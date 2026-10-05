/* ============================================================================
 * announcements.js — the ONE announcement + notification service for every portal
 * (Media/Production index.html, Sales, Academics, HR, Manager).
 *
 *   HR publishes (hr_announcements) → audience resolution (BEAnnounce.applies)
 *   → realtime event (Supabase postgres_changes; 45 s polling as a safety net)
 *   → toast + short chime + unread badges → Announcement Center (MyWorkspace panel)
 *   → reactions / replies / acknowledgement / read receipts back to HR.
 *
 * Self-starting: it finds the page's Supabase client and the signed-in employee itself,
 * so pages only include the script. Works before the 20261006 migration too (no realtime,
 * no reactions/replies) — features switch on when the tables/columns exist.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.BEAnnounce) return;

  var EMOJIS = ['👍', '❤️', '👏', '✅', '🙏', '🎉'];
  var HEAD_ROLES = ['manager', 'founder', 'co_founder', 'managing_director', 'director', 'academic_head', 'media_head'];
  var POLL_MS = 45000, REPLY_MAX = 500;
  var S = { db: null, email: null, me: null, anns: [], reads: {}, reactions: {}, replyCounts: {}, ready: false,
            hasReactions: true, hasReplies: true, centerRoot: null, filter: 'all', openId: null, listeners: [], channel: null, live: false };

  // ── helpers ────────────────────────────────────────────────────────────────
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function ago(iso) {
    var t = new Date(iso).getTime(); if (isNaN(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function link(u) { u = String(u || '').trim(); if (!u) return ''; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; return u; }
  function imgSrc(u) { u = link(u); if (!u) return ''; try { if (typeof hrConvertDriveUrl === 'function') return hrConvertDriveUrl(u); } catch (_) {} return u; }
  function ids(v) { if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = []; } } return Array.isArray(v) ? v.map(String) : []; }
  function pubTime(a) { return a.published_at || a.created_at; }
  function likeExact(v) { return String(v || '').replace(/[\\%_]/g, function (c) { return '\\' + c; }); }
  function client() {
    if (S.db) return S.db;
    try { if (typeof dbInstance !== 'undefined' && dbInstance && dbInstance.from) return (S.db = dbInstance); } catch (_) {}
    try { if (typeof sb !== 'undefined' && sb && sb.from) return (S.db = sb); } catch (_) {}
    try {
      var u = typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : null;
      var k = typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : (typeof SUPABASE_KEY !== 'undefined' ? SUPABASE_KEY : null);
      if (u && k && window.supabase) return (S.db = window.supabase.createClient(u, k));
    } catch (_) {}
    return null;
  }
  function sessionEmail() {
    try { var a = localStorage.getItem('be_active_email'); if (a) return a.trim().toLowerCase(); } catch (_) {}
    try { var m = JSON.parse(localStorage.getItem('be_media_academic_session') || 'null'); if (m && m.email) return String(m.email).trim().toLowerCase(); } catch (_) {}
    return null;
  }

  // ── audience (single source of truth, also used by HR + common.js) ─────────
  function isActiveEmp(e) { return e && (e.employment_status || 'active') === 'active' && e.portal_access_enabled !== false && e.account_type !== 'system'; }
  function isTrainer(e) { return e && e.division === 'education' && !/head|coordinator/i.test(String(e.department || '') + ' ' + String(e.designation || '')); }
  function isHead(e) {
    if (!e) return false;
    if (e.account_type === 'management' || HEAD_ROLES.indexOf(String(e.system_role || '').toLowerCase()) > -1) return true;
    return /head|manager|lead|coordinator/i.test(String(e.department || '') + ' ' + String(e.designation || ''));
  }
  function applies(a, e) {
    var aud = a.audience || 'all';
    if (!e) return aud === 'all';                    // no linked HR record → company-wide only
    if (e.employment_status && e.employment_status !== 'active') return false;
    if (aud === 'all') return true;
    if (aud === 'selected') return ids(a.audience_employee_ids).indexOf(String(e.id)) > -1;
    if (aud === 'departments') return ids(a.audience_departments).indexOf(String(e.division)) > -1;
    if (aud === 'trainers') return isTrainer(e);
    if (aud === 'heads') return isHead(e);
    return aud === e.division;                       // legacy single-department value
  }
  function isLive(a) {
    if (a.archived_at) return false;
    var n = Date.now();
    if (a.start_at && n < new Date(a.start_at).getTime()) return false;
    if (a.end_at && n > new Date(a.end_at).getTime()) return false;
    return true;
  }
  function isPast(a) { return !!a.archived_at || (a.end_at && Date.now() > new Date(a.end_at).getTime()); }
  function mine() { return S.anns.filter(function (a) { return applies(a, S.me) && !(a.start_at && Date.now() < new Date(a.start_at).getTime()); }); }
  function isRead(a) { return !!S.reads[String(a.id)]; }
  function unreadList() { return mine().filter(function (a) { return isLive(a) && !isRead(a); }); }
  function isUpdated(a) { var r = S.reads[String(a.id)]; return (a.notify_seq || 0) > 0 && a.edited_at && r && r.read_at && new Date(a.edited_at) > new Date(r.read_at); }

  // ── styles ─────────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('be-ann-css')) return;
    var s = document.createElement('style'); s.id = 'be-ann-css';
    s.textContent = [
      '.be-ann-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;margin-left:auto;border-radius:9px;background:#ef4444;color:#fff;font:800 10px/1 Inter,system-ui,sans-serif}',
      '.be-ann-pulse{animation:beAnnPulse 1.6s ease-in-out 3}',
      '@keyframes beAnnPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,107,6,0)}50%{box-shadow:0 0 0 4px rgba(255,107,6,.28)}}',
      '.be-ann-toasts{position:fixed;top:16px;right:16px;z-index:100000;display:flex;flex-direction:column;gap:10px;width:min(380px,calc(100vw - 32px));pointer-events:none}',
      '.be-ann-toast{pointer-events:auto;background:#10131f;border:1px solid rgba(255,255,255,.1);border-left:4px solid #ff6b06;border-radius:14px;padding:14px 16px;box-shadow:0 18px 44px rgba(0,0,0,.55);color:#e6e9f5;font-family:Inter,system-ui,sans-serif;transform:translateY(-8px);opacity:0;transition:transform .25s,opacity .25s}',
      '.be-ann-toast.on{transform:none;opacity:1}',
      '.be-ann-toast.important{border-left-color:#f59e0b}.be-ann-toast.urgent{border-left-color:#ef4444;background:linear-gradient(180deg,rgba(239,68,68,.12),#10131f 60%)}',
      '.be-ann-toast .k{display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#ff8a3c}',
      '.be-ann-toast.important .k{color:#fbbf24}.be-ann-toast.urgent .k{color:#f87171}',
      '.be-ann-toast .t{font-size:15px;font-weight:700;margin:6px 0 4px;color:#fff;line-height:1.3}',
      '.be-ann-toast .m{font-size:12.5px;color:#a5adcf;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.be-ann-toast .row{display:flex;gap:8px;margin-top:12px}',
      '.be-ann-btn{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e6e9f5;font:700 12px Inter,system-ui,sans-serif;padding:8px 12px;border-radius:9px;cursor:pointer}',
      '.be-ann-btn:hover{background:rgba(255,255,255,.1)}.be-ann-btn:focus-visible{outline:2px solid rgba(255,138,60,.6);outline-offset:1px}',
      '.be-ann-btn.p{background:linear-gradient(135deg,#ff6b06,#f9182f);border-color:transparent;color:#fff}',
      '.be-ann-btn:disabled{opacity:.55;cursor:default}',
      // centre
      '.be-annc{display:grid;gap:14px}',
      '.be-annc-top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}',
      '.be-annc-top h2{margin:0;font:800 20px Inter,system-ui,sans-serif;color:#fff}.be-annc-top p{margin:4px 0 0;font-size:12.5px;color:#8890b5}',
      '.be-annc-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.be-annc-chip{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#a5adcf;font:600 12px Inter,system-ui,sans-serif;padding:6px 12px;border-radius:999px;cursor:pointer}',
      '.be-annc-chip.on{background:rgba(255,107,6,.14);border-color:rgba(255,107,6,.45);color:#fff}',
      '.be-annc-snd{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:#a5adcf;cursor:pointer}',
      '.be-annc-snd input{accent-color:#ff6b06}',
      '.be-annc-list{display:grid;gap:10px}',
      '.be-annc-card{display:block;width:100%;text-align:left;cursor:pointer;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px 16px;color:#e6e9f5;font-family:Inter,system-ui,sans-serif;transition:border-color .15s,background .15s}',
      '.be-annc-card:hover{border-color:rgba(255,255,255,.18)}',
      '.be-annc-card.new{background:rgba(255,107,6,.06);border-color:rgba(255,107,6,.35)}',
      '.be-annc-card.urgent{box-shadow:inset 3px 0 0 #ef4444}.be-annc-card.important{box-shadow:inset 3px 0 0 #f59e0b}',
      '.be-annc-card.past{opacity:.6}',
      '.be-annc-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.be-annc-h b{font-size:15px;color:#fff}',
      '.be-annc-ex{font-size:13px;color:#a5adcf;margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.be-annc-meta{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:11.5px;color:#6b74a0}',
      '.be-annc-pill{display:inline-flex;align-items:center;gap:4px;font:800 9.5px Inter,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:999px}',
      '.be-annc-pill.new{background:#ff6b06;color:#fff}.be-annc-pill.urg{background:rgba(239,68,68,.16);color:#fca5a5}.be-annc-pill.imp{background:rgba(245,158,11,.16);color:#fcd34d}',
      '.be-annc-pill.pin{background:rgba(96,165,250,.14);color:#93c5fd}.be-annc-pill.upd{background:rgba(167,139,250,.16);color:#c4b5fd}.be-annc-pill.ack{background:rgba(34,197,94,.14);color:#86efac}.be-annc-pill.past{background:rgba(255,255,255,.07);color:#94a3b8}',
      '.be-annc-empty{padding:40px 16px;text-align:center;color:#6b74a0;font-size:13px;border:1px dashed rgba(255,255,255,.1);border-radius:14px}',
      // detail modal
      '.be-annm-bg{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.7);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px}',
      '.be-annm{width:min(720px,100%);max-height:calc(100vh - 32px);overflow:auto;background:#0d1120;border:1px solid rgba(255,255,255,.1);border-radius:18px;color:#e6e9f5;font-family:Inter,system-ui,sans-serif;box-shadow:0 30px 80px rgba(0,0,0,.6)}',
      '.be-annm-h{display:flex;justify-content:space-between;gap:12px;padding:20px 22px 12px}',
      '.be-annm-h h3{margin:8px 0 4px;font-size:20px;font-weight:800;color:#fff;line-height:1.25;text-wrap:balance}',
      '.be-annm-h .s{font-size:12px;color:#8890b5}',
      '.be-annm-x{width:34px;height:34px;flex-shrink:0;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#a5adcf;cursor:pointer;font-size:15px}',
      '.be-annm-b{padding:0 22px 20px;display:grid;gap:16px}',
      '.be-annm-msg{font-size:14px;line-height:1.65;color:#dfe3f1;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.be-annm-img{max-width:100%;border-radius:12px;border:1px solid rgba(255,255,255,.08)}',
      '.be-annm-links{display:flex;gap:8px;flex-wrap:wrap}',
      '.be-annm-sec{border-top:1px solid rgba(255,255,255,.07);padding-top:14px}',
      '.be-annm-sec h4{margin:0 0 10px;font:800 10.5px Inter,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#8890b5}',
      '.be-annm-rx{display:flex;gap:8px;flex-wrap:wrap}',
      '.be-annm-rx button{min-width:54px;height:40px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#e6e9f5;font:600 15px Inter,system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
      '.be-annm-rx button span{font-size:12px;color:#a5adcf}',
      '.be-annm-rx button.mine{border-color:rgba(255,107,6,.6);background:rgba(255,107,6,.12)}',
      '.be-annm-ack{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;border-radius:12px;border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.07);font-size:13px}',
      '.be-annm-ack.done{border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.07)}',
      '.be-annm-rep{display:grid;gap:10px;max-height:300px;overflow:auto}',
      '.be-annm-rep div{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:9px 12px;font-size:13px;line-height:1.5;overflow-wrap:anywhere}',
      '.be-annm-rep b{color:#fff;font-size:12.5px}.be-annm-rep small{color:#6b74a0;margin-left:6px}',
      '.be-annm-form{display:flex;gap:8px;margin-top:10px;align-items:flex-end}',
      '.be-annm-form textarea{flex:1;min-height:42px;max-height:120px;resize:vertical;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#e6e9f5;font:13px Inter,system-ui,sans-serif;padding:10px 12px}',
      '@media (max-width:640px){.be-ann-toasts{top:auto;bottom:90px;right:12px;left:12px;width:auto}.be-annm-h,.be-annm-b{padding-left:16px;padding-right:16px}.be-annm-form{flex-direction:column;align-items:stretch}}',
      '@media (prefers-reduced-motion:reduce){.be-ann-pulse{animation:none}.be-ann-toast{transition:none}}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── sound: short two-note chime, synthesized (no file), once per new announcement ──
  var actx = null;
  function soundOn() { return lsGet('be_ann_sound', true) !== false; }
  function unlockAudio() {
    try {
      if (!actx) { var C = window.AudioContext || window.webkitAudioContext; if (!C) return; actx = new C(); }
      if (actx.state === 'suspended') actx.resume();
    } catch (_) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, unlockAudio, { passive: true }); });
  function chime(priority) {
    if (!soundOn()) return;
    try {
      if (!actx || actx.state !== 'running') return;          // browser hasn't allowed audio yet — visuals still show
      var t0 = actx.currentTime + 0.02, notes = priority === 'urgent' ? [659.25, 987.77, 1318.5] : [659.25, 987.77];
      notes.forEach(function (f, i) {
        var o = actx.createOscillator(), g = actx.createGain(), st = t0 + i * 0.16;
        o.type = 'sine'; o.frequency.setValueAtTime(f, st);
        g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(priority === 'normal' ? 0.09 : 0.13, st + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, st + 0.7);
        o.connect(g); g.connect(actx.destination); o.start(st); o.stop(st + 0.75);
      });
    } catch (_) {}
  }

  // ── toast ──────────────────────────────────────────────────────────────────
  function toast(a, kind) {
    css();
    var host = document.querySelector('.be-ann-toasts');
    if (!host) { host = document.createElement('div'); host.className = 'be-ann-toasts'; host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
    var pr = a ? (a.priority || 'normal') : 'normal';
    var el = document.createElement('div');
    el.className = 'be-ann-toast ' + pr; el.setAttribute('role', pr === 'urgent' ? 'alert' : 'status');
    var head = kind === 'updated' ? 'Announcement updated' : kind === 'summary' ? 'Unread HR announcements' : (pr === 'urgent' ? 'Urgent HR announcement' : pr === 'important' ? 'Important HR announcement' : 'New HR announcement');
    var title = kind === 'summary' ? a.title : (a.title || 'Announcement');
    var msg = kind === 'summary' ? a.message : String(a.message || '').slice(0, 220);
    el.innerHTML = '<div class="k"><span aria-hidden="true">📢</span>' + esc(head) + '</div><div class="t">' + esc(title) + '</div>' + (msg ? '<div class="m">' + esc(msg) + '</div>' : '')
      + '<div class="row"><button class="be-ann-btn p" data-v>' + (kind === 'summary' ? 'View announcements' : 'View announcement') + '</button><button class="be-ann-btn" data-x>Dismiss</button></div>';
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    var close = function () { el.classList.remove('on'); setTimeout(function () { el.remove(); }, 260); };
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('[data-v]').onclick = function () { close(); openCenter(kind === 'summary' ? null : a.id); };
    setTimeout(close, pr === 'urgent' ? 30000 : pr === 'important' ? 16000 : 10000);
  }

  // ── badges + nav highlight ─────────────────────────────────────────────────
  function navItems() {
    return [].slice.call(document.querySelectorAll('[onclick*="\'announcements\'"],[data-tab="announcements"]'))
      .filter(function (n) { return /BUTTON|A/.test(n.tagName) && !n.closest('.be-annm-bg,.be-ann-toasts'); });
  }
  function renderBadges(pulse) {
    var n = unreadList().length, txt = n > 99 ? '99+' : String(n);
    ['announcements-badge-sidebar', 'announcements-badge-mobile'].forEach(function (id) { var b = document.getElementById(id); if (b) { b.textContent = txt; b.style.display = n ? 'inline-block' : 'none'; } });
    navItems().forEach(function (item) {
      if (item.querySelector('#announcements-badge-sidebar,#announcements-badge-mobile')) return;
      var b = item.querySelector('.be-ann-badge');
      if (!b && n) { b = document.createElement('span'); b.className = 'be-ann-badge'; item.appendChild(b); if (getComputedStyle(item).display !== 'flex') { item.style.display = 'flex'; item.style.alignItems = 'center'; } }
      if (b) { b.textContent = txt; b.style.display = n ? '' : 'none'; }
      if (pulse && n) { item.classList.remove('be-ann-pulse'); void item.offsetWidth; item.classList.add('be-ann-pulse'); }
    });
    S.listeners.forEach(function (fn) { try { fn(n); } catch (_) {} });
  }

  // ── navigation to the Announcement Center ─────────────────────────────────
  function openCenter(id) {
    if (id != null) S.pendingOpen = String(id);
    var go = null;
    if (typeof window.acadSwitchTab === 'function') go = function () { window.acadSwitchTab('announcements'); };
    else if (typeof window.switchHRSubtab === 'function' && document.getElementById('hr-sub-announcements')) go = function () { window.switchHRSubtab('announcements'); };
    else if (typeof window.switchTab === 'function') go = function () { window.switchTab('announcements'); };
    if (go) go(); else if (navItems()[0]) navItems()[0].click();
    if (id != null && S.centerRoot && document.body.contains(S.centerRoot)) setTimeout(function () { if (S.pendingOpen) { var p = S.pendingOpen; S.pendingOpen = null; openDetail(p); } }, 350);
  }

  // ── data ───────────────────────────────────────────────────────────────────
  async function loadMe() {
    S.email = sessionEmail();
    if (!S.email) return;
    try {
      var r = await client().from('hr_employees').select('id,full_name,division,department,designation,system_role,account_type,employment_status,portal_access_enabled').eq('portal_email', S.email);
      var rows = r.data || [];
      S.me = rows.find(function (x) { return (x.employment_status || 'active') === 'active'; }) || rows[0] || null;
    } catch (_) {}
  }
  async function loadAll() {
    var db = client(); if (!db) return;
    var res = await Promise.all([
      db.from('hr_announcements').select('*').order('created_at', { ascending: false }),
      S.email ? db.from('hr_announcement_reads').select('announcement_id,read_at,acknowledged_at,employee_email').ilike('employee_email', likeExact(S.email)) : Promise.resolve({ data: [] }),
      db.from('hr_announcement_reactions').select('announcement_id,emoji,employee_email'),
      db.from('hr_announcement_replies').select('announcement_id,hidden_at')
    ]);
    if (res[0].error) return;
    S.anns = res[0].data || [];
    S.reads = {}; (res[1].data || []).forEach(function (r) { S.reads[String(r.announcement_id)] = r; });
    S.hasReactions = !res[2].error; S.reactions = {};
    (res[2].data || []).forEach(function (r) { var k = String(r.announcement_id); (S.reactions[k] = S.reactions[k] || {})[String(r.employee_email).toLowerCase()] = r.emoji; });
    S.hasReplies = !res[3].error; S.replyCounts = {};
    (res[3].data || []).forEach(function (r) { if (r.hidden_at) return; var k = String(r.announcement_id); S.replyCounts[k] = (S.replyCounts[k] || 0) + 1; });
  }
  function notifiedKey() { return 'be_ann_notified_' + (S.email || 'anon'); }
  function markNotified(a) { var m = lsGet(notifiedKey(), {}); m[String(a.id)] = a.notify_seq || 0; lsSet(notifiedKey(), m); }
  function wasNotified(a) { var m = lsGet(notifiedKey(), {}); return Object.prototype.hasOwnProperty.call(m, String(a.id)) && m[String(a.id)] >= (a.notify_seq || 0); }

  // New-arrival handling, shared by realtime and polling.
  function announce(a, kind) {
    if (!applies(a, S.me) || !isLive(a)) return;
    if (kind !== 'updated' && isRead(a)) { markNotified(a); return; }
    if (wasNotified(a)) return;
    markNotified(a);
    toast(a, kind || 'new');
    chime(a.priority || 'normal');
    renderBadges(true);
  }
  function upsertAnn(row) {
    var i = S.anns.findIndex(function (x) { return String(x.id) === String(row.id); });
    var prev = i > -1 ? S.anns[i] : null;
    if (i > -1) S.anns[i] = row; else S.anns.unshift(row);
    return prev;
  }
  function refreshViews() {
    renderBadges(false);
    if (S.centerRoot && document.body.contains(S.centerRoot)) renderList();
    if (S.openId) { var m = document.querySelector('.be-annm-bg'); if (m) fillDetail(m, S.openId, true); }
  }
  var _rt = null;
  function scheduleRefresh() { clearTimeout(_rt); _rt = setTimeout(refreshViews, 250); }

  // ── realtime ───────────────────────────────────────────────────────────────
  function subscribe() {
    var db = client(); if (!db || !db.channel || S.channel) return;
    try {
      S.channel = db.channel('be-announcements-' + Math.random().toString(36).slice(2, 8))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_announcements' }, function (p) {
          if (p.eventType === 'DELETE') { S.anns = S.anns.filter(function (x) { return String(x.id) !== String(p.old && p.old.id); }); scheduleRefresh(); return; }
          var row = p.new, prev = upsertAnn(row);
          if (p.eventType === 'INSERT') announce(row, 'new');
          else if (prev && (row.notify_seq || 0) > (prev.notify_seq || 0)) announce(row, 'updated');
          scheduleRefresh();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_announcement_reactions' }, function (p) {
          var r = p.eventType === 'DELETE' ? p.old : p.new; if (!r || r.announcement_id == null) return;
          var k = String(r.announcement_id), em = String(r.employee_email || '').toLowerCase();
          S.reactions[k] = S.reactions[k] || {};
          if (p.eventType === 'DELETE') { if (em) delete S.reactions[k][em]; else loadAll().then(scheduleRefresh); } else S.reactions[k][em] = r.emoji;
          scheduleRefresh();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_announcement_replies' }, function (p) {
          var r = p.new || p.old; if (!r) return;
          var k = String(r.announcement_id);
          if (p.eventType === 'INSERT' && !r.hidden_at) S.replyCounts[k] = (S.replyCounts[k] || 0) + 1;
          else loadAll().then(scheduleRefresh);
          if (S.openId === k) { var m = document.querySelector('.be-annm-bg'); if (m) loadReplies(m, k); }
          scheduleRefresh();
          window.dispatchEvent(new CustomEvent('be-ann-reply', { detail: r }));
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_announcement_reads' }, function (p) {
          var r = p.new; if (r && S.email && String(r.employee_email || '').toLowerCase() === S.email) { S.reads[String(r.announcement_id)] = r; scheduleRefresh(); }
          window.dispatchEvent(new CustomEvent('be-ann-read', { detail: r }));
        })
        .subscribe(function (status) { S.live = status === 'SUBSCRIBED'; });
    } catch (_) {}
  }
  // Safety net: catches announcements if realtime isn't enabled yet / the socket dropped,
  // and scheduled announcements whose start time has just arrived.
  async function poll() {
    if (document.hidden) return;
    var before = {}; S.anns.forEach(function (a) { before[String(a.id)] = a.notify_seq || 0; });
    await loadAll();
    S.anns.forEach(function (a) {
      var k = String(a.id);
      if (!(k in before)) announce(a, 'new');
      else if ((a.notify_seq || 0) > before[k]) announce(a, 'updated');
      else if (isLive(a) && !isRead(a) && !wasNotified(a)) announce(a, 'new');   // scheduled one just went live
    });
    refreshViews();
  }

  // ── reads / reactions / replies / acknowledgement ─────────────────────────
  async function markRead(a) {
    if (!S.email || isRead(a)) return;
    var row = { announcement_id: a.id, employee_email: S.email, read_at: new Date().toISOString() };
    if (S.me) row.employee_id = S.me.id;
    S.reads[String(a.id)] = row;
    var r = await client().from('hr_announcement_reads').insert(row);
    if (r.error && /employee_id/.test(r.error.message || '')) { delete row.employee_id; await client().from('hr_announcement_reads').insert(row); }
    renderBadges(false);
    try { if (typeof window.renderAnnouncementBadge === 'function') window.renderAnnouncementBadge(); } catch (_) {}
  }
  async function react(a, emoji) {
    if (!S.email || !S.hasReactions) return;
    var k = String(a.id), cur = (S.reactions[k] || {})[S.email];
    S.reactions[k] = S.reactions[k] || {};
    var db = client();
    if (cur === emoji) {                                   // tap again = remove
      delete S.reactions[k][S.email];
      await db.from('hr_announcement_reactions').delete().eq('announcement_id', a.id).ilike('employee_email', likeExact(S.email));
    } else {
      S.reactions[k][S.email] = emoji;
      var ex = await db.from('hr_announcement_reactions').select('id').eq('announcement_id', a.id).ilike('employee_email', likeExact(S.email)).limit(1);
      if (ex.data && ex.data[0]) await db.from('hr_announcement_reactions').update({ emoji: emoji, updated_at: new Date().toISOString() }).eq('id', ex.data[0].id);
      else await db.from('hr_announcement_reactions').insert({ announcement_id: a.id, employee_email: S.email, employee_id: S.me ? S.me.id : null, emoji: emoji });
    }
    scheduleRefresh();
  }
  async function acknowledge(a) {
    if (!S.email) return;
    var now = new Date().toISOString();
    await markRead(a);
    var r = await client().from('hr_announcement_reads').update({ acknowledged_at: now }).eq('announcement_id', a.id).ilike('employee_email', likeExact(S.email));
    if (!r.error) { S.reads[String(a.id)].acknowledged_at = now; scheduleRefresh(); }
    return r;
  }
  async function loadReplies(m, k) {
    var box = m.querySelector('[data-replies]'); if (!box) return;
    var r = await client().from('hr_announcement_replies').select('*').eq('announcement_id', k).is('hidden_at', null).order('created_at', { ascending: true });
    var rows = r.data || [];
    var h = m.querySelector('[data-reply-count]'); if (h) h.textContent = rows.length;
    box.innerHTML = rows.length ? rows.map(function (x) { return '<div><b>' + esc(x.author_name || 'Employee') + '</b><small>' + esc(ago(x.created_at)) + '</small><br>' + esc(x.body) + '</div>'; }).join('') : '<span style="font-size:12.5px;color:#6b74a0">No replies yet.</span>';
    box.scrollTop = box.scrollHeight;
  }
  async function sendReply(a, body) {
    body = String(body || '').trim().slice(0, REPLY_MAX);
    if (!body || !S.email) return { error: { message: 'empty' } };
    return client().from('hr_announcement_replies').insert({ announcement_id: a.id, employee_email: S.email, employee_id: S.me ? S.me.id : null, author_name: S.me ? S.me.full_name : S.email, body: body });
  }

  // ── Announcement Center ───────────────────────────────────────────────────
  function pills(a) {
    var h = '';
    if (!isRead(a) && isLive(a)) h += '<span class="be-annc-pill new">New</span>';
    if (isUpdated(a)) h += '<span class="be-annc-pill upd">Updated</span>';
    if (a.pinned && isLive(a)) h += '<span class="be-annc-pill pin">📌 Pinned</span>';
    if (a.priority === 'urgent') h += '<span class="be-annc-pill urg">Urgent</span>'; else if (a.priority === 'important') h += '<span class="be-annc-pill imp">Important</span>';
    if (a.require_ack) { var r = S.reads[String(a.id)]; h += r && r.acknowledged_at ? '<span class="be-annc-pill ack">✓ Acknowledged</span>' : '<span class="be-annc-pill imp">Acknowledge</span>'; }
    if (isPast(a)) h += '<span class="be-annc-pill past">' + (a.archived_at ? 'Archived' : 'Expired') + '</span>';
    return h;
  }
  function rxSummary(a) {
    var c = counts(a); return EMOJIS.filter(function (e) { return c[e]; }).map(function (e) { return e + ' ' + c[e]; }).join('  ');
  }
  function counts(a) { var c = {}, m = S.reactions[String(a.id)] || {}; Object.keys(m).forEach(function (k) { c[m[k]] = (c[m[k]] || 0) + 1; }); return c; }
  function renderCenter(root) {
    css(); S.centerRoot = root;
    var n = unreadList().length;
    root.innerHTML = '<div class="be-annc"><div class="be-annc-top"><div><h2>Announcements</h2><p>Official messages from HR for you and your team.' + (n ? ' <b style="color:#ff8a3c">' + n + ' unread</b>' : '') + '</p></div>'
      + '<label class="be-annc-snd"><input type="checkbox" data-snd ' + (soundOn() ? 'checked' : '') + '> Announcement sound</label></div>'
      + '<div class="be-annc-chips">' + [['all', 'All'], ['unread', 'Unread'], ['important', 'Important'], ['pinned', 'Pinned'], ['read', 'Read'], ['past', 'Past']].map(function (f) { return '<button class="be-annc-chip' + (S.filter === f[0] ? ' on' : '') + '" data-f="' + f[0] + '">' + f[1] + '</button>'; }).join('') + '</div>'
      + '<div class="be-annc-list" data-list></div></div>';
    root.querySelector('[data-snd]').onchange = function () { lsSet('be_ann_sound', this.checked); if (this.checked) { unlockAudio(); chime('normal'); } };
    root.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { S.filter = b.getAttribute('data-f'); renderCenter(root); }; });
    renderList();
    if (S.pendingOpen) { var p = S.pendingOpen; S.pendingOpen = null; openDetail(p); }
  }
  function renderList() {
    var root = S.centerRoot; if (!root) return; var box = root.querySelector('[data-list]'); if (!box) return;
    var f = S.filter, list = mine().filter(function (a) {
      if (f === 'past') return isPast(a);
      if (isPast(a)) return false;
      if (f === 'unread') return !isRead(a);
      if (f === 'read') return isRead(a);
      if (f === 'important') return a.priority === 'important' || a.priority === 'urgent';
      if (f === 'pinned') return !!a.pinned;
      return true;
    }).sort(function (x, y) { return (f !== 'past' && (!!y.pinned - !!x.pinned)) || String(pubTime(y)).localeCompare(String(pubTime(x))); });
    box.innerHTML = list.length ? list.map(function (a) {
      var ex = String(a.message || ''), rc = S.replyCounts[String(a.id)] || 0, rx = rxSummary(a);
      return '<button class="be-annc-card' + (!isRead(a) && isLive(a) ? ' new' : '') + (a.priority === 'urgent' ? ' urgent' : a.priority === 'important' ? ' important' : '') + (isPast(a) ? ' past' : '') + '" data-a="' + esc(a.id) + '">'
        + '<div class="be-annc-h"><span aria-hidden="true">📢</span><b>' + esc(a.title || 'Announcement') + '</b>' + pills(a) + '</div>'
        + '<div class="be-annc-ex">' + esc(ex) + '</div>'
        + '<div class="be-annc-meta"><span>' + esc(a.published_by || a.created_by || 'HR') + ' · ' + esc(ago(pubTime(a))) + '</span>' + (rx ? '<span>' + esc(rx) + '</span>' : '') + (a.allow_replies ? '<span>💬 ' + rc + (rc === 1 ? ' reply' : ' replies') + '</span>' : '') + '</div></button>';
    }).join('') : '<div class="be-annc-empty">' + (f === 'unread' ? 'You\'re all caught up — no unread announcements.' : f === 'past' ? 'No past announcements.' : 'No announcements here yet.') + '</div>';
    box.querySelectorAll('[data-a]').forEach(function (b) { b.onclick = function () { openDetail(b.getAttribute('data-a')); }; });
  }
  function openDetail(id) {
    var a = S.anns.find(function (x) { return String(x.id) === String(id); }); if (!a || !applies(a, S.me)) return;
    css();
    var old = document.querySelector('.be-annm-bg'); if (old) old.remove();
    var m = document.createElement('div'); m.className = 'be-annm-bg'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    document.body.appendChild(m);
    S.openId = String(a.id);
    var close = function () { S.openId = null; m.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    m._close = close;
    fillDetail(m, a.id, false);
    if (a.allow_replies && S.hasReplies) loadReplies(m, String(a.id));
    markRead(a).then(function () { if (S.centerRoot) renderList(); });
  }
  function fillDetail(m, id, partial) {
    var a = S.anns.find(function (x) { return String(x.id) === String(id); }); if (!a) return;
    var k = String(a.id), r = S.reads[k], c = counts(a), my = (S.reactions[k] || {})[S.email];
    var rxHTML = S.hasReactions ? EMOJIS.map(function (e) { return '<button data-rx="' + e + '" class="' + (my === e ? 'mine' : '') + '" aria-pressed="' + (my === e) + '" aria-label="React ' + e + '">' + e + (c[e] ? ' <span>' + c[e] + '</span>' : '') + '</button>'; }).join('') : '';
    if (partial && m.querySelector('[data-rxbar]')) {             // live update: only the parts that change
      m.querySelector('[data-rxbar]').innerHTML = rxHTML; wireRx(m, a);
      var ackBox = m.querySelector('[data-ackbox]'); if (ackBox) ackBox.outerHTML = ackHTML(a); wireAck(m, a);
      return;
    }
    var img = imgSrc(a.image_url), lk = link(a.link_url), att = link(a.attachment_url);
    m.innerHTML = '<div class="be-annm"><div class="be-annm-h"><div><div class="be-annc-h">' + pills(a) + (a.category ? '<span class="be-annc-pill past">' + esc(a.category) + '</span>' : '') + '</div>'
      + '<h3>' + esc(a.title || 'Announcement') + '</h3><div class="s">Published by ' + esc(a.published_by || a.created_by || 'HR') + ' · ' + esc(new Date(pubTime(a)).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))
      + (a.edited_at && (a.notify_seq || 0) > 0 ? ' · updated ' + esc(ago(a.edited_at)) : '') + (a.end_at ? ' · until ' + esc(new Date(a.end_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })) : '') + '</div></div>'
      + '<button class="be-annm-x" aria-label="Close">✕</button></div>'
      + '<div class="be-annm-b"><div class="be-annm-msg">' + esc(a.message || '') + '</div>'
      + (img ? '<img class="be-annm-img" src="' + esc(img) + '" alt="" loading="lazy" onerror="this.remove()">' : '')
      + (lk || att ? '<div class="be-annm-links">' + (lk ? '<a class="be-ann-btn" href="' + esc(lk) + '" target="_blank" rel="noopener">Open link ↗</a>' : '') + (att ? '<a class="be-ann-btn" href="' + esc(att) + '" target="_blank" rel="noopener">View document ↗</a>' : '') + '</div>' : '')
      + ackHTML(a)
      + (S.hasReactions ? '<div class="be-annm-sec"><h4>React</h4><div class="be-annm-rx" data-rxbar>' + rxHTML + '</div></div>' : '')
      + (S.hasReplies ? '<div class="be-annm-sec"><h4>Replies (<span data-reply-count>' + (S.replyCounts[k] || 0) + '</span>)</h4>'
        + (a.allow_replies ? '<div class="be-annm-rep" data-replies><span style="font-size:12.5px;color:#6b74a0">Loading…</span></div>'
          + (isPast(a) ? '' : '<div class="be-annm-form"><textarea maxlength="' + REPLY_MAX + '" placeholder="Write a reply…" data-reply aria-label="Write a reply"></textarea><button class="be-ann-btn p" data-send>Send</button></div><div style="font-size:11px;color:#6b74a0;margin-top:4px">Short replies only (max ' + REPLY_MAX + ' characters). HR can see every reply.</div>')
          : '<span style="font-size:12.5px;color:#6b74a0">Replies are turned off for this announcement.</span>') + '</div>' : '')
      + '</div></div>';
    m.querySelector('.be-annm-x').onclick = function () { m._close && m._close(); };
    wireRx(m, a); wireAck(m, a);
    var send = m.querySelector('[data-send]');
    if (send) send.onclick = async function () {
      var t = m.querySelector('[data-reply]'); var v = t.value.trim(); if (!v) return;
      send.disabled = true; var res = await sendReply(a, v); send.disabled = false;
      if (res && res.error) { t.style.borderColor = '#ef4444'; return; }
      t.value = ''; loadReplies(m, k);
    };
  }
  function ackHTML(a) {
    if (!a.require_ack) return '';
    var r = S.reads[String(a.id)];
    return r && r.acknowledged_at
      ? '<div class="be-annm-ack done" data-ackbox><span>✓ You acknowledged this on ' + esc(new Date(r.acknowledged_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + '.</span></div>'
      : '<div class="be-annm-ack" data-ackbox><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" data-ackchk style="accent-color:#ff6b06"> I have read and understood this announcement.</label><button class="be-ann-btn p" data-ack disabled>Acknowledge</button></div>';
  }
  function wireAck(m, a) {
    var chk = m.querySelector('[data-ackchk]'), b = m.querySelector('[data-ack]');
    if (!chk || !b) return;
    chk.onchange = function () { b.disabled = !chk.checked; };
    b.onclick = async function () { b.disabled = true; await acknowledge(a); var box = m.querySelector('[data-ackbox]'); if (box) box.outerHTML = ackHTML(a); };
  }
  function wireRx(m, a) { m.querySelectorAll('[data-rx]').forEach(function (b) { b.onclick = function () { react(a, b.getAttribute('data-rx')); fillDetail(m, a.id, true); }; }); }

  // ── start ──────────────────────────────────────────────────────────────────
  async function start() {
    if (S.started) return; S.started = true;
    if (!client()) return;
    css();
    await loadMe();
    await loadAll();
    S.ready = true;
    // Offline catch-up: one summary toast for unread announcements published while away.
    var pending = unreadList().filter(function (a) { return !wasNotified(a); });
    pending.forEach(markNotified);
    if (pending.length === 1) { toast(pending[0], 'new'); chime(pending[0].priority || 'normal'); }
    else if (pending.length > 1) { var top = pending.some(function (a) { return a.priority === 'urgent'; }) ? 'urgent' : pending.some(function (a) { return a.priority === 'important'; }) ? 'important' : 'normal';
      toast({ title: pending.length + ' unread announcements', message: pending.slice(0, 3).map(function (a) { return a.title; }).join(' · '), priority: top }, 'summary'); chime(top); }
    renderBadges(pending.length > 0);
    subscribe();
    setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  }

  window.BEAnnounce = {
    applies: applies, isLive: isLive, isTrainer: isTrainer, isHead: isHead, isActiveEmp: isActiveEmp, EMOJIS: EMOJIS,
    renderCenter: function (root) { if (!S.ready) { root.innerHTML = '<div class="be-annc-empty">Loading announcements…</div>'; start().then(function () { renderCenter(root); }); return; } renderCenter(root); },
    open: openCenter, refresh: function () { return loadAll().then(refreshViews); },
    onUnread: function (fn) { S.listeners.push(fn); }, unreadCount: function () { return unreadList().length; },
    state: S, start: start, testChime: function (p) { unlockAudio(); chime(p || 'normal'); },
    // Local preview for HR (nothing is published): the exact toast + chime employees will get.
    preview: function (a) { css(); unlockAudio(); toast(a, 'new'); chime(a.priority || 'normal'); }
  };
  // Start once the page's own scripts (client, session) are in place.
  function boot() { setTimeout(start, 1500); }
  if (document.readyState === 'complete') boot(); else window.addEventListener('load', boot);
})();
