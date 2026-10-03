import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nameLookup, parseDecklist, decodeShard, similarDecks, foldCopies, recommend, closestCommanders,
} from "./site/deck.js";

const NAMES = ["Sol Ring", "Atraxa, Praetors' Voice", "Delver of Secrets // Insectile Aberration", "Island",
  "Lim-Dûl's Vault", "Swords to Plowshares", "Krenko, Mob Boss"];
const lookup = nameLookup(NAMES);
const parse = text => parseDecklist(text, lookup);

test("reads the common export formats", () => {
  const { cards, commanders, unknown } = parse(`
Commander
1 Atraxa, Praetors' Voice (2X2) 190

Deck
1x Sol Ring (CMM) 400 *F*
Delver of Secrets
12 Island
1 Lim-Dul's Vault
1 Not A Card`);
  assert.deepEqual(commanders, [1]);
  assert.deepEqual([...cards].sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(unknown, ["1 Not A Card"]);
});

test("Archidekt categories and *CMDR* markers pick the commander; side boards are left out", () => {
  const archidekt = parse("1x Krenko, Mob Boss (ddt) 52 [Commander{top}]\n1x Sol Ring (c21) 263 [Ramp]\n1x Swords to Plowshares (sta) 10 [Maybeboard{noDeck}{noPrice}]");
  assert.deepEqual(archidekt.commanders, [6]);
  assert.deepEqual([...archidekt.cards].sort(), [0, 6]);
  const marked = parse("1 Sol Ring\n1 Krenko, Mob Boss *CMDR*\n\nSideboard\n1 Swords to Plowshares");
  assert.deepEqual(marked.commanders, [6]);
  assert.deepEqual([...marked.cards].sort(), [0, 6]);
});

// Five decks over cards 10..16; card 10 is in every deck, so it carries no weight
const gaps = ps => ps.map((p, i) => p - (ps[i - 1] ?? 0));
const CARDS = [10, 11, 12, 13, 14, 15, 16];
const raw = { cards: CARDS, decks: [[1, "a", "", [0, 1, 2, 3]], [2, "b", "", [0, 1, 2, 4]], [3, "c", "", [0, 4, 5, 6]],
  [4, "a copy", "", [0, 1, 2, 3]], [5, "d", "", [0, 5, 6]]].map(([id, name, up, ps]) => [id, name, up, gaps(ps)]) };

test("similar decks rank by shared rare cards", () => {
  const shard = decodeShard(raw);
  assert.equal(shard.weight[0], 0);
  const similar = similarDecks(shard, [10, 11, 12, 13]);
  assert.deepEqual(similar.map(r => r.deck.id), [1, 4, 2, 3, 5]);
  assert.ok(Math.abs(similar[0].similarity - 1) < 1e-9);
  assert.equal(similar[0].shared, 4);
  assert.equal(similar.at(-1).similarity, 0);
  const folded = foldCopies(similar, 10);
  assert.deepEqual(folded.map(r => [r.deck.id, r.copies]), [[1, 1], [2, 0], [3, 0], [5, 0]]);
});

test("recommendations: what similar decks play that you don't; cuts: what they don't", () => {
  const shard = decodeShard(raw);
  const mine = [11, 12, 13, 99];
  const { adds, cuts } = recommend(shard, similarDecks(shard, mine), mine);
  // Every deck plays 10, then 14 is in b, the closest deck that differs
  assert.deepEqual(adds.slice(0, 2).map(a => a.card), [10, 14]);
  assert.ok(!adds.some(a => mine.includes(a.card)));
  assert.equal(cuts[0].card, 99); // no deck plays it
});

test("closest commanders by signature cards", () => {
  const index = { commanders: [["1", 300, [5, 6, 7]], ["2", 50, [5, 6, 8]], ["3", 900, [9]]] };
  assert.deepEqual(closestCommanders(index, [5, 6, 8]).map(c => c.key), ["2", "1"]);
});
