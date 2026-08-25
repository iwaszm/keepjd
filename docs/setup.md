# Setup

## Extension

1. Open Chrome Extensions.
2. Enable Developer Mode.
3. Click Load unpacked.
4. Select the `extension/` folder.
5. Update `API_BASE_URL` in `extension/content.js` after deploying the Worker.

The content script injects one compact panel on likely Joybuy product pages. It fetches historical points for 30 or 90 days. If the current product has not been collected yet, the panel remains visible and shows `No tracked history yet.`

## Worker

1. Install dependencies with `npm install`.
2. Create a D1 database with `wrangler d1 create joybuy_price_history`.
3. Replace the placeholder `database_id` in `worker/wrangler.toml`.
4. Apply `worker/migrations/0001_initial.sql`.
5. Deploy with `npm run worker:deploy`.

## Tracked Products

Set `TRACKED_PRODUCTS_JSON` in `worker/wrangler.toml` or as a Worker environment variable containing an array of objects:

```json
[
  { "url": "https://www.joybuy.de/product/example-sku" }
]
```

The checked-in `worker/tracked-products.json` is a starter checklist file. Production collection uses the `TRACKED_PRODUCTS_JSON` Worker variable. The deployed Worker currently runs collection once per day at `03:00 UTC`.

## Ubuntu Collector

For the one-week 100-product validation, use the Playwright collector instead of relying on Cloudflare Cron:

```bash
npm install
npx playwright install --with-deps chromium
npm run collect:login
npm run collect
```

The product list is `collector/tracked-products.json`. The collector uses a persistent browser profile at `collector/.browser-profile`, submits successful observations to `/products/observe`, and writes failures to `collector/logs/YYYY-MM-DD.ndjson`.

If collection redirects to `/login`, run `npm run collect:login` in the Ubuntu graphical session and complete login in the opened Chromium profile before scheduling cron.
