/**
 * BE Update — keeps every open tab on the latest deployed version of the site.
 *
 * This is about deployed CODE (HTML/JS/CSS), not data. Live data is be-live.js.
 *
 *  - Each deploy stamps a version into version.json and into every page as
 *    <meta name="be-version">, and every local asset as file.js?v=VERSION
 *    (scripts/stamp-version.mjs, run by the pre-commit hook).
 *  - LIVE: listens to the central app_versions row over Supabase Realtime. The deploy pipeline
 *    (.github/workflows/publish-version.yml) updates that row only after the new build is
 *    actually served in production — so open pages learn about it within seconds, no refresh.
 *  - Fallback: every 45 s, and when the tab becomes visible, the network comes back, the page is
 *    restored from bfcache, or the device wakes, it reads that row + version.json (both tiny).
 *  - On detection it pre-fetches the new page and its versioned JS/CSS in the background.
 *  - New version + nothing unsaved  → "System update available · Updating in 10 seconds…" with
 *    Later / Update now. Unsaved work → "Finish your current work before updating" — never an
 *    automatic reload while working. Later → a small "Update ready" chip, reminder in 15 min.
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
  var APP = 'broken_english', CHECK_MS = 45000, NOTICE_MS = 10000, LATER_MS = 15 * 60000, RESUME_KEY = 'be_update_resume';
  var meta = document.querySelector('meta[name="be-version"]');
  var running = meta ? meta.getAttribute('content') : null;
  var latest = null, ui = null, laterUntil = 0, pendingTimer = null, countdown = null;

  // ───────────────────────────── version check
  // Versions are stamped "YYYY.MM.DD.HHMM-xxxx" (India time) — only a NEWER one counts, so an
  // old record can never ask a freshly loaded page to "update" backwards.
  function isNewer(v, than) {
    if (!v || !than || v === than) return false;
    var a = String(v).split('-')[0], b = String(than).split('-')[0];
    return a > b || (a === b);   // same minute, different build → still a new build
  }
  function consider(v) {
    v = v ? String(v) : null;
    if (!v) return;
    try { window.dispatchEvent(new CustomEvent('be-version-seen', { detail: v })); } catch (_) {}
    if (!running) { running = v; return; }             // page without a stamp: adopt as baseline
    if (v === running) { try { sessionStorage.removeItem('be_update_tried'); } catch (_) {} return; }
    if (!isNewer(v, running) || (latest && !isNewer(v, latest) && v !== latest)) return;
    var fresh = v !== latest;
    latest = v;
    if (fresh) prefetch(v);
    onNewVersion();
  }
  function versionUrl() {
    var base = location.pathname.replace(/[^/]*$/, '');
    return base + 'version.json?t=' + Date.now();
  }
  function client() {
    try { if (typeof dbInstance !== 'undefined' && dbInstance && dbInstance.from) return dbInstance; } catch (_) {}
    try { if (typeof sb !== 'undefined' && sb && sb.from) return sb; } catch (_) {}
    return null;
  }
  // Fallback check (realtime is primary): the central production record + the deployed
  // version.json — both tiny; neither reloads anything.
  var checking = false, lastCheck = 0;
  function check(reason) {
    if (EMBEDDED) return;
    if (checking || !navigator.onLine) return;
    if (reason !== 'force' && Date.now() - lastCheck < 8000) return;
    checking = true; lastCheck = Date.now();
    var jobs = [fetch(versionUrl(), { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.version) consider(j.version); })
      .catch(function () {})];
    var c = client();
    if (c && listen.ok) jobs.push(Promise.resolve(c.from('app_versions').select('version,status').eq('app_name', APP).maybeSingle())
      .then(function (r) { var row = r && r.data; if (row && row.status !== 'rolled_back') consider(row.version); })
      .catch(function () {}));
    Promise.all(jobs).then(function () { checking = false; });
  }
  // Primary: Supabase Realtime on the central app_versions row. The deploy pipeline updates it
  // only once the new build is actually live, so every open page hears about it within seconds.
  function listen(n) {
    if (EMBEDDED) return;
    if (!window.BELive || !client()) { if ((n || 0) < 60) setTimeout(function () { listen((n || 0) + 1); }, 500); return; }
    // Subscribe only once the table exists (before the migration runs, a binding on a missing
    // table would break the shared live channel for every other subscriber).
    if (!listen.ok) {
      Promise.resolve(client().from('app_versions').select('version').limit(1)).then(function (r) {
        if (r && !r.error) { listen.ok = true; listen(n); } else setTimeout(function () { listen(n); }, 300000);
      }, function () { setTimeout(function () { listen(n); }, 300000); });
      return;
    }
    BELive.use(client());
    BELive.on('app-version', { table: 'app_versions', filter: 'app_name=eq.' + APP }, function (evs, info) {
      if (info.resync) { check('force'); return; }
      evs.forEach(function (p) { var row = p.new; if (row && row.version && row.status !== 'rolled_back') consider(row.version); });
    }, { debounce: 0 });
  }
  // "Prepare the update" in the background: warm the browser cache with the new page and its
  // versioned JS/CSS, so Update now is a single quick reload. Nothing running is replaced.
  var prefetched = {};
  function prefetch(v) {
    if (prefetched[v] || EMBEDDED) return; prefetched[v] = true;
    try {
      var u = new URL(location.href); u.searchParams.set('_v', v);
      fetch(u.toString(), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (html) {
        var re = /(?:src|href)="([^":?#]+\.(?:js|css)\?v=[^"]+)"/g, m, seen = {};
        while ((m = re.exec(html))) { if (!seen[m[1]]) { seen[m[1]] = 1; fetch(m[1], { credentials: 'same-origin' }).catch(function () {}); } }
      }).catch(function () {});
    } catch (_) {}
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
    '.beu-chip{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;border-radius:999px;border:1px solid rgba(255,138,60,.4);background:#11162a;color:#ffb37a;font:700 12px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 10px 26px -10px rgba(0,0,0,.7);opacity:0;transition:opacity .25s}',
    '.beu-chip.on{opacity:1}.beu-chip:hover{color:#fff}',
    '.beu-cd{display:block;margin-top:4px;color:#e6e9f5;font-weight:600}',
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
    '@media (max-width:640px){.beu,.beu-chip{right:16px;bottom:calc(16px + 76px)}}'
  ].join('');
  function css() { if (document.getElementById('beu-css')) return; var s = document.createElement('style'); s.id = 'beu-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }
  var SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>';

  function closeUI() { if (ui) { var u = ui; ui = null; u.classList.remove('on'); setTimeout(function () { u.remove(); }, 260); } clearInterval(countdown); countdown = null; }
  var chipEl = null;
  // After "Later": a small "Update ready" chip stays in the corner as a quiet reminder.
  function showChip() {
    css();
    if (chipEl) return;
    chipEl = document.createElement('button');
    chipEl.type = 'button'; chipEl.className = 'beu-chip'; chipEl.innerHTML = SPARK + 'Update ready';
    chipEl.title = 'A new version of Broken English is ready — click to update';
    chipEl.addEventListener('click', function () { laterUntil = 0; hideChip(); show(busyReason() ? 'busy' : 'manual'); });
    document.body.appendChild(chipEl);
    requestAnimationFrame(function () { chipEl && chipEl.classList.add('on'); });
  }
  function hideChip() { if (chipEl) { chipEl.remove(); chipEl = null; } }
  function show(kind) {
    css();
    hideChip();
    if (ui && ui.dataset.kind === kind) return;
    closeUI();
    var d = document.createElement('div');
    d.className = 'beu'; d.dataset.kind = kind; d.setAttribute('role', 'status'); d.setAttribute('aria-live', 'polite');
    var head = '<div class="beu-t">' + SPARK + 'System update available</div>';
    if (kind === 'auto') {
      d.innerHTML = head + '<p class="beu-p">A new version of Broken English is ready to install. <span class="beu-cd">Updating in <b>' + Math.round(NOTICE_MS / 1000) + '</b> seconds…</span></p><div class="beu-bar"><i style="animation-duration:' + NOTICE_MS + 'ms"></i></div><div class="beu-b"><button type="button" data-a="later">Later</button><button type="button" class="pri" data-a="now">Update now</button></div>';
      var left = Math.round(NOTICE_MS / 1000), cd = d.querySelector('.beu-cd b');
      countdown = setInterval(function () {
        left--; if (cd) cd.textContent = Math.max(left, 0);
        if (left > 0) return;
        clearInterval(countdown); countdown = null;
        if (!busyReason()) applyUpdate(); else show('busy');      // started typing meanwhile → wait
      }, 1000);
    } else if (kind === 'busy') {
      d.innerHTML = head + '<p class="beu-p">Update available. Finish your current work before updating — nothing will reload while you are working.</p><div class="beu-b"><button type="button" data-a="later">Update later</button><button type="button" class="pri" data-a="now">Update now</button></div>';
    } else {
      d.innerHTML = head + '<p class="beu-p">A new version of Broken English is ready to install.</p><div class="beu-b"><button type="button" data-a="later">Later</button><button type="button" class="pri" data-a="now">Update now</button></div>';
    }
    d.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a === 'now') applyUpdate();
      else { laterUntil = Date.now() + LATER_MS; closeUI(); showChip(); }
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
    if (!latest || latest === running) return;
    if (Date.now() < laterUntil) { showChip(); return; }          // snoozed: quiet chip only
    if (!ui) { onNewVersion(); return; }                           // snooze over → remind again
    if (!busyReason() && ui.dataset.kind === 'busy') { closeUI(); onNewVersion(); } // work finished → safe now
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
  function start() { restoreResume(); listen(0); setTimeout(function () { check('force'); }, 4000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.BEUpdate = {
    get version() { return running; },
    get latest() { return latest; },
    check: function () { check('force'); },
    _consider: consider,
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
