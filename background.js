// Claude Usage Monitor — service worker

const TOGGLE_KEY = "auto_keep_alive";
const STATUS_KEY_REGULAR = "last_keep_alive_regular";
const STATUS_KEY_INCOGNITO = "last_keep_alive_incognito";
const ALARM_NAME_REGULAR = "keep_alive_check_regular";
const ALARM_NAME_INCOGNITO = "keep_alive_check_incognito";
const PERIOD_MIN = 5;

const RETRY_INTERVAL_MS = 5000;
const MAX_RETRIES = 30;

// Separate retry states for each context
let retryState = {
  regular: { orgId: null, attemptsRemaining: 0, lastError: null },
  incognito: { orgId: null, attemptsRemaining: 0, lastError: null },
};

// Helper to get the right status key and alarm name for a context
function getKeysForContext(incognito) {
  return {
    statusKey: incognito ? STATUS_KEY_INCOGNITO : STATUS_KEY_REGULAR,
    alarmName: incognito ? ALARM_NAME_INCOGNITO : ALARM_NAME_REGULAR,
    contextName: incognito ? "incognito" : "regular",
  };
}

// ── Alarm management ───────────────────────────────────────────────────────
async function ensureAlarm(incognito) {
  const { [TOGGLE_KEY]: enabled } = await chrome.storage.sync.get(TOGGLE_KEY);
  const { alarmName } = getKeysForContext(incognito);
  if (enabled) {
    const existing = await chrome.alarms.get(alarmName);
    if (!existing) {
      chrome.alarms.create(alarmName, { delayInMinutes: 0.5, periodInMinutes: PERIOD_MIN });
    }
  } else {
    await chrome.alarms.clear(alarmName);
  }
}

async function ensureAllAlarms() {
  await Promise.all([ensureAlarm(false), ensureAlarm(true)]);
}

chrome.runtime.onInstalled.addListener(ensureAllAlarms);
chrome.runtime.onStartup.addListener(ensureAllAlarms);

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync" && changes[TOGGLE_KEY]) {
    await ensureAllAlarms();
    if (!changes[TOGGLE_KEY].newValue) {
      // Toggled off — cancel any in-progress retries for both contexts
      retryState.regular = { orgId: null, attemptsRemaining: 0, lastError: null };
      retryState.incognito = { orgId: null, attemptsRemaining: 0, lastError: null };
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const isRegular = alarm.name === ALARM_NAME_REGULAR;
  const isIncognito = alarm.name === ALARM_NAME_INCOGNITO;
  if (!isRegular && !isIncognito) return;

  const incognito = isIncognito;
  const state = retryState[incognito ? "incognito" : "regular"];
  if (state.attemptsRemaining > 0) {
    processRetry(incognito);
  } else {
    runCheck(incognito);
  }
});

chrome.runtime.onMessage.addListener((req, sender, reply) => {
  // Manual refetch from popup — open a tab in the right context if needed
  if (req.action === "fetchUsage") {
    const incognito = !!req.incognito;
    fetchUsageForPopup(incognito)
      .then(result => reply(result))
      .catch(e => reply({ ok: false, error: e.message }));
    return true;
  }

  // Read the last cached usage from storage (never opens a tab)
  if (req.action === "getStatus") {
    const incognito = !!req.incognito;
    const { statusKey } = getKeysForContext(incognito);
    chrome.storage.local.get(statusKey).then(data => {
      reply(data[statusKey] || {});
    });
    return true;
  }

  // Check whether the user is currently logged into claude.ai in the given context.
  // Uses an existing Claude tab if available, otherwise opens a temporary one.
  // Returns { loggedIn: bool }.
  if (req.action === "checkSession") {
    const incognito = !!req.incognito;
    checkSession(incognito)
      .then(result => reply(result))
      .catch(() => reply({ loggedIn: false }));
    return true;
  }
});

