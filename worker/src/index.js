import { TARGET_PAGES as DEFAULT_TARGET_PAGES } from "../../background-extension/target-pages.js";
import {
  buildPageUrl,
  extractMaxPageNumber,
  extractPageCountNumber,
  extractSearchPageObservations,
  pageNumberFromSeed
} from "../../background-extension/parser.js";
import { fetchSearchPageHtml } from "../../background-extension/stream-fetch.js";
import { extractProductSnapshotFromHtml } from "../../shared/joybuy-parser.js";

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90
};
const DEFAULT_COLLECTOR_MAX_PAGES = 5000;
const DEFAULT_COLLECTOR_CONCURRENCY = 8;
const DEFAULT_COLLECTOR_BATCH_SIZE = 500;
const DEFAULT_COLLECTOR_FETCH_TIMEOUT_MS = 20000;
const COLLECTOR_USER_AGENT = "JoybuyPriceHistoryBot/0.2 (+https://example.invalid/joybuy-price-history)";

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCollector(env));
  }
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "joybuy-price-history" });
  }

  if (request.method === "GET" && url.pathname === "/products/missing-price-points") {
    return getProductsMissingPricePoints(env.DB, url.searchParams.get("limit"));
  }

  const pricesMatch = url.pathname.match(/^\/products\/([^/]+)\/prices$/);
  if (request.method === "GET" && pricesMatch) {
    return getPrices(env.DB, decodeURIComponent(pricesMatch[1]), url.searchParams.get("range") || "30d");
  }

  if (request.method === "POST" && url.pathname === "/products/observe") {
    return observeProduct(request, env.DB);
  }

  if (request.method === "POST" && url.pathname === "/products/observe-batch") {
    return observeProductsBatch(request, env.DB);
  }

  if (request.method === "POST" && url.pathname === "/collector/target-summary") {
    return recordCollectorTargetSummary(request, env.DB);
  }

  if (request.method === "GET" && url.pathname === "/collector/targets/latest") {
    return getLatestCollectorTargetStats(env.DB);
  }

  return json({ error: "Not found" }, 404);
}

async function getProductsMissingPricePoints(db, limitParam) {
  const limit = clampLimit(limitParam, 10000);
  const { results } = await db
    .prepare(
      `SELECT p.joybuy_product_id
       FROM products p
       LEFT JOIN price_points pp ON pp.product_id = p.id
       WHERE pp.id IS NULL
       ORDER BY p.id ASC
       LIMIT ?`
    )
    .bind(limit)
    .all();

  const joybuyProductIds = (results || []).map((row) => row.joybuy_product_id).filter(Boolean);
  return json({ ok: true, count: joybuyProductIds.length, joybuy_product_ids: joybuyProductIds });
}

async function getPrices(db, joybuyProductId, range) {
  const days = RANGE_DAYS[range] ?? RANGE_DAYS["30d"];
  const since = toCaptureDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  const product = await db
    .prepare("SELECT id, joybuy_product_id, url, title, created_at, updated_at FROM products WHERE joybuy_product_id = ?")
    .bind(joybuyProductId)
    .first();

  if (!product) {
    return json({ product: null, prices: [], range, currency: "EUR" });
  }

  const { results } = await db
    .prepare(
      `SELECT price, list_price, promo_price, availability, captured_at
       FROM price_points
       WHERE product_id = ?
         AND (
           captured_at >= ?
           OR captured_at = (
             SELECT MAX(captured_at)
             FROM price_points
             WHERE product_id = ? AND captured_at < ?
           )
         )
       ORDER BY captured_at ASC`
    )
    .bind(product.id, since, product.id, since)
    .all();

  return json({ product, prices: results ?? [], range, currency: "EUR" });
}

async function observeProduct(request, db) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const validationError = validateObservation(payload);
  if (validationError) return json({ error: validationError }, 400);

  const product = await upsertProduct(db, payload);
  const inserted = await maybeInsertPricePoint(db, product.id, payload);

  return json({ product, inserted });
}

