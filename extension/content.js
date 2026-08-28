const API_BASE_URL = "https://joybuy-price-history.zhangmeng43.workers.dev";
const ROOT_ID = "joybuy-price-history-tracker-root";
const RANGES = ["30d", "90d"];
const MAX_BOOT_ATTEMPTS = 20;
const state = {
  activeRange: "30d",
  href: "",
  lastProductId: "",
  lastPrice: null,
  syncTimer: 0,
  rangeMins: Object.fromEntries(RANGES.map((range) => [range, null]))
};

boot();
installUrlChangeHooks();
observePageChanges();
window.setInterval(() => scheduleSync("interval"), 1500);

function boot(attempt = 0) {
  if (!isProductPageCandidate()) {
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
    price
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
  const height = 170;
  const pad = { top: 16, right: 18, bottom: 34, left: 36 };
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
  const xLabels = getXAxisLabels(coords);

  container.innerHTML = `
    <svg class="jbph-svg" viewBox="0 0 ${width} ${height}" role="img">
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" />
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
      <polyline points="${line}" />
      ${coords.map(({ x, y, point }) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${new Date(point.captured_at).toLocaleDateString()} - ${formatEuro(point.price)}</title></circle>`).join("")}
      ${xLabels.map(({ x, label }) => `<text class="jbph-x-label" x="${x.toFixed(1)}" y="${height - 12}" text-anchor="middle">${label}</text>`).join("")}
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

function extractFirstEuroPrice(value) {
  const text = String(value || "").replace(/\u00a0/g, " ");
  const match = text.match(/€\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)|(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)\s*€/);
  if (!match) return null;
  const integerPart = match[1] || match[4];
  const decimal = match[3] || match[6];
  const price = Number(`${integerPart.replace(/[.\s]/g, "")}.${decimal}`);
  return Number.isFinite(price) ? price : null;
}

function formatEuro(value) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(Number(value));
}

function formatDateMMDD(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}
