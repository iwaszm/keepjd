const API_BASE_URL = "https://joybuy-price-history.zhangmeng43.workers.dev";
const ROOT_ID = "joybuy-price-history-tracker-root";
const RANGES = ["30d", "90d"];
const RANGE_DAYS = {
  "30d": 30,
  "90d": 90
};
const MAX_BOOT_ATTEMPTS = 20;
const MANUAL_CAPTURE_DELAY_MS = 1000;
const MANUAL_CAPTURE_LIMIT = 20;
const OBSERVE_BATCH_URL = `${API_BASE_URL}/products/observe-batch`;
const observedListingKeys = new Set();
const state = {
  activeRange: "30d",
  href: "",
  lastProductId: "",
  syncTimer: 0,
  captureTimer: 0,
  captureInFlight: false,
  rangeMins: Object.fromEntries(RANGES.map((range) => [range, null]))
};

boot();
installUrlChangeHooks();
observePageChanges();
window.setInterval(() => scheduleSync("interval"), 1500);
window.setTimeout(() => scheduleManualListingCapture("boot"), MANUAL_CAPTURE_DELAY_MS);

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
  if (!joybuyProductId) return null;

  return {
    joybuy_product_id: joybuyProductId
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
          <span>Latest</span>
          <strong data-latest-price>--</strong>
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
  const hrefChanged = location.href !== state.href;

  state.href = location.href;
  state.lastProductId = snapshot.joybuy_product_id;

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
      state.rangeMins[range] = minimumPrice(expandDailyPricePoints(data.prices || [], range));
      updateRangeButtons(root);
    } catch {}
  }));
}

function minimumPrice(points) {
  const prices = points.map((point) => Number(point.price)).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : null;
}
function updatePanelMeta(root, snapshot) {
  updateRangeButtons(root);
}

