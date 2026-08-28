import {
  API_BASE_URL,
  MAX_PAGES_PER_TARGET,
  MAX_PAGE_RETRIES,
  OBSERVATION_DELAY_MS,
  PAGE_DELAY_MS,
  PAGES_PER_ALARM_TICK,
  RETRY_DELAY_MS,
  STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES,
  WRITE_UNCHANGED_OBSERVATIONS
} from "./config.js";
import { TARGET_PAGES } from "./target-pages.js";
import {
  buildPageUrl,
  extractMaxPageNumber,
  extractSearchPageObservations,
  pageNumberFromSeed
} from "./parser.js";

const ALARM_NAME = "joybuy-background-page-collector";
const STORAGE_KEY = "joybuyBackgroundCollectorState";
const SNAPSHOT_CACHE_KEY = "joybuyBackgroundCollectorSnapshots";
const OBSERVE_URL = `${API_BASE_URL}/products/observe`;

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
    loadState().then((state) => sendResponse({ ok: true, state })).catch((error) => {
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
  await setBadge("RUN", "#2563eb");
  const startedAt = new Date().toISOString();
  const queue = TARGET_PAGES.map((targetUrl, index) => ({
    targetIndex: index + 1,
    targetUrl,
    nextPage: pageNumberFromSeed(targetUrl),
    maxPage: pageNumberFromSeed(targetUrl) + MAX_PAGES_PER_TARGET - 1,
    seenProductIds: [],
    emptyPages: 0,
    done: false
  }));

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
      observationsSkipped: 0,
      observationsFailed: 0,
      targetsDone: 0
    },
    lastError: null
  });

  await processQueue();
}

async function processQueue() {
  const state = await loadState();
  if (!state.running || state.paused) return;
  await setBadge("RUN", "#2563eb");

  let pagesLeft = PAGES_PER_ALARM_TICK;
  while (pagesLeft > 0) {
    const item = state.queue.find((entry) => !entry.done);
    if (!item) {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.updatedAt = state.finishedAt;
      await saveState(state);
      chrome.alarms.clear(ALARM_NAME);
      await setBadge("OK", "#15803d");
      console.info("Joybuy background collection finished", state.totals);
      return;
    }

    const didProcessPage = await collectPage(state, item);
    state.updatedAt = new Date().toISOString();
    await saveProgressState(state);
    const latestState = await loadState();
    if (!latestState.running || latestState.paused) {
      chrome.alarms.clear(ALARM_NAME);
      await setBadge(latestState.paused ? "PAUSE" : "", latestState.paused ? "#a16207" : "#6b7280");
      return;
    }

    if (!didProcessPage) break;

    pagesLeft -= 1;
    if (pagesLeft > 0) await sleep(PAGE_DELAY_MS);
  }

  state.updatedAt = new Date().toISOString();
  await saveState(state);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
}

async function pauseCollection() {
  const state = await loadState();
  if (!state.running) return;

  state.running = false;
  state.paused = true;
  state.pausedAt = new Date().toISOString();
  state.updatedAt = state.pausedAt;
  await saveState(state);
  chrome.alarms.clear(ALARM_NAME);
  await setBadge("PAUSE", "#a16207");
}

async function resumeCollection() {
  const state = await loadState();
  const hasPendingQueue = (state.queue || []).some((entry) => !entry.done);
  if (!state.paused || !hasPendingQueue) return;

  state.running = true;
  state.paused = false;
  state.pausedAt = null;
  state.resumedAt = new Date().toISOString();
  state.updatedAt = state.resumedAt;
  state.finishedAt = null;
  await saveState(state);
  await setBadge("RUN", "#2563eb");
  await processQueue();
}

