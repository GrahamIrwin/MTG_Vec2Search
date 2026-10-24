import {
  parseQuery, buildIndex, search, nameSearch, mainTerms, termsNeeded, decodePosting, parsePrice,
  isBudget, BUDGET_USD, SORTS, sortResults, randomSearches, filterFn,
} from "./search.js";
import { CURRENCIES, detectCurrency, usdRate, moneyFormatter } from "./currency.js";
import {
  nameLookup, parseDecklist, decodeShard, similarDecks, foldCopies, recommend, closestCommanders,
  findBuilds, playCounts, distinctive, averageDeck, playedDifferently, buildName, buildTags, findPackages, packageGroups, comboDecks, groupCombos, comboPrimer,
  decodeTrends, withCards, filterCommanders, trendingCommanders, trendingCards, commandersPlaying, risingCards,
  cardResults, packageResults, MIN_RESULT_DECKS,
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
const pricesMode = params.has("prices");
const searching = !deckMode && !commandersMode && !trendsMode && !tournamentsMode && !pricesMode
  && [...params.keys()].some(k => k !== "sort");

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
// A row of buttons, the one picked pressed: options = [[value, label, disabled, tooltip]]; pick(value)
const chipRow = (box, options, current, pick) => box.replaceChildren(...options.map(([value, label, off, title = ""]) =>
  el("button", { type: "button", ariaPressed: String(value === current), disabled: !!off, title, onclick: () => pick(value) },
    ...[label].flat())));
// A button's label with its count beside it, smaller ("Rising 31")
const withCount = (label, n) => [label, el("small", { textContent: n.toLocaleString() })];

// The site's own data files are checked with the server before a cached copy is used (an
// unchanged file is a quick "304 Not Modified"): after a rebuild, a stale deck file read with a
// fresh card index would show the wrong cards
// Other names cards are printed under ([[name, card]]); none if the file's missing
let aliasData;
const getAliases = () => (aliasData ??= getJson("index/aliases.json").catch(() => []));
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
$("intro").hidden = searching || deckMode || commandersMode || trendsMode || tournamentsMode || pricesMode;
$("results").hidden = !searching;
form.hidden = deckMode || commandersMode || trendsMode || tournamentsMode || pricesMode;
$("deck-view").hidden = !deckMode;
$("commander-view").hidden = !commandersMode;
$("trends-view").hidden = !trendsMode;
$("tournaments-view").hidden = !tournamentsMode;
$("prices-view").hidden = !pricesMode;
$(deckMode ? "mode-deck" : commandersMode ? "mode-commanders" : trendsMode ? "mode-trends"
  : tournamentsMode ? "mode-tournaments" : pricesMode ? "mode-prices" : "mode-cards")
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
  // A name a card is printed under (Glittering Caves of Aglarond: Gemstone Caverns) is that card,
  // though its words would read as a search ("cave")
  const q = query.trim().toLowerCase();
  const printedAs = q ? (await getAliases()).filter(([name]) => name.toLowerCase() === q).map(([, card]) => card) : [];
  const groups = printedAs.length ? [] : parseQuery(query, index);
  if (printedAs.length) {
    results = nameSearch(index, [], query, filters, (await getAliases()).filter(([, card]) => printedAs.includes(card)));
  } else if (groups.length) {
    const postings = await Promise.all(termsNeeded(index, groups).map(async t => [t, decodePosting(await getJson(`index/t/${t}.json`))]));
    results = search(index, groups, new Map(postings), filters);
  } else if (query.trim() && filters.maxPrice === null) {
    results = nameSearch(index, await getJson("index/names.json"), query, filters, await getAliases());
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
    $("recognized").replaceChildren(el("span", { className: "muted", textContent: printedAs.length ? `Printed as “${query}”` : `Cards named “${query}”` }));
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
  if (!chunks.has(k)) {
    chunks.set(k, getJson(`index/c/${k}.json`).catch(err => {
      chunks.delete(k); // a failed fetch is tried again next time, not kept
      throw err;
    }));
  }
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
// extra: a tone for the detail ("up" or "down"), faint (too little to go on), a note under it,
// a printing's own price (US cents) in place of the card's cheapest, and whether it's the foil
function cardTile(card, info, detail, bar, i, { tone, faint, note, price: own, foil: isFoil } = {}) {
  const { name, id } = info;
  const price = own ?? index.columns.price[card];
  const img = el("img", { alt: name, loading: "lazy", decoding: "async" });
  img.onload = () => img.classList.add("loaded");
  img.src = imageUrl(id);
  const tile = el("button", { className: "card", type: "button", onclick: () => openCard(id, card, isFoil) },
    el("span", { className: "card-art" + (isFoil ? " foil-shimmer" : "") }, img),
    el("span", { className: "card-name", textContent: name }),
    el("span", { className: "card-meta" },
      el("span", { textContent: price >= 0 ? money.formatUsd(price / 100) : "No price" }),
      el("span", { textContent: detail, className: [tone, faint && "faint"].filter(Boolean).join(" ") })));
  if (note) tile.append(el("span", { className: "card-note", textContent: note }));
  tile.title = name;
  if (bar != null) tile.append(el("span", { className: "match-bar" }, el("span", { style: `width:${bar * 100}%` })));
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
    lines.push(el("p", {}, `In the last ${periodName(all.windows[w])}, ${percent1(decks / fieldDecks)} of ${fieldDecks.toLocaleString()} tournament decks play it (${decks.toLocaleString()} ${decks === 1 ? "deck" : "decks"}). `
      + (!commanders ? "Too few of any one commander's decks play it to compare."
        : Math.abs(evidence) < SIGNAL * 100 ? `No clear difference yet between decks with it and without it, within ${theCommanders(commanders)}.`
          : `Within ${theCommanders(commanders)}, decks with it had a win rate ${Math.abs(lift / 100).toFixed(1)} pts ${lift > 0 ? "higher" : "lower"} than decks without it.`),
      " ", el("a", { href: "?tournaments", textContent: "Tournaments →" })));
  }
  if (!lines.length) return;
  box.replaceChildren(el("span", { className: "label", textContent: "In cEDH tournaments" }), ...lines);
  box.hidden = false;
}

// card: its number in the index, when known, for links to the commanders that play it
// foilFirst: show its foil price first (a foil printing's tile on the Prices page)
let foilFirst = false;
let openedCard = null; // its number in the index, when known
async function openCard(id, card, showFoil = false) {
  foilFirst = showFoil;
  openedCard = card ?? null;
  showAlternatives(openedCard);
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
  foil.checked = (!card.prices.usd || foilFirst) && !!card.prices.usd_foil;
  foilFirst = false; // just for the printing it opened on
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
  showHistory(current.id, foil.checked ? "usd_foil" : "usd");
  showWatchButton();
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
// The order card types are listed in; build_index.py picks each card's (card_type)
const TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land"];
const TYPE_PLURALS = { Sorcery: "Sorceries" };
const deckMessage = text => {
  $("deck-message").textContent = text;
  $("deck-message").hidden = !text;
};

let deckData;
function loadDeckData() {
  deckData ??= Promise.all([getMeta(), getJson("index/columns.json"), getJson("index/names.json"),
    getDeckIndex(), usdRate(currency), getAliases()])
    .then(([meta, columns, names, decks, rate, aliases]) => {
      money = moneyFormatter(currency, rate);
      index = buildIndex(meta, columns);
      return { names, lookup: nameLookup(names, aliases), decks, files: new Set(decks.commanders.map(c => c[0])) };
    });
  deckData.catch(() => (deckData = null)); // try again next time
  return deckData;
}
const commanderNames = (key, names) => key.split("-").map(n => names[n]).join(" & ");
const typeOf = card => index.types[index.columns.kind[card]] ?? "Other";
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

// The tournament list to compare your deck with (?deck&from=<commander file name>.<its number in
// results/lists/>&pilot=<who played it>): the cards build_decks.py kept for it (basic lands aren't),
// and where it was played, from the pilot's history. {ref, key, pilot, lead, cards: Set, text, label}
let fromDeck = null;
let borrowed = null; // a tournament list being looked at as if it were yours: not saved as your deck
// A commander's average deck to compare a deck with (its page's "Compare your deck with it"):
// ref "avg.<commander>", its cards (but basic lands) in the URL in base 36, and the build's name
async function averageTarget(ref, encoded, build) {
  const key = ref.slice(4);
  const { names } = await loadDeckData();
  const cards = (encoded ?? "").split(".").filter(Boolean).map(c => parseInt(c, 36)).filter(c => names[c] !== undefined);
  if (!cards.length) throw new Error(`No cards for ${ref}`);
  const lead = commanderNames(key, names);
  return {
    ref, key, lead, cards: new Set(cards), average: true,
    params: { from: ref, cards: encoded, ...(build && { of: build }) },
    text: [...key.split("-").map(c => `1 ${names[c]} *CMDR*`), ...cards.map(c => `1 ${names[c]}`)].join("\n"),
    label: `The average ${lead} deck${build ? ` (${build})` : ""}`,
  };
}

async function tournamentDeck(ref, pilot) {
  const [key, i] = ref.split(".");
  const [{ names }, lists, block] = await Promise.all([loadDeckData(), getJson(`decks/results/lists/${key}.json`),
    pilot ? getJson(`decks/results/pilots/${Math.floor(pilot / PILOT_BLOCK)}.json`).catch(() => ({})) : {}]);
  const deck = lists.decks[Number(i)];
  if (!deck) throw new Error(`No tournament deck ${ref}`);
  let p = 0;
  const cards = deck.slice(4).map(gap => lists.cards[p += gap]);
  const [name, rows = []] = block[pilot] ?? [];
  const row = rows.find(r => r[8] === key && r[11] === Number(i));
  const lead = commanderNames(key, names);
  return {
    ref, key, pilot, lead, cards: new Set(cards),
    text: [...key.split("-").map(c => `1 ${names[c]} *CMDR*`), ...cards.map(c => `1 ${names[c]}`)].join("\n"),
    label: row ? `${name || "A pilot"}'s ${lead} list from ${row[1]}: ${ordinal(row[4])} of ${row[2]} on ${dateName(row[0])}, ${row[5]}–${row[6]}–${row[7]}`
      : `A ${lead} tournament list that won ${deck[2]} of its ${deck[1]} games`,
  };
}

// Your deck against the tournament list: the cards in one and not the other, each ranked by how the
// commander's tournament decks with it did against those without (cardResults, over the period its
// page shows first): theirs that win most first, as cards to add; yours that win least, to cut
const showAgainstAdds = typedGallery($("against-adds-types"), $("against-adds"), $("more-against-adds"));
const showAgainstCuts = typedGallery($("against-cuts-types"), $("against-cuts"), $("more-against-cuts"));
async function showAgainst(target, mine, ownKey) {
  const results = await getJson(`decks/results/${target.key}.json`).catch(() => null);
  const w = results && firstPeriod(results);
  const tested = new Map(results ? cardResults(results, w).map(x => [x.card, x]) : []);
  const lift = card => tested.get(card)?.lift;
  // cards with a result first, best (sign 1) or worst (-1) first; the rest after
  const order = sign => (a, b) => (lift(a) === undefined) - (lift(b) === undefined) || sign * ((lift(b) ?? 0) - (lift(a) ?? 0));
  const tile = card => (tested.has(card) ? resultTile(tested.get(card), results.totals[w][0])
    : { card, type: typeOf(card), bar: null, detail: "Few decks", faint: true, note: "Too few tournament decks with it, or without it, to compare" });
  const yours = new Set(mine);
  const adds = [...target.cards].filter(c => !yours.has(c)).sort(order(1));
  const cuts = mine.filter(c => !target.cards.has(c)).sort(order(-1));
  $("against-lede").textContent = `${target.label}. ${mine.length - cuts.length} of your cards are in it; it has ${adds.length} yours doesn't, and yours has ${cuts.length} it doesn't. `
    + (results ? `▲ and ▼: how much higher or lower the win rate of ${target.lead} tournament decks with the card is than of those without it, `
      + `in the last ${periodName(results.windows[w])}. A card can stand for a style of build, so weigh them together.` : "There are no tournament results to rank them by.")
    + (ownKey !== target.key ? " Your deck's commander isn't theirs, so expect many differences." : "");
  const theirs = target.average ? "the average deck" : "their list";
  $("against-heading").textContent = `Against ${theirs}`;
  $("against-adds-heading").textContent = `In ${theirs}, not yours: what to add`;
  $("against-cuts-heading").textContent = `In yours, not ${theirs}: what to cut`;
  $("against-adds-lede").textContent = adds.length ? (results ? "The biggest win rate boosts first. Faded: too few decks to be sure yet." : "")
    : `Your deck has every card in ${theirs}.`;
  $("against-cuts-lede").textContent = cuts.length ? (results ? "The lowest win rates first." : "")
    : `Every card in your deck is in ${theirs}.`;
  await Promise.all([showAgainstAdds(adds.map(tile)), showAgainstCuts(cuts.map(tile))]);
}

// A commander's tournament decks (results/lists/), or only those that made the top cut, as a shard
// to match a deck with: each named for its record, its number in the lists file as its id
let deckPool = params.get("decks") ?? "public"; // public, tournament or topcut
const poolFiles = new Map();
async function tournamentPool(key, topCut) {
  if (!poolFiles.has(key)) poolFiles.set(key, getJson(`decks/results/lists/${key}.json`).catch(err => { poolFiles.delete(key); throw err; }));
  const [{ cards, decks }, { windows }] = await Promise.all([poolFiles.get(key), getJson(`decks/results/${key}.json`)]);
  return decodeShard({ cards, decks: decks.flatMap(([w, games, wins, cut, ...gaps], i) => (topCut && cut !== 2 ? []
    : [[i, `Won ${wins} of ${games} games${cut === 2 ? ", made the top cut" : ""}`, periodName(windows[w]), gaps]])) });
}

// key: compare with this commander's decks instead of the deck's own commander
async function findSimilar(key) {
  const input = $("decklist").value;
  if (input !== borrowed) try { localStorage.setItem("decklist", input); } catch {}
  // A link goes in the address bar, so the page can be shared or bookmarked
  history.replaceState(null, "", "?" + new URLSearchParams({ deck: LINK.test(input.trim()) ? input.trim() : "",
    ...(fromDeck && (fromDeck.params ?? { from: fromDeck.ref, ...(fromDeck.pilot && { pilot: fromDeck.pilot }) })) }));
  $("deck-results").hidden = true;
  const deck = await readDeck(input);
  if (deck.error) return deckMessage(deck.error);
  deckMessage("Loading decks…");
  const { names, lookup, decks, files } = await loadDeckData();
  const parsed = parseDecklist(deck.list, lookup);
  // The commander: as marked in the list, or else the most-played commander among its cards
  let commanders = parsed.commanders;
  // None marked: the cards at the bottom (Moxfield's exports put the commanders there), if they're
  // a commander with decks; or else a guess: the most played pair of partners, or commander, in it
  if (!commanders.length && files.has([...parsed.possible].sort((a, b) => a - b).join("-"))) {
    commanders = parsed.possible;
    for (const c of commanders) parsed.cards.add(c);
  }
  const has = k => k.split("-").every(c => parsed.cards.has(+c));
  const guessed = !commanders.length && (decks.commanders.find(([k]) => k.includes("-") && has(k))
    ?? decks.commanders.find(([k]) => !k.includes("-") && has(k)));
  if (guessed) commanders = guessed[0].split("-").map(Number);
  const mine = [...parsed.cards].filter(c => !BASIC.test(names[c]) && !commanders.includes(c));
  if (!mine.length) return deckMessage("Couldn't find any card names in that list. Paste one card per line, like “1 Sol Ring”.");

  const ownKey = commanders.length ? [...commanders].sort((a, b) => a - b).join("-") : null;
  const closest = closestCommanders(decks, mine, 8);
  key ??= files.has(ownKey) ? ownKey : closest[0]?.key;
  if (!key) return deckMessage("Couldn't find any decks like this one yet.");
  const count = decks.commanders.find(c => c[0] === key)[1];
  const shard = decodeShard(await getJson(`decks/${key}.json`));
  // Its commander's tournament results (another commander's say nothing about this deck)
  const tourney = key === ownKey && shard.results ? await getJson(`decks/results/${key}.json`).catch(() => null) : null;
  // The decks to match it with (?decks=): public ones, or its commander's tournament decks, or those
  // that made the top cut, when there are MIN_AVERAGE_DECKS of them
  const totals = tourney?.totals.at(-1);
  const poolSizes = { public: count, ...(totals && { tournament: totals[0], topcut: totals[4] }) };
  const pool = poolSizes[deckPool] >= MIN_AVERAGE_DECKS ? deckPool : "public";
  setParams({ decks: pool === "public" ? null : pool });
  let matched = shard;
  if (pool !== "public") {
    try {
      matched = await tournamentPool(key, pool === "topcut");
    } catch {
      return deckMessage("Couldn't load the tournament decks. Please try again.");
    }
  }
  const poolDecks = { public: "decks", tournament: "tournament decks", topcut: "top-cut tournament decks" }[pool];
  const similar = similarDecks(matched, mine);
  const { adds, cuts, neighbors } = recommend(matched, similar, mine);

  // Summary: which deck, whose decks it's compared with, and what wasn't recognized
  const lead = commanderNames(key, names);
  const tw = tourney && firstPeriod(tourney);
  const tested = tourney ? cardResults(tourney, tw) : [];
  tournament = tourney && { lead, period: periodName(tourney.windows[tw]),
    byCard: new Map(tested.map(x => [x.card, { ...x, story: resultTile(x, tourney.totals[tw][0]).story }])) };
  const summary = [];
  const note = text => summary.push(el("span", { className: "muted", textContent: text }));
  if (deck.site) summary.push(el("span", { className: "term-chip", textContent: `${deck.name} (${deck.site})` }));
  summary.push(el("span", { className: "label", textContent: "compared with" }));
  if (totals) { // which of its decks: public, tournament or top cut
    const box = el("span", { className: "chips type-filter", role: "group", ariaLabel: "Compare with" });
    chipRow(box, [["public", "Public decks"], ["tournament", "Tournament decks"], ["topcut", "Top cut"]].map(([s, label]) => {
      const few = poolSizes[s] < MIN_AVERAGE_DECKS;
      return [s, withCount(label, poolSizes[s]), few, few ? `Too few to compare with: ${MIN_AVERAGE_DECKS} decks or more` : ""];
    }), pool, s => { deckPool = s; findSimilar(key).then(() => $("deck-results").scrollIntoView()); });
    summary.push(box);
  } else {
    summary.push(el("a", { className: "term", href: "?" + new URLSearchParams({ commander: key }), textContent: `${count.toLocaleString()} ${lead} decks` }));
  }
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
  showDeckValue([...mine, ...commanders], parsed.printings).then(() => deckSections(), err => {
    console.error(err); // no prices built: the page goes without
    $("deck-value-panel").hidden = true;
  });

  // Cards to add, within the deck's color identity, filterable by type
  const { identity } = index.columns;
  const colors = (commanders.length ? commanders : [...parsed.cards]).reduce((m, c) => m | identity[c], 0);
  const picks = adds.filter(a => (identity[a.card] & ~colors) === 0).slice(0, MAX_ADDS)
    .map(a => ({ card: a.card, type: typeOf(a.card), detail: `in ${a.decks} of ${neighbors} decks`, bar: a.decks / neighbors, ...tournamentNote(a.card) }));
  $("adds-lede").textContent = `What the ${neighbors} ${poolDecks} most like yours play that yours doesn't, favoring cards they play more than most ${lead} ${poolDecks} do.`;
  await showAdds(picks);

  // Combos: Commander Spellbook's that this commander's decks play, in your deck or one card from it
  // (a card in your colors, not another commander)
  const inDeck = new Set([...mine, ...commanders]);
  const shardLeaders = key.split("-").map(Number);
  const known = comboDecks(shard, shard.decks.map((_, d) => d), c => shardLeaders.includes(c));
  const away = combo => combo.cards.filter(c => !inDeck.has(c));
  const complete = known.filter(c => !away(c).length);
  const near = known.filter(c => away(c).length === 1 && !shardLeaders.includes(away(c)[0]) && (identity[away(c)[0]] & ~colors) === 0);
  const decksSay = k => `${k.toLocaleString()} ${lead} ${k === 1 ? "deck plays" : "decks play"} it`;
  $("deck-combos-panel").hidden = !shard.combos.length;
  $("deck-combos-lede").textContent = complete.length
    ? `Combos from Commander Spellbook in your deck, of those at least 2% of ${lead} decks play.`
    : `None of the combos at least 2% of ${lead} decks play (from Commander Spellbook) is in your deck.`;
  showRows($("deck-combos"), $("more-deck-combos"), groupCombos(complete).map(g => comboRow(g, decksSay)));
  $("combos-export").hidden = !complete.length;
  $("copy-combos").textContent = "Copy for a primer";
  $("copy-combos").onclick = async () => {
    try {
      await navigator.clipboard.writeText(comboPrimer(complete, names));
      $("copy-combos").textContent = "Copied";
    } catch {
      $("copy-combos").textContent = "Couldn't copy";
    }
  };
  $("near-combos-lede").textContent = near.length
    ? `Combos your deck is one card from (marked), most played first.`
    : `No combo ${lead} decks play is one card from your deck.`;
  showRows($("near-combos"), $("more-near-combos"), near.map(c => comboRow({ core: c.cards, options: [{ card: null, decks: c.decks, combo: c }] },
    decksSay, away(c)[0])));

  // Cuts only make sense against decks with your own commander: another's never play its cards
  $("cuts-section").hidden = key !== ownKey;
  const rare = cuts.filter(c => c.share < CUT_BELOW).slice(0, SHOW_CUTS);
  $("cuts-lede").textContent = rare.length ? `Your cards that the most similar ${poolDecks} rarely play, the rarest first.`
    : `None: similar ${poolDecks} play almost all of your cards.`;
  await showCuts(rare.map(c => ({ card: c.card, type: typeOf(c.card), detail: `in ${percent(c.share)} of similar decks`,
    bar: c.share, ...tournamentNote(c.card) })));

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
    $("mine-less-lede").textContent = less.length ? "Decks with these have a lower win rate than decks without them."
      : "None of your cards clearly lowers the win rate of the decks that play it.";
    $("missing-more-lede").textContent = more.length ? "Decks with these have a higher win rate than decks without them."
      : "Every card with a clearly higher win rate is already in your deck.";
    await Promise.all([showMineLess(less.map(x => resultTile(x, decksThere))), showMissingMore(more.map(x => resultTile(x, decksThere)))]);
  }

  // The similar decks, each opening to the cards they play that yours doesn't
  const have = new Set(mine);
  const items = foldCopies(similar.filter(r => r.similarity > 0), MAX_DECKS).map((r, i) => {
    const meta = `${r.shared} cards in common · ${pool === "public" ? "updated" : "played in the last"} ${r.deck.updated}`
      + (r.copies ? ` · ${r.copies} near-${r.copies === 1 ? "copy" : "copies"}` : "");
    const details = el("details", {},
      el("summary", {},
        el("span", { className: "sim", textContent: `${Math.round(r.similarity * 100)}%` }),
        el("span", { className: "deck-name", textContent: r.deck.name || "Untitled deck" }),
        pool === "public" ? openDeck(r.deck.id) : compareLink(key, r.deck.id),
        el("span", { className: "deck-meta", textContent: meta })));
    details.addEventListener("toggle", () => {
      const theirs = [...r.deck.cards].map(p => matched.cards[p]).filter(c => !have.has(c)).sort((a, b) => a - b);
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

  // Against a tournament list, when there's one to compare with
  $("against-panel").hidden = !fromDeck;
  if (fromDeck) await showAgainst(fromDeck, mine, ownKey);

  deckMessage("");
  $("deck-results").hidden = false;
  deckSections = pageSections($("deck-results"), $("deck-views"), [["against", fromDeck?.average ? "Against the average deck"
    : "Against their list"], ["adds", "Cards to add"],
    ["cuts", "Cards to cut"], ["combos", "Combos"], ["tournament", "Tournament check"], ["similar", "Similar decks"],
    ["worth", "What it's worth"]], $("deck-how"), {
    against: "Their list against yours: what's in theirs and not yours, and in yours and not theirs, each ranked by how "
      + "the commander's tournament decks with it did against those without.",
    adds: "The decks most like yours (by the cards you share, rare ones counting for more) vote on cards. Cards any "
      + "deck with this commander plays count for less, so the list is what decks like yours play more than usual. "
      + "Tournament decks and Top cut (beside “compared with”) match it with the commander's cEDH tournament lists of "
      + "the last 2 years, or only those that made the top cut, instead of public decks.",
    cuts: "Your cards that the decks most like yours rarely play.",
    combos: "Combos from Commander Spellbook that this commander's decks play: in your deck, or one card away (a card "
      + "in your colors).",
    tournament: "How the commander's cEDH tournament decks with each card did against those without it.",
    similar: "The decks behind these picks, and commanders whose decks play the most of your cards.",
    worth: "Each card at its cheapest printing, now and 30 days and a year ago (over the cards priced then).",
  }, fromDeck ? "against" : "adds");
}
let deckSections = () => {}; // shows the deck's sections again, as one fills in later (its worth)

// A gallery of cards with a type filter, PAGE_ADDS cards at a time. Returns a function that
// shows picks: [{card, type, detail, bar}]
const typeLabel = t => (t === "All" ? "All" : TYPE_PLURALS[t] ?? `${t}s`);
function typedGallery(types, gallery, more) {
  let view;
  async function show() {
    const current = view;
    const counts = {};
    for (const p of current.picks) counts[p.type] = (counts[p.type] ?? 0) + 1;
    chipRow(types, ["All", ...TYPE_ORDER, "Other"].filter(t => t === "All" || counts[t])
      .map(t => [t, withCount(typeLabel(t), t === "All" ? current.picks.length : counts[t])]),
    current.type, t => { view = { ...current, type: t, shown: PAGE_ADDS }; show(); });
    const list = current.type === "All" ? current.picks : current.picks.filter(p => p.type === current.type);
    const page = list.slice(0, current.shown);
    const infos = await Promise.all(page.map(a => cardInfo(a.card)));
    if (current !== view) return; // filtered again while loading
    gallery.replaceChildren(...page.map((a, i) => cardTile(a.card, a.id ? { ...infos[i], id: a.id } : infos[i],
      a.detail, a.bar, i % PAGE_ADDS, a)));
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
const showCuts = typedGallery($("cut-types"), $("cuts"), $("more-cuts"));
const showMineLess = typedGallery($("mine-less-types"), $("mine-less"), $("more-mine-less"));
const showMissingMore = typedGallery($("missing-more-types"), $("missing-more"), $("more-missing-more"));

// === Commanders: every commander with decks, and what their decks play ===
const PAGE_COMMANDERS = 30;
const SIGNATURE_SHOWN = 60;
const PAGE_LISTS = 20;
const MIN_AVERAGE_DECKS = 10; // tournament decks (or top cuts) for an average of them
const BRACKETS = ["Any", "1 Exhibition", "2 Core", "3 Upgraded", "4 Optimized", "5 cEDH"];
const BASIC_OF = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
const commanderMessage = text => {
  $("commander-message").textContent = text;
  $("commander-message").hidden = !text;
};
const commanderLink = key => "?" + new URLSearchParams({ commander: key });

// Changes some of the URL's parameters (null: leaves it out), so a view is a link to share
// A page's sections, one at a time: `views` ([[name, label]]) as buttons in `box`, and in `root`
// each one's elements (data-<attr>="name") shown only for it, and controls some of them share
// (data-<attr>s="name name ...") only for those. pick(name): another was picked
function showSections(root, box, views, current, pick, attr = "view") {
  for (const e of root.querySelectorAll(`[data-${attr}]`)) e.hidden = e.dataset[attr] !== current;
  for (const e of root.querySelectorAll(`[data-${attr}s]`)) e.hidden = !e.dataset[`${attr}s`].split(" ").includes(current);
  chipRow(box, views, current, pick);
}

// A page's sections (showSections), the one in the URL (view=) shown and kept there. views:
// [[name, label]], those with nothing in them (every panel hidden) left out; how: {name: text} for
// howBox; first: the one shown first when it's there. Returns a function that shows them again,
// for when a section's panels change
function pageSections(page, box, views, howBox, how, first = null) {
  let view = new URLSearchParams(location.search).get("view");
  const draw = () => {
    const shown = views.filter(([v]) => [...page.querySelectorAll(`[data-view="${v}"] .panel`)].some(p => !p.hidden));
    if (!shown.some(([v]) => v === view)) view = shown.some(([v]) => v === first) ? first : shown[0]?.[0];
    showSections(page, box, shown, view, v => {
      view = v;
      setParams({ view: v });
      draw();
    });
    howBox.textContent = how[view] ?? "";
  };
  draw();
  return draw;
}

// Back to the top of the page, smoothly unless the visitor would rather not
$("to-top").onclick = () => scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

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
// Combos and packages, PAGE_COMBOS at a time. rows: [{cards: elements, meta: text and elements, how:
// async () => elements explaining it, test: cards to test}]. test: showResults' tester. "How it works" and "Test
// in tournaments" each open a box in the row.
const PAGE_COMBOS = 10;
function showRows(list, more, rows, test = null) {
  let shown = 0;
  list.replaceChildren();
  // A button that opens a box under the row with what show() gives, the first time it's opened
  const opener = (label, show) => {
    const box = el("div", { className: "combo-box", hidden: true });
    const button = el("button", { type: "button", className: "link-button", textContent: label, ariaExpanded: "false",
      onclick: async () => {
        const open = button.ariaExpanded !== "true";
        button.ariaExpanded = String(open);
        box.hidden = !open;
        if (open && !box.childElementCount) {
          box.append(el("p", { className: "muted", textContent: "Loading…" }));
          box.replaceChildren(...await show());
        }
      } });
    return [button, box];
  };
  const row = r => {
    const opens = [r.how && opener("How it works", r.how),
      test && r.test && opener("Test in tournaments", () => test(r.test)
        .catch(() => [el("p", { className: "muted", textContent: "Couldn't load the tournament decks." })]))].filter(Boolean);
    return el("li", {}, el("div", { className: "combo-cards" }, ...r.cards),
      el("p", { className: "combo-meta" }, ...r.meta),
      ...(opens.length ? [el("p", { className: "combo-meta combo-actions" }, ...opens.flatMap(([button], i) => [...(i ? [" · "] : []), button]))] : []),
      ...opens.map(([, box]) => box));
  };
  more.onclick = () => {
    list.append(...rows.slice(shown, shown + PAGE_COMBOS).map(row));
    shown += PAGE_COMBOS;
    more.hidden = shown >= rows.length;
  };
  more.onclick();
}
const joined = (items, by = "+") => items.flatMap((x, i) => (i ? [el("span", { className: "plus", textContent: by }), x] : [x]));
// A small card image that opens the card, with a caption under it (optional)
function miniCard(card, caption = "", className = "") {
  const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
  img.onload = () => img.classList.add("loaded");
  const tile = el("button", { type: "button", className: `card mini ${className}` }, el("span", { className: "card-art" }, img),
    ...(caption ? [el("span", { className: "card-meta", textContent: caption })] : []));
  cardInfo(card).then(info => {
    img.alt = tile.title = info.name;
    img.src = imageUrl(info.id);
    tile.onclick = () => openCard(info.id, card);
  });
  return tile;
}
// A row for a group of combos (see groupCombos): its cards, the one that differs as choices (each with
// its decks), the other pieces it needs, and what it makes. decks(k): how to say how many decks play
// it. missing: a card to add, marked (one card away)
function comboRow({ core, options }, decks, missing = null) {
  const card = (c, caption = "") => (c === missing ? miniCard(c, "Not in your deck", "missing") : miniCard(c, caption));
  const first = options[0].combo;
  const choices = options.length > 1 ? [el("span", { className: "choices" },
    ...joined(options.map(o => card(o.card, `${o.decks.toLocaleString()} ${o.decks === 1 ? "deck" : "decks"}`)), "or"))] : [];
  return {
    cards: [...joined([...core.map(c => card(c)), ...choices]),
      ...first.needs.map(n => el("span", { className: "plus need", textContent: `+ any ${n}` }))],
    meta: [`${decks(options[0].decks)} · ${first.makes.join(", ") || "a combo"}`],
    how: () => comboSteps(first, options.length > 1 && options[0].card),
    test: first.cards,
  };
}
// Text with mana symbols ({G}, {2/W}, {T}) as Scryfall's images
const withSymbols = text => text.split(/(\{[^}]+\})/).filter(Boolean).map(part => (/^\{.+\}$/.test(part)
  ? el("img", { className: "mana", alt: part, src: `https://svgs.scryfall.io/card-symbols/${part.slice(1, -1).replace("/", "")}.svg` })
  : part));
// How a combo works, from Commander Spellbook: what it needs first, then its steps. choice: the card
// these steps are for, of a group's choices
async function comboSteps({ id, how }, choice) {
  const lines = text => text.split("\n").map(t => t.trim()).filter(Boolean);
  const before = [...lines(how.easy), ...lines(how.notable), ...(how.mana ? [`${how.mana} available.`] : [])];
  return [
    ...(choice ? [el("p", { className: "muted", textContent: `With ${(await cardInfo(choice)).name}; the others work the same way.` })] : []),
    ...(before.length ? [el("h4", { textContent: "First" }), el("ul", {}, ...before.map(t => el("li", {}, ...withSymbols(t))))] : []),
    el("h4", { textContent: "Then" }),
    el("ol", {}, ...lines(how.steps).map(t => el("li", {}, ...withSymbols(t)))),
    el("p", { className: "muted" }, "From ",
      el("a", { href: `https://commanderspellbook.com/combo/${id}/`, target: "_blank", rel: "noopener", textContent: "Commander Spellbook ↗" })),
  ];
}

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
  $("builds-lede").textContent = builds.length ? "" : `Too few ${lead} decks, or too alike, to tell builds apart.`;
  $("builds-lede").hidden = !!builds.length;
  $("builds-row").hidden = !builds.length;
  // The build's decks of one bracket (the one its builder gave it), or all of them. The URL holds
  // both (the build by name), so a view of a commander is a link to share.
  let build = groups.find(g => g.name === params.get("build")) ?? groups[0];
  let bracket = Math.max(0, BRACKETS.findIndex((_, b) => b && String(b) === params.get("bracket")));
  const showBuilds = () => chipRow($("builds"), groups.map((g, i) =>
    [g, withCount(g.name, i ? `${Math.round(g.members.length / n * 100)}%` : n)]), build, g => { build = g; showBuilds(); showBuild(); });
  showBuilds();

  // Packages, with the decks in groups of alike ones (see packageGroups), each with the combos it's part of
  // (Displacer Kitten and Teferi: with Sol Ring, or Mana Vault, ...)
  const groupOf = packageGroups(shard, builds.map(b => b.members), { lands, gameChangers: new Set(index.game_changers ?? []) });
  const staples = new Set((decks.staples ?? []).map(c => shard.position.get(c)));
  const packages = findPackages(shard, { lands, staples, groups: groupOf }).map(p => p.cards.map(q => shard.cards[q]))
    .map(cards => ({ cards, combos: shard.combos.filter(c => cards.every(x => c.cards.includes(x))).length }));

  const ofBracket = (members, b) => members.filter(d => shard.decks[d].bracket === b);
  $("bracket-filter").hidden = !shard.decks.some(d => d.bracket);
  function showBuild() {
    if (!ofBracket(build.members, bracket).length) bracket = 0;
    setParams({ build: build.all ? null : build.name, bracket: bracket || null });
    const given = build.members.length - ofBracket(build.members, 0).length;
    $("commander-builds-how").textContent = (builds.length
      ? `Builds: ${lead} decks split into ${builds.length} by the cards they play (lands left out: they mostly show a budget), `
        + "each named for the kind of card (Scryfall Tagger tag) it plays more of than the rest. " : "")
      + `Brackets are the ones each deck's builder gave it: ${percent(given / build.members.length)} of these decks have one.`
      + (bracket === 5 && tournament ? ` With bracket 5, cards also show how their decks did in tournaments in the last ${tournament.period}.` : "");
    chipRow($("brackets"), BRACKETS.map((label, b) => {
      const k = b ? ofBracket(build.members, b).length : build.members.length;
      return [b, withCount(label, k), !k];
    }), bracket, b => { bracket = b; showBuild(); });
    return showGroup(!bracket ? build : { ...build, all: false, members: ofBracket(build.members, bracket),
      name: [build.all ? "" : build.name, `bracket ${bracket}`].filter(Boolean).join(", ") });
  }

  let current;
  async function showGroup(g) {
    current = g;
    const all = g.all;
    const counts = playCounts(shard, g.members);
    const share = p => counts[p] / g.members.length;
    const detail = p => played(counts[p], share(p));

    const tile = p => ({ card: shard.cards[p], type: typeOf(shard.cards[p]), detail: detail(p), bar: share(p), ...cedh(shard.cards[p]) });

    // Signature cards: what sets these decks apart from other commanders' decks (all of them),
    // or from the commander's other decks (a build)
    $("signature-lede").textContent = all
      ? "What these decks play far more than other commanders' decks."
      : `What this build plays far more than other ${lead} decks`
        + (g.tags?.length ? `: ${g.tags.map(t => tagLabel(t).toLowerCase()).join(", ")}.` : ".");
    showSignature((all ? (shard.signature ?? entry[2]).map(c => shard.position.get(c)).filter(p => p !== undefined)
      : distinctive(shard, g.members, { n: SIGNATURE_SHOWN, ignore: lands })).slice(0, SIGNATURE_SHOWN).map(tile));

    showPlayed([...counts.keys()].filter(p => counts[p]).sort((a, b) => counts[b] - counts[a] || a - b).map(tile));
    showCombos(g);
    showCommanderTrends(g, counts);

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

    return showAverage(g); // after the rest, as it's the most to load
  }

  // The average deck, of the build's public decks (and bracket), or of every tournament deck, or
  // those that made the top cut (?avg=): as many spells and nonbasic lands as those decks play on
  // average, then basic lands, split evenly between the colors, to make 100 cards
  const tourney = results?.totals.at(-1); // [decks, ...] over every window, top cuts at 4
  const averageFroms = [["public", "Public decks"], ...(tourney ? [["tournament", "Tournament decks"], ["topcut", "Top cut"]] : [])];
  let averageFrom = averageFroms.some(([s]) => s === params.get("avg")) ? params.get("avg") : "public";
  let tournamentShard; // the commander's tournament decks, shaped like a shard for averageDeck
  const getTournamentShard = () => (tournamentShard ??= getJson(`decks/results/lists/${key}.json`).then(({ cards, decks }) => ({
    cards,
    decks: decks.map(([, , , topCut, ...gaps]) => { let p = 0; return { topCut, cards: gaps.map(gap => (p += gap)) }; }),
    lands: new Set(cards.flatMap((c, p) => (index.columns.types[c] & landBit ? [p] : []))),
  })).catch(err => { tournamentShard = null; throw err; }));
  // The cards these tournament decks play most differently from the build's public decks (and
  // bracket's), each a row with a dot for each on a 0–100% track
  function showAverageVs(g, from, members, counts) {
    const plays = (cards, k) => new Map(cards.flatMap((c, p) => (k[p] ? [[c, k[p]]] : [])));
    const pub = { plays: plays(shard.cards, playCounts(shard, g.members)), decks: g.members.length };
    const { more, less } = playedDifferently(pub, { plays: plays(from.cards, counts), decks: members.length });
    const these = averageFrom === "topcut" ? "top-cut decks" : "tournament decks";
    const publicName = `public decks${g.all ? "" : ` (${g.name})`}`;
    const decksOf = k => `${k.toLocaleString()} ${k === 1 ? "deck" : "decks"}`;
    const pct = x => (x > 0 && x < 0.005 ? "<1%" : percent(x)); // one deck in 231 isn't none
    $("average-vs-heading").textContent = `What ${these} play differently`;
    $("average-vs-lede").textContent = `The cards whose share of decks differs most between ${lead}'s ${these} and its `
      + `${publicName}, among those at least 15% of either play. Each card's shares: public → ${averageFrom === "topcut" ? "top cut" : "tournament"}.`;
    $("average-vs-tourney").textContent = `${these[0].toUpperCase()}${these.slice(1)} (${members.length.toLocaleString()})`;
    $("average-vs-public").textContent = `${publicName[0].toUpperCase()}${publicName.slice(1)} (${g.members.length.toLocaleString()})`;
    const row = r => el("li", { title: `${names[r.card]}: ${pct(r.a)} of ${publicName} (${decksOf(r.aDecks)}), `
        + `${pct(r.b)} of ${these} (${decksOf(r.bDecks)})` },
      cardButton(r.card, names),
      el("div", { className: "vs-track" },
        el("span", { className: "span", style: `left:${Math.min(r.a, r.b) * 100}%;width:${Math.abs(r.b - r.a) * 100}%` }),
        el("span", { className: "dot public", style: `left:${r.a * 100}%` }),
        el("span", { className: "dot tourney", style: `left:${r.b * 100}%` })),
      el("span", { className: "shares", textContent: `${pct(r.a)} → ${pct(r.b)}` }));
    const group = (label, rows) => (rows.length ? [el("li", { className: "group", textContent: label }), ...rows.map(row)] : []);
    const scale = el("li", { className: "scale", ariaHidden: "true" }, el("span"),
      el("div", { className: "vs-track" }, ...["0%", "50%", "100%"].map(x => el("span", { textContent: x }))), el("span"));
    $("average-vs-rows").replaceChildren(scale, ...group(`${these} play more`, more), ...group(`${these} play less`, less));
    if (!more.length && !less.length) $("average-vs-lede").textContent = `No card at least 15% of either plays differs between ${lead}'s ${these} and its ${publicName}.`;
  }

  let averageShown;
  async function showAverage(g) {
    const shown = averageShown = {};
    const n = { public: g.members.length, tournament: tourney?.[0], topcut: tourney?.[4] };
    if (n[averageFrom] < MIN_AVERAGE_DECKS) averageFrom = "public";
    setParams({ avg: averageFrom === "public" ? null : averageFrom });
    chipRow($("average-from"), averageFroms.map(([s, label]) => {
      const few = s !== "public" && n[s] < MIN_AVERAGE_DECKS;
      return [s, withCount(label, n[s]), few, few ? `Too few to average: ${MIN_AVERAGE_DECKS} decks or more` : ""];
    }), averageFrom, s => { averageFrom = s; showAverage(current); });
    $("average-from").hidden = averageFroms.length < 2;

    let from = shard, members = g.members, landsOf = lands, name = g.all ? "" : g.name;
    if (averageFrom !== "public") {
      try {
        from = await getTournamentShard();
      } catch {
        $("average-lede").textContent = "Couldn't load the tournament decks. Please try again.";
        return;
      }
      if (averageShown !== shown) return;
      members = from.decks.flatMap((d, i) => (averageFrom === "topcut" && d.topCut !== 2 ? [] : [i]));
      landsOf = from.lands;
      name = averageFrom === "topcut" ? "tournament decks that made the top cut" : "tournament decks";
    }
    const counts = playCounts(from, members);
    const share = p => counts[p] / members.length;
    $("average-vs").hidden = averageFrom === "public";
    if (averageFrom !== "public") showAverageVs(g, from, members, counts);
    const average = averageDeck(from, members, landsOf);
    const basics = Math.max(0, 100 - leaders.length - average.spells.length - average.lands.length);
    const kinds = colors.length ? colors.map(c => BASIC_OF[c]) : ["Wastes"];
    const basicCounts = kinds.map((b, i) => [names.indexOf(b), Math.floor(basics / kinds.length) + (i < basics % kinds.length)])
      .filter(([, k]) => k);
    const decksOf = `${members.length.toLocaleString()} ${averageFrom === "public" ? "public" : "cEDH tournament"} decks`;
    $("average-lede").textContent = (averageFrom === "public" ? `From ${decksOf}`
      : `From ${decksOf} of the last ${periodName(results.windows.at(-1))}${averageFrom === "topcut" ? " that made the top cut" : ""}, any build or bracket`)
      + `: ${average.spells.length} spells and ${average.lands.length + basics} lands (${basics} basic).`;
    const picks = [...average.spells, ...average.lands].map(p => ({ card: from.cards[p], detail: played(counts[p], share(p)), bar: share(p), ...cedh(from.cards[p]) }))
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
    $("compare-average").href = "?" + new URLSearchParams({ deck: "", from: `avg.${key}`,
      cards: [...average.spells, ...average.lands].map(p => from.cards[p].toString(36)).join("."), ...(name && { of: name }) });
    $("download-average").onclick = () => {
      const a = el("a", { download: `${lead}${name ? ` (${name})` : ""} average deck.txt`,
        href: URL.createObjectURL(new Blob([listText()], { type: "text/plain" })) });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href));
    };

    // Its cards, by type
    const averageInfos = await Promise.all(sections.map(([, list]) => Promise.all(list.map(a => cardInfo(a.card)))));
    if (averageShown !== shown) return; // another build, or other decks, picked while loading
    $("average").replaceChildren(...sections.flatMap(([t, list], s) => [
      el("h3", {}, typeLabel(t), el("small", { textContent: list.reduce((k, a) => k + (a.copies ?? 1), 0) })),
      el("div", { className: "gallery" }, ...list.map((a, i) => cardTile(a.card, averageInfos[s][i], a.detail, a.bar, i, a))),
    ]));
  }

  // Combos and packages these decks play, each with how many of them play all of it
  function showCombos(g) {
    const m = g.members.length, these = g.all ? `${lead} decks` : "these decks";
    const combos = groupCombos(comboDecks(shard, g.members, c => leaders.includes(c)).filter(c => c.decks && c.decks >= 0.01 * m));
    $("combos-lede").textContent = combos.length
      ? `Combos in 1% of ${these} or more, most played first.`
      : `None of Commander Spellbook's combos is in 1% of ${these}.`;
    showRows($("combos"), $("more-combos"), combos.map(group => comboRow(group, k => `${percent(k / m)} of ${these} (${k.toLocaleString()})`)), testPackage);
    shard.sets ??= shard.decks.map(d => new Set(d.cards));
    const counted = packages.map(({ cards, combos }) => {
      const ps = cards.map(c => shard.position.get(c));
      return { cards, combos, decks: g.members.reduce((k, d) => k + ps.every(p => shard.sets[d].has(p)), 0) };
    }).filter(p => p.decks >= Math.max(3, 0.03 * m)).sort((a, b) => b.decks - a.decks);
    $("packages-lede").textContent = counted.length
      ? `Cards ${these} play together far more often than chance would have it.`
      : `No cards that ${these} play together far more often than chance would have it.`;
    showRows($("packages"), $("more-packages"), counted.map(p => ({
      cards: joined(p.cards.map(c => miniCard(c))),
      meta: [`${percent(p.decks / m)} of ${these} play all of them (${p.decks.toLocaleString()})`,
        ...(p.combos ? [` · part of ${p.combos === 1 ? "a combo" : `${p.combos} combos`}`] : [])],
      test: p.cards,
    })), testPackage);
    // Combos or packages, one at a time
    const tabs = [["combos", "Combos", combos.length], ["packages", "Packages", counted.length]];
    const pickTab = name => {
      comboTab = name;
      for (const [t] of tabs) $(`${t}-tab`).hidden = t !== name;
      chipRow($("combo-tabs"), tabs.map(([t, label, k]) => [t, withCount(label, k)]), name, pickTab);
    };
    pickTab(comboTab);
  }
  let comboTab = "combos";

  // Trends: what the decks made lately play more of, for a window of days (index.json's windows)
  const windows = (decks.windows ?? []).map((days, i) => ({ days, since: decks.since[i] }));
  let shownWindow = windows.findIndex(w => w.days === DEFAULT_DAYS && w.since !== null);
  if (shownWindow < 0) shownWindow = windows.findIndex(w => w.since !== null);
  function showCommanderTrends(g, counts) {
    const recentOf = w => (w.since === null ? [] : g.members.filter(d => shard.decks[d].made >= w.since));
    chipRow($("commander-windows"), windows.map((w, i) => [i, withCount(`${w.days} days`, w.since === null ? "–" : recentOf(w).length),
      w.since === null, w.since === null ? "Not enough data yet" : ""]).reverse(),
    shownWindow, i => { shownWindow = i; showCommanderTrends(g, counts); });
    const w = windows[shownWindow];
    const recent = w ? recentOf(w) : [];
    const whose = g.all ? `${lead}'s` : "these";
    $("commander-trends-lede").textContent = !w
      ? "Not enough data yet: decks show up here once the crawler knows when they were made."
      : `${recent.length.toLocaleString()} of ${whose} ${g.members.length.toLocaleString()} decks were made in the last ${w.days} days.`;
    const pick = (p, detail, bar) => ({ card: shard.cards[p], type: typeOf(shard.cards[p]), detail, bar, ...cedh(shard.cards[p]) });
    showRising(recent.length ? risingCards(shard, g.members, recent)
      .map(x => pick(x.p, `${percent(x.was)} → ${played(x.decks, x.share)}`, x.share)) : []);
    showNewCards([...counts.keys()].filter(p => counts[p] && isNew(released, shard.cards[p]))
      .sort((a, b) => counts[b] - counts[a] || a - b)
      .map(p => pick(p, played(counts[p], counts[p] / g.members.length), counts[p] / g.members.length)));
  }

  // The page's sections, one at a time (in the URL); a link into the tournament results opens on them
  const views = [["cards", "Cards"], ["trends", "Trends"], ...(results ? [["tournaments", "Tournaments"]] : []),
    ["combos", "Combos & packages"], ["average", "Average deck"], ["decklists", "Decklists"]];
  let view = views.some(([v]) => v === params.get("view")) ? params.get("view")
    : results && (params.has("results") || params.has("package")) ? "tournaments" : "cards";
  const how = {
    cards: "Signature cards: what these decks play far more often than other commanders' decks do (or, for a build, "
      + `than ${lead}'s other decks). Most played: every card, by the share of these decks that play it.`,
    trends: "Rising: cards the decks made in the period play more often than these decks do overall, from a few decks up "
      + "counting for more (1% to 4% beats 60% to 66%). New cards: first printed in the last few months.",
    tournaments: "cEDH tournaments of 16 players or more. Points are 5 for a win and 1 for a draw. Each card's decks are "
      + "measured against the commander's other decks, so the commander's own strength doesn't count: ▲ and ▼ are how "
      + "many points higher or lower their win rate is, allowing for how few decks play it. It's the decks that won, so a "
      + "card can stand for a style of build. Faded: too few decks to be sure yet. Pilots: who played its decks, and how "
      + "it does without the ones who won the most.",
    combos: "Combos from Commander Spellbook that these decks play every card of; combos that differ in one card are "
      + "shown as one, with each choice's decks. Packages: cards these decks play together far more often than chance, "
      + "compared among decks of the same build, as tuned and with as many Game Changers, so cards don't go together "
      + `just for being in the same kind of deck. Staples every deck plays and ${lead}'s precon are left out.`,
    average: "As many spells and nonbasic lands as these decks play on average, picking the cards they play most, then "
      + "basic lands, split evenly between the colors, to make 100 cards. Every deck counts the same. Public decks: the "
      + "build and bracket picked above. Tournament decks: every cEDH tournament list of the last 2 years, wherever it "
      + `placed; Top cut: only those that made their event's top cut. Each needs ${MIN_AVERAGE_DECKS} decks or more. `
      + "With either, the cards those decks play most differently from the public decks: the 6 whose share of decks "
      + "rose most and the 6 it fell most, among cards at least 15% of either plays.",
    decklists: "Public decks from Moxfield and Archidekt, newest first, with their cards.",
  };
  const showViews = () => {
    showSections($("commander-page"), $("commander-views"), views, view, v => {
      view = v;
      setParams({ view: v === "cards" ? null : v });
      showViews();
    });
    $("commander-how").textContent = how[view];
    $("commander-source").hidden = view !== "tournaments";
  };
  showViews();

  // Tournament results; picking bracket 5 also notes each card's on its tile
  tournament = null;
  $("results-panel").hidden = !results;
  const testPackage = results ? showResults(key, results, names, released, () => bracket === 5 && showBuild()) : null;
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
// "win rate +4 pts with it": how much higher (or lower) a win rate is with a card than without
const winChange = (withIt, without) => {
  const d = Math.round((withIt - without) * 100);
  return d ? `win rate ${d > 0 ? "+" : "−"}${Math.abs(d)} pts with it` : "same win rate with it or without";
};
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
    note: `Win rate ${percent(x.winRate)} with it, ${percent(x.winRateWithout)} without · ${played(x.decks, x.share)}`,
    story: `Win rate ${percent1(x.winRate)} with it (over ${x.games.toLocaleString()} games), ${percent1(x.winRateWithout)} without.`
      + (x.conversion === null || x.conversionWithout === null ? ""
        : ` ${percent1(x.conversion)} of decks with it made the top cut, ${percent1(x.conversionWithout)} without.`)
      + ` ${x.decks.toLocaleString()} of ${decks.toLocaleString()} decks play it.`
      + (Math.abs(x.evidence) < SIGNAL ? " Too few decks to be sure yet." : ""),
  };
}
// Match points a game: 5 for a win, 1 for a draw. With draws, the average deck scores a little
// over 1.2, not 1.25. Two shown this close are about the same
const perGame = (games, wins, draws) => (games ? (5 * wins + draws) / games : 0);
const SAME_POINTS = 0.05;
const vsPoints = (x, field) => (Math.abs(x - field) < SAME_POINTS ? "About the same as"
  : `${x > field ? "▲" : "▼"} ${Math.abs(x - field).toFixed(2)} vs`) + ` ${field.toFixed(2)} for all decks`;
const pointsTone = (x, field) => (Math.abs(x - field) < SAME_POINTS ? "" : x > field ? "up" : "down");
// value: text, or a node such as a link
function statTile(label, value, note, tone) {
  return el("div", { className: "stat" }, el("span", { className: "label", textContent: label }),
    el("span", { className: "stat-value" }, value),
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
function showResults(key, results, names, released, onPeriod) {
  const leads = key.split("-").map(c => names[c]);
  const lead = leads.join(" & ");
  $("results-source").href = "https://edhtop16.com/commander/" + encodeURIComponent([...leads].sort().join(" / "));
  const usable = w => results.totals[w][0] >= 2 * MIN_RESULT_DECKS;
  const first = firstPeriod(results);
  let w = results.windows.indexOf(Number(params.get("results")));
  if (w < 0) w = first;
  const period = () => periodName(results.windows[w]);
  // Its parts, one at a time: a link with a package to test opens on that
  let part = params.has("package") ? "test" : "cards";
  const showParts = () => showSections($("results-panel"), $("results-parts"),
    [["cards", "Cards"], ["finishes", "Best finishes"], ["pilots", "Pilots"], ["test", "Test a package"]], part,
    p => { part = p; showParts(); }, "part");
  showParts();

  // A package of cards to test (one or more; in the URL): the decks one by one, fetched the first time
  let pkg = (params.get("package") ?? "").split(".").filter(Boolean).map(Number).filter(c => names[c] !== undefined);
  let lists, byName;
  const getLists = () => (lists ??= getJson(`decks/results/lists/${key}.json`).then(data => {
    byName = new Map();
    for (const c of data.cards) for (const n of [names[c], names[c].split(" // ")[0]]) byName.set(n.toLowerCase(), c);
    $("package-cards").replaceChildren(...data.cards.map(c => el("option", { value: names[c] })));
    return data;
  }));
  async function showPackage() {
    setParams({ package: pkg.length ? pkg.join(".") : null });
    $("package-chips").replaceChildren(...pkg.map(c => el("button", {
      type: "button", className: "term", title: `Take ${names[c]} out`,
      onclick: () => { pkg = pkg.filter(x => x !== c); showPackage(); },
    }, names[c], el("span", { ariaHidden: "true", textContent: "×" }))));
    $("package-result").hidden = !pkg.length;
    $("package-note").textContent = "";
    if (!pkg.length) return;
    const shown = pkg, data = await getLists();
    if (shown !== pkg) return; // changed while loading
    const { tiles, note } = packageView(data, pkg);
    $("package-result").replaceChildren(...tiles);
    $("package-note").textContent = note;
  }
  // A package's results over the period shown: stat tiles, and a note on them
  function packageView(data, cards) {
    const r = packageResults(data, cards, w);
    const one = cards.length === 1;
    const sides = s => `${s.decks.toLocaleString()} ${s.decks === 1 ? "deck" : "decks"}, ${s.games.toLocaleString()} games`
      + (s.cutDecks ? `; ${percent(s.cuts / s.cutDecks)} made the top cut` : "");
    const sure = r.lift !== null && Math.abs(r.evidence) >= SIGNAL;
    return {
      tiles: [
        statTile(`${one ? "With it" : "With all of them"}: win rate`, r.all.games ? percent1(r.all.wins / r.all.games) : "–", sides(r.all)),
        statTile(`${one ? "Without it" : "With none"}: win rate`, r.none.games ? percent1(r.none.wins / r.none.games) : "–", sides(r.none)),
        r.lift === null ? statTile("Difference", "–", `Too few decks ${r.all.decks ? "without" : "with"} ${one ? "it" : "them"} to compare`)
          : statTile("Difference", points(r.lift), sure ? `A clearly ${r.lift > 0 ? "higher" : "lower"} win rate with ${one ? "it" : "them"}`
            : "Too few decks to be sure yet", sure ? (r.lift > 0 ? "up" : "down") : ""),
      ],
      note: (r.some.decks ? `${r.some.decks.toLocaleString()} ${r.some.decks === 1 ? "deck plays" : "decks play"} only some of them, left out. ` : "")
        + `In the last ${period()}. As for single cards, both sides are pulled toward ${lead}'s win rate, so a few decks need a big difference to show one; `
        + "and a card can stand for a style of build rather than win on its own.",
    };
  }
  // The example to test: a niche card, one that some but not most of its decks play (over two years)
  const last = results.windows.length - 1;
  const niche = results.cards.filter((_, i) => Math.abs(results.stats[i][5 * last] / results.totals[last][0] - 0.15) <= 0.1);
  const example = pick(niche.length ? niche : results.cards);
  $("package-input").placeholder = example === undefined ? "Add a card" : `Add a card, e.g. ${names[example]}`;
  $("package-input").onfocus = () => getLists();
  $("package-input").onchange = async () => {
    const typed = $("package-input").value.trim();
    if (!typed) return;
    await getLists();
    const card = byName.get(typed.toLowerCase());
    if (card === undefined) {
      $("package-note").textContent = `No ${lead} tournament deck plays “${typed}”. Pick a card from the list as you type.`;
      return;
    }
    if (!pkg.includes(card)) pkg = [...pkg, card];
    $("package-input").value = "";
    showPackage();
  };

  function show() {
    setParams({ results: w === first ? null : results.windows[w] });
    chipRow($("results-windows"), results.windows.map((days, i) => [i, withCount(`Last ${periodName(days)}`, results.totals[i][0])]),
      w, i => { w = i; show(); showPackage(); onPeriod(); });

    // The headline: how its decks do against every deck in these tournaments
    const [decks, games, wins, cutDecks, cuts, draws = 0] = results.totals[w];
    const [, fieldGames, fieldWins, fieldCutDecks, fieldCuts, fieldDraws = 0] = results.field[w];
    const rate = wins / games, fieldRate = fieldWins / fieldGames;
    const ppg = perGame(games, wins, draws), fieldPpg = perGame(fieldGames, fieldWins, fieldDraws);
    const vs = (x, field) => (Math.abs(x - field) < SAME ? "About the same as" : points(x - field) + " vs")
      + ` ${percent1(field)} for all decks`;
    const tone = d => (Math.abs(d) < SAME ? "" : d > 0 ? "up" : "down");
    $("results-lede").textContent = `${lead} decks in cEDH tournaments of 16 players or more.`;
    $("results-stats").replaceChildren(
      statTile("Tournament decks", decks.toLocaleString(), `in the last ${period()}, ${games.toLocaleString()} games`),
      statTile("Points per game", ppg.toFixed(2), vsPoints(ppg, fieldPpg), pointsTone(ppg, fieldPpg)),
      statTile("Win rate", percent1(rate), vs(rate, fieldRate), tone(rate - fieldRate)),
      cutDecks && fieldCutDecks
        ? statTile("Made the top cut", percent1(cuts / cutDecks), vs(cuts / cutDecks, fieldCuts / fieldCutDecks), tone(cuts / cutDecks - fieldCuts / fieldCutDecks))
        : statTile("Made the top cut", "–", "No events with a top cut"));

    // Pilots: who played its decks, and how it does without the ones who won the most
    const pilots = (results.pilots ?? []).map(([id, name, ...flat]) => {
      const [decks, games, wins] = flat.slice(6 * w, 6 * w + 3);
      return { id, name, decks, games, wins };
    }).filter(p => p.decks).sort((a, b) => b.decks - a.decks || b.wins - a.wins);
    $("pilots-section").hidden = !pilots.length;
    const best = [...pilots].sort((a, b) => b.wins - a.wins).slice(0, TOP_PILOTS);
    const bestGames = best.reduce((k, p) => k + p.games, 0), bestWins = best.reduce((k, p) => k + p.wins, 0);
    $("pilots-lede").textContent = `${pilots.length.toLocaleString()} ${pilots.length === 1 ? "pilot" : "pilots"}, most decks first.`
      + (pilots.length > TOP_PILOTS && games > bestGames
        ? ` Without its ${TOP_PILOTS} with the most wins (${best.map(p => p.name).join(" and ")}), its win rate is `
          + `${percent1((wins - bestWins) / (games - bestGames))} (${percent1(rate)} with them, ${percent1(fieldRate)} for all decks).`
        : "");
    const pilotChip = p => el("a", {
      className: "term", href: pilotLink(p.id), title: `${p.decks} ${p.decks === 1 ? "deck" : "decks"}, ${p.wins} wins in ${p.games} games`,
    }, p.name || "Unknown", el("small", { textContent: `${p.decks} ${p.decks === 1 ? "deck" : "decks"} · ${p.games ? percent(p.wins / p.games) : "–"} win rate` }));
    const showAll = el("button", { type: "button", className: "term", textContent: `All ${pilots.length.toLocaleString()} →`,
      onclick: () => $("pilots").replaceChildren(...pilots.map(pilotChip)) });
    $("pilots").replaceChildren(...pilots.slice(0, SHOWN_PILOTS).map(pilotChip), pilots.length > SHOWN_PILOTS ? showAll : "");

    // Cards: how much more (or less) often the decks playing each one win
    const cards = cardResults(results, w);
    const tile = x => resultTile(x, decks);
    tournament = { lead, period: period(), byCard: new Map(cards.map(x => [x.card, { ...x, story: tile(x).story }])) };
    const few = !usable(w) ? `There are too few ${lead} decks in the last ${period()} to compare cards. Try a longer period.` : "";
    const more = cards.filter(x => x.lift > 0 && x.evidence >= SIGNAL).sort((a, b) => b.lift - a.lift);
    $("wins-more-lede").textContent = few || (more.length
      ? "Decks with these win more than the commander's other decks. Open a card for the numbers."
      : `No card clearly raises the win rate of these ${decks.toLocaleString()} decks.`);
    showWinsMore(more.map(tile));
    const fresh = cards.filter(x => isNew(released, x.card)).sort((a, b) => b.lift - a.lift);
    $("results-new-lede").textContent = few || (fresh.length
      ? `New cards in ${MIN_RESULT_DECKS} or more of these decks, best results first.`
      : `No new card is in ${MIN_RESULT_DECKS} or more of these decks yet.`);
    showResultsNew(fresh.map(tile));
    const less = cards.filter(x => x.lift < 0 && x.evidence <= -SIGNAL).sort((a, b) => a.lift - b.lift);
    $("wins-less-lede").textContent = few || (less.length
      ? "Decks with these win less: worth a second look."
      : "No card clearly lowers the win rate of these decks.");
    showWinsLess(less.map(tile));

    // Its best finishes in the period, newest first, each with its decklist
    const since = new Date(Date.now() - results.windows[w] * 864e5).toISOString().slice(0, 10);
    const finishes = results.top.filter(f => f[0] >= since);
    $("finishes-lede").textContent = finishes.length
      ? `${finishes.length.toLocaleString()} top ${TOP_FINISH} finishes, newest first. Records are won–lost–drawn.`
      : `No top ${TOP_FINISH} finishes in the last ${period()}.`;
    let shown = 0;
    $("finishes").replaceChildren();
    $("more-finishes").onclick = () => {
      $("finishes").append(...finishes.slice(shown, shown + PAGE_FINISHES).map(([date, event, size, standing, won, lost, drew, link, pilot, pilotName, deck = -1]) =>
        finishItem(standing, event, link, pilot ? [el("a", { href: pilotLink(pilot), textContent: pilotName || "Unknown pilot" })] : [],
          [`of ${size} players`, dateName(date), `${won}–${lost}–${drew}`], key, deck, pilot)));
      shown += PAGE_FINISHES;
      $("more-finishes").hidden = shown >= finishes.length;
    };
    $("more-finishes").onclick();
  }
  show();
  showPackage();
  // To test a package from elsewhere on the page, over the period shown here: elements to show
  // (every deck plays the commander, so it's left out)
  return async cards => {
    const { tiles, note } = packageView(await getLists(), cards.filter(c => !key.split("-").includes(String(c))));
    return [el("div", { className: "result-stats" }, ...tiles), el("p", { className: "muted deck-lede", textContent: note })];
  };
}
const TOP_FINISH = 4; // TOP_FINISH in build_decks.py
const TOP_PILOTS = 2; // the pilots a commander's results are shown without
const SHOWN_PILOTS = 24;
const pilotLink = id => `?tournaments&pilot=${id}`;
const dateName = date => new Date(date).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
// A tournament deck in a list: its place, event and decklist, and a line of what else is known
// (`lead`: nodes before it, such as links). key and deck: the deck in results/lists/<key>.json, for a
// link that compares your deck with it in Deck recommendations (-1: not there); pilot: who played it
const compareLink = (key, deck, pilot) => el("a", {
  className: "open", href: "?" + new URLSearchParams({ deck: "", from: `${key}.${deck}`, ...(pilot && { pilot }) }), textContent: "Compare",
  title: "Compare your deck with this list: what each plays that the other doesn't, ranked by how tournament decks with those cards won",
});
function finishItem(standing, event, link, lead, facts, key = "", deck = -1, pilot = 0) {
  return el("li", { className: "finish" },
    el("span", { className: "place", textContent: ordinal(standing) }),
    el("span", { className: "deck-name", textContent: event }),
    el("span", { className: "finish-links" }, listLink(link) ?? "", key && deck >= 0 ? compareLink(key, deck, pilot) : ""),
    el("span", { className: "deck-meta" }, ...lead.flatMap(node => [node, " · "]), facts.join(" · ")));
}

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
const SORTS_BY = { decks: r => r.decks, ppg: r => r.ppg, wins: r => r.rate, cut: r => r.cut ?? -1 };
const PILOT_SORTS = { points: r => r.points, ...SORTS_BY };
const FOUND_PILOTS = 12; // in a search's results
// Rows of a leaderboard from totals one window after another: those of window w
function totalsRow(flat, w) {
  const [decks, games, wins, cutDecks, cuts, draws] = flat.slice(6 * w, 6 * w + 6);
  return { decks, games, rate: games ? wins / games : 0, points: 5 * wins + draws, ppg: perGame(games, wins, draws),
    cut: cutDecks ? cuts / cutDecks : null };
}
// A leaderboard's numbers: decks (and their share of all fieldDecks, if given), then each of `columns`, compared with
// every deck's (field) where it has one
function rankCells(r, fieldDecks, field, columns) {
  const vs = (x, f) => (f === null || Math.abs(x - f) < SAME ? "" : points(x - f));
  const cells = {
    points: () => el("td", { className: "num" }, r.points.toLocaleString()),
    ppg: () => el("td", { className: "num" }, r.ppg.toFixed(2), el("small", {
      className: pointsTone(r.ppg, field.ppg), textContent: Math.abs(r.ppg - field.ppg) < SAME_POINTS ? ""
        : `${r.ppg > field.ppg ? "▲" : "▼"} ${Math.abs(r.ppg - field.ppg).toFixed(2)}` })),
    wins: () => el("td", { className: "num" }, percent1(r.rate), el("small", { className: r.rate > field.rate ? "up" : "down", textContent: vs(r.rate, field.rate) })),
    cut: () => el("td", { className: "num" }, r.cut === null ? "–" : percent1(r.cut),
      el("small", { className: r.cut > field.cut ? "up" : "down", textContent: r.cut === null ? "" : vs(r.cut, field.cut) })),
  };
  return [el("td", { className: "num" }, r.decks.toLocaleString(),
    fieldDecks ? el("small", { className: "share", textContent: percent1(r.decks / fieldDecks) + " of decks" }) : ""),
    ...columns.map(c => cells[c]())];
}
// Points a sort is by, in words
const SORT_NAMES = { decks: "tournament decks", points: "match points", ppg: "match points per game", wins: "win rate",
  cut: "share of decks making the top cut" };

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
    chipRow($("tour-windows"), all.windows.map((d, i) => [i, withCount(`Last ${periodName(d)}`, all.field[i][0])]),
      w, i => { w = i; show(); });
    const fieldDecks = all.field[w][0];
    const field = totalsRow(all.field[w], 0);
    const rows = commanders.map(c => ({ ...c, ...totalsRow(c.flat, w) })).filter(r => r.decks);
    $("tour-stats").replaceChildren(
      statTile("Tournament decks", fieldDecks.toLocaleString(), `with decklists, in the last ${periodName(days)}`),
      statTile("Commanders", rows.length.toLocaleString(), `${rows.filter(r => r.decks >= DEFAULT_MIN_DECKS).length.toLocaleString()} with ${DEFAULT_MIN_DECKS} decks or more`),
      statTile("Win rate", percent1(field.rate), "of the average deck: about 1 game in 5, as draws keep it under 1 in 4"),
      statTile("Points per game", field.ppg.toFixed(2), "by the average deck: 5 for a win, 1 for a draw"));
    showLeaderboard(rows, field);
    drawRanking();

    // Cards, across commanders: each compared only within the commanders that play it
    const cards = all.cards.flatMap((card, i) => {
      const [decks, n, lift, evidence] = all.stats[i].slice(4 * w, 4 * w + 4);
      return n ? [{ card, decks, n, lift: lift / 10000, evidence: evidence / 100 }] : [];
    });
    const tile = x => ({
      card: x.card, type: typeOf(x.card), bar: null, detail: points(x.lift), tone: x.lift > 0 ? "up" : "down",
      faint: Math.abs(x.evidence) < SIGNAL,
      note: `${played(x.decks, x.decks / fieldDecks)} · ${x.n} ${x.n === 1 ? "commander" : "commanders"}`,
    });
    const more = cards.filter(x => x.lift > 0 && x.evidence >= SIGNAL).sort((a, b) => b.lift - a.lift);
    const less = cards.filter(x => x.lift < 0 && x.evidence <= -SIGNAL).sort((a, b) => a.lift - b.lift);
    const fresh = cards.filter(x => isNew(released, x.card)).sort((a, b) => b.lift - a.lift);
    $("tour-more-lede").textContent = more.length ? "Their decks win more than the same commanders' decks without them."
      : "No card clearly raises its decks' win rate yet.";
    $("tour-new-lede").textContent = fresh.length ? "New cards that enough decks play to compare, best results first."
      : "No new card is in enough decks to compare yet.";
    $("tour-less-lede").textContent = less.length ? "Their decks win less: often a sign of a slower or older style of deck."
      : "No card clearly lowers its decks' win rate yet.";
    showTourMore(more.map(tile));
    showTourNew(fresh.map(tile));
    showTourLess(less.map(tile));
  }

  // The commanders, sorted and filtered, PAGE_ROWS at a time
  let shownRows = PAGE_ROWS;
  let current = { rows: [], field: null };
  function showLeaderboard(rows, field) {
    current = { rows, field };
    shownRows = PAGE_ROWS;
    drawRows();
  }
  async function drawRows() {
    const { rows, field } = current;
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
    for (const th of document.querySelectorAll("#tour-table th")) {
      const sort = th.querySelector("button")?.dataset.sort;
      if (sort === by) th.setAttribute("aria-sort", "descending");
      else th.removeAttribute("aria-sort");
    }
    $("tour-commanders-lede").textContent = `${list.length.toLocaleString()} commanders with ${min} decks or more`
      + (f.active ? " that match the filters" : "") + `, by ${SORT_NAMES[by]}.`;
    const page = list.slice(0, shownRows);
    const infos = await Promise.all(page.map(r => Promise.all(r.key.split("-").map(c => cardInfo(+c)))));
    if (current.rows !== rows) return;
    $("tour-rows").replaceChildren(...page.map((r, i) => {
      const href = files.has(r.key) ? commanderLink(r.key) : "https://edhtop16.com/commander/"
        + encodeURIComponent(r.key.split("-").map(c => names[c]).sort().join(" / "));
      return el("tr", {},
        el("td", { className: "rank", textContent: i + 1 }),
        el("td", {}, el("a", { className: "who", href, ...(files.has(r.key) ? {} : { target: "_blank", rel: "noopener" }) },
          el("span", { className: "thumbs" }, ...infos[i].map(info => el("img", { src: artCrop(info.id), alt: "", loading: "lazy" }))),
          el("span", { textContent: r.name }))),
        ...rankCells(r, all.field[w][0], field, ["ppg", "wins", "cut"]));
    }));
    $("more-tour").hidden = shownRows >= list.length;
  }
  $("more-tour").onclick = () => { shownRows += PAGE_ROWS; drawRows(); };
  $("tour-filter").oninput = () => { shownRows = PAGE_ROWS; drawRows(); };
  $("tour-min").oninput = $("tour-filter").oninput;
  tform.addEventListener("input", () => { shownRows = PAGE_ROWS; drawRows(); });
  for (const button of document.querySelectorAll("#tour-table th button")) {
    button.onclick = () => { by = button.dataset.sort; shownRows = PAGE_ROWS; show(); };
  }

  // Pilot rankings (decks/results/ranking.json): the pilots with a few decks or more, for the period
  // shown, PAGE_ROWS at a time
  const ranking = getJson("decks/results/ranking.json").catch(() => null);
  let rankBy = "points", shownRanked = PAGE_ROWS;
  async function drawRanking() {
    const data = await ranking;
    $("ranking").hidden = !data;
    if (!data) return;
    const v = data.windows.indexOf(all.windows[w]);
    const min = Number($("ranking-min").value) || 1;
    const field = totalsRow(all.field[w], 0);
    const list = data.pilots.map(([id, name, ...flat]) => ({ id, name, ...totalsRow(flat, v) }))
      .filter(r => r.decks >= min).sort((a, b) => PILOT_SORTS[rankBy](b) - PILOT_SORTS[rankBy](a) || b.decks - a.decks);
    for (const th of document.querySelectorAll("#ranking-table th")) {
      if (th.querySelector("button")?.dataset.sort === rankBy) th.setAttribute("aria-sort", "descending");
      else th.removeAttribute("aria-sort");
    }
    $("ranking-lede").textContent = `${list.length.toLocaleString()} pilots with ${min} decks or more in the last ${periodName(all.windows[w])}, `
      + `by ${SORT_NAMES[rankBy]}.`;
    $("ranking-rows").replaceChildren(...list.slice(0, shownRanked).map((r, i) => el("tr", {},
      el("td", { className: "rank", textContent: i + 1 }),
      el("td", {}, el("a", { className: "who", href: pilotLink(r.id), textContent: r.name || "Unknown pilot" })),
      ...rankCells(r, null, field, ["points", "ppg", "wins", "cut"]))));
    $("more-ranking").hidden = shownRanked >= list.length;
  }
  $("more-ranking").onclick = () => { shownRanked += PAGE_ROWS; drawRanking(); };
  $("ranking-min").oninput = () => { shownRanked = PAGE_ROWS; drawRanking(); };
  for (const button of document.querySelectorAll("#ranking-table th button")) {
    button.onclick = () => { rankBy = button.dataset.sort; shownRanked = PAGE_ROWS; drawRanking(); };
  }

  // Highlights: the last month's standout commanders (see highlights() in build_decks.py)
  const h = all.highlights;
  const leadOf = key => (files.has(key) ? el("a", { href: commanderLink(key), textContent: commanderNames(key, names) }) : commanderNames(key, names));
  const whoPlayed = ([, decks, , pilots]) => `${decks} decks` + (pilots ? ` by ${pilots} ${pilots === 1 ? "pilot" : "pilots"}` : "");
  const tiles = h ? [
    h.best && statTile("Best results", leadOf(h.best[0]), `${h.best[2].toFixed(2)} points a game (all decks: ${h.field.toFixed(2)}), ${whoPlayed(h.best)}`),
    h.breakout && statTile("Breakout", leadOf(h.breakout[0]),
      `${whoPlayed(h.breakout)}: ${percent1(h.breakout[1] / h.decks)} of all decks, `
        + (h.breakout[4] ? `up from ${percent1(h.breakout[4])} the ${h.before} days before` : `with none the ${h.before} days before`)),
    h.rising && statTile("Rising", leadOf(h.rising[0]), `${h.rising[4].toFixed(2)} → ${h.rising[2].toFixed(2)} points a game, ${whoPlayed(h.rising)}`),
  ].filter(Boolean) : [];
  $("highlights-section").hidden = !tiles.length;
  $("highlights-heading").textContent = h ? `The last ${h.days} days` : "";
  $("highlights").replaceChildren(...tiles);
  show();
  whenFiltering(trends, () => {
    themesOf = new Map(trends.commanders.map(c => [c.key, c.themes]));
    drawRows();
  });

  // Search: pilots by name, with what they play (decks/results/pilots.json, fetched once the search is used)
  let pilotIndex, found = [];
  const getPilots = () => (pilotIndex ??= getJson("decks/results/pilots.json").then(list => list.map(([id, name, decks, ...flat]) => {
    const played = [];
    for (let i = 0; i < flat.length; i += 2) played.push([flat[i], flat[i + 1]]);
    return { id, name, decks, played, lower: name.toLowerCase() };
  })).catch(err => { pilotIndex = null; throw err; }));
  const decksOf = n => `${n.toLocaleString()} ${n === 1 ? "deck" : "decks"}`;
  const leadLink = key => (files.has(key) ? el("a", { href: commanderLink(key), textContent: commanderNames(key, names) }) : commanderNames(key, names));
  async function searchPilots() {
    const typed = $("pilot-input").value.trim(), q = typed.toLowerCase();
    $("pilot-note").textContent = "";
    $("pilot-results").hidden = q.length < 2;
    found = [];
    if (q.length < 2) return;
    let pilots;
    try { pilots = await getPilots(); } catch { $("pilot-note").textContent = "Couldn't load the pilots. Please try again."; return; }
    if ($("pilot-input").value.trim().toLowerCase() !== q) return; // typed on meanwhile
    found = pilots.filter(p => p.lower.includes(q));
    $("pilot-results").hidden = !found.length;
    if (!found.length) {
      $("pilot-note").textContent = `No pilot in these tournaments is named like “${typed}”.`;
      return;
    }
    $("pilot-results").replaceChildren(el("h3", { className: "sub-heading" }, `Pilots: ${found.length.toLocaleString()}`),
      el("ul", { className: "found-list" }, ...found.slice(0, FOUND_PILOTS).map(p => el("li", {},
        el("a", { href: pilotLink(p.id), textContent: p.name || "Unknown pilot" }), " ",
        el("small", {}, decksOf(p.decks), p.played.length ? ": " : "", ...p.played.slice(0, 3).flatMap(([key, n], i) =>
          [i ? ", " : "", leadLink(key), ` ${n}`]), p.played.length > 3 ? `, and ${p.played.length - 3} more` : "")))),
      found.length > FOUND_PILOTS ? el("p", { className: "muted", textContent: `And ${(found.length - FOUND_PILOTS).toLocaleString()} more: type more of the name.` }) : "");
  }
  $("pilot-input").onfocus = () => getPilots().catch(() => {});
  $("pilot-input").oninput = searchPilots;
  // Enter: the pilot of exactly that name (the one with most decks), or the only one found
  $("pilot-input").onkeydown = e => {
    if (e.key !== "Enter") return;
    const q = $("pilot-input").value.trim().toLowerCase();
    const pick = found.find(p => p.lower === q) ?? (found.length === 1 ? found[0] : null);
    if (pick) location.search = pilotLink(pick.id);
  };
  tournamentsMessage("");
  $("tournaments-page").hidden = false;
  pageSections($("tournaments-page"), $("tour-views"), [["commanders", "Commanders"], ["pilots", "Pilots"], ["cards", "Cards"]],
    $("tour-how"), {
      commanders: "cEDH tournaments of 16 players or more. Commanders by decks, points per game (5 for a win, 1 for a draw), "
        + "win rate or top cut, each compared with every deck's.",
      pilots: "Players with 5 or more tournament decks in two years, by match points, points per game, games won or top "
        + "cuts. Search a pilot by name at the top.",
      cards: "Each card's decks are measured against the same commander's decks without it, then averaged over the "
        + "commanders that play it, so a card isn't credited for the commanders it's played with. ▲ and ▼ are how many "
        + "points higher or lower their win rate is. A card can stand for a style of deck (turbo lists play Rite of Flame, "
        + "slower ones Force of Will), so read these as what winning decks play, not proof a card wins on its own. Faded: "
        + "too few decks to be sure yet.",
    });
}

// === A pilot's page: every tournament deck they played (decks/results/pilots/<block>.json) ===
const PILOT_BLOCK = 64; // PILOT_BLOCK in build_decks.py
const showPilotCards = typedGallery($("pilot-cards-types"), $("pilot-cards"), $("more-pilot-cards"));
async function showPilot(id) {
  const [all, { names, files }, block, ranked] = await Promise.all([getResultsIndex(), loadDeckData(),
    Number.isInteger(id) && id > 0 ? getJson(`decks/results/pilots/${Math.floor(id / PILOT_BLOCK)}.json`).catch(() => ({})) : {},
    getJson("decks/results/ranking.json").catch(() => null)]);
  if (!block[id]) return tournamentsMessage("There's no such pilot in these tournament results.");
  const [name, rows, liked = []] = block[id];
  document.title = `${name || "Unknown pilot"} · MTG Vec2Search`;
  $("pilot-name").textContent = name || "Unknown pilot";

  // Their record, against every deck's over the same two years
  let games = 0, wins = 0, draws = 0, cutEvents = 0, cuts = 0;
  for (const [, , , cut, standing, won, lost, drew] of rows) {
    games += won + lost + drew;
    wins += won;
    draws += drew;
    cutEvents += cut > 0;
    cuts += cut > 0 && standing <= cut;
  }
  const [, fieldGames, fieldWins, fieldCutDecks, fieldCuts, fieldDraws = 0] = all?.field.at(-1) ?? [];
  const ppg = perGame(games, wins, draws), fieldPpg = perGame(fieldGames, fieldWins, fieldDraws);
  const vs = (x, field) => (!field ? "" : (Math.abs(x - field) < SAME ? "About the same as" : points(x - field) + " vs")
    + ` ${percent1(field)} for all decks`);
  const tone = (x, field) => (!field || Math.abs(x - field) < SAME ? "" : x > field ? "up" : "down");
  const rate = games ? wins / games : 0, fieldRate = fieldGames && fieldWins / fieldGames;
  const cutRate = cutEvents ? cuts / cutEvents : 0, fieldCut = fieldCutDecks && fieldCuts / fieldCutDecks;
  $("pilot-stats").replaceChildren(
    statTile("Tournament decks", rows.length.toLocaleString(), `in the last ${periodName(all?.windows.at(-1) ?? 730)}, ${games.toLocaleString()} games`),
    statTile("Points per game", games ? ppg.toFixed(2) : "–", fieldGames ? vsPoints(ppg, fieldPpg) : "", fieldGames ? pointsTone(ppg, fieldPpg) : ""),
    statTile("Win rate", games ? percent1(rate) : "–", vs(rate, fieldRate), tone(rate, fieldRate)),
    cutEvents ? statTile("Made the top cut", `${cuts} of ${cutEvents}`, vs(cutRate, fieldCut), tone(cutRate, fieldCut))
      : statTile("Made the top cut", "–", "No events with a top cut"));

  // Commanders: what they played, most decks first, each with how they did on it
  const leadName = (key, lead) => (key ? commanderNames(key, names) : lead) || "Unknown commander";
  const leadLink = (key, lead) => (files.has(key) ? el("a", { href: commanderLink(key), textContent: leadName(key, lead) }) : leadName(key, lead));
  const byCommander = new Map();
  for (const [, , , , , won, lost, drew, key, lead] of rows) {
    const c = byCommander.get(key || lead) ?? { key, lead, decks: 0, games: 0, wins: 0 };
    byCommander.set(key || lead, { ...c, decks: c.decks + 1, games: c.games + won + lost + drew, wins: c.wins + won });
  }
  const theirs = [...byCommander.values()].sort((a, b) => b.decks - a.decks || b.wins - a.wins);
  $("pilot-commanders").replaceChildren(el("span", { className: "label", textContent: "Plays" }), ...theirs.map(c =>
    el(files.has(c.key) ? "a" : "span", { className: "term", ...(files.has(c.key) ? { href: commanderLink(c.key) } : {}),
      title: `${c.decks} ${c.decks === 1 ? "deck" : "decks"}, ${c.wins} wins in ${c.games} games` },
    leadName(c.key, c.lead), el("small", { textContent: `${c.decks} ${c.decks === 1 ? "deck" : "decks"} · ${c.games ? percent(c.wins / c.games) : "–"} win rate` }))));

  // The header: their main commander's art, how long and how much they've played, their rank and best finish
  const main = theirs.find(c => c.key);
  if (main) {
    const leaders = main.key.split("-").map(Number);
    const infos = await Promise.all(leaders.map(cardInfo));
    const art = infos.map(({ name: card, id: image }, i) =>
      el("button", { type: "button", className: "card", onclick: () => openCard(image, leaders[i]) }, el("img", { src: imageUrl(image), alt: card })));
    $("pilot-art").replaceChildren(art.length > 1 ? overlap(art) : withFlip(art[0], art[0].querySelector("img"), infos[0]));
  }
  const since = new Date(rows.at(-1)[0]).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  let rank = "";
  if (ranked) {
    const last = ranked.windows.length - 1;
    const order = ranked.pilots.map(([pilot, , ...flat]) => [pilot, totalsRow(flat, last).points]).sort((a, b) => b[1] - a[1]);
    const i = order.findIndex(([pilot]) => pilot === id);
    if (i >= 0) rank = ` · #${(i + 1).toLocaleString()} of ${order.length.toLocaleString()} ranked pilots by match points`;
  }
  $("pilot-meta").textContent = `${rows.length.toLocaleString()} tournament ${rows.length === 1 ? "deck" : "decks"} since ${since}${rank}`;
  const best = [...rows].sort((a, b) => a[4] / a[2] - b[4] / b[2] || b[2] - a[2])[0]; // the highest place for the field's size
  $("pilot-best").hidden = !best;
  $("pilot-best").replaceChildren(el("span", { className: "label", textContent: "Best finish" }),
    `${ordinal(best[4])} of ${best[2]} at ${best[1]}, ${dateName(best[0])}, with `, leadLink(best[8], best[9]));

  // Favorite cards: what they play more than other pilots of the same commanders (pilot_cards in build_decks.py)
  const known = rows.filter(r => r[8]);
  const knownGames = known.reduce((k, r) => k + r[5] + r[6] + r[7], 0), knownWins = known.reduce((k, r) => k + r[5], 0);
  $("pilot-cards-lede").textContent = liked.length
    ? `Cards they play in more of their ${known.length} decks than other pilots of the same commanders do, the most more first. `
      + "For each: how many other tournament decks of those commanders play it, and how much higher or lower their win rate is with it than without it."
    : "Favorite cards need 2 or more of their decks to play a card more than other pilots' decks do.";
  await showPilotCards(liked.map(([card, decks, g, k, expected]) => ({
    card, type: typeOf(card), detail: `in ${decks} of ${known.length} decks`, bar: decks / known.length,
    note: `In ${percent(Math.min(1, expected / known.length))} of others' decks`
      + (g && knownGames > g ? ` · ${winChange(k / g, (knownWins - k) / (knownGames - g))}` : ""),
  })));

  showListsOverTime(id, rows, theirs, names, leadName);

  // Their tournaments, newest first
  let shown = 0;
  $("pilot-events").replaceChildren();
  $("more-pilot-events").onclick = () => {
    $("pilot-events").append(...rows.slice(shown, shown + PAGE_FINISHES).map(([date, event, size, , standing, won, lost, drew, key, lead, link, deck = -1]) =>
      finishItem(standing, event, link, [leadLink(key, lead)], [`of ${size} players`, dateName(date), `${won}–${lost}–${drew}`], key, deck, id)));
    shown += PAGE_FINISHES;
    $("more-pilot-events").hidden = shown >= rows.length;
  };
  $("more-pilot-events").onclick();
  tournamentsMessage("");
  $("pilot-page").hidden = false;
}

// A pilot's lists over time, for each commander they played 2 or more kept decks of: the cards in
// some of those lists but not all, with their games won with each and without; their earlier events
// against their later; and event by event, what changed from the list before (results/lists/<key>.json)
const PAGE_VERSIONS = 10;
const showChanged = typedGallery($("pilot-changed-types"), $("pilot-changed"), $("more-pilot-changed"));
function showListsOverTime(pilot, rows, theirs, names, leadName) {
  const kept = key => rows.filter(r => r[8] === key && r[11] >= 0).reverse(); // oldest first
  const listed = theirs.filter(c => c.key && kept(c.key).length >= 2);
  $("pilot-lists-panel").hidden = !listed.length;
  if (!listed.length) return;
  let chosen = listed[0].key;
  // [games, wins] of some of these decks
  const record = decks => decks.reduce(([g, k], { row }) => [g + row[5] + row[6] + row[7], k + row[5]], [0, 0]);
  const rateOf = ([g, k]) => (g ? percent(k / g) : "–");
  async function draw() {
    const key = chosen;
    chipRow($("pilot-lists-commanders"), listed.map(c => [c.key, withCount(leadName(c.key), kept(c.key).length)]),
      key, k => { chosen = k; draw(); });
    const lists = await getJson(`decks/results/lists/${key}.json`);
    if (key !== chosen) return; // another commander was picked meanwhile
    const decks = kept(key).map(row => {
      let p = 0;
      return { row, cards: new Set(lists.decks[row[11]].slice(4).map(gap => lists.cards[p += gap])) };
    });
    const n = decks.length;
    const half = Math.floor(n / 2);
    $("pilot-lists-lede").textContent = `Their ${n} ${leadName(key)} lists from tournaments, from ${dateName(decks[0].row[0])} to ${dateName(decks.at(-1).row[0])}. `
      + (n >= 4 ? `Their win rate was ${rateOf(record(decks.slice(0, half)))} in their first ${half} events and ${rateOf(record(decks.slice(half)))} in their last ${n - half}. ` : "")
      + "A few events are few games, so read the differences loosely.";

    // Cards in some lists but not all, the clearest difference in games won first: a difference
    // counts for more with more games on both sides (weighted as in pooled() in build_decks.py)
    const all = record(decks);
    const changed = [...new Set(decks.flatMap(d => [...d.cards]))].flatMap(card => {
      const having = decks.filter(d => d.cards.has(card));
      if (having.length === n) return [];
      const [g, k] = record(having);
      const [gw, kw] = [all[0] - g, all[1] - k];
      return g && gw ? [{ card, decks: having.length, g, k, gw, kw, rate: k / g, without: kw / gw }] : [];
    }).map(x => ({ ...x, clear: Math.abs(x.rate - x.without) * Math.sqrt(1 / (1 / x.g + 1 / x.gw)) }))
      .sort((a, b) => b.clear - a.clear || b.decks - a.decks);
    $("pilot-changed-lede").textContent = changed.length
      ? "In some of these lists but not all. ▲ and ▼: how much higher or lower their win rate was with it than without it, "
        + "the clearest differences first, counting more games for more."
      : "They played the same cards every time.";
    showChanged(changed.map(x => ({
      card: x.card, type: typeOf(x.card), bar: x.decks / n, detail: points(x.rate - x.without),
      tone: x.rate > x.without ? "up" : x.rate < x.without ? "down" : "",
      note: `In ${x.decks} of ${n} lists · win rate ${percent(x.rate)} with it, ${percent(x.without)} without`,
    })));

    // Event by event, newest first, each against the list before it
    const byName = (a, b) => names[a].localeCompare(names[b]);
    const items = decks.map((d, i) => {
      const before = decks[i - 1];
      const added = before ? [...d.cards].filter(c => !before.cards.has(c)).sort(byName) : [];
      const cut = before ? [...before.cards].filter(c => !d.cards.has(c)).sort(byName) : [];
      const [date, event, size, , standing, won, lost, drew, , , link, deck] = d.row;
      const games = won + lost + drew;
      const change = !before ? "their first list here" : added.length || cut.length ? `+${added.length} −${cut.length} since the last` : "no changes since the last";
      const details = el("details", {},
        el("summary", {},
          el("span", { className: "sim", textContent: games ? percent(won / games) : "–", title: "Win rate" }),
          el("span", { className: "deck-name", textContent: event }),
          el("span", { className: "finish-links" }, listLink(link) ?? "", compareLink(key, deck, pilot)),
          el("span", { className: "deck-meta", textContent: [dateName(date), `${ordinal(standing)} of ${size}`, `${won}–${lost}–${drew}`, change].join(" · ") })));
      details.addEventListener("toggle", () => details.append(el("div", { className: "deck-body" },
        ...(before ? [
          el("p", { className: "added", textContent: added.length ? `Added (${added.length}):` : "Nothing added." }),
          el("div", { className: "term-items" }, ...added.map(c => cardButton(c, names))),
          el("p", { className: "cut", textContent: cut.length ? `Cut (${cut.length}):` : "Nothing cut." }),
          el("div", { className: "term-items" }, ...cut.map(c => cardButton(c, names))),
        ] : [el("p", { textContent: `${d.cards.size} cards besides basic lands:` }), ...typeGroups([...d.cards], names)]))), { once: true });
      return el("li", {}, details);
    }).reverse();
    let shown = 0;
    $("pilot-versions").replaceChildren();
    $("more-pilot-versions").onclick = () => {
      $("pilot-versions").append(...items.slice(shown, shown + PAGE_VERSIONS));
      shown += PAGE_VERSIONS;
      $("more-pilot-versions").hidden = shown >= items.length;
    };
    $("more-pilot-versions").onclick();
  }
  draw().catch(err => {
    console.error(err);
    $("pilot-lists-lede").textContent = "Couldn't load their lists. Please try again.";
  });
}

// === Trends ===
const DEFAULT_DAYS = 30;
const NEW_DAYS = 120; // a card first printed this recently is new
const MAX_TRENDING = 300;
const percent = x => `${Math.round(x * 100)}%`;
// "15% play it (13 decks)": the share of decks that play a card, and how many that is
const played = (decks, share) => `${percent(share)} play it (${decks.toLocaleString()} ${decks === 1 ? "deck" : "decks"})`;
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
    const view = new URLSearchParams(location.search).get("view");
    history.replaceState(null, "", "?" + new URLSearchParams([...lead.map(k => [k, ""]), ...extra,
      ...[...data].filter(([, v]) => v), ...(view ? [["view", view]] : [])]));
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
    chipRow($("trend-windows"), windows.map((x, i) => [i, x.days ? `${x.days} days` : "All time",
      x.since === null, x.since === null ? "Not enough data yet" : ""]).reverse(), w, i => { w = i; update(); });

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
    showTrendRising(cards.rising.slice(0, MAX_TRENDING).map(x => pick(x, `${percent(x.was)} → ${played(x.decks, x.share)}`)));
    $("trend-played-lede").textContent = days ? `The share of the decks made in the last ${days} days that play each card.`
      : "The share of all these decks that play each card.";
    showTrendPlayed(cards.popular.slice(0, MAX_TRENDING).map(x => pick(x, played(x.decks, x.share))));
    showTrendNew(cards.popular.filter(x => isNew(released, x.card)).slice(0, MAX_TRENDING)
      .map(x => pick(x, played(x.decks, x.share))));
  }
  $("trend-form").addEventListener("input", async () => {
    await update();
    sections();
  });
  await update();
  trendsMessage("");
  $("trends-page").hidden = false;
  const sections = pageSections($("trends-page"), $("trend-views"), [["commanders", "Commanders"], ["cards", "Cards"]], $("trends-how"), {
    commanders: "Rising: commanders whose share of the decks made in the period beats their share of all decks the most, "
      + "relative to it, so going from 1% to 4% beats 60% to 66%. Most popular: the most decks made in the period. The "
      + "filters keep the commanders that pass them (color identity: exactly those colors).",
    cards: "Rising cards: what the period's new decks play more often than these commanders' decks do overall. Most played: "
      + "the share of the period's decks that play each card. New cards: first printed in the last few months. With "
      + "filters, the cards are those of the commanders that pass them.",
  });
}

