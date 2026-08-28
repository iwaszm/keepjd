const startButton = document.getElementById("start");
const statusNode = document.getElementById("status");
const pagesNode = document.getElementById("pages");
const foundNode = document.getElementById("found");
const postedNode = document.getElementById("posted");
const skippedNode = document.getElementById("skipped");
const failedNode = document.getElementById("failed");
const targetNode = document.getElementById("target");
const pageNode = document.getElementById("page");
const targetsNode = document.getElementById("targets");
const errorNode = document.getElementById("error");

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  statusNode.textContent = "Starting";
  const response = await chrome.runtime.sendMessage({ type: "START_COLLECTION" });
  if (!response?.ok) showError(response?.error || "Failed to start");
  await refreshState();
});

refreshState();
setInterval(refreshState, 1500);

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) {
    showError(response?.error || "Failed to read state");
    return;
  }

  const state = response.state || {};
  const totals = state.totals || {};
  const activeTarget = (state.queue || []).find((entry) => !entry.done);
  statusNode.textContent = state.running ? "Running" : state.finishedAt ? "Finished" : "Idle";
  pagesNode.textContent = totals.pagesFetched || 0;
  foundNode.textContent = totals.observationsFound || 0;
  postedNode.textContent = totals.observationsPosted || 0;
  skippedNode.textContent = totals.observationsSkipped || 0;
  failedNode.textContent = totals.observationsFailed || 0;
  targetNode.textContent = activeTarget ? `${activeTarget.targetIndex}/${state.queue.length}` : "-";
  pageNode.textContent = activeTarget ? `${activeTarget.nextPage}/${activeTarget.detectedMaxPage || activeTarget.maxPage}` : "-";
  targetsNode.textContent = totals.targetsDone || totals.seedsDone || 0;
  startButton.disabled = Boolean(state.running);

  if (state.lastError) showError(state.lastError);
  else hideError();
}

function showError(message) {
  errorNode.hidden = false;
  errorNode.textContent = message;
}

function hideError() {
  errorNode.hidden = true;
  errorNode.textContent = "";
}
