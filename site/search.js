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

// === Word normalization, shared by queries and tag names ===
const IRREGULAR = { elves: "elf", wolves: "wolf", dwarves: "dwarf", knives: "knife" };
// Everyday words for what tags call things. Applied to both sides, so either word matches.
const SYNONYMS = {
  punish: "hate", punishing: "hate", hoser: "hate", hose: "hate", hosing: "hate",
  steal: "theft", stealing: "theft", stolen: "theft", stole: "theft",
  blink: "flicker", blinking: "flicker", wrath: "sweeper", boardwipe: "sweeper",
  make: "create", making: "create", made: "create", creating: "create",
  generate: "create", generating: "create", produce: "create", producing: "create",
  double: "doubler", doubling: "doubler", tutoring: "tutor",
};
// Tag words a query word also stands for: "artifact hate" includes artifact removal
const ALSO = { hate: ["removal"] };
const FILLER = new Set(["a", "an", "the", "of", "to", "for", "with", "and", "or", "that", "my", "your",
  "their", "its", "it", "is", "are", "on", "in"]);
// Tag aliases too ambiguous on their own ("counter" usually means +1/+1 counters, not counterspells)
const AMBIGUOUS_ALIASES = new Set(["counter"]);

function stem(w) {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return SYNONYMS[w] ?? w;
}

