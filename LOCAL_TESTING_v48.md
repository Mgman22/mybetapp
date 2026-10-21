STT Betting Admin Login Fix v48 — LOCAL NEW DB BUILD (v2)

Changes in this test build:
- API responses send no-store/no-cache headers to prevent stale login/session/API responses.
- Admin API fetches bypass the browser cache.
- Login validates HTTP response, success flag, admin role, and token before hiding the login gate.
- Successful login switches to the Marker/users page and loads users.
- New empty local SQLite database is created on first run; no live Railway DB is included.

Requirements:
- Node.js 18 or newer
- Internet access for first `npm install`

Run on Windows:
1. Extract this ZIP into a new folder.
2. Double-click `run-local.bat` (or run `npm install`, then `npm start` in that folder).
3. Open http://localhost:3000/admin.html
4. Test default admin credentials: username `admin`, password `admin123`.

Validation performed before packaging:
- `node --check server.js` passed.
- Admin HTML inline script syntax check passed.
- ZIP integrity test passed.
- Full runtime login test could not be completed in this environment because npm dependencies (including sqlite3) were not installed/available here. Run locally and share the complete terminal output if startup fails.

Database notes:
- This package intentionally excludes `betting.db` and its WAL/SHM files.
- This is a separate local test database and does not change Railway data.
- To reset this test DB only, stop the server and delete `betting.db`, `betting.db-wal`, and `betting.db-shm` from this extracted test folder.
- Change the default password before any use beyond local testing.
