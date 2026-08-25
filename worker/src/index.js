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

  const pricesMatch = url.pathname.match(/^\/products\/([^/]+)\/prices$/);
  if (request.method === "GET" && pricesMatch) {
    return getPrices(env.DB, decodeURIComponent(pricesMatch[1]), url.searchParams.get("range") || "30d");
  }

  if (request.method === "POST" && url.pathname === "/products/observe") {
    return observeProduct(request, env.DB);
  }

  return json({ error: "Not found" }, 404);
}

async function getPrices(db, joybuyProductId, range) {
  const days = RANGE_DAYS[range] ?? RANGE_DAYS["30d"];
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
       WHERE product_id = ? AND captured_at >= ?
       ORDER BY captured_at ASC`
    )
    .bind(product.id, since)
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
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO products (joybuy_product_id, url, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(joybuy_product_id) DO UPDATE SET
         url = excluded.url,
         title = COALESCE(excluded.title, products.title),
         updated_at = excluded.updated_at`
    )
    .bind(snapshot.joybuy_product_id, snapshot.url, snapshot.title ?? null, now, now)
    .run();

  return db
    .prepare("SELECT id, joybuy_product_id, url, title, created_at, updated_at FROM products WHERE joybuy_product_id = ?")
    .bind(snapshot.joybuy_product_id)
    .first();
}

async function maybeInsertPricePoint(db, productId, snapshot) {
  const latest = await db
    .prepare(
      `SELECT price, list_price, promo_price, availability, captured_at
       FROM price_points
       WHERE product_id = ?
       ORDER BY captured_at DESC
       LIMIT 1`
    )
    .bind(productId)
    .first();

  if (latest && !shouldCapture(latest, snapshot)) {
    return false;
  }

  await db
    .prepare(
      `INSERT INTO price_points (product_id, price, list_price, promo_price, availability, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      productId,
      snapshot.price,
      snapshot.list_price ?? null,
      snapshot.promo_price ?? null,
      snapshot.availability ?? "unknown",
      snapshot.captured_at ?? new Date().toISOString()
    )
    .run();
  return true;
}

function shouldCapture(latest, snapshot) {
  const latestTime = Date.parse(latest.captured_at);
  const capturedTime = Date.parse(snapshot.captured_at ?? new Date().toISOString());
  const ageHours = Number.isFinite(latestTime) && Number.isFinite(capturedTime)
    ? (capturedTime - latestTime) / 36e5
    : Infinity;
  const latestDay = Number.isFinite(latestTime) ? new Date(latestTime).toISOString().slice(0, 10) : null;
  const capturedDay = Number.isFinite(capturedTime) ? new Date(capturedTime).toISOString().slice(0, 10) : null;

  return (
    ageHours >= 20 ||
    latestDay !== capturedDay ||
    latest.price !== snapshot.price ||
    latest.list_price !== (snapshot.list_price ?? null) ||
    latest.promo_price !== (snapshot.promo_price ?? null) ||
    latest.availability !== (snapshot.availability ?? "unknown")
  );
}

function validateObservation(payload) {
  if (!payload || typeof payload !== "object") return "Body must be an object";
  if (!payload.joybuy_product_id || typeof payload.joybuy_product_id !== "string") return "joybuy_product_id is required";
  if (!payload.url || typeof payload.url !== "string") return "url is required";
  if (typeof payload.price !== "number" || !Number.isFinite(payload.price)) return "price must be a finite number";
  return null;
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
