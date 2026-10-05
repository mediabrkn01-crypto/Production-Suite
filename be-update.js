/**
 * BE Update — keeps every open tab on the latest deployed version of the site.
 *
 * This is about deployed CODE (HTML/JS/CSS), not data. Live data is be-live.js.
 *
 *  - Each deploy stamps a version into version.json and into every page as
 *    <meta name="be-version">, and every local asset as file.js?v=VERSION
 *    (scripts/stamp-version.mjs, run by the pre-commit hook).
 *  - This file polls version.json (no-store, cache-busted) every 60 s, and again when the tab
 *    becomes visible, the network comes back, the page is restored from bfcache, or the device
 *    wakes from sleep.
 *  - New version + nothing unsaved  → short "Updating Broken English…" notice, then reload.
 *    New version + unsaved work     → "Finish your current work and update" with Update now /
 *    Later; it updates by itself once the work is finished (unless the user chose Later).
 *  - The reload goes to the same URL with ?_v=<version> so the browser cannot reuse a cached
 *    HTML page, and the current tab/section is restored after the reload.
 *  - There is no service worker; any old one is unregistered and its caches are removed.
 *
 * Pages can also tell it about work it cannot see: BEUpdate.setBusy('payroll-edit', true/false).
 * Namespace: window.BEUpdate
 */
