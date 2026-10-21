STT Betting Admin Login Fix v48

Fix:
- The admin login form submit handler is registered immediately after the login function is defined, before optional page initialization code runs.
- This prevents a later UI initializer error from leaving the Login button with no submit handler.
- Existing /api/login flow, password verification, session handling, and database schema are unchanged.
- Do not replace the existing betting.db with the ZIP copy if your local database has newer account/data changes. Back up your current betting.db first.

Test locally:
1. Back up your current betting.db.
2. Extract this ZIP into a new folder.
3. Copy your backed-up/current betting.db into the project folder only after keeping a separate backup.
4. Run npm install, then npm start.
5. Open http://localhost:3000/admin.html and hard refresh (Ctrl+F5).
6. If login still does nothing, open browser DevTools > Console and Network, then report any red error or /api/login response status.
