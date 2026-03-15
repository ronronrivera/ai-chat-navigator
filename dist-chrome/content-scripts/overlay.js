// content-scripts/overlay.js
// Floating in-page navigator panel — always visible on AI sites, draggable, togglable

(function () {
  'use strict';

  // Prevent double-injection per page context
  if (window.__AI_NAV_OVERLAY_LOADED__) return;
  window.__AI_NAV_OVERLAY_LOADED__ = true;

  const STORAGE_KEY = 'ai-navigator:overlay-state';
  const OVERLAY_ENABLED_KEY = 'ai-navigator:overlay-enabled';
  const PANEL_ID = 'ai-nav-overlay-root';
  const REFRESH_MS = 3500;

  // ─── SITE DETECTION ──────────────────────────────────────────────────────
  function getSite() {
    const host = location.hostname;
    const path = location.pathname;
    const query = location.search;
    if (host.includes('chatgpt.com') || host.includes('chat.openai.com'))
      return { name: 'ChatGPT', color: '#10a37f', accent: 'rgba(16,163,127,0.8)' };
    if (host.includes('claude.ai'))
      return { name: 'Claude', color: '#e6914e', accent: 'rgba(230,145,78,0.8)' };
    if (host.includes('copilot.microsoft.com'))
      return { name: 'Copilot', color: '#5ca3e6', accent: 'rgba(92,163,230,0.8)' };
    if (host.includes('github.com') && (/copilot/i.test(path) || /copilot/i.test(query)))
      return { name: 'GitHub Copilot', color: '#7ee787', accent: 'rgba(126,231,135,0.8)' };
    return null;
  }

  const SITE = getSite();
  if (!SITE) return; // Not an AI site we support

  // ─── STATE ───────────────────────────────────────────────────────────────
  let state = {
    collapsed: false,
    overlayEnabled: true,
    turns: [],
    status: 'loading', // loading | ready | empty | error
    query: '',
    jumpingIndex: null,
    errorMsg: ''
  };
  let overlayRoot = null;
  let mountObserver = null;
  let refreshTimer = null;
  let hrefWatcherTimer = null;
  let lastObservedHref = location.href;
  let pendingHrefReloadTimer = null;
  let suppressTabToggleUntil = 0;
  let turnsRequestToken = 0;

  // Persist collapsed state to localStorage (simple, no storage API needed)
  function loadPersistedState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        state.collapsed = !!saved.collapsed;
      }
    } catch (_) {}
  }

  function savePersistedState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed: state.collapsed }));
    } catch (_) {}
  }

  async function loadOverlayEnabled() {
    try {
      const result = await getApi().storage.local.get(OVERLAY_ENABLED_KEY);
      if (typeof result[OVERLAY_ENABLED_KEY] === 'boolean') {
        state.overlayEnabled = result[OVERLAY_ENABLED_KEY];
      }
    } catch (_) {
      state.overlayEnabled = true;
    }
  }

  function applyOverlayEnabled() {
    if (!overlayRoot) return;
    overlayRoot.style.display = state.overlayEnabled ? '' : 'none';
  }

  function setOverlayEnabled(enabled) {
    state.overlayEnabled = !!enabled;
    applyOverlayEnabled();
    if (state.overlayEnabled && !state.collapsed && state.status !== 'ready') {
      loadTurns();
    }
    return { ok: true, enabled: state.overlayEnabled };
  }

  // ─── STYLES ──────────────────────────────────────────────────────────────
  const STYLES = `
    #ai-nav-overlay-root {
      all: initial;
      position: fixed;
      z-index: 2147483647;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      color: #e2e0ef;
      user-select: none;
      /* Default position: right side, vertically centered */
      right: 16px;
      top: 50%;
      transform: translateY(-50%);
      pointer-events: none; /* panel itself handles pointer events */
    }

    #ai-nav-overlay-root * {
      box-sizing: border-box;
    }

    /* ── TOGGLE TAB (always visible) ── */
    #ai-nav-tab {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 28px;
      height: 52px;
      background: ${SITE.color};
      border-radius: 8px 0 0 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      pointer-events: all;
      box-shadow: -2px 0 12px rgba(0,0,0,0.4);
      transition: width 0.15s ease, background 0.15s ease;
      writing-mode: vertical-lr;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #fff;
      padding: 0 4px;
      overflow: hidden;
      white-space: nowrap;
    }

    #ai-nav-tab:hover {
      width: 32px;
      background: ${SITE.accent};
    }

    #ai-nav-tab svg {
      writing-mode: horizontal-tb;
      flex-shrink: 0;
    }

    /* ── MAIN PANEL ── */
    #ai-nav-panel {
      position: relative;
      right: 28px;
      width: 300px;
      max-height: 70vh;
      background: rgba(12, 12, 18, 0.97);
      border: 1px solid rgba(255,255,255,0.08);
      border-right: none;
      border-radius: 12px 0 0 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      pointer-events: all;
      box-shadow: -4px 0 32px rgba(0,0,0,0.5);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }

    #ai-nav-panel.hidden {
      opacity: 0;
      transform: translateX(20px);
      pointer-events: none;
    }

    /* Accent bar */
    #ai-nav-panel::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, ${SITE.color}, transparent);
      z-index: 1;
    }

    /* ── HEADER ── */
    #ai-nav-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px 9px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      cursor: grab;
      flex-shrink: 0;
    }

    #ai-nav-header:active { cursor: grabbing; }

    #ai-nav-logo {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      background: linear-gradient(135deg, #6c5ce7, #fd79a8);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      flex-shrink: 0;
    }

    #ai-nav-title {
      flex: 1;
      font-size: 12px;
      font-weight: 700;
      color: #e2e0ef;
      letter-spacing: 0.02em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #ai-nav-site-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 20px;
      background: rgba(255,255,255,0.06);
      color: ${SITE.color};
      border: 1px solid ${SITE.color}44;
      flex-shrink: 0;
    }

    /* ── STATS ── */
    #ai-nav-stats {
      display: flex;
      gap: 12px;
      padding: 7px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      flex-shrink: 0;
    }

    .ai-nav-stat {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: rgba(226,224,239,0.55);
    }

    .ai-nav-stat-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .ai-nav-stat-num {
      font-weight: 700;
      color: #e2e0ef;
    }

    /* ── SEARCH ── */
    #ai-nav-search-wrap {
      padding: 7px 10px 6px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      flex-shrink: 0;
    }

    #ai-nav-search {
      all: unset;
      width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 11px;
      color: #e2e0ef;
      placeholder-color: rgba(226,224,239,0.35);
    }

    #ai-nav-search:focus {
      border-color: ${SITE.color}88;
      background: rgba(255,255,255,0.07);
      outline: none;
    }

    #ai-nav-search::placeholder {
      color: rgba(226,224,239,0.35);
    }

    /* ── LIST ── */
    #ai-nav-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.12) transparent;
    }

    #ai-nav-list::-webkit-scrollbar { width: 4px; }
    #ai-nav-list::-webkit-scrollbar-track { background: transparent; }
    #ai-nav-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }

    .ai-nav-turn {
      all: unset;
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      transition: background 0.1s ease;
      width: 100%;
      text-align: left;
    }

    .ai-nav-turn:hover {
      background: rgba(255,255,255,0.05);
    }

    .ai-nav-turn:hover .ai-nav-jump { opacity: 1; }

    .ai-nav-turn-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 1px;
      font-size: 8px;
      font-weight: 700;
    }

    .ai-nav-turn-dot.user {
      background: rgba(162,155,247,0.15);
      color: #a29bf7;
      border: 1px solid rgba(162,155,247,0.3);
    }

    .ai-nav-turn-dot.ai {
      background: rgba(253,121,168,0.15);
      color: #fd79a8;
      border: 1px solid rgba(253,121,168,0.3);
    }

    .ai-nav-turn-body {
      flex: 1;
      min-width: 0;
    }

    .ai-nav-turn-meta {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 2px;
    }

    .ai-nav-turn-role {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .ai-nav-turn-role.user { color: #a29bf7; }
    .ai-nav-turn-role.ai { color: #fd79a8; }

    .ai-nav-turn-num {
      font-size: 9px;
      color: rgba(226,224,239,0.3);
    }

    .ai-nav-turn-text {
      font-size: 11px;
      color: rgba(226,224,239,0.7);
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      line-clamp: 2;
      word-break: break-word;
    }

    .ai-nav-jump {
      font-size: 9px;
      font-weight: 600;
      color: ${SITE.color};
      opacity: 0;
      transition: opacity 0.15s ease;
      flex-shrink: 0;
      padding-top: 2px;
      letter-spacing: 0.04em;
    }

    .ai-nav-turn.jumping .ai-nav-jump { opacity: 1; animation: ai-nav-pulse 0.5s infinite alternate; }

    @keyframes ai-nav-pulse {
      from { opacity: 0.6; }
      to { opacity: 1; }
    }

    /* ── STATE SCREENS ── */
    #ai-nav-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px 16px;
      text-align: center;
      gap: 6px;
    }

    .ai-nav-state-icon { font-size: 24px; }
    .ai-nav-state-title { font-size: 13px; font-weight: 700; color: #e2e0ef; }
    .ai-nav-state-sub { font-size: 11px; color: rgba(226,224,239,0.5); line-height: 1.5; }

    /* ── FOOTER ── */
    #ai-nav-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      border-top: 1px solid rgba(255,255,255,0.05);
      background: rgba(255,255,255,0.02);
      flex-shrink: 0;
      gap: 8px;
    }

    #ai-nav-refresh {
      all: unset;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      color: rgba(226,224,239,0.55);
      cursor: pointer;
      padding: 3px 7px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      transition: background 0.1s, color 0.1s;
    }

    #ai-nav-refresh:hover {
      background: rgba(255,255,255,0.07);
      color: #e2e0ef;
    }

    #ai-nav-footer-label {
      font-size: 10px;
      color: rgba(226,224,239,0.3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  // ─── ESCAPE HTML ─────────────────────────────────────────────────────────
  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getVisibleTurns() {
    return state.turns.filter(turn => turn && turn.role === 'user');
  }

  // ─── BUILD DOM ───────────────────────────────────────────────────────────
  function buildPanelHTML() {
    const visibleTurns = getVisibleTurns();
    const userCount = visibleTurns.length;
    const aiCount = state.turns.filter(t => t.role === 'ai').length;
    const query = state.query.trim().toLowerCase();
    const filtered = query ? visibleTurns.filter(t => String(t.text || '').toLowerCase().includes(query)) : visibleTurns;
    const showList = state.status === 'ready' && visibleTurns.length > 0;

    const statsHTML = showList ? `
      <div id="ai-nav-stats">
        <div class="ai-nav-stat"><span class="ai-nav-stat-dot" style="background:#a29bf7"></span><span class="ai-nav-stat-num">${userCount}</span><span>prompts</span></div>
        <div class="ai-nav-stat"><span class="ai-nav-stat-dot" style="background:#fd79a8"></span><span class="ai-nav-stat-num">${aiCount}</span><span>AI hidden</span></div>
        <div class="ai-nav-stat" style="margin-left:auto"><span class="ai-nav-stat-num">${visibleTurns.length}</span><span>&nbsp;shown</span></div>
      </div>` : '';

    const searchHTML = showList ? `
      <div id="ai-nav-search-wrap">
        <input id="ai-nav-search" type="text" placeholder="filter turns…" value="${esc(state.query)}" autocomplete="off" spellcheck="false" />
      </div>` : '';

    let bodyHTML = '';
    const emptyTitle = (SITE.name === 'Claude' || SITE.name === 'GitHub Copilot') ? "It's empty" : 'No messages yet';
    if (state.status === 'loading') {
      bodyHTML = `<div id="ai-nav-state"><div class="ai-nav-state-icon">🔍</div><div class="ai-nav-state-title">Scanning…</div></div>`;
    } else if (state.status === 'empty') {
      bodyHTML = `<div id="ai-nav-state"><div class="ai-nav-state-icon">💬</div><div class="ai-nav-state-title">${emptyTitle}</div><div class="ai-nav-state-sub">Start a conversation, or refresh.</div></div>`;
    } else if (state.status === 'error') {
      bodyHTML = `<div id="ai-nav-state"><div class="ai-nav-state-icon">⚡</div><div class="ai-nav-state-title">Error</div><div class="ai-nav-state-sub">${esc(state.errorMsg)}</div></div>`;
    } else if (state.status === 'ready' && !visibleTurns.length) {
      bodyHTML = `<div id="ai-nav-state"><div class="ai-nav-state-icon">💬</div><div class="ai-nav-state-title">Session is empty</div><div class="ai-nav-state-sub">Send your first prompt to start tracking this chat.</div></div>`;
    } else if (showList) {
      const items = filtered.map(turn => {
        const role = turn.role === 'user' ? 'user' : 'ai';
        const isJumping = state.jumpingIndex === turn.index;
        const dotLabel = role === 'user' ? 'U' : 'AI';
        return `<button class="ai-nav-turn${isJumping ? ' jumping' : ''}" data-turn-index="${turn.index}">
          <span class="ai-nav-turn-dot ${role}">${dotLabel}</span>
          <span class="ai-nav-turn-body">
            <span class="ai-nav-turn-meta">
              <span class="ai-nav-turn-role ${role}">${role === 'user' ? 'You' : 'AI'}</span>
              <span class="ai-nav-turn-num">#${turn.index + 1}</span>
            </span>
            <span class="ai-nav-turn-text">${esc(turn.text)}</span>
          </span>
          <span class="ai-nav-jump">↓ jump</span>
        </button>`;
      }).join('');
      bodyHTML = `<div id="ai-nav-list">${items || '<div style="padding:12px;font-size:11px;color:rgba(226,224,239,0.4);text-align:center">No matching turns</div>'}</div>`;
    }

    const footerLabel = state.status === 'ready' && visibleTurns.length > 0
      ? `${visibleTurns.length} prompts`
      : state.status;

    return `
      <div id="ai-nav-header">
        <div id="ai-nav-logo">N</div>
        <div id="ai-nav-title">AI Navigator</div>
        <div id="ai-nav-site-badge">${esc(SITE.name)}</div>
      </div>
      ${statsHTML}
      ${searchHTML}
      ${bodyHTML}
      <div id="ai-nav-footer">
        <button id="ai-nav-refresh" type="button">↺ Refresh</button>
        <span id="ai-nav-footer-label">${esc(footerLabel)}</span>
      </div>
    `;
  }

  // ─── RENDER ──────────────────────────────────────────────────────────────
  let panel = null;
  let tab = null;
  let searchFocused = false;

  function ensureRootMounted() {
    if (!overlayRoot) return;
    const host = document.documentElement || document.body;
    if (!host) return;
    if (!host.contains(overlayRoot)) {
      host.appendChild(overlayRoot);
    }
  }

  function render() {
    if (!panel) return;
    applyOverlayEnabled();

    if (state.collapsed) {
      panel.classList.add('hidden');
      tab.title = 'Open AI Navigator';
    } else {
      panel.classList.remove('hidden');
      tab.title = 'Close AI Navigator';

      const prevScrollTop = panel.querySelector('#ai-nav-list') ? panel.querySelector('#ai-nav-list').scrollTop : 0;
      const prevQuery = state.query;

      panel.innerHTML = buildPanelHTML();

      // Re-attach search listener
      const searchInput = panel.querySelector('#ai-nav-search');
      if (searchInput) {
        if (searchFocused) { searchInput.focus(); searchInput.setSelectionRange(prevQuery.length, prevQuery.length); }
        searchInput.addEventListener('input', (e) => {
          state.query = e.target.value || '';
          searchFocused = true;
          render();
        });
        searchInput.addEventListener('focus', () => { searchFocused = true; });
        searchInput.addEventListener('blur', () => { searchFocused = false; });
      }

      // Restore scroll
      const list = panel.querySelector('#ai-nav-list');
      if (list) list.scrollTop = prevScrollTop;

      // Turn click events
      panel.querySelectorAll('.ai-nav-turn[data-turn-index]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-turn-index'));
          if (!Number.isNaN(idx)) jumpTo(idx);
        });
      });

      // Refresh button
      const refreshBtn = panel.querySelector('#ai-nav-refresh');
      if (refreshBtn) refreshBtn.addEventListener('click', () => { state.query = ''; loadTurns(); });

      // Draggable header
      const header = panel.querySelector('#ai-nav-header');
      if (header) makeDraggable(header);
    }
  }

  // ─── MESSAGING ───────────────────────────────────────────────────────────
  function getApi() { return typeof browser !== 'undefined' ? browser : chrome; }

  function getCurrentSiteKey() {
    if (SITE.name === 'ChatGPT') return 'chatgpt';
    if (SITE.name === 'Claude') return 'claude';
    if (SITE.name === 'GitHub Copilot') return 'github-copilot';
    if (SITE.name === 'Copilot') return 'copilot';
    return '';
  }

  function isLatestTurnsRequest(token, requestHref) {
    return token === turnsRequestToken && requestHref === location.href;
  }

  async function requestTurnsFromRuntime() {
    return getApi().runtime.sendMessage({ type: 'GET_TURNS' });
  }

  async function loadTurns() {
    const requestToken = ++turnsRequestToken;
    const requestHref = location.href;
    state.status = 'loading';
    render();
    try {
      let response = await requestTurnsFromRuntime();
      if (!response || !response.ok) {
        response = await loadTurnsFromPage();
      }

      if (!isLatestTurnsRequest(requestToken, requestHref)) return;

      if (response && response.ok) {
        state.turns = Array.isArray(response.turns) ? response.turns : [];
        state.status = state.turns.length ? 'ready' : 'empty';
        state.errorMsg = '';
      } else {
        state.turns = [];
        state.status = 'empty';
        state.errorMsg = '';
      }
      render();
    } catch (_) {
      // Fall back: request turns from page's content script via custom event
      const response = await loadTurnsFromPage();
      if (!isLatestTurnsRequest(requestToken, requestHref)) return;
      state.turns = response && Array.isArray(response.turns) ? response.turns : [];
      state.status = state.turns.length ? 'ready' : 'empty';
      state.errorMsg = '';
      render();
    }
  }

  // The overlay and the site content script (chatgpt.js etc.) run in the SAME
  // content script context (same extension page, same world). We can call a
  // shared event instead of runtime.sendMessage.
  function loadTurnsFromPage() {
    return new Promise((resolve) => {
      const requestId = `ai-nav-${Date.now()}`;

      function onResponse(e) {
        if (!e.detail || e.detail.requestId !== requestId) return;
        window.removeEventListener('ai-nav-turns-response', onResponse);
        resolve(e.detail);
      }

      window.addEventListener('ai-nav-turns-response', onResponse);
      window.dispatchEvent(new CustomEvent('ai-nav-turns-request', { detail: { requestId } }));

      // Timeout fallback
      setTimeout(() => {
        window.removeEventListener('ai-nav-turns-response', onResponse);
        resolve({ ok: false, turns: [] });
      }, 5000);
    });
  }

  async function jumpTo(index) {
    state.jumpingIndex = index;
    render();
    try {
      await getApi().runtime.sendMessage({ type: 'JUMP_TO_TURN', index });
    } catch (_) {
      window.dispatchEvent(new CustomEvent('ai-nav-jump-request', { detail: { index } }));
    }
    setTimeout(() => { state.jumpingIndex = null; render(); }, 900);
  }

  // ─── DRAG ────────────────────────────────────────────────────────────────
  function makeDraggable(handle) {
    const root = overlayRoot || document.getElementById(PANEL_ID);
    if (!root) return;

    let startX, startY, startRight, startTop;
    let moved = false;

    function onMouseMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const newRight = Math.max(0, Math.min(window.innerWidth - 60, startRight - dx));
      const newTop = Math.max(10, Math.min(window.innerHeight - 60, startTop + dy));
      root.style.right = `${newRight}px`;
      root.style.top = `${newTop}px`;
      root.style.transform = 'none';
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      handle.style.cursor = 'grab';
      if (moved) suppressTabToggleUntil = Date.now() + 220;
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      moved = false;
      const rect = root.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startRight = window.innerWidth - rect.right;
      startTop = rect.top;
      root.style.transform = 'none';
      handle.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // ─── MOUNT ───────────────────────────────────────────────────────────────
  function mount() {
    loadPersistedState();

    // Inject styles
    if (!document.getElementById('ai-nav-overlay-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'ai-nav-overlay-styles';
      styleEl.textContent = STYLES;
      (document.head || document.documentElement).appendChild(styleEl);
    }

    // Create root
    overlayRoot = document.createElement('div');
    overlayRoot.id = PANEL_ID;
    (document.documentElement || document.body).appendChild(overlayRoot);

    // Create toggle tab
    tab = document.createElement('div');
    tab.id = 'ai-nav-tab';
    tab.title = state.collapsed ? 'Open AI Navigator' : 'Close AI Navigator';
    tab.innerHTML = 'Nav';
    tab.addEventListener('click', () => {
      if (Date.now() < suppressTabToggleUntil) return;
      state.collapsed = !state.collapsed;
      savePersistedState();
      ensureRootMounted();
      render();
      if (!state.collapsed && state.status !== 'ready') loadTurns();
    });
    overlayRoot.appendChild(tab);
    makeDraggable(tab);

    // Create panel
    panel = document.createElement('div');
    panel.id = 'ai-nav-panel';
    if (state.collapsed) panel.classList.add('hidden');
    overlayRoot.appendChild(panel);

    render();
    applyOverlayEnabled();

    // Initial load unless collapsed
    if (state.overlayEnabled && !state.collapsed) {
      loadTurns();
    }

    // Auto-refresh
    refreshTimer = setInterval(() => {
      if (!state.collapsed && document.visibilityState === 'visible' && state.status !== 'loading') {
        // Silent refresh: only update if we can get turns without showing loading
        doSilentRefresh();
      }
    }, REFRESH_MS);

    if (!hrefWatcherTimer) {
      hrefWatcherTimer = setInterval(() => {
        const nextHref = location.href;
        if (nextHref === lastObservedHref) return;
        lastObservedHref = nextHref;
        clearTimeout(pendingHrefReloadTimer);
        state.query = '';
        state.turns = [];
        state.status = 'loading';
        render();
        if (state.overlayEnabled && !state.collapsed) {
          pendingHrefReloadTimer = setTimeout(() => {
            loadTurns();
          }, 700);
        }
      }, 450);
    }

    if (!mountObserver && document.documentElement) {
      mountObserver = new MutationObserver(() => {
        ensureRootMounted();
        applyOverlayEnabled();
      });
      mountObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  async function doSilentRefresh() {
    const requestToken = turnsRequestToken;
    const requestHref = location.href;
    try {
      let response = await requestTurnsFromRuntime();
      if ((!response || !response.ok) && requestHref === location.href) {
        response = await loadTurnsFromPage();
      }
      if (!isLatestTurnsRequest(requestToken, requestHref)) return;
      if (response && response.ok && Array.isArray(response.turns)) {
        state.turns = response.turns;
        state.status = response.turns.length ? 'ready' : 'empty';
        render();
      }
    } catch (_) {
      // Silent failure — don't change UI
    }
  }

  // ─── CROSS-SCRIPT BRIDGE ─────────────────────────────────────────────────
  // Listen for turn requests dispatched by this overlay itself (when runtime.sendMessage fails)
  // The site content scripts (chatgpt.js etc.) also listen for this and respond.
  // This is set up here as a fallback receiver in case sendMessage works.
  window.addEventListener('ai-nav-turns-request', () => {});
  window.addEventListener('ai-nav-jump-request', () => {});
  window.addEventListener('ai-nav-turns-updated', (e) => {
    const detail = e && e.detail ? e.detail : null;
    if (!detail) return;
    if (detail.site && detail.site !== getCurrentSiteKey()) return;
    if (!Array.isArray(detail.turns)) return;

    state.turns = detail.turns;
    state.status = detail.turns.length ? 'ready' : 'empty';
    state.errorMsg = '';

    if (!state.collapsed && state.overlayEnabled) {
      render();
    }
  });
  window.addEventListener('ai-nav-overlay-enabled', (e) => {
    const enabled = !!(e && e.detail && e.detail.enabled);
    setOverlayEnabled(enabled);
  });

  getApi().runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'SET_OVERLAY_ENABLED') {
      return Promise.resolve(setOverlayEnabled(msg.enabled));
    }
    return false;
  });

  // Wait for DOM ready
  async function init() {
    await loadOverlayEnabled();
    mount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
