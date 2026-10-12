// ITTR ShopFlow v24.41.9: checks that an AI answer is really a translation of the UI text it was given.
// Without this, a model could "answer" a label instead of translating it (e.g. ramble about prompts), and that text
// was shown in the app and cached forever.
const META = /(prompt|промпт|chat ?gpt|openai|\bsystem\b|системн|as an ai|i cannot|i can't|не можу|translat|переклад|користувач|user'?s? message|instruction|інструкці)/i;

export function validTranslation(source, out) {
  const src = String(source ?? '').trim(), t = String(out ?? '').trim();
  if (!src || !t) return false;
  if (t === src) return true; // names, codes and brands stay as they are
  if (t.length > Math.max(40, src.length * 3)) return false; // UI text never grows 3x when translated
  if (!src.includes('\n') && /\n/.test(t)) return false; // a one-line label must stay one line
  const metaOut = t.match(META);
  if (metaOut && !META.test(src)) return false; // talks about prompts/translation instead of translating
  if (/^["'«“]|["'»”]$/.test(t) && !/^["'«“]|["'»”]$/.test(src)) return false; // wrapped in quotes = commentary
  return true;
}

// The model returns {"translations":[...]} with one entry per input. Anything missing or suspicious becomes null,
// so the app keeps the English text instead of showing a bad translation.
export function parseBatchTranslations(sources, raw) {
  let arr = null;
  try {
    const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    arr = Array.isArray(j?.translations) ? j.translations : null;
  } catch { arr = null; }
  return sources.map((s, i) => (arr && typeof arr[i] === 'string' && validTranslation(s, arr[i]) ? arr[i].trim() : null));
}
