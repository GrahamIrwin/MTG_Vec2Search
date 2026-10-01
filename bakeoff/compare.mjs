// Bake-off step 2: compare current search vs semantic search per model.
// Usage: node bakeoff/compare.mjs [modelKeys...]
import { pipeline } from "@huggingface/transformers";
import { readFileSync, existsSync } from "node:fs";
import { parseQuery, buildIndex, search } from "../site/search.js";
import { MODELS } from "./embed.mjs";

const QUERIES = [
  "punish opponents for drawing cards",
  "sacrifice creatures for value",
  "creatures that get bigger when I gain life",
  "copy a spell",
  "steal an opponent's creature",
  "take an extra turn",
  "protect my creatures from removal",
  "untap all my lands",
  "search my library for any card",
  "creatures lose all abilities",
  "deal damage whenever a creature dies",
  "win the game",
  "double the number of tokens",
  "opponents can't cast spells during my turn",
  "draw a card when it enters",
  "discard my hand and draw seven",
  "lifelink angels",
  "cheap green creature that ramps",
  "board wipe",
  "flying dragons",
];
const TOP = 6;
const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MODELS);

const data = JSON.parse(readFileSync("site/cards.json", "utf8"));
const index = buildIndex(data);
const names = index.cards.map(c => c.name.split(" // ")[0]);
index.cards.forEach((c, i) => (c.i = i));
const [HYBRID, A, B] = [!!process.env.A, Number(process.env.A ?? 0), Number(process.env.B ?? 0)];
// 1 for the most popular card, falling to 0 for the least popular / unranked
const pop = index.cards.map(c => (c.rank === Infinity ? 0 : 1 - Math.log(c.rank) / Math.log(40000)));

const models = [];
for (const key of keys) {
  if (!existsSync(`bakeoff/${key}.f32`)) continue;
  const emb = new Float32Array(readFileSync(`bakeoff/${key}.f32`).buffer.slice(0));
  const { id, pooling, queryPrefix } = MODELS[key];
  models.push({ key, emb, pooling, queryPrefix, extract: await pipeline("feature-extraction", id, { dtype: "q8" }) });
}

for (const q of QUERIES) {
  console.log(`\n### ${q}`);
  const cur = search(index, parseQuery(q, index.terms), {}, q).slice(0, TOP);
  console.log(`  current: ${cur.map(r => names[index.cards.indexOf(r.card)]).join(" | ") || "(nothing)"}`);
  for (const m of models) {
    const qv = (await m.extract(m.queryPrefix + q, { pooling: m.pooling, normalize: true })).data;
    const scores = new Float32Array(names.length);
    for (let i = 0; i < names.length; i++) {
      let s = 0;
      for (let d = 0; d < 384; d++) s += qv[d] * m.emb[i * 384 + d];
      scores[i] = s;
    }
    const top = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, TOP);
    console.log(`  ${m.key.padEnd(7)}: ${top.map(i => names[i]).join(" | ")}`);
    if (!HYBRID) continue;
    // Hybrid: semantic + feature coverage boost + popularity prior
    const cov = new Float32Array(names.length);
    for (const r of search(index, parseQuery(q, index.terms), {}, q)) cov[r.card.i] = r.score ?? 0;
    const hy = scores.map((s, i) => s + A * cov[i] + B * pop[i]);
    const htop = [...hy.keys()].sort((a, b) => hy[b] - hy[a]).slice(0, TOP);
    console.log(`  ${(m.key + "+h").padEnd(7)}: ${htop.map(i => names[i]).join(" | ")}`);
  }
}
