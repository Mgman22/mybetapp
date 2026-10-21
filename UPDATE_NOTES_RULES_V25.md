# STT Betting v25 — Rules & Regulations + Animated Bettor Hero

## Admin Panel
- Added Rules & Regulations page under Website.
- Admin can edit plain-text rules and toggle visibility.
- Rules are stored in `site_settings` as `bettor_rules` and `bettor_rules_enabled`.
- Added public GET `/api/rules` and protected admin POST `/api/admin/rules`.
- Rule updates are written to security audit as `UPDATE_RULES`.

## Bettor Panel
- Added Rules tab.
- Rules are loaded from `/api/rules` and rendered as escaped plain text with preserved line breaks.
- Disabled/empty rules show an unavailable message.
- Added animated glass hero effects (moving shine, soft orb, live clock pulse).
- Hero already uses live Asia/Yangon time; kept it and enhanced the visual treatment without changing card sizing.
