// content-scripts/copilot.js
// Starter scaffold for copilot.microsoft.com in the Chrome build.

(function () {
  'use strict';

  const SITE = 'copilot';
  const STORAGE_PREFIX = 'ai-nav:copilot:';
  let inMemoryCache = [];
  let lastHref = location.href;
  let observerStarted = false;

  function getApi() { return typeof browser !== 'undefined' ? browser : chrome; }

  function getConversationId() {
    const url = new URL(location.href);
    return url.pathname + url.search;
  }

  function getStorageKey() {
    return `${STORAGE_PREFIX}${getConversationId()}`;
  }

  async function loadCachedTurns() {
    try {
      const storage = getApi()?.storage?.local;
      if (!storage) return { turns: [] };
      const data = await storage.get(getStorageKey());
      return data[getStorageKey()] || { turns: [] };
    } catch (_) {
      return { turns: [] };
    }
  }

  async function persistTurns(turns) {
    try {
      const storage = getApi()?.storage?.local;
      if (!storage) return;
      const payload = {
        site: SITE,
        conversationId: getConversationId(),
        updatedAt: Date.now(),
        turns: Array.isArray(turns) ? turns : []
      };
      await storage.set({ [getStorageKey()]: payload });
      window.dispatchEvent(new CustomEvent('ai-nav-turns-updated', { detail: payload }));
    } catch (_) {
    }
  }

  async function syncTurns() {
    // Placeholder extractor for the Chrome build.
    // Keeps the extension loadable while site-specific parsing is implemented.
    inMemoryCache = [];
    await persistTurns(inMemoryCache);
  }

  async function handleGetTurns() {
    if (!inMemoryCache.length) {
      const cached = await loadCachedTurns();
      if (cached && Array.isArray(cached.turns)) {
        inMemoryCache = cached.turns;
      }
    }

    return {
      ok: true,
      site: SITE,
      conversationId: getConversationId(),
      updatedAt: Date.now(),
      turns: inMemoryCache.slice()
    };
  }

  async function handleJumpToTurn(index) {
    return { ok: false, site: SITE, index };
  }

  function scheduleSync() {
    syncTurns().catch(() => {});
  }

  function startObserver() {
    if (observerStarted || !document.body) return;
    observerStarted = true;

    const observer = new MutationObserver(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
      }
      scheduleSync();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    window.addEventListener('focus', scheduleSync);
    window.addEventListener('load', scheduleSync);
    window.addEventListener('popstate', scheduleSync);
    window.addEventListener('hashchange', scheduleSync);

    scheduleSync();
  }

  getApi().runtime.onMessage.addListener((msg) => {
    startObserver();
    if (msg.type === 'GET_TURNS') return handleGetTurns();
    if (msg.type === 'JUMP_TO_TURN') return handleJumpToTurn(msg.index);
    return false;
  });

  window.addEventListener('ai-nav-turns-request', (e) => {
    const requestId = e && e.detail && e.detail.requestId;
    handleGetTurns().then((payload) => {
      window.dispatchEvent(new CustomEvent('ai-nav-turns-response', { detail: { ...payload, requestId } }));
    }).catch(() => {});
  });

  window.addEventListener('ai-nav-jump-request', (e) => {
    const index = e && e.detail && typeof e.detail.index === 'number' ? e.detail.index : -1;
    if (index >= 0) handleJumpToTurn(index).catch(() => {});
  });

  startObserver();
})();