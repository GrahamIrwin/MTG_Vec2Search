import requests
import json
import sqlite3
import os
from tqdm import tqdm

# === Settings ===
SCRYFALL_BULK_LIST_URL = "https://api.scryfall.com/bulk-data"
BULK_FILE = "all_cards.json"
DB_FILE = "mtg_cards.db"

# === Step 1: Download the bulk card data ===
def download_bulk_data():
    print("Fetching bulk data list from Scryfall...")
    resp = requests.get(SCRYFALL_BULK_LIST_URL)
    resp.raise_for_status()
    bulk_list = resp.json()

    default_cards_uri = None
    for item in bulk_list['data']:
        if item['type'] == 'default_cards':
            default_cards_uri = item['download_uri']
            break

    if not default_cards_uri:
        raise ValueError("Could not find 'default_cards' bulk file.")

    print(f"Downloading card data from {default_cards_uri}...")
    with requests.get(default_cards_uri, stream=True) as r:
        r.raise_for_status()
        with open(BULK_FILE, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)

    print(f"Saved bulk file as {BULK_FILE}")

# === Step 2: Prepare the database ===
def prepare_database():
    if os.path.exists(DB_FILE):
        os.remove(DB_FILE)

    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute('''
        CREATE TABLE cards (
            id TEXT PRIMARY KEY,
            name TEXT,
            colors TEXT,
            color_identity TEXT,
            cmc REAL,
            type_line TEXT,
            keywords TEXT,
            oracle_text TEXT
        )
    ''')
    conn.commit()
    conn.close()

# === Step 3: Insert cards into the database ===
def insert_cards():
    print("Loading JSON data...")
    with open(BULK_FILE, 'r', encoding='utf-8') as f:
        all_cards = json.load(f)

    print(f"Processing {len(all_cards)} cards...")

    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    for card in tqdm(all_cards):
        # Skip digital-only cards, tokens, and duplicates
        if card.get('digital', False):
            continue
        if card.get('layout') in ['token', 'emblem', 'art_series', 'augment', 'host']:
            continue
        if not card.get('id'):
            continue

        card_id = card['id']
        name = card.get('name', '')
        colors = ','.join(card.get('colors', []))
        color_identity = ','.join(card.get('color_identity', []))
        cmc = card.get('cmc', 0)
        type_line = card.get('type_line', '')
        keywords = ','.join(card.get('keywords', []))
        oracle_text = card.get('oracle_text', '')

        cur.execute('''
            INSERT OR REPLACE INTO cards (id, name, colors, color_identity, cmc, type_line, keywords, oracle_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (card_id, name, colors, color_identity, cmc, type_line, keywords, oracle_text))

    conn.commit()
    conn.close()
    print(f"Inserted processed cards into {DB_FILE}")

# === Main run ===
if __name__ == "__main__":
    download_bulk_data()
    prepare_database()
    insert_cards()
    print("\n✅ Step 1 complete!\n")
