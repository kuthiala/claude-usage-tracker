// Claude Usage Monitor — popup

const TOGGLE_KEY = "auto_keep_alive";
const STATUS_KEY_REGULAR = "last_keep_alive_regular";
const STATUS_KEY_INCOGNITO = "last_keep_alive_incognito";

function getStatusKeyForWindow(incognito) {
  return incognito ? STATUS_KEY_INCOGNITO : STATUS_KEY_REGULAR;
}

function errorHtml(title, body) {
  return `<div class="error"><strong>${title}</strong>${body}</div>`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function fmtTimeRemaining(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sec = Math.max(0, Math.round((d.getTime() - Date.now()) / 1000));
  if (sec === 0) return "(expired)";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `(${h}h ${m}m left)`;
  return `(${m}m left)`;
}

function fillClass(pct) {
  if (pct >= 80) return "high";
  if (pct >= 50) return "mid";
  return "low";
}

function renderBar({ label, util, resets, windowMs, showStart, showTimeRemaining }) {
  const pct = Math.max(0, Math.min(100, Math.round(util ?? 0)));
  const resetDate = resets ? new Date(resets) : null;
  const startedIso =
    resetDate && !isNaN(resetDate) && windowMs
      ? new Date(resetDate - windowMs).toISOString() : null;
  const timeRem = showTimeRemaining ? fmtTimeRemaining(resets) : "";
  return `
    <div class="bar-block">
      <div class="bar-header">
        <span class="bar-label">${label}</span>
        <span class="bar-pct">${pct}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${fillClass(pct)}" style="width:${pct}%"></div>
      </div>
      <div class="bar-meta">
        ${showStart && startedIso ? `<span><span class="label">Started</span><span class="value">${fmtTime(startedIso)}</span></span>` : ""}
        <span><span class="label">Resets</span><span class="value">${fmtTime(resets)} ${timeRem}</span></span>
      </div>
    </div>`;
}

function renderUsage(data) {
  let html = "";
  if (data.five_hour) html += renderBar({ label: "5-hour session", util: data.five_hour.utilization, resets: data.five_hour.resets_at, windowMs: 5 * 60 * 60 * 1000, showStart: true, showTimeRemaining: true });
  if (data.seven_day) html += renderBar({ label: "Weekly (all models)", util: data.seven_day.utilization, resets: data.seven_day.resets_at, windowMs: 7 * 24 * 60 * 60 * 1000, showStart: false, showTimeRemaining: false });
  if (data.seven_day_opus) html += renderBar({ label: "Weekly Opus", util: data.seven_day_opus.utilization, resets: data.seven_day_opus.resets_at, windowMs: 7 * 24 * 60 * 60 * 1000, showStart: false, showTimeRemaining: false });
  html += `<div class="last-fetched-display"><span class="last-fetched-label">Last fetched:</span> <span id="last-fetched">Never</span></div>`;
  return html || errorHtml("No usage data returned.", "");
}

let lastUsageData = null;
let lastFetchedTime = null;
let currentIncognito = null;
let initialFetchDone = false;

async function getCurrentWindowIncognito() {
  const currentWindow = await chrome.windows.getCurrent();
  return !!currentWindow.incognito;
}

// Check if a Claude tab exists in the current window context
async function claudeTabExists(incognito) {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  return tabs.some(t => t.incognito === incognito);
}

// Render the popup content based on current storage state, without triggering fetches.
async function checkSession(incognito) {
  try {
    const result = await chrome.runtime.sendMessage({ action: "checkSession", incognito });
    return !!(result && result.loggedIn);
  } catch {
    return false;
  }
}

async function render(skipAutoFetch = false) {
  const content = document.getElementById("content");
  content.innerHTML = `<div class="loading">Loading…</div>`;

  currentIncognito = await getCurrentWindowIncognito();

  // If a Claude tab is already open in this context, do a fast login check
  // against it before showing anything — this catches the case where the user
  // has logged out since the last fetch and the popup would otherwise show
  // stale cached usage data.
  const hasClaudeTab = await claudeTabExists(currentIncognito);
  if (hasClaudeTab) {
    const loggedIn = await checkSession(currentIncognito);
    if (!loggedIn) {
      content.innerHTML = errorHtml(
        "Not signed in",
        `<span class="detail">Sign in at <a href="https://claude.ai" class="internal-link">claude.ai</a> and reopen the extension.</span>`
      );
      return;
    }
  }

  const statusKey = getStatusKeyForWindow(currentIncognito);
  const stored = await chrome.storage.local.get(statusKey);
  const status = stored[statusKey] || {};

  // On first open, always fetch fresh data
  if (!skipAutoFetch && !initialFetchDone) {
    initialFetchDone = true;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "fetchUsage",
        incognito: currentIncognito,
      });
      if (result && result.ok) {
        lastUsageData = result.data;
        lastFetchedTime = Date.now();
        content.innerHTML = renderUsage(result.data);
        updateLastFetched(lastFetchedTime);
        return;
      }
      // fetchUsage failed — check if it was a login issue
      if (result?.error === "not_signed_in") {
        content.innerHTML = errorHtml(
          "Not signed in",
          `<span class="detail">Sign in at <a href="https://claude.ai" class="internal-link">claude.ai</a> and reopen the extension.</span>`
        );
        return;
      }
    } catch (e) {
      // fall through to show stored/error status
    }
  }

  if (status.outcome === "retrying") {
    content.innerHTML = `<div class="loading">Trying to refresh the window…</div>`;
    lastFetchedTime = status.lastFetched;
    updateLastFetched(status.lastFetched);
    return;
  }

  if (status.outcome === "error") {
    const detail = status.errorDetail;
    let msg = "Couldn't load usage.";
    if (detail === "max_retries" || detail === "refresh_failed") {
      msg = "Timed out trying to refresh usage. Auto-refresh has been turned off.";
    } else if (detail === "not_signed_in") {
      content.innerHTML = errorHtml(
        "Not signed in",
        `<span class="detail">Sign in at <a href="https://claude.ai" class="internal-link">claude.ai</a> and reopen the extension.</span>`
      );
      return;
    }
    content.innerHTML = errorHtml("Error", `<span class="detail">${msg}</span>`);
    lastFetchedTime = status.lastFetched;
    updateLastFetched(status.lastFetched);
    return;
  }

  if (status.usage) {
    lastUsageData = status.usage;
    content.innerHTML = renderUsage(status.usage);
    lastFetchedTime = status.lastFetched;
    updateLastFetched(status.lastFetched);
    return;
  }

  // No data yet
  content.innerHTML = errorHtml("No data yet.", `<span class="detail">Click "Refetch Usage" to load your usage.</span>`);
}

