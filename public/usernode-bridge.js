// Quick Count — local-dev wallet shim.
//
// NOTE: this is NOT a vendored copy of the platform's hosted bridge. Inside
// Usernode the app loads the canonical bridge from
//   https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js
// (see index.html). This file only provides a *mock* wallet for --local-dev,
// so the whole app can be exercised offline against the /__mock/* endpoints.
//
// It is activated EXPLICITLY by the app (QCMock.activate()) only when the server
// reports localDev === true. Activation installs window.getNodeAddress /
// window.sendTransaction / window.usernode.username so the bridge resilience
// layer (window.QCBridge) is the SINGLE identity + transaction entry point in
// every mode — the mock is just its backend in local-dev. We never install
// those globals at parse time, so this file is inert (cannot shadow the hosted
// bridge) when loaded in staging / production.
(function () {
  function randHex(n) {
    var hex = '';
    var chars = '0123456789abcdef';
    for (var i = 0; i < n; i++) hex += chars[Math.floor(Math.random() * 16)];
    return hex;
  }
  function randAddr() { return 'ut1' + randHex(39); }

  var KEY = 'qc_mock_persona';
  var FRESH = 'qc_mock_fresh_addr';
  var FRESH_USER = 'qc_mock_fresh_user';

  var QCMock = {
    personas: [],
    init: function (personas) {
      this.personas = Array.isArray(personas) ? personas : [];
      // Default persona = first one, unless a prior choice is stored.
      if (!localStorage.getItem(KEY) && this.personas.length) {
        localStorage.setItem(KEY, '0');
      }
    },
    currentIndex: function () {
      var i = parseInt(localStorage.getItem(KEY) || '0', 10);
      return isNaN(i) ? 0 : i;
    },
    setPersona: function (i) {
      localStorage.setItem(KEY, String(i));
      // Switching to "fresh wallet" mints a new address + username each time.
      var p = this.personas[i];
      if (p && p.addr == null) {
        localStorage.setItem(FRESH, randAddr());
        localStorage.setItem(FRESH_USER, 'staging_demo_' + randHex(4));
      }
      this._syncUsernode();
    },
    address: function () {
      var p = this.personas[this.currentIndex()];
      if (!p) return localStorage.getItem(FRESH) || (function () { var a = randAddr(); localStorage.setItem(FRESH, a); return a; })();
      if (p.addr) return p.addr;
      var f = localStorage.getItem(FRESH);
      if (!f) { f = randAddr(); localStorage.setItem(FRESH, f); }
      return f;
    },
    // Simulated Usernode Username for the active persona — the bridge-supplied
    // identity the app reads when no verified server session is present offline.
    username: function () {
      var p = this.personas[this.currentIndex()];
      if (p && p.username) return p.username;
      var u = localStorage.getItem(FRESH_USER);
      if (!u) { u = 'staging_demo_' + randHex(4); localStorage.setItem(FRESH_USER, u); }
      return u;
    },
    _syncUsernode: function () {
      window.usernode = window.usernode || {};
      try { window.usernode.username = this.username(); } catch (e) { /* ignore */ }
    },
    send: function (to, amount, memo) {
      return fetch('/__mock/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.address(), to: to, amount: amount || 0, memo: memo }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) throw new Error(j.error);
        return j.txId;
      });
    },
    // Install the window-level bridge functions the resilience layer expects, so
    // QCBridge.getAddress()/send() drive the mock exactly like the hosted bridge.
    // Called only from the local-dev boot path.
    activate: function () {
      var self = this;
      window.getNodeAddress = function () { return self.address(); };
      window.sendTransaction = function (to, amount, memo) { return self.send(to, amount, memo); };
      this._syncUsernode();
    },
  };

  window.QCMock = QCMock;
})();
