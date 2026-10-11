"""Crawl public Commander decks from Archidekt and Moxfield into decks.jsonl.gz, the deck corpus,
and cEDH tournament results from edhtop16 into results.jsonl.gz, and turn them into site/decks/,
the data behind "Find similar decks" and the commander pages.

    python build_decks.py crawl --hours 5     # resumable: stop and restart any time
    python build_decks.py crawl --site moxfield --hours 5
    python build_decks.py crawl --top 3500 --per-commander 20 --rate 3   # fill in popular commanders
    python build_decks.py crawl --only "Derevi, Empyrial Tactician" --bracket 5 --per-commander 1000
    python build_decks.py results --hours 1   # resumable: the last year's tournaments, newest first
    python build_decks.py build               # after build_index.py (uses its card numbers)
"""
import argparse
import bisect
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, timedelta

from build_index import by_popularity, load_cards, load_oracle_tags, load_printings, write_json

ARCHIDEKT = "https://archidekt.com/api"
MOXFIELD = "https://api2.moxfield.com"
EDHTOP16 = "https://edhtop16.com/api"
CORPUS = "decks.jsonl.gz"
HEADERS = {"User-Agent": "MTG_Vec2Search/1.0 (+https://github.com/grahamirwin/MTG_Vec2Search)",
           "Accept": "application/json", "Accept-Encoding": "gzip"}
COMMANDER_FORMAT = 3  # Archidekt's deckFormat id for Commander / EDH
DELAY = 1.0  # seconds between requests; Archidekt is a small team, so crawl politely
MIN_CARDS, MAX_CARDS = 95, 105  # roughly complete 100-card decks
MAX_PAGES = 50  # the search API stops returning results after ~50 pages
MOX_PAGES = 100  # Moxfield's search stops at 10,000 decks: 100 pages of 100
STATE = "crawl_state.json"  # when each commander was last crawled, so crawls take turns
# (Moxfield's turns are "moxfield:<commander>"). A deck's id says where it's from: Archidekt's are
# numbers, Moxfield's strings (its public id, the one in the deck's link).
RELEASE = "deck-corpus"  # the GitHub release the corpus lives on (too big for git)


_last = {}  # per site: when its next request may go out
_lock = threading.Lock()


def get_json(path, base=ARCHIDEKT, post=None):
    """GET an Archidekt (or Moxfield) API path, or POST `post` (as JSON) to one, at most one request
    per DELAY seconds to each site (across threads), retrying on errors."""
    site = {MOXFIELD: "Moxfield", EDHTOP16: "edhtop16"}.get(base, "Archidekt")
    sent = post and json.dumps(post).encode()
    headers = {**HEADERS, "Content-Type": "application/json"} if post else HEADERS
    for attempt in range(5):
        with _lock:
            now = time.time()  # one reading: a second, later one could make the wait negative
            _last[base] = max(_last.get(base, 0) + DELAY, now)
            wait = _last[base] - now
        time.sleep(wait)
        try:
            with urllib.request.urlopen(urllib.request.Request(base + path, sent, headers), timeout=120) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 500, 502, 503, 504):
                raise
            problem, asked = f"answered {e.code}", e.headers.get("Retry-After", "")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            problem, asked = f"didn't answer ({getattr(e, 'reason', e)})", ""
        # As long as the site asks (Moxfield's 429s say a few seconds), else back off: 30s, 1m, 2m, 4m, 8m
        wait = int(asked) + 1 if asked.isdigit() else 30 * 2 ** attempt
        with _lock:  # every thread backs off, not just this one
            _last[base] = max(_last.get(base, 0), time.time() + wait)
        print(f"  ! {site} {problem}; trying again in {duration(wait)}", flush=True)
    raise RuntimeError(f"{site} keeps failing for {path}")


def search_decks(commander=None, pages=MAX_PAGES, bracket=None):
    """(id, last update date, creation date) of complete Commander decks, most recently updated first,
    optionally only those led by this commander, or of this bracket. A search stops after MAX_PAGES
    (3,000 decks), so a commander's search then goes on from its oldest decks: twice as many in all."""
    query = {"deckFormat": COMMANDER_FORMAT, "pageSize": 50}
    if commander:
        query["commanderName"] = commander
    if bracket:
        query["edhBracket"] = bracket
    for order in ["-updatedAt", "updatedAt"] if commander else ["-updatedAt"]:
        for page in range(1, pages + 1):
            data = get_json("/decks/v3/?" + urllib.parse.urlencode({**query, "orderBy": order, "page": page}))
            for d in (data or {}).get("results") or []:
                if MIN_CARDS <= d.get("size", 0) <= MAX_CARDS and not d.get("private") and not d.get("unlisted"):
                    yield d["id"], (d.get("updatedAt") or "")[:10], (d.get("createdAt") or "")[:10]
            if not data or not data.get("next"):
                break


def slim_deck(deck):
    """Just what similarity needs: commanders and mainboard cards, by Scryfall oracle id.
    Returns None for decks that aren't a usable Commander deck."""
    in_deck = {c["name"]: c.get("includedInDeck", True) for c in deck.get("categories") or []}
    commanders, cards = [], {}
    for entry in deck.get("cards") or []:
        categories = entry.get("categories") or []
        # A card's first category decides where it is (Maybeboard and Sideboard aren't in the deck)
        if categories and not in_deck.get(categories[0], True):
            continue
        oracle = (entry.get("card") or {}).get("oracleCard") or {}
        if not oracle.get("uid"):
            continue
        if "Commander" in categories:
            commanders.append(oracle["uid"])
        cards[oracle["uid"]] = cards.get(oracle["uid"], 0) + entry.get("quantity", 1)
    if not 1 <= len(commanders) <= 2 or not MIN_CARDS <= sum(cards.values()) <= MAX_CARDS:
        return None
    return {"id": deck["id"], "name": deck.get("name", ""), "updated": deck.get("updatedAt", "")[:10],
            "created": (deck.get("createdAt") or "")[:10],
            "bracket": deck.get("edhBracket"), "views": deck.get("viewCount", 0),
            "commanders": sorted(commanders), "cards": cards}


