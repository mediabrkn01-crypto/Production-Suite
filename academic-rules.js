/**
 * Academic rules — ONE definition, shared by every Academic view, for:
 *
 *   • the ERP calendar day (Asia/Kolkata), so a class date never shifts at a UTC boundary;
 *   • whether a saved attendance row is real evidence of a class on its session_date.
 *
 * Attendance date rule
 *   A class can only be marked on or after the day it happened. A row whose session_date is
 *   LATER than the day it was saved (created_at, in ERP time) describes a class that had not
 *   happened yet — a future date picked by mistake, or a legacy import whose day/month were
 *   swapped (e.g. 05/10 stored as 2026-10-05). Such rows are NOT counted as classes of that
 *   month: they are listed as "needs review" instead, and nothing is deleted or rewritten.
 *   Example: a batch completed on 4 Sep with a row dated 6 Oct saved on 24 Aug must not show
 *   as an October class for its trainer.
 *
 *   AcademicRules.ERP_TZ                     'Asia/Kolkata'
 *   AcademicRules.erpDate(tsOrDate)          'YYYY-MM-DD' in ERP time ('' when invalid)
 *   AcademicRules.todayISO()                 today in ERP time
 *   AcademicRules.isFutureClassDate(iso)     true when iso is after today (cannot be marked yet)
 *   AcademicRules.attendanceDateIssue(row)   null | { code:'recorded_before_class', recorded }
 *   AcademicRules.splitAttendance(rows)      { valid:[...], invalid:[{row, issue}] }
 * Namespace: window.AcademicRules
 */
(function () {
  'use strict';
  if (window.AcademicRules) return;
  var ERP_TZ = 'Asia/Kolkata';
  var fmt = null;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ERP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (e) { fmt = null; }

  function erpDate(v) {
    if (v == null || v === '') return '';
    var d = v instanceof Date ? v : new Date(v);
    if (isNaN(d)) return '';
    if (fmt) {
      var p = {}; fmt.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
      return p.year + '-' + p.month + '-' + p.day;
    }
    var ist = new Date(d.getTime() + 330 * 60000); // fallback: fixed +05:30
    return ist.toISOString().slice(0, 10);
  }
  function todayISO() { return erpDate(new Date()); }
  function isFutureClassDate(iso) { return !!iso && String(iso).slice(0, 10) > todayISO(); }

  function attendanceDateIssue(row) {
    if (!row || !row.session_date || !row.created_at) return null;
    var rec = erpDate(row.created_at);
    if (rec && String(row.session_date).slice(0, 10) > rec) return { code: 'recorded_before_class', recorded: rec };
    return null;
  }
  function splitAttendance(rows) {
    var valid = [], invalid = [];
    (rows || []).forEach(function (r) {
      var is = attendanceDateIssue(r);
      if (is) invalid.push({ row: r, issue: is }); else valid.push(r);
    });
    return { valid: valid, invalid: invalid };
  }

  window.AcademicRules = { ERP_TZ: ERP_TZ, erpDate: erpDate, todayISO: todayISO, isFutureClassDate: isFutureClassDate, attendanceDateIssue: attendanceDateIssue, splitAttendance: splitAttendance };
})();
