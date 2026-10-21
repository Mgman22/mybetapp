# STT Betting Update — Odds Sync + Admin Table UI

## Changes
- Bettor panel match list now checks for updated odds/status every 3 seconds while the authenticated panel is visible.
- Match API requests use `cache: 'no-store'` to reduce stale responses from browser/intermediary caches.
- Returning to the bettor tab triggers an immediate match refresh.
- Admin odds save now checks the HTTP/API result and shows an error if the save fails instead of silently closing the modal.
- Admin tables have a refined header treatment, clearer row separation, alternating row backgrounds, hover highlighting, and more consistent cell spacing. Existing table markup and app workflows were retained.

## Test notes
- Static patch applied to the uploaded v47 project.
- This package has not been tested against the user's live Railway instance or in a real browser session. Please run locally first with `RUN_LOCAL.bat`.
- Odds refresh is polling-based, not push-based; expected visible update is typically within about 3 seconds when the browser tab is active and the server responds normally.
