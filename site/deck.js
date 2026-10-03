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
// decks = [id, name, updated, gaps between positions in `cards`]
export function decodeShard(shard) {
  const decks = shard.decks.map(([id, name, updated, gaps]) => {
    const cards = new Int32Array(gaps.length);
    let p = 0;
    gaps.forEach((gap, i) => (cards[i] = p += gap));
    return { id, name, updated, cards };
  });
  // How many decks play each card, and its weight: cards every deck plays (Sol Ring) say little
  // about a deck, rare ones say a lot (IDF)
  const plays = new Int32Array(shard.cards.length);
  for (const d of decks) for (const p of d.cards) plays[p]++;
  const weight = Float64Array.from(plays, n => Math.log(decks.length / Math.max(n, 1)) ** 2);
  const position = new Map(shard.cards.map((card, p) => [card, p]));
  return { cards: shard.cards, decks, plays, weight, position };
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
