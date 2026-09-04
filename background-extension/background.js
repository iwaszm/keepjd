import {
  API_BASE_URL,
  BATCH_FLUSH_SIZE,
  FORBIDDEN_COOLDOWN_BASE_MINUTES,
  FORBIDDEN_COOLDOWN_MAX_AUTO_RESUMES,
  FORBIDDEN_PROBE_TIMEOUT_MS,
  FORBIDDEN_PROBE_URL,
  MAX_PAGES_PER_TARGET,
  MAX_PAGE_RETRIES,
  OBSERVATION_DELAY_MS,
  OBSERVE_BATCH_TIMEOUT_MS,
  PAGE_FETCH_CONCURRENCY,
  PAGE_FETCH_TIMEOUT_MS,
  PAGE_DELAY_MAX_MS,
  PAGE_DELAY_MIN_MS,
  PAGES_PER_ALARM_TICK,
  RETRY_DELAY_MS,
  SNAPSHOT_SAVE_INTERVAL_PAGES,
  STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES,
  WRITE_UNCHANGED_OBSERVATIONS
} from "./config.js";
import { TARGET_PAGES } from "./target-pages.js";
import { fetchSearchPageHtml } from "./stream-fetch.js";
import {
  buildPageUrl,
  describeSearchPageHtml,
  extractMaxPageNumber,
  extractPageCountNumber,
  extractSearchPageObservations,
  pageNumberFromSeed
} from "./parser.js";

const ALARM_NAME = "joybuy-background-page-collector";
const STORAGE_KEY = "joybuyBackgroundCollectorState";
const SNAPSHOT_CACHE_KEY = "joybuyBackgroundCollectorSnapshots";
const PENDING_OBSERVATIONS_KEY = "joybuyBackgroundCollectorPendingObservations";
const FAILED_PAGES_KEY = "joybuyBackgroundCollectorFailedPages";
const MAX_FAILED_PAGE_RECORDS = 1000;
const OBSERVE_BATCH_URL = `${API_BASE_URL}/products/observe-batch`;
const TARGET_SUMMARY_URL = `${API_BASE_URL}/collector/target-summary`;
const MISSING_PRICE_POINTS_URL = `${API_BASE_URL}/products/missing-price-points?limit=10000`;
const activeFetchControllers = new Set();
let pauseAbortRequested = false;
let failedPageRecordChain = Promise.resolve();

console.info("Joybuy background collector service worker loaded");

