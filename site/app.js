import {
  parseQuery, buildIndex, search, nameSearch, mainTerms, termsNeeded, decodePosting, parsePrice,
  SORTS, sortResults,
} from "./search.js";

const PAGE_SIZE = 30;
const CHUNK = 256; // cards per index/c/<chunk>.json (CHUNK in build_index.py)
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
const $ = id => document.getElementById(id);
const form = $("search");
const params = new URLSearchParams(location.search);
const searching = [...params.keys()].some(k => k !== "sort");

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const imageUrl = id => `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`;
const year = days => new Date(Date.UTC(1993, 0, 1) + days * 864e5).getUTCFullYear();

// Readable, lowercase labels for terms: "tag:hate-nonbasic-land" -> "hate nonbasic land"
function featureLabel(f) {
  if (f.startsWith("CMC_")) return `mana value ${f.slice(4).replace("_plus", "+")}`;
  if (f.startsWith("tag:")) return f.slice(4).replaceAll("-", " ");
  if (f.startsWith("token:")) return `makes ${(COLOR_NAMES[f.slice(6)] ?? f.slice(6)).toLowerCase()} tokens`;
  return (COLOR_NAMES[f] ?? f).toLowerCase();
}

// === The form: the URL holds the search, so every search is a shareable link and Back works ===
for (const input of form.elements) {
  if (input.type === "checkbox") input.checked = params.getAll(input.name).includes(input.value);
  else if (input.name && params.has(input.name)) input.value = params.get(input.name);
}
form.addEventListener("submit", e => {
  e.preventDefault();
  const next = new URLSearchParams([...new FormData(form)].filter(([, v]) => v));
  if (params.get("sort")) next.set("sort", params.get("sort"));
  location.search = next;
});

// "/" jumps to the search box
document.addEventListener("keydown", e => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || document.querySelector("dialog[open]")) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  e.preventDefault();
  $("q").focus();
});

const activeFilters = params.getAll("c").length + params.getAll("t").length
  + ["min", "max", "price", "f"].filter(k => params.get(k)).length;
if (activeFilters) {
  $("filter-count").textContent = activeFilters;
  $("filter-count").hidden = false;
  $("filters").open = true;
}
$("clear-filters").href = "?" + new URLSearchParams(params.get("q") ? { q: params.get("q") } : {});

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

// === Index files: each is downloaded only when something needs it (see build_index.py) ===
let metaPromise;
function getMeta() {
  metaPromise ??= getJson("index/meta.json").then(meta => {
    $("updated").textContent = ` (updated ${meta.updated.slice(0, 10)})`;
    for (const f of meta.formats) $("format").append(el("option", { value: f, textContent: f[0].toUpperCase() + f.slice(1) }));
    $("format").value = params.get("f") ?? "";
    return meta;
  });
  return metaPromise;
}
$("filters").addEventListener("toggle", () => $("filters").open && getMeta());

// === Search ===
const message = text => {
  $("message").textContent = text;
  $("message").hidden = !text;
};
$("intro").hidden = searching;
$("results").hidden = !searching;

let index;
let results = [];
let sorted = [];
let sort = SORTS[params.get("sort")] ? params.get("sort") : "match";
const sortData = {};

async function runSearch() {
  const query = params.get("q") ?? "";
  const num = k => (params.get(k) ? Number(params.get(k)) : null);
  const filters = {
    colors: params.getAll("c"), types: params.getAll("t"), format: params.get("f") ?? "",
    min: num("min"), max: num("max"), maxPrice: num("price") ?? parsePrice(query),
  };
  const groups = parseQuery(query, index);
  if (groups.length) {
    const postings = await Promise.all(termsNeeded(index, groups).map(async t => [t, decodePosting(await getJson(`index/t/${t}.json`))]));
    results = search(index, groups, new Map(postings), filters);
  } else if (query.trim() && filters.maxPrice === null) {
    results = nameSearch(index, await getJson("index/names.json"), query, filters);
  } else {
    results = search(index, [], new Map(), filters); // filters only
  }

  const chips = mainTerms(groups).map(featureLabel);
  if (filters.maxPrice !== null) chips.push(`under $${filters.maxPrice}`);
  if (chips.length) {
    $("recognized").replaceChildren(el("span", { className: "label", textContent: "Matched" }),
      ...chips.map(c => el("span", { className: "term-chip", textContent: c })));
  } else if (query) {
    $("recognized").replaceChildren(el("span", { className: "muted", textContent: `Cards named “${query}”` }));
  }

  $("sort").replaceChildren(...Object.entries(SORTS).map(([value, label]) => el("option", { value, textContent: label })));
  $("sort").value = sort;
  await render();
}

