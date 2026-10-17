# Phase 4 — Marker Management polish

- Renamed the User Management submenu item from `Marker` to `Marker Mgnt`.
- Removed the `MMK` suffix from the Marker List Balance column; the column now displays the formatted numeric balance only.
- Kept currency labels in other areas (e.g. balance guidance and threshold settings) unchanged.
- Preserved Phase 3 features: single-color STT header, dropdown auto-close when switching pages, Marker balance thresholds, and scoped Bet Limits.

## Local test
1. Back up your existing `betting.db` before replacing project files.
2. Extract this ZIP to a new folder.
3. Run `npm install` then `npm start`.
4. Open `http://localhost:3000/admin.html`, log in, and check User Management > Marker Mgnt.
5. Confirm the Balance column shows only numbers (no `MMK`).

Browser end-to-end testing has not been performed. Verify locally before deploying to Railway.
