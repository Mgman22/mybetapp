# STT Betting v50 — Four-Market Live Score Preview

## Preview changes
- Replaced the aggregated marker summary inside Score Preview with four detailed market tables: Home, Away, Goal Over, and Goal Under.
- Tables render in two columns on wide screens and stack on narrow screens.
- Each table includes Marker, Odds, Amt, Result (W/L), (W/L) Amt, and Total Amt.
- W/L Amt is shown as projected net win after the existing commission rule, negative stake for a loss, and zero for a push/refund outcome.
- The existing projected Admin Net P/L summary remains prominent at the bottom and in the header.
- Backend preview returns per-bet market rows but remains read-only; it does not settle bets or modify tickets, balances, or statuses.
- Parlay tickets remain excluded, as before.

## Verification
- Patch applied to v49 ZIP.
- Node syntax checks and ZIP integrity should be run locally before use.
- Not tested against live Railway data or in a real browser in this session.
