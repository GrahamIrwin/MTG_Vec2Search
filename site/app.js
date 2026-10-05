import {
  parseQuery, buildIndex, search, nameSearch, mainTerms, termsNeeded, decodePosting, parsePrice,
  isBudget, BUDGET_USD, SORTS, sortResults, randomSearches,
} from "./search.js";
import { CURRENCIES, detectCurrency, usdRate, moneyFormatter } from "./currency.js";
import {
  nameLookup, parseDecklist, decodeShard, similarDecks, foldCopies, recommend, closestCommanders,
  findBuilds, playCounts, distinctive, averageDeck, buildName, buildTags,
  decodeTrends, withCards, filterCommanders, trendingCommanders, trendingCards, commandersPlaying, risingCards,
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
const searching = !deckMode && !commandersMode && !trendsMode && [...params.keys()].some(k => k !== "sort");

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
$("intro").hidden = searching || deckMode || commandersMode || trendsMode;
$("results").hidden = !searching;
form.hidden = deckMode || commandersMode || trendsMode;
$("deck-view").hidden = !deckMode;
$("commander-view").hidden = !commandersMode;
$("trends-view").hidden = !trendsMode;
$(deckMode ? "mode-deck" : commandersMode ? "mode-commanders" : trendsMode ? "mode-trends" : "mode-cards")
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
  const [name, id] = (await chunks.get(k))[card % CHUNK];
  return { name, id };
}

