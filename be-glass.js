/* ============================================================================
   BEGlass — adoption half of the Liquid Glass system (materials live in be-glass.css).

   Why this exists: most ERP surfaces are not reachable by a fixed class list — 20+ modules
   (work-tasks, work-project, file-share, content-calendar, aura, notifications …) inject their
   own CSS after the page loads, templates paint panels with inline style="background:…", and
   menus / dialogs / toasts are appended straight to <body>. So instead of guessing class names,
   every rendered element is classified ONCE by what it actually is on screen:

     full-screen fixed layer          → .lg-scrim   (dialog backdrop, dimmed, never blurred)
     surface inside a scrim           → .lg-dialog
     floating surface (fixed/abs, z)  → .lg-pop     (menus, popovers, toasts, sheets)
     surface inside another surface   → .lg-nested
     any other theme-coloured surface → .lg-panel
     buttons                          → .lg-btn (neutral) · .lg-btn-solid (filled) · .lg-btn-ghost
     2+ buttons/tabs in a track       → .lg-seg + .lg-seg-item
   A "surface" is a sizeable box whose background is the theme's neutral surface colour (solid,
   or the faint ink tint panels use) — coloured status chips, photos, charts and tables are left
   alone. Elements set inline get .lg-inline so the material can outrank the inline style.

   New nodes (MutationObserver) and elements that become visible later (a dialog opening by
   class/style toggle) are classified as they appear, in idle-time batches. Purely visual: no
   handler, DOM structure, text or data is touched. Opt out with class="lg-skip" on any subtree.
   BEGlass.audit()  → counts per material + any large opaque surfaces still unadopted.
   ============================================================================ */
