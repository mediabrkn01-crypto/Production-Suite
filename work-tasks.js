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
  function fmtIso(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? String(s).slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); }
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
  // ── Delivered output ───────────────────────────────────────────────────────────────
  // asset_link holds what the employee submitted. Media stores "name|url;;name|url" (Drive files)
  // plus an optional "__folder__|<drive folder>"; BEWork submissions use the same format, and a
  // bare URL is a plain link. Everything is parsed here so every view shows the real output.
  var EXT = { image: /\.(jpe?g|png|gif|webp|bmp|svg|heic|avif)$/i, video: /\.(mp4|mov|m4v|webm|mkv|avi)$/i, pdf: /\.pdf$/i,
    doc: /\.(docx?|xlsx?|pptx?|csv|txt|rtf|odt|ods|odp|key|pages|numbers)$/i, zip: /\.(zip|rar|7z|tar|gz)$/i, audio: /\.(mp3|wav|m4a|aac|ogg)$/i };
  function kindOf(name, url) {
    var n = String(name || '') + ' ' + String(url || '').split('?')[0];
    for (var k in EXT) if (EXT[k].test(String(name || '')) || EXT[k].test(String(url || '').split('?')[0])) return k;
    if (/drive\.google\.com\/drive\/folders\//i.test(url)) return 'folder';
    if (/docs\.google\.com\/(document|spreadsheets|presentation)/i.test(url)) return 'doc';
    return /drive\.google\.com\/file\//i.test(url) ? 'file' : 'link';
  }
  function parseOutput(str) {
    var raw = String(str || '').trim(); if (!raw || raw === 'None') return [];
    var parts = raw.indexOf('|') > -1 || raw.indexOf(';;') > -1 ? raw.split(';;') : [raw];
    return parts.map(function (p) {
      p = p.trim(); var k = p.indexOf('|'); var name = k > -1 ? p.slice(0, k) : ''; var url = (k > -1 ? p.slice(k + 1) : p).trim();
      if (!/^https?:\/\//i.test(url)) return null;
      var folder = name === '__folder__';
      var kind = folder ? 'folder' : kindOf(name, url);
      if (!name || folder) { try { name = folder ? 'Delivery folder' : (new URL(url).hostname.replace(/^www\./, '') + (kind === 'link' ? '' : ' file')); } catch (_) { name = 'Link'; } }
      return { name: name, url: url, kind: kind };
    }).filter(Boolean);
  }
  function driveId(url) { var m = String(url).match(/\/file\/d\/([\w-]{10,})/) || String(url).match(/[?&]id=([\w-]{10,})/); return m ? m[1] : null; }
  function previewSrc(f) {
    var id = driveId(f.url);
    if (id) return f.kind === 'image' ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w2000' : 'https://drive.google.com/file/d/' + id + '/preview';
    return f.url;
  }
  function thumbSrc(f) { var id = driveId(f.url); return id ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000' : f.url; }
  function downloadSrc(f) { var id = driveId(f.url); return id ? 'https://drive.google.com/uc?export=download&id=' + id : f.url; }
  function canPreview(f) { return ['image', 'video', 'pdf', 'audio'].indexOf(f.kind) > -1 || (f.kind === 'file' || f.kind === 'doc') && !!driveId(f.url); }
  var KIND_ICON = { image: '🖼️', video: '🎬', pdf: '📄', doc: '📝', zip: '🗜️', audio: '🎵', folder: '📁', file: '📎', link: '🔗' };
  var KIND_LABEL = { image: 'Image', video: 'Video', pdf: 'PDF', doc: 'Document', zip: 'Archive', audio: 'Audio', folder: 'Folder', file: 'File', link: 'Link' };
  function outputSummary(t) {
    var f = parseOutput(t.asset_link).filter(function (x) { return x.kind !== 'folder'; });
    if (!f.length) return parseOutput(t.asset_link).length ? 'Folder' : '';
    var files = f.filter(function (x) { return x.kind !== 'link'; }).length, links = f.length - files;
    return (files ? files + ' file' + (files === 1 ? '' : 's') : '') + (files && links ? ' · ' : '') + (links ? links + ' link' + (links === 1 ? '' : 's') : '');
  }
  function outputNote(t) {
    var n = String(t.explanation || '').trim(); if (n && n !== 'None') return n;
    var h = Array.isArray(t.history) ? t.history : [];
    for (var i = h.length - 1; i >= 0; i--) if (h[i].action === 'submitted') return h[i].note || '';
    return '';
  }
  function fmtFull(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function filesHTML(files) {
    var imgs = files.filter(function (f) { return f.kind === 'image'; });
    return (imgs.length ? '<div class="bw-thumbs">' + imgs.map(function (f) { var i = files.indexOf(f); return '<button type="button" class="bw-thumb" data-pv="' + i + '" title="Preview ' + esc(f.name) + '"><img src="' + esc(thumbSrc(f)) + '" alt="' + esc(f.name) + '" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{textContent:\'🖼️\'}))"></button>'; }).join('') + '</div>' : '') +
      '<div class="bw-files">' + files.map(function (f, i) {
        return '<div class="bw-file bw-of"><span class="bw-fk">' + (KIND_ICON[f.kind] || '📎') + '</span><span class="bw-fn"><b>' + esc(f.name) + '</b><small>' + esc(KIND_LABEL[f.kind] || 'File') + (driveId(f.url) ? ' · Google Drive' : '') + '</small></span>' +
          '<span class="bw-fa">' + (canPreview(f) ? '<button type="button" class="bw-btn" data-pv="' + i + '">Preview</button>' : '') +
          (f.kind === 'link' || f.kind === 'folder' || f.kind === 'doc' && !driveId(f.url) ? '<a class="bw-btn" href="' + esc(f.url) + '" target="_blank" rel="noopener">Open link</a>'
            : '<a class="bw-btn" href="' + esc(downloadSrc(f)) + '" target="_blank" rel="noopener">Download</a>') + '</span></div>';
      }).join('') + '</div>';
  }
  function wirePreviews(root, files) {
    root.querySelectorAll('[data-pv]').forEach(function (b) { b.onclick = function () { preview(files[+b.dataset.pv], files); }; });
  }
  function preview(f, all) {
    if (!f) return;
    var src = previewSrc(f), drive = !!driveId(f.url), body;
    if (f.kind === 'image') body = '<img class="bw-pv-media" src="' + esc(src) + '" alt="' + esc(f.name) + '">';
    else if (f.kind === 'video' && !drive) body = '<video class="bw-pv-media" src="' + esc(src) + '" controls playsinline></video>';
    else if (f.kind === 'audio' && !drive) body = '<audio src="' + esc(src) + '" controls style="width:100%"></audio>';
    else body = '<iframe class="bw-pv-frame" src="' + esc(src) + '" allow="autoplay; fullscreen" allowfullscreen></iframe>';
    var idx = all ? all.indexOf(f) : -1, nav = all && all.filter(canPreview).length > 1;
    modal('<div class="bw-mh"><div><h3>' + esc(f.name) + '</h3><p>' + esc(KIND_LABEL[f.kind] || 'File') + (drive ? ' · Google Drive' : '') + '</p></div><button class="bw-x" data-bw-close aria-label="Close">✕</button></div>' +
      '<div class="bw-pv">' + body + '</div>' +
      '<div class="bw-mf">' + (nav ? '<button class="bw-btn ghost" data-nav="-1">‹ Previous</button><button class="bw-btn ghost" data-nav="1">Next ›</button>' : '') +
      '<a class="bw-btn" href="' + esc(f.url) + '" target="_blank" rel="noopener">Open original</a><a class="bw-btn pri" href="' + esc(downloadSrc(f)) + '" target="_blank" rel="noopener">Download</a></div>', function (ov, close) {
      ov.querySelector('.bw-modal').classList.add('bw-wide');
      ov.querySelectorAll('[data-nav]').forEach(function (b) { b.onclick = function () {
        var list = all.filter(canPreview), j = list.indexOf(f), n = list[(j + (+b.dataset.nav) + list.length) % list.length]; close(); preview(n, all); }; });
    });
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
    if (!(await hasTeams(db))) TEAM_COLS.forEach(function (k) { delete p[k]; });
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

  // ── team / collaborative tasks (20261013_work_teams.sql) ─────────────────────────────
  // ONE shared assignments row (assignment_type 'team') + assignment_members (many-to-many,
  // soft-removed for audit) + assignment_activity (comments + team output files).
  var TEAM_COLS = ['assignment_type', 'team_lead_id', 'final_submitted_by'];
  var CONTRIB = { not_started: 'Not started', in_progress: 'In progress', done: 'Contribution done' };
  async function hasTeams(db) {
    if (hasTeams._v != null) return hasTeams._v;
    try { var r = await db.from('assignment_members').select('id').limit(1); hasTeams._v = !r.error; } catch (e) { hasTeams._v = false; }
    return hasTeams._v;
  }
  function isTeam(t) { return t && t.assignment_type === 'team'; }
  async function loadMembers(db, ids) {
    var map = {}; ids = (ids || []).map(String);
    if (!ids.length || !(await hasTeams(db))) return map;
    var r = await db.from('assignment_members').select('*').in('assignment_id', ids).order('joined_at');
    (r.data || []).forEach(function (m) { (map[String(m.assignment_id)] = map[String(m.assignment_id)] || []).push(m); });
    return map;
  }
  function activeMembers(list) { return (list || []).filter(function (m) { return !m.removed_at; }); }
  async function loadActivity(db, id) {
    if (!(await hasTeams(db))) return [];
    var r = await db.from('assignment_activity').select('*').eq('assignment_id', id).order('created_at');
    return r.data || [];
  }
  var _teamLive = false;
  function liveTeamBlocks() {
    if (_teamLive || !window.BELive) return; _teamLive = true;
    BELive.on('bework-team-live', ['assignment_activity', 'assignment_members'], function (evs, info) {
      var ids = {}; (evs || []).forEach(function (e) { var n = e.new || {}, p = e.old || {}; ids[String(n.assignment_id || p.assignment_id)] = 1; });
      document.querySelectorAll('.bw-teamblk[data-task]').forEach(function (b) { if ((info && info.resync) || ids[b.dataset.task]) { if (b._refresh) b._refresh(); } });
    }, { debounce: 250 });
  }
  function teamBadge() { return '<span class="bw-team">TEAM WORK</span>'; }
  function teamDeps(mem) { var d = {}; activeMembers(mem).forEach(function (m) { if (m.department) d[m.department] = 1; }); return Object.keys(d); }
  function teamNames(mem, exceptEmail) { return activeMembers(mem).filter(function (m) { return lc(m.employee_email) !== lc(exceptEmail); }).map(function (m) { return m.employee_name || m.employee_email; }); }
  function joinNames(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  /** Team block for the task modal (members, roles, contributions, activity, team outputs). */
  function teamHTML(t, mem, acts, o) {
    return '<div class="bw-teamblk" data-task="' + esc(t.id) + '">' + teamInner(t, mem, acts, o) + '</div>';
  }
  function teamInner(t, mem, acts, o) {
    o = o || {};
    var act = activeMembers(mem), gone = (mem || []).filter(function (m) { return m.removed_at; });
    var lead = act.find(function (m) { return m.member_role === 'lead'; });
    var files = (acts || []).filter(function (a) { return a.kind === 'file' && a.file_url; });
    var notes = (acts || []).filter(function (a) { return a.kind !== 'file'; });
    return '<div class="bw-f"><span class="bw-l">Team members · ' + act.length + (lead ? ' · Team lead: ' + esc(lead.employee_name) : '') + '</span><div class="bw-mems">' +
        act.map(function (m) {
          var mine = o.me && lc(m.employee_email) === lc(o.me);
          return '<div class="bw-mem"><span class="bw-ava">' + esc(initials(m.employee_name)) + '</span><div class="bw-mem-t"><b>' + esc(m.employee_name || m.employee_email) + (mine ? ' <em>(you)</em>' : '') + (m.member_role === 'lead' ? ' <i class="bw-lead">LEAD</i>' : '') + '</b>' + depChip(m.department) + '</div>' +
            (mine && o.canContribute ? '<select class="bw-contrib" data-contrib="' + esc(m.id) + '">' + Object.keys(CONTRIB).map(function (k) { return '<option value="' + k + '"' + (m.contribution_status === k ? ' selected' : '') + '>' + CONTRIB[k] + '</option>'; }).join('') + '</select>'
              : '<span class="bw-cs ' + esc(m.contribution_status) + '">' + esc(CONTRIB[m.contribution_status] || '') + '</span>') +
            (o.manage && act.length > 1 ? '<button type="button" class="bw-btn ghost bw-rmm" data-rmm="' + esc(m.id) + '" aria-label="Remove ' + esc(m.employee_name) + '">Remove</button>' : '') + '</div>';
        }).join('') +
        (gone.length ? '<div class="bw-gone">Previously on this team: ' + esc(gone.map(function (m) { return m.employee_name; }).join(', ')) + '</div>' : '') +
        (o.manage ? '<div class="bw-addm" id="bw-addm"><button type="button" class="bw-btn" data-addm>+ Add team member</button></div>' : '') +
      '</div></div>' +
      (files.length ? '<div class="bw-f"><span class="bw-l">Team outputs</span><div class="bw-files">' + files.map(function (f) {
        return '<div class="bw-file">' + (KIND_ICON[kindOf(f.file_name, f.file_url)] || '📎') + '<span><b>' + esc(f.author_name || '') + '</b> – ' + esc(f.file_name || 'File') + '</span><a href="' + esc(f.file_url) + '" target="_blank" rel="noopener">Open</a></div>'; }).join('') + '</div></div>' : '') +
      '<div class="bw-f"><span class="bw-l">Task activity</span><div class="bw-acty">' +
        (notes.length ? notes.map(function (a) { return '<div class="bw-actr"><b>' + esc(a.author_name || a.author_email || '') + '</b><span>' + esc(a.body || '') + '</span><small>' + esc(fmtTs(a.created_at)) + '</small></div>'; }).join('') : '<div class="bw-due" style="color:#5b638a">No activity yet.</div>') +
      '</div>' +
      (o.canPost ? '<div class="bw-post"><textarea id="bw-actin" rows="2" maxlength="600" placeholder="Share an update with the team…"></textarea><div class="bw-post-a"><label class="bw-btn ghost">📎 Share file<input type="file" hidden id="bw-actf"></label><button type="button" class="bw-btn pri" data-post>Post</button></div></div>' : '') +
      '</div>';
  }
  /** Wire contribution / post / share-file controls of teamHTML. The block refreshes itself in
   *  place (realtime or after an action) — the modal stays open and typed text is kept. */
  function wireTeam(ov, db, t, who, reload, o) {
    var blk = ov.querySelector('.bw-teamblk[data-task="' + t.id + '"]');
    if (blk && !blk._refresh) blk._refresh = async function () {
      var mem = (await loadMembers(db, [t.id]))[String(t.id)] || [], acts = await loadActivity(db, t.id);
      var ta = blk.querySelector('#bw-actin'), keep = ta ? ta.value : '';
      blk.innerHTML = teamInner(t, mem, acts, o);
      var ta2 = blk.querySelector('#bw-actin'); if (ta2 && keep) ta2.value = keep;
      wireTeam(ov, db, t, who, reload, o);
      if (o && o.onRefresh) o.onRefresh(mem);
    };
    if (blk && !reload) reload = blk._refresh;
    var sel = ov.querySelector('[data-contrib]');
    if (sel) sel.onchange = async function () {
      var r = await db.from('assignment_members').update({ contribution_status: sel.value }).eq('id', sel.dataset.contrib);
      if (r.error) { toast('error', 'Could not update: ' + r.error.message); return; }
      await db.from('assignment_activity').insert([{ assignment_id: t.id, author_email: who.email, author_name: who.name, kind: 'contribution', body: 'Contribution: ' + CONTRIB[sel.value] }]);
      toast('success', 'Your contribution status is updated for the team.');
      if (reload) reload();
    };
    var post = ov.querySelector('[data-post]');
    if (post) post.onclick = async function () {
      var ta = ov.querySelector('#bw-actin'), body = ta.value.trim(); if (!body) { ta.focus(); return; }
      post.disabled = true;
      var r = await db.from('assignment_activity').insert([{ assignment_id: t.id, author_email: who.email, author_name: who.name, kind: 'comment', body: body }]);
      post.disabled = false;
      if (r.error) { toast('error', 'Could not post: ' + r.error.message); return; }
      ta.value = ''; if (reload) reload();
    };
    var fin = ov.querySelector('#bw-actf');
    if (fin) fin.onchange = async function () {
      var f = fin.files && fin.files[0]; fin.value = ''; if (!f) return;
      if (f.size > 50 * 1024 * 1024) { toast('warning', 'Over 50 MB — share it as a Drive link in a post instead.'); return; }
      toast('info', 'Uploading ' + f.name + '…');
      try {
        var up = await uploadFiles(db, [f]);
        var r = await db.from('assignment_activity').insert([{ assignment_id: t.id, author_email: who.email, author_name: who.name, kind: 'file', file_name: up[0].name, file_url: up[0].url, body: 'Shared ' + up[0].name }]);
        if (r.error) throw r.error;
        toast('success', 'Shared with the team.'); if (reload) reload();
      } catch (e) { toast('error', 'Upload failed: ' + (e.message || e)); }
    };
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
      '.bw-ov{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,6,12,.72);backdrop-filter:blur(4px)}',
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
      '.bw-alert{position:fixed;top:18px;right:18px;z-index:9500;width:min(360px,calc(100vw - 32px));padding:14px 16px;border-radius:14px;background:#11162a;border:1px solid rgba(255,107,6,.45);box-shadow:0 20px 50px -12px rgba(0,0,0,.8);color:#e5e7eb;transform:translateY(-12px);opacity:0;transition:all .2s}',
      '.bw-alert.on{transform:none;opacity:1}.bw-alert small{display:block;font-size:10.5px;font-weight:800;letter-spacing:.1em;color:#ff8a3c}',
      '.bw-alert b{display:block;margin:4px 0 2px;font-size:14.5px;color:#fff}.bw-alert span{font-size:12px;color:#8b93b8}',
      '.bw-alert-a{display:flex;gap:8px;margin-top:10px}',
      '.bw-done .bw-row{grid-template-columns:minmax(0,2fr) minmax(0,1.4fr) 110px 82px 96px 110px 110px auto}',
      '.bw-range{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:var(--bw-m)}.bw-range .bw-in{width:140px}',
      '.bw-outpill{display:inline-flex;font-size:11px;font-weight:800;padding:4px 9px;border-radius:999px;color:#93c5fd;background:rgba(59,130,246,.12);white-space:nowrap}',
      '.bw-out{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:14px;border:1px solid rgba(52,211,153,.3);background:linear-gradient(180deg,rgba(16,185,129,.07),rgba(255,255,255,.015))}',
      '.bw-out-h{display:flex;align-items:center;justify-content:space-between;gap:8px}.bw-out-h b{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6ee7b7}.bw-out-h span{font-size:11px;font-weight:700;color:#a5adcf;background:rgba(255,255,255,.06);border-radius:999px;padding:2px 8px}',
      '.bw-out-m{display:flex;gap:18px;flex-wrap:wrap}.bw-out-m small,.bw-out-note small{display:block;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--bw-d)}.bw-out-m b{font-size:13px;color:#fff}',
      '.bw-out-note{font-size:13px;color:#e5e7eb;font-style:italic;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.2)}.bw-out-note small{font-style:normal;margin-bottom:3px}',
      '.bw-thumbs{display:flex;gap:8px;flex-wrap:wrap}.bw-thumb{width:120px;height:90px;padding:0;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.12);background:#0b0e18;cursor:zoom-in;display:grid;place-items:center;font-size:22px}',
      '.bw-thumb img{width:100%;height:100%;object-fit:cover}.bw-thumb:hover{border-color:rgba(255,107,6,.6)}',
      '.bw-of{gap:10px!important;padding:9px 10px!important}.bw-fk{font-size:18px}.bw-fn{flex:1;min-width:0;display:flex;flex-direction:column}.bw-fn b{font-size:12.5px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bw-fn small{font-size:10.5px;color:var(--bw-d)}',
      '.bw-fa{display:flex;gap:6px;flex-shrink:0}.bw-fa .bw-btn{min-height:30px;text-decoration:none}',
      '.bw-ver{display:flex;flex-direction:column;gap:3px;margin-top:6px;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}',
      '.bw-ver span{font-size:11px;font-weight:700;color:#a5adcf}.bw-ver a{font-size:12px;color:#93c5fd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bw-ver em{font-size:12px;color:#cbd5e1}',
      '.bw-modal.bw-wide{max-width:1000px}.bw-pv{flex:1;min-height:0;display:grid;place-items:center;padding:12px;background:#05070e}',
      '.bw-pv-media{max-width:100%;max-height:70vh;border-radius:10px;object-fit:contain}.bw-pv-frame{width:100%;height:70vh;border:0;border-radius:10px;background:#0b0e18}',
      '@media(max-width:1100px){.bw-done .bw-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto}.bw-done .bw-row>:nth-child(3),.bw-done .bw-row>:nth-child(4),.bw-done .bw-row>:nth-child(5){display:none}}',
      '@media(max-width:1100px){.bw-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto}.bw-row.hd{display:none}.bw-row>.bw-c-pri,.bw-row>.bw-c-prog{display:none}.bw-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}',
      '@media(max-width:640px){.bw-row{grid-template-columns:minmax(0,1fr) auto;row-gap:8px}.bw-row>.bw-c-who{grid-column:1/-1}.bw-row>.bw-c-due{grid-column:1}.bw-acts{grid-column:2;grid-row:1}.bw-kpis{grid-template-columns:1fr 1fr}.bw-g2,.bw-info{grid-template-columns:1fr}.bw-seg{grid-template-columns:1fr 1fr}.bw-mf .bw-btn{flex:1}.bw-search{min-width:100%}}',
      // team / collaborative work
      '.bw-team{display:inline-flex;align-items:center;vertical-align:middle;margin-left:6px;padding:2px 8px;border-radius:999px;font-size:9.5px;font-weight:800;letter-spacing:.08em;color:#c4b5fd;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.35);white-space:nowrap}',
      '.bw-tm{font-size:11.5px;color:#c4b5fd;margin:2px 0 6px;overflow-wrap:anywhere}',
      '.bw-avas{display:flex}.bw-avas .bw-ava{margin-left:-8px;border:2px solid #0d1120}.bw-avas .bw-ava:first-child{margin-left:0}',
      '.bw-mems{display:flex;flex-direction:column;gap:6px}',
      '.bw-mem{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--bw-b);border-radius:12px;background:var(--bw-s)}',
      '.bw-mem-t{flex:1;min-width:140px;display:flex;flex-direction:column;gap:3px}.bw-mem-t b{font-size:13px}.bw-mem-t em{color:var(--bw-m);font-style:normal;font-weight:500}',
      '.bw-lead{font-style:normal;font-size:9px;font-weight:800;letter-spacing:.08em;color:#fbbf24;border:1px solid rgba(251,191,36,.4);border-radius:6px;padding:1px 5px;margin-left:4px}',
      '.bw-cs{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid var(--bw-b);color:var(--bw-m);white-space:nowrap}.bw-cs.in_progress{color:#93c5fd;border-color:rgba(147,197,253,.35)}.bw-cs.done{color:#6ee7b7;border-color:rgba(110,231,183,.35)}',
      '.bw-contrib{min-height:34px;border-radius:9px;border:1px solid var(--bw-b);background:rgba(0,0,0,.25);color:var(--bw-t);font:inherit;font-size:12px;padding:0 8px}',
      '.bw-gone{font-size:11.5px;color:var(--bw-d);padding:2px 2px 0}',
      '.bw-addm{margin-top:4px}.bw-addm .bw-g2{align-items:center}',
      '.bw-acty{display:flex;flex-direction:column;gap:8px;max-height:260px;overflow:auto;padding-right:2px}',
      '.bw-actr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:8px 10px;border-radius:10px;background:var(--bw-s);border:1px solid var(--bw-b)}.bw-actr b{font-size:12px}.bw-actr span{grid-column:1/-1;font-size:13px;line-height:1.5;overflow-wrap:anywhere}.bw-actr small{grid-row:1;grid-column:2;font-size:10.5px;color:var(--bw-d)}',
      '.bw-post{display:flex;flex-direction:column;gap:6px;margin-top:8px}.bw-post-a{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.bw-post-a label{cursor:pointer}',
      '.bw-pick{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto;margin-top:8px;padding:2px}',
      '.bw-pk{display:flex;align-items:center;gap:12px;min-height:48px;padding:8px 12px;border-radius:12px;border:1px solid var(--bw-b);background:var(--bw-s);cursor:pointer}',
      '.bw [hidden]{display:none!important}',
      '.bw-pk input[type=checkbox]{width:18px!important;height:18px!important;min-height:0!important;min-width:18px;padding:0!important;margin:0;border:0;flex:0 0 18px;accent-color:#ff6b06;box-shadow:none!important}',
      '.bw-contrib{width:auto!important;flex:0 0 auto;max-width:190px}',
      '.bw-pk input{accent-color:#ff6b06;flex-shrink:0}.bw-pk span{display:flex;flex-direction:column;min-width:0}.bw-pk b{font-size:13px}.bw-pk small{font-size:11px;color:var(--bw-m);overflow-wrap:anywhere}',
      '.bw-pk.on{border-color:rgba(255,107,6,.5);background:rgba(255,107,6,.08)}.bw-pk.off{opacity:.45;cursor:not-allowed}',
      '@media(max-width:640px){.bw-mem{align-items:flex-start}.bw-pick{max-height:50vh}}',
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
    // Escape closes an open branded dropdown / calendar first, never the whole popup with it.
    var popOpen = function () { return Array.prototype.some.call(document.querySelectorAll('.be-sel-menu,.be-cal'), function (m) { return m.offsetParent !== null && getComputedStyle(m).display !== 'none' && getComputedStyle(m).visibility !== 'hidden'; }); };
    var onKey = function (e) { if (e.key === 'Escape' && !e.defaultPrevented && !popOpen() && ov === document.querySelector('.bw-ov:last-of-type')) close(); };
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
    var team = isTeam(t), mem = (opts && opts.members) || [];
    var deps = team ? teamDeps(mem) : [t.department];
    return '<div class="bw-mh"><div><h3>' + esc(t.topic || 'Task') + (team ? ' ' + teamBadge() : '') + '</h3><p>' + esc(t.type || 'Task') + ' · ' + deps.map(depChip).join(' ') + '</p></div><button class="bw-x" data-bw-close aria-label="Close">✕</button></div>' +
      '<div class="bw-mb">' +
        '<div class="bw-info"><div><small>Status</small>' + stPill(t) + '</div><div><small>Priority</small>' + priPill(t.priority) + '</div><div><small>Due</small><b class="' + (isOverdue(t) ? 'bw-due od' : '') + '">' + esc(dueText(t)) + '</b></div>' +
          (team ? '<div><small>Team</small><b>' + activeMembers(mem).length + ' members' + (deps.length > 1 ? ' · ' + deps.length + ' departments' : '') + '</b></div>' : '<div><small>Assigned to</small><b>' + esc(t.assigned_to || '—') + '</b></div>') + '<div><small>Assigned by</small><b>' + esc(t.assigned_by || '—') + '</b></div><div><small>Assigned on</small><b>' + esc(fmtD(t.assigned_date)) + '</b></div></div>' +
        (typeof t.progress === 'number' && t.progress > 0 && t.status !== 'Completed' ? '<div class="bw-f"><span class="bw-l">Progress · ' + t.progress + '%</span><div class="bw-prog"><i style="width:' + t.progress + '%"></i></div></div>' : '') +
        '<div class="bw-f"><span class="bw-l">Instructions</span><div class="bw-desc">' + (t.description ? esc(t.description) : '<span style="color:#5b638a">No instructions added.</span>') + '</div></div>' +
        (t.rework_reason && t.status === 'Rework Required' ? '<div class="bw-warn"><b>Rework needed:</b> ' + esc(t.rework_reason) + '</div>' : '') +
        ((refs.length || t.reference_link) ? '<div class="bw-f"><span class="bw-l">Reference files &amp; links</span><div class="bw-files">' +
          refs.map(function (r) { return '<div class="bw-file">📎<span>' + esc(r.name) + '</span><a href="' + esc(r.url) + '" target="_blank" rel="noopener">Open</a></div>'; }).join('') +
          (t.reference_link ? '<div class="bw-file">🔗<span>' + esc(t.reference_link) + '</span><a href="' + esc(t.reference_link) + '" target="_blank" rel="noopener">Open</a></div>' : '') + '</div></div>' : '') +
        (team && opts && opts.teamBlock ? opts.teamBlock : '') +
        outputHTML(t) +
        (hist.length ? '<div class="bw-f"><span class="bw-l">History</span><div class="bw-hist">' + hist.map(function (h) {
          var o = h.output && parseOutput(h.output.asset_link);
          return '<div class="bw-h">' + esc(histLabel(h)) + '<small>' + esc(h.by || '') + ' · ' + esc(fmtTs(h.at)) + '</small>' + (h.note ? '<q>' + esc(h.note) + '</q>' : '') +
            (o && o.length ? '<div class="bw-ver"><span>' + esc(h.version ? 'Submission version ' + h.version : 'Submission kept') + (h.output.submitted_at ? ' · submitted ' + esc(fmtFull(h.output.submitted_at)) : '') + '</span>' +
              o.map(function (f) { return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + (KIND_ICON[f.kind] || '📎') + ' ' + esc(f.name) + '</a>'; }).join('') + (h.output.note ? '<em>“' + esc(h.output.note) + '”</em>' : '') + '</div>' : '') + '</div>'; }).join('') + '</div></div>' : '') +
        (opts && opts.extra ? opts.extra : '') +
      '</div>';
  }
  function outputHTML(t) {
    var files = parseOutput(t.asset_link), done = t.status === 'Completed', note = outputNote(t);
    var when = t.submitted_at || t.completed_at;
    if (!files.length && !done) return '';
    var vers = (Array.isArray(t.history) ? t.history : []).filter(function (h) { return h.output && parseOutput(h.output.asset_link).length; }).length;
    return '<div class="bw-out"><div class="bw-out-h"><b>' + (done ? 'Completed output' : 'Latest submission') + '</b>' + (vers ? '<span>Version ' + (vers + 1) + '</span>' : '') + '</div>' +
      '<div class="bw-out-m"><div><small>' + (isTeam(t) ? 'Final submitted by' : 'Submitted by') + '</small><b>' + esc(t.final_submitted_by || t.assigned_to || '—') + (isTeam(t) ? ' <em style="color:#8b93b8;font-style:normal">· credited to the whole team</em>' : '') + '</b></div><div><small>Submitted</small><b>' + esc(when ? fmtFull(when) : '—') + '</b></div>' +
        (t.manager_approved ? '<div><small>Review</small><b style="color:#6ee7b7">Approved' + (t.approved_by ? ' · ' + esc(t.approved_by) : '') + '</b></div>' : '') + '</div>' +
      (files.length ? filesHTML(files) : '<div class="bw-empty" style="padding:14px">No file or link was attached to this submission.</div>') +
      (note ? '<div class="bw-out-note"><small>Employee note</small>“' + esc(note) + '”</div>' : '') + '</div>';
  }
  function histLabel(h) {
    switch (h.action) {
      case 'created': return (h.team ? 'Team work assigned to ' : 'Assigned to ') + (h.to || '—');
      case 'member_added': return 'Team member added: ' + (h.to || '—');
      case 'member_removed': return 'Team member removed: ' + (h.to || '—');
      case 'reassigned': return 'Reassigned from ' + (h.from || '—') + ' to ' + (h.to || '—');
      case 'edited': return 'Edited' + (h.fields ? ' (' + h.fields.join(', ') + ')' : '');
      case 'status': return 'Status → ' + (h.to || '');
      case 'update': return 'Progress update' + (h.progress != null ? ' · ' + h.progress + '%' : '');
      case 'submitted': return h.team ? 'Final team output submitted' : 'Marked completed';
      case 'rework': return 'Sent back for rework' + (h.output && parseOutput(h.output.asset_link).length ? ' — previous delivery kept' : '');
      case 'cancelled': return 'Cancelled';
      default: return h.action || 'Update';
    }
  }

  // ── live alert ─────────────────────────────────────────────────────────────────────────
  function alertNew(t, onView, kind, others) {
    css();
    var team = isTeam(t);
    var head = kind === 'rework' ? (team ? '↩️ TEAM WORK – REWORK REQUIRED' : '↩️ SENT BACK FOR REWORK') : (team ? '👥 NEW TEAM WORK ASSIGNED' : '🔔 NEW WORK ASSIGNED');
    var body = kind === 'rework' ? 'Manager feedback: ' + (t.rework_reason || 'see the task')
      : (team ? 'This is a collaborative task' + (others && others.length ? ' with ' + joinNames(others) : '') + '. ' : '') + dueText(t) + ' · from ' + (t.assigned_by || 'Manager');
    var a = document.createElement('div'); a.className = 'bw-alert bw'; a.setAttribute('role', 'status');
    a.innerHTML = '<small>' + esc(head) + '</small><b>' + esc(t.topic || 'New task') + '</b><span>' + esc(body) + '</span>' +
      '<div class="bw-alert-a"><button class="bw-btn pri" data-v>View task</button><button class="bw-btn ghost" data-d>Dismiss</button></div>';
    document.body.appendChild(a);
    requestAnimationFrame(function () { a.classList.add('on'); });
    var kill = function () { a.classList.remove('on'); setTimeout(function () { a.remove(); }, 250); };
    a.querySelector('[data-v]').onclick = function () { kill(); if (onView) onView(t); };
    a.querySelector('[data-d]').onclick = kill;
    setTimeout(kill, 15000);
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification(head.replace(/^\W+\s*/, ''), { body: (t.topic || '') + ' · ' + body }); } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // MY ASSIGNED TASKS
  // ══════════════════════════════════════════════════════════════════════════════════════
  function mountMyTasks(el, o) {
    css();
    var db = o.db, me = lc(o.email), name = o.name || '';
    var S = { rows: [], f: 'open', known: null, loading: true, teamIds: new Set(), mem: {} };
    try { S.known = new Set(JSON.parse(localStorage.getItem('bw_seen_' + me) || '[]')); } catch (_) { S.known = new Set(); }
    el.classList.add('bw');

    async function load() {
      var r = await db.from('assignments').select('*').ilike('employee_email', me).order('id', { ascending: false });
      S.loading = false;
      if (r.error) { el.innerHTML = '<div class="bw-empty"><b>Could not load your tasks</b>' + esc(r.error.message) + '</div>'; return; }
      // Team tasks I'm an active member of (one shared row each — never a copy per person).
      var teamIds = [], extra = [];
      if (await hasTeams(db)) {
        var m = await db.from('assignment_members').select('assignment_id').ilike('employee_email', me).is('removed_at', null);
        teamIds = (m.data || []).map(function (x) { return String(x.assignment_id); });
        var have = new Set((r.data || []).map(function (x) { return String(x.id); }));
        var need = teamIds.filter(function (id) { return !have.has(id); });
        if (need.length) { var r2 = await db.from('assignments').select('*').in('id', need); extra = r2.data || []; }
      }
      S.teamIds = new Set(teamIds);
      // After the first load, any new id is new work — also for someone whose list was empty
      // (the old rows.length check never alerted an employee about their very first task).
      var prev = S.loadedOnce ? new Set(S.rows.map(function (x) { return String(x.id); })) : null;
      S.loadedOnce = true;
      var prevSt = {}; S.rows.forEach(function (x) { prevSt[String(x.id)] = x.status; });
      // A team task where I was removed (and am not the primary) is no longer mine.
      S.rows = (r.data || []).concat(extra).filter(function (t) { return t.status !== 'cancelled' && (!isTeam(t) || S.teamIds.has(String(t.id))); })
        .sort(function (a, b) { return Number(b.id) - Number(a.id); });
      S.mem = await loadMembers(db, S.rows.filter(isTeam).map(function (t) { return t.id; }));
      // brand-new tasks while this page is open → live alert + page bell (each member gets their own)
      if (prev) S.rows.forEach(function (t) {
        var id = String(t.id), others = isTeam(t) ? teamNames(S.mem[id], me) : null;
        if (!prev.has(id) && isOpen(t)) { alertNew(t, openTask, 'new', others); if (o.onNotify) try { o.onNotify(t); } catch (_) {} }
        else if (prev.has(id) && prevSt[id] !== 'Rework Required' && t.status === 'Rework Required') { alertNew(t, openTask, 'rework', others); if (o.onNotify) try { o.onNotify(t); } catch (_) {} }
      });
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
            '<h4>' + esc(t.topic || 'Task') + (isTeam(t) ? ' ' + teamBadge() : '') + '</h4>' + (t.description ? '<p>' + esc(t.description) + '</p>' : '') +
            (isTeam(t) ? '<div class="bw-tm">With ' + esc(joinNames(teamNames(S.mem[String(t.id)], me)) || 'your team') + '</div>' : '') +
            '<div class="bw-card-m">' + stPill(t) + priPill(t.priority) + (t.type ? '<span class="bw-pri">' + esc(t.type) + '</span>' : '') + '</div>' +
            (t.progress > 0 && isOpen(t) ? '<div class="bw-prog"><i style="width:' + t.progress + '%"></i></div>' : '') +
            '<div class="bw-card-f"><span class="' + (isOverdue(t) ? 'bw-due od' : '') + '">' + esc(dueText(t)) + '</span><span>From ' + esc(t.assigned_by || '—') + '</span></div></button>';
        }).join('') + '</div>'
        : '<div class="bw-empty"><b>' + (S.f === 'open' ? 'Nothing to do right now' : 'No tasks here') + '</b>' + (S.f === 'open' ? 'New work from your manager shows up here instantly.' : '') + '</div>');
      el.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { S.f = b.dataset.f; render(); }; });
      el.querySelectorAll('.bw-card').forEach(function (b) { b.onclick = function () { openTask(S.rows.find(function (t) { return String(t.id) === b.dataset.id; })); }; });
    }
    function markSeen(id) { S.known.add(String(id)); try { localStorage.setItem('bw_seen_' + me, JSON.stringify([].concat(Array.from(S.known)).slice(-400))); } catch (_) {} }
    async function openTask(t) {
      if (!t) return; markSeen(t.id);
      var k = state(t), media = t.scope !== 'org' && t.department === 'production';
      var team = isTeam(t), mem = S.mem[String(t.id)] || [], teamBlock = '';
      var lead = activeMembers(mem).find(function (m) { return m.member_role === 'lead'; });
      // One final submission: the team lead when there is one, otherwise any team member.
      var canSubmit = !team || !lead || lc(lead.employee_email) === me;
      if (team) teamBlock = teamHTML(t, mem, await loadActivity(db, t.id), { me: me, canContribute: isOpen(t), canPost: isOpen(t) });
      var acts = '';
      if (k === 'pending') acts = '<button class="bw-btn pri" data-a="start">Start task</button>';
      else if (k === 'progress' || k === 'rework') acts = '<button class="bw-btn" data-a="update">Add progress update</button>' + (canSubmit ? '<button class="bw-btn green" data-a="submit">' + (team ? 'Submit final team output' : 'Mark completed') + '</button>' : '');
      if (team && !canSubmit && (k === 'progress' || k === 'rework')) teamBlock += '<div class="bw-note">' + esc(lead.employee_name) + ' (team lead) submits the final output for the team.</div>';
      var extra = (k === 'progress' || k === 'rework') ? '<div class="bw-f" id="bw-upd" hidden><span class="bw-l">Progress update</span><input type="range" class="bw-rng" min="0" max="100" step="5" value="' + (t.progress || 0) + '" id="bw-pg"><span class="bw-l" id="bw-pgt">' + (t.progress || 0) + '% done</span><textarea id="bw-note" placeholder="What did you do? Anything blocking you?"></textarea><div style="display:flex;justify-content:flex-end"><button class="bw-btn pri" data-a="saveupd">Save update</button></div></div>' +
        '<div class="bw-f" id="bw-sub" hidden><span class="bw-l">Submit your work</span><div class="bw-files" id="bw-sfl"></div><label class="bw-drop"><input type="file" multiple hidden id="bw-sf">📎 Attach finished files (image, video, PDF, document, ZIP…)</label><input id="bw-out" type="url" placeholder="Or a link — Google Drive, Docs, YouTube…"><textarea id="bw-subnote" placeholder="Short note for your manager (optional)"></textarea><div style="display:flex;justify-content:flex-end"><button class="bw-btn green" data-a="dosubmit">Submit as completed</button></div></div>' : '';
      if (media && (k === 'progress' || k === 'rework')) extra += '<div class="bw-note">This is Media work — you can also submit it from the Media Suite as usual.</div>';
      modal(detailHTML(t, { extra: extra, members: mem, teamBlock: teamBlock }) + '<div class="bw-mf"><button class="bw-btn ghost" data-bw-close>Close</button>' + acts + '</div>', function (ov, close) {
        var ob = ov.querySelector('.bw-out'); if (ob) wirePreviews(ob, parseOutput(t.asset_link));
        if (team) wireTeam(ov, db, t, { email: me, name: name }, null, { me: me, canContribute: isOpen(t), canPost: isOpen(t) });
        var rng = ov.querySelector('#bw-pg'); if (rng) rng.oninput = function () { ov.querySelector('#bw-pgt').textContent = rng.value + '% done'; };
        var subFiles = [], sf = ov.querySelector('#bw-sf');
        function paintSub() { var box = ov.querySelector('#bw-sfl'); if (!box) return; box.innerHTML = subFiles.map(function (f, i) { return '<div class="bw-file">' + (KIND_ICON[kindOf(f.name, '')] || '📎') + '<span>' + esc(f.name) + '</span><a href="#" data-rms="' + i + '">Remove</a></div>'; }).join('');
          box.querySelectorAll('[data-rms]').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); subFiles.splice(+a.dataset.rms, 1); paintSub(); }; }); }
        if (sf) sf.onchange = function () { Array.prototype.forEach.call(sf.files, function (f) { if (f.size > 50 * 1024 * 1024) toast('warning', f.name + ' is over 50 MB — share it as a Drive link instead.'); else subFiles.push(f); }); sf.value = ''; paintSub(); };
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
              var parts = [];
              if (subFiles.length) { b.textContent = 'Uploading…'; try { (await uploadFiles(db, subFiles, function (p) { b.textContent = 'Uploading ' + p + '%…'; })).forEach(function (u) { parts.push(u.name + '|' + u.url); }); }
                catch (err) { toast('error', 'Upload failed: ' + (err.message || err)); b.disabled = false; b.textContent = 'Submit as completed'; return; } }
              if (out) parts.push('Link|' + out);
              var nowIso = new Date().toISOString(), asset = parts.join(';;');
              patch = { status: 'Completed', progress: 100, completed_at: nowIso, submitted_at: nowIso, explanation: sn || 'None',
                history: histAdd(t, name, 'submitted', { note: sn || undefined, team: team || undefined }) };
              if (team) patch.final_submitted_by = name;
              if (asset) patch.asset_link = asset;
              msg = team ? 'Final team output submitted — your manager and team have been updated.' : 'Marked completed — your manager has been updated.'; }
            var r = await saveRow(db, t.id, patch);
            if (r.error) { toast('error', 'Could not save: ' + r.error.message); b.disabled = false; return; }
            toast('success', msg); close(); load();
          };
        });
      });
    }
    el.innerHTML = '<div class="bw-empty">Loading your tasks…</div>';
    liveTeamBlocks();
    load().then(function () { S.rows.forEach(function (t) { if (!isOpen(t)) markSeen(t.id); }); });
    if (window.BELive && me) BELive.on('bework-my', ['assignments', 'assignment_members'], function (evs, info) {
      var mine = info.resync || (evs || []).some(function (e) {
        var n = e.new || {}, p = e.old || {};
        if (e.table === 'assignment_members') return lc(n.employee_email) === me || lc(p.employee_email) === me || S.teamIds.has(String(n.assignment_id || p.assignment_id));
        return lc(n.employee_email) === me || lc(p.employee_email) === me || S.teamIds.has(String(n.id || p.id)) || (!n.employee_email && !p.employee_email);
      });
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
    var S = { rows: [], emps: [], tab: 'active', dep: '', emp: '', pri: '', month: '', from: '', to: '', q: '', ready: false, cols: true, teams: false, mem: {} };
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
      S.teams = await hasTeams(db);
      var all = (r.data || []).map(function (t) { if (!t.department) t.department = 'production'; return t; });
      S.mem = await loadMembers(db, all.filter(isTeam).map(function (t) { return t.id; }));
      // A department head sees team work that involves anyone from their departments.
      S.rows = all.filter(function (t) { return allowedDep(t.department) || (isTeam(t) && activeMembers(S.mem[String(t.id)]).some(function (m) { return allowedDep(m.department); })); });
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
        if (S.emp && lc(t.employee_email) !== lc(S.emp) && !(isTeam(t) && activeMembers(S.mem[String(t.id)]).some(function (m) { return lc(m.employee_email) === lc(S.emp); }))) return false;
        if (S.pri && (t.priority || 'medium') !== S.pri) return false;
        if (S.month && String(t.assigned_date || '').slice(0, 7) !== S.month) return false;
        if (S.from || S.to) { var dk = S.tab === 'completed' ? fmtIso(t.completed_at || t.submitted_at) : String(t.assigned_date || '').slice(0, 10);
          if (!dk || (S.from && dk < S.from) || (S.to && dk > S.to)) return false; }
        if (q && [t.topic, t.assigned_to, DIV[t.department], t.type, t.description, isTeam(t) ? 'team ' + teamNames(S.mem[String(t.id)]).join(' ') : ''].join(' ').toLowerCase().indexOf(q) === -1) return false;
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
      var empOpts = {}; S.rows.forEach(function (t) { if (t.employee_email) empOpts[lc(t.employee_email)] = t.assigned_to || t.employee_email;
        if (isTeam(t)) activeMembers(S.mem[String(t.id)]).forEach(function (m) { empOpts[lc(m.employee_email)] = m.employee_name || m.employee_email; }); });
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
          '<span class="bw-range"><span>' + (S.tab === 'completed' ? 'Completed' : 'Assigned') + '</span><input type="date" class="bw-in" data-from value="' + esc(S.from) + '" aria-label="From date"><span>–</span><input type="date" class="bw-in" data-to value="' + esc(S.to) + '" aria-label="To date">' + (S.from || S.to ? '<button type="button" class="bw-btn ghost" data-clr>Clear</button>' : '') + '</span>' +
        '</div>' +
        (list.length && S.tab === 'completed' ? '<div class="bw-list bw-done"><div class="bw-row hd"><span>Task</span><span>Assigned to</span><span class="bw-c-by">Assigned by</span><span class="bw-c-pri">Priority</span><span class="bw-c-due2">Due</span><span>Completed</span><span>Output</span><span></span></div>' +
          list.slice(0, 400).map(function (t) {
            var out = outputSummary(t), when = t.completed_at || t.submitted_at;
            var late = when && t.date && String(fmtIso(when)) > String(t.date).slice(0, 10);
            return '<div class="bw-row" data-id="' + esc(t.id) + '">' +
              '<div class="bw-tt"><b>' + esc(t.topic || 'Task') + (isTeam(t) ? ' ' + teamBadge() : '') + '</b><span>' + esc(t.type || 'Task') + (isTeam(t) && t.final_submitted_by ? ' · submitted by ' + esc(t.final_submitted_by) : '') + '</span></div>' +
              whoCell(t) +
              '<div class="bw-c-by bw-due">' + esc(t.assigned_by || '—') + '</div>' +
              '<div class="bw-c-pri">' + priPill(t.priority) + '</div>' +
              '<div class="bw-c-due2 bw-due">' + esc(t.date ? fmtD(t.date) : '—') + '</div>' +
              '<div class="bw-due bw-c-due">' + esc(when ? fmtD(fmtIso(when)) : '—') + (late ? '<small style="color:#fb923c">after due</small>' : (t.manager_approved ? '<small style="color:#6ee7b7">approved</small>' : '<small>awaiting review</small>')) + '</div>' +
              '<div>' + (out ? '<span class="bw-outpill">' + esc(out) + '</span>' : '<span class="bw-due" style="color:#5b638a">No output</span>') + '</div>' +
              '<div class="bw-acts"><button class="bw-btn' + (out ? ' green' : '') + '" data-view="' + esc(t.id) + '">View output</button></div>' +
            '</div>';
          }).join('') + '</div>'
        : list.length ? '<div class="bw-list"><div class="bw-row hd"><span>Task</span><span>Assigned to</span><span class="bw-c-pri">Priority</span><span>Due</span><span>Status</span><span class="bw-c-prog">Progress</span><span></span></div>' +
          list.slice(0, 300).map(function (t) {
            var pg = t.status === 'Completed' ? 100 : (t.progress || (t.status === 'In Progress' ? 10 : 0));
            return '<div class="bw-row" data-id="' + esc(t.id) + '">' +
              '<div class="bw-tt"><b>' + esc(t.topic || 'Task') + (isTeam(t) ? ' ' + teamBadge() : '') + '</b><span>' + esc(t.type || 'Task') + ' · assigned ' + esc(fmtD(t.assigned_date)) + '</span></div>' +
              whoCell(t) +
              '<div class="bw-c-pri">' + priPill(t.priority) + '</div>' +
              '<div class="bw-due bw-c-due' + (isOverdue(t) ? ' od' : '') + '">' + esc(t.date ? fmtD(t.date) : '—') + '<small>' + esc(isOpen(t) ? dueText(t) : '') + '</small></div>' +
              '<div>' + stPill(t) + '</div>' +
              '<div class="bw-c-prog"><div class="bw-prog"><i style="width:' + pg + '%"></i></div><div class="bw-prog-t">' + pg + '%</div></div>' +
              '<div class="bw-acts">' + (isOpen(t) ? '<button class="bw-btn" data-edit="' + esc(t.id) + '">Edit</button>' + (isTeam(t) ? '<button class="bw-btn" data-view="' + esc(t.id) + '">Team</button>' : '<button class="bw-btn" data-re="' + esc(t.id) + '">Reassign</button>') : '<button class="bw-btn" data-view="' + esc(t.id) + '">View</button>') + '</div>' +
            '</div>';
          }).join('') + '</div>'
          : '<div class="bw-list"><div class="bw-empty"><b>No tasks match</b>Try another tab or filter, or assign new work.</div></div>');
      // wire
      el.querySelector('[data-new]').onclick = function () { openForm(null); };
      el.querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { S.tab = b.dataset.tab; render(); }; });
      var qi = el.querySelector('[data-q]'); qi.oninput = function () { S.q = qi.value; var pos = qi.selectionStart; render(); var n = el.querySelector('[data-q]'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {} };
      [['dep', 'dep'], ['emp', 'emp'], ['pri', 'pri'], ['month', 'month'], ['from', 'from'], ['to', 'to']].forEach(function (p) { var s = el.querySelector('[data-' + p[0] + ']'); if (s) s.onchange = function () { S[p[1]] = s.value; render(); }; });
      var clr = el.querySelector('[data-clr]'); if (clr) clr.onclick = function () { S.from = S.to = ''; render(); };
      el.querySelectorAll('.bw-row[data-id]').forEach(function (r) { r.onclick = function (e) { if (e.target.closest('button')) return; view(r.dataset.id); }; });
      el.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openForm(b.dataset.edit); }; });
      el.querySelectorAll('[data-re]').forEach(function (b) { b.onclick = function () { reassign([b.dataset.re]); }; });
      el.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { view(b.dataset.view); }; });
      el.querySelectorAll('[data-bulk]').forEach(function (b) { b.onclick = function () { var e = empById(b.dataset.bulk); reassign(S.rows.filter(function (t) { return isOpen(t) && empForTask(t) === e; }).map(function (t) { return String(t.id); }), e); }; });
    }
    function rowById(id) { return S.rows.find(function (t) { return String(t.id) === String(id); }); }
    function whoCell(t) {
      if (!isTeam(t)) return '<div class="bw-who bw-c-who"><span class="bw-ava">' + esc(initials(t.assigned_to)) + '</span><div><b>' + esc(t.assigned_to || '—') + '</b>' + depChip(t.department) + '</div></div>';
      var mem = activeMembers(S.mem[String(t.id)]), d = teamDeps(mem);
      return '<div class="bw-who bw-c-who"><span class="bw-avas">' + mem.slice(0, 3).map(function (m) { return '<span class="bw-ava">' + esc(initials(m.employee_name)) + '</span>'; }).join('') + '</span><div><b>Team · ' + mem.length + ' members</b><span class="bw-due">' + esc(d.map(function (x) { return DIV[x] || x; }).join(' + ')) + '</span></div></div>';
    }
    async function view(id) {
      var t = rowById(id); if (!t) return;
      var open = isOpen(t), done = t.status === 'Completed', team = isTeam(t), mem = S.mem[String(t.id)] || [];
      var actorEmail = lc((o.actor && o.actor.email) || '');
      var teamOpts = { manage: open, canPost: true, me: actorEmail };
      var teamBlock = team ? teamHTML(t, mem, await loadActivity(db, t.id), teamOpts) : '';
      var acts = (open ? '<button class="bw-btn red" data-a="cancel">Cancel task</button>' + (team ? '' : '<button class="bw-btn" data-a="re">Reassign</button>') + '<button class="bw-btn pri" data-a="edit">Edit</button>' : '') +
        (done ? '<button class="bw-btn" data-a="rework">Send back for rework</button>' : '');
      modal(detailHTML(t, { members: mem, teamBlock: teamBlock, extra: done ? '<div class="bw-f" id="bw-rw" hidden><span class="bw-l">What needs to change?' + (team ? ' <em>— every team member is notified</em>' : '') + '</span><textarea id="bw-rwn" placeholder="Explain what to fix"></textarea><div style="display:flex;justify-content:flex-end"><button class="bw-btn pri" data-a="dorework">Send back</button></div></div>' : '' }) +
        '<div class="bw-mf"><button class="bw-btn ghost" data-bw-close>Close</button>' + acts + '</div>', function (ov, close) {
        var ob = ov.querySelector('.bw-out'); if (ob) wirePreviews(ob, parseOutput(t.asset_link));
        if (team) { wireTeam(ov, db, t, { email: actorEmail, name: actor }, null, teamOpts); wireManage(ov, t); }
        ov.querySelectorAll('[data-a]').forEach(function (b) {
          b.onclick = async function () {
            var a = b.dataset.a;
            if (a === 'edit') { close(); openForm(t.id); return; }
            if (a === 're') { close(); reassign([t.id]); return; }
            if (a === 'rework') { ov.querySelector('#bw-rw').hidden = false; ov.querySelector('#bw-rwn').focus(); return; }
            if (a === 'dorework') { var n = ov.querySelector('#bw-rwn').value.trim(); if (!n) { toast('warning', 'Explain what needs to change.'); return; }
              var vno = (Array.isArray(t.history) ? t.history : []).filter(function (h) { return h.output && parseOutput(h.output.asset_link).length; }).length + 1;
              var r = await saveRow(db, t.id, { status: 'Rework Required', rework_reason: n, reviewed_by: actor, reviewed_at: new Date().toISOString(), completed_at: null, manager_approved: false,
                history: histAdd(t, actor, 'rework', { note: n, version: vno, output: { asset_link: t.asset_link || '', submitted_at: t.submitted_at || t.completed_at || null, note: outputNote(t) } }) });
              if (r.error) { toast('error', 'Could not save: ' + r.error.message); return; } toast('success', 'Sent back for rework.'); close(); load(); return; }
            if (a === 'cancel') { if (!(await confirmBox('"' + (t.topic || 'This task') + '" will be cancelled. It stays in history.', 'Cancel this task?', 'Cancel task'))) return;
              var r2 = await saveRow(db, t.id, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: actor, history: histAdd(t, actor, 'cancelled') });
              if (r2.error) { toast('error', 'Could not cancel: ' + r2.error.message); return; } toast('success', 'Task cancelled.'); close(); load(); }
          };
        });
      });
    }
    // Add / remove team members after assignment (soft removal keeps history, comments, files).
    function wireManage(ov, t) {
      if (ov._manage) return; ov._manage = true;
      ov.addEventListener('click', async function (e) {
        var rm = e.target.closest('[data-rmm]'), add = e.target.closest('[data-addm]'), go = e.target.closest('[data-addgo]');
        var blk = ov.querySelector('.bw-teamblk');
        var cur = function () { return S.mem[String(t.id)] || []; };
        if (rm) {
          var m = cur().find(function (x) { return String(x.id) === rm.dataset.rmm; }); if (!m) return;
          if (!(await confirmBox(m.employee_name + ' will be removed from this team task. Their earlier comments and files stay in the task history.', 'Remove team member?', 'Remove'))) return;
          var nowIso = new Date().toISOString();
          var r = await db.from('assignment_members').update({ removed_at: nowIso, removed_by: actor }).eq('id', m.id);
          if (r.error) { toast('error', 'Could not remove: ' + r.error.message); return; }
          var rest = activeMembers(cur()).filter(function (x) { return x.id !== m.id; });
          var lead = rest.find(function (x) { return x.member_role === 'lead'; }), primary = lead || rest[0];
          var patch = { history: histAdd(t, actor, 'member_removed', { to: m.employee_name }) };
          if (m.member_role === 'lead') patch.team_lead_id = null;
          if (primary && lc(t.employee_email) === lc(m.employee_email)) Object.assign(patch, { assigned_to: primary.employee_name, employee_email: lc(primary.employee_email), employee_id: primary.employee_id, department: primary.department || t.department });
          await saveRow(db, t.id, patch);
          toast('success', m.employee_name + ' removed from the team.');
          await load(); t = rowById(t.id) || t; if (blk && blk._refresh) blk._refresh();
          return;
        }
        if (add) {
          var box = ov.querySelector('#bw-addm'), inTeam = new Set(activeMembers(cur()).map(function (x) { return lc(x.employee_email); }));
          var opts = activeTargets('').filter(function (x) { return x.portal_email && !inTeam.has(lc(x.portal_email)); });
          box.innerHTML = '<div class="bw-g2"><select id="bw-addsel"><option value="">Choose employee</option>' + opts.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.full_name) + ' · ' + esc(DIV[x.division] || x.division || '') + '</option>'; }).join('') + '</select><button type="button" class="bw-btn pri" data-addgo>Add to team</button></div>';
          return;
        }
        if (go) {
          var emp = empById((ov.querySelector('#bw-addsel') || {}).value); if (!emp) { toast('warning', 'Choose an employee.'); return; }
          go.disabled = true;
          var r2 = await db.from('assignment_members').insert([{ assignment_id: t.id, employee_id: emp.id, employee_email: lc(emp.portal_email), employee_name: emp.full_name, department: emp.division || 'other', member_role: 'member', added_by: actor }]);
          if (r2.error) { toast('error', 'Could not add: ' + r2.error.message); go.disabled = false; return; }
          await saveRow(db, t.id, { history: histAdd(t, actor, 'member_added', { to: emp.full_name }) });
          toast('success', emp.full_name + ' added — they have been notified.');
          await load(); t = rowById(t.id) || t; if (blk && blk._refresh) blk._refresh();
        }
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
          (t ? (isTeam(t) ? '<div class="bw-f"><span class="bw-l">Team ' + teamBadge() + '</span><div class="bw-file"><span>' + esc(teamNames(S.mem[String(t.id)]).join(', ')) + '</span><a href="#" data-team-in>Manage team</a></div></div>'
              : '<div class="bw-f"><span class="bw-l">Assigned to</span><div class="bw-file"><span>' + esc(t.assigned_to || '—') + ' · ' + esc(DIV[t.department] || '') + '</span><a href="#" data-re-in>Reassign</a></div></div>')
            : '<div class="bw-f"><span class="bw-l">Assignment type</span><div class="bw-seg" role="radiogroup" id="bw-type"><button type="button" data-ty="individual" class="on">Individual</button><button type="button" data-ty="team"' + (S.teams ? '' : ' disabled title="Run 20261013_work_teams.sql to enable team work"') + '>Team / Collaborative</button></div>' + (S.teams ? '' : '<span class="bw-due">Team work needs 20261013_work_teams.sql.</span>') + '</div>' +
              '<div class="bw-f" id="bw-teamf" hidden><label class="bw-l" for="bw-tsearch">Assign team members <b>*</b></label><input class="bw-in" id="bw-tsearch" type="search" placeholder="Search employees…" autocomplete="off">' +
                '<div class="bw-pick" id="bw-pick">' + activeTargets('').map(function (x) { var ok = !!x.portal_email; return '<label class="bw-pk' + (ok ? '' : ' off') + '" data-name="' + esc(lc(x.full_name + ' ' + (x.designation || '') + ' ' + (DIV[x.division] || ''))) + '"><input type="checkbox" value="' + esc(x.id) + '"' + (ok ? '' : ' disabled') + '><span><b>' + esc(x.full_name) + '</b><small>' + esc((x.designation ? x.designation + ' · ' : '') + (DIV[x.division] || x.division || '')) + (ok ? '' : ' · no login') + '</small></span></label>'; }).join('') + '</div>' +
                '<div class="bw-g2"><div class="bw-f"><span class="bw-due" id="bw-tcount">0 selected — choose at least 2</span></div><div class="bw-f"><label class="bw-l" for="bw-lead">Team lead <em>optional</em></label><select id="bw-lead"><option value="">No team lead</option></select></div></div></div>' +
              '<div class="bw-g2" id="bw-indf"><div class="bw-f"><label class="bw-l" for="bw-dep">Department</label><select id="bw-dep">' + (depOpts.length > 1 ? '<option value="">All departments</option>' : '') + depOpts.map(function (d) { return '<option value="' + d + '"' + (dep0 === d ? ' selected' : '') + '>' + esc(DIV[d]) + '</option>'; }).join('') + '</select></div>' +
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
        var tmIn = ov.querySelector('[data-team-in]'); if (tmIn) tmIn.onclick = function (e) { e.preventDefault(); close(); view(t.id); };
        // assignment type + team picker
        var type = 'individual';
        ov.querySelectorAll('[data-ty]').forEach(function (b) { b.onclick = function () { if (b.disabled) return; type = b.dataset.ty;
          ov.querySelectorAll('[data-ty]').forEach(function (x) { x.classList.toggle('on', x === b); });
          ov.querySelector('#bw-teamf').hidden = type !== 'team'; ov.querySelector('#bw-indf').hidden = type === 'team';
          var sv = ov.querySelector('[data-save]'); if (sv) sv.textContent = type === 'team' ? 'Assign team work' : 'Assign work'; }; });
        var picked = function () { return Array.prototype.map.call(ov.querySelectorAll('#bw-pick input:checked'), function (c) { return c.value; }); };
        var syncPick = function () {
          var ids = picked(), lead = ov.querySelector('#bw-lead'), keep = lead ? lead.value : '';
          var cnt = ov.querySelector('#bw-tcount'); if (cnt) cnt.textContent = ids.length + ' selected' + (ids.length < 2 ? ' — choose at least 2' : '');
          if (lead) lead.innerHTML = '<option value="">No team lead</option>' + ids.map(function (id) { var x = empById(id); return '<option value="' + esc(id) + '"' + (keep === id ? ' selected' : '') + '>' + esc(x ? x.full_name : id) + '</option>'; }).join('');
        };
        ov.querySelectorAll('#bw-pick input').forEach(function (c) { c.onchange = function () { c.closest('.bw-pk').classList.toggle('on', c.checked); syncPick(); }; });
        var ts = ov.querySelector('#bw-tsearch'); if (ts) ts.oninput = function () { var q = lc(ts.value); ov.querySelectorAll('#bw-pick .bw-pk').forEach(function (l) { l.hidden = !!q && l.dataset.name.indexOf(q) === -1; }); };
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
          var teamIds = !t && type === 'team' ? picked() : null;
          var teamEmps = teamIds ? teamIds.map(empById).filter(Boolean) : null;
          var leadId = teamIds ? (ov.querySelector('#bw-lead') || {}).value || '' : '';
          if (teamEmps && teamEmps.length < 2) { toast('warning', 'Choose at least 2 team members.'); ov.querySelector('#bw-tsearch').focus(); return; }
          var e = t ? null : (teamEmps ? (empById(leadId) || teamEmps[0]) : empById(emp.value));
          if (!t && !e) { toast('warning', 'Choose the employee.'); emp.focus(); return; }
          if (!due) { toast('warning', 'Set a due date.'); ov.querySelector('#bw-due').focus(); return; }
          if (!t && !teamEmps && !S.cols && e.division !== 'production') { toast('warning', 'Run 20261010_work_assignments.sql in Supabase first — until then only Media work can be assigned.'); return; }
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
            var media = !teamEmps && e.division === 'production', newId = Date.now();
            var row = {
              id: newId, topic: title, type: cat || (media ? 'Video Editing' : 'Task'), description: desc,
              assigned_to: e.full_name, employee_email: lc(e.portal_email), employee_id: e.id, department: e.division || 'other',
              scope: media ? 'media' : 'org', assigned_date: ad, date: due, status: 'Pending', explanation: 'None', asset_link: '',
              reference_file: refStr, reference_link: link || null, assigned_by: actor, created_by: actor, priority: pri, assign_approved: true, progress: 0,
              history: [{ at: new Date().toISOString(), by: actor, action: 'created', to: teamEmps ? teamEmps.map(function (x) { return x.full_name; }).join(', ') : e.full_name, team: teamEmps ? true : undefined }]
            };
            // Team: ONE shared task (team tasks stay out of the Media pipeline screens) + one member row each.
            if (teamEmps) Object.assign(row, { assignment_type: 'team', team_lead_id: leadId || null, scope: 'org' });
            r = await saveRow(db, null, row);
            if (!r.error && teamEmps) {
              var mr = await db.from('assignment_members').insert(teamEmps.map(function (x) { return { assignment_id: newId, employee_id: x.id, employee_email: lc(x.portal_email), employee_name: x.full_name, department: x.division || 'other', member_role: String(x.id) === String(leadId) ? 'lead' : 'member', added_by: actor }; }));
              if (mr.error) r = mr;
            }
          }
          if (r.error) { toast('error', 'Could not save: ' + r.error.message); btn.disabled = false; btn.textContent = t ? 'Save changes' : 'Assign work'; return; }
          toast('success', t ? 'Task updated.' : teamEmps ? 'Team work assigned to ' + teamEmps.length + ' people — each of them has been notified.' : 'Work assigned to ' + e.full_name + ' — they have been notified.');
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
    liveTeamBlocks();
    if (window.BELive) BELive.on('bework-mgr' + (deps ? '-' + deps.join('_') : ''), ['assignments', 'hr_employees', 'assignment_members'], function (evs, info) {
      if (info.resync || (evs || []).some(function (e) { return e.table === 'hr_employees'; })) loadEmps().then(load); else load();
    }, { debounce: 400 });
    return { reload: load, assign: function () { openForm(null); } };
  }

  window.BEWork = { mountMyTasks: mountMyTasks, mountManager: mountManager, DIV: DIV, isOpen: isOpen, isOverdue: isOverdue };
})();