def search_moxfield(commander=None, pages=MOX_PAGES, bracket=None):
    """search_decks, on Moxfield: (public id, last update date, creation date) of complete public
    Commander decks, most recently updated first; for a commander, then its oldest too."""
    query = {"fmt": "commander", "pageSize": 100, "sortType": "updated"}
    if bracket:
        query["minBracket"] = query["maxBracket"] = bracket
    if commander:  # Moxfield finds a commander's decks by its own card id
        found = get_json("/v2/cards/search?" + urllib.parse.urlencode({"q": commander}), MOXFIELD) or {}
        ids = [c["id"] for c in found.get("data") or [] if c.get("name", "").lower() == commander.lower()]
        if not ids:
            return
        query["commanderCardId"] = ids[0]
    for order in ["Descending", "Ascending"] if commander else ["Descending"]:
        for page in range(1, pages + 1):
            data = get_json("/v2/decks/search?" + urllib.parse.urlencode(
                {**query, "sortDirection": order, "pageNumber": page}), MOXFIELD)
            for d in (data or {}).get("data") or []:
                # mainboardCount counts the commanders too
                if MIN_CARDS <= d.get("mainboardCount", 0) <= MAX_CARDS and d.get("visibility") == "public":
                    yield d["publicId"], (d.get("lastUpdatedAtUtc") or "")[:10], (d.get("createdAtUtc") or "")[:10]
            if not data or page >= data.get("totalPages", 0):
                break


def slim_moxfield(deck, oracles):
    """slim_deck, for a Moxfield deck. Its cards are printings: oracles is {Scryfall id: oracle id}."""
    boards = deck.get("boards") or {}

    def board(name):
        for e in ((boards.get(name) or {}).get("cards") or {}).values():
            oracle = oracles.get((e.get("card") or {}).get("scryfall_id"))
            if oracle:
                yield oracle, e.get("quantity", 1)
    commanders = sorted({o for o, _ in board("commanders")})
    cards = {}
    for o, k in [*board("commanders"), *board("mainboard")]:  # the sideboard and maybeboard aren't in the deck
        cards[o] = cards.get(o, 0) + k
    if not 1 <= len(commanders) <= 2 or not MIN_CARDS <= sum(cards.values()) <= MAX_CARDS:
        return None
    return {"id": deck["publicId"], "name": deck.get("name", ""), "updated": (deck.get("lastUpdatedAtUtc") or "")[:10],
            "created": (deck.get("createdAtUtc") or "")[:10],
            "bracket": deck.get("bracket"), "views": deck.get("viewCount", 0),
            "commanders": commanders, "cards": cards}


def printing_oracles(printings_file="default_cards.jsonl.gz"):
    """{Scryfall id: oracle id} for every printing (from build_index.py), digital ones too."""
    oracles = {}
    with gzip.open(printings_file, "rt", encoding="utf-8") as f:
        for c in map(json.loads, filter(str.strip, f)):
            oracle_id = c.get("oracle_id") or (c.get("card_faces") or [{}])[0].get("oracle_id")
            if oracle_id:
                oracles[c["id"]] = oracle_id
    return oracles


def load_corpus(path=CORPUS):
    """{deck id: deck}. A deck crawled again after an update is appended, so the last copy wins."""
    decks = {}
    if os.path.exists(path):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            try:
                for line in f:
                    deck = json.loads(line)
                    decks[deck["id"]] = deck
            except (EOFError, json.JSONDecodeError):  # cut off mid-write by a stopped crawl
                pass
    return decks


def save_corpus(corpus, path=CORPUS):
    """One gzip stream, without replaced copies of decks (about half the size)."""
    with gzip.open(path + ".tmp", "wt", encoding="utf-8") as f:
        f.writelines(json.dumps(d, separators=(",", ":")) + "\n" for d in corpus.values())
    os.replace(path + ".tmp", path)


# === Tournament results, from edhtop16 (whose decklists and results come from TopDeck.gg) ===
# results.jsonl.gz: one cEDH tournament per line, like the deck corpus (the last copy wins):
#   {id: TopDeck's tournament id, name, date, size: players, top_cut: players in the top cut (0: none),
#    decklists: how many edhtop16 had when it was fetched (absent in the first ones fetched),
#    entries: [[commander(s) ("A / B" for partners), standing, wins, losses, draws, decklist link,
#               [card names]]]}, only the entries edhtop16 has a decklist for
RESULTS = "results.jsonl.gz"
RESULT_DAYS = 365
MIN_EVENT = 16  # players: smaller events are few games against few decks
REFETCH_DAYS = 3  # recent events are fetched again: results and decklists come in after they start
FETCHERS = 4  # tournaments fetched at once: each takes edhtop16 a few seconds, and DELAY still spaces the requests
TOURNAMENTS = """query($since: String, $after: String) {
  tournaments(first: 1000, sortBy: DATE, after: $after, filters: {minDate: $since, minSize: %d}) {
    edges { node { TID tournamentDate breakdown { entries } } } pageInfo { hasNextPage endCursor } } }""" % MIN_EVENT
TOURNAMENT = """query($tid: String!) { tournament(TID: $tid) { name size topCut tournamentDate
  entries { standing wins losses draws decklist commander { name } maindeck { name } } } }"""


def edhtop16(query, **variables):
    data = get_json("/graphql", EDHTOP16, {"query": query, "variables": variables}) or {}
    if data.get("errors") or not data.get("data"):
        raise RuntimeError(f"edhtop16 says: {data.get('errors')}")
    return data["data"]


