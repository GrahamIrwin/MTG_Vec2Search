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
    // Popularity prior for smart search: 1 for the top EDHREC card, falling to 0 (unranked)
    pop: rank ? Math.max(0, 1 - Math.log(rank) / Math.log(40000)) : 0,
  }));
  return { terms: data.terms, formats: data.formats, termIndex, weight, df, cards };
}

// filters: { colors: ["W","U"], types: ["Creature"], format: "modern", min: 0, max: 3 }
function filterFn(index, filters) {
  const { colors = [], types = [], format = "", min = null, max = null } = filters;
  const formatBit = format ? 1 << index.formats.indexOf(format) : 0;
  return c =>
    (!colors.length || [...c.identity].every(x => colors.includes(x))) &&
    (!types.length || types.some(t => c.type.includes(t))) &&
    (!formatBit || c.legal & formatBit) &&
    (min === null || c.cmc >= min) &&
    (max === null || c.cmc <= max);
}

const hasFilters = ({ colors = [], types = [], format = "", min = null, max = null }) =>
  colors.length || types.length || format || min !== null || max !== null;

// Per-card IDF-weighted share of the query each card covers (query vector · card vector / query total).
// Unlike cosine, a card isn't penalized for extra features the query didn't mention.
function coverage(index, features) {
  const scores = new Float64Array(index.cards.length);
  if (!features.length) return scores;
  const qw = new Float64Array(index.terms.length);
  const ids = features.map(f => index.termIndex.get(f));
  // A card has exactly one mana-value bucket, so requested buckets count once, as a group
  const cmcIds = ids.filter(i => index.terms[i].startsWith("CMC_"));
  const cmcWeight = Math.max(0, ...cmcIds.map(i => index.weight[i]));
  for (const i of ids) qw[i] = cmcIds.includes(i) ? cmcWeight : index.weight[i];
  const total = ids.reduce((s, i) => s + (cmcIds.includes(i) ? 0 : qw[i]), cmcWeight);
  index.cards.forEach((card, ci) => {
    let dot = 0;
    for (const b of card.bits) dot += qw[b];
    scores[ci] = Math.round((dot / total) * 1e6) / 1e6;
  });
  return scores;
}

export function search(index, features, filters = {}, query = "") {
  const passes = filterFn(index, filters);

  if (!features.length) {
    // Nothing recognized: fall back to a card-name search, ranked by popularity
    const q = query.trim().toLowerCase();
    if (!q && !hasFilters(filters)) return [];
    return index.cards
      .filter(c => passes(c) && c.name.toLowerCase().includes(q))
      .map(card => ({ card, score: null }))
      .sort((a, b) => a.card.rank - b.card.rank);
  }

  const cov = coverage(index, features);
  const results = [];
  index.cards.forEach((card, i) => {
    if (cov[i] > 0 && passes(card)) results.push({ card, score: cov[i] });
  });
  // Ties go to the more popular card (EDHREC rank)
  return results.sort((a, b) => b.score - a.score || a.card.rank - b.card.rank);
}

// === Smart (semantic) search ===
// Card rules text embedded at build time (embeddings.bin), compared with the embedded query.

// Rules-text phrasing for concepts, so slang the parser knows ("board wipe")
// also steers the embedding ("Destroy all creatures.")
const CONCEPT_TEXT = {
  "Life Gain": "You gain life.",
  "Card Advantage": "Draw a card.",
  "Tap Effect": "Tap target creature.",
  "Direct Damage": "Deals damage to any target.",
  "Mana Ramp": "Add one mana of any color. Search your library for a basic land card and put it onto the battlefield.",
  "Graveyard Recursion": "Return target creature card from your graveyard to the battlefield.",
  "Discard Effect": "Target opponent discards a card.",
  "Counter Effect": "Counter target spell.",
  "Removal": "Destroy target creature.",
  "Exile Effect": "Exile target permanent.",
  "Bounce Effect": "Return target permanent to its owner's hand.",
  "Mass Removal": "Destroy all creatures.",
  "Fight Effect": "Target creature you control fights target creature you don't control.",
  "Mill Effect": "Target player mills cards.",
  "Token Creation": "Create creature tokens.",
  "Artifact Interaction": "Destroy target artifact.",
  "Enchantment Interaction": "Destroy target enchantment.",
  "Landfall Effect": "Whenever a land you control enters, ",
};

export function expandQuery(query, features) {
  return [query, ...features.filter(f => CONCEPT_TEXT[f]).map(f => CONCEPT_TEXT[f])].join(" ");
}

// embeddings.bin: float32 scale, then one int8 vector per card (same order as cards.json)
export function loadEmbeddings(buffer, cardCount) {
  const scale = new Float32Array(buffer.slice(0, 4))[0];
  const vectors = new Int8Array(buffer, 4);
  const dims = vectors.length / cardCount;
  if (!Number.isInteger(dims)) throw new Error("embeddings.bin doesn't match cards.json");
  return { scale, vectors, dims };
}

export const SMART_MODEL = "Xenova/all-MiniLM-L6-v2";
// Weights tuned on ~20 real queries (bakeoff/)
export const SMART = { coverageWeight: 0.1, popularityWeight: 0.1, commonFeature: 0.25, limit: 300 };

// Score = semantic similarity + small boosts for matching parsed features and for popularity.
// Card names aren't embedded, so a query that's part of a card's name puts that card first.
export function semanticSearch(index, emb, queryVector, features, filters = {}, query = "") {
  const passes = filterFn(index, filters);
  // Very common features (e.g. "Creature") would boost a quarter of all cards, so they don't count here
  const n = index.cards.length;
  const specific = features.filter(f => index.df[index.termIndex.get(f)] / n <= SMART.commonFeature);
  const cov = coverage(index, specific);
  const q = query.trim().toLowerCase();
  const { scale, vectors, dims } = emb;
  const results = [];
  index.cards.forEach((card, i) => {
    if (!passes(card)) return;
    let dot = 0;
    for (let d = 0, o = i * dims; d < dims; d++) dot += queryVector[d] * vectors[o + d];
    const nameHit = q.length >= 3 && card.name.toLowerCase().includes(q) ? 1 : 0;
    const score = dot / scale + SMART.coverageWeight * cov[i] + SMART.popularityWeight * card.pop + nameHit;
    results.push({ card, score });
  });
  return results.sort((a, b) => b.score - a.score).slice(0, SMART.limit);
}
