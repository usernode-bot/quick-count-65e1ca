// Quick Count — minimal username/address helper (vendored-style).
//
// Resolves a wallet address to a friendly label. If the hosted bridge exposes a
// username lookup it is used; otherwise we fall back to a shortened address and
// any known demo labels. Kept intentionally small.
(function () {
  var DEMO = {
    'ut1democitizenscount0000000000000000000000': 'Citizens Count (org)',
    'ut1demounpaidorg000000000000000000000000000': 'Unpaid Org',
    'ut1demoobserverone000000000000000000000000': 'Observer One',
    'ut1demoobservertwo000000000000000000000000': 'Observer Two',
    'ut1demoobserverthree00000000000000000000000': 'Observer Three',
  };
  function shortAddr(addr) {
    if (!addr) return '—';
    var s = String(addr);
    if (s.length <= 14) return s;
    return s.slice(0, 8) + '…' + s.slice(-4);
  }
  window.QCNames = {
    short: shortAddr,
    label: function (addr) {
      if (!addr) return '—';
      if (DEMO[addr]) return DEMO[addr];
      try {
        if (window.usernode && typeof window.usernode.usernameFor === 'function') {
          var u = window.usernode.usernameFor(addr);
          if (u) return u;
        }
      } catch (e) { /* ignore */ }
      return shortAddr(addr);
    },
  };
})();
