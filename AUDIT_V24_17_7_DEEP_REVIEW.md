# ITTR ShopFlow v24.17.7 — Deep Review

Base audited: uploaded v24.17.6 package.

## Verified
- Package/frontend/backend release identity aligned.
- Root/public frontend byte-identical.
- Inline JS and module JS syntax pass.
- No duplicate DOM IDs or Express method/path pairs.
- Invoice new-tab workspace, draft-preserving structural actions, parts inventory autocomplete, PDF save-before-download, old invoice permanent delete, and labor rate presets remain present.
- AI shop chat endpoint/client sender and voice controls remain present.
- Fullbay inventory import still uses max SQL parameter $22 and does not reference $23.
- Mechanic USDOT/VIN self-start is mechanic-only on creation and uses FMCSA/NHTSA server-side lookup.
- No production secrets were found in the package.

## Hardening fix in v24.17.7
The uploaded v24.17.6 code accepted an explicit existing unitRecordId before checking whether that unit belonged to the selected customer. Normal UI flow would not normally create this mismatch, but a crafted request could. v24.17.7 now rejects this with HTTP 409 / UNIT_CUSTOMER_CONFLICT and only attaches an unowned unit to the selected customer.

## Packaging
The uploaded ZIP's outer directory was still named ITTR_v24_16_1_INVOICE_TAB_AUTOSAVE_HARDENED even though the code was v24.17.6. This rebuilt package uses a version-correct outer directory name.
