import assert from "node:assert/strict";
import test from "node:test";
import {
  extractJoybuyProductId,
  extractProductSnapshotFromHtml,
  isLikelyJoybuyProductPage,
  normalizeJoybuyUrl,
  parsePriceText
} from "../shared/joybuy-parser.js";

test("parsePriceText handles German euro formats", () => {
  assert.equal(parsePriceText("6,99 €"), 6.99);
  assert.equal(parsePriceText("€1.299,00"), 1299);
  assert.equal(parsePriceText("€229.00"), 229);
  assert.equal(parsePriceText("UVP: 12,99 €"), 12.99);
  assert.equal(parsePriceText("25,000 Pa"), null);
  assert.equal(parsePriceText("no price"), null);
});

test("extractJoybuyProductId reads known URL and HTML patterns", () => {
  assert.equal(extractJoybuyProductId("https://www.joybuy.de/product/ABC-123?utm=1"), "ABC-123");
  assert.equal(extractJoybuyProductId("https://www.joybuy.de/item.html?skuId=998877"), "998877");
  assert.equal(extractJoybuyProductId("https://www.joybuy.de/dp/cocacola-original-dose-vorratspack-18x033l/100736603?requestIdentity=x"), "100736603");
  assert.equal(extractJoybuyProductId("https://www.joybuy.de/x", '<script>{"productId":"P12345"}</script>'), "P12345");
});

test("normalizeJoybuyUrl removes marketing params and keeps product identifiers", () => {
  assert.equal(
    normalizeJoybuyUrl("https://www.joybuy.de/item.html?skuId=998877&utm_source=x#reviews"),
    "https://www.joybuy.de/item.html?skuId=998877"
  );
});

test("extractProductSnapshotFromHtml extracts a minimal product snapshot", () => {
  const html = `
    <html>
      <head><meta property="og:title" content="Coca-Cola Original Dose Vorratspack 18x0.33L"></head>
      <body data-sku="COCA123456">
        <h1>Coca-Cola Original Dose Vorratspack 18x0.33L</h1>
        <span>Willkommensangebot</span><strong>6,99 €</strong>
        <span>UVP:12,99 €</span>
        <p>Lieferung bis morgen</p>
      </body>
    </html>
  `;
  const snapshot = extractProductSnapshotFromHtml(html, "https://www.joybuy.de/product/COCA123456?utm=1", "2026-08-25T10:00:00.000Z");

  assert.deepEqual(snapshot, {
    joybuy_product_id: "COCA123456",
    url: "https://www.joybuy.de/product/COCA123456",
    title: "Coca-Cola Original Dose Vorratspack 18x0.33L",
    price: 6.99,
    list_price: 12.99,
    promo_price: 6.99,
    availability: "in_stock",
    captured_at: "2026-08-25T10:00:00.000Z"
  });
});

test("isLikelyJoybuyProductPage rejects non-Joybuy hosts", () => {
  assert.equal(isLikelyJoybuyProductPage("https://example.com/product/COCA123456"), false);
  assert.equal(isLikelyJoybuyProductPage("https://www.joybuy.de/product/COCA123456"), true);
});
