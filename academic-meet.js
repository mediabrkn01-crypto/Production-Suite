/* ════════════════════════════════════════════════════════════════════════════
   AcademicMeet — Academic → LIVE CLASSES (Google Calendar + Google Meet).

   Loaded lazily by academics.html (acadLoadLiveClasses) the first time the Live Classes tab is
   opened; the markup comes from academic-meet.html and is injected into #tab-acad-liveclasses,
   inside the existing Academic shell. Never navigates away.

   Source of truth = the ERP. Classes are the SAME occurrences every Academic screen uses:
     • batch occurrences   generateBatchOccurrences() (day_pattern / time_slot / holidays /
                           class_postponements) → key 'class:<batch_id>:<original_date>'
     • group 1:1 sessions  oto_sessions rows → key 'oto:<id>'
   academic_live_classes only links an occurrence to its Calendar event + Meet link. Every Google
   call goes through the `academic-meet` edge function (no Google credentials in the browser),
   authorised by the normal ERP sign-in (BESession token).

   Permissions (enforced again on the server):
     Academic Head / Class Coordinator / Operations Manager → view all, create, edit, cancel, invite
     Manager / Founder → view all          Fluency Coach → own classes, join, copy link
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.AcademicMeet) return;

  var TZ = 'Asia/Kolkata';
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var REMINDER_CHOICES = [10, 15, 30, 60];
  var SESSION_MSG = 'Your session has expired. Please sign in again to continue.';

  var S = {
    root: null, view: 'day', anchor: null, status: null, statusErr: null, tableMissing: false,
    occ: [], links: {}, touched: {}, autoSyncAt: {}, online: {}, busy: {}, autoDone: {}, seq: 0, modalKey: null, modalDetails: null, loading: false
  };

  // ── small helpers ─────────────────────────────────────────────────────────
  // academics.html globals: functions live on window; `sb` / `currentUser` are top-level let/const
  // (shared global scope, not window properties).
  function g(name) { return typeof window[name] === 'function' ? window[name] : undefined; }
  function db() { return typeof sb !== 'undefined' ? sb : null; }
  function me() { return (typeof currentUser !== 'undefined' && currentUser) || {}; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(type, msg, ms) { var f = g('showToast'); if (typeof f === 'function') f(type, msg, ms); }
  function icons() { if (window.lucide) try { lucide.createIcons(); } catch (e) {} }
  function istToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
  function istNowMin() { var p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number); return p[0] * 60 + p[1]; }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function dowOf(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
  function toMin(t) { var m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function hm(min) { return String(Math.floor(min / 60) % 24).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
  function fmt(min) { if (min == null || isNaN(min)) return '—'; var h = Math.floor(min / 60) % 24, mm = min % 60; return String((h + 11) % 12 + 1).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function fmtDate(iso, o) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', Object.assign({ timeZone: 'UTC' }, o || { day: '2-digit', month: 'short', year: 'numeric' })); }
  function mobile() { return window.matchMedia && window.matchMedia('(max-width:760px)').matches; }
  function canManage() { return !!(S.status && S.status.canManage); }
  /** Google connected + the link table exists → Meet links can be created. */
  function ready() { return !!(S.status && S.status.connected) && !S.tableMissing; }
  function isOrg() { var f = g('_acadIsRealHeadForSchedule'); return typeof f === 'function' ? !!f() : false; }
  function remText(arr) { var a = (arr && arr.length ? arr : [30]).slice().sort(function (x, y) { return y - x; }); return a.map(function (m) { return m >= 60 && m % 60 === 0 ? (m / 60) + ' hr' : m + ' min'; }).join(' & ') + ' before'; }

  // ── backend ───────────────────────────────────────────────────────────────
  function api(action, payload) {
    var BS = window.BESession;
    var token = BS && BS.token((me().username || '').toLowerCase());
    if (!BS || !token) return Promise.reject(Object.assign(new Error(SESSION_MSG), { code: 'SESSION_EXPIRED' }));
    return fetch(BS.url + '/functions/v1/academic-meet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: BS.anonKey, Authorization: 'Bearer ' + BS.anonKey, 'x-erp-session': token },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) throw Object.assign(new Error(j.message || ('Live Classes service error (' + r.status + ')')), { code: j.code || (r.status === 404 ? 'NOT_DEPLOYED' : ''), status: r.status });
        return j;
      });
    }, function () { throw Object.assign(new Error('Could not reach the Live Classes service. Check your connection and try again.'), { code: 'NETWORK' }); });
  }

  // ── ERP classes (same generator as Classes / Schedule / Class & Attendance) ──
  function keyOf(o) { return o.kind === 'oto' ? 'oto:' + o.oto.id : 'class:' + o.batch.id + ':' + (o.postponed ? o.postponed.original_date : o.date); }

  function rangeFor(view, anchor) {
    if (view === 'day') return [anchor, anchor];
    if (view === 'week') { var s = addDays(anchor, -((dowOf(anchor) + 6) % 7)); return [s, addDays(s, 6)]; }
    var first = anchor.slice(0, 8) + '01', gs = addDays(first, -((dowOf(first) + 6) % 7));
    return [gs, addDays(gs, 41)];
  }

  async function fetchClasses(from, to) {
    var sbc = db(), org = isOrg(), myTid = window._myTrainerId || '00000000-0000-0000-0000-000000000000';
    var loadH = g('_acadLoadHolidays'), gen = g('generateBatchOccurrences'), isDel = g('_isBatchDeleted') || function (b) { return !!(b && b.deleted_at); };
    if (typeof loadH === 'function') await loadH();
    var bq = sbc.from('batches').select('*').eq('status', 'active');
    if (!org) bq = bq.eq('trainer_id', myTid);
    var oq = sbc.from('oto_sessions').select('id,batch_id,student_id,trainer_id,session_number,session_date,start_time,end_time,duration_minutes,status').gte('session_date', from).lte('session_date', to);
    if (!org) oq = oq.eq('trainer_id', myTid);
    var res = await Promise.all([bq, oq.then(function (r) { return r; }, function () { return { data: [] }; }), sbc.from('trainers').select('id,name')]);
    var batches = (res[0].data || []).filter(function (b) { return !isDel(b); });
    var otos = res[1].data || [];
    var trName = {}; (res[2].data || []).forEach(function (t) { trName[t.id] = t.name; });

    // SESSION COMPLETION RULE (same as Classes / My Calendar): a batch that has reached its session
    // total no longer generates classes.
    var fetchAll = g('_acadFetchAllRows');
    if (batches.length && typeof fetchAll === 'function') {
      var names = batches.map(function (b) { return b.name; }).filter(Boolean), done = {};
      try {
        var att = await fetchAll('attendance', 'batch_name,session_date,session_num,status', function (q) { return q.in('batch_name', names); });
        (att || []).forEach(function (a) { if (a.status !== 'present') return; (done[a.batch_name] = done[a.batch_name] || {})[a.session_date != null ? a.session_date : 'n' + a.session_num] = 1; });
      } catch (e) {}
      batches = batches.filter(function (b) { var t = b.sessions_total || 0; return !(t && Object.keys(done[b.name] || {}).length >= t); });
    }

    // Batches referenced by 1:1 sessions that aren't in the active list (rare) + students.
    var bMap = {}; batches.forEach(function (b) { bMap[b.id] = b; });
    var extra = otos.map(function (o) { return o.batch_id; }).filter(function (id) { return id && !bMap[id]; });
    if (extra.length) { var er = await sbc.from('batches').select('*').in('id', Array.from(new Set(extra))); (er.data || []).forEach(function (b) { bMap[b.id] = b; }); }
    var bIds = Object.keys(bMap), studentsBy = {}, stuById = {};
    for (var i = 0; i < bIds.length; i += 150) {
      var sr = await sbc.from('students').select('id,name,email,batch_id,status').in('batch_id', bIds.slice(i, i + 150));
      (sr.data || []).forEach(function (s) { stuById[s.id] = s; if (String(s.status || '').toLowerCase() === 'dropped') return; (studentsBy[s.batch_id] = studentsBy[s.batch_id] || []).push(s); });
    }
    var missingStu = otos.map(function (o) { return o.student_id; }).filter(function (id) { return id && !stuById[id]; });
    if (missingStu.length) { var ms = await sbc.from('students').select('id,name,email,batch_id,status').in('id', Array.from(new Set(missingStu))); (ms.data || []).forEach(function (s) { stuById[s.id] = s; }); }

    var out = [];
    batches.forEach(function (b) {
      if (b.group_classes_completed_at || typeof gen !== 'function') return;
      gen(b, from, to).forEach(function (o) { out.push(build({ kind: 'class', date: o.date, startMin: o.startTime, batch: b, postponed: o.postponed || null }, trName, studentsBy)); });
    });
    otos.forEach(function (o) {
      var b = bMap[o.batch_id] || { id: o.batch_id, name: '1:1 session', programme: '' };
      var st = toMin(o.start_time), en = toMin(o.end_time);
      if (st == null) return;
      var s = stuById[o.student_id];
      out.push(build({ kind: 'oto', date: String(o.session_date).slice(0, 10), startMin: st, dur: (en != null && en > st) ? en - st : (Number(o.duration_minutes) || 30), batch: b, oto: o, student: s || null, trainerId: o.trainer_id || b.trainer_id }, trName, studentsBy));
    });
    out.sort(function (a, b) { return a.date === b.date ? (a.startMin - b.startMin) : a.date.localeCompare(b.date); });
    return out;
  }

  function build(o, trName, studentsBy) {
    var b = o.batch, isOto = o.kind === 'oto';
    var dur = isOto ? o.dur : (Number(b.class_duration_minutes) || 60);
    var studs = isOto ? (o.student ? [o.student] : []) : (studentsBy[b.id] || []);
    var isOne = isOto || Number(b.capacity) === 1;
    var course = String(b.programme || b.name || '').trim();
    var who = isOne ? ((studs[0] && studs[0].name) || b.name) : b.name;
    var noStudent = isOne && !(studs[0] && studs[0].name);
    var trainerId = isOto ? o.trainerId : b.trainer_id;
    var x = {
      kind: o.kind, date: o.date, startMin: o.startMin, dur: dur, endMin: o.startMin + dur, batch: b, oto: o.oto || null,
      postponed: o.postponed || null, students: studs, isOne: isOne, trainerId: trainerId,
      trainerName: trName[trainerId] || b.trainer_name || 'Unassigned',
      typeLabel: isOto ? 'Group 1:1' : (isOne ? '1:1' : 'Group'),
      title: isOne && !noStudent ? (isOto ? b.name + ' – ' + who : course + ' – ' + who) : b.name,
      who: who, course: course
    };
    x.key = keyOf(x);
    return x;
  }

  // A link just returned by an action wins over a list read that started before it.
  function keepFresh(map) {
    Object.keys(S.touched).forEach(function (k) {
      if (Date.now() - S.touched[k] > 15000) { delete S.touched[k]; return; }
      if (S.links[k]) map[k] = S.links[k];
    });
    return map;
  }

  async function fetchLinks(keys) {
    var sbc = db(), map = {};
    for (var i = 0; i < keys.length; i += 120) {
      var r = await sbc.from('academic_live_classes').select('*').in('occurrence_key', keys.slice(i, i + 120));
      if (r.error) { if (/academic_live_classes|relation|schema cache/i.test(r.error.message || '')) S.tableMissing = true; return map; }
      (r.data || []).forEach(function (row) { map[row.occurrence_key] = row; });
    }
    S.tableMissing = false;
    return keepFresh(map);
  }

  async function fetchOnline() {
    var r = await db().from('academic_meet_batches').select('batch_id,online');
    var m = {}; (r.data || []).forEach(function (x) { if (x.online) m[x.batch_id] = true; });
    return m;
  }

  // ── load / render ─────────────────────────────────────────────────────────
  async function load(quiet) {
    if (!S.root) return;
    var seq = ++S.seq, rg = rangeFor(S.view, S.anchor);
    if (!quiet) { S.loading = true; paintRange(); }
    try {
      var occ = await fetchClasses(rg[0], rg[1]);
      var links = await fetchLinks(occ.map(function (o) { return o.key; }));
      var online = await fetchOnline().catch(function () { return {}; });
      if (seq !== S.seq) return;
      S.occ = occ; S.links = links; S.online = online; S.loading = false;
      render();
      autoCreate();
    } catch (e) {
      if (seq !== S.seq) return;
      S.loading = false;
      body('<div class="am-empty"><b>Live classes could not load</b>' + esc(e && e.message || e) + '</div>');
    }
  }

  async function reloadLinks() {
    if (!S.occ.length) return load(true);
    S.links = await fetchLinks(S.occ.map(function (o) { return o.key; }));
    S.online = await fetchOnline().catch(function () { return S.online; });
    render();
    if (S.modalKey) renderModal();
  }

  function body(html) { var el = S.root && S.root.querySelector('#am-body'); if (el) { el.innerHTML = html; icons(); } }
  function $(sel) { return S.root ? S.root.querySelector(sel) : null; }

  function paintRange() {
    var rg = rangeFor(S.view, S.anchor), el = $('#am-range'), t = istToday();
    if (!el) return;
    if (S.view === 'day') el.textContent = (S.anchor === t ? 'Today · ' : '') + fmtDate(S.anchor, { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
    else if (S.view === 'week') el.textContent = fmtDate(rg[0], { day: '2-digit', month: 'short' }) + ' – ' + fmtDate(rg[1], { day: '2-digit', month: 'short', year: 'numeric' });
    else el.textContent = fmtDate(S.anchor.slice(0, 8) + '01', { month: 'long', year: 'numeric' });
    S.root.querySelectorAll('.am-views button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === S.view); b.setAttribute('aria-selected', b.getAttribute('data-view') === S.view); });
    var td = S.root.querySelector('.am-views [data-view="day"]'); if (td) td.textContent = 'Today';
    if (S.loading) body('<div class="am-loading">Loading live classes…</div>');
  }

  function linkOf(o) { return S.links[o.key] || null; }
  function cancelled(o) { var l = linkOf(o); return !!(l && l.class_status === 'cancelled'); }
  function ended(o) { var t = istToday(); return o.date < t || (o.date === t && istNowMin() >= o.endMin); }
  function liveNow(o) { var t = istToday(), n = istNowMin(); return o.date === t && n >= o.startMin && n < o.endMin; }
  function needsMeet(o) { var l = linkOf(o); return !cancelled(o) && !ended(o) && !(l && l.google_meet_url && l.google_calendar_event_id); }
  function syncState(o) {
    if (S.busy[o.key]) return 'syncing';
    var l = linkOf(o);
    if (!l) return 'none';
    if (l.class_status === 'cancelled') return l.google_sync_status === 'failed' ? 'failed' : 'cancelled';
    if (l.google_sync_status === 'synced' && l.google_meet_url) return 'synced';
    if (l.google_sync_status === 'syncing') return 'syncing';
    if (l.google_sync_status === 'failed') return 'failed';
    return 'none';
  }
  var SYNC_LABEL = { none: 'No Meet', syncing: 'Syncing…', synced: 'Synced', failed: 'Sync Failed', cancelled: 'Cancelled' };
  function chip(o) {
    var l = linkOf(o);
    if (l && l.class_status !== 'cancelled' && l.live_status === 'live') return '<span class="am-chip s-live">Live</span>';
    if (l && l.meet_sync_status === 'synced') return '<span class="am-chip s-synced">Completed · ' + (l.actual_duration_minutes != null ? l.actual_duration_minutes + ' min' : 'report') + '</span>';
    var s = syncState(o); return '<span class="am-chip s-' + s + '"' + (s === 'failed' && linkOf(o) && linkOf(o).google_sync_error ? ' title="' + esc(linkOf(o).google_sync_error) + '"' : '') + '>' + SYNC_LABEL[s] + '</span>'; }

  function render() {
    paintRange(); renderSetup(); renderStats();
    var bulk = $('#am-bulk');
    if (bulk) { var n = S.occ.filter(needsMeet).length; bulk.hidden = !(canManage() && ready() && n > 1); bulk.querySelector('span').textContent = 'Create Meet for ' + n + ' classes'; }
    if (S.view === 'day') return body(agenda(S.occ.filter(function (o) { return o.date === S.anchor; }), true));
    // Narrow screens (or a narrow content area) get a clean agenda instead of a squeezed grid.
    if (S.view === 'week') return body(mobile() || S.root.clientWidth < 700 ? agenda(S.occ, false) : weekGrid());
    body(monthGrid());
  }

  function renderStats() {
    var el = $('#am-stats'); if (!el) return;
    var occ = S.occ.filter(function (o) { return S.view === 'day' ? o.date === S.anchor : S.view === 'month' ? o.date.slice(0, 7) === S.anchor.slice(0, 7) : true; });
    var withMeet = occ.filter(function (o) { return syncState(o) === 'synced'; }).length;
    var need = occ.filter(needsMeet).length, failed = occ.filter(function (o) { return syncState(o) === 'failed'; }).length;
    var c = occ.filter(cancelled).length;
    el.innerHTML = '<div class="am-stat"><b>' + occ.length + '</b> classes</div><div class="am-stat"><b>' + withMeet + '</b> with Meet</div>'
      + (need ? '<div class="am-stat"><b>' + need + '</b> need a Meet</div>' : '')
      + (failed ? '<div class="am-stat" style="border-color:rgba(248,113,113,.35)"><b style="color:#f87171">' + failed + '</b> sync failed</div>' : '')
      + (c ? '<div class="am-stat"><b>' + c + '</b> cancelled</div>' : '');
  }

  function cardActions(o) {
    var l = linkOf(o), s = syncState(o), a = '';
    if (s === 'synced' && !cancelled(o) && !ended(o)) a += '<a class="am-btn am-btn-meet am-btn-sm" href="' + esc(l.google_meet_url) + '" target="_blank" rel="noopener" data-stop><i data-lucide="video"></i>Join Meet</a>';
    else if (canManage() && ready() && needsMeet(o) && s !== 'failed') a += '<button type="button" class="am-btn am-btn-ghost am-btn-sm" data-create="' + esc(o.key) + '"' + (S.busy[o.key] ? ' disabled' : '') + '><i data-lucide="video"></i>Create Meet</button>';
    if (s === 'failed' && canManage()) a += '<button type="button" class="am-btn am-btn-danger am-btn-sm" data-retry="' + esc(o.key) + '"' + (S.busy[o.key] ? ' disabled' : '') + '>Retry Sync</button>';
    return a;
  }

  function agenda(list, single) {
    if (!list.length) {
      var who = isOrg() ? 'No Academic classes' : 'No classes for you';
      return '<div class="am-empty"><b>' + (single ? (S.anchor === istToday() ? 'No live classes today' : 'No classes this day') : 'No classes this week') + '</b>' + who + ' scheduled' + (single ? ' on this day.' : ' in this range.') + '</div>';
    }
    var html = '', t = istToday(), groups = [];
    list.forEach(function (o) { if (!groups.length || groups[groups.length - 1].date !== o.date) groups.push({ date: o.date, items: [] }); groups[groups.length - 1].items.push(o); });
    groups.forEach(function (gp) {
      var label = gp.date === t ? (single ? "Today's Live Classes" : 'Today') : gp.date === addDays(t, 1) ? 'Tomorrow' : fmtDate(gp.date, { weekday: 'long', day: '2-digit', month: 'short' });
      html += '<div class="am-day-h"><span class="am-tag">' + esc(label) + '</span><span class="am-n">' + gp.items.length + ' class' + (gp.items.length === 1 ? '' : 'es') + '</span></div><div class="am-list">';
      gp.items.forEach(function (o) {
        var cls = 'am-card', st = '';
        if (cancelled(o)) cls += ' is-cancelled';
        else if (liveNow(o)) { cls += ' is-live'; st = '<span class="am-chip s-live">Live now</span>'; }
        else if (ended(o)) cls += ' is-done';
        if (syncState(o) === 'synced') cls += ' has-meet';
        var sub = [];
        if (isOrg()) sub.push('Trainer: ' + esc(o.trainerName));
        if (!o.isOne) sub.push(o.students.length + ' student' + (o.students.length === 1 ? '' : 's'));
        sub.push('Type: ' + o.typeLabel);
        if (o.kind === 'oto') sub.push(esc(o.course));
        var pp = o.postponed ? '<span class="am-chip s-pp">Moved from ' + fmt(o.postponed.original_min) + '</span>' : '';
        html += '<div class="' + cls + '" role="button" tabindex="0" data-open="' + esc(o.key) + '">'
          + '<div class="am-c-time"><b>' + fmt(o.startMin) + '</b><span>to ' + fmt(o.endMin) + '</span></div><span class="am-rail"></span>'
          + '<div class="am-c-main"><div class="am-c-title">' + esc(o.title) + '</div><div class="am-c-sub">' + sub.map(function (s) { return '<span>' + s + '</span>'; }).join('') + '</div></div>'
          + '<div class="am-c-act">' + st + pp + chip(o) + cardActions(o) + '</div></div>';
      });
      html += '</div>';
    });
    return html;
  }

  function weekGrid() {
    var rg = rangeFor('week', S.anchor), t = istToday();
    var days = []; for (var i = 0; i < 7; i++) days.push(addDays(rg[0], i));
    var hasSun = S.occ.some(function (o) { return o.date === days[6]; });
    if (!hasSun) days = days.slice(0, 6);
    var mins = S.occ.map(function (o) { return o.startMin; }), maxs = S.occ.map(function (o) { return o.endMin; });
    var h0 = Math.min(8, mins.length ? Math.floor(Math.min.apply(null, mins) / 60) : 8), h1 = Math.max(22, maxs.length ? Math.ceil(Math.max.apply(null, maxs) / 60) : 22);
    h1 = Math.min(h1, 24);
    var HOUR = 52, heightPx = (h1 - h0) * HOUR;
    var html = '<div class="am-week-scroll"><div class="am-week" style="--am-days:' + days.length + ';min-width:' + (52 + days.length * 132) + 'px"><div class="am-wh" style="border-bottom:1px solid var(--am-line)"></div>';
    days.forEach(function (d) { html += '<div class="am-wh' + (d === t ? ' is-today' : '') + '"><small>' + DOW[dowOf(d)] + '</small><b>' + Number(d.slice(8)) + '</b></div>'; });
    html += '<div class="am-hours" style="height:' + heightPx + 'px">';
    for (var h = h0; h < h1; h++) html += '<div class="am-hr">' + (h === h0 ? '' : ((h + 11) % 12 + 1) + ' ' + (h < 12 ? 'AM' : 'PM')) + '</div>';
    html += '</div>';
    days.forEach(function (d) {
      var items = S.occ.filter(function (o) { return o.date === d; });
      // Overlapping classes sit side by side; each overlap cluster gets its own lane count.
      var cl = null, clEnd = -1;
      items.forEach(function (o) {
        if (!cl || o.startMin >= clEnd) { cl = { lanes: [] }; clEnd = -1; }
        var L = 0; while (cl.lanes[L] != null && cl.lanes[L] > o.startMin) L++;
        cl.lanes[L] = o.endMin; o._lane = L; o._cl = cl; clEnd = Math.max(clEnd, o.endMin);
      });
      html += '<div class="am-col' + (d === t ? ' is-today' : '') + '" style="height:' + heightPx + 'px">';
      items.forEach(function (o) {
        var top = (o.startMin - h0 * 60) / 60 * HOUR, hgt = Math.max(22, o.dur / 60 * HOUR - 2);
        var w = 100 / o._cl.lanes.length, s = syncState(o);
        html += '<div class="am-ev' + (s === 'synced' ? ' has-meet' : '') + (s === 'failed' ? ' s-failed' : '') + (cancelled(o) ? ' is-cancelled' : '') + '" role="button" tabindex="0" data-open="' + esc(o.key) + '" style="top:' + top + 'px;height:' + hgt + 'px;left:calc(' + (o._lane * w) + '% + 3px);width:calc(' + w + '% - 6px);right:auto" title="' + esc(o.title + ' · ' + fmt(o.startMin) + ' – ' + fmt(o.endMin)) + '">'
          + (s === 'synced' ? '<i data-lucide="video" class="am-ev-v"></i>' : '')
          + '<b>' + esc(o.title) + '</b><span>' + fmt(o.startMin) + ' – ' + fmt(o.endMin) + '</span>' + (isOrg() ? '<span>' + esc(o.trainerName) + '</span>' : '') + '</div>';
      });
      if (d === t) { var n = istNowMin(); if (n >= h0 * 60 && n <= h1 * 60) html += '<div class="am-now" style="top:' + ((n - h0 * 60) / 60 * HOUR) + 'px"></div>'; }
      html += '</div>';
    });
    html += '</div></div>';
    return html;
  }

  function monthGrid() {
    var rg = rangeFor('month', S.anchor), t = istToday(), mo = S.anchor.slice(0, 7);
    var html = '<div class="am-month">';
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (d) { html += '<div class="am-mh">' + d + '</div>'; });
    for (var i = 0; i < 42; i++) {
      var d = addDays(rg[0], i), items = S.occ.filter(function (o) { return o.date === d; });
      html += '<button type="button" class="am-md' + (d.slice(0, 7) !== mo ? ' is-out' : '') + (d === t ? ' is-today' : '') + '" data-day="' + d + '" aria-label="' + esc(fmtDate(d) + ' — ' + items.length + ' classes') + '"><span class="am-md-n">' + Number(d.slice(8)) + '</span>';
      items.slice(0, 3).forEach(function (o) { html += '<span class="am-mi' + (syncState(o) === 'synced' ? ' has-meet' : '') + (cancelled(o) ? ' is-cancelled' : '') + '">' + fmt(o.startMin).replace(':00', '').replace(/^0/, '') + ' ' + esc(o.title) + '</span>'; });
      if (items.length > 3) html += '<span class="am-more">+' + (items.length - 3) + ' more</span>';
      if (items.length) html += '<span class="am-md-dots">' + items.slice(0, 6).map(function (o) { return '<i class="' + (syncState(o) === 'synced' ? 'has-meet' : '') + '"></i>'; }).join('') + '</span>';
      html += '</button>';
    }
    return html + '</div>';
  }

  // ── setup banner (Google connection) ──────────────────────────────────────
  function renderSetup() {
    var el = $('#am-setup'); if (!el) return;
    var st = S.status, html = '', cls = 'am-setup';
    if (S.tableMissing) html = '<div class="am-setup-t"><b>One-time database update needed</b>Ask the admin to run <code>20261016_academic_live_classes.sql</code> in Supabase. Classes still show below; Meet links can be created after the update.</div>';
    else if (S.statusErr && S.statusErr.code === 'SESSION_EXPIRED') html = '<div class="am-setup-t"><b>Session expired</b>' + esc(SESSION_MSG) + '</div><button type="button" class="am-btn" data-relogin>Sign in again</button>';
    else if (S.statusErr) html = canManage() || isOrg() ? '<div class="am-setup-t"><b>Google Meet service not reachable</b>' + esc(S.statusErr.message) + '</div><button type="button" class="am-btn am-btn-ghost" data-recheck>Try again</button>' : '';
    else if (st && canManage() && !st.configured) html = '<div class="am-setup-t"><b>Connect Google Calendar &amp; Meet</b>The server needs the Google OAuth client first — add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> as Supabase function secrets (see supabase/functions/academic-meet/README.md).</div>';
    else if (st && canManage() && !st.connected) html = '<div class="am-setup-t"><b>Connect the Broken English Google account</b>Classes are created by one organisation account (for example academics@…). Trainers and students are invited as attendees.</div><button type="button" class="am-btn" data-connect><i data-lucide="link"></i>Connect Google account</button>';
    else if (st && st.connected && canManage()) { cls += ' ok'; html = '<div class="am-setup-t">Google connected' + (st.organizerEmail ? ' as <b style="display:inline">' + esc(st.organizerEmail) + '</b>' : '') + ' · Reminder: ' + esc(remText(st.defaultReminders)) + '</div><button type="button" class="am-btn am-btn-ghost am-btn-sm" data-settings><i data-lucide="settings-2"></i>Settings</button>'; }
    el.className = cls;
    el.hidden = !html;
    el.innerHTML = html;
    icons();
  }

  async function loadStatus() {
    try { S.status = await api('status'); S.statusErr = null; }
    catch (e) { S.status = null; S.statusErr = { code: e.code, message: e.code === 'NOT_DEPLOYED' ? 'The academic-meet function is not deployed yet.' : e.message }; }
  }

  // ── actions ───────────────────────────────────────────────────────────────
  function occByKey(key) { for (var i = 0; i < S.occ.length; i++) if (S.occ[i].key === key) return S.occ[i]; return null; }
  function startHint(o) { return o ? hm(o.postponed ? o.postponed.original_min : o.startMin) : undefined; }

  function sessionGuard(e) {
    if (e && e.code === 'SESSION_EXPIRED') { toast('error', SESSION_MSG, 6000); return true; }
    return false;
  }

  async function run(key, action, extra, okMsg) {
    if (S.busy[key]) return null;
    S.busy[key] = true; render(); if (S.modalKey === key) renderModal();
    try {
      var o = occByKey(key);
      var j = await api(action, Object.assign({ key: key, start: startHint(o) }, extra || {}));
      if (j.row) { S.links[key] = j.row; S.touched[key] = Date.now(); }
      var miss = (j.notInvited || []).length;
      if (okMsg) {
        if (miss && action !== 'cancel') toast('warning', 'Meet created, but ' + miss + ' participant' + (miss === 1 ? '' : 's') + ' could not be invited because their email address is missing.', 7000);
        else toast('success', j.already ? 'This class already has a Meet link.' : okMsg);
      }
      return j;
    } catch (e) {
      if (!sessionGuard(e)) toast('error', e.message || String(e), 7000);
      await reloadLinks().catch(function () {});
      return null;
    } finally {
      // Keep the current attendee list on screen while it refreshes (no empty flash).
      delete S.busy[key]; render(); if (S.modalKey === key) { renderModal(); fetchDetails(key); }
    }
  }

  function createMeet(key) { return run(key, 'create', null, 'Google Meet created — invitations sent.'); }
  function retry(key) { return run(key, 'retry', null, 'Synced with Google Calendar.'); }

  async function bulkCreate() {
    var list = S.occ.filter(needsMeet).filter(function (o) { return syncState(o) !== 'failed'; });
    if (!list.length) return;
    var conf = g('beConfirm');
    var ok = typeof conf === 'function' ? await conf({ title: 'Create Google Meet links', message: 'Create a Calendar event and Meet link for ' + list.length + ' classes?', detail: 'Trainers and students with an email address receive Google Calendar invitations.', confirmLabel: 'Create ' + list.length + ' Meets', confirmColor: '#10b981' }) : true;
    if (!ok) return;
    var btn = $('#am-bulk'), made = 0, failed = 0, missing = 0;
    if (btn) btn.disabled = true;
    for (var i = 0; i < list.length; i++) {
      if (btn) btn.querySelector('span').textContent = 'Creating ' + (i + 1) + ' of ' + list.length + '…';
      var j = await run(list[i].key, 'create', null, null);
      if (j) { made++; missing += (j.notInvited || []).length; } else failed++;
    }
    if (btn) btn.disabled = false;
    render();
    toast(failed ? 'warning' : 'success', made + ' Meet link' + (made === 1 ? '' : 's') + ' created' + (failed ? ', ' + failed + ' failed (Retry Sync on each)' : '') + (missing ? ' · ' + missing + ' participant invitation' + (missing === 1 ? '' : 's') + ' missing an email' : '') + '.', 7000);
  }

  // Online batches: create Meets for their classes in the next 7 days automatically.
  var autoRunning = false;
  async function autoCreate() {
    if (autoRunning || !canManage() || !ready()) return;
    var ids = Object.keys(S.online); if (!ids.length) return;
    autoRunning = true;
    try {
      var t = istToday(), to = addDays(t, 6);
      var occ = await fetchClasses(t, to);
      occ = occ.filter(function (o) { return S.online[o.batch.id] && !S.autoDone[o.key] && !ended(o); });
      if (!occ.length) return;
      var links = await fetchLinks(occ.map(function (o) { return o.key; }));
      var todo = occ.filter(function (o) { var l = links[o.key]; return !l || (l.class_status !== 'cancelled' && l.google_sync_status !== 'failed' && !(l.google_meet_url && l.google_calendar_event_id)); });
      var made = 0;
      for (var i = 0; i < todo.length; i++) {
        S.autoDone[todo[i].key] = true;
        try { await api('create', { key: todo[i].key, start: startHint(todo[i]) }); made++; } catch (e) { if (e.code === 'SESSION_EXPIRED' || e.code === 'NOT_CONNECTED' || e.code === 'NOT_CONFIGURED') break; }
      }
      if (made) { toast('success', 'Created ' + made + ' Meet link' + (made === 1 ? '' : 's') + ' for online batches.'); reloadLinks(); }
    } catch (e) { /* next visit retries */ }
    finally { autoRunning = false; }
  }

  async function setOnline(batchId, on) {
    var r = await db().from('academic_meet_batches').upsert({ batch_id: batchId, online: !!on, set_by: me().username || null, updated_at: new Date().toISOString() });
    if (r.error) { toast('error', 'Could not save: ' + r.error.message); return; }
    if (on) S.online[batchId] = true; else delete S.online[batchId];
    toast('success', on ? 'Online batch — Meet links will be created for its upcoming classes.' : 'Automatic Meet creation turned off for this batch.');
    if (on) autoCreate();
    renderModal();
  }

  // ── class details modal ───────────────────────────────────────────────────
  function modalEl() { return document.getElementById('am-modal'); }

  function openModal(key) {
    if (!occByKey(key)) return;
    S.modalKey = key; S.modalDetails = null; S.cancelOpen = false; S.fixOpen = false; S.endOpen = false; S.revOpen = false; S.repOpen = false; S.histOpen = false;
    var box = document.getElementById('am-m-body'); if (box) { box.onclick = null; box.oninput = null; }
    renderModal();
    var m = modalEl(); m.classList.add('on'); m.setAttribute('aria-hidden', 'false');
    fetchDetails(key);
  }
  function closeModal() { var m = modalEl(); if (m) { m.classList.remove('on'); m.setAttribute('aria-hidden', 'true'); } S.modalKey = null; S.modalDetails = null; }

  async function fetchDetails(key) {
    var o = occByKey(key); if (!o) return;
    try {
      var j = await api('details', { key: key, start: startHint(o) });
      if (S.modalKey !== key) return;
      if (j.row) S.links[key] = j.row;
      S.modalDetails = j;
      var r = j.row;
      if (r && r.google_meet_url && (r.meet_sync_status === 'pending' || r.meet_sync_status === 'waiting') && !S.busy[key]
          && Date.now() - Date.parse(r.updated_at || 0) > 120000 && Date.now() - (S.autoSyncAt[key] || 0) > 120000) {
        S.autoSyncAt[key] = Date.now();
        setTimeout(function () { if (S.modalKey === key) run(key, 'sync_report', null, null).then(reportToast); }, 300);
      }
    } catch (e) {
      if (S.modalKey !== key) return;
      S.modalDetails = { error: e.code === 'SESSION_EXPIRED' ? SESSION_MSG : e.message };
    }
    renderModal();
  }

  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?'; }
  function fact(icon, label, val, sub) { return '<div class="am-fact"><span class="am-fact-i"><i data-lucide="' + icon + '"></i></span><div><small>' + label + '</small><b>' + val + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div></div>'; }

  function renderModal() {
    var key = S.modalKey, o = key && occByKey(key), box = document.getElementById('am-m-body');
    if (!o || !box) return;
    var l = linkOf(o), d = S.modalDetails, s = syncState(o), man = canManage(), isC = cancelled(o), isEnded = ended(o), busy = !!S.busy[key];
    var status = isC ? ['Cancelled', 'st-cancel'] : (l && l.meet_sync_status === 'synced') ? ['Completed', 'st-live'] : (l && l.live_status === 'live') ? ['Live', 'st-live'] : (l && l.live_status === 'ended') ? ['Ended', 'st-ended'] : liveNow(o) ? ['Live now', 'st-live'] : isEnded ? ['Ended', 'st-ended'] : ['Scheduled', 'st-sched'];
    var hasMeet = !!(l && l.google_meet_url && !isC);

    // ── header
    var html = '<div class="am-mh">'
      + '<div class="am-mh-pills"><span class="am-pill">' + esc(o.typeLabel) + '</span><span class="am-pill ' + status[1] + '">' + status[0] + '</span>' + chip(o) + '</div>'
      + '<h3 class="am-m-title" id="am-m-title">' + esc(o.title) + '</h3>'
      + '<div class="am-mh-when"><span><i data-lucide="calendar"></i>' + esc(fmtDate(o.date, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })) + '</span>'
      + '<span><i data-lucide="clock"></i>' + esc(fmt(o.startMin) + ' – ' + fmt(o.endMin)) + '</span>'
      + (o.postponed ? '<span class="am-moved">Moved from ' + esc(fmt(o.postponed.original_min)) + '</span>' : '') + '</div></div>';

    html += '<div class="am-m-scroll">';

    // ── Google Meet hero
    if (l && l.google_sync_status === 'failed' && l.google_sync_error) html += '<div class="am-err"><b>Sync failed.</b> ' + esc(l.google_sync_error) + (man ? '<button type="button" class="am-btn am-btn-danger am-btn-sm" data-retry="' + esc(key) + '"' + (busy ? ' disabled' : '') + '><i data-lucide="refresh-cw"></i>Retry Sync</button>' : '') + '</div>';
    var canRun = !!(d && d.canRun), isLive = !!(l && l.live_status === 'live'), erpEnded = !!(l && l.live_status === 'ended');
    if (hasMeet) {
      html += '<section class="am-hero is-ready' + (isLive ? ' is-live' : '') + '"><div class="am-hero-ic"><i data-lucide="' + (isLive ? 'radio' : 'video') + '"></i></div><div class="am-hero-t"><b>' + (isLive ? 'Class is live' : erpEnded ? 'Class ended' : 'Google Meet') + '</b><span>' + esc(l.google_meet_url.replace(/^https?:\/\//, '')) + '</span></div>'
        + '<button type="button" class="am-ic-btn" data-copy title="Copy Meet link" aria-label="Copy Meet link"><i data-lucide="link"></i></button>'
        + (isLive ? '<div class="am-live-row"><span class="am-live-dot"></span>Live in ERP since ' + esc(clock(l.joined_at)) + (l.joined_by ? ' · ' + esc(l.joined_by.split('@')[0]) : '') + '</div>' : '')
        + (!erpEnded && (!isEnded || isLive) ? '<button type="button" class="am-btn am-btn-meet am-hero-join" data-join><i data-lucide="video"></i>' + (isLive ? 'Rejoin Google Meet' : 'Join Live') + '</button>' : '')
        + (isLive && canRun && !S.endOpen ? '<button type="button" class="am-btn am-btn-danger am-hero-join" data-end-open><i data-lucide="square"></i>End Class</button>' : '')
        + '</section>';
      if (S.endOpen && canRun) html += '<section class="am-cancel"><b>End this live class?</b><span>The ERP marks the class ended and starts syncing the Google Meet report. The official duration comes from Google Meet, not from this button.</span>'
        + '<div class="am-m-actions"><button type="button" class="am-btn am-btn-ghost" data-end-no>Cancel</button><button type="button" class="am-btn am-btn-danger" data-end-go' + (busy ? ' disabled' : '') + '>' + (busy ? 'Ending…' : 'End Class') + '</button></div></section>';
      html += reportHTML(o, l, d, canRun, busy);
    } else if (isC) {
      html += '<section class="am-hero is-muted"><div class="am-hero-ic"><i data-lucide="calendar-x"></i></div><div class="am-hero-t"><b>Class cancelled</b><span>' + (l && l.google_calendar_event_id ? (s === 'cancelled' ? 'Google Calendar sent the cancellation to every attendee.' : 'The Calendar event still needs to be cancelled — Retry Sync.') : 'Only this date is affected.') + '</span></div></section>';
    } else if (man && ready() && !isEnded) {
      html += '<section class="am-hero"><div class="am-hero-ic"><i data-lucide="video-off"></i></div><div class="am-hero-t"><b>No Google Meet yet</b><span>Creates a Calendar event with a Meet link and emails everyone with an address.</span></div>'
        + '<button type="button" class="am-btn am-hero-join" data-create="' + esc(key) + '"' + (busy ? ' disabled' : '') + '><i data-lucide="' + (busy ? 'loader' : 'video') + '"></i>' + (busy ? 'Creating…' : 'Create Google Meet') + '</button></section>';
    } else {
      html += '<section class="am-hero is-muted"><div class="am-hero-ic"><i data-lucide="video-off"></i></div><div class="am-hero-t"><b>' + (isEnded ? 'Class ended' : 'Meet link not created yet') + '</b><span>' + (isEnded ? 'No Meet was used for this class.' : man ? 'Connect the Google account (banner above) to create Meet links.' : 'The Academic team adds the link — it will appear here and in your Google Calendar.') + '</span></div></section>';
    }

    // ── facts
    var rem = (l && l.reminder_minutes && l.reminder_minutes.length) ? l.reminder_minutes : (S.status && S.status.defaultReminders);
    html += '<div class="am-facts">'
      + fact('user-round', 'Trainer', esc(o.trainerName))
      + fact(o.isOne ? 'graduation-cap' : 'users', o.isOne ? 'Student' : 'Batch', esc(o.isOne ? o.who : o.batch.name), o.isOne ? '' : o.students.length + ' student' + (o.students.length === 1 ? '' : 's'))
      + fact('bell', 'Reminder', esc(remText(rem)))
      + '</div>';

    // ── attendees
    html += '<section class="am-att">';
    if (!d) html += '<div class="am-att-h"><b>Attendees</b></div><div class="am-skel"></div><div class="am-skel"></div>';
    else if (d.error) html += '<div class="am-att-h"><b>Attendees</b></div><div class="am-err">' + esc(d.error) + '</div>';
    else {
      var inv = d.invited || [], miss = d.notInvited || [], total = inv.length + miss.length;
      var pct = total ? Math.round(inv.length / total * 100) : 0;
      html += '<div class="am-att-h"><b>Attendees</b><span>' + inv.length + ' of ' + total + ' can receive the invitation</span></div>'
        + '<div class="am-bar-t"><i style="width:' + pct + '%"></i></div>';
      if (inv.length) {
        html += '<div class="am-people">';
        inv.forEach(function (p) { html += '<div class="am-person"><span class="am-av' + (p.role === 'trainer' ? ' is-tr' : p.role === 'review' ? ' is-rv' : '') + '">' + (p.role === 'review' ? '<i data-lucide="eye"></i>' : esc(initials(p.name))) + '</span><div class="am-p-n"><b>' + esc(p.role === 'review' ? p.email : p.name) + '</b><span>' + esc(p.role === 'review' ? 'Review / Academic Monitoring' : p.email) + '</span></div><span class="am-role">' + (p.role === 'trainer' ? 'Trainer' : p.role === 'review' ? 'Review' : 'Student') + '</span></div>'; });
        html += '</div>';
      }
      if (miss.length) {
        var trMiss = miss.filter(function (p) { return p.role === 'trainer'; }), stMiss = miss.filter(function (p) { return p.role === 'student'; });
        html += '<div class="am-miss"><div class="am-miss-h"><i data-lucide="mail-x"></i><div><b>' + miss.length + ' without an email address</b><span>'
          + (l && l.google_calendar_event_id && !isC ? 'Meet created, but ' + (miss.length === 1 ? 'this participant was' : 'these participants were') + ' not invited.' : 'They won’t get the Google Calendar invitation.')
          + '</span></div>' + (man && stMiss.length ? '<button type="button" class="am-btn am-btn-ghost am-btn-sm" data-fix-toggle>' + (S.fixOpen ? 'Done' : 'Add emails') + '</button>' : '') + '</div>';
        if (man && S.fixOpen) {
          html += '<div class="am-fix-list">' + stMiss.map(function (p) { return '<div class="am-fix"><span class="am-av">' + esc(initials(p.name)) + '</span><span class="am-fix-n">' + esc(p.name) + '</span><input type="email" placeholder="name@email.com" data-fix-input="' + esc(p.id) + '" autocomplete="off"><button type="button" class="am-btn am-btn-ghost am-btn-sm" data-fix="' + esc(p.id) + '">Save</button></div>'; }).join('') + '</div>';
        } else {
          html += '<div class="am-chips">' + miss.map(function (p) { return '<span class="am-nchip">' + esc(p.name) + (p.role === 'trainer' ? ' · Trainer' : '') + '</span>'; }).join('') + '</div>';
        }
        if (trMiss.length) html += '<div class="am-miss-note">Trainer email comes from the HR employee record — ask HR to add it.</div>';
        html += '</div>';
      }
      if (!total) html += '<div class="am-meet-link">No trainer or students on this class yet.</div>';
    }
    html += '</section>';

    // ── class history
    if (d && d.events && d.events.length) {
      html += '<section class="am-hist"><button type="button" class="am-hist-h" data-hist-toggle aria-expanded="' + !!S.histOpen + '"><b>Class history</b><span>' + d.events.length + ' event' + (d.events.length === 1 ? '' : 's') + '</span><i data-lucide="chevron-' + (S.histOpen ? 'up' : 'down') + '"></i></button>';
      if (S.histOpen) html += '<ol class="am-tl">' + d.events.slice().reverse().map(function (ev) {
        return '<li><time>' + esc(new Date(ev.at).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</time><b>' + esc(ev.event) + '</b>' + (ev.detail ? '<span>' + esc(ev.detail) + '</span>' : '') + '</li>';
      }).join('') + '</ol>';
      html += '</section>';
    }

    // ── online batch
    if (man && o.kind === 'class' && !S.tableMissing) {
      html += '<label class="am-switch am-online"><input type="checkbox" data-online="' + esc(o.batch.id) + '"' + (S.online[o.batch.id] ? ' checked' : '') + '><span><b>Online batch</b>Create the Meet automatically for every upcoming class of ' + esc(o.batch.name) + '</span></label>';
    }

    // ── cancel confirm
    if (S.cancelOpen && man && !isC) {
      html += '<section class="am-cancel"><b>Cancel this class?</b><span>Marked cancelled in the ERP' + (l && l.google_calendar_event_id ? ' and Google Calendar sends a cancellation to every attendee' : '') + '. Only this date — the batch schedule stays the same.</span><textarea class="am-m-reason" id="am-cancel-reason" placeholder="Reason (optional)"></textarea>'
        + '<div class="am-m-actions"><button type="button" class="am-btn am-btn-ghost" data-cancel-no>Keep class</button><button type="button" class="am-btn am-btn-danger" data-cancel-go' + (busy ? ' disabled' : '') + '>' + (busy ? 'Cancelling…' : 'Cancel class') + '</button></div></section>';
    }
    html += '</div>';

    // ── footer actions (by permission)
    var acts = '';
    if (typeof g('openBatchDetails') === 'function' && o.batch && o.batch.id) acts += '<button type="button" class="am-btn am-btn-ghost" data-attendance><i data-lucide="clipboard-check"></i>Attendance</button>';
    if (man && d && d.invited && d.invited.length) acts += '<a class="am-btn am-btn-ghost" href="' + esc(mailto(o, d.invited, l)) + '"><i data-lucide="mail"></i>Email</a>';
    if (!isC) acts += '<button type="button" class="am-btn am-btn-ghost" data-copy-details><i data-lucide="clipboard-copy"></i>Copy Details</button>';
    if (!isC && navigator.share) acts += '<button type="button" class="am-btn am-btn-ghost" data-share><i data-lucide="share-2"></i>Share</button>';
    if (man && l && l.google_calendar_event_id && !isC && !isEnded && !erpEnded) acts += '<button type="button" class="am-btn am-btn-ghost" data-resend="' + esc(key) + '"' + (busy ? ' disabled' : '') + '><i data-lucide="send"></i>Resend Invitation</button>';
    if (man && !isC && !isEnded && !isLive && !erpEnded && canEditTime(o)) acts += '<button type="button" class="am-btn am-btn-ghost" data-edit-time><i data-lucide="clock"></i>Edit Time</button>';
    if (man && !isC && !isEnded && !isLive && !erpEnded && !S.cancelOpen) acts += '<button type="button" class="am-btn am-btn-danger" data-cancel-open><i data-lucide="x-circle"></i>Cancel</button>';
    if (acts) html += '<div class="am-mf">' + acts + '</div>';

    box.innerHTML = html;
    icons();
  }

  var DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function clock(ts) { return ts ? new Date(ts).toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—'; }
  function mins(n) { return n == null ? '—' : n + ' min'; }

  /** WhatsApp-ready class message (also used by Share and Email). No internal ids. */
  function detailsText(o, l) {
    var d = o.date.split('-').map(Number);
    var lines = ['BROKEN ENGLISH – LIVE CLASS', '', 'Class: ' + o.title];
    if (o.course && o.title.toLowerCase().indexOf(o.course.toLowerCase()) < 0) lines.push('Course: ' + o.course);
    lines.push('Date: ' + DOW_LONG[dowOf(o.date)] + ', ' + d[2] + ' ' + MON_LONG[d[1] - 1] + ' ' + d[0]);
    lines.push('Time: ' + fmt(o.startMin) + ' – ' + fmt(o.endMin));
    lines.push('Trainer: ' + o.trainerName);
    lines.push('Type: ' + (o.kind === 'oto' ? '1:1' : o.typeLabel));
    if (!o.isOne) lines.push('Students: ' + o.students.length);
    if (l && l.google_meet_url && l.class_status !== 'cancelled') lines.push('', 'Google Meet:', l.google_meet_url);
    lines.push('', 'Please join the class on time.');
    return lines.join('\n');
  }

  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      toast(ok ? 'success' : 'error', ok ? okMsg : 'Copy failed — your browser blocked the clipboard.');
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { toast('success', okMsg); }, fallback);
    else fallback();
  }

  function shareDetails(o, l) {
    var text = detailsText(o, l);
    if (!navigator.share) return copyText(text, 'Class details copied.');
    navigator.share({ title: 'Broken English – ' + o.title, text: text }).catch(function (e) { if (!e || e.name !== 'AbortError') copyText(text, 'Class details copied.'); });
  }

  /** Join Live: Meet opens in its own tab; the ERP stays here and records the join. */
  function joinLive(o) {
    var l = linkOf(o); if (!l || !l.google_meet_url) return;
    var w = window.open(l.google_meet_url, '_blank');
    if (w) { try { w.opener = null; } catch (e) {} } else toast('warning', 'Your browser blocked the new tab — allow pop-ups for this site, or use the Meet link.', 7000);
    api('join', { key: o.key, start: startHint(o) }).then(function (j) {
      if (j.row) { S.links[o.key] = j.row; S.touched[o.key] = Date.now(); }
      render(); if (S.modalKey === o.key) { renderModal(); fetchDetails(o.key); }
    }, function (e) { if (!sessionGuard(e)) toast('error', e.message, 6000); });
  }

  function reportToast(j) {
    if (!j) return;
    if (j.waiting) toast('info', j.message || 'Waiting for the Google Meet report.', 7000);
    else if (j.row && j.row.meet_sync_status === 'synced') toast('success', 'Meet report synced — ' + (j.row.actual_duration_minutes != null ? j.row.actual_duration_minutes + ' min class.' : 'ready.'));
  }

  // ── after the class: official Meet report + attendance review ──
  function reportHTML(o, l, d, canRun, busy) {
    var st = l.meet_sync_status || 'none';
    if (st === 'none' && l.live_status !== 'ended') return '';
    if (st === 'pending' || st === 'waiting' || st === 'none') {
      return '<section class="am-report is-wait"><div class="am-rp-h"><i data-lucide="hourglass"></i><div><b>Waiting for the Google Meet report</b><span>' + esc(l.meet_sync_error || 'The report appears a few minutes after everyone leaves the call.') + '</span></div>'
        + '<button type="button" class="am-btn am-btn-ghost am-btn-sm" data-sync' + (busy ? ' disabled' : '') + '><i data-lucide="refresh-cw"></i>' + (busy ? 'Checking…' : 'Check now') + '</button></div></section>';
    }
    if (st === 'failed') {
      return '<div class="am-err"><b>Meet report not synced.</b> ' + esc(l.meet_sync_error || '') + '<button type="button" class="am-btn am-btn-danger am-btn-sm" data-sync' + (busy ? ' disabled' : '') + '><i data-lucide="refresh-cw"></i>Try again</button></div>';
    }
    var parts = l.meet_participants || [], sugg = l.attendance_suggestion || [];
    var invitedCount = ((d && d.invited) || l.invited || []).filter(function (p) { return p.role !== 'review'; }).length;
    var joined = parts.filter(function (p) { return p.role !== 'unmatched'; }).length;
    var schedDur = o.endMin - o.startMin, diff = l.actual_duration_minutes != null ? l.actual_duration_minutes - schedDur : null;
    var attLabel = l.attendance_review_status === 'confirmed' ? ['Confirmed', 'ok'] : sugg.length ? ['Ready for review', 'warn'] : ['No students to review', ''];
    var h = '<section class="am-report"><div class="am-rp-top"><span class="am-pill st-live">Class completed</span><span class="am-rp-sync">Meet report · ' + esc(clock(l.meet_report_synced_at)) + '</span></div>'
      + '<div class="am-rp-grid">'
      + '<div><small>Scheduled</small><b>' + esc(fmt(o.startMin) + ' – ' + fmt(o.endMin)) + '</b><span>' + schedDur + ' min</span></div>'
      + '<div><small>Actual (Google Meet)</small><b>' + esc(clock(l.actual_start) + ' – ' + clock(l.actual_end)) + '</b><span>' + mins(l.actual_duration_minutes) + (diff ? ' · ' + (diff > 0 ? '+' : '') + diff + ' min' : '') + '</span></div>'
      + '<div><small>Trainer presence</small><b>' + mins(l.trainer_presence_minutes) + '</b><span>' + (l.trainer_join_at ? esc(clock(l.trainer_join_at) + ' – ' + clock(l.trainer_leave_at)) : 'Trainer not matched in Meet') + '</span></div>'
      + '<div><small>Participants</small><b>' + joined + ' joined</b><span>' + invitedCount + ' invited' + (parts.length > joined ? ' · ' + (parts.length - joined) + ' other' : '') + '</span></div>'
      + '</div>'
      + '<div class="am-rp-att' + (attLabel[1] ? ' is-' + attLabel[1] : '') + '"><i data-lucide="' + (attLabel[1] === 'ok' ? 'check-circle-2' : 'clipboard-list') + '"></i><span>Attendance: <b>' + attLabel[0] + '</b></span></div>'
      + '<div class="am-rp-btns">'
      + (sugg.length ? '<button type="button" class="am-btn am-btn-sm' + (S.revOpen ? '' : ' am-btn-ghost') + '" data-rev-toggle><i data-lucide="user-check"></i>Review Attendance</button>' : '')
      + '<button type="button" class="am-btn am-btn-sm' + (S.repOpen ? '' : ' am-btn-ghost') + '" data-rep-toggle><i data-lucide="file-bar-chart"></i>Meet Report</button>'
      + '<button type="button" class="am-btn am-btn-ghost am-btn-sm" data-sync title="Sync the report again"' + (busy ? ' disabled' : '') + '><i data-lucide="refresh-cw"></i></button>'
      + '</div>';
    if (S.revOpen && sugg.length) {
      var LBL = { present: 'Present', review: 'Review', absent: 'Absent' };
      h += '<div class="am-rp-list"><div class="am-rp-note">Suggested from Google Meet (present = at least half the class). Confirm in Class &amp; Attendance — nothing is saved from here.</div>'
        + sugg.map(function (x) { return '<div class="am-rp-row"><span class="am-av">' + esc(initials(x.name)) + '</span><b>' + esc(x.name) + '</b><span class="am-rp-min">' + (x.minutes ? x.minutes + ' min' : 'Did not join') + '</span><span class="am-sg sg-' + x.suggested + '">' + LBL[x.suggested] + '</span></div>'; }).join('')
        + (canRun && l.attendance_review_status !== 'confirmed' ? '<button type="button" class="am-btn am-rp-go" data-att-confirm><i data-lucide="clipboard-check"></i>Confirm in Class &amp; Attendance</button>' : '')
        + '</div>';
    }
    if (S.repOpen) {
      h += '<div class="am-rp-list">' + (parts.length ? parts.map(function (p) {
        return '<div class="am-rp-row"><span class="am-av' + (p.role === 'trainer' ? ' is-tr' : '') + '">' + esc(initials(p.name)) + '</span><b>' + esc(p.name) + '<em>' + (p.role === 'trainer' ? 'Trainer' : p.role === 'student' ? 'Student' : 'Not on roster') + '</em></b><span class="am-rp-min">' + esc(clock(p.first) + ' – ' + clock(p.last)) + (p.sessions > 1 ? ' · ' + p.sessions + ' joins' : '') + '</span><span class="am-sg">' + p.minutes + ' min</span></div>';
      }).join('') : '<div class="am-rp-note">Nobody joined this Meet.</div>') + '<div class="am-rp-note">Names are matched from Google Meet display names — Meet does not share email addresses.</div></div>';
    }
    return h + '</section>';
  }

  /** Opens the EXISTING attendance modal for this class date, pre-filled with the Meet suggestion. */
  async function confirmAttendance(o, l) {
    var sugg = (l && l.attendance_suggestion) || [];
    closeModal();
    var list = window._liveBatches || [], idx = -1;
    for (var i = 0; i < list.length; i++) if ((list[i].raw || list[i].name) === o.batch.name) { idx = i; break; }
    if (o.kind === 'oto' || idx < 0 || typeof window.openAtt !== 'function') {
      if (typeof g('openBatchDetails') === 'function') g('openBatchDetails')(o.batch.id);
      toast('info', 'Mark this session in the batch — Meet suggestion: ' + sugg.map(function (x) { return x.name + ' ' + (x.minutes || 0) + ' min'; }).join(', '), 9000);
      return;
    }
    await window.openAtt(idx);
    var dt = document.getElementById('att_date');
    if (dt && dt.value !== o.date) { dt.value = o.date; dt.dispatchEvent(new Event('change', { bubbles: true })); }
    var norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
    var by = {}; sugg.forEach(function (x) { by[norm(x.name)] = x; });
    (list[idx].students || []).forEach(function (st, j) {
      var x = by[norm(st.name)]; if (!x) return;
      if (typeof window.setAtt === 'function') window.setAtt(j, x.suggested === 'present');
      var row = document.getElementById('att_' + j); row = row && row.closest('.att-row');
      if (row && !row.querySelector('.am-att-hint')) { var tag = document.createElement('span'); tag.className = 'am-att-hint sg-' + x.suggested; tag.textContent = 'Meet ' + (x.minutes || 0) + ' min · ' + (x.suggested === 'present' ? 'Present' : x.suggested === 'review' ? 'Review' : 'Absent'); row.querySelector('.att-name').appendChild(tag); }
    });
    var listEl = document.getElementById('att_list');
    if (listEl && !listEl.querySelector('.am-att-note')) { var n = document.createElement('div'); n.className = 'am-att-note'; n.textContent = 'Pre-filled from Google Meet for ' + fmtDate(o.date) + '. Check every student, then save.'; listEl.prepend(n); }
  }

  function mailto(o, people, l) {
    var to = people.map(function (p) { return p.email; }).filter(Boolean);
    var subj = 'Broken English | ' + o.title + ' — ' + fmtDate(o.date, { day: '2-digit', month: 'short' }) + ', ' + fmt(o.startMin);
    var bodyTxt = 'Hello,\n\n' + detailsText(o, l) + '\n\n— Broken English Academic';
    return 'mailto:?bcc=' + encodeURIComponent(to.join(',')) + '&subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(bodyTxt);
  }

  function canEditTime(o) {
    if (typeof g('openPostponeModal') !== 'function') return false;
    if (o.kind === 'oto') return ['pending', 'scheduled'].indexOf(String(o.oto.status || 'pending').toLowerCase()) >= 0;
    return true;
  }

  // Edit Time = the existing Postpone Class flow (same date, new time). After it saves,
  // academics.html calls AcademicMeet.onClassMoved() → the SAME Calendar event is updated.
  function editTime(o) {
    var rows = window._acadPpRows = window._acadPpRows || {};
    var k = 'am' + (window._acadPpSeq = (window._acadPpSeq || 0) + 1);
    rows[k] = { kind: o.kind, batch: o.batch, date: o.date, startMin: o.startMin, dur: o.dur, oto: o.oto || null, student: o.who || '', trainerId: o.trainerId, trainerName: o.trainerName, postponed: o.postponed || null };
    closeModal();
    g('openPostponeModal')(k);
  }

  async function fixEmail(studentId, input) {
    var v = String(input && input.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { toast('error', 'Enter a valid email address.'); if (input) input.focus(); return; }
    var r = await db().from('students').update({ email: v }).eq('id', studentId);
    if (r.error) { toast('error', 'Could not save the email: ' + r.error.message); return; }
    toast('success', 'Email saved.' + (linkOf(occByKey(S.modalKey) || {}) && (linkOf(occByKey(S.modalKey)) || {}).google_calendar_event_id ? ' Use Resend Invitation to invite them.' : ''));
    S.modalDetails = null; renderModal(); fetchDetails(S.modalKey);
  }

  // ── events ────────────────────────────────────────────────────────────────
  function wire() {
    S.root.addEventListener('click', function (e) {
      var t = e.target.closest('button,a,[data-open],[data-day]');
      if (!t || !S.root.contains(t)) return;
      if (t.hasAttribute('data-stop')) { e.stopPropagation(); return; }
      if (t.hasAttribute('data-view')) { S.view = t.getAttribute('data-view'); if (S.view === 'day') S.anchor = S.anchor || istToday(); load(); return; }
      if (t.hasAttribute('data-nav')) {
        var n = +t.getAttribute('data-nav');
        if (!n) S.anchor = istToday();
        else if (S.view === 'day') S.anchor = addDays(S.anchor, n);
        else if (S.view === 'week') S.anchor = addDays(S.anchor, 7 * n);
        else { var dd = new Date(S.anchor.slice(0, 8) + '01T00:00:00Z'); dd.setUTCMonth(dd.getUTCMonth() + n); S.anchor = dd.toISOString().slice(0, 10); }
        load(); return;
      }
      if (t.hasAttribute('data-create')) { e.stopPropagation(); createMeet(t.getAttribute('data-create')); return; }
      if (t.hasAttribute('data-retry')) { e.stopPropagation(); retry(t.getAttribute('data-retry')); return; }
      if (t.id === 'am-bulk') { bulkCreate(); return; }
      if (t.hasAttribute('data-connect')) { connect(t); return; }
      if (t.hasAttribute('data-settings')) { settings(); return; }
      if (t.hasAttribute('data-recheck')) { loadStatus().then(render); return; }
      if (t.hasAttribute('data-relogin')) { try { window.BESession && BESession.clear(me().username); } catch (x) {} location.href = 'index.html'; return; }
      if (t.hasAttribute('data-day')) { S.view = 'day'; S.anchor = t.getAttribute('data-day'); load(); return; }
      if (t.hasAttribute('data-open')) { openModal(t.getAttribute('data-open')); }
    });
    S.root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var t = e.target.closest('[data-open]'); if (!t || e.target.closest('button,a')) return;
      e.preventDefault(); openModal(t.getAttribute('data-open'));
    });
    var m = modalEl();
    m.addEventListener('click', function (e) {
      if (e.target === m || e.target.closest('[data-close]')) return closeModal();
      var t = e.target.closest('button,a,input'); if (!t) return;
      var key = S.modalKey, o = occByKey(key);
      if (t.hasAttribute('data-create')) return createMeet(key);
      if (t.hasAttribute('data-retry')) return retry(key);
      if (t.hasAttribute('data-resend')) return run(key, 'resend', null, 'Invitations sent again.');
      if (t.hasAttribute('data-copy')) { copyText((linkOf(o) || {}).google_meet_url || '', 'Meet link copied.'); return; }
      if (t.hasAttribute('data-edit-time')) return editTime(o);
      if (t.hasAttribute('data-copy-details')) { copyText(detailsText(o, linkOf(o)), 'Class details copied — paste into WhatsApp.'); return; }
      if (t.hasAttribute('data-share')) { shareDetails(o, linkOf(o)); return; }
      if (t.hasAttribute('data-join')) { joinLive(o); return; }
      if (t.hasAttribute('data-end-open')) { S.endOpen = true; renderModal(); return; }
      if (t.hasAttribute('data-end-no')) { S.endOpen = false; renderModal(); return; }
      if (t.hasAttribute('data-end-go')) { S.endOpen = false; return run(key, 'end', null, null).then(reportToast); }
      if (t.hasAttribute('data-sync')) { return run(key, 'sync_report', null, null).then(reportToast); }
      if (t.hasAttribute('data-rev-toggle')) { S.revOpen = !S.revOpen; S.repOpen = false; renderModal(); return; }
      if (t.hasAttribute('data-rep-toggle')) { S.repOpen = !S.repOpen; S.revOpen = false; renderModal(); return; }
      if (t.hasAttribute('data-hist-toggle')) { S.histOpen = !S.histOpen; renderModal(); return; }
      if (t.hasAttribute('data-att-confirm')) { confirmAttendance(o, linkOf(o)); return; }
      if (t.hasAttribute('data-fix-toggle')) { S.fixOpen = !S.fixOpen; renderModal(); var fi = m.querySelector('[data-fix-input]'); if (fi) fi.focus(); return; }
      if (t.hasAttribute('data-cancel-open')) { S.cancelOpen = true; renderModal(); var r = document.getElementById('am-cancel-reason'); if (r) r.focus(); return; }
      if (t.hasAttribute('data-cancel-no')) { S.cancelOpen = false; renderModal(); return; }
      if (t.hasAttribute('data-cancel-go')) { var reason = (document.getElementById('am-cancel-reason') || {}).value || ''; S.cancelOpen = false; return run(key, 'cancel', { reason: reason }, 'Class cancelled' + ((linkOf(o) || {}).google_calendar_event_id ? ' — attendees notified by Google Calendar.' : '.')); }
      if (t.hasAttribute('data-attendance')) { closeModal(); g('openBatchDetails')(o.batch.id); return; }
      if (t.hasAttribute('data-fix')) return fixEmail(t.getAttribute('data-fix'), m.querySelector('[data-fix-input="' + t.getAttribute('data-fix') + '"]'));
    });
    m.addEventListener('change', function (e) { var t = e.target.closest('[data-online]'); if (t) setOnline(t.getAttribute('data-online'), t.checked); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.modalKey) closeModal(); });
    window.addEventListener('message', function (e) { if (e.data && e.data.type === 'be-academic-meet-oauth') { loadStatus().then(function () { render(); if (e.data.ok) toast('success', 'Google account connected.'); }); } });
    var mq = window.matchMedia && window.matchMedia('(max-width:760px)');
    if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (S.view === 'week') render(); });
    // Keep "Live now" / ended states current.
    setInterval(function () { if (S.root && S.root.offsetParent !== null && !S.loading) render(); }, 60000);
  }

  async function connect(btn) {
    btn.disabled = true;
    var w = window.open('', 'be_google_connect', 'width=520,height=680');
    try {
      var j = await api('oauth_url');
      if (w) w.location.href = j.url; else location.href = j.url;
    } catch (e) { if (w) w.close(); if (!sessionGuard(e)) toast('error', e.message, 7000); }
    finally { btn.disabled = false; }
  }

  function settings() {
    var cur = (S.status && S.status.defaultReminders) || [30];
    var sel = {}; cur.forEach(function (m) { sel[m] = 1; });
    var box = document.getElementById('am-m-body');
    S.modalKey = null;
    var orig = cur.slice().sort().join(',');
    var rvOrig = (S.status && S.status.reviewEmail) || '', rv = rvOrig;
    function paint() {
      var email = (S.status && S.status.organizerEmail) || 'Connected account';
      var picked = Object.keys(sel).map(Number).sort(function (x, y) { return y - x; });
      var dirty = picked.slice().sort().join(',') !== orig || rv.trim().toLowerCase() !== rvOrig;
      box.innerHTML = '<div class="am-mh"><div class="am-mh-pills"><span class="am-pill">Live Classes</span><span class="am-pill st-live">Connected</span></div>'
        + '<h3 class="am-m-title" id="am-m-title">Google settings</h3><div class="am-mh-when"><span><i data-lucide="calendar-check"></i>Google Calendar + Google Meet</span></div></div>'
        + '<div class="am-m-scroll">'
        // organizer
        + '<div class="am-set-h">Organizer account</div>'
        + '<div class="am-org"><span class="am-av is-tr am-av-lg">' + esc(initials(email.split('@')[0].replace(/[._-]+/g, ' '))) + '</span>'
        + '<div class="am-org-t"><b>' + esc(email) + '</b><span>Creates every class event and Meet link. Trainers and students are invited as guests.</span></div>'
        + '<button type="button" class="am-btn am-btn-ghost am-btn-sm" data-reconnect><i data-lucide="refresh-cw"></i>Change</button></div>'
        // reminders
        + '<div class="am-set-h">Default reminder <span>Choose up to two</span></div>'
        + '<div class="am-rem-grid">' + REMINDER_CHOICES.map(function (m) {
            var on = !!sel[m];
            return '<button type="button" data-rem="' + m + '" class="am-rem-opt' + (on ? ' on' : '') + '" aria-pressed="' + on + '"><i data-lucide="' + (on ? 'check' : 'bell') + '"></i><b>' + (m >= 60 ? m / 60 : m) + '</b><span>' + (m >= 60 ? 'hour' : 'min') + ' before</span></button>';
          }).join('') + '</div>'
        + '<div class="am-rem-prev"><i data-lucide="info"></i><span>' + (picked.length ? 'Popup and email reminder <b>' + esc(remText(picked)) + '</b> each class.' : 'Pick at least one reminder.') + ' Used for new Meet links and when a class is next updated. Each person’s own Google Calendar settings also apply.</span></div>'
        // review email
        + '<div class="am-set-h">Meet review email <span>Invited to every class</span></div>'
        + '<div class="am-org"><span class="am-av is-rv am-av-lg"><i data-lucide="eye"></i></span><div class="am-org-t"><input type="email" class="am-rv-in" data-rv value="' + esc(rv) + '" placeholder="review@example.com" autocomplete="off"><span>Gets the Google Calendar / Meet invitation for every new class (Academic review &amp; monitoring). Leave empty to stop.</span></div></div>'
        + '</div>'
        + '<div class="am-mf"><button type="button" class="am-btn am-btn-ghost" data-close>Cancel</button><button type="button" class="am-btn" data-rem-save' + (dirty && picked.length ? '' : ' disabled') + '><i data-lucide="check"></i>Save changes</button></div>';
      icons();
    }
    paint();
    var m = modalEl(); m.classList.add('on'); m.setAttribute('aria-hidden', 'false');
    box.onclick = async function (e) {
      var t = e.target.closest('button'); if (!t) return;
      if (t.hasAttribute('data-rem')) { var v = +t.getAttribute('data-rem'); if (sel[v]) delete sel[v]; else { sel[v] = 1; var ks = Object.keys(sel); if (ks.length > 2) delete sel[ks[0] == v ? ks[1] : ks[0]]; } paint(); return; }
      if (t.hasAttribute('data-reconnect')) { connect(t); return; }
      if (t.hasAttribute('data-rem-save')) {
        var picks = Object.keys(sel).map(Number); if (!picks.length) { toast('error', 'Choose at least one reminder.'); return; }
        var rvNew = rv.trim().toLowerCase();
        if (rvNew && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rvNew)) { toast('error', 'Enter a valid review email, or leave it empty.'); return; }
        t.disabled = true;
        try {
          if (picks.slice().sort().join(',') !== orig) { var j = await api('set_reminders', { reminders: picks }); S.status.defaultReminders = j.defaultReminders; }
          if (rvNew !== rvOrig) { var k = await api('set_review_email', { email: rvNew }); S.status.reviewEmail = k.reviewEmail; }
          toast('success', 'Settings saved.'); closeModal(); render();
        } catch (x) { toast('error', x.message); t.disabled = false; }
      }
    };
    box.oninput = function (e) {
      if (!e.target.hasAttribute('data-rv')) return;
      rv = e.target.value;
      var picked = Object.keys(sel).map(Number).sort().join(','), btn = box.querySelector('[data-rem-save]');
      if (btn) btn.disabled = !(picked && (picked !== orig || rv.trim().toLowerCase() !== rvOrig));
    };
  }

  function subscribe() {
    if (!window.BELive) return;
    BELive.on('acad-meet', ['academic_live_classes', 'academic_meet_batches'], function () { if (S.root) reloadLinks().catch(function () {}); }, { debounce: 300 });
    // ERP schedule changes (postpone / 1:1 edits / batch edits) → regenerate the classes.
    BELive.on('acad-meet-erp', ['class_postponements', 'oto_sessions', 'batches'], function () { if (S.root) load(true); }, { debounce: 800 });
  }

  // ── public API ────────────────────────────────────────────────────────────
  window.AcademicMeet = {
    /** Called by academics.html after injecting academic-meet.html into the tab. */
    mount: async function (container) {
      S.root = container.querySelector('#am-root');
      // The modal lives at <body> level so it overlays the whole Academic shell.
      var m = container.querySelector('#am-modal'); if (m) document.body.appendChild(m);
      S.anchor = istToday();
      var head = S.root.querySelector('#am-heading'); if (head) head.textContent = isOrg() ? 'Live Classes' : 'My Live Classes';
      wire(); subscribe(); paintRange(); icons();
      await loadStatus();
      await load();
    },
    /** Tab re-opened. */
    show: function () { if (S.root) load(true); },
    refresh: function () { return load(true); },
    /** A class time changed through Postpone (same date, new time) → update the SAME Calendar event. */
    onClassMoved: async function (key, start) {
      try {
        var r = await db().from('academic_live_classes').select('google_calendar_event_id,class_status').eq('occurrence_key', key).maybeSingle();
        if (!r.data || !r.data.google_calendar_event_id || r.data.class_status === 'cancelled') { if (S.root) load(true); return; }
        await api('update', { key: key, start: start });
        toast('success', 'Google Calendar updated — attendees get the new time.');
      } catch (e) {
        toast('error', 'Time changed in the ERP, but Google Calendar was not updated: ' + (e.message || e) + ' Open Live Classes → Retry Sync.', 9000);
      }
      if (S.root) load(true);
    },
    /** Create Batch with "Create online class" ticked. */
    onBatchCreated: async function (batchId) {
      var r = await db().from('academic_meet_batches').upsert({ batch_id: batchId, online: true, set_by: me().username || null, updated_at: new Date().toISOString() });
      if (r.error) { toast('error', 'Batch created, but online classes could not be switched on: ' + r.error.message, 8000); return; }
      S.online[batchId] = true;
      if (!S.status) await loadStatus();
      if (!S.status || !S.status.connected) { toast('warning', 'Batch saved as online. Meet links will be created once the Google account is connected in Live Classes.', 8000); return; }
      autoCreate();
    }
  };
})();
