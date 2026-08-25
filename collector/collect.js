import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const API_BASE_URL = process.env.JOYBUY_API_BASE_URL || "https://joybuy-price-history.zhangmeng43.workers.dev";
const OBSERVE_URL = `${API_BASE_URL}/products/observe`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTS_FILE = path.join(__dirname, "tracked-products.json");
const LOG_DIR = path.join(__dirname, "logs");
const PROFILE_DIR = path.join(__dirname, ".browser-profile");
const PAGE_TIMEOUT_MS = Number(process.env.JOYBUY_PAGE_TIMEOUT_MS || 20000);
const DELAY_MIN_MS = Number(process.env.JOYBUY_DELAY_MIN_MS || 300);
const DELAY_MAX_MS = Number(process.env.JOYBUY_DELAY_MAX_MS || 1200);
const CONCURRENCY = Number(process.env.JOYBUY_CONCURRENCY || 3);
const HEADLESS = process.env.JOYBUY_HEADLESS === "1";
const LIMIT = Number(process.env.JOYBUY_LIMIT || 0);
const DEBUG = process.env.JOYBUY_DEBUG === "1";
const BLOCK_RESOURCES = process.env.JOYBUY_BLOCK_RESOURCES !== "0";

await main();

async function main() {
  await mkdir(LOG_DIR, { recursive: true });
  const allProducts = JSON.parse(await readFile(PRODUCTS_FILE, "utf8"));
  const products = LIMIT > 0 ? allProducts.slice(0, LIMIT) : allProducts;
  const logPath = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.ndjson`);
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1365, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  });
  if (BLOCK_RESOURCES) {
    await browser.route("**/*", (route) => {
      const request = route.request();
      if (["image", "media", "font"].includes(request.resourceType())) {
        return route.abort();
      }
      return route.continue();
    });
  }

  const summary = { ok: 0, fail: 0, total: products.length, started_at: new Date().toISOString() };

  try {
    await runPool(products, CONCURRENCY, async (product, index) => {
      await sleep(randomInt(DELAY_MIN_MS, DELAY_MAX_MS));
      const result = await collectOne(browser, product.url, index + 1, products.length);
      await appendLog(logPath, result);
      if (result.ok) {
        summary.ok += 1;
        console.log(`OK ${result.index}/${result.total} ${result.product_id} ${result.price}`);
      } else {
        summary.fail += 1;
        console.log(`FAIL ${result.index}/${result.total} ${product.url} ${result.reason}`);
      }
    });
  } finally {
    await browser.close();
  }

  summary.finished_at = new Date().toISOString();
  await appendLog(logPath, { type: "summary", ...summary });
  console.log(`Done: ${summary.ok}/${summary.total} ok, ${summary.fail} failed`);
}

async function collectOne(browser, url, index, total) {
  const page = await browser.newPage();
  const capturedAt = new Date().toISOString();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(() => {
      if (/Joybuy Risk Control|notFound_container|not-found/i.test(document.documentElement.innerHTML)) return true;
      return Boolean(document.querySelector("[class*='skuPriceReal' i], [class*='mainPriceText_wrapper' i], [class*='mainPrice__' i]"));
    }, { timeout: Math.min(PAGE_TIMEOUT_MS, 12000) }).catch(() => {});
    await page.waitForTimeout(500);

    const snapshot = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const bodyText = document.body.innerText || "";
      const productId = extractProductId(location.href, document.documentElement.innerHTML);
      const price = extractVisiblePrice();
      const title = document.querySelector("h1")?.textContent?.trim() || document.title.replace(/\s*\|\s*Joybuy.*/i, "").trim();
      const blocked = /Joybuy Risk Control|notFound_container|not-found/i.test(html);
      const loginRequired = location.pathname.startsWith("/login") || /Melden Sie sich bei Ihrem Konto an|Sign in to your account/i.test(bodyText);
      const priceNodeCount = document.querySelectorAll("[class*='skuPriceReal' i], [class*='mainPriceText_wrapper' i], [class*='mainPrice__' i], [class*='price' i]").length;
      return {
        productId,
        price,
        title,
        finalUrl: location.href,
        blocked,
        loginRequired,
        priceNodeCount,
        bodySample: bodyText.slice(0, 300)
      };

      function extractProductId(rawUrl, html) {
        const urlProductId = extractProductIdFromUrl(rawUrl);
        if (urlProductId) return urlProductId;

        try {
          const url = new URL(rawUrl);
          const returnUrl = url.searchParams.get("returnUrl");
          if (returnUrl) {
            const returnUrlProductId = extractProductIdFromUrl(returnUrl);
            if (returnUrlProductId) return returnUrlProductId;
          }
        } catch {
        }

        const patterns = [
          /"skuId"\s*:\s*"([^"]+)"/i,
          /"productId"\s*:\s*"([^"]+)"/i,
          /data-(?:sku|product-id|ware-id)=["']([^"']+)["']/i
        ];
        for (const pattern of patterns) {
          const match = html.match(pattern);
          if (match?.[1]) return decodeURIComponent(match[1]).replace(/\.html$/i, "").trim();
        }
        return null;
      }

      function extractProductIdFromUrl(rawUrl) {
        try {
          const url = new URL(rawUrl, location.origin);
          const dpMatch = url.pathname.match(/\/dp\/(?:[^/?#]+\/)?([^/?#]+)/i);
          if (dpMatch?.[1]) return decodeURIComponent(dpMatch[1]).replace(/\.html$/i, "").trim();
          for (const key of ["sku", "skuid", "skuId", "productId", "wareId", "itemId", "id"]) {
            const value = url.searchParams.get(key);
            if (value) return value.trim();
          }
        } catch {
        }
        return null;
      }

      function extractVisiblePrice() {
        const primary = findPriceInSelectors([
          "[class*='skuPriceReal' i]",
          "[class*='mainPriceText_wrapper' i]",
          "[class*='mainPrice__' i]"
        ]);
        if (primary !== null) return primary;
        return findPriceInSelectors([
          "[class*='price' i]",
          "[class*='amount' i]",
          "[data-testid*='price' i]",
          "[data-price]",
          "meta[property='product:price:amount']"
        ]);
      }

      function findPriceInSelectors(selectors) {
        const nodes = [...document.querySelectorAll(selectors.join(", "))];
        for (const node of nodes) {
          const value = node.content || node.dataset?.price || node.textContent;
          const price = extractFirstEuroPrice(value);
          if (typeof price === "number" && Number.isFinite(price) && price >= 0.1 && price <= 10000) return price;
        }
        return null;
      }

      function extractFirstEuroPrice(value) {
        const text = String(value || "").replace(/\u00a0/g, " ");
        const match = text.match(/€\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)|(\d{1,3}(?:[.\s]\d{3})*|\d+)([,.])(\d{2})(?!\d)\s*€/);
        if (!match) return null;
        const integerPart = match[1] || match[4];
        const decimal = match[3] || match[6];
        const price = Number(`${integerPart.replace(/[.\s]/g, "")}.${decimal}`);
        return Number.isFinite(price) ? price : null;
      }
    });

    if (snapshot.loginRequired) return await fail(page, url, "login_required", index, total, capturedAt, snapshot.finalUrl, snapshot.productId, snapshot);
    if (snapshot.blocked) return await fail(page, url, "blocked_or_not_found", index, total, capturedAt, snapshot.finalUrl, snapshot.productId, snapshot);
    if (!snapshot.productId) return await fail(page, url, "missing_product_id", index, total, capturedAt, snapshot.finalUrl, null, snapshot);
    if (snapshot.price === null) return await fail(page, url, "missing_price", index, total, capturedAt, snapshot.finalUrl, snapshot.productId, snapshot);

    const payload = {
      joybuy_product_id: snapshot.productId,
      url: snapshot.finalUrl,
      title: snapshot.title || null,
      price: snapshot.price,
      captured_at: capturedAt
    };
    const response = await fetch(OBSERVE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return fail(url, `api_${response.status}`, index, total, capturedAt, snapshot.finalUrl, snapshot.productId);
    }

    return {
      ok: true,
      index,
      total,
      url,
      final_url: snapshot.finalUrl,
      product_id: snapshot.productId,
      price: snapshot.price,
      captured_at: capturedAt
    };
  } catch (error) {
    return await fail(page, url, error.message, index, total, capturedAt);
  } finally {
    await page.close().catch(() => {});
  }
}

async function fail(page, url, reason, index, total, capturedAt, finalUrl = null, productId = null, diagnostics = null) {
  const debug = DEBUG ? await writeDebugArtifacts(page, index, productId || "unknown") : null;
  return {
    ok: false,
    index,
    total,
    url,
    final_url: finalUrl,
    product_id: productId,
    reason,
    diagnostics,
    debug,
    captured_at: capturedAt
  };
}

async function appendLog(logPath, entry) {
  await writeFile(logPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeDebugArtifacts(page, index, productId) {
  const safeId = String(productId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const prefix = path.join(LOG_DIR, `debug-${new Date().toISOString().replace(/[:.]/g, "-")}-${index}-${safeId}`);
  const htmlPath = `${prefix}.html`;
  const screenshotPath = `${prefix}.png`;
  await writeFile(htmlPath, await page.content(), "utf8").catch(() => {});
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return { html: htmlPath, screenshot: screenshotPath };
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}
