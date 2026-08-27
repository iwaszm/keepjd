import {
  API_BASE_URL,
  MAX_PAGES_PER_SEED,
  OBSERVATION_DELAY_MS,
  PAGE_DELAY_MS,
  PAGES_PER_ALARM_TICK,
  SEED_PAGES,
  STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES
} from "./config.js";
import { buildPageUrl, extractSearchPageObservations, pageNumberFromSeed } from "./parser.js";

const ALARM_NAME = "joybuy-background-page-collector";
const STORAGE_KEY = "joybuyBackgroundCollectorState";
const OBSERVE_URL = `${API_BASE_URL}/products/observe`;

chrome.runtime.onInstalled.addListener(() => {
  setIdleStatus("installed");
});

chrome.action.onClicked.addListener(() => {
  startCollection("manual_click").catch((error) => {
    console.error("Joybuy background collection failed to start", error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  processQueue().catch((error) => {
    console.error("Joybuy background collection tick failed", error);
  });
});

async function startCollection(reason) {
  const startedAt = new Date().toISOString();
  const queue = SEED_PAGES.map((seedUrl) => ({
    seedUrl,
    nextPage: pageNumberFromSeed(seedUrl),
    maxPage: pageNumberFromSeed(seedUrl) + MAX_PAGES_PER_SEED - 1,
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
      seedsDone: 0
    },
    lastError: null
  });

  await processQueue();
}

async function processQueue() {
  const state = await loadState();
  if (!state.running) return;

  let pagesLeft = PAGES_PER_ALARM_TICK;
  while (pagesLeft > 0) {
    const item = state.queue.find((entry) => !entry.done);
    if (!item) {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.updatedAt = state.finishedAt;
      await saveState(state);
      chrome.alarms.clear(ALARM_NAME);
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
    markSeedDone(state, item);
    return;
  }

  const pageUrl = buildPageUrl(item.seedUrl, item.nextPage);
  console.info("Fetching Joybuy page", pageUrl);

  try {
    const response = await fetch(pageUrl, {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
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

    if (item.emptyOrDuplicatePages >= STOP_AFTER_DUPLICATE_OR_EMPTY_PAGES) {
      markSeedDone(state, item);
    }
  } catch (error) {
    item.lastError = `${pageUrl}: ${error.message}`;
    state.lastError = item.lastError;
    state.totals.observationsFailed += 1;
    item.nextPage += 1;
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

function markSeedDone(state, item) {
  item.done = true;
  item.doneAt = new Date().toISOString();
  state.totals.seedsDone += 1;
}

async function setIdleStatus(reason) {
  const now = new Date().toISOString();
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
      seedsDone: 0
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
