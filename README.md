# MTG Vec2Search

Search Magic: The Gathering cards by describing them in plain English
("cheap green elves that ramp"), with filters for color identity, card type,
mana value, and format. It's a static site, and the search runs in your browser.

**Live site:** https://grahamirwin.github.io/MTG_Vec2Search/

## How it works

1. `build_index.py` downloads Scryfall's `oracle_cards` bulk data (one entry per
   unique card) and turns each card into a sparse binary vector over a term
   space: colors, types, keywords, subtypes, rules-text terms, action concepts
   (removal, ramp, card advantage, …) and mana value. Keywords and subtypes come
   from the data itself, so new mechanics are picked up automatically. The
   output is `site/cards.json`.
2. In the browser, `site/search.js` maps the query to the same terms and ranks
   cards by IDF-weighted query coverage, so rare features count for more than
   common ones. Ties go to the more popular card, by EDHREC rank.

## Updating card data

GitHub Actions rebuilds the index and redeploys every Monday. To update right
away (e.g. on a set's release day), open **Actions → Build and deploy → Run workflow**.

## Running locally

Python 3.11+ (standard library only):

```
python build_index.py              # download data + build site/cards.json (~1 min)
python -m http.server -d site      # http://localhost:8000
```

Tests: `python test_build_index.py` and `node --test`.

## Files

- `build_index.py`: downloads data from Scryfall, vectorizes the cards, writes the index
- `site/index.html`, `site/app.js`: the page
- `site/search.js`: query parsing and ranking
- `.github/workflows/deploy.yml`: weekly rebuild and GitHub Pages deploy
- `archive/`: earlier versions, including the original Flask app

Card data and images come from [Scryfall](https://scryfall.com). MTG Vec2Search is
unofficial Fan Content permitted under the Fan Content Policy. Not
approved/endorsed by Wizards. Portions of the materials used are property of
Wizards of the Coast. ©Wizards of the Coast LLC.
