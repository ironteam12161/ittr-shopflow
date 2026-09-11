# ITTR ShopFlow v23.10.0 — NHTSA VIN Auto-Fill

New in v23.10.0:
- Official U.S. DOT / NHTSA vPIC VIN decoder integration.
- No VIN API key is required.
- Customers > Truck / Unit: entering a complete 17-character VIN automatically looks up and fills available Year, Make, Model, Engine, and Transmission fields.
- Existing nonblank fields are protected from silent overwrite; an explicit Replace action is available.
- Vehicle Profiles use the same official NHTSA decoder instead of AI VIN guessing.
- Decode result card shows additional NHTSA details when available, including vehicle type, body class, GVWR, drive type, fuel, engine, transmission, and plant.
- FMCSA / SAFER USDOT customer lookup remains included.
- Existing CRM, Fullbay, R2, productivity, collaboration, PDF, AI, and historical functionality is preserved.

Deploy this package to the same Railway project. Do not reset PostgreSQL. No new environment variable is required for NHTSA VIN decoding.