def fetch_results(hours=None, path=RESULTS, today=None):
    """Bring results.jsonl.gz up to date with edhtop16: the tournaments of the last RESULT_DAYS days
    with MIN_EVENT players or more and some decklists (by its commander breakdown, which the list
    gives: about 40% have none) that it lacks or that have more or fewer decklists since, newest
    first, and the last REFETCH_DAYS days' again. FETCHERS at a time; each is saved as it arrives,
    so it can stop (`hours`, Ctrl+C) and go on later."""
    today = today or date.today()
    since = (today - timedelta(RESULT_DAYS)).isoformat()
    results = {i: t for i, t in load_corpus(path).items() if t["date"] >= since}
    save_corpus(results, path)  # without tournaments now too old
    listed, after = [], None
    while True:
        page = edhtop16(TOURNAMENTS, since=since, after=after)["tournaments"]
        listed += [e["node"] for e in page["edges"]]
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]
    recent = (today - timedelta(REFETCH_DAYS)).isoformat()
    decklists = {t["TID"]: sum(b["entries"] for b in t.get("breakdown") or []) for t in listed}
    todo = sorted((t for t in listed if decklists[t["TID"]] and (
        t["TID"] not in results or t["tournamentDate"][:10] >= recent
        or results[t["TID"]].get("decklists", decklists[t["TID"]]) != decklists[t["TID"]])),
        key=lambda t: t["tournamentDate"], reverse=True)
    print(f"{len(results):,} tournaments in {path}; edhtop16 has {len(listed):,} since {since} "
          f"({sum(not n for n in decklists.values()):,} without decklists), fetching {len(todo):,}", flush=True)
    deadline = time.time() + hours * 3600 if hours else float("inf")
    start, fetched = time.time(), [0]
    lock, stop = threading.Lock(), threading.Event()  # Ctrl+C: requests out finish, but nothing more is saved
    jobs = iter(todo)
    with open(path, "ab") as out:
        def work():
            for t in jobs:
                if time.time() > deadline or stop.is_set():
                    return
                got = edhtop16(TOURNAMENT, tid=t["TID"])["tournament"]
                if not got:
                    continue
                record = {
                    "id": t["TID"], "name": got["name"], "date": got["tournamentDate"][:10], "size": got["size"],
                    "top_cut": got["topCut"] or 0, "decklists": decklists[t["TID"]],
                    "entries": [[(e["commander"] or {}).get("name") or "", e["standing"], e["wins"], e["losses"], e["draws"],
                                 e["decklist"] or "", [c["name"] for c in e["maindeck"]]]
                                for e in got["entries"] if e["maindeck"]]}
                with lock:
                    if stop.is_set():
                        return
                    results[t["TID"]] = record
                    out.write(gzip.compress((json.dumps(record, separators=(",", ":")) + "\n").encode()))
                    out.flush()
                    fetched[0] += 1
                    print(f"  {record['date']}  {got['name'][:50]:<50}  {got['size']:>4} players, "
                          f"{len(record['entries']):>4} decklists  [{fetched[0]:,}/{len(todo):,}]", flush=True)
        threads = [threading.Thread(target=work, daemon=True) for _ in range(FETCHERS)]
        for thread in threads:
            thread.start()
        try:
            for thread in threads:
                while thread.is_alive():
                    thread.join(1)  # with a timeout, so Ctrl+C gets through on Windows
        except KeyboardInterrupt:
            with lock:  # waits out a tournament being written, and no thread writes another
                stop.set()
            print("\nStopped. Everything fetched so far is saved.", flush=True)
    save_corpus(results, path)
    print(f"Done in {duration(time.time() - start)}: fetched {fetched[0]:,} tournaments; {len(results):,} in {path}, "
          f"{sum(len(t['entries']) for t in results.values()):,} decklists.", flush=True)


def full_names(wanted, names):
    """Archidekt only finds a commander by its exact, full name, so: the full names of these
    cards, written in any case and double-faced ones by their front face. names: {oracle id: name}"""
    # Reversible printings are named twice over ("Atraxa, Praetors' Voice // Atraxa, Praetors' Voice")
    real = [n for n in names.values() if len(set(n.split(" // "))) == len(n.split(" // "))]
    full = {name.split(" // ")[0].lower(): name for name in real}
    full.update({name.lower(): name for name in real})  # a whole name beats a front face
    unknown = [w for w in wanted if w.lower() not in full]
    if unknown:
        raise SystemExit(f"Not card names: {', '.join(unknown)}")
    return [full[w.lower()] for w in wanted]


def card_names(oracle_file="oracle_cards.jsonl.gz"):
    with gzip.open(oracle_file, "rt", encoding="utf-8") as f:
        return {c["oracle_id"]: c["name"] for c in map(json.loads, f) if c.get("oracle_id")}


def top_commanders(n, oracle_file="oracle_cards.jsonl.gz"):
    """(oracle id, name) of the n most played cards that can lead a Commander deck, by EDHREC rank."""
    def can_lead(c):
        front = c.get("type_line", "").split(" // ")[0]
        text = c.get("oracle_text") or " ".join(f.get("oracle_text", "") for f in c.get("card_faces") or [])
        return c.get("edhrec_rank") and c.get("legalities", {}).get("commander") == "legal" and (
            ("Legendary" in front and "Creature" in front) or "can be your commander" in text)
    with gzip.open(oracle_file, "rt", encoding="utf-8") as f:
        cards = sorted((c for c in map(json.loads, f) if can_lead(c)), key=lambda c: c["edhrec_rank"])
    return [(c["oracle_id"], c["name"]) for c in cards[:n]]


def duration(seconds):
    """3725 -> "1h 2m", 95 -> "1m 35s"."""
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}h {m}m" if h else f"{m}m {s}s" if m else f"{s}s"


