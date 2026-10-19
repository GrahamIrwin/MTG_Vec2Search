"""Self-check for the price history: python test_build_prices.py"""
import os
import random
import tempfile

from build_prices import add_day, load, merge, mtgjson_days, on, save, scryfall_snapshot

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
print("ok")
