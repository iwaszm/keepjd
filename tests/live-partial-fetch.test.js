import assert from "node:assert/strict";
import test from "node:test";
import { extractSearchPageObservations } from "../background-extension/parser.js";
import { fetchSearchPageHtml } from "../background-extension/stream-fetch.js";

const JOYBUY_SEARCH_URL = "https://www.joybuy.de/s?k=%E6%89%AB%E5%9C%B0%E6%9C%BA%E5%99%A8%E4%BA%BA&l1=2177&l2=null&l3=3348&fromTrending=true";
const RUN_LIVE_TEST = process.env.JOYBUY_LIVE_PARTIAL_TEST === "1";

test("live Joybuy search page can return products from partial stream read", { skip: RUN_LIVE_TEST ? false : "Set JOYBUY_LIVE_PARTIAL_TEST=1 to run the live Joybuy partial fetch check" }, async () => {
  const partialPage = await fetchSearchPageHtml(JOYBUY_SEARCH_URL, true);
  const partialObservations = extractSearchPageObservations(partialPage.html);

  const fullResponse = await fetch(JOYBUY_SEARCH_URL, { cache: "no-store" });
  assert.equal(fullResponse.ok, true, `full fetch returned HTTP ${fullResponse.status}`);
  const fullHtml = await fullResponse.text();
  const fullObservations = extractSearchPageObservations(fullHtml);

  console.info("Joybuy partial fetch diagnostics", {
    partialRead: partialPage.partialRead,
    partialBytesRead: partialPage.bytesRead,
    partialHtmlLength: partialPage.html.length,
    partialObservationCount: partialObservations.length,
    fullHtmlLength: fullHtml.length,
    fullObservationCount: fullObservations.length,
    partialProductIds: partialObservations.map((observation) => observation.joybuy_product_id),
    fullProductIds: fullObservations.map((observation) => observation.joybuy_product_id)
  });

  assert.ok(fullObservations.length > 0, "full live fetch did not extract any products; the Node response likely differs from the Chrome logged-in source");
  assert.equal(partialPage.partialRead, true, "stream fetch did not abort early");
  assert.ok(partialObservations.length > 0, "partial stream read did not extract any products");
  assert.equal(partialObservations.length, fullObservations.length, "partial stream read extracted a different product count than the full page");
  assert.deepEqual(
    partialObservations.map((observation) => observation.joybuy_product_id),
    fullObservations.map((observation) => observation.joybuy_product_id),
    "partial stream read extracted different products than the full page"
  );
});