// A card in a results gallery: image, name, price, a detail line and an optional bar (0 to 1)
function cardTile(card, { name, id }, detail, bar, i) {
  const price = index.columns.price[card];
  const img = el("img", { alt: name, loading: "lazy", decoding: "async" });
  img.onload = () => img.classList.add("loaded");
  img.src = imageUrl(id);
  const tile = el("button", { className: "card", type: "button", onclick: () => openCard(id, card) },
    el("span", { className: "card-art" }, img),
    el("span", { className: "card-name", textContent: name }),
    el("span", { className: "card-meta" },
      el("span", { textContent: price >= 0 ? money.formatUsd(price / 100) : "No price" }),
      el("span", { textContent: detail })));
  if (bar !== null) tile.append(el("span", { className: "match-bar" }, el("span", { style: `width:${bar * 100}%` })));
  tile.style.setProperty("--i", i);
  return tile;
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

// card: its number in the index, when known, for links to the commanders that play it
async function openCard(id, card) {
  showCardActions(card);
  $("printings").replaceChildren();
  $("modal-name").textContent = "Loading…";
  $("modal-type").textContent = $("modal-set").textContent = $("price").textContent = "";
  $("foil-label").hidden = true;
  $("modal-img").src = imageUrl(id);
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
    .map(a => ({ card: a.card, type: typeOf(a.card), detail: `in ${a.decks} of ${neighbors} decks`, bar: a.decks / neighbors }));
  $("adds-lede").textContent = `What the ${neighbors} decks most like yours play that yours doesn't, favoring cards they play more than most ${lead} decks do.`;
  await showAdds(picks);

  // Cuts only make sense against decks with your own commander: another's never play its cards
  $("cuts-section").hidden = key !== ownKey;
  const rare = cuts.filter(c => c.share < CUT_BELOW).slice(0, SHOW_CUTS);
  $("cuts").replaceChildren(...(rare.length
    ? rare.map(c => cardButton(c.card, names, `${names[c.card]} · ${Math.round(c.share * 100)}%`))
    : [el("span", { className: "muted", textContent: "None: similar decks play almost all of your cards." })]));

  // The similar decks, each opening to the cards they play that yours doesn't
  const have = new Set(mine);
  const items = foldCopies(similar.filter(r => r.similarity > 0), MAX_DECKS).map((r, i) => {
    const meta = `${r.shared} cards in common · updated ${r.deck.updated}`
      + (r.copies ? ` · ${r.copies} near-${r.copies === 1 ? "copy" : "copies"}` : "");
    const details = el("details", {},
      el("summary", {},
        el("span", { className: "sim", textContent: `${Math.round(r.similarity * 100)}%` }),
        el("span", { className: "deck-name", textContent: r.deck.name || "Untitled deck" }),
        el("a", { className: "open", href: `https://archidekt.com/decks/${r.deck.id}`, target: "_blank", rel: "noopener", textContent: "Archidekt ↗" }),
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
    gallery.replaceChildren(...page.map((a, i) => cardTile(a.card, infos[i], a.detail, a.bar, i % PAGE_ADDS)));
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

// === Commanders: every commander with decks, and what their decks play ===
const PAGE_COMMANDERS = 30;
const SIGNATURE_SHOWN = 60;
const PAGE_LISTS = 20;
const BASIC_OF = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
const commanderMessage = text => {
  $("commander-message").textContent = text;
  $("commander-message").hidden = !text;
};
const commanderLink = key => "?" + new URLSearchParams({ commander: key });

// A gallery of commanders, PAGE_COMMANDERS at a time, each opening its page. Returns a function
// that shows a list: [{key, name, detail}]
function commanderGallery(gallery, moreButton) {
  let list = [];
  let shown = 0;
  const more = async () => {
    const current = list;
    moreButton.hidden = true;
    const page = current.slice(shown, shown + PAGE_COMMANDERS);
    const infos = await Promise.all(page.map(c => cardInfo(+c.key.split("-")[0])));
    if (current !== list) return; // shown another list while loading
    gallery.append(...page.map((c, i) => {
      const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
      img.onload = () => img.classList.add("loaded");
      img.src = imageUrl(infos[i].id);
      const tile = el("a", { className: "card", href: commanderLink(c.key) },
        el("span", { className: "card-art" }, img),
        el("span", { className: "card-name", textContent: c.name }),
        el("span", { className: "card-meta" }, el("span", { textContent: c.detail })));
      tile.style.setProperty("--i", i);
      return tile;
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
  $("commander-filter").oninput = () => {
    const q = $("commander-filter").value.trim().toLowerCase();
    const matches = all.filter(c => c.name.toLowerCase().includes(q));
    $("commander-count").textContent = `${matches.length.toLocaleString()} ${matches.length === 1 ? "commander" : "commanders"}`
      + (q ? "" : ` · ${decks.decks.toLocaleString()} decks`);
    showCommanderList(matches);
  };
  $("commander-filter").oninput();
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
  const n = shard.decks.length;

  $("commander-art").replaceChildren(...infos.map(({ name, id }, i) =>
    el("button", { type: "button", className: "card", onclick: () => openCard(id, leaders[i]) }, el("img", { src: imageUrl(id), alt: name }))));
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
  const groups = [{ name: "All decks", members: shard.decks.map((_, d) => d) }, ...builds];
  $("builds-lede").textContent = builds.length
    ? `${lead} decks fall into ${builds.length} builds by the cards they play, each named for the kind of card (Scryfall Tagger tag) it plays more of than the rest. Pick one to see its cards and decks.`
    : `There aren't enough ${lead} decks, or they're too alike, to tell builds apart.`;
  $("builds").hidden = !builds.length;
  $("builds").replaceChildren(...groups.map((g, i) => el("button", {
    type: "button", ariaPressed: String(i === 0),
    onclick: e => {
      for (const b of $("builds").children) b.ariaPressed = String(b === e.currentTarget);
      showGroup(g);
    },
  }, g.name, el("small", { textContent: i ? `${Math.round(g.members.length / n * 100)}%` : n.toLocaleString() }))));

  let current;
  async function showGroup(g) {
    current = g;
    const all = g === groups[0];
    const counts = playCounts(shard, g.members);
    const share = p => counts[p] / g.members.length;
    const detail = p => `in ${Math.round(share(p) * 100)}% of decks`;

    const tile = p => ({ card: shard.cards[p], type: typeOf(shard.cards[p]), detail: detail(p), bar: share(p) });

    // Signature cards: what sets these decks apart from other commanders' decks (all of them),
    // or from the commander's other decks (a build)
    $("signature-lede").textContent = all
      ? `What ${lead} decks play far more often than other commanders' decks do.`
      : `What this build plays far more often than other ${lead} decks do. It leans on: ${g.tags.map(t => tagLabel(t).toLowerCase()).join(", ") || "no tag in particular"}.`;
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
      + ` (${basics} of them basic), as many of each as ${all ? "these" : "this build's"} decks play on average, picking the cards they play most.`;
    const picks = [...average.spells, ...average.lands].map(p => ({ card: shard.cards[p], detail: detail(p), bar: share(p) }))
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
            el("a", { className: "open", href: `https://archidekt.com/decks/${deck.id}`, target: "_blank", rel: "noopener", textContent: "Archidekt ↗" }),
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
      el("div", { className: "gallery" }, ...list.map((a, i) => cardTile(a.card, averageInfos[s][i], a.detail, a.bar, i))),
    ]));
  }

  // Trends: what the decks made lately play more of, for a window of days (index.json's windows)
  const windows = (decks.windows ?? []).map((days, i) => ({ days, since: decks.since[i] }));
  let shownWindow = windows.findIndex(w => w.days === DEFAULT_DAYS && w.since !== null);
  if (shownWindow < 0) shownWindow = windows.findIndex(w => w.since !== null);
  function showCommanderTrends(g, counts) {
    const recentOf = w => (w.since === null ? [] : g.members.filter(d => shard.decks[d].id >= w.since));
    $("commander-windows").replaceChildren(...windows.map((w, i) => ({ w, i })).reverse().map(({ w, i }) => el("button", {
      type: "button", ariaPressed: String(i === shownWindow), disabled: w.since === null,
      title: w.since === null ? "Not enough data yet" : "",
      onclick: () => { shownWindow = i; showCommanderTrends(g, counts); },
    }, `${w.days} days`, el("small", { textContent: w.since === null ? "–" : recentOf(w).length }))));
    const w = windows[shownWindow];
    const recent = w ? recentOf(w) : [];
    const whose = g === groups[0] ? `${lead}'s` : "this build's";
    $("commander-trends-lede").textContent = !w
      ? "Not enough data yet: decks show up here once the crawler knows when they were made."
      : `${recent.length.toLocaleString()} of ${whose} ${g.members.length.toLocaleString()} decks were made in the last ${w.days} days.`;
    const pick = (p, detail, bar) => ({ card: shard.cards[p], type: typeOf(shard.cards[p]), detail, bar });
    showRising(recent.length ? risingCards(shard, g.members, recent)
      .map(x => pick(x.p, `${percent(x.was)} → ${percent(x.share)} of decks`, x.share)) : []);
    showNewCards([...counts.keys()].filter(p => counts[p] && isNew(released, shard.cards[p]))
      .sort((a, b) => counts[b] - counts[a] || a - b)
      .map(p => pick(p, `in ${percent(counts[p] / g.members.length)} of decks`, counts[p] / g.members.length)));
  }

  await showGroup(groups[0]);
  commanderMessage("");
  $("commander-page").hidden = false;
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
// Most of each commander's cards (decks/trend-cards.json, about a MB): only for filters and card pages
let cardsLoaded;
const loadTrendCards = trends => (cardsLoaded ??= getJson("decks/trend-cards.json").then(data => withCards(trends.commanders, data)));

async function showTrends() {
  const [{ decks }, trends, released] = await Promise.all([loadDeckData(), loadTrends(), getReleased()]);
  const windows = [{ days: null, since: 0 }, ...decks.windows.map((days, i) => ({ days, since: decks.since[i] }))];
  const fromUrl = windows.findIndex(w => String(w.days ?? "all") === params.get("w"));
  let w = windows[fromUrl]?.since != null ? fromUrl : windows.findIndex(x => x.days === DEFAULT_DAYS && x.since !== null);
  if (w < 0) w = 0;

  const tform = $("trend-form");
  for (const input of tform.elements) {
    if (input.type === "checkbox") input.checked = params.getAll(input.name).includes(input.value);
    else if (input.name && params.has(input.name)) input.value = params.get(input.name);
  }
  linkColorless(tform);
  $("trend-themes").replaceChildren(...trends.themes.map(t => el("option", { value: tagLabel(t) })));

  const readFilters = () => {
    const data = new FormData(tform);
    const colors = data.getAll("c");
    const theme = data.get("theme").trim().toLowerCase();
    return {
      window: w,
      colors: !colors.length ? null : colors.includes("C") ? 0 : colors.reduce((m, c) => m | (1 << "WUBRG".indexOf(c)), 0),
      maxPrice: data.get("budget") ? Math.round((data.get("budget") / (money.rate ?? 1)) * 100) : null,
      themes: theme ? new Set(trends.themes.flatMap((t, i) => (tagLabel(t).toLowerCase().includes(theme) ? [i] : []))) : null,
      brackets: data.getAll("b").map(Number),
      kind: data.get("kind"),
      min: Number(data.get("min")) || 0,
    };
  };

  let shownFor;
  async function update() {
    const f = readFilters();
    const active = (f.colors !== null) + (f.maxPrice !== null) + !!f.themes + !!f.brackets.length + !!f.kind + !!f.min;
    $("trend-filter-count").textContent = active;
    $("trend-filter-count").hidden = !active;
    // The URL holds the period and filters, so a view of Trends is a link to share
    const next = new URLSearchParams([["trends", ""], ...(w ? [["w", windows[w].days]] : [["w", "all"]]),
      ...[...new FormData(tform)].filter(([, v]) => v)]);
    history.replaceState(null, "", "?" + next);

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
      await loadTrendCards(trends);
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
  tform.addEventListener("input", update);
  tform.addEventListener("submit", e => e.preventDefault());
  $("trend-filters").open = [...params.keys()].some(k => !["trends", "w"].includes(k));
  await update();
  trendsMessage("");
  $("trends-page").hidden = false;
}

// === A card's page: the commanders whose decks play it, by what those decks are known for ===
const TREND_SHARE = 0.15; // TREND_SHARE in build_decks.py
const MAX_STRATEGIES = 12;
const showCardCommanders = commanderGallery($("card-commanders"), $("more-card-commanders"));
async function showCardPage(card) {
  const trends = await loadTrends();
  if (!Number.isInteger(card) || card < 0 || card >= index.n) return commanderMessage("There's no such card.");
  const [info] = await Promise.all([cardInfo(card), loadTrendCards(trends)]);
  document.title = `${info.name} · MTG Vec2Search`;
  $("card-art").replaceChildren(el("button", { type: "button", className: "card", onclick: () => openCard(info.id, card) },
    el("img", { src: imageUrl(info.id), alt: info.name })));
  $("card-name").textContent = info.name;
  const { everything } = trends;
  const i = everything.cards.indexOf(card);
  const decksWith = i < 0 ? 0 : everything.plays[0][i];
  const playing = commandersPlaying(trends.commanders, card);
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
