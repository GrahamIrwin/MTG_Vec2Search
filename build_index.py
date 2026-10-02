"""Download the latest Scryfall card data and build site/index/, the search index.

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
TAGS_FILE = "oracle_tags.jsonl.gz"
PRINTINGS_FILE = "default_cards.jsonl.gz"  # every printing, for the cheapest price
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


# === Step 1: Download the bulk data ===
# oracle_tags = Scryfall Tagger's community-curated tags for what cards do
# ("tutor-instant", "hate-nonbasic-land", "removal-artifact", ...)
BULK_FILES = {"oracle_cards": BULK_FILE, "oracle_tags": TAGS_FILE, "default_cards": PRINTINGS_FILE}


def download_bulk_data():
    print("Fetching bulk data list from Scryfall...")
    with fetch(SCRYFALL_BULK_LIST_URL) as r:
        items = {i["type"]: i for i in json.load(r)["data"]}
    for bulk_type, path in BULK_FILES.items():
        print(f"Downloading {items[bulk_type]['jsonl_download_uri']}...")
        with fetch(items[bulk_type]["jsonl_download_uri"]) as r, open(path, "wb") as f:
            shutil.copyfileobj(r, f)
    print(f"Scryfall data last updated: {items[BULK_TYPE]['updated_at']}")
    return items[BULK_TYPE]["updated_at"]


def load_oracle_tags():
    """Return {slug: (oracle_ids, names)}. The bulk file only has direct taggings, so each card
    is also added to every ancestor tag (e.g. "tutor-instant" cards are also "tutor").
    names = the slug, label and community aliases, used to match search queries."""
    with gzip.open(TAGS_FILE, "rt", encoding="utf-8") as f:
        raw = [json.loads(line) for line in f if line.strip()]
    by_id = {t["id"]: t for t in raw}
    ids = {t["id"]: {g["oracle_id"] for g in t["taggings"] if g.get("oracle_id")} for t in raw}

    def ancestors(tag, seen):
        for parent in tag.get("parent_ids") or []:
            if parent in by_id and parent not in seen:
                seen.add(parent)
                ancestors(by_id[parent], seen)
        return seen

    for t in raw:
        for parent in ancestors(t, set()):
            ids[parent] |= ids[t["id"]]
    return {t["slug"]: (ids[t["id"]], sorted({t["slug"], t["label"], *(t.get("aliases") or [])}))
            for t in raw}


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


TOKEN_RE = re.compile(r"\bcreates? ([^.;]*?)\btokens?\b([^.;]*)", re.IGNORECASE)
COLOR_WORDS = {"white": "W", "blue": "U", "black": "B", "red": "R", "green": "G", "colorless": "Colorless"}


def token_features(oracle_text, find_keywords, subtype_names):
    """Features of the tokens a card creates, e.g. "create two 1/1 white Spirit creature tokens
    with flying" -> {"token:W", "token:Creature", "token:Spirit", "token:Flying"}."""
    features = set()
    for desc, rest in TOKEN_RE.findall(oracle_text):
        if rest.lstrip().lower().startswith(("that's a copy", "that are copies")):
            continue
        for word in re.findall(r"[A-Za-z'-]+", desc):
            if word.lower() in COLOR_WORDS:
                features.add("token:" + COLOR_WORDS[word.lower()])
            elif word.capitalize() in TYPES or word in subtype_names:
                features.add("token:" + (word.capitalize() if word.capitalize() in TYPES else word))
        with_clause = re.match(r"\s*with ([^\"]*)", rest)
        if with_clause:
            features |= {"token:" + k for k in find_keywords(with_clause[1].lower())}
    return features


def build_term_space(cards, tags):
    def common(counter):
        return sorted(t for t, n in counter.items() if n >= MIN_CARDS and t.lower() not in STOPWORDS)

    keywords = common(Counter(k for c in cards for k in c.get("keywords", [])))
    subs = common(Counter(s for c in cards for s in subtypes(c.get("type_line", "")) if SUBTYPE_RE.match(s)))
    find_keywords, sub_names = keyword_matcher(keywords), set(subs)
    tokens = common(Counter(f for c in cards for f in token_features(c["oracle_text"], find_keywords, sub_names)))
    # Tags on a single card or on most cards don't help ranking
    oracle_ids = {c.get("oracle_id") for c in cards}
    tag_counts = {t: len(oracle_ids & ids) for t, (ids, _) in tags.items()}
    tag_terms = sorted("tag:" + t for t, n in tag_counts.items()
                       if 2 <= n <= len(cards) / 2 and not t.startswith("cycle"))  # card cycles aren't search targets
    categories = {
        "Colors": COLORS, "Card types": TYPES, "Keywords": keywords, "Subtypes": subs,
        "Rules text": TEXT_TERMS, "Effects": ACTION_CONCEPTS, "Mana value": CMC_BUCKETS,
        "Tokens it makes": tokens, "What it does (Scryfall Tagger)": tag_terms,
    }
    terms = list(dict.fromkeys(t for ts in categories.values() for t in ts))  # dedupe ("Food": keyword + subtype)
    return terms, keywords, categories


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


