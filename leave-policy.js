/* ============================================================================
 * leave-policy.js — ONE shared Leave Policy engine (company Leave Policy v2).
 *
 * Source of truth = "Leave Policy new.pdf". Every module (HR dashboard, attendance
 * report, employee leave page, payroll, Sales approvals) MUST consume THESE resolvers
 * so one screen can never show Paid Leave while another shows LOP.
 *
 * Design: the resolvers are PURE functions over a plain `ctx` data bundle (employee +
 * requests + attendance + holidays + settings + CL buckets + SL ledger). DB reads/writes
 * live in the thin async helpers at the bottom (LeavePolicy.buildContext / .db.*). Pure
 * core = same result everywhere, unit-testable, no rule duplicated across HTML files.
 *
 * Loaded by hr.html, index.html, sales.html (plain <script>, exposes window.LeavePolicy).
 * ==========================================================================*/
(function (global) {
  'use strict';

  // ---- Policy constants (the new PDF, nothing from the old system) ----------
  var P = {
    WORK_START: '09:00',        // §7 official working hours
    WORK_END:   '17:30',        // 5:30 PM
    SL_PER_MONTH: 1,            // §2.1 1 Sick Leave/month, no carry-forward
    CL_PER_CYCLE: 6,            // §2.2 6 Casual Leave every 6 months
    CL_CYCLE_MONTHS: 6,
    CL_CARRY_MONTHS: 3,         // carry forward max 3 months …
    CL_VALIDITY_MONTHS: 9,      // … used within 9 months of credit date
    MAX_CONSECUTIVE: 2,         // §2.2 max 2 consecutive leave days
    PROBATION_MONTHS: 3,        // §6 first 3 months
    INCIDENT_HALFDAY_AT: 2,     // §7 2 late/early instances → half-day deduction
    INCIDENT_FULLDAY_AT: 4      // §7 4+ instances → full-day deduction
  };

  // Canonical resolved attendance codes (§18). Keep existing valid codes.
  var CODES = { P:'P', L:'L', WFH:'WFH', SL:'SL', CL:'CL', ML:'ML', LOP:'LOP', WO:'WO', H:'H', OE:'OE' };

  // Leave-type normalisation — the PDF defines only Sick Leave + Casual Leave as paid
  // entitlements. Exceptional WFH is an attendance mode, not a paid balance. Everything
  // else that still exists in old data is treated as unpaid unless it maps here.
  function normType(t) {
    t = (t || '').toLowerCase();
    if (t.indexOf('sick') >= 0) return 'SL';
    if (t.indexOf('casual') >= 0) return 'CL';
    if (t.indexOf('maternity') >= 0) return 'ML';
    if (t.indexOf('home') >= 0 || t === 'wfh' || t.indexOf('wfh') >= 0) return 'WFH';
    return 'OTHER';
  }

  // ---- small date utils (all dates are 'YYYY-MM-DD' strings, tz-agnostic) ---
  function ymd(d) {
    if (typeof d === 'string') return d.slice(0, 10);
    var z = new Date(d); return z.getFullYear() + '-' + String(z.getMonth() + 1).padStart(2, '0') + '-' + String(z.getDate()).padStart(2, '0');
  }
  function addMonths(dateStr, n) {
    var p = dateStr.slice(0, 10).split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]); d.setMonth(d.getMonth() + n);
    return ymd(d);
  }
  function daysBetween(a, b) { // whole days b - a
    return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  }
  function eachDate(startStr, endStr, fn) {
    var p = startStr.slice(0, 10).split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    var end = endStr.slice(0, 10);
    for (var i = 0; i < 3660 && ymd(d) <= end; i++) { fn(ymd(d), d.getDay()); d.setDate(d.getDate() + 1); }
  }
  function monthPeriod(dateStr) { return dateStr.slice(0, 7); } // YYYY-MM
  function monthEnd(period) { var p = period.split('-').map(Number); return ymd(new Date(p[0], p[1], 0)); }
  // Calendar half-year cycle label + credit/expiry for a given date (CL anchor).
  function clCycleFor(dateStr) {
    var p = dateStr.slice(0, 7).split('-').map(Number), y = p[0], m = p[1];
    var half = m <= 6 ? 1 : 2;
    var credit = y + '-' + (half === 1 ? '01' : '07') + '-01';
    return { label: y + '-H' + half, credit_date: credit, expiry_date: addMonths(credit, P.CL_VALIDITY_MONTHS) };
  }
  // Extract local HH:MM from a timestamptz/ISO string.
  function hhmm(ts) {
    if (!ts) return null; var d = new Date(ts); if (isNaN(d)) return null;
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function timeGt(a, b) { return a > b; } // 'HH:MM' lexicographic works
  function addMin(hhmmStr, mins) {
    if (!hhmmStr) return hhmmStr; mins = mins || 0;
    var p = hhmmStr.split(':').map(Number), t = p[0] * 60 + p[1] + mins;
    if (t < 0) t = 0; if (t > 1439) t = 1439;
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }

  // getEmployeeWorkSchedule(employee, date): the ONE resolver for a person's expected hours.
  // Overrides the global 9:00-5:30. Flexible / unconfigured employees have hasExpected=false →
  // they are NEVER auto-marked Late/Early. Only Fixed/Custom/Class with an explicit start time
  // get late/early evaluation. (date reserved for future per-day shift overrides.)
  function getEmployeeWorkSchedule(emp, dateStr) {
    var type = (emp && emp.work_schedule_type) || 'flexible';
    var start = emp && emp.expected_start_time ? String(emp.expected_start_time).slice(0, 5) : null;
    var end = emp && emp.expected_end_time ? String(emp.expected_end_time).slice(0, 5) : null;
    var grace = emp && emp.grace_minutes != null ? Number(emp.grace_minutes) : 0;
    var days = (emp && emp.work_days) ? String(emp.work_days).split(',').map(function (s) { return Number(s.trim()); }).filter(function (n) { return !isNaN(n); }) : null;
    var configured = (type === 'fixed' || type === 'custom' || type === 'class');
    return { type: type, start: start, end: end, graceMin: grace || 0, workDays: days, hasExpected: !!(configured && start) };
  }

  // =========================================================================
  // 1. getEmployeePolicyState(employee, date)
  // =========================================================================
  function getEmployeePolicyState(employee, dateStr) {
    dateStr = ymd(dateStr || new Date());
    var joining = employee && employee.joining_date ? employee.joining_date.slice(0, 10) : null;
    var probMonths = employee && employee.probation_months != null ? Number(employee.probation_months) : P.PROBATION_MONTHS;
    var probationEnd = joining ? addMonths(joining, probMonths) : null; // exclusive
    var onProbation = !!(joining && probationEnd && dateStr >= joining && dateStr < probationEnd);

    var noticeActive = !!(employee && employee.notice_active);
    var nStart = employee && employee.notice_start ? employee.notice_start.slice(0, 10) : null;
    var nEnd = employee && employee.notice_end ? employee.notice_end.slice(0, 10) : null;
    var onNotice = noticeActive && (!nStart || dateStr >= nStart) && (!nEnd || dateStr <= nEnd);

    return {
      date: dateStr,
      joiningDate: joining,
      probationMonths: probMonths,
      probationStart: joining,
      probationEnd: probationEnd,          // = expected confirmation date
      confirmationDate: probationEnd,
      onProbation: onProbation,
      onNotice: onNotice,
      noticeStart: nStart,
      noticeEnd: nEnd,
      // §6 no paid leave / §10 none during notice
      paidLeaveEligible: !onProbation && !onNotice,
      // §6 weekly offs N/A in probation, §10 none in notice (WFH suppression handled per-day)
      weeklyOffEligible: !onProbation && !onNotice
    };
  }

  // =========================================================================
  // calendar helpers over ctx
  // =========================================================================
  function isHoliday(ctx, dateStr) {
    return (ctx.holidays || []).some(function (h) { return (h.holiday_date || '').slice(0, 10) === dateStr; });
  }
  function officialEventFor(ctx, dateStr) {
    return (ctx.officialEvents || []).find(function (e) {
      var d = (e.event_date || e.date || '').slice(0, 10);
      return d === dateStr;
    }) || null;
  }
  function isWeeklyOff(ctx, dow) {
    var s = ctx.settings || {};
    if (dow === 0 && s.weekly_off_sunday !== false) return true;  // Sunday default on
    if (dow === 6 && s.weekly_off_saturday === true) return true; // Saturday only if enabled
    return false;
  }
  // Approved leave/WFH request covering a date (any that reached final approved OR whose
  // both stages approved). Returns the request row or null.
  function approvedRequestFor(ctx, dateStr) {
    return (ctx.requests || []).find(function (r) {
      if (!isApproved(r)) return false;
      var s = (r.start_date || '').slice(0, 10), e = (r.end_date || r.start_date || '').slice(0, 10);
      return s && dateStr >= s && dateStr <= e;
    }) || null;
  }
  function isApproved(r) {
    if (!r) return false;
    if (r.status === 'approved' || r.status === 'Approved' || r.status === 'Exception Approved') return true;
    // two-stage: both stages approved
    return r.manager_status === 'approved' && r.hr_status === 'approved';
  }

  // =========================================================================
  // 2. resolveLeaveBalance(ctx)  — SL (monthly) + CL (buckets)
  // =========================================================================
  function resolveLeaveBalance(ctx) {
    var dateStr = ctx.date || ymd(new Date());
    var period = monthPeriod(dateStr);

    // Sick Leave — current month only, no carry-forward.
    var slRow = (ctx.slLedger || []).find(function (r) { return r.period === period; });
    var slEnt = slRow ? Number(slRow.entitlement) : P.SL_PER_MONTH;
    var slUsed = slRow ? Number(slRow.used) : 0;
    var sick = {
      entitlement: slEnt,
      used: slUsed,
      remaining: Math.max(0, slEnt - slUsed),
      expiry: monthEnd(period),           // lapses at month end
      period: period
    };

    // Casual Leave — bucket ledger. Non-expired buckets (expiry_date > date), oldest-first.
    var buckets = (ctx.clBuckets || [])
      .map(function (b) { return { id: b.id, credit_date: (b.credit_date || '').slice(0, 10), cycle_label: b.cycle_label, original: Number(b.original_amount), remaining: Number(b.remaining_amount), expiry: (b.expiry_date || '').slice(0, 10), source: b.source }; })
      .filter(function (b) { return b.expiry >= dateStr; })
      .sort(function (a, b) { return a.credit_date < b.credit_date ? -1 : a.credit_date > b.credit_date ? 1 : 0; });
    var curCycle = clCycleFor(dateStr).label;
    var clRemaining = 0, clCarried = 0, clCurrent = 0, nextExpiry = null;
    buckets.forEach(function (b) {
      clRemaining += b.remaining;
      if (b.cycle_label === curCycle) clCurrent += b.remaining; else clCarried += b.remaining;
      if (b.remaining > 0 && (!nextExpiry || b.expiry < nextExpiry)) nextExpiry = b.expiry;
    });
    var casual = {
      currentCycle: curCycle,
      currentCredit: clCurrent,
      carriedForward: clCarried,
      remaining: clRemaining,
      nextExpiry: nextExpiry,
      buckets: buckets               // ordered oldest-first = consumption order
    };
    return { date: dateStr, sick: sick, casual: casual };
  }

  // =========================================================================
  // 3. resolveLeaveEligibility(ctx, request)
  //    Decides warnings, whether HR/mgr exception is required, and the payroll
  //    treatment (paid / lop / lop_double / exception). Non-destructive: only
  //    computes — the approval workflow persists.
  // =========================================================================
  function resolveLeaveEligibility(ctx, request) {
    var warnings = [], requiresException = false;
    var start = (request.start_date || '').slice(0, 10);
    var end = (request.end_date || request.start_date || '').slice(0, 10);
    var days = request.days != null ? Number(request.days) : (start && end ? daysBetween(start, end) + 1 : 1);
    var kind = normType(request.leave_type);
    var state = getEmployeePolicyState(ctx.employee, start);

    // WFH is not a paid balance — it's an approval-gated attendance mode (§9).
    if (kind === 'WFH') {
      if (!request.proof_url) warnings.push('Exceptional WFH normally requires a medical certificate/supporting document.');
      return {
        eligible: true, treatment: 'wfh', kind: 'WFH', days: days,
        warnings: warnings, requiresException: true, // WFH always needs mgr+HR approval
        consumeFrom: null, consecutiveDays: days
      };
    }

    // Maternity Leave — always PAID (§5). No fixed balance to exhaust, and exempt from the
    // max-consecutive-days limit (a maternity leave is a long continuous block by nature).
    // Approval workflow still applies; it simply never resolves to LOP.
    if (kind === 'ML') {
      return { eligible: true, treatment: 'paid', kind: 'ML', days: days, paidDays: days, lopDays: 0,
        warnings: warnings, requiresException: false, adjacency: detectAdjacency(ctx, start, end),
        consumeFrom: null, consecutiveDays: days };
    }

    // §6 probation / §10 notice → no paid leave, absence = LOP.
    if (state.onProbation) { warnings.push('Employee is in probation (no paid leave) — this leave resolves as LOP.'); return finalize('lop'); }
    if (state.onNotice) { warnings.push('Employee is serving notice period — CL/SL not eligible, resolves as LOP.'); return finalize('lop'); }

    // Balance availability.
    var bal = resolveLeaveBalance(Object.assign({}, ctx, { date: start }));
    var available = kind === 'SL' ? bal.sick.remaining : kind === 'CL' ? bal.casual.remaining : 0;
    var paidDays = Math.min(days, Math.max(0, available));
    var lopDays = days - paidDays;
    var consumeFrom = null;
    if (kind === 'CL') consumeFrom = planCLConsumption(bal.casual.buckets, paidDays); // oldest-first
    if (kind === 'OTHER') { warnings.push('Leave type not defined as a paid entitlement in policy — treated as LOP.'); }

    // §2.2 max 2 consecutive days.
    if (days > P.MAX_CONSECUTIVE) { warnings.push('Exceeds ' + P.MAX_CONSECUTIVE + ' consecutive leave days — requires management exception.'); requiresException = true; }

    // §4 apply ≥1 day in advance unless emergency.
    if (!request.emergency && ctx.now) {
      var lead = daysBetween(ymd(ctx.now), start);
      if (lead < 1) warnings.push('Applied less than 1 day in advance (not flagged emergency) — normally not approved.');
    }

    // §8 leave adjacent to a week-off/holiday: surface as a WARNING for HR review only — it does
    // NOT auto-convert a valid approved paid leave into LOP. An eligible SL/CL stays Paid unless
    // HR explicitly marks it unpaid. (Prevents the "valid CL wrongly became LOP-double" bug.)
    var adj = detectAdjacency(ctx, start, end);
    var treatment = lopDays > 0 && paidDays === 0 ? 'lop' : (lopDays > 0 ? 'partial_lop' : 'paid');
    if (adj.adjacent) {
      warnings.push('Note: leave is adjacent to a ' + adj.what + ' (' + adj.date + '). HR may review; it remains Paid Leave unless HR marks it unpaid.');
    }

    function finalize(t) {
      return { eligible: t !== 'lop', treatment: t, kind: kind, days: days, paidDays: 0, lopDays: days, warnings: warnings, requiresException: requiresException, adjacency: detectAdjacency(ctx, start, end), consumeFrom: null, consecutiveDays: days };
    }
    return {
      eligible: true, treatment: treatment, kind: kind, days: days,
      paidDays: paidDays, lopDays: lopDays, available: available,
      warnings: warnings, requiresException: requiresException,
      adjacency: adj, consumeFrom: consumeFrom, consecutiveDays: days
    };
  }

  // Plan CL consumption oldest-first across buckets. Returns [{bucketId, take}].
  function planCLConsumption(buckets, need) {
    var plan = [], left = need;
    for (var i = 0; i < buckets.length && left > 0; i++) {
      var take = Math.min(buckets[i].remaining, left);
      if (take > 0) { plan.push({ bucketId: buckets[i].id, take: take, cycle: buckets[i].cycle_label }); left -= take; }
    }
    return plan;
  }

  // §8 adjacency: is the day immediately before `start` or after `end` a weekly-off/holiday?
  function detectAdjacency(ctx, start, end) {
    var before = addMonths ? null : null;
    var dayBefore = ymd(new Date(Date.parse(start) - 86400000));
    var dayAfter = ymd(new Date(Date.parse(end) + 86400000));
    var checks = [
      { date: dayBefore, dow: new Date(Date.parse(dayBefore)).getDay() },
      { date: dayAfter, dow: new Date(Date.parse(dayAfter)).getDay() }
    ];
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      if (isHoliday(ctx, c.date)) return { adjacent: true, what: 'Holiday', date: c.date };
      if (isWeeklyOff(ctx, c.dow)) return { adjacent: true, what: 'Week Off', date: c.date };
    }
    return { adjacent: false };
  }

  // =========================================================================
  // 4. resolveAttendanceStatus(ctx, date) — policy-first, returns a §18 code.
  // =========================================================================
  function resolveAttendanceStatus(ctx, dateStr) {
    dateStr = ymd(dateStr);
    var emp = ctx.employee;
    var state = getEmployeePolicyState(emp, dateStr);
    var dow = new Date(Date.parse(dateStr)).getDay();
    var rec = (ctx.attendance || []).find(function (a) { return a.att_date && a.att_date.slice(0, 10) === dateStr; });
    var req = approvedRequestFor(ctx, dateStr);
    var wfhApproved = req && normType(req.leave_type) === 'WFH';

    // pre-joining / future → not evaluated
    if (state.joiningDate && dateStr < state.joiningDate) return code(CODES.LOP, 'Pre-joining', { payable: false, preJoining: true });

    // Approved WFH is an attendance MODE — WFH, never Present (§13). Weekly-off benefit is
    // suppressed during approved WFH period.
    if (wfhApproved) return code(CODES.WFH, 'Approved WFH', { payable: true, worked: true, clockIn: rec ? rec.clock_in_time : null, clockOut: rec ? rec.clock_out_time : null });

    // Holiday / weekly-off (weekly-off only if eligible — §6/§10 remove it in probation/notice).
    if (isHoliday(ctx, dateStr)) return code(CODES.H, 'Holiday', { payable: true });

    var oe = officialEventFor(ctx, dateStr);

    // Attendance row present → worked / half-day / explicit.
    if (rec) {
      if (rec.status === 'holiday') return code(CODES.H, 'Holiday', { payable: true });
      if (rec.status === 'wfh') return code(CODES.WFH, 'WFH', { payable: true, worked: true });
      if (rec.status === 'half_day') return code('HD', 'Half Day', { payable: true, half: true });
      if (rec.status === 'on_leave') {
        // §1 precedence: official-calendar days outrank ANY leave. A leave-sync writes an
        // on_leave row for EVERY date in an approved range (weekends included), so without
        // this a Weekly Off / Official Event inside a long leave wrongly became LOP/ML/PL.
        if (oe && !oe.clock_in_required) return code(CODES.OE, 'Official Event', { payable: true });
        if (isWeeklyOff(ctx, dow) && state.weeklyOffEligible) return code(CODES.WO, 'Weekly Off', { payable: true });
        return resolveLeaveDay(ctx, dateStr, req, state);
      }
      if (rec.status === 'absent') {
        // A paid Official Event created/edited after an Absent row was filed outranks it.
        if (oe && !oe.clock_in_required) return code(CODES.OE, 'Official Event', { payable: true });
        if (isWeeklyOff(ctx, dow) && state.weeklyOffEligible) return code(CODES.WO, 'Weekly Off', { payable: true });
        return code(CODES.LOP, 'Absent', { payable: false, lop: true });
      }
      // present / late — decided against THIS employee's own schedule, never a global 9:00.
      var sched = getEmployeeWorkSchedule(emp, dateStr);
      var ci = hhmm(rec.clock_in_time);
      var late = false;
      if (sched.hasExpected) {
        if (ci) late = timeGt(ci, addMin(sched.start, sched.graceMin));
        else if (rec.status === 'late') late = true; // no clock time but HR marked late
      } // flexible / unconfigured → never auto-late
      if (late) return code(CODES.L, 'Late', { payable: true, worked: true, clockIn: rec.clock_in_time, clockOut: rec.clock_out_time });
      return code(CODES.P, 'Present', { payable: true, worked: true, clockIn: rec.clock_in_time, clockOut: rec.clock_out_time });
    }

    // No attendance row — a real portal clock-in still counts as Present (sync lag safety).
    if (ctx.portalLog && ctx.portalLog(dateStr)) return code(CODES.P, 'Present (portal log)', { payable: true, worked: true });
    // §1 precedence: Official Event + Weekly Off outrank approved leave, so a WO/OE inside an
    // approved leave range stays WO/OE and never becomes LOP/ML/PL (checked BEFORE the leave).
    if (oe && !oe.clock_in_required) return code(CODES.OE, 'Official Event', { payable: true });
    if (isWeeklyOff(ctx, dow)) {
      if (state.weeklyOffEligible) return code(CODES.WO, 'Weekly Off', { payable: true });
      return code(CODES.LOP, 'Weekly Off not applicable (probation/notice)', { payable: false, lop: true });
    }
    // Approved leave still covers the remaining working day.
    if (req) return resolveLeaveDay(ctx, dateStr, req, state);
    // Nothing → unmarked working day = LOP.
    return code(CODES.LOP, 'Unmarked / Absent', { payable: false, lop: true });
  }

  function resolveLeaveDay(ctx, dateStr, req, state) {
    // Probation/notice → any leave = LOP (§6/§10).
    if (state.onProbation) return code(CODES.LOP, 'Leave during probation → LOP', { payable: false, lop: true });
    if (state.onNotice) return code(CODES.LOP, 'Leave during notice → LOP', { payable: false, lop: true });
    var kind = req ? normType(req.leave_type) : 'OTHER';
    // Maternity Leave — approved ML is always PAID / non-LOP (§5). Not subject to SL/CL
    // balance caps, and NEVER auto-converts to LOP (checked before the final_treatment gate).
    if (kind === 'ML') return code(CODES.ML, 'Maternity Leave', { payable: true, leave: true, maternity: true });
    var exception = req && (req.status === 'Exception Approved' || req.final_treatment === 'exception' || req.exception_by);
    // A valid APPROVED paid leave stays PAID. It becomes LOP ONLY when explicitly marked so:
    // final_treatment 'lop' (set when HR/policy resolved it as unpaid, or entitlement exhausted)
    // — NEVER auto-converted by week-off/holiday adjacency. Adjacency now surfaces as a warning
    // at request time (see resolveLeaveEligibility), so HR can choose to LOP it, but the default
    // for an eligible approved SL/CL is Paid Leave. (Balance-exhaustion → LOP is enforced by the
    // payroll consumer, which knows the running SL/CL balance for the month.)
    if (req && !exception && req.final_treatment === 'lop') return code(CODES.LOP, 'Marked unpaid / entitlement exhausted → LOP', { payable: false, lop: true });
    if (kind === 'SL') return code(CODES.SL, 'Sick Leave', { payable: true, leave: true });
    if (kind === 'CL') return code(CODES.CL, 'Casual Leave', { payable: true, leave: true });
    if (kind === 'WFH') return code(CODES.WFH, 'WFH', { payable: true, worked: true });
    // Only a leave type that is not a configured paid entitlement falls to LOP.
    return code(CODES.LOP, 'Unpaid / non-entitlement leave → LOP', { payable: false, lop: true });
  }

  function code(c, label, meta) { return Object.assign({ code: c, label: label }, meta || {}); }

  // =========================================================================
  // Late-login / early-logout monthly incident engine (§11). Auditable list.
  // =========================================================================
  function resolveIncidents(ctx, monthStr) {
    var incidents = [];
    var sched = getEmployeeWorkSchedule(ctx.employee, monthStr + '-01');
    // §2/§4/§5 override: NO incidents for flexible/unconfigured employees — an incident is only
    // valid against the employee's own configured expected start/end (+ grace), never a global.
    if (sched.hasExpected) {
      var startThresh = addMin(sched.start, sched.graceMin);
      var endThresh = sched.end ? addMin(sched.end, -sched.graceMin) : null;
      (ctx.attendance || []).forEach(function (a) {
        var d = a.att_date && a.att_date.slice(0, 10); if (!d || d.slice(0, 7) !== monthStr) return;
        if (['absent', 'on_leave', 'holiday'].indexOf(a.status) >= 0) return; // only worked days
        var ci = hhmm(a.clock_in_time), co = hhmm(a.clock_out_time);
        if (ci && timeGt(ci, startThresh)) incidents.push({ date: d, type: 'late_login', at: ci });
        if (endThresh && co && timeGt(endThresh, co)) incidents.push({ date: d, type: 'early_logout', at: co });
      });
    }
    var count = incidents.length;
    // §11 NOT cumulative: 4+ → 1 full day; else 2..3 → 0.5 day; else 0. Never both.
    var deductionDays = count >= P.INCIDENT_FULLDAY_AT ? 1 : count >= P.INCIDENT_HALFDAY_AT ? 0.5 : 0;
    return { month: monthStr, incidents: incidents, count: count, deductionDays: deductionDays,
      reason: deductionDays === 1 ? (count + ' late-login/early-logout incidents — Full Day Deduction')
            : deductionDays === 0.5 ? (count + ' late-login/early-logout incidents — Half Day Deduction') : null };
  }

  // =========================================================================
  // 5. resolvePayrollDeduction(ctx, month) — reads policy-resolved statuses.
  //    Returns LOP days + full breakdown + incident deduction, with an audit
  //    trail string per deduction. Payroll multiplies by daily salary.
  // =========================================================================
  function resolvePayrollDeduction(ctx, monthStr) {
    var p = monthStr.split('-').map(Number), y = p[0], m = p[1];
    var daysInMonth = new Date(y, m, 0).getDate();
    var todayStr = ymd(ctx.now || new Date());
    var buckets = { present: 0, late: 0, wfh: 0, sl: 0, cl: 0, ml: 0, wo: 0, holiday: 0, oe: 0, half: 0, lop: 0, lopDouble: 0, preJoining: 0 };
    var lopDays = 0, breakdown = [];
    for (var d = 1; d <= daysInMonth; d++) {
      var dateStr = monthStr + '-' + String(d).padStart(2, '0');
      if (dateStr > todayStr) continue; // not yet occurred
      var r = resolveAttendanceStatus(ctx, dateStr);
      if (r.preJoining) { buckets.preJoining++; lopDays += 1; breakdown.push({ date: dateStr, code: 'PRE', lop: 1, reason: 'Pre-joining day' }); continue; }
      switch (r.code) {
        case CODES.P: buckets.present++; break;
        case CODES.L: buckets.late++; break;
        case CODES.WFH: buckets.wfh++; break;
        case CODES.SL: buckets.sl++; break;
        case CODES.CL: buckets.cl++; break;
        case CODES.ML: buckets.ml++; break; // Maternity Leave — paid, no deduction (§5)
        case CODES.WO: buckets.wo++; break;
        case CODES.H: buckets.holiday++; break;
        case CODES.OE: buckets.oe++; break;
        case 'HD': buckets.half++; lopDays += 0.5; breakdown.push({ date: dateStr, code: 'HD', lop: 0.5, reason: 'Half day' }); break;
        case CODES.LOP:
        default:
          var factor = r.lopFactor === 2 ? 2 : 1;
          if (factor === 2) buckets.lopDouble++; else buckets.lop++;
          lopDays += factor;
          breakdown.push({ date: dateStr, code: 'LOP', lop: factor, reason: r.label + (factor === 2 ? ' (double)' : '') });
      }
    }
    var incidents = resolveIncidents(ctx, monthStr);
    if (incidents.deductionDays > 0) breakdown.push({ date: monthStr, code: 'INC', lop: incidents.deductionDays, reason: incidents.reason });
    var totalLopDays = lopDays + incidents.deductionDays;
    return {
      month: monthStr, daysInMonth: daysInMonth,
      buckets: buckets, lopDays: lopDays, incidentDays: incidents.deductionDays,
      totalDeductionDays: totalLopDays, incidents: incidents, breakdown: breakdown
    };
  }

  // =========================================================================
  // async DB layer — buildContext + policy-sensitive writes (Supabase `sb`).
  // =========================================================================
  function makeDb(sb) {
    if (!sb) return null;
    var db = {
      // Build a full ctx for one employee (leave requests + attendance + calendar + ledgers).
      buildContext: async function (employee, opts) {
        opts = opts || {};
        var empId = employee.id;
        var res = await Promise.all([
          sb.from('hr_leave_requests').select('*').eq('employee_id', empId),
          sb.from('hr_attendance').select('*').eq('employee_id', empId),
          sb.from('hr_holidays').select('*'),
          sb.from('hr_company_settings').select('*').maybeSingle(),
          sb.from('hr_cl_buckets').select('*').eq('employee_id', empId),
          sb.from('hr_sl_ledger').select('*').eq('employee_id', empId)
        ]);
        return {
          employee: employee,
          requests: res[0].data || [],
          attendance: res[1].data || [],
          holidays: res[2].data || [],
          settings: res[3].data || {},
          clBuckets: res[4].data || [],
          slLedger: res[5].data || [],
          now: opts.now || new Date(),
          date: opts.date || ymd(opts.now || new Date())
        };
      },
      logAudit: async function (row) {
        try { await sb.from('hr_audit_log').insert(Object.assign({ created_at: new Date().toISOString() }, row)); } catch (e) { console.warn('audit log failed', e); }
      },
      // Ensure current CL cycle bucket + SL month row exist for an employee (idempotent).
      ensureCurrent: async function (empId, dateStr) {
        dateStr = dateStr || ymd(new Date());
        var cyc = clCycleFor(dateStr), period = monthPeriod(dateStr);
        try { await sb.from('hr_cl_buckets').upsert({ employee_id: empId, credit_date: cyc.credit_date, cycle_label: cyc.label, original_amount: P.CL_PER_CYCLE, remaining_amount: P.CL_PER_CYCLE, expiry_date: cyc.expiry_date, source: 'auto-credit' }, { onConflict: 'employee_id,cycle_label', ignoreDuplicates: true }); } catch (e) {}
        try { await sb.from('hr_sl_ledger').upsert({ employee_id: empId, period: period, entitlement: P.SL_PER_MONTH, used: 0, expired: 0 }, { onConflict: 'employee_id,period', ignoreDuplicates: true }); } catch (e) {}
      }
    };
    return db;
  }

  var LeavePolicy = {
    P: P, CODES: CODES,
    normType: normType,
    clCycleFor: clCycleFor,
    getEmployeeWorkSchedule: getEmployeeWorkSchedule,
    getEmployeePolicyState: getEmployeePolicyState,
    resolveLeaveBalance: resolveLeaveBalance,
    resolveLeaveEligibility: resolveLeaveEligibility,
    resolveAttendanceStatus: resolveAttendanceStatus,
    resolveIncidents: resolveIncidents,
    resolvePayrollDeduction: resolvePayrollDeduction,
    detectAdjacency: detectAdjacency,
    planCLConsumption: planCLConsumption,
    isApproved: isApproved,
    makeDb: makeDb,
    // convenience: attach a live sb client
    withClient: function (sb) { this.db = makeDb(sb); return this; }
  };

  global.LeavePolicy = LeavePolicy;
  if (typeof module !== 'undefined' && module.exports) module.exports = LeavePolicy;
})(typeof window !== 'undefined' ? window : globalThis);
