// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseQuery, buildIndex, search, nameSearch, mainTerms, decodePosting, parsePrice, isBudget, sortResults,
  randomSearches,
} from "./site/search.js";

const terms = ["W", "R", "G", "Creature", "Instant", "Land", "Artifact", "Flying", "Ward", "Elf", "Dragon",
  "Spirit", "draw", "Card Advantage", "tag:ramp", "Token Creation", "CMC_0", "CMC_1", "CMC_2", "CMC_3",
  "CMC_6", "token:W", "token:Creature", "token:Flying", "token:Spirit",
  "tag:tutor", "tag:tutor-instant", "tag:hate", "tag:hate-nonbasic-land", "tag:hate-artifact",
  "tag:removal", "tag:removal-artifact", "tag:token-doubler", "tag:sweeper", "tag:wheel", "tag:draw-hate",
  "tag:pure-draw"];
const data = {
  terms, formats: ["standard", "modern"],
  tag_names: {
    "tag:sweeper": ["boardwipe", "wipe", "mass removal"], "tag:token-doubler": ["token doubler"],
    "tag:pure-draw": ["draw card"], "tag:hate-nonbasic-land": ["nonbasic land hate", "punish nonbasic land"],
  },
  cards: [
    // [name, type_line, cmc, id, color_identity, legal_bitmask, edhrec_rank, term_indices, price_cents]
    ["Common Flyer", "Creature — Bird", 2, "a", "W", 3, 50, [0, 3, 7, 18], 10],
    ["Popular Flyer", "Creature — Bird", 2, "b", "W", 2, 1, [0, 3, 7, 18]],
    ["Elf Dork", "Creature — Elf", 1, "c", "G", 3, 5, [2, 3, 9, 14, 17]],
    ["Big Dragon", "Creature — Dragon", 6, "d", "R", 3, 9, [1, 3, 7, 10, 20]],
    ["Opt", "Instant", 1, "e", "", 3, 2, [4, 12, 13, 17]],
    ["Mystical Tutor", "Instant", 1, "f", "U", 3, 3, [4, 17, 25, 26]],
    ["Demonic Tutor", "Sorcery", 2, "g", "B", 3, 4, [18, 25]],
    ["Blood Moon", "Enchantment", 3, "h", "R", 3, 6, [19, 27, 28], 900],
    ["Wasteland", "Land", 0, "i", "", 3, 7, [5, 16, 27, 28, 30], 1500],
    ["Collector Ouphe", "Creature — Ouphe", 2, "j", "G", 3, 8, [2, 3, 18, 27, 29]],
    ["Shatter", "Instant", 2, "k", "R", 3, 10, [1, 4, 18, 30, 31], 25],
    ["Spirit Maker", "Sorcery", 3, "l", "W", 3, 11, [0, 15, 19, 21, 22, 23, 24]],
    ["Doubling Season", "Enchantment", 5, "m", "G", 3, 12, [2, 32]],
    ["Wrath", "Sorcery", 4, "n", "W", 3, 13, [0, 30, 33]],
    ["Tithe", "Enchantment", 2, "o", "W", 3, 14, [0, 27, 35]],
    ["Divination", "Sorcery", 3, "p", "U", 3, 15, [12, 13, 19, 36]],
    ["Inspiration", "Instant", 4, "q", "U", 3, 16, [4, 12, 36]],
    ["Windfall", "Sorcery", 3, "r", "U", 3, 17, [12, 13, 19, 34]],
  ],
};
// Builds the split index (meta, columns, postings) the way build_index.py does, cards in popularity order
const cards = [...data.cards].sort((a, b) => a[6] - b[6]);
const types = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Land", "Battle"];
const postings = new Map(terms.map((_, t) => [t, Int32Array.from(cards.flatMap((c, i) => (c[7].includes(t) ? [i] : [])))]));
const index = buildIndex({
  ...data, types, updated: "", categories: [], counts: terms.map((_, t) => postings.get(t).length),
}, {
  identity: cards.map(c => [..."WUBRG"].reduce((m, x, i) => (c[4].includes(x) ? m | (1 << i) : m), 0)),
  types: cards.map(c => types.reduce((m, t, i) => (c[1].includes(t) ? m | (1 << i) : m), 0)),
  cmc: cards.map(c => c[2]), legal: cards.map(c => c[5]), price: cards.map(c => c[8] ?? -1),
});
const parsed = q => mainTerms(parseQuery(q, index));
// Same flow as app.js: features -> ranked search; otherwise a card-name search
function names(q, filters = {}) {
  const groups = parseQuery(q, index);
  const results = groups.length ? search(index, groups, postings, filters)
    : q.trim() ? nameSearch(index, cards.map(c => c[0]), q, filters) : [];
  return results.map(r => cards[r.card][0]);
}

