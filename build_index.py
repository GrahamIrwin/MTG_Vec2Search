"""Download the latest Scryfall card data and build site/cards.json, the search index.

Run this whenever a new set comes out:  python build_index.py
(GitHub Actions also runs it weekly and redeploys the site.)
"""
import gzip
import json
import os
import re
import shutil
import urllib.request
from collections import Counter

# === Settings ===
SCRYFALL_BULK_LIST_URL = "https://api.scryfall.com/bulk-data"
# oracle_cards = one entry per unique card (vs. default_cards = every printing)
BULK_TYPE = "oracle_cards"
BULK_FILE = "oracle_cards.jsonl.gz"
OUT_FILE = os.path.join("site", "cards.json")
# Scryfall requires a User-Agent and Accept header on API requests
HEADERS = {"User-Agent": "MTG_Vec2Search/1.0", "Accept": "application/json;q=0.9,*/*;q=0.8"}
SKIP_LAYOUTS = {"token", "double_faced_token", "emblem", "art_series", "augment", "host",
                "planar", "scheme", "vanguard"}
FORMATS = ["standard", "pioneer", "modern", "legacy", "vintage", "commander", "pauper"]

# === Term space ===
# Keywords and subtypes are read from the card data, so new mechanics and
# creature types become searchable as soon as a set is released.
COLORS = ["W", "U", "B", "R", "G", "Colorless"]
TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Planeswalker",
         "Battle", "Legendary"]
TEXT_TERMS = ["draw", "destroy", "counter target", "exile", "sacrifice", "life gain", "search your library"]
ACTION_CONCEPTS = [
    "Life Gain", "Card Advantage", "Tap Effect", "Direct Damage", "Mana Ramp",
    "Graveyard Recursion", "Discard Effect", "Counter Effect", "Removal", "Exile Effect",
    "Bounce Effect", "Mass Removal", "Fight Effect", "Mill Effect", "Token Creation",
    "Artifact Interaction", "Landfall Effect", "Enchantment Interaction"
]
CMC_BUCKETS = ["CMC_0", "CMC_1", "CMC_2", "CMC_3", "CMC_4", "CMC_5", "CMC_6", "CMC_7_plus"]

# Keywords/subtypes on fewer cards than this are mostly one-off flavor abilities
MIN_CARDS = 3
# Real subtypes/keywords that are also everyday words, so they'd false-match search queries
STOPWORDS = {"you", "the", "of", "new", "will", "time", "lord", "head", "art", "fire", "moon",
             "gold", "mine", "plan", "key", "map", "town", "lady", "sand", "hell", "case",
             "room", "double"}
SUBTYPE_RE = re.compile(r"^[A-Z][A-Za-z'-]+$")


def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS))


# === Step 1: Download the bulk card data ===
def download_bulk_data():
    print("Fetching bulk data list from Scryfall...")
    with fetch(SCRYFALL_BULK_LIST_URL) as r:
        item = next(i for i in json.load(r)["data"] if i["type"] == BULK_TYPE)
    print(f"Scryfall data last updated: {item['updated_at']}")
    print(f"Downloading {item['jsonl_download_uri']}...")
    with fetch(item["jsonl_download_uri"]) as r, open(BULK_FILE, "wb") as f:
        shutil.copyfileobj(r, f)
    return item["updated_at"]


