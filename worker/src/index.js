import { extractProductSnapshotFromHtml } from "../../shared/joybuy-parser.js";

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90
};

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

async function runCollector(env) {
  const tracked = await loadTrackedProducts(env);
  const outcomes = [];

  for (const item of tracked) {
    try {
      const response = await fetch(item.url, {
        headers: {
          "user-agent": "JoybuyPriceHistoryBot/0.1 (+https://example.invalid/joybuy-price-history)"
        }
      });
      const html = await response.text();
      const snapshot = extractProductSnapshotFromHtml(html, response.url || item.url);
      if (!snapshot) {
        outcomes.push({ url: item.url, ok: false, reason: "parser_returned_null" });
        continue;
      }
      const product = await upsertProduct(env.DB, snapshot);
      const inserted = await maybeInsertPricePoint(env.DB, product.id, snapshot);
      outcomes.push({ url: item.url, ok: true, joybuy_product_id: snapshot.joybuy_product_id, inserted });
    } catch (error) {
      outcomes.push({ url: item.url, ok: false, reason: error.message });
    }
  }

  return outcomes;
}

async function loadTrackedProducts(env) {
  if (env.TRACKED_PRODUCTS_JSON) {
    return JSON.parse(env.TRACKED_PRODUCTS_JSON);
  }
  return [];
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

function normalizeAvailability(value) {
  if (value === "in_stock" || value === "out_of_stock") return value;
  return "unknown";
}

function clampLimit(value, defaultLimit) {
  const limit = Number(value || defaultLimit);
  if (!Number.isInteger(limit) || limit <= 0) return defaultLimit;
  return Math.min(limit, 10000);
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
