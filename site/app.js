import {
  parseQuery, buildIndex, search, nameSearch, mainTerms, termsNeeded, decodePosting, parsePrice,
  isBudget, BUDGET_USD, SORTS, sortResults, randomSearches,
} from "./search.js";
import { CURRENCIES, detectCurrency, usdRate, moneyFormatter } from "./currency.js";
import {
  nameLookup, parseDecklist, decodeShard, similarDecks, foldCopies, recommend, closestCommanders,
  findBuilds, playCounts, distinctive, averageDeck, buildName, buildTags,
  decodeTrends, withCards, filterCommanders, trendingCommanders, trendingCards, commandersPlaying, risingCards,
  cardResults, MIN_RESULT_DECKS,
} from "./deck.js";

const PAGE_SIZE = 30;
const CHUNK = 256; // cards per index/c/<chunk>.json (CHUNK in build_index.py)
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
// Searches that show off what the engine understands; the search box placeholder picks from these
const EXAMPLES = [
  "makes flying white creatures", "punishes non-basic lands", "artifact hate", "instant tutors",
  "budget board wipe", "double the number of tokens", "punish opponents for drawing cards",
  "opponents can't cast spells during my turn", "win the game", "discard my hand and draw seven",
  "cheap green elves that ramp", "steal an opponent's creature", "graveyard hate", "lifelink angels",
  "extra turns", "mana rocks", "copy a spell", "sacrifice outlet", "flying dragons", "blink creatures",
  "counterspell under $1", "creatures that untap lands", "reanimate creatures", "extra combat",
  "goblins that make treasure", "fog effects", "tap down creatures", "land destruction",
];
const pick = list => list[Math.floor(Math.random() * list.length)];
const $ = id => document.getElementById(id);
const form = $("search");
const params = new URLSearchParams(location.search);
const deckMode = params.has("deck");
const commanderKey = params.get("commander");
const cardKey = params.get("card"); // a card's page: the commanders whose decks play it
const commandersMode = params.has("commanders") || commanderKey !== null || cardKey !== null;
const trendsMode = params.has("trends");
const tournamentsMode = params.has("tournaments");
const searching = !deckMode && !commandersMode && !trendsMode && !tournamentsMode && [...params.keys()].some(k => k !== "sort");

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// The site's own data files are checked with the server before a cached copy is used (an
// unchanged file is a quick "304 Not Modified"): after a rebuild, a stale deck file read with a
// fresh card index would show the wrong cards
async function getJson(url) {
  const res = await fetch(url, { cache: /^https?:/.test(url) ? "default" : "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const imageUrl = (id, face = "front") => `https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg`;
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
// Colorless excludes every color, so checking it clears and grays out the color pips
function linkColorless(f) {
  const colorless = f.querySelector('[name="c"][value="C"]');
  const sync = () => {
    for (const pip of f.querySelectorAll('[name="c"]:not([value="C"])')) {
      pip.disabled = colorless.checked;
      if (colorless.checked) pip.checked = false;
    }
  };
  colorless.addEventListener("change", sync);
  sync();
}
linkColorless(form);
form.addEventListener("submit", e => {
  e.preventDefault();
  if (metaSets) $("set-code").value = setCode($("set").value);
  const next = new URLSearchParams([...new FormData(form)].filter(([, v]) => v));
  if (params.get("sort")) next.set("sort", params.get("sort"));
  location.search = next;
});

$("q").placeholder = `Describe a card, e.g. ${pick(EXAMPLES)}`;
// "Random search": any term the search knows, among ~2,000 (see randomSearches in search.js)
$("random").onclick = async () => {
  const choices = randomSearches(await getMeta()).filter(names => !names.includes(params.get("q")));
  location.search = new URLSearchParams({ q: pick(pick(choices)) });
};

// "/" jumps to the search box
document.addEventListener("keydown", e => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || document.querySelector("dialog[open]")) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  e.preventDefault();
  $("q").focus();
});

const activeFilters = params.getAll("c").length + params.getAll("t").length
  + ["min", "max", "price", "f", "s"].filter(k => params.get(k)).length;
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

// Prices: shown in the visitor's currency (guessed from their browser, changeable, remembered).
// The exchange rate is only fetched once a search needs it.
const currency = detectCurrency();
let money = moneyFormatter(currency, currency === "USD" ? 1 : null);
$("currency").append(...CURRENCIES.map(c => el("option", { value: c, textContent: c })));
$("currency").value = currency;
$("currency").onchange = () => {
  try { localStorage.setItem("currency", $("currency").value); } catch {}
  location.reload();
};
$("money").dataset.symbol = money.symbol;
$("budget-money").dataset.symbol = money.symbol;
if (currency !== "USD") {
  $("price-label").textContent = `Max price (${currency})`;
  $("budget-label").textContent = `Max deck price (${currency})`;
}

// === Index files: each is downloaded only when something needs it (see build_index.py) ===
let metaPromise, metaSets;
function getMeta() {
  metaPromise ??= getJson("index/meta.json").then(meta => {
    metaSets = meta.sets;
    $("updated").textContent = `updated ${new Date(meta.updated).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" })}`;
    for (const f of meta.formats) $("format").append(el("option", { value: f, textContent: f[0].toUpperCase() + f.slice(1) }));
    $("format").value = params.get("f") ?? "";
    $("sets").append(...meta.sets.map(([code, name]) => el("option", { value: setLabel(code, name) })));
    const chosen = meta.sets.find(([code]) => code === params.get("s"));
    if (chosen) $("set").value = setLabel(...chosen);
    return meta;
  });
  return metaPromise;
}
// The set box shows "Bloomburrow (BLB)"; the URL holds the code. Typing just the name or code works too.
const setLabel = (code, name) => `${name} (${code.toUpperCase()})`;
function setCode(text) {
  const t = text.trim().toLowerCase();
  const found = t && (metaSets ?? []).find(([code, name]) => [code, name.toLowerCase(), setLabel(code, name).toLowerCase()].includes(t));
  return found ? found[0] : "";
}
$("filters").addEventListener("toggle", () => $("filters").open && getMeta());

// === Search ===
const message = text => {
  $("message").textContent = text;
  $("message").hidden = !text;
};
$("intro").hidden = searching || deckMode || commandersMode || trendsMode || tournamentsMode;
$("results").hidden = !searching;
form.hidden = deckMode || commandersMode || trendsMode || tournamentsMode;
$("deck-view").hidden = !deckMode;
$("commander-view").hidden = !commandersMode;
$("trends-view").hidden = !trendsMode;
$("tournaments-view").hidden = !tournamentsMode;
$(deckMode ? "mode-deck" : commandersMode ? "mode-commanders" : trendsMode ? "mode-trends"
  : tournamentsMode ? "mode-tournaments" : "mode-cards")
  .setAttribute("aria-current", "page");

let index;
let results = [];
let sorted = [];
let sort = SORTS[params.get("sort")] ? params.get("sort") : "match";
const sortData = {};

async function runSearch() {
  const query = params.get("q") ?? "";
  const num = k => (params.get(k) ? Number(params.get(k)) : null);
  // Price limits are typed in the visitor's currency; cards are filtered on US dollars
  const limit = num("price") ?? parsePrice(query);
  const filters = {
    colors: params.getAll("c"), types: params.getAll("t"), format: params.get("f") ?? "",
    min: num("min"), max: num("max"),
    maxPrice: limit !== null ? limit / (money.rate ?? 1) : isBudget(query) ? BUDGET_USD : null,
  };
  const set = index.sets.findIndex(([code]) => code === params.get("s"));
  if (set >= 0) filters.printedIn = new Set(decodePosting(await getJson(`index/s/${set}.json`)));
  const groups = parseQuery(query, index);
  if (groups.length) {
    const postings = await Promise.all(termsNeeded(index, groups).map(async t => [t, decodePosting(await getJson(`index/t/${t}.json`))]));
    results = search(index, groups, new Map(postings), filters);
  } else if (query.trim() && filters.maxPrice === null) {
    results = nameSearch(index, await getJson("index/names.json"), query, filters);
  } else {
    results = search(index, [], new Map(), filters); // filters only
  }

  // A keyword and a tag can share a name ("metalcraft"), so show each label once
  const chips = [...new Set(mainTerms(groups).map(featureLabel))];
  if (filters.maxPrice !== null) chips.push(`under ${money.formatUsd(filters.maxPrice)}`);
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
  const [name, id, back] = (await chunks.get(k))[card % CHUNK];
  return { name, id, back: !!back };
}

// Turns a card's image over to src: edge-on, the other face in, and back (the face loaded first, so
// it never turns to a blank). `rotate` rather than `transform`, which the hover lift is using
async function turnOver(img, src) {
  const next = new Image();
  next.src = src;
  await next.decode().catch(() => {});
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    img.src = src;
    return;
  }
  const art = img.parentElement;
  await art.animate([{ rotate: "y 0deg" }, { rotate: "y 90deg" }], { duration: 140, easing: "ease-in" }).finished;
  img.src = src;
  art.animate([{ rotate: "y -90deg" }, { rotate: "y 0deg" }], { duration: 160, easing: "ease-out" });
}

// A double-faced card's tile, with a button over the top right of its art that turns it over
// (beside the tile, not in it: a button can't hold another)
function withFlip(tile, img, { id, back }) {
  if (!back) return tile;
  let face = "front";
  const flip = el("button", { type: "button", className: "flip", ariaLabel: "Flip card", title: "Flip card", textContent: "↻" });
  flip.onclick = () => {
    face = face === "front" ? "back" : "front";
    turnOver(img, imageUrl(id, face));
    flip.ariaPressed = String(face === "back");
  };
  return el("div", { className: "flip-wrap" }, tile, flip);
}

