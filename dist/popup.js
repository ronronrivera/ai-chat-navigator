(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const root = document.getElementById('root');
  const OVERLAY_SETTING_KEY = 'ai-navigator:overlay-enabled';
  const state = {
    status: 'loading',
    site: null,
    overlayEnabled: true,
    errorMsg: ''
  };

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getSiteInfo(url) {
    if (!url) return null;
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
      return { name: 'ChatGPT', color: '#10a37f', soft: 'rgba(16,163,127,0.14)' };
    }
    if (url.includes('claude.ai')) {
      return { name: 'Claude', color: '#e6914e', soft: 'rgba(230,145,78,0.14)' };
    }
    if (url.includes('copilot.microsoft.com')) {
      return { name: 'Copilot', color: '#5ca3e6', soft: 'rgba(92,163,230,0.14)' };
    }
    if (url.includes('github.com/copilot') || (url.includes('github.com') && url.includes('copilot'))) {
      return { name: 'GitHub Copilot', color: '#7ee787', soft: 'rgba(126,231,135,0.14)' };
    }
    return null;
  }

  function getContentScriptFile(url) {
    if (!url) return null;
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'content-scripts/chatgpt.js';
    if (url.includes('claude.ai')) return 'content-scripts/claude.js';
    if (url.includes('copilot.microsoft.com')) return 'content-scripts/copilot.js';
    if (url.includes('github.com/copilot') || (url.includes('github.com') && url.includes('copilot'))) return 'content-scripts/github-copilot.js';
    return null;
  }

  function isConnectionError(error) {
    const message = String((error && error.message) || error || '');
    return /Could not establish connection|Receiving end does not exist|message port closed/i.test(message);
  }

  async function getActiveTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  async function ensureContentScript(tab) {
    const file = getContentScriptFile(tab && tab.url);
    if (!file || typeof api.tabs.executeScript !== 'function') return;
    await api.tabs.executeScript(tab.id, { file });
    try {
      await api.tabs.executeScript(tab.id, { file: 'content-scripts/overlay.js' });
    } catch (_error) {
    }
  }

  async function sendMessageWithRecovery(tab, payload) {
    try {
      return await api.tabs.sendMessage(tab.id, payload);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      await ensureContentScript(tab);
      return api.tabs.sendMessage(tab.id, payload);
    }
  }

  async function loadOverlaySetting() {
    try {
      const result = await api.storage.local.get(OVERLAY_SETTING_KEY);
      if (typeof result[OVERLAY_SETTING_KEY] === 'boolean') {
        state.overlayEnabled = result[OVERLAY_SETTING_KEY];
      }
    } catch (_error) {
      state.overlayEnabled = true;
    }
  }

  function render() {
    const siteName = state.site ? escapeHtml(state.site.name) : '';
    const accent = state.site ? state.site.color : '#6c5ce7';
    const soft = state.site ? state.site.soft : 'rgba(108,92,231,0.14)';

    if (state.status === 'loading') {
      root.innerHTML = [
        '<div class="minimal-app is-center">',
        '<div class="minimal-loader"></div>',
        '<div class="minimal-title">Checking tab…</div>',
        '</div>'
      ].join('');
      return;
    }

    if (state.status === 'unsupported') {
      root.innerHTML = [
        '<div class="minimal-app is-center">',
        '<div class="minimal-title">Unsupported tab</div>',
        '<div class="minimal-sub">This tab is not a generative AI platform.</div>',
        '<div class="minimal-sub">Open ChatGPT, Claude, Copilot, or GitHub Copilot.</div>',
        '</div>'
      ].join('');
      return;
    }

    const unsupportedNote = state.status === 'unsupported'
      ? '<div class="minimal-sub">No supported AI tab is active. This setting will apply when you open ChatGPT, Claude, Copilot, or GitHub Copilot.</div>'
      : '';

    const errorNote = state.status === 'error'
      ? `<div class="minimal-sub">${escapeHtml(state.errorMsg || 'Unknown error')}</div><button id="retry-btn" class="minimal-retry" type="button">Try again</button>`
      : '';

    root.innerHTML = [
      '<div class="minimal-app">',
      `<div class="minimal-site" style="--accent:${accent};--soft:${soft}">`,
      '<span class="minimal-dot"></span>',
      siteName,
      '</div>',
      unsupportedNote,
      errorNote,
      '<div class="minimal-toggle-card">',
      '<div class="minimal-copy">',
      '<div class="minimal-title">Draggable UI</div>',
      `<div class="minimal-sub">${state.overlayEnabled ? 'Visible inside the site' : 'Hidden inside the site'}</div>`,
      '</div>',
      `<button id="overlay-toggle" class="minimal-switch${state.overlayEnabled ? ' is-on' : ''}" type="button" aria-pressed="${state.overlayEnabled ? 'true' : 'false'}">`,
      '<span class="minimal-switch-track"><span class="minimal-switch-thumb"></span></span>',
      `<span class="minimal-switch-label">${state.overlayEnabled ? 'ON' : 'OFF'}</span>`,
      '</button>',
      '</div>',
      '</div>'
    ].join('');
  }

  async function load() {
    state.status = 'loading';
    state.errorMsg = '';
    render();

    try {
      await loadOverlaySetting();
      const tab = await getActiveTab();
      if (!tab) {
        state.status = 'error';
        state.errorMsg = 'No active tab found.';
        render();
        return;
      }

      state.site = getSiteInfo(tab.url || '');
      state.status = state.site ? 'ready' : 'unsupported';
    } catch (error) {
      state.status = 'error';
      state.errorMsg = String((error && error.message) || error || 'Unknown error');
    }

    render();
  }

  async function setOverlayEnabled(value) {
    state.overlayEnabled = !!value;
    state.errorMsg = '';
    state.status = state.site ? 'ready' : state.status;
    render();

    try {
      await api.storage.local.set({ [OVERLAY_SETTING_KEY]: state.overlayEnabled });
      const tab = await getActiveTab();
      if (!tab || !state.site) return;
      await ensureContentScript(tab);
      try {
        await sendMessageWithRecovery(tab, { type: 'SET_OVERLAY_ENABLED', enabled: state.overlayEnabled });
      } catch (_msgError) {
        // Keep toggle state persisted even if the page bridge is momentarily unavailable.
        // A tab refresh or reinjection will apply it.
      }
    } catch (error) {
      state.status = state.site ? 'ready' : 'error';
      state.errorMsg = 'Toggle saved, but page sync is delayed. Refresh the tab if UI does not update.';
      render();
    }
  }

  root.addEventListener('click', (event) => {
    const toggleButton = event.target.closest('#overlay-toggle');
    if (toggleButton) {
      setOverlayEnabled(!state.overlayEnabled);
      return;
    }

    const retryButton = event.target.closest('#retry-btn');
    if (retryButton) {
      load();
    }
  });

  load();
})();
