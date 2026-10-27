/* ============================================================================
   SessionNumber — which session of its batch a class is ("Session No.: 07").
   Server copy: supabase/functions/_shared/session-number.ts (same rule, kept in step).

   Group / 1:1 batch classes reuse the ERP's own numbering — attendance.session_num, which the
   DB trigger fn_renumber_attendance (20260924) keeps in class-date order:
     • class already marked          → its stored attendance.session_num
     • class not marked yet          → sessions done before it (legacy undated present sessions
                                       + present class days before it) + every still-to-come
                                       class of the SAME batch between today and it + 1
       "still-to-come" = the batch's scheduled occurrences (holidays, postponements applied)
       minus cancelled classes and classes suppressed by approved trainer leave — so a cancel,
       postpone or leave renumbers the classes after it.
   Group 1:1 sessions (oto_sessions) carry their own stored session_number.
   Never a company-wide count; nothing is written.

   SessionNumber.compute({ date, attendance, upcoming, today }) → number
     attendance = this batch's attendance rows {session_date, session_num, status}
     upcoming   = this batch's active scheduled class dates (any order; only today..date used)
   SessionNumber.label(n) → "07" ('' when unknown)
   ============================================================================ */
(function () {
  'use strict';
  var day = function (v) { return v == null ? '' : String(v).slice(0, 10); };

  function compute(opt) {
    var date = day(opt && opt.date), today = day(opt && opt.today), rows = (opt && opt.attendance) || [];
    if (!date) return null;
    var marked = {}, undated = {}, doneBefore = {}, onDay = null;
    rows.forEach(function (r) {
      if (!r) return;
      var d = day(r.session_date), present = !r.status || r.status === 'present';
      if (!d) { if (present && r.session_num != null) undated[+r.session_num] = 1; return; }
      marked[d] = 1;
      if (d === date && r.session_num != null) onDay = Math.max(onDay || 0, +r.session_num);
      if (present && d < date) doneBefore[d] = 1;
    });
    if (onDay) return onDay;
    var pending = {};
    (opt.upcoming || []).forEach(function (u) { u = day(u); if (u && u >= today && u < date && !marked[u]) pending[u] = 1; });
    return Object.keys(undated).length + Object.keys(doneBefore).length + Object.keys(pending).length + 1;
  }

  function label(n) { n = +n; return n > 0 ? (n < 10 ? '0' + n : String(n)) : ''; }

  window.SessionNumber = { compute: compute, label: label };
})();
