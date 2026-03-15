// content-scripts/claude.js
// Conversation extraction, persistence, and jump navigation for claude.ai

(function () {
  'use strict';

  const SITE = 'claude';
  const STORAGE_PREFIX = 'ai-navigator:conversation:';
  const UPDATE_DEBOUNCE_MS = 400;
  const RETRY_DELAY_MS = 500;
  const MAX_RETRIES = 10;
  const MAX_TEXT_LENGTH = 500;
  const MAX_TURNS = 1200;
  const HIGHLIGHT_COLOR = 'rgba(230,145,78,0.9)';
  const URL_CHECK_MS = 1000;
  const NAVIGATION_GUARD_MS = 2500;

  let persistTimer = null;
  let observerStarted = false;
  let lastHref = location.href;
  let inMemoryCache = [];
  let lastConvId = null;
  let lastNavigationAt = 0;
  let lastConversationTurns = [];

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fingerprint(text) {
    return normalizeText(text).toLowerCase().slice(0, 180);
  }

  function shouldSkipNode(node) {
    return !!(node && node.nodeType === Node.ELEMENT_NODE &&
      /^(SCRIPT|STYLE|NOSCRIPT|SVG|PATH|BUTTON|INPUT|TEXTAREA|SELECT|OPTION)$/.test(node.tagName));
  }

  function collectText(node, parts) {
    if (!parts) parts = [];
    if (!node) return parts;
    if (node.nodeType === Node.TEXT_NODE) {
      const v = normalizeText(node.textContent);
      if (v) parts.push(v);
      return parts;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return parts;
    if (node.nodeType === Node.ELEMENT_NODE && shouldSkipNode(node)) return parts;
    if (node.shadowRoot) collectText(node.shadowRoot, parts);
    for (const child of node.childNodes) collectText(child, parts);
    return parts;
  }

  function extractText(element) {
    const deepText = normalizeText(collectText(element).join(' '));
    const visibleText = normalizeText(element.innerText || element.textContent || '');
    const raw = deepText || visibleText;
    return normalizeText(raw)
      .replace(/^(you said:|claude said:|human:|assistant:)/i, '')
      .replace(/\b(Copy|Retry|Edit|Share|Thumbs up|Thumbs down|Good response|Bad response|Report|Regenerate)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getConversationId() {
    const url = new URL(location.href);
    const parts = url.pathname.split('/').filter(Boolean);
    // /chat/<uuid>  or  /new  etc.
    let id = '';
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'chat' && parts[i + 1]) { id = parts[i + 1]; break; }
    }

    if (!id) {
      id = url.searchParams.get('conversation_id') ||
        url.searchParams.get('conversationId') ||
        url.searchParams.get('thread') ||
        url.searchParams.get('thread_uuid') ||
        '';
    }

    if (!id) {
      const uuidMatch = url.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
      if (uuidMatch) id = uuidMatch[0];
    }

    if (!id) id = `${url.pathname}${url.search}` || parts[parts.length - 1] || 'home';
    return `${SITE}:${id}`.replace(/[^a-z0-9:_-]/gi, '-').toLowerCase();
  }

  function getStorageKey() {
    return `${STORAGE_PREFIX}${getConversationId()}`;
  }

  function hasExplicitConversationInUrl() {
    const url = new URL(location.href);
    const parts = url.pathname.split('/').filter(Boolean);
    const chatIndex = parts.indexOf('chat');
    if (chatIndex >= 0 && parts[chatIndex + 1]) return true;

    return !!(
      url.searchParams.get('conversation_id') ||
      url.searchParams.get('conversationId') ||
      url.searchParams.get('thread') ||
      url.searchParams.get('thread_uuid')
    );
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;

    let current = element;
    while (current && current instanceof HTMLElement) {
      if (current.hidden || current.inert) return false;
      if (current.getAttribute('aria-hidden') === 'true') return false;
      current = current.parentElement;
    }

    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getActiveConversationRoot() {
    const candidates = Array.from(document.querySelectorAll('main, [role="main"], .flex-1')).filter(isElementVisible);
    if (!candidates.length) return document.body;

    const scored = candidates.map((root) => {
      const messageScore = root.querySelectorAll('[data-testid*="turn" i], [data-testid*="message" i], article, [class*="message" i], [class*="turn" i]').length;
      const composerScore = root.querySelectorAll('textarea, [contenteditable="true"]').length * 4;
      return { root, score: messageScore + composerScore };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0] && scored[0].score > 0 ? scored[0].root : candidates[0];
  }

  function findMessageContainer(element, root) {
    let current = element instanceof HTMLElement ? element : null;
    const stop = root instanceof HTMLElement ? root : document.body;

    while (current && current !== stop && current !== document.body) {
      const className = String(current.className || '').toLowerCase();
      const testId = String(current.getAttribute('data-testid') || '').toLowerCase();
      const role = String(current.getAttribute('data-role') || '').toLowerCase();

      if (
        /turn|message|bubble|response|prompt/.test(className) ||
        /turn|message|response|prompt/.test(testId) ||
        /user|assistant|human/.test(role)
      ) {
        return current;
      }

      current = current.parentElement;
    }

    return element instanceof HTMLElement ? element : null;
  }

  // ─── ELEMENT SELECTION ────────────────────────────────────────────────────
  function getElements() {
    const root = getActiveConversationRoot() || document;
    const fallbackSelectors = [
      '[data-testid="human-turn"]',
      '[data-testid="assistant-turn"]',
      '[data-testid*="turn" i]',
      '[data-testid*="message" i]',
      '[data-testid*="chat" i]',
      '[data-role="user"]',
      '[data-role="assistant"]',
      'article',
      '[class*="human-turn" i]',
      '[class*="assistant-turn" i]',
      '[class*="user-message" i]',
      '[class*="assistant-message" i]',
      '[class*="chat-message" i]',
      '[class*="message-bubble" i]',
      '[class*="font-claude-message" i]',
      '[class*="prose" i]'
    ];

    const seen = new Set();
    const elements = [];

    for (const selector of fallbackSelectors) {
      for (const rawEl of root.querySelectorAll(selector)) {
        if (!(rawEl instanceof HTMLElement) || !isElementVisible(rawEl)) continue;
        const el = findMessageContainer(rawEl, root);
        if (!(el instanceof HTMLElement) || seen.has(el) || !isElementVisible(el)) continue;
        if (elements.some(ex => ex.contains(el) || el.contains(ex))) continue;
        const text = extractText(el);
        if (!text || text.length < 2) continue;
        seen.add(el);
        elements.push(el);
      }
    }

    elements.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    return elements;
  }

  function detectRole(element) {
    const testId = String(element.getAttribute('data-testid') || '').toLowerCase();
    const dataRole = String(element.getAttribute('data-role') || '').toLowerCase();
    if (dataRole === 'user' || dataRole === 'human') return 'user';
    if (dataRole === 'assistant' || dataRole === 'ai') return 'ai';
    if (testId.includes('human')) return 'user';
    if (testId.includes('assistant') || testId.includes('ai-')) return 'ai';
    const label = String(element.getAttribute('aria-label') || '').toLowerCase();
    const className = String(element.className || '').toLowerCase();
    const combined = `${testId} ${dataRole} ${label} ${className}`;
    if (/\bhuman\b|\buser\b|author-user/.test(combined)) return 'user';
    return 'ai';
  }

  // ─── TURNS ────────────────────────────────────────────────────────────────
  function buildTurns(elements) {
    const occurrenceMap = new Map();
    const turns = [];
    for (const element of elements) {
      const role = detectRole(element);
      const text = extractText(element);
      if (!text || text.length < 2) continue;
      const normalized = text.slice(0, MAX_TEXT_LENGTH);
      const base = `${role}:${fingerprint(normalized)}`;
      const occurrence = (occurrenceMap.get(base) || 0) + 1;
      occurrenceMap.set(base, occurrence);
      turns.push({ role, text: normalized, fingerprint: fingerprint(normalized), key: `${base}:${occurrence}` });
    }

    if (turns.length > 1 && !turns.some(turn => turn.role === 'user')) {
      for (let i = 0; i < turns.length; i += 1) {
        const inferredRole = i % 2 === 0 ? 'user' : 'ai';
        turns[i].role = inferredRole;
        turns[i].key = `${inferredRole}:${turns[i].fingerprint}:${Math.floor(i / 2) + 1}`;
      }
    }

    return turns.map((turn, index) => ({ ...turn, index }));
  }

  function reindexTurns(turns) {
    return turns.map((turn, index) => ({ ...turn, index }));
  }

  function sameTurn(a, b) {
    if (!a || !b) return false;
    if (a.key && b.key && a.key === b.key) return true;
    return a.role === b.role && a.fingerprint === b.fingerprint;
  }

  function getTurnIdentity(turn) {
    if (!turn) return '';
    return String(turn.key || `${turn.role}:${turn.fingerprint || fingerprint(turn.text || '')}`);
  }

  function trimTurns(turns) {
    const list = Array.isArray(turns) ? turns : [];
    if (list.length <= MAX_TURNS) return reindexTurns(list);
    return reindexTurns(list.slice(list.length - MAX_TURNS));
  }

  function sanitizeTurns(turns) {
    const cleaned = [];
    const indexByIdentity = new Map();

    for (const raw of (turns || [])) {
      const role = raw.role === 'user' ? 'user' : 'ai';
      const text = normalizeText(raw.text).slice(0, MAX_TEXT_LENGTH);
      if (!text || text.length < 2) continue;
      const item = { role, text, fingerprint: fingerprint(text), key: raw.key || `${role}:${fingerprint(text)}` };

      const identity = getTurnIdentity(item);
      const idx = indexByIdentity.has(identity) ? indexByIdentity.get(identity) : -1;
      if (idx >= 0) { if (item.text.length > cleaned[idx].text.length) cleaned[idx] = item; }
      else {
        indexByIdentity.set(identity, cleaned.length);
        cleaned.push(item);
      }
    }

    return trimTurns(cleaned);
  }

  function mergeTurns(cachedTurns, liveTurns) {
    const cached = sanitizeTurns(cachedTurns);
    const live = sanitizeTurns(liveTurns);
    if (!cached.length) return live;
    if (!live.length) return cached;

    const cachedIds = new Set(cached.map(getTurnIdentity));
    const liveIds = new Set(live.map(getTurnIdentity));
    let overlap = 0;
    for (const id of liveIds) {
      if (cachedIds.has(id)) overlap += 1;
    }

    const minSize = Math.min(cached.length, live.length);
    const overlapThreshold = Math.max(3, Math.floor(minSize * 0.45));
    if (overlap < overlapThreshold) {
      // Low overlap usually means navigation to a different session while old
      // cached turns are still around; prefer fresh live turns only.
      return live;
    }

    // History = cached turns not currently in live viewport.
    const history = cached.filter(t => !liveIds.has(getTurnIdentity(t)));
    return trimTurns([...history, ...live]);
  }

  function hasStrongOverlap(referenceTurns, liveTurns) {
    const reference = sanitizeTurns(referenceTurns).slice(0, 8);
    const live = sanitizeTurns(liveTurns).slice(0, 8);
    if (!reference.length || !live.length) return false;

    let overlap = 0;
    for (const turn of live) {
      if (reference.some(existing => sameTurn(existing, turn))) overlap += 1;
    }

    return overlap >= Math.max(2, Math.min(reference.length, live.length) - 1);
  }

  // ─── STORAGE ──────────────────────────────────────────────────────────────
  function getApi() { return typeof browser !== 'undefined' ? browser : chrome; }

  function emitTurnsUpdated(payload) {
    try {
      window.dispatchEvent(new CustomEvent('ai-nav-turns-updated', { detail: payload }));
    } catch (_) {}
  }

  async function readCache() {
    const storage = getApi()?.storage?.local;
    if (!storage) return { turns: inMemoryCache };
    try {
      const result = await storage.get(getStorageKey());
      const data = result[getStorageKey()];
      // Validate that cached data is for the current conversation
      if (data && data.conversationId && data.conversationId !== getConversationId()) return { turns: [] };
      return data || { turns: [] };
    } catch (_) { return { turns: inMemoryCache }; }
  }

  async function writeCache(turns) {
    const payload = { site: SITE, url: location.href, title: document.title,
      conversationId: getConversationId(), updatedAt: Date.now(), turns: trimTurns(turns) };
    inMemoryCache = payload.turns;
    if (payload.turns.length) lastConversationTurns = payload.turns.slice();
    emitTurnsUpdated(payload);
    const storage = getApi()?.storage?.local;
    if (!storage) return payload;
    try { await storage.set({ [getStorageKey()]: payload }); } catch (_) {}
    return payload;
  }

  async function syncTurnsFromDom() {
    const conversationId = getConversationId();
    const liveTurns = buildTurns(getElements());
    if (!liveTurns.length) {
      if (!hasExplicitConversationInUrl()) {
        return writeCache([]);
      }
      return readCache();
    }

    if (Date.now() - lastNavigationAt < NAVIGATION_GUARD_MS && hasStrongOverlap(lastConversationTurns, liveTurns)) {
      return { site: SITE, url: location.href, title: document.title, conversationId, updatedAt: Date.now(), turns: [] };
    }

    const cached = await readCache();
    return writeCache(mergeTurns(cached.turns || [], liveTurns));
  }

  function scheduleSync() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => syncTurnsFromDom().catch(() => {}), UPDATE_DEBOUNCE_MS);
  }

  // ─── SCROLL / JUMP ────────────────────────────────────────────────────────
  function getScrollRoot(sampleEl) {
    let current = sampleEl instanceof HTMLElement ? sampleEl.parentElement : null;
    while (current) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 80) return current;
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getScrollTop(root) {
    if (root === document.body || root === document.documentElement || root === document.scrollingElement)
      return window.scrollY || document.documentElement.scrollTop || 0;
    return root.scrollTop;
  }

  function setScrollTop(root, value) {
    if (root === document.body || root === document.documentElement || root === document.scrollingElement)
      window.scrollTo({ top: value, behavior: 'smooth' });
    else root.scrollTo({ top: value, behavior: 'smooth' });
  }

  function getMaxScrollTop(root) {
    if (root === document.body || root === document.documentElement || root === document.scrollingElement)
      return Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight);
    return Math.max(0, root.scrollHeight - root.clientHeight);
  }

  function buildEntries() {
    const elements = getElements();
    const turns = buildTurns(elements);
    return turns.map((turn, i) => ({ turn, element: elements[i] })).filter(e => e.element);
  }

  function findMatchingElement(targetTurn) {
    const entries = buildEntries();
    let match = entries.find(e => sameTurn(e.turn, targetTurn));
    if (match) return match.element;
    match = entries.find(e => e.turn.role === targetTurn.role && e.turn.fingerprint === targetTurn.fingerprint);
    if (match) return match.element;
    const prefix = targetTurn.text.slice(0, 100);
    match = entries.find(e => e.turn.role === targetTurn.role &&
      (e.turn.text.startsWith(prefix) || prefix.startsWith(e.turn.text.slice(0, 80))));
    return match ? match.element : null;
  }

  function highlightElement(element) {
    if (!(element instanceof HTMLElement)) return;
    const prev = { outline: element.style.outline, outlineOffset: element.style.outlineOffset,
      borderRadius: element.style.borderRadius, transition: element.style.transition };
    element.style.outline = `2px solid ${HIGHLIGHT_COLOR}`;
    element.style.outlineOffset = '4px';
    element.style.borderRadius = '8px';
    element.style.transition = 'outline 0.2s ease';
    setTimeout(() => { Object.assign(element.style, prev); }, 1800);
  }

  async function scanForElement(targetTurn, targetIndex, totalTurns) {
    let element = findMatchingElement(targetTurn);
    if (element) return element;
    const firstEl = getElements()[0];
    const root = getScrollRoot(firstEl);
    const maxScroll = getMaxScrollTop(root);
    if (maxScroll <= 0) return null;
    const current = getScrollTop(root);
    const ratio = totalTurns > 1 ? targetIndex / (totalTurns - 1) : 0;
    const targetScroll = Math.round(maxScroll * ratio);
    const step = Math.max(300, Math.round((window.innerHeight || 700) * 0.75));
    for (const point of [targetScroll, 0, maxScroll, current]) {
      setScrollTop(root, point); await delay(250);
      element = findMatchingElement(targetTurn); if (element) return element;
    }
    for (let pos = targetScroll; pos >= 0; pos -= step) {
      setScrollTop(root, pos); await delay(200);
      element = findMatchingElement(targetTurn); if (element) return element;
    }
    for (let pos = targetScroll; pos <= maxScroll; pos += step) {
      setScrollTop(root, pos); await delay(200);
      element = findMatchingElement(targetTurn); if (element) return element;
    }
    return null;
  }

  // ─── MESSAGE HANDLERS ─────────────────────────────────────────────────────
  async function ensureFreshTurns() {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const payload = await syncTurnsFromDom();
      if (payload && payload.turns && payload.turns.length) return payload;
      await delay(RETRY_DELAY_MS);
    }
    return readCache();
  }

  async function handleGetTurns() {
    const payload = await ensureFreshTurns();
    return { ok: true, site: SITE, conversationId: payload.conversationId || getConversationId(),
      updatedAt: payload.updatedAt || Date.now(), turns: payload.turns || [] };
  }

  async function handleJumpToTurn(index) {
    const payload = await ensureFreshTurns();
    const turns = payload.turns || [];
    const targetTurn = turns[index];
    if (!targetTurn) return { ok: false, reason: 'Turn not found' };
    const element = await scanForElement(targetTurn, index, turns.length);
    if (!element) return { ok: false, reason: 'Element not found in DOM' };
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightElement(element);
    return { ok: true };
  }

  // ─── OBSERVER ─────────────────────────────────────────────────────────────
  function startObserver() {
    if (observerStarted || !document.body) return;
    observerStarted = true;
    lastConvId = getConversationId();

    const observer = new MutationObserver(() => scheduleSync());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: false });

    window.addEventListener('focus', scheduleSync);
    window.addEventListener('load', scheduleSync);
    window.addEventListener('hashchange', scheduleSync);
    window.addEventListener('popstate', scheduleSync);

    setInterval(() => {
      const newHref = location.href;
      if (newHref !== lastHref) {
        lastHref = newHref;
        const newConvId = getConversationId();
        if (newConvId !== lastConvId) {
          if (inMemoryCache.length) lastConversationTurns = inMemoryCache.slice();
          inMemoryCache = [];
          lastConvId = newConvId;
          lastNavigationAt = Date.now();
        }
        scheduleSync();
      }
    }, URL_CHECK_MS);

    scheduleSync();
  }

  getApi().runtime.onMessage.addListener((msg) => {
    startObserver();
    if (msg.type === 'GET_TURNS') return handleGetTurns();
    if (msg.type === 'JUMP_TO_TURN') return handleJumpToTurn(msg.index);
    return false;
  });

    // Overlay bridge
    window.addEventListener('ai-nav-turns-request', (e) => {
      const requestId = e && e.detail && e.detail.requestId;
      handleGetTurns().then(payload => {
        window.dispatchEvent(new CustomEvent('ai-nav-turns-response', { detail: { ...payload, requestId } }));
      }).catch(() => {});
    });

    window.addEventListener('ai-nav-jump-request', (e) => {
      const index = e && e.detail && typeof e.detail.index === 'number' ? e.detail.index : -1;
      if (index >= 0) handleJumpToTurn(index).catch(() => {});
    });

  startObserver();
})();


