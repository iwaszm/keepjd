# Joybuy Background Page Collector

This is a separate Ubuntu-oriented Chrome extension for background collection. It does not inject a chart panel and does not modify the normal `extension/` browser experience.

## Configure Seeds

Edit `config.js`:

```js
export const SEED_PAGES = [
  "https://www.joybuy.de/s?k=%E4%B8%96%E7%95%8C%E9%A3%9F%E5%93%81&l1=2411&page=1"
];
```

Each seed is treated as a paginated listing URL. The collector replaces the `page` query parameter with `1, 2, 3...` and stops when it reaches `MAX_PAGES_PER_SEED` or sees a duplicate/empty page.

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
