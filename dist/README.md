# AI Chat Navigator — Firefox Extension

Jump to any message in ChatGPT, Claude, or Copilot. No more endless scrolling.

The popup now auto-syncs while open and keeps a local conversation cache for the current chat so older and newer turns are easier to track.

## Install in Firefox

**Option A — Temporary (for testing, no account needed):**
1. Open Firefox → go to `about:debugging`
2. Click **"This Firefox"** in the left sidebar
3. Click **"Load Temporary Add-on…"**
4. Navigate into the `dist/` folder and select `manifest.json`
5. Done! The **N** icon appears in your toolbar.
   ⚠️ Temporary add-ons are removed when Firefox restarts.

**Option B — Permanent (recommended):**
1. Install [Firefox Developer Edition](https://www.mozilla.org/firefox/developer/) or Firefox Nightly
2. Go to `about:config` → set `xpinstall.signatures.required` to `false`
3. Go to `about:addons` → click the gear icon → **"Install Add-on From File…"**
4. Select the `ai-navigator-extension.zip` file

## No React or Vite install needed!
React is loaded from CDN inside popup.html. Just load the folder directly.

## Usage
1. Open a conversation on **ChatGPT**, **Claude**, or **Copilot**
2. Click the **N** icon in your toolbar
3. Wait a moment while the extension syncs the current conversation
4. Click any turn in the list → page jumps there instantly
5. Use the search bar to filter by keyword
6. The popup auto-refreshes every few seconds while it is open
7. Hit **Refresh** any time to force a full rescan

## Supported Sites
| Site | URL |
|------|-----|
| Claude | claude.ai |
| ChatGPT | chatgpt.com |
| Copilot | copilot.microsoft.com |

## Troubleshooting
- **"Could not connect"** → Refresh the AI site tab, then reopen the popup
- **No turns found** → Make sure a conversation is open and fully loaded
- **Restarted Firefox?** → Reload the temporary add-on via `about:debugging`
