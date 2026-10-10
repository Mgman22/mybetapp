# v16 Transaction Time + Late Bet Cap

- Transaction Request/Processed time now displays as Myanmar Time (GMT+6:30), treating SQLite CURRENT_TIMESTAMP as UTC.
- Added configurable Late Bet Cap global setting: enable/disable, late window (2/5/10/15/30 minutes before hard lock), maximum stake amount.
- Server-side enforcement rejects bets exceeding the cap during the late window; hard lock still wins after the configured lock cutoff.
- Bettor transaction statement uses the same correct UTC->Myanmar conversion.
