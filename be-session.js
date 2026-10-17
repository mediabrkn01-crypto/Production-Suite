/* ════════════════════════════════════════════════════════════════════════════
   BESession — the server-verifiable side of the normal ERP login.

   index.html's portal login calls BESession.issue(identifier, password) right after its
   own successful sign-in; the `erp-session` edge function repeats the same password +
   HR access check on the server and returns a signed token. It is stored per account
   (account switching keeps each account's token) on this origin, so every portal —
   Media, HR, Academics, Sales, Manager — shares it. Logout clears it.

   Features that need a trustworthy identity (Jarvis) send BESession.token(email) as the
   `x-erp-session` header. The token carries identity only; access is re-resolved from HR
   on the server for every request.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BESession) return;
  var URL_ = 'https://fevqnpllmarhoqdzpatq.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZldnFucGxsbWFyaG9xZHpwYXRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1OTI1MjgsImV4cCI6MjA5NzE2ODUyOH0.23qi1hDcOA19W2psdIiP2ucypkymG7BZzcTrt2Q2ZSA';
  var KEY = 'be_erp_sessions';

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; } }
  function save(m) { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (_) {} }
  function norm(e) { return String(e || '').trim().toLowerCase(); }

  /** The email of whoever is signed in to this portal right now. */
  function currentEmail() {
    try { if (typeof activeEmail !== 'undefined' && activeEmail) return norm(activeEmail); } catch (_) {}
    try { var a = localStorage.getItem('be_active_email'); if (a) return norm(a); } catch (_) {}
    try { var s = JSON.parse(localStorage.getItem('be_media_academic_session') || 'null'); if (s && s.email) return norm(s.email); } catch (_) {}
    return '';
  }

  var inflight = {};
  window.BESession = {
    url: URL_, anonKey: ANON,
    currentEmail: currentEmail,
    /** Called by the ERP login after its own check succeeds. Never blocks the login. */
    issue: function (identifier, password) {
      var p = fetch(URL_ + '/functions/v1/erp-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON, 'Authorization': 'Bearer ' + ANON },
        body: JSON.stringify({ identifier: identifier, password: password })
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j || !j.token) return null;
        var m = load(); m[norm(j.email)] = { t: j.token, exp: j.exp }; save(m);
        return j.token;
      }).catch(function () { return null; });
      window.BESession.pending = p;
      return p;
    },
    /** Wait (max ms) for a token request started by the login, so a redirect right after
     *  sign-in (manager / sales / academics routing) can't cancel it mid-flight. */
    ready: function (ms) {
      var p = window.BESession.pending;
      if (!p) return Promise.resolve();
      return Promise.race([p, new Promise(function (r) { setTimeout(r, ms || 4000); })]).then(function () { window.BESession.pending = null; });
    },
    /** Valid token for this account (default: the signed-in one), or null. */
    token: function (email) {
      var e = norm(email || currentEmail()), m = load(), s = m[e];
      if (!s || !s.t || (s.exp && s.exp * 1000 < Date.now())) return null;
      return s.t;
    },
    /** Valid token for this account, re-issued when missing or about to expire.
     *  The login form is the only place a token used to be created, so an account reached
     *  through the account switcher, a sign-in older than the token's 30 days, or one made
     *  before tokens existed had none — and every server-checked feature (Aura, Content
     *  Calendar, Jarvis) failed with "session expired". The switcher already keeps that
     *  account's credentials on this device (be_saved_accounts); we re-run the same server
     *  sign-in with them. Resolves to the token or null (then the user must sign in). */
    ensure: function (email) {
      var e = norm(email || currentEmail());
      if (!e) return Promise.resolve(null);
      var m = load(), s = m[e];
      if (s && s.t && (!s.exp || s.exp * 1000 > Date.now() + 3 * 86400000)) return Promise.resolve(s.t);
      if (inflight[e]) return inflight[e];
      var acc = null;
      try { acc = (JSON.parse(localStorage.getItem('be_saved_accounts') || '[]') || []).filter(function (a) { return a && norm(a.email) === e && a.pass; })[0] || null; } catch (_) {}
      var still = s && s.t && (!s.exp || s.exp * 1000 > Date.now()) ? s.t : null;
      if (!acc) return Promise.resolve(still);
      inflight[e] = window.BESession.issue(acc.email, acc.pass)
        .then(function (t) { return t || still; })
        .finally(function () { delete inflight[e]; });
      return inflight[e];
    },
    clear: function (email) {
      var m = load();
      if (email) delete m[norm(email)]; else m = {};
      save(m);
    }
  };
  // Self-heal on every portal load (and after an account switch in another tab) so the token
  // is ready before Aura / Calendar / Jarvis need it.
  setTimeout(function () { window.BESession.ensure().catch(function () {}); }, 1500);
  window.addEventListener('storage', function (ev) { if (ev.key === 'be_active_email') window.BESession.ensure().catch(function () {}); });
})();