def merge(corpus, state, other_dir, path=CORPUS, state_path=STATE):
    """Add what another copy of the corpus (in other_dir) has that this one doesn't: decks, and
    newer versions of decks. Crawl dates keep the later of the two. Returns how many decks it took."""
    taken = 0
    for i, d in load_corpus(os.path.join(other_dir, path)).items():
        mine = corpus.get(i)
        if not mine or d["updated"] > mine["updated"]:
            corpus[i], mine, d = d, d, mine or {}
            taken += 1
        if not mine.get("created") and d.get("created"):  # a creation date either copy has
            mine["created"] = d["created"]
    if os.path.exists(os.path.join(other_dir, state_path)):
        with open(os.path.join(other_dir, state_path), encoding="utf-8") as f:
            for commander, day in json.load(f).items():
                state[commander] = max(state.get(commander, ""), day)
    return taken


def share(corpus, state, path=CORPUS, state_path=STATE):
    """Upload the corpus to the release, after merging in what the release has that it doesn't
    (another crawl's decks, e.g. the weekly one on GitHub Actions), so nothing there is lost."""
    print(f"\nSharing with the {RELEASE} release...", flush=True)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            got = subprocess.run(["gh", "release", "download", RELEASE, "--dir", tmp,
                                  "--pattern", path, "--pattern", state_path])
            if got.returncode:  # uploading anyway could replace decks we couldn't see
                raise RuntimeError("couldn't download the release to merge with")
            taken = merge(corpus, state, tmp, path, state_path)
        save_corpus(corpus, path)
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=0, sort_keys=True)
        print(f"Merged in {taken:,} decks from the release; {len(corpus):,} in all", flush=True)
        if subprocess.run(["gh", "release", "upload", RELEASE, path, state_path, "--clobber"]).returncode:
            raise RuntimeError("the upload failed")
        print("Uploaded.", flush=True)
        # The site only reads the corpus when it's built, so build it now rather than on Monday
        deployed = not subprocess.run(["gh", "workflow", "run", "deploy.yml"]).returncode
        print("Started a deploy; the site has the new decks in a few minutes." if deployed else
              "Couldn't start a deploy: Actions → Build and deploy → Run workflow", flush=True)
    except (OSError, RuntimeError) as e:  # OSError: gh isn't installed
        print(f"Couldn't share it ({e}). Everything is saved here; to try again:\n"
              f"  gh release upload {RELEASE} {path} {state_path} --clobber", flush=True)


