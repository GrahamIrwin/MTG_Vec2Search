"""Keep prices.jsonl.gz, the price history of every paper printing (nonfoil, foil and etched, in US
dollars and euros), on the price-history release (too big for git). Additive: a day already in it
is never replaced.

    python build_prices.py snapshot    # add the day's prices from default_cards.jsonl.gz (the daily crawl does this)
    python build_prices.py backfill    # add every older day we can find: the Wayback Machine's copies of
                                       # Scryfall's bulk files and MTGJSON's price files, Hugging Face datasets
                                       # of them, and MTGJSON's last 90 days
    python build_prices.py share       # merge with the release and upload (snapshot and backfill do this
                                       # unless given --no-upload)
    python build_prices.py site        # write site/prices/ (after build_index.py: it uses its card numbers)
    python build_prices.py goldfish --hours 24   # fetch daily histories to fill the days between ours
                                                 # (resumable: stop and run it again any time)
    python build_prices.py goldfish --hours 24 --workers 3   # the same, 3 at a time (each its own file, merged after)
    python build_prices.py goldfish --stop       # stop a crawl that's running (or Ctrl+C it)
    python build_prices.py goldfish --least 1    # printings under MIN_MOVER cents too (the default leaves them out)

The file's first line is {"days": {day: where its prices came from}, "sources": [files imported]}.
Then a line per printing (Scryfall id), with a series per price: [[day, cents], ...], a point only
where the price changed since the day before it in "days" (null when it stopped having one). A
printing's price on a day in "days" is its series' last point on or before that day. A day without
any of a price (a source that missed Cardmarket's that day, say) keeps every printing's one before.
"""
import bisect
import bz2
import csv
import gzip
import html
import http.client
import io
import json
import lzma
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from collections import Counter, defaultdict
from datetime import date, datetime, timezone

from build_index import (HEADERS, PRINTINGS_FILE, SCRYFALL_BULK_LIST_URL, by_popularity, fetch, load_cards,
                         load_oracle_tags, write_json)

HISTORY = "prices.jsonl.gz"
RELEASE = "price-history"
FIELDS = ("usd", "usd_foil", "usd_etched", "eur", "eur_foil")
# MTGJSON's retail prices: TCGplayer's are what Scryfall shows in dollars, Cardmarket's in euros
MTGJSON_FIELDS = {"tcgplayer": {"normal": "usd", "foil": "usd_foil", "etched": "usd_etched"},
                  "cardmarket": {"normal": "eur", "foil": "eur_foil"}}
MTGJSON = "https://mtgjson.com/api/v5"
WAYBACK = "http://web.archive.org"
HF = "https://huggingface.co"
SITE = os.path.join("site", "prices")
EPOCH = date(1993, 1, 1)  # app.js counts days from it
WINDOWS = (7, 30, 90, 365)  # days back the Prices page compares with
US = ("usd", "usd_foil", "usd_etched")  # the site shows US prices, in the visitor's currency
# cents: cheaper printings move by cents, which make big percentages. Under $1 because the Prices
# page's lowest filter is 1 of the visitor's currency, as low as about 60 US cents
MIN_MOVER = 50
BANDS = (50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000)  # cents: where each band of prices starts
TOP = 150  # rises and falls kept per finish and band
ALT_FROM = 500  # cents: a card this pricey gets cheaper alternatives
ALT_SHARE = 0.5  # at most this share of its price
ALT_SHOWN = 6
ALT_LEAST = 0.35  # an alternative has at least this much of the card's tags (weighted, as alternatives())
ALT_TAG_MOST = 1500  # tags on more cards than this say too little to find alternatives by
ALT_BLOCK = 256  # cards per prices/alts/ file
CARD_TYPES = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land"]
REPRINT_DAYS = 120  # a printing this new is a reprint, when its card has printings older than
REPRINT_OLDER = 180  # this many days before it
REPRINT_BEFORE = 45  # an older printing's price before a reprint: this many days before it came out
ESTIMATE_MOVE = 0.01  # an estimated price is kept (for the site) where it moved this much since the last kept one


def load(path=HISTORY):
    hist = {"days": {}, "sources": [], "series": {}}
    if not os.path.exists(path):
        return hist
    with gzip.open(path, "rt", encoding="utf-8") as f:
        hist.update(json.loads(next(f)))
        for line in f:
            row = json.loads(line)
            i = row.pop("id")
            hist["series"][i] = {k: ([d for d, _ in v], [c for _, c in v]) for k, v in row.items()}
    return hist


def save(hist, path=HISTORY):
    with gzip.open(path + ".tmp", "wt", encoding="utf-8") as f:  # then renamed: a crash can't leave half a file
        f.write(json.dumps({"days": dict(sorted(hist["days"].items())), "sources": hist["sources"]}) + "\n")
        for i, s in hist["series"].items():
            f.write(json.dumps({"id": i, **{k: list(map(list, zip(*v))) for k, v in s.items()}},
                               separators=(",", ":")) + "\n")
    os.replace(path + ".tmp", path)


def at(series, day):
    """A series' price on a day: its last point on or before it."""
    days, cents = series
    k = bisect.bisect_right(days, day)
    return cents[k - 1] if k else None


def compact(series):
    """Drop points that repeat the price before them (and leading nulls)."""
    days, cents = series
    keep = [k for k in range(len(days)) if cents[k] != (cents[k - 1] if k else None)]
    series[0][:], series[1][:] = [days[k] for k in keep], [cents[k] for k in keep]


def put(series, day, c):
    days, cents = series
    k = bisect.bisect_left(days, day)
    if k < len(days) and days[k] == day:
        cents[k] = c
    else:
        days.insert(k, day)
        cents.insert(k, c)


def add_day(hist, day, source, snap):
    """Add a day's prices, snap = {printing: {field: cents}}; a printing or price it lacks had none
    that day, unless no printing has that price: then the source didn't collect it that day (MTGJSON
    has days without Cardmarket's), and each printing keeps the one before. Days can come in any
    order. Returns whether the day was new."""
    if day in hist["days"]:
        return False
    after = min((d for d in hist["days"] if d > day), default=None)
    hist["days"][day] = source
    collected = {f for v in snap.values() for f in v}
    for i in set(hist["series"]) | set(snap):
        s, new = hist["series"].setdefault(i, {}), snap.get(i, {})
        for field in (set(s) | set(new)) & collected:
            series = s.setdefault(field, ([], []))
            c = new.get(field)
            if c == at(series, day):  # the price it already carried
                continue
            if after is None:  # the newest day: the usual case, and cheap
                series[0].append(day)
                series[1].append(c)
                continue
            # The next day after it carried the price from before it; pin that price there first
            put(series, after, at(series, after))
            put(series, day, c)
            compact(series)
        for field in [f for f, v in s.items() if not v[0]]:
            del s[field]
        if not s:
            del hist["series"][i]
    return True


def on(hist, day):
    """Every printing's prices on a day in hist, as add_day takes them."""
    snap = {}
    for i, s in hist["series"].items():
        got = {f: c for f, v in s.items() if (c := at(v, day)) is not None}
        if got:
            snap[i] = got
    return snap


def merge(hist, other):
    """Add the days another copy of the history has that this one doesn't. Returns how many."""
    new = sorted(set(other["days"]) - set(hist["days"]))
    for day in new:
        add_day(hist, day, other["days"][day], on(other, day))
    hist["sources"] += [s for s in other["sources"] if s not in hist["sources"]]
    return len(new)


