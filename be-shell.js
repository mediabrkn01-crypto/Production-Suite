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
    /* number fields: no browser up/down spinner (type a value instead) */
    'input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0}',
    'input[type=number]{-moz-appearance:textfield;appearance:textfield}',
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
    artDirect(root);
  }
  // Phones: the 1920×400 desktop banner shrinks to ~80px tall and becomes unreadable. When the
  // event has a taller image (HR's "Mobile banner", else its popup artwork) the renderers pass it
  // as data-m; on phones that image is shown whole (contain — nothing cropped or stretched) on a
  // blurred backdrop of itself, at a proper 170–220px height. Desktop keeps the wide banner.
  var BANNER_CSS = '@media (max-width:640px){' +
    '.be-celeb-banner-slot .be-celeb-banner-item.has-m{position:relative;height:clamp(170px,52vw,220px)!important;overflow:hidden;border-radius:16px;background:#0b0e1a;isolation:isolate}' +
    '.be-celeb-banner-item.has-m .bcb-bg{position:absolute;inset:-24px;z-index:-1;background-size:cover;background-position:center;filter:blur(22px) brightness(.45) saturate(1.15)}' +
    '.be-celeb-banner-slot .be-celeb-banner-item.has-m img.bcb-m{display:block;width:100%!important;height:100%!important;object-fit:contain!important}' +
    '.be-celeb-banner-slot .be-celeb-banner-item.has-m .bcb-d{display:none!important}' +
    '}' +
    '@media (min-width:641px){.be-celeb-banner-item .bcb-m,.be-celeb-banner-item .bcb-bg{display:none!important}}' +
    // Wide-only banner on a phone (no taller artwork uploaded): show it at a readable height as a
    // swipeable strip that pans slowly end to end — the whole artwork, never cropped or squeezed.
    '@media (max-width:640px){' +
    '.be-celeb-banner-slot .be-celeb-banner-item.pan{height:clamp(104px,30vw,132px)!important;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;scrollbar-width:none;border-radius:16px;position:relative}' +
    '.be-celeb-banner-item.pan::-webkit-scrollbar{display:none}' +
    '.be-celeb-banner-slot .be-celeb-banner-item.pan img.bcb-d{display:block;height:100%!important;width:auto!important;max-width:none!important;object-fit:contain!important}' +
    '}';
  function bannerCss() { if (!document.getElementById('bcb-css')) { var st = document.createElement('style'); st.id = 'bcb-css'; st.textContent = BANNER_CSS; document.head.appendChild(st); } }
  var PHONE = window.matchMedia ? window.matchMedia('(max-width:640px)') : { matches: false };
  var REDUCED = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  // Slow ping-pong pan of a wide banner strip; stops for good once the employee touches it.
  function panStrip(box) {
    if (box._pan) return; box._pan = true;
    var dir = 1, hold = 0, stopped = false, last = 0;
    function stop() { stopped = true; }
    box.addEventListener('pointerdown', stop, { passive: true }); box.addEventListener('touchstart', stop, { passive: true }); box.addEventListener('wheel', stop, { passive: true });
    if (REDUCED.matches) return;
    (function step(t) {
      if (stopped || !box.isConnected) return;
      var max = box.scrollWidth - box.clientWidth;
      if (max > 4 && !document.hidden) {
        if (hold > t) { requestAnimationFrame(step); return; }
        var dt = last ? Math.min(64, t - last) : 16; last = t;
        box.scrollLeft += dir * dt * 0.035;                 // ~35px per second
        if (box.scrollLeft >= max - 1 && dir > 0) { dir = -1; hold = t + 1800; }
        else if (box.scrollLeft <= 0 && dir < 0) { dir = 1; hold = t + 1800; }
      } else last = 0;
      requestAnimationFrame(step);
    })(0);
  }
  function widePan(root) {
    var list = root.matches && root.matches('.be-celeb-banner-item') ? [root] : [].slice.call(root.querySelectorAll ? root.querySelectorAll('.be-celeb-banner-item') : []);
    list.forEach(function (it) {
      if (it.classList.contains('has-m') || it.classList.contains('pan') || it.hasAttribute('data-m')) return;
      var img = it.querySelector('img'); if (!img || it.querySelector('video')) return;
      function check() {
        if (!PHONE.matches || !img.naturalWidth || img.naturalWidth / img.naturalHeight < 2.6) return;
        bannerCss(); img.classList.add('bcb-d'); it.classList.add('pan'); panStrip(it);
      }
      if (img.complete) check(); else img.addEventListener('load', check, { once: true });
    });
  }
  function artDirect(root) {
    if (!root.querySelectorAll) return;
    widePan(root);
    var items = root.matches && root.matches('.be-celeb-banner-item[data-m]') ? [root] : [].slice.call(root.querySelectorAll('.be-celeb-banner-item[data-m]'));
    if (!items.length) return;
    bannerCss();
    items.forEach(function (it) {
      var m = it.getAttribute('data-m'); it.removeAttribute('data-m');
      if (!m || it.classList.contains('has-m')) return;
      var d = it.querySelector('img,video'); if (d) d.classList.add('bcb-d');
      var bg = document.createElement('div'); bg.className = 'bcb-bg'; bg.style.backgroundImage = 'url("' + m.replace(/"/g, '%22') + '")';
      var im = document.createElement('img'); im.className = 'bcb-m'; im.alt = (d && d.alt) || 'Celebration'; im.src = m; im.decoding = 'async';
      it.appendChild(bg); it.appendChild(im); it.classList.add('has-m');
    });
  }
  try {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) { if (n.matches && n.matches('.be-celeb-banner-item img[loading="lazy"]')) n.loading = 'eager'; else eagerBanners(n); if (n.parentNode) artDirect(n.parentNode); } }); });
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (document.body) eagerBanners(document.body);
  } catch (_) {}

  window.BEShell = { header: header, openPalette: openPalette, formatDate: formatDate };
})();

