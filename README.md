# MTG Vec2Search

Search Magic: The Gathering cards by describing them in plain English
("cheap green elves that ramp"), with filters for color identity, card type,
mana value, and format, plus an optional semantic "smart search". Dark mode
by default. It's a static site, and the search runs in your browser.

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
3. **Smart search** (opt-in) handles descriptions the term space can't express,
   like "copy a spell" or "opponents can't cast spells during my turn".
   `embed_cards.mjs` embeds each card's type line and rules text with
   [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) and writes
   `site/embeddings.bin` (int8, 12.7 MB). The browser runs the same model with
   [transformers.js](https://huggingface.co/docs/transformers.js) to embed the
   query. Results are ranked by semantic similarity, plus small boosts for
   matching parsed features (so slang like "board wipe" still works) and for
   popularity. The model (~23 MB) and vectors only download when smart search
   is used, and the browser caches them after that.

   `bakeoff/` has the scripts used to choose the model and tune the weights.

## Updating card data

GitHub Actions rebuilds the index and redeploys every Monday. To update right
away (e.g. on a set's release day), open **Actions → Build and deploy → Run workflow**.

## Running locally

Python 3.11+ (standard library only) and Node 24:

```
python build_index.py              # download data + build site/cards.json (~1 min)
npm ci
node embed_cards.mjs               # smart search vectors (reuses the live site's; ~15 min from scratch)
python -m http.server -d site      # http://localhost:8000
```

Tests: `python test_build_index.py` and `node --test`.

## Files

- `build_index.py`: downloads data from Scryfall, vectorizes the cards, writes the index
- `site/index.html`, `site/app.js`: the page
- `site/search.js`: query parsing and ranking (regular and smart)
- `embed_cards.mjs`: smart search card embeddings
- `.github/workflows/deploy.yml`: weekly rebuild and GitHub Pages deploy
- `archive/`: earlier versions, including the original Flask app

Card data and images come from [Scryfall](https://scryfall.com). MTG Vec2Search is
unofficial Fan Content permitted under the Fan Content Policy. Not
approved/endorsed by Wizards. Portions of the materials used are property of
Wizards of the Coast. ©Wizards of the Coast LLC.
