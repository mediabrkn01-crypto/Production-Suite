/* Broken English — shared dashboard shell (one component for every department page).
 *
 * Renders the common top header (search · date · notifications · account) and ships the
 * shared styles for the blocks every dashboard stacks under it, in this fixed order:
 *
 *   1. .bes-header    common header          BEShell.header(mount, cfg)
 *   2. banner slot    #celebration-banner-slot (page's own celebration engine fills it)
 *   3. .bes-welcome   greeting + title + subtitle (+ department actions on the right)
 *   4. .bes-att       attendance card, then the department-specific sections
 *
 * Pages keep their own ids (bell, badge, avatar, date…) so every existing handler — badge
 * counts, avatar photos, account menus, notification panels — keeps working untouched. The
 * shell only owns layout/visuals, the date text, and the name/role labels.
 *
 * cfg = {
 *   ids: { search, date, bell, badge, account, avatar, name, role },   // page ids to reuse
 *   searchPlaceholder: 'Search…',
 *   onSearch: fn            // optional — default is a quick "jump to section" palette
 *   navSelector: '.sidebar-link'   // what the default palette lists (visible items only)
 *   onBell: fn,
 *   getUser: () => ({ name, role })   // optional — fills the name/role labels
 *   mobileBreakpoint: 767,  // header hides at/below this width (page has its own mobile bar)
 *   mobileCompact: false    // true = stay visible on phones, icons only (no mobile bar)
 * }
 */
