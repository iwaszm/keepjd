# Joybuy Price History Tracker

A lightweight Keepa-style MVP for `joybuy.de`: a Chrome Manifest V3 extension injects a price history module on Joybuy product pages, while a Cloudflare Worker API stores and serves historical price points from D1.

## Project Layout

- `extension/` - Chrome MV3 content script, injected UI, and styles.
- `worker/` - Cloudflare Worker API, cron collector, D1 migrations, and seed product list.
- `shared/` - Joybuy URL, product ID, and price extraction helpers.
- `tests/` - Node built-in test suite for parser and API-independent behavior.
- `docs/` - setup notes and Joybuy extraction findings.

## Local Setup

```bash
npm install
npm test
npm run db:migrate:local
npm run worker:dev
```

Then load `extension/` as an unpacked extension in Chrome. For local API testing, edit `extension/content.js` and set `API_BASE_URL` to the local Worker URL shown by Wrangler.

## Cloudflare Setup

1. Create a D1 database:

   ```bash
   wrangler d1 create joybuy_price_history
   ```

2. Copy the returned `database_id` into `worker/wrangler.toml`.
3. Add tracked Joybuy product URLs to `worker/tracked-products.json`.
4. Apply migrations and deploy:

   ```bash
   npm run db:migrate:remote
   npm run worker:deploy
   ```

## MVP Notes

- Historical data begins after deployment; this MVP does not backfill old prices.
- The extension reads history only. It does not auto-track arbitrary products, so untracked product pages keep the chart slot and show an empty-data state.
- The Worker cron tracks the 10 product URLs configured in `TRACKED_PRODUCTS_JSON` once per day when Joybuy allows server-side fetches. The Chrome extension also records visible prices for those same 10 tracked product IDs when the user visits them.
- The Worker collector uses `fetch` and HTML parsing first. If Joybuy product pages require browser rendering, keep the API/D1 contract and move only the collector to a VPS/Playwright process.

## Ubuntu Playwright Collector

The `collector/` folder contains a 100-product validation collector intended to run once per day from an Ubuntu machine.

```bash
npm install
npx playwright install --with-deps chromium
npm run collect:login
npm run collect
```

Daily cron example:

```cron
0 6 * * * cd /path/to/joybuy-price-history-tracker && /usr/bin/npm run collect >> collector/logs/cron.log 2>&1
```

The product list is `collector/tracked-products.json`. Successful captures are submitted to `/products/observe`; failures are written as newline-delimited JSON under `collector/logs/YYYY-MM-DD.ndjson` and are not submitted.

If logs show `login_required`, run `npm run collect:login` on the Ubuntu desktop, sign in to Joybuy in the opened Chromium window, confirm any region prompt, then press Enter in the terminal. The collector reuses the saved profile in `collector/.browser-profile`.