def scryfall_snapshot(cards):
    """{printing: {field: cents}} from Scryfall card objects."""
    snap = {}
    for c in cards:
        p = c.get("prices") or {}
        got = {f: round(float(p[f]) * 100) for f in FIELDS if p.get(f)}
        if got and not c.get("digital"):
            snap[c["id"]] = got
    return snap


def mtgjson_days(data, ids):
    """{day: {printing: {field: cents}}} from MTGJSON's AllPrices data; ids = its uuid -> Scryfall id."""
    days = defaultdict(dict)
    for uuid, p in data.items():
        if not (i := ids.get(uuid)):
            continue
        for provider, finishes in MTGJSON_FIELDS.items():
            retail = (((p.get("paper") or {}).get(provider) or {}).get("retail")) or {}
            for finish, field in finishes.items():
                for day, price in (retail.get(finish) or {}).items():
                    days[day].setdefault(i, {})[field] = round(price * 100)
    return days


def mtgjson_csv(text):
    """MTGJSON's cardPrices.csv as the AllPrices data it has the same prices as."""
    data = {}
    for r in csv.DictReader(io.StringIO(text)):
        if r["gameAvailability"] == "paper" and r["providerListing"] == "retail":
            provider = data.setdefault(r["uuid"], {"paper": {}})["paper"].setdefault(r["priceProvider"], {"retail": {}})
            provider["retail"].setdefault(r["cardFinish"], {})[r["date"]] = float(r["price"])
    return data


def parquet_days(table):
    """{day: {printing: {field: cents}}} from a table of MTGJSON's prices by Scryfall id (columns
    scryfall_id, medium, provider, list_type, finish, date, price), like mtgjson_days."""
    cols = table.select(["scryfall_id", "medium", "provider", "list_type", "finish", "date", "price"]).to_pydict()
    days = defaultdict(dict)
    for i, medium, provider, listing, finish, day, price in zip(*cols.values()):
        field = MTGJSON_FIELDS.get(provider, {}).get(finish)
        if field and medium == "paper" and listing == "retail" and i and price:
            days[str(day)[:10]].setdefault(i, {})[field] = round(price * 100)
    return days


def mtgjson4_days(printings):
    """{day: {printing: {field: cents}}} from MTGJSON 4's AllPrintings: TCGplayer's prices. A few
    printings kept a price from weeks before, so only the day nearly all have counts."""
    days = defaultdict(dict)
    for s in printings.get("data", printings).values():
        for c in s.get("cards", []):
            for key, field in (("paper", "usd"), ("paperFoil", "usd_foil")):
                for day, price in ((c.get("prices") or {}).get(key) or {}).items():
                    if c.get("scryfallId") and price:
                        days[day].setdefault(c["scryfallId"], {})[field] = round(price * 100)
    most = max(days, key=lambda d: len(days[d]), default=None)
    return {most: days[most]} if most else {}


def get(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=600) as r:
                return r.read()
        except (OSError, http.client.HTTPException) as e:  # HTTPException: a connection cut off mid-read
            if k == tries - 1:
                raise
            print(f"  {e}; trying again in {30 * (k + 1)}s", flush=True)
            time.sleep(30 * (k + 1))


def unpack(raw, name):
    """A downloaded file's text, whatever it was compressed with."""
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    elif name.endswith(".xz"):
        raw = lzma.decompress(raw)
    elif name.endswith(".bz2"):
        raw = bz2.decompress(raw)
    elif name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            raw = z.read(z.namelist()[0])
    return raw.decode("utf-8")


def cards_in(text):
    """Scryfall card objects from a bulk file: a JSON array, or one card a line."""
    if text.lstrip().startswith("["):
        return json.loads(text)
    return (json.loads(line) for line in text.splitlines() if line.strip())


def archived(pattern, least):
    """[(timestamp, url)] the Wayback Machine has of a URL pattern, files of at least `least` bytes."""
    rows = json.loads(get(f"{WAYBACK}/cdx/search/cdx?url={pattern}&output=json"
                          "&fl=timestamp,original,length&filter=statuscode:200&collapse=digest"))
    return [(t, u) for t, u, n in rows[1:] if int(n) >= least]


def snapshot(path=PRINTINGS_FILE):
    """Add the day's prices from Scryfall's default_cards, dated by when Scryfall made the file."""
    with fetch(SCRYFALL_BULK_LIST_URL) as r:
        updated = next(i for i in json.load(r)["data"] if i["type"] == "default_cards")["updated_at"]
    made = datetime.fromisoformat(updated)
    if datetime.fromtimestamp(os.path.getmtime(path), timezone.utc) < made:
        sys.exit(f"{path} is older than Scryfall's latest; download it again first (python build_index.py)")
    hist = load()
    with gzip.open(path, "rt", encoding="utf-8") as f:
        new = add_day(hist, made.date().isoformat(), "scryfall", scryfall_snapshot(json.loads(line) for line in f))
    save(hist)
    print(f"{'Added' if new else 'Already had'} {made.date()}: {len(hist['days'])} days in all", flush=True)


