/* ============================================================================
   BESelect — ONE shared branded dropdown for index.html, academics.html and
   hr.html (loaded like sidebar-collapse.js). It never touches business logic:
   every native <select> stays in the DOM as the single source of truth (its
   value, options, change/input events, disabled state and dynamic/realtime
   option updates are all unchanged). Picking a branded option writes
   select.value and dispatches real 'input'+'change' events, so every existing
   handler, filter query and form submission fires exactly as before.

   Why a real trigger element (v2): simply preventing the native popup on
   mousedown was NOT reliable across browsers (macOS Chrome still showed the
   white OS list). So the native <select> is now visually hidden (kept for
   value + events) and a branded trigger is rendered in its place, guaranteeing
   the OS popup can never appear. The trigger copies the select's OWN computed
   style (background, border, radius, padding, font, colour, flex/width/margin),
   so it looks identical to however each page already styles that select and
   keeps the same layout footprint — no page CSS duplicated, nothing hardcoded.

   - Menu is portalled to <body>, fixed-positioned (z-index above every modal),
     never clipped by overflow; flips up when there's no room below; repositions
     on scroll/resize.
   - Search box appears for long lists; max-height + internal scroll.
   - Full keyboard + aria; explicit dark colours (independent of OS light mode).
   - Skips <select multiple> and [data-native]; re-syncs on backend/realtime
     option or value changes; auto-enhances selects added later.
   ============================================================================ */
