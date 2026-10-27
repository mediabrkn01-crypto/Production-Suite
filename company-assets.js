/* ════════════════════════════════════════════════════════════════════════════
   HRAssets — HR → Company Assets (migration 20261024_dept_holidays_and_assets.sql).

     hr_asset_types        HR-managed types (custom types allowed)
     hr_assets             the item + its CURRENT status / holder (current_employee_id,
                           current_assignment_id)
     hr_asset_assignments  one row per hand-over. Return / transfer CLOSE the row
                           (returned_date, end_reason) — rows are never overwritten or deleted,
                           so every past holder stays on record. One open row per asset (DB index).
     hr_asset_events       timeline: created · assigned · returned · transferred · repair ·
                           retired · status · edited (+ HR user, timestamp)

   HRAssets.render(host)            the Company Assets page
   HRAssets.renderEmployee(el, emp) Employee Details → Company Assets
   HRAssets.add()                   open the Add Asset form
   HRAssets.exitCheck(emp) → Promise<boolean>   exit / inactive guard (true = continue saving)
   Depends on hr.html globals: dbInstance, hrEmployees, showToast, showConfirm, activeEmail.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.HRAssets) return;
  var S = { types: [], assets: [], open: {}, host: null, ok: true, f: { q: '', status: '', type: '', emp: '' }, loaded: false };
  var ST = {
    available: { l: 'Available', c: '#34d399' }, assigned: { l: 'Assigned', c: '#60a5fa' }, returned: { l: 'Returned', c: '#a5b4fc' },
    repair: { l: 'Repair / Maintenance', c: '#fbbf24' }, retired: { l: 'Retired', c: '#94a3b8' }
  };
  var CONDITIONS = ['New', 'Good', 'Fair', 'Needs repair', 'Damaged'];

  // common.js declares dbInstance / hrEmployees as script globals (not window properties).
  function db() { try { return typeof dbInstance !== 'undefined' ? dbInstance : window.dbInstance; } catch (_) { return window.dbInstance; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(t, m) { if (window.showToast) showToast(t, m); }
  function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
  function fmtD(d) { if (!d) return '—'; var x = new Date(String(d).slice(0, 10) + 'T00:00:00'); return isNaN(x) ? '—' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  function fmtDT(d) { return d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  function emps() { try { return (typeof hrEmployees !== 'undefined' ? hrEmployees : window.hrEmployees) || []; } catch (_) { return []; } }
  function empById(id) { return emps().find(function (e) { return String(e.id) === String(id); }) || null; }
  function empName(id) { var e = empById(id); return e ? e.full_name : '—'; }
  function activeEmps() { return emps().filter(function (e) { return (e.employment_status || 'active') === 'active' && (e.account_type || '') !== 'system'; }).sort(function (a, b) { return (a.full_name || '').localeCompare(b.full_name || ''); }); }
  function actor() {
    var em = (typeof activeEmail !== 'undefined' && activeEmail) || '';
    var me = emps().find(function (e) { return (e.portal_email || '').toLowerCase() === String(em).toLowerCase(); });
    return { email: em || null, name: me ? me.full_name : (em || 'HR') };
  }
  function typeName(id) { var t = S.types.find(function (x) { return String(x.id) === String(id); }); return t ? t.name : '—'; }
  function pill(st) { var m = ST[st] || { l: st, c: '#94a3b8' }; return '<span class="ca-pill" style="--c:' + m.c + '">' + esc(m.l) + '</span>'; }
  function missing(err) { return err && /hr_asset|relation|schema cache/i.test(err.message || ''); }

  function css() {
    if (document.getElementById('ca-css')) return;
    var st = document.createElement('style'); st.id = 'ca-css';
    st.textContent = [
      '.ca-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.ca-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}',
      '.ca-kpi{padding:12px 14px;border-radius:14px;background:rgba(var(--ink, 255,255,255), 0.03);border:1px solid rgba(var(--ink, 255,255,255), 0.07)}',
      '.ca-kpi b{display:block;font-size:20px;color:var(--tx-0, #fff);font-variant-numeric:tabular-nums}.ca-kpi span{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tx-6, #6b74a0)}',
      '.ca-filters{display:grid;grid-template-columns:minmax(0,2fr) repeat(3,minmax(0,1fr));gap:8px;margin:14px 0 10px}',
      '.ca-filters input,.ca-filters select{width:100%;min-width:0}',
      '.ca-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;color:color-mix(in srgb, var(--c) var(--acc-k, 100%), var(--acc-mix, #000));background:color-mix(in srgb,var(--c) 13%,transparent);border:1px solid color-mix(in srgb,var(--c) 35%,transparent);white-space:nowrap}',
      '.ca-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--c)}',
      '.ca-name b{display:block;color:var(--tx-0, #fff);font-weight:700}.ca-name small{display:block;color:var(--tx-6, #6b74a0);font-size:11.5px}',
      '.ca-acts{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}.ca-acts button{white-space:nowrap}',
      '.ca-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--tx-2, #cbd5e1)}',
      '.ca-empty{padding:34px 16px;text-align:center;color:var(--tx-6, #6b74a0);font-size:13px}',
      '.ca-list{display:flex;flex-direction:column;gap:8px}',
      '.ca-item{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:12px;background:rgba(var(--ink, 255,255,255), 0.03);border:1px solid rgba(var(--ink, 255,255,255), 0.07)}',
      '.ca-item>div{flex:1;min-width:0}.ca-item b{display:block;color:var(--tx-0, #fff);font-size:13.5px}.ca-item span{display:block;color:var(--tx-4, #8b93b8);font-size:12px}',
      '.ca-ic{width:34px;height:34px;flex-shrink:0;border-radius:10px;display:grid;place-items:center;color:var(--fg-blue, #60a5fa);background:rgba(96,165,250,.12)}',
      '.ca-tl{display:flex;flex-direction:column;gap:0;border-left:2px solid rgba(var(--ink, 255,255,255), 0.08);margin-left:6px}',
      '.ca-tl div{position:relative;padding:0 0 12px 16px;font-size:12.5px;color:var(--tx-3, #a5adcf)}.ca-tl div::before{content:"";position:absolute;left:-6px;top:4px;width:10px;height:10px;border-radius:50%;background:#ff6b06;box-shadow:0 0 0 3px #0d1120}',
      '.ca-tl b{color:var(--tx-0, #fff)}.ca-tl em{display:block;font-style:normal;color:var(--tx-6, #5b638a);font-size:11px;margin-top:1px}',
      '.ca-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px}.ca-facts div span{display:block;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tx-6, #6b74a0)}.ca-facts div b{color:var(--tx-0, #fff);font-size:13px;font-weight:600;overflow-wrap:anywhere}',
      '.ca-cols{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:22px;align-items:start}',
      '.ca-col{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.ca-side{padding:16px;border-radius:16px;background:rgba(var(--ink, 255,255,255), 0.025);border:1px solid rgba(var(--ink, 255,255,255), 0.07)}',
      '.ca-sec{margin:4px 0 -4px;font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--fg-orange, #ff8a3d)}.ca-sec em{font-style:normal;color:var(--tx-6, #5b638a);letter-spacing:.04em;text-transform:none;font-weight:600;margin-left:6px}',
      '.ca-box{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:14px;background:rgba(96,165,250,.05);border:1px solid rgba(96,165,250,.18)}',
      '.ca-hint{margin:-4px 0 0;font-size:11.5px;color:var(--tx-6, #6b74a0)}',
      '.ca-prev{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;padding:14px;border-radius:14px;background:linear-gradient(150deg,rgba(255,107,6,.1),rgba(var(--ink, 255,255,255), 0.02));border:1px solid rgba(255,107,6,.22)}',
      '.ca-prev>div{flex:1;min-width:0}.ca-prev b{display:block;color:var(--tx-0, #fff);font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ca-prev span:not(.ca-pill):not(.ca-ic){display:block;color:var(--tx-4, #8b93b8);font-size:12px}',
      '.ca-prev-who{flex-basis:100%;font-style:normal;font-size:12px;color:var(--fg-blue, #93c5fd)}',
      '.ca-seg{display:flex;flex-wrap:wrap;gap:6px}.ca-seg button{min-height:34px;padding:0 12px;border-radius:10px;border:1px solid rgba(var(--ink, 255,255,255), 0.1);background:rgba(var(--ink, 255,255,255), 0.03);color:var(--tx-3, #a5adcf);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}',
      '.ca-seg button.on{color:var(--tx-0, #fff);background:rgba(255,107,6,.16);border-color:rgba(255,107,6,.5)}.ca-seg button:focus-visible{outline:2px solid #ff8a3c;outline-offset:2px}',
      '@media(max-width:760px){.ca-cols{grid-template-columns:1fr;gap:16px}.ca-side{padding:12px}}',
      '.ca-newtype{display:flex;gap:6px;margin-top:6px}.ca-newtype[hidden]{display:none}.ca-newtype input{flex:1;min-width:0}',
      '@media(max-width:767px){.ca-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.ca-filters{grid-template-columns:1fr 1fr}.ca-filters .ca-q{grid-column:1/-1}.ca-acts{justify-content:flex-start}}',
      '@media(max-width:440px){.ca-facts{grid-template-columns:1fr}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ── data ──────────────────────────────────────────────────────────────
  async function load() {
    var r = await Promise.all([
      db().from('hr_asset_types').select('*').order('sort_order').order('name'),
      db().from('hr_assets').select('*').order('created_at', { ascending: false }),
      db().from('hr_asset_assignments').select('*').is('returned_date', null)
    ]);
    if (r.some(function (x) { return missing(x.error); })) { S.ok = false; S.loaded = true; return; }
    S.ok = true; S.loaded = true;
    S.types = (r[0].data || []).filter(function (t) { return t.active !== false; });
    S.assets = r[1].data || [];
    S.open = {}; (r[2].data || []).forEach(function (a) { S.open[a.asset_id] = a; });
  }
  async function logEvent(assetId, event, extra) {
    var a = actor();
    await db().from('hr_asset_events').insert([Object.assign({ asset_id: assetId, event: event, actor_email: a.email, actor_name: a.name, details: {} }, extra || {})]);
  }

  // ── modal helper (HR's own .hfm modal look) ────────────────────────────
  function modal(title, sub, body, foot, onMount, wide) {
    var ov = document.createElement('div'); ov.className = 'hr-modal-overlay';
    ov.innerHTML = '<div class="hr-modal hfm" style="max-width:' + (wide === 'xl' ? 920 : wide ? 640 : 520) + 'px" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">'
      + '<div class="hfm-head"><div class="hfm-ic" style="--ic:#60a5fa"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg></div>'
      + '<div class="hfm-ttl"><h3>' + esc(title) + '</h3>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>'
      + '<button type="button" class="hfm-x" data-x aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>'
      + '<div class="hfm-body">' + body + '</div>' + (foot ? '<div class="hfm-foot">' + foot + '</div>' : '') + '</div>';
    document.body.appendChild(ov);
    var close = function () { ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.closest('[data-x]')) close(); });
    if (onMount) onMount(ov, close);
    var f = ov.querySelector('input,select,textarea'); if (f) setTimeout(function () { f.focus(); }, 30);
    return { ov: ov, close: close };
  }
  function empOptions(sel, exclude) {
    return '<option value="">Select employee…</option>' + activeEmps().filter(function (e) { return String(e.id) !== String(exclude || ''); })
      .map(function (e) { return '<option value="' + e.id + '"' + (String(sel) === String(e.id) ? ' selected' : '') + '>' + esc(e.full_name) + (e.designation ? ' — ' + esc(e.designation) : '') + '</option>'; }).join('');
  }
  function condOptions(sel) { return '<option value="">—</option>' + CONDITIONS.map(function (c) { return '<option' + (c === sel ? ' selected' : '') + '>' + c + '</option>'; }).join(''); }
  function fld(label, html, req) { return '<div class="hfm-f"><label class="hfm-l">' + label + (req ? ' <b>*</b>' : '') + '</label>' + html + '</div>'; }
  function foot(btn) { return '<span class="hfm-hint">* Required</span><div class="hfm-btns"><button type="button" class="hfm-btn" data-x>Cancel</button>' + btn + '</div>'; }
  function v(ov, id) { var el = ov.querySelector('#' + id); return el ? String(el.value || '').trim() : ''; }

  // ── core operations (history-preserving) ─────────────────────────────────
  async function assign(asset, employeeId, date, cond, notes, eventName, fromEmp) {
    var a = actor();
    var ins = await db().from('hr_asset_assignments').insert([{ asset_id: asset.id, employee_id: employeeId, assigned_date: date || today(), assigned_by: a.name, condition_out: cond || asset.condition || null, notes: notes || null }]).select('id').single();
    if (ins.error) throw ins.error;
    var up = await db().from('hr_assets').update({ status: 'assigned', current_employee_id: employeeId, current_assignment_id: ins.data.id, updated_at: new Date().toISOString() }).eq('id', asset.id);
    if (up.error) throw up.error;
    await logEvent(asset.id, eventName || 'assigned', { employee_id: employeeId, from_employee_id: fromEmp || null, details: { date: date || today(), condition: cond || null, notes: notes || null } });
  }
  async function closeOpen(asset, date, cond, notes, reason) {
    var open = S.open[asset.id];
    if (!open) { var r = await db().from('hr_asset_assignments').select('*').eq('asset_id', asset.id).is('returned_date', null).maybeSingle(); open = r.data; }
    if (!open) return null;
    var up = await db().from('hr_asset_assignments').update({ returned_date: date || today(), return_condition: cond || null, return_notes: notes || null, returned_by: actor().name, end_reason: reason }).eq('id', open.id).is('returned_date', null);
    if (up.error) throw up.error;
    return open;
  }

  // ── forms ─────────────────────────────────────────────────────────────
  function openForm(asset) {
    var a = asset || {};
    // Two-column form: item details on the left; live summary card, condition, assignment,
    // document and notes on the right (the right column was empty space before).
    var typeSel = '<select id="ca-type" class="hr-select w-full"><option value="">Select type…</option>' + S.types.map(function (t) { return '<option value="' + t.id + '"' + (String(t.id) === String(a.type_id) ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '<option value="__new">+ Add a new type…</option></select><div class="ca-newtype" id="ca-newtype" hidden><input id="ca-newtype-name" class="hr-input" placeholder="New type name"></div>';
    var condChips = '<input type="hidden" id="ca-cond" value="' + esc(a.condition || '') + '"><div class="ca-seg" role="radiogroup" aria-label="Condition">' + CONDITIONS.map(function (c) { return '<button type="button" role="radio" data-cond="' + c + '" class="' + (c === a.condition ? 'on' : '') + '" aria-checked="' + (c === a.condition) + '">' + c + '</button>'; }).join('') + '</div>';
    var left = '<div class="ca-col">'
      + '<p class="ca-sec">Item</p>'
      + fld('Asset name', '<input id="ca-name" class="hr-input" placeholder="e.g. MacBook Pro 14" value="' + esc(a.name) + '">', true)
      + '<div class="hfm-g2">' + fld('Asset type', typeSel, true) + fld('Asset ID / internal code', '<input id="ca-code" class="hr-input" placeholder="e.g. BE-LAP-012" value="' + esc(a.asset_code) + '">') + '</div>'
      + '<p class="ca-sec">Specification</p>'
      + '<div class="hfm-g2">' + fld('Brand', '<input id="ca-brand" class="hr-input" placeholder="e.g. Apple" value="' + esc(a.brand) + '">') + fld('Model', '<input id="ca-model" class="hr-input" placeholder="e.g. M3 Pro, 18 GB" value="' + esc(a.model) + '">') + '</div>'
      + '<div class="hfm-g2">' + fld('Serial number', '<input id="ca-serial" class="hr-input" value="' + esc(a.serial_number) + '">') + fld('Purchase date', '<input id="ca-pdate" type="date" class="hr-input" value="' + esc(a.purchase_date || '') + '">') + '</div>'
      + fld('Condition', condChips)
      + '</div>';
    var right = '<div class="ca-col ca-side">'
      + '<div class="ca-prev" id="ca-prev"></div>'
      + (asset ? '' : '<div class="ca-box"><p class="ca-sec" style="margin-top:0">Assign now <em>optional</em></p>'
        + fld('Employee', '<select id="ca-emp" class="hr-select w-full">' + empOptions('') + '</select>')
        + fld('Assigned date', '<input id="ca-adate" type="date" class="hr-input" value="' + today() + '">')
        + '<p class="ca-hint">Leave empty to add it as Available.</p></div>')
      + fld('Image / invoice / document link', '<input id="ca-doc" class="hr-input" placeholder="Drive or file link" value="' + esc(a.document_url) + '">')
      + fld('Notes', '<textarea id="ca-notes" class="hr-input" rows="3" placeholder="Accessories, charger, warranty…">' + esc(a.notes) + '</textarea>')
      + '</div>';
    var body = '<div class="ca-cols">' + left + right + '</div>';
    modal(asset ? 'Edit asset' : 'Add asset', asset ? (a.asset_code || a.name) : 'Company-owned item. Assign it now or later.', body,
      foot('<button type="button" class="hfm-btn hfm-pri brand-gradient" data-save>' + (asset ? 'Save changes' : 'Add asset') + '</button>'), function (ov, close) {
        ov.querySelector('#ca-type').onchange = function () { ov.querySelector('#ca-newtype').hidden = this.value !== '__new'; if (this.value === '__new') ov.querySelector('#ca-newtype-name').focus(); };
        var prev = function () {
          var nm = v(ov, 'ca-name'), tSel = ov.querySelector('#ca-type'), tn = tSel.value === '__new' ? v(ov, 'ca-newtype-name') : (tSel.value ? tSel.options[tSel.selectedIndex].text : '');
          var emp = ov.querySelector('#ca-emp'), who = emp && emp.value ? emp.options[emp.selectedIndex].text.split(' — ')[0] : '';
          var spec = [v(ov, 'ca-brand'), v(ov, 'ca-model')].filter(Boolean).join(' ');
          ov.querySelector('#ca-prev').innerHTML = '<span class="ca-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg></span>'
            + '<div><b>' + esc(nm || 'New asset') + '</b><span>' + esc([v(ov, 'ca-code'), tn].filter(Boolean).join(' · ') || 'Asset ID · type') + '</span>' + (spec ? '<span>' + esc(spec) + '</span>' : '') + '</div>'
            + pill(asset ? asset.status : (who ? 'assigned' : 'available')) + (who ? '<i class="ca-prev-who">→ ' + esc(who) + '</i>' : '');
        };
        ov.addEventListener('input', prev); ov.addEventListener('change', prev);
        ov.querySelectorAll('[data-cond]').forEach(function (b) { b.onclick = function () {
          var on = !b.classList.contains('on');
          ov.querySelectorAll('[data-cond]').forEach(function (x) { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
          if (on) { b.classList.add('on'); b.setAttribute('aria-checked', 'true'); }
          ov.querySelector('#ca-cond').value = on ? b.dataset.cond : '';
        }; });
        prev();
        ov.querySelector('[data-save]').onclick = async function () {
          var btn = this, name = v(ov, 'ca-name'), typeId = v(ov, 'ca-type'), code = v(ov, 'ca-code');
          if (!name) return toast('warning', 'Enter the asset name.');
          if (!typeId) return toast('warning', 'Choose the asset type.');
          if (code && S.assets.some(function (x) { return x.id !== a.id && String(x.asset_code || '').toLowerCase() === code.toLowerCase(); })) return toast('warning', 'Asset ID ' + code + ' is already used.');
          btn.disabled = true;
          try {
            if (typeId === '__new') {
              var tn = v(ov, 'ca-newtype-name'); if (!tn) { btn.disabled = false; return toast('warning', 'Enter the new type name.'); }
              var ex = S.types.find(function (t) { return t.name.toLowerCase() === tn.toLowerCase(); });
              if (ex) typeId = ex.id; else { var tr = await db().from('hr_asset_types').insert([{ name: tn }]).select('id').single(); if (tr.error) throw tr.error; typeId = tr.data.id; }
            }
            var row = { name: name, type_id: typeId, asset_code: code || null, brand: v(ov, 'ca-brand') || null, model: v(ov, 'ca-model') || null, serial_number: v(ov, 'ca-serial') || null,
              condition: v(ov, 'ca-cond') || null, purchase_date: v(ov, 'ca-pdate') || null, document_url: v(ov, 'ca-doc') || null, notes: v(ov, 'ca-notes') || null };
            if (asset) {
              row.updated_at = new Date().toISOString();
              var u = await db().from('hr_assets').update(row).eq('id', asset.id); if (u.error) throw u.error;
              var changed = Object.keys(row).filter(function (k) { return k !== 'updated_at' && String(row[k] || '') !== String(asset[k] || ''); });
              if (changed.length) await logEvent(asset.id, 'edited', { details: { fields: changed } });
            } else {
              row.created_by = actor().name; row.status = 'available';
              var ins = await db().from('hr_assets').insert([row]).select('*').single(); if (ins.error) throw ins.error;
              await logEvent(ins.data.id, 'created', { details: { name: name, code: code || null } });
              var empId = v(ov, 'ca-emp');
              if (empId) await assign(ins.data, empId, v(ov, 'ca-adate'), row.condition, null, 'assigned');
            }
            close(); toast('success', asset ? 'Asset updated.' : 'Asset added.'); await refresh();
          } catch (e) { btn.disabled = false; toast('error', 'Could not save the asset: ' + (e.message || e)); }
        };
      }, 'xl');
  }
  function openAssign(asset, transfer) {
    var cur = asset.current_employee_id;
    var body = (transfer ? '<p style="margin:0;color:var(--tx-3, #a5adcf);font-size:13px">Currently with <b style="color:var(--tx-0, #fff)">' + esc(empName(cur)) + '</b>. Their assignment is closed first, then a new one starts — both stay in the history.</p>' : '')
      + fld(transfer ? 'Transfer to' : 'Assign to', '<select id="ca-to" class="hr-select w-full">' + empOptions('', transfer ? cur : '') + '</select>', true)
      + '<div class="hfm-g2">' + fld(transfer ? 'Transfer date' : 'Assigned date', '<input id="ca-d" type="date" class="hr-input" value="' + today() + '">', true)
      + fld('Condition', '<select id="ca-c" class="hr-select w-full">' + condOptions(asset.condition) + '</select>') + '</div>'
      + fld('Notes', '<textarea id="ca-n" class="hr-input" rows="2"></textarea>');
    modal(transfer ? 'Transfer asset' : 'Assign asset', (asset.name || '') + (asset.asset_code ? ' · ' + asset.asset_code : ''), body,
      foot('<button type="button" class="hfm-btn hfm-pri brand-gradient" data-save>' + (transfer ? 'Transfer' : 'Assign') + '</button>'), function (ov, close) {
        ov.querySelector('[data-save]').onclick = async function () {
          var to = v(ov, 'ca-to'), d = v(ov, 'ca-d'), btn = this;
          if (!to || !d) return toast('warning', 'Choose the employee and date.');
          btn.disabled = true;
          try {
            if (transfer || S.open[asset.id]) await closeOpen(asset, d, v(ov, 'ca-c'), v(ov, 'ca-n'), 'transferred');
            var had = transfer ? null : await db().from('hr_asset_assignments').select('id').eq('asset_id', asset.id).limit(1);
            await assign(asset, to, d, v(ov, 'ca-c'), v(ov, 'ca-n'), transfer ? 'transferred' : (had && (had.data || []).length ? 'reassigned' : 'assigned'), transfer ? cur : null);
            close(); toast('success', transfer ? 'Asset transferred to ' + empName(to) + '.' : 'Asset assigned to ' + empName(to) + '.'); await refresh();
          } catch (e) { btn.disabled = false; toast('error', 'Could not ' + (transfer ? 'transfer' : 'assign') + ': ' + (e.message || e)); }
        };
      });
  }
  function openReturn(asset, after) {
    var body = '<p style="margin:0;color:var(--tx-3, #a5adcf);font-size:13px">Returning from <b style="color:var(--tx-0, #fff)">' + esc(empName(asset.current_employee_id)) + '</b>. Their assignment stays in the history.</p>'
      + '<div class="hfm-g2">' + fld('Return date', '<input id="ca-d" type="date" class="hr-input" value="' + today() + '">', true)
      + fld('Return condition', '<select id="ca-c" class="hr-select w-full">' + condOptions(asset.condition) + '</select>') + '</div>'
      + fld('Asset status after return', '<select id="ca-s" class="hr-select w-full"><option value="available">Available</option><option value="returned">Returned</option><option value="repair">Repair / Maintenance</option><option value="retired">Retired</option></select>', true)
      + fld('Notes', '<textarea id="ca-n" class="hr-input" rows="2"></textarea>');
    modal('Return asset', (asset.name || '') + (asset.asset_code ? ' · ' + asset.asset_code : ''), body,
      foot('<button type="button" class="hfm-btn hfm-pri brand-gradient" data-save>Record return</button>'), function (ov, close) {
        ov.querySelector('[data-save]').onclick = async function () {
          var d = v(ov, 'ca-d'), st = v(ov, 'ca-s'), btn = this; if (!d) return toast('warning', 'Enter the return date.');
          btn.disabled = true;
          try {
            var prev = await closeOpen(asset, d, v(ov, 'ca-c'), v(ov, 'ca-n'), 'returned');
            var up = await db().from('hr_assets').update({ status: st, condition: v(ov, 'ca-c') || asset.condition, current_employee_id: null, current_assignment_id: null, updated_at: new Date().toISOString() }).eq('id', asset.id);
            if (up.error) throw up.error;
            await logEvent(asset.id, 'returned', { employee_id: prev ? prev.employee_id : asset.current_employee_id, details: { date: d, condition: v(ov, 'ca-c') || null, status_after: st, notes: v(ov, 'ca-n') || null } });
            if (st === 'repair' || st === 'retired') await logEvent(asset.id, st, { details: { via: 'return' } });
            close(); toast('success', 'Return recorded.'); await refresh(); if (after) after();
          } catch (e) { btn.disabled = false; toast('error', 'Could not record the return: ' + (e.message || e)); }
        };
      });
  }
  async function setStatus(asset, st) {
    var labels = { repair: 'Send for repair', retired: 'Retire asset', available: 'Mark available' };
    if (asset.current_employee_id && st !== 'repair') return toast('warning', 'Return the asset from ' + empName(asset.current_employee_id) + ' first.');
    if (window.showConfirm && !(await showConfirm(st === 'retired' ? 'It stays in the list and history, but can no longer be assigned.' : 'The status change is added to the asset history.', { title: labels[st] + '?', confirmLabel: labels[st], danger: st === 'retired' }))) return;
    var u = await db().from('hr_assets').update({ status: st, updated_at: new Date().toISOString() }).eq('id', asset.id);
    if (u.error) return toast('error', u.error.message);
    await logEvent(asset.id, st === 'available' ? 'status' : st, { details: { status: st } });
    toast('success', 'Status updated.'); await refresh();
  }
  var EV = { created: 'Created', assigned: 'Assigned', reassigned: 'Reassigned', returned: 'Returned', transferred: 'Transferred', repair: 'Sent for repair', retired: 'Retired', status: 'Status changed', edited: 'Details edited' };
  async function openView(asset) {
    var r = await Promise.all([
      db().from('hr_asset_events').select('*').eq('asset_id', asset.id).order('created_at'),
      db().from('hr_asset_assignments').select('*').eq('asset_id', asset.id).order('assigned_date')
    ]);
    var evs = r[0].data || [], asg = r[1].data || [];
    var fact = function (k, val) { return '<div><span>' + k + '</span><b>' + (val || '—') + '</b></div>'; };
    var body = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + pill(asset.status) + (asset.current_employee_id ? '<span style="color:var(--tx-3, #a5adcf);font-size:13px">with <b style="color:var(--tx-0, #fff)">' + esc(empName(asset.current_employee_id)) + '</b></span>' : '') + '</div>'
      + '<div class="ca-facts">' + fact('Type', esc(typeName(asset.type_id))) + fact('Asset ID', esc(asset.asset_code)) + fact('Brand / model', esc([asset.brand, asset.model].filter(Boolean).join(' '))) + fact('Serial number', esc(asset.serial_number))
      + fact('Condition', esc(asset.condition)) + fact('Purchase date', fmtD(asset.purchase_date))
      + fact('Document', asset.document_url ? '<a href="' + esc(asset.document_url) + '" target="_blank" rel="noopener" style="color:var(--fg-blue, #60a5fa)">Open link</a>' : '') + fact('Notes', esc(asset.notes)) + '</div>'
      + '<div><p class="hfm-l" style="margin:4px 0 8px">Holders</p>' + (asg.length ? '<div class="ca-list">' + asg.map(function (x) {
          return '<div class="ca-item"><div><b>' + esc(empName(x.employee_id)) + '</b><span>' + fmtD(x.assigned_date) + ' → ' + (x.returned_date ? fmtD(x.returned_date) + ' · ' + (x.end_reason === 'transferred' ? 'transferred' : 'returned') + (x.return_condition ? ' (' + esc(x.return_condition) + ')' : '') : '<b style="display:inline;color:var(--fg-emerald, #34d399)">current</b>') + '</span></div></div>';
        }).join('') + '</div>' : '<p class="hrp-empty" style="margin:0">Never assigned.</p>') + '</div>'
      + '<div><p class="hfm-l" style="margin:4px 0 10px">History</p><div class="ca-tl">' + evs.map(function (e) {
          var who = e.employee_id ? ' — ' + esc(empName(e.employee_id)) : '', from = e.from_employee_id ? ' (from ' + esc(empName(e.from_employee_id)) + ')' : '';
          return '<div><b>' + esc(EV[e.event] || e.event) + '</b>' + who + from + '<em>' + esc(fmtDT(e.created_at)) + (e.actor_name ? ' · by ' + esc(e.actor_name) : '') + '</em></div>';
        }).join('') + '</div></div>';
    var btns = '<button type="button" class="hfm-btn" data-x>Close</button>'
      + (asset.status !== 'retired' ? '<button type="button" class="hfm-btn" data-a="edit">Edit</button>' : '')
      + (asset.status === 'assigned' ? '<button type="button" class="hfm-btn" data-a="return">Return</button><button type="button" class="hfm-btn" data-a="transfer">Transfer</button>' : '')
      + (asset.status !== 'assigned' && asset.status !== 'retired' ? '<button type="button" class="hfm-btn hfm-pri brand-gradient" data-a="assign">Assign</button>' : '')
      + (asset.status !== 'repair' && asset.status !== 'retired' && asset.status !== 'assigned' ? '<button type="button" class="hfm-btn" data-a="repair">Send for repair</button>' : '')
      + (asset.status === 'repair' || asset.status === 'returned' || asset.status === 'retired' ? '<button type="button" class="hfm-btn" data-a="available">Mark available</button>' : '')
      + (asset.status !== 'retired' && asset.status !== 'assigned' ? '<button type="button" class="hfm-btn" data-a="retired" style="color:var(--fg-red, #f87171)">Retire</button>' : '');
    modal(asset.name || 'Asset', asset.asset_code || typeName(asset.type_id), body, '<span></span><div class="hfm-btns" style="flex-wrap:wrap">' + btns + '</div>', function (ov, close) {
      ov.querySelectorAll('[data-a]').forEach(function (b) { b.onclick = function () { var a = b.dataset.a; close(); act(a, asset); }; });
    }, true);
  }
  function act(a, asset) {
    if (a === 'view') return openView(asset);
    if (a === 'edit') return openForm(asset);
    if (a === 'assign') return openAssign(asset, false);
    if (a === 'transfer') return openAssign(asset, true);
    if (a === 'return') return openReturn(asset);
    if (a === 'repair' || a === 'retired' || a === 'available') return setStatus(asset, a);
  }

  // ── Company Assets page ──────────────────────────────────────────────────
  function filtered() {
    var f = S.f, q = f.q.toLowerCase();
    return S.assets.filter(function (a) {
      if (f.status && a.status !== f.status) return false;
      if (f.type && String(a.type_id) !== f.type) return false;
      if (f.emp && String(a.current_employee_id) !== f.emp) return false;
      if (q && [a.name, a.asset_code, a.brand, a.model, a.serial_number, typeName(a.type_id), empName(a.current_employee_id)].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function rowsHTML() {
    var list = filtered();
    if (!list.length) return '<tr><td colspan="8"><div class="ca-empty">' + (S.assets.length ? 'No assets match these filters.' : 'No company assets yet. Add the first one.') + '</div></td></tr>';
    return list.map(function (a) {
      var open = S.open[a.id];
      var acts = '<button class="hr-icon-btn" data-a="view" data-id="' + a.id + '">View</button>'
        + (a.status !== 'retired' ? '<button class="hr-icon-btn" data-a="edit" data-id="' + a.id + '">Edit</button>' : '')
        + (a.status === 'assigned' ? '<button class="hr-icon-btn" data-a="return" data-id="' + a.id + '">Return</button><button class="hr-icon-btn" data-a="transfer" data-id="' + a.id + '">Transfer</button>'
          : a.status !== 'retired' ? '<button class="hr-icon-btn" data-a="assign" data-id="' + a.id + '" style="color:var(--fg-blue, #60a5fa)">Assign</button>' : '');
      return '<tr class="hover:bg-white/[0.02]">'
        + '<td data-label="Asset" class="py-2.5 px-4"><div class="ca-name"><b>' + esc(a.name) + '</b><small>' + esc([a.brand, a.model].filter(Boolean).join(' ')) + '</small></div></td>'
        + '<td data-label="Type" class="py-2.5 px-4">' + esc(typeName(a.type_id)) + '</td>'
        + '<td data-label="Asset ID" class="py-2.5 px-4"><span class="ca-code">' + esc(a.asset_code || '—') + '</span></td>'
        + '<td data-label="Assigned To" class="py-2.5 px-4">' + (a.current_employee_id ? '<span style="display:flex;align-items:center;gap:8px">' + (typeof hrAvatarForEmployeeId === 'function' ? hrAvatarForEmployeeId(a.current_employee_id, 24) : '') + esc(empName(a.current_employee_id)) + '</span>' : '<span style="color:var(--tx-6, #6b74a0)">—</span>') + '</td>'
        + '<td data-label="Condition" class="py-2.5 px-4">' + esc(a.condition || '—') + '</td>'
        + '<td data-label="Status" class="py-2.5 px-4">' + pill(a.status) + '</td>'
        + '<td data-label="Assigned Date" class="py-2.5 px-4">' + (open ? fmtD(open.assigned_date) : '—') + '</td>'
        + '<td data-label="Actions" class="py-2.5 px-4"><div class="ca-acts">' + acts + '</div></td></tr>';
    }).join('');
  }
  function paint() {
    var h = S.host; if (!h) return;
    if (!S.ok) { h.innerHTML = '<div class="card glass-card p-6 rounded-2xl"><h1 class="text-xl font-bold tracking-tight">Company Assets</h1><p class="text-[#6b74a0] text-sm mt-2">One-time database update needed: run <code>20261024_dept_holidays_and_assets.sql</code> in Supabase, then reopen this page.</p></div>'; return; }
    var c = { total: S.assets.length, assigned: 0, available: 0, repair: 0 };
    S.assets.forEach(function (a) { if (c[a.status] != null) c[a.status]++; });
    var f = S.f;
    var empsWith = activeEmps().concat(emps().filter(function (e) { return S.assets.some(function (a) { return String(a.current_employee_id) === String(e.id); }) && (e.employment_status || 'active') !== 'active'; }));
    h.innerHTML = '<div class="space-y-4"><div class="ca-top"><div><h1 class="text-xl font-bold tracking-tight">Company Assets</h1><p class="text-[#6b74a0] text-xs mt-1">Company-owned equipment and who has it. Every hand-over stays in the history.</p></div>'
      + '<button type="button" data-add class="brand-gradient text-white text-xs font-bold px-4 py-2.5 rounded-xl uppercase tracking-wider">+ Add Asset</button></div>'
      + '<div class="ca-kpis"><div class="ca-kpi"><b>' + c.total + '</b><span>Total</span></div><div class="ca-kpi"><b>' + c.assigned + '</b><span>Assigned</span></div><div class="ca-kpi"><b>' + c.available + '</b><span>Available</span></div><div class="ca-kpi"><b>' + c.repair + '</b><span>In repair</span></div></div>'
      + '<div class="ca-filters"><input class="hr-input ca-q" data-f="q" placeholder="Search name, ID, serial, employee…" value="' + esc(f.q) + '">'
      + '<select class="hr-select" data-f="status"><option value="">All statuses</option>' + Object.keys(ST).map(function (k) { return '<option value="' + k + '"' + (f.status === k ? ' selected' : '') + '>' + ST[k].l + '</option>'; }).join('') + '</select>'
      + '<select class="hr-select" data-f="type"><option value="">All types</option>' + S.types.map(function (t) { return '<option value="' + t.id + '"' + (f.type === String(t.id) ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</select>'
      + '<select class="hr-select" data-f="emp"><option value="">All employees</option>' + empsWith.map(function (e) { return '<option value="' + e.id + '"' + (f.emp === String(e.id) ? ' selected' : '') + '>' + esc(e.full_name) + '</option>'; }).join('') + '</select></div>'
      + '<div class="card glass-card rounded-2xl overflow-x-auto"><table class="w-full text-sm text-left"><thead><tr class="text-[#6b74a0] text-[11px] uppercase tracking-wider border-b border-white/[0.06]">'
      + ['Asset', 'Type', 'Asset ID', 'Assigned To', 'Condition', 'Status', 'Assigned Date', ''].map(function (x) { return '<th class="py-3 px-4">' + x + '</th>'; }).join('')
      + '</tr></thead><tbody id="ca-rows" class="divide-y divide-white/[0.05]">' + rowsHTML() + '</tbody></table></div></div>';
    h.querySelector('[data-add]').onclick = function () { openForm(null); };
    h.querySelectorAll('[data-f]').forEach(function (el) {
      el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', function () { S.f[el.dataset.f] = el.value; h.querySelector('#ca-rows').innerHTML = rowsHTML(); });
    });
    h.onclick = function (e) {
      var b = e.target.closest('[data-a][data-id]'); if (!b) return;
      var a = S.assets.find(function (x) { return String(x.id) === b.dataset.id; }); if (a) act(b.dataset.a, a);
    };
  }
  async function refresh() {
    await load(); paint();
    if (S.empEl && S.empRow && document.body.contains(S.empEl)) renderEmployee(S.empEl, S.empRow);
  }

  // ── Employee Details → Company Assets ────────────────────────────────────
  async function renderEmployee(el, emp) {
    css(); S.empEl = el; S.empRow = emp;
    if (!S.loaded) await load();
    if (!S.ok) { el.innerHTML = '<p class="hrp-empty">Company Assets needs the database update 20261024_dept_holidays_and_assets.sql.</p>'; return; }
    var r = await db().from('hr_asset_assignments').select('*').eq('employee_id', emp.id).order('assigned_date', { ascending: false });
    var rows = r.data || [], cur = rows.filter(function (x) { return !x.returned_date; }), past = rows.filter(function (x) { return x.returned_date; });
    var aById = {}; S.assets.forEach(function (a) { aById[a.id] = a; });
    var item = function (x, current) {
      var a = aById[x.asset_id] || { name: 'Asset' };
      return '<div class="ca-item"><span class="ca-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg></span><div><b>' + esc(a.name) + '</b><span>'
        + esc([a.asset_code, typeName(a.type_id)].filter(function (s) { return s && s !== '—'; }).join(' · ')) + '</span><span>Assigned ' + fmtD(x.assigned_date) + (current ? '' : ' · ' + (x.end_reason === 'transferred' ? 'Transferred' : 'Returned') + ' ' + fmtD(x.returned_date)) + '</span></div>'
        + (current && a.id ? '<button class="hr-icon-btn" data-er="' + a.id + '">Return</button>' : '') + '</div>';
    };
    el.innerHTML = (cur.length ? '<div class="ca-list">' + cur.map(function (x) { return item(x, true); }).join('') + '</div>' : '<p class="hrp-empty">No company assets assigned.</p>')
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="hr-icon-btn" data-ea style="color:var(--fg-blue, #60a5fa)">+ Assign an asset</button></div>'
      + (past.length ? '<p class="hfm-l" style="margin:16px 0 8px">Previously held</p><div class="ca-list" style="opacity:.75">' + past.map(function (x) { return item(x, false); }).join('') + '</div>' : '');
    el.onclick = function (e) {
      var rb = e.target.closest('[data-er]'); if (rb) { var a = S.assets.find(function (x) { return String(x.id) === rb.dataset.er; }); if (a) openReturn(a); return; }
      if (e.target.closest('[data-ea]')) pickForEmployee(emp);
    };
  }
  function pickForEmployee(emp) {
    var free = S.assets.filter(function (a) { return a.status === 'available' || a.status === 'returned'; });
    if (!free.length) return toast('warning', 'No available assets. Add one in HR → Company Assets.');
    var body = fld('Asset', '<select id="ca-pick" class="hr-select w-full"><option value="">Select asset…</option>' + free.map(function (a) { return '<option value="' + a.id + '">' + esc(a.name) + (a.asset_code ? ' — ' + esc(a.asset_code) : '') + '</option>'; }).join('') + '</select>', true)
      + fld('Assigned date', '<input id="ca-d" type="date" class="hr-input" value="' + today() + '">', true);
    modal('Assign asset to ' + emp.full_name, '', body, foot('<button type="button" class="hfm-btn hfm-pri brand-gradient" data-save>Assign</button>'), function (ov, close) {
      ov.querySelector('[data-save]').onclick = async function () {
        var id = v(ov, 'ca-pick'), d = v(ov, 'ca-d'), btn = this; if (!id || !d) return toast('warning', 'Choose the asset and date.');
        var a = S.assets.find(function (x) { return String(x.id) === id; }); btn.disabled = true;
        try { await assign(a, emp.id, d, a.condition, null, 'assigned'); close(); toast('success', 'Asset assigned.'); await refresh(); }
        catch (e) { btn.disabled = false; toast('error', 'Could not assign: ' + (e.message || e)); }
      };
    });
  }

  // ── Exit / inactive guard ───────────────────────────────────────────────
  async function exitCheck(emp) {
    css(); await load();
    if (!S.ok) return true;
    var held = S.assets.filter(function (a) { return String(a.current_employee_id) === String(emp.id); });
    if (!held.length) return true;
    return new Promise(function (resolve) {
      var done = false, fin = function (val, close) { if (done) return; done = true; close(); resolve(val); };
      var list = function () {
        var still = S.assets.filter(function (a) { return String(a.current_employee_id) === String(emp.id); });
        return still.length ? '<div class="ca-list">' + still.map(function (a) { return '<div class="ca-item"><div><b>' + esc(a.name) + '</b><span>' + esc(a.asset_code || typeName(a.type_id)) + '</span></div><button class="hr-icon-btn" data-ret="' + a.id + '">Return</button></div>'; }).join('') + '</div>'
          : '<p style="margin:0;color:var(--fg-emerald, #34d399);font-weight:700">All assets returned.</p>';
      };
      var m = modal('Company assets are still assigned to this employee.', emp.full_name, '<p style="margin:0;color:var(--tx-3, #a5adcf);font-size:13px">Return them now, or continue and keep them on record as still held by ' + esc(emp.full_name) + '.</p><div id="ca-exit-list">' + list() + '</div>',
        '<span></span><div class="hfm-btns"><button type="button" class="hfm-btn" data-cancel>Cancel</button><button type="button" class="hfm-btn hfm-pri brand-gradient" data-go>Continue</button></div>', function (ov, close) {
          ov.querySelector('[data-cancel]').onclick = function () { fin(false, close); };
          ov.querySelector('[data-go]').onclick = function () { fin(true, close); };
          ov.querySelector('[data-x]').onclick = function () { fin(false, close); };
          ov.addEventListener('click', function (e) {
            var b = e.target.closest('[data-ret]'); if (!b) return;
            var a = S.assets.find(function (x) { return String(x.id) === b.dataset.ret; });
            if (a) openReturn(a, function () { var l = ov.querySelector('#ca-exit-list'); if (l) l.innerHTML = list(); });
          });
        });
    });
  }

  window.HRAssets = {
    render: async function (host) { css(); S.host = host; if (!S.loaded) host.innerHTML = '<div class="ca-empty">Loading assets…</div>'; await load(); paint(); },
    renderEmployee: renderEmployee,
    add: async function () { css(); if (!S.loaded) await load(); if (!S.ok) return toast('error', 'Run 20261024_dept_holidays_and_assets.sql first.'); openForm(null); },
    exitCheck: exitCheck,
    reload: refresh
  };
  if (window.BELive) BELive.on('hr-assets', ['hr_assets', 'hr_asset_assignments', 'hr_asset_types'], function () { if (S.loaded && S.host && document.body.contains(S.host) && !S.host.closest('.hidden')) refresh(); }, { debounce: 600 });
})();
