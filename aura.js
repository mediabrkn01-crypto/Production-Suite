/* ════════════════════════════════════════════════════════════════════════════
   BEAura — Aura Points (employee recognition) for every portal.

   Data: aura_point_transactions / best_employee_selections (20261027_aura_points.sql).
   Reads go straight to the tables (read-only for the browser). EVERY write — award, Best
   Employee selection, reversal — goes through the `aura` edge function, which re-resolves
   the caller from the ERP sign-in and enforces the hierarchy. Totals are always the SUM of
   active transactions; nothing here ever writes a total.

   BEAura.mountProfile(el, employee, {self})   stat (lifetime · this month) + history
   BEAura.dashboard(el, {mode:'hr'|'manager'}) overview · ranking · Best Employee
   BEAura.give()                               "Give Aura Points" dialog (permission-scoped)
   BEAura.watch()                              live "+50 Aura Points" toast for the signed-in employee
   Aura is recognition only — never read by payroll, leave, attendance or performance code.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BEAura) return;
  var DIV = { education: 'Academics', production: 'Media / Production', sales: 'Sales', hr: 'HR', accounts: 'Accounts', management: 'Management', other: 'Administration' };
  var REASONS = ['Excellent class performance', 'Completed urgent work ahead of deadline', 'Excellent student feedback', 'Strong teamwork', 'Outstanding creative work', 'Consistent attendance', 'Went beyond assigned responsibility'];
  var S = { client: null, emps: null, empAt: 0, scope: null, scopeAt: 0, me: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function B() { return window.BESession || {}; }
  function db() {
    try { if (typeof dbInstance !== 'undefined' && dbInstance) return dbInstance; } catch (_) {}
    try { if (typeof sb !== 'undefined' && sb && sb.from) return sb; } catch (_) {}
    if (!S.client && window.supabase && B().url) S.client = window.supabase.createClient(B().url, B().anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    return S.client;
  }
  function toast(kind, msg) { if (typeof window.showToast === 'function') { try { return window.showToast(kind, msg); } catch (_) {} } pop(msg, kind === 'error'); }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function istToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
  function istDay(ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ts)); }
  function fDay(iso, year) { var d = new Date(String(iso).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? '' : d.toLocaleDateString('en-IN', year ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }); }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return (w[0] || '').toUpperCase(); }).join('') || '?'; }
  function uuid() { try { return crypto.randomUUID(); } catch (_) { return 'k' + Date.now() + Math.random().toString(36).slice(2); } }
  var MARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.4 5.6L20 9.3l-4.3 3.9 1.2 5.8L12 16.1 7.1 19l1.2-5.8L4 9.3l5.6-.7z"/></svg>';

  function css() {
    if (document.getElementById('aura-css')) return;
    var s = document.createElement('style'); s.id = 'aura-css';
    s.textContent = [
      '.au{--au:#ff8a3d;color:#e6e9f5;font-family:inherit}',
      '.au-stat{display:flex;align-items:center;gap:16px;flex-wrap:wrap}',
      '.au-num{display:flex;flex-direction:column;gap:2px;min-width:0;cursor:pointer;border:0;background:none;color:inherit;font:inherit;text-align:left;padding:0}',
      '.au-k{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#8b93b8}.au-k svg{color:var(--au)}',
      '.au-v{font-size:30px;font-weight:800;color:#fff;letter-spacing:-.02em;line-height:1.05;font-variant-numeric:tabular-nums}',
      '.au-sub{font-size:12px;color:#8b93b8;font-variant-numeric:tabular-nums}.au-sub b{color:#34d399;font-weight:700}',
      '.au-give{margin-left:auto;display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,138,61,.4);background:rgba(255,107,6,.08);color:#ffb37a;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap}',
      '.au-give:hover{background:rgba(255,107,6,.14);color:#fff}',
      '.au-hist[hidden]{display:none}.au-hist{margin-top:14px;border-top:1px solid rgba(255,255,255,.06);padding-top:6px;display:flex;flex-direction:column}',
      '.au-tx{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:2px 12px;align-items:start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.04)}',
      '.au-tx:last-child{border-bottom:0}.au-pts{font-weight:800;color:#fff;font-size:14px;font-variant-numeric:tabular-nums}.au-pts.neg{color:#f87171}',
      '.au-why{color:#e6e9f5;font-size:13px;font-weight:600;overflow-wrap:anywhere}.au-by{grid-column:2;color:#8b93b8;font-size:11.5px}.au-note{grid-column:2;color:#a5adcf;font-size:12px;font-style:italic}',
      '.au-when{color:#6b74a0;font-size:11.5px;white-space:nowrap}.au-tx.rev{opacity:.5}.au-tx.rev .au-why{text-decoration:line-through}',
      '.au-empty{padding:18px 0;color:#6b74a0;font-size:12.5px}',
      '.au-more{border:0;background:none;color:#8b93b8;font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:8px 0;text-align:left}.au-more:hover{color:#fff}',
      /* modal */
      '.au-ov{position:fixed;inset:0;z-index:9300;display:grid;place-items:center;padding:16px;background:rgba(3,5,9,.66);backdrop-filter:blur(4px)}',
      '.au-dlg{width:min(480px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:18px;background:#0e1222;border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 80px -20px rgba(0,0,0,.85);padding:20px 20px 18px;display:flex;flex-direction:column;gap:14px}',
      '.au-dlg h3{margin:0;font-size:17px;color:#fff;font-weight:800}.au-dlg .sub{margin:-8px 0 0;font-size:12px;color:#8b93b8}',
      '.au-f{display:flex;flex-direction:column;gap:6px}.au-f>span{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#6b74a0}.au-f>span b{color:#f87171}',
      '.au-in,.au .au-in{width:100%;box-sizing:border-box;height:38px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.08)!important;background:rgba(255,255,255,.03)!important;color:#fff;font:inherit;font-size:13px!important;outline:none}',
      'textarea.au-in{height:auto;min-height:60px;padding:9px 12px;resize:vertical;line-height:1.45}.au-in:focus{border-color:rgba(255,107,6,.55)!important}',
      '.au-pick{max-height:200px;overflow:auto;display:flex;flex-direction:column;gap:2px;margin-top:4px}',
      '.au-opt{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:10px;border:0;background:none;color:#e6e9f5;font:inherit;font-size:13px;cursor:pointer;text-align:left;width:100%}',
      '.au-opt:hover,.au-opt.on{background:rgba(255,107,6,.1)}.au-opt small{display:block;color:#6b74a0;font-size:11px}',
      '.au-av{width:30px;height:30px;border-radius:50%;flex-shrink:0;display:grid;place-items:center;font-size:11px;font-weight:800;color:#fff;background:linear-gradient(135deg,#2a3150,#1a1f35)}',
      '.au-chips{display:flex;gap:8px;flex-wrap:wrap}.au-chip{min-width:62px;height:40px;padding:0 14px;border-radius:11px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#c7cbe0;font:inherit;font-size:14px;font-weight:800;cursor:pointer;font-variant-numeric:tabular-nums}',
      '.au-chip.on{color:#fff;border-color:rgba(255,107,6,.6);background:rgba(255,107,6,.14)}',
      '.au-sugg{display:flex;flex-wrap:wrap;gap:6px}.au-sugg button{border:1px solid rgba(255,255,255,.08);background:none;color:#8b93b8;border-radius:999px;padding:4px 10px;font:inherit;font-size:11.5px;cursor:pointer}.au-sugg button:hover{color:#fff;border-color:rgba(255,255,255,.2)}',
      '.au-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
      '.au-btn{height:40px;padding:0 16px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#e6e9f5;font:inherit;font-size:13px;font-weight:700;cursor:pointer}',
      '.au-btn.pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f 55%,#ff0552)}.au-btn:disabled{opacity:.6;cursor:progress}',
      '.au-confirm{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.03)}.au-confirm span{color:#6b74a0}.au-confirm b{color:#fff;font-weight:600;overflow-wrap:anywhere}',
      '.au-err{color:#f87171;font-size:12.5px}',
      '.au-pop{position:fixed;left:50%;top:20px;z-index:9400;transform:translate(-50%,-12px);opacity:0;transition:all .22s ease;display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:14px;background:#11182a;border:1px solid rgba(255,138,61,.35);box-shadow:0 20px 50px -14px rgba(0,0,0,.8);color:#e6e9f5;max-width:calc(100vw - 24px)}',
      '.au-pop.on{transform:translate(-50%,0);opacity:1}.au-pop b{display:block;color:#fff;font-size:14.5px;font-variant-numeric:tabular-nums}.au-pop span{display:block;color:#a5adcf;font-size:12px}.au-pop svg{color:#ff8a3d;flex-shrink:0}',
      /* dashboard */
      '.aud{display:flex;flex-direction:column;gap:16px}',
      '.aud-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}.aud-top h2{margin:0;font-size:22px;font-weight:800;color:#fff}.aud-top p{margin:4px 0 0;color:#8b93b8;font-size:12.5px}',
      '.aud-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.aud-bar .au-in{width:auto;min-width:0;height:36px}.aud-bar .q{flex:1 1 200px}',
      '.aud-seg{display:inline-flex;padding:3px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)}',
      '.aud-seg button{border:0;background:none;color:#8b93b8;font:inherit;font-size:12px;font-weight:700;height:30px;padding:0 12px;border-radius:7px;cursor:pointer;white-space:nowrap}.aud-seg button.on{background:rgba(255,255,255,.08);color:#fff}',
      '.aud-tabs{display:flex;gap:4px;border-bottom:1px solid rgba(255,255,255,.07)}.aud-tabs button{border:0;background:none;color:#8b93b8;font:inherit;font-size:13px;font-weight:700;padding:10px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}.aud-tabs button.on{color:#fff;border-bottom-color:#ff6b06}',
      '.aud-tbl{width:100%;border-collapse:collapse;font-size:13px}.aud-tbl th{text-align:left;font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6b74a0;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07);white-space:nowrap;cursor:pointer;user-select:none}',
      '.aud-tbl td{padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.04);color:#c7cbe0;vertical-align:middle}.aud-tbl td.n{font-variant-numeric:tabular-nums;color:#fff;font-weight:700}.aud-tbl tr:hover td{background:rgba(255,255,255,.015)}',
      '.aud-who{display:flex;align-items:center;gap:10px;min-width:0}.aud-who b{color:#fff;font-weight:600}.aud-who small{display:block;color:#6b74a0;font-size:11px}',
      '.aud-rank{display:flex;flex-direction:column}.aud-r{display:grid;grid-template-columns:44px minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid rgba(255,255,255,.05)}',
      '.aud-r .pos{font-size:18px;font-weight:800;color:#6b74a0;font-variant-numeric:tabular-nums;text-align:center}.aud-r.top .pos{color:#ffb37a}',
      '.aud-r .pts{font-size:18px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums;text-align:right}.aud-r .pts small{display:block;font-size:10.5px;color:#6b74a0;font-weight:600}',
      '.aud-tie{font-size:10px;font-weight:800;letter-spacing:.06em;color:#fbbf24;border:1px solid rgba(251,191,36,.4);border-radius:999px;padding:1px 7px;margin-left:6px}',
      '.aud-sel{height:32px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,138,61,.4);background:rgba(255,107,6,.08);color:#ffb37a;font:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}',
      '.aud-best{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:linear-gradient(120deg,rgba(255,107,6,.08),rgba(255,255,255,.02));border:1px solid rgba(255,138,61,.25)}',
      '.aud-best .k{font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#ffb37a}.aud-best b{display:block;color:#fff;font-size:16px}.aud-best span{color:#8b93b8;font-size:12px}',
      '.aud-wrap{overflow-x:auto;border:1px solid rgba(255,255,255,.06);border-radius:14px}',
      '@media(max-width:700px){.aud-tbl thead{display:none}.aud-tbl,.aud-tbl tbody,.aud-tbl tr,.aud-tbl td{display:block;width:100%}.aud-tbl tr{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.05)}.aud-tbl td{padding:3px 0;border:0}.aud-tbl td[data-l]::before{content:attr(data-l) "  ";color:#6b74a0;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.aud-tbl td{text-align:left!important}.aud-tbl td.n{display:inline-block;width:auto;margin-right:16px}.aud-wrap{border:0}}',
      '@media(max-width:560px){.au-v{font-size:26px}.au-give{margin-left:0;width:100%;justify-content:center}.aud-r{grid-template-columns:32px minmax(0,1fr) auto;row-gap:8px}.aud-r .aud-sel{grid-column:2/-1;justify-self:start}.aud-seg{width:100%;display:grid;grid-template-columns:1fr 1fr;gap:3px}.aud-seg button{width:100%}.aud-bar .au-in{flex:1 1 140px}.au-acts .au-btn{flex:1}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── server calls (the only write path) ───────────────────────────────────
  async function api(action, body) {
    var tk = B().token ? B().token() : null;
    if (!tk) throw new Error('Your session has expired. Please sign in again.');
    var r = await fetch(B().url + '/functions/v1/aura', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': B().anonKey, 'Authorization': 'Bearer ' + B().anonKey, 'x-erp-session': tk },
      body: JSON.stringify(Object.assign({ action: action }, body || {})) });
    var j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(j.error || 'Aura Points is unavailable right now.');
    return j;
  }
  async function scope(force) {
    if (!force && S.scope && Date.now() - S.scopeAt < 60000) return S.scope;
    S.scope = await api('scope'); S.scopeAt = Date.now(); return S.scope;
  }

  // ── reads ──────────────────────────────────────────────────────────────
  async function employees() {
    if (S.emps && Date.now() - S.empAt < 120000) return S.emps;
    var r = await db().from('hr_employees').select('id,full_name,division,designation,employment_status,account_type,portal_email');
    S.emps = (r.data || []).filter(function (e) { return e.account_type !== 'system' && e.full_name; }); S.empAt = Date.now();
    return S.emps;
  }
  async function txFor(empId) {
    var r = await db().from('aura_point_transactions').select('*').eq('recipient_employee_id', empId).order('created_at', { ascending: false }).limit(200);
    if (r.error) throw r.error;
    return r.data || [];
  }
  async function allTx() {
    var out = [], from = 0;
    for (;;) {
      var r = await db().from('aura_point_transactions').select('id,recipient_employee_id,points,status,created_at,reason').eq('status', 'active').range(from, from + 999);
      if (r.error) throw r.error;
      out = out.concat(r.data || []); if (!r.data || r.data.length < 1000) break; from += 1000;
    }
    return out;
  }
  function sum(rows, from, to) {
    return rows.filter(function (t) { if (t.status !== 'active') return false; var d = istDay(t.created_at); return (!from || d >= from) && (!to || d <= to); })
      .reduce(function (s, t) { return s + Number(t.points || 0); }, 0);
  }
  function monthRange(offset) {
    var t = istToday(), y = +t.slice(0, 4), m = +t.slice(5, 7) - 1 + (offset || 0);
    var a = new Date(Date.UTC(y, m, 1)), b = new Date(Date.UTC(y, m + 1, 0));
    return { from: a.toISOString().slice(0, 10), to: b.toISOString().slice(0, 10), label: a.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }

  function pop(msg, bad, sub) {
    css();
    var el = document.createElement('div'); el.className = 'au-pop'; el.setAttribute('role', 'status');
    el.innerHTML = MARK + '<div><b>' + esc(msg) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>';
    if (bad) el.style.borderColor = 'rgba(248,113,113,.45)';
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    setTimeout(function () { el.classList.remove('on'); setTimeout(function () { el.remove(); }, 260); }, 3600);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Profile: Aura stat near the top + recognition history
  // ════════════════════════════════════════════════════════════════════════
  async function mountProfile(el, emp, opts) {
    if (!el || !emp) return; css(); opts = opts || {};
    el.classList.add('au');
    var rows;
    try { rows = await txFor(emp.id); }
    catch (e) { el.innerHTML = /aura_point|relation|schema cache/i.test(e.message || '') ? '' : '<div class="au-empty">Aura Points could not load.</div>'; return; }
    var life = sum(rows), m = monthRange(0), month = sum(rows, m.from, m.to), active = rows.filter(function (t) { return t.status === 'active'; });
    var canGive = false;
    if (opts.self) { try { var sc = await scope(); canGive = !!sc.can_award; } catch (_) {} }
    el.innerHTML = '<div class="au-stat"><button type="button" class="au-num" data-au-toggle aria-expanded="false" title="Show Aura history">'
      + '<span class="au-k">' + MARK + 'Aura Points</span><span class="au-v">' + life.toLocaleString('en-IN') + '</span>'
      + '<span class="au-sub">' + (month ? '<b>+' + month + '</b> this month' : 'No new points this month') + ' · ' + active.length + ' recognition' + (active.length === 1 ? '' : 's') + '</span></button>'
      + (canGive ? '<button type="button" class="au-give" data-au-give>' + MARK + 'Give Aura Points</button>' : '') + '</div>'
      + '<div class="au-hist" data-au-hist hidden>' + history(rows, opts) + '</div>';
    el.querySelector('[data-au-toggle]').onclick = function () {
      var h = el.querySelector('[data-au-hist]'); h.hidden = !h.hidden; this.setAttribute('aria-expanded', String(!h.hidden));
    };
    var g = el.querySelector('[data-au-give]'); if (g) g.onclick = function () { give({ onDone: function () { mountProfile(el, emp, opts); } }); };
    if (opts.openHistory) el.querySelector('[data-au-hist]').hidden = false;
  }
  function history(rows, opts) {
    if (!rows.length) return '<div class="au-empty">' + (opts.self ? 'No Aura Points yet — recognitions from your Head or Manager will appear here.' : 'No Aura Points yet.') + '</div>';
    var show = rows.slice(0, opts.limit || 12);
    return show.map(function (t) {
      var rev = t.status === 'reversed', neg = Number(t.points) < 0;
      return '<div class="au-tx' + (rev ? ' rev' : '') + '"><span class="au-pts' + (neg ? ' neg' : '') + '">' + (neg ? '' : '+') + t.points + '</span><span class="au-why">' + esc(t.reason) + (t.kind === 'adjustment' ? ' <span style="color:#6b74a0;font-weight:500">(adjustment)</span>' : '') + '</span><span class="au-when">' + esc(fDay(istDay(t.created_at))) + '</span>'
        + '<span class="au-by">Awarded by ' + esc(t.awarded_by_name || '—') + (rev ? ' · reversed' + (t.reversal_reason ? ': ' + esc(t.reversal_reason) : '') : '') + '</span>'
        + (t.note ? '<span class="au-note">“' + esc(t.note) + '”</span>' : '') + '</div>';
    }).join('') + (rows.length > show.length ? '<div class="au-empty">+ ' + (rows.length - show.length) + ' earlier recognitions</div>' : '');
  }

  // ════════════════════════════════════════════════════════════════════════
  // Give Aura Points (employee list + point options come from the server scope)
  // ════════════════════════════════════════════════════════════════════════
  async function give(opts) {
    css(); opts = opts || {};
    var sc;
    try { sc = await scope(true); } catch (e) { return toast('error', e.message); }
    if (!sc.can_award) return toast('error', sc.tier === 'employee' ? 'Your role can\'t give Aura Points.' : 'There is no one in your team you can give Aura Points to.');
    var st = { emp: opts.employeeId ? sc.eligible.filter(function (x) { return x.id === opts.employeeId; })[0] || null : null, pts: null, reason: '', note: '', key: uuid(), busy: false };
    var ov = document.createElement('div'); ov.className = 'au-ov au';
    ov.innerHTML = '<div class="au-dlg" role="dialog" aria-modal="true" aria-label="Give Aura Points"></div>';
    document.body.appendChild(ov);
    var dlg = ov.querySelector('.au-dlg');
    var close = function () { ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape' && !st.busy) close(); };
    document.addEventListener('keydown', key);
    ov.addEventListener('click', function (e) { if (e.target === ov && !st.busy) close(); });
    function list(q) {
      q = String(q || '').toLowerCase();
      var l = sc.eligible.filter(function (x) { return !q || x.name.toLowerCase().indexOf(q) > -1 || String(x.department).toLowerCase().indexOf(q) > -1 || String(x.designation).toLowerCase().indexOf(q) > -1; });
      return l.length ? l.slice(0, 60).map(function (x) { return '<button type="button" class="au-opt' + (st.emp && st.emp.id === x.id ? ' on' : '') + '" data-emp="' + x.id + '"><span class="au-av">' + esc(initials(x.name)) + '</span><span><span>' + esc(x.name) + '</span><small>' + esc([x.designation, x.department].filter(Boolean).join(' · ')) + '</small></span></button>'; }).join('') : '<div class="au-empty">No one matches.</div>';
    }
    function form() {
      dlg.innerHTML = '<h3>Give Aura Points</h3><p class="sub">' + esc(sc.scope === 'organisation' ? 'Anyone in the organisation' : 'Your team · ' + sc.scope) + '</p>'
        + '<div class="au-f"><span>Employee <b>*</b></span>' + (st.emp
          ? '<button type="button" class="au-opt on" data-change><span class="au-av">' + esc(initials(st.emp.name)) + '</span><span><span>' + esc(st.emp.name) + '</span><small>' + esc([st.emp.designation, st.emp.department].filter(Boolean).join(' · ')) + ' · change</small></span></button>'
          : '<input class="au-in" data-q placeholder="Search by name, team or role" autocomplete="off"><div class="au-pick" data-list>' + list('') + '</div>') + '</div>'
        + '<div class="au-f"><span>Points <b>*</b></span><div class="au-chips">' + sc.points.map(function (p) { return '<button type="button" class="au-chip' + (st.pts === p ? ' on' : '') + '" data-pts="' + p + '">' + p + '</button>'; }).join('') + '</div></div>'
        + '<div class="au-f"><span>Reason <b>*</b></span><input class="au-in" data-reason maxlength="300" placeholder="What is this recognition for?" value="' + esc(st.reason) + '"><div class="au-sugg">' + REASONS.map(function (r) { return '<button type="button" data-sugg="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div></div>'
        + '<div class="au-f"><span>Note (optional)</span><textarea class="au-in" data-note maxlength="600" rows="2" placeholder="A short message to the employee">' + esc(st.note) + '</textarea></div>'
        + '<div class="au-err" data-err></div>'
        + '<div class="au-acts"><button type="button" class="au-btn" data-cancel>Cancel</button><button type="button" class="au-btn pri" data-next>Give Aura Points</button></div>';
      var q = dlg.querySelector('[data-q]');
      if (q) { q.addEventListener('input', function () { dlg.querySelector('[data-list]').innerHTML = list(q.value); }); setTimeout(function () { q.focus(); }, 30); }
      dlg.querySelector('[data-reason]').addEventListener('input', function () { st.reason = this.value; });
      dlg.querySelector('[data-note]').addEventListener('input', function () { st.note = this.value; });
    }
    function confirmView() {
      dlg.innerHTML = '<h3>Give ' + st.pts + ' Aura Points?</h3>'
        + '<div class="au-confirm"><span>Employee</span><b>' + esc(st.emp.name) + '</b><span>Points</span><b>+' + st.pts + '</b><span>Reason</span><b>' + esc(st.reason) + '</b>' + (st.note ? '<span>Note</span><b>' + esc(st.note) + '</b>' : '') + '</div>'
        + '<div class="au-err" data-err></div>'
        + '<div class="au-acts"><button type="button" class="au-btn" data-back>Back</button><button type="button" class="au-btn pri" data-confirm>Confirm</button></div>';
    }
    dlg.addEventListener('click', async function (e) {
      var b = e.target.closest('button'); if (!b || st.busy) return;
      if (b.hasAttribute('data-cancel')) return close();
      if (b.hasAttribute('data-emp')) { st.emp = sc.eligible.filter(function (x) { return x.id === b.getAttribute('data-emp'); })[0]; return form(); }
      if (b.hasAttribute('data-change')) { st.emp = null; return form(); }
      if (b.hasAttribute('data-pts')) { st.pts = +b.getAttribute('data-pts'); dlg.querySelectorAll('[data-pts]').forEach(function (x) { x.classList.toggle('on', x === b); }); return; }
      if (b.hasAttribute('data-sugg')) { st.reason = b.getAttribute('data-sugg'); dlg.querySelector('[data-reason]').value = st.reason; return; }
      if (b.hasAttribute('data-back')) return form();
      if (b.hasAttribute('data-next')) {
        st.reason = dlg.querySelector('[data-reason]').value.trim(); st.note = dlg.querySelector('[data-note]').value.trim();
        var err = !st.emp ? 'Choose an employee.' : !st.pts ? 'Choose the points.' : !st.reason ? 'Add a reason.' : '';
        if (err) { dlg.querySelector('[data-err]').textContent = err; return; }
        return confirmView();
      }
      if (b.hasAttribute('data-confirm')) {
        st.busy = true; b.disabled = true; b.textContent = 'Giving…';
        try {
          // Same key for every retry of THIS dialog → the server never records it twice.
          await api('award', { recipient_id: st.emp.id, points: st.pts, reason: st.reason, note: st.note || null, idempotency_key: st.key });
          close(); pop('+' + st.pts + ' Aura Points', false, 'Awarded to ' + st.emp.name);
          S.scopeAt = 0; if (opts.onDone) try { opts.onDone(); } catch (_) {}
          document.dispatchEvent(new CustomEvent('be-aura-changed'));
        } catch (x) { st.busy = false; b.disabled = false; b.textContent = 'Confirm'; dlg.querySelector('[data-err]').textContent = x.message; }
      }
    });
    form();
  }

  // ════════════════════════════════════════════════════════════════════════
  // HR / Manager dashboard: overview + ranking + Best Employee
  // ════════════════════════════════════════════════════════════════════════
  async function dashboard(el, opts) {
    if (!el) return; css(); opts = opts || {};
    var D = el._aura || (el._aura = { tab: 'rank', period: 'this', from: '', to: '', q: '', dept: '', sort: 'period' });
    el.classList.add('au');
    el.innerHTML = '<div class="au-empty">Loading Aura Points…</div>';
    var emps, rows, sc = null, best = [];
    try {
      var r = await Promise.all([employees(), allTx(), scope().catch(function () { return null; }), db().from('best_employee_selections').select('*').eq('status', 'active').order('selected_at', { ascending: false }).limit(24)]);
      emps = r[0]; rows = r[1]; sc = r[2]; best = (r[3] && r[3].data) || [];
    } catch (e) {
      el.innerHTML = '<div class="au-empty">' + (/aura_point|relation|schema cache/i.test(e.message || '') ? 'Aura Points needs the database update 20261027_aura_points.sql.' : 'Aura Points could not load.') + '</div>'; return;
    }
    var P = period(D), active = emps.filter(function (e) { return !['exited', 'inactive'].includes(String(e.employment_status || 'active').toLowerCase()); });
    var by = {};
    rows.forEach(function (t) {
      var x = by[t.recipient_employee_id] || (by[t.recipient_employee_id] = { life: 0, per: 0, n: 0, last: '' });
      x.life += Number(t.points || 0);
      var d = istDay(t.created_at);
      if ((!P.from || d >= P.from) && (!P.to || d <= P.to)) { x.per += Number(t.points || 0); x.n++; if (d > x.last) x.last = d; }
    });
    var list = active.map(function (e) { var x = by[e.id] || { life: 0, per: 0, n: 0, last: '' }; return { e: e, life: x.life, per: x.per, n: x.n, last: x.last }; })
      .filter(function (r) { return (!D.dept || r.e.division === D.dept) && (!D.q || (r.e.full_name + ' ' + (r.e.designation || '')).toLowerCase().indexOf(D.q.toLowerCase()) > -1); });
    var key = D.sort === 'life' ? 'life' : D.sort === 'name' ? 'name' : 'per';
    list.sort(function (a, b) { return key === 'name' ? a.e.full_name.localeCompare(b.e.full_name) : (b[key] - a[key]) || (b.life - a.life) || a.e.full_name.localeCompare(b.e.full_name); });
    var depts = Object.keys(DIV).filter(function (d) { return active.some(function (e) { return e.division === d; }); });
    var curBest = best.filter(function (b) { return b.period_start === P.from && b.period_end === P.to; })[0];

    el.innerHTML = '<div class="aud">'
      + '<div class="aud-top"><div><h2>Aura Points</h2><p>Recognition across the organisation · ' + esc(P.label) + '</p></div>'
      + (sc && sc.can_award ? '<button type="button" class="au-give" data-au-give style="margin-left:0">' + MARK + 'Give Aura Points</button>' : '') + '</div>'
      + '<div class="aud-bar"><div class="aud-seg" role="tablist">' + [['this', 'This month'], ['prev', 'Previous month'], ['custom', 'Custom'], ['all', 'All time']].map(function (p) { return '<button type="button" data-per="' + p[0] + '" class="' + (D.period === p[0] ? 'on' : '') + '">' + p[1] + '</button>'; }).join('') + '</div>'
      + (D.period === 'custom' ? '<input type="date" class="au-in" data-from value="' + esc(D.from) + '" aria-label="From"><input type="date" class="au-in" data-to value="' + esc(D.to) + '" aria-label="To">' : '') + '</div>'
      + '<div class="aud-bar"><input class="au-in q" data-q placeholder="Search employee or role" value="' + esc(D.q) + '"><select class="au-in" data-dept data-native><option value="">All departments</option>' + depts.map(function (d) { return '<option value="' + d + '"' + (D.dept === d ? ' selected' : '') + '>' + esc(DIV[d]) + '</option>'; }).join('') + '</select>'
      + '<select class="au-in" data-sort data-native><option value="period"' + (key === 'per' ? ' selected' : '') + '>Sort: points in period</option><option value="life"' + (key === 'life' ? ' selected' : '') + '>Sort: lifetime points</option><option value="name"' + (key === 'name' ? ' selected' : '') + '>Sort: name</option></select></div>'
      + '<div class="aud-tabs"><button type="button" data-tab="rank" class="' + (D.tab === 'rank' ? 'on' : '') + '">Best Employee · ranking</button><button type="button" data-tab="all" class="' + (D.tab === 'all' ? 'on' : '') + '">All employees</button></div>'
      + (D.tab === 'rank' ? rankHTML(list, P, sc, curBest) : tableHTML(list))
      + '</div>';
    wireDash(el, opts, list, P, sc);
  }
  function period(D) {
    if (D.period === 'prev') return monthRange(-1);
    if (D.period === 'all') return { from: '', to: '', label: 'All time' };
    if (D.period === 'custom') { var a = D.from || monthRange(0).from, b = D.to || istToday(); if (b < a) b = a; return { from: a, to: b, label: fDay(a, true) + ' – ' + fDay(b, true) }; }
    return monthRange(0);
  }
  function rankHTML(list, P, sc, curBest) {
    var ranked = list.filter(function (r) { return r.per > 0; }).sort(function (a, b) { return b.per - a.per || a.e.full_name.localeCompare(b.e.full_name); });
    // Standard competition ranking: equal points → equal rank, never broken at random.
    var pos = 0, prev = null;
    ranked.forEach(function (r, i) { if (r.per !== prev) { pos = i + 1; prev = r.per; } r.pos = pos; });
    var tieAt = {}; ranked.forEach(function (r) { tieAt[r.pos] = (tieAt[r.pos] || 0) + 1; });
    var canSel = sc && sc.can_select_best && P.from && P.to;
    var bestBox = curBest ? '<div class="aud-best">' + MARK.replace('14', '22').replace('14', '22') + '<div><div class="k">Best Employee · ' + esc(curBest.period_label || P.label) + '</div><b>' + esc(curBest.employee_name) + '</b><span>' + curBest.aura_points_during_period + ' Aura Points · selected by ' + esc(curBest.selected_by_name || '—') + ' on ' + esc(fDay(istDay(curBest.selected_at), true)) + '</span></div></div>' : '';
    if (!ranked.length) return bestBox + '<div class="au-empty">No Aura Points awarded in this period yet.</div>';
    return bestBox + (canSel ? '' : (P.from ? '' : '<div class="au-empty" style="padding:4px 0">Choose a month or custom range to select a Best Employee.</div>'))
      + '<div class="aud-rank">' + ranked.slice(0, 50).map(function (r) {
        var isBest = curBest && curBest.employee_id === r.e.id;
        return '<div class="aud-r' + (r.pos === 1 ? ' top' : '') + '"><span class="pos">' + r.pos + '</span>'
          + '<span class="aud-who"><span class="au-av">' + esc(initials(r.e.full_name)) + '</span><span><b>' + esc(r.e.full_name) + '</b>' + (tieAt[r.pos] > 1 ? '<span class="aud-tie">TIE</span>' : '') + '<small>' + esc([DIV[r.e.division] || r.e.division, r.e.designation].filter(Boolean).join(' · ')) + '</small></span></span>'
          + '<span class="pts">' + r.per + '<small>' + r.life + ' lifetime</small></span>'
          + (canSel ? (isBest ? '<span class="aud-tie" style="color:#34d399;border-color:rgba(52,211,153,.4)">SELECTED</span>' : '<button type="button" class="aud-sel" data-best="' + r.e.id + '" data-pts="' + r.per + '">Select as Best Employee</button>') : '<span></span>')
          + '</div>';
      }).join('') + '</div>';
  }
  function tableHTML(list) {
    if (!list.length) return '<div class="au-empty">No employees match.</div>';
    return '<div class="aud-wrap"><table class="aud-tbl"><thead><tr><th>Employee</th><th>Department</th><th>Designation</th><th style="text-align:right">Aura Points</th><th style="text-align:right">In period</th><th style="text-align:right">Awards</th><th>Latest</th></tr></thead><tbody>'
      + list.map(function (r) {
        return '<tr><td><span class="aud-who"><span class="au-av">' + esc(initials(r.e.full_name)) + '</span><b>' + esc(r.e.full_name) + '</b></span></td>'
          + '<td data-l="Department">' + esc(DIV[r.e.division] || r.e.division || '—') + '</td><td data-l="Designation">' + esc(r.e.designation || '—') + '</td>'
          + '<td class="n" data-l="Aura Points" style="text-align:right">' + r.life + '</td><td class="n" data-l="In period" style="text-align:right">' + (r.per ? '+' + r.per : '0') + '</td>'
          + '<td data-l="Awards" style="text-align:right">' + r.n + '</td><td data-l="Latest">' + (r.last ? esc(fDay(r.last, true)) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function wireDash(el, opts, list, P, sc) {
    var D = el._aura, re = function () { dashboard(el, opts); };
    el.onclick = async function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-per')) { D.period = b.getAttribute('data-per'); return re(); }
      if (b.hasAttribute('data-tab')) { D.tab = b.getAttribute('data-tab'); return re(); }
      if (b.hasAttribute('data-au-give')) return give({ onDone: re });
      if (b.hasAttribute('data-best')) {
        var r = list.filter(function (x) { return x.e.id === b.getAttribute('data-best'); })[0]; if (!r) return;
        var ok = typeof window.showConfirm === 'function'
          ? await showConfirm(r.e.full_name + ' · ' + r.per + ' Aura Points in ' + P.label + '. This records management\'s final pick for the period (a later pick replaces it, history is kept).', { title: 'Select as Best Employee?', confirmLabel: 'Select' })
          : await confirmBox('Select ' + r.e.full_name + ' as Best Employee for ' + P.label + '?');
        if (!ok) return;
        b.disabled = true;
        try { await api('select_best', { employee_id: r.e.id, period_start: P.from, period_end: P.to, period_label: P.label }); pop('Best Employee selected', false, r.e.full_name + ' · ' + P.label); re(); }
        catch (x) { b.disabled = false; toast('error', x.message); }
      }
    };
    var q = el.querySelector('[data-q]'); if (q) { var t; q.oninput = function () { clearTimeout(t); t = setTimeout(function () { D.q = q.value; re(); setTimeout(function () { var n = el.querySelector('[data-q]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 0); }, 300); }; }
    var dp = el.querySelector('[data-dept]'); if (dp) dp.onchange = function () { D.dept = dp.value; re(); };
    var so = el.querySelector('[data-sort]'); if (so) so.onchange = function () { D.sort = so.value; re(); };
    var f = el.querySelector('[data-from]'), to = el.querySelector('[data-to]');
    if (f) f.onchange = function () { D.from = f.value; re(); }; if (to) to.onchange = function () { D.to = to.value; re(); };
  }
  function confirmBox(msg) {
    return new Promise(function (res) {
      var ov = document.createElement('div'); ov.className = 'au-ov au';
      ov.innerHTML = '<div class="au-dlg"><h3>' + esc(msg) + '</h3><div class="au-acts"><button class="au-btn" data-n>Cancel</button><button class="au-btn pri" data-y>Confirm</button></div></div>';
      document.body.appendChild(ov);
      ov.querySelector('[data-n]').onclick = function () { ov.remove(); res(false); };
      ov.querySelector('[data-y]').onclick = function () { ov.remove(); res(true); };
    });
  }

  // ── live toast for the signed-in employee ──────────────────────────────────
  async function watch() {
    if (S.watching) return; S.watching = true;
    var email = B().currentEmail ? String(B().currentEmail() || '').toLowerCase() : '';
    if (!email || !db()) return;
    var r = await db().from('hr_employees').select('id').ilike('portal_email', email.replace(/[\\%_]/g, function (c) { return '\\' + c; })).limit(1);
    var me = r.data && r.data[0]; if (!me || !window.BELive) return;
    S.me = me.id;
    BELive.on('be-aura-me', [{ table: 'aura_point_transactions', filter: 'recipient_employee_id=eq.' + me.id, event: 'INSERT' }], function (evs) {
      (evs || []).forEach(function (p) {
        var n = p && p.new; if (!n || n.status !== 'active' || Number(n.points) <= 0) return;
        try { var seen = JSON.parse(localStorage.getItem('be_aura_seen') || '[]'); if (seen.indexOf(n.id) > -1) return; seen.push(n.id); localStorage.setItem('be_aura_seen', JSON.stringify(seen.slice(-50))); } catch (_) {}
        pop('+' + n.points + ' Aura Points', false, n.reason + (n.awarded_by_name ? ' — ' + n.awarded_by_name : ''));
      });
      document.dispatchEvent(new CustomEvent('be-aura-changed'));
    }, { debounce: 0 });
  }

  window.BEAura = { mountProfile: mountProfile, dashboard: dashboard, give: give, watch: watch, scope: scope };
  // Auto: start the live toast once someone is signed in (not inside embedded frames).
  var embedded = /[?&]embed=1\b/.test(location.search) || window.self !== window.top;
  if (!embedded) { var tries = 0; (function w() { if (B().currentEmail && B().currentEmail()) return watch(); if (++tries < 60) setTimeout(w, 2000); })(); }
})();
