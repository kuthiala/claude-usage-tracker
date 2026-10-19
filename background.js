// Claude Usage Monitor — service worker

const TOGGLE_KEY = "auto_keep_alive";
const STATUS_KEY_REGULAR = "last_keep_alive_regular";
const STATUS_KEY_INCOGNITO = "last_keep_alive_incognito";
const RETRY_KEY_REGULAR = "retry_state_regular";
const RETRY_KEY_INCOGNITO = "retry_state_incognito";
const TEMP_TABS_KEY = "temp_tab_ids";
const ALARM_NAME_REGULAR = "keep_alive_check_regular";
const ALARM_NAME_INCOGNITO = "keep_alive_check_incognito";
const PERIOD_MIN = 2;

const MAX_RETRIES = 15;
const TAB_LOAD_TIMEOUT_MS = 20000;

// Helper to get the right storage keys and alarm name for a context
function getKeysForContext(incognito) {
  return {
    statusKey: incognito ? STATUS_KEY_INCOGNITO : STATUS_KEY_REGULAR,
    retryKey: incognito ? RETRY_KEY_INCOGNITO : RETRY_KEY_REGULAR,
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
      await Promise.all([clearRetryState(false), clearRetryState(true)]);
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME_REGULAR) runCheck(false);
  else if (alarm.name === ALARM_NAME_INCOGNITO) runCheck(true);
});

chrome.runtime.onMessage.addListener((req, sender, reply) => {
  // Manual refetch from popup — open a tab in the right context if needed
  if (req.action === "fetchUsage") {
    const incognito = !!req.incognito;
    const force = !!req.force;
    fetchUsageForPopup(incognito, force)
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
  // Only uses an existing Claude tab — never opens one.
  // Returns { loggedIn: true | false | null } (null = could not determine).
  if (req.action === "checkSession") {
    const incognito = !!req.incognito;
    checkSession(incognito)
      .then(result => reply(result))
      .catch(() => reply({ loggedIn: null }));
    return true;
  }
});

// ── Storage helpers ────────────────────────────────────────────────────────
// lastFetched only moves when fresh usage is saved (or is passed explicitly),
// so error/retrying writes don't make stale data look fresh.
async function setStatus(outcome, incognito, extra = {}) {
  const { statusKey } = getKeysForContext(incognito);
  const existing = (await chrome.storage.local.get(statusKey))[statusKey] || {};
  const next = {
    ...existing,
    outcome,
    time: Date.now(),
    ...(extra.usage ? { lastFetched: Date.now() } : {}),
    ...extra,
  };
  if (outcome !== "error") delete next.errorDetail;
  await chrome.storage.local.set({ [statusKey]: next });
}

// Retry state lives in session storage: the service worker is torn down
// between alarm ticks, so in-memory state would reset on every tick.
async function getRetryState(incognito) {
  const { retryKey } = getKeysForContext(incognito);
  const data = await chrome.storage.session.get(retryKey);
  return data[retryKey] || { attempts: 0 };
}

async function setRetryState(incognito, state) {
  const { retryKey } = getKeysForContext(incognito);
  await chrome.storage.session.set({ [retryKey]: state });
}

async function clearRetryState(incognito) {
  const { retryKey } = getKeysForContext(incognito);
  await chrome.storage.session.remove(retryKey);
}

function isWindowExpired(usage) {
  const fh = usage?.five_hour;
  const resetTs = fh?.resets_at ? new Date(fh.resets_at).getTime() : null;
  return !fh || !resetTs || resetTs <= Date.now();
}

// ── Tab helpers ────────────────────────────────────────────────────────────

// Find an existing, usable claude.ai tab matching the given incognito mode.
// Discarded/frozen tabs can't run scripts, so they're skipped.
async function findClaudeTab(incognito) {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  const matching = tabs.filter(t => t.incognito === incognito && !t.discarded && !t.frozen);
  return matching.find(t => t.status === "complete") || matching[0] || null;
}

async function hasWindowForContext(incognito) {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return windows.some(w => w.incognito === incognito);
}

// Create a new claude.ai tab in a window of the same type. Never falls back to
// a window of the other type — that tab would belong to a different session.
async function createClaudeTab(incognito) {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const target = windows.find(w => w.incognito === incognito);
    if (!target) return null;
    return await chrome.tabs.create({
      url: "https://claude.ai",
      windowId: target.id,
      active: false,
    });
  } catch {
    return null;
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(ok);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId)
      .then(tab => { if (tab.status === "complete") finish(true); })
      .catch(() => finish(false));
  });
}