// Cheaper cards that do the same thing (prices/alts/<block>.json, from build_prices.py's
// alternatives()), under a card's prices in its details
const ALT_BLOCK = 256; // ALT_BLOCK in build_prices.py
const altBlocks = new Map();
async function showAlternatives(card) {
  $("card-alts").hidden = true;
  if (card === null || !index) return;
  const k = Math.floor(card / ALT_BLOCK);
  if (!altBlocks.has(k)) altBlocks.set(k, getJson(`prices/alts/${k}.json`).catch(() => ({}))); // none for that block: {}
  const alts = (await altBlocks.get(k))[card % ALT_BLOCK];
  if (!alts || openedCard !== card) return;
  const infos = await Promise.all(alts.map(cardInfo));
  if (openedCard !== card) return;
  $("alts").replaceChildren(...alts.map((alt, i) => el("li", {},
    el("button", { type: "button", className: "term", textContent: infos[i].name, onclick: () => openCard(infos[i].id, alt) }), " ",
    el("small", { textContent: index.columns.price[alt] >= 0 ? `from ${money.formatUsd(index.columns.price[alt] / 100)}` : "" }))));
  $("card-alts").hidden = false;
}

// === Watchlist: printings to keep an eye on, kept in this browser, and shared as a link ===
// An entry: { card (its number), id (the printing's Scryfall id), finish ("usd" or "usd_foil"), set }
const WATCH_KEY = "watchlist";
function readWatch() {
  try { return JSON.parse(localStorage.getItem(WATCH_KEY)) ?? []; } catch { return []; }
}
function writeWatch(list) {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(list)); } catch {}
}
const watching = (list, id, finish) => list.findIndex(w => w.id === id && w.finish === finish);
// In a link: card.id.finish (0 nonfoil, 1 foil), comma-separated
const WATCH_FINISHES = ["usd", "usd_foil"];
const watchParam = list => list.map(w => `${w.card ?? ""}.${w.id}.${WATCH_FINISHES.indexOf(w.finish)}`).join(",");
const fromWatchParam = text => text.split(",").map(x => x.split(".")).filter(x => x.length === 3)
  .map(([card, id, f]) => ({ card: card === "" ? null : Number(card), id, finish: WATCH_FINISHES[Number(f)] ?? "usd" }));