// ── Storage helpers ────────────────────────────────────────────────────────
async function setStatus(outcome, incognito, extra = {}) {
  const { statusKey } = getKeysForContext(incognito);
  const existing = (await chrome.storage.local.get(statusKey))[statusKey] || {};
  await chrome.storage.local.set({
    [statusKey]: {
      ...existing,
      outcome,
      time: Date.now(),
      lastFetched: Date.now(),
      ...extra,
    }
  });
}

// ── Tab helpers ────────────────────────────────────────────────────────────

// Find an existing claude.ai tab matching the given incognito mode.
async function findClaudeTab(incognito) {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  const matching = tabs.filter(t => t.incognito === incognito);
  return matching.length ? matching[0] : null;
}

// Create a new claude.ai tab in the correct window type.
async function createClaudeTab(incognito) {
  try {
    const windows = await chrome.windows.getAll();
    const target = windows.find(w => w.incognito === incognito) ||
                   windows.find(w => !w.incognito) ||
                   windows[0];
    if (!target) return null;
    const tab = await chrome.tabs.create({
      url: "https://claude.ai",
      windowId: target.id,
      active: false,
    });
    return tab;
  } catch {
    return null;
  }
}

async function execInTab(tabId, fn, ...args) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: fn,
      args,
    });
    return r?.[0]?.result;
  } catch (e) {
    return { ok: false, error: e.message, threw: true };
  }
}

