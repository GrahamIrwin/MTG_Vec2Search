import json

# ===== Static Sections =====
COLORS = [
    "White", "Blue", "Black", "Red", "Green", "Colorless"
]

TYPES = [
    "Creature", "Instant", "Sorcery", "Artifact", "Enchantment",
    "Land", "Planeswalker", "Battle", "Legendary"
]

KEYWORDS = [
    "Flying", "Trample", "Haste", "Deathtouch", "Lifelink", "Menace",
    "First Strike", "Double Strike", "Reach", "Hexproof", "Indestructible",
    "Flash", "Vigilance", "Ward", "Equip", "Unearth", "Cascade", "Explore",
    "Mutate", "Prowess", "Protection", "Persist", "Modular"
]

ACTION_CONCEPTS = [
    "tap", "untap", "exile", "destroy", "counter", "draw", "mill", "return",
    "fight", "gain life", "lose life", "discard", "sacrifice", "transform",
    "create token", "search library", "shuffle", "add mana", "populate", "proliferate"
]

CMC_BUCKETS = ["CMC1", "CMC2", "CMC3", "CMC4", "CMC5", "CMC6+"]

# ===== Main Script =====
def generate_term_space(bulk_json_path="all_cards.json", term_output_path="term_space.json", artist_output_path="artists.json"):
    with open(bulk_json_path, "r", encoding="utf-8") as f:
        cards = json.load(f)

    all_subtypes = set()
    all_artists = set()

    for card in cards:
        # ===== Subtypes =====
        type_line = card.get("type_line", "")
        if "—" in type_line:
            try:
                subtype_part = type_line.split("—")[1]
                subtypes = [s.strip().lower() for s in subtype_part.split()]
                all_subtypes.update(subtypes)
            except:
                pass

        # ===== Artists =====
        artist = card.get("artist", "").strip().lower()
        if artist:
            all_artists.add(artist)

    # ===== Build Final Lists =====
    term_space = (
        COLORS +
        TYPES +
        KEYWORDS +
        sorted(all_subtypes) +
        ACTION_CONCEPTS +
        CMC_BUCKETS
    )

    term_space = sorted(set(term.lower() for term in term_space))
    artists = sorted(set(all_artists))

    # ===== Save Files =====
    with open(term_output_path, "w", encoding="utf-8") as f_term:
        json.dump(term_space, f_term, indent=2, ensure_ascii=False)

    with open(artist_output_path, "w", encoding="utf-8") as f_artist:
        json.dump(artists, f_artist, indent=2, ensure_ascii=False)

    print(f"Generated {term_output_path} ({len(term_space)} terms)")
    print(f"Generated {artist_output_path} ({len(artists)} artists)")

if __name__ == "__main__":
    generate_term_space()