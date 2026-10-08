/**
 * BEWork — the ONE work-assignment engine for the whole organisation.
 *
 * Every task is a row in `assignments` (the Media Work Assignment table):
 *   scope 'media' → shows in the Media pipeline (index.html) exactly as before
 *   scope 'org'   → any other department (Academics, Sales, HR, Management …)
 * Status flow (same words Media uses): Pending → In Progress → Completed,
 *   Rework Required (sent back by the assigner), cancelled. Overdue = past due & still open.
 * Every change appends to `history` (who / when / what) — nothing is deleted.
 *
 *   BEWork.mountMyTasks(el, { db, email, name, onNotify(task), onCount(n) })
 *       "My Assigned Tasks" for the signed-in employee + live "New work assigned" alerts.
 *   BEWork.mountManager(el, { db, actor:{name,email}, departments: null | ['education',…], title })
 *       Work Assignment board: KPIs, filters, assign / edit / reassign / cancel, history,
 *       inactive-employee warnings. departments=null → all departments (Manager).
 *
 * Realtime via BELive (one shared channel). Uploads go to the public `task-references`
 * bucket and are stored in reference_file as "name|url;;…" (same format Media uses).
 * Namespace: window.BEWork
 */
(function () {
  'use strict';
  if (window.BEWork) return;

  var DIV = { production: 'Media / Production', education: 'Academics', sales: 'Sales', hr: 'HR', accounts: 'Accounts', other: 'Management / Admin' };
  var DIV_COLOR = { production: '#a78bfa', education: '#34d399', sales: '#fbbf24', hr: '#60a5fa', accounts: '#22d3ee', other: '#94a3b8' };
  var PRIO = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['very_high', 'Urgent']];
  var PRIO_LABEL = { low: 'Low', medium: 'Medium', high: 'High', very_high: 'Urgent', urgent: 'Urgent' };
  var OPEN = ['Pending', 'In Progress', 'Rework Required'];
  var MEDIA_TYPES = ['Video Editing', 'Poster Design', 'Thumbnail', 'Social Media'];

  // ── utils ────────────────────────────────────────────────────────────────────────────
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
  function fmtD(s) { if (!s) return '—'; var d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? String(s) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtTs(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
  function initials(n) { return String(n || '?').trim().split(/\s+/).map(function (w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase() || '?'; }
  function lc(s) { return String(s || '').trim().toLowerCase(); }
  function isOpen(t) { return OPEN.indexOf(t.status || 'Pending') > -1; }
  function isOverdue(t) { return isOpen(t) && t.date && /^\d{4}-\d{2}-\d{2}/.test(t.date) && String(t.date).slice(0, 10) < today(); }
  function state(t) {
    var s = t.status || 'Pending';
    if (s === 'cancelled') return 'cancelled';
    if (s === 'Rejected') return 'rejected';
    if (s === 'Completed') return 'completed';
    if (s === 'Rework Required') return 'rework';
    if (s === 'In Progress') return 'progress';
    return 'pending';
  }
  var STATE_LABEL = { pending: 'Pending', progress: 'In progress', rework: 'Rework', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Rejected' };
  function toast(type, msg) { if (typeof window.showToast === 'function') window.showToast(type, msg); else console.log('[BEWork]', msg); }
  async function confirmBox(msg, title, label) {
    if (typeof window.showConfirm === 'function') return window.showConfirm(msg, { title: title, confirmLabel: label || 'Confirm' });
    if (typeof window._showSimpleConfirm === 'function') return window._showSimpleConfirm(msg, { title: title, confirmLabel: label || 'Confirm' });
    return true;
  }
  function parseRefs(str) {
    return String(str || '').split(';;').filter(Boolean).map(function (p) {
      var k = p.indexOf('|'); var name = k > -1 ? p.slice(0, k) : 'Reference'; var url = k > -1 ? p.slice(k + 1) : p;
      return { name: name === '__folder__' ? 'All reference files (folder)' : name, url: url };
    }).filter(function (r) { return /^https?:\/\//i.test(r.url); });
  }
  function dueText(t) {
    if (!t.date) return 'No due date';
    var d = String(t.date).slice(0, 10), td = today();
    if (!isOpen(t)) return 'Due ' + fmtD(d);
    if (d < td) { var n = Math.round((new Date(td) - new Date(d)) / 864e5); return n + ' day' + (n === 1 ? '' : 's') + ' overdue'; }
    if (d === td) return 'Due today';
    var m = Math.round((new Date(d) - new Date(td)) / 864e5); return m === 1 ? 'Due tomorrow' : 'Due ' + fmtD(d);
  }
  function histAdd(t, by, action, extra) {
    var h = Array.isArray(t.history) ? t.history.slice() : [];
    var e = { at: new Date().toISOString(), by: by || 'Someone', action: action };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    h.push(e); return h;
  }
  async function hasCols(db) {
    if (hasCols._v != null) return hasCols._v;
    try { var r = await db.from('assignments').select('scope,history').limit(1); hasCols._v = !r.error; } catch (e) { hasCols._v = false; }
    return hasCols._v;
  }
  // Update that survives a database where the migration hasn't run yet (drops new columns).
  async function saveRow(db, id, patch) {
    var ok = await hasCols(db), p = Object.assign({}, patch);
    if (!ok) ['scope', 'department', 'employee_id', 'created_by', 'created_at', 'updated_at', 'started_at', 'completed_at', 'progress', 'reference_link', 'history'].forEach(function (k) { delete p[k]; });
    return id == null ? db.from('assignments').insert([p]) : db.from('assignments').update(p).eq('id', id);
  }
  async function uploadFiles(db, files, onPct) {
    var out = [], i = 0;
    for (var f of files) {
      var path = 'work/' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '_' + f.name.replace(/[^\w.\-]+/g, '_');
      var r = await db.storage.from('task-references').upload(path, f, { upsert: false, contentType: f.type || undefined });
      if (r.error) throw r.error;
      var u = db.storage.from('task-references').getPublicUrl(path);
      out.push({ name: f.name, url: u.data.publicUrl });
      i++; if (onPct) onPct(Math.round(i / files.length * 100));
    }
    return out;
  }

  // ── styles (injected once) ─────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('bework-css')) return;
    var s = document.createElement('style'); s.id = 'bework-css';
    s.textContent = [
      '.bw{--bw-b:rgba(255,255,255,.08);--bw-s:rgba(255,255,255,.025);--bw-t:#e5e7eb;--bw-m:#8b93b8;--bw-d:#5b638a;color:var(--bw-t);font-family:inherit;text-align:left}',
      '.bw *{box-sizing:border-box}',
      '.bw-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}',
      '.bw-head h2{margin:0;font-size:20px;font-weight:800;color:#fff}.bw-head p{margin:4px 0 0;font-size:12.5px;color:var(--bw-m)}',
      '.bw-new{display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:0 16px;border:0;border-radius:11px;color:#fff;font-weight:800;font-size:13px;cursor:pointer;background:linear-gradient(135deg,#ff6b06,#f9182f)}',
      '.bw-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:14px}',
      '.bw-kpi{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border-radius:14px;border:1px solid var(--bw-b);background:var(--bw-s);cursor:pointer;text-align:left;color:var(--bw-m);font:inherit}',
      '.bw-kpi b{font-size:22px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums}.bw-kpi span{font-size:11.5px;font-weight:600}',
      '.bw-kpi.on{border-color:rgba(255,107,6,.6);background:rgba(255,107,6,.08)}',
      '.bw-kpi.warn b{color:#fb7185}.bw-kpi.good b{color:#34d399}.bw-kpi.info b{color:#60a5fa}.bw-kpi.amber b{color:#fbbf24}',
      '.bw-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}',
      '.bw-tabs{display:flex;gap:4px;flex-wrap:wrap;padding:4px;border-radius:12px;background:rgba(0,0,0,.25);border:1px solid var(--bw-b)}',
      '.bw-tabs button{min-height:32px;padding:0 12px;border-radius:9px;border:1px solid transparent;background:none;color:var(--bw-m);font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.bw-tabs button.on{color:#fff;background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12)}',
      '.bw-tabs button i{font-style:normal;margin-left:5px;font-size:11px;color:var(--bw-d)}',
      '.bw-sel,.bw-in{min-height:36px!important;padding:0 10px!important;border-radius:10px!important;border:1px solid var(--bw-b)!important;background:rgba(255,255,255,.04)!important;color:#fff!important;font-size:12.5px!important;font-family:inherit!important;max-width:100%}',
      '.bw-sel{padding-right:26px!important}',
      '.bw-search{flex:1;min-width:180px}',
      '.bw-warn{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-radius:12px;margin-bottom:12px;font-size:12.5px;color:#fde68a;background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.3)}',
      '.bw-warn b{color:#fff}.bw-warn button{margin-left:auto}',
      '.bw-note{padding:10px 14px;border-radius:12px;margin-bottom:12px;font-size:12.5px;color:#bfdbfe;background:rgba(59,130,246,.07);border:1px solid rgba(96,165,250,.3)}',
      '.bw-list{display:flex;flex-direction:column;border:1px solid var(--bw-b);border-radius:14px;overflow:hidden;background:var(--bw-s)}',
      '.bw-row{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(0,1.4fr) 86px 110px 118px 92px auto;gap:12px;align-items:center;padding:11px 14px;border-top:1px solid rgba(255,255,255,.05);cursor:pointer}',
      '.bw-row:first-child{border-top:0}.bw-row:hover{background:rgba(255,255,255,.025)}',
      '.bw-row.hd{cursor:default;font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--bw-d);background:rgba(0,0,0,.15)}',
      '.bw-row.hd:hover{background:rgba(0,0,0,.15)}',
      '.bw-tt{min-width:0}.bw-tt b{display:block;font-size:13.5px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bw-tt span{font-size:11.5px;color:var(--bw-m)}',
      '.bw-who{display:flex;align-items:center;gap:9px;min-width:0}.bw-who div{min-width:0}.bw-who b{display:block;font-size:12.5px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bw-ava{width:28px;height:28px;flex-shrink:0;border-radius:50%;display:grid;place-items:center;font-size:10.5px;font-weight:800;color:#fff;background:linear-gradient(135deg,#334155,#475569)}',
      '.bw-dep{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--bw-m)}.bw-dep i{width:7px;height:7px;border-radius:2px}',
      '.bw-pri{display:inline-flex;font-size:10.5px;font-weight:800;padding:3px 8px;border-radius:999px;white-space:nowrap;color:#a5adcf;background:rgba(255,255,255,.06)}',
      '.bw-pri.high{color:#fdba74;background:rgba(251,146,60,.13)}.bw-pri.very_high,.bw-pri.urgent{color:#fda4af;background:rgba(244,63,94,.15)}.bw-pri.low{color:#93c5fd;background:rgba(59,130,246,.1)}',
      '.bw-due{font-size:12px;color:#cbd5e1}.bw-due.od{color:#fb7185;font-weight:700}.bw-due small{display:block;font-size:10.5px;color:var(--bw-d)}',
      '.bw-st{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;padding:4px 9px;border-radius:999px;white-space:nowrap}',
      '.bw-st i{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.bw-st.pending{color:#cbd5e1;background:rgba(255,255,255,.07)}.bw-st.progress{color:#93c5fd;background:rgba(59,130,246,.13)}.bw-st.rework{color:#fcd34d;background:rgba(245,158,11,.13)}',
      '.bw-st.completed{color:#6ee7b7;background:rgba(16,185,129,.13)}.bw-st.cancelled,.bw-st.rejected{color:#94a3b8;background:rgba(148,163,184,.1)}',
      '.bw-prog{height:5px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden}.bw-prog i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#ff6b06,#f9182f)}',
      '.bw-prog-t{font-size:10.5px;color:var(--bw-d);margin-top:3px}',
      '.bw-acts{display:flex;gap:4px;justify-content:flex-end}',
      '.bw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 11px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#e5e7eb;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.bw-btn:hover{border-color:rgba(255,255,255,.28);color:#fff}.bw-btn.pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f)}',
      '.bw-btn.green{color:#6ee7b7;border-color:rgba(16,185,129,.4);background:rgba(16,185,129,.1)}.bw-btn.ghost{background:none;border-color:transparent;color:var(--bw-m)}',
      '.bw-btn.red{color:#fda4af;border-color:rgba(244,63,94,.35);background:rgba(244,63,94,.07)}',
      '.bw-empty{padding:34px 16px;text-align:center;color:var(--bw-m);font-size:13px}.bw-empty b{display:block;color:#fff;font-size:14px;margin-bottom:4px}',
      // my tasks cards
      '.bw-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}',
      '.bw-card{position:relative;display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:14px;border:1px solid var(--bw-b);background:var(--bw-s);cursor:pointer;text-align:left;font:inherit;color:inherit}',
      '.bw-card:hover{border-color:rgba(255,255,255,.18)}.bw-card.od{border-color:rgba(244,63,94,.35)}.bw-card.new::after{content:"NEW";position:absolute;top:12px;right:12px;font-size:9.5px;font-weight:800;letter-spacing:.08em;color:#fff;background:#f9182f;border-radius:999px;padding:2px 7px}',
      '.bw-card h4{margin:0;font-size:14.5px;font-weight:800;color:#fff;padding-right:40px}.bw-card p{margin:0;font-size:12.5px;color:var(--bw-m);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.bw-card-m{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.bw-card-f{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--bw-d)}',
      // modal
      '.bw-ov{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,6,12,.72);backdrop-filter:blur(4px)}',
      '.bw-modal{width:100%;max-width:620px;max-height:min(92vh,880px);display:flex;flex-direction:column;border-radius:18px;border:1px solid rgba(255,255,255,.1);background:#0f1322;box-shadow:0 30px 80px -20px rgba(0,0,0,.8);overflow:hidden}',
      '.bw-mh{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 14px;border-bottom:1px solid rgba(255,255,255,.07)}',
      '.bw-mh h3{margin:0;font-size:17px;font-weight:800;color:#fff}.bw-mh p{margin:3px 0 0;font-size:12.5px;color:var(--bw-m)}',
      '.bw-x{margin-left:auto;width:32px;height:32px;flex-shrink:0;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#a5adcf;cursor:pointer;font-size:14px}',
      '.bw-mb{padding:16px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:14px}',
      '.bw-mf{display:flex;align-items:center;gap:10px;justify-content:flex-end;flex-wrap:wrap;padding:12px 20px;border-top:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.2)}',
      '.bw-f{display:flex;flex-direction:column;gap:6px;min-width:0}.bw-l{font-size:12px;font-weight:700;color:#a5adcf}.bw-l b{color:#f87171}.bw-l em{font-style:normal;font-weight:500;color:var(--bw-d)}',
      '.bw-g2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.bw-modal input:not([type=file]):not([type=range]),.bw-modal select,.bw-modal textarea{width:100%;min-height:42px;padding:9px 12px!important;border-radius:10px!important;border:1px solid rgba(255,255,255,.1)!important;background:rgba(255,255,255,.04)!important;color:#fff!important;font-size:13px!important;font-family:inherit!important;margin:0!important}',
      '.bw-modal textarea{min-height:96px;resize:vertical}',
      '.bw-seg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:4px;border-radius:12px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08)}',
      '.bw-seg button{min-height:34px;border-radius:9px;border:1px solid transparent;background:none;color:var(--bw-m);font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.bw-seg button.on{color:#fff;background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.14)}',
      '.bw-files{display:flex;flex-direction:column;gap:6px}',
      '.bw-file{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);font-size:12.5px}',
      '.bw-file a{color:#93c5fd;font-weight:700;margin-left:auto}.bw-file span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bw-drop{display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;border-radius:10px;border:1px dashed rgba(255,255,255,.18);color:var(--bw-m);font-size:12.5px;cursor:pointer}',
      '.bw-drop:hover{border-color:rgba(255,107,6,.5);color:#fff}',
      '.bw-info{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
      '.bw-info div{padding:10px 12px;border-radius:11px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}',
      '.bw-info small{display:block;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--bw-d)}.bw-info b{font-size:13px;color:#fff}',
      '.bw-desc{white-space:pre-wrap;font-size:13px;line-height:1.55;color:#cbd5e1;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06)}',
      '.bw-hist{display:flex;flex-direction:column;gap:0;border-left:2px solid rgba(255,255,255,.08);margin-left:6px;padding-left:14px}',
      '.bw-h{position:relative;padding:6px 0;font-size:12.5px;color:#cbd5e1}.bw-h::before{content:"";position:absolute;left:-20px;top:11px;width:10px;height:10px;border-radius:50%;background:#1e2438;border:2px solid #ff6b06}',
      '.bw-h small{display:block;font-size:11px;color:var(--bw-d)}.bw-h q{display:block;margin-top:3px;color:#e5e7eb;quotes:none}',
      '.bw-rng{width:100%;accent-color:#ff6b06}',
      // alert card
      '.bw-alert{position:fixed;top:18px;right:18px;z-index:2147482500;width:min(360px,calc(100vw - 32px));padding:14px 16px;border-radius:14px;background:#11162a;border:1px solid rgba(255,107,6,.45);box-shadow:0 20px 50px -12px rgba(0,0,0,.8);color:#e5e7eb;transform:translateY(-12px);opacity:0;transition:all .2s}',
      '.bw-alert.on{transform:none;opacity:1}.bw-alert small{display:block;font-size:10.5px;font-weight:800;letter-spacing:.1em;color:#ff8a3c}',
      '.bw-alert b{display:block;margin:4px 0 2px;font-size:14.5px;color:#fff}.bw-alert span{font-size:12px;color:#8b93b8}',
      '.bw-alert-a{display:flex;gap:8px;margin-top:10px}',
      '@media(max-width:1100px){.bw-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto}.bw-row.hd{display:none}.bw-row>.bw-c-pri,.bw-row>.bw-c-prog{display:none}.bw-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}',
      '@media(max-width:640px){.bw-row{grid-template-columns:minmax(0,1fr) auto;row-gap:8px}.bw-row>.bw-c-who{grid-column:1/-1}.bw-row>.bw-c-due{grid-column:1}.bw-acts{grid-column:2;grid-row:1}.bw-kpis{grid-template-columns:1fr 1fr}.bw-g2,.bw-info{grid-template-columns:1fr}.bw-seg{grid-template-columns:1fr 1fr}.bw-mf .bw-btn{flex:1}.bw-search{min-width:100%}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── modal helper ───────────────────────────────────────────────────────────────────────
  function modal(html, onMount) {
    css();
    var ov = document.createElement('div'); ov.className = 'bw-ov bw';
    ov.innerHTML = '<div class="bw-modal" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(ov);
    var close = function () { ov.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    ov.querySelectorAll('[data-bw-close]').forEach(function (b) { b.onclick = close; });
    if (onMount) onMount(ov, close);
    return close;
  }
  function stPill(t) { var k = state(t); return '<span class="bw-st ' + k + '"><i></i>' + STATE_LABEL[k] + '</span>'; }
  function priPill(p) { p = p || 'medium'; return '<span class="bw-pri ' + esc(p) + '">' + esc(PRIO_LABEL[p] || p) + '</span>'; }
  function depChip(d) { d = d || 'production'; return '<span class="bw-dep"><i style="background:' + (DIV_COLOR[d] || '#94a3b8') + '"></i>' + esc(DIV[d] || d) + '</span>'; }

  // Task detail (shared by employee + manager views)
  function detailHTML(t, opts) {
    var refs = parseRefs(t.reference_file), hist = Array.isArray(t.history) ? t.history.slice().reverse() : [];
    var out = t.asset_link && /^https?:/i.test(t.asset_link) ? t.asset_link : '';
    return '<div class="bw-mh"><div><h3>' + esc(t.topic || 'Task') + '</h3><p>' + esc(t.type || 'Task') + ' · ' + depChip(t.department) + '</p></div><button class="bw-x" data-bw-close aria-label="Close">✕</button></div>' +
      '<div class="bw-mb">' +
        '<div class="bw-info"><div><small>Status</small>' + stPill(t) + '</div><div><small>Priority</small>' + priPill(t.priority) + '</div><div><small>Due</small><b class="' + (isOverdue(t) ? 'bw-due od' : '') + '">' + esc(dueText(t)) + '</b></div>' +
          '<div><small>Assigned to</small><b>' + esc(t.assigned_to || '—') + '</b></div><div><small>Assigned by</small><b>' + esc(t.assigned_by || '—') + '</b></div><div><small>Assigned on</small><b>' + esc(fmtD(t.assigned_date)) + '</b></div></div>' +
        (typeof t.progress === 'number' && t.progress > 0 && t.status !== 'Completed' ? '<div class="bw-f"><span class="bw-l">Progress · ' + t.progress + '%</span><div class="bw-prog"><i style="width:' + t.progress + '%"></i></div></div>' : '') +
        '<div class="bw-f"><span class="bw-l">Instructions</span><div class="bw-desc">' + (t.description ? esc(t.description) : '<span style="color:#5b638a">No instructions added.</span>') + '</div></div>' +
        (t.rework_reason && t.status === 'Rework Required' ? '<div class="bw-warn"><b>Rework needed:</b> ' + esc(t.rework_reason) + '</div>' : '') +
        ((refs.length || t.reference_link) ? '<div class="bw-f"><span class="bw-l">Reference files &amp; links</span><div class="bw-files">' +
          refs.map(function (r) { return '<div class="bw-file">📎<span>' + esc(r.name) + '</span><a href="' + esc(r.url) + '" target="_blank" rel="noopener">Open</a></div>'; }).join('') +
          (t.reference_link ? '<div class="bw-file">🔗<span>' + esc(t.reference_link) + '</span><a href="' + esc(t.reference_link) + '" target="_blank" rel="noopener">Open</a></div>' : '') + '</div></div>' : '') +
        (out ? '<div class="bw-f"><span class="bw-l">Submitted work</span><div class="bw-file">✅<span>' + esc(out) + '</span><a href="' + esc(out) + '" target="_blank" rel="noopener">Open</a></div></div>' : '') +
        (hist.length ? '<div class="bw-f"><span class="bw-l">History</span><div class="bw-hist">' + hist.map(function (h) {
          return '<div class="bw-h">' + esc(histLabel(h)) + '<small>' + esc(h.by || '') + ' · ' + esc(fmtTs(h.at)) + '</small>' + (h.note ? '<q>' + esc(h.note) + '</q>' : '') + '</div>'; }).join('') + '</div></div>' : '') +
        (opts && opts.extra ? opts.extra : '') +
      '</div>';
  }
  function histLabel(h) {
    switch (h.action) {
      case 'created': return 'Assigned to ' + (h.to || '—');
      case 'reassigned': return 'Reassigned from ' + (h.from || '—') + ' to ' + (h.to || '—');
      case 'edited': return 'Edited' + (h.fields ? ' (' + h.fields.join(', ') + ')' : '');
      case 'status': return 'Status → ' + (h.to || '');
      case 'update': return 'Progress update' + (h.progress != null ? ' · ' + h.progress + '%' : '');
      case 'submitted': return 'Marked completed';
      case 'rework': return 'Sent back for rework';
      case 'cancelled': return 'Cancelled';
      default: return h.action || 'Update';
    }
  }

  // ── live alert ─────────────────────────────────────────────────────────────────────────
  function alertNew(t, onView) {
    css();
    var a = document.createElement('div'); a.className = 'bw-alert bw'; a.setAttribute('role', 'status');
    a.innerHTML = '<small>🔔 NEW WORK ASSIGNED</small><b>' + esc(t.topic || 'New task') + '</b><span>' + esc(dueText(t)) + ' · from ' + esc(t.assigned_by || 'Manager') + '</span>' +
      '<div class="bw-alert-a"><button class="bw-btn pri" data-v>View task</button><button class="bw-btn ghost" data-d>Dismiss</button></div>';
    document.body.appendChild(a);
    requestAnimationFrame(function () { a.classList.add('on'); });
    var kill = function () { a.classList.remove('on'); setTimeout(function () { a.remove(); }, 250); };
    a.querySelector('[data-v]').onclick = function () { kill(); if (onView) onView(t); };
    a.querySelector('[data-d]').onclick = kill;
    setTimeout(kill, 15000);
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('New work assigned', { body: (t.topic || '') + ' · ' + dueText(t) }); } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // MY ASSIGNED TASKS
  // ══════════════════════════════════════════════════════════════════════════════════════
  function mountMyTasks(el, o) {
    css();
    var db = o.db, me = lc(o.email), name = o.name || '';
    var S = { rows: [], f: 'open', known: null, loading: true };
    try { S.known = new Set(JSON.parse(localStorage.getItem('bw_seen_' + me) || '[]')); } catch (_) { S.known = new Set(); }
    el.classList.add('bw');

    async function load() {
      var r = await db.from('assignments').select('*').ilike('employee_email', me).order('id', { ascending: false });
      S.loading = false;
      if (r.error) { el.innerHTML = '<div class="bw-empty"><b>Could not load your tasks</b>' + esc(r.error.message) + '</div>'; return; }
      var prev = S.rows.length ? new Set(S.rows.map(function (x) { return String(x.id); })) : null;
      S.rows = (r.data || []).filter(function (t) { return t.status !== 'cancelled'; });
      // brand-new tasks while this page is open → live alert + page bell
      if (prev) S.rows.forEach(function (t) { if (!prev.has(String(t.id)) && isOpen(t)) { alertNew(t, openTask); if (o.onNotify) try { o.onNotify(t); } catch (_) {} } });
      if (o.onCount) try { o.onCount(S.rows.filter(isOpen).length); } catch (_) {}
      render();
    }
    function counts() {
      var c = { open: 0, pending: 0, progress: 0, rework: 0, overdue: 0, completed: 0, all: S.rows.length };
      S.rows.forEach(function (t) { var k = state(t); if (isOpen(t)) c.open++; if (c[k] != null) c[k]++; if (isOverdue(t)) c.overdue++; });
      return c;
    }
    function render() {
      var c = counts();
      var list = S.rows.filter(function (t) {
        var k = state(t);
        return S.f === 'all' || (S.f === 'open' && isOpen(t)) || (S.f === 'overdue' && isOverdue(t)) || S.f === k;
      }).sort(function (a, b) { return (isOverdue(b) - isOverdue(a)) || String(a.date || '9').localeCompare(String(b.date || '9')); });
      var tabs = [['open', 'To do'], ['progress', 'In progress'], ['rework', 'Rework'], ['overdue', 'Overdue'], ['completed', 'Completed'], ['all', 'All']];
      el.innerHTML = '<div class="bw-head"><div><h2>' + esc(o.title || 'My Assigned Tasks') + '</h2><p>Work assigned to you by your manager or department head. Updates appear here instantly.</p></div></div>' +
        '<div class="bw-bar"><div class="bw-tabs" role="tablist">' + tabs.map(function (x) { return '<button type="button" data-f="' + x[0] + '" class="' + (S.f === x[0] ? 'on' : '') + '">' + x[1] + '<i>' + (c[x[0]] || 0) + '</i></button>'; }).join('') + '</div></div>' +
        (list.length ? '<div class="bw-cards">' + list.map(function (t) {
          var isNew = isOpen(t) && !S.known.has(String(t.id));
          return '<button type="button" class="bw-card' + (isOverdue(t) ? ' od' : '') + (isNew ? ' new' : '') + '" data-id="' + esc(t.id) + '">' +
            '<h4>' + esc(t.topic || 'Task') + '</h4>' + (t.description ? '<p>' + esc(t.description) + '</p>' : '') +
            '<div class="bw-card-m">' + stPill(t) + priPill(t.priority) + (t.type ? '<span class="bw-pri">' + esc(t.type) + '</span>' : '') + '</div>' +
            (t.progress > 0 && isOpen(t) ? '<div class="bw-prog"><i style="width:' + t.progress + '%"></i></div>' : '') +
            '<div class="bw-card-f"><span class="' + (isOverdue(t) ? 'bw-due od' : '') + '">' + esc(dueText(t)) + '</span><span>From ' + esc(t.assigned_by || '—') + '</span></div></button>';
        }).join('') + '</div>'
        : '<div class="bw-empty"><b>' + (S.f === 'open' ? 'Nothing to do right now' : 'No tasks here') + '</b>' + (S.f === 'open' ? 'New work from your manager shows up here instantly.' : '') + '</div>');
      el.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { S.f = b.dataset.f; render(); }; });
      el.querySelectorAll('.bw-card').forEach(function (b) { b.onclick = function () { openTask(S.rows.find(function (t) { return String(t.id) === b.dataset.id; })); }; });
    }
    function markSeen(id) { S.known.add(String(id)); try { localStorage.setItem('bw_seen_' + me, JSON.stringify([].concat(Array.from(S.known)).slice(-400))); } catch (_) {} }
    function openTask(t) {
      if (!t) return; markSeen(t.id);
      var k = state(t), media = t.scope !== 'org' && t.department === 'production';
      var acts = '';
      if (k === 'pending') acts = '<button class="bw-btn pri" data-a="start">Start task</button>';
      else if (k === 'progress' || k === 'rework') acts = '<button class="bw-btn" data-a="update">Add progress update</button><button class="bw-btn green" data-a="submit">Mark completed</button>';
      var extra = (k === 'progress' || k === 'rework') ? '<div class="bw-f" id="bw-upd" hidden><span class="bw-l">Progress update</span><input type="range" class="bw-rng" min="0" max="100" step="5" value="' + (t.progress || 0) + '" id="bw-pg"><span class="bw-l" id="bw-pgt">' + (t.progress || 0) + '% done</span><textarea id="bw-note" placeholder="What did you do? Anything blocking you?"></textarea><div style="display:flex;justify-content:flex-end"><button class="bw-btn pri" data-a="saveupd">Save update</button></div></div>' +
        '<div class="bw-f" id="bw-sub" hidden><span class="bw-l">Submit your work</span><input id="bw-out" type="url" placeholder="Link to the finished work (optional) — Drive, Docs, sheet…" value="' + esc(t.asset_link && /^https?:/.test(t.asset_link) ? t.asset_link : '') + '"><textarea id="bw-subnote" placeholder="Short note for your manager (optional)"></textarea><div style="display:flex;justify-content:flex-end"><button class="bw-btn green" data-a="dosubmit">Submit as completed</button></div></div>' : '';
      if (media && (k === 'progress' || k === 'rework')) extra += '<div class="bw-note">This is Media work — you can also submit it from the Media Suite as usual.</div>';
      modal(detailHTML(t, { extra: extra }) + '<div class="bw-mf"><button class="bw-btn ghost" data-bw-close>Close</button>' + acts + '</div>', function (ov, close) {
        var rng = ov.querySelector('#bw-pg'); if (rng) rng.oninput = function () { ov.querySelector('#bw-pgt').textContent = rng.value + '% done'; };
        ov.querySelectorAll('[data-a]').forEach(function (b) {
          b.onclick = async function () {
            var a = b.dataset.a;
            if (a === 'update') { ov.querySelector('#bw-upd').hidden = false; ov.querySelector('#bw-sub').hidden = true; ov.querySelector('#bw-note').focus(); return; }
            if (a === 'submit') { ov.querySelector('#bw-sub').hidden = false; ov.querySelector('#bw-upd').hidden = true; ov.querySelector('#bw-out').focus(); return; }
            b.disabled = true;
            var patch, msg;
            if (a === 'start') { patch = { status: 'In Progress', started_at: new Date().toISOString(), history: histAdd(t, name, 'status', { to: 'In Progress' }) }; msg = 'Task started.'; }
            if (a === 'saveupd') { var pg = +ov.querySelector('#bw-pg').value, note = ov.querySelector('#bw-note').value.trim();
              if (!note && pg === (t.progress || 0)) { toast('warning', 'Move the slider or write a short update.'); b.disabled = false; return; }
              patch = { progress: pg, history: histAdd(t, name, 'update', { progress: pg, note: note || undefined }) }; if (t.status === 'Pending') patch.status = 'In Progress'; msg = 'Update saved.'; }
            if (a === 'dosubmit') { var out = ov.querySelector('#bw-out').value.trim(), sn = ov.querySelector('#bw-subnote').value.trim();
              if (out && !/^https?:\/\//i.test(out)) { toast('warning', 'The work link must start with https://'); b.disabled = false; return; }
              patch = { status: 'Completed', progress: 100, completed_at: new Date().toISOString(), submitted_at: new Date().toISOString(), history: histAdd(t, name, 'submitted', { note: sn || undefined }) };
              if (out) patch.asset_link = out; if (sn) patch.explanation = sn; msg = 'Marked completed — your manager has been updated.'; }
            var r = await saveRow(db, t.id, patch);
            if (r.error) { toast('error', 'Could not save: ' + r.error.message); b.disabled = false; return; }
            toast('success', msg); close(); load();
          };
        });
      });
    }
    el.innerHTML = '<div class="bw-empty">Loading your tasks…</div>';
    load().then(function () { S.rows.forEach(function (t) { if (!isOpen(t)) markSeen(t.id); }); });
    if (window.BELive && me) BELive.on('bework-my', { table: 'assignments' }, function (evs, info) {
      var mine = info.resync || (evs || []).some(function (e) { var n = e.new || {}, p = e.old || {}; return lc(n.employee_email) === me || lc(p.employee_email) === me || (!n.employee_email && !p.employee_email); });
      if (mine) load();
    }, { debounce: 300 });
    return { reload: load, open: function (id) { openTask(S.rows.find(function (t) { return String(t.id) === String(id); })); } };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // MANAGER / DEPARTMENT-HEAD BOARD
  // ══════════════════════════════════════════════════════════════════════════════════════
  function mountManager(el, o) {
    css();
    var db = o.db, actor = (o.actor && o.actor.name) || 'Manager', deps = o.departments || null;
    var S = { rows: [], emps: [], tab: 'active', dep: '', emp: '', pri: '', month: '', q: '', ready: false, cols: true };
    el.classList.add('bw');

    function allowedDep(d) { return !deps || deps.indexOf(d || 'production') > -1; }
    async function loadEmps() {
      var r = await db.from('hr_employees').select('id,full_name,portal_email,division,designation,employment_status,account_type');
      S.emps = (r.data || []).filter(function (e) { return (e.account_type || '') !== 'system' && e.full_name; });
    }
    async function load() {
      S.cols = await hasCols(db);
      var q = db.from('assignments').select('*').order('id', { ascending: false });
      if (deps && S.cols) q = q.in('department', deps);
      var r = await q;
      if (r.error) { el.innerHTML = '<div class="bw-empty"><b>Could not load tasks</b>' + esc(r.error.message) + '</div>'; return; }
      S.rows = (r.data || []).map(function (t) { if (!t.department) t.department = 'production'; return t; }).filter(function (t) { return allowedDep(t.department); });
      S.ready = true; render();
    }
    function empById(id) { return S.emps.find(function (e) { return String(e.id) === String(id); }); }
    function empForTask(t) { return (t.employee_id && empById(t.employee_id)) || S.emps.find(function (e) { return lc(e.portal_email) && lc(e.portal_email) === lc(t.employee_email); }); }
    function activeTargets(dep) {
      return S.emps.filter(function (e) { return (e.employment_status || 'active') === 'active' && allowedDep(e.division) && (!dep || e.division === dep); })
        .sort(function (a, b) { return a.full_name.localeCompare(b.full_name); });
    }
    function filtered() {
      var q = lc(S.q);
      return S.rows.filter(function (t) {
        var k = state(t);
        var tabOk = S.tab === 'all' || (S.tab === 'active' && isOpen(t)) || (S.tab === 'overdue' && isOverdue(t)) || (S.tab === k) || (S.tab === 'closed' && (k === 'cancelled' || k === 'rejected'));
        if (!tabOk) return false;
        if (S.dep && t.department !== S.dep) return false;
        if (S.emp && lc(t.employee_email) !== lc(S.emp)) return false;
        if (S.pri && (t.priority || 'medium') !== S.pri) return false;
        if (S.month && String(t.assigned_date || '').slice(0, 7) !== S.month) return false;
        if (q && [t.topic, t.assigned_to, DIV[t.department], t.type, t.description].join(' ').toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
    }
    function render() {
      if (!S.ready) return;
      var month = today().slice(0, 7);
      var c = { active: 0, pending: 0, progress: 0, rework: 0, overdue: 0, completed: 0, monthDone: 0, closed: 0, all: S.rows.length };
      S.rows.forEach(function (t) { var k = state(t); if (isOpen(t)) c.active++; if (c[k] != null) c[k]++; if (isOverdue(t)) c.overdue++; if (k === 'cancelled' || k === 'rejected') c.closed++;
        if (k === 'completed' && String(t.completed_at || t.submitted_at || t.date || '').slice(0, 7) === month) c.monthDone++; });
      // employees who left / paused with unfinished work
      var stuck = {};
      S.rows.filter(isOpen).forEach(function (t) { var e = empForTask(t); if (e && (e.employment_status || 'active') !== 'active') { (stuck[e.id] = stuck[e.id] || { e: e, n: 0 }).n++; } });
      var stuckList = Object.keys(stuck).map(function (k) { return stuck[k]; });
      var list = filtered();
      var depOpts = Object.keys(DIV).filter(allowedDep);
      var empOpts = {}; S.rows.forEach(function (t) { if (t.employee_email) empOpts[lc(t.employee_email)] = t.assigned_to || t.employee_email; });
      var months = {}; S.rows.forEach(function (t) { var m = String(t.assigned_date || '').slice(0, 7); if (/^\d{4}-\d{2}$/.test(m)) months[m] = 1; });
      var tabs = [['active', 'Active'], ['pending', 'Pending'], ['progress', 'In progress'], ['rework', 'Rework'], ['overdue', 'Overdue'], ['completed', 'Completed'], ['closed', 'Cancelled'], ['all', 'All']];
      el.innerHTML =
        '<div class="bw-head"><div><h2>' + esc(o.title || 'Work Assignment') + '</h2><p>' + esc(deps ? 'Assign and track work for ' + deps.map(function (d) { return DIV[d]; }).join(', ') + '.' : 'Assign and track work for every department — Media, Academics, Sales, HR and Management.') + '</p></div>' +
          '<button type="button" class="bw-new" data-new><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Assign work</button></div>' +
        (S.cols ? '' : '<div class="bw-note">Run <b>20261010_work_assignments.sql</b> in Supabase to enable departments, history and progress. Assigning still works.</div>') +
        stuckList.map(function (x) { return '<div class="bw-warn">⚠️ <span><b>' + esc(x.e.full_name) + '</b> is ' + esc(x.e.employment_status) + ' and has ' + x.n + ' active task' + (x.n === 1 ? '' : 's') + '.</span><button class="bw-btn" data-bulk="' + esc(x.e.id) + '">Reassign tasks</button></div>'; }).join('') +
        '<div class="bw-kpis">' +
          [['active', c.active, 'Total active tasks', ''], ['pending', c.pending, 'Pending', 'amber'], ['progress', c.progress, 'In progress', 'info'], ['overdue', c.overdue, 'Overdue', 'warn'], ['completed', c.monthDone, 'Completed this month', 'good']]
            .map(function (k) { return '<button type="button" class="bw-kpi ' + k[3] + (S.tab === k[0] ? ' on' : '') + '" data-tab="' + k[0] + '"><b>' + k[1] + '</b><span>' + k[2] + '</span></button>'; }).join('') + '</div>' +
        '<div class="bw-bar"><div class="bw-tabs">' + tabs.map(function (x) { return '<button type="button" data-tab="' + x[0] + '" class="' + (S.tab === x[0] ? 'on' : '') + '">' + x[1] + '<i>' + (x[0] === 'completed' ? c.completed : c[x[0]] || 0) + '</i></button>'; }).join('') + '</div></div>' +
        '<div class="bw-bar">' +
          '<input class="bw-in bw-search" type="search" placeholder="Search task, employee or department…" value="' + esc(S.q) + '" data-q>' +
          (depOpts.length > 1 ? '<select class="bw-sel" data-dep><option value="">All departments</option>' + depOpts.map(function (d) { return '<option value="' + d + '"' + (S.dep === d ? ' selected' : '') + '>' + esc(DIV[d]) + '</option>'; }).join('') + '</select>' : '') +
          '<select class="bw-sel" data-emp><option value="">All employees</option>' + Object.keys(empOpts).sort(function (a, b) { return empOpts[a].localeCompare(empOpts[b]); }).map(function (e) { return '<option value="' + esc(e) + '"' + (lc(S.emp) === e ? ' selected' : '') + '>' + esc(empOpts[e]) + '</option>'; }).join('') + '</select>' +
          '<select class="bw-sel" data-pri><option value="">Any priority</option>' + PRIO.map(function (p) { return '<option value="' + p[0] + '"' + (S.pri === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select>' +
          '<select class="bw-sel" data-month><option value="">Any month</option>' + Object.keys(months).sort().reverse().map(function (m) { return '<option value="' + m + '"' + (S.month === m ? ' selected' : '') + '>' + new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) + '</option>'; }).join('') + '</select>' +
        '</div>' +
        (list.length ? '<div class="bw-list"><div class="bw-row hd"><span>Task</span><span>Assigned to</span><span class="bw-c-pri">Priority</span><span>Due</span><span>Status</span><span class="bw-c-prog">Progress</span><span></span></div>' +
          list.slice(0, 300).map(function (t) {
            var pg = t.status === 'Completed' ? 100 : (t.progress || (t.status === 'In Progress' ? 10 : 0));
            return '<div class="bw-row" data-id="' + esc(t.id) + '">' +
              '<div class="bw-tt"><b>' + esc(t.topic || 'Task') + '</b><span>' + esc(t.type || 'Task') + ' · assigned ' + esc(fmtD(t.assigned_date)) + '</span></div>' +
              '<div class="bw-who bw-c-who"><span class="bw-ava">' + esc(initials(t.assigned_to)) + '</span><div><b>' + esc(t.assigned_to || '—') + '</b>' + depChip(t.department) + '</div></div>' +
              '<div class="bw-c-pri">' + priPill(t.priority) + '</div>' +
              '<div class="bw-due bw-c-due' + (isOverdue(t) ? ' od' : '') + '">' + esc(t.date ? fmtD(t.date) : '—') + '<small>' + esc(isOpen(t) ? dueText(t) : '') + '</small></div>' +
              '<div>' + stPill(t) + '</div>' +
              '<div class="bw-c-prog"><div class="bw-prog"><i style="width:' + pg + '%"></i></div><div class="bw-prog-t">' + pg + '%</div></div>' +
              '<div class="bw-acts">' + (isOpen(t) ? '<button class="bw-btn" data-edit="' + esc(t.id) + '">Edit</button><button class="bw-btn" data-re="' + esc(t.id) + '">Reassign</button>' : '<button class="bw-btn" data-view="' + esc(t.id) + '">View</button>') + '</div>' +
            '</div>';
          }).join('') + '</div>'
          : '<div class="bw-list"><div class="bw-empty"><b>No tasks match</b>Try another tab or filter, or assign new work.</div></div>');
      // wire
      el.querySelector('[data-new]').onclick = function () { openForm(null); };
      el.querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { S.tab = b.dataset.tab; render(); }; });
      var qi = el.querySelector('[data-q]'); qi.oninput = function () { S.q = qi.value; var pos = qi.selectionStart; render(); var n = el.querySelector('[data-q]'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {} };
      [['dep', 'dep'], ['emp', 'emp'], ['pri', 'pri'], ['month', 'month']].forEach(function (p) { var s = el.querySelector('[data-' + p[0] + ']'); if (s) s.onchange = function () { S[p[1]] = s.value; render(); }; });
      el.querySelectorAll('.bw-row[data-id]').forEach(function (r) { r.onclick = function (e) { if (e.target.closest('button')) return; view(r.dataset.id); }; });
      el.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openForm(b.dataset.edit); }; });
      el.querySelectorAll('[data-re]').forEach(function (b) { b.onclick = function () { reassign([b.dataset.re]); }; });
      el.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { view(b.dataset.view); }; });
      el.querySelectorAll('[data-bulk]').forEach(function (b) { b.onclick = function () { var e = empById(b.dataset.bulk); reassign(S.rows.filter(function (t) { return isOpen(t) && empForTask(t) === e; }).map(function (t) { return String(t.id); }), e); }; });
    }
    function rowById(id) { return S.rows.find(function (t) { return String(t.id) === String(id); }); }
    function view(id) {
      var t = rowById(id); if (!t) return;
      var open = isOpen(t), done = t.status === 'Completed';
      var acts = (open ? '<button class="bw-btn red" data-a="cancel">Cancel task</button><button class="bw-btn" data-a="re">Reassign</button><button class="bw-btn pri" data-a="edit">Edit</button>' : '') +
        (done ? '<button class="bw-btn" data-a="rework">Send back for rework</button>' : '');
      modal(detailHTML(t, { extra: done ? '<div class="bw-f" id="bw-rw" hidden><span class="bw-l">What needs to change?</span><textarea id="bw-rwn" placeholder="Explain what to fix"></textarea><div style="display:flex;justify-content:flex-end"><button class="bw-btn pri" data-a="dorework">Send back</button></div></div>' : '' }) +
        '<div class="bw-mf"><button class="bw-btn ghost" data-bw-close>Close</button>' + acts + '</div>', function (ov, close) {
        ov.querySelectorAll('[data-a]').forEach(function (b) {
          b.onclick = async function () {
            var a = b.dataset.a;
            if (a === 'edit') { close(); openForm(t.id); return; }
            if (a === 're') { close(); reassign([t.id]); return; }
            if (a === 'rework') { ov.querySelector('#bw-rw').hidden = false; ov.querySelector('#bw-rwn').focus(); return; }
            if (a === 'dorework') { var n = ov.querySelector('#bw-rwn').value.trim(); if (!n) { toast('warning', 'Explain what needs to change.'); return; }
              var r = await saveRow(db, t.id, { status: 'Rework Required', rework_reason: n, reviewed_by: actor, reviewed_at: new Date().toISOString(), completed_at: null, history: histAdd(t, actor, 'rework', { note: n }) });
              if (r.error) { toast('error', 'Could not save: ' + r.error.message); return; } toast('success', 'Sent back for rework.'); close(); load(); return; }
            if (a === 'cancel') { if (!(await confirmBox('"' + (t.topic || 'This task') + '" will be cancelled. It stays in history.', 'Cancel this task?', 'Cancel task'))) return;
              var r2 = await saveRow(db, t.id, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: actor, history: histAdd(t, actor, 'cancelled') });
              if (r2.error) { toast('error', 'Could not cancel: ' + r2.error.message); return; } toast('success', 'Task cancelled.'); close(); load(); }
          };
        });
      });
    }
    function empOptions(dep, selId) {
      var list = activeTargets(dep);
      return '<option value="">Select employee</option>' + list.map(function (e) {
        var ok = !!e.portal_email;
        return '<option value="' + esc(e.id) + '"' + (String(selId) === String(e.id) ? ' selected' : '') + (ok ? '' : ' disabled') + '>' + esc(e.full_name) + (e.designation ? ' — ' + esc(e.designation) : '') + (ok ? '' : ' (no login)') + (dep ? '' : ' · ' + esc(DIV[e.division] || e.division || '')) + '</option>'; }).join('');
    }
    function openForm(id) {
      var t = id ? rowById(id) : null, files = [];
      var e0 = t ? empForTask(t) : null;
      var dep0 = t ? (t.department || (e0 && e0.division) || '') : (deps && deps.length === 1 ? deps[0] : '');
      var depOpts = Object.keys(DIV).filter(allowedDep);
      var cats = {}; MEDIA_TYPES.concat(S.rows.map(function (x) { return x.type; })).forEach(function (c) { if (c) cats[c] = 1; });
      var pr = (t && t.priority) || 'medium';
      modal('<div class="bw-mh"><div><h3>' + (t ? 'Edit task' : 'Assign work') + '</h3><p>' + (t ? 'Changes are saved to the same task and recorded in its history.' : 'The employee is notified instantly in their own portal.') + '</p></div><button class="bw-x" data-bw-close aria-label="Close">✕</button></div>' +
        '<div class="bw-mb">' +
          '<div class="bw-f"><label class="bw-l" for="bw-title">Task / work title <b>*</b></label><input id="bw-title" maxlength="140" placeholder="e.g. Prepare October Academic Report" value="' + esc(t ? t.topic : '') + '"></div>' +
          (t ? '<div class="bw-f"><span class="bw-l">Assigned to</span><div class="bw-file"><span>' + esc(t.assigned_to || '—') + ' · ' + esc(DIV[t.department] || '') + '</span><a href="#" data-re-in>Reassign</a></div></div>'
            : '<div class="bw-g2"><div class="bw-f"><label class="bw-l" for="bw-dep">Department</label><select id="bw-dep">' + (depOpts.length > 1 ? '<option value="">All departments</option>' : '') + depOpts.map(function (d) { return '<option value="' + d + '"' + (dep0 === d ? ' selected' : '') + '>' + esc(DIV[d]) + '</option>'; }).join('') + '</select></div>' +
              '<div class="bw-f"><label class="bw-l" for="bw-emp">Employee <b>*</b></label><select id="bw-emp">' + empOptions(dep0, '') + '</select></div></div>') +
          '<div class="bw-g2"><div class="bw-f"><label class="bw-l" for="bw-cat">Category <em>optional</em></label><input id="bw-cat" list="bw-cats" placeholder="e.g. Report, Poster Design" value="' + esc(t ? (t.type || '') : '') + '"><datalist id="bw-cats">' + Object.keys(cats).map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist></div>' +
            '<div class="bw-f"><span class="bw-l">Priority</span><div class="bw-seg" role="radiogroup">' + PRIO.map(function (p) { return '<button type="button" data-p="' + p[0] + '" class="' + (pr === p[0] ? 'on' : '') + '">' + p[1] + '</button>'; }).join('') + '</div></div></div>' +
          '<div class="bw-g2"><div class="bw-f"><label class="bw-l" for="bw-ad">Assigned date</label><input id="bw-ad" type="date" value="' + esc(t ? String(t.assigned_date || '').slice(0, 10) : today()) + '"></div>' +
            '<div class="bw-f"><label class="bw-l" for="bw-due">Due date <b>*</b></label><input id="bw-due" type="date" min="' + (t ? '' : today()) + '" value="' + esc(t ? String(t.date || '').slice(0, 10) : '') + '"></div></div>' +
          '<div class="bw-f"><label class="bw-l" for="bw-desc">Description / instructions</label><textarea id="bw-desc" placeholder="What should be done, what “done” looks like, anything they need to know">' + esc(t ? (t.description || '') : '') + '</textarea></div>' +
          '<div class="bw-f"><span class="bw-l">Reference files <em>optional</em></span><div class="bw-files" id="bw-flist">' + (t ? parseRefs(t.reference_file).map(function (r) { return '<div class="bw-file">📎<span>' + esc(r.name) + '</span><a href="' + esc(r.url) + '" target="_blank" rel="noopener">Open</a></div>'; }).join('') : '') + '</div>' +
            '<label class="bw-drop"><input type="file" multiple hidden id="bw-file">📎 Add files</label></div>' +
          '<div class="bw-f"><label class="bw-l" for="bw-link">Link <em>optional</em></label><input id="bw-link" type="url" placeholder="https://…" value="' + esc(t ? (t.reference_link || '') : '') + '"></div>' +
        '</div>' +
        '<div class="bw-mf"><button class="bw-btn ghost" data-bw-close>Cancel</button><button class="bw-btn pri" data-save>' + (t ? 'Save changes' : 'Assign work') + '</button></div>', function (ov, close) {
        var pri = pr;
        ov.querySelectorAll('[data-p]').forEach(function (b) { b.onclick = function () { pri = b.dataset.p; ov.querySelectorAll('[data-p]').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
        var dep = ov.querySelector('#bw-dep'), emp = ov.querySelector('#bw-emp');
        if (dep) dep.onchange = function () { emp.innerHTML = empOptions(dep.value, emp.value); };
        var reIn = ov.querySelector('[data-re-in]'); if (reIn) reIn.onclick = function (e) { e.preventDefault(); close(); reassign([t.id]); };
        var fi = ov.querySelector('#bw-file');
        function paintFiles() {
          var box = ov.querySelector('#bw-flist'); box.querySelectorAll('.bw-file.new').forEach(function (x) { x.remove(); });
          box.insertAdjacentHTML('beforeend', files.map(function (f, i) { return '<div class="bw-file new">📎<span>' + esc(f.name) + '</span><a href="#" data-rm="' + i + '">Remove</a></div>'; }).join(''));
          box.querySelectorAll('[data-rm]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); files.splice(+a.dataset.rm, 1); paintFiles(); }; });
        }
        fi.onchange = function () { Array.prototype.forEach.call(fi.files, function (f) { if (f.size > 50 * 1024 * 1024) toast('warning', f.name + ' is over 50 MB — skipped.'); else files.push(f); }); fi.value = ''; paintFiles(); };
        ov.querySelector('[data-save]').onclick = async function () {
          var btn = this, title = ov.querySelector('#bw-title').value.trim(), due = ov.querySelector('#bw-due').value, ad = ov.querySelector('#bw-ad').value || today();
          var link = ov.querySelector('#bw-link').value.trim(), cat = ov.querySelector('#bw-cat').value.trim(), desc = ov.querySelector('#bw-desc').value.trim();
          if (!title) { toast('warning', 'Add a task title.'); ov.querySelector('#bw-title').focus(); return; }
          var e = t ? null : empById(emp.value);
          if (!t && !e) { toast('warning', 'Choose the employee.'); emp.focus(); return; }
          if (!due) { toast('warning', 'Set a due date.'); ov.querySelector('#bw-due').focus(); return; }
          if (!t && !S.cols && e.division !== 'production') { toast('warning', 'Run 20261010_work_assignments.sql in Supabase first — until then only Media work can be assigned.'); return; }
          if (link && !/^https?:\/\//i.test(link)) { toast('warning', 'The link must start with https://'); return; }
          btn.disabled = true; btn.textContent = files.length ? 'Uploading…' : 'Saving…';
          var refStr = t ? (t.reference_file || '') : '';
          if (files.length) { try { var up = await uploadFiles(db, files, function (p) { btn.textContent = 'Uploading ' + p + '%…'; });
            refStr = [refStr].concat(up.map(function (u) { return u.name + '|' + u.url; })).filter(Boolean).join(';;'); }
            catch (err) { toast('error', 'File upload failed: ' + (err.message || err)); btn.disabled = false; btn.textContent = t ? 'Save changes' : 'Assign work'; return; } }
          var r;
          if (t) {
            var patch = { topic: title, type: cat || t.type || 'Task', priority: pri, assigned_date: ad, date: due, description: desc, reference_file: refStr, reference_link: link || null };
            var changed = Object.keys(patch).filter(function (k) { return String(patch[k] == null ? '' : patch[k]) !== String(t[k] == null ? '' : t[k]); });
            if (!changed.length) { close(); return; }
            patch.history = histAdd(t, actor, 'edited', { fields: changed.map(function (k) { return { topic: 'title', type: 'category', date: 'due date', assigned_date: 'assigned date', reference_file: 'files', reference_link: 'link' }[k] || k; }) });
            r = await saveRow(db, t.id, patch);
          } else {
            var media = e.division === 'production';
            r = await saveRow(db, null, {
              id: Date.now(), topic: title, type: cat || (media ? 'Video Editing' : 'Task'), description: desc,
              assigned_to: e.full_name, employee_email: lc(e.portal_email), employee_id: e.id, department: e.division || 'other',
              scope: media ? 'media' : 'org', assigned_date: ad, date: due, status: 'Pending', explanation: 'None', asset_link: '',
              reference_file: refStr, reference_link: link || null, assigned_by: actor, created_by: actor, priority: pri, assign_approved: true, progress: 0,
              history: [{ at: new Date().toISOString(), by: actor, action: 'created', to: e.full_name }]
            });
          }
          if (r.error) { toast('error', 'Could not save: ' + r.error.message); btn.disabled = false; btn.textContent = t ? 'Save changes' : 'Assign work'; return; }
          toast('success', t ? 'Task updated.' : 'Work assigned to ' + e.full_name + ' — they have been notified.');
          close(); load();
        };
      });
    }
    function reassign(ids, fromEmp) {
      var tasks = ids.map(rowById).filter(Boolean); if (!tasks.length) return;
      var dep0 = fromEmp ? fromEmp.division : (tasks[0].department || '');
      var depOpts = Object.keys(DIV).filter(allowedDep);
      modal('<div class="bw-mh"><div><h3>Reassign ' + (tasks.length === 1 ? 'task' : tasks.length + ' tasks') + '</h3><p>' + esc(tasks.length === 1 ? tasks[0].topic : 'All active tasks of ' + (fromEmp ? fromEmp.full_name : 'this employee')) + '</p></div><button class="bw-x" data-bw-close aria-label="Close">✕</button></div>' +
        '<div class="bw-mb"><div class="bw-g2"><div class="bw-f"><label class="bw-l" for="bw-rdep">Department</label><select id="bw-rdep">' + (depOpts.length > 1 ? '<option value="">All departments</option>' : '') + depOpts.map(function (d) { return '<option value="' + d + '"' + (dep0 === d ? ' selected' : '') + '>' + esc(DIV[d]) + '</option>'; }).join('') + '</select></div>' +
        '<div class="bw-f"><label class="bw-l" for="bw-remp">New employee <b>*</b></label><select id="bw-remp">' + empOptions(dep0, '') + '</select></div></div>' +
        '<div class="bw-f"><label class="bw-l" for="bw-rn">Reason <em>optional</em></label><input id="bw-rn" placeholder="e.g. On leave this week"></div>' +
        '<div class="bw-note">The new employee is notified and starts from Pending. The previous assignee no longer sees it as active. History is kept.</div></div>' +
        '<div class="bw-mf"><button class="bw-btn ghost" data-bw-close>Cancel</button><button class="bw-btn pri" data-go>Reassign</button></div>', function (ov, close) {
        var dep = ov.querySelector('#bw-rdep'), emp = ov.querySelector('#bw-remp');
        dep.onchange = function () { emp.innerHTML = empOptions(dep.value, emp.value); };
        ov.querySelector('[data-go]').onclick = async function () {
          var e = empById(emp.value); if (!e) { toast('warning', 'Choose the new employee.'); return; }
          if (!S.cols && e.division !== 'production') { toast('warning', 'Run 20261010_work_assignments.sql in Supabase first — until then only Media work can be reassigned.'); return; }
          var note = ov.querySelector('#bw-rn').value.trim(), btn = this; btn.disabled = true;
          for (var t of tasks) {
            if (lc(t.employee_email) === lc(e.portal_email)) continue;
            var media = e.division === 'production';
            var r = await saveRow(db, t.id, { assigned_to: e.full_name, employee_email: lc(e.portal_email), employee_id: e.id, department: e.division || 'other', scope: media ? 'media' : 'org',
              status: 'Pending', progress: 0, started_at: null, history: histAdd(t, actor, 'reassigned', { from: t.assigned_to, to: e.full_name, note: note || undefined }) });
            if (r.error) { toast('error', 'Could not reassign: ' + r.error.message); btn.disabled = false; return; }
          }
          toast('success', (tasks.length === 1 ? 'Task' : tasks.length + ' tasks') + ' reassigned to ' + e.full_name + '.');
          close(); load();
        };
      });
    }
    el.innerHTML = '<div class="bw-empty">Loading work assignments…</div>';
    Promise.all([loadEmps(), load()]).then(render);
    if (window.BELive) BELive.on('bework-mgr' + (deps ? '-' + deps.join('_') : ''), ['assignments', 'hr_employees'], function (evs, info) {
      if (info.resync || (evs || []).some(function (e) { return e.table === 'hr_employees'; })) loadEmps().then(load); else load();
    }, { debounce: 400 });
    return { reload: load, assign: function () { openForm(null); } };
  }

  window.BEWork = { mountMyTasks: mountMyTasks, mountManager: mountManager, DIV: DIV, isOpen: isOpen, isOverdue: isOverdue };
})();
