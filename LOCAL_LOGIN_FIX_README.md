# STT Betting Admin Login Fix v49 — Local Test

## Local test credentials
- Username: `admin`
- Password: `admin123`

## Run
1. Extract the ZIP to a new folder.
2. Double-click `run-local.bat`.
3. Wait for `Server running on http://localhost:3000`.
4. Open `http://localhost:3000/admin.html`.

`run-local.bat` runs `reset-local-admin.js` before starting the app. It sets the local `admin` user's password to `admin123`, makes that user active/admin, and clears only that user's failed-login lock. It does not delete users, bets, balances, or transactions.

**Important:** The script is intended for local testing only. Do not run it against a live production database. If a `betting.db` already exists in this folder, back it up first. For a clean test, extract into a new folder and do not copy the Railway database into it.

If login still fails, send the terminal error and the `/api/login` request's Response body (do not share password/token/cookie values).
