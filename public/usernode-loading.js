// Quick Count — tiny loading-overlay helper (vendored-style).
(function () {
  var el = null;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'qc-loading';
    el.style.cssText = 'position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;backdrop-filter:blur(2px)';
    el.innerHTML = '<div id="qc-loading-inner" style="display:flex;flex-direction:column;align-items:center;gap:.75rem;font-family:system-ui">'
      + '<div id="qc-loading-spinner" style="width:2rem;height:2rem;border:3px solid;border-radius:50%;animation:qcspin 0.8s linear infinite"></div>'
      + '<div id="qc-loading-msg" style="font-size:.85rem"></div></div>';
    var style = document.createElement('style');
    style.textContent = '@keyframes qcspin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    document.body.appendChild(el);
    return el;
  }
  function applyTheme(e) {
    var dark = document.documentElement.classList.contains('dark');
    e.style.background = dark ? 'rgba(9,9,11,0.7)' : 'rgba(255,255,255,0.7)';
    var inner = e.querySelector('#qc-loading-inner');
    if (inner) inner.style.color = dark ? '#e4e4e7' : '#18181b';
    var spinner = e.querySelector('#qc-loading-spinner');
    if (spinner) { spinner.style.borderColor = dark ? '#3f3f46' : '#d4d4d8'; spinner.style.borderTopColor = '#8b5cf6'; }
    var msg = e.querySelector('#qc-loading-msg');
    if (msg) msg.style.color = dark ? '#a1a1aa' : '#52525b';
  }
  window.QCLoading = {
    show: function (msg) { var e = ensure(); applyTheme(e); e.querySelector('#qc-loading-msg').textContent = msg || 'Working…'; e.style.display = 'flex'; },
    hide: function () { if (el) el.style.display = 'none'; },
  };
})();
