// The numbers behind the README's figures, worked out by the site's own code (site/search.js,
// site/deck.js) from the locally built site/ data. Prints JSON; make_figures.py reads it.
//   node docs/figures/site_data.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const site = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "site");
const read = file => JSON.parse(fs.readFileSync(path.join(site, file)));
const { parseQuery, buildIndex, search, decodePosting, termsNeeded } = await import(pathToFileURL(path.join(site, "search.js")));
const { decodeShard, findBuilds, buildTags, cardResults, similarDecks, recommend, STAPLE_DISCOUNT, PRIOR_GAMES } = await import(pathToFileURL(path.join(site, "deck.js")));

const meta = read("index/meta.json");
const names = read("index/names.json");
const index = buildIndex(meta, read("index/columns.json"));

// The search example: the query's groups, their weights, and how much of it a few cards cover
const QUERY = "cheap green elves that ramp";
const parsed = parseQuery(QUERY, index);
const groups = parsed.groups ?? parsed;
const postings = new Map(termsNeeded(index, groups).map(t => [t, new Set(decodePosting(read(`index/t/${t}.json`)))]));
const has = (card, g) => g.some(o => postings.get(index.termIndex.get(o.term))?.has(card));
const scores = new Map(search(index, groups, postings).map(r => [r.card, r.score]));
const weightOf = g => Math.max(...g.map(o => index.weight[index.termIndex.get(o.term)]));
const searchExample = {
  query: QUERY, cards: index.n,
  groups: groups.map(g => ({ terms: g.map(o => o.term), weight: weightOf(g),
    cardsWith: Math.max(...g.map(o => meta.counts[index.termIndex.get(o.term)])) })),
  examples: ["Llanowar Elves", "Elvish Visionary", "Cultivate", "Sol Ring"].map(name => {
    const card = names.indexOf(name);
    return { name, score: scores.get(card) ?? 0, covers: groups.map(g => has(card, g)) };
  }),
};

// Derevi, Empyrial Tactician: its builds, how much each card weighs, and public decks against top-cut ones
const KEY = String(names.indexOf("Derevi, Empyrial Tactician")); // card numbers change as Scryfall's list grows
const shard = decodeShard(read(`decks/${KEY}.json`));
const n = shard.decks.length;
const landBit = 1 << index.types.indexOf("Land");
const lands = new Set(shard.cards.flatMap((c, p) => (index.columns.types[c] & landBit ? [p] : [])));
const label = tag => { const s = tag.replaceAll("-", " "); return s[0].toUpperCase() + s.slice(1); };
const named = new Set();
const builds = findBuilds(shard, { ignore: lands }).map(members => {
  const tag = buildTags(shard, members).find(t => !named.has(t));
  named.add(tag);
  return { name: tag ? label(tag) : "Other", members };
});

const lists = read(`decks/results/lists/${KEY}.json`);
const topCut = lists.decks.filter(d => d[3] === 2).map(d => { let p = 0; return d.slice(4).map(g => lists.cards[p += g]); });
const topPlays = new Map();
for (const deck of topCut) for (const c of deck) topPlays.set(c, (topPlays.get(c) ?? 0) + 1);

// Recommendations for one of its decks, matched with the others: the first deck whose closest other
// deck is 60–85% alike (not a near-copy of it)
let example;
for (const deck of shard.decks) {
  const mine = [...deck.cards].map(p => shard.cards[p]);
  const similar = similarDecks(shard, mine).filter(r => r.deck !== deck);
  if (similar[0].similarity < 0.6 || similar[0].similarity > 0.85) continue;
  const { adds, neighbors } = recommend(shard, similar, mine);
  example = {
    cards: mine.length, neighbors, closest: similar.slice(0, 5).map(r => ({ similarity: r.similarity, shared: r.shared })),
    adds: adds.slice(0, 12).map(a => ({ name: names[a.card], share: a.share, decks: a.decks,
      everywhere: shard.plays[shard.position.get(a.card)] / n, score: a.score })),
  };
  break;
}

const results = read(`decks/results/${KEY}.json`);
const w = results.windows.length - 1;
const [, games, wins] = results.totals[w];

console.log(JSON.stringify({
  search: searchExample,
  commander: {
    name: names[+KEY], decks: n, topCutDecks: topCut.length,
    // each deck's cards (positions in cards), for the map of builds, and which are lands
    cards: shard.cards.map((c, p) => ({ name: names[c], popularity: c, plays: shard.plays[p], land: lands.has(p),
      topCut: topPlays.get(c) ?? 0 })),
    deckCards: shard.decks.map(d => [...d.cards]),
    builds: builds.map(b => ({ name: b.name, members: b.members })),
    rate: wins / games, games, priorGames: PRIOR_GAMES,
    tested: cardResults(results, w).length,
    example, discount: STAPLE_DISCOUNT,
  },
}));
