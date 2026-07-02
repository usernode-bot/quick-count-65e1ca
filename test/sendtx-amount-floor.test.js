'use strict';

// sendTx() is the single choke point every app-initiated transaction passes
// through (public/index.html). Most call sites pass amount: 0 (the payload
// lives in the memo), but a 0-amount transaction is invalid on-chain, so
// sendTx floors it to 1. This extracts sendTx out of the HTML shell (same
// technique as test/orgmgmt-client-parity.test.js) and drives it directly
// against a stubbed window.QCBridge across all three branches.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

const sendTxBlock = balancedAfter(html, 'function sendTx(to, amount, memoObj, opts)');

// Build sendTx with App/window/validateMemo/mockSubmit supplied as closured
// params, mirroring how they exist in the real IIFE scope.
function makeSendTx(App, windowStub) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'App', 'window', 'validateMemo', 'mockSubmit',
    'return function sendTx(to, amount, memoObj, opts) ' + sendTxBlock + ';'
  );
  return factory(App, windowStub, () => true, () => Promise.resolve('unused'));
}

function makeBridgeStub() {
  const calls = [];
  return {
    calls,
    QCBridge: {
      send: (to, amount, memoStr, opts) => {
        calls.push({ to, amount, memoStr, opts });
        return 'txid-stub';
      },
    },
  };
}

test('sendTx floors amount 0/undefined/negative to 1 in the localDev branch', () => {
  const { QCBridge, calls } = makeBridgeStub();
  const App = { cfg: { localDev: true, mockMode: false } };
  const sendTx = makeSendTx(App, { QCBridge, QCMock: { send: () => {} } });
  sendTx('to-addr', 0, { a: 1 }, {});
  sendTx('to-addr', undefined, { a: 1 }, {});
  sendTx('to-addr', -5, { a: 1 }, {});
  assert.deepStrictEqual(calls.map((c) => c.amount), [1, 1, 1]);
});

test('sendTx floors amount 0/undefined/negative to 1 in the mockMode branch', () => {
  const { QCBridge, calls } = makeBridgeStub();
  const App = { cfg: { localDev: false, mockMode: true } };
  const sendTx = makeSendTx(App, { QCBridge });
  sendTx('to-addr', 0, { a: 1 }, {});
  sendTx('to-addr', undefined, { a: 1 }, {});
  sendTx('to-addr', -5, { a: 1 }, {});
  assert.deepStrictEqual(calls.map((c) => c.amount), [1, 1, 1]);
});

test('sendTx floors amount 0/undefined/negative to 1 in the default/real-bridge branch', () => {
  const { QCBridge, calls } = makeBridgeStub();
  const App = { cfg: { localDev: false, mockMode: false } };
  const sendTx = makeSendTx(App, { QCBridge });
  sendTx('to-addr', 0, { a: 1 }, {});
  sendTx('to-addr', undefined, { a: 1 }, {});
  sendTx('to-addr', -5, { a: 1 }, {});
  assert.deepStrictEqual(calls.map((c) => c.amount), [1, 1, 1]);
});

test('sendTx passes a real fee amount through unchanged, across all branches', () => {
  for (const cfg of [{ localDev: true, mockMode: false }, { localDev: false, mockMode: true }, { localDev: false, mockMode: false }]) {
    const { QCBridge, calls } = makeBridgeStub();
    const App = { cfg };
    const sendTx = makeSendTx(App, { QCBridge, QCMock: { send: () => {} } });
    sendTx('treasury-addr', 100, { t: 'org' }, {});
    assert.strictEqual(calls[0].amount, 100);
  }
});
