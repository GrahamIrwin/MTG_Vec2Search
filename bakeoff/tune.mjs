// Bake-off step 3: run the real semanticSearch (search.js) on int8 embeddings.
// Usage: A=0.1 B=0.05 node bakeoff/tune.mjs <embeddings file>
import { pipeline } from "@huggingface/transformers";
import { readFileSync } from "node:fs";
import { parseQuery, buildIndex, expandQuery, semanticSearch, SMART } from "../site/search.js";
import { MODELS } from "./embed.mjs";

const QUERIES = readFileSync("bakeoff/compare.mjs", "utf8").match(/const QUERIES = \[([\s\S]*?)\];/)[1]
  .split("\n").map(l => l.trim().replace(/^"|",?$/g, "")).filter(Boolean);
if (process.env.A) SMART.coverageWeight = Number(process.env.A);
if (process.env.B) SMART.popularityWeight = Number(process.env.B);

const index = buildIndex(JSON.parse(readFileSync("site/cards.json", "utf8")));
const f32 = new Float32Array(readFileSync(process.argv[2]).buffer.slice(0));
let max = 0;
for (const v of f32) max = Math.max(max, Math.abs(v));
const scale = 127 / max;
const emb = { scale, vectors: Int8Array.from(f32, v => Math.round(v * scale)), dims: 384 };
const extract = await pipeline("feature-extraction", MODELS.minilm.id, { dtype: "q8" });

for (const q of QUERIES) {
  const features = parseQuery(q, index.terms);
  const qv = (await extract(expandQuery(q, features), { pooling: "mean", normalize: true })).data;
  const top = semanticSearch(index, emb, qv, features).slice(0, 6);
  console.log(`${q.padEnd(44)} ${top.map(r => r.card.name.split(" // ")[0]).join(" | ")}`);
}
