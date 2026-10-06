/**
 * Session credit — ONE rule for how much a taught session counts, used by every Academic,
 * HR and payroll total (Class & Attendance, trainer reports, PDFs, part-time trainer pay).
 *
 *   Group class (any length)                       → 1 session
 *   Standalone 1:1 class (a capacity-1 batch)      → 1 session
 *   1:1 session belonging to a GROUP batch         → duration ÷ 60 (30 min → 0.5), max 1
 *     = an oto_sessions row whose batch is a group batch (capacity ≠ 1). These are the
 *       included one-on-one sessions of a group course; their duration comes from the
 *       row's start/end time, else duration_minutes, else the 30-minute standard.
 *
 * Teaching hours are always real minutes ÷ 60 (30 min → 0.5 h), never "1 per session".
 * The attendance / 1:1 record itself is untouched — only its weight in totals changes.
 *
 *   getSessionCredit(session) / SessionCredit.credit(session)
 *     session: { kind: 'class' | 'oto', batch?: { capacity }, minutes?, start_time?, end_time?, duration_minutes? }
 *   SessionCredit.otoMinutes(row)   real minutes of a 1:1 row
 *   SessionCredit.isGroupLinked(row, batch)
 *   SessionCredit.fmt(n)            1 → "1", 0.5 → "0.5", 25.5 → "25.5"
 *   SessionCredit.typeLabel(session) "Group" | "1:1" | "Group 1:1"
 * Namespace: window.SessionCredit (+ window.getSessionCredit)
 */
(function () {
  'use strict';
  if (window.SessionCredit) return;
  var GROUP_OTO_DEFAULT_MIN = 30;

  function toMin(t) {
    var m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function otoMinutes(row) {
    row = row || {};
    var s = toMin(row.start_time), e = toMin(row.end_time);
    if (s != null && e != null) { var d = e - s; if (d < 0) d += 1440; if (d > 0 && d <= 240) return d; }
    var dm = Number(row.duration_minutes || row.minutes);
    return dm > 0 ? dm : GROUP_OTO_DEFAULT_MIN;
  }
  // oto_sessions only exist for group courses; a capacity-1 batch is a standalone 1:1.
  function isGroupLinked(row, batch) {
    var b = batch || (row && row.batch) || null;
    if (b && Number(b.capacity) === 1) return false;
    return true;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function credit(s) {
    s = s || {};
    if (s.kind === 'oto' && isGroupLinked(s, s.batch)) {
      var min = s.minutes > 0 ? s.minutes : otoMinutes(s);
      return Math.min(1, round2(min / 60));
    }
    return 1;
  }
  function typeLabel(s) {
    s = s || {};
    if (s.kind === 'oto') return isGroupLinked(s, s.batch) ? 'Group 1:1' : '1:1';
    return s.batch && Number(s.batch.capacity) === 1 ? '1:1' : 'Group';
  }
  function fmt(n) { n = round2(Number(n) || 0); return String(n); }

  window.SessionCredit = { credit: credit, otoMinutes: otoMinutes, isGroupLinked: isGroupLinked, typeLabel: typeLabel, fmt: fmt, GROUP_OTO_DEFAULT_MIN: GROUP_OTO_DEFAULT_MIN };
  window.getSessionCredit = credit;
})();
