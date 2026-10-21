"""Self-check for the price history: python test_build_prices.py"""
import gzip
import json
import os
import random
import tempfile
from datetime import date

from build_prices import (add_day, estimator, load, merge, mtgjson4_days, mtgjson_csv, mtgjson_days, on, save,
                          scryfall_snapshot, site_data)

# Random days of random prices (some printings missing some days), added in a random order, read
# back exactly: every day's prices, after saving and loading, and merged into another copy
random.seed(1)
days = [f"2026-{m:02}-{d:02}" for m in (1, 2, 3) for d in range(1, 29, 3)]
truth = {day: {f"p{i}": {f: random.choice([100, 100, 150, 200]) for f in ("usd", "eur_foil") if random.random() < 0.8}
               for i in range(20) if random.random() < 0.9} for day in days}
truth = {day: {i: s for i, s in snap.items() if s} for day, snap in truth.items()}
hist = {"days": {}, "sources": [], "series": {}}
for day in random.sample(days, len(days)):
    assert add_day(hist, day, "test", truth[day])
assert not add_day(hist, days[0], "test", {}), "a day already in it is never replaced"
for day in days:
    assert on(hist, day) == truth[day], day
with tempfile.TemporaryDirectory() as tmp:
    save(hist, os.path.join(tmp, "h.jsonl.gz"))
    loaded = load(os.path.join(tmp, "h.jsonl.gz"))
assert all(on(loaded, day) == truth[day] for day in days)
half = {"days": {}, "sources": [], "series": {}}
for day in days[::2]:
    add_day(half, day, "test", truth[day])
assert merge(half, loaded) == len(days) - len(days[::2])
assert all(on(half, day) == truth[day] for day in days)
# A day without any euro prices (the source missed them) keeps the ones before; one printing's
# missing euro price is just gone
gap = {"days": {}, "sources": [], "series": {}}
for day, snap in [("2026-01-03", {"p": {"usd": 5, "eur": 4}, "q": {"usd": 1}}), ("2026-01-01", {"p": {"usd": 5, "eur": 3}}),
                  ("2026-01-02", {"p": {"usd": 6}}), ("2026-01-04", {"p": {"usd": 6}, "q": {"usd": 1, "eur": 2}})]:
    add_day(gap, day, "test", snap)
assert [on(gap, d)["p"] for d in sorted(gap["days"])] == [{"usd": 5, "eur": 3}, {"usd": 6, "eur": 3}, {"usd": 5, "eur": 4},
                                                         {"usd": 6}], gap
# Only changes are kept: a price the same every day is one point
flat = {"days": {}, "sources": [], "series": {}}
for day in days:
    add_day(flat, day, "test", {"p": {"usd": 5}})
assert flat["series"]["p"]["usd"] == ([days[0]], [5]), flat

assert scryfall_snapshot([{"id": "a", "prices": {"usd": "0.37", "usd_foil": None, "eur": "1.20", "tix": "0.03"}},
                          {"id": "b", "digital": True, "prices": {"usd": "1"}},
                          {"id": "c", "prices": {}}]) == {"a": {"usd": 37, "eur": 120}}
prices = {"u1": {"paper": {"tcgplayer": {"retail": {"normal": {"2026-01-01": 1.5}, "foil": {"2026-01-02": 3}}},
                           "cardmarket": {"retail": {"normal": {"2026-01-01": 1.25}}, "buylist": {}}}},
          "u2": {"paper": {"tcgplayer": {"retail": {"normal": {"2026-01-01": 9}}}}}}
assert mtgjson_days(prices, {"u1": "a"}) == {"2026-01-01": {"a": {"usd": 150, "eur": 125}},
                                             "2026-01-02": {"a": {"usd_foil": 300}}}
assert mtgjson_days(mtgjson_csv(
    "cardFinish,currency,date,gameAvailability,price,priceProvider,providerListing,uuid\n"
    "normal,USD,2026-01-01,paper,1.5,tcgplayer,retail,u1\nfoil,USD,2026-01-01,paper,9,tcgplayer,buylist,u1\n"
    "normal,USD,2026-01-01,mtgo,0.2,cardhoarder,retail,u1\n"), {"u1": "a"}) == {"2026-01-01": {"a": {"usd": 150}}}
v4 = {"LEA": {"cards": [{"scryfallId": "a", "prices": {"paper": {"2020-11-06": 78.0}, "paperFoil": {}}},
                        {"scryfallId": "b", "prices": {"paper": {"2020-11-06": 2.5, "2020-08-16": 3}}},
                        {"scryfallId": "c", "prices": {"paper": {"2020-08-16": 1}}}]}}