// Temp tab IDs are recorded in session storage so a tab orphaned by the
// service worker being killed mid-task gets closed on the next wake-up.
async function recordTempTab(tabId, add) {
  const ids = (await chrome.storage.session.get(TEMP_TABS_KEY))[TEMP_TABS_KEY] || [];
  const next = add ? [...new Set([...ids, tabId])] : ids.filter(id => id !== tabId);
  await chrome.storage.session.set({ [TEMP_TABS_KEY]: next });
}

async function closeTempTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch {}
  await recordTempTab(tabId, false);
}

async function cleanupOrphanedTempTabs() {
  const ids = (await chrome.storage.session.get(TEMP_TABS_KEY))[TEMP_TABS_KEY] || [];
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      // If the user switched to it, they've adopted it — leave it open.
      if (!tab.active) await chrome.tabs.remove(id);
    } catch {}
  }
  const current = (await chrome.storage.session.get(TEMP_TABS_KEY))[TEMP_TABS_KEY] || [];
  await chrome.storage.session.set({ [TEMP_TABS_KEY]: current.filter(id => !ids.includes(id)) });
}

// Any temp tabs recorded before this service worker instance started belong
// to a previous instance that was killed mid-task.
const orphanCleanup = cleanupOrphanedTempTabs().catch(() => {});

// Serialises all tab work per context so concurrent callers (alarm + popup)
// share one temporary tab instead of each opening their own.
const contextLocks = { regular: Promise.resolve(), incognito: Promise.resolve() };

function withContextLock(incognito, fn) {
  const { contextName } = getKeysForContext(incognito);
  const run = contextLocks[contextName].then(fn, fn);
  contextLocks[contextName] = run.catch(() => {});
  return run;
}

// Runs fn(tabId) against an existing Claude tab, or a temporary background tab
// that is opened once, waited on until loaded, and always closed afterwards.
// Returns null if no tab could be obtained.
function withClaudeTab(incognito, fn) {
  return withContextLock(incognito, async () => {
    const existing = await findClaudeTab(incognito);
    if (existing) return fn(existing.id);

    await orphanCleanup;
    const tab = await createClaudeTab(incognito);
    if (!tab?.id) return null;
    await recordTempTab(tab.id, true);
    try {
      const loaded = await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
      if (!loaded) return null;
      return await fn(tab.id);
    } finally {
      await closeTempTab(tab.id);
    }
  });
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

function isAuthError(result) {
  return result?.status === 401 || result?.status === 403;
}

// ── Session check ─────────────────────────────────────────────────────────
// Hits /api/organizations in the correct browser context to determine if the
// user is currently logged in.
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
      if (res.status === 401 || res.status === 403) return { loggedIn: false };
      if (!res.ok) return { loggedIn: null };
      const orgs = await res.json();
      return { loggedIn: Array.isArray(orgs) && orgs.length > 0 };
    } catch {
      return { loggedIn: null };
    }
  });
  // Script injection failed (tab still loading, navigating, etc.) — unknown.
  if (!result || result.threw) return { loggedIn: null };
  return result;
}

// ── Manual refetch for popup ───────────────────────────────────────────────
// Checks cache first (5-min TTL) unless force=true. If cache is fresh, returns it without opening a tab.
// Otherwise uses a Claude tab in the correct incognito context (temporary if none is open).
// Returns { ok, data, fromCache } to distinguish cache hits from real fetches.
async function fetchUsageForPopup(incognito, force = false) {
  const { statusKey } = getKeysForContext(incognito);
  const stored = (await chrome.storage.local.get(statusKey))[statusKey] || {};

  // Check if we have cached data that's less than 5 minutes old (unless forced)
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();
  const lastFetchedTime = stored.lastFetched || 0;
  const age = now - lastFetchedTime;

  if (!force && stored.usage && age < CACHE_TTL) {
    return { ok: true, data: stored.usage, fromCache: true };
  }

  // Cache is stale — need to fetch fresh data
  // Save the fetch attempt timestamp immediately so subsequent clicks within 5 min use cache
  await setStatus(stored.outcome || "ok", incognito, { lastFetched: now });

  const result = await withClaudeTab(incognito, tabId => fetchUsageInTab(tabId));
  if (result === null) return { ok: false, error: "Could not open Claude tab" };
  if (!result.ok) {
    const errDetail = isAuthError(result)
      ? "not_signed_in"
      : result.error || `${result.step}_${result.status}`;
    if (errDetail === "not_signed_in") {
      await setStatus("error", incognito, { errorDetail: errDetail });
    }
    return { ok: false, error: errDetail };
  }
  // Persist fresh usage data
  await setStatus("ok", incognito, { usage: result.usage });
  return { ok: true, data: result.usage, fromCache: false };
}

