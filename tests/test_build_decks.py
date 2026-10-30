"""Self-check for the deck corpus and site/decks/: python tests/test_build_decks.py"""
import gzip
import io
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))  # the scripts tested
import build_decks
from build_decks import all_decks, compact, corpus_files, load_corpus, precon_sets, save_corpus, slim_deck, slim_moxfield


def build(corpus, *args, **kwargs):
    """build_decks.build, from {id: deck}: all in one list, as if in one partition"""
    build_decks.build(lambda: [list(corpus.values())], *args, **kwargs)


def corpus_now():
    """Every deck in this directory's corpus, after folding in what's new"""
    compact(corpus_files())
    return all_decks()


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
assert "zero" not in slim_deck({**archidekt, "cards": archidekt["cards"] + [entry("zero", ["Ramp"], 0)]})["cards"]


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
    def append(path, *records):  # as a crawl does: one gzip member each
        with open(path, "ab") as f:
            for r in records:
                f.write(gzip.compress((json.dumps(r) + "\n").encode()))
    here = os.path.join(tmp, "corpus")  # the crawl below starts from its own
    os.makedirs(here)
    # A crawl appends to decks-new.jsonl.gz, one gzip member per deck; a stopped one loses only its last deck
    new = os.path.join(here, "decks-new.jsonl.gz")
    append(new, deck, {**deck, "id": 8}, {**deck, "name": "Newer"})
    with open(new, "ab") as f:
        cut = gzip.compress(b'{"id": 9, "name": "cut off mid-write"}\n')
        f.write(cut[:len(cut) // 2])
    best = compact(corpus_files(here), here)
    corpus = all_decks(here)
    assert sorted(corpus) == [7, 8] and corpus[7]["name"] == "Newer" and corpus[7] == {**deck, "name": "Newer"}, corpus
    assert not os.path.exists(new) and best[7].source == len(corpus_files(here)) - 1  # folded in, from decks-new
    # Every deck of a commander is in the same partition, its cards by number in decks-cards.json, a
    # card's number once a copy (the island's twice); the most played cards get the smallest numbers
    lines = {p: list(build_decks.read_lines(os.path.join(here, build_decks.PART.format(p)))) for p in range(build_decks.PARTS)}
    assert [len(ls) for ls in lines.values() if ls] == [2] and build_decks.part(["cmdr"]) in [p for p, ls in lines.items() if ls]
    with open(os.path.join(here, "decks-cards.json"), encoding="utf-8") as f:
        table = json.load(f)
    stored = json.loads(lines[build_decks.part(["cmdr"])][0])
    assert table[0] == "island" and stored["cards"][:3] == [0, 0, 1] and len(stored["cards"]) == 100, stored["cards"][:5]
    # The corpus from before it was split is folded in, then kept as decks-backup.jsonl.gz; a deck's
    # newer copy wins, and an older one can still tell when it was made
    save_corpus({8: {**deck, "id": 8, "updated": "2026-01-01", "created": "2025-12-01"},
                 11: {**deck, "id": 11, "commanders": ["c0"]}}, os.path.join(here, "decks.jsonl.gz"))
    compact(corpus_files(here), here)
    corpus = all_decks(here)
    assert sorted(corpus) == [7, 8, 11] and corpus[8]["updated"] == "2026-09-30" and corpus[8]["created"] == "2025-12-01"
    assert os.path.exists(os.path.join(here, "decks-backup.jsonl.gz")) and not os.path.exists(os.path.join(here, "decks.jsonl.gz"))
    assert table == json.load(open(os.path.join(here, "decks-cards.json"), encoding="utf-8"))[:len(table)]  # numbers stay put
    # A deck found gone keeps its record, marked removed; a newer version brings it back. A note
    # older than the deck's version is about an earlier one, so it's left alone.
    append(new, {"id": 7, "removed": "2026-10-01"}, {"id": 8, "removed": "2026-09-01"}, {"id": 404, "removed": "2026-10-01"})
    compact(corpus_files(here), here)
    corpus = all_decks(here)
    assert corpus[7]["removed"] == "2026-10-01" and "removed" not in corpus[8] and 404 not in corpus
    append(new, {**deck, "updated": "2026-10-02"})
    best = compact(corpus_files(here), here)
    assert "removed" not in all_decks(here)[7] and not best[7].removed
    # Another copy of the corpus that numbered new cards differently: its decks are renumbered to this one's
    other = os.path.join(here, "other")
    os.makedirs(other)
    append(os.path.join(other, "decks-new.jsonl.gz"), {**deck, "id": 12, "cards": {"brand new": 1, **deck["cards"]}})
    compact(corpus_files(other), other)
    append(new, {**deck, "id": 13, "cards": {"newer still": 1, **deck["cards"]}})
    compact(corpus_files(here) + corpus_files(other), here)
    corpus = all_decks(here)
    assert corpus[12]["cards"]["brand new"] == 1 and corpus[13]["cards"]["newer still"] == 1 and len(corpus[12]["cards"]) == 100
    assert sorted(corpus) == [7, 8, 11, 12, 13]
    # A deck whose commander changed moves partitions, and isn't left behind
    append(os.path.join(here, "decks-new.jsonl.gz"), {**deck, "id": 11, "updated": "2026-10-03"})
    compact(corpus_files(here), here)
    assert [d["commanders"] for d in all_decks(here).values() if d["id"] == 11] == [["cmdr"]]
    assert sum(len(list(build_decks.read_lines(os.path.join(here, build_decks.PART.format(p))))) for p in range(64)) == 5

    # Cards in index order: 0 = the commander, 1 = a basic land, then c0..c96
    cards = [{"oracle_id": "cmdr", "name": "Cmdr", "type_line": "Legendary Creature"},
             {"oracle_id": "island", "type_line": "Basic Land — Island"}]
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
    corpus[5]["bracket"], corpus[4]["bracket"] = 4, None
    event = {"id": "e", "name": "Event", "date": "2026-09-30", "size": 40, "top_cut": 4,
             "entries": [["Cmdr", 3, 2, 2, 1, "deck link", []], ["Nobody", 1, 5, 0, 0, "", []]]}
    # The commander's precon is its oldest Commander set (c13): c0 and c5 are in it, c6 only in blc
    sets = {"c13": ("C13", "2013-11-01", "commander"), "blc": ("BLC", "2024-08-02", "commander"), "m14": ("M14", "2013-07-19", "core")}
    precons = precon_sets({"cmdr": {"blc", "c13", "m14"}, "c0": {"c13"}, "c5": {"blc", "c13"}, "c6": {"blc"}}, sets)
    assert precons["cmdr"] == ["c13", "blc"], precons
    build(corpus, cards, tags, out, prices={"cmdr": 2.0, "c0": 1.0, "island": 0.5}, today=date(2026, 10, 4),
          results={"e": event}, precons=precons, combos=[
              ("1-2", ["cmdr", "c0"], ["cmdr"], [[], ["Win the game"], ["", "", "", "Cast it.\nWin."]]),  # the commander counts as played
              ("w", ["c96", "c0"], [], [["Mana Dork"], ["Infinite mana"], ["", "", "", "Cast it.\nWin."]]),
              ("x", ["c0", "c1"], [], [[], [], ["", "", "", "Cast it.\nWin."]]),  # c1: in 4 of the 5 decks, under MIN_COMBO_DECKS
              ("y", ["c0", "c96"], ["c0"], [[], [], ["", "", "", "Cast it.\nWin."]]),  # c0 isn't the commander
              ("z", ["c0", "not a card"], [], [[], [], ["", "", "", "Cast it.\nWin."]])])
    with open(os.path.join(out, "0.json"), encoding="utf-8") as f:
        shard = json.load(f)
    assert shard["cards"][:2] == [2, 98] and len(shard["cards"]) == 97  # c0 and c96 are in every deck
    # A card banned in Commander (Jeweled Lotus) is left out of what the decks play: nothing suggests it
    banned = [dict(c) for c in cards]
    banned[3]["legalities"] = {"commander": "banned"}  # c1, in 4 of the 5 decks
    build(corpus, banned, tags, os.path.join(tmp, "banned"), today=date(2026, 10, 4))
    with open(os.path.join(tmp, "banned", "0.json"), encoding="utf-8") as f:
        assert 3 in shard["cards"] and 3 not in json.load(f)["cards"]
    assert shard["tags"] == [["pump", [0, 1]]] and len(shard["signature"]) == 60, shard["tags"]
    precon = [sum(shard["precon"][:i + 1]) for i in range(len(shard["precon"]))]
    assert sorted(shard["cards"][p] for p in precon) == [2, 7], shard["precon"]
    assert shard["combos"] == [["1-2", [0, 2], [], ["Win the game"], ["", "", "", "Cast it.\nWin."]],
                               ["w", [98, 2], ["Mana Dork"], ["Infinite mana"], ["", "", "", "Cast it.\nWin."]]], shard["combos"]
    first = shard["decks"][0]
    assert first[0] == 5 and first[2] == "2026-09-05" and first[4] == "2026-10-01"  # newest first; when it was made
    assert [d[5] for d in shard["decks"]] == [4, 0, 3, 3, 3]  # its bracket (0: none)
    assert [d[4] for d in shard["decks"]] == ["2026-10-01", "2026-09-13", "2025-01-01", "2025-01-01", "2025-01-01"]
    positions = [sum(first[3][:i + 1]) for i in range(len(first[3]))]
    assert [shard["cards"][p] for p in positions] == [2, 98]  # no commander, no basic land
    with open(os.path.join(out, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    assert index["decks"] == 5 and index["commanders"][0][:2] == ["0", 5]
    assert index["since"] == ["2026-07-06", "2026-09-04", "2026-09-27"], index["since"]  # the 90, 30 and 7 day windows
    assert index["staples"][:2] == [2, 3] and len(index["staples"]) == 97  # every card these few decks play is in 4 or 5 of 5
    assert shard["price"] == 300 and shard["bracket"] == 3  # basic lands are left out of the price
    assert shard["results"] == 1 and os.path.exists(os.path.join(out, "results", "0.json"))  # 1 tournament deck
    assert os.path.exists(os.path.join(out, "results", "lists", "0.json"))

    # Tournament results: each commander's decks and the decks playing each card, per window, and
    # its best finishes. Cards by name (a double-faced one by its front face), partners either way.
    named = [{"name": "Lead"}, {"name": "Partner"}, {"name": "Island", "type_line": "Basic Land — Island"},
             {"name": "Bolt"}, {"name": "Front // Back"}]
    tournament = lambda i, day, cut, entries: {"id": i, "name": f"Event {i}", "date": day, "size": 40,
                                                "top_cut": cut, "entries": entries}
    # Pilots: Ann (7) played Lead twice and an unknown commander; event 2 was fetched before pilots were
    events = {
        1: tournament(1, "2026-09-30", 4, [["Lead", 1, 4, 1, 1, "link1", ["Bolt", "Front", "Island", "Lead"], 7, "Ann"],
                                           ["Lead", 9, 1, 5, 0, "link2", ["Bolt"], 8, "Bo"],
                                           ["Partner / Lead", 2, 3, 2, 1, "link3", ["Bolt"], 0, ""],
                                           ["Unknown", 3, 3, 3, 0, "", ["Bolt"], 7, "Ann", "tdA"]]),
        2: tournament(2, "2026-01-01", 0, [["Lead", 1, 5, 0, 0, "link4", ["Front // Back", "Nope"]]])}
    stats = build_decks.tournament_stats(events, named, date(2026, 10, 4))
    assert sorted(stats) == ["0", "0-1"], stats.keys()
    lead = stats["0"]
    # [decks, games, wins, decks in events with a top cut, top cuts, draws]: in 90 and 180 days event
    # 1's two decks (one made the cut), in one and two years event 2's too (which had no cut)
    assert lead["totals"] == [[2, 12, 5, 2, 1, 1], [2, 12, 5, 2, 1, 1], [3, 17, 10, 2, 1, 1], [3, 17, 10, 2, 1, 1]], lead["totals"]
    assert lead["cards"] == [3, 4]  # Bolt and Front, each in 2 decks; not the commander or a basic land
    assert lead["stats"] == [[2, 12, 5, 2, 1] * 4, [1, 6, 4, 1, 1] * 2 + [2, 11, 9, 1, 1] * 2], lead["stats"]
    # each with its number among the decks in lists (below)
    assert lead["top"] == [["2026-09-30", "Event 1", 40, 1, 4, 1, 1, "link1", 7, "Ann", 0],
                           ["2026-01-01", "Event 2", 40, 1, 5, 0, 0, "link4", 0, "", 2]], lead["top"]
    assert lead["pilots"] == [[7, "Ann", *[1, 6, 4, 1, 1, 1] * 4], [8, "Bo", *[1, 6, 1, 1, 0, 0] * 4]], lead["pilots"]
    histories = build_decks.pilot_histories(events, named, stats)
    assert sorted(histories) == [7, 8] and histories[7][0] == "Ann" and histories[7][2] == "tdA"  # her TopDeck profile
    # Finding pilots by name or commander: Ann's 2 decks, 1 of them Lead's (the other's commander is unknown)
    assert build_decks.pilot_index(histories) == [[7, "Ann", 2, "0", 1], [8, "Bo", 1, "0", 1]]
    # Each deck with its number in its commander's lists (-1: a commander without results)
    assert histories[7][1] == [["2026-09-30", "Event 1", 40, 4, 1, 4, 1, 1, "0", "Lead", "link1", 0],
                               ["2026-09-30", "Event 1", 40, 4, 3, 3, 3, 0, "", "Unknown", "", -1]], histories[7]
    assert stats["0-1"]["cards"] == []  # in 1 deck: too few to say anything
    # Each deck, for testing packages: narrowest window (event 2 is in the year's, 2), games, wins,
    # top cut (2: made it, 1: missed it, 0: none) and its cards as gaps between positions in cards
    assert lead["lists"] == {"cards": [3, 4], "decks": [[0, 6, 4, 2, 0, 1], [0, 6, 1, 1, 0], [2, 5, 5, 0, 1]]}, lead["lists"]
    assert lead["field"][-1] == [5, 29, 16, 4, 3, 2]  # every deck, the unknown commander's too
    # The cards a pilot likes: all 5 Lead decks play Bolt, but only Ann's two play Front (2 of 5 Lead
    # decks: 0.8 of her 2 expected); Bo plays nothing more than expected, nobody else has 2 decks
    played = {1: tournament(1, "2026-09-30", 4, [["Lead", 1, 3, 1, 0, "", ["Bolt", "Front"], 7, "Ann"],
                                                 ["Lead", 2, 2, 2, 0, "", ["Bolt"], 8, "Bo"],
                                                 ["Lead", 3, 1, 3, 0, "", ["Bolt"], 0, ""]]),
              2: tournament(2, "2026-09-29", 4, [["Lead", 1, 4, 0, 0, "", ["Bolt", "Front"], 7, "Ann"],
                                                 ["Lead", 2, 1, 3, 0, "", ["Bolt"], 8, "Bo"]])}
    liked = build_decks.pilot_cards(played, named, build_decks.tournament_stats(played, named, date(2026, 10, 4)))
    assert liked == {7: [[4, 2, 8, 7, 0.8]], 8: []}, liked

    # Ranking: Ann's two decks, both in every window (both made the top 4), counted with RANKED_DECKS at 2
    real_ranked, build_decks.RANKED_DECKS = build_decks.RANKED_DECKS, 2
    try:
        assert build_decks.ranking(histories, date(2026, 10, 4)) == [[7, "Ann", *[2, 12, 7, 2, 2, 1] * 4]]
    finally:
        build_decks.RANKED_DECKS = real_ranked

    # Highlights, needing 1 deck each: this month Lead's 2 decks scored 25 points in 8 games (two
    # pilots), its partners' deck none; before, Lead 5 in 4 games and the partners 6 (a draw)
    finish = lambda lead, wins, losses, draws, who=0: [lead, 1, wins, losses, draws, "", [], who, ""]
    monthly = {1: tournament(1, "2026-09-30", 0, [finish("Lead", 3, 1, 0, 1), finish("Lead", 2, 2, 0, 2), finish("Partner / Lead", 0, 4, 0)]),
               2: tournament(2, "2026-08-01", 0, [finish("Lead", 1, 3, 0), finish("Partner / Lead", 1, 2, 1)]),
               3: tournament(3, "2026-01-01", 0, [finish("Partner / Lead", 9, 0, 0)])}  # too long ago
    saved = build_decks.BEST_DECKS, build_decks.BREAKOUT_DECKS, build_decks.RISING_DECKS
    build_decks.BEST_DECKS = build_decks.BREAKOUT_DECKS = build_decks.RISING_DECKS = 1
    try:
        got = build_decks.highlights(monthly, named, date(2026, 10, 4))
    finally:
        build_decks.BEST_DECKS, build_decks.BREAKOUT_DECKS, build_decks.RISING_DECKS = saved
    assert got["decks"] == 3 and got["field"] == round(25 / 12, 3) and got["best"] == ["0", 2, 3.125, 2, None], got
    # Each a different commander: Lead is best, so the partners are the breakout (1 of 3 decks, against
    # 1 of 2 before), and the only one left to rise is none
    assert got["breakout"] == ["0-1", 1, 0.0, 0, 0.5] and got["rising"] is None, got

    # A card across commanders: in A's decks and B's it wins 10 points more than their decks without it,
    # A's counting three times as much (300 games each side, against 100); card 8 is in too few of B's
    window = lambda *row: [list(row)] * len(build_decks.RESULT_WINDOWS)
    overall = build_decks.pooled({
        "A": {"totals": window(60, 600, 150, 0, 0), "cards": [7], "stats": [sum(window(30, 300, 90, 0, 0), [])]},
        "B": {"totals": window(20, 200, 40, 0, 0), "cards": [7, 8],
              "stats": [sum(window(10, 100, 25, 0, 0), []), sum(window(2, 20, 10, 0, 0), [])]},
    }, window(80, 800, 190, 0, 0))
    decks, commanders, lift, evidence = overall[7][0]
    assert (decks, commanders) == (40, 2) and abs(lift - 0.1 * 200 / 300) < 1e-9, overall[7]
    assert abs(evidence - 0.1 / (2 * 0.2375 * 0.7625 / 200) ** 0.5) < 1e-9
    assert overall[8][0] == [2, 0, 0.0, 0.0]

    # Results from a fake TopDeck.gg: a week a query, from 3 days before the newest tournament it has;
    # a player keeps their number and a new one gets the next; entries without a decklist, tournaments
    # without one, and a copy with fewer decklists than the one it has are left out; nothing it has is dropped
    def player(name, who, cards=("Bolt",), commanders=("Lead",), decklist="text"):
        return {"name": name, "id": who, "wins": 3, "losses": 1, "draws": 0, "decklist": decklist,
                "deckObj": {"Commanders": {c: {"count": 1} for c in commanders}, "Mainboard": {c: {"count": 1} for c in cards}}}
    noon = lambda day: int(datetime(2026, 9, day, 12, tzinfo=timezone.utc).timestamp())
    week = [{"TID": "new", "tournamentName": " Event ", "startDate": noon(30), "topCut": 4, "standings": [
                player(" Ann ", "td1", commanders=("Tymna", "Kraum")), player("Bo", "tdNew", decklist="https://moxfield.com/decks/x"),
                {"name": "Cy", "id": "td3", "wins": 1, "losses": 3, "draws": 0, "decklist": None, "deckObj": None}]},
            {"TID": "none", "tournamentName": "No lists", "startDate": noon(29), "standings": [{"name": "Di", "id": "td4"}]},
            {"TID": "same", "tournamentName": "Fewer now", "startDate": noon(28), "standings": []}]
    asked = []

    def fake_get_json(path, base, post=None, headers=None):
        asked.append((path, base, post, headers))
        return week if len(asked) == 1 else []
    path = os.path.join(tmp, "results.jsonl.gz")
    save_corpus({"same": {"id": "same", "date": "2026-09-28", "decklists": 1, "entries": [["Lead", 1, 3, 1, 0, "x", [], 4272, "Ann", "td1"]]},
                 "old": {"id": "old", "date": "2024-01-01", "entries": []}}, path)
    real_get_json, build_decks.get_json = build_decks.get_json, fake_get_json
    os.environ["TOPDECK_API_KEY"] = "key"
    try:
        build_decks.fetch_results(path=path, today=date(2026, 10, 4))
    finally:
        build_decks.get_json = real_get_json
        del os.environ["TOPDECK_API_KEY"]
    assert [(p, b, h) for p, b, _, h in asked] == [("/v2/tournaments", build_decks.TOPDECK, {"Authorization": "key"})] * 2
    first, second = (post for _, _, post, _ in asked)
    assert first["start"] == int(datetime(2026, 9, 25, tzinfo=timezone.utc).timestamp()) and first["participantMin"] == 16
    assert second["end"] == int(datetime(2026, 10, 5, tzinfo=timezone.utc).timestamp()) - 1  # through today
    got = load_corpus(path)
    assert sorted(got) == ["new", "old", "same"], got.keys()  # over two years old: kept; no decklists: never kept
    assert got["new"] == {"id": "new", "name": "Event", "date": "2026-09-30", "size": 3, "top_cut": 4, "decklists": 2, "entries": [
        ["Kraum / Tymna", 1, 3, 1, 0, "https://topdeck.gg/deck/new/td1", ["Bolt"], 4272, "Ann", "td1"],
        ["Lead", 2, 3, 1, 0, "https://moxfield.com/decks/x", ["Bolt"], 4273, "Bo", "tdNew"]]}, got["new"]
    assert got["same"]["entries"][0][7] == 4272  # the copy with more decklists stays
    try:
        build_decks.topdeck_key()
        raise AssertionError("no key should stop it")
    except SystemExit:
        pass
    with open(os.path.join(out, "trends.json"), encoding="utf-8") as f:
        trends = json.load(f)
    key, made, price, bracket, _ = trends["commanders"][0]
    assert key == "0" and made == [5, 2, 2, 1] and trends["everything"][0] == made, made
    with open(os.path.join(out, "trend-cards", "0.json"), encoding="utf-8") as f:  # colorless: no colors in the test cards
        (i, kept, plays), = json.load(f)
    assert i == 0 and kept[0] == 2 and [counts[0] for counts in plays] == [5, 2, 2, 1]  # c0, in every deck
    with open(os.path.join(out, "card-commanders", "0.json"), encoding="utf-8") as f:
        assert json.load(f)[2] == [0, 5]  # c0: commander 0's 5 decks play it

    # An undated Archidekt deck was made when the last dated one before it was (or who knows: "")
    assert build_decks.made_dates([{"id": 1, "created": "2026-01-01"}, {"id": 2}, {"id": 0}, {"id": 3, "created": "2026-02-01"},
                                   {"id": "m", "created": "2026-03-01"}, {"id": "n"}],
                                  [(1, "2026-01-01"), (3, "2026-02-01")]) == \
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
    count = Counter(o for d in corpus_now().values() for o in d["commanders"])
    assert count == {"A": 3, "B": 3, "D": 3}, count  # A already had 3
    with open("crawl_state.json", encoding="utf-8") as f:
        assert sorted(json.load(f)) == ["B // B2", "D"]

    # Moxfield: --top counts only Moxfield's decks (A's 3 are Archidekt's), and takes its own turns
    with gzip.open("default_cards.jsonl.gz", "wt", encoding="utf-8") as f:
        f.writelines(json.dumps({"id": p, "oracle_id": o}) + "\n" for p, o in printings.items())
        f.write(json.dumps({"id": "p-reversible", "card_faces": [{"oracle_id": "c0"}, {"oracle_id": "c0"}]}) + "\n")
    assert build_decks.printing_oracles() == {**printings, "p-reversible": "c0"}
    build_decks.crawl(3, top=10, site="moxfield")
    corpus = corpus_now()
    count = Counter(o for d in corpus.values() if isinstance(d["id"], str) for o in d["commanders"])
    assert count == {"A": 3, "B": 3, "D": 3}, count
    assert corpus["A-Descending1-0"]["created"] == "2026-09-29"
    with open("crawl_state.json", encoding="utf-8") as f:
        assert sorted(json.load(f)) == ["B // B2", "D", "moxfield:A", "moxfield:B // B2", "moxfield:D"]
    # Recently updated decks, then each commander, newest decks and then oldest
    build_decks.crawl(0, site="moxfield")
    assert sorted(i for i in corpus_now() if str(i).startswith("new")) == \
        ["new-Descending1-0", "new-Descending1-1", "new-Descending2-0", "new-Descending2-1"]
    build_decks.crawl(10, only=["d"], site="moxfield")
    assert sum(isinstance(d["id"], str) and d["commanders"] == ["D"] for d in corpus_now().values()) == 8
    # --bracket: each site's search asks for just that bracket, and the crawl takes its own turns
    searched = []
    build_decks.get_json = lambda path, base=build_decks.ARCHIDEKT: searched.append(path) or fake_get_json(path, base)
    build_decks.crawl(1, only=["a"], bracket=5)
    build_decks.crawl(1, only=["a"], site="moxfield", bracket=5)
    query = lambda prefix: [urllib.parse.parse_qs(p.partition("?")[2]) for p in searched if p.startswith(prefix)]
    assert query("/decks/v3/") and all(q["edhBracket"] == ["5"] for q in query("/decks/v3/"))
    assert query("/v2/decks/search") and all(q["minBracket"] == q["maxBracket"] == ["5"] for q in query("/v2/decks/search"))
    with open("crawl_state.json", encoding="utf-8") as f:
        assert {"A (bracket 5)", "moxfield:A (bracket 5)"} <= set(json.load(f))
    # A site error on one commander's search skips it, unmarked so it's first in line next time,
    # rather than stopping the crawl
    def failing(path, base=build_decks.ARCHIDEKT):
        if path.startswith("/v2/cards/search"):
            raise urllib.error.HTTPError(path, 424, "Failed Dependency", {}, None)
        return fake_get_json(path, base)
    build_decks.get_json = failing
    build_decks.crawl(1, only=["b"], site="moxfield", bracket=4)
    with open("crawl_state.json", encoding="utf-8") as f:
        assert "moxfield:B // B2 (bracket 4)" not in json.load(f)

    # Before uploading, the release's copy is merged in: decks only it has, and newer versions
    os.makedirs("release")
    with open(os.path.join("release", "decks-new.jsonl.gz"), "wb") as f:
        for d in [{**deck, "id": 1, "updated": "2026-01-01", "created": "2025-12-01"}, {**deck, "id": 2, "updated": "2026-12-01"},
                  {**deck, "id": 99}]:
            f.write(gzip.compress((json.dumps(d) + "\n").encode()))
    compact(corpus_files("release"), "release")
    with open(os.path.join("release", "crawl_state.json"), "w", encoding="utf-8") as f:
        json.dump({"A": "2027-01-01", "Z": "2026-01-01"}, f)
    os.makedirs("mine")
    os.chdir("mine")
    with open("decks-new.jsonl.gz", "wb") as f:
        for d in [{**deck, "id": 1, "updated": "2026-06-01"}, {**deck, "id": 2, "updated": "2026-06-01"}]:
            f.write(gzip.compress((json.dumps(d) + "\n").encode()))
    state = {"A": "2026-10-01", "B // B2": "2026-10-01"}
    assert build_decks.merge(os.path.join("..", "release"), state) == (2, 3)
    mine = all_decks()
    assert {i: d["updated"] for i, d in mine.items()} == {1: "2026-06-01", 2: "2026-12-01", 99: "2026-09-30"}
    assert state == {"A": "2027-01-01", "B // B2": "2026-10-01", "Z": "2026-01-01"}
    assert mine[1]["created"] == "2025-12-01"  # an older copy can still tell when the deck was made
    os.chdir("..")
    # Tournaments: the ones only the other copy has, and ones it has more decklists of
    old, new = [0] * 9, [0] * 10  # an entry fetched before pilots' profiles were, and one after
    mine = {"a": {"entries": [new, new]}, "b": {"entries": [new]}, "d": {"entries": [old]}}
    assert build_decks.merge_results(mine, {"a": {"entries": [new]}, "b": {"entries": [new, new]}, "c": {"entries": []},
                                            "d": {"entries": [new]}}) == 3
    assert mine == {"a": {"entries": [new, new]}, "b": {"entries": [new, new]}, "c": {"entries": []}, "d": {"entries": [new]}}
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
print("ok")
