# Phase A — Local Tailwind CSS

## Changes
- Replaced the `https://cdn.tailwindcss.com` script in `public/admin.html` with `/tailwind.local.css`.
- Added the generated local stylesheet at `public/tailwind.local.css`.
- Kept existing HTML, inline JavaScript, application APIs, database, settlement logic, and other UI assets unchanged.
- No new runtime dependency or database migration is required.

## Why
The Admin panel no longer needs to fetch Tailwind from the public CDN at runtime. This avoids that specific external CDN dependency for Tailwind styles.

## Important validation notes
- The local stylesheet was generated using the Tailwind CSS compiler available in the build environment (v4.1.10) from utility candidates extracted from the existing Admin HTML and its inline/related JavaScript, with additional common dynamic color utilities.
- The original CDN URL uses the Tailwind v3 browser build. Tailwind v4 and v3 are not perfectly identical, so visually compare the Admin panel and test all tabs, modals, dropdowns, responsive layouts, and dynamically styled buttons before production deployment.
- The Bettor page still references Bootstrap CSS, Bootstrap Icons, and Bootstrap JS through jsDelivr. Those are separate CDN dependencies and are intentionally unchanged in this Tailwind-focused Phase A.
- This change does not itself fix API, session, antivirus rules for other assets, or server errors.

## Suggested local smoke test
1. Start with `RUN_LOCAL.bat`.
2. Open the Admin page and confirm the login screen renders with styling.
3. In DevTools Network, verify `/tailwind.local.css` returns HTTP 200 and there is no request to `cdn.tailwindcss.com`.
4. Test login, navigation, marker/match/transaction pages, dialogs, and mobile layout.
5. Only then deploy to Railway and repeat the same checks.
