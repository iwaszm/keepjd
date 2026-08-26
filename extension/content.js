const API_BASE_URL = "https://joybuy-price-history.zhangmeng43.workers.dev";
const ROOT_ID = "joybuy-price-history-tracker-root";
const RANGES = ["30d", "90d"];
const MAX_BOOT_ATTEMPTS = 20;
const SCRIPT_CAPTURE_LIMIT = 200;
const SCRIPT_CAPTURE_DELAY_MS = 700;
const PASSIVE_CAPTURE_INTERVAL_MS = 5000;
const TRACKED_PRODUCT_IDS = new Set([
  "101322517",
  "10286300",
  "100946343",
  "10372137",
  "100736603",
  "102744800",
  "102744790",
  "10328909",
  "10382745",
  "10468517",
  "102395532"
]);
const observedProductIds = new Set();
const observedScriptPriceKeys = new Set();
const state = {
  activeRange: "30d",
  href: "",
  lastProductId: "",
  lastPrice: null,
  syncTimer: 0,
  scriptCaptureTimer: 0,
  scriptCaptureInFlight: false,
  rangeMins: Object.fromEntries(RANGES.map((range) => [range, null]))
};

boot();
installUrlChangeHooks();
observePageChanges();
window.setInterval(() => scheduleSync("interval"), 1500);
window.setInterval(() => scheduleScriptPriceCapture(null), PASSIVE_CAPTURE_INTERVAL_MS);
window.setTimeout(() => scheduleScriptPriceCapture(null), SCRIPT_CAPTURE_DELAY_MS);

function boot(attempt = 0) {
  if (!isProductPageCandidate()) {
    scheduleScriptPriceCapture(null);
    if (attempt < 3) window.setTimeout(() => boot(attempt + 1), 500);
    return;
  }
  const didSync = syncPanel();
  if (!didSync && attempt < MAX_BOOT_ATTEMPTS) {
    window.setTimeout(() => boot(attempt + 1), 500);
  }
}

function isProductPageCandidate() {
  if (/^\/(?:$|cms\/|campaign\/|marketing\/|search|category)/i.test(location.pathname)) return false;
  if (/\/(?:product|item|p|dp)(?:\/|$)/i.test(location.pathname)) return true;
  if (/[?&](?:sku|skuid|skuId|productId|wareId|itemId|id)=/i.test(location.search)) return true;
  return Boolean(document.querySelector("[data-sku], [data-product-id], [data-ware-id]"));
}

function extractSnapshotFromPage() {
  const joybuyProductId = extractProductId(location.href, document.documentElement.innerHTML);
  const price = extractVisiblePrice();
  if (!joybuyProductId) return null;

  return {
    joybuy_product_id: joybuyProductId,
    title: null,
    price,
    list_price: extractLabeledPrice(["UVP", "RRP", "WAS"]),
    promo_price: extractLabeledPrice(["Willkommensangebot", "Blitzangebot", "Promo", "Angebot"]),
    availability: extractAvailability(),
    captured_at: captureDate()
  };
}

function injectPanel(snapshot) {
  const existing = document.getElementById(ROOT_ID);
  if (existing) return existing;

  const root = document.createElement("section");
  root.id = ROOT_ID;
  root.addEventListener("click", stopPageEvent);
  root.addEventListener("pointerdown", stopPageEvent);
  root.addEventListener("mousedown", stopPageEvent);
  root.addEventListener("touchstart", stopPageEvent);
  root.innerHTML = `
    <div class="jbph-shell">
      <div class="jbph-top">
        <div class="jbph-now">
          <span>Now</span>
          <strong data-current-price>${snapshot.price === null ? "--" : formatEuro(snapshot.price)}</strong>
        </div>
        <div class="jbph-toolbar" role="tablist" aria-label="Price history range">
          ${RANGES.map((range) => renderRangeButton(range)).join("")}
        </div>
      </div>
      <div class="jbph-status" data-status>Loading...</div>
      <div class="jbph-chart" data-chart aria-label="Joybuy price history chart"></div>
    </div>
  `;

  document.body.appendChild(root);

  root.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", (event) => {
      stopPageEvent(event);
      root.querySelectorAll("[data-range]").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      state.activeRange = button.dataset.range;
      loadAndRender(root, state.lastProductId || snapshot.joybuy_product_id, state.activeRange);
    });
  });

  return root;
}

