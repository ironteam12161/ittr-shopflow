ITTR v24.0.0 — SMART UNIFIED WORKSPACE

This release reorganizes the admin interface around daily shop workflows:
1. Dashboard
2. Work Orders
3. Customers & Vehicles
4. Findings
5. Operations

Main UX changes:
- Truck Search is no longer a separate primary screen.
- Customers & Vehicles has one smart search across customer/company, unit, VIN, plate, USDOT and work-order/service history.
- Header universal search works from anywhere. Ctrl+K focuses it on desktop.
- Vehicle Profiles are no longer a separate daily navigation area; customer/vehicle records are centralized.
- Completed history is accessed from Work Orders / Operations instead of another primary tab.
- Mechanic Activity and Mechanic Accounts are grouped under Operations.
- Iron Team logo is integrated into the header.

DATA SAFETY
- No database reset.
- No destructive migration.
- Existing work orders, customers, units, R2 photos, task labor, findings, parts and Fullbay import data remain in place.
- Existing legacy views/functions remain in code for compatibility, but duplicate screens are removed from primary navigation.

DEPLOYMENT
Replace the existing repository ROOT files with this package. Do not upload this package into a nested folder.
After Railway deploys, the green banner must show frontend 24.0.0 and backend 24.0.0.
