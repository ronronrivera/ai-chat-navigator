# 🧭 AI Chat Navigator

> Jump to any message in a long AI conversation instantly. Never lose your place in ChatGPT, Claude, or Copilot again.

A lightweight browser extension that adds a navigation panel to your AI chat tools, letting you jump to any message in a long conversation with a single click — no more endless scrolling.

---

## ✨ Features

- **One-click navigation** — click any turn in the panel and the page instantly scrolls to it
- **Conversation overview** — see every user and AI message listed in order with a preview
- **Keyword search** — filter turns by typing a word to find exactly what you're looking for
- **Turn counter** — shows how many messages you and the AI have sent
- **Visual jump highlight** — a subtle outline flashes on the message you jumped to so you always know where you landed
- **Zero dependencies** — fully self-contained, no internet connection required after install
- **Works across three platforms** — ChatGPT, Claude, and Copilot

---

## 🌐 Supported Sites

| Platform | URL |
|----------|-----|
| Claude | `claude.ai` |
| ChatGPT | `chatgpt.com`, `chat.openai.com` |
| Microsoft Copilot | `copilot.microsoft.com` |

---

## 📦 Installation

### 🦊 Firefox

[![Get the Add-on on Firefox](https://img.shields.io/badge/Firefox-Get%20the%20Add--on-FF7139?style=for-the-badge&logo=firefox-browser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/ai-chat-navigator/)

**Option A — Temporary install (easiest, no account needed)**

> Best for trying it out. Note: temporary add-ons are removed when Firefox restarts.

1. Download and unzip `ai-navigator-firefox.zip`
2. Open Firefox and go to `about:debugging`
3. Click **"This Firefox"** in the left sidebar
4. Click **"Load Temporary Add-on…"**
5. Navigate into the `dist/` folder and select `manifest.json`
6. The **N** icon will appear in your toolbar — you're ready to go!

**Option B — Permanent install**

> Requires Firefox Developer Edition or Firefox Nightly.

1. Download [Firefox Developer Edition](https://www.mozilla.org/en-US/firefox/developer/) or [Firefox Nightly](https://www.mozilla.org/en-US/firefox/channel/desktop/#nightly)
2. Go to `about:config` and set `xpinstall.signatures.required` to `false`
3. Go to `about:addons`
4. Click the **gear icon ⚙️** → **"Install Add-on From File…"**
5. Select the `ai-navigator-firefox.zip` file directly

---

### 🌐 Chrome / Brave / Edge

> These browsers all support the same installation method.

1. Download and unzip `ai-navigator-firefox.zip`  
   *(the same package works — just load the `dist/` folder)*
2. Open your browser and go to:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode** using the toggle in the top-right corner
4. Click **"Load unpacked"**
5. Select the `dist/` folder from the unzipped package
6. The **N** icon will appear in your toolbar

> **Note for Chrome/Edge:** The manifest uses MV2 format which is still supported but may show a warning in Chrome. It will continue to work normally.

---

## 🚀 How to Use

1. Open any conversation on **ChatGPT**, **Claude**, or **Copilot**
2. Click the **N icon** in your browser toolbar to open the navigator panel
3. You'll see a list of every message in the conversation
4. **Click any turn** to instantly jump to that message
5. Use the **search bar** to filter messages by keyword
6. Click **↺ Refresh** after sending new messages to update the list

---

## 🗂️ Project Structure

```
dist/                          ← Load this folder as the extension
├── manifest.json              ← Extension configuration
├── popup.html                 ← Full navigator UI (self-contained, no dependencies)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── content-scripts/
    ├── claude.js              ← Message scraper for claude.ai
    ├── chatgpt.js             ← Message scraper for chatgpt.com
    └── copilot.js             ← Message scraper for copilot.microsoft.com
```

---

## ⚙️ How It Works

The extension has two layers:

**Content Scripts** are injected into each supported AI site. They use site-specific CSS selectors to find all message elements on the page and listen for two commands from the popup:
- `GET_TURNS` — returns a list of all messages with their role (user/AI) and a text preview
- `JUMP_TO_TURN` — scrolls the page to a specific message and briefly highlights it

**Popup UI** (`popup.html`) is a fully self-contained HTML/CSS/JS panel with zero external dependencies. It communicates with the active tab's content script using the browser messaging API to fetch turns and trigger jumps.

### Message detection selectors

| Site | Primary selector | Fallback |
|------|-----------------|---------|
| Claude | `[data-testid="human-turn"]`, `[data-testid="ai-turn"]` | Class-based patterns |
| ChatGPT | `[data-message-author-role]` | `article[data-testid*="conversation-turn"]` |
| Copilot | `cib-chat-turn` | Class-based patterns |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | Vanilla HTML, CSS, JavaScript |
| Browser API | `browser.*` (Firefox) / `chrome.*` (Chromium) |
| Manifest | MV2 (Firefox-compatible) |
| Dependencies | None — fully self-contained |

> No React, no bundler, no build step required. Just load the `dist/` folder directly.

---

## 🐛 Troubleshooting

**"Cannot connect" error**
→ Refresh the AI site tab, then close and reopen the extension panel.

**No messages shown / empty list**
→ Make sure the page has fully loaded and a conversation is already open. Click **Refresh**.

**Turn count seems wrong**
→ AI chat sites update their HTML structure over time. Click **Refresh** to re-scan. If it persists, the site may have updated its layout — feel free to open an issue.

**Extension disappeared after Firefox restart**
→ Temporary add-ons are removed on restart. Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and reload `manifest.json`. For a permanent install, see Option B above.

**Icon not showing in toolbar**
→ In Firefox, click the puzzle piece icon (Extensions menu) and pin AI Navigator. In Chrome/Brave, click the puzzle piece icon in the top-right and pin it.

---

## 🔒 Privacy

This extension:
- Does **not** collect, store, or transmit any data
- Does **not** have access to your account or messages beyond reading what's visible on screen
- Only activates on `claude.ai`, `chatgpt.com`, `chat.openai.com`, and `copilot.microsoft.com`
- Requires no login or account of any kind

---

## 👤 Author

**Ron-Ron Aspe Rivera**  
Full-Stack Developer · Backend Specialist  
🌐 [ronronrivera.tech](https://ronronrivera.tech) · 📧 ronaspe42@gmail.com

---

## 📄 License

MIT License — free to use, modify, and distribute.
