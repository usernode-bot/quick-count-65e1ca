'use strict';

// Client/server parity for the org-management memo types. The browser mirrors
// lib/memo.js inline (QC.* builders + validateMemo) because there is no bundler.
// This test extracts those two pieces from public/index.html and checks they
// agree with lib/memo for omem/orem/ovis/odel — catching drift between the two.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const memo = require('../lib/memo');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Slice a brace-balanced block starting at the first `{` at/after `marker`.
function balancedAfter(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('marker not found: ' + marker);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error('unbalanced block: ' + marker);
}

// Reconstruct the client QC builder object and validateMemo() from the shell.
const APP = 'quickcount', V = 1;
const qcBlock = balancedAfter(html, 'const QC = {');
// eslint-disable-next-line no-new-func
const QC = new Function('APP', 'V', 'return ' + qcBlock + ';')(APP, V);
const vmBlock = balancedAfter(html, 'function validateMemo(m)');
// eslint-disable-next-line no-new-func
const validateMemo = new Function('return function validateMemo(m) ' + vmBlock + ';')();

test('client QC builders produce the same envelopes as lib/memo', () => {
  assert.deepStrictEqual(QC.omem('O', 'A', 'mod'), memo.memberMemo('O', 'A', 'mod'));
  assert.deepStrictEqual(QC.orem('O', 'A'), memo.removeMemberMemo('O', 'A'));
  assert.deepStrictEqual(QC.ovis('O', 'private'), memo.visibilityMemo('O', 'private'));
  assert.deepStrictEqual(QC.odel('O'), memo.deleteOrgMemo('O'));
  // unknown role coerced to 'member' on both sides
  assert.strictEqual(QC.omem('O', 'A', 'king').role, 'member');
});

test('client validateMemo agrees with lib/memo.decode on new types', () => {
  const cases = [
    QC.omem('O', 'A', 'admin'),
    QC.orem('O', 'A'),
    QC.ovis('O', 'public'),
    QC.odel('O'),
    { app: APP, v: V, t: 'omem', org: 'O', addr: 'A', role: 'king' }, // bad role
    { app: APP, v: V, t: 'omem', org: 'O', role: 'mod' },             // missing addr
    { app: APP, v: V, t: 'orem', org: 'O' },                          // missing addr
    { app: APP, v: V, t: 'ovis', org: 'O', vis: 'secret' },           // bad vis
    { app: APP, v: V, t: 'odel' },                                    // missing org
  ];
  for (const m of cases) {
    const clientOk = validateMemo(m);
    const serverOk = memo.decode(JSON.stringify(m)) !== null;
    assert.strictEqual(clientOk, serverOk, 'parity for ' + JSON.stringify(m));
  }
});
