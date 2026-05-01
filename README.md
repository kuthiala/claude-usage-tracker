# Claude Usage Tracker

A powerful Chrome extension that monitors your Claude.ai usage in real-time with an inline chat bar display and detailed popup dashboard. Never hit your usage limit unexpectedly—track your 5-hour session, weekly quota, and Opus limits at a glance. Optionally enable auto-refresh to automatically reset your 5-hour window when it expires.

![Claude Usage Tracker Screenshot](./screenshot.png)

## Features

- **Usage Bars** — View your 5-hour session, weekly (all models), and weekly Opus usage at a glance
- **Inline Chat Bar** — See usage directly in the Claude.ai interface alongside the chat
- **Popup Dashboard** — Click the extension icon for a detailed view with timestamps
- **Auto-Refresh** — Optionally enable automatic refresh of your 5-hour window after expiration
- **Incognito Support** — Separate tracking for regular and incognito window contexts (different accounts)
- **Last Fetched Timestamp** — Know exactly when your usage was last updated

## Installation

### From GitHub (Development Version)

1. **Download the extension:**
   - Click "Code" → "Download ZIP" on this repository, or
   - Run: `git clone https://github.com/YOUR_USERNAME/claude-usage-tracker.git`

2. **Load into Chrome:**
   - Open Chrome and go to `chrome://extensions/`
   - Enable **Developer mode** (toggle in top-right)
   - Click **Load unpacked**
   - Select the `claude-usage-monitor` folder
   - The extension is now active!

3. **Verify installation:**
   - Click the Claude Usage Monitor icon in your Chrome toolbar
   - Visit https://claude.ai and open a conversation
   - You should see the usage bars appear

## Usage

### Popup
Click the extension icon to view:
- 5-hour session usage with time remaining
- Weekly usage (all models)
- Weekly Opus usage
- Last fetch timestamp
- Refetch button for manual refresh
- Auto-refresh toggle

### Inline Chat Bar
In any Claude conversation, you'll see a usage bar below the chat input with:
- 5-hour session percentage and time remaining
- Weekly usage (if available)
- Weekly Opus usage (if available)
- Context tokens used (on conversation pages)
- Last fetched time

### Auto-Refresh
Enable "Auto-refresh 5-hour window" in the popup to:
- Automatically monitor when your 5-hour window expires
- Send a harmless test prompt ("Ans y/n, k?") to reset it
- Retry up to 30 times if refresh fails
- Automatically disable if max retries are exceeded

**Note:** Auto-refresh requires an open Claude tab in the same window context (regular or incognito).

## How It Works

1. **Reads Usage Data** — Fetches your usage from Claude's official `/api/organizations/{id}/usage` endpoint
2. **Displays Locally** — All data is stored in your browser's local storage
3. **Auto-Refresh Logic** — Checks every 5 minutes if your 5-hour window has expired, then sends a test prompt if needed
4. **No External Servers** — All traffic stays between your browser and claude.ai

## Permissions

- `storage` — Stores usage data and settings locally
- `scripting` — Injects the inline usage bar into Claude.ai pages
- `tabs` — Checks for open Claude tabs for auto-refresh
- `alarms` — Schedules auto-refresh checks every 5 minutes
- `https://claude.ai/*` — Access to Claude.ai API endpoints

## Privacy

- ✅ No external servers contacted
- ✅ No analytics or tracking
- ✅ No credential theft (uses your existing session)
- ✅ All data stays in your browser
- ✅ Open source — you can audit every line of code

## Development

### File Structure
```
claude-usage-monitor/
├── manifest.json       # Extension metadata
├── background.js       # Service worker (auto-refresh logic)
├── popup.js           # Popup UI logic
├── popup.html         # Popup HTML
├── popup.css          # Popup styles
├── content.js         # Inline bar injection
├── icons/             # Extension icons (16x16, 32x32, 48x48, 128x128)
└── README.md          # This file
```

### Building
The extension is ready to use as-is. No build step required.

### Testing
1. Load unpacked (see Installation above)
2. Make changes to any file
3. Click the reload button on the extension card in `chrome://extensions/`
4. Test in your Claude.ai session

## Troubleshooting

**Extension icon doesn't show usage:**
- Ensure you're on https://claude.ai (not claude.com)
- Check that you're signed in
- Click "Refetch Usage" in the popup

**Auto-refresh not working:**
- Enable the toggle in the popup
- Keep at least one Claude tab open
- Check that you're logged in (not 403 error)

**Last fetched shows "Never":**
- Click "Refetch Usage" once to fetch data
- The timestamp will update and display

**Different usage in regular vs incognito:**
- This is expected! Each context logs into a different account
- Each tracks its own 5-hour window independently

## Support

Found a bug? Have a feature request?
- Open an issue on GitHub
- Include steps to reproduce and browser/OS version

## License

MIT — Use freely, modify, distribute

## Inspiration & Credit

This extension was inspired by [claude-counter](https://github.com/she-llac/claude-counter), a similar tool for monitoring Claude usage. Thanks to the creator for the innovative idea!

## Disclaimer

This extension is not affiliated with Anthropic or Claude. It's a community tool that reads publicly available usage data.