$("sort").onchange = async () => {
  sort = $("sort").value;
  const next = new URLSearchParams(location.search);
  if (sort === "match") next.delete("sort");
  else next.set("sort", sort);
  history.replaceState(null, "", "?" + next);
  await render();
};

async function render() {
  if (sort === "newest" || sort === "oldest") sortData.released ??= await getJson("index/released.json");
  if (sort === "name") sortData.names ??= await getJson("index/names.json");
  sorted = sortResults(results, sort, index, sortData);
  $("count").textContent = sorted.length < results.length
    ? `${sorted.length.toLocaleString()} closest of ${results.length.toLocaleString()} matches`
    : `${sorted.length.toLocaleString()} ${sorted.length === 1 ? "card" : "cards"}`;
  message(sorted.length ? "" : "No cards match that. Try fewer filters, or describe it another way.");
  $("gallery").replaceChildren();
  shown = 0;
  await showMore();
}

// Card names and Scryfall ids come in chunks of CHUNK cards, fetched as results are shown
const chunks = new Map();
async function cardInfo(card) {
  const k = Math.floor(card / CHUNK);
  if (!chunks.has(k)) chunks.set(k, getJson(`index/c/${k}.json`));
  const [name, id] = (await chunks.get(k))[card % CHUNK];
  return { name, id };
}

let shown = 0;
let loading = false;
async function showMore() {
  if (loading || shown >= sorted.length) return;
  loading = true;
  const list = sorted;
  const page = list.slice(shown, shown + PAGE_SIZE);
  const infos = await Promise.all(page.map(r => cardInfo(r.card)));
  if (list !== sorted) { // re-sorted while loading: start over with the new order
    loading = false;
    return showMore();
  }
  page.forEach(({ card, score }, i) => {
    const { name, id } = infos[i];
    const price = index.columns.price[card];
    const img = el("img", { alt: name, loading: "lazy", decoding: "async" });
    img.onload = () => img.classList.add("loaded");
    img.src = imageUrl(id);
    const detail = sortData.released && (sort === "newest" || sort === "oldest") ? String(year(sortData.released[card]))
      : score !== null ? `${Math.round(score * 100)}% match` : "";
    const tile = el("button", { className: "card", type: "button", onclick: () => openCard(id) },
      el("span", { className: "card-art" }, img),
      el("span", { className: "card-name", textContent: name }),
      el("span", { className: "card-meta" },
        el("span", { textContent: price >= 0 ? `$${(price / 100).toFixed(2)}` : "No price" }),
        el("span", { textContent: detail })));
    if (score !== null && sort === "match") {
      tile.append(el("span", { className: "match-bar" }, el("span", { style: `width:${score * 100}%` })));
    }
    tile.style.setProperty("--i", i);
    $("gallery").append(tile);
  });
  shown += page.length;
  $("more").hidden = shown >= sorted.length;
  loading = false;
}
$("more").onclick = showMore;
// More results load as you scroll near the end
new IntersectionObserver(entries => entries[0].isIntersecting && showMore(), { rootMargin: "800px" })
  .observe($("sentinel"));

// === Browse all search terms ===
function termLink(term) {
  if (term.startsWith("CMC_")) {
    const mv = term.slice(4).replace("_plus", "");
    return `?min=${mv}` + (term.endsWith("_plus") ? "" : `&max=${mv}`);
  }
  // Tags, tokens and colors are searched by their readable label ("hate nonbasic land", "white")
  const q = /^(tag|token):/.test(term) || COLOR_NAMES[term] ? featureLabel(term) : term;
  return "?" + new URLSearchParams({ q });
}