// Common phrasings for things tags have a name for
const PHRASES = [
  [/\bnon[- ]+(?=[a-z])/g, "non"], // non-basic -> nonbasic
  [/\bsearch(?:es|ing)?\b[^.]*?\blibrar(?:y|ies)\b/g, "tutor"], // search my library
  [/\bcan(?:no|')?t (?:cast|play)\b/g, "silence"], // opponents can't cast spells
  [/\bwins? the game\b/g, "win condition"],
  [/\bdiscards? (?:\w+ )?hands? and draws?\b/g, "wheel"],
  [/\bwhen(?:ever)?\b[^.]*?\bdies\b/g, "death trigger"],
];

function normalize(text) {
  return PHRASES.reduce((t, [re, to]) => t.replace(re, to), text.toLowerCase()).replace(/'/g, "");
}

const rawWords = text => normalize(text).split(/[^a-z0-9]+/).filter(Boolean);
const words = text => rawWords(text).filter(w => !FILLER.has(w)).map(stem);

// "drawing" -> draw, "sacrificing" -> sacrifice, "untapped" -> untap, but only when the
// result is a word tags actually use (so "nothing" doesn't become "noth")
function verbBase(w, vocab) {
  if (vocab.has(w)) return w;
  for (const suffix of ["ing", "ed"]) {
    if (!w.endsWith(suffix) || w.length < suffix.length + 3) continue;
    const base = w.slice(0, -suffix.length);
    const match = [base, base + "e", base.slice(0, -1)].find(b => vocab.has(stem(b)));
    if (match) return stem(match);
  }
  return w;
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
  // Every name a tag goes by (slug, label, community aliases), as normalized word sets
  const tagVariants = [];
  for (const term of data.terms) {
    if (!term.startsWith("tag:")) continue;
    for (const name of [term.slice(4), ...(data.tag_names?.[term] ?? [])]) {
      const ws = [...new Set(words(name))];
      if (ws.length && !AMBIGUOUS_ALIASES.has(name)) tagVariants.push({ term, words: ws });
    }
  }
  const vocab = new Set(tagVariants.flatMap(v => v.words));
  return { terms: data.terms, formats: data.formats, termIndex, weight, cards, tagVariants, vocab };
}

// Turns a plain-English query into feature groups: [[{term, credit}], ...].
// A card earns a group's weight times the best credit among the group's terms it has.
// Most groups are a single feature; related tags form one group, where the most specific
// tag gets full credit ("instant tutors": tutor-instant 1, tutor 0.5).
export function parseQuery(query, index) {
  const text = normalize(query);
  const groups = [];
  const single = new Set();

  // Oracle tags whose words all appear in the query, grouped when they share words.
  // Words added by ALSO ("hate" -> "removal") count half, and stand in for the word they came from.
  const qwords = new Set(words(query).map(w => verbBase(w, index.vocab)));
  const source = {};
  for (const w of qwords) for (const extra of ALSO[w] ?? []) if (!qwords.has(extra)) source[extra] = w;
  const matched = new Map();
  for (const v of index.tagVariants) {
    if (!v.words.every(w => qwords.has(w) || source[w])) continue;
    const size = v.words.reduce((s, w) => s + (source[w] ? 0.5 : 1), 0);
    if (v.words.some(w => !source[w]) && size > (matched.get(v.term)?.size ?? 0)) {
      matched.set(v.term, { ...v, size, roots: v.words.map(w => source[w] ?? w) });
    }
  }
  const clusters = [];
  for (const m of matched.values()) {
    const overlapping = clusters.filter(c => c.some(o => o.roots.some(w => m.roots.includes(w))));
    const merged = [m, ...overlapping.flat()];
    for (const c of overlapping) clusters.splice(clusters.indexOf(c), 1);
    clusters.push(merged);
  }
  // Credit goes to the tag covering the most query words, then to the rarer (more specific) one
  const specificity = m => m.size * index.weight[index.termIndex.get(m.term)];
  for (const c of clusters) {
    const most = Math.max(...c.map(specificity));
    groups.push(c.map(m => ({ term: m.term, credit: most ? specificity(m) / most : 1 })));
  }

  // Words in a matched multi-word tag describe its target ("artifact hate", "punishes nonbasic
  // lands"), so they don't also count as the card's own type, color or keyword
  const consumed = new Set([...matched.values()].filter(m => m.words.length > 1).flatMap(m => m.words));
  const raw = rawWords(query)
    .map(w => (verbBase(stem(w), index.vocab) === stem(w) ? w : verbBase(stem(w), index.vocab))) // sacrificing -> sacrifice
    .filter(w => !consumed.has(stem(w)));
  let cardText = raw.join(" ");

  // Tokens: after "makes"/"creates" (or before "tokens"), words describe the token, not the card
  const verb = raw.findIndex(w => stem(w) === "create");
  const noun = raw.findIndex(w => stem(w) === "token");
  if (verb >= 0 || noun >= 0) {
    const tokenText = (verb >= 0 ? raw.slice(verb + 1) : raw.slice(0, noun)).join(" ");
    const tokenFeatures = [
      ...Object.entries(COLOR_WORDS).filter(([word]) => has(tokenText, word)).map(([, code]) => "token:" + code),
      ...index.terms.filter(t => t.startsWith("token:") && t.length > 7 && has(tokenText, t.slice(6))),
    ];
    if (verb >= 0 || tokenFeatures.length) {
      cardText = (verb >= 0 ? raw.slice(0, verb) : raw.slice(noun)).join(" ");
      [...tokenFeatures, "Token Creation"].forEach(t => single.add(t));
    }
  }

  for (const [concept, phrases] of Object.entries(ACTION_PHRASES)) {
    if (phrases.some(p => has(text, p))) single.add(concept);
  }
  for (const [word, code] of Object.entries(COLOR_WORDS)) if (has(cardText, word)) single.add(code);
  // A card has exactly one mana-value bucket, so requested buckets form one group
  const cmc = CMC_WORDS.filter(([ws]) => ws.some(w => has(cardText, w))).flatMap(([, buckets]) => buckets);
  if (cmc.length) groups.push(cmc.map(term => ({ term, credit: 1 })));
  // Types, keywords, subtypes and text terms match by name
  for (const t of index.terms) {
    if (t.length > 1 && !/^(CMC_|tag:|token:)/.test(t) && has(cardText, t)) single.add(t);
  }
  for (const t of single) if (index.termIndex.has(t)) groups.push([{ term: t, credit: 1 }]);
  return groups;
}

// The most specific term of each group, for display
export const mainTerms = groups => groups.flatMap(g => g.filter(o => o.credit === 1).map(o => o.term));

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

// Score = IDF-weighted share of the query each card covers. Unlike cosine, a card isn't
// penalized for extra features the query didn't mention.
export function search(index, groups, filters = {}, query = "") {
  const passes = filterFn(index, filters);

  if (!groups.length) {
    // Nothing recognized: fall back to a card-name search, ranked by popularity
    const q = query.trim().toLowerCase();
    if (!q && !hasFilters(filters)) return [];
    return index.cards
      .filter(c => passes(c) && c.name.toLowerCase().includes(q))
      .map(card => ({ card, score: null }))
      .sort((a, b) => a.card.rank - b.card.rank);
  }

  // A group weighs as much as its rarest term; term index -> [[group, credit], ...]
  const groupWeight = groups.map(g => Math.max(...g.map(o => index.weight[index.termIndex.get(o.term)])));
  const total = groupWeight.reduce((s, w) => s + w, 0);
  const credits = new Map();
  groups.forEach((g, gi) => g.forEach(({ term, credit }) => {
    const i = index.termIndex.get(term);
    credits.set(i, [...(credits.get(i) ?? []), [gi, credit]]);
  }));

  const best = new Float64Array(groups.length);
  const results = [];
  for (const card of index.cards) {
    best.fill(0);
    for (const b of card.bits) for (const [gi, credit] of credits.get(b) ?? []) best[gi] = Math.max(best[gi], credit);
    let dot = 0;
    for (let gi = 0; gi < groups.length; gi++) dot += best[gi] * groupWeight[gi];
    if (dot > 0 && passes(card)) results.push({ card, score: Math.round((dot / total) * 1e6) / 1e6 });
  }
  // Ties go to the more popular card (EDHREC rank)
  return results.sort((a, b) => b.score - a.score || a.card.rank - b.card.rank);
}
