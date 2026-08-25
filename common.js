// ══════════════════════════════════════════════════════════════════════════
// shared/common.js — Broken English Media Suite
// Loaded by index.html (Pipeline), academic module, and hr/index.html.
// One Supabase backend, one auth/session, one set of employee/attendance/leave
// data-access + calculation functions — so HR, Academic, and Pipeline can never
// disagree about what "Present", "my payslip", or "my leave balance" means.
//
// This file owns:
//   - Supabase client setup (dbInstance + acadDB)
//   - Session/auth state (activeUser/activeEmail/activeRole, currentUser)
//   - The notification bell (badges, dismiss/read tracking) + Announcements core
//   - Pure HR calculation/lookup helpers used by more than one module
//   - loadMyHRData() — a lightweight, SELF-SCOPED data loader for employee
//     self-service pages (My Attendance/Leave/Payslips/Profile) and the
//     notification poll. This replaces those callers' previous dependency on
//     hr.html's full company-wide loadHRData() (all employees, all attendance,
//     all salary history, all applicants, every employee's documents) — which
//     is real, unnecessary, and in the applicants/salary-history/documents case
//     sensitive over-fetching for a plain employee's browser on every ~20s poll.
//     hr.html defines its own loadHRData() for the full admin view; both write
//     into the SAME shared array names below, so every reader here works
//     identically regardless of which loader populated them.
// ══════════════════════════════════════════════════════════════════════════

// Small generic HTML-escape helper — used by Academic (index.html) and now also by
// hr.html's rendering code. Safe to also exist in index.html's own script (a `function`
// declaration re-declaring the same name doesn't throw, unlike let/const) — both are
// identical, whichever loads is fine.
function esc(s){return String(s??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));}

// ---------- Supabase clients ----------
const SUPABASE_URL = "https://fevqnpllmarhoqdzpatq.supabase.co";
        const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZldnFucGxsbWFyaG9xZHpwYXRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1OTI1MjgsImV4cCI6MjA5NzE2ODUyOH0.23qi1hDcOA19W2psdIiP2ucypkymG7BZzcTrt2Q2ZSA";
        const dbInstance = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Academic's tables now live in the same project as HR/Media Suite — consolidated here
// after the original separate Academic project (baazubvfsrpmbfmrzumw) became unreachable
// under the current login. See academics.html for the matching change.
const ACAD_SUPABASE_URL = SUPABASE_URL;
const ACAD_SUPABASE_KEY = SUPABASE_ANON_KEY;
const acadDB = supabase.createClient(ACAD_SUPABASE_URL, ACAD_SUPABASE_KEY);

// ---------- Session / identity ----------
let currentUser = null; // bridge var: { name, username, role } so ported Academic functions (written against currentUser.role) work unchanged
let activeUser = localStorage.getItem('be_active_user') || null;
let activeRole = localStorage.getItem('be_active_role') || null;
let activeEmail = localStorage.getItem('be_active_email') || null;

// ---------- Notification bell state ----------
let notifications = [];  // { id, type, topic, assignedTo, time }
let _readNotifIds = new Set();
let _lastKnownPayslipIds = new Set();
let _lastKnownLeaveStatuses = {};
let _lastKnownAnnouncementIds = new Set();
let _hrNotifBaselineLoaded = false;
let _lastHRNotifPoll = 0;

// ---------- Announcements state (HR writes from hr.html, everyone reads here) ----------
let hrAnnouncements = [];
let hrAnnouncementReads = [];
let _announcementsTableMissing = false;

// ---------- Shared employee/attendance/leave/payroll state ----------
// Populated by EITHER loadMyHRData() (index.html, scoped to "me") or hr.html's own
// loadHRData() (full company-wide) — every function below reads these same array
// names regardless of which loader filled them.
let hrEmployees = [];
let hrLeaveRequests = [];
let hrLeaveBalances = [];
let hrAttendance = [];
let hrPayroll = [];
let hrSalaryHistory = [];
let hrHolidays = [];
let hrOfficialEvents = []; // hr_official_events — paid company-wide event days (see hrOfficialEventFor)
let hrCelebrationEvents = []; // hr_celebration_events — HR-configured festival/company-event wishes (see computeTodaysCelebrations)
let hrCompanySettings = { weekly_off_sunday: true, weekly_off_saturday: false };
let myHRDataLoaded = false; // guards loadMyHRData() the same way hr.html's hrLoaded guards loadHRData()

// ---------- HR constants (used by calculation helpers shared across modules) ----------
        const HR_ROLES = {
            production: ['Editor', 'Designer', 'Cinematographer', 'Photographer', 'Video Editor', 'Colorist', 'VFX & Motion Graphics Artist', 'Production Coordinator'],
            education: ['Academic Head', 'Class Coordinator', 'Coaches'], // exactly these 3 — Academic Head & Class Coordinator have identical management access, Coaches see only their own assigned work (see checkAcademicAccess)
            // Department-specific role sets — the Add Employee form picks this list based on
            // whichever Department is selected (see hr-emp-division/renderHREmpRoleChips), so
            // HR only ever sees HR roles, Accounts only sees Accounts roles, etc. "Intern" is
            // included as an available option, not a requirement — nothing forces it to be used.
            hr: ['HR Manager', 'HR Executive', 'HR Intern'],
            accounts: ['Accounts Manager', 'Accounts Executive', 'Accounts Intern'],
            sales: ['Student Counselor', 'Student Counselor Head'],
            other: [] // Administration/etc. — no preset chips, Designation field covers the title
        };
        function hrParseRoles(departmentStr) {
            return (departmentStr || '').split(',').map(s => s.trim()).filter(Boolean);
        }
        function hrJoinRoles(rolesArray) {
            return (rolesArray || []).join(', ');
        }
        // Seniority level — same no-new-column approach as Roles: the level is stored as a
        // plain-text prefix on the PRIMARY role only (roles[0]), e.g. department =
        // "Senior Editor, Cinematographer, Designer". Additional roles never carry a level.
        const HR_LEVELS = ['Senior', 'Mid-Level', 'Junior'];
        const HR_LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Annual Leave', 'Emergency Leave', 'Unpaid Leave', 'Work From Home'];
        const HR_UNLIMITED_LEAVE_TYPES = ['Unpaid Leave']; // these show "—" for Allocated/Remaining instead of a number
        // Company's standard/default leave policy — auto-assigned to every new employee so HR
        // never has to manually type a starting allocation per person. Edit these numbers to
        // change the company-wide policy; existing employees' allocations are untouched (they're
        // only used as the seed value at the moment an employee record is first created).
        const HR_DEFAULT_LEAVE_ALLOCATION = {
            'Casual Leave': 3,
            'Sick Leave': 1,
            'Annual Leave': 12,
            'Emergency Leave': 3,
            'Unpaid Leave': null, // no fixed allocation
            'Work From Home': 10
        };
        const HR_ATT_STATUSES = ['present', 'absent', 'late', 'afternoon', 'half_day', 'wfh', 'on_leave', 'holiday'];
        // Monthly paid-leave allowance (payroll policy, not a per-leave-type balance): the
        // first N approved leave days in a calendar month across every eligible paid leave
        // type are fully paid; only days beyond this become LOP. 'Unpaid Leave' and 'Work From
        // Home' are never eligible — Unpaid Leave is LOP by definition, WFH is already counted
        // as a worked/present day, not leave, elsewhere in this file. There is no separate
        // "always-paid medical/special exception" flag in hr_leave_requests today (only
        // leave_type), so every other approved leave_type (Casual/Sick/Annual/Emergency Leave)
        // is treated as eligible — see hrCalculatePayrollForMonth.
        const HR_MONTHLY_PAID_LEAVE_DAYS = 3;
        // ── Late auto-detection ─────────────────────────────────────────────────────
        // Single cutoff, single source of truth: clock in at/before this hour → Present;
        // after it → Present + Late. Simplified to exactly this 2-state model per spec
        // ("clock-in before 1PM → Present, after 1PM → Present + Late" — no intermediate
        // tier). 'afternoon' stays a valid, supported status value everywhere it's already
        // used (HR_PRESENT_STATUSES, hrAttStatusLabel, the attendance grid's AL code, manual
        // status dropdowns) in case it's ever set manually or appears in older records — this
        // function itself just never auto-produces it anymore.
        const HR_LATE_AFTER_HOUR = 13; // after 1:00 PM = Present · Late
        // Which stored statuses count as "Present" for any percentage/summary calculation —
        // one array everyone reads, so "does Late count as Present" can never drift out of
        // sync between the dashboard tile, reports, and Academic's Employee Attendance view.
        const HR_PRESENT_STATUSES = ['present', 'late', 'afternoon', 'half_day', 'wfh'];

// ---------- Department separation: Academic must never leak into the Production
// Pipeline, and vice versa. The task-assignment dropdown (populateDropdownSelectors in
// index.html) is built from user_roster, which carries login ROLE (employee/manager/
// admin/social_media) but not DIVISION — an Academic person with portal access would
// otherwise show up there indistinguishably from a Production one. This is a minimal,
// cached lookup (just portal_email + division, nothing else) so that dropdown can filter
// them out without needing a full, unscoped employee fetch on every render. ----------
let _academicPortalEmails = new Set();
let _lastAcademicEmailsFetch = 0;
async function refreshAcademicEmailsCache() {
    const now = Date.now();
    if (now - _lastAcademicEmailsFetch < 60000) return; // throttled — this is a slow-changing list
    _lastAcademicEmailsFetch = now;
    try {
        const { data, error } = await dbInstance.from('hr_employees').select('portal_email').eq('division', 'education');
        if (!error && data) {
            _academicPortalEmails = new Set(data.map(e => (e.portal_email || '').toLowerCase()).filter(Boolean));
        }
    } catch (e) { /* leave the previous cache in place rather than blanking it on a transient error */ }
}

// ---------- Department-scoped "who's on leave" widget (Team Members section) ----------
// Deliberately NOT the full employee directory — Coaches/regular employees don't get that
// (see role-head-only on the Coaches roster, and Manager-only on My Team). This is a
// narrow, purpose-built query: just enough fields to show a name, photo, and leave dates
// for people in the SAME division as the viewer, restricted to currently-APPROVED leave
// only (never pending/rejected) — scoped at the query itself, not filtered client-side
// from a bigger fetch.
async function fetchDeptOnLeaveToday() {
    const me = myHREmployeeRecord();
    if (!me || !me.division) return [];
    try {
        const { data: deptEmployees, error: e1 } = await dbInstance.from('hr_employees')
            .select('id,full_name,photo_base64,photo_url,division')
            .eq('division', me.division)
            .eq('employment_status', 'active');
        if (e1 || !deptEmployees || !deptEmployees.length) return [];
        const ids = deptEmployees.map(e => e.id);
        const today = new Date().toISOString().slice(0, 10);
        const { data: leaves, error: e2 } = await dbInstance.from('hr_leave_requests')
            .select('*')
            .eq('status', 'approved')
            .lte('start_date', today)
            .gte('end_date', today)
            .in('employee_id', ids);
        if (e2 || !leaves) return [];
        const byId = {}; deptEmployees.forEach(e => { byId[e.id] = e; });
        return leaves.map(l => ({ employee: byId[l.employee_id], leave: l })).filter(x => x.employee);
    } catch (e) {
        console.warn('fetchDeptOnLeaveToday failed:', e.message);
        return [];
    }
}

async function renderDeptOnLeaveWidget(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const rows = await fetchDeptOnLeaveToday();
    if (!rows.length) {
        el.innerHTML = `<p class="text-[#4a5182] text-xs italic py-3 text-center">No one on your team is on leave today.</p>`;
        return;
    }
    el.innerHTML = rows.map(({ employee, leave }) => `
        <div class="flex items-center gap-3 p-3 rounded-xl" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06)">
            ${hrAvatarHTML(employee, 36)}
            <div class="flex-1 min-w-0">
                <div class="text-sm font-bold text-white truncate">${employee.full_name}</div>
                <div class="text-[11px] text-[#6b74a0]">${leave.start_date} → ${leave.end_date}</div>
            </div>
            <span class="hr-badge hr-badge-on_leave shrink-0">On Leave</span>
        </div>
    `).join('');
}

// Team-leave notifications: a division-mate's leave just became approved. Fires into the
// SAME bell as everything else (payslip/leave-status), deduped per leave-request id so it
// only ever announces once, not on every poll tick.
let _lastKnownDeptLeaveIds = new Set();
function loadDeptLeaveNotifBaseline() {
    try { _lastKnownDeptLeaveIds = new Set(JSON.parse(localStorage.getItem(`be_known_dept_leaves_${activeEmail}`) || '[]')); }
    catch (e) { _lastKnownDeptLeaveIds = new Set(); }
}
function saveDeptLeaveNotifBaseline() {
    localStorage.setItem(`be_known_dept_leaves_${activeEmail}`, JSON.stringify([..._lastKnownDeptLeaveIds]));
}
async function checkDeptLeaveNotifications() {
    const me = myHREmployeeRecord();
    if (!me || !me.division) return;
    const hadBaseline = localStorage.getItem(`be_known_dept_leaves_${activeEmail}`) !== null;
    loadDeptLeaveNotifBaseline();
    try {
        const { data: deptEmployees } = await dbInstance.from('hr_employees')
            .select('id,full_name').eq('division', me.division).eq('employment_status', 'active');
        if (!deptEmployees || !deptEmployees.length) return;
        const ids = deptEmployees.map(e => e.id);
        const byId = {}; deptEmployees.forEach(e => { byId[e.id] = e; });
        const { data: leaves } = await dbInstance.from('hr_leave_requests').select('*').eq('status', 'approved').in('employee_id', ids);
        if (!leaves) return;
        let changed = false;
        leaves.forEach(l => {
            if (l.employee_id === me.id) return; // don't notify me about my own leave — that's the existing leave_approved notif
            if (!_lastKnownDeptLeaveIds.has(l.id)) {
                if (hadBaseline) {
                    const who = byId[l.employee_id]?.full_name || 'A team member';
                    addNotif('team_leave', `${who} is on leave from ${l.start_date} to ${l.end_date}.`, null, l.id);
                }
                _lastKnownDeptLeaveIds.add(l.id);
                changed = true;
            }
        });
        if (changed) saveDeptLeaveNotifBaseline();
    } catch (e) { /* non-critical — skip this tick */ }
}

// ---------- loadMyHRData(): lightweight, self-scoped loader ----------
// Fetches ONLY the current employee's own rows — never the full company roster,
// applicants, or other employees' salary history/documents. Used by the My
// Attendance/Leave/Payslips/Profile pages and the notification poll.
async function loadMyHRData() {
    if (!activeEmail) { myHRDataLoaded = true; return; }
    try {
        let lookup = await dbInstance.from('hr_employees').select('*').eq('portal_email', activeEmail.trim().toLowerCase()).limit(1);
        let me = lookup.data && lookup.data[0];
        if (!me && activeUser) {
            const byName = await dbInstance.from('hr_employees').select('*').eq('full_name', activeUser).limit(1);
            me = byName.data && byName.data[0];
        }
        if (!me) {
            hrEmployees = []; hrAttendance = []; hrLeaveRequests = []; hrLeaveBalances = [];
            hrPayroll = []; hrSalaryHistory = [];
            const [hol, oe, cel, settings] = await Promise.all([
                dbInstance.from('hr_holidays').select('*').order('holiday_date', { ascending: true }),
                dbInstance.from('hr_official_events').select('*').order('event_date', { ascending: true }),
                dbInstance.from('hr_celebration_events').select('*').order('event_date', { ascending: true }),
                dbInstance.from('hr_company_settings').select('*').limit(1)
            ]);
            hrHolidays = hol.data || [];
            hrOfficialEvents = oe.data || [];
            if (cel.error) console.error('Celebration engine: hr_celebration_events fetch failed —', cel.error.message);
            hrCelebrationEvents = cel.data || [];
            if (settings.data && settings.data[0]) hrCompanySettings = settings.data[0];
            myHRDataLoaded = true;
            return;
        }
        // Managers additionally get their direct reports — via a SERVER-SIDE scoped query
        // (eq('manager_email', ...)), never a full-roster fetch filtered client-side. Plain
        // employees never trigger this at all, so they still only ever pull their own row.
        let teamMembers = [];
        if (activeRole === 'manager') {
            const teamRes = await dbInstance.from('hr_employees').select('*').eq('manager_email', activeEmail.trim().toLowerCase());
            // Defensive: only ever include reports in the same division as the manager — a
            // stray/incorrect manager_email on someone in the other department must never
            // surface them in "My Team", even if HR data entry made that mistake.
            teamMembers = (teamRes.data || []).filter(t => t.id !== me.id && t.division === me.division);
        }
        const teamIds = [me.id, ...teamMembers.map(t => t.id)];
        const scopeAttLeave = q => teamIds.length > 1 ? q.in('employee_id', teamIds) : q.eq('employee_id', me.id);

        const [att, leaveReq, leaveBal, pay, salHist, hol, oe, cel, settings, attLogs] = await Promise.all([
            scopeAttLeave(dbInstance.from('hr_attendance').select('*')),
            scopeAttLeave(dbInstance.from('hr_leave_requests').select('*')).order('requested_at', { ascending: false }),
            scopeAttLeave(dbInstance.from('hr_leave_balances').select('*')),
            // Payroll/salary history stay self-only regardless of role — a manager's "My Team"
            // view never shows pay data, so their reports' salaries have no reason to be fetched.
            dbInstance.from('hr_payroll').select('*').eq('employee_id', me.id).eq('published', true).order('month', { ascending: false }),
            dbInstance.from('hr_salary_history').select('*').eq('employee_id', me.id).order('effective_date', { ascending: false }),
            dbInstance.from('hr_holidays').select('*').order('holiday_date', { ascending: true }),
            dbInstance.from('hr_official_events').select('*').order('event_date', { ascending: true }),
            dbInstance.from('hr_celebration_events').select('*').order('event_date', { ascending: true }),
            dbInstance.from('hr_company_settings').select('*').limit(1),
            // Own raw clock-in log — hrAttDayCode/hrCalculatePayrollForMonth's fallback (via
            // hrPortalLogFor) needs this populated here too, not just from hr.html's loader, or
            // My Attendance can show a gap the same sync failure already fixed elsewhere.
            dbInstance.from('attendance_logs').select('*').eq('employee_email', activeEmail.trim().toLowerCase())
        ]);
        hrEmployees = [me, ...teamMembers]; // self-service views only ever need myHREmployeeRecord()'s own row + (for managers) their team
        hrAttendance = att.data || [];
        hrLeaveRequests = leaveReq.data || [];
        hrLeaveBalances = leaveBal.data || [];
        hrPayroll = pay.data || [];
        hrSalaryHistory = salHist.data || [];
        hrHolidays = hol.data || [];
        hrOfficialEvents = oe.data || [];
        if (cel.error) console.error('Celebration engine: hr_celebration_events fetch failed —', cel.error.message);
        hrCelebrationEvents = cel.data || [];
        if (settings.data && settings.data[0]) hrCompanySettings = settings.data[0];
        if (!attLogs.error) window._hrAttendanceLogsCache = attLogs.data || [];
    } catch (e) {
        console.warn('loadMyHRData failed:', e.message);
    } finally {
        myHRDataLoaded = true;
    }
}


