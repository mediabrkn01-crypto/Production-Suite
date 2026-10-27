/* ============================================================================
   BETheme — Light / Dark theme for every ERP page. Tokens live in be-theme.css.

   Load in <head> as a plain (non-deferred) script BEFORE the page's stylesheets render, so the
   saved theme is on <html data-theme> before first paint — no flash of the wrong theme:
       <script src="be-theme.js"></script>  <link rel="stylesheet" href="be-theme.css">

   • Preference: localStorage 'be-theme' = 'light' | 'dark' (a per-device UI preference — no
     backend). No saved choice → dark, the ERP's original look. Other open tabs follow a change.
   • BETheme.get() / .set('light'|'dark') / .toggle()
   • BETheme.onChange(fn(theme))        also fires the 'be-theme-change' window event
   • BETheme.color('--be-chart-grid')   current value of a token (canvas charts)
   • BETheme.toggle element: BETheme.mount(parent, { before, className }) or any
     <span data-be-theme-toggle></span> in the markup (mounted on DOMContentLoaded).
   ============================================================================ */
(function () {
  'use strict';
  if (window.BETheme) return;
  var KEY = 'be-theme', root = document.documentElement, subs = [], uid = 0;
  var META = { dark: '#0b0d19', light: '#f6f7fb' };

  function saved() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch (_) { return null; } }
  function current() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

  function paint(t) {
    root.setAttribute('data-theme', t);
    // light only: dark keeps the browser default the ERP was built on (native controls unchanged)
    root.style.colorScheme = t === 'light' ? 'light' : '';
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', META[t]);
  }
  paint(saved() || 'dark');

  function apply(t, opts) {
    t = t === 'light' ? 'light' : 'dark';
    if (t === current()) return syncToggles(t);
    if (!(opts && opts.instant)) {
      root.classList.add('be-theming');
      clearTimeout(apply._t);
      apply._t = setTimeout(function () { root.classList.remove('be-theming'); }, 380);
    }
    paint(t);
    syncToggles(t);
    subs.forEach(function (fn) { try { fn(t); } catch (e) { console.warn('[BETheme]', e); } });
    try { window.dispatchEvent(new CustomEvent('be-theme-change', { detail: { theme: t } })); } catch (_) {}
  }

  function set(t) {
    t = t === 'light' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, t); } catch (_) {}
    apply(t);
  }

  function syncToggles(t) {
    var light = t === 'light';
    document.querySelectorAll('.be-tt').forEach(function (el) {
      var cb = el.querySelector('.themeToggleInput');
      if (cb && cb.checked !== light) cb.checked = light;
      label(el, light);
    });
  }
  function label(el, light) {
    var txt = light ? 'Switch to dark theme' : 'Switch to light theme';
    el.title = txt;
    var cb = el.querySelector('.themeToggleInput');
    if (cb) { cb.setAttribute('aria-label', 'Light theme'); cb.setAttribute('aria-checked', light ? 'true' : 'false'); }
  }

  // The supplied sun/moon toggle (Uiverse.io, Type-Delta). Each instance gets its own mask id.
  function build(className) {
    var id = 'be-moon-mask-' + (++uid), light = current() === 'light';
    var el = document.createElement('label');
    el.className = 'be-tt be-tt-still' + (className ? ' ' + className : '');
    el.innerHTML =
      '<span class="themeToggle st-sunMoonThemeToggleBtn">' +
        '<input type="checkbox" class="themeToggleInput" role="switch"' + (light ? ' checked' : '') + '>' +
        '<svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" stroke="none" aria-hidden="true">' +
          '<mask id="' + id + '"><rect x="0" y="0" width="20" height="20" fill="white"></rect><circle cx="11" cy="3" r="8" fill="black"></circle></mask>' +
          '<circle class="sunMoon" cx="10" cy="10" r="8" mask="url(#' + id + ')"></circle>' +
          '<g>' +
            '<circle class="sunRay sunRay1" cx="18" cy="10" r="1.5"></circle>' +
            '<circle class="sunRay sunRay2" cx="14" cy="16.928" r="1.5"></circle>' +
            '<circle class="sunRay sunRay3" cx="6" cy="16.928" r="1.5"></circle>' +
            '<circle class="sunRay sunRay4" cx="2" cy="10" r="1.5"></circle>' +
            '<circle class="sunRay sunRay5" cx="6" cy="3.1718" r="1.5"></circle>' +
            '<circle class="sunRay sunRay6" cx="14" cy="3.1718" r="1.5"></circle>' +
          '</g>' +
        '</svg>' +
      '</span>';
    label(el, light);
    var cb = el.querySelector('.themeToggleInput');
    cb.addEventListener('change', function () { el.classList.remove('be-tt-still'); set(cb.checked ? 'light' : 'dark'); });
    // Enter also toggles (Space already does on a checkbox)
    cb.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); cb.click(); } });
    el.addEventListener('click', function (e) { e.stopPropagation(); });
    return el;
  }

  function mount(parent, opts) {
    opts = opts || {};
    if (typeof parent === 'string') parent = document.querySelector(parent);
    if (!parent) return null;
    var el = build(opts.className);
    if (opts.before && opts.before.parentNode === parent) parent.insertBefore(el, opts.before);
    else if (opts.replace) parent.replaceWith(el);
    else parent.appendChild(el);
    return el;
  }

  function mountPlaceholders() {
    document.querySelectorAll('[data-be-theme-toggle]').forEach(function (ph) {
      mount(ph, { replace: true, className: ph.getAttribute('data-be-theme-toggle') || '' });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPlaceholders);
  else mountPlaceholders();

  // Another tab changed the theme
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(saved() || 'dark'); });

  window.BETheme = {
    get: current,
    set: set,
    toggle: function () { set(current() === 'light' ? 'dark' : 'light'); },
    onChange: function (fn) { if (typeof fn === 'function') subs.push(fn); },
    color: function (name, fallback) {
      var v = getComputedStyle(root).getPropertyValue(name).trim();
      return v || fallback || '';
    },
    mount: mount
  };
})();
