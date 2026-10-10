# v30 Test — Bettor Match Loading Fix

## Root cause
The bettor match renderer called `formatClosingTime(match_time, lockMinutes)`, but the helper was not defined in `public/index.html`. This threw a `ReferenceError` while rendering cards; the surrounding `loadMatches()` catch incorrectly looked like a match API connection failure.

## Fix
- Restored `formatClosingTime()` using the match's effective lock time and `Asia/Yangon` display formatting.
- Changed the fallback message to English and clarified it is a match load/render error; detailed error remains in the browser console.
- Kept existing auth token handling, API routes, lock calculation, match card layout, and betting behavior unchanged.

## Verification
- `node --check server.js`
- `node --check` on all inline JavaScript blocks in `public/index.html` and `public/admin.html`
- ZIP integrity check

Live Railway runtime was not available in this environment, so please test in the deployed app.