// ── Fetch usage data via a tab ─────────────────────────────────────────────
// Returns { ok, usage, orgId } or { ok: false, error }.
async function fetchUsageInTab(tabId) {
  return execInTab(tabId, async () => {
    try {
      const orgRes = await fetch("/api/organizations", {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!orgRes.ok) return { ok: false, step: "orgs", status: orgRes.status };
      const orgs = await orgRes.json();
      if (!Array.isArray(orgs) || !orgs.length) return { ok: false, error: "no_orgs" };
      const org = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || orgs[0];
      const orgId = org.uuid || org.id;
      const usageRes = await fetch(`/api/organizations/${orgId}/usage`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!usageRes.ok) return { ok: false, step: "usage", status: usageRes.status };
      const usage = await usageRes.json();
      return { ok: true, orgId, usage };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// ── Session check ─────────────────────────────────────────────────────────
// Hits /api/organizations in the correct browser context to determine if the
// user is currently logged in. Uses an existing Claude tab; opens a temporary
// one if none is available.
async function checkSession(incognito) {
  // Only check against an already-open Claude tab — never open a new one just
  // to check login state, since that would block the popup for ~5 seconds.
  // If no tab is open in this context, there is no active session to check.
  const tab = await findClaudeTab(incognito);
  if (!tab) return { loggedIn: false };

  const result = await execInTab(tab.id, async () => {
    try {
      const res = await fetch("/api/organizations", {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) return { loggedIn: false };
      const orgs = await res.json();
      return { loggedIn: Array.isArray(orgs) && orgs.length > 0 };
    } catch {
      return { loggedIn: false };
    }
  });
  return result || { loggedIn: false };
}

// ── Manual refetch for popup ───────────────────────────────────────────────
// Opens a background tab in the correct incognito context if needed.
async function fetchUsageForPopup(incognito) {
  let tab = await findClaudeTab(incognito);
  let createdTab = false;

  if (!tab) {
    tab = await createClaudeTab(incognito);
    if (!tab) return { ok: false, error: "Could not open Claude tab" };
    createdTab = true;
    // Wait for the page to load enough for the API calls to work
    await new Promise(r => setTimeout(r, 5000));
  }

  try {
    const result = await fetchUsageInTab(tab.id);
    if (!result || !result.ok) {
      const errDetail = result?.status === 401 || result?.status === 403
        ? "not_signed_in"
        : result?.error || `${result?.step}_${result?.status}`;
      return { ok: false, error: errDetail };
    }
    // Persist usage so the popup can read it next time
    await setStatus("ok", incognito, { usage: result.usage });
    return { ok: true, data: result.usage };
  } finally {
    if (createdTab && tab?.id) {
      await new Promise(r => setTimeout(r, 200));
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

// ── Auto-refresh check (alarm-driven) ─────────────────────────────────────
// Only opens a tab when the stored reset timestamp has expired.
async function runCheck(incognito) {
  const { [TOGGLE_KEY]: enabled } = await chrome.storage.sync.get(TOGGLE_KEY);
  if (!enabled) return;

  const { statusKey } = getKeysForContext(incognito);
  // Read last known reset timestamp from stored usage
  const stored = (await chrome.storage.local.get(statusKey))[statusKey] || {};
  const fh = stored.usage?.five_hour;
  const resetTs = fh?.resets_at ? new Date(fh.resets_at).getTime() : null;
  const now = Date.now();
  const expired = !fh || !resetTs || resetTs <= now;

  if (!expired) {
    // Still inside the window — nothing to do
    retryState[incognito ? "incognito" : "regular"] = { orgId: null, attemptsRemaining: 0, lastError: null };
    return;
  }

  // Window has expired — need to send a prompt to refresh it.
  // Find an existing claude.ai tab in this context.
  let tab = await findClaudeTab(incognito);
  let createdTab = false;

  if (!tab) {
    tab = await createClaudeTab(incognito);
    if (!tab) return;
    createdTab = true;
    await new Promise(r => setTimeout(r, 5000));
  }

  try {
    // First, get the current orgId from the page
    const usageResult = await fetchUsageInTab(tab.id);
    if (!usageResult || !usageResult.ok) {
      const detail = usageResult?.status === 401 || usageResult?.status === 403
        ? "not_signed_in" : "fetch_error";
      await setStatus("error", incognito, { errorDetail: detail });
      retryState[incognito ? "incognito" : "regular"] = { orgId: null, attemptsRemaining: 0, lastError: detail };
      return;
    }

    // Save fresh usage data
    await setStatus("ok", incognito, { usage: usageResult.usage });

    const fh2 = usageResult.usage?.five_hour;
    const resetTs2 = fh2?.resets_at ? new Date(fh2.resets_at).getTime() : null;
    const expired2 = !fh2 || !resetTs2 || resetTs2 <= now;

    if (!expired2) {
      // Window just refreshed on its own (race condition)
      retryState[incognito ? "incognito" : "regular"] = { orgId: null, attemptsRemaining: 0, lastError: null };
      return;
    }

    // Window is still expired — start retry loop to send a prompt
    const contextName = incognito ? "incognito" : "regular";
    retryState[contextName] = {
      orgId: usageResult.orgId,
      attemptsRemaining: MAX_RETRIES,
      lastError: null,
    };
    await setStatus("retrying", incognito);
    await processRetry(incognito);
  } finally {
    if (createdTab && tab?.id) {
      await new Promise(r => setTimeout(r, 200));
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

// ── Retry: send a short prompt to reset the 5-hour window ─────────────────
async function processRetry(incognito) {
  const { [TOGGLE_KEY]: enabled } = await chrome.storage.sync.get(TOGGLE_KEY);
  if (!enabled) {
    retryState[incognito ? "incognito" : "regular"] = { orgId: null, attemptsRemaining: 0, lastError: null };
    return;
  }

  const contextName = incognito ? "incognito" : "regular";
  const state = retryState[contextName];

  if (state.attemptsRemaining <= 0) {
    await setStatus("error", incognito, { errorDetail: "max_retries" });
    retryState[contextName] = { orgId: null, attemptsRemaining: 0, lastError: null };
    // Turn off auto-refresh after exhausting retries
    await chrome.storage.sync.set({ [TOGGLE_KEY]: false });
    return;
  }

  // Always use a tab in the correct context for auto-refresh
  let tab = await findClaudeTab(incognito);
  let createdTab = false;

  if (!tab) {
    tab = await createClaudeTab(incognito);
    if (!tab) {
      state.attemptsRemaining--;
      return;
    }
    createdTab = true;
    await new Promise(r => setTimeout(r, 5000));
  }

  try {
    const startResult = await execInTab(tab.id, async (orgId) => {
      try {
        const convUuid = crypto.randomUUID();
        const createRes = await fetch(`/api/organizations/${orgId}/chat_conversations`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ uuid: convUuid, name: "" }),
        });
        if (!createRes.ok) return { ok: false, step: "create", status: createRes.status };

        const compBody = {
          prompt: "Ans y/n, k?",
          parent_message_uuid: "00000000-0000-4000-8000-000000000000",
          timezone: "UTC",
          model: "claude-haiku-4-5",
          attachments: [],
          files: [],
          rendering_mode: "messages",
        };

        let compRes = await fetch(
          `/api/organizations/${orgId}/chat_conversations/${convUuid}/completion`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify(compBody),
          }
        );

        if (!compRes.ok && (compRes.status === 400 || compRes.status === 422)) {
          const fallback = { ...compBody };
          delete fallback.model;
          compRes = await fetch(
            `/api/organizations/${orgId}/chat_conversations/${convUuid}/completion`,
            {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
              body: JSON.stringify(fallback),
            }
          );
        }

        if (!compRes.ok) {
          fetch(`/api/organizations/${orgId}/chat_conversations/${convUuid}`, {
            method: "DELETE", credentials: "include",
          }).catch(() => {});
          return { ok: false, step: "completion", status: compRes.status };
        }

        // Drain the stream
        try {
          const reader = compRes.body.getReader();
          let chunks = 0;
          while (chunks < 500) {
            const { done } = await reader.read();
            if (done) break;
            chunks++;
          }
        } catch {}

        // Check if the window reset by fetching usage again
        const orgRes = await fetch("/api/organizations", {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        let windowReset = false;
        if (orgRes.ok) {
          const orgs = await orgRes.json();
          const org2 = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || orgs[0];
          const usageRes = await fetch(`/api/organizations/${org2.uuid || org2.id}/usage`, {
            credentials: "include",
            headers: { Accept: "application/json" },
            cache: "no-store",
          });
          if (usageRes.ok) {
            const usage = await usageRes.json();
            const fh = usage?.five_hour;
            const resetTs = fh?.resets_at ? new Date(fh.resets_at).getTime() : null;
            windowReset = !!resetTs && resetTs > Date.now();
            if (windowReset) {
              // Cleanup the conversation we just created
              await fetch(`/api/organizations/${orgId}/chat_conversations/${convUuid}`, {
                method: "DELETE", credentials: "include",
              }).catch(() => {});
              return { ok: true, usage };
            }
          }
        }

        await fetch(`/api/organizations/${orgId}/chat_conversations/${convUuid}`, {
          method: "DELETE", credentials: "include",
        }).catch(() => {});

        return { ok: false, step: "still_expired" };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, state.orgId);

    if (startResult?.ok) {
      // Save refreshed usage data
      await setStatus("ok", incognito, { usage: startResult.usage });
      retryState[contextName] = { orgId: null, attemptsRemaining: 0, lastError: null };
    } else {
      state.attemptsRemaining--;
      state.lastError = startResult?.error || `${startResult?.step}_${startResult?.status}`;

      if (state.attemptsRemaining <= 0) {
        await setStatus("error", incognito, { errorDetail: "refresh_failed" });
        await chrome.storage.sync.set({ [TOGGLE_KEY]: false });
      } else {
        await setStatus("retrying", incognito);
      }
    }
  } catch (e) {
    state.attemptsRemaining--;
    if (state.attemptsRemaining <= 0) {
      await setStatus("error", incognito, { errorDetail: "refresh_failed" });
      await chrome.storage.sync.set({ [TOGGLE_KEY]: false });
    }
  } finally {
    if (createdTab && tab?.id) {
      await new Promise(r => setTimeout(r, 200));
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

ensureAllAlarms();
