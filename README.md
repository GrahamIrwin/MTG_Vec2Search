# MTG Vec2Search

Search Magic: The Gathering cards by describing them in plain English
("cheap white creature with flying and lifelink"). Cards and queries are
turned into feature vectors and ranked by cosine similarity.

## Setup

```
pip install flask numpy requests tqdm
python bulkCardDownload.py   # download card data + vectorize (~1 min)
python app.py                # http://127.0.0.1:5000
```

## Updating card data

When a new set comes out, re-run:

```
python bulkCardDownload.py
```

This downloads Scryfall's latest `oracle_cards` bulk file (one entry per unique
card), rebuilds `mtg_cards.db`, and recomputes every card vector. Generated data
files are git-ignored.

## Files

- `app.py`: Flask web app, with the query parser and similarity search
- `bulkCardDownload.py`: downloads data from Scryfall, then calls the vectorizer
- `vectorize2_Cards.py`: defines the feature space and turns each card into a vector
- `archive/`: earlier versions and experiments (subtype/artist term space, etc.)

Card data and images come from [Scryfall](https://scryfall.com). Magic: The
Gathering is © Wizards of the Coast. This project is unofficial Fan Content
and is not approved or endorsed by Wizards.