def backfill():
    """Add every older day we can find. Each file is imported once (saved after each), so it can
    stop and go on."""
    hist, ids = load(), None
    today = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    # The Wayback Machine's copies of Scryfall's bulk files (a day each, every printing's prices) and
    # of MTGJSON's price files (AllPrices has 90 days, AllPricesToday one), then MTGJSON's current
    # AllPrices. Oldest first: adding days in order is far quicker
    # (all_cards, every language, only for days default_cards has no copy of: it's 4 times bigger)
    files = [(t, u, "scryfall") for t, u in archived("data.scryfall.io/default-cards/*", 10_000_000)
             + archived("data.scryfall.io/all-cards/*", 10_000_000)]
    files += [(t, u, "mtgjson") for t, u in archived("mtgjson.com/api/v5/AllPrices*", 1_000_000)
              + archived("mtgjson.com/api/v5/csv/cardPrices.csv*", 1_000_000)
              if u.endswith((".json", ".csv")) or re.search(r"\.(json|csv)\.(gz|xz|bz2|zip)$", u)]
    # MTGJSON 4's AllPrintings had each printing's TCGplayer prices in it
    files += [(t, u, "mtgjson4") for t, u in archived("mtgjson.com/json/AllPrintings.json*", 10_000_000)]
    # Hugging Face datasets: MTGJSON's 90 days as of September 2026, and Scryfall's default_cards
    # uploaded now and then (each upload a day: the day it was uploaded)
    files += [("20260924000000", f"{HF}/datasets/pcwoods/mtg-card-prices/resolve/main/price_history.parquet", "parquet-prices")]
    commits = json.loads(get(f"{HF}/api/datasets/nishtahir/scryfall-default-cards/commits/main"))
    files += [(re.sub(r"\D", "", c["date"])[:14], f"{HF}/datasets/nishtahir/scryfall-default-cards/resolve/{c['id']}"
               "/data/train-00000-of-00001.parquet", "parquet-cards") for c in commits if c["title"] == "Upload dataset"]
    files.sort(key=lambda f: (f[0][:8], "all-cards" in f[1], f[0]))
    for t, url, kind in files + [(today, f"{MTGJSON}/AllPrices.json.gz", "today")]:
        key = f"{t[:8]}/{url.split('.json')[0].split('.csv')[0]}"  # in another compression it's the same days
        if key in hist["sources"] or f"truncated: {t}/{url}" in hist["sources"]:
            continue
        made = re.search(r"-(\d{4})(\d\d)(\d\d)\d{6}\.json", url)  # default-cards-20240506090530.json
        day = "-".join(made.groups()) if kind == "scryfall" else f"{t[:4]}-{t[4:6]}-{t[6:8]}" if kind == "parquet-cards" else None
        if day in hist["days"]:
            continue
        print(f"{t[:8]}: {url}", flush=True)
        try:
            raw = get(url if kind in ("today", "parquet-prices", "parquet-cards") else f"{WAYBACK}/web/{t}id_/{url}")
            if kind.startswith("parquet"):
                import pyarrow.parquet  # only for these two files: pip install pyarrow
                table = pyarrow.parquet.read_table(io.BytesIO(raw))
                del raw
                if kind == "parquet-cards":
                    add_day(hist, day, "scryfall", scryfall_snapshot(table.select(["id", "prices", "digital"]).to_pylist()))
                else:
                    added = [d for d, snap in sorted(parquet_days(table).items()) if add_day(hist, d, "mtgjson", snap)]
                    print(f"  {len(added)} new days" + (f": {added[0]} to {added[-1]}" if added else ""), flush=True)
                hist["sources"].append(key)
                save(hist)
                continue
            text = unpack(raw, url)
            if kind == "scryfall":
                add_day(hist, day, "scryfall", scryfall_snapshot(cards_in(text)))
            else:
                if kind == "mtgjson4":
                    days = mtgjson4_days(json.loads(text))
                else:
                    if ids is None:
                        got = unpack(get(f"{MTGJSON}/csv/cardIdentifiers.csv.gz"), "ids.csv.gz")
                        ids = {r["uuid"]: r["scryfallId"] for r in csv.DictReader(io.StringIO(got)) if r["scryfallId"]}
                    data = mtgjson_csv(text) if ".csv" in url else json.loads(text)["data"]
                    days = mtgjson_days(data, ids)
                del text
                added = [d for d in sorted(days) if add_day(hist, d, "mtgjson", days[d])]
                print(f"  {len(added)} new days of {len(days)}" + (f": {added[0]} to {added[-1]}" if added else ""),
                      flush=True)
        except OSError as e:  # tried again next time
            print(f"  skipped: {e}", flush=True)
            continue
        except (ValueError, EOFError, zipfile.BadZipFile) as e:  # a truncated copy: never tried again
            print(f"  skipped: {e}", flush=True)
            hist["sources"].append(f"truncated: {t}/{url}")  # (another compression of it may work)
            save(hist)
            continue
        hist["sources"].append(key)
        save(hist)
        time.sleep(5)  # the Wayback Machine is free; go easy on it
    print(f"{len(hist['days'])} days in all, {len(hist['series']):,} printings", flush=True)


# === Daily history from another price guide (MTGGoldfish), to fill the days between ours ===
# Its prices are its own measure, 0-20% off TCGplayer's depending on the year, so they're kept apart
# (goldfish.jsonl, a line per printing and finish as it's fetched) and only used scaled to meet ours.
GOLDFISH = "https://www.mtggoldfish.com"
GOLDFISH_FILE = "goldfish.jsonl"
GOLDFISH_SETS = "goldfish_sets.json"  # Scryfall set code -> its set code, from its set pages
GOLDFISH_STOP = "goldfish.stop"  # there: the crawl stops after the printing it's on (goldfish --stop)
GOLDFISH_DELAY = 2.0  # seconds between requests
GOLDFISH_HEADERS = {"User-Agent": "MTG_Vec2Search/1.0 (+https://github.com/GrahamIrwin/MTG_Vec2Search)"}
_goldfish_next = 0.0


def goldfish_get(path, **headers):
    """GET a page of its site, at most one request per GOLDFISH_DELAY, waiting out errors that pass
    (429, 5xx). Returns the text, or None when it isn't there (404 and the like)."""
    global _goldfish_next
    for k in range(6):
        time.sleep(max(0.0, _goldfish_next - time.time()))
        _goldfish_next = time.time() + GOLDFISH_DELAY
        try:
            req = urllib.request.Request(GOLDFISH + path, headers={**GOLDFISH_HEADERS, **headers})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):  # 404, a page that redirects in a loop (301): not there
                print(f"  {path}: {e.code}", flush=True)
                return None
            print(f"  {e}; waiting {60 * (k + 1)}s", flush=True)
            time.sleep(60 * (k + 1))
        except http.client.InvalidURL as e:  # a link of theirs we can't ask for: not there
            print(f"  {path}: {e}", flush=True)
            return None
        except (OSError, http.client.HTTPException) as e:
            print(f"  {e}; waiting {60 * (k + 1)}s", flush=True)
            time.sleep(60 * (k + 1))
    raise RuntimeError(f"{path} kept failing")


def fold(name):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", name).lower())


def goldfish_sets(printings=PRINTINGS_FILE):
    """{Scryfall set code: its set code}, matched by set name, or else by set code ("Planechase 2012
    Edition" is PC2 both places), from its set pages. GOLDFISH_SETS keeps them and the pages it
    read ("_read"), so each is read once: new sets are read as they come."""
    codes = {}
    if os.path.exists(GOLDFISH_SETS):
        with open(GOLDFISH_SETS, encoding="utf-8") as f:
            codes = json.load(f)
    read = set(codes.pop("_read", []))
    ours, our_codes = {}, set()
    with gzip.open(printings, "rt", encoding="utf-8") as f:
        for c in map(json.loads, f):
            ours.setdefault(fold(c["set_name"]), c["set"])
            our_codes.add(c["set"])
    name = lambda slug: urllib.parse.unquote_plus(slug)
    slugs = sorted(set(re.findall(r'href="/sets/([^"#?]+)"', goldfish_get("/sets"))))
    if not read and codes:  # kept before it kept the pages it read: the ones matched by name were
        read = {slug for slug in slugs if ours.get(fold(name(slug))) in codes}
    todo = [slug for slug in slugs if slug not in read]
    for k, slug in enumerate(todo):
        page = goldfish_get(f"/sets/{slug}")
        m = page and (re.search(r"data-react-props='([^']*)'", page) or re.search(r'data-react-props="([^"]*)"', page))
        cards = json.loads(html.unescape(m.group(1))).get("cards", []) if m else []
        theirs = cards[0]["set"] if cards else None
        mine = ours.get(fold(name(slug))) or (theirs.lower() if theirs and theirs.lower() in our_codes else None)
        if theirs and mine and mine not in codes:
            codes[mine] = theirs
        read.add(slug)
        print(f"  set {k + 1}/{len(todo)} {name(slug)} ({theirs}): {mine or 'no match'}", flush=True)
    with open(GOLDFISH_SETS, "w", encoding="utf-8") as f:
        json.dump({**codes, "_read": sorted(read)}, f, indent=0, sort_keys=True)
    return codes


