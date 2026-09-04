import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const parserSource = fs.readFileSync(new URL("../extension/listing-parser.js", import.meta.url), "utf8");

function loadParser() {
  const context = {
    window: {},
    URL,
    console
  };
  vm.createContext(context);
  vm.runInContext(parserSource, context);
  return context.window.JoybuyListingParser;
}

test("extension listing parser extracts products from adjacent Next script blocks", () => {
  const parser = loadParser();
  const items = Array.from({ length: 20 }, (_, index) => {
    const id = String(10286000 + index);
    const price = (1 + index / 10).toFixed(2);
    return `{\\"@type\\":\\"ListItem\\",\\"position\\":${index + 1},\\"item\\":{\\"@type\\":\\"Product\\",\\"url\\":\\"https://www.joybuy.de/dp/example-${index}/${id}\\",\\"offers\\":{\\"@type\\":\\"Offer\\",\\"price\\":\\"${price}\\",\\"priceCurrency\\":\\"EUR\\",\\"availability\\":\\"https://schema.org/InStock\\"}}}`;
  }).join(",");
  const html = `</script><script>(self.__next_s=self.__next_s||[]).push([0,{"children":"${items}"}])</script>`;

  const observations = parser.extractSearchPageObservations(html, "2026-09-04");

  assert.equal(observations.length, 20);
  assert.equal(observations[0].joybuy_product_id, "10286000");
  assert.equal(observations[0].title, null);
  assert.equal(observations[0].price, 1);
  assert.equal(observations[0].list_price, null);
  assert.equal(observations[0].promo_price, null);
  assert.equal(observations[0].availability, "in_stock");
  assert.equal(observations[0].captured_at, "2026-09-04");
  assert.equal(observations.at(-1).joybuy_product_id, "10286019");
  assert.equal(observations.at(-1).price, 2.9);
});
