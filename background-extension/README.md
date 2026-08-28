# Joybuy Background Page Collector

This is a separate Ubuntu-oriented Chrome extension for background collection. It does not inject a chart panel and does not modify the normal `extension/` browser experience.

## Configure Target Pages

Edit `target-pages.js`:

```js
export const TARGET_PAGES = [
  { url: "https://www.joybuy.de/s?b1=5825", label: "常温食品", maxPage: 376 }
];
```

Each target is treated as a paginated listing URL. The collector processes targets in order. When `maxPage` is set, it fetches every page up to that configured maximum before moving to the next target. This is preferred for Joybuy category pages because the rendered pagination can expose only a local page window such as pages 1-7, not the real category maximum.

String targets are still supported as a fallback. For those, the collector uses `MAX_PAGES_PER_TARGET` and any detected pagination numbers as hints.

## Run

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click `Load unpacked`.
4. Select this `background-extension/` folder.
5. Click the extension icon.
6. Click `Start collection`.

Progress is shown in the popup, stored in Chrome extension local storage under `joybuyBackgroundCollectorState`, and logged to the extension service worker console.

## Behavior

- Fetches listing pages in the background with browser credentials.
- Parses only page HTML scripts containing `self.__next_s`, `self.__next_f`, product URLs, SKU IDs, or price fields.
- Extracts product IDs and prices from product-local script windows.
- Posts observations to `https://joybuy-price-history.zhangmeng43.workers.dev/products/observe`.
- Does not open listing tabs and does not click through product pages.
