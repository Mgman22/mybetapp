STT Betting Admin v24

Added:
- System Settings page connected to site_settings API
- Global betting lock setting (2/5/10/15 minutes)
- Final 5-minute late betting cap setting + amount
- YGN timezone shown as Asia/Yangon (GMT+6:30)
- Backup & Restore page
- Manual SQLite backup creation with WAL checkpoint
- Authenticated backup download via Bearer token
- Restore with automatic emergency backup before replacement
- Audit log entries for backup and restore actions

Preserved:
- Marker Management
- Match Management
- Risk Management
- Transactions
- Settlement
- Admin Ledger
- Reports
- Audit Log
- Website Notice

Checks:
- server.js syntax OK
- admin inline JavaScript syntax OK
- ZIP integrity verified