test("parseQuery matches whole words and plurals", () => {
  assert.deepEqual(parsed("cheap green elves that ramp"), ["tag:ramp", "CMC_0", "CMC_1", "CMC_2", "CMC_3", "G", "Elf"]);
  assert.deepEqual(parsed("red flying dragons"), ["R", "Flying", "Dragon"]);
  // "entered" contains "red", "toward" contains "ward", "midnight" contains "mid"
  assert.deepEqual(parsed("it entered toward midnight"), []);
});

test("oracle tags: slang, plurals, specificity, and tag words not counted as card types", () => {
  // Singular and plural give the same results; the specific tag outranks the general one
  assert.deepEqual(parsed("instant tutors"), ["tag:tutor-instant"]);
  assert.deepEqual(names("instant tutors"), names("instant tutor"));
  assert.deepEqual(names("instant tutors").slice(0, 2), ["Mystical Tutor", "Demonic Tutor"]);
  // "punishes" means hate; "non-basic lands" is what's hated, not a Land card
  assert.deepEqual(parsed("punishes non-basic lands"), ["tag:hate-nonbasic-land"]);
  assert.deepEqual(names("punishes non-basic lands").slice(0, 2), ["Blood Moon", "Wasteland"]);
  // "artifact hate": hosers first, artifact removal next (hate also stands for removal)
  assert.deepEqual(names("artifact hate").slice(0, 2), ["Collector Ouphe", "Shatter"]);
  // Aliases: "board wipe" -> sweeper
  assert.equal(names("board wipe")[0], "Wrath");
  assert.equal(names("double the number of tokens")[0], "Doubling Season");
});

test("verb forms and common phrasings", () => {
  // "drawing" -> draw; of two equally long matches, the rarer tag (draw-hate) wins over pure-draw
  assert.deepEqual(parsed("punish opponents for drawing cards"), ["tag:draw-hate"]);
  // The phrase becomes "wheel", so it doesn't also trigger the discard/draw concepts
  assert.deepEqual(parsed("discard my hand and draw seven"), ["tag:wheel"]);
  // Verb forms match both ways: "drawing" finds the rules-text term "draw", "flying" stays the keyword
  assert.deepEqual(parsed("drawing flying"), ["Flying", "draw"]);
  // Every tag that says "nonbasic" also says "land", so "nonbasic hate" implies land
  assert.deepEqual(parsed("nonbasic hate"), ["tag:hate-nonbasic-land"]);
});

test("prices: query limits, filter, and index files", () => {
  assert.equal(parsePrice("artifact hate under $2"), 2);
  assert.equal(parsePrice("removal less than 5 dollars"), 5);
  assert.equal(parsePrice("burn under C$3"), 3);
  assert.equal(parsePrice("ramp under €2.50"), 2.5);
  assert.equal(parsePrice("creatures under 3 mana"), null);
  assert.equal(parsePrice("board wipe"), null);
  assert.ok(isBudget("budget board wipe") && !isBudget("board wipe"));
  // Cards without a known price are left out when there's a limit
  assert.deepEqual(names("punishes nonbasic lands", { maxPrice: 10 }), ["Blood Moon"]);
  assert.deepEqual(names("artifact hate", { maxPrice: 1 }), ["Shatter"]);
  assert.deepEqual([...decodePosting([3, 1, 4])], [3, 4, 8]);
});

