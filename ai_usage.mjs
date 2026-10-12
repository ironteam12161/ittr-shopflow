// ITTR ShopFlow v24.42.0: AI usage meter and monthly budget.
// Every call to the AI providers goes through meterAIClient(), which records the feature, user, model, tokens and
// cost in ai_usage, and stops new AI calls once the owner's monthly budget is used up.
// OpenRouter reports the real cost of each call (usage.cost); for other providers the cost is estimated from tokens.
import { AsyncLocalStorage } from 'node:async_hooks';

export const aiContext = new AsyncLocalStorage();
export const DEFAULT_AI_BUDGET = Object.freeze({ monthlyLimit: 25, warnAt: 0.8 });

// USD per 1M tokens [input, output]. Used only when the provider does not report the cost.
const PRICES = [
  [/gemini-2\.5-flash-lite/i, 0.10, 0.40],
  [/gemini-2\.5-flash/i, 0.30, 2.50],
  [/gemini-2\.5-pro/i, 1.25, 10.00],
  [/gpt-4o-transcribe/i, 2.50, 10.00],
  [/gpt-4o-mini/i, 0.15, 0.60],
  [/gpt-4o/i, 2.50, 10.00],
];
export function estimateCost(model, promptTokens, completionTokens) {
  const p = PRICES.find(([re]) => re.test(String(model || '')));
  const [inP, outP] = p ? [p[1], p[2]] : [Number(process.env.AI_PRICE_IN_PER_M || 0.5), Number(process.env.AI_PRICE_OUT_PER_M || 2)];
  return (Number(promptTokens || 0) * inP + Number(completionTokens || 0) * outP) / 1e6;
}

// Which part of the app an API path belongs to (shown in the usage report).
const FEATURES = [
  [/^\/api\/translate/, 'translate', 'Screen translation'],
  [/^\/api\/ai\/shop-chat/, 'assistant', 'Workshop AI chat'],
  [/^\/api\/parts\/receiving\/scan-invoice/, 'vendor_scan', 'Vendor invoice scan (receiving)'],
  [/^\/api\/vendor-invoices/, 'vendor_bills', 'Vendor bills (filing + analysis)'],
  [/^\/api\/gmail/, 'vendor_bills', 'Vendor bills (filing + analysis)'],
  [/^\/api\/invoices\/[^/]+\/check/, 'invoice_check', 'Invoice check'],
  [/^\/api\/ai\/import/, 'invoice_import', 'Old invoice import'],
  [/^\/api\/ai\/(note|diagnostic|part)/, 'writing', 'Notes, diagnostics, parts help'],
  [/^\/api\/ai\/productivity/, 'reports', 'Report summaries'],
  [/^\/api\/transcribe/, 'voice', 'Voice notes'],
  [/^\/api\/manuals/, 'manuals', 'Workshop manuals'],
];
export const FEATURE_LABELS = Object.fromEntries([...FEATURES.map(([, k, l]) => [k, l]), ['background', 'Background jobs'], ['other', 'Other']]);
export function featureForPath(p) { const f = FEATURES.find(([re]) => re.test(String(p || ''))); return f ? f[1] : 'other'; }

export async function ensureAIUsageSchema(pool) {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS ai_usage(
    id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), feature TEXT NOT NULL, username TEXT,
    provider TEXT, model TEXT, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0, cost_estimated BOOLEAN NOT NULL DEFAULT TRUE, ok BOOLEAN NOT NULL DEFAULT TRUE, error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_time ON ai_usage(created_at DESC);
  CREATE TABLE IF NOT EXISTS ai_translation_cache(
    target_language TEXT NOT NULL, source_text TEXT NOT NULL, translation TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(target_language, source_text)
  );`);
}

export function cleanAIBudget(b = {}, cur = DEFAULT_AI_BUDGET) {
  const lim = Number(b.monthlyLimit), warn = Number(b.warnAt);
  return {
    monthlyLimit: Number.isFinite(lim) && lim >= 0 && lim <= 10000 ? Math.round(lim * 100) / 100 : cur.monthlyLimit,
    warnAt: Number.isFinite(warn) && warn > 0 && warn < 1 ? warn : cur.warnAt,
  };
}

export function createAIMeter({ pool }) {
  let budget = { ...DEFAULT_AI_BUDGET }, spent = 0, loadedAt = 0, monthKey = '';
  const curMonth = () => new Date().toISOString().slice(0, 7);
  async function refresh(force = false) {
    if (!pool) return;
    if (!force && Date.now() - loadedAt < 60_000 && monthKey === curMonth()) return;
    try {
      const [b, s] = await Promise.all([
        pool.query("SELECT value FROM shop_settings WHERE setting_key='ai_budget'"),
        pool.query("SELECT coalesce(sum(cost_usd),0)::float8 s FROM ai_usage WHERE created_at>=date_trunc('month',now())"),
      ]);
      budget = cleanAIBudget(b.rows[0]?.value || {}, DEFAULT_AI_BUDGET); spent = Number(s.rows[0]?.s || 0); loadedAt = Date.now(); monthKey = curMonth();
    } catch (_) { /* tables not ready yet: allow the call */ }
  }
  async function guard() {
    await refresh();
    if (budget.monthlyLimit > 0 && spent >= budget.monthlyLimit) {
      const e = new Error(`The monthly AI budget ($${budget.monthlyLimit.toFixed(2)}) is used up. The owner can raise it in Reports → AI usage.`);
      e.code = 'AI_BUDGET_REACHED'; throw e;
    }
  }
  function record({ provider, model, usage, ok = true, error = '' }) {
    const store = aiContext.getStore() || {};
    const prompt = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
    const completion = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
    const real = Number(usage?.cost);
    const estimated = !(Number.isFinite(real) && real >= 0);
    const cost = estimated ? estimateCost(model, prompt, completion) : real;
    spent += cost;
    if (!pool) return;
    pool.query(`INSERT INTO ai_usage(feature,username,provider,model,prompt_tokens,completion_tokens,cost_usd,cost_estimated,ok,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [store.feature || 'background', store.req?.user?.username || null, provider, String(model || '').slice(0, 120), prompt, completion, cost, estimated, ok, error ? String(error).slice(0, 300) : null])
      .catch(() => {});
  }
  async function run(provider, params, call) {
    await guard();
    try {
      const r = await call();
      record({ provider, model: r?.model || params?.model, usage: r?.usage });
      return r;
    } catch (e) {
      record({ provider, model: params?.model, usage: null, ok: false, error: `${e?.status || ''} ${e?.message || e}` });
      throw e;
    }
  }
  // Same shape as the OpenAI client, for the methods ShopFlow uses.
  function meterAIClient(c, provider) {
    if (!c) return null;
    const withUsage = p => (provider === 'openrouter' ? { ...p, usage: { include: true } } : p);
    return {
      chat: { completions: { create: (p, o) => run(provider, p, () => c.chat.completions.create(withUsage(p), o)) } },
      responses: { create: (p, o) => run(provider, p, () => c.responses.create(p, o)) },
      audio: { transcriptions: { create: (p, o) => run(provider, p, () => c.audio.transcriptions.create(p, o)) } },
    };
  }
  return { meterAIClient, refresh, status: async () => { await refresh(); return { budget, spent }; }, setBudget: b => { budget = b; } };
}

