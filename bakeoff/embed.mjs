// Bake-off step 1: embed every card in site/cards.json with one model.
// Usage: node bakeoff/embed.mjs <key>   (key from MODELS below)
import { pipeline } from "@huggingface/transformers";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export const MODELS = {
  minilm: { id: "Xenova/all-MiniLM-L6-v2", pooling: "mean", queryPrefix: "" },
  bge: { id: "Xenova/bge-small-en-v1.5", pooling: "cls", queryPrefix: "Represent this sentence for searching relevant passages: " },
  mxbai: { id: "mixedbread-ai/mxbai-embed-xsmall-v1", pooling: "mean", queryPrefix: "" },
};

export function cardTexts() {
  const byId = new Map();
  for (const line of gunzipSync(readFileSync("oracle_cards.jsonl.gz")).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    const text = c.oracle_text ?? (c.card_faces ?? []).map(f => f.oracle_text ?? "").join("\n");
    byId.set(c.id, process.env.NONAME ? `${c.type_line ?? ""}\n${text}` : `${c.name}\n${c.type_line ?? ""}\n${text}`);
  }
  return JSON.parse(readFileSync("site/cards.json", "utf8")).cards.map(c => byId.get(c[3]));
}

if (import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  const key = process.argv[2];
  const { id, pooling } = MODELS[key];
  const extract = await pipeline("feature-extraction", id, { dtype: "q8" });
  const texts = cardTexts();
  const out = new Float32Array(texts.length * 384);
  const t0 = Date.now();
  // Batch similar-length texts together so little time is spent on padding
  const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
  for (let i = 0; i < order.length; i += 64) {
    const batch = order.slice(i, i + 64);
    const emb = await extract(batch.map(j => texts[j]), { pooling, normalize: true });
    batch.forEach((j, k) => out.set(emb.data.subarray(k * 384, (k + 1) * 384), j * 384));
    if (i % 3200 === 0) console.log(key, i, `${Math.round((Date.now() - t0) / 1000)}s`);
  }
  writeFileSync(`bakeoff/${key}${process.env.NONAME ? "-noname" : ""}.f32`, Buffer.from(out.buffer));
  console.log(key, "done", texts.length, `${Math.round((Date.now() - t0) / 1000)}s`);
}