chrome.runtime.onInstalled.addListener(() => {
  console.info("Joybuy background collector installed");
  restoreCollectionState("installed").catch((error) => {
    console.error("Joybuy background collector restore failed", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  console.info("Joybuy background collector startup");
  restoreCollectionState("startup").catch((error) => {
    console.error("Joybuy background collector startup restore failed", error);
  });
});

chrome.action.onClicked.addListener(() => {
  startCollection("manual_click").catch((error) => {
    console.error("Joybuy background collection failed to start", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_COLLECTION") {
    startCollection("popup").then(() => sendResponse({ ok: true })).catch((error) => {
      console.error("Joybuy background collection failed to start", error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "GET_STATE") {
    loadStateWithPendingCount().then((state) => sendResponse({ ok: true, state })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "PAUSE_COLLECTION") {
    pauseCollection().then(() => sendResponse({ ok: true })).catch((error) => {
      console.error("Joybuy background collection failed to pause", error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "RESUME_COLLECTION") {
    resumeCollection().then(() => sendResponse({ ok: true })).catch((error) => {
      console.error("Joybuy background collection failed to resume", error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  processQueue().catch((error) => {
    console.error("Joybuy background collection tick failed", error);
  });
});

async function startCollection(reason) {
  console.info("Joybuy background collection starting", { reason, targets: TARGET_PAGES.length });
  await chrome.alarms.clear(ALARM_NAME);
  pauseAbortRequested = false;
  const pending = await loadPendingObservations();
  const missingPricePointProductIds = await fetchMissingPricePointProductIds();
  await saveFailedPageRecords([]);
  await setBadge("RUN", "#2563eb");
  const startedAt = new Date().toISOString();
  const queue = shuffleTargets(TARGET_PAGES).map((entry, index) => {
    const normalizedTarget = normalizeTarget(entry.target);
    const startPage = pageNumberFromSeed(normalizedTarget.url);
    return {
      targetIndex: index + 1,
      originalTargetIndex: entry.originalIndex + 1,
      targetUrl: normalizedTarget.url,
      targetLabel: normalizedTarget.label,
      startPage,
      nextPage: startPage,
      maxPage: normalizedTarget.maxPage ?? startPage + MAX_PAGES_PER_TARGET - 1,
      configuredMaxPage: normalizedTarget.maxPage ?? null,
      seenProductIds: [],
      emptyPages: 0,
      pagesFetched: 0,
      observationsFound: 0,
      observationsPosted: 0,
      observationsSkipped: 0,
      forbiddenPages: 0,
      zeroProductPages: 0,
      done: false
    };
  });

  await saveState({
    running: true,
    reason,
    startedAt,
    updatedAt: startedAt,
    queue,
    totals: {
      pagesFetched: 0,
      observationsFound: 0,
      observationsPosted: 0,
      partialReads: 0,
      uploadingObservations: 0,
      zeroProductPages: 0,
      missingPricePointBackfillRemaining: missingPricePointProductIds.length,
      observationsBuffered: pending.length,
      observationsSkipped: 0,
      observationsFailed: 0,
      targetsDone: 0
    },
    missingPricePointProductIds,
    forbiddenCooldownCount: 0,
    autoPauseReason: null,
    autoResumeAt: null,
    lastError: null
  });

  await processQueue();
}

async function processQueue() {
  const state = await loadState();
  if (state.paused && state.autoPauseReason === "forbidden") {
    if (!isAutoResumeReady(state)) {
      scheduleForbiddenResume(state);
      return;
    }
    const probe = await probeForbiddenRecovery(currentQueuePageUrl(state));
    if (!probe.ok) {
      deferForbiddenCooldown(state, probe.error);
      await saveState(state);
      scheduleForbiddenResume(state);
      await setBadge("403", "#b91c1c");
      return;
    }
    resumeForbiddenCooldown(state);
    await saveState(state);
  }

  if (!state.running || state.paused) return;
  await setBadge("RUN", "#2563eb");

  const snapshotCache = await loadSnapshotCache();
  let snapshotDirty = false;
  let pagesLeft = PAGES_PER_ALARM_TICK;
  while (pagesLeft > 0) {
    const item = state.queue.find((entry) => !entry.done);
    if (!item) {
      if (snapshotDirty) await saveSnapshotCache(snapshotCache);
      await flushPendingObservations(state);
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.updatedAt = state.finishedAt;
      await saveState(state);
      chrome.alarms.clear(ALARM_NAME);
      await setBadge("OK", "#15803d");
      console.info("Joybuy background collection finished", state.totals);
      return;
    }

    const needsFullFirstPageForPageCount = !item.maxPageDetected && (item.pagesFetched || 0) === 0;
    const pageCount = needsFullFirstPageForPageCount ? 1 : Math.min(PAGE_FETCH_CONCURRENCY, pagesLeft);
    const result = await collectPages(state, item, snapshotCache, pageCount);
    snapshotDirty = snapshotDirty || result.snapshotDirty;
    state.updatedAt = new Date().toISOString();
    await saveProgressState(state);
    const latestState = await loadState();
    if (!latestState.running || latestState.paused) {
      if (snapshotDirty) await saveSnapshotCache(snapshotCache);
      if (latestState.paused && latestState.autoPauseReason === "forbidden") {
        scheduleForbiddenResume(latestState);
        await setBadge("403", "#b91c1c");
      } else {
        chrome.alarms.clear(ALARM_NAME);
        await setBadge(latestState.paused ? "PAUSE" : "", latestState.paused ? "#a16207" : "#6b7280");
      }
      return;
    }

    if (!result.didProcessPage) break;

    pagesLeft -= result.pagesProcessed;
    if (snapshotDirty && state.totals.pagesFetched % SNAPSHOT_SAVE_INTERVAL_PAGES === 0) {
      await saveSnapshotCache(snapshotCache);
      snapshotDirty = false;
    }
    if (pagesLeft > 0) await sleep(randomPageDelayMs());
  }

  if (snapshotDirty) await saveSnapshotCache(snapshotCache);
  state.updatedAt = new Date().toISOString();
  await saveState(state);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
}

async function pauseCollection() {
  const state = await loadState();
  if (!state.running) return;

  pauseAbortRequested = true;
  abortActiveFetches();
  state.running = false;
  state.paused = true;
  state.pausedAt = new Date().toISOString();
  state.updatedAt = state.pausedAt;
  state.autoPauseReason = null;
  state.autoResumeAt = null;
  await saveState(state);
  chrome.alarms.clear(ALARM_NAME);
  await setBadge("PAUSE", "#a16207");
  flushPendingObservations(state).then(async () => {
    state.updatedAt = new Date().toISOString();
    await saveState(state);
  }).catch((error) => {
    console.error("Joybuy background collection failed to flush pending observations while pausing", error);
  });
}

async function resumeCollection() {
  const state = await loadState();
  const hasPendingQueue = (state.queue || []).some((entry) => !entry.done);
  if (!state.paused || !hasPendingQueue) return;

  if (state.autoPauseReason === "forbidden") {
    const probe = await probeForbiddenRecovery(currentQueuePageUrl(state));
    if (!probe.ok) {
      deferForbiddenCooldown(state, probe.error, { incrementCount: false });
      await saveState(state);
      scheduleForbiddenResume(state);
      await setBadge("403", "#b91c1c");
      return;
    }
  }

  pauseAbortRequested = false;
  state.running = true;
  state.paused = false;
  state.pausedAt = null;
  state.autoPauseReason = null;
  state.autoResumeAt = null;
  state.resumedAt = new Date().toISOString();
  state.updatedAt = state.resumedAt;
  state.finishedAt = null;
  await saveState(state);
  await setBadge("RUN", "#2563eb");
  await processQueue();
}

function abortActiveFetches() {
  for (const controller of activeFetchControllers) {
    controller.abort(new Error("collection paused"));
  }
  activeFetchControllers.clear();
}

async function collectPages(state, item, snapshotCache, pageCount) {
  if (item.nextPage > item.maxPage) {
    await markTargetDone(state, item, "max_page_reached");
    return { didProcessPage: true, pagesProcessed: 0, snapshotDirty: false };
  }

  if (item.retryAfter && Date.parse(item.retryAfter) > Date.now()) {
    return { didProcessPage: false, pagesProcessed: 0, snapshotDirty: false };
  }

  const startPage = item.nextPage;
  const endPage = Math.min(item.maxPage, startPage + pageCount - 1);
  const pageNumbers = [];
  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    pageNumbers.push(pageNumber);
  }

  console.info("Joybuy collector fetching pages", {
    targetIndex: item.targetIndex,
    startPage,
    endPage,
    concurrency: pageNumbers.length
  });

  const fetchedPages = await Promise.all(pageNumbers.map(async (pageNumber) => {
    const pageUrl = buildPageUrl(item.targetUrl, pageNumber);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`page fetch timeout after ${PAGE_FETCH_TIMEOUT_MS}ms`));
    }, PAGE_FETCH_TIMEOUT_MS);
    activeFetchControllers.add(controller);
    try {
      const needsPageCount = !item.maxPageDetected && pageNumber === (item.startPage || 1);
      const page = await fetchSearchPageHtml(pageUrl, !needsPageCount, { signal: controller.signal });
      return { ok: true, pageNumber, pageUrl, page };
    } catch (error) {
      if (pauseAbortRequested) return { ok: false, paused: true, pageNumber, pageUrl, error };
      return { ok: false, pageNumber, pageUrl, error };
    } finally {
      clearTimeout(timeoutId);
      activeFetchControllers.delete(controller);
    }
  }));

  let pagesProcessed = 0;
  let snapshotDirty = false;
  const seen = new Set(item.seenProductIds);
  const missingPricePointProductIds = new Set(state.missingPricePointProductIds || []);
  const observationsToPost = [];
  let skippedCountTotal = 0;
  let pageErrorHit = false;

  for (const fetched of fetchedPages) {
    if (fetched.paused) {
      return { didProcessPage: false, pagesProcessed, snapshotDirty };
    }

    if (!fetched.ok) {
      handlePageError(state, item, fetched.pageUrl, fetched.pageNumber, fetched.error);
      pageErrorHit = true;
      break;
    }

    const pageResult = processFetchedPage(state, item, fetched, snapshotCache, seen, missingPricePointProductIds);
    pagesProcessed += 1;
    snapshotDirty = snapshotDirty || pageResult.snapshotDirty;
    skippedCountTotal += pageResult.skippedCount;
    observationsToPost.push(...pageResult.observationsToPost);

    if (pageResult.shouldPause) {
      break;
    }

    if (!item.maxPageDetected && item.emptyPages >= STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES) {
      break;
    }

    if (item.nextPage > item.maxPage) {
      break;
    }
  }

  let postedCount = 0;
  if (observationsToPost.length) {
    const queuedCount = await queuePendingObservations(observationsToPost);
    state.totals.observationsBuffered = queuedCount;
    if (queuedCount >= BATCH_FLUSH_SIZE) {
      postedCount = await flushPendingObservations(state);
    }
    if (OBSERVATION_DELAY_MS > 0) await sleep(OBSERVATION_DELAY_MS);
  }

  item.seenProductIds = [...seen];
  item.observationsPosted = (item.observationsPosted || 0) + postedCount;
  item.lastBatchPageCount = pagesProcessed;
  item.lastBatchQueuedObservationCount = observationsToPost.length;
  item.lastBatchPostedObservationCount = postedCount;
  item.lastBatchSkippedObservationCount = skippedCountTotal;
  state.missingPricePointProductIds = [...missingPricePointProductIds];
  state.totals.missingPricePointBackfillRemaining = missingPricePointProductIds.size;

  if (state.paused) {
    return { didProcessPage: true, pagesProcessed, snapshotDirty };
  }

  if (pageErrorHit) {
    return { didProcessPage: false, pagesProcessed, snapshotDirty };
  }

  if (!item.maxPageDetected && item.emptyPages >= STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES) {
    const finalPostedCount = await flushPendingObservations(state);
    item.observationsPosted = (item.observationsPosted || 0) + finalPostedCount;
    await markTargetDone(state, item, "empty_page_stop");
  } else if (item.nextPage > item.maxPage) {
    const finalPostedCount = await flushPendingObservations(state);
    item.observationsPosted = (item.observationsPosted || 0) + finalPostedCount;
    await markTargetDone(state, item, "max_page_reached");
  }

  return { didProcessPage: true, pagesProcessed, snapshotDirty };
}

function processFetchedPage(state, item, fetched, snapshotCache, seen, missingPricePointProductIds) {
  const html = fetched.page.html;
  const detectedMaxPage = extractMaxPageNumber(html);
  const detectedPageCount = extractPageCountNumber(html);
  if (detectedPageCount !== null) {
    item.detectedMaxPage = detectedPageCount;
    item.maxPageDetected = true;
    item.maxPage = detectedPageCount;
  } else if (!item.configuredMaxPage && detectedMaxPage !== null) {
    item.detectedMaxPage = detectedMaxPage;
    item.maxPageDetected = true;
    item.maxPage = Math.max(item.maxPage, detectedMaxPage);
  }

  const observations = extractSearchPageObservations(html);
  const targetSnapshotCache = targetCacheFor(snapshotCache, item);
  const freshObservations = observations.filter((observation) => !seen.has(observation.joybuy_product_id));
  const observationsToPost = [];
  let skippedCount = 0;

  for (const observation of freshObservations) {
    if (shouldPostObservation(observation, targetSnapshotCache, snapshotCache, missingPricePointProductIds)) {
      observationsToPost.push(observation);
      missingPricePointProductIds.delete(observation.joybuy_product_id);
    } else {
      skippedCount += 1;
    }

    updateSnapshotCache(targetSnapshotCache, observation);
    seen.add(observation.joybuy_product_id);
  }

  item.emptyPages = observations.length ? 0 : (item.emptyPages || 0) + 1;
  if (!observations.length) {
    state.totals.zeroProductPages = (state.totals.zeroProductPages || 0) + 1;
    state.totals.observationsFailed += 1;
    item.zeroProductPages = (item.zeroProductPages || 0) + 1;
    item.lastZeroProductPageUrl = fetched.pageUrl;
    state.lastZeroProductPageUrl = fetched.pageUrl;
    const diagnostics = describeSearchPageHtml(html);
    if (diagnostics.hasForbiddenText) {
      item.forbiddenPages = (item.forbiddenPages || 0) + 1;
      autoPauseCollection(state, item, `auto paused after forbidden page: ${fetched.pageUrl}`);
    }
    recordFailedPage({
      reason: "zero_products",
      pageUrl: fetched.pageUrl,
      pageNumber: fetched.pageNumber,
      targetIndex: item.targetIndex,
      targetLabel: item.targetLabel,
      targetUrl: item.targetUrl,
      detectedMaxPage,
      detectedPageCount,
      maxPage: item.maxPage,
      partialRead: fetched.page.partialRead,
      bytesRead: fetched.page.bytesRead,
      diagnostics
    }).catch((error) => {
      console.error("Joybuy collector failed to record zero product page", error);
    });
  }
  item.lastPageUrl = fetched.pageUrl;
  item.lastPagePartialRead = fetched.page.partialRead;
  item.lastPageBytesRead = fetched.page.bytesRead;
  item.lastPageObservationCount = observations.length;
  item.lastPageFreshObservationCount = freshObservations.length;
  item.lastPagePostedObservationCount = 0;
  item.lastPageQueuedObservationCount = observationsToPost.length;
  item.lastPageSkippedObservationCount = skippedCount;
  item.retryCount = 0;
  item.retryAfter = null;
  item.nextPage = fetched.pageNumber + 1;

  item.pagesFetched = (item.pagesFetched || 0) + 1;
  item.observationsFound = (item.observationsFound || 0) + observations.length;
  item.observationsSkipped = (item.observationsSkipped || 0) + skippedCount;

  state.totals.pagesFetched += 1;
  state.totals.observationsFound += observations.length;
  state.totals.partialReads = (state.totals.partialReads || 0) + (fetched.page.partialRead ? 1 : 0);
  state.totals.observationsSkipped = (state.totals.observationsSkipped || 0) + skippedCount;

  console.info("Joybuy collector page result", {
    pageUrl: fetched.pageUrl,
    partialRead: fetched.page.partialRead,
    bytesRead: fetched.page.bytesRead,
    targetIndex: item.targetIndex,
    detectedMaxPage,
    detectedPageCount,
    maxPage: item.maxPage,
    nextPage: item.nextPage,
    observations: observations.length,
    freshObservations: freshObservations.length,
    queuedObservations: observationsToPost.length,
    skippedObservations: skippedCount,
    totals: state.totals
  });

  return {
    observationsToPost,
    skippedCount,
    shouldPause: state.paused,
    snapshotDirty: freshObservations.length > 0
  };
}

function handlePageError(state, item, pageUrl, pageNumber, error) {
  item.lastError = `${pageUrl}: ${error.message}`;
  state.lastError = item.lastError;
  state.totals.observationsFailed += 1;
  if (/\bHTTP 403\b/i.test(error.message)) {
    item.forbiddenPages = (item.forbiddenPages || 0) + 1;
    autoPauseCollection(state, item, `auto paused after HTTP 403: ${pageUrl}`);
  }
  recordFailedPage({
    reason: "fetch_error",
    pageUrl,
    pageNumber,
    targetIndex: item.targetIndex,
    targetLabel: item.targetLabel,
    targetUrl: item.targetUrl,
    maxPage: item.maxPage,
    error: error.message
  }).catch((recordError) => {
    console.error("Joybuy collector failed to record failed page", recordError);
  });
  if (state.paused) {
    console.error("Joybuy collector page failed", item.lastError);
    return;
  }
  item.retryCount = (item.retryCount || 0) + 1;
  if (item.retryCount > MAX_PAGE_RETRIES) {
    item.lastSkippedPageUrl = pageUrl;
    item.nextPage = pageNumber + 1;
    item.retryCount = 0;
    item.retryAfter = null;
  } else {
    item.nextPage = pageNumber;
    item.retryAfter = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
  }
  setBadge("ERR", "#b91c1c").catch((badgeError) => {
    console.error("Joybuy collector badge update failed", badgeError);
  });
  console.error("Joybuy collector page failed", item.lastError);
}

function autoPauseCollection(state, item, message) {
  const now = new Date().toISOString();
  const cooldownCount = (state.forbiddenCooldownCount || 0) + 1;
  const cooldownMinutes = FORBIDDEN_COOLDOWN_BASE_MINUTES;
  const shouldAutoResume = cooldownCount <= FORBIDDEN_COOLDOWN_MAX_AUTO_RESUMES;
  const autoResumeAt = shouldAutoResume
    ? new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString()
    : null;

  pauseAbortRequested = true;
  abortActiveFetches();
  state.running = false;
  state.paused = true;
  state.pausedAt = now;
  state.updatedAt = now;
  state.autoPausedAt = now;
  state.autoPauseReason = "forbidden";
  state.autoResumeAt = autoResumeAt;
  state.forbiddenCooldownCount = cooldownCount;
  state.lastError = autoResumeAt
    ? `${message}; cooling down ${cooldownMinutes}m until ${autoResumeAt}`
    : `${message}; max 403 cooldown attempts reached, manual restart required`;
  item.retryAfter = null;
  item.lastError = state.lastError;
  item.forbiddenCooldownCount = cooldownCount;
  setBadge("403", "#b91c1c").catch((badgeError) => {
    console.error("Joybuy collector badge update failed", badgeError);
  });
  scheduleForbiddenResume(state);
}

async function probeForbiddenRecovery(probeUrl = FORBIDDEN_PROBE_URL) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`forbidden probe timeout after ${FORBIDDEN_PROBE_TIMEOUT_MS}ms`));
  }, FORBIDDEN_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(probeUrl, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, error: `probe HTTP ${response.status}: ${probeUrl}` };

    const html = await response.text();
    const diagnostics = describeSearchPageHtml(html);
    if (diagnostics.hasForbiddenText) return { ok: false, error: `probe returned forbidden page: ${probeUrl}` };

    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${error.message}: ${probeUrl}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

function deferForbiddenCooldown(state, error, options = {}) {
  const now = new Date().toISOString();
  const incrementCount = options.incrementCount !== false;
  const cooldownCount = (state.forbiddenCooldownCount || 0) + (incrementCount ? 1 : 0);
  const shouldAutoResume = cooldownCount <= FORBIDDEN_COOLDOWN_MAX_AUTO_RESUMES;
  const autoResumeAt = shouldAutoResume
    ? new Date(Date.now() + FORBIDDEN_COOLDOWN_BASE_MINUTES * 60 * 1000).toISOString()
    : null;
  const item = state.queue?.find((entry) => !entry.done);

  state.running = false;
  state.paused = true;
  state.pausedAt = now;
  state.updatedAt = now;
  state.autoPausedAt = now;
  state.autoPauseReason = "forbidden";
  state.autoResumeAt = autoResumeAt;
  state.forbiddenCooldownCount = cooldownCount;
  state.lastError = autoResumeAt
    ? `forbidden recovery probe failed: ${error}; cooling down ${FORBIDDEN_COOLDOWN_BASE_MINUTES}m until ${autoResumeAt}`
    : `forbidden recovery probe failed: ${error}; max 403 cooldown attempts reached, manual restart required`;

  if (item) {
    item.lastError = state.lastError;
    item.forbiddenCooldownCount = cooldownCount;
  }
}

function currentQueuePageUrl(state) {
  const item = state.queue?.find((entry) => !entry.done);
  if (!item) return FORBIDDEN_PROBE_URL;
  return buildPageUrl(item.targetUrl, item.nextPage || item.startPage || 1);
}

function isAutoResumeReady(state) {
  if (!state.autoResumeAt) return false;
  const autoResumeAt = Date.parse(state.autoResumeAt);
  return Number.isFinite(autoResumeAt) && autoResumeAt <= Date.now();
}

function resumeForbiddenCooldown(state) {
  const now = new Date().toISOString();
  pauseAbortRequested = false;
  state.running = true;
  state.paused = false;
  state.pausedAt = null;
  state.autoPauseReason = null;
  state.autoResumeAt = null;
  state.resumedAt = now;
  state.updatedAt = now;
  state.lastError = null;
}

function scheduleForbiddenResume(state) {
  if (!state.autoResumeAt) return;
  const when = Date.parse(state.autoResumeAt);
  if (!Number.isFinite(when)) return;
  chrome.alarms.create(ALARM_NAME, { when });
}

async function postObservations(observations) {
  let postedCount = 0;
  for (let index = 0; index < observations.length; index += BATCH_FLUSH_SIZE) {
    postedCount += await postObservationChunk(observations.slice(index, index + BATCH_FLUSH_SIZE));
  }
  return postedCount;
}

async function postObservationChunk(observations) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`observe batch timeout after ${OBSERVE_BATCH_TIMEOUT_MS}ms`));
  }, OBSERVE_BATCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(OBSERVE_BATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ observations }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) throw new Error(`observe batch failed: HTTP ${response.status}`);

  const body = await response.json().catch(() => null);
  if (!body?.ok) throw new Error(`observe batch failed: ${body?.failed ?? "unknown"}`);
  return body.inserted ?? observations.length;
}

async function reportTargetSummary(state, item) {
  const payload = {
    run_started_at: state.startedAt,
    run_finished_at: state.finishedAt || item.doneAt || new Date().toISOString(),
    target_index: item.targetIndex,
    original_target_index: item.originalTargetIndex ?? item.targetIndex,
    label: item.targetLabel || "",
    url: item.targetUrl,
    configured_max_page: item.configuredMaxPage,
    latest_max_page: item.detectedMaxPage || item.maxPage || null,
    pages_fetched: item.pagesFetched || 0,
    zero_product_pages: item.zeroProductPages || 0,
    forbidden_pages: item.forbiddenPages || 0,
    items_found: item.observationsFound || 0,
    posted: item.observationsPosted || 0,
    skipped: item.observationsSkipped || 0,
    done_reason: item.doneReason || "",
    last_page: item.lastPageUrl || null,
    last_error: item.lastError || null
  };

  try {
    const response = await fetch(TARGET_SUMMARY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json().catch(() => null);
    if (!body?.ok) throw new Error(body?.error || "invalid target summary response");
    item.summaryPostedAt = new Date().toISOString();
  } catch (error) {
    item.summaryPostError = error.message;
    console.error("Joybuy collector failed to report target summary", { payload, error });
  }
}

async function markTargetDone(state, item, reason) {
  if (item.done) return;
  item.done = true;
  item.doneAt = new Date().toISOString();
  item.doneReason = reason;
  state.totals.targetsDone += 1;
  await reportTargetSummary(state, item);
}

async function setIdleStatus(reason) {
  const now = new Date().toISOString();
  await setBadge("", "#6b7280");
  await saveState({
    running: false,
    paused: false,
    reason,
    updatedAt: now,
    queue: [],
    totals: {
      pagesFetched: 0,
      observationsFound: 0,
      observationsPosted: 0,
      observationsBuffered: 0,
      partialReads: 0,
      uploadingObservations: 0,
      zeroProductPages: 0,
      missingPricePointBackfillRemaining: 0,
      observationsSkipped: 0,
      observationsFailed: 0,
      targetsDone: 0
    },
    lastError: null
  });
}

async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(data[STORAGE_KEY] || { running: false });
}

async function loadStateWithPendingCount() {
  const state = await loadState();
  const pending = await loadPendingObservations();
  const failedPages = await loadFailedPageRecords();
  state.totals = state.totals || {};
  state.totals.observationsBuffered = pending.length;
  state.totals.failedPageRecords = failedPages.length;
  state.recentFailedPages = failedPages.slice(-10);
  return state;
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function queuePendingObservations(observations) {
  const pending = await loadPendingObservations();
  const byProductId = new Map(pending.map((observation) => [observation.joybuy_product_id, observation]));
  for (const observation of observations) {
    byProductId.set(observation.joybuy_product_id, observation);
  }
  const nextPending = [...byProductId.values()];
  await savePendingObservations(nextPending);
  return nextPending.length;
}

async function flushPendingObservations(state = null) {
  const pending = await loadPendingObservations();
  if (!pending.length) {
    if (state) {
      state.totals.observationsBuffered = 0;
      state.totals.uploadingObservations = 0;
    }
    return 0;
  }

  if (state) {
    state.totals.uploadingObservations = Math.min(BATCH_FLUSH_SIZE, pending.length);
    state.totals.observationsBuffered = pending.length;
    state.lastUploadStartedAt = new Date().toISOString();
    await saveState(state);
  }

  let remaining = pending;
  let totalPosted = 0;
  try {
    while (remaining.length) {
      const chunk = remaining.slice(0, BATCH_FLUSH_SIZE);
      if (state) {
        state.totals.uploadingObservations = chunk.length;
        state.totals.observationsBuffered = remaining.length;
        await saveState(state);
      }

      const postedCount = await postObservationChunk(chunk);
      totalPosted += postedCount;
      remaining = remaining.slice(chunk.length);
      await savePendingObservations(remaining);

      if (state) {
        state.totals.observationsPosted = (state.totals.observationsPosted || 0) + postedCount;
        state.totals.observationsBuffered = remaining.length;
        state.totals.uploadingObservations = 0;
        state.lastUploadFinishedAt = new Date().toISOString();
        await saveState(state);
      }
    }

    return totalPosted;
  } catch (error) {
    if (state) {
      state.totals.uploadingObservations = 0;
      state.totals.observationsBuffered = remaining.length;
      state.lastUploadFailedAt = new Date().toISOString();
      state.lastError = `upload failed: ${error.message}`;
      await saveState(state);
    }
    throw error;
  }
}

async function loadPendingObservations() {
  const data = await chrome.storage.local.get(PENDING_OBSERVATIONS_KEY);
  return Array.isArray(data[PENDING_OBSERVATIONS_KEY]) ? data[PENDING_OBSERVATIONS_KEY] : [];
}

async function fetchMissingPricePointProductIds() {
  try {
    const response = await fetch(MISSING_PRICE_POINTS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body?.ok || !Array.isArray(body.joybuy_product_ids)) {
      throw new Error("invalid missing price points response");
    }
    console.info("Joybuy missing price point products loaded", { count: body.joybuy_product_ids.length });
    return body.joybuy_product_ids;
  } catch (error) {
    console.error("Joybuy missing price point products failed to load", error);
    return [];
  }
}

async function savePendingObservations(observations) {
  await chrome.storage.local.set({ [PENDING_OBSERVATIONS_KEY]: observations });
}

async function loadFailedPageRecords() {
  const data = await chrome.storage.local.get(FAILED_PAGES_KEY);
  return Array.isArray(data[FAILED_PAGES_KEY]) ? data[FAILED_PAGES_KEY] : [];
}

async function saveFailedPageRecords(records) {
  await chrome.storage.local.set({ [FAILED_PAGES_KEY]: records });
}

async function recordFailedPage(record) {
  failedPageRecordChain = failedPageRecordChain.catch(() => null).then(async () => {
    const records = await loadFailedPageRecords();
    records.push({
      capturedAt: new Date().toISOString(),
      ...record
    });
    const trimmedRecords = records.slice(-MAX_FAILED_PAGE_RECORDS);
    await saveFailedPageRecords(trimmedRecords);
  });
  return failedPageRecordChain;
}

async function saveProgressState(state) {
  const latest = await loadState();
  if (latest.paused) {
    state.running = false;
    state.paused = true;
    state.pausedAt = latest.pausedAt || new Date().toISOString();
  }
  await saveState(state);
}

async function restoreCollectionState(reason) {
  const state = await loadState();
  if (!state.queue?.length) {
    await setIdleStatus(reason);
    return;
  }

  if (state.paused) {
    if (state.autoPauseReason === "forbidden") {
      scheduleForbiddenResume(state);
      await setBadge("403", "#b91c1c");
    } else {
      await setBadge("PAUSE", "#a16207");
    }
    return;
  }

  if (state.running) {
    state.updatedAt = new Date().toISOString();
    await saveState(state);
    await setBadge("RUN", "#2563eb");
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
    return;
  }

  if (state.finishedAt) {
    await setBadge("OK", "#15803d");
    return;
  }

  await setBadge("", "#6b7280");
}

async function loadSnapshotCache() {
  const data = await chrome.storage.local.get(SNAPSHOT_CACHE_KEY);
  return data[SNAPSHOT_CACHE_KEY] || {};
}

async function saveSnapshotCache(cache) {
  await chrome.storage.local.set({ [SNAPSHOT_CACHE_KEY]: cache });
}

function shouldPostObservation(observation, targetCache, rootCache, missingPricePointProductIds = new Set()) {
  if (missingPricePointProductIds.has(observation.joybuy_product_id)) return true;
  if (WRITE_UNCHANGED_OBSERVATIONS) return true;

  const previous = targetCache[observation.joybuy_product_id] || rootCache[observation.joybuy_product_id];
  if (!previous) return true;

  return previous.price !== observation.price || previous.availability !== observation.availability;
}

function updateSnapshotCache(targetCache, observation) {
  targetCache[observation.joybuy_product_id] = snapshotValue(observation);
}

function targetCacheFor(cache, item) {
  cache.targets = cache.targets && typeof cache.targets === "object" ? cache.targets : {};
  const key = targetCacheKey(item);
  cache.targets[key] = cache.targets[key] && typeof cache.targets[key] === "object" ? cache.targets[key] : {};
  return cache.targets[key];
}

function targetCacheKey(item) {
  return item.targetLabel || item.targetUrl || `target-${item.targetIndex}`;
}

function snapshotValue(observation) {
  return {
    price: observation.price,
    availability: observation.availability || "unknown",
    lastSeenDate: observation.captured_at
  };
}

function normalizeState(state) {
  if (!Array.isArray(state.queue)) return state;

  state.totals = {
    ...(state.totals || {}),
    partialReads: state.totals?.partialReads ?? 0,
    uploadingObservations: state.totals?.uploadingObservations ?? 0,
    zeroProductPages: state.totals?.zeroProductPages ?? 0,
    missingPricePointBackfillRemaining: state.totals?.missingPricePointBackfillRemaining ?? (state.missingPricePointProductIds || []).length,
    observationsBuffered: state.totals?.observationsBuffered ?? 0,
    observationsFailed: state.totals?.observationsFailed ?? 0
  };
  state.forbiddenCooldownCount = state.forbiddenCooldownCount ?? 0;
  state.autoPauseReason = state.autoPauseReason ?? null;
  state.autoResumeAt = state.autoResumeAt ?? null;

  state.queue = state.queue.map((item) => ({
    ...item,
    startPage: item.startPage ?? pageNumberFromSeed(item.targetUrl),
    originalTargetIndex: item.originalTargetIndex ?? item.targetIndex,
    configuredMaxPage: item.configuredMaxPage ?? null,
    emptyPages: item.emptyPages ?? item.emptyOrDuplicatePages ?? 0,
    pagesFetched: item.pagesFetched ?? 0,
    observationsFound: item.observationsFound ?? 0,
    observationsPosted: item.observationsPosted ?? 0,
    observationsSkipped: item.observationsSkipped ?? 0,
    zeroProductPages: item.zeroProductPages ?? 0,
    forbiddenPages: item.forbiddenPages ?? 0
  }));
  return state;
}

function normalizeTarget(target) {
  if (typeof target === "string") {
    return { url: target, label: "", maxPage: null };
  }

  const maxPage = Number(target.maxPage);
  return {
    url: target.url,
    label: target.label || "",
    maxPage: Number.isInteger(maxPage) && maxPage > 0 ? maxPage : null
  };
}

function shuffleTargets(targets) {
  const entries = targets.map((target, originalIndex) => ({ target, originalIndex }));
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [entries[index], entries[swapIndex]] = [entries[swapIndex], entries[index]];
  }
  return entries;
}

function randomInt(maxExclusive) {
  if (globalThis.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

function randomPageDelayMs() {
  const min = Math.max(0, PAGE_DELAY_MIN_MS);
  const max = Math.max(min, PAGE_DELAY_MAX_MS);
  return min + randomInt(max - min + 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}
