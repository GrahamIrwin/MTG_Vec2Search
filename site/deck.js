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

// Returns { cards: Set of card numbers, commanders: [card numbers], possible: [card numbers], unknown: [lines] }.
// A commander is marked (*CMDR*, an Archidekt [Commander] category or a Commander section), wherever
// it is, a sideboard included. With none marked, `possible` are the cards at the bottom that may be
// the commanders (findSimilar takes them if they are): Moxfield's MTGO export puts them in the
// sideboard, plain text after a blank line, 1 or 2 of them
export function parseDecklist(text, lookup) {
  const cards = new Set();
  const commanders = [];
  const unknown = [];
  const sideboard = [];
  let group = []; // the cards since the last blank line or section header
  let groups = 0; // groups of cards before it
  let section = "deck";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (group.length) groups++;
      group = [];
      continue;
    }
    if (line.startsWith("#")) continue;
    const header = line.match(SECTION);
    if (header) {
      section = header[1].toLowerCase();
      if (group.length) groups++;
      group = [];
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
    if (section.startsWith("commander") || /\*cmdr\*/i.test(line) || category === "commander") {
      if (!commanders.includes(card)) commanders.push(card);
      cards.add(card);
      continue;
    }
    if (OUT_OF_DECK.test(section) || /^(sideboard|maybeboard|considering)$/.test(category)) {
      if (section === "sideboard" || category === "sideboard") sideboard.push(card);
      continue;
    }
    cards.add(card);
    group.push(card);
  }
  const fewAtTheEnd = list => list.length >= 1 && list.length <= 2;
  const possible = commanders.length ? []
    : fewAtTheEnd(sideboard) ? sideboard
    : groups && fewAtTheEnd(group) ? group : [];
  return { cards, commanders, possible, unknown };
}

