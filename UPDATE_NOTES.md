# MBT Panel / Core Fixes

This build keeps the current Bettor/Admin UI direction and applies the required backend hardening.

## Included
- Bettor panel keeps: WELCOME BACK header, balance/summary, matches, My Bets/Ticket view, Results, Transactions, Profile.
- Admin panel keeps the current sidebar/table/modal UI.
- Bet-time odds are stored in `bets.odds_rate` and settlement uses the stored odds snapshot.
- Risk Management is keyed by the database Match ID (`match_db_id`), not team-name text.
- 5% commission is applied only to positive winnings/profit, never to stake.
- 15-minute server-side betting lock remains enforced.
- Settlement only processes Pending bets, preventing duplicate payout on already-settled bets.
- Admin-only protection added to match management, result settlement, transaction actions, risk summary/forwarding, and bet deletion.
- Payout transaction status is normalized to `Completed`.
- Existing database is intentionally NOT bundled in this update ZIP, so extracting the build will not overwrite live betting data.

## Update
1. Back up your existing `betting.db`.
2. Replace `server.js`, `public/index.html`, `public/admin.html`, `package.json`, and `package-lock.json` with this build.
3. Keep your existing `betting.db`.
4. Run `npm install`.
5. Run `node server.js`.

The server waits for the SQLite schema migration before opening the HTTP port.

## Bettor Panel UI Update - Tabs + Hero Reorder
- Added clean pill-style bettor tabs: Matches, My Bets, Results, Transactions, Profile.
- Added Results tab using match scores from `/api/matches`.
- Added Profile tab with account/balance/status and change-password action.
- Reordered hero content so Balance + Current Time cards appear above the admin marquee banner.
- Kept the admin-managed marquee notice and 30-second refresh.
- Added responsive horizontal tab scrolling for mobile screens.
- Removed Linux `node_modules` from the ZIP so Windows/Railway can run `npm install` with the correct native sqlite3 binary.

## Bettor Header + Double Bet Confirmation Update
- Simplified the Bettor Panel top header branding to **STT Betting**, with a compact trophy mark, subtle green accent, and responsive layout.
- Removed the Password shortcut from the Hero action buttons; password change remains available from the Profile section.
- Added a second explicit confirmation prompt after the bet form's confirm button. It summarizes match, market, selection, odds, and stake before sending the bet to the server.
- Cancelling the second prompt stops submission and re-enables the confirm button; no bet API request is sent.
