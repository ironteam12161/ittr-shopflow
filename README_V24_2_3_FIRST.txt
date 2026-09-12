ITTR v24.2.3 — Professional Data Normalization

1. Upload/replace these files at the ROOT of the same GitHub repository used by Railway.
2. Do not create an extra release folder inside the repository.
3. Do not reset PostgreSQL.
4. Do not re-import Customers, Inventory or Details just to remove = signs.
5. Wait for Railway to finish deployment.
6. Hard refresh with Ctrl+Shift+R.
7. Verify the green build bar shows frontend/backend 24.2.3.
8. Open Customers & Vehicles > Air Delivery Corporation > Vehicles and confirm Unit/VIN/type/status no longer show leading = signs.
9. Open a vehicle > Service History > Open and confirm complaint/correction/technician/component/system are also clean.

The startup repair is designed to normalize already-imported Fullbay formatting artifacts while preserving the existing data and relationships.
