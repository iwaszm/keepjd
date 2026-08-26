import { TRACKED_PRODUCTS } from "./tracked-products.js";

const API_BASE_URL = "https://joybuy-price-history.zhangmeng43.workers.dev";
const ALARM_NAME = "joybuy-daily-price-collection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  collectTrackedProducts();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 5, periodInMinutes: 24 * 60 });
  collectTrackedProducts();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) collectTrackedProducts();
});

async function collectTrackedProducts() {
  for (const item of TRACKED_PRODUCTS) {
    try {
      const response = await fetch(item.url, {
        credentials: "include",
        cache: "no-store"
      });
      const html = await response.text();
      const snapshot = extractSnapshotFromHtml(html, response.url || item.url);
      if (!snapshot) continue;

      await fetch(`${API_BASE_URL}/products/observe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot)
      });
    } catch {
      // Collection is best effort; the next alarm or page visit can try again.
    }
  }
}

function extractSnapshotFromHtml(html, rawUrl) {
  if (/Joybuy Risk Control|notFound_container|not-found/i.test(html)) return null;

  const joybuyProductId = extractProductId(rawUrl, html);
  const price = extractBestPrice(html);
  if (!joybuyProductId || price === null) return null;

  return {
    joybuy_product_id: joybuyProductId,
    url: canonicalUrl(rawUrl),
    title: null,
    price,
    list_price: extractStructuredNumber(html, ["originPrice", "listPrice", "marketPrice", "retailPrice"]),
    promo_price: extractStructuredNumber(html, ["promotionPrice", "promoPrice", "salePrice"]),
    availability: /nicht verfügbar|ausverkauft|out of stock|currently unavailable/i.test(html) ? "out_of_stock" : "in_stock",
    captured_at: new Date().toISOString().slice(0, 10)
  };
}

function extractBestPrice(html) {
  return (
    extractStructuredNumber(html, ["promotionPrice", "promoPrice", "salePrice", "jdPrice", "price"]) ??
    extractVisibleEuroPrice(html)
  );
}

function extractStructuredNumber(html, keys) {
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

function extractVisibleEuroPrice(html) {
  const text = stripHtml(html);
  const matches = [...text.matchAll(/€\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)|(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)\s*€/g)];
  for (const match of matches) {
    const integerPart = match[1] || match[4];
    const decimal = match[3] || match[6];
    const value = Number(`${integerPart.replace(/[.\s]/g, "")}.${decimal}`);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function extractProductId(rawUrl, html) {
  const patterns = [
    /\/dp\/(?:[^/?#]+\/)?([^/?#]+)/i,
    /[?&](?:sku|skuid|skuId|productId|wareId|itemId|id)=([^&#]+)/i,
    /"skuId"\s*:\s*"([^"]+)"/i,
    /"productId"\s*:\s*"([^"]+)"/i,
    /data-(?:sku|product-id|ware-id)=["']([^"']+)["']/i
  ];
  for (const pattern of patterns) {
    const match = `${rawUrl}\n${html}`.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]).replace(/\.html$/i, "").trim();
  }
  return null;
}

function extractTitle(html) {
  const match =
    html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i) ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match?.[1] ? stripHtml(match[1]).trim() : null;
}

function canonicalUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = "";
  return url.toString();
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
