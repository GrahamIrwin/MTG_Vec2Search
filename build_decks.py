"""Crawl public Commander decks from Archidekt into decks.jsonl.gz, the deck corpus, and turn
it into site/decks/, the data behind "Find similar decks".

    python build_decks.py crawl --hours 5     # resumable: stop and restart any time
    python build_decks.py crawl --top 3500 --per-commander 20 --rate 3   # fill in popular commanders
    python build_decks.py build               # after build_index.py (uses its card numbers)
"""
import argparse
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
CORPUS = "decks.jsonl.gz"
HEADERS = {"User-Agent": "MTG_Vec2Search/1.0 (+https://github.com/grahamirwin/MTG_Vec2Search)",
           "Accept": "application/json", "Accept-Encoding": "gzip"}
COMMANDER_FORMAT = 3  # Archidekt's deckFormat id for Commander / EDH
DELAY = 1.0  # seconds between requests; Archidekt is a small team, so crawl politely
MIN_CARDS, MAX_CARDS = 95, 105  # roughly complete 100-card decks
MAX_PAGES = 50  # the search API stops returning results after ~50 pages
STATE = "crawl_state.json"  # when each commander was last crawled, so crawls take turns
RELEASE = "deck-corpus"  # the GitHub release the corpus lives on (too big for git)


_last = 0.0
_lock = threading.Lock()


def get_json(path):
    """GET an Archidekt API path, at most one request per DELAY seconds (across threads), retrying on errors."""
    global _last
    for attempt in range(5):
        with _lock:
            now = time.time()  # one reading: a second, later one could make the wait negative
            _last = max(_last + DELAY, now)
            wait = _last - now
        time.sleep(wait)
        try:
            with urllib.request.urlopen(urllib.request.Request(ARCHIDEKT + path, headers=HEADERS), timeout=60) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 500, 502, 503, 504):
                raise
            problem = f"answered {e.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            problem = f"didn't answer ({getattr(e, 'reason', e)})"
        wait = 30 * 2 ** attempt  # back off: 30s, 1m, 2m, 4m, 8m
        with _lock:  # every thread backs off, not just this one
            _last = max(_last, time.time() + wait)
        print(f"  ! Archidekt {problem}; trying again in {duration(wait)}", flush=True)
    raise RuntimeError(f"Archidekt keeps failing for {path}")


def search_decks(commander=None, pages=MAX_PAGES):
    """(id, last update date, creation date) of complete Commander decks, most recently updated first,
    optionally only those led by this commander. A search stops after MAX_PAGES (3,000 decks),
    so a commander's search then goes on from its oldest decks: twice as many in all."""
    query = {"deckFormat": COMMANDER_FORMAT, "pageSize": 50}
    if commander:
        query["commanderName"] = commander
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


def crawl(per_commander, only=None, hours=None, top=None, upload=False, path=CORPUS, state_path=STATE):
    """First the decks updated most recently (new decks, and new versions of ones we have), then up
    to per_commander more decks for each commander: commanders never crawled first (most common
    in the corpus first), then the ones crawled longest ago, until `hours` run out.
    With `top`: instead, the `top` most played commanders, each topped up to per_commander decks,
    several at once (as fast as DELAY allows)."""
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
                deck = slim_deck(get_json(f"/decks/{deck_id}/") or {})
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
                          f"{lead[:40]:<40}  archidekt.com/decks/{deck_id}", flush=True)
            return added

        def take_turns(queue):  # threads take commanders off the queue: [(name, decks wanted)]
            jobs = iter(enumerate(queue, 1))

            def work():
                for i, (commander, want) in jobs:
                    if time.time() > deadline or stop.is_set():
                        return
                    added = fetch(search_decks(commander), want)
                    with lock:
                        state[commander] = date.today().isoformat()
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
                count = Counter(o for d in corpus.values() for o in d["commanders"])
                queue = [(name, per_commander - count[o]) for o, name in top_commanders(top) if count[o] < per_commander]
                print(f"{len(queue):,} of the top {top:,} commanders have fewer than {per_commander} decks\n", flush=True)
                take_turns(queue)
            elif not only:
                print("Recently updated decks on Archidekt:", flush=True)
                print(f"Recently updated: +{fetch(search_decks(), float('inf'))} decks ({progress()})\n", flush=True)
            done = set()
            while not top and per_commander and time.time() < deadline:
                if only:
                    queue = [c for c in only if c not in done]
                else:  # recounted each time: crawling one commander turns up decks for others
                    by_lead = Counter(names[o] for d in corpus.values() for o in d["commanders"] if o in names)
                    queue = sorted((c for c in by_lead if c not in done), key=lambda c: (state.get(c, ""), -by_lead[c]))
                if not queue:
                    break
                commander = queue[0]
                done.add(commander)
                print(f"[{len(done)}] {commander}" + (f" (last crawled {state[commander]})" if commander in state else ""), flush=True)
                added = fetch(search_decks(commander), per_commander)
                state[commander] = date.today().isoformat()
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
#       decks  [archidekt id, name, last updated, cards], the newest MAX_DECKS; cards are
#              positions in `cards`, sorted and stored as gaps (popular cards have small
#              positions, so the gaps are small numbers; same idea as index/t/)
#       signature  the SHOWN_SIGNATURE cards these decks play far more often than other decks do
#       tags   [Scryfall Tagger tag, gaps between positions in `cards`], over the nonland cards
#              at least COMMON of the decks play: what the site names a commander's builds by
#              (only for BUILD_DECKS decks or more, as fewer aren't split into builds)
#       price  what a typical (median) deck costs, in US cents (-1: unknown)
#       bracket  the typical bracket of the decks that give one (0: none do)
#       themes  the Tagger tags these decks play far more of than other decks do
#   index.json  every commander with a file: [file name, deck count, signature cards], where the
#              signature cards are what its decks play far more often than other decks do. Used to
#              find decks with other commanders, and for commanders without enough decks.
#              Also windows (days) and since: the first Archidekt deck id made in each window.
#   trends.json  themes (tag names); every commander with a file, most decks first: [file name,
#              decks made [ever, in each window], price, bracket, theme numbers]; and everything:
#              [decks made, gaps between the cards they play, [how many play each card, per window]]
#              over all their decks
#   trend-cards.json  the same as everything, for each commander in trends.json (most of its cards)
OUT_DIR = os.path.join("site", "decks")
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


