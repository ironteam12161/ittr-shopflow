// v24.76.5 test helper (operations_safety_test.mjs O7), loaded into a test server with NODE_OPTIONS=--import. Requests to
// Samsara get an empty fleet after ITTR_TEST_SAMSARA_DELAY_MS, so a test can see what the server holds while Samsara is
// slow. Nothing leaves the machine. Never used by the real server.
const realFetch = globalThis.fetch;
const delay = Math.max(0, Number(process.env.ITTR_TEST_SAMSARA_DELAY_MS) || 0);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.hostname !== 'api.samsara.com') return realFetch(input, init);
  await new Promise(r => setTimeout(r, delay));
  return new Response(JSON.stringify({ data: [], pagination: { hasNextPage: false, endCursor: '' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
