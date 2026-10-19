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
  // art: realistic banner shipped with the app (HR can replace or remove it per theme).
  // pal: colours for falling petals / flowers.
  var ART = (function () { try { return new URL('assets/header-themes/', (document.currentScript && document.currentScript.src) || location.href).href; } catch (_) { return 'assets/header-themes/'; } })();
  var PRESETS = {
    christmas:    { label: 'Christmas',        kind: 'festival', particles: 'snow',    caps: null,  overlay: 'frost',    art: null,    accent: '#cfe6ff', line: 'rgba(207,230,255,.28)', glow: 'rgba(186,220,255,.16)' },
    newyear:      { label: 'New Year',         kind: 'special',  particles: 'sparkle', caps: null,    overlay: 'night',    art: null,      accent: '#fbbf24', line: 'rgba(251,191,36,.28)',  glow: 'rgba(251,191,36,.14)' },
    independence: { label: 'Independence Day', kind: 'special',  particles: 'petals',  caps: null,    overlay: 'tricolor', art: null, accent: '#ff9933', line: 'rgba(255,255,255,.18)', glow: 'rgba(255,153,51,.10)', pal: ['#ff9933', '#f8fafc', '#16a34a', '#ff9933'] },
    vishu:        { label: 'Vishu',            kind: 'festival', particles: 'petals',  caps: null,    overlay: 'warm',     art: null,        accent: '#facc15', line: 'rgba(250,204,21,.28)',  glow: 'rgba(250,204,21,.14)', pal: ['#facc15', '#fde047', '#eab308', '#fbbf24'] },
    onam:         { label: 'Onam',             kind: 'festival', particles: 'petals',  caps: null,    overlay: 'warm',     art: null,         accent: '#f59e0b', line: 'rgba(245,158,11,.28)',  glow: 'rgba(245,158,11,.12)', pal: ['#f97316', '#facc15', '#e11d48', '#f8fafc', '#c026d3'] },
    navaratri:    { label: 'Navaratri',        kind: 'festival', particles: 'embers',  caps: null,    overlay: 'diyas',    art: null,                      accent: '#f59e0b', line: 'rgba(245,158,11,.30)',  glow: 'rgba(245,158,11,.14)' },
    monsoon:      { label: 'Monsoon',          kind: 'seasonal', particles: 'rain',    caps: 'drops', overlay: 'mist',     art: null,      accent: '#7dd3fc', line: 'rgba(125,211,252,.24)', glow: 'rgba(96,165,250,.12)' },
    summer:       { label: 'Summer',           kind: 'seasonal', particles: 'motes',   caps: null,    overlay: 'sun',      art: null,                      accent: '#fbbf24', line: 'rgba(251,191,36,.26)',  glow: 'rgba(251,191,36,.14)' },
    custom:       { label: 'Custom',           kind: 'custom',   particles: null,      caps: null,    overlay: null,       art: null,                      accent: '#ff8a3d', line: 'rgba(255,138,61,.24)',  glow: 'rgba(255,138,61,.12)' }
  };
  var KINDS = [['seasonal', 'Seasonal'], ['festival', 'Festival'], ['special', 'Special day'], ['custom', 'Custom event']];
  var PORTALS = [['media', 'Media'], ['academics', 'Academics'], ['sales', 'Sales'], ['hr', 'HR'], ['manager', 'Manager']];
  function currentPortal() { var f = (location.pathname.split('/').pop() || 'index.html').toLowerCase(); return { 'app.html': 'media', 'index.html': 'media', 'academics.html': 'academics', 'sales.html': 'sales', 'hr.html': 'hr', 'manager.html': 'manager' }[f] || ''; }
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
      colors: p, asset: t.asset_url || null,
      banner: c.banner === 'none' ? null : (c.banner || p.art || null), bannerBuiltin: !c.banner && !!p.art, pal: p.pal || null,
      bannerDark: ({ light: 0.08, medium: 0.2, strong: 0.38 })[c.banner_dark || 'light'], bannerPos: ({ top: 'center top', center: 'center center', bottom: 'center bottom' })[c.banner_pos || 'center'], bannerTall: c.banner_h === 'tall' };
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
  function appliesTo(t, division, portal) {
    if (t.portals && t.portals.length && portal !== undefined && t.portals.indexOf(portal) < 0) return false;
    return !t.departments || !t.departments.length || (division && t.departments.indexOf(division) > -1);
  }
  function statusOf(t, d) {
    if (!t.enabled) return 'disabled';
    if (t.manual_state === 'off') return 'off';
    if (t.manual_state === 'on') return 'forced';
    if (!t.start_date || !t.end_date) return 'nodates';
    if (!t.auto_active) return 'manual';
    return inWindow(t, d || today()) ? 'active' : 'scheduled';
  }
  function schedule(themes, division, d, portal) {
    d = d || today();
    var live = (themes || []).filter(function (t) { var s = statusOf(t, d); return (s === 'forced' || s === 'active') && appliesTo(t, division, portal); });
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
      /* themed header = a card with its own scene behind the controls */
      '.bst-bg{position:absolute;inset:0;z-index:-1;pointer-events:none;overflow:hidden;border-radius:12px;-webkit-mask:linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent);mask:linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent)}',
      '.bst-caps{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:visible}',
      '.bst-bg canvas{position:absolute;inset:0;width:100%;height:100%}',
      /* band layout: live scene across the top, controls on a frosted glass bar */
      '.bst-band .bst-bg{background:#080c17}',
      /* banner band + glass control bar (realistic themes) */
      '.bst-hasbanner .bst-bg{background:linear-gradient(180deg,#0b1020,#080c17)}',
      '.bst-banner{position:absolute;left:0;right:0;top:0;bottom:0;background-size:cover;background-repeat:no-repeat;opacity:0;transform:scale(1.015);transition:opacity .8s ease,transform 1.4s ease;-webkit-mask:linear-gradient(#000 62%,transparent);mask:linear-gradient(#000 62%,transparent)}',
      '.bst-banner.on{opacity:1;transform:none}.bst-banner::after{content:"";position:absolute;inset:0;background:rgba(5,8,16,var(--bst-dark,.08))}',
      '.bst-bar{position:absolute;left:7px;right:7px;bottom:6px;top:auto;border-radius:13px;background:rgba(9,12,22,.74);backdrop-filter:blur(12px) saturate(1.2);-webkit-backdrop-filter:blur(12px) saturate(1.2);border:1px solid rgba(255,255,255,.07);box-shadow:0 -10px 24px -14px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05)}',
      '.bst-hasbanner .bst-sky,.bst-hasbanner .bst-corner,.bst-hasbanner .bst-mid,.bst-hasbanner .bst-drift,.bst-hasbanner .bst-frost,.bst-hasbanner .bst-top{display:none!important}',
      '.bst-ny{position:absolute;top:0;bottom:0;display:flex;align-items:center;justify-content:center;gap:10px;--bst-band:46px;pointer-events:none;opacity:.95}',
      '.bst-ny em{font:400 calc(var(--bst-band,52px) * .42)/1 "Great Vibes","Snell Roundhand","Brush Script MT",cursive;color:#fde7b0;text-shadow:0 0 12px rgba(251,191,36,.45)}',
      '.bst-ny b{font:800 calc(var(--bst-band,52px) * .5)/1 Inter,system-ui,sans-serif;letter-spacing:.02em;background:linear-gradient(180deg,#fff3c4,#fbbf24 55%,#b45309);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 10px rgba(251,191,36,.5))}',
      '@media(max-width:900px){.bst-ny{display:none}}.bst-ny[hidden]{display:none}',
      '.bst-sky,.bst-top,.bst-drift{position:absolute;left:0;right:0}.bst-sky{inset:0}.bst-top{top:0;height:22px}',
      '.bst-mid{position:absolute;top:0;bottom:0;display:flex;align-items:center;justify-content:center;gap:18px}.bst-mid[hidden]{display:none}',
      '.bst-corner{position:absolute;top:0;pointer-events:none}.bst-corner.l{left:0}.bst-corner.r{right:0;transform:scaleX(-1)}',
      /* readable controls on top of a scene */
      '.bst-scene .bes-search,.bst-scene .bes-date,.bst-scene .bes-icon,.bst-scene .bes-clockpill{background:rgba(8,11,20,.76)!important;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}',
      '.bst-scene .bes-account{background:rgba(8,11,20,.6)!important;border-color:rgba(255,255,255,.07)!important}',
      '.bst.bst-glow{box-shadow:0 10px 30px -18px var(--bst-glow),inset 0 1px 0 rgba(255,255,255,.04)}',
      '.bst.bst-accent .bes-icon,.bst.bst-accent .bes-date,.bst.bst-accent .bes-clockpill,.bst.bst-accent .bes-search{border-color:var(--bst-line)!important}',
      '.bst.bst-accent .bes-icon svg,.bst.bst-accent .bes-date svg{color:var(--bst-accent)}',
      '.bst.bst-accent .bes-av{box-shadow:0 0 0 2px var(--bst-line)!important}',
      /* christmas */
      '.bst-christmas .bst-sky{background:radial-gradient(1px 1px at 12% 40%,#fff 60%,transparent),radial-gradient(1px 1px at 27% 70%,rgba(255,255,255,.7) 60%,transparent),radial-gradient(1.2px 1.2px at 46% 35%,#fff 60%,transparent),radial-gradient(1px 1px at 63% 62%,rgba(255,255,255,.8) 60%,transparent),radial-gradient(1px 1px at 78% 30%,#fff 60%,transparent),radial-gradient(1px 1px at 91% 66%,rgba(255,255,255,.7) 60%,transparent),radial-gradient(60% 140% at 30% -50%,rgba(52,211,153,.10),transparent 60%),radial-gradient(60% 140% at 75% -60%,rgba(129,140,248,.14),transparent 60%),linear-gradient(180deg,#081228,#0b1834 55%,#0d1a30)}',
      '.bst-christmas .bst-sky::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 20%,rgba(94,234,212,.07) 35%,rgba(129,140,248,.08) 50%,transparent 65%);animation:bstAur 14s ease-in-out infinite alternate}',
      '@keyframes bstAur{from{transform:translateX(-8%)}to{transform:translateX(8%)}}',
      '.bst-christmas .bst-top{height:18px;z-index:1}',
      '.bst-spark{position:absolute;width:3px;height:3px;border-radius:50%;background:#fff;box-shadow:0 0 4px 1px rgba(255,255,255,.9);opacity:0;animation:bstSpk 4.5s ease-in-out infinite}',
      '@keyframes bstSpk{0%,70%,100%{opacity:0;transform:scale(.4)}80%{opacity:1;transform:scale(1)}}',
      '.bst-xm{position:relative;display:flex;align-items:flex-end;gap:2px;align-self:flex-end;margin-bottom:-2px}.bst-xm .bst-tree{margin:0}.bst-gifts{display:block;margin-bottom:1px}',
      '.bst-glowx{position:absolute;left:-30px;right:-30px;bottom:-10px;height:46px;background:radial-gradient(50% 60% at 50% 100%,rgba(251,191,36,.22),transparent 70%)}',
      '.bst-bulb{position:absolute;width:5px;height:7px;margin:-1px 0 0 -2.5px;border-radius:50% 50% 45% 45%;background:var(--b);box-shadow:0 0 6px 1px var(--b);animation:bstTw 2.6s ease-in-out infinite}',
      '.bst-bulb::before{content:"";position:absolute;left:1px;top:-2px;width:3px;height:3px;border-radius:1px;background:#334155}',
      '@keyframes bstTw{0%,100%{opacity:1}50%{opacity:.45;box-shadow:0 0 2px 0 var(--b)}}',
      '.bst-frost{position:absolute;inset:0;background:radial-gradient(90px 40px at 0 0,rgba(226,240,255,.18),transparent 70%),radial-gradient(90px 40px at 100% 0,rgba(226,240,255,.18),transparent 70%),radial-gradient(70px 30px at 0 100%,rgba(226,240,255,.12),transparent 70%),radial-gradient(70px 30px at 100% 100%,rgba(226,240,255,.12),transparent 70%)}',
      '.bst-bauble{position:absolute;width:9px;height:9px;margin-left:-4.5px;transform-origin:50% calc(-1 * var(--l));animation:bstSway 3.4s ease-in-out infinite alternate}',
      '.bst-bauble::before{content:"";position:absolute;left:4px;bottom:9px;width:1px;height:var(--l);background:rgba(203,213,225,.6)}',
      '.bst-bauble::after{content:"";position:absolute;inset:0;margin-top:var(--l);border-radius:50%;background:radial-gradient(circle at 32% 30%,rgba(255,255,255,.85) 0 14%,var(--c) 42%,rgba(0,0,0,.55) 100%);box-shadow:0 0 6px rgba(255,255,255,.08)}',
      '@keyframes bstSway{from{transform:rotate(-6deg)}to{transform:rotate(6deg)}}',
      '.bst-cap.hat{transform:rotate(18deg);filter:drop-shadow(0 2px 2px rgba(0,0,0,.5))}.bst-cap.hat svg{display:block}',
      '.bst-pen{position:absolute;width:9px;height:11px;margin-left:-4.5px;background:var(--p);clip-path:polygon(0 0,100% 0,50% 100%);opacity:.9;transform-origin:50% 0;animation:bstSway 2.8s ease-in-out infinite alternate;filter:brightness(.92)}',
      '.bst-flag2{display:block;width:150px;height:60px}.bst-mf{display:block;opacity:.9;filter:drop-shadow(0 4px 8px rgba(0,0,0,.4))}.bst-mf.r{transform:scaleX(-1)}.bst-mid.w-s .bst-mf.r{display:none}',
      '.bst-drift{bottom:-1px;height:9px;background:radial-gradient(18px 7px at 6% 100%,#e8f1ff 60%,transparent 62%),radial-gradient(26px 8px at 22% 100%,#e8f1ff 60%,transparent 62%),radial-gradient(22px 7px at 41% 100%,#e8f1ff 60%,transparent 62%),radial-gradient(30px 9px at 63% 100%,#e8f1ff 60%,transparent 62%),radial-gradient(20px 7px at 82% 100%,#e8f1ff 60%,transparent 62%),radial-gradient(26px 8px at 97% 100%,#e8f1ff 60%,transparent 62%);opacity:.38}',
      '.bst-tree{display:block;margin-top:auto;align-self:flex-end;filter:drop-shadow(0 0 10px rgba(253,230,138,.18))}.bst-tl circle{animation:bstTw 2.2s ease-in-out infinite}.bst-tl circle:nth-child(2n){animation-delay:1.1s}',
      '.bst-cap.snow{filter:drop-shadow(0 1px 1px rgba(2,6,23,.35))}.bst-cap svg{display:block}',
      '.bst-vishu .bst-sky{background:radial-gradient(50% 160% at 20% 120%,rgba(250,204,21,.22),transparent 60%),linear-gradient(180deg,#1d1606,#231a08 60%,#17120a)}',
      '.bst-onam .bst-sky{background:radial-gradient(45% 150% at 10% 120%,rgba(249,115,22,.22),transparent 60%),radial-gradient(45% 150% at 90% 120%,rgba(225,29,72,.16),transparent 60%),linear-gradient(180deg,#14180c,#1a1d0e 60%,#121509)}',
      '.bst-newyear .bst-sky{background:radial-gradient(50% 160% at 50% -40%,rgba(192,132,252,.18),transparent 60%),linear-gradient(180deg,#0c0a1e,#120d26 60%,#0d0a1c)}',
      /* monsoon */
      '.bst-monsoon .bst-sky{background:radial-gradient(70% 120% at 50% -30%,rgba(148,163,184,.16),transparent 70%),linear-gradient(180deg,#0a1726,#0d2033 60%,#0b1a2a)}',
      '.bst-cloud{position:absolute;top:-30px;width:280px;height:70px;border-radius:50%;background:radial-gradient(closest-side,rgba(148,163,184,.22),transparent);filter:blur(4px);animation:bstCl 60s linear infinite}',
      '.bst-cloud.c1{left:-10%}.bst-cloud.c2{left:35%;top:-38px;width:360px;animation-duration:80s;animation-delay:-20s}.bst-cloud.c3{left:70%;animation-duration:70s;animation-delay:-40s}',
      '@keyframes bstCl{from{transform:translateX(-120px)}to{transform:translateX(160px)}}',
      '.bst-flash{position:absolute;inset:0;background:radial-gradient(60% 140% at 60% -20%,rgba(219,234,254,.55),transparent 70%);opacity:0;animation:bstFlash 17s infinite}',
      '@keyframes bstFlash{0%,93%,100%{opacity:0}94%{opacity:.55}95%{opacity:.1}96%{opacity:.4}97.5%{opacity:0}}',
      '.bst-monsoon .bst-corner svg{display:block;opacity:.9}',
      '.bst-cap.drop{width:var(--s);height:calc(var(--s) * 1.35);border-radius:50% 50% 50% 50%/62% 62% 38% 38%;background:radial-gradient(circle at 34% 30%,rgba(255,255,255,.95) 0 18%,rgba(186,230,253,.55) 40%,rgba(59,130,246,.25) 75%);box-shadow:0 1px 2px rgba(0,0,0,.35),inset 0 -1px 1px rgba(255,255,255,.25)}',
      /* summer */
      '.bst-summer .bst-sky{background:radial-gradient(60% 160% at 50% 140%,rgba(251,146,60,.28),transparent 60%),linear-gradient(180deg,#26160a,#2a180b 45%,#1c130d)}',
      '.bst-sunc{position:relative;width:46px;height:46px;flex:none}.bst-disc{position:absolute;inset:11px;border-radius:50%;background:radial-gradient(circle,#fff7d6,#fde68a 45%,#f59e0b);box-shadow:0 0 22px 8px rgba(251,191,36,.35)}',
      '.bst-rays{position:absolute;inset:0;border-radius:50%;background:repeating-conic-gradient(rgba(253,230,138,.35) 0 6deg,transparent 6deg 22deg);-webkit-mask:radial-gradient(circle,transparent 30%,#000 32%,transparent 70%);mask:radial-gradient(circle,transparent 30%,#000 32%,transparent 70%);animation:bstSpin 60s linear infinite}',
      '@keyframes bstSpin{to{transform:rotate(360deg)}}',
      '.bst-fl{width:10px;height:10px;border-radius:50%;flex:none;background:radial-gradient(circle,rgba(253,230,138,.35),transparent 70%)}.bst-fl.f2{width:16px;height:16px;opacity:.6}.bst-fl.f3{width:6px;height:6px}',
      '.bst-summer .bst-corner{top:-6px}',
      /* navaratri */
      '.bst-navaratri .bst-sky{background:radial-gradient(45% 140% at 15% 120%,rgba(245,158,11,.20),transparent 60%),radial-gradient(45% 140% at 85% 120%,rgba(236,72,153,.16),transparent 60%),linear-gradient(180deg,#220a1d,#2a0c1c 55%,#1c0915)}',
      '.bst-bead{position:absolute;width:6px;height:6px;margin:-1px 0 0 -3px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff3c4,var(--m) 55%,#9a3412);box-shadow:0 1px 1px rgba(0,0,0,.4)}',
      '.bst-mleaf{position:absolute;width:6px;height:10px;margin-left:-3px;border-radius:0 0 50% 50%/0 0 100% 100%;background:linear-gradient(#166534,#14532d);transform:rotate(6deg)}',
      '.bst-mwrap{position:absolute;opacity:.16}.bst-mandala{animation:bstSpin 90s linear infinite;display:block}',
      '.bst-drow{display:flex;gap:16px;align-items:flex-end;align-self:flex-end;margin-bottom:-2px}',
      '.bst-dy{position:relative;width:18px;height:20px}.bst-dy .bw{position:absolute;left:0;right:0;bottom:0;height:7px;border-radius:2px 2px 10px 10px;background:linear-gradient(180deg,#b45309,#78350f);box-shadow:0 0 12px rgba(245,158,11,.45)}',
      '.bst-dy .fl{position:absolute;left:50%;bottom:6px;width:6px;height:11px;margin-left:-3px;border-radius:50% 50% 50% 50%/62% 62% 38% 38%;background:radial-gradient(ellipse at 50% 72%,#fffbeb 0 22%,#fde047 38%,#f97316 70%,rgba(249,115,22,0) 76%);filter:drop-shadow(0 0 5px rgba(251,191,36,.95));transform-origin:50% 100%;animation:bstFlick 1.6s ease-in-out infinite alternate}',
      '.bst-dy:nth-child(2) .fl{animation-delay:.4s}.bst-dy:nth-child(3) .fl{animation-delay:.9s}.bst-dy:nth-child(4) .fl{animation-delay:.2s}.bst-dy:nth-child(5) .fl{animation-delay:.7s}',
      '@keyframes bstFlick{0%{transform:scale(1,1) rotate(-2deg)}50%{transform:scale(.92,1.08) rotate(2deg)}100%{transform:scale(1.04,.96) rotate(-1deg)}}',
      /* independence day */
      '.bst-independence .bst-sky{background:radial-gradient(50% 180% at 50% -60%,rgba(254,215,170,.16),transparent 60%),radial-gradient(40% 160% at 0% 0%,rgba(255,153,51,.26),transparent 60%),radial-gradient(40% 160% at 100% 100%,rgba(19,136,8,.26),transparent 60%),linear-gradient(180deg,#0d1424,#0f1729 60%,#0c1220)}',
      '.bst-independence .bst-sky::after{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,#ff9933 0 33.3%,#f8fafc 33.3% 66.6%,#138808 66.6%);opacity:.85}',
      '.bst-flag{display:block;opacity:.42;transform-origin:0 50%;animation:bstWave 5s ease-in-out infinite alternate}.bst-corner.r .bst-flag{animation-delay:-2.5s}',
      '@keyframes bstWave{0%{transform:skewY(-2deg) scaleY(1)}50%{transform:skewY(1.5deg) scaleY(.94)}100%{transform:skewY(-1deg) scaleY(1.03)}}',
      '.bst-chw{opacity:.5;filter:drop-shadow(0 0 6px rgba(107,140,255,.5))}.bst-chakra{display:block;animation:bstSpin 40s linear infinite}',
      '.bst-birds{position:absolute;left:0;top:6px;width:100%;height:20px}.bst-birds i{position:absolute;width:10px;height:4px;border:1.5px solid rgba(203,213,225,.55);border-color:rgba(203,213,225,.55) transparent transparent transparent;border-radius:50% 50% 0 0;animation:bstFly 26s linear infinite}',
      '.bst-birds i:nth-child(2){top:6px;animation-delay:-9s;transform:scale(.8)}.bst-birds i:nth-child(3){top:2px;animation-delay:-17s;transform:scale(.7)}',
      '@keyframes bstFly{from{left:-5%}to{left:105%}}',
      '.bst-independence.bst-accent .bes-clockpill .bcp-btn{box-shadow:inset 0 2px 0 #ff9933,inset 0 -2px 0 #138808}',
      '.bst-independence.bst-accent .bes-av{box-shadow:0 0 0 2px #ff9933,0 0 0 4px rgba(19,136,8,.6)!important}',
      '.bst-asset{position:absolute;right:12px;top:6px;bottom:6px;max-height:46px;opacity:.85;object-fit:contain}',
      '.bst-cap{position:absolute;pointer-events:none}',
      '@media (prefers-reduced-motion:reduce){.bst *{animation:none!important}}',
      '.bsa-pv .be-sel-wrap{width:auto!important;min-width:220px}',
      /* preview chip + admin */
      '.bst-chip{position:fixed;left:16px;bottom:16px;z-index:9400;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:999px;background:#11182a;border:1px solid rgba(255,138,61,.35);color:#e6e9f5;font:600 12.5px Inter,system-ui,sans-serif;box-shadow:0 14px 40px -12px rgba(0,0,0,.8)}',
      '.bst-chip button{height:28px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font:inherit;cursor:pointer}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── scene helpers (SVG built once per layout; ids unique per instance) ─────
  var UID = 0;
  function rnd(a, b) { return a + Math.random() * (b - a); }
  // Fluffy snow piled on a control: a mound of overlapping, individually shaded clumps (taller in
  // the middle, spilling 3px past each side), a soft blue under-shadow and drips over the front.
  function snowCapSVG(w) {
    var id = 'bstg' + (++UID), H = Math.round(Math.min(18, 10 + w / 18)), base = H - 3, W = w + 6, clumps = '', n = Math.max(4, Math.round(w / 9));
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n, cx = 3 + t * w + rnd(-2, 2), hump = Math.sin(Math.PI * t), r = (3.6 + hump * (H * 0.32)) * rnd(0.85, 1.12);
      clumps += '<circle cx="' + cx.toFixed(1) + '" cy="' + (base - hump * (H * 0.38) - r * 0.25 + rnd(-0.8, 0.8)).toFixed(1) + '" r="' + r.toFixed(1) + '" fill="url(#' + id + 'c)"/>';
    }
    var drips = '';
    [rnd(0.15, 0.3), rnd(0.55, 0.72), rnd(0.82, 0.92)].forEach(function (p, k) { if (w < 60 && k === 1) return; var x = (3 + w * p).toFixed(1), L = rnd(2.5, 5.5), rw = rnd(1.4, 2.2); drips += '<path d="M' + (x - rw) + ' ' + base + ' q0 ' + L.toFixed(1) + ' ' + rw + ' ' + L.toFixed(1) + ' q' + rw + ' 0 ' + rw + ' -' + L.toFixed(1) + ' z" fill="url(#' + id + 'd)"/>'; });
    return '<svg width="' + W + '" height="' + (H + 6) + '" viewBox="0 0 ' + W + ' ' + (H + 6) + '" aria-hidden="true" style="overflow:visible"><defs>'
      + '<radialGradient id="' + id + 'c" cx=".38" cy=".3" r=".75"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#f4f8ff"/><stop offset="1" stop-color="#c9d9ee"/></radialGradient>'
      + '<linearGradient id="' + id + 'b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef4fd"/><stop offset="1" stop-color="#b9cbe4"/></linearGradient>'
      + '<linearGradient id="' + id + 'd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6effa"/><stop offset="1" stop-color="#cfe0f3" stop-opacity=".85"/></linearGradient></defs>'
      + '<ellipse cx="' + (W / 2) + '" cy="' + (base + 2.5) + '" rx="' + (W / 2 - 1) + '" ry="2.6" fill="rgba(15,23,42,.45)" style="filter:blur(1.2px)"/>'
      + '<rect x="0" y="' + (base - 4) + '" width="' + W + '" height="6" rx="3" fill="url(#' + id + 'b)"/>' + clumps + drips
      + '<circle cx="' + (W * rnd(.3, .45)).toFixed(1) + '" cy="' + (base - H * 0.45).toFixed(1) + '" r=".9" fill="#fff"/><circle cx="' + (W * rnd(.6, .75)).toFixed(1) + '" cy="' + (base - H * 0.3).toFixed(1) + '" r=".7" fill="#fff" opacity=".9"/></svg>';
  }
  // catenary-ish swoops across the header top: used for fairy lights and the marigold toran
  function swoops(W, every, sag, fn) {
    var n = Math.max(2, Math.round(W / every)), seg = W / n, out = [];
    for (var s = 0; s < n; s++) out.push({ x0: s * seg, x1: (s + 1) * seg });
    var path = out.map(function (o) { return 'M' + o.x0.toFixed(1) + ' 1 Q' + ((o.x0 + o.x1) / 2).toFixed(1) + ' ' + (sag * 2) + ' ' + o.x1.toFixed(1) + ' 1'; }).join(' ');
    out.forEach(function (o) { fn(o, function (t) { return { x: o.x0 + (o.x1 - o.x0) * t, y: 1 + sag * 4 * t * (1 - t) }; }); });
    return path;
  }
  var SVG = {
    hat: '<svg viewBox="0 0 40 34" width="30" height="26" aria-hidden="true"><defs><linearGradient id="bsthat" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ef4444"/><stop offset="1" stop-color="#991b1b"/></linearGradient></defs><path d="M6 24 C10 10 20 2 33 4 C29 9 27 14 30 22 Z" fill="url(#bsthat)"/><path d="M31 4 C34 5 36 8 35 11" fill="none" stroke="#7f1d1d" stroke-width="1"/><rect x="3" y="21" width="30" height="8" rx="4" fill="#f8fafc"/><circle cx="34" cy="5" r="4" fill="#f8fafc"/><path d="M6 23h24" stroke="#cbd5e1" stroke-width="1"/></svg>',
    tree2: '<svg viewBox="0 0 60 74" width="46" height="57" aria-hidden="true"><defs><linearGradient id="bsttr" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14532d"/><stop offset=".55" stop-color="#166534"/><stop offset="1" stop-color="#0b3b22"/></linearGradient></defs><path d="M30 6 L44 26 H37 L50 44 H40 L56 64 H4 L20 44 H10 L23 26 H16 Z" fill="url(#bsttr)"/><path d="M16 26 Q30 31 44 26 M10 44 Q30 50 50 44" stroke="#f8fafc" stroke-opacity=".5" stroke-width="1.6" fill="none" stroke-dasharray="2 3"/><rect x="26" y="64" width="8" height="7" rx="1" fill="#6b4423"/><path d="M30 0l1.9 3.9 4.3.6-3.1 3 .7 4.3L30 9.8l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="#fde047"/><g class="bst-tl"><circle cx="23" cy="20" r="1.8" fill="#ef4444"/><circle cx="35" cy="34" r="1.8" fill="#fbbf24"/><circle cx="20" cy="40" r="1.8" fill="#60a5fa"/><circle cx="40" cy="52" r="1.8" fill="#ef4444"/><circle cx="26" cy="57" r="1.8" fill="#fbbf24"/><circle cx="31" cy="15" r="1.5" fill="#a7f3d0"/><circle cx="15" cy="58" r="1.8" fill="#e879f9"/></g></svg>',
    gifts: '<svg viewBox="0 0 64 30" width="58" height="27" class="bst-gifts" aria-hidden="true"><rect x="2" y="12" width="20" height="17" rx="1.5" fill="#b91c1c"/><rect x="10" y="12" width="4" height="17" fill="#fde68a"/><rect x="2" y="17" width="20" height="3.5" fill="#fde68a"/><path d="M12 12 c-5 -6 -9 -2 -3 0 M12 12 c5 -6 9 -2 3 0" stroke="#fde68a" stroke-width="1.6" fill="none"/><rect x="25" y="17" width="17" height="12" rx="1.5" fill="#1d4ed8"/><rect x="32" y="17" width="3" height="12" fill="#e2e8f0"/><rect x="45" y="9" width="17" height="20" rx="1.5" fill="#15803d"/><rect x="45" y="16" width="17" height="3" fill="#fca5a5"/><rect x="52" y="9" width="3" height="20" fill="#fca5a5"/><path d="M53.5 9 c-4 -5 -7 -1 -2 0 M53.5 9 c4 -5 7 -1 2 0" stroke="#fca5a5" stroke-width="1.4" fill="none"/></svg>',
    tree: '<svg viewBox="0 0 40 52\" width="34" height="44" aria-hidden="true"><path d="M20 6 L33 24 H26 L36 38 H25 L38 48 H2 L15 38 H4 L14 24 H7 Z" fill="#0f3d2a"/><path d="M20 6 L33 24 H26 L36 38 H25 L38 48 H20 Z" fill="#0b3020"/><rect x="17.5" y="48" width="5" height="4" fill="#5b3a1e"/><path d="M20 1.5l1.3 2.7 2.9.4-2.1 2 .5 2.9L20 8.2l-2.6 1.3.5-2.9-2.1-2 2.9-.4z" fill="#fde68a"/><g class="bst-tl"><circle cx="15" cy="21" r="1.3" fill="#fca5a5"/><circle cx="24" cy="28" r="1.3" fill="#fde68a"/><circle cx="11" cy="35" r="1.3" fill="#86efac"/><circle cx="28" cy="40" r="1.3" fill="#fca5a5"/><circle cx="19" cy="43" r="1.3" fill="#bfdbfe"/><circle cx="21" cy="15" r="1.2" fill="#fde68a"/></g></svg>',
    palmL: '<svg viewBox="0 0 160 70" width="150" height="66" aria-hidden="true"><g fill="#0d0805" opacity=".92"><path d="M0 8 C40 0 80 6 118 30 C80 18 40 16 0 24 Z"/><path d="M0 28 C30 22 62 28 92 52 C60 40 30 38 0 44 Z"/><path d="M0 0 C34 -6 70 -2 104 12 C70 6 34 8 0 14 Z"/><path d="M118 30 l6 6 -9 -2 z M92 52 l5 7 -8 -4 z"/></g></svg>',
    leaf: '<svg viewBox="0 0 120 60" width="120" height="60" aria-hidden="true"><g fill="#0a1f17" opacity=".95"><path d="M0 0 C40 4 80 20 104 50 C70 34 34 26 0 26 Z"/><path d="M0 22 C26 24 52 34 70 58 C44 46 20 42 0 44 Z" fill="#0c2a1e"/><path d="M14 0 C40 -2 70 4 92 18 C66 12 40 10 14 12 Z" fill="#0e3022"/></g></svg>',
    sun: '<span class="bst-sunc"><i class="bst-rays"></i><i class="bst-disc"></i></span><i class="bst-fl f1"></i><i class="bst-fl f2"></i><i class="bst-fl f3"></i>',
    chakra: (function () { var s = '<svg viewBox="-50 -50 100 100" width="40" height="40" class="bst-chakra" aria-hidden="true"><circle r="46" fill="none" stroke="#6b8cff" stroke-width="5"/><circle r="8" fill="#6b8cff"/>'; for (var i = 0; i < 24; i++) { var a = i * 15 * Math.PI / 180; s += '<line x1="0" y1="0" x2="' + (44 * Math.cos(a)).toFixed(1) + '" y2="' + (44 * Math.sin(a)).toFixed(1) + '" stroke="#6b8cff" stroke-width="1.6"/>'; } return s + '</svg>'; })(),
    flag2: function (side) {
      // shaded waving cloth (SMIL morph — cheap, GPU-free) with pole and a navy 24-spoke chakra
      var A = 'M8 6 C40 0 70 14 104 6 C130 0 156 6 180 10 L180 64 C156 60 130 54 104 60 C70 68 40 54 8 60 Z';
      var B = 'M8 6 C40 12 70 0 104 8 C130 14 156 4 180 4 L180 58 C156 58 130 68 104 62 C70 56 40 68 8 60 Z';
      var spokes = ''; for (var i = 0; i < 24; i++) { var a = i * 15 * Math.PI / 180; spokes += '<line x2="' + (7.2 * Math.cos(a)).toFixed(2) + '" y2="' + (7.2 * Math.sin(a)).toFixed(2) + '"/>'; }
      var id = 'bstfl' + (++UID);
      return '<svg viewBox="0 0 184 74" width="184" height="74" class="bst-flag2 ' + side + '" aria-hidden="true"><defs>'
        + '<clipPath id="' + id + 'c"><path d="' + A + '"><animate attributeName="d" dur="3.6s" repeatCount="indefinite" values="' + A + ';' + B + ';' + A + '"/></path></clipPath>'
        + '<linearGradient id="' + id + 's" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".25"/><stop offset=".22" stop-color="#fff" stop-opacity=".18"/><stop offset=".45" stop-color="#000" stop-opacity=".22"/><stop offset=".7" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#000" stop-opacity=".28"/>'
        + '<animateTransform attributeName="gradientTransform" type="translate" values="-.15 0;.15 0;-.15 0" dur="3.6s" repeatCount="indefinite"/></linearGradient></defs>'
        + '<rect x="3" y="2" width="3" height="72" rx="1.5" fill="#cbd5e1"/><circle cx="4.5" cy="2.5" r="2.5" fill="#e2e8f0"/>'
        + '<g clip-path="url(#' + id + 'c)"><rect x="6" y="0" width="178" height="26" fill="#ff9933"/><rect x="6" y="26" width="178" height="22" fill="#f8fafc"/><rect x="6" y="48" width="178" height="26" fill="#138808"/>'
        + '<g transform="translate(94 36)" stroke="#000080" stroke-width=".7"><circle r="8" fill="none" stroke-width="1.2"/>' + spokes + '<circle r="1.4" fill="#000080"/></g>'
        + '<rect x="6" y="0" width="178" height="74" fill="url(#' + id + 's)"/></g></svg>';
    },
    flag: function (side) { return '<svg viewBox="0 0 150 60" width="150" height="60" class="bst-flag ' + side + '" aria-hidden="true" preserveAspectRatio="none"><path d="M0 4 C40 -2 70 14 110 6 C125 3 140 6 150 10 L150 24 C140 20 125 17 110 20 C70 28 40 12 0 18 Z" fill="#ff9933"/><path d="M0 18 C40 12 70 28 110 20 C125 17 140 20 150 24 L150 38 C140 34 125 31 110 34 C70 42 40 26 0 32 Z" fill="#f8fafc"/><path d="M0 32 C40 26 70 42 110 34 C125 31 140 34 150 38 L150 52 C140 48 125 45 110 48 C70 56 40 40 0 46 Z" fill="#138808"/><circle cx="72" cy="27" r="4.6" fill="none" stroke="#1e3a8a" stroke-width="1.2"/></svg>'; },
    birds: '<span class="bst-birds"><i></i><i></i><i></i></span>',
    mandala: (function () { var s = '<svg viewBox="-50 -50 100 100" width="64" height="64" class="bst-mandala" aria-hidden="true"><g fill="none" stroke="#f59e0b" stroke-width="1">'; for (var i = 0; i < 12; i++) s += '<ellipse rx="9" ry="22" transform="rotate(' + (i * 30) + ') translate(0 -20)"/>'; return s + '<circle r="10"/><circle r="40"/></g></svg>'; })(),
    diya: '<span class="bst-dy"><i class="fl"></i><i class="bw"></i></span>'
  };

  // ════════════════════════════════════════════════════════════════════════
  // Scene engine — every theme is a live, cinematic canvas scene (no stock art)
  //   bg(ctx)  light, sky, depth layers (skipped when HR uploads an own banner image)
  //   fx(ctx)  moving light: snow / rain / petals / fireworks / embers / bokeh
  // Glow & bokeh are pre-rendered sprites (no gradients built per frame); ~30 fps; paused
  // when hidden or off-screen; fewer particles on phones; one still frame for reduced motion.
  // ════════════════════════════════════════════════════════════════════════
  var SPR = {};
  function sprite(r, rgb, soft) {   // cached radial glow: rgb "255,200,120", soft 0..1
    var k = r + '|' + rgb + '|' + soft; if (SPR[k]) return SPR[k];
    var c = document.createElement('canvas'), d = Math.ceil(r * 2); c.width = c.height = d;
    var g = c.getContext('2d'), gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(' + rgb + ',1)'); gr.addColorStop(soft ? 0.18 : 0.55, 'rgba(' + rgb + ',' + (soft ? 0.55 : 0.9) + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr; g.fillRect(0, 0, d, d); return (SPR[k] = c);
  }
  function lin(ctx, h, stops) { var g = ctx.createLinearGradient(0, 0, 0, h); stops.forEach(function (s) { g.addColorStop(s[0], s[1]); }); return g; }
  function sky(ctx, H, band, top, horizon, base) { var hb = Math.min(0.95, band / Math.max(1, H)); return lin(ctx, H, [[0, top], [hb * 0.92, horizon], [Math.min(1, hb + 0.08), base], [1, base]]); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function petal(ctx, p) {   // tumbling petal: flips in 3D (scaleX = cos) with a light edge
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(Math.max(0.15, Math.abs(Math.cos(p.flip))), 1);
    ctx.globalAlpha = p.a; ctx.fillStyle = p.col; ctx.beginPath(); ctx.ellipse(0, 0, p.r * 0.55, p.r, 0, 0, 6.283); ctx.fill();
    ctx.globalAlpha = p.a * 0.35; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(-p.r * 0.15, -p.r * 0.3, p.r * 0.18, p.r * 0.4, 0, 0, 6.283); ctx.fill(); ctx.restore();
  }
  function stepPetal(p, W, H) { p.y += p.v; p.x += Math.sin(p.s) * 0.45 + p.dx; p.s += 0.03; p.rot += p.vr; p.flip += p.vf; return p.y < H + 8 && p.x > -10 && p.x < W + 10; }
  function newPetal(W, H, pal, fresh, size) { return { x: rnd(-5, W), y: fresh ? rnd(-10, H) : -8, r: rnd(size[0], size[1]), v: rnd(0.25, 0.6), dx: rnd(-0.1, 0.25), s: rnd(0, 6.28), rot: rnd(0, 6.28), vr: rnd(-0.03, 0.03), flip: rnd(0, 6.28), vf: rnd(0.03, 0.08), col: pick(pal), a: rnd(0.6, 0.95) }; }
  function bokeh(W, H, n, cols, rr, br) { br = br || 1; var a = []; for (var i = 0; i < n; i++) a.push({ x: rnd(0, W), y: rnd(0, H), r: rnd(rr[0], rr[1]), c: pick(cols), a: Math.min(0.9, rnd(0.12, 0.4) * br), s: rnd(0, 6.28), vx: rnd(-0.08, 0.08), vy: rnd(-0.12, 0.02) }); return a; }
  function drawBokeh(ctx, list, W, H, move) {
    ctx.globalCompositeOperation = 'lighter';
    list.forEach(function (b) { if (move) { b.x += b.vx; b.y += b.vy; b.s += 0.02; if (b.y < -b.r) b.y = H + b.r; if (b.x < -b.r) b.x = W + b.r; if (b.x > W + b.r) b.x = -b.r; }
      ctx.globalAlpha = b.a * (0.65 + 0.35 * Math.sin(b.s)); var sp = sprite(Math.round(b.r), b.c, true); ctx.drawImage(sp, b.x - b.r, b.y - b.r); });
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  var SCENES = {
    christmas: function (W, H, band, q) {
      // Only snow, done properly: three depths, soft-edged flakes (sprites, no hard dots), gentle
      // sway, near flakes larger + slightly blurred. A faint cold moonlight and two distant warm
      // window glows give the season without drawing any objects.
      var snow = [];
      for (var k = 0; k < q(64); k++) { var z = Math.random(); snow.push({ z: z, x: rnd(0, W), y: rnd(-10, H), r: 0.6 + z * z * 2.2, v: 0.12 + z * 0.42, s: rnd(0, 6.28), sw: rnd(0.15, 0.45) }); }
      var warm = [{ x: W * rnd(0.3, 0.42), y: H * 0.7 }, { x: W * rnd(0.55, 0.68), y: H * 0.78 }];
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = lin(ctx, H, [[0, 'rgba(8,16,38,.55)'], [1, 'rgba(6,10,24,.15)']]); ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.22; ctx.drawImage(sprite(90, '170,200,255', true), W * 0.18 - 90, -70);
          warm.forEach(function (w, i) { ctx.globalAlpha = 0.07 + 0.02 * Math.sin(t * 0.7 + i * 2); ctx.drawImage(sprite(26, '255,190,120', true), w.x - 26, w.y - 26); });
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        },
        fx: function (ctx) {
          for (var i = 0; i < snow.length; i++) {
            var p = snow[i]; p.y += p.v; p.s += 0.015 + p.z * 0.01; p.x += Math.sin(p.s) * p.sw * (0.5 + p.z);
            if (p.y > H + 6) { p.y = -6; p.x = rnd(0, W); }
            var rr = Math.max(1, Math.round(p.r * (p.z > 0.85 ? 2.4 : 1.6)));
            ctx.globalAlpha = 0.25 + p.z * 0.55; ctx.drawImage(sprite(rr, '240,246,255', p.z > 0.85), p.x - rr, p.y - rr);
          }
          ctx.globalAlpha = 1;
        }
      };
    },

    independence: function (W, H, band, q) {
      var petals = []; for (var i = 0; i < q(20); i++) petals.push(newPetal(W, H, ['#ff9933', '#f6f7f2', '#138808', '#ff9933'], true, [2.2, 3.6]));
      var glows = bokeh(W, band, q(10), ['255,153,51', '255,240,220', '34,197,94'], [6, 14], 1.5);
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = sky(ctx, H, band, '#0b1428', '#3a2a3e', '#0f1526'); ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.22; ctx.drawImage(sprite(140, '255,170,90', true), W * 0.62 - 140, band * 0.9 - 140); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
          // a silk tricolour flowing across the band: per-column wave + shading from the slope
          var th = Math.min(band * 0.62, 34), top0 = band * 0.18, step = 4, cx = W * 0.5;
          for (var x = 0; x < W; x += step) {
            var ph = x * 0.012 - t * 1.6, amp = 4 + 6 * (x / W), y = top0 + Math.sin(ph) * amp + Math.sin(x * 0.004 - t * 0.6) * 3;
            var fade = Math.min(1, x / (W * 0.18)) * Math.min(1, (W - x) / (W * 0.18)), shade = Math.cos(ph) * 0.22;
            ctx.globalAlpha = 0.9 * fade;
            ctx.fillStyle = '#ff9933'; ctx.fillRect(x, y, step + 0.6, th / 3);
            ctx.fillStyle = '#f6f7f2'; ctx.fillRect(x, y + th / 3, step + 0.6, th / 3);
            ctx.fillStyle = '#138808'; ctx.fillRect(x, y + 2 * th / 3, step + 0.6, th / 3);
            ctx.globalAlpha = fade * Math.abs(shade); ctx.fillStyle = shade > 0 ? '#ffffff' : '#000000'; ctx.fillRect(x, y, step + 0.6, th);
            if (Math.abs(x - cx) < step / 2) { cxY = y + th / 2; }
          }
          // Ashoka chakra riding the wave on the white band
          ctx.globalAlpha = 0.95; ctx.strokeStyle = '#1e3a8a'; ctx.lineWidth = 1; var rr = th / 6.2;
          ctx.save(); ctx.translate(cx, cxY); ctx.rotate(t * 0.25); ctx.beginPath(); ctx.arc(0, 0, rr, 0, 6.283); ctx.stroke();
          for (var s = 0; s < 24; s++) { var an = s * 0.2618; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); ctx.stroke(); } ctx.restore(); ctx.globalAlpha = 1;
          drawBokeh(ctx, glows, W, band, true);
        },
        fx: function (ctx) { petals.forEach(function (p, i) { if (!stepPetal(p, W, H)) petals[i] = newPetal(W, H, ['#ff9933', '#f6f7f2', '#138808'], false, [2.2, 3.6]); petal(ctx, p); }); }
      };
      var cxY = 0;
    },

    vishu: function (W, H, band, q) {
      var gold = bokeh(W, H, q(18), ['255,214,90', '255,190,60', '255,236,170'], [5, 13], 1.7);
      var pet = []; for (var i = 0; i < q(22); i++) pet.push(newPetal(W, H, ['#facc15', '#fde047', '#eab308', '#fbbf24'], true, [1.8, 3]));
      var lamps = [0.74, 0.8, 0.86].map(function (f) { return { x: W * f, y: band * 0.78, s: rnd(0, 6) }; });
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = sky(ctx, H, band, '#120c03', '#4a3210', '#15100a'); ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter';
          for (var r = 0; r < 3; r++) {   // slow god-rays through leaves
            ctx.save(); ctx.translate(W * (0.12 + r * 0.16), -10); ctx.rotate(0.5 + Math.sin(t * 0.1 + r) * 0.05);
            var gr = ctx.createLinearGradient(0, 0, 0, band * 1.6); gr.addColorStop(0, 'rgba(255,214,120,.16)'); gr.addColorStop(1, 'rgba(255,214,120,0)'); ctx.fillStyle = gr; ctx.fillRect(-14, 0, 28, band * 1.8); ctx.restore();
          }
          lamps.forEach(function (l) { var f = 0.75 + 0.25 * Math.sin(t * 6 + l.s) * Math.sin(t * 3.3 + l.s * 2); ctx.globalAlpha = 0.55 * f; ctx.drawImage(sprite(26, '255,170,60', true), l.x - 26, l.y - 30); ctx.globalAlpha = 0.95; ctx.drawImage(sprite(4, '255,245,200', false), l.x - 4, l.y - 9); });
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
          drawBokeh(ctx, gold, W, H, true);
        },
        fx: function (ctx) { pet.forEach(function (p, i) { if (!stepPetal(p, W, H)) pet[i] = newPetal(W, H, ['#facc15', '#fde047', '#eab308'], false, [1.8, 3]); petal(ctx, p); }); }
      };
    },

    onam: function (W, H, band, q) {
      var pal = ['#f97316', '#facc15', '#e11d48', '#fafaf9', '#c026d3', '#fb923c'];
      var pet = []; for (var i = 0; i < q(26); i++) pet.push(newPetal(W, H, pal, true, [1.8, 3.2]));
      var warm = bokeh(W, band, q(12), ['255,190,90', '255,120,140', '180,255,170'], [6, 12], 1.7);
      // pookalam: concentric rings of flower petals, pre-rendered once, turned slowly
      var pr = Math.max(14, band * 0.4), pk = document.createElement('canvas'); pk.width = pk.height = Math.ceil(pr * 2 + 4);
      var pg = pk.getContext('2d'), RC = ['#fde047', '#f97316', '#e11d48', '#fafaf9', '#16a34a', '#c026d3'];
      for (var ring = 0; ring < 6; ring++) { var rad = pr * (1 - ring * 0.16), n2 = Math.max(6, Math.round(rad * 0.9)); pg.fillStyle = RC[ring]; for (var j = 0; j < n2; j++) { var an2 = j / n2 * 6.283 + ring * 0.2; pg.beginPath(); pg.ellipse(pr + 2 + Math.cos(an2) * rad * 0.86, pr + 2 + Math.sin(an2) * rad * 0.86, rad * 0.09 + 0.6, rad * 0.05 + 0.5, an2, 0, 6.283); pg.fill(); } }
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = sky(ctx, H, band, '#0a1410', '#2a3a22', '#0e1711'); ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.25; ctx.drawImage(sprite(120, '255,170,80', true), W * 0.5 - 120, -150); ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(190,240,255,.10)'; ctx.lineWidth = 1;   // backwater shimmer along the band's lower edge
          for (var r = 0; r < 4; r++) { ctx.beginPath(); for (var x = 0; x <= W; x += 12) { var y = band - 6 + r * 3 + Math.sin(x * 0.03 + t * (1 + r * 0.3) + r) * 1.2; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
          ctx.globalCompositeOperation = 'source-over';
          drawBokeh(ctx, warm, W, band, true);
          ctx.save(); ctx.globalAlpha = 0.75; ctx.translate(W * 0.84, band * 0.5); ctx.rotate(t * 0.05); ctx.drawImage(pk, -pk.width / 2, -pk.height / 2); ctx.restore(); ctx.globalAlpha = 1;
        },
        fx: function (ctx) { pet.forEach(function (p, i) { if (!stepPetal(p, W, H)) pet[i] = newPetal(W, H, pal, false, [1.8, 3.2]); petal(ctx, p); }); }
      };
    },

    newyear: function (W, H, band, q) {
      var city = document.createElement('canvas'); city.width = Math.max(1, W); city.height = Math.max(1, band);
      var g = city.getContext('2d');
      for (var i = 0; i < W / 3; i++) { var c = pick(['255,214,140', '255,240,200', '200,170,255', '255,170,120']); g.globalAlpha = rnd(0.45, 1); g.drawImage(sprite(Math.round(rnd(1.5, 3.5)), c, true), rnd(0, W), band - rnd(2, band * 0.35)); }
      for (var bx = 0; bx < W; bx += rnd(8, 22)) { var bh = rnd(band * 0.12, band * 0.42); g.globalAlpha = 0.9; g.fillStyle = '#05040f'; g.fillRect(bx, band - bh, rnd(6, 16), bh); g.globalAlpha = 0.7; g.fillStyle = '#ffd68a'; for (var wy = band - bh + 3; wy < band - 2; wy += 4) if (Math.random() < 0.35) g.fillRect(bx + rnd(1, 5), wy, 1.2, 1.2); }
      var glitter = []; for (var k = 0; k < q(26); k++) glitter.push({ x: rnd(0, W), y: rnd(0, H), v: rnd(0.15, 0.4), s: rnd(0, 6.28) });
      var shells = [], sparks = [], flashes = [], next = 0.3;
      var COLS = ['255,214,120', '255,140,190', '170,200,255', '255,255,255', '200,150,255'];
      function launch() { shells.push({ x: rnd(W * 0.08, W * 0.92), y: band + 4, vy: -rnd(2.3, 2.9), ty: rnd(band * 0.18, band * 0.45), c: pick(COLS) }); }
      function burst(s) { flashes.push({ x: s.x, y: s.y, t: 0, c: s.c }); var n = q(64); for (var i = 0; i < n; i++) { var an = rnd(0, 6.283), sp = rnd(0.9, 2.9); sparks.push({ x: s.x, y: s.y, px: s.x, py: s.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, life: rnd(48, 78), age: 0, c: Math.random() < 0.15 ? '255,255,255' : s.c }); } }
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = sky(ctx, H, band, '#06051a', '#2c1d55', '#0b0920'); ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 0.9 + 0.1 * Math.sin(t); ctx.drawImage(city, 0, 0); ctx.globalAlpha = 1;
        },
        fx: function (ctx, t, dt) {
          next -= dt; if (next <= 0 && shells.length < 2) { launch(); next = rnd(1.6, 3.4); }
          ctx.globalCompositeOperation = 'lighter';
          for (var i = shells.length - 1; i >= 0; i--) { var s = shells[i]; s.y += s.vy; s.vy *= 0.985; ctx.globalAlpha = 0.8; ctx.drawImage(sprite(3, '255,220,170', true), s.x - 3, s.y - 3); if (s.y <= s.ty || s.vy > -0.6) { burst(s); shells.splice(i, 1); } }
          for (var j = sparks.length - 1; j >= 0; j--) { var p = sparks[j]; p.px = p.x; p.py = p.y; p.vx *= 0.975; p.vy = p.vy * 0.975 + 0.035; p.x += p.vx; p.y += p.vy; p.age++;
            var a = 1 - p.age / p.life; if (a <= 0) { sparks.splice(j, 1); continue; }
            ctx.globalAlpha = a * (p.age % 6 < 3 && p.age > p.life * 0.6 ? 0.4 : 1); ctx.strokeStyle = 'rgba(' + p.c + ',1)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke(); }
          for (var fl = flashes.length - 1; fl >= 0; fl--) { var f = flashes[fl]; ctx.globalAlpha = Math.max(0, 0.55 - f.t * 0.06); ctx.drawImage(sprite(30, f.c, true), f.x - 30, f.y - 30); if (++f.t > 9) flashes.splice(fl, 1); }
          ctx.fillStyle = '#fde68a';
          glitter.forEach(function (gl) { gl.y += gl.v; gl.s += 0.12; if (gl.y > H) { gl.y = -2; gl.x = rnd(0, W); } ctx.globalAlpha = 0.25 + 0.6 * Math.abs(Math.sin(gl.s)); ctx.fillRect(gl.x, gl.y, 1.2, 1.2); });
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
      };
    },

    monsoon: function (W, H, band, q) {
      var rain = []; for (var i = 0; i < q(90); i++) { var z = Math.random(); rain.push({ z: z, x: rnd(-20, W + 40), y: rnd(-30, H), l: 7 + z * 12, v: 4 + z * 5 }); }
      var drops = []; for (var k = 0; k < q(16); k++) drops.push({ x: rnd(0, W), y: rnd(0, band), r: rnd(1.2, 2.6), v: Math.random() < 0.35 ? rnd(0.15, 0.5) : 0 });
      var fog = bokeh(W, band, q(5), ['148,163,184'], [40, 70], 0.8), bolt = null, flash = 0, nextBolt = rnd(6, 12);
      function makeBolt() { var pts = [[rnd(W * 0.5, W * 0.92), -4]], x = pts[0][0], y = -4; while (y < band * 0.9) { x += rnd(-9, 9); y += rnd(5, 9); pts.push([x, y]); } return { pts: pts, age: 0, br: pts.slice(3, 4).map(function (p0) { var b = [p0], bx = p0[0], by = p0[1]; for (var s = 0; s < 4; s++) { bx += rnd(4, 10); by += rnd(4, 8); b.push([bx, by]); } return b; }) }; }
      return {
        bg: function (ctx, t, dt) {
          ctx.fillStyle = sky(ctx, H, band, '#08111e', '#1f3552', '#0a1524'); ctx.fillRect(0, 0, W, H);
          drawBokeh(ctx, fog, W, band, true);
          nextBolt -= dt; if (nextBolt <= 0) { bolt = makeBolt(); flash = 1; nextBolt = rnd(9, 18); }
          if (flash > 0) { ctx.globalAlpha = flash * 0.28; ctx.fillStyle = '#dbeafe'; ctx.fillRect(0, 0, W, H); flash -= 0.08; ctx.globalAlpha = 1; }
          if (bolt && bolt.age < 6) {
            ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(219,234,254,' + (1 - bolt.age / 6) + ')'; ctx.lineWidth = 1.4; ctx.shadowColor = '#93c5fd'; ctx.shadowBlur = 8;
            [bolt.pts].concat(bolt.br).forEach(function (pp) { ctx.beginPath(); pp.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.stroke(); });
            ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'source-over'; bolt.age++;
          }
          // beads of water on the "glass" (some slide down)
          drops.forEach(function (d) { d.y += d.v; if (d.y > band) { d.y = -3; d.x = rnd(0, W); }
            ctx.globalAlpha = 0.5; ctx.fillStyle = 'rgba(15,30,50,.6)'; ctx.beginPath(); ctx.arc(d.x, d.y + 0.6, d.r, 0, 6.283); ctx.fill();
            ctx.globalAlpha = 0.7; ctx.fillStyle = 'rgba(200,230,255,.35)'; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 6.283); ctx.fill();
            ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff'; ctx.fillRect(d.x - d.r * 0.4, d.y - d.r * 0.5, 0.9, 0.9); });
          ctx.globalAlpha = 1;
        },
        fx: function (ctx) {
          rain.forEach(function (p) { p.y += p.v; p.x -= p.v * 0.22; if (p.y > H) { p.y = rnd(-30, -6); p.x = rnd(-10, W + 40); }
            ctx.globalAlpha = 0.08 + p.z * 0.24; ctx.strokeStyle = '#bae6fd'; ctx.lineWidth = p.z > 0.7 ? 1.1 : 0.7; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.l * 0.22, p.y + p.l); ctx.stroke(); });
          ctx.globalAlpha = 1;
        }
      };
    },

    summer: function (W, H, band, q) {
      var motes = bokeh(W, H, q(22), ['255,226,150', '255,200,120'], [1.5, 3.5]), heat = bokeh(W, band, q(8), ['255,170,90'], [10, 18]);
      var sx = W * 0.82, sy = band * 0.25;
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = sky(ctx, H, band, '#1c1007', '#5a3412', '#1a110a'); ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter';
          var pulse = 1 + 0.04 * Math.sin(t * 0.8);
          ctx.globalAlpha = 0.5; ctx.drawImage(sprite(Math.round(150 * pulse), '255,170,70', true), sx - 150 * pulse, sy - 150 * pulse);
          ctx.globalAlpha = 0.9; ctx.drawImage(sprite(26, '255,236,180', false), sx - 26, sy - 26);
          // lens flare chain toward the lower-left, drifting gently
          [[0.35, 10, 0.18], [0.55, 6, 0.22], [0.75, 16, 0.1], [1.05, 8, 0.16]].forEach(function (f, i) { var fx = sx + (W * 0.35 - sx) * f[0] + Math.sin(t * 0.3 + i) * 3, fy = sy + (band * 0.95 - sy) * f[0]; ctx.globalAlpha = f[2]; ctx.drawImage(sprite(f[1], i % 2 ? '180,220,255' : '255,210,140', true), fx - f[1], fy - f[1]); });
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
          drawBokeh(ctx, heat, W, band, true);
        },
        fx: function (ctx) { drawBokeh(ctx, motes, W, H, true); }
      };
    },

    navaratri: function (W, H, band, q, accent, gap) {
      // Minimal: a faint maroon-gold wash, 3 (desktop) small brass lamps placed only in the empty
      // space between search and the right-hand controls, a calm flame flicker, a few slow embers.
      var lamps = [], free = gap && gap.b - gap.a > 120 ? gap : null;
      if (free && !isPhone()) { var n = free.b - free.a > 360 ? 3 : free.b - free.a > 200 ? 2 : 1; for (var i = 0; i < n; i++) lamps.push({ x: free.a + (free.b - free.a) * (i + 1) / (n + 1), y: H * 0.5, s: rnd(0, 6.28), sz: i === Math.floor(n / 2) ? 1 : 0.85 }); }
      var embers = []; for (var k = 0; k < q(7); k++) embers.push({ x: free ? rnd(free.a, free.b) : rnd(0, W), y: rnd(0, H), v: rnd(0.06, 0.16), s: rnd(0, 6.28), a: rnd(0.25, 0.5) });
      function lamp(ctx, L, t) {
        var sc = L.sz, x = L.x, y = L.y;
        var f = 0.92 + 0.05 * Math.sin(t * 3.1 + L.s) + 0.03 * Math.sin(t * 7.3 + L.s * 2);   // calm flicker, never blinking
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.28 * f; ctx.drawImage(sprite(Math.round(22 * sc), '255,150,50', true), x - 22 * sc, y - 26 * sc); ctx.globalCompositeOperation = 'source-over';
        // brass bowl: shaded half-ellipse with a lit rim
        ctx.globalAlpha = 1; var bw = 9 * sc, bh = 4.2 * sc, by = y + 4 * sc;
        var gb = ctx.createLinearGradient(x - bw, by, x + bw, by); gb.addColorStop(0, '#4a2a0c'); gb.addColorStop(0.45, '#b7791f'); gb.addColorStop(0.6, '#e2b45a'); gb.addColorStop(1, '#3d220a');
        ctx.fillStyle = gb; ctx.beginPath(); ctx.ellipse(x, by, bw, bh, 0, 0, Math.PI); ctx.fill();
        ctx.strokeStyle = 'rgba(246,211,140,.8)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.ellipse(x, by, bw, 1.4 * sc, 0, 0, 6.283); ctx.stroke();
        // flame: outer orange body, inner pale core, both leaning very slightly
        var fh = 9 * sc * f, lean = Math.sin(t * 1.3 + L.s) * 0.6;
        var gf = ctx.createRadialGradient(x, by - 2 * sc, 0.5, x, by - fh * 0.45, fh * 0.75); gf.addColorStop(0, 'rgba(255,250,225,1)'); gf.addColorStop(0.35, 'rgba(255,214,110,.95)'); gf.addColorStop(0.75, 'rgba(249,115,22,.55)'); gf.addColorStop(1, 'rgba(249,115,22,0)');
        ctx.fillStyle = gf; ctx.beginPath(); ctx.moveTo(x - 2.6 * sc, by - 1 * sc); ctx.quadraticCurveTo(x - 2.2 * sc, by - fh * 0.6, x + lean, by - fh); ctx.quadraticCurveTo(x + 2.2 * sc, by - fh * 0.6, x + 2.6 * sc, by - 1 * sc); ctx.closePath(); ctx.fill();
      }
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = lin(ctx, H, [[0, 'rgba(48,10,22,.42)'], [1, 'rgba(30,8,14,.12)']]); ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.12; if (free) ctx.drawImage(sprite(90, '255,160,60', true), (free.a + free.b) / 2 - 90, H * 0.5 - 90); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
          lamps.forEach(function (L) { lamp(ctx, L, t); });
        },
        fx: function (ctx) {
          ctx.globalCompositeOperation = 'lighter';
          embers.forEach(function (e) { e.y -= e.v; e.s += 0.02; e.x += Math.sin(e.s) * 0.15; if (e.y < -3) { e.y = H + 3; e.x = free ? rnd(free.a, free.b) : rnd(0, W); } ctx.globalAlpha = e.a * (0.7 + 0.3 * Math.sin(e.s * 2)); ctx.drawImage(sprite(2, '255,180,90', true), e.x - 2, e.y - 2); });
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
      };
    },

    custom: function (W, H, band, q, accent) {
      var orbs = bokeh(W, H, q(14), [accent || '255,138,61', '255,255,255'], [5, 12]);
      return { bg: function (ctx) { ctx.fillStyle = lin(ctx, H, [[0, '#0b0f1c'], [1, '#0d1220']]); ctx.fillRect(0, 0, W, H); drawBokeh(ctx, orbs, W, H, true); }, fx: function () {} };
    }
  };
  function hexRgb(h) { var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || ''); return m ? parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) : null; }

  function render(header, theme, opts) {
    if (!header || !theme) return function () {};
    css(); opts = opts || {};
    var c = cfgOf(theme), phone = isPhone() || opts.compact, still = reducedMotion(), weak = lowPower();
    var cls = ['bst', 'bst-' + c.preset, 'bst-scene', 'bst-band', c.glow ? 'bst-glow' : '', c.accent ? 'bst-accent' : ''].filter(Boolean);
    cls.forEach(function (k) { header.classList.add(k); });
    header.style.setProperty('--bst-accent', c.colors.accent);
    header.style.setProperty('--bst-line', c.colors.line);
    header.style.setProperty('--bst-glow', c.colors.glow);
    var band = 44, gap = { a: 0, b: 0 };   // band = the header's own height (measured in build); gap = empty space between search and the right controls
    var bg = document.createElement('div'); bg.className = 'bst-bg'; bg.setAttribute('aria-hidden', 'true');
    var caps = document.createElement('div'); caps.className = 'bst-caps'; caps.setAttribute('aria-hidden', 'true');
    var cv = document.createElement('canvas');
    bg.appendChild(cv);
    header.insertBefore(bg, header.firstChild); header.appendChild(caps);
    // optional own banner image (HR upload): shown under the scene's moving light
    var ban = null;
    if (c.banner) {
      ban = document.createElement('div'); ban.className = 'bst-banner'; ban.style.backgroundPosition = c.bannerPos; bg.insertBefore(ban, cv);
      header.style.setProperty('--bst-dark', c.bannerDark);
      var bimg = new Image(); bimg.decoding = 'async';
      bimg.onload = function () { ban.style.backgroundImage = 'url("' + c.banner.replace(/"/g, '%22') + '")'; setTimeout(function () { ban.classList.add('on'); }, 30); };
      bimg.onerror = function () { ban.remove(); ban = null; };
      bimg.src = c.banner;
    }
    if (c.preset === 'newyear') {
      var td = today(), yr = +td.slice(0, 4) + (td.slice(5, 7) === '12' ? 1 : 0);
      if (!document.getElementById('bst-font')) { var lk = document.createElement('link'); lk.id = 'bst-font'; lk.rel = 'stylesheet'; lk.href = 'https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap'; document.head.appendChild(lk); }
      var ny = document.createElement('span'); ny.className = 'bst-ny'; ny.innerHTML = '<em>Happy New Year</em><b>' + yr + '</b>'; bg.appendChild(ny);
    }
    if (c.asset && !phone) { var img = new Image(); img.className = 'bst-asset'; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.onerror = function () { img.remove(); }; img.src = c.asset; bg.appendChild(img); }

    // caps on controls + the glass bar behind the control row
    var TARGETS = '.bes-clockpill .bcp-btn,.bes-date,.bes-icon,.bes-account .bes-av,.bes-search';
    function place() {
      var hr = header.getBoundingClientRect(); if (!hr.width) return;
      var sr = header.querySelector('.bes-search'), rr = header.querySelector('.bes-right'), ga = sr && sr.offsetParent ? sr.getBoundingClientRect().right - hr.left : 0, gb = hr.width;
      if (rr) Array.prototype.forEach.call(rr.children, function (ch) { if (ch.offsetParent === null) return; var l = ch.getBoundingClientRect().left - hr.left; if (l > ga && l < gb) gb = l; });
      gap.a = ga + 14; gap.b = gb - 14;
      var nyEl = bg.querySelector('.bst-ny'); if (nyEl) { nyEl.style.left = gap.a + 'px'; nyEl.style.width = Math.max(0, gap.b - gap.a) + 'px'; nyEl.hidden = gap.b - gap.a < 260; }
      caps.innerHTML = '';
      if (!c.caps) return;
      header.querySelectorAll(TARGETS).forEach(function (el) {
        var r = el.getBoundingClientRect(); if (!r.width || !r.height || el.offsetParent === null) return;
        var x = r.left - hr.left, y = r.top - hr.top;
        if (c.caps === 'snow' && c.preset === 'christmas' && el.classList.contains('bcp-btn') && !phone) {
          var hat = document.createElement('i'); hat.className = 'bst-cap hat'; hat.innerHTML = SVG.hat; hat.style.left = (x + r.width - 20) + 'px'; hat.style.top = (y - 15) + 'px'; caps.appendChild(hat);
        } else if (c.caps === 'snow') {
          var w = Math.round(Math.min(r.width, phone ? 70 : 160)), H2 = Math.round(Math.min(18, 10 + w / 18)), cap = document.createElement('i'); cap.className = 'bst-cap snow';
          cap.style.left = (x + (r.width - w) / 2 - 3) + 'px'; cap.style.top = (y - H2 + 2) + 'px'; cap.innerHTML = snowCapSVG(w); caps.appendChild(cap);
        } else if (c.caps === 'drops') {
          [[0.18, -1, 4], [0.74, 1, 6], [0.9, r.height - 4, 4]].forEach(function (p, i) { if (phone && i) return; var dr = document.createElement('i'); dr.className = 'bst-cap drop'; dr.style.left = (x + r.width * p[0]) + 'px'; dr.style.top = (y + p[1]) + 'px'; dr.style.setProperty('--s', p[2] + 'px'); caps.appendChild(dr); });
        }
      });
    }
    // the scene
    var ctx = cv.getContext('2d'), W = 0, H = 0, scene = null, raf = 0, last = 0, visible = true, io = null, t0 = performance.now(), prev = t0;
    var factor = phone ? 0.4 : weak ? 0.6 : 1, intens = c.intensity === 'normal' ? 1.3 : 1;
    var q = function (n) { return Math.max(1, Math.round(n * factor * intens)); };
    function build() {
      var r = bg.getBoundingClientRect(), dpr = Math.min(phone ? 1.25 : 1.5, window.devicePixelRatio || 1);
      if (!r.width) return; W = r.width; H = r.height; band = H;
      cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr)); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var mk = SCENES[c.preset] || SCENES.custom;
      scene = mk(W, H, band, q, hexRgb(c.colors.accent), gap);
      frame(performance.now(), true);
    }
    function frame(now, force) {
      if (!scene) return;
      var t = (now - t0) / 1000, dt = Math.min(0.1, (now - prev) / 1000); prev = now;
      ctx.clearRect(0, 0, W, H);
      if (!c.banner && c.overlay) scene.bg(ctx, t, dt);
      if (c.particles || force) { if (c.particles) scene.fx(ctx, t, dt); }
    }
    function loop(now) {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || now - last < 33) return; last = now;
      frame(now);
    }
    place(); build();
    var ro = window.ResizeObserver ? new ResizeObserver(function () { clearTimeout(ro.t); ro.t = setTimeout(function () { place(); build(); }, 120); }) : null;
    if (ro) ro.observe(header);
    var mo = new MutationObserver(function () { clearTimeout(mo.t); mo.t = setTimeout(place, 150); });
    mo.observe(header, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    if (!still) {
      if (window.IntersectionObserver) { io = new IntersectionObserver(function (es) { visible = es[0] && es[0].isIntersecting; }); io.observe(header); }
      raf = requestAnimationFrame(loop);
    }
    return function destroy() {
      cancelAnimationFrame(raf); if (ro) ro.disconnect(); mo.disconnect(); if (io) io.disconnect();
      bg.remove(); caps.remove();
      cls.forEach(function (k) { header.classList.remove(k); });
      ['--bst-accent', '--bst-line', '--bst-glow', '--bst-band', '--bst-dark'].forEach(function (v) { header.style.removeProperty(v); });
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
    var seq = S.seq = (S.seq || 0) + 1;   // a later decorate() call always wins
    var pv = previewTheme();
    var t = pv || (ls(K_OFF) === '1' ? null : schedule(await loadThemes(), await myDivision(), null, currentPortal()));
    if (seq !== S.seq) return;
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
      '.bsa-row{display:grid;grid-template-columns:96px minmax(0,1.4fr) minmax(0,1fr) auto auto;gap:14px;align-items:center;padding:12px 14px;border-radius:14px;background:#0e1222;border:1px solid rgba(255,255,255,.07)}',
      '.bsa-sw{width:96px;height:30px;border-radius:9px;position:relative;overflow:hidden;border:1px solid rgba(255,255,255,.1)}',
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
      '@media(max-width:860px){.bsa-row{grid-template-columns:72px minmax(0,1fr);}.bsa-sw{width:72px!important}.bsa-row>.bsa-when,.bsa-row>.bsa-seg,.bsa-row>.bsa-acts{grid-column:1/-1}.bsa-grid{grid-template-columns:1fr}}'
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
          var art = t.config && t.config.banner && t.config.banner !== 'none' ? t.config.banner : (t.config && t.config.banner === 'none' ? null : p.art);
          return '<div class="bsa-row" data-id="' + t.id + '"><span class="bsa-sw" data-sw="' + t.id + '" style="background:' + (art ? 'url(&quot;' + esc(art) + '&quot;) center/cover' : 'linear-gradient(135deg,' + p.glow + ',#0b0f1c)') + '"></span>'
            + '<div><b>' + esc(t.name) + '</b><small>' + esc((KINDS.filter(function (k) { return k[0] === t.kind; })[0] || ['', p.kind || ''])[1]) + ' · priority ' + (t.priority || 0) + ' · ' + (t.portals && t.portals.length ? esc(t.portals.map(function (x) { return (PORTALS.filter(function (o) { return o[0] === x; })[0] || [0, x])[1]; }).join(', ')) + ' · ' : '') + (t.departments && t.departments.length ? esc(t.departments.map(function (c) { var d = divs.filter(function (x) { return x.code === c; })[0]; return d ? d.name : c; }).join(', ')) : 'All departments') + '</small></div>'
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
    var f = src ? JSON.parse(JSON.stringify(src)) : { preset: 'custom', kind: 'custom', portals: [], name: '', start_date: today(), end_date: today(), repeat_yearly: false, auto_active: true, manual_state: 'auto', priority: 50, departments: [], enabled: true, config: {}, asset_url: '' };
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
        + '<div class="bsa-row2"><div class="bsa-f"><label>Type</label><select class="bsa-in" data-k="kind">' + KINDS.map(function (k) { return '<option value="' + k[0] + '"' + ((f.kind || 'festival') === k[0] ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select></div>'
        + '<div class="bsa-f"><label>Style</label><select class="bsa-in" data-k="preset">' + Object.keys(PRESETS).map(function (k) { return '<option value="' + k + '"' + (f.preset === k ? ' selected' : '') + '>' + esc(PRESETS[k].label) + '</option>'; }).join('') + '</select></div></div>'
        + '<div class="bsa-row2"><div class="bsa-f"><label>Start date</label><input class="bsa-in" type="date" data-k="start_date" value="' + esc(f.start_date || '') + '"></div><div class="bsa-f"><label>End date</label><input class="bsa-in" type="date" data-k="end_date" value="' + esc(f.end_date || '') + '"></div></div>'
        + '<div class="bsa-f"><span>Schedule</span><div class="bsa-chips"><button type="button" class="bsa-ch' + (f.repeat_yearly ? ' on' : '') + '" data-tog="repeat_yearly">Repeat every year</button><button type="button" class="bsa-ch' + (f.auto_active ? ' on' : '') + '" data-tog="auto_active">Auto-activate on these dates</button><button type="button" class="bsa-ch' + (f.enabled ? ' on' : '') + '" data-tog="enabled">Enabled</button></div></div>'
        + '<div class="bsa-row2"><div class="bsa-f"><label>Activation</label><select class="bsa-in" data-k="manual_state"><option value="auto"' + (f.manual_state === 'auto' ? ' selected' : '') + '>Automatic (by date)</option><option value="on"' + (f.manual_state === 'on' ? ' selected' : '') + '>On now (manual)</option><option value="off"' + (f.manual_state === 'off' ? ' selected' : '') + '>Off (manual)</option></select></div>'
        + '<div class="bsa-f"><label>Priority</label><select class="bsa-in" data-k="priority">' + [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(function (n) { return '<option value="' + n + '"' + (+f.priority === n ? ' selected' : '') + '>' + n + (n === 100 ? ' (highest)' : n === 10 ? ' (lowest)' : '') + '</option>'; }).join('') + '</select></div></div>'
        + '<div class="bsa-f"><span>Applies to</span><div class="bsa-chips"><button type="button" class="bsa-ch' + (!f.departments.length ? ' on' : '') + '" data-dep="">All departments</button>' + divs.map(function (d) { return '<button type="button" class="bsa-ch' + (f.departments.indexOf(d.code) > -1 ? ' on' : '') + '" data-dep="' + esc(d.code) + '">' + esc(d.name) + '</button>'; }).join('') + '</div></div>'
        + '<div class="bsa-f"><span>Show in</span><div class="bsa-chips"><button type="button" class="bsa-ch' + (!(f.portals || []).length ? ' on' : '') + '" data-por="">All suites</button>' + PORTALS.map(function (o) { return '<button type="button" class="bsa-ch' + ((f.portals || []).indexOf(o[0]) > -1 ? ' on' : '') + '" data-por="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></div>'
        + '</div><div class="bsa-col">'
        + '<div class="bsa-f"><span>Preview</span><div class="bsa-mock" data-mock>' + mockHeader() + '</div></div>'
        + '<div class="bsa-f"><span>Effects</span><div class="bsa-chips">' + EFFECTS.map(function (x) { return '<button type="button" class="bsa-ch' + (f.config[x[0]] !== false ? ' on' : '') + '" data-fx="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div><em class="bsa-note">Effects a style doesn’t have are ignored (e.g. Summer has no falling effect).</em></div>'
        + '<div class="bsa-f"><span>Intensity</span><div class="bsa-chips"><button type="button" class="bsa-ch' + (f.config.intensity !== 'normal' ? ' on' : '') + '" data-int="subtle">Subtle</button><button type="button" class="bsa-ch' + (f.config.intensity === 'normal' ? ' on' : '') + '" data-int="normal">Normal</button></div></div>'
        + (function () { var pa = (PRESETS[f.preset] || {}).art, cur = f.config.banner, mode = cur === 'none' ? 'none' : cur ? 'custom' : (pa ? 'builtin' : 'none');
            return '<div class="bsa-f"><label>Banner image</label><div class="bsa-chips">' + (pa ? '<button type="button" class="bsa-ch' + (mode === 'builtin' ? ' on' : '') + '" data-ban="builtin">Built-in artwork</button>' : '') + '<button type="button" class="bsa-ch' + (mode === 'custom' ? ' on' : '') + '" data-ban="custom">My image</button><button type="button" class="bsa-ch' + (mode === 'none' ? ' on' : '') + '" data-ban="none">No banner</button></div>'
              + (mode === 'custom' ? '<div style="display:flex;gap:8px;margin-top:6px"><input class="bsa-in" data-cfg="banner" placeholder="https:// — wide JPG / WebP" value="' + esc(cur || '') + '"><button type="button" class="bsa-btn sm" data-up="banner" style="height:38px">Upload</button></div>' : '')
              + '<em class="bsa-note">' + (mode === 'none' ? 'Uses the drawn header scene instead of a photo banner.' : 'Wide scene (about 24:1, e.g. 2400 × 100 px or larger, JPG/WebP under 3 MB). Shown as a band above the controls; effects animate on top.') + '</em></div>'; })()
        + ((f.config.banner !== 'none' && (f.config.banner || (PRESETS[f.preset] || {}).art)) ? '<div class="bsa-row2"><div class="bsa-f"><span>Darken</span><div class="bsa-chips">' + [['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']].map(function (o) { return '<button type="button" class="bsa-ch' + ((f.config.banner_dark || 'medium') === o[0] ? ' on' : '') + '" data-opt="banner_dark" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></div>'
          + '<div class="bsa-f"><span>Show image</span><div class="bsa-chips">' + [['top', 'Top'], ['center', 'Centre'], ['bottom', 'Bottom']].map(function (o) { return '<button type="button" class="bsa-ch' + ((f.config.banner_pos || 'center') === o[0] ? ' on' : '') + '" data-opt="banner_pos" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></div></div>'
          + '<div class="bsa-f"><span>Header height</span><div class="bsa-chips">' + [['slim', 'Slim'], ['tall', 'Tall (shows more of the image)']].map(function (o) { return '<button type="button" class="bsa-ch' + ((f.config.banner_h || 'slim') === o[0] ? ' on' : '') + '" data-opt="banner_h" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></div>' : '')
        + '<div class="bsa-f"><label>Decorative image (optional)</label><div style="display:flex;gap:8px"><input class="bsa-in" data-k="asset_url" placeholder="https:// — PNG / SVG / WebP" value="' + esc(f.asset_url || '') + '"><button type="button" class="bsa-btn sm" data-up="asset" style="height:38px">Upload</button><input type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" data-file hidden></div><em class="bsa-note">Shown small at the right of the header on desktop only.</em></div>'
        + '</div></div><div class="bsa-err" data-err></div>'
        + '<div class="bsa-foot">' + (src ? '<button type="button" class="bsa-btn" data-del style="margin-right:auto;color:#fca5a5">Delete</button>' : '') + '<button type="button" class="bsa-btn" data-x>Cancel</button><button type="button" class="bsa-btn pri" data-save>' + (src ? 'Save theme' : 'Create theme') + '</button></div>';
      if (stopPv) stopPv();
      var mh = dlg.querySelector('[data-mock] .bes-header');
      stopPv = render(mh, f, { compact: false });
    }
    function grab() {
      dlg.querySelectorAll('[data-k]').forEach(function (x) { var k = x.getAttribute('data-k'); f[k] = k === 'priority' ? +x.value : x.value; });
      dlg.querySelectorAll('[data-cfg]').forEach(function (x) { f.config[x.getAttribute('data-cfg')] = x.value.trim(); });
    }
    dlg.addEventListener('change', function (e) { if (e.target.getAttribute && e.target.getAttribute('data-cfg') === 'banner') { grab(); return draw(); } if (e.target.getAttribute && e.target.getAttribute('data-k') === 'preset') { grab(); if (!f.name || Object.keys(PRESETS).some(function (k) { return PRESETS[k].label === f.name; })) f.name = PRESETS[f.preset].label; f.kind = PRESETS[f.preset].kind || f.kind; draw(); } });
    dlg.addEventListener('click', async function (e) {
      var b = e.target.closest('button'); if (!b || busy) return;
      if (b.hasAttribute('data-x')) return close();
      if (b.hasAttribute('data-tog')) { grab(); var k = b.getAttribute('data-tog'); f[k] = !f[k]; b.classList.toggle('on', f[k]); return; }
      if (b.hasAttribute('data-dep')) { grab(); var c = b.getAttribute('data-dep'); if (!c) f.departments = []; else { var i = f.departments.indexOf(c); if (i > -1) f.departments.splice(i, 1); else f.departments.push(c); } return draw(); }
      if (b.hasAttribute('data-fx')) { grab(); var x = b.getAttribute('data-fx'); f.config[x] = f.config[x] === false; return draw(); }
      if (b.hasAttribute('data-int')) { grab(); f.config.intensity = b.getAttribute('data-int'); return draw(); }
      if (b.hasAttribute('data-ban')) { grab(); var bm = b.getAttribute('data-ban'); if (bm === 'builtin') delete f.config.banner; else if (bm === 'none') f.config.banner = 'none'; else if (!f.config.banner || f.config.banner === 'none') f.config.banner = ''; return draw(); }
      if (b.hasAttribute('data-por')) { grab(); var po = b.getAttribute('data-por'); f.portals = f.portals || []; if (!po) f.portals = []; else { var pi2 = f.portals.indexOf(po); if (pi2 > -1) f.portals.splice(pi2, 1); else f.portals.push(po); } return draw(); }
      if (b.hasAttribute('data-opt')) { grab(); f.config[b.getAttribute('data-opt')] = b.getAttribute('data-v'); return draw(); }
      if (b.hasAttribute('data-up')) { var which = b.getAttribute('data-up'), fi = dlg.querySelector('[data-file]'); fi.value = ''; fi.onchange = async function () {
          var file = fi.files && fi.files[0]; if (!file) return; var max = which === 'banner' ? 3 : 1; if (file.size > max * 1024 * 1024) { dlg.querySelector('[data-err]').textContent = 'Image must be under ' + max + ' MB.'; return; }
          b.disabled = true; b.textContent = 'Uploading…';
          var path = 'header-themes/' + Date.now() + '-' + file.name.replace(/[^a-z0-9.\-]+/gi, '_');
          var up = await db().storage.from('celebration-media').upload(path, file, { contentType: file.type, upsert: true });
          b.disabled = false; b.textContent = 'Upload';
          if (up.error) { dlg.querySelector('[data-err]').textContent = 'Upload failed: ' + up.error.message; return; }
          grab(); var pub = db().storage.from('celebration-media').getPublicUrl(path).data.publicUrl; if (which === 'banner') f.config.banner = pub; else f.asset_url = pub; draw();
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
        if (f.config.banner === '') delete f.config.banner;
        var row = { preset: f.preset, kind: f.kind || (PRESETS[f.preset] || {}).kind || 'custom', portals: f.portals || [], name: String(f.name).trim().slice(0, 60), start_date: f.start_date || null, end_date: f.end_date || null, repeat_yearly: !!f.repeat_yearly, auto_active: !!f.auto_active,
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
