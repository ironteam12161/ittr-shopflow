// ITTR ShopFlow v24.47.2: live Samsara facts for the Workshop AI chat ("where is unit 25?", "what mileage is on the
// Freightliner?", "fuel / engine hours / fault codes"). Read-only; mechanics may use it.
// paged(path, query) -> array (Samsara API, all pages); db is optional (links Samsara vehicles to ShopFlow units).

const norm = v => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const last = x => (Array.isArray(x) ? (x[x.length - 1] || null) : x || null);
const val = x => { const z = last(x), v = Number(z?.value ?? z); return Number.isFinite(v) ? v : null; };
const ago = t => { const ms = Date.now() - Date.parse(t || ''); if (!Number.isFinite(ms) || ms < 0) return ''; const m = Math.round(ms / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

// Score how well one Samsara vehicle matches what the user typed (unit name/number, VIN or its last digits, plate).
export function samsaraMatchScore(v, query, linkedUnit = '') {
  const q = norm(query); if (!q) return 0;
  const name = norm(v?.name), vin = norm(v?.vin || v?.externalIds?.['samsara.vin']), plate = norm(v?.licensePlate), unit = norm(linkedUnit);
  if (q === name || q === unit || q === vin || (plate && q === plate)) return 100;
  const digits = q.replace(/^(unit|truck|trailer|trk|tr|u)/, '');
  if (digits && (digits === name || digits === unit || name.replace(/^(unit|truck|trailer|trk|tr|u)/, '') === digits)) return 95;
  if (vin && q.length >= 4 && vin.endsWith(q)) return 85;
  if (q.length >= 3 && (name.includes(q) || unit.includes(q))) return 60;
  return 0;
}

export function createSamsaraLookup({ paged, configured, db }) {
  let cache = null;
  const vehicles = async () => (cache && Date.now() - cache.at < 60000 ? cache.list : (cache = { at: Date.now(), list: await paged('/fleet/vehicles') }).list);
  async function linkedUnits() {
    if (!db) return new Map();
    try { return new Map((await db.query("SELECT samsara_vehicle_id,unit_number,customer_name FROM customer_units WHERE samsara_vehicle_id IS NOT NULL")).rows.map(r => [String(r.samsara_vehicle_id), r])); } catch (_) { return new Map(); }
  }
  return async function samsaraVehicle({ query = '' } = {}) {
    if (!configured()) return { note: 'Samsara is not connected to ShopFlow (SAMSARA_API_TOKEN is missing).' };
    const q = String(query || '').trim(); if (!q) return { note: 'Say which truck: unit number, VIN (or last digits) or plate.' };
    const [list, units] = await Promise.all([vehicles(), linkedUnits()]);
    const scored = list.map(v => ({ v, s: samsaraMatchScore(v, q, units.get(String(v.id))?.unit_number) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    if (!scored.length) return { found: 0, note: `No Samsara vehicle matches "${q}". Samsara has ${list.length} vehicles.`, examples: list.slice(0, 8).map(v => v.name) };
    const best = scored[0].s, picks = scored.filter(x => x.s === best).slice(0, 3).map(x => x.v);
    if (scored.filter(x => x.s === best).length > 3) return { found: scored.length, note: 'Several vehicles match — ask which one.', matches: scored.slice(0, 10).map(x => ({ name: x.v.name, vin: x.v.vin || '' })) };
    const ids = picks.map(v => v.id).join(',');
    const opt = async (types) => { try { return await paged('/fleet/vehicles/stats', { types, vehicleIds: ids }); } catch (e) { return [{ error: e?.message || String(e) }]; } };
    // Samsara allows a few stat types per request.
    const [a, b, c] = await Promise.all([opt('gps,obdOdometerMeters,gpsOdometerMeters'), opt('engineStates,fuelPercents,obdEngineSeconds'), opt('faultCodes')]);
    const by = rows => new Map(rows.filter(r => r?.id).map(r => [String(r.id), r]));
    const A = by(a), B = by(b), C = by(c);
    return {
      found: picks.length,
      vehicles: picks.map(v => {
        const s1 = A.get(String(v.id)) || {}, s2 = B.get(String(v.id)) || {}, s3 = C.get(String(v.id)) || {};
        const gps = last(s1.gps), odo = val(s1.obdOdometerMeters) ?? val(s1.gpsOdometerMeters), sec = val(s2.obdEngineSeconds);
        const fault = last(s3.faultCodes)?.value ?? last(s3.faultCodes) ?? {}, j = fault?.j1939?.diagnosticTroubleCodes ?? fault?.j1939?.dtcs ?? fault?.diagnosticTroubleCodes ?? [];
        const link = units.get(String(v.id));
        return {
          samsaraName: v.name || '', vin: v.vin || v.externalIds?.['samsara.vin'] || '', plate: v.licensePlate || '', year: v.year || '', make: v.make || '', model: v.model || '',
          shopflowUnit: link?.unit_number || '', customer: link?.customer_name || '',
          driver: v.staticAssignedDriver?.name || '',
          location: gps ? { address: gps.reverseGeo?.formattedLocation || '', latitude: gps.latitude, longitude: gps.longitude, mapLink: gps.latitude != null ? `https://maps.google.com/?q=${gps.latitude},${gps.longitude}` : '', speedMph: gps.speedMilesPerHour ?? null, at: gps.time || '', seen: ago(gps.time) } : null,
          odometerMiles: odo != null ? Math.round(odo / 1609.344) : null,
          engineHours: sec != null ? Math.round(sec / 360) / 10 : null,
          engineState: last(s2.engineStates)?.value || '',
          fuelPercent: val(s2.fuelPercents),
          activeFaultCodes: (Array.isArray(j) ? j : []).slice(0, 10).map(d => ({ spn: d.spnId ?? d.spn ?? null, fmi: d.fmiId ?? d.fmi ?? null, description: d.spnDescription || d.fmiDescription || d.description || '' })),
        };
      }),
    };
  };
}
