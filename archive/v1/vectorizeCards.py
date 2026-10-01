import sqlite3
import json
import os
from tqdm import tqdm

# === Settings ===
DB_FILE = "mtg_cards.db"
TERM_SPACE_FILE = "term_space.json"

# Define term space
COLORS = ["W", "U", "B", "R", "G", "Colorless"]
TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Planeswalker"]

KEYWORDS = [
    # Evergreen Keywords
    "Flying", "First Strike", "Double Strike", "Deathtouch", "Defender", "Haste", "Hexproof",
    "Indestructible", "Lifelink", "Menace", "Reach", "Trample", "Vigilance", "Ward",

    # Set Mechanics (Expert Level)
    "Cycling", "Kicker", "Prowess", "Escape", "Madness", "Dash", "Exploit", "Eternalize",
    "Aftermath", "Convoke", "Evolve", "Persist", "Undying", "Delve", "Rebound", "Miracle",
    "Embalm", "Amass", "Cascade", "Encore", "Dredge", "Suspend", "Buyback", "Proliferate",

    # Ability Words
    "Landfall", "Heroic", "Constellation", "Ferocious", "Morbid", "Fateful hour", "Revolt",
    "Formidable", "Pack tactics", "Metalcraft", "Hellbent", "Threshold",

    # Discontinued Keywords
    "Fear", "Shroud", "Protection", "Banding", "Rampage", "Phasing"
]

TEXT_TERMS = [
    "draw", "destroy", "counter target", "exile", "sacrifice", "life gain", "search your library"
]

CMC_BUCKETS = ["CMC_0", "CMC_1", "CMC_2", "CMC_3", "CMC_4", "CMC_5", "CMC_6", "CMC_7_plus"]

TERM_SPACE = COLORS + TYPES + KEYWORDS + TEXT_TERMS + CMC_BUCKETS

# === Functions ===

def determine_cmc_bucket(cmc):
    if cmc == 0:
        return "CMC_0"
    elif cmc == 1:
        return "CMC_1"
    elif cmc == 2:
        return "CMC_2"
    elif cmc == 3:
        return "CMC_3"
    elif cmc == 4:
        return "CMC_4"
    elif cmc == 5:
        return "CMC_5"
    elif cmc == 6:
        return "CMC_6"
    else:
        return "CMC_7_plus"

def vectorize_card(card):
    vector = [0] * len(TERM_SPACE)

    colors = card["colors"].split(",") if card["colors"] else []
    color_identity = card["color_identity"].split(",") if card["color_identity"] else []
    type_line = card["type_line"]
    keywords = card["keywords"].split(",") if card["keywords"] else []
    oracle_text = card["oracle_text"].lower()
    cmc = card["cmc"]

    # Handle Colors
    if not colors and not color_identity:
        color_flags = ["Colorless"]
    else:
        color_flags = colors

    for color in color_flags:
        if color in COLORS:
            idx = TERM_SPACE.index(color)
            vector[idx] = 1

    # Handle Types
    for t in TYPES:
        if t in type_line:
            idx = TERM_SPACE.index(t)
            vector[idx] = 1

    # Handle Keywords and Ability Words
    for kw in KEYWORDS:
        if kw.lower() in keywords or kw.lower() in oracle_text:
            idx = TERM_SPACE.index(kw)
            vector[idx] = 1

    # Handle Text Terms
    for term in TEXT_TERMS:
        if term in oracle_text:
            idx = TERM_SPACE.index(term)
            vector[idx] = 1

    # Handle CMC Buckets
    cmc_bucket = determine_cmc_bucket(cmc)
    idx = TERM_SPACE.index(cmc_bucket)
    vector[idx] = 1

    return vector

# === Main Process ===
if __name__ == "__main__":
    if not os.path.exists(DB_FILE):
        print(f"Database {DB_FILE} not found! Run Step 1 first.")
        exit(1)

    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    # Create card_vectors table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS card_vectors (
            id TEXT PRIMARY KEY,
            vector TEXT
        )
    """)

    # Load all cards
    cur.execute("SELECT id, colors, color_identity, cmc, type_line, keywords, oracle_text FROM cards")
    cards = cur.fetchall()

    print(f"Vectorizing {len(cards)} cards...")

    for card in tqdm(cards):
        card_obj = {
            "id": card[0],
            "colors": card[1],
            "color_identity": card[2],
            "cmc": card[3],
            "type_line": card[4],
            "keywords": card[5],
            "oracle_text": card[6]
        }

        vector = vectorize_card(card_obj)

        cur.execute("""
            INSERT OR REPLACE INTO card_vectors (id, vector)
            VALUES (?, ?)
        """, (card_obj["id"], json.dumps(vector)))

    conn.commit()
    conn.close()

    # Save the term space for later lookup
    with open(TERM_SPACE_FILE, 'w') as f:
        json.dump(TERM_SPACE, f, indent=2)

    print("\nVectors saved.")