let onWatchChange = () => {}; // the Prices page redraws its list
function showWatchButton() {
  const finish = foil.checked ? "usd_foil" : "usd";
  const on = watching(readWatch(), current.id, finish) >= 0;
  const button = $("watch-button");
  button.textContent = on ? "★ Watching" : "☆ Watch its price";
  button.ariaPressed = String(on);
  button.title = on ? "On your watchlist (the Prices tab): click to take it off" : "Add this printing to your watchlist, on the Prices tab";
  button.hidden = openedCard === null; // its tile on the Prices page needs the card's number
  button.onclick = () => {
    const list = readWatch();
    const k = watching(list, current.id, finish);
    if (k >= 0) list.splice(k, 1);
    else list.push({ card: openedCard, id: current.id, finish, set: current.set_name });
    writeWatch(list);
    showWatchButton();
    onWatchChange();
  };
}

// === Prices (build_prices.py makes the data in prices/) ===
// A deck's worth: its cards at their cheapest printings now, against 30 days and a year ago, and
// the cards that moved most in 30 days (prices/cards.json)
let cardPrices;
const showDeckMovers = typedGallery($("deck-movers-types"), $("deck-movers"), $("more-deck-movers"));
// A set's printings' prices (prices/sets/set-<code>.json: {number: {id, card, finish: [now, then PRICE_WINDOWS days
// before]}}), each fetched once
const setPrices = new Map();
const getSetPrices = code => setPrices.get(code)
  ?? setPrices.set(code, getJson(`prices/sets/set-${code}.json`).catch(() => ({}))).get(code);
