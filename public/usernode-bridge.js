// Quick Count — local-dev wallet shim.
//
// NOTE: this is NOT a vendored copy of the platform's hosted bridge. Inside
// Usernode the app loads the canonical bridge from
//   https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js
// (see index.html). This file only provides a *mock* wallet for --local-dev,
// so the whole app can be exercised offline against the /__mock/* endpoints.
// It self-activates only when the server reports localDev === true.
(function () {
  function randAddr() {
    var hex = '';
    var chars = '0123456789abcdef';
    for (var i = 0; i < 39; i++) hex += chars[Math.floor(Math.random() * 16)];
    return 'ut1' + hex;
  }

  var KEY = 'qc_mock_persona';
  var FRESH = 'qc_mock_fresh_addr';

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
      // Switching to "fresh wallet" mints a new address each time it's chosen.
      var p = this.personas[i];
      if (p && p.addr == null) localStorage.setItem(FRESH, randAddr());
    },
    address: function () {
      var p = this.personas[this.currentIndex()];
      if (!p) return localStorage.getItem(FRESH) || (function () { var a = randAddr(); localStorage.setItem(FRESH, a); return a; })();
      if (p.addr) return p.addr;
      var f = localStorage.getItem(FRESH);
      if (!f) { f = randAddr(); localStorage.setItem(FRESH, f); }
      return f;
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
  };

  window.QCMock = QCMock;
})();
