"""Self-check for the deck corpus and site/decks/: python test_build_decks.py"""
import gzip
import io
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date

import build_decks
from build_decks import build, load_corpus, save_corpus, slim_deck, slim_moxfield


def entry(uid, categories, quantity=1):
    return {"categories": categories, "quantity": quantity, "card": {"oracleCard": {"uid": uid}}}


# An Archidekt deck: the commander, 98 cards in the deck, 2 basics, and a maybeboard card
archidekt = {
    "id": 7, "name": "Test", "updatedAt": "2026-09-30T12:00:00Z", "edhBracket": 3, "viewCount": 5,
    "categories": [{"name": "Commander", "includedInDeck": True}, {"name": "Ramp", "includedInDeck": True},
                   {"name": "Maybeboard", "includedInDeck": False}],
    "cards": [entry("cmdr", ["Commander"]), entry("island", ["Land"], 2), entry("maybe", ["Maybeboard"])]
             + [entry(f"c{i}", ["Ramp"]) for i in range(97)],
}
deck = slim_deck(archidekt)
assert deck["commanders"] == ["cmdr"] and "maybe" not in deck["cards"], deck
assert sum(deck["cards"].values()) == 100 and deck["cards"]["island"] == 2 and deck["updated"] == "2026-09-30"
assert slim_deck({**archidekt, "cards": archidekt["cards"][:50]}) is None  # incomplete
assert slim_deck({**archidekt, "cards": archidekt["cards"][1:]}) is None  # no commander


# The same deck on Moxfield, whose cards are printings ("p-<oracle id>" here)
def mox_deck(public_id, lead="cmdr"):
    card = lambda oracle, quantity=1: {"quantity": quantity, "card": {"scryfall_id": f"p-{oracle}"}}
    return {"publicId": public_id, "name": "Mox", "lastUpdatedAtUtc": "2026-09-30T12:00:00Z",
            "createdAtUtc": "2026-09-29T08:00:00Z", "bracket": 2, "viewCount": 3,
            "boards": {"commanders": {"cards": {"x": card(lead)}},
                       "mainboard": {"cards": {"isl": card("island", 2), **{f"k{i}": card(f"c{i}") for i in range(97)}}},
                       "maybeboard": {"cards": {"m": card("maybe")}}, "sideboard": {"cards": {"s": card("side")}}}}


printings = {f"p-{o}": o for o in ["cmdr", "island", "maybe", "side", "A", "B", "D"] + [f"c{i}" for i in range(97)]}
mox = slim_moxfield(mox_deck("Q-mgAa"), printings)
assert mox == {**deck, "id": "Q-mgAa", "name": "Mox", "created": "2026-09-29", "bracket": 2, "views": 3}, mox
unknown = lambda n: {p: o for p, o in printings.items() if o not in {f"c{i}" for i in range(n)}}
assert sum(slim_moxfield(mox_deck("x"), unknown(5))["cards"].values()) == 95  # printings Scryfall lacks are left out,
assert slim_moxfield(mox_deck("x"), unknown(6)) is None  # which can leave too few cards
assert slim_moxfield(mox_deck("x", lead="nope"), printings) is None  # no commander we know
assert slim_moxfield({}, printings) is None  # a deck that's gone (404)