def vectorize_card(card, index, find_keywords, card_tags=(), subtype_names=frozenset()):
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
    tokens = token_features(card["oracle_text"], find_keywords, subtype_names)
    if tokens:
        features |= tokens | {"Token Creation"}
    features |= {"tag:" + t for t in card_tags}
    return sorted(index[f] for f in features if f in index)


def load_prices():
    """Cheapest current USD price (nonfoil, foil or etched) across all paper printings, by oracle_id."""
    prices = {}
    with gzip.open(PRINTINGS_FILE, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            c = json.loads(line)
            oracle_id = c.get("oracle_id") or (c.get("card_faces") or [{}])[0].get("oracle_id")
            p = c.get("prices") or {}
            usd = [float(v) for v in (p.get("usd"), p.get("usd_foil"), p.get("usd_etched")) if v]
            if oracle_id and usd and not c.get("digital"):
                prices[oracle_id] = min(prices.get(oracle_id, usd[0]), *usd)
    return prices


# === Step 4: Write the index ===
# The index is split so a search only downloads what it needs (site/index/):
#   meta.json      terms, card counts and tag names, for parsing queries (small, always loaded)
#   columns.json   per-card filter data: colors, types, mana value, formats, price
#   t/<term>.json  the cards with each term (one file per term, fetched when a query uses it)
#   c/<chunk>.json name + Scryfall id for each block of CHUNK cards, fetched to show results
#   names.json     all card names, only fetched for card-name searches
# Cards are in popularity order (EDHREC rank), so the top results sit in the first chunks.
OUT_DIR = os.path.join("site", "index")
CHUNK = 256
FILTER_TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Land", "Battle"]
NO_PRICE = -1


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def build_index(cards, updated, tags, prices):
    terms, keywords, categories = build_term_space(cards, tags)
    index = {t: i for i, t in enumerate(terms)}
    find_keywords = keyword_matcher(keywords)
    subtype_names = {t for t in terms if SUBTYPE_RE.match(t)}
    tags_by_card = {}
    for tag, (ids, _) in tags.items():
        for oracle_id in ids:
            tags_by_card.setdefault(oracle_id, []).append(tag)

    cards = sorted(cards, key=lambda c: (c.get("edhrec_rank") is None, c.get("edhrec_rank") or 0, c["name"]))
    postings = [[] for _ in terms]
    columns = {"identity": [], "types": [], "cmc": [], "legal": [], "price": []}
    for i, c in enumerate(cards):
        for t in vectorize_card(c, index, find_keywords, tags_by_card.get(c.get("oracle_id"), ()), subtype_names):
            postings[t].append(i)
        type_words = set(c.get("type_line", "").replace("//", " ").split())
        columns["identity"].append(sum(1 << j for j, color in enumerate("WUBRG") if color in c.get("color_identity", [])))
        columns["types"].append(sum(1 << j for j, t in enumerate(FILTER_TYPES) if t in type_words))
        cmc = c.get("cmc", 0)
        columns["cmc"].append(int(cmc) if cmc == int(cmc) else cmc)
        columns["legal"].append(sum(1 << j for j, f in enumerate(FORMATS)
                                    if c.get("legalities", {}).get(f) in ("legal", "restricted")))
        price = prices.get(c.get("oracle_id"))
        columns["price"].append(round(price * 100) if price is not None else NO_PRICE)  # cents

    if os.path.isdir(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    write_json(os.path.join(OUT_DIR, "meta.json"), {
        "updated": updated, "terms": terms, "formats": FORMATS, "types": FILTER_TYPES,
        "counts": [len(p) for p in postings],
        # Other names a tag goes by (label, community aliases), for matching queries
        "tag_names": {t: [n for n in tags[t[4:]][1] if n != t[4:]] for t in terms if t.startswith("tag:")},
        "categories": [[name, [index[t] for t in ts if t in index]] for name, ts in categories.items()],
    })
    write_json(os.path.join(OUT_DIR, "columns.json"), columns)
    write_json(os.path.join(OUT_DIR, "names.json"), [c["name"] for c in cards])
    for t, cards_with_term in enumerate(postings):
        # Gaps between card numbers are small numbers, which keeps the files short
        write_json(os.path.join(OUT_DIR, "t", f"{t}.json"), [b - a for a, b in zip([0] + cards_with_term, cards_with_term)])
    for k in range(0, len(cards), CHUNK):
        write_json(os.path.join(OUT_DIR, "c", f"{k // CHUNK}.json"), [[c["name"], c["id"]] for c in cards[k:k + CHUNK]])
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(OUT_DIR) for f in fs)
    print(f"Wrote {OUT_DIR}: {len(cards)} cards, {len(terms)} terms, {size / 1e6:.1f} MB in total")


if __name__ == "__main__":
    updated = download_bulk_data()
    build_index(load_cards(), updated, load_oracle_tags(), load_prices())
