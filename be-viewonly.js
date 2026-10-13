/* ============================================================================
   BEViewOnly — view-only mode for department pages opened inside HR → Company Suite.

   Active only when this page is inside a frame named "be-view-company" (set by HR's Company
   Suite; a frame's name survives the pages scrubbing their URL and in-frame reloads, and is
   private to that one frame — Manager's frames and normal tabs are never affected). Loaded right
   after supabase-js and before any page code, it wraps supabase.createClient so every client
   the page makes is READ-ONLY:
     • from(table).insert / update / upsert / delete  → refused (no request is sent)
     • storage uploads / removals, edge-function calls → refused
     • database functions that change data (clock, enrol, complete batch, reassign …) → refused
     • reads, realtime and read RPCs work normally (same live data as the department itself)
   A refused change returns { error } like any failed save, and a short notice is shown.
   Nothing here can widen access: it only removes the ability to write.
   ============================================================================ */
(function () {
  'use strict';
  var inFrame = false;
  try { inFrame = window.self !== window.top; } catch (_) { inFrame = true; }
  var on = inFrame && window.name === 'be-view-company';
  if (!on) return;
  window.BE_VIEW_ONLY = true;

  var MSG = 'View only — Company Suite. Changes can be made from the department\'s own page by someone with access.';
  var lastNote = 0;
  function note() {
    if (Date.now() - lastNote < 3000) return; lastNote = Date.now();
    try { if (typeof window.showToast === 'function') window.showToast('warning', MSG); } catch (_) {}
  }
  function refused() {
    note();
    var res = { data: null, error: { message: MSG, code: 'VIEW_ONLY' }, count: null, status: 403, statusText: 'View only' };
    // A chainable stand-in for a query builder: .eq().select().single() … all return itself,
    // and awaiting it yields the refusal.
    var p = new Proxy(function () {}, {
      get: function (_, k) {
        if (k === 'then') return function (a, b) { return Promise.resolve(res).then(a, b); };
        if (k === 'catch') return function (f) { return Promise.resolve(res).catch(f); };
        if (k === 'finally') return function (f) { return Promise.resolve(res).finally(f); };
        return function () { return p; };
      },
      apply: function () { return p; }
    });
    return p;
  }
  function lock(client) {
    if (!client || client.__beViewOnly) return client;
    client.__beViewOnly = true;
    var from = client.from.bind(client);
    client.from = function (t) {
      var q = from(t);
      ['insert', 'update', 'upsert', 'delete'].forEach(function (m) { q[m] = function () { return refused(); }; });
      return q;
    };
    // Database functions that CHANGE data (clock in/out, enrol, complete batch, reassign …);
    // read-only ones (availability, matching, paging, overviews) keep working.
    var WRITE_RPC = /^(be_clock|complete_batch|enroll_student_in_batch|unenroll_student_from_batch|media_reassign_work)$|(^|_)(set|save|update|insert|delete|remove|create|mark|publish|enrol|enroll|assign|reassign|approve|reject|complete|clock|send)(_|$)/i;
    if (client.rpc) {
      var rpc = client.rpc.bind(client);
      client.rpc = function (fn) { return WRITE_RPC.test(String(fn || '')) ? refused() : rpc.apply(client, arguments); };
    }
    if (client.storage && client.storage.from) {
      var sfrom = client.storage.from.bind(client.storage);
      client.storage.from = function (b) {
        var api = sfrom(b);
        ['upload', 'update', 'remove', 'move', 'copy', 'uploadToSignedUrl'].forEach(function (m) { if (api[m]) api[m] = function () { return refused(); }; });
        return api;
      };
    }
    // `functions` is a getter that builds a fresh client each time — replace the property itself.
    try { Object.defineProperty(client, 'functions', { configurable: true, get: function () { return { invoke: function () { return refused(); }, setAuth: function () {} }; } }); } catch (_) {}
    return client;
  }
  if (window.supabase && window.supabase.createClient) {
    var create = window.supabase.createClient;
    try { window.supabase.createClient = function () { return lock(create.apply(this, arguments)); }; } catch (_) {}
  }

  // Visible cue inside the page.
  function banner() {
    if (document.getElementById('be-viewonly-bar')) return;
    var b = document.createElement('div'); b.id = 'be-viewonly-bar';
    b.textContent = 'View only · Company Suite';
    b.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;padding:4px 12px;border-radius:999px;font:700 10.5px Inter,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#c4b5fd;background:rgba(20,16,32,.92);border:1px solid rgba(167,139,250,.4);pointer-events:none';
    document.body.appendChild(b);
    document.documentElement.classList.add('be-viewonly');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner); else banner();

  // Who may view: the HR-granted per-person permission (hr_employees.access_company_suite) or
  // the existing HR-admin access — System Role 'hr_admin', or the HR admin login (user_roster
  // role 'admin'). Exited / inactive people never qualify. Returns { ok, name, rec }.
  async function verify(db, email) {
    var e = String(email || '').trim().toLowerCase(); if (!e || !db) return { ok: false };
    var hr = await db.from('hr_employees').select('*').eq('portal_email', e);
    var rows = (hr && hr.data) || [];
    var live = rows.filter(function (r) { var st = String(r.employment_status || 'active').toLowerCase(); return st !== 'inactive' && st !== 'exited'; });
    if (rows.length && !live.length) return { ok: false };
    var rec = live.find(function (r) { return r.access_company_suite === true || String(r.system_role || '').toLowerCase() === 'hr_admin'; });
    if (rec) return { ok: true, name: rec.full_name || e, rec: rec };
    try {
      var ur = await db.from('user_roster').select('name,email,role');
      var u = ((ur && ur.data) || []).find(function (x) { return String(x.email || '').trim().toLowerCase() === e && String(x.role || '').toLowerCase() === 'admin'; });
      if (u) return { ok: true, name: u.name || e, rec: live[0] || null };
    } catch (_) {}
    return { ok: false };
  }

  window.BEViewOnly = { active: true, lock: lock, verify: verify };
})();
