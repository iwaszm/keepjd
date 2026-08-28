# Joybuy Price History Tracker

A lightweight Keepa-style MVP for `joybuy.de`. The regular Chrome extension shows compact 30/90 day price history charts on product detail pages. Data collection is handled separately by the background collector extension and stored in Cloudflare D1 through a Worker API.

## Current Scope

This project is currently optimized for low-cost validation, not full-site automated crawling.

- Chrome extension: product-page chart injection and historical price display.
- Background Chrome extension: listing-page collection from configured target URLs.
- Cloudflare Worker: API layer, D1 persistence, optional scheduled collector.
- D1 database: minimal daily price history.
- No user accounts, alerts, recommendations, affiliate logic, or backfilled historical data.

## Project Layout

- `extension/` - Chrome Manifest V3 extension.
  - `manifest.json` declares Joybuy page injection and Worker host access.
  - `content.js` injects the chart, detects the current product ID and visible price, and reads price history from the Worker.
  - `styles.css` styles the compact floating chart panel.
- `background-extension/` - Separate Ubuntu-oriented Chrome extension for background listing-page collection.
  - Fetches configured search/listing URLs page by page without opening tabs.
  - Parses `self.__next_s` and `self.__next_f` script payloads for product IDs and prices.
  - Posts changed observations to the same Worker API.
- `worker/` - Cloudflare Worker API, D1 config, migrations, and cron configuration.
  - `src/index.js` implements the API and persistence rules.
  - `wrangler.toml` contains Worker name, D1 binding, cron trigger, and `TRACKED_PRODUCTS_JSON`.
  - `migrations/` contains D1 schema and cleanup migrations.
- `collector/` - Optional Ubuntu Playwright collector for later controlled validation.
- `shared/` - Shared Joybuy URL/product/price parser helpers used by Worker tests and collectors.
- `tests/` - Node built-in tests.
- `docs/context.md` - Compressed project context for starting a new Codex task or folder.

## Data Model

The current product decision is minimal daily tracking:

```text
product_id, price, captured_at
```

The deployed D1 schema still keeps compatibility columns from the early MVP, but Worker writes only the minimum useful data.

### products

Current table shape:

```sql
products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  joybuy_product_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

Current write behavior:

- `joybuy_product_id` is the stable product key.
- `created_at` and `updated_at` are stored as `YYYY-MM-DD` only.
- `title` is always stored as `NULL`.
- `url` is no longer required from clients. The Worker generates `https://www.joybuy.de/dp/{id}` when the client omits it because the old schema still has `url NOT NULL`.

### price_points

Current table shape:

```sql
price_points(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  price REAL NOT NULL,
  list_price REAL,
  promo_price REAL,
  availability TEXT NOT NULL DEFAULT 'unknown',
  captured_at TEXT NOT NULL
)
```

Current write behavior:

- `captured_at` is stored as `YYYY-MM-DD` only.
- `list_price` and `promo_price` are written as `NULL`.
- `availability` is written as `unknown` by the Worker for minimal daily points.
- One product can have at most one row per date through `idx_price_points_product_day(product_id, captured_at)`.

A future slimming migration can rebuild both tables as:

```sql
products(id, joybuy_product_id, created_at, updated_at)
price_points(id, product_id, price, captured_at)
```

## Worker API

Base URL currently used by the extension:

```text
https://joybuy-price-history.zhangmeng43.workers.dev
```

Endpoints:

```http
GET /health
GET /products/:joybuyProductId/prices?range=30d|90d
POST /products/observe
```

`POST /products/observe` accepts the minimal payload:

```json
{
  "joybuy_product_id": "10387040",
  "price": 229,
  "captured_at": "2026-08-26"
}
```

Accepted compatibility fields, but not required for the current MVP:

```json
{
  "url": "https://www.joybuy.de/dp/10387040",
  "title": null,
  "list_price": null,
  "promo_price": null,
  "availability": "unknown"
}
```

`GET /products/:id/prices` returns:

```json
{
  "product": { "id": 1, "joybuy_product_id": "10387040" },
  "prices": [
    { "price": 229, "captured_at": "2026-08-26" }
  ],
  "range": "30d",
  "currency": "EUR"
}
```

## Cloudflare Setup

Install dependencies first:

```bash
npm install
```

Login to Cloudflare:

```bash
npx wrangler login
```

Create a new D1 database if starting from scratch:

```bash
npx wrangler d1 create joybuy_price_history
```

