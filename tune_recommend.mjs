// Tunes which similar decks vote in recommend(): hide HIDE cards of real decks and see how many
// come back in the top TOP adds. The deck itself and its near-copies are left out of its shard,
// or a copy would hand every hidden card back. node tune_recommend.mjs [shards per size] [decks per shard]
import { readdirSync, readFileSync } from "node:fs";
import { decodeShard, similarDecks, recommend, COPY, NEIGHBORS } from "./site/deck.js";

const HIDE = 10, TOP = 20;
const PER_SIZE = +(process.argv[2] ?? 40), DECKS_PER_SHARD = +(process.argv[3] ?? 8);
const SIZES = [[5, 30], [30, 100], [100, 300], [300, Infinity]];

// Ways to pick the voters (recommend's neighbors option): top k is { ratio: 0, min: k, max: k }
const PICKS = {
  "top 25 (before)": { ratio: 0, min: 25, max: 25 },
  "now": NEIGHBORS,
  ...Object.fromEntries([0.2, 0.25, 0.35].flatMap(ratio => [[10, 100], [10, 300]].map(([min, max]) =>
    [`≥${ratio}×best, ${min}–${max}`, { ratio, min, max }]))),
};

let seed = 1; // mulberry32, so runs compare
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const jaccard = (a, b) => { const s = new Set(a); const both = b.reduce((n, p) => n + s.has(p), 0); return both / (s.size + b.length - both); };

const dir = "site/decks/";
const shards = readdirSync(dir).filter(f => /^[\d-]+\.json$/.test(f)).map(f => JSON.parse(readFileSync(dir + f)));
const hits = SIZES.map(() => Object.fromEntries(Object.keys(PICKS).map(k => [k, 0])));
const voters = SIZES.map(() => Object.fromEntries(Object.keys(PICKS).map(k => [k, 0])));
const tried = SIZES.map(() => 0);
const diffs = Object.fromEntries(Object.keys(PICKS).map(k => [k, []])); // hits minus the first pick's, per test
SIZES.forEach(([lo, hi], b) => {
  for (const raw of shuffle(shards.filter(s => s.decks.length >= lo && s.decks.length < hi)).slice(0, PER_SIZE)) {
    const all = decodeShard(raw).decks;
    for (const t of shuffle([...all.keys()]).slice(0, DECKS_PER_SHARD)) {
      const test = all[t].cards;
      if (test.length < 40) continue;
      const rest = raw.decks.filter((_, d) => d !== t && jaccard(test, all[d].cards) < COPY);
      if (rest.length < 5) continue;
      const shard = decodeShard({ ...raw, decks: rest });
      const hidden = new Set(shuffle([...test]).slice(0, HIDE).map(p => raw.cards[p]));
      const mine = [...test].map(p => raw.cards[p]).filter(c => !hidden.has(c));
      const similar = similarDecks(shard, mine);
      tried[b]++;
      let base;
      for (const [name, pick] of Object.entries(PICKS)) {
        const { adds, neighbors } = recommend(shard, similar, mine, { neighbors: pick });
        const found = adds.slice(0, TOP).filter(a => hidden.has(a.card)).length;
        base ??= found;
        diffs[name].push(found - base);
        hits[b][name] += found;
        voters[b][name] += neighbors;
      }
    }
  }
});

console.log(`Hidden cards found in the top ${TOP} adds, of ${HIDE} (avg voters)\n`);
const head = ["", ...SIZES.map(([lo, hi], b) => `${lo}–${hi === Infinity ? "" : hi} decks (${tried[b]})`), "all", "vs first ± 2 SE"];
console.log(head.map((h, i) => (i ? h.padStart(22) : h.padEnd(36))).join(""));
for (const name of Object.keys(PICKS)) {
  const cells = SIZES.map((_, b) => `${(hits[b][name] / tried[b]).toFixed(2)} (${Math.round(voters[b][name] / tried[b])})`);
  const all = SIZES.reduce((s, _, b) => s + hits[b][name], 0) / tried.reduce((a, b) => a + b, 0);
  const d = diffs[name], mean = d.reduce((a, b) => a + b, 0) / d.length;
  const se = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (d.length - 1) / d.length);
  console.log(name.padEnd(36) + [...cells, all.toFixed(3), `${mean >= 0 ? "+" : ""}${mean.toFixed(3)} ± ${(2 * se).toFixed(3)}`].map(c => c.padStart(22)).join(""));
}
