/* Global Digits — shared theme controller.
   Load this FIRST inside <head> (blocking, no defer) on every page so the
   saved theme is applied before the first paint. Default theme: dark.
   API: GDTheme.get() -> 'dark'|'light', GDTheme.set('dark'|'light'),
        GDTheme.toggle(). Fires a 'gd:themechange' event on window. */
(function () {
  var KEY = 'gd_ui_theme';
  var root = document.documentElement;
  var COLORS = { dark: '#000000', light: '#ffffff' };

  function read() {
    var t = null;
    try { t = localStorage.getItem(KEY); } catch (e) {}
    return t === 'light' ? 'light' : 'dark';
  }

  function syncMeta(t) {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    if (!metas.length && document.head) {
      var m = document.createElement('meta');
      m.name = 'theme-color';
      document.head.appendChild(m);
      metas = [m];
    }
    for (var i = 0; i < metas.length; i++) {
      metas[i].removeAttribute('media');
      metas[i].setAttribute('content', COLORS[t]);
    }
  }

  var LOGO_RE = /(^|\/)logo(-dark)?\.png(\?.*)?$/;
  function swapLogos(t, scope) {
    var imgs = (scope || document).querySelectorAll ? (scope || document).querySelectorAll('img') : [];
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute('src') || '';
      if (!LOGO_RE.test(src)) continue;
      var want = src.replace(LOGO_RE, '$1' + (t === 'light' ? 'logo-dark.png' : 'logo.png') + '$3');
      if (want !== src) imgs[i].setAttribute('src', want);
    }
  }

  function apply(t) {
    root.setAttribute('data-gd-theme', t);
    if (document.body) swapLogos(t);
    root.style.colorScheme = t;
    root.style.backgroundColor = COLORS[t];
    syncMeta(t);
  }

  var current = read();
  apply(current);

  window.GDTheme = {
    get: function () { return current; },
    set: function (t) {
      t = t === 'light' ? 'light' : 'dark';
      current = t;
      try { localStorage.setItem(KEY, t); } catch (e) {}
      apply(t);
      try { window.dispatchEvent(new CustomEvent('gd:themechange', { detail: { theme: t } })); } catch (e) {}
    },
    toggle: function () { this.set(current === 'dark' ? 'light' : 'dark'); }
  };

  // Keep other open tabs/pages in sync.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) { current = read(); apply(current); }
  });
  // Restored from back/forward cache: re-read in case it changed elsewhere.
  window.addEventListener('pageshow', function () {
    var t = read();
    if (t !== current) { current = t; apply(t); }
  });
  document.addEventListener('DOMContentLoaded', function () {
    syncMeta(current);
    swapLogos(current);
    // Logos inserted later by page scripts (loaders, receipts, headers).
    if (window.MutationObserver) {
      new MutationObserver(function (list) {
        if (current !== 'light') return;
        for (var i = 0; i < list.length; i++) {
          var n = list[i].target;
          if (n.nodeType === 1) swapLogos(current, n.parentNode || n);
        }
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }
  });
})();