def window_plays(decks, since):
    """For [(deck, cards it plays)]: how many were made ever and in each window (since: the first deck
    id in each), and how many of those play each card: {card: [ever, per window]}."""
    windows = [[1] + [int(s is not None and d["id"] >= s) for s in since] for d, _ in decks]
    made = [sum(col) for col in zip(*windows)] or [0] * (len(since) + 1)
    plays = defaultdict(lambda: [0] * len(made))
    for (_, played), w in zip(decks, windows):
        for c in played:
            for k, inside in enumerate(w):
                plays[c][k] += inside
    return made, plays


def trend_cards(made, plays, share, least):
    """[gaps between the cards at least `share` of the decks and `least` decks play in some window,
    [how many play each, per window]]"""
    kept = sorted(c for c, ks in plays.items() if any(k >= max(least, share * m) for k, m in zip(ks, made)))
    return [gaps(kept), [[plays[c][k] for c in kept] for k in range(len(made))]]


def median(values, missing):
    values = sorted(values)
    return values[len(values) // 2] if values else missing


def build(corpus, cards, tags=None, out_dir=OUT_DIR, prices=None, today=None):
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

    # Archidekt numbers decks as they're made, so a window is every deck from the first one made in
    # it on: decks crawled before creation dates were kept count too. None: no known deck is older,
    # so where the window starts isn't known yet.
    today = today or date.today()
    known = [(d["created"], d["id"]) for d in corpus.values() if d.get("created")]
    since = []
    for days in WINDOWS:
        cutoff = (today - timedelta(days)).isoformat()
        after = [i for made, i in known if made >= cutoff]
        since.append(min(after) if after and any(made < cutoff for made, _ in known) else None)

    everywhere = Counter(c for decks in groups.values() for _, played in decks for c in played)
    total = sum(len(decks) for decks in groups.values())
    usual = Counter()
    for c, k in everywhere.items():
        for t in card_tags[c]:
            usual[t] += k / total
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
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
        made, plays = window_plays(decks, since)
        trends.append([key, made, price, bracket, known_themes, trend_cards(made, plays, TREND_SHARE, TREND_DECKS)])

        decks = sorted(decks, key=lambda x: (x[0]["updated"], x[0]["id"]), reverse=True)[:MAX_DECKS]
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
            "decks": [[d["id"], d["name"][:80], d["updated"], gaps(sorted(position[c] for c in played))]
                      for d, played in decks],
            "signature": signature[:SHOWN_SIGNATURE],
            "tags": [[t, gaps(ps)] for t, ps in sorted(by_tag.items()) if len(ps) >= 2],
            "price": price, "bracket": bracket, "themes": known_themes,
        })
        commanders.append([key, made[0], signature[:SIGNATURE]])
    commanders.sort(key=lambda c: -c[1])
    write_json(os.path.join(out_dir, "index.json"),
               {"decks": total, "commanders": commanders, "windows": WINDOWS, "since": since})
    trends.sort(key=lambda c: -c[1][0])
    names = sorted({t for c in trends for t in c[4]})
    for c in trends:
        c[4] = [names.index(t) for t in c[4]]
    # Every deck of these commanders, exactly: what Trends shows until a filter is picked
    made, plays = window_plays([x for key, *_ in trends for x in groups[key]], since)
    write_json(os.path.join(out_dir, "trends.json"), {
        "themes": names, "everything": [made, *trend_cards(made, plays, 0, TREND_DECKS)],
        "commanders": [c[:5] for c in trends]})
    write_json(os.path.join(out_dir, "trend-cards.json"), [c[5] for c in trends])
    size = lambda f: os.path.getsize(os.path.join(out_dir, f)) / 1e6
    print(f"Wrote {out_dir}: {total} decks, {len(commanders)} commanders, {sum(map(size, os.listdir(out_dir))):.1f} MB "
          f"in total (trends.json {size('trends.json'):.1f} MB, trend-cards.json {size('trend-cards.json'):.1f} MB)")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("crawl", help="download decks from Archidekt into the corpus")
    c.add_argument("--per-commander", type=int, default=100,
                   help="new decks to fetch per commander (0: only recently updated decks)")
    c.add_argument("--only", nargs="*", help="crawl just these commanders (card names; double-faced ones by either)")
    c.add_argument("--hours", type=float, help="stop after this long")
    c.add_argument("--top", type=int, help="instead: top up the N most played commanders to --per-commander decks each")
    c.add_argument("--rate", type=float, default=1 / DELAY, help="requests a second (default: %(default)g)")
    c.add_argument("--no-upload", action="store_true",
                   help="don't merge with and upload to the deck-corpus release when the crawl stops")
    sub.add_parser("build", help="write site/decks/ from the corpus")
    args = p.parse_args()
    sys.stdout.reconfigure(errors="replace")  # deck names with emoji can't crash a non-UTF-8 console
    if args.cmd == "crawl":
        DELAY = 1 / args.rate
        crawl(args.per_commander, args.only, args.hours, args.top, upload=not args.no_upload)
    else:
        build(load_corpus(), by_popularity(load_cards()), load_oracle_tags(), prices=load_printings()[0])