async function observeProductsBatch(request, db) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const observations = Array.isArray(payload) ? payload : payload?.observations;
  if (!Array.isArray(observations)) return json({ error: "observations must be an array" }, 400);
  if (observations.length > 500) return json({ error: "observations must contain at most 500 items" }, 400);

  const results = [];
  for (const observation of observations) {
    const validationError = validateObservation(observation);
    if (validationError) {
      results.push({ ok: false, error: validationError, joybuy_product_id: observation?.joybuy_product_id ?? null });
      continue;
    }

    try {
      const product = await upsertProduct(db, observation);
      const inserted = await maybeInsertPricePoint(db, product.id, observation);
      results.push({ ok: true, joybuy_product_id: observation.joybuy_product_id, inserted });
    } catch (error) {
      results.push({ ok: false, error: error.message, joybuy_product_id: observation.joybuy_product_id });
    }
  }

  const inserted = results.filter((result) => result.ok && result.inserted).length;
  const failed = results.filter((result) => !result.ok).length;
  return json({ ok: failed === 0, inserted, failed, results });
}

async function recordCollectorTargetSummary(request, db) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const validationError = validateTargetSummary(payload);
  if (validationError) return json({ error: validationError }, 400);

  await insertCollectorTargetStat(db, payload);
  return json({ ok: true });
}

async function getLatestCollectorTargetStats(db) {
  const { results } = await db
    .prepare(
      `SELECT s.*
       FROM collector_target_stats s
       JOIN (
         SELECT url, MAX(id) AS id
         FROM collector_target_stats
         GROUP BY url
       ) latest ON latest.id = s.id
       ORDER BY COALESCE(s.original_target_index, s.target_index, s.id), s.id`
    )
    .all();

  return json({ ok: true, targets: results || [] });
}

export async function runCollector(env) {
  const startedAt = new Date().toISOString();
  const runId = await createCollectorRun(env.DB, startedAt);
  const summary = {
    ok: true,
    run_id: runId,
    started_at: startedAt,
    finished_at: null,
    targets: 0,
    targets_done: 0,
    pages_fetched: 0,
    pages_failed: 0,
    observations_found: 0,
    observations_written: 0,
    observations_skipped: 0,
    stopped_reason: null,
    errors: []
  };

  try {
    const targetPages = loadCollectorTargetPages(env);
    if (targetPages.length) {
      await runListingPageCollector(env, targetPages, summary);
    } else {
      await runLegacyTrackedProductCollector(env, summary);
    }
  } catch (error) {
    summary.ok = false;
    summary.errors.push(error.message);
  } finally {
    summary.finished_at = new Date().toISOString();
    await finishCollectorRun(env.DB, runId, summary);
  }

  return summary;
}

async function runListingPageCollector(env, targetPages, summary) {
  const maxPagesPerRun = positiveInt(env.COLLECTOR_MAX_PAGES_PER_RUN, DEFAULT_COLLECTOR_MAX_PAGES);
  const concurrency = positiveInt(env.COLLECTOR_PAGE_CONCURRENCY, DEFAULT_COLLECTOR_CONCURRENCY);
  const batchSize = positiveInt(env.COLLECTOR_BATCH_SIZE, DEFAULT_COLLECTOR_BATCH_SIZE);
  const capturedAt = toCaptureDate(new Date().toISOString());
  let pagesRemaining = maxPagesPerRun;

  summary.targets = targetPages.length;

  for (let targetIndex = 0; targetIndex < targetPages.length && pagesRemaining > 0; targetIndex += 1) {
    const target = normalizeCollectorTarget(targetPages[targetIndex]);
    const targetSummary = {
      target_index: targetIndex + 1,
      label: target.label,
      url: target.url,
      pages_fetched: 0,
      pages_failed: 0,
      observations_found: 0,
      observations_written: 0,
      observations_skipped: 0,
      done_reason: null,
      last_page: null,
      last_error: null
    };

    try {
      const startPage = pageNumberFromSeed(target.url);
      let maxPage = target.maxPage ?? startPage;
      let nextPage = startPage;
      let detectedMaxPage = null;
      let detectedPageCount = null;
      let emptyPages = 0;
      const seen = new Set();

      while (nextPage <= maxPage && pagesRemaining > 0) {
        const pageNumbers = [];
        for (
          let pageNumber = nextPage;
          pageNumber <= maxPage && pageNumbers.length < concurrency && pagesRemaining - pageNumbers.length > 0;
          pageNumber += 1
        ) {
          pageNumbers.push(pageNumber);
        }

        const fetchedPages = await Promise.all(pageNumbers.map((pageNumber) => fetchListingPage(target.url, pageNumber, Boolean(target.maxPage))));
        for (const fetched of fetchedPages) {
          targetSummary.last_page = fetched.pageUrl;
          if (!fetched.ok) {
            targetSummary.pages_failed += 1;
            summary.pages_failed += 1;
            targetSummary.last_error = fetched.error;
            summary.errors.push(`${fetched.pageUrl}: ${fetched.error}`);
            continue;
          }

          pagesRemaining -= 1;
          targetSummary.pages_fetched += 1;
          summary.pages_fetched += 1;

          detectedMaxPage = extractMaxPageNumber(fetched.html) ?? detectedMaxPage;
          detectedPageCount = extractPageCountNumber(fetched.html) ?? detectedPageCount;
          if (detectedPageCount) {
            maxPage = detectedPageCount;
          }
          const observations = extractSearchPageObservations(fetched.html, capturedAt)
            .filter((observation) => !seen.has(observation.joybuy_product_id));

          for (const observation of observations) {
            seen.add(observation.joybuy_product_id);
          }

          targetSummary.observations_found += observations.length;
          summary.observations_found += observations.length;

          const writeResult = await writeChangedObservations(env.DB, observations, batchSize);
          targetSummary.observations_written += writeResult.written;
          targetSummary.observations_skipped += writeResult.skipped;
          summary.observations_written += writeResult.written;
          summary.observations_skipped += writeResult.skipped;

          emptyPages = observations.length ? 0 : emptyPages + 1;
          if (!target.maxPage && !detectedPageCount && detectedMaxPage) {
            maxPage = Math.max(maxPage, detectedMaxPage);
          }
          if (!target.maxPage && emptyPages >= 1) {
            targetSummary.done_reason = "empty_page_stop";
            break;
          }
        }

        if (targetSummary.done_reason) break;
        nextPage = pageNumbers.at(-1) + 1;
      }

      if (!targetSummary.done_reason) {
        targetSummary.done_reason = pagesRemaining <= 0 ? "run_page_limit_reached" : "max_page_reached";
      }
    } catch (error) {
      targetSummary.last_error = error.message;
      targetSummary.done_reason = "target_failed";
      summary.errors.push(`${target.url}: ${error.message}`);
    }

    summary.targets_done += 1;
    await recordCollectorRunItem(env.DB, summary.run_id, targetSummary);
  }

  summary.stopped_reason = pagesRemaining <= 0 ? "run_page_limit_reached" : "all_targets_done";
}

