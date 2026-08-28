import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../worker/src/index.js";

test("GET /health returns service status", async () => {
  const response = await handleRequest(new Request("https://api.example.test/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "joybuy-price-history"
  });
});

test("OPTIONS returns CORS preflight response", async () => {
  const response = await handleRequest(new Request("https://api.example.test/products/abc/prices", { method: "OPTIONS" }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
});

test("POST /products/observe overwrites same-day price with the latest observation", async () => {
  const db = new FakeD1();

  const first = await handleRequest(new Request("https://api.example.test/products/observe", {
    method: "POST",
    body: JSON.stringify({
      joybuy_product_id: "10387040",
      price: 3.99,
      availability: "in_stock",
      captured_at: "2026-08-27"
    })
  }), { DB: db });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).inserted, true);

  const lower = await handleRequest(new Request("https://api.example.test/products/observe", {
    method: "POST",
    body: JSON.stringify({
      joybuy_product_id: "10387040",
      price: 2.89,
      captured_at: "2026-08-27"
    })
  }), { DB: db });
  assert.equal(lower.status, 200);
  assert.equal((await lower.json()).inserted, true);

  const higher = await handleRequest(new Request("https://api.example.test/products/observe", {
    method: "POST",
    body: JSON.stringify({
      joybuy_product_id: "10387040",
      price: 3.49,
      availability: "out_of_stock",
      captured_at: "2026-08-27"
    })
  }), { DB: db });
  assert.equal(higher.status, 200);
  assert.equal((await higher.json()).inserted, true);

  const unknownAvailability = await handleRequest(new Request("https://api.example.test/products/observe", {
    method: "POST",
    body: JSON.stringify({
      joybuy_product_id: "10387040",
      price: 3.59,
      availability: "unknown",
      captured_at: "2026-08-27"
    })
  }), { DB: db });
  assert.equal(unknownAvailability.status, 200);
  assert.equal((await unknownAvailability.json()).inserted, true);

  const history = await handleRequest(new Request("https://api.example.test/products/10387040/prices?range=30d"), { DB: db });
  const body = await history.json();
  assert.deepEqual(body.prices, [{
    price: 3.59,
    list_price: null,
    promo_price: null,
    availability: "out_of_stock",
    captured_at: "2026-08-27"
  }]);
});

test("GET /products/:id/prices includes the latest point before the requested range", async () => {
  const db = new FakeD1();
  db.products.push({
    id: 1,
    joybuy_product_id: "10387040",
    url: "https://www.joybuy.de/dp/10387040",
    title: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01"
  });
  db.pricePoints.push({
    id: 1,
    product_id: 1,
    price: 4.99,
    list_price: null,
    promo_price: null,
    availability: "in_stock",
    captured_at: "2000-01-01"
  });

  const response = await handleRequest(new Request("https://api.example.test/products/10387040/prices?range=30d"), { DB: db });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.prices, [{
    price: 4.99,
    list_price: null,
    promo_price: null,
    availability: "in_stock",
    captured_at: "2000-01-01"
  }]);
});

test("POST /products/observe-batch records multiple observations", async () => {
  const db = new FakeD1();

  const response = await handleRequest(new Request("https://api.example.test/products/observe-batch", {
    method: "POST",
    body: JSON.stringify({
      observations: [
        {
          joybuy_product_id: "10100568",
          price: 4.18,
          availability: "in_stock",
          captured_at: "2026-08-28"
        },
        {
          joybuy_product_id: "10145624",
          price: 3.47,
          availability: "out_of_stock",
          captured_at: "2026-08-28"
        }
      ]
    })
  }), { DB: db });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    inserted: 2,
    failed: 0,
    results: [
      { ok: true, joybuy_product_id: "10100568", inserted: true },
      { ok: true, joybuy_product_id: "10145624", inserted: true }
    ]
  });
  assert.equal(db.products.length, 2);
  assert.equal(db.pricePoints.length, 2);
});

test("POST /products/observe-batch reports invalid observations", async () => {
  const response = await handleRequest(new Request("https://api.example.test/products/observe-batch", {
    method: "POST",
    body: JSON.stringify({
      observations: [
        { joybuy_product_id: "10100568", price: 4.18 },
        { joybuy_product_id: "10145624", price: "3.47" }
      ]
    })
  }), { DB: new FakeD1() });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: false,
    inserted: 1,
    failed: 1,
    results: [
      { ok: true, joybuy_product_id: "10100568", inserted: true },
      { ok: false, error: "price must be a finite number", joybuy_product_id: "10145624" }
    ]
  });
});

class FakeD1 {
  constructor() {
    this.products = [];
    this.pricePoints = [];
    this.nextProductId = 1;
    this.nextPricePointId = 1;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (/FROM products WHERE joybuy_product_id = \?/i.test(this.sql)) {
      return this.db.products.find((product) => product.joybuy_product_id === this.values[0]) || null;
    }

    if (/FROM price_points\s+WHERE product_id = \? AND captured_at = \?/i.test(this.sql)) {
      const [productId, capturedAt] = this.values;
      return this.db.pricePoints.find((point) => point.product_id === productId && point.captured_at === capturedAt) || null;
    }

    throw new Error(`Unhandled first query: ${this.sql}`);
  }

  async all() {
    if (/FROM price_points\s+WHERE product_id = \?/i.test(this.sql)) {
      const [productId, since] = this.values;
      const carryIn = this.db.pricePoints
        .filter((point) => point.product_id === productId && point.captured_at < since)
        .sort((a, b) => b.captured_at.localeCompare(a.captured_at))[0];
      const results = this.db.pricePoints
        .filter((point) => point.product_id === productId && point.captured_at >= since)
        .concat(carryIn ? [carryIn] : [])
        .sort((a, b) => a.captured_at.localeCompare(b.captured_at))
        .map(({ price, list_price, promo_price, availability, captured_at }) => ({
          price,
          list_price,
          promo_price,
          availability,
          captured_at
        }));
      return { results };
    }

    throw new Error(`Unhandled all query: ${this.sql}`);
  }

  async run() {
    if (/INSERT INTO products/i.test(this.sql)) {
      const [joybuyProductId, url, createdAt, updatedAt] = this.values;
      const existing = this.db.products.find((product) => product.joybuy_product_id === joybuyProductId);
      if (existing) {
        existing.url = url;
        existing.title = null;
        existing.updated_at = updatedAt;
        return {};
      }

      this.db.products.push({
        id: this.db.nextProductId++,
        joybuy_product_id: joybuyProductId,
        url,
        title: null,
        created_at: createdAt,
        updated_at: updatedAt
      });
      return {};
    }

    if (/INSERT INTO price_points/i.test(this.sql)) {
      const [productId, price, availability, capturedAt] = this.values;
      this.db.pricePoints.push({
        id: this.db.nextPricePointId++,
        product_id: productId,
        price,
        list_price: null,
        promo_price: null,
        availability,
        captured_at: capturedAt
      });
      return {};
    }

    if (/UPDATE price_points/i.test(this.sql)) {
      const [price, availability, _availabilityForCase, id] = this.values;
      const point = this.db.pricePoints.find((item) => item.id === id);
      point.price = price;
      point.list_price = null;
      point.promo_price = null;
      if (availability !== "unknown") point.availability = availability;
      return {};
    }

    throw new Error(`Unhandled run query: ${this.sql}`);
  }
}
