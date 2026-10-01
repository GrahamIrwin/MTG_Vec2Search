import json

with open("artists.json", "r", encoding="utf-8") as f:
    data = json.load(f)

print(f"Successfully loaded {len(data)} artists.")
