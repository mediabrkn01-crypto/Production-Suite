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

const ACAD_SUPABASE_URL = "https://baazubvfsrpmbfmrzumw.supabase.co";
const ACAD_SUPABASE_KEY = "sb_publishable_cpAjOHoZL3AMZHaNieb_0A_Tb1kspmh";
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
let hrCompanySettings = { weekly_off_sunday: true, weekly_off_saturday: false };
let myHRDataLoaded = false; // guards loadMyHRData() the same way hr.html's hrLoaded guards loadHRData()

// ---------- HR constants (used by calculation helpers shared across modules) ----------
        const HR_ROLES = {
            production: ['Editor', 'Designer', 'Cinematographer', 'Photographer', 'Video Editor', 'Colorist', 'VFX & Motion Graphics Artist', 'Production Coordinator'],
            education: ['Academic Head', 'Class Coordinator', 'Coaches'], // exactly these 3 — Academic Head & Class Coordinator have identical management access, Coaches see only their own assigned work (see checkAcademicAccess)
            other: [] // Administration/HR/etc. — no preset chips, Designation field covers the title
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
            const [hol, settings] = await Promise.all([
                dbInstance.from('hr_holidays').select('*').order('holiday_date', { ascending: true }),
                dbInstance.from('hr_company_settings').select('*').limit(1)
            ]);
            hrHolidays = hol.data || [];
            if (settings.data && settings.data[0]) hrCompanySettings = settings.data[0];
            myHRDataLoaded = true;
            return;
        }
        const [att, leaveReq, leaveBal, pay, salHist, hol, settings, attLogs] = await Promise.all([
            dbInstance.from('hr_attendance').select('*').eq('employee_id', me.id),
            dbInstance.from('hr_leave_requests').select('*').eq('employee_id', me.id).order('requested_at', { ascending: false }),
            dbInstance.from('hr_leave_balances').select('*').eq('employee_id', me.id),
            dbInstance.from('hr_payroll').select('*').eq('employee_id', me.id).eq('published', true).order('month', { ascending: false }),
            dbInstance.from('hr_salary_history').select('*').eq('employee_id', me.id).order('effective_date', { ascending: false }),
            dbInstance.from('hr_holidays').select('*').order('holiday_date', { ascending: true }),
            dbInstance.from('hr_company_settings').select('*').limit(1),
            // Own raw clock-in log — hrAttDayCode/hrCalculatePayrollForMonth's fallback (via
            // hrPortalLogFor) needs this populated here too, not just from hr.html's loader, or
            // My Attendance can show a gap the same sync failure already fixed elsewhere.
            dbInstance.from('attendance_logs').select('*').eq('employee_email', activeEmail.trim().toLowerCase())
        ]);
        hrEmployees = [me]; // scoped: self-service views only ever need myHREmployeeRecord()'s own row
        hrAttendance = att.data || [];
        hrLeaveRequests = leaveReq.data || [];
        hrLeaveBalances = leaveBal.data || [];
        hrPayroll = pay.data || [];
        hrSalaryHistory = salHist.data || [];
        hrHolidays = hol.data || [];
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
                        // Don't flip an explicit Holiday marking to Present just because someone logged in.
                        const nextStatus = existing.status === 'holiday' ? 'holiday' : computedStatus;
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

            checkAndShowBirthdayPopup(me);

            // New payslip: any published row for me not seen before. First-ever check on this
            // device just records the baseline — otherwise every existing payslip would fire a
            // notification at once the first time someone opens the app on a new device.
            hrPayroll.filter(p => p.employee_id === me.id && p.published === true).forEach(p => {
                if (!_lastKnownPayslipIds.has(p.id)) {
                    if (hadPayslipBaseline) {
                        const monthLabel = (() => { try { const [y,m] = p.month.split('-').map(Number); return new Date(y, m-1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); } catch(e) { return p.month; } })();
                        addNotif('payslip', `Your payslip for ${monthLabel} is now available.`, null, p.id);
                        sendBrowserNotif('New Payslip Available', `Your payslip for ${monthLabel} is now available.`);
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
        async function hrFetchAndApplyMyPhoto() {
            if (!activeEmail || typeof dbInstance === 'undefined' || !dbInstance) return;
            try {
                // select('*') rather than naming photo_base64 explicitly — on a database where
                // that column hasn't been added yet, naming it here makes the whole query error
                // out (PGRST 42703), which silently broke photo sync for every employee, not
                // just ones with an uploaded photo. select('*') degrades gracefully instead:
                // rec.photo_base64 below is just undefined if the column doesn't exist.
                let { data, error } = await dbInstance.from('hr_employees').select('*').eq('portal_email', activeEmail.trim().toLowerCase()).limit(1);
                if (error) { console.warn('HR photo lookup by email failed:', error.message); return; }
                if (!data || !data[0]) {
                    // Fallback: no HR record linked by email — try matching by name instead,
                    // in case this person's HR record was never given a portal email.
                    const byName = await dbInstance.from('hr_employees').select('*').eq('full_name', activeUser).limit(1);
                    if (!byName.error && byName.data && byName.data[0]) data = byName.data;
                }
                if (!data || !data[0]) { console.warn(`HR photo lookup: no hr_employees record found for "${activeUser}" (${activeEmail}). Photo can't sync until HR links this login to an employee record.`); return; }
                const rec = data[0];
                const photo = rec.photo_base64 || (rec.photo_url ? hrConvertDriveUrl(rec.photo_url) : null);
                if (!photo) { console.warn(`HR photo lookup: found employee record "${rec.full_name}" but it has no photo saved yet.`); return; }
                // Sidebar avatar (bottom-left, next to name/role)
                const sidebarAvatar = document.getElementById('sidebar-user-avatar');
                if (sidebarAvatar) {
                    sidebarAvatar.innerHTML = `<img src="${photo}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" onerror="this.remove()">`;
                }
                // "My Profile Photo" widget on the My Settings page
                const img = document.getElementById('my-avatar-img');
                if (img) {
                    img.src = photo;
                    img.classList.remove('hidden');
                    img.onerror = () => img.classList.add('hidden');
                }
            } catch (e) {
                console.warn('Could not load HR-saved profile photo:', e.message);
            }
        }

// ── acadSyncTrainersFromHR (orig line 8306) ──
async function acadSyncTrainersFromHR(){
  if (typeof dbInstance === 'undefined' || !dbInstance) return;
  try {
    const { data: eduEmployees, error } = await dbInstance.from('hr_employees').select('full_name,employment_status').eq('division', 'education');
    if (error || !eduEmployees) return;
    const { data: existingTrainers } = await acadDB.from('trainers').select('id,name');
    const existingByName = new Map((existingTrainers || []).map(t => [String(t.name).trim().toLowerCase(), t]));
    for (const emp of eduEmployees) {
      if (!emp.full_name) continue;
      const key = emp.full_name.trim().toLowerCase();
      const status = emp.employment_status === 'active' ? 'active' : 'inactive';
      const existing = existingByName.get(key);
      if (existing) {
        await acadDB.from('trainers').update({ status }).eq('id', existing.id);
      } else {
        await acadDB.from('trainers').insert({ name: emp.full_name.trim(), type: 'ft', status });
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
                if (rec.status === 'absent') return 'A';
                if (rec.status === 'late') return 'L';
                if (rec.status === 'afternoon') return 'AL'; // Present · Afternoon Login (still counts as Present — see HR_PRESENT_STATUSES)
                if (rec.status === 'on_leave') {
                    // Unpaid leave gets its own code (UL) — it used to render identically to
                    // Absent ('A'), making it impossible to tell "took approved unpaid leave"
                    // apart from "didn't show up, nothing filed" on the grid.
                    const leave = hrLeaveRequests.find(r => r.employee_id === employee.id && r.status === 'approved' && r.start_date <= dateStr && r.end_date >= dateStr);
                    return (leave && leave.leave_type === 'Unpaid Leave') ? 'UL' : 'PL';
                }
                return 'P'; // present, half_day, wfh
            }
            if (hrIsWeeklyOff(dayOfWeek)) return 'WO'; // configurable weekly off, not otherwise marked
            const today = new Date().toISOString().slice(0,10);
            if (dateStr > today) return null; // future, unmarked — blank
            return null; // past, unmarked — blank rather than assuming Present
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
            let paidLeaveDays = 0, unpaidLeaveDays = 0, absentDays = 0, holidayDays = 0, weeklyOffDays = 0, presentDays = 0, halfDayDays = 0, preJoiningDays = 0;

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
                    if (rec.status === 'absent') { absentDays++; continue; }
                    if (rec.status === 'on_leave') {
                        const leave = hrLeaveRequests.find(r => r.employee_id === employeeId && r.status === 'approved' && r.start_date <= dateStr && r.end_date >= dateStr);
                        if (leave && leave.leave_type === 'Unpaid Leave') { unpaidLeaveDays++; continue; }
                        paidLeaveDays++; continue;
                    }
                    if (rec.status === 'half_day') { halfDayDays++; continue; }
                    presentDays++; continue; // present, late, wfh — all worked
                }
                if (hrIsWeeklyOff(dow)) { weeklyOffDays++; continue; }
                // No record, not a weekly-off, not a holiday — genuinely unmarked/unworked → LOP.
                absentDays++;
            }
            // LOP: every day that isn't Present, Approved Paid Leave, Weekly Off, or Holiday —
            // plus pre-joining days, which reduce pay the same way but aren't "LOP" in the
            // attendance-discipline sense, so they're reported separately (see preJoiningDays).
            const lopDays = unpaidLeaveDays + absentDays + halfDayDays * 0.5;
            const payableDays = presentDays + paidLeaveDays + weeklyOffDays + holidayDays + halfDayDays * 0.5;
            const futureDays = daysInMonth - elapsedDays; // not yet occurred — never paid, never LOP'd, simply not evaluated
            // Basic is prorated to the elapsed portion of the month, not always the full salary
            // — for a month that's completely in the past this equals the full salary anyway
            // (elapsedDays === daysInMonth), so nothing changes for normal end-of-month payroll.
            const earnedBasic = Math.round(dailySalary * elapsedDays * 100) / 100;
            const leaveDeduction = Math.round(dailySalary * (lopDays + preJoiningDays) * 100) / 100;
            return { salary, daysInMonth, dailySalary, presentDays, paidLeaveDays, unpaidLeaveDays, absentDays, holidayDays, weeklyOffDays, halfDayDays, preJoiningDays, elapsedDays, futureDays, lopDays, payableDays, earnedBasic, leaveDeduction };
        }

// ── hrProbationEndDate (orig line 10650) ──
        function hrProbationEndDate(employee) {
            if (!employee.joining_date || !employee.probation_months) return null;
            const d = new Date(employee.joining_date);
            d.setMonth(d.getMonth() + Number(employee.probation_months));
            return d.toISOString().slice(0,10);
        }

// ── downloadHRPayslip (orig line 11327) ──
        async function downloadHRPayslip(id) {
            const p = hrPayroll.find(x => x.id === id);
            if (!p) return;
            const e = hrEmployees.find(x => x.id === p.employee_id);
            const doc = await _buildHRPayslipDoc(p, e);
            doc.save(`Payslip_${(e?.full_name||'employee').replace(/\s+/g,'_')}_${p.month}.pdf`);
        }

// ── myHREmployeeRecord (orig line 11445) ──
        function myHREmployeeRecord() {
            return hrEmployees.find(e => (e.portal_email || '').toLowerCase() === (activeEmail || '').toLowerCase());
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
            const myDivisionLabel = { education: 'Education', production: 'Production House', other: 'Other' }[me.division] || me.division;
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
            el.innerHTML = mine.length ? mine.map(p => `
                <tr class="hover:bg-white/[0.02]">
                    <td class="py-2.5 px-4 text-white font-semibold">${p.month}</td>
                    <td class="py-2.5 px-4 text-green-400 font-bold">₹${(p.net_salary||0).toLocaleString('en-IN')}</td>
                    <td class="py-2.5 px-4"><span class="hr-badge hr-badge-${p.payment_status}">${p.payment_status}</span></td>
                    <td class="py-2.5 px-4 text-center"><button onclick="downloadHRPayslip('${p.id}')" class="hr-icon-btn">Download</button></td>
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

// ── BIRTHDAY CELEBRATION — month/day only, never the birth year; works for every
// employee automatically off the existing hr_employees.dob field, nothing hardcoded. ──
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

        // Employee-side popup — once per person per calendar day, persisted in localStorage
        // so it survives reloads/re-polls within the same day rather than a session flag that
        // would just re-show on every refresh.
        function checkAndShowBirthdayPopup(me) {
            if (!me || !isBirthdayToday(me.dob) || !document.getElementById('birthday-popup-overlay')) return;
            const today = new Date().toISOString().slice(0, 10);
            const key = `be_birthday_shown_${(activeEmail || '').toLowerCase()}_${today}`;
            if (localStorage.getItem(key)) return;
            localStorage.setItem(key, '1');
            showBirthdayPopup(me.full_name || activeUser || 'there');
        }

        function showBirthdayPopup(name) {
            const overlay = document.getElementById('birthday-popup-overlay');
            if (!overlay) return;
            const firstName = String(name).trim().split(' ')[0];
            document.getElementById('birthday-popup-name-suffix').textContent = firstName ? ',' : '';
            document.getElementById('birthday-popup-name').textContent = firstName || '';
            const confettiEl = document.getElementById('birthday-confetti');
            if (confettiEl) {
                const pieces = ['🎉','🎈','🎊','✨','🎂'];
                confettiEl.innerHTML = Array.from({ length: 16 }).map(() => {
                    const left = Math.round(Math.random() * 100);
                    const delay = (Math.random() * 0.6).toFixed(2);
                    const dur = (2 + Math.random() * 1.2).toFixed(2);
                    const emoji = pieces[Math.floor(Math.random() * pieces.length)];
                    return `<span class="confetti-piece" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s">${emoji}</span>`;
                }).join('');
            }
            overlay.classList.remove('hidden');
            if (window.lucide) lucide.createIcons();
        }

        function closeBirthdayPopup() {
            document.getElementById('birthday-popup-overlay')?.classList.add('hidden');
        }
