# Transaction Management Update

- Transaction table columns updated to:
  No. | Marker | Type | Amt | Request Time | Processed Time | Process By Who | Process By Where | Status | Action
- Added DB migration columns:
  process_by_who, process_by_where, processed_at
- Admin transaction actions record:
  Process By Who = Admin
  Process By Where = Desktop / Tablet / Phone (User-Agent based)
- System-generated wallet transactions record:
  Process By Who = System
  Process By Where = Server
- Pending Deposit / Withdrawal requests keep processing fields empty until processed.
- Existing legacy processed_by data remains compatible; UI falls back to Admin/System where possible.
- Admin action refreshes both Transactions and Ledger views when available.
