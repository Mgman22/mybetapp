STT Betting Admin layout repair v37
- Added local CSS fallback in public/admin.html so the login overlay, sidebar, hidden pages, navigation groups, and core layout remain usable if Tailwind CDN cannot load.
- Existing application JavaScript, server routes, package dependencies, and database files were preserved.
- Validation performed: ZIP integrity and inline JavaScript syntax check. This is not a full browser/login test; please verify locally.
- Start with RUN_LOCAL.bat or npm start, then open http://localhost:3000/admin.html and hard-refresh with Ctrl+F5.
