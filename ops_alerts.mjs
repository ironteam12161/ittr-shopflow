// v24.56.0: server error alerts. Set ALERT_WEBHOOK_URL to a Slack, Discord, Microsoft Teams or any webhook that
// accepts JSON, and server errors (500s, crashes, a shop record close to its size limit) are posted there with the
// incident number shown to the user. The same error is sent at most once per 10 minutes, so an outage is one alert,
// not hundreds. Never throws and never blocks a request.
const sent = new Map();
export function alertsConfigured(env = process.env) { return /^https:\/\//.test(String(env.ALERT_WEBHOOK_URL || '').trim()); }
export function shouldSend(key, now = Date.now(), everyMs = 10 * 60 * 1000) {
  const last = sent.get(key); if (last && now - last < everyMs) return false;
  sent.set(key, now); if (sent.size > 500) for (const [k, t] of sent) if (now - t > everyMs) sent.delete(k);
  return true;
}
export async function sendAlert(text, { key = text, env = process.env, fetchImpl = fetch } = {}) {
  const url = String(env.ALERT_WEBHOOK_URL || '').trim(); if (!/^https:\/\//.test(url) && !env.ALERT_WEBHOOK_ALLOW_HTTP) return false;
  if (!shouldSend(String(key).slice(0, 200))) return false;
  const msg = `🚨 ITTR ShopFlow${env.RAILWAY_ENVIRONMENT_NAME ? ` (${env.RAILWAY_ENVIRONMENT_NAME})` : ''}: ${String(text).slice(0, 1500)}`;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
    // Slack/Teams read "text", Discord reads "content"; extra fields are ignored by each.
    const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: msg, content: msg }), signal: ctl.signal });
    clearTimeout(t); return r.ok;
  } catch (e) { console.warn('[alerts] webhook failed:', e?.message); return false; }
}