export async function aiUsageReport(db, { days = 30 } = {}) {
  const d = Math.min(366, Math.max(1, Number(days) || 30));
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const [month] = await q(`SELECT count(*)::int calls, coalesce(sum(cost_usd),0)::float8 cost, count(*) FILTER (WHERE NOT ok)::int failed,
      coalesce(sum(prompt_tokens),0)::bigint prompt_tokens, coalesce(sum(completion_tokens),0)::bigint completion_tokens,
      bool_or(cost_estimated) any_estimated FROM ai_usage WHERE created_at>=date_trunc('month',now())`);
  const [lastMonth] = await q(`SELECT coalesce(sum(cost_usd),0)::float8 cost, count(*)::int calls FROM ai_usage
      WHERE created_at>=date_trunc('month',now())-interval '1 month' AND created_at<date_trunc('month',now())`);
  const byFeature = await q(`SELECT feature, count(*)::int calls, coalesce(sum(cost_usd),0)::float8 cost, count(*) FILTER (WHERE NOT ok)::int failed,
      coalesce(avg(prompt_tokens+completion_tokens),0)::int avg_tokens FROM ai_usage WHERE created_at>=now()-($1::int*interval '1 day') GROUP BY 1 ORDER BY 3 DESC`, [d]);
  const byUser = await q(`SELECT coalesce(username,'(system)') username, count(*)::int calls, coalesce(sum(cost_usd),0)::float8 cost FROM ai_usage
      WHERE created_at>=now()-($1::int*interval '1 day') GROUP BY 1 ORDER BY 3 DESC LIMIT 30`, [d]);
  const byDay = await q(`SELECT to_char(created_at::date,'YYYY-MM-DD') AS day, count(*)::int calls, coalesce(sum(cost_usd),0)::float8 cost FROM ai_usage
      WHERE created_at>=now()-($1::int*interval '1 day') GROUP BY 1 ORDER BY 1`, [d]);
  const byModel = await q(`SELECT coalesce(model,'') model, count(*)::int calls, coalesce(sum(cost_usd),0)::float8 cost FROM ai_usage
      WHERE created_at>=now()-($1::int*interval '1 day') GROUP BY 1 ORDER BY 3 DESC`, [d]);
  const recentErrors = await q(`SELECT created_at, feature, username, model, error FROM ai_usage WHERE NOT ok AND created_at>=now()-($1::int*interval '1 day') ORDER BY id DESC LIMIT 15`, [d]);
  const [cache] = await q(`SELECT count(*)::int phrases FROM ai_translation_cache`);
  const now = new Date(), dim = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate(), dom = now.getUTCDate();
  const r6 = n => Math.round(Number(n || 0) * 10000) / 10000;
  return {
    days: d,
    month: { calls: month.calls, cost: r6(month.cost), failed: month.failed, promptTokens: Number(month.prompt_tokens), completionTokens: Number(month.completion_tokens), estimated: !!month.any_estimated,
      projected: r6(month.cost / Math.max(1, dom) * dim) },
    lastMonth: { calls: lastMonth.calls, cost: r6(lastMonth.cost) },
    byFeature: byFeature.map(x => ({ feature: x.feature, label: FEATURE_LABELS[x.feature] || x.feature, calls: x.calls, cost: r6(x.cost), failed: x.failed, avgTokens: x.avg_tokens, perCall: x.calls ? r6(x.cost / x.calls) : 0 })),
    byUser: byUser.map(x => ({ ...x, cost: r6(x.cost) })), byDay: byDay.map(x => ({ ...x, cost: r6(x.cost) })), byModel: byModel.map(x => ({ ...x, cost: r6(x.cost) })),
    recentErrors, translationPhrasesCached: cache?.phrases || 0,
  };
}
