// v24.76.5: the database connection pool and its time limits.
// - Waiting for a connection (database unreachable, or every connection busy) gives up after ITTR_DB_CONNECT_TIMEOUT_MS
//   (default 15 s) instead of holding the request forever.
// - One SQL statement may run for ITTR_DB_STATEMENT_TIMEOUT_MS (default 120 s), and a transaction may sit idle between
//   statements for ITTR_DB_IDLE_TX_TIMEOUT_MS (default 120 s), so a runaway query or a forgotten transaction cannot hold
//   rows locked for good. 0 turns a limit off. Long maintenance work (index builds) lifts the statement limit for itself.
// - A connection that drops while a request is using it (database restart, network blip, a limit above) fails that
//   request only. Without a listener on the connection itself, pg raised it as an uncaught error and the server exited.
import pg from 'pg';

const limit = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export function dbLimits(env = process.env) {
  return {
    connectMs: limit(env, 'ITTR_DB_CONNECT_TIMEOUT_MS', 15000),
    statementMs: limit(env, 'ITTR_DB_STATEMENT_TIMEOUT_MS', 120000),
    idleTxMs: limit(env, 'ITTR_DB_IDLE_TX_TIMEOUT_MS', 120000),
  };
}

export function createPool({ connectionString, ssl, env = process.env, log = console } = {}) {
  if (!connectionString) return null;
  const limits = dbLimits(env);
  const pool = new pg.Pool({ connectionString, ssl, keepAlive: true, ...(limits.connectMs ? { connectionTimeoutMillis: limits.connectMs } : {}) });
  pool.ittrLimits = limits;
  // v24.71.0: an idle pooled connection's error is reported, not fatal. Readiness (/api/health) answers 503 until the
  // database is back.
  pool.on('error', e => log.error('[database] idle connection error:', e?.message || e));
  pool.on('connect', client => {
    client.on('error', e => log.error('[database] connection lost while in use:', e?.message || e));
    // SET rather than startup options, so a connection pooler in front of PostgreSQL cannot refuse the connection.
    // pg runs queries on a connection in order, so these come before the first query that uses it.
    const sets = [];
    if (limits.statementMs) sets.push(`SET statement_timeout=${limits.statementMs}`);
    if (limits.idleTxMs) sets.push(`SET idle_in_transaction_session_timeout=${limits.idleTxMs}`);
    if (sets.length) client.query(sets.join(';')).catch(e => log.error('[database] could not set time limits:', e?.message || e));
  });
  return pool;
}

// For maintenance statements that may legitimately run longer than the statement limit (CREATE INDEX CONCURRENTLY on a
// large table). A dedicated connection, because CONCURRENTLY cannot run inside a transaction.
export async function withoutStatementLimit(pool, fn) {
  const client = await pool.connect();
  let broken = null;
  try { await client.query('SET statement_timeout=0'); return await fn(client); }
  catch (e) { broken = e; throw e; }
  finally {
    try { if (!broken) await client.query(pool.ittrLimits?.statementMs ? `SET statement_timeout=${pool.ittrLimits.statementMs}` : 'SET statement_timeout=0'); } catch (e) { broken = e; }
    client.release(broken || undefined);
  }
}

// A request that failed because the database was unreachable, too slow, or dropped the connection.
export function isDatabaseUnavailable(err) {
  if (!err || err.status || err.statusCode) return false;
  if (['57014', '25P03', '57P01', '57P02', '57P03', '08000', '08003', '08006'].includes(String(err.code || ''))) return true;
  // pg's own messages only: other services (R2, Samsara, email) can fail with ECONNREFUSED too, and that is not the database.
  return /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error/i.test(String(err.message || ''));
}
