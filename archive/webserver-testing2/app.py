from flask import Flask, render_template, request
import sqlite3
import json
import numpy as np
import requests

DB_FILE = "mtg_cards.db"
TERM_SPACE_FILE = "term_space.json"

app = Flask(__name__)

# Load Term Space
with open(TERM_SPACE_FILE, 'r') as f:
    TERM_SPACE = json.load(f)

def build_query_vector(features_requested):
    vector = [0] * len(TERM_SPACE)
    for feature in features_requested:
        if feature in TERM_SPACE:
            idx = TERM_SPACE.index(feature)
            vector[idx] = 1
    return np.array(vector)

def cosine_similarity(vec1, vec2):
    if not np.any(vec1) or not np.any(vec2):
        return 0.0
    return np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2))

def parse_natural_language(input_text):
    features = []
    text = input_text.lower()

    if any(phrase in text for phrase in ["gain life", "lifelink", "equal to life"]):
        features.append("Life Gain")
    if any(phrase in text for phrase in ["draw", "scry", "investigate", "loot"]):
        features.append("Card Advantage")
    if any(phrase in text for phrase in ["tap", "untap", "tap an untapped"]):
        features.append("Tap Effect")
    if any(phrase in text for phrase in ["deal damage", "deals damage", "burn"]):
        features.append("Direct Damage")
    if any(phrase in text for phrase in ["search your library for land", "add mana", "put a land", "mana fixing", "ramp"]):
        features.append("Mana Ramp")
    if any(phrase in text for phrase in ["reanimate", "return from graveyard", "raise dead"]):
        features.append("Graveyard Recursion")
    if any(phrase in text for phrase in ["discard a card", "opponent discards"]):
        features.append("Discard Effect")
    if any(phrase in text for phrase in ["counterspell", "counter target spell"]):
        features.append("Counter Effect")
    if any(phrase in text for phrase in ["destroy target creature", "destroy target permanent", "removal"]):
        features.append("Removal")
    if any(phrase in text for phrase in ["exile target", "exile all"]):
        features.append("Exile Effect")
    if any(phrase in text for phrase in ["return target to hand", "bounce"]):
        features.append("Bounce Effect")
    if any(phrase in text for phrase in ["board wipe", "destroy all creatures"]):
        features.append("Mass Removal")
    if any(phrase in text for phrase in ["fight another creature", "fights target"]):
        features.append("Fight Effect")
    if any(phrase in text for phrase in ["mill cards", "put top cards into graveyard"]):
        features.append("Mill Effect")
    if any(phrase in text for phrase in ["create a token", "create tokens"]):
        features.append("Token Creation")
    if any(phrase in text for phrase in ["destroy artifact", "exile artifact"]):
        features.append("Artifact Interaction")
    if any(phrase in text for phrase in ["destroy enchantment", "exile enchantment"]):
        features.append("Enchantment Interaction")
    if "landfall" in text:
        features.append("Landfall Effect")

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
            features.append(kw.title() if kw != "protection" else "Protection")

    color_map = {
        "white": "W", "blue": "U", "black": "B", "red": "R", "green": "G", "colorless": "Colorless"
    }
    for color_word, color_code in color_map.items():
        if color_word in text:
            features.append(color_code)

    types = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Planeswalker"]
    for t in types:
        if t.lower() in text:
            features.append(t)

    text_terms = {
        "draw": "draw",
        "destroy": "destroy",
        "counter": "counter target",
        "exile": "exile",
        "sacrifice": "sacrifice",
        "life gain": "life gain",
        "search your library": "search your library"
    }
    for word, mapped in text_terms.items():
        if word in text:
            features.append(mapped)

    if any(word in text for word in ["cheap", "small", "low mana", "cheap mana"]):
        features += ["CMC_0", "CMC_1", "CMC_2", "CMC_3"]
    if any(word in text for word in ["medium mana", "mid"]):
        features += ["CMC_4", "CMC_5"]
    if any(word in text for word in ["big", "expensive", "high mana"]):
        features += ["CMC_6", "CMC_7_plus"]

    features = list(set(features))
    valid_features = [feat for feat in features if feat in TERM_SPACE]

    return valid_features

def search_similar_cards(features_requested):
    query_vec = build_query_vector(features_requested)

    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    cur.execute("SELECT cards.name, cards.type_line, cards.cmc, card_vectors.vector FROM cards JOIN card_vectors ON cards.id = card_vectors.id")
    all_cards = cur.fetchall()

    results = []

    for name, type_line, cmc, vector_json in all_cards:
        card_vec = np.array(json.loads(vector_json))
        sim = cosine_similarity(query_vec, card_vec)
        if sim > 0:
            results.append((name, type_line, cmc, sim))

    conn.close()

    results.sort(key=lambda x: x[3], reverse=True)

    seen_names = set()
    final_results = []

    for name, type_line, cmc, sim in results:
        if name in seen_names:
            continue
        seen_names.add(name)

        final_results.append({
            "name": name,
            "type_line": type_line,
            "cmc": cmc,
            "similarity": round(sim, 4)
        })

    return final_results

@app.route("/", methods=["GET", "POST"])
def index():
    if request.method == "POST":
        user_query = request.form.get("query", "")
        print(f"[SEARCH RECEIVED] Query: {user_query}")
        features = parse_natural_language(user_query)
        if not features:
            return render_template("results.html", query=user_query, features=[], results=[], error="No recognizable features found.")
        results = search_similar_cards(features)
        return render_template("results.html", query=user_query, features=features, results=results, error=None)
    return render_template("index.html")

if __name__ == "__main__":
    app.run(debug=True)