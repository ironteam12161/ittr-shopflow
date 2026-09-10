PRODUCTION MIGRATION PLAN

v20 still preserves the existing localStorage data so upgrading does not erase the shop's current records.
A PostgreSQL schema is included in database/schema.sql as the target production database.

Before going live across multiple phones:
1. Deploy PostgreSQL.
2. Move users to server-side authentication with password hashing and secure sessions.
3. Import existing localStorage work orders/users/vehicles into PostgreSQL once.
4. Replace save()/saveUsers()/savePro() with authenticated API calls.
5. Store inspection photos in object storage and keep only URLs/metadata in PostgreSQL.
6. Add WebSocket/SSE updates so every phone sees changes in real time.
7. Add scheduled server jobs for maintenance alerts and daily reports.
8. Back up the database and photo bucket automatically.

Do not use the browser localStorage build as the final multi-device production database.
