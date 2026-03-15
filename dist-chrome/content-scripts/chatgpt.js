// content-scripts/chatgpt.js
// Robust conversation extraction, persistence, and jump navigation for chatgpt.com

(function () {
  'use strict';

  const SITE = 'chatgpt';
  const STORAGE_PREFIX = 'ai-navigator:conversation:';
  const UPDATE_DEBOUNCE_MS = 400;
  const RETRY_DELAY_MS = 500;
  const MAX_RETRIES = 10;
  const MAX_TEXT_LENGTH = 500;
  const MAX_TURNS = 1200;
  const MIN_TEXT_LENGTH = 3;
  const HIGHLIGHT_COLOR = 'rgba(16,163,127,0.85)';
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
    return !!(node && node.nodeType === Node.ELEMENT_NODE && /^(SCRIPT|STYLE|NOSCRIPT|SVG|PATH|BUTTON|INPUT|TEXTAREA|SELECT|OPTION)$/.test(node.tagName));
  }

  function collectText(node, parts = []) {
    if (!node) return parts;

    if (node.nodeType === Node.TEXT_NODE) {
      const value = normalizeText(node.textContent);
      if (value) parts.push(value);
      return parts;
    }

    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return parts;
    }

    if (node.nodeType === Node.ELEMENT_NODE && shouldSkipNode(node)) {
      return parts;
    }

    if (node.shadowRoot) {
      collectText(node.shadowRoot, parts);
    }

    for (const child of node.childNodes) {
      collectText(child, parts);
    }

    return parts;
  }

  function extractText(element) {
    const deepText = normalizeText(collectText(element).join(' '));
    const visibleText = normalizeText(element.innerText || element.textContent || '');
    const text = deepText || visibleText;
    return normalizeText(text)
      .replace(/^(you said:|chatgpt said:)/i, '')
      .replace(/\b(Copy code|Copy|Edit message|Regenerate|Read aloud|Good response|Bad response)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getConversationId() {
    const url = new URL(location.href);
    const parts = url.pathname.split('/').filter(Boolean);
    // URL pattern: /c/<uuid>  or  /g/<model>/<uuid>
    let id = '';
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'c' && parts[i + 1]) {
        id = parts[i + 1];
        break;
      }
      if (parts[i] === 'g') {
        id = parts[i + 2] || parts[i + 1] || '';
        if (id) break;
      }
    }

    if (!id) {
      id = url.searchParams.get('conversation_id') ||
        url.searchParams.get('conversationId') ||
        url.searchParams.get('thread_id') ||
        url.searchParams.get('thread') ||
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
    const mains = Array.from(document.querySelectorAll('main')).filter(isElementVisible);
    if (!mains.length) return document.body;

    const scored = mains.map((main) => ({
      root: main,
      score:
        main.querySelectorAll('[data-message-author-role]').length * 5 +
        main.querySelectorAll('article[data-testid*="conversation-turn"]').length * 3 +
        main.querySelectorAll('textarea, [contenteditable="true"]').length * 4
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0] && scored[0].score > 0 ? scored[0].root : mains[0];
  }

  function getTurnContainer(rawEl) {
    if (!(rawEl instanceof HTMLElement)) return null;

    let container = rawEl.closest('article[data-testid*="conversation-turn"], [data-message-author-role]');
    if (!(container instanceof HTMLElement)) container = rawEl;

    const roleHost = container.hasAttribute('data-message-author-role')
      ? container
      : container.querySelector('[data-message-author-role]');

    if (!(roleHost instanceof HTMLElement)) return null;
    return container;
  }

  function getElements() {
    const selectors = [
      'main [data-message-author-role]',
      'main article[data-testid*="conversation-turn"]',
      '[data-message-author-role]'
    ];

    const seen = new Set();
    const elements = [];
    const root = getActiveConversationRoot() || document;

    for (const selector of selectors) {
      for (const rawEl of root.querySelectorAll(selector)) {
        if (!(rawEl instanceof HTMLElement) || !isElementVisible(rawEl)) continue;

        const el = getTurnContainer(rawEl);
        if (!(el instanceof HTMLElement) || seen.has(el) || !isElementVisible(el)) continue;
        if (elements.some(existing => existing.contains(el) || el.contains(existing))) continue;

        const text = extractText(el);
        if (!text || text.length < MIN_TEXT_LENGTH) continue;

        seen.add(el);
        elements.push(el);
      }
      if (elements.length >= 2) break;
    }

    elements.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    return elements;
  }

  function detectRole(element) {
    const roleHost = element.hasAttribute('data-message-author-role')
      ? element
      : element.querySelector('[data-message-author-role]');
    const dataRole = String((roleHost && roleHost.getAttribute('data-message-author-role')) || '').toLowerCase();
    if (dataRole === 'user') return 'user';
    if (dataRole === 'assistant' || dataRole === 'tool' || dataRole === 'system') return 'ai';

    const testId = String(element.dataset.testid || element.getAttribute('data-testid') || '').toLowerCase();
    const label = String(element.getAttribute('aria-label') || '').toLowerCase();
    const className = String(element.className || '').toLowerCase();
    const text = `${testId} ${label} ${className}`;
    return /user|human|you/.test(text) ? 'user' : 'ai';
  }

  function buildTurns(elements) {
    const occurrenceMap = new Map();
    const turns = [];

    for (const element of elements) {
      const role = detectRole(element);
      const text = extractText(element);
      if (!text) continue;

      const normalized = text.slice(0, MAX_TEXT_LENGTH);
      const base = `${role}:${fingerprint(normalized)}`;
      const occurrence = (occurrenceMap.get(base) || 0) + 1;
      occurrenceMap.set(base, occurrence);

      turns.push({
        role,
        text: normalized,
        fingerprint: fingerprint(normalized),
        key: `${base}:${occurrence}`
      });
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

    for (const raw of turns || []) {
      const role = raw.role === 'user' ? 'user' : 'ai';
      const text = normalizeText(raw.text).slice(0, MAX_TEXT_LENGTH);
      if (!text || text.length < MIN_TEXT_LENGTH) continue;
      const item = {
        role,
        text,
        fingerprint: fingerprint(text),
        key: raw.key || `${role}:${fingerprint(text)}`
      };

      const identity = getTurnIdentity(item);
      const existingIndex = indexByIdentity.has(identity) ? indexByIdentity.get(identity) : -1;
      if (existingIndex >= 0) {
        if (item.text.length > cleaned[existingIndex].text.length) cleaned[existingIndex] = item;
      } else {
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

    const merged = cached.slice();
    let overlap = 0;
    const liveIds = new Set(live.map(getTurnIdentity));

    for (const liveTurn of live) {
      const existingIndex = merged.findIndex(turn => sameTurn(turn, liveTurn));
      if (existingIndex >= 0) {
        overlap += 1;
        if (liveTurn.text.length > merged[existingIndex].text.length) {
          merged[existingIndex] = { ...merged[existingIndex], ...liveTurn, index: merged[existingIndex].index };
        }
      } else {
        merged.push({ ...liveTurn });
      }
    }

    const minSize = Math.min(cached.length, live.length);
    const overlapThreshold = Math.max(3, Math.floor(minSize * 0.45));
    if (overlap < overlapThreshold) {
      // Low overlap on long threads usually means stale cache from a different
      // session/view. Prefer fresh live turns only.
      return live;
    }

    if (live.length >= cached.length && overlap >= Math.max(2, Math.floor(cached.length * 0.45))) {
      const preferred = live.slice();
      for (const cachedTurn of cached) {
        if (!liveIds.has(getTurnIdentity(cachedTurn)) && !preferred.some(turn => sameTurn(turn, cachedTurn))) {
          preferred.push(cachedTurn);
        }
      }
      return trimTurns(preferred);
    }

    return trimTurns(merged);
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

  function getApi() { return typeof browser !== 'undefined' ? browser : chrome; }

  async function readCache() {
    const storage = getApi()?.storage?.local;
    if (!storage) return { turns: inMemoryCache };
    try {
      const result = await storage.get(getStorageKey());
      const data = result[getStorageKey()];
      if (data && data.conversationId && data.conversationId !== getConversationId()) return { turns: [] };
      return data || { turns: [] };
    } catch (_) {
      return { turns: inMemoryCache };
    }
  }

  async function writeCache(turns) {
    const payload = { site: SITE, url: location.href, title: document.title,
      conversationId: getConversationId(), updatedAt: Date.now(), turns: trimTurns(turns) };
    inMemoryCache = payload.turns;
    if (payload.turns.length) lastConversationTurns = payload.turns.slice();
    const storage = getApi()?.storage?.local;
    if (!storage) return payload;
    try { await storage.set({ [getStorageKey()]: payload }); } catch (_) {}
    return payload;
  }

  async function syncTurnsFromDom() {
    const conversationId = getConversationId();
    const liveTurns = buildTurns(getElements());
    if (!liveTurns.length) return readCache();

    if (Date.now() - lastNavigationAt < NAVIGATION_GUARD_MS && hasStrongOverlap(lastConversationTurns, liveTurns)) {
      return { site: SITE, url: location.href, title: document.title, conversationId, updatedAt: Date.now(), turns: [] };
    }

    const cached = await readCache();
    const mergedTurns = mergeTurns(cached.turns || [], liveTurns);
    return writeCache(mergedTurns);
  }

  function scheduleSync() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      syncTurnsFromDom().catch(() => {});
    }, UPDATE_DEBOUNCE_MS);
  }

  function getScrollRoot(sampleElement) {
    let current = sampleElement instanceof HTMLElement ? sampleElement.parentElement : null;

    while (current) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 80) {
        return current;
      }
      current = current.parentElement;
    }

    return document.scrollingElement || document.documentElement || document.body;
  }

  function getScrollTop(root) {
    if (root === document.body || root === document.documentElement || root === document.scrollingElement) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return root.scrollTop;
  }

  function setScrollTop(root, value) {
    if (root === document.body || root === document.documentElement || root === document.scrollingElement) {
      window.scrollTo({ top: value, behavior: 'smooth' });
      return;
    }
    root.scrollTo({ top: value, behavior: 'smooth' });
  }

  function getMaxScrollTop(root) {
    if (root === document.body || root === document.documentElement || root === document.scrollingElement) {
      const doc = document.documentElement;
      return Math.max(0, (document.scrollingElement || doc).scrollHeight - window.innerHeight);
    }
    return Math.max(0, root.scrollHeight - root.clientHeight);
  }

  function buildEntries() {
    const elements = getElements();
    const turns = buildTurns(elements);
    return turns.map((turn, index) => ({ turn, element: elements[index] })).filter(entry => entry.element);
  }

  function findMatchingElement(targetTurn) {
    const entries = buildEntries();
    let match = entries.find(entry => sameTurn(entry.turn, targetTurn));
    if (match) return match.element;

    match = entries.find(entry => entry.turn.role === targetTurn.role && entry.turn.fingerprint === targetTurn.fingerprint);
    if (match) return match.element;

    const targetPrefix = targetTurn.text.slice(0, 100);
    match = entries.find(entry => entry.turn.role === targetTurn.role && (entry.turn.text.startsWith(targetPrefix) || targetPrefix.startsWith(entry.turn.text.slice(0, 80))));
    return match ? match.element : null;
  }

  function highlightElement(element) {
    if (!(element instanceof HTMLElement)) return;
    const previousOutline = element.style.outline;
    const previousOutlineOffset = element.style.outlineOffset;
    const previousBorderRadius = element.style.borderRadius;
    const previousTransition = element.style.transition;

    element.style.outline = `2px solid ${HIGHLIGHT_COLOR}`;
    element.style.outlineOffset = '4px';
    element.style.borderRadius = '8px';
    element.style.transition = 'outline 0.2s ease';

    setTimeout(() => {
      element.style.outline = previousOutline;
      element.style.outlineOffset = previousOutlineOffset;
      element.style.borderRadius = previousBorderRadius;
      element.style.transition = previousTransition;
    }, 1800);
  }

  async function scanForElement(targetTurn, targetIndex, totalTurns) {
    let element = findMatchingElement(targetTurn);
    if (element) return element;

    const firstElement = getElements()[0];
    const root = getScrollRoot(firstElement);
    const maxScroll = getMaxScrollTop(root);
    if (maxScroll <= 0) return null;

    const current = getScrollTop(root);
    const ratio = totalTurns > 1 ? targetIndex / (totalTurns - 1) : 0;
    const targetScroll = Math.max(0, Math.min(maxScroll, Math.round(maxScroll * ratio)));
    const step = Math.max(260, Math.round((root.clientHeight || window.innerHeight || 700) * 0.8));

    const checkpoints = [targetScroll, 0, maxScroll, current];
    for (const point of checkpoints) {
      setScrollTop(root, point);
      await delay(220);
      element = findMatchingElement(targetTurn);
      if (element) return element;
    }

    for (let pos = targetScroll; pos >= 0; pos -= step) {
      setScrollTop(root, pos);
      await delay(180);
      element = findMatchingElement(targetTurn);
      if (element) return element;
    }

    for (let pos = targetScroll; pos <= maxScroll; pos += step) {
      setScrollTop(root, pos);
      await delay(180);
      element = findMatchingElement(targetTurn);
      if (element) return element;
    }

    return null;
  }

  async function ensureFreshTurns() {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const payload = await syncTurnsFromDom();
      if (payload && payload.turns && payload.turns.length) return payload;
      await delay(RETRY_DELAY_MS);
    }
    return readCache();
  }

  async function handleGetTurns() {
    const payload = await ensureFreshTurns();
    return {
      ok: true,
      site: SITE,
      conversationId: payload.conversationId || getConversationId(),
      updatedAt: payload.updatedAt || Date.now(),
      turns: payload.turns || []
    };
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

  function startObserver() {
    if (observerStarted || !document.body) return;
    observerStarted = true;
    lastConvId = getConversationId();

    const observer = new MutationObserver(() => {
      scheduleSync();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: false
    });

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

  // Overlay bridge — overlay.js fires these custom events when runtime.sendMessage fails
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
