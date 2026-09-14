ITTR v24.8.1 — AI Workshop Copilot

Deploy over the SAME Railway project and PostgreSQL database. Do not reset the database.

After deployment:
1. Confirm green build bar shows frontend/backend 24.8.1.
2. Open Workshop AI from the lower-right button.
3. Ask: коли була заміна масла на 6600?
4. Enter a Unit context and ask for recent repairs.
5. Admin: Workshop AI > Manuals > add a licensed PDF or source URL.
6. Ask a torque/spec/procedure question for a matching unit. Exact specs should only be returned when supported by the uploaded/licensed manual.

Required existing env vars remain unchanged. PDF-manual AI requires OPENROUTER_API_KEY and configured R2 variables.
