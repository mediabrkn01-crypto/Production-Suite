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
    // Minimal surface: typography + whitespace + hairlines. Accent (#ff6b06 → #f9182f) only on
    // the primary action, focus and active states.
    s.textContent = [
      '#admin-assignment-panel.wp-on{border-left:1px solid rgba(var(--ink, 255,255,255), 0.06)!important;padding:22px 24px!important}',
      '#admin-assignment-panel.wp-on>h3{font-size:10.5px!important;letter-spacing:.16em;color:var(--tx-6, #6b74a0)!important;margin-bottom:-6px}',
      '#admin-assignment-panel.wp-on>h3 i,#admin-assignment-panel.wp-on>h3 svg{display:none}',
      '.wp{display:flex;flex-direction:column;gap:22px;color:var(--tx-1, #e6e9f5)}',
      '.wp-lbl{font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--tx-6, #6b74a0)}',
      '.wp-hint{font-size:11px;color:var(--tx-7, #4f5785);font-weight:500;letter-spacing:0;text-transform:none}',
      /* project header */
      '.wp-proj{display:flex;flex-direction:column;gap:10px}',
      '.wp-title{width:100%;background:transparent;border:0;border-bottom:1px solid rgba(var(--ink, 255,255,255), 0.08);padding:4px 0 10px;color:var(--tx-0, #fff);font:inherit;font-size:22px;font-weight:700;letter-spacing:-.01em;outline:none;transition:border-color .15s}',
      '.wp-title::placeholder{color:var(--tx-7, #3d4470)}.wp-title:focus{border-bottom-color:#ff6b06}',
      '.wp-auto{width:100%;box-sizing:border-box;background:rgba(var(--ink, 255,255,255), 0.025);border:1px solid transparent;border-radius:10px;padding:9px 12px;color:var(--tx-1, #dfe3f3);font:inherit;font-size:13px;line-height:1.5;resize:none;outline:none;overflow:hidden;min-height:38px;transition:border-color .15s,background .15s}',
      '.wp-auto::placeholder{color:var(--tx-7, #4f5785)}.wp-auto:focus{background:rgba(var(--ink, 255,255,255), 0.04);border-color:rgba(255,107,6,.45)}',
      /* compact inputs */
      '.wp-in{width:100%;box-sizing:border-box;height:36px;background:rgba(var(--ink, 255,255,255), 0.03);border:1px solid rgba(var(--ink, 255,255,255), 0.06);border-radius:9px;padding:0 11px;color:var(--tx-0, #fff);font:inherit;font-size:12.5px;outline:none;transition:border-color .15s}',
      '.wp-in::placeholder{color:var(--tx-7, #4f5785)}.wp-in:focus{border-color:rgba(255,107,6,.55)}select.wp-in{background:var(--sf-2, #10131f);padding-right:6px}',
      '.wp-in[type=date]{color-scheme:var(--scheme, dark)}.bad{border-color:#f87171!important;box-shadow:0 0 0 1px rgba(248,113,113,.25)}',
      '.wp-del-in{font-size:13.5px;font-weight:600;height:38px}',
      /* files */
      '.wp-files-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.wp-addf{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid rgba(var(--ink, 255,255,255), 0.08);background:transparent;color:var(--tx-3, #a5adcf);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '.wp-addf:hover{color:var(--tx-0, #fff);border-color:rgba(var(--ink, 255,255,255), 0.18)}.wp-addf input{display:none}',
      '.wp-files{display:flex;flex-direction:column;gap:2px;width:100%}.wp-files:empty{display:none}',
      '.wp-file{display:flex;align-items:center;gap:10px;min-height:30px;padding:2px 4px 2px 2px;border-radius:7px;font-size:12px}',
      '.wp-file:hover{background:rgba(var(--ink, 255,255,255), 0.025)}',
      '.wp-file .ic{color:var(--tx-6, #6b74a0);display:flex;flex-shrink:0}.wp-file .nm{flex:1;min-width:0;color:var(--tx-1, #dfe3f3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wp-file .st{display:flex;align-items:center;gap:8px;color:var(--tx-6, #6b74a0);font-size:11px;flex-shrink:0;font-variant-numeric:tabular-nums}',
      '.wp-file .bar{width:74px;height:3px;border-radius:9px;background:rgba(var(--ink, 255,255,255), 0.08);overflow:hidden}.wp-file .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff6b06,#f9182f);transition:width .25s}',
      '.wp-file .acts{display:flex;gap:2px;flex-shrink:0}.wp-file .acts button{border:0;background:transparent;color:var(--tx-6, #6b74a0);border-radius:6px;height:24px;min-width:24px;padding:0 6px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}',
      '.wp-file .acts button:hover{color:var(--tx-0, #fff);background:rgba(var(--ink, 255,255,255), 0.06)}',
      '.wp-file.done .st .ok{color:var(--fg-emerald, #34d399);display:flex}.wp-file.failed .nm,.wp-file.failed .st{color:var(--fg-red, #f87171)}.wp-file.failed .acts button[data-wp-retry]{color:var(--fg-orange, #ff8a3d)}',
      '[data-wp-drop]{position:relative}[data-wp-drop].over::after{content:"Drop to attach";position:absolute;inset:-6px;border:1.5px dashed #ff6b06;border-radius:12px;background:rgba(var(--sf-1-rgb, 10,12,22), 0.82);display:grid;place-items:center;color:var(--fg-orange, #ff8a3d);font-size:12px;font-weight:700;z-index:3}',
      /* assignees */
      '.wp-ahead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:4px;border-top:1px solid rgba(var(--ink, 255,255,255), 0.06)}',
      '.wp-ahead .wp-lbl b{color:var(--tx-2, #c7cbe0);font-weight:700;margin-left:6px}',
      '#wp-cards{display:flex;flex-direction:column}',
      '.wp-card{padding:14px 0;border-bottom:1px solid rgba(var(--ink, 255,255,255), 0.05)}.wp-card:first-child{padding-top:6px}',
      '.wp-row1{display:grid;grid-template-columns:minmax(190px,230px) minmax(0,1fr) minmax(130px,160px) auto;gap:10px;align-items:center}',
      '.wp-row2{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:start;margin-top:10px;padding-left:2px}',
      '.wp-meta{display:flex;align-items:center;gap:8px}',
      '.wp-more{display:flex;gap:2px}.wp-more button{border:0;background:transparent;color:var(--tx-6, #6b74a0);height:30px;padding:0 8px;border-radius:8px;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}',
      '.wp-more button:hover{color:var(--tx-0, #fff);background:rgba(var(--ink, 255,255,255), 0.05)}.wp-more button.rm:hover{color:var(--fg-red, #f87171)}',
      '.wp-card .wp-files{margin-top:6px;padding-left:2px}',
      /* employee picker */
      '.wp-pick{position:relative}',
      '.wp-pick-btn{display:flex;align-items:center;gap:9px;width:100%;height:38px;padding:0 10px 0 4px;border-radius:999px;border:1px solid rgba(var(--ink, 255,255,255), 0.06);background:rgba(var(--ink, 255,255,255), 0.03);color:var(--tx-0, #fff);font:inherit;font-size:12.5px;cursor:pointer;text-align:left}',
      '.wp-pick-btn:hover,.wp-pick.open .wp-pick-btn{border-color:rgba(255,107,6,.45)}',
      '.wp-av{width:30px;height:30px;border-radius:50%;flex-shrink:0;display:grid;place-items:center;font-size:11px;font-weight:800;color:var(--tx-0, #fff);background:linear-gradient(135deg,var(--sf-4, #2a3150),var(--sf-3, #1a1f35));overflow:hidden}.wp-av img{width:100%;height:100%;object-fit:cover}',
      '.wp-av.empty{background:rgba(var(--ink, 255,255,255), 0.05);color:var(--tx-7, #4f5785);border:1px dashed rgba(var(--ink, 255,255,255), 0.12)}',
      '.wp-pick-t{min-width:0;flex:1;line-height:1.15}.wp-pick-t b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wp-pick-t small{display:block;font-size:10.5px;color:var(--tx-6, #6b74a0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wp-pick-pop{position:absolute;left:0;top:calc(100% + 6px);z-index:40;width:max(100%,280px);max-height:300px;overflow:auto;padding:6px;border-radius:14px;background:var(--sf-3, #12162a);border:1px solid rgba(var(--ink, 255,255,255), 0.1);box-shadow:0 24px 60px -16px rgba(var(--shade, 0,0,0), calc(0.85 * var(--shade-k, 1)))}',
      '.wp-pick-pop input{width:100%;box-sizing:border-box;height:34px;margin-bottom:4px;border-radius:9px;border:1px solid rgba(var(--ink, 255,255,255), 0.08);background:rgba(var(--ink, 255,255,255), 0.03);color:var(--tx-0, #fff);padding:0 10px;font:inherit;font-size:12.5px;outline:none}',
      '.wp-opt{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border-radius:10px;border:0;background:transparent;color:var(--tx-1, #e6e9f5);font:inherit;font-size:12.5px;cursor:pointer;text-align:left}',
      '.wp-opt:hover,.wp-opt.on{background:rgba(255,107,6,.1)}.wp-opt small{display:block;color:var(--tx-6, #6b74a0);font-size:10.5px}',
      /* priority segmented */
      '.wp-seg{display:inline-flex;height:36px;padding:3px;border-radius:9px;background:rgba(var(--ink, 255,255,255), 0.03);border:1px solid rgba(var(--ink, 255,255,255), 0.06)}',
      '.wp-seg button{border:0;background:transparent;color:var(--tx-6, #6b74a0);font:inherit;font-size:11.5px;font-weight:600;padding:0 9px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
      '.wp-seg button i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.8}',
      '.wp-seg button.on{background:rgba(var(--ink, 255,255,255), 0.07);color:var(--tx-0, #fff)}.wp-seg button[data-p=very_high].on{color:var(--fg-red, #fca5a5)}.wp-seg button[data-p=low].on{color:var(--fg-blue, #93c5fd)}',
      '.wp-due{width:150px}',
      /* collapsed summary */
      '.wp-sumrow{display:none;align-items:center;gap:12px;cursor:pointer;padding:2px 0}',
      '.wp-card.closed .wp-edit{display:none}.wp-card.closed .wp-sumrow{display:flex}',
      '.wp-sumrow .t{flex:1;min-width:0}.wp-sumrow .t b{display:block;color:var(--tx-0, #fff);font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wp-sumrow .t span{display:block;color:var(--tx-4, #8b93b8);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wp-sumrow .due{font-size:11.5px;color:var(--tx-3, #a5adcf);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.wp-pdot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:#fbbf24}.wp-pdot.low{background:#60a5fa}.wp-pdot.very_high{background:#f87171}',
      '.wp-addas{align-self:flex-start;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;margin-top:10px;border-radius:9px;border:0;background:transparent;color:var(--fg-orange, #ff8a3d);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
      '.wp-addas:hover{background:rgba(255,107,6,.08)}',
      /* footer */
      '.wp-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:16px;border-top:1px solid rgba(var(--ink, 255,255,255), 0.06)}',
      '.wp-foot .sum{font-size:11.5px;color:var(--tx-6, #6b74a0);font-variant-numeric:tabular-nums}.wp-foot .sum b{color:var(--tx-2, #c7cbe0);font-weight:600}.wp-foot .warn{color:var(--fg-amber, #fbbf24)}',
      '.wp-go{border:0;border-radius:10px;height:40px;padding:0 24px;color:#fff;font:inherit;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;background:linear-gradient(135deg,#ff6b06,#f9182f 55%,#ff0552);box-shadow:0 6px 18px -6px rgba(249,24,47,.6)}',
      '.wp-go:disabled{opacity:.75;cursor:progress}',
      '.wp button:focus-visible,.wp-pick-btn:focus-visible{outline:2px solid #ff8a3c;outline-offset:2px}',
      /* shared with the pipeline / project views */
      '.wp-chip{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;color:var(--fg-violet, #c4b5fd);background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.35);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
      '.wp-refs{display:flex;flex-direction:column;gap:6px}.wp-refs .lbl{font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--tx-6, #6b74a0)}',
      '.wp-shared a{display:flex;align-items:center;gap:6px;color:var(--fg-blue, #93c5fd);font-size:11.5px;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wp-shared a:hover{color:var(--tx-0, #fff)}',
      '.wpp{display:flex;flex-direction:column;gap:12px}',
      '.wpp-card{border:1px solid rgba(var(--ink, 255,255,255), 0.07);border-radius:16px;background:rgba(var(--ink, 255,255,255), 0.02);padding:14px 16px}',
      '.wpp-top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start}',
      '.wpp-top h4{margin:0;color:var(--tx-0, #fff);font-size:15px}.wpp-top p{margin:3px 0 0;color:var(--tx-4, #8b93b8);font-size:11.5px}',
      '.wpp-prog{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--tx-4, #8b93b8);min-width:160px}.wpp-prog .bar{flex:1;height:6px;border-radius:9px;background:rgba(var(--ink, 255,255,255), 0.08);overflow:hidden}.wpp-prog .bar i{display:block;height:100%;background:linear-gradient(90deg,#34d399,#10b981)}',
      '.wpp-list{display:flex;flex-direction:column;gap:6px;margin-top:12px}',
      '.wpp-a{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 11px;border-radius:12px;background:rgba(var(--ink, 255,255,255), 0.025);border:1px solid rgba(var(--ink, 255,255,255), 0.06)}',
      '.wpp-a .who{flex:1;min-width:180px}.wpp-a .who b{display:block;color:var(--tx-0, #fff);font-size:12.5px}.wpp-a .who span{color:var(--tx-4, #8b93b8);font-size:11px}',
      '.wpp-a .acts{display:flex;gap:5px;flex-wrap:wrap}.wpp-a .acts button{border:1px solid rgba(var(--ink, 255,255,255), 0.12);background:rgba(var(--ink, 255,255,255), 0.05);color:var(--tx-2, #c7cbe0);font:inherit;font-size:11px;font-weight:700;padding:5px 10px;border-radius:8px;cursor:pointer}',
      '.wpp-a .acts button.pri{border-color:rgba(255,107,6,.4);background:rgba(255,107,6,.12);color:var(--fg-orange, #ff8a3d)}.wpp-a .acts button.bad{border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.1);color:var(--fg-red, #f87171)}',
      '.wpp-st{font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;white-space:nowrap}',
      /* The Media Suite styles every input/select/textarea globally with !important (dark box,
         5px radius, 11px text) — re-assert this form's own field styles with higher priority. */
      '.wp input.wp-title{background:transparent!important;border:0!important;border-bottom:1px solid rgba(var(--ink, 255,255,255), 0.08)!important;border-radius:0!important;font-size:22px!important;font-weight:700!important;padding:4px 0 10px!important;height:auto!important;box-shadow:none!important}',
      '.wp input.wp-title:focus{border-bottom-color:#ff6b06!important}',
      '.wp textarea.wp-auto{background:rgba(var(--ink, 255,255,255), 0.025)!important;border:1px solid transparent!important;border-radius:10px!important;font-size:13px!important;padding:9px 12px!important}',
      '.wp textarea.wp-auto:focus{background:rgba(var(--ink, 255,255,255), 0.04)!important;border-color:rgba(255,107,6,.45)!important}',
      '.wp input.wp-in,.wp select.wp-in{background:rgba(var(--ink, 255,255,255), 0.03)!important;border:1px solid rgba(var(--ink, 255,255,255), 0.06)!important;border-radius:9px!important;font-size:12.5px!important;height:36px!important}',
      '.wp select.wp-in{background:var(--sf-2, #10131f)!important}.wp input.wp-del-in{font-size:13.5px!important;height:38px!important}',
      '.wp input.wp-in:focus,.wp select.wp-in:focus{border-color:rgba(255,107,6,.55)!important}',
      '.wp .bad{border-color:#f87171!important}',
      '.wp .wp-pick-pop input{background:rgba(var(--ink, 255,255,255), 0.03)!important;border:1px solid rgba(var(--ink, 255,255,255), 0.08)!important;border-radius:9px!important;font-size:12.5px!important;height:34px!important}',
      /* tablet / phone */
      '@media(max-width:1024px){.wp-row1{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.wp-row1 .wp-cls{grid-column:1}.wp-row1 .wp-more{grid-column:2;justify-self:end}.wp-row1 .wp-delw{grid-column:1/-1;order:-1}}',
      '@media(max-width:1024px){.wp-row1 .wp-pick{order:-2;grid-column:1/-1}}',
      '@media(max-width:640px){#admin-assignment-panel.wp-on{padding:18px 16px!important}.wp input.wp-title{font-size:19px!important}',
      '.wp-row1{grid-template-columns:1fr}.wp-row1 .wp-cls,.wp-row1 .wp-more{grid-column:auto;justify-self:stretch}.wp-more{justify-content:flex-end}',
      '.wp-row2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.wp-row2>*{min-width:0}.wp-row2 .wp-auto{grid-column:1/-1}.wp-seg{width:100%;min-width:0}.wp-seg button{flex:1;justify-content:center;padding:0 2px;min-width:0}.wp-meta{min-width:0}.wp-due{width:100%;min-width:0}.wp input.wp-due{padding:0 6px!important}',
      '.wp-foot{flex-direction:column;align-items:stretch}.wp-go{width:100%}.wp-file .bar{width:44px}.wp-sumrow .due{display:none}.wp-sumrow .wp-more button:not([data-wp-open]){display:none}}'
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
  // DOM: one compact line per file, created once and patched in place (no list re-render)
  function drawJob(j) {
    var list = document.querySelector('[data-wp-files="' + j.owner + '"]'); if (!list) return;
    var el = list.querySelector('[data-job="' + j.id + '"]');
    if (j.status === 'cancelled') { if (el) el.remove(); changed(); return; }
    if (!el) {
      el = document.createElement('div'); el.className = 'wp-file'; el.setAttribute('data-job', j.id);
      el.innerHTML = '<span class="ic">' + IC.file + '</span><span class="nm"></span><span class="st"></span><span class="acts"></span>';
      list.appendChild(el);
      el.querySelector('.nm').textContent = j.file.name;
    }
    el.className = 'wp-file ' + j.status;
    el.title = j.status === 'failed' ? j.err : '';
    var st = el.querySelector('.st'), acts = el.querySelector('.acts'), size = '<span>' + esc(mb(j.file.size)) + '</span>';
    if (j.status === 'done') { st.innerHTML = size + '<span class="ok" aria-label="Uploaded">' + IC.ok + '</span>'; acts.innerHTML = '<button type="button" data-wp-rm="' + j.id + '" aria-label="Remove ' + esc(j.file.name) + '">' + IC.x + '</button>'; }
    else if (j.status === 'failed') { st.innerHTML = '<span>Upload failed</span>'; acts.innerHTML = '<button type="button" data-wp-retry="' + j.id + '">Retry</button><button type="button" data-wp-rm="' + j.id + '" aria-label="Remove">' + IC.x + '</button>'; }
    else { st.innerHTML = size + '<span class="bar"><i style="width:' + (j.pct || 0) + '%"></i></span><span class="lbl">' + (j.status === 'queued' ? 'Waiting' : (j.pct || 0) + '%') + '</span>'; acts.innerHTML = '<button type="button" data-wp-cancel="' + j.id + '" aria-label="Cancel upload">' + IC.x + '</button>'; }
    changed();
  }
  function tick(j) {
    var el = document.querySelector('[data-job="' + j.id + '"]'); if (!el) return;
    var b = el.querySelector('.bar i'), l = el.querySelector('.lbl');
    if (b) b.style.width = j.pct + '%'; if (l) l.textContent = j.pct + '%';
    changed();
  }
  function refsOf(owner) { return U.jobs.filter(function (j) { return j.owner === owner && j.status === 'done'; }).map(function (j) { return { name: j.result.name, url: j.result.url, size: j.file.size, type: j.file.type }; }); }

  // ════════════════════════════════════════════════════════════════════════
  // Create & Assign Work Project form — minimal layout
  //   Project (title · brief · shared files)  →  Assignees (one compact block each)  →  Assign
  // ════════════════════════════════════════════════════════════════════════
  var F = { cards: [], seq: 0, waiting: false, saving: false, mounted: false };
  function empList() {
    var src = document.getElementById('task-assigned-employee'), out = [];
    if (src) Array.prototype.forEach.call(src.options, function (o) { if (o.value) out.push({ name: o.value, label: o.textContent }); });
    var roster = G('userRoster') || [];
    out.forEach(function (e) {
      var r = roster.filter(function (u) { return u.name === e.name; })[0];
      e.email = r ? String(r.email || '').toLowerCase() : '';
      var des = null; try { if (typeof hrDesignationForEmail === 'function' && e.email) des = hrDesignationForEmail(e.email); } catch (_) {}
      e.role = des || (r && r.role ? String(r.role).replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }) : '');
    });
    return out;
  }
  function empOptions(sel) {
    return '<option value="">Select employee</option>' + empList().map(function (e) { return '<option value="' + esc(e.name) + '"' + (e.name === sel ? ' selected' : '') + '>' + esc(e.name) + '</option>'; }).join('');
  }
  // Photos: HR's employee list when present (hr.html), else app.html's shared lazy cache
  // (beEmpForEmail: one batched hr_employees query) — avatars repaint when photos arrive.
  function avatar(name, email) {
    if (!name) return '<span class="wp-av empty">+</span>';
    email = String(email || '').toLowerCase();
    try {
      if (typeof hrAvatarHTML === 'function') {
        var emp = (typeof hrEmployees !== 'undefined' && Array.isArray(hrEmployees)) ? hrEmployees.filter(function (e) { return (e.portal_email || '').toLowerCase() === email; })[0] : null;
        if (!emp && email && typeof window.beEmpForEmail === 'function') emp = window.beEmpForEmail(email, repaintAvatars);
        var h = hrAvatarHTML(emp || name, 30); if (h) return '<span class="wp-av" data-av-email="' + esc(email) + '">' + h + '</span>';
      }
    } catch (_) {}
    var ini = String(name).trim().split(/\s+/).map(function (w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase();
    return '<span class="wp-av" data-av-email="' + esc(email) + '">' + esc(ini) + '</span>';
  }
  function repaintAvatars() {
    if (typeof hrAvatarHTML !== 'function' || typeof window.beEmpForEmail !== 'function') return;
    document.querySelectorAll('.wp-av[data-av-email]').forEach(function (s) {
      var em = s.getAttribute('data-av-email'); if (!em) return;
      var e = window.beEmpForEmail(em); if (e && (e.photo_url || e.photo_base64)) s.innerHTML = hrAvatarHTML(e, 30);
    });
  }
  function classOptions(sel) {
    var src = document.getElementById('task-type'), list = CLASSES.slice();
    if (src) Array.prototype.forEach.call(src.options, function (o) { if (list.indexOf(o.value) < 0) list.push(o.value); });
    return '<option value="">Work type</option>' + list.map(function (c) { return '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '<option value="__other">Other…</option>';
  }
  function fileBtn(owner, label) { return '<label class="wp-addf">' + IC.plus + label + '<input type="file" multiple accept="' + ACCEPT + '" data-wp-input="' + owner + '"></label>'; }
  function cardHTML(c) {
    var k = c.key;
    return '<div class="wp-card" data-card="' + k + '" data-wp-drop="' + k + '">'
      // collapsed summary (shown once the block is complete and another assignee is added)
      + '<div class="wp-sumrow" data-wp-open="' + k + '"><span data-wp-sav></span><span class="t"><b data-wp-sname></b><span data-wp-sdel></span></span><span class="wp-pdot" data-wp-sdot></span><span class="due" data-wp-sdue></span>'
      + '<span class="wp-more"><button type="button" data-wp-open="' + k + '">Edit</button><button type="button" data-wp-dup="' + k + '">Duplicate</button><button type="button" class="rm" data-wp-del="' + k + '">Remove</button></span></div>'
      + '<div class="wp-edit">'
      + '<div class="wp-row1">'
      + '<div class="wp-pick" data-pick="' + k + '"><select data-k="emp" hidden data-native>' + empOptions() + '</select><button type="button" class="wp-pick-btn" data-wp-pick="' + k + '" aria-haspopup="listbox">' + avatar('') + '<span class="wp-pick-t"><b>Choose employee</b><small>Who is doing this?</small></span>' + IC.chev + '</button></div>'
      + '<div class="wp-delw"><input class="wp-in wp-del-in" data-k="del" placeholder="Deliverable — e.g. Edit the final Reel video" aria-label="Deliverable"></div>'
      + '<div class="wp-cls"><select class="wp-in" data-k="cls" aria-label="Work type">' + classOptions() + '</select><input class="wp-in" data-k="clsOther" placeholder="Type the work type" style="display:none;margin-top:6px"></div>'
      + '<div class="wp-more"><button type="button" data-wp-fold="' + k + '" title="Collapse">Done</button><button type="button" data-wp-dup="' + k + '">Duplicate</button><button type="button" class="rm" data-wp-del="' + k + '">Remove</button></div>'
      + '</div>'
      + '<div class="wp-row2">'
      + '<textarea class="wp-auto" data-k="ins" rows="1" placeholder="Instructions (optional)" aria-label="Instructions"></textarea>'
      + '<div class="wp-seg" role="radiogroup" aria-label="Priority"><select data-k="pri" hidden data-native>' + PRIORITY.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === 'medium' ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select>'
      + PRIORITY.map(function (p) { return '<button type="button" data-p="' + p[0] + '" role="radio" aria-checked="' + (p[0] === 'medium') + '" class="' + (p[0] === 'medium' ? 'on' : '') + '"><i></i>' + (p[0] === 'very_high' ? 'High' : p[1]) + '</button>'; }).join('') + '</div>'
      + '<label class="wp-meta"><span class="wp-hint">Due</span><input type="date" class="wp-in wp-due" data-k="due" min="' + today() + '" aria-label="Deadline"></label>'
      + '</div>'
      + '<div class="wp-files-line" style="margin-top:10px">' + fileBtn(k, 'Files') + '<span class="wp-hint" data-wp-fhint>Only this person sees these</span></div>'
      + '<div class="wp-files" data-wp-files="' + k + '"></div>'
      + '</div></div>';
  }
  function formHTML() {
    return '<div class="wp" id="wp-form">'
      + '<div class="wp-proj" data-wp-drop="shared">'
      + '<input id="wp-title" class="wp-title" placeholder="Project name — e.g. Vocabulary Reels Day 5" aria-label="Project name" autocomplete="off">'
      + '<textarea id="wp-brief" class="wp-auto" rows="1" placeholder="Shared brief for everyone on this project" aria-label="Shared brief"></textarea>'
      + '<div class="wp-files-line">' + fileBtn('shared', 'Shared files') + '<span class="wp-hint">Visible to every assignee</span></div>'
      + '<div class="wp-files" data-wp-files="shared"></div>'
      + '</div>'
      + '<div><div class="wp-ahead"><span class="wp-lbl">Assignees<b id="wp-count">1</b></span></div>'
      + '<div id="wp-cards"></div>'
      + '<button type="button" class="wp-addas" id="wp-add">' + IC.plus + 'Add assignee</button></div>'
      + '<div class="wp-foot"><span class="sum" id="wp-sum"></span><button type="button" class="wp-go" id="wp-go">Assign Project</button></div>'
      + '</div>';
  }
  function addCard(from) {
    var c = { key: 'a' + (++F.seq) };
    F.cards.push(c);
    document.getElementById('wp-cards').insertAdjacentHTML('beforeend', cardHTML(c));
    var el = cardEl(c.key);
    if (from) {   // Duplicate: same work type / deliverable / instructions / priority / deadline, new person, no files
      ['cls', 'clsOther', 'del', 'ins', 'due'].forEach(function (k) { var a = el.querySelector('[data-k="' + k + '"]'), b = from.querySelector('[data-k="' + k + '"]'); if (a && b) a.value = b.value; });
      setPri(el, from.querySelector('[data-k="pri"]').value);
      var o = el.querySelector('[data-k="clsOther"]'); if (o) o.style.display = el.querySelector('[data-k="cls"]').value === '__other' ? '' : 'none';
      autosize(el.querySelector('[data-k="ins"]'));
    }
    // fold earlier complete blocks into one-line summaries
    F.cards.slice(0, -1).forEach(function (x) { if (complete(x)) fold(x.key, true); });
    renumber(); summary();
    openPicker(c.key);
  }
  function cardEl(key) { return document.querySelector('.wp-card[data-card="' + key + '"]'); }
  function readCard(c) {
    var el = cardEl(c.key); if (!el) return {};
    var v = function (k) { var x = el.querySelector('[data-k="' + k + '"]'); return x ? String(x.value || '').trim() : ''; };
    var cls = v('cls'); if (cls === '__other') cls = v('clsOther');
    return { emp: v('emp'), cls: cls, del: v('del'), ins: v('ins'), pri: v('pri') || 'medium', due: v('due') };
  }
  function complete(c) { var d = readCard(c); return !!(d.emp && d.cls && d.del && d.due); }
  function fold(key, on) { var el = cardEl(key); if (!el) return; if (on && !complete({ key: key })) { toastMsg('info', 'Add the employee, work type, deliverable and due date first.'); return; } el.classList.toggle('closed', !!on); }
  function fmtDue(iso) { if (!iso) return ''; var d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : 'Due ' + d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
  function renumber() {
    var emps = empList();
    F.cards.forEach(function (c) {
      var el = cardEl(c.key); if (!el) return;
      var d = readCard(c), e = emps.filter(function (x) { return x.name === d.emp; })[0];
      // picker face
      var btn = el.querySelector('.wp-pick-btn');
      btn.innerHTML = avatar(d.emp, e && e.email) + '<span class="wp-pick-t"><b>' + esc(d.emp || 'Choose employee') + '</b><small>' + esc(d.emp ? ((e && e.role) || d.cls || '') : 'Who is doing this?') + '</small></span>' + IC.chev;
      // summary line
      el.querySelector('[data-wp-sav]').innerHTML = avatar(d.emp, e && e.email);
      el.querySelector('[data-wp-sname]').textContent = (d.emp || 'Assignee') + (d.cls ? ' · ' + d.cls : '');
      el.querySelector('[data-wp-sdel]').textContent = d.del || '';
      el.querySelector('[data-wp-sdue]').textContent = fmtDue(d.due);
      el.querySelector('[data-wp-sdot]').className = 'wp-pdot ' + d.pri;
      var hint = el.querySelector('[data-wp-fhint]'); if (hint) hint.textContent = 'Only ' + (d.emp ? d.emp.split(' ')[0] : 'this person') + ' sees these';
      // a single assignee can't be removed; collapsing only makes sense once it's complete
      el.querySelectorAll('[data-wp-del]').forEach(function (b) { b.style.display = F.cards.length > 1 ? '' : 'none'; });
      var fb = el.querySelector('[data-wp-fold]'); if (fb) fb.style.display = F.cards.length > 1 ? '' : 'none';
    });
    var n = document.getElementById('wp-count'); if (n) n.textContent = F.cards.length;
  }
  function summary() {
    var s = document.getElementById('wp-sum'); if (!s) return;
    var busy = busyJobs().length, failed = failedJobs().length, files = U.jobs.filter(function (j) { return j.status === 'done'; }).length;
    var txt = '<b>' + F.cards.length + '</b> assignee' + (F.cards.length === 1 ? '' : 's') + (files ? ' · <b>' + files + '</b> file' + (files === 1 ? '' : 's') : '');
    if (busy) txt += ' · <span class="warn">uploading ' + overallPct() + '%</span>';
    if (failed) txt += ' · <span style="color:var(--fg-red, #f87171)">' + failed + ' upload' + (failed === 1 ? '' : 's') + ' failed</span>';
    s.innerHTML = txt;
    var go = document.getElementById('wp-go');
    if (go && F.waiting) go.textContent = busy ? 'Files uploading… ' + overallPct() + '%' : 'Assigning…';
  }
  function setPri(el, v) {
    var sel = el.querySelector('[data-k="pri"]'); if (sel) sel.value = v;
    el.querySelectorAll('.wp-seg button').forEach(function (b) { var on = b.getAttribute('data-p') === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  }
  function autosize(t) { if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 240) + 'px'; }

  // ── employee picker (avatar · name · designation, searchable) ──────────────
  var openPick = null;
  function closePicker() { if (openPick) { var p = document.querySelector('.wp-pick.open'); if (p) { p.classList.remove('open'); var pop = p.querySelector('.wp-pick-pop'); if (pop) pop.remove(); } openPick = null; } }
  function openPicker(key) {
    closePicker();
    var el = cardEl(key); if (!el) return;
    var wrap = el.querySelector('.wp-pick'), sel = wrap.querySelector('[data-k="emp"]');
    var emps = empList();
    var pop = document.createElement('div'); pop.className = 'wp-pick-pop'; pop.setAttribute('role', 'listbox');
    var draw = function (q) {
      q = String(q || '').toLowerCase();
      var list = emps.filter(function (e) { return !q || e.name.toLowerCase().indexOf(q) > -1 || String(e.role).toLowerCase().indexOf(q) > -1; });
      pop.querySelector('.wp-opts').innerHTML = list.length ? list.map(function (e) { return '<button type="button" class="wp-opt' + (e.name === sel.value ? ' on' : '') + '" data-emp="' + esc(e.name) + '" role="option">' + avatar(e.name, e.email) + '<span><b style="font-weight:600">' + esc(e.name) + '</b><small>' + esc(e.role || '') + '</small></span></button>'; }).join('') : '<div style="padding:10px;color:var(--tx-6, #6b74a0);font-size:12px">No match</div>';
    };
    pop.innerHTML = '<input type="search" placeholder="Search people" aria-label="Search employees"><div class="wp-opts"></div>';
    wrap.appendChild(pop); wrap.classList.add('open'); openPick = key;
    draw('');
    var s = pop.querySelector('input');
    s.addEventListener('input', function () { draw(s.value); });
    s.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var f = pop.querySelector('[data-emp]'); if (f) f.click(); }
      if (e.key === 'Escape') { closePicker(); wrap.querySelector('.wp-pick-btn').focus(); }
    });
    setTimeout(function () { s.focus(); }, 0);
  }
  function pickEmployee(key, name) {
    var el = cardEl(key); if (!el) return;
    var sel = el.querySelector('[data-k="emp"]'); sel.value = name;
    el.querySelector('.wp-pick-btn').classList.remove('bad');
    closePicker(); renumber();
    var del = el.querySelector('[data-k="del"]'); if (del && !del.value) del.focus();
  }

  function resetForm() {
    F.cards = []; F.seq = 0; F.waiting = false; F.saving = false;
    U.jobs.filter(function (j) { return j.status === 'uploading'; }).forEach(function (j) { j.status = 'cancelled'; try { j.ctl.abort(); } catch (_) {} });
    U.jobs = []; newBatch();
    var host = document.getElementById('wp-host'); if (!host) return;
    host.innerHTML = formHTML(); if (!host._wired) { wire(host); host._wired = true; }
    addCard(); closePicker();
  }
  function wire(host) {
    host.addEventListener('change', function (e) {
      var inp = e.target.closest('[data-wp-input]');
      if (inp) { addFiles(inp.files, inp.getAttribute('data-wp-input')); inp.value = ''; return; }
      var cls = e.target.closest('[data-k="cls"]');
      if (cls) { var o = cls.parentNode.querySelector('[data-k="clsOther"]'); if (o) { o.style.display = cls.value === '__other' ? '' : 'none'; if (cls.value === '__other') o.focus(); } }
      if (e.target.classList) e.target.classList.remove('bad');
      renumber();
    });
    host.addEventListener('input', function (e) {
      if (e.target.classList) e.target.classList.remove('bad');
      if (e.target.classList && e.target.classList.contains('wp-auto')) autosize(e.target);
      if (e.target.closest('.wp-card')) renumber();
    });
    host.addEventListener('click', function (e) {
      var b;
      if ((b = e.target.closest('[data-emp]'))) { var pk = b.closest('.wp-card').getAttribute('data-card'); return pickEmployee(pk, b.getAttribute('data-emp')); }
      if ((b = e.target.closest('[data-wp-pick]'))) { var key = b.getAttribute('data-wp-pick'); return openPick === key ? closePicker() : openPicker(key); }
      if ((b = e.target.closest('.wp-seg button'))) { setPri(b.closest('.wp-card'), b.getAttribute('data-p')); return renumber(); }
      if ((b = e.target.closest('[data-wp-cancel]'))) return cancelJob(+b.getAttribute('data-wp-cancel'));
      if ((b = e.target.closest('[data-wp-retry]'))) return retryJob(+b.getAttribute('data-wp-retry'));
      if ((b = e.target.closest('[data-wp-rm]'))) return cancelJob(+b.getAttribute('data-wp-rm'));
      if ((b = e.target.closest('[data-wp-dup]'))) { e.stopPropagation(); return addCard(cardEl(b.getAttribute('data-wp-dup'))); }
      if ((b = e.target.closest('[data-wp-fold]'))) return fold(b.getAttribute('data-wp-fold'), true);
      if ((b = e.target.closest('[data-wp-del]'))) {
        e.stopPropagation();
        var dk = b.getAttribute('data-wp-del');
        jobsFor(dk).forEach(function (j) { cancelJob(j.id); });
        F.cards = F.cards.filter(function (c) { return c.key !== dk; });
        var del = cardEl(dk); if (del) del.remove();
        renumber(); summary(); return;
      }
      if ((b = e.target.closest('[data-wp-open]'))) return fold(b.getAttribute('data-wp-open'), false);
      if (e.target.closest('#wp-add')) return addCard();
      if (e.target.closest('#wp-go')) return submit();
    });
    document.addEventListener('mousedown', function (e) { if (openPick && !e.target.closest('.wp-pick')) closePicker(); });
    // drag & drop: the project header or an assignee block highlights only while dragging
    var dragOwner = null;
    host.addEventListener('dragover', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      var d = e.target.closest('[data-wp-drop]'); if (!d) return;
      e.preventDefault();
      if (dragOwner !== d) { host.querySelectorAll('[data-wp-drop].over').forEach(function (x) { x.classList.remove('over'); }); d.classList.add('over'); dragOwner = d; }
    });
    host.addEventListener('dragleave', function (e) { var d = e.target.closest('[data-wp-drop]'); if (d && !d.contains(e.relatedTarget)) { d.classList.remove('over'); dragOwner = null; } });
    host.addEventListener('drop', function (e) {
      var d = e.target.closest('[data-wp-drop]'); if (!d) return;
      e.preventDefault(); d.classList.remove('over'); dragOwner = null;
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files, d.getAttribute('data-wp-drop'));
    });
  }
  U.listeners.push(function () { summary(); if (F.waiting && !busyJobs().length) { F.waiting = false; submit(); } });

  function validateForm() {
    var title = document.getElementById('wp-title'), bad = [], first = null;
    var mark = function (el) {
      if (!el) return;
      if (el.hidden && el.closest('.wp-pick')) el = el.closest('.wp-pick').querySelector('.wp-pick-btn');   // custom picker face
      el.classList.add('bad'); first = first || el;
    };
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
    finally { F.saving = false; var g = document.getElementById('wp-go'); if (g) { g.disabled = false; g.textContent = 'Assign Project'; } }
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
    host.innerHTML = '<div class="wpp"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"><h3 class="text-base md:text-lg font-bold text-white" style="margin:0">Work projects</h3><span style="font-size:11px;color:var(--tx-6, #6b74a0)">Multi-person projects — each assignment tracked separately</span></div>'
      + multi.map(function (p) {
        var list = byP[p.id] || [], live = list.filter(function (x) { return x.status !== 'cancelled'; }), done = live.filter(function (x) { return x.status === 'Completed'; }).length;
        var st = STATUS[p.status] || [p.status, '#94a3b8'], pct = live.length ? Math.round(done / live.length * 100) : 0;
        return '<div class="wpp-card"><div class="wpp-top"><div style="min-width:0;flex:1"><h4>' + esc(p.title) + '</h4><p>' + list.length + ' assignments · by ' + esc(p.created_by || '—') + (p.shared_description ? ' · ' + esc(String(p.shared_description).slice(0, 90)) + (p.shared_description.length > 90 ? '…' : '') : '') + '</p></div>'
          + '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="wpp-st" style="color:' + st[1] + ';background:' + st[1] + '22;border:1px solid ' + st[1] + '55">' + esc(st[0]) + '</span><div class="wpp-prog"><span>' + done + ' of ' + live.length + ' done</span><span class="bar"><i style="width:' + pct + '%"></i></span></div></div></div>'
          + ((P.shared[p.id] || []).length ? '<div style="margin-top:10px"><div style="font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--tx-6, #6b74a0);margin-bottom:4px">Shared project files</div>' + sharedList(p.id) + '</div>' : '')
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
    var t = document.getElementById('wa-form-title'); if (t) t.textContent = 'New work project';
    panel.classList.add('wp-on');
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
    var t = document.getElementById('wa-form-title'); if (t && !on) t.textContent = 'New work project';
    var p = document.getElementById('admin-assignment-panel'); if (p) p.classList.toggle('wp-on', !on);
  }
  /** Refresh employee options after the roster loads. */
  function refreshEmployees() {
    F.cards.forEach(function (c) { var el = cardEl(c.key); if (!el) return; var s = el.querySelector('[data-k="emp"]'); if (!s) return; var v = s.value; s.innerHTML = empOptions(); s.value = v; });
    renumber();
  }

  window.WorkProjects = { mount: mount, ensure: ensure, project: project, chip: chip, refCell: refCell, descExtra: descExtra, renderPanel: renderPanel,
    syncAssignmentRefs: syncAssignmentRefs, editMode: editMode, refreshEmployees: refreshEmployees, queue: queue,
    _jobs: function () { return U.jobs; }, _addFiles: addFiles };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(mount, 0); }); else setTimeout(mount, 0);
})();
