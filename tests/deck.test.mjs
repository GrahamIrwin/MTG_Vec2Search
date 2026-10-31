import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nameLookup, parseDecklist, decodeShard, similarDecks, foldCopies, recommend, closestCommanders,
  findBuilds, distinctive, averageDeck, playedDifferently, buildName, buildTags, findPackages, packageGroups, comboDecks, groupCombos, comboPrimer,
  decodeTrends, cardResults, packageResults, withCards, filterCommanders, trendingCommanders, trendingCards, commandersPlaying, risingCards,
  playedMoreWith, winsMoreWith, synergyGraph, packageMap, packageGraph, playRateByMonth, resultsByMonth,
} from "../site/deck.js";

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

test("the printing a line names: set, collector number and finish", () => {
  const { printings } = parse("1 Atraxa, Praetors' Voice (2X2) 190 *CMDR*\n1x Sol Ring (CMM) 400 *F*\n1 Island (PLST) TMP-345 *E*\nDelver of Secrets");
  assert.deepEqual(Object.fromEntries(printings), {
    1: { set: "2x2", number: "190", finish: 0 }, 0: { set: "cmm", number: "400", finish: 1 }, 3: { set: "plst", number: "TMP-345", finish: 2 },
  });
});

test("a card by another name it's printed under (Universes Beyond's)", () => {
  const { cards, unknown } = parseDecklist("1 Glittering Caves of Aglarond\n1 Sol Ring", nameLookup(NAMES, [["Glittering Caves of Aglarond", 6]]));
  assert.deepEqual([...cards].sort(), [0, 6]);
  assert.deepEqual(unknown, []);
});

test("Archidekt categories and *CMDR* markers pick the commander; side boards are left out", () => {
  const archidekt = parse("1x Krenko, Mob Boss (ddt) 52 [Commander{top}]\n1x Sol Ring (c21) 263 [Ramp]\n1x Swords to Plowshares (sta) 10 [Maybeboard{noDeck}{noPrice}]");
  assert.deepEqual(archidekt.commanders, [6]);
  assert.deepEqual([...archidekt.cards].sort(), [0, 6]);
  const marked = parse("1 Sol Ring\n1 Krenko, Mob Boss *CMDR*\n\nSideboard\n1 Swords to Plowshares");
  assert.deepEqual(marked.commanders, [6]);
  assert.deepEqual([...marked.cards].sort(), [0, 6]);
});