def goldfish_printings(page):
    """[(set slug, collector number or None, foil, set code, variant or "", card id)] of every
    printing of a card in every set, from one of its price pages."""
    out = []
    for card_id, href in dict.fromkeys(re.findall(r'data-card-id="([^"]*)"[^>]*href="(/price/[^"#]*)"', page or "")):
        card_id = html.unescape(card_id)
        m = re.fullmatch(r"/price/([^/]+)/(?:([^/]+)/)?[^/]+", html.unescape(href))
        code = re.search(r"\[([^\]]+)\]", card_id)
        if m and code:
            tag = re.search(r"<([^>]*)>", card_id)
            out.append((m.group(1), m.group(2), card_id.endswith("(F)"), code.group(1), tag.group(1) if tag else "", card_id))
    return out


# Scryfall's promo types, and the words of its variants they go by
PROMO_TAGS = {"prerelease": "prerelease", "datestamped": "prerelease", "promopack": "stamp", "stamped": "stamp",
              "buyabox": "buy-a-box", "bundle": "bundle", "release": "release", "boxtopper": "topper",
              "judgegift": "judge", "fnm": "fnm", "gameday": "game day", "instore": "store"}


def goldfish_match(printings, set_names, codes, number, foil, promo_types=()):
    """(card id, sure) of a printing among goldfish_printings(): in its set (by the set's name, its
    code, or ours: set_names[0] and codes[0]); or else a promo set's printing (pkhm) as a variant in
    the set it's from (set_names[1], codes[1]), or in a promo set of theirs its promo types name
    (Prerelease Cards, PRM-PRE). By its collector number ("TMP-315" on The List is 315 there, "17e"
    or "U36" may be 17 or 36) and finish; of several, the variant its promo types name, or else the
    plain one. sure: the one printing it could be, in its set. None if there's none."""
    tail = number.split("-")[-1]
    numbers = {number, tail, re.sub(r"\D+$", "", tail), re.sub(r"^\D+|\D+$", "", tail)}
    same = lambda a, b: bool(b) and fold(a).rstrip("s") == fold(b).rstrip("s")  # Ultimate Box Topper(s)
    wanted = [fold(PROMO_TAGS.get(t, t)) for t in promo_types]
    named = lambda slug, tag: any(w in fold(tag) or w in fold(slug) for w in wanted)
    promo = lambda tag: any(fold(w) in fold(tag) for w in PROMO_TAGS.values()) and not named("", tag)
    passes = (lambda slug, code, tag: (same(slug, set_names[0]) or code.lower() in codes[0]) and not promo(tag),
              lambda slug, code, tag: bool(tag) and (same(slug, set_names[1]) or code.lower() in codes[1]),
              lambda slug, code, tag: code.startswith("PRM") and named(slug, tag))
    for k, in_set in enumerate(passes):
        best, score, ties = None, -1, 0
        for slug, n, f, code, tag, card_id in printings:
            if f != foil or (n is not None and n not in numbers) or not in_set(slug, code, tag):
                continue
            s = (2 if n == number else 1 if n else 0) + (2 if tag and named("", tag) else 0) + (not tag)
            best, score, ties = (card_id, s, 1) if s > score else (best, score, ties + (s == score))
        if best:
            return best, ties == 1 and k == 0
    return None


def goldfish_history(card_id):
    """{day: cents} of a card id's paper prices, every day it has one."""
    q = urllib.parse.urlencode({"card_id": card_id, "selector": "#tab-paper", "type": "paper", "price_type": ""})
    js = goldfish_get(f"/price_history_component?{q}", **{"X-Requested-With": "XMLHttpRequest",
                                                          "Accept": "text/javascript, application/javascript, */*; q=0.01"})
    return {d: round(float(p) * 100) for d, p in re.findall(r"(\d{4}-\d\d-\d\d), ([\d.]+)", js or "")}


def goldfish_parts():
    """The files of crawls running side by side (goldfish --workers): goldfish.<n>.jsonl."""
    return sorted(f for f in os.listdir(".") if re.fullmatch(r"goldfish\.\d+\.jsonl", f))


def goldfish_rows(path=GOLDFISH_FILE):
    """goldfish_crawl's lines, one at a time (they're big), less a last one cut off by stopping it
    mid-write, with those of the workers' files not merged in yet. Read from the release's gzipped
    copy (path + ".gz") when there's no file of them here (the deploy)."""
    if not os.path.exists(path) and os.path.exists(path + ".gz"):
        with gzip.open(path + ".gz", "rt", encoding="utf-8") as f:
            yield from map(json.loads, f)
        return
    for file in [path] + (goldfish_parts() if path == GOLDFISH_FILE else []):
        if not os.path.exists(file):
            continue
        with open(file, encoding="utf-8") as f:
            line = None
            for after in f:
                if line is not None:
                    yield json.loads(line)  # a line before the last: whole, or the file's broken
                line = after
            try:
                if line is not None:
                    yield json.loads(line)
            except ValueError:
                pass


def cut_off(path):
    """Drop a last line cut off by stopping a crawl mid-write, so lines added after are whole."""
    if os.path.exists(path):
        with open(path, "rb+") as f:
            data = f.read()
            if data and not data.endswith(b"\n"):
                f.truncate(data.rfind(b"\n") + 1)


def merge_goldfish_parts(path=GOLDFISH_FILE):
    """Add the workers' files to the one file, and remove them."""
    for part in goldfish_parts():
        cut_off(part)
        cut_off(path)
        with open(part, encoding="utf-8") as f, open(path, "a", encoding="utf-8") as out:
            shutil.copyfileobj(f, out)
        os.remove(part)


def goldfish_workers(n, hours=None, least=MIN_MOVER):
    """Crawl with n workers side by side, each taking every n-th printing of the queue into its own
    file, merged into GOLDFISH_FILE when they're done (or stopped: goldfish --stop, or Ctrl+C)."""
    merge_goldfish_parts()
    goldfish_sets()  # once, before the workers read it
    args = [sys.executable, "-u", __file__, "goldfish", "--least", str(least)] + (["--hours", str(hours)] if hours else [])
    workers = [subprocess.Popen(args + ["--part", f"{k}/{n}"]) for k in range(n)]
    try:
        for w in workers:
            w.wait()
    except KeyboardInterrupt:
        open(GOLDFISH_STOP, "w").close()  # each stops after the printing it's on
        for w in workers:
            w.wait()
    if os.path.exists(GOLDFISH_STOP):
        os.remove(GOLDFISH_STOP)
    merge_goldfish_parts()
    print(f"Merged the workers' histories into {GOLDFISH_FILE}.", flush=True)


