/* ════════════════════════════════════════════════════════════════════════════
   WorkProjects — Media Suite → Work Assignment: one shared PROJECT, several INDIVIDUAL
   assignments (migration 20261026_work_projects.sql).

     work_projects          shared title, shared brief, derived status (DB trigger)
     assignments            one row per person (unchanged table — every existing screen, the
                            delivery / approval / rework flow and history keep working)
                              project_id, deliverable   (new)
                              type = classification, description = individual instructions,
                              reference_file = that person's own files (legacy string)
     work_reference_files   assignment_id NULL = shared project file · set = that person's file

   Reference uploads (the old lag): files used to upload only when "Assign" was pressed, one
   after another, with the whole form locked and no per-file feedback; every file pick also
   re-rendered the list with innerHTML += and ran lucide.createIcons() over the whole (very
   large) page. Now each file starts uploading THE MOMENT it is picked, up to 3 in parallel,
   through the existing chunked Drive engine (uploadFileChunked: direct-to-Drive byte PUTs
   with real progress when available, resumable, retried), each with its own progress bar,
   cancel and retry — and the form stays fully editable. Assign waits for running uploads
   (and finishes by itself), and never saves a failed or half-uploaded file.

   Public: WorkProjects.mount() · .ensure(ids) · .project(id) · .chip(t) · .refCell(t, ownHtml)
           .descExtra(t) · .renderPanel() · .syncAssignmentRefs(id, refs)
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.WorkProjects) return;

  var MAX_BYTES = 2 * 1024 * 1024 * 1024;     // 2 GB per reference file
  var PARALLEL = 3;
  var ACCEPT = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.psd,.ai,.eps,.svg,.fig,.xd,.zip,.rar,.7z,.srt,.prproj,.aep';
  var OK_EXT = /\.(pdf|docx?|xlsx?|pptx?|txt|csv|psd|ai|eps|svg|fig|xd|zip|rar|7z|srt|prproj|aep|png|jpe?g|gif|webp|heic|heif|bmp|tiff?|mp4|mov|m4v|avi|mkv|webm|mp3|wav|m4a|aac|ogg|flac)$/i;
  var CLASSES = ['Video Editing', 'Thumbnail', 'Poster Design', 'Graphic Design', 'Social Media', 'Motion Graphics', 'Photography', 'Script / Copywriting'];
  var PRIORITY = [['low', 'Low'], ['medium', 'Medium'], ['very_high', 'Very High']];

  function db() { try { return typeof dbInstance !== 'undefined' ? dbInstance : window.dbInstance; } catch (_) { return window.dbInstance; } }
  // app.html keeps these as script-scoped let/const/function bindings (not window properties).
  var GLOBALS = {
    userRoster: function () { return typeof userRoster !== 'undefined' ? userRoster : []; },
    activeUser: function () { return typeof activeUser !== 'undefined' ? activeUser : ''; },
    activeEmail: function () { return typeof activeEmail !== 'undefined' ? activeEmail : ''; },
    GOOGLE_SCRIPT_URL: function () { return typeof GOOGLE_SCRIPT_URL !== 'undefined' ? GOOGLE_SCRIPT_URL : ''; },
    uploadFileChunked: function () { return typeof uploadFileChunked === 'function' ? uploadFileChunked : null; },
    pushLogEntry: function () { return typeof pushLogEntry === 'function' ? pushLogEntry : null; },
    syncLedgerEngine: function () { return typeof syncLedgerEngine === 'function' ? syncLedgerEngine : null; },
    syncTasksToSheet: function () { return typeof syncTasksToSheet === 'function' ? syncTasksToSheet : null; },
    syncMonthlyReportToSheet: function () { return typeof syncMonthlyReportToSheet === 'function' ? syncMonthlyReportToSheet : null; },
    renderTableRows: function () { return typeof renderTableRows === 'function' ? renderTableRows : null; }
  };
  function G(name) { try { return GLOBALS[name] ? GLOBALS[name]() : window[name]; } catch (_) { return window[name]; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toastMsg(type, m) { if (window.showToast) showToast(type, m); else if (window.toast) toast(type, m); }
  function mb(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  var IC = {
    file: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/></svg>',
    up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    ok: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
  };

  function css() {
    if (document.getElementById('wp-css')) return;
    var s = document.createElement('style'); s.id = 'wp-css';
    s.textContent = [
      '.wp{display:flex;flex-direction:column;gap:16px}',
      '.wp-sec{font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#ff8a3d;margin:0 0 2px;display:flex;align-items:center;gap:8px}.wp-sec em{font-style:normal;color:#6b74a0;letter-spacing:.04em;text-transform:none;font-weight:600}',
      '.wp-box{border:1px solid rgba(255,255,255,.07);border-radius:16px;background:rgba(255,255,255,.02);padding:14px;display:flex;flex-direction:column;gap:12px}',
      '.wp-g{display:grid;gap:10px}.wp-g2{grid-template-columns:repeat(2,minmax(0,1fr))}.wp-g4{grid-template-columns:repeat(4,minmax(0,1fr))}',
      '.wp-f{display:flex;flex-direction:column;gap:5px;min-width:0}.wp-f label{color:#6b74a0;font-size:11px}.wp-f label b{color:#f87171}',
      '.wp-in{width:100%;box-sizing:border-box;background:transparent;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:9px 12px;color:#fff;font:inherit;font-size:12.5px;outline:none;transition:border-color .15s}',
      '.wp-in:focus{border-color:#ff6b06}select.wp-in{background:#0f1220}textarea.wp-in{resize:vertical;min-height:62px;line-height:1.5}',
      '.wp-in.bad{border-color:#f87171}',
      '.wp-drop{display:flex;align-items:center;gap:10px;cursor:pointer;border:1px dashed rgba(255,255,255,.12);border-radius:12px;padding:11px 12px;color:#8b93b8;font-size:12px;transition:border-color .15s,color .15s,background .15s}',
      '.wp-drop:hover,.wp-drop.over{border-color:#ff6b06;color:#fff;background:rgba(255,107,6,.05)}.wp-drop input{display:none}',
      '.wp-files{display:flex;flex-direction:column;gap:6px}',
      '.wp-file{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center;padding:8px 10px;border-radius:11px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.025);font-size:12px}',
      '.wp-file .ic{color:#60a5fa;grid-row:span 2}.wp-file .nm{color:#e6e9f5;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wp-file .st{grid-column:2;display:flex;align-items:center;gap:8px;color:#8b93b8;font-size:11px;min-width:0}',
      '.wp-file .bar{flex:1;height:5px;border-radius:9px;background:rgba(255,255,255,.08);overflow:hidden;min-width:60px}.wp-file .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff6b06,#f9182f);transition:width .25s}',
      '.wp-file .acts{grid-row:span 2;display:flex;gap:4px}.wp-file .acts button{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#c7cbe0;border-radius:8px;height:28px;padding:0 8px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}',
      '.wp-file.done .st{color:#34d399}.wp-file.done .ic{color:#34d399}.wp-file.failed{border-color:rgba(248,113,113,.45)}.wp-file.failed .st{color:#f87171}',
      '.wp-card{border:1px solid rgba(255,255,255,.08);border-left:3px solid rgba(255,107,6,.5);border-radius:16px;background:rgba(255,255,255,.02);overflow:hidden}',
      '.wp-card-h{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;user-select:none}',
      '.wp-card-h .n{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:rgba(255,107,6,.14);color:#ff8a3d;font-weight:800;font-size:12px;flex-shrink:0}',
      '.wp-card-h .t{flex:1;min-width:0}.wp-card-h .t b{display:block;color:#fff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wp-card-h .t span{display:block;color:#8b93b8;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wp-card-h .chev{color:#8b93b8;transition:transform .2s}.wp-card.closed .chev{transform:rotate(-90deg)}',
      '.wp-card-h .rm{border:1px solid rgba(248,113,113,.3);background:rgba(248,113,113,.08);color:#f87171;border-radius:8px;height:28px;padding:0 9px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}',
      '.wp-card-b{padding:0 14px 14px;display:flex;flex-direction:column;gap:10px}.wp-card.closed .wp-card-b{display:none}',
      '.wp-add{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;border:1px dashed rgba(255,107,6,.45);border-radius:14px;background:rgba(255,107,6,.05);color:#ff8a3d;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}',
      '.wp-add:hover{background:rgba(255,107,6,.1)}',
      '.wp-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.wp-foot .sum{font-size:11.5px;color:#8b93b8}.wp-foot .sum b{color:#fff}.wp-foot .warn{color:#fbbf24}',
      '.wp-go{border:0;border-radius:12px;padding:11px 22px;color:#fff;font:inherit;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;background:linear-gradient(135deg,#ff6b06,#f9182f 55%,#ff0552);box-shadow:0 4px 16px rgba(255,45,120,.3)}',
      '.wp-go:disabled{opacity:.75;cursor:progress}',
      '.wp-chip{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;color:#c4b5fd;background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.35);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
      '.wp-refs{display:flex;flex-direction:column;gap:6px}.wp-refs .lbl{font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6b74a0}',
      '.wp-shared a{display:flex;align-items:center;gap:6px;color:#93c5fd;font-size:11.5px;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wp-shared a:hover{color:#fff}',
      '.wpp{display:flex;flex-direction:column;gap:12px}',
      '.wpp-card{border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02);padding:14px 16px}',
      '.wpp-top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start}',
      '.wpp-top h4{margin:0;color:#fff;font-size:15px}.wpp-top p{margin:3px 0 0;color:#8b93b8;font-size:11.5px}',
      '.wpp-prog{display:flex;align-items:center;gap:8px;font-size:11px;color:#8b93b8;min-width:160px}.wpp-prog .bar{flex:1;height:6px;border-radius:9px;background:rgba(255,255,255,.08);overflow:hidden}.wpp-prog .bar i{display:block;height:100%;background:linear-gradient(90deg,#34d399,#10b981)}',
      '.wpp-list{display:flex;flex-direction:column;gap:6px;margin-top:12px}',
      '.wpp-a{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 11px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06)}',
      '.wpp-a .who{flex:1;min-width:180px}.wpp-a .who b{display:block;color:#fff;font-size:12.5px}.wpp-a .who span{color:#8b93b8;font-size:11px}',
      '.wpp-a .acts{display:flex;gap:5px;flex-wrap:wrap}.wpp-a .acts button{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#c7cbe0;font:inherit;font-size:11px;font-weight:700;padding:5px 10px;border-radius:8px;cursor:pointer}',
      '.wpp-a .acts button.pri{border-color:rgba(255,107,6,.4);background:rgba(255,107,6,.12);color:#ff8a3d}.wpp-a .acts button.bad{border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.1);color:#f87171}',
      '.wpp-st{font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;white-space:nowrap}',
      '@media(max-width:900px){.wp-g4{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media(max-width:600px){.wp-g2,.wp-g4{grid-template-columns:1fr}.wp-go{width:100%}.wp-foot{flex-direction:column;align-items:stretch}.wp-file{padding:8px}.wp-file .bar{min-width:40px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Upload manager — starts on pick, parallel, per-file progress / cancel / retry
  // ════════════════════════════════════════════════════════════════════════
  var U = { jobs: [], seq: 0, batchId: '', running: 0, listeners: [] };
  function newBatch() { U.batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2); }
  function folderName() { var t = (document.getElementById('wp-title') || {}).value; return (String(t || '').trim() || 'Work project') + ' - Reference Files'; }
  function validate(f) {
    if (f.size > MAX_BYTES) return 'File too large (max 2 GB): ' + f.name;
    if (!f.size) return 'This file is empty: ' + f.name;
    var okType = /^(image|video|audio)\//.test(f.type) || f.type === 'application/pdf' || OK_EXT.test(f.name);
    return okType ? '' : 'Unsupported file type: ' + f.name;
  }
  function addFiles(files, owner) {
    var added = 0;
    Array.prototype.forEach.call(files, function (f) {
      var err = validate(f);
      if (err) { toastMsg('error', err); return; }
      if (U.jobs.some(function (j) { return j.owner === owner && j.status !== 'cancelled' && j.file.name === f.name && j.file.size === f.size; })) { toastMsg('info', f.name + ' is already attached.'); return; }
      var job = { id: ++U.seq, file: f, owner: owner, status: 'queued', pct: 0, result: null, err: '', ctl: null, state: {} };
      U.jobs.push(job); added++;
      drawJob(job);
    });
    if (added) pump();
  }
  function pump() {
    U.running = U.jobs.filter(function (j) { return j.status === 'uploading'; }).length;
    U.jobs.forEach(function (j) {
      if (U.running >= PARALLEL || j.status !== 'queued') return;
      U.running++; run(j);
    });
    changed();
  }
  async function run(j) {
    var up = G('uploadFileChunked');
    j.status = 'uploading'; j.err = ''; j.ctl = new AbortController(); drawJob(j);
    try {
      if (typeof up !== 'function') throw new Error('Upload service is not available on this page.');
      var r = await up(j.file, U.batchId, folderName(), function (pct) { j.pct = pct; tick(j); }, { signal: j.ctl.signal, state: j.state });
      if (!r || !r.fileUrl) throw new Error('Drive did not return a file link');
      j.result = { name: r.fileName || j.file.name, url: r.fileUrl };
      j.status = 'done'; j.pct = 100;
    } catch (e) {
      if (j.status === 'cancelled' || (e && e.name === 'AbortError')) { j.status = 'cancelled'; }
      else { j.status = 'failed'; j.err = (e && e.message) || 'Upload failed'; }
    }
    drawJob(j); pump();
  }
  function cancelJob(id) { var j = find(id); if (!j) return; if (j.status === 'uploading' && j.ctl) { j.status = 'cancelled'; j.ctl.abort(); } else j.status = 'cancelled'; drawJob(j); pump(); }
  function retryJob(id) { var j = find(id); if (!j || j.status !== 'failed') return; j.status = 'queued'; j.pct = 0; drawJob(j); pump(); }
  function find(id) { return U.jobs.filter(function (j) { return j.id === id; })[0]; }
  function jobsFor(owner) { return U.jobs.filter(function (j) { return j.owner === owner && j.status !== 'cancelled'; }); }
  function busyJobs() { return U.jobs.filter(function (j) { return j.status === 'uploading' || j.status === 'queued'; }); }
  function failedJobs() { return U.jobs.filter(function (j) { return j.status === 'failed'; }); }
  function overallPct() {
    var live = U.jobs.filter(function (j) { return j.status !== 'cancelled'; });
    var tot = live.reduce(function (a, j) { return a + j.file.size; }, 0) || 1;
    return Math.round(live.reduce(function (a, j) { return a + j.file.size * (j.status === 'done' ? 1 : (j.pct || 0) / 100); }, 0) / tot * 100);
  }
  function changed() { U.listeners.forEach(function (f) { try { f(); } catch (_) {} }); }
  // DOM: one row per file, created once and patched in place (no list re-render, no global icon scan)
  function drawJob(j) {
    var list = document.querySelector('[data-wp-files="' + j.owner + '"]'); if (!list) return;
    var el = list.querySelector('[data-job="' + j.id + '"]');
    if (j.status === 'cancelled') { if (el) el.remove(); changed(); return; }
    if (!el) {
      el = document.createElement('div'); el.className = 'wp-file'; el.setAttribute('data-job', j.id);
      el.innerHTML = '<span class="ic">' + IC.file + '</span><span class="nm"></span><span class="acts"></span><span class="st"></span>';
      list.appendChild(el);
      el.querySelector('.nm').textContent = j.file.name;
    }
    el.className = 'wp-file ' + j.status;
    var st = el.querySelector('.st'), acts = el.querySelector('.acts');
    if (j.status === 'done') { st.innerHTML = '<span>' + esc(mb(j.file.size)) + '</span> ' + IC.ok + ' <span>Uploaded</span>'; acts.innerHTML = '<button type="button" data-wp-rm="' + j.id + '" title="Remove">' + IC.x + '</button>'; }
    else if (j.status === 'failed') { st.innerHTML = '<span>Upload failed — ' + esc(j.err).slice(0, 120) + '</span>'; acts.innerHTML = '<button type="button" data-wp-retry="' + j.id + '">Retry</button><button type="button" data-wp-rm="' + j.id + '" title="Remove">' + IC.x + '</button>'; }
    else {
      st.innerHTML = '<span>' + esc(mb(j.file.size)) + '</span><span class="lbl">' + (j.status === 'queued' ? 'Waiting…' : 'Uploading… ' + (j.pct || 0) + '%') + '</span><span class="bar"><i style="width:' + (j.pct || 0) + '%"></i></span>';
      acts.innerHTML = '<button type="button" data-wp-cancel="' + j.id + '">Cancel</button>';
    }
    changed();
  }
  function tick(j) {
    var el = document.querySelector('[data-job="' + j.id + '"]'); if (!el) return;
    var b = el.querySelector('.bar i'), l = el.querySelector('.lbl');
    if (b) b.style.width = j.pct + '%'; if (l) l.textContent = 'Uploading… ' + j.pct + '%';
    changed();
  }
  function refsOf(owner) { return U.jobs.filter(function (j) { return j.owner === owner && j.status === 'done'; }).map(function (j) { return { name: j.result.name, url: j.result.url, size: j.file.size, type: j.file.type }; }); }

  // ════════════════════════════════════════════════════════════════════════
  // Create & Assign Work Project form
  // ════════════════════════════════════════════════════════════════════════
  var F = { cards: [], seq: 0, waiting: false, saving: false, mounted: false };
  function empOptions(sel) {
    var src = document.getElementById('task-assigned-employee');
    var html = src ? src.innerHTML : '<option value="">-- Select Employee --</option>';
    return sel ? html.replace('value="' + esc(sel) + '"', 'value="' + esc(sel) + '" selected') : html;
  }
  function classOptions(sel) {
    var src = document.getElementById('task-type'), list = CLASSES.slice();
    if (src) Array.prototype.forEach.call(src.options, function (o) { if (list.indexOf(o.value) < 0) list.push(o.value); });
    return '<option value="">Select classification…</option>' + list.map(function (c) { return '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '<option value="__other">Other…</option>';
  }
  function dropzone(owner, label) {
    return '<label class="wp-drop" data-wp-drop="' + owner + '">' + IC.up + '<span>' + label + '</span><input type="file" multiple accept="' + ACCEPT + '" data-wp-input="' + owner + '"></label><div class="wp-files" data-wp-files="' + owner + '"></div>';
  }
  function cardHTML(c, n) {
    return '<div class="wp-card" data-card="' + c.key + '">'
      + '<div class="wp-card-h" data-wp-toggle="' + c.key + '"><span class="n">' + n + '</span><span class="t"><b data-wp-ct>' + 'Assignment ' + n + '</b><span data-wp-cs>Pick the employee and the deliverable</span></span>'
      + (n > 1 ? '<button type="button" class="rm" data-wp-del="' + c.key + '">Remove</button>' : '') + '<span class="chev">' + IC.chev + '</span></div>'
      + '<div class="wp-card-b">'
      + '<div class="wp-g wp-g2">'
      + '<div class="wp-f"><label>Employee <b>*</b></label><select class="wp-in" data-k="emp">' + empOptions() + '</select></div>'
      + '<div class="wp-f"><label>Classification <b>*</b></label><select class="wp-in" data-k="cls">' + classOptions() + '</select><input class="wp-in" data-k="clsOther" placeholder="Type the classification" style="display:none"></div>'
      + '</div>'
      + '<div class="wp-f"><label>Specific deliverable <b>*</b></label><input class="wp-in" data-k="del" placeholder="e.g. Edit the final Reel video · Create poster + thumbnail"></div>'
      + '<div class="wp-f"><label>Instructions for this person</label><textarea class="wp-in" data-k="ins" rows="2" placeholder="Specific notes for this deliverable — aspect ratio, length, fonts, music…"></textarea></div>'
      + '<div class="wp-g wp-g2">'
      + '<div class="wp-f"><label>Priority</label><select class="wp-in" data-k="pri">' + PRIORITY.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === 'medium' ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></div>'
      + '<div class="wp-f"><label>Deadline <b>*</b></label><input type="date" class="wp-in" data-k="due" min="' + today() + '"></div>'
      + '</div>'
      + '<div class="wp-f"><label>Reference files for this person <span style="color:#4a5182">— only they see these</span></label>' + dropzone(c.key, 'Attach files for this assignment (uploads start right away)') + '</div>'
      + '</div></div>';
  }
  function formHTML() {
    return '<div class="wp" id="wp-form">'
      + '<div class="wp-box"><p class="wp-sec">Shared project <em>— everyone on this project sees this</em></p>'
      + '<div class="wp-f"><label>Project / campaign title <b>*</b></label><input id="wp-title" class="wp-in" placeholder="Vocabulary Reels Day 5"></div>'
      + '<div class="wp-f"><label>Shared brief</label><textarea id="wp-brief" class="wp-in" rows="3" placeholder="Campaign-level instructions shared with every assignee…"></textarea></div>'
      + '<div class="wp-f"><label>Shared reference files <span style="color:#4a5182">— script, brand guide, source images</span></label>' + dropzone('shared', 'Attach shared files (uploads start right away)') + '</div>'
      + '</div>'
      + '<div style="display:flex;flex-direction:column;gap:10px"><p class="wp-sec">Assignments <em>— one per person, each with its own deliverable</em></p><div id="wp-cards" style="display:flex;flex-direction:column;gap:10px"></div>'
      + '<button type="button" class="wp-add" id="wp-add">' + IC.plus + ' Add another assignee</button></div>'
      + '<div class="wp-foot"><span class="sum" id="wp-sum"></span><button type="button" class="wp-go" id="wp-go">Assign Work Project</button></div>'
      + '</div>';
  }
  function addCard() {
    var c = { key: 'a' + (++F.seq) };
    F.cards.push(c);
    var box = document.getElementById('wp-cards');
    box.insertAdjacentHTML('beforeend', cardHTML(c, F.cards.length));
    // collapse earlier filled cards on desktop to keep the form short
    F.cards.slice(0, -1).forEach(function (o) { var el = cardEl(o.key); if (el && readCard(o).emp) el.classList.add('closed'); });
    renumber(); summary();
    var s = cardEl(c.key).querySelector('[data-k="emp"]'); if (s) s.focus();
  }
  function cardEl(key) { return document.querySelector('.wp-card[data-card="' + key + '"]'); }
  function readCard(c) {
    var el = cardEl(c.key); if (!el) return {};
    var v = function (k) { var x = el.querySelector('[data-k="' + k + '"]'); return x ? String(x.value || '').trim() : ''; };
    var cls = v('cls'); if (cls === '__other') cls = v('clsOther');
    return { emp: v('emp'), cls: cls, del: v('del'), ins: v('ins'), pri: v('pri') || 'medium', due: v('due') };
  }
  function renumber() {
    F.cards.forEach(function (c, i) {
      var el = cardEl(c.key); if (!el) return;
      el.querySelector('.n').textContent = i + 1;
      var d = readCard(c);
      el.querySelector('[data-wp-ct]').textContent = d.emp ? d.emp.replace(/\s*\(.*\)$/, '') + (d.cls ? ' · ' + d.cls : '') : 'Assignment ' + (i + 1);
      el.querySelector('[data-wp-cs]').textContent = d.del || 'Pick the employee and the deliverable';
    });
  }
  function summary() {
    var s = document.getElementById('wp-sum'); if (!s) return;
    var busy = busyJobs().length, failed = failedJobs().length, files = U.jobs.filter(function (j) { return j.status === 'done'; }).length;
    var txt = '<b>' + F.cards.length + '</b> assignment' + (F.cards.length === 1 ? '' : 's') + ' · <b>' + files + '</b> file' + (files === 1 ? '' : 's') + ' uploaded';
    if (busy) txt += ' · <span class="warn">' + busy + ' uploading (' + overallPct() + '%)</span>';
    if (failed) txt += ' · <span style="color:#f87171">' + failed + ' failed — retry or remove</span>';
    s.innerHTML = txt;
    var go = document.getElementById('wp-go');
    if (go && F.waiting) go.textContent = busy ? 'Reference files are still uploading… ' + overallPct() + '%' : 'Assigning…';
  }
  function resetForm() {
    F.cards = []; F.seq = 0; F.waiting = false; F.saving = false;
    U.jobs.filter(function (j) { return j.status === 'uploading'; }).forEach(function (j) { j.status = 'cancelled'; try { j.ctl.abort(); } catch (_) {} });
    U.jobs = []; newBatch();
    var host = document.getElementById('wp-host'); if (!host) return;
    host.innerHTML = formHTML(); wire(host); addCard();
  }
  function wire(host) {
    host.addEventListener('change', function (e) {
      var inp = e.target.closest('[data-wp-input]');
      if (inp) { addFiles(inp.files, inp.getAttribute('data-wp-input')); inp.value = ''; return; }
      var cls = e.target.closest('[data-k="cls"]');
      if (cls) { var o = cls.parentNode.querySelector('[data-k="clsOther"]'); if (o) { o.style.display = cls.value === '__other' ? '' : 'none'; if (cls.value === '__other') o.focus(); } }
      e.target.classList && e.target.classList.remove('bad');
      renumber();
    });
    host.addEventListener('input', function (e) { if (e.target.classList) e.target.classList.remove('bad'); if (e.target.closest('.wp-card')) renumber(); });
    host.addEventListener('click', function (e) {
      var b;
      if ((b = e.target.closest('[data-wp-cancel]'))) return cancelJob(+b.getAttribute('data-wp-cancel'));
      if ((b = e.target.closest('[data-wp-retry]'))) return retryJob(+b.getAttribute('data-wp-retry'));
      if ((b = e.target.closest('[data-wp-rm]'))) return cancelJob(+b.getAttribute('data-wp-rm'));
      if ((b = e.target.closest('[data-wp-del]'))) {
        e.stopPropagation();
        var key = b.getAttribute('data-wp-del');
        jobsFor(key).forEach(function (j) { cancelJob(j.id); });
        F.cards = F.cards.filter(function (c) { return c.key !== key; });
        var el = cardEl(key); if (el) el.remove();
        renumber(); summary(); return;
      }
      if ((b = e.target.closest('[data-wp-toggle]')) && !e.target.closest('button')) { var c = cardEl(b.getAttribute('data-wp-toggle')); if (c) c.classList.toggle('closed'); return; }
      if (e.target.closest('#wp-add')) return addCard();
      if (e.target.closest('#wp-go')) return submit();
    });
    // drag & drop onto any dropzone
    host.addEventListener('dragover', function (e) { var d = e.target.closest('[data-wp-drop]'); if (d) { e.preventDefault(); d.classList.add('over'); } });
    host.addEventListener('dragleave', function (e) { var d = e.target.closest('[data-wp-drop]'); if (d) d.classList.remove('over'); });
    host.addEventListener('drop', function (e) { var d = e.target.closest('[data-wp-drop]'); if (!d) return; e.preventDefault(); d.classList.remove('over'); if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files, d.getAttribute('data-wp-drop')); });
  }
  U.listeners.push(function () { summary(); if (F.waiting && !busyJobs().length) { F.waiting = false; submit(); } });

  function validateForm() {
    var title = document.getElementById('wp-title'), bad = [], first = null;
    var mark = function (el) { if (el) { el.classList.add('bad'); first = first || el; } };
    if (!String(title.value || '').trim()) { mark(title); bad.push('project title'); }
    if (!F.cards.length) bad.push('at least one assignment');
    F.cards.forEach(function (c, i) {
      var d = readCard(c), el = cardEl(c.key), miss = [];
      if (!d.emp) { mark(el.querySelector('[data-k="emp"]')); miss.push('employee'); }
      if (!d.cls) { mark(el.querySelector('[data-k="cls"]')); miss.push('classification'); }
      if (!d.del) { mark(el.querySelector('[data-k="del"]')); miss.push('deliverable'); }
      if (!d.due) { mark(el.querySelector('[data-k="due"]')); miss.push('deadline'); }
      if (miss.length) { el.classList.remove('closed'); bad.push('assignment ' + (i + 1) + ': ' + miss.join(', ')); }
    });
    var dupe = {}; F.cards.forEach(function (c) { var d = readCard(c); var k = d.emp + '|' + d.cls; if (d.emp && dupe[k]) bad.push(d.emp.replace(/\s*\(.*\)$/, '') + ' has the same classification twice'); dupe[k] = 1; });
    if (bad.length) { toastMsg('error', 'Please complete: ' + bad.join(' · ')); if (first) first.focus(); return false; }
    return true;
  }

  async function submit() {
    if (F.saving) return;
    if (!validateForm()) return;
    var go = document.getElementById('wp-go');
    if (failedJobs().length) { toastMsg('error', 'Some reference files failed to upload. Retry or remove them before assigning.'); return; }
    if (busyJobs().length) {
      // Never save half-uploaded files: wait, then finish automatically.
      F.waiting = true; go.disabled = true; summary();
      toastMsg('info', 'Reference files are still uploading. The project will be assigned as soon as they finish.');
      return;
    }
    F.saving = true; go.disabled = true; go.textContent = 'Assigning…';
    try { await save(); }
    catch (e) { toastMsg('error', 'Could not assign the work project. ' + ((e && e.message) || '')); }
    finally { F.saving = false; var g = document.getElementById('wp-go'); if (g) { g.disabled = false; g.textContent = 'Assign Work Project'; } }
  }

  function refString(refs, folderUrl) {
    var parts = []; if (folderUrl) parts.push('__folder__|' + folderUrl);
    refs.forEach(function (r) { if (r.url) parts.push(String(r.name).replace(/[|;]/g, ' ') + '|' + r.url); });
    return parts.join(';;');
  }
  async function save() {
    var d = db(), roster = G('userRoster') || [], me = G('activeUser') || '', meEmail = String(G('activeEmail') || '').toLowerCase();
    var title = document.getElementById('wp-title').value.trim(), brief = document.getElementById('wp-brief').value.trim();
    var shared = refsOf('shared');
    var cards = F.cards.map(function (c) {
      var x = readCard(c), name = x.emp, emp = roster.filter(function (u) { return u.name === name; })[0];
      return Object.assign(x, { key: c.key, name: name, email: emp ? String(emp.email || '').toLowerCase() : '', social: !!(emp && emp.role === 'social_media'), refs: refsOf(c.key) });
    });
    // 1 — parent project (falls back to plain assignments if the 20261026 SQL is not run yet)
    var projectId = null, grouped = true;
    var pr = await d.from('work_projects').insert([{ title: title, shared_description: brief || null, created_by: me, created_by_email: meEmail || null, kind: 'multi_deliverable' }]).select('id').single();
    if (pr.error) {
      if (/work_projects|relation|schema cache/i.test(pr.error.message || '')) grouped = false;
      else throw pr.error;
    } else projectId = pr.data.id;
    // 2 — one assignments row per person
    var base = Date.now(), rows = cards.map(function (c, i) {
      var own = grouped ? c.refs : c.refs.concat(shared);
      var desc = grouped ? (c.ins || c.del) : [brief, c.del ? 'Your deliverable: ' + c.del : '', c.ins].filter(Boolean).join('\n\n');
      var r = { id: base + i, topic: title, type: c.cls, assigned_to: c.name, employee_email: c.email, description: desc,
        assigned_date: today(), date: c.due, status: 'Pending', explanation: 'None', asset_link: '', reference_file: refString(own),
        assigned_by: me, priority: c.pri, assign_approved: !c.social };
      if (grouped) { r.project_id = projectId; r.deliverable = c.del; }
      return r;
    });
    var ins = await d.from('assignments').insert(rows).select('id');
    if (ins.error) {
      if (projectId) try { await d.from('work_projects').delete().eq('id', projectId); } catch (_) {}
      throw ins.error;
    }
    // 3 — reference registry (shared = assignment_id NULL)
    if (grouped) {
      var refRows = shared.map(function (r) { return { project_id: projectId, assignment_id: null, file_name: r.name, file_url: r.url, file_size: r.size, mime_type: r.type || null, uploaded_by: me }; });
      cards.forEach(function (c, i) { c.refs.forEach(function (r) { refRows.push({ project_id: projectId, assignment_id: rows[i].id, file_name: r.name, file_url: r.url, file_size: r.size, mime_type: r.type || null, uploaded_by: me }); }); });
      if (refRows.length) { var rr = await d.from('work_reference_files').insert(refRows); if (rr.error) console.warn('[WorkProjects] reference registry:', rr.error.message); }
    }
    // 4 — Drive folder link: background only, never blocks the assignment
    var batch = U.batchId, gurl = G('GOOGLE_SCRIPT_URL');
    if (U.jobs.some(function (j) { return j.status === 'done'; }) && gurl) {
      fetch(gurl, { method: 'POST', body: JSON.stringify({ action: 'finalizeFolder', folderBatchId: batch }) }).then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.success && j.folderUrl && projectId) d.from('work_projects').update({ folder_url: j.folderUrl }).eq('id', projectId).then(function () {}); }).catch(function () {});
    }
    var push = G('pushLogEntry'); if (typeof push === 'function') push('Assigned work project "' + title + '" → ' + cards.map(function (c) { return c.name + ' (' + c.cls + ')'; }).join(', ')).catch(function () {});
    toastMsg('success', grouped ? ('"' + title + '" assigned to ' + cards.length + (cards.length === 1 ? ' person.' : ' people.')) : ('Assigned. Run 20261026_work_projects.sql to group these assignments under one project.'));
    resetForm();
    var sync = G('syncLedgerEngine'); if (typeof sync === 'function') await sync(false);
    ['syncTasksToSheet', 'syncMonthlyReportToSheet'].forEach(function (n) { var f = G(n); if (typeof f === 'function') try { f(); } catch (_) {} });
    try { if (typeof window.mhAssignedWorkLiveRefresh === 'function') window.mhAssignedWorkLiveRefresh(); } catch (_) {}
    try { if (typeof window._beRenderKanbanIfActive === 'function') window._beRenderKanbanIfActive(); } catch (_) {}
    if (projectId) { P.loaded[projectId] = false; await ensure([projectId], true); renderPanel(); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Project data for every view (cache; shared files only — own files stay on the row)
  // ════════════════════════════════════════════════════════════════════════
  var P = { byId: {}, shared: {}, loaded: {}, ok: true, pending: null };
  async function ensure(ids, force) {
    ids = (ids || []).filter(function (id) { return id && (force || !P.loaded[id]); });
    ids = ids.filter(function (v, i) { return ids.indexOf(v) === i; });
    if (!ids.length || !P.ok) return false;
    ids.forEach(function (id) { P.loaded[id] = true; });
    var d = db();
    var r = await Promise.all([
      d.from('work_projects').select('*').in('id', ids),
      d.from('work_reference_files').select('*').in('project_id', ids).is('assignment_id', null).is('removed_at', null).order('created_at')
    ]);
    if (r[0].error) { P.ok = !/work_projects|relation|schema cache/i.test(r[0].error.message || ''); return false; }
    (r[0].data || []).forEach(function (p) { P.byId[p.id] = p; P.shared[p.id] = []; });
    (r[1].data || []).forEach(function (f) { (P.shared[f.project_id] = P.shared[f.project_id] || []).push(f); });
    return true;
  }
  // Called by the pipeline renderer: load any missing projects, then re-render once.
  function queue(ids) {
    var miss = (ids || []).filter(function (id) { return id && !P.loaded[id]; });
    if (!miss.length || P.pending) return;
    P.pending = ensure(miss).then(function (gotNew) {
      P.pending = null;
      if (!gotNew) return;
      var r = G('renderTableRows'); if (typeof r === 'function') try { r(); } catch (_) {}
      try { if (typeof window._beRenderKanbanIfActive === 'function') window._beRenderKanbanIfActive(); } catch (_) {}
    });
  }
  function project(id) { return id ? P.byId[id] || null : null; }
  var STATUS = { not_started: ['Not started', '#94a3b8'], in_progress: ['In progress', '#60a5fa'], partially_completed: ['Partially completed', '#fbbf24'], completed: ['Completed', '#34d399'], cancelled: ['Cancelled', '#f87171'] };
  function chip(t) {
    var pid = t && (t.projectId || t.project_id); if (!pid) return '';
    var p = project(pid); queue([pid]);
    return '<span class="wp-chip" title="Part of a multi-person work project">◆ Project' + (p ? ' · ' + esc(STATUS[p.status] ? STATUS[p.status][0] : p.status) : '') + '</span>';
  }
  function sharedList(pid) {
    var files = P.shared[pid] || [], p = project(pid);
    if (!files.length && !(p && p.folder_url)) return '';
    return '<div class="wp-shared">' + files.map(function (f) { return '<a href="' + esc(f.file_url) + '" target="_blank" rel="noopener">' + IC.file + '<span>' + esc(f.file_name) + '</span></a>'; }).join('') + '</div>';
  }
  // Reference column: "My assignment files" + "Shared project files" — never one mixed list.
  function refCell(t, ownHtml) {
    var pid = t && (t.projectId || t.project_id); if (!pid) return ownHtml;
    css(); queue([pid]);
    var shared = sharedList(pid);
    return '<div class="wp-refs">' + (t.referenceFile || t.reference_file ? '<div><div class="lbl">My assignment files</div>' + ownHtml + '</div>' : '')
      + (shared ? '<div><div class="lbl">Shared project files</div>' + shared + '</div>' : '') + ((!shared && !(t.referenceFile || t.reference_file)) ? ownHtml : '') + '</div>';
  }
  // Description: your deliverable + your instructions, then the shared brief.
  function descExtra(t) {
    var pid = t && (t.projectId || t.project_id); if (!pid) return null;
    var p = project(pid);
    return { deliverable: t.deliverable || '', brief: p ? (p.shared_description || '') : '', title: p ? p.title : (t.topic || '') };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Grouped project view (Media Head / Manager) — Work Assignment tab
  // ════════════════════════════════════════════════════════════════════════
  var V = { rows: [], open: {} };
  function aState(a) {
    if (a.status === 'cancelled') return ['Cancelled', '#f87171'];
    if (a.status === 'Completed' && a.manager_approved) return ['Approved', '#34d399'];
    if (a.status === 'Completed') return ['Completed · awaiting review', '#a3e635'];
    if (a.status === 'Rework Required') return ['Rework', '#c084fc'];
    if (a.status === 'Rejected') return ['Rejected', '#f87171'];
    if (a.status === 'In Progress') return ['In progress', '#60a5fa'];
    return ['Pending', '#fbbf24'];
  }
  function canManage() {
    var r = window._systemRole || '';
    var role = (function () { try { return typeof activeRole !== 'undefined' ? activeRole : ''; } catch (_) { return ''; } })();
    return r === 'media_head' || ['manager', 'founder', 'co_founder', 'managing_director', 'director'].indexOf(r) > -1 || role === 'admin';
  }
  async function renderPanel() {
    var host = document.getElementById('wp-projects'); if (!host) return;
    if (!canManage()) { host.innerHTML = ''; return; }
    var d = db(); if (!d) return;
    var r = await d.from('work_projects').select('*').neq('status', 'cancelled').order('created_at', { ascending: false }).limit(30);
    if (r.error) { host.innerHTML = /work_projects|relation|schema cache/i.test(r.error.message || '') ? '' : ''; return; }
    var projects = r.data || [];
    if (!projects.length) { host.innerHTML = ''; return; }
    var ids = projects.map(function (p) { return p.id; });
    var a = await d.from('assignments').select('id,topic,type,deliverable,assigned_to,employee_email,status,manager_approved,date,priority,asset_link,project_id,completed_at,submitted_at').in('project_id', ids).order('id');
    projects.forEach(function (p) { P.byId[p.id] = p; P.loaded[p.id] = P.loaded[p.id] || false; });
    await ensure(ids, true);
    var byP = {}; (a.data || []).forEach(function (x) { (byP[x.project_id] = byP[x.project_id] || []).push(x); });
    V.rows = a.data || [];
    // Only multi-person projects need grouping here; single ones already read fine in Assigned Work.
    var multi = projects.filter(function (p) { return (byP[p.id] || []).length > 1; });
    if (!multi.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="wpp"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"><h3 class="text-base md:text-lg font-bold text-white" style="margin:0">Work projects</h3><span style="font-size:11px;color:#6b74a0">Multi-person projects — each assignment tracked separately</span></div>'
      + multi.map(function (p) {
        var list = byP[p.id] || [], live = list.filter(function (x) { return x.status !== 'cancelled'; }), done = live.filter(function (x) { return x.status === 'Completed'; }).length;
        var st = STATUS[p.status] || [p.status, '#94a3b8'], pct = live.length ? Math.round(done / live.length * 100) : 0;
        return '<div class="wpp-card"><div class="wpp-top"><div style="min-width:0;flex:1"><h4>' + esc(p.title) + '</h4><p>' + list.length + ' assignments · by ' + esc(p.created_by || '—') + (p.shared_description ? ' · ' + esc(String(p.shared_description).slice(0, 90)) + (p.shared_description.length > 90 ? '…' : '') : '') + '</p></div>'
          + '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="wpp-st" style="color:' + st[1] + ';background:' + st[1] + '22;border:1px solid ' + st[1] + '55">' + esc(st[0]) + '</span><div class="wpp-prog"><span>' + done + ' of ' + live.length + ' done</span><span class="bar"><i style="width:' + pct + '%"></i></span></div></div></div>'
          + ((P.shared[p.id] || []).length ? '<div style="margin-top:10px"><div style="font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6b74a0;margin-bottom:4px">Shared project files</div>' + sharedList(p.id) + '</div>' : '')
          + '<div class="wpp-list">' + list.map(function (x) {
            var s = aState(x), open = x.status !== 'cancelled' && x.status !== 'Completed' && x.status !== 'Rejected', hasOut = String(x.asset_link || '').trim() !== '';
            return '<div class="wpp-a"><span class="wpp-st" style="color:' + s[1] + ';background:' + s[1] + '1f;border:1px solid ' + s[1] + '55">' + esc(s[0]) + '</span>'
              + '<div class="who"><b>' + esc(x.type || 'Work') + ' — ' + esc(x.assigned_to || '—') + '</b><span>' + esc(x.deliverable || '') + (x.date ? ' · due ' + esc(String(x.date).slice(0, 10)) : '') + '</span></div>'
              + '<div class="acts">' + (open ? '<button type="button" data-wpp="view" data-id="' + x.id + '">View</button>' : '')
              + (open ? '<button type="button" class="pri" data-wpp="edit" data-id="' + x.id + '">Edit / Reassign</button>' : '')
              + (hasOut ? '<button type="button" data-wpp="out" data-id="' + x.id + '">Review output</button>' : '')
              + (open ? '<button type="button" class="bad" data-wpp="cancel" data-id="' + x.id + '">Cancel</button>' : '') + '</div></div>';
          }).join('') + '</div></div>';
      }).join('') + '</div>';
  }
  function panelClick(e) {
    var b = e.target.closest('[data-wpp]'); if (!b) return;
    var id = +b.getAttribute('data-id'), act = b.getAttribute('data-wpp');
    var agwFind = function () { return (window._agwRowById || {})[id]; };
    if (act === 'out' && typeof window.mhViewDelivery === 'function') return window.mhViewDelivery(id);
    // Reuse the existing per-assignment screens (View / Edit / Cancel) — no duplicate work screen.
    var go = function () {
      if (act === 'view' && window.agwView) return window.agwView(id);
      if (act === 'edit' && window.agwEdit) return window.agwEdit(id);
      if (act === 'cancel' && window.agwCancel) return window.agwCancel(id, false);
    };
    if (agwFind() || !window.mhRenderAssignedWork) return go();
    window.mhRenderAssignedWork().then(go);
  }

  // When the existing edit form saves an assignment's references, keep the registry in step.
  async function syncAssignmentRefs(id, refs) {
    var d = db(); if (!d || !id) return;
    var row = (await d.from('assignments').select('project_id').eq('id', id).maybeSingle()).data;
    if (!row || !row.project_id) return;
    var cur = (await d.from('work_reference_files').select('id,file_url').eq('assignment_id', id).is('removed_at', null)).data || [];
    var keep = refs.filter(function (r) { return !r.folder; }).map(function (r) { return r.url; });
    var gone = cur.filter(function (c) { return keep.indexOf(c.file_url) < 0; }).map(function (c) { return c.id; });
    var have = cur.map(function (c) { return c.file_url; });
    var add = refs.filter(function (r) { return !r.folder && have.indexOf(r.url) < 0; });
    if (gone.length) await d.from('work_reference_files').update({ removed_at: new Date().toISOString(), removed_by: G('activeUser') || null }).in('id', gone);
    if (add.length) await d.from('work_reference_files').insert(add.map(function (r) { return { project_id: row.project_id, assignment_id: id, file_name: r.name, file_url: r.url, uploaded_by: G('activeUser') || null }; }));
  }

  // ════════════════════════════════════════════════════════════════════════
  function mount() {
    css();
    var panel = document.getElementById('admin-assignment-panel'); if (!panel || document.getElementById('wp-host')) return;
    // The original single form stays (it is the EDIT form for one assignment); the new
    // multi-assignee form is the CREATE form.
    var single = document.createElement('div'); single.id = 'wa-single-form'; single.className = 'space-y-5 hidden';
    var kids = Array.prototype.slice.call(panel.children, 1);
    kids.forEach(function (k) { single.appendChild(k); });
    panel.appendChild(single);
    var host = document.createElement('div'); host.id = 'wp-host';
    panel.appendChild(host);
    var t = document.getElementById('wa-form-title'); if (t) t.textContent = 'Create & Assign Work Project';
    newBatch(); resetForm();
    // Grouped project list above "Assigned Work" in the Work Assignment tab.
    var mountPt = document.getElementById('wa-panel-mount');
    if (mountPt && !document.getElementById('wp-projects')) {
      var pv = document.createElement('div'); pv.id = 'wp-projects'; pv.style.marginTop = '22px';
      mountPt.parentNode.insertBefore(pv, mountPt.nextSibling);
      pv.addEventListener('click', panelClick);
    }
    // Refresh the grouped view whenever the Assigned Work list loads / refreshes.
    ['mhRenderAssignedWork', 'mhAssignedWorkLiveRefresh'].forEach(function (n) {
      var f = window[n]; if (typeof f !== 'function' || f._wp) return;
      var w = async function () { var r = await f.apply(this, arguments); renderPanel(); return r; }; w._wp = true; window[n] = w;
    });
    if (window.BELive) BELive.on('work-projects', ['work_projects', 'work_reference_files'], function () { Object.keys(P.loaded).forEach(function (k) { P.loaded[k] = false; }); renderPanel(); queue(Object.keys(P.byId)); }, { debounce: 800 });
    F.mounted = true;
  }
  /** Edit mode of the old form on/off (called from app.html _waSetEditUI). */
  function editMode(on) {
    var s = document.getElementById('wa-single-form'), h = document.getElementById('wp-host');
    if (s) s.classList.toggle('hidden', !on); if (h) h.classList.toggle('hidden', !!on);
    var t = document.getElementById('wa-form-title'); if (t && !on) t.textContent = 'Create & Assign Work Project';
  }
  /** Refresh employee options after the roster loads. */
  function refreshEmployees() {
    F.cards.forEach(function (c) { var el = cardEl(c.key); if (!el) return; var s = el.querySelector('[data-k="emp"]'); if (!s) return; var v = s.value; s.innerHTML = empOptions(); s.value = v; });
  }

  window.WorkProjects = { mount: mount, ensure: ensure, project: project, chip: chip, refCell: refCell, descExtra: descExtra, renderPanel: renderPanel,
    syncAssignmentRefs: syncAssignmentRefs, editMode: editMode, refreshEmployees: refreshEmployees, queue: queue,
    _jobs: function () { return U.jobs; }, _addFiles: addFiles };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(mount, 0); }); else setTimeout(mount, 0);
})();