async function runLegacyTrackedProductCollector(env, summary) {
  const tracked = await loadTrackedProducts(env);
  summary.targets = tracked.length;

  for (const item of tracked) {
    const targetSummary = {
      target_index: summary.targets_done + 1,
      label: "legacy-product",
      url: item.url,
      pages_fetched: 0,
      pages_failed: 0,
      observations_found: 0,
      observations_written: 0,
      observations_skipped: 0,
      done_reason: null,
      last_page: item.url,
      last_error: null
    };

    try {
      const html = await fetchText(item.url);
      const snapshot = extractProductSnapshotFromHtml(html, item.url);
      targetSummary.pages_fetched = 1;
      summary.pages_fetched += 1;
      if (!snapshot) {
        targetSummary.done_reason = "parser_returned_null";
      } else {
        targetSummary.observations_found = 1;
        summary.observations_found += 1;
        const writeResult = await writeChangedObservations(env.DB, [snapshot], DEFAULT_COLLECTOR_BATCH_SIZE);
        targetSummary.observations_written = writeResult.written;
        targetSummary.observations_skipped = writeResult.skipped;
        summary.observations_written += writeResult.written;
        summary.observations_skipped += writeResult.skipped;
        targetSummary.done_reason = "ok";
      }
    } catch (error) {
      targetSummary.pages_failed = 1;
      targetSummary.last_error = error.message;
      targetSummary.done_reason = "target_failed";
      summary.pages_failed += 1;
      summary.errors.push(`${item.url}: ${error.message}`);
    }

    summary.targets_done += 1;
    await recordCollectorRunItem(env.DB, summary.run_id, targetSummary);
  }

  summary.stopped_reason = "legacy_targets_done";
}

function loadCollectorTargetPages(env) {
  if (env.TARGET_PAGES_JSON) {
    const parsed = JSON.parse(env.TARGET_PAGES_JSON);
    return Array.isArray(parsed) ? parsed : [];
  }
  return DEFAULT_TARGET_PAGES;
}

async function loadTrackedProducts(env) {
  if (env.TRACKED_PRODUCTS_JSON) {
    return JSON.parse(env.TRACKED_PRODUCTS_JSON);
  }
  return [];
}

