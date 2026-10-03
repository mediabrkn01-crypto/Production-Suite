/* ============================================================================
 * be-window.js — reusable "workspace window" behaviour for LARGE admin popups.
 *
 * Opt-in only: put data-bewin="<key>" on the .modal element and mark its parts:
 *   [data-bewin-head]      sticky header (window controls are appended into
 *                          [data-bewin-controls] inside it)
 *   [data-bewin-body]      scrollable content (a CSS container, so layouts can
 *                          switch columns by the WINDOW's width, not the screen's)
 *   [data-bewin-foot]      sticky action bar
 * Close is wired to the existing close behaviour: the parent .modal-bg loses .on.
 *
 * Gives: wide default size, Compact / Maximize / Close controls, desktop resize
 * (right edge, bottom edge, corner) with min/max limits, size remembered for the
 * browser session per key (sessionStorage), touch devices never get resize.
 * Small confirm dialogs don't use it and are untouched.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.BEWindow) return;
  var MIN_W = 560, MIN_H = 380, PAD = 24;
  var CSS = [
    '.bewin{display:flex!important;flex-direction:column;position:relative;padding:0!important;overflow:hidden!important;box-sizing:border-box;',
    'width:min(82vw,1320px);height:min(88vh,920px);max-width:calc(100vw - ' + PAD + 'px)!important;max-height:calc(100vh - ' + PAD + 'px)!important;transition:width .18s,height .18s}',
    '.bewin.bewin-resizing{transition:none;user-select:none}',
    '.bewin[data-mode="compact"]{width:min(640px,calc(100vw - ' + PAD + 'px));height:min(88vh,920px)}',
    '.bewin[data-mode="max"]{width:calc(100vw - ' + PAD + 'px)!important;height:calc(100vh - ' + PAD + 'px)!important}',
    '.bewin>[data-bewin-head]{flex:0 0 auto;position:relative;z-index:2}',
    '.bewin>[data-bewin-body]{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;container-type:inline-size;container-name:bewin}',
    '.bewin>[data-bewin-foot]{flex:0 0 auto;position:relative;z-index:2}',
    '.bewin-ctl{display:flex;align-items:center;gap:6px;flex-shrink:0}',
    '.bewin-btn{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:rgba(255,255,255,.6);',
    'display:grid;place-items:center;cursor:pointer;padding:0;transition:background .12s,color .12s}',
    '.bewin-btn:hover{color:#fff;background:rgba(255,255,255,.09)}',
    '.bewin-btn:focus-visible{outline:2px solid rgba(255,138,60,.6);outline-offset:1px}',
    '.bewin-btn[data-on]{color:#ff8a3c;border-color:rgba(255,107,6,.4)}',
    '.bewin-rz{position:absolute;z-index:3}',
    '.bewin-rz-r{top:0;right:0;width:7px;height:100%;cursor:ew-resize}',
    '.bewin-rz-b{left:0;bottom:0;height:7px;width:100%;cursor:ns-resize}',
    '.bewin-rz-c{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;',
    'background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.18) 50%,rgba(255,255,255,.18) 58%,transparent 58%,transparent 70%,rgba(255,255,255,.18) 70%,rgba(255,255,255,.18) 78%,transparent 78%)}',
    '.bewin[data-mode="max"] .bewin-rz,.bewin[data-mode="compact"] .bewin-rz-r,.bewin[data-mode="compact"] .bewin-rz-c{display:none}',
    '@media (max-width:760px),(pointer:coarse){.bewin,.bewin[data-mode]{width:calc(100vw - 16px)!important;height:auto!important;max-height:calc(100vh - 16px)!important;max-width:calc(100vw - 16px)!important}',
    '.bewin .bewin-rz,.bewin [data-bewin-act="compact"],.bewin [data-bewin-act="max"]{display:none!important}}'
  ].join('');
  var ICON = {
    compact: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    max: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    restore: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  };
  function injectCSS() { if (document.getElementById('bewin-css')) return; var s = document.createElement('style'); s.id = 'bewin-css'; s.textContent = CSS; document.head.appendChild(s); }
  function load(key) { try { return JSON.parse(sessionStorage.getItem('bewin:' + key) || 'null') || {}; } catch (_) { return {}; } }
  function save(key, st) { try { sessionStorage.setItem('bewin:' + key, JSON.stringify(st)); } catch (_) {} }
  function clampW(w) { return Math.max(MIN_W, Math.min(w, window.innerWidth - PAD)); }
  function clampH(h) { return Math.max(MIN_H, Math.min(h, window.innerHeight - PAD)); }
  function canResize() { return window.matchMedia && !window.matchMedia('(max-width:760px),(pointer:coarse)').matches; }

  function apply(win) {
    var st = win.__bewinState;
    win.setAttribute('data-mode', st.mode || 'normal');
    if ((st.mode || 'normal') === 'normal' && st.w && st.h && canResize()) { win.style.width = clampW(st.w) + 'px'; win.style.height = clampH(st.h) + 'px'; }
    else { win.style.width = ''; win.style.height = ''; }
    var mx = win.querySelector('[data-bewin-act="max"]'), cp = win.querySelector('[data-bewin-act="compact"]');
    if (mx) { mx.innerHTML = st.mode === 'max' ? ICON.restore : ICON.max; mx.title = st.mode === 'max' ? 'Restore size' : 'Maximize'; mx.setAttribute('aria-label', mx.title); }
    if (cp) { if (st.mode === 'compact') cp.setAttribute('data-on', ''); else cp.removeAttribute('data-on'); cp.title = st.mode === 'compact' ? 'Back to wide view' : 'Compact view'; cp.setAttribute('aria-label', cp.title); }
  }
  function setMode(win, mode) { var st = win.__bewinState; st.mode = st.mode === mode ? 'normal' : mode; save(win.__bewinKey, st); apply(win); }

  function startResize(win, edge, e) {
    if (!canResize()) return;
    e.preventDefault();
    var r = win.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, w0 = r.width, h0 = r.height;
    win.classList.add('bewin-resizing');
    var st = win.__bewinState; if (st.mode !== 'normal') { st.mode = 'normal'; win.setAttribute('data-mode', 'normal'); }
    // The window is centred, so it grows on both sides; double the pointer delta to keep the
    // edge under the cursor.
    function move(ev) {
      if (edge !== 'b') win.style.width = clampW(w0 + (ev.clientX - x0) * 2) + 'px';
      if (edge !== 'r') win.style.height = clampH(h0 + (ev.clientY - y0) * 2) + 'px';
    }
    function up() {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      win.classList.remove('bewin-resizing');
      var rr = win.getBoundingClientRect(); st.w = Math.round(rr.width); st.h = Math.round(rr.height); save(win.__bewinKey, st); apply(win);
    }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }

  function enhance(win) {
    if (!win || win.__bewin) return;
    var key = win.getAttribute('data-bewin'); if (!key) return;
    injectCSS();
    win.__bewin = true; win.__bewinKey = key; win.__bewinState = Object.assign({ mode: 'normal' }, load(key));
    win.classList.add('bewin');
    var slot = win.querySelector('[data-bewin-controls]');
    if (slot) {
      slot.classList.add('bewin-ctl');
      slot.innerHTML =
        '<button type="button" class="bewin-btn" data-bewin-act="compact">' + ICON.compact + '</button>' +
        '<button type="button" class="bewin-btn" data-bewin-act="max">' + ICON.max + '</button>' +
        '<button type="button" class="bewin-btn" data-bewin-act="close" title="Close" aria-label="Close">' + ICON.close + '</button>';
      slot.addEventListener('click', function (e) {
        var b = e.target.closest('[data-bewin-act]'); if (!b) return;
        var act = b.getAttribute('data-bewin-act');
        if (act === 'close') { var bg = win.closest('.modal-bg'); if (bg) bg.classList.remove('on'); }
        else setMode(win, act);
      });
    }
    ['r', 'b', 'c'].forEach(function (edge) {
      var h = document.createElement('div'); h.className = 'bewin-rz bewin-rz-' + edge; h.setAttribute('aria-hidden', 'true');
      h.addEventListener('pointerdown', function (e) { startResize(win, edge, e); });
      win.appendChild(h);
    });
    win.addEventListener('dblclick', function (e) { if (e.target.closest('[data-bewin-head]') && !e.target.closest('button,input,select,a')) setMode(win, 'max'); });
    apply(win);
  }
  function scan() { document.querySelectorAll('[data-bewin]').forEach(enhance); }
  window.addEventListener('resize', function () { document.querySelectorAll('.bewin').forEach(function (w) { if (w.__bewinState) apply(w); }); });
  window.BEWindow = { enhance: enhance, scan: scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
