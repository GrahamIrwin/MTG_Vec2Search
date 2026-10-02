"""Self-check for card vectorization: python test_build_index.py"""
from build_index import build_term_space, keyword_matcher, token_features, vectorize_card

card = {
    "name": "Test Dragon", "type_line": "Legendary Creature — Dragon", "cmc": 5, "colors": ["R"],
    "keywords": ["Flying"], "oracle_id": "o1",
    "oracle_text": "Flying\nOther creatures you control have trample.\nWhen this enters, it deals 3 damage to any target. Draw a card.\nWard toward the reward.",
}
tags = {"hate-artifact": ({"o1", "o2"}, ["hate-artifact"]), "only-one": ({"o1"}, ["only-one"])}
cards = [card, {**card, "keywords": ["Trample"], "oracle_id": "o2"}, {**card, "keywords": ["Ward"]}] * 3
terms, keywords, _ = build_term_space(cards, tags)
index = {t: i for i, t in enumerate(terms)}
assert "tag:hate-artifact" in terms and "tag:only-one" not in terms  # tags on a single card are dropped
vec = lambda c, card_tags=(): {terms[i] for i in vectorize_card(c, index, keyword_matcher(keywords), card_tags)}

assert vec(card, ["hate-artifact"]) == {"R", "Legendary", "Creature", "Dragon", "Flying", "Trample", "Ward",
                                        "CMC_5", "tag:hate-artifact"}, vec(card)
# "toward"/"reward" must not count as Ward; only the standalone "Ward" line does
card["oracle_text"] = "Creatures move toward the reward."
assert "Ward" not in vec(card)

# Token makers: the token's colors, types, subtypes and keywords
find_kw = keyword_matcher(["Flying", "Haste"])
assert token_features("Create two 1/1 white Spirit creature tokens with flying.", find_kw, {"Spirit"}) == \
    {"token:W", "token:Creature", "token:Spirit", "token:Flying"}
assert token_features("Create a 3/3 green and white Elephant creature token.", find_kw, {"Elephant"}) == \
    {"token:G", "token:W", "token:Creature", "token:Elephant"}
assert token_features("Create a token that's a copy of target creature.", find_kw, set()) == set()
print("ok")
