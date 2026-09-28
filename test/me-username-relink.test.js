'use strict';

// Regression: GET /api/me used to 500 when the verified username was already
// bound to a DIFFERENT wallet's profile row (a relinked wallet, or a staging
// identity returning with a fresh wallet). The INSERT's ON CONFLICT only
// covered usernode_pubkey, so profiles_username_uniq threw on every page load.
//
// Needs Postgres: runs when TEST_DATABASE_URL (or the in-loop INLOOP_DATABASE_URL)
// is set, and skips in the default no-database harness.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
process.env.USERNODE_ENV = 'staging';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'relink-test-secret';
if (DB_URL) process.env.DATABASE_URL = DB_URL; else delete process.env.DATABASE_URL;

const USERNAME = 'relink_test_' + Date.now();
const OLD_WALLET = 'ut1relinkold' + Date.now();
const NEW_WALLET = 'ut1relinknew' + Date.now();

let server, base, pg;
before(async () => {
  if (!DB_URL) return;
  const { app, migrate } = require('../server');
  await migrate();
  const { Pool } = require('pg');
  pg = new Pool({ connectionString: DB_URL });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) server.close();
  if (pg) {
    await pg.query('DELETE FROM profiles WHERE usernode_pubkey IN ($1, $2)', [OLD_WALLET, NEW_WALLET]);
    await pg.end();
  }
});

function getMe(pubkey) {
  const token = jwt.sign({ id: 1, username: USERNAME, usernode_pubkey: pubkey }, process.env.JWT_SECRET);
  return new Promise((resolve, reject) => {
    http.get(base + '/api/me', { headers: { 'x-usernode-token': token } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    }).on('error', reject);
  });
}

test('GET /api/me moves a username to the newly linked wallet instead of 500ing', { skip: !DB_URL && 'no database' }, async () => {
  const first = await getMe(OLD_WALLET);
  assert.strictEqual(first.status, 200);

  const second = await getMe(NEW_WALLET);
  assert.strictEqual(second.status, 200, JSON.stringify(second.json));
  assert.strictEqual(second.json.username, USERNAME);

  const { rows } = await pg.query(
    'SELECT usernode_pubkey FROM profiles WHERE username = $1', [USERNAME]
  );
  assert.deepStrictEqual(rows.map((r) => r.usernode_pubkey), [NEW_WALLET]);
});
