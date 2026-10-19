/* ════════════════════════════════════════════════════════════════════════════
   BESeason — seasonal / special-day decorations for the shared ERP top header ONLY
   (be-shell.js .bes-header: search, clock pill, date, bell, account). The page layout,
   colours and content are never touched; with no active theme nothing is added.

   Modules (one file, loaded on every portal after be-shell.js):
     PRESETS     theme config: what each preset draws (particles, button caps, overlay, accents)
     schedule()  picks the theme for today (Asia/Kolkata): enabled → manual on/off → date window
                 (yearly or one-off) → department → highest priority. Preview beats all.
     render()    draws one theme onto ANY header element (live header, admin preview mock):
                 a background layer (overlay + canvas particles, behind the controls) and a caps
                 layer (snow / droplets resting on top of buttons). Both pointer-events:none.
     decorate()  keeps the live header in sync (theme changes, resizes, realtime edits).
     mountAdmin  HR → Header Themes: create / edit / schedule / force on-off / preview / assets.

   Performance: one small canvas, ≤ 46 particles (≈ 40 % on phones), ~30 fps, paused when the
   tab is hidden or the header is off-screen; prefers-reduced-motion → still decorations only;
   images load only when a theme uses them. Viewers can turn effects off (account menu).
   Data: public.erp_header_themes (20261101_header_themes.sql).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BESeason) return;
  var TZ = 'Asia/Kolkata';
  var K_OFF = 'be_season_off', K_PREVIEW = 'be_season_preview', K_CACHE = 'be_season_cache';

  // ── theme config ─────────────────────────────────────────────────────────
  var PRESETS = {
    christmas:    { label: 'Christmas',        particles: 'snow',   caps: 'snow',  overlay: 'frost',    accent: '#cfe6ff', line: 'rgba(207,230,255,.28)', glow: 'rgba(186,220,255,.16)' },
    monsoon:      { label: 'Monsoon',          particles: 'rain',   caps: 'drops', overlay: 'mist',     accent: '#7dd3fc', line: 'rgba(125,211,252,.24)', glow: 'rgba(96,165,250,.12)' },
    summer:       { label: 'Summer',           particles: null,     caps: null,    overlay: 'sun',      accent: '#fbbf24', line: 'rgba(251,191,36,.26)',  glow: 'rgba(251,191,36,.14)' },
    navaratri:    { label: 'Navaratri',        particles: 'embers', caps: null,    overlay: 'diyas',    accent: '#f59e0b', line: 'rgba(245,158,11,.30)',  glow: 'rgba(245,158,11,.14)' },
    independence: { label: 'Independence Day', particles: null,     caps: null,    overlay: 'tricolor', accent: '#ff9933', line: 'rgba(255,255,255,.18)', glow: 'rgba(255,153,51,.10)' },
    custom:       { label: 'Custom',           particles: null,     caps: null,    overlay: null,       accent: '#ff8a3d', line: 'rgba(255,138,61,.24)',  glow: 'rgba(255,138,61,.12)' }
  };
  var EFFECTS = [['particles', 'Falling effect'], ['caps', 'Button decorations'], ['overlay', 'Header overlay'], ['glow', 'Glow'], ['accent', 'Accent colours']];
  var S = { client: null, themes: null, division: null, active: null, live: null, header: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function B() { return window.BESession || {}; }
  function db() {
    try { if (typeof dbInstance !== 'undefined' && dbInstance) return dbInstance; } catch (_) {}
    try { if (typeof sb !== 'undefined' && sb && sb.from) return sb; } catch (_) {}
    if (!S.client && window.supabase && B().url) S.client = window.supabase.createClient(B().url, B().anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    return S.client;
  }
  function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { return null; } }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (_) { return null; } }
  function reducedMotion() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function isPhone() { return window.matchMedia && matchMedia('(max-width: 767px)').matches; }
  function lowPower() { var n = navigator.hardwareConcurrency || 4, m = navigator.deviceMemory || 4; return n <= 2 || m <= 2; }
  function cfgOf(t) {
    var p = PRESETS[t.preset] || PRESETS.custom, c = t.config || {};
    var on = function (k) { return c[k] !== false; };
    return { preset: t.preset, label: t.name || p.label, particles: on('particles') ? p.particles : null, caps: on('caps') ? p.caps : null,
      overlay: on('overlay') ? p.overlay : null, glow: on('glow'), accent: on('accent'), intensity: c.intensity === 'normal' ? 'normal' : 'subtle',
      colors: p, asset: t.asset_url || null };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Scheduler
  // ════════════════════════════════════════════════════════════════════════
  function inWindow(t, d) {
    if (!t.start_date || !t.end_date) return false;
    if (!t.repeat_yearly) return d >= t.start_date && d <= t.end_date;
    var md = d.slice(5), a = String(t.start_date).slice(5), b = String(t.end_date).slice(5);
    return a <= b ? (md >= a && md <= b) : (md >= a || md <= b);   // e.g. Dec 28 – Jan 3
  }
  function appliesTo(t, division) { return !t.departments || !t.departments.length || (division && t.departments.indexOf(division) > -1); }
  function statusOf(t, d) {
    if (!t.enabled) return 'disabled';
    if (t.manual_state === 'off') return 'off';
    if (t.manual_state === 'on') return 'forced';
    if (!t.start_date || !t.end_date) return 'nodates';
    if (!t.auto_active) return 'manual';
    return inWindow(t, d || today()) ? 'active' : 'scheduled';
  }
  function schedule(themes, division, d) {
    d = d || today();
    var live = (themes || []).filter(function (t) { var s = statusOf(t, d); return (s === 'forced' || s === 'active') && appliesTo(t, division); });
    live.sort(function (a, b) { return (b.manual_state === 'on') - (a.manual_state === 'on') || (b.priority || 0) - (a.priority || 0) || String(b.start_date || '').localeCompare(String(a.start_date || '')); });
    return live[0] || null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Renderer — draws one theme on a header element; returns a destroy() function
  // ════════════════════════════════════════════════════════════════════════
  function css() {
    if (document.getElementById('bst-css')) return;
    var s = document.createElement('style'); s.id = 'bst-css';
    s.textContent = [
      '.bst{position:relative;isolation:isolate}',
      '.bst-bg,.bst-caps{position:absolute;left:0;right:0;top:-14px;bottom:0;pointer-events:none;overflow:hidden;border-radius:14px}',
      '.bst-bg{z-index:-1}.bst-caps{z-index:3;overflow:visible}',
      '.bst-bg canvas{position:absolute;inset:0;width:100%;height:100%}',
      /* line under the header + soft glow */
      '.bst.bst-glow{border-bottom-color:var(--bst-line)!important}',
      '.bst.bst-glow .bst-bg::after{content:"";position:absolute;left:8%;right:8%;bottom:-1px;height:28px;background:radial-gradient(60% 100% at 50% 100%,var(--bst-glow),transparent 70%)}',
      /* accents on the top controls (borders + icons only — text colours untouched) */
      '.bst.bst-accent .bes-icon,.bst.bst-accent .bes-date,.bst.bst-accent .bes-clockpill,.bst.bst-accent .bes-search{border-color:var(--bst-line)!important}',
      '.bst.bst-accent .bes-icon svg,.bst.bst-accent .bes-date svg{color:var(--bst-accent)}',
      '.bst.bst-accent .bes-av{box-shadow:0 0 0 2px var(--bst-line)!important}',
      /* overlays */
      '.bst-ov{position:absolute;inset:0}',
      '.bst-frost{background:linear-gradient(180deg,rgba(220,236,255,.07),transparent 55%)}',
      '.bst-mist{background:linear-gradient(180deg,rgba(125,211,252,.07),rgba(30,58,95,.04) 60%,transparent)}',
      '.bst-sun{background:radial-gradient(42% 130% at 88% -10%,rgba(251,191,36,.26),rgba(251,146,60,.08) 45%,transparent 72%)}',
      '.bst-sun i{position:absolute;top:6px;right:22%;width:60px;height:60px;border-radius:50%;background:radial-gradient(circle,rgba(255,236,179,.16),transparent 65%);animation:bstFlare 16s ease-in-out infinite alternate}',
      '@keyframes bstFlare{from{transform:translateX(0) scale(1);opacity:.7}to{transform:translateX(-120px) scale(1.25);opacity:1}}',
      '.bst-tri{background:linear-gradient(90deg,rgba(255,153,51,.10),transparent 30%,transparent 70%,rgba(19,136,8,.10))}',
      '.bst-tri::before{content:"";position:absolute;left:0;right:0;top:12px;height:2px;background:linear-gradient(90deg,#ff9933 0 33.3%,#f8fafc 33.3% 66.6%,#138808 66.6%);opacity:.75}',
      '.bst-diyas{background:linear-gradient(180deg,rgba(245,158,11,.06),transparent 60%)}',
      '.bst-diya{position:absolute;top:0;width:14px;height:13px;transform:translateX(-50%)}',
      '.bst-diya i{position:absolute;left:50%;top:0;width:5px;height:8px;margin-left:-2.5px;border-radius:50% 50% 50% 50%/60% 60% 40% 40%;background:radial-gradient(circle at 50% 70%,#fff7cc,#fbbf24 45%,rgba(249,115,22,.0) 75%);filter:drop-shadow(0 0 4px rgba(251,191,36,.8));animation:bstFlick 1.8s ease-in-out infinite alternate}',
      '.bst-diya b{position:absolute;left:0;right:0;bottom:0;height:6px;border-radius:0 0 10px 10px;background:linear-gradient(180deg,#d97706,#92400e);box-shadow:0 0 10px rgba(245,158,11,.35)}',
      '@keyframes bstFlick{from{transform:scale(1,1);opacity:.85}to{transform:scale(.9,1.12);opacity:1}}',
      '.bst-asset{position:absolute;right:12px;top:14px;height:calc(100% - 14px);max-height:46px;opacity:.85;object-fit:contain}',
      /* caps resting on the buttons */
      '.bst-cap{position:absolute;pointer-events:none}',
      '.bst-cap.snow{height:7px;border-radius:7px 7px 3px 3px;background:radial-gradient(10px 6px at 18% 70%,#fff,transparent 70%),radial-gradient(14px 7px at 50% 75%,#fff,transparent 70%),radial-gradient(12px 6px at 82% 70%,#fff,transparent 70%),linear-gradient(#f8fbff,#e6f0ff);opacity:.9;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}',
      '.bst-cap.snow::after{content:"";position:absolute;left:28%;top:5px;width:3px;height:4px;border-radius:0 0 3px 3px;background:#eef5ff}',
      '.bst-cap.drops{width:5px;height:7px;border-radius:50% 50% 50% 50%/60% 60% 40% 40%;background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.9),rgba(125,211,252,.55) 45%,rgba(59,130,246,.25));box-shadow:0 1px 2px rgba(0,0,0,.3)}',
      '.bst-independence.bst-accent .bes-clockpill .bcp-btn{box-shadow:inset 0 2px 0 #ff9933,inset 0 -2px 0 #138808}',
      '.bst-independence.bst-accent .bes-av{box-shadow:0 0 0 2px #ff9933,0 0 0 4px rgba(19,136,8,.6)!important}',
      '.bsa-pv .be-sel-wrap{width:auto!important;min-width:220px}',
      '@media (prefers-reduced-motion:reduce){.bst-sun i,.bst-diya i{animation:none}}',
      /* preview chip + admin */
      '.bst-chip{position:fixed;left:16px;bottom:16px;z-index:9400;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:999px;background:#11182a;border:1px solid rgba(255,138,61,.35);color:#e6e9f5;font:600 12.5px Inter,system-ui,sans-serif;box-shadow:0 14px 40px -12px rgba(0,0,0,.8)}',
      '.bst-chip button{height:28px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font:inherit;cursor:pointer}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function render(header, theme, opts) {
    if (!header || !theme) return function () {};
    css(); opts = opts || {};
    var c = cfgOf(theme), phone = isPhone() || opts.compact, still = reducedMotion() || ls(K_OFF) === 'motion';
    header.classList.add('bst', 'bst-' + c.preset);
    if (c.glow) header.classList.add('bst-glow');
    if (c.accent) header.classList.add('bst-accent');
    header.style.setProperty('--bst-accent', c.colors.accent);
    header.style.setProperty('--bst-line', c.colors.line);
    header.style.setProperty('--bst-glow', c.colors.glow);
    var bg = document.createElement('div'); bg.className = 'bst-bg'; bg.setAttribute('aria-hidden', 'true');
    var caps = document.createElement('div'); caps.className = 'bst-caps'; caps.setAttribute('aria-hidden', 'true');
    header.insertBefore(bg, header.firstChild); header.appendChild(caps);
    // overlay
    if (c.overlay) {
      var ov = document.createElement('div'); ov.className = 'bst-ov bst-' + ({ frost: 'frost', mist: 'mist', sun: 'sun', tricolor: 'tri', diyas: 'diyas' }[c.overlay]);
      if (c.overlay === 'sun') ov.innerHTML = '<i></i>';
      if (c.overlay === 'diyas') { var n = phone ? 3 : 7; for (var k = 0; k < n; k++) { var dv = document.createElement('span'); dv.className = 'bst-diya'; dv.style.left = (100 * (k + 0.5) / n) + '%'; dv.style.animationDelay = (k * 0.3) + 's'; dv.innerHTML = '<i style="animation-delay:' + (k * 0.27) + 's"></i><b></b>'; ov.appendChild(dv); } }
      bg.appendChild(ov);
    }
    if (c.asset && !phone) { var img = new Image(); img.className = 'bst-asset'; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.onerror = function () { img.remove(); }; img.src = c.asset; bg.appendChild(img); }
    // caps on the top controls
    var TARGETS = '.bes-clockpill .bcp-btn,.bes-date,.bes-icon,.bes-account .bes-av,.bes-search';
    function placeCaps() {
      if (!c.caps) return;
      caps.innerHTML = '';
      var hr = header.getBoundingClientRect();
      header.querySelectorAll(TARGETS).forEach(function (el) {
        var r = el.getBoundingClientRect(); if (!r.width || !r.height || el.offsetParent === null) return;
        var x = r.left - hr.left, y = r.top - hr.top + 14;   // caps layer starts 14px above the header
        if (c.caps === 'snow') {
          var w = Math.max(16, Math.min(r.width - 6, phone ? 60 : 120));
          var cap = document.createElement('i'); cap.className = 'bst-cap snow';
          cap.style.left = (x + (r.width - w) / 2) + 'px'; cap.style.top = (y - 4) + 'px'; cap.style.width = w + 'px';
          caps.appendChild(cap);
        } else if (c.caps === 'drops') {
          [[0.78, 1], [0.86, 6]].forEach(function (p, j) { if (phone && j) return; var dr = document.createElement('i'); dr.className = 'bst-cap drops'; dr.style.left = (x + r.width * p[0]) + 'px'; dr.style.top = (y + p[1]) + 'px'; caps.appendChild(dr); });
        }
      });
    }
    placeCaps();
    var ro = window.ResizeObserver ? new ResizeObserver(function () { placeCaps(); sizeCanvas(); }) : null;
    if (ro) ro.observe(header);
    var mo = new MutationObserver(function () { clearTimeout(mo.t); mo.t = setTimeout(placeCaps, 150); });
    mo.observe(header, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    // particles (one canvas, capped count, ~30 fps, paused off-screen / hidden)
    var cv = null, ctx = null, parts = [], raf = 0, last = 0, visible = true, W = 0, H = 0, io = null;
    function sizeCanvas() {
      if (!cv) return; var r = bg.getBoundingClientRect(), dpr = Math.min(1.5, window.devicePixelRatio || 1);
      W = r.width; H = r.height; cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (c.particles && !(phone && lowPower())) {
      cv = document.createElement('canvas'); bg.appendChild(cv); ctx = cv.getContext('2d'); sizeCanvas();
      var base = { snow: 46, rain: 38, embers: 18 }[c.particles] || 20;
      var count = Math.round(base * (phone ? 0.4 : 1) * (c.intensity === 'normal' ? 1.3 : 1));
      var rnd = function (a, b) { return a + Math.random() * (b - a); };
      var spawn = function (fresh) {
        if (c.particles === 'snow') return { x: rnd(0, W), y: fresh ? rnd(-10, H) : -6, r: rnd(0.6, 1.9), v: rnd(0.15, 0.45), s: rnd(0, 6.28), a: rnd(0.35, 0.8) };
        if (c.particles === 'rain') return { x: rnd(0, W + 40), y: fresh ? rnd(-20, H) : -14, l: rnd(7, 13), v: rnd(3.5, 6), a: rnd(0.12, 0.3) };
        return { x: rnd(0, W), y: fresh ? rnd(0, H) : H + 4, r: rnd(0.6, 1.6), v: rnd(0.12, 0.35), s: rnd(0, 6.28), a: rnd(0.3, 0.8) };
      };
      for (var q = 0; q < count; q++) parts.push(spawn(true));
      var draw = function () {
        ctx.clearRect(0, 0, W, H);
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          if (c.particles === 'snow') { ctx.globalAlpha = p.a; ctx.fillStyle = '#f2f7ff'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill(); }
          else if (c.particles === 'rain') { ctx.globalAlpha = p.a; ctx.strokeStyle = '#a5d8ff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.l * 0.25, p.y + p.l); ctx.stroke(); }
          else { ctx.globalAlpha = p.a * (0.6 + 0.4 * Math.sin(p.s)); ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill(); }
        }
        ctx.globalAlpha = 1;
      };
      var step = function (t) {
        raf = requestAnimationFrame(step);
        if (!visible || document.hidden || t - last < 33) return; last = t;
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          if (c.particles === 'snow') { p.y += p.v; p.s += 0.02; p.x += Math.sin(p.s) * 0.25; if (p.y > H + 4) parts[i] = spawn(false); }
          else if (c.particles === 'rain') { p.y += p.v; p.x -= p.v * 0.25; if (p.y > H) parts[i] = spawn(false); }
          else { p.y -= p.v; p.s += 0.08; p.x += Math.sin(p.s) * 0.2; if (p.y < -4) parts[i] = spawn(false); }
        }
        draw();
      };
      if (still) draw();   // reduced motion: a still scene, no animation
      else {
        if (window.IntersectionObserver) { io = new IntersectionObserver(function (es) { visible = es[0] && es[0].isIntersecting; }); io.observe(header); }
        raf = requestAnimationFrame(step);
      }
    }
    return function destroy() {
      cancelAnimationFrame(raf); if (ro) ro.disconnect(); mo.disconnect(); if (io) io.disconnect();
      bg.remove(); caps.remove();
      header.classList.remove('bst', 'bst-' + c.preset, 'bst-glow', 'bst-accent');
      ['--bst-accent', '--bst-line', '--bst-glow'].forEach(function (v) { header.style.removeProperty(v); });
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Header decorator — keeps the live header in sync
  // ════════════════════════════════════════════════════════════════════════
  async function loadThemes(force) {
    if (!force && S.themes) return S.themes;
    if (!force) { try { var c = JSON.parse(ss(K_CACHE) || 'null'); if (c && Date.now() - c.at < 600000) { S.themes = c.rows; return S.themes; } } catch (_) {} }
    var r = await db().from('erp_header_themes').select('*');
    if (r.error) { S.themes = []; return S.themes; }   // table not created yet → default header
    S.themes = r.data || []; ss(K_CACHE, JSON.stringify({ at: Date.now(), rows: S.themes }));
    return S.themes;
  }
  async function myDivision() {
    if (S.division !== null) return S.division;
    var email = B().currentEmail ? String(B().currentEmail() || '').toLowerCase() : '';
    var k = 'be_season_div:' + email, c = ss(k);
    if (c !== null) { S.division = c; return c; }
    S.division = '';
    if (email && db()) { try { var r = await db().from('hr_employees').select('division').ilike('portal_email', email.replace(/[\\%_]/g, function (x) { return '\\' + x; })).limit(1); S.division = (r.data && r.data[0] && r.data[0].division) || ''; } catch (_) {} }
    ss(k, S.division); return S.division;
  }
  function previewTheme() {
    var p = null; try { p = JSON.parse(ss(K_PREVIEW) || 'null'); } catch (_) {}
    if (!p) return null;
    if (p.id) { var t = (S.themes || []).filter(function (x) { return x.id === p.id; })[0]; if (t) return t; }
    if (p.preset && PRESETS[p.preset]) return { id: 'preview', preset: p.preset, name: PRESETS[p.preset].label, config: p.config || {}, asset_url: p.asset_url || null };
    return null;
  }
  function chip(theme) {
    var old = document.querySelector('.bst-chip'); if (old) old.remove();
    if (!theme) return;
    var el = document.createElement('div'); el.className = 'bst-chip'; el.setAttribute('role', 'status');
    el.innerHTML = '<span>Previewing <b>' + esc(theme.name || (PRESETS[theme.preset] || {}).label) + '</b></span><button type="button">Stop preview</button>';
    el.querySelector('button').onclick = function () { stopPreview(); };
    document.body.appendChild(el);
  }
  async function decorate() {
    css();
    var header = document.querySelector('.bes-header');
    if (!header) return;
    if (S.header !== header && S.live) { try { S.live(); } catch (_) {} S.live = null; S.active = null; }
    S.header = header;
    var pv = previewTheme();
    var t = pv || (ls(K_OFF) === '1' ? null : schedule(await loadThemes(), await myDivision()));
    chip(pv);
    var key = t ? t.id + '|' + (t.updated_at || '') + '|' + JSON.stringify(t.config || {}) + '|' + t.preset : '';
    if (key === S.active) return;
    if (S.live) { try { S.live(); } catch (_) {} S.live = null; }
    S.active = key;
    if (t) { try { S.live = render(header, t); } catch (e) { console.warn('[BESeason]', e); } }   // never let decoration break the header
  }
  function preview(target) {
    var v = typeof target === 'string' ? (PRESETS[target] ? { preset: target } : { id: target }) : target;
    ss(K_PREVIEW, JSON.stringify(v)); S.active = null; decorate();
  }
  function stopPreview() { ss(K_PREVIEW, null); S.active = null; decorate(); }
  function setEnabledForMe(on) { ls(K_OFF, on ? null : '1'); S.active = null; decorate(); }
  function menuRow() {
    var on = ls(K_OFF) !== '1';
    return '<button class="am-item" data-am-action="season"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg> Seasonal effects <span style="margin-left:auto;font-size:11px;color:' + (on ? '#34d399' : '#8b93b8') + '">' + (on ? 'On' : 'Off') + '</span></button>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // Admin — HR → Header Themes
  // ════════════════════════════════════════════════════════════════════════
  function acss() {
    if (document.getElementById('bst-admin-css')) return;
    var s = document.createElement('style'); s.id = 'bst-admin-css';
    s.textContent = [
      '.bsa{color:#e6e9f5;font-family:inherit;display:flex;flex-direction:column;gap:16px}',
      '.bsa *{box-sizing:border-box}',
      '.bsa-top{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}.bsa-top h2{margin:0;font-size:22px;font-weight:800;color:#fff}.bsa-top p{margin:4px 0 0;color:#8b93b8;font-size:12.5px}',
      '.bsa-btn{height:38px;padding:0 16px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#e6e9f5;font:inherit;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}',
      '.bsa-btn.pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f 55%,#ff0552)}.bsa-btn.sm{height:30px;padding:0 11px;font-size:12px}.bsa-btn:disabled{opacity:.6;cursor:progress}',
      '.bsa-pv{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.02)}.bsa-pv span{font-size:12px;color:#8b93b8}',
      '.bsa-list{display:flex;flex-direction:column;gap:8px}',
      '.bsa-row{display:grid;grid-template-columns:44px minmax(0,1.4fr) minmax(0,1fr) auto auto;gap:14px;align-items:center;padding:12px 14px;border-radius:14px;background:#0e1222;border:1px solid rgba(255,255,255,.07)}',
      '.bsa-sw{width:44px;height:30px;border-radius:9px;position:relative;overflow:hidden;border:1px solid rgba(255,255,255,.1)}',
      '.bsa-row b{display:block;color:#fff;font-size:14px}.bsa-row small{display:block;color:#8b93b8;font-size:11.5px;margin-top:2px}',
      '.bsa-pill{height:22px;padding:0 9px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.04em;display:inline-flex;align-items:center;border:1px solid rgba(255,255,255,.1);color:#8b93b8;white-space:nowrap}',
      '.bsa-pill.on{color:#6ee7b7;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}.bsa-pill.sch{color:#93c5fd;border-color:rgba(96,165,250,.35)}.bsa-pill.warn{color:#fcd34d;border-color:rgba(252,211,77,.35)}',
      '.bsa-seg{display:inline-grid;grid-template-columns:repeat(3,auto);gap:2px;padding:3px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07)}.bsa-seg button{height:26px;padding:0 10px;border:0;border-radius:7px;background:none;color:#8b93b8;font:inherit;font-size:11.5px;font-weight:700;cursor:pointer}.bsa-seg button.on{background:rgba(255,107,6,.16);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,107,6,.45)}',
      '.bsa-acts{display:flex;gap:6px;align-items:center}',
      '.bsa-ov{position:fixed;inset:0;z-index:9300;display:grid;place-items:center;padding:16px;background:rgba(3,5,9,.66);backdrop-filter:blur(4px)}',
      '.bsa-dlg{box-sizing:border-box;width:min(980px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:18px;background:#0e1222;border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 80px -20px rgba(0,0,0,.85);padding:22px;display:flex;flex-direction:column;gap:16px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}',
      '.bsa-dlg h3{margin:0;font-size:18px;color:#fff}.bsa-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}',
      '.bsa-col{display:flex;flex-direction:column;gap:14px;min-width:0}.bsa-f{display:flex;flex-direction:column;gap:6px}.bsa-f>label,.bsa-f>span{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#6b74a0}',
      '.bsa-in{width:100%;height:38px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.08)!important;background:rgba(255,255,255,.03)!important;color:#fff!important;font:inherit;font-size:13px!important;outline:none}',
      '.bsa .be-sel-wrap,.bsa .be-date-wrap{width:100%!important}',
      '.bsa-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.bsa-chips{display:flex;flex-wrap:wrap;gap:6px}.bsa-ch{height:30px;padding:0 11px;border-radius:999px;border:1px solid rgba(255,255,255,.09);background:none;color:#8b93b8;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.bsa-ch.on{color:#fff;border-color:rgba(255,107,6,.55);background:rgba(255,107,6,.12)}',
      '.bsa-mock{border-radius:14px;padding:14px 14px 0;background:#090c16;border:1px solid rgba(255,255,255,.07);overflow:hidden}',
      '.bsa-mock .bes-header{margin:0!important;gap:8px}.bsa-mock .bes-search{flex:1 1 60px;min-width:0;max-width:120px}.bsa-mock .bes-search span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bsa-mock .bes-right{gap:6px;min-width:0}.bsa-mock .bes-date span{display:none}.bsa-mock .bes-date{width:38px;padding:0;justify-content:center}.bsa-mock .bcp-txt{white-space:nowrap}',
      '.bsa-note{font-style:normal}',
      '.bsa-note{font-size:11.5px;color:#6b74a0}.bsa-err{color:#f87171;font-size:12.5px}',
      '.bsa-foot{display:flex;justify-content:flex-end;gap:8px}',
      '@media(max-width:860px){.bsa-row{grid-template-columns:44px minmax(0,1fr);}.bsa-row>.bsa-when,.bsa-row>.bsa-seg,.bsa-row>.bsa-acts{grid-column:1/-1}.bsa-grid{grid-template-columns:1fr}}'
    ].join('\n');
    document.head.appendChild(s);
  }
  function rangeText(t) {
    if (!t.start_date || !t.end_date) return 'No dates set';
    var f = function (d) { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: t.repeat_yearly ? undefined : 'numeric' }); };
    return (t.start_date === t.end_date ? f(t.start_date) : f(t.start_date) + ' – ' + f(t.end_date)) + (t.repeat_yearly ? ' · every year' : '');
  }
  var ST_LABEL = { active: ['Active now', 'on'], forced: ['On (manual)', 'on'], scheduled: ['Scheduled', 'sch'], off: ['Off (manual)', ''], disabled: ['Disabled', ''], nodates: ['Needs dates', 'warn'], manual: ['Manual only', ''] };
  function mockHeader() {
    return '<div class="bes-header" style="position:relative"><button type="button" class="bes-search" tabindex="-1" style="pointer-events:none"><span>Search tasks, videos…</span></button><div class="bes-right">'
      + '<div class="bes-clockpill" style="pointer-events:none"><span class="bcp-dot"></span><span class="bcp-txt">In since <b>10:29 AM</b></span><button type="button" class="bcp-btn" tabindex="-1">Clock Out</button></div>'
      + '<div class="bes-date"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg><span>Oct 19, 2026</span></div><button type="button" class="bes-icon" tabindex="-1" style="pointer-events:none"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/></svg></button>'
      + '<button type="button" class="bes-account" tabindex="-1" style="pointer-events:none"><span class="bes-av">AB</span></button></div></div>';
  }
  async function mountAdmin(el, opts) {
    if (!el) return; css(); acss(); opts = opts || {};
    el.classList.add('bsa');
    el.innerHTML = '<div class="bsa-note">Loading themes…</div>';
    var rows = await loadThemes(true);
    var divs = [];
    try { var dr = await db().from('hr_divisions').select('code,name,active').order('sort_order'); divs = (dr.data || []).filter(function (d) { return d.active !== false; }); } catch (_) {}
    var d0 = today();
    rows.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name); });
    var cur = schedule(rows, null, d0);
    el.innerHTML = '<div class="bsa-top"><div style="flex:1;min-width:220px"><h2>Header Themes</h2><p>Seasonal and special-day decorations for the ERP top header. Today: ' + (cur ? '<b style="color:#fff">' + esc(cur.name) + '</b> is live for all departments it applies to.' : 'no theme is active — the normal header shows.') + '</p></div><button type="button" class="bsa-btn pri" data-new>+ Add theme</button></div>'
      + '<div class="bsa-pv"><span>Preview any theme on this page</span><select class="bsa-in" data-pv style="width:auto;min-width:200px">' + Object.keys(PRESETS).filter(function (k) { return k !== 'custom'; }).map(function (k) { return '<option value="p:' + k + '">' + esc(PRESETS[k].label) + ' (preset)</option>'; }).join('') + rows.map(function (t) { return '<option value="t:' + t.id + '">' + esc(t.name) + '</option>'; }).join('') + '</select><button type="button" class="bsa-btn sm" data-pvgo>Preview</button><button type="button" class="bsa-btn sm" data-pvstop>Stop preview</button></div>'
      + '<div class="bsa-list">' + (rows.length ? rows.map(function (t) {
          var st = statusOf(t, d0), L = ST_LABEL[st] || [st, ''], p = PRESETS[t.preset] || PRESETS.custom;
          return '<div class="bsa-row" data-id="' + t.id + '"><span class="bsa-sw" data-sw="' + t.id + '" style="background:linear-gradient(135deg,' + p.glow + ',#0b0f1c)"></span>'
            + '<div><b>' + esc(t.name) + '</b><small>' + esc(p.label) + ' · priority ' + (t.priority || 0) + ' · ' + (t.departments && t.departments.length ? esc(t.departments.map(function (c) { var d = divs.filter(function (x) { return x.code === c; })[0]; return d ? d.name : c; }).join(', ')) : 'All departments') + '</small></div>'
            + '<div class="bsa-when"><span class="bsa-pill ' + L[1] + '">' + esc(L[0]) + '</span><small style="color:#8b93b8;font-size:11.5px;margin-top:4px;display:block">' + esc(rangeText(t)) + '</small></div>'
            + '<div class="bsa-seg" role="group" aria-label="Activation">' + [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']].map(function (m) { return '<button type="button" data-ms="' + m[0] + '" class="' + (t.manual_state === m[0] ? 'on' : '') + '">' + m[1] + '</button>'; }).join('') + '</div>'
            + '<div class="bsa-acts"><button type="button" class="bsa-btn sm" data-pvid="' + t.id + '">Preview</button><button type="button" class="bsa-btn sm" data-edit="' + t.id + '">Edit</button></div></div>';
        }).join('') : '<div class="bsa-note">No themes yet. Run 20261101_header_themes.sql to add the built-in presets.</div>') + '</div>'
      + '<p class="bsa-note">Only the top header changes (search, clock, date, bell, profile). Effects pause off-screen, shrink on phones, stay still for reduced-motion users, and anyone can switch them off from their account menu.</p>';
    el.onclick = async function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-new')) return editor(null, divs, function () { mountAdmin(el, opts); });
      if (b.hasAttribute('data-edit')) return editor(rows.filter(function (t) { return t.id === b.getAttribute('data-edit'); })[0], divs, function () { mountAdmin(el, opts); });
      if (b.hasAttribute('data-pvid')) return preview(b.getAttribute('data-pvid'));
      if (b.hasAttribute('data-pvstop')) return stopPreview();
      if (b.hasAttribute('data-pvgo')) { var v = el.querySelector('[data-pv]').value; return preview(v.slice(0, 2) === 'p:' ? v.slice(2) : v.slice(2)); }
      if (b.hasAttribute('data-ms')) {
        var id = b.closest('[data-id]').getAttribute('data-id'), ms = b.getAttribute('data-ms');
        b.parentNode.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
        var r = await db().from('erp_header_themes').update({ manual_state: ms, updated_at: new Date().toISOString(), updated_by: who() }).eq('id', id);
        if (r.error) toast('error', 'Could not update: ' + r.error.message); else { ss(K_CACHE, null); S.themes = null; mountAdmin(el, opts); decorate(); }
      }
    };
    // tiny live swatches (still render of each theme)
    rows.forEach(function (t) { var sw = el.querySelector('[data-sw="' + t.id + '"]'); if (sw) sw.title = (PRESETS[t.preset] || PRESETS.custom).label; });
  }
  function who() { try { if (typeof currentUser !== 'undefined' && currentUser && currentUser.name) return currentUser.name; } catch (_) {} return B().currentEmail ? B().currentEmail() : ''; }
  function toast(k, m) { if (typeof window.showToast === 'function') return window.showToast(k, m); }

  function editor(src, divs, onDone) {
    acss(); css();
    var f = src ? JSON.parse(JSON.stringify(src)) : { preset: 'custom', name: '', start_date: today(), end_date: today(), repeat_yearly: false, auto_active: true, manual_state: 'auto', priority: 50, departments: [], enabled: true, config: {}, asset_url: '' };
    f.config = f.config || {};
    var ov = document.createElement('div'); ov.className = 'bsa-ov bsa';
    ov.innerHTML = '<div class="bsa-dlg" role="dialog" aria-modal="true" aria-label="Header theme"></div>';
    document.body.appendChild(ov);
    var dlg = ov.querySelector('.bsa-dlg'), stopPv = null, busy = false;
    var close = function () { if (stopPv) stopPv(); ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    function draw() {
      dlg.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><div><h3>' + (src ? 'Edit theme' : 'New theme') + '</h3><p class="bsa-note" style="margin:4px 0 0">Dates use India time. Repeating themes only use day and month.</p></div><button type="button" class="bsa-btn sm" data-x aria-label="Close">×</button></div>'
        + '<div class="bsa-grid"><div class="bsa-col">'
        + '<div class="bsa-f"><label>Theme name</label><input class="bsa-in" data-k="name" maxlength="60" value="' + esc(f.name) + '" placeholder="e.g. Diwali"></div>'
        + '<div class="bsa-f"><label>Style</label><select class="bsa-in" data-k="preset">' + Object.keys(PRESETS).map(function (k) { return '<option value="' + k + '"' + (f.preset === k ? ' selected' : '') + '>' + esc(PRESETS[k].label) + '</option>'; }).join('') + '</select></div>'
        + '<div class="bsa-row2"><div class="bsa-f"><label>Start date</label><input class="bsa-in" type="date" data-k="start_date" value="' + esc(f.start_date || '') + '"></div><div class="bsa-f"><label>End date</label><input class="bsa-in" type="date" data-k="end_date" value="' + esc(f.end_date || '') + '"></div></div>'
        + '<div class="bsa-f"><span>Schedule</span><div class="bsa-chips"><button type="button" class="bsa-ch' + (f.repeat_yearly ? ' on' : '') + '" data-tog="repeat_yearly">Repeat every year</button><button type="button" class="bsa-ch' + (f.auto_active ? ' on' : '') + '" data-tog="auto_active">Auto-activate on these dates</button><button type="button" class="bsa-ch' + (f.enabled ? ' on' : '') + '" data-tog="enabled">Enabled</button></div></div>'
        + '<div class="bsa-row2"><div class="bsa-f"><label>Activation</label><select class="bsa-in" data-k="manual_state"><option value="auto"' + (f.manual_state === 'auto' ? ' selected' : '') + '>Automatic (by date)</option><option value="on"' + (f.manual_state === 'on' ? ' selected' : '') + '>On now (manual)</option><option value="off"' + (f.manual_state === 'off' ? ' selected' : '') + '>Off (manual)</option></select></div>'
        + '<div class="bsa-f"><label>Priority</label><select class="bsa-in" data-k="priority">' + [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(function (n) { return '<option value="' + n + '"' + (+f.priority === n ? ' selected' : '') + '>' + n + (n === 100 ? ' (highest)' : n === 10 ? ' (lowest)' : '') + '</option>'; }).join('') + '</select></div></div>'
        + '<div class="bsa-f"><span>Applies to</span><div class="bsa-chips"><button type="button" class="bsa-ch' + (!f.departments.length ? ' on' : '') + '" data-dep="">All departments</button>' + divs.map(function (d) { return '<button type="button" class="bsa-ch' + (f.departments.indexOf(d.code) > -1 ? ' on' : '') + '" data-dep="' + esc(d.code) + '">' + esc(d.name) + '</button>'; }).join('') + '</div></div>'
        + '</div><div class="bsa-col">'
        + '<div class="bsa-f"><span>Preview</span><div class="bsa-mock" data-mock>' + mockHeader() + '</div></div>'
        + '<div class="bsa-f"><span>Effects</span><div class="bsa-chips">' + EFFECTS.map(function (x) { return '<button type="button" class="bsa-ch' + (f.config[x[0]] !== false ? ' on' : '') + '" data-fx="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div><em class="bsa-note">Effects a style doesn’t have are ignored (e.g. Summer has no falling effect).</em></div>'
        + '<div class="bsa-f"><span>Intensity</span><div class="bsa-chips"><button type="button" class="bsa-ch' + (f.config.intensity !== 'normal' ? ' on' : '') + '" data-int="subtle">Subtle</button><button type="button" class="bsa-ch' + (f.config.intensity === 'normal' ? ' on' : '') + '" data-int="normal">Normal</button></div></div>'
        + '<div class="bsa-f"><label>Decorative image (optional)</label><div style="display:flex;gap:8px"><input class="bsa-in" data-k="asset_url" placeholder="https:// — PNG / SVG / WebP" value="' + esc(f.asset_url || '') + '"><button type="button" class="bsa-btn sm" data-up style="height:38px">Upload</button><input type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" data-file hidden></div><em class="bsa-note">Shown small at the right of the header on desktop only.</em></div>'
        + '</div></div><div class="bsa-err" data-err></div>'
        + '<div class="bsa-foot">' + (src ? '<button type="button" class="bsa-btn" data-del style="margin-right:auto;color:#fca5a5">Delete</button>' : '') + '<button type="button" class="bsa-btn" data-x>Cancel</button><button type="button" class="bsa-btn pri" data-save>' + (src ? 'Save theme' : 'Create theme') + '</button></div>';
      if (stopPv) stopPv();
      var mh = dlg.querySelector('[data-mock] .bes-header');
      stopPv = render(mh, f, { compact: false });
    }
    function grab() { dlg.querySelectorAll('[data-k]').forEach(function (x) { var k = x.getAttribute('data-k'); f[k] = k === 'priority' ? +x.value : x.value; }); }
    dlg.addEventListener('change', function (e) { if (e.target.getAttribute && e.target.getAttribute('data-k') === 'preset') { grab(); if (!f.name || Object.keys(PRESETS).some(function (k) { return PRESETS[k].label === f.name; })) f.name = PRESETS[f.preset].label; draw(); } });
    dlg.addEventListener('click', async function (e) {
      var b = e.target.closest('button'); if (!b || busy) return;
      if (b.hasAttribute('data-x')) return close();
      if (b.hasAttribute('data-tog')) { grab(); var k = b.getAttribute('data-tog'); f[k] = !f[k]; b.classList.toggle('on', f[k]); return; }
      if (b.hasAttribute('data-dep')) { grab(); var c = b.getAttribute('data-dep'); if (!c) f.departments = []; else { var i = f.departments.indexOf(c); if (i > -1) f.departments.splice(i, 1); else f.departments.push(c); } return draw(); }
      if (b.hasAttribute('data-fx')) { grab(); var x = b.getAttribute('data-fx'); f.config[x] = f.config[x] === false; return draw(); }
      if (b.hasAttribute('data-int')) { grab(); f.config.intensity = b.getAttribute('data-int'); return draw(); }
      if (b.hasAttribute('data-up')) { var fi = dlg.querySelector('[data-file]'); fi.onchange = async function () {
          var file = fi.files && fi.files[0]; if (!file) return; if (file.size > 1024 * 1024) { dlg.querySelector('[data-err]').textContent = 'Image must be under 1 MB.'; return; }
          b.disabled = true; b.textContent = 'Uploading…';
          var path = 'header-themes/' + Date.now() + '-' + file.name.replace(/[^a-z0-9.\-]+/gi, '_');
          var up = await db().storage.from('celebration-media').upload(path, file, { contentType: file.type, upsert: true });
          b.disabled = false; b.textContent = 'Upload';
          if (up.error) { dlg.querySelector('[data-err]').textContent = 'Upload failed: ' + up.error.message; return; }
          grab(); f.asset_url = db().storage.from('celebration-media').getPublicUrl(path).data.publicUrl; draw();
        }; fi.click(); return; }
      if (b.hasAttribute('data-del')) {
        var ok = typeof window.showConfirm === 'function' ? await showConfirm('Delete “' + src.name + '”? The header goes back to normal while it would have been active.', { title: 'Delete theme?', confirmLabel: 'Delete' }) : false;
        if (!ok) return;
        busy = true; var dr = await db().from('erp_header_themes').delete().eq('id', src.id); busy = false;
        if (dr.error) { dlg.querySelector('[data-err]').textContent = dr.error.message; return; }
        ss(K_CACHE, null); S.themes = null; close(); decorate(); if (onDone) onDone(); return;
      }
      if (b.hasAttribute('data-save')) {
        grab();
        var err = !String(f.name || '').trim() ? 'Add a name.' : (f.start_date && f.end_date && !f.repeat_yearly && f.end_date < f.start_date) ? 'End date is before the start date.' : (f.auto_active && f.manual_state === 'auto' && (!f.start_date || !f.end_date)) ? 'Set start and end dates, or switch activation to manual.' : '';
        if (err) { dlg.querySelector('[data-err]').textContent = err; return; }
        busy = true; b.disabled = true; b.textContent = 'Saving…';
        var row = { preset: f.preset, name: String(f.name).trim().slice(0, 60), start_date: f.start_date || null, end_date: f.end_date || null, repeat_yearly: !!f.repeat_yearly, auto_active: !!f.auto_active,
          manual_state: f.manual_state, priority: +f.priority || 50, departments: f.departments, enabled: !!f.enabled, config: f.config, asset_url: String(f.asset_url || '').trim() || null, updated_by: who(), updated_at: new Date().toISOString() };
        var r = src ? await db().from('erp_header_themes').update(row).eq('id', src.id) : await db().from('erp_header_themes').insert(row);
        busy = false;
        if (r.error) { b.disabled = false; b.textContent = src ? 'Save theme' : 'Create theme'; dlg.querySelector('[data-err]').textContent = /erp_header_themes|relation|schema cache/i.test(r.error.message) ? 'Run 20261101_header_themes.sql first.' : r.error.message; return; }
        ss(K_CACHE, null); S.themes = null; close(); toast('success', src ? 'Theme saved' : 'Theme created'); decorate(); if (onDone) onDone();
      }
    });
    draw();
  }

  // ── boot ────────────────────────────────────────────────────────────────
  window.BESeason = { PRESETS: PRESETS, schedule: schedule, statusOf: statusOf, render: render, decorate: decorate, preview: preview, stopPreview: stopPreview,
    setEnabledForMe: setEnabledForMe, enabledForMe: function () { return ls(K_OFF) !== '1'; }, menuRow: menuRow, mountAdmin: mountAdmin };
  try { var q = new URLSearchParams(location.search).get('theme'); if (q && PRESETS[q]) ss(K_PREVIEW, JSON.stringify({ preset: q })); } catch (_) {}
  var embedded = /[?&]embed=1\b/.test(location.search) || window.self !== window.top;
  if (embedded) return;
  var tries = 0;
  (function boot() {
    if (!document.querySelector('.bes-header') || !db()) { if (++tries < 40) setTimeout(boot, 500); return; }
    decorate();
    // keep up with header rebuilds (account switch / route changes) and theme edits
    new MutationObserver(function () { var h = document.querySelector('.bes-header'); if (h && h !== S.header) decorate(); }).observe(document.body, { childList: true, subtree: true });
    if (window.BELive) BELive.on('be-season', [{ table: 'erp_header_themes', event: '*' }], function () { ss(K_CACHE, null); S.themes = null; S.active = null; decorate(); }, { debounce: 800 });
    setInterval(decorate, 15 * 60000);   // date rolls over at midnight IST; same theme → nothing redrawn
  })();
})();
