'use strict';

// Regression guard for observerPanel()'s submit handler: blank Total/Invalid
// vote fields must be forwarded as undefined (so QC.res/resultMemo omits them)
// rather than the raw '' string, which Number('') coerces to a finite 0.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('observerPanel submit handler converts blank tot/inv to undefined, not raw ""', () => {
  const idx = html.indexOf('function observerPanel(');
  assert.ok(idx !== -1, 'observerPanel() not found');
  const body = html.slice(idx, html.indexOf('function ', idx + 20));
  assert.match(
    body,
    /totRaw\.trim\(\)\s*===\s*''\s*\?\s*undefined\s*:\s*totRaw/,
    'expected tot to be converted to undefined when blank'
  );
  assert.match(
    body,
    /invRaw\.trim\(\)\s*===\s*''\s*\?\s*undefined\s*:\s*invRaw/,
    'expected inv to be converted to undefined when blank'
  );
});
