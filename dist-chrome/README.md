# AI Chat Navigator — Chrome Extension

Jump to any message in ChatGPT, Claude, or Copilot. No more endless scrolling.

The popup now auto-syncs while open and keeps a local conversation cache for the current chat so older and newer turns are easier to track.

## Install in Google Chrome

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `dist-chrome/` folder
5. Pin the extension if you want quick access to the popup

## Chrome build notes
- This folder is the Chrome-specific Manifest V3 build.
- The popup reinjection flow was updated to use Chrome's `scripting` API.
- `content-scripts/copilot.js` is currently a starter scaffold so the Chrome package loads cleanly while Copilot-specific extraction is built out.

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
| GitHub Copilot | github.com |

## Troubleshooting
- **"Could not connect"** → Refresh the AI site tab, then reopen the popup
- **No turns found** → Make sure a conversation is open and fully loaded
- **Extension not updating?** → Click the refresh button for the unpacked extension in `chrome://extensions`
