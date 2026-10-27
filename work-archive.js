/* ════════════════════════════════════════════════════════════════════════════
   BEArchive — Media Suite → Completed Work History → "Create Monthly Archive".

   Flow: pick month → server preview (projects grouped by project id, every deliverable, missing
   files flagged) → confirm → files archived in batches with live progress (the page never
   blocks; each batch is one server call) → index Sheet → share the private folder with
   Co-Founders (or copy the link). Everything goes through the work-archive edge function
   (ERP session + role checked there); Drive work is done by the existing Apps Script account.
   Nothing is shown as created unless the server returned the real folder.

   BEArchive.mount(buttonHost)   adds the button — "Create Monthly Archive" for leadership / Department
                                 Heads (their scope), "My Monthly Work" for every other employee
   BEArchive.open()
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BEArchive) return;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var S = { scope: null, scopeKey: null, month: null, preview: null, archive: null, running: false, ov: null, stop: false };
  var DIVL = { education: 'Academics', production: 'Media / Production', sales: 'Sales', hr: 'HR', accounts: 'Accounts', management: 'Management', other: 'Administration' };
  function viewOnly() { return !(S.scope && S.scope.can_create); }
  function scopeName(k) { var x = ((S.scope && S.scope.scopes) || []).find(function (z) { return z.key === k; }); return x ? x.label : (k === 'org' ? 'Whole organisation' : k); }

  function B() { return window.BESession || {}; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(t, m) { if (window.showToast) window.showToast(t, m); }
  function istMonth() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).slice(0, 7); }
  function mLabel(m) { var p = String(m).split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0]; }
  function fmtD(d) { if (!d) return '—'; var x = new Date(String(d).slice(0, 10) + 'T00:00:00'); return isNaN(x) ? d : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  function fmtTs(d) { if (!d) return ''; var x = new Date(d); return isNaN(x) ? '' : x.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }); }

  async function api(action, body) {
    var tk = B().ensure ? await B().ensure() : null;
    if (!tk) throw new Error('Your session has expired. Please sign in again.');
    var r = await fetch(B().url + '/functions/v1/work-archive', { method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: B().anonKey, Authorization: 'Bearer ' + B().anonKey, 'x-erp-session': tk },
      body: JSON.stringify(Object.assign({ action: action }, body || {})) });
    var j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && !(body && body._retry) && B().clear && j.code === 'SESSION_EXPIRED') {
      try { B().clear(B().currentEmail()); } catch (_) {}
      if (await B().ensure()) return api(action, Object.assign({}, body || {}, { _retry: true }));
    }
    if (!r.ok) throw new Error(j.error || 'The archive service is unavailable right now.');
    return j;
  }

  function css() {
    if (document.getElementById('bea-css')) return;
    var st = document.createElement('style'); st.id = 'bea-css';
    st.textContent = [
      '.bea-btn{text-decoration:none;display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:11px;border:1px solid rgba(255,107,6,.35);background:rgba(255,107,6,.1);color:var(--fg-orange, #ffb37a);font-size:12.5px;font-weight:700;cursor:pointer;transition:background .15s}',
      '.bea-btn:hover{background:rgba(255,107,6,.18)}.bea-btn.pri{background:linear-gradient(135deg,#ff6b06,#ff0552);border-color:transparent;color:#fff}.bea-btn.ghost{background:transparent;border-color:rgba(var(--ink, 255,255,255), 0.12);color:var(--tx-2, #c7cbe0)}',
      '.bea-btn:disabled{opacity:.45;cursor:not-allowed}.bea-btn.sm{padding:6px 10px;font-size:11.5px;border-radius:9px}',
      '.bea-ov{position:fixed;inset:0;z-index:9100;background:rgba(var(--scrim, 3,5,10), calc(0.72 * var(--scrim-k, 1)));backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px}',
      '.bea-m{width:100%;max-width:980px;max-height:92vh;display:flex;flex-direction:column;background:linear-gradient(180deg,var(--sf-2, #12141c),var(--sf-1, #0b0c12));border:1px solid rgba(var(--ink, 255,255,255), 0.09);border-radius:18px;box-shadow:0 30px 80px rgba(var(--shade, 0,0,0), calc(0.55 * var(--shade-k, 1)));color:var(--tx-1, #e6e9f5)}',
      '.bea-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px 12px;border-bottom:1px solid rgba(var(--ink, 255,255,255), 0.06)}',
      '.bea-h h3{margin:0;font-size:17px;font-weight:800;color:var(--tx-0, #fff)}.bea-h p{margin:3px 0 0;font-size:12px;color:var(--tx-5, #7d86ad)}',
      '.bea-x{background:none;border:0;color:var(--tx-5, #7d86ad);font-size:18px;cursor:pointer;padding:2px 6px;border-radius:8px}.bea-x:hover{color:var(--tx-0, #fff);background:rgba(var(--ink, 255,255,255), 0.06)}',
      '.bea-b{padding:16px 20px;overflow:auto;flex:1}.bea-f{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px 16px;border-top:1px solid rgba(var(--ink, 255,255,255), 0.06)}',
      '.bea-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}.bea-l{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--tx-6, #6b74a0)}',
      '.bea-sel{background:rgba(var(--ink, 255,255,255), 0.04);border:1px solid rgba(var(--ink, 255,255,255), 0.12);border-radius:10px;color:var(--tx-1, #e6e9f5);padding:8px 10px;font-size:13px;font-weight:600}',
      '.bea-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}',
      '.bea-kpi{padding:12px 14px;border-radius:12px;background:rgba(var(--ink, 255,255,255), 0.03);border:1px solid rgba(var(--ink, 255,255,255), 0.07)}.bea-kpi b{display:block;font-size:22px;font-weight:800;color:var(--tx-0, #fff);font-variant-numeric:tabular-nums}.bea-kpi span{font-size:11px;color:var(--tx-4, #8b93b8)}',
      '.bea-kpi.bad{border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.06)}.bea-kpi.bad b{color:var(--fg-red, #f87171)}',
      '.bea-p{border:1px solid rgba(var(--ink, 255,255,255), 0.07);border-radius:13px;padding:12px 14px;margin-top:10px;background:rgba(var(--ink, 255,255,255), 0.02)}.bea-p.miss{border-color:rgba(248,113,113,.35)}',
      '.bea-pt{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-weight:700;font-size:14px;color:var(--tx-0, #fff)}.bea-ps{font-size:11.5px;color:var(--tx-4, #8b93b8);margin-top:3px}',
      '.bea-chip{font-size:10px;font-weight:800;letter-spacing:.04em;padding:2px 8px;border-radius:999px;border:1px solid;white-space:nowrap}',
      '.bea-d{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 0;border-top:1px solid rgba(var(--ink, 255,255,255), 0.05);font-size:12.5px}',
      '.bea-d:first-of-type{border-top:0}.bea-dn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tx-2, #d5d9ee)}.bea-dn small{color:var(--tx-6, #6b74a0);margin-left:6px}',
      '.bea-prog{height:10px;border-radius:999px;background:rgba(var(--ink, 255,255,255), 0.06);overflow:hidden}.bea-prog>i{display:block;height:100%;background:linear-gradient(90deg,#ff6b06,#ff0552);transition:width .3s}',
      '.bea-note{font-size:12px;color:var(--tx-3, #a5adcf);padding:10px 12px;border-radius:10px;background:rgba(var(--ink, 255,255,255), 0.03);border:1px solid rgba(var(--ink, 255,255,255), 0.07);margin-top:10px}',
      '.bea-err{color:var(--fg-red, #fca5a5);border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.06)}',
      '.bea-link{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}.bea-link input{flex:1;min-width:220px;background:rgba(var(--ink, 255,255,255), 0.04);border:1px solid rgba(var(--ink, 255,255,255), 0.12);border-radius:10px;color:var(--tx-1, #e6e9f5);padding:9px 11px;font-size:12.5px}',
      '.bea-rc{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:10px;border:1px solid rgba(var(--ink, 255,255,255), 0.07);margin-top:6px;cursor:pointer;font-size:13px}.bea-rc input{accent-color:#ff6b06;width:15px;height:15px}',
      '.bea-hist{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-top:1px solid rgba(var(--ink, 255,255,255), 0.05);font-size:12.5px}',
      '@media(max-width:640px){.bea-m{max-height:96vh;border-radius:14px}.bea-b,.bea-h,.bea-f{padding-left:14px;padding-right:14px}.bea-f .bea-btn{flex:1;justify-content:center}}'
    ].join('');
    document.head.appendChild(st);
  }

  var KIND = { drive_file: 'Drive file → shortcut', drive_folder: 'Drive folder → shortcut', storage: 'ERP file → copy', link: 'Link only', missing: 'Missing', no_output: 'No output' };
  function chip(d) {
    var m = { done: ['Archived', '#22c55e'], failed: ['Failed', '#f87171'], pending: ['To archive', '#38bdf8'], link: ['Link only', '#a5adcf'], missing: ['MISSING FILE', '#f87171'], no_output: ['No output', '#86efac'] }[d.status] || [d.status, '#a5adcf'];
    return '<span class="bea-chip" style="color:' + m[1] + ';border-color:' + m[1] + '55;background:' + m[1] + '14"' + (d.error ? ' title="' + esc(d.error) + '"' : '') + '>' + m[0] + '</span>';
  }

  function modal() {
    if (S.ov && document.body.contains(S.ov)) return S.ov;
    css();
    var ov = document.createElement('div'); ov.className = 'bea-ov';
    ov.innerHTML = '<div class="bea-m" role="dialog" aria-modal="true" aria-label="Monthly Work Archive"><div class="bea-h"><div><h3>' + (viewOnly() ? 'My Monthly Work' : 'Monthly Work Archive') + '</h3><p>' + (viewOnly() ? 'Your completed work of a month, with archive links once it has been archived.' : 'Completed work of a month, from every department in your scope, in one private Google Drive folder with an index Sheet.') + '</p></div><button class="bea-x" data-x aria-label="Close">✕</button></div><div class="bea-b" data-body></div><div class="bea-f" data-foot></div></div>';
    ov.addEventListener('mousedown', function (e) { if (e.target === ov && !S.running) close(); });
    ov.querySelector('[data-x]').onclick = function () { close(); };
    document.body.appendChild(ov); S.ov = ov;
    return ov;
  }
  function close() { if (S.ov) S.ov.remove(); S.ov = null; }
  function paint(body, foot) {
    var ov = modal();
    ov.querySelector('[data-body]').innerHTML = body;
    ov.querySelector('[data-foot]').innerHTML = foot || '';
    if (window.lucide) try { lucide.createIcons(); } catch (_) {}
    return ov;
  }

  // ── step 1: pick month ───────────────────────────────────────────────────
  async function pickStep() {
    var cur = S.month || istMonth(), y = +cur.slice(0, 4), thisY = +istMonth().slice(0, 4);
    var years = []; for (var k = thisY; k >= Math.min(2025, y); k--) years.push(k);
    var ov = paint(
      '<div class="bea-row"><span class="bea-l">Month</span><select class="bea-sel" data-m>' + MONTHS.map(function (n, i) { var v = String(i + 1).padStart(2, '0'); return '<option value="' + v + '"' + (cur.slice(5) === v ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select>' +
        '<span class="bea-l">Year</span><select class="bea-sel" data-y>' + years.map(function (v) { return '<option' + (v === y ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select>' +
        (!viewOnly() && S.scope.scopes.length > 1 ? '<span class="bea-l">Scope</span><select class="bea-sel" data-s>' + S.scope.scopes.map(function (z) { return '<option value="' + esc(z.key) + '"' + (z.key === S.scopeKey ? ' selected' : '') + '>' + esc(z.label) + '</option>'; }).join('') + '</select>' : '') + '</div>' +
        '<div data-hist class="bea-note" style="margin-top:16px">Loading earlier archives…</div>',
      '<button class="bea-btn ghost" data-x2>Cancel</button><button class="bea-btn pri" data-go>' + (viewOnly() ? 'Show my work' : 'Preview archive') + '</button>');
    ov.querySelector('[data-x2]').onclick = close;
    ov.querySelector('[data-go]').onclick = function () { var sc = ov.querySelector('[data-s]'); if (sc) S.scopeKey = sc.value; S.month = ov.querySelector('[data-y]').value + '-' + ov.querySelector('[data-m]').value; previewStep(); };
    try {
      var l = await api('list'), h = ov.querySelector('[data-hist]'); if (!h) return;
      h.innerHTML = (l.archives || []).length ? '<div class="bea-l" style="margin-bottom:4px">Earlier archives</div>' + l.archives.map(function (a) {
        var st = { completed: ['Completed', '#22c55e'], partial: ['Some files failed', '#fbbf24'], running: ['In progress', '#38bdf8'], draft: ['Not started', '#a5adcf'], failed: ['Failed', '#f87171'] }[a.status] || [a.status, '#a5adcf'];
        return '<div class="bea-hist"><span><b style="color:var(--tx-0, #fff)">' + esc(mLabel(a.month)) + '</b> <small style="color:var(--tx-2, #c7cbe0)">· ' + esc(a.scope_label || 'Whole organisation') + '</small> <small style="color:var(--tx-6, #6b74a0)">· ' + esc(a.created_by || '') + ' · ' + esc(fmtTs(a.updated_at || a.created_at)) + '</small></span><span style="display:flex;gap:8px;align-items:center"><span class="bea-chip" style="color:' + st[1] + ';border-color:' + st[1] + '55">' + st[0] + '</span>' +
          (a.folder_url ? '<a href="' + esc(a.folder_url) + '" target="_blank" rel="noopener" class="bea-btn sm ghost">Open folder</a>' : '') + (viewOnly() || a.can_manage === false ? '' : '<button class="bea-btn sm" data-open="' + esc(a.month) + '" data-sk="' + esc(a.scope_key || 'org') + '">View</button>') + '</span></div>';
      }).join('') : (viewOnly() ? 'None of your work has been archived yet.' : 'No archives yet. The first one creates the “Broken English Work Archive” folder in Google Drive.');
      h.querySelectorAll('[data-open]').forEach(function (b) { b.onclick = function () { S.month = b.dataset.open; S.scopeKey = b.dataset.sk; previewStep(); }; });
    } catch (e) { var hh = ov.querySelector('[data-hist]'); if (hh) { hh.className = 'bea-note bea-err'; hh.textContent = e.message; } }
  }

  // ── step 2: preview (nothing written yet) ─────────────────────────────────
  async function previewStep() {
    paint('<div class="bea-note">Collecting completed work for ' + esc(mLabel(S.month)) + '…</div>', '');
    var p;
    try { p = await api('preview', { month: S.month, scope: S.scopeKey }); } catch (e) { paint('<div class="bea-note bea-err">' + esc(e.message) + '</div>', '<button class="bea-btn ghost" data-back>Back</button>'); return bindBack(); }
    S.preview = p; S.archive = p.archive;
    var t = p.totals, a = p.archive;
    var exists = a && a.month_folder_id;
    var head = '<div class="bea-row" style="justify-content:space-between"><div><div class="bea-l">' + (viewOnly() ? 'My completed work' : 'Preview · ' + esc(scopeName(S.scopeKey))) + '</div><div style="font-size:18px;font-weight:800;color:var(--tx-0, #fff)">' + esc(mLabel(S.month)) + '</div></div>' +
      (viewOnly() ? (a && a.folder_url ? '<div class="bea-note" style="margin:0">Archived in Google Drive. <a href="' + esc(a.folder_url) + '" target="_blank" rel="noopener" style="color:var(--fg-orange, #ffb37a)">Open folder</a> — opens if the folder has been shared with you.</div>' : '') : exists ? '<div class="bea-note" style="margin:0">Archive exists (' + esc(a.status) + ') — files already archived are kept and <b>not</b> sent again; only new or failed work is added.' + (a.folder_url ? ' <a href="' + esc(a.folder_url) + '" target="_blank" rel="noopener" style="color:var(--fg-orange, #ffb37a)">Open folder</a>' : '') + '</div>' : '') + '</div>';
    var kpis = '<div class="bea-kpis"><div class="bea-kpi"><b>' + t.projects + '</b><span>Completed projects</span></div><div class="bea-kpi"><b>' + t.files + '</b><span>Output files</span></div>' +
      '<div class="bea-kpi' + (t.projects_missing ? ' bad' : '') + '"><b>' + t.projects_missing + '</b><span>Projects with missing files</span></div>' +
      (t.no_output ? '<div class="bea-kpi"><b>' + t.no_output + '</b><span>No-output work (listed only)</span></div>' : '') +
      (t.links ? '<div class="bea-kpi"><b>' + t.links + '</b><span>Links (listed in index)</span></div>' : '') + '</div>';
    var miss = t.missing ? '<div class="bea-note bea-err"><b>' + t.missing + ' deliverable(s) have no output file.</b> They are listed as MISSING in the index Sheet — nothing is silently skipped.</div>' : '';
    var list = p.projects.length ? p.projects.map(function (pr) {
      var cats = Array.from(new Set(pr.deliverables.map(function (d) { return d.category; }))).join(', ');
      var who = Array.from(new Set(pr.deliverables.map(function (d) { return d.creator; }))).join(', ');
      var deps = Array.from(new Set(pr.deliverables.map(function (d) { return DIVL[d.department] || d.department; }).filter(Boolean)));
      return '<div class="bea-p' + (pr.missing ? ' miss' : '') + '"><div class="bea-pt">' + esc(pr.title) + (pr.is_project ? ' <span class="bea-chip" style="color:var(--fg-violet, #c4b5fd);border-color:#c4b5fd55">PROJECT</span>' : '') +
        deps.map(function (d) { return ' <span class="bea-chip" style="color:var(--fg-sky, #7dd3fc);border-color:#7dd3fc55">' + esc(d) + '</span>'; }).join('') +
        (pr.missing ? ' <span class="bea-chip" style="color:var(--fg-red, #f87171);border-color:#f8717155">' + pr.missing + ' MISSING</span>' : '') + '</div>' +
        '<div class="bea-ps">' + esc(cats) + ' · ' + esc(who) + ' · completed ' + esc(fmtD(pr.completed_on)) + ' · ' + pr.deliverables.length + ' deliverable' + (pr.deliverables.length === 1 ? '' : 's') + '</div><div style="margin-top:6px">' +
        pr.deliverables.map(function (d) {
          return '<div class="bea-d"><div class="bea-dn">' + (d.url ? '<a href="' + esc(d.url) + '" target="_blank" rel="noopener" style="color:var(--tx-2, #d5d9ee)">' + esc(d.name) + '</a>' : esc(d.name)) + '<small>' + esc(KIND[d.kind] || d.kind) + ' · ' + esc(d.category) + ' · ' + esc(d.creator) + ' · ' + esc(fmtD(d.completed_on)) + (d.approved ? '' : ' · awaiting approval') + '</small></div><span style="display:flex;gap:6px;align-items:center">' + (d.drive_url ? '<a class="bea-btn sm ghost" href="' + esc(d.drive_url) + '" target="_blank" rel="noopener">Archive link</a>' : '') + (viewOnly() && d.status === 'pending' ? '<span class="bea-chip" style="color:var(--tx-3, #a5adcf);border-color:#a5adcf55">Not archived yet</span>' : chip(d)) + '</span></div>';
        }).join('') + '</div></div>';
    }).join('') : '<div class="bea-note">No completed work in ' + esc(mLabel(S.month)) + '.</div>';
    var toDo = t.pending + t.failed;
    if (viewOnly()) { paint(head + kpis + list, '<button class="bea-btn ghost" data-back>Change month</button>'); return bindBack(); }
    var ov = paint(head + kpis + miss + list,
      '<button class="bea-btn ghost" data-back>Change month</button>' +
      (exists && a.folder_url && !toDo ? '<button class="bea-btn" data-res>Folder &amp; sharing</button>' : '') +
      (p.projects.length ? '<button class="bea-btn pri" data-create>' + (exists ? (toDo ? 'Update archive (' + toDo + ' file' + (toDo === 1 ? '' : 's') + ')' : 'Refresh index') : 'Create archive') + '</button>' : ''));
    bindBack();
    var c = ov.querySelector('[data-create]'); if (c) c.onclick = function () { runStep(); };
    var r = ov.querySelector('[data-res]'); if (r) r.onclick = function () { resultStep(a); };
  }
  function bindBack() { var b = S.ov && S.ov.querySelector('[data-back]'); if (b) b.onclick = function () { pickStep(); }; }

  // ── step 3: create + archive in batches (non-blocking) ───────────────────
  async function runStep() {
    if (S.running) return;
    S.running = true; S.stop = false;
    var prog = function (t, msg) {
      var total = (t.done || 0) + (t.failed || 0) + (t.pending || 0), done = (t.done || 0) + (t.failed || 0), pct = total ? Math.round(done / total * 100) : 100;
      paint('<div class="bea-l">Archiving ' + esc(mLabel(S.month)) + '</div><div style="font-size:15px;font-weight:700;color:var(--tx-0, #fff);margin:6px 0 10px">' + esc(msg) + '</div>' +
        '<div class="bea-prog"><i style="width:' + pct + '%"></i></div><div class="bea-row" style="justify-content:space-between;margin-top:8px;font-size:12px;color:var(--tx-4, #8b93b8)"><span>' + (t.done || 0) + ' archived · ' + (t.failed || 0) + ' failed · ' + (t.pending || 0) + ' to go</span><span>' + pct + '%</span></div>' +
        '<div class="bea-note">You can keep working in other tabs — the archive continues while this window is open. Original deliverables are never moved or changed.</div>',
        '<button class="bea-btn ghost" data-stop>Pause</button>');
      var sb = S.ov.querySelector('[data-stop]'); if (sb) sb.onclick = function () { S.stop = true; sb.disabled = true; sb.textContent = 'Pausing after this batch…'; };
    };
    try {
      prog({}, 'Preparing Google Drive folders…');
      var c = await api('create', { month: S.month, scope: S.scopeKey });
      S.archive = c.archive;
      var t = c.totals;
      prog(t, 'Archiving files…');
      while (t.pending > 0 && !S.stop) {
        var r = await api('process', { archive_id: S.archive.id });
        t = r.totals; prog(t, 'Archiving files…');
        await new Promise(function (res) { setTimeout(res, 50); });   // let the page breathe between batches
      }
      if (S.stop && t.pending > 0) { S.running = false; return previewStep(); }
      prog(t, 'Writing the index Sheet…');
      var f = await api('finalize', { archive_id: S.archive.id });
      S.archive = f.archive; S.running = false;
      resultStep(f.archive, f);
    } catch (e) {
      S.running = false;
      paint('<div class="bea-note bea-err"><b>The archive was not completed.</b><br>' + esc(e.message) + '</div><div class="bea-note">Files already archived are kept. Run it again to continue — nothing is duplicated.</div>',
        '<button class="bea-btn ghost" data-back>Back</button><button class="bea-btn pri" data-again>Try again</button>');
      bindBack(); S.ov.querySelector('[data-again]').onclick = function () { runStep(); };
    }
  }

  // ── step 4: result + share ───────────────────────────────────────────────
  async function resultStep(a, data) {
    if (!data) { try { data = await api('get', { month: a.month, scope: a.scope_key || S.scopeKey }); a = data.archive || a; } catch (e) { data = { totals: a.totals || {}, projects: [] }; } }
    var t = data.totals || {}, ok = a.status === 'completed', failedItems = [];
    (data.projects || []).forEach(function (p) { p.deliverables.forEach(function (d) { if (d.status === 'failed') failedItems.push({ p: p.title, d: d }); }); });
    var rec = (S.scope && S.scope.recipients) || [];
    var shared = Array.isArray(a.shared_with) ? a.shared_with : [];
    var sharedOk = {}; shared.forEach(function (s) { if (s.ok) sharedOk[String(s.email).toLowerCase()] = s; });
    var ov = paint(
      '<div class="bea-note" style="' + (ok ? 'border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.06)' : 'border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.06)') + '"><b style="color:' + (ok ? '#86efac' : '#fde68a') + '">' +
        (ok ? 'Archive created for ' + esc(mLabel(a.month)) : 'Archive created for ' + esc(mLabel(a.month)) + ' — ' + failedItems.length + ' file(s) failed') + ' · ' + esc(scopeName(a.scope_key || S.scopeKey)) + '</b><br>' +
        (t.done || 0) + ' file' + ((t.done || 0) === 1 ? '' : 's') + ' archived across ' + (t.projects || 0) + ' project' + ((t.projects || 0) === 1 ? '' : 's') + (t.missing ? ' · ' + t.missing + ' missing (listed in the index)' : '') + (t.links ? ' · ' + t.links + ' link(s) listed' : '') + '.</div>' +
      '<div class="bea-l" style="margin-top:16px">Google Drive folder</div><div class="bea-link"><input readonly value="' + esc(a.folder_url || '') + '" data-url><button class="bea-btn sm" data-copy>Copy link</button><a class="bea-btn sm ghost" href="' + esc(a.folder_url || '#') + '" target="_blank" rel="noopener">Open</a>' +
        (a.sheet_url ? '<a class="bea-btn sm ghost" href="' + esc(a.sheet_url) + '" target="_blank" rel="noopener">Index Sheet</a>' : '') + '</div>' +
      '<div class="bea-note">The folder is private. Only the people you share it with below can open it.</div>' +
      (failedItems.length ? '<div class="bea-note bea-err"><b>Failed files</b>' + failedItems.slice(0, 30).map(function (x) { return '<div style="margin-top:4px">' + esc(x.p) + ' — ' + esc(x.d.name) + ': <span style="color:var(--fg-red, #fecaca)">' + esc(x.d.error || 'Failed') + '</span></div>'; }).join('') + '</div>' : '') +
      '<div class="bea-l" style="margin-top:16px">Share the folder</div>' +
      (rec.length ? rec.map(function (r) { var done = sharedOk[r.email], mine = String(a.scope_key || S.scopeKey || '').indexOf('self:') === 0;
        // personal archive → share with yourself by default; organisation / department → Co-Founders
        var pre = !done && (mine ? r.role === 'You' : r.role !== 'You');
        return '<label class="bea-rc"><input type="checkbox" data-rc value="' + esc(r.email) + '"' + (pre ? ' checked' : '') + '><span><b>' + esc(r.name) + '</b> <small style="color:var(--tx-6, #6b74a0)">' + esc(r.role) + ' · ' + esc(r.email) + '</small></span>' + (done ? '<span class="bea-chip" style="margin-left:auto;color:var(--fg-green, #86efac);border-color:#86efac55">Shared</span>' : '') + '</label>'; }).join('')
        : '<div class="bea-note">No Co-Founder email is on file in HR — add the email below or copy the link.</div>') +
      '<div class="bea-link"><input type="text" placeholder="Other email(s), comma separated" data-more></div>' +
      '<div data-shareres></div>',
      '<button class="bea-btn ghost" data-close>Close</button>' + (failedItems.length ? '<button class="bea-btn" data-retry>Retry failed files</button>' : '') + '<button class="bea-btn pri" data-share>Share folder</button>');
    ov.querySelector('[data-close]').onclick = close;
    ov.querySelector('[data-copy]').onclick = function () {
      var u = a.folder_url || ''; if (!u) return;
      (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { toast('success', 'Folder link copied.'); }, function () { var i = ov.querySelector('[data-url]'); i.select(); document.execCommand('copy'); toast('success', 'Folder link copied.'); });
    };
    var rb = ov.querySelector('[data-retry]');
    if (rb) rb.onclick = async function () { rb.disabled = true; try { await api('retry', { archive_id: a.id }); runStep(); } catch (e) { toast('error', e.message); rb.disabled = false; } };
    ov.querySelector('[data-share]').onclick = async function () {
      var btn = this, emails = Array.from(ov.querySelectorAll('[data-rc]:checked')).map(function (x) { return x.value; })
        .concat(String(ov.querySelector('[data-more]').value || '').split(/[,;\s]+/).filter(Boolean));
      if (!emails.length) { toast('warning', 'Choose at least one person, or copy the link.'); return; }
      btn.disabled = true; btn.textContent = 'Sharing…';
      try {
        var r = await api('share', { archive_id: a.id, emails: emails });
        a.shared_with = r.shared_with;
        var bad = (r.results || []).filter(function (x) { return !x.ok; });
        ov.querySelector('[data-shareres]').innerHTML = '<div class="bea-note' + (bad.length ? ' bea-err' : '') + '">' + (r.results || []).map(function (x) { return '<div>' + (x.ok ? '✓ Shared with ' : '✕ Could not share with ') + esc(x.email) + (x.ok ? '' : ' — ' + esc(x.error || '') + ' (copy the link and send it instead)') + '</div>'; }).join('') + '</div>';
        if (!bad.length) toast('success', 'Folder shared.');
      } catch (e) { ov.querySelector('[data-shareres]').innerHTML = '<div class="bea-note bea-err">' + esc(e.message) + ' — copy the link and send it instead.</div>'; }
      btn.disabled = false; btn.textContent = 'Share folder';
    };
  }

  async function open() {
    try { if (!S.scope) S.scope = await api('scope'); } catch (e) { toast('error', e.message); return; }
    if (!S.scopeKey) S.scopeKey = (S.scope.scopes[0] || {}).key || 'self';
    if (!viewOnly() && !S.scope.configured) { paint('<div class="bea-note bea-err"><b>Monthly archive is not set up yet.</b><br>The server key (WORK_ARCHIVE_KEY) is missing.</div>', '<button class="bea-btn ghost" data-close>Close</button>'); S.ov.querySelector('[data-close]').onclick = close; return; }
    S.month = S.month || istMonth();
    if (S.running) return;   // a running archive keeps its own window
    pickStep();
  }

  /** Adds the button to `host` only for people the server allows. */
  async function mount(host) {
    if (!host || host.querySelector('.bea-btn') || S.mounting) return;
    S.mounting = true;
    try { if (!S.scope) S.scope = await api('scope'); } catch (_) { setTimeout(function () { S.mounting = false; }, 30000); return; }
    S.mounting = false;
    if (host.querySelector('.bea-btn')) return;
    css();
    var b = document.createElement('button'); b.type = 'button'; b.className = 'bea-btn';
    b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>' + (viewOnly() ? 'My Monthly Work' : 'Create Monthly Archive');
    b.onclick = open;
    host.appendChild(b);
  }

  window.BEArchive = { mount: mount, open: open };
})();
