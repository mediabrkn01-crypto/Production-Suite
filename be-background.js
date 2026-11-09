/* ============================================================================
   BEBackground — personal ERP background (Settings → Appearance → Background Customization).

   Each employee chooses, per theme, Pure Black (#000000), Pure White (#FFFFFF) or their own
   image, with fit / position / blur / overlay. Defaults: dark = Pure Black, light = Pure White
   (the Liquid Glass canvas, be-glass.css --canvas).

   Rendering: one fixed layer (#be-bg-layer: image + readability overlay) behind the whole app at
   z-index -1, under the existing Liquid Glass surfaces (be-glass.css) so every translucent card,
   sidebar, menu and dialog blurs the image. Pure colours set --canvas on <html> exactly.
   No page carries its own background image.

   Storage: the `user-settings` edge function (x-erp-session → my employee id only) keeps the
   preferences in public.erp_user_settings and the images in the PRIVATE erp-backgrounds bucket
   (signed URLs only). localStorage keeps a small per-account cache (preferences + the signed URL,
   never image data) so the saved background paints before the server answers.

   Load in <head> right after be-theme.js:  <script src="be-background.js"></script>
   API: BEBackground.openSettings() · .menuRow() (account menu) · .refresh() · .current()
   ============================================================================ */
(function () {
  'use strict';
  if (window.BEBackground) return;
  var root = document.documentElement;
  var MAX = 8 * 1024 * 1024;
  var TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  var FITS = [['cover', 'Cover', 'Fills the screen, may crop edges'], ['contain', 'Contain', 'Whole image, plain colour around it'], ['auto', 'Actual size', 'Original pixels, no scaling'], ['tile', 'Tile', 'Repeats the image']];
  var POS = ['top left', 'top', 'top right', 'left', 'center', 'right', 'bottom left', 'bottom', 'bottom right'];
  var PURE = { black: '#000000', white: '#FFFFFF' };
  var CACHE = 'be_bg_cache:';

  // ── preferences ───────────────────────────────────────────────────────────
  function defPref(theme) { return { mode: theme === 'light' ? 'white' : 'black', fit: 'cover', pos: 'center', blur: 0, overlay: 25 }; }
  function defBg() { return { same: false, dark: defPref('dark'), light: defPref('light') }; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function norm(bg) {
    var d = defBg(); bg = bg && typeof bg === 'object' ? bg : {};
    ['dark', 'light'].forEach(function (t) { var p = bg[t] || {}; d[t] = Object.assign(defPref(t), p); });
    d.same = !!bg.same; if (d.same) d.light = Object.assign({}, d.dark);
    return d;
  }
  function email() {
    try { if (window.BESession && BESession.currentEmail) return BESession.currentEmail(); } catch (_) {}
    try { return String(localStorage.getItem('be_active_email') || '').trim().toLowerCase(); } catch (_) { return ''; }
  }
  function readCache(e) { try { var c = JSON.parse(localStorage.getItem(CACHE + e) || 'null'); return c && c.bg ? c : null; } catch (_) { return null; } }
  function writeCache(e, bg, urls) { try { localStorage.setItem(CACHE + e, JSON.stringify({ bg: bg, urls: urls || {}, exp: Date.now() + 20 * 3600e3 })); } catch (_) {} }

  var S = { email: '', saved: defBg(), urls: {}, draft: null, local: {}, failed: {}, retried: {}, setup: true };
  function load() {
    S.email = email();
    var c = S.email ? readCache(S.email) : null;
    S.saved = c ? norm(c.bg) : defBg();
    S.urls = c && c.exp > Date.now() ? (c.urls || {}) : {};
  }
  function theme() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function active() { var b = S.draft || S.saved; return b[theme()] || defPref(theme()); }
  function urlFor(path) { return path ? (S.local[path] || S.urls[path] || '') : ''; }

  // ── rendering ─────────────────────────────────────────────────────────────
  var CSS = [
    '#be-bg-layer{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;display:none;contain:strict}',
    '#be-bg-layer.on{display:block}',
    // the theme fade (be-theme.css html.be-theming *) must not cross-fade the overlay through the other theme's colour
    'html #be-bg-layer,html #be-bg-layer *{transition:none!important}',
    '#be-bg-layer .bbg-img,.bbs-pv .bbg-img{position:absolute;inset:0;background-repeat:no-repeat;will-change:transform}',
    '#be-bg-layer .bbg-ov,.bbs-pv .bbg-ov{position:absolute;inset:0}',
    // the image shows through the glass: page wrappers stay transparent (be-glass.css) and the
    // canvas underneath is the theme base, so Contain / Actual size frame the image cleanly
    'html.be-bg-image body{background:transparent!important}'
  ].join('\n');
  function styleOnce() {
    if (document.getElementById('be-bg-css')) return;
    var s = document.createElement('style'); s.id = 'be-bg-css'; s.textContent = CSS + '\n' + SHEET_CSS;
    (document.head || root).appendChild(s);
  }
  function layer() {
    var l = document.getElementById('be-bg-layer');
    if (!l && document.body) {
      l = document.createElement('div'); l.id = 'be-bg-layer'; l.className = 'lg-skip'; l.setAttribute('aria-hidden', 'true');
      l.innerHTML = '<div class="bbg-img"></div><div class="bbg-ov"></div>';
      document.body.insertBefore(l, document.body.firstChild);
    }
    return l;
  }
  /** Paint one preference onto an image + overlay pair (the live layer or the preview). */
  function paintInto(img, ov, p, t, url) {
    var tile = p.fit === 'tile';
    img.style.backgroundImage = url ? 'url("' + url.replace(/"/g, '%22') + '")' : 'none';
    img.style.backgroundSize = tile || p.fit === 'auto' ? 'auto' : p.fit;
    img.style.backgroundRepeat = tile ? 'repeat' : 'no-repeat';
    img.style.backgroundPosition = p.pos || 'center';
    var blur = +p.blur || 0, sc = img.getAttribute('data-scale') ? +img.getAttribute('data-scale') : 1;
    img.style.filter = blur ? 'blur(' + (blur * sc).toFixed(1) + 'px)' : 'none';
    img.style.transform = blur ? 'scale(1.06)' : 'none';   // blurred edges never show the canvas
    ov.style.background = (t === 'light' ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + ((+p.overlay || 0) / 100) + ')';
  }
  var loadSeq = 0;
  function paint() {
    var t = theme(), p = active();
    var base = t === 'light' ? PURE.white : PURE.black;
    var canvas = p.mode === 'image' ? base : (PURE[p.mode] || base);
    root.style.setProperty('--canvas', canvas);
    var l = layer();
    if (p.mode !== 'image' || !p.path) { root.classList.remove('be-bg-image'); if (l) l.classList.remove('on'); return; }
    var url = urlFor(p.path);
    if (!url || S.failed[p.path]) { root.classList.remove('be-bg-image'); if (l) l.classList.remove('on'); if (!url) refresh(); return; }
    if (!l) return;   // body not parsed yet — DOMContentLoaded paints again
    var seq = ++loadSeq, im = new Image();
    im.onload = function () {
      if (seq !== loadSeq) return;
      paintInto(l.firstChild, l.lastChild, p, t, url);
      root.classList.add('be-bg-image'); l.classList.add('on');
    };
    im.onerror = function () {
      if (seq !== loadSeq) return;
      // an expired signed URL: ask once for fresh ones; a broken file: stay on the plain canvas
      if (!S.local[p.path] && !S.retried[p.path]) { S.retried[p.path] = 1; S.urls = {}; refresh(); return; }
      S.failed[p.path] = 1; root.classList.remove('be-bg-image'); l.classList.remove('on');
    };
    im.src = url;
  }

  // ── server ────────────────────────────────────────────────────────────────
  function B() { return window.BESession || {}; }
  async function api(action, body) {
    var tk = B().ensure ? await B().ensure() : null;
    if (!tk) throw Object.assign(new Error('Your session has expired. Please sign in again.'), { code: 'NO_SESSION' });
    var r = await fetch(B().url + '/functions/v1/user-settings', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': B().anonKey, 'Authorization': 'Bearer ' + B().anonKey, 'x-erp-session': tk },
      body: JSON.stringify(Object.assign({ action: action }, body || {})) });
    var j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && !(body && body._retry) && B().clear && j.code === 'SESSION_EXPIRED') {
      try { B().clear(B().currentEmail()); } catch (_) {}
      if (await B().ensure()) return api(action, Object.assign({}, body || {}, { _retry: true }));
    }
    if (!r.ok) throw Object.assign(new Error(j.error || 'Settings are unavailable right now.'), { code: j.code, status: r.status });
    return j;
  }
  var refreshing = null;
  function refresh() {
    if (refreshing || !email() || !(window.BESession && BESession.ensure)) return refreshing;
    var e = email();
    refreshing = api('get').then(function (j) {
      S.setup = true;
      if (e !== email()) return;
      S.saved = norm(j.background); S.urls = j.urls || {}; S.failed = {};
      writeCache(e, S.saved, S.urls); paint();
    }).catch(function (err) { if (err && err.code === 'SETUP_PENDING') S.setup = false; })
      .then(function () { refreshing = null; });
    return refreshing;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Settings sheet — Settings → Appearance → Background Customization
  // ════════════════════════════════════════════════════════════════════════
  var SHEET_CSS = [
    '.bbs-scrim{position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.5)}',
    '.bbs{width:min(980px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;border-radius:20px;overflow:hidden;color:var(--tx-1,#e6e9f5);font:500 13px/1.45 Inter,system-ui,sans-serif;border:1px solid var(--lg-border,rgba(255,255,255,.11));background:var(--lg-dialog,rgba(4,4,4,.86));backdrop-filter:blur(34px) saturate(140%);-webkit-backdrop-filter:blur(34px) saturate(140%);box-shadow:var(--lg-shadow-3,0 32px 80px rgba(0,0,0,.75)),var(--lg-rim-strong,inset 0 1px 0 rgba(255,255,255,.2))}',
    '.bbs-h{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--lg-border,rgba(255,255,255,.1))}',
    '.bbs-h h2{margin:0;font-size:17px;font-weight:800;color:var(--tx-0,#fff)}.bbs-crumb{font-size:12px;color:var(--tx-5,#808a9d)}',
    '.bbs-x{margin-left:auto;width:34px;height:34px;border-radius:10px;border:1px solid var(--lg-border,rgba(255,255,255,.11));background:transparent;color:inherit;cursor:pointer;display:grid;place-items:center}',
    '.bbs-body{display:grid;grid-template-columns:180px 1fr;min-height:0;flex:1}',
    '.bbs-nav{padding:14px 10px;border-right:1px solid var(--lg-border,rgba(255,255,255,.1));display:flex;flex-direction:column;gap:4px}',
    '.bbs-nav button{display:flex;align-items:center;gap:9px;text-align:left;padding:9px 11px;border-radius:10px;border:0;background:transparent;color:var(--tx-4,#8b93b8);font:600 13px Inter,system-ui,sans-serif;cursor:pointer}',
    '.bbs-nav button.on{background:var(--lg-pill,rgba(255,255,255,.12));color:var(--tx-0,#fff)}',
    '.bbs-main{overflow-y:auto;padding:18px 22px 22px;display:flex;flex-direction:column;gap:16px}',
    '.bbs-sec h3{margin:0 0 2px;font-size:15px;font-weight:800;color:var(--tx-0,#fff)}.bbs-sec>p{margin:0 0 12px;color:var(--tx-5,#808a9d);font-size:12.5px}',
    '.bbs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.bbs-lbl{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--tx-5,#808a9d);margin:0 0 7px}',
    '.bbs-seg{display:inline-flex;padding:3px;border-radius:12px;background:var(--lg-track,rgba(0,0,0,.6));box-shadow:var(--lg-track-rim,none);gap:2px;flex-wrap:wrap}',
    '.bbs-seg button{border:0;background:transparent;color:var(--tx-4,#8b93b8);font:700 12.5px Inter,system-ui,sans-serif;padding:7px 13px;border-radius:9px;cursor:pointer}',
    '.bbs-seg button.on{background:var(--lg-pill,rgba(255,255,255,.12));color:var(--tx-0,#fff);box-shadow:var(--lg-ctl-rim,none)}',
    '.bbs-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:18px;align-items:start}',
    '.bbs-opts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
    '.bbs-opt{position:relative;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:14px;border:1.5px solid var(--lg-border,rgba(255,255,255,.12));background:var(--lg-ctl,rgba(255,255,255,.035));color:inherit;cursor:pointer;text-align:left;font:inherit}',
    '.bbs-opt.on{border-color:#ff6b06;box-shadow:0 0 0 3px rgba(255,107,6,.18)}',
    '.bbs-opt i{display:block;height:46px;border-radius:9px;border:1px solid rgba(128,128,128,.35);background-size:cover;background-position:center}',
    '.bbs-opt b{font-size:12.5px;color:var(--tx-0,#fff)}.bbs-opt small{font-size:11px;color:var(--tx-5,#808a9d);font-variant-numeric:tabular-nums}',
    '.bbs-drop{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:14px;border:1.5px dashed var(--lg-border-strong,rgba(255,255,255,.2))}',
    '.bbs-drop.drag{border-color:#ff8a3d;background:rgba(255,107,6,.07)}',
    '.bbs-drop small{color:var(--tx-5,#808a9d);font-size:11.5px}',
    '.bbs-thumb{display:flex;align-items:center;gap:12px}.bbs-thumb i{width:84px;height:52px;border-radius:9px;background:center/cover no-repeat;border:1px solid rgba(128,128,128,.35);flex:none}',
    '.bbs-thumb span{min-width:0;display:flex;flex-direction:column;gap:2px}.bbs-thumb b{font-size:12.5px;color:var(--tx-0,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bbs-bar{height:5px;border-radius:9px;background:rgba(128,128,128,.25);overflow:hidden}.bbs-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff6b06,#f9182f);transition:width .15s}',
    '.bbs-err{color:var(--fg-red,#f87171);font-size:12px;font-weight:600}.bbs-warn{color:var(--fg-amber,#fbbf24);font-size:12px;font-weight:600}.bbs-note{color:var(--tx-5,#808a9d);font-size:12px}',
    '.bbs-btn{height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--lg-ctl-border,rgba(255,255,255,.14));background:var(--lg-ctl,rgba(255,255,255,.035));color:var(--tx-1,#e6e9f5);font:700 12.5px Inter,system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:7px}',
    '.bbs-btn:hover:not(:disabled){background:var(--lg-ctl-hover,rgba(255,255,255,.07))}.bbs-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.bbs-btn.pri{border-color:transparent;background:linear-gradient(135deg,#ff6b06,#f9182f);color:#fff}.bbs-btn.danger{color:var(--fg-red,#f87171)}',
    '.bbs-btn:focus-visible,.bbs-opt:focus-visible,.bbs-seg button:focus-visible,.bbs-pos button:focus-visible{outline:2px solid rgba(255,107,6,.6);outline-offset:2px}',
    '.bbs-pos{display:grid;grid-template-columns:repeat(3,30px);gap:4px}.bbs-pos button{width:30px;height:24px;border-radius:7px;border:1px solid var(--lg-border,rgba(255,255,255,.12));background:var(--lg-ctl,rgba(255,255,255,.035));cursor:pointer;display:grid;place-items:center;padding:0}',
    '.bbs-pos button i{width:6px;height:6px;border-radius:50%;background:var(--tx-6,#6b74a0)}.bbs-pos button.on{border-color:#ff6b06}.bbs-pos button.on i{background:#ff6b06}',
    '.bbs-range{display:flex;align-items:center;gap:10px}.bbs-range input{flex:1;accent-color:#ff6b06}.bbs-range output{min-width:44px;text-align:right;font-variant-numeric:tabular-nums;color:var(--tx-2,#cbd5e1);font-weight:700}',
    '.bbs-pv{position:relative;aspect-ratio:16/10;border-radius:14px;overflow:hidden;border:1px solid var(--lg-border,rgba(255,255,255,.12));isolation:isolate}',
    '.bbs-pv .pv-ui{position:absolute;inset:0;display:grid;grid-template-columns:22% 1fr;gap:6px;padding:7px}',
    '.bbs-pv .pv-g{border-radius:8px;backdrop-filter:blur(10px) saturate(140%);-webkit-backdrop-filter:blur(10px) saturate(140%);box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}',
    '.bbs-pv[data-t=dark] .pv-g{background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12)}.bbs-pv[data-t=light] .pv-g{background:rgba(255,255,255,.55);border:1px solid rgba(0,0,0,.08)}',
    '.bbs-pv .pv-r{display:flex;flex-direction:column;gap:6px}.bbs-pv .pv-cards{flex:1;display:grid;grid-template-columns:repeat(3,1fr);gap:6px}',
    '.bbs-pv .pv-t{display:block;height:5px;border-radius:3px;margin:8px 8px 0;width:55%}.bbs-pv[data-t=dark] .pv-t{background:rgba(255,255,255,.75)}.bbs-pv[data-t=light] .pv-t{background:rgba(0,0,0,.7)}',
    '.bbs-pv .pv-t.s{width:35%;opacity:.5;height:4px}',
    '.bbs-pv .pv-cap{position:absolute;right:8px;bottom:7px;font-size:10px;font-weight:700;padding:2px 7px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff}',
    '.bbs-f{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 20px;border-top:1px solid var(--lg-border,rgba(255,255,255,.1))}.bbs-f .sp{flex:1}',
    '.bbs-chk{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;cursor:pointer}.bbs-chk input{accent-color:#ff6b06;width:16px;height:16px;margin:0}',
    '@media(max-width:760px){.bbs-scrim{padding:0;align-items:flex-end}.bbs{border-radius:18px 18px 0 0;max-height:94vh}.bbs-body{grid-template-columns:1fr}.bbs-nav{flex-direction:row;border-right:0;border-bottom:1px solid var(--lg-border,rgba(255,255,255,.1));padding:8px 12px}.bbs-grid{grid-template-columns:1fr}.bbs-main{padding:14px}.bbs-f{padding:10px 14px}.bbs-f .sp{display:none}.bbs-f .bbs-btn{flex:1 1 auto;justify-content:center}}',
    '@media(prefers-reduced-motion:reduce){.bbs-bar i{transition:none}}'
  ].join('\n');

  var sheet = null, E = {};   // E = editor state
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(k, m) { if (typeof window.showToast === 'function') { try { return window.showToast(k, m); } catch (_) {} } if (typeof window.hrShowToast === 'function') return window.hrShowToast(m, k); }
  function svg(d, s) { return '<svg width="' + (s || 15) + '" height="' + (s || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var IC = {
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    pal: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>',
    up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>', trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'
  };

  function menuRow() {
    return '<button class="am-item" data-am-action="settings">' + svg(IC.gear, 14) + ' Settings</button>';
  }

  function openSettings() {
    if (sheet) return;
    styleOnce();
    E = { draft: clone(S.saved), target: theme(), busy: false, err: '', warn: '', pct: -1, uploads: [], applied: false, name: '' };
    S.draft = null;
    sheet = document.createElement('div');
    sheet.className = 'bbs-scrim lg-skip';
    sheet.innerHTML = '<div class="bbs" role="dialog" aria-modal="true" aria-labelledby="bbs-title">'
      + '<div class="bbs-h">' + svg(IC.gear, 18) + '<div><h2 id="bbs-title">Settings</h2><div class="bbs-crumb">Appearance · Background Customization</div></div>'
      + '<button type="button" class="bbs-x" data-k="cancel" aria-label="Close settings">' + svg(IC.x, 16) + '</button></div>'
      + '<div class="bbs-body"><nav class="bbs-nav" aria-label="Settings sections"><button type="button" class="on" aria-current="page">' + svg(IC.pal, 15) + 'Appearance</button></nav>'
      + '<div class="bbs-main" data-main></div></div>'
      + '<div class="bbs-f"><button type="button" class="bbs-btn danger" data-k="reset">Reset to default</button><span class="sp"></span>'
      + '<button type="button" class="bbs-btn" data-k="cancel">Cancel</button><button type="button" class="bbs-btn" data-k="apply">Apply</button><button type="button" class="bbs-btn pri" data-k="save">Save</button></div>'
      + '<input type="file" data-file accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden></div>';
    document.body.appendChild(sheet);
    sheet.addEventListener('click', onClick);
    sheet.addEventListener('input', onInput);
    sheet.addEventListener('change', onChange);
    sheet.addEventListener('dragover', function (e) { var d = e.target.closest && e.target.closest('.bbs-drop'); if (d) { e.preventDefault(); d.classList.add('drag'); } });
    sheet.addEventListener('dragleave', function (e) { var d = e.target.closest && e.target.closest('.bbs-drop'); if (d) d.classList.remove('drag'); });
    sheet.addEventListener('drop', function (e) { var d = e.target.closest && e.target.closest('.bbs-drop'); if (d) { e.preventDefault(); d.classList.remove('drag'); if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); } });
    document.addEventListener('keydown', onKey, true);
    drawSheet();
    if (!S.setup) refresh();
    setTimeout(function () { var f = sheet && sheet.querySelector('.bbs-seg button.on'); if (f) f.focus(); }, 30);
  }
  function close() {
    if (!sheet) return;
    document.removeEventListener('keydown', onKey, true);
    sheet.remove(); sheet = null; S.draft = null; paint();
  }
  function onKey(e) { if (e.key === 'Escape' && sheet) { e.stopPropagation(); cancel(); } }

  function tp() { return E.draft[E.target]; }
  function pv() { return E.draft.same ? E.draft.dark : tp(); }
  function setP(k, v) { var p = pv(); p[k] = v; if (E.draft.same) E.draft.light = Object.assign({}, E.draft.dark); E.dirty = true; }

  function drawSheet() {
    if (!sheet) return;
    var main = sheet.querySelector('[data-main]'), p = pv(), t = E.draft.same ? theme() : E.target;
    var img = p.mode === 'image' && p.path ? urlFor(p.path) : '';
    var mismatch = (t === 'light' && p.mode === 'black') || (t === 'dark' && p.mode === 'white');
    main.innerHTML =
      '<section class="bbs-sec"><h3>Appearance</h3><p>Only you see these settings — they follow your account to every portal and device.</p>'
      + '<div class="bbs-lbl">Theme</div><div class="bbs-seg" role="group" aria-label="Theme"><button type="button" data-theme-set="light" class="' + (theme() === 'light' ? 'on' : '') + '" aria-pressed="' + (theme() === 'light') + '">Light mode</button><button type="button" data-theme-set="dark" class="' + (theme() === 'dark' ? 'on' : '') + '" aria-pressed="' + (theme() === 'dark') + '">Dark mode</button></div></section>'
      + '<section class="bbs-sec"><h3>Background Customization</h3><p>Shown behind the Liquid Glass interface. Pure Black and Pure White are the defaults.</p>'
      + '<div class="bbs-row" style="margin-bottom:12px">'
        + (E.draft.same ? '' : '<div class="bbs-seg" role="tablist" aria-label="Edit background for"><button type="button" role="tab" data-tgt="dark" aria-selected="' + (E.target === 'dark') + '" class="' + (E.target === 'dark' ? 'on' : '') + '">For Dark mode</button><button type="button" role="tab" data-tgt="light" aria-selected="' + (E.target === 'light') + '" class="' + (E.target === 'light' ? 'on' : '') + '">For Light mode</button></div>')
        + '<label class="bbs-chk"><input type="checkbox" data-same' + (E.draft.same ? ' checked' : '') + '> Use the same background in both themes</label></div>'
      + '<div class="bbs-grid"><div style="display:flex;flex-direction:column;gap:14px">'
        + '<div class="bbs-opts" role="radiogroup" aria-label="Background">'
          + opt('black', 'Pure Black', '#000000', 'background:#000000')
          + opt('white', 'Pure White', '#FFFFFF', 'background:#FFFFFF')
          + opt('image', 'Custom image', img ? 'Your image' : 'Upload JPG, PNG, WebP', img ? 'background-image:url(&quot;' + esc(img) + '&quot;)' : 'background:repeating-linear-gradient(45deg,rgba(128,128,128,.25) 0 6px,transparent 6px 12px)')
        + '</div>'
        + (mismatch ? '<div class="bbs-warn">Page headings sit directly on the background — ' + (t === 'light' ? 'Pure White' : 'Pure Black') + ' reads best in ' + (t === 'light' ? 'Light' : 'Dark') + ' mode.</div>' : '')
        + (p.mode === 'image' ? imagePanel(p, img) : '')
        + (S.setup ? '' : '<div class="bbs-warn">Image backgrounds need a one-time database update by the administrator (20261112). Pure Black / Pure White work now.</div>')
      + '</div>'
      + '<div style="display:flex;flex-direction:column;gap:8px"><div class="bbs-lbl">Live preview · ' + (t === 'light' ? 'Light' : 'Dark') + ' mode</div>'
        + '<div class="bbs-pv" data-t="' + t + '"><div class="bbg-img" data-scale=".35"></div><div class="bbg-ov"></div>'
        + '<div class="pv-ui"><div class="pv-g"><span class="pv-t"></span><span class="pv-t s"></span><span class="pv-t s"></span><span class="pv-t s"></span></div>'
        + '<div class="pv-r"><div class="pv-g" style="height:16%"><span class="pv-t s"></span></div><div class="pv-cards"><div class="pv-g"><span class="pv-t"></span></div><div class="pv-g"><span class="pv-t"></span></div><div class="pv-g"><span class="pv-t"></span></div></div><div class="pv-g" style="height:34%"><span class="pv-t"></span><span class="pv-t s"></span></div></div></div>'
        + '<span class="pv-cap">' + (p.mode === 'image' ? (img ? 'Custom image' : 'No image yet') : (p.mode === 'black' ? '#000000' : '#FFFFFF')) + '</span></div>'
        + '<div class="bbs-note">Apply shows it on this page now; Save keeps it on every device.</div>'
      + '</div></div></section>';
    var box = main.querySelector('.bbs-pv');
    box.style.background = p.mode === 'image' ? (t === 'light' ? PURE.white : PURE.black) : PURE[p.mode];
    if (p.mode === 'image') paintInto(box.querySelector('.bbg-img'), box.querySelector('.bbg-ov'), p, t, img);
    else { box.querySelector('.bbg-ov').style.background = 'none'; }
    var f = sheet.querySelector('.bbs-f'); f.querySelectorAll('button').forEach(function (b) { b.disabled = E.busy && b.getAttribute('data-k') !== 'cancel'; });
    var sv = f.querySelector('[data-k="save"]'); sv.textContent = E.busy === 'save' ? 'Saving…' : 'Save';
  }
  function opt(mode, label, sub, sw) {
    var on = pv().mode === mode;
    return '<button type="button" role="radio" aria-checked="' + on + '" class="bbs-opt' + (on ? ' on' : '') + '" data-mode="' + mode + '"><i style="' + sw + '"></i><b>' + label + '</b><small>' + esc(sub) + '</small></button>';
  }
  function imagePanel(p, img) {
    var uploading = E.pct >= 0;
    return '<div class="bbs-drop">'
      + (img || uploading
        ? '<div class="bbs-thumb"><i style="' + (img ? 'background-image:url(&quot;' + esc(img) + '&quot;)' : '') + '"></i><span><b>' + esc(E.name || (img ? 'Background image' : 'Uploading…')) + '</b><small>' + (uploading ? 'Uploading… ' + E.pct + '%' : 'JPG, PNG or WebP · up to 8 MB') + '</small></span></div>'
        : '<div><b style="color:var(--tx-0,#fff)">Upload a background image</b><br><small>Drag an image here or choose one. JPG, PNG or WebP, up to 8 MB. 1920 × 1080 or larger looks sharpest. Only you can open it.</small></div>')
      + (uploading ? '<div class="bbs-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + E.pct + '"><i style="width:' + E.pct + '%"></i></div>' : '')
      + (E.err ? '<div class="bbs-err" role="alert">' + esc(E.err) + '</div>' : '') + (E.warn ? '<div class="bbs-warn">' + esc(E.warn) + '</div>' : '')
      + '<div class="bbs-row"><button type="button" class="bbs-btn" data-k="upload"' + (uploading || !S.setup ? ' disabled' : '') + '>' + svg(IC.up, 14) + (img ? 'Replace image' : 'Upload image') + '</button>'
      + (img ? '<button type="button" class="bbs-btn danger" data-k="remove"' + (uploading ? ' disabled' : '') + '>' + svg(IC.trash, 14) + 'Remove image</button>' : '') + '</div></div>'
      + '<div><div class="bbs-lbl">Scaling</div><div class="bbs-seg" role="radiogroup" aria-label="Scaling">' + FITS.map(function (f) { return '<button type="button" role="radio" title="' + f[2] + '" aria-checked="' + (p.fit === f[0]) + '" data-fit="' + f[0] + '" class="' + (p.fit === f[0] ? 'on' : '') + '">' + f[1] + '</button>'; }).join('') + '</div></div>'
      + '<div class="bbs-row" style="align-items:flex-start;gap:22px"><div><div class="bbs-lbl">Position</div><div class="bbs-pos" role="radiogroup" aria-label="Image position">' + POS.map(function (x) { return '<button type="button" role="radio" aria-label="' + x + '" aria-checked="' + (p.pos === x) + '" data-pos="' + x + '" class="' + (p.pos === x ? 'on' : '') + '"><i></i></button>'; }).join('') + '</div></div>'
      + '<div style="flex:1;min-width:180px;display:flex;flex-direction:column;gap:10px">'
      + '<div><div class="bbs-lbl"><label for="bbs-blur">Blur</label></div><div class="bbs-range"><input id="bbs-blur" type="range" min="0" max="24" step="1" value="' + p.blur + '" data-rng="blur"><output>' + p.blur + ' px</output></div></div>'
      + '<div><div class="bbs-lbl"><label for="bbs-ov">Overlay (readability)</label></div><div class="bbs-range"><input id="bbs-ov" type="range" min="0" max="80" step="1" value="' + p.overlay + '" data-rng="overlay"><output>' + p.overlay + '%</output></div></div>'
      + '<button type="button" class="bbs-btn" data-k="adjreset" style="align-self:flex-start">Reset adjustments</button></div></div>';
  }

  function onClick(e) {
    if (e.target === sheet) return cancel();
    var b = e.target.closest('button'); if (!b || b.disabled) return;
    var k = b.getAttribute('data-k');
    if (b.hasAttribute('data-theme-set')) { if (window.BETheme) BETheme.set(b.getAttribute('data-theme-set')); if (!E.draft.same) E.target = theme(); if (E.applied) liveDraft(); drawSheet(); return; }
    if (b.hasAttribute('data-tgt')) { E.target = b.getAttribute('data-tgt'); E.err = E.warn = ''; drawSheet(); return; }
    if (b.hasAttribute('data-mode')) { setP('mode', b.getAttribute('data-mode')); E.err = ''; if (b.getAttribute('data-mode') === 'image' && !pv().path && S.setup) sheet.querySelector('[data-file]').click(); drawSheet(); return; }
    if (b.hasAttribute('data-fit')) { setP('fit', b.getAttribute('data-fit')); drawSheet(); return; }
    if (b.hasAttribute('data-pos')) { setP('pos', b.getAttribute('data-pos')); drawSheet(); return; }
    if (k === 'upload') return sheet.querySelector('[data-file]').click();
    if (k === 'remove') { var p = pv(); p.mode = E.target === 'light' && !E.draft.same ? 'white' : 'black'; delete p.path; if (E.draft.same) E.draft.light = Object.assign({}, E.draft.dark); E.name = ''; drawSheet(); return; }
    if (k === 'adjreset') { var q = pv(), d = defPref(E.target); q.fit = d.fit; q.pos = d.pos; q.blur = d.blur; q.overlay = d.overlay; if (E.draft.same) E.draft.light = Object.assign({}, E.draft.dark); drawSheet(); return; }
    if (k === 'reset') { if (E.draft.same) { E.draft = defBg(); } else { E.draft[E.target] = defPref(E.target); } E.err = E.warn = ''; E.name = ''; drawSheet(); toast('info', 'Reset to the default — Save to keep it.'); return; }
    if (k === 'cancel') return cancel();
    if (k === 'apply') { liveDraft(); E.applied = true; toast('success', 'Applied to this page — Save to keep it.'); return; }
    if (k === 'save') return save();
  }
  function onInput(e) {
    var r = e.target.getAttribute && e.target.getAttribute('data-rng'); if (!r) return;
    setP(r, +e.target.value);
    var o = e.target.parentNode.querySelector('output'); if (o) o.textContent = e.target.value + (r === 'blur' ? ' px' : '%');
    var box = sheet.querySelector('.bbs-pv'), p = pv(), t = E.draft.same ? theme() : E.target;
    if (box && p.mode === 'image') paintInto(box.querySelector('.bbg-img'), box.querySelector('.bbg-ov'), p, t, urlFor(p.path));
    if (E.applied) liveDraft();
  }
  function onChange(e) {
    if (e.target.hasAttribute('data-same')) { E.draft.same = e.target.checked; if (E.draft.same) { if (E.target === 'light') E.draft.dark = Object.assign({}, E.draft.light); E.draft.light = Object.assign({}, E.draft.dark); } drawSheet(); return; }
    if (e.target.hasAttribute('data-file')) { var f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) pick(f); }
  }
  function liveDraft() { S.draft = clone(E.draft); paint(); }

  function ext(n) { return (String(n).toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1] || ''; }
  /** Validate in the browser (type, size, really decodes as an image), then upload with progress. */
  async function pick(file) {
    E.err = E.warn = '';
    var x = ext(file.name), type = TYPES[x];
    if (!type || (file.type && !/^image\/(jpeg|png|webp)$/.test(file.type))) { E.err = 'Use a JPG, PNG or WebP image.'; return drawSheet(); }
    if (!file.size) { E.err = 'That file is empty.'; return drawSheet(); }
    if (file.size > MAX) { E.err = 'That image is ' + (file.size / 1048576).toFixed(1) + ' MB — the limit is 8 MB.'; return drawSheet(); }
    var local = URL.createObjectURL(file);
    var dim = await new Promise(function (res) { var im = new Image(); im.onload = function () { res({ w: im.naturalWidth, h: im.naturalHeight }); }; im.onerror = function () { res(null); }; im.src = local; });
    if (!dim) { URL.revokeObjectURL(local); E.err = 'That file could not be read as an image.'; return drawSheet(); }
    if (dim.w < 1280 || dim.h < 720) E.warn = 'This image is ' + dim.w + ' × ' + dim.h + ' — it may look soft on large screens.';
    E.name = file.name; E.pct = 0; E.busy = 'upload'; drawSheet();
    try {
      var t = await api('upload', { name: file.name, size: file.size, type: type });
      await new Promise(function (res, rej) {
        var fd = new FormData(); fd.append('cacheControl', '3600'); fd.append('', file.type ? file : new File([file], file.name, { type: type }), file.name);
        var xh = new XMLHttpRequest(); xh.open('PUT', t.url);
        xh.upload.onprogress = function (ev) { if (ev.lengthComputable && sheet) { E.pct = Math.min(99, Math.round(ev.loaded / ev.total * 100)); var bar = sheet.querySelector('.bbs-bar i'), sm = sheet.querySelector('.bbs-thumb small'); if (bar) bar.style.width = E.pct + '%'; if (sm) sm.textContent = 'Uploading… ' + E.pct + '%'; } };
        xh.onload = function () { xh.status >= 200 && xh.status < 300 ? res() : rej(new Error(/mime|type/i.test(xh.responseText) ? 'That file type isn’t allowed.' : /size|large|payload/i.test(xh.responseText) ? 'That image is larger than 8 MB.' : 'Upload failed (' + xh.status + ').')); };
        xh.onerror = function () { rej(new Error(navigator.onLine ? 'Upload failed — check your connection.' : 'You are offline.')); };
        xh.send(fd);
      });
      S.local[t.path] = local; E.uploads.push(t.path);
      var p = pv(); p.mode = 'image'; p.path = t.path; if (E.draft.same) E.draft.light = Object.assign({}, E.draft.dark);
      if (E.applied) liveDraft();
    } catch (err) {
      URL.revokeObjectURL(local);
      E.err = err.code === 'SETUP_PENDING' ? 'Image backgrounds need a one-time database update by the administrator.' : err.message;
      if (err.code === 'SETUP_PENDING') S.setup = false;
    }
    E.pct = -1; E.busy = false; drawSheet();
  }

  async function save() {
    E.err = ''; E.busy = 'save'; drawSheet();
    try {
      var j = await api('save', { background: E.draft });
      S.saved = norm(j.background); Object.assign(S.urls, j.urls || {}); S.failed = {};
      writeCache(S.email || email(), S.saved, S.urls);
      E.uploads = []; E.busy = false;
      close(); toast('success', 'Background saved.');
    } catch (err) {
      E.busy = false; E.err = err.message;
      if (pv().mode !== 'image') toast('error', err.message);
      drawSheet();
    }
  }
  function cancel() {
    var orphans = E.uploads.filter(function (p) { return p !== S.saved.dark.path && p !== S.saved.light.path; });
    if (orphans.length) api('discard', { paths: orphans }).catch(function () {});
    close();
  }

  // ── boot (last, so every helper and SHEET_CSS above is defined) ──────────────────────────────────────────────────────────────────
  load(); paint();
  function boot() { styleOnce(); paint(); setTimeout(refresh, 400); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('be-theme-change', function () { paint(); if (sheet) drawSheet(); });
  // another tab saved, or another account signed in on this device
  window.addEventListener('storage', function (e) { if (!e.key || e.key === 'be_active_email' || e.key === CACHE + S.email) { load(); paint(); } });
  setInterval(function () { if (email() !== S.email) { load(); S.draft = null; paint(); refresh(); } }, 3000);


  window.BEBackground = {
    openSettings: openSettings,
    menuRow: menuRow,
    refresh: refresh,
    current: function () { return { theme: theme(), pref: clone(active()), saved: clone(S.saved) }; },
    _state: S
  };
})();