// ── hrSyncClockToAttendance (orig line 4611) ──
        async function hrSyncClockToAttendance(email, kind, whenIso) {
            try {
                const cleanEmail = (email || '').toLowerCase().trim();
                const empRes = await dbInstance.from('hr_employees').select('id').eq('portal_email', cleanEmail).limit(1);
                let emp = empRes.data && empRes.data[0];
                if (!emp) {
                    // No HR record linked by email — try matching by name instead, same fallback
                    // hrFetchAndApplyMyPhoto() already uses, so a clock-in from someone whose HR
                    // record predates having a portal_email set still gets synced instead of
                    // silently vanishing (this was the actual cause of "Present on the clock-in
                    // screen, missing from the HR Attendance Report").
                    if (typeof activeUser !== 'undefined' && activeUser) {
                        const byName = await dbInstance.from('hr_employees').select('id').eq('full_name', activeUser).limit(1);
                        emp = byName.data && byName.data[0];
                    }
                }
                if (!emp) {
                    console.warn(`HR attendance sync: no hr_employees record found for "${email}" — clock-${kind} at ${whenIso} was NOT written to hr_attendance. Link this login to an HR employee record (portal_email) to fix.`);
                    return;
                }
                const dateStr = todayDateStr();
                const existingRes = await dbInstance.from('hr_attendance').select('*').eq('employee_id', emp.id).eq('att_date', dateStr).limit(1);
                const existing = existingRes.data && existingRes.data[0];
                if (kind === 'in') {
                    // Late/Afternoon-login is auto-detected from the actual clock-in time —
                    // never manually guessed — and still means Present (see HR_PRESENT_STATUSES
                    // and hrAttStatusLabel: it always reads "Present · ...", never bare "Late").
                    const computedStatus = hrComputeClockInStatus(whenIso);
                    if (existing) {
                        // Don't let an automatic clock-in silently overwrite a status HR set on
                        // purpose. This was the actual cause of "HR marks someone On Leave and it
                        // resets itself" — a clock-in event for that date (the employee's own,
                        // unaware they'd been marked out; or a stale/replayed sync) would flip
                        // 'on_leave' straight back to 'present'/'late' with no visible HR action
                        // to explain it. Holiday got this protection before; On Leave needs it too.
                        const HR_PROTECTED_FROM_AUTO_CLOCKIN = ['holiday', 'on_leave'];
                        const nextStatus = HR_PROTECTED_FROM_AUTO_CLOCKIN.includes(existing.status) ? existing.status : computedStatus;
                        await dbInstance.from('hr_attendance').update({ status: nextStatus, clock_in_time: whenIso }).eq('id', existing.id);
                    } else {
                        await dbInstance.from('hr_attendance').insert([{ employee_id: emp.id, att_date: dateStr, status: computedStatus, clock_in_time: whenIso }]);
                    }
                } else if (kind === 'out' && existing) {
                    // Update the same day's record only — never create a second attendance entry on clock-out.
                    await dbInstance.from('hr_attendance').update({ clock_out_time: whenIso }).eq('id', existing.id);
                }
                if (typeof hrLoaded !== 'undefined' && hrLoaded) await loadHRData(); // hr.html only, if the admin view is open
                if (typeof loadMyHRData === 'function') await loadMyHRData(); // reflect the clock-in in My Attendance immediately
            } catch (e) {
                console.warn('HR attendance sync from clock action failed:', e.message);
            }
        }

// ── hrDriveDownloadUrl (orig line 5161) ──
        function hrDriveDownloadUrl(url) {
            if (!url) return url;
            const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/) || url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/) || url.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
            return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
        }

// ── hrDriveFileId (orig line 5166) ──
        function hrDriveFileId(url) {
            const m = (url||'').match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/) || (url||'').match(/[?&]id=([a-zA-Z0-9_-]{10,})/) || (url||'').match(/\/d\/([a-zA-Z0-9_-]{10,})/);
            return m ? m[1] : null;
        }

// ── notifMeta (orig line 6916) ──
        function notifMeta(n) {
            switch (n.type) {
                case 'rework': return { icon: 'refresh-cw', color: 'red', label: '🔄 Rework Required', onClick: null };
                case 'payslip': return { icon: 'wallet', color: 'green', label: '💰 New Payslip Available', onClick: "switchTab('my-payslips');closeNotifPanel();" };
                case 'leave_approved': return { icon: 'check-circle-2', color: 'green', label: '✅ Leave Approved', onClick: "switchTab('my-leave');closeNotifPanel();" };
                case 'leave_rejected': return { icon: 'x-circle', color: 'red', label: '❌ Leave Rejected', onClick: "switchTab('my-leave');closeNotifPanel();" };
                case 'announcement': return { icon: 'megaphone', color: 'orange', label: '📢 Company Announcement', onClick: null };
                case 'team_leave': return { icon: 'calendar-days', color: 'orange', label: '🌴 Team Member On Leave', onClick: null };
                case 'birthday': return { icon: 'cake', color: 'orange', label: '🎂 Happy Birthday!', onClick: null };
                case 'work_anniversary': return { icon: 'award', color: 'orange', label: '🏆 Work Anniversary', onClick: null };
                case 'celebration': return { icon: 'party-popper', color: 'orange', label: '🎉 Celebration', onClick: null };
                default: return { icon: 'plus-circle', color: 'orange', label: '🆕 New Task Assigned', onClick: null };
            }
        }

// ── loadNotifs (orig line 6928) ──
        function loadNotifs() {
            try { notifications = JSON.parse(localStorage.getItem(`be_notifs_${activeEmail}`) || '[]'); } catch(e) { notifications = []; }
            try { _readNotifIds = new Set(JSON.parse(localStorage.getItem(`be_read_notifs_${activeEmail}`) || '[]')); } catch(e) { _readNotifIds = new Set(); }
            notifications = notifications.filter(n => !_readNotifIds.has(n.id));
        }

// ── saveNotifs (orig line 6933) ──
        function saveNotifs() {
            localStorage.setItem(`be_notifs_${activeEmail}`, JSON.stringify(notifications.slice(0, 50)));
            localStorage.setItem(`be_read_notifs_${activeEmail}`, JSON.stringify([..._readNotifIds].slice(0, 200)));
        }

// ── addNotif (orig line 6937) ──
        function addNotif(type, topic, assignedTo, taskId) {
            // Stable ID per (type, task) — previously this was Date.now(), meaning a
            // regenerated notification for the SAME task always got a fresh id, so the
            // dismissed-ids set could never block it and cleared notifications kept
            // coming back (especially on other devices with their own localStorage).
            const newId = taskId ? `${type}_${taskId}` : `${type}_${Date.now()}`;
            if (_readNotifIds.has(newId)) return; // permanently dismissed — never re-add
            if (notifications.some(n => n.id === newId)) return; // already showing
            notifications.unshift({ id: newId, type, topic, assignedTo, time: new Date().toISOString() });
            saveNotifs();
            renderNotifBadges();
            renderDashboardNotifFeed();
        }

// ── clearNotifsForTask (orig line 6952) ──
        function clearNotifsForTask(taskId) {
            if (!taskId) return;
            const before = notifications.length;
            notifications = notifications.filter(n => n.id !== `new_${taskId}` && n.id !== `rework_${taskId}`);
            _readNotifIds.add(`new_${taskId}`);
            _readNotifIds.add(`rework_${taskId}`);
            if (notifications.length !== before) {
                saveNotifs();
                renderNotifBadges();
                renderDashboardNotifFeed();
                renderNotifList();
            } else {
                saveNotifs(); // still persist the read-ids so it can't come back later
            }
        }

// ── dismissAllNotifs (orig line 6967) ──
        function dismissAllNotifs() {
            notifications.filter(n => n.type === 'announcement').forEach(n => markAnnouncementRead(n.id.replace('announcement_', '')));
            notifications.forEach(n => _readNotifIds.add(n.id));
            notifications = [];
            saveNotifs();
            renderNotifBadges();
            renderDashboardNotifFeed();
            renderNotifList();
        }

// ── dismissNotif (orig line 6976) ──
        function dismissNotif(id) {
            const dismissed = notifications.find(n => n.id === id);
            if (dismissed && dismissed.type === 'announcement') markAnnouncementRead(id.replace('announcement_', ''));
            _readNotifIds.add(id);
            notifications = notifications.filter(n => n.id !== id);
            saveNotifs();
            renderNotifBadges();
            renderDashboardNotifFeed();
            renderNotifList();
        }

// ── renderNotifBadges (orig line 6986) ──
        function renderNotifBadges() {
            const total = notifications.length;
            const badge = document.getElementById('notif-badge-corner');
            if (badge) {
                if (total > 0) {
                    badge.textContent = total > 99 ? '99+' : total;
                    badge.style.display = 'flex';
                    badge.classList.remove('hidden');
                } else {
                    badge.style.display = 'none';
                    badge.classList.add('hidden');
                }
            }
            // Also update sidebar and mobile notification badges
            const sidebarBadge = document.getElementById('notif-badge-sidebar');
            if (sidebarBadge) {
                sidebarBadge.textContent = total;
                sidebarBadge.style.display = total > 0 ? 'inline-block' : 'none';
            }
            const mobileBadge = document.getElementById('notif-badge-mobile');
            if (mobileBadge) {
                mobileBadge.textContent = total;
                mobileBadge.style.display = total > 0 ? 'flex' : 'none';
            }
        }

// ── renderDashboardNotifFeed (orig line 7018) ──
        function renderDashboardNotifFeed() {
            const feed = document.getElementById('dashboard-notif-feed');
            if (!feed) return;
            if (notifications.length === 0) {
                feed.innerHTML = `<p class="text-center text-[#4a5182] text-xs italic py-6">No new notifications.</p>`;
                return;
            }
            feed.innerHTML = notifications.map(n => {
                const meta = notifMeta(n);
                const c = NOTIF_COLOR_CLASSES[meta.color] || NOTIF_COLOR_CLASSES.orange;
                const timeAgo = notifTimeAgo(n.time);
                const rowClick = meta.onClick ? ` cursor-pointer` : '';
                const rowOnClick = meta.onClick ? ` onclick="dismissNotif('${n.id}');${meta.onClick}"` : '';
                return `<div class="flex items-start gap-3 px-4 py-3 border-b border-white/[0.06]/50 hover:bg-transparent/40 transition${rowClick}"${rowOnClick}>
                    <div class="w-8 h-8 rounded-full ${c.bg} flex items-center justify-center shrink-0 mt-0.5">
                        <i data-lucide="${meta.icon}" class="w-4 h-4 ${c.icon}"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-white">${meta.label}</p>
                        <p class="text-[11px] text-gray-300 truncate">${n.topic}</p>
                        <p class="text-[10px] text-[#4a5182] mt-0.5">${timeAgo}</p>
                    </div>
                    <button onclick="event.stopPropagation();dismissNotif('${n.id}')" class="text-gray-600 hover:text-red-400 p-1 shrink-0 transition"><i data-lucide="x" class="w-3 h-3"></i></button>
                </div>`;
            }).join('');
            lucide.createIcons();
        }

// ── notifTimeAgo (orig line 7045) ──
        function notifTimeAgo(iso) {
            try {
                const diff = Date.now() - new Date(iso).getTime();
                const m = Math.floor(diff / 60000);
                if (m < 1) return 'just now';
                if (m < 60) return m + 'm ago';
                const h = Math.floor(m / 60);
                if (h < 24) return h + 'h ago';
                return Math.floor(h / 24) + 'd ago';
            } catch(e) { return ''; }
        }

// ── renderNotifList (orig line 7057) ──
        function renderNotifList() {
            const list = document.getElementById('notif-list');
            if (!list) return;
            if (notifications.length === 0) {
                list.innerHTML = `<p class="text-center text-[#4a5182] text-xs italic py-6">No new notifications.</p>`;
                return;
            }
            list.innerHTML = notifications.map(n => {
                const meta = notifMeta(n);
                const c = NOTIF_COLOR_CLASSES[meta.color] || NOTIF_COLOR_CLASSES.orange;
                const timeAgo = notifTimeAgo(n.time);
                const assignedLine = n.assignedTo ? `<p class="text-[11px] text-[#6b74a0] mt-0.5">By: <span class="text-gray-200 font-semibold">${n.assignedTo}</span></p>` : '';
                const rowClick = meta.onClick ? ` cursor-pointer` : '';
                const rowOnClick = meta.onClick ? ` onclick="dismissNotif('${n.id}');${meta.onClick}"` : '';
                return `<div class="flex items-start gap-3 px-4 py-4 hover:bg-transparent transition${rowClick}"${rowOnClick}>
                    <div class="w-9 h-9 rounded-full ${c.bg} flex items-center justify-center shrink-0 mt-0.5">
                        <i data-lucide="${meta.icon}" class="w-4 h-4 ${c.icon}"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold ${c.title} mb-1">${meta.label}</p>
                        <p class="text-sm font-bold text-white leading-snug break-words">${n.topic}</p>
                        ${assignedLine}
                        <p class="text-[10px] text-[#4a5182] mt-1.5">${timeAgo}</p>
                    </div>
                    <button onclick="event.stopPropagation();dismissNotif('${n.id}')" title="Dismiss" class="text-gray-600 hover:text-red-400 p-1.5 shrink-0 transition rounded-lg hover:bg-red-500/10 mt-0.5"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
                </div>`;
            }).join('');
            lucide.createIcons();
        }

// ── markNotifRead (orig line 7086) ──
        function markNotifRead(id) { dismissNotif(id); }

// ── markAllNotifsRead (orig line 7087) ──
        function markAllNotifsRead() { dismissAllNotifs(); }

// ── toggleNotifPanel (orig line 7291) ──
        function toggleNotifPanel() {
            const panel = document.getElementById('notif-panel');
            const isHidden = panel.classList.contains('hidden');
            panel.classList.toggle('hidden');
            if (isHidden) {
                renderNotifList();
                lucide.createIcons();
                // Opening = seen: hide the corner badge count.
                // Notifications stay listed until dismissed individually or via Mark All Read.
                const _nb=document.getElementById('notif-badge-corner'); if(_nb){_nb.style.display='none';_nb.classList.add('hidden');}
            }
        }

// ── loadHRNotifBaseline (orig line 7373) ──
        function loadHRNotifBaseline() {
            if (_hrNotifBaselineLoaded) return;
            try { _lastKnownPayslipIds = new Set(JSON.parse(localStorage.getItem(`be_known_payslips_${activeEmail}`) || '[]')); } catch(e) { _lastKnownPayslipIds = new Set(); }
            try { _lastKnownLeaveStatuses = JSON.parse(localStorage.getItem(`be_known_leave_statuses_${activeEmail}`) || '{}'); } catch(e) { _lastKnownLeaveStatuses = {}; }
            try { _lastKnownAnnouncementIds = new Set(JSON.parse(localStorage.getItem(`be_known_announcements_${activeEmail}`) || '[]')); } catch(e) { _lastKnownAnnouncementIds = new Set(); }
            _hrNotifBaselineLoaded = true;
        }

// ── saveHRNotifBaseline (orig line 7380) ──
        function saveHRNotifBaseline() {
            localStorage.setItem(`be_known_payslips_${activeEmail}`, JSON.stringify([..._lastKnownPayslipIds]));
            localStorage.setItem(`be_known_leave_statuses_${activeEmail}`, JSON.stringify(_lastKnownLeaveStatuses));
            localStorage.setItem(`be_known_announcements_${activeEmail}`, JSON.stringify([..._lastKnownAnnouncementIds]));
        }

// ── loadAnnouncements (orig line 7394) ──
        async function loadAnnouncements() {
            const [annRes, readsRes] = await Promise.all([
                dbInstance.from('hr_announcements').select('*').order('created_at', { ascending: false }),
                dbInstance.from('hr_announcement_reads').select('*')
            ]);
            const hasRows = (r) => r && r.data && r.data.length > 0;
            _announcementsTableMissing = !!(annRes.error && !hasRows(annRes));
            if (!_announcementsTableMissing) hrAnnouncements = annRes.data || [];
            if (!(readsRes.error && !hasRows(readsRes))) hrAnnouncementReads = readsRes.data || [];
            const banner = document.getElementById('hr-announcements-missing-banner');
            if (banner) banner.classList.toggle('hidden', !_announcementsTableMissing);
            renderAnnouncementBadgeExtra();
        }