test("commanders at the bottom: marked ones count wherever they are; unmarked ones are possible", () => {
  // Moxfield's MTGO export: the commanders in the sideboard, marked or not
  const marked = parse("1 Sol Ring\n1 Island\n\nSIDEBOARD:\n1 Krenko, Mob Boss *CMDR*");
  assert.deepEqual(marked.commanders, [6]);
  assert.deepEqual([...marked.cards].sort(), [0, 3, 6]);
  const sideboard = parse("1 Sol Ring\n1 Island\n\nSIDEBOARD:\n1 Krenko, Mob Boss\n1 Atraxa, Praetors' Voice");
  assert.deepEqual(sideboard.commanders, []);
  assert.deepEqual(sideboard.possible, [6, 1]);
  assert.ok(!sideboard.cards.has(6), "the page adds them if they're a commander with decks");
  // Plain text: after a blank line, at the end
  assert.deepEqual(parse("1 Sol Ring\n1 Island\n\n1 Krenko, Mob Boss").possible, [6]);
  assert.deepEqual(parse("1 Sol Ring\n1 Island\n1 Krenko, Mob Boss").possible, [], "no blank line: nothing to go on");
  assert.deepEqual(parse("1 Sol Ring\n\n1 Island\n1 Krenko, Mob Boss\n1 Swords to Plowshares").possible, [], "3 at the end: not commanders");
  assert.deepEqual(parse("1 Krenko, Mob Boss *CMDR*\n1 Sol Ring\n\n1 Island").possible, [], "one's marked");
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

test("packages: cards played together, but not just for being in the same group of decks, nor the precon", () => {
  // Cards 0 and 1: every third deck plays both; 2: every other deck, apart from them; 3 and 4: the
  // first 50 decks (one group) play both
  const plays = i => [...(i % 3 ? [] : [0, 1]), ...(i % 2 ? [] : [2]), ...(i < 50 ? [3, 4] : [])];
  const gaps = ps => ps.map((p, i) => p - (i ? ps[i - 1] : 0));
  const raw = { cards: [0, 1, 2, 3, 4], decks: Array.from({ length: 100 }, (_, i) => [i, "", "", gaps(plays(i))]) };
  const shard = decodeShard(raw);
  assert.deepEqual(findPackages(shard).map(p => [p.cards.sort(), p.decks]), [[[0, 1], 34], [[3, 4], 50]]);
  assert.deepEqual(findPackages(shard, { groups: shard.decks.map((_, i) => +(i < 50)) }).map(p => p.cards.sort()), [[0, 1]]);
  assert.deepEqual(findPackages(shard, { lands: new Set([0, 1]) }).map(p => p.cards.sort()), [[3, 4]]); // lands don't start one
  assert.deepEqual(findPackages(decodeShard({ ...raw, precon: [3, 1] })).map(p => p.cards.sort()), [[0, 1]]); // 3 and 4: the precon
  // 0 and 1 are staples, 3 isn't
  assert.deepEqual(findPackages(shard, { staples: new Set([0, 1, 4]) }).map(p => p.cards.sort()), [[3, 4]]);
  // Groups: the first 50 decks play two Game Changers (cards 3 and 4), the rest none; too few decks for tuned bands
  assert.deepEqual(new Set(packageGroups(shard, [], { gameChangers: new Set([3, 4]) })), new Set([1, 0]));
  assert.equal(packageGroups(shard, [], { gameChangers: new Set([3, 4]) })[0], 1);
});

test("combos: the decks playing every card (the commander's a given), near-copies as one", () => {
  // Card 9 is the commander; 1 and 2 are in every deck, 3 in half, 4 in none
  const raw = { cards: [1, 2, 3], decks: Array.from({ length: 10 }, (_, i) => [i, "", "", i % 2 ? [0, 1] : [0, 1, 1]]),
    combos: [["a", [9, 1, 2], [], ["Infinite mana"]], ["b", [9, 1, 3], ["Mana Dork"], []], ["c", [9, 1, 4], [], ["Infinite mana", "Lock"]],
      ["d", [2, 1, 9], [], []], ["e", [9, 1, 5], [], ["Win the game"]]] };
  const shard = decodeShard(raw);
  const counted = comboDecks(shard, shard.decks.map((_, d) => d), c => c === 9);
  assert.deepEqual(counted.map(c => [c.id, c.decks]), [["a", 10], ["d", 10], ["b", 5], ["c", 0], ["e", 0]]);
  assert.deepEqual(counted[2].needs, ["Mana Dork"]);
  // d has a's cards; c differs from a in one card, and makes the same first; b needs a Mana Dork, e makes another thing
  const groups = groupCombos(counted);
  assert.deepEqual(groups.map(g => [g.core, g.options.map(o => [o.card, o.decks])]),
    [[[9, 1], [[2, 10], [4, 0]]], [[9, 1, 3], [[null, 5]]], [[9, 1, 5], [[null, 0]]]]);
  assert.deepEqual(groupCombos([{ cards: [5, 6], decks: 3 }]), [{ core: [5, 6], options: [{ card: null, decks: 3, combo: { cards: [5, 6], decks: 3 } }] }]);
});

test("combos for a primer: cards as [[links]], what comes first, steps and result", () => {
  const combo = { id: "1-2", cards: [0, 1], needs: ["Mana Dork"], makes: ["Infinite mana", "Infinite ETB"],
    how: { mana: "{G}", easy: "", notable: "You control a creature.\n", steps: "Tap it, adding {G}{W/U}.\nPay {3}.\nRepeat." } };
  assert.equal(comboPrimer([combo], ["Derevi, Empyrial Tactician", "Brigid, Clachan's Heart // Brigid, Doun's Mind"]), [
    "# Combos", "",
    "## Derevi, Empyrial Tactician + Brigid, Clachan's Heart // Brigid, Doun's Mind", "",
    "**Cards:** [[Derevi, Empyrial Tactician]] + [[Brigid, Clachan's Heart]]", "",
    "**First:**", "- Any Mana Dork", "- You control a creature.", "- [[symbol:g]] available", "",
    "**Steps:**", "1. Tap it, adding [[symbol:g]][[symbol:wu]].", "2. Pay [[symbol:3]].", "3. Repeat.", "",
    "**Result:** Infinite mana, Infinite ETB", "",
  ].join("\n"));
});

test("deck link worker: Moxfield and Archidekt decks become plain decklists", async () => {
  const { default: worker } = await import("../worker/deck-link.js");
  const realFetch = globalThis.fetch;
  const card = (name, quantity = 1, set, cn, finish = "nonFoil") => ({ quantity, finish, card: { name, set, cn } });
  const responses = {
    "https://api2.moxfield.com/v3/decks/all/abc": { name: "Goblins", boards: {
      commanders: { cards: { a: card("Krenko, Mob Boss", 1, "m13", "141") } },
      mainboard: { cards: { b: card("Sol Ring", 1, "cmm", "410", "foil"), c: card("Mountain", 30), e: card("Arcane Signet", 1, "cmm", "367", "etched") } },
      maybeboard: { cards: { d: card("Swords to Plowshares") } } } },
    "https://archidekt.com/api/decks/42/": { name: "Atraxa", categories: [{ name: "Maybeboard", includedInDeck: false }],
      cards: [["Atraxa, Praetors' Voice", ["Commander"], "Normal"], ["Sol Ring", ["Ramp"], "Foil"], ["Doubling Season", ["Maybeboard"], "Normal"]]
        .map(([name, categories, modifier]) => ({ quantity: 1, categories, modifier,
          card: { oracleCard: { name }, edition: { editioncode: "cmm" }, collectorNumber: "1" } })) },
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
    assert.deepEqual(mox, { name: "Goblins", site: "Moxfield",
      list: "1 Krenko, Mob Boss (M13) 141 *CMDR*\n1 Sol Ring (CMM) 410 *F*\n30 Mountain\n1 Arcane Signet (CMM) 367 *E*" });
    const [, arch] = await ask("https://archidekt.com/decks/42/atraxa");
    assert.equal(arch.list, "1 Atraxa, Praetors' Voice (CMM) 1 *CMDR*\n1 Sol Ring (CMM) 1 *F*");
    // The site reads those lines back with their printings
    const { printings } = parseDecklist(mox.list, nameLookup(["Krenko, Mob Boss", "Sol Ring", "Mountain", "Arcane Signet"]));
    assert.deepEqual(Object.fromEntries(printings), { 0: { set: "m13", number: "141", finish: 0 },
      1: { set: "cmm", number: "410", finish: 1 }, 3: { set: "cmm", number: "367", finish: 2 } });
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
  // Two trend-cards/ files (one per color identity), each [commander number, gaps, plays] for its commanders
  withCards(commanders, [[0, [5, 4], [[90, 10], [10, 0], [5, 0], [1, 0]]], [2, [9], [[6], [6], [3], [0]]]]);
  withCards(commanders, [[1, [5, 4], [[20, 0], [20, 0], [12, 0], [6, 0]]]]);
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

  assert.deepEqual(keys(filterCommanders(commanders, { colors: 0b11 })), ["2"]); // exactly WU, not W alone
  assert.deepEqual(keys(filterCommanders(commanders, { colors: 0b1 })), ["1"]);
  assert.deepEqual(keys(filterCommanders(commanders, { colors: 0 })), []); // colorless
  assert.deepEqual(keys(filterCommanders(commanders, { maxPrice: 10000, kind: "single" })), ["2"]);
  assert.deepEqual(keys(filterCommanders(commanders, { themes: new Set([0]), brackets: [2] })), ["3-4"]);
  assert.deepEqual(keys(filterCommanders(commanders, { window: 3, min: 1 })), ["1", "2"]);

  // Card 9, from its row of card-commanders/: commander 0 ("1") in 10 of 100 decks, 2 ("3-4") in 6 of 20
  assert.deepEqual(commandersPlaying(commanders, [0, 10, 2, 6]).map(c => [c.key, c.decks]), [["3-4", 6], ["1", 10]]);
});

test("a commander's rising cards: what its recent decks play more than its decks overall", () => {
  // Six decks all play card 10; only the three newest also play 11
  const shard = decodeShard({ cards: [10, 11], decks: [1, 2, 3, 4, 5, 6].map(id => [id, "", "", id > 3 ? [0, 1] : [0]]) });
  const all = [0, 1, 2, 3, 4, 5];
  assert.deepEqual(risingCards(shard, all, [3, 4, 5]).map(x => [x.p, x.share, x.was]), [[1, 1, 0.5]]);
  assert.deepEqual(risingCards(shard, all, all), []); // the same decks: nothing rises
});

test("tournament results: a card's decks against the commander's other decks, small samples pulled in", () => {
  // Window 0: 100 decks winning 150 of 600 games (25%); window 1 has too few decks to say anything
  const results = {
    windows: [365, 90],
    totals: [[100, 600, 150, 60, 15], [12, 72, 18, 0, 0]],
    cards: [1, 2, 3, 4, 5],
    stats: [
      [50, 300, 100, 30, 12, 0, 0, 0, 0, 0], // wins a third of its games, the rest a sixth
      [5, 30, 20, 0, 0, 0, 0, 0, 0, 0], // in too few decks
      [95, 570, 140, 60, 15, 0, 0, 0, 0, 0], // in too many: too few decks without it
      [20, 120, 30, 12, 3, 0, 0, 0, 0, 0], // wins as often as the rest
      [10, 60, 25, 0, 0, 0, 0, 0, 0, 0], // wins more, but in only 10 decks
    ],
  };
  const byCard = Object.fromEntries(cardResults(results, 0).map(x => [x.card, x]));
  assert.deepEqual(Object.keys(byCard), ["1", "4", "5"]);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(byCard[1].winRate, 1 / 3);
  close(byCard[1].winRateWithout, 1 / 6);
  close(byCard[1].lift, 0.125); // (100 + 25) / 400 - (50 + 25) / 400: 100 games at 25% pulled in on each side
  close(byCard[1].evidence, (1 / 6) / 0.05); // 0.05: the standard error, with a deck's games counted as half
  close(byCard[1].conversion, 0.4);
  close(byCard[1].conversionWithout, 0.1);
  close(byCard[4].lift, 0);
  // A 19-point difference over 10 decks counts for less than a 17-point one over 50
  assert.ok(byCard[5].winRate - byCard[5].winRateWithout > byCard[1].winRate - byCard[1].winRateWithout);
  assert.ok(byCard[5].lift < byCard[1].lift && byCard[5].lift > 0);
  assert.equal(byCard[5].conversion, null); // no events with a top cut
  assert.deepEqual(cardResults(results, 1), []);
});

test("a package of cards: the decks playing all of them against those playing none", () => {
  // Cards 7, 8 and 9; decks: [narrowest window, games, wins, top cut (0 none, 1 missed, 2 made), gaps]
  const lists = {
    cards: [7, 8, 9],
    decks: [
      [0, 6, 3, 2, 0, 1], // 7 and 8, won 3 of 6, made the cut
      [0, 6, 2, 1, 0, 1, 1], // all three
      [1, 6, 0, 1, 0], // only 7: some of 7 and 8
      [0, 6, 1, 0, 2], // only 9: none of 7 and 8
      [3, 6, 6, 0, 2], // only 9, but two years back
    ],
  };
  const result = packageResults(lists, [7, 8], 1);
  assert.deepEqual(result.all, { decks: 2, games: 12, wins: 5, cutDecks: 2, cuts: 1 });
  assert.deepEqual(result.none, { decks: 1, games: 6, wins: 1, cutDecks: 0, cuts: 0 });
  assert.deepEqual(result.some, { decks: 1, games: 6, wins: 0, cutDecks: 1, cuts: 0 });
  assert.ok(result.lift > 0 && result.evidence > 0);
  // One card is the same comparison as cardResults' (here, 9 over every window)
  const nine = packageResults(lists, [9], 3);
  assert.equal(nine.all.decks, 3);
  assert.equal(nine.none.decks, 2);
  // A card no deck plays: nothing to compare
  assert.equal(packageResults(lists, [42], 3).lift, null);
});

test("playedDifferently: the cards decks that made the cut play most more, and less, than those that missed it", () => {
  // 100 decks missed the cut, 50 made it
  const missed = { decks: 100, plays: new Map([[1, 20], [2, 80], [3, 50], [4, 10], [5, 5]]) };
  const made = { decks: 50, plays: new Map([[1, 40], [2, 10], [3, 26], [6, 30], [5, 4]]) };
  const { more, less } = playedDifferently(missed, made, { n: 2 });
  // 1: 20% → 80%, 6: 0% → 60%, 3: 50% → 52%; 2: 80% → 20%, 4: 10% → 0% (under 15% both: left out)
  assert.deepEqual(more.map(r => r.card), [1, 6]);
  assert.deepEqual(less.map(r => r.card), [2]);
  const { evidence, ...one } = more[0];
  assert.deepEqual(one, { card: 1, aDecks: 20, bDecks: 40, a: 0.2, b: 0.8 });
  assert.ok(evidence > 6); // 20% against 80% of these many decks is no chance
  assert.ok(Math.abs(playedDifferently(missed, made).more.find(r => r.card === 3).evidence) < 1); // 50% against 52% could be
  assert.equal(playedDifferently(missed, made).more.length, 3); // and 3, once there's room
  // Only some cards: a deck's own, say
  assert.deepEqual(playedDifferently(missed, made, { only: c => c !== 1 }).more.map(r => r.card), [6, 3]);
});

// 100 decks; card 100 in the first 40. 101: in all 40 and 10 more (50% of decks, 100% with it);
// 102: in 5 of them only; 103: in 4 (too few); 104: every deck; 105: 20 of the 40 and 30 others (50% both ways)
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
const made = i => (i < 30 ? "2026-01-15" : i < 60 ? "2026-03-02" : i < 90 ? "" : "2025-12-31");
const withShard = {
  cards: [100, 101, 102, 103, 104, 105, 106],
  decks: range(0, 100).map(i => [i, "", "", gaps([
    ...(i < 40 ? [0] : []), ...(i < 50 ? [1] : []), ...(i < 5 ? [2] : []), ...(i < 4 ? [3] : []), 4,
    ...((i < 40 ? i < 20 : i < 70) ? [5] : []), ...(i >= 97 ? [6] : [])]), made(i)]),
};

test("played more with: what the decks playing a card play more than all the commander's decks", () => {
  const shard = decodeShard(withShard);
  const rows = playedMoreWith(shard, 100);
  assert.deepEqual(rows.map(r => r.card), [101, 102]);
  const { evidence, ...one } = rows[0];
  assert.deepEqual(one, { card: 101, base: 0.5, with: 1, decks: 40, decksWith: 40 });
  assert.ok(evidence > 2);
  assert.deepEqual(playedMoreWith(withShard, 100), rows); // a raw file is decoded first
  assert.deepEqual(playedMoreWith(shard, 102), []); // only 5 decks play it
  assert.deepEqual(playedMoreWith(shard, 999), []); // no deck does
  assert.deepEqual(playedMoreWith(shard, 100, { min: 4, evidence: 0 }).map(r => r.card), [101, 102, 103]); // 103: 4% -> 10%, 1.9 standard errors
});

test("a card's play rate by month: consecutive months, undated decks left out", () => {
  assert.deepEqual(playRateByMonth(decodeShard(withShard), 100), [
    { month: "2025-12", decks: 10, playing: 0 }, { month: "2026-01", decks: 30, playing: 30 },
    { month: "2026-02", decks: 0, playing: 0 }, { month: "2026-03", decks: 30, playing: 10 }]);
  assert.deepEqual(playRateByMonth(decodeShard(withShard), 999).map(r => r.playing), [0, 0, 0, 0]);
  assert.deepEqual(playRateByMonth(decodeShard({ cards: [1], decks: [[1, "", "", [0], ""]] }), 1), []);
  assert.equal(decodeShard({ ...withShard, months: ["2026-01", [3, 0, 2]] }).months[0], "2026-01");
});

// Tournament decks: [narrowest window, games, wins, cut, ...gaps]; cards 7, 8, 9, 10 at 0..3.
// 30 decks play 7: the 15 with 8 win 4 of 6, the 15 without 1 of 6; 9 is in 5 of them, 10 in every
// other one. 10 decks don't play 7; 10 more with 7 and 8 lost every game, but two years back.
const listDeck = (narrowest, wins, ps) => [narrowest, 6, wins, 0, ...gaps(ps)];
const wonLists = {
  cards: [7, 8, 9, 10],
  decks: [
    ...range(0, 30).map(i => listDeck(0, i < 15 ? 4 : 1, [0, ...(i < 15 ? [1] : []), ...(i < 5 ? [2] : []), ...(i % 2 ? [] : [3])])),
    ...range(0, 10).map(() => listDeck(0, 3, [1, 2])),
    ...range(0, 10).map(() => listDeck(3, 0, [0, 1])),
  ],
};

test("wins more with: among a card's tournament decks, those with another card against those without", () => {
  assert.deepEqual(winsMoreWith(wonLists, 7, 1), []); // 15 a side: under the 20 a pair needs by default
  const rows = winsMoreWith(wonLists, 7, 1, { min: 10 });
  assert.deepEqual(rows.map(r => r.card), [8, 10]); // 9: in only 5
  assert.deepEqual(rows[0].with, { decks: 15, games: 90, wins: 60 });
  assert.deepEqual(rows[0].without, { decks: 15, games: 90, wins: 15 });
  assert.ok(rows[0].lift > 0.2 && rows[0].evidence > 2);
  assert.ok(Math.abs(rows[1].evidence) < 2); // 10: about the same
  // Over every window the old losing decks count too
  const all = winsMoreWith(wonLists, 7, 3, { min: 10 }).find(r => r.card === 8);
  assert.equal(all.with.decks, 25);
  assert.ok(all.lift < rows[0].lift);
  assert.deepEqual(winsMoreWith(wonLists, 7, 1, { min: 5 }).map(r => r.card).sort((a, b) => a - b), [8, 9, 10]);
  assert.deepEqual(winsMoreWith(wonLists, 42, 3, { min: 10 }), []);
});

test("a card's tournament results by month, against all the commander's decks; none in older files", () => {
  const lists = { cards: [7, 8], months: ["2025-11", "2026-01", "", "2026-01"],
    decks: [listDeck(0, 2, [0]), listDeck(0, 3, [0, 1]), listDeck(0, 6, [0]), listDeck(0, 1, [1])] };
  assert.deepEqual(resultsByMonth(lists, 7), [
    { month: "2025-11", decks: 1, games: 6, wins: 2, allDecks: 1, allGames: 6, allWins: 2 },
    { month: "2025-12", decks: 0, games: 0, wins: 0, allDecks: 0, allGames: 0, allWins: 0 },
    { month: "2026-01", decks: 1, games: 6, wins: 3, allDecks: 2, allGames: 12, allWins: 4 }]);
  assert.deepEqual(resultsByMonth(lists, 42).map(r => r.decks), [0, 0, 0]);
  assert.deepEqual(resultsByMonth({ cards: lists.cards, decks: lists.decks }, 7), []);
});

// No line runs within `least` of a node it doesn't join (lines: [[node, node]], nodes with x and y)
function clearOfLines(nodes, lines, least = 0.05) {
  for (const [a, b] of lines) for (const n of nodes) {
    if (n === a || n === b) continue;
    const ux = b.x - a.x, uy = b.y - a.y, t = Math.max(0, Math.min(1, ((n.x - a.x) * ux + (n.y - a.y) * uy) / (ux * ux + uy * uy)));
    const d = Math.hypot(n.x - a.x - t * ux, n.y - a.y - t * uy);
    assert.ok(d >= least, `a line runs ${d.toFixed(3)} from a node`);
  }
}

test("synergy graph: partners around the card, every line a correlation, the Won node to the right", () => {
  // 120 decks, card 100 in the first 60. Among those: 101 and 102 in the even ones, 103 and 104 in
  // every third, 105 in the first 20, 106 in the last 20; each also in 6 of the other 60. 107: every deck.
  const plays = i => i < 60
    ? [0, ...(i % 2 ? [] : [1, 2]), ...(i % 3 ? [] : [3, 4]), ...(i < 20 ? [5] : []), ...(i >= 40 ? [6] : []), 7]
    : [...(i % 10 ? [] : [1, 2, 3, 4, 5, 6]), 7];
  const shard = decodeShard({ cards: range(100, 108), decks: range(0, 120).map(i => [i, "", "", gaps(plays(i))]) });
  // Tournament decks with 100: those with 105 win far more, those with 106 far less; 200 wins more too,
  // but isn't played with 100 enough to be in the graph
  const lists = { cards: [100, 105, 106, 200], decks: range(0, 40).map(i =>
    listDeck(0, i < 20 ? 5 : 1, [0, ...(i < 20 ? [1] : [2]), ...(i < 12 || (i >= 20 && i < 23) ? [3] : [])])) };

  const graph = synergyGraph(shard, lists, 100, 0, { min: 10 });
  assert.deepEqual(graph, synergyGraph(shard, lists, 100, 0, { min: 10 })); // the same every time
  const byCard = new Map(graph.nodes.map(n => [n.card, n]));
  assert.equal(byCard.get(100).kind, "center");
  const ring = graph.nodes.filter(n => n.kind === "partner").map(n => n.card);
  assert.deepEqual([...ring].sort(), [101, 102, 103, 104, 105, 106]);
  assert.deepEqual(graph.won.map(x => x.card).sort(), [105, 106]); // only cards in the graph
  assert.ok(!byCard.has(200) && !byCard.has(107)); // 107: in every deck, so no more with 100 than without
  assert.ok(byCard.get(105).lift > 0 && byCard.get(106).lift < 0);
  const wonNode = byCard.get(null);
  assert.equal(wonNode.kind, "won");
  assert.ok(graph.nodes.every(n => n === wonNode || n.x < wonNode.x));
  // Spokes are each partner's correlation with the card: 101 is in half of 100's decks and few others
  assert.ok(graph.edges.filter(e => e.kind === "spoke").every(e => e.strength >= 0.2 && e.strength <= 1));
  // Every card correlated clearly enough with it (here 6), the strongest n at most
  assert.deepEqual(synergyGraph(shard, null, 100, 0).nodes.length, 7);
  assert.ok(synergyGraph(shard, null, 100, 0, { n: 3 }).nodes.length === 4);
  // Played together: 101 and 102, 103 and 104; 105 and 106 never are, an either/or
  const edge = (a, b) => graph.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  const linked = (a, b) => !!edge(a, b);
  assert.equal(edge(101, 102).kind, "together");
  assert.equal(edge(103, 104).kind, "together");
  assert.equal(edge(105, 106).kind, "apart");
  assert.ok(edge(105, 106).strength < 0);
  assert.ok(graph.edges.filter(e => e.kind === "together").length <= 4); // not every pair: each card's strongest
  assert.ok(graph.edges.every(e => (e.kind === "spoke") === (e.a === 100)));
  assert.ok(ring.every(c => linked(100, c)));
  // Cards played together sit closer than an either/or pair
  const far = (a, b) => Math.hypot(byCard.get(a).x - byCard.get(b).x, byCard.get(a).y - byCard.get(b).y);
  assert.ok(far(101, 102) < far(105, 106) && far(103, 104) < far(105, 106));
  // In the box, no two nodes on top of each other, and no line under a node it doesn't join
  for (const g of [graph, synergyGraph(shard, null, 100, 0), synergyGraph(shard, lists, 100, 0, { n: 12 })]) {
    for (const n of g.nodes) assert.ok(n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1, `${n.card} at ${n.x}, ${n.y}`);
    for (const a of g.nodes) for (const b of g.nodes) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 0.1);
    const at = new Map(g.nodes.map(n => [n.card, n]));
    clearOfLines(g.nodes, [...g.edges.map(e => [at.get(e.a), at.get(e.b)]), ...g.won.map(x => [at.get(null), at.get(x.card)])]);
  }
  // No results: no Won node, the card in the middle
  const plain = synergyGraph(shard, null, 100, 0);
  assert.deepEqual(plain.won, []);
  assert.ok(!plain.nodes.some(n => n.kind === "won"));
  assert.deepEqual(synergyGraph(shard, lists, 999, 0), { nodes: [{ card: 999, x: 0.5, y: 0.5, kind: "center" }], edges: [], won: [] });
});

// 200 decks, cards 10..22 (positions 0..12). Packages: [10, 11] in decks 0..79; [12, 13] in 0..59 (mostly
// with it); [14, 15] in 100..159 (never with either: another build); [16, 17] in 4 only; [18, 19] in every
// fifth deck (with any of them by chance). 20: every deck; 21: decks 0..69; 22: 0..9 and 100..109.
const pkgPlays = i => [
  ...(i < 80 ? [10, 11] : []), ...(i < 60 ? [12, 13] : []), ...(i >= 100 && i < 160 ? [14, 15] : []),
  ...(i >= 190 && i < 194 ? [16, 17] : []), ...(i % 5 ? [] : [18, 19]), 20, ...(i < 70 ? [21] : []),
  ...(i < 10 || (i >= 100 && i < 110) ? [22] : [])].sort((a, b) => a - b);
const pkgShard = { cards: range(10, 23), decks: range(0, 200).map(i => [i, "", "", gaps(pkgPlays(i).map(c => c - 10))]) };
const pkgs = [[10, 11], [12, 13], [14, 15], [16, 17], [18, 19]].map(cards => ({ cards }));
// Tournament decks: 20 with 10, 11 and 21 win 5 of 6; 20 with 10 and 11 only win 1 of 6 (12 in half of
// each); 20 with 14 and 15 win 1 of 6
const pkgLists = { cards: [10, 11, 12, 14, 15, 21], decks: [
  ...range(0, 20).map(i => listDeck(0, 5, [0, 1, ...(i < 10 ? [2] : []), 5])),
  ...range(0, 20).map(i => listDeck(0, 1, [0, 1, ...(i < 10 ? [2] : [])])),
  ...range(0, 20).map(() => listDeck(0, 1, [3, 4])),
] };
const spread = g => {
  for (const n of g.nodes) assert.ok(n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1, `${n.key} at ${n.x}, ${n.y}`);
  for (const a of g.nodes) for (const b of g.nodes) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 0.08, `${a.key} on ${b.key}`);
};
const edgeOf = (g, a, b) => g.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));

