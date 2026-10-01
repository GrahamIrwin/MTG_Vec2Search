"""Self-check for card vectorization: python test_build_index.py"""
from build_index import build_term_space, keyword_matcher, vectorize_card

card = {
    "name": "Test Dragon", "type_line": "Legendary Creature — Dragon", "cmc": 5, "colors": ["R"],
    "keywords": ["Flying"],
    "oracle_text": "Flying\nOther creatures you control have trample.\nWhen this enters, it deals 3 damage to any target. Draw a card.\nWard toward the reward.",
}
terms, keywords = build_term_space([card, {**card, "keywords": ["Trample"]}, {**card, "keywords": ["Ward"]}] * 3)
index = {t: i for i, t in enumerate(terms)}
got = {terms[i] for i in vectorize_card(card, index, keyword_matcher(keywords))}

assert got == {"R", "Legendary", "Creature", "Dragon", "Flying", "Trample", "Ward",
               "draw", "Card Advantage", "Direct Damage", "CMC_5"}, got
# "toward"/"reward" must not count as Ward; only the standalone "Ward" line does
card["oracle_text"] = "Creatures move toward the reward."
assert "Ward" not in {terms[i] for i in vectorize_card(card, index, keyword_matcher(keywords))}
# Mana dorks are ramp; lands that tap for mana are not
card["oracle_text"] = "{T}: Add {G}."
assert "Mana Ramp" in {terms[i] for i in vectorize_card(card, index, keyword_matcher(keywords))}
card["type_line"] = "Basic Land — Forest"
assert "Mana Ramp" not in {terms[i] for i in vectorize_card(card, index, keyword_matcher(keywords))}
print("ok")
