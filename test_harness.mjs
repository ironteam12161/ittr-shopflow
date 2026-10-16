// v24.67.0: shared harness for the database integration suites added in this release.
// - Runs only against a disposable database: DATABASE_URL plus ITTR_LANGUAGE_TEST_DB=1 (CI sets both; the suite makes
//   its own throw-away schema and drops it at the end). Never point this at the production database.
// - When the release check requires the database suites (ITTR_REQUIRE_DB_SUITES=1, set in CI), a missing database is a
//   FAILURE, not a skip, so a passing CI run means the suite really ran.
import { spawn } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

import { appendFileSync } from 'node:fs';
// One line per suite (ran/passed/failed/skipped) in ITTR_SUITE_REPORT, so CI can show what really ran.
let reported = false;
export function reportSuite(name, result, detail = '') { if (reported) return; reported = true; const f = process.env.ITTR_SUITE_REPORT; if (!f) return; try { appendFileSync(f, `${result}\t${name}${detail ? `\t${detail}` : ''}\n`); } catch (_) {} }
export function dbSuiteGuard(name) {
  const flag = process.env.ITTR_LANGUAGE_TEST_DB === '1' || process.env.ITTR_OPERATIONS_TEST_DB === '1' || process.env.ITTR_INVENTORY_TEST_DB === '1';
  const url = String(process.env.DATABASE_URL || '');
  if (flag && url) { process.on('exit', code => reportSuite(name, code === 0 ? 'PASSED' : 'FAILED', code === 0 ? '' : `exit ${code}`)); return url; }
  const why = !url ? 'DATABASE_URL is not set' : 'the disposable-database flag (ITTR_LANGUAGE_TEST_DB=1) is not set';
  if (process.env.ITTR_REQUIRE_DB_SUITES === '1') { reportSuite(name, 'FAILED', `required but could not run: ${why}`); console.error(`FAIL ${name}: required database suite cannot run: ${why}`); process.exit(1); }
  reportSuite(name, 'SKIPPED', why);
  console.log(`SKIP ${name}: ${why}`);
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.once('error', reject); s.listen({ host: '127.0.0.1', port: 0 }, () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }

export async function startTestServer({ prefix = 'ittr_test', env = {}, admin = { username: 'opsadmin', password: 'CI-Ops-Admin-2026!' } } = {}) {
  const url = String(process.env.DATABASE_URL || '');
  const schema = `${prefix}_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g, '');
  const boot = new pg.Pool({ connectionString: url, ssl: false });
  await boot.query(`CREATE SCHEMA ${schema}`); await boot.end();
  const db = new pg.Pool({ connectionString: url, ssl: false, options: `-c search_path=${schema}` });
  let child = null, port = 0, output = '';
  const base = () => `http://127.0.0.1:${port}`;
  async function request(path, { method = 'GET', token, body, raw, allowError = false } = {}) {
    const r = await fetch(base() + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!r.ok && !allowError) throw Object.assign(new Error(`${method} ${path} -> ${r.status}: ${text}`), { status: r.status, code: data.code || '' });
    return { status: r.status, ...data };
  }
  async function start() {
    port = await freePort();
    child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PGOPTIONS: `-c search_path=${schema}`, PORT: String(port), NODE_ENV: 'test', BOOTSTRAP_ADMIN_USERNAME: admin.username, BOOTSTRAP_ADMIN_PASSWORD: admin.password, OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', SAMSARA_API_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    for (let i = 0; i < 200; i++) { if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}\n${output}`); try { const h = await request('/api/health'); if (h.ok && h.db) return; } catch {} await sleep(100); }
    throw new Error(`server did not start\n${output}`);
  }
  async function stop() { if (child && child.exitCode == null) { child.kill('SIGTERM'); await sleep(200); if (child.exitCode == null) child.kill('SIGKILL'); } child = null; }
  async function cleanup() { await stop().catch(() => {}); await db.end().catch(() => {}); const b = new pg.Pool({ connectionString: url, ssl: false }); try { await b.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) {} await b.end().catch(() => {}); }
  async function login(username, password) { const r = await request('/api/auth/login', { method: 'POST', body: { username, password } }); return r.token; }
  await start();
  return { db, schema, request, start, stop, cleanup, login, base, output: () => output, admin };
}

export function ok(v, msg) { if (!v) throw new Error(msg); }
export function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
export { sleep };