(function () {
  'use strict';
  if (window.BEUpdate) return;

  // Inside the Manager Command Center the department pages run in iframes — the top page owns
  // version checks and its reload refreshes every frame, so embedded copies stay quiet.
  var EMBEDDED = false; try { EMBEDDED = window.top !== window.self; } catch (_) { EMBEDDED = true; }
  var CHECK_MS = 60000, NOTICE_MS = 5000, LATER_MS = 15 * 60000, RESUME_KEY = 'be_update_resume';
  var meta = document.querySelector('meta[name="be-version"]');
  var running = meta ? meta.getAttribute('content') : null;
  var latest = null, ui = null, laterUntil = 0, pendingTimer = null, countdown = null;

  // ───────────────────────────── version check
  function versionUrl() {
    var base = location.pathname.replace(/[^/]*$/, '');
    return base + 'version.json?t=' + Date.now();
  }
  var checking = false, lastCheck = 0;
  function check(reason) {
    if (EMBEDDED) return;
    if (checking || !navigator.onLine) return;
    if (reason !== 'force' && Date.now() - lastCheck < 8000) return;
    checking = true; lastCheck = Date.now();
    fetch(versionUrl(), { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var v = j && j.version ? String(j.version) : null;
        if (!v) return;
        if (!running) { running = v; return; }          // page without a stamp: adopt as baseline
        if (v === running) { try { sessionStorage.removeItem('be_update_tried'); } catch (_) {} }
        if (v !== running) { latest = v; onNewVersion(); }
      })
      .catch(function () {})
      .then(function () { checking = false; });
  }

  // ───────────────────────────── unsaved-work detection
  var busyFlags = {}, touched = new WeakSet(), writes = 0, lastWriteEnd = 0;
  var SEARCHY = /search|filter|find/i;
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!e.isTrusted || !t || !t.matches || t.tagName === 'SELECT') return;   // selects are filters or save at once
    if (t.matches('input[type="search"],input[type="date"],input[type="month"],input[type="time"],input[type="checkbox"],input[type="radio"],input[type="range"]') || SEARCHY.test((t.getAttribute('placeholder') || '') + ' ' + (t.getAttribute('aria-label') || '') + ' ' + (t.id || ''))) return;
    touched.add(t);
  }, true);
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (e.isTrusted && t && t.matches && t.matches('input[type="file"]') && t.files && t.files.length) { touched.add(t); }
  }, true);

  var lastGesture = 0;
  document.addEventListener('pointerdown', function (e) { if (e.isTrusted) lastGesture = Date.now(); }, true);
  document.addEventListener('keydown', function (e) { if (e.isTrusted && e.key === 'Enter') lastGesture = Date.now(); }, true);
  // Count in-flight writes (Supabase REST/Storage writes are fetch POST/PATCH/PUT/DELETE).
  if (window.fetch) {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      var m = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var isWrite = m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
      if (!isWrite) return _fetch.apply(this, arguments);
      writes++;
      var byUser = Date.now() - lastGesture < 3000;   // a Save click, not a background read-receipt/log
      // A finished write means what the user typed has been saved — start tracking afresh.
      var done = function () { writes = Math.max(0, writes - 1); lastWriteEnd = Date.now(); if (!writes && byUser) touched = new WeakSet(); };
      var p = _fetch.apply(this, arguments);
      p.then(done, done);
      return p;
    };
  }

  function visible(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
  var MODAL_SEL = [
    '.hr-modal-overlay:not(.hidden)', '[aria-modal="true"]', '.modal-overlay.open', '.modal-overlay.show',
    '.modal.open', '.modal.show', '.modal-bg.on', '.overlay.on', '.mw-modal', '.be-win-overlay', '[data-unsaved="true"]'
  ].join(',');

  function busyReason() {
    var k; for (k in busyFlags) if (busyFlags[k]) return k;
    // Same-origin embedded pages (Manager Command Center) report their own unsaved work.
    var frs = document.querySelectorAll('iframe');
    for (var fi = 0; fi < frs.length; fi++) { try { var w = frs[fi].contentWindow, r = w && w.BEUpdate && w.BEUpdate.isBusy(); if (r) return 'frame:' + r; } catch (_) {} }
    if (writes > 0 || Date.now() - lastWriteEnd < 2000) return 'saving';
    var modals = document.querySelectorAll(MODAL_SEL);
    for (var i = 0; i < modals.length; i++) if (visible(modals[i])) return 'dialog-open';
    var a = document.activeElement;
    if (a && a !== document.body && a.matches && a.matches('textarea,[contenteditable="true"]')) return 'typing';
    var fields = document.querySelectorAll('input,textarea,[contenteditable="true"]');
    for (var j = 0; j < fields.length; j++) {
      var f = fields[j];
      if (!touched.has(f) || !visible(f)) continue;
      if (f.type === 'file') { if (f.files && f.files.length) return 'file-selected'; continue; }
      if (f.isContentEditable || f.value !== f.defaultValue) return 'unsaved-input';
    }
    return null;
  }

  // ───────────────────────────── UI
  var CSS = [
    '.beu{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:min(360px,calc(100vw - 32px));background:#11162a;color:#e6e9f5;border:1px solid rgba(255,138,60,.35);border-radius:16px;box-shadow:0 24px 60px -16px rgba(0,0,0,.75);padding:16px 16px 14px;font:13px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;opacity:0;transform:translateY(10px);transition:opacity .25s,transform .25s}',
    '.beu.on{opacity:1;transform:none}',
    '.beu-t{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#ff8a3c;margin:0 0 6px}',
    '.beu-p{margin:0 0 12px;color:#a5adcf}',
    '.beu-b{display:flex;gap:8px;justify-content:flex-end}',
    '.beu button{height:36px;padding:0 14px;border-radius:10px;font:700 12.5px Inter,system-ui,sans-serif;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#cbd5e1}',
    '.beu button.pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f)}',
    '.beu button:focus-visible{outline:2px solid #ff8a3c;outline-offset:2px}',
    '.beu-bar{height:3px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;margin:0 0 12px}',
    '.beu-bar i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#ff6b06,#f9182f);transform-origin:left;animation:beuBar linear forwards}',
    '@keyframes beuBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}',
    '.beu-cover{position:fixed;inset:0;z-index:2147483001;background:#0b0d19;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;color:#e6e9f5;font:600 14px Inter,system-ui,sans-serif}',
    '.beu-spin{width:28px;height:28px;border-radius:50%;border:3px solid rgba(255,255,255,.12);border-top-color:#ff6b06;animation:beuSpin .8s linear infinite}',
    '@keyframes beuSpin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.beu{transition:none}.beu-bar i{animation:none}.beu-spin{animation-duration:2s}}',
    '@media (max-width:640px){.beu{right:16px;bottom:calc(16px + 76px)}}'
  ].join('');
  function css() { if (document.getElementById('beu-css')) return; var s = document.createElement('style'); s.id = 'beu-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }
  var SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>';

  function closeUI() { if (ui) { var u = ui; ui = null; u.classList.remove('on'); setTimeout(function () { u.remove(); }, 260); } clearTimeout(countdown); countdown = null; }
  function show(kind) {
    css();
    if (ui && ui.dataset.kind === kind) return;
    closeUI();
    var d = document.createElement('div');
    d.className = 'beu'; d.dataset.kind = kind; d.setAttribute('role', 'status'); d.setAttribute('aria-live', 'polite');
    if (kind === 'auto') {
      d.innerHTML = '<div class="beu-t">' + SPARK + 'Updating Broken English…</div><p class="beu-p">A new version is ready. Reloading in a few seconds — you\'ll stay on this page.</p><div class="beu-bar"><i style="animation-duration:' + NOTICE_MS + 'ms"></i></div><div class="beu-b"><button type="button" data-a="later">Not now</button><button type="button" class="pri" data-a="now">Update now</button></div>';
      countdown = setTimeout(function () { if (!busyReason()) applyUpdate(); else show('busy'); }, NOTICE_MS);
    } else {
      var busy = kind === 'busy';
      d.innerHTML = '<div class="beu-t">' + SPARK + 'New update available</div><p class="beu-p">' + (busy ? 'New version available. Finish your current work and update.' : 'Broken English has been updated. Refresh to use the latest version.') + '</p><div class="beu-b">' + (busy ? '<button type="button" data-a="later">Later</button>' : '') + '<button type="button" class="pri" data-a="now">Update now</button></div>';
    }
    d.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a === 'now') applyUpdate();
      else { laterUntil = Date.now() + LATER_MS; closeUI(); }
    });
    document.body.appendChild(d); ui = d;
    requestAnimationFrame(function () { d.classList.add('on'); });
  }

  function triedFor() { try { return sessionStorage.getItem('be_update_tried'); } catch (_) { return null; } }
  function onNewVersion() {
    if (!latest || latest === running) return;
    if (Date.now() < laterUntil) return;
    // Already reloaded for this exact version and still on the old one (the server/CDN was
    // still handing out the previous page) — never loop; offer the button and retry later.
    if (triedFor() === latest) { show('manual'); laterUntil = Date.now() + 5 * 60000; try { sessionStorage.removeItem('be_update_tried'); } catch (_) {} return; }
    var busy = busyReason();
    if (busy) { show('busy'); return; }
    if (document.visibilityState === 'hidden') { applyUpdate(true); return; } // nobody is looking — update quietly
    if (!ui || ui.dataset.kind !== 'auto') show('auto');
  }
  // While an update is waiting, keep re-checking whether it has become safe.
  setInterval(function () {
    if (!latest || latest === running || Date.now() < laterUntil) return;
    if (!busyReason() && (!ui || ui.dataset.kind === 'busy')) { closeUI(); onNewVersion(); }
  }, 15000);

  // ───────────────────────────── route save / restore
  function q(s) { try { return document.querySelector(s); } catch (_) { return null; } }
  function g(name) { try { return Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')(); } catch (_) { return undefined; } }
  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var ROUTES = {
    'hr.html': { get: function () { return g('hrCurrentSubtab'); }, set: function (t) { g('switchHRSubtab')(t); }, ready: function () { return g('hrDataState') === 'ready'; } },
    'academics.html': { get: function () { var e = q('.acad-tab.on'); return e ? e.id.replace(/^tab-acad-/, '') : null; }, set: function (t) { g('acadSwitchTab')(t); }, ready: function () { return !!g('currentUser') && !!q('.acad-tab.on'); } },
    'sales.html': { get: function () { var e = q('.tab.on[id^="tab-"]'); return e ? e.id.replace(/^tab-/, '') : null; }, set: function (t) { g('switchTab')(t); }, ready: function () { return !!g('ME') && !!q('.tab.on'); } },
    'manager.html': { get: function () { var e = q('.navlink.on[data-sec]'); return e ? e.dataset.sec : null; }, set: function (t) { window.mgrSection(t); }, ready: function () { return typeof window.mgrSection === 'function' && !!q('.navlink.on'); } },
    'index.html': { get: function () { var e = q('[id^="tab-content-"]:not(.hidden)'); return e ? e.id.replace(/^tab-content-/, '') : null; }, set: function (t) { g('switchTab')(t); }, ready: function () { return !!g('activeUser') && !!window._hrLandingDone; } }
  };
  ROUTES[''] = ROUTES['index.html'];
  var route = ROUTES[page];

  function saveResume() {
    var tab = null; try { tab = route && route.get(); } catch (_) {}
    try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ page: page, tab: tab, y: window.scrollY || 0, at: Date.now() })); } catch (_) {}
  }
  function restoreResume() {
    var r; try { r = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null'); sessionStorage.removeItem(RESUME_KEY); } catch (_) { r = null; }
    if (!r || r.page !== page || Date.now() - r.at > 120000 || !route || !r.tab) return;
    var tries = 0, applied = 0;
    (function wait() {
      var ok = false; try { ok = route.ready(); } catch (_) {}
      if (!ok) { if (++tries < 80) setTimeout(wait, 250); return; }
      var cur = null; try { cur = route.get(); } catch (_) {}
      if (cur !== r.tab) { try { route.set(r.tab); } catch (_) {} }
      if (r.y) setTimeout(function () { window.scrollTo(0, r.y); }, 120);
      // A page's own landing logic can run a moment later — re-apply a couple of times.
      if (++applied < 3) setTimeout(function () { var c = null; try { c = route.get(); } catch (_) {} if (c !== r.tab) wait(); }, 1500);
    })();
  }

  function applyUpdate(silent) {
    saveResume();
    try { sessionStorage.setItem('be_update_tried', latest || ''); } catch (_) {}
    if (!silent) {
      css();
      var c = document.createElement('div'); c.className = 'beu-cover'; c.innerHTML = '<div class="beu-spin"></div>Updating Broken English…';
      document.body.appendChild(c);
    }
    clearSWCaches().then(function () {
      var u = new URL(location.href);
      u.searchParams.set('_v', latest || String(Date.now()));
      location.replace(u.toString());
    });
  }

  // ───────────────────────────── service worker / cache hygiene
  // The site does not use a service worker. Remove any that an older build or another app on
  // this origin left behind, so nothing can keep serving an old bundle.
  function clearSWCaches() {
    var jobs = [];
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations)
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }).catch(function () {}));
      if (window.caches && caches.keys)
        jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }).catch(function () {}));
    } catch (_) {}
    return Promise.all(jobs).then(function () {}, function () {});
  }

  // ───────────────────────────── boot
  // Drop the one-time ?_v= marker from the address bar after an update reload.
  try {
    var u0 = new URL(location.href);
    if (u0.searchParams.has('_v')) { u0.searchParams.delete('_v'); history.replaceState(history.state, '', u0.pathname + (u0.search || '') + u0.hash); }
  } catch (_) {}
  clearSWCaches();

  var lastTick = Date.now();
  setInterval(function () {
    var now = Date.now(), slept = now - lastTick > CHECK_MS * 2.5; lastTick = now;
    if (document.visibilityState === 'visible' || slept) check(slept ? 'force' : 'tick');
  }, CHECK_MS);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check('visible'); });
  window.addEventListener('online', function () { check('force'); });
  window.addEventListener('focus', function () { check('focus'); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) check('force'); });
  function start() { restoreResume(); setTimeout(function () { check('force'); }, 4000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.BEUpdate = {
    get version() { return running; },
    get latest() { return latest; },
    check: function () { check('force'); },
    isBusy: function () { return busyReason(); },
    /** True while the user has typed into a field inside `root` that is still unsaved/focused. */
    isEditingIn: function (root) {
      if (!root) return false;
      var a = document.activeElement;
      if (a && root.contains(a) && a.matches && a.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable="true"]')) return true;
      var fs = root.querySelectorAll('input,textarea,[contenteditable="true"]');
      for (var i = 0; i < fs.length; i++) if (touched.has(fs[i]) && visible(fs[i]) && (fs[i].isContentEditable || fs[i].value !== fs[i].defaultValue)) return true;
      return false;
    },
    setBusy: function (key, on) { busyFlags[key] = !!on; },
    updateNow: function () { if (latest) applyUpdate(); else location.reload(); }
  };
})();
