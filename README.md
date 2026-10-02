# MTG Vec2Search

Search Magic: The Gathering cards by describing them in plain English
("cheap green elves that ramp"), with filters for color identity, card type,
mana value, and format. Dark mode by default. It's a static site: all the
heavy lifting happens at build time, and the browser just downloads a small
index (~2.4 MB gzipped) and searches it.

**Live site:** https://grahamirwin.github.io/MTG_Vec2Search/

## How it works

1. `build_index.py` downloads Scryfall's `oracle_cards` and `oracle_tags` bulk
   data and turns each card into a sparse binary vector over a term space:
   - colors, types, keywords, subtypes, rules-text terms, action concepts
     (removal, ramp, card advantage, …) and mana value
   - the tokens it makes ("create two 1/1 white Spirit creature tokens with
     flying" → makes white / Spirit / creature / flying tokens)
   - **oracle tags** from the community [Scryfall Tagger](https://tagger.scryfall.com)
     project, which describe what cards *do*: `tutor-instant`, `hate-nonbasic-land`,
     `removal-artifact`, `token-doubler`, … (~3,000 tags, with their aliases)

   Keywords, subtypes and tags come from the data itself, so new mechanics are
   picked up automatically. The output is `site/cards.json`.
2. In the browser, `site/search.js` maps the query to the same terms:
   - a tag matches when all its words (or an alias's) are in the query, after
     folding plurals, verb forms ("drawing" → draw) and a little slang
     ("punishes" → hate, "makes" → create, "steal" → theft, "non-basic" →
     nonbasic, "can't cast" → silence, "win the game" → win condition)
   - related tags form one group where the most specific gets full credit
     ("instant tutors": `tutor-instant` 100%, `tutor` 50%)
   - words that a tag uses describe its target, not the card ("**artifact** hate"
     isn't looking for artifacts)
   - after "makes"/"creates", words describe the token

   Cards are ranked by IDF-weighted query coverage, so rare features count for
   more than common ones. Ties go to the more popular card, by EDHREC rank.

## Updating card data

GitHub Actions rebuilds the index and redeploys every Monday. To update right
away (e.g. on a set's release day), open **Actions → Build and deploy → Run workflow**.

## Running locally

Python 3.11+ (standard library only):

```
python build_index.py              # download data + build site/cards.json (~1 min)
python -m http.server -d site      # http://localhost:8000
```

Tests: `python test_build_index.py` and `node --test` (Node 24).

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
