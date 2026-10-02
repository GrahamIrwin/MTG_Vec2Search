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
  [/\bland destruction\b/g, "land removal"],
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

const TYPE_WORDS = ["land", "creature", "artifact", "enchantment", "instant", "sorcery", "planeswalker", "battle"];
const COLOR_BITS = "WUBRG";

// Builds the in-browser index from meta.json + columns.json (see build_index.py), with IDF
// weights so rare features (e.g. "Rebound") count for more than common ones (e.g. "Creature").
// Which cards have which term is fetched per term later (postings).
export function buildIndex(meta, columns) {
  const n = columns.cmc.length;
  const weight = meta.counts.map(d => (d ? (1 + Math.log(n / d)) ** 2 : 0));
  const termIndex = new Map(meta.terms.map((t, i) => [t, i]));
  // Every name a tag goes by (slug, label, community aliases), as normalized word sets
  const tagVariants = [];
  for (const term of meta.terms) {
    if (!term.startsWith("tag:")) continue;
    for (const name of [term.slice(4), ...(meta.tag_names?.[term] ?? [])]) {
      const ws = [...new Set(words(name))];
      if (ws.length && !AMBIGUOUS_ALIASES.has(name)) tagVariants.push({ term, words: ws });
    }
  }
  const vocab = new Set(tagVariants.flatMap(v => v.words));
  // Words that only ever describe one card type in tag names imply it: every tag mentioning
  // "nonbasic" also says "land", so "nonbasic hate" means nonbasic land hate
  const implies = {};
  for (const w of vocab) {
    if (TYPE_WORDS.includes(w)) continue;
    const uses = tagVariants.filter(v => v.words.includes(w));
    const always = TYPE_WORDS.filter(t => uses.every(v => v.words.includes(t)));
    if (uses.length >= 3 && always.length) implies[w] = always;
  }
  return { ...meta, n, columns, weight, termIndex, tagVariants, vocab, implies };
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
  for (const w of [...qwords]) for (const implied of index.implies[w] ?? []) qwords.add(implied);
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
  // Verb forms keep the original word too: "sacrificing" also matches "sacrifice", "fading" stays Fading
  const raw = rawWords(query)
    .flatMap(w => (verbBase(stem(w), index.vocab) === stem(w) ? [w] : [w, verbBase(stem(w), index.vocab)]))
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

// A price limit written in the query, in the visitor's currency: "under $5", "less than 3 euros".
// Needs a currency sign or word, so "creatures under 3 mana" isn't read as a price.
export function parsePrice(query) {
  const m = query.toLowerCase().match(/(?:under|below|less than|cheaper than|max|<=?)\s*(?:[a-z]{0,2}[$€£¥])\s*(\d+(?:\.\d+)?)|[$€£¥](\d+(?:\.\d+)?)\s*(?:or less|or under|max)|(?:under|below|less than)\s*(\d+(?:\.\d+)?)\s*(?:dollars|bucks|euros|pounds|yen)/);
  return m ? Number(m[1] ?? m[2] ?? m[3]) : null;
}
// "budget" means under US$1 (converted to the visitor's currency for display)
export const BUDGET_USD = 1;
export const isBudget = query => /\bbudget\b/i.test(query);

// Term indices a parsed query needs postings for
export const termsNeeded = (index, groups) =>
  [...new Set(groups.flat().map(o => index.termIndex.get(o.term)))];

// A t/<term>.json file stores gaps between card numbers; this turns it back into card numbers
export function decodePosting(gaps) {
  const cards = new Int32Array(gaps.length);
  let card = 0;
  gaps.forEach((gap, i) => (cards[i] = card += gap));
  return cards;
}

// filters: { colors: ["W","U"], types: ["Creature"], format: "modern", min: 0, max: 3, maxPrice: 5 }
function filterFn(index, filters) {
  const { colors = [], types = [], format = "", min = null, max = null, maxPrice = null } = filters;
  const { identity, types: typeBits, cmc, legal, price } = index.columns;
  const colorMask = [...COLOR_BITS].reduce((m, c, i) => (colors.includes(c) ? m | (1 << i) : m), 0);
  const typeMask = types.reduce((m, t) => m | (1 << index.types.indexOf(t)), 0);
  const formatBit = format ? 1 << index.formats.indexOf(format) : 0;
  const cents = maxPrice === null ? null : Math.round(maxPrice * 100);
  return i =>
    (!colors.length || (identity[i] & ~colorMask) === 0) &&
    (!types.length || typeBits[i] & typeMask) &&
    (!formatBit || legal[i] & formatBit) &&
    (min === null || cmc[i] >= min) &&
    (max === null || cmc[i] <= max) &&
    (cents === null || (price[i] >= 0 && price[i] <= cents));
}

// Cards are numbered in popularity order, so sorting by card number = most popular first
const byScoreThenPopularity = (a, b) => b.score - a.score || a.card - b.card;

// Score = IDF-weighted share of the query each card covers. Unlike cosine, a card isn't
// penalized for extra features the query didn't mention. postings: term index -> card numbers.
// Returns [{card, score}], where card is the card's number.
export function search(index, groups, postings, filters = {}) {
  const passes = filterFn(index, filters);
  if (!groups.length) {
    // Filters only: every card that passes, most popular first
    const all = [];
    for (let card = 0; card < index.n; card++) if (passes(card)) all.push({ card, score: null });
    return all;
  }
  // A group weighs as much as its rarest term; a card earns it times its best credit in the group
  const groupWeight = groups.map(g => Math.max(...g.map(o => index.weight[index.termIndex.get(o.term)])));
  const total = groupWeight.reduce((s, w) => s + w, 0);
  const scores = new Float64Array(index.n);
  const best = new Float64Array(index.n);
  groups.forEach((g, gi) => {
    best.fill(0);
    for (const { term, credit } of g) {
      for (const card of postings.get(index.termIndex.get(term)) ?? []) best[card] = Math.max(best[card], credit);
    }
    for (let card = 0; card < index.n; card++) scores[card] += best[card] * groupWeight[gi];
  });
  const results = [];
  for (let card = 0; card < index.n; card++) {
    if (scores[card] > 0 && passes(card)) results.push({ card, score: Math.round((scores[card] / total) * 1e6) / 1e6 });
  }
  return results.sort(byScoreThenPopularity);
}

// Nothing recognized in the query: cards whose name contains it, most popular first
export function nameSearch(index, names, query, filters = {}) {
  const passes = filterFn(index, filters);
  const q = query.trim().toLowerCase();
  const results = [];
  names.forEach((name, card) => {
    if (name.toLowerCase().includes(q) && passes(card)) results.push({ card, score: null });
  });
  return results;
}

// === Sorting ===
export const SORTS = {
  match: "Best match", popular: "Most popular", newest: "Newest first", oldest: "Oldest first",
  "price-asc": "Price: low to high", "price-desc": "Price: high to low",
  "mv-asc": "Mana value: low to high", "mv-desc": "Mana value: high to low", name: "Name (A–Z)",
};
// Sorted by anything but match quality, only cards this close to the best match are kept,
// so "price: low to high" isn't led by cards that barely match
export const STRONG_MATCH = 0.75;

// released (days since 1993) and names are only needed, and loaded, for the date and name sorts
export function sortResults(results, sort, index, { released = [], names = [] } = {}) {
  const top = Math.max(0, ...results.map(r => r.score ?? 0));
  const list = sort === "match" || !top ? [...results] : results.filter(r => r.score >= top * STRONG_MATCH);
  const { price, cmc } = index.columns;
  const last = v => (v < 0 ? Infinity : v); // unknown price/date sorts last
  const key = {
    popular: c => c,
    newest: c => (released[c] < 0 ? Infinity : -released[c]), oldest: c => last(released[c]),
    "price-asc": c => last(price[c]), "price-desc": c => (price[c] < 0 ? Infinity : -price[c]),
    "mv-asc": c => cmc[c], "mv-desc": c => -cmc[c],
  }[sort];
  if (sort === "name") return list.sort((a, b) => names[a.card].localeCompare(names[b.card]));
  // Ties (and "match", already in order) go to the more popular card
  return key ? list.sort((a, b) => key(a.card) - key(b.card) || a.card - b.card) : list;
}

// === Random search ===
// Every term on enough cards to make a good search, written the way a person would search for it:
// a tag by its readable name or a community alias, "makes treasure tokens", "goad", "dragon".
// Returns a list of choices per term, so each term is equally likely however many names it has.
const RANDOM_MIN_CARDS = 15;
const JARGON = /\b(cycle|synergy|pwdeck|deprecated|mv|cmc|typal|tribal|set|sets|mechanic|precon|named|errata|matters|self|card|oracle|unprinted|deck)\b|\d/;
export function randomSearches(meta) {
  const choices = [];
  for (const [category, ids] of meta.categories) {
    for (const i of ids) {
      const term = meta.terms[i];
      if (meta.counts[i] < RANDOM_MIN_CARDS) continue;
      if (term.startsWith("tag:")) {
        const readable = [term.slice(4), ...(meta.tag_names?.[term] ?? [])]
          .map(n => n.replaceAll("-", " ").toLowerCase())
          .filter(n => /^[a-z' ]+$/.test(n) && !JARGON.test(n) && !AMBIGUOUS_ALIASES.has(n) && n.split(" ").length <= 4);
        if (readable.length) choices.push(readable);
      } else if (term.startsWith("token:") && term.length > 7) {
        choices.push([`makes ${term.slice(6).toLowerCase()} tokens`]);
      } else if ((category === "Keywords" || category === "Subtypes") && /^[a-z' ]+$/i.test(term)) {
        choices.push([term.toLowerCase()]);
      }
    }
  }
  return choices;
}
