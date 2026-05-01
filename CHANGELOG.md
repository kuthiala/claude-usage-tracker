# Changelog

## v1.0.1

**Inline bar fetch behavior:**
- Bar now fetches immediately when the tab becomes active
- Bar fetches every 2 minutes while the tab is in the foreground
- Bar stops fetching entirely when the tab is hidden or backgrounded
- Bar resumes with an immediate fetch when the tab comes back into focus
- Bar force-fetches after every prompt response completes

**"Fetched" timestamp:**
- The Fetched field in the inline bar now reflects when the bar itself last fetched, not when the popup last fetched
- Previously would appear stale even after the bar refreshed its own data
- Seconds are rounded to 10-second buckets (0s, 10s, 20s, etc.) for less visual distraction

**Auto-refresh toggle label:**
- Toggle now reads "Auto-refresh / 5 hour window" on two lines to clarify what it controls

**Auto-refresh timing:**
- Alarm period: 5 minutes → 2 minutes (faster detection of expired windows)
- Retry limit: 30 → 15 (reduces total wait time from ~2.5h to ~2h if all retries fail)

**Login detection and cache invalidation:**
- Popup now checks login state before showing cached usage data, preventing stale data from being displayed after logout
- If a Claude tab is open, login is verified immediately (fast check against /api/organizations)
- Regular and incognito windows are checked independently
- "Not signed in" message now appears in popup when user is logged out

## v1.0.0

- Initial release
- Usage bars for 5-hour session, weekly (all models), and weekly Opus
- Inline usage bar in Claude.ai chat interface
- Popup dashboard with detailed usage and timestamps
- Auto-refresh: sends a throwaway prompt to reset the 5-hour window when it expires, retries up to 30 times on a 5-minute alarm
- Regular and incognito windows tracked independently
- Last fetched timestamp display
- Context token counter (estimates from conversation text, ~4 chars per token, 200k limit)
