import {
  parseQuery, buildIndex, search, nameSearch, mainTerms, termsNeeded, decodePosting, parsePrice,
} from "./search.js";

const PAGE_SIZE = 30;
const CHUNK = 256; // cards per index/c/<chunk>.json (CHUNK in build_index.py)
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
// Only the files a search needs are downloaded (and cached by the browser): see build_index.py
const status = $("status");
status.textContent = "Loading…";
let index;
try {
  const [meta, columns] = await Promise.all([getJson("index/meta.json"), getJson("index/columns.json")]);
  index = buildIndex(meta, columns);
} catch {
  status.textContent = "Couldn't load card data. Please refresh to try again.";
  throw new Error("index failed to load");
}
$("updated").textContent = ` (updated ${index.updated.slice(0, 10)})`;
for (const f of index.formats) $("format").append(el("option", { value: f, textContent: f[0].toUpperCase() + f.slice(1) }));
$("format").value = params.get("f") ?? "";

const query = params.get("q") ?? "";
const num = k => (params.get(k) ? Number(params.get(k)) : null);
const filters = {
  colors: params.getAll("c"), types: params.getAll("t"), format: params.get("f") ?? "",
  min: num("min"), max: num("max"), maxPrice: num("price") ?? parsePrice(query),
};
const groups = parseQuery(query, index);
let results = [];
if (groups.length) {
  const postings = await Promise.all(termsNeeded(index, groups).map(async t => [t, decodePosting(await getJson(`index/t/${t}.json`))]));
  results = search(index, groups, new Map(postings), filters);
} else if (query.trim() && filters.maxPrice === null) {
  results = nameSearch(index, await getJson("index/names.json"), query, filters);
} else if (params.size) {
  results = search(index, [], new Map(), filters); // filters only
}

status.textContent = "";
const chips = mainTerms(groups).map(featureLabel);
if (filters.maxPrice !== null) chips.push(`under $${filters.maxPrice}`);
if (chips.length) {
  status.append("Recognized: ", ...chips.map(c => el("span", { className: "feature", textContent: c })));
} else if (query) {
  status.append(`No card features recognized, so showing cards named “${query}”.`);
}
if (params.size) status.append(el("div", { textContent: `${results.length.toLocaleString()} cards found` }));

// Card names and Scryfall ids come in chunks of CHUNK cards, fetched as results are shown
const chunks = new Map();
async function cardInfo(card) {
  const k = Math.floor(card / CHUNK);
  if (!chunks.has(k)) chunks.set(k, getJson(`index/c/${k}.json`));
  const [name, id] = (await chunks.get(k))[card % CHUNK];
  return { name, id };
}

let shown = 0;
async function showMore() {
  const page = results.slice(shown, shown + PAGE_SIZE);
  shown += PAGE_SIZE;
  $("more").hidden = shown >= results.length;
  const infos = await Promise.all(page.map(r => cardInfo(r.card)));
  page.forEach(({ card, score }, i) => {
    const { name, id } = infos[i];
    const price = index.columns.price[card];
    const tile = el("button", { className: "card", onclick: () => openCard(id) },
      el("img", { src: imageUrl(id), alt: name, loading: "lazy" }),
      el("span", { className: "card-name", textContent: name }),
      el("span", { className: "card-price", textContent: price >= 0 ? `from $${(price / 100).toFixed(2)}` : "no price" }));
    if (score !== null) {
      tile.append(el("span", { className: "similarity", textContent: `${Math.round(score * 100)}% match` }),
        el("span", { className: "progress-container" },
          el("span", { className: "progress-bar", style: `width:${score * 100}%` })));
    }
    $("gallery").append(tile);
  });
}
$("more").onclick = showMore;
showMore();

// === Browse all search terms ===
// Each term links to a search for it
function termLink(term) {
  if (term.startsWith("CMC_")) {
    const mv = term.slice(4).replace("_plus", "");
    return `?min=${mv}` + (term.endsWith("_plus") ? "" : `&max=${mv}`);
  }
  // Tags, tokens and colors are searched by their readable label ("hate nonbasic land", "white")
  const q = /^(tag|token):/.test(term) || COLOR_NAMES[term] ? featureLabel(term) : term;
  return "?" + new URLSearchParams({ q });
}

function showTerms() {
  if (!$("term-list").childElementCount) {
    for (const [category, ids] of index.categories) {
      const items = ids.map(i => {
        const term = index.terms[i];
        const label = featureLabel(term);
        const aliases = index.tag_names?.[term] ?? [];
        const a = el("a", { className: "term", href: termLink(term), title: aliases.join(", ") },
          label, el("small", { textContent: ` ${index.counts[i].toLocaleString()}` }));
        a.dataset.search = [label, ...aliases].join(" ").toLowerCase();
        return a;
      });
      $("term-list").append(el("details", { open: ids.length <= 60 },
        el("summary", { textContent: `${category} (${ids.length.toLocaleString()})` }),
        el("div", { className: "term-items" }, ...items)));
    }
  }
  $("terms").showModal();
}
$("browse-terms").onclick = showTerms;
$("term-filter").oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  for (const a of $("term-list").querySelectorAll(".term")) a.hidden = q !== "" && !a.dataset.search.includes(q);
  for (const d of $("term-list").children) d.open = q !== "" ? !!d.querySelector(".term:not([hidden])") : d.querySelectorAll(".term").length <= 60;
};
$("terms").addEventListener("click", e => { if (e.target === $("terms")) $("terms").close(); });

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
