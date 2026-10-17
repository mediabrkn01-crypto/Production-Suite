/* ════════════════════════════════════════════════════════════════════════════
   BENotify — the ONE shared notification client for every portal.

   Source of truth: public.erp_notifications (migration 20261023_erp_notifications.sql).
   One row per logical event per recipient (unique recipient_email + dedupe_key), written by
   database triggers (work completed) or by the portal that detects the event (attendance
   pending). This module only reads, marks read / resolved / snoozed, and shows.

   BENotify.init({
     db,                       supabase client of the ERP project
     email,                    signed-in portal email (recipient)
     bell, badge,              optional element ids: bell button + its count badge (panel mode)
     panel: true|false,        render the shared Notification Center dropdown on the bell
     onOpen(row),              deep-link handler when a notification is clicked / its toast "View"
     toastTypes: [...]         types that pop a small toast when they arrive live
   })
   BENotify.on('change', fn(rows)) · rows() · unread() · open() · close() · toggle()
   BENotify.markRead(id) · markAllRead() · upsert(row) · resolve(keys) · snooze(keys, minutes)
   BENotify.serverNow() → Promise<Date>   (database clock — never trust the device clock)

   Realtime: BELive (Supabase Realtime) on erp_notifications filtered to this recipient; a
   60 s refresh is the fallback only. Sound: a soft two-tone chime for live work completions,
   off when localStorage 'be_notif_sound' = 'off' (toggle in the panel header).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BENotify) return;
  var T = 'erp_notifications';
  var S = { db: null, email: '', rows: [], subs: {}, panel: null, opts: {}, seen: {}, ready: false, timer: 0, skew: 0, ok: true };

  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function emit(ev, a) { (S.subs[ev] || []).forEach(function (f) { try { f(a); } catch (e) { console.warn('[BENotify]', e); } }); }
  function ago(iso) {
    var m = Math.floor((Date.now() + S.skew - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); return d < 7 ? d + 'd ago' : new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  var META = {
    attendance_pending:   { c: '#fb923c', ic: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', l: 'Attendance pending' },
    attendance_completed: { c: '#34d399', ic: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>', l: 'Attendance marked' },
    work_completed:       { c: '#34d399', ic: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>', l: 'Work completed' },
    calendar_reminder:    { c: '#ff8a3d', ic: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', l: 'Calendar reminder' },
    calendar_assigned:    { c: '#a78bfa', ic: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4"/>', l: 'New calendar item' },
    work_output_uploaded: { c: '#60a5fa', ic: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3"/>', l: 'Output ready for review' }
  };
  function meta(t) { return META[t] || { c: '#a5b4fc', ic: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>', l: 'Notification' }; }
  function svg(d, s) { return '<svg width="' + (s || 16) + '" height="' + (s || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  function soundOn() { try { return localStorage.getItem('be_notif_sound') !== 'off'; } catch (_) { return true; } }

  function css() {
    if (document.getElementById('ben-css')) return;
    var st = document.createElement('style'); st.id = 'ben-css';
    st.textContent = [
      '.ben-panel{position:fixed;top:64px;right:16px;z-index:9400;width:min(400px,calc(100vw - 24px));max-height:min(72vh,620px);display:flex;flex-direction:column;border-radius:18px;background:linear-gradient(170deg,#151a2c,#0c0f1c);border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 80px -20px rgba(0,0,0,.85);color:#e5e7eb;font-family:inherit;overflow:hidden;animation:benIn .16s ease}',
      '@keyframes benIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
      '.ben-h{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,.07)}',
      '.ben-h b{font-size:15px;color:#fff;flex:1}.ben-h button{height:30px;padding:0 10px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#cbd5e1;font:inherit;font-size:11.5px;font-weight:700;cursor:pointer}.ben-h button:hover{color:#fff;background:rgba(255,255,255,.09)}',
      '.ben-tabs{display:flex;gap:4px;padding:8px 12px}.ben-tabs button{height:28px;padding:0 12px;border-radius:999px;border:1px solid transparent;background:none;color:#8b93b8;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.ben-tabs button.on{color:#fff;background:rgba(255,107,6,.16);border-color:rgba(255,107,6,.4)}',
      '.ben-l{overflow-y:auto;padding:4px 8px 10px;display:flex;flex-direction:column;gap:4px;scrollbar-width:thin}',
      '.ben-i{position:relative;display:flex;gap:11px;align-items:flex-start;width:100%;text-align:left;padding:11px 12px;border-radius:12px;border:1px solid transparent;background:none;color:inherit;font:inherit;cursor:pointer}',
      '.ben-i:hover{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.07)}.ben-i.unread{background:rgba(255,107,6,.06)}',
      '.ben-i.unread::after{content:"";position:absolute;right:12px;top:16px;width:8px;height:8px;border-radius:50%;background:#ff6b06}',
      '.ben-ic{width:34px;height:34px;flex-shrink:0;border-radius:11px;display:grid;place-items:center;color:var(--c);background:color-mix(in srgb,var(--c) 15%,transparent)}',
      '.ben-t{flex:1;min-width:0;padding-right:14px}.ben-t small{display:block;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--c)}',
      '.ben-t b{display:block;font-size:13.5px;color:#fff;margin-top:1px}.ben-t span{display:block;font-size:12.5px;color:#a5adcf;line-height:1.45;margin-top:2px}.ben-t em{display:block;font-style:normal;font-size:11px;color:#5b638a;margin-top:4px}',
      '.ben-i.resolved{opacity:.55}',
      '.ben-e{padding:36px 16px;text-align:center;color:#8b93b8;font-size:13px}',
      '.ben-toast{position:fixed;top:72px;right:16px;z-index:9450;width:min(360px,calc(100vw - 24px));display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:16px;background:linear-gradient(160deg,#15201c,#0d1119);border:1px solid rgba(52,211,153,.4);box-shadow:0 20px 50px -14px rgba(0,0,0,.8);color:#e5e7eb;font-family:inherit;transform:translateY(-10px);opacity:0;transition:transform .2s,opacity .2s}',
      '.ben-toast.on{transform:none;opacity:1}.ben-toast .ben-ic{color:#34d399;background:rgba(52,211,153,.15)}',
      '.ben-toast b{display:block;font-size:14px;color:#fff}.ben-toast span{display:block;font-size:12.5px;color:#a5adcf;margin-top:2px;line-height:1.45}',
      '.ben-toast-a{display:flex;gap:8px;margin-top:10px}.ben-toast-a button{height:30px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e5e7eb;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.ben-toast-a button.pri{border:0;color:#fff;background:linear-gradient(135deg,#10b981,#059669)}',
      '@media(max-width:640px){.ben-panel{top:58px;left:12px;right:12px;width:auto;max-height:calc(100vh - 150px)}.ben-toast{top:60px;left:12px;right:12px;width:auto}}',
      '@media (prefers-reduced-motion:reduce){.ben-panel{animation:none}.ben-toast{transition:none}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ── data ─────────────────────────────────────────────────────────────
  async function load() {
    if (!S.db || !S.email) return;
    var r = await S.db.from(T).select('*').eq('recipient_email', S.email).order('created_at', { ascending: false }).limit(60);
    if (r.error) { S.ok = !/erp_notifications|relation|schema cache/i.test(r.error.message || ''); return; }
    S.ok = true;
    var fresh = r.data || [], first = !S.ready;
    S.rows = fresh; S.ready = true;
    fresh.forEach(function (n) {
      if (!S.seen[n.id]) {
        S.seen[n.id] = 1;
        // A row that ARRIVES while the portal is open (not on first load) pops a toast.
        if (!first && !n.read_at && !n.resolved_at && (S.opts.toastTypes || ['work_completed', 'work_output_uploaded']).indexOf(n.type) >= 0) toast(n);
      }
    });
    badge(); renderPanel(); emit('change', S.rows);
  }
  function unreadRows() { return S.rows.filter(function (n) { return !n.read_at && !n.resolved_at; }); }
  function badge() {
    var b = S.opts.badge && document.getElementById(S.opts.badge); if (!b) return;
    var n = unreadRows().length;
    b.textContent = n > 99 ? '99+' : (n || '');
    b.style.display = n ? 'inline-flex' : 'none';
    b.hidden = !n; b.classList.toggle('hidden', !n);
  }

  // ── Notification Center panel ──────────────────────────────────────────
  var tab = 'unread';
  function renderPanel() {
    if (!S.panel) return;
    var list = tab === 'unread' ? unreadRows() : S.rows;
    S.panel.innerHTML = '<div class="ben-h"><b>Notifications</b>'
      + '<button type="button" data-ben-sound title="Sound for new work completions">' + (soundOn() ? '🔔 Sound on' : '🔕 Sound off') + '</button>'
      + (unreadRows().length ? '<button type="button" data-ben-all>Mark all read</button>' : '')
      + '<button type="button" data-ben-x aria-label="Close">✕</button></div>'
      + '<div class="ben-tabs"><button type="button" data-ben-tab="unread" class="' + (tab === 'unread' ? 'on' : '') + '">Unread ' + unreadRows().length + '</button><button type="button" data-ben-tab="all" class="' + (tab === 'all' ? 'on' : '') + '">All</button></div>'
      + '<div class="ben-l">' + (!S.ok ? '<div class="ben-e">Notifications need the database update <b>20261023_erp_notifications.sql</b>.</div>'
        : list.length ? list.map(function (n) {
          var m = meta(n.type);
          return '<button type="button" class="ben-i' + (!n.read_at && !n.resolved_at ? ' unread' : '') + (n.resolved_at ? ' resolved' : '') + '" style="--c:' + m.c + '" data-ben-id="' + esc(n.id) + '">'
            + '<span class="ben-ic">' + svg(m.ic, 17) + '</span><span class="ben-t"><small>' + esc(n.resolved_at && n.type === 'attendance_pending' ? 'Resolved' : m.l) + '</small><b>' + esc(n.title) + '</b>'
            + (n.message ? '<span>' + esc(n.message) + '</span>' : '') + '<em>' + esc(ago(n.created_at)) + '</em></span></button>';
        }).join('') : '<div class="ben-e">' + (tab === 'unread' ? 'You’re all caught up.' : 'No notifications yet.') + '</div>') + '</div>';
  }
  function open() {
    css();
    if (S.panel) return;
    if (typeof window._beCloseOverlays === 'function') window._beCloseOverlays();
    S.panel = document.createElement('div'); S.panel.className = 'ben-panel'; S.panel.setAttribute('role', 'dialog'); S.panel.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(S.panel); renderPanel();
    S.panel.addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (!t) return;
      if (t.hasAttribute('data-ben-x')) return close();
      if (t.hasAttribute('data-ben-all')) return markAllRead();
      if (t.hasAttribute('data-ben-sound')) { try { localStorage.setItem('be_notif_sound', soundOn() ? 'off' : 'on'); } catch (_) {} return renderPanel(); }
      if (t.hasAttribute('data-ben-tab')) { tab = t.getAttribute('data-ben-tab'); return renderPanel(); }
      var id = t.getAttribute('data-ben-id'); if (!id) return;
      var row = S.rows.find(function (n) { return String(n.id) === id; });
      markRead(id); close();
      if (row && /^cal:/.test(String(row.link || '')) && window.BECal) { BECal.openFromLink(row.link); return; }   // Content Calendar item
      if (row && typeof S.opts.onOpen === 'function') S.opts.onOpen(row);
    });
    setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
    document.addEventListener('keydown', esc_);
  }
  function outside(e) { if (S.panel && !S.panel.contains(e.target) && !(S.bellEl && S.bellEl.contains(e.target))) close(); }
  function esc_(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (!S.panel) return;
    S.panel.remove(); S.panel = null;
    document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc_);
  }

  // ── toast + sound ──────────────────────────────────────────────────────
  function chime() {
    if (!soundOn()) return;
    try {
      var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      var ac = S.ac || (S.ac = new A()), t0 = ac.currentTime;
      [[660, 0], [990, 0.12]].forEach(function (p) {
        var o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = p[0];
        g.gain.setValueAtTime(0.0001, t0 + p[1]); g.gain.exponentialRampToValueAtTime(0.06, t0 + p[1] + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + p[1] + 0.35);
        o.connect(g); g.connect(ac.destination); o.start(t0 + p[1]); o.stop(t0 + p[1] + 0.4);
      });
    } catch (_) {}
  }
  function toast(n) {
    css(); chime();
    var m = meta(n.type), md = n.metadata || {};
    var el = document.createElement('div'); el.className = 'ben-toast'; el.setAttribute('role', 'status');
    el.innerHTML = '<span class="ben-ic">' + svg(m.ic, 18) + '</span><div style="flex:1;min-width:0"><b>' + esc(n.type === 'work_output_uploaded' ? '✓ ' + n.title : '✓ New ' + (md.department ? md.department + ' ' : '') + 'work completed') + '</b>'
      + '<span>' + esc(n.message || '') + '</span><div class="ben-toast-a"><button type="button" class="pri" data-v>' + (n.type === 'work_output_uploaded' ? 'Review Output' : 'View') + '</button><button type="button" data-d>Dismiss</button></div></div>';
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    var gone = function () { el.classList.remove('on'); setTimeout(function () { el.remove(); }, 220); };
    var t = setTimeout(gone, 9000);
    el.querySelector('[data-d]').onclick = function () { clearTimeout(t); gone(); };
    el.querySelector('[data-v]').onclick = function () { clearTimeout(t); gone(); markRead(n.id); if (/^cal:/.test(String(n.link || '')) && window.BECal) return BECal.openFromLink(n.link); if (typeof S.opts.onOpen === 'function') S.opts.onOpen(n); };
  }

  // ── writes ─────────────────────────────────────────────────────────────
  async function markRead(id) {
    var r = S.rows.find(function (n) { return String(n.id) === String(id); }); if (r && !r.read_at) r.read_at = new Date().toISOString();
    badge(); renderPanel(); emit('change', S.rows);
    await S.db.from(T).update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null);
  }
  async function markAllRead() {
    var ids = unreadRows().map(function (n) { return n.id; }); if (!ids.length) return;
    var now = new Date().toISOString(); S.rows.forEach(function (n) { if (ids.indexOf(n.id) >= 0) n.read_at = now; });
    badge(); renderPanel(); emit('change', S.rows);
    await S.db.from(T).update({ read_at: now }).in('id', ids).is('read_at', null);
  }
  // Idempotent: one row per (recipient, dedupe_key) — repeating it never creates a duplicate.
  async function upsert(row) {
    row = Object.assign({ recipient_email: S.email }, row); row.recipient_email = String(row.recipient_email || '').toLowerCase();
    var r = await S.db.from(T).upsert(row, { onConflict: 'recipient_email,dedupe_key', ignoreDuplicates: true });
    return !r.error;
  }
  async function resolve(keys) {
    keys = [].concat(keys).filter(Boolean); if (!keys.length) return;
    await S.db.from(T).update({ resolved_at: new Date().toISOString() }).eq('recipient_email', S.email).in('dedupe_key', keys).is('resolved_at', null);
    await load();
  }
  async function snooze(keys, minutes) {
    keys = [].concat(keys).filter(Boolean); if (!keys.length) return;
    var until = new Date((await serverNow()).getTime() + (minutes || 5) * 60000).toISOString();
    await S.db.from(T).update({ snooze_until: until }).eq('recipient_email', S.email).in('dedupe_key', keys);
    S.rows.forEach(function (n) { if (keys.indexOf(n.dedupe_key) >= 0) n.snooze_until = until; });
  }
  // Database clock (erp_now()); falls back to the device clock if the function is missing.
  async function serverNow() {
    try { var r = await S.db.rpc('erp_now'); if (!r.error && r.data) { var d = new Date(r.data); S.skew = d.getTime() - Date.now(); return d; } } catch (_) {}
    return new Date(Date.now() + S.skew);
  }

  window.BENotify = {
    init: function (o) {
      S.opts = o || {}; S.db = o.db; S.email = String(o.email || '').trim().toLowerCase();
      if (!S.db || !S.email) return;
      if (o.panel && o.bell) {
        S.bellEl = typeof o.bell === 'string' ? document.getElementById(o.bell) : o.bell;
      }
      load();
      if (window.BELive) BELive.on('be-notify', [{ table: T, filter: 'recipient_email=eq.' + S.email }], function () { load(); }, { debounce: 200 });
      clearInterval(S.timer); S.timer = setInterval(load, 60000);   // fallback only — realtime is primary
      document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
    },
    on: function (ev, fn) { (S.subs[ev] = S.subs[ev] || []).push(fn); if (ev === 'change' && S.ready) fn(S.rows); },
    rows: function () { return S.rows.slice(); },
    unread: function () { return unreadRows(); },
    reload: load, open: open, close: close,
    toggle: function () { if (S.panel) close(); else open(); },
    markRead: markRead, markAllRead: markAllRead, upsert: upsert, resolve: resolve, snooze: snooze, serverNow: serverNow,
    get available() { return S.ok; }
  };
})();
