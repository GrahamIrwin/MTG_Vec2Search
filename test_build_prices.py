"""Self-check for the price history: python test_build_prices.py"""
import os
import random
import tempfile

from build_prices import add_day, load, merge, mtgjson4_days, mtgjson_csv, mtgjson_days, on, save, scryfall_snapshot

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
print("ok")
