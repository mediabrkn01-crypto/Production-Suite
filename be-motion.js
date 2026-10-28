/* ============================================================================
   BEMotion — interaction + motion behaviour for every portal (styles: be-motion.css).
   Plain JS, no dependency; everything is delegated / observed, so pages and JS-rendered
   modules adopt it without per-page code. Business logic is never touched: handlers only
   add classes, CSS variables and a few ARIA / tabindex attributes.

     magnify   sidebar nav items — icon swell by pointer proximity (mouse only, rAF-throttled)
     enter     tab panes / sections, modal scrims + dialogs, menus & popovers fade in once per open;
               a dialog grows from the point the user clicked, a menu from its trigger side
     glide     segmented tab groups: the active pill slides from the old tab to the new one
     peek      [data-be-peek] text on hover (420 ms intent delay) or keyboard focus; Esc hides
     disclose  long notes (.aw-note, .wa-desc, [data-be-clamp]) clamp to 3 lines + Show more
     rows      Work Assignment rows are focusable buttons (Enter / Space opens the task)
   API: BEMotion.ok(button) — brief success ring on a button after its action completed.
   ============================================================================ */
(function () {
  'use strict';
  if (window.BEMotion) return;
  var RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var FINE = window.matchMedia ? matchMedia('(hover: hover) and (pointer: fine)') : { matches: true };
  var NAV = '.sidebar-link, .acad-nav-link, .navlink';
  var PANE = '[id^="tab-content-"], [id^="hr-sub-"], [id^="tab-acad-"], .tab[id^="tab-"], #mgr-dash, #mgr-work, #mgr-annc, #mgr-content > iframe';
  var POP = '.be-sel-menu, .be-cal, .am-dropdown, .lg-pop';
  // full-screen overlays that live inside the page (portalled ones are body children)
  var OVL = '.fixed.inset-0, .modal-bg, .acadx-modal-bg, .bw-ov, .hr-modal-bg, .am-modal-bg, [id$="-overlay"], [id$="-modal"]';
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
  function vis(el) { if (!el || !el.isConnected) return false; var cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  function once(el, cls) {
    if (RM.matches || !el) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    var done = function () { el.classList.remove(cls, 'be-up'); el.style.transformOrigin = el.__beOrigin || ''; el.removeEventListener('animationend', done); };
    el.addEventListener('animationend', done);
    setTimeout(done, 700);   // never leave a class behind if the animation is skipped
  }

  // ── last pointer: where a dialog / menu should appear to come from ─────────
  var lastPt = null;
  document.addEventListener('pointerdown', function (e) { lastPt = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);
  function recentPt() { return lastPt && Date.now() - lastPt.t < 900 ? lastPt : null; }

  // ════ magnify ════════════════════════════════════════════════════════════
  var magBox = null, magItems = [], magY = 0, magQueued = false, magHot = null;
  var RANGE = 72, PEAK = 0.09;   // px of influence above / below the pointer; hovered icon ≈ 1.09
  function navBox(item) { return item.closest('aside, nav, .be-aside, #be-sidebar, .side, .sidebar') || item.parentElement; }
  function magReset() {
    magItems.forEach(function (it) { it.style.removeProperty('--be-mag'); it.classList.remove('be-mag-on'); });
    magItems = []; magBox = null; magHot = null;
  }
  function magFrame() {
    magQueued = false;
    if (!magBox) return;
    for (var i = 0; i < magItems.length; i++) {
      var it = magItems[i], r = it.getBoundingClientRect();
      if (!r.height) continue;
      var d = Math.abs(magY - (r.top + r.height / 2)), f = Math.max(0, 1 - d / RANGE);
      var s = 1 + PEAK * f * f;
      if (s > 1.002) it.style.setProperty('--be-mag', s.toFixed(3)); else it.style.removeProperty('--be-mag');
      it.classList.toggle('be-mag-on', it === magHot);
    }
  }
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || RM.matches || !FINE.matches) return;
    var item = e.target.closest && e.target.closest(NAV);
    var box = item ? navBox(item) : (magBox && magBox.contains(e.target) ? magBox : null);
    if (!box) { if (magBox) magReset(); return; }
    if (box !== magBox) { magReset(); magBox = box; magItems = Array.prototype.filter.call(box.querySelectorAll(NAV), vis); }
    magHot = item; magY = e.clientY;
    if (!magQueued) { magQueued = true; setTimeout(magFrame, 16); }
  }, { passive: true });
  document.addEventListener('pointerleave', magReset);
  window.addEventListener('blur', magReset);
  document.addEventListener('scroll', function () { if (magBox) { magQueued = true; setTimeout(magFrame, 16); } }, { passive: true, capture: true });

  // ════ enter: panes, dialogs, menus ════════════════════════════════════════
  var shown = new WeakMap();
  function overlayDialog(scrim) {
    // the dialog is the largest visible child box of a full-screen overlay
    var best = null, area = 0, kids = scrim.children;
    for (var i = 0; i < kids.length; i++) { var r = kids[i].getBoundingClientRect(); if (r.width * r.height > area && r.width < innerWidth * .98) { area = r.width * r.height; best = kids[i]; } }
    return best;
  }
  function isOverlay(el) {
    if (el === document.body || el.id === 'be-bg-layer' || el.classList.contains('be-peek')) return false;
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed') return false;
    var r = el.getBoundingClientRect();
    return r.width >= innerWidth * .95 && r.height >= innerHeight * .9 && el.children.length > 0;
  }
  function enterOverlay(scrim) {
    var dlg = overlayDialog(scrim); if (!dlg) return;
    once(scrim, 'be-scrim-in');
    var p = recentPt(), r = dlg.getBoundingClientRect();
    if (p && r.width) {
      var ox = Math.min(Math.max(p.x - r.left, 0), r.width), oy = Math.min(Math.max(p.y - r.top, 0), r.height);
      dlg.__beOrigin = dlg.style.transformOrigin; dlg.style.transformOrigin = ox + 'px ' + oy + 'px';
    }
    once(dlg, 'be-dlg-in');
  }
  function enterPop(el) {
    var p = recentPt(), r = el.getBoundingClientRect();
    if (p && r.height && r.bottom <= p.y + 4) el.classList.add('be-up');    // opened above its trigger
    once(el, 'be-pop-in');   // origin: top, or bottom for .be-up (CSS — menus rewrite their inline styles)
  }
  function check(el) {
    var now = vis(el), was = shown.get(el);
    shown.set(el, now);
    if (!now || was) return;
    if (el.matches(POP)) return enterPop(el);
    if (el.matches(PANE)) { if (!el.parentElement || !el.parentElement.closest('.be-pane-in')) once(el, 'be-pane-in'); return; }
    if (isOverlay(el)) enterOverlay(el);
  }
  function sweep(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(PANE + ',' + POP + ',' + OVL) || root.parentElement === document.body) check(root);
    var list = root.querySelectorAll(PANE + ',' + POP + ',' + OVL);
    for (var i = 0; i < list.length; i++) check(list[i]);
    var top = document.body.children;   // overlays live at body level (portalled)
    for (var j = 0; j < top.length; j++) if (top[j] === root || root.contains(top[j]) || top[j].contains(root)) check(top[j]);
  }

  // ════ glide: segmented tabs ═══════════════════════════════════════════════
  var SEG = '.lg-seg, .bw-tabs, [role="tablist"], .bbs-seg';
  var ON = /(^|\s)(on|active|selected|is-active|sel|current)(\s|$)/;
  function activeOf(seg) {
    var items = seg.children;
    for (var i = 0; i < items.length; i++) { var k = items[i]; if (k.classList.contains('be-glide')) continue; if (ON.test(k.className) || k.getAttribute('aria-selected') === 'true' || k.getAttribute('aria-pressed') === 'true') return k; }
    return null;
  }
  document.addEventListener('click', function (e) {
    if (RM.matches) return;
    var item = e.target.closest && e.target.closest('button, [role="tab"]'); if (!item) return;
    var seg = item.parentElement && item.parentElement.matches(SEG) ? item.parentElement : null; if (!seg) return;
    var from = activeOf(seg); if (!from || from === item) return;
    var fr = from.getBoundingClientRect(), segR = seg.getBoundingClientRect(), fcs = getComputedStyle(from);
    var paint = { bg: fcs.backgroundImage !== 'none' ? fcs.backgroundImage + ',' + fcs.backgroundColor : fcs.backgroundColor, sh: fcs.boxShadow, rad: fcs.borderRadius, bd: fcs.border };
    setTimeout(function () {   // after the click handler re-rendered the group
      var host = seg.isConnected ? seg : null;   // re-rendered boards replace the group — find its successor in place
      if (!host) { var hit = document.elementFromPoint(segR.left + 6, segR.top + segR.height / 2); host = hit && hit.closest(SEG); }
      if (!host) return;
      var to = activeOf(host); if (!to) return;
      var tr = to.getBoundingClientRect(), hr = host.getBoundingClientRect();
      if (Math.abs(tr.left - fr.left) < 2 && Math.abs(tr.top - fr.top) < 2) return;
      if (Math.abs(tr.top - fr.top) > 4) return;   // wrapped tab rows: a diagonal slide reads as noise
      var g = document.createElement('span'); g.className = 'be-glide';
      g.style.cssText = 'left:' + (tr.left - hr.left - host.clientLeft) + 'px;top:' + (tr.top - hr.top - host.clientTop) + 'px;width:' + tr.width + 'px;height:' + tr.height + 'px;background:' + paint.bg + ';box-shadow:' + paint.sh + ';border-radius:' + paint.rad + ';border:' + paint.bd + ';box-sizing:border-box';
      host.classList.add('be-glide-host'); host.appendChild(g); to.classList.add('be-glide-to');
      var a = g.animate([{ transform: 'translate(' + (fr.left - tr.left) + 'px,' + (fr.top - tr.top) + 'px)', width: fr.width + 'px' }, { transform: 'none', width: tr.width + 'px' }],
        { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
      var end = function () { g.remove(); to.classList.remove('be-glide-to'); if (!host.querySelector('.be-glide')) host.classList.remove('be-glide-host'); };
      a.onfinish = end; a.oncancel = end; setTimeout(end, 500);
      // the tab's content is the thing that changed — let it arrive, not pop
      var panel = to.getAttribute('aria-controls') && document.getElementById(to.getAttribute('aria-controls'));
      if (panel) once(panel, 'be-pane-in');
    }, 0);
  }, true);

  // ════ peek ═══════════════════════════════════════════════════════════════
  var peek = null, peekFor = null, peekT = 0;
  function peekHide() { clearTimeout(peekT); if (peek) { peek.remove(); peek = null; } if (peekFor) { peekFor.removeAttribute('aria-describedby'); peekFor = null; } }
  function peekShow(el, x) {
    var txt = el.getAttribute('data-be-peek'); if (!txt) return;
    peekHide(); peekFor = el;
    peek = document.createElement('div'); peek.className = 'be-peek lg-skip'; peek.id = 'be-peek'; peek.setAttribute('role', 'tooltip');
    // "Label: text" lines become small headings
    peek.innerHTML = txt.split('\n\n').map(function (part) {
      var m = part.match(/^([A-Z][\w ]{1,24}):\s([\s\S]*)$/);
      var e = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
      return m ? '<b>' + e(m[1]) + '</b>' + e(m[2]) : e(part);
    }).join('<br>');
    document.body.appendChild(peek);
    el.setAttribute('aria-describedby', 'be-peek');
    var r = el.getBoundingClientRect(), pw = peek.offsetWidth, ph = peek.offsetHeight;
    var left = Math.min(Math.max(8, (x == null ? r.left + 16 : x - 24)), innerWidth - pw - 8);
    var top = r.bottom + 6;
    if (top + ph > innerHeight - 8) { top = r.top - ph - 6; peek.classList.add('be-up'); }
    peek.style.left = left + 'px'; peek.style.top = Math.max(8, top) + 'px';
  }
  document.addEventListener('pointerover', function (e) {
    if (e.pointerType !== 'mouse') return;
    var el = e.target.closest && e.target.closest('[data-be-peek]');
    if (!el) { if (peekFor && !peekFor.contains(e.target)) peekHide(); return; }
    if (el === peekFor) return;
    clearTimeout(peekT); var x = e.clientX;
    peekT = setTimeout(function () { if (el.matches(':hover')) peekShow(el, x); }, 420);
  });
  document.addEventListener('focusin', function (e) { var el = e.target.closest && e.target.closest('[data-be-peek]'); if (el && el === e.target && el.matches(':focus-visible')) peekShow(el); else peekHide(); });
  document.addEventListener('focusout', function (e) { if (peekFor && e.target === peekFor) peekHide(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && peek) { peekHide(); } }, true);
  document.addEventListener('pointerdown', peekHide, true);
  window.addEventListener('scroll', function () { if (peek) peekHide(); }, { passive: true, capture: true });

  // ════ disclose: long notes ════════════════════════════════════════════════
  var CLAMP = '.aw-note, .wa-desc, [data-be-clamp]';
  var CHEV = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var cid = 0;
  function clamp(el) {
    if (el.__beClamp || !vis(el)) return;
    el.__beClamp = 1; el.classList.add('be-clamp');
    if (el.scrollHeight <= el.clientHeight + 2) { el.classList.remove('be-clamp'); return; }
    if (!el.id) el.id = 'be-clamp-' + (++cid);
    var b = document.createElement('button'); b.type = 'button'; b.className = 'be-more-btn';
    b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', el.id); b.innerHTML = 'Show more' + CHEV;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !el.classList.contains('be-open'), h0 = el.getBoundingClientRect().height;
      el.classList.toggle('be-open', open);
      b.setAttribute('aria-expanded', String(open)); b.innerHTML = (open ? 'Show less' : 'Show more') + CHEV;
      if (!RM.matches && el.animate) { var h1 = el.getBoundingClientRect().height; el.animate([{ height: h0 + 'px', opacity: .85 }, { height: h1 + 'px', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' }); }
    });
    el.insertAdjacentElement('afterend', b);
  }

  // ════ rows: Work Assignment boards ════════════════════════════════════════
  function rows(root) {
    var list = root.querySelectorAll ? root.querySelectorAll('.bw-row[data-id]:not([tabindex])') : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i]; r.tabIndex = 0; r.setAttribute('role', 'button');
      var t = r.querySelector('.bw-tt b'); if (t) r.setAttribute('aria-label', 'Open task: ' + t.textContent.trim());
    }
  }
  document.addEventListener('keydown', function (e) {
    if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches || !e.target.matches('.bw-row[data-id]')) return;
    e.preventDefault(); e.target.click();
  });

  // ════ observe ════════════════════════════════════════════════════════════
  var pending = new Set(), flushQ = false;
  function flush() {
    flushQ = false;
    pending.forEach(function (n) { if (n.isConnected) { sweep(n); rows(n); } });
    pending.clear();
    var c = document.querySelectorAll(CLAMP); for (var i = 0; i < c.length; i++) clamp(c[i]);
  }
  // a timer, not rAF: background tabs must still tag rows / clamp notes before they're shown
  function queue(n) { if (n && n.nodeType === 1) { pending.add(n); if (!flushQ) { flushQ = true; setTimeout(flush, 16); } } }
  function start() {
    // what is visible at load counts as already shown: nothing animates on first paint
    document.querySelectorAll(PANE + ',' + POP + ',' + OVL).forEach(function (el) { shown.set(el, vis(el)); });
    Array.prototype.forEach.call(document.body.children, function (el) { shown.set(el, vis(el)); });
    rows(document.body); queue(document.body);
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) queue(m.addedNodes[j]); }
        else if (m.attributeName !== 'data-lg' && !/^be-/.test(String(m.target.className).split(' ').pop() || '')) queue(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.BEMotion = {
    ok: function (btn) { if (btn) once(btn, 'be-ok-flash'); },
    refresh: function (el) { queue(el || document.body); }
  };
})();