with tempfile.TemporaryDirectory() as tmp:
    # One gzip member per deck; a newer copy of a deck replaces the older, and a crawl cut off
    # mid-write loses only its last deck
    path = os.path.join(tmp, "decks.jsonl.gz")
    with open(path, "wb") as f:
        for d in (deck, {**deck, "id": 8}, {**deck, "name": "Newer"}):
            f.write(gzip.compress((json.dumps(d) + "\n").encode()))
        cut = gzip.compress(b'{"id": 9, "name": "cut off mid-write"}\n')
        f.write(cut[:len(cut) // 2])
    corpus = load_corpus(path)
    assert sorted(corpus) == [7, 8] and corpus[7]["name"] == "Newer", corpus.keys()
    # A crawl rewrites the corpus before appending, or decks after the cut-off one would be lost
    save_corpus(corpus, path)
    with open(path, "ab") as f:
        f.write(gzip.compress((json.dumps({**deck, "id": 10}) + "\n").encode()))
    assert sorted(load_corpus(path)) == [7, 8, 10]

    # Cards in index order: 0 = the commander, 1 = a basic land, then c0..c96
    cards = [{"oracle_id": "cmdr", "type_line": "Legendary Creature"}, {"oracle_id": "island", "type_line": "Basic Land — Island"}]
    cards += [{"oracle_id": f"c{i}", "type_line": "Creature"} for i in range(97)]
    corpus = {i: {**deck, "id": i, "updated": f"2026-09-0{i}"} for i in range(1, 6)}
    build_decks.BUILD_DECKS = 5  # so these few decks get tags
    corpus[5]["cards"] = {"cmdr": 1, "c96": 1, "c0": 1}
    out = os.path.join(tmp, "decks")
    # c0 and c96 are in every deck, c1-c95 in 4 of 5: a tag needs 2 cards decks play, and none
    # about wording ("cycle-")
    tags = {"pump": ({"c0", "c96", "island"}, []), "cycle-test": ({"c0", "c96"}, []), "lone": ({"c0"}, [])}
    # Trends: deck 1 was made long ago, 4 three weeks ago and 5 three days ago; 2 and 3 have no date,
    # but Archidekt numbers decks as they're made, so 2 and 3 are older than 4
    corpus[1]["created"], corpus[4]["created"], corpus[5]["created"] = "2025-01-01", "2026-09-13", "2026-10-01"
    build(corpus, cards, tags, out, prices={"cmdr": 2.0, "c0": 1.0, "island": 0.5}, today=date(2026, 10, 4))
    with open(os.path.join(out, "0.json"), encoding="utf-8") as f:
        shard = json.load(f)
    assert shard["cards"][:2] == [2, 98] and len(shard["cards"]) == 97  # c0 and c96 are in every deck
    assert shard["tags"] == [["pump", [0, 1]]] and len(shard["signature"]) == 60, shard["tags"]
    first = shard["decks"][0]
    assert first[0] == 5 and first[2] == "2026-09-05" and first[4] == "2026-10-01"  # newest first; when it was made
    assert [d[4] for d in shard["decks"]] == ["2026-10-01", "2026-09-13", "2025-01-01", "2025-01-01", "2025-01-01"]
    positions = [sum(first[3][:i + 1]) for i in range(len(first[3]))]
    assert [shard["cards"][p] for p in positions] == [2, 98]  # no commander, no basic land
    with open(os.path.join(out, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    assert index["decks"] == 5 and index["commanders"][0][:2] == ["0", 5]
    assert index["since"] == ["2026-07-06", "2026-09-04", "2026-09-27"], index["since"]  # the 90, 30 and 7 day windows
    assert shard["price"] == 300 and shard["bracket"] == 3  # basic lands are left out of the price
    with open(os.path.join(out, "trends.json"), encoding="utf-8") as f:
        trends = json.load(f)
    key, made, price, bracket, _ = trends["commanders"][0]
    assert key == "0" and made == [5, 2, 2, 1] and trends["everything"][0] == made, made
    with open(os.path.join(out, "trend-cards.json"), encoding="utf-8") as f:
        kept, plays = json.load(f)[0]
    assert kept[0] == 2 and [counts[0] for counts in plays] == [5, 2, 2, 1]  # c0, in every deck

    # An undated Archidekt deck was made when the last dated one before it was (or who knows: "")
    assert build_decks.made_dates({d["id"]: d for d in [{"id": 1, "created": "2026-01-01"}, {"id": 2}, {"id": 0},
                                                        {"id": 3, "created": "2026-02-01"}, {"id": "m", "created": "2026-03-01"},
                                                        {"id": "n"}]}) == \
        {1: "2026-01-01", 2: "2026-01-01", 0: "", 3: "2026-02-01", "m": "2026-03-01", "n": ""}
    # Archidekt and Moxfield decks together, updated the same day (so sorted by id too)
    mixed = {i: {**deck, "id": i, "updated": "2026-09-30", "created": "2026-01-01"} for i in range(1, 4)}
    mixed.update({m: {**deck, "id": m, "updated": "2026-09-30", "created": "2026-10-02"} for m in ("m1", "m2")})
    build(mixed, cards, tags, out, today=date(2026, 10, 4))
    with open(os.path.join(out, "0.json"), encoding="utf-8") as f:
        assert [(d[0], d[4]) for d in json.load(f)["decks"]] == [
            ("m2", "2026-10-02"), ("m1", "2026-10-02"), (3, "2026-01-01"), (2, "2026-01-01"), (1, "2026-01-01")]
    with open(os.path.join(out, "trends.json"), encoding="utf-8") as f:
        assert json.load(f)["commanders"][0][1] == [5, 2, 2, 2]  # the Moxfield decks are this week's

    # Themes: what these decks play far more of than decks in general; "b" is mostly "a"'s cards
    usual = Counter({"a": 0.2, "b": 0.1})
    card_tags = defaultdict(list, {1: ["a", "b"], 2: ["a"], 3: ["c"]})
    assert build_decks.themes(Counter({1: 10, 2: 10, 3: 1}), 10, usual, card_tags) == ["a"]

    # --top: the most played cards that can lead a deck, each topped up to per_commander decks,
    # from a fake Archidekt where every commander has 5 decks
    os.chdir(tmp)
    oracle = [{"oracle_id": "A", "name": "A", "edhrec_rank": 1, "type_line": "Legendary Creature — Elf"},
              {"oracle_id": "B", "name": "B // B2", "edhrec_rank": 2, "type_line": "Legendary Creature // Land"},
              {"oracle_id": "C", "name": "C", "edhrec_rank": 3, "type_line": "Creature — Elf"},
              {"oracle_id": "D", "name": "D", "edhrec_rank": 4, "type_line": "Legendary Planeswalker",
               "oracle_text": "D can be your commander."},
              {"oracle_id": "E", "name": "E", "type_line": "Legendary Creature"}]  # no rank: unplayed
    for c in oracle:
        c["legalities"] = {"commander": "legal"}
    with gzip.open("oracle_cards.jsonl.gz", "wt", encoding="utf-8") as f:
        f.writelines(json.dumps(c) + "\n" for c in oracle)
    assert build_decks.top_commanders(10) == [("A", "A"), ("B", "B // B2"), ("D", "D")]
    # --only: any case, and a double-faced card by its front face
    assert build_decks.full_names(["a", "B"], {c["oracle_id"]: c["name"] for c in oracle}) == ["A", "B // B2"]
    assert build_decks.full_names(["r"], {"x": "R // R", "y": "R // R2"}) == ["R // R2"]  # not the reversible printing
    try:
        build_decks.full_names(["Nope"], {"A": "A"})
        raise AssertionError("an unknown name should stop the crawl")
    except SystemExit as e:
        assert "Nope" in str(e)

    # A 429 waits as long as its Retry-After says (6s, then a second to spare), else backs off (1m on a second try)
    answers, slept = [6, None, {}], []
    def fake_urlopen(request, timeout):
        a = answers.pop(0)
        if not isinstance(a, dict):
            raise urllib.error.HTTPError(request.full_url, 429, "", {"Retry-After": str(a)} if a else {}, None)
        response = io.BytesIO(json.dumps(a).encode())
        response.headers = {}
        return response
    real = urllib.request.urlopen, build_decks.time.sleep
    urllib.request.urlopen, build_decks.time.sleep = fake_urlopen, slept.append
    try:
        assert build_decks.get_json("/x", base="https://test") == {}
    finally:
        urllib.request.urlopen, build_decks.time.sleep = real
    assert [round(s) for s in slept] == [0, 1 + 7, 1 + 60], slept  # plus a second between requests

    lead = {}
    def fake_get_json(path, base=build_decks.ARCHIDEKT):
        if base == build_decks.MOXFIELD:
            return fake_moxfield(path)
        if path.startswith("/decks/v3/"):
            name = urllib.parse.parse_qs(path.split("?")[1])["commanderName"][0]
            uid = next(c["oracle_id"] for c in oracle if c["name"] == name)
            ids = [100 * ord(uid) + i for i in range(5)]
            lead.update({i: uid for i in ids})
            return {"results": [{"id": i, "size": 100, "updatedAt": "2026-09-30"} for i in ids]}
        deck_id = int(path.split("/")[2])
        return {**archidekt, "id": deck_id, "cards": [entry(lead[deck_id], ["Commander"])] + archidekt["cards"][1:]}

    # A fake Moxfield: 2 pages of 2 complete decks (and one incomplete and one unlisted deck) per search
    def fake_moxfield(path):
        query = urllib.parse.parse_qs(path.partition("?")[2])
        if path.startswith("/v2/cards/search?"):
            name = query["q"][0]
            return {"data": [{"name": f"{name}'s Fall", "id": "wrong"}, {"name": name, "id": f"mx:{name}"}]}
        if path.startswith("/v2/decks/search?"):
            assert query["fmt"] == ["commander"] and query["sortType"] == ["updated"]
            name = query["commanderCardId"][0][3:] if "commanderCardId" in query else None
            uid = next(c["oracle_id"] for c in oracle if c["name"] == name) if name else "A"
            page, order = query["pageNumber"][0], query["sortDirection"][0]
            ids = [f"{uid if name else 'new'}-{order}{page}-{i}" for i in range(2)]
            lead.update({i: uid for i in ids})
            rows = [{"publicId": i, "mainboardCount": 100, "visibility": "public", "lastUpdatedAtUtc": "2026-09-30T12:00:00Z",
                     "createdAtUtc": "2026-09-29T08:00:00Z"} for i in ids]
            rows += [{"publicId": "incomplete", "mainboardCount": 60, "visibility": "public"},
                     {"publicId": "unlisted", "mainboardCount": 100, "visibility": "unlisted"}]
            return {"data": rows, "totalPages": 2}
        assert path.startswith("/v3/decks/all/"), path
        public_id = path.rsplit("/", 1)[1]
        return mox_deck(public_id, lead[public_id])  # never "incomplete" or "unlisted": KeyError
    build_decks.get_json, build_decks.DELAY = fake_get_json, 0
    save_corpus({i: {**deck, "id": i, "commanders": ["A"]} for i in range(3)}, "decks.jsonl.gz")
    build_decks.crawl(3, top=10)
    count = Counter(o for d in load_corpus("decks.jsonl.gz").values() for o in d["commanders"])
    assert count == {"A": 3, "B": 3, "D": 3}, count  # A already had 3
    with open("crawl_state.json", encoding="utf-8") as f:
        assert sorted(json.load(f)) == ["B // B2", "D"]

    # Moxfield: --top counts only Moxfield's decks (A's 3 are Archidekt's), and takes its own turns
    with gzip.open("default_cards.jsonl.gz", "wt", encoding="utf-8") as f:
        f.writelines(json.dumps({"id": p, "oracle_id": o}) + "\n" for p, o in printings.items())
        f.write(json.dumps({"id": "p-reversible", "card_faces": [{"oracle_id": "c0"}, {"oracle_id": "c0"}]}) + "\n")
    assert build_decks.printing_oracles() == {**printings, "p-reversible": "c0"}
    build_decks.crawl(3, top=10, site="moxfield")
    corpus = load_corpus("decks.jsonl.gz")
    count = Counter(o for d in corpus.values() if isinstance(d["id"], str) for o in d["commanders"])
    assert count == {"A": 3, "B": 3, "D": 3}, count
    assert corpus["A-Descending1-0"]["created"] == "2026-09-29"
    with open("crawl_state.json", encoding="utf-8") as f:
        assert sorted(json.load(f)) == ["B // B2", "D", "moxfield:A", "moxfield:B // B2", "moxfield:D"]
    # Recently updated decks, then each commander, newest decks and then oldest
    build_decks.crawl(0, site="moxfield")
    assert sorted(i for i in load_corpus("decks.jsonl.gz") if str(i).startswith("new")) == \
        ["new-Descending1-0", "new-Descending1-1", "new-Descending2-0", "new-Descending2-1"]
    build_decks.crawl(10, only=["d"], site="moxfield")
    assert sum(isinstance(d["id"], str) and d["commanders"] == ["D"] for d in load_corpus("decks.jsonl.gz").values()) == 8

    # Before uploading, the release's copy is merged in: decks only it has, and newer versions
    os.makedirs("release")
    save_corpus({1: {**deck, "id": 1, "updated": "2026-01-01", "created": "2025-12-01"}, 2: {**deck, "id": 2, "updated": "2026-12-01"},
                 99: {**deck, "id": 99}}, os.path.join("release", "decks.jsonl.gz"))
    with open(os.path.join("release", "crawl_state.json"), "w", encoding="utf-8") as f:
        json.dump({"A": "2027-01-01", "Z": "2026-01-01"}, f)
    mine = {1: {**deck, "id": 1, "updated": "2026-06-01"}, 2: {**deck, "id": 2, "updated": "2026-06-01"}}
    state = {"A": "2026-10-01", "B // B2": "2026-10-01"}
    assert build_decks.merge(mine, state, "release") == 2
    assert {i: d["updated"] for i, d in mine.items()} == {1: "2026-06-01", 2: "2026-12-01", 99: "2026-09-30"}
    assert state == {"A": "2027-01-01", "B // B2": "2026-10-01", "Z": "2026-01-01"}
    assert mine[1]["created"] == "2025-12-01"  # an older copy can still tell when the deck was made
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
print("ok")
