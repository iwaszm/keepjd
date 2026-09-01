# Joybuy Background Page Collector

This is a separate Ubuntu-oriented Chrome extension for background collection. It does not inject a chart panel and does not modify the normal `extension/` browser experience.

## Configure Target Pages

Edit `target-pages.js`:

```js
export const TARGET_PAGES = [
  { url: "https://www.joybuy.de/s?b1=5825", label: "常温食品", maxPage: 376 }
];
```

Each target is treated as a paginated listing URL. The collector processes targets in order. The first page of each target is read fully so the page can expose its own `pageCount` metadata. When detected, that page count becomes the target limit; the configured `maxPage` is only a fallback for pages where Joybuy does not expose usable pagination metadata.

String targets are still supported as a fallback. For those, the collector uses `MAX_PAGES_PER_TARGET` and any detected pagination numbers as hints.

## Run

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click `Load unpacked`.
4. Select this `background-extension/` folder.
5. Click the extension icon.
6. Click `Start collection`.

Progress is shown in the popup, stored in Chrome extension local storage under `joybuyBackgroundCollectorState`, and logged to the extension service worker console.

Pages that fail to fetch or return zero products are stored under `joybuyBackgroundCollectorFailedPages` for local debugging. In the service worker console, run:

```js
chrome.storage.local.get("joybuyBackgroundCollectorFailedPages").then(console.log);
```

## Behavior

- Fetches listing pages in the background with browser credentials.
- Parses only page HTML scripts containing `self.__next_s`, `self.__next_f`, product URLs, SKU IDs, or price fields.
- Extracts product IDs and prices from product-local script windows.
- Posts observations to `https://joybuy-price-history.zhangmeng43.workers.dev/products/observe`.
- Does not open listing tabs and does not click through product pages.