const windowName = w => (w === 365 ? "a year" : `${w} days`);

// The deck's worth: each card at the printing its line names ("(CMM) 400 *F*"), else at its cheapest,
// and how it changed over the period picked (w= in the URL, as on the Prices tab)
async function showDeckValue(deck, printings = new Map()) {
  cardPrices ??= getJson("prices/cards.json").catch(err => { cardPrices = null; throw err; });
  const p = await cardPrices;
  const codes = [...new Set(deck.map(c => printings.get(c)?.set).filter(Boolean))];
  const sets = Object.fromEntries(await Promise.all(codes.map(async code => [code, await getSetPrices(code)])));
  // Each card's [now, then each of PRICE_WINDOWS before] (-1: none)
  const at = new Map(deck.map(c => {
    // Only if that printing is this card ("(SNC) 197" for Tivit is Lord Xander: a mistyped number)
    const named = printings.get(c), printing = named && sets[named.set][named.number];
    const own = printing?.card === c && printing[named.finish];
    return [c, own ? { prices: own, named, id: printing.id }
      : { prices: [p.now[c], ...PRICE_WINDOWS.map(w => p[w]?.[c] ?? -1)] }];
  }));
  const now = c => at.get(c).prices[0];
  const then = (c, w) => at.get(c).prices[1 + PRICE_WINDOWS.indexOf(w)] ?? -1;
  const priced = deck.filter(c => now(c) >= 0);
  if (!priced.length) {
    $("deck-value-panel").hidden = true;
    return;
  }
  const worth = cards => cards.reduce((sum, c) => sum + now(c), 0);
  const named = priced.filter(c => at.get(c).named).length;
  const fromUrl = Number(params.get("w"));
  let w = PRICE_WINDOWS.includes(fromUrl) ? fromUrl : 30;
  let order = ["rising", "falling"].includes(params.get("order")) ? params.get("order") : "all";

  function show() {
    setParams({ w: w === 30 ? null : w, order: order === "all" ? null : order });
    chipRow($("deck-value-windows"), PRICE_WINDOWS.map(x => [x, x === 365 ? "1 year" : `${x} days`,
      !priced.some(c => then(c, x) >= 0)]), w, x => { w = x; show(); });
    // The change over the cards priced both then and now
    const both = priced.filter(c => then(c, w) >= 0);
    const total = worth(both), was = both.reduce((sum, c) => sum + then(c, w), 0), diff = total - was;
    $("deck-value-lede").replaceChildren(
      (named === priced.length ? "At the printings in your list"
        : named ? `At the printings in your list (the cheapest printing for the ${priced.length - named} without a priced one named)`
        : "At each card's cheapest printing")
        + `, the ${priced.length} cards with a price are worth ${wholeDollars(worth(priced))}`
        + (priced.length < deck.length ? ` (${deck.length - priced.length} have none)` : ""),
      ...(both.length ? [`: ${diff >= 0 ? "up" : "down"} ${wholeDollars(Math.abs(diff))} (`,
        el("span", { className: diff > 0 ? "up" : diff < 0 ? "down" : "", textContent: priceChange(total, was) }),
        `) in ${windowName(w)}` + (both.length < priced.length ? ` (the ${both.length} cards with a price then)` : "")] : []),
      ".");
    // Every card by price, most first; or rising or falling, the biggest change first
    const ratio = c => now(c) / then(c, w);
    const lists = {
      all: [...priced].sort((a, b) => now(b) - now(a)),
      rising: priced.filter(c => then(c, w) > 0 && ratio(c) > 1).sort((a, b) => ratio(b) - ratio(a)),
      falling: priced.filter(c => then(c, w) > 0 && ratio(c) < 1).sort((a, b) => ratio(a) - ratio(b)),
    };
    if (!lists[order].length) order = "all";
    chipRow($("deck-value-order"), [["all", withCount("All cards", lists.all.length)],
      ["rising", withCount("Rising", lists.rising.length), !lists.rising.length],
      ["falling", withCount("Falling", lists.falling.length), !lists.falling.length]], order, o => { order = o; show(); });
    return showDeckMovers(lists[order].map(c => {
      const { named: printing, id } = at.get(c);
      const tile = { card: c, id, type: typeOf(c), price: now(c), foil: printing?.finish > 0 };
      return order === "all" ? tile : { ...tile, ...priceTag(now(c), then(c, w), `${windowName(w)} ago`,
        printing ? [index.sets.find(([code]) => code === printing.set)?.[1], FINISHES[printing.finish]] : []) };
    }));
  }
  $("deck-value-panel").hidden = false;
  await show();
}

