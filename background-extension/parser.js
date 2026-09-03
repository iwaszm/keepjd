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
const SEARCH_PAGE_SIZE = 20;

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
  const text = String(html || "");
  collectFromJsonLdScripts(text, found, capturedAt);

  const scripts = extractNextScripts(text).map(normalizeScriptText);

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

  const pageCount = extractPageCountNumber(text);
  if (pageCount !== null) pageNumbers.push(pageCount);

  const validPageNumbers = pageNumbers.filter((value) => Number.isInteger(value) && value > 0);
  return validPageNumbers.length ? Math.max(...validPageNumbers) : null;
}

export function extractPageCountNumber(html) {
  const text = String(html || "");
  const pageCounts = collectMetadataNumbers(text, "pageCount");

  const validPageCounts = pageCounts.filter((value) => Number.isInteger(value) && value > 0);
  if (validPageCounts.length) return Math.max(...validPageCounts);

  const skuCounts = [];
  for (const key of ["skuCount", "orgSkuCount", "resultShowCount", "resultCount"]) {
    skuCounts.push(...collectMetadataNumbers(text, key));
  }

  const validSkuCounts = skuCounts.filter((value) => Number.isInteger(value) && value > 0);
  return validSkuCounts.length ? Math.ceil(Math.max(...validSkuCounts) / SEARCH_PAGE_SIZE) : null;
}

export function describeSearchPageHtml(html) {
  const text = String(html || "");
  return {
    htmlLength: text.length,
    nextScriptMarkers: countMatches(text, /self\.__next_[sf]/g),
    jsonLdScripts: countMatches(text, /application\/ld\+json/gi),
    productUrlMatches: countMatches(text, /\/dp\//g),
    priceCurrencyMatches: countMatches(text, /priceCurrency/g),
    pageCountMatches: countMatches(text, /pageCount/g),
    escapedPageCountMatches: countMatches(text, /\\"pageCount\\"/g),
    skuCountMatches: countMatches(text, /skuCount/g),
    orgSkuCountMatches: countMatches(text, /orgSkuCount/g),
    resultCountMatches: countMatches(text, /resultCount/g),
    hasSearchProductArea: /search_productArea|SearchResult_productList/i.test(text),
    hasCaptchaOrRobotText: /captcha|robot|verify|验证|安全检查|unusual traffic/i.test(text),
    hasForbiddenText: /(?:\b403\b|forbidden|access denied|访问被拒绝|拒绝访问)/i.test(text),
    hasGeoRedirectText: /geoRedirect|switch country|切换国家|countrySwitch/i.test(text)
  };
}

function extractNextScripts(html) {
  const scripts = [];
  const text = String(html || "");
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const scriptText = match[1] || "";
    if (isCandidateProductScript(scriptText)) {
      scripts.push(scriptText);
    }
  }

  const lastScriptStart = text.lastIndexOf("<script");
  const lastScriptEnd = text.lastIndexOf("</script>");
  if (lastScriptStart > lastScriptEnd) {
    const scriptBodyStart = text.indexOf(">", lastScriptStart);
    if (scriptBodyStart !== -1) {
      const partialScriptText = text.slice(scriptBodyStart + 1);
      if (isCandidateProductScript(partialScriptText)) {
        scripts.push(partialScriptText);
      }
    }
  }

  return scripts;
}

function extractJsonLdScripts(html) {
  const scripts = [];
  const pattern = /<script\b(?=[^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    scripts.push(decodeHtmlEntities(match[1] || ""));
  }
  return scripts;
}

function collectFromJsonLdScripts(html, found, capturedAt) {
  for (const scriptText of extractJsonLdScripts(html)) {
    const parsed = parseJson(scriptText);
    if (parsed !== null) collectFromJsonLdNode(parsed, found, capturedAt);
  }
}

function collectFromJsonLdNode(node, found, capturedAt) {
  if (Array.isArray(node)) {
    for (const item of node) collectFromJsonLdNode(item, found, capturedAt);
    return;
  }

  if (!node || typeof node !== "object") return;

  const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : String(node["@type"] || "");
  if (/\bProduct\b/i.test(type)) {
    collectFromJsonLdProduct(node, found, capturedAt);
  }

  if (Array.isArray(node.itemListElement)) {
    for (const element of node.itemListElement) {
      collectFromJsonLdNode(element?.item || element, found, capturedAt);
    }
  }
}

function collectFromJsonLdProduct(product, found, capturedAt) {
  const id = extractProductIdFromUrlText(product.url || "");
  if (!id || found.has(id)) return;

  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const price = parseNumericPrice(offer?.price);
  if (!isPlausibleProductPrice(price)) return;

  found.set(id, buildObservation(id, price, capturedAt, normalizeAvailability(offer?.availability)));
}

function isCandidateProductScript(text) {
  return /self\.__next_[sf]|\/dp\/|skuId|productId|wareId|price/i.test(text);
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

    found.set(id, buildObservation(id, price, capturedAt, extractJsonLdAvailability(windowText)));
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

    found.set(id, buildObservation(id, price, capturedAt, extractJsonLdAvailability(windowText)));
  }
}

function buildObservation(id, price, capturedAt, availability = "unknown") {
  return {
    joybuy_product_id: id,
    title: null,
    price,
    list_price: null,
    promo_price: null,
    availability,
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

function extractJsonLdAvailability(text) {
  const value = String(text || "")
    .replace(/\\\//g, "/")
    .match(/"availability"\s*:\s*"https:\/\/schema\.org\/(InStock|OutOfStock)"/i)?.[1];
  return normalizeAvailability(value);
}

function normalizeAvailability(value) {
  const text = String(value || "").replace(/\\\//g, "/");
  if (/InStock$/i.test(text)) return "in_stock";
  if (/OutOfStock$/i.test(text)) return "out_of_stock";
  return "unknown";
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
    .replace(/\\\//g, "/")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u003C/gi, "<")
    .replace(/\\u003E/gi, ">")
    .replace(/\\u0026/gi, "&")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#x22;/gi, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
}

function collectMetadataNumbers(text, key) {
  const values = [];
  const candidates = [
    String(text || ""),
    decodeHtmlEntities(text),
    normalizeScriptText(decodeHtmlEntities(text))
  ];
  const pattern = new RegExp(`\\\\*["']${escapeRegExp(key)}\\\\*["']\\s*:\\s*(\\d+)`, "gi");

  for (const candidate of new Set(candidates)) {
    for (const match of candidate.matchAll(pattern)) {
      values.push(Number(match[1]));
    }
  }

  return values;
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
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