function syncPanel() {
  if (!isProductPageCandidate()) return false;
  const snapshot = extractSnapshotFromPage();
  if (!snapshot) return false;

  const root = injectPanel(snapshot);
  const productChanged = snapshot.joybuy_product_id !== state.lastProductId;
  const priceChanged = snapshot.price !== state.lastPrice;
  const hrefChanged = location.href !== state.href;

  state.href = location.href;
  state.lastProductId = snapshot.joybuy_product_id;
  state.lastPrice = snapshot.price;

  updatePanelMeta(root, snapshot);

  if (productChanged || hrefChanged) {
    state.rangeMins = Object.fromEntries(RANGES.map((range) => [range, null]));
    updateRangeButtons(root);
    renderChart(root.querySelector("[data-chart]"), []);
    loadAndRender(root, snapshot.joybuy_product_id, state.activeRange);
    loadRangeMinimums(root, snapshot.joybuy_product_id);
  }

  if (priceChanged || productChanged) {
    maybeObserveTrackedProduct(root, snapshot);
  }

  if (priceChanged || productChanged || hrefChanged) {
    scheduleScriptPriceCapture(root);
  }

  return true;
}

function renderRangeButton(range) {
  const days = range.replace("d", "");
  const min = state.rangeMins[range];
  return `<button type="button" data-range="${range}" class="${range === state.activeRange ? "is-active" : ""}"><span>${days}</span><small data-range-min="${range}">${min === null ? "Low --" : `Low ${formatEuro(min)}`}</small></button>`;
}

function updateRangeButtons(root) {
  root.querySelectorAll("[data-range]").forEach((button) => {
    const range = button.dataset.range;
    const min = state.rangeMins[range];
    button.classList.toggle("is-active", range === state.activeRange);
    const minNode = button.querySelector("[data-range-min]");
    if (minNode) minNode.textContent = min === null ? "Low --" : `Low ${formatEuro(min)}`;
  });
}

async function loadRangeMinimums(root, joybuyProductId) {
  await Promise.all(RANGES.map(async (range) => {
    try {
      const response = await fetch(`${API_BASE_URL}/products/${encodeURIComponent(joybuyProductId)}/prices?range=${range}`);
      if (!response.ok) return;
      const data = await response.json();
      state.rangeMins[range] = minimumPrice(data.prices || []);
      updateRangeButtons(root);
    } catch {}
  }));
}

function minimumPrice(points) {
  const prices = points.map((point) => Number(point.price)).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : null;
}
function updatePanelMeta(root, snapshot) {
  const priceNode = root.querySelector("[data-current-price]");
  if (priceNode) priceNode.textContent = snapshot.price === null ? "--" : formatEuro(snapshot.price);

  updateRangeButtons(root);
}

function maybeObserveTrackedProduct(root, snapshot) {
  if (snapshot.price !== null && TRACKED_PRODUCT_IDS.has(snapshot.joybuy_product_id) && !observedProductIds.has(snapshot.joybuy_product_id)) {
    observedProductIds.add(snapshot.joybuy_product_id);
    postObservation({ ...snapshot, captured_at: captureDate() }).then(() => {
      loadAndRender(root, snapshot.joybuy_product_id, state.activeRange);
    }).catch(() => {});
  }
}

function scheduleScriptPriceCapture(root) {
  window.clearTimeout(state.scriptCaptureTimer);
  state.scriptCaptureTimer = window.setTimeout(() => {
    captureScriptPriceObservations(root);
  }, SCRIPT_CAPTURE_DELAY_MS);
}