const PRICE_WINDOWS = [7, 30, 90, 365]; // WINDOWS in build_prices.py
const PRICE_BANDS = [1, 5, 20, 100]; // US dollars, shown as round amounts of the visitor's currency
const FINISHES = ["", "foil", "etched"];
const GAP_DAYS = 21; // longer stretches without prices are drawn dashed
const HISTORY_RANGES = [[90, "3 months"], [365, "1 year"], [1095, "3 years"], [null, "All"]];
const pricesMessage = text => {
  $("prices-message").textContent = text;
  $("prices-message").hidden = !text;
};
const dollars = cents => money.formatUsd(cents / 100);
const wholeDollars = cents => (cents >= 10000 ? money.formatUsdWhole(cents / 100) : dollars(cents));
const dayName = day => new Date(Date.UTC(1993, 0, 1) + day * 864e5)
  .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
// "+38%", "−4.5%": a change in price, to a tenth of a percent when it's under 10%
function priceChange(now, was) {
  const x = (now / was - 1) * 100;
  const digits = Math.abs(x) < 9.95 ? 1 : 0;
  return (x > 0 ? "+" : x < 0 ? "−" : "")
    + Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) + "%";
}
let priceDays; // prices/days.json: the days with prices
const getPriceDays = () => (priceDays ??= getJson("prices/days.json"));
// Estimated prices, [days since the point before, change in cents (null: none until the next point),
// ...] (build_prices.py's daily()), flat between points, as [[day, cents, true, starts after none]]
function estimated(points = []) {
  const out = [];
  let d = 0, c = 0, on = false;
  for (let k = 0; k < points.length; k += 2) {
    d += points[k];
    if (on && points[k] > 1) out.push([d - 1, c, true]);
    const starts = !on;
    on = points[k + 1] !== null;
    if (on) out.push([d, (c += points[k + 1]), true, starts]);
  }
  return out;
}
// A stretch with no prices between two points: estimates run unbroken until one starts again after
// none; between ours (or ours and an estimate), more than GAP_DAYS apart
const priceGap = (a, b) => (a[2] && b[2] ? !!b[3] : b[0] - a[0] > GAP_DAYS);
// A series' price on each day with prices: series = [[day, cents or null]], where it changed
function onDays(series, days) {
  const out = [];
  let k = 0, c = null;
  for (const d of days) {
    while (k < series.length && series[k][0] <= d) c = series[k++][1];
    if (c !== null) out.push([d, c]);
  }
  return out;
}

