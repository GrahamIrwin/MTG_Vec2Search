// Embeds each card's rules text for smart search. Run after build_index.py:  node embed_cards.mjs
// Writes site/embeddings.bin (float32 scale, then one int8 vector per card, in cards.json order)
// and embeddings-keys.json (text hash per card). Vectors for unchanged cards are reused from the
// live site, so weekly builds only embed new or errata'd cards.
import { pipeline } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { SMART_MODEL } from "./site/search.js";

const DIMS = 384;
// Normalized MiniLM components stay under ~0.3, so this keeps full int8 precision (values are clamped)
const SCALE = 400;
// Where to fetch last build's vectors from (override to test locally)
const LIVE = process.env.EMBED_CACHE_URL ?? "https://grahamirwin.github.io/MTG_Vec2Search/";

// Type line + rules text. Card names are left out: in testing they pulled in cards like
// "Ramp" or "Sticker Sheet" instead of cards that actually do the thing.
export function cardText(c) {
  const text = c.oracle_text ?? (c.card_faces ?? []).map(f => f.oracle_text ?? "").join("\n");
  return `${c.type_line ?? ""}\n${text}`;
}

const hash = text => createHash("sha1").update(SMART_MODEL + text).digest("base64url").slice(0, 12);

async function previousVectors() {
  try {
    const [keys, bin] = await Promise.all([
      fetch(LIVE + "embeddings-keys.json").then(r => (r.ok ? r.json() : [])),
      fetch(LIVE + "embeddings.bin").then(r => (r.ok ? r.arrayBuffer() : new ArrayBuffer(4))),
    ]);
    const vectors = new Int8Array(bin, 4);
    if (vectors.length !== keys.length * DIMS) return new Map();
    return new Map(keys.map((k, i) => [k, vectors.subarray(i * DIMS, (i + 1) * DIMS)]));
  } catch {
    return new Map();
  }
}

const byId = new Map();
for (const line of gunzipSync(readFileSync("oracle_cards.jsonl.gz")).toString("utf8").split("\n")) {
  if (line.trim()) {
    const c = JSON.parse(line);
    byId.set(c.id, cardText(c));
  }
}
const texts = JSON.parse(readFileSync("site/cards.json", "utf8")).cards.map(c => byId.get(c[3]));
const keys = texts.map(hash);

const previous = await previousVectors();
const out = new Int8Array(texts.length * DIMS);
const todo = [];
keys.forEach((k, i) => (previous.has(k) ? out.set(previous.get(k), i * DIMS) : todo.push(i)));
console.log(`Reusing ${texts.length - todo.length} vectors, embedding ${todo.length} cards...`);

if (todo.length) {
  const extract = await pipeline("feature-extraction", SMART_MODEL, { dtype: "q8" });
  // Batch similar-length texts together so little time is spent on padding
  todo.sort((a, b) => texts[a].length - texts[b].length);
  for (let i = 0; i < todo.length; i += 64) {
    const batch = todo.slice(i, i + 64);
    const { data } = await extract(batch.map(j => texts[j]), { pooling: "mean", normalize: true });
    batch.forEach((j, k) => {
      for (let d = 0; d < DIMS; d++) {
        out[j * DIMS + d] = Math.max(-127, Math.min(127, Math.round(data[k * DIMS + d] * SCALE)));
      }
    });
    if (i % 6400 === 0) console.log(`  ${i}/${todo.length}`);
  }
}

const header = new Float32Array([SCALE]);
writeFileSync("site/embeddings.bin", Buffer.concat([Buffer.from(header.buffer), Buffer.from(out.buffer)]));
writeFileSync("site/embeddings-keys.json", JSON.stringify(keys));
console.log(`Wrote site/embeddings.bin (${((out.length + 4) / 1e6).toFixed(1)} MB)`);
