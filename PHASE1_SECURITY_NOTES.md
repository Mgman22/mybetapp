# Phase 1 - Login / Security

Implemented security foundation:
- Session-token authentication with SQLite `sessions` table
- 12-hour session expiry and automatic expired-session cleanup
- Admin login gate and bettor login gate
- Logout invalidates the current session token
- `/api/me` session validation
- Active / Inactive bettor accounts
- Inactive users have their active sessions invalidated
- Failed-login protection: 5 failed attempts -> 15-minute temporary lock
- Passwords stored with bcrypt hashes
- Bettor password change invalidates all bettor sessions
- Admin password change (8+ characters) invalidates all admin sessions
- Admin-only API protection for user management and admin endpoints
- Bettor API identity is taken from the authenticated session, not from a client-supplied username
- Existing users table is migrated automatically with status/login-security fields
- Existing plaintext passwords are upgraded to bcrypt on startup

Default existing admin account:
- Username: admin
- Password: admin123

Change the admin password immediately after deployment using the Admin Panel `Change Password` button.
