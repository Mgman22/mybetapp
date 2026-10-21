# Match Center UI Update — Phase 6

Changes in this update:
- Replaced the always-visible Add New Match form with an Add New Match button and scrollable popup modal.
- Reduced Match ID input width and made it responsive to the input label/content.
- Replaced native time input with a dropdown covering all 24 hours and minute choices 00, 15, 30, 45.
- Reordered Myanmar odds options: for Body odds, existing 0 options remain; each line 1–6 shows `=` then all minus values from 05 to 100, then plus values from 05 to 100. GP odds uses existing goal range 2–7 with the same minus-then-plus ordering.
- Added row checkboxes, select-all, and Delete Selected for Match Schedule.
- Replaced multiple Action buttons with one Action dropdown while retaining Edit, Edit Odds, Odds History, Open/Close, Suspend, Cancel, and Delete actions.

Validation: inline JavaScript passed `node --check`. Please test locally before deploying. Back up `betting.db` first.