test("package map: packages run by enough decks, linked by how often decks run both, the Won node to the right", () => {
  const shard = decodeShard(pkgShard), all = range(0, 200);
  const map = packageMap(shard, pkgs, all, { lists: pkgLists, w: 0 });
  assert.deepEqual(map, packageMap(shard, pkgs, all, { lists: pkgLists, w: 0 })); // the same every time
  assert.deepEqual(packageMap(pkgShard, pkgs, all, { lists: pkgLists, w: 0 }), map); // a raw file is decoded first
  const byKey = new Map(map.nodes.map(n => [n.key, n]));
  // [16, 17]: in 4 decks, under the floor (3% of 200)
  assert.deepEqual(map.nodes.filter(n => n.kind === "package").map(n => n.key).sort(), ["p0", "p1", "p2", "p4"]);
  assert.deepEqual([byKey.get("p0").decks, byKey.get("p2").decks, byKey.get("p4").decks], [80, 60, 40]);
  assert.deepEqual(byKey.get("p0").name, [10, 11]);
  assert.deepEqual(byKey.get("p0").cards, [10, 11]);
  // Together: [10, 11] and [12, 13]; either/or: [14, 15] with both; [18, 19]: with none in particular
  assert.ok(edgeOf(map, "p0", "p1").strength > 0.5);
  assert.ok(edgeOf(map, "p0", "p2").strength < -0.1 && edgeOf(map, "p1", "p2").strength < -0.1);
  assert.ok(!map.edges.some(e => e.a === "p4" || e.b === "p4"));
  // Won: decks with [10, 11] win more than those without, [14, 15] less; [12, 13] isn't in the lists
  assert.deepEqual(map.won.map(x => x.key).sort(), ["p0", "p2"]);
  assert.ok(byKey.get("p0").lift > 0 && byKey.get("p2").lift < 0 && !("lift" in byKey.get("p1")));
  assert.ok(map.won.every(x => x.tested.every(k => k >= 10)) && byKey.get("p0").tested === map.won.find(x => x.key === "p0").tested);
  assert.equal(byKey.get("won").x, 1);
  assert.ok(map.nodes.every(n => n.key === "won" || n.x < 1)); // the Won node rightmost
  clearOfLines(map.nodes, [...map.edges.map(e => [byKey.get(e.a), byKey.get(e.b)]), ...map.won.map(x => [byKey.get("won"), byKey.get(x.key)])]);
  // The n most run; within a build (members); a pasted deck's share of each
  assert.deepEqual(packageMap(shard, pkgs, all, { n: 2 }).nodes.map(n => n.key).sort(), ["p0", "p1"]);
  assert.deepEqual(packageMap(shard, pkgs, range(100, 200)).nodes.map(n => n.key).sort(), ["p2", "p3", "p4"]); // 4 of 100 is enough
  const mine = packageMap(shard, pkgs, all, { have: new Set([10, 11, 12]) });
  assert.deepEqual(mine.nodes.map(n => [n.key, n.have]).sort(), [["p0", "all"], ["p1", "some"], ["p2", "none"], ["p4", "none"]]);
  assert.ok(!("have" in map.nodes[0]));
  // No lists: no Won node, the ring in the middle
  const plain = packageMap(shard, pkgs, all);
  assert.deepEqual(plain.won, []);
  assert.ok(!plain.nodes.some(n => n.kind === "won"));
  for (const g of [map, plain, mine, packageMap(shard, pkgs, all, { n: 2 }), packageMap(shard, pkgs.slice(0, 1), all)]) spread(g);
  assert.deepEqual(packageMap(shard, [], all), { nodes: [], edges: [], won: [] });
});

