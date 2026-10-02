// Display currency: prices come from Scryfall in USD and are converted with Frankfurter
// (European Central Bank rates), which supports these currencies.
export const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "NZD", "JPY", "CHF", "SEK", "NOK", "DKK", "PLN",
  "CZK", "HUF", "RON", "BGN", "TRY", "BRL", "MXN", "INR", "CNY", "HKD", "SGD", "KRW", "ZAR", "ILS"];

const EURO_REGIONS = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV",
  "MT", "NL", "PT", "SI", "SK"];
const REGION = {
  US: "USD", CA: "CAD", GB: "GBP", AU: "AUD", NZ: "NZD", JP: "JPY", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK",
  PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN", TR: "TRY", BR: "BRL", MX: "MXN", IN: "INR", CN: "CNY",
  HK: "HKD", SG: "SGD", KR: "KRW", ZA: "ZAR", IL: "ILS", ...Object.fromEntries(EURO_REGIONS.map(r => [r, "EUR"])),
};
// Time zones say where someone is even when their browser language doesn't (en-US in Canada)
const TIME_ZONES = [
  [/^America\/(Toronto|Montreal|Vancouver|Winnipeg|Edmonton|Calgary|Regina|Swift_Current|Halifax|Glace_Bay|Moncton|Goose_Bay|St_Johns|Whitehorse|Dawson|Yellowknife|Inuvik|Iqaluit|Rankin_Inlet|Resolute|Cambridge_Bay|Atikokan|Creston|Dawson_Creek|Fort_Nelson|Blanc-Sablon|Nipigon|Thunder_Bay|Rainy_River)$/, "CAD"],
  [/^Europe\/(London|Belfast|Guernsey|Jersey|Isle_of_Man)$/, "GBP"],
  [/^Europe\/(Zurich|Busingen)$/, "CHF"], [/^Europe\/Stockholm$/, "SEK"], [/^Europe\/Oslo$/, "NOK"],
  [/^Europe\/Copenhagen$/, "DKK"], [/^Europe\/Warsaw$/, "PLN"], [/^Europe\/Prague$/, "CZK"],
  [/^Europe\/Budapest$/, "HUF"], [/^Europe\/Bucharest$/, "RON"], [/^Europe\/Sofia$/, "BGN"], [/^Europe\/Istanbul$/, "TRY"],
  [/^Europe\/(Berlin|Paris|Madrid|Rome|Amsterdam|Brussels|Vienna|Dublin|Lisbon|Helsinki|Athens|Luxembourg|Bratislava|Ljubljana|Tallinn|Riga|Vilnius|Malta|Zagreb|Nicosia|Monaco|Andorra|San_Marino|Vatican)$/, "EUR"],
  [/^Australia\//, "AUD"], [/^Pacific\/(Auckland|Chatham)$/, "NZD"], [/^Asia\/Tokyo$/, "JPY"],
  [/^Asia\/(Kolkata|Calcutta)$/, "INR"], [/^Asia\/Hong_Kong$/, "HKD"], [/^Asia\/Singapore$/, "SGD"],
  [/^Asia\/Seoul$/, "KRW"], [/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)$/, "CNY"], [/^Africa\/Johannesburg$/, "ZAR"],
  [/^Asia\/(Jerusalem|Tel_Aviv)$/, "ILS"], [/^America\/(Sao_Paulo|Bahia|Fortaleza|Recife|Manaus|Belem)$/, "BRL"],
  [/^America\/(Mexico_City|Monterrey|Merida|Cancun|Tijuana|Chihuahua|Hermosillo|Mazatlan)$/, "MXN"],
];

// The visitor's saved choice, else a guess from their time zone, then their browser languages
export function detectCurrency() {
  try {
    const saved = localStorage.getItem("currency");
    if (CURRENCIES.includes(saved)) return saved;
  } catch {}
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  for (const [pattern, currency] of TIME_ZONES) if (pattern.test(zone)) return currency;
  for (const lang of navigator.languages ?? [navigator.language]) {
    try {
      const currency = REGION[new Intl.Locale(lang).maximize().region];
      if (currency) return currency;
    } catch {}
  }
  return "USD";
}

export function saveCurrency(currency) {
  try { localStorage.setItem("currency", currency); } catch {}
}

// Units of `currency` per US dollar (1 for USD); null if the rate can't be fetched
export async function usdRate(currency) {
  if (currency === "USD") return 1;
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${currency}`);
    return (await res.json()).rates[currency] ?? null;
  } catch {
    return null;
  }
}

// formatUsd(7.71) -> the amount in the display currency, e.g. "$10.98" for CAD or "7,22 €" in a
// French locale; in US dollars ("$7.71") if the exchange rate couldn't be fetched
export function moneyFormatter(currency, rate) {
  const local = new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "narrowSymbol" });
  const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  return {
    currency, rate,
    formatUsd: amount => (rate ? local.format(amount * rate) : usd.format(amount)),
    symbol: local.formatToParts(0).find(p => p.type === "currency")?.value ?? "$",
  };
}
