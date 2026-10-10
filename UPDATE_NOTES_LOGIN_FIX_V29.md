STT Betting v29 TEST — Bettor Login Fix

Fixed:
- Restored missing frontend time/lock helpers that were called during DOMContentLoaded. Their absence caused a ReferenceError before login form submit handlers could be attached.
- Preserved the existing auth token during /api/me session validation. The /api/me response returns user information, not a new token; the previous frontend code could overwrite a valid token with undefined during reload.
- Updated the gate login connection-error text to English.

Preserved:
- v28 Bettor UI updates (simple Deposit/Withdraw, match cards, Rules, notification APIs, and styling).
- Existing backend login/session APIs and database schema.

Validation:
- `node --check server.js`
- `node --check` for the inline Bettor JavaScript
- Verified required helper functions are present exactly once.
- Checked HTML IDs for duplicates.
- ZIP integrity checked before delivery.

Note: A live runtime test against the user's Railway database was not possible in this environment; this ZIP should be deployed to the test environment for login verification.