async function captureScriptPriceObservations(root) {
  if (state.scriptCaptureInFlight) return;
  state.scriptCaptureInFlight = true;

  try {
    const observations = extractScriptPriceObservations();
    let shouldRefreshCurrentChart = false;

    for (const observation of observations) {
      const key = `${observation.joybuy_product_id}:${observation.price}`;
      if (observedScriptPriceKeys.has(key)) continue;

      observedScriptPriceKeys.add(key);
      try {
        await postObservation(observation);
        shouldRefreshCurrentChart ||= observation.joybuy_product_id === state.lastProductId;
      } catch {
        observedScriptPriceKeys.delete(key);
      }
    }

    if (root && shouldRefreshCurrentChart && state.lastProductId) {
      loadAndRender(root, state.lastProductId, state.activeRange);
    }
  } finally {
    state.scriptCaptureInFlight = false;
  }
}
async function postObservation(snapshot) {
  await fetch(`${API_BASE_URL}/products/observe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot)
  });
}

function observePageChanges() {
  const observer = new MutationObserver(() => {
    scheduleSync("mutation");
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function installUrlChangeHooks() {
  window.addEventListener("popstate", () => scheduleSync("popstate"));
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      scheduleSync(method);
      return result;
    };
  }
}

function scheduleSync(_reason) {
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => {
    if (!document.getElementById(ROOT_ID) && !isProductPageCandidate()) return;
    syncPanel();
  }, 150);
}

function stopPageEvent(event) {
  event.stopPropagation();
}

async function loadAndRender(root, joybuyProductId, range) {
  setStatus(root, "Loading...");
  try {
    const response = await fetch(`${API_BASE_URL}/products/${encodeURIComponent(joybuyProductId)}/prices?range=${range}`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    const prices = data.prices || [];
    state.rangeMins[range] = minimumPrice(prices);
    updateRangeButtons(root);
    renderChart(root.querySelector("[data-chart]"), prices);
    setStatus(root, prices.length ? "" : "No data");
  } catch {
    renderChart(root.querySelector("[data-chart]"), []);
    setStatus(root, "Unavailable");
  }
}

function renderChart(container, points) {
  if (!points.length) {
    container.innerHTML = `<div class="jbph-empty">No captured prices</div>`;
    return;
  }

  const width = 640;
  const height = 220;
  const pad = { top: 18, right: 18, bottom: 42, left: 48 };
  const prices = points.map((point) => Number(point.price)).filter(Number.isFinite);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(max - min, 1);
  const coords = points.map((point, index) => {
    const x = pad.left + (index / Math.max(points.length - 1, 1)) * (width - pad.left - pad.right);
    const y = pad.top + ((max - Number(point.price)) / span) * (height - pad.top - pad.bottom);
    return { x, y, point };
  });
  const line = coords.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords.at(-1);
  const xLabels = getXAxisLabels(coords);
  const axisY = height - pad.bottom;

  container.innerHTML = `
    <svg class="jbph-svg" viewBox="0 0 ${width} ${height}" role="img">
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" />
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
      <text x="${pad.left}" y="14">${formatEuro(max)}</text>
      <text x="${pad.left}" y="${axisY - 4}">${formatEuro(min)}</text>
      <polyline points="${line}" />
      ${coords.map(({ x, y, point }) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${new Date(point.captured_at).toLocaleDateString()} - ${formatEuro(point.price)}</title></circle>`).join("")}
      ${xLabels.map(({ x, label }) => `<text class="jbph-x-label" x="${x.toFixed(1)}" y="${height - 12}" text-anchor="middle">${label}</text>`).join("")}
      <text class="jbph-last" x="${Math.min(last.x + 8, width - 110)}" y="${Math.max(last.y - 8, 18)}">${formatEuro(last.point.price)}</text>
    </svg>
  `;
}

function getXAxisLabels(coords) {
  if (coords.length <= 1) {
    return coords.map(({ x, point }) => ({ x, label: formatDateMMDD(point.captured_at) }));
  }

  const indexes = new Set([0, coords.length - 1]);
  if (coords.length >= 4) indexes.add(Math.floor((coords.length - 1) / 2));
  if (coords.length >= 10) {
    indexes.add(Math.floor((coords.length - 1) / 3));
    indexes.add(Math.floor(((coords.length - 1) * 2) / 3));
  }

  return [...indexes].sort((a, b) => a - b).map((index) => {
    const coord = coords[index];
    return { x: coord.x, label: formatDateMMDD(coord.point.captured_at) };
  });
}
function setStatus(root, message) {
  const status = root.querySelector("[data-status]");
  status.textContent = message;
  status.hidden = !message;
}

function extractProductId(rawUrl, html) {
  const patterns = [
    /\/dp\/(?:[^/?#]+\/)?([^/?#]+)/i,
    /\/(?:product|item|p|dp)\/([^/?#]+)/i,
    /[?&](?:sku|skuid|skuId|productId|wareId|itemId|id)=([^&#]+)/i,
    /\/([A-Za-z0-9_-]{8,})(?:[/?#]|$)/,
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

function extractScriptPriceObservations() {
  const found = new Map();
  const capturedAt = captureDate();
  const scripts = [...document.scripts]
    .map((script) => script.textContent || "")
    .filter((text) => /self\.__next_[sf]|\/dp\/|skuId|productId|wareId|price/i.test(text));

  for (const scriptText of scripts) {
    const text = normalizeScriptText(scriptText);
    collectPricesFromProductUrls(text, found, capturedAt);
    collectPricesFromStructuredIds(text, found, capturedAt);
    if (found.size >= SCRIPT_CAPTURE_LIMIT) break;
  }

  return [...found.values()].slice(0, SCRIPT_CAPTURE_LIMIT);
}

function collectPricesFromProductUrls(text, found, capturedAt) {
  const productUrlPattern = /(?:https?:\/\/(?:www\.)?joybuy\.de)?(\/dp\/(?:[^"'<>\\\s]+\/)?([A-Za-z0-9_-]{5,}))(?:\?[^"'<>\\\s]*)?/gi;
  let match;
  while ((match = productUrlPattern.exec(text)) && found.size < SCRIPT_CAPTURE_LIMIT) {
    const id = cleanProductId(match[2]);
    if (!id || found.has(id)) continue;

    const windowText = surroundingText(text, match.index, 1400, 2600);
    const price = extractPriceFromScriptWindow(windowText);
    if (!isPlausibleProductPrice(price)) continue;

    found.set(id, {
      joybuy_product_id: id,
      title: null,
      price,
      list_price: null,
      promo_price: null,
      availability: extractAvailabilityFromText(windowText),
      captured_at: capturedAt
    });
  }
}

function collectPricesFromStructuredIds(text, found, capturedAt) {
  const idPattern = /["']?(?:skuId|sku|productId|wareId|itemId)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{5,})["']?/gi;
  let match;
  while ((match = idPattern.exec(text)) && found.size < SCRIPT_CAPTURE_LIMIT) {
    const id = cleanProductId(match[1]);
    if (!id || found.has(id)) continue;

    const windowText = surroundingText(text, match.index, 1600, 2600);
    const price = extractPriceFromScriptWindow(windowText);
    if (!isPlausibleProductPrice(price)) continue;

    found.set(id, {
      joybuy_product_id: id,
      title: null,
      price,
      list_price: null,
      promo_price: null,
      availability: extractAvailabilityFromText(windowText),
      captured_at: capturedAt
    });
  }
}

function extractPriceFromScriptWindow(text) {
  const preferredKeys = [
    "promotionPrice",
    "promoPrice",
    "salePrice",
    "skuPrice",
    "realPrice",
    "currentPrice",
    "displayPrice",
    "jdPrice",
    "price"
  ];

  for (const key of preferredKeys) {
    const pattern = new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']?(?:€\\s*)?([0-9]{1,5}(?:[.,][0-9]{1,2})?)`, "i");
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const price = Number(match[1].replace(",", "."));
    if (isPlausibleProductPrice(price)) return price;
  }

  return extractFirstEuroPrice(text);
}

function extractScriptTitle(text) {
  const match = text.match(/["']?(?:skuName|productName|title|name)["']?\s*[:=]\s*["']([^"']{3,180})["']/i);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() : "";
}

function extractAvailabilityFromText(text) {
  const normalized = text.toLowerCase();
  if (/nicht verfügbar|ausverkauft|out[_\s-]?of[_\s-]?stock|unavailable/.test(normalized)) return "out_of_stock";
  if (/auf lager|in[_\s-]?stock|available|verfügbar/.test(normalized)) return "in_stock";
  return "unknown";
}

function normalizeScriptText(text) {
  return String(text || "")
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

function cleanProductId(value) {
  const match = String(value || "").match(/[A-Za-z0-9_-]{5,}/);
  return match ? match[0].replace(/\.html$/i, "") : "";
}

function absoluteJoybuyUrl(path, id) {
  try {
    const url = new URL(path, location.origin);
    url.hash = "";
    return url.toString();
  } catch {
    return `https://www.joybuy.de/dp/${encodeURIComponent(id)}`;
  }
}
function extractVisiblePrice() {
  const primaryPrice = findPriceInSelectors([
    "[class*='skuPriceReal' i]",
    "[class*='mainPriceText_wrapper' i]",
    "[class*='mainPrice__' i]"
  ]);
  if (primaryPrice !== null) return primaryPrice;

  return findPriceInSelectors([
    "[class*='price' i]",
    "[class*='amount' i]",
    "[data-testid*='price' i]",
    "[data-price]",
    "meta[property='product:price:amount']"
  ]) ?? extractFirstEuroPrice(document.body.innerText);
}

function findPriceInSelectors(selectors) {
  const priceNodes = [...document.querySelectorAll(selectors.join(", "))];
  for (const node of priceNodes) {
    if (node.closest(`#${ROOT_ID}`)) continue;
    const value = node.content || node.dataset?.price || node.textContent;
    const price = extractFirstEuroPrice(value);
    if (isPlausibleProductPrice(price)) return price;
  }
  return null;
}

function isPlausibleProductPrice(price) {
  return typeof price === "number" && Number.isFinite(price) && price >= 0.1 && price <= 10000;
}

function extractLabeledPrice(labels) {
  const text = document.body.innerText;
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*:?\\s*(.{0,40}?(?:€\\s*\\d[\\d.\\s]*[,.]\\d{2}|\\d[\\d.\\s]*[,.]\\d{2}\\s*€))`, "i");
    const price = extractFirstEuroPrice(text.match(pattern)?.[1] || "");
    if (price !== null) return price;
  }
  return null;
}

function extractFirstEuroPrice(value) {
  const text = String(value || "").replace(/\u00a0/g, " ");
  const match = text.match(/€\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)|(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)\s*€/);
  if (!match) return null;
  const integerPart = match[1] || match[4];
  const decimal = match[3] || match[6];
  const price = Number(`${integerPart.replace(/[.\s]/g, "")}.${decimal}`);
  return Number.isFinite(price) ? price : null;
}

function extractTitle() {
  return document.querySelector("h1")?.textContent?.trim() || document.title.replace(/\s*\|\s*Joybuy.*/i, "").trim();
}

function canonicalUrl() {
  const canonical = document.querySelector("link[rel='canonical']")?.href || location.href;
  const url = new URL(canonical);
  url.hash = "";
  return url.toString();
}

function extractAvailability() {
  const text = document.body.innerText.toLowerCase();
  if (/nicht verfügbar|ausverkauft|out of stock|currently unavailable/.test(text)) return "out_of_stock";
  if (/lieferung bis|auf lager|in stock|verfügbar|available/.test(text)) return "in_stock";
  return "unknown";
}

function formatEuro(value) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(Number(value));
}

function captureDate() {
  return new Date().toISOString().slice(0, 10);
}
function formatDateMMDD(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
