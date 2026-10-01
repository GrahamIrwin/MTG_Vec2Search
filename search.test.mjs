// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, buildIndex, search } from "./site/search.js";

const terms = ["W", "R", "G", "Creature", "Instant", "Flying", "Ward", "Elf", "Dragon", "draw",
  "Card Advantage", "Mana Ramp", "CMC_0", "CMC_1", "CMC_2", "CMC_3", "CMC_6"];

test("parseQuery matches whole words and plurals", () => {
  assert.deepEqual(parseQuery("cheap green elves that ramp", terms),
    ["G", "Elf", "Mana Ramp", "CMC_0", "CMC_1", "CMC_2", "CMC_3"]);
  assert.deepEqual(parseQuery("red flying dragons", terms), ["R", "Flying", "Dragon"]);
  // "entered" contains "red", "toward" contains "ward", "midnight" contains "mid"
  assert.deepEqual(parseQuery("it entered toward midnight", terms), []);
});

test("search ranks by IDF-weighted query coverage, then popularity, and applies filters", () => {
  const data = {
    terms, formats: ["standard", "modern"],
    cards: [
      // [name, type_line, cmc, id, color_identity, legal_bitmask, edhrec_rank, term_indices]
      ["Common Flyer", "Creature — Bird", 2, "a", "W", 3, 50, [0, 3, 5, 14]],
      ["Popular Flyer", "Creature — Bird", 2, "b", "W", 2, 1, [0, 3, 5, 14]],
      ["Elf Dork", "Creature — Elf", 1, "c", "G", 3, 5, [2, 3, 7, 11, 13]],
      ["Big Dragon", "Creature — Dragon", 6, "d", "R", 3, 9, [1, 3, 5, 8, 16]],
      ["Opt", "Instant", 1, "e", "", 3, 2, [4, 9, 10, 13]],
    ],
  };
  const index = buildIndex(data);
  const names = (features, filters, q) => search(index, features, filters, q).map(r => r.card.name);

  // Full matches tie, so the most popular card wins
  assert.deepEqual(names(["Flying"]), ["Popular Flyer", "Big Dragon", "Common Flyer"]);
  // Partial matches: the rarer feature (Dragon, 1 card) outweighs the commoner one (W, 2 cards)
  assert.deepEqual(names(["Dragon", "W"]), ["Big Dragon", "Popular Flyer", "Common Flyer"]);
  // Any one requested mana value counts as a full match on that part of the query
  assert.equal(search(index, ["Flying", "CMC_1", "CMC_2"]).find(r => r.card.name === "Popular Flyer").score, 1);
  assert.deepEqual(names(["Flying"], { colors: ["R"] }), ["Big Dragon"]);
  assert.deepEqual(names(["Flying"], { format: "standard" }), ["Big Dragon", "Common Flyer"]);
  assert.deepEqual(names(["Creature"], { min: 2, max: 3 }), ["Popular Flyer", "Common Flyer"]);
  // Colorless cards fit any color filter
  assert.deepEqual(names(["draw"], { colors: ["G"] }), ["Opt"]);
  // Unrecognized query falls back to name search
  assert.deepEqual(names([], {}, "dork"), ["Elf Dork"]);
  assert.deepEqual(names([], {}, ""), []);
});
