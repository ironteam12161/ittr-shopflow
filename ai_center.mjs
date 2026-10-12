// ITTR ShopFlow v24.42.0: AI usage report + budget, vendor bills and invoice check routes.
import { aiUsageReport, cleanAIBudget, DEFAULT_AI_BUDGET, FEATURE_LABELS } from './ai_usage.mjs';
import { registerVendorBillRoutes } from './vendor_bills.mjs';
import { registerInvoiceCheckRoutes } from './invoice_check.mjs';

export function registerAICenterRoutes(app, deps) {
  const { auth, ownerOnly, managerPermission, requireDb, audit, aiMeter, aiStatus } = deps;
  app.get('/api/ai/usage', auth, managerPermission('reports'), async (req, res, next) => {
    try {
      const db = requireDb(), { budget, spent } = await aiMeter.status();
      res.json({ ...(await aiUsageReport(db, { days: req.query.days })), budget, spentThisMonth: Math.round(spent * 10000) / 10000, ai: aiStatus(), features: FEATURE_LABELS });
    } catch (e) { next(e); }
  });
  app.put('/api/ai/budget', auth, ownerOnly, async (req, res, next) => {
    try {
      const db = requireDb(), cur = (await db.query("SELECT value FROM shop_settings WHERE setting_key='ai_budget'")).rows[0]?.value || {};
      const value = cleanAIBudget(req.body || {}, cleanAIBudget(cur, DEFAULT_AI_BUDGET));
      await db.query(`INSERT INTO shop_settings(setting_key,value,updated_by,updated_at) VALUES('ai_budget',$1::jsonb,$2,now())
        ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(value), req.user.username]);
      await aiMeter.refresh(true);
      await audit(req.user.username, 'ai_budget_changed', value);
      res.json({ budget: value });
    } catch (e) { next(e); }
  });
  registerVendorBillRoutes(app, deps);
  registerInvoiceCheckRoutes(app, deps);
}
