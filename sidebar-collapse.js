/* ============================================================================
   SHARED collapsible sidebar behaviour — index.html, hr.html, academics.html
   all include this one file (see sidebar-collapse.css for the paired styles).
   Each page keeps its own nav menu/branding/role-based visibility completely
   untouched — this only adds collapse/expand + a persisted preference. No
   per-page markup rewrite was needed: nav-link labels are auto-wrapped in a
   .be-nav-label span at runtime (see wrapLabels below), not hand-edited into
   every <button>/<a> across three files.
   ============================================================================ */
(function () {
  var STORAGE_KEY = 'be_sidebar_collapsed'; // shared key on purpose — one
  // collapse preference across index.html/hr.html/academics.html, same
  // origin in production already (established elsewhere in this codebase),
  // spec's own "prefer the same preference across pages" ask.

  function isCollapsed() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
  }
  function setCollapsed(v) {
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch (e) {}
  }

  // Wraps the trailing content of every nav link inside `aside` in a
  // <span class="be-nav-label">, skipping the icon itself (first element
  // child) and skipping any element that looks like a notification badge
  // (spec: badges must stay visible when collapsed, labels must not).
  function wrapLabels(aside) {
    var links = aside.querySelectorAll('.sidebar-link, .acad-nav-link');
    links.forEach(function (link) {
      if (link.querySelector('.be-nav-label')) return; // already wrapped
      var icon = link.querySelector('i[data-lucide], svg');
      var startAfter = icon || link.firstElementChild;
      if (!startAfter) return;
      var frag = document.createDocumentFragment();
      var node = startAfter.nextSibling;
      var labelText = '';
      while (node) {
        var next = node.nextSibling;
        var isBadge = node.nodeType === 1 && /badge/i.test(node.id + ' ' + node.className);
        if (isBadge) { node = next; continue; } // leave badge where it is, outside the label span
        if (node.nodeType === 3) labelText += node.textContent;
        else if (node.nodeType === 1) labelText += node.textContent;
        frag.appendChild(node);
        node = next;
      }
      labelText = labelText.replace(/\s+/g, ' ').trim();
      if (!frag.childNodes.length) return;
      var span = document.createElement('span');
      span.className = 'be-nav-label';
      span.appendChild(frag);
      link.appendChild(span);
      if (labelText) {
        link.setAttribute('data-be-tip', labelText);
        if (!link.title) link.title = labelText; // native tooltip fallback, always present
      }
    });
    // Section headings ("PIPELINE"/"HR MANAGEMENT"/"MY WORKSPACE" etc) — all
    // three pages already use this same .nav-section-title class, no new
    // markup class needed.
    aside.querySelectorAll('.nav-section-title').forEach(function (h) {
      h.classList.add('be-nav-label');
    });
  }

  function applyState(aside, toggleBtn, collapsed) {
    aside.classList.toggle('be-collapsed', collapsed);
    var icon = toggleBtn.querySelector('svg, i');
    toggleBtn.innerHTML = collapsed
      ? '<i data-lucide="chevron-right" style="width:13px;height:13px"></i>'
      : '<i data-lucide="chevron-left" style="width:13px;height:13px"></i>';
    toggleBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    if (window.lucide) window.lucide.createIcons();
  }

  // Public entry point. Called once per page, right after the sidebar
  // markup exists in the DOM — deliberately NOT waiting on auth/data (see
  // each page's own call site) so the shell/icons never wait on Supabase.
  window.initSidebarCollapse = function (asideSelector) {
    var aside = document.querySelector(asideSelector);
    if (!aside || aside.dataset.beCollapseInit) return;
    aside.dataset.beCollapseInit = '1';
    aside.classList.add('be-aside');

    wrapLabels(aside);

    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'be-sidebar-toggle';
    toggleBtn.setAttribute('aria-label', 'Toggle sidebar');
    aside.appendChild(toggleBtn);

    var collapsed = isCollapsed();
    applyState(aside, toggleBtn, collapsed);

    toggleBtn.addEventListener('click', function () {
      collapsed = !collapsed;
      setCollapsed(collapsed);
      applyState(aside, toggleBtn, collapsed);
    });

    // A tab switch inside the app (switchTab/acadSwitchTab/switchHRSubtab)
    // can render new nav-adjacent badges/links later — re-run the label
    // sweep defensively so anything added after init still collapses
    // correctly. Cheap (skips already-wrapped links) and idempotent.
    var mo = new MutationObserver(function () { wrapLabels(aside); });
    mo.observe(aside, { childList: true, subtree: true });
  };
})();