/* ============================================================================
 * BEClock — the ONE clock-in / clock-out service for every portal.
 *
 *  - Locks immediately on the first tap: every clock control shows "Clocking in…" and every
 *    further tap is ignored until the server answers (no debounce guesswork).
 *  - Each tap gets a request id; the server (be_clock) stores the first result per id, so a
 *    retry or a double request can never create a second action or a second record.
 *  - Clock Out always asks for confirmation, and for 1.5 s after any change no control reacts —
 *    plus any tap that STARTED before the change is dropped — so a repeated Clock In tap can
 *    never land on the Clock Out that just appeared.
 *  - 12 s timeout. A timeout or network drop is "unknown", not "failed": the real status is read
 *    back from the database before anything is retried.
 *  Pages call BEClock.run(kind, { request(rid), verify(), apply(res) }).
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.BEClock) return;
  var TIMEOUT = 12000, SLOW = 3500, COOL = 1500;
  var S = { busy: false, kind: null, slow: false, lastChange: 0 };
  var lastDown = 0;
  function emit() { try { window.dispatchEvent(new CustomEvent('be-clock', { detail: { busy: S.busy, kind: S.kind, slow: S.slow } })); } catch (_) {} }
  function rid() { try { return crypto.randomUUID(); } catch (_) { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); } }
  function fmt(t) { if (!t) return ''; var d = new Date(t); return isNaN(d) ? String(t) : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }); }

  var CSS = '.bclk-bg{position:fixed;inset:0;z-index:2147482500;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.bclk-dlg{width:min(400px,100%);background:#11162a;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:20px;color:#e6e9f5;font:13.5px/1.5 Inter,system-ui,sans-serif;box-shadow:0 30px 70px -20px rgba(0,0,0,.8)}' +
    '.bclk-dlg h3{margin:0 0 6px;font-size:16px;font-weight:800;color:#fff;display:flex;align-items:center;gap:8px}' +
    '.bclk-dlg p{margin:0 0 16px;color:#a5adcf}' +
    '.bclk-b{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}' +
    '.bclk-b button{min-height:44px;padding:0 16px;border-radius:11px;font:700 13px Inter,system-ui,sans-serif;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#cbd5e1}' +
    '.bclk-b button.pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f)}' +
    '.bclk-b button.ok{border:0;color:#fff;background:linear-gradient(135deg,#10b981,#059669)}' +
    '.bclk-toast{position:fixed;left:50%;top:18px;transform:translate(-50%,-8px);z-index:2147482600;display:flex;gap:10px;align-items:flex-start;max-width:calc(100vw - 32px);padding:12px 16px;border-radius:14px;background:#11162a;border:1px solid rgba(255,255,255,.12);color:#e6e9f5;font:13px/1.45 Inter,system-ui,sans-serif;box-shadow:0 20px 50px -16px rgba(0,0,0,.8);opacity:0;transition:opacity .2s,transform .2s}' +
    '.bclk-toast.on{opacity:1;transform:translate(-50%,0)}.bclk-toast b{display:block;color:#fff;font-size:13.5px}.bclk-toast.ok{border-color:rgba(34,197,94,.45)}.bclk-toast.info{border-color:rgba(96,165,250,.45)}.bclk-toast i{font-style:normal;font-size:16px;line-height:1.2}' +
    '.bclk-spin{display:inline-block;width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;animation:bclkS .7s linear infinite;flex-shrink:0}@keyframes bclkS{to{transform:rotate(360deg)}}' +
    '@media(prefers-reduced-motion:reduce){.bclk-spin{animation-duration:2s}.bclk-toast{transition:none}}';
  function css() { if (!document.getElementById('bclk-css')) { var st = document.createElement('style'); st.id = 'bclk-css'; st.textContent = CSS; document.head.appendChild(st); } }
  function dialog(title, text, buttons) {
    css();
    return new Promise(function (resolve) {
      var bg = document.createElement('div'); bg.className = 'bclk-bg';
      bg.innerHTML = '<div class="bclk-dlg" role="alertdialog" aria-modal="true"><h3></h3><p></p><div class="bclk-b"></div></div>';
      bg.querySelector('h3').textContent = title; bg.querySelector('p').textContent = text;
      var row = bg.querySelector('.bclk-b');
      buttons.forEach(function (b) { var el = document.createElement('button'); el.type = 'button'; el.textContent = b.label; if (b.cls) el.className = b.cls; el.dataset.v = b.value; row.appendChild(el); });
      function done(v) { bg.remove(); document.removeEventListener('keydown', esc, true); resolve(v); }
      function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); done(null); } }
      bg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) done(b.dataset.v); });
      document.addEventListener('keydown', esc, true);
      document.body.appendChild(bg);
      var first = row.querySelector('button'); if (first) first.focus();
    });
  }
  var toastEl = null, toastT = null;
  function toast(kind, title, sub) {
    css();
    if (toastEl) toastEl.remove();
    var t = document.createElement('div'); t.className = 'bclk-toast ' + kind; t.setAttribute('role', 'status');
    t.innerHTML = '<i>' + (kind === 'ok' ? '✓' : 'ℹ') + '</i><div><b></b><span></span></div>';
    t.querySelector('b').textContent = title; t.querySelector('span').textContent = sub || '';
    document.body.appendChild(t); toastEl = t;
    requestAnimationFrame(function () { t.classList.add('on'); });
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 250); }, 3800);
  }
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { var e = new Error('timeout'); e.beKind = 'timeout'; rej(e); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function classify(e) {
    if (!navigator.onLine) return 'offline';
    if (e && e.beKind) return e.beKind;
    var m = String((e && (e.message || e.details)) || '');
    if (/Failed to fetch|NetworkError|network|Load failed|ERR_/i.test(m)) return 'network';
    return 'server';
  }
  var ERR = {
    offline: ['No internet connection', 'Your device is offline, so your attendance could not be recorded. Reconnect and try again.'],
    network: ['Network connection issue', 'Unable to confirm your attendance because the connection is unstable.'],
    timeout: ['Request timed out', 'The server did not answer in time. Your attendance may still have been saved — check the status before trying again.'],
    server: ['Server error', 'The attendance server returned an error.']
  };

  // Drop taps that land during an action, during the cool-down after it, or that STARTED before
  // the state changed (a double-tap whose second half would hit the new button).
  var CLOCK_SEL = '.bes-clk,.bcp-btn,.bcp-mc-btn,.bcp-mbtn,#clockBtn';
  document.addEventListener('pointerdown', function (e) { if (e.target.closest && e.target.closest(CLOCK_SEL)) lastDown = Date.now(); }, true);
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest(CLOCK_SEL); if (!b) return;
    var now = Date.now();
    if (S.busy || now - S.lastChange < COOL || (lastDown && lastDown < S.lastChange && now - lastDown < 3000)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);

  async function run(kind, o) {
    if (S.busy) return null;
    if (Date.now() - S.lastChange < COOL) return null;
    if (kind === 'out' && !o.confirmed) {
      var since = o.since ? ' since ' + o.since : '';
      var v = await dialog('Clock out?', 'You are currently clocked in' + since + '. Are you sure you want to end today’s attendance? Clock In opens again tomorrow.', [{ label: 'Cancel', value: 'no' }, { label: 'Confirm clock out', value: 'yes', cls: 'pri' }]);
      if (v !== 'yes') return null;
    }
    if (!navigator.onLine) { await problem('offline', kind, o); return null; }
    css();
    var id = rid();
    S.busy = true; S.kind = kind; S.slow = false; emit();
    try { sessionStorage.setItem('be_clock_pending', JSON.stringify({ kind: kind, id: id, at: Date.now() })); } catch (_) {}
    var slowT = setTimeout(function () { S.slow = true; emit(); }, SLOW);
    var res = null, err = null;
    try { res = await withTimeout(o.request(id), TIMEOUT); } catch (e) { err = e; }
    clearTimeout(slowT);
    if (err) {
      // Unknown outcome: ask the database what actually happened before saying anything.
      var truth = null;
      try { truth = await withTimeout(o.verify(), 8000); } catch (_) {}
      if (truth && ((kind === 'in' && (truth.state === 'in' || truth.state === 'done')) || (kind === 'out' && truth.state === 'done'))) {
        res = Object.assign({}, truth, { result: 'ok' });
      } else {
        finish(truth);
        if (truth && o.apply) try { o.apply(truth); } catch (_) {}
        await problem(classify(err), kind, o, err);
        return null;
      }
    }
    finish(res);
    try { if (o.apply) o.apply(res); } catch (e) { console.warn('[BEClock] apply:', e && e.message); }
    report(kind, res);
    return res;
  }
  function finish() {
    S.busy = false; S.kind = null; S.slow = false; S.lastChange = Date.now();
    try { sessionStorage.removeItem('be_clock_pending'); } catch (_) {}
    emit();
    setTimeout(emit, COOL + 30);   // let controls re-enable after the cool-down
  }
  function report(kind, r) {
    if (!r) return;
    if (r.result === 'ok') {
      if (kind === 'in') toast('ok', 'Clocked in successfully', 'Clock In Time: ' + fmt(r.log_in_time));
      else toast('ok', 'Clocked out successfully', 'Clock Out Time: ' + fmt(r.log_out_time));
    } else if (r.result === 'already_in') toast('info', 'You are already clocked in', 'Since ' + fmt(r.log_in_time));
    else if (r.result === 'completed') toast('info', 'Today’s attendance has already been completed.', fmt(r.log_in_time) + ' – ' + fmt(r.log_out_time));
    else if (r.result === 'no_session') toast('info', 'You are not clocked in', 'There is no open attendance session today.');
  }
  async function problem(type, kind, o, err) {
    var m = ERR[type] || ERR.server;
    var text = m[1] + (type === 'server' && err && err.message ? ' (' + err.message + ')' : '');
    var v = await dialog(m[0], text, [{ label: 'Close', value: 'close' }, { label: 'Check status', value: 'check' }, { label: 'Retry', value: 'retry', cls: kind === 'out' ? 'pri' : 'ok' }]);
    if (v === 'check' || v === 'retry') {
      var truth = null;
      try { truth = await withTimeout(o.verify(), 8000); } catch (e) { await problem(classify(e), kind, o, e); return; }
      if (truth && o.apply) try { o.apply(truth); } catch (_) {}
      S.lastChange = Date.now(); emit();
      var done = truth && ((kind === 'in' && truth.state !== 'none') || (kind === 'out' && truth.state === 'done'));
      if (done) { report(kind, Object.assign({}, truth, { result: kind === 'in' && truth.state === 'done' ? 'completed' : 'ok' })); return; }
      if (v === 'check') { toast('info', kind === 'in' ? 'Not clocked in yet' : 'Still clocked in', 'Your attendance was not changed. Tap ' + (kind === 'in' ? 'Clock In' : 'Clock Out') + ' to try again.'); return; }
      S.lastChange = 0; // a retry is a deliberate new action
      run(kind, Object.assign({}, o, { confirmed: true }));
    }
  }
  window.BEClock = {
    run: run,
    get busy() { return S.busy; },
    get kind() { return S.kind; },
    get slow() { return S.slow; },
    get coolingDown() { return Date.now() - S.lastChange < COOL; },
    toast: toast, dialog: dialog
  };
})();

/* ============================================================================
 * Header clock pill — Clock In / Clock Out lives in the top header bar (next to the
 * date) on every portal instead of a big Attendance card at the top of each page.
 * It MIRRORS the page's existing Attendance card (status text + its real Clock In /
 * Clock Out buttons) and clicks those buttons, so every portal keeps its own clock
 * logic untouched; the card itself is only hidden. If a page shows no card (e.g. the
 * Master Admin system account), the pill hides too.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.__beClockPill) return; window.__beClockPill = true;
  var CSS = [
    '.bes-att.bes-att-moved{display:none!important}',
    '.bes-clockpill{height:40px;display:inline-flex;align-items:center;gap:10px;padding:0 6px 0 13px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);color:#c7cce3;font:600 12.5px Inter,system-ui,sans-serif;white-space:nowrap;flex-shrink:0}',
    '.bes-clockpill[hidden]{display:none}',
    '.bes-clockpill .bcp-dot{width:8px;height:8px;border-radius:50%;background:#6b74a0;flex-shrink:0}',
    '.bes-clockpill.is-in .bcp-dot{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}',
    '.bes-clockpill.is-done .bcp-dot{background:#60a5fa}',
    '.bes-clockpill .bcp-txt b{color:#fff;font-weight:700}',
    '.bes-clockpill .bcp-btn{height:30px;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border-radius:9px;border:0;cursor:pointer;font:700 12px Inter,system-ui,sans-serif;color:#fff}',
    '.bes-clockpill .bcp-btn.in{background:linear-gradient(135deg,#10b981,#059669)}',
    '.bes-clockpill .bcp-btn.out{background:linear-gradient(135deg,#ff6b06,#f9182f)}',
    '.bes-clockpill .bcp-btn:disabled{opacity:.6;cursor:default}',
    '.bes-clockpill .bcp-btn[hidden],.bes-clockpill .bcp-chip[hidden],.bes-clockpill .bcp-link[hidden]{display:none!important}',
    '.bes-clockpill .bcp-chip{height:30px;display:inline-flex;align-items:center;gap:6px;padding:0 11px;border-radius:9px;font:700 11.5px Inter,system-ui,sans-serif;color:#93c5fd;background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.28);cursor:default;user-select:none}',
    '.bes-clockpill .bcp-chip.off{color:#c4b5fd;background:rgba(167,139,250,.1);border-color:rgba(167,139,250,.28)}',
    '.bes-clockpill .bcp-link{background:none;border:0;padding:0 4px;font:600 11px Inter,system-ui,sans-serif;color:#8b93b8;text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
    '.bes-clockpill .bcp-link:hover{color:#fff}',
    '.bes-clockpill .bcp-hrs{color:#8b93b8;font-weight:600}',
    '.bes-clockpill.is-done .bcp-txt b{color:#e6e9f5}',
    '.bcp-dlg-bg{position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}',
    '.bcp-dlg{width:min(400px,100%);background:#11162a;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:20px;color:#e6e9f5;font:13px/1.5 Inter,system-ui,sans-serif;box-shadow:0 30px 70px -20px rgba(0,0,0,.8)}',
    '.bcp-dlg h3{margin:0 0 6px;font-size:16px;font-weight:800;color:#fff}',
    '.bcp-dlg p{margin:0 0 16px;color:#a5adcf}',
    '.bcp-dlg-b{display:flex;justify-content:flex-end;gap:8px}',
    '.bcp-dlg-b button{height:38px;padding:0 16px;border-radius:10px;font:700 12.5px Inter,system-ui,sans-serif;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#cbd5e1}',
    '.bcp-dlg-b button.pri{border:0;color:#fff;background:linear-gradient(135deg,#ff6b06,#f9182f)}',
    '.bes-clockpill .bcp-btn:focus-visible{outline:2px solid rgba(255,138,60,.6);outline-offset:1px}',
    '.bes-clockpill.is-done{padding-right:13px}',
    '@media(max-width:1100px){.bes-clockpill .bcp-txt{display:none}.bes-clockpill{padding-left:10px}}',
    '@media(max-width:560px){.bes-clockpill .bcp-btn span{display:none}.bes-clockpill .bcp-btn{padding:0 9px}}',
    // phone top bar: round clock button beside search / bell
    '.bcp-mbtn{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;border:0;cursor:pointer;color:#fff;flex-shrink:0;padding:0;position:relative}',
    '.bcp-mbtn[hidden]{display:none}',
    '.bcp-mbtn.in{background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 0 0 3px rgba(16,185,129,.18)}',
    '.bcp-mbtn.out{background:linear-gradient(135deg,#ff6b06,#f9182f);box-shadow:0 0 0 3px rgba(249,24,47,.18)}',
    '.bcp-mbtn.done{background:rgba(96,165,250,.14);color:#93c5fd;border:1px solid rgba(96,165,250,.35);cursor:default}',
    '.bcp-mbtn:disabled{opacity:.6}',
    // Phone attendance card (dashboard, below the header). Desktop keeps the header pill.
    '.bcp-mcard{display:none}',
    '@media(max-width:640px){.bcp-mcard:not([hidden]){display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px 14px;margin:0 0 14px;padding:14px 14px 14px 16px;border-radius:16px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);font-family:Inter,system-ui,sans-serif}}',
    '.bcp-mcard.is-in{border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.06)}',
    '.bcp-mcard.is-done{border-color:rgba(96,165,250,.25);background:rgba(96,165,250,.05)}',
    '.bcp-mc-l{min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.bcp-mc-k{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#8b93b8}',
    '.bcp-mc-k i{width:8px;height:8px;border-radius:50%;background:#6b74a0}',
    '.bcp-mcard.is-in .bcp-mc-k{color:#4ade80}.bcp-mcard.is-in .bcp-mc-k i{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.2)}',
    '.bcp-mcard.is-done .bcp-mc-k{color:#93c5fd}.bcp-mcard.is-done .bcp-mc-k i{background:#60a5fa}',
    '.bcp-mcard.is-off .bcp-mc-k{color:#c4b5fd}.bcp-mcard.is-off .bcp-mc-k i{background:#a78bfa}',
    '.bcp-mc-big{font-size:17px;font-weight:800;color:#fff;line-height:1.25;font-variant-numeric:tabular-nums}',
    '.bcp-mc-sub{font-size:12.5px;color:#a5adcf;font-variant-numeric:tabular-nums}',
    '.bcp-mc-btn{min-height:48px;min-width:118px;padding:0 18px;border-radius:13px;border:0;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:800 14px Inter,system-ui,sans-serif;color:#fff;cursor:pointer;touch-action:manipulation}',
    '.bcp-mc-btn.in{background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 8px 20px -10px rgba(16,185,129,.8)}',
    '.bcp-mc-btn.out{background:linear-gradient(135deg,#ff6b06,#f9182f);box-shadow:0 8px 20px -10px rgba(249,24,47,.8)}',
    '.bcp-mc-btn.ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#cbd5e1;font-weight:700}',
    '.bcp-mc-btn[hidden],.bcp-mc-link[hidden]{display:none!important}',
    '.bcp-mc-btn:disabled{opacity:.6}',
    '.bcp-mc-link{grid-column:1/-1;justify-self:start;min-height:36px;background:none;border:0;padding:0;font:600 12px Inter,system-ui,sans-serif;color:#8b93b8;text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
    '.bcp-mbtn{width:40px;height:40px}'
  ].join('');
  var IC_IN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/></svg>';
  var IC_OUT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>';

  function visible(el) { return !!el && !el.classList.contains('hidden') && el.style.display !== 'none'; }
  function findCard() {
    var cards = [].slice.call(document.querySelectorAll('.bes-att')).filter(function (c) { return c.querySelector('.bes-clk'); });
    // prefer the page's own primary card ids, else the first card with clock buttons
    return cards.find(function (c) { return c.querySelector('#attendance-clockin-btn,#hr-attendance-clockin-btn,#clockBtn'); }) || cards[0] || null;
  }
  function shortStatus(card, state) {
    var st = card.querySelector('.bes-att-st'), t = st ? st.textContent.replace(/\s+/g, ' ').trim() : '';
    var times = t.match(/\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?/g) || [];
    if (state === 'in') return times[0] ? 'In since <b>' + times[0] + '</b>' : 'Clocked in';
    if (state === 'done') return times.length > 1 ? 'Done <b>' + times[0] + ' – ' + times[1] + '</b>' : 'Done for today';
    if (/checking/i.test(t)) return 'Checking…';
    return 'Not clocked in';
  }
  function mount() {
    var card = findCard(), header = document.querySelector('.bes-date');
    if (!card || !header) return false;
    if (!document.getElementById('bes-clockpill-css')) { var s = document.createElement('style'); s.id = 'bes-clockpill-css'; s.textContent = CSS; document.head.appendChild(s); }
    var pill = document.createElement('div');
    pill.className = 'bes-clockpill'; pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'Attendance');
    pill.innerHTML = '<span class="bcp-dot" aria-hidden="true"></span><span class="bcp-txt"></span><button type="button" class="bcp-btn"></button><span class="bcp-chip" hidden aria-disabled="true"></span><button type="button" class="bcp-link" hidden></button>';
    header.parentNode.insertBefore(pill, header);
    card.classList.add('bes-att-moved');
    // Phone: a clear, labeled attendance card at the top of the dashboard (above the banner)
    // instead of relying on the small round button in the top bar.
    var mcard = document.createElement('section');
    mcard.className = 'bcp-mcard'; mcard.setAttribute('aria-label', 'Attendance'); mcard.hidden = true;
    mcard.innerHTML = '<div class="bcp-mc-l"><span class="bcp-mc-k"><i></i><span class="bcp-mc-kt">Attendance</span></span><span class="bcp-mc-big"></span><span class="bcp-mc-sub"></span></div><button type="button" class="bcp-mc-btn in"></button><button type="button" class="bcp-mc-link" hidden></button>';
    var topStack = card.closest('.bes-top');
    if (topStack) topStack.insertBefore(mcard, topStack.firstChild); else card.parentNode.insertBefore(mcard, card);
    var mcVisible = false;
    try { new IntersectionObserver(function (es) { mcVisible = es.some(function (e) { return e.isIntersecting; }); syncTopBtn(); }).observe(mcard); } catch (_) {}
    var btn = pill.querySelector('.bcp-btn'), txt = pill.querySelector('.bcp-txt'), chip = pill.querySelector('.bcp-chip'), link = pill.querySelector('.bcp-link');
    // Phone top bar (#mobile-topbar, shared by every portal): the desktop header is hidden on
    // phones, so the same Clock In / Clock Out also gets a round button next to search / bell.
    var mbtn = document.createElement('button'); mbtn.type = 'button'; mbtn.className = 'bcp-mbtn'; mbtn.hidden = true;
    (function placeMobile(n) {
      var icon = document.querySelector('#mobile-topbar .be-mtb-icon-btn');
      if (icon && icon.parentNode) { icon.parentNode.insertBefore(mbtn, icon); return; }
      if (n < 40) setTimeout(function () { placeMobile(n + 1); }, 500);
    })(0);
    mbtn.addEventListener('click', function () { if (mbtn._target && !mbtn._target.disabled) mbtn._target.click(); });
    function realButtons() {
      var bs = [].slice.call(card.querySelectorAll('.bes-clk'));
      return { in: bs.find(function (b) { return b.classList.contains('bes-clk-in') || /clock in/i.test(b.textContent); }),
               out: bs.find(function (b) { return b.classList.contains('bes-clk-out') || /clock out/i.test(b.textContent); }), all: bs };
    }
    // ── helpers: company day (IST), worked hours, day-off from the shared leave policy ──
    function istToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
    function mins(t) { var m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(t || ''); if (!m) return null; var h = +m[1] % 12; if (!m[3]) h = +m[1]; else if (/pm/i.test(m[3])) h += 12; return h * 60 + (+m[2]); }
    function worked(a, b) { var x = mins(a), y = mins(b); if (x == null || y == null || y < x) return ''; var d = y - x; return Math.floor(d / 60) + 'h ' + String(d % 60).padStart(2, '0') + 'm'; }
    function g(name) { try { return Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')(); } catch (_) { return undefined; } }
    function myEmail() { var a = g('activeEmail'); if (a) return a; var cu = g('currentUser'); if (cu && cu.username) return cu.username; var me = g('ME'); return me && me.email ? me.email : null; }
    function db() { var d = g('dbInstance'); if (d && d.from) return d; d = g('sb'); return d && d.from ? d : null; }
    var off = { date: null, label: null, busy: false };
    // Holiday / weekly off / not scheduled / official event / full-day approved leave — decided by
    // the same LeavePolicy.resolveAttendanceStatus() that attendance and payroll use.
    async function loadDayOff() {
      var d = istToday();
      if (off.busy || off.date === d) return;
      off.busy = true;
      var label = null;
      try {
        var LP = window.LeavePolicy, c = db(), em = myEmail();
        if (LP && LP.resolveAttendanceStatus && c && em) {
          if (!LP.db && LP.withClient) LP.withClient(c);
          var r = await c.from('hr_employees').select('*').eq('portal_email', String(em).trim().toLowerCase()).limit(1);
          var emp = r.data && r.data[0];
          if (emp && emp.account_type !== 'system' && LP.db && LP.db.buildContext) {
            var ctx = await LP.db.buildContext(emp, { now: new Date(), date: d });
            var res = LP.resolveAttendanceStatus(ctx, d) || {};
            if (res.code === 'H') { var h = (ctx.holidays || []).find(function (x) { return String(x.holiday_date || '').slice(0, 10) === d; }); label = 'Holiday' + (h && h.name ? ' · ' + h.name : ''); }
            else if (res.code === 'WO') label = 'Weekly off';
            else if (res.code === 'NS') label = 'Not a working day';
            else if (res.code === 'OE') label = 'Official event';
            else if (res.leave && !res.half) label = 'On leave';
          }
        }
      } catch (_) {}
      off = { date: d, label: label, busy: false };
      sync();
    }
    // Small confirm dialog (never the browser's confirm()).
    function ask(title, text, okLabel) {
      return new Promise(function (resolve) {
        var bg = document.createElement('div'); bg.className = 'bcp-dlg-bg';
        bg.innerHTML = '<div class="bcp-dlg" role="dialog" aria-modal="true"><h3></h3><p></p><div class="bcp-dlg-b"><button type="button" data-a="no">Cancel</button><button type="button" class="pri" data-a="yes"></button></div></div>';
        bg.querySelector('h3').textContent = title; bg.querySelector('p').textContent = text; bg.querySelector('.pri').textContent = okLabel || 'Continue';
        function done(v) { bg.remove(); document.removeEventListener('keydown', esc); resolve(v); }
        function esc(e) { if (e.key === 'Escape') done(false); }
        bg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) done(b.dataset.a === 'yes'); else if (e.target === bg) done(false); });
        document.addEventListener('keydown', esc);
        document.body.appendChild(bg); bg.querySelector('[data-a="no"]').focus();
      });
    }
    function clockInAnyway(target) {
      return ask('Clock in on a day off?', (off.label || 'Today is not a working day') + ' — no clock-in is needed. Clock in only if you are actually working today.', 'Clock in').then(function (ok) { if (ok && target && !target.disabled) target.click(); });
    }
    link.addEventListener('click', function () {
      if (link.dataset.a === 'reopen') {
        ask('Re-open today’s attendance?', 'Today’s attendance is already completed. Do you want to start another attendance session? The clock-out time will be cleared and recorded in the audit log.', 'Continue')
          .then(function (ok) { if (ok && typeof window.beClockReopen === 'function') window.beClockReopen(); });
      } else if (link.dataset.a === 'anyway') clockInAnyway(btn._target || mbtn._target);
    });

    function sync() {
      // The card's own "hidden" means the page decided clocking doesn't apply (e.g. system account).
      var cardOn = !card.classList.contains('hidden');
      var r = realButtons(), target = null, state = 'none';
      if (r.all.length === 1) {               // single toggle button (Sales)
        var one = r.all[0];
        if (visible(one) && !one.disabled) { target = one; state = /out/i.test(one.textContent) ? 'in' : 'none'; } else state = 'done';
      } else if (visible(r.out)) { target = r.out; state = 'in'; }
      else if (visible(r.in)) { target = r.in; state = 'none'; }
      else state = 'done';
      if (state === 'none' && off.date !== istToday()) loadDayOff();
      var dayOff = state === 'none' && off.date === istToday() && off.label;
      pill.hidden = !cardOn;
      pill.classList.toggle('is-in', state === 'in'); pill.classList.toggle('is-done', state === 'done' || !!dayOff);
      var stText = card.querySelector('.bes-att-st') ? card.querySelector('.bes-att-st').textContent.replace(/\s+/g, ' ').trim() : '';
      var times = stText.match(/\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?/g) || [];
      if (state === 'done') {
        var hrs = times.length > 1 ? worked(times[0], times[1]) : '';
        txt.innerHTML = '✓ ' + (times.length > 1 ? 'Done <b>' + times[0] + ' – ' + times[1] + '</b>' : 'Attendance completed') + (hrs ? ' <span class="bcp-hrs">· ' + hrs + '</span>' : '');
      } else if (dayOff) txt.innerHTML = '<b>' + off.label.replace(/</g, '&lt;') + '</b> · no clock-in needed';
      else txt.innerHTML = shortStatus(card, state);
      // Primary action: Clock In / Clock Out. Completed day → neutral "Completed today" chip.
      if (target && !dayOff) {
        var out = state === 'in';
        btn.hidden = false; btn.className = 'bcp-btn ' + (out ? 'out' : 'in');
        btn.innerHTML = (out ? IC_OUT : IC_IN) + '<span>' + (out ? 'Clock Out' : 'Clock In') + '</span>';
        btn.disabled = !!target.disabled;
        btn.title = stText;
        btn._target = target;
      } else { btn.hidden = true; btn._target = dayOff ? target : null; }
      chip.hidden = !(state === 'done' || dayOff);
      chip.className = 'bcp-chip' + (dayOff ? ' off' : '');
      chip.textContent = dayOff ? 'Day off' : 'Completed today';
      chip.title = dayOff ? off.label : 'Clock In opens again tomorrow';
      var canReopen = state === 'done' && typeof window.beClockReopenAllowed === 'function' && window.beClockReopenAllowed();
      link.hidden = !(canReopen || dayOff);
      link.dataset.a = canReopen ? 'reopen' : 'anyway';
      link.textContent = canReopen ? 'Re-open' : 'Clock in anyway';
      var plain = txt.textContent;
      mbtn.hidden = !cardOn;
      mbtn._target = dayOff ? null : target; mbtn._dayoff = dayOff ? target : null;
      mbtn.disabled = target && !dayOff ? !!target.disabled : false;
      mbtn.className = 'bcp-mbtn ' + (target && !dayOff ? (state === 'in' ? 'out' : 'in') : 'done');
      mbtn.innerHTML = target && !dayOff ? (state === 'in' ? IC_OUT : IC_IN) : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
      var lbl = target && !dayOff ? (state === 'in' ? 'Clock Out — ' + plain : 'Clock In — ' + plain) : plain + (state === 'done' ? ' · Completed today' : '');
      mbtn.setAttribute('aria-label', lbl); mbtn.title = lbl;
      // ── phone card ──
      mcard.hidden = !cardOn;
      mcard.className = 'bcp-mcard' + (state === 'in' ? ' is-in' : state === 'done' ? ' is-done' : dayOff ? ' is-off' : '');
      var kt = mcard.querySelector('.bcp-mc-kt'), big = mcard.querySelector('.bcp-mc-big'), sub = mcard.querySelector('.bcp-mc-sub'), mb = mcard.querySelector('.bcp-mc-btn'), ml = mcard.querySelector('.bcp-mc-link');
      mb._target = target; mb._mode = null;
      if (state === 'in') {
        var nowM = mins(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()));
        var startM = mins(times[0]), w = (startM != null && nowM != null && nowM >= startM) ? nowM - startM : null;
        kt.textContent = 'Clocked in'; big.textContent = times[0] ? 'Since ' + times[0] : 'Clocked in';
        sub.textContent = w != null ? 'Working for ' + Math.floor(w / 60) + 'h ' + String(w % 60).padStart(2, '0') + 'm' : 'Remember to clock out';
        mb.hidden = !target; mb.className = 'bcp-mc-btn out'; mb.innerHTML = IC_OUT + 'Clock Out'; mb._mode = 'out'; mb.disabled = !!(target && target.disabled);
      } else if (state === 'done') {
        kt.textContent = '✓ Attendance completed';
        big.textContent = times.length > 1 ? times[0] + ' – ' + times[1] : 'Done for today';
        sub.textContent = times.length > 1 && worked(times[0], times[1]) ? worked(times[0], times[1]) + ' worked · Clock In opens tomorrow' : 'Clock In opens tomorrow';
        mb.hidden = true;
      } else if (dayOff) {
        kt.textContent = off.label; big.textContent = 'No clock-in needed today'; sub.textContent = 'Working today anyway? Clock in below.';
        mb.hidden = !target; mb.className = 'bcp-mc-btn ghost'; mb.textContent = 'Clock in anyway'; mb._mode = 'anyway'; mb.disabled = false;
      } else {
        kt.textContent = 'Attendance'; big.textContent = /checking/i.test(stText) ? 'Checking…' : 'You haven\u2019t clocked in yet'; sub.textContent = 'Tap Clock In when you start work';
        mb.hidden = !target; mb.className = 'bcp-mc-btn in'; mb.innerHTML = IC_IN + 'Clock In'; mb._mode = 'in'; mb.disabled = !!(target && target.disabled);
      }
      ml.hidden = !canReopen; ml.textContent = 'Re-open today\u2019s attendance';
      // In-flight clock action (BEClock): every control shows progress and is locked; right after
      // a change they stay locked for a moment so a repeated tap can't hit the new button.
      var C = window.BEClock;
      if (C && C.busy) {
        var lbl2 = (C.kind === 'out' ? 'Clocking out…' : 'Clocking in…') + (C.slow ? ' (slow connection)' : '');
        btn.hidden = false; btn.disabled = true; btn.innerHTML = '<span class="bclk-spin"></span><span>' + lbl2 + '</span>';
        mb.hidden = false; mb.disabled = true; mb.innerHTML = '<span class="bclk-spin"></span>' + (C.kind === 'out' ? 'Clocking out…' : 'Clocking in…');
        if (C.slow) sub.textContent = 'Slow connection — still waiting for the server…';
        mbtn.disabled = true; mbtn.innerHTML = '<span class="bclk-spin"></span>';
      } else if (C && C.coolingDown) { btn.disabled = true; mb.disabled = true; mbtn.disabled = true; }
      syncTopBtn();
    }
    window.addEventListener('be-clock', function () { sync(); });
    // The round top-bar button stays for other screens; it hides while the card is on screen.
    function syncTopBtn() { if (mcard && !mcard.hidden && mcVisible) mbtn.style.display = 'none'; else mbtn.style.display = ''; }
    mcard.querySelector('.bcp-mc-btn').addEventListener('click', function () {
      var b = this, t = b._target; if (!t || t.disabled) return;
      if (b._mode === 'anyway') { clockInAnyway(t); return; }
      t.click();
    });
    mcard.querySelector('.bcp-mc-link').addEventListener('click', function () {
      ask('Re-open today\u2019s attendance?', 'Today\u2019s attendance is already completed. Do you want to start another attendance session? The clock-out time will be cleared and recorded in the audit log.', 'Continue')
        .then(function (ok) { if (ok && typeof window.beClockReopen === 'function') window.beClockReopen(); });
    });
    setInterval(function () { if (!mcard.hidden && mcard.classList.contains('is-in')) sync(); }, 30000);
    // Header pill button → the page's real Clock In / Clock Out (its handler runs BEClock).
    btn.addEventListener('click', function () { if (btn._target && !btn._target.disabled) btn._target.click(); });
    mbtn.addEventListener('click', function () { if (mbtn._dayoff) clockInAnyway(mbtn._dayoff); });
    // New company day (IST midnight): re-read today's attendance so Clock In returns — and only
    // then; the completed state stays for the rest of the day even across reloads (it comes from
    // the day's attendance row in the database).
    var lastDay = istToday();
    function rollover() {
      var d = istToday(); if (d === lastDay) return; lastDay = d; off.date = null;
      try { if (typeof window.refreshAttendanceClockCard === 'function') window.refreshAttendanceClockCard(); } catch (_) {}
      try { var ic = g('refreshAttendanceClockCard'); if (typeof ic === 'function') ic(); } catch (_) {}
      try { var init = g('initClock'); if (typeof init === 'function') init(); } catch (_) {}
      sync();
    }
    (function scheduleMidnight() {
      var p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
      var ms = ((24 * 3600) - (p[0] * 3600 + p[1] * 60 + p[2])) * 1000 + 3000;
      setTimeout(function () { rollover(); scheduleMidnight(); }, Math.min(ms, 6 * 3600 * 1000));
    })();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') rollover(); });
    new MutationObserver(sync).observe(card, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'disabled'] });
    sync();
    return true;
  }
  var tries = 0;
  (function wait() { if (mount()) return; if (++tries < 60) setTimeout(wait, 500); })();
})();