// A card in a results gallery: image, name, price, a detail line and an optional bar (0 to 1)
// extra: a tone for the detail ("up" or "down"), faint (too little to go on) and a note under it
function cardTile(card, info, detail, bar, i, { tone, faint, note } = {}) {
  const { name, id } = info;
  const price = index.columns.price[card];
  const img = el("img", { alt: name, loading: "lazy", decoding: "async" });
  img.onload = () => img.classList.add("loaded");
  img.src = imageUrl(id);
  const tile = el("button", { className: "card", type: "button", onclick: () => openCard(id, card) },
    el("span", { className: "card-art" }, img),
    el("span", { className: "card-name", textContent: name }),
    el("span", { className: "card-meta" },
      el("span", { textContent: price >= 0 ? money.formatUsd(price / 100) : "No price" }),
      el("span", { textContent: detail, className: [tone, faint && "faint"].filter(Boolean).join(" ") })));
  if (note) tile.append(el("span", { className: "card-note", textContent: note }));
  tile.title = name;
  if (bar !== null) tile.append(el("span", { className: "match-bar" }, el("span", { style: `width:${bar * 100}%` })));
  tile.style.setProperty("--i", i);
  return withFlip(tile, img, info);
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
    const detail = sortData.released && (sort === "newest" || sort === "oldest") ? String(year(sortData.released[card]))
      : score !== null ? `${Math.round(score * 100)}% match` : "";
    $("gallery").append(cardTile(card, infos[i], detail, score !== null && sort === "match" ? score : null, i));
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
foil.onchange = updatePrice;

let deckIndex; // decks/index.json
const getDeckIndex = () => (deckIndex ??= getJson("decks/index.json").catch(err => { deckIndex = null; throw err; }));
let actionsFor;
async function showCardActions(card) {
  actionsFor = card;
  $("card-actions").hidden = card === undefined;
  $("as-commander").hidden = true;
  if (card === undefined) return;
  $("in-decks").href = "?" + new URLSearchParams({ card });
  // A commander page for it alone, or else for the partners it's played with most
  const { commanders } = await getDeckIndex().catch(() => ({ commanders: [] }));
  const key = commanders.find(([k]) => k === String(card))?.[0] ?? commanders.find(([k]) => k.split("-").includes(String(card)))?.[0];
  if (key && actionsFor === card) {
    $("as-commander").href = commanderLink(key);
    $("as-commander").hidden = false;
  }
}

// In a card's details: how its decks did in tournaments, across commanders (the last year) and
// with the commander whose page or deck this is (that page's period)
async function showCardResults(card) {
  const box = $("card-results");
  box.hidden = true;
  box.replaceChildren();
  if (card === undefined) return;
  const lines = [];
  const here = tournament?.byCard.get(card);
  if (here) {
    lines.push(el("p", {}, el("strong", { className: here.lift > 0 ? "up" : "down", textContent: points(here.lift) }),
      ` with ${tournament.lead} in the last ${tournament.period}. ${here.story}`));
  }
  const all = await getResultsIndex();
  if (actionsFor !== card) return; // another card was opened meanwhile
  const i = all ? all.cards.indexOf(card) : -1;
  if (i >= 0) {
    const w = Math.max(0, all.windows.indexOf(365)); // the last year's: recent enough to go on
    const [decks, commanders, lift, evidence] = all.stats[i].slice(4 * w, 4 * w + 4);
    const fieldDecks = all.field[w][0];
    lines.push(el("p", {}, `In the last ${periodName(all.windows[w])}, ${percent1(decks / fieldDecks)} of ${fieldDecks.toLocaleString()} tournament decks play it. `
      + (!commanders ? "Too few of any one commander's decks play it to compare."
        : Math.abs(evidence) < SIGNAL * 100 ? `No clear difference yet between decks with it and without it, within ${theCommanders(commanders)}.`
          : `Within ${theCommanders(commanders)}, decks with it won ${Math.abs(lift / 100).toFixed(1)} points ${lift > 0 ? "more" : "less"} of their games than decks without it.`),
      " ", el("a", { href: "?tournaments", textContent: "Tournaments →" })));
  }
  if (!lines.length) return;
  box.replaceChildren(el("span", { className: "label", textContent: "In cEDH tournaments" }), ...lines);
  box.hidden = false;
}

// card: its number in the index, when known, for links to the commanders that play it
async function openCard(id, card) {
  showCardActions(card);
  showCardResults(card);
  $("printings").replaceChildren();
  $("modal-name").textContent = "Loading…";
  $("modal-type").textContent = $("modal-set").textContent = $("price").textContent = "";
  $("foil-label").hidden = true;
  $("modal-img").src = imageUrl(id);
  $("modal-flip").hidden = true;
  modal.showModal();
  try {
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

const printPrice = p => (p.prices.usd ? money.formatUsd(+p.prices.usd)
  : p.prices.usd_foil ? `${money.formatUsd(+p.prices.usd_foil)} foil` : "—");

function showPrinting(card) {
  current = card;
  const face = card.image_uris ?? card.card_faces[0].image_uris;
  $("modal-img").src = face.normal;
  $("modal-img").alt = card.name;
  const faces = (card.card_faces ?? []).filter(f => f.image_uris);
  let showing = 0;
  $("modal-flip").hidden = faces.length < 2;
  $("modal-flip").onclick = () => {
    showing = 1 - showing;
    turnOver($("modal-img"), faces[showing].image_uris.normal);
  };
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

function updatePrice() {
  $("foil-wrapper").classList.toggle("foil-shimmer", foil.checked);
  const usd = foil.checked ? current.prices.usd_foil : current.prices.usd;
  // In the visitor's currency, with Scryfall's US price alongside when they differ
  $("price").textContent = !usd ? "No current price"
    : money.formatUsd(+usd) + (foil.checked ? " foil" : "")
      + (money.currency !== "USD" && money.rate ? `  ·  US$${usd}` : "");
}

// === Deck recommendations (deck.js does the math, build_decks.py makes the data) ===
// Moxfield and Archidekt links are read by a small Cloudflare Worker (worker/deck-link.js):
// neither site lets other sites' pages call its API directly.
const DECK_LINK = "https://mtg-deck-link.grahamirwin.workers.dev";
const LINK = /^https?:\/\/(?:www\.)?(?:moxfield|archidekt)\.com\/\S+$/i;
// A crawled deck's page: Moxfield's ids are strings, Archidekt's numbers (build_decks.py)
const openDeck = id => {
  const [site, href] = typeof id === "string" ? ["Moxfield", `https://moxfield.com/decks/${id}`] : ["Archidekt", `https://archidekt.com/decks/${id}`];
  return el("a", { className: "open", href, target: "_blank", rel: "noopener", textContent: `${site} ↗` });
};
const BASIC = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;
const MAX_ADDS = 150;
const PAGE_ADDS = 30;
const MAX_DECKS = 30;
const PAGE_DECKS = 10;
const SHOW_CUTS = 16;
const CUT_BELOW = 0.1; // played by under 10% of similar decks
// A card counts as its first type here: an artifact creature is a creature
const TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land"];
const TYPE_PLURALS = { Sorcery: "Sorceries" };
const deckMessage = text => {
  $("deck-message").textContent = text;
  $("deck-message").hidden = !text;
};

let deckData;
function loadDeckData() {
  deckData ??= Promise.all([getMeta(), getJson("index/columns.json"), getJson("index/names.json"),
    getDeckIndex(), usdRate(currency)])
    .then(([meta, columns, names, decks, rate]) => {
      money = moneyFormatter(currency, rate);
      index = buildIndex(meta, columns);
      return { names, lookup: nameLookup(names), decks, files: new Set(decks.commanders.map(c => c[0])) };
    });
  deckData.catch(() => (deckData = null)); // try again next time
  return deckData;
}
const commanderNames = (key, names) => key.split("-").map(n => names[n]).join(" & ");
const typeOf = card => TYPE_ORDER.find(t => index.columns.types[card] & (1 << index.types.indexOf(t))) ?? "Other";
const cardButton = (card, names, label = names[card]) =>
  el("button", { type: "button", className: "term", textContent: label, onclick: async () => openCard((await cardInfo(card)).id, card) });

// The decklist to compare: what was pasted, or the list behind a pasted link.
// Returns { list, name?, site? }, or { error }.
let fetched = { link: null };
async function readDeck(input) {
  const link = input.trim();
  if (!LINK.test(link)) return { list: input };
  if (fetched.link === link) return fetched; // switching commanders doesn't fetch it again
  deckMessage("Fetching the deck…");
  try {
    const res = await fetch(`${DECK_LINK}/?url=${encodeURIComponent(link)}`);
    const data = await res.json();
    if (!res.ok) return { error: data.error };
    fetched = { ...data, link };
    return fetched;
  } catch {
    return { error: "Couldn't fetch that deck. Try again, or paste its list." };
  }
}

// key: compare with this commander's decks instead of the deck's own commander
async function findSimilar(key) {
  const input = $("decklist").value;
  try { localStorage.setItem("decklist", input); } catch {}
  // A link goes in the address bar, so the page can be shared or bookmarked
  history.replaceState(null, "", "?" + new URLSearchParams({ deck: LINK.test(input.trim()) ? input.trim() : "" }));
  $("deck-results").hidden = true;
  const deck = await readDeck(input);
  if (deck.error) return deckMessage(deck.error);
  deckMessage("Loading decks…");
  const { names, lookup, decks, files } = await loadDeckData();
  const parsed = parseDecklist(deck.list, lookup);
  // The commander: as marked in the list, or else the most-played commander among its cards
  let commanders = parsed.commanders;
  const guessed = !commanders.length && decks.commanders.find(([k]) => !k.includes("-") && parsed.cards.has(+k));
  if (guessed) commanders = [+guessed[0]];
  const mine = [...parsed.cards].filter(c => !BASIC.test(names[c]) && !commanders.includes(c));
  if (!mine.length) return deckMessage("Couldn't find any card names in that list. Paste one card per line, like “1 Sol Ring”.");

  const ownKey = commanders.length ? [...commanders].sort((a, b) => a - b).join("-") : null;
  const closest = closestCommanders(decks, mine, 8);
  key ??= files.has(ownKey) ? ownKey : closest[0]?.key;
  if (!key) return deckMessage("Couldn't find any decks like this one yet.");
  const count = decks.commanders.find(c => c[0] === key)[1];
  const shard = decodeShard(await getJson(`decks/${key}.json`));
  const similar = similarDecks(shard, mine);
  const { adds, cuts, neighbors } = recommend(shard, similar, mine);

  // Summary: which deck, whose decks it's compared with, and what wasn't recognized
  const lead = commanderNames(key, names);
  // Its commander's tournament results (another commander's say nothing about this deck)
  const tourney = key === ownKey && shard.results ? await getJson(`decks/results/${key}.json`).catch(() => null) : null;
  const tw = tourney && firstPeriod(tourney);
  const tested = tourney ? cardResults(tourney, tw) : [];
  tournament = tourney && { lead, period: periodName(tourney.windows[tw]),
    byCard: new Map(tested.map(x => [x.card, { ...x, story: resultTile(x, tourney.totals[tw][0]).story }])) };
  const summary = [];
  const note = text => summary.push(el("span", { className: "muted", textContent: text }));
  if (deck.site) summary.push(el("span", { className: "term-chip", textContent: `${deck.name} (${deck.site})` }));
  summary.push(el("span", { className: "label", textContent: "compared with" }),
    el("a", { className: "term", href: "?" + new URLSearchParams({ commander: key }), textContent: `${count.toLocaleString()} ${lead} decks` }));
  if (ownKey && key !== ownKey && !files.has(ownKey)) {
    note(`There aren't enough ${commanderNames(ownKey, names)} decks yet, so these are the closest commander's.`);
  } else if (!ownKey) {
    note("No commander found in your list. Mark it with *CMDR* to compare with its decks.");
  } else if (guessed && key === ownKey) {
    note("Guessed your commander. Mark it with *CMDR* if that's wrong.");
  }
  if (parsed.unknown.length) {
    summary.push(el("span", { className: "muted", title: parsed.unknown.join("\n"),
      textContent: `${parsed.unknown.length} unrecognized ${parsed.unknown.length === 1 ? "line" : "lines"}` }));
  }
  $("deck-summary").replaceChildren(...summary);

  // Cards to add, within the deck's color identity, filterable by type
  const { identity } = index.columns;
  const colors = (commanders.length ? commanders : [...parsed.cards]).reduce((m, c) => m | identity[c], 0);
  const picks = adds.filter(a => (identity[a.card] & ~colors) === 0).slice(0, MAX_ADDS)
    .map(a => ({ card: a.card, type: typeOf(a.card), detail: `in ${a.decks} of ${neighbors} decks`, bar: a.decks / neighbors, ...tournamentNote(a.card) }));
  $("adds-lede").textContent = `What the ${neighbors} decks most like yours play that yours doesn't, favoring cards they play more than most ${lead} decks do.`;
  await showAdds(picks);

  // Cuts only make sense against decks with your own commander: another's never play its cards
  $("cuts-section").hidden = key !== ownKey;
  const rare = cuts.filter(c => c.share < CUT_BELOW).slice(0, SHOW_CUTS);
  $("cuts").replaceChildren(...(rare.length
    ? rare.map(c => cardButton(c.card, names, `${names[c.card]} · ${Math.round(c.share * 100)}%`
      + (tournament?.byCard.has(c.card) ? ` · ${points(tournament.byCard.get(c.card).lift)} in tournaments` : "")))
    : [el("span", { className: "muted", textContent: "None: similar decks play almost all of your cards." })]));

  // The tournament check: your cards whose decks win less, and cards whose decks win more that you don't play
  $("deck-tournament").hidden = !tourney;
  if (tourney) {
    const decksThere = tourney.totals[tw][0];
    const yours = new Set(mine);
    $("deck-tournament-lede").textContent = `From ${decksThere.toLocaleString()} ${lead} decks in cEDH tournaments in the last ${tournament.period}. `
      + "Each card's decks are measured against the commander's other decks. A card can stand for a style of build, "
      + "so weigh them together rather than one at a time. Open a card for the full numbers.";
    const less = tested.filter(x => yours.has(x.card) && x.lift < 0 && x.evidence <= -SIGNAL).sort((a, b) => a.lift - b.lift);
    const more = tested.filter(x => !yours.has(x.card) && (identity[x.card] & ~colors) === 0 && x.lift > 0 && x.evidence >= SIGNAL)
      .sort((a, b) => b.lift - a.lift);
    $("mine-less-lede").textContent = less.length ? "Decks that play these won less often than those that don't."
      : "None of your cards' decks clearly won less than the rest.";
    $("missing-more-lede").textContent = more.length ? "Decks that play these won more often than those that don't."
      : "Every card whose decks clearly won more is already in your deck.";
    await Promise.all([showMineLess(less.map(x => resultTile(x, decksThere))), showMissingMore(more.map(x => resultTile(x, decksThere)))]);
  }

  // The similar decks, each opening to the cards they play that yours doesn't
  const have = new Set(mine);
  const items = foldCopies(similar.filter(r => r.similarity > 0), MAX_DECKS).map((r, i) => {
    const meta = `${r.shared} cards in common · updated ${r.deck.updated}`
      + (r.copies ? ` · ${r.copies} near-${r.copies === 1 ? "copy" : "copies"}` : "");
    const details = el("details", {},
      el("summary", {},
        el("span", { className: "sim", textContent: `${Math.round(r.similarity * 100)}%` }),
        el("span", { className: "deck-name", textContent: r.deck.name || "Untitled deck" }),
        openDeck(r.deck.id),
        el("span", { className: "deck-meta", textContent: meta })));
    details.addEventListener("toggle", () => {
      const theirs = [...r.deck.cards].map(p => shard.cards[p]).filter(c => !have.has(c)).sort((a, b) => a - b);
      details.append(el("div", { className: "deck-body" },
        el("p", { textContent: theirs.length ? `${theirs.length} cards they play that you don't, most popular first:` : "They play no cards you don't." }),
        el("div", { className: "term-items" }, ...theirs.map(c => cardButton(c, names)))));
    }, { once: true });
    return el("li", { hidden: i >= PAGE_DECKS }, details);
  });
  $("similar").replaceChildren(...items);
  $("more-decks").hidden = items.length <= PAGE_DECKS;
  $("more-decks").onclick = () => {
    items.forEach(li => (li.hidden = false));
    $("more-decks").hidden = true;
  };

  // Other commanders, to compare with their decks instead
  const others = closest.filter(c => c.key !== key);
  if (files.has(ownKey) && key !== ownKey) others.unshift({ key: ownKey, decks: decks.commanders.find(c => c[0] === ownKey)[1] });
  $("others-section").hidden = !others.length;
  $("others").replaceChildren(...others.slice(0, 8).map(c => el("button", {
    type: "button", className: "term", onclick: () => findSimilar(c.key).then(() => $("deck-results").scrollIntoView()),
  }, commanderNames(c.key, names), el("small", { textContent: c.decks.toLocaleString() }))));

  deckMessage("");
  $("deck-results").hidden = false;
}

// A gallery of cards with a type filter, PAGE_ADDS cards at a time. Returns a function that
// shows picks: [{card, type, detail, bar}]
const typeLabel = t => (t === "All" ? "All" : TYPE_PLURALS[t] ?? `${t}s`);
function typedGallery(types, gallery, more) {
  let view;
  async function show() {
    const current = view;
    const counts = {};
    for (const p of current.picks) counts[p.type] = (counts[p.type] ?? 0) + 1;
    types.replaceChildren(...["All", ...TYPE_ORDER, "Other"].filter(t => t === "All" || counts[t]).map(t =>
      el("button", {
        type: "button", ariaPressed: String(current.type === t),
        onclick: () => { view = { ...current, type: t, shown: PAGE_ADDS }; show(); },
      }, typeLabel(t), el("small", { textContent: t === "All" ? current.picks.length : counts[t] }))));
    const list = current.type === "All" ? current.picks : current.picks.filter(p => p.type === current.type);
    const page = list.slice(0, current.shown);
    const infos = await Promise.all(page.map(a => cardInfo(a.card)));
    if (current !== view) return; // filtered again while loading
    gallery.replaceChildren(...page.map((a, i) => cardTile(a.card, infos[i], a.detail, a.bar, i % PAGE_ADDS, a)));
    more.hidden = current.shown >= list.length;
  }
  more.onclick = () => {
    view = { ...view, shown: view.shown + PAGE_ADDS };
    show();
  };
  return picks => {
    view = { picks, type: "All", shown: PAGE_ADDS };
    return show();
  };
}
const showAdds = typedGallery($("add-types"), $("adds"), $("more-adds"));
const showMineLess = typedGallery($("mine-less-types"), $("mine-less"), $("more-mine-less"));
const showMissingMore = typedGallery($("missing-more-types"), $("missing-more"), $("more-missing-more"));

// === Commanders: every commander with decks, and what their decks play ===
const PAGE_COMMANDERS = 30;
const SIGNATURE_SHOWN = 60;
const PAGE_LISTS = 20;
const BRACKETS = ["Any", "1 Exhibition", "2 Core", "3 Upgraded", "4 Optimized", "5 cEDH"];
const BASIC_OF = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
const commanderMessage = text => {
  $("commander-message").textContent = text;
  $("commander-message").hidden = !text;
};
const commanderLink = key => "?" + new URLSearchParams({ commander: key });

// Changes some of the URL's parameters (null: leaves it out), so a view is a link to share
function setParams(changes) {
  const url = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(changes)) v === null ? url.delete(k) : url.set(k, v);
  history.replaceState(null, "", "?" + url);
}

// Partners, overlapped: the one behind shows its name and cost above the other, and pointing at it
// (or focusing it) brings it forward until the pointer leaves the pair (or focus moves on)
function overlap(cards, className = "") {
  const pair = el("span", { className: `pair ${className}` }, ...cards);
  const flip = second => {
    if (cards[0].classList.contains("back") === second) return;
    pair.classList.add("shuffled");
    cards[0].classList.toggle("back", second);
    cards[1].classList.toggle("back", !second);
  };
  cards[1].classList.add("back");
  // The strip where the one behind shows: the top and left 10%, by where the pointer is rather
  // than which card is under it, since flipping slides the other card under the pointer
  pair.onpointermove = e => {
    const r = pair.getBoundingClientRect();
    if (e.clientX - r.left < r.width * 0.1 || e.clientY - r.top < r.height * 0.1) flip(true);
  };
  pair.onpointerleave = () => flip(false);
  pair.addEventListener("focusin", e => flip(cards[1].contains(e.target)));
  pair.addEventListener("focusout", () => flip(false));
  return pair;
}

// A gallery of commanders, PAGE_COMMANDERS at a time, each opening its page. Returns a function
// that shows a list: [{key, name, detail}]
function commanderGallery(gallery, moreButton) {
  let list = [];
  let shown = 0;
  const more = async () => {
    const current = list;
    moreButton.hidden = true;
    const page = current.slice(shown, shown + PAGE_COMMANDERS);
    const infos = await Promise.all(page.map(c => Promise.all(c.key.split("-").map(k => cardInfo(+k)))));
    if (current !== list) return; // shown another list while loading
    gallery.append(...page.map((c, i) => {
      const imgs = infos[i].map(info => {
        const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
        img.onload = () => img.classList.add("loaded");
        img.src = imageUrl(info.id);
        return img;
      });
      const tile = el("a", { className: "card", href: commanderLink(c.key), title: c.name },
        imgs.length > 1 ? overlap(imgs, "card-art") : el("span", { className: "card-art" }, ...imgs),
        el("span", { className: "card-name", textContent: c.name }),
        el("span", { className: "card-meta" }, el("span", { textContent: c.detail })));
      tile.style.setProperty("--i", i);
      return imgs.length > 1 ? tile : withFlip(tile, imgs[0], infos[i][0]);
    }));
    shown += page.length;
    moreButton.hidden = shown >= current.length;
  };
  moreButton.onclick = more;
  return items => {
    list = items;
    shown = 0;
    gallery.replaceChildren();
    return more();
  };
}
const showCommanderList = commanderGallery($("commanders"), $("more-commanders"));

async function showCommanders() {
  const { names, decks } = await loadDeckData();
  const all = decks.commanders.map(([key, count]) => ({ key, name: commanderNames(key, names), detail: `${count.toLocaleString()} decks` }));
  $("random-commander").onclick = () => (location.search = commanderLink(pick(all).key));
  // The Trends filters, over all time
  $("commander-list").insertBefore($("trend-form"), $("commanders"));
  const trends = { themes: [] }; // filled in once the filters are used
  const readFilters = trendFilters(trends, ["commanders"]);
  const update = () => {
    const f = readFilters(0);
    const kept = f.active && trends.commanders && new Set(filterCommanders(trends.commanders, f).map(c => c.key));
    const q = $("commander-filter").value.trim().toLowerCase();
    const matches = all.filter(c => (!kept || kept.has(c.key)) && c.name.toLowerCase().includes(q));
    $("commander-count").textContent = `${matches.length.toLocaleString()} ${matches.length === 1 ? "commander" : "commanders"}`
      + (q || f.active ? "" : ` · ${decks.decks.toLocaleString()} decks`);
    showCommanderList(matches);
  };
  $("commander-filter").oninput = update;
  $("trend-form").addEventListener("input", update);
  update();
  whenFiltering(trends, update);
  commanderMessage("");
  $("commander-list").hidden = false;
}

// Cards grouped by type (as card numbers), each opening its details
function typeGroups(cards, names) {
  const by = new Map();
  for (const c of cards) by.set(typeOf(c), [...(by.get(typeOf(c)) ?? []), c]);
  return [...TYPE_ORDER, "Other"].filter(t => by.has(t)).map(t => el("div", { className: "type-group" },
    el("h3", {}, typeLabel(t), el("small", { textContent: by.get(t).length })),
    el("div", { className: "term-items" }, ...by.get(t).sort((a, b) => a - b).map(c => cardButton(c, names)))));
}

const showPlayed = typedGallery($("played-types"), $("played"), $("more-played"));
const showSignature = typedGallery($("signature-types"), $("signature"), $("more-signature"));
// Scryfall Tagger tags, readably: "gives-pp-counters" -> "Gives +1/+1 counters"
function tagLabel(tag) {
  const label = tag.replaceAll("-", " ").replace(/\bpp\b/g, "+1/+1").replace(/\bmm\b/g, "−1/−1");
  return label[0].toUpperCase() + label.slice(1);
}

async function showCommander(key) {
  const { names, decks } = await loadDeckData();
  const entry = decks.commanders.find(c => c[0] === key);
  if (!entry) {
    await showCommanders();
    return commanderMessage("There aren't enough decks with that commander yet. Here are the commanders that have some.");
  }
  const lead = commanderNames(key, names);
  document.title = `${lead} · MTG Vec2Search`;
  const leaders = key.split("-").map(Number);
  const [shard, infos, released] = await Promise.all([getJson(`decks/${key}.json`).then(decodeShard),
    Promise.all(leaders.map(cardInfo)), getReleased()]);
  const results = shard.results ? await getJson(`decks/results/${key}.json`).catch(() => null) : null;
  const n = shard.decks.length;

  const art = infos.map(({ name, id }, i) =>
    el("button", { type: "button", className: "card", onclick: () => openCard(id, leaders[i]) }, el("img", { src: imageUrl(id), alt: name })));
  $("commander-art").replaceChildren(art.length > 1 ? overlap(art) : withFlip(art[0], art[0].querySelector("img"), infos[0]));
  const identity = leaders.reduce((m, c) => m | index.columns.identity[c], 0);
  const colors = [..."WUBRG"].filter((_, i) => identity & (1 << i));
  $("commander-name").textContent = lead;
  $("commander-meta").textContent = [`${n.toLocaleString()} decks`, colors.map(c => COLOR_NAMES[c]).join(", ") || "Colorless",
    shard.price >= 0 && `typical deck ${money.formatUsd(shard.price / 100)}`, shard.bracket && `bracket ${shard.bracket}`]
    .filter(Boolean).join(" · ");
  // What its decks are known for, each finding more commanders like it on Trends
  $("commander-themes").hidden = !shard.themes.length;
  $("commander-themes").replaceChildren(el("span", { className: "label", textContent: "Known for" }),
    ...shard.themes.map(t => el("a", { className: "term", textContent: tagLabel(t),
      href: "?" + new URLSearchParams({ trends: "", w: "all", theme: tagLabel(t) }) })));

  // Builds: lands are left out of telling them apart (they mostly show a deck's budget)
  const landBit = 1 << index.types.indexOf("Land");
  const lands = new Set(shard.cards.flatMap((c, p) => (index.columns.types[c] & landBit ? [p] : [])));
  // Each build is named for the Tagger tag it leans on most that a bigger build isn't named for;
  // failing that, a word its deck names share, or its most distinctive card
  const skip = new Set(lead.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'+-]*/gu));
  const named = new Set();
  const builds = findBuilds(shard, { ignore: lands }).map(members => {
    const tags = buildTags(shard, members);
    const tag = tags.find(t => !named.has(t));
    named.add(tag);
    return {
      members, tags,
      name: tag ? tagLabel(tag) : buildName(shard, members, skip)
        ?? names[shard.cards[distinctive(shard, members, { n: 1, ignore: lands })[0]]],
    };
  });
  const groups = [{ name: "All decks", members: shard.decks.map((_, d) => d), all: true }, ...builds];
  $("builds-lede").textContent = builds.length
    ? `${lead} decks fall into ${builds.length} builds by the cards they play, each named for the kind of card (Scryfall Tagger tag) it plays more of than the rest. Pick one to see its cards and decks.`
    : `There aren't enough ${lead} decks, or they're too alike, to tell builds apart.`;
  $("builds").hidden = !builds.length;
  // The build's decks of one bracket (the one its builder gave it), or all of them. The URL holds
  // both (the build by name), so a view of a commander is a link to share.
  let build = groups.find(g => g.name === params.get("build")) ?? groups[0];
  let bracket = Math.max(0, BRACKETS.findIndex((_, b) => b && String(b) === params.get("bracket")));
  $("builds").replaceChildren(...groups.map((g, i) => el("button", {
    type: "button", ariaPressed: String(g === build),
    onclick: e => {
      for (const b of $("builds").children) b.ariaPressed = String(b === e.currentTarget);
      build = g;
      showBuild();
    },
  }, g.name, el("small", { textContent: i ? `${Math.round(g.members.length / n * 100)}%` : n.toLocaleString() }))));

  const ofBracket = (members, b) => members.filter(d => shard.decks[d].bracket === b);
  $("bracket-filter").hidden = !shard.decks.some(d => d.bracket);
  function showBuild() {
    if (!ofBracket(build.members, bracket).length) bracket = 0;
    setParams({ build: build.all ? null : build.name, bracket: bracket || null });
    const given = build.members.length - ofBracket(build.members, 0).length;
    $("brackets-lede").textContent = `The bracket each deck's builder gave it. ${percent(given / build.members.length)} of these decks have one.`
      + (bracket === 5 && tournament ? ` Bracket 5 cards also show how their decks did in tournaments in the last ${tournament.period}.` : "");
    $("brackets").replaceChildren(...BRACKETS.map((label, b) => {
      const k = b ? ofBracket(build.members, b).length : build.members.length;
      return el("button", { type: "button", ariaPressed: String(b === bracket), disabled: !k,
        onclick: () => { bracket = b; showBuild(); } }, label, el("small", { textContent: k.toLocaleString() }));
    }));
    return showGroup(!bracket ? build : { ...build, all: false, members: ofBracket(build.members, bracket),
      name: [build.all ? "" : build.name, `bracket ${bracket}`].filter(Boolean).join(", ") });
  }

  let current;
  async function showGroup(g) {
    current = g;
    const all = g.all;
    const counts = playCounts(shard, g.members);
    const share = p => counts[p] / g.members.length;
    const detail = p => `in ${Math.round(share(p) * 100)}% of decks`;

    const tile = p => ({ card: shard.cards[p], type: typeOf(shard.cards[p]), detail: detail(p), bar: share(p), ...cedh(shard.cards[p]) });

    // Signature cards: what sets these decks apart from other commanders' decks (all of them),
    // or from the commander's other decks (a build)
    $("signature-lede").textContent = all
      ? `What ${lead} decks play far more often than other commanders' decks do.`
      : `What these decks play far more often than other ${lead} decks do.`
        + (g.tags ? ` They lean on: ${g.tags.map(t => tagLabel(t).toLowerCase()).join(", ") || "no tag in particular"}.` : "");
    showSignature((all ? (shard.signature ?? entry[2]).map(c => shard.position.get(c)).filter(p => p !== undefined)
      : distinctive(shard, g.members, { n: SIGNATURE_SHOWN, ignore: lands })).slice(0, SIGNATURE_SHOWN).map(tile));

    showPlayed([...counts.keys()].filter(p => counts[p]).sort((a, b) => counts[b] - counts[a] || a - b).map(tile));
    showCommanderTrends(g, counts);

    // The average deck: as many spells and nonbasic lands as these decks play on average, then
    // basic lands, split evenly between the colors, to make 100 cards
    const average = averageDeck(shard, g.members, lands);
    const basics = Math.max(0, 100 - leaders.length - average.spells.length - average.lands.length);
    const kinds = colors.length ? colors.map(c => BASIC_OF[c]) : ["Wastes"];
    const basicCounts = kinds.map((b, i) => [names.indexOf(b), Math.floor(basics / kinds.length) + (i < basics % kinds.length)])
      .filter(([, k]) => k);
    $("average-lede").textContent = `${average.spells.length} spells and ${average.lands.length + basics} lands`
      + ` (${basics} of them basic), as many of each as these decks play on average, picking the cards they play most.`;
    const picks = [...average.spells, ...average.lands].map(p => ({ card: shard.cards[p], detail: detail(p), bar: share(p), ...cedh(shard.cards[p]) }))
      .concat(basicCounts.map(([card, k]) => ({ card, detail: `× ${k}`, bar: null, copies: k })));
    const byType = new Map();
    for (const pick of picks) byType.set(typeOf(pick.card), [...(byType.get(typeOf(pick.card)) ?? []), pick]);
    const sections = [...TYPE_ORDER, "Other"].filter(t => byType.has(t)).map(t => [t, byType.get(t)]);
    const listText = () => [...leaders.map(c => `1 ${names[c]} *CMDR*`),
      ...sections.flatMap(([, list]) => list.map(a => `${a.copies ?? 1} ${names[a.card]}`))].join("\n") + "\n";
    $("copy-average").textContent = "Copy list";
    $("copy-average").onclick = async () => {
      try {
        await navigator.clipboard.writeText(listText());
        $("copy-average").textContent = "Copied";
      } catch {
        $("copy-average").textContent = "Couldn't copy";
      }
    };
    $("download-average").onclick = () => {
      const a = el("a", { download: `${lead}${all ? "" : ` (${g.name})`} average deck.txt`,
        href: URL.createObjectURL(new Blob([listText()], { type: "text/plain" })) });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href));
    };

    // Decklists, newest first, each opening to its cards
    let shown = 0;
    $("lists").replaceChildren();
    const moreLists = () => {
      $("lists").append(...g.members.slice(shown, shown + PAGE_LISTS).map(d => {
        const deck = shard.decks[d];
        const details = el("details", {},
          el("summary", {},
            el("span", { className: "deck-name", textContent: deck.name || "Untitled deck" }),
            openDeck(deck.id),
            el("span", { className: "deck-meta", textContent: `updated ${deck.updated} · ${deck.cards.length} cards besides basic lands` })));
        details.addEventListener("toggle", () => details.append(el("div", { className: "deck-body type-groups" },
          ...typeGroups([...deck.cards].map(p => shard.cards[p]), names))), { once: true });
        return el("li", {}, details);
      }));
      shown += PAGE_LISTS;
      $("more-lists").hidden = shown >= g.members.length;
    };
    $("more-lists").onclick = moreLists;
    moreLists();


    // The average deck's cards, by type (after the rest, as it's the most to load)
    const averageInfos = await Promise.all(sections.map(([, list]) => Promise.all(list.map(a => cardInfo(a.card)))));
    if (current !== g) return; // another build was picked while loading
    $("average").replaceChildren(...sections.flatMap(([t, list], s) => [
      el("h3", {}, typeLabel(t), el("small", { textContent: list.reduce((k, a) => k + (a.copies ?? 1), 0) })),
      el("div", { className: "gallery" }, ...list.map((a, i) => cardTile(a.card, averageInfos[s][i], a.detail, a.bar, i, a))),
    ]));
  }

  // Trends: what the decks made lately play more of, for a window of days (index.json's windows)
  const windows = (decks.windows ?? []).map((days, i) => ({ days, since: decks.since[i] }));
  let shownWindow = windows.findIndex(w => w.days === DEFAULT_DAYS && w.since !== null);
  if (shownWindow < 0) shownWindow = windows.findIndex(w => w.since !== null);
  function showCommanderTrends(g, counts) {
    const recentOf = w => (w.since === null ? [] : g.members.filter(d => shard.decks[d].made >= w.since));
    $("commander-windows").replaceChildren(...windows.map((w, i) => ({ w, i })).reverse().map(({ w, i }) => el("button", {
      type: "button", ariaPressed: String(i === shownWindow), disabled: w.since === null,
      title: w.since === null ? "Not enough data yet" : "",
      onclick: () => { shownWindow = i; showCommanderTrends(g, counts); },
    }, `${w.days} days`, el("small", { textContent: w.since === null ? "–" : recentOf(w).length }))));
    const w = windows[shownWindow];
    const recent = w ? recentOf(w) : [];
    const whose = g.all ? `${lead}'s` : "these";
    $("commander-trends-lede").textContent = !w
      ? "Not enough data yet: decks show up here once the crawler knows when they were made."
      : `${recent.length.toLocaleString()} of ${whose} ${g.members.length.toLocaleString()} decks were made in the last ${w.days} days.`;
    const pick = (p, detail, bar) => ({ card: shard.cards[p], type: typeOf(shard.cards[p]), detail, bar, ...cedh(shard.cards[p]) });
    showRising(recent.length ? risingCards(shard, g.members, recent)
      .map(x => pick(x.p, `${percent(x.was)} → ${percent(x.share)} of decks`, x.share)) : []);
    showNewCards([...counts.keys()].filter(p => counts[p] && isNew(released, shard.cards[p]))
      .sort((a, b) => counts[b] - counts[a] || a - b)
      .map(p => pick(p, `in ${percent(counts[p] / g.members.length)} of decks`, counts[p] / g.members.length)));
  }

  // Tournament results; picking bracket 5 also notes each card's on its tile
  tournament = null;
  $("results-panel").hidden = !results;
  if (results) showResults(results, leaders.map(c => names[c]), released, () => bracket === 5 && showBuild());
  const cedh = card => (bracket === 5 ? tournamentNote(card) : {});
  await showBuild();
  commanderMessage("");
  $("commander-page").hidden = false;
}

// === A commander's cEDH tournament results (decks/results/<key>.json, from edhtop16) ===
const RESULT_PERIODS = { 90: "3 months", 180: "6 months", 365: "year", 730: "2 years" };
const MIN_PERIOD_DECKS = 150; // the period shown first: the shortest with this many decks
const SAME = 0.01; // a win rate this close to the field's is about the same
const SIGNAL = 2; // standard errors: a difference this clear or more counts (see cardResults)
const PAGE_FINISHES = 10;
const showWinsMore = typedGallery($("wins-more-types"), $("wins-more"), $("more-wins-more"));
const showWinsLess = typedGallery($("wins-less-types"), $("wins-less"), $("more-wins-less"));
const showResultsNew = typedGallery($("results-new-types"), $("results-new"), $("more-results-new"));
const percent1 = x => `${(x * 100).toFixed(1)}%`;
const points = x => `${x > 0 ? "▲" : x < 0 ? "▼" : ""} ${Math.abs(x * 100).toFixed(1)} pts`.trim();
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");
// A decklist link, named for where it is
function listLink(href) {
  let host = "";
  try { host = new URL(href).hostname.replace(/^www\./, ""); } catch { return null; }
  const site = { "topdeck.gg": "TopDeck", "moxfield.com": "Moxfield", "archidekt.com": "Archidekt" }[host] ?? "Decklist";
  return el("a", { className: "open", href, target: "_blank", rel: "noopener", textContent: `${site} ↗` });
}
// The period shown first: the shortest with MIN_PERIOD_DECKS decks, else the longest
function firstPeriod(results) {
  const w = results.totals.findIndex(t => t[0] >= MIN_PERIOD_DECKS);
  return w < 0 ? results.windows.length - 1 : w;
}
const periodName = days => RESULT_PERIODS[days] ?? `${days} days`;
// A card tile for one of cardResults' results, among a commander's `decks` tournament decks
function resultTile(x, decks) {
  return {
    card: x.card, type: typeOf(x.card), bar: null, detail: points(x.lift), tone: x.lift > 0 ? "up" : "down",
    faint: Math.abs(x.evidence) < SIGNAL,
    note: `${percent(x.winRate)} vs ${percent(x.winRateWithout)} won · ${percent(x.share)} play it`,
    story: `Decks with it won ${percent1(x.winRate)} of ${x.games.toLocaleString()} games; decks without it, ${percent1(x.winRateWithout)}.`
      + (x.conversion === null || x.conversionWithout === null ? ""
        : ` ${percent1(x.conversion)} of decks with it made the top cut, ${percent1(x.conversionWithout)} without.`)
      + ` ${x.decks.toLocaleString()} of ${decks.toLocaleString()} decks play it.`
      + (Math.abs(x.evidence) < SIGNAL ? " Too few decks to be sure yet." : ""),
  };
}
function statTile(label, value, note, tone) {
  return el("div", { className: "stat" }, el("span", { className: "label", textContent: label }),
    el("span", { className: "stat-value", textContent: value }),
    el("span", { className: `stat-note ${tone ?? ""}`, textContent: note }));
}

// Every commander's results and each card's across commanders (decks/results/index.json; null: none yet)
let resultsIndex;
const getResultsIndex = () => (resultsIndex ??= getJson("decks/results/index.json").catch(() => null));
// "the one commander with enough decks with it and without it to compare" / "each of the 5 commanders ..."
const theCommanders = n => (n === 1 ? "the one commander" : `each of the ${n} commanders`) + " with enough decks with it and without it to compare";
// A note for a card tile: how the card did in the current commander's tournament decks
function tournamentNote(card) {
  const r = tournament?.byCard.get(card);
  return r ? { note: `In tournaments: ${points(r.lift)}` } : {};
}
// The commander page's results for the period shown, for card details and bracket 5's notes:
// {lead, period, byCard: card -> cardResults' result, with a story: the whole of it, in words}
let tournament = null;
// onPeriod: called after another period is picked
function showResults(results, leads, released, onPeriod) {
  const lead = leads.join(" & ");
  $("results-source").href = "https://edhtop16.com/commander/" + encodeURIComponent([...leads].sort().join(" / "));
  const usable = w => results.totals[w][0] >= 2 * MIN_RESULT_DECKS;
  const first = firstPeriod(results);
  let w = results.windows.indexOf(Number(params.get("results")));
  if (w < 0) w = first;
  const period = () => periodName(results.windows[w]);

  function show() {
    setParams({ results: w === first ? null : results.windows[w] });
    $("results-windows").replaceChildren(...results.windows.map((days, i) => el("button", {
      type: "button", ariaPressed: String(i === w), onclick: () => { w = i; show(); onPeriod(); },
    }, `Last ${periodName(days)}`, el("small", { textContent: results.totals[i][0].toLocaleString() }))));

    // The headline: how its decks do against every deck in these tournaments
    const [decks, games, wins, cutDecks, cuts] = results.totals[w];
    const [, fieldGames, fieldWins, fieldCutDecks, fieldCuts] = results.field[w];
    const rate = wins / games, fieldRate = fieldWins / fieldGames;
    const vs = (x, field) => (Math.abs(x - field) < SAME ? "About the same as" : points(x - field) + " vs")
      + ` ${percent1(field)} for all decks`;
    const tone = d => (Math.abs(d) < SAME ? "" : d > 0 ? "up" : "down");
    $("results-lede").textContent = `How ${lead} decks did in cEDH tournaments of 16 players or more. `
      + "Each card's decks are measured against the commander's other decks, so the commander's own strength doesn't count.";
    $("results-stats").replaceChildren(
      statTile("Tournament decks", decks.toLocaleString(), `in the last ${period()}, ${games.toLocaleString()} games`),
      statTile("Games won", percent1(rate), vs(rate, fieldRate), tone(rate - fieldRate)),
      cutDecks && fieldCutDecks
        ? statTile("Made the top cut", percent1(cuts / cutDecks), vs(cuts / cutDecks, fieldCuts / fieldCutDecks), tone(cuts / cutDecks - fieldCuts / fieldCutDecks))
        : statTile("Made the top cut", "–", "No events with a top cut"));

    // Cards: how much more (or less) often the decks playing each one win
    const cards = cardResults(results, w);
    const tile = x => resultTile(x, decks);
    tournament = { lead, period: period(), byCard: new Map(cards.map(x => [x.card, { ...x, story: tile(x).story }])) };
    const few = !usable(w) ? `There are too few ${lead} decks in the last ${period()} to compare cards. Try a longer period.` : "";
    const more = cards.filter(x => x.lift > 0 && x.evidence >= SIGNAL).sort((a, b) => b.lift - a.lift);
    $("wins-more-lede").textContent = few || (more.length
      ? "Decks that play these won more of their games than the commander's other decks. ▲ is how many points more, allowing for how few decks play a card. "
        + "It's the decks that won: a card can stand for a style of build. Open a card for the full numbers."
      : `No card's decks clearly won more than the rest in these ${decks.toLocaleString()} decks.`);
    showWinsMore(more.map(tile));
    const fresh = cards.filter(x => isNew(released, x.card)).sort((a, b) => b.lift - a.lift);
    $("results-new-lede").textContent = few || (fresh.length
      ? `Cards from the last few months that at least ${MIN_RESULT_DECKS} of these decks play, best results first. Faded: too few decks to be sure yet.`
      : `No new card is in ${MIN_RESULT_DECKS} or more of these decks yet.`);
    showResultsNew(fresh.map(tile));
    const less = cards.filter(x => x.lift < 0 && x.evidence <= -SIGNAL).sort((a, b) => a.lift - b.lift);
    $("wins-less-lede").textContent = few || (less.length
      ? "Decks that play these won less often than the commander's other decks: worth a second look before you play them."
      : `No card's decks clearly won less than the rest.`);
    showWinsLess(less.map(tile));

    // Its best finishes in the period, newest first, each with its decklist
    const since = new Date(Date.now() - results.windows[w] * 864e5).toISOString().slice(0, 10);
    const finishes = results.top.filter(f => f[0] >= since);
    $("finishes-lede").textContent = finishes.length
      ? `${finishes.length.toLocaleString()} top ${TOP_FINISH} finishes in the last ${period()}, newest first, each with its decklist. Records are won–lost–drawn.`
      : `No top ${TOP_FINISH} finishes in the last ${period()}.`;
    let shown = 0;
    $("finishes").replaceChildren();
    $("more-finishes").onclick = () => {
      $("finishes").append(...finishes.slice(shown, shown + PAGE_FINISHES).map(([date, event, size, standing, won, lost, drew, link]) =>
        el("li", { className: "finish" },
          el("span", { className: "place", textContent: ordinal(standing) }),
          el("span", { className: "deck-name", textContent: event }),
          listLink(link) ?? "",
          el("span", { className: "deck-meta", textContent: [`of ${size} players`,
            new Date(date).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" }),
            `${won}–${lost}–${drew}`].join(" · ") }))));
      shown += PAGE_FINISHES;
      $("more-finishes").hidden = shown >= finishes.length;
    };
    $("more-finishes").onclick();
  }
  show();
}
const TOP_FINISH = 4; // TOP_FINISH in build_decks.py

// === Tournaments: every commander's results, and the cards that win across commanders ===
const PAGE_ROWS = 25;
const DEFAULT_MIN_DECKS = 20;
const tournamentsMessage = text => {
  $("tournaments-message").textContent = text;
  $("tournaments-message").hidden = !text;
};
const showTourMore = typedGallery($("tour-more-types"), $("tour-more"), $("more-tour-more"));
const showTourNew = typedGallery($("tour-new-types"), $("tour-new"), $("more-tour-new"));
const showTourLess = typedGallery($("tour-less-types"), $("tour-less"), $("more-tour-less"));
const artCrop = id => `https://cards.scryfall.io/art_crop/front/${id[0]}/${id[1]}/${id}.jpg`;
const SORTS_BY = { decks: r => r.decks, wins: r => r.rate, cut: r => r.cut ?? -1 };

async function showTournaments() {
  const [all, { names, files }, released] = await Promise.all([getResultsIndex(), loadDeckData(), getReleased()]);
  if (!all) return tournamentsMessage("No tournament results yet.");
  // The Trends filters, less what doesn't apply: bracket (every deck here is cEDH), deck price (a
  // casual deck's) and min decks (the table has its own, of tournament decks). Disabled fields
  // aren't read, counted or put in the URL. Strategies are from a commander's casual decks.
  const tform = $("trend-form");
  $("tour-filters").append(tform);
  for (const name of ["b", "budget", "min"]) {
    for (const input of tform.querySelectorAll(`[name="${name}"]`)) {
      input.disabled = true;
      input.closest("fieldset, .field").hidden = true;
    }
  }
  const trends = { themes: [] }; // filled in once the filters are used
  const readFilters = trendFilters(trends, ["tournaments"]);
  let themesOf = new Map();
  const totals = all.windows.length;
  let w = all.windows.indexOf(Number(params.get("results")));
  if (w < 0) w = all.windows.indexOf(180) >= 0 ? all.windows.indexOf(180) : totals - 1;
  let by = SORTS_BY[params.get("by")] ? params.get("by") : "decks";
  $("tour-min").value = params.get("min") ?? DEFAULT_MIN_DECKS;
  const commanders = all.commanders.map(([key, flat]) => ({ key, name: commanderNames(key, names), flat }));

  function show() {
    const days = all.windows[w];
    $("tour-windows").replaceChildren(...all.windows.map((d, i) => el("button", {
      type: "button", ariaPressed: String(i === w), onclick: () => { w = i; show(); },
    }, `Last ${periodName(d)}`, el("small", { textContent: all.field[i][0].toLocaleString() }))));
    const [fieldDecks, fieldGames, fieldWins, fieldCutDecks, fieldCuts] = all.field[w];
    const fieldRate = fieldWins / fieldGames, fieldCut = fieldCutDecks ? fieldCuts / fieldCutDecks : null;
    const rows = commanders.map(c => {
      const [decks, games, wins, cutDecks, cuts] = c.flat.slice(5 * w, 5 * w + 5);
      return { ...c, decks, games, rate: games ? wins / games : 0, cut: cutDecks ? cuts / cutDecks : null };
    }).filter(r => r.decks);
    $("tour-stats").replaceChildren(
      statTile("Tournament decks", fieldDecks.toLocaleString(), `with decklists, in the last ${periodName(days)}`),
      statTile("Commanders", rows.length.toLocaleString(), `${rows.filter(r => r.decks >= DEFAULT_MIN_DECKS).length.toLocaleString()} with ${DEFAULT_MIN_DECKS} decks or more`),
      statTile("Games won", percent1(fieldRate), "by the average deck: with draws, about a fifth, not a quarter"));
    showLeaderboard(rows, fieldRate, fieldCut);

    // Cards, across commanders: each compared only within the commanders that play it
    const cards = all.cards.flatMap((card, i) => {
      const [decks, n, lift, evidence] = all.stats[i].slice(4 * w, 4 * w + 4);
      return n ? [{ card, decks, n, lift: lift / 10000, evidence: evidence / 100 }] : [];
    });
    const tile = x => ({
      card: x.card, type: typeOf(x.card), bar: null, detail: points(x.lift), tone: x.lift > 0 ? "up" : "down",
      faint: Math.abs(x.evidence) < SIGNAL,
      note: `${percent(x.decks / fieldDecks)} of decks · ${x.n} ${x.n === 1 ? "commander" : "commanders"}`,
    });
    const more = cards.filter(x => x.lift > 0 && x.evidence >= SIGNAL).sort((a, b) => b.lift - a.lift);
    const less = cards.filter(x => x.lift < 0 && x.evidence <= -SIGNAL).sort((a, b) => a.lift - b.lift);
    const fresh = cards.filter(x => isNew(released, x.card)).sort((a, b) => b.lift - a.lift);
    const how = "Each card's decks are measured against the same commander's decks without it, then averaged over the commanders that play it, "
      + "so a card isn't credited for the commanders it's played with. ▲ is how many points more of their games they won. "
      + "A card can stand for a style of deck (turbo lists play Rite of Flame, slower ones Force of Will), so read these as what winning decks play, not proof a card wins on its own.";
    $("tour-more-lede").textContent = more.length ? `Cards whose decks clearly won more. ${how}` : "No card's decks clearly won more yet.";
    $("tour-new-lede").textContent = fresh.length ? `Cards from the last few months that enough decks play to compare, best results first. Faded: too few decks to be sure yet.`
      : "No new card is in enough decks to compare yet.";
    $("tour-less-lede").textContent = less.length ? "Cards whose decks clearly won less than the same commanders' decks without them. "
      + "Often a sign of the slower or older style of deck they're played in."
      : "No card's decks clearly won less yet.";
    showTourMore(more.map(tile));
    showTourNew(fresh.map(tile));
    showTourLess(less.map(tile));
  }

  // The commanders, sorted and filtered, PAGE_ROWS at a time
  let shownRows = PAGE_ROWS;
  let current = { rows: [], fieldRate: 0, fieldCut: null };
  function showLeaderboard(rows, fieldRate, fieldCut) {
    current = { rows, fieldRate, fieldCut };
    shownRows = PAGE_ROWS;
    drawRows();
  }
  async function drawRows() {
    const { rows, fieldRate, fieldCut } = current;
    const min = Number($("tour-min").value) || 1;
    const q = $("tour-filter").value.trim().toLowerCase();
    // The filters, which also put the period, sort and min decks in the URL
    const days = all.windows[w];
    const f = readFilters(0, [...(days === 180 ? [] : [["results", days]]), ...(by === "decks" ? [] : [["by", by]]),
      ...(min === DEFAULT_MIN_DECKS ? [] : [["min", min]])]);
    const kept = f.active && new Set(filterCommanders(rows.map(r => ({
      key: r.key, identity: r.key.split("-").reduce((m, c) => m | index.columns.identity[c], 0),
      themes: themesOf.get(r.key) ?? [], price: -1, bracket: 0, made: [0],
    })), { ...f, window: 0, min: 0, maxPrice: null, brackets: [] }).map(c => c.key));
    const list = rows.filter(r => r.decks >= min && r.name.toLowerCase().includes(q) && (!kept || kept.has(r.key)))
      .sort((a, b) => SORTS_BY[by](b) - SORTS_BY[by](a) || b.decks - a.decks);
    for (const th of document.querySelectorAll(".leaderboard th")) {
      const sort = th.querySelector("button")?.dataset.sort;
      if (sort === by) th.setAttribute("aria-sort", "descending");
      else th.removeAttribute("aria-sort");
    }
    $("tour-commanders-lede").textContent = `${list.length.toLocaleString()} commanders with ${min} decks or more`
      + (f.active ? " that match the filters" : "")
      + `, by ${{ decks: "tournament decks", wins: "share of games won", cut: "share of decks making the top cut" }[by]}. `
      + "Games won and top cut are compared with every deck's.";
    const page = list.slice(0, shownRows);
    const infos = await Promise.all(page.map(r => Promise.all(r.key.split("-").map(c => cardInfo(+c)))));
    if (current.rows !== rows) return;
    const vs = (x, field) => (field === null || Math.abs(x - field) < SAME ? "" : points(x - field));
    $("tour-rows").replaceChildren(...page.map((r, i) => {
      const href = files.has(r.key) ? commanderLink(r.key) : "https://edhtop16.com/commander/"
        + encodeURIComponent(r.key.split("-").map(c => names[c]).sort().join(" / "));
      return el("tr", {},
        el("td", { className: "rank", textContent: i + 1 }),
        el("td", {}, el("a", { className: "who", href, ...(files.has(r.key) ? {} : { target: "_blank", rel: "noopener" }) },
          el("span", { className: "thumbs" }, ...infos[i].map(info => el("img", { src: artCrop(info.id), alt: "", loading: "lazy" }))),
          el("span", { textContent: r.name }))),
        el("td", { className: "num" }, r.decks.toLocaleString(), el("small", { className: "share", textContent: percent1(r.decks / all.field[w][0]) + " of decks" })),
        el("td", { className: "num" }, percent1(r.rate), el("small", { className: r.rate > fieldRate ? "up" : "down", textContent: vs(r.rate, fieldRate) })),
        el("td", { className: "num" }, r.cut === null ? "–" : percent1(r.cut),
          el("small", { className: r.cut > fieldCut ? "up" : "down", textContent: r.cut === null ? "" : vs(r.cut, fieldCut) })));
    }));
    $("more-tour").hidden = shownRows >= list.length;
  }
  $("more-tour").onclick = () => { shownRows += PAGE_ROWS; drawRows(); };
  $("tour-filter").oninput = () => { shownRows = PAGE_ROWS; drawRows(); };
  $("tour-min").oninput = $("tour-filter").oninput;
  tform.addEventListener("input", () => { shownRows = PAGE_ROWS; drawRows(); });
  for (const button of document.querySelectorAll(".leaderboard th button")) {
    button.onclick = () => { by = button.dataset.sort; shownRows = PAGE_ROWS; show(); };
  }
  show();
  whenFiltering(trends, () => {
    themesOf = new Map(trends.commanders.map(c => [c.key, c.themes]));
    drawRows();
  });
  tournamentsMessage("");
  $("tournaments-page").hidden = false;
}

// === Trends ===
const DEFAULT_DAYS = 30;
const NEW_DAYS = 120; // a card first printed this recently is new
const MAX_TRENDING = 300;
const percent = x => `${Math.round(x * 100)}%`;
let releasedPromise; // index/released.json: first release, in days since 1993-01-01
const getReleased = () => (releasedPromise ??= getJson("index/released.json"));
const today = Math.floor((Date.now() - Date.UTC(1993, 0, 1)) / 864e5);
const isNew = (released, card) => released[card] >= today - NEW_DAYS;
const showRising = typedGallery($("rising-types"), $("rising"), $("more-rising"));
const showNewCards = typedGallery($("new-types"), $("new-cards"), $("more-new"));
const showRisingCommanders = commanderGallery($("rising-commanders"), $("more-rising-commanders"));
const showPopularCommanders = commanderGallery($("popular-commanders"), $("more-popular-commanders"));
const showTrendRising = typedGallery($("trend-rising-types"), $("trend-rising"), $("more-trend-rising"));
const showTrendPlayed = typedGallery($("trend-played-types"), $("trend-played"), $("more-trend-played"));
const showTrendNew = typedGallery($("trend-new-types"), $("trend-new"), $("more-trend-new"));
const trendsMessage = text => {
  $("trends-message").textContent = text;
  $("trends-message").hidden = !text;
};

let trendData; // decks/trends.json, with each commander's name and colors
function loadTrends() {
  trendData ??= Promise.all([loadDeckData(), getJson("decks/trends.json")]).then(([{ names }, data]) => {
    const trends = decodeTrends(data);
    for (const c of trends.commanders) {
      c.name = commanderNames(c.key, names);
      c.identity = c.key.split("-").reduce((m, card) => m | index.columns.identity[card], 0);
    }
    return trends;
  });
  return trendData;
}
// Most of each commander's cards, for a filtered Trends: decks/trend-cards/<identity>.json, only for
// the color identities of the commanders it keeps (one, with a color filter)
const identityCards = new Map();
function loadTrendCards(trends, scope) {
  return Promise.all([...new Set(scope.map(c => c.identity))].map(colors => {
    if (!identityCards.has(colors)) {
      const loading = getJson(`decks/trend-cards/${colors}.json`).then(rows => withCards(trends.commanders, rows));
      loading.catch(() => identityCards.delete(colors)); // try again next time
      identityCards.set(colors, loading);
    }
    return identityCards.get(colors);
  }));
}

// On pages that don't need Trends' data (decks/trends.json, a few hundred KB) but for their filters:
// fetches it into `trends` once the filters are opened (or open already, from the URL), then done()
function whenFiltering(trends, done) {
  const load = () => loadTrends().then(data => {
    Object.assign(trends, data);
    $("trend-themes").replaceChildren(...data.themes.map(t => el("option", { value: tagLabel(t) })));
    done();
  }).catch(err => console.error(err));
  if ($("trend-filters").open) load();
  else $("trend-filters").addEventListener("toggle", load, { once: true });
}

// The Trends filters, shared with the commander list and the Tournaments tab: restored from the URL, then a function of the
// period that reads them as filterCommanders' options (with how many are active) and puts them in
// the URL after `lead` and `extra`, so a filtered view is a link to share
function trendFilters(trends, lead) {
  const tform = $("trend-form");
  for (const input of tform.elements) {
    if (input.type === "checkbox") input.checked = params.getAll(input.name).includes(input.value);
    else if (input.name && params.has(input.name)) input.value = params.get(input.name);
  }
  linkColorless(tform);
  $("trend-themes").replaceChildren(...trends.themes.map(t => el("option", { value: tagLabel(t) })));
  $("clear-trend-filters").href = "?" + new URLSearchParams(lead.map(k => [k, ""]));
  tform.addEventListener("submit", e => e.preventDefault());
  $("trend-filters").open = [...new FormData(tform)].some(([, v]) => v);
  return (window, extra = []) => {
    const data = new FormData(tform);
    const colors = data.getAll("c");
    const theme = data.get("theme").trim().toLowerCase();
    const f = {
      window,
      colors: !colors.length ? null : colors.includes("C") ? 0 : colors.reduce((m, c) => m | (1 << "WUBRG".indexOf(c)), 0),
      maxPrice: data.get("budget") ? Math.round((data.get("budget") / (money.rate ?? 1)) * 100) : null,
      themes: theme ? new Set(trends.themes.flatMap((t, i) => (tagLabel(t).toLowerCase().includes(theme) ? [i] : []))) : null,
      brackets: data.getAll("b").map(Number),
      kind: data.get("kind"),
      min: Number(data.get("min")) || 0,
    };
    f.active = (f.colors !== null) + (f.maxPrice !== null) + !!f.themes + !!f.brackets.length + !!f.kind + !!f.min;
    $("trend-filter-count").textContent = f.active;
    $("trend-filter-count").hidden = !f.active;
    history.replaceState(null, "", "?" + new URLSearchParams([...lead.map(k => [k, ""]), ...extra,
      ...[...data].filter(([, v]) => v)]));
    return f;
  };
}

async function showTrends() {
  const [{ decks }, trends, released] = await Promise.all([loadDeckData(), loadTrends(), getReleased()]);
  const windows = [{ days: null, since: 0 }, ...decks.windows.map((days, i) => ({ days, since: decks.since[i] }))];
  const fromUrl = windows.findIndex(w => String(w.days ?? "all") === params.get("w"));
  let w = windows[fromUrl]?.since != null ? fromUrl : windows.findIndex(x => x.days === DEFAULT_DAYS && x.since !== null);
  if (w < 0) w = 0;

  const readFilters = trendFilters(trends, ["trends"]);

  let shownFor;
  async function update() {
    const f = readFilters(w, [["w", windows[w].days ?? "all"]]);
    const { active } = f;
    $("trend-windows").replaceChildren(...windows.map((x, i) => ({ x, i })).reverse().map(({ x, i }) => el("button", {
      type: "button", ariaPressed: String(i === w), disabled: x.since === null, title: x.since === null ? "Not enough data yet" : "",
      onclick: () => { w = i; update(); },
    }, x.days ? `${x.days} days` : "All time")));

    const scope = active ? filterCommanders(trends.commanders, f) : trends.commanders;
    const { popular, rising, total, recent } = trendingCommanders(scope, w);
    const days = windows[w].days;
    $("trend-summary").textContent = !scope.length ? "No commanders match these filters."
      : (days ? `${recent.toLocaleString()} decks made in the last ${days} days, of ` : "")
        + `${total.toLocaleString()} decks by ${scope.length.toLocaleString()} commanders`;
    $("rising-commanders-panel").hidden = $("rising-cards-panel").hidden = !days;
    showRisingCommanders(rising.map(c => ({ key: c.key, name: c.name,
      detail: `${c.made[w]} new decks · ${c.ratio.toFixed(1)}× its usual share` })));
    $("popular-commanders-lede").textContent = days ? `Most decks made in the last ${days} days.` : "Most decks of all time.";
    showPopularCommanders(popular.map(c => ({ key: c.key, name: c.name,
      detail: `${c.made[w].toLocaleString()} ${days ? "new " : ""}decks` })));

    // Cards: over every deck at once, or the filtered commanders' (which needs most of their cards)
    const asked = shownFor = {};
    if (active) {
      trendsMessage("Loading cards…");
      await loadTrendCards(trends, scope);
      if (asked !== shownFor) return;
      trendsMessage("");
    }
    const cards = trendingCards(active ? scope : [trends.everything], w);
    const pick = (x, detail) => ({ card: x.card, type: typeOf(x.card), detail, bar: x.share });
    showTrendRising(cards.rising.slice(0, MAX_TRENDING).map(x => pick(x, `${percent(x.was)} → ${percent(x.share)} of decks`)));
    $("trend-played-lede").textContent = days ? `The share of the decks made in the last ${days} days that play each card.`
      : "The share of all these decks that play each card.";
    showTrendPlayed(cards.popular.slice(0, MAX_TRENDING).map(x => pick(x, `in ${percent(x.share)} of decks`)));
    showTrendNew(cards.popular.filter(x => isNew(released, x.card)).slice(0, MAX_TRENDING)
      .map(x => pick(x, `in ${percent(x.share)} of decks`)));
  }
  $("trend-form").addEventListener("input", update);
  await update();
  trendsMessage("");
  $("trends-page").hidden = false;
}

// === A card's page: the commanders whose decks play it, by what those decks are known for ===
const TREND_SHARE = 0.15; // TREND_SHARE in build_decks.py
const CARD_BLOCK = 16; // CARD_BLOCK in build_decks.py: cards per decks/card-commanders/ file
const MAX_STRATEGIES = 12;
const showCardCommanders = commanderGallery($("card-commanders"), $("more-card-commanders"));
async function showCardPage(card) {
  const trends = await loadTrends();
  if (!Number.isInteger(card) || card < 0 || card >= index.n) return commanderMessage("There's no such card.");
  const [info, pairs] = await Promise.all([cardInfo(card),
    getJson(`decks/card-commanders/${Math.floor(card / CARD_BLOCK)}.json`).then(rows => rows[card % CARD_BLOCK] ?? [])]);
  document.title = `${info.name} · MTG Vec2Search`;
  $("card-art").replaceChildren(el("button", { type: "button", className: "card", onclick: () => openCard(info.id, card) },
    el("img", { src: imageUrl(info.id), alt: info.name })));
  $("card-name").textContent = info.name;
  const { everything } = trends;
  const i = everything.cards.indexOf(card);
  const decksWith = i < 0 ? 0 : everything.plays[0][i];
  const playing = commandersPlaying(trends.commanders, pairs);
  $("card-meta").textContent = `In ${decksWith.toLocaleString()} of ${everything.made[0].toLocaleString()} decks (${percent(decksWith / everything.made[0])})`;
  $("card-lede").textContent = playing.length
    ? `${playing.length.toLocaleString()} commanders whose decks play it often (at least ${percent(TREND_SHARE)} of them), most often first. Pick a strategy to see the commanders known for it.`
    : `No commander's decks play it often enough to show here (at least ${percent(TREND_SHARE)} of them).`;
  // Strategies: what the commanders that play it are known for, by how many of their decks play it
  const weight = new Map();
  for (const c of playing) for (const t of c.themes) weight.set(t, (weight.get(t) ?? 0) + c.decks);
  const strategies = [null, ...[...weight].sort((a, b) => b[1] - a[1]).slice(0, MAX_STRATEGIES).map(([t]) => t)];
  const show = strategy => {
    showCardCommanders(playing.filter(c => strategy === null || c.themes.includes(strategy)).map(c => ({ key: c.key, name: c.name,
      detail: `in ${percent(c.share)} of ${c.made[0].toLocaleString()} decks` })));
  };
  $("card-themes").replaceChildren(...strategies.map(t => el("button", {
    type: "button", ariaPressed: String(t === null),
    onclick: e => {
      for (const b of $("card-themes").children) b.ariaPressed = String(b === e.currentTarget);
      show(t);
    },
  }, t === null ? "All" : tagLabel(trends.themes[t]),
  el("small", { textContent: t === null ? playing.length : playing.filter(c => c.themes.includes(t)).length }))));
  show(null);
  commanderMessage("");
  $("card-page").hidden = false;
}


if (commandersMode) {
  commanderMessage("Loading decks…");
  (cardKey !== null ? showCardPage(Number(cardKey)) : commanderKey !== null ? showCommander(commanderKey) : showCommanders()).catch(err => {
    console.error(err);
    commanderMessage("Couldn't load the deck data. Please try again.");
  });
}

if (tournamentsMode) {
  tournamentsMessage("Loading tournament results…");
  showTournaments().catch(err => {
    console.error(err);
    tournamentsMessage("Couldn't load the tournament results. Please try again.");
  });
}

if (trendsMode) {
  trendsMessage("Loading trends…");
  showTrends().catch(err => {
    console.error(err);
    trendsMessage("Couldn't load the trends. Please try again.");
  });
}

if (deckMode) {
  const link = params.get("deck");
  try { $("decklist").value = link || (localStorage.getItem("decklist") ?? ""); } catch { $("decklist").value = link; }
  const run = () => findSimilar().catch(err => {
    console.error(err);
    deckMessage("Couldn't load the deck data. Please try again.");
  });
  $("deck-form").addEventListener("submit", e => {
    e.preventDefault();
    run();
  });
  if (link) run(); // a shared ?deck=<link>
}

// === Start: everything above is set up, so run the search in the URL ===
if (searching) {
  message("Searching…");
  try {
    const [meta, columns, rate] = await Promise.all([getMeta(), getJson("index/columns.json"), usdRate(currency)]);
    money = moneyFormatter(currency, rate);
    index = buildIndex(meta, columns);
    await runSearch();
  } catch (err) {
    console.error(err);
    message("Couldn't load the card index. Please refresh to try again.");
  }
}
