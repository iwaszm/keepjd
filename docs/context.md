# Joybuy Price History Tracker - Compressed Context

## Project Goal

Build a lightweight Keepa-style price history tool for `joybuy.de`.

Current MVP direction:

- Use the Chrome extension as the primary data source through passive browsing.
- Store daily minimal price history in Cloudflare D1.
- Show 30/90 day price charts on Joybuy product pages.
- Keep the implementation low-cost and simple.

Not in scope for now:

- User accounts
- Price drop alerts
- Recommendations
- Affiliate logic
- Full automated crawling
- Backfilled history

## Repository

Current repo:

```text
git@github.com:zhangmeng43/keepjd.git
```

Current Windows project folder used during development:

```text
D:\e\codex\keepjd
```

The old Codex workspace root sometimes points to:

```text
D:\e\codex\keepa
```

When starting a new Codex task, explicitly open or select `D:\e\codex\keepjd`, or clone the repo into a new folder and open that folder as the project root.

## Current Stack

- Chrome Extension Manifest V3
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Cron Triggers
- Node.js tests with `node:test`
- Optional Playwright collector for Ubuntu validation

## Data Rules

The chosen minimum data is:

```text
product_id, price, captured_at
```

`captured_at` means date only:

```text
YYYY-MM-DD
```

One `product_id` can have only one price point per date.

Current D1 still has old compatibility columns, but Worker writes minimal values:

- `products.title = NULL`
- `products.created_at = YYYY-MM-DD`
- `products.updated_at = YYYY-MM-DD`
- `price_points.captured_at = YYYY-MM-DD`
- `price_points.list_price = NULL`
- `price_points.promo_price = NULL`
- `price_points.availability = unknown`

`products.url` is not needed for current functionality, but still exists because the original table declared it `NOT NULL`. The Worker now accepts requests without `url` and generates `https://www.joybuy.de/dp/{id}` internally for compatibility.

Future clean schema:

```sql
products(id, joybuy_product_id, created_at, updated_at)
price_points(id, product_id, price, captured_at)
```

## Cloudflare Resources

Worker:

```text
name: joybuy-price-history
url: https://joybuy-price-history.zhangmeng43.workers.dev
```

D1:

```text
name: joybuy_price_history
id: 24718ee9-f606-47cd-a4d8-4c2899c684ad
binding: DB
```

Cron:

```text
0 3 * * *
```

The cron path exists, but passive extension capture is currently preferred.

## Worker API

```http
GET /health
GET /products/:joybuyProductId/prices?range=30d|90d
POST /products/observe
```

Minimal observe payload:

```json
{
  "joybuy_product_id": "10387040",
  "price": 229,
  "captured_at": "2026-08-26"
}
```

The Worker validates product ID and finite numeric price. It normalizes dates to `YYYY-MM-DD`. It refuses duplicate same-product same-day inserts by checking existing rows and via unique index:

```sql
idx_price_points_product_day(product_id, captured_at)
```

## Extension Behavior

Content script is injected on all `joybuy.de` pages.

On any Joybuy page:

- Passive capture runs every few seconds.
- It scans embedded Next.js script data containing patterns such as `self.__next_s` and `self.__next_f`.
- It extracts product IDs and prices from `/dp/...` links and nearby structured price fields.
- It posts minimal observations to the Worker.

On product detail pages:

- It inserts a compact floating price history panel.
- It shows current page price.
- It has 30 and 90 day tabs.
- It displays the lowest price for each range next to the tab.
- The plot is a simple point-line chart with x=date and y=price.
- X-axis labels use `mm-dd`.
- Untracked/no-history products still show the chart area with `No data`.

Known issue:

- Out-of-stock is not reliably tracked right now. If no price exists, no price point is written. Availability should not be used for decisions until a dedicated stock parser is added.

## Current Observed Database State

Last inspected during development:

```text
products: 429+
price_points: 321+
products.created_at/updated_at timestamp rows: 0
products.title non-null rows: 0
```

Counts will continue changing as the extension passively records more pages.

## Important Commands

Install:

```bash
npm install
```

Test:

```bash
npm test
```

Syntax checks:

```bash
node --check extension/content.js
node --check extension/background.js
node --check worker/src/index.js
```

Cloudflare login:

```bash
npx wrangler login
```

Apply remote migrations:

```bash
npm run db:migrate:remote
```

Deploy Worker:

```bash
npm run worker:deploy
```

Inspect D1:

```bash
npx wrangler d1 execute joybuy_price_history --remote --config worker/wrangler.toml --command "SELECT COUNT(*) FROM products;"

npx wrangler d1 execute joybuy_price_history --remote --config worker/wrangler.toml --command "SELECT COUNT(*) FROM price_points;"
```

Load extension:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Load unpacked.
4. Select `extension/`.
5. Reload the extension after changing local files.

## Migration History

- `0001_initial.sql`: original products and price_points schema.
- `0002_minimal_daily_points.sql`: clears product titles, converts price timestamps to dates, removes same-day duplicate price points, adds unique product/day index.
- `0003_product_dates.sql`: converts product created/updated timestamps to dates and clears titles.

## Recent Implementation Decisions

- Passive browsing is enough for now; do not prioritize VPS/Playwright crawling unless coverage becomes insufficient.
- URL is not required from extension requests anymore.
- Keep D1 schema compatibility for now; do table slimming later if storage matters.
- Do not record product names.
- Do not write error prices.
- Do not write duplicate same-product same-day records.