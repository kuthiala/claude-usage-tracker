// Claude Usage Monitor — content script
// Injects an inline usage bar below the chat input toolbar.
(function () {
  'use strict';

  if (document.__claudeUsageMonitor) return;
  document.__claudeUsageMonitor = true;

  const CONTEXT_LIMIT = 200_000;
  const STYLE_ID = 'cum-styles';
  const USAGE_TTL = 2 * 60 * 1000;       // refresh usage every 2 min
  const TOKEN_POLL_MS = 60 * 1000;        // poll tokens every 1 min

  // ── CSS ──────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .cum-bar-wrapper {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 5px 14px 6px;
        font-size: 11px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: #6B6862;
        flex-wrap: nowrap;
        box-sizing: border-box;
        width: 100%;
        border-top: 1px solid rgba(0,0,0,0.06);
        min-height: 26px;
      }
      html[data-mode="dark"] .cum-bar-wrapper {
        color: #9b9890;
        border-top-color: rgba(255,255,255,0.07);
      }

      .cum-group {
        display: flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .cum-label {
        font-size: 10px;
        opacity: 0.75;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        font-weight: 500;
      }

      .cum-pct {
        font-weight: 600;
        font-size: 11px;
        color: #1F1E1D;
        min-width: 34px;
        display: inline-block;
      }
      html[data-mode="dark"] .cum-pct { color: #e8e4dc; }
      .cum-pct.cum-warn { color: #C8943B; }
      .cum-pct.cum-high { color: #C25B4A; }

      .cum-track {
        width: 52px;
        height: 4px;
        background: #E8E2D2;
        border-radius: 3px;
        overflow: hidden;
        flex-shrink: 0;
      }
      html[data-mode="dark"] .cum-track { background: #3a3833; }

      .cum-fill {
        height: 100%;
        border-radius: 3px;
        background: #5C8767;
        transition: width 0.4s ease;
      }
      .cum-fill.cum-warn { background: #C8943B; }
      .cum-fill.cum-high { background: #C25B4A; }

      .cum-divider {
        width: 1px;
        height: 12px;
        background: rgba(0,0,0,0.12);
        flex-shrink: 0;
      }
      html[data-mode="dark"] .cum-divider { background: rgba(255,255,255,0.12); }

      .cum-reset {
        opacity: 0.65;
        font-size: 10px;
        margin-left: 1px;
        white-space: nowrap;
      }

      /* ctx used text has a stable min-width so the bar doesn't jump */
      .cum-ctx-used {
        opacity: 0.65;
        font-size: 10px;
        margin-left: 1px;
        white-space: nowrap;
        min-width: 80px;
        display: inline-block;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function formatTimeRemaining(isoOrMs) {
    if (!isoOrMs) return '';
    const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    if (isNaN(ts)) return '';
    const sec = Math.max(0, Math.round((ts - Date.now()) / 1000));
    if (sec === 0) return 'resets now';
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m`;
  }

  function fillClass(pct) {
    if (pct >= 80) return 'cum-high';
    if (pct >= 50) return 'cum-warn';
    return '';
  }

  function makeMiniBar() {
    const track = document.createElement('div');
    track.className = 'cum-track';
    const fill = document.createElement('div');
    fill.className = 'cum-fill';
    fill.style.width = '0%';
    track.appendChild(fill);
    return { track, fill };
  }

  function makeDivider() {
    const d = document.createElement('span');
    d.className = 'cum-divider';
    return d;
  }

  // ── UI elements ───────────────────────────────────────────────────────────
  let wrapper = null;

  // Session
  let sessionPctEl, sessionFillEl, sessionResetEl, sessionResetMs = null;
  // Last fetched
  let lastFetchedGroup, lastFetchedEl = null;
  // Weekly
  let weeklyGroupEl, weeklyPctEl, weeklyFillEl, weeklyResetEl, div1El, div3El, weeklyResetMs = null;
  // Context
  let ctxGroupEl, ctxPctEl, ctxFillEl, ctxUsedEl, div2El;

  function buildUI() {
    wrapper = document.createElement('div');
    wrapper.className = 'cum-bar-wrapper';
    wrapper.setAttribute('data-cum-bar', '1');

    // ── Session (5h) ──
    const sessionGroup = document.createElement('div');
    sessionGroup.className = 'cum-group';

    const sessionLabel = document.createElement('span');
    sessionLabel.className = 'cum-label';
    sessionLabel.textContent = '5h';

    sessionPctEl = document.createElement('span');
    sessionPctEl.className = 'cum-pct';
    sessionPctEl.textContent = '—';

    const { track: sTrack, fill: sFill } = makeMiniBar();
    sessionFillEl = sFill;

    sessionResetEl = document.createElement('span');
    sessionResetEl.className = 'cum-reset';

    sessionGroup.append(sessionLabel, sessionPctEl, sTrack, sessionResetEl);

    // ── Divider 1 ──
    div1El = makeDivider();
    div1El.style.display = 'none';

    // ── Weekly (7d) ──
    weeklyGroupEl = document.createElement('div');
    weeklyGroupEl.className = 'cum-group';
    weeklyGroupEl.style.display = 'none';

    const weeklyLabel = document.createElement('span');
    weeklyLabel.className = 'cum-label';
    weeklyLabel.textContent = '7d';

    weeklyPctEl = document.createElement('span');
    weeklyPctEl.className = 'cum-pct';
    weeklyPctEl.textContent = '—';

    const { track: wTrack, fill: wFill } = makeMiniBar();
    weeklyFillEl = wFill;

    weeklyResetEl = document.createElement('span');
    weeklyResetEl.className = 'cum-reset';

    weeklyGroupEl.append(weeklyLabel, weeklyPctEl, wTrack, weeklyResetEl);

    // ── Divider 2 ──
    div2El = makeDivider();
    div2El.style.display = 'none';

    // ── Last fetched ──
    const lastFetchedGroup = document.createElement('div');
    lastFetchedGroup.className = 'cum-group';
    const lastFetchedLabel = document.createElement('span');
    lastFetchedLabel.className = 'cum-label';
    lastFetchedLabel.textContent = 'Fetched';
    lastFetchedEl = document.createElement('span');
    lastFetchedEl.className = 'cum-reset';
    lastFetchedEl.textContent = '';
    lastFetchedGroup.append(lastFetchedLabel, lastFetchedEl);

    // ── Context tokens ──
    ctxGroupEl = document.createElement('div');
    ctxGroupEl.className = 'cum-group';
    ctxGroupEl.style.display = 'none';

    const ctxLabel = document.createElement('span');
    ctxLabel.className = 'cum-label';
    ctxLabel.textContent = 'Ctx';

    ctxPctEl = document.createElement('span');
    ctxPctEl.className = 'cum-pct';

    const { track: cTrack, fill: cFill } = makeMiniBar();
    ctxFillEl = cFill;

    ctxUsedEl = document.createElement('span');
    ctxUsedEl.className = 'cum-ctx-used';

    ctxGroupEl.append(ctxLabel, ctxPctEl, cTrack, ctxUsedEl);

    // ── Divider 3 (between 7d and fetched) ──
    div3El = makeDivider();
    div3El.style.display = 'none';

    wrapper.append(sessionGroup, div1El, weeklyGroupEl, div3El, lastFetchedGroup, div2El, ctxGroupEl);
  }

  // ── Data → UI ─────────────────────────────────────────────────────────────
  function setUsage(data) {
    if (!sessionPctEl) return;

    const session = data?.five_hour;
    const weekly = data?.seven_day;

    if (session && typeof session.utilization === 'number') {
      const pct = Math.max(0, Math.min(100, session.utilization));
      const rounded = Math.round(pct * 10) / 10;
      sessionPctEl.textContent = `${rounded}%`;
      sessionPctEl.className = `cum-pct ${fillClass(pct)}`.trim();
      sessionFillEl.style.width = `${pct}%`;
      sessionFillEl.className = `cum-fill ${fillClass(pct)}`.trim();
      sessionResetMs = session.resets_at ? Date.parse(session.resets_at) : null;
      updateSessionReset();
    } else {
      sessionPctEl.textContent = '—';
      sessionPctEl.className = 'cum-pct';
      sessionFillEl.style.width = '0%';
      sessionFillEl.className = 'cum-fill';
      sessionResetMs = null;
      sessionResetEl.textContent = '';
    }

    if (weekly && typeof weekly.utilization === 'number') {
      const pct = Math.max(0, Math.min(100, weekly.utilization));
      const rounded = Math.round(pct * 10) / 10;
      weeklyPctEl.textContent = `${rounded}%`;
      weeklyPctEl.className = `cum-pct ${fillClass(pct)}`.trim();
      weeklyFillEl.style.width = `${pct}%`;
      weeklyFillEl.className = `cum-fill ${fillClass(pct)}`.trim();
      weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
      updateWeeklyReset();
      weeklyGroupEl.style.display = '';
      div1El.style.display = '';
      div3El.style.display = '';
    } else {
      weeklyGroupEl.style.display = 'none';
      div1El.style.display = 'none';
      div3El.style.display = 'none';
      weeklyResetMs = null;
      weeklyResetEl.textContent = '';
    }
  }

  function setTokenCount(totalTokens) {
    if (!ctxPctEl) return;
    if (typeof totalTokens !== 'number' || totalTokens <= 0) {
      // Keep the group visible but blank while on a non-chat page
      ctxGroupEl.style.display = 'none';
      div2El.style.display = 'none';
      ctxUsedEl.textContent = '';
      return;
    }
    const pct = Math.min(100, (totalTokens / CONTEXT_LIMIT) * 100);
    const rounded = Math.round(pct * 10) / 10;
    ctxPctEl.textContent = `${rounded}%`;
    ctxPctEl.className = `cum-pct ${fillClass(pct)}`.trim();
    ctxFillEl.style.width = `${pct}%`;
    ctxFillEl.className = `cum-fill ${fillClass(pct)}`.trim();
    ctxUsedEl.textContent = `· ${totalTokens.toLocaleString()} used`;
    ctxGroupEl.style.display = '';
    div2El.style.display = '';
  }

  function updateSessionReset() {
    if (!sessionResetEl) return;
    if (!sessionResetMs) { sessionResetEl.textContent = ''; return; }
    const rem = formatTimeRemaining(sessionResetMs);
    sessionResetEl.textContent = rem ? `· ${rem}` : '';
  }

  function updateWeeklyReset() {
    if (!weeklyResetEl) return;
    if (!weeklyResetMs) { weeklyResetEl.textContent = ''; return; }
    const rem = formatTimeRemaining(weeklyResetMs);
    weeklyResetEl.textContent = rem ? `· ${rem}` : '';
  }

  function tick() {
    updateSessionReset();
    updateWeeklyReset();
  }

  // ── DOM attachment ────────────────────────────────────────────────────────
  function findToolbarRow() {
    const modelSelector =
      document.querySelector('[data-testid="model-selector-dropdown"]') ||
      document.querySelector('[data-testid="model-selector-input-button"]');
    if (!modelSelector) return null;

    let cur = modelSelector.parentElement;
    while (cur && cur !== document.body) {
      if (cur.nodeType === 1) {
        const cs = window.getComputedStyle(cur);
        if (cs.display === 'flex' &&
            (cs.flexDirection === 'row' || cs.flexDirection === '') &&
            cur.querySelectorAll('button').length > 1) return cur;
      }
      cur = cur.parentElement;
    }
    return modelSelector.parentElement?.parentElement || null;
  }

  // The wrapper is created once and reused — we only move it if the toolbar
  // has changed (different parent), never recreate it.
  function attachBar() {
    if (!wrapper) buildUI();

    const toolbar = findToolbarRow();
    if (!toolbar) return;

    // Already in the right place
    if (wrapper.previousElementSibling === toolbar || toolbar.nextElementSibling === wrapper) return;

    // Insert (or re-insert) immediately after the toolbar
    toolbar.insertAdjacentElement('afterend', wrapper);
  }

  // ── waitForElement helper ─────────────────────────────────────────────────
  function waitForElement(selector, timeoutMs) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }
      let tid;
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { clearTimeout(tid); obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      if (timeoutMs) tid = setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  // ── Org ID ────────────────────────────────────────────────────────────────
  let orgIdCache = null;
  let orgIdFetchedAt = 0;
  let orgIdInFlight = null;

  async function fetchOrgId() {
    if (orgIdCache && Date.now() - orgIdFetchedAt < 10 * 60 * 1000) return orgIdCache;
    if (orgIdInFlight) return orgIdInFlight;

    orgIdInFlight = (async () => {
      const res = await fetch('/api/organizations', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`orgs ${res.status}`);
      const orgs = await res.json();
      if (!Array.isArray(orgs) || !orgs.length) throw new Error('no orgs');
      const org = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || orgs[0];
      const id = org.uuid || org.id;
      if (!id) throw new Error('no org id');
      orgIdCache = id;
      orgIdFetchedAt = Date.now();
      return id;
    })();

    try { return await orgIdInFlight; } finally { orgIdInFlight = null; }
  }

  // ── Last fetched display ──────────────────────────────────────────────────
  async function updateLastFetched() {
    if (!lastFetchedEl) return;
    try {
      const incognito = !!(await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: "getStatus", incognito: false }, (res) => {
          resolve(false);
        });
      }));
      const statusKey = incognito ? "last_keep_alive_incognito" : "last_keep_alive_regular";
      const data = await chrome.storage.local.get(statusKey);
      const status = data[statusKey] || {};
      const timestamp = status.lastFetched;
      if (!timestamp) {
        lastFetchedEl.textContent = '';
        return;
      }
      const now = Date.now();
      const diff = Math.floor((now - timestamp) / 1000);
      if (diff < 60) {
        lastFetchedEl.textContent = '· Just now';
      } else if (diff < 3600) {
        const m = Math.floor(diff / 60);
        lastFetchedEl.textContent = `· ${m}m ago`;
      } else if (diff < 86400) {
        const h = Math.floor(diff / 3600);
        lastFetchedEl.textContent = `· ${h}h ago`;
      } else {
        const d = new Date(timestamp);
        lastFetchedEl.textContent = `· ${d.toLocaleDateString()}`;
      }
    } catch {}
  }

  // ── Usage fetch ───────────────────────────────────────────────────────────
  let lastUsageFetchAt = 0;
  let usageInFlight = false;

  async function loadUsage(force = false) {
    if (!force && Date.now() - lastUsageFetchAt < USAGE_TTL) return;
    if (usageInFlight) return;
    usageInFlight = true;
    try {
      const orgId = await fetchOrgId();
      const res = await fetch(`/api/organizations/${orgId}/usage`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!res.ok) return;
      const data = await res.json();
      lastUsageFetchAt = Date.now();
      setUsage(data);
      updateLastFetched();
    } catch { /* silent */ } finally {
      usageInFlight = false;
    }
  }

  // ── Token count ───────────────────────────────────────────────────────────
  function getConversationId() {
    const m = window.location.pathname.match(/\/chat\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  let tokenFetchInFlight = false;

  async function fetchAndCountTokens() {
    const convId = getConversationId();
    if (!convId) { setTokenCount(null); return; }
    if (tokenFetchInFlight) return;
    tokenFetchInFlight = true;
    try {
      const orgId = await fetchOrgId();
      const res = await fetch(
        `/api/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`,
        { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' }
      );
      if (!res.ok) return;
      const data = await res.json();

      let charCount = 0;
      for (const msg of data.chat_messages || []) {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && typeof block.text === 'string') charCount += block.text.length;
          }
        } else if (typeof msg.content === 'string') {
          charCount += msg.content.length;
        }
        if (typeof msg.text === 'string') charCount += msg.text.length;
      }

      setTokenCount(Math.round(charCount / 4));
    } catch { /* silent */ } finally {
      tokenFetchInFlight = false;
    }
  }

  // ── Send-button watcher ───────────────────────────────────────────────────
  // Watches for generation completing by detecting the stop button being
  // replaced by the send button (Claude's UI swaps them during streaming).
  let sendBtnObserver = null;
  let generationActive = false;

  function watchForMessageSend() {
    if (sendBtnObserver) { sendBtnObserver.disconnect(); sendBtnObserver = null; }
    generationActive = false;

    sendBtnObserver = new MutationObserver(() => {
      // Stop button present → generation in progress
      const stopBtn = document.querySelector('[data-testid="stop-button"]') ||
                      document.querySelector('button[aria-label="Stop"]');
      const sendBtn = document.querySelector('[data-testid="send-button"]') ||
                      document.querySelector('button[aria-label="Send message"]');

      if (stopBtn) {
        generationActive = true;
        return;
      }
      if (generationActive && sendBtn) {
        // Generation just finished
        generationActive = false;
        setTimeout(fetchAndCountTokens, 1000);
      }
    });

    sendBtnObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Main orchestration ────────────────────────────────────────────────────
  let lastPath = window.location.pathname;

  function onUrlChange() {
    setTokenCount(null); // clear stale ctx immediately
    setTimeout(() => {
      attachBar();
      loadUsage(false);
      fetchAndCountTokens();
      watchForMessageSend();
    }, 400);
  }

  // DOM observer: SPA navigation + bar re-attachment
  const domObserver = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      onUrlChange();
      return;
    }
    // Re-attach if wrapper was removed by React reconciliation
    if (wrapper && !document.contains(wrapper)) {
      attachBar();
    }
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('popstate', () => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      onUrlChange();
    }
  });

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  injectStyles();

  function tryInit() {
    const hasChatUI = !!document.querySelector(
      '[data-testid="model-selector-dropdown"], [data-testid="model-selector-input-button"]'
    );
    attachBar();
    loadUsage(true);
    updateLastFetched();
    if (hasChatUI) {
      fetchAndCountTokens();
      watchForMessageSend();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    tryInit();
  }

  // Periodic usage refresh (every 2 min)
  setInterval(() => loadUsage(true), USAGE_TTL);

  // Periodic token re-count (every 1 min)
  setInterval(fetchAndCountTokens, TOKEN_POLL_MS);

  // Countdown tick
  setInterval(tick, 1000);

  // Update last fetched display (every 30 sec to keep it fresh, even when user isn't typing)
  setInterval(updateLastFetched, 30 * 1000);

})();
