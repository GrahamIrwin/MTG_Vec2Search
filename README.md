# MTG Vec2Search

Search Magic: The Gathering cards by describing them in plain English
("cheap green elves that ramp"), with filters for color identity, card type,
mana value, format and price. Or paste a Commander deck (a Moxfield or
Archidekt link, or a decklist) to see which cards similar decks play that
yours doesn't. Dark mode by
default. It's a static site: all the heavy lifting happens at build time, and a
search only downloads the small pieces of the index it needs (~200 KB the first
time, a few KB after that).

**Live site:** https://grahamirwin.github.io/MTG_Vec2Search/

## How it works

1. `build_index.py` downloads Scryfall's `oracle_cards`, `oracle_tags` and
   `default_cards` (every printing, for the cheapest price) bulk data and turns
   each card into a sparse binary vector over a term space:
   - colors, types, keywords, subtypes and mana value
   - the tokens it makes ("create two 1/1 white Spirit creature tokens with
     flying" → makes white / Spirit / creature / flying tokens)
   - **oracle tags** from the community [Scryfall Tagger](https://tagger.scryfall.com)
     project, which describe what cards *do*: `tutor-instant`, `hate-nonbasic-land`,
     `removal-artifact`, `token-doubler`, … (~3,000 tags, with their aliases)

   Keywords, subtypes and tags come from the data itself, so new mechanics are
   picked up automatically. The output, `site/index/`, is split so a search
   only fetches what it uses:
   - `meta.json`: the terms, card counts and tag aliases (for parsing queries)
   - `columns.json`: per-card colors, types, mana value, formats and price (for filters)
   - `t/<term>.json`: which cards have each term (only the query's terms are fetched)
   - `c/<chunk>.json`: names and image ids, 256 cards each; cards are in
     popularity order, so top results come from the first few chunks
   - `names.json`, `released.json`: names and first-release dates, only fetched
     for card-name searches and the name/date sorts
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
   "under $5", "less than 3 euros" or "budget" (under US$1) in a query sets
   the price limit; prices are each card's cheapest printing.

   Prices are shown in the visitor's currency: guessed from their time zone
   (then browser language), changeable in the top corner, and converted from
   Scryfall's USD prices with [Frankfurter](https://frankfurter.dev).

   **Sort by** reorders results by best match, popularity, release date (first
   printing), price or mana value. Sorted by anything but match, only cards at
   least 75% as good a match as the best one are kept.

   **Browse all search terms** on the page lists every term with its card count.
3. **Deck recommendations** compares a Commander deck with public decks from
   [Archidekt](https://archidekt.com):
   - `build_decks.py crawl` downloads decks through Archidekt's API (one request a
     second) into `decks.jsonl.gz`: each deck's commanders and cards, by Scryfall
     oracle id. It takes the recently updated decks first, then takes turns
     through every commander it has seen, least recently crawled first.
   - `build_decks.py build` writes `site/decks/`: one file per commander (or
     partner pair) with its newest 3,000 decks. Each deck is stored as positions
     in that commander's list of cards, most played first, gap-encoded like the
     card index, which comes to about 100 bytes per deck over the wire.
     `index.json` lists every commander with its "signature" cards, the ones
     its decks play far more often than other decks do.
   - In the browser (`site/deck.js`), decks are compared by cosine similarity
     over the cards they play, each weighted by how rare it is among that
     commander's decks (IDF), so Sol Ring and Command Tower count for almost
     nothing. The 25 most similar decks vote on **cards to consider**, by
     similarity, minus half of how often any deck with that commander plays the
     card, so the list is what decks like yours play more than usual rather than
     staples. **Cards to reconsider** are yours that similar decks rarely play.
   - A pasted Moxfield or Archidekt link is read by `worker/deck-link.js`, a
     small Cloudflare Worker: neither site's API can be called from another
     site's page (CORS). It fetches just that one deck and returns it as a
     plain decklist. A link also goes in the address bar (`?deck=<link>`), so
     results can be shared.
   - A commander with too few decks is compared with the commander whose
     signature cards the deck plays the most of. That same match powers "decks
     like yours with other commanders".

   Card-overlap similarity was checked against a "functional" similarity over
   the search terms above (tags, keywords, types) by hiding 10 cards of real
   decks and recommending them back. Card overlap alone did best (about 39% of
   hidden cards in the top 20, against 31% for "most played with this
   commander"), so that's all the browser computes.

## Updating card data

GitHub Actions rebuilds the index and redeploys every Monday. To update right
away (e.g. on a set's release day), open **Actions → Build and deploy → Run workflow**.

The deck corpus is too big for git, so it lives on the `deck-corpus` release.
**Actions → Crawl decks** adds to it for five hours every Sunday. To grow it
faster, crawl locally and upload:

```
gh release download deck-corpus             # decks.jsonl.gz, crawl_state.json
python build_decks.py crawl --hours 24      # stop with Ctrl+C and resume any time
gh release upload deck-corpus decks.jsonl.gz crawl_state.json --clobber
```

## The deck link Worker

Deploy it once to a free Cloudflare account, then put the URL it prints in
`DECK_LINK` in `site/app.js`:

```
cd worker
npx wrangler login
npx wrangler deploy
```

It only answers the site (and localhost, for testing), and only fetches Moxfield and
Archidekt deck pages, one per request, cached for 10 minutes.

## Running locally

Python 3.11+ (standard library only):

```
python build_index.py              # download data + build site/index/ (~1 min)
gh release download deck-corpus --pattern decks.jsonl.gz
python build_decks.py build        # site/decks/, for Find similar decks
python -m http.server -d site      # http://localhost:8000
```

Tests: `python test_build_index.py`, `python test_build_decks.py` and `node --test` (Node 24).

## Files

- `build_index.py`: downloads data from Scryfall, vectorizes the cards, writes the index
- `build_decks.py`: crawls Archidekt decks, writes the per-commander deck files
- `site/index.html`, `site/app.js`: the page
- `site/search.js`: query parsing and ranking
- `site/deck.js`: decklist parsing, similar decks and recommendations
- `worker/deck-link.js`: Cloudflare Worker that turns a deck link into a decklist
- `site/currency.js`: currency detection, exchange rate and price formatting
- `.github/workflows/deploy.yml`: weekly rebuild and GitHub Pages deploy
- `.github/workflows/crawl.yml`: weekly deck crawl

Card data and images come from [Scryfall](https://scryfall.com), decklists from
[Archidekt](https://archidekt.com). MTG Vec2Search is
unofficial Fan Content permitted under the Fan Content Policy. Not
approved/endorsed by Wizards. Portions of the materials used are property of
Wizards of the Coast. ©Wizards of the Coast LLC.