(function () {
  'use strict';
  if (window.BEShell) return;

  var ICON = {
    search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    calendar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    bell: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>'
  };

  var CSS = [
    /* ── 1. common header ── */
    '.bes-header{display:flex;align-items:center;gap:12px;min-height:44px;margin:0 0 18px;padding:0 0 14px;border-bottom:1px solid rgba(255,255,255,.06);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f1f5f9}',
    '.bes-search{flex:1 1 auto;max-width:380px;min-width:0;height:40px;display:flex;align-items:center;gap:9px;padding:0 10px 0 13px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);color:#6b74a0;font:inherit;font-size:12.5px;text-align:left;cursor:pointer;transition:border-color .15s,background .15s}',
    '.bes-search:hover{border-color:rgba(255,107,6,.35);background:rgba(255,255,255,.045);color:#9aa3c7}',
    '.bes-search span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bes-search kbd{font:600 10px/1 Inter,system-ui,sans-serif;color:#4a5182;border:1px solid rgba(255,255,255,.09);border-radius:5px;padding:3px 6px;background:rgba(255,255,255,.02)}',
    '.bes-right{display:flex;align-items:center;gap:10px;margin-left:auto;flex-shrink:0}',
    '.bes-date{height:40px;display:flex;align-items:center;gap:8px;padding:0 13px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);color:#8b93b8;font-size:12px;font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.bes-date svg{color:#6b74a0;flex-shrink:0}',
    '.bes-date-short{display:none;font-style:normal}',
    '.bes-icon{position:relative;width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);color:rgba(255,255,255,.72);cursor:pointer;transition:all .15s;padding:0}',
    '.bes-icon:hover{color:#fff;border-color:rgba(255,107,6,.35);background:rgba(255,255,255,.05)}',
    '.bes-badge{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;border-radius:999px;background:linear-gradient(135deg,#ff6b06,#f9182f,#ff0552);color:#fff;font-size:9px;font-weight:700;align-items:center;justify-content:center;padding:0 4px;box-shadow:0 2px 6px rgba(255,5,82,.4)}',
    '.bes-account{display:flex;align-items:center;gap:10px;height:40px;padding:0 10px 0 4px;margin-left:2px;border-radius:999px;background:transparent;border:1px solid transparent;color:inherit;font:inherit;cursor:pointer;position:relative;transition:background .15s,border-color .15s}',
    '.bes-account:hover{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.07)}',
    '.bes-av{width:34px;height:34px;border-radius:50%;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff6b06,#f9182f);color:#fff;font-size:12px;font-weight:700;box-shadow:0 0 0 2px rgba(255,255,255,.07)}',
    '.bes-av > *{width:100%!important;height:100%!important;border-radius:50%!important;font-size:12px!important}',
    '.bes-av img{object-fit:cover;object-position:center}',
    '.bes-who{display:flex;flex-direction:column;align-items:flex-start;line-height:1.2;min-width:0;max-width:170px}',
    '.bes-who b{font-size:12.5px;font-weight:700;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '.bes-who small{font-size:10.5px;color:#6b74a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '.bes-who:empty,.bes-who b:empty,.bes-who small:empty{display:none}',
    '.bes-account > svg{color:#6b74a0;flex-shrink:0}',
    '@media(max-width:1100px){.bes-who{display:none}}',
    '@media(max-width:900px){.bes-date span{display:none}.bes-date{width:40px;padding:0;justify-content:center}}',
    '@media(max-width:380px){.bes-header.bes-compact .bes-search{flex:0 0 38px;width:38px;padding:0;justify-content:center}.bes-header.bes-compact .bes-search span{display:none}}',
    '.be-embed .bes-header{display:none!important}',
    /* shared top stack: banner → welcome → attendance, one rhythm on every page */
    '.bes-top{display:flex;flex-direction:column;gap:18px;margin:0 0 18px}',
    '.bes-top > *{margin:0!important}',
    '.bes-off{display:none!important}',
    /* pages whose containers use Tailwind space-y-6 (24px) — pull back to the shared 18px */
    '.space-y-6 > .bes-header,.space-y-6 > .bes-top{margin-bottom:-6px}',
    /* ── 3. welcome block ── */
    '.bes-welcome{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 0 18px}',
    '.bes-welcome-main{min-width:0}',
    '.bes-greet{font-size:12px;font-weight:600;color:#8b93b8;margin:0 0 4px}',
    '.bes-greet:empty{display:none}',
    '.bes-title{font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-.02em;color:#f1f5f9;margin:0}',
    '.bes-sub{display:none}', /* descriptive subtitles removed — the title says it */
    '.bes-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
    '.bes-actions:empty{display:none}',
    '@media(max-width:767px){.bes-title{font-size:23px}.bes-sub{font-size:12px}}',
    /* ── banner slot spacing (slot itself stays the celebration engine\'s) ── */
    '.bes-banner{margin:0 0 18px}',
    '.bes-banner:empty{display:none;margin:0}',
    /* ── 4. attendance card ── */
    '.bes-att{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 20px;margin:0 0 18px;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));border:1px solid rgba(255,255,255,.07);font-family:Inter,system-ui,sans-serif}',
    '.bes-att.hidden{display:none!important}',
    '.bes-att-l{display:flex;align-items:center;gap:13px;min-width:0;flex:1 1 240px}',
    '.bes-att-ic{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:rgba(255,107,6,.12);color:#ff8a3c;border:1px solid rgba(255,107,6,.2)}',
    '.bes-att-ic svg,.bes-att-ic i{width:20px;height:20px}',
    '.bes-att-lbl{font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#f1f5f9;margin:0}',
    '.bes-att-st{font-size:12px;color:#8b93b8;margin:3px 0 0}',
    '.bes-att-r{display:flex;align-items:center;gap:14px;flex-wrap:wrap}',
    '.bes-clk{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:40px;padding:0 18px;border-radius:11px;font:800 12px/1 Inter,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:filter .15s,transform .1s;border:1px solid transparent;white-space:nowrap}',
    '.bes-clk:active{transform:scale(.97)}',
    '.bes-clk:disabled{opacity:.5;cursor:default}',
    '.bes-clk.hidden{display:none!important}',
    '.bes-clk svg,.bes-clk i{width:15px;height:15px}',
    '.bes-clk-in{background:rgba(16,185,129,.14);border-color:rgba(16,185,129,.42);color:#10b981}',
    '.bes-clk-in:hover:not(:disabled){filter:brightness(1.15)}',
    '.bes-clk-out{background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.45);color:#f87171}',
    '.bes-clk-out:hover:not(:disabled){filter:brightness(1.15)}',
    '@media(max-width:767px){.bes-att{padding:14px 16px}.bes-att-r{width:100%}.bes-att-r .bes-clk{flex:1;height:46px;font-size:13px}}',
    /* ── phones: compact top stack, banner kept inside its frame, no sideways scroll ── */
    '@media(max-width:767px){' +
      'body{overflow-x:hidden}' +
      'img,video{max-width:100%}' +
      '.space-y-6 > .bes-header,.space-y-6 > .bes-top{margin-bottom:0!important}' +
      '.space-y-6 > :not([hidden]) ~ :not([hidden]){margin-top:20px!important}' +
      '.bes-top{gap:16px;margin:4px 0 20px}' +
      '.bes-welcome{gap:10px;align-items:flex-start}' +
      '.bes-greet{font-size:12px;margin:0 0 3px}' +
      '.bes-greet[data-date]::after{content:" · " attr(data-date);color:#6b74a0;font-weight:500}' +
      '.bes-title{font-size:22px!important;line-height:1.2!important;margin:0!important;overflow-wrap:anywhere}' +
      '.bes-sub{display:none!important}' +
      '.bes-actions{width:100%;justify-content:flex-start}' +
      '.be-celeb-banner-slot{max-width:100%;box-sizing:border-box;overflow:hidden;border-radius:12px}' +
      '.be-celeb-banner-slot .be-celeb-banner-item{height:auto!important;max-width:100%;margin-bottom:8px;border-radius:12px;box-sizing:border-box}' +
      '.be-celeb-banner-slot .be-celeb-banner-item:last-child{margin-bottom:0}' +
      /* the artwork's own aspect ratio — whole image visible, never cropped or stretched */
      '.be-celeb-banner-slot .be-celeb-banner-item img,.be-celeb-banner-slot .be-celeb-banner-item video{display:block;width:100%!important;height:auto!important;max-width:100%;object-fit:contain}' +
      '.be-celeb-banner-close{width:26px;height:26px;top:6px;right:6px;font-size:13px}' +
      '.bes-att{padding:11px 12px;gap:10px;border-radius:14px}' +
      '.bes-att-l{gap:10px;flex:1 1 170px}' +
      '.bes-att-ic{width:34px;height:34px;border-radius:10px}' +
      '.bes-att-ic svg,.bes-att-ic i{width:17px;height:17px}' +
      '.bes-att-lbl{font-size:12.5px;letter-spacing:0;text-transform:none}' +
      '.bes-att-st{font-size:11.5px;line-height:1.35;margin-top:2px}' +
      '.bes-att-r{width:auto;flex:0 1 auto;gap:10px;flex-wrap:wrap;max-width:100%;min-width:0}' +
      '.bes-att-r > *{min-width:0}' +
      '.bes-att-r .bes-clk{flex:0 0 auto;height:38px;padding:0 14px;font-size:11px;border-radius:10px}' +
      '.bes-att-r > .pl-4{padding-left:10px!important}' +
      '.dsh-empty{min-height:0!important;padding:14px 12px!important;gap:6px!important}' +
      '.dsh-empty-ic{width:32px;height:32px;border-radius:10px}' +
    '}',
    /* ── jump-to palette ── */
    '@media(max-width:767px){.bes-pal{padding:10vh 12px 12px}.bes-pal-item{padding:12px}}',
    '.bes-pal{position:fixed;inset:0;z-index:95;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px}',
    '.bes-pal-box{width:100%;max-width:520px;background:#0b0d19;border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 30px 70px rgba(0,0,0,.7);overflow:hidden;font-family:Inter,system-ui,sans-serif}',
    '.bes-pal-in{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06);color:#6b74a0}',
    '.bes-pal-in input,.bes-pal-in input:focus{flex:1;background:transparent!important;border:0!important;border-radius:0!important;outline:0!important;box-shadow:none!important;padding:0!important;height:26px;color:#f1f5f9!important;font:500 15px Inter,system-ui,sans-serif!important}',
    '.bes-pal-list{max-height:52vh;overflow-y:auto;padding:6px}',
    '.bes-pal-item{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;border:0;background:transparent;color:#c7cbe0;font:500 13px Inter,system-ui,sans-serif;text-align:left;cursor:pointer}',
    '.bes-pal-item small{color:#4a5182;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}',
    '.bes-pal-item.on,.bes-pal-item:hover{background:rgba(255,107,6,.1);color:#fff}',
    '.bes-pal-empty{padding:26px;text-align:center;color:#4a5182;font-size:12.5px}'
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('bes-css')) return;
    var s = document.createElement('style');
    s.id = 'bes-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  injectCSS();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function idAttr(id) { return id ? ' id="' + esc(id) + '"' : ''; }

  function formatDate(now) {
    return now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
      '  ·  ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  // ── default search: jump to any section the current user can actually see ──
  // Permission-gated = hidden. Walks up to (not including) the sidebar root, so the sidebar's
  // own display:none on phones doesn't hide every item, while a hidden role group still does.
  function isShown(el) {
    var root = el.closest('#be-sidebar, #aside, aside') || document.body;
    for (var n = el; n && n !== root && n !== document.body; n = n.parentElement) {
      if (n.hidden || n.classList.contains('hidden')) return false;
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }
  function navItems(sel) {
    var seen = {}, out = [];
    document.querySelectorAll(sel).forEach(function (el) {
      if (el.closest('.bes-header') || !isShown(el)) return;
      var label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || seen[label.toLowerCase()]) return;
      seen[label.toLowerCase()] = 1;
      var grp = '';
      for (var p = el.previousElementSibling; p; p = p.previousElementSibling) {
        if (p.matches(sel)) continue;
        var t = (p.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 40 && !p.querySelector('button,a')) { grp = t; break; }
      }
      out.push({ el: el, label: label, group: grp });
    });
    return out;
  }
  function openPalette(sel) {
    if (document.querySelector('.bes-pal')) return;
    var items = navItems(sel || '.sidebar-link');
    var wrap = document.createElement('div');
    wrap.className = 'bes-pal';
    wrap.innerHTML = '<div class="bes-pal-box" role="dialog" aria-label="Jump to section"><div class="bes-pal-in">' + ICON.search +
      '<input type="text" placeholder="Jump to a section…" aria-label="Search sections"></div><div class="bes-pal-list"></div></div>';
    document.body.appendChild(wrap);
    var input = wrap.querySelector('input'), list = wrap.querySelector('.bes-pal-list'), shown = [], cur = 0;
    function close() { wrap.remove(); document.removeEventListener('keydown', onKey, true); }
    function draw() {
      var q = input.value.trim().toLowerCase();
      shown = items.filter(function (it) { return !q || it.label.toLowerCase().indexOf(q) > -1 || it.group.toLowerCase().indexOf(q) > -1; });
      cur = Math.min(cur, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length ? shown.map(function (it, i) {
        return '<button type="button" class="bes-pal-item' + (i === cur ? ' on' : '') + '" data-i="' + i + '"><span>' + esc(it.label) + '</span>' + (it.group ? '<small>' + esc(it.group) + '</small>' : '') + '</button>';
      }).join('') : '<div class="bes-pal-empty">No matching section</div>';
    }
    function go(i) { var it = shown[i]; close(); if (it) it.el.click(); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(cur + 1, shown.length - 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(cur - 1, 0); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(cur); }
    }
    input.addEventListener('input', function () { cur = 0; draw(); });
    list.addEventListener('click', function (e) { var b = e.target.closest('.bes-pal-item'); if (b) go(+b.dataset.i); });
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey, true);
    draw();
    setTimeout(function () { input.focus(); }, 30);
  }

  var active = null;

  function header(mount, cfg) {
    cfg = cfg || {};
    var ids = cfg.ids || {};
    var host = typeof mount === 'string' ? document.querySelector(mount) : mount;
    if (!host) return null;
    var bp = cfg.mobileBreakpoint == null ? 767 : cfg.mobileBreakpoint;
    var el = document.createElement('header');
    el.className = 'bes-header' + (cfg.mobileCompact ? ' bes-compact' : '');
    el.setAttribute('role', 'banner');
    el.innerHTML =
      '<button type="button" class="bes-search"' + idAttr(ids.search) + ' aria-label="Search">' + ICON.search +
        '<span>' + esc(cfg.searchPlaceholder || 'Search…') + '</span><kbd>⌘K</kbd></button>' +
      '<div class="bes-right">' +
        '<div class="bes-date" title="Today">' + ICON.calendar + '<span' + idAttr(ids.date) + '></span><em class="bes-date-short"></em></div>' +
        '<button type="button" class="bes-icon"' + idAttr(ids.bell) + ' title="Notifications" aria-label="Notifications">' + ICON.bell +
          '<span class="bes-badge hidden" style="display:none"' + idAttr(ids.badge) + '></span></button>' +
        '<button type="button" class="bes-account"' + idAttr(ids.account) + ' title="Account" aria-label="Account menu">' +
          '<span class="bes-av"' + idAttr(ids.avatar) + '>?</span>' +
          '<span class="bes-who"><b' + idAttr(ids.name) + '></b><small' + idAttr(ids.role) + '></small></span>' + ICON.chevron +
        '</button>' +
      '</div>';
    host.replaceWith(el);

    var mq = document.createElement('style');
    mq.textContent = '@media(max-width:' + (bp || 767) + 'px){' +
      '.bes-header{min-height:0;gap:8px;margin:0 0 12px!important;padding:0;border-bottom:0}' +
      '.bes-header .bes-search{height:38px;max-width:none;border-radius:11px;font-size:12.5px;padding:0 12px}' +
      '.bes-header .bes-search kbd{display:none}' +
      '.bes-header .bes-date{height:38px;width:auto;padding:0 11px;border-radius:11px;gap:6px;font-size:11.5px}' +
      '.bes-header .bes-date span{display:none}.bes-header .bes-date .bes-date-short{display:inline}' +
      '.bes-header .bes-right{gap:8px}' +
      '.bes-header .bes-icon{width:38px;height:38px;border-radius:11px}' +
      '.bes-header .bes-account{height:38px;padding:0 2px;margin:0}.bes-header .bes-account > svg,.bes-header .bes-who{display:none}' +
      '.bes-header .bes-av{width:32px;height:32px}' +
      (cfg.mobileCompact ? '' : '.bes-header .bes-icon,.bes-header .bes-account{display:none}.bes-header{display:none!important}') +
      '}';
    document.head.appendChild(mq);

    // Phones: search lives in the page's sticky top bar as one icon (same action as the header
    // search), so the header row isn't a second row of chrome. Skipped if the bar already has one.
    if (!cfg.mobileCompact) {
      var bar = document.getElementById('mobile-topbar') || document.getElementById('sales-mobile-appbar');
      var actions = bar && (bar.querySelector('.ma-actions') || bar.children[bar.children.length - 1]);
      if (actions && !actions.querySelector('[title="Search"]')) {
        var sb = document.createElement('button');
        sb.type = 'button'; sb.className = 'be-mtb-icon-btn'; sb.title = 'Search'; sb.setAttribute('aria-label', 'Search');
        sb.innerHTML = ICON.search;
        sb.addEventListener('click', function () { doSearch(); });
        actions.insertBefore(sb, actions.firstChild);
      }
    }

    var search = el.querySelector('.bes-search');
    function doSearch() { if (typeof cfg.onSearch === 'function') cfg.onSearch(); else openPalette(cfg.navSelector); }
    search.addEventListener('click', doSearch);
    var bell = el.querySelector('.bes-icon');
    bell.addEventListener('click', function (e) { if (typeof cfg.onBell === 'function') { e.stopPropagation(); cfg.onBell(e); } });

    var dateEl = el.querySelector('.bes-date span'), shortEl = el.querySelector('.bes-date-short');
    var nameEl = el.querySelector('.bes-who b'), roleEl = el.querySelector('.bes-who small');
    function tick() {
      var now = new Date();
      dateEl.textContent = formatDate(now);
      shortEl.textContent = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      document.querySelectorAll('.bes-greet').forEach(function (g) { if (g.getAttribute('data-date') !== shortEl.textContent) g.setAttribute('data-date', shortEl.textContent); });
      if (typeof cfg.getUser === 'function') {
        var u = null;
        try { u = cfg.getUser(); } catch (_) {}
        if (u) {
          if (u.name && nameEl.textContent !== u.name) nameEl.textContent = u.name;
          if (u.role && roleEl.textContent !== u.role) roleEl.textContent = u.role;
        }
      }
    }
    tick();
    if (active && active.timer) clearInterval(active.timer);
    active = { el: el, cfg: cfg, doSearch: doSearch, timer: setInterval(tick, 1000) };
    return el;
  }

  // ⌘K / Ctrl+K opens the header search on every page.
  document.addEventListener('keydown', function (e) {
    if (!active || !(e.metaKey || e.ctrlKey) || (e.key || '').toLowerCase() !== 'k') return;
    if (!document.body.contains(active.el) || getComputedStyle(active.el).display === 'none') return;
    e.preventDefault();
    active.doSearch();
  });

  // Celebration banners are rendered with loading="lazy". On phones the banner takes the
  // artwork's own height (height:auto), so before it loads it is 0px tall — and a browser never
  // lazy-loads a zero-height image, so it stayed blank forever. Banners sit at the top of the
  // page anyway: load them eagerly, on every page, whichever engine rendered them.
  function eagerBanners(root) {
    (root.querySelectorAll ? root.querySelectorAll('.be-celeb-banner-item img[loading="lazy"]') : []).forEach(function (img) { img.loading = 'eager'; });
  }
  try {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) { if (n.matches && n.matches('.be-celeb-banner-item img[loading="lazy"]')) n.loading = 'eager'; else eagerBanners(n); } }); });
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (document.body) eagerBanners(document.body);
  } catch (_) {}

  window.BEShell = { header: header, openPalette: openPalette, formatDate: formatDate };
})();