function normalizeCollectorTarget(target) {
  if (typeof target === "string") return { url: target, label: "", maxPage: null };
  const maxPage = Number(target.maxPage);
  return {
    url: target.url,
    label: target.label || "",
    maxPage: Number.isInteger(maxPage) && maxPage > 0 ? maxPage : null
  };
}

async function fetchListingPage(seedUrl, pageNumber, allowEarlyAbort) {
  const pageUrl = buildPageUrl(seedUrl, pageNumber);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), DEFAULT_COLLECTOR_FETCH_TIMEOUT_MS);
  try {
    const page = await fetchSearchPageHtml(pageUrl, allowEarlyAbort, {
      headers: collectorRequestHeaders(),
      signal: controller.signal
    });
    return {
      ok: true,
      pageUrl,
      html: page.html,
      partialRead: page.partialRead,
      bytesRead: page.bytesRead
    };
  } catch (error) {
    return {
      ok: false,
      pageUrl,
      error: error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), DEFAULT_COLLECTOR_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: collectorRequestHeaders(),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function collectorRequestHeaders() {
  return {
    "user-agent": COLLECTOR_USER_AGENT,
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "de-DE,de;q=0.9,en;q=0.8"
  };
}

async function writeChangedObservations(db, observations, batchSize) {
  const unique = dedupeObservations(observations);
  let written = 0;
  let skipped = 0;

  for (let index = 0; index < unique.length; index += batchSize) {
    const chunk = unique.slice(index, index + batchSize);
    for (const observation of chunk) {
      if (await shouldWriteObservation(db, observation)) {
        const product = await upsertProduct(db, observation);
        await maybeInsertPricePoint(db, product.id, observation);
        written += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return { written, skipped };
}

function dedupeObservations(observations) {
  return [...new Map(observations.map((observation) => [observation.joybuy_product_id, observation])).values()];
}

async function shouldWriteObservation(db, observation) {
  const latest = await db
    .prepare(
      `SELECT pp.price, pp.availability, pp.captured_at
       FROM price_points pp
       JOIN products p ON p.id = pp.product_id
       WHERE p.joybuy_product_id = ?
       ORDER BY pp.captured_at DESC, pp.id DESC
       LIMIT 1`
    )
    .bind(observation.joybuy_product_id)
    .first();

  if (!latest) return true;
  if (latest.captured_at === toCaptureDate(observation.captured_at)) return true;
  return Number(latest.price) !== Number(observation.price)
    || normalizeAvailability(latest.availability) !== normalizeAvailability(observation.availability);
}

async function createCollectorRun(db, startedAt) {
  try {
    const result = await db
      .prepare("INSERT INTO collector_runs (started_at, status) VALUES (?, 'running')")
      .bind(startedAt)
      .run();
    return result.meta?.last_row_id ?? null;
  } catch {
    return null;
  }
}

async function finishCollectorRun(db, runId, summary) {
  if (!runId) return;
  try {
    await db
      .prepare(
        `UPDATE collector_runs
         SET finished_at = ?,
             status = ?,
             targets = ?,
             targets_done = ?,
             pages_fetched = ?,
             pages_failed = ?,
             observations_found = ?,
             observations_written = ?,
             observations_skipped = ?,
             stopped_reason = ?,
             error = ?
         WHERE id = ?`
      )
      .bind(
        summary.finished_at,
        summary.ok ? "ok" : "failed",
        summary.targets,
        summary.targets_done,
        summary.pages_fetched,
        summary.pages_failed,
        summary.observations_found,
        summary.observations_written,
        summary.observations_skipped,
        summary.stopped_reason,
        summary.errors.slice(0, 20).join("\n") || null,
        runId
      )
      .run();
  } catch {}
}

async function recordCollectorRunItem(db, runId, item) {
  if (!runId) return;
  try {
    await db
      .prepare(
        `INSERT INTO collector_run_items (
           run_id, target_index, label, url, pages_fetched, pages_failed,
           observations_found, observations_written, observations_skipped,
           done_reason, last_page, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        runId,
        item.target_index,
        item.label,
        item.url,
        item.pages_fetched,
        item.pages_failed,
        item.observations_found,
        item.observations_written,
        item.observations_skipped,
        item.done_reason,
        item.last_page,
        item.last_error
      )
      .run();
  } catch {}
}

async function insertCollectorTargetStat(db, item) {
  await db
    .prepare(
      `INSERT INTO collector_target_stats (
         run_started_at, run_finished_at, target_index, original_target_index,
         label, url, configured_max_page, latest_max_page, pages_fetched,
         zero_product_pages, forbidden_pages, items_found, posted, skipped,
         done_reason, last_page, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      item.run_started_at,
      item.run_finished_at || null,
      nullableInt(item.target_index),
      nullableInt(item.original_target_index),
      item.label || null,
      item.url,
      nullableInt(item.configured_max_page),
      nullableInt(item.latest_max_page),
      nonNegativeInt(item.pages_fetched),
      nonNegativeInt(item.zero_product_pages),
      nonNegativeInt(item.forbidden_pages),
      nonNegativeInt(item.items_found),
      nonNegativeInt(item.posted),
      nonNegativeInt(item.skipped),
      item.done_reason || null,
      item.last_page || null,
      item.last_error || null
    )
    .run();
}

async function upsertProduct(db, snapshot) {
  const now = toCaptureDate(new Date().toISOString());
  await db
    .prepare(
      `INSERT INTO products (joybuy_product_id, url, title, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(joybuy_product_id) DO UPDATE SET
         url = excluded.url,
         title = NULL,
         updated_at = excluded.updated_at`
    )
    .bind(snapshot.joybuy_product_id, productUrl(snapshot), now, now)
    .run();

  return db
    .prepare("SELECT id, joybuy_product_id, url, title, created_at, updated_at FROM products WHERE joybuy_product_id = ?")
    .bind(snapshot.joybuy_product_id)
    .first();
}

async function maybeInsertPricePoint(db, productId, snapshot) {
  const captureDate = toCaptureDate(snapshot.captured_at ?? new Date().toISOString());
  const existing = await db
    .prepare(
      `SELECT id, price
       FROM price_points
       WHERE product_id = ? AND captured_at = ?
       LIMIT 1`
    )
    .bind(productId, captureDate)
    .first();

  if (existing) {
    await db
      .prepare(
        `UPDATE price_points
         SET price = ?,
             list_price = NULL,
             promo_price = NULL,
             availability = CASE WHEN ? = 'unknown' THEN availability ELSE ? END
         WHERE id = ?`
      )
      .bind(snapshot.price, normalizeAvailability(snapshot.availability), normalizeAvailability(snapshot.availability), existing.id)
      .run();
    return true;
  }

  await db
    .prepare(
      `INSERT INTO price_points (product_id, price, list_price, promo_price, availability, captured_at)
       VALUES (?, ?, NULL, NULL, ?, ?)`
    )
    .bind(productId, snapshot.price, normalizeAvailability(snapshot.availability), captureDate)
    .run();
  return true;
}

function productUrl(snapshot) {
  if (snapshot.url && typeof snapshot.url === "string") return snapshot.url;
  return `https://www.joybuy.de/dp/${encodeURIComponent(snapshot.joybuy_product_id)}`;
}
function toCaptureDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}
function validateObservation(payload) {
  if (!payload || typeof payload !== "object") return "Body must be an object";
  if (!payload.joybuy_product_id || typeof payload.joybuy_product_id !== "string") return "joybuy_product_id is required";
  if (typeof payload.price !== "number" || !Number.isFinite(payload.price)) return "price must be a finite number";
  if (payload.availability !== undefined && normalizeAvailability(payload.availability) !== payload.availability) {
    return "availability must be in_stock, out_of_stock, or unknown";
  }
  return null;
}

function validateTargetSummary(payload) {
  if (!payload || typeof payload !== "object") return "Body must be an object";
  if (!payload.run_started_at || typeof payload.run_started_at !== "string") return "run_started_at is required";
  if (!payload.url || typeof payload.url !== "string") return "url is required";

  for (const key of [
    "target_index",
    "original_target_index",
    "configured_max_page",
    "latest_max_page",
    "pages_fetched",
    "zero_product_pages",
    "forbidden_pages",
    "items_found",
    "posted",
    "skipped"
  ]) {
    if (payload[key] !== undefined && payload[key] !== null && !Number.isInteger(Number(payload[key]))) {
      return `${key} must be an integer`;
    }
  }

  return null;
}

function normalizeAvailability(value) {
  if (value === "in_stock" || value === "out_of_stock") return value;
  return "unknown";
}

function clampLimit(value, defaultLimit) {
  const limit = Number(value || defaultLimit);
  if (!Number.isInteger(limit) || limit <= 0) return defaultLimit;
  return Math.min(limit, 10000);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nullableInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function nonNegativeInt(value) {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function json(body, status = 200) {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    })
  );
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