function updateLastFetched(timestamp) {
  const el = document.getElementById("last-fetched");
  if (!el) return;
  if (!timestamp) {
    el.textContent = "Never";
    return;
  }
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) {
    el.textContent = "Never";
    return;
  }
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) {
    el.textContent = "Just now";
  } else if (diff < 3600) {
    const m = Math.floor(diff / 60);
    el.textContent = `${m}m ago`;
  } else if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    el.textContent = `${h}h ago`;
  } else {
    el.textContent = fmtTime(d.toISOString());
  }
}

// Refetch button: open a tab in the same incognito context as the current window.
document.getElementById("refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const content = document.getElementById("content");
  content.innerHTML = `<div class="loading">Fetching…</div>`;

  try {
    const incognito = await getCurrentWindowIncognito();

    const result = await chrome.runtime.sendMessage({
      action: "fetchUsage",
      incognito,
    });

    if (!result || !result.ok) {
      if (result?.error === "not_signed_in") {
        content.innerHTML = errorHtml(
          "Not signed in",
          `<span class="detail">Sign in at <a href="https://claude.ai" class="internal-link">claude.ai</a> and try again.</span>`
        );
      } else {
        content.innerHTML = errorHtml("Error", `<span class="detail">Couldn't load usage.</span>`);
      }
    } else {
      lastUsageData = result.data;
      content.innerHTML = renderUsage(result.data);
      lastFetchedTime = Date.now();
      updateLastFetched(lastFetchedTime);
    }
  } catch (e) {
    content.innerHTML = errorHtml("Error", `<span class="detail">${e.message}</span>`);
  } finally {
    btn.disabled = false;
  }
});

// Auto-refresh toggle — only saves the setting, never triggers a fetch.
document.getElementById("ka-toggle").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ [TOGGLE_KEY]: e.target.checked });
});

// Handle internal links
document.addEventListener("click", async (e) => {
  const link = e.target.tagName === "A" ? e.target : e.target.closest("a");
  if (link) {
    const href = link.href;
    const isInternal = link.classList.contains("internal-link");
    const isSettings = href.includes("claude.ai/settings");
    if (isInternal || isSettings) {
      e.preventDefault();
      const currentWindow = await chrome.windows.getCurrent();
      chrome.tabs.create({ windowId: currentWindow.id, url: href });
    }
  }
});

// Update countdown every second
setInterval(() => {
  if (!lastUsageData?.five_hour?.resets_at) return;
  const content = document.getElementById("content");
  const resetIso = lastUsageData.five_hour.resets_at;
  const timeRem = fmtTimeRemaining(resetIso);
  // Replace only the time-remaining part to avoid clobbering the whole DOM
  content.innerHTML = content.innerHTML.replace(
    /Resets<\/span><span class="value">[^<]*/,
    `Resets</span><span class="value">${fmtTime(resetIso)} ${timeRem}`
  );
}, 1000);

// Update "last fetched" countdown every second
setInterval(() => {
  if (!lastFetchedTime) return;
  updateLastFetched(lastFetchedTime);
}, 1000);

// Sync toggle state on load and when changed from elsewhere
async function refreshToggle() {
  const sync = await chrome.storage.sync.get(TOGGLE_KEY);
  document.getElementById("ka-toggle").checked = !!sync[TOGGLE_KEY];
}

refreshToggle();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[TOGGLE_KEY]) {
    refreshToggle();
  }
  // Re-render if storage state changed (e.g., auto-refresh updated status)
  // skipAutoFetch=true to avoid a second fetch loop triggered by the first fetch's setStatus
  if (area === "local") {
    if (changes[STATUS_KEY_REGULAR] || changes[STATUS_KEY_INCOGNITO]) {
      render(true);
    }
  }
});

render();