test("token makers: words after makes/creates describe the token", () => {
  assert.deepEqual(parsed("makes flying white creatures"), ["token:W", "token:Creature", "token:Flying", "Token Creation"]);
  assert.equal(names("makes flying white creatures")[0], "Spirit Maker");
  assert.equal(names("white spirit tokens")[0], "Spirit Maker");
});

test("search ranks by IDF-weighted coverage, then popularity, and applies filters", () => {
  // Full matches tie, so the most popular card wins
  assert.deepEqual(names("flying").slice(0, 3), ["Popular Flyer", "Big Dragon", "Common Flyer"]);
  assert.deepEqual(names("flying", { colors: ["R"] }), ["Big Dragon"]);
  assert.deepEqual(names("flying", { format: "standard" }), ["Big Dragon", "Common Flyer"]);
  assert.deepEqual(names("creature", { min: 2, max: 3 }), ["Popular Flyer", "Collector Ouphe", "Common Flyer"]);
  // Colorless cards fit any color filter
  assert.deepEqual(names("draw", { colors: ["G"] }), ["Opt"]);
  // Colorless alone keeps only colorless-identity cards
  assert.deepEqual(names("land", { colors: ["C"] }), ["Wasteland"]);
  // Unrecognized query falls back to name search
  assert.deepEqual(names("dork"), ["Elf Dork"]);
  assert.deepEqual(names(""), []);
});

test("sorting: by price, date and name, keeping only strong matches", () => {
  const ranked = search(index, parseQuery("punishes nonbasic lands", index), postings);
  const order = (sort, extra) => sortResults(ranked, sort, index, extra).map(r => cards[r.card][0]);
  assert.deepEqual(order("match").slice(0, 2), ["Blood Moon", "Wasteland"]);
  // Only cards within 75% of the best match are kept (the plain-"hate" partial matches drop out);
  // unknown prices sort last
  assert.deepEqual(order("price-asc"), ["Blood Moon", "Wasteland"]);
  assert.deepEqual(order("price-desc"), ["Wasteland", "Blood Moon"]);
  const released = cards.map((_, i) => 1000 - i); // later in popularity order = older here
  assert.deepEqual(order("newest", { released }), ["Blood Moon", "Wasteland"]);
  assert.deepEqual(order("oldest", { released }), ["Wasteland", "Blood Moon"]);
  assert.deepEqual(order("name", { names: cards.map(c => c[0]) }), ["Blood Moon", "Wasteland"]);
  assert.deepEqual(order("mv-desc"), ["Blood Moon", "Wasteland"]);
  // Filter-only results (no score) are all kept
  assert.equal(sortResults(search(index, [], postings, {}), "price-asc", index).length, cards.length);
});

test("random searches: readable names for terms on enough cards, each of which finds its term", () => {
  const meta = {
    terms: ["Flying", "Dragon", "token:Treasure", "tag:mana-rock", "tag:cycle-thing", "tag:rare-thing", "W"],
    counts: [500, 40, 60, 110, 30, 3, 900],
    tag_names: { "tag:mana-rock": ["manarock", "manarock-ccc"] },
    categories: [["Colors", [6]], ["Keywords", [0]], ["Subtypes", [1]], ["Tokens it makes", [2]], ["Tags", [3, 4, 5]]],
  };
  assert.deepEqual(randomSearches(meta), [["flying"], ["dragon"], ["makes treasure tokens"], ["mana rock", "manarock", "manarock ccc"]]);
  // Each random search for a real tag/token parses back to it
  assert.deepEqual(parsed("makes spirit tokens"), ["token:Spirit", "Token Creation"]);
  assert.deepEqual(parsed("hate nonbasic land"), ["tag:hate-nonbasic-land"]);
});
