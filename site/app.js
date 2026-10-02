import { parseQuery, buildIndex, search, mainTerms } from "./search.js";

const PAGE_SIZE = 30;
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
  if (f.startsWith("tag:")) return f.slice(4).replaceAll("-", " ");
  if (f.startsWith("token:")) return `makes ${(COLOR_NAMES[f.slice(6)] ?? f.slice(6)).toLowerCase()} tokens`;
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
const groups = parseQuery(query, index);
const results = search(index, groups, filters, query);

status.textContent = "";
if (groups.length) {
  status.append("Recognized: ", ...mainTerms(groups).map(f => el("span", { className: "feature", textContent: featureLabel(f) })));
} else if (query) {
  status.append(`No card features recognized, so showing cards named “${query}”.`);
}
if (params.size) status.append(el("div", { textContent: `${results.length.toLocaleString()} cards found` }));

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
