/* ============================================================================
   BEMobile — app-style bottom navigation for phones/small tablets, shared by
   index.html, hr.html, academics.html and sales.html (loaded like the other
   shared scripts). It does NOT change any page's logic or desktop layout: on
   viewports <= 820px it builds a fixed bottom tab bar from each page's OWN
   existing sidebar links and forwards a tap to the real link (so switchTab /
   acadSwitchTab / every existing nav handler fires unchanged), plus a "Menu"
   tab that opens a bottom sheet listing every nav item. Above 820px it renders
   nothing and touches nothing — desktop is exactly as before.
   ============================================================================ */
(function () {
  if (window.__beMobileInit) return;
  window.__beMobileInit = true;
  var BP = 820;

  var CSS = [
    ':root{--bem-bg:var(--sf-1, #0a0e17);--bem-border:rgba(var(--ink, 255,255,255), 0.09);--bem-text:var(--tx-2, #c7cbe0);--bem-muted:var(--tx-6, #6b7488);--bem-accent:#ff3b6b;}',
    '.be-mnav,.be-msheet-bg{display:none;}',
    '@media (max-width:' + BP + 'px){',
    /* bottom clearance now lives on each page's own scroll container (below), not on <body> too */
    'body{padding-bottom:env(safe-area-inset-bottom,0px)!important;}',
    /* FLOATING PILL bottom nav (OLINEX-style): detached from the screen edges, rounded,
       elevated, dark glass. Active item gets an accent pill instead of a flat underline. */
    '.be-mnav{display:flex;position:fixed;left:12px;right:12px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:150;',
    'background:rgba(var(--sf-2-rgb, 14,18,28), 0.92);backdrop-filter:blur(14px);border:1px solid rgba(var(--ink, 255,255,255), 0.08);',
    'border-radius:22px;padding:6px;gap:2px;box-shadow:0 12px 30px rgba(var(--shade, 0,0,0), calc(0.55 * var(--shade-k, 1)));}',
    '.be-mnav-item{flex:1;min-width:0;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;',
    'height:52px;background:none;border:none;border-radius:16px;color:var(--bem-muted);font-size:9.5px;font-weight:600;cursor:pointer;padding:0 2px;-webkit-tap-highlight-color:transparent;transition:color .15s,background .15s;}',
    '.be-mnav-item svg{width:20px;height:20px;}',
    '.be-mnav-item[data-active]{color:#fff;background:linear-gradient(135deg,var(--bem-accent),#ff6b06);box-shadow:0 6px 16px rgba(255,59,107,.35);}',
    '.be-mnav-item span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.be-msheet-bg{display:none;position:fixed;inset:0;z-index:180;background:rgba(var(--scrim, 0,0,0), calc(0.6 * var(--scrim-k, 1)));backdrop-filter:blur(3px);}',
    '.be-msheet-bg[data-open]{display:block;}',
    '.be-msheet{position:fixed;left:0;right:0;bottom:0;z-index:181;background:var(--bem-bg);border-top:1px solid var(--bem-border);',
    'border-radius:16px 16px 0 0;max-height:76vh;overflow-y:auto;padding:8px 10px calc(16px + env(safe-area-inset-bottom,0px));transform:translateY(100%);transition:transform .2s;}',
    '.be-msheet-bg[data-open] .be-msheet{transform:translateY(0);}',
    '.be-msheet-grab{width:40px;height:4px;border-radius:99px;background:rgba(var(--ink, 255,255,255), 0.2);margin:8px auto 12px;}',
    '.be-msheet-item{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:none;border:none;',
    'color:var(--bem-text);font-size:15px;font-weight:600;padding:14px 12px;border-radius:11px;cursor:pointer;}',
    '.be-msheet-item:hover,.be-msheet-item[data-active]{background:rgba(var(--ink, 255,255,255), 0.05);}',
    '.be-msheet-item[data-active]{color:color-mix(in srgb, var(--bem-accent) var(--acc-k, 100%), var(--acc-mix, #000));}',
    '.be-msheet-item svg{width:20px;height:20px;flex:0 0 20px;}',
    /* comfortable tap targets for the page's own interactive bits on mobile */
    '.act-btn,.btn-ghost,.btn-sm{min-height:34px;}',
    /* ---- SHARED RESPONSIVE LAYER (every page that loads this file: index, hr, academics,
       sales, manager). Root-cause rules, not overflow-x:hidden: everything is sized to fit. ---- */
    '*,*::before,*::after{box-sizing:border-box;}',
    'img,video,iframe,canvas{max-width:100%;}',
    /* The page scroller must clear the floating bottom bar (64px bar + 10px gap + safe area) and the
       Jarvis globe parked above it, so the last row's buttons can always scroll into the clear — the
       scrolling element differs per page (academics .acad-main, hr/index <main>, sales/manager .main). */
    'body .acad-main,body main,body .main{padding-bottom:calc(140px + env(safe-area-inset-bottom,0px))!important;}',
    /* flex/grid children may shrink below their content width instead of pushing the row wider */
    '.section,.card,.glass-card,.dsh-main,.dsh-list,.acad-tab,.tab{min-width:0;max-width:100%;}',
    /* long names (batches, trainers, students) wrap instead of widening the page */
    'h1,h2,h3,.dsh-title,.bes-sub,.section h2{overflow-wrap:anywhere;}',
    /* every dialog fits the phone and scrolls inside itself */
    '.modal,.hr-modal,.hfm,.prm,.otr,.jv-sheet,.mw-modal{max-width:calc(100vw - 24px)!important;max-height:calc(100dvh - 24px)!important;overflow-y:auto!important;}',
    '.modal-bg,.hr-modal-overlay{padding:12px!important;}',
    /* form controls never exceed their column; modal footers get thumb-sized buttons */
    'input:not([type=checkbox]):not([type=radio]),select,textarea{max-width:100%;}',
    '.modal-actions button,.otr-foot button,.hfm-foot button,.hfm-btn,.btn-save,.btn-cancel{min-height:44px;}',
    /* a wide table scrolls inside its own wrapper (added by fitTables below), never the page */
    '.be-tscroll{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}',
    /* status chips/badges wrap inside their parent */
    /* status chips / action groups wrap inside their parent. Right-aligned (flex-end) groups that
       can't wrap are what push badges/buttons off the LEFT edge of a narrow card. */
    '.cls-badges,.pr-card-pills,.hr-actions,.bcard-actions,.bt-acts,.dg-acts,.dgx-acts,.bw-acts,.avx-acts,.lr-acts,.cb-actions,.modal-actions,.hr-emp-foot,.otr-foot,.hfm-foot,.mp-foot{flex-wrap:wrap!important;min-width:0;max-width:100%;}',
    '}',
    /* two-column modal/form grids collapse to one column on small phones */
    '@media (max-width:480px){',
    '.otr-g2,.hfm-g2,.hfm-grid,.prm-cols,.form-grid,.grid-2{grid-template-columns:minmax(0,1fr)!important;}',
    '.modal,.hr-modal,.otr,.jv-sheet{width:100%!important;}',
    '}',
    /* ---- PHONE EDITION skin (<=560px): reshape the desktop content into a native
       mobile card feed — tighter gutters, elevated rounded cards, mobile type rhythm,
       full-width primary actions. Visual only; no page logic/markup touched. ---- */
    '@media (max-width:560px){',
    'body{background:var(--sf-0, #05070d)!important;}',
    '.main,main,.acadx-shell,#app>main{padding:12px 12px calc(140px + env(safe-area-inset-bottom,0px))!important}',
    'h1{font-size:21px!important;line-height:1.12!important;margin:2px 0 2px!important}',
    'h2{font-size:14.5px!important}',
    /* card skin — covers the section/card primitives across all four pages */
    '.section,.card,.glass-card,.acadx-card,.acadx-section,.hr-card,.acadx-dash-card{',
    'border-radius:16px!important;border:1px solid rgba(var(--ink, 255,255,255), 0.07)!important;',
    'background:linear-gradient(180deg,rgba(var(--sf-3-rgb, 20,26,40), 0.55),rgba(var(--sf-2-rgb, 13,17,28), 0.55))!important;',
    'box-shadow:0 6px 18px rgba(var(--shade, 0,0,0), calc(0.35 * var(--shade-k, 1)))!important;margin-bottom:12px!important;}',
    '.section{padding:15px!important}',
    '.qrow{border-radius:14px!important;padding:13px 14px!important}',
    '.tile{padding:13px!important;border-radius:14px!important}',
    /* primary action buttons go full-width & thumb-sized in a card footer */
    '.modal-actions .btn,.modal-actions .btn-ghost{flex:1;min-height:46px}',
    '.filters>*{flex:1 1 46%!important;min-width:0!important}',
    /* let horizontally-wide tables scroll inside their own card, page never scrolls sideways */
    '.section table,.card table{min-width:520px}',
    '.section>div[style*=overflow],.card>div[style*=overflow]{-webkit-overflow-scrolling:touch}',
    '}'
  ].join('');
  var st = document.createElement('style'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st);

  var nav = null, sheetBg = null, sheet = null, primaries = [], navSig = '', mo = null, menuBtn = null;

  // ── Wide tables on phones: wrap any table that is wider than its container in a horizontal
  // scroller (.be-tscroll), so the TABLE scrolls and the page never does. Tables already inside a
  // scrolling container, or reshaped into cards by a page's own CSS (display != table), are left
  // alone. Re-checked after DOM changes because tables are re-rendered by each page's JS.
  // A dedicated horizontal scroller — NOT the page's own vertical scroller (overflow-y:auto also
  // computes overflow-x to auto, which would wrongly count main/.acad-main as a table container).
  function scrollsX(el) {
    if (el.matches('main,.main,.acad-main,#app,body')) return false;
    var ox = getComputedStyle(el).overflowX; return ox === 'auto' || ox === 'scroll';
  }
  function fitTables() {
    if (window.innerWidth > BP) return;
    var tables = document.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i], p = t.parentElement;
      if (!p || p.classList.contains('be-tscroll') || !t.getClientRects().length) continue;
      if (getComputedStyle(t).display !== 'table') continue;
      var contained = false;
      for (var a = p, k = 0; a && a !== document.body && k < 4; a = a.parentElement, k++) { if (scrollsX(a)) { contained = true; break; } }
      if (contained) continue;
      if (t.getBoundingClientRect().width <= p.getBoundingClientRect().width + 1) continue;
      var w = document.createElement('div'); w.className = 'be-tscroll';
      p.insertBefore(w, t); w.appendChild(t);
    }
  }
  window.BEMobileFitTables = fitTables;
  var _ftTimer = null;
  function scheduleFit() { clearTimeout(_ftTimer); _ftTimer = setTimeout(fitTables, 250); }
  try {
    // childList = re-rendered tables; class/style = tabs and panels being shown
    new MutationObserver(scheduleFit).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', scheduleFit);
  } catch (e) {}

  function labelOf(el) {
    // Prefer the wrapped label span (sidebar-collapse.js's .be-nav-label). Fall back to the
    // link's own text with icon + any notification-badge spans stripped — the old
    // `querySelector('span')` grabbed the first span, which for links like Announcements is the
    // empty count badge, yielding '' and silently dropping that item from the menu.
    var lab = el.querySelector('.be-nav-label');
    if (lab) return (lab.textContent || '').replace(/\s+/g, ' ').trim();
    var clone = el.cloneNode(true);
    var junk = clone.querySelectorAll('[data-lucide], svg, [id*="badge"], [class*="badge"]');
    for (var i = 0; i < junk.length; i++) junk[i].remove();
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function iconOf(el) {
    var i = el.querySelector('[data-lucide]');
    return i ? i.getAttribute('data-lucide') : 'circle';
  }
  function shortLabel(t) {
    // first meaningful word, so it fits a bottom tab ("My Work Queue" -> "Queue")
    var words = t.split(' ').filter(function (w) { return !/^(my|the|a|all)$/i.test(w); });
    return (words[0] || t).slice(0, 10);
  }

  // The ONE canonical nav container to read links from — the page's real desktop sidebar.
  // Reading from a single root is the whole fix for two bugs at once:
  //   1. Duplicates. index.html/hr.html also carry an OLD off-canvas #mobile-sidebar drawer
  //      (a second full copy of the nav). Reading globally scooped BOTH → every item appeared
  //      twice (Pipeline Matrix ×2, History ×2, …). The drawer lives OUTSIDE #be-sidebar, so
  //      scoping to the sidebar drops it entirely.
  //   2. Cross-module leakage. index.html embeds the whole Academic module's nav inline, inside
  //      #nav-group-academic which is display:none (.hidden) until checkAcademicAccess() confirms
  //      this employee actually has Academic access. Those links have no .hidden of their own —
  //      only their GROUP does — so the old per-link .hidden check missed them and a plain Media
  //      employee saw Dashboard/Live Batches/Courses/Coaches/etc. isVisibleNav() below walks the
  //      ancestors up to the sidebar root and skips a link inside any display:none/.hidden group,
  //      so a hidden permission group is never harvested. Not a CSS patch — the DOM we build
  //      simply never contains those links for a role that can't see them.
  function navRoot() {
    return document.getElementById('be-sidebar') || document.getElementById('aside') || document.querySelector('aside.aside, aside');
  }
  // The app shell must be authenticated/shown before the bottom bar appears. Most pages gate
  // login with display:none on #app (collectLinks then finds nothing → no bar, correct). BUT
  // index.html gates its #main-application-frame with opacity:0 + pointer-events:none instead —
  // display is not none, so the sidebar's links ARE "visible" and the bar was building right on
  // top of the login screen. Walk from ABOVE the sidebar up to <body>: if any ancestor is
  // display:none / visibility:hidden / opacity:0 / pointer-events:none, the shell isn't ready.
  // (Starts above the sidebar so the aside's own mobile display:none doesn't trip it.)
  function appReady() {
    var root = navRoot();
    if (!root) return false;
    var node = root.parentElement;
    while (node && node !== document.body && node.nodeType === 1) {
      var cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || cs.pointerEvents === 'none') return false;
      node = node.parentElement;
    }
    return true;
  }
  // Visible = not permission-gated. Walks parents up to (but not including) the sidebar root,
  // so the root's OWN `display:none` on mobile (aside{display:none} at <=767px) is ignored,
  // while an inner hidden group (e.g. #nav-group-academic.hidden) correctly excludes its links.
  function isVisibleNav(el, root) {
    if (el.classList.contains('hidden')) return false;
    var node = el.parentElement;
    while (node && node !== root) {
      if (node.classList.contains('hidden')) return false;
      if (getComputedStyle(node).display === 'none') return false;
      node = node.parentElement;
    }
    return true;
  }
  // Stable dedup key = the switchTab/acadSwitchTab target, so "switchTab('dashboard')" and the
  // drawer's "switchTab('dashboard');closeMobileSidebar()" collapse to one, and label case/spacing
  // never splits a destination into two entries.
  function destKey(el) {
    var oc = el.getAttribute('onclick') || '';
    var m = oc.match(/(?:switchTab|acadSwitchTab|switchHRSubtab)\(\s*['"]([^'"]+)['"]/);
    if (m) return 'tab:' + m[1];
    if (el.getAttribute('data-tab')) return 'tab:' + el.getAttribute('data-tab');
    return 'lbl:' + (labelOf(el) || '').toLowerCase();
  }
  // Collect the page's real sidebar links — ONE source (the desktop sidebar), permission-aware,
  // deduped by destination.
  function collectLinks() {
    var root = navRoot();
    var all = (root || document).querySelectorAll('.sidebar-link, .acad-nav-link');
    var seen = {}, out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (root && !isVisibleNav(el, root)) continue;
      var lab = labelOf(el);
      if (!lab) continue;
      if (/^log ?out$/i.test(lab)) continue;               // logout lives elsewhere
      var key = destKey(el);
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ el: el, label: lab, icon: iconOf(el) });
    }
    return out;
  }

  function build() {
    if (nav) return;
    if (!appReady()) return;   // don't paint the bar over the login screen
    var links = collectLinks();
    if (!links.length) return;
    // Primary 4 = the fixed bottom-bar tabs. A page can name them explicitly by putting
    // `data-mnav` on the 4 desktop sidebar links it wants pinned (e.g. index.html pins
    // Pipeline/History/Profile/Attendance — its desktop order would otherwise surface
    // Announcements 4th). data-mnav is an invisible attribute: zero effect on desktop. Pages
    // that set none keep the previous behaviour (first 4 collected), so nothing else changes.
    var flagged = links.filter(function (l) { return l.el.hasAttribute('data-mnav'); });
    var primaryLinks = flagged.length ? flagged.slice(0, 4) : links.slice(0, 4);
    primaries = [];

    nav = document.createElement('nav');
    nav.className = 'be-mnav';
    primaryLinks.forEach(function (lk) {
      var b = document.createElement('button');
      b.className = 'be-mnav-item';
      b.style.position = 'relative';
      b.innerHTML = '<i data-lucide="' + lk.icon + '"></i><span>' + shortLabel(lk.label) + '</span>';
      b.addEventListener('click', function () { lk.el.click(); closeSheet(); syncActive(); });
      nav.appendChild(b);
      primaries.push({ btn: b, el: lk.el });
    });
    // Menu tab
    var menu = document.createElement('button');
    menu.className = 'be-mnav-item';
    menu.innerHTML = '<i data-lucide="menu"></i><span>Menu</span>';
    menu.addEventListener('click', openSheet);
    nav.appendChild(menu);
    menuBtn = menu;
    document.body.appendChild(nav);

    // Bottom sheet with EVERY nav item
    sheetBg = document.createElement('div');
    sheetBg.className = 'be-msheet-bg';
    sheet = document.createElement('div');
    sheet.className = 'be-msheet';
    sheet.innerHTML = '<div class="be-msheet-grab"></div>';
    links.forEach(function (lk) {
      var b = document.createElement('button');
      b.className = 'be-msheet-item';
      b.innerHTML = '<i data-lucide="' + lk.icon + '"></i> ' + lk.label;
      b.addEventListener('click', function () { lk.el.click(); closeSheet(); syncActive(); });
      sheet.appendChild(b);
    });
    sheetBg.appendChild(sheet);
    sheetBg.addEventListener('click', function (e) { if (e.target === sheetBg) closeSheet(); });
    document.body.appendChild(sheetBg);

    if (typeof lucide !== 'undefined') try { lucide.createIcons(); } catch (e) {}
    navSig = links.map(function (l) { return destKey(l.el); }).join('|');
    syncActive();
    // Watch the whole sidebar: a class change flips active state (syncActive), but auth
    // revealing/hiding a permission group (e.g. checkAcademicAccess() un-hiding #nav-group-
    // academic for an Academic employee, or hiding Pipeline for them) changes WHICH links are
    // visible — the nav must then rebuild so it can never show a stale/wrong menu after login
    // resolves (spec item 11). Cheap: only rebuilds when the visible-destination set actually
    // changes, otherwise just re-syncs the active pill.
    var root = navRoot();
    if (mo) mo.disconnect();
    mo = new MutationObserver(function () {
      var sig = collectLinks().map(function (l) { return destKey(l.el); }).join('|');
      if (sig !== navSig) rebuild(); else syncActive();
    });
    if (root) mo.observe(root, { attributes: true, attributeFilter: ['class', 'style'], subtree: true, childList: true });
  }

  // Tear down the built bar/sheet and build afresh — used when the visible nav set changes
  // after auth. Idempotent; safe to call any number of times.
  function rebuild() {
    if (nav && nav.parentNode) nav.parentNode.removeChild(nav);
    if (sheetBg && sheetBg.parentNode) sheetBg.parentNode.removeChild(sheetBg);
    nav = null; sheetBg = null; sheet = null; primaries = [];
    build();
  }

  function openSheet() { if (sheetBg) { sheetBg.setAttribute('data-open', ''); if (menuBtn) menuBtn.setAttribute('data-active', ''); syncActive(); } }
  function closeSheet() { if (sheetBg) sheetBg.removeAttribute('data-open'); if (menuBtn) menuBtn.removeAttribute('data-active'); }

  function syncActive() {
    primaries.forEach(function (p) {
      if (p.el.classList.contains('active')) p.btn.setAttribute('data-active', '');
      else p.btn.removeAttribute('data-active');
    });
  }

  function boot() {
    // Only build the bar when it will actually be shown (mobile) — but build once and let CSS
    // media query control visibility, so a rotate/resize into mobile just works.
    build();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // The sidebar/app shell appears only after the user logs in (login is user-paced — could be
  // seconds or minutes), so keep trying build() until it succeeds. build() self-gates on
  // appReady(), so this never paints over the login screen; it just retries cheaply until the
  // authenticated shell is up. Generous cap (~10 min) purely as a safety stop.
  var tries = 0;
  var iv = setInterval(function () { if (nav || tries++ > 1200) { clearInterval(iv); return; } build(); }, 500);
  // Instant trigger the moment the app frame is revealed (login success flips
  // #main-application-frame's opacity/pointer-events, or a page toggles #app's display) — so the
  // bar appears right after auth without waiting on the polling interval (which a backgrounded
  // tab can throttle). Disconnects itself once the bar is built.
  var preObs = new MutationObserver(function () { if (nav) { preObs.disconnect(); return; } build(); });
  try { preObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'], subtree: true }); } catch (e) {}
})();
