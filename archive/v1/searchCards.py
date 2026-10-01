import sqlite3
import json
import numpy as np
from tqdm import tqdm

# === Settings ===
DB_FILE = "mtg_cards.db"
TERM_SPACE_FILE = "term_space.json"

# === Functions ===

def load_term_space():
    with open(TERM_SPACE_FILE, 'r') as f:
        term_space = json.load(f)
    return term_space

def build_query_vector(term_space, features_requested):
    vector = [0] * len(term_space)
    for feature in features_requested:
        if feature in term_space:
            idx = term_space.index(feature)
            vector[idx] = 1
    return np.array(vector)

def cosine_similarity(vec1, vec2):
    if not np.any(vec1) or not np.any(vec2):
        return 0.0
    return np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2))

def parse_natural_language(input_text, term_space):
    features = []
    text = input_text.lower()

    # General Mapping
    keyword_matches = [
        "flying", "first strike", "double strike", "deathtouch", "defender", "haste", "hexproof",
        "indestructible", "lifelink", "menace", "reach", "trample", "vigilance", "ward",
        "cycling", "kicker", "prowess", "escape", "madness", "dash", "exploit", "eternalize",
        "aftermath", "convoke", "evolve", "persist", "undying", "delve", "rebound", "miracle",
        "embalm", "amass", "cascade", "encore", "dredge", "suspend", "buyback", "proliferate",
        "landfall", "heroic", "constellation", "ferocious", "morbid", "fateful hour", "revolt",
        "formidable", "pack tactics", "metalcraft", "hellbent", "threshold",
        "fear", "shroud", "protection", "banding", "rampage", "phasing"
    ]

    for kw in keyword_matches:
        if kw in text:
            features.append(kw.title() if kw != "protection" else "Protection")  # Maintain title case match

    # Colors
    color_map = {
        "white": "W", "blue": "U", "black": "B", "red": "R", "green": "G", "colorless": "Colorless"
    }
    for color_word, color_code in color_map.items():
        if color_word in text:
            features.append(color_code)

    # Types
    types = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Planeswalker"]
    for t in types:
        if t.lower() in text:
            features.append(t)

    # Special Text Actions
    text_terms = {
        "draw": "draw",
        "destroy": "destroy",
        "exile": "exile",
        "counter": "counter target",
        "sacrifice": "sacrifice",
        "life gain": "life gain",
        "gain life": "life gain",
        "search your library": "search your library",
    }
    for word, mapped in text_terms.items():
        if word in text:
            features.append(mapped)

    # CMC handling
    if any(word in text for word in ["cheap", "small", "low mana", "cheap mana"]):
        features += ["CMC_0", "CMC_1", "CMC_2", "CMC_3"]
    if any(word in text for word in ["medium mana", "mid"]):
        features += ["CMC_4", "CMC_5"]
    if any(word in text for word in ["big", "expensive", "high mana"]):
        features += ["CMC_6", "CMC_7_plus"]

    features = list(set(features))
    valid_features = [feat for feat in features if feat in term_space]

    return valid_features

def search_similar_cards(features_requested, top_n=10):
    term_space = load_term_space()
    query_vec = build_query_vector(term_space, features_requested)

    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    cur.execute("SELECT cards.name, cards.type_line, cards.cmc, card_vectors.vector FROM cards JOIN card_vectors ON cards.id = card_vectors.id")
    all_cards = cur.fetchall()

    results = []

    print(f"Comparing against {len(all_cards)} cards...")

    for name, type_line, cmc, vector_json in tqdm(all_cards):
        card_vec = np.array(json.loads(vector_json))
        sim = cosine_similarity(query_vec, card_vec)
        if sim > 0:
            results.append((name, type_line, cmc, sim))

    conn.close()

    results.sort(key=lambda x: x[3], reverse=True)

    seen_names = set()

    print(f"\nTop {top_n} unique matching cards:\n")
    count = 0

    for name, type_line, cmc, sim in results:
        if name in seen_names:
            continue  # skip duplicates
        seen_names.add(name)

        print(f"{name} | {type_line} | CMC {cmc} | Similarity {sim:.4f}")
        count += 1

        if count >= top_n:
            break


# === Main run ===
if __name__ == "__main__":
    print("\n=== MTG Natural Language Card Search Engine ===\n")
    print("Example: I want a cheap flying creature that draws cards")
    print("Type 'exit' to quit.\n")

    term_space = load_term_space()

    while True:
        user_input = input("Enter your search description: ").strip()

        if user_input.lower() in ("exit", "quit"):
            print("Goodbye!")
            break

        if not user_input:
            print("No input detected. Please enter a description.\n")
            continue

        features = parse_natural_language(user_input, term_space)

        if not features:
            print("No features recognized in your input. Please try more precise wording.\n")
            continue

        print(f"\nRecognized Features: {features}")
        search_similar_cards(features, top_n=10)
        print("\nReady for another search!\n")