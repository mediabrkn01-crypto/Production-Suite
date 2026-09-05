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
