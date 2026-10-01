import sqlite3
import json

def create_database(db_name="cards.db"):
    conn = sqlite3.connect(db_name)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS cards (
            id TEXT PRIMARY KEY,
            name TEXT,
            colors TEXT,
            color_identity TEXT,
            cmc REAL,
            type_line TEXT,
            keywords TEXT,
            oracle_text TEXT,
            artist TEXT
        )
    ''')
    conn.commit()
    conn.close()

def populate_database(json_file, db_name="cards.db"):
    conn = sqlite3.connect(db_name)
    c = conn.cursor()

    with open(json_file, "r", encoding="utf-8") as f:
        cards = json.load(f)

    for card in cards:
        card_id = card.get("id")
        name = card.get("name", "")
        colors = ",".join(card.get("colors", []))
        color_identity = ",".join(card.get("color_identity", []))
        cmc = card.get("cmc", 0)
        type_line = card.get("type_line", "")
        keywords = ",".join(card.get("keywords", []))
        oracle_text = card.get("oracle_text", "")
        artist = card.get("artist", "")

        c.execute('''
            INSERT OR IGNORE INTO cards
            (id, name, colors, color_identity, cmc, type_line, keywords, oracle_text, artist)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (card_id, name, colors, color_identity, cmc, type_line, keywords, oracle_text, artist))

    conn.commit()
    conn.close()

if __name__ == "__main__":
    create_database()
    populate_database("all_cards.json")  # Your downloaded Scryfall JSON file