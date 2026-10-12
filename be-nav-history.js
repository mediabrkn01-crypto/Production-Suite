/* ============================================================================
   BENavHistory — Back / Forward for the ERP's in-page navigation (all portals:
   index / Media, HR, Academic, Sales, Manager). Shared; no page logic changes.

   Before this, switching tabs or opening a popup added NO browser history, so the
   phone's Back button left the whole page — and since every portal is opened from the
   login page, Back landed on the password screen and looked like a logout.

   What it does (and only this — it never reads, clears or touches any session/auth):
     • Each page's own tab function (acadSwitchTab, switchHRSubtab, switchTab, mgrSection)
       is wrapped: a real tab change pushes ONE history entry {be:1, tab} with #tab in the
       URL; re-showing the same tab only replaces it (no duplicates, no 10× Back).
     • Opening a popup/sheet pushes one entry; Back closes the TOPMOST popup first (via its
       own Close/Cancel button, so the page's own close logic runs). Closing a popup with
       its button quietly removes that entry again.
     • Back with no popup open returns to the previous tab; Forward re-opens the next one.
     • Refresh: the #tab in the URL is restored once the app is showing (only tabs whose
       nav link this user can actually see).
   ============================================================================ */
(function () {
  'use strict';
  if (window.BENavHistory) return;

  var TAB_FNS = ['acadSwitchTab', 'switchHRSubtab', 'mgrSection', 'switchTab'];
  // Every popup/sheet style used across the ERP.
  var OVERLAYS = '.modal-bg, .hr-modal-overlay, .acadx-modal-bg, .mw-modal-bg, #be-confirm-overlay, .be-msheet-bg[data-open], .jv-sheet-bg, [id$="-modal"].fixed, [role="dialog"][aria-modal="true"]';

  var fnName = null, orig = null, curTab = null, restoring = false, ignorePops = 0, booted = false, openCount = 0;

  function state() { return history.state && history.state.be ? history.state : null; }
  function urlFor(tab) { return location.pathname + location.search + (tab ? '#' + encodeURIComponent(tab) : ''); }

  // ── popups ──
  function isOpen(el) {
    if (!el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0;
  }
  function openOverlays() {
    var list = [].slice.call(document.querySelectorAll(OVERLAYS)).filter(isOpen);
    // a dialog nested inside an open overlay is the same popup
    return list.filter(function (el) { return !list.some(function (o) { return o !== el && o.contains(el); }); });
  }
  function topmost(list) {
    var best = null, bz = -Infinity;
    list.forEach(function (el, i) { var z = parseInt(getComputedStyle(el).zIndex, 10); z = isNaN(z) ? 0 : z; if (z > bz || (z === bz)) { bz = z; best = el; } });
    return best;
  }
  function closeOverlay(el) {
    if (el.matches('.be-msheet-bg')) { el.removeAttribute('data-open'); return; }
    var btns = [].slice.call(el.querySelectorAll('button, [role="button"], a')).filter(function (b) {
      if (!b.getClientRects().length) return false;
      var on = (b.getAttribute('onclick') || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.id || '') + ' ' + (b.className || '');
      var tx = (b.textContent || '').trim();
      return /close|cancel|dismiss/i.test(on) || /^(✕|×|x|close|cancel|back|no|not now)$/i.test(tx) || /^✕\s*close$/i.test(tx);
    });
    if (btns.length) { btns[0].click(); if (!isOpen(el)) return; }
    // fallback: the page's own class conventions for "closed" (.on / .flex vs .hidden) — never an
    // inline display:none, which would stop the page from opening this popup again later.
    el.classList.remove('on', 'flex'); el.classList.add('hidden');
  }

  function watchOverlays() {
    var t = null;
    new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var n = openOverlays().length;
        if (n > openCount) {
          for (var i = openCount; i < n; i++) history.pushState({ be: 1, tab: curTab, modal: i + 1 }, '', urlFor(curTab));
        } else if (n < openCount) {
          // Closed with its own button: quietly step back over the entries we pushed for it, so
          // the next Back goes to the previous tab instead of doing nothing.
          var s = state(), drop = s && s.modal ? Math.min(openCount - n, s.modal) : 0;
          if (drop) { ignorePops++; history.go(-drop); }
        }
        openCount = n;
      }, 60);
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-open', 'hidden'] });
  }

  // ── tabs ──
  function goTab(tab) { if (!orig || tab == null || tab === curTab) return; restoring = true; try { orig.call(window, tab); } finally { restoring = false; } curTab = tab; }
  function navLinkVisible(tab) {
    var q = '[onclick*="(\'' + tab + '\'"],[onclick*="(&quot;' + tab + '&quot;"],[data-sec="' + tab + '"],[data-tab="' + tab + '"]';
    return [].some.call(document.querySelectorAll(q), function (el) { return el.getClientRects().length > 0; });
  }
  function wrap() {
    for (var i = 0; i < TAB_FNS.length; i++) { if (typeof window[TAB_FNS[i]] === 'function') { fnName = TAB_FNS[i]; break; } }
    if (!fnName || window[fnName].__beNav) return !!fnName;
    orig = window[fnName];
    var wrapped = function (tab) {
      var r = orig.apply(this, arguments);
      if (restoring || typeof tab !== 'string' || !tab) return r;
      var s = state();
      if (!booted || (s && s.tab === tab && !s.modal) || tab === curTab) history.replaceState({ be: 1, tab: tab }, '', urlFor(tab));
      else history.pushState({ be: 1, tab: tab }, '', urlFor(tab));
      curTab = tab;
      if (!booted) { booted = true; restoreFromHash(); }
      return r;
    };
    wrapped.__beNav = true;
    window[fnName] = wrapped;
    return true;
  }
  var hashTab = decodeURIComponent((location.hash || '').slice(1)) || null;
  function restoreFromHash() {
    if (!hashTab) return;
    var want = hashTab; hashTab = null;
    // wait until the app shell (and this user's permitted nav) is actually showing
    var tries = 0, iv = setInterval(function () {
      if (++tries > 40) { clearInterval(iv); return; }
      if (want === curTab) { clearInterval(iv); return; }
      if (navLinkVisible(want)) { clearInterval(iv); window[fnName](want); history.replaceState({ be: 1, tab: want }, '', urlFor(want)); }
    }, 250);
  }

  window.addEventListener('popstate', function (e) {
    if (ignorePops > 0) { ignorePops--; return; }
    var open = openOverlays();
    if (open.length) {
      // Back with a popup open → close the top popup only; stay on this tab.
      openCount = open.length - 1;
      closeOverlay(topmost(open));
      var s = state();
      if (s && s.tab && s.tab !== curTab && !s.modal) goTab(s.tab);
      return;
    }
    var st = e.state && e.state.be ? e.state : null;
    if (st && st.tab) goTab(st.tab);
  });

  function boot() {
    if (!wrap()) { setTimeout(boot, 300); return; }
    watchOverlays();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.BENavHistory = { current: function () { return curTab; } };
})();
