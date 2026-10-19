"""Keep prices.jsonl.gz, the price history of every paper printing (nonfoil, foil and etched, in US
dollars and euros), on the price-history release (too big for git). Additive: a day already in it
is never replaced.

    python build_prices.py snapshot    # add the day's prices from default_cards.jsonl.gz (the daily crawl does this)
    python build_prices.py backfill    # add every older day we can find: the Wayback Machine's copies of
                                       # Scryfall's bulk files and MTGJSON's price files, and MTGJSON's last 90 days
    python build_prices.py share       # merge with the release and upload (snapshot and backfill do this
                                       # unless given --no-upload)
    python build_prices.py site        # write site/prices/ (after build_index.py: it uses its card numbers)

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
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, timezone

from build_index import HEADERS, PRINTINGS_FILE, SCRYFALL_BULK_LIST_URL, by_popularity, fetch, load_cards, write_json

HISTORY = "prices.jsonl.gz"
RELEASE = "price-history"
FIELDS = ("usd", "usd_foil", "usd_etched", "eur", "eur_foil")
# MTGJSON's retail prices: TCGplayer's are what Scryfall shows in dollars, Cardmarket's in euros
MTGJSON_FIELDS = {"tcgplayer": {"normal": "usd", "foil": "usd_foil", "etched": "usd_etched"},
                  "cardmarket": {"normal": "eur", "foil": "eur_foil"}}
MTGJSON = "https://mtgjson.com/api/v5"
WAYBACK = "http://web.archive.org"
SITE = os.path.join("site", "prices")
EPOCH = date(1993, 1, 1)  # app.js counts days from it
WINDOWS = (7, 30, 90, 365)  # days back the Prices page compares with
US = ("usd", "usd_foil", "usd_etched")  # the site shows US prices, in the visitor's currency
MIN_MOVER = 100  # cents: cheaper printings move by cents, which make big percentages
BANDS = (500, 2000, 10000)  # cents: the Prices page's "and up" filters, $1, $5, $20 and $100
TOP = 250  # rises and falls kept per finish and band


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
        except OSError as e:
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
    files.sort(key=lambda f: (f[0][:8], "all-cards" in f[1], f[0]))
    for t, url, kind in files + [(today, f"{MTGJSON}/AllPrices.json.gz", "today")]:
        key = f"{t[:8]}/{url.split('.json')[0].split('.csv')[0]}"  # in another compression it's the same days
        if key in hist["sources"] or f"truncated: {t}/{url}" in hist["sources"]:
            continue
        made = re.search(r"-(\d{4})(\d\d)(\d\d)\d{6}\.json", url)  # default-cards-20240506090530.json
        day = "-".join(made.groups()) if kind == "scryfall" else None
        if day in hist["days"]:
            continue
        print(f"{t[:8]}: {url}", flush=True)
        try:
            text = unpack(get(url if kind == "today" else f"{WAYBACK}/web/{t}id_/{url}"), url)
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


def site_data(hist, cards, out_dir=SITE, printings=PRINTINGS_FILE):
    """Write site/prices/, what the Prices page and card details read (days are days since 1993-01-01,
    prices US cents, a printing's row is [card number, Scryfall id, set (in "sets"), finish (0 nonfoil,
    1 foil, 2 etched), price on the last day, then ...]):
      days.json        the days with prices
      movers-<w>.json  {"sets", "rows": [..., price w days before]}: the printings at MIN_MOVER or more
                       on both days whose prices rose or fell the most in w days, the top TOP of each finish (nonfoil, or foil and
                       etched) and band of price (BANDS, by the lower of the two) both ways, so the
                       top of "$5 and up", say, is the top of its bands put together
      reserved.json    {"sets", "rows": [..., price 7, 30, 90 and 365 days before (-1: none)],
                       "total": [[day, cents, cards]]}: every reserve list printing, and one of every
                       reserve list card (its cheapest nonfoil printing) each day
      p/<first 3 characters of the Scryfall id>.json  each printing's prices: {finish: [[day, cents]]}
    A price on the Prices page is the median of the printing's last 3 days within a week, so one odd
    day doesn't make it rise or fall."""
    days = sorted(hist["days"])
    num = [(date.fromisoformat(d) - EPOCH).days for d in days]
    order = {c["oracle_id"]: n for n, c in enumerate(cards)}  # card numbers, in build_index.py's order
    info, sets, reserved = {}, {}, defaultdict(list)
    with gzip.open(printings, "rt", encoding="utf-8") as f:
        for c in map(json.loads, f):
            oracle = c.get("oracle_id") or (c.get("card_faces") or [{}])[0].get("oracle_id")
            if oracle in order and c["id"] in hist["series"]:
                info[c["id"]] = (order[oracle], sets.setdefault(c["set_name"], len(sets)))
                if c.get("reserved"):
                    reserved[oracle].append(c["id"])

    def price(series, i):
        if at(series, days[i]) is None:
            return None
        near = sorted(c for k in range(max(0, i - 2), i + 1)
                      if num[i] - num[k] <= 7 and (c := at(series, days[k])) is not None)
        return near[len(near) // 2]

    def back(w):  # the last day on or before w days ago, if close enough to it
        k = bisect.bisect_right(num, num[-1] - w) - 1
        return k if k >= 0 and num[-1] - w - num[k] <= max(3, w // 10) else None

    last, then = len(days) - 1, [back(w) for w in WINDOWS]
    on_list = {i for ids in reserved.values() for i in ids}
    rows = []  # every printing: [..., now, then 7, 30, 90 and 365 days before]
    for i, (card, s) in info.items():
        for finish, series in hist["series"][i].items():
            if finish in US and (now := price(series, last)) is not None:
                past = [-1 if k is None or (c := price(series, k)) is None else c for k in then]
                rows.append([card, i, s, US.index(finish), now, *past])
    shutil.rmtree(out_dir, ignore_errors=True)
    write_json(os.path.join(out_dir, "days.json"), num)
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
                band = bisect.bisect_right(BANDS, min(now, was))
                groups[min(r[3], 1), band, now > was].append(r)
        top = [r for g in groups.values() for r in sorted(g, key=lambda r: -abs(math.log(r[4] / r[5 + k])))[:TOP]]
        moved += len(top)
        write_json(os.path.join(out_dir, f"movers-{w}.json"), with_sets([[*r[:5], r[5 + k]] for r in top]))
    total = []
    for k, d in enumerate(days):
        cheapest = [c for ids in reserved.values()
                    if (c := min((p for i in ids if (p := at(hist["series"][i].get("usd", ([], [])), d))), default=None))]
        if cheapest:
            total.append([num[k], sum(cheapest), len(cheapest)])
    write_json(os.path.join(out_dir, "reserved.json"),
               {**with_sets([r for r in rows if r[1] in on_list]), "total": total})
    shards = defaultdict(dict)
    for i in info:
        shards[i[:3]][i] = {f: [[num[bisect.bisect_left(days, d)], c] for d, c in zip(*v)]
                            for f, v in hist["series"][i].items() if f in US}
    for k, shard in shards.items():
        write_json(os.path.join(out_dir, "p", f"{k}.json"), shard)
    print(f"Wrote {out_dir}: {len(days)} days, {moved:,} rises and falls, "
          f"{len(reserved)} reserve list cards, {len(info):,} printings' prices", flush=True)


def share(path=HISTORY):
    """Upload the history to the release, after merging in the days the release's copy has that this
    one doesn't (another run's), so nothing there is lost. Returns whether it uploaded."""
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
        if subprocess.run(["gh", "release", "upload", RELEASE, path, "--clobber"]).returncode:
            raise RuntimeError("the upload failed")
        print(f"Uploaded {len(hist['days'])} days.", flush=True)
        return True
    except (OSError, RuntimeError) as e:  # OSError: gh isn't installed
        print(f"Couldn't share it ({e}). Everything is saved here; to try again:\n"
              "  python build_prices.py share", flush=True)
        return False


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd not in ("snapshot", "backfill", "share", "site"):
        sys.exit(__doc__)
    if cmd == "site":
        sys.exit(site_data(load(), by_popularity(load_cards())))
    if cmd == "snapshot":
        snapshot()
    elif cmd == "backfill":
        backfill()
    if "--no-upload" in sys.argv:
        print("Not uploaded (--no-upload). To upload: python build_prices.py share")
    else:
        sys.exit(0 if share() else 1)
