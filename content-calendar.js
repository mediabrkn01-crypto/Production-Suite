/* ════════════════════════════════════════════════════════════════════════════
   BECal — the ONE Content Calendar for every portal (Media publishing schedule, Academic
   workshops, Sales campaigns, HR events, Management milestones, company-wide events).

   Data: content_calendar_* tables (20261030_content_calendar.sql). Reads use the browser
   key; every write goes through the `calendar` edge function, which re-checks the caller's
   effective access (same rules as Aura: manager tier = all departments; heads = own
   department; Operations Managers = own + managed departments; HR admin = HR + company-wide).

   BECal.open(opts)            full calendar panel   (nav "Content Calendar" opens this)
   BECal.openItem(id, date)    exact item            (notification links  cal:<id>:<date>)
   BECal.mountUpcoming(el)     small "Next 7 days" widget
   Automatic once signed in: nav entry, Today's Plan briefing (once per day), live
   assignment toasts, reminder toasts, and the server reminder dispatcher trigger.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BECal) return;
  var TZ = 'Asia/Kolkata';
  var DCOL = { production: '#ff8a3d', education: '#60a5fa', sales: '#34d399', hr: '#f472b6', management: '#a78bfa', accounts: '#fbbf24', other: '#94a3b8', company: '#e5e7eb' };
  var DNAME = { production: 'Media', education: 'Academics', sales: 'Sales', hr: 'HR', management: 'Management', accounts: 'Accounts', other: 'Administration', company: 'Company-wide' };
  var ST = { planned: 'Planned', in_progress: 'In Progress', completed: 'Completed', cancelled: 'Cancelled' };
  var PLATFORMS = ['Instagram', 'YouTube', 'Facebook', 'LinkedIn', 'WhatsApp', 'Website', 'Email'];
  var REM = [['morning', 'Morning of the day'], ['start', 'At start time'], ['10', '10 min before'], ['30', '30 min before'], ['60', '1 hour before']];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var S = { client: null, scope: null, scopeAt: 0, scopeP: null, types: null, me: null, email: '', panel: null, ui: { view: '', cursor: '', dept: '', type: '', status: '', person: '', prio: '' }, data: null };

  // ── basics ────────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function B() { return window.BESession || {}; }
  function db() {
    try { if (typeof dbInstance !== 'undefined' && dbInstance) return dbInstance; } catch (_) {}
    try { if (typeof sb !== 'undefined' && sb && sb.from) return sb; } catch (_) {}
    try { if (typeof db_ !== 'undefined' && db_ && db_.from) return db_; } catch (_) {}
    if (!S.client && window.supabase && B().url) S.client = window.supabase.createClient(B().url, B().anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    return S.client;
  }
  function toast(kind, msg) { if (typeof window.showToast === 'function') { try { return window.showToast(kind, msg); } catch (_) {} } note({ title: msg }); }
  function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
  function nowHM() { return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
  function D(s) { return new Date(s + 'T00:00:00Z'); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function add(s, n) { var d = D(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
  function dow(s) { return D(s).getUTCDay(); }
  function monthStart(s) { return s.slice(0, 8) + '01'; }
  function monthEnd(s) { var d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return ymd(d); }
  function addMonths(s, n) { var d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return ymd(d); }
  function fDay(s, o) { return D(s).toLocaleDateString('en-IN', Object.assign({ timeZone: 'UTC', day: 'numeric', month: 'short' }, o || {})); }
  function fTime(t) { if (!t) return ''; var h = +t.slice(0, 2), m = t.slice(3, 5); return ((h % 12) || 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return (w[0] || '').toUpperCase(); }).join('') || '?'; }
  function uid() { try { return crypto.randomUUID(); } catch (_) { return 'k' + Date.now(); } }
  function deptName(c) { var x = S.scope && (S.scope.departments || []).filter(function (d) { return d.code === c; })[0]; return c === 'company' ? 'Company-wide' : DNAME[c] || (x && x.name) || c || ''; }
  function typeLabel(code) { var t = (S.types || []).filter(function (x) { return x.code === code; })[0]; return t ? t.label : String(code || 'other').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function isMobile() { return window.matchMedia && matchMedia('(max-width: 720px)').matches; }

  // ── server ───────────────────────────────────────────────────────────────
  async function api(action, body) {
    var tk = B().token ? B().token() : null;
    if (!tk) throw new Error('Your session has expired. Please sign in again.');
    var r = await fetch(B().url + '/functions/v1/calendar', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': B().anonKey, 'Authorization': 'Bearer ' + B().anonKey, 'x-erp-session': tk },
      body: JSON.stringify(Object.assign({ action: action }, body || {})) });
    var j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(j.error || 'The calendar is unavailable right now.');
    return j;
  }
  function scopeKey() { return S.email ? 'be_cal_scope:' + S.email : ''; }
  function scopeCached() {
    if (S.scope) return S.scope;
    try { var c = JSON.parse(sessionStorage.getItem(scopeKey()) || 'null'); if (c && c.data && Date.now() - c.at < 600000) { S.scope = c.data; S.scopeAt = c.at; } } catch (_) {}
    return S.scope;
  }
  function scope(force) {
    if (!force && scopeCached() && Date.now() - S.scopeAt < 60000) return Promise.resolve(S.scope);
    if (S.scopeP) return S.scopeP;
    S.scopeP = api('scope').then(function (x) { S.scope = x; S.scopeAt = Date.now(); S.me = x.me && x.me.id; try { sessionStorage.setItem(scopeKey(), JSON.stringify({ at: S.scopeAt, data: x })); } catch (_) {} return x; })
      .finally(function () { S.scopeP = null; });
    return S.scopeP;
  }
  async function types() {
    if (S.types) return S.types;
    var r = await db().from('content_calendar_types').select('code,label,departments,sort_order').eq('active', true).order('sort_order');
    S.types = r.data || []; return S.types;
  }
  function manageable() { var sc = S.scope; if (!sc) return []; var m = sc.manage_departments === '*' ? sc.departments.map(function (d) { return d.code; }) : sc.manage_departments; return (m || []).slice(); }
  function canManage(dept) { var sc = S.scope; if (!sc) return false; return dept === 'company' ? sc.can_company : (sc.manage_departments === '*' || (sc.manage_departments || []).indexOf(dept) > -1); }
  function canAdd() { return manageable().length > 0 || (S.scope && S.scope.can_company); }

  // ── data: items in a range, recurring ones expanded (never stored as copies) ─────────
  function occurs(i, d) {
    if (d < i.item_date) return false;
    if (!i.recurrence) return d === i.item_date;
    if (i.recurrence_until && d > i.recurrence_until) return false;
    if (i.recurrence === 'daily') return true;
    if (i.recurrence === 'weekly') return dow(d) === dow(i.item_date);
    if (i.recurrence === 'weekdays') return ((i.recurrence_days && i.recurrence_days.length) ? i.recurrence_days : [dow(i.item_date)]).indexOf(dow(d)) > -1;
    if (i.recurrence === 'monthly') { var want = +i.item_date.slice(8, 10), last = +monthEnd(d).slice(8, 10); return +d.slice(8, 10) === Math.min(want, last); }
    return false;
  }
  async function load(from, to) {
    var c = db();
    var r = await c.from('content_calendar_items').select('*')
      .or('and(recurrence.is.null,item_date.gte.' + from + ',item_date.lte.' + to + '),and(recurrence.not.is.null,item_date.lte.' + to + ')').limit(3000);
    if (r.error) throw r.error;
    var items = (r.data || []).filter(function (i) { return !i.recurrence || !i.recurrence_until || i.recurrence_until >= from; });
    var ids = items.map(function (i) { return i.id; }), asg = {}, occ = {};
    for (var k = 0; k < ids.length; k += 150) {
      var part = ids.slice(k, k + 150);
      var a = await c.from('content_calendar_assignees').select('item_id,employee_id').in('item_id', part);
      (a.data || []).forEach(function (x) { (asg[x.item_id] = asg[x.item_id] || []).push(x.employee_id); });
      var rec = items.filter(function (i) { return i.recurrence && part.indexOf(i.id) > -1; }).map(function (i) { return i.id; });
      if (rec.length) {
        var o = await c.from('content_calendar_occurrences').select('*').in('item_id', rec).gte('occ_date', from).lte('occ_date', to);
        (o.data || []).forEach(function (x) { occ[x.item_id + '|' + x.occ_date] = x; });
      }
    }
    var out = [];
    items.forEach(function (i) {
      i.assignees = asg[i.id] || [];
      if (!visible(i)) return;
      for (var d = i.recurrence ? (i.item_date > from ? i.item_date : from) : i.item_date; d <= to; d = add(d, 1)) {
        if (d >= from && occurs(i, d)) {
          var o = occ[i.id + '|' + d];
          var st = i.status === 'cancelled' ? 'cancelled' : i.recurrence ? (o ? o.status : 'planned') : i.status;
          out.push({ i: i, date: d, status: st, occ: o || null });
        }
        if (!i.recurrence) break;
      }
    });
    out.sort(function (a, b) { return (a.date + (a.i.start_time || '99')).localeCompare(b.date + (b.i.start_time || '99')); });
    return out;
  }
  // Who sees what (the server applies the same scope to every write).
  function visible(i) {
    var sc = S.scope; if (!sc) return false;
    if (sc.view_all) return true;
    var me = sc.me || {};
    return i.department === 'company' || i.department === me.division || canManage(i.department) || (i.assignees || []).indexOf(me.id) > -1;
  }
  function overdue(o) {
    if (o.status !== 'planned' && o.status !== 'in_progress') return false;
    var t = today();
    return o.date < t || (o.date === t && !!o.i.start_time && o.i.start_time.slice(0, 5) < nowHM());
  }
  function mine(o) { var me = S.scope && S.scope.me || {}; return (o.i.assignees || []).indexOf(me.id) > -1; }
  function personName(id) { var p = (S.scope && S.scope.people || []).filter(function (x) { return x.id === id; })[0]; return p ? p.name : ''; }

  // ── styles ───────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('becal-css')) return;
    var s = document.createElement('style'); s.id = 'becal-css';
    s.textContent = [
      '.cc{--cc-bg:#0b0f1c;--cc-card:#0e1222;--cc-line:rgba(255,255,255,.06);--cc-mute:#8b93b8;--cc-dim:#6b74a0;--cc-acc:#ff8a3d;color:#e6e9f5;font-family:inherit}',
      '.cc *{box-sizing:border-box}',
      '.cc-sheet{position:fixed;inset:0;z-index:9150;background:rgba(3,5,9,.7);backdrop-filter:blur(4px);display:flex;justify-content:center;align-items:flex-start;padding:22px 16px;overflow:auto}',
      '.cc-pane{width:min(1240px,100%);min-height:calc(100vh - 44px);background:var(--cc-bg);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:20px 22px;display:flex;flex-direction:column;gap:14px;box-shadow:0 30px 80px -20px rgba(0,0,0,.85)}',
      '.cc-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.cc-top h2{margin:0;font-size:20px;font-weight:800;color:#fff;letter-spacing:-.01em}',
      '.cc-nav{display:flex;align-items:center;gap:6px}.cc-ib{width:34px;height:34px;border-radius:10px;border:1px solid var(--cc-line);background:rgba(255,255,255,.03);color:#c7cbe0;font:inherit;font-size:16px;cursor:pointer;display:grid;place-items:center}.cc-ib:hover{color:#fff;border-color:rgba(255,255,255,.14)}',
      '.cc-tbtn{height:34px;padding:0 12px;border-radius:10px;border:1px solid var(--cc-line);background:rgba(255,255,255,.03);color:#e6e9f5;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
      '.cc-label{font-size:14px;font-weight:700;color:#fff;min-width:0}',
      '.cc-seg{display:inline-flex;padding:3px;border-radius:11px;background:rgba(255,255,255,.04);border:1px solid var(--cc-line);margin-left:auto}.cc-seg button{height:28px;padding:0 12px;border:0;border-radius:8px;background:none;color:var(--cc-mute);font:inherit;font-size:12px;font-weight:700;cursor:pointer}.cc-seg button.on{background:rgba(255,255,255,.08);color:#fff}',
      '.cc-add{height:34px;padding:0 14px;border-radius:10px;border:0;background:linear-gradient(135deg,#ff6b06,#f9182f 60%,#ff0552);color:#fff;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer;white-space:nowrap}',
      '.cc-x{width:34px;height:34px;border-radius:10px;border:1px solid var(--cc-line);background:rgba(255,255,255,.03);color:#a5adcf;font-size:18px;cursor:pointer}',
      '.cc-filters{display:flex;gap:8px;flex-wrap:wrap}.cc-sel{height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--cc-line)!important;background:rgba(255,255,255,.03)!important;color:#c7cbe0!important;font:inherit;font-size:12px!important;outline:none;max-width:200px}',
      '.cc-sel option{background:#0e1222;color:#e6e9f5}',
      /* month */
      '.cc-mh{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--cc-dim);padding:0 2px}.cc-mh span{padding:4px 8px}',
      '.cc-month{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;background:var(--cc-line);border:1px solid var(--cc-line);border-radius:14px;overflow:hidden}',
      '.cc-day{background:var(--cc-bg);min-height:112px;padding:6px 6px 8px;display:flex;flex-direction:column;gap:3px;cursor:pointer;min-width:0;transition:background .12s}.cc-day:hover{background:#0e1323}',
      '.cc-day.out{background:#090c16}.cc-day.out .cc-dn{color:#3d4463}.cc-dn{font-size:12px;font-weight:700;color:#a5adcf;padding:2px 4px;font-variant-numeric:tabular-nums;display:flex;align-items:center;justify-content:space-between}',
      '.cc-day.today .cc-dn b{background:var(--cc-acc);color:#140a02;border-radius:999px;padding:1px 7px}.cc-dn b{font-weight:800}',
      '.cc-chip{display:flex;flex-direction:column;gap:0;padding:3px 6px 4px;border-radius:7px;background:rgba(255,255,255,.035);border-left:2px solid var(--c,#94a3b8);font-size:11.5px;line-height:1.25;min-width:0;cursor:pointer;text-align:left;border-top:0;border-right:0;border-bottom:0;color:#e6e9f5;font-family:inherit}',
      '.cc-chip:hover{background:rgba(255,255,255,.07)}.cc-chip small{font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--cc-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cc-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
      '.cc-chip.done{opacity:.45}.cc-chip.done span{text-decoration:line-through}.cc-chip.late small{color:#f87171}.cc-chip.cxl{opacity:.35}',
      '.cc-more{font-size:11px;color:var(--cc-mute);padding:1px 6px;font-weight:700}',
      '.cc-dots{display:none;gap:3px;justify-content:center;padding-top:2px}.cc-dots i{width:5px;height:5px;border-radius:50%;background:var(--c,#94a3b8)}',
      /* list / cards */
      '.cc-list{display:flex;flex-direction:column;gap:6px}.cc-dh{display:flex;align-items:baseline;gap:10px;margin:12px 0 2px;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--cc-dim)}.cc-dh b{color:#fff;font-size:12px;letter-spacing:.1em}.cc-dh.today b{color:var(--cc-acc)}',
      '.cc-card{display:grid;grid-template-columns:76px minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 14px;border-radius:12px;background:var(--cc-card);border:1px solid var(--cc-line);cursor:pointer;text-align:left;color:inherit;font:inherit;width:100%}',
      '.cc-card:hover{border-color:rgba(255,255,255,.12)}.cc-card .t{font-size:12.5px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums}.cc-card .t small{display:block;font-size:10px;color:var(--cc-dim);font-weight:700;letter-spacing:.06em;text-transform:uppercase}',
      '.cc-card .m{min-width:0}.cc-card .m b{display:block;font-size:14px;color:#fff;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cc-card .m span{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11.5px;color:var(--cc-mute);margin-top:2px}',
      '.cc-dot{width:7px;height:7px;border-radius:50%;background:var(--c,#94a3b8);display:inline-block;flex-shrink:0}',
      '.cc-card.done{opacity:.55}.cc-card.done .m b{text-decoration:line-through;text-decoration-color:rgba(255,255,255,.35)}.cc-card.cxl{opacity:.4}',
      '.cc-pill{height:22px;padding:0 9px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.04em;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;border:1px solid var(--cc-line);color:var(--cc-mute)}',
      '.cc-pill.late{color:#fca5a5;border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08)}.cc-pill.done{color:#6ee7b7;border-color:rgba(52,211,153,.35)}.cc-pill.prog{color:#93c5fd;border-color:rgba(96,165,250,.35)}.cc-pill.hi{color:#fdba74;border-color:rgba(251,146,60,.35)}',
      '.cc-avs{display:flex}.cc-avs i{width:24px;height:24px;border-radius:50%;margin-left:-6px;display:grid;place-items:center;font-style:normal;font-size:9.5px;font-weight:800;color:#fff;background:#1d2340;border:2px solid var(--cc-card)}',
      '.cc-empty{padding:28px 6px;text-align:center;color:var(--cc-dim);font-size:13px}',
      /* week */
      '.cc-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}.cc-wd{display:flex;flex-direction:column;gap:6px;min-width:0;padding:8px;border-radius:12px;background:rgba(255,255,255,.015);border:1px solid var(--cc-line);min-height:240px}',
      '.cc-wd.today{border-color:rgba(255,138,61,.35)}.cc-wdh{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--cc-dim);cursor:pointer}.cc-wdh b{font-size:16px;color:#fff;letter-spacing:0}.cc-wd.today .cc-wdh b{color:var(--cc-acc)}',
      '.cc-wd .cc-chip{padding:6px 8px}',
      /* modal */
      '.cc-ov{position:fixed;inset:0;z-index:9350;display:grid;place-items:center;padding:16px;background:rgba(3,5,9,.6);backdrop-filter:blur(3px)}',
      '.cc-dlg{width:min(560px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:18px;background:#0e1222;border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 80px -20px rgba(0,0,0,.85);padding:20px;display:flex;flex-direction:column;gap:14px}',
      '.cc-dlg.wide{width:min(820px,100%)}.cc-dlg h3{margin:0;font-size:18px;color:#fff;font-weight:800;overflow-wrap:anywhere}',
      '.cc-f{display:flex;flex-direction:column;gap:6px;min-width:0}.cc-f>label,.cc-f>span{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--cc-dim)}.cc-f b{color:#f87171}',
      '.cc-in{width:100%;height:38px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.08)!important;background:rgba(255,255,255,.03)!important;color:#fff!important;font:inherit;font-size:13px!important;outline:none;color-scheme:dark}textarea.cc-in{height:auto;padding:9px 12px;resize:vertical}',
      '.cc-in:focus{border-color:rgba(255,138,61,.5)!important}',
      '.cc-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.cc-row3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
      '.cc-chips{display:flex;flex-wrap:wrap;gap:6px}.cc-ch{height:30px;padding:0 11px;border-radius:999px;border:1px solid rgba(255,255,255,.09);background:none;color:var(--cc-mute);font:inherit;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
      '.cc-ch.on{color:#fff;border-color:rgba(255,107,6,.55);background:rgba(255,107,6,.12)}.cc-ch .cc-dot{width:6px;height:6px}',
      '.cc-people{max-height:170px;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;padding:2px}',
      '.cc-acts{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.cc-btn{height:38px;padding:0 16px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#e6e9f5;font:inherit;font-size:13px;font-weight:700;cursor:pointer}',
      '.cc-btn.pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f 55%,#ff0552)}.cc-btn.ok{border-color:rgba(52,211,153,.45);color:#6ee7b7;background:rgba(52,211,153,.08)}.cc-btn.ghost{border-color:transparent;background:none;color:var(--cc-mute)}.cc-btn:disabled{opacity:.6;cursor:progress}',
      '.cc-more-t{border:0;background:none;color:#ffb37a;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;padding:0;align-self:flex-start}',
      '.cc-err{color:#f87171;font-size:12.5px;min-height:0}',
      '.cc-kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 14px;font-size:13px}.cc-kv span{color:var(--cc-dim)}.cc-kv b{color:#fff;font-weight:600;overflow-wrap:anywhere}.cc-kv a{color:#ffb37a}',
      '.cc-desc{font-size:13px;color:#c7cbe0;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.03)}',
      '.cc-work{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;border:1px solid rgba(96,165,250,.25);background:rgba(96,165,250,.05)}.cc-work div{flex:1;min-width:0}.cc-work small{display:block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#93c5fd}.cc-work b{color:#fff;font-size:13.5px}',
      /* today's plan briefing */
      '.cc-plan{position:fixed;right:20px;bottom:20px;z-index:9300;width:min(360px,calc(100vw - 24px));border-radius:16px;background:#0e1222;border:1px solid rgba(255,138,61,.25);box-shadow:0 24px 60px -18px rgba(0,0,0,.85);padding:16px;display:flex;flex-direction:column;gap:10px;transform:translateY(12px);opacity:0;transition:all .25s ease}',
      '.cc-plan.on{transform:none;opacity:1}.cc-plan .k{font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#ffb37a}.cc-plan h4{margin:0;font-size:15px;color:#fff}',
      '.cc-plan ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto}.cc-plan li{display:grid;grid-template-columns:70px minmax(0,1fr);gap:10px;padding:7px 4px;border-bottom:1px solid var(--cc-line);font-size:13px;cursor:pointer}.cc-plan li:last-child{border:0}',
      '.cc-plan li b{color:#fff;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cc-plan li span{color:var(--cc-mute);font-variant-numeric:tabular-nums;font-size:12px}.cc-plan li small{display:block;color:var(--cc-dim);font-size:11px}',
      '.cc-plan .cc-acts .cc-btn{height:34px;font-size:12.5px}',
      /* toast */
      '.cc-note{position:fixed;left:50%;top:18px;z-index:9450;transform:translate(-50%,-10px);opacity:0;transition:all .22s;display:flex;gap:12px;align-items:center;padding:12px 14px 12px 16px;border-radius:14px;background:#11182a;border:1px solid rgba(255,138,61,.3);box-shadow:0 20px 50px -14px rgba(0,0,0,.8);max-width:calc(100vw - 24px);color:#e6e9f5}',
      '.cc-note.on{transform:translate(-50%,0);opacity:1}.cc-note b{display:block;color:#fff;font-size:13.5px}.cc-note span{display:block;color:#a5adcf;font-size:12px}.cc-note button{height:30px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;font:inherit;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0}',
      /* upcoming widget */
      '.cc-up h4{margin:0 0 8px;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#8b93b8;display:flex;justify-content:space-between}.cc-up h4 button{border:0;background:none;color:#ffb37a;font:inherit;font-size:11px;font-weight:700;cursor:pointer;letter-spacing:0;text-transform:none}',
      '.cc-up .r{display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;font-size:12.5px}.cc-up .r:last-child{border:0}.cc-up .r span{color:#8b93b8;font-size:11.5px}.cc-up .r b{color:#fff;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cc-nav-cal svg{color:#ff8a3d}',
      '@media(max-width:720px){.cc-sheet{padding:0}.cc-pane{border-radius:0;min-height:100vh;padding:14px 14px 24px;border:0}.cc-seg{margin-left:0;width:100%;display:grid;grid-template-columns:repeat(4,1fr)}.cc-top h2{font-size:18px;flex:1}.cc-label{flex:1;font-size:13px}',
      ' .cc-mh span{padding:4px 0;text-align:center;letter-spacing:.04em}.cc-day{min-height:52px;padding:4px 2px;align-items:center}.cc-day .cc-chip,.cc-day .cc-more{display:none}.cc-day .cc-dots{display:flex}.cc-day.sel{background:#141a30}.cc-dn{justify-content:center}',
      ' .cc-week{grid-template-columns:1fr}.cc-wd{min-height:0}.cc-card{grid-template-columns:62px minmax(0,1fr);padding:10px 12px}.cc-card .s{grid-column:2;justify-self:start}',
      ' .cc-ov{place-items:end stretch;grid-template-columns:minmax(0,1fr);padding:0}.cc-dlg,.cc-dlg.wide{width:100%;max-height:92vh;border-radius:20px 20px 0 0;padding:18px 16px calc(16px + env(safe-area-inset-bottom))}',
      ' .cc-top h2{order:0}.cc-top .cc-x{order:1}.cc-top .cc-nav{order:2}.cc-top .cc-label{order:3}.cc-top .cc-seg{order:4}.cc-top .cc-add{order:5;width:100%;height:40px}',
      ' .cc-filters{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 -14px;padding:0 14px}.cc-filters::-webkit-scrollbar{display:none}.cc-filters .cc-sel{flex:0 0 auto!important;max-width:170px!important}',
      ' .cc-row3{grid-template-columns:1fr 1fr}.cc-kv{grid-template-columns:96px minmax(0,1fr)}.cc-plan{right:12px;left:12px;bottom:12px;width:auto}.cc-filters .cc-sel{flex:1 1 140px;max-width:none}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── small UI helpers ─────────────────────────────────────────────────────
  function note(o) {
    css();
    var el = document.createElement('div'); el.className = 'cc-note cc'; el.setAttribute('role', 'status');
    el.innerHTML = '<div style="min-width:0"><b>' + esc(o.title) + '</b>' + (o.sub ? '<span>' + esc(o.sub) + '</span>' : '') + '</div>' + (o.onView ? '<button type="button">View</button>' : '');
    document.body.appendChild(el);
    var gone = function () { el.classList.remove('on'); setTimeout(function () { el.remove(); }, 250); };
    if (o.onView) el.querySelector('button').onclick = function () { gone(); o.onView(); };
    setTimeout(function () { el.classList.add('on'); }, 10);
    setTimeout(gone, o.ms || 6500);
  }
  function modal(html, wide) {
    css();
    var ov = document.createElement('div'); ov.className = 'cc-ov cc';
    ov.innerHTML = '<div class="cc-dlg' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(ov);
    var close = function () { ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    return { ov: ov, dlg: ov.querySelector('.cc-dlg'), close: close };
  }
  function pill(o) {
    if (o.status === 'completed') return '<span class="cc-pill done">✓ Completed</span>';
    if (o.status === 'cancelled') return '<span class="cc-pill">Cancelled</span>';
    if (overdue(o)) return '<span class="cc-pill late">Overdue</span>';
    if (o.status === 'in_progress') return '<span class="cc-pill prog">In Progress</span>';
    if (o.i.priority === 'high') return '<span class="cc-pill hi">High</span>';
    return '';
  }
  function label(i) { return typeLabel(i.item_type) + (i.platform ? ' · ' + i.platform : ''); }
  function avs(ids) { return ids && ids.length ? '<span class="cc-avs">' + ids.slice(0, 3).map(function (id) { var n = personName(id); return '<i title="' + esc(n) + '">' + esc(initials(n)) + '</i>'; }).join('') + (ids.length > 3 ? '<i>+' + (ids.length - 3) + '</i>' : '') + '</span>' : ''; }
  function card(o, showDate) {
    var cls = o.status === 'completed' ? ' done' : o.status === 'cancelled' ? ' cxl' : '';
    return '<button type="button" class="cc-card' + cls + '" data-open="' + o.i.id + '" data-date="' + o.date + '" style="--c:' + (DCOL[o.i.department] || '#94a3b8') + '">'
      + '<span class="t">' + (o.i.start_time ? fTime(o.i.start_time) : 'All day') + (showDate ? '<small>' + esc(fDay(o.date, { weekday: 'short' })) + '</small>' : '') + '</span>'
      + '<span class="m"><b>' + esc(o.i.title) + '</b><span><i class="cc-dot"></i>' + esc(deptName(o.i.department)) + ' · ' + esc(label(o.i)) + (o.i.recurrence ? ' · ↻' : '') + '</span></span>'
      + '<span class="s" style="display:flex;gap:8px;align-items:center">' + avs(o.i.assignees) + pill(o) + '</span></button>';
  }
  function chip(o) {
    var cls = o.status === 'completed' ? ' done' : o.status === 'cancelled' ? ' cxl' : overdue(o) ? ' late' : '';
    return '<button type="button" class="cc-chip' + cls + '" data-open="' + o.i.id + '" data-date="' + o.date + '" style="--c:' + (DCOL[o.i.department] || '#94a3b8') + '" title="' + esc(o.i.title) + '">'
      + '<small>' + esc((o.i.start_time ? fTime(o.i.start_time) + ' · ' : '') + label(o.i)) + '</small><span>' + (o.status === 'completed' ? '✓ ' : '') + esc(o.i.title) + '</span></button>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // Calendar panel
  // ════════════════════════════════════════════════════════════════════════
  function open(opts) {
    css(); opts = opts || {};
    if (S.panel && S.panel.isConnected) { if (opts.view) S.ui.view = opts.view; return render(); }
    var U = S.ui;
    if (!U.view) U.view = isMobile() ? 'today' : 'month';
    if (opts.view) U.view = opts.view;
    U.cursor = opts.date || U.cursor || today();
    var sh = document.createElement('div'); sh.className = 'cc-sheet cc';
    sh.innerHTML = '<div class="cc-pane" role="dialog" aria-modal="true" aria-label="Content Calendar"></div>';
    document.body.appendChild(sh); S.panel = sh;
    var key = function (e) { if (e.key === 'Escape' && !document.querySelector('.cc-ov') && S.panel) close(); };
    var close = function () { sh.remove(); S.panel = null; document.removeEventListener('keydown', key); try { if (location.hash === '#calendar') history.replaceState(null, '', location.pathname + location.search); } catch (_) {} };
    S.closePanel = close;
    document.addEventListener('keydown', key);
    sh.addEventListener('mousedown', function (e) { if (e.target === sh) close(); });
    sh.addEventListener('click', onPanelClick);
    sh.addEventListener('change', onPanelChange);
    render();
  }
  function range() {
    var U = S.ui, c = U.cursor;
    if (U.view === 'month') { var a = monthStart(c), b = monthEnd(c); return { from: add(a, -dow(a)), to: add(b, 6 - dow(b)), label: D(c).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' }) }; }
    if (U.view === 'week') { var s = add(c, -dow(c)); return { from: s, to: add(s, 6), label: fDay(s) + ' – ' + fDay(add(s, 6), { year: 'numeric' }) }; }
    if (U.view === 'agenda') { return { from: add(c, -14), to: add(c, 30), label: 'From ' + fDay(c, { weekday: 'short' }) }; }
    return { from: c, to: c, label: (c === today() ? 'Today · ' : '') + fDay(c, { weekday: 'long', year: 'numeric' }) };
  }
  async function render() {
    var sh = S.panel; if (!sh) return;
    var pane = sh.querySelector('.cc-pane'), U = S.ui, R = range();
    var head = function () {
      var sc = S.scope;
      var depts = sc ? (sc.view_all ? sc.departments.map(function (d) { return d.code; }) : uniq([sc.me && sc.me.division].concat(manageable())).filter(Boolean)).concat(['company']) : [];
      var people = (sc && sc.people) || [];
      return '<div class="cc-top"><h2>Content Calendar</h2>'
        + '<div class="cc-nav"><button type="button" class="cc-ib" data-mv="-1" aria-label="Previous">‹</button><button type="button" class="cc-tbtn" data-today>Today</button><button type="button" class="cc-ib" data-mv="1" aria-label="Next">›</button></div>'
        + '<span class="cc-label">' + esc(R.label) + '</span>'
        + '<div class="cc-seg" role="tablist">' + [['month', 'Month'], ['week', 'Week'], ['today', 'Day'], ['agenda', 'Agenda']].map(function (v) { return '<button type="button" data-view="' + v[0] + '" class="' + (U.view === v[0] ? 'on' : '') + '">' + v[1] + '</button>'; }).join('') + '</div>'
        + (canAdd() ? '<button type="button" class="cc-add" data-new>+ Add Event / Content</button>' : '')
        + '<button type="button" class="cc-x" data-close aria-label="Close">×</button></div>'
        + '<div class="cc-filters">'
        + '<select class="cc-sel" data-native data-f="dept"><option value="">' + (sc && sc.view_all ? 'All departments' : 'My calendar') + '</option>' + depts.map(function (d) { return '<option value="' + esc(d) + '"' + (U.dept === d ? ' selected' : '') + '>' + esc(deptName(d)) + '</option>'; }).join('') + '</select>'
        + '<select class="cc-sel" data-native data-f="type"><option value="">All types</option>' + (S.types || []).map(function (t) { return '<option value="' + esc(t.code) + '"' + (U.type === t.code ? ' selected' : '') + '>' + esc(t.label) + '</option>'; }).join('') + '</select>'
        + '<select class="cc-sel" data-native data-f="status"><option value="">Any status</option>' + Object.keys(ST).concat(['overdue']).map(function (k) { return '<option value="' + k + '"' + (U.status === k ? ' selected' : '') + '>' + (ST[k] || 'Overdue') + '</option>'; }).join('') + '</select>'
        + '<select class="cc-sel" data-native data-f="prio"><option value="">Any priority</option>' + ['high', 'medium', 'low'].map(function (k) { return '<option value="' + k + '"' + (U.prio === k ? ' selected' : '') + '>' + k[0].toUpperCase() + k.slice(1) + '</option>'; }).join('') + '</select>'
        + '<select class="cc-sel" data-native data-f="person"><option value="">Everyone</option><option value="me"' + (U.person === 'me' ? ' selected' : '') + '>Assigned to me</option>' + people.map(function (p) { return '<option value="' + p.id + '"' + (U.person === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>'
        + '</div><div data-body></div>';
    };
    pane.innerHTML = head();
    var body = pane.querySelector('[data-body]');
    if (!S.data || S.data.from !== R.from || S.data.to !== R.to) body.innerHTML = '<div class="cc-empty">Loading…</div>';
    try {
      await Promise.all([scope(), types()]);
      pane.innerHTML = head(); body = pane.querySelector('[data-body]');
      var rows = await load(R.from, R.to);
      S.data = { from: R.from, to: R.to, rows: rows };
    } catch (e) {
      body.innerHTML = '<div class="cc-empty">' + esc(/content_calendar|relation|schema cache/i.test(e.message || '') ? 'The Content Calendar needs the database update 20261030_content_calendar.sql.' : (e.message || 'The calendar could not load.')) + '</div>'; return;
    }
    var list = filtered(S.data.rows);
    body.innerHTML = U.view === 'month' ? monthHTML(list, R) : U.view === 'week' ? weekHTML(list, R) : U.view === 'agenda' ? agendaHTML(list) : dayHTML(list, U.cursor);
  }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function filtered(rows) {
    var U = S.ui, me = S.scope && S.scope.me || {};
    return rows.filter(function (o) {
      if (U.dept && o.i.department !== U.dept) return false;
      if (U.type && o.i.item_type !== U.type) return false;
      if (U.prio && o.i.priority !== U.prio) return false;
      if (U.status === 'overdue' ? !overdue(o) : (U.status && o.status !== U.status)) return false;
      if (U.person === 'me' && (o.i.assignees || []).indexOf(me.id) < 0) return false;
      if (U.person && U.person !== 'me' && (o.i.assignees || []).indexOf(U.person) < 0) return false;
      return true;
    });
  }
  function byDay(list) { var m = {}; list.forEach(function (o) { (m[o.date] = m[o.date] || []).push(o); }); return m; }
  function monthHTML(list, R) {
    var m = byDay(list), t = today(), cur = S.ui.cursor.slice(0, 7), out = '';
    for (var d = R.from; d <= R.to; d = add(d, 1)) {
      var xs = m[d] || [];
      out += '<div class="cc-day' + (d.slice(0, 7) !== cur ? ' out' : '') + (d === t ? ' today' : '') + (d === S.ui.sel ? ' sel' : '') + '" data-day="' + d + '">'
        + '<span class="cc-dn"><b>' + (+d.slice(8)) + '</b></span>'
        + xs.slice(0, 3).map(chip).join('') + (xs.length > 3 ? '<span class="cc-more">+' + (xs.length - 3) + ' more</span>' : '')
        + '<span class="cc-dots">' + xs.slice(0, 4).map(function (o) { return '<i style="--c:' + (DCOL[o.i.department] || '#94a3b8') + '"></i>'; }).join('') + '</span></div>';
    }
    var sel = S.ui.sel && S.ui.sel >= R.from && S.ui.sel <= R.to ? S.ui.sel : (t >= R.from && t <= R.to ? t : '');
    // Phones: the grid is a compact dot map; the chosen day's items are listed underneath.
    var below = isMobile() && sel ? '<div class="cc-dh' + (sel === t ? ' today' : '') + '"><b>' + esc(fDay(sel, { weekday: 'long' })) + '</b></div><div class="cc-list">' + ((m[sel] || []).map(function (o) { return card(o); }).join('') || '<div class="cc-empty">Nothing scheduled.</div>') + '</div>' : '';
    return '<div class="cc-mh">' + WD.map(function (w) { return '<span>' + (isMobile() ? w[0] : w) + '</span>'; }).join('') + '</div><div class="cc-month">' + out + '</div>' + below;
  }
  function weekHTML(list, R) {
    var m = byDay(list), t = today(), out = '';
    for (var d = R.from; d <= R.to; d = add(d, 1)) {
      var xs = m[d] || [];
      if (isMobile()) { out += '<div class="cc-dh' + (d === t ? ' today' : '') + '" data-day="' + d + '"><b>' + esc(fDay(d, { weekday: 'short' })) + '</b>' + (xs.length ? xs.length + ' item' + (xs.length > 1 ? 's' : '') : '') + '</div>' + (xs.map(function (o) { return card(o); }).join('') || ''); continue; }
      out += '<div class="cc-wd' + (d === t ? ' today' : '') + '"><div class="cc-wdh" data-day="' + d + '"><span>' + WD[dow(d)] + '</span><b>' + (+d.slice(8)) + '</b></div>' + xs.map(chip).join('') + '</div>';
    }
    return isMobile() ? '<div class="cc-list">' + out + '</div>' : '<div class="cc-week">' + out + '</div>';
  }
  function dayHTML(list, d) {
    var xs = list.filter(function (o) { return o.date === d; });
    return '<div class="cc-dh' + (d === today() ? ' today' : '') + '"><b>' + (d === today() ? 'Today · ' : '') + esc(fDay(d, { weekday: 'short' }).toUpperCase()) + '</b>' + (xs.length ? xs.length + ' scheduled' : '') + '</div>'
      + '<div class="cc-list">' + (xs.map(function (o) { return card(o); }).join('') || '<div class="cc-empty">Nothing scheduled' + (canAdd() ? ' — add the first item for this day.' : '.') + '</div>') + '</div>';
  }
  function agendaHTML(list) {
    var c = S.ui.cursor, late = list.filter(function (o) { return o.date < c && overdue(o); });
    var next = list.filter(function (o) { return o.date >= c; }), m = byDay(next), out = '';
    if (late.length) out += '<div class="cc-dh"><b style="color:#fca5a5">Overdue</b>' + late.length + '</div>' + late.map(function (o) { return card(o, true); }).join('');
    Object.keys(m).sort().forEach(function (d) { out += '<div class="cc-dh' + (d === today() ? ' today' : '') + '"><b>' + esc(fDay(d, { weekday: 'short' })) + '</b>' + (d === today() ? 'Today' : '') + '</div>' + m[d].map(function (o) { return card(o); }).join(''); });
    return '<div class="cc-list">' + (out || '<div class="cc-empty">Nothing scheduled in the next 30 days.</div>') + '</div>';
  }
  function onPanelClick(e) {
    var b = e.target.closest('[data-open],[data-day],[data-view],[data-mv],[data-today],[data-new],[data-close]'); if (!b) return;
    var U = S.ui;
    if (b.hasAttribute('data-open')) { e.stopPropagation(); return openItem(b.getAttribute('data-open'), b.getAttribute('data-date')); }
    if (b.hasAttribute('data-close')) return S.closePanel && S.closePanel();
    if (b.hasAttribute('data-view')) { U.view = b.getAttribute('data-view'); return render(); }
    if (b.hasAttribute('data-today')) { U.cursor = today(); U.sel = today(); return render(); }
    if (b.hasAttribute('data-mv')) {
      var n = +b.getAttribute('data-mv');
      U.cursor = U.view === 'month' ? addMonths(U.cursor, n) : U.view === 'week' ? add(U.cursor, 7 * n) : U.view === 'agenda' ? add(U.cursor, 30 * n) : add(U.cursor, n);
      return render();
    }
    if (b.hasAttribute('data-new')) return editor({ item_date: U.view === 'today' ? U.cursor : (U.sel || today()) });
    if (b.hasAttribute('data-day')) {
      var d = b.getAttribute('data-day');
      if (U.view === 'month' && isMobile()) { U.sel = d; return render(); }
      if (canAdd() && U.view === 'month') return editor({ item_date: d }, true);   // Quick Add
      U.cursor = d; U.view = 'today'; return render();
    }
  }
  function onPanelChange(e) {
    var f = e.target.getAttribute && e.target.getAttribute('data-f'); if (!f) return;
    S.ui[f] = e.target.value; render();
  }

  // ════════════════════════════════════════════════════════════════════════
  // One item
  // ════════════════════════════════════════════════════════════════════════
  async function fetchItem(id) {
    var r = await db().from('content_calendar_items').select('*').eq('id', id).maybeSingle();
    if (!r.data) return null;
    var a = await db().from('content_calendar_assignees').select('employee_id').eq('item_id', id);
    r.data.assignees = (a.data || []).map(function (x) { return x.employee_id; });
    return r.data;
  }
  async function openItem(id, date) {
    css();
    var M = modal('<h3>Loading…</h3>');
    var i, sc;
    try { var res = await Promise.all([fetchItem(id), scope(), types()]); i = res[0]; sc = res[1]; } catch (e) { M.dlg.innerHTML = '<h3>Could not load</h3><div class="cc-err">' + esc(e.message) + '</div>'; return; }
    if (!i || !visible(i)) { M.dlg.innerHTML = '<h3>Not available</h3><p style="color:#8b93b8;margin:0">This item was removed or is outside your calendar.</p><div class="cc-acts"><button class="cc-btn" data-x>Close</button></div>'; M.dlg.querySelector('[data-x]').onclick = M.close; return; }
    if (!date || !occurs(i, date)) date = i.recurrence ? (occurs(i, today()) ? today() : i.item_date) : i.item_date;
    var o = { i: i, date: date, status: i.status };
    if (i.recurrence && i.status !== 'cancelled') { var r = await db().from('content_calendar_occurrences').select('*').eq('item_id', i.id).eq('occ_date', date).maybeSingle(); o.status = r.data ? r.data.status : 'planned'; o.occ = r.data; }
    var me = sc.me || {}, manage = canManage(i.department), assigned = i.assignees.indexOf(me.id) > -1;
    var canStatus = manage || assigned;
    var rec = i.recurrence ? ({ daily: 'Every day', weekly: 'Every ' + WD[dow(i.item_date)], weekdays: 'Every ' + ((i.recurrence_days && i.recurrence_days.length ? i.recurrence_days : [dow(i.item_date)]).map(function (n) { return WD[n]; }).join(', ')), monthly: 'Monthly on day ' + (+i.item_date.slice(8)) }[i.recurrence] + (i.recurrence_until ? ' until ' + fDay(i.recurrence_until, { year: 'numeric' }) : '')) : '';
    var remTxt = (i.reminders || []).map(function (r) { var x = REM.filter(function (q) { return q[0] === r; })[0]; return x ? x[1] : /^m:/.test(r) ? r.slice(2) + ' min before' : r; }).join(', ');
    var by = o.status === 'completed' ? (o.occ ? o.occ.completed_by : i.completed_by) : '';
    M.dlg.classList.add('wide');
    M.dlg.innerHTML = '<div style="display:flex;gap:12px;align-items:flex-start"><div style="flex:1;min-width:0"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><span class="cc-pill" style="color:#fff"><i class="cc-dot" style="--c:' + (DCOL[i.department] || '#94a3b8') + '"></i>' + esc(deptName(i.department)) + '</span><span class="cc-pill">' + esc(label(i)) + '</span>' + pill(o) + (i.priority === 'high' && o.status !== 'completed' && !overdue(o) ? '' : i.priority === 'high' ? '<span class="cc-pill hi">High</span>' : '') + '</div><h3>' + esc(i.title) + '</h3></div><button class="cc-x" data-x aria-label="Close">×</button></div>'
      + '<div class="cc-kv"><span>When</span><b>' + esc(fDay(o.date, { weekday: 'long', year: 'numeric' })) + (i.start_time ? ' · ' + fTime(i.start_time) : ' · All day') + '</b>'
      + (rec ? '<span>Repeats</span><b>' + esc(rec) + '</b>' : '')
      + '<span>Status</span><b>' + esc(overdue(o) ? 'Overdue (' + ST[o.status] + ')' : ST[o.status]) + (by ? ' · by ' + esc(by) : '') + '</b>'
      + '<span>Assigned to</span><b>' + (i.assignees.length ? esc(i.assignees.map(personName).filter(Boolean).join(', ') || i.assignees.length + ' people') : '—') + '</b>'
      + '<span>Priority</span><b>' + esc(i.priority[0].toUpperCase() + i.priority.slice(1)) + '</b>'
      + (remTxt ? '<span>Reminders</span><b>' + esc(remTxt) + '</b>' : '')
      + (i.reference_url ? '<span>Reference</span><b><a href="' + esc(i.reference_url) + '" target="_blank" rel="noopener">' + esc(i.reference_url.replace(/^https?:\/\//, '').slice(0, 60)) + '</a></b>' : '')
      + (i.attachment_url ? '<span>Attachment</span><b><a href="' + esc(i.attachment_url) + '" target="_blank" rel="noopener">Open attachment</a></b>' : '')
      + '<span>Added by</span><b>' + esc(i.created_by_name || '—') + '</b></div>'
      + (i.description ? '<div class="cc-desc">' + esc(i.description) + '</div>' : '')
      + (i.related_assignment_id ? '<div class="cc-work" data-work><div><small>Related work</small><b>Loading…</b></div></div>' : '')
      + '<div class="cc-err" data-err></div>'
      + '<div class="cc-acts">'
      + (manage && o.status !== 'cancelled' ? '<button class="cc-btn ghost" data-cancel>Cancel item</button>' : '')
      + (manage ? '<button class="cc-btn" data-edit>Edit</button>' : '')
      + (canStatus && o.status !== 'cancelled' ? (o.status === 'completed' ? '<button class="cc-btn" data-st="planned">Reopen</button>' : (o.status === 'planned' ? '<button class="cc-btn" data-st="in_progress">Start</button>' : '') + '<button class="cc-btn ok" data-st="completed">✓ Mark Completed</button>') : '')
      + '</div>';
    M.dlg.querySelector('[data-x]').onclick = M.close;
    if (i.related_assignment_id) relatedWork(M.dlg.querySelector('[data-work]'), i.related_assignment_id);
    M.dlg.addEventListener('click', async function (e) {
      var b = e.target.closest('button'); if (!b || b.disabled) return;
      if (b.hasAttribute('data-edit')) { M.close(); return editor(i); }
      var st = b.getAttribute('data-st') || (b.hasAttribute('data-cancel') ? 'cancelled' : '');
      if (!st) return;
      var all = false;
      if (st === 'cancelled') {
        var ok = typeof window.showConfirm === 'function' ? await showConfirm(i.recurrence ? 'Cancel only ' + fDay(o.date) + '? (Edit the item to stop the whole series.)' : 'Cancel “' + i.title + '”? It stays in history as Cancelled.', { title: 'Cancel item?', confirmLabel: 'Cancel item' }) : true;
        if (!ok) return;
      }
      b.disabled = true;
      try {
        await api('status', { id: i.id, occ_date: o.date, status: st, all: all });
        M.close();
        if (st === 'completed') note({ title: '✓ Completed', sub: i.title, ms: 3000 });
        refresh();
      } catch (x) { b.disabled = false; M.dlg.querySelector('[data-err]').textContent = x.message; }
    });
  }
  async function relatedWork(box, id) {
    if (!box) return;
    var r = await db().from('assignments').select('id,topic,type,status,assigned_to,deadline,department').eq('id', id).maybeSingle();
    if (!r.data) { box.querySelector('b').textContent = 'That work item is no longer available.'; return; }
    var w = r.data;
    box.innerHTML = '<div><small>Related work</small><b>' + esc(w.topic || w.type || 'Work') + '</b><span style="display:block;color:#8b93b8;font-size:11.5px">' + esc([w.status, w.assigned_to, w.deadline ? 'due ' + fDay(String(w.deadline).slice(0, 10)) : ''].filter(Boolean).join(' · ')) + '</span></div><button class="cc-btn" data-ow>Open Work</button>';
    box.querySelector('[data-ow]').onclick = function () {
      var hooks = [window._mgrWork, window._acadMyWork, window._mediaWork, window._hrWork, window._salesWork];
      for (var k = 0; k < hooks.length; k++) { if (hooks[k] && typeof hooks[k].open === 'function') { var ov = box.closest('.cc-ov'); if (ov) ov.remove(); if (S.closePanel) S.closePanel(); try { if (typeof mgrSection === 'function') mgrSection('work'); } catch (_) {} hooks[k].open(String(w.id)); return; } }
      toast('info', 'Open the Work Assignment section to see “' + (w.topic || 'this work') + '”.');
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Add / edit (Quick Add = same form, details folded away)
  // ════════════════════════════════════════════════════════════════════════
  async function editor(src, quick) {
    css(); src = src || {};
    var M = modal('<h3>' + (src.id ? 'Edit item' : 'Add Event / Content') + '</h3><div class="cc-empty">Loading…</div>', !quick);
    var sc;
    try { var r = await Promise.all([scope(), types()]); sc = r[0]; } catch (e) { M.dlg.innerHTML = '<h3>Could not open</h3><div class="cc-err">' + esc(e.message) + '</div>'; return; }
    var depts = manageable().concat(sc.can_company ? ['company'] : []);
    if (!depts.length) { M.close(); return toast('error', 'You can view the calendar, but adding items is for department heads and managers.'); }
    var f = {
      id: src.id || null, title: src.title || '', department: src.department || (depts.indexOf(sc.me && sc.me.division) > -1 ? sc.me.division : depts[0]),
      item_type: src.item_type || '', platform: src.platform || '', item_date: src.item_date || today(), start_time: src.start_time ? String(src.start_time).slice(0, 5) : '',
      description: src.description || '', priority: src.priority || 'medium', status: src.status || 'planned',
      reminders: src.reminders ? src.reminders.slice() : ['morning'], recurrence: src.recurrence || '', recurrence_days: (src.recurrence_days || []).slice(), recurrence_until: src.recurrence_until || '',
      reference_url: src.reference_url || '', attachment_url: src.attachment_url || '', related_assignment_id: src.related_assignment_id || '', assignees: (src.assignees || []).slice()
    };
    var more = !quick, key = uid(), busy = false, works = null;
    function typesFor(d) { return (S.types || []).filter(function (t) { return !t.departments || !t.departments.length || t.departments.indexOf(d) > -1; }).concat((S.types || []).filter(function (t) { return t.departments && t.departments.length && t.departments.indexOf(d) < 0; })); }
    function people() { return (sc.people || []).filter(function (p) { return f.department === 'company' || sc.manage_departments === '*' || p.division === f.department; }); }
    function custom() { return f.reminders.filter(function (r) { return /^m:/.test(r); })[0]; }
    async function loadWorks() {
      if (works) return works;
      var q = db().from('assignments').select('id,topic,type,status,department').order('id', { ascending: false }).limit(150);
      var r = await q; works = (r.data || []).filter(function (w) { return f.department === 'company' || !w.department || w.department === f.department || (f.department === 'production' && !w.department); });
      return works;
    }
    function draw() {
      var tl = typesFor(f.department);
      if (!f.item_type) f.item_type = (tl[0] && tl[0].code) || 'other';
      M.dlg.innerHTML = '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><h3>' + (f.id ? 'Edit item' : quick ? 'Quick add · ' + esc(fDay(f.item_date, { weekday: 'short' })) : 'Add Event / Content') + '</h3><button class="cc-x" data-x aria-label="Close">×</button></div>'
        + '<div class="cc-f"><label>Title <b>*</b></label><input class="cc-in" data-k="title" maxlength="200" placeholder="e.g. Pronunciation Challenge Winner Reel" value="' + esc(f.title) + '"></div>'
        + '<div class="cc-f"><span>Department <b>*</b></span><div class="cc-chips">' + depts.map(function (d) { return '<button type="button" class="cc-ch' + (f.department === d ? ' on' : '') + '" data-dept="' + esc(d) + '"><i class="cc-dot" style="--c:' + (DCOL[d] || '#94a3b8') + '"></i>' + esc(deptName(d)) + '</button>'; }).join('') + '</div></div>'
        + '<div class="cc-row3"><div class="cc-f"><label>Type <b>*</b></label><input class="cc-in" data-k="item_type_label" list="cc-types" value="' + esc(typeLabel(f.item_type)) + '"><datalist id="cc-types">' + tl.map(function (t) { return '<option value="' + esc(t.label) + '">'; }).join('') + '</datalist></div>'
        + '<div class="cc-f"><label>Date <b>*</b></label><input class="cc-in" type="date" data-native data-k="item_date" value="' + esc(f.item_date) + '"></div>'
        + '<div class="cc-f"><label>Time</label><input class="cc-in" type="time" data-native data-k="start_time" value="' + esc(f.start_time) + '"></div></div>'
        + (more ? details() : '<button type="button" class="cc-more-t" data-more>More details — notes, people, reminders, repeat…</button>')
        + '<div class="cc-err" data-err></div>'
        + '<div class="cc-acts"><button type="button" class="cc-btn" data-x>Cancel</button><button type="button" class="cc-btn pri" data-save>' + (f.id ? 'Save changes' : 'Save') + '</button></div>';
      if (more) loadWorks().then(function (ws) { var s = M.dlg.querySelector('[data-k="related_assignment_id"]'); if (!s) return; s.innerHTML = '<option value="">None</option>' + ws.map(function (w) { return '<option value="' + w.id + '"' + (String(f.related_assignment_id) === String(w.id) ? ' selected' : '') + '>' + esc((w.topic || w.type || 'Work') + ' · ' + (w.status || '')) + '</option>'; }).join(''); }).catch(function () {});
      if (!f.title) setTimeout(function () { var t = M.dlg.querySelector('[data-k="title"]'); if (t && !('ontouchstart' in window)) t.focus(); }, 30);
    }
    function details() {
      var ppl = people(), cm = custom();
      return '<div class="cc-row"><div class="cc-f"><label>Platform</label><input class="cc-in" data-k="platform" list="cc-plat" placeholder="Instagram, YouTube…" value="' + esc(f.platform) + '"><datalist id="cc-plat">' + PLATFORMS.map(function (p) { return '<option value="' + p + '">'; }).join('') + '</datalist></div>'
        + '<div class="cc-f"><span>Priority</span><div class="cc-chips">' + ['low', 'medium', 'high'].map(function (p) { return '<button type="button" class="cc-ch' + (f.priority === p ? ' on' : '') + '" data-prio="' + p + '">' + p[0].toUpperCase() + p.slice(1) + '</button>'; }).join('') + '</div></div></div>'
        + '<div class="cc-f"><label>Description / notes</label><textarea class="cc-in" data-k="description" rows="3" maxlength="4000" placeholder="What needs to happen?">' + esc(f.description) + '</textarea></div>'
        + '<div class="cc-f"><span>Assigned to</span><div class="cc-people">' + (ppl.length ? ppl.map(function (p) { return '<button type="button" class="cc-ch' + (f.assignees.indexOf(p.id) > -1 ? ' on' : '') + '" data-person="' + p.id + '">' + esc(p.name) + '</button>'; }).join('') : '<span style="color:#6b74a0;font-size:12px">No one to assign in this department.</span>') + '</div></div>'
        + '<div class="cc-f"><span>Reminders</span><div class="cc-chips">' + REM.map(function (r) { return '<button type="button" class="cc-ch' + (f.reminders.indexOf(r[0]) > -1 ? ' on' : '') + '" data-rem="' + r[0] + '">' + r[1] + '</button>'; }).join('')
        + '<button type="button" class="cc-ch' + (cm ? ' on' : '') + '" data-rem="custom">Custom</button>' + (cm ? '<input class="cc-in" type="number" min="1" max="10080" data-native data-k="custom_min" style="width:110px;height:30px" value="' + esc(cm.slice(2)) + '" aria-label="Minutes before"><span style="color:#6b74a0;font-size:12px;align-self:center">min before</span>' : '') + '</div>'
        + (!f.start_time ? '<span style="color:#6b74a0;font-size:11.5px">All-day items only use the morning reminder.</span>' : '') + '</div>'
        + '<div class="cc-row"><div class="cc-f"><span>Repeat</span><div class="cc-chips">' + [['', 'Never'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['weekdays', 'Selected days'], ['monthly', 'Monthly']].map(function (r) { return '<button type="button" class="cc-ch' + (f.recurrence === r[0] ? ' on' : '') + '" data-rec="' + r[0] + '">' + r[1] + '</button>'; }).join('') + '</div>'
        + (f.recurrence === 'weekdays' ? '<div class="cc-chips" style="margin-top:4px">' + WD.map(function (w, n) { return '<button type="button" class="cc-ch' + (f.recurrence_days.indexOf(n) > -1 ? ' on' : '') + '" data-wd="' + n + '">' + w + '</button>'; }).join('') + '</div>' : '') + '</div>'
        + (f.recurrence ? '<div class="cc-f"><label>Repeat until (optional)</label><input class="cc-in" type="date" data-native data-k="recurrence_until" value="' + esc(f.recurrence_until) + '"></div>' : '<div></div>') + '</div>'
        + '<div class="cc-row"><div class="cc-f"><label>Status</label><select class="cc-in" data-native data-k="status">' + Object.keys(ST).map(function (k) { return '<option value="' + k + '"' + (f.status === k ? ' selected' : '') + '>' + ST[k] + '</option>'; }).join('') + '</select></div>'
        + '<div class="cc-f"><label>Related work assignment</label><select class="cc-in" data-native data-k="related_assignment_id"><option value="">' + (f.related_assignment_id ? 'Loading…' : 'None') + '</option></select></div></div>'
        + '<div class="cc-row"><div class="cc-f"><label>Reference link</label><input class="cc-in" data-k="reference_url" placeholder="https://" value="' + esc(f.reference_url) + '"></div>'
        + '<div class="cc-f"><label>Attachment link</label><input class="cc-in" data-k="attachment_url" placeholder="Drive / file URL" value="' + esc(f.attachment_url) + '"></div></div>';
    }
    function grab() {
      M.dlg.querySelectorAll('[data-k]').forEach(function (el) {
        var k = el.getAttribute('data-k');
        if (k === 'item_type_label') { var v = el.value.trim(); var t = (S.types || []).filter(function (x) { return x.label.toLowerCase() === v.toLowerCase() || x.code === v.toLowerCase(); })[0]; f.item_type = t ? t.code : (v ? v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : ''); f._typeLabel = v; return; }
        if (k === 'custom_min') { var n = Math.max(1, Math.min(10080, parseInt(el.value, 10) || 0)); f.reminders = f.reminders.filter(function (r) { return !/^m:/.test(r); }); if (n) f.reminders.push('m:' + n); return; }
        f[k] = el.value;
      });
    }
    M.dlg.addEventListener('click', async function (e) {
      var b = e.target.closest('button'); if (!b || busy) return;
      if (b.hasAttribute('data-x')) return M.close();
      if (b.hasAttribute('data-more')) { grab(); more = true; M.dlg.classList.add('wide'); return draw(); }
      if (b.hasAttribute('data-dept')) { grab(); f.department = b.getAttribute('data-dept'); var ok = people().map(function (p) { return p.id; }); f.assignees = f.assignees.filter(function (id) { return ok.indexOf(id) > -1; }); works = null; return draw(); }
      if (b.hasAttribute('data-prio')) { f.priority = b.getAttribute('data-prio'); M.dlg.querySelectorAll('[data-prio]').forEach(function (x) { x.classList.toggle('on', x === b); }); return; }
      if (b.hasAttribute('data-person')) { var id = b.getAttribute('data-person'), k = f.assignees.indexOf(id); if (k > -1) f.assignees.splice(k, 1); else f.assignees.push(id); b.classList.toggle('on', k < 0); return; }
      if (b.hasAttribute('data-rem')) {
        grab(); var r = b.getAttribute('data-rem');
        if (r === 'custom') { if (custom()) f.reminders = f.reminders.filter(function (x) { return !/^m:/.test(x); }); else f.reminders.push('m:15'); return draw(); }
        var j = f.reminders.indexOf(r); if (j > -1) f.reminders.splice(j, 1); else f.reminders.push(r); b.classList.toggle('on', j < 0); return;
      }
      if (b.hasAttribute('data-rec')) { grab(); f.recurrence = b.getAttribute('data-rec'); if (f.recurrence === 'weekdays' && !f.recurrence_days.length) f.recurrence_days = [dow(f.item_date)]; return draw(); }
      if (b.hasAttribute('data-wd')) { var n = +b.getAttribute('data-wd'), q = f.recurrence_days.indexOf(n); if (q > -1) f.recurrence_days.splice(q, 1); else f.recurrence_days.push(n); b.classList.toggle('on', q < 0); return; }
      if (b.hasAttribute('data-save')) {
        grab();
        var err = !f.title.trim() ? 'Add a title.' : !f.item_type ? 'Choose a type.' : !f.item_date ? 'Choose a date.' : (f.recurrence === 'weekdays' && !f.recurrence_days.length) ? 'Pick at least one weekday.' : '';
        if (err) { M.dlg.querySelector('[data-err]').textContent = err; return; }
        busy = true; b.disabled = true; b.textContent = 'Saving…';
        try {
          var item = { id: f.id, title: f.title.trim(), department: f.department, item_type: f.item_type, platform: f.platform, item_date: f.item_date, start_time: f.start_time || null,
            description: f.description, priority: f.priority, status: f.status, reminders: f.reminders, recurrence: f.recurrence || null, recurrence_days: f.recurrence_days, recurrence_until: f.recurrence_until || null,
            reference_url: f.reference_url, attachment_url: f.attachment_url, related_assignment_id: f.related_assignment_id || null, client_key: key };
          var res = await api('save', { item: item, assignees: f.assignees });
          f.id = res.item.id;   // a retry after a network error edits instead of duplicating
          M.close();
          note({ title: src.id ? 'Saved' : 'Added to the calendar', sub: f.title + ' · ' + fDay(f.item_date, { weekday: 'short' }) + (f.start_time ? ', ' + fTime(f.start_time) : ''), ms: 3000 });
          if (S.panel) { S.ui.cursor = S.ui.view === 'today' ? f.item_date : S.ui.cursor; }
          refresh();
        } catch (x) { busy = false; b.disabled = false; b.textContent = f.id ? 'Save changes' : 'Save'; M.dlg.querySelector('[data-err]').textContent = x.message; }
      }
    });
    draw();
  }

  // ── after any change ──────────────────────────────────────────────────────
  var rt = 0;
  function refresh() { clearTimeout(rt); rt = setTimeout(function () { S.data = null; if (S.panel) render(); document.querySelectorAll('[data-cc-up]').forEach(function (el) { mountUpcoming(el); }); }, 120); }

  // ════════════════════════════════════════════════════════════════════════
  // Small "Upcoming · next 7 days" widget
  // ════════════════════════════════════════════════════════════════════════
  async function mountUpcoming(el) {
    if (!el) return; css(); el.classList.add('cc', 'cc-up'); el.setAttribute('data-cc-up', '1');
    try {
      await scope();
      var t = today(), rows = (await load(t, add(t, 6))).filter(function (o) { return o.status !== 'cancelled' && o.status !== 'completed' && relevant(o); });
      el.innerHTML = '<h4><span>Upcoming · next 7 days</span><button type="button" data-cal>Open calendar</button></h4>'
        + (rows.length ? rows.slice(0, 6).map(function (o) { return '<div class="r" data-open="' + o.i.id + '" data-date="' + o.date + '"><span>' + esc(o.date === t ? 'Today' : fDay(o.date, { weekday: 'short' }).split(',')[0]) + '<br>' + esc(o.i.start_time ? fTime(o.i.start_time) : 'All day') + '</span><b>' + esc(o.i.title) + '</b>' + (overdue(o) ? '<span class="cc-pill late">Overdue</span>' : '<span>' + esc(deptName(o.i.department)) + '</span>') + '</div>'; }).join('') + (rows.length > 6 ? '<div class="r" data-cal style="grid-template-columns:1fr"><span>+ ' + (rows.length - 6) + ' more</span></div>' : '')
          : '<div style="color:#6b74a0;font-size:12.5px;padding:6px 0">Nothing scheduled for the next 7 days.</div>');
      el.onclick = function (e) { var b = e.target.closest('[data-open],[data-cal]'); if (!b) return; if (b.hasAttribute('data-open')) openItem(b.getAttribute('data-open'), b.getAttribute('data-date')); else open({ view: 'agenda' }); };
    } catch (e) { el.innerHTML = ''; }
  }
  // "Relevant to me" for briefings: assigned to me, my department, company-wide.
  function relevant(o) { var me = S.scope && S.scope.me || {}; return mine(o) || o.i.department === 'company' || o.i.department === me.division; }

  // ════════════════════════════════════════════════════════════════════════
  // Today's Plan — once per day per person (first open of the ERP that day)
  // ════════════════════════════════════════════════════════════════════════
  async function todaysPlan(force) {
    var t = today(), k = 'be_cal_plan:' + S.email;
    try { if (!force && localStorage.getItem(k) === t) return; } catch (_) {}
    var rows = (await load(t, t)).filter(function (o) { return o.status !== 'cancelled' && relevant(o); });
    if (!rows.length && !force) return;
    try { localStorage.setItem(k, t); } catch (_) {}
    css();
    var open_ = rows.filter(function (o) { return o.status !== 'completed'; }).length;
    var el = document.createElement('div'); el.className = 'cc-plan cc'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', "Today's plan");
    el.innerHTML = '<div><div class="k">Today\'s plan · ' + esc(fDay(t, { weekday: 'short' })) + '</div><h4>' + (open_ ? open_ + ' thing' + (open_ > 1 ? 's' : '') + ' scheduled for today' : 'All done for today') + '</h4></div>'
      + '<ul>' + rows.map(function (o) { return '<li data-open="' + o.i.id + '" data-date="' + o.date + '"><span>' + esc(o.i.start_time ? fTime(o.i.start_time) : 'All day') + '</span><div style="min-width:0"><b' + (o.status === 'completed' ? ' style="text-decoration:line-through;opacity:.6"' : '') + '>' + esc(o.i.title) + '</b><small>' + esc(deptName(o.i.department) + ' · ' + label(o.i)) + (overdue(o) ? ' · <span style="color:#fca5a5">overdue</span>' : '') + '</small></div></li>'; }).join('') + '</ul>'
      + '<div class="cc-acts"><button class="cc-btn ghost" data-d>Dismiss</button><button class="cc-btn" data-v>View Calendar</button></div>';
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('on'); }, 30);
    var gone = function () { el.classList.remove('on'); setTimeout(function () { el.remove(); }, 260); };
    el.onclick = function (e) {
      var li = e.target.closest('[data-open]'); if (li) { gone(); return openItem(li.getAttribute('data-open'), li.getAttribute('data-date')); }
      if (e.target.closest('[data-d]')) return gone();
      if (e.target.closest('[data-v]')) { gone(); open({ view: 'today' }); }
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Boot (signed-in pages, not embedded frames)
  // ════════════════════════════════════════════════════════════════════════
  function addNav() {
    var links = document.querySelectorAll('#nav-acad-announcements, #nav-announcements, #hrtree-announcements, .sidebar-link[data-tab="announcements"], .sidebar-link[onclick*="\'announcements\'"], [data-sec="announcements"]');
    Array.prototype.forEach.call(links, function (a) {
      if (a._ccNav) return; a._ccNav = true;
      var b = document.createElement(a.tagName === 'A' ? 'a' : 'button'); if (b.tagName === 'BUTTON') b.type = 'button';
      b.className = String(a.className).replace(/\b(active|on|hidden)\b/g, '') + ' cc-nav-cal';
      b.setAttribute('style', a.getAttribute('style') || '');
      b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg> <span class="be-nav-label">Content Calendar</span>';
      b.onclick = function (e) { e.preventDefault(); try { if (typeof closeMobileSidebar === 'function') closeMobileSidebar(); } catch (_) {} open(); };
      a.insertAdjacentElement('afterend', b);
    });
  }
  function dispatch() { if (document.visibilityState === 'hidden') return; try { db().rpc('content_calendar_dispatch').then(function () {}, function () {}); } catch (_) {} }
  async function boot() {
    S.email = String(B().currentEmail() || '').toLowerCase();
    css(); addNav(); setTimeout(addNav, 2500);
    var sc;
    try { sc = await scope(); } catch (_) { return; }
    S.me = sc.me && sc.me.id;
    // Server reminder dispatcher: database time + delivered-once keys; open pages only trigger it.
    dispatch(); setInterval(dispatch, 120000);
    types().catch(function () {});
    setTimeout(function () { todaysPlan().catch(function () {}); }, 1800);
    // Deep links: #calendar, ?cal=<id>[&d=<date>]
    try { var q = new URLSearchParams(location.search); if (q.get('cal')) openItem(q.get('cal'), q.get('d')); else if (location.hash === '#calendar') open(); } catch (_) {}
    if (!window.BELive || !S.me) return;
    BELive.on('be-cal-items', [{ table: 'content_calendar_items', event: '*' }, { table: 'content_calendar_occurrences', event: '*' }, { table: 'content_calendar_assignees', event: '*' }], function () { refresh(); }, { debounce: 500 });
    // Assigned while the ERP is open → toast right away.
    BELive.on('be-cal-mine', [{ table: 'content_calendar_assignees', filter: 'employee_id=eq.' + S.me, event: 'INSERT' }], async function (evs) {
      for (var k = 0; k < (evs || []).length; k++) {
        var n = evs[k] && evs[k].new; if (!n) continue;
        try { var seen = JSON.parse(sessionStorage.getItem('be_cal_seen') || '[]'); if (seen.indexOf(n.item_id) > -1) continue; seen.push(n.item_id); sessionStorage.setItem('be_cal_seen', JSON.stringify(seen.slice(-50))); } catch (_) {}
        var i = await fetchItem(n.item_id); if (!i || i.created_by_employee_id === S.me) continue;
        (function (i) { note({ title: 'New calendar item', sub: 'You were assigned “' + i.title + '” — ' + (i.item_date === today() ? 'today' : fDay(i.item_date, { weekday: 'short' })) + (i.start_time ? ', ' + fTime(i.start_time) : ''), onView: function () { openItem(i.id, i.item_date); } }); })(i);
      }
    }, { debounce: 0 });
    // Reminders delivered by the server → small toast with View (also in the Notification Center).
    if (S.email) BELive.on('be-cal-rem', [{ table: 'erp_notifications', filter: 'recipient_email=eq.' + S.email, event: 'INSERT' }], function (evs) {
      (evs || []).forEach(function (p) {
        var n = p && p.new; if (!n || n.type !== 'calendar_reminder') return;
        var m = String(n.link || '').match(/^cal:([^:]+):?(.*)$/);
        note({ title: n.title, sub: n.message, onView: m ? function () { openItem(m[1], m[2]); } : null, ms: 9000 });
      });
    }, { debounce: 0 });
  }
  function openFromLink(link) { var m = String(link || '').match(/^cal:([^:]+):?(.*)$/); if (!m) return false; openItem(m[1], m[2] || null); return true; }

  window.BECal = { open: open, openItem: openItem, openFromLink: openFromLink, mountUpcoming: mountUpcoming, add: editor, todaysPlan: todaysPlan, refresh: refresh, _occurs: occurs };
  var embedded = /[?&]embed=1\b/.test(location.search) || window.self !== window.top;
  if (!embedded) { var tries = 0; (function w() { if (B().currentEmail && B().currentEmail()) return boot(); if (++tries < 60) setTimeout(w, 2000); })(); }
})();
