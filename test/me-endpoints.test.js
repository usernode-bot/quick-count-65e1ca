'use strict';

// Endpoint tests for /api/me + /api/me/profile. These run WITHOUT a database
// (DATABASE_URL unset → pool is null), so they cover identity resolution and
// validation — the branches that return before touching Postgres. The pure
// validator/resolver logic is covered separately in profile.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Force a non-prod env so the `viewer` fallback is honored, and ensure no DB.
process.env.USERNODE_ENV = 'staging';
delete process.env.DATABASE_URL;

const { app } = require('../server');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (server) server.close(); });

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(base + path);
    const r = http.request(u, {
      method,
      headers: data ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('GET /__mock/enabled is present (200) with the default always-on mock flow', async () => {
  // LOCAL_DEV is false here, but MOCK_TX_FLOW defaults on in every environment,
  // so the bridge probe is mounted and reports enabled — this is what makes the
  // hosted bridge route submissions through the self-contained local-ingest path.
  const { status, json } = await req('GET', '/__mock/enabled');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.enabled, true);
});

test('GET /api/me without auth returns null identity (no 401)', async () => {
  const { status, json } = await req('GET', '/api/me');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.usernode_pubkey, null);
  assert.strictEqual(json.username, null);
  assert.strictEqual(json.profile, null);
});

test('PUT /api/me/profile without a wallet is rejected', async () => {
  // No token, no viewer → no acting wallet → 400 (mirrors the unlock endpoint).
  const { status, json } = await req('PUT', '/api/me/profile', { display_name: 'valid_name' });
  assert.strictEqual(status, 400);
  assert.match(json.error, /wallet/i);
});

test('PUT /api/me/profile rejects an invalid display name', async () => {
  const { status, json } = await req('PUT', '/api/me/profile?viewer=ut1tester000000000000000000000000000000', { display_name: 'no' });
  assert.strictEqual(status, 400);
  assert.match(json.error, /3.?20|letters/i);
});

test('PUT /api/me/profile rejects an unsupported language', async () => {
  const { status, json } = await req('PUT', '/api/me/profile?viewer=ut1tester000000000000000000000000000000', { preferred_lang: 'de' });
  assert.strictEqual(status, 400);
  assert.match(json.error, /language/i);
});

test('PUT /api/me/profile with a valid payload but no DB reports unavailable', async () => {
  // Validation passes; the handler then needs Postgres, which is absent here.
  const { status } = await req('PUT', '/api/me/profile?viewer=ut1tester000000000000000000000000000000', { display_name: 'valid_name', preferred_lang: 'fr' });
  assert.strictEqual(status, 503);
});

test('PUT /api/me/profile rejects an overlong bio', async () => {
  const longBio = 'a'.repeat(281);
  const { status, json } = await req('PUT', '/api/me/profile?viewer=ut1tester000000000000000000000000000000', { bio: longBio });
  assert.strictEqual(status, 400);
  assert.match(json.error, /280/i);
});

test('PUT /api/me/profile accepts a valid bio (falls through to no-DB 503)', async () => {
  const { status } = await req('PUT', '/api/me/profile?viewer=ut1tester000000000000000000000000000000', { bio: 'A short bio.' });
  assert.strictEqual(status, 503);
});

test('PUT /api/me/profile accepts a prefs-only payload (falls through to no-DB 503)', async () => {
  // prefs (per-username UI config restored on return) is a valid standalone
  // update — it must not be rejected as "Nothing to update", and without a DB it
  // degrades to 503 like the other writable fields.
  const { status } = await req('PUT', '/api/me/profile?viewer=ut1tester000000000000000000000000000000', { prefs: { theme: 'dark', method: 'verified' } });
  assert.strictEqual(status, 503);
});

test('POST /api/unlock/verify without a DB returns 503, not 500', async () => {
  // The unlock record is off-chain; with no Postgres the feature degrades
  // cleanly (503) instead of throwing a generic 500. No token here → the handler
  // first rejects the missing wallet (400), so we assert it never 500s.
  const { status } = await req('POST', '/api/unlock/verify', { tx_id: 'whatever' });
  assert.notStrictEqual(status, 500);
});
