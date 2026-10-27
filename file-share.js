/* ════════════════════════════════════════════════════════════════════════════
   BEShare — the ONE internal file-sharing module for every portal.

   Send approved work (later: new uploads) to ERP people, departments, heads or role groups.
   Nothing is uploaded or copied: a send creates one share (pointers to the existing delivery
   files) + one recipient row per person, each with its own Viewed / Downloaded state.

   Data lives in erp_file_shares / erp_file_share_recipients (20261103_file_shares.sql) and is
   reachable ONLY through the `share` edge function (ERP session token) — the browser key
   can't read it, and file links are returned only to the people a file was sent to.

   BEShare.send(work)        Send dialog. work = { source:{type:'assignment', id}, title, type,
                             approved_at, files:[{name}] }  (files in delivery order)
   BEShare.open(tab)         Files panel: 'received' (Shared with me) | 'sent' (status history)
   BEShare.openFromLink(l)   notification link  share:<recipient row id>
   Automatic once signed in: "Received Files" nav entry with unread badge in every portal,
   live toast when something arrives (from the Notification Center row the server writes).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BEShare) return;
  var DCOL = { production: '#ff8a3d', education: '#60a5fa', sales: '#34d399', hr: '#f472b6', management: '#a78bfa', accounts: '#fbbf24', other: '#94a3b8' };
  var S = { email: '', targets: null, targetsAt: 0, inbox: null, unread: 0, panel: null, tab: 'received', openRid: null, opened: {} };

  // ── basics ────────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function B() { return window.BESession || {}; }
  function svg(d, s) { return '<svg width="' + (s || 14) + '" height="' + (s || 14) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var IC = {
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>', check: '<path d="m5 12 5 5 9-10"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>', eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    dept: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    fwd: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
    video: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3"/>', image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'
  };
  function kindIcon(k) { return svg(IC[k === 'video' ? 'video' : k === 'image' ? 'image' : k === 'folder' ? 'folder' : 'file'], 15); }
  function kindOf(name) {
    var n = String(name || '').toLowerCase();
    if (/\.(mp4|mov|m4v|webm|mkv|avi)$|youtube|video/.test(n)) return 'video';
    if (/\.(png|jpe?g|gif|webp|svg|heic)$/.test(n)) return 'image';
    if (/folder/.test(n)) return 'folder';
    return 'file';
  }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return (w[0] || '').toUpperCase(); }).join('') || '?'; }
  function fDate(iso, withTime) {
    if (!iso) return '—'; var d = new Date(iso); if (isNaN(d)) return '—';
    var s = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    return withTime ? s + ' · ' + d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase() : s;
  }
  function toast(kind, msg) { if (typeof window.showToast === 'function') { try { return window.showToast(kind, msg); } catch (_) {} } note({ title: msg }); }
  function isMobile() { return window.matchMedia && matchMedia('(max-width: 720px)').matches; }

  // ── server ───────────────────────────────────────────────────────────────
  async function api(action, body) {
    var tk = B().ensure ? await B().ensure() : (B().token ? B().token() : null);
    if (!tk) throw new Error('Your session has expired. Please sign in again.');
    var r = await fetch(B().url + '/functions/v1/share', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': B().anonKey, 'Authorization': 'Bearer ' + B().anonKey, 'x-erp-session': tk },
      body: JSON.stringify(Object.assign({ action: action }, body || {})) });
    var j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && !(body && body._retry) && B().clear && B().ensure && j.code === 'SESSION_EXPIRED') {
      try { B().clear(B().currentEmail()); } catch (_) {}
      if (await B().ensure()) return api(action, Object.assign({}, body || {}, { _retry: true }));
    }
    if (!r.ok) throw new Error(j.error || 'File sharing is unavailable right now.');
    return j;
  }
  function loadTargets(force) {
    if (!force && S.targets && Date.now() - S.targetsAt < 120000) return Promise.resolve(S.targets);
    return api('targets').then(function (j) { S.targets = j.targets || []; S.targetsAt = Date.now(); return S.targets; });
  }
  async function loadInbox() {
    var j = await api('inbox');
    S.inbox = j.items || []; setUnread(j.unread || 0);
    return S.inbox;
  }
  function setUnread(n) {
    S.unread = n;
    document.querySelectorAll('[data-fs-badge]').forEach(function (b) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = n ? 'inline-flex' : 'none'; });
    var tb = S.panel && S.panel.querySelector('[data-fs-tabcount]'); if (tb) { tb.textContent = n; tb.style.display = n ? '' : 'none'; }
  }

  // ── styles ───────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('beshare-css')) return;
    var s = document.createElement('style'); s.id = 'beshare-css';
    s.textContent = [
      '.fs{--fs-bg:var(--sf-2, #0b0f1c);--fs-card:var(--sf-2, #0e1222);--fs-line:rgba(var(--ink, 255,255,255), 0.07);--fs-mute:var(--tx-4, #8b93b8);--fs-dim:var(--tx-6, #6b74a0);--fs-acc:#ff6b06;color:var(--tx-1, #e6e9f5);font-family:inherit}',
      '.fs *{box-sizing:border-box}.fs,.fs *{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}',
      '.fs ::-webkit-scrollbar{width:8px;height:8px}.fs ::-webkit-scrollbar-thumb{background:rgba(var(--ink, 255,255,255), 0.14);border-radius:8px}',
      // dialog
      '.fs-ov{position:fixed;inset:0;z-index:9360;display:grid;place-items:center;padding:16px;background:rgba(var(--scrim, 3,5,9), calc(0.62 * var(--scrim-k, 1)));backdrop-filter:blur(3px)}',
      '.fs-dlg{width:min(560px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:linear-gradient(170deg,var(--sf-3, #141a2c),var(--sf-2, #0c0f1c));border:1px solid rgba(var(--ink, 255,255,255), 0.09);border-radius:18px;box-shadow:0 30px 80px -20px rgba(var(--shade, 0,0,0), calc(0.85 * var(--shade-k, 1)));animation:fsIn .16s ease}',
      '@keyframes fsIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '.fs-hd{display:flex;align-items:center;gap:10px;padding:16px 18px 12px}.fs-hd h3{margin:0;flex:1;font-size:16px;font-weight:800;color:var(--tx-0, #fff)}',
      '.fs-x{width:32px;height:32px;border-radius:9px;border:1px solid var(--fs-line);background:rgba(var(--ink, 255,255,255), 0.03);color:var(--tx-3, #aab1d1);display:grid;place-items:center;cursor:pointer}.fs-x:hover{color:var(--tx-0, #fff)}',
      '.fs-bd{padding:0 18px 4px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;min-height:0}',
      '.fs-ft{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px 16px;border-top:1px solid var(--fs-line)}',
      '.fs-work{padding:12px 14px;border-radius:13px;background:rgba(var(--ink, 255,255,255), 0.03);border:1px solid var(--fs-line)}',
      '.fs-work b{display:block;font-size:14.5px;color:var(--tx-0, #fff);font-weight:700;line-height:1.35}',
      '.fs-meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:6px;font-size:11.5px;color:var(--fs-mute)}.fs-meta span b{display:inline;font-size:11.5px;color:var(--tx-2, #d7dbee);font-weight:600}',
      '.fs-lbl{display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--fs-dim);margin-bottom:7px}.fs-lbl .fs-link{margin-left:auto}',
      '.fs-link{background:none;border:0;padding:0;color:var(--fg-orange, #ff9a4d);font:inherit;font-size:11.5px;font-weight:700;letter-spacing:0;text-transform:none;cursor:pointer}.fs-link:hover{color:var(--fg-orange, #ffb77d)}',
      '.fs-files{display:flex;flex-direction:column;gap:5px}',
      '.fs-fr{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:7px 10px;border-radius:10px;border:1px solid var(--fs-line);background:rgba(var(--ink, 255,255,255), 0.02);color:var(--tx-1, #e6e9f5);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}',
      '.fs-fr:hover{background:rgba(var(--ink, 255,255,255), 0.05)}.fs-fr .fs-fn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.fs-fr>svg{color:var(--fs-mute);flex-shrink:0}',
      '.fs-cb{width:18px;height:18px;border-radius:5px;border:1.5px solid rgba(var(--ink, 255,255,255), 0.25);display:grid;place-items:center;flex-shrink:0;color:transparent;transition:.12s}',
      '[aria-checked="true"] .fs-cb,.fs-cb.on{background:var(--fs-acc);border-color:var(--fs-acc);color:var(--tx-0, #fff)}',
      '.fs-seg{display:inline-flex;padding:3px;border-radius:10px;background:rgba(var(--ink, 255,255,255), 0.04);border:1px solid var(--fs-line);gap:2px;margin-bottom:8px;max-width:100%;overflow-x:auto}',
      '.fs-seg button{height:28px;padding:0 11px;border-radius:8px;border:0;background:none;color:var(--fs-mute);font:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}.fs-seg button.on{background:rgba(255,107,6,.16);color:var(--tx-0, #fff)}',
      '.fs-box{border-radius:12px;border:1px solid rgba(var(--ink, 255,255,255), 0.1);background:rgba(var(--ink, 255,255,255), 0.03);transition:border-color .12s}.fs-box:focus-within{border-color:rgba(255,107,6,.55)}',
      '.fs-chips{display:flex;flex-wrap:wrap;gap:5px;padding:7px 8px 0}.fs-chips:empty{display:none}',
      '.fs-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;height:26px;padding:0 4px 0 9px;border-radius:999px;background:rgba(255,107,6,.12);border:1px solid rgba(255,107,6,.35);color:var(--fg-orange, #ffd9bd);font-size:11.5px;font-weight:700}',
      '.fs-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fs-chip i{font-style:normal;font-weight:600;color:var(--fg-orange, #ffb98a);opacity:.8}',
      '.fs-chip button{width:18px;height:18px;border-radius:50%;border:0;background:rgba(var(--ink, 255,255,255), 0.08);color:var(--fg-orange, #ffd9bd);display:grid;place-items:center;cursor:pointer;flex-shrink:0}.fs-chip button:hover{background:rgba(var(--ink, 255,255,255), 0.18)}',
      '.fs-q{display:flex;align-items:center;gap:8px;padding:0 11px;height:40px;color:var(--fs-mute)}.fs-q input{flex:1;min-width:0;height:100%;background:none;border:0;outline:0;color:var(--tx-0, #fff);font:inherit;font-size:13px}.fs-q input::placeholder{color:var(--tx-6, #5f6790)}',
      '.fs-res{max-height:220px;overflow-y:auto;border-top:1px solid var(--fs-line);padding:4px}',
      '.fs-opt{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border-radius:9px;border:0;background:none;color:var(--tx-1, #e6e9f5);font:inherit;text-align:left;cursor:pointer}',
      '.fs-opt:hover,.fs-opt.hi{background:rgba(var(--ink, 255,255,255), 0.06)}.fs-opt[aria-selected="true"]{background:rgba(255,107,6,.1)}',
      '.fs-av{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;flex-shrink:0;font-size:10.5px;font-weight:800;color:var(--tx-0, #fff);background:var(--c,#3b4266)}',
      '.fs-av.sq{border-radius:8px;background:rgba(var(--ink, 255,255,255), 0.06);color:var(--c,var(--tx-3, #aab1d1))}',
      '.fs-ot{flex:1;min-width:0}.fs-ot b{display:block;font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fs-ot small{display:block;font-size:11px;color:var(--fs-mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fs-opt .fs-tick{color:var(--fs-acc);opacity:0}.fs-opt[aria-selected="true"] .fs-tick{opacity:1}',
      '.fs-empty{padding:14px;text-align:center;color:var(--fs-dim);font-size:12px}',
      '.fs-ta{width:100%;min-height:68px;resize:vertical;padding:10px 12px;border-radius:12px;border:1px solid rgba(var(--ink, 255,255,255), 0.1);background:rgba(var(--ink, 255,255,255), 0.03);color:var(--tx-0, #fff);font:inherit;font-size:13px;line-height:1.45;outline:0}.fs-ta:focus{border-color:rgba(255,107,6,.55)}',
      '.fs-cnt{text-align:right;font-size:10.5px;color:var(--fs-dim);margin-top:3px}',
      '.fs-sw{display:flex;align-items:center;gap:11px;width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--fs-line);background:rgba(var(--ink, 255,255,255), 0.02);color:var(--tx-1, #e6e9f5);font:inherit;text-align:left;cursor:pointer}',
      '.fs-sw .fs-tg{width:34px;height:20px;border-radius:999px;background:rgba(var(--ink, 255,255,255), 0.12);position:relative;flex-shrink:0;transition:.15s}.fs-sw .fs-tg::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:.15s}',
      '.fs-sw[aria-checked="true"] .fs-tg{background:var(--fs-acc)}.fs-sw[aria-checked="true"] .fs-tg::after{left:16px}',
      '.fs-sw div{flex:1;min-width:0}.fs-sw b{display:block;font-size:12.5px}.fs-sw small{display:block;font-size:11px;color:var(--fs-mute)}',
      '.fs-btn{height:38px;padding:0 16px;border-radius:10px;border:1px solid rgba(var(--ink, 255,255,255), 0.12);background:rgba(var(--ink, 255,255,255), 0.04);color:var(--tx-1, #e6e9f5);font:inherit;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap;text-decoration:none}',
      '.fs-btn:hover{background:rgba(var(--ink, 255,255,255), 0.08)}.fs-btn.pri{background:linear-gradient(135deg,#ff6b06,#f9182f);border-color:transparent;color:#fff}.fs-btn.pri:disabled{opacity:.45;cursor:not-allowed}',
      '.fs-btn.sm{height:30px;padding:0 11px;font-size:11.5px;border-radius:8px}',
      // wide two-pane Send dialog
      '.fs-dlg.wide{width:min(1040px,100%);height:min(720px,calc(100vh - 32px))}',
      '.fs-split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(300px,370px) minmax(0,1fr);border-top:1px solid var(--fs-line)}',
      '.fs-side{padding:16px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:16px;border-right:1px solid var(--fs-line);background:rgba(var(--ink, 255,255,255), 0.012)}',
      '.fs-main{padding:16px 18px;display:flex;flex-direction:column;gap:10px;min-height:0;min-width:0}',
      '.fs-main .fs-lbl{margin-bottom:0}.fs-who{margin-left:auto;font-size:11px;font-weight:700;letter-spacing:0;text-transform:none;color:var(--fs-dim);padding:3px 9px;border-radius:999px;border:1px solid var(--fs-line)}.fs-who.on{color:var(--fg-orange, #ffcfa8);border-color:rgba(255,107,6,.4);background:rgba(255,107,6,.1)}',
      '.fs-seg.full{display:grid;grid-template-columns:repeat(3,1fr);width:100%;margin:0}.fs-seg.full button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px}',
      '.fs-main .fs-box{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.fs-main .fs-res{flex:1;max-height:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));align-content:start;gap:2px}.fs-res .fs-empty{grid-column:1/-1}',
      '.fs-q input,.fs-q input:focus,.fs-q input:focus-visible{border:0!important;outline:0!important;box-shadow:none!important;background:transparent!important;padding:0!important;height:100%!important;border-radius:0!important}',
      '.fs-work{display:flex;gap:12px;align-items:flex-start}.fs-tile{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;flex-shrink:0;background:linear-gradient(140deg,rgba(255,107,6,.22),rgba(249,24,47,.12));color:var(--fg-orange, #ffb27a);border:1px solid rgba(255,107,6,.3)}',
      '.fs-side .fs-ta{min-height:96px}.fs-side>*,.fs-main>.fs-lbl,.fs-main>.fs-seg{flex-shrink:0}',
      '.fs-grp{display:flex;flex-direction:column;gap:4px}.fs-grp+.fs-grp{margin-top:8px}.fs-grp .fs-fr{margin-left:14px;width:calc(100% - 14px)}',
      '.fs-gh{display:flex;align-items:center;gap:8px;width:100%;padding:4px 2px;border:0;background:none;color:var(--tx-1, #e6e9f5);font:inherit;text-align:left;cursor:pointer}.fs-gh b{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-orange, #ffcfa8)}.fs-gh span{font-size:12px;color:var(--fs-mute);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fs-gh em{margin-left:auto;font-style:normal;font-size:11px;color:var(--fs-dim)}',
      '[aria-checked="mixed"] .fs-cb,.fs-cb.mixed{background:rgba(255,107,6,.35);border-color:var(--fs-acc);color:var(--tx-0, #fff)}',
      '.fs-files.locked .fs-fr,.fs-files.locked .fs-gh{cursor:default}.fs-files.locked .fs-fr:hover{background:rgba(var(--ink, 255,255,255), 0.02)}.fs-fr:disabled,.fs-gh:disabled{opacity:1;color:var(--tx-1, #e6e9f5)}',
      '.fs-log{padding:10px 12px;border-radius:12px;border:1px solid rgba(52,211,153,.25);background:rgba(52,211,153,.06);font-size:12px;display:flex;flex-direction:column;gap:4px}.fs-log div{display:flex;gap:7px;align-items:flex-start;color:var(--tx-2, #cfe9dd)}.fs-log svg{color:var(--fg-emerald, #34d399);margin-top:2px;flex-shrink:0}',
      '.fs-done{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:40px 20px}.fs-done b{font-size:17px;color:var(--tx-0, #fff)}.fs-done span:not(.fs-tile){font-size:13px;color:var(--tx-2, #cfd4ea);max-width:520px}.fs-done small{font-size:12px;color:var(--fs-mute)}.fs-done .fs-tile{color:var(--fg-emerald, #34d399);background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.35)}',
      '.fs-ft{align-items:center}.fs-ftsum{margin-right:auto;font-size:12px;color:var(--fs-mute);min-width:0}.fs-ftsum b{color:var(--tx-1, #e6e9f5);font-weight:700}',
      // panel
      '.fs-sheet{position:fixed;inset:0;z-index:9150;background:rgba(var(--scrim, 3,5,9), calc(0.7 * var(--scrim-k, 1)));backdrop-filter:blur(4px);display:flex;justify-content:center;align-items:flex-start;padding:22px 16px;overflow:auto}',
      '.fs-pane{width:min(860px,100%);min-height:min(640px,calc(100vh - 44px));background:var(--fs-bg);border:1px solid rgba(var(--ink, 255,255,255), 0.08);border-radius:18px;padding:20px 22px;display:flex;flex-direction:column;gap:14px;box-shadow:0 30px 80px -20px rgba(var(--shade, 0,0,0), calc(0.85 * var(--shade-k, 1)))}',
      '.fs-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.fs-top h2{margin:0;font-size:20px;font-weight:800;color:var(--tx-0, #fff);flex:1}',
      '.fs-tabs{display:flex;gap:4px}.fs-tabs button{height:32px;padding:0 13px;border-radius:999px;border:1px solid transparent;background:none;color:var(--fs-mute);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
      '.fs-tabs button.on{color:var(--tx-0, #fff);background:rgba(255,107,6,.16);border-color:rgba(255,107,6,.4)}',
      '.fs-n{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:linear-gradient(135deg,#ff6b06,#f9182f);color:#fff;font-size:10px;font-weight:800;display:inline-grid;place-items:center}',
      '.fs-list{display:flex;flex-direction:column;gap:8px}',
      '.fs-card{border-radius:14px;border:1px solid var(--fs-line);background:var(--fs-card);overflow:hidden}.fs-card.new{border-color:rgba(255,107,6,.35)}',
      '.fs-row{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}.fs-row:hover{background:rgba(var(--ink, 255,255,255), 0.025)}',
      '.fs-rt{flex:1;min-width:0}.fs-rt b{display:block;font-size:14px;color:var(--tx-0, #fff);font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fs-rt small{display:block;font-size:11.5px;color:var(--fs-mute);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fs-pill{font-size:10px;font-weight:800;letter-spacing:.03em;padding:3px 8px;border-radius:999px;white-space:nowrap;border:1px solid;flex-shrink:0}',
      '.fs-pill.unread,.fs-pill.new{color:var(--fg-orange, #ffb27a);background:rgba(255,107,6,.12);border-color:rgba(255,107,6,.4)}.fs-pill.viewed{color:var(--fg-blue, #93c5fd);background:rgba(96,165,250,.1);border-color:rgba(96,165,250,.35)}.fs-pill.downloaded{color:var(--fg-emerald, #6ee7b7);background:rgba(52,211,153,.1);border-color:rgba(52,211,153,.35)}',
      '.fs-det{padding:0 14px 14px 54px;display:flex;flex-direction:column;gap:10px}',
      '.fs-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px 16px}.fs-kv div small{display:block;font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--fs-dim)}.fs-kv div span{font-size:12.5px;font-weight:600;color:var(--tx-1, #e6e9f5)}',
      '.fs-msg{padding:9px 11px;border-radius:10px;background:rgba(var(--ink, 255,255,255), 0.03);border:1px solid var(--fs-line);font-size:12.5px;color:var(--tx-2, #cfd4ea);line-height:1.5;white-space:pre-wrap;word-break:break-word}',
      '.fs-fl{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;border:1px solid var(--fs-line);background:rgba(var(--ink, 255,255,255), 0.02)}.fs-fl>svg{color:var(--fs-mute);flex-shrink:0}.fs-fl .fs-fn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600}',
      '.fs-fl .fs-a{display:flex;gap:6px;flex-shrink:0}',
      '.fs-rc{display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px dashed var(--fs-line)}.fs-rc:last-child{border-bottom:0}.fs-rc .fs-ot b{font-size:12.5px}',
      '.fs-sum{font-size:11.5px;color:var(--fs-mute)}',
      '.fs-blank{padding:50px 16px;text-align:center;color:var(--fs-mute);font-size:13px}.fs-blank b{display:block;color:var(--tx-0, #fff);font-size:15px;margin-bottom:4px}',
      // nav badge + toast
      '.fs-navb{margin-left:auto;min-width:18px;height:18px;border-radius:99px;background:linear-gradient(135deg,#ff6b06,#f9182f);color:#fff;font-size:9px;font-weight:800;display:none;align-items:center;justify-content:center;padding:0 5px}',
      '.fs-note{position:fixed;right:18px;bottom:18px;z-index:9500;display:flex;gap:12px;align-items:center;max-width:min(380px,calc(100vw - 24px));padding:12px 12px 12px 14px;border-radius:14px;background:linear-gradient(170deg,var(--sf-3, #161c30),var(--sf-2, #0d1120));border:1px solid rgba(var(--ink, 255,255,255), 0.1);box-shadow:0 20px 50px -12px rgba(var(--shade, 0,0,0), calc(0.8 * var(--shade-k, 1)));color:var(--tx-1, #e6e9f5);transform:translateY(12px);opacity:0;transition:.22s}',
      '.fs-note.on{transform:none;opacity:1}.fs-note b{display:block;font-size:13px;color:var(--tx-0, #fff)}.fs-note span{display:block;font-size:12px;color:var(--fs-mute);margin-top:2px}.fs-note .fs-ic{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(255,107,6,.14);color:var(--fg-orange, #ff9a4d);flex-shrink:0}',
      '@media(max-width:720px){',
      ' .fs-ov{place-items:end stretch;padding:0}.fs-dlg,.fs-dlg.wide{width:100%;height:auto;max-height:92vh;border-radius:20px 20px 0 0}',
      ' .fs-split{display:flex;flex-direction:column;overflow-y:auto;padding:14px 16px 6px;gap:16px}.fs-side{display:contents}.fs-main{padding:0;min-height:auto}',
      ' .o1{order:1}.o2{order:2}.o3{order:3}.o4{order:4}.o5{order:5}.fs-main .fs-res{max-height:240px;display:block}.fs-ftsum{display:none}',
      ' .fs-seg.full button{font-size:11.5px;padding:0 4px}.fs-ft{padding-bottom:calc(14px + env(safe-area-inset-bottom))}.fs-ft .fs-btn{flex:1}',
      ' .fs-sheet{padding:0}.fs-pane{border-radius:0;min-height:100vh;padding:14px 14px 24px;border:0}.fs-top h2{font-size:18px}.fs-tabs{order:3;width:100%}.fs-tabs button{flex:1;justify-content:center}',
      ' .fs-det{padding:0 12px 12px}.fs-fl{flex-wrap:wrap}.fs-fl .fs-fn{flex-basis:calc(100% - 30px)}.fs-fl .fs-a{width:100%}.fs-fl .fs-a .fs-btn{flex:1}',
      ' .fs-note{left:12px;right:12px;bottom:12px;max-width:none}',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function note(o) {
    css();
    var el = document.createElement('div'); el.className = 'fs-note fs'; el.setAttribute('role', 'status');
    el.innerHTML = '<span class="fs-ic">' + svg(IC.inbox, 17) + '</span><div style="flex:1;min-width:0"><b>' + esc(o.title) + '</b>' + (o.sub ? '<span>' + esc(o.sub) + '</span>' : '') + '</div>' + (o.onOpen ? '<button type="button" class="fs-btn sm pri">Open</button>' : '');
    document.body.appendChild(el);
    var gone = function () { el.classList.remove('on'); setTimeout(function () { el.remove(); }, 250); };
    if (o.onOpen) el.querySelector('button').onclick = function () { gone(); o.onOpen(); };
    setTimeout(function () { el.classList.add('on'); }, 10);
    setTimeout(gone, o.ms || 8000);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Send dialog
  // ════════════════════════════════════════════════════════════════════════
  function send(work) {
    css(); work = work || {};
    var files = (work.files || []).map(function (f, i) { return { index: i, name: f.name || ('File ' + (i + 1)), kind: f.kind || kindOf(f.name), group: f.group || '' }; });
    // Project sends: "Entire Project" (every approved file) or "Select Files" (any subset, by file
    // or by deliverable group). After a send the dialog offers "Send another set", so graphic
    // files can go to HR and the video to the Academic Head in one sitting.
    var isProj = !!work.project, groups = [];
    files.forEach(function (f) { if (f.group && groups.indexOf(f.group) < 0) groups.push(f.group); });
    var allIdx = files.map(function (f) { return f.index; });
    var st = { files: work.select ? work.select.slice() : allIdx.slice(), scope: isProj ? (work.select ? 'select' : 'all') : '', picked: [], mode: 'person', q: '', msg: '', fwd: false, busy: false, hi: 0, log: [], done: null };
    var isFwd = work.source && work.source.type === 'forward';
    var ov = document.createElement('div'); ov.className = 'fs-ov fs';
    ov.innerHTML = '<div class="fs-dlg wide" role="dialog" aria-modal="true" aria-label="' + (isFwd ? 'Forward file' : 'Send approved work') + '"></div>';
    document.body.appendChild(ov);
    var dlg = ov.firstChild, targets = null, terr = '';
    var close = function () { ov.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

    function byKey(k) { return (targets || []).filter(function (t) { return t.key === k; })[0]; }
    function count() { var set = {}; st.picked.forEach(function (k) { var t = byKey(k); (t ? t.ids : []).forEach(function (id) { set[id] = 1; }); }); return Object.keys(set).length; }
    function matches() {
      var q = st.q.trim().toLowerCase(), list = (targets || []).filter(function (t) { return t.kind === st.mode; });
      if (q) list = list.filter(function (t) { return (t.label + ' ' + t.sub).toLowerCase().indexOf(q) > -1; });
      return list.slice(0, 60);
    }
    function optHtml(t, i) {
      var on = st.picked.indexOf(t.key) > -1, c = DCOL[t.division] || '#5b6390';
      var av = t.kind === 'person' ? '<span class="fs-av" style="--c:' + c + '">' + esc(initials(t.label)) + '</span>' : '<span class="fs-av sq" style="--c:' + c + '">' + svg(t.kind === 'dept' ? IC.dept : IC.users, 14) + '</span>';
      return '<button type="button" class="fs-opt' + (i === st.hi ? ' hi' : '') + '" role="option" aria-selected="' + on + '" data-pick="' + esc(t.key) + '">' + av + '<span class="fs-ot"><b>' + esc(t.label) + '</b><small>' + esc(t.sub) + '</small></span><span class="fs-tick">' + svg(IC.check, 15) + '</span></button>';
    }
    function results() {
      if (!targets) return '<div class="fs-empty">' + (terr ? esc(terr) : 'Loading people and departments…') + '</div>';
      var m = matches(); if (st.hi >= m.length) st.hi = 0;
      return m.length ? m.map(optHtml).join('') : '<div class="fs-empty">No ' + (st.mode === 'person' ? 'people' : st.mode === 'dept' ? 'departments' : 'groups') + ' match “' + esc(st.q) + '”.</div>';
    }
    function chips() {
      return st.picked.map(function (k) { var t = byKey(k); if (!t) return ''; return '<span class="fs-chip"><span>' + esc(t.label) + '</span>' + (t.kind !== 'person' ? '<i>' + t.ids.length + '</i>' : '') + '<button type="button" data-unpick="' + esc(k) + '" aria-label="Remove ' + esc(t.label) + '">' + svg(IC.x, 10) + '</button></span>'; }).join('');
    }
    function footer() {
      var n = count(), ok = n > 0 && st.files.length > 0 && !st.busy;
      var nf = st.files.length;
      return '<span class="fs-ftsum">' + (n && nf ? 'Sending <b>' + nf + (nf === 1 ? ' file' : ' files') + '</b> to <b>' + n + (n === 1 ? ' person' : ' people') + '</b> · no re-upload' : nf ? 'Pick who should receive ' + (nf === 1 ? 'this file' : 'these files') : 'Select at least one file') + '</span>'
        + '<button type="button" class="fs-btn" data-cancel>Cancel</button><button type="button" class="fs-btn pri" data-go' + (ok ? '' : ' disabled') + '>' + svg(IC.send, 14) + (st.busy ? 'Sending…' : n ? 'Send to ' + n + (n === 1 ? ' person' : ' people') : 'Send') + '</button>';
    }
    function fileRow(f) { var on = st.files.indexOf(f.index) > -1; return '<button type="button" class="fs-fr" role="checkbox" aria-checked="' + on + '" data-file="' + f.index + '"' + (st.scope === 'all' ? ' disabled' : '') + '><span class="fs-cb">' + svg(IC.check, 12) + '</span>' + kindIcon(f.kind) + '<span class="fs-fn">' + esc(f.name) + '</span></button>'; }
    function fileRows() {
      if (!groups.length) return files.map(fileRow).join('');
      return groups.map(function (g) {
        var mine = files.filter(function (f) { return f.group === g; }), n = mine.filter(function (f) { return st.files.indexOf(f.index) > -1; }).length;
        var state = n === mine.length ? 'true' : n ? 'mixed' : 'false', parts = g.split(' · ');
        return '<div class="fs-grp"><button type="button" class="fs-gh" role="checkbox" aria-checked="' + state + '" data-grp="' + esc(g) + '"' + (st.scope === 'all' ? ' disabled' : '') + '><span class="fs-cb' + (state === 'mixed' ? ' mixed' : '') + '">' + svg(state === 'mixed' ? '<path d="M6 12h12"/>' : IC.check, 12) + '</span><b>' + esc(parts[0]) + '</b>' + (parts[1] ? '<span>' + esc(parts.slice(1).join(' · ')) + '</span>' : '') + '<em>' + n + '/' + mine.length + '</em></button>'
          + mine.map(fileRow).join('') + '</div>';
      }).join('');
    }
    function scopeSeg() {
      if (!isProj) return '';
      return '<div class="fs-seg full o2" style="margin-bottom:0"><button type="button" data-scope="all"' + (st.scope === 'all' ? ' class="on"' : '') + '>Entire Project</button><button type="button" data-scope="select"' + (st.scope === 'select' ? ' class="on"' : '') + '>Select Files</button></div>';
    }
    function logHtml() {
      if (!st.log.length) return '';
      return '<div class="fs-log o2"><div class="fs-lbl" style="margin-bottom:5px">Sent in this window</div>' + st.log.map(function (l) { return '<div>' + svg(IC.check, 12) + '<span><b>' + l.files + (l.files === 1 ? ' file' : ' files') + '</b> → ' + esc(l.to) + '</span></div>'; }).join('') + '</div>';
    }
    function doneView() {
      var l = st.done;
      dlg.querySelector('.fs-split').innerHTML = '<div class="fs-done"><span class="fs-tile" style="width:54px;height:54px">' + svg(IC.check, 24) + '</span><b>Sent ' + l.files + (l.files === 1 ? ' file' : ' files') + ' to ' + l.n + (l.n === 1 ? ' person' : ' people') + '</b><span>' + esc(l.to) + '</span><small>Nothing was uploaded again — they get access to the approved files.</small></div>';
      dlg.querySelector('[data-ft]').innerHTML = '<span class="fs-ftsum">Want different files to go to someone else?</span><button type="button" class="fs-btn" data-cancel>Done</button><button type="button" class="fs-btn pri" data-again>' + svg(IC.send, 14) + 'Send another set</button>';
    }
    function draw() {
      var all = st.files.length === files.length, k0 = (files[0] && files[0].kind) || 'file';
      // Desktop: two panes — WHAT is sent (left) and WHO gets it (right, full height). Phone: one column.
      dlg.innerHTML = '<div class="fs-hd"><h3>' + (isFwd ? 'Forward File' : isProj ? 'Send Project' : 'Send Approved Work') + '</h3><button type="button" class="fs-x" data-cancel aria-label="Close">' + svg(IC.x, 15) + '</button></div>'
        + '<div class="fs-split"><div class="fs-side">'
        + '<div class="fs-work o1"><span class="fs-tile">' + kindIcon(k0) + '</span><div style="min-width:0"><b>' + esc(work.title || 'Untitled') + '</b><div class="fs-meta">' + (work.type ? '<span>Type <b>' + esc(work.type) + '</b></span>' : '') + (work.approved_at ? '<span>Approved <b>' + esc(fDate(work.approved_at)) + '</b></span>' : '') + (isFwd && work.from ? '<span>From <b>' + esc(work.from) + '</b></span>' : '') + '</div></div></div>'
        + scopeSeg()
        + '<div class="o2"><div class="fs-lbl">' + (st.scope === 'all' ? 'Entire project · ' + files.length + (files.length === 1 ? ' file' : ' files') : 'Files · ' + st.files.length + ' of ' + files.length + (files.length > 1 ? '<button type="button" class="fs-link" data-all>' + (all ? 'Clear all' : 'Select all') + '</button>' : '')) + '</div><div class="fs-files' + (st.scope === 'all' ? ' locked' : '') + '" role="group" aria-label="Files to send">' + fileRows() + '</div></div>'
        + logHtml()
        + '<div class="o4"><div class="fs-lbl">Message <span style="font-weight:600;letter-spacing:0;text-transform:none">(optional)</span></div><textarea class="fs-ta" data-msg maxlength="600" placeholder="e.g. Final approved video for tomorrow’s student session.">' + esc(st.msg) + '</textarea><div class="fs-cnt" data-cnt>' + st.msg.length + ' / 600</div></div>'
        + '<button type="button" class="fs-sw o5" role="switch" aria-checked="' + st.fwd + '" data-fwd><span class="fs-tg"></span><div><b>Allow recipients to forward</b><small>Off: only the people you pick can open these files.</small></div></button>'
        + '</div><div class="fs-main o3">'
        + '<div class="fs-lbl">Recipients<span class="fs-who" data-who>' + whoText() + '</span></div>'
        + '<div class="fs-seg full" role="tablist"><button type="button" data-mode="person"' + (st.mode === 'person' ? ' class="on"' : '') + '>' + svg(IC.users, 13) + 'Individual</button><button type="button" data-mode="dept"' + (st.mode === 'dept' ? ' class="on"' : '') + '>' + svg(IC.dept, 13) + 'Department</button><button type="button" data-mode="role"' + (st.mode === 'role' ? ' class="on"' : '') + '>' + svg(IC.users, 13) + 'Role / Group</button></div>'
        + '<div class="fs-box"><div class="fs-chips" data-chips>' + chips() + '</div><label class="fs-q">' + svg(IC.search, 15) + '<input type="text" data-q placeholder="' + (st.mode === 'person' ? 'Search name, department, designation, role…' : st.mode === 'dept' ? 'Search departments or heads…' : 'Search role groups…') + '" value="' + esc(st.q) + '" autocomplete="off" aria-label="Search recipients"></label>'
        + '<div class="fs-res" role="listbox" aria-multiselectable="true" data-res>' + results() + '</div></div>'
        + '</div></div><div class="fs-ft" data-ft>' + footer() + '</div>';
    }
    function whoText() { var n = count(); return n ? n + (n === 1 ? ' person' : ' people') : 'No one selected'; }
    function redrawPicker() { var r = dlg.querySelector('[data-res]'); if (r) r.innerHTML = results(); var c = dlg.querySelector('[data-chips]'); if (c) c.innerHTML = chips(); var w = dlg.querySelector('[data-who]'); if (w) { w.textContent = whoText(); w.classList.toggle('on', count() > 0); } dlg.querySelector('[data-ft]').innerHTML = footer(); }
    function toggle(k) { var i = st.picked.indexOf(k); if (i > -1) st.picked.splice(i, 1); else st.picked.push(k); redrawPicker(); }
    dlg.addEventListener('click', async function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-cancel')) return close();
      if (b.hasAttribute('data-scope')) { st.scope = b.getAttribute('data-scope'); st.files = st.scope === 'all' ? allIdx.slice() : []; return draw(); }
      if (b.hasAttribute('data-grp')) { var gi = files.filter(function (f) { return f.group === b.getAttribute('data-grp'); }).map(function (f) { return f.index; }), allOn = gi.every(function (x) { return st.files.indexOf(x) > -1; });
        st.files = st.files.filter(function (x) { return gi.indexOf(x) < 0; }); if (!allOn) st.files = st.files.concat(gi); return draw(); }
      if (b.hasAttribute('data-again')) { st.done = null; st.picked = []; st.msg = ''; st.fwd = false; st.q = ''; if (isProj) { st.scope = 'select'; st.files = []; } return draw(); }
      if (b.hasAttribute('data-file')) { var ix = +b.getAttribute('data-file'), p = st.files.indexOf(ix); if (p > -1) st.files.splice(p, 1); else st.files.push(ix); return draw(); }
      if (b.hasAttribute('data-all')) { st.files = st.files.length === files.length ? [] : files.map(function (f) { return f.index; }); return draw(); }
      if (b.hasAttribute('data-mode')) { st.mode = b.getAttribute('data-mode'); st.q = ''; st.hi = 0; draw(); var qi = dlg.querySelector('[data-q]'); if (qi && !isMobile()) qi.focus(); return; }
      if (b.hasAttribute('data-pick')) return toggle(b.getAttribute('data-pick'));
      if (b.hasAttribute('data-unpick')) return toggle(b.getAttribute('data-unpick'));
      if (b.hasAttribute('data-fwd')) { st.fwd = !st.fwd; b.setAttribute('aria-checked', st.fwd); return; }
      if (b.hasAttribute('data-go')) {
        if (st.busy) return; st.busy = true; redrawPicker();
        try {
          var j = await api('send', { source: work.source, files: st.files.slice().sort(function (a, c) { return a - c; }), targets: st.picked, message: st.msg.trim(), forward_allowed: st.fwd });
          if (S.panel && S.tab === 'sent') renderPanel();
          if (isProj) {   // stay open: confirm, and allow another set to other people
            var to = st.picked.map(function (k) { var t = byKey(k); return t ? t.label : ''; }).filter(Boolean).join(', ');
            st.log.push({ files: j.files, to: to }); st.done = { files: j.files, n: j.recipients, to: to }; st.busy = false;
            return doneView();
          }
          close();
          toast('success', 'Sent “' + (work.title || 'file') + '” to ' + j.recipients + (j.recipients === 1 ? ' person' : ' people'));
        } catch (err) { st.busy = false; redrawPicker(); toast('error', err.message); }
      }
    });
    dlg.addEventListener('input', function (e) {
      if (e.target.hasAttribute('data-q')) { st.q = e.target.value; st.hi = 0; var r = dlg.querySelector('[data-res]'); if (r) r.innerHTML = results(); }
      if (e.target.hasAttribute('data-msg')) { st.msg = e.target.value; var c = dlg.querySelector('[data-cnt]'); if (c) c.textContent = st.msg.length + ' / 600'; }
    });
    dlg.addEventListener('keydown', function (e) {   // keyboard: ↑/↓ move, Enter picks, Backspace on empty removes last chip
      if (!e.target.hasAttribute('data-q')) return;
      var m = targets ? matches() : [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!m.length) return; st.hi = (st.hi + (e.key === 'ArrowDown' ? 1 : -1) + m.length) % m.length; var r = dlg.querySelector('[data-res]'); r.innerHTML = results(); var h = r.querySelector('.hi'); if (h) h.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); if (m[st.hi]) toggle(m[st.hi].key); }
      else if (e.key === 'Backspace' && !e.target.value && st.picked.length) { st.picked.pop(); redrawPicker(); }
    });
    draw();
    loadTargets().then(function (t) { targets = t; redrawPicker(); }, function (err) { terr = err.message; redrawPicker(); });
    setTimeout(function () { var qi = dlg.querySelector('[data-q]'); if (qi && !isMobile()) qi.focus(); }, 60);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Files panel — Received (Shared with me) + Sent (status history)
  // ════════════════════════════════════════════════════════════════════════
  function open(tab) {
    css(); if (tab) S.tab = tab;
    if (S.panel && S.panel.isConnected) return renderPanel();
    var sh = document.createElement('div'); sh.className = 'fs-sheet fs';
    sh.innerHTML = '<div class="fs-pane" role="dialog" aria-modal="true" aria-label="Received files"></div>';
    document.body.appendChild(sh); S.panel = sh;
    var key = function (e) { if (e.key === 'Escape' && !document.querySelector('.fs-ov')) close(); };
    var close = function () { sh.remove(); S.panel = null; S.openRid = null; document.removeEventListener('keydown', key); };
    S.closePanel = close;
    document.addEventListener('keydown', key);
    sh.addEventListener('mousedown', function (e) { if (e.target === sh) close(); });
    sh.addEventListener('click', onPanelClick);
    renderPanel();
  }
  function statusPill(r) { return r.downloaded_at ? '<span class="fs-pill downloaded">Downloaded</span>' : r.viewed_at ? '<span class="fs-pill viewed">Viewed</span>' : '<span class="fs-pill new">New</span>'; }
  async function renderPanel() {
    var sh = S.panel; if (!sh) return;
    var pane = sh.firstChild;
    var head = '<div class="fs-top"><h2>Files</h2><div class="fs-tabs" role="tablist"><button type="button" data-tab="received"' + (S.tab === 'received' ? ' class="on"' : '') + '>' + svg(IC.inbox, 14) + 'Received <span class="fs-n" data-fs-tabcount' + (S.unread ? '' : ' style="display:none"') + '>' + S.unread + '</span></button><button type="button" data-tab="sent"' + (S.tab === 'sent' ? ' class="on"' : '') + '>' + svg(IC.send, 13) + 'Sent</button></div><button type="button" class="fs-x" data-close aria-label="Close">' + svg(IC.x, 15) + '</button></div>';
    pane.innerHTML = head + '<div class="fs-blank">Loading…</div>';
    try {
      if (S.tab === 'received') {
        var items = await loadInbox();
        if (S.panel !== sh) return;
        pane.innerHTML = head + (items.length ? '<div class="fs-list">' + items.map(receivedCard).join('') + '</div>' : '<div class="fs-blank"><b>Nothing shared with you yet</b>Files people send you from the ERP will appear here.</div>');
        if (S.openRid) { var still = items.filter(function (i) { return i.rid === S.openRid; })[0]; if (still) expand(still, true); }
      } else {
        var j = await api('sent');
        if (S.panel !== sh) return;
        pane.innerHTML = head + ((j.items || []).length ? '<div class="fs-list">' + j.items.map(sentCard).join('') + '</div>' : '<div class="fs-blank"><b>You haven’t sent anything yet</b>Use <b style="display:inline;font-size:13px">Send</b> on an approved work to share it with people or departments.</div>');
      }
    } catch (err) { if (S.panel === sh) pane.innerHTML = head + '<div class="fs-blank"><b>Couldn’t load files</b>' + esc(err.message) + '</div>'; }
  }
  function receivedCard(i) {
    var c = '#3b4266';
    return '<div class="fs-card' + (i.viewed_at ? '' : ' new') + '" data-card="' + esc(i.rid) + '">'
      + '<button type="button" class="fs-row" data-rid="' + esc(i.rid) + '" aria-expanded="' + (S.openRid === i.rid) + '"><span class="fs-av" style="--c:' + c + '">' + esc(initials(i.from.name)) + '</span>'
      + '<span class="fs-rt"><b>' + esc(i.title) + '</b><small>' + esc(i.from.name) + ' · ' + esc(fDate(i.sent_at, true)) + ' · ' + i.files.length + (i.files.length === 1 ? ' file' : ' files') + '</small></span>' + statusPill(i) + '</button>'
      + '<div data-det></div></div>';
  }
  function sentCard(s) {
    var v = s.recipients.filter(function (r) { return r.status !== 'unread'; }).length;
    return '<div class="fs-card"><div class="fs-row" style="cursor:default"><span class="fs-av sq" style="--c:#ff9a4d">' + svg(IC.send, 14) + '</span><span class="fs-rt"><b>' + esc(s.title) + '</b><small>' + esc(fDate(s.sent_at, true)) + ' · ' + s.files.length + (s.files.length === 1 ? ' file' : ' files') + (s.forwarded ? ' · forwarded' : '') + '</small></span><span class="fs-sum">' + v + ' of ' + s.recipients.length + ' opened</span></div>'
      + '<div class="fs-det">' + (s.message ? '<div class="fs-msg">' + esc(s.message) + '</div>' : '')
      + '<div>' + s.recipients.map(function (r) { return '<div class="fs-rc"><span class="fs-av" style="--c:#3b4266">' + esc(initials(r.name)) + '</span><span class="fs-ot"><b>' + esc(r.name) + '</b><small>' + esc(r.role || '') + (r.at ? ' · ' + esc(fDate(r.at, true)) : '') + '</small></span><span class="fs-pill ' + r.status + '">' + (r.status === 'downloaded' ? 'Downloaded' : r.status === 'viewed' ? 'Viewed' : 'Unread') + '</span></div>'; }).join('') + '</div></div></div>';
  }
  async function expand(i, keep) {
    var card = S.panel && S.panel.querySelector('[data-card="' + i.rid + '"]'); if (!card) return;
    var det = card.querySelector('[data-det]'), row = card.querySelector('.fs-row');
    if (!keep && S.openRid === i.rid && det.innerHTML) { det.innerHTML = ''; S.openRid = null; row.setAttribute('aria-expanded', 'false'); return; }
    S.openRid = i.rid; row.setAttribute('aria-expanded', 'true');
    det.innerHTML = '<div class="fs-det"><div class="fs-sum">Opening…</div></div>';
    var wasNew = !i.viewed_at;
    try {
      var j = S.opened[i.rid] && keep ? S.opened[i.rid] : await api('open', { rid: i.rid });
      S.opened[i.rid] = j;
      if (wasNew) { i.viewed_at = j.viewed_at || new Date().toISOString(); card.classList.remove('new'); var pl = row.querySelector('.fs-pill'); if (pl) pl.outerHTML = statusPill(i); setUnread(Math.max(0, S.unread - 1)); }
      det.innerHTML = '<div class="fs-det">'
        + '<div class="fs-kv"><div><small>From</small><span>' + esc(i.from.name) + '</span></div><div><small>Department</small><span>' + esc(i.from.department || '—') + '</span></div><div><small>Sent</small><span>' + esc(fDate(i.sent_at, true)) + '</span></div>' + (i.item_type ? '<div><small>Type</small><span>' + esc(i.item_type) + '</span></div>' : '') + '</div>'
        + (i.message ? '<div class="fs-msg">' + esc(i.message) + '</div>' : '')
        + '<div style="display:flex;flex-direction:column;gap:6px">' + j.files.map(function (f, k) {
          var gh = f.group && (k === 0 || j.files[k - 1].group !== f.group) ? '<div class="fs-lbl" style="margin:' + (k ? '6px' : '0') + ' 0 0">' + esc(f.group) + '</div>' : '';
          return gh + '<div class="fs-fl">' + kindIcon(f.kind) + '<span class="fs-fn" title="' + esc(f.name) + '">' + esc(f.name) + '</span><span class="fs-a"><a class="fs-btn sm" href="' + esc(f.view) + '" target="_blank" rel="noopener noreferrer">' + svg(IC.eye, 13) + 'View</a>'
            + '<button type="button" class="fs-btn sm" data-dl="' + f.index + '" data-r="' + esc(i.rid) + '">' + svg(IC.dl, 13) + (f.downloadable ? 'Download' : 'Open') + '</button></span></div>'; }).join('') + '</div>'
        + (i.forward_allowed ? '<div><button type="button" class="fs-btn sm" data-fwd-rid="' + esc(i.rid) + '">' + svg(IC.fwd, 13) + 'Forward</button></div>' : '')
        + '</div>';
    } catch (err) { det.innerHTML = '<div class="fs-det"><div class="fs-sum" style="color:var(--fg-red, #fca5a5)">' + esc(err.message) + '</div></div>'; }
  }
  async function onPanelClick(e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-close')) return S.closePanel && S.closePanel();
    if (b.hasAttribute('data-tab')) { S.tab = b.getAttribute('data-tab'); S.openRid = null; return renderPanel(); }
    if (b.hasAttribute('data-rid')) { var it = (S.inbox || []).filter(function (x) { return x.rid === b.getAttribute('data-rid'); })[0]; if (it) expand(it); return; }
    if (b.hasAttribute('data-dl')) {
      var rid = b.getAttribute('data-r'), w = window.open('', '_blank');   // opened in the click → never popup-blocked
      try {
        var j = await api('file', { rid: rid, index: +b.getAttribute('data-dl') });
        if (w) { try { w.opener = null; } catch (_) {} w.location.href = j.href; } else location.href = j.href;
        var item = (S.inbox || []).filter(function (x) { return x.rid === rid; })[0];
        if (item && !item.downloaded_at) { item.downloaded_at = new Date().toISOString(); var row = S.panel && S.panel.querySelector('[data-rid="' + rid + '"] .fs-pill'); if (row) row.outerHTML = statusPill(item); }
      } catch (err) { if (w) w.close(); toast('error', err.message); }
      return;
    }
    if (b.hasAttribute('data-fwd-rid')) {
      var f = (S.inbox || []).filter(function (x) { return x.rid === b.getAttribute('data-fwd-rid'); })[0]; if (!f) return;
      send({ source: { type: 'forward', rid: f.rid }, title: f.title, type: f.item_type, approved_at: f.approved_at, from: f.from.name, files: f.files });
    }
  }
  function openRid(rid) { S.tab = 'received'; S.openRid = rid; open('received'); }
  function openFromLink(link) { var m = String(link || '').match(/^share:([0-9a-f-]{36})$/i); if (!m) return false; openRid(m[1]); return true; }

  // ════════════════════════════════════════════════════════════════════════
  // Boot: nav entry + unread badge + live arrivals (every portal)
  // ════════════════════════════════════════════════════════════════════════
  function addNav() {
    var links = document.querySelectorAll('#nav-acad-announcements, #nav-announcements, #hrtree-announcements, .sidebar-link[data-tab="announcements"], .sidebar-link[onclick*="\'announcements\'"], [data-sec="announcements"]');
    Array.prototype.forEach.call(links, function (a) {
      if (a._fsNav) return; a._fsNav = true;
      var b = document.createElement(a.tagName === 'A' ? 'a' : 'button'); if (b.tagName === 'BUTTON') b.type = 'button';
      b.className = String(a.className).replace(/\b(active|on|hidden)\b/g, '') + ' fs-nav';
      b.setAttribute('style', (a.getAttribute('style') || '') + ';display:flex;align-items:center;gap:11px');
      b.innerHTML = svg(IC.inbox, 14) + ' <span class="be-nav-label">Received Files</span><span class="fs-navb" data-fs-badge></span>';
      b.onclick = function (e) { e.preventDefault(); try { if (typeof closeMobileSidebar === 'function') closeMobileSidebar(); } catch (_) {} open('received'); };
      a.insertAdjacentElement('afterend', b);
    });
    setUnread(S.unread);
  }
  async function boot() {
    S.email = String(B().currentEmail() || '').toLowerCase();
    css(); addNav(); setTimeout(addNav, 2500);
    try { await loadInbox(); } catch (_) {}
    // Deep links: ?share=<rid> or #received-files
    try { var q = new URLSearchParams(location.search); if (q.get('share')) openRid(q.get('share')); else if (location.hash === '#received-files') open('received'); } catch (_) {}
    if (!window.BELive || !S.email) return;
    BELive.on('be-share-in', [{ table: 'erp_notifications', filter: 'recipient_email=eq.' + S.email, event: 'INSERT' }], function (evs) {
      var got = false;
      (evs || []).forEach(function (p) {
        var n = p && p.new; if (!n || n.type !== 'file_shared') return; got = true;
        var rid = String(n.link || '').replace(/^share:/, '');
        note({ title: 'New File Shared', sub: n.message, onOpen: function () { openRid(rid); } });
      });
      if (got) { setUnread(S.unread + 1); loadInbox().then(function () { if (S.panel && S.tab === 'received') renderPanel(); }, function () {}); }
    }, { debounce: 0 });
  }

  window.BEShare = { send: send, open: open, openFromLink: openFromLink, refresh: loadInbox, unread: function () { return S.unread; } };
  var embedded = /[?&]embed=1\b/.test(location.search) || window.self !== window.top;
  if (!embedded) { var tries = 0; (function w() { if (B().currentEmail && B().currentEmail()) return boot(); if (++tries < 60) setTimeout(w, 2000); })(); }
})();
