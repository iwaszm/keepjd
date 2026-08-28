const startButton = document.getElementById("start");
const pauseButton = document.getElementById("pause");
const statusNode = document.getElementById("status");
const elapsedNode = document.getElementById("elapsed");
const pagesNode = document.getElementById("pages");
const foundNode = document.getElementById("found");
const postedNode = document.getElementById("posted");
const bufferedNode = document.getElementById("buffered");
const skippedNode = document.getElementById("skipped");
const failedNode = document.getElementById("failed");
const targetNode = document.getElementById("target");
const pageNode = document.getElementById("page");
const lastTargetPagesNode = document.getElementById("last-target-pages");
const lastReasonNode = document.getElementById("last-reason");
const errorNode = document.getElementById("error");

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  const state = await readState();
  statusNode.textContent = state.running || state.paused || state.finishedAt ? "Restarting" : "Starting";
  const response = await chrome.runtime.sendMessage({ type: "START_COLLECTION" });
  if (!response?.ok) showError(response?.error || "Failed to start");
  await refreshState();
});

pauseButton.addEventListener("click", async () => {
  pauseButton.disabled = true;
  const state = await readState();
  const response = await chrome.runtime.sendMessage({ type: state.paused ? "RESUME_COLLECTION" : "PAUSE_COLLECTION" });
  if (!response?.ok) showError(response?.error || "Failed to update collection");
  await refreshState();
});

refreshState();
setInterval(refreshState, 1500);

async function refreshState() {
  const state = await readState();
  const totals = state.totals || {};
  const queue = state.queue || [];
  const activeTarget = queue.find((entry) => !entry.done);
  statusNode.textContent = state.running ? "Running" : state.paused ? "Paused" : state.finishedAt ? "Finished" : "Idle";
  elapsedNode.textContent = formatElapsed(state);
  pagesNode.textContent = totals.pagesFetched || 0;
  foundNode.textContent = totals.observationsFound || 0;
  postedNode.textContent = totals.observationsPosted || 0;
  bufferedNode.textContent = totals.observationsBuffered || 0;
  skippedNode.textContent = totals.observationsSkipped || 0;
  failedNode.textContent = totals.observationsFailed || 0;
  targetNode.textContent = targetText(state, queue, activeTarget);
  pageNode.textContent = activeTarget ? `${activeTarget.nextPage}/${activeTarget.detectedMaxPage || activeTarget.maxPage}` : "-";
  const lastDoneTarget = [...queue].reverse().find((entry) => entry.done);
  lastTargetPagesNode.textContent = lastDoneTarget ? `${lastDoneTarget.pagesFetched || 0}` : "-";
  lastReasonNode.textContent = lastDoneTarget?.doneReason || "-";
  startButton.disabled = false;
  startButton.textContent = state.running || state.paused || state.finishedAt ? "Restart" : "Start";
  pauseButton.disabled = !state.running && !state.paused;
  pauseButton.textContent = state.paused ? "Resume" : "Pause";

  if (state.lastError) showError(state.lastError);
  else hideError();
}

async function readState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) {
    showError(response?.error || "Failed to read state");
    return {};
  }
  return response.state || {};
}

function targetText(state, queue, activeTarget) {
  if (activeTarget) return `${activeTarget.targetIndex}/${queue.length}`;
  if (queue.length && state.finishedAt) return `${queue.length}/${queue.length}`;
  if (queue.length && state.paused) return `${queue.length}/${queue.length}`;
  return "-";
}

function formatElapsed(state) {
  if (!state.startedAt) return "-";
  const start = Date.parse(state.startedAt);
  const end = Date.parse(state.running ? new Date().toISOString() : state.finishedAt || state.pausedAt || new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";

  const totalSeconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function showError(message) {
  errorNode.hidden = false;
  errorNode.textContent = message;
}

function hideError() {
  errorNode.hidden = true;
  errorNode.textContent = "";
}