// ── renderAnnouncementBadgeExtra (orig line 7411) ──
        function renderAnnouncementBadgeExtra() {
            if (typeof renderHRAnnouncementsSentList === 'function' && document.getElementById('hr-announcements-sent-list')) {
                renderHRAnnouncementsSentList();
            }
            renderAnnouncementBadge();
            if (document.getElementById('tab-content-announcements') && !document.getElementById('tab-content-announcements').classList.contains('hidden')) {
                renderEmployeeAnnouncementsList();
            }
        }

        // Announcement read-state is entirely server-side (hr_announcement_reads), unlike the
        // bell's local dismiss-tracking — so "unread" is always computed live, never stale.
        function getUnreadAnnouncementIds() {
            if (!activeEmail) return [];
            const myEmail = activeEmail.toLowerCase();
            const readIds = new Set(hrAnnouncementReads.filter(r => (r.employee_email || '').toLowerCase() === myEmail).map(r => String(r.announcement_id)));
            return hrAnnouncements.filter(a => !readIds.has(String(a.id))).map(a => a.id);
        }

        function renderAnnouncementBadge() {
            const n = getUnreadAnnouncementIds().length;
            [document.getElementById('announcements-badge-sidebar'), document.getElementById('announcements-badge-mobile')].forEach(b => {
                if (!b) return;
                b.textContent = n > 99 ? '99+' : n;
                b.style.display = n > 0 ? 'inline-block' : 'none';
            });
        }

        // Employee-facing Announcements tab — deliberately separate from the notification
        // bell (see checkForHRNotifications, which no longer calls addNotif for these): these
        // are persistent HR communications an employee should be able to browse and re-read,
        // not a transient alert that gets dismissed and disappears.
        function renderEmployeeAnnouncementsList() {
            const el = document.getElementById('announcements-list');
            if (!el) return;
            if (_announcementsTableMissing) {
                el.innerHTML = `<p class="text-center text-red-300 text-xs py-8">Announcements aren't available right now — ask your admin to check the Supabase setup.</p>`;
                return;
            }
            if (!hrAnnouncements.length) {
                el.innerHTML = `<p class="text-center text-[#4a5182] text-xs italic py-10">No announcements yet.</p>`;
                return;
            }
            const unreadIds = new Set(getUnreadAnnouncementIds().map(String));
            el.innerHTML = hrAnnouncements.map(a => {
                const isUnread = unreadIds.has(String(a.id));
                const dateLabel = new Date(a.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                const excerpt = (a.message || '').slice(0, 140) + ((a.message || '').length > 140 ? '…' : '');
                return `<div onclick="openAnnouncementDetail('${a.id}')" class="card glass-card rounded-2xl p-4 cursor-pointer transition hover:border-orange-500/30 ${isUnread ? 'border-l-2 border-l-orange-500' : ''}" style="border-left-width:${isUnread ? '3px' : '1px'}">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2 flex-wrap mb-1">
                                <i data-lucide="megaphone" class="w-3.5 h-3.5 text-orange-400 shrink-0"></i>
                                <h3 class="text-sm font-bold text-white break-words">${a.title}</h3>
                                ${a.category ? `<span class="text-[9px] font-bold uppercase tracking-wide text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded px-1.5 py-0.5 shrink-0">${a.category}</span>` : ''}
                                ${isUnread ? `<span class="text-[9px] font-bold uppercase tracking-wide text-white bg-orange-500 rounded-full px-2 py-0.5 shrink-0">New</span>` : ''}
                            </div>
                            <p class="text-xs text-gray-400 break-words">${excerpt}</p>
                            <p class="text-[10px] text-[#4a5182] mt-1.5">${dateLabel}</p>
                        </div>
                    </div>
                </div>`;
            }).join('');
            if (window.lucide) lucide.createIcons();
        }

        function openAnnouncementDetail(id) {
            const a = hrAnnouncements.find(x => String(x.id) === String(id));
            if (!a) return;
            const catEl = document.getElementById('announcement-detail-category');
            if (catEl) { catEl.textContent = a.category || ''; catEl.classList.toggle('hidden', !a.category); }
            const dateLabel = new Date(a.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            document.getElementById('announcement-detail-title').textContent = a.title;
            document.getElementById('announcement-detail-meta').textContent = `Sent ${dateLabel}${a.created_by ? ' · ' + a.created_by : ''}`;
            document.getElementById('announcement-detail-body').textContent = a.message || '';
            document.getElementById('announcement-detail-modal').classList.remove('hidden');
            markAnnouncementRead(a.id); // updates the badge + list itself once persisted (see renderAnnouncementBadgeExtra)
        }

        function closeAnnouncementDetail() {
            document.getElementById('announcement-detail-modal')?.classList.add('hidden');
        }

// ── markAnnouncementRead (orig line 7443) ──
        async function markAnnouncementRead(announcementId) {
            if (!announcementId || !activeEmail) return;
            const already = hrAnnouncementReads.some(r => String(r.announcement_id) === String(announcementId) && (r.employee_email || '').toLowerCase() === activeEmail.toLowerCase());
            if (already) return;
            const readRow = { announcement_id: announcementId, employee_email: activeEmail, read_at: new Date().toISOString() };
            hrAnnouncementReads.push(readRow); // optimistic, so HR's count updates immediately for this session
            const { error } = await dbInstance.from('hr_announcement_reads').insert(readRow);
            if (error) console.warn('Could not persist announcement read receipt:', error.message);
            renderAnnouncementBadgeExtra();
        }

// ── checkForHRNotifications (orig line 7473) ──
        async function checkForHRNotifications() {
            if (!activeEmail || !activeUser) return;
            // Throttled well below the 4s sync tick — this does a real Supabase round-trip
            // (loadHRData), unlike the task check above which just reads already-loaded arrays.
            const now = Date.now();
            if (now - _lastHRNotifPoll < 20000) return;
            _lastHRNotifPoll = now;

            const hadPayslipBaseline = localStorage.getItem(`be_known_payslips_${activeEmail}`) !== null;
            const hadLeaveBaseline = localStorage.getItem(`be_known_leave_statuses_${activeEmail}`) !== null;
            const hadAnnouncementBaseline = localStorage.getItem(`be_known_announcements_${activeEmail}`) !== null;
            loadHRNotifBaseline();

            // Company announcements: not gated on having an hr_employees record — everyone
            // logged in should get these, even before HR data resolves. Deliberately NOT added
            // to the notification bell (addNotif) — Announcements are their own persistent tab
            // now (see renderEmployeeAnnouncementsList), not a dismiss-and-disappear alert. A
            // native OS push is still fine here since that's outside the in-app Notifications list.
            let changed = false;
            try {
                await loadAnnouncements();
                hrAnnouncements.forEach(a => {
                    if (!_lastKnownAnnouncementIds.has(a.id)) {
                        if (hadAnnouncementBaseline) {
                            sendBrowserNotif('📢 ' + a.title, a.message || '');
                        }
                        _lastKnownAnnouncementIds.add(a.id);
                        changed = true;
                    }
                });
            } catch (e) { /* announcements table may not exist yet — don't block the rest */ }

            try { await loadMyHRData(); } catch (e) { if (changed) saveHRNotifBaseline(); return; }
            const me = myHREmployeeRecord();
            if (!me) { if (changed) saveHRNotifBaseline(); return; }

            runCelebrationQueue(me);
            checkDeptLeaveNotifications();

            // New payslip: any published row for me not seen before. First-ever check on this
            // device just records the baseline — otherwise every existing payslip would fire a
            // notification at once the first time someone opens the app on a new device.
            hrPayroll.filter(p => p.employee_id === me.id && p.published === true).forEach(p => {
                if (!_lastKnownPayslipIds.has(p.id)) {
                    if (hadPayslipBaseline) {
                        const monthLabel = (() => { try { const [y,m] = p.month.split('-').map(Number); return new Date(y, m-1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); } catch(e) { return p.month; } })();
                        // In-app bell only (see notifMeta's 'payslip' case + initMyPayslips'
                        // NEW marker) — no sendBrowserNotif here, per spec: "Do not use
                        // browser-native notifications" for this specific alert.
                        addNotif('payslip', `Your payslip for ${monthLabel} is now available.`, null, p.id);
                    }
                    _lastKnownPayslipIds.add(p.id);
                    changed = true;
                }
            });

            // Leave approved/rejected: status transition on one of my own requests.
            hrLeaveRequests.filter(r => r.employee_id === me.id).forEach(r => {
                const prev = _lastKnownLeaveStatuses[r.id];
                if (prev !== r.status) {
                    if (hadLeaveBaseline && prev === 'pending' && (r.status === 'approved' || r.status === 'rejected')) {
                        const dateLabel = r.start_date === r.end_date
                            ? new Date(r.start_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long' })
                            : `${r.start_date} to ${r.end_date}`;
                        addNotif(r.status === 'approved' ? 'leave_approved' : 'leave_rejected',
                            `Your leave request for ${dateLabel} has been ${r.status}.`, null, r.id);
                        sendBrowserNotif(r.status === 'approved' ? 'Leave Approved' : 'Leave Rejected',
                            `Your leave request for ${dateLabel} has been ${r.status}.`);
                    }
                    _lastKnownLeaveStatuses[r.id] = r.status;
                    changed = true;
                }
            });

            if (changed) saveHRNotifBaseline();
        }

// ── requestBrowserNotifPermission (orig line 7545) ──
        async function requestBrowserNotifPermission() {
            if ('Notification' in window && Notification.permission === 'default') {
                await Notification.requestPermission();
            }
        }

// ── sendBrowserNotif (orig line 7550) ──
        function sendBrowserNotif(title, body) {
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            new Notification(title, { body, icon: 'Broken English Final Logo-02 (1).png' });
        }

// ── hrParseRoles (orig line 7591) ──
        function hrParseRoles(departmentStr) {
            return (departmentStr || '').split(',').map(s => s.trim()).filter(Boolean);
        }

// ── hrJoinRoles (orig line 7594) ──
        function hrJoinRoles(rolesArray) {
            return (rolesArray || []).join(', ');
        }

// ── hrStripLevel (orig line 7601) ──
        function hrStripLevel(roleStr) {
            for (const lvl of HR_LEVELS) {
                if (roleStr.startsWith(lvl + ' ')) return { level: lvl, role: roleStr.slice(lvl.length + 1) };
            }
            return { level: '', role: roleStr };
        }

// ── hrRoleInfo (orig line 7610) ──
        function hrRoleInfo(e) {
            const roles = hrParseRoles(e?.department);
            if (!roles.length) return { level: '', primary: '', additional: [] };
            const { level, role } = hrStripLevel(roles[0]);
            return { level, primary: role, additional: roles.slice(1) };
        }

// ── hrRoleDisplay (orig line 7616) ──
        function hrRoleDisplay(e) {
            const info = hrRoleInfo(e);
            if (!info.primary) return e?.designation || '—';
            return (info.level ? info.level + ' ' : '') + info.primary;
        }

// ── Flexible multi-range working hours (Trainer/Coach) ──
// A Trainer/Coach's working hours are not always one continuous block — a part-timer might
// work 10:00–12:00, 14:00–16:00, 18:00–19:00 in the same day. Stored as JSON text in
// pt_time_ranges (hr_employees and trainers both), e.g. '[{"start":"10:00","end":"12:00"}, …]',
// rather than the old single pt_time_start/pt_time_end pair, which could only ever represent
// one range. Those two legacy columns are left in the schema and still read as a fallback
// below, so employee records saved before this feature existed still display correctly — new
// saves write pt_time_ranges only (see saveHREmployee in hr.html). Shared here (not
// duplicated per page) so index.html, hr.html, and academics.html all resolve/display working
// hours identically. This is entirely separate from "My Availability" (trainer_slots) — see
// the comments there; working hours is the general schedule template, availability is which
// specific date/time slots the trainer has actually opened up for booking.
function hrGetWorkingHourRanges(emp) {
    if (!emp) return [];
    if (emp.pt_time_ranges) {
        try {
            const parsed = JSON.parse(emp.pt_time_ranges);
            if (Array.isArray(parsed)) return parsed.filter(r => r && r.start && r.end);
        } catch (e) { /* malformed — fall through to the legacy single-range fields below */ }
    }
    if (emp.pt_time_start && emp.pt_time_end) return [{ start: emp.pt_time_start, end: emp.pt_time_end }];
    return [];
}
// Minutes between "HH:MM" strings — negative/zero for an invalid or empty range, so callers
// can filter those out without a separate validity check.
function hrTimeRangeMinutes(r) {
    if (!r || !r.start || !r.end) return 0;
    const [sh, sm] = r.start.split(':').map(Number);
    const [eh, em] = r.end.split(':').map(Number);
    if ([sh, sm, eh, em].some(n => Number.isNaN(n))) return 0;
    return (eh * 60 + em) - (sh * 60 + sm);
}
function hrTotalWorkingHours(ranges) {
    const mins = (ranges || []).reduce((sum, r) => sum + Math.max(0, hrTimeRangeMinutes(r)), 0);
    return mins / 60;
}
function hrFormatTotalHours(hours) {
    return (Number.isInteger(hours) ? String(hours) : hours.toFixed(1)) + 'h';
}
// Multi-line display string for hrProfileField(..., true) — "Not Set" (not blank, not "0h")
// when the trainer genuinely has no working hours configured yet, per spec.
function hrFormatWorkingHours(emp) {
    const ranges = hrGetWorkingHourRanges(emp);
    if (!ranges.length) return 'Not Set';
    const lines = ranges.map(r => `${r.start}–${r.end}`);
    lines.push(`Total: ${hrFormatTotalHours(hrTotalWorkingHours(ranges))}`);
    return lines.join('\n');
}

// ── hrSeedDefaultLeaveBalances (orig line 7636) ──
        async function hrSeedDefaultLeaveBalances(employeeId) {
            const rows = HR_LEAVE_TYPES.filter(t => !HR_UNLIMITED_LEAVE_TYPES.includes(t)).map(t => ({
                employee_id: employeeId, leave_type: t, allotted: HR_DEFAULT_LEAVE_ALLOCATION[t] || 0, used: 0
            }));
            if (!rows.length) return;
            try { await dbInstance.from('hr_leave_balances').insert(rows); }
            catch (e) { console.warn('Could not seed default leave balances:', e.message); }
        }

// ── hrComputeClockInStatus (orig line 7657) ──
        function hrComputeClockInStatus(whenIso) {
            const d = new Date(whenIso);
            const hour = d.getHours() + d.getMinutes() / 60;
            return hour > HR_LATE_AFTER_HOUR ? 'late' : 'present';
        }

// ── hrAttStatusLabel (orig line 7665) ──
        function hrAttStatusLabel(status) {
            return ({
                present: 'Present', late: 'Present · Late', afternoon: 'Present · Afternoon Login',
                half_day: 'Present · Half Day', wfh: 'Present · WFH', absent: 'Absent',
                on_leave: 'Leave', holiday: 'Holiday'
            })[status] || 'Not Marked';
        }

// ── hrPortalLogFor (orig line 7912) ──
        function hrPortalLogFor(employee, dateStr) {
            if (!employee || !employee.portal_email) return null;
            return (window._hrAttendanceLogsCache || []).find(l => (l.employee_email || '').toLowerCase() === employee.portal_email && l.log_date === dateStr);
        }

// ── hrEmpName (orig line 7949) ──
        function hrEmpName(id) {
            const e = hrEmployees.find(x => x.id === id);
            return e ? e.full_name : '—';
        }

// ── hrFetchAndApplyMyPhoto (orig line 7959) ──
// ============================================================================
// SHARED CURRENT-USER PROFILE LOADER — the one source of truth for the logged-in
// user's own hr_employees record (name, designation, photo), replacing what used
// to be three separate near-identical queries: hrFetchAndApplyMyPhoto's own fetch,
// checkAcademicAccess's own fetch (index.html), and academics.html's own fetch.
// All three now call this one function instead. Always looked up by portal_email
// (falling back to full_name only when no portal email is linked yet) — never by
// a hardcoded name→photo map, so a name change or two similarly-named employees
// can't cross-wire anyone's photo.
//
// Works from any of the three pages without them needing to agree on variable
// names: resolves the current identity from whichever of activeEmail/activeUser
// (index.html, hr.html) or currentUser.username/.name (academics.html) actually
// exists on the page it's running on, and the Supabase client from whichever of
// dbInstance/mediaHrDB is defined — both point at the same project.
//
// Memoized after the first successful fetch, so navigating between tabs/pages
// (Pipeline → My Profile → Pipeline, switching Academic tabs, etc.) never
// re-queries and never "loses" the already-loaded photo. Pass true to force a
// fresh fetch — e.g. right after the user changes their own profile photo.
// CRITICAL: the cache is keyed by WHOSE profile it holds (the resolved email at fetch
// time), not just "is something cached". switchToAccount() (this file, used by both
// index.html and hr.html) and hr.html's own admin-to-admin switch both change
// activeEmail/activeUser and re-render WITHOUT a page reload — a real, already-shipped
// path where a module-level cache with no identity check would keep serving the PREVIOUS
// account's name/photo/designation to the newly switched-in account. Every read below
// re-resolves the current identity and compares it against which identity the cache
// actually belongs to; a mismatch is treated as "no cache", full stop, regardless of
// forceRefresh. This is what makes the cache self-invalidating on account switch instead
// of depending on every switch call site remembering to bust it by hand.
let _currentUserProfileCache = null;
let _currentUserProfileCacheKey = null;
let _currentUserProfilePromise = null;
let _currentUserProfilePromiseKey = null;
function _resolveCurrentUserIdentity() {
    const email = (typeof activeEmail !== 'undefined' && activeEmail) || (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || null;
    const name = (typeof activeUser !== 'undefined' && activeUser) || (typeof currentUser !== 'undefined' && currentUser && currentUser.name) || null;
    const db = (typeof dbInstance !== 'undefined' && dbInstance) || (typeof mediaHrDB !== 'undefined' && mediaHrDB) || null;
    return { email, name, db };
}
// Call explicitly on logout, in addition to the automatic key-mismatch check above — belt
// and suspenders, and makes "no stale profile can survive a logout" true even if some
// future caller reads the module variables directly instead of through this function.
function clearCurrentUserProfileCache() {
    _currentUserProfileCache = null;
    _currentUserProfileCacheKey = null;
    _currentUserProfilePromise = null;
    _currentUserProfilePromiseKey = null;
}
async function loadCurrentUserProfile(forceRefresh) {
    const { email, name, db } = _resolveCurrentUserIdentity();
    const key = (email || '').trim().toLowerCase();
    // Cache/in-flight request belongs to a DIFFERENT identity than the one currently
    // active — e.g. an account switch happened since the last call. Never return or reuse
    // it, no matter what forceRefresh says.
    if (_currentUserProfileCacheKey && _currentUserProfileCacheKey !== key) _currentUserProfileCache = null;
    if (_currentUserProfilePromiseKey && _currentUserProfilePromiseKey !== key) _currentUserProfilePromise = null;
    if (_currentUserProfileCache && !forceRefresh) return _currentUserProfileCache;
    if (_currentUserProfilePromise && !forceRefresh) return _currentUserProfilePromise;
    _currentUserProfilePromiseKey = key;
    _currentUserProfilePromise = (async () => {
        if (!email || !db) { _currentUserProfileCache = null; _currentUserProfileCacheKey = key; return null; }
        try {
            // select('*') rather than naming photo_base64 explicitly — on a database where
            // that column hasn't been added yet, naming it here makes the whole query error
            // out (PGRST 42703), which silently broke photo sync for every employee, not
            // just ones with an uploaded photo. select('*') degrades gracefully instead.
            let { data, error } = await db.from('hr_employees').select('*').eq('portal_email', key).limit(1);
            if (error) { console.warn('loadCurrentUserProfile: lookup by email failed:', error.message); return null; }
            if (!data || !data[0]) {
                // Fallback: no HR record linked by email — try matching by name instead, for
                // an employee whose HR record was never given a portal email. Still a real
                // identifying-field lookup per employee, never a hardcoded name→photo map.
                const byName = await db.from('hr_employees').select('*').eq('full_name', name).limit(1);
                if (!byName.error && byName.data && byName.data[0]) data = byName.data;
            }
            if (!data || !data[0]) { console.warn(`loadCurrentUserProfile: no hr_employees record found for "${name}" (${email}). Profile can't sync until this login is linked to an employee record.`); _currentUserProfileCache = null; _currentUserProfileCacheKey = key; return null; }
            const rec = data[0];
            const photoUrl = rec.photo_base64 || (rec.photo_url ? hrConvertDriveUrl(rec.photo_url) : null);
            const title = (typeof hrRoleDisplay === 'function') ? hrRoleDisplay(rec) : (rec.designation || null);
            // Re-check the identity is STILL the one this fetch was for — if a second switch
            // happened while this query was in flight, this result is now stale too; don't
            // let it win the cache.
            const stillCurrent = _resolveCurrentUserIdentity().email && _resolveCurrentUserIdentity().email.trim().toLowerCase() === key;
            const result = { employeeId: rec.id, name: rec.full_name || name || '', designation: (title && title !== '—') ? title : null, photoUrl, raw: rec };
            if (stillCurrent) { _currentUserProfileCache = result; _currentUserProfileCacheKey = key; }
            return result;
        } catch (e) {
            console.warn('loadCurrentUserProfile failed:', e.message);
            return null;
        } finally {
            if (_currentUserProfilePromiseKey === key) _currentUserProfilePromise = null;
        }
    })();
    return _currentUserProfilePromise;
}

// Applies a loaded profile to every known avatar/name/designation element across all
// three pages — checks each element's existence first, so it's safe to call from any
// page; only the elements that page actually has get updated. Uses hrAvatarHTML() for
// the actual <img>/fallback markup — the same function, not a second hand-written
// version — so a broken/missing photo always falls back to initials, never a broken-
// image icon or a blank circle.
function applyCurrentUserProfileToDOM(profile) {
    if (!profile) return;
    if (typeof hrAvatarHTML === 'function') {
        const sidebarAvatar = document.getElementById('sidebar-user-avatar');
        if (sidebarAvatar) sidebarAvatar.innerHTML = hrAvatarHTML(profile.raw, 28);
        const sidebarAvatarMobile = document.getElementById('sidebar-user-avatar-mobile');
        if (sidebarAvatarMobile) sidebarAvatarMobile.innerHTML = hrAvatarHTML(profile.raw, 26);
    }
    if (profile.designation) {
        // user-role-badge (index.html's top sidebar identity block, under "Media Suite") used
        // to be set separately in launchSession() as `${activeRole} scope` — generic text like
        // "employee scope" instead of the person's actual HR designation, and inconsistent
        // with the Academic module's own sidebar header. Added here so it's set by the same
        // one shared profile write every other designation display already goes through,
        // instead of a second, differently-sourced value racing with this one.
        ['sidebar-user-role', 'sidebar-user-role-mobile', 'hr-active-role-display', 'hr-topbar-role', 'user-role-badge', 'hr-role-badge'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = profile.designation;
        });
    }
    // "My Profile Photo" widget on the My Settings page (index.html). onerror is attached
    // BEFORE src is set — the other way around is a real race: for an already-cached or
    // instantly-failing image, the browser can fire the error before the next line of JS
    // runs, so an onerror assigned after src can miss it and leave a broken-image icon with
    // nothing to catch it. Falls back to the initials span already sitting underneath this
    // img in the DOM (see my-avatar-wrap's markup) — never a bare broken-image icon.
    const img = document.getElementById('my-avatar-img');
    if (img && profile.photoUrl) {
        img.onerror = () => { console.warn('my-avatar-img failed to load:', profile.photoUrl); img.classList.add('hidden'); };
        img.src = profile.photoUrl;
        img.classList.remove('hidden');
    }
}

// Kept as the existing call name every page already uses (hrFetchAndApplyMyPhoto()) so
// nothing calling it needs to change — now backed by the one shared loader above instead
// of running its own separate query.
async function hrFetchAndApplyMyPhoto() {
    const profile = await loadCurrentUserProfile();
    applyCurrentUserProfileToDOM(profile);
}

// ── acadSyncTrainersFromHR (orig line 8306) ──
async function acadSyncTrainersFromHR(){
  if (typeof dbInstance === 'undefined' || !dbInstance) return;
  try {
    // select('*') rather than an explicit column list — on an acadDB/hr_employees database
    // where the newer Coach-scheduling columns haven't been added yet (see
    // coach-scheduling-schema.sql), naming them here would make the WHOLE query fail; select('*')
    // degrades gracefully instead, the same pattern hrFetchAndApplyMyPhoto already uses.
    const { data: eduEmployees, error } = await dbInstance.from('hr_employees').select('*').eq('division', 'education');
    if (error || !eduEmployees) return;
    const { data: existingTrainers } = await acadDB.from('trainers').select('id,name');
    const existingByName = new Map((existingTrainers || []).map(t => [String(t.name).trim().toLowerCase(), t]));
    for (const emp of eduEmployees) {
      if (!emp.full_name) continue;
      const key = emp.full_name.trim().toLowerCase();
      // Mirror HR's own Add/Edit Employee form convention: an unset employment_status
      // defaults to "Active" there, so only an EXPLICIT 'inactive'/'exited' should sync
      // as inactive — otherwise employees created before this field existed get wrongly
      // hidden everywhere Academic filters on trainers.status = 'active'.
      const status = (emp.employment_status === 'inactive' || emp.employment_status === 'exited') ? 'inactive' : 'active';
      // Coach scheduling fields, mirrored straight from the HR record — HR (via Add/Edit
      // Employee) is the single source of truth for these; this sync only ever reads FROM
      // hr_employees and writes INTO acadDB.trainers, never the other direction.
      const coachFields = {
        type: emp.employment_type === 'part_time' ? 'pt' : 'ft',
        teachable_courses: emp.teachable_courses || null,
        pt_max_classes_per_day: emp.pt_max_classes_per_day || null,
        pt_max_hours: emp.pt_max_hours || null,
        pt_available_days: emp.pt_available_days || null,
        pt_time_start: emp.pt_time_start || null,
        pt_time_end: emp.pt_time_end || null,
        pt_time_ranges: emp.pt_time_ranges || null,
        // Lets academics.html's own leave/availability lookups match a trainer row reliably
        // (leaves.username is the person's login — an email when they signed in via the
        // Media Suite SSO bridge) instead of a fuzzy name match.
        portal_email: emp.portal_email || null,
      };
      const existing = existingByName.get(key);
      if (existing) {
        await acadDB.from('trainers').update({ status, ...coachFields }).eq('id', existing.id);
      } else {
        await acadDB.from('trainers').insert({ name: emp.full_name.trim(), status, ...coachFields });
      }
    }
  } catch (e) {
    console.warn('Trainer sync from HR failed:', e.message);
  }
}

// ── hrConvertDriveUrl (orig line 8832) ──
        function hrConvertDriveUrl(url) {
            if (!url) return url;
            url = url.trim();
            if (!/drive\.google\.com/.test(url)) return url; // not a Drive link — leave as-is
            if (/drive\.google\.com\/thumbnail\?id=/.test(url)) return url; // already converted
            const patterns = [
                /\/file\/d\/([a-zA-Z0-9_-]{10,})/,   // .../file/d/FILE_ID/view
                /[?&]id=([a-zA-Z0-9_-]{10,})/,        // .../uc?id=FILE_ID or /open?id=FILE_ID
                /\/d\/([a-zA-Z0-9_-]{10,})/           // .../d/FILE_ID
            ];
            for (const re of patterns) {
                const m = url.match(re);
                if (m && m[1]) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`;
            }
            return url; // couldn't parse a file ID — leave as-is, fallback avatar will catch a bad load
        }

// ── hrAvatarHTML (orig line 8850) ──
        function hrAvatarHTML(nameOrEmp, sizePx) {
            sizePx = sizePx || 28;
            const name = typeof nameOrEmp === 'string' ? nameOrEmp : (nameOrEmp?.full_name || '');
            const base64Photo = typeof nameOrEmp === 'object' ? nameOrEmp?.photo_base64 : null;
            const rawPhotoUrl = typeof nameOrEmp === 'object' ? nameOrEmp?.photo_url : null;
            // Uploaded (base64) photo always wins over a legacy URL — Supabase is the single
            // source of truth either way, but base64 doesn't depend on an external host.
            const photoUrl = base64Photo || (rawPhotoUrl ? hrConvertDriveUrl(rawPhotoUrl) : null);
            const initials = name.split(' ').filter(Boolean).slice(0,2).map(w => w[0].toUpperCase()).join('') || '?';
            const style = `width:${sizePx}px;height:${sizePx}px;border-radius:50%;flex-shrink:0;object-fit:cover;font-size:${Math.round(sizePx*0.38)}px`;
            return photoUrl
                ? `<img src="${photoUrl}" alt="${name}" style="${style}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'hr-avatar-fallback',style:'${style};display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff6b06,#f9182f);color:#fff;font-weight:700',textContent:'${initials}'}))">`
                : `<div style="${style};display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff6b06,#f9182f);color:#fff;font-weight:700">${initials}</div>`;
        }

// ── hrAvatarForEmployeeId (orig line 8864) ──
        function hrAvatarForEmployeeId(id, sizePx) {
            const e = hrEmployees.find(x => x.id === id);
            return hrAvatarHTML(e || hrEmpName(id), sizePx);
        }

// ── hrIsWeeklyOff (orig line 8870) ──
        function hrIsWeeklyOff(dayOfWeek) {
            if (dayOfWeek === 0) return !!hrCompanySettings.weekly_off_sunday;
            if (dayOfWeek === 6) return !!hrCompanySettings.weekly_off_saturday;
            return false;
        }

// ── hrProfileField (orig line 9456) ──
        function hrProfileField(label, value, block = false) {
            return `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                <div class="hr-field-label" style="margin-bottom:2px">${label}</div>
                <div class="text-sm ${block?'whitespace-pre-wrap':''} text-[#e6e9f5]">${value || '—'}</div>
            </div>`;
        }

// Approved leave (any type, including 'Work From Home' — it's one of HR_LEAVE_TYPES, not a
// separate system) covering dateStr for this employee — shared by hrAttDayCode() and
// hrCalculatePayrollForMonth() below so the calendar grid and the Present/Absent/payroll
// figures can never disagree about which days are covered by an approved leave.
function hrApprovedLeaveFor(employeeId, dateStr) {
    return hrLeaveRequests.find(r => r.employee_id === employeeId && r.status === 'approved' && r.start_date <= dateStr && r.end_date >= dateStr) || null;
}
// A structured, HR-created hr_official_events row covering dateStr and this employee's
// division (or applies_to='all') — e.g. Onam Celebration, a company-wide paid event day
// where normal clock-in isn't required. Deliberately NOT derived from announcement text in
// any way — HR must explicitly create this record; scanning "Onam Celebration" out of an
// announcement's title and guessing at attendance rules would be unsafe (see spec item 8),
// so there is no code path anywhere that reads hr_announcements for this purpose.
function hrOfficialEventFor(employee, dateStr) {
    return hrOfficialEvents.find(ev => ev.event_date === dateStr && (ev.applies_to === 'all' || ev.applies_to === employee.division)) || null;
}
// ── hrAttDayCode (orig line 9555) ──
        function hrAttDayCode(employee, dateStr, dayOfWeek) {
            if (employee.joining_date && dateStr < employee.joining_date) return null; // before joining — blank
            if (hrIsHoliday(dateStr)) return 'H';
            const rec = hrAttendance.find(a => a.employee_id === employee.id && a.att_date === dateStr);
            if (!rec) {
                // No hr_attendance row for this date — before assuming unmarked, check the raw
                // clock-in log directly (same source the Dashboard's "Today's Workforce"/"Present
                // Today" already trust). Covers a sync that failed or hasn't caught up yet, so
                // the Report can't disagree with what the employee's own clock-in screen shows.
                const portalLog = hrPortalLogFor(employee, dateStr);
                if (portalLog && portalLog.log_in_time) return hrComputeClockInStatus(portalLog.log_in_time) === 'late' ? 'L' : 'P';
            }
            if (rec) {
                if (rec.status === 'holiday') return 'H';
                if (rec.status === 'absent') {
                    // A persisted 'absent' row (e.g. manually marked by HR before this event
                    // existed, or before this employee's leave was approved) must not outrank
                    // a later-created Official Event — otherwise the event only ever "works"
                    // for employees who happen to have no hr_attendance row at all for that
                    // date, which is exactly the reported bug: existing employees who already
                    // had an explicit Absent row stayed stuck on 'A' while brand-new employees
                    // (never had one) correctly fell through to OE. This is the live
                    // reconciliation itself — no separate backfill write needed, and running
                    // it any number of times (reload, edit event, delete event) can never
                    // create a duplicate row since nothing is ever written here.
                    const event = hrOfficialEventFor(employee, dateStr);
                    if (event && !event.clock_in_required) return 'OE';
                    return 'A';
                }
                if (rec.status === 'late') return 'L';
                if (rec.status === 'afternoon') return 'AL'; // Present · Afternoon Login (still counts as Present — see HR_PRESENT_STATUSES)
                if (rec.status === 'on_leave') {
                    // Unpaid leave gets its own code (UL) — it used to render identically to
                    // Absent ('A'), making it impossible to tell "took approved unpaid leave"
                    // apart from "didn't show up, nothing filed" on the grid.
                    const leave = hrApprovedLeaveFor(employee.id, dateStr);
                    if (leave && leave.leave_type === 'Work From Home') return 'WFH';
                    return (leave && leave.leave_type === 'Unpaid Leave') ? 'UL' : 'PL';
                }
                return 'P'; // present, half_day, wfh
            }
            // No hr_attendance row AT ALL for this date (the actual "blank cell" bug this fixes)
            // — an approved Leave/WFH request still covering the date is real, existing data
            // this employee never had a chance to clock in around, and must resolve the same way
            // it would if a properly-filed on_leave attendance row existed (above) — never fall
            // through to Weekly Off/Absent just because nobody filed the row. Checked before
            // Weekly Off/Holiday-adjacent fallbacks per the requested priority order.
            const leave = hrApprovedLeaveFor(employee.id, dateStr);
            if (leave) {
                if (leave.leave_type === 'Work From Home') return 'WFH';
                return leave.leave_type === 'Unpaid Leave' ? 'UL' : 'PL';
            }
            // Official Event / Paid Special Day (e.g. Onam Celebration) — a structured,
            // HR-created hr_official_events row, never inferred from announcement text (see
            // hrOfficialEventFor's own comment). Only overrides the Absent fallback when the
            // event doesn't require clock-in; an event marked Clock In Required = Yes changes
            // nothing here and normal attendance rules keep applying, per spec example B.
            const event = hrOfficialEventFor(employee, dateStr);
            if (event && !event.clock_in_required) return 'OE';
            if (hrIsWeeklyOff(dayOfWeek)) return 'WO'; // configurable weekly off, not otherwise marked
            const today = new Date().toISOString().slice(0,10);
            if (dateStr >= today) return null; // today (still an open attendance day) or future — blank, never auto-Absent
            // Genuinely past, working day, no clock-in, no approved leave/WFH/official event,
            // not a holiday or weekly off — this is the one case that used to stay an
            // "unexplained blank" cell forever. Resolves to Absent, same code manually-marked
            // absences already use.
            return 'A';
        }

// ── hrComputeLeaveUsed (orig line 9776) ──
        function hrComputeLeaveUsed(employeeId, leaveType) {
            return hrLeaveRequests
                .filter(r => r.employee_id === employeeId && r.leave_type === leaveType && r.status === 'approved')
                .reduce((sum, r) => sum + (r.days || 0), 0);
        }

// ── hrGetEffectiveSalary (orig line 10316) ──
        function hrGetEffectiveSalary(employeeId, monthStr) {
            const monthEnd = new Date(monthStr + '-01'); monthEnd.setMonth(monthEnd.getMonth() + 1); monthEnd.setDate(0);
            const monthEndStr = monthEnd.toISOString().slice(0,10);
            const history = hrSalaryHistory.filter(s => s.employee_id === employeeId && s.effective_date <= monthEndStr).sort((a,b) => b.effective_date.localeCompare(a.effective_date));
            if (history.length) return history[0].salary;
            const e = hrEmployees.find(x => x.id === employeeId);
            return e?.monthly_salary || 0;
        }

// ── hrIsHoliday (orig line 10325) ──
        function hrIsHoliday(dateStr) {
            return hrHolidays.some(h => h.holiday_date === dateStr);
        }

        // ── SINGLE source of truth for "attendance %" on any one date — used by the HR
        // Dashboard's workforce-marked donut, the daily Attendance page's summary card, and
        // the Monthly Attendance Overview's per-day row, so none of them can ever disagree.
        //   Applicable = active employees, already joined by this date, MINUS anyone on a
        //     configured weekly-off or company holiday for this specific date (so those days
        //     never drag the percentage down — they're excluded from both sides of the ratio,
        //     not counted as absent).
        //   Present = employees in Applicable who currently have a Present-family
        //     hr_attendance status (see HR_PRESENT_STATUSES) OR a raw clock-in log for this
        //     date, counted as a Set of employee ids — so even if two attendance rows existed
        //     for the same person/date, they'd still only ever count once.
        //   Everyone else in Applicable (marked Absent, on leave, or simply never marked at
        //     all) counts toward the denominator but not the numerator — an employee nobody
        //     has gotten around to marking yet is not silently dropped from the calculation.
        function hrComputeAttendancePctForDate(dateStr) {
            const dow = new Date(dateStr + 'T00:00:00').getDay();
            const applicable = hrEmployees.filter(e =>
                e.employment_status === 'active' &&
                (!e.joining_date || dateStr >= e.joining_date) &&
                !hrIsWeeklyOff(dow) &&
                !hrIsHoliday(dateStr)
            );
            const presentIds = new Set();
            applicable.forEach(e => {
                const rec = hrAttendance.find(a => a.employee_id === e.id && a.att_date === dateStr);
                const isPresent = rec ? HR_PRESENT_STATUSES.includes(rec.status) : !!hrPortalLogFor(e, dateStr);
                if (isPresent) presentIds.add(e.id);
            });
            return {
                applicable: applicable.length,
                present: presentIds.size,
                pct: applicable.length > 0 ? Math.round((presentIds.size / applicable.length) * 100) : null
            };
        }

// ── hrCalculatePayrollForMonth (orig line 10345) ──
        function hrCalculatePayrollForMonth(employeeId, monthStr) {
            const [y, m] = monthStr.split('-').map(Number);
            const daysInMonth = new Date(y, m, 0).getDate();
            const salary = hrGetEffectiveSalary(employeeId, monthStr);
            const dailySalary = daysInMonth ? salary / daysInMonth : 0;
            const todayStr = new Date().toISOString().slice(0,10);
            // "Basic = full salary, LOP is the only deduction" only works if every day in the
            // month is actually a day the employee was employed. A joining date partway through
            // the month means the days before it were never part of this job — without this,
            // they fell into "no record, not weekly-off/holiday → absent → LOP", which is a real
            // LOP (a disciplinary/attendance concept) blown up to cover a person who simply
            // wasn't hired yet. preJoiningDays tracks that separately, but still has to reduce
            // pay the same way LOP does — otherwise a employee joining on the 29th would be paid
            // their full month's salary for 2 days worked.
            const employee = hrEmployees.find(e => e.id === employeeId);
            const joiningDate = employee?.joining_date || null;
            // How much of the month has actually happened yet. A past month is fully elapsed;
            // a future month hasn't started; the current month is elapsed up to today.
            // THIS is what Basic gets prorated against below — not always the full month — so
            // checking payroll mid-month can't inflate pay for days that haven't occurred:
            // previously Basic assumed the FULL month's salary regardless, while LOP only ever
            // covered the days already evaluated, so a sparse mid-month check (e.g. 2 Present
            // days out of 10 elapsed, in a 31-day month) paid out for the other 21 days that
            // simply hadn't happened yet, instead of correctly excluding them until they do.
            const monthPrefix = monthStr, todayMonthPrefix = todayStr.slice(0, 7);
            const elapsedDays = monthPrefix < todayMonthPrefix ? daysInMonth
                : monthPrefix > todayMonthPrefix ? 0
                : Number(todayStr.slice(8, 10));
            // eligibleLeaveDays accumulates every approved paid-type leave day seen in the
            // loop below; it's capped to HR_MONTHLY_PAID_LEAVE_DAYS AFTER the loop (paidLeaveDays)
            // with the remainder folded into LOP (excessLeaveDays) — see below the loop.
            let eligibleLeaveDays = 0, unpaidLeaveDays = 0, absentDays = 0, holidayDays = 0, weeklyOffDays = 0, presentDays = 0, halfDayDays = 0, preJoiningDays = 0, officialEventDays = 0;

            for (let d = 1; d <= daysInMonth; d++) {
                const dateStr = `${monthStr}-${String(d).padStart(2,'0')}`;
                if (dateStr > todayStr) continue; // hasn't happened yet — excluded entirely
                if (joiningDate && dateStr < joiningDate) { preJoiningDays++; continue; } // not yet hired
                const dow = new Date(y, m - 1, d).getDay();
                if (hrIsHoliday(dateStr)) { holidayDays++; continue; }
                const rec = hrAttendance.find(a => a.employee_id === employeeId && a.att_date === dateStr);
                // Same fallback as hrAttDayCode: a day with no hr_attendance row but a real
                // clock-in log counts as Present, not Absent/LOP — a failed/lagging sync must
                // never cost an employee pay for a day they actually worked.
                if (!rec) {
                    const portalLog = hrPortalLogFor(employee, dateStr);
                    if (portalLog && portalLog.log_in_time) { presentDays++; continue; }
                }
                if (rec) {
                    if (rec.status === 'holiday') { holidayDays++; continue; }
                    if (rec.status === 'absent') {
                        // Same reconciliation as hrAttDayCode: a persisted Absent row must not
                        // outrank an Official Event created (or edited) afterward, or payroll
                        // would keep LOP-deducting an employee for a paid company event day
                        // just because they already had an explicit row from before the event
                        // existed.
                        const event = hrOfficialEventFor(employee, dateStr);
                        if (event && !event.clock_in_required) { officialEventDays++; continue; }
                        absentDays++; continue;
                    }
                    if (rec.status === 'on_leave') {
                        const leave = hrApprovedLeaveFor(employeeId, dateStr);
                        if (leave && leave.leave_type === 'Unpaid Leave') { unpaidLeaveDays++; continue; }
                        eligibleLeaveDays++; continue;
                    }
                    if (rec.status === 'half_day') { halfDayDays++; continue; }
                    presentDays++; continue; // present, late, wfh — all worked
                }
                // No hr_attendance row at all — an approved Leave/WFH request still covering
                // this date is real, existing data this employee never got an attendance row
                // filed for (the same gap hrAttDayCode() fixes for the calendar display) —
                // must resolve the same way a filed on_leave row would, not fall through to
                // Weekly Off/Absent(LOP) just because nobody filed it. Approved WFH counts as
                // presentDays (worked, paid) the same way an actual wfh-status attendance row
                // already would above — Leave (paid/unpaid) does not, same as everywhere else
                // in this function.
                const leave = hrApprovedLeaveFor(employeeId, dateStr);
                if (leave) {
                    if (leave.leave_type === 'Work From Home') { presentDays++; continue; }
                    if (leave.leave_type === 'Unpaid Leave') { unpaidLeaveDays++; continue; }
                    eligibleLeaveDays++; continue;
                }
                // Official Event / Paid Special Day — a paid, non-absence day by default (spec
                // item 12), tracked in its own bucket rather than folded into presentDays (no
                // work was actually done/clocked) or paidLeaveDays (nobody applied for leave) —
                // kept out of both lopDays and, deliberately, out of presentDays too, so it
                // shows up as its own line in the Workforce Report rather than silently
                // inflating "Present". Still paid (see payableDays below). Only applies when
                // clock-in isn't required, same as the calendar-code fallback above.
                const event = hrOfficialEventFor(employee, dateStr);
                if (event && !event.clock_in_required) { officialEventDays++; continue; }
                if (hrIsWeeklyOff(dow)) { weeklyOffDays++; continue; }
                // No record, no approved leave/WFH/official event, not a weekly-off, not a
                // holiday — genuinely unmarked/unworked → LOP. (dateStr === todayStr also lands
                // here if unmarked; unlike the calendar's own hrAttDayCode(), payroll has always
                // evaluated today as already elapsed once its own hour has passed — unchanged
                // here, this fix is only about the missing leave/WFH/event check, not payroll's
                // date-boundary rule.)
                absentDays++;
            }
            // Monthly paid-leave allowance: only the first HR_MONTHLY_PAID_LEAVE_DAYS approved
            // eligible-leave days in the month are paidLeaveDays; anything beyond that is
            // excessLeaveDays, which is LOP the same as Unpaid Leave — the employee took more
            // leave than the monthly allowance covers, regardless of which leave_type it was
            // filed under. Order doesn't matter for the deduction amount (every day in a month
            // has the same dailySalary), only the total count does.
            const paidLeaveDays = Math.min(eligibleLeaveDays, HR_MONTHLY_PAID_LEAVE_DAYS);
            const excessLeaveDays = Math.max(0, eligibleLeaveDays - HR_MONTHLY_PAID_LEAVE_DAYS);
            // LOP: every day that isn't Present, Approved Paid Leave (within the monthly
            // allowance), Official Event, Weekly Off, or Holiday — plus pre-joining days, which
            // reduce pay the same way but aren't "LOP" in the attendance-discipline sense, so
            // they're reported separately (see preJoiningDays).
            const lopDays = unpaidLeaveDays + absentDays + excessLeaveDays + halfDayDays * 0.5;
            const payableDays = presentDays + paidLeaveDays + officialEventDays + weeklyOffDays + holidayDays + halfDayDays * 0.5;
            const futureDays = daysInMonth - elapsedDays; // not yet occurred — never paid, never LOP'd, simply not evaluated
            // Basic is prorated to the elapsed portion of the month, not always the full salary
            // — for a month that's completely in the past this equals the full salary anyway
            // (elapsedDays === daysInMonth), so nothing changes for normal end-of-month payroll.
            const earnedBasic = Math.round(dailySalary * elapsedDays * 100) / 100;
            const leaveDeduction = Math.round(dailySalary * (lopDays + preJoiningDays) * 100) / 100;
            return { salary, daysInMonth, dailySalary, presentDays, paidLeaveDays, eligibleLeaveDays, excessLeaveDays, unpaidLeaveDays, absentDays, holidayDays, weeklyOffDays, halfDayDays, preJoiningDays, officialEventDays, elapsedDays, futureDays, lopDays, payableDays, earnedBasic, leaveDeduction };
        }

// ── hrProbationEndDate (orig line 10650) ──
        function hrProbationEndDate(employee) {
            if (!employee.joining_date || !employee.probation_months) return null;
            const d = new Date(employee.joining_date);
            d.setMonth(d.getMonth() + Number(employee.probation_months));
            return d.toISOString().slice(0,10);
        }

// ---------- Number → words (Indian numbering: Crore/Lakh/Thousand) ----------
// Used for the "Amount In Words" line on the payslip. Was only defined on index.html —
// moved here so hr.html (and any other page) can build the same payslip too.
        function _numToWordsIndian(num) {
            num = Math.round(num);
            if (num === 0) return 'Zero';
            const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
            const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
            const twoDigits = n => n < 20 ? ones[n] : tens[Math.floor(n/10)] + (n % 10 ? '-' + ones[n % 10] : '');
            const threeDigits = n => {
                let s = '';
                if (n >= 100) { s += ones[Math.floor(n/100)] + ' Hundred'; n %= 100; if (n) s += ' '; }
                if (n) s += twoDigits(n);
                return s;
            };
            let n = num, parts = [];
            const crore = Math.floor(n / 10000000); n %= 10000000;
            const lakh = Math.floor(n / 100000); n %= 100000;
            const thousand = Math.floor(n / 1000); n %= 1000;
            if (crore) parts.push(threeDigits(crore) + ' Crore');
            if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
            if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
            if (n) parts.push(threeDigits(n));
            return parts.join(' ');
        }
        function amountInWordsINR(amount) {
            return `Indian Rupee ${_numToWordsIndian(Math.abs(amount))} Only`;
        }

// Black-text "Broken English" logo for the payslip PDF, embedded inline as a data URL rather
// than fetched at runtime — see the original index.html comment this was copied from for why
// (relative-path/CORS failure class, plus jsPDF needing an already-downscaled bitmap).
        const PAYSLIP_LOGO = { dataUrl: 'data:image/png;base64,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', w: 400, h: 164 };
        function _loadPayslipLogo() {
            return Promise.resolve(PAYSLIP_LOGO);
        }

// hrDefaultPaymentDateFor moved here from hr.html — the payslip builder below needs it on
// every page, not just hr.html.
        function hrDefaultPaymentDateFor(monthStr) {
            if (!monthStr) return '';
            const [y, m] = monthStr.split('-').map(Number);
            const d = new Date(y, m, 10); // m (not m-1) lands one month after the pay period
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

// Payslip PDF — laid out to match the reference format supplied by the company (company
// header w/ logo, Employee Summary + highlighted Net Pay box, Paid/LOP days, two-column
// Earnings/Deductions, Gross Earnings vs Total Deductions, Total Net Payable, amount in
// words). Every figure comes straight off the same hr_payroll row HR saved — nothing here is
// recalculated independently, so this can never drift from HR's approved numbers. Builds the
// jsPDF document for one payroll row/employee, without saving it — shared by the single
// Download button, HR's own View/Payslip buttons, and the bulk "Download All Payslips (ZIP)".
// Moved here from hr.html — it used to only exist on that page, so index.html's My Payslips
// (every employee's own self-service download) called downloadHRPayslip() → this function,
// which didn't exist in index.html's scope, and silently threw. Now there is exactly one
// payslip-building function, shared by HR and every employee, so the two can never disagree.
        async function _buildHRPayslipDoc(p, e) {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();
            const pageW = doc.internal.pageSize.getWidth();
            const marginX = 14;
            const rightX = pageW - marginX;

            const [y, m] = p.month.split('-').map(Number);
            const daysInMonth = new Date(y, m, 0).getDate();
            const monthLabel = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
            // Paid Days is always the full calendar days in the month (Aug → 31, Feb → 28/29),
            // independent of attendance — it's a reference figure, not derived from LOP.
            const paidDays = daysInMonth;
            // Day-count breakdown (Present/Leave/Weekly Off/Holiday/LOP) is recomputed live from
            // current attendance + approved-leave records — always automatic, per the payroll
            // rule: Present→Present, Approved Paid Leave→Leave (not LOP), Sunday/Weekly Off and
            // Company Holiday→not LOP, Absent with nothing approved→LOP.
            const dayInfo = hrCalculatePayrollForMonth(p.employee_id, p.month);
            const lopDays = dayInfo.lopDays;
            // Payment Date is a distinct thing from the Pay Period — salary for August is paid
            // in September. Uses whatever was actually saved on this payroll row; falls back to
            // the standard default (10th of the following month) for older rows saved before
            // this field existed, or on a database that hasn't had the column added yet.
            const payDateStr = p.payment_date || hrDefaultPaymentDateFor(p.month);
            const [pdy, pdm, pdd] = payDateStr.split('-').map(Number);
            const payDate = new Date(pdy, pdm - 1, pdd).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

            // "Basic Salary" on the payslip is p.basic — the stored, HR-approved figure (full
            // month's salary once the whole period has elapsed; prorated to the elapsed portion
            // if payroll's being checked mid-month — see hrCalculatePayrollForMonth). It's
            // deliberately NOT re-derived independently here: doing that used to make the
            // printed Gross Earnings disagree with the actual Net Pay whenever Basic had been
            // prorated, since Gross would show the full salary while Net reflected the smaller
            // prorated+LOP-adjusted figure. Using the same stored value everywhere means the
            // printed arithmetic always adds up, and this can never drift from what HR approved.
            const monthlySalary = hrGetEffectiveSalary(p.employee_id, p.month); // full contracted salary — shown as a reference only
            const basicForPayslip = p.basic != null ? p.basic : monthlySalary;
            const grossEarnings = basicForPayslip + (p.allowances||0) + (p.overtime||0) + (p.bonuses||0);
            const totalDeductions = (p.leave_deduction||0) + (p.deductions||0) + (p.advances||0);
            const netPay = p.net_salary != null ? p.net_salary : (grossEarnings - totalDeductions);
            // jsPDF's built-in fonts (Helvetica etc.) have no ₹ glyph — it silently renders as
            // a broken superscript-1. "Rs." is what actually prints correctly.
            const rupee = v => 'Rs. ' + Number(v||0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            const logo = await _loadPayslipLogo();
            let headerY = 20;
            if (logo) {
                const logoW = 34, logoH = logoW * (logo.h / logo.w);
                doc.addImage(logo.dataUrl, 'PNG', marginX, 12, logoW, logoH);
                headerY = 12 + logoH + 7;
            }
            doc.setFontSize(15); doc.setFont(undefined, 'bold'); doc.setTextColor(20);
            doc.text('Broken English', marginX, headerY);
            doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(120);
            doc.text('Production Studio Network', marginX, headerY + 5);

            doc.setFontSize(9); doc.setTextColor(120);
            doc.text('Payslip For the Month', rightX, 18, { align: 'right' });
            doc.setFontSize(12); doc.setFont(undefined, 'bold'); doc.setTextColor(20);
            doc.text(monthLabel, rightX, 24, { align: 'right' });
            doc.setFont(undefined, 'normal');

            doc.setDrawColor(225); doc.line(marginX, 32, rightX, 32);

            // Employee Summary (left) + Net Pay box (right)
            let sy = 42;
            doc.setFontSize(9); doc.setTextColor(140);
            doc.text('EMPLOYEE SUMMARY', marginX, sy);
            sy += 7;
            const summaryRow = (label, val) => {
                doc.setFontSize(9.5); doc.setTextColor(120); doc.text(label, marginX, sy);
                doc.setTextColor(20); doc.text(':', marginX + 34, sy); doc.text(String(val ?? '—'), marginX + 38, sy);
                sy += 6.5;
            };
            summaryRow('Employee Name', e?.full_name || hrEmpName(p.employee_id));
            summaryRow('Role', e ? hrRoleDisplay(e) : '—');
            summaryRow('Employee ID', e?.employee_id || '—');
            summaryRow('Pay Period', monthLabel);
            summaryRow('Pay Date', payDate);
            // Full contracted salary, always — a fixed reference point so it's clear the payslip
            // isn't wrong when Basic Salary below is lower (mid-period check or partial month).
            summaryRow('Monthly Salary', rupee(monthlySalary));

            // PAYROLL SUMMARY stats stacked one-per-line (not side-by-side) — values here can
            // run to a decimal like "28.5", which would collide with a neighboring label if two
            // were placed on the same line. Pre-Joining only shows when it's actually nonzero
            // (mid-month joiner) — no clutter for the normal case.
            const hasPreJoining = dayInfo.preJoiningDays > 0;
            const hasFutureDays = dayInfo.futureDays > 0;
            const boxX = 122, boxW = rightX - boxX, boxY = 40, boxH = hasPreJoining ? 76 : 70;
            doc.setFillColor(230, 250, 240); doc.roundedRect(boxX, boxY, boxW, boxH, 2, 2, 'F');
            doc.setDrawColor(52, 199, 130); doc.setLineWidth(1); doc.line(boxX + 4, boxY + 4, boxX + 4, boxY + boxH - 4); doc.setLineWidth(0.2);
            doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(20, 110, 70);
            doc.text(rupee(netPay), boxX + 9, boxY + 12);
            doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(80, 140, 110);
            doc.text('Total Net Pay', boxX + 9, boxY + 18);
            doc.setDrawColor(200, 230, 215); doc.line(boxX + 4, boxY + 21, boxX + boxW - 4, boxY + 21);
            doc.setFontSize(8.5); doc.setTextColor(60);
            const statRow = (label, val, i) => {
                const ry = boxY + 26 + i * 6.2;
                doc.text(label, boxX + 9, ry); doc.text(':', boxX + 34, ry); doc.text(String(val), boxX + 38, ry);
            };
            statRow('Paid Days', paidDays, 0);
            statRow('Present Days', dayInfo.presentDays, 1);
            statRow('Paid Leave', dayInfo.paidLeaveDays, 2);
            statRow('Weekly Off', dayInfo.weeklyOffDays, 3);
            statRow('Company Holidays', dayInfo.holidayDays, 4);
            statRow('LOP Days', lopDays, 5);
            if (hasPreJoining) statRow('Before Joining', dayInfo.preJoiningDays, 6);

            let y2 = Math.max(sy, boxY + boxH) + 6;
            if (lopDays > 0 || hasPreJoining) {
                doc.setDrawColor(230); doc.line(marginX, y2, rightX, y2); y2 += 6;
                doc.setFontSize(9); doc.setTextColor(120); doc.text('LOP', marginX, y2);
                doc.text(':', marginX + 34, y2); doc.setTextColor(20);
                const lopNote = lopDays > 0
                    ? `${lopDays} day${lopDays===1?'':'s'} — absent or unpaid leave (not Sunday/weekly-off, holiday, or approved paid leave)`
                    : 'No absence-based LOP this period.';
                const joinNote = hasPreJoining ? ` Plus ${dayInfo.preJoiningDays} day(s) before this employee's joining date — also unpaid, but not attendance-related.` : '';
                const noteLines = doc.splitTextToSize(lopNote + joinNote, rightX - marginX - 38);
                doc.text(noteLines, marginX + 38, y2);
                y2 += 5 * noteLines.length + 3;
            }
            if (hasFutureDays) {
                doc.setDrawColor(230); doc.line(marginX, y2, rightX, y2); y2 += 6;
                doc.setFontSize(9); doc.setTextColor(120); doc.text('Note', marginX, y2);
                doc.text(':', marginX + 34, y2); doc.setTextColor(20);
                const futureNote = doc.splitTextToSize(`This pay period isn't finished yet — ${dayInfo.futureDays} day(s) haven't happened. Basic Salary above reflects only the ${dayInfo.elapsedDays} elapsed day(s) so far; re-generate this payslip after the period ends for the final figure.`, rightX - marginX - 38);
                doc.text(futureNote, marginX + 38, y2);
                y2 += 5 * futureNote.length + 3;
            }
            doc.setDrawColor(230); doc.line(marginX, y2, rightX, y2); y2 += 8;

            // Two-column Earnings / Deductions table (16mm gutter between columns so a
            // right-aligned earnings amount can never run into the deductions label)
            const gutter = 16;
            const colW = (rightX - marginX - gutter) / 2;
            const earnCol = marginX, dedCol = marginX + colW + gutter;
            const tableTopY = y2;
            doc.setFontSize(8.5); doc.setTextColor(140); doc.setFont(undefined, 'bold');
            doc.text('EARNINGS', earnCol, y2); doc.text('AMOUNT', earnCol + colW, y2, { align: 'right' });
            doc.text('DEDUCTIONS', dedCol, y2); doc.text('AMOUNT', dedCol + colW, y2, { align: 'right' });
            y2 += 3;
            doc.setDrawColor(220);
            doc.line(earnCol, y2, earnCol + colW, y2); doc.line(dedCol, y2, dedCol + colW, y2);
            y2 += 6;
            doc.setFont(undefined, 'normal'); doc.setFontSize(9.5);

            const earnings = [['Basic Salary', basicForPayslip], ['Allowances', p.allowances], ['Overtime', p.overtime], ['Bonuses', p.bonuses]];
            const deductions = [];
            // Day count in the label matches exactly what the rupee figure was calculated over
            // — LOP days plus any pre-joining days, since both reduce this same deduction line.
            const deductionDays = lopDays + dayInfo.preJoiningDays;
            if (p.leave_deduction) deductions.push([`LOP Deduction${deductionDays ? ` (${deductionDays}d)` : ''}`, p.leave_deduction]);
            if (p.deductions) deductions.push(['Other Deductions', p.deductions]);
            if (p.advances) deductions.push(['Advances', p.advances]);
            if (!deductions.length) deductions.push(['—', 0]);

            const rowCount = Math.max(earnings.length, deductions.length);
            for (let i = 0; i < rowCount; i++) {
                const ry = y2 + i * 6.5;
                if (earnings[i]) { doc.setTextColor(60); doc.text(earnings[i][0], earnCol, ry); doc.setTextColor(20); doc.text(rupee(earnings[i][1]), earnCol + colW, ry, { align: 'right' }); }
                if (deductions[i]) { doc.setTextColor(60); doc.text(deductions[i][0], dedCol, ry); doc.setTextColor(20); doc.text(rupee(deductions[i][1]), dedCol + colW, ry, { align: 'right' }); }
            }
            y2 += rowCount * 6.5 + 3;
            doc.setDrawColor(220); doc.line(earnCol, y2, earnCol + colW, y2); doc.line(dedCol, y2, dedCol + colW, y2);
            y2 += 6;
            doc.setFont(undefined, 'bold'); doc.setFontSize(9.5); doc.setTextColor(30);
            doc.text('Gross Earnings', earnCol, y2); doc.text(rupee(grossEarnings), earnCol + colW, y2, { align: 'right' });
            doc.text('Total Deductions', dedCol, y2); doc.text(rupee(totalDeductions), dedCol + colW, y2, { align: 'right' });
            doc.setFont(undefined, 'normal');

            y2 += 12;
            doc.setFillColor(246, 247, 250); doc.rect(marginX, y2, rightX - marginX, 16, 'F');
            doc.setFontSize(9.5); doc.setFont(undefined, 'bold'); doc.setTextColor(30);
            doc.text('TOTAL NET PAYABLE', marginX + 4, y2 + 6.5);
            doc.setFont(undefined, 'normal'); doc.setFontSize(8); doc.setTextColor(120);
            doc.text('Gross Earnings - Total Deductions', marginX + 4, y2 + 12);
            doc.setFillColor(230, 250, 240);
            doc.rect(rightX - 42, y2 + 2, 38, 12, 'F');
            doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(20, 110, 70);
            doc.text(rupee(netPay), rightX - 5, y2 + 9.5, { align: 'right' });

            y2 += 26;
            doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(100);
            doc.text(`Amount In Words : ${amountInWordsINR(netPay)}`, marginX, y2, { maxWidth: rightX - marginX });

            doc.setFontSize(8); doc.setTextColor(160);
            doc.text('-- This is a system-generated document. --', pageW / 2, 285, { align: 'center' });

            return doc;
        }

// ── downloadHRPayslip (orig line 11327) ──
// Shared by every Download/View/Payslip button on both hr.html and index.html — HR and
// every employee build the identical PDF from the identical _buildHRPayslipDoc() above, off
// the same saved hr_payroll row, so the two sides can never show different numbers (spec:
// "Payslip data must match payroll" / "do not maintain two different payslip formats").
// btnEl (optional) is the clicked button itself (pass `this` from onclick) — when given, it
// gets a "Preparing…" state while the PDF builds and a success/error toast afterward, so a
// slow build or a real failure (a missing jsPDF/PAYSLIP_LOGO load, a bad payroll row) is never
// silent; without it (e.g. a future non-button call site) the download still runs, just
// without the visible loading/toast feedback. Also clears this payslip's "NEW" bell
// notification and the NEW-in-My-Payslips marker (see initMyPayslips) — "opens/downloads it"
// is exactly when the spec says the NEW marker may be cleared.
        async function downloadHRPayslip(id, btnEl) {
            const p = hrPayroll.find(x => x.id === id);
            if (!p) { if (typeof showToast === 'function') showToast('error', 'Unable to download payslip.'); return; }
            const e = hrEmployees.find(x => x.id === p.employee_id);
            const originalLabel = btnEl ? btnEl.textContent : null;
            if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Preparing...'; }
            try {
                const doc = await _buildHRPayslipDoc(p, e);
                doc.save(`Payslip_${(e?.full_name||'employee').replace(/\s+/g,'_')}_${p.month}.pdf`);
                if (typeof dismissNotif === 'function') dismissNotif('payslip_' + p.id); // clears the bell entry
                if (typeof initMyPayslips === 'function' && document.getElementById('my-payslips-rows')) initMyPayslips(); // re-render so the NEW marker actually disappears from this row too
                if (typeof showToast === 'function') showToast('success', 'Payslip downloaded successfully.');
            } catch (err) {
                console.warn('Payslip download failed:', err.message);
                if (typeof showToast === 'function') showToast('error', 'Unable to download payslip.');
            } finally {
                if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalLabel; }
            }
        }

// hrSyncLeaveToAttendance — moved here from hr.html so decideHRLeave (below) can call it from
// any page. When a leave request is approved, writes/updates an on_leave hr_attendance row for
// every date in the request's range, so the calendar/payroll's own recorded-row branch shows
// it consistently with a manually-filed on_leave entry. Untouched logic-wise from the original
// hr.html version — this fix is only about making decideHRLeave itself exist and work, not
// about changing what happens once it runs.
        async function hrSyncLeaveToAttendance(req) {
            const start = new Date(req.start_date), end = new Date(req.end_date);
            const dates = [];
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dates.push(new Date(d).toISOString().slice(0,10));
            for (const dateStr of dates) {
                const existing = hrAttendance.find(a => a.employee_id === req.employee_id && a.att_date === dateStr);
                if (existing) {
                    await dbInstance.from('hr_attendance').update({ status: 'on_leave' }).eq('id', existing.id);
                } else {
                    await dbInstance.from('hr_attendance').insert([{ employee_id: req.employee_id, att_date: dateStr, status: 'on_leave' }]);
                }
            }
        }

// decideHRLeave — the Approve/Reject button handler for a leave request, called from both
// hr.html (HR's own Leave Requests tab) and index.html (a manager's My Team leave list). This
// function was referenced by both pages' onclick handlers but never actually defined anywhere
// in the codebase — clicking Approve/Reject called a function that didn't exist, so nothing
// happened (no error surfaced anywhere visible, since onclick="..." swallows a thrown
// ReferenceError silently). Writes the real status to hr_leave_requests (the only thing that
// actually decides the request — nothing here recalculates leave balances separately, since
// hrComputeLeaveUsed already computes "used" live off approved requests, not a stored
// counter), then syncs an approved request into hr_attendance (existing, previously orphaned
// hrSyncLeaveToAttendance) so the calendar reflects it immediately, not just via the
// live-approved-leave fallback. Each caller is responsible for its own re-render afterward
// (index.html already chains .then(initMyTeam); hr.html's buttons now chain
// .then(renderHRLeaveRequests) the same way) — this function only ever does the write.
        async function decideHRLeave(id, status) {
            const req = hrLeaveRequests.find(r => r.id === id);
            if (!req) { if (typeof showToast === 'function') showToast('error', 'Could not find that leave request — try reloading.'); return; }
            const { error } = await dbInstance.from('hr_leave_requests').update({ status }).eq('id', id);
            if (error) {
                console.warn('Could not update leave request:', error.message);
                if (typeof showToast === 'function') showToast('error', 'Could not update the leave request: ' + error.message); else alert('Could not update the leave request: ' + error.message);
                return;
            }
            req.status = status; // optimistic — reflects immediately even before the reload below finishes
            if (status === 'approved') {
                try { await hrSyncLeaveToAttendance(req); } catch (e) { console.warn('Could not sync approved leave to attendance:', e.message); }
            }
            if (typeof loadHRData === 'function') await loadHRData();
            else if (typeof loadMyHRData === 'function') await loadMyHRData();
            if (typeof showToast === 'function') showToast('success', status === 'approved' ? 'Leave request approved.' : 'Leave request rejected.');
        }

// ── myHREmployeeRecord (orig line 11445) ──
        function myHREmployeeRecord() {
            return hrEmployees.find(e => (e.portal_email || '').toLowerCase() === (activeEmail || '').toLowerCase());
        }

// ── hrDesignationForEmail: real job title for a person shown by email elsewhere in the UI
// (e.g. the Pipeline's "Assigned Creator" column) — never the generic employment-status/
// system-role label. Looks up hrEmployees (self + team, in a self-service session) by
// portal_email and reuses the same hrRoleDisplay() the sidebar role label uses, so both
// places agree on one real title per employee, sourced from HR — never hardcoded. Returns
// null (not a placeholder string) when no match/title is found, so callers can decide their
// own fallback (blank line vs. omitting it entirely) instead of this guessing for them.
        function hrDesignationForEmail(email) {
            if (!email) return null;
            const e = hrEmployees.find(x => (x.portal_email || '').toLowerCase() === email.trim().toLowerCase());
            if (!e) return null;
            const label = hrRoleDisplay(e);
            return (label && label !== '—') ? label : null;
        }

// ── ensureHRDataLoaded (orig line 11448) ──
        async function ensureHRDataLoaded() {
            if (!myHRDataLoaded) { await loadMyHRData(); }
        }

// ── initMyProfileDetails (orig line 11455) ──
        async function initMyProfileDetails() {
            await ensureHRDataLoaded();
            const body = document.getElementById('my-profile-details-body');
            if (!body) return;
            const me = myHREmployeeRecord();
            if (!me) {
                body.innerHTML = '<p class="text-[#4a5182] text-xs py-2">No HR employee record is linked to your login yet — ask HR to link your portal email.</p>';
                return;
            }
            const probationEnd = hrProbationEndDate(me);
            const myDivisionLabel = { education: 'Education', production: 'Production House', hr: 'HR', accounts: 'Accounts', sales: 'Sales', other: 'Other' }[me.division] || me.division;
            const myRoleInfo = hrRoleInfo(me);
            body.innerHTML =
                hrProfileField('Employee ID', me.employee_id) +
                hrProfileField('Department', myDivisionLabel) +
                hrProfileField('Role', myRoleInfo.primary ? ((myRoleInfo.level ? myRoleInfo.level + ' ' : '') + myRoleInfo.primary) : '—') +
                hrProfileField('Level', myRoleInfo.level || '—') +
                hrProfileField('Additional Roles', myRoleInfo.additional.length ? myRoleInfo.additional.join(', ') : '—') +
                hrProfileField('Designation', me.designation) +
                hrProfileField('Joining Date', me.joining_date) +
                hrProfileField('Date of Birth', me.dob) +
                hrProfileField('Phone', me.phone) +
                hrProfileField('Portal Email', me.portal_email) +
                hrProfileField('Manager (portal email)', me.manager_email) +
                hrProfileField('Employment Status', me.employment_status) +
                hrProfileField('Probation Period', me.probation_months ? `${me.probation_months} month(s)` : null) +
                hrProfileField('Probation End Date', probationEnd) +
                hrProfileField('Emergency Contact', [me.emergency_contact_name, me.emergency_contact_phone].filter(Boolean).join(' — '));
            if (window.lucide) lucide.createIcons();
        }

// ── initMyAttendance (orig line 11492) ──
        async function initMyAttendance() {
            await ensureHRDataLoaded();
            const monthInput = document.getElementById('my-att-month');
            if (monthInput && !monthInput.value) monthInput.value = new Date().toISOString().slice(0, 7);
            renderMyAttendance();
        }

// ── renderMyAttendance (orig line 11498) ──
        function renderMyAttendance() {
            const me = myHREmployeeRecord();
            const statsEl = document.getElementById('my-att-stats');
            const calEl = document.getElementById('my-att-calendar');
            if (!me) {
                statsEl.innerHTML = '';
                calEl.innerHTML = '<p class="text-[#4a5182] text-xs col-span-7">No HR employee record is linked to your login yet — ask HR to link your portal email.</p>';
                return;
            }
            const month = document.getElementById('my-att-month').value || new Date().toISOString().slice(0, 7);
            const calc = hrCalculatePayrollForMonth(me.id, month);
            statsEl.innerHTML = [
                { label: 'Present', num: calc.presentDays, color: '#4ade80' },
                { label: 'Paid Leave', num: calc.paidLeaveDays, color: '#60a5fa' },
                { label: 'Weekly Off', num: calc.weeklyOffDays, color: '#8890b5' },
                { label: 'Company Holidays', num: calc.holidayDays, color: '#c084fc' },
                { label: 'LOP / Absent', num: calc.lopDays, color: '#f87171' },
                { label: 'Half Days', num: calc.halfDayDays, color: '#facc15' }
            ].map(s => `<div class="hr-stat-card"><div class="num" style="color:${s.color}">${s.num}</div><div class="label">${s.label}</div></div>`).join('');

            const [y, m] = month.split('-').map(Number);
            const daysInMonth = new Date(y, m, 0).getDate();
            const firstDow = new Date(y, m - 1, 1).getDay();
            const dowLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            const cells = dowLabels.map(d => `<div class="text-center text-[10px] text-[#4a5182] font-bold uppercase pb-1">${d}</div>`);
            for (let i = 0; i < firstDow; i++) cells.push('<div></div>');
            for (let d = 1; d <= daysInMonth; d++) {
                const dateStr = `${month}-${String(d).padStart(2,'0')}`;
                const dow = new Date(y, m - 1, d).getDay();
                const code = hrAttDayCode(me, dateStr, dow);
                const cls = code ? `hr-att-cell-${code}` : 'hr-att-cell-blank';
                cells.push(`<div class="rounded-lg border border-white/[0.05] p-1.5 text-center" style="min-height:44px">
                    <div class="text-[10px] text-[#6b74a0]">${d}</div>
                    <div class="text-xs font-bold ${cls}">${code || '—'}</div>
                </div>`);
            }
            calEl.innerHTML = cells.join('');
            if (window.lucide) lucide.createIcons();
        }

// ── initMyLeave (orig line 11538) ──
        async function initMyLeave() {
            await ensureHRDataLoaded();
            const me = myHREmployeeRecord();
            if (!me) {
                document.getElementById('my-leave-balances').innerHTML = '<p class="text-[#4a5182] text-xs col-span-3">No HR employee record is linked to your login yet — ask HR to link your portal email.</p>';
                document.getElementById('my-leave-history').innerHTML = '';
                return;
            }
            const balances = hrLeaveBalances.filter(b => b.employee_id === me.id);
            document.getElementById('my-leave-balances').innerHTML = balances.length ? balances.map(b => {
                // Same live-computed "used" as the HR admin view (renderHRLeaveBalances) —
                // never trust the stored counter, it can drift from approved requests.
                const used = hrComputeLeaveUsed(me.id, b.leave_type);
                const remaining = HR_UNLIMITED_LEAVE_TYPES.includes(b.leave_type) ? '—' : Math.max(0, (b.allotted||0) - used);
                return `<div class="hr-stat-card"><div class="num">${remaining}</div><div class="label">${b.leave_type}</div></div>`;
            }).join('') : '<p class="text-[#4a5182] text-xs col-span-3">No balances set yet.</p>';
            const mine = hrLeaveRequests.filter(r => r.employee_id === me.id);
            document.getElementById('my-leave-history').innerHTML = mine.length ? mine.map(r => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid rgba(255,255,255,0.06);border-radius:10px">
                    <span class="text-sm text-[#a5adcf]">${r.leave_type} — ${r.start_date} → ${r.end_date}</span>
                    <span class="hr-badge hr-badge-${r.status}">${r.status}</span>
                </div>
            `).join('') : '<p class="text-[#4a5182] text-xs">No requests yet.</p>';
        }

// ── submitMyLeave (orig line 11563) ──
        async function submitMyLeave() {
            const me = myHREmployeeRecord();
            if (!me) { alert('No HR employee record is linked to your login. Ask HR to link your portal email first.'); return; }
            const leave_type = document.getElementById('my-leave-type').value;
            const start_date = document.getElementById('my-leave-start').value;
            const end_date = document.getElementById('my-leave-end').value;
            const reason = document.getElementById('my-leave-reason').value.trim();
            if (!start_date || !end_date) { alert('Pick start and end dates.'); return; }
            const days = Math.round((new Date(end_date) - new Date(start_date)) / 86400000) + 1;
            if (days < 1) { alert('End date must be on or after start date.'); return; }
            try {
                await dbInstance.from('hr_leave_requests').insert([{ employee_id: me.id, leave_type, start_date, end_date, days, reason, status: 'pending' }]);
                document.getElementById('my-leave-start').value = '';
                document.getElementById('my-leave-end').value = '';
                document.getElementById('my-leave-reason').value = '';
                await loadMyHRData();
                initMyLeave();
            } catch (e) { alert('Could not submit request: ' + e.message); }
        }

// ── initMyDocs (orig line 11583) ──
        async function initMyDocs() {
            await ensureHRDataLoaded();
            const me = myHREmployeeRecord();
            const el = document.getElementById('my-docs-list');
            if (!me) { el.innerHTML = '<p class="text-[#4a5182] text-xs">No HR employee record is linked to your login yet.</p>'; return; }
            const docs = (me.document_links || '').split(',').map(s => s.trim()).filter(Boolean);
            el.innerHTML = docs.length ? docs.map(d => `
                <a href="${d}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(255,255,255,0.06);border-radius:10px;color:#a5adcf;text-decoration:none">
                    <i data-lucide="file-text" class="w-4 h-4"></i> ${d}
                </a>
            `).join('') : '<p class="text-[#4a5182] text-xs">No documents on file yet.</p>';
            if (window.lucide) lucide.createIcons();
        }

// ── initMyPayslips (orig line 11597) ──
        async function initMyPayslips() {
            await ensureHRDataLoaded();
            const me = myHREmployeeRecord();
            const el = document.getElementById('my-payslips-rows');
            if (!me) { el.innerHTML = `<tr><td colspan="4" class="py-8 text-center text-[#4a5182] text-xs">No HR employee record is linked to your login yet.</td></tr>`; return; }
            // Access control: only payslips (a) belonging to this employee AND (b) explicitly
            // Sent by HR (published === true). A generated-but-not-yet-sent payslip is a draft
            // that even the employee it belongs to can't see — matches "HR controls when the
            // payslip is released." See the note in hrSetPayrollPublished about the matching
            // Supabase RLS policy this needs to be a real access-control boundary, not just a
            // UI filter.
            const mine = hrPayroll.filter(p => p.employee_id === me.id && p.published === true);
            // NEW marker: reuses the bell's own live `notifications` array rather than a
            // separate read/unread table — a payslip is "new" here exactly as long as its
            // addNotif('payslip', ..., p.id) entry (checkForHRNotifications, id `payslip_<id>`)
            // is still sitting in the bell, unread/undismissed. Downloading it (downloadHRPayslip)
            // dismisses that same entry, which is also what clears this marker — one piece of
            // state, two places it's shown, never two things that can disagree. Deliberately no
            // "Received"/acknowledged marker — only NEW, cleared automatically on open/download.
            const isNew = id => (typeof notifications !== 'undefined') && notifications.some(n => n.id === 'payslip_' + id);
            el.innerHTML = mine.length ? mine.map(p => `
                <tr class="hover:bg-white/[0.02]">
                    <td data-label="Month" class="py-2.5 px-4 text-white font-semibold">${p.month}${isNew(p.id) ? ' <span class="text-[9px] font-bold uppercase tracking-wide text-white bg-orange-500 rounded-full px-2 py-0.5" style="margin-left:6px">New</span>' : ''}</td>
                    <td data-label="Net Salary" class="py-2.5 px-4 text-green-400 font-bold">₹${(p.net_salary||0).toLocaleString('en-IN')}</td>
                    <td data-label="Status" class="py-2.5 px-4"><span class="hr-badge hr-badge-${p.payment_status}">${p.payment_status}</span></td>
                    <td data-label="Action" class="py-2.5 px-4 text-center"><button onclick="downloadHRPayslip('${p.id}', this)" class="hr-icon-btn">Download</button></td>
                </tr>
            `).join('') : `<tr><td colspan="4" class="py-8 text-center text-[#4a5182] text-xs">No payslips yet.</td></tr>`;
        }

// ── Clock In/Out engine + activity log — genuinely shared: index.html AND hr.html both
// have their own Clock In/Clock Out card, and hr.html's Announcements feature also needs
// pushLogEntry. Pipeline-only side effects (Google Sheets sync, the ledger engine) are
// guarded with typeof checks so this works standalone on hr.html, which doesn't load them.
        let attendanceLogs = [];
        let myActiveAttendanceRecord = null;

        async function pushLogEntry(text) {
            const now = new Date();
            const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            await dbInstance.from('system_logs').insert([{ time: ts, text }]);
            if (typeof syncLogToSheet === 'function') syncLogToSheet(ts, text); // Pipeline-only, push to Sheets silently
        }

        function todayDateStr() {
            return new Date().toISOString().slice(0, 10);
        }

        function findMyOpenAttendanceRecord() {
            const today = todayDateStr();
            return attendanceLogs.find(r => r.employee_email === activeEmail && r.log_date === today) || null;
        }

        // Updates every Clock In/Out card present on the current page — Pipeline dashboard,
        // Academic dashboard, HR dashboard — from the one attendance record. Each lookup is
        // null-safe, so this works fine on a page that only has one (or none) of the three.
        function refreshAttendanceClockCard() {
            myActiveAttendanceRecord = findMyOpenAttendanceRecord();

            const apply = (statusEl, inBtn, outBtn) => {
                if (!statusEl || !inBtn || !outBtn) return;
                if (!myActiveAttendanceRecord) {
                    statusEl.innerHTML = `You haven't clocked in today.`;
                    inBtn.classList.remove('hidden');
                    outBtn.classList.add('hidden');
                } else if (myActiveAttendanceRecord.log_in_time && !myActiveAttendanceRecord.log_out_time) {
                    const inTime = new Date(myActiveAttendanceRecord.log_in_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    statusEl.innerHTML = `Clocked in at <span class="text-emerald-400 font-bold">${inTime}</span>. Don't forget to clock out!`;
                    inBtn.classList.add('hidden');
                    outBtn.classList.remove('hidden');
                } else {
                    const inTime = new Date(myActiveAttendanceRecord.log_in_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const outTime = new Date(myActiveAttendanceRecord.log_out_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    statusEl.innerHTML = `Completed today: <span class="text-white font-bold">${inTime} → ${outTime}</span>.`;
                    inBtn.classList.add('hidden');
                    outBtn.classList.add('hidden');
                }
            };
            apply(
                document.getElementById('attendance-status-text'),
                document.getElementById('attendance-clockin-btn'),
                document.getElementById('attendance-clockout-btn')
            );
            apply(
                document.getElementById('acad-attendance-status-text'),
                document.getElementById('acad-attendance-clockin-btn'),
                document.getElementById('acad-attendance-clockout-btn')
            );
            apply(
                document.getElementById('hr-attendance-status-text'),
                document.getElementById('hr-attendance-clockin-btn'),
                document.getElementById('hr-attendance-clockout-btn')
            );
        }

        async function handleClockIn() {
            const existing = findMyOpenAttendanceRecord();
            if (existing) { if (typeof syncLedgerEngine === 'function') await syncLedgerEngine(false); return; }

            const nowIso = new Date().toISOString();
            const { data, error } = await dbInstance.from('attendance_logs').insert([{
                employee_email: activeEmail,
                employee_name: activeUser,
                log_date: todayDateStr(),
                log_in_time: nowIso,
                log_out_time: null
            }]).select();

            if (error) { alert('Could not record clock in: ' + error.message); return; }
            if (data && data[0]) attendanceLogs = attendanceLogs.concat(data);

            await hrSyncClockToAttendance(activeEmail, 'in', nowIso);
            await pushLogEntry(`${activeUser} clocked IN at ${new Date(nowIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
            refreshAttendanceClockCard();
            if (typeof syncLedgerEngine === 'function') await syncLedgerEngine(false);
            if (typeof syncAttendanceToSheet === 'function') syncAttendanceToSheet();
            if (typeof syncMonthlyReportToSheet === 'function') syncMonthlyReportToSheet();
        }

        async function handleClockOut() {
            const existing = findMyOpenAttendanceRecord();
            if (!existing || existing.log_out_time) { if (typeof syncLedgerEngine === 'function') await syncLedgerEngine(false); return; }

            const nowIso = new Date().toISOString();
            const { error } = await dbInstance
                .from('attendance_logs')
                .update({ log_out_time: nowIso })
                .eq('id', existing.id);

            if (error) { alert('Could not record clock out: ' + error.message); return; }
            existing.log_out_time = nowIso;

            await hrSyncClockToAttendance(activeEmail, 'out', nowIso);
            await pushLogEntry(`${activeUser} clocked OUT at ${new Date(nowIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
            refreshAttendanceClockCard();
            if (typeof syncLedgerEngine === 'function') await syncLedgerEngine(false);
            if (typeof syncAttendanceToSheet === 'function') syncAttendanceToSheet();
            if (typeof syncMonthlyReportToSheet === 'function') syncMonthlyReportToSheet();
        }

// ── ACCOUNT SWITCHER — instant switch between saved logins on this device. Genuinely
// shared: hr.html previously had none of this at all. index.html declares its OWN
// (identical-looking) versions of toggleAccountSwitcher/renderAccountSwitcherList/
// switchToAccount further down its script — since these are all plain `function`
// declarations (not let/const), index.html's later declaration simply wins there, so
// this doesn't change index.html's existing behavior at all. hr.html has no such
// override, so it gets exactly this version. Accounts are only ever ones THIS device
// has actually logged into before (be_saved_accounts) — never a directory of every
// account that exists — so this can't expose anything the current user isn't already
// authorized to use. ──
        function getSavedAccounts() {
            try {
                const raw = localStorage.getItem('be_saved_accounts');
                return raw ? JSON.parse(raw) : [];
            } catch (e) {
                return [];
            }
        }

        function saveAccountForSwitching(name, role, email, pass) {
            let accounts = getSavedAccounts();
            accounts = accounts.filter(a => a.email.toLowerCase() !== email.toLowerCase());
            accounts.push({ name, role, email, pass });
            localStorage.setItem('be_saved_accounts', JSON.stringify(accounts));
        }

        function removeSavedAccount(email) {
            let accounts = getSavedAccounts();
            accounts = accounts.filter(a => a.email.toLowerCase() !== email.toLowerCase());
            localStorage.setItem('be_saved_accounts', JSON.stringify(accounts));
            renderAccountSwitcherList();
        }

        function jsStringLiteral(str) {
            return "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        }

        function escapeChatHtml(str) {
            const div = document.createElement('div');
            div.innerText = str || '';
            return div.innerHTML;
        }

        function toggleAccountSwitcher() {
            const desktopPanel = document.getElementById('account-switcher-panel');
            const mobilePanel = document.getElementById('account-switcher-panel-mobile'); // may not exist — hr.html has no separate mobile panel
            if (!desktopPanel) return;
            const isOpening = desktopPanel.classList.contains('hidden') && (!mobilePanel || mobilePanel.classList.contains('hidden'));

            desktopPanel.classList.add('hidden');
            mobilePanel?.classList.add('hidden');

            if (isOpening) {
                renderAccountSwitcherList();
                if (mobilePanel && window.innerWidth < 768) {
                    mobilePanel.classList.remove('hidden');
                } else {
                    desktopPanel.classList.remove('hidden');
                }
            }
        }

        function closeAccountSwitcher() {
            document.getElementById('account-switcher-panel')?.classList.add('hidden');
            document.getElementById('account-switcher-panel-mobile')?.classList.add('hidden');
        }

        function renderAccountSwitcherList() {
            const accounts = getSavedAccounts();
            const targets = [
                document.getElementById('account-switcher-list'),
                document.getElementById('account-switcher-list-mobile')
            ];

            targets.forEach(list => {
                if (!list) return;
                list.innerHTML = '';

                if (accounts.length === 0) {
                    list.innerHTML = `<p class="px-3 py-3 text-[11px] text-[#4a5182] italic">No saved accounts yet.</p>`;
                    return;
                }

                accounts.forEach(acc => {
                    const isCurrent = acc.email.toLowerCase() === (activeEmail || '').toLowerCase();
                    const initials = acc.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
                    const emailLiteral = jsStringLiteral(acc.email);
                    list.innerHTML += `
                        <div class="flex items-center gap-2 px-3 py-2 hover:bg-transparent transition-colors ${isCurrent ? 'bg-transparent/60' : ''}">
                            <button onclick="switchToAccount(${emailLiteral})" class="flex items-center gap-2.5 flex-1 text-left min-w-0">
                                <div class="w-7 h-7 rounded-full bg-transparent flex items-center justify-center text-gray-300 font-bold text-[10px] shrink-0">${initials}</div>
                                <div class="min-w-0">
                                    <p class="text-xs font-bold text-white truncate">${escapeChatHtml(acc.name)} ${isCurrent ? '<span class="text-emerald-400">(current)</span>' : ''}</p>
                                    <p class="text-[10px] text-[#4a5182] truncate">${acc.role}</p>
                                </div>
                            </button>
                            <button onclick="removeSavedAccount(${emailLiteral})" title="Remove saved account" class="text-[#4a5182] hover:text-red-400 p-1 shrink-0">
                                <i data-lucide="x" class="w-3.5 h-3.5"></i>
                            </button>
                        </div>
                    `;
                });
            });

            if (window.lucide) lucide.createIcons();
        }

        function switchToAccount(email) {
            const accounts = getSavedAccounts();
            const target = accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
            if (!target) return;

            if (target.email.toLowerCase() === (activeEmail || '').toLowerCase()) {
                closeAccountSwitcher();
                return;
            }

            activeUser = target.name;
            activeRole = target.role;
            activeEmail = target.email;

            localStorage.setItem('be_active_user', activeUser);
            localStorage.setItem('be_active_role', activeRole);
            localStorage.setItem('be_active_email', activeEmail);

            closeAccountSwitcher();
            if (typeof pushLogEntry === 'function') pushLogEntry(`${activeUser} (${activeRole}) switched into session on this device.`);

            if (typeof launchSession === 'function') {
                // index.html (Pipeline) — full boot + role-based landing, same as it always did.
                launchSession();
                if (typeof switchTab === 'function') {
                    if (activeRole === 'admin') switchTab('hr');
                    else if (activeRole === 'manager') switchTab('team');
                    else switchTab('dashboard');
                }
            } else {
                // hr.html — no Pipeline boot to call. Switching TO an admin account just
                // re-renders this page with the new identity's data; switching to anything
                // else can't stay here (this page is admin-only — see bootHRPage), so send
                // them to the app that can actually show their role.
                if (typeof renderHRSidebarIdentity === 'function') renderHRSidebarIdentity();
                if (activeRole === 'admin' && typeof initHRPanel === 'function') {
                    hrLoaded = false;
                    initHRPanel();
                } else {
                    window.location.href = 'index.html';
                }
            }
        }

        function startAddAccountFlow() {
            closeAccountSwitcher();
            if (typeof document !== 'undefined' && document.getElementById('portal-login-screen')) {
                // index.html only — hr.html has no login screen of its own; its "Add another
                // account" link goes straight to index.html instead (see the sidebar markup).
                const screen = document.getElementById('portal-login-screen');
                document.getElementById('portal-user-input').value = '';
                document.getElementById('portal-password-input').value = '';
                document.getElementById('portal-heading-text').innerText = 'Add Another Account';
                document.getElementById('portal-subheading-text').classList.remove('hidden');
                document.getElementById('portal-cancel-add-btn').classList.remove('hidden');
                screen.classList.remove('hidden');
                screen.style.display = 'flex';
                window.scrollTo(0, 0);
                setTimeout(() => document.getElementById('portal-user-input').focus(), 100);
            }
        }

        document.addEventListener('click', function(e) {
            const desktopPanel = document.getElementById('account-switcher-panel');
            if (!desktopPanel) return;
            const mobilePanel = document.getElementById('account-switcher-panel-mobile');
            const clickedInsideSwitcher = e.target.closest('#account-switcher-panel, #account-switcher-trigger, #account-switcher-trigger-mobile, #account-switcher-panel-mobile');
            if (!clickedInsideSwitcher) {
                desktopPanel.classList.add('hidden');
                mobilePanel?.classList.add('hidden');
            }
        });

// ── CELEBRATION ENGINE — birthday, work anniversary (both computed live off the existing
// hr_employees.dob/joining_date, nothing duplicated or hardcoded), and HR-configured
// festival/national-day/custom events (hr_celebration_events). One shared popup+banner
// component, built once via ensureCelebrationDOM() rather than duplicated markup in
// index.html/hr.html/academics.html — this is what makes it actually work on every page,
// unlike the old birthday-only popup which only ever existed in index.html's own markup and
// silently did nothing on hr.html/academics.html (its own null-check on
// #birthday-popup-overlay just returned early there). Self-contained CSS (.be-celeb-*
// classes, injected once) so it renders identically regardless of which page's own utility
// classes are or aren't available — academics.html in particular has none of index.html/
// hr.html's .card/.glass-card/.brand-gradient classes. ──

        function isBirthdayToday(dobStr) {
            if (!dobStr) return false;
            const d = new Date(dobStr);
            if (isNaN(d)) return false;
            const now = new Date();
            return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        }

        // Every active employee whose dob matches today — used by the HR Dashboard alert.
        function getTodaysBirthdays() {
            return hrEmployees.filter(e => e.employment_status === 'active' && isBirthdayToday(e.dob));
        }

        // Work anniversary — same month/day match as birthday, but only once at least one full
        // year has actually elapsed (joining day itself isn't anyone's first anniversary).
        // Returns the whole-number year count, or null if today isn't the anniversary.
        function isAnniversaryToday(joiningDateStr) {
            if (!joiningDateStr) return null;
            const jd = new Date(joiningDateStr);
            if (isNaN(jd)) return null;
            const now = new Date();
            if (jd.getMonth() !== now.getMonth() || jd.getDate() !== now.getDate()) return null;
            const years = now.getFullYear() - jd.getFullYear();
            return years >= 1 ? years : null;
        }

        // A company-wide event is "active" today either on its actual event_date, or — if HR
        // set an advance_start_date — anywhere in [advance_start_date, event_date). Returns
        // 'actual' | 'advance' | null. Purely date-driven, never hardcoded into page JS (spec
        // item 4/5) — HR changes the dates in the Celebrations admin UI, this just reads them.
        function hrCelebrationStatusForToday(ev) {
            const todayStr = new Date().toISOString().slice(0, 10);
            if (!ev.event_date) return null;
            if (todayStr === ev.event_date) return 'actual';
            if (ev.advance_start_date && todayStr >= ev.advance_start_date && todayStr < ev.event_date) return 'advance';
            return null;
        }

        function hrCelebrationApplies(ev, employee) {
            return !ev.applies_to || ev.applies_to === 'all' || ev.applies_to === employee.division;
        }

        // Birthday/Work Anniversary artwork isn't tied to a date row — it's a reusable
        // "template" HR uploads once (event_type = 'birthday' | 'work_anniversary', no
        // event_date), applied to every employee whenever their own personal event is true
        // today. Only ever looked up by type, never by date.
        function hrFindCelebrationTemplate(type) {
            return (hrCelebrationEvents || []).find(ev => ev.event_type === type) || null;
        }

        // Every celebration item relevant to this employee today — personal (birthday, work
        // anniversary) first, then HR-configured company-wide events. Each item is fully
        // self-describing (title/popupImage/bannerImage/enabled flags/artworkMode) so the
        // queue/banner renderers below never need to know the difference between a birthday
        // and a festival. title/message are still generated (used for the Notification Center
        // text list, which stays plain text) but the popup/banner SURFACES are image-only —
        // see spec item 1: "Do NOT generate celebration visuals using plain HTML text boxes."
        function computeTodaysCelebrations(me) {
            if (!me) return [];
            const items = [];
            const todayStr = new Date().toISOString().slice(0, 10);
            const firstName = (me.full_name || activeUser || 'there').trim().split(' ')[0];

            if (isBirthdayToday(me.dob)) {
                const tpl = hrFindCelebrationTemplate('birthday');
                items.push({
                    key: `birthday_${todayStr}`, type: 'birthday',
                    title: `Happy Birthday, ${firstName}!`, captionName: firstName,
                    message: 'Wishing you a wonderful year ahead filled with happiness and success 🎂',
                    bannerMessage: `🎂 Happy Birthday, ${firstName}! Have a wonderful day 🎉`,
                    popupImage: tpl?.popup_image_base64 || null, bannerImage: tpl?.banner_image_base64 || null,
                    artworkMode: tpl?.artwork_mode || 'complete',
                    popupEnabled: tpl ? tpl.popup_enabled !== false : true, bannerEnabled: tpl ? tpl.banner_enabled !== false : true
                });
            }
            const years = isAnniversaryToday(me.joining_date);
            if (years) {
                const yearLabel = years === 1 ? '1 Year' : `${years} Years`;
                const tpl = hrFindCelebrationTemplate('work_anniversary');
                items.push({
                    key: `anniversary_${todayStr}`, type: 'work_anniversary',
                    title: `Happy Work Anniversary, ${firstName}!`, captionName: `${firstName} · ${yearLabel}`,
                    message: `Thank you for being an important part of our journey — ${yearLabel} at Broken English 🎉`,
                    bannerMessage: `🏆 Happy Work Anniversary, ${firstName}! ${yearLabel} and counting 🎉`,
                    popupImage: tpl?.popup_image_base64 || null, bannerImage: tpl?.banner_image_base64 || null,
                    artworkMode: tpl?.artwork_mode || 'complete',
                    popupEnabled: tpl ? tpl.popup_enabled !== false : true, bannerEnabled: tpl ? tpl.banner_enabled !== false : true
                });
            }
            (hrCelebrationEvents || []).forEach(ev => {
                if (ev.event_type === 'birthday' || ev.event_type === 'work_anniversary') return; // those are templates, handled above — never date-matched
                const status = hrCelebrationStatusForToday(ev);
                if (!status || !hrCelebrationApplies(ev, me)) return;
                const titleText = `${status === 'advance' ? 'Advance ' : ''}${ev.title}!`;
                items.push({
                    key: `event_${ev.id}_${todayStr}`, type: ev.event_type || 'custom',
                    title: `${ev.icon ? ev.icon + ' ' : ''}${titleText}`, captionName: null,
                    message: ev.message || `Wishing you a wonderful ${ev.title}!`,
                    bannerMessage: ev.banner_message || ev.message || `${ev.icon ? ev.icon + ' ' : ''}${titleText}`,
                    popupImage: ev.popup_image_base64 || null, bannerImage: ev.banner_image_base64 || null,
                    artworkMode: 'complete',
                    popupEnabled: ev.popup_enabled !== false, bannerEnabled: ev.banner_enabled !== false
                });
            });
            return items;
        }

        // Per-user, per-event, per-day seen/dismissed state (spec item 2) — localStorage keyed
        // by activeEmail + the item's own key (which already embeds today's date), never a
        // single global flag shared between employees.
        function _celebStorageKey(prefix, key) { return `be_celeb_${prefix}_${(activeEmail || '').toLowerCase()}_${key}`; }
        function hasSeenCelebrationPopup(key) { return !!localStorage.getItem(_celebStorageKey('popup', key)); }
        function markCelebrationPopupSeen(key) { localStorage.setItem(_celebStorageKey('popup', key), '1'); }
        function isCelebrationBannerDismissed(key) { return !!localStorage.getItem(_celebStorageKey('banner', key)); }
        function dismissCelebrationBanner(key) {
            try {
                localStorage.setItem(_celebStorageKey('banner', key), '1');
                const el = document.getElementById(`celeb-banner-${key}`);
                if (el) el.remove(); else console.warn(`Celebration engine: dismiss clicked for "${key}" but its banner element was already gone.`);
            } catch (e) {
                console.error('Celebration engine: could not dismiss banner —', e.message);
            }
        }

        let _celebrationCSSInjected = false;
        function ensureCelebrationCSS() {
            if (_celebrationCSSInjected || document.getElementById('be-celeb-styles')) { _celebrationCSSInjected = true; return; }
            const style = document.createElement('style');
            style.id = 'be-celeb-styles';
            // Popup: the designer image IS the surface — object-fit:contain so it's NEVER
            // cropped or stretched (this is the focal "read the whole artwork" surface),
            // capped to 90vw/85vh (spec item 7), a single ✕ overlaid in the corner (the one
            // thing the spec's own mockup shows sitting over the artwork).
            // Banner: a fixed-size box (full dashboard width, compact fixed height —
            // 130px/90px on phones) with object-fit:cover. Deliberately NOT object-fit:contain
            // here — most real uploaded artwork isn't cut to the exact wide-banner aspect ratio
            // (e.g. the actual Onam art is closer to 2.5:1, not the recommended ~4.8:1), and
            // contain's letterboxing left an obvious gap with the ✕ button floating in empty
            // space disconnected from the image. cover fills the box completely, edge to edge,
            // center-cropping the excess on whichever axis doesn't match — the same tradeoff
            // virtually every real product's hero/banner image makes, and a deliberate,
            // reported-and-fixed departure from the popup's own never-crop rule (the popup is
            // the "read the whole design" surface; the banner is a compact strip). Rendered
            // inside each page's own #celebration-banner-slot — part of the dashboard content
            // area, not a floating toast (spec item 16).
            style.textContent = `
                .be-celeb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:95;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)}
                .be-celeb-overlay.hidden{display:none}
                .be-celeb-imgwrap{position:relative;max-width:90vw;max-height:85vh;line-height:0}
                .be-celeb-imgwrap img{display:block;max-width:90vw;max-height:85vh;width:auto;height:auto;object-fit:contain;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.6)}
                .be-celeb-close{position:absolute;top:8px;right:8px;background:rgba(10,12,20,.65);border:none;color:#fff;cursor:pointer;width:30px;height:30px;border-radius:50%;font-size:15px;line-height:1;backdrop-filter:blur(3px)}
                .be-celeb-close:hover{background:rgba(10,12,20,.85)}
                .be-celeb-caption{text-align:center;color:#fff;font-weight:700;font-size:14px;margin-top:10px;text-shadow:0 2px 8px rgba(0,0,0,.6)}
                .be-celeb-loading{width:90vw;max-width:340px;aspect-ratio:4/5;border-radius:14px;background:#12162a;display:flex;align-items:center;justify-content:center}
                .be-celeb-spinner{width:28px;height:28px;border-radius:50%;border:3px solid rgba(255,255,255,.15);border-top-color:#ff6b06;animation:be-celeb-spin .8s linear infinite}
                @keyframes be-celeb-spin{to{transform:rotate(360deg)}}
                .be-celeb-banner-slot{width:100%;position:relative}
                .be-celeb-banner-item{position:relative;width:100%;height:130px;margin-bottom:10px;border-radius:12px;overflow:hidden;background:#12162a}
                .be-celeb-banner-item:last-child{margin-bottom:0}
                .be-celeb-banner-item img{display:block;width:100%;height:100%;object-fit:cover;object-position:center;pointer-events:none}
                .be-celeb-banner-close{position:absolute;top:8px;right:8px;z-index:5;background:rgba(10,12,20,.65);border:none;color:#fff;cursor:pointer;width:30px;height:30px;border-radius:50%;font-size:15px;line-height:1;pointer-events:auto}
                .be-celeb-banner-close:hover{background:rgba(10,12,20,.9)}
                @media (max-width:480px){.be-celeb-banner-item{height:90px}}
            `;
            document.head.appendChild(style);
            _celebrationCSSInjected = true;
        }

        // The banner renders inside each page's own #celebration-banner-slot — a small static
        // div each page places at the top of its dashboard content (spec item 16: "part of the
        // dashboard content/header area", not a floating toast). Falls back to creating one
        // fixed near the top of the viewport only if a page hasn't added the slot.
        function ensureCelebrationBannerHost() {
            let host = document.getElementById('celebration-banner-slot');
            if (host) return host;
            host = document.createElement('div');
            host.id = 'celebration-banner-slot';
            host.className = 'be-celeb-banner-slot';
            host.style.cssText = 'position:fixed;top:64px;left:12px;right:12px;z-index:90;max-width:480px;margin:0 auto';
            document.body.appendChild(host);
            return host;
        }

        function ensureCelebrationDOM() {
            ensureCelebrationCSS();
            if (!document.getElementById('celebration-popup-overlay')) {
                document.body.insertAdjacentHTML('beforeend', `<div id="celebration-popup-overlay" class="be-celeb-overlay hidden"></div>`);
            }
            ensureCelebrationBannerHost();
        }

        // Queue so multiple events on the same day (e.g. a birthday + a company festival) never
        // show two full-screen popups at once (spec item 13) — one at a time, in order, with a
        // brief pause between. Banners, unlike the popup, aren't queued — every active,
        // not-yet-dismissed-today event gets its own banner simultaneously, since those are
        // meant to coexist quietly rather than interrupt one another.
        let _celebrationQueue = [];
        function runCelebrationQueue(me) {
            const items = computeTodaysCelebrations(me);
            if (!items.length) return;
            ensureCelebrationDOM();
            // Notification Center entry per item per day (plain text, unaffected by whether
            // artwork is configured) — addNotif already dedupes by its own id (built from
            // `key` here), so calling this on every poll is safe and never spams.
            items.forEach(it => {
                if (typeof addNotif === 'function') {
                    const notifType = it.type === 'birthday' ? 'birthday' : it.type === 'work_anniversary' ? 'work_anniversary' : 'celebration';
                    addNotif(notifType, it.bannerMessage || it.message, null, it.key);
                }
            });
            // "If Popup Image is missing: Do not show popup." (spec item 9) — an item with no
            // popupImage never enters the queue at all, rather than falling back to a generic
            // text popup.
            _celebrationQueue = items.filter(it => it.popupEnabled && it.popupImage && !hasSeenCelebrationPopup(it.key));
            showNextCelebrationPopup();
            // Same rule for the banner — no bannerImage, no banner surface.
            renderCelebrationBanners(items.filter(it => it.bannerEnabled && it.bannerImage && !isCelebrationBannerDismissed(it.key)));
        }

        function showNextCelebrationPopup() {
            if (!_celebrationQueue.length) return;
            const overlay = document.getElementById('celebration-popup-overlay');
            if (!overlay || !overlay.classList.contains('hidden')) return; // one at a time — closeCelebrationPopup re-calls this once the current one is dismissed
            const item = _celebrationQueue[0];
            // Loading state (spec item 18): show a small spinner, not a giant blank/broken
            // modal, while the image decodes; preload via a plain Image() first so the overlay
            // never flashes an empty box. If the image fails to load, skip this item safely —
            // mark it seen and move straight to the next queued item (or just close).
            overlay.innerHTML = `<div class="be-celeb-loading"><div class="be-celeb-spinner"></div></div>`;
            overlay.classList.remove('hidden');
            const preload = new Image();
            preload.onload = () => {
                if (_celebrationQueue[0] !== item) return; // superseded (closed/advanced) while loading
                const captionHtml = item.artworkMode === 'template' && item.captionName
                    ? `<div class="be-celeb-caption">${item.captionName}</div>` : '';
                overlay.innerHTML = `
                    <div>
                        <div class="be-celeb-imgwrap">
                            <img src="${item.popupImage}" alt="${item.title}">
                            <button onclick="closeCelebrationPopup()" class="be-celeb-close" aria-label="Close">✕</button>
                        </div>
                        ${captionHtml}
                    </div>
                `;
            };
            preload.onerror = () => {
                if (_celebrationQueue[0] !== item) return;
                // Log the actual failure (spec item 12) rather than silently skipping —
                // popup_image_base64 truncated in the log since it's a data URL (can be
                // hundreds of KB), only its length is useful for diagnosing a corrupt upload.
                console.error(`Celebration engine: popup image failed to load for event "${item.key}" (type: ${item.type}). Image data length: ${item.popupImage ? item.popupImage.length : 0}.`);
                closeCelebrationPopup(); // skip this one safely — never leave a broken-image modal open
            };
            preload.src = item.popupImage;
        }

        function closeCelebrationPopup() {
            const overlay = document.getElementById('celebration-popup-overlay');
            overlay?.classList.add('hidden');
            if (overlay) overlay.innerHTML = ''; // destroy the loaded image/DOM once closed rather than leaving it sitting there all day (spec item 19)
            const item = _celebrationQueue.shift();
            if (item) markCelebrationPopupSeen(item.key);
            if (_celebrationQueue.length) setTimeout(showNextCelebrationPopup, 300);
        }

        function renderCelebrationBanners(items) {
            const host = ensureCelebrationBannerHost();
            host.innerHTML = items.map(it => `
                <div id="celeb-banner-${it.key}" class="be-celeb-banner-item">
                    <img src="${it.bannerImage}" alt="${it.title}" loading="lazy" onerror="console.error('Celebration engine: banner image failed to load for event &quot;${it.key}&quot; (type: ${it.type}).');this.closest('.be-celeb-banner-item')?.remove()">
                    <button onclick="dismissCelebrationBanner('${it.key}')" class="be-celeb-banner-close" aria-label="Dismiss">✕</button>
                </div>
            `).join('');
        }

// ============================================================================
// SHARED IN-APP NOTIFICATION SYSTEM — toasts + confirm/prompt modals, replacing
// native alert()/confirm()/prompt() everywhere. One implementation here (common.js
// is loaded by index.html, hr.html, and academics.html already) so every page
// behaves identically instead of three separate copies. Self-contained inline
// styles — deliberately does NOT depend on any one page's own CSS custom
// properties (each of the three files defines its own, differently-named set),
// so the same toast/modal renders correctly no matter which page is showing it.
// Colors match the existing Broken English dark theme + orange→pink→red brand
// gradient already used everywhere (sidebar accents, primary buttons, badges).
// ============================================================================
(function(){
  const BE_COLORS = {
    bg: '#12162a', panelBg: '#0f1121', border: 'rgba(255,255,255,.1)',
    text: '#f1f5f9', muted: '#a5adcf',
    success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6',
    gradient: 'linear-gradient(135deg,#ff6b06,#f9182f,#ff0552)',
    dangerGradient: 'linear-gradient(135deg,#f9182f,#ff0552)'
  };
  const BE_ICONS = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };

  function beEnsureToastHost(){
    let host = document.getElementById('be-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'be-toast-host';
      // max-width:min(360px, 100vw - 40px) — on a narrow phone (320-430px) the toast shrinks
      // to fit the available width minus its side margins instead of clipping against the
      // viewport edge; on a wider screen the 360px cap wins as before.
      host.style.cssText = 'position:fixed;top:70px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:10px;max-width:min(360px,calc(100vw - 40px));pointer-events:none;font-family:inherit';
      document.body.appendChild(host);
    }
    return host;
  }

  // showToast(type, message, durationMs?) — type is 'success'|'error'|'warning'|'info'.
  // Auto-dismisses after durationMs (default 4000ms); click the × to dismiss early.
  // Returns a dismiss() function in case a caller wants to close it programmatically.
  window.showToast = function(type, message, durationMs){
    type = BE_ICONS[type] ? type : 'info';
    durationMs = durationMs || 4200;
    const host = beEnsureToastHost();
    const accent = BE_COLORS[type];
    const el = document.createElement('div');
    el.style.cssText = `pointer-events:auto;display:flex;align-items:flex-start;gap:10px;background:${BE_COLORS.bg};border:1px solid ${BE_COLORS.border};border-left:3px solid ${accent};border-radius:10px;padding:12px 14px;box-shadow:0 12px 32px rgba(0,0,0,.5);font-size:13px;color:${BE_COLORS.text};opacity:0;transform:translateX(16px);transition:opacity .25s ease,transform .25s ease`;
    el.innerHTML = `<span style="flex-shrink:0;width:20px;height:20px;border-radius:50%;background:${accent}22;color:${accent};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${BE_ICONS[type]}</span>`
      + `<span style="flex:1;line-height:1.45;padding-top:1px;white-space:pre-line;word-break:break-word">${message}</span>`
      + `<span data-be-toast-close style="cursor:pointer;color:${BE_COLORS.muted};font-size:15px;line-height:1;padding:1px 2px" title="Dismiss">&times;</span>`;
    host.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(0)'; });
    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      el.style.opacity = '0'; el.style.transform = 'translateX(16px)';
      setTimeout(() => el.remove(), 220);
    };
    el.querySelector('[data-be-toast-close]').onclick = dismiss;
    timer = setTimeout(dismiss, durationMs);
    return dismiss;
  };

  function beEnsureModalHost(){
    let host = document.getElementById('be-modal-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'be-modal-host';
      document.body.appendChild(host);
    }
    return host;
  }
  function beOverlayShell(innerHtml){
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(4,6,12,.72);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .18s ease;font-family:inherit';
    overlay.innerHTML = `<div style="width:100%;max-width:400px;max-height:85vh;overflow-y:auto;background:${BE_COLORS.panelBg};border:1px solid ${BE_COLORS.border};border-radius:16px;padding:22px;box-shadow:0 30px 80px rgba(0,0,0,.6);transform:translateY(8px);transition:transform .18s ease;box-sizing:border-box">${innerHtml}</div>`;
    return overlay;
  }

  // showConfirm(message, opts?) -> Promise<boolean>. Replaces window.confirm().
  // opts: { title, confirmLabel, cancelLabel, danger } — danger:true uses the red
  // accent for destructive actions (delete employee/course/batch/student/trainer, etc).
  window.showConfirm = function(message, opts){
    opts = opts || {};
    return new Promise(resolve => {
      const host = beEnsureModalHost();
      const confirmBg = opts.danger ? BE_COLORS.dangerGradient : BE_COLORS.gradient;
      const overlay = beOverlayShell(`
        <div style="font-size:16px;font-weight:800;color:${BE_COLORS.text};margin-bottom:10px">${opts.title || (opts.danger ? 'Are you sure?' : 'Confirm')}</div>
        <div style="font-size:13px;color:${BE_COLORS.muted};line-height:1.55;white-space:pre-line;margin-bottom:20px">${message}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button data-be-cancel style="padding:10px 16px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#cbd5e1;font-weight:600;font-size:13px;cursor:pointer">${opts.cancelLabel || 'Cancel'}</button>
          <button data-be-confirm style="padding:10px 16px;border-radius:9px;border:none;background:${confirmBg};color:#fff;font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 6px 18px rgba(237,31,81,.35)">${opts.confirmLabel || 'Confirm'}</button>
        </div>`);
      host.appendChild(overlay);
      requestAnimationFrame(() => { overlay.style.opacity = '1'; overlay.firstElementChild.style.transform = 'translateY(0)'; overlay.querySelector('[data-be-confirm]')?.focus(); });
      const cleanup = (result) => { overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 150); resolve(result); };
      overlay.querySelector('[data-be-cancel]').onclick = () => cleanup(false);
      overlay.querySelector('[data-be-confirm]').onclick = () => cleanup(true);
      overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
      const escHandler = (e) => { if (e.key === 'Escape') { cleanup(false); document.removeEventListener('keydown', escHandler); } };
      document.addEventListener('keydown', escHandler);
    });
  };

  // showPrompt(message, opts?) -> Promise<string|null>. Replaces window.prompt().
  // opts: { title, defaultValue, placeholder, confirmLabel, requireExact } —
  // requireExact (a string) keeps Confirm disabled until the typed value matches
  // it (case-insensitive) — mirrors the existing "type DELETE to confirm" guard.
  window.showPrompt = function(message, opts){
    opts = opts || {};
    return new Promise(resolve => {
      const host = beEnsureModalHost();
      const overlay = beOverlayShell(`
        <div style="font-size:16px;font-weight:800;color:${BE_COLORS.text};margin-bottom:10px">${opts.title || 'Confirm'}</div>
        <div style="font-size:13px;color:${BE_COLORS.muted};line-height:1.55;white-space:pre-line;margin-bottom:14px">${message}</div>
        <input data-be-input type="text" placeholder="${opts.placeholder || ''}" value="${opts.defaultValue || ''}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:10px 12px;color:${BE_COLORS.text};font-size:13px;outline:none;margin-bottom:20px">
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button data-be-cancel style="padding:10px 16px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#cbd5e1;font-weight:600;font-size:13px;cursor:pointer">Cancel</button>
          <button data-be-confirm style="padding:10px 16px;border-radius:9px;border:none;background:${BE_COLORS.dangerGradient};color:#fff;font-weight:700;font-size:13px;cursor:pointer" ${opts.requireExact ? 'disabled' : ''}>${opts.confirmLabel || 'OK'}</button>
        </div>`);
      host.appendChild(overlay);
      const input = overlay.querySelector('[data-be-input]');
      const confirmBtn = overlay.querySelector('[data-be-confirm]');
      confirmBtn.style.opacity = opts.requireExact ? '.5' : '1';
      requestAnimationFrame(() => { overlay.style.opacity = '1'; overlay.firstElementChild.style.transform = 'translateY(0)'; input.focus(); input.select(); });
      if (opts.requireExact) {
        input.addEventListener('input', () => {
          const ok = input.value.trim().toLowerCase() === String(opts.requireExact).toLowerCase();
          confirmBtn.disabled = !ok;
          confirmBtn.style.opacity = ok ? '1' : '.5';
        });
      }
      const cleanup = (result) => { overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 150); resolve(result); };
      overlay.querySelector('[data-be-cancel]').onclick = () => cleanup(null);
      confirmBtn.onclick = () => { if (!confirmBtn.disabled) cleanup(input.value); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !confirmBtn.disabled) cleanup(input.value); });
      overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
    });
  };

  // Global safety net: any alert() call site not individually converted to showToast()
  // still renders through the branded toast instead of a native browser popup — the hard
  // requirement is "never a native popup," and this guarantees that everywhere, even for
  // calls this pass didn't reach individually. Type is classified from the same message
  // conventions already used throughout this codebase (a leading ✓/⚠/✕, or keywords like
  // "Cannot"/"failed"/"Could not" for errors) — individually-converted call sites still pass
  // their own explicit type, which is always more accurate than this guess.
  window.alert = function(message){
    const msg = String(message == null ? '' : message);
    let type = 'info';
    if (/^✓|success|saved|created|updated|deleted|sent|complete/i.test(msg)) type = 'success';
    else if (/^⚠|warning|already|not available|unavailable|at capacity/i.test(msg)) type = 'warning';
    else if (/^✕|cannot|could not|failed|unable|error/i.test(msg)) type = 'error';
    showToast(type, msg, 6000);
  };
})();

// ============================================================================
// SHARED MOBILE OFF-CANVAS SIDEBAR — index.html already has its own working
// version of this (hand-written mobile nav links, left untouched — no reason
// to risk it). hr.html and academics.html did not: hr.html had the CSS to
// HIDE its desktop sidebar below 768px but no replacement at all (a real,
// severe bug — HR had no way to navigate on a phone); academics.html had
// neither the CSS nor the markup. Both now use this one shared
// implementation instead of a third hand-copied nav list to maintain.
//
// Rather than duplicating each page's nav links a second time (guaranteed to
// drift out of sync the next time a nav item is added), this clones the
// EXISTING desktop sidebar's nav markup into the mobile drawer the first
// time it opens, and rewrites each link's onclick to also close the drawer
// afterward. One source of truth for nav links, on every page, always.
// Requires the page to have a real desktop <aside> containing an element
// matching MOBILE_SIDEBAR_NAV_SELECTOR (each page defines its own — see the
// window.MOBILE_SIDEBAR_NAV_SELECTOR assignment near that page's own sidebar
// markup) and to include the three host elements in its own HTML:
// #mobile-nav-overlay, #mobile-sidebar > (a header) + #mobile-sidebar-nav-host,
// #mobile-topbar.
function openMobileSidebar(){
  const mobileSidebar = document.getElementById('mobile-sidebar');
  const overlay = document.getElementById('mobile-nav-overlay');
  const navHost = document.getElementById('mobile-sidebar-nav-host');
  if (!mobileSidebar || !overlay) return;
  if (navHost && !navHost.dataset.cloned) {
    const sourceSelector = window.MOBILE_SIDEBAR_NAV_SELECTOR || 'aside .sidebar-nav-scroll';
    const source = document.querySelector(sourceSelector);
    if (source) {
      navHost.innerHTML = source.innerHTML;
      navHost.dataset.cloned = '1';
      navHost.querySelectorAll('button[onclick], a[onclick]').forEach(el => {
        const orig = el.getAttribute('onclick') || '';
        if (!orig.includes('closeMobileSidebar')) el.setAttribute('onclick', orig + ';closeMobileSidebar()');
      });
    }
  }
  mobileSidebar.classList.add('open');
  overlay.classList.add('open');
  if (window.lucide) lucide.createIcons();
}
function closeMobileSidebar(){
  document.getElementById('mobile-sidebar')?.classList.remove('open');
  document.getElementById('mobile-nav-overlay')?.classList.remove('open');
}