(function () {
  if (window.__beSelectInit) return;
  window.__beSelectInit = true;

  var CSS = [
    ':root{',
    '--be-sel-bg-menu:#0d1119;--be-sel-border:rgba(255,255,255,.12);',
    '--be-sel-text:#f2f3f7;--be-sel-muted:#8b93ad;--be-sel-hover:rgba(255,255,255,.06);',
    '--be-sel-selected:rgba(255,107,6,.16);--be-sel-accent:#ff6b06;',
    '--be-sel-radius:10px;--be-sel-shadow:0 18px 44px rgba(0,0,0,.6);}',
    '.be-sel-wrap{position:relative;box-sizing:border-box;}',
    '.be-sel-native{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;',
    'opacity:0!important;pointer-events:none!important;margin:0!important;}',
    '.be-sel-trigger{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;cursor:pointer;',
    'color:var(--be-sel-text);outline:none;overflow:hidden;}',
    '.be-sel-trigger[aria-disabled="true"]{opacity:.5;cursor:not-allowed;}',
    '.be-sel-trigger:focus-visible{border-color:var(--be-sel-accent)!important;box-shadow:0 0 0 2px rgba(255,107,6,.35)!important;}',
    '.be-sel-trigger[data-be-open]{border-color:var(--be-sel-accent)!important;}',
    '.be-sel-value{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;}',
    '.be-sel-value[data-placeholder]{color:var(--be-sel-muted);}',
    '.be-sel-chev{flex:0 0 auto;width:12px;height:12px;color:var(--be-sel-muted);transition:transform .15s;}',
    '.be-sel-trigger[data-be-open] .be-sel-chev{transform:rotate(180deg);}',
    '.be-sel-menu{position:fixed;z-index:3000;background:var(--be-sel-bg-menu);border:1px solid var(--be-sel-border);',
    'border-radius:var(--be-sel-radius);box-shadow:var(--be-sel-shadow);padding:5px;box-sizing:border-box;',
    'display:none;flex-direction:column;max-height:min(320px,60vh);overflow:hidden;font-size:13px;color:var(--be-sel-text);}',
    '.be-sel-menu[data-open]{display:flex;}',
    '.be-sel-search{flex:0 0 auto;margin:2px 2px 6px;background:rgba(255,255,255,.05);border:1px solid var(--be-sel-border);',
    'border-radius:8px;padding:8px 10px;color:var(--be-sel-text);font-size:13px;outline:none;}',
    '.be-sel-search::placeholder{color:var(--be-sel-muted);}',
    '.be-sel-list{overflow-y:auto;overflow-x:hidden;flex:1 1 auto;}',
    '.be-sel-opt{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:7px;cursor:pointer;',
    'color:var(--be-sel-text);line-height:1.25;min-height:38px;box-sizing:border-box;white-space:normal;word-break:break-word;}',
    '.be-sel-opt:hover,.be-sel-opt[data-active]{background:var(--be-sel-hover);}',
    '.be-sel-opt[data-selected]{background:var(--be-sel-selected);color:#fff;}',
    '.be-sel-opt[data-selected] .be-sel-check{opacity:1;}',
    '.be-sel-opt[data-disabled]{opacity:.4;cursor:not-allowed;}',
    '.be-sel-check{flex:0 0 14px;width:14px;color:var(--be-sel-accent);opacity:0;font-weight:800;text-align:center;}',
    '.be-sel-optlabel{flex:1 1 auto;}',
    '.be-sel-group{padding:8px 10px 4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--be-sel-muted);}',
    '.be-sel-empty{padding:12px 10px;color:var(--be-sel-muted);text-align:center;}',
    '.be-sel-list::-webkit-scrollbar{width:9px;}',
    '.be-sel-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:8px;border:2px solid var(--be-sel-bg-menu);}',
    '.be-sel-list::-webkit-scrollbar-track{background:transparent;}',
    '@media (max-width:640px){.be-sel-opt{min-height:44px;font-size:14px;}.be-sel-menu{font-size:14px;}}'
  ].join('');

  var style = document.createElement('style');
  style.id = 'be-select-styles';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);

  var CHEV = '<svg class="be-sel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  var menu = null, list = null, search = null;
  var openSelect = null, openTrigger = null;
  var activeIndex = -1, rows = [];

  function buildMenu() {
    menu = document.createElement('div');
    menu.className = 'be-sel-menu';
    menu.setAttribute('role', 'listbox');
    search = document.createElement('input');
    search.className = 'be-sel-search';
    search.type = 'text';
    search.setAttribute('placeholder', 'Search…');
    search.setAttribute('aria-label', 'Search options');
    list = document.createElement('div');
    list.className = 'be-sel-list';
    menu.appendChild(search);
    menu.appendChild(list);
    document.body.appendChild(menu);
    search.addEventListener('input', function () { renderOptions(search.value); });
    search.addEventListener('keydown', onMenuKey);
    menu.addEventListener('mousedown', function (e) { if (e.target !== search) e.preventDefault(); });
  }

  function optionText(o) { return (o.textContent || '').trim(); }

  function currentLabel(select) {
    var o = select.options[select.selectedIndex];
    return o ? optionText(o) : '';
  }

  function refreshTrigger(select) {
    var t = select.__beTrigger;
    if (!t) return;
    var val = t.querySelector('.be-sel-value');
    var o = select.options[select.selectedIndex];
    var label = o ? optionText(o) : '';
    val.textContent = label || (select.getAttribute('data-placeholder') || 'Select…');
    if (label) val.removeAttribute('data-placeholder'); else val.setAttribute('data-placeholder', '');
    if (select.disabled) t.setAttribute('aria-disabled', 'true'); else t.removeAttribute('aria-disabled');
    t.setAttribute('tabindex', select.disabled ? '-1' : '0');
  }

  function renderOptions(filter) {
    if (!openSelect) return;
    filter = (filter || '').trim().toLowerCase();
    list.innerHTML = '';
    rows = [];
    var opts = openSelect.options, anyShown = false, curVal = openSelect.value, lastGroup = null;
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i], label = optionText(o);
      if (filter && label.toLowerCase().indexOf(filter) === -1) continue;
      var grp = o.parentNode && o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.getAttribute('label') : null;
      if (grp && grp !== lastGroup) {
        var gh = document.createElement('div'); gh.className = 'be-sel-group'; gh.textContent = grp; list.appendChild(gh); lastGroup = grp;
      }
      var row = document.createElement('div');
      row.className = 'be-sel-opt';
      row.setAttribute('role', 'option');
      if (o.value === curVal) { row.setAttribute('data-selected', ''); row.setAttribute('aria-selected', 'true'); }
      if (o.disabled) row.setAttribute('data-disabled', '');
      row.innerHTML = '<span class="be-sel-check">✓</span><span class="be-sel-optlabel"></span>';
      row.querySelector('.be-sel-optlabel').textContent = label || ' ';
      (function (optIndex, disabled) { row.addEventListener('click', function () { if (!disabled) commit(optIndex); }); })(i, o.disabled);
      list.appendChild(row);
      if (!o.disabled) rows.push({ el: row, optionIndex: i });
      anyShown = true;
    }
    if (!anyShown) { var em = document.createElement('div'); em.className = 'be-sel-empty'; em.textContent = 'No matches'; list.appendChild(em); }
    activeIndex = rows.findIndex(function (r) { return openSelect.options[r.optionIndex].value === curVal; });
    if (activeIndex < 0 && rows.length) activeIndex = 0;
    paintActive();
  }

  function paintActive() {
    rows.forEach(function (r, i) {
      if (i === activeIndex) { r.el.setAttribute('data-active', ''); r.el.scrollIntoView({ block: 'nearest' }); }
      else r.el.removeAttribute('data-active');
    });
  }

  function commit(optionIndex) {
    if (!openSelect) return;
    var o = openSelect.options[optionIndex];
    if (!o || o.disabled) return;
    if (openSelect.value !== o.value) {
      openSelect.value = o.value;
      openSelect.dispatchEvent(new Event('input', { bubbles: true }));
      openSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refreshTrigger(openSelect);
    close();
  }

  function position() {
    if (!openTrigger || !menu) return;
    var r = openTrigger.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var width = Math.max(r.width, 180);
    if (vw < 640) width = Math.min(width, vw - 16);
    menu.style.width = width + 'px';
    menu.style.left = Math.min(Math.max(8, r.left), vw - width - 8) + 'px';
    var mh = menu.offsetHeight || 260;
    var spaceBelow = vh - r.bottom, spaceAbove = r.top;
    if (spaceBelow < mh + 8 && spaceAbove > spaceBelow) menu.style.top = Math.max(8, r.top - mh - 6) + 'px';
    else menu.style.top = (r.bottom + 6) + 'px';
  }

  function open(select) {
    if (openSelect === select) return;
    if (openSelect) close();
    if (select.disabled) return;
    if (!menu) buildMenu();
    openSelect = select; openTrigger = select.__beTrigger;
    openTrigger.setAttribute('data-be-open', '');
    openTrigger.setAttribute('aria-expanded', 'true');
    var many = select.options.length > 8;
    search.style.display = many ? '' : 'none';
    search.value = '';
    menu.setAttribute('data-open', '');
    renderOptions('');
    position();
    if (many) { try { search.focus(); } catch (e) {} }
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    document.addEventListener('mousedown', onDocDown, true);
  }

  function close() {
    if (!openSelect) return;
    var t = openTrigger;
    openTrigger.removeAttribute('data-be-open');
    openTrigger.setAttribute('aria-expanded', 'false');
    openSelect = null; openTrigger = null;
    if (menu) menu.removeAttribute('data-open');
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('mousedown', onDocDown, true);
    try { t.focus(); } catch (e) {}
  }

  function onDocDown(e) {
    if (menu && menu.contains(e.target)) return;
    if (openTrigger && openTrigger.contains(e.target)) return;
    close();
  }

  function onMenuKey(e) {
    if (!openSelect) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (activeIndex >= 0 && rows[activeIndex]) commit(rows[activeIndex].optionIndex); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) { activeIndex = Math.min(rows.length - 1, activeIndex + 1); paintActive(); } return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) { activeIndex = Math.max(0, activeIndex - 1); paintActive(); } return; }
    if (e.key === 'Home') { e.preventDefault(); if (rows.length) { activeIndex = 0; paintActive(); } return; }
    if (e.key === 'End') { e.preventDefault(); if (rows.length) { activeIndex = rows.length - 1; paintActive(); } return; }
  }

  function onTriggerKey(e) {
    var select = e.currentTarget.__beSelect;
    if (openSelect === select) { onMenuKey(e); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault(); open(select);
    }
  }

  // Copy the properties that make the trigger look and sit exactly like the native select the
  // page already styled — read from getComputedStyle so it matches whatever CSS applied, per
  // page, with nothing hardcoded.
  var COPY = ['backgroundColor', 'backgroundImage', 'border', 'borderRadius', 'boxShadow', 'fontFamily',
    'fontSize', 'fontWeight', 'letterSpacing', 'color', 'paddingTop', 'paddingRight', 'paddingBottom',
    'paddingLeft', 'minHeight', 'height', 'lineHeight', 'textTransform'];

  function enhance(select) {
    if (!select || select.tagName !== 'SELECT') return;
    if (select.multiple || select.size > 1) return;
    if (select.hasAttribute('data-native')) return;
    if (select.__beEnhanced) return;
    select.__beEnhanced = true;

    var cs = getComputedStyle(select);
    var wrap = document.createElement('span');
    wrap.className = 'be-sel-wrap';
    // Preserve the select's own layout footprint (flex grow / width / margin / display).
    wrap.style.display = (cs.display === 'block') ? 'block' : 'inline-block';
    if (parseFloat(cs.flexGrow) > 0 || (select.style.flex && select.style.flex !== 'none')) wrap.style.flex = cs.flex;
    if (select.style.width || cs.width) wrap.style.width = select.style.width || cs.width;
    if (select.style.minWidth || cs.minWidth !== '0px') wrap.style.minWidth = select.style.minWidth || cs.minWidth;
    wrap.style.margin = cs.margin;
    wrap.style.verticalAlign = 'middle';

    var trigger = document.createElement('div');
    trigger.className = 'be-sel-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('tabindex', select.disabled ? '-1' : '0');
    COPY.forEach(function (p) { try { trigger.style[p] = cs[p]; } catch (e) {} });
    trigger.style.boxSizing = 'border-box';
    trigger.style.width = '100%';
    trigger.innerHTML = '<span class="be-sel-value"></span>' + CHEV;

    // Put the wrapper where the select is, move the select inside (hidden), add the trigger.
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(trigger);
    select.classList.add('be-sel-native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');
    select.__beTrigger = trigger;
    trigger.__beSelect = select;

    refreshTrigger(select);

    trigger.addEventListener('mousedown', function (e) { e.preventDefault(); if (select.disabled) return; if (openSelect === select) close(); else open(select); });
    // Stop a wrapping <label> from forwarding this click to the hidden native <select> (which
    // would open the OS dropdown on top of the branded menu).
    trigger.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    trigger.addEventListener('keydown', onTriggerKey);
    // Keep the trigger label + an open menu in sync when the app rebuilds options or changes
    // value/disabled programmatically (backend-driven / realtime).
    var mo = new MutationObserver(function () { refreshTrigger(select); if (openSelect === select) renderOptions(search.value); });
    mo.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'value'] });
    // Some code sets select.value without firing change; catch the common "rebuild options then
    // set value" pattern by also refreshing on the next tick after any option mutation.
    select.addEventListener('change', function () { refreshTrigger(select); });
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll ? (root || document).querySelectorAll('select') : [];
    for (var i = 0; i < nodes.length; i++) enhance(nodes[i]);
  }

  function boot() {
    scan(document);
    var docMo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'SELECT') enhance(n);
          else if (n.querySelectorAll) scan(n);
        }
      }
    });
    docMo.observe(document.body, { childList: true, subtree: true });
    // Programmatic value changes (select.value = x) don't emit events or attribute mutations;
    // a light periodic sweep keeps trigger labels correct for those cases too.
    setInterval(function () {
      var sels = document.querySelectorAll('select.be-sel-native');
      for (var i = 0; i < sels.length; i++) {
        var s = sels[i], t = s.__beTrigger;
        if (!t) continue;
        var shown = t.querySelector('.be-sel-value').textContent;
        var real = currentLabel(s) || (s.getAttribute('data-placeholder') || 'Select…');
        if (shown !== real) refreshTrigger(s);
      }
    }, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* ============================================================================
   BEDate — branded dark date picker, same shared file / same 3 pages. Same
   contract as BESelect: the native <input type="date"> stays the source of
   truth (its value 'YYYY-MM-DD', min/max, disabled, and change/input events are
   unchanged); it is only hidden and driven by a branded trigger + a portalled
   dark calendar, so the white OS calendar can never appear in system light mode
   or differ across browsers. Skips [data-native]. Nothing hardcoded, no data
   behaviour changed — only the visible picker.
   ============================================================================ */
(function () {
  if (window.__beDateInit) return;
  window.__beDateInit = true;

  var CSS = [
    '.be-date-wrap{position:relative;box-sizing:border-box;}',
    '.be-date-native{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;opacity:0!important;pointer-events:none!important;margin:0!important;}',
    '.be-date-trigger{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;cursor:pointer;color:var(--be-sel-text,#f2f3f7);outline:none;}',
    '.be-date-trigger[aria-disabled="true"]{opacity:.5;cursor:not-allowed;}',
    '.be-date-trigger:focus-visible,.be-date-trigger[data-open]{border-color:var(--be-sel-accent,#ff6b06)!important;box-shadow:0 0 0 2px rgba(255,107,6,.3)!important;}',
    '.be-date-val{flex:1 1 auto;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.be-date-val[data-placeholder]{color:var(--be-sel-muted,#8b93ad);}',
    '.be-date-ico{flex:0 0 auto;width:15px;height:15px;color:var(--be-sel-muted,#8b93ad);}',
    '.be-cal{position:fixed;z-index:3000;background:var(--be-sel-bg-menu,#0d1119);border:1px solid var(--be-sel-border,rgba(255,255,255,.12));',
    'border-radius:var(--be-sel-radius,10px);box-shadow:var(--be-sel-shadow,0 18px 44px rgba(0,0,0,.6));padding:12px;box-sizing:border-box;',
    'display:none;width:290px;color:var(--be-sel-text,#f2f3f7);font-size:13px;user-select:none;}',
    '.be-cal[data-open]{display:block;}',
    '.be-cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}',
    '.be-cal-title{font-weight:700;font-size:13.5px;}',
    '.be-cal-nav{display:flex;gap:4px;}',
    '.be-cal-btn{background:rgba(255,255,255,.05);border:1px solid var(--be-sel-border,rgba(255,255,255,.12));color:var(--be-sel-text,#f2f3f7);',
    'width:30px;height:30px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;}',
    '.be-cal-btn:hover{background:rgba(255,255,255,.1);}',
    '.be-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}',
    '.be-cal-dow{text-align:center;font-size:10.5px;color:var(--be-sel-muted,#8b93ad);padding:4px 0;text-transform:uppercase;letter-spacing:.04em;}',
    '.be-cal-day{text-align:center;padding:0;height:34px;line-height:34px;border-radius:8px;cursor:pointer;font-variant-numeric:tabular-nums;}',
    '.be-cal-day:hover{background:var(--be-sel-hover,rgba(255,255,255,.06));}',
    '.be-cal-day[data-other]{color:var(--be-sel-muted,#8b93ad);opacity:.55;}',
    '.be-cal-day[data-today]{box-shadow:inset 0 0 0 1px var(--be-sel-accent,#ff6b06);}',
    '.be-cal-day[data-selected]{background:var(--be-sel-accent,#ff6b06);color:#fff;font-weight:700;}',
    '.be-cal-day[data-disabled]{opacity:.25;cursor:not-allowed;text-decoration:line-through;}',
    '.be-cal-foot{display:flex;justify-content:space-between;margin-top:10px;}',
    '.be-cal-link{background:none;border:none;color:var(--be-sel-accent,#ff6b06);cursor:pointer;font-size:12.5px;padding:4px 2px;}',
    '.be-cal-link:hover{text-decoration:underline;}',
    '@media (max-width:640px){.be-cal{width:min(320px,92vw);}}'
  ].join('');
  var st = document.createElement('style'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st);

  var CAL_ICO = '<svg class="be-date-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DOW = ['S','M','T','W','T','F','S'];

  var cal = null, calGrid = null, calTitle = null, openInput = null, viewY = 0, viewM = 0;

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function parseISO(v) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; }
  function fmtDisplay(v) { var p = parseISO(v); return p ? pad(p.d) + '/' + pad(p.m + 1) + '/' + p.y : ''; }

  function refreshTrigger(input) {
    var t = input.__beDateTrigger; if (!t) return;
    var val = t.querySelector('.be-date-val');
    var disp = fmtDisplay(input.value);
    val.textContent = disp || 'dd/mm/yyyy';
    if (disp) val.removeAttribute('data-placeholder'); else val.setAttribute('data-placeholder', '');
    if (input.disabled) { t.setAttribute('aria-disabled', 'true'); t.setAttribute('tabindex', '-1'); }
    else { t.removeAttribute('aria-disabled'); t.setAttribute('tabindex', '0'); }
  }

  function buildCal() {
    cal = document.createElement('div');
    cal.className = 'be-cal';
    cal.innerHTML =
      '<div class="be-cal-head"><span class="be-cal-title"></span><span class="be-cal-nav">' +
      '<button type="button" class="be-cal-btn" data-prev>&#8249;</button>' +
      '<button type="button" class="be-cal-btn" data-next>&#8250;</button></span></div>' +
      '<div class="be-cal-grid" data-grid></div>' +
      '<div class="be-cal-foot"><button type="button" class="be-cal-link" data-clear>Clear</button>' +
      '<button type="button" class="be-cal-link" data-today>Today</button></div>';
    calTitle = cal.querySelector('.be-cal-title');
    calGrid = cal.querySelector('[data-grid]');
    document.body.appendChild(cal);
    cal.querySelector('[data-prev]').addEventListener('click', function () { shift(-1); });
    cal.querySelector('[data-next]').addEventListener('click', function () { shift(1); });
    cal.querySelector('[data-clear]').addEventListener('click', function () { setValue(''); closeCal(); });
    cal.querySelector('[data-today]').addEventListener('click', function () { var n = new Date(); viewY = n.getFullYear(); viewM = n.getMonth(); pick(n.getFullYear(), n.getMonth(), n.getDate()); });
    cal.addEventListener('mousedown', function (e) { e.preventDefault(); });
  }

  function shift(delta) { viewM += delta; if (viewM < 0) { viewM = 11; viewY--; } else if (viewM > 11) { viewM = 0; viewY++; } renderCal(); }

  function bounds(input) {
    return { min: parseISO(input.min), max: parseISO(input.max) };
  }
  function isDisabledDay(y, m, d, b) {
    var v = y * 10000 + m * 100 + d;
    if (b.min && v < b.min.y * 10000 + b.min.m * 100 + b.min.d) return true;
    if (b.max && v > b.max.y * 10000 + b.max.m * 100 + b.max.d) return true;
    return false;
  }

  function renderCal() {
    if (!openInput) return;
    calTitle.textContent = MONTHS[viewM] + ' ' + viewY;
    calGrid.innerHTML = '';
    DOW.forEach(function (d) { var el = document.createElement('div'); el.className = 'be-cal-dow'; el.textContent = d; calGrid.appendChild(el); });
    var first = new Date(viewY, viewM, 1).getDay();
    var daysIn = new Date(viewY, viewM + 1, 0).getDate();
    var prevDays = new Date(viewY, viewM, 0).getDate();
    var sel = parseISO(openInput.value);
    var today = new Date();
    var b = bounds(openInput);
    var cells = [];
    for (var i = 0; i < first; i++) cells.push({ d: prevDays - first + 1 + i, other: -1 });
    for (var d = 1; d <= daysIn; d++) cells.push({ d: d, other: 0 });
    while (cells.length % 7 !== 0) cells.push({ d: cells.length - (first + daysIn) + 1, other: 1 });
    cells.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'be-cal-day';
      el.textContent = c.d;
      var yy = viewY, mm = viewM, dd = c.d;
      if (c.other === -1) { mm = viewM - 1; if (mm < 0) { mm = 11; yy--; } el.setAttribute('data-other', ''); }
      else if (c.other === 1) { mm = viewM + 1; if (mm > 11) { mm = 0; yy++; } el.setAttribute('data-other', ''); }
      if (yy === today.getFullYear() && mm === today.getMonth() && dd === today.getDate()) el.setAttribute('data-today', '');
      if (sel && sel.y === yy && sel.m === mm && sel.d === dd) el.setAttribute('data-selected', '');
      if (isDisabledDay(yy, mm, dd, b)) el.setAttribute('data-disabled', '');
      else el.addEventListener('click', function () { pick(yy, mm, dd); });
      calGrid.appendChild(el);
    });
  }

  function setValue(iso) {
    if (!openInput) return;
    if (openInput.value !== iso) {
      openInput.value = iso;
      openInput.dispatchEvent(new Event('input', { bubbles: true }));
      openInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refreshTrigger(openInput);
  }
  function pick(y, m, d) { setValue(toISO(y, m, d)); closeCal(); }

  function positionCal() {
    if (!openInput || !cal) return;
    var t = openInput.__beDateTrigger.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var w = cal.offsetWidth || 290, h = cal.offsetHeight || 320;
    cal.style.left = Math.min(Math.max(8, t.left), vw - w - 8) + 'px';
    if (vh - t.bottom < h + 8 && t.top > vh - t.bottom) cal.style.top = Math.max(8, t.top - h - 6) + 'px';
    else cal.style.top = (t.bottom + 6) + 'px';
  }

  function openCal(input) {
    if (openInput === input) return;
    if (openInput) closeCal();
    if (input.disabled) return;
    if (!cal) buildCal();
    openInput = input;
    var p = parseISO(input.value) || (function () { var n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; })();
    viewY = p.y; viewM = p.m;
    input.__beDateTrigger.setAttribute('data-open', '');
    cal.setAttribute('data-open', '');
    renderCal();
    positionCal();
    window.addEventListener('scroll', positionCal, true);
    window.addEventListener('resize', positionCal);
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }
  function closeCal() {
    if (!openInput) return;
    var t = openInput.__beDateTrigger;
    t.removeAttribute('data-open');
    openInput = null;
    if (cal) cal.removeAttribute('data-open');
    window.removeEventListener('scroll', positionCal, true);
    window.removeEventListener('resize', positionCal);
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    try { t.focus(); } catch (e) {}
  }
  function onDocDown(e) { if (cal && cal.contains(e.target)) return; if (openInput && openInput.__beDateTrigger.contains(e.target)) return; closeCal(); }
  function onKey(e) {
    if (!openInput) return;
    if (e.key === 'Escape') { e.preventDefault(); closeCal(); }
    else if (e.key === 'PageUp') { e.preventDefault(); shift(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); shift(1); }
  }

  function enhance(input) {
    if (!input || input.tagName !== 'INPUT' || input.type !== 'date') return;
    if (input.hasAttribute('data-native')) return;
    if (input.__beDate) return;
    input.__beDate = true;
    var cs = getComputedStyle(input);
    var wrap = document.createElement('span');
    wrap.className = 'be-date-wrap';
    wrap.style.display = (cs.display === 'block') ? 'block' : 'inline-block';
    if (parseFloat(cs.flexGrow) > 0 || (input.style.flex && input.style.flex !== 'none')) wrap.style.flex = cs.flex;
    if (input.style.width || cs.width) wrap.style.width = input.style.width || cs.width;
    wrap.style.margin = cs.margin; wrap.style.verticalAlign = 'middle';
    var trig = document.createElement('div');
    trig.className = 'be-date-trigger';
    trig.setAttribute('role', 'button');
    trig.setAttribute('aria-haspopup', 'dialog');
    trig.setAttribute('tabindex', input.disabled ? '-1' : '0');
    ['backgroundColor','backgroundImage','border','borderRadius','fontFamily','fontSize','fontWeight','color','paddingTop','paddingRight','paddingBottom','paddingLeft','minHeight','height','lineHeight']
      .forEach(function (p) { try { trig.style[p] = cs[p]; } catch (e) {} });
    trig.style.boxSizing = 'border-box'; trig.style.width = '100%';
    trig.innerHTML = '<span class="be-date-val"></span>' + CAL_ICO;
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input); wrap.appendChild(trig);
    input.classList.add('be-date-native'); input.setAttribute('tabindex', '-1'); input.setAttribute('aria-hidden', 'true');
    // BUG FIX (two calendars at once): the date input sits inside a <label>, so clicking the
    // branded trigger also forwarded a synthetic click to the native date input and opened the
    // OS calendar on top of ours. readonly stops the native date input from ever showing its own
    // picker (JS still sets its .value, and the value still submits) — belt-and-braces with the
    // trigger's own click guard below.
    input.readOnly = true;
    input.__beDateTrigger = trig; trig.__beDate = input;
    refreshTrigger(input);
    trig.addEventListener('mousedown', function (e) { e.preventDefault(); if (input.disabled) return; if (openInput === input) closeCal(); else openCal(input); });
    trig.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    trig.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openCal(input); } });
    var mo = new MutationObserver(function () { refreshTrigger(input); if (openInput === input) renderCal(); });
    mo.observe(input, { attributes: true, attributeFilter: ['value', 'min', 'max', 'disabled'] });
    input.addEventListener('change', function () { refreshTrigger(input); });
  }

  function scan(root) { var n = (root || document).querySelectorAll ? (root || document).querySelectorAll('input[type="date"]') : []; for (var i = 0; i < n.length; i++) enhance(n[i]); }
  function boot() {
    scan(document);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) { var a = muts[i].addedNodes; for (var j = 0; j < a.length; j++) { var x = a[j]; if (x.nodeType !== 1) continue; if (x.tagName === 'INPUT' && x.type === 'date') enhance(x); else if (x.querySelectorAll) scan(x); } }
    }).observe(document.body, { childList: true, subtree: true });
    // programmatic value changes (input.value = 'YYYY-MM-DD') emit no event — keep triggers synced
    setInterval(function () {
      var ins = document.querySelectorAll('input.be-date-native');
      for (var i = 0; i < ins.length; i++) { var s = ins[i], t = s.__beDateTrigger; if (!t) continue; var want = fmtDisplay(s.value) || 'dd/mm/yyyy'; if (t.querySelector('.be-date-val').textContent !== want) refreshTrigger(s); }
    }, 700);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
