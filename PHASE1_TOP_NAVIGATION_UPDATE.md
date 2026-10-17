# Phase 1 — Website-style top navigation

- Replaced the left sidebar presentation with a horizontal top navigation bar.
- Grouped sections now open as dropdown menus.
- Kept existing page IDs, `switchPage()` calls, API routes, login logic, and database files unchanged.
- Dropdown menus close after selecting a page; mobile layout allows wrapping and dropdowns become scrollable panels.

## Local test
1. Extract this ZIP into a new folder (do not overwrite the existing project).
2. Run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000/admin.html` and hard refresh with Ctrl+F5.

This is a UI/navigation-only phase. Verify admin login and each dropdown item locally before continuing to Phase 2. Keep a separate backup of your active `betting.db`.
