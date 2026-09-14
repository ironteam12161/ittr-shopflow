# ITTR ShopFlow v24.17.8 — Invoice Tab Session Fix

## Fixed
- Invoice workspace no longer opens at the login screen when launched from an already authenticated ShopFlow tab.
- Keeps invoice workspaces in a normal separate browser tab.
- Uses a same-origin BroadcastChannel to hand the active session to the invoice tab.
- Does not put the bearer token in the URL.
- Does not persist the bearer token in localStorage.
- Keeps `noopener noreferrer` on the invoice tab link.

## Preserved
- v24.17.7 mechanic customer/unit ownership hardening.
- invoice draft autosave before structural actions.
- live parts autocomplete.
- old invoice deletion controls.
- AI chat and voice.
- Fullbay inventory SQL `$22` regression guard.

## Validation
- `npm run check`: 183/183 PASS.
- root/public frontend byte-identical.
- server syntax valid.

Deploy over the same Railway service and same PostgreSQL database. No database reset or destructive migration is required.
