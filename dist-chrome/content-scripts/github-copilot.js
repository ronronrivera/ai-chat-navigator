// content-scripts/github-copilot.js
// Robust conversation extraction, persistence, and jump navigation for github.com/copilot

(function () {
  'use strict';

  const SITE = 'github-copilot';
  const STORAGE_PREFIX = 'ai-navigator:conversation:';
  const UPDATE_DEBOUNCE_MS = 400;
  const RETRY_DELAY_MS = 500;
  const MAX_RETRIES = 10;
  const MAX_TEXT_LENGTH = 500;
  const HIGHLIGHT_COLOR = 'rgba(126,231,135,0.9)';
  const URL_CHECK_MS = 1000;

  let persistTimer = null;
  let observerStarted = false;
  let lastHref = location.href;
  let inMemoryCache = [];
  let lastConvId = null;

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
      .replace(/^(you:|copilot:|github copilot:)/i, '')
      .replace(/\b(Copy|Share|Like|Dislike|Retry|Regenerate|Insert into editor|Insert at cursor)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getConversationId() {
    const url = new URL(location.href);
    const parts = url.pathname.split('/').filter(Boolean);
    let id = '';

    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'c' && parts[i + 1]) {
        id = parts[i + 1];
        break;
      }
      if (parts[i] === 'conversations' && parts[i + 1]) {
        id = parts[i + 1];
        break;
      }
    }

    if (!id) {
      id = url.searchParams.get('conversation') || url.searchParams.get('thread') || `${url.pathname}${url.search}` || 'home';
    }

    return `${SITE}:${id}`.replace(/[^a-z0-9:_-]/gi, '-').toLowerCase();
  }

  function getStorageKey() {
    return `${STORAGE_PREFIX}${getConversationId()}`;
  }

  function hasExplicitConversationInUrl() {
    const url = new URL(location.href);
    const parts = url.pathname.split('/').filter(Boolean);
    const hasPathConversation = parts.some((part, index) =>
      (part === 'conversations' || part === 'c') && !!parts[index + 1]
    );
    if (hasPathConversation) return true;

    return !!(
      url.searchParams.get('conversation') ||
      url.searchParams.get('conversation_id') ||
      url.searchParams.get('thread') ||
      url.searchParams.get('thread_id')
    );
  }

  function getElements() {
    const selectors = [
      '[data-testid="user-message"], [data-testid="human-message"]',
      '[data-testid="copilot-message"], [data-testid="assistant-message"], [data-testid="bot-message"]',
      '[data-role="user"], [data-role="assistant"]',
      '[class*="copilot-chat-message"]',
      '[class*="ChatMessage"]',
      '[class*="chat-message"]',
      '[class*="message--user" i]',
      '[class*="message--assistant" i]',
      '[class*="ThreadMessage"]',
      'article[class*="Message"]'
    ];

    const seen = new Set();
    const elements = [];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!(el instanceof HTMLElement)) continue;
        if (seen.has(el)) continue;
        if (!normalizeText(el.innerText || el.textContent || '')) continue;
        if (elements.some(existing => existing.contains(el) || el.contains(existing))) continue;
        seen.add(el);
        elements.push(el);
      }
      if (elements.length >= 2) break;
    }

    elements.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    return elements;
  }

  function detectRole(element) {
    const testId = String(element.getAttribute('data-testid') || '').toLowerCase();
    const dataRole = String(element.getAttribute('data-role') || '').toLowerCase();
    const label = String(element.getAttribute('aria-label') || '').toLowerCase();
    const className = String(element.className || '').toLowerCase();
    const text = `${testId} ${dataRole} ${label} ${className}`;

    if (/assistant|copilot|bot|model|response|reply/.test(text)) return 'ai';
    if (dataRole === 'assistant') return 'ai';
    if (/user|human|prompt|author-user/.test(text)) return 'user';
    if (dataRole === 'user') return 'user';

    return 'ai';
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

    // Fallback: some GitHub Copilot DOM variants do not expose explicit role
    // metadata. If all extracted turns are classified as AI, infer alternating
    // roles so user prompts remain navigable in the overlay.
    if (turns.length > 0 && !turns.some(turn => turn.role === 'user')) {
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

  function sanitizeTurns(turns) {
    const cleaned = [];
    for (const raw of turns || []) {
      const role = raw.role === 'user' ? 'user' : 'ai';
      const text = normalizeText(raw.text).slice(0, MAX_TEXT_LENGTH);
      if (!text) continue;
      const item = {
        role,
        text,
        fingerprint: fingerprint(text),
        key: raw.key || `${role}:${fingerprint(text)}`
      };

      const existingIndex = cleaned.findIndex(turn => sameTurn(turn, item));
      if (existingIndex >= 0) {
        if (item.text.length > cleaned[existingIndex].text.length) cleaned[existingIndex] = item;
      } else {
        cleaned.push(item);
      }
    }
    return reindexTurns(cleaned);
  }

  function mergeTurns(cachedTurns, liveTurns) {
    const cached = sanitizeTurns(cachedTurns);
    const live = sanitizeTurns(liveTurns);

    if (!cached.length) return live;
    if (!live.length) return cached;

    const merged = cached.slice();
    let overlap = 0;

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

    if (live.length >= cached.length && overlap >= Math.max(2, Math.floor(cached.length * 0.45))) {
      const preferred = live.slice();
      for (const cachedTurn of cached) {
        if (!preferred.some(turn => sameTurn(turn, cachedTurn))) {
          preferred.push(cachedTurn);
        }
      }
      return reindexTurns(preferred);
    }

    return reindexTurns(merged);
  }

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
      if (data && data.conversationId && data.conversationId !== getConversationId()) return { turns: [] };
      return data || { turns: [] };
    } catch (_) {
      return { turns: inMemoryCache };
    }
  }

  async function writeCache(turns) {
    const payload = { site: SITE, url: location.href, title: document.title,
      conversationId: getConversationId(), updatedAt: Date.now(), turns: reindexTurns(turns) };
    inMemoryCache = payload.turns;
    emitTurnsUpdated(payload);
    const storage = getApi()?.storage?.local;
    if (!storage) return payload;
    try { await storage.set({ [getStorageKey()]: payload }); } catch (_) {}
    return payload;
  }

  async function syncTurnsFromDom() {
    const liveTurns = buildTurns(getElements());
    if (!liveTurns.length) {
      if (!hasExplicitConversationInUrl()) {
        return writeCache([]);
      }
      return readCache();
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
          inMemoryCache = [];
          lastConvId = newConvId;
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
    if (msg.type === 'SET_OVERLAY_ENABLED') {
      const root = document.getElementById('ai-nav-overlay-root');
      if (root) root.style.display = msg.enabled ? '' : 'none';
      window.dispatchEvent(new CustomEvent('ai-nav-overlay-enabled', { detail: { enabled: !!msg.enabled } }));
      return Promise.resolve({ ok: true, enabled: !!msg.enabled });
    }
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