def crawl(per_commander, only=None, hours=None, top=None, upload=False, path=CORPUS, state_path=STATE,
          site="archidekt", bracket=None):
    """First the decks updated most recently on `site` (new decks, and new versions of ones we have),
    then up to per_commander more decks for each commander: commanders never crawled there first
    (most common in the corpus first), then the ones crawled longest ago, until `hours` run out.
    With `top`: instead, the `top` most played commanders, each topped up to per_commander of the
    site's decks, several at once (as fast as DELAY allows). With `bracket`: only decks their
    builders gave that bracket."""
    moxfield = site == "moxfield"
    if moxfield:
        oracles = printing_oracles()  # Moxfield decks list printings
        site_search, link = search_moxfield, "moxfield.com/decks/{}"
        get_deck = lambda i: slim_moxfield(get_json(f"/v3/decks/all/{i}", MOXFIELD) or {}, oracles)
    else:
        site_search, link = search_decks, "archidekt.com/decks/{}"
        get_deck = lambda i: slim_deck(get_json(f"/decks/{i}/") or {})
    search = lambda commander=None: site_search(commander, bracket=bracket)
    # A commander's key in state; a bracket's crawl takes its own turns, apart from the commander's
    turn = lambda c: ("moxfield:" if moxfield else "") + c + (f" (bracket {bracket})" if bracket else "")
    deadline = time.time() + hours * 3600 if hours else float("inf")
    stop = threading.Event()  # Ctrl+C: threads finish their request but save nothing more
    lock = threading.Lock()  # around the corpus, the file and the counts
    corpus = load_corpus(path)
    # Rewritten first too: decks appended after one cut off by a stopped crawl couldn't be read
    save_corpus(corpus, path)
    have = {i: d["updated"] for i, d in corpus.items()}
    state = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    names = card_names() if os.path.exists("oracle_cards.jsonl.gz") else {}  # from build_index.py
    if only and names:
        only = full_names(only, names)
    start, before = time.time(), len(corpus)
    counts = {"new": 0, "updated": 0}
    print(f"{len(corpus):,} decks in {path}" + (f"; crawling for {hours:g} hours" if hours else "")
          + (f"; only bracket {bracket} decks" if bracket else "")
          + "\n  + new deck   ~ newer version of a deck we had\n", flush=True)

    def progress():
        rate = (counts["new"] + counts["updated"]) / max(time.time() - start, 1) * 3600
        left = f", {duration(max(0, deadline - time.time()))} left" if hours else ""
        return f"{len(corpus):,} decks, {rate:,.0f}/hour{left}"

    # Each deck is its own gzip member, so stopping the crawl can only cut off the last one
    with open(path, "ab") as out:
        def fetch(found, limit):
            added = 0
            for deck_id, updated, created in found:
                if added >= limit or time.time() > deadline or stop.is_set():
                    break
                with lock:
                    if have.get(deck_id, "") >= updated:  # already have this version
                        mine = corpus.get(deck_id)  # (None for one that isn't a usable deck)
                        if created and mine and not mine.get("created"):  # crawled before dates were kept
                            mine["created"] = created
                        continue
                    have[deck_id] = updated
                deck = get_deck(deck_id)
                with lock:
                    if not deck or stop.is_set():
                        continue
                    out.write(gzip.compress((json.dumps(deck, separators=(",", ":")) + "\n").encode()))
                    out.flush()
                    kind = "updated" if deck_id in corpus else "new"
                    counts[kind] += 1
                    corpus[deck_id] = deck
                    added += 1
                    lead = " & ".join(names.get(o, "?") for o in deck["commanders"])
                    print(f"  {'~' if kind == 'updated' else '+'} {len(corpus):>7,}  {deck['name'][:40]:<40}  "
                          f"{lead[:40]:<40}  {link.format(deck_id)}", flush=True)
            return added

        def take_turns(queue):  # threads take commanders off the queue: [(name, decks wanted)]
            jobs = iter(enumerate(queue, 1))

            def work():
                for i, (commander, want) in jobs:
                    if time.time() > deadline or stop.is_set():
                        return
                    added = fetch(search(commander), want)
                    with lock:
                        state[turn(commander)] = date.today().isoformat()
                        with open(state_path, "w", encoding="utf-8") as f:
                            json.dump(state, f, ensure_ascii=False, indent=0, sort_keys=True)
                        print(f"[{i:,}/{len(queue):,}] {commander}: +{added} decks ({progress()})", flush=True)
            # ponytail: 8 threads keep up with a few requests a second; DELAY is the real limit
            threads = [threading.Thread(target=work, daemon=True) for _ in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                while t.is_alive():
                    t.join(1)  # with a timeout, so Ctrl+C gets through on Windows

        try:
            if top:
                count = Counter(o for d in corpus.values() if isinstance(d["id"], str) == moxfield
                                for o in d["commanders"])
                queue = [(name, per_commander - count[o]) for o, name in top_commanders(top) if count[o] < per_commander]
                print(f"{len(queue):,} of the top {top:,} commanders have fewer than {per_commander} decks\n", flush=True)
                take_turns(queue)
            elif not only:
                print(f"Recently updated decks on {site.capitalize()}:", flush=True)
                print(f"Recently updated: +{fetch(search(), float('inf'))} decks ({progress()})\n", flush=True)
            done = set()
            while not top and per_commander and time.time() < deadline:
                if only:
                    queue = [c for c in only if c not in done]
                else:  # recounted each time: crawling one commander turns up decks for others
                    by_lead = Counter(names[o] for d in corpus.values() for o in d["commanders"] if o in names)
                    queue = sorted((c for c in by_lead if c not in done), key=lambda c: (state.get(turn(c), ""), -by_lead[c]))
                if not queue:
                    break
                commander = queue[0]
                done.add(commander)
                last = state.get(turn(commander))
                print(f"[{len(done)}] {commander}" + (f" (last crawled {last})" if last else ""), flush=True)
                added = fetch(search(commander), per_commander)
                state[turn(commander)] = date.today().isoformat()
                with open(state_path, "w", encoding="utf-8") as f:
                    json.dump(state, f, ensure_ascii=False, indent=0, sort_keys=True)
                print(f"[{len(done)}] {commander}: +{added} decks ({progress()})\n", flush=True)
        except KeyboardInterrupt:
            with lock:  # waits out a deck being written, and no thread writes another
                stop.set()
            print("\nStopped. Everything fetched so far is saved.", flush=True)

    save_corpus(corpus, path)
    print(f"Done in {duration(time.time() - start)}: {counts['new']:,} new decks, {counts['updated']:,} updated; "
          f"{len(corpus):,} in {path} (was {before:,}).", flush=True)
    if upload:
        share(corpus, state, path, state_path)
    else:
        print(f"Share it with the site: gh release upload {RELEASE} {path} {state_path} --clobber", flush=True)


# === Build site/decks/ ===
# One file per commander (or partner pair), named after its card number(s) in the card index, so
# a search downloads just the decks for the pasted deck's commander:
#   <card>.json / <card>-<card>.json
#       cards  the cards these decks play (card numbers), most played first
#       decks  [id, name, last updated, cards, made, bracket], the newest MAX_DECKS; id is Archidekt's (a
#              number) or Moxfield's (a string); cards are positions in `cards`, sorted and stored
#              as gaps (popular cards have small positions, so the gaps are small numbers; same
#              idea as index/t/); made: when the deck was made (see made_dates; "" if unknown);
#              bracket: what its builder gave it (0: none)
#       signature  the SHOWN_SIGNATURE cards these decks play far more often than other decks do
#       tags   [Scryfall Tagger tag, gaps between positions in `cards`], over the nonland cards
#              at least COMMON of the decks play: what the site names a commander's builds by
#              (only for BUILD_DECKS decks or more, as fewer aren't split into builds)
#       price  what a typical (median) deck costs, in US cents (-1: unknown)
#       bracket  the typical bracket of the decks that give one (0: none do)
#       themes  the Tagger tags these decks play far more of than other decks do
#       results  how many of its decks are in the last year's cEDH tournament results (absent: none)
#   results/<card>.json  a commander's cEDH tournament results (from results.jsonl.gz), for each
#              of RESULT_WINDOWS (days back): totals: [decks, games, wins, decks in events with a
#              top cut, top cuts] per window; cards: what the decks play (card numbers, most
#              played first; in at least MIN_RESULT_DECKS decks); stats: for each card, the totals
#              of the decks that play it, one window after another; top: the newest finishes in the
#              top TOP_FINISH, [date, event, players, standing, wins, losses, draws, decklist link];
#              field: the totals of every tournament deck (with draws, a deck wins less than a
#              quarter of its games, so this is what a commander's decks are measured against)
#   results/index.json  the Tournaments tab: windows and field as above; commanders: every commander
#              with tournament decks, [file name, totals one window after another], most decks first;
#              cards: the cards at least MIN_POOLED_DECKS decks play; stats: for each card, per window,
#              [decks, commanders counted, lift (in hundredths of a point), evidence (hundredths)],
#              from pooled()
#   index.json  every commander with a file: [file name, deck count, signature cards], where the
#              signature cards are what its decks play far more often than other decks do. Used to
#              find decks with other commanders, and for commanders without enough decks.
#              Also windows (days) and since: the date each window starts (null: not known yet).
#   trends.json  themes (tag names); every commander with a file, most decks first: [file name,
#              decks made [ever, in each window], price, bracket, theme numbers]; and everything:
#              [decks made, gaps between the cards they play, [how many play each card, per window]]
#              over all their decks
#   trend-cards.json  the same as everything, for each commander in trends.json (most of its cards)
OUT_DIR = os.path.join("site", "decks")
RESULT_WINDOWS = [90, 180, 365]  # days back: the periods commander pages show tournament results for
MIN_RESULT_DECKS = 2  # a card fewer of a commander's tournament decks play says nothing yet
MIN_POOLED_DECKS = 10  # tournament decks playing a card for the Tournaments tab to list it
POOL_DECKS = 3  # a commander's decks with a card, and without it, for it to count toward the card's overall result
PRIOR_GAMES, DESIGN_EFFECT = 100, 2  # as in cardResults (site/deck.js)
TOP_FINISH, MAX_FINISHES = 4, 200  # best finishes on a commander page: the newest MAX_FINISHES in the top 4
MIN_DECKS = 5  # fewer decks than this don't make useful recommendations
MAX_DECKS = 3000  # per commander, newest first: keeps a file around 300 KB to download
SIGNATURE = 24
SHOWN_SIGNATURE = 60
COMMON = 0.02  # same as `rare` in findBuilds (site/deck.js)
BUILD_DECKS = 100  # 2 * DECKS_PER_BUILD in site/deck.js
MAX_TAG_CARDS = 2000  # tags on more cards than this ("removal") don't tell builds apart
THEMES = 6  # Tagger tags a commander's decks are known for, which Trends finds commanders by
WINDOWS = [90, 30, 7]  # days, for Trends: decks made in the last 90, 30 and 7 days
TREND_SHARE, TREND_DECKS = 0.15, 3  # a commander's cards in trend-cards.json (see build)
# Tags about how a card is worded or printed rather than what a deck does with it
NOT_A_PLAN = re.compile(r"^cycle-|-effect$|vanilla|^multiple-|^passive-ability$|^delayed-trigger$|"
                        r"^inverted-effects$|^intervening-if|out-of-color|^noncreature-typal$|"
                        r"^unique-type-line$|^drawback$|^cheaper-than-mv$|^staple-with")


def gaps(numbers):
    return [b - a for a, b in zip([0] + numbers, numbers)]


def themes(here, n, usual, card_tags, count=THEMES):
    """The Scryfall Tagger tags whose cards these n decks (here: plays by card) play the most more of
    than decks in general do (usual: plays per deck by tag), relative to how many they play anyway:
    buildTags in site/deck.js, against every deck instead of the commander's own. A tag mostly on
    the same cards as a better one is skipped."""
    mine = Counter()
    for c, k in here.items():
        for t in card_tags[c]:
            mine[t] += k
    more = {t: mine[t] / n - usual[t] for t in mine}
    picked = []
    for t in sorted((t for t in more if more[t] >= 0.5), key=lambda t: -more[t] / (usual[t] + 1) ** .5):
        if len(picked) >= count:
            break
        played = {c for c in here if t in card_tags[c]}
        if all(len(played & p) / len(played | p) < 0.5 for _, p in picked):
            picked.append((t, played))
    return [t for t, _ in picked]


def made_dates(corpus):
    """{deck id: when it was made}: its creation date, or for an Archidekt deck crawled before those
    were kept, that of the last dated deck before it (Archidekt numbers decks as they're made), so
    it's in a window just when it would be by id. "" when nothing tells."""
    dated = sorted((d["id"], d["created"]) for d in corpus.values() if isinstance(d["id"], int) and d.get("created"))
    ids = [i for i, _ in dated]
    made = {}
    for d in corpus.values():
        if d.get("created"):
            made[d["id"]] = d["created"]
        else:
            k = bisect.bisect(ids, d["id"]) if isinstance(d["id"], int) else 0
            made[d["id"]] = dated[k - 1][1] if k else ""
    return made


def window_plays(decks, since, made):
    """For [(deck, cards it plays)]: how many were made ever and in each window (since: the date each
    starts; made: see made_dates), and how many of those play each card: {card: [ever, per window]}."""
    windows = [[1] + [int(s is not None and made[d["id"]] >= s) for s in since] for d, _ in decks]
    counts = [sum(col) for col in zip(*windows)] or [0] * (len(since) + 1)
    plays = defaultdict(lambda: [0] * len(counts))
    for (_, played), w in zip(decks, windows):
        for c in played:
            for k, inside in enumerate(w):
                plays[c][k] += inside
    return counts, plays


def trend_cards(made, plays, share, least):
    """[gaps between the cards at least `share` of the decks and `least` decks play in some window,
    [how many play each, per window]]"""
    kept = sorted(c for c, ks in plays.items() if any(k >= max(least, share * m) for k, m in zip(ks, made)))
    return [gaps(kept), [[plays[c][k] for c in kept] for k in range(len(made))]]


def median(values, missing):
    values = sorted(values)
    return values[len(values) // 2] if values else missing


def tournament_stats(results, cards, today):
    """{commander file name: its results/ file} from the tournaments in results.jsonl.gz ({id:
    tournament}). Cards are matched by name: whole, or a double-faced card's front face."""
    number = {}
    for i, c in enumerate(cards):  # most played printing first, as in the card index
        if c.get("name"):
            number.setdefault(c["name"].lower(), i)
            number.setdefault(c["name"].split(" // ")[0].lower(), i)
    basic = {i for i, c in enumerate(cards) if "Basic" in c.get("type_line", "")}
    since = [(today - timedelta(days)).isoformat() for days in RESULT_WINDOWS]

    def add(counts, t, row):  # row: [decks, games, wins, decks in events with a top cut, top cuts]
        for w, day in enumerate(since):
            if t["date"] >= day:
                for i, x in enumerate(row):
                    counts[w][i] += x

    by_key = defaultdict(list)
    field = [[0] * 5 for _ in since]
    for t in results.values():
        for lead, standing, wins, losses, draws, link, names in t["entries"]:
            cut = t["top_cut"]
            row = [1, wins + losses + draws, wins, int(cut > 0), int(0 < standing <= cut)]
            add(field, t, row)
            leads = [number.get(n.lower()) for n in lead.split(" / ")] if lead else [None]
            if None in leads:
                continue
            played = {number[n.lower()] for n in names if n.lower() in number} - basic - set(leads)
            by_key["-".join(str(n) for n in sorted(leads))].append((t, standing, [wins, losses, draws], link, played, row))
    out = {}
    for key, entries in by_key.items():
        totals = [[0] * 5 for _ in since]
        stats = defaultdict(lambda: [[0] * 5 for _ in since])
        top = []
        for t, standing, record, link, played, row in entries:
            for counts in [totals] + [stats[c] for c in played]:
                add(counts, t, row)
            if standing <= TOP_FINISH:
                top.append([t["date"], t["name"], t["size"], standing, *record, link])
        kept = sorted((c for c in stats if stats[c][-1][0] >= MIN_RESULT_DECKS), key=lambda c: (-stats[c][-1][0], c))
        out[key] = {"windows": RESULT_WINDOWS, "totals": totals, "cards": kept,
                    "stats": [sum(stats[c], []) for c in kept],
                    "top": sorted(top, key=lambda f: (f[0], -f[2]), reverse=True)[:MAX_FINISHES], "field": field}
    return out


def pooled(standings, field):
    """Each card's result across commanders, from tournament_stats' standings: the difference in
    games won between a commander's decks with the card and its decks without, averaged over the
    commanders whose decks are POOL_DECKS or more on each side, each weighted by how much its
    difference can be trusted (1 / (1/games with + 1/games without)). So a card is only ever
    compared within a commander, and a strong commander playing it doesn't make it look good.
    lift: that average, pulled toward no difference by PRIOR_GAMES games' worth; evidence: how many
    standard errors it is (a deck's games counted as 1/DESIGN_EFFECT as many independent ones), as
    in cardResults (site/deck.js). {card: [[decks, commanders, lift, evidence] per window]}"""
    sums = defaultdict(lambda: [[0.0, 0.0, 0, 0] for _ in RESULT_WINDOWS])  # weighted sum, weights, decks, commanders
    for data in standings.values():
        for card, row in zip(data["cards"], data["stats"]):
            for w, (decks, games, wins, *_) in enumerate(data["totals"]):
                d, g, k = row[5 * w:5 * w + 3]
                s = sums[card][w]
                s[2] += d
                if d >= POOL_DECKS and decks - d >= POOL_DECKS and 0 < g < games:
                    weight = 1 / (1 / g + 1 / (games - g))
                    s[0] += weight * (k / g - (wins - k) / (games - g))
                    s[1] += weight
                    s[3] += 1
    out = {}
    for card, windows in sums.items():
        out[card] = []
        for (total, weights, decks, commanders), (_, games, wins, *_) in zip(windows, field):
            rate = wins / games if games else 0
            if not weights or not 0 < rate < 1:
                out[card].append([decks, 0, 0.0, 0.0])
                continue
            difference = total / weights
            evidence = difference / (DESIGN_EFFECT * rate * (1 - rate) / weights) ** 0.5
            out[card].append([decks, commanders, difference * weights / (weights + PRIOR_GAMES), evidence])
    return out


def build(corpus, cards, tags=None, out_dir=OUT_DIR, prices=None, today=None, results=None):
    """corpus: {id: deck} (see slim_deck); cards: Scryfall cards in card-index order;
    tags: Scryfall Tagger tags, {slug: (oracle ids, names)} (see load_oracle_tags);
    prices: {oracle id: cheapest USD price} (see load_printings)."""
    number = {c["oracle_id"]: i for i, c in enumerate(cards) if c.get("oracle_id")}
    basic = {c["oracle_id"] for c in cards if "Basic" in c.get("type_line", "")}
    prices = prices or {}
    card_tags = defaultdict(list)
    for slug, (ids, _) in (tags or {}).items():
        if len(ids) <= MAX_TAG_CARDS and not NOT_A_PLAN.search(slug):
            for o in ids:
                if o in number:
                    card_tags[number[o]].append(slug)
    groups = defaultdict(list)
    for d in corpus.values():
        if not all(o in number for o in d["commanders"]):
            continue
        key = "-".join(str(n) for n in sorted(number[o] for o in d["commanders"]))
        played = sorted({number[o] for o in d["cards"]
                         if o in number and o not in basic and o not in d["commanders"]})
        groups[key].append((d, played))

    # A window is every deck made from its first day on. None: no deck known to be made in it, or no
    # known deck is older, so the window isn't filled in yet.
    today = today or date.today()
    made = made_dates(corpus)
    known = [d["created"] for d in corpus.values() if d.get("created")]
    since = []
    for days in WINDOWS:
        cutoff = (today - timedelta(days)).isoformat()
        since.append(cutoff if any(c >= cutoff for c in known) and any(c < cutoff for c in known) else None)

    everywhere = Counter(c for decks in groups.values() for _, played in decks for c in played)
    total = sum(len(decks) for decks in groups.values())
    usual = Counter()
    for c, k in everywhere.items():
        for t in card_tags[c]:
            usual[t] += k / total
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    standings = tournament_stats(results or {}, cards, today)
    os.makedirs(os.path.join(out_dir, "results"))
    if standings:
        field = next(iter(standings.values()))["field"]
        overall = pooled(standings, field)
        kept = sorted((c for c in overall if overall[c][-1][0] >= MIN_POOLED_DECKS), key=lambda c: (-overall[c][-1][0], c))
        write_json(os.path.join(out_dir, "results", "index.json"), {
            "windows": RESULT_WINDOWS, "field": field,
            "commanders": sorted(([key, sum(s["totals"], [])] for key, s in standings.items()), key=lambda c: (-c[1][-5], c[0])),
            "cards": kept,
            "stats": [[x for d, n, lift, evidence in overall[c] for x in (d, n, round(lift * 10000), round(evidence * 100))]
                      for c in kept]})
    commanders, trends = [], []
    for key, decks in groups.items():
        if len(decks) < MIN_DECKS:
            continue
        here = Counter(c for _, played in decks for c in played)
        known_themes = themes(here, len(decks), usual, card_tags)
        price = median([round(100 * sum(prices[o] * k for o, k in d["cards"].items() if o in prices and o not in basic))
                        for d, _ in decks], -1)
        bracket = median([d["bracket"] for d, _ in decks if d.get("bracket")], 0)
        # Trends: decks made ever and in each window, and how many of them play each card. Only cards
        # at least TREND_SHARE of the decks play in some window, which keeps the file to about a MB.
        # ponytail: a card under that in every commander's decks is missing from filtered Trends;
        # per-identity totals (exact) if that matters
        counts, plays = window_plays(decks, since, made)
        trends.append([key, counts, price, bracket, known_themes, trend_cards(counts, plays, TREND_SHARE, TREND_DECKS)])

        decks = sorted(decks, key=lambda x: (x[0]["updated"], str(x[0]["id"])), reverse=True)[:MAX_DECKS]
        here = Counter(c for _, played in decks for c in played)
        played_most = sorted(here, key=lambda c: (-here[c], c))
        position = {c: i for i, c in enumerate(played_most)}
        lift = {c: here[c] / len(decks) - everywhere[c] / total for c in here}
        signature = sorted(here, key=lambda c: -lift[c])
        by_tag = defaultdict(list)
        for i, c in enumerate(played_most if len(decks) >= BUILD_DECKS else []):
            if here[c] >= max(2, COMMON * len(decks)) and "Land" not in cards[c].get("type_line", ""):
                for t in card_tags[c]:
                    by_tag[t].append(i)
        write_json(os.path.join(out_dir, f"{key}.json"), {
            "cards": played_most,
            "decks": [[d["id"], d["name"][:80], d["updated"], gaps(sorted(position[c] for c in played)), made[d["id"]],
                       d.get("bracket") or 0]
                      for d, played in decks],
            "signature": signature[:SHOWN_SIGNATURE],
            "tags": [[t, gaps(ps)] for t, ps in sorted(by_tag.items()) if len(ps) >= 2],
            "price": price, "bracket": bracket, "themes": known_themes,
            **({"results": standings[key]["totals"][-1][0]} if key in standings else {}),
        })
        if key in standings:
            write_json(os.path.join(out_dir, "results", f"{key}.json"), standings[key])
        commanders.append([key, counts[0], signature[:SIGNATURE]])
    commanders.sort(key=lambda c: -c[1])
    write_json(os.path.join(out_dir, "index.json"),
               {"decks": total, "commanders": commanders, "windows": WINDOWS, "since": since})
    trends.sort(key=lambda c: -c[1][0])
    names = sorted({t for c in trends for t in c[4]})
    for c in trends:
        c[4] = [names.index(t) for t in c[4]]
    # Every deck of these commanders, exactly: what Trends shows until a filter is picked
    counts, plays = window_plays([x for key, *_ in trends for x in groups[key]], since, made)
    write_json(os.path.join(out_dir, "trends.json"), {
        "themes": names, "everything": [counts, *trend_cards(counts, plays, 0, TREND_DECKS)],
        "commanders": [c[:5] for c in trends]})
    write_json(os.path.join(out_dir, "trend-cards.json"), [c[5] for c in trends])
    size = lambda f: os.path.getsize(os.path.join(out_dir, f)) / 1e6
    print(f"Wrote {out_dir}: {total} decks, {len(commanders)} commanders, {sum(map(size, os.listdir(out_dir))):.1f} MB "
          f"in total (trends.json {size('trends.json'):.1f} MB, trend-cards.json {size('trend-cards.json'):.1f} MB)")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("crawl", help="download decks from Archidekt or Moxfield into the corpus")
    c.add_argument("--site", choices=["archidekt", "moxfield"], default="archidekt",
                   help="where to crawl (default: %(default)s); moxfield needs build_index.py's default_cards")
    c.add_argument("--per-commander", type=int, default=100,
                   help="new decks to fetch per commander (0: only recently updated decks)")
    c.add_argument("--only", nargs="*", help="crawl just these commanders (card names; double-faced ones by either)")
    c.add_argument("--hours", type=float, help="stop after this long")
    c.add_argument("--top", type=int, help="instead: top up the N most played commanders to --per-commander decks each")
    c.add_argument("--bracket", type=int, choices=range(1, 6), help="only decks their builders gave this bracket")
    c.add_argument("--rate", type=float, default=1 / DELAY, help="requests a second (default: %(default)g)")
    c.add_argument("--no-upload", action="store_true",
                   help="don't merge with and upload to the deck-corpus release when the crawl stops")
    r = sub.add_parser("results", help="download the last year's cEDH tournament results from edhtop16")
    r.add_argument("--hours", type=float, help="stop after this long")
    sub.add_parser("build", help="write site/decks/ from the corpus")
    args = p.parse_args()
    sys.stdout.reconfigure(errors="replace")  # deck names with emoji can't crash a non-UTF-8 console
    if args.cmd == "crawl":
        DELAY = 1 / args.rate
        crawl(args.per_commander, args.only, args.hours, args.top, upload=not args.no_upload, site=args.site,
              bracket=args.bracket)
    elif args.cmd == "results":
        fetch_results(args.hours)
    else:
        build(load_corpus(), by_popularity(load_cards()), load_oracle_tags(), prices=load_printings()[0],
              results=load_corpus(RESULTS))