def goldfish_crawl(hours=None, least=MIN_MOVER, path=GOLDFISH_FILE, printings=PRINTINGS_FILE, part=None):
    """Fetch the daily history of every printing (and finish) at `least` cents or more on the last
    day of ours, and every reserve list printing: the reserve list first, then the priciest. Each
    is a line of `path` as it arrives ({"id", "finish", "card", "start", "cents": [a day each from
    start, null for none]}, or "miss" when it has none that matches ours), so it can stop and go on.
    part = (k, n): a worker of n, taking every n-th printing from the k-th, into its own file."""
    stop = time.time() + hours * 3600 if hours else None
    hist, codes = load(), goldfish_sets(printings)
    # Its card pages go by its sets' names (by_card)
    slugs = {fold(urllib.parse.unquote_plus(x)): x for x in set(re.findall(r'href="/sets/([^"#?]+)"', goldfish_get("/sets")))}
    last = max(hist["days"])
    # Done: found, or looked for on its card page; one not found by the set's page is looked for again
    done, again = set(), set()
    for r in goldfish_rows(path):
        (done if r.get("card") or r.get("by") == "card" else again).add((r["id"], r["finish"]))
    again -= done
    label = f"[{part[0] + 1}/{part[1]}] " if part else ""
    if part:
        path = f"goldfish.{part[0]}.jsonl"
    cut_off(path)
    cards, in_set, set_names, known = {}, defaultdict(int), {}, defaultdict(list)
    with gzip.open(printings, "rt", encoding="utf-8") as f:
        for c in map(json.loads, f):
            if c.get("digital"):
                continue
            # Double-faced cards go by their front's name there; split cards by both halves'
            name = c["name"] if c.get("layout") in ("split", "flip") else c["name"].split(" // ")[0]
            cards[c["id"]] = (name, c["set_name"], c["set"], c["collector_number"], c.get("reserved", False),
                              c.get("promo_types", []))
            in_set[c["set"], name] += 1
            set_names[c["set"]] = c["set_name"]
            if c["set"] in codes:
                known[name].append(c["set_name"])
    queue = []
    for i, (name, set_name, s, number, reserved, _) in cards.items():
        for finish in ("usd", "usd_foil"):
            series = hist["series"].get(i, {}).get(finish)
            now = at(series, last) if series else None
            if now and (reserved or now >= least) and (i, finish) not in done:
                queue.append((not reserved, -now, i, finish))
    queue.sort()
    if part:  # by card name, so each card's page is read by one of them
        queue = [q for q in queue if zlib.crc32(cards[q[2]][0].encode()) % part[1] == part[0]]
    pages = {}  # name -> goldfish_printings()

    def by_card(name, set_name):  # its printings, from its page: in a set of it there, or ours, or found by a search
        if name not in pages:
            plain = urllib.parse.quote_plus(re.sub(r"[^\w\s-]", "", name))
            tries = [f"/price/{slug}/{plain}" for slug in dict.fromkeys(
                [slugs[fold(n)] for n in known[name] if fold(n) in slugs][:1] + [urllib.parse.quote_plus(set_name)])]
            pages[name] = []
            for page_path in tries + [None]:
                if page_path is None:  # the search's link to the card's own page
                    found = re.findall(r'href="(/price/[^"#]*)"', goldfish_get(
                        "/q?" + urllib.parse.urlencode({"query_string": name})) or "")
                    kebab = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", name).lower()).strip("-")
                    page_path = next((h for h in found if h.rsplit("/", 1)[-1].startswith(kebab)), None)
                    if not page_path:
                        break
                    page_path = urllib.parse.quote(html.unescape(page_path))  # "-shattered glass"
                if found := goldfish_printings(goldfish_get(page_path)):
                    pages[name] = found
                    break
        return pages[name]
    print(f"{label}{len(queue):,} printings to fetch ({len(done):,} already), about "
          f"{len(queue) * GOLDFISH_DELAY / 3600:.0f} hours", flush=True)
    got = missed = 0
    with open(path, "a", encoding="utf-8") as out:
        for k, (_, minus_now, i, finish) in enumerate(queue):
            if stop and time.time() > stop:
                print("Out of time; run it again to go on.", flush=True)
                break
            if os.path.exists(GOLDFISH_STOP):  # left there for the other workers too
                print(f"{label}Stopped (goldfish --stop); run it again to go on.", flush=True)
                break
            name, set_name, s, number, _, promo_types = cards[i]
            foil = finish == "usd_foil"
            # The one printing of its name in a set it has a page of is "Name [SET]"; any other (one of
            # several in a set, a set it has no page of, or not found that way before) by the card's page
            if s in codes and in_set[s, name] == 1 and (i, finish) not in again:
                by, sure, card_id = "set", True, f"{name} [{codes[s]}]" + (" (F)" if foil else "")
            else:
                by = "card"
                p = s[1:] if s.startswith("p") and s[1:] in set_names else None  # a promo set's own
                card_id, sure = goldfish_match(
                    by_card(name, set_name), (set_name, set_names.get(p)),
                    ({s, codes.get(s, "").lower()}, {p, codes.get(p, "").lower()} if p else set()),
                    number, foil, promo_types) or (None, False)
            prices = goldfish_history(card_id) if card_id else {}
            row = {"id": i, "finish": finish, "card": card_id, **({"by": "card"} if by == "card" else {})}
            # Its latest price should be about ours: otherwise it's another printing. Within a factor
            # of 2 for one of a name's printings in a set; a sure one only within 5, as cards that
            # rarely sell (Alpha's) can be priced very differently. The estimates are scaled anyway
            latest = prices[max(prices)] if prices else None
            within = 5 if sure else 2
            if not latest or not 1 / within <= latest / -minus_now <= within:
                row["miss"] = "none" if not latest else f"{latest} against our {-minus_now}"
                missed += 1
            else:
                days = sorted(prices)
                d0 = date.fromisoformat(days[0])
                n = (date.fromisoformat(days[-1]) - d0).days + 1
                cents = [None] * n
                for d, c in prices.items():
                    cents[(date.fromisoformat(d) - d0).days] = c
                row.update(start=days[0], cents=cents)
                got += 1
            out.write(json.dumps(row, separators=(",", ":")) + "\n")
            out.flush()
            if k % 25 == 0:
                print(f"  {label}{k + 1:,}/{len(queue):,}: {got:,} histories, {missed:,} without one; "
                      f"{name} [{s}]{' foil' if foil else ''}: {row.get('miss') or row['start']}", flush=True)
    print(f"Fetched {got:,} histories ({missed:,} without one).", flush=True)



def goldfish_series(path=GOLDFISH_FILE):
    """((printing, finish), (first day, numpy array of cents a day from it, nan for none)) of each
    history goldfish_crawl fetched, one at a time (days are days since EPOCH)."""
    import numpy as np  # for the site's estimates only: pip install numpy
    for r in goldfish_rows(path):
        if r.get("cents"):
            yield (r["id"], r["finish"]), ((date.fromisoformat(r["start"]) - EPOCH).days, np.array(r["cents"], dtype=np.float32))


