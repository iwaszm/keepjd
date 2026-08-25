# Joybuy Extraction Findings

Date: 2026-08-25

Public Joybuy listing pages expose product titles, visible euro prices, UVP/RRP prices, promo labels, seller text, and delivery or availability text in crawlable page content. That supports an initial Cloudflare Worker collector based on `fetch` plus HTML parsing.

Open validation item: product detail URLs still need fixture coverage from real detail pages. The parser currently supports URL identifiers from `/product/`, `/item/`, `/p/`, `/dp/`, common SKU query parameters, JSON fields such as `skuId` and `productId`, and common `data-*` attributes.

If detail pages hide prices behind client-rendered data, keep the Worker API and D1 schema unchanged and replace only the collector with a VPS or scheduled Playwright job.
