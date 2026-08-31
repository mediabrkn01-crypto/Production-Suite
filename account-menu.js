/* ============================================================================
   SHARED top-right profile/account menu — index.html, hr.html, academics.html
   all include this one file (paired with account-menu.css). Each page passes
   its own thin config (current user getter, logout fn, add-account fn, saved-
   accounts source, photo lookup) — the actual dropdown UI/open-close/two-view
   interaction logic lives here once, not copied three times.

   This REPLACES the old always-mounted "Switch Account" panel that used to
   live permanently inside each sidebar (see sidebar-collapse.js's own header
   comment for that prior work) — the sidebar keeps its compact current-user
   card, but switching/adding accounts/logging out now only ever happens
   through this top-right dropdown, closed by default, exactly like the
   notification bell panel next to it.
   ============================================================================ */
(function () {
  function escapeHtml(s) {
    var d = document.createElement('div');
    d.innerText = s == null ? '' : String(s);
    return d.innerHTML;
  }

  window.initAccountMenu = function (opts) {
    var trigger = typeof opts.trigger === 'string' ? document.querySelector(opts.trigger) : opts.trigger;
    if (!trigger || trigger.dataset.amInit) return;
    trigger.dataset.amInit = '1';
    trigger.classList.add('am-trigger');

    // BUG: trigger.closest('[style*="relative"]') matched the TRIGGER ITSELF whenever the
    // trigger button's own inline style happened to contain "position:relative" (true for
    // every one of these three pages' circular header buttons) — closest() includes the
    // starting element, so the dropdown was being appended INSIDE the 36px circular button
    // and immediately clipped by its own overflow:hidden, invisible even with .am-open set.
    // The wrap must always be the trigger's PARENT, never the trigger itself.
    var wrap = trigger.parentElement;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    var dropdown = document.createElement('div');
    dropdown.className = 'am-dropdown';
    wrap.appendChild(dropdown);

    var view = 'main'; // 'main' | 'switch'
    var photoCache = null;

    function avatarHTML(nameOrRec, size, fallbackName) {
      size = size || 30;
      // Defensive: a caller's photo-lookup row might match (real employee, real query hit)
      // but simply have no name field selected — falling all the way to a bare '?' in that
      // case (rather than the real name the caller already knows, passed as fallbackName)
      // broke initials for exactly this case once (an employee with no photo on file, the
      // common case) until the caller's own query was fixed too. Belt-and-suspenders.
      var name = typeof nameOrRec === 'string' ? nameOrRec : (nameOrRec && (nameOrRec.full_name || nameOrRec.name)) || fallbackName || '?';
      var photo = typeof nameOrRec === 'object' && nameOrRec ? (nameOrRec.photo_base64 || nameOrRec.photo_url) : null;
      var initials = name.split(' ').filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('') || '?';
      var style = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;flex-shrink:0;object-fit:cover;display:flex;align-items:center;justify-content:center;font-size:' + Math.round(size * 0.38) + 'px;font-weight:700;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f)';
      if (photo) {
        return '<img src="' + escapeHtml(photo) + '" alt="" style="' + style.replace('display:flex;align-items:center;justify-content:center;', '') + '" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{style:\'' + style + '\',textContent:\'' + initials + '\'}))">';
      }
      return '<div style="' + style + '">' + initials + '</div>';
    }

    function renderMain() {
      var me = opts.getCurrentUser() || {};
      var rec = photoCache && me.email && photoCache[me.email.toLowerCase()];
      dropdown.innerHTML =
        '<div class="am-current">' + avatarHTML(rec || me.name, 34, me.name) +
          '<div style="min-width:0"><div class="am-name">' + escapeHtml(me.name || 'User') + '</div><div class="am-role">' + escapeHtml(me.role || '') + '</div></div>' +
        '</div>' +
        '<button class="am-item" data-am-action="switch"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3l4 4-4 4M20 7H8M8 21l-4-4 4-4M4 17h12"/></svg> Switch Account</button>' +
        '<button class="am-item" data-am-action="add"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg> Add Another Account</button>' +
        '<div class="am-divider"></div>' +
        '<button class="am-item am-danger" data-am-action="logout"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg> Logout</button>';
      wireClicks();
    }

    function renderSwitch() {
      var me = opts.getCurrentUser() || {};
      var accounts = (opts.getSavedAccounts() || []).slice();
      var rowsHTML = accounts.length
        ? accounts.map(function (acc) {
            var isCurrent = (acc.email || '').toLowerCase() === (me.email || '').toLowerCase();
            var rec = photoCache && photoCache[(acc.email || '').toLowerCase()];
            return '<div class="am-account-row">' +
              '<button class="am-acc-btn" data-am-switch="' + escapeHtml(acc.email) + '">' +
                avatarHTML(rec || acc.name, 26, acc.name) +
                '<span style="min-width:0"><div class="am-acc-name" title="' + escapeHtml(acc.name) + '">' + escapeHtml(acc.name) + (isCurrent ? ' <span class="am-current-tag">(current)</span>' : '') + '</div><div class="am-acc-role">' + escapeHtml(acc.role || '') + '</div></span>' +
              '</button>' +
              (isCurrent ? '' : '<button class="am-remove" title="Remove saved account" data-am-remove="' + escapeHtml(acc.email) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>') +
            '</div>';
          }).join('')
        : '<div style="padding:12px 14px;font-size:11.5px;color:#4a5182">No saved accounts yet.</div>';
      dropdown.innerHTML =
        '<div class="am-switch-header"><button class="am-back" data-am-action="back"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button> Switch Account</div>' +
        rowsHTML +
        '<div class="am-divider"></div>' +
        '<button class="am-item" data-am-action="add"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg> Add Another Account</button>';
      wireClicks();
    }

    // BUG FIX: a click on "Switch Account"/"Add Another Account"/etc used to bubble up to
    // the document-level outside-click listener AFTER dropdown.innerHTML had already been
    // replaced (renderSwitch() re-renders synchronously inside the same click handler) — by
    // the time that listener ran, the clicked element was a DETACHED node, so
    // dropdown.contains(e.target) came back false and the menu closed itself right after
    // switching views. One delegated capture-time stopPropagation on the dropdown itself
    // (added once, not per-button, not re-added on every re-render) fixes every button
    // inside it at once, regardless of how many times its content gets replaced.
    dropdown.addEventListener('click', function (e) { e.stopPropagation(); });

    function wireClicks() {
      dropdown.querySelectorAll('[data-am-action]').forEach(function (el) {
        el.addEventListener('click', function () {
          var action = el.getAttribute('data-am-action');
          if (action === 'switch') { view = 'switch'; renderSwitch(); }
          else if (action === 'back') { view = 'main'; renderMain(); }
          else if (action === 'add') { close(); opts.onAddAccount(); }
          else if (action === 'logout') { close(); opts.onLogout(); }
        });
      });
      dropdown.querySelectorAll('[data-am-switch]').forEach(function (el) {
        el.addEventListener('click', function () { close(); opts.onSwitchAccount(el.getAttribute('data-am-switch')); });
      });
      dropdown.querySelectorAll('[data-am-remove]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          if (typeof opts.onRemoveAccount === 'function') opts.onRemoveAccount(el.getAttribute('data-am-remove'));
          renderSwitch();
        });
      });
    }

    function open() {
      view = 'main';
      renderMain();
      dropdown.classList.add('am-open');
      // Photos load AFTER the initials-only menu is already open (never blocks opening) —
      // same progressive pattern as the sidebar switcher this replaces.
      if (typeof opts.getPhotos === 'function' && !photoCache) {
        var emails = [];
        var me = opts.getCurrentUser() || {};
        if (me.email) emails.push(me.email);
        (opts.getSavedAccounts() || []).forEach(function (a) { if (a.email) emails.push(a.email); });
        opts.getPhotos(emails).then(function (map) {
          photoCache = map || {};
          if (dropdown.classList.contains('am-open')) { if (view === 'main') renderMain(); else renderSwitch(); }
        });
      }
    }
    function close() { dropdown.classList.remove('am-open'); }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (dropdown.classList.contains('am-open')) close(); else open();
    });
    document.addEventListener('click', function (e) {
      if (!dropdown.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  };
})();