async function collectPage(state, item) {
  if (item.nextPage > item.maxPage) {
    markTargetDone(state, item);
    return true;
  }

  if (item.retryAfter && Date.parse(item.retryAfter) > Date.now()) {
    return false;
  }

  const pageUrl = buildPageUrl(item.targetUrl, item.nextPage);
  console.info("Joybuy collector fetching page", pageUrl);

  try {
    const response = await fetch(pageUrl, {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const detectedMaxPage = extractMaxPageNumber(html);
    if (detectedMaxPage !== null) {
      item.detectedMaxPage = detectedMaxPage;
      item.maxPage = Math.min(item.maxPage, detectedMaxPage);
      item.maxPageDetected = true;
    }

    const observations = extractSearchPageObservations(html);
    const seen = new Set(item.seenProductIds);
    const snapshotCache = await loadSnapshotCache();
    const freshObservations = observations.filter((observation) => !seen.has(observation.joybuy_product_id));
    let postedCount = 0;
    let skippedCount = 0;

    for (const observation of freshObservations) {
      if (shouldPostObservation(observation, snapshotCache)) {
        await postObservation(observation);
        postedCount += 1;
        await sleep(OBSERVATION_DELAY_MS);
      } else {
        skippedCount += 1;
      }

      updateSnapshotCache(snapshotCache, observation);
      seen.add(observation.joybuy_product_id);
    }
    await saveSnapshotCache(snapshotCache);

    item.seenProductIds = [...seen];
    item.emptyPages = observations.length ? 0 : (item.emptyPages || 0) + 1;
    item.lastPageUrl = pageUrl;
    item.lastPageObservationCount = observations.length;
    item.lastPageFreshObservationCount = freshObservations.length;
    item.lastPagePostedObservationCount = postedCount;
    item.lastPageSkippedObservationCount = skippedCount;
    item.retryCount = 0;
    item.retryAfter = null;
    item.nextPage += 1;

    state.totals.pagesFetched += 1;
    state.totals.observationsFound += observations.length;
    state.totals.observationsPosted += postedCount;
    state.totals.observationsSkipped = (state.totals.observationsSkipped || 0) + skippedCount;

    console.info("Joybuy collector page result", {
      pageUrl,
      targetIndex: item.targetIndex,
      detectedMaxPage,
      maxPage: item.maxPage,
      nextPage: item.nextPage,
      observations: observations.length,
      freshObservations: freshObservations.length,
      postedObservations: postedCount,
      skippedObservations: skippedCount,
      totals: state.totals
    });

    if (!item.maxPageDetected && item.emptyPages >= STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES) {
      markTargetDone(state, item);
    } else if (item.nextPage > item.maxPage) {
      markTargetDone(state, item);
    }
  } catch (error) {
    item.lastError = `${pageUrl}: ${error.message}`;
    state.lastError = item.lastError;
    state.totals.observationsFailed += 1;
    item.retryCount = (item.retryCount || 0) + 1;
    if (item.retryCount > MAX_PAGE_RETRIES) {
      item.nextPage += 1;
      item.retryCount = 0;
      item.retryAfter = null;
    } else {
      item.retryAfter = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
    }
    await setBadge("ERR", "#b91c1c");
    console.error("Joybuy collector page failed", item.lastError);
    return false;
  }

  return true;
}

async function postObservation(observation) {
  const response = await fetch(OBSERVE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(observation)
  });

  if (!response.ok) throw new Error(`observe failed: ${response.status}`);
}

function markTargetDone(state, item) {
  item.done = true;
  item.doneAt = new Date().toISOString();
  state.totals.targetsDone += 1;
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

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
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
    await setBadge("PAUSE", "#a16207");
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

function shouldPostObservation(observation, cache) {
  if (WRITE_UNCHANGED_OBSERVATIONS) return true;

  const previous = cache[observation.joybuy_product_id];
  if (!previous) return true;

  return previous.price !== observation.price || previous.availability !== observation.availability;
}

function updateSnapshotCache(cache, observation) {
  cache[observation.joybuy_product_id] = {
    price: observation.price,
    availability: observation.availability || "unknown",
    lastSeenDate: observation.captured_at
  };
}

function normalizeState(state) {
  if (!Array.isArray(state.queue)) return state;

  state.queue = state.queue.map((item) => ({
    ...item,
    emptyPages: item.emptyPages ?? item.emptyOrDuplicatePages ?? 0
  }));
  return state;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}
