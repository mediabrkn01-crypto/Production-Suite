/* ════════════════════════════════════════════════════════════════════════════
   BEAttRemind — trainer "Attendance Pending" reminders (Academic portal).

   Rule: a class the signed-in trainer taught today / yesterday whose attendance is still not
   saved by (class END + 10 min, Asia/Kolkata) → reminder popup. "Remind Me Later" hides it for
   5 minutes; it returns until the attendance is actually saved.

   Sources of truth (nothing inferred from the UI):
     schedule      batches (status 'active' — frozen / completed batches never qualify)
                   HR holidays for Academics (all-department or scoped to 'education') remove
                   the occurrence entirely (generateBatchOccurrences / _acadHolidayFor)
                   → generateBatchOccurrences() (day_pattern, time_slot, HR holidays and
                   class_postponements: a postponed class uses its NEW date / start time)
                   → _acadCapToRemaining() (no reminders past the batch's real session total)
                   + oto_sessions (1:1 sessions of group courses, status pending / scheduled)
     trainer       trainers.hr_employee_id = this employee's id (stable id, never the name)
     done          attendance rows for (batch_name, session_date) — any status, so an all-absent
                   "class not held" save also counts · oto_sessions.status ≠ pending/scheduled
     not held      academic_live_classes.class_status = 'cancelled' · approved trainer leave
                   (TrainerAvailability — trainer-availability.js; a half day only covers its own
                   half; cancelled / edited leave recalculates on the next check) · HR holidays
     clock         erp_now() (database time) — never the device clock
     state         public.erp_notifications: ONE row per class (dedupe_key att:<class key>);
                   snooze_until = server time + 5 min; resolved_at when attendance is saved.
                   Survives refresh, re-login and switching devices; nothing is re-created
                   every 5 minutes — only the popup repeats.

   The 60 s tick only decides WHEN to re-check; every decision is re-derived from the database.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BEAttRemind) return;
  var GRACE_MIN = 10, SNOOZE_MIN = 5, TZ = 'Asia/Kolkata';
  var S = { tid: null, trainer: null, pending: [], ov: null, busy: false, again: false, started: false, timer: 0, okTable: true };

  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // academics.html declares `const sb` (global lexical binding, not a window property).
  function db() { try { return typeof sb !== 'undefined' ? sb : window.sb; } catch (_) { return window.sb; } }
  function istDay(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); }
  function istMin(d) { var p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).split(':').map(Number); return (p[0] % 24) * 60 + p[1]; }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function toMin(t) { var m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function fmt(min) { if (min == null || isNaN(min)) return ''; var h = Math.floor(min / 60) % 24, m = min % 60; return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function dayLabel(iso, today) { if (iso === today) return 'Today'; if (iso === addDays(today, -1)) return 'Yesterday'; return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }); }

  // ── who am I (stable trainer id) ───────────────────────────────────────
  async function resolveTrainer() {
    if (S.trainer) return S.trainer;
    var emp = window._mediaEmployeeId, t = null;
    if (emp) { var r = await db().from('trainers').select('id,name,hr_employee_id').eq('hr_employee_id', emp).limit(1); t = r.data && r.data[0]; }
    if (!t && window._myTrainerId) { var r2 = await db().from('trainers').select('id,name,hr_employee_id').eq('id', window._myTrainerId).maybeSingle(); t = r2.data; }
    S.trainer = t || null; S.tid = t ? t.id : null;
    return S.trainer;
  }

  // ── pending classes, derived from the database ───────────────────────────
  async function computePending(now) {
    var tr = await resolveTrainer(); if (!tr) return [];
    var today = istDay(now), nowMin = istMin(now), from = addDays(today, -1);
    var due = function (date, endMin) { return date < today || (endMin != null && endMin + GRACE_MIN <= nowMin); };
    if (typeof _acadLoadHolidays === 'function') await _acadLoadHolidays();
    if (typeof _acadLoadPostponements === 'function' && window._acadPostponeOk == null) await _acadLoadPostponements();

    var res = await Promise.all([
      db().from('batches').select('*').eq('status', 'active').eq('trainer_id', tr.id),
      db().from('oto_sessions').select('id,batch_id,student_id,trainer_id,session_number,session_date,start_time,end_time,duration_minutes,status')
        .eq('trainer_id', tr.id).gte('session_date', from).lte('session_date', today).in('status', ['pending', 'scheduled']).then(function (r) { return r; }, function () { return { data: [] }; }),
      // approved trainer leave — the shared rule (trainer-availability.js), one query
      tr.hr_employee_id && window.TrainerAvailability ? TrainerAvailability.load(db(), { from: from, to: today, trainers: [tr] }).then(function (r) { return r; }, function () { return null; }) : null
    ]);
    var batches = (res[0].data || []).filter(function (b) { return !b.deleted_at; });
    var lvIdx = res[2];
    function onLeave(date, startMin, endMin) { return !!(lvIdx && lvIdx.leaveFor(tr, date, startMin, endMin)); }

    var out = [];
    if (batches.length && typeof generateBatchOccurrences === 'function') {
      var names = batches.map(function (b) { return b.name; });
      var att = typeof _acadFetchAllRows === 'function'
        ? await _acadFetchAllRows('attendance', 'batch_name,session_date,session_num,status', function (q) { return q.in('batch_name', names); })
        : ((await db().from('attendance').select('batch_name,session_date,session_num,status').in('batch_name', names)).data || []);
      var marked = new Set((att || []).filter(function (a) { return a.session_date; }).map(function (a) { return a.batch_name + '|' + String(a.session_date).slice(0, 10); }));
      var doneBy = typeof _acadDoneKeysByBatch === 'function' ? _acadDoneKeysByBatch(att) : {};
      batches.forEach(function (b) {
        var occ = generateBatchOccurrences(b, from, today);
        if (typeof _acadCapToRemaining === 'function') occ = _acadCapToRemaining(occ, b, doneBy[b.name], today);
        occ.forEach(function (o) {
          var dur = Number(b.class_duration_minutes) || 60, end = o.startTime != null ? o.startTime + dur : null;
          if (o.date > today || !due(o.date, end) || marked.has(b.name + '|' + o.date) || onLeave(o.date, o.startTime, end)) return;
          out.push({ key: 'att:class:' + b.id + ':' + o.date, liveKey: 'class:' + b.id + ':' + (o.postponed ? o.postponed.original_date : o.date),
            kind: 'class', batchId: b.id, batchName: b.name, title: b.name, date: o.date, start: o.startTime, end: end, postponed: !!o.postponed });
        });
      });
    }
    var oto = res[1].data || [];
    if (oto.length) {
      var bIds = Array.from(new Set(oto.map(function (o) { return o.batch_id; }).filter(Boolean)));
      var sIds = Array.from(new Set(oto.map(function (o) { return o.student_id; }).filter(Boolean)));
      var x = await Promise.all([
        bIds.length ? db().from('batches').select('id,name,status').in('id', bIds) : { data: [] },
        sIds.length ? db().from('students').select('id,name').in('id', sIds) : { data: [] }
      ]);
      var bm = {}, sm = {}; (x[0].data || []).forEach(function (b) { bm[b.id] = b; }); (x[1].data || []).forEach(function (s) { sm[s.id] = s.name; });
      oto.forEach(function (o) {
        var b = bm[o.batch_id]; if (!b || b.status === 'frozen') return;
        var st = toMin(o.start_time); if (st == null) return;
        var en = toMin(o.end_time); if (en == null || en <= st) en = st + (Number(o.duration_minutes) || 30);
        var date = String(o.session_date).slice(0, 10);
        // Academics holiday (all-department or Academics-scoped — same _acadHolidayFor the class
        // generator uses) → no 1:1 reminder either.
        if (!due(date, en) || onLeave(date, st, en) || (typeof _acadHolidayFor === 'function' && _acadHolidayFor(date))) return;
        out.push({ key: 'att:oto:' + o.id, liveKey: 'oto:' + o.id, kind: 'oto', otoId: o.id, batchId: o.batch_id, studentId: o.student_id, sessionNum: o.session_number,
          batchName: b.name, title: b.name + ' · 1:1 with ' + (sm[o.student_id] || 'student'), date: date, start: st, end: en });
      });
    }
    // Cancelled from Live Classes → not held.
    if (out.length) {
      var lr = await db().from('academic_live_classes').select('occurrence_key,class_status').in('occurrence_key', out.map(function (p) { return p.liveKey; }))
        .then(function (r) { return r; }, function () { return { data: [] }; });
      var cancelled = new Set((lr.data || []).filter(function (r) { return r.class_status === 'cancelled'; }).map(function (r) { return r.occurrence_key; }));
      out = out.filter(function (p) { return !cancelled.has(p.liveKey); });
    }
    // Oldest overdue first.
    return out.sort(function (a, b) { return a.date === b.date ? (a.end || 0) - (b.end || 0) : a.date.localeCompare(b.date); });
  }

  // ── one check: compute → sync the logical notifications → maybe show ───────
  async function check() {
    if (!S.started || !window.BENotify) return;
    if (S.busy) { S.again = true; return; }
    S.busy = true;
    try {
      var now = await BENotify.serverNow();
      var list = await computePending(now);
      S.pending = list;
      // Create each class's ONE logical notification (ignored when it already exists).
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        await BENotify.upsert({ type: 'attendance_pending', title: 'Attendance pending for ' + p.title,
          message: dayLabel(p.date, istDay(now)) + ' · ' + fmt(p.start) + ' – ' + fmt(p.end) + '. Attendance was due after this class.',
          entity_type: p.kind === 'oto' ? 'oto_session' : 'class_occurrence', entity_id: p.kind === 'oto' ? String(p.otoId) : p.batchId + ':' + p.date,
          dedupe_key: p.key, link: p.key, recipient_employee_id: window._mediaEmployeeId || null,
          metadata: { batch_id: p.batchId, batch_name: p.batchName, date: p.date, start: fmt(p.start), end: fmt(p.end), kind: p.kind, trainer_id: S.tid } });
      }
      await BENotify.reload();
      if (!BENotify.available) return;   // 20261023_erp_notifications.sql not run yet — no server state, no popups
      // Anything no longer pending (marked elsewhere, cancelled, leave approved …) is resolved.
      var live = new Set(list.map(function (p) { return p.key; }));
      var stale = BENotify.rows().filter(function (n) { return n.type === 'attendance_pending' && !n.resolved_at && !live.has(n.dedupe_key); }).map(function (n) { return n.dedupe_key; });
      if (stale.length) await BENotify.resolve(stale);
      mirrorBell(list);
      // Show unless every pending row is snoozed (server time).
      var rows = {}; BENotify.rows().forEach(function (n) { rows[n.dedupe_key] = n; });
      var visible = list.filter(function (p) { var n = rows[p.key]; return !n || !n.snooze_until || new Date(n.snooze_until).getTime() <= now.getTime(); });
      if (S.ov) { if (!list.length) closePopup(); else renderPopup(list, now); }
      else if (visible.length) openPopup(list, now);
    } catch (e) { console.warn('[BEAttRemind]', e); }
    finally { S.busy = false; if (S.again) { S.again = false; setTimeout(check, 400); } }
  }

  // Academic bell mirror (the portal's existing notification list).
  function mirrorBell(list) {
    try {
      if (typeof window._acadSyncAttNotifs === 'function') window._acadSyncAttNotifs(list.map(function (p) { return { key: p.key, text: 'Attendance pending for ' + p.title + ' (' + fmt(p.start) + ' – ' + fmt(p.end) + ')' }; }));
    } catch (_) {}
  }

  // ── popup ───────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('bear-css')) return;
    var st = document.createElement('style'); st.id = 'bear-css';
    st.textContent = [
      '.bear-ov{position:fixed;inset:0;z-index:9600;display:grid;place-items:center;padding:16px;background:rgba(var(--scrim, 3,5,9), calc(0.62 * var(--scrim-k, 1)));backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);animation:bearF .18s ease}',
      '@keyframes bearF{from{opacity:0}to{opacity:1}}@keyframes bearU{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}',
      '.bear-c{width:min(460px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;border-radius:20px;background:linear-gradient(170deg,var(--sf-2, #1a1410),var(--sf-1, #0d0f18) 46%);border:1px solid rgba(251,146,60,.35);box-shadow:0 30px 80px -20px rgba(var(--shade, 0,0,0), calc(0.9 * var(--shade-k, 1)));color:var(--tx-1, #e5e7eb);font-family:inherit;overflow:hidden;animation:bearU .22s ease}',
      '.bear-h{display:flex;gap:14px;align-items:flex-start;padding:20px 20px 6px}',
      '.bear-ic{width:46px;height:46px;flex-shrink:0;border-radius:14px;display:grid;place-items:center;color:var(--fg-orange, #fb923c);background:rgba(251,146,60,.14);border:1px solid rgba(251,146,60,.3)}',
      '.bear-h small{display:block;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-orange, #fb923c)}',
      '.bear-h h3{margin:3px 0 0;font-size:19px;line-height:1.25;color:var(--tx-0, #fff);text-wrap:balance}',
      '.bear-b{padding:8px 20px 4px;overflow-y:auto;font-size:13.5px;color:var(--tx-3, #a5adcf);line-height:1.55}',
      '.bear-one{margin-top:10px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;padding:14px;border-radius:14px;background:rgba(var(--ink, 255,255,255), 0.035);border:1px solid rgba(var(--ink, 255,255,255), 0.07)}',
      '.bear-one span{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--tx-6, #6b7394);padding-top:2px}.bear-one b{color:var(--tx-0, #fff);font-size:14px;font-weight:700;overflow-wrap:anywhere}',
      '.bear-l{display:flex;flex-direction:column;gap:6px;margin-top:10px}',
      '.bear-r{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:13px;background:rgba(var(--ink, 255,255,255), 0.035);border:1px solid rgba(var(--ink, 255,255,255), 0.07)}',
      '.bear-r.first{border-color:rgba(251,146,60,.4);background:rgba(251,146,60,.07)}',
      '.bear-r div{flex:1;min-width:0}.bear-r b{display:block;color:var(--tx-0, #fff);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bear-r em{display:block;font-style:normal;font-size:12px;color:var(--tx-4, #8b93b8)}',
      '.bear-r button{flex-shrink:0;min-height:36px;padding:0 12px;border-radius:10px;border:1px solid rgba(251,146,60,.45);background:rgba(251,146,60,.1);color:var(--fg-orange, #fdba74);font:inherit;font-size:12px;font-weight:800;cursor:pointer}',
      '.bear-f{display:flex;gap:10px;padding:16px 20px 20px;flex-wrap:wrap}',
      '.bear-f button{flex:1 1 160px;min-height:46px;border-radius:12px;font:inherit;font-size:14px;font-weight:800;cursor:pointer}',
      '.bear-f .pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f 55%,#ff0552);box-shadow:0 10px 24px -10px rgba(249,24,47,.7)}',
      '.bear-f .sec{border:1px solid rgba(var(--ink, 255,255,255), 0.14);background:rgba(var(--ink, 255,255,255), 0.04);color:var(--tx-1, #e5e7eb)}',
      '.bear-c button:focus-visible{outline:2px solid #ff6b06;outline-offset:2px}',
      '.bear-ok{position:fixed;left:50%;top:22px;z-index:9650;transform:translate(-50%,-14px);opacity:0;display:flex;gap:12px;align-items:center;width:min(380px,calc(100vw - 24px));padding:14px 16px;border-radius:16px;background:linear-gradient(160deg,var(--sf-2, #10231b),var(--sf-1, #0c1018));border:1px solid rgba(52,211,153,.45);box-shadow:0 22px 50px -16px rgba(var(--shade, 0,0,0), calc(0.85 * var(--shade-k, 1)));color:var(--tx-1, #e5e7eb);font-family:inherit;transition:transform .25s ease,opacity .25s ease}',
      '.bear-ok.on{transform:translate(-50%,0);opacity:1}',
      '.bear-ok svg{flex-shrink:0}.bear-ok svg circle{stroke-dasharray:100;stroke-dashoffset:100;animation:bearD .5s ease forwards}.bear-ok svg path{stroke-dasharray:22;stroke-dashoffset:22;animation:bearD .3s .4s ease forwards}',
      '@keyframes bearD{to{stroke-dashoffset:0}}',
      '.bear-ok b{display:block;font-size:14.5px;color:var(--tx-0, #fff)}.bear-ok span{display:block;font-size:12.5px;color:var(--tx-3, #a5d8c2);line-height:1.45;margin-top:1px}',
      '.bear-ok i{display:block;font-style:normal;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--fg-orange, #ff8a3d);margin-top:5px}',
      '@media(max-width:480px){.bear-ov{place-items:end center;padding:10px}.bear-c{border-radius:20px 20px 16px 16px;max-height:calc(100vh - 20px)}.bear-h{padding:18px 16px 4px}.bear-b{padding:8px 16px 4px}.bear-f{padding:14px 16px 16px}.bear-f button{flex-basis:100%}}',
      '@media (prefers-reduced-motion:reduce){.bear-ov,.bear-c{animation:none}.bear-ok{transition:none}.bear-ok svg circle,.bear-ok svg path{animation:none;stroke-dashoffset:0}}'
    ].join('\n');
    document.head.appendChild(st);
  }
  var WARN = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';

  function renderPopup(list, now) {
    var today = istDay(now || new Date()), one = list.length === 1, p0 = list[0];
    S.ov.querySelector('.bear-c').innerHTML =
      '<div class="bear-h"><span class="bear-ic">' + WARN + '</span><div><small>Attendance pending</small><h3 id="bear-t">'
        + (one ? 'You haven’t marked attendance for this class' : list.length + ' attendance records pending') + '</h3></div></div>'
      + '<div class="bear-b">' + (one
        ? '<div class="bear-one"><span>Class</span><b>' + esc(p0.title) + '</b><span>Time</span><b>' + esc(dayLabel(p0.date, today) + ' · ' + fmt(p0.start) + ' – ' + fmt(p0.end)) + (p0.postponed ? ' (rescheduled)' : '') + '</b></div><p style="margin:12px 2px 0">Attendance was due after this class.</p>'
        : '<p style="margin:0 2px">Attendance was due after these classes. Oldest first:</p><div class="bear-l">' + list.map(function (p, i) {
            return '<div class="bear-r' + (i ? '' : ' first') + '"><div><b>' + esc(p.title) + '</b><em>' + esc(dayLabel(p.date, today) + ' · ' + fmt(p.start) + ' – ' + fmt(p.end)) + '</em></div><button type="button" data-open="' + i + '">Mark now</button></div>';
          }).join('') + '</div>')
      + '</div><div class="bear-f"><button type="button" class="pri" data-open="0">Mark Attendance Now</button><button type="button" class="sec" data-later>Remind Me Later</button></div>';
  }
  function openPopup(list, now) {
    css();
    S.ov = document.createElement('div'); S.ov.className = 'bear-ov';
    S.ov.innerHTML = '<div class="bear-c" role="alertdialog" aria-modal="true" aria-labelledby="bear-t"></div>';
    document.body.appendChild(S.ov);
    renderPopup(list, now);
    S.ov.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-later')) return later();
      if (b.hasAttribute('data-open')) { var p = S.pending[+b.getAttribute('data-open')]; closePopup(); if (p) openClass(p); }
    });
    S.onKey = function (e) { if (e.key === 'Escape') later(); };
    document.addEventListener('keydown', S.onKey);
    var f = S.ov.querySelector('.pri'); if (f) f.focus();
  }
  function closePopup() {
    if (!S.ov) return;
    S.ov.remove(); S.ov = null;
    document.removeEventListener('keydown', S.onKey);
  }
  // "Hide for now": snooze every class shown (server time + 5 min). Never a permanent dismiss.
  async function later() {
    var keys = S.pending.map(function (p) { return p.key; });
    closePopup();
    try { await BENotify.snooze(keys, SNOOZE_MIN); } catch (_) {}
  }

  // Deep link: the exact attendance screen for that class + date.
  async function openClass(p) {
    try {
      if (p.kind === 'oto') {
        if (typeof openOTOSessions !== 'function') return;
        await openOTOSessions(p.batchId);
        if (typeof _otoOpenRecord === 'function') await _otoOpenRecord(p.studentId, p.sessionNum);
        return;
      }
      if (!window._liveBatches && typeof loadLive === 'function') await loadLive();
      var arr = window._liveBatches || [], i = arr.findIndex(function (b) { return (b.raw || b.name) === p.batchName; });
      if (i < 0 && typeof loadLive === 'function') { await loadLive(); arr = window._liveBatches || []; i = arr.findIndex(function (b) { return (b.raw || b.name) === p.batchName; }); }
      if (i < 0) { if (typeof showToast === 'function') showToast('error', 'Could not open ' + p.batchName + ' — open it from My Batches & Attendance.'); return; }
      await openAtt(i);
      var d = document.getElementById('att_date');
      if (d && d.value !== p.date) { d.value = p.date; d.dispatchEvent(new Event('change')); }
    } catch (e) { console.warn('[BEAttRemind] open', e); }
  }

  // ── success / thank-you ──────────────────────────────────────────────────
  function thank(title) {
    css();
    var el = document.createElement('div'); el.className = 'bear-ok'; el.setAttribute('role', 'status');
    el.innerHTML = '<svg width="34" height="34" viewBox="0 0 36 36" fill="none" stroke="var(--fg-emerald, #34d399)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="15" transform="rotate(-90 18 18)"/><path d="m11.5 18.5 4.5 4.5 8.5-9"/></svg>'
      + '<div><b>Attendance marked</b><span>Thank you for marking the attendance for ' + esc(title) + ' — your class records are up to date.</span><i>Broken English</i></div>';
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    setTimeout(function () { el.classList.remove('on'); setTimeout(function () { el.remove(); }, 300); }, 4200);
  }
  // Called by saveAtt() / saveOTOSession() AFTER the database write succeeded.
  //   { kind:'class', batchId, title, date } · { kind:'oto', otoId, title }
  async function completed(o) {
    o = o || {};
    var key = o.kind === 'oto' ? (o.otoId ? 'att:oto:' + o.otoId : '') : (o.batchId && o.date ? 'att:class:' + o.batchId + ':' + o.date : '');
    thank(o.title || 'this class');
    if (!window.BENotify || !key) return;
    try {
      var had = BENotify.rows().some(function (n) { return n.dedupe_key === key && !n.resolved_at; });
      await BENotify.resolve([key]);
      // History entry (already read) — one per class, never duplicated.
      await BENotify.upsert({ type: 'attendance_completed', title: 'Attendance marked for ' + (o.title || 'class'), message: had ? 'Marked after the reminder.' : 'Marked on time — thank you.',
        entity_type: o.kind === 'oto' ? 'oto_session' : 'class_occurrence', entity_id: key.replace(/^att:(class|oto):/, ''), dedupe_key: key.replace(/^att:/, 'att_done:'),
        link: key, read_at: new Date().toISOString(), resolved_at: new Date().toISOString(), recipient_employee_id: window._mediaEmployeeId || null, metadata: { date: o.date || null } });
      S.pending = S.pending.filter(function (p) { return p.key !== key; });
      if (S.ov) { if (S.pending.length) renderPopup(S.pending); else closePopup(); }
    } catch (e) { console.warn('[BEAttRemind] resolve', e); }
    setTimeout(check, 1500);
  }

  window.BEAttRemind = {
    // email = the trainer's portal login (recipient). Safe to call more than once.
    start: async function (email) {
      if (S.started || !email || !window.BENotify || !db()) return;
      var tr = await resolveTrainer(); if (!tr) return;          // not a trainer → nothing to remind
      S.started = true;
      BENotify.init({ db: db(), email: email, toastTypes: [] });
      if (window.BELive) BELive.on('acad-att-remind', ['attendance', 'oto_sessions', 'academic_live_classes', 'class_postponements', 'hr_leave_requests'], function () { check(); }, { debounce: 2500 });
      // Snooze / resolve on another device → re-evaluate here.
      BENotify.on('change', function () { if (S.ov && !BENotify.rows().some(function (n) { return n.type === 'attendance_pending' && !n.resolved_at; })) closePopup(); });
      clearInterval(S.timer); S.timer = setInterval(check, 60000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
      window.addEventListener('focus', function () { check(); });
      check();
    },
    check: check, completed: completed,
    show: function () { if (S.pending.length && !S.ov) { BENotify.serverNow().then(function (n) { openPopup(S.pending, n); }); } else if (!S.pending.length && typeof showToast === 'function') showToast('success', 'No attendance pending.'); },
    pending: function () { return S.pending.slice(); },
    _compute: computePending   // tests
  };
})();