// A price tag, the same on every tab: the price now, its change since `was` (green up, red down),
// and under it the printing (set, foil) and what it cost then, saying when ("$80.96 30 days ago")
function priceTag(now, was, when, printing = []) {
  const has = was > 0;
  return {
    price: now, detail: has ? priceChange(now, was) : "", tone: has && now > was ? "up" : has && now < was ? "down" : "",
    note: [...printing, has && `${dollars(was)} ${when}`].filter(Boolean).join(" · "),
  };
}

// A printing's row ([card, id, set, finish, now, ...]) as a tile, against its price w days before
function pricePick(r, sets, was, w) {
  const [card, id, set, finish, now] = r;
  return { card, id, type: typeOf(card), foil: finish > 0, ...priceTag(now, was, `${windowName(w)} ago`, [sets[set], FINISHES[finish]]) };
}
// A round amount of the visitor's currency near `usd` dollars: 1, 2 or 5 times a power of ten
function roundLocal(usd) {
  const x = usd * (money.rate ?? 1);
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 5, 10].map(m => m * p).reduce((a, b) => (Math.abs(Math.log(b / x)) < Math.abs(Math.log(a / x)) ? b : a));
}
// How big a change (|ln(now / then)|) a list of rises or falls is complete down to, for printings at
// `cents` or more: each band of prices keeps only its biggest changes (movers-<w>.json's cutoffs)
function completeTo(data, cents, finish, rose) {
  const first = Math.max(0, data.bands.findLastIndex(b => b <= cents));
  let cut = 0;
  for (const g of finish ? [finish === "foil" ? 1 : 0] : [0, 1]) {
    for (let b = first; b < data.bands.length; b++) cut = Math.max(cut, data.cutoffs[g][b][rose ? 1 : 0]);
  }
  return cut;
}