test("package graph: its cards in the middle, what decks running it add around them, the Won node to the right", () => {
  const shard = decodeShard(pkgShard), all = range(0, 200);
  const graph = packageGraph(shard, [10, 11], all, { lists: pkgLists, w: 0 });
  assert.deepEqual(graph, packageGraph(shard, [10, 11], all, { lists: pkgLists, w: 0 })); // the same every time
  const byKey = new Map(graph.nodes.map(n => [n.key, n]));
  const center = byKey.get("pkg");
  assert.equal(center.kind, "package");
  assert.equal(center.decks, 80);
  assert.deepEqual(graph.nodes.filter(n => n.kind === "core").map(n => n.card).sort(), [10, 11]);
  // Extras: what decks running it play far more than the others (21, 12, 13); not 20 (every deck),
  // 22 (barely more), 14 (less)
  const extras = graph.nodes.filter(n => n.kind === "extra");
  assert.deepEqual(extras.map(n => n.card).sort(), [12, 13, 21]);
  const { base, with: share, decksWith } = byKey.get("c21");
  assert.deepEqual({ base, share, decksWith }, { base: 0, share: 70 / 80, decksWith: 70 });
  assert.deepEqual(packageGraph(shard, [10, 11], all, { extra: 1 }).nodes.filter(n => n.kind === "extra").map(n => n.card), [21]);
  // Lines: the core pair, and a spoke to each extra (none to the core: its decks all play it)
  assert.equal(edgeOf(graph, "c10", "c11").strength, 1);
  assert.ok(extras.every(n => edgeOf(graph, "pkg", n.key).strength >= 0.2));
  assert.equal(graph.edges.length, 1 + extras.length);
  // Won: the package (its decks win more than those without it) and 21 (its decks with 21 win more); not 12
  assert.deepEqual(graph.won.map(x => x.key).sort(), ["c21", "pkg"]);
  assert.ok(center.lift > 0 && byKey.get("c21").lift > 0 && !("lift" in byKey.get("c12")));
  assert.ok(graph.won.every(x => x.tested.length === 2) && center.tested.every(k => k >= 10));
  assert.equal(byKey.get("won").x, 1);
  // No spoke (or the line to Won) runs over a card of the package, and its two cards don't face each other
  // across the middle
  const angle = n => Math.atan2(n.y - center.y, n.x - center.x);
  const cores = graph.nodes.filter(n => n.kind === "core");
  for (const c of cores) for (const t of [...extras, byKey.get("won")]) {
    assert.ok(Math.abs(Math.atan2(Math.sin(angle(c) - angle(t)), Math.cos(angle(c) - angle(t)))) > 0.35, `${c.key} by ${t.key}`);
  }
  assert.ok(Math.abs((cores[0].x + cores[1].x) / 2 - center.x) > 0.08);
  // A pasted deck: which cards it has
  const mine = packageGraph(shard, [10, 11], all, { have: new Set([10, 21]) });
  assert.deepEqual(mine.nodes.filter(n => n.card).map(n => [n.card, n.have]).sort((a, b) => a[0] - b[0]),
    [[10, true], [11, false], [12, false], [13, false], [21, true]]);
  // Three cards: every pair linked; an either/or pair is negative
  const three = packageGraph(shard, [10, 11, 14], all);
  assert.equal(three.nodes[0].decks, 0);
  assert.ok(edgeOf(three, "c10", "c14").strength < 0);
  assert.equal(three.edges.length, 3); // run by no deck: no extras
  for (const g of [graph, mine, three, packageGraph(shard, [10, 11, 21], all), packageGraph(shard, [10, 11], all, { lists: pkgLists, w: 0, extra: 12 })]) spread(g);
  assert.equal(packageGraph(shard, [10, 999], all).nodes[0].decks, 0);
  // On a pasted deck's page, just the cards it plays: here one of the package's two, and an extra it has
  const pick = packageGraph(pkgShard, [10, 11], range(0, 200), { have: new Set([10, 21]), mine: true });
  assert.deepEqual(pick.nodes.filter(n => n.kind !== "package").map(n => n.card).sort((a, b) => a - b), [10, 21]);
  assert.deepEqual(pick.nodes[0].cards, [10, 11]); // the package itself, whole
  assert.ok(pick.edges.every(e => e.a !== "c11" && e.b !== "c11"));
});
