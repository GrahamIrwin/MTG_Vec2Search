// Query parsing and ranking. Pure functions, tested by search.test.mjs (node --test).

// Plain-English phrases that map to the action concepts detected in card text
const ACTION_PHRASES = {
  "Life Gain": ["gain life", "lifelink", "equal to life"],
  "Card Advantage": ["draw", "scry", "investigate", "loot"],
  "Tap Effect": ["tap", "untap", "tap an untapped"],
  "Direct Damage": ["deal damage", "deals damage", "burn", "damage"],
  "Mana Ramp": ["search your library for land", "add mana", "put a land", "mana fixing", "ramp", "mana dork", "mana rock"],
  "Graveyard Recursion": ["reanimate", "return from graveyard", "raise dead", "recursion"],
  "Discard Effect": ["discard a card", "opponent discards", "discard"],
  "Counter Effect": ["counterspell", "counter target spell"],
  "Removal": ["destroy target creature", "destroy target permanent", "removal", "kill spell"],
  "Exile Effect": ["exile target", "exile all"],
  "Bounce Effect": ["return target to hand", "bounce"],
  "Mass Removal": ["board wipe", "wrath", "sweeper", "destroy all creatures"],
  "Fight Effect": ["fight another creature", "fights target"],
  "Mill Effect": ["mill cards", "put top cards into graveyard"],
  "Token Creation": ["create a token", "create tokens", "token maker"],
  "Artifact Interaction": ["destroy artifact", "exile artifact"],
  "Enchantment Interaction": ["destroy enchantment", "exile enchantment"],
  "Landfall Effect": ["landfall"],
};
const COLOR_WORDS = { white: "W", blue: "U", black: "B", red: "R", green: "G", colorless: "Colorless" };
const CMC_WORDS = [
  [["cheap", "small", "low mana", "low cost"], ["CMC_0", "CMC_1", "CMC_2", "CMC_3"]],
  [["medium mana", "mid"], ["CMC_4", "CMC_5"]],
  [["big", "expensive", "high mana"], ["CMC_6", "CMC_7_plus"]],
];

// Whole-word/phrase match that also accepts plurals: "dragons", "elves", "wolves"
function has(text, phrase) {
  let p = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (p.endsWith("f")) p = `(?:${p}|${p.slice(0, -1)}ve)`;
  return new RegExp(`(?<![\\w'-])${p}(?:s|es)?(?![\\w'-])`).test(text);
}

// Returns the terms (feature names) recognized in a plain-English query
export function parseQuery(query, terms) {
  const text = query.toLowerCase();
  const found = new Set();
  for (const [concept, phrases] of Object.entries(ACTION_PHRASES)) {
    if (phrases.some(p => has(text, p))) found.add(concept);
  }
  for (const [word, code] of Object.entries(COLOR_WORDS)) if (has(text, word)) found.add(code);
  for (const [words, buckets] of CMC_WORDS) {
    if (words.some(w => has(text, w))) buckets.forEach(b => found.add(b));
  }
  // Types, keywords, subtypes and text terms match by name
  for (const t of terms) {
    if (t.length > 1 && !t.startsWith("CMC_") && has(text, t)) found.add(t);
  }
  return terms.filter(t => found.has(t));
}

const BITS = 7;

// Turns cards.json into searchable card objects, with IDF weights so rare
// features (e.g. "Rebound") count for more than common ones (e.g. "Creature").
export function buildIndex(data) {
  const n = data.cards.length;
  const df = new Float64Array(data.terms.length);
  for (const c of data.cards) for (const b of c[BITS]) df[b]++;
  const weight = Array.from(df, d => (d ? (1 + Math.log(n / d)) ** 2 : 0));
  const termIndex = new Map(data.terms.map((t, i) => [t, i]));
  const cards = data.cards.map(([name, type, cmc, id, identity, legal, rank, bits]) => ({
    name, type, cmc, id, identity, legal, rank: rank ?? Infinity, bits,
  }));
  return { terms: data.terms, formats: data.formats, termIndex, weight, cards };
}

// filters: { colors: ["W","U"], types: ["Creature"], format: "modern", min: 0, max: 3 }
export function search(index, features, filters = {}, query = "") {
  const { colors = [], types = [], format = "", min = null, max = null } = filters;
  const formatBit = format ? 1 << index.formats.indexOf(format) : 0;
  const passes = c =>
    (!colors.length || [...c.identity].every(x => colors.includes(x))) &&
    (!types.length || types.some(t => c.type.includes(t))) &&
    (!formatBit || c.legal & formatBit) &&
    (min === null || c.cmc >= min) &&
    (max === null || c.cmc <= max);

  const byRank = (a, b) => b.score - a.score || a.card.rank - b.card.rank;

  if (!features.length) {
    // Nothing recognized: fall back to a card-name search, ranked by popularity
    const q = query.trim().toLowerCase();
    if (!q && !colors.length && !types.length && !format && min === null && max === null) return [];
    return index.cards
      .filter(c => passes(c) && c.name.toLowerCase().includes(q))
      .map(card => ({ card, score: null }))
      .sort((a, b) => a.card.rank - b.card.rank);
  }

  // Score = IDF-weighted share of the query the card covers (query vector · card vector / query total).
  // Unlike cosine, a card isn't penalized for extra features the query didn't mention.
  const qw = new Float64Array(index.terms.length);
  const ids = features.map(f => index.termIndex.get(f));
  // A card has exactly one mana-value bucket, so requested buckets count once, as a group
  const cmcIds = ids.filter(i => index.terms[i].startsWith("CMC_"));
  const cmcWeight = Math.max(0, ...cmcIds.map(i => index.weight[i]));
  for (const i of ids) qw[i] = cmcIds.includes(i) ? cmcWeight : index.weight[i];
  const total = ids.reduce((s, i) => s + (cmcIds.includes(i) ? 0 : qw[i]), cmcWeight);

  const results = [];
  for (const card of index.cards) {
    let dot = 0;
    for (const b of card.bits) dot += qw[b];
    if (dot > 0 && passes(card)) results.push({ card, score: Math.round((dot / total) * 1e6) / 1e6 });
  }
  // Ties go to the more popular card (EDHREC rank)
  return results.sort(byRank);
}
