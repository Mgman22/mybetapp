# STT Betting v31 — Bettor Header, Dual Marquee, Withdrawal Confirmation

## Bettor UI changes
- Kept the existing STT Betting glass theme, betting cards, and tab navigation.
- Made the welcome Hero compact and removed the Available Balance and Current Time cards from the Hero.
- Added a live Asia/Yangon clock and Account dropdown to the header. Deposit, Withdraw, Profile, Change Password, and Logout are in the dropdown.
- Kept the existing Admin Notice marquee and added a separate Final Scores marquee.
- Final Scores are populated from Admin-saved matches whose status is `Finished` or `Settled` and whose home/away scores are both present.
- Added guarded polling to refresh matches and both marquees every 30 seconds while logged in.

## Withdrawal flow
1. Bettor enters an amount and clicks the first Confirm.
2. An agent-confirmation message box appears: “Units ထုတ်ယူရန်အတွက် Agent ဆီသို့ Viber / TG (Telegram) သို့မဟုတ် ဖုန်းဖြင့် အတည်ပြုပေးပါရန်။”
3. Only the second `Confirm & Notify Admin` click sends the withdrawal API request.
4. The server rejects requests without `agent_confirmation: true`. The transaction and Admin notification are created only after the second confirmation reaches the API.
5. Cancel/close returns to the amount form and does not create an Admin notification.

## Validation
- `node --check server.js`
- `node --check` on inline JavaScript in `public/index.html` and `public/admin.html`
- UI wiring and withdrawal confirmation guard checks
- ZIP integrity check

Live Railway runtime/browser interaction testing was not available here; please test the ZIP on a staging deployment before updating production.
