# STT Betting — Admin fixes and Downline Agent roadmap

## Included in this build
- Added `RUN_LOCAL.bat` to install Node dependencies when needed and start the local server on Windows.
- Improved the Admin Transactions tab to show a loading state and the actual server/database error instead of only a generic failure message.
- Tightened Risk Management match lookup to use the internal database match ID selected by the admin UI. This prevents a custom Match ID that happens to equal another row's database ID from opening the wrong match.
- Risk match loading now gives visible feedback if the API fails.
- Preserved the existing app UI and existing SQLite database files in this working build.

## First run
1. Make a separate backup copy of `betting.db` before running the app.
2. Extract the ZIP to a normal folder (not inside the ZIP viewer).
3. Double-click `RUN_LOCAL.bat`.
4. Open `http://localhost:3000` in the browser. If the app reports that port 3000 is already in use, close the other running copy first.
5. The default admin credentials documented in the existing security notes are `admin` / `admin123`. Change the password immediately if these credentials are still active.

## Before deploying to Railway
- Keep the live database backed up.
- Test deposit/withdraw approval and rejection, match settlement, and risk layout with test accounts first.
- Do not upload the local database to a public repository.

## Next phase: Downline Agent system
Plan and implement after Admin fixes are validated:
1. Agent hierarchy (`parent_agent_id`, agent role/type, Active/Inactive status).
2. Server-enforced row-level access: agents can access only their own downline and customers.
3. Agent wallet/credit ledger with auditable transfers and balance invariants.
4. Commission/profit-share rules configurable by parent-child relationship.
5. Agent dashboard, downline user management, transaction approvals, and scoped reports.
6. Migration tests and regression tests for existing bettor login, tickets, odds snapshots, settlement, refunds, and admin reports.

The Agent phase is not yet implemented by this build. It must be developed against the tested schema rather than adding UI-only agent fields.
