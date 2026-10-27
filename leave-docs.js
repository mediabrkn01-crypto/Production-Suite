/* ════════════════════════════════════════════════════════════════════════════
   BELeaveDocs — supporting documents for leave requests (medical certificate, prescription,
   hospital papers, emergency proof). One module for the employee form (every portal) and HR.

   Storage: PRIVATE Supabase bucket `leave-docs` (20261106). The `leave-docs` edge function
   (ERP session) issues a one-time signed upload URL; the browser uploads straight to it with
   real progress (XHR). Viewing / downloading uses a 2-minute signed URL that the function only
   gives to the employee, HR and leadership. Nothing ever gets a public URL.
   Choose from Drive: Google Picker (drive.file scope) → the picked file is copied into the same
   private storage, so HR never needs access to the employee's Drive. Needs a Google OAuth
   client + API key: window.BE_GOOGLE = { clientId, apiKey, appId } (see setup note in README).

   BELeaveDocs.picker(el, {onChange})  → { files(), busy(), failed(), clear() }
   BELeaveDocs.chip(request)           → small "📎 N documents" button html (data-ld-open)
   BELeaveDocs.open(request)           → viewer: Preview · Open · Download per document
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.BELeaveDocs) return;
  var MAX = 20 * 1024 * 1024;
  var PHOTO = /\.(jpe?g|png|heic|heif|webp)$/i, DOC = /\.(pdf|docx?)$/i;
  var MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function B() { return window.BESession || {}; }
  function toast(k, m) { if (typeof window.showToast === 'function') { try { return window.showToast(k, m); } catch (_) {} } if (typeof window.hrShowToast === 'function') return window.hrShowToast(m, k); alert(m); }
  function ext(n) { return (String(n).toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1] || ''; }
  function size(n) { n = Number(n || 0); return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function isImg(n) { return /\.(jpe?g|png|webp|heic|heif)$/i.test(n); }
  function svg(d, s) { return '<svg width="' + (s || 15) + '" height="' + (s || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var IC = {
    cam: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    drive: '<path d="M8 3h8l6 10-4 7H6l-4-7z"/><path d="m8 3 8 14M16 3 8 17M2 13h20"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>', ok: '<path d="m5 12 5 5 9-10"/>', eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>', ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'
  };

  async function api(action, body) {
    var tk = B().ensure ? await B().ensure() : (B().token ? B().token() : null);
    if (!tk) throw new Error('Your session has expired. Please sign in again.');
    var r = await fetch(B().url + '/functions/v1/leave-docs', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': B().anonKey, 'Authorization': 'Bearer ' + B().anonKey, 'x-erp-session': tk },
      body: JSON.stringify(Object.assign({ action: action }, body || {})) });
    var j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && !(body && body._retry) && B().clear && B().ensure && j.code === 'SESSION_EXPIRED') {
      try { B().clear(B().currentEmail()); } catch (_) {}
      if (await B().ensure()) return api(action, Object.assign({}, body || {}, { _retry: true }));
    }
    if (!r.ok) throw new Error(j.error || 'Documents are unavailable right now.');
    return j;
  }

  function css() {
    if (document.getElementById('beld-css')) return;
    var s = document.createElement('style'); s.id = 'beld-css';
    s.textContent = [
      '.ld{display:flex;flex-direction:column;gap:8px;text-transform:none;letter-spacing:normal;font-weight:500;font-size:13px;color:var(--tx-1, #e6e9f5)}',
      '.ld-zone{position:relative;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px;border-radius:14px;border:1.5px dashed rgba(var(--ink, 255,255,255), 0.12);background:rgba(var(--ink, 255,255,255), 0.02);transition:border-color .15s,background .15s}',
      '.ld-zone.drag{border-color:rgba(255,138,61,.7);background:rgba(255,107,6,.07)}.ld-zone.req{border-color:rgba(251,191,36,.35)}',
      '.ld-zi{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;flex-shrink:0;color:var(--fg-orange, #ff9a4d);background:linear-gradient(140deg,rgba(255,107,6,.18),rgba(249,24,47,.08));border:1px solid rgba(255,138,61,.25)}',
      '.ld-zt{flex:1;min-width:200px}.ld-zt b{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:var(--tx-0, #fff)}.ld-zt small{display:block;font-size:11.5px;color:var(--tx-4, #8b93b8);margin-top:3px;line-height:1.45}',
      '.ld-badge{font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:999px;border:1px solid rgba(var(--ink, 255,255,255), 0.12);color:var(--tx-4, #8b93b8)}.ld-badge.req{color:var(--fg-amber, #fbbf24);border-color:rgba(251,191,36,.45);background:rgba(251,191,36,.1)}',
      '.ld-sub{display:none}',
      '.ld-acts{display:flex;flex-wrap:wrap;gap:6px;width:100%}',
      '.ld-btn{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 13px;text-transform:none;letter-spacing:normal;border-radius:10px;border:1px solid rgba(var(--ink, 255,255,255), 0.1);background:rgba(var(--ink, 255,255,255), 0.03);color:var(--tx-1, #e6e9f5);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap}',
      '.ld-btn:hover{background:rgba(var(--ink, 255,255,255), 0.07);border-color:rgba(255,138,61,.35)}.ld-btn svg{color:var(--fg-orange, #ff9a4d)}.ld-btn:focus-visible{outline:2px solid rgba(255,138,61,.6);outline-offset:2px}',
      '.ld-list{display:flex;flex-direction:column;gap:6px}.ld-list:empty{display:none}',
      '.ld-row{display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:11px;border:1px solid rgba(var(--ink, 255,255,255), 0.07);background:rgba(var(--ink, 255,255,255), 0.02);min-width:0}',
      '.ld-row.bad{border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.05)}',
      '.ld-th{width:38px;height:38px;border-radius:8px;flex-shrink:0;display:grid;place-items:center;background:rgba(var(--ink, 255,255,255), 0.05);color:var(--tx-3, #a5adcf);overflow:hidden}.ld-th img{width:100%;height:100%;object-fit:cover}',
      '.ld-th.pdf{color:var(--fg-red, #f87171);background:rgba(248,113,113,.1)}.ld-th.doc{color:var(--fg-blue, #60a5fa);background:rgba(96,165,250,.1)}',
      '.ld-mid{flex:1;min-width:0}.ld-mid b{display:block;font-size:12.5px;font-weight:600;color:var(--tx-1, #e6e9f5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ld-mid small{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--tx-4, #8b93b8);margin-top:2px}.ld-mid small .ok{color:var(--fg-emerald, #34d399);display:inline-flex;align-items:center;gap:3px;font-weight:700}.ld-mid small .err{color:var(--fg-red, #fca5a5);font-weight:600}',
      '.ld-bar{height:4px;border-radius:4px;background:rgba(var(--ink, 255,255,255), 0.08);overflow:hidden;margin-top:5px}.ld-bar i{display:block;height:100%;background:linear-gradient(90deg,#ff6b06,#f9182f);transition:width .15s}',
      '.ld-x{width:28px;height:28px;flex-shrink:0;border-radius:8px;border:1px solid rgba(var(--ink, 255,255,255), 0.08);background:none;color:var(--tx-4, #8b93b8);display:grid;place-items:center;cursor:pointer}.ld-x:hover{color:var(--fg-red, #fca5a5);border-color:rgba(248,113,113,.4)}',
      '.ld-mini{height:26px;padding:0 9px;border-radius:7px;border:1px solid rgba(var(--ink, 255,255,255), 0.1);background:rgba(var(--ink, 255,255,255), 0.04);color:var(--tx-1, #e6e9f5);font:inherit;font-size:11px;font-weight:700;cursor:pointer}',
      '.ld-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;border:1px solid rgba(96,165,250,.35);background:rgba(96,165,250,.1);color:var(--fg-blue, #93c5fd);font:inherit;font-size:11px;font-weight:700;cursor:pointer}',
      '.ld-chip:hover{background:rgba(96,165,250,.18);color:var(--tx-0, #fff)}',
      /* viewer */
      '.ld-ov{position:fixed;inset:0;z-index:9500;display:grid;place-items:center;padding:16px;background:rgba(var(--scrim, 3,5,9), calc(0.7 * var(--scrim-k, 1)));backdrop-filter:blur(3px)}',
      '.ld-dlg{width:min(860px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:linear-gradient(170deg,var(--sf-3, #141a2c),var(--sf-2, #0c0f1c));border:1px solid rgba(var(--ink, 255,255,255), 0.09);border-radius:18px;box-shadow:0 30px 80px -20px rgba(var(--shade, 0,0,0), calc(0.85 * var(--shade-k, 1)));color:var(--tx-1, #e6e9f5);font-family:inherit;overflow:hidden}',
      '.ld-hd{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(var(--ink, 255,255,255), 0.07)}.ld-hd b{flex:1;font-size:15px;color:var(--tx-0, #fff)}.ld-hd small{display:block;font-size:11.5px;color:var(--tx-4, #8b93b8);font-weight:500;margin-top:2px}',
      '.ld-body{display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);min-height:0;flex:1}',
      '.ld-side{border-right:1px solid rgba(var(--ink, 255,255,255), 0.07);padding:10px;overflow-y:auto;display:flex;flex-direction:column;gap:6px}',
      '.ld-side .ld-row{cursor:pointer}.ld-side .ld-row.on{border-color:rgba(255,138,61,.5);background:rgba(255,107,6,.08)}',
      '.ld-pane{display:flex;flex-direction:column;min-height:360px;min-width:0}',
      '.ld-view{flex:1;display:grid;place-items:center;padding:12px;min-height:320px;background:rgba(var(--well, 0,0,0), calc(0.25 * var(--well-k, 1)))}.ld-view img{max-width:100%;max-height:62vh;border-radius:10px}.ld-view iframe{width:100%;height:62vh;border:0;border-radius:10px;background:#fff}',
      '.ld-view .ld-msg{color:var(--tx-4, #8b93b8);font-size:13px;text-align:center;line-height:1.6}',
      '.ld-pacts{display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:1px solid rgba(var(--ink, 255,255,255), 0.07);flex-wrap:wrap}',
      '@media(min-width:721px){.ld-acts{width:auto}}',
      '@media(max-width:720px){.ld-btn{flex:1;justify-content:center}.ld-zt{min-width:0}.ld-ov{padding:0;place-items:end stretch}.ld-dlg{width:100%;max-height:94vh;border-radius:18px 18px 0 0}.ld-body{grid-template-columns:1fr}.ld-side{border-right:0;border-bottom:1px solid rgba(var(--ink, 255,255,255), 0.07);max-height:180px}.ld-view{min-height:240px}.ld-view iframe{height:50vh}}'
    ].join('\n');
    document.head.appendChild(s);
  }
  function thumbHTML(f) {
    if (f.preview) return '<span class="ld-th"><img src="' + esc(f.preview) + '" alt=""></span>';
    var e = ext(f.name);
    return '<span class="ld-th' + (e === 'pdf' ? ' pdf' : /docx?/.test(e) ? ' doc' : '') + '">' + svg(isImg(f.name) ? IC.cam : IC.file, 17) + '</span>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // Upload picker (employee form)
  // ════════════════════════════════════════════════════════════════════════
  function picker(el, opts) {
    css(); opts = opts || {};
    var items = [], seq = 0;
    el.classList.add('ld');
    el.innerHTML = '<div class="ld-zone" data-ld-zone><span class="ld-zi">' + svg(IC.clip, 19) + '</span>'
      + '<div class="ld-zt"><b>Medical certificate or proof <span class="ld-badge" data-ld-badge>Optional</span></b><small>Photos (JPG, PNG, HEIC) or PDF / Word · up to 20 MB each · drag &amp; drop here. Only you, HR and leadership can open them.</small></div>'
      + '<div class="ld-acts"><button type="button" class="ld-btn" data-ld="photo">' + svg(IC.cam) + 'Upload Photo</button><button type="button" class="ld-btn" data-ld="file">' + svg(IC.file) + 'Upload File</button><button type="button" class="ld-btn" data-ld="drive">' + svg(IC.drive) + 'Choose from Drive</button></div></div>'
      + '<input type="file" data-ld-in="photo" accept="image/*,.heic,.heif" multiple hidden>'
      + '<input type="file" data-ld-in="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*,.heic" multiple hidden>'
      + '<div class="ld-list" data-ld-list></div>';
    var list = el.querySelector('[data-ld-list]');
    function changed() { draw(); if (opts.onChange) try { opts.onChange(); } catch (_) {} }
    function draw() {
      list.innerHTML = items.map(function (it) {
        var st = it.state === 'done' ? '<span class="ok">' + svg(IC.ok, 11) + 'Uploaded</span>'
          : it.state === 'failed' ? '<span class="err">' + esc(it.error || 'Upload failed') + '</span>'
          : '<span>Uploading… ' + it.pct + '%</span>';
        return '<div class="ld-row' + (it.state === 'failed' ? ' bad' : '') + '" data-id="' + it.id + '">' + thumbHTML(it)
          + '<span class="ld-mid"><b title="' + esc(it.name) + '">' + esc(it.name) + '</b><small>' + esc(size(it.size)) + ' · ' + st + '</small>'
          + (it.state === 'uploading' ? '<span class="ld-bar"><i style="width:' + it.pct + '%"></i></span>' : '') + '</span>'
          + (it.state === 'failed' ? '<button type="button" class="ld-mini" data-retry="' + it.id + '">Retry</button>' : '')
          + '<button type="button" class="ld-x" data-rm="' + it.id + '" aria-label="Remove ' + esc(it.name) + '">' + svg(IC.x, 13) + '</button></div>';
      }).join('');
    }
    function setPct(it, p) { it.pct = p; var row = list.querySelector('[data-id="' + it.id + '"]'); if (!row) return; var bar = row.querySelector('.ld-bar i'); if (bar) bar.style.width = p + '%'; var s = row.querySelector('small span'); if (s && it.state === 'uploading') s.textContent = 'Uploading… ' + p + '%'; }
    async function upload(it) {
      it.state = 'uploading'; it.pct = 0; it.error = ''; changed();
      try {
        var t = await api('upload', { name: it.name, size: it.size, type: it.file.type || '' });
        it.path = t.path; it.type = t.type;
        await new Promise(function (res, rej) {   // straight to storage, with real progress
          var fd = new FormData(); fd.append('cacheControl', '3600');
          fd.append('', it.file.type ? it.file : new File([it.file], it.name, { type: t.type }), it.name);
          var x = new XMLHttpRequest(); it.xhr = x;
          x.open('PUT', t.url);
          x.upload.onprogress = function (ev) { if (ev.lengthComputable) setPct(it, Math.min(99, Math.round(ev.loaded / ev.total * 100))); };
          x.onload = function () { x.status >= 200 && x.status < 300 ? res() : rej(new Error(/mime|type/i.test(x.responseText) ? 'This file type isn’t allowed.' : 'Upload failed (' + x.status + ').')); };
          x.onerror = function () { rej(new Error(navigator.onLine ? 'Upload failed — check your connection.' : 'You are offline.')); };
          x.onabort = function () { rej(Object.assign(new Error('cancelled'), { cancelled: true })); };
          x.send(fd);
        });
        it.state = 'done'; it.pct = 100; it.xhr = null;
      } catch (e) {
        if (e.cancelled) return;
        it.state = 'failed'; it.error = e.message; it.xhr = null;
      }
      changed();
    }
    function add(files) {
      Array.prototype.forEach.call(files || [], function (f) {
        var name = f.name || ('photo-' + Date.now() + '.jpg');
        if (!(PHOTO.test(name) || DOC.test(name))) { toast('warning', name + ': use a photo (JPG, PNG, HEIC) or a PDF / Word document.'); return; }
        if (f.size > MAX) { toast('warning', name + ' is larger than 20 MB.'); return; }
        var it = { id: 'd' + (++seq), file: f, name: name, size: f.size, state: 'uploading', pct: 0 };
        if (/\.(jpe?g|png|webp)$/i.test(name)) try { it.preview = URL.createObjectURL(f); } catch (_) {}
        items.push(it); upload(it);
      });
      changed();
    }
    el.addEventListener('click', async function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      var k = b.getAttribute('data-ld');
      if (k === 'photo' || k === 'file') return el.querySelector('[data-ld-in="' + k + '"]').click();
      if (k === 'drive') return pickDrive(add);
      if (b.hasAttribute('data-retry')) { var r = items.filter(function (x) { return x.id === b.getAttribute('data-retry'); })[0]; if (r) upload(r); return; }
      if (b.hasAttribute('data-rm')) {
        var it = items.filter(function (x) { return x.id === b.getAttribute('data-rm'); })[0]; if (!it) return;
        if (it.xhr) try { it.xhr.abort(); } catch (_) {}
        items = items.filter(function (x) { return x !== it; });
        if (it.preview) try { URL.revokeObjectURL(it.preview); } catch (_) {}
        changed();
        if (it.path && it.state === 'done') api('remove', { path: it.path }).catch(function () {});   // not attached yet → delete it
      }
    });
    var zone = el.querySelector('[data-ld-zone]');
    ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (ev) { ev.preventDefault(); zone.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (t) { zone.addEventListener(t, function (ev) { ev.preventDefault(); if (t === 'dragleave' && zone.contains(ev.relatedTarget)) return; zone.classList.remove('drag'); }); });
    zone.addEventListener('drop', function (ev) { if (ev.dataTransfer && ev.dataTransfer.files) add(ev.dataTransfer.files); });
    el.querySelectorAll('[data-ld-in]').forEach(function (inp) { inp.addEventListener('change', function () { add(inp.files); inp.value = ''; }); });
    return {
      files: function () { return items.filter(function (x) { return x.state === 'done'; }).map(function (x) { return { path: x.path, name: x.name, size: x.size, type: x.type }; }); },
      busy: function () { return items.some(function (x) { return x.state === 'uploading'; }); },
      failed: function () { return items.some(function (x) { return x.state === 'failed'; }); },
      clear: function () { items.forEach(function (x) { if (x.preview) try { URL.revokeObjectURL(x.preview); } catch (_) {} }); items = []; draw(); },
      setRequired: function (on) { var b = el.querySelector('[data-ld-badge]'), z = el.querySelector('[data-ld-zone]'); if (b) { b.textContent = on ? 'Required' : 'Optional'; b.classList.toggle('req', !!on); } if (z) z.classList.toggle('req', !!on); }
    };
  }

  // ── Google Drive (Picker, drive.file scope) → copied into the private bucket ───────────
  function load(src) { return new Promise(function (res, rej) { if (document.querySelector('script[src="' + src + '"]')) return res(); var s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = function () { rej(new Error('Could not load Google Drive.')); }; document.head.appendChild(s); }); }
  async function pickDrive(add) {
    var G = window.BE_GOOGLE || {};
    if (!G.clientId || !G.apiKey) { toast('info', 'Choose from Drive needs a one-time Google setup by the admin. Use Upload Photo / Upload File for now.'); return; }
    try {
      await Promise.all([load('https://apis.google.com/js/api.js'), load('https://accounts.google.com/gsi/client')]);
      await new Promise(function (r) { window.gapi.load('picker', r); });
      var token = await new Promise(function (res, rej) {
        var tc = window.google.accounts.oauth2.initTokenClient({ client_id: G.clientId, scope: 'https://www.googleapis.com/auth/drive.file', callback: function (r) { r && r.access_token ? res(r.access_token) : rej(new Error('Google sign-in was cancelled.')); } });
        tc.requestAccessToken({ prompt: '' });
      });
      var P = window.google.picker;
      var view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(false).setMimeTypes('image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.google-apps.document');
      var b = new P.PickerBuilder().addView(view).enableFeature(P.Feature.MULTISELECT_ENABLED).setOAuthToken(token).setDeveloperKey(G.apiKey)
        .setCallback(async function (d) {
          if (d.action !== P.Action.PICKED) return;
          for (var i = 0; i < d.docs.length; i++) {
            var doc = d.docs[i], gdoc = doc.mimeType === 'application/vnd.google-apps.document';
            try {
              var r = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(doc.id) + (gdoc ? '/export?mimeType=application/pdf' : '?alt=media'), { headers: { Authorization: 'Bearer ' + token } });
              if (!r.ok) throw new Error('Drive returned ' + r.status);
              var blob = await r.blob(), name = gdoc ? doc.name.replace(/\.pdf$/i, '') + '.pdf' : doc.name;
              add([new File([blob], name, { type: gdoc ? 'application/pdf' : (doc.mimeType || blob.type) })]);
            } catch (e) { toast('error', 'Could not copy “' + doc.name + '” from Drive: ' + e.message); }
          }
        });
      if (G.appId) b.setAppId(G.appId);
      b.build().setVisible(true);
    } catch (e) { toast('error', e.message || 'Google Drive is unavailable right now.'); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Viewer (employee's own requests + HR)
  // ════════════════════════════════════════════════════════════════════════
  function docsOf(r) { var a = r && r.proof_files; if (typeof a === 'string') try { a = JSON.parse(a); } catch (_) { a = []; } return Array.isArray(a) ? a.filter(function (x) { return x && x.path; }) : []; }
  function chip(r) {
    var n = docsOf(r).length; if (!n) return '';
    css(); return '<button type="button" class="ld-chip" data-ld-open="' + esc(r.id) + '">' + svg(IC.clip, 12) + n + ' document' + (n === 1 ? '' : 's') + '</button>';
  }
  async function signed(r, f, download) { return api('sign', { request_id: r.id, path: f.path, download: !!download }); }
  function open(r, title) {
    css(); var docs = docsOf(r); if (!docs.length) return;
    var ov = document.createElement('div'); ov.className = 'ld-ov';
    ov.innerHTML = '<div class="ld-dlg" role="dialog" aria-modal="true" aria-label="Supporting documents"><div class="ld-hd"><div style="flex:1;min-width:0"><b>Supporting documents</b><small>' + esc(title || '') + ' · links expire after 2 minutes</small></div><button type="button" class="ld-x" data-close aria-label="Close">' + svg(IC.x, 14) + '</button></div>'
      + '<div class="ld-body"><div class="ld-side">' + docs.map(function (f, i) { return '<div class="ld-row' + (i ? '' : ' on') + '" data-i="' + i + '" tabindex="0" role="button">' + thumbHTML(f) + '<span class="ld-mid"><b>' + esc(f.name) + '</b><small>' + esc(size(f.size)) + '</small></span></div>'; }).join('') + '</div>'
      + '<div class="ld-pane"><div class="ld-view" data-view></div><div class="ld-pacts"><button type="button" class="ld-btn" data-act="open">' + svg(IC.ext) + 'Open</button><button type="button" class="ld-btn" data-act="dl">' + svg(IC.dl) + 'Download</button></div></div></div></div>';
    document.body.appendChild(ov);
    var cur = 0, view = ov.querySelector('[data-view]');
    var close = function () { ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    async function show(i) {
      cur = i; ov.querySelectorAll('.ld-side .ld-row').forEach(function (x) { x.classList.toggle('on', +x.getAttribute('data-i') === i); });
      var f = docs[i], e = ext(f.name);
      view.innerHTML = '<div class="ld-msg">Loading preview…</div>';
      try {
        var s = await signed(r, f, false); if (cur !== i) return;
        if (/^(jpe?g|png|webp)$/.test(e)) view.innerHTML = '<img src="' + esc(s.url) + '" alt="' + esc(f.name) + '">';
        else if (e === 'pdf') view.innerHTML = '<iframe src="' + esc(s.url) + '" title="' + esc(f.name) + '"></iframe>';
        else view.innerHTML = '<div class="ld-msg">' + svg(IC.file, 34) + '<br>' + esc(f.name) + '<br>' + (/heic|heif/.test(e) ? 'HEIC photos can’t be previewed in every browser — use Open or Download.' : 'Word documents open in Word / Google Docs — use Download.') + '</div>';
      } catch (x) { view.innerHTML = '<div class="ld-msg" style="color:var(--fg-red, #fca5a5)">' + esc(x.message) + '</div>'; }
    }
    ov.addEventListener('click', async function (e) {
      if (e.target.closest('[data-close]')) return close();
      var row = e.target.closest('.ld-side .ld-row'); if (row) return show(+row.getAttribute('data-i'));
      var a = e.target.closest('[data-act]'); if (!a) return;
      var w = window.open('', '_blank');   // opened inside the click → never popup-blocked
      try { var s = await signed(r, docs[cur], a.getAttribute('data-act') === 'dl'); if (w) { try { w.opener = null; } catch (_) {} w.location.href = s.url; } else location.href = s.url; }
      catch (x) { if (w) w.close(); toast('error', x.message); }
    });
    ov.addEventListener('keydown', function (e) { var row = e.target.closest && e.target.closest('.ld-side .ld-row'); if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show(+row.getAttribute('data-i')); } });
    show(0);
  }

  window.BELeaveDocs = { picker: picker, chip: chip, open: open, docs: docsOf, mime: MIME };
})();
