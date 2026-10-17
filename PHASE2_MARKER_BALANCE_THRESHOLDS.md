# STT Betting — Phase 2: Marker Balance Thresholds

## Included
- Phase 1 top navigation now uses a more attractive glassmorphism treatment: a deep blue gradient hero header, translucent dropdown navigation panel, blurred glass dropdowns, subtle highlights and responsive mobile layout.
- Marker Management includes editable **Low Balance** and **Critical Balance** thresholds.
- Thresholds are saved in SQLite `site_settings` (`marker_low_balance_threshold`, `marker_critical_balance_threshold`) and persist across restarts.
- Marker balance labels, table row highlights and Low/Critical filter use the saved values immediately after saving.
- Defaults for existing databases remain Low `< 100,000 MMK` and Critical `< 25,000 MMK`.
- Validation requires non-negative values and Critical must be lower than Low. Existing user accounts, passwords, login flow and betting data are not intentionally modified.

## Local test
1. Back up `betting.db` before replacing the project folder.
2. Extract this ZIP into a new test folder.
3. Run `npm install`, then `npm start`.
4. Open `http://localhost:3000/admin.html` and sign in.
5. Open **User Management → Marker**. Change both limits and select **Save Limits**.
6. Confirm the displayed thresholds update and marker alert labels/filters respond to the new limits.
7. Restart the server and confirm the saved thresholds remain.

Do not deploy to Railway until local checks pass. Automated syntax and ZIP integrity checks were run; a full browser-based acceptance test has not been performed in this environment.
