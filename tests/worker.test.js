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