assert mtgjson4_days(v4) == {"2020-11-06": {"a": {"usd": 7800}, "b": {"usd": 250}}}

# site/prices/: a printing that rose from $2 to $4 over 30 days, a reserve list one from $100 to $90,
# and one at 50 cents (too cheap to rise or fall), with one odd day that the 3-day median ignores
site = {"days": {}, "sources": [], "series": {}}
for k in range(40):
    day = f"2026-{9 + k // 30:02}-{k % 30 + 1:02}"
    add_day(site, day, "test", {"up": {"usd": 200 if k < 10 else 400 if k != 38 else 9999, "usd_foil": 900},
                                "rl": {"usd": 10000 if k < 10 else 9000, "usd_foil": 500}, "cheap": {"usd": 50 if k < 10 else 25}})
with tempfile.TemporaryDirectory() as tmp:
    with gzip.open(os.path.join(tmp, "p.jsonl.gz"), "wt") as f:
        for i, oracle, rl in [("up", "o1", False), ("rl", "o2", True), ("cheap", "o1", False)]:
            # rl comes in nonfoil only, so its foil price (one TCGplayer product for both, as 7th Edition's) is left out
            f.write(json.dumps({"id": i, "oracle_id": oracle, "set_name": "Set " + i, "reserved": rl,
                                "finishes": ["nonfoil"] if rl else ["nonfoil", "foil"]}) + "\n")
    site_data(site, [{"oracle_id": "o2"}, {"oracle_id": "o1"}], tmp, os.path.join(tmp, "p.jsonl.gz"), os.path.join(tmp, "none"))
    read = lambda *path: json.load(open(os.path.join(tmp, *path)))
    moved = read("movers-30.json")
    assert sorted([moved["sets"][r[2]], *r[3:]] for r in moved["rows"]) == [["Set rl", 0, 9000, 10000], ["Set up", 0, 400, 200]], moved
    assert moved["cutoffs"][0][2] == [0, 0], "a band with fewer than TOP is complete"
    assert read("cards.json") == {"now": [9000, 25], "30": [10000, 50], "90": [-1, -1], "365": [-1, -1]}, read("cards.json")  # its cheapest
    reserved = read("reserved.json")
    assert [r[1] for r in reserved["rows"]] == ["rl"] and reserved["rows"][0][-1] == 1 and reserved["total"][-1][1:] == [9000, 1, 0], reserved
    assert reserved["playable"] == reserved["total"], "nothing in it is not to play with"
    assert read("p", "up.json")["up"]["usd_foil"] == [[(date(2026, 9, 1) - date(1993, 1, 1)).days, 900]]
    assert "usd_foil" not in read("p", "rl.json")["rl"], "a finish it doesn't come in"

# Estimates between our days: the other guide's prices, scaled to meet ours. Theirs are 10% over
# ours on day 0 and 20% over on day 10, so on day 5 they're scaled down by about 15%; before our
# first day by 10%, after our last by 20%
theirs = (-5, [110] * 5 + [110 + k for k in range(11)] + [None, 240])
est = estimator({0: 100, 10: 100}, theirs)
assert est(0) == 100 and est(10) == 100 and est(-5) == 100, [est(d) for d in (0, 10, -5)]
assert abs(est(5) - 115 / (1.1 ** 0.5 * 1.2 ** 0.5)) <= 1 and est(11) is None and est(12) == 200
assert estimator({0: 100}, (50, [1, 2]))(51) is None, "no day in common: no estimates"
glitch = estimator({0: 100}, (0, [100] * 40 + [6000] * 15 + [100] * 45 + [600] * 60))
assert glitch(45) is None and glitch(30) == 100 and glitch(130) == 600, \
    "two weeks at 60 times: left out; a rise that stays: kept"

# Cheaper alternatives: the same type, within its colors, half its price or less, most of its tags
from build_prices import alternatives
cards = [{"oracle_id": o, "type_line": t, "color_identity": c} for o, t, c in [
    ("a", "Artifact", []), ("b", "Artifact", []), ("c", "Creature", []), ("d", "Artifact", ["G"]),
    ("e", "Artifact", []), ("f", "Artifact", [])] + [(f"x{k}", "Land", []) for k in range(20)]]
tags = {"ramp": ({"a", "b", "c", "d", "e"}, []), "rock": ({"a", "b", "c", "d"}, []),
        "odd": ({"a", "f", *(f"x{k}" for k in range(10))}, [])}  # a common tag: f is little like a
assert alternatives(cards, tags, {0: 1000, 1: 300, 2: 100, 3: 100, 4: 900, 5: 100}) == {0: [1], 4: [1]}, \
    "for a: b, not c (a creature), d (green), e (too pricey) or f (too little alike); for e too: b"
print("ok")