def estimator(real, gf):
    """A printing's estimated price on any day, from another guide's prices gf = (first day, [cents
    a day, None or nan for none]) scaled to meet ours, real = {day: cents} on the days we have. The
    scale (ln(ours / theirs)) on each of our days is the median of it and its neighbours' within 3
    days, and in between a straight line from one to the next. est(day) is None for a day it has no
    price on, or if it has no day in common; est.d0 and est.values (cents a day from d0, nan for
    none) are every day's at once."""
    import numpy as np
    d0, theirs = gf
    theirs = np.asarray(theirs, dtype=np.float64)
    n = len(theirs)
    # The median of the 5 days around (the upper one of an even few), so a day of a glitch (a price
    # doubled) is gone
    nan2 = np.full(2, np.nan)
    window = np.sort(np.lib.stride_tricks.sliding_window_view(np.concatenate([nan2, theirs, nan2]), 5), axis=1)
    med = window[np.arange(n), (~np.isnan(window)).sum(axis=1) // 2]
    med[np.isnan(theirs) | ~(med > 0)] = np.nan
    # And none for a longer glitch: 5 times (or a fifth of) the price both 30 days before and after
    before, after = np.full(n, np.nan), np.full(n, np.nan)
    before[30:], after[:-30] = med[:-30], med[30:]
    with np.errstate(invalid="ignore"):
        med[(before > 0) & (after > 0) & ((med > 5 * np.fmax(before, after)) | (5 * med < np.fmin(before, after)))] = np.nan
    both = sorted((d, math.log(c / med[d - d0])) for d, c in real.items() if 0 <= d - d0 < n and med[d - d0] > 0)
    values = np.full(n, np.nan, dtype=np.float32)
    if both:
        at_days = [d for d, _ in both]
        scale = []
        for d, _ in both:
            near = sorted(r for _, r in both[bisect.bisect_left(at_days, d - 3):bisect.bisect_right(at_days, d + 3)])
            scale.append(near[len(near) // 2])
        values[:] = np.round(med * np.exp(np.interp(np.arange(d0, d0 + n), at_days, scale)))

    def est(d):
        return int(values[d - d0]) if 0 <= d - d0 < n and not math.isnan(values[d - d0]) else None
    est.d0, est.values = d0, values
    return est


def daily(real, est):
    """A printing's estimated prices for the site: est (estimator()) on every day it has one, but
    within 3 days of one of ours (real = {day: cents}), as [days since the point before (day 0 for
    the first), change in cents (null: none from that day until the next point), ...]: a point
    where it moved ESTIMATE_MOVE or more (a cent at least) since the last, so flat in between."""
    import numpy as np
    values = est.values.copy()
    near = np.array(sorted(real), dtype=np.int64) - est.d0
    for k in range(-3, 4):
        at_k = near + k
        values[at_k[(at_k >= 0) & (at_k < len(values))]] = np.nan
    gone = np.isnan(values)
    changed = np.flatnonzero(np.concatenate([[True], (values[1:] != values[:-1]) & ~(gone[1:] & gone[:-1])]))
    out, prev, last, on = [], 0, 0, False
    for k in changed.tolist():  # where it changed: kept if it started, stopped or moved enough
        d = est.d0 + k
        if gone[k]:
            if on:
                out += [d - prev, None]
                prev, on = d, False
        elif not on or abs(values[k] - last) >= max(1, ESTIMATE_MOVE * last):
            c = int(values[k])
            out += [d - prev, c - last]
            prev, last, on = d, c, True
    if on:
        out += [est.d0 + len(values) - prev, None]
    return out


def alternatives(cards, tags, prices):
    """{card number: [cheaper cards that do the same thing]}, for cards at ALT_FROM cents or more:
    cards with the same main type, within its color identity, at ALT_SHARE of its price or less,
    that have most of its Scryfall Tagger tags, each weighted by how rare it is (ln(cards / cards
    with it)), the most first. prices: {card number: cheapest now, cents}."""
    number = {c["oracle_id"]: n for n, c in enumerate(cards)}
    of = defaultdict(set)  # card -> its tags
    have = {}  # tag -> its cards
    for slug, (ids, _) in tags.items():
        held = {number[i] for i in ids if i in number}
        if held:
            have[slug] = held
            for n in held:
                of[n].add(slug)
    weight = {t: math.log(len(cards) / len(held)) for t, held in have.items()}
    kind = [next((t for t in CARD_TYPES if t in c.get("type_line", "")), "") for c in cards]
    colors = [set(c.get("color_identity", [])) for c in cards]
    found = {}
    for n, price in prices.items():
        if price < ALT_FROM or not of[n]:
            continue
        mine = sum(weight[t] for t in of[n])
        score = Counter()
        for t in of[n]:
            if len(have[t]) <= ALT_TAG_MOST:
                for m in have[t]:
                    score[m] += weight[t]
        best = [m for m, w in score.most_common() if m != n and w >= ALT_LEAST * mine and kind[m] == kind[n]
                and colors[m] <= colors[n] and 0 <= prices.get(m, -1) <= ALT_SHARE * price][:ALT_SHOWN]
        if best:
            found[n] = best
    return found


def site_data(hist, cards, out_dir=SITE, printings=PRINTINGS_FILE, goldfish=GOLDFISH_FILE, tags=None):
    """Write site/prices/, what the Prices page and card details read (days are days since 1993-01-01,
    prices US cents, a printing's row is [card number, Scryfall id, set (in "sets"), finish (0 nonfoil,
    1 foil, 2 etched), price on the last day, then ...]):
      days.json        the days with prices of ours
      sets/set-<code>.json  {collector number: {"id": Scryfall id, "card": card number, finish: [cents now, then
                       WINDOWS days before (-1: none)]}}: each printing's price by set, for a decklist's
                       printings ("(CMM) 400 *F*"; the card number tells a mistyped one)
      cards.json       {"now", "7", "30", "90", "365": [cents by card number, -1: none]}: each card's
                       cheapest printing's price (any finish) now, and 7, 30, 90 and 365 days before
      alts/<n>.json    {card number - ALT_BLOCK * n: [cheaper cards that do the same thing]} for card
                       numbers from ALT_BLOCK * n, as alternatives()
      reprints.json    {"sets", "rows": [[card number, an older printing, its set, the new one's set,
                       the day it came out, the older one's price REPRINT_BEFORE days before, now, the
                       new one's (its cheapest finish, -1: none)]]}: cards reprinted lately
      movers-<w>.json  {"sets", "rows": [..., price w days before], "bands", "cutoffs"}: the printings
                       at MIN_MOVER or more on both days whose prices rose or fell the most in w
                       days, the top TOP of each finish (nonfoil, or foil and etched) and band of
                       price (BANDS, by the lower of the two) both ways. cutoffs[finish][band][rose]
                       is the size of the change (|ln(now / then)|) a band's list stops at (0: it
                       has them all), so the page can tell how far a list for any price is complete
      reserved.json    {"sets", "rows": [..., price 7, 30, 90 and 365 days before (-1: none), 1 if it's
                       to play with], "total" and "playable": [[day, cents, cards, estimated]]}: every
                       reserve list printing, and one of every reserve list card (its cheapest
                       nonfoil printing) over time, of all printings or just the ones to play with
                       (not Collectors' Edition's, 30th Anniversary's, gold-bordered or oversized)
      p/<first 3 characters of the Scryfall id>.json  each printing's prices: {finish: [[day,
                       cents or null]] where they changed on our days, finish + "_d": the estimated
                       prices between ours (estimator()), a day at a time, as daily()
    A price on the Prices page is the median of the printing's last 3 days within a week (estimated
    ones too), so one odd day doesn't make it rise or fall."""
    days = sorted(hist["days"])
    num = [(date.fromisoformat(d) - EPOCH).days for d in days]
    number = dict(zip(days, num))
    last = num[-1]
    order = {c["oracle_id"]: n for n, c in enumerate(cards)}  # card numbers, in build_index.py's order
    info, sets, reserved, unplayable, released, finishes, plain = {}, {}, defaultdict(list), set(), defaultdict(list), {}, {}
    where = {}  # printing -> (set code, collector number), for decklists' "(CMM) 400"
    with gzip.open(printings, "rt", encoding="utf-8") as f:
        for c in map(json.loads, f):
            oracle = c.get("oracle_id") or (c.get("card_faces") or [{}])[0].get("oracle_id")
            if oracle in order and c["id"] in hist["series"]:
                info[c["id"]] = (order[oracle], sets.setdefault(c["set_name"], len(sets)))
                where[c["id"]] = (c["set"], c["collector_number"])
                # Just the finishes it comes in: 7th to 9th Edition's foils are printings of their own
                # (325★), but MTGJSON gives the nonfoil one TCGplayer's foil price too (one product)
                finishes[c["id"]] = {US[k] for k, f in enumerate(("nonfoil", "foil", "etched")) if f in c.get("finishes", [])}
                plain[c["id"]] = c.get("collector_number", "").isdigit()
                if c.get("released_at") and c.get("set_type") != "memorabilia" and not c.get("digital"):
                    released[oracle].append(((date.fromisoformat(c["released_at"]) - EPOCH).days, c["id"]))
                if c.get("reserved"):
                    reserved[oracle].append(c["id"])
                    # Collectors' Edition, 30th Anniversary, gold borders, oversized: not to play with
                    if c.get("set_type") == "memorabilia" or c.get("border_color") == "gold":
                        unplayable.add(c["id"])

    def ours(series):  # {day: cents} on each of our days it has a price
        out, k, c = {}, 0, None
        for d, n in zip(days, num):
            while k < len(series[0]) and series[0][k] <= d:
                c = series[1][k]
                k += 1
            if c is not None:
                out[n] = c
        return out

    prices = {}  # (printing, finish) -> (ours, estimator or None)
    for i in info:
        for finish, series in hist["series"][i].items():
            if finish in finishes[i]:
                prices[i, finish] = (ours(series), None)
    for key, gf in goldfish_series(goldfish):
        if key in prices:
            prices[key] = (prices[key][0], estimator(prices[key][0], gf))

    def on(real, est, d):
        c = real.get(d)
        return c if c is not None or not est else est(d)

    def price(real, est, target, reach=7):
        """The median of a printing's last 3 prices within a week, from the last on or before
        `target` (at most `reach` days before it)."""
        first = next((d for d in range(target, target - reach - 1, -1) if on(real, est, d) is not None), None)
        if first is None:
            return None
        near = sorted([c for d in range(first, first - 7, -1) if (c := on(real, est, d)) is not None][:3])
        return near[len(near) // 2]

    on_list = {i for ids in reserved.values() for i in ids}
    rows = []  # every printing: [..., now, then 7, 30, 90 and 365 days before]
    for (i, finish), (real, est) in prices.items():
        if (now := price(real, est, last)) is not None:
            past = [price(real, est, last - w, max(7, w // 10)) for w in WINDOWS]
            card, s = info[i]
            rows.append([card, i, s, US.index(finish), now, *(-1 if c is None else c for c in past)])
    by_set = defaultdict(lambda: defaultdict(dict))  # set code -> collector number -> finish -> [now, then WINDOWS days before]
    for card, i, s, finish, *now_then in rows:
        by_set[where[i][0]][where[i][1]].update({"id": i, "card": card, finish: now_then})
    # Printings of a card in a set with the very same prices are one TCGplayer product (Odyssey's
    # Cephalid Looter #72 and #72†): one of them, the plain collector number's
    rows.sort(key=lambda r: not plain[r[1]])
    seen = set()
    rows = [r for r in rows if (key := (r[0], r[2], r[3], *r[4:])) not in seen and not seen.add(key)]
    shutil.rmtree(out_dir, ignore_errors=True)
    write_json(os.path.join(out_dir, "days.json"), num)
    for code, numbers in by_set.items():  # "set-": Conflux is "con", a name Windows keeps for itself
        write_json(os.path.join(out_dir, "sets", f"set-{code}.json"), numbers)
    # Reprints: cards with a printing out in the last REPRINT_DAYS and others REPRINT_OLDER days
    # older, and how the older printing that was cheapest REPRINT_BEFORE days before it moved since
    reprints = []
    for oracle, printed in released.items():
        new = [(d, i) for d, i in printed if last - REPRINT_DAYS <= d <= last]
        if not new:
            continue
        out, newest = min(new)
        before = out - REPRINT_BEFORE
        older = [(c, i) for d, i in printed if d <= out - REPRINT_OLDER and (i, "usd") in prices
                 and (c := price(*prices[i, "usd"], before, 14)) is not None]
        if not older:
            continue
        was, old = min(older)
        now = price(*prices[old, "usd"], last)
        fresh = min((c for f in US if (newest, f) in prices and (c := price(*prices[newest, f], last)) is not None), default=-1)
        if now is not None and min(was, now) >= MIN_MOVER:
            reprints.append([info[old][0], old, info[old][1], info[newest][1], out, was, now, fresh])
    write_json(os.path.join(out_dir, "reprints.json"), {"sets": list(sets), "rows": reprints})
    # Each card's cheapest printing (any finish) now, and WINDOWS days before, by card number
    cheapest = {}
    for r in rows:
        now, then = cheapest.get(r[0], (math.inf, [math.inf] * len(WINDOWS)))
        cheapest[r[0]] = (min(now, r[4]), [min(t, c) if c > 0 else t for t, c in zip(then, r[5:])])
    by_card = lambda pick: [(lambda c: -1 if c == math.inf else c)(pick(cheapest[n])) if n in cheapest else -1
                            for n in range(len(cards))]
    write_json(os.path.join(out_dir, "cards.json"), {"now": by_card(lambda x: x[0]),
                **{str(w): by_card(lambda x, k=k: x[1][k]) for k, w in enumerate(WINDOWS)}})
    if tags:
        alts = alternatives(cards, tags, {n: now for n, (now, _) in cheapest.items()})
        for k in range(0, len(cards), ALT_BLOCK):
            block = {n - k: alts[n] for n in range(k, min(k + ALT_BLOCK, len(cards))) if n in alts}
            if block:
                write_json(os.path.join(out_dir, "alts", f"{k // ALT_BLOCK}.json"), block)
    names = list(sets)

    def with_sets(chosen):  # just the sets they're from
        used = sorted({r[2] for r in chosen})
        new = {s: k for k, s in enumerate(used)}
        return {"sets": [names[s] for s in used], "rows": [[r[0], r[1], new[r[2]], *r[3:]] for r in chosen]}

    moved = 0
    for k, w in enumerate(WINDOWS):
        groups = defaultdict(list)
        for r in rows:
            now, was = r[4], r[5 + k]
            if was > 0 and min(now, was) >= MIN_MOVER and abs(now - was) >= 25:
                band = bisect.bisect_right(BANDS, min(now, was)) - 1
                groups[min(r[3], 1), band, now > was].append(r)
        size = lambda r: abs(math.log(r[4] / r[5 + k]))
        top, cutoffs = [], [[[0, 0] for _ in BANDS] for _ in range(2)]
        for (finish, band, rose), g in groups.items():
            g.sort(key=size, reverse=True)
            top += g[:TOP]
            if len(g) > TOP:
                cutoffs[finish][band][rose] = round(size(g[TOP - 1]), 5)
        moved += len(top)
        write_json(os.path.join(out_dir, f"movers-{w}.json"),
                   {**with_sets([[*r[:5], r[5 + k]] for r in top]), "bands": BANDS, "cutoffs": cutoffs})

    # One of every reserve list card, each its cheapest nonfoil printing: on each of our days, and
    # between them, weekly as far back as estimates go, the day-to-day changes of a set of printings
    # that all have estimates (each card's cheapest of those) scaled to meet ours (as estimator()).
    # The cheapest printing of some (Collectors' Edition's) has none, so they can't be summed as is.
    # Of every printing, or just the ones to play with (counts)
    observed = set(num)

    def reserve_total(counts):
        ours_total = {}
        for d in num:
            each = [c for ids in reserved.values()
                    if (c := min((p for i in ids if counts(i) and (i, "usd") in prices
                                  and (p := prices[i, "usd"][0].get(d)) is not None), default=None)) is not None]
            ours_total[d] = (sum(each), len(each))
        picked = [min(have, key=lambda i: price(*prices[i, "usd"], last) or math.inf) for ids in reserved.values()
                  if (have := [i for i in ids if counts(i) and (i, "usd") in prices and prices[i, "usd"][1]])]
        total = [[d, c, n, 0] for d, (c, n) in ours_total.items()]
        if picked:
            first = max(prices[i, "usd"][1].d0 for i in picked)
            # Each printing's last price (its estimates have holes), a week left out when more than 1 in 50
            # are over 60 days old; worked out weekly and on our days, the only days shown, and the
            # week's kept for the days between
            sums, seen = [], {}
            for d in range(first, last + 1):
                if (d - first) % 7 and d not in observed:
                    sums.append(sums[-1])
                    continue
                for i in picked:
                    if (c := on(*prices[i, "usd"], d)) is not None:
                        seen[i] = (d, c)
                stale = sum(d - e[0] > 60 for e in seen.values())
                sums.append(sum(c for _, c in seen.values())
                            if len(seen) == len(picked) and stale <= len(picked) // 50 else None)
            est = estimator({d: c for d, (c, _) in ours_total.items()}, (first, sums))
            cards = max((n for _, n in ours_total.values()), default=0)
            total += [[d, c, cards, 1] for d in range(last, first - 1, -7)
                      if not any(e in observed for e in range(d - 3, d + 4)) and (c := est(d)) is not None]
        total.sort()
        most = max((t[2] for t in total), default=0)
        return [t for t in total if t[2] >= 0.9 * most]  # days missing a tenth of the cards would look like a fall

    write_json(os.path.join(out_dir, "reserved.json"),
               {**with_sets([[*r, int(r[1] not in unplayable)] for r in rows if r[1] in on_list]),
                "total": reserve_total(lambda i: True), "playable": reserve_total(lambda i: i not in unplayable)})

    shards = defaultdict(dict)
    for i in info:
        entry = {f: [[number[d], c] for d, c in zip(*v)]
                 for f, v in hist["series"][i].items() if f in finishes[i]}
        for f in US:
            if (i, f) in prices and prices[i, f][1] and (r := daily(*prices[i, f])):
                entry[f + "_d"] = r
        shards[i[:3]][i] = entry
    for k, shard in shards.items():
        write_json(os.path.join(out_dir, "p", f"{k}.json"), shard)
    print(f"Wrote {out_dir}: {len(days)} days, {moved:,} rises and falls, {len(reserved)} reserve list cards, "
          f"{len(info):,} printings' prices ({sum(1 for _, e in prices.values() if e):,} with estimates between)", flush=True)


def share(path=HISTORY, goldfish=GOLDFISH_FILE):
    """Upload the history to the release, after merging in the days the release's copy has that this
    one doesn't (another run's), so nothing there is lost; and goldfish_crawl's histories, gzipped,
    with the printings the release's copy has that these don't. Returns whether it uploaded."""
    print(f"\nSharing with the {RELEASE} release...", flush=True)
    try:
        listed = subprocess.run(["gh", "release", "view", RELEASE, "--json", "assets", "-q", ".assets[].name"],
                                capture_output=True, text=True)
        if listed.returncode:  # uploading anyway could replace days we couldn't see
            raise RuntimeError(f"couldn't read the release: {listed.stderr.strip()}")
        hist = load(path)
        if path in listed.stdout.split():
            with tempfile.TemporaryDirectory() as tmp:
                if subprocess.run(["gh", "release", "download", RELEASE, "--dir", tmp, "--pattern", path]).returncode:
                    raise RuntimeError("couldn't download the release to merge with")
                print(f"Merged in {merge(hist, load(os.path.join(tmp, path)))} days from the release", flush=True)
            save(hist, path)
        files = [path]
        if os.path.exists(goldfish):
            if goldfish + ".gz" in listed.stdout.split():  # the release's rows we don't have, added here
                with tempfile.TemporaryDirectory() as tmp:
                    if subprocess.run(["gh", "release", "download", RELEASE, "--dir", tmp,
                                       "--pattern", goldfish + ".gz"]).returncode:
                        raise RuntimeError("couldn't download the release to merge with")
                    have = {(r["id"], r["finish"]) for r in goldfish_rows(goldfish)}
                    cut_off(goldfish)
                    with open(goldfish, "a", encoding="utf-8") as f:
                        f.writelines(json.dumps(r, separators=(",", ":")) + "\n" for r in goldfish_rows(os.path.join(tmp, goldfish))
                                     if (r["id"], r["finish"]) not in have)
            with gzip.open(goldfish + ".gz", "wt", encoding="utf-8") as f:
                f.writelines(json.dumps(r, separators=(",", ":")) + "\n" for r in goldfish_rows(goldfish))
            files.append(goldfish + ".gz")
        if subprocess.run(["gh", "release", "upload", RELEASE, *files, "--clobber"]).returncode:
            raise RuntimeError("the upload failed")
        print(f"Uploaded {len(hist['days'])} days" + (" and the other guide's histories" if len(files) > 1 else "") + ".",
              flush=True)
        return True
    except (OSError, RuntimeError) as e:  # OSError: gh isn't installed
        print(f"Couldn't share it ({e}). Everything is saved here; to try again:\n"
              "  python build_prices.py share", flush=True)
        return False


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # card names (꞉) in a log file Windows would write in cp1252
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd not in ("snapshot", "backfill", "share", "site", "goldfish"):
        sys.exit(__doc__)
    if cmd == "goldfish":
        arg = lambda name: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None
        if "--stop" in sys.argv:  # tells a crawl that's running to stop (every worker of one)
            open(GOLDFISH_STOP, "w").close()
            sys.exit("A running crawl stops after the printing it's on (within a few seconds).")
        hours = float(arg("--hours")) if arg("--hours") else None
        least = int(arg("--least") or MIN_MOVER)  # cents: --least 1 for every printing with a price
        if arg("--part"):  # one of goldfish_workers()'s
            k, n = map(int, arg("--part").split("/"))
            try:
                sys.exit(goldfish_crawl(hours, least, part=(k, n)))
            except KeyboardInterrupt:
                sys.exit()
        if os.path.exists(GOLDFISH_STOP):
            os.remove(GOLDFISH_STOP)  # left by a --stop with no crawl running
        if arg("--workers"):
            sys.exit(goldfish_workers(int(arg("--workers")), hours, least))
        merge_goldfish_parts()
        try:
            goldfish_crawl(hours, least)
        except KeyboardInterrupt:  # each printing is saved as it arrives: nothing's lost
            sys.exit("Stopped; run it again to go on.")
        finally:
            if os.path.exists(GOLDFISH_STOP):
                os.remove(GOLDFISH_STOP)
    if cmd == "site":
        sys.exit(site_data(load(), by_popularity(load_cards()), tags=load_oracle_tags()))
    if cmd == "snapshot":
        snapshot()
    elif cmd == "backfill":
        backfill()
    if "--no-upload" in sys.argv:
        print("Not uploaded (--no-upload). To upload: python build_prices.py share")
    else:
        sys.exit(0 if share() else 1)
