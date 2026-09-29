// ITTR workshop manual library: page-by-page text index + page slices for the AI.
// Only the few pages relevant to a question are ever sent to the model (cheap, cites pages,
// and the model still sees tables and diagrams on those pages).
import { extractText, getDocumentProxy } from 'unpdf';
import { PDFDocument } from 'pdf-lib';

export async function extractPdfPages(bytes) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { totalPages, pages: (Array.isArray(text) ? text : [text]).map(t => String(t || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').trim()) };
}

export async function slicePdf(bytes, pageNumbers) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  const wanted = [...new Set(pageNumbers.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= total))].slice(0, 6);
  if (!wanted.length) return null;
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, wanted.map(n => n - 1));
  pages.forEach(p => out.addPage(p));
  return { bytes: Buffer.from(await out.save()), pages: wanted, total };
}

// English truck-shop synonyms so Ukrainian/Russian questions still hit English manuals.
const SYN = [
  [/момент|затяжк|затягув|torque|ft[- ]?lb|lb[- ]?ft|n[·.]?m\b|нм\b/i, 'torque'],
  [/схем|проводк|wiring|diagram|schematic|електр/i, 'wiring diagram'],
  [/гальм|brake/i, 'brake'], [/ступиц|маточин|hub/i, 'hub'], [/колес|wheel/i, 'wheel'], [/гайк|nut/i, 'nut'], [/болт|bolt/i, 'bolt'],
  [/форсун|інжектор|injector/i, 'injector'], [/турб|turbo/i, 'turbocharger'], [/клапан|valve/i, 'valve'], [/зазор|lash|clearance/i, 'valve lash clearance'],
  [/олив|масл|oil/i, 'oil'], [/фільтр|filter/i, 'filter'], [/антифриз|охолодж|coolant/i, 'coolant'], [/сальник|seal/i, 'seal'],
  [/кардан|driveshaft|u-?joint/i, 'driveshaft'], [/редуктор|диференц|differential|axle/i, 'axle differential'], [/коробк|transmission|кпп/i, 'transmission'],
  [/зчеплен|clutch/i, 'clutch'], [/ресор|spring|підвіск|suspension/i, 'suspension spring'], [/кпп|dpf|egr|scr|def|doc/i, (m) => m[0].toUpperCase()],
];
export function manualSearchTerms(q) {
  const s = String(q || '');
  const extra = [];
  for (const [re, en] of SYN) { const m = s.match(re); if (m) extra.push(typeof en === 'function' ? en(m) : en); }
  return `${s} ${extra.join(' ')}`.trim();
}
