"""Self-check for the deck corpus and site/decks/: python test_build_decks.py"""
import gzip
import json
import os
import tempfile
import urllib.parse
from collections import Counter

import build_decks
from build_decks import build, load_corpus, save_corpus, slim_deck


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
    corpus[5]["cards"] = {"cmdr": 1, "c96": 1, "c0": 1}
    out = os.path.join(tmp, "decks")
    build(corpus, cards, out)
    with open(os.path.join(out, "0.json"), encoding="utf-8") as f:
        shard = json.load(f)
    assert shard["cards"][:2] == [2, 98] and len(shard["cards"]) == 97  # c0 and c96 are in every deck
    first = shard["decks"][0]
    assert first[0] == 5 and first[2] == "2026-09-05"  # newest first
    positions = [sum(first[3][:i + 1]) for i in range(len(first[3]))]
    assert [shard["cards"][p] for p in positions] == [2, 98]  # no commander, no basic land
    with open(os.path.join(out, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    assert index["decks"] == 5 and index["commanders"][0][:2] == ["0", 5]

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

    lead = {}
    def fake_get_json(path):
        if path.startswith("/decks/v3/"):
            name = urllib.parse.parse_qs(path.split("?")[1])["commanderName"][0]
            uid = next(c["oracle_id"] for c in oracle if c["name"] == name)
            lead.update({f"{uid}{i}": uid for i in range(5)})
            return {"results": [{"id": f"{uid}{i}", "size": 100, "updatedAt": "2026-09-30"} for i in range(5)]}
        deck_id = path.split("/")[2]
        return {**archidekt, "id": deck_id, "cards": [entry(lead[deck_id], ["Commander"])] + archidekt["cards"][1:]}
    build_decks.get_json, build_decks.DELAY = fake_get_json, 0
    save_corpus({i: {**deck, "id": i, "commanders": ["A"]} for i in range(3)}, "decks.jsonl.gz")
    build_decks.crawl(3, top=10)
    count = Counter(o for d in load_corpus("decks.jsonl.gz").values() for o in d["commanders"])
    assert count == {"A": 3, "B": 3, "D": 3}, count  # A already had 3
    with open("crawl_state.json", encoding="utf-8") as f:
        assert sorted(json.load(f)) == ["B // B2", "D"]
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
print("ok")
