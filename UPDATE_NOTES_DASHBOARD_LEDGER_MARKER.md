# Dashboard + Admin Ledger + Marker Management Update

- Dashboard redesigned to a clean modern KPI layout with four primary metrics.
- Admin login now opens Marker page instead of Dashboard.
- Amount displays no longer append `MMK` in Admin or Bettor UI.
- Marker balance edits are routed through the Balance action with a required reason.
- Marker balance adjustments create a balance_adjustments record, a transaction record, and an Admin Ledger entry.
- Marker opening balance creates an Admin Ledger entry.
- Bet stake creates an Admin Ledger IN entry linked to the ticket number.
- Approved deposit creates an Admin Ledger IN entry.
- Approved withdrawal creates an Admin Ledger OUT entry.
- Settlement payouts create Admin Ledger OUT entries linked to the bet.
- Admin Ledger API returns running balance, total IN, and total OUT.
- Admin Ledger UI shows Running Balance and summary cards.
- Existing admin ledger table remains backend-driven and uses the same financial event chain.
- Rejected deposit/withdraw requests do not create cash-flow ledger entries.