function observePageChanges() {
  const observer = new MutationObserver(() => {
    scheduleSync("mutation");
    scheduleManualListingCapture("mutation");
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function installUrlChangeHooks() {
  window.addEventListener("popstate", () => {
    scheduleSync("popstate");
    scheduleManualListingCapture("popstate");
  });
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      scheduleSync(method);
      scheduleManualListingCapture(method);
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

function scheduleManualListingCapture(_reason) {
  window.clearTimeout(state.captureTimer);
  state.captureTimer = window.setTimeout(() => {
    captureManualListingObservations();
  }, MANUAL_CAPTURE_DELAY_MS);
}

async function captureManualListingObservations() {
  if (state.captureInFlight || !window.JoybuyListingParser) return;
  state.captureInFlight = true;

  try {
    const observations = window.JoybuyListingParser
      .extractSearchPageObservations(document.documentElement.outerHTML, captureDate())
      .slice(0, MANUAL_CAPTURE_LIMIT)
      .filter((observation) => {
        const key = `${observation.joybuy_product_id}:${observation.price}:${observation.availability}:${observation.captured_at}`;
        if (observedListingKeys.has(key)) return false;
        observedListingKeys.add(key);
        return true;
      });

    if (!observations.length) return;
    const response = await fetch(OBSERVE_BATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ observations })
    });
    if (!response.ok) throw new Error(`observe batch failed: ${response.status}`);
  } catch (error) {
    console.warn("Joybuy manual listing capture failed", error);
  } finally {
    state.captureInFlight = false;
  }
}

async function loadAndRender(root, joybuyProductId, range) {
  setStatus(root, "Loading...");
  try {
    const response = await fetch(`${API_BASE_URL}/products/${encodeURIComponent(joybuyProductId)}/prices?range=${range}`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    const prices = expandDailyPricePoints(data.prices || [], range);
    state.rangeMins[range] = minimumPrice(prices);
    updateRangeButtons(root);
    updateLatestHistoryPrice(root, prices);
    renderChart(root.querySelector("[data-chart]"), prices);
    setStatus(root, prices.length ? "" : "No data");
  } catch {
    updateLatestHistoryPrice(root, []);
    renderChart(root.querySelector("[data-chart]"), []);
    setStatus(root, "Unavailable");
  }
}

function updateLatestHistoryPrice(root, points) {
  const priceNode = root.querySelector("[data-latest-price]");
  if (!priceNode) return;

  const latestPoint = [...points].reverse().find((point) => Number.isFinite(Number(point.price)));
  priceNode.textContent = latestPoint ? formatEuro(latestPoint.price) : "--";
}

function expandDailyPricePoints(points, range) {
  const validPoints = points
    .filter((point) => Number.isFinite(Number(point.price)) && parseDateOnly(point.captured_at))
    .sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
  if (!validPoints.length) return [];

  const today = dateOnly(new Date());
  const since = addDays(today, -(RANGE_DAYS[range] ?? RANGE_DAYS["30d"]));
  let activePointIndex = 0;
  let activePoint = null;
  const expanded = [];

  for (let cursor = since; cursor <= today; cursor = addDays(cursor, 1)) {
    while (
      activePointIndex < validPoints.length
      && String(validPoints[activePointIndex].captured_at).slice(0, 10) <= cursor
    ) {
      activePoint = validPoints[activePointIndex];
      activePointIndex += 1;
    }

    if (activePoint) {
      expanded.push({
        ...activePoint,
        price: Number(activePoint.price),
        captured_at: cursor,
        carried_forward: String(activePoint.captured_at).slice(0, 10) !== cursor
      });
    }
  }

  return expanded;
}

function renderChart(container, points) {
  const validPoints = points.filter((point) => Number.isFinite(Number(point.price)));
  if (!validPoints.length) {
    container.innerHTML = `<div class="jbph-empty">No tracked history yet.</div>`;
    return;
  }

  const width = 640;
  const height = 170;
  const pad = { top: 16, right: 18, bottom: 34, left: 36 };
  const prices = validPoints.map((point) => Number(point.price));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(max - min, 1);
  const coords = validPoints.map((point, index) => {
    const x = pad.left + (index / Math.max(validPoints.length - 1, 1)) * (width - pad.left - pad.right);
    const y = pad.top + ((max - Number(point.price)) / span) * (height - pad.top - pad.bottom);
    return { x, y, point };
  });
  const segments = getStepSegments(coords, pad, width);
  const xLabels = getXAxisLabels(coords);

  container.innerHTML = `
    <svg class="jbph-svg" viewBox="0 0 ${width} ${height}" role="img">
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" />
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
      ${segments.map(({ d, outOfStock }) => `<path class="jbph-step-line${outOfStock ? " is-out-of-stock" : ""}" d="${d}" />`).join("")}
      ${coords.map(({ x, y, point }) => `<circle class="${isOutOfStock(point) ? "is-out-of-stock" : ""}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${new Date(point.captured_at).toLocaleDateString()} - ${formatEuro(point.price)}${isOutOfStock(point) ? " - out of stock" : ""}</title></circle>`).join("")}
      ${xLabels.map(({ x, label }) => `<text class="jbph-x-label" x="${x.toFixed(1)}" y="${height - 12}" text-anchor="middle">${label}</text>`).join("")}
    </svg>
  `;
}

function getStepSegments(coords, pad, width) {
  if (coords.length === 1) {
    const y = coords[0].y.toFixed(1);
    return [{
      d: `M ${pad.left} ${y} H ${width - pad.right}`,
      outOfStock: isOutOfStock(coords[0].point)
    }];
  }

  const segments = [];
  for (let index = 1; index < coords.length; index += 1) {
    const previous = coords[index - 1];
    const current = coords[index];
    segments.push({
      d: `M ${previous.x.toFixed(1)} ${previous.y.toFixed(1)} H ${current.x.toFixed(1)} V ${current.y.toFixed(1)}`,
      outOfStock: isOutOfStock(previous.point) || isOutOfStock(current.point)
    });
  }
  return segments;
}

function isOutOfStock(point) {
  return point?.availability === "out_of_stock";
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

function formatEuro(value) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(Number(value));
}

function formatDateMMDD(value) {
  const date = parseDateOnly(value);
  if (!date) return "";
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function parseDateOnly(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = parseDateOnly(dateText);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function captureDate() {
  return new Date().toISOString().slice(0, 10);
}
