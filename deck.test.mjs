import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nameLookup, parseDecklist, decodeShard, similarDecks, foldCopies, recommend, closestCommanders,
  findBuilds, distinctive, averageDeck, buildName, buildTags,
  decodeTrends, withCards, filterCommanders, trendingCommanders, trendingCards, commandersPlaying, risingCards,
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

test("a deck row keeps its Moxfield id and when it was made", () => {
  const [deck] = decodeShard({ cards: CARDS, decks: [["Q-mgAa", "m", "2026-09-30", [0, 2], "2026-09-29"]] }).decks;
  assert.deepEqual([deck.id, deck.made, [...deck.cards]], ["Q-mgAa", "2026-09-29", [0, 2]]);
  assert.equal(decodeShard(raw).decks[0].made, ""); // unknown
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

test("builds: decks that play different cards split apart, and are named for them", () => {
  // Cards 0-9 every deck plays; 10-19 only "Poison" decks, 20-29 only the others; 30 a land the
  // "Poison" decks play, which shouldn't count. 60 decks of each.
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
  const gaps = ps => ps.map((p, i) => p - (i ? ps[i - 1] : 0));
  const deck = (i, poison) => [i, poison ? `Poison ${i}` : `Deck ${i}`, "2026-01-01",
    gaps([...range(0, 10), ...(poison ? range(10, 20) : range(20, 30)), ...(poison ? [30] : [])])];
  const tags = [["poison-mechanics", gaps(range(10, 15))], ["proliferate", gaps(range(20, 25))], ["ramp", gaps(range(0, 5))]];
  const shard = decodeShard({ cards: range(0, 31), decks: range(0, 120).map(i => deck(i, i % 2 === 0)), tags });
  const builds = findBuilds(shard, { ignore: new Set([30]) });
  assert.equal(builds.length, 2);
  for (const b of builds) assert.ok(b.every(d => d % 2 === b[0] % 2) && b.length === 60);
  const poison = builds.find(b => b[0] % 2 === 0);
  assert.equal(buildName(shard, poison), "Poison");
  assert.equal(buildName(shard, builds.find(b => b !== poison)), null); // "Deck" is filler
  assert.ok(distinctive(shard, poison, { n: 10, ignore: new Set([30]) }).every(p => p >= 10 && p < 20));
  assert.deepEqual(findBuilds(decodeShard({ cards: [0], decks: range(0, 40).map(i => [i, "", "", [0]]) })), []); // too few decks
  assert.deepEqual(buildTags(shard, poison), ["poison-mechanics"]); // ramp: every deck plays it
  assert.deepEqual(buildTags(shard, builds.find(b => b !== poison)), ["proliferate"]);
  assert.deepEqual(averageDeck(shard, poison, new Set([30])), { spells: range(0, 20), lands: [30] });
});

test("deck link worker: Moxfield and Archidekt decks become plain decklists", async () => {
  const { default: worker } = await import("./worker/deck-link.js");
  const realFetch = globalThis.fetch;
  const card = (name, quantity = 1) => ({ quantity, card: { name } });
  const responses = {
    "https://api2.moxfield.com/v3/decks/all/abc": { name: "Goblins", boards: {
      commanders: { cards: { a: card("Krenko, Mob Boss") } },
      mainboard: { cards: { b: card("Sol Ring"), c: card("Mountain", 30) } },
      maybeboard: { cards: { d: card("Swords to Plowshares") } } } },
    "https://archidekt.com/api/decks/42/": { name: "Atraxa", categories: [{ name: "Maybeboard", includedInDeck: false }],
      cards: [["Atraxa, Praetors' Voice", ["Commander"]], ["Sol Ring", ["Ramp"]], ["Doubling Season", ["Maybeboard"]]]
        .map(([name, categories]) => ({ quantity: 1, categories, card: { oracleCard: { name } } })) },
  };
  globalThis.fetch = async url => (responses[url] ? new Response(JSON.stringify(responses[url])) : new Response("{}", { status: 404 }));
  const ask = async link => {
    const res = await worker.fetch(new Request(`https://w/?url=${encodeURIComponent(link)}`, { headers: { Origin: "http://localhost:8000" } }));
    return [res.status, await res.json(), res.headers.get("Access-Control-Allow-Origin")];
  };
  try {
    const [status, mox, origin] = await ask("https://www.moxfield.com/decks/abc");
    assert.equal(status, 200);
    assert.equal(origin, "http://localhost:8000");
    assert.deepEqual(mox, { name: "Goblins", site: "Moxfield", list: "1 Krenko, Mob Boss *CMDR*\n1 Sol Ring\n30 Mountain" });
    const [, arch] = await ask("https://archidekt.com/decks/42/atraxa");
    assert.equal(arch.list, "1 Atraxa, Praetors' Voice *CMDR*\n1 Sol Ring");
    assert.equal((await ask("https://moxfield.com/decks/missing"))[0], 404);
    assert.equal((await ask("https://example.com/decks/1"))[0], 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("trends: rising commanders and cards, within the filters", () => {
  // made: [ever, 90 days, 30 days, 7 days]; plays per window for the cards 5 and 9
  const { commanders, everything } = decodeTrends({ themes: ["tokens", "lifegain"],
    everything: [[150, 36, 20, 7], [5, 4], [[110, 16], [30, 6], [17, 3], [7, 0]]],
    commanders: [["1", [100, 10, 5, 1], 20000, 3, [0]], ["2", [20, 20, 12, 6], 8000, 2, [1]], ["3-4", [30, 6, 3, 0], 5000, 2, [0, 1]]] });
  withCards(commanders, [[[5, 4], [[90, 10], [10, 0], [5, 0], [1, 0]]], [[5, 4], [[20, 0], [20, 0], [12, 0], [6, 0]]], [[9], [[6], [6], [3], [0]]]]);
  assert.deepEqual(commanders[0].cards, [5, 9]);
  assert.deepEqual(trendingCards([everything], 2), trendingCards(commanders, 2)); // all of them, as one
  commanders.forEach((c, i) => (c.identity = [0b1, 0b11, 0b100][i])); // W, WU, B
  const keys = list => list.map(c => c.key);

  const all = trendingCommanders(commanders, 2);
  assert.deepEqual(keys(all.popular), ["2", "1", "3-4"]);
  assert.deepEqual(keys(all.rising), ["2"]); // all its decks are new
  assert.deepEqual(trendingCommanders(commanders, 0).rising, []); // nothing rises over all time

  // In the last 30 days: card 5 is in 17 of 20 decks (was 110 of 150), card 9 in 3 (was 16)
  const cards = trendingCards(commanders, 2);
  assert.deepEqual(cards.popular.map(x => [x.card, x.decks]), [[5, 17], [9, 3]]);
  assert.deepEqual(cards.rising.map(x => x.card), [5, 9]);
  // Only commander 1: card 9 fell from 10% of its decks to none
  assert.deepEqual(trendingCards(commanders.slice(0, 1), 2).rising.map(x => x.card), [5]);

  assert.deepEqual(keys(filterCommanders(commanders, { colors: 0b11 })), ["1", "2"]); // fit within WU
  assert.deepEqual(keys(filterCommanders(commanders, { colors: 0 })), []); // colorless
  assert.deepEqual(keys(filterCommanders(commanders, { maxPrice: 10000, kind: "single" })), ["2"]);
  assert.deepEqual(keys(filterCommanders(commanders, { themes: new Set([0]), brackets: [2] })), ["3-4"]);
  assert.deepEqual(keys(filterCommanders(commanders, { window: 3, min: 1 })), ["1", "2"]);

  assert.deepEqual(commandersPlaying(commanders, 9).map(c => [c.key, c.decks]), [["3-4", 6], ["1", 10]]);
});

test("a commander's rising cards: what its recent decks play more than its decks overall", () => {
  // Six decks all play card 10; only the three newest also play 11
  const shard = decodeShard({ cards: [10, 11], decks: [1, 2, 3, 4, 5, 6].map(id => [id, "", "", id > 3 ? [0, 1] : [0]]) });
  const all = [0, 1, 2, 3, 4, 5];
  assert.deepEqual(risingCards(shard, all, [3, 4, 5]).map(x => [x.p, x.share, x.was]), [[1, 1, 0.5]]);
  assert.deepEqual(risingCards(shard, all, all), []); // the same decks: nothing rises
});