(function () {
  'use strict';
  if (window.BEGlass) return;

  var SURFACE_TAGS = { DIV: 1, SECTION: 1, ASIDE: 1, NAV: 1, HEADER: 1, FOOTER: 1, ARTICLE: 1, FORM: 1, UL: 1, DIALOG: 1, DETAILS: 1, FIELDSET: 1, LI: 1 };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, IMG: 1, SVG: 1, PATH: 1, CANVAS: 1, VIDEO: 1, IFRAME: 1, PICTURE: 1, OPTION: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, I: 1, svg: 1 };
  var SKIP_ZONE = '.lg-skip, .bst-scene, .be-dark-island, .be-celeb-overlay, .bst, svg, table, .jv-orb, .be-login-visual-side';
  var CHROME = 'aside.be-aside, aside#be-sidebar, .aside, .bes-header, #sales-mobile-appbar, .lg-chrome';
  var OWN_NAV = '.sidebar-link, .acad-nav-link, .bes-search, .bes-date, .bes-icon, .be-tt, .be-sidebar-toggle, .bes-account, .be-tt *';
  var SURF_ROLES = ['lg-panel', 'lg-nested', 'lg-pop', 'lg-dialog'];
  /* families be-glass.css already styles by class (first paint, before this script runs) */
  var KNOWN = [
    ['lg-scrim', '.modal-bg, .hr-modal-overlay, .acadx-modal-bg, .dm-overlay, .mgr-drill-bg, .fs-ov, .cc-ov, .au-ov, .bsa-ov, .ld-ov, .bear-ov, .am-modal-bg, .be-annm-bg, .be-msheet-bg, .jv-sheet-bg, .tp-overlay, .be-dp-overlay, .be-pfp-overlay, #mobile-nav-overlay'],
    ['lg-dialog', '.modal, .hr-modal, .acadx-modal, .dm-box, .mgr-drill, .bw-modal, .mw-modal, .fs-dlg, .cc-dlg, .ld-dlg, .au-dlg, .bclk-dlg, .bcp-dlg, .bsa-dlg, .am-modal, .lbox, .fbs-win, .bes-pal-box, .tp-box, .be-dp, .jv-sheet'],
    ['lg-pop', '.am-dropdown, .ben-panel, #notif-panel > div, #global-search-overlay > div, #hr-float-menu, #hr-month-picker, .be-sel-menu, .be-cal, .ub-cal-pop, .ub-time-pop, .wp-pick-pop, .au-pop, .wp-drop, .switcher-panel, .toast, .ben-toast, .mw-toast, .bclk-toast'],
    ['lg-panel', '.card, .hcard, .section, .acadx-section, .acadx-card, .stat-card-new, .stat-card, .pm-card, .glass-card, .dash-card, .mw-card, .bw-card, .cc-card, .wp-card, .hfm-card, .ec-card, .tcard, .mcard, .ub-card, .wf-card, .metric-strip, .assignment-panel, .emp-panel, .am-card, .bsa-card, .be-login-shell']
  ];
  function known(el) {
    for (var i = 0; i < KNOWN.length; i++) if (el.matches(KNOWN[i][1])) return KNOWN[i][0];
    return null;
  }
  var ACTIVE = /(^|\s)(active|on|sel|selected|is-active|current)(\s|$)/;

  function rgba(str) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(str || '');
    if (!m) return null;
    var a = m[4] == null ? 1 : (m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }
  function lum(c) { return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255; }
  function sat(c) { return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b); }
  function dark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }

  /* neutral surface colour of the current theme: near-black (dark) / near-white (light) */
  function isSurfaceColour(c) {
    if (!c || c.a < 0.5 || sat(c) > 42) return false;
    var L = lum(c);
    return dark() ? L < 0.2 : L > 0.84;
  }
  /* the faint ink wash panels use: white @ 2–14 % (dark) / navy @ 2–14 % (light) */
  function isInkTint(c) {
    if (!c || c.a < 0.015 || c.a > 0.16 || sat(c) > 50) return false;
    return dark() ? lum(c) > 0.8 : lum(c) < 0.35;
  }
  function stops(img) {
    if (!img || img === 'none' || img.indexOf('url(') >= 0 || img.indexOf('gradient') < 0) return null;
    return (img.match(/rgba?\([^)]+\)/g) || []).map(rgba);
  }
  /* a gradient built from surface colours (faint washes under 20 % don't count either way) */
  function gradientIsSurface(img) {
    var st = stops(img); if (!st) return false;
    var strong = st.filter(function (c) { return c && c.a >= 0.2; });
    return strong.length > 0 && strong.every(isSurfaceColour);
  }
  /* a faint coloured wash a component lays over its surface (KPI hue, status tint) */
  function accentWash(img) {
    var st = stops(img); if (!st) return false;
    return st.some(function (c) { return c && c.a > 0 && c.a < 0.2 && sat(c) >= 45; }) && !st.some(function (c) { return c && c.a >= 0.5 && sat(c) >= 45; });
  }
  function filled(cs) {
    var st = stops(cs.backgroundImage);
    if (st && st.some(function (c) { return c && c.a >= 0.5 && sat(c) >= 45; })) return true;
    var c = rgba(cs.backgroundColor);
    return !!(c && c.a >= 0.5 && sat(c) >= 45);
  }
  function hasBorder(cs) {
    return parseFloat(cs.borderTopWidth) > 0 && (rgba(cs.borderTopColor) || { a: 0 }).a > 0.04 && cs.borderTopStyle !== 'none';
  }
  function inlineBg(el) { var s = el.style; return !!(s && (s.background || s.backgroundColor || s.backgroundImage)); }

  function surfaceAncestor(el) {
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      var r = p.getAttribute('data-lg');
      if (r === 'lg-scrim') return 'scrim';
      if (r && SURF_ROLES.indexOf(r) >= 0) return r;
      if (p.matches(CHROME)) return 'lg-chrome';
    }
    return null;
  }
  function tag(el, role, inline) {
    el.setAttribute('data-lg', role);
    if (role.indexOf('lg-') === 0) el.classList.add(role);
    if (inline) el.classList.add('lg-inline');
  }
  /* keep a surface's identity: its accent wash rides on top of the glass, its coloured edge stays */
  function keepIdentity(el, cs) {
    if (accentWash(cs.backgroundImage)) { el.style.setProperty('--lg-own', cs.backgroundImage); el.classList.add('lg-keep-img'); }
    var b = rgba(cs.borderTopColor);
    if (hasBorder(cs) && b && b.a >= 0.18 && sat(b) >= 60) { el.style.setProperty('--lg-own-edge', cs.borderTopColor); el.classList.add('lg-keep-edge'); }
  }

  function classifySurface(el, cs, r) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var pos = cs.position, bg = rgba(cs.backgroundColor);
    // full-screen layer: a dialog backdrop (dim, never blur) — loading screens (opaque) excluded
    if (pos === 'fixed' && r.width >= vw * 0.9 && r.height >= vh * 0.9) {
      if (bg && bg.a >= 0.15 && bg.a < 0.96) { tag(el, 'lg-scrim'); return true; }
      if (cs.backdropFilter && cs.backdropFilter !== 'none' && (!bg || bg.a < 0.96)) { tag(el, 'lg-scrim'); return true; }
      return false;
    }
    var anc = surfaceAncestor(el), inline = inlineBg(el);
    var z = parseInt(cs.zIndex, 10) || 0;
    // a box inside a backdrop is the dialog, whatever colour its template hard-coded
    // (several build theirs with a fixed dark rgb(), which ignores the light theme)
    if (anc === 'scrim' && bg && bg.a >= 0.5 && sat(bg) <= 42 && r.width >= 200 && r.height >= 80) { tag(el, 'lg-dialog', inline); return true; }
    var solid = isSurfaceColour(bg) || gradientIsSurface(cs.backgroundImage);
    var floating = pos === 'fixed' || (pos === 'absolute' && z >= 10);
    if (!solid && floating && !anc && bg && bg.a >= 0.5 && sat(bg) <= 42) solid = true;   // menus / toasts, same reason
    var tint = !solid && isInkTint(bg) && hasBorder(cs) && parseFloat(cs.borderTopLeftRadius) >= 8;
    if (!solid && !tint) return false;
    if (solid ? (r.width < 120 || r.height < 40) : (r.width < 170 || r.height < 52)) return false;
    keepIdentity(el, cs);
    if (anc === 'scrim') { tag(el, 'lg-dialog', inline); return true; }
    if (solid && floating && !anc) { tag(el, 'lg-pop', inline); return true; }
    if (anc) { tag(el, 'lg-nested', inline); return true; }
    tag(el, solid ? 'lg-panel' : 'lg-nested', inline);
    return true;
  }

  function classifyButton(el, cs, r) {
    if (r.width < 22 || r.height < 20 || el.matches(OWN_NAV)) return false;
    if (el.closest('.lg-seg')) return false;
    var inline = inlineBg(el);
    if (filled(cs)) { tag(el, 'lg-btn-solid'); return true; }
    var bg = rgba(cs.backgroundColor);
    var visible = (bg && bg.a > 0.015) || hasBorder(cs);
    // big text-only rows (list items rendered as <button>) are not controls to restyle
    if (!visible && r.height > 64) return false;
    tag(el, visible ? 'lg-btn' : 'lg-btn-ghost', inline && visible);
    return true;
  }

  /* a track of 2+ sibling buttons/tabs that paints a background or border, short and inline */
  function classifySeg(el, cs, r) {
    if (r.height > 64 || r.height < 22) return false;
    var kids = el.children, items = [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.tagName === 'BUTTON' || k.getAttribute('role') === 'tab' || (k.tagName === 'A' && k.getAttribute('href') === null)) items.push(k);
      else if (k.offsetWidth) return false;   // mixed content → a toolbar, not a segmented control
    }
    var isList = el.getAttribute('role') === 'tablist';
    if (items.length < 2) return false;
    var bg = rgba(cs.backgroundColor);
    if (!isList && !((bg && bg.a > 0.015) || hasBorder(cs))) return false;
    tag(el, 'lg-seg');
    // a group whose items carry status colours (present / absent …) keeps them
    for (var j = 0; j < items.length; j++) {
      var ic = getComputedStyle(items[j]);
      if (ACTIVE.test(items[j].className) && filled(ic) && !/gradient/.test(ic.backgroundImage)) el.classList.add('lg-seg-keep');
      items[j].setAttribute('data-lg', 'lg-seg-item');
      items[j].classList.add('lg-seg-item');
    }
    return true;
  }

  function visit(el) {
    if (el.hasAttribute('data-lg') || SKIP_TAGS[el.tagName]) return;
    if (el.closest(SKIP_ZONE)) { el.setAttribute('data-lg', '-'); return; }
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;          // not rendered yet — retried when it appears
    if (el.matches(CHROME)) { el.setAttribute('data-lg', 'lg-chrome'); return; }
    var k = known(el);
    if (k) { el.setAttribute('data-lg', k === 'lg-panel' && surfaceAncestor(el) ? 'lg-nested' : k); return; }
    var cs = getComputedStyle(el), done = false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    var isBtn = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' ||
                (el.tagName === 'A' && /btn|button/.test(el.className));
    // tile-sized buttons (KPI cards, clickable panels) are surfaces, not controls
    if (isBtn && r.width >= 140 && r.height >= 64 && !filled(cs)) done = classifySurface(el, cs, r);
    if (isBtn && !done) done = classifyButton(el, cs, r);
    else if (SURFACE_TAGS[el.tagName]) done = classifySeg(el, cs, r) || classifySurface(el, cs, r);
    if (!done) el.setAttribute('data-lg', '-');
  }

  /* ── idle-time batching ── */
  var queue = [], queued = new Set(), scheduled = false;
  var idle = window.requestIdleCallback || function (fn) { return setTimeout(function () { fn({ timeRemaining: function () { return 8; } }); }, 16); };
  function enqueue(root) {
    if (!root || root.nodeType !== 1 || queued.has(root)) return;
    queued.add(root); queue.push(root);
    if (!scheduled) { scheduled = true; idle(run, { timeout: 300 }); }
  }
  function run(deadline) {
    scheduled = false;
    while (queue.length && deadline.timeRemaining() > 2) {
      var root = queue.shift(); queued.delete(root);
      if (!root.isConnected) continue;
      visit(root);
      var all = root.getElementsByTagName('*');
      for (var i = 0; i < all.length; i++) visit(all[i]);
    }
    if (queue.length) { scheduled = true; idle(run, { timeout: 300 }); }
  }

  /* a class mutation that only added our own lg-* classes */
  function ownTagging(m) {
    if (m.attributeName !== 'class' || typeof m.target.className !== 'string') return false;
    var strip = function (v) { return String(v || '').replace(/(^|\s)lg-[\w-]+/g, '').trim(); };
    return strip(m.target.className) === strip(m.oldValue);
  }

  function start() {
    enqueue(document.body);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) if (m.addedNodes[j].nodeType === 1) enqueue(m.addedNodes[j]);
        } else if (m.target.nodeType === 1 && !ownTagging(m)) {
          enqueue(m.target);   // shown/hidden by class/style/hidden/open toggles → classify what appeared
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
    // theme switch: the surface test is theme-relative, so re-check anything left unclassified
    if (window.BETheme && typeof BETheme.onChange === 'function') {
      BETheme.onChange(function () {
        var rest = document.querySelectorAll('[data-lg="-"]');
        for (var i = 0; i < rest.length; i++) rest[i].removeAttribute('data-lg');
        enqueue(document.body);
      });
    }
  }

  function audit() {
    var counts = {}, left = [];
    document.querySelectorAll('[data-lg]').forEach(function (e) { var k = e.getAttribute('data-lg'); counts[k] = (counts[k] || 0) + 1; });
    document.querySelectorAll('body *').forEach(function (e) {
      if (SKIP_TAGS[e.tagName] || e.closest(SKIP_ZONE)) return;
      var r = e.getBoundingClientRect(); if (r.width < 160 || r.height < 60) return;
      var role = e.getAttribute('data-lg'); if (role && role !== '-') return;
      if (e.matches(CHROME)) return;
      var c = rgba(getComputedStyle(e).backgroundColor);
      if (c && c.a >= 0.85) left.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + Array.prototype.slice.call(e.classList, 0, 3).join('.') + ' ' + getComputedStyle(e).backgroundColor);
    });
    return { counts: counts, opaqueUnadopted: left };
  }

  window.BEGlass = { audit: audit, refresh: function (el) { enqueue(el || document.body); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
