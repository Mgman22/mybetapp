# Transaction Management v20 Fix

- Narrowed Request Time / Processed Time columns for better table usability.
- Replaced inline Approve/Reject handlers with delegated click handling using data attributes; avoids dynamic-row inline JS quoting/click issues.
- Added confirmation before transaction approval/rejection.
- Buttons are disabled while an action is processing to prevent double-clicks.
- Backend checks that exactly one Pending transaction was updated; otherwise rolls back and returns conflict.
- Process By Who / Where and Processed Time remain server-recorded at processing time.
