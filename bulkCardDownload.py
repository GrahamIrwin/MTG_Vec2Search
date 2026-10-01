"""Download the latest Scryfall card data, rebuild mtg_cards.db, and revectorize.

Run this whenever a new set comes out:  python bulkCardDownload.py
"""
import requests
import json
import gzip
import sqlite3
import os
from tqdm import tqdm
from vectorize2_Cards import vectorize_db

# === Settings ===
SCRYFALL_BULK_LIST_URL = "https://api.scryfall.com/bulk-data"
# oracle_cards = one entry per unique card (vs. default_cards = every printing)
BULK_TYPE = "oracle_cards"
BULK_FILE = "oracle_cards.jsonl.gz"
DB_FILE = "mtg_cards.db"
# Scryfall requires a User-Agent and Accept header on API requests
HEADERS = {"User-Agent": "MTG_Vec2Search/1.0", "Accept": "application/json;q=0.9,*/*;q=0.8"}
SKIP_LAYOUTS = ['token', 'double_faced_token', 'emblem', 'art_series', 'augment', 'host',
                'planar', 'scheme', 'vanguard']

# === Step 1: Download the bulk card data ===
def download_bulk_data():
    print("Fetching bulk data list from Scryfall...")
    resp = requests.get(SCRYFALL_BULK_LIST_URL, headers=HEADERS)
    resp.raise_for_status()
    bulk_list = resp.json()

    bulk_uri = None
    for item in bulk_list['data']:
        if item['type'] == BULK_TYPE:
            bulk_uri = item['jsonl_download_uri']
            print(f"Scryfall data last updated: {item['updated_at']}")
            break

    if not bulk_uri:
        raise ValueError(f"Could not find '{BULK_TYPE}' bulk file.")

    print(f"Downloading card data from {bulk_uri}...")
    with requests.get(bulk_uri, headers=HEADERS, stream=True) as r:
        r.raise_for_status()
        with open(BULK_FILE, 'wb') as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
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
    print("Processing cards...")
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    with gzip.open(BULK_FILE, 'rt', encoding='utf-8') as f:
        all_cards = [json.loads(line) for line in f if line.strip()]

    for card in tqdm(all_cards):
        # Skip digital-only cards, tokens, and non-traditional cards
        if card.get('digital', False):
            continue
        if card.get('layout') in SKIP_LAYOUTS:
            continue
        if not card.get('id'):
            continue

        # Double-faced/split cards keep colors and rules text on their faces
        faces = card.get('card_faces', [])
        card_id = card['id']
        name = card.get('name', '')
        colors = ','.join(card.get('colors') or sorted({c for f in faces for c in f.get('colors', [])}))
        color_identity = ','.join(card.get('color_identity', []))
        cmc = card.get('cmc', 0)
        type_line = card.get('type_line', '')
        keywords = ','.join(card.get('keywords', []))
        oracle_text = card.get('oracle_text') or '\n'.join(f.get('oracle_text', '') for f in faces)

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
    vectorize_db()
    print("\n✅ Card data downloaded and vectorized!\n")
