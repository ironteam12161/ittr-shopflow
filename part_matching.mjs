// ITTR ShopFlow v24.42.1: match vendor-invoice lines to inventory parts.
// 1) by part number (ignoring dashes/spaces), 2) when there is no part number or it is unknown, by description words
// ("Red 50/50 Heavy Duty Antifreeze - Per Gallon" → "Antifreeze - 55 Gallon"), and 3) suggest how many stock units a
// billed quantity is when the pack sizes differ (100 gallons billed → 1.82 of a 55-gallon drum part).

const STOP = new Set(['the', 'and', 'for', 'with', 'per', 'each', 'ea', 'pcs', 'pc', 'piece', 'pieces', 'gal', 'gallon', 'gallons', 'qt', 'quart', 'quarts', 'drum', 'drums', 'case', 'cs', 'box', 'pack', 'pk', 'bottle', 'jug', 'pail', 'tote', 'bulk', 'new', 'item', 'part', 'unit', 'units', 'heavy', 'duty', 'hd']);
export const normPn = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function descTokens(text) {
  const s = String(text || '').toLowerCase().replace(/(\d+)\s*\/\s*(\d+)/g, '$1x$2'); // 50/50 → 50x50
  return [...new Set(s.split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)))];
}

// Pack size written in a description: "55 Gallon", "5 gal", "per gallon", "case of 12", "12/cs".
export function packSize(text) {
  const s = String(text || '').toLowerCase();
  let m = /(\d+(?:\.\d+)?)\s*-?\s*(?:gal\b|gals\b|gallons?\b)/.exec(s);
  if (m) return { kind: 'gal', size: Number(m[1]) };
  if (/\b(per|\/)\s*(gal|gallon)\b|\bgallons?\b|\bgal\b/.test(s)) return { kind: 'gal', size: 1 };
  m = /(\d+(?:\.\d+)?)\s*-?\s*(?:qt|qts|quarts?)\b/.exec(s);
  if (m) return { kind: 'gal', size: Number(m[1]) / 4 };
  if (/\b(per|\/)\s*(qt|quart)\b|\bquarts?\b/.test(s)) return { kind: 'gal', size: 0.25 };
  m = /\bcase\s+of\s+(\d+)\b|\b(\d+)\s*(?:\/|per\s+)\s*(?:cs|case|box|pk|pack)\b|\b(\d+)\s*-?\s*(?:pk|pack|count|ct)\b/.exec(s);
  if (m) return { kind: 'each', size: Number(m[1] || m[2] || m[3]) };
  return null;
}
// How many stock units one billed unit is. 1 gallon billed into a "55 Gallon" part = 1/55; null = same unit.
export function stockFactor(lineText, partText) {
  const a = packSize(lineText), b = packSize(partText);
  if (!a || !b || a.kind !== b.kind || !(a.size > 0) || !(b.size > 0) || a.size === b.size) return null;
  return a.size / b.size;
}
const r2 = v => Math.round(v * 100) / 100;

export function scoreDescription(lineText, part) {
  const want = descTokens(lineText); if (!want.length) return 0;
  const have = new Set(descTokens(`${part.description || ''} ${part.part_number || ''} ${part.manufacturer || ''}`));
  const hit = want.filter(t => have.has(t)).length;
  if (!hit) return 0;
  // Share of the invoice words found in the part, plus a bit for how specific the part is (few extra words).
  return Math.min(1, hit / want.length * 0.85 + (have.size ? hit / have.size : 0) * 0.15);
}

// lines: [{partNumber, description, quantity}] → adds matches[], matchedPartId, matchStatus, matchBy, stockFactor, stockQty
export async function matchInvoiceLines(db, lines) {
  const cols = 'id,part_number,internal_barcode,description,manufacturer,quantity,cost,price,vendor,uom';
  for (const line of lines) {
    const pn = String(line.partNumber || '').trim();
    let rows = [];
    if (normPn(pn).length >= 2) {
      rows = (await db.query(`SELECT ${cols} FROM fullbay_import_parts WHERE lower(regexp_replace(coalesce(part_number,''),'[^a-zA-Z0-9]','','g'))=$1 ORDER BY CASE WHEN lower(part_number)=lower($2) THEN 0 ELSE 1 END LIMIT 3`, [normPn(pn), pn])).rows;
      line.matchBy = rows.length ? 'part_number' : '';
    }
    if (!rows.length) {
      const toks = descTokens(line.description).slice(0, 6);
      if (toks.length) {
        const cand = (await db.query(`SELECT ${cols} FROM fullbay_import_parts WHERE coalesce(status,'Active')<>'Inactive' AND lower(coalesce(description,'')||' '||coalesce(part_number,'')) LIKE ANY($1::text[]) LIMIT 200`, [toks.map(t => `%${t.replace(/[%_\\]/g, '')}%`)])).rows;
        rows = cand.map(p => ({ ...p, score: scoreDescription(line.description, p) })).filter(p => p.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 3);
        if (rows.length) line.matchBy = 'description';
      }
    }
    line.matches = rows;
    // A single part-number hit is a match; a description hit is pre-selected only when it clearly wins, and still shown for review.
    const top = rows[0], second = rows[1];
    const clear = top && (line.matchBy === 'part_number' ? rows.length === 1 : top.score >= 0.75 && (!second || top.score - second.score >= 0.15));
    line.matchedPartId = clear ? top.id : null;
    line.matchStatus = line.matchBy === 'part_number' && rows.length === 1 ? 'matched' : rows.length ? 'possible' : 'new';
    for (const p of rows) { const f = stockFactor(line.description, `${p.description || ''} ${p.uom || ''}`); if (f) { p.stockFactor = f; p.stockQty = r2(Number(line.quantity || 0) * f); } }
    if (clear && top.stockFactor) { line.stockFactor = top.stockFactor; line.stockQty = top.stockQty; }
  }
  return lines;
}
