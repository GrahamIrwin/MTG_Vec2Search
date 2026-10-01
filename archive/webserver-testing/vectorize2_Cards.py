import sqlite3
import json

# ===== Adjustable Weights =====
NAME_WEIGHT = 2
SUBTYPE_WEIGHT = 1
ORACLE_WEIGHT = 1
ARTIST_WEIGHT = 1
# ===============================

# ===== Load TERM_SPACE and ARTISTS =====
with open("term_space.json", "r", encoding="utf-8") as f:
    TERM_SPACE = json.load(f)

with open("artists.json", "r", encoding="utf-8") as f:
    ARTIST_TERMS = json.load(f)

def detect_action_concepts(text):
    actions = []
    text = text.lower()
    if "draw" in text: actions.append("draw")
    if "destroy" in text: actions.append("destroy")
    if "exile" in text: actions.append("exile")
    if "tap" in text: actions.append("tap")
    if "untap" in text: actions.append("untap")
    if "mill" in text: actions.append("mill")
    if "gain life" in text: actions.append("gain life")
    if "lose life" in text: actions.append("lose life")
    if "discard" in text: actions.append("discard")
    if "sacrifice" in text: actions.append("sacrifice")
    if "transform" in text: actions.append("transform")
    if "create token" in text: actions.append("create token")
    if "search library" in text: actions.append("search library")
    if "shuffle" in text: actions.append("shuffle")
    if "add mana" in text: actions.append("add mana")
    return actions

def determine_cmc_bucket(cmc):
    if cmc <= 1:
        return "CMC1"
    elif cmc == 2:
        return "CMC2"
    elif cmc == 3:
        return "CMC3"
    elif cmc == 4:
        return "CMC4"
    elif cmc == 5:
        return "CMC5"
    else:
        return "CMC6+"

def vectorize_card(card):
    vector = [0] * (len(TERM_SPACE) + len(ARTIST_TERMS))

    colors = card["colors"].split(",") if card["colors"] else []
    type_line = card["type_line"]
    keywords = card["keywords"].split(",") if card["keywords"] else []
    oracle_text = card["oracle_text"].lower() if card["oracle_text"] else ""
    cmc = card["cmc"]
    name = card["name"].lower() if card["name"] else ""
    artist = card["artist"].lower() if card["artist"] else ""

    # Subtypes
    subtypes = []
    if "—" in type_line:
        try:
            subtype_part = type_line.split("—")[1]
            subtypes = [s.strip().lower() for s in subtype_part.split()]
        except:
            pass

    # Combine weighted text
    combined_text = (
        (name + " ") * NAME_WEIGHT +
        (" ".join(subtypes) + " ") * SUBTYPE_WEIGHT +
        (oracle_text + " ") * ORACLE_WEIGHT +
        (artist + " ") * ARTIST_WEIGHT
    )

    # ===== Match against TERM_SPACE =====
    for idx, term in enumerate(TERM_SPACE):
        if term.lower() in combined_text:
            vector[idx] = 1

    # ===== Match against ARTIST_TERMS =====
    for idx, artist_term in enumerate(ARTIST_TERMS, start=len(TERM_SPACE)):
        if artist_term.lower() in artist:
            vector[idx] = 1

    # ===== Action Concepts =====
    action_concepts = detect_action_concepts(oracle_text)
    for action in action_concepts:
        if action in TERM_SPACE:
            idx = TERM_SPACE.index(action)
            vector[idx] = 1

    # ===== CMC Buckets =====
    cmc_bucket = determine_cmc_bucket(cmc)
    if cmc_bucket in TERM_SPACE:
        idx = TERM_SPACE.index(cmc_bucket)
        vector[idx] = 1

    return vector

def create_vector_database(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Create card_vectors table if it doesn't exist
    cur.execute('''
        CREATE TABLE IF NOT EXISTS card_vectors (
            id TEXT PRIMARY KEY,
            vector TEXT
        )
    ''')

    cur.execute("SELECT id, name, colors, color_identity, cmc, type_line, keywords, oracle_text, artist FROM cards")
    rows = cur.fetchall()

    count = 0
    for row in rows:
        card_id = row["id"]
        card_vector = vectorize_card(row)
        vector_string = ",".join(map(str, card_vector))

        cur.execute('''
            INSERT OR REPLACE INTO card_vectors (id, vector)
            VALUES (?, ?)
        ''', (card_id, vector_string))
        count += 1

    conn.commit()
    conn.close()
    print(f"Inserted {count} vectors into {db_path}")

if __name__ == "__main__":
    db_path = "cards.db"
    create_vector_database(db_path)