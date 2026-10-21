# Settlement Center v19

- Replaced the settlement preview inline section / native confirmation flow with dedicated closable preview and confirmation modals.
- Added Close Preview and Cancel buttons plus Escape-key closing support.
- Preview remains non-mutating; only Confirm Settlement mutates data.
- Settlement confirm now validates final score server-side.
- Settlement confirm re-reads pending bets inside a BEGIN IMMEDIATE transaction.
- Bet status updates, marker payout balance updates, payout transaction rows, admin ledger payout rows, and match status `Settled` are committed atomically.
- Settlement confirm detects stale/non-pending bets and rolls back instead of partially settling.
- Preview summary includes bets, stake, won, lost, payout, draw and admin net P/L.
- Payout settlement continues to use bet-time odds snapshots (`bets.odds_rate`) and 5% commission on positive profit only.
- Cancelled / Postponed / Settled matches cannot be previewed or confirmed for settlement.
