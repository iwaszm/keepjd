import {
  API_BASE_URL,
  MAX_PAGES_PER_TARGET,
  OBSERVATION_DELAY_MS,
  PAGE_DELAY_MS,
  PAGES_PER_ALARM_TICK,
  STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES
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
const OBSERVE_URL = `${API_BASE_URL}/products/observe`;

console.info("Joybuy background collector service worker loaded");

chrome.runtime.onInstalled.addListener(() => {
  console.info("Joybuy background collector installed");
  setIdleStatus("installed");
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
    emptyOrDuplicatePages: 0,
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
      observationsFailed: 0,
      targetsDone: 0
    },
    lastError: null
  });

  await processQueue();
}

async function processQueue() {
  const state = await loadState();
  if (!state.running) return;
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

    await collectPage(state, item);
    pagesLeft -= 1;
    if (pagesLeft > 0) await sleep(PAGE_DELAY_MS);
  }

  state.updatedAt = new Date().toISOString();
  await saveState(state);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
}

async function collectPage(state, item) {
  if (item.nextPage > item.maxPage) {
    markTargetDone(state, item);
    return;
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
    const freshObservations = observations.filter((observation) => !seen.has(observation.joybuy_product_id));

    for (const observation of freshObservations) {
      await postObservation(observation);
      seen.add(observation.joybuy_product_id);
      await sleep(OBSERVATION_DELAY_MS);
    }

    item.seenProductIds = [...seen];
    item.emptyOrDuplicatePages = freshObservations.length ? 0 : item.emptyOrDuplicatePages + 1;
    item.lastPageUrl = pageUrl;
    item.lastPageObservationCount = observations.length;
    item.lastPageFreshObservationCount = freshObservations.length;
    item.nextPage += 1;

    state.totals.pagesFetched += 1;
    state.totals.observationsFound += observations.length;
    state.totals.observationsPosted += freshObservations.length;

    console.info("Joybuy collector page result", {
      pageUrl,
      targetIndex: item.targetIndex,
      detectedMaxPage,
      maxPage: item.maxPage,
      nextPage: item.nextPage,
      observations: observations.length,
      freshObservations: freshObservations.length,
      totals: state.totals
    });

    if (!item.maxPageDetected && item.emptyOrDuplicatePages >= STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES) {
      markTargetDone(state, item);
    } else if (item.nextPage > item.maxPage) {
      markTargetDone(state, item);
    }
  } catch (error) {
    item.lastError = `${pageUrl}: ${error.message}`;
    state.lastError = item.lastError;
    state.totals.observationsFailed += 1;
    item.nextPage += 1;
    await setBadge("ERR", "#b91c1c");
    console.error("Joybuy collector page failed", item.lastError);
  }
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
    reason,
    updatedAt: now,
    queue: [],
    totals: {
      pagesFetched: 0,
      observationsFound: 0,
      observationsPosted: 0,
      observationsFailed: 0,
      targetsDone: 0
    },
    lastError: null
  });
}

async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || { running: false };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}
