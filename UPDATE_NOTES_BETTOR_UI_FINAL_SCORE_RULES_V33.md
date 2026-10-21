# STT Betting v33 — Bettor UI, Final Score Manager, Rules Gate

Built from the v32 Bettor Match Limit + Both Over/Under version. This build keeps the existing STT Betting visual theme and existing color scheme for match selections.

## Included
- Replaced the Bettor header's live clock with a visible Logout button; Logout is no longer duplicated in the Account dropdown.
- My Bets and Results text is forced to white for readability over the existing dark glass cards.
- Match card teams are now side-by-side: favored team first (existing red style), other team second (existing blue style); when Away is favored the Home team is labelled `(H)`. Over/Under and Both Over/Both Under remain in separate rows and the established colors are preserved.
- Added Admin → Final Score Manager. Admin can save Home/Away score without settlement, then publish/hide that score separately from the Bettor Final Score marquee. Editing a changed published score automatically hides it until republished. Settled/cancelled/postponed matches cannot be edited in this manager. The manager’s Open Settlement button resolves the selected match by its real list index.
- Final Score marquee now only displays scores explicitly published by Admin. It never invokes settlement or payout.
- Added a Login → Rules & Regulations gate. Bettor must read and check agreement before entering the main panel. Acceptance is stored server-side against the current rules version; Admin rule changes require new acceptance. If rules are disabled or empty, the panel opens normally.
- Preserved v31's two-stage withdrawal confirmation, v32's separate Home/Away/Over/Under bet limits, Both Over/Both Under two-leg stake model, odds snapshot protections, and other existing modules.

## Important workflow
1. Admin → Final Score Manager → enter Home and Away scores → Save Score.
2. Publish when the result should appear in the Bettor marquee; Hide removes it from the marquee.
3. Admin → Settlement remains the only place to preview and confirm actual settlement/payouts.

## Verification
- `node --check server.js` passed.
- Inline JavaScript in both public HTML pages passed `node --check`.
- SQLite checks for manager query, score publication/hide upsert, and versioned rules acceptance passed.
- Full Railway/browser runtime test was not performed in this environment because app dependencies are not installed here.
