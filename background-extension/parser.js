const SCRIPT_PRICE_KEYS = [
  "promotionPrice",
  "promoPrice",
  "salePrice",
  "sellingPrice",
  "skuPrice",
  "realPrice",
  "currentPrice",
  "displayPrice",
  "jdPrice",
  "mainPrice",
  "price"
];

const PRICE_CONTEXT_BLOCKLIST = /(?:unit|unitPrice|unit_price|basePrice|base_price|referencePrice|reference_price|pricePer|price_per|perPrice|per_price|grundpreis|basispreis|stückpreis|shipping|delivery|freight|tax|vat|discount|coupon|voucher|saving|save|points|installment|threshold)/i;
const GENERIC_PRICE_CONTEXT_ALLOWLIST = /(?:priceCurrency|offers|itemCommonView|skuId|skuUuid|productId|wareId|Product|ListItem|mainPrice)/i;
const EURO_PRICE_RE = /€\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)|(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)\s*€/;

export function buildPageUrl(seedUrl, pageNumber) {
  const url = new URL(seedUrl);
  url.searchParams.set("page", String(pageNumber));
  return url.toString();
}

export function pageNumberFromSeed(seedUrl) {
  const url = new URL(seedUrl);
  const page = Number(url.searchParams.get("page") || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function extractSearchPageObservations(html, capturedAt = captureDate()) {
  const found = new Map();
  const scripts = extractNextScripts(html).map(normalizeScriptText);

  for (const text of scripts) {
    collectFromProductUrls(text, found, capturedAt);
    collectFromStructuredIds(text, found, capturedAt);
  }

  return [...found.values()];
}

export function extractMaxPageNumber(html) {
  const pageNumbers = [];
  const text = String(html || "");

  for (const match of text.matchAll(/aria-label=["']Go to page\s+(\d+)["']/gi)) {
    pageNumbers.push(Number(match[1]));
  }

  for (const match of text.matchAll(/[?&amp;]page=(\d+)(?:[&#"']|&amp;|$)/gi)) {
    pageNumbers.push(Number(match[1]));
  }

  const validPageNumbers = pageNumbers.filter((value) => Number.isInteger(value) && value > 0);
  return validPageNumbers.length ? Math.max(...validPageNumbers) : null;
}

function extractNextScripts(html) {
  const scripts = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const text = match[1] || "";
    if (/self\.__next_[sf]|\/dp\/|skuId|productId|wareId|price/i.test(text)) {
      scripts.push(text);
    }
  }
  return scripts;
}

function collectFromProductUrls(text, found, capturedAt) {
  const productUrlPattern = /(?:https?:\/\/(?:www\.)?joybuy\.de)?\/dp\/[^"'<>\\\s]+/gi;
  const matches = [...text.matchAll(productUrlPattern)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const id = extractProductIdFromUrlText(match[0]);
    if (!id || found.has(id)) continue;

    const windowText = productWindowFromMatches(text, matches, index);
    const price = extractPriceFromProductWindow(windowText, id);
    if (!isPlausibleProductPrice(price)) continue;

    found.set(id, buildObservation(id, price, capturedAt));
  }
}

function collectFromStructuredIds(text, found, capturedAt) {
  const idPattern = /["']?(?:skuId|sku|productId|wareId|itemId)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{5,})["']?/gi;
  const matches = [...text.matchAll(idPattern)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const id = cleanProductId(match[1]);
    if (!id || found.has(id)) continue;

    const windowText = productWindowFromMatches(text, matches, index);
    const price = extractPriceFromProductWindow(windowText, id);
    if (!isPlausibleProductPrice(price)) continue;

    found.set(id, buildObservation(id, price, capturedAt));
  }
}

function buildObservation(id, price, capturedAt) {
  return {
    joybuy_product_id: id,
    title: null,
    price,
    list_price: null,
    promo_price: null,
    availability: "unknown",
    captured_at: capturedAt
  };
}

function extractPriceFromProductWindow(text, id = "") {
  const jsonLdPrice = extractJsonLdOfferPrice(text, id);
  if (jsonLdPrice !== null) return jsonLdPrice;

  const eventPrice = id ? extractSearchEventPrice(text, id) : null;
  if (eventPrice !== null) return eventPrice;

  const euroPrice = parseEuroPrice(text);
  if (isPlausibleProductPrice(euroPrice)) return euroPrice;

  const candidates = [];
  for (let rank = 0; rank < SCRIPT_PRICE_KEYS.length; rank += 1) {
    const key = SCRIPT_PRICE_KEYS[rank];
    const pattern = new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']?(?:€\\s*)?([0-9]{1,5}(?:[.,][0-9]{1,2})?)`, "gi");
    let match;
    while ((match = pattern.exec(text))) {
      const context = surroundingText(text, match.index, 110, 110);
      if (PRICE_CONTEXT_BLOCKLIST.test(context)) continue;
      if (key === "price" && !GENERIC_PRICE_CONTEXT_ALLOWLIST.test(context)) continue;

      const price = Number(match[1].replace(",", "."));
      if (isPlausibleProductPrice(price)) {
        candidates.push({ rank, index: match.index, price });
      }
    }
  }

  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return candidates[0]?.price ?? null;
}

function extractJsonLdOfferPrice(text, id = "") {
  if (id && !new RegExp(`/dp/(?:[^"'<>\\\\\\s]+/)?${escapeRegExp(id)}(?:[?#"'<>\\\\\\s]|$)`, "i").test(text)) {
    return null;
  }

  const patterns = [
    /"offers"\s*:\s*\{[\s\S]{0,800}?"price"\s*:\s*"([0-9]+(?:[.,][0-9]{1,2})?)"[\s\S]{0,300}?"priceCurrency"\s*:\s*"EUR"/i,
    /"offers"\s*:\s*\{[\s\S]{0,800}?"priceCurrency"\s*:\s*"EUR"[\s\S]{0,300}?"price"\s*:\s*"([0-9]+(?:[.,][0-9]{1,2})?)"/i
  ];
  for (const pattern of patterns) {
    const price = parseNumericPrice(text.match(pattern)?.[1]);
    if (isPlausibleProductPrice(price)) return price;
  }
  return null;
}

function extractSearchEventPrice(text, id) {
  const pattern = new RegExp(`${escapeRegExp(id)},[^"']{0,220}?([0-9]{1,5}(?:\\.[0-9]{2,6}))`, "i");
  const price = parseNumericPrice(text.match(pattern)?.[1]);
  return isPlausibleProductPrice(price) ? price : null;
}

function productWindowFromMatches(text, matches, index) {
  const start = matches[index].index;
  const nextStart = matches[index + 1]?.index ?? text.length;
  return text.slice(start, nextStart);
}

function extractProductIdFromUrlText(value) {
  const match = String(value || "").match(/\/dp\/(?:[^/?#"'\\\s]+\/)?([^/?#"'\\\s]+)/i);
  return match?.[1] ? cleanProductId(match[1]) : "";
}

function parseNumericPrice(value) {
  if (!value) return null;
  const price = Number(String(value).replace(",", "."));
  return Number.isFinite(price) ? price : null;
}

function parseEuroPrice(value) {
  const match = String(value || "").replace(/\u00a0/g, " ").match(EURO_PRICE_RE);
  if (!match) return null;
  const integerPart = match[1] || match[4];
  const decimal = match[3] || match[6];
  const price = Number(`${integerPart.replace(/[.\s]/g, "")}.${decimal}`);
  return Number.isFinite(price) ? price : null;
}

function isPlausibleProductPrice(price) {
  return typeof price === "number" && Number.isFinite(price) && price >= 0.1 && price <= 10000;
}

function cleanProductId(value) {
  const match = decodeURIComponent(String(value || "")).match(/[A-Za-z0-9_-]{5,}/);
  return match ? match[0].replace(/\.html$/i, "") : "";
}

function normalizeScriptText(text) {
  return String(text || "")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u003C/gi, "<")
    .replace(/\\u003E/gi, ">")
    .replace(/\\u0026/gi, "&")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function surroundingText(text, index, before, after) {
  return text.slice(Math.max(0, index - before), Math.min(text.length, index + after));
}

function captureDate() {
  return new Date().toISOString().slice(0, 10);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const __test = {
  parseEuroPrice
};
