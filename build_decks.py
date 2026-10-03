"""Crawl public Commander decks from Archidekt into decks.jsonl.gz, the deck corpus, and turn
it into site/decks/, the data behind "Find similar decks".

    python build_decks.py crawl --hours 5     # resumable: stop and restart any time
    python build_decks.py build               # after build_index.py (uses its card numbers)
"""
import argparse
import gzip
import json
import os
import shutil
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


def get_json(path):
    """GET an Archidekt API path, at most one request per DELAY seconds, retrying on errors."""
    global _last
    for attempt in range(5):
        time.sleep(max(0.0, _last + DELAY - time.time()))
        _last = time.time()
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
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(30 * 2 ** attempt)  # back off: 30s, 1m, 2m, 4m, 8m
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


def crawl(per_commander, only=None, hours=None, path=CORPUS, state_path=STATE):
    """First the decks updated most recently (new decks, and new versions of ones we have), then up
    to per_commander more decks for each commander: commanders never crawled first (most common
    in the corpus first), then the ones crawled longest ago, until `hours` run out."""
    deadline = time.time() + hours * 3600 if hours else float("inf")
    corpus = load_corpus(path)
    # Rewritten first too: decks appended after one cut off by a stopped crawl couldn't be read
    save_corpus(corpus, path)
    have = {i: d["updated"] for i, d in corpus.items()}
    state = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    print(f"{len(have)} decks already in {path}", flush=True)

    # Each deck is its own gzip member, so stopping the crawl can only cut off the last one
    with open(path, "ab") as out:
        def fetch(found, limit):
            added = 0
            for deck_id, updated in found:
                if added >= limit or time.time() > deadline:
                    break
                if have.get(deck_id, "") >= updated:  # already have this version
                    continue
                have[deck_id] = updated
                deck = slim_deck(get_json(f"/decks/{deck_id}/") or {})
                if deck:
                    out.write(gzip.compress((json.dumps(deck, separators=(",", ":")) + "\n").encode()))
                    out.flush()
                    corpus[deck_id] = deck
                    added += 1
            return added

        if not only:
            print(f"Recently updated: +{fetch(search_decks(), float('inf'))} decks", flush=True)
            names = card_names()
        done = set()
        while per_commander and time.time() < deadline:
            if only:
                queue = [c for c in only if c not in done]
            else:  # recounted each time: crawling one commander turns up decks for others
                counts = Counter(names[o] for d in corpus.values() for o in d["commanders"] if o in names)
                queue = sorted((c for c in counts if c not in done), key=lambda c: (state.get(c, ""), -counts[c]))
            if not queue:
                break
            commander = queue[0]
            done.add(commander)
            added = fetch(search_decks(commander), per_commander)
            state[commander] = date.today().isoformat()
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=0, sort_keys=True)
            print(f"[{len(done)}] {commander}: +{added} decks ({len(corpus)} in all)", flush=True)

    save_corpus(corpus, path)


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
    sub.add_parser("build", help="write site/decks/ from the corpus")
    args = p.parse_args()
    if args.cmd == "crawl":
        crawl(args.per_commander, args.only, args.hours)
    else:
        build(load_corpus(), by_popularity(load_cards()))