// === Similar decks ===
// A commander's file (see build_decks.py): cards = card numbers, most played first;
// decks = [id (Archidekt's number or Moxfield's string), name, updated, gaps between positions in
// `cards`, made (date, "" if unknown)]; tags = [tag, gaps between positions];
// price (US cents), bracket and themes: what a typical deck costs, its bracket, what they're known for
export function decodeShard(shard) {
  const decks = shard.decks.map(([id, name, updated, gaps, made = "", bracket = 0]) => {
    const cards = new Int32Array(gaps.length);
    let p = 0;
    gaps.forEach((gap, i) => (cards[i] = p += gap));
    return { id, name, updated, cards, made, bracket };
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
  let q = 0;
  const precon = new Set((shard.precon ?? []).map(gap => (q += gap)));
  const combos = (shard.combos ?? []).map(([id, cards, needs, makes, how = ["", "", "", ""]]) =>
    ({ id, cards, needs, makes, how: { mana: how[0], easy: how[1], notable: how[2], steps: how[3] } }));
  return { cards: shard.cards, decks, plays, weight, position, tags, precon, combos, signature: shard.signature,
    price: shard.price ?? -1, bracket: shard.bracket ?? 0, themes: shard.themes ?? [], results: shard.results ?? 0 };
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
// The decks at least NEIGHBORS.ratio as similar as the most similar one vote for cards, by
// similarity: never fewer than NEIGHBORS.min, nor more than NEIGHBORS.max. A card's score is its
// share of the votes minus part of how often any deck with this commander plays it, so the list
// is what decks like yours play more than usual, not just staples.
// Tuned by hiding 10 cards of real decks and recommending them back (tune_recommend.mjs)
export const NEIGHBORS = { ratio: 0.3, min: 10, max: 100 };
export const STAPLE_DISCOUNT = 0.5;
export function recommend(shard, similar, deckCards, { neighbors = NEIGHBORS, discount = STAPLE_DISCOUNT } = {}) {
  const cut = neighbors.ratio * (similar[0]?.similarity ?? 0);
  const top = similar.filter((r, i) => r.similarity > 0 && i < neighbors.max && (i < neighbors.min || r.similarity >= cut));
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

// Packages: a few different cards these decks play together far more often than chance would have
// it (Displacer Kitten and Teferi; Intuition and Sevinne's Reclamation), by the phi correlation of
// each pair's plays within groups of alike decks (see packageGroups). A package grows from its
// strongest pair, adding the card whose weakest link to the cards already in is strongest, while that
// link is at least PHI, so a chain A–B–C doesn't join A and C.
// Left out: staples played together (Force of Will and Force of Negation; Rhystic Study and Mystic
// Remora), every card in staples (a Set of positions); a package most of whose pairs are in packages
// found before (a card can be in more than one); and one mostly of the commander's precon
// (shard.precon: decks barely changed from it). Lands (a Set of positions) can join a package but not start one, or
// the duals would be one. Cards most decks play (Sol Ring) or few do are left out.
// Returns [{ cards: positions in shard.cards, decks: how many play them all }], strongest first.
export const PHI = 0.3, MAX_PACKAGE = 8;
export function findPackages(shard, { lands = new Set(), staples = new Set(), phi = PHI, max = MAX_PACKAGE, groups } = {}) {
  const { decks, plays } = shard;
  const n = decks.length;
  const least = Math.max(5, 0.03 * n);
  const picked = [...plays.keys()].filter(p => plays[p] >= least && plays[p] <= 0.8 * n);
  const m = picked.length;
  const index = new Int32Array(plays.length).fill(-1);
  picked.forEach((p, i) => (index[p] = i));
  const both = new Int32Array(m * m);
  for (const d of decks) {
    const mine = [];
    for (const p of d.cards) if (index[p] >= 0) mine.push(index[p]);
    for (const a of mine) for (const b of mine) if (a < b) both[a * m + b]++;
  }
  // With groups (a group number per deck), the correlation is within groups, pooled: cards a
  // group plays a lot of (cEDH staples) don't link just by being in the same group
  const g = groups ?? decks.map(() => 0);
  const G = Math.max(...g) + 1;
  const size = new Int32Array(G), per = new Int32Array(G * m);
  decks.forEach((d, i) => { size[g[i]]++; for (const p of d.cards) if (index[p] >= 0) per[g[i] * m + index[p]]++; });
  const spread = Float64Array.from(picked, (_, a) => size.reduce((s, z, j) => s + (z && per[j * m + a] - per[j * m + a] ** 2 / z), 0));
  const link = (a, b) => {
    const k = a < b ? both[a * m + b] : both[b * m + a];
    if (k < 5) return 0;
    let cov = k;
    for (let j = 0; j < G; j++) if (size[j]) cov -= per[j * m + a] * per[j * m + b] / size[j];
    return cov / Math.sqrt(spread[a] * spread[b] || 1);
  };
  const pairs = [];
  for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) {
    const s = link(a, b);
    if (s >= phi && !lands.has(picked[a]) && !lands.has(picked[b])) pairs.push([s, a, b]);
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const together = new Uint8Array(m * m); // pairs already in a package
  const packages = [];
  for (const [, a, b] of pairs) {
    if (together[a * m + b]) continue;
    const members = [a, b];
    while (members.length < max) {
      let best = -1, bestLink = phi;
      for (let c = 0; c < m; c++) {
        if (members.includes(c)) continue;
        const weakest = Math.min(...members.map(x => link(x, c)));
        if (weakest >= bestLink) [best, bestLink] = [c, weakest];
      }
      if (best < 0) break;
      members.push(best);
    }
    const old = members.reduce((k, x, i) => k + members.slice(i + 1).filter(y => together[x * m + y]).length, 0);
    for (const x of members) for (const y of members) together[x * m + y] = 1;
    const cards = members.map(x => picked[x]);
    if (old * 4 > members.length * (members.length - 1) || cards.filter(p => shard.precon.has(p)).length * 2 >= cards.length
      || cards.every(p => staples.has(p))) continue;
    const all = decks.reduce((k, d) => k + cards.every(p => d.cards.includes(p)), 0);
    if (all >= 5) packages.push({ cards, decks: all });
  }
  return packages;
}

// === Combos: Commander Spellbook's, that a commander's decks play (shard.combos, see build_decks.py) ===
// How many of these decks (numbers in shard.decks) play every card of each combo, but those has(card)
// says are there anyway (the commander). Returns [{...combo, decks}], most played first.
export function comboDecks(shard, members, has = () => false) {
  shard.sets ??= shard.decks.map(d => new Set(d.cards));
  return shard.combos.map(combo => {
    const need = combo.cards.filter(c => !has(c)).map(c => shard.position.get(c));
    const decks = need.includes(undefined) ? 0 : members.reduce((k, d) => k + need.every(p => shard.sets[d].has(p)), 0);
    return { ...combo, decks };
  }).sort((a, b) => b.decks - a.decks);
}

// Combos that differ in one card (Teferi, Displacer Kitten and Sol Ring, or Mana Vault, ...), need the same
// other pieces and make the same thing first, as one:
// [{core: the cards they share, options: [{card: the one that differs (null for a lone combo), decks, combo}]}],
// in the order given. A combo with the same cards as one before it is left out.
export function groupCombos(combos) {
  const groups = [], seen = new Set();
  for (const combo of combos) {
    const key = [...combo.cards].sort((a, b) => a - b).join();
    if (seen.has(key)) continue;
    seen.add(key);
    const size = combo.cards.length;
    const like = String([combo.needs, combo.makes?.[0]]);
    const group = groups.find(g => g.size === size && g.like === like && g.core.filter(c => combo.cards.includes(c)).length === size - 1);
    if (!group) {
      groups.push({ size, like, core: combo.cards, options: [{ card: null, decks: combo.decks, combo }] });
      continue;
    }
    if (group.core.length === size) { // a lone combo, now a group
      group.core = group.core.filter(c => combo.cards.includes(c));
      group.options[0].card = group.options[0].combo.cards.find(c => !group.core.includes(c));
    }
    group.options.push({ card: combo.cards.find(c => !group.core.includes(c)), decks: combo.decks, combo });
  }
  return groups.map(({ core, options }) => ({ core, options }));
}

// Groups of alike decks for findPackages, a number per deck: cards are played together for being in
// the same kind of deck, as much as for working together, so they're compared within decks of the
// same build (builds: findBuilds'), as tuned (how many of its build's TUNED_TOP most played nonland
// cards a deck plays, in bands of at least BAND_DECKS decks, up to TUNED_BANDS) and with as many Game
// Changers (bands as the brackets': none, up to 3, 4 to 7, more; gameChangers: a Set of card numbers).
export const TUNED_TOP = 60, BAND_DECKS = 100, TUNED_BANDS = 5;
export function packageGroups(shard, builds, { lands = new Set(), gameChangers = new Set() } = {}) {
  const groups = shard.decks.map(() => 0);
  (builds.length ? builds : [shard.decks.map((_, d) => d)]).forEach((members, b) => {
    const counts = playCounts(shard, members);
    const top = new Set([...counts.keys()].filter(p => !lands.has(p)).sort((x, y) => counts[y] - counts[x]).slice(0, TUNED_TOP));
    const tuned = d => shard.decks[d].cards.reduce((k, p) => k + top.has(p), 0);
    const bands = Math.max(1, Math.min(TUNED_BANDS, Math.floor(members.length / BAND_DECKS)));
    [...members].sort((x, y) => tuned(x) - tuned(y)).forEach((d, i) => {
      const k = shard.decks[d].cards.reduce((n, p) => n + gameChangers.has(shard.cards[p]), 0);
      groups[d] = (b * TUNED_BANDS + Math.floor(i * bands / members.length)) * 4 + (k === 0 ? 0 : k <= 3 ? 1 : k <= 7 ? 2 : 3);
    });
  });
  return groups;
}

// Combos as Markdown for a deck's primer: each one's cards, other pieces it needs, what comes first,
// its steps and what it makes. Cards are [[Card Name]] (their front face) and mana symbols
// [[symbol:g]], which Moxfield's primers show as the card and the symbol. combos: shard.combos';
// names: card names by number.
export function comboPrimer(combos, names) {
  const card = c => `[[${names[c].split(" // ")[0]}]]`;
  const lines = text => text.replace(/\{([^}]+)\}/g, (_, s) => `[[symbol:${s.replace("/", "").toLowerCase()}]]`)
    .split("\n").map(t => t.trim()).filter(Boolean);
  return ["# Combos", "", ...combos.flatMap(({ cards, needs, makes, how }) => {
    const first = [...needs.map(n => `Any ${n}`), ...lines(how.easy), ...lines(how.notable), ...lines(how.mana).map(m => `${m} available`)];
    return [
      `## ${cards.map(c => names[c]).join(" + ")}`, "",
      `**Cards:** ${cards.map(card).join(" + ")}`, "",
      ...(first.length ? ["**First:**", ...first.map(t => `- ${t}`), ""] : []),
      "**Steps:**", ...lines(how.steps).map((t, i) => `${i + 1}. ${t}`), "",
      `**Result:** ${makes.join(", ") || "a combo"}`, "",
    ];
  })].join("\n");
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

// === Trends: decks/trends.json, trend-cards/ and card-commanders/ (see build_decks.py) ===
// Window 0 is all time; 1, 2, 3 are the last 90, 30 and 7 days (index.json's windows).
// Each commander: { key, made: decks made [ever, per window], price (US cents, -1 unknown),
// bracket (0: none), themes (numbers in themes) }, and once its trend-cards/ file is read (withCards),
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
// rows: a trend-cards/ file, [commander number, gaps, plays] for some of the commanders
export const withCards = (commanders, rows) => rows.forEach(([i, ...cards]) => Object.assign(commanders[i], decodeCards(cards)));

// The commanders that pass the filters. identity: each commander's color identity bitmask, set by
// the caller. colors: the bitmask theirs must be exactly (0: colorless), or null; maxPrice: US cents;
// themes: a Set of theme numbers, any of which will do; kind: "single" or "partners";
// min: decks made in `window`
export function filterCommanders(commanders, { window = 0, colors = null, maxPrice = null, themes = null,
  brackets = [], kind = "", min = 0 } = {}) {
  return commanders.filter(c =>
    (colors === null || c.identity === colors) &&
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

// The commanders whose decks play a card, most of their decks first: [{...commander, decks, share}].
// pairs: its row of a card-commanders/ file, [commander number, decks playing it, ...]
export function commandersPlaying(commanders, pairs) {
  const playing = [];
  for (let j = 0; j < pairs.length; j += 2) {
    const c = commanders[pairs[j]];
    playing.push({ ...c, decks: pairs[j + 1], share: pairs[j + 1] / c.made[0] });
  }
  return playing.sort((a, b) => b.share - a.share || b.decks - a.decks);
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

// === Tournament results (decks/results/<commander>.json: cEDH tournaments, from edhtop16) ===
// How the tournament decks that play each card did against the commander's other tournament
// decks, over window w (an index into results.windows), for the cards at least MIN_RESULT_DECKS
// decks play and at least as many don't. lift: how much more of their games those decks win (0.03
// is 3 points), after pulling both sides toward the commander's win rate by PRIOR_GAMES games'
// worth, so a card few decks play needs a big difference to show one. evidence: how many standard
// errors the difference is, counting a deck's games as half as many independent ones (a deck's
// games share a pilot and a list). conversion: the share of decks in events with a top cut that
// made it (null: none). [{card, decks, share, games, winRate, winRateWithout, lift, evidence,
// conversion, conversionWithout}]
export const PRIOR_GAMES = 100;
export const MIN_RESULT_DECKS = 10;
const DESIGN_EFFECT = 2;
export function cardResults(results, w) {
  const [decks, games, wins, cutDecks, cuts] = results.totals[w];
  if (decks < 2 * MIN_RESULT_DECKS) return [];
  const rate = wins / games;
  const share = (k, n) => (n ? k / n : null);
  return results.cards.flatMap((card, i) => {
    const [d, g, k, cd, c] = results.stats[i].slice(5 * w, 5 * w + 5);
    if (d < MIN_RESULT_DECKS || decks - d < MIN_RESULT_DECKS) return [];
    return [{
      card, decks: d, share: d / decks, games: g, winRate: k / g, winRateWithout: (wins - k) / (games - g),
      ...compare(k, g, wins - k, games - g, rate),
      conversion: share(c, cd), conversionWithout: share(cuts - c, cutDecks - cd),
    }];
  });
}

// Decks winning k1 of n1 games against decks winning k2 of n2, where the commander's decks win
// `rate` of theirs: lift and evidence, as in cardResults
function compare(k1, n1, k2, n2, rate) {
  const toward = (k, n) => (k + PRIOR_GAMES * rate) / (n + PRIOR_GAMES);
  return {
    lift: toward(k1, n1) - toward(k2, n2),
    evidence: (k1 / n1 - k2 / n2) / Math.sqrt(DESIGN_EFFECT * rate * (1 - rate) * (1 / n1 + 1 / n2)),
  };
}

// A package of cards (one or more) in a commander's tournament decks (results/lists/<key>.json),
// over window w: the decks that play all of them against the decks that play none, as cardResults
// compares a card's. Decks playing only some of them are counted apart. Each side: {decks, games,
// wins, cutDecks (in events with a top cut), cuts}; lift and evidence: null with no decks on a side.
export function packageResults(lists, cards, w) {
  const position = new Map(lists.cards.map((c, p) => [c, p]));
  const wanted = cards.map(c => position.get(c));
  const side = () => ({ decks: 0, games: 0, wins: 0, cutDecks: 0, cuts: 0 });
  const all = side(), none = side(), some = side();
  for (const [narrowest, games, wins, cut, ...gaps] of lists.decks) {
    if (narrowest > w) continue;
    let p = 0;
    const plays = new Set(gaps.map(g => (p += g)));
    const n = wanted.filter(q => plays.has(q)).length;
    const s = n === wanted.length ? all : n ? some : none;
    s.decks++;
    s.games += games;
    s.wins += wins;
    s.cutDecks += cut > 0;
    s.cuts += cut === 2;
  }
  const rate = (all.wins + none.wins + some.wins) / (all.games + none.games + some.games);
  const comparable = all.games && none.games && rate > 0 && rate < 1;
  return { all, none, some, ...(comparable ? compare(all.wins, all.games, none.wins, none.games, rate) : { lift: null, evidence: null }) };
}
