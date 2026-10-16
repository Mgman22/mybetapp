STT Betting Admin Panel - Local Test Build

Changes in this build:
- Kept the existing backend and grouped sidebar dropdown navigation from the v36 project build.
- Marker Create form no longer asks for Initial Balance. New Markers are explicitly created with balance 0.
- Added Marker search by username or Marker ID.
- Added balance alert filter (All / Low / Critical / Normal).
- Added low-balance blinking badge (< 100,000 MMK) and critical blinking badge (< 25,000 MMK).
- Replaced multiple status buttons with one Status dropdown and confirmation.
- Replaced multiple action buttons with one Actions dropdown.
- Existing status, balance, edit, password reset, history, and delete operations still call the existing backend APIs.

Default alert thresholds in public/admin.html:
- Low: below 100,000 MMK
- Critical: below 25,000 MMK
These are UI alert thresholds only and can be changed in the constants MARKER_LOW_BALANCE and MARKER_CRITICAL_BALANCE.

Run locally:
1. Install Node.js 18+.
2. Extract this ZIP.
3. Open the project folder in Terminal / PowerShell.
4. Run: npm install
5. Run: npm start
6. Open http://localhost:3000 (or the port printed by the server).

Database safety:
- The included betting.db is a project snapshot for local testing. Back it up before running any migration or testing destructive actions.
- This build is not connected to Railway until deployed.
- Do not upload a local database to Railway if Railway is meant to retain its existing production database.
