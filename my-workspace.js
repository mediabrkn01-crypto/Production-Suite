/* ============================================================================
   MY WORKSPACE — one shared system for Academic, Sales and Media/Production.
   Same UI + same functionality everywhere; the data is always the CURRENT
   employee's own (resolved by portal email), never another employee's.

   Page adapter:
     MyWorkspace.init({
       db:        <supabase client>,
       getEmail:  () => '<logged-in portal email>',
       getName:   () => '<display name>'            (optional, audit fallback),
       mounts:    { profile, announcements, attendance, leave, documents, payslips, team } -> element ids,
       navigate:  (panel) => void                   (optional, used by Profile quick access)
     });
     MyWorkspace.open('<panel>');                   // render into that panel's mount

   Business rules come from the shared LeavePolicy engine (leave-policy.js) — the
   same resolver HR payroll uses — so balances / attendance codes never diverge.
   ============================================================================ */
(function () {
  'use strict';
  var cfg = null, _me = null, _meEmail = null, _attMonth = null;

  // ------------------------------------------------------------------ utils
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function todayStr() { return ymd(new Date()); }
  function fDate(iso, withYear, withDay) {
    if (!iso) return '—';
    var d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return String(iso);
    var o = { day: '2-digit', month: 'short' }; if (withYear) o.year = 'numeric'; if (withDay) o.weekday = 'short';
    return d.toLocaleDateString('en-IN', o);
  }
  function fDT(iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function fRange(a, b) { return (!b || a === b) ? fDate(a, false, true) : fDate(a, false, true) + ' → ' + fDate(b, false, true); }
  function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
  function initials(n) { return String(n || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('') || '?'; }
  function photoOf(e) { return e && (e.photo_base64 || (e.photo_url || '')) || ''; }
  function avatar(e, name, size) {
    size = size || 36; var p = photoOf(e), n = (e && e.full_name) || name || '?';
    var st = 'width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.36) + 'px';
    if (p) return '<span class="mw-av" style="' + st + '"><img src="' + esc(p) + '" alt="" onerror="this.parentNode.textContent=\'' + esc(initials(n)) + '\'"></span>';
    return '<span class="mw-av" style="' + st + '">' + esc(initials(n)) + '</span>';
  }
  var SVG = {
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    wallet: '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>', x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
  };
  function ic(name, size) { size = size || 16; return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (SVG[name] || '') + '</svg>'; }
  function pill(txt, kind) { return '<span class="mw-pill mw-' + (kind || 'mute') + '">' + esc(txt) + '</span>'; }
  function empty(icon, t, s) { return '<div class="mw-empty"><div class="mw-empty-ic">' + ic(icon, 18) + '</div><div class="mw-empty-t">' + esc(t) + '</div>' + (s ? '<div class="mw-empty-s">' + esc(s) + '</div>' : '') + '</div>'; }
  function loading() { return '<div class="mw-loading"><span></span><span></span><span></span></div>'; }
  function header(title, sub, right) { return '<div class="mw-head"><div><h1>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>' + (right || '') + '</div>'; }
  function toast(kind, msg) {
    if (typeof window.showToast === 'function') { try { window.showToast(kind, msg); return; } catch (e) {} }
    var t = document.createElement('div'); t.className = 'mw-toast mw-toast-' + kind; t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10); setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 250); }, 3200);
  }
  function modal(html) {
    var o = document.createElement('div'); o.className = 'mw-modal-bg';
    o.innerHTML = '<div class="mw-modal">' + html + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o) o.remove(); });
    document.body.appendChild(o); return o;
  }
  function confirmBox(title, msg, okLabel) {
    return new Promise(function (res) {
      var o = modal('<div class="mw-modal-h"><h3>' + esc(title) + '</h3></div><p class="mw-modal-p">' + msg + '</p><div class="mw-modal-a"><button class="mw-btn" data-a="no">Keep</button><button class="mw-btn mw-btn-danger" data-a="yes">' + esc(okLabel || 'Confirm') + '</button></div>');
      o.querySelector('[data-a="no"]').onclick = function () { o.remove(); res(false); };
      o.querySelector('[data-a="yes"]').onclick = function () { o.remove(); res(true); };
    });
  }
  function el(panel) { var id = cfg && cfg.mounts && cfg.mounts[panel]; return id ? document.getElementById(id) : null; }
  function db() { return cfg.db; }
  function email() { return String((cfg.getEmail && cfg.getEmail()) || '').trim().toLowerCase(); }
  function likeExact(v) { return String(v || '').replace(/[\\%_]/g, function (c) { return '\\' + c; }); }
  function policy() { var LP = window.LeavePolicy; if (LP && !LP.db && LP.withClient) LP.withClient(db()); return LP && LP.db ? LP : null; }
  function refreshHost() { try { if (typeof window.loadMyHRData === 'function') window.loadMyHRData(); } catch (e) {} if (cfg.onChange) try { cfg.onChange(); } catch (e) {} }

  // ------------------------------------------------------------------ data
  async function me(force) {
    var em = email();
    if (!em) return null;
    if (_me && _meEmail === em && !force) return _me;
    var r = await db().from('hr_employees').select('*').ilike('portal_email', likeExact(em)).limit(1);
    _me = (r.data && r.data[0]) || null; _meEmail = em; return _me;
  }
  var DIV = { education: 'Education', production: 'Production House', hr: 'HR', accounts: 'Accounts', sales: 'Sales', other: 'Administration' };
  var DIVC = { education: '#10b981', production: '#7c3aed', sales: '#f59e0b', hr: '#3b82f6', accounts: '#06b6d4', other: '#94a3b8' };
  function divPill(d) { var c = DIVC[d] || '#94a3b8'; return '<span class="mw-pill" style="color:' + c + ';background:' + c + '1a;border-color:' + c + '40">' + esc(DIV[d] || d || '—') + '</span>'; }
  function roleInfo(e) {
    var roles = String(e && e.department || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var lvl = '', prim = roles[0] || '';
    ['Senior', 'Mid-Level', 'Junior'].forEach(function (l) { if (!lvl && prim.indexOf(l + ' ') === 0) { lvl = l; prim = prim.slice(l.length + 1); } });
    return { level: lvl, primary: prim, additional: roles.slice(1) };
  }
  function probationEnd(e) {
    if (!e || !e.joining_date || !e.probation_months) return null;
    var d = new Date(e.joining_date + 'T00:00:00'); d.setMonth(d.getMonth() + Number(e.probation_months)); return ymd(d);
  }
  function statusLabel(r) {
    if (r.status === 'rejected') return 'Rejected';
    if (r.status === 'cancelled') return 'Cancelled';
    if (r.final_treatment === 'exception') return 'Exception Approved';
    if (r.status === 'approved') return (r.final_treatment === 'lop' || r.final_treatment === 'lop_double') ? 'Approved (LOP)' : 'Approved';
    return 'Pending HR Review';
  }
  function noLink(title) { return header(title) + '<div class="mw-card">' + empty('user', 'No HR record linked to your login', 'Ask HR to link your portal email to your employee record.') + '</div>'; }

  // ================================================================== PROFILE
  async function renderProfile(root) {
    var e = await me(true); if (!e) { root.innerHTML = noLink('My Profile'); return; }
    var ri = roleInfo(e), pe = probationEnd(e), onProb = pe && pe >= todayStr();
    var mgr = null;
    if (e.manager_email) { var m = await db().from('hr_employees').select('full_name').ilike('portal_email', likeExact(String(e.manager_email).trim())).limit(1); mgr = m.data && m.data[0] ? m.data[0].full_name : null; }
    var f = function (l, v) { return '<div class="mw-field"><div class="mw-field-l">' + esc(l) + '</div><div class="mw-field-v">' + (v ? esc(v) : '<span class="mw-muted">—</span>') + '</div></div>'; };
    var quick = [['attendance', 'clock', 'My Attendance'], ['leave', 'calendar', 'My Leave'], ['documents', 'file', 'My Documents'], ['payslips', 'wallet', 'My Payslips'], ['announcements', 'megaphone', 'Announcements'], ['team', 'users', 'Team Members']]
      .filter(function (q) { return cfg.mounts[q[0]]; });
    root.innerHTML = header('My Profile', 'Your employee record — set by HR, updates here automatically.')
      + '<div class="mw-card mw-hero">' + avatar(e, e.full_name, 68)
      + '<div class="mw-hero-main"><div class="mw-hero-name">' + esc(e.full_name) + '</div>'
      + '<div class="mw-hero-sub">' + esc(ri.primary ? ((ri.level ? ri.level + ' ' : '') + ri.primary) : (e.designation || '—')) + '</div>'
      + '<div class="mw-row">' + divPill(e.division) + (e.employee_id ? pill(e.employee_id, 'mute') : '') + (onProb ? pill('Probation until ' + fDate(pe, true), 'warn') : pill(e.employment_status || 'active', e.employment_status === 'active' || !e.employment_status ? 'ok' : 'mute')) + '</div></div></div>'
      + '<div class="mw-card"><div class="mw-card-t">Details</div><div class="mw-fields">'
      + f('Employee ID', e.employee_id) + f('Department', DIV[e.division] || e.division)
      + f('Role', ri.primary ? ((ri.level ? ri.level + ' ' : '') + ri.primary) : '') + f('Level', ri.level)
      + f('Additional Roles', ri.additional.join(', ')) + f('Designation', e.designation)
      + f('Joining Date', e.joining_date ? fDate(e.joining_date, true) : '') + f('Date of Birth', e.dob ? fDate(e.dob, true) : '')
      + f('Phone', e.phone) + f('Portal Email', e.portal_email)
      + f('Reporting Manager', mgr ? mgr + ' (' + e.manager_email + ')' : e.manager_email) + f('Employment Status', e.employment_status)
      + f('Probation Period', e.probation_months ? e.probation_months + ' month(s)' : '') + f('Probation End Date', pe ? fDate(pe, true) : '')
      + f('Emergency Contact', [e.emergency_contact_name, e.emergency_contact_phone].filter(Boolean).join(' — '))
      + '</div></div>'
      + (quick.length && cfg.navigate ? '<div class="mw-card"><div class="mw-card-t">Quick access</div><div class="mw-quick">' + quick.map(function (q) { return '<button class="mw-quick-b" data-go="' + q[0] + '">' + ic(q[1], 18) + '<span>' + esc(q[2]) + '</span></button>'; }).join('') + '</div></div>' : '');
    root.querySelectorAll('[data-go]').forEach(function (b) { b.onclick = function () { cfg.navigate(b.getAttribute('data-go')); }; });
  }

  // ============================================================== ANNOUNCEMENTS
  function annApplies(a, e) {
    var aud = a.audience || 'all'; if (aud === 'all') return true; if (!e) return false;
    if (aud === 'selected') { var ids = a.audience_employee_ids; if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (x) { ids = []; } } return Array.isArray(ids) && ids.map(String).indexOf(String(e.id)) > -1; }
    return aud === e.division;
  }
  function annActive(a) { var n = Date.now(); if (a.start_at && n < new Date(a.start_at).getTime()) return false; if (a.end_at && n > new Date(a.end_at).getTime()) return false; return true; }
  async function renderAnnouncements(root) {
    var e = await me();
    var res = await Promise.all([
      db().from('hr_announcements').select('*').order('created_at', { ascending: false }),
      db().from('hr_announcement_reads').select('announcement_id').ilike('employee_email', likeExact(email()))
    ]);
    if (res[0].error) { root.innerHTML = header('Announcements') + '<div class="mw-card">' + empty('megaphone', 'Announcements aren\'t available right now', 'Ask your admin to check the announcements setup.') + '</div>'; return; }
    var list = (res[0].data || []).filter(function (a) { return annActive(a) && (e ? annApplies(a, e) : true); });
    var read = new Set((res[1].data || []).map(function (r) { return String(r.announcement_id); }));
    var unread = list.filter(function (a) { return !read.has(String(a.id)); }).length;
    root.innerHTML = header('Announcements', 'Messages from HR for you and your team.', unread ? pill(unread + ' new', 'brand') : '')
      + (list.length ? '<div class="mw-stack">' + list.map(function (a) {
        var isNew = !read.has(String(a.id)), pr = a.priority === 'urgent' ? pill('Urgent', 'bad') : a.priority === 'important' ? pill('Important', 'warn') : '';
        var ex = String(a.message || ''); ex = ex.length > 160 ? ex.slice(0, 160) + '…' : ex;
        return '<button class="mw-card mw-ann' + (isNew ? ' is-new' : '') + '" data-ann="' + esc(a.id) + '"><span class="mw-ic mw-ic-brand">' + ic('megaphone') + '</span><span class="mw-ann-main"><span class="mw-row"><b class="mw-ann-t">' + esc(a.title || 'Announcement') + '</b>' + pr + (a.category ? pill(a.category, 'brand') : '') + (isNew ? pill('New', 'new') : '') + '</span><span class="mw-ann-x">' + esc(ex) + '</span><span class="mw-meta">' + esc(fDT(a.created_at)) + (a.created_by ? ' · ' + esc(a.created_by) : '') + '</span></span></button>';
      }).join('') + '</div>' : '<div class="mw-card">' + empty('megaphone', 'No announcements yet', 'HR announcements for you will appear here.') + '</div>');
    root.querySelectorAll('[data-ann]').forEach(function (b) {
      b.onclick = async function () {
        var a = list.find(function (x) { return String(x.id) === b.getAttribute('data-ann'); }); if (!a) return;
        var o = modal('<div class="mw-modal-h"><div><div class="mw-row">' + (a.priority === 'urgent' ? pill('Urgent', 'bad') : a.priority === 'important' ? pill('Important', 'warn') : '') + (a.category ? pill(a.category, 'brand') : '') + '</div><h3>' + esc(a.title) + '</h3><div class="mw-meta">Sent ' + esc(fDT(a.created_at)) + (a.created_by ? ' · By ' + esc(a.created_by) : '') + '</div></div><button class="mw-x">' + ic('x', 18) + '</button></div><div class="mw-modal-body">' + esc(a.message || '') + '</div>');
        o.querySelector('.mw-x').onclick = function () { o.remove(); };
        if (!read.has(String(a.id)) && email()) {
          read.add(String(a.id));
          try { await db().from('hr_announcement_reads').insert({ announcement_id: a.id, employee_email: email(), read_at: new Date().toISOString() }); } catch (x) {}
          b.classList.remove('is-new'); var nb = b.querySelector('.mw-new'); if (nb) nb.remove();
          if (typeof window.renderAnnouncementBadge === 'function') try { window.renderAnnouncementBadge(); } catch (x) {}
        }
      };
    });
  }

  // ================================================================ ATTENDANCE
  var CODEC = { P: ['#10b981', 'Present'], L: ['#f59e0b', 'Late'], WFH: ['#a78bfa', 'WFH'], SL: ['#38bdf8', 'Sick Leave'], CL: ['#60a5fa', 'Casual Leave'], ML: ['#f472b6', 'Maternity'], WO: ['#64748b', 'Weekly Off'], H: ['#c084fc', 'Holiday'], OE: ['#ec4899', 'Official Event'], HD: ['#facc15', 'Half Day'], LOP: ['#f87171', 'LOP / Absent'] };
  async function attContext(e) {
    var LP = policy(); if (!LP) return null;
    var ctx = await LP.db.buildContext(e, { now: new Date(), date: todayStr() });
    try { var oe = await db().from('hr_official_events').select('*'); ctx.officialEvents = (oe.data || []).filter(function (x) { return !x.applies_to || x.applies_to === 'all' || x.applies_to === e.division; }); } catch (x) {}
    try {
      var logs = await db().from('attendance_logs').select('log_date').ilike('employee_email', likeExact(e.portal_email || email()));
      var set = new Set((logs.data || []).map(function (l) { return String(l.log_date).slice(0, 10); }));
      ctx.portalLog = function (d) { return set.has(d); };
    } catch (x) {}
    return ctx;
  }
  // Master Admin (account_type 'system') is not an employee — no personal attendance or leave.
  function notTracked(title) { return header(title, '') + '<div class="mw-card">' + empty('clock', 'Not tracked for this account', 'Master Admin isn\'t an employee — attendance, working hours and leave don\'t apply.') + '</div>'; }
  async function renderAttendance(root) {
    var e = await me(); if (!e) { root.innerHTML = noLink('My Attendance'); return; }
    if (e.account_type === 'system') { root.innerHTML = notTracked('My Attendance'); return; }
    if (!_attMonth) _attMonth = todayStr().slice(0, 7);
    var month = _attMonth, p = month.split('-').map(Number), label = new Date(p[0], p[1] - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    root.innerHTML = header('My Attendance', 'Your own attendance — present days, leave, weekly offs, holidays and LOP.',
      '<div class="mw-monthnav"><button class="mw-btn mw-btn-ic" data-m="-1">' + ic('left') + '</button><span>' + esc(label) + '</span><button class="mw-btn mw-btn-ic" data-m="1"' + (month >= todayStr().slice(0, 7) ? ' disabled' : '') + '>' + ic('right') + '</button></div>') + '<div class="mw-card">' + loading() + '</div>';
    root.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { var d = new Date(p[0], p[1] - 1 + Number(b.getAttribute('data-m')), 1); _attMonth = ymd(d).slice(0, 7); renderAttendance(root); }; });
    var LP = policy(), ctx = await attContext(e);
    var body = root.querySelector('.mw-card');
    if (!LP || !ctx) { body.innerHTML = empty('clock', 'Attendance engine unavailable', 'Please reload the page.'); return; }
    var pay = LP.resolvePayrollDeduction(ctx, month), b = pay.buckets;
    var stats = [['Present', b.present + b.late, '#10b981'], ['Late', b.late, '#f59e0b'], ['WFH', b.wfh, '#a78bfa'], ['Paid Leave', b.sl + b.cl + b.ml, '#60a5fa'], ['Weekly Off', b.wo, '#64748b'], ['Holidays / Events', b.holiday + b.oe, '#c084fc'], ['Half Days', b.half, '#facc15'], ['LOP days', pay.totalDeductionDays, '#f87171']];
    var days = new Date(p[0], p[1], 0).getDate(), first = new Date(p[0], p[1] - 1, 1).getDay(), today = todayStr();
    var cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(function (d) { return '<div class="mw-cal-h">' + d + '</div>'; });
    for (var i = 0; i < first; i++) cells.push('<div></div>');
    for (var d = 1; d <= days; d++) {
      var ds = month + '-' + String(d).padStart(2, '0');
      if (ds > today) { cells.push('<div class="mw-cal-d is-future"><span>' + d + '</span></div>'); continue; }
      var r = LP.resolveAttendanceStatus(ctx, ds), code = r.preJoining ? null : r.code, c = code && CODEC[code] ? CODEC[code][0] : null;
      var tip = r.label + (r.clockIn ? ' · in ' + new Date(r.clockIn).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '') + (r.clockOut ? ' · out ' + new Date(r.clockOut).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '');
      cells.push('<div class="mw-cal-d' + (ds === today ? ' is-today' : '') + '" title="' + esc(fDate(ds, true, true) + ' — ' + tip) + '"' + (c ? ' style="--c:' + c + '"' : '') + '><span>' + d + '</span><b>' + esc(r.preJoining ? '—' : (code === 'LOP' ? 'A' : code || '—')) + '</b></div>');
    }
    body.outerHTML = '<div class="mw-stats">' + stats.map(function (s) { return '<div class="mw-stat" style="--c:' + s[2] + '"><div class="mw-stat-n">' + s[1] + '</div><div class="mw-stat-l">' + s[0] + '</div></div>'; }).join('') + '</div>'
      + '<div class="mw-card"><div class="mw-cal">' + cells.join('') + '</div><div class="mw-legend">' + Object.keys(CODEC).map(function (k) { return '<span><i style="background:' + CODEC[k][0] + '"></i>' + (k === 'LOP' ? 'A' : k) + ' ' + CODEC[k][1] + '</span>'; }).join('') + '</div>'
      + (pay.incidents && pay.incidents.count ? '<div class="mw-note mw-note-warn">' + esc(pay.incidents.count + ' late-login / early-logout incident(s) this month' + (pay.incidentDays ? ' — ' + pay.incidentDays + ' day deduction' : '')) + '</div>' : '') + '</div>';
  }

  // ===================================================================== LEAVE
  var LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Maternity Leave', 'Exceptional WFH', 'Half Day'];
  async function renderLeave(root) {
    var e = await me(true); if (!e) { root.innerHTML = noLink('My Leave'); return; }
    if (e.account_type === 'system') { root.innerHTML = notTracked('My Leave'); return; }
    root.innerHTML = header('My Leave', 'Request leave and track your balance — reviewed by HR.')
      + '<div class="mw-grid2"><div class="mw-card"><div class="mw-card-t">Request leave</div>'
      + '<div class="mw-form">'
      + '<label class="mw-f"><span>Leave type</span><select data-f="type">' + LEAVE_TYPES.map(function (t) { return '<option>' + t + '</option>'; }).join('') + '</select></label>'
      + '<label class="mw-f" data-w="half" style="display:none"><span>Half type</span><select data-f="half"><option value="morning">Morning Half (off first half, work second)</option><option value="afternoon">Afternoon Half (work first half, off second)</option></select></label>'
      + '<div class="mw-f2"><label class="mw-f"><span>Start date</span><input type="date" data-f="start"></label><label class="mw-f" data-w="end"><span>End date</span><input type="date" data-f="end"></label></div>'
      + '<label class="mw-f"><span>Reason</span><textarea rows="2" data-f="reason" placeholder="Optional"></textarea></label>'
      + '<label class="mw-f"><span>Supporting document / medical certificate (link)</span><input data-f="proof" placeholder="https://… (required for Exceptional WFH / emergency Sick Leave)"></label>'
      + '<label class="mw-check"><input type="checkbox" data-f="emergency"> Emergency request (last-minute — notify HR + attach proof)</label>'
      + '<div class="mw-note">Leave is reviewed by HR. Max 2 consecutive days; leave adjacent to a weekly-off/holiday may be LOP unless an exception is granted; WFH is exceptional (medical) only.</div>'
      + '<div><button class="mw-btn mw-btn-primary" data-submit>Submit request</button></div></div></div>'
      + '<div class="mw-card"><div class="mw-card-t">My balances</div><div data-bal>' + loading() + '</div></div></div>'
      + '<div class="mw-card"><div class="mw-card-t">My requests</div><div data-list>' + loading() + '</div></div>';
    var q = function (s) { return root.querySelector('[data-f="' + s + '"]'); };
    q('type').onchange = function () { var h = q('type').value === 'Half Day'; root.querySelector('[data-w="half"]').style.display = h ? '' : 'none'; root.querySelector('[data-w="end"]').style.display = h ? 'none' : ''; };
    root.querySelector('[data-submit]').onclick = function () { submitLeave(root, e, q); };
    // balances
    (async function () {
      var box = root.querySelector('[data-bal]'), LP = policy();
      if (!LP) { box.innerHTML = empty('calendar', 'Balances unavailable right now'); return; }
      try {
        var t = todayStr(), ctx = await LP.db.buildContext(e, { now: new Date(), date: t });
        var bal = LP.resolveLeaveBalance(ctx), st = LP.getEmployeePolicyState(e, t), pay = LP.resolvePayrollDeduction(ctx, t.slice(0, 7));
        var why = function (u) { return u === 'probation' ? 'not in probation' : u === 'notice' ? 'not in notice period' : null; };
        var sl = bal.sick.remaining, cl = bal.casual.remaining, slNo = why(bal.sick.unavailable), clNo = why(bal.casual.unavailable);
        var slT = +bal.sick.entitlement || 1, clT = (+bal.casual.currentCredit || 0) + (+bal.casual.carriedForward || 0);
        var card = function (c, t2, n, sub, pct) { return '<div class="mw-bal" style="--c:' + c + '"><div class="mw-bal-t">' + t2 + '</div><div class="mw-bal-n">' + n + '<small>' + sub + '</small></div>' + (pct != null ? '<div class="mw-bar"><span style="width:' + Math.max(0, Math.min(100, pct)) + '%"></span></div>' : '') + '</div>'; };
        box.innerHTML = '<div class="mw-bals">' + card('#10b981', 'Sick Leave', sl, slNo || 'this month', sl / slT * 100)
          + card('#3b82f6', 'Casual Leave', cl, clNo || (bal.casual.carriedForward ? 'incl. ' + bal.casual.carriedForward + ' carried' : 'remaining'), clT ? cl / clT * 100 : 0)
          + card('#f87171', 'LOP days', pay.totalDeductionDays, 'this month', null) + '</div>'
          + (st.onProbation ? '<div class="mw-note mw-note-warn">Probation until ' + esc(fDate(st.confirmationDate, true)) + ' — ' + ([slNo ? 'no sick leave' : '', clNo ? 'no casual leave' : ''].filter(Boolean).join(', ') || 'leave allowed') + '; unpaid leave counts as LOP.</div>' : '')
          + (st.onNotice ? '<div class="mw-note mw-note-bad">Notice period — ' + (slNo || clNo ? 'paid leave not available; absence is LOP.' : 'leave allowed.') + '</div>' : '')
          + (LP.isPrePolicy && LP.isPrePolicy(t) ? '<div class="mw-note">New leave policy starts ' + esc(fDate(LP.P.LEAVE_SYSTEM_START, true)) + '.</div>' : '');
      } catch (x) { box.innerHTML = empty('calendar', 'Balances unavailable right now'); }
    })();
    // requests
    var reqs = await db().from('hr_leave_requests').select('*').eq('employee_id', e.id).order('requested_at', { ascending: false });
    var rows = reqs.data || [], today = todayStr(), list = root.querySelector('[data-list]');
    list.innerHTML = rows.length ? '<div class="mw-list">' + rows.map(function (r) {
      var k = r.status === 'approved' ? 'ok' : (r.status === 'rejected' || r.status === 'cancelled') ? 'bad' : 'warn';
      var can = r.status !== 'cancelled' && r.status !== 'rejected' && r.start_date > today;
      return '<div class="mw-item mw-edge-' + k + '"><span class="mw-ic">' + ic('calendar') + '</span><div class="mw-item-main"><div class="mw-row"><b>' + esc(r.leave_type || 'Leave') + '</b>' + (r.emergency ? pill('Emergency', 'warn') : '') + (r.half_day_type ? pill(r.half_day_type === 'morning' ? 'Morning half' : 'Afternoon half', 'mute') : '') + '</div><div class="mw-sub">' + esc(fRange(r.start_date, r.end_date)) + (r.days ? ' · ' + r.days + ' day' + (r.days === 1 ? '' : 's') : '') + (r.reason ? ' · ' + esc(r.reason) : '') + '</div>' + (r.policy_warning ? '<div class="mw-note mw-note-warn" style="margin-top:6px">' + esc(r.policy_warning) + '</div>' : '') + '</div><div class="mw-row mw-item-end">' + pill(statusLabel(r), k) + (can ? '<button class="mw-btn mw-btn-danger mw-btn-sm" data-cancel="' + esc(r.id) + '">Cancel</button>' : '') + '</div></div>';
    }).join('') + '</div>' : empty('calendar', 'No leave requests yet', 'Requests you submit will appear here with their HR status.');
    list.querySelectorAll('[data-cancel]').forEach(function (b) { b.onclick = function () { var r = rows.find(function (x) { return String(x.id) === b.getAttribute('data-cancel'); }); if (r) cancelLeave(root, e, r); }; });
  }
  async function submitLeave(root, e, q) {
    var type = q('type').value, half = type === 'Half Day', start = q('start').value, end = half ? start : q('end').value;
    var reason = q('reason').value.trim(), proof = q('proof').value.trim(), emergency = q('emergency').checked;
    if (!start || !end) { toast('warning', half ? 'Pick the date.' : 'Pick start and end dates.'); return; }
    var days = half ? 0.5 : Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
    if (days < 0.5) { toast('warning', 'End date must be on or after start date.'); return; }
    var btn = root.querySelector('[data-submit]'); btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      var policy_warning = null, final_treatment = 'pending', adjacency_flag = false, LP = policy();
      if (LP) { try { var ctx = await LP.db.buildContext(e, { now: new Date(), date: start }); var ev = LP.resolveLeaveEligibility(ctx, { leave_type: type, start_date: start, end_date: end, days: days, emergency: emergency }); if (ev.warnings && ev.warnings.length) { policy_warning = ev.warnings.join(' '); toast('info', 'Policy note: ' + ev.warnings[0]); } final_treatment = ev.treatment || 'pending'; adjacency_flag = !!(ev.adjacency && ev.adjacency.adjacent); } catch (x) {} }
      var auth = e.manager_email ? String(e.manager_email).trim().toLowerCase() : null;
      if (!auth && typeof window.hrResolveReportingAuthority === 'function') { try { var a = window.hrResolveReportingAuthority(e); auth = a ? a.email : null; } catch (x) {} }
      var rec = { employee_id: e.id, leave_type: type, start_date: start, end_date: end, days: days, reason: reason, status: 'pending', requested_at: new Date().toISOString(), manager_status: 'approved', hr_status: 'pending', reporting_authority_email: auth, emergency: emergency, proof_url: proof || null, policy_warning: policy_warning, final_treatment: final_treatment, adjacency_flag: adjacency_flag, consecutive_days: days };
      if (half) rec.half_day_type = q('half').value;
      var ins = await db().from('hr_leave_requests').insert([rec]);
      if (ins.error) throw ins.error;
      try { await db().from('hr_audit_log').insert([{ employee_id: e.id, actor_email: email(), actor_name: (cfg.getName && cfg.getName()) || e.full_name, action: 'leave_request', entity: 'leave_request', new_status: 'Pending HR Review', reason: reason, meta: { leave_type: type, start_date: start, end_date: end, days: days, emergency: emergency } }]); } catch (x) {}
      toast('success', 'Leave request submitted to HR.');
      refreshHost(); renderLeave(root);
    } catch (x) { toast('error', 'Could not submit request: ' + (x.message || x)); btn.disabled = false; btn.textContent = 'Submit request'; }
  }
  async function cancelLeave(root, e, r) {
    var today = todayStr();
    if (r.start_date <= today && r.status === 'approved') { toast('error', 'Cannot cancel leave that has already started.'); return; }
    var ok = await confirmBox('Cancel leave request', esc(r.leave_type || 'Leave') + ' · ' + esc(fRange(r.start_date, r.end_date)) + (r.days ? ' (' + r.days + ' day' + (r.days === 1 ? '' : 's') + ')' : '') + '<br>Are you sure you want to cancel it?', 'Yes, cancel leave');
    if (!ok) return;
    var actor = (cfg.getName && cfg.getName()) || e.full_name, prev = statusLabel(r);
    var up = await db().from('hr_leave_requests').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: actor }).eq('id', r.id).eq('employee_id', e.id);
    if (up.error) { toast('error', 'Could not cancel: ' + up.error.message); return; }
    if (r.hr_status === 'approved' || r.manager_status === 'approved') {
      for (var d = new Date(r.start_date + 'T00:00:00'); d <= new Date(r.end_date + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
        var ds = ymd(d); if (ds >= today) { try { await db().from('hr_attendance').delete().eq('employee_id', e.id).eq('att_date', ds).in('status', ['on_leave', 'half_day', 'wfh']); } catch (x) {} }
      }
    }
    if (/casual/i.test(r.leave_type || '') && r.days) {
      try { var bk = await db().from('hr_cl_buckets').select('*').eq('employee_id', e.id).order('credit_date', { ascending: true }); var restore = Number(r.days), B = bk.data || [];
        for (var i = B.length - 1; i >= 0 && restore > 0; i--) { var used = Number(B[i].original_amount) - Number(B[i].remaining_amount); if (used > 0) { var give = Math.min(used, restore); await db().from('hr_cl_buckets').update({ remaining_amount: Number(B[i].remaining_amount) + give }).eq('id', B[i].id); restore -= give; } } } catch (x) {}
    }
    if (/sick/i.test(r.leave_type || '') && r.days) {
      try { var sl = await db().from('hr_sl_ledger').select('*').eq('employee_id', e.id).eq('period', r.start_date.slice(0, 7)).maybeSingle(); if (sl.data && Number(sl.data.used) > 0) await db().from('hr_sl_ledger').update({ used: Math.max(0, Number(sl.data.used) - Number(r.days)) }).eq('id', sl.data.id); } catch (x) {}
    }
    try { await db().from('hr_audit_log').insert([{ employee_id: e.id, actor_email: email(), actor_name: actor, action: 'leave_cancel', entity: 'leave_request', entity_id: r.id, prev_status: prev, new_status: 'Cancelled', reason: 'Employee cancelled' }]); } catch (x) {}
    toast('success', 'Leave request cancelled. Balance restored.');
    refreshHost(); renderLeave(root);
  }

  // ================================================================= DOCUMENTS
  async function renderDocuments(root) {
    var e = await me(true); if (!e) { root.innerHTML = noLink('My Documents'); return; }
    var docs = String(e.document_links || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var name = function (u) { try { var x = new URL(u); var seg = decodeURIComponent(x.pathname.split('/').filter(Boolean).pop() || ''); return seg && !/^(view|edit|d|file|open|preview)$/i.test(seg) && seg.length < 60 ? seg : x.hostname.replace(/^www\./, ''); } catch (z) { return 'Document'; } };
    root.innerHTML = header('My Documents', 'Documents HR has shared on your employee record.')
      + '<div class="mw-card">' + (docs.length ? '<div class="mw-list">' + docs.map(function (u) { return '<a class="mw-item is-link" href="' + esc(u) + '" target="_blank" rel="noopener"><span class="mw-ic">' + ic('file') + '</span><div class="mw-item-main"><b>' + esc(name(u)) + '</b><div class="mw-sub mw-ellipsis">' + esc(u) + '</div></div><span class="mw-muted">' + ic('ext', 14) + '</span></a>'; }).join('') + '</div>' : empty('file', 'No documents on file yet', 'Documents HR adds to your record will appear here.')) + '</div>';
  }

  // ================================================================== PAYSLIPS
  async function renderPayslips(root) {
    var e = await me(); if (!e) { root.innerHTML = noLink('My Payslips'); return; }
    var r = await db().from('hr_payroll').select('*').eq('employee_id', e.id).eq('published', true);
    var rows = (r.data || []).slice().sort(function (a, b) { return String(b.month || '').localeCompare(String(a.month || '')); });
    var mLabel = function (m) { return /^\d{4}-\d{2}$/.test(m || '') ? new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : (m || '—'); };
    var isNew = function (p) { return (typeof notifications !== 'undefined' && Array.isArray(notifications)) ? notifications.some(function (n) { return n.id === 'payslip_' + p.id; }) : false; };
    root.innerHTML = header('My Payslips', 'Payslips HR has released to you.')
      + '<div class="mw-card">' + (rows.length ? '<div class="mw-list">' + rows.map(function (p) {
        var paid = p.payment_status === 'paid';
        return '<div class="mw-item"><span class="mw-ic mw-ic-ok">' + ic('wallet') + '</span><div class="mw-item-main"><div class="mw-row"><b>' + esc(mLabel(p.month)) + '</b>' + (isNew(p) ? pill('New', 'new') : '') + '</div><div class="mw-sub">' + (p.payment_date ? 'Paid on ' + esc(fDate(p.payment_date, true)) : paid ? 'Paid' : 'Payment pending') + '</div></div><div class="mw-item-end mw-row"><span class="mw-amount">' + money(p.net_salary) + '</span>' + pill(paid ? 'Paid' : (p.payment_status || 'Pending'), paid ? 'ok' : 'warn') + '<button class="mw-btn mw-btn-sm" data-dl="' + esc(p.id) + '">' + ic('dl', 14) + ' Download</button></div></div>';
      }).join('') + '</div>' : empty('wallet', 'No payslips yet', 'Payslips appear here once HR releases them.')) + '</div>';
    root.querySelectorAll('[data-dl]').forEach(function (b) { b.onclick = function () { var p = rows.find(function (x) { return String(x.id) === b.getAttribute('data-dl'); }); if (p) downloadPayslip(p, e, b); }; });
  }
  function loadJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
    return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  async function downloadPayslip(p, e, btn) {
    var lbl = btn.innerHTML; btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      // Prefer the official HR payslip builder when this page has it (identical PDF to HR's).
      if (typeof window.downloadHRPayslip === 'function' && typeof hrPayroll !== 'undefined' && Array.isArray(hrPayroll) && hrPayroll.some(function (x) { return x.id === p.id; })) {
        await window.downloadHRPayslip(p.id); return;
      }
      await loadJsPDF();
      var doc = new window.jspdf.jsPDF(), W = doc.internal.pageSize.getWidth(), y = 20;
      var ml = /^\d{4}-\d{2}$/.test(p.month || '') ? new Date(p.month + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : p.month;
      doc.setFillColor(255, 107, 6); doc.rect(0, 0, W, 6, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('Broken English', 14, y); doc.setFontSize(11); doc.setFont('helvetica', 'normal'); doc.text('Payslip — ' + ml, W - 14, y, { align: 'right' }); y += 12;
      doc.setFontSize(10);
      [['Employee', e.full_name], ['Employee ID', e.employee_id || '—'], ['Department', DIV[e.division] || e.division || '—'], ['Designation', e.designation || '—'], ['Payment status', p.payment_status || '—'], ['Payment date', p.payment_date || '—']].forEach(function (r2) { doc.setTextColor(110); doc.text(r2[0], 14, y); doc.setTextColor(20); doc.text(String(r2[1]), 70, y); y += 7; });
      y += 4; doc.setDrawColor(220); doc.line(14, y, W - 14, y); y += 8;
      var lines = [['Basic', p.basic], ['Allowances', p.allowances], ['Overtime', p.overtime], ['Bonuses', p.bonuses], ['Leave deduction', -(+p.leave_deduction || 0)], ['Other deductions', -(+p.deductions || 0)], ['Advances', -(+p.advances || 0)]];
      lines.forEach(function (l) { if (l[1] == null) return; doc.setTextColor(60); doc.text(l[0], 14, y); doc.text((l[1] < 0 ? '- ' : '') + 'Rs ' + Math.abs(+l[1] || 0).toLocaleString('en-IN'), W - 14, y, { align: 'right' }); y += 7; });
      y += 2; doc.line(14, y, W - 14, y); y += 9; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(20); doc.text('Net salary', 14, y); doc.text('Rs ' + Number(p.net_salary || 0).toLocaleString('en-IN'), W - 14, y, { align: 'right' });
      if (p.unpaid_leave_days) { y += 8; doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(120); doc.text('Includes ' + p.unpaid_leave_days + ' unpaid leave day(s).', 14, y); }
      doc.save('Payslip_' + String(e.full_name || 'employee').replace(/\s+/g, '_') + '_' + p.month + '.pdf');
      if (typeof window.dismissNotif === 'function') try { window.dismissNotif('payslip_' + p.id); } catch (x) {}
      toast('success', 'Payslip downloaded.');
    } catch (x) { toast('error', 'Unable to download payslip.'); }
    finally { btn.disabled = false; btn.innerHTML = lbl; }
  }

  // ==================================================================== TEAM
  async function renderTeam(root) {
    var e = await me(); if (!e) { root.innerHTML = noLink('Team Members'); return; }
    var t = todayStr();
    var ppl = await db().from('hr_employees').select('id,full_name,designation,department,division,photo_base64,photo_url,employment_status').eq('division', e.division).eq('employment_status', 'active').order('full_name');
    var team = ppl.data || [], ids = team.map(function (x) { return x.id; });
    var lv = ids.length ? await db().from('hr_leave_requests').select('employee_id,leave_type,start_date,end_date').eq('status', 'approved').lte('start_date', t).gte('end_date', t).in('employee_id', ids) : { data: [] };
    var today = {}; (lv.data || []).forEach(function (r) { today[r.employee_id] = r; });
    var wfh = team.filter(function (x) { return today[x.id] && /home|wfh/i.test(today[x.id].leave_type || ''); });
    var off = team.filter(function (x) { return today[x.id] && !/home|wfh/i.test(today[x.id].leave_type || ''); });
    var row = function (x) { var r = today[x.id]; return '<div class="mw-item">' + avatar(x, x.full_name, 36) + '<div class="mw-item-main"><b>' + esc(x.full_name) + (x.id === e.id ? ' <span class="mw-muted" style="font-weight:500">(you)</span>' : '') + '</b><div class="mw-sub">' + esc(x.designation || roleInfo(x).primary || '—') + '</div></div><div class="mw-item-end">' + (r ? (/home|wfh/i.test(r.leave_type || '') ? pill('Work from home', 'purple') : pill('On leave · until ' + fDate(r.end_date), 'warn')) : pill('Working today', 'ok')) + '</div></div>'; };
    root.innerHTML = header('Team Members', 'Your ' + (DIV[e.division] || 'team') + ' colleagues and who is out today.', divPill(e.division))
      + '<div class="mw-stats">' + [['Team size', team.length, '#3b82f6'], ['Working today', team.length - off.length - wfh.length, '#10b981'], ['On leave', off.length, '#f59e0b'], ['WFH', wfh.length, '#a78bfa']].map(function (s) { return '<div class="mw-stat" style="--c:' + s[2] + '"><div class="mw-stat-n">' + s[1] + '</div><div class="mw-stat-l">' + s[0] + '</div></div>'; }).join('') + '</div>'
      + (off.length || wfh.length ? '<div class="mw-card"><div class="mw-card-t">Out today</div><div class="mw-list">' + off.concat(wfh).map(row).join('') + '</div></div>' : '')
      + '<div class="mw-card"><div class="mw-card-t">Everyone</div>' + (team.length ? '<div class="mw-list">' + team.map(row).join('') + '</div>' : empty('users', 'No team members found')) + '</div>';
  }

  // =================================================================== CSS
  var CSS = [
    '.mw-root{color:#e6e9f5;font-family:inherit;display:flex;flex-direction:column;gap:16px}',
    '.mw-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}',
    '.mw-head h1{font-size:24px;font-weight:800;letter-spacing:-.01em;color:#fff;margin:0}',
    '.mw-head p{font-size:13px;color:#6b74a0;margin:4px 0 0}',
    '.mw-card{background:rgba(13,17,28,.72);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:18px 20px;backdrop-filter:blur(12px);text-align:left;width:100%;box-sizing:border-box}',
    '.mw-card-t{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#8890b5;margin-bottom:12px}',
    '.mw-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
    '.mw-muted{color:rgba(255,255,255,.3)}',
    '.mw-meta{font-size:11px;color:#6b74a0}',
    '.mw-pill{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid;white-space:nowrap;line-height:1.4}',
    '.mw-ok{color:#34d399;background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.3)}',
    '.mw-warn{color:#fbbf24;background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.3)}',
    '.mw-bad{color:#f87171;background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3)}',
    '.mw-purple{color:#a78bfa;background:rgba(124,58,237,.12);border-color:rgba(124,58,237,.3)}',
    '.mw-brand{color:#ff8a3d;background:rgba(255,107,6,.12);border-color:rgba(255,107,6,.3)}',
    '.mw-new{color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f);border-color:transparent}',
    '.mw-mute{color:rgba(255,255,255,.6);background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1)}',
    '.mw-av{border-radius:50%;overflow:hidden;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff6b06,#f9182f);color:#fff;font-weight:800;box-shadow:0 0 0 2px rgba(255,255,255,.06)}',
    '.mw-av img{width:100%;height:100%;object-fit:cover}',
    '.mw-ic{width:36px;height:36px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#a5adcf}',
    '.mw-ic-brand{color:#ff8a3d;background:rgba(255,107,6,.1);border-color:rgba(255,107,6,.28)}',
    '.mw-ic-ok{color:#34d399;background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.28)}',
    '.mw-hero{display:flex;align-items:center;gap:18px;flex-wrap:wrap}',
    '.mw-hero-main{display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.mw-hero-name{font-size:20px;font-weight:800;color:#fff}',
    '.mw-hero-sub{font-size:13px;color:#a5adcf}',
    '.mw-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));column-gap:28px}',
    '.mw-field{padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)}',
    '.mw-field-l{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b74a0}',
    '.mw-field-v{font-size:13.5px;color:#e6e9f5;margin-top:3px;word-break:break-word}',
    '.mw-quick{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}',
    '.mw-quick-b{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 10px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);color:#c7cbe0;font-size:12px;font-weight:600;cursor:pointer;transition:border-color .15s,background .15s}',
    '.mw-quick-b:hover{border-color:rgba(255,107,6,.4);background:rgba(255,107,6,.06);color:#fff}',
    '.mw-stack{display:flex;flex-direction:column;gap:10px}',
    '.mw-ann{display:flex;gap:14px;align-items:flex-start;cursor:pointer;transition:border-color .15s;font:inherit;color:inherit}',
    '.mw-ann:hover{border-color:rgba(255,107,6,.35)}',
    '.mw-ann.is-new{border-left:3px solid #ff6b06}',
    '.mw-ann-main{display:flex;flex-direction:column;gap:5px;min-width:0}',
    '.mw-ann-t{font-size:14px;color:#fff}',
    '.mw-ann-x{font-size:12.5px;color:#a5adcf;line-height:1.5}',
    '.mw-list{display:flex;flex-direction:column}',
    '.mw-item{display:flex;align-items:center;gap:12px;padding:12px 4px;border-top:1px solid rgba(255,255,255,.05);color:inherit;text-decoration:none}',
    '.mw-item:first-child{border-top:none}',
    '.mw-item.is-link:hover{background:rgba(255,255,255,.025);border-radius:10px}',
    '.mw-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.mw-item-main b{font-size:13.5px;color:#fff;font-weight:600}',
    '.mw-item-end{margin-left:auto;justify-content:flex-end}',
    '.mw-sub{font-size:12px;color:#8890b5}',
    '.mw-ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mw-edge-ok{box-shadow:inset 3px 0 0 #10b981;padding-left:12px}',
    '.mw-edge-warn{box-shadow:inset 3px 0 0 #f59e0b;padding-left:12px}',
    '.mw-edge-bad{box-shadow:inset 3px 0 0 #ef4444;padding-left:12px}',
    '.mw-amount{font-size:14px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums}',
    '.mw-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}',
    '.mw-stat{background:rgba(13,17,28,.72);border:1px solid rgba(255,255,255,.08);border-top:2px solid var(--c);border-radius:14px;padding:12px 14px}',
    '.mw-stat-n{font-size:22px;font-weight:800;color:var(--c);font-variant-numeric:tabular-nums}',
    '.mw-stat-l{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b74a0;margin-top:2px}',
    '.mw-monthnav{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:700;color:#fff}',
    '.mw-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}',
    '.mw-cal-h{text-align:center;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b74a0;padding-bottom:2px}',
    '.mw-cal-d{--c:rgba(255,255,255,.12);min-height:54px;border-radius:10px;border:1px solid color-mix(in srgb,var(--c) 35%,transparent);background:color-mix(in srgb,var(--c) 10%,transparent);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}',
    '.mw-cal-d span{font-size:10px;color:#8890b5;font-weight:600}',
    '.mw-cal-d b{font-size:12.5px;font-weight:800;color:var(--c)}',
    '.mw-cal-d.is-future{background:rgba(255,255,255,.015);border-color:rgba(255,255,255,.05)}',
    '.mw-cal-d.is-today{box-shadow:0 0 0 2px #ff6b06}',
    '.mw-legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px;font-size:11px;color:#8890b5}',
    '.mw-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:-1px}',
    '.mw-grid2{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px;align-items:start}',
    '@media(max-width:900px){.mw-grid2{grid-template-columns:1fr}}',
    '.mw-form{display:flex;flex-direction:column;gap:12px}',
    '.mw-f{display:flex;flex-direction:column;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b74a0;flex:1;min-width:0}',
    '.mw-f input,.mw-f select,.mw-f textarea{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;color:#fff;font-size:13px;font-family:inherit;outline:none;text-transform:none;letter-spacing:normal;font-weight:500;color-scheme:dark;width:100%;box-sizing:border-box}',
    '.mw-f input:focus,.mw-f select:focus,.mw-f textarea:focus{border-color:rgba(255,107,6,.6)}',
    '.mw-f2{display:flex;gap:12px;flex-wrap:wrap}',
    '.mw-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#c7cbe0;cursor:pointer}',
    '.mw-check input{width:16px;height:16px;accent-color:#ff6b06}',
    '.mw-note{font-size:11.5px;color:#8890b5;line-height:1.55;padding:9px 11px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}',
    '.mw-note-warn{color:#fbbf24;background:rgba(245,158,11,.07);border-color:rgba(245,158,11,.25)}',
    '.mw-note-bad{color:#f87171;background:rgba(239,68,68,.07);border-color:rgba(239,68,68,.25)}',
    '.mw-bals{display:flex;flex-direction:column;gap:10px}',
    '.mw-bal{padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-left:3px solid var(--c)}',
    '.mw-bal-t{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c)}',
    '.mw-bal-n{font-size:26px;font-weight:800;color:#fff;margin-top:4px;font-variant-numeric:tabular-nums}',
    '.mw-bal-n small{font-size:11.5px;font-weight:500;color:#6b74a0;margin-left:8px}',
    '.mw-bar{height:5px;border-radius:99px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:8px}',
    '.mw-bar span{display:block;height:100%;border-radius:99px;background:var(--c)}',
    '.mw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#e6e9f5;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:filter .15s,border-color .15s}',
    '.mw-btn:hover{border-color:rgba(255,255,255,.25)}',
    '.mw-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.mw-btn-sm{padding:6px 11px;font-size:11px}',
    '.mw-btn-ic{padding:7px;border-radius:9px}',
    '.mw-btn-primary{background:linear-gradient(135deg,#ff6b06,#f9182f);border-color:transparent;color:#fff;text-transform:uppercase;letter-spacing:.06em;box-shadow:0 4px 16px rgba(255,6,82,.25)}',
    '.mw-btn-primary:hover{filter:brightness(1.08)}',
    '.mw-btn-danger{color:#f87171;background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3)}',
    '.mw-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:150px;padding:20px;text-align:center}',
    '.mw-empty-ic{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#8890b5}',
    '.mw-empty-t{font-size:13px;font-weight:700;color:#c7cbe0}',
    '.mw-empty-s{font-size:11.5px;color:#6b74a0;max-width:320px;line-height:1.5}',
    '.mw-loading{display:flex;gap:6px;justify-content:center;padding:34px 0}',
    '.mw-loading span{width:7px;height:7px;border-radius:50%;background:#ff6b06;animation:mwP 1s infinite ease-in-out}',
    '.mw-loading span:nth-child(2){animation-delay:.15s}.mw-loading span:nth-child(3){animation-delay:.3s}',
    '@keyframes mwP{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}',
    '@media(prefers-reduced-motion:reduce){.mw-loading span{animation:none;opacity:.6}}',
    '.mw-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}',
    '.mw-modal{width:100%;max-width:520px;max-height:85vh;overflow:auto;background:#0d111c;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:20px 22px;color:#e6e9f5;box-shadow:0 24px 60px rgba(0,0,0,.5)}',
    '.mw-modal-h{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}',
    '.mw-modal-h h3{font-size:17px;font-weight:800;color:#fff;margin:6px 0 4px}',
    '.mw-modal-p{font-size:13px;color:#a5adcf;line-height:1.6;margin:0 0 16px}',
    '.mw-modal-body{font-size:13.5px;line-height:1.65;color:#e6e9f5;white-space:pre-wrap;word-break:break-word}',
    '.mw-modal-a{display:flex;justify-content:flex-end;gap:8px}',
    '.mw-x{background:none;border:none;color:#8890b5;cursor:pointer;padding:4px}',
    '.mw-toast{position:fixed;top:18px;right:18px;z-index:10000;padding:11px 16px;border-radius:12px;font-size:12.5px;font-weight:600;color:#fff;background:#1a2033;border:1px solid rgba(255,255,255,.12);opacity:0;transform:translateY(-6px);transition:all .25s}',
    '.mw-toast.on{opacity:1;transform:none}.mw-toast-success{border-color:rgba(16,185,129,.5)}.mw-toast-error{border-color:rgba(239,68,68,.5)}',
    '@media(max-width:640px){.mw-card{padding:14px}.mw-head h1{font-size:20px}.mw-item{flex-wrap:wrap}.mw-item-end{margin-left:48px}.mw-cal-d{min-height:44px}}'
  ].join('\n');
  function injectCSS() { if (document.getElementById('mw-css')) return; var s = document.createElement('style'); s.id = 'mw-css'; s.textContent = CSS; document.head.appendChild(s); }

  // =================================================================== API
  var RENDER = { profile: renderProfile, announcements: renderAnnouncements, attendance: renderAttendance, leave: renderLeave, documents: renderDocuments, payslips: renderPayslips, team: renderTeam };
  window.MyWorkspace = {
    init: function (c) {
      cfg = c || {}; injectCSS();
      // Pages without common.js (Academic, Sales) still need HR's saved leave policy.
      try {
        if (cfg.db && window.PolicyConfig && !PolicyConfig.isLoaded())
          PolicyConfig.load(cfg.db).then(function () { if (window.LeavePolicy && LeavePolicy.reloadPolicy) LeavePolicy.reloadPolicy(); });
      } catch (_) {}
    },
    open: async function (panel) {
      if (!cfg) return;
      var root = el(panel); if (!root || !RENDER[panel]) return;
      root.classList.add('mw-root');
      if (!root.innerHTML.trim()) root.innerHTML = '<div class="mw-card">' + loading() + '</div>';
      try { await RENDER[panel](root); }
      catch (e) { console.warn('MyWorkspace ' + panel + ' failed:', e); root.innerHTML = '<div class="mw-card">' + empty('inbox', 'Could not load this section', (e && e.message) || 'Please try again.') + '</div>'; }
    },
    reset: function () { _me = null; _meEmail = null; _attMonth = null; }
  };
})();
