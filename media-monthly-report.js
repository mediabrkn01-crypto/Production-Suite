/* ============================================================================
 * media-monthly-report.js — Media Head "Monthly Work Report" (Team / Individual).
 *
 * READ-ONLY reporting over the existing `assignments` table (+ reassignment history
 * from hr_audit_log, team from hr_employees). Never writes anything.
 *
 * Rules (documented so the numbers are explainable to management):
 *  - A work item belongs to the month of its assigned_date (set on every row).
 *  - status 'cancelled' rows are excluded. Only Production-division assignees count.
 *  - Status buckets mirror Team Workflow: Completed (delivered; approved or awaiting
 *    approval), In Progress, Pending, Rework Required, Rejected — each item in exactly one.
 *  - Overdue = still open (Pending / In Progress / Rework) and target date before today.
 *  - Completed date = submitted_at, else approved_at; blank when neither was recorded.
 *  - Reworked = a rework reason was recorded, or it is in rework now.
 *  - Reassigned = a work_reassigned / assignee-changing edit entry exists in hr_audit_log.
 *    Each task is counted ONCE, for its current assignee — never twice.
 * PDF: jsPDF (already loaded by index.html), tables + charts drawn directly.
 * ==========================================================================*/
(function () {
  'use strict';
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var ST = {
    completed: { t: 'Completed', c: '#22c55e', rgb: [34, 160, 90] },
    inprogress: { t: 'In Progress', c: '#60a5fa', rgb: [59, 130, 246] },
    pending: { t: 'Pending', c: '#fbbf24', rgb: [217, 160, 30] },
    rework: { t: 'Rework', c: '#fb923c', rgb: [234, 120, 40] },
    rejected: { t: 'Rejected', c: '#f87171', rgb: [220, 70, 70] }
  };
  var ORDER = ['completed', 'inprogress', 'pending', 'rework', 'rejected'];
  var S = { mode: 'team', y: null, m: null, emp: '', data: null, report: null, team: [] };

  function db() { return (typeof dbInstance !== 'undefined' && dbInstance) ? dbInstance : null; }
  function allowed() { var r = window._systemRole || ''; return r === 'media_head' || ['manager','founder','co_founder','managing_director','director'].indexOf(r) > -1; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function day(s) { return s ? String(s).slice(0, 10) : ''; }
  function fmtD(s) { s = day(s); if (!s) return '—'; var d = new Date(s + 'T00:00:00'); return isNaN(d) ? s : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  function prio(a) { var p = String(a.priority || 'medium').toLowerCase(); return p === 'low' ? 'Low' : p === 'very_high' ? 'Very High' : 'Medium'; }
  function bucket(a) {
    if (a.status === 'Rejected') return 'rejected';
    if (a.status === 'Rework Required') return 'rework';
    if (a.manager_approved || a.status === 'Completed') return 'completed';
    if (a.status === 'In Progress') return 'inprogress';
    return 'pending';
  }
  function completedOn(a) { return day(a.submitted_at) || day(a.approved_at) || ''; }
  function toast(t, m) { if (window.showToast) window.showToast(t, m); }

  // ---------------------------------------------------------------- data (read-only)
  async function loadData() {
    var d = db(); if (!d) throw new Error('Not connected.');
    var res = await Promise.all([
      d.from('assignments').select('id,topic,type,assigned_to,employee_email,assigned_by,assigned_date,date,status,priority,manager_approved,submitted_at,approved_at,rework_reason,cancelled_at').neq('status', 'cancelled'),
      d.from('hr_employees').select('full_name,portal_email,division,department,designation,employment_status,account_type'),
      d.from('hr_audit_log').select('action,meta,created_at').in('action', ['work_reassigned', 'work_assignment_edited']).order('created_at', { ascending: true })
    ]);
    if (res[0].error) throw new Error(res[0].error.message);
    var emps = res[1].data || [];
    var byEmail = {}; emps.forEach(function (e) { if (e.portal_email) byEmail[e.portal_email.toLowerCase()] = e; });
    // Reassignment history per task id (oldest first).
    var hist = {};
    (res[2].data || []).forEach(function (r) {
      var m = r.meta || {}, id = m.assignment_id; if (id == null) return;
      var from = null, to = null;
      if (r.action === 'work_reassigned') { from = m.previous_assignee; to = m.new_assignee; }
      else if (Array.isArray(m.changed) && m.changed.indexOf('assigned_to') > -1 && m.previous && m.updated) { from = m.previous.assigned_to; to = m.updated.assigned_to; }
      if (!from || from === to) return;
      (hist[String(id)] = hist[String(id)] || []).push({ from: from, to: to, at: r.created_at });
    });
    var rows = (res[0].data || []).filter(function (a) {
      if (a.cancelled_at || !a.assigned_date) return false;
      var e = byEmail[String(a.employee_email || '').toLowerCase()];
      return !e || e.division === 'production';   // keep Production work; no HR row = legacy creator, still Media work
    });
    var team = emps.filter(function (e) { return e.division === 'production' && (e.account_type || 'employee') === 'employee' && e.portal_email; });
    return { rows: rows, byEmail: byEmail, hist: hist, team: team };
  }

  function build(data, y, m, empEmail) {
    var key = y + '-' + pad(m), today = todayStr();
    var items = data.rows.filter(function (a) { return day(a.assigned_date).slice(0, 7) === key; });
    if (empEmail) items = items.filter(function (a) { return String(a.employee_email || '').toLowerCase() === empEmail; });
    items = items.map(function (a) {
      var b = bucket(a), h = data.hist[String(a.id)] || [];
      var open = b === 'pending' || b === 'inprogress' || b === 'rework';
      return {
        id: a.id, topic: a.topic || 'Untitled', type: a.type || '—', assignee: a.assigned_to || a.employee_email || '—',
        email: String(a.employee_email || '').toLowerCase(), assigned: day(a.assigned_date), target: day(a.date),
        done: b === 'completed' ? completedOn(a) : '', b: b, approved: !!a.manager_approved, priority: prio(a),
        overdue: open && !!a.date && day(a.date) < today,
        reworked: !!(a.rework_reason && String(a.rework_reason).trim()) || b === 'rework',
        reassigned: h.length > 0, original: h.length ? h[0].from : ''
      };
    }).sort(function (x, z) { return x.assigned === z.assigned ? String(x.topic).localeCompare(z.topic) : x.assigned.localeCompare(z.assigned); });
    var c = { total: items.length, overdue: 0, reworked: 0, reassigned: 0, approved: 0 };
    ORDER.forEach(function (k) { c[k] = 0; });
    items.forEach(function (i) { c[i.b]++; if (i.overdue) c.overdue++; if (i.reworked) c.reworked++; if (i.reassigned) c.reassigned++; if (i.approved) c.approved++; });
    c.pct = c.total ? Math.round(c.completed / c.total * 100) : 0;
    // Completions per day of the month (only items with a recorded completion date in this month).
    var dim = new Date(y, m, 0).getDate(), daily = [], dated = 0;
    for (var i = 1; i <= dim; i++) daily.push(0);
    items.forEach(function (it) { if (it.done && it.done.slice(0, 7) === key) { daily[+it.done.slice(8, 10) - 1]++; dated++; } });
    // Per-employee breakdown (team report).
    var per = {};
    items.forEach(function (it) {
      var p = per[it.email || it.assignee] || (per[it.email || it.assignee] = { name: it.assignee, total: 0, completed: 0, inprogress: 0, pending: 0, rework: 0, rejected: 0, overdue: 0 });
      p.total++; p[it.b]++; if (it.overdue) p.overdue++;
    });
    var people = Object.keys(per).map(function (k) { var p = per[k]; p.pct = p.total ? Math.round(p.completed / p.total * 100) : 0; return p; })
      .sort(function (a, b) { return b.completed - a.completed || b.total - a.total || a.name.localeCompare(b.name); });
    // Trend: completed per assigned-month for the 6 months ending at the selected month (same scope).
    var trend = [];
    for (var k = 5; k >= 0; k--) {
      var dt = new Date(y, m - 1 - k, 1), tk = dt.getFullYear() + '-' + pad(dt.getMonth() + 1);
      var set = data.rows.filter(function (a) { return day(a.assigned_date).slice(0, 7) === tk && (!empEmail || String(a.employee_email || '').toLowerCase() === empEmail); });
      trend.push({ label: MONTHS[dt.getMonth()].slice(0, 3) + ' ' + String(dt.getFullYear()).slice(2), total: set.length, completed: set.filter(function (a) { return bucket(a) === 'completed'; }).length });
    }
    var emp = empEmail ? (data.byEmail[empEmail] || null) : null;
    return { y: y, m: m, key: key, label: MONTHS[m - 1] + ' ' + y, mode: empEmail ? 'individual' : 'team', items: items, c: c, daily: daily, dated: dated, people: people, trend: trend,
      emp: emp, empName: emp ? emp.full_name : (items[0] && items[0].assignee) || empEmail, empDept: emp ? (emp.designation || String(emp.department || '').split(',')[0] || 'Production') : 'Production' };
  }

  // ---------------------------------------------------------------- page UI
  function el(id) { return document.getElementById(id); }
  function selectHTML(id, opts, val, extra) {
    return '<select id="' + id + '" class="mwr-sel"' + (extra || '') + '>' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(val) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }
  function renderShell() {
    var root = el('mwr-root'); if (!root) return;
    if (!allowed()) { root.innerHTML = '<div class="card glass-card rounded-2xl" style="padding:24px;color:#6b74a0;font-size:13px">Not authorized.</div>'; return; }
    var now = new Date(); if (S.y == null) { S.y = now.getFullYear(); S.m = now.getMonth() + 1; }
    var years = []; for (var yy = now.getFullYear(); yy >= 2026; yy--) years.push([yy, yy]);
    if (years.every(function (o) { return o[0] !== S.y; })) years.push([S.y, S.y]);
    var empOpts = [['', 'Select employee']].concat(S.team.map(function (e) { return [e.portal_email.toLowerCase(), e.full_name + (e.employment_status === 'active' ? '' : ' (inactive)')]; }));
    root.innerHTML =
      '<div class="card glass-card rounded-2xl mwr-bar">' +
        '<div class="mwr-seg" role="group" aria-label="Report type">' +
          '<button type="button" data-mode="team" class="' + (S.mode === 'team' ? 'on' : '') + '">Team Report</button>' +
          '<button type="button" data-mode="individual" class="' + (S.mode === 'individual' ? 'on' : '') + '">Individual Report</button>' +
        '</div>' +
        '<label class="mwr-f"><span>Month</span>' + selectHTML('mwr-m', MONTHS.map(function (n, i) { return [i + 1, n]; }), S.m) + '</label>' +
        '<label class="mwr-f"><span>Year</span>' + selectHTML('mwr-y', years, S.y) + '</label>' +
        (S.mode === 'individual' ? '<label class="mwr-f mwr-f-emp"><span>Employee</span>' + selectHTML('mwr-e', empOpts, S.emp) + '</label>' : '') +
        '<button type="button" id="mwr-go" class="brand-gradient mwr-go">Generate Report</button>' +
      '</div>' +
      '<div id="mwr-out"></div>';
    root.querySelectorAll('[data-mode]').forEach(function (b) { b.onclick = function () { S.mode = b.dataset.mode; S.report = null; renderShell(); }; });
    el('mwr-m').onchange = function () { S.m = +this.value; };
    el('mwr-y').onchange = function () { S.y = +this.value; };
    if (el('mwr-e')) el('mwr-e').onchange = function () { S.emp = this.value; };
    el('mwr-go').onclick = generate;
    if (S.report) renderReport(S.report); else el('mwr-out').innerHTML = '<div class="card glass-card rounded-2xl mwr-empty">Pick a month and generate the report to preview it here.</div>';
  }
  async function generate() {
    if (!allowed()) return;
    if (S.mode === 'individual' && !S.emp) { toast('error', 'Select an employee first.'); return; }
    var out = el('mwr-out'); out.innerHTML = '<div class="card glass-card rounded-2xl mwr-empty">Building report…</div>';
    try {
      S.data = await loadData();
      S.report = build(S.data, S.y, S.m, S.mode === 'individual' ? S.emp : '');
      renderReport(S.report);
    } catch (e) { out.innerHTML = '<div class="card glass-card rounded-2xl mwr-empty" style="color:#f87171">Could not build the report. ' + esc(e.message || '') + '</div>'; }
  }
  function tile(n, l, c, sub) { return '<div class="mwr-tile"><div class="mwr-tile-n"' + (c ? ' style="color:' + c + '"' : '') + '>' + n + '</div><div class="mwr-tile-l">' + l + '</div>' + (sub ? '<div class="mwr-tile-s">' + sub + '</div>' : '') + '</div>'; }
  function hbars(rows, max) {
    max = Math.max(1, max || 0);
    return rows.map(function (r) {
      return '<div class="mwr-hb"><span class="mwr-hb-l">' + esc(r.l) + '</span><span class="mwr-hb-t"><i style="width:' + (r.v / max * 100) + '%;background:' + r.c + '"></i></span><span class="mwr-hb-v">' + r.v + '</span></div>';
    }).join('');
  }
  function colsSVG(vals, color, labels) {
    var w = 560, h = 150, n = vals.length, max = Math.max.apply(null, vals.concat([1])), bw = w / n;
    var bars = vals.map(function (v, i) { var bh = v / max * (h - 36); return '<rect x="' + (i * bw + bw * .18) + '" y="' + (h - 18 - bh) + '" width="' + (bw * .64) + '" height="' + Math.max(v ? 2 : 0, bh) + '" rx="2" fill="' + color + '"/>' + (v ? '<text x="' + (i * bw + bw / 2) + '" y="' + (h - 22 - bh) + '" text-anchor="middle" font-size="9" fill="#c7cbe0">' + v + '</text>' : ''); }).join('');
    var lab = labels.map(function (t, i) { return t ? '<text x="' + (i * bw + bw / 2) + '" y="' + (h - 4) + '" text-anchor="middle" font-size="9" fill="#6b74a0">' + esc(t) + '</text>' : ''; }).join('');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="mwr-svg" role="img"><line x1="0" y1="' + (h - 18) + '" x2="' + w + '" y2="' + (h - 18) + '" stroke="rgba(255,255,255,.1)"/>' + bars + lab + '</svg>';
  }
  function table(head, rows) {
    if (!rows.length) return '<div class="mwr-none">Nothing to show.</div>';
    return '<div class="mwr-tw"><table class="mwr-t"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function chip(b) { var s = ST[b]; return '<span class="mwr-chip" style="color:' + s.c + ';border-color:' + s.c + '55;background:' + s.c + '14">' + s.t + '</span>'; }
  function renderReport(R) {
    var out = el('mwr-out'); if (!out) return;
    var c = R.c;
    var head = '<div class="mwr-rh"><div><div class="mwr-eyebrow">' + (R.mode === 'team' ? 'Team Monthly Report' : 'Individual Monthly Report') + '</div>' +
      '<h2>' + (R.mode === 'team' ? 'Media Team' : esc(R.empName)) + ' · ' + esc(R.label) + '</h2>' +
      (R.mode === 'individual' ? '<p>' + esc(R.empDept) + '</p>' : '<p>' + R.people.length + ' team member' + (R.people.length === 1 ? '' : 's') + ' with work this month</p>') + '</div>' +
      '<button type="button" id="mwr-pdf" class="brand-gradient mwr-go"' + '>Download PDF</button></div>';
    if (!c.total) {
      out.innerHTML = '<div class="card glass-card rounded-2xl mwr-card">' + head + '<div class="mwr-empty" style="padding:28px 0 6px">No work was assigned in ' + esc(R.label) + (R.mode === 'individual' ? ' to ' + esc(R.empName) : '') + '.</div></div>';
      el('mwr-pdf').onclick = function () { downloadPDF(R); };
      return;
    }
    var tiles = '<div class="mwr-tiles">' + tile(c.total, 'Total work') + tile(c.completed, 'Completed', ST.completed.c, c.approved + ' approved') + tile(c.inprogress, 'In progress', ST.inprogress.c) +
      tile(c.pending, 'Pending', ST.pending.c) + tile(c.overdue, 'Overdue', c.overdue ? '#f87171' : '', 'open & past due') + tile(c.pct + '%', 'Completion') + '</div>' +
      '<div class="mwr-mini">Rework: <b>' + c.reworked + '</b> · Reassigned: <b>' + c.reassigned + '</b> · Rejected: <b>' + c.rejected + '</b>' + (R.mode === 'team' ? ' · Team members: <b>' + R.people.length + '</b>' : '') + '</div>';
    var charts = '<div class="mwr-charts">' +
      '<div class="mwr-chart"><div class="mwr-ct">Work status distribution</div>' + hbars(ORDER.map(function (k) { return { l: ST[k].t, v: c[k], c: ST[k].c }; }).concat([{ l: 'Overdue', v: c.overdue, c: '#f87171' }]), c.total) + '</div>' +
      (R.dated ? '<div class="mwr-chart"><div class="mwr-ct">Work completed across ' + esc(MONTHS[R.m - 1]) + '</div>' + colsSVG(R.daily, '#22c55e', R.daily.map(function (v, i) { return (i === 0 || (i + 1) % 5 === 0) ? String(i + 1) : ''; })) + '<div class="mwr-note">By completion date (' + R.dated + ' of ' + c.completed + ' completed items have one recorded).</div></div>' : '') +
      (R.mode === 'team' && R.people.length > 1 ? '<div class="mwr-chart"><div class="mwr-ct">Completed by team member</div>' + hbars(R.people.map(function (p) { return { l: p.name, v: p.completed, c: '#ff8a3c' }; }), Math.max.apply(null, R.people.map(function (p) { return p.completed; }))) + '</div>' : '') +
      (R.trend.filter(function (t) { return t.total; }).length >= 3 ? '<div class="mwr-chart"><div class="mwr-ct">Completed work — last 6 months</div>' + colsSVG(R.trend.map(function (t) { return t.completed; }), '#60a5fa', R.trend.map(function (t) { return t.label; })) + '</div>' : '') +
      '</div>';
    var workRows = function (list) { return list.map(function (i) { return [esc(i.topic) + (i.reworked ? ' <span class="mwr-tag">Rework</span>' : ''), esc(i.type), esc(i.assignee) + (i.reassigned ? '<div class="mwr-sub">from ' + esc(i.original) + '</div>' : ''), fmtD(i.assigned), fmtD(i.target) + (i.overdue ? '<div class="mwr-sub" style="color:#f87171">Overdue</div>' : ''), i.done ? fmtD(i.done) : '—', chip(i.b), esc(i.priority)]; }); };
    var H = ['Work', 'Type', 'Assignee', 'Assigned', 'Target', 'Completed', 'Status', 'Priority'];
    var people = R.mode === 'team' ? '<div class="mwr-sec">Employee breakdown</div>' + table(['Employee', 'Total', 'Completed', 'In progress', 'Pending', 'Rework', 'Overdue', 'Completion'],
      R.people.map(function (p) { return [esc(p.name), p.total, p.completed, p.inprogress, p.pending, p.rework, p.overdue, p.pct + '%']; })) : '';
    var lists = R.mode === 'team'
      ? '<div class="mwr-sec">Work details (' + R.items.length + ')</div>' + table(H, workRows(R.items))
      : '<div class="mwr-sec">Completed work (' + c.completed + ')</div>' + table(H, workRows(R.items.filter(function (i) { return i.b === 'completed'; }))) +
        '<div class="mwr-sec">Open work (' + (c.pending + c.inprogress + c.rework) + ')</div>' + table(H, workRows(R.items.filter(function (i) { return i.b === 'pending' || i.b === 'inprogress' || i.b === 'rework'; }))) +
        (c.rejected ? '<div class="mwr-sec">Rejected (' + c.rejected + ')</div>' + table(H, workRows(R.items.filter(function (i) { return i.b === 'rejected'; }))) : '');
    out.innerHTML = '<div class="card glass-card rounded-2xl mwr-card">' + head + tiles + charts + people + lists +
      '<div class="mwr-foot">Based on work assigned in ' + esc(R.label) + '. Status is as of today. Cancelled work is not included.</div></div>';
    el('mwr-pdf').onclick = function () { downloadPDF(R); };
  }

  // ---------------------------------------------------------------- PDF (jsPDF, drawn directly)
  function downloadPDF(R) {
    var JS = window.jspdf && window.jspdf.jsPDF; if (!JS) { toast('error', 'PDF tools are still loading. Try again in a moment.'); return; }
    var doc = new JS({ unit: 'pt', format: 'a4' }), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40, y = 0;
    var INK = [24, 26, 38], MUTE = [110, 116, 140], LINE = [225, 228, 236], ACC = [255, 107, 6];
    var gen = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    var title = R.mode === 'team' ? 'Media Team' : R.empName;
    function txt(s) { return String(s == null ? '' : s).replace(/[^\x20-\x7E -ÿ–—‘’“”•]/g, ''); }
    function footer() {
      var n = doc.internal.getNumberOfPages();
      for (var p = 1; p <= n; p++) { doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor.apply(doc, MUTE);
        doc.text('Broken English Studio  •  Media Monthly Work Report  •  ' + txt(R.label), M, H - 22); doc.text('Page ' + p + ' of ' + n, W - M, H - 22, { align: 'right' }); }
    }
    function need(h) { if (y + h > H - 50) { doc.addPage(); y = 50; return true; } return false; }
    function section(t) { need(90); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor.apply(doc, INK); doc.text(txt(t), M, y); doc.setDrawColor.apply(doc, ACC); doc.setLineWidth(1.5); doc.line(M, y + 5, M + 28, y + 5); y += 20; }
    function tbl(head, rows, widths) {
      var x0 = M, total = widths.reduce(function (s, w) { return s + w; }, 0), sc = (W - 2 * M) / total; widths = widths.map(function (w) { return w * sc; });
      function hdr() { doc.setFillColor(244, 245, 249); doc.rect(x0, y, W - 2 * M, 20, 'F'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor.apply(doc, MUTE);
        var x = x0; head.forEach(function (h, i) { doc.text(txt(h).toUpperCase(), x + 5, y + 13); x += widths[i]; }); y += 20; }
      if (!rows.length) { need(24); doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor.apply(doc, MUTE); doc.text('Nothing to show.', x0, y + 10); y += 22; return; }
      need(44); hdr();
      rows.forEach(function (r) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
        var cells = r.map(function (c, i) { return doc.splitTextToSize(txt(c.t != null ? c.t : c), widths[i] - 10).slice(0, 3); });
        var rh = Math.max.apply(null, cells.map(function (l) { return l.length; })) * 10.5 + 9;
        if (need(rh)) hdr();
        var x = x0;
        cells.forEach(function (lines, i) { var cc = r[i] && r[i].rgb; doc.setTextColor.apply(doc, cc || INK); if (r[i] && r[i].b) doc.setFont('helvetica', 'bold'); else doc.setFont('helvetica', 'normal'); doc.text(lines, x + 5, y + 13); x += widths[i]; });
        y += rh; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.line(x0, y, W - M, y);
      });
      y += 14;
    }
    function hbarChart(t, rows, max) {
      var h = 24 + rows.length * 20; need(h + 10); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor.apply(doc, INK); doc.text(txt(t), M, y); y += 14;
      var lw = 110, bw = W - 2 * M - lw - 40; max = Math.max(1, max);
      rows.forEach(function (r) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor.apply(doc, INK); doc.text(txt(r.l).slice(0, 26), M, y + 9);
        doc.setFillColor(240, 241, 246); doc.rect(M + lw, y + 1, bw, 11, 'F'); doc.setFillColor.apply(doc, r.rgb); if (r.v) doc.rect(M + lw, y + 1, Math.max(2, bw * r.v / max), 11, 'F');
        doc.setFont('helvetica', 'bold'); doc.text(String(r.v), M + lw + bw + 8, y + 10); y += 20; });
      y += 10;
    }
    function colChart(t, vals, labels, rgb, note) {
      var ch = 120; need(ch + 50); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor.apply(doc, INK); doc.text(txt(t), M, y); y += 12;
      var cw = W - 2 * M, n = vals.length, bw = cw / n, max = Math.max.apply(null, vals.concat([1])), base = y + ch;
      doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); [0.25, 0.5, 0.75, 1].forEach(function (f) { doc.line(M, base - ch * f, M + cw, base - ch * f); });
      doc.setFillColor.apply(doc, rgb);
      vals.forEach(function (v, i) { var bh = v / max * (ch - 12); if (v) { doc.setFillColor.apply(doc, rgb); doc.rect(M + i * bw + bw * .18, base - bh, bw * .64, bh, 'F'); doc.setFontSize(7); doc.setTextColor.apply(doc, INK); doc.text(String(v), M + i * bw + bw / 2, base - bh - 3, { align: 'center' }); }
        if (labels[i]) { doc.setFontSize(7); doc.setTextColor.apply(doc, MUTE); doc.text(txt(labels[i]), M + i * bw + bw / 2, base + 10, { align: 'center' }); } });
      doc.setDrawColor(190, 194, 206); doc.line(M, base, M + cw, base); y = base + 22;
      if (note) { doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor.apply(doc, MUTE); doc.text(txt(note), M, y); y += 14; }
      y += 6;
    }

    // ---- Page 1: cover + summary
    doc.setFillColor(14, 12, 18); doc.rect(0, 0, W, 150, 'F');
    doc.setFillColor.apply(doc, ACC); doc.rect(0, 150, W, 3, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(255, 138, 60); doc.text('BROKEN ENGLISH STUDIO  •  MEDIA', M, 46);
    doc.setFontSize(26); doc.setTextColor(255, 255, 255); doc.text('Monthly Work Report', M, 82);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(13); doc.setTextColor(200, 204, 222); doc.text(txt(R.label + '  —  ' + (R.mode === 'team' ? 'Team Report' : 'Individual Report')), M, 108);
    doc.setFontSize(9); doc.setTextColor(150, 156, 184); doc.text('Generated ' + txt(gen), M, 130);
    y = 190;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor.apply(doc, INK); doc.text(txt(title), M, y); y += 16;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor.apply(doc, MUTE);
    doc.text(txt(R.mode === 'team' ? ('Production team  •  ' + R.people.length + ' member' + (R.people.length === 1 ? '' : 's') + ' with work this month') : (R.empDept + '  •  Reporting month: ' + R.label)), M, y); y += 30;
    var c = R.c, stats = [['Total work', c.total], ['Completed', c.completed], ['In progress', c.inprogress], ['Pending', c.pending], ['Overdue', c.overdue], ['Completion', c.pct + '%'],
      ['Approved', c.approved], ['Rework', c.reworked], ['Reassigned', c.reassigned], ['Rejected', c.rejected]];
    if (R.mode === 'team') stats.push(['Team members', R.people.length]);
    var cols = 3, gw = (W - 2 * M - (cols - 1) * 12) / cols, gh = 58;
    stats.forEach(function (s, i) { var cx = M + (i % cols) * (gw + 12), cy = y + Math.floor(i / cols) * (gh + 12);
      doc.setFillColor(247, 248, 251); doc.setDrawColor.apply(doc, LINE); doc.roundedRect(cx, cy, gw, gh, 6, 6, 'FD');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor.apply(doc, INK); doc.text(String(s[1]), cx + 14, cy + 30);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor.apply(doc, MUTE); doc.text(s[0].toUpperCase(), cx + 14, cy + 46); });
    y += Math.ceil(stats.length / cols) * (gh + 12) + 14;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor.apply(doc, MUTE);
    doc.text(doc.splitTextToSize('Scope: work assigned in ' + R.label + ' (by assigned date). Status as of the generated date. Overdue = still open and past its target date. Cancelled work is excluded; reassigned work is counted once, for its current assignee.', W - 2 * M), M, y);

    // ---- Page 2+: charts, breakdowns, tables
    doc.addPage(); y = 50;
    if (!c.total) {
      section('Details'); doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor.apply(doc, MUTE);
      doc.text(txt('No work was assigned in ' + R.label + (R.mode === 'individual' ? ' to ' + R.empName : '') + '.'), M, y); y += 20;
    } else {
      section('Charts');
      hbarChart('Work status distribution', ORDER.map(function (k) { return { l: ST[k].t, v: c[k], rgb: ST[k].rgb }; }).concat([{ l: 'Overdue (open)', v: c.overdue, rgb: [220, 70, 70] }]), c.total);
      if (R.dated) colChart('Work completed across ' + MONTHS[R.m - 1] + ' ' + R.y, R.daily, R.daily.map(function (v, i) { return (i === 0 || (i + 1) % 5 === 0) ? String(i + 1) : ''; }), [34, 160, 90], 'By completion date (' + R.dated + ' of ' + c.completed + ' completed items have one recorded).');
      if (R.mode === 'team' && R.people.length > 1) hbarChart('Completed work by team member', R.people.map(function (p) { return { l: p.name, v: p.completed, rgb: ACC }; }), Math.max.apply(null, R.people.map(function (p) { return p.completed; })));
      if (R.trend.filter(function (t) { return t.total; }).length >= 3) colChart('Completed work - last 6 months (by assigned month)', R.trend.map(function (t) { return t.completed; }), R.trend.map(function (t) { return t.label; }), [59, 130, 246]);
      if (R.mode === 'team') {
        section('Employee breakdown');
        tbl(['Employee', 'Total', 'Done', 'In prog.', 'Pending', 'Rework', 'Overdue', 'Compl.'], R.people.map(function (p) { return [{ t: p.name, b: 1 }, p.total, p.completed, p.inprogress, p.pending, p.rework, p.overdue, p.pct + '%']; }), [150, 45, 45, 50, 50, 50, 50, 50]);
      }
      var wr = function (list) { return list.map(function (i) { return [{ t: i.topic + (i.reworked ? ' (rework)' : ''), b: 1 }, i.type, i.assignee + (i.reassigned ? ' (from ' + i.original + ')' : ''), fmtD(i.assigned), fmtD(i.target) + (i.overdue ? ' - overdue' : ''), i.done ? fmtD(i.done) : '-', { t: ST[i.b].t, rgb: ST[i.b].rgb, b: 1 }, i.priority]; }); };
      var WW = [130, 62, 88, 58, 66, 58, 58, 48], HH = ['Work', 'Type', 'Assignee', 'Assigned', 'Target', 'Done', 'Status', 'Priority'];
      if (R.mode === 'team') { section('Work details (' + R.items.length + ')'); tbl(HH, wr(R.items), WW); }
      else {
        section('Completed work (' + c.completed + ')'); tbl(HH, wr(R.items.filter(function (i) { return i.b === 'completed'; })), WW);
        section('Open work (' + (c.pending + c.inprogress + c.rework) + ')'); tbl(HH, wr(R.items.filter(function (i) { return i.b === 'pending' || i.b === 'inprogress' || i.b === 'rework'; })), WW);
        if (c.rejected) { section('Rejected (' + c.rejected + ')'); tbl(HH, wr(R.items.filter(function (i) { return i.b === 'rejected'; })), WW); }
      }
    }
    footer();
    var fname = 'Media-Work-Report_' + (R.mode === 'team' ? 'Team' : String(R.empName).replace(/[^A-Za-z0-9]+/g, '-')) + '_' + R.key + '.pdf';
    doc.save(fname);
    toast('success', 'Report downloaded.');
  }

  // ---------------------------------------------------------------- entry
  window.mhRenderMonthlyReport = async function () {
    var root = el('mwr-root'); if (!root) return;
    if (!allowed()) { root.innerHTML = '<div class="card glass-card rounded-2xl" style="padding:24px;color:#6b74a0;font-size:13px">Not authorized.</div>'; return; }
    if (!S.team.length) {
      try { var d = db(); var r = await d.from('hr_employees').select('full_name,portal_email,employment_status,account_type,division').eq('division', 'production');
        S.team = (r.data || []).filter(function (e) { return e.portal_email && (e.account_type || 'employee') === 'employee'; }).sort(function (a, b) { return a.full_name.localeCompare(b.full_name); });
      } catch (_) {}
    }
    renderShell();
  };
  window._mwrBuild = build; // exposed for verification only (pure function)
})();
