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
    monsoon:      { label: 'Monsoon',          kind: 'seasonal', particles: 'rain',    caps: null, overlay: 'mist',     art: null,      accent: '#7dd3fc', line: 'rgba(125,211,252,.24)', glow: 'rgba(96,165,250,.12)' },
    summer:       { label: 'Summer',           kind: 'seasonal', particles: 'motes',   caps: null,    overlay: 'sun',      art: null,                      accent: '#fbbf24', line: 'rgba(251,191,36,.26)',  glow: 'rgba(251,191,36,.14)' },
    custom:       { label: 'Custom',           kind: 'custom',   particles: null,      caps: null,    overlay: null,       art: null,                      accent: '#ff8a3d', line: 'rgba(255,138,61,.24)',  glow: 'rgba(255,138,61,.12)' }
  };
  // default dates for built-ins (yearly); festivals that move every year have none — HR sets them
  var DEF_DATES = { christmas: ['2026-12-20', '2026-12-31', '20 Dec – 31 Dec · every year'], newyear: ['2026-12-31', '2027-01-01', '31 Dec – 1 Jan · every year'], independence: ['2026-08-15', '2026-08-15', '15 Aug · every year'], vishu: ['2026-04-14', '2026-04-15', '14 – 15 Apr · every year'], monsoon: ['2026-06-01', '2026-09-30', '1 Jun – 30 Sep · every year'], summer: ['2026-03-01', '2026-05-31', '1 Mar – 31 May · every year'] };
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
      for (var k = 0; k < q(54); k++) { var z = Math.random(); snow.push({ z: z, x: rnd(0, W), y: rnd(-10, H), r: 0.6 + z * z * 2.2, v: 0.12 + z * 0.42, s: rnd(0, 6.28), sw: rnd(0.15, 0.45) }); }
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

    independence: function (W, H, band, q, accent, gap) {
      // Faint saffron / green light at the two ends, one small silk flag waving in the empty
      // space (folds shaded from the wave, chakra on the white band), a few slow petals.
      var free = gap && gap.b - gap.a > 140 && !isPhone() ? gap : null;
      var pal = ['#ff9933', '#f6f7f2', '#138808'], pet = []; for (var i = 0; i < q(6); i++) pet.push(newPetal(W, H, pal, true, [1.8, 2.8]));
      function flag(ctx, t) {
        var fw = Math.min(96, (free.b - free.a) * 0.42, (H - 10) / 0.62), fh = fw * 0.6, x0 = (free.a + free.b) / 2 - fw / 2 + 4, y0 = Math.max(4, H * 0.5 - fh / 2 - 4), step = 2;
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.12; ctx.drawImage(sprite(Math.round(fw * 0.9), '255,220,170', true), x0 + fw / 2 - fw * 0.9, y0 + fh / 2 - fw * 0.9); ctx.globalCompositeOperation = 'source-over';
        var pg2 = ctx.createLinearGradient(x0 - 4, 0, x0 - 1.5, 0); pg2.addColorStop(0, '#64748b'); pg2.addColorStop(0.5, '#e2e8f0'); pg2.addColorStop(1, '#94a3b8');
        ctx.globalAlpha = 0.95; ctx.fillStyle = pg2; ctx.fillRect(x0 - 4, y0 - 2, 2.2, H - y0 + 2);   // pole
        ctx.fillStyle = '#e8c56a'; ctx.beginPath(); ctx.arc(x0 - 2.9, y0 - 3.2, 2, 0, 6.283); ctx.fill();   // brass finial
        for (var x = 0; x < fw; x += step) {
          var ph = x * 0.11 - t * 2.2, k = x / fw, dy = Math.sin(ph) * 2.2 * k, sh = Math.cos(ph) * 0.24 * (0.3 + k);
          ctx.globalAlpha = 0.92; ctx.fillStyle = '#ff9933'; ctx.fillRect(x0 + x, y0 + dy, step + 0.5, fh / 3);
          ctx.fillStyle = '#f6f7f2'; ctx.fillRect(x0 + x, y0 + dy + fh / 3, step + 0.5, fh / 3);
          ctx.fillStyle = '#138808'; ctx.fillRect(x0 + x, y0 + dy + 2 * fh / 3, step + 0.5, fh / 3);
          ctx.globalAlpha = Math.abs(sh); ctx.fillStyle = sh > 0 ? '#fff' : '#000'; ctx.fillRect(x0 + x, y0 + dy, step + 0.5, fh);
        }
        var cx = x0 + fw / 2, cy = y0 + fh / 2 + Math.sin(fw / 2 * 0.11 - t * 2.2) * 1.1, rr = fh / 7;
        ctx.globalAlpha = 0.95; ctx.strokeStyle = '#1e3a8a'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, 6.283); ctx.stroke();
        for (var s2 = 0; s2 < 24; s2 += 2) { var an = s2 * 0.2618; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(an) * rr, cy + Math.sin(an) * rr); ctx.stroke(); }
        ctx.globalAlpha = 1;
      }
      return {
        bg: function (ctx, t) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.16; ctx.drawImage(sprite(110, '255,153,51', true), -60, H / 2 - 110); ctx.drawImage(sprite(110, '19,136,8', true), W - 160, H / 2 - 110);
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
          if (free) flag(ctx, t);
        },
        fx: function (ctx) { pet.forEach(function (p, i) { p.v = Math.min(p.v, 0.35); if (!stepPetal(p, W, H)) pet[i] = newPetal(W, H, pal, false, [1.8, 2.8]); petal(ctx, p); }); }
      };
    },

    vishu: function (W, H, band, q, accent, gap) {
      // Warm golden morning light; a soft ray across the empty space; a few konna blossoms drifting.
      var free = gap && gap.b - gap.a > 140 ? gap : null;
      var pal = ['#facc15', '#fde047', '#eab308'], pet = []; for (var i = 0; i < q(7); i++) pet.push(newPetal(W, H, pal, true, [1.6, 2.6]));
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = lin(ctx, H, [[0, 'rgba(60,40,8,.35)'], [1, 'rgba(30,20,6,.08)']]); ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter';
          if (free) {
            ctx.save(); ctx.translate((free.a + free.b) / 2, -8); ctx.rotate(0.55 + Math.sin(t * 0.12) * 0.04);
            var gr = ctx.createLinearGradient(0, 0, 0, H * 1.6); gr.addColorStop(0, 'rgba(255,214,120,.14)'); gr.addColorStop(1, 'rgba(255,214,120,0)'); ctx.fillStyle = gr; ctx.fillRect(-18, 0, 36, H * 1.8); ctx.restore();
            ctx.globalAlpha = 0.14; ctx.drawImage(sprite(70, '255,200,90', true), (free.a + free.b) / 2 - 70, H / 2 - 70);
          }
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        },
        fx: function (ctx) { pet.forEach(function (p, i) { p.v = Math.min(p.v, 0.35); if (!stepPetal(p, W, H)) pet[i] = newPetal(W, H, pal, false, [1.6, 2.6]); petal(ctx, p); }); }
      };
    },

    onam: function (W, H, band, q, accent, gap) {
      // A small realistic pookalam turning very slowly in the empty space; a few petals.
      var free = gap && gap.b - gap.a > 120 && !isPhone() ? gap : null;
      var pal = ['#f97316', '#facc15', '#e11d48', '#fafaf9', '#c026d3'], pet = []; for (var i = 0; i < q(7); i++) pet.push(newPetal(W, H, pal, true, [1.6, 2.6]));
      var pr = Math.max(10, H * 0.32), pk = document.createElement('canvas'); pk.width = pk.height = Math.ceil(pr * 2 + 4);
      var pg = pk.getContext('2d'), RC = ['#fde047', '#f97316', '#be123c', '#f5f5f4', '#15803d', '#a21caf'];
      for (var ring = 0; ring < 6; ring++) { var rad = pr * (1 - ring * 0.16), n2 = Math.max(6, Math.round(rad * 1.1)); pg.fillStyle = RC[ring];
        for (var j = 0; j < n2; j++) { var an2 = j / n2 * 6.283 + ring * 0.2; pg.beginPath(); pg.ellipse(pr + 2 + Math.cos(an2) * rad * 0.86, pr + 2 + Math.sin(an2) * rad * 0.86, rad * 0.08 + 0.5, rad * 0.045 + 0.4, an2, 0, 6.283); pg.fill(); } }
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = lin(ctx, H, [[0, 'rgba(20,36,24,.35)'], [1, 'rgba(14,24,16,.08)']]); ctx.fillRect(0, 0, W, H);
          if (free) {
            var cx = (free.a + free.b) / 2, cy = H / 2;
            ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.12; ctx.drawImage(sprite(Math.round(pr * 2.2), '255,180,90', true), cx - pr * 2.2, cy - pr * 2.2); ctx.globalCompositeOperation = 'source-over';
            ctx.save(); ctx.globalAlpha = 0.8; ctx.translate(cx, cy); ctx.rotate(t * 0.04); ctx.drawImage(pk, -pk.width / 2, -pk.height / 2); ctx.restore(); ctx.globalAlpha = 1;
          }
        },
        fx: function (ctx) { pet.forEach(function (p, i) { p.v = Math.min(p.v, 0.35); if (!stepPetal(p, W, H)) pet[i] = newPetal(W, H, pal, false, [1.6, 2.6]); petal(ctx, p); }); }
      };
    },

    newyear: function (W, H, band, q, accent, gap) {
      // Deep night tint; small, soft fireworks only inside the empty space (never behind
      // controls); a little drifting gold glitter. The greeting sits in the same space.
      var free = gap && gap.b - gap.a > 160 && !isPhone() ? gap : null;
      var glitter = []; for (var k = 0; k < q(9); k++) glitter.push({ x: rnd(0, W), y: rnd(0, H), v: rnd(0.12, 0.3), s: rnd(0, 6.28) });
      var sparks = [], flashes = [], next = 0.6, COLS = ['255,214,120', '255,170,200', '190,210,255', '255,255,255'];
      function burst() {
        var x = rnd(free.a + 20, free.b - 20), y = rnd(H * 0.25, H * 0.55), c = pick(COLS), n = q(36);
        flashes.push({ x: x, y: y, t: 0, c: c });
        for (var i = 0; i < n; i++) { var an = rnd(0, 6.283), sp = rnd(0.5, 1.6); sparks.push({ x: x, y: y, px: x, py: y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, life: rnd(34, 52), age: 0, c: Math.random() < 0.15 ? '255,255,255' : c }); }
      }
      return {
        bg: function (ctx) { ctx.fillStyle = lin(ctx, H, [[0, 'rgba(26,16,60,.4)'], [1, 'rgba(14,10,34,.08)']]); ctx.fillRect(0, 0, W, H); },
        fx: function (ctx, t, dt) {
          if (free) { next -= dt; if (next <= 0 && sparks.length < 10) { burst(); next = rnd(2.6, 4.6); } }
          ctx.globalCompositeOperation = 'lighter';
          for (var fl = flashes.length - 1; fl >= 0; fl--) { var f = flashes[fl]; ctx.globalAlpha = Math.max(0, 0.35 - f.t * 0.04); ctx.drawImage(sprite(20, f.c, true), f.x - 20, f.y - 20); if (++f.t > 9) flashes.splice(fl, 1); }
          for (var j = sparks.length - 1; j >= 0; j--) { var p = sparks[j]; p.px = p.x; p.py = p.y; p.vx *= 0.97; p.vy = p.vy * 0.97 + 0.025; p.x += p.vx; p.y += p.vy; p.age++;
            var a = 1 - p.age / p.life; if (a <= 0) { sparks.splice(j, 1); continue; }
            ctx.globalAlpha = a * 0.85; ctx.strokeStyle = 'rgba(' + p.c + ',1)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke(); }
          ctx.fillStyle = '#fde68a';
          glitter.forEach(function (gl) { gl.y += gl.v; gl.s += 0.08; if (gl.y > H) { gl.y = -2; gl.x = rnd(0, W); } ctx.globalAlpha = 0.15 + 0.45 * Math.abs(Math.sin(gl.s)); ctx.fillRect(gl.x, gl.y, 1.1, 1.1); });
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
      };
    },

    monsoon: function (W, H, band, q, accent, gap) {
      // Cool overcast tint, light fine rain, and once in a while a soft distant flash.
      var rain = []; for (var i = 0; i < q(38); i++) { var z = Math.random(); rain.push({ z: z, x: rnd(-20, W + 40), y: rnd(-30, H), l: 6 + z * 9, v: 3.5 + z * 4 }); }
      var flash = 0, nextFlash = rnd(10, 18);
      return {
        bg: function (ctx, t, dt) {
          ctx.fillStyle = lin(ctx, H, [[0, 'rgba(20,40,64,.38)'], [1, 'rgba(10,22,38,.08)']]); ctx.fillRect(0, 0, W, H);
          nextFlash -= dt; if (nextFlash <= 0) { flash = 1; nextFlash = rnd(12, 22); }
          if (flash > 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = flash * 0.18; ctx.drawImage(sprite(140, '210,228,255', true), W * 0.62 - 140, -110); flash -= 0.07; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
        },
        fx: function (ctx) {
          ctx.strokeStyle = '#bae6fd';
          rain.forEach(function (p) { p.y += p.v; p.x -= p.v * 0.2; if (p.y > H) { p.y = rnd(-30, -6); p.x = rnd(-10, W + 40); }
            ctx.globalAlpha = 0.06 + p.z * 0.16; ctx.lineWidth = p.z > 0.7 ? 1 : 0.7; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.l * 0.2, p.y + p.l); ctx.stroke(); });
          ctx.globalAlpha = 1;
        }
      };
    },

    summer: function (W, H, band, q, accent, gap) {
      // Warm afternoon light from the top edge, a soft sun glare in the empty space, slow dust.
      var free = gap && gap.b - gap.a > 140 ? gap : null;
      var motes = bokeh(W, H, q(12), ['255,226,150', '255,200,120'], [1.2, 2.6]);
      return {
        bg: function (ctx, t) {
          ctx.fillStyle = lin(ctx, H, [[0, 'rgba(70,40,12,.32)'], [1, 'rgba(30,18,8,.06)']]); ctx.fillRect(0, 0, W, H);
          if (free) {
            var sx = free.b - (free.b - free.a) * 0.25, pulse = 1 + 0.04 * Math.sin(t * 0.8);
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.3; ctx.drawImage(sprite(Math.round(80 * pulse), '255,170,70', true), sx - 80 * pulse, -60 * pulse);
            ctx.globalAlpha = 0.6; ctx.drawImage(sprite(12, '255,236,180', false), sx - 12, -4);
            [[0.3, 6, 0.14], [0.55, 4, 0.16], [0.8, 8, 0.08]].forEach(function (f, i) { var fx = sx - (sx - free.a) * f[0], fy = H * 0.15 + H * 0.6 * f[0]; ctx.globalAlpha = f[2]; ctx.drawImage(sprite(f[1], i % 2 ? '180,220,255' : '255,210,140', true), fx - f[1], fy - f[1]); });
            ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
          }
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
      // faint gold line mandala (prerendered) turning very slowly behind the centre lamp
      var mr = Math.max(12, Math.round(H * 0.46)), md = document.createElement('canvas'); md.width = md.height = mr * 2 + 2;
      var mg = md.getContext('2d'); mg.translate(mr + 1, mr + 1); mg.strokeStyle = '#f6c66b'; mg.lineWidth = 0.6;
      [[1, 16], [0.72, 12], [0.46, 8]].forEach(function (rg) { var R = mr * rg[0];
        for (var i2 = 0; i2 < rg[1]; i2++) { mg.save(); mg.rotate(i2 / rg[1] * 6.283); mg.beginPath(); mg.moveTo(0, -R * 0.55); mg.quadraticCurveTo(R * 0.24, -R * 0.8, 0, -R); mg.quadraticCurveTo(-R * 0.24, -R * 0.8, 0, -R * 0.55); mg.stroke(); mg.restore(); }
        mg.beginPath(); mg.arc(0, 0, R * 0.55, 0, 6.283); mg.stroke(); });
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
          if (lamps.length) { var mL = lamps[Math.floor(lamps.length / 2)]; ctx.save(); ctx.globalAlpha = 0.09; ctx.translate(mL.x, mL.y); ctx.rotate(t * 0.025); ctx.drawImage(md, -md.width / 2, -md.height / 2); ctx.restore(); ctx.globalAlpha = 1; }
          lamps.forEach(function (L) { lamp(ctx, L, t); });
        },
        fx: function (ctx, t) {
          lamps.forEach(function (L, li) {   // thin smoke wisps rising from each flame
            ctx.globalAlpha = 0.08; ctx.strokeStyle = '#e7e5e4'; ctx.lineWidth = 1; ctx.beginPath();
            for (var k = 0; k < 10; k++) { var yy = L.y - 6 - k * 2.2, xx = L.x + Math.sin(t * 1.4 + k * 0.6 + li) * (k * 0.35); k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
            ctx.stroke();
          });
          ctx.globalCompositeOperation = 'lighter';
          embers.forEach(function (e) { e.y -= e.v; e.s += 0.02; e.x += Math.sin(e.s) * 0.15; if (e.y < -3) { e.y = H + 3; e.x = free ? rnd(free.a, free.b) : rnd(0, W); } ctx.globalAlpha = e.a * (0.7 + 0.3 * Math.sin(e.s * 2)); ctx.drawImage(sprite(2, '255,180,90', true), e.x - 2, e.y - 2); });
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
      };
    },

    custom: function (W, H, band, q, accent) {
      var orbs = bokeh(W, H, q(8), [accent || '255,138,61', '255,255,255'], [5, 10], 0.6);
      return { bg: function (ctx) { drawBokeh(ctx, orbs, W, H, true); }, fx: function () {} };
    }
  };
  function hexRgb(h) { var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || ''); return m ? parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) : null; }

  // ════════════════════════════════════════════════════════════════════════
  // Gap scenery — realistic, animated detail placed ONLY in the empty space between the
  // search box and the right-hand controls (never behind or on a control). Off on phones
  // and when that space is narrower than 170px.
  // ════════════════════════════════════════════════════════════════════════
  // A string of out-of-focus fairy lights hanging across the gap (soft bokeh, not bulbs).
  function lightString(g, H, cols, opts) {
    // Draped in loops (swags) across the gap, each bulb a soft out-of-focus glow with a hot
    // core; the whole string sways a little and bulbs breathe at their own pace.
    opts = opts || {};
    var w = g.b - g.a, loops = Math.max(2, Math.round(w / (opts.loop || 210))), sag = opts.sag || H * 0.42, y0 = opts.y0 || 2, per = opts.per || 7, pts = [];
    for (var L = 0; L < loops; L++) for (var i = 0; i < per; i++) { var t = (i + 0.5) / per; pts.push({ L: L, t: t, c: cols[(L * per + i) % cols.length], s: rnd(0, 6.28), r: rnd(opts.r0 || 2.4, opts.r1 || 3.8) }); }
    function at(L, t, sway) { var seg = w / loops; return { x: g.a + seg * (L + t), y: y0 + sag * 4 * t * (1 - t) * (0.85 + 0.15 * Math.sin(L * 1.7)) + sway * Math.sin(t * Math.PI) }; }
    return function (ctx, time) {
      var sway = Math.sin(time * 0.55) * 1.4;
      ctx.globalAlpha = 0.22; ctx.strokeStyle = '#64748b'; ctx.lineWidth = 0.7;
      for (var L = 0; L < loops; L++) { ctx.beginPath(); for (var k = 0; k <= 20; k++) { var p = at(L, k / 20, sway); k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); } ctx.stroke(); }
      ctx.globalCompositeOperation = 'lighter';
      pts.forEach(function (p) {
        var q = at(p.L, p.t, sway), tw = 0.7 + 0.3 * Math.sin(time * 1.2 + p.s);
        ctx.globalAlpha = 0.42 * tw; ctx.drawImage(sprite(Math.round(p.r * 3.2), p.c, true), q.x - p.r * 3.2, q.y + 2 - p.r * 3.2);
        ctx.globalAlpha = tw; ctx.drawImage(sprite(Math.max(1, Math.round(p.r * 0.75)), '255,250,235', false), q.x - p.r * 0.75, q.y + 2 - p.r * 0.75);
      });
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    };
  }
  // small shared helpers for gap scenery
  function offscreen(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function edgeFade(pc, w, h, e) {   // fade an offscreen layer out at its left / right ends
    e = e || 0.15; pc.globalCompositeOperation = 'destination-in'; pc.globalAlpha = 1;
    var f = pc.createLinearGradient(0, 0, w, 0); f.addColorStop(0, 'rgba(0,0,0,0)'); f.addColorStop(e, '#000'); f.addColorStop(1 - e, '#000'); f.addColorStop(1, 'rgba(0,0,0,0)');
    pc.fillStyle = f; pc.fillRect(0, 0, w, h); pc.globalCompositeOperation = 'source-over';
  }
  function edgeA(x, g, m) { m = m || 36; return Math.max(0, Math.min(1, (x - g.a) / m, (g.b - x) / m)); }
  function flame(ctx, x, y, fh, lean, wd) {   // teardrop flame: pale core → orange edge
    var gf = ctx.createRadialGradient(x, y - fh * 0.2, 0.4, x, y - fh * 0.45, fh * 0.75);
    gf.addColorStop(0, 'rgba(255,250,225,1)'); gf.addColorStop(0.35, 'rgba(255,214,110,.95)'); gf.addColorStop(0.75, 'rgba(249,115,22,.55)'); gf.addColorStop(1, 'rgba(249,115,22,0)');
    ctx.fillStyle = gf; ctx.beginPath(); ctx.moveTo(x - wd, y); ctx.quadraticCurveTo(x - wd * 0.85, y - fh * 0.6, x + lean, y - fh); ctx.quadraticCurveTo(x + wd * 0.85, y - fh * 0.6, x + wd, y); ctx.closePath(); ctx.fill();
  }
  function palm(pc, x, base, h, lean, col) {   // coconut palm silhouette: curved trunk + drooping fronds
    pc.strokeStyle = col; pc.lineCap = 'round';
    var tx = x + lean * h, ty = base - h;
    pc.lineWidth = Math.max(1.2, h * 0.05); pc.beginPath(); pc.moveTo(x, base); pc.quadraticCurveTo(x + lean * h * 0.15, base - h * 0.6, tx, ty); pc.stroke();
    for (var i = 0; i < 9; i++) {
      var an = -Math.PI - 0.45 + i / 8 * (Math.PI + 0.9) + rnd(-0.1, 0.1), L = h * rnd(0.42, 0.58), ex = tx + Math.cos(an) * L, ey = ty + Math.sin(an) * L * 0.45 + L * 0.4;
      pc.lineWidth = Math.max(0.7, h * 0.028); pc.beginPath(); pc.moveTo(tx, ty); pc.quadraticCurveTo(tx + Math.cos(an) * L * 0.55, ty + Math.sin(an) * L * 0.55 - L * 0.1, ex, ey); pc.stroke();
    }
  }

  var GAPS = {
    christmas: function (g, H) {
      // a thin crescent moon, now and then a shooting star, misty pines with one lit cabin
      // (chimney smoke) at the bottom, and a light string hanging across the top
      var w = Math.ceil(g.b - g.a), pine = offscreen(w, H), pc = pine.getContext('2d');
      [[0.45, '#1b2b4f', 0.55, 7, 13], [0.75, '#0d1730', 0.8, 10, 18]].forEach(function (L) {
        pc.globalAlpha = L[0]; pc.fillStyle = L[1]; pc.beginPath(); pc.moveTo(0, H);
        for (var x = -6; x < w + 10; x += rnd(L[3] * 0.6, L[3] * 1.2)) { var h = rnd(L[3], L[4]), b = H * (L[2] + 0.3); pc.lineTo(x - h * 0.28, b); pc.lineTo(x - h * 0.12, b - h * 0.5); pc.lineTo(x - h * 0.2, b - h * 0.5); pc.lineTo(x, b - h); pc.lineTo(x + h * 0.2, b - h * 0.5); pc.lineTo(x + h * 0.12, b - h * 0.5); pc.lineTo(x + h * 0.28, b); }
        pc.lineTo(w + 10, H); pc.closePath(); pc.fill();
      });
      var cab = { x: Math.round(w * 0.66), y: H - 1 };   // cabin: body, pitched roof, chimney
      pc.globalAlpha = 1; pc.fillStyle = '#0a1226';
      pc.fillRect(cab.x - 8, cab.y - 8, 16, 8);
      pc.beginPath(); pc.moveTo(cab.x - 10, cab.y - 7.5); pc.lineTo(cab.x, cab.y - 14); pc.lineTo(cab.x + 10, cab.y - 7.5); pc.closePath(); pc.fill();
      pc.fillRect(cab.x + 4, cab.y - 15, 2.4, 5);
      pc.fillStyle = 'rgba(226,236,255,.55)'; pc.fillRect(cab.x - 10, cab.y - 8.6, 20, 1.1);   // snow line on the roof edge
      edgeFade(pc, w, H, 0.15);
      var moon = offscreen(18, 18), mc = moon.getContext('2d');
      mc.fillStyle = '#eef3ff'; mc.beginPath(); mc.arc(9, 9, 6, 0, 6.283); mc.fill();
      mc.globalCompositeOperation = 'destination-out'; mc.beginPath(); mc.arc(12, 7, 5.6, 0, 6.283); mc.fill();
      var mx = g.a + w * 0.1, my = 13, star = null, nextStar = rnd(4, 8);
      var lights = lightString(g, H, ['255,196,120', '255,214,160', '255,120,100', '255,196,120', '150,190,255'], { loop: 230, per: 5, r0: 2.2, r1: 3.4 });
      return function (ctx, t, dt) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.16; ctx.drawImage(sprite(22, '200,215,255', true), mx - 22, my - 22);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.85; ctx.drawImage(moon, mx - 9, my - 9);
        nextStar -= dt || 0.033;
        if (nextStar <= 0 && !star) { star = { x: rnd(g.a + w * 0.2, g.a + w * 0.6), y: rnd(3, 9), age: 0 }; nextStar = rnd(9, 16); }
        if (star) {
          star.x += 4.2; star.y += 1.1; star.age++;
          var a = Math.sin(star.age / 16 * Math.PI) * edgeA(star.x, g);
          var sg = ctx.createLinearGradient(star.x - 26, star.y - 7, star.x, star.y); sg.addColorStop(0, 'rgba(230,240,255,0)'); sg.addColorStop(1, 'rgba(230,240,255,.9)');
          ctx.globalAlpha = Math.max(0, a); ctx.strokeStyle = sg; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(star.x - 26, star.y - 7); ctx.lineTo(star.x, star.y); ctx.stroke();
          if (star.age >= 16) star = null;
        }
        ctx.globalAlpha = 1; ctx.drawImage(pine, g.a, 0);
        var wx = g.a + cab.x, fl = 0.8 + 0.12 * Math.sin(t * 2.3) + 0.08 * Math.sin(t * 5.1);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.35 * fl; ctx.drawImage(sprite(9, '255,180,90', true), wx - 3 - 9, cab.y - 4.5 - 9);
        ctx.globalAlpha = 0.95 * fl; ctx.fillStyle = '#ffcf87'; ctx.fillRect(wx - 4.5, cab.y - 6, 3, 2.6);
        ctx.globalAlpha = 0.08; ctx.drawImage(sprite(40, '200,220,255', true), (g.a + g.b) / 2 - 40, H - 30);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.09; ctx.strokeStyle = '#dbe4f5'; ctx.lineWidth = 1.1; ctx.beginPath();   // chimney smoke
        for (var k = 0; k < 12; k++) { var yy = cab.y - 15 - k * 1.8, xx = wx + 5.2 + k * 0.9 + Math.sin(t * 0.9 + k * 0.5) * (k * 0.25); k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
        ctx.stroke(); ctx.globalAlpha = 1;
        lights(ctx, t);
      };
    },
    navaratri: function (g, H) {
      // a marigold toran (thread of marigold beads with mango leaves) draped across the top
      var w = g.b - g.a, loops = Math.max(1, Math.round(w / 300)), seg = w / loops, sag = H * 0.2, beads = [], leaves = [];
      for (var L = 0; L < loops; L++) {
        for (var x = 1.5; x < seg; x += 3.3) beads.push({ L: L, t: x / seg, c: pick(['#f59e0b', '#fb923c', '#fbbf24', '#ea580c', '#f97316']), r: rnd(1.5, 2.1) });
        for (var x2 = 13; x2 < seg - 6; x2 += 26) leaves.push({ L: L, t: x2 / seg, s: rnd(0, 6.28), len: rnd(7, 10) });
      }
      function at(L, t, sw) { return { x: g.a + seg * (L + t), y: 1 + sag * 4 * t * (1 - t) + sw * Math.sin(t * Math.PI) }; }
      return function (ctx, t) {
        var sw = Math.sin(t * 0.5) * 1.2;
        leaves.forEach(function (lf) {
          var p = at(lf.L, lf.t, sw), swing = Math.sin(t * 0.9 + lf.s) * 1.4, wd = 2.4;
          var lg = ctx.createLinearGradient(p.x - wd, 0, p.x + wd, 0); lg.addColorStop(0, '#1f3d10'); lg.addColorStop(0.5, '#4d7c0f'); lg.addColorStop(1, '#1f3d10');
          ctx.globalAlpha = 0.9; ctx.fillStyle = lg; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(p.x + wd + 0.6, p.y + lf.len * 0.5, p.x + swing, p.y + lf.len); ctx.quadraticCurveTo(p.x - wd - 0.6, p.y + lf.len * 0.5, p.x, p.y); ctx.fill();
          ctx.globalAlpha = 0.35; ctx.strokeStyle = '#a3c96a'; ctx.lineWidth = 0.4; ctx.beginPath(); ctx.moveTo(p.x, p.y + 1); ctx.lineTo(p.x + swing * 0.9, p.y + lf.len - 1); ctx.stroke();
        });
        beads.forEach(function (b) {
          var p = at(b.L, b.t, sw);
          ctx.globalAlpha = 0.95; ctx.fillStyle = b.c; ctx.beginPath(); ctx.arc(p.x, p.y, b.r, 0, 6.283); ctx.fill();
          ctx.globalAlpha = 0.4; ctx.fillStyle = '#7c2d12'; ctx.beginPath(); ctx.arc(p.x + b.r * 0.25, p.y + b.r * 0.3, b.r * 0.55, 0, 6.283); ctx.fill();
          ctx.globalAlpha = 0.5; ctx.fillStyle = '#fef3c7'; ctx.beginPath(); ctx.arc(p.x - b.r * 0.35, p.y - b.r * 0.35, b.r * 0.3, 0, 6.283); ctx.fill();
        });
        ctx.globalAlpha = 1;
      };
    },
    independence: function (g, H) {
      // two paper kites flying high on either side of the flag + faint silk ribbons of light
      var w = g.b - g.a;
      var kites = [{ f: 0.13, y: 0.3, s: rnd(0, 6.28), c: ['#fb923c', '#c2410c'], sz: 7.5 }, { f: 0.87, y: 0.24, s: rnd(0, 6.28), c: ['#22c55e', '#15803d'], sz: 6.5 }];
      return function (ctx, t) {
        ctx.globalCompositeOperation = 'lighter';
        [['255,153,51', 0, 0.12], ['248,250,252', 1.1, 0.07], ['19,160,8', 2.2, 0.11]].forEach(function (R, i) {
          ctx.beginPath();
          for (var k = 0; k <= 48; k++) { var tt = k / 48, x = g.a + w * tt, y = H * (0.36 + i * 0.12) + Math.sin(tt * 6 + t * 0.7 + R[1]) * H * 0.1; k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
          for (var k2 = 48; k2 >= 0; k2--) { var t2 = k2 / 48, x2 = g.a + w * t2, y2 = H * (0.36 + i * 0.12) + Math.sin(t2 * 6 + t * 0.7 + R[1]) * H * 0.1 + 2.4 + Math.sin(t2 * 3 + t) * 1.2; ctx.lineTo(x2, y2); }
          var gr = ctx.createLinearGradient(g.a, 0, g.b, 0); gr.addColorStop(0, 'rgba(' + R[0] + ',0)'); gr.addColorStop(0.5, 'rgba(' + R[0] + ',' + R[2] + ')'); gr.addColorStop(1, 'rgba(' + R[0] + ',0)');
          ctx.fillStyle = gr; ctx.fill();
        });
        ctx.globalCompositeOperation = 'source-over';
        kites.forEach(function (k) {
          var kx = g.a + w * k.f + Math.sin(t * 0.45 + k.s) * 4, ky = H * k.y + Math.sin(t * 0.9 + k.s) * 2.4, rot = Math.sin(t * 0.7 + k.s) * 0.16, sz = k.sz;
          ctx.globalAlpha = 0.28; ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 0.5;   // string down to the ground
          ctx.beginPath(); ctx.moveTo(kx, ky + sz * 0.4); ctx.quadraticCurveTo(kx - 8, H * 0.85, kx - 24, H + 2); ctx.stroke();
          ctx.save(); ctx.translate(kx, ky); ctx.rotate(rot + 0.08);
          var kg = ctx.createLinearGradient(-sz, -sz, sz, sz); kg.addColorStop(0, k.c[0]); kg.addColorStop(1, k.c[1]);
          ctx.globalAlpha = 0.88; ctx.fillStyle = kg; ctx.beginPath(); ctx.moveTo(0, -sz); ctx.lineTo(sz * 0.78, -sz * 0.05); ctx.lineTo(0, sz * 1.05); ctx.lineTo(-sz * 0.78, -sz * 0.05); ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 0.3; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, -sz); ctx.lineTo(sz * 0.78, -sz * 0.05); ctx.lineTo(0, -sz * 0.05); ctx.closePath(); ctx.fill();   // lit facet
          ctx.globalAlpha = 0.45; ctx.strokeStyle = '#3b2a14'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(0, -sz); ctx.lineTo(0, sz * 1.05); ctx.moveTo(-sz * 0.78, -sz * 0.05); ctx.quadraticCurveTo(0, -sz * 0.45, sz * 0.78, -sz * 0.05); ctx.stroke();
          ctx.globalAlpha = 0.6; ctx.strokeStyle = k.c[0]; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(0, sz * 1.05);   // tail
          for (var j = 1; j <= 6; j++) ctx.lineTo(Math.sin(t * 4 + j * 0.9 + k.s) * 1.6, sz * 1.05 + j * 1.7);
          ctx.stroke(); ctx.restore();
        });
        ctx.globalAlpha = 1;
      };
    },
    vishu: function (g, H) {
      // drooping konna (golden shower) clusters swaying from the top, and a small brass
      // nilavilakku with three calm flames at the right end of the gap
      var w = g.b - g.a, cl = [], n = Math.max(2, Math.min(4, Math.round((w - 60) / 120)));
      for (var i = 0; i < n; i++) { var fl = []; var len = rnd(H * 0.45, H * 0.75); for (var j = 0; j < 24; j++) { var f = j / 24; fl.push({ y: f * len, x: rnd(-1, 1) * (2 + f * 6), r: rnd(1.2, 2.2) * (1 - f * 0.4), c: pick(['#facc15', '#fde047', '#eab308', '#fbbf24']) }); } cl.push({ x: g.a + (w - 60) * (i + 0.5) / n + rnd(-12, 12), s: rnd(0, 6.28), fl: fl }); }
      var lx = g.b - 26, base = H - 3, lh = Math.min(H * 0.72, 40);
      function brass(x0, x1) { var gb = ctx0.createLinearGradient(x0, 0, x1, 0); gb.addColorStop(0, '#4a2a0c'); gb.addColorStop(0.45, '#c08a2c'); gb.addColorStop(0.6, '#f1cf7a'); gb.addColorStop(1, '#3d220a'); return gb; }
      var ctx0 = null;
      return function (ctx, t) {
        ctx0 = ctx;
        cl.forEach(function (c) {
          var sw = Math.sin(t * 0.8 + c.s) * 0.06;
          ctx.save(); ctx.translate(c.x, -2); ctx.rotate(sw);
          ctx.globalAlpha = 0.5; ctx.strokeStyle = '#3f6212'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, c.fl[c.fl.length - 1].y); ctx.stroke();
          c.fl.forEach(function (f) { ctx.globalAlpha = 0.88; ctx.fillStyle = f.c; ctx.beginPath(); ctx.ellipse(f.x, f.y, f.r, f.r * 0.8, 0, 0, 6.283); ctx.fill(); });
          ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.16; ctx.drawImage(sprite(14, '255,214,90', true), -14, c.fl[10].y - 14); ctx.globalCompositeOperation = 'source-over';
          ctx.restore();
        });
        // nilavilakku: foot, stem with two knobs, wide top bowl, three wicks
        var f = 0.93 + 0.04 * Math.sin(t * 3.1) + 0.03 * Math.sin(t * 7.7), top = base - lh * 0.8;
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.3 * f; ctx.drawImage(sprite(26, '255,170,70', true), lx - 26, top - 32); ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1; ctx.fillStyle = brass(lx - lh * 0.2, lx + lh * 0.2);
        ctx.beginPath(); ctx.moveTo(lx - lh * 0.2, base); ctx.lineTo(lx + lh * 0.2, base); ctx.lineTo(lx + lh * 0.06, base - lh * 0.1); ctx.lineTo(lx - lh * 0.06, base - lh * 0.1); ctx.closePath(); ctx.fill();
        ctx.fillStyle = brass(lx - 2, lx + 2); ctx.fillRect(lx - lh * 0.025, top, lh * 0.05, lh * 0.72);
        [0.35, 0.58].forEach(function (k) { ctx.fillStyle = brass(lx - lh * 0.06, lx + lh * 0.06); ctx.beginPath(); ctx.ellipse(lx, base - lh * k, lh * 0.06, lh * 0.035, 0, 0, 6.283); ctx.fill(); });
        ctx.fillStyle = brass(lx - lh * 0.17, lx + lh * 0.17); ctx.beginPath(); ctx.ellipse(lx, top, lh * 0.17, lh * 0.06, 0, 0, Math.PI); ctx.fill();
        ctx.strokeStyle = 'rgba(246,211,140,.85)'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.ellipse(lx, top, lh * 0.17, lh * 0.025, 0, 0, 6.283); ctx.stroke();
        [-0.11, 0, 0.11].forEach(function (o, i) { flame(ctx, lx + o * lh, top - 0.5, lh * (i === 1 ? 0.2 : 0.16) * f, Math.sin(t * 1.3 + i) * 0.5, 1.6); });
        ctx.globalAlpha = 1;
      };
    },
    onam: function (g, H) {
      // backwater at the bottom: two coconut palms at the ends, a chundan vallam (snake boat)
      // rowing slowly across with its reflection, and a calm shimmer on the water
      var w = g.b - g.a, pl = offscreen(w, H), pc = pl.getContext('2d'), dusk = offscreen(w, H), dc = dusk.getContext('2d');
      var dg = dc.createLinearGradient(0, 0, 0, H); dg.addColorStop(0, 'rgba(120,90,140,.05)'); dg.addColorStop(0.55, 'rgba(255,150,90,.14)'); dg.addColorStop(0.82, 'rgba(255,190,120,.24)'); dg.addColorStop(1, 'rgba(120,180,200,.1)');
      dc.fillStyle = dg; dc.fillRect(0, 0, w, H); edgeFade(dc, w, H, 0.2);
      pc.globalAlpha = 0.95; palm(pc, 10, H + 2, H * 0.78, 0.16, '#050c07'); palm(pc, w - 12, H + 2, H * 0.66, -0.18, '#050c07');
      pc.globalAlpha = 0.5; palm(pc, w - 34, H + 2, H * 0.48, -0.08, '#12261a');
      var boat = { x: g.a + rnd(w * 0.05, w * 0.35), v: 8 };
      return function (ctx, t, dt) {
        ctx.drawImage(dusk, g.a, 0);
        ctx.globalCompositeOperation = 'lighter'; ctx.lineWidth = 1;
        for (var r = 0; r < 4; r++) { ctx.strokeStyle = 'rgba(190,240,255,' + (0.06 + r * 0.02) + ')'; ctx.beginPath(); for (var x = 0; x <= w; x += 8) { var y = H - 10 + r * 2.5 + Math.sin(x * 0.04 + t * (0.8 + r * 0.25) + r) * 1.1; x ? ctx.lineTo(g.a + x, y) : ctx.moveTo(g.a + x, y); } ctx.stroke(); }
        ctx.globalCompositeOperation = 'source-over';
        boat.x += boat.v * (dt || 0.033); if (boat.x > g.b + 10) boat.x = g.a - 90;
        var bx = boat.x, by = H - 8 + Math.sin(t * 1.2) * 0.4, L = 70, a = Math.min(edgeA(bx, g, 40), edgeA(bx + L, g, 40)) * 0.9;
        if (a > 0) {
          ctx.save(); ctx.beginPath(); ctx.rect(g.a, 0, w, H); ctx.clip();
          ctx.globalAlpha = a; ctx.fillStyle = '#0d160f';
          ctx.beginPath(); ctx.moveTo(bx - 1, by - 14);   // tall curved stern (left) sweeping into a long low hull
          ctx.quadraticCurveTo(bx + 3, by - 2, bx + 14, by - 1.4); ctx.lineTo(bx + L, by - 1.8); ctx.quadraticCurveTo(bx + L + 3, by - 1.6, bx + L + 1, by + 0.6); ctx.lineTo(bx + 12, by + 1); ctx.quadraticCurveTo(bx + 1, by, bx - 2, by - 14); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#0d160f'; ctx.lineWidth = 0.7; var row = Math.sin(t * 4.2);
          for (var i = 0; i < 13; i++) { var px = bx + 17 + i * 4; ctx.fillRect(px - 0.5, by - 4.4, 1.1, 3); ctx.beginPath(); ctx.moveTo(px, by - 2.2); ctx.lineTo(px - 1.5 + row * 2.2, by + 2.6); ctx.stroke(); }
          ctx.globalAlpha = a * 0.22; ctx.fillRect(bx + 8, by + 2, L - 8, 1.1);   // reflection
          ctx.restore();
        }
        ctx.globalAlpha = 1; ctx.drawImage(pl, g.a, 0);
      };
    },
    newyear: function (g, H) {
      // a far city skyline along the bottom (lit windows, one blinking tower light) under a
      // short string of warm lights; fireworks come from the scene
      var w = Math.ceil(g.b - g.a), sk = offscreen(w, H), sc = sk.getContext('2d'), wins = [], tower = null;
      var cg = sc.createLinearGradient(0, H * 0.45, 0, H); cg.addColorStop(0, 'rgba(150,110,255,0)'); cg.addColorStop(0.7, 'rgba(170,120,255,.14)'); cg.addColorStop(1, 'rgba(255,190,120,.2)');
      sc.fillStyle = cg; sc.fillRect(0, 0, w, H);   // city glow on the low haze
      sc.fillStyle = '#0b0920';
      for (var x = 0; x < w; ) { var bw = rnd(6, 15), bh = rnd(4, 12); if (!tower && x > w * 0.55) { bh = 15; tower = { x: x + bw / 2, y: H - bh - 4 }; sc.fillRect(x + bw / 2 - 0.4, H - bh - 4, 0.8, 4); }
        sc.fillRect(x, H - bh, bw, bh);
        for (var wy = H - bh + 2; wy < H - 1; wy += 2.6) for (var wx = x + 1.5; wx < x + bw - 1.5; wx += 2.6) if (Math.random() < 0.18) wins.push({ x: g.a + wx, y: wy, s: rnd(0, 6.28), on: Math.random() < 0.85 });
        x += bw + rnd(0, 2); }
      edgeFade(sc, w, H, 0.12);
      var str = lightString(g, H, ['255,214,120', '255,236,180', '230,190,255'], { loop: 200, per: 6, sag: H * 0.26, r0: 1.5, r1: 2.4 });
      return function (ctx, t) {
        ctx.globalAlpha = 0.9; ctx.drawImage(sk, g.a, 0);
        ctx.fillStyle = '#ffd68a';
        wins.forEach(function (wn) { if (!wn.on) return; ctx.globalAlpha = 0.45 * (0.75 + 0.25 * Math.sin(t * 0.6 + wn.s)) * edgeA(wn.x, g, 40); ctx.fillRect(wn.x, wn.y, 1, 1); });
        if (tower) { var on = Math.sin(t * 2.4) > 0.6; ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = on ? 0.9 : 0.15; ctx.drawImage(sprite(3, '255,80,80', true), g.a + tower.x - 3, tower.y - 3); ctx.globalCompositeOperation = 'source-over'; }
        ctx.globalAlpha = 1; str(ctx, t);
      };
    },
    monsoon: function (g, H) {
      // low rain clouds drifting along the top, water beads on glass (some sliding), rings
      // where drops land along the bottom, and a faint distant lightning fork now and then
      var w = g.b - g.a, beads = [], rings = [], nextRing = 0.3, nextBolt = rnd(5, 9), bolt = null, clouds = [];
      for (var i = 0; i < Math.round(w / 30); i++) beads.push({ x: g.a + rnd(0, w), y: rnd(2, H - 4), r: rnd(1.8, 4), v: Math.random() < 0.3 ? rnd(0.12, 0.35) : 0, tr: [] });
      for (var c = 0; c < Math.max(3, Math.round(w / 90)); c++) { var pf = []; for (var k = 0; k < 4; k++) pf.push({ dx: rnd(-22, 22), dy: rnd(-5, 4), r: Math.round(rnd(13, 22)) }); clouds.push({ x: g.a + rnd(0, w), pf: pf }); }
      return function (ctx, t, dt) {
        dt = dt || 0.033;
        clouds.forEach(function (cd) { cd.x += 3 * dt; if (cd.x > g.b + 30) cd.x = g.a - 30; var a = edgeA(cd.x, g, 50);
          cd.pf.forEach(function (p) { ctx.globalAlpha = 0.13 * a; ctx.drawImage(sprite(p.r, '150,170,200', true), cd.x + p.dx - p.r, p.dy - p.r); }); });
        nextBolt -= dt;
        if (nextBolt <= 0) { var x = rnd(g.a + w * 0.2, g.b - w * 0.2), y = -2, pts = [[x, y]]; while (y < H * 0.7) { x += rnd(-6, 6); y += rnd(4, 7); pts.push([x, y]); } bolt = { pts: pts, age: 0 }; nextBolt = rnd(12, 20); }
        if (bolt && bolt.age < 5) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.4 * (1 - bolt.age / 5); ctx.strokeStyle = '#dbeafe'; ctx.lineWidth = 1; ctx.beginPath(); bolt.pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.stroke(); ctx.globalCompositeOperation = 'source-over'; bolt.age++; }
        nextRing -= dt; if (nextRing <= 0) { rings.push({ x: g.a + rnd(10, w - 10), y: H - rnd(3, 7), age: 0 }); nextRing = rnd(0.25, 0.6); }
        ctx.strokeStyle = '#cfe8ff'; ctx.lineWidth = 0.6;
        for (var ri = rings.length - 1; ri >= 0; ri--) { var rg = rings[ri]; rg.age += dt; if (rg.age > 1.1) { rings.splice(ri, 1); continue; } var rr = 1 + rg.age * 7;
          ctx.globalAlpha = 0.3 * (1 - rg.age / 1.1); ctx.beginPath(); ctx.ellipse(rg.x, rg.y, rr, rr * 0.28, 0, 0, 6.283); ctx.stroke(); }
        beads.forEach(function (b) {
          if (b.v) { b.tr.push([b.x, b.y]); if (b.tr.length > 14) b.tr.shift(); b.y += b.v; b.x += Math.sin(t + b.r) * 0.05; if (b.y > H + 3) { b.y = -3; b.x = g.a + rnd(0, w); b.tr = []; } }
          if (b.tr.length > 2) { ctx.globalAlpha = 0.14; ctx.strokeStyle = '#cfe8ff'; ctx.lineWidth = b.r * 0.6; ctx.beginPath(); b.tr.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.stroke(); }
          ctx.globalAlpha = 0.45; ctx.fillStyle = 'rgba(6,14,26,.9)'; ctx.beginPath(); ctx.arc(b.x, b.y + 0.5, b.r, 0, 6.283); ctx.fill();
          ctx.globalAlpha = 0.55; ctx.fillStyle = 'rgba(186,220,255,.6)'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.92, 0, 6.283); ctx.fill();
          ctx.globalAlpha = 0.35; ctx.strokeStyle = 'rgba(15,23,42,.9)'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0.2, 2.9); ctx.stroke();
          ctx.globalAlpha = 0.95; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, Math.max(0.4, b.r * 0.22), 0, 6.283); ctx.fill();
          ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.arc(b.x + b.r * 0.3, b.y + b.r * 0.45, Math.max(0.3, b.r * 0.12), 0, 6.283); ctx.fill();
        });
        ctx.globalAlpha = 1;
      };
    },
    summer: function (g, H) {
      // slow sun rays, two distant birds gliding across, heat-haze shimmer and sun glints
      var w = g.b - g.a, glints = []; for (var i = 0; i < Math.round(w / 60); i++) glints.push({ x: g.a + rnd(0, w), y: rnd(H * 0.3, H - 4), s: rnd(0, 6.28) });
      var sx = g.b - w * 0.25, birds = [{ x: g.a + w * 0.15, y: H * 0.38, v: 14, s: rnd(0, 6.28), sz: 4.2 }, { x: g.a + w * 0.3, y: H * 0.5, v: 11, s: rnd(0, 6.28), sz: 3.2 }];
      return function (ctx, t, dt) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.save(); ctx.translate(sx, 0); ctx.rotate(t * 0.03);
        for (var ry = 0; ry < 8; ry++) { ctx.rotate(0.785); var gr = ctx.createLinearGradient(0, 0, 0, H * 1.4); gr.addColorStop(0, 'rgba(255,214,140,.09)'); gr.addColorStop(1, 'rgba(255,214,140,0)'); ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-4, H * 1.4); ctx.lineTo(4, H * 1.4); ctx.closePath(); ctx.fill(); }
        ctx.restore();
        for (var r = 0; r < 3; r++) { ctx.strokeStyle = 'rgba(255,214,150,' + (0.05 + r * 0.02) + ')'; ctx.lineWidth = 1; ctx.beginPath(); for (var x = 0; x <= w; x += 10) { var y = H - 8 - r * 4 + Math.sin(x * 0.05 - t * 1.6 + r) * 1.4; x ? ctx.lineTo(g.a + x, y) : ctx.moveTo(g.a + x, y); } ctx.stroke(); }
        glints.forEach(function (gl) { var a = Math.max(0, Math.sin(t * 1.2 + gl.s)); if (a < 0.2) return; ctx.globalAlpha = 0.5 * a; ctx.drawImage(sprite(3, '255,236,190', true), gl.x - 3, gl.y - 3); });
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = '#e9d7b8'; ctx.lineWidth = 1; ctx.lineCap = 'round';
        birds.forEach(function (b) {   // glide, with a few wing beats every now and then
          b.x += b.v * (dt || 0.033); if (b.x > g.b + 8) { b.x = g.a - 8; b.y = H * rnd(0.3, 0.55); }
          var beat = Math.sin(t * 0.5 + b.s) > 0.4 ? Math.sin(t * 9 + b.s) : 0.25, y = b.y + Math.sin(t * 0.8 + b.s) * 1.5, s = b.sz;
          ctx.globalAlpha = 0.42 * edgeA(b.x, g, 30); ctx.beginPath();
          ctx.moveTo(b.x - s, y - beat * s * 0.5); ctx.quadraticCurveTo(b.x - s * 0.45, y - s * 0.45, b.x, y); ctx.quadraticCurveTo(b.x + s * 0.45, y - s * 0.45, b.x + s, y - beat * s * 0.5); ctx.stroke();
        });
        ctx.globalAlpha = 1;
      };
    }
  };

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
    var gapDraw = null, ctx = cv.getContext('2d'), W = 0, H = 0, scene = null, raf = 0, last = 0, visible = true, io = null, t0 = performance.now(), prev = t0;
    var factor = phone ? 0.4 : weak ? 0.6 : 1, intens = c.intensity === 'normal' ? 1.3 : 1;
    var q = function (n) { return Math.max(1, Math.round(n * factor * intens)); };
    function build() {
      var r = bg.getBoundingClientRect(), dpr = Math.min(phone ? 1.25 : 1.5, window.devicePixelRatio || 1);
      if (!r.width) return; W = r.width; H = r.height; band = H;
      cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr)); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var mk = SCENES[c.preset] || SCENES.custom;
      scene = mk(W, H, band, q, hexRgb(c.colors.accent), gap);
      gapDraw = c.overlay && GAPS[c.preset] && !phone && gap.b - gap.a >= 170 ? GAPS[c.preset]({ a: gap.a, b: gap.b }, H) : null;
      frame(performance.now(), true);
    }
    function frame(now, force) {
      if (!scene) return;
      var t = (now - t0) / 1000, dt = Math.min(0.1, (now - prev) / 1000); prev = now;
      ctx.clearRect(0, 0, W, H);
      if (!c.banner && c.overlay) scene.bg(ctx, t, dt);
      if (gapDraw) gapDraw(ctx, t, dt);
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
      '.bsa-missing{border-style:dashed;opacity:.92}@media(min-width:861px){.bsa-missing .bsa-row{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) 133px 124px}}.bsa-missing .bsa-acts{justify-content:flex-end}',
      '.bsa-card{border-radius:16px;background:#0e1222;border:1px solid rgba(255,255,255,.07);overflow:hidden}.bsa-card .bsa-row{border:0;border-radius:0;background:none}',
      '.bsa-live{padding:14px 16px 2px;background:#070a14;border-top:1px solid rgba(255,255,255,.05)}.bsa-live .bes-header{margin:0!important}.bsa-live .bes-search{flex:0 1 300px;max-width:300px}.bsa-live .bes-right{margin-left:auto}',
      '@media(max-width:860px){.bsa-live .bes-search{max-width:140px}}',
      '.bsa-row{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;gap:14px;align-items:center;padding:12px 14px;border-radius:14px;background:#0e1222;border:1px solid rgba(255,255,255,.07)}',
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
      '@media(max-width:860px){.bsa-row{grid-template-columns:minmax(0,1fr);}.bsa-row>.bsa-when,.bsa-row>.bsa-seg,.bsa-row>.bsa-acts{grid-column:1/-1}.bsa-grid{grid-template-columns:1fr}}'
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
    (el._bsaKill || []).forEach(function (k) { try { k(); } catch (_) {} }); el._bsaKill = [];
    el.classList.add('bsa');
    el.innerHTML = '<div class="bsa-note">Loading themes…</div>';
    var rows = await loadThemes(true);
    var divs = [];
    try { var dr = await db().from('hr_divisions').select('code,name,active').order('sort_order'); divs = (dr.data || []).filter(function (d) { return d.active !== false; }); } catch (_) {}
    var d0 = today();
    rows.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name); });
    var cur = schedule(rows, null, d0);
    var missing = Object.keys(PRESETS).filter(function (k) { return k !== 'custom' && !rows.some(function (r) { return r.preset === k; }); });
    el.innerHTML = '<div class="bsa-top"><div style="flex:1;min-width:220px"><h2>Header Themes</h2><p>Seasonal and special-day decorations for the ERP top header. Today: ' + (cur ? '<b style="color:#fff">' + esc(cur.name) + '</b> is live for all departments it applies to.' : 'no theme is active — the normal header shows.') + '</p></div><div style="display:flex;gap:8px"><button type="button" class="bsa-btn" data-pvstop>Stop page preview</button><button type="button" class="bsa-btn pri" data-new>+ Add theme</button></div></div>'
      + ''
      + '<div class="bsa-list">' + (rows.length ? rows.map(function (t) {
          var st = statusOf(t, d0), L = ST_LABEL[st] || [st, ''], p = PRESETS[t.preset] || PRESETS.custom;
          var art = t.config && t.config.banner && t.config.banner !== 'none' ? t.config.banner : (t.config && t.config.banner === 'none' ? null : p.art);
          return '<div class="bsa-card" data-id="' + t.id + '"><div class="bsa-row">'
            + '<div><b>' + esc(t.name) + '</b><small>' + esc((KINDS.filter(function (k) { return k[0] === t.kind; })[0] || ['', p.kind || ''])[1]) + ' · priority ' + (t.priority || 0) + ' · ' + (t.portals && t.portals.length ? esc(t.portals.map(function (x) { return (PORTALS.filter(function (o) { return o[0] === x; })[0] || [0, x])[1]; }).join(', ')) + ' · ' : '') + (t.departments && t.departments.length ? esc(t.departments.map(function (c) { var d = divs.filter(function (x) { return x.code === c; })[0]; return d ? d.name : c; }).join(', ')) : 'All departments') + '</small></div>'
            + '<div class="bsa-when"><span class="bsa-pill ' + L[1] + '">' + esc(L[0]) + '</span><small style="color:#8b93b8;font-size:11.5px;margin-top:4px;display:block">' + esc(rangeText(t)) + '</small></div>'
            + '<div class="bsa-seg" role="group" aria-label="Activation">' + [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']].map(function (m) { return '<button type="button" data-ms="' + m[0] + '" class="' + (t.manual_state === m[0] ? 'on' : '') + '">' + m[1] + '</button>'; }).join('') + '</div>'
            + '<div class="bsa-acts"><button type="button" class="bsa-btn sm" data-pvid="' + t.id + '">Preview</button><button type="button" class="bsa-btn sm" data-edit="' + t.id + '">Edit</button></div></div>'
            + '<div class="bsa-live" data-live="' + t.id + '" aria-hidden="true">' + mockHeader() + '</div></div>';
        }).join('') : '<div class="bsa-note">No themes yet. Run 20261101_header_themes.sql to add the built-in presets.</div>')
      + missing.map(function (k) {
          var pp = PRESETS[k];
          return '<div class="bsa-card bsa-missing" data-pid="' + k + '"><div class="bsa-row"><div><b>' + esc(pp.label) + '</b><small>' + esc((KINDS.filter(function (x) { return x[0] === pp.kind; })[0] || ['', ''])[1]) + ' · built-in · not added yet</small></div>'
            + '<div class="bsa-when"><span class="bsa-pill warn">Not added</span><small style="color:#8b93b8;font-size:11.5px;margin-top:4px;display:block">' + esc(DEF_DATES[k] ? DEF_DATES[k][2] : 'Dates set by HR') + '</small></div><span></span>'
            + '<div class="bsa-acts"><button type="button" class="bsa-btn sm" data-pvp="' + k + '">Preview</button><button type="button" class="bsa-btn sm pri" data-addp="' + k + '">Add</button></div></div>'
            + '<div class="bsa-live" data-live="p_' + k + '" aria-hidden="true">' + mockHeader() + '</div></div>';
        }).join('') + '</div>'
      + '<p class="bsa-note">Only the top header changes (search, clock, date, bell, profile). Effects pause off-screen, shrink on phones, stay still for reduced-motion users, and anyone can switch them off from their account menu.</p>';
    el.onclick = async function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-new')) return editor(null, divs, function () { mountAdmin(el, opts); });
      if (b.hasAttribute('data-edit')) return editor(rows.filter(function (t) { return t.id === b.getAttribute('data-edit'); })[0], divs, function () { mountAdmin(el, opts); });
      if (b.hasAttribute('data-pvid')) return preview(b.getAttribute('data-pvid'));
      if (b.hasAttribute('data-pvstop')) return stopPreview();
      if (b.hasAttribute('data-pvp')) return preview(b.getAttribute('data-pvp'));
      if (b.hasAttribute('data-addp')) {
        var k = b.getAttribute('data-addp'), dd = DEF_DATES[k];
        b.disabled = true; b.textContent = 'Adding…';
        var ins = await db().from('erp_header_themes').insert({ preset: k, kind: PRESETS[k].kind, name: PRESETS[k].label, start_date: dd ? dd[0] : null, end_date: dd ? dd[1] : null, repeat_yearly: true, auto_active: !!dd, priority: k === 'newyear' ? 95 : PRESETS[k].kind === 'seasonal' ? 10 : 90, updated_by: who() });
        if (ins.error) { b.disabled = false; b.textContent = 'Add'; toast('error', /check constraint|kind|portals/i.test(ins.error.message) ? 'Run the database update 20261102_header_themes_v2.sql first, then add ' + PRESETS[k].label + '.' : ins.error.message); return; }
        ss(K_CACHE, null); S.themes = null; toast('success', PRESETS[k].label + ' added'); return mountAdmin(el, opts);
      }
      if (b.hasAttribute('data-pvgo')) { var v = el.querySelector('[data-pv]').value; return preview(v.slice(0, 2) === 'p:' ? v.slice(2) : v.slice(2)); }
      if (b.hasAttribute('data-ms')) {
        var id = b.closest('[data-id]').getAttribute('data-id'), ms = b.getAttribute('data-ms');
        b.parentNode.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
        var r = await db().from('erp_header_themes').update({ manual_state: ms, updated_at: new Date().toISOString(), updated_by: who() }).eq('id', id);
        if (r.error) toast('error', 'Could not update: ' + r.error.message); else { ss(K_CACHE, null); S.themes = null; mountAdmin(el, opts); decorate(); }
      }
    };
    // live animated preview of every theme, exactly as the header will look
    (el._bsaKill || []).forEach(function (k) { try { k(); } catch (_) {} });
    el._bsaKill = rows.map(function (t) { var h = el.querySelector('[data-live="' + t.id + '"] .bes-header'); return h ? render(h, t, {}) : null; })
      .concat(missing.map(function (k) { var h = el.querySelector('[data-live="p_' + k + '"] .bes-header'); return h ? render(h, { id: 'p_' + k, preset: k, name: PRESETS[k].label, config: {} }, {}) : null; })).filter(Boolean);
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
