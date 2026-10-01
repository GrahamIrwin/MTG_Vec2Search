import {
  parseQuery, buildIndex, search, expandQuery, loadEmbeddings, semanticSearch, SMART_MODEL,
} from "./search.js";

const PAGE_SIZE = 30;
// Same version the build uses (package.json), so query and card embeddings match
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js";
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
const $ = id => document.getElementById(id);
const form = $("search");
const params = new URLSearchParams(location.search);

// The URL holds the search, so every search is a shareable link and Back works
for (const input of form.elements) {
  if (input.type === "checkbox") input.checked = params.getAll(input.name).includes(input.value);
  else if (input.name && params.has(input.name)) input.value = params.get(input.name);
}
form.addEventListener("submit", e => {
  e.preventDefault();
  location.search = new URLSearchParams([...new FormData(form)].filter(([, v]) => v));
});

const themeToggle = $("theme-toggle");
const showThemeLabel = () =>
  (themeToggle.textContent = document.documentElement.dataset.theme === "dark" ? "☀ Light" : "☾ Dark");
themeToggle.onclick = () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("theme", theme); } catch {}
  showThemeLabel();
};
showThemeLabel();

const imageUrl = id => `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`;

function featureLabel(f) {
  if (f.startsWith("CMC_")) return `Mana value ${f.slice(4).replace("_plus", "+")}`;
  return COLOR_NAMES[f] ?? f;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// === Search ===
const status = $("status");
status.textContent = "Loading card data…";
let data;
try {
  data = await (await fetch("cards.json")).json();
} catch {
  status.textContent = "Couldn't load card data. Please refresh to try again.";
  throw new Error("cards.json failed to load");
}
const index = buildIndex(data);
$("updated").textContent = ` (updated ${data.updated.slice(0, 10)})`;
for (const f of data.formats) $("format").append(el("option", { value: f, textContent: f[0].toUpperCase() + f.slice(1) }));
$("format").value = params.get("f") ?? "";

const query = params.get("q") ?? "";
const num = k => (params.get(k) ? Number(params.get(k)) : null);
const filters = {
  colors: params.getAll("c"), types: params.getAll("t"), format: params.get("f") ?? "",
  min: num("min"), max: num("max"),
};
const features = parseQuery(query, index.terms);
const smart = params.get("smart") === "1" && query.trim() !== "";
let results;
let note = "";
if (smart) {
  try {
    results = await smartSearch();
  } catch (err) {
    console.error(err);
    note = "Smart search couldn't load, so these are regular results.";
  }
}
results ??= search(index, features, filters, query);

status.textContent = "";
if (note) status.append(el("div", { textContent: note }));
if (features.length) {
  status.append("Recognized: ", ...features.map(f => el("span", { className: "feature", textContent: featureLabel(f) })));
} else if (query && !(smart && !note)) {
  status.append(`No card features recognized, so showing cards named “${query}”.`);
}
if (params.size) {
  const count = results.length.toLocaleString();
  status.append(el("div", { textContent: smart && !note ? `Smart search: top ${count} matches` : `${count} cards found` }));
}

// Loads the embedding model (cached by the browser after the first time) and the card vectors
async function smartSearch() {
  status.textContent = "Loading smart search…";
  const [{ pipeline }, buffer] = await Promise.all([
    import(TRANSFORMERS_URL),
    fetch("embeddings.bin").then(r => {
      if (!r.ok) throw new Error(`embeddings.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const extract = await pipeline("feature-extraction", SMART_MODEL, {
    dtype: "q8",
    progress_callback: p => {
      if (p.status === "progress" && p.file.endsWith(".onnx")) {
        status.textContent = `Loading smart search model… ${Math.round(p.progress)}%`;
      }
    },
  });
  const { data } = await extract(expandQuery(query, features), { pooling: "mean", normalize: true });
  const emb = loadEmbeddings(buffer, index.cards.length);
  // Smart scores aren't percentages, so no match bar
  return semanticSearch(index, emb, data, features, filters, query).map(r => ({ card: r.card, score: null }));
}

let shown = 0;
function showMore() {
  for (const { card, score } of results.slice(shown, shown + PAGE_SIZE)) {
    const tile = el("button", { className: "card", onclick: () => openCard(card.id) },
      el("img", { src: imageUrl(card.id), alt: card.name, loading: "lazy" }),
      el("span", { className: "card-name", textContent: card.name }));
    if (score !== null) {
      tile.append(el("span", { className: "similarity", textContent: `${Math.round(score * 100)}% match` }),
        el("span", { className: "progress-container" },
          el("span", { className: "progress-bar", style: `width:${score * 100}%` })));
    }
    $("gallery").append(tile);
  }
  shown += PAGE_SIZE;
  $("more").hidden = shown >= results.length;
}
$("more").onclick = showMore;
showMore();

// === Card details (fetched from Scryfall on click) ===
const modal = $("modal");
const foil = $("foil");
let current = null;
let cadRate = null;

modal.addEventListener("click", e => { if (e.target === modal) modal.close(); });
foil.onchange = updatePrice;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function openCard(id) {
  $("printings").replaceChildren();
  $("modal-name").textContent = "Loading…";
  $("modal-set").textContent = $("price").textContent = "";
  $("modal-img").src = imageUrl(id);
  modal.showModal();
  try {
    cadRate ??= getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD")
      .then(d => d.rates.CAD).catch(() => null);
    showPrinting(await getJson(`https://api.scryfall.com/cards/${id}`));
    const prints = await getJson(current.prints_search_uri);
    $("printings").replaceChildren(...prints.data.map(p =>
      el("button", { className: "version-button", textContent: `${p.set_name} (${p.collector_number})`, onclick: () => showPrinting(p) })));
    markCurrent();
  } catch {
    $("modal-name").textContent = "Couldn't load card details from Scryfall.";
  }
}

function showPrinting(card) {
  current = card;
  const face = card.image_uris ?? card.card_faces[0].image_uris;
  $("modal-img").src = face.normal;
  $("modal-img").alt = card.name;
  $("modal-name").textContent = card.name;
  $("modal-set").textContent = `${card.set_name} · ${card.rarity}`;
  $("scryfall-link").href = card.scryfall_uri;
  $("foil-label").hidden = !card.prices.usd_foil;
  foil.checked = !card.prices.usd && !!card.prices.usd_foil;
  updatePrice();
  markCurrent();
}

function markCurrent() {
  for (const b of $("printings").children) {
    b.toggleAttribute("aria-current", b.textContent === `${current.set_name} (${current.collector_number})`);
  }
}

async function updatePrice() {
  $("foil-wrapper").classList.toggle("foil-shimmer", foil.checked);
  const usd = foil.checked ? current.prices.usd_foil : current.prices.usd;
  if (!usd) {
    $("price").textContent = "Price unavailable";
    return;
  }
  const text = `$${usd} USD`;
  $("price").textContent = text;
  const rate = await cadRate;
  // Skip if the user switched printing/foil while the rate was loading
  if (rate && $("price").textContent === text) $("price").textContent += ` · $${(usd * rate).toFixed(2)} CAD`;
}
