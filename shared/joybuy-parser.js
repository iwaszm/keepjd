const EURO_PRICE_RE = /€\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)|(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)\s*€/;
const URL_ID_PATTERNS = [
  /\/dp\/(?:[^/?#]+\/)?([^/?#]+)/i,
  /\/(?:product|item|p|dp)\/([^/?#]+)/i,
  /[?&](?:sku|skuid|skuId|productId|wareId|itemId|id)=([^&#]+)/i,
  /\/([A-Za-z0-9_-]{8,})(?:[/?#]|$)/
];

export function parsePriceText(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.replace(/\u00a0/g, " ").match(EURO_PRICE_RE);
  if (!match) return null;
  const integerPart = match[1] ?? match[4];
  const decimal = match[3] ?? match[6];
  const integer = integerPart.replace(/[.\s]/g, "");
  const price = Number(`${integer}.${decimal}`);
  return Number.isFinite(price) ? price : null;
}

export function normalizeJoybuyUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = "";
  const allowedParams = new Set(["sku", "skuId", "skuid", "productId", "wareId", "itemId", "id"]);
  for (const key of [...url.searchParams.keys()]) {
    if (!allowedParams.has(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export function extractJoybuyProductId(rawUrl, html = "") {
  if (rawUrl) {
    for (const pattern of URL_ID_PATTERNS) {
      const match = rawUrl.match(pattern);
      if (match?.[1]) return cleanId(match[1]);
    }
  }

  const dataPatterns = [
    /"skuId"\s*:\s*"([^"]+)"/i,
    /"sku"\s*:\s*"([^"]+)"/i,
    /"productId"\s*:\s*"([^"]+)"/i,
    /"wareId"\s*:\s*"([^"]+)"/i,
    /data-(?:sku|product-id|ware-id)=["']([^"']+)["']/i
  ];
  for (const pattern of dataPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) return cleanId(match[1]);
  }

  return null;
}

export function isLikelyJoybuyProductPage(rawUrl, html = "") {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)joybuy\.de$/i.test(url.hostname)) return false;
    if (extractJoybuyProductId(rawUrl, html)) return true;
    return /\b(add to cart|in den warenkorb|lieferung|uvp|rrp|sold by|verkauft von)\b/i.test(html);
  } catch {
    return false;
  }
}

export function extractProductSnapshotFromHtml(html, rawUrl, capturedAt = new Date().toISOString()) {
  if (/Joybuy Risk Control|notFound_container|not-found/i.test(html)) return null;

  const joybuyProductId = extractJoybuyProductId(rawUrl, html);
  const title = firstText(html, [
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<meta\s+name=["']title["']\s+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
  ]);
  const availability = availabilityFromHtml(html);
  const listPrice = structuredNumber(html, ["originPrice", "listPrice", "marketPrice", "retailPrice"]) ?? labeledPrice(html, ["UVP", "RRP", "WAS"]);
  const promoPrice = structuredNumber(html, ["promotionPrice", "promoPrice", "salePrice"]) ?? labeledPrice(html, ["Willkommensangebot", "Blitzangebot", "Promo", "Angebot"]);
  const price = promoPrice ?? structuredNumber(html, ["jdPrice", "price"]) ?? firstPrice(html);

  if (!joybuyProductId || !price) return null;

  return {
    joybuy_product_id: joybuyProductId,
    url: normalizeJoybuyUrl(rawUrl),
    title: title || null,
    price,
    list_price: listPrice,
    promo_price: promoPrice,
    availability,
    captured_at: capturedAt
  };
}

function structuredNumber(html, keys) {
  for (const key of keys) {
    const patterns = [
      new RegExp(`"${key}"\\s*:\\s*"?([0-9]+(?:\\.[0-9]+)?)"?`, "i"),
      new RegExp(`\\\\\\"${key}\\\\\\"\\s*:\\s*\\\\\\"?([0-9]+(?:\\.[0-9]+)?)`, "i")
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      const value = Number(match?.[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

function cleanId(value) {
  return decodeURIComponent(value).replace(/\.html$/i, "").trim();
}

function firstText(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripHtml(match[1]).trim();
  }
  return null;
}

function firstPrice(html) {
  const candidates = [...html.matchAll(/€\s*\d{1,3}(?:[.\s]\d{3})*[,.]\d{2}(?!\d)|\d{1,3}(?:[.\s]\d{3})*[,.]\d{2}(?!\d)\s*€/g)]
    .map((match) => parsePriceText(match[0]))
    .filter((value) => value !== null);
  return candidates.length ? candidates[0] : null;
}

function labeledPrice(html, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*:?\\s*(?:<[^>]+>\\s*){0,4}([^<\\n]{0,40}(?:€\\s*)?\\d[\\d.\\s]*,\\d{2}\\s*(?:€)?)`, "i");
    const match = html.match(pattern);
    const price = parsePriceText(match?.[1] ?? "");
    if (price !== null) return price;
  }
  return null;
}

function availabilityFromHtml(html) {
  const text = stripHtml(html).toLowerCase();
  if (/(nicht verfügbar|ausverkauft|out of stock|currently unavailable)/i.test(text)) return "out_of_stock";
  if (/(lieferung bis|auf lager|in stock|verfügbar|available)/i.test(text)) return "in_stock";
  return "unknown";
}

function stripHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
