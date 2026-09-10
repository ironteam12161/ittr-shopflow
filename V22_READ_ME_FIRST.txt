ITTR v22 — DATA SAFE + PAUSE/RESUME + FINDING DECISION SYNC

KEEP THE SAME RAILWAY PROJECT AND POSTGRES DATABASE.

Mechanic Pause / Resume
- Pause a running repair without completing it.
- Reasons: Waiting for Parts, End of Day, Waiting for Customer Approval, Waiting for Information, Other.
- Optional pause note.
- Resume later.
- Paused time is excluded from labor.
- Start/Pause/Resume/Complete are recorded server-side.

Finding decisions
- Proceed = active task in mechanic work order.
- Waiting for Customer = same task shows ON HOLD / WAITING FOR CUSTOMER.
- Do Not Proceed = same task shows DECLINED / DO NOT PROCEED and cannot be started.
- Changing back to Proceed reactivates the same task; no duplicate.
- If the decision changes while a task is running, the server stops the timer and preserves accumulated labor.

Data safety
- PostgreSQL keeps prior-state history snapshots.
- Schema migrations are tracked.
- Stale browser snapshot writes are rejected instead of silently overwriting newer cloud state.
- Existing database is upgraded in place. No DROP TABLE and no reset.

Deploy
1. Extract ZIP.
2. Upload all files to SAME private GitHub repo.
3. Commit.
4. Wait for Railway web service to become Online.
5. Do not recreate Postgres and do not change your existing Railway variables.
6. Hard refresh once with Ctrl+Shift+R.