// ── Auto-refresh check (alarm-driven) ─────────────────────────────────────
// Only touches a tab when the stored reset timestamp has expired, and only
// opens a temporary one when the user is believed to be signed in.
async function runCheck(incognito) {
  const { [TOGGLE_KEY]: enabled } = await chrome.storage.sync.get(TOGGLE_KEY);
  if (!enabled) return;

  // No window of this type means no session to refresh (e.g. no incognito
  // window open, or the extension isn't allowed in incognito).
  if (!(await hasWindowForContext(incognito))) return;

  const { statusKey } = getKeysForContext(incognito);
  const stored = (await chrome.storage.local.get(statusKey))[statusKey] || {};

  if (stored.usage && !isWindowExpired(stored.usage)) {
    // Still inside the window — nothing to do
    await clearRetryState(incognito);
    return;
  }

  // Signed out last time we looked: don't spawn tabs every tick. An open
  // Claude tab (e.g. after the user signs back in) will be picked up instead.
  if (stored.errorDetail === "not_signed_in" && !(await findClaudeTab(incognito))) return;

  await withClaudeTab(incognito, async (tabId) => {
    const usageResult = await fetchUsageInTab(tabId);
    if (!usageResult || !usageResult.ok) {
      if (isAuthError(usageResult)) {
        await setStatus("error", incognito, { errorDetail: "not_signed_in" });
        await clearRetryState(incognito);
      } else {
        await recordFailedAttempt(incognito);
      }
      return;
    }

    // Save fresh usage data
    await setStatus("ok", incognito, { usage: usageResult.usage });

    if (!isWindowExpired(usageResult.usage)) {
      // Window is active (stale stored data, or it was refreshed elsewhere)
      await clearRetryState(incognito);
      return;
    }

    // Window is expired — send a prompt to start a new one
    await setStatus("retrying", incognito);
    const refresh = await sendRefreshPrompt(tabId, usageResult.orgId);
    if (refresh?.ok) {
      await setStatus("ok", incognito, { usage: refresh.usage });
      await clearRetryState(incognito);
    } else {
      await recordFailedAttempt(incognito);
    }
  });
}

// Counts a failed attempt; after MAX_RETRIES the toggle turns itself off.
async function recordFailedAttempt(incognito) {
  const state = await getRetryState(incognito);
  const attempts = state.attempts + 1;
  if (attempts >= MAX_RETRIES) {
    await setStatus("error", incognito, { errorDetail: "max_retries" });
    await clearRetryState(incognito);
    await chrome.storage.sync.set({ [TOGGLE_KEY]: false });
  } else {
    await setRetryState(incognito, { attempts });
    await setStatus("retrying", incognito);
  }
}

// ── Send a short prompt to reset the 5-hour window ────────────────────────
// Returns { ok: true, usage } once the window shows as active again.
async function sendRefreshPrompt(tabId, orgId) {
  return execInTab(tabId, async (orgId) => {
    const convUuid = crypto.randomUUID();
    const deleteConversation = () =>
      fetch(`/api/organizations/${orgId}/chat_conversations/${convUuid}`, {
        method: "DELETE", credentials: "include",
      }).catch(() => {});

    try {
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

      const completionUrl = `/api/organizations/${orgId}/chat_conversations/${convUuid}/completion`;
      let compRes = await fetch(completionUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(compBody),
      });

      if (!compRes.ok && (compRes.status === 400 || compRes.status === 422)) {
        const fallback = { ...compBody };
        delete fallback.model;
        compRes = await fetch(completionUrl, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(fallback),
        });
      }

      if (!compRes.ok) {
        await deleteConversation();
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

      // Check whether the window reset. The usage endpoint can lag slightly
      // behind the completion, so poll a few times before giving up.
      for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 2000));
        const usageRes = await fetch(`/api/organizations/${orgId}/usage`, {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!usageRes.ok) continue;
        const usage = await usageRes.json();
        const fh = usage?.five_hour;
        const resetTs = fh?.resets_at ? new Date(fh.resets_at).getTime() : null;
        if (resetTs && resetTs > Date.now()) {
          await deleteConversation();
          return { ok: true, usage };
        }
      }

      await deleteConversation();
      return { ok: false, step: "still_expired" };
    } catch (e) {
      await deleteConversation();
      return { ok: false, error: e.message };
    }
  }, orgId);
}

ensureAllAlarms();
