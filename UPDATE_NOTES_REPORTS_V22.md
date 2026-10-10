# STT Betting v22 — Admin Reports Center

Added a connected Admin Reports module without replacing existing Admin UI.

Features:
- Reports nav/page
- YGN date range filters
- Marker filter
- Match filter
- Report types: Summary, By Marker, By Match, Transactions
- Quick date ranges: Today, Last 7 Days, Last 30 Days
- Connected backend `/api/admin/reports`
- Summary KPIs: bets, stake, settled stake, payout, admin net P/L
- CSV export of current report table
- Uses match_db_id / marker identifiers, not team name matching
