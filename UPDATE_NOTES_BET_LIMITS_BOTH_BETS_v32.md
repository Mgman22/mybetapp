# STT Betting v32 — Per-side Bet Limits + Both Over/Under

Base: `mbt_STT_BETTING_DUAL_MARQUEE_WITHDRAW_CONFIRM_v31_TEST.zip`

## Bettor Panel
- Preserved the existing STT Betting dark/glass theme and both independent marquees.
- Added the white Available Balance display to the right side of the compact Hero section.
- Removed Profile from the visible bottom/main navigation; Profile remains available from Account dropdown in a modal.
- Match card now lists the favored team first in red and the other team below in blue. When Away is favored, the actual Home team is marked `(H)` on the blue row.
- Added `Both Over` and `Both Under` below the normal Over/Under buttons.
- Both Over sends two independent selections: favored Body team + GP Over. Both Under sends favored Body team + GP Under.
- The input stake applies to each selection. Example: stake 1,000 means Body 1,000 + GP 1,000, for a total wallet deduction of 2,000.
- Both selections appear separately in the second confirmation dialog, with only Selection, Odds and Amt rows plus Confirm.
- Both legs share a ticket number but are stored as separate bets so settlement evaluates each market independently. Wallet deduction, transaction, and Admin Ledger record use the combined total.
- Rejects stale odds at the server rather than silently placing a bet at an updated price.

## Admin Bet Limits
- Added `Bet Limits` in the Admin sidebar.
- Admin can configure independent cumulative limits for each Bettor + Match ID:
  - Body Home
  - Body Away
  - GP Over
  - GP Under
- Limit 0 means unlimited until Admin sets a positive cap.
- Usage is calculated from previously placed stake rows for that Bettor, Match ID and side. A stake that reaches the cap exactly is allowed; a stake that would exceed it is rejected in full.
- Both Over/Under requests are checked for all legs before any wallet deduction or bet insert; if either side is at/over its limit, the entire combined request is rejected.
- A `Bet Limit Reached` message box shows the cap, used amount, and remaining amount. Admin is notified only when the bettor explicitly clicks `Request Limit Increase`.
- Admin can edit/remove the cap from Bet Limits; removing a rule makes that Bettor/Match unlimited until a new rule is saved.

## Validation
- `node --check server.js` passed.
- Extracted inline JavaScript syntax checks for `public/index.html` and `public/admin.html` passed.
- A focused helper test passed for Home/Away lane mapping, GP Over limits, exact-cap acceptance, over-cap rejection, and multiple legs in a single request.
- Full browser/Railway runtime testing was not performed in this environment because npm dependencies were not available from the offline cache. Please deploy to a staging/production Railway service and test with a test bettor before using with real accounts.
