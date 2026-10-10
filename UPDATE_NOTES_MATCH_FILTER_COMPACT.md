# STT Betting - Match Filter + Compact Match UI

## Bettor Panel updates
- Added League filter and Kickoff Time filter on Matches tab.
- League options are populated dynamically from `/api/matches`.
- Time filters: All Times, Next 30 Minutes, Next 1 Hour, Next 3 Hours, Next 6 Hours, Today.
- Added compact match cards designed for mobile screens.
- Match header shows Match ID, League and Open/Closed/Betting Closed status.
- Home team button uses red styling; Away team button uses blue styling.
- Over button uses red styling; Under button uses blue styling.
- Body odds and Goal/O-U odds are shown directly in the compact match card.
- Existing 15-minute betting lock behavior is preserved.
- Existing bet modal and double-confirm flow are preserved.

## Mobile banner
- Removed the HTML `<marquee>` element.
- Replaced it with a CSS transform animation to reduce mobile stutter/jank.
- Respects `prefers-reduced-motion`.

## Validation
- `server.js` syntax check: passed.
- Bettor `index.html` JavaScript syntax check: passed.
- No `node_modules` included in ZIP; run `npm install` on the target machine.
