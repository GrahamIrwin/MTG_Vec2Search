// Similar decks and card recommendations for a pasted decklist. Pure functions, tested by
// deck.test.mjs (node --test). The deck data is built by build_decks.py.

// === Decklist parsing ===
// Accepts what deck sites export: "1 Sol Ring", "1x Sol Ring (CMM) 400 *F*",
// "Commander"/"Deck"/"Sideboard" section headers (Arena, Moxfield), and Archidekt's
// "1x Atraxa, Praetors' Voice (2x2) 190 [Commander{top}]" categories.
const SECTION = /^(?:\/\/\s*)?(commanders?|deck|main(?:board)?|sideboard|maybeboard|considering|companion|tokens?)\s*:?\s*(?:\(\d+\))?$/i;
const LINE = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\([A-Za-z0-9]{2,6}\)(?:\s+\S+)?)?(?:\s+\*[A-Z]+\*)*(?:\s+\[([^\]]*)\])?(?:\s+\^[^^]*\^)?\s*$/;
const OUT_OF_DECK = /^(sideboard|maybeboard|considering|tokens?)$/i;

const fold = s => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’`]/g, "'").trim();

// names: every card name, by card number (index/names.json). Double-faced cards can be
// written with just their front face ("Delver of Secrets").
export function nameLookup(names) {
  const lookup = new Map();
  names.forEach((name, card) => {
    for (const n of [name, name.split(" // ")[0]]) if (!lookup.has(fold(n))) lookup.set(fold(n), card);
  });
  return lookup;
}

// Returns { cards: Set of card numbers, commanders: [card numbers], unknown: [lines] }
export function parseDecklist(text, lookup) {
  const cards = new Set();
  const commanders = [];
  const unknown = [];
  let section = "deck";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(SECTION);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    const m = line.match(LINE);
    const tags = (m?.[3] ?? "").toLowerCase();
    const name = m?.[2].replace(/\s+\*CMDR\*$/i, "");
    const card = name && lookup.get(fold(name));
    if (card === undefined) {
      unknown.push(line);
      continue;
    }
    const category = tags.split(/[,{]/)[0].trim();
    if (OUT_OF_DECK.test(section) || /^(sideboard|maybeboard|considering)$/.test(category)) continue;
    if (section.startsWith("commander") || /\*cmdr\*/i.test(line) || category === "commander") {
      if (!commanders.includes(card)) commanders.push(card);
    }
    cards.add(card);
  }
  return { cards, commanders, unknown };
}

// === Similar decks ===
// A commander's file (see build_decks.py): cards = card numbers, most played first;
// decks = [id (Archidekt's number or Moxfield's string), name, updated, gaps between positions in
// `cards`, made (date, "" if unknown)]; tags = [tag, gaps between positions];
// price (US cents), bracket and themes: what a typical deck costs, its bracket, what they're known for
export function decodeShard(shard) {
  const decks = shard.decks.map(([id, name, updated, gaps, made = ""]) => {
    const cards = new Int32Array(gaps.length);
    let p = 0;
    gaps.forEach((gap, i) => (cards[i] = p += gap));
    return { id, name, updated, cards, made };
  });
  // How many decks play each card, and its weight: cards every deck plays (Sol Ring) say little
  // about a deck, rare ones say a lot (IDF)
  const plays = new Int32Array(shard.cards.length);
  for (const d of decks) for (const p of d.cards) plays[p]++;
  const weight = Float64Array.from(plays, n => Math.log(decks.length / Math.max(n, 1)) ** 2);
  const position = new Map(shard.cards.map((card, p) => [card, p]));
  const tags = (shard.tags ?? []).map(([name, gaps]) => {
    let p = 0;
    return { name, positions: gaps.map(gap => (p += gap)) };
  });
  return { cards: shard.cards, decks, plays, weight, position, tags, signature: shard.signature,
    price: shard.price ?? -1, bracket: shard.bracket ?? 0, themes: shard.themes ?? [] };
}

// Cosine similarity between the pasted deck and every deck in the file, over the cards they
// play, weighted by rarity. deckCards: card numbers (commanders and basic lands left out).
// Returns [{deck, similarity, shared}], most similar first.
export function similarDecks(shard, deckCards) {
  const { decks, weight, position } = shard;
  const unseen = Math.log(decks.length) ** 2; // a card no deck here plays
  const mine = new Set();
  let norm = 0;
  for (const card of deckCards) {
    const p = position.get(card);
    if (p === undefined) norm += unseen;
    else if (!mine.has(p)) { mine.add(p); norm += weight[p]; }
  }
  return decks.map(deck => {
    let dot = 0, theirs = 0, shared = 0;
    for (const p of deck.cards) {
      theirs += weight[p];
      if (mine.has(p)) { dot += weight[p]; shared++; }
    }
    return { deck, similarity: dot ? dot / Math.sqrt(norm * theirs) : 0, shared };
  }).sort((a, b) => b.similarity - a.similarity || b.shared - a.shared);
}

// Near-copies (a precon with a few changes, "Copy of …") fold into the first deck like them,
// so the list isn't the same deck twenty times. Returns [{...result, copies}].
export const COPY = 0.9; // share of cards in common (Jaccard)
export function foldCopies(results, limit) {
  const shown = [];
  for (const r of results) {
    if (shown.length >= limit) break;
    const set = new Set(r.deck.cards);
    const like = shown.find(s => {
      const both = s.deck.cards.reduce((n, p) => n + set.has(p), 0);
      return both / (set.size + s.deck.cards.length - both) >= COPY;
    });
    if (like) like.copies++;
    else shown.push({ ...r, copies: 0 });
  }
  return shown;
}

// === Recommendations ===
// The NEIGHBORS most similar decks vote for cards, by similarity. A card's score is its share
// of the votes minus part of how often any deck with this commander plays it, so the list is
// what decks like yours play more than usual, not just staples.
export const NEIGHBORS = 25; // tuned by hiding 10 cards of real decks and recommending them back
export const STAPLE_DISCOUNT = 0.5;
export function recommend(shard, similar, deckCards, { neighbors = NEIGHBORS, discount = STAPLE_DISCOUNT } = {}) {
  const top = similar.slice(0, neighbors).filter(r => r.similarity > 0);
  const total = top.reduce((s, r) => s + r.similarity, 0) || 1;
  const share = new Float64Array(shard.cards.length);
  const decks = new Int32Array(shard.cards.length); // how many of them play it, for display
  for (const r of top) {
    for (const p of r.deck.cards) {
      share[p] += r.similarity / total;
      decks[p]++;
    }
  }
  const mine = new Set(deckCards);
  const adds = [];
  shard.cards.forEach((card, p) => {
    if (!mine.has(card) && share[p] > 0) {
      adds.push({ card, share: share[p], decks: decks[p], score: share[p] - discount * shard.plays[p] / shard.decks.length });
    }
  });
  adds.sort((a, b) => b.score - a.score);
  // Cuts: your cards that decks like yours rarely play
  const cuts = [...mine].map(card => ({ card, share: shard.position.has(card) ? share[shard.position.get(card)] : 0 }))
    .sort((a, b) => a.share - b.share);
  return { adds, cuts, neighbors: top.length };
}

// === Builds: a commander's decks, grouped by the cards they share ===
// Spherical k-means over the decks' cards, each weighted by how rare it is among them (IDF),
// starting from a build per DECKS_PER_BUILD decks (up to MAX_BUILDS): one with under MIN_BUILD of
// the decks is dropped, and of two whose typical decks are ALIKE, one is dropped, its decks going
// to the build nearest them. ignore: positions in shard.cards to leave out (lands, which say more
// about a deck's budget than its plan).
// Returns [[deck numbers in shard.decks]], biggest build first, or [] for a single build.
export const MAX_BUILDS = 6;
export const DECKS_PER_BUILD = 50;
export const MIN_BUILD = 0.08;
export const ALIKE = 0.75; // cosine similarity of two builds' centers
export function findBuilds(shard, { ignore = new Set(), seed = 1 } = {}) {
  const { decks, plays } = shard;
  const n = decks.length;
  const k = Math.min(MAX_BUILDS, Math.floor(n / DECKS_PER_BUILD));
  if (k < 2) return [];
  // Cards a few decks play are noise here; cards every deck plays weigh nothing anyway
  const rare = Math.max(2, 0.02 * n);
  const idf = Float64Array.from(plays, (c, p) => (c >= rare && !ignore.has(p) ? Math.log(n / c) : 0));
  const norm = decks.map(d => Math.sqrt(d.cards.reduce((s, p) => s + idf[p] ** 2, 0)) || 1);
  const sim = (d, c) => decks[d].cards.reduce((s, p) => s + idf[p] * c[p], 0) / norm[d];
  const center = members => {
    const c = new Float64Array(plays.length);
    for (const d of members) for (const p of decks[d].cards) c[p] += idf[p] / norm[d];
    const len = Math.hypot(...c) || 1;
    return c.map(x => x / len);
  };
  const random = mulberry32(seed);

  // k-means++: each next center is a deck far from the ones chosen so far
  let centers = [center([Math.floor(random() * n)])];
  while (centers.length < k) {
    const far = decks.map((_, d) => (1 - Math.max(...centers.map(c => sim(d, c)))) ** 2);
    let r = random() * far.reduce((a, b) => a + b, 0);
    centers.push(center([far.findIndex(f => (r -= f) <= 0)]));
  }
  let groups;
  const settle = () => {
    for (let round = 0; round < 30; round++) {
      const near = decks.map((_, d) => centers.reduce((best, c, i) => (sim(d, c) > sim(d, centers[best]) ? i : best), 0));
      const next = centers.map((_, i) => near.flatMap((g, d) => (g === i ? [d] : [])));
      const same = groups && next.every((g, i) => g.length === groups[i].length && g.every((d, j) => d === groups[i][j]));
      groups = next;
      if (same) break;
      centers = groups.map((g, i) => (g.length ? center(g) : centers[i]));
    }
  };
  settle();
  for (;;) {
    const smallest = groups.reduce((s, g, i) => (g.length < groups[s].length ? i : s), 0);
    let drop = groups[smallest].length < MIN_BUILD * n ? smallest : -1;
    for (let i = 0; drop < 0 && i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        if (centers[i].reduce((s, x, p) => s + x * centers[j][p], 0) > ALIKE) {
          drop = groups[i].length < groups[j].length ? i : j;
          break;
        }
      }
    }
    if (drop < 0 || centers.length === 1) break;
    centers.splice(drop, 1);
    groups = null;
    settle();
  }
  return centers.length > 1 ? groups.sort((a, b) => b.length - a.length) : [];
}

function mulberry32(seed) { // a small seeded random number generator, so builds don't change between visits
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How many of these decks (numbers in shard.decks) play each card, by position in shard.cards
export function playCounts(shard, members) {
  const counts = new Int32Array(shard.cards.length);
  for (const d of members) for (const p of shard.decks[d].cards) counts[p]++;
  return counts;
}

// The cards a group of decks plays far more often than all this commander's decks do
// (positions in shard.cards, most distinctive first)
export function distinctive(shard, members, { n = 12, ignore = new Set() } = {}) {
  const counts = playCounts(shard, members);
  const lift = p => counts[p] / members.length - shard.plays[p] / shard.decks.length;
  return [...counts.keys()].filter(p => counts[p] && !ignore.has(p)).sort((a, b) => lift(b) - lift(a)).slice(0, n);
}

// An average deck: the spells these decks play most, as many as they play on average, and the
// same for lands (positions in shard.cards; lands: a Set of positions). Basic lands aren't in
// the deck files, so they're left to fill the rest. Returns { spells, lands }.
export function averageDeck(shard, members, lands) {
  const counts = playCounts(shard, members);
  const landCount = members.reduce((s, d) => s + shard.decks[d].cards.reduce((k, p) => k + lands.has(p), 0), 0);
  const cardCount = members.reduce((s, d) => s + shard.decks[d].cards.length, 0);
  const most = isLand => [...counts.keys()].filter(p => counts[p] && lands.has(p) === isLand)
    .sort((a, b) => counts[b] - counts[a] || a - b);
  return {
    spells: most(false).slice(0, Math.round((cardCount - landCount) / members.length)),
    lands: most(true).slice(0, Math.round(landCount / members.length)),
  };
}

// The Scryfall Tagger tags (shard.tags) whose cards these decks play the most more of than all
// this commander's decks do, per deck, relative to how many they play anyway. A tag mostly on
// the same cards as a better one ("tutor" after "tutor-to") is skipped. Returns tag names.
export function buildTags(shard, members, n = 3) {
  const counts = playCounts(shard, members);
  const scored = shard.tags.map(tag => {
    let here = 0, all = 0;
    for (const p of tag.positions) { here += counts[p]; all += shard.plays[p]; }
    here /= members.length;
    all /= shard.decks.length;
    return { ...tag, more: here - all, score: (here - all) / Math.sqrt(all + 1) };
  }).filter(t => t.more >= 0.5).sort((a, b) => b.score - a.score);
  const picked = [];
  for (const t of scored) {
    if (picked.length >= n) break;
    const mine = new Set(t.positions);
    const alike = picked.some(p => {
      const both = p.positions.reduce((k, x) => k + mine.has(x), 0);
      return both / (mine.size + p.positions.length - both) >= 0.5;
    });
    if (!alike) picked.push(t);
  }
  return picked.map(t => t.name);
}

// A name for a build from the word its deck names use far more than the commander's other
// decks do ("Poison", "Superfriends"), or null. skip: words that say nothing (the commander's name)
const NAME_WORDS = /[\p{L}\p{N}][\p{L}\p{N}'+-]*/gu;
const FILLER = new Set(["the", "of", "a", "an", "and", "my", "deck", "edh", "commander", "copy", "v1", "v2", "v3",
  "new", "list", "build", "upgraded", "upgrade", "precon", "budget", "cedh", "test", "wip", "in", "to", "with",
  "for", "is", "on", "de", "la", "el", "untitled", "version", "primer", "optimized", "casual"]);
export function buildName(shard, members, skip = new Set()) {
  const wordsOf = d => new Set((shard.decks[d].name.toLowerCase().match(NAME_WORDS) ?? [])
    .filter(w => !FILLER.has(w) && !skip.has(w) && w.length > 2));
  const all = new Map();
  shard.decks.forEach((_, d) => { for (const w of wordsOf(d)) all.set(w, (all.get(w) ?? 0) + 1); });
  const here = new Map();
  for (const d of members) for (const w of wordsOf(d)) here.set(w, (here.get(w) ?? 0) + 1);
  const best = [...here]
    .filter(([, k]) => k >= Math.max(3, 0.1 * members.length))
    .map(([w, k]) => [w, k / members.length - all.get(w) / shard.decks.length])
    .filter(([, lift]) => lift >= 0.08)
    .sort((a, b) => b[1] - a[1]);
  return best.length ? best[0][0][0].toUpperCase() + best[0][0].slice(1) : null;
}

// Commanders whose decks look most like this one, by how many of their signature cards it plays
// (decks/index.json: [file name, deck count, signature cards])
export function closestCommanders(index, deckCards, n = 6) {
  const mine = new Set(deckCards);
  return index.commanders
    .map(([key, decks, signature]) => ({ key, decks, overlap: signature.reduce((k, c) => k + mine.has(c), 0) }))
    .filter(c => c.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.decks - a.decks)
    .slice(0, n);
}

// === Trends: decks/trends.json and trend-cards.json (see build_decks.py) ===
// Window 0 is all time; 1, 2, 3 are the last 90, 30 and 7 days (index.json's windows).
// Each commander: { key, made: decks made [ever, per window], price (US cents, -1 unknown),
// bracket (0: none), themes (numbers in themes) }, and once trend-cards.json is read (withCards),
// cards (card numbers) and plays ([per window, per card]). everything: all their decks, as one.
const decodeCards = ([gaps, plays]) => {
  let card = 0;
  return { cards: gaps.map(g => (card += g)), plays };
};
export function decodeTrends(data) {
  const [made, ...cards] = data.everything;
  return {
    themes: data.themes,
    everything: { key: "", made, ...decodeCards(cards) },
    commanders: data.commanders.map(([key, made, price, bracket, themes]) => ({ key, made, price, bracket, themes })),
  };
}
export const withCards = (commanders, cardData) => commanders.forEach((c, i) => Object.assign(c, decodeCards(cardData[i])));

// The commanders that pass the filters. identity: each commander's color identity bitmask, set by
// the caller. colors: a bitmask they must fit within (0: colorless), or null; maxPrice: US cents;
// themes: a Set of theme numbers, any of which will do; kind: "single" or "partners";
// min: decks made in `window`
export function filterCommanders(commanders, { window = 0, colors = null, maxPrice = null, themes = null,
  brackets = [], kind = "", min = 0 } = {}) {
  return commanders.filter(c =>
    (colors === null || (c.identity & ~colors) === 0) &&
    (maxPrice === null || (c.price >= 0 && c.price <= maxPrice)) &&
    (!themes || c.themes.some(t => themes.has(t))) &&
    (!brackets.length || brackets.includes(c.bracket)) &&
    (!kind || (kind === "partners") === c.key.includes("-")) &&
    c.made[window] >= min);
}

// Popular: most decks made in the window. Rising: the most more decks than their share of all
// decks would give them, relative to that (so a commander going from 5 decks to 20 beats one going
// from 300 to 330), from at least MIN_RISING decks. ratio: how many times their usual share.
export const MIN_RISING = 3;
// How far a share rose, relative to where it was: 1% -> 4% counts for more than 60% -> 66%
const rise = x => (x.share - x.was) / Math.sqrt(x.was);
export function trendingCommanders(scope, window) {
  const total = scope.reduce((s, c) => s + c.made[0], 0);
  const recent = scope.reduce((s, c) => s + c.made[window], 0);
  const popular = scope.filter(c => c.made[window]).sort((a, b) => b.made[window] - a.made[window] || b.made[0] - a.made[0]);
  const rising = !window || !recent ? [] : scope
    .map(c => {
      const expected = recent * c.made[0] / total;
      return { ...c, score: (c.made[window] - expected) / Math.sqrt(expected), ratio: c.made[window] / expected };
    })
    .filter(c => c.score > 0 && c.made[window] >= MIN_RISING)
    .sort((a, b) => b.score - a.score);
  return { popular, rising, total, recent };
}

// Popular: the share of the window's decks (of these commanders) that play each card. Rising:
// the most above the share of all their decks (was), relative to it (see rise), from at least
// MIN_RISING decks and 1% of them.
export function trendingCards(scope, window) {
  const plays = new Map(); // card -> [decks ever, decks in the window]
  let total = 0, recent = 0;
  for (const c of scope) {
    total += c.made[0];
    recent += c.made[window];
    c.cards.forEach((card, i) => {
      const p = plays.get(card) ?? plays.set(card, [0, 0]).get(card);
      p[0] += c.plays[0][i];
      p[1] += c.plays[window][i];
    });
  }
  const popular = [...plays].filter(([, [, now]]) => now)
    .map(([card, [ever, now]]) => ({ card, decks: now, share: now / recent, was: ever / total }))
    .sort((a, b) => b.share - a.share || a.card - b.card);
  const rising = !window ? [] : popular
    .filter(x => x.share > x.was && x.decks >= Math.max(MIN_RISING, 0.01 * recent))
    .sort((a, b) => rise(b) - rise(a));
  return { popular, rising, total, recent };
}

// The commanders whose decks play this card, most of their decks first: [{...commander, decks, share}]
export function commandersPlaying(commanders, card) {
  return commanders.flatMap(c => {
    const i = c.cards.indexOf(card);
    return i < 0 || !c.plays[0][i] ? [] : [{ ...c, decks: c.plays[0][i], share: c.plays[0][i] / c.made[0] }];
  }).sort((a, b) => b.share - a.share || b.decks - a.decks);
}

// On a commander's page: the cards a group's recent decks (deck numbers in shard.decks) play more
// often than all its decks do, most above first: [{p (position in shard.cards), share, was}]
export function risingCards(shard, members, recent) {
  const now = playCounts(shard, recent), ever = playCounts(shard, members);
  return [...now.keys()]
    .map(p => ({ p, decks: now[p], share: now[p] / recent.length, was: ever[p] / members.length }))
    .filter(x => x.share > x.was && x.decks >= Math.max(MIN_RISING, 0.01 * recent.length))
    .sort((a, b) => rise(b) - rise(a));
}