# === Step 2: Load cards ===
def load_cards():
    cards = []
    with gzip.open(BULK_FILE, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            card = json.loads(line)
            # Skip digital-only cards, tokens, and non-traditional cards
            if card.get("digital") or card.get("layout") in SKIP_LAYOUTS:
                continue
            # Double-faced/split cards keep colors and rules text on their faces
            faces = card.get("card_faces", [])
            card["oracle_text"] = card.get("oracle_text") or "\n".join(f.get("oracle_text", "") for f in faces)
            card["colors"] = card.get("colors") or sorted({c for f in faces for c in f.get("colors", [])})
            cards.append(card)
    return cards


def subtypes(type_line):
    return [s for part in type_line.split("//") if "—" in part for s in part.split("—")[1].split()]


def build_term_space(cards):
    def common(counter):
        return sorted(t for t, n in counter.items() if n >= MIN_CARDS and t.lower() not in STOPWORDS)

    keywords = common(Counter(k for c in cards for k in c.get("keywords", [])))
    subs = common(Counter(s for c in cards for s in subtypes(c.get("type_line", "")) if SUBTYPE_RE.match(s)))
    terms = COLORS + TYPES + keywords + subs + TEXT_TERMS + ACTION_CONCEPTS + CMC_BUCKETS
    return list(dict.fromkeys(terms)), keywords  # dedupe (e.g. "Food" is a keyword and a subtype)


# === Step 3: Vectorize ===
def determine_cmc_bucket(cmc):
    return f"CMC_{int(cmc)}" if cmc < 7 else "CMC_7_plus"


def detect_action_concepts(oracle_text, is_land=False):
    text = oracle_text.lower()
    actions = set()

    # Life Gain
    if "gain life" in text or "lifelink" in text:
        actions.add("Life Gain")

    # Card Advantage
    if any(term in text for term in ["draw a card", "scry", "investigate", "loot"]):
        actions.add("Card Advantage")

    # Tap Effects
    if "tap target" in text or "untap target" in text or "tap an untapped" in text:
        actions.add("Tap Effect")

    # Direct Damage
    if re.search(r"deals? (?:\d+|x|that much) damage", text) or "burn" in text:
        actions.add("Direct Damage")

    # Mana Ramp
    if any(term in text for term in ["search your library for a land", "add mana", "put a land"]):
        actions.add("Mana Ramp")
    # Mana dorks/rocks ("{T}: Add {G}"); every land does this, so it's not ramp there
    if not is_land and re.search(r"\badd (?:\{|\w+ mana)", text):
        actions.add("Mana Ramp")

    # Graveyard Recursion
    if any(term in text for term in ["return target creature card", "reanimate", "raise dead"]):
        actions.add("Graveyard Recursion")

    # Discard
    if "target opponent discards" in text or "discard a card" in text:
        actions.add("Discard Effect")

    # Counter Effects
    if "counter target spell" in text or "counter an ability" in text:
        actions.add("Counter Effect")

    # Removal
    if "destroy target creature" in text or "destroy target permanent" in text:
        actions.add("Removal")

    # Exile Effects
    if "exile target" in text or "exile all" in text:
        actions.add("Exile Effect")

    # Bounce Effects
    if "return target" in text and "to its owner's hand" in text:
        actions.add("Bounce Effect")

    # Mass Removal
    if "destroy all creatures" in text or "each creature gets" in text:
        actions.add("Mass Removal")

    # Fight Effects
    if "fights target" in text or "fight another target creature" in text:
        actions.add("Fight Effect")

    # Mill Effects
    if "put the top" in text and "cards of your library into your graveyard" in text:
        actions.add("Mill Effect")

    # Token Creation
    if "create a" in text and "token" in text:
        actions.add("Token Creation")

    # Artifact Interaction
    if "destroy target artifact" in text or "exile target artifact" in text:
        actions.add("Artifact Interaction")

    # Enchantment Interaction
    if "destroy target enchantment" in text or "exile target enchantment" in text:
        actions.add("Enchantment Interaction")

    # Landfall Effects
    if "whenever a land enters" in text:
        actions.add("Landfall Effect")

    return actions


def keyword_matcher(keywords):
    """Regex finding keyword names as whole words in rules text (e.g. cards that grant flying)."""
    alts = sorted((re.escape(k.lower()) for k in keywords), key=len, reverse=True)
    lookup = {k.lower(): k for k in keywords}
    pattern = re.compile(r"\b(?:" + "|".join(alts) + r")\b")
    return lambda text: {lookup[m] for m in pattern.findall(text)}


def vectorize_card(card, index, find_keywords):
    """Return the sorted term indices set for this card (a sparse binary vector)."""
    text = card["oracle_text"].lower()
    type_line = card.get("type_line", "")
    type_words = set(type_line.replace("//", " ").split())

    features = set(card["colors"] or ["Colorless"])
    features |= {t for t in TYPES if t in type_words}
    features |= set(subtypes(type_line))
    features |= set(card.get("keywords", [])) | find_keywords(text)
    features |= {t for t in TEXT_TERMS if re.search(r"\b" + t, text)}
    features |= detect_action_concepts(text, "Land" in type_words)
    features.add(determine_cmc_bucket(card.get("cmc", 0)))
    return sorted(index[f] for f in features if f in index)


# === Step 4: Write the index ===
def build_index(cards, updated):
    terms, keywords = build_term_space(cards)
    index = {t: i for i, t in enumerate(terms)}
    find_keywords = keyword_matcher(keywords)

    rows = []
    for c in cards:
        cmc = c.get("cmc", 0)
        legal = sum(1 << i for i, f in enumerate(FORMATS) if c.get("legalities", {}).get(f) in ("legal", "restricted"))
        rows.append([
            c["name"], c.get("type_line", ""), int(cmc) if cmc == int(cmc) else cmc, c["id"],
            "".join(c.get("color_identity", [])), legal, c.get("edhrec_rank"),
            vectorize_card(c, index, find_keywords),
        ])

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump({
            "updated": updated, "terms": terms, "formats": FORMATS,
            # Each card: [name, type_line, cmc, scryfall_id, color_identity, legal_bitmask, edhrec_rank, term_indices]
            "cards": rows,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUT_FILE}: {len(rows)} cards, {len(terms)} terms, {os.path.getsize(OUT_FILE) / 1e6:.1f} MB")


if __name__ == "__main__":
    updated = download_bulk_data()
    build_index(load_cards(), updated)
