import {
  STREAM_EARLY_ABORT_ENABLED,
  STREAM_FULL_READ_FALLBACK_BYTES,
  STREAM_MIN_BYTES
} from "./config.js";
import { extractSearchPageObservations } from "./parser.js";

export async function fetchSearchPageHtml(pageUrl, allowEarlyAbort) {
  const response = await fetch(pageUrl, {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  if (!allowEarlyAbort || !STREAM_EARLY_ABORT_ENABLED || !response.body) {
    const html = await response.text();
    return { html, partialRead: false, bytesRead: html.length };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytesRead = 0;
  let earlyAbortAvailable = true;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    bytesRead += value.byteLength;
    html += decoder.decode(value, { stream: true });

    if (earlyAbortAvailable && bytesRead >= STREAM_MIN_BYTES && canExtractProductsFromPartialHtml(html)) {
      await reader.cancel();
      html += decoder.decode();
      return { html, partialRead: true, bytesRead };
    }

    if (earlyAbortAvailable && bytesRead >= STREAM_FULL_READ_FALLBACK_BYTES && !hasProductNextScriptStart(html)) {
      earlyAbortAvailable = false;
    }
  }

  html += decoder.decode();
  return { html, partialRead: false, bytesRead };
}

function hasProductNextScriptStart(html) {
  return /<script\b[^>]*>[\s\S]*self\.__next_[sf][\s\S]*(?:\/dp\/|skuId|productId|wareId|price)/i.test(html);
}

function canExtractProductsFromPartialHtml(html) {
  return extractSearchPageObservations(html).length > 0;
}
