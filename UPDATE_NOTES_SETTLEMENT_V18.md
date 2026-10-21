# STT Betting Settlement Center v18

- Reworked Admin Settlement flow as Preview -> Confirm.
- Preview shows marker, ticket, selection, immutable bet-time odds, stake, result, payout, and net profit.
- Confirm settlement recomputes from current Pending bets and their stored odds/team snapshot.
- Settlement is protected against double settlement and cancelled/postponed matches.
- Confirm is transactional: match, bet settlement, marker payout balance, payout transaction, and Admin Ledger payout entry commit together or roll back.
- Settled match status is `Settled`.
- Admin Ledger receives System/Server payout entries for positive payouts.
- Existing Cancelled/Postponed handling remains untouched.