$("browse-terms").onclick = async () => {
  $("terms").showModal();
  if ($("term-list").childElementCount) return;
  const meta = await getMeta();
  for (const [category, ids] of meta.categories) {
    const items = ids.map(i => {
      const term = meta.terms[i];
      const label = featureLabel(term);
      const aliases = meta.tag_names?.[term] ?? [];
      const a = el("a", { className: "term", href: termLink(term), title: aliases.join(", ") },
        label, el("small", { textContent: meta.counts[i].toLocaleString() }));
      a.dataset.search = [label, ...aliases].join(" ").toLowerCase();
      return a;
    });
    $("term-list").append(el("details", { open: ids.length <= 60 },
      el("summary", {}, category, el("small", { textContent: ids.length.toLocaleString() })),
      el("div", { className: "term-items" }, ...items)));
  }
};
$("term-filter").oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  for (const a of $("term-list").querySelectorAll(".term")) a.hidden = q !== "" && !a.dataset.search.includes(q);
  for (const d of $("term-list").children) {
    d.hidden = q !== "" && !d.querySelector(".term:not([hidden])");
    d.open = q !== "" || d.querySelectorAll(".term").length <= 60;
  }
};

// Clicking the dimmed area outside a dialog closes it
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
}

// === Card details (fetched from Scryfall on click) ===
const modal = $("modal");
const foil = $("foil");
let current = null;
let cadRate = null;
foil.onchange = updatePrice;

async function openCard(id) {
  $("printings").replaceChildren();
  $("modal-name").textContent = "Loading…";
  $("modal-type").textContent = $("modal-set").textContent = $("price").textContent = "";
  $("foil-label").hidden = true;
  $("modal-img").src = imageUrl(id);
  modal.showModal();
  try {
    cadRate ??= getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD")
      .then(d => d.rates.CAD).catch(() => null);
    showPrinting(await getJson(`https://api.scryfall.com/cards/${id}`));
    const prints = await getJson(current.prints_search_uri);
    $("printings").replaceChildren(...prints.data.map(p => {
      const button = el("button", { type: "button", onclick: () => showPrinting(p) },
        el("span", { className: "set", textContent: p.set_name }),
        el("span", { className: "cost", textContent: printPrice(p) }),
        el("span", { className: "detail", textContent: `${p.set.toUpperCase()} #${p.collector_number} · ${p.released_at.slice(0, 4)}` }));
      button.dataset.id = p.id;
      return el("li", {}, button);
    }));
    markCurrent();
  } catch {
    $("modal-name").textContent = "Couldn't load card details from Scryfall.";
  }
}

const printPrice = p => (p.prices.usd ? `$${p.prices.usd}` : p.prices.usd_foil ? `$${p.prices.usd_foil} foil` : "—");

function showPrinting(card) {
  current = card;
  const face = card.image_uris ?? card.card_faces[0].image_uris;
  $("modal-img").src = face.normal;
  $("modal-img").alt = card.name;
  $("modal-name").textContent = card.name;
  $("modal-type").textContent = card.type_line;
  $("modal-set").textContent = `${card.set_name} · ${card.rarity[0].toUpperCase() + card.rarity.slice(1)} · ${card.released_at.slice(0, 4)}`;
  $("scryfall-link").href = card.scryfall_uri;
  $("foil-label").hidden = !card.prices.usd_foil || !card.prices.usd;
  foil.checked = !card.prices.usd && !!card.prices.usd_foil;
  updatePrice();
  markCurrent();
}

function markCurrent() {
  for (const b of $("printings").querySelectorAll("button")) b.toggleAttribute("aria-current", b.dataset.id === current.id);
}

async function updatePrice() {
  $("foil-wrapper").classList.toggle("foil-shimmer", foil.checked);
  const usd = foil.checked ? current.prices.usd_foil : current.prices.usd;
  if (!usd) {
    $("price").textContent = "No current price";
    return;
  }
  const text = `$${usd}` + (foil.checked ? " foil" : "");
  $("price").textContent = text;
  const rate = await cadRate;
  // Skip if the user switched printing/foil while the rate was loading
  if (rate && $("price").textContent === text) $("price").textContent += `  ·  $${(usd * rate).toFixed(2)} CAD`;
}

// === Start: everything above is set up, so run the search in the URL ===
if (searching) {
  message("Searching…");
  try {
    const [meta, columns] = await Promise.all([getMeta(), getJson("index/columns.json")]);
    index = buildIndex(meta, columns);
    await runSearch();
  } catch (err) {
    console.error(err);
    message("Couldn't load the card index. Please refresh to try again.");
  }
}
