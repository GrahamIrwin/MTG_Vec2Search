import {
  parseQuery, buildIndex, search, nameSearch, mainTerms, termsNeeded, decodePosting, parsePrice,
  isBudget, BUDGET_USD, SORTS, sortResults, randomSearches,
} from "./search.js";
import { CURRENCIES, detectCurrency, usdRate, moneyFormatter } from "./currency.js";
import {
  nameLookup, parseDecklist, decodeShard, similarDecks, foldCopies, recommend, closestCommanders,
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
const searching = !deckMode && [...params.keys()].some(k => k !== "sort");

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
// Colorless excludes every color, so checking it clears and grays out the color pips
const colorless = form.querySelector('[name="c"][value="C"]');
const syncColorless = () => {
  for (const pip of form.querySelectorAll('[name="c"]:not([value="C"])')) {
    pip.disabled = colorless.checked;
    if (colorless.checked) pip.checked = false;
  }
};
colorless.addEventListener("change", syncColorless);
syncColorless();
form.addEventListener("submit", e => {
  e.preventDefault();
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
if (currency !== "USD") $("price-label").textContent = `Max price (${currency})`;

// === Index files: each is downloaded only when something needs it (see build_index.py) ===
let metaPromise;
function getMeta() {
  metaPromise ??= getJson("index/meta.json").then(meta => {
    $("updated").textContent = `updated ${new Date(meta.updated).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" })}`;
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
$("intro").hidden = searching || deckMode;
$("results").hidden = !searching;
form.hidden = deckMode;
$("deck-view").hidden = !deckMode;
$(deckMode ? "mode-deck" : "mode-cards").setAttribute("aria-current", "page");

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
  const tile = el("button", { className: "card", type: "button", onclick: () => openCard(id) },
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

async function openCard(id) {
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

// === Find similar decks (deck.js does the math, build_decks.py makes the data) ===
const BASIC = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;
const SHOW_DECKS = 20;
const SHOW_ADDS = 30;
const SHOW_CUTS = 16;
const CUT_BELOW = 0.1; // played by under 10% of similar decks
const deckMessage = text => {
  $("deck-message").textContent = text;
  $("deck-message").hidden = !text;
};

let deckData;
function loadDeckData() {
  deckData ??= Promise.all([getMeta(), getJson("index/columns.json"), getJson("index/names.json"),
    getJson("decks/index.json"), usdRate(currency)])
    .then(([meta, columns, names, decks, rate]) => {
      money = moneyFormatter(currency, rate);
      index = buildIndex(meta, columns);
      return { names, lookup: nameLookup(names), decks, files: new Set(decks.commanders.map(c => c[0])) };
    });
  deckData.catch(() => (deckData = null)); // try again next time
  return deckData;
}
const commanderNames = (key, names) => key.split("-").map(n => names[n]).join(" & ");
const cardButton = (card, names, label = names[card]) =>
  el("button", { type: "button", className: "term", textContent: label, onclick: async () => openCard((await cardInfo(card)).id) });

// key: compare with this commander's decks instead of the pasted deck's own commander
async function findSimilar(key) {
  const text = $("decklist").value;
  try { localStorage.setItem("decklist", text); } catch {}
  $("deck-results").hidden = true;
  deckMessage("Loading decks…");
  const { names, lookup, decks, files } = await loadDeckData();
  const parsed = parseDecklist(text, lookup);
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

  // Summary: whose decks these are, and what was (and wasn't) recognized
  const lead = commanderNames(key, names);
  const summary = [el("span", { className: "label", textContent: "Compared with" }),
    el("span", { className: "term-chip", textContent: `${count.toLocaleString()} ${lead} decks` })];
  const note = text => summary.push(el("span", { className: "muted", textContent: text }));
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

  // Similar decks, each opening to the cards they play that yours doesn't
  const have = new Set(mine);
  $("similar").replaceChildren(...foldCopies(similar.filter(r => r.similarity > 0), SHOW_DECKS).map(r => {
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
    return el("li", {}, details);
  }));

  // Recommendations, within the deck's color identity
  const { identity } = index.columns;
  const colors = (commanders.length ? commanders : [...parsed.cards]).reduce((m, c) => m | identity[c], 0);
  const picks = adds.filter(a => (identity[a.card] & ~colors) === 0).slice(0, SHOW_ADDS);
  $("adds-lede").textContent = `What the ${neighbors} decks most like yours play that yours doesn't, favoring cards they play more than most ${lead} decks do.`;
  const infos = await Promise.all(picks.map(a => cardInfo(a.card)));
  $("adds").replaceChildren(...picks.map((a, i) =>
    cardTile(a.card, infos[i], `in ${a.decks} of ${neighbors} decks`, a.decks / neighbors, i)));
  // Cuts only make sense against decks with your own commander: another's never play its cards
  $("cuts-section").hidden = key !== ownKey;
  const rare = cuts.filter(c => c.share < CUT_BELOW).slice(0, SHOW_CUTS);
  $("cuts").replaceChildren(...(rare.length
    ? rare.map(c => cardButton(c.card, names, `${names[c.card]} · ${Math.round(c.share * 100)}%`))
    : [el("span", { className: "muted", textContent: "None: similar decks play almost all of your cards." })]));

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

if (deckMode) {
  try { $("decklist").value = localStorage.getItem("decklist") ?? ""; } catch {}
  $("deck-form").addEventListener("submit", e => {
    e.preventDefault();
    findSimilar().catch(err => {
      console.error(err);
      deckMessage("Couldn't load the deck data. Please try again.");
    });
  });
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
