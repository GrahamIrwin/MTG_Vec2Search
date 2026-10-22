// Cloudflare Worker: turns a Moxfield or Archidekt deck link into a plain decklist for the site.
// Browsers can't call either site's API from another site (CORS), so the page asks this instead:
//   GET /?url=https://moxfield.com/decks/abc123  ->  { name, site, list: "1 Atraxa, Praetors' Voice (2X2) 190 *CMDR*\n1 Sol Ring (CMM) 410 *F*\n..." }
// Each line names its printing (set, collector number, *F* foil, *E* etched), as the sites' own exports do
// It fetches only the one deck it's asked for, as itself (no crawling, no pretending to be a browser).
const UA = "MTG_Vec2Search/1.0 (+https://github.com/grahamirwin/MTG_Vec2Search)";
const SITE = "https://grahamirwin.github.io";
const allowed = origin => origin === SITE || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? ""); // + local testing

const SITES = [
  {
    site: "Moxfield",
    match: /moxfield\.com\/decks\/([\w-]+)/,
    api: id => `https://api2.moxfield.com/v3/decks/all/${id}`,
    read: deck => ({
      name: deck.name,
      commanders: Object.values(deck.boards?.commanders?.cards ?? {}),
      cards: Object.values(deck.boards?.mainboard?.cards ?? {}),
      nameOf: entry => entry.card.name,
      printingOf: entry => [entry.card.set, entry.card.cn, entry.finish], // finish: nonFoil, foil, etched
    }),
  },
  {
    site: "Archidekt",
    match: /archidekt\.com\/(?:api\/)?decks\/(\d+)/,
    api: id => `https://archidekt.com/api/decks/${id}/`,
    read: deck => {
      // A card's first category decides where it is; Maybeboard/Sideboard aren't in the deck
      const out = new Set((deck.categories ?? []).filter(c => c.includedInDeck === false).map(c => c.name));
      const inDeck = (deck.cards ?? []).filter(e => !out.has(e.categories?.[0]));
      return {
        name: deck.name,
        commanders: inDeck.filter(e => e.categories?.includes("Commander")),
        cards: inDeck.filter(e => !e.categories?.includes("Commander")),
        nameOf: entry => entry.card.oracleCard.name,
        printingOf: entry => [entry.card.edition?.editioncode, entry.card.collectorNumber, entry.modifier], // Normal, Foil, Etched
      };
    },
  },
];

export function deckList(read) {
  const printing = e => {
    const [set, number, finish = ""] = read.printingOf(e);
    if (!set || !number) return "";
    const f = finish.toLowerCase();
    return ` (${set.toUpperCase()}) ${number}${f === "foil" ? " *F*" : f === "etched" ? " *E*" : ""}`;
  };
  const line = (e, mark = "") => `${e.quantity ?? 1} ${read.nameOf(e)}${printing(e)}${mark}`;
  return [...read.commanders.map(e => line(e, " *CMDR*")), ...read.cards.map(e => line(e))].join("\n");
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": allowed(origin) ? origin : SITE,
      "Content-Type": "application/json",
      Vary: "Origin",
    };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
    const link = new URL(request.url).searchParams.get("url") ?? "";
    for (const s of SITES) {
      const id = link.match(s.match)?.[1];
      if (!id) continue;
      // Cached for 10 minutes, so pasting the same link again doesn't hit their API
      const res = await fetch(s.api(id), { headers: { "User-Agent": UA, Accept: "application/json" }, cf: { cacheTtl: 600 } });
      if (res.status === 404) return reply({ error: `${s.site} can't find that deck. Is it public?` }, 404);
      if (!res.ok) return reply({ error: `${s.site} didn't answer (${res.status}). Try again, or paste the list.` }, 502);
      const read = s.read(await res.json());
      return reply({ name: read.name, site: s.site, list: deckList(read) });
    }
    return reply({ error: "That isn't a Moxfield or Archidekt deck link." }, 400);
  },
};
