// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, buildIndex, search, mainTerms } from "./site/search.js";

const terms = ["W", "R", "G", "Creature", "Instant", "Land", "Artifact", "Flying", "Ward", "Elf", "Dragon",
  "Spirit", "draw", "Card Advantage", "Mana Ramp", "Token Creation", "CMC_0", "CMC_1", "CMC_2", "CMC_3",
  "CMC_6", "token:W", "token:Creature", "token:Flying", "token:Spirit",
  "tag:tutor", "tag:tutor-instant", "tag:hate", "tag:hate-nonbasic-land", "tag:hate-artifact",
  "tag:removal", "tag:removal-artifact", "tag:token-doubler", "tag:sweeper"];
const data = {
  terms, formats: ["standard", "modern"],
  tag_names: { "tag:sweeper": ["boardwipe", "wipe", "mass removal"], "tag:token-doubler": ["token doubler"] },
  cards: [
    // [name, type_line, cmc, id, color_identity, legal_bitmask, edhrec_rank, term_indices]
    ["Common Flyer", "Creature — Bird", 2, "a", "W", 3, 50, [0, 3, 7, 18]],
    ["Popular Flyer", "Creature — Bird", 2, "b", "W", 2, 1, [0, 3, 7, 18]],
    ["Elf Dork", "Creature — Elf", 1, "c", "G", 3, 5, [2, 3, 9, 14, 17]],
    ["Big Dragon", "Creature — Dragon", 6, "d", "R", 3, 9, [1, 3, 7, 10, 20]],
    ["Opt", "Instant", 1, "e", "", 3, 2, [4, 12, 13, 17]],
    ["Mystical Tutor", "Instant", 1, "f", "U", 3, 3, [4, 17, 25, 26]],
    ["Demonic Tutor", "Sorcery", 2, "g", "B", 3, 4, [18, 25]],
    ["Blood Moon", "Enchantment", 3, "h", "R", 3, 6, [19, 27, 28]],
    ["Wasteland", "Land", 0, "i", "", 3, 7, [5, 16, 27, 28, 30]],
    ["Collector Ouphe", "Creature — Ouphe", 2, "j", "G", 3, 8, [2, 3, 18, 27, 29]],
    ["Shatter", "Instant", 2, "k", "R", 3, 10, [1, 4, 18, 30, 31]],
    ["Spirit Maker", "Sorcery", 3, "l", "W", 3, 11, [0, 15, 19, 21, 22, 23, 24]],
    ["Doubling Season", "Enchantment", 5, "m", "G", 3, 12, [2, 32]],
    ["Wrath", "Sorcery", 4, "n", "W", 3, 13, [0, 30, 33]],
  ],
};
const index = buildIndex(data);
const parsed = q => mainTerms(parseQuery(q, index));
const names = (q, filters) => search(index, parseQuery(q, index), filters, q).map(r => r.card.name);

test("parseQuery matches whole words and plurals", () => {
  assert.deepEqual(parsed("cheap green elves that ramp"), ["CMC_0", "CMC_1", "CMC_2", "CMC_3", "Mana Ramp", "G", "Elf"]);
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
  // Unrecognized query falls back to name search
  assert.deepEqual(names("dork"), ["Elf Dork"]);
  assert.deepEqual(names(""), []);
});