// A line chart of prices: points = [[day, cents]], one per day with a price. Lines across more than
// GAP_DAYS without prices are dashed. A crosshair and the day's price follow the pointer
const SVG = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}
function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return ticks;
}
function priceChart(box, points, label) {
  box.replaceChildren();
  if (points.length < 2) return;
  // Drawn at the size it's shown at, so its text is the page's size (the box must be showing)
  const W = Math.max(280, box.clientWidth || 640);
  const [H, L, R, T, B] = [Math.min(240, Math.round(W * 0.42)), 74, 14, 30, 26];
  const x0 = points[0][0], x1 = points.at(-1)[0];
  let lo = Math.min(...points.map(p => p[1])), hi = Math.max(...points.map(p => p[1]));
  const pad = Math.max((hi - lo) * 0.1, hi * 0.02, 1);
  lo = Math.max(0, lo - pad);
  hi += pad;
  const x = d => L + ((d - x0) / Math.max(1, x1 - x0)) * (W - L - R);
  const y = c => T + (1 - (c - lo) / (hi - lo)) * (H - T - B);
  const root = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `${label}: ${dollars(points[0][1])} on ${dayName(x0)}, ${dollars(points.at(-1)[1])} on ${dayName(x1)}` });
  for (const c of niceTicks(lo, hi, 3)) {
    root.append(svgEl("line", { class: "grid", x1: L, x2: W - R, y1: y(c), y2: y(c) }),
      svgEl("text", { class: "tick", x: L - 8, y: y(c) + 4, "text-anchor": "end" }, wholeDollars(c)));
  }
  root.append(svgEl("text", { class: "tick", x: L, y: H - 6 }, dayName(x0)),
    svgEl("text", { class: "tick", x: W - R, y: H - 6, "text-anchor": "end" }, dayName(x1)));
  // Over more than a year and a half, each new year too, where it fits between the ends
  if (x1 - x0 > 540) {
    let shown = -Infinity; // where the last year's label went: one at most every 48px
    for (let year = new Date(Date.UTC(1993, 0, 1) + x0 * 864e5).getUTCFullYear() + 1; ; year++) {
      const d = (Date.UTC(year, 0, 1) - Date.UTC(1993, 0, 1)) / 864e5;
      if (x(d) > W - R - 110) break;
      if (x(d) - L < 110 || x(d) - shown < 48) continue;
      shown = x(d);
      root.append(svgEl("line", { class: "grid", x1: x(d), x2: x(d), y1: H - B, y2: H - B + 5 }),
        svgEl("text", { class: "tick", x: x(d), y: H - 6, "text-anchor": "middle" }, String(year)));
    }
  }
  // Each step is a line of ours, a lighter one to or from an estimate, or dashed across a gap
  const paths = { line: "", est: "", gap: "" };
  const dots = [];
  const xy = ([d, c]) => `${x(d).toFixed(1)},${y(c).toFixed(1)}`;
  points.forEach((p, k) => {
    const prev = points[k - 1], next = points[k + 1];
    if (prev) paths[priceGap(prev, p) ? "gap" : prev[2] || p[2] ? "est" : "line"] += `M${xy(prev)}L${xy(p)}`;
    // A day of ours with no other close by would be no line at all: a dot instead
    if (!p[2] && (!prev || priceGap(prev, p) || prev[2]) && (!next || priceGap(p, next) || next[2])) {
      dots.push(svgEl("circle", { class: "dot", cx: x(p[0]), cy: y(p[1]), r: 3 }));
    }
  });
  root.append(...Object.entries(paths).map(([cls, d]) => svgEl("path", { class: cls, d })), ...dots);
  const cross = svgEl("line", { class: "cross", y1: T - 6, y2: H - B, visibility: "hidden" });
  const dot = svgEl("circle", { class: "dot", r: 4.5, visibility: "hidden" });
  const tip = el("span", { className: "tip", hidden: true });
  root.append(cross, dot);
  root.addEventListener("pointermove", e => {
    const rect = root.getBoundingClientRect();
    const day = x0 + ((((e.clientX - rect.left) / rect.width) * W - L) / (W - L - R)) * (x1 - x0);
    let k = points.findIndex(p => p[0] >= day);
    if (k < 0) k = points.length - 1;
    else if (k > 0 && day - points[k - 1][0] < points[k][0] - day) k--;
    const [d, c, est] = points[k];
    for (const [node, attrs] of [[cross, { x1: x(d), x2: x(d) }], [dot, { cx: x(d), cy: y(c) }]]) {
      for (const [a, v] of Object.entries({ ...attrs, visibility: "visible" })) node.setAttribute(a, v);
    }
    tip.textContent = `${dayName(d)} · ${est ? "about " : ""}${c >= 100000 ? wholeDollars(c) : dollars(c)}`;
    tip.style.left = `${Math.min(88, Math.max(12, (x(d) / W) * 100))}%`;
    tip.hidden = false;
  });
  root.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
  box.append(root, tip);
}

// A printing's price history, under its price in its details
let historyRange = 365;
async function showHistory(id, finish) {
  $("price-history").hidden = true;
  try {
    const [days, shard] = await Promise.all([getPriceDays(), getJson(`prices/p/${id.slice(0, 3)}.json`)]);
    const prices = shard[id] ?? {};
    const key = [finish, "usd_etched", "usd_foil", "usd"].find(k => prices[k]);
    if (current?.id !== id || !key) return;
    const all = [...onDays(prices[key], days), ...estimated(prices[key + "_d"])].sort((a, b) => a[0] - b[0]);
    if (all.length < 2) return;
    const draw = () => {
      const points = historyRange ? all.filter(p => p[0] >= days.at(-1) - historyRange) : all;
      // Only the periods that show something the next one up doesn't
      chipRow($("history-ranges"), HISTORY_RANGES.filter(([r]) => !r || all[0][0] < days.at(-1) - r / 2), historyRange,
        r => { historyRange = r; draw(); });
      priceChart($("history-chart"), points, `${current.name} price`);
      const ours = points.filter(p => !p[2]);
      $("history-note").textContent = points.length < 2 ? "Not enough prices in this period."
        : (ours.length ? `${ours.length} days of TCGplayer prices since ${dayName(ours[0][0])}.` : "No TCGplayer prices in this period.")
          + (ours.length < points.length ? " The lighter line is estimated between them, from another price guide's daily prices"
            + " scaled to meet TCGplayer's." : "")
          + (points.some((p, k) => k && priceGap(points[k - 1], p))
            ? " Dashed lines cross stretches with no prices." : "");
    };
    if (historyRange && all[0][0] >= days.at(-1) - historyRange / 2) historyRange = null;
    // How much it changed: over a month, a year and as far back as it goes (2 years or more)
    const latest = all.at(-1);
    const before = w => all.findLast(p => p[0] <= latest[0] - w && latest[0] - w - p[0] <= Math.max(7, w / 10));
    const spans = [[30, "in 30 days"], [365, "in a year"]].map(([w, label]) => [before(w), label])
      .concat(latest[0] - all[0][0] > 730 ? [[all[0], `since ${year(all[0][0])}`]] : [])
      .filter(([p]) => p && p[1] > 0);
    $("history-change").replaceChildren(...spans.flatMap(([p, label], k) => [k ? " · " : "",
      el("span", { className: latest[1] > p[1] ? "up" : latest[1] < p[1] ? "down" : "", textContent: priceChange(latest[1], p[1]) }),
      ` ${label}`]));
    $("history-change").hidden = !spans.length;
    $("price-history").hidden = false;
    draw();
  } catch (err) {
    console.error(err); // no price history built: the details go without it
  }
}

const showPriceRising = typedGallery($("price-rising-types"), $("price-rising"), $("more-price-rising"));
const showPriceFalling = typedGallery($("price-falling-types"), $("price-falling"), $("more-price-falling"));
const showReserved = typedGallery($("reserved-types"), $("reserved"), $("more-reserved"));
const PRICE_VIEWS = [["movers", "Rising & falling"], ["spec", "Spec buys"], ["buyouts", "Buyouts"],
  ["spikes", "Tournament spikes"], ["reprints", "Reprints"], ["reserve", "Reserve list"], ["watch", "Watchlist"]];
