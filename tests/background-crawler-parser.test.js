import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPageUrl,
  extractMaxPageNumber,
  extractPageCountNumber,
  extractSearchPageObservations,
  pageNumberFromSeed
} from "../background-extension/parser.js";

test("buildPageUrl replaces existing page parameter", () => {
  assert.equal(
    buildPageUrl("https://www.joybuy.de/s?k=x&l1=2411&page=1", 12),
    "https://www.joybuy.de/s?k=x&l1=2411&page=12"
  );
});

test("pageNumberFromSeed defaults to page one", () => {
  assert.equal(pageNumberFromSeed("https://www.joybuy.de/s?k=x"), 1);
  assert.equal(pageNumberFromSeed("https://www.joybuy.de/s?k=x&page=3"), 3);
});

test("extractSearchPageObservations reads JSON-LD offer prices from Next scripts", () => {
  const html = `
    <script>(self.__next_s=self.__next_s||[]).push([0,{
      "children":"{\\"@type\\":\\"ListItem\\",\\"item\\":{\\"@type\\":\\"Product\\",\\"url\\":\\"https://www.joybuy.de/dp/example-product/10286300\\",\\"offers\\":{\\"@type\\":\\"Offer\\",\\"price\\":\\"3.98\\",\\"priceCurrency\\":\\"EUR\\"}}}"
    }])</script>
  `;

  assert.deepEqual(extractSearchPageObservations(html, "2026-08-27"), [{
    joybuy_product_id: "10286300",
    title: null,
    price: 3.98,
    list_price: null,
    promo_price: null,
    availability: "unknown",
    captured_at: "2026-08-27"
  }]);
});

test("extractSearchPageObservations ignores shipping price near generic price key", () => {
  const html = `
    <script>self.__next_f.push([1,"
      {\\"skuId\\":\\"10286300\\",\\"delivery\\":{\\"price\\":\\"3.99\\",\\"priceCurrency\\":\\"EUR\\"}}
    "])</script>
  `;

  assert.deepEqual(extractSearchPageObservations(html, "2026-08-27"), []);
});

test("extractSearchPageObservations keeps adjacent product prices separated", () => {
  const html = `
    <script>self.__next_s.push([0,{"children":"
      <a href=\\"/dp/sauce-one/10100568\\">Sauce One</a>
      <span>4,18 €</span>
      <a href=\\"/dp/sauce-two/10145624\\">Sauce Two</a>
      <span>1,85 €</span>
    "}])</script>
  `;

  assert.deepEqual(extractSearchPageObservations(html, "2026-08-28"), [
    {
      joybuy_product_id: "10100568",
      title: null,
      price: 4.18,
      list_price: null,
      promo_price: null,
      availability: "unknown",
      captured_at: "2026-08-28"
    },
    {
      joybuy_product_id: "10145624",
      title: null,
      price: 1.85,
      list_price: null,
      promo_price: null,
      availability: "unknown",
      captured_at: "2026-08-28"
    }
  ]);
});

test("extractSearchPageObservations pairs JSON-LD offer prices with adjacent product URLs", () => {
  const html = `
    </script><script>(self.__next_s=self.__next_s||[]).push([0,{"children":"
      {\\"@type\\":\\"ListItem\\",\\"position\\":1,\\"item\\":{
        \\"@type\\":\\"Product\\",
        \\"name\\":\\"Frosch Qingning\\",
        \\"url\\":\\"https://www.joybuy.de/dp/frosch-qingning-750ml/10121869\\",
        \\"offers\\":{\\"@type\\":\\"Offer\\",\\"price\\":\\"1.75\\",\\"priceCurrency\\":\\"EUR\\",\\"availability\\":\\"https:\\\\/\\\\/schema.org\\\\/InStock\\"}
      }},
      {\\"@type\\":\\"ListItem\\",\\"position\\":2,\\"item\\":{
        \\"@type\\":\\"Product\\",
        \\"name\\":\\"Raid trap 5 pack\\",
        \\"image\\":\\"https://images4.joy-sourcing.com/product/example.png.webp\\",
        \\"url\\":\\"https://www.joybuy.de/dp/raid-trap-5-pack/10145624\\",
        \\"offers\\":{\\"@type\\":\\"Offer\\",\\"price\\":\\"3.47\\",\\"priceCurrency\\":\\"EUR\\",\\"availability\\":\\"https://schema.org/OutOfStock\\"}
      }}
    "}])</script>
  `;

  assert.deepEqual(extractSearchPageObservations(html, "2026-08-28"), [
    {
      joybuy_product_id: "10121869",
      title: null,
      price: 1.75,
      list_price: null,
      promo_price: null,
      availability: "in_stock",
      captured_at: "2026-08-28"
    },
    {
      joybuy_product_id: "10145624",
      title: null,
      price: 3.47,
      list_price: null,
      promo_price: null,
      availability: "out_of_stock",
      captured_at: "2026-08-28"
    }
  ]);
});

test("extractSearchPageObservations reads product data from an incomplete streamed Next script", () => {
  const html = `
    <script>(self.__next_s=self.__next_s||[]).push([0,{"children":"
      {\\"@type\\":\\"ListItem\\",\\"position\\":1,\\"item\\":{
        \\"@type\\":\\"Product\\",
        \\"url\\":\\"https://www.joybuy.de/dp/robot-vacuum/10328909\\",
        \\"offers\\":{\\"@type\\":\\"Offer\\",\\"price\\":\\"229.00\\",\\"priceCurrency\\":\\"EUR\\",\\"availability\\":\\"https://schema.org/InStock\\"}
      }}
    "}]
  `;

  assert.deepEqual(extractSearchPageObservations(html, "2026-08-30"), [{
    joybuy_product_id: "10328909",
    title: null,
    price: 229,
    list_price: null,
    promo_price: null,
    availability: "in_stock",
    captured_at: "2026-08-30"
  }]);
});

test("extractMaxPageNumber reads pagination links and labels", () => {
  const html = `
    <nav>
      <li><a aria-label="Go to page 49" href="/s?k=x&amp;page=49">49</a></li>
      <li><a class="MuiPaginationItem-page" aria-label="Go to page 261" href="/s?k=x&amp;l1=2411&amp;page=261&amp;logId=abc">261</a></li>
    </nav>
  `;

  assert.equal(extractMaxPageNumber(html), 261);
});

test("extractMaxPageNumber reads plain and escaped pageCount metadata", () => {
  assert.equal(extractMaxPageNumber('<script>{"pageCount":7,"pageIndex":1,"pageSize":20}</script>'), 7);
  assert.equal(
    extractMaxPageNumber('<script>(self.__next_s=self.__next_s||[]).push([0,{"children":"{\\"pageCount\\":49,\\"pageIndex\\":1,\\"pageSize\\":20}"}])</script>'),
    49
  );
});

test("extractPageCountNumber ignores local pagination links", () => {
  const html = `
    <nav>
      <a aria-label="Go to page 13" href="/s?b1=4&amp;page=13">13</a>
    </nav>
    <script>{"pageCount":370,"pageIndex":1,"pageSize":20}</script>
  `;

  assert.equal(extractMaxPageNumber(html), 370);
  assert.equal(extractPageCountNumber(html), 370);
  assert.equal(extractPageCountNumber('<a aria-label="Go to page 13" href="/s?b1=4&amp;page=13">13</a>'), null);
});

test("extractMaxPageNumber returns null when pagination is absent", () => {
  assert.equal(extractMaxPageNumber("<html><body>No pagination</body></html>"), null);
});
