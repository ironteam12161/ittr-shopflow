# ITTR ShopFlow v24.17.6 — Mechanic USDOT/VIN Self-Start

This release upgrades the existing mechanic **Start Job** wizard so a mechanic can identify a customer and truck without waiting for an administrator.

## Flow
1. Enter USDOT number.
2. Enter the 17-character VIN (unit number is optional for lookup).
3. ShopFlow checks the local ITTR customer/unit directory first.
4. If configured, the server queries the official FMCSA QCMobile API for carrier data.
5. The server decodes the VIN with NHTSA vPIC.
6. The mechanic reviews customer, unit number, year/make/model/mileage, jobs, and submits.
7. Existing records are reused. Missing customer/unit records are created only on final submission.
8. The new work order is assigned to the logged-in mechanic and marked Truck Is Here.

## Railway configuration
NHTSA vPIC does not require an API key for this use.
For live FMCSA carrier lookup, add this Railway Variable:

`FMCSA_WEBKEY=<your FMCSA developer WebKey>`

The WebKey is server-side only and is never sent to the browser.

## Safety / data-integrity controls
- VIN normalized to uppercase and validated as a 17-character VIN (I/O/Q rejected).
- Exact VIN lookup prevents duplicate unit creation.
- A VIN already attached to another customer is rejected with a conflict instead of silently reassigning it.
- Existing customer/unit records are reused.
- External records are candidates until the mechanic confirms and creates the work order.
- Created records are tagged `mechanic_self_start` and audited.
- FMCSA/NHTSA failures do not expose credentials.

## Validation
Run:

`npm run check`
