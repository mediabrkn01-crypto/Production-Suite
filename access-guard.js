/* ============================================================================
 * access-guard.js — one portal-access rule for every portal (index, HR, Sales,
 * Academics, Manager).
 *
 * The answer comes from the database (rpc portal_access_state, built on
 * hr_employees.employment_status + portal_access_enabled). It is asked:
 *   - at sign-in            BEAccess.state(email)
 *   - when a page opens     (any saved session on this device)
 *   - during an open session, every 60s and whenever the tab becomes visible
 * When the answer is "blocked", every saved session key is cleared and the
 * browser goes back to the sign-in screen with the reason, so an employee who
 * is exited/made inactive cannot keep using an already-open page.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.BEAccess) return;
  var SESSION_KEYS = ['be_active_user', 'be_active_role', 'be_active_email', 'be_media_academic_session', 'be_session'];
  var INTERVAL = 60000;

  function cfg() {
    var u = typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : null;
    var k = typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : (typeof SUPABASE_KEY !== 'undefined' ? SUPABASE_KEY : null);
    return u && k ? { u: u, k: k } : null;
  }
  function headers(c) { return { apikey: c.k, Authorization: 'Bearer ' + c.k, 'Content-Type': 'application/json' }; }

  // Same rule as the SQL function — used only if the function isn't deployed yet.
  function ruleFromRow(r) {
    if (!r) return { allowed: true, reason: 'no_hr_record' };
    if (r.account_type === 'system') return { allowed: true, reason: 'system' };
    var st = String(r.employment_status || 'active').toLowerCase();
    if (st === 'exited') return { allowed: false, reason: 'exited', message: 'Your employment has ended, so portal access is closed. Contact HR if this is a mistake.' };
    if (st === 'inactive') return { allowed: false, reason: 'inactive', message: 'Your employee account is inactive, so sign-in is disabled. Contact HR.' };
    if (r.portal_access_enabled === false) return { allowed: false, reason: 'disabled', message: 'HR has disabled your portal access. Contact HR for assistance.' };
    return { allowed: true, reason: 'active' };
  }

  async function state(email) {
    email = String(email || '').trim().toLowerCase();
    if (!email || email.indexOf('@') < 0) return { allowed: true, reason: 'no_identity' };
    var c = cfg(); if (!c) return { allowed: true, reason: 'unknown' };
    try {
      var res = await fetch(c.u + '/rest/v1/rpc/portal_access_state', { method: 'POST', headers: headers(c), body: JSON.stringify({ p_email: email }) });
      if (res.ok) { var j = await res.json(); if (j && typeof j.allowed === 'boolean') return j; }
      if (res.status !== 404) return { allowed: true, reason: 'unknown' }; // network/server hiccup: don't lock people out
    } catch (_) { return { allowed: true, reason: 'unknown' }; }
    try {
      var r2 = await fetch(c.u + '/rest/v1/hr_employees?select=employment_status,portal_access_enabled,account_type&portal_email=eq.' + encodeURIComponent(email), { headers: headers(c) });
      if (!r2.ok) return { allowed: true, reason: 'unknown' };
      var rows = await r2.json() || [];
      rows.sort(function (a, b) {
        var s = function (x) { return (x.account_type === 'system' ? 4 : 0) + (String(x.employment_status || 'active').toLowerCase() === 'active' ? 2 : 0) + (x.portal_access_enabled !== false ? 1 : 0); };
        return s(b) - s(a);
      });
      return ruleFromRow(rows[0]);
    } catch (_) { return { allowed: true, reason: 'unknown' }; }
  }

  function sessionEmails() {
    var out = [];
    try { var a = localStorage.getItem('be_active_email'); if (a) out.push(a); } catch (_) {}
    try { var m = JSON.parse(localStorage.getItem('be_media_academic_session') || 'null'); if (m && m.email) out.push(m.email); } catch (_) {}
    try { var s = JSON.parse(localStorage.getItem('be_session') || 'null'); if (s && s.u) out.push(s.u); } catch (_) {}
    return out.map(function (x) { return String(x).trim().toLowerCase(); }).filter(function (x, i, arr) { return x && arr.indexOf(x) === i; });
  }

  function revoke(email, info) {
    SESSION_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (_) {} });
    // Saved "switch account" entries for this login must not bring the session back.
    try {
      var raw = localStorage.getItem('be_saved_accounts');
      if (raw) { var list = JSON.parse(raw) || []; localStorage.setItem('be_saved_accounts', JSON.stringify(list.filter(function (a) { return String(a.email || '').toLowerCase() !== email; }))); }
    } catch (_) {}
    try { sessionStorage.setItem('be_access_msg', (info && info.message) || 'Your portal access has been disabled. Contact HR.'); } catch (_) {}
    location.replace('index.html?access=' + encodeURIComponent((info && info.reason) || 'disabled'));
  }

  var busy = false;
  async function check() {
    if (busy) return true; busy = true;
    try {
      var emails = sessionEmails();
      for (var i = 0; i < emails.length; i++) {
        var st = await state(emails[i]);
        if (!st.allowed) { revoke(emails[i], st); return false; }
      }
      return true;
    } finally { busy = false; }
  }

  // Login-time gate: returns the state; never navigates.
  window.BEAccess = { state: state, check: check, takeMessage: function () { try { var m = sessionStorage.getItem('be_access_msg'); sessionStorage.removeItem('be_access_msg'); return m; } catch (_) { return null; } } };

  function start() {
    check();
    setInterval(check, INTERVAL);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);
})();
