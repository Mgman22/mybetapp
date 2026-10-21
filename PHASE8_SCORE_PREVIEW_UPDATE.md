# Phase 8 — Match Score Preview (Read-only)

## Changes
- Added a `Score Preview` action to each Match Schedule row's Action dropdown.
- Preview modal accepts Home/Away score inputs and displays projected Admin P/L, Home/Away/GP Over/GP Under stake totals, and marker-level breakdown.
- Added authenticated read-only endpoint `POST /api/admin/matches/:id/score-preview`.
- Preview uses pending single bets and the existing Myanmar odds outcome engine; parlays are excluded and shown as a count.
- Preview does not write scores, settle tickets, update balances, or change bet statuses.
- Negative GP odds are styled red in the Add/Edit Odds dropdowns, like Body odds.

## Testing
- `node --check server.js` passed.
- Inline JavaScript syntax check passed.
- Please test against a backed-up local database before Railway deployment.
