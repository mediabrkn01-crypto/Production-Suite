/* ============================================================================
   BESelect — ONE shared branded dropdown, used by index.html, academics.html
   and hr.html (included the same way as sidebar-collapse.js). It does NOT
   restructure the DOM or touch any business logic: every native <select> stays
   exactly where it is and remains the single source of truth (its value, its
   options, its change/input events, its disabled state, its dynamic
   backend-driven option updates). The closed control is still the same native
   <select> the page already styles dark — the ONLY thing this replaces is the
   OS-rendered OPEN popup (the part that turns white/low-contrast in system
   light mode and differs across Chrome/Safari/Edge). On open we suppress the
   native popup and show a portalled, fully self-styled menu; picking an option
   writes select.value and dispatches a real 'change' (+ 'input') event, so
   every existing handler, filter query and form submission fires unchanged.

   Scope / safety:
   - Skips <select multiple> (kept native so existing multi-select behaviour is
     never altered) and any select tagged [data-native].
   - Reads options live from the select each time it opens, so backend-driven /
     realtime option changes are always reflected — nothing is hardcoded.
   - Menu is appended to <body> and fixed-positioned, so it is never clipped by
     overflow:hidden cards/tables/modals; flips upward when there's no room
     below; z-index above every modal in these pages.
   - Full keyboard support (Arrow/Enter/Space/Escape/Home/End/type-ahead), aria
     roles/state, visible focus. A search box appears for long lists.
   - Explicit dark colors (no reliance on color-scheme), so it stays branded in
     OS light mode too. Tokens below reuse the Broken English palette.
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
    /* custom chevron on enhanced selects; hide native arrow so closed state matches everywhere */
    'select[data-be]{-webkit-appearance:none!important;-moz-appearance:none!important;appearance:none!important;',
    'background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%238b93ad\' stroke-width=\'2.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><polyline points=\'6 9 12 15 18 9\'/></svg>")!important;',
    'background-repeat:no-repeat!important;background-position:right 11px center!important;padding-right:30px!important;color-scheme:dark;}',
    'select[data-be][data-be-open]{border-color:var(--be-sel-accent)!important;}',
    /* portalled menu */
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

  // One reused menu element (portalled to body).
  var menu = null, list = null, search = null;
  var openSelect = null;   // the native <select> currently driving the menu
  var activeIndex = -1;    // keyboard-highlighted option index (into rendered rows)
  var rows = [];           // [{el, optionIndex}]

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
    // Keep focus/keyboard on the search field while open.
    search.addEventListener('keydown', onMenuKey);
    menu.addEventListener('mousedown', function (e) { e.preventDefault(); }); // don't blur the select/search
  }

  function optionText(o) { return (o.textContent || '').trim(); }

  function renderOptions(filter) {
    if (!openSelect) return;
    filter = (filter || '').trim().toLowerCase();
    list.innerHTML = '';
    rows = [];
    var opts = openSelect.options;
    var anyShown = false;
    var curVal = openSelect.value;
    var lastGroup = null;
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var label = optionText(o);
      if (filter && label.toLowerCase().indexOf(filter) === -1) continue;
      // optgroup heading
      var grp = o.parentNode && o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.getAttribute('label') : null;
      if (grp && grp !== lastGroup) {
        var gh = document.createElement('div');
        gh.className = 'be-sel-group';
        gh.textContent = grp;
        list.appendChild(gh);
        lastGroup = grp;
      }
      var row = document.createElement('div');
      row.className = 'be-sel-opt';
      row.setAttribute('role', 'option');
      var isSel = o.value === curVal;
      if (isSel) { row.setAttribute('data-selected', ''); row.setAttribute('aria-selected', 'true'); }
      if (o.disabled) row.setAttribute('data-disabled', '');
      row.innerHTML = '<span class="be-sel-check">✓</span><span class="be-sel-optlabel"></span>';
      row.querySelector('.be-sel-optlabel').textContent = label || ' ';
      (function (optIndex, disabled) {
        row.addEventListener('click', function () { if (!disabled) commit(optIndex); });
      })(i, o.disabled);
      list.appendChild(row);
      if (!o.disabled) rows.push({ el: row, optionIndex: i });
      anyShown = true;
    }
    if (!anyShown) {
      var em = document.createElement('div');
      em.className = 'be-sel-empty';
      em.textContent = 'No matches';
      list.appendChild(em);
    }
    // highlight the selected (or first) row
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
    close();
  }

  function position() {
    if (!openSelect || !menu) return;
    var r = openSelect.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var width = Math.max(r.width, 180);
    if (vw < 640) width = Math.min(width, vw - 16); // mobile: fit viewport
    menu.style.width = width + 'px';
    menu.style.left = Math.min(Math.max(8, r.left), vw - width - 8) + 'px';
    // measure height by showing invisibly
    var mh = menu.offsetHeight || 260;
    var spaceBelow = vh - r.bottom, spaceAbove = r.top;
    if (spaceBelow < mh + 8 && spaceAbove > spaceBelow) {
      menu.style.top = Math.max(8, r.top - mh - 6) + 'px';   // flip up
    } else {
      menu.style.top = (r.bottom + 6) + 'px';
    }
  }

  function open(select) {
    if (openSelect === select) return;
    if (openSelect) close();
    if (!menu) buildMenu();
    openSelect = select;
    select.setAttribute('data-be-open', '');
    select.setAttribute('aria-expanded', 'true');
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
    openSelect.removeAttribute('data-be-open');
    openSelect.setAttribute('aria-expanded', 'false');
    var s = openSelect;
    openSelect = null;
    if (menu) menu.removeAttribute('data-open');
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('mousedown', onDocDown, true);
    try { s.focus(); } catch (e) {}
  }

  function onDocDown(e) {
    if (menu && menu.contains(e.target)) return;
    if (openSelect && openSelect.contains(e.target)) return;
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

  // Key handling while focus is on the SELECT itself (search hidden / short list).
  function onSelectKey(e) {
    var select = e.currentTarget;
    if (openSelect === select) {
      onMenuKey(e);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      open(select);
    }
  }

  function enhance(select) {
    if (!select || select.tagName !== 'SELECT') return;
    if (select.multiple || select.size > 1) return;                 // leave native multi-selects alone
    if (select.hasAttribute('data-native')) return;                 // explicit opt-out
    if (select.hasAttribute('data-be')) return;                     // already enhanced
    select.setAttribute('data-be', '');
    select.setAttribute('role', 'combobox');
    select.setAttribute('aria-haspopup', 'listbox');
    select.setAttribute('aria-expanded', 'false');
    // Suppress the native popup; show ours instead. mousedown preventDefault is what stops the
    // OS dropdown from ever appearing, on desktop and mobile alike.
    select.addEventListener('mousedown', function (e) {
      if (select.disabled) return;
      e.preventDefault();
      if (openSelect === select) close(); else open(select);
    });
    select.addEventListener('keydown', onSelectKey);
    // If the app rebuilds this select's options or programmatically changes value while the
    // menu is open, re-render so the branded menu never shows stale data (backend/realtime).
    var mo = new MutationObserver(function () { if (openSelect === select) renderOptions(search.value); });
    mo.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'value'] });
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll ? (root || document).querySelectorAll('select') : [];
    for (var i = 0; i < nodes.length; i++) enhance(nodes[i]);
  }

  function boot() {
    scan(document);
    // Enhance selects added later (modals built on demand, dynamic filter rows, etc.).
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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
