/* ════════════════════════════════════════════════════════════════════════════
   TrainerAvailability — ONE rule for "is this trainer expected to teach this class?"

   Approved HR leave is an AVAILABILITY OVERRIDE, never a schedule change: the batch, its
   recurrence and every attendance row stay untouched; a covered occurrence is only suppressed
   from active views / counts / reminders / Meet creation while the leave stays approved.
   Cancel or edit the leave in HR → the next load recalculates. Nothing is regenerated.

   Source of truth   hr_leave_requests, status = 'approved' ONLY (pending / rejected /
                     cancelled never suppress). Work From Home is not leave (trainer works).
   Overlap           leave_start < class_end AND leave_end > class_start, Asia/Kolkata wall time.
                     Full day      → 00:00–24:00 on every date start_date..end_date
                     Morning half  → 00:00–HALF_SPLIT     (half_day_type 'morning' / 'HD-M')
                     Afternoon half→ HALF_SPLIT–24:00     (half_day_type 'afternoon' / 'HD-A')
                     HALF_SPLIT = 13:00 (the split the attendance reminder already used;
                     the server copy _shared/trainer-availability.ts uses the same value).
   History           callers must keep an occurrence whose attendance is already saved —
                     see TrainerAvailability.suppress(): marked classes are never hidden.
   Performance       load() fetches every relevant leave row in ONE query for the date range
                     (optionally narrowed to a set of employees) — never one query per class.

   API
     TrainerAvailability.load(db, { from, to, trainers?, employeeIds? }) → Promise<Index>
     TrainerAvailability.index(leaveRows, trainers?)                     → Index   (pure)
     Index.leaveFor(trainer, dateISO, startMin, endMin)  → leave row | null
     Index.isAvailable(trainer, dateISO, startMin, endMin) → boolean
     Index.suppress(trainer, dateISO, startMin, endMin, alreadyMarked) → leave row | null
       trainer = trainers row ({ id, hr_employee_id }), a trainer id, or { hr_employee_id }
     window.isTrainerAvailable(trainerId, classStart, classEnd)
       sugar over the most recently loaded index; classStart / classEnd are Dates or
       'YYYY-MM-DDTHH:MM' Asia/Kolkata strings.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.TrainerAvailability) return;
  var TZ = 'Asia/Kolkata', DAY = 1440;

  function toMin(t) { var m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  // Kept identical to the server copy (supabase/functions/_shared/trainer-availability.ts).
  function halfSplit() { return 13 * 60; }
  function isWfh(l) { return /work\s*from\s*home|\bwfh\b/i.test(String(l && l.leave_type || '')); }
  function isMorning(l) { return /^(morning|hd-m)$/i.test(String(l.half_day_type || '')); }
  function isAfternoon(l) { return /^(afternoon|hd-a)$/i.test(String(l.half_day_type || '')); }

  /** Minutes [start, end) of the day `dateISO` covered by leave row `l`, or null. */
  function windowOf(l, dateISO) {
    var s = String(l.start_date || '').slice(0, 10), e = String(l.end_date || l.start_date || '').slice(0, 10);
    if (!s || dateISO < s || dateISO > e) return null;
    if (isMorning(l)) return [0, halfSplit()];
    if (isAfternoon(l)) return [halfSplit(), DAY];
    return [0, DAY];
  }

  function istParts(v) {
    if (v == null) return null;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
      return { date: v.slice(0, 10), min: v.length > 10 ? toMin(v.slice(11)) : null };
    }
    var d = v instanceof Date ? v : new Date(v);
    if (isNaN(d)) return null;
    var date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
    var hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).split(':').map(Number);
    return { date: date, min: (hm[0] % 24) * 60 + hm[1] };
  }

  function index(rows, trainers) {
    var byEmp = {}, empOfTrainer = {};
    (trainers || []).forEach(function (t) { if (t && t.id != null && t.hr_employee_id) empOfTrainer[String(t.id)] = String(t.hr_employee_id); });
    (rows || []).forEach(function (l) {
      if (!l || String(l.status || 'approved').toLowerCase() !== 'approved' || isWfh(l) || !l.employee_id) return;
      (byEmp[String(l.employee_id)] = byEmp[String(l.employee_id)] || []).push(l);
    });
    function empOf(tr) {
      if (tr == null) return null;
      if (typeof tr === 'object') return tr.hr_employee_id ? String(tr.hr_employee_id) : (tr.id != null ? empOfTrainer[String(tr.id)] || null : null);
      return empOfTrainer[String(tr)] || null;
    }
    function leaveFor(tr, dateISO, startMin, endMin) {
      var list = byEmp[empOf(tr)];
      if (!list || !dateISO) return null;
      // Unknown class time → the class is treated as spanning the whole day.
      var cs = startMin == null || isNaN(startMin) ? 0 : +startMin;
      var ce = endMin == null || isNaN(endMin) || +endMin <= cs ? (startMin == null ? DAY : cs + 1) : +endMin;
      for (var i = 0; i < list.length; i++) {
        var w = windowOf(list[i], dateISO);
        if (w && w[0] < ce && w[1] > cs) return list[i];
      }
      return null;
    }
    return {
      rows: rows || [],
      leaveFor: leaveFor,
      isAvailable: function (tr, d, s, e) { return !leaveFor(tr, d, s, e); },
      /** Leave row that suppresses this occurrence, or null. An occurrence whose attendance is
          already saved is history and is never suppressed. */
      suppress: function (tr, d, s, e, alreadyMarked) { return alreadyMarked ? null : leaveFor(tr, d, s, e); },
      employeeOf: empOf
    };
  }

  var last = index([], []);

  async function load(db, opt) {
    opt = opt || {};
    var from = String(opt.from || '').slice(0, 10), to = String(opt.to || opt.from || '').slice(0, 10);
    var trainers = opt.trainers;
    if (!trainers) {
      var tr = await db.from('trainers').select('id,hr_employee_id');
      trainers = (tr && tr.data) || [];
    }
    var emp = opt.employeeIds || null;
    if (!emp && opt.trainers) emp = trainers.map(function (t) { return t && t.hr_employee_id; }).filter(Boolean);
    if (emp) emp = Array.from(new Set(emp.map(String)));
    var rows = [];
    if (!emp || emp.length) {
      var q = db.from('hr_leave_requests').select('id,employee_id,leave_type,start_date,end_date,half_day_type,status').eq('status', 'approved');
      if (to) q = q.lte('start_date', to);
      if (from) q = q.gte('end_date', from);
      if (emp) q = q.in('employee_id', emp);
      try { var r = await q; if (r && !r.error) rows = r.data || []; } catch (_) { rows = []; }
    }
    last = index(rows, trainers);
    return last;
  }

  window.TrainerAvailability = { load: load, index: index, windowOf: windowOf, halfSplit: halfSplit, current: function () { return last; } };
  window.isTrainerAvailable = function (trainerId, classStart, classEnd) {
    var a = istParts(classStart), b = istParts(classEnd);
    if (!a) return true;
    var end = b && b.date === a.date ? b.min : (b ? DAY : null);
    return last.isAvailable(trainerId, a.date, a.min, end);
  };
})();
