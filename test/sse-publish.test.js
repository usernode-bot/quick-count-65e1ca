'use strict';

// Live-publishing (SSE) tests: the in-process broker (subscribe / publish /
// cleanup) and the public stream endpoint. Runs WITHOUT a database (pool null);
// the shared indexer is seeded from buildDemoTxs() so the endpoint can resolve
// an election. Mirrors the no-DB endpoint pattern in orgs-endpoint.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.USERNODE_ENV = 'staging';
delete process.env.DATABASE_URL;

const { app, indexer, buildDemoTxs, sse } = require('../server');

let server, base;
before(async () => {
  indexer.rebuild(buildDemoTxs());
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (server) server.close(); });

test('broker delivers a published frame to a subscriber and cleans up', () => {
  const frames = [];
  const fakeRes = { write: (s) => frames.push(s) };
  const before = sse.count();
  const unsubscribe = sse.subscribe('eid-x', fakeRes);
  assert.strictEqual(sse.count(), before + 1);

  sse.publish('eid-x', { kind: 'test', lastUpdated: null });
  assert.strictEqual(frames.length, 1);
  assert.match(frames[0], /event: update/);
  assert.match(frames[0], /"kind":"test"/);

  // A publish to a different eid is not delivered here.
  sse.publish('eid-other', { kind: 'nope' });
  assert.strictEqual(frames.length, 1);

  unsubscribe();
  assert.strictEqual(sse.count(), before);
  // After cleanup, further publishes are a no-op (no throw).
  sse.publish('eid-x', { kind: 'after' });
  assert.strictEqual(frames.length, 1);
});

test('public election stream is reachable without a token and sends a ready event', async () => {
  const got = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/public/elections/demo-election/stream', (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('event: ready')) {
          req.destroy();
          resolve({ status: res.statusCode, type: res.headers['content-type'], buf });
        }
      });
      res.on('error', () => { /* destroyed on purpose */ });
    });
    req.on('error', (e) => { if (!/aborted|socket hang up/i.test(e.message)) reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('timed out waiting for ready event')); }, 4000);
  });
  assert.strictEqual(got.status, 200);
  assert.match(got.type || '', /text\/event-stream/);
  assert.match(got.buf, /event: ready/);
  assert.match(got.buf, /demo-election/);
});
