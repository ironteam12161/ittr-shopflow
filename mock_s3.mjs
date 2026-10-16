// v24.69.0: tiny in-memory S3-compatible server for tests only (photo storage without a real R2 bucket).
// Supports what the app uses: PUT/GET/HEAD/DELETE object, HEAD bucket, and presigned GET URLs (signature not checked;
// an expired presigned URL is answered with 403 like S3 so the "link expired" path can be tested).
import http from 'node:http';

export async function startMockS3({ bucket = 'ittr-test' } = {}) {
  const objects = new Map(); const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const b = parts.shift(), key = parts.join('/');
    log.push(`${req.method} ${key}`);
    if (b !== bucket) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
    const date = u.searchParams.get('X-Amz-Date'), exp = Number(u.searchParams.get('X-Amz-Expires') || 0);
    if (date && exp) { const t = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15)); if (Date.now() > t + exp * 1000 || server.forceExpired?.has(key)) { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>'); } }
    if (!key) { res.writeHead(200); return res.end(); }
    if (req.method === 'PUT') { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] || 'application/octet-stream' }); res.writeHead(200, { ETag: '"x"' }); res.end(); }); return; }
    const o = objects.get(key);
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    if (!o) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
    res.writeHead(200, { 'Content-Type': o.type, 'Content-Length': o.body.length, 'Access-Control-Allow-Origin': '*' });
    res.end(req.method === 'HEAD' ? undefined : o.body);
  });
  server.forceExpired = new Set();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { endpoint, bucket, objects, log, server, env: { R2_BUCKET_NAME: bucket, R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_REGION: 'auto' }, close: () => new Promise(r => server.close(r)) };
}