const priceHow = view => ({
  movers: "Each printing's price now against the start of the period picked, among the printings at the amount picked or more on both days.",
  spec: `Cards in ${percent1(SPEC_SHARE)} or more of the Commander decks made in the last 30 days, and ${SPEC_PLAYED} times `
    + `their share of all decks or more, while their cheapest printing's price moved less than ${percent(SPEC_FLAT)} in those 30 days.`,
  buyouts: `Cards whose cheapest printing rose ${percent(BUYOUT_RISE)} or more in 30 days, while the Commander decks made in `
    + `those days play them no more than usual (under ${BUYOUT_PLAYED} times their share of all decks): a buyout, `
    + "speculation, or demand from another format.",
  spikes: `Cards in ${SPIKE_DECKS} or more of the last 90 days' cEDH tournament decks, and ${SPIKE_PLAYED} times their share `
    + "of the year's or more, with their cheapest printing's price change in those 90 days. Winning players pick up new "
    + "cards first, so prices can follow.",
  reprints: `Cards with a new paper printing out in the last ${REPRINT_DAYS} days: the older printing that was cheapest `
    + `${REPRINT_BEFORE} days before it came out (about when reprints are announced), and how it has moved since.`,
  reserve: "Cards Wizards of the Coast has promised never to reprint. The total is one of each at its cheapest nonfoil "
    + "printing; tournament-legal only leaves out Collectors' Edition, 30th Anniversary, gold-bordered and oversized "
    + "printings. Between the days we have TCGplayer's prices, the lighter line is estimated from another price guide's "
    + "daily prices, scaled to meet them.",
  watch: "Your watchlist is kept in this browser. Copy a link to share it: whoever opens it can add it to theirs.",
})[view];
const showWatched = typedGallery($("watch-types"), $("watch"), $("more-watch"));
const showSpikes = typedGallery($("spikes-types"), $("spikes"), $("more-spikes"));
const SPIKE_DECKS = 30; // at least this many tournament decks in the last 90 days play a spike
const SPIKE_PLAYED = 1.5; // and that many times its share of the year's
const showReprints = typedGallery($("reprints-types"), $("reprints"), $("more-reprints"));
const REPRINT_DAYS = 120, REPRINT_BEFORE = 45; // the same in build_prices.py
const showSpecBuys = typedGallery($("spec-buys-types"), $("spec-buys"), $("more-spec-buys"));
const showBuyouts = typedGallery($("buyouts-types"), $("buyouts"), $("more-buyouts"));
// Spec buys and buyouts: Commander play (the share of the decks made in the last 30 days against
// the share of all decks) against each card's cheapest price, now and 30 days ago (prices/cards.json)
const SPEC_SHARE = 0.003; // at least this share of new decks play a spec buy (fewer is mostly noise)
const SPEC_PLAYED = 1.5; // and that many times its usual share of decks
const SPEC_FLAT = 0.1; // while its price moved less than this
const BUYOUT_RISE = 0.3; // a buyout's price rose this much
const BUYOUT_PLAYED = 1.15; // while its share of new decks is no more than this many times its usual
async function showPrices() {
  const [meta, columns, rate, days, reserved] = await Promise.all([getMeta(), getJson("index/columns.json"),
    usdRate(currency), getPriceDays(), getJson("prices/reserved.json")]);
  money = moneyFormatter(currency, rate);
  index ??= buildIndex(meta, columns);
  const movers = {};
  const fromUrl = Number(params.get("w"));
  let w = PRICE_WINDOWS.includes(fromUrl) ? fromUrl : 30;
  let finish = ["nonfoil", "foil"].includes(params.get("finish")) ? params.get("finish") : "";
  // "And up" amounts, round in the visitor's currency; filtered on in US cents
  const amounts = PRICE_BANDS.map(roundLocal);
  const toCents = amount => Math.round((amount / (money.rate ?? 1)) * 100);
  let band = Math.max(0, amounts.indexOf(Number(params.get("price"))));
  const bandName = i => money.formatUsdWhole(amounts[i] / (money.rate ?? 1));
  let order = "rising";
  // The reserve list: every printing, or just the ones to play with (not Collectors' Edition's,
  // 30th Anniversary's, gold-bordered or oversized)
  let playable = params.get("rl") === "legal";
  // Which section shows: a shared watchlist opens on it
  let view = params.has("watch") ? "watch" : PRICE_VIEWS.some(([v]) => v === params.get("view")) ? params.get("view") : "movers";
  for (const id of ["spec-buys-lede", "buyouts-lede", "spikes-lede", "reprints-lede"]) $(id).textContent = "Loading…";
  for (const id of ["spec-panel", "buyouts-panel", "spikes-panel", "reprints-panel"]) $(id).hidden = false;

  // Filters: like the card search's, on each printing's card (and the printing's own set)
  const form = $("price-form");
  for (const f of meta.formats) $("price-format").append(el("option", { value: f, textContent: f[0].toUpperCase() + f.slice(1) }));
  for (const box of form.querySelectorAll('[name="c"]')) box.checked = params.getAll("c").includes(box.value);
  for (const k of ["min", "max", "f"]) form.elements[k].value = params.get(k) ?? "";
  const fromSet = meta.sets.find(([code]) => code === params.get("s"));
  if (fromSet) $("price-set").value = setLabel(...fromSet);
  $("price-filters").open = ["c", "min", "max", "f", "s"].some(k => params.has(k));
  let cardOk, setName, filterParams;
  const readFilters = () => {
    const data = new FormData(form);
    const num = k => (data.get(k) === "" || data.get(k) === null ? null : Number(data.get(k)));
    const f = { colors: data.getAll("c"), format: data.get("f") ?? "", min: num("min"), max: num("max") };
    const code = setCode($("price-set").value);
    setName = code ? meta.sets.find(([c]) => c === code)[1] : null;
    cardOk = filterFn(index, f);
    filterParams = [...f.colors.map(c => ["c", c]), ...["min", "max"].filter(k => f[k] !== null).map(k => [k, f[k]]),
      ...(f.format ? [["f", f.format]] : []), ...(code ? [["s", code]] : [])];
    const active = f.colors.length + (f.min !== null || f.max !== null) + !!f.format + !!code;
    $("price-filter-count").textContent = active;
    $("price-filter-count").hidden = !active;
  };
  const rowOk = (r, sets) => (!finish || (finish === "foil") === (r[3] > 0)) && cardOk(r[0]) && (!setName || sets[r[2]] === setName);

  // The reserve list: one of every card over time, and each printing
  const totalOf = () => (playable ? reserved.playable : reserved.total);
  const drawTotal = () => priceChart($("reserved-chart"), totalOf().map(([d, c, , est]) => [d, c, !!est]),
    "One of every reserve list card");
  const showList = () => {
    const k = PRICE_WINDOWS.indexOf(w);
    const was = r => r[5 + k];
    const rows = reserved.rows.filter(r => rowOk(r, reserved.sets) && (!playable || r.at(-1)));
    const sorted = order === "priciest" ? rows.sort((a, b) => b[4] - a[4])
      : rows.filter(r => Math.min(was(r), r[4]) >= toCents(amounts[0]))
        .sort((a, b) => (order === "rising" ? -1 : 1) * (a[4] / was(a) - b[4] / was(b)));
    chipRow($("reserved-sorts"), [["rising", "Rising"], ["falling", "Falling"], ["priciest", "Most expensive"]], order,
      o => { order = o; showList(); });
    showReserved(sorted.map(r => pricePick(r, reserved.sets, was(r), w)));
  };

  // The watchlist: yours, or one from a link (watch=...)
  const shared = params.has("watch") ? fromWatchParam(params.get("watch")) : null;
  const showWatchlist = async () => {
    const list = (shared ?? readWatch()).filter(w => Number.isInteger(w.card));
    $("watch-panel").hidden = !list.length;
    $("watch-empty").hidden = !!list.length;
    showViews();
    if (!list.length) return;
    const shards = {};
    const series = await Promise.all(list.map(async w => {
      const shard = await (shards[w.id.slice(0, 3)] ??= getJson(`prices/p/${w.id.slice(0, 3)}.json`).catch(() => ({})));
      const prices = shard[w.id] ?? {};
      return [...onDays(prices[w.finish] ?? [], days), ...estimated(prices[w.finish + "_d"])].sort((a, b) => a[0] - b[0]);
    }));
    const at = (points, back) => points.findLast(p => p[0] <= points.at(-1)[0] - back);
    $("watch-heading").textContent = shared ? "A shared watchlist" : "Your watchlist";
    $("watch-lede").textContent = shared ? "Printings someone shared with you." : "Printings you're watching, in this browser.";
    $("watch-keep").hidden = !shared;
    $("watch-keep").onclick = () => {
      const mine = readWatch();
      for (const w of shared) if (watching(mine, w.id, w.finish) < 0) mine.push(w);
      writeWatch(mine);
      $("watch-keep").textContent = "Added to your watchlist";
      $("watch-keep").disabled = true;
    };
    $("watch-share").onclick = async () => {
      const link = `${location.origin}${location.pathname}?prices&watch=${watchParam(list)}`;
      try {
        await navigator.clipboard.writeText(link);
        $("watch-share").textContent = "Link copied";
      } catch {
        prompt("A link to this list:", link);
      }
    };
    await showWatched(list.map((w, k) => {
      const points = series[k];
      const printing = [w.set, w.finish !== "usd" && "foil"];
      if (!points.length) return { card: w.card, id: w.id, type: typeOf(w.card), price: -1, note: printing.filter(Boolean).join(" · ") };
      const now = points.at(-1)[1], month = at(points, 30);
      return { card: w.card, id: w.id, type: typeOf(w.card), foil: w.finish !== "usd", ...priceTag(now, month?.[1], "30 days ago", printing) };
    }));
  };
  onWatchChange = () => showWatchlist().catch(err => console.error(err));

  // Spec buys and buyouts, once Trends' data is in (fetched after the rest of the page)
  let spec = null;
  const showSpec = () => {
    if (!spec) return;
    const { trends, p, k } = spec;
    const { popular, recent } = trendingCards([trends.everything], k);
    const floor = toCents(amounts[band]);
    const ok = c => cardOk(c) && Math.min(p.now[c], p["30"][c]) >= floor;
    const ratio = c => p.now[c] / p["30"][c];
    const played = new Map(popular.map(x => [x.card, x]));
    const deckShare = x => `${percent1(x.share)} of new decks, usually ${percent1(x.was)}`;
    const buys = popular.filter(x => x.share >= SPEC_SHARE && x.share >= SPEC_PLAYED * x.was && ok(x.card)
      && Math.abs(ratio(x.card) - 1) < SPEC_FLAT).sort((a, b) => b.share / b.was - a.share / a.was);
    const outs = [];
    p.now.forEach((now, c) => {
      const x = played.get(c);
      if (ok(c) && ratio(c) >= 1 + BUYOUT_RISE && (!x || x.share < BUYOUT_PLAYED * x.was)) outs.push(c);
    });
    outs.sort((a, b) => ratio(b) - ratio(a));
    $("spec-buys-lede").textContent = `Far more Commander decks play them these 30 days (${recent.toLocaleString()} new decks), `
      + "and the price hasn't caught up yet.";
    $("buyouts-lede").textContent = `Up ${percent(BUYOUT_RISE)} or more in 30 days, while Commander decks play them no more than usual.`;
    showSpecBuys(buys.map(x => ({ card: x.card, type: typeOf(x.card), price: p.now[x.card],
      detail: `${(x.share / x.was).toFixed(1)}× played`, tone: "up",
      note: `${deckShare(x)} · price ${priceChange(p.now[x.card], p["30"][x.card])} in 30 days` })));
    showBuyouts(outs.map(c => {
      const tag = priceTag(p.now[c], p["30"][c], "30 days ago");
      return { card: c, type: typeOf(c), ...tag,
        note: `${tag.note} · ` + (played.has(c) ? deckShare(played.get(c)) : "in no new Commander decks") };
    }));
  };

  // Tournament spikes: cards in far more of the last 90 days' cEDH tournament decks than of the
  // year's (decks/results/index.json), and how their cheapest price moved in those 90 days
  let spikes = null;
  const showSpikeList = () => {
    if (!spikes) return;
    const { results, p } = spikes;
    const [q, y] = [90, 365].map(d => results.windows.indexOf(d));
    const floor = toCents(amounts[band]);
    const list = results.cards.map((card, k) => {
      const st = results.stats[k];
      const decks = st[q * 4], yearDecks = st[y * 4];
      const share = decks / results.field[q][0], was = yearDecks / results.field[y][0];
      return { card, decks, share, was };
    }).filter(x => x.decks >= SPIKE_DECKS && x.share >= SPIKE_PLAYED * x.was && cardOk(x.card) && p.now[x.card] >= floor)
      .sort((a, b) => b.share / b.was - a.share / a.was);
    $("spikes-lede").textContent = `Far more cEDH tournament decks play them these 90 days (${results.field[q][0].toLocaleString()} decks).`;
    showSpikes(list.map(x => {
      const now = p.now[x.card], then = p["90"][x.card];
      return {
        card: x.card, type: typeOf(x.card), price: now, detail: `${(x.share / x.was).toFixed(1)}× played`, tone: "up",
        note: `${percent1(x.share)} of tournament decks, usually ${percent1(x.was)}` + (then > 0 ? ` · price ${priceChange(now, then)} in 90 days` : ""),
      };
    }));

  };

  // Reprints: how the older printing moved since a reprint was coming (prices/reprints.json)
  let reprints = null;
  const showReprintList = () => {
    if (!reprints) return;
    const floor = toCents(amounts[band]);
    const rows = reprints.rows.filter(r => cardOk(r[0]) && (!setName || reprints.sets[r[3]] === setName || reprints.sets[r[2]] === setName)
      && Math.min(r[5], r[6]) >= floor);
    rows.sort((a, b) => a[6] / a[5] - b[6] / b[5]);
    $("reprints-lede").textContent = `Older printings since a reprint came out (in the last ${REPRINT_DAYS} days), the biggest falls first.`;
    showReprints(rows.map(([card, id, oldSet, newSet, out, was, now, fresh]) => {
      const tag = priceTag(now, was, "before the reprint", [reprints.sets[oldSet]]);
      return { card, id, type: typeOf(card), ...tag, note: tag.note + (fresh >= 0 ? ` · the reprint ${dollars(fresh)}` : "") };
    }));

  };

  const showViews = () => {
    $("price-how").textContent = priceHow(view);
    const watched = (shared ?? readWatch()).length;
    showSections($("prices-page"), $("price-views"),
      PRICE_VIEWS.map(([v, label]) => [v, v === "watch" && watched ? `${label} (${watched})` : label]), view, v => {
        view = v;
        update();
        if (view === "reserve") drawTotal(); // drawn at the size it's shown at
      });
  };

  let shownFor;
  async function update() {
    readFilters();
    showViews();
    showSpec();
    showSpikeList();
    showReprintList();
    const extra = [...(view !== "movers" ? [["view", view]] : []), ["w", w], ...(finish ? [["finish", finish]] : []),
      ...(band ? [["price", amounts[band]]] : []), ...(playable ? [["rl", "legal"]] : []), ...filterParams,
      ...(shared ? [["watch", params.get("watch")]] : [])];
    history.replaceState(null, "", "?" + new URLSearchParams([["prices", ""], ...extra]));
    chipRow($("price-windows"), PRICE_WINDOWS.map(x => [x, x === 365 ? "1 year" : `${x} days`]), w,
      x => { w = x; update(); });
    chipRow($("price-finishes"), [["", "Any finish"], ["nonfoil", "Nonfoil"], ["foil", "Foil"]], finish, x => { finish = x; update(); });
    chipRow($("price-bands"), amounts.map((_, i) => [i, `${bandName(i)} and up`]), band,
      i => { band = i; update(); });
    $("price-summary").textContent = `${dayName(days.at(-1))} against ${dayName(days.at(-1) - w)}`;
    const total = totalOf();
    $("reserved-lede").textContent = `One of each of its ${total.at(-1)[2]} cards: ${wholeDollars(total.at(-1)[1])} today, `
      + `${wholeDollars(total[0][1])} in ${new Date(Date.UTC(1993, 0, 1) + total[0][0] * 864e5).toLocaleDateString(undefined,
        { month: "short", year: "numeric", timeZone: "UTC" })}.`;
    chipRow($("reserved-printings"), [[false, "All printings"], [true, "Tournament-legal only"]], playable, x => {
      playable = x;
      update();
      drawTotal();
    });
    showList();

    const asked = shownFor = {};
    movers[w] ??= getJson(`prices/movers-${w}.json`);
    const data = await movers[w];
    if (asked !== shownFor) return;
    const cents = toCents(amounts[band]);
    const size = r => Math.abs(Math.log(r[4] / r[5]));
    const keep = data.rows.filter(r => Math.min(r[4], r[5]) >= cents && rowOk(r, data.sets));
    // Each list stops where some band's biggest changes run out, so it's never missing one
    const [upTo, downTo] = [true, false].map(rose => completeTo(data, cents, finish, rose));
    const picks = list => list.map(r => pricePick(r, data.sets, r[5], w));
    $("price-rising-lede").hidden = $("price-falling-lede").hidden = true; // the buttons above say it
    showPriceRising(picks(keep.filter(r => r[4] > r[5] && size(r) >= upTo).sort((a, b) => size(b) - size(a))));
    showPriceFalling(picks(keep.filter(r => r[4] < r[5] && size(r) >= downTo).sort((a, b) => size(b) - size(a))));
  }
  form.addEventListener("input", update);
  form.addEventListener("submit", e => e.preventDefault());

  // Look up a card by name: the most played that match first, those starting with it before
  const LOOKUP_SHOWN = 12;
  let names;
  const lookup = async () => {
    const typed = $("price-lookup").value.trim(), q = typed.toLowerCase();
    $("price-lookup-note").textContent = "";
    $("price-lookup-results").hidden = true;
    if (q.length < 2) return;
    try { names ??= await getJson("index/names.json"); } catch { $("price-lookup-note").textContent = "Couldn't load the card names. Please try again."; return; }
    if ($("price-lookup").value.trim().toLowerCase() !== q) return; // typed on meanwhile
    const found = [];
    names.forEach((name, card) => name.toLowerCase().includes(q) && found.push(card));
    for (const [name, card] of await getAliases()) if (name.toLowerCase().includes(q) && !found.includes(card)) found.push(card);
    found.sort((a, b) => !names[a].toLowerCase().startsWith(q) - !names[b].toLowerCase().startsWith(q) || a - b);
    if (!found.length) {
      $("price-lookup-note").textContent = `No card is named like “${typed}”.`;
      return;
    }
    const price = card => index.columns.price[card];
    $("price-lookup-results").replaceChildren(el("h3", { className: "sub-heading" }, `Cards: ${found.length.toLocaleString()}`),
      el("ul", { className: "found-list" }, ...found.slice(0, LOOKUP_SHOWN).map(card => el("li", {}, cardButton(card, names), " ",
        el("small", { textContent: price(card) >= 0 ? `from ${dollars(price(card))}` : "no price" })))),
      found.length > LOOKUP_SHOWN ? el("p", { className: "muted", textContent: `And ${(found.length - LOOKUP_SHOWN).toLocaleString()} more: type more of the name.` }) : "");
    $("price-lookup-results").hidden = false;
  };
  $("price-lookup").oninput = lookup;
  $("price-lookup").onfocus = () => getJson("index/names.json").then(n => (names ??= n)).catch(() => {});
  $("price-lookup").onkeydown = async e => { // Enter: the first one found
    if (e.key === "Enter") $("price-lookup-results").querySelector("button")?.click();
  };
  await update();
  onWatchChange();
  pricesMessage("");
  $("prices-page").hidden = false;
  const failed = ids => () => ids.forEach(id => ($(id).textContent = "Couldn't load this. Please try again."));
  getJson("prices/reprints.json").then(data => {
    reprints = data;
    showReprintList();
  }).catch(failed(["reprints-lede"]));
  cardPrices ??= getJson("prices/cards.json").catch(err => { cardPrices = null; throw err; });
  Promise.all([loadDeckData(), loadTrends(), cardPrices]).then(([{ decks }, trends, p]) => {
    spec = { trends, p, k: 1 + decks.windows.indexOf(30) };
    showSpec();
  }).catch(failed(["spec-buys-lede", "buyouts-lede"]));
  Promise.all([getResultsIndex(), cardPrices]).then(([results, p]) => {
    if (!results) return failed(["spikes-lede"])();
    spikes = { results, p };
    showSpikeList();
  }).catch(failed(["spikes-lede"]));
  if (view === "reserve") drawTotal();
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
      detail: `${c.decks.toLocaleString()} of ${c.made[0].toLocaleString()} decks (${percent(c.share)})` })));
  };
  const showThemes = picked => chipRow($("card-themes"), strategies.map(t => [t, withCount(t === null ? "All" : tagLabel(trends.themes[t]),
    t === null ? playing.length : playing.filter(c => c.themes.includes(t)).length)]), picked, t => { showThemes(t); show(t); });
  showThemes(null);
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
  (params.has("pilot") ? showPilot(Number(params.get("pilot"))) : showTournaments()).catch(err => {
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

if (pricesMode) {
  pricesMessage("Loading prices…");
  showPrices().catch(err => {
    console.error(err);
    pricesMessage("Couldn't load the prices. Please try again.");
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
  if (params.get("from")) { // a tournament list, or a commander's average deck, to compare your deck with
    const average = params.get("from").startsWith("avg.");
    deckMessage(average ? "Loading the average deck…" : "Loading the tournament list…");
    (average ? averageTarget(params.get("from"), params.get("cards"), params.get("of"))
      : tournamentDeck(params.get("from"), Number(params.get("pilot")) || 0)).then(deck => {
      fromDeck = deck;
      $("compare-target-text").textContent = deck.label;
      $("compare-target").hidden = false;
      $("compare-instead").onclick = () => {
        fromDeck = null;
        $("compare-target").hidden = true;
        $("decklist").value = borrowed = deck.text;
        run();
      };
      if ($("decklist").value.trim()) return run();
      deckMessage("Paste your deck, or a Moxfield or Archidekt link, to compare it with this list.");
    }).catch(err => {
      console.error(err);
      deckMessage(`Couldn't load that ${average ? "average deck" : "tournament list"}. Please try again.`);
    });
  } else if (link) run(); // a shared ?deck=<link>
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
