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
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date

from build_index import by_popularity, load_cards, write_json

ARCHIDEKT = "https://archidekt.com/api"
CORPUS = "decks.jsonl.gz"
HEADERS = {"User-Agent": "MTG_Vec2Search/1.0 (+https://github.com/grahamirwin/MTG_Vec2Search)",
           "Accept": "application/json", "Accept-Encoding": "gzip"}
COMMANDER_FORMAT = 3  # Archidekt's deckFormat id for Commander / EDH
DELAY = 1.0  # seconds between requests; Archidekt is a small team, so crawl politely
MIN_CARDS, MAX_CARDS = 95, 105  # roughly complete 100-card decks
MAX_PAGES = 50  # the search API stops returning results after ~50 pages
STATE = "crawl_state.json"  # when each commander was last crawled, so crawls take turns


_last = 0.0
_lock = threading.Lock()


def get_json(path):
    """GET an Archidekt API path, at most one request per DELAY seconds (across threads), retrying on errors."""
    global _last
    for attempt in range(5):
        with _lock:
            _last = max(_last + DELAY, time.time())
            wait = _last - time.time()
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
    """(id, last update date) of complete Commander decks, most recently updated first,
    optionally only those led by this commander."""
    query = {"deckFormat": COMMANDER_FORMAT, "orderBy": "-updatedAt", "pageSize": 50}
    if commander:
        query["commanderName"] = commander
    for page in range(1, pages + 1):
        data = get_json("/decks/v3/?" + urllib.parse.urlencode({**query, "page": page}))
        for d in (data or {}).get("results") or []:
            if MIN_CARDS <= d.get("size", 0) <= MAX_CARDS and not d.get("private") and not d.get("unlisted"):
                yield d["id"], (d.get("updatedAt") or "")[:10]
        if not data or not data.get("next"):
            return


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


def crawl(per_commander, only=None, hours=None, top=None, path=CORPUS, state_path=STATE):
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
            for deck_id, updated in found:
                if added >= limit or time.time() > deadline or stop.is_set():
                    break
                with lock:
                    if have.get(deck_id, "") >= updated:  # already have this version
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
          f"{len(corpus):,} in {path} (was {before:,}).\n"
          f"Share it with the site: gh release upload deck-corpus {path} {state_path} --clobber", flush=True)


# === Build site/decks/ ===
# One file per commander (or partner pair), named after its card number(s) in the card index, so
# a search downloads just the decks for the pasted deck's commander:
#   <card>.json / <card>-<card>.json
#       cards  the cards these decks play (card numbers), most played first
#       decks  [archidekt id, name, last updated, cards], the newest MAX_DECKS; cards are
#              positions in `cards`, sorted and stored as gaps (popular cards have small
#              positions, so the gaps are small numbers; same idea as index/t/)
#   index.json  every commander with a file: [file name, deck count, signature cards], where the
#              signature cards are what its decks play far more often than other decks do. Used to
#              find decks with other commanders, and for commanders without enough decks.
OUT_DIR = os.path.join("site", "decks")
MIN_DECKS = 5  # fewer decks than this don't make useful recommendations
MAX_DECKS = 3000  # per commander, newest first: keeps a file around 300 KB to download
SIGNATURE = 24


def gaps(numbers):
    return [b - a for a, b in zip([0] + numbers, numbers)]


def build(corpus, cards, out_dir=OUT_DIR):
    """corpus: {id: deck} (see slim_deck); cards: Scryfall cards in card-index order."""
    number = {c["oracle_id"]: i for i, c in enumerate(cards) if c.get("oracle_id")}
    basic = {c["oracle_id"] for c in cards if "Basic" in c.get("type_line", "")}
    groups = defaultdict(list)
    for d in corpus.values():
        if not all(o in number for o in d["commanders"]):
            continue
        key = "-".join(str(n) for n in sorted(number[o] for o in d["commanders"]))
        played = sorted({number[o] for o in d["cards"]
                         if o in number and o not in basic and o not in d["commanders"]})
        groups[key].append((d, played))

    everywhere = Counter(c for decks in groups.values() for _, played in decks for c in played)
    total = sum(len(decks) for decks in groups.values())
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    commanders = []
    for key, decks in groups.items():
        if len(decks) < MIN_DECKS:
            continue
        decks = sorted(decks, key=lambda x: (x[0]["updated"], x[0]["id"]), reverse=True)[:MAX_DECKS]
        here = Counter(c for _, played in decks for c in played)
        played_most = sorted(here, key=lambda c: (-here[c], c))
        position = {c: i for i, c in enumerate(played_most)}
        write_json(os.path.join(out_dir, f"{key}.json"), {
            "cards": played_most,
            "decks": [[d["id"], d["name"][:80], d["updated"], gaps(sorted(position[c] for c in played))]
                      for d, played in decks],
        })
        lift = {c: here[c] / len(decks) - everywhere[c] / total for c in here}
        commanders.append([key, len(decks), sorted(here, key=lambda c: -lift[c])[:SIGNATURE]])
    commanders.sort(key=lambda c: -c[1])
    write_json(os.path.join(out_dir, "index.json"), {"decks": total, "commanders": commanders})
    size = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir))
    print(f"Wrote {out_dir}: {total} decks, {len(commanders)} commanders, {size / 1e6:.1f} MB in total")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("crawl", help="download decks from Archidekt into the corpus")
    c.add_argument("--per-commander", type=int, default=100,
                   help="new decks to fetch per commander (0: only recently updated decks)")
    c.add_argument("--only", nargs="*", help="crawl just these commanders (exact names)")
    c.add_argument("--hours", type=float, help="stop after this long")
    c.add_argument("--top", type=int, help="instead: top up the N most played commanders to --per-commander decks each")
    c.add_argument("--rate", type=float, default=1 / DELAY, help="requests a second (default: %(default)g)")
    sub.add_parser("build", help="write site/decks/ from the corpus")
    args = p.parse_args()
    sys.stdout.reconfigure(errors="replace")  # deck names with emoji can't crash a non-UTF-8 console
    if args.cmd == "crawl":
        DELAY = 1 / args.rate
        crawl(args.per_commander, args.only, args.hours, args.top)
    else:
        build(load_corpus(), by_popularity(load_cards()))
