// Quick Count — tiny loading-overlay helper (vendored-style).
(function () {
  var el = null;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'qc-loading';
    el.style.cssText = 'position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(9,9,11,0.7);backdrop-filter:blur(2px)';
    el.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:.75rem;color:#e4e4e7;font-family:system-ui">'
      + '<div style="width:2rem;height:2rem;border:3px solid #3f3f46;border-top-color:#8b5cf6;border-radius:50%;animation:qcspin 0.8s linear infinite"></div>'
      + '<div id="qc-loading-msg" style="font-size:.85rem;color:#a1a1aa"></div></div>';
    var style = document.createElement('style');
    style.textContent = '@keyframes qcspin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    document.body.appendChild(el);
    return el;
  }
  window.QCLoading = {
    show: function (msg) { var e = ensure(); e.querySelector('#qc-loading-msg').textContent = msg || 'Working…'; e.style.display = 'flex'; },
    hide: function () { if (el) el.style.display = 'none'; },
  };
})();
