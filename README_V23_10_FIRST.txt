ITTR v23.10.0 — NHTSA VIN AUTO-FILL

NEW:
- Official NHTSA vPIC VIN decode. No API key required.
- In Customers > Truck / Unit, enter a complete 17-character VIN. ITTR automatically looks it up after a short pause and fills blank Year, Make, Model, Engine, and Transmission fields when NHTSA provides them.
- A Decode VIN button is available for manual lookup.
- Existing nonblank vehicle fields are not silently overwritten; use Replace vehicle fields with NHTSA data when desired.
- Operations Center > Vehicle Profiles also auto-decodes VINs through NHTSA instead of AI.
- NHTSA detail card shows available vehicle type, body class, GVWR, drive type, fuel, engine, transmission, and plant information.
- FMCSA / SAFER customer lookup from v23.9 remains intact.

DEPLOY:
1. Deploy to the SAME Railway project.
2. Do not reset PostgreSQL.
3. No new API key is needed for VIN decoding.
4. Confirm /api/build and the green banner both show 23.10.0.