Copy the returned `database_id` into `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "joybuy_price_history"
database_id = "..."
```

Apply migrations locally:

```bash
npm run db:migrate:local
```

Apply migrations remotely:

```bash
npm run db:migrate:remote
```

Run the Worker locally:

```bash
npm run worker:dev
```

Deploy the Worker:

```bash
npm run worker:deploy
```

Check deployed health:

```bash
curl https://joybuy-price-history.zhangmeng43.workers.dev/health
```

Useful D1 inspection commands:

```bash
npx wrangler d1 execute joybuy_price_history --remote --config worker/wrangler.toml --command "SELECT COUNT(*) FROM products;"

npx wrangler d1 execute joybuy_price_history --remote --config worker/wrangler.toml --command "SELECT COUNT(*) FROM price_points;"

npx wrangler d1 execute joybuy_price_history --remote --config worker/wrangler.toml --command "SELECT p.joybuy_product_id, pp.price, pp.captured_at FROM price_points pp JOIN products p ON p.id = pp.product_id ORDER BY pp.id DESC LIMIT 30;"
```

## Extension Setup

The extension has no build step. Load it directly as an unpacked Chrome extension.

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable Developer Mode.
4. Click `Load unpacked`.
5. Select the `extension/` folder.
6. After any local file change, click `Reload` on the extension card.

The current `content.js` is configured to use the deployed Worker URL:

```js
const API_BASE_URL = "https://joybuy-price-history.zhangmeng43.workers.dev";
```

For local Worker testing, temporarily point that constant to the Wrangler dev URL.

## Extension Behavior

On Joybuy product detail pages:

- The content script is injected by Manifest V3.
- It detects the current product ID and visible current price.
- It injects a compact floating chart panel.
- The panel has 30 and 90 day tabs.
- Each tab shows the lowest price in that range.
- The chart is a simple x=date, y=price point-line chart.
- Empty history shows `No data` but keeps the chart slot visible.

Known behavior:

- Search/category/home pages do not show the chart panel and are not collected by the regular extension.
- The regular extension never posts observations to `/products/observe`.
- Listing-page data collection lives in `background-extension/`, which fetches configured target pages, parses Next.js payloads, and posts observations.
- The background extension stores its latest local product snapshots in Chrome storage. By default it skips unchanged `price + availability` pairs on later runs and only writes new or changed observations.
- Out-of-stock detection comes from JSON-LD `https://schema.org/InStock` and `https://schema.org/OutOfStock` when those fields are present.

## Optional Ubuntu Playwright Collector

The `collector/` folder is kept for later validation if passive browsing is not enough.

Install Chromium dependencies:

```bash
npm install
npx playwright install --with-deps chromium
```

Login once with a persistent browser profile:

```bash
npm run collect:login
```

Run collection:

```bash
npm run collect
```

Useful environment variables:

```bash
JOYBUY_LIMIT=10 npm run collect
JOYBUY_CONCURRENCY=3 npm run collect
JOYBUY_HEADLESS=false npm run collect
JOYBUY_DEBUG=1 npm run collect
```

Daily cron example:

```cron
0 6 * * * cd /path/to/keepjd && /usr/bin/npm run collect >> collector/logs/cron.log 2>&1
```

Current preference: keep this optional. Use passive extension recording first.

## Testing

Run all tests:

```bash
npm test
```

Syntax-check key JS files:

```bash
node --check extension/content.js
node --check background-extension/background.js
node --check background-extension/parser.js
node --check background-extension/popup.js
node --check worker/src/index.js
```

## Moving To A New Project Folder

Recommended clean setup:

```bash
git clone git@github.com:zhangmeng43/keepjd.git keepjd
cd keepjd
npm install
npx wrangler login
npm test
```

Then load `extension/` in Chrome.

If creating a new Cloudflare project/database, update these values:

- `worker/wrangler.toml` Worker `name`
- D1 `database_name`
- D1 `database_id`
- `extension/content.js` `API_BASE_URL`
- `background-extension/config.js` `API_BASE_URL`

## Current Deployed Resources

Current Git remote:

```text
git@github.com:zhangmeng43/keepjd.git
```

Current Worker:

```text
joybuy-price-history
https://joybuy-price-history.zhangmeng43.workers.dev
```

Current D1:

```text
name: joybuy_price_history
id: 24718ee9-f606-47cd-a4d8-4c2899c684ad
```

Current cron trigger:

```text
0 3 * * *
```

The cron collector remains configured, but the current product direction is passive browsing capture first.
