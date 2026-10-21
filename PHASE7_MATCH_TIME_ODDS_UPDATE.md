# Phase 7 — Match Center Time & Odds UI

- Replaced the single kickoff time dropdown with separate Hour, Minute, and AM/PM dropdowns.
- Hour choices: 01–12; Minute choices: 00, 15, 30, 45; AM/PM choices provided.
- Converts selected 12-hour time to the existing 24-hour `HH:mm` value before match creation, preserving the existing API format.
- Body Odds options with a minus sign are styled red, including the currently selected value.
- Escape closes the Add New Match modal.
- Kept the existing match form fields, API payload, date field, and other Match Center behavior unchanged.

Validation: inline JavaScript passed `node --check`; ZIP integrity should be checked after packaging. Browser-level testing is still recommended before deployment.
