// Quick Count — app-side bridge resilience layer (window.QCBridge + window.QCNotice).
//
// The hosted Usernode bridge (loaded cross-origin in the HTML shell) can be slow
// to wake up or its relay can momentarily time out. We can't touch the bridge or
// its timeout window — but we CAN, on our side, detect those failures, retry the
// safe ones with backoff, and degrade gracefully with a non-blocking Try-again
// notice instead of a dead-end. This module is the single choke point both
// index.html and dashboard.html call through.
//
// Classification rules live in the pure, testable companion
// public/usernode-bridge-classify.js (window.QCBridgeClassify).
(function () {
  'use strict';

  var C = window.QCBridgeClassify || {};
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function backoff(attempt) { return C.backoffDelay ? C.backoffDelay(attempt, Math.random) : 500 * (attempt + 1); }
  function classify(err) {
    if (err && err.qcKind) return err.qcKind;
    return C.classifyBridgeError ? C.classifyBridgeError(err) : 'unknown';
  }
  function tag(err, kind) {
    if (err && typeof err === 'object' && !err.qcKind) { try { err.qcKind = kind; } catch (_) {} }
    return err;
  }

  // ── Fault injection (local-dev / staging only) ──────────────────────────────
  // Set by the app from ?bridgefault=timeout|notready|reject when cfg allows it.
  // Centralised here so it covers BOTH the staging bridge path and the local-dev
  // mock path (which runs through this same invoke()). A no-op when unset.
  var FAULT = { mode: null, remaining: 0 };
  function setFault(mode, count) {
    FAULT.mode = mode || null;
    // 'timeout' is one-shot by default so reviewers can see auto-retry recover.
    FAULT.remaining = mode === 'timeout' ? (count == null ? 1 : count) : 0;
  }
  // Only fault SENDS (writes) — reads like getNodeAddress must stay clean so the
  // boot-time silent connect doesn't consume a one-shot meant for a user action.
  // ('notready' is the exception and is enforced in pollReady, affecting both.)
  function faultThrow(isSend) {
    if (!isSend) return null;
    if (FAULT.mode === 'timeout' && FAULT.remaining > 0) {
      FAULT.remaining -= 1;
      return new Error('Usernode relay timed out');
    }
    if (FAULT.mode === 'reject') return new Error('Transaction rejected by user');
    return null;
  }

  function invoke(fn, isSend) {
    return Promise.resolve().then(function () {
      var f = faultThrow(isSend);
      if (f) {
        if (FAULT.mode === 'timeout') return sleep(350).then(function () { throw f; });
        throw f;
      }
      return fn();
    });
  }

  // ── Readiness detection ─────────────────────────────────────────────────────
  function bridgeFnsPresent() {
    return typeof window.sendTransaction === 'function' && typeof window.getNodeAddress === 'function';
  }
  function pollReady(maxTries) {
    return new Promise(function (resolve) {
      var n = 0;
      (function poll() {
        if (FAULT.mode === 'notready') { if (n++ > maxTries) return resolve(false); return setTimeout(poll, 100); }
        if (bridgeFnsPresent()) return resolve(true);
        if (n++ > maxTries) return resolve(false);
        setTimeout(poll, 100);
      })();
    });
  }
  // One ~10s polling window (extended from 6s), then up to two extra backoff rounds before giving up.
  function ensureReady() {
    var startTime = Date.now();
    var pollAttempts = 0;
    return pollReady(100).then(function (ok) {
      pollAttempts = Math.floor((Date.now() - startTime) / 100);
      if (ok) {
        console.log('[QCBridge] Ready after ' + pollAttempts + ' attempts (~' + Math.round((Date.now() - startTime) / 100) / 10 + 's)');
        return true;
      }
      var round = 0;
      function next() {
        if (round >= 2) {
          var err = new Error('Wallet bridge not ready after extended timeout');
          err.qcCode = 'BRIDGE_INIT_TIMEOUT';
          console.error('[QCBridge] BRIDGE_INIT_TIMEOUT after ' + (Date.now() - startTime) + 'ms, ' + pollAttempts + ' initial poll attempts');
          return false;
        }
        var attempt = round++;
        return sleep(backoff(attempt)).then(function () {
          return pollReady(20).then(function (r) { return r ? true : next(); });
        });
      }
      return next();
    });
  }
  function notReadyError() {
    var err = new Error('Wallet bridge not ready');
    err.qcCode = 'BRIDGE_UNREACHABLE';
    return tag(err, 'transient');
  }

  // ── call(fn, opts): readiness + classified retry ────────────────────────────
  // opts: { idempotent?: bool, attempts?: number, skipReady?: bool, isSend?: bool }
  async function call(fn, opts) {
    opts = opts || {};
    var maxAttempts = opts.attempts || C.MAX_ATTEMPTS || 3;
    var lastErr = null;
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      if (!opts.skipReady) {
        var ready = await ensureReady();
        if (!ready) {
          lastErr = notReadyError();
          if (attempt < maxAttempts - 1) { await sleep(backoff(attempt)); continue; }
          console.error('[QCBridge] All readiness attempts exhausted', lastErr);
          throw lastErr;
        }
      }
      try {
        var result = await invoke(fn, opts.isSend);
        if (attempt > 0) console.log('[QCBridge] Success on attempt ' + (attempt + 1));
        return result;
      } catch (err) {
        lastErr = err;
        var kind = classify(err);
        tag(err, kind);
        if (!err.qcCode) {
          if (kind === 'ambiguous') err.qcCode = 'BRIDGE_RELAY_TIMEOUT';
          else if (kind === 'transient') err.qcCode = 'BRIDGE_UNREACHABLE';
          else if (kind === 'terminal') err.qcCode = 'BRIDGE_REJECTED';
        }
        console.log('[QCBridge] Attempt ' + (attempt + 1) + '/' + maxAttempts + ' failed: kind=' + kind + ', code=' + err.qcCode + ', msg=' + (err.message || ''));
        var isRetryable = C.isRetryable ? C.isRetryable(kind, opts) : false;
        if (!isRetryable || attempt >= maxAttempts - 1) {
          console.error('[QCBridge] Non-retryable or exhausted: ' + err.qcCode, err);
          throw err;
        }
        var delay = backoff(attempt);
        console.log('[QCBridge] Retrying in ' + delay + 'ms...');
        await sleep(delay);
      }
    }
    throw tag(lastErr || new Error('Wallet bridge call failed'), 'unknown');
  }

  function extractTxId(res) {
    if (!res) return null;
    if (typeof res === 'string') return res;
    for (var i = 0, ks = ['txId', 'tx_id', 'id', 'txid', 'hash', 'tx_hash', 'txHash']; i < ks.length; i++) {
      if (typeof res[ks[i]] === 'string' && res[ks[i]].trim()) return res[ks[i]].trim();
    }
    var subs = [res.matchedTx, res.tx, res.transaction];
    for (var j = 0; j < subs.length; j++) { if (subs[j]) { var v = extractTxId(subs[j]); if (v) return v; } }
    return null;
  }

  // ── Public wrappers ─────────────────────────────────────────────────────────
  // Reading the wallet address is idempotent → safe to auto-retry.
  function getAddress() {
    return call(function () { return window.getNodeAddress(); }, { idempotent: true });
  }
  // send(): opts.sender lets local-dev inject the mock without touching the real
  // bridge (and skips readiness, since the mock is always present). opts.idempotent
  // is OFF by default — only latest-wins ops (e.g. result re-submission) set it.
  function send(to, amount, memo, opts) {
    opts = opts || {};
    var sender = opts.sender;
    var fn = sender
      ? function () { return sender(to, amount || 0, memo); }
      : function () { return window.sendTransaction(to, amount || 0, memo); };
    return call(fn, { idempotent: opts.idempotent === true, skipReady: !!sender, isSend: true }).then(extractTxId);
  }

  window.QCBridge = {
    ensureReady: ensureReady,
    call: call,
    getAddress: getAddress,
    send: send,
    extractTxId: extractTxId,
    setFault: setFault,
    classify: classify,
    // Boolean compat shim for any caller still expecting the old bridgeReady().
    bridgeReady: function () { return ensureReady(); },
  };

  // ── QCNotice: non-blocking, dismissible notice with an optional action ───────
  // Renders above (not replacing) the platform's own red relay banner.
  var noticeEl = null;
  function buildNotice() {
    if (noticeEl) return noticeEl;
    noticeEl = document.createElement('div');
    noticeEl.id = 'qc-notice';
    noticeEl.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);bottom:5.5rem;z-index:60;max-width:24rem;width:calc(100% - 2rem);' +
      'display:none;align-items:center;gap:.6rem;padding:.7rem .85rem;border-radius:.7rem;' +
      'font-family:system-ui;font-size:.82rem;line-height:1.25;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    var msg = document.createElement('span');
    msg.id = 'qc-notice-msg'; msg.style.cssText = 'flex:1';
    var action = document.createElement('button');
    action.id = 'qc-notice-action';
    action.style.cssText = 'flex:none;font-weight:600;padding:.3rem .6rem;border-radius:.5rem;border:0;cursor:pointer;background:#4f46e5;color:#fff';
    var close = document.createElement('button');
    close.id = 'qc-notice-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.style.cssText = 'flex:none;font-size:1.1rem;line-height:1;background:transparent;border:0;cursor:pointer;opacity:.6;color:inherit';
    close.onclick = function () { hideNotice(); };
    noticeEl.appendChild(msg); noticeEl.appendChild(action); noticeEl.appendChild(close);
    document.body.appendChild(noticeEl);
    return noticeEl;
  }
  function themeNotice(e) {
    var dark = document.documentElement.classList.contains('dark');
    e.style.background = dark ? '#1e293b' : '#ffffff';
    e.style.color = dark ? '#e2e8f0' : '#0f172a';
    e.style.border = '1px solid ' + (dark ? '#334155' : '#e2e8f0');
  }
  function showNotice(opts) {
    opts = opts || {};
    var e = buildNotice();
    themeNotice(e);
    e.querySelector('#qc-notice-msg').textContent = opts.message || '';
    var action = e.querySelector('#qc-notice-action');
    if (opts.actionLabel && typeof opts.onAction === 'function') {
      action.textContent = opts.actionLabel;
      action.style.display = '';
      action.onclick = function () { hideNotice(); opts.onAction(); };
    } else {
      action.style.display = 'none';
      action.onclick = null;
    }
    e.style.display = 'flex';
  }
  function hideNotice() { if (noticeEl) noticeEl.style.display = 'none'; }

  window.QCNotice = { show: showNotice, hide: hideNotice };
})();
