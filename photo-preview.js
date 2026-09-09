/* ============================================================
   Broken English — shared profile-photo preview (WhatsApp-style)
   VIEW ONLY. One implementation for every page. Loaded on index/hr/
   academics/sales/manager. Never touches upload/storage/records.
   ------------------------------------------------------------
   Behaviour: clicking a REAL profile photo (a round <img> avatar)
   opens a centered, dimmed/blurred preview with the person's name.
   Fallback avatars (initials) are plain <div>s, never <img>, so they
   are automatically non-clickable — exactly the required rule.
   ============================================================ */
(function () {
  if (window.__bePhotoPreviewInit) return;
  window.__bePhotoPreviewInit = true;

  // ── styles (hover affordance + modal), injected once ──
  var css = document.createElement('style');
  css.textContent = [
    'img[data-be-pfp="1"]{cursor:pointer;transition:transform .15s ease, box-shadow .15s ease}',
    'img[data-be-pfp="1"]:hover{transform:scale(1.06);box-shadow:0 0 0 2px rgba(255,107,6,.55)}',
    '.be-pfp-overlay{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;',
    '  background:rgba(4,6,12,.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transition:opacity .18s ease}',
    '.be-pfp-overlay.be-pfp-show{opacity:1}',
    '.be-pfp-name{color:#fff;font-weight:800;font-size:16px;letter-spacing:.01em;text-align:center;max-width:90vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 2px 8px rgba(0,0,0,.5)}',
    '.be-pfp-frame{border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 70px rgba(0,0,0,.6);background:linear-gradient(145deg,#161116,#0a080a);',
    '  transform:scale(.9);transition:transform .18s cubic-bezier(.2,.8,.2,1);max-width:min(520px,86vw);max-height:78vh}',
    '.be-pfp-overlay.be-pfp-show .be-pfp-frame{transform:scale(1)}',
    '.be-pfp-frame img{display:block;width:100%;height:auto;max-height:78vh;object-fit:contain}',
    '.be-pfp-close{position:absolute;top:18px;right:20px;width:40px;height:40px;border-radius:12px;border:1px solid rgba(255,255,255,.14);',
    '  background:rgba(255,255,255,.06);color:#e5e9f5;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1}',
    '.be-pfp-close:hover{background:rgba(255,255,255,.12)}',
    '@media (max-width:640px){.be-pfp-frame{max-width:88vw}}'
  ].join('');
  (document.head || document.documentElement).appendChild(css);

  var overlay = null, keyHandler = null;

  function close() {
    if (!overlay) return;
    overlay.classList.remove('be-pfp-show');
    var o = overlay; overlay = null;
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    setTimeout(function () { if (o && o.parentNode) o.parentNode.removeChild(o); }, 200);
  }

  // Public, reusable entry point — same call everywhere.
  window.openProfilePhotoPreview = function (opts) {
    opts = opts || {};
    var url = opts.imageUrl; if (!url) return;
    var name = opts.name || '';
    close();
    overlay = document.createElement('div');
    overlay.className = 'be-pfp-overlay';
    overlay.innerHTML =
      '<button class="be-pfp-close" aria-label="Close">×</button>' +
      (name ? '<div class="be-pfp-name"></div>' : '') +
      '<div class="be-pfp-frame"><img alt=""></div>';
    if (name) overlay.querySelector('.be-pfp-name').textContent = name;
    var imgEl = overlay.querySelector('.be-pfp-frame img');
    imgEl.src = url; imgEl.alt = name || 'Profile photo';
    overlay.querySelector('.be-pfp-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    // force reflow then animate in
    void overlay.offsetWidth; overlay.classList.add('be-pfp-show');
    keyHandler = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', keyHandler);
  };

  // ── is this <img> a real, clickable profile avatar? ──
  function realSrc(img) {
    var s = img.currentSrc || img.getAttribute('src') || '';
    return /^(https?:|data:|blob:)/i.test(s) ? s : '';
  }
  function isAvatarImg(img) {
    if (!img || img.tagName !== 'IMG') return false;
    if (!realSrc(img)) return false;
    // never hijack a delivery/media viewer or our own preview
    if (img.closest('#mh-deliv-modal') || img.closest('.be-pfp-overlay')) return false;
    // leave interactive avatars alone (account menu, links, roster click-to-open-student, etc.)
    // so their existing action still runs — preview only plain display avatars.
    if (img.closest('button, a, [onclick], [role="button"]')) return false;
    var w = img.offsetWidth || img.width, h = img.offsetHeight || img.height;
    if (!w || w > 160) return false;                 // avatars are small; excludes logos/banners/delivery
    var r = getComputedStyle(img).borderRadius || '';
    var roundish = r.indexOf('50%') > -1 || r.indexOf('9999') > -1 || parseFloat(r) >= Math.min(w, h) * 0.25;
    return roundish;                                  // round + small = an avatar (initials fallbacks are <div>, never here)
  }
  function nameFor(img) {
    if (img.getAttribute('alt')) return img.getAttribute('alt').trim();
    if (img.dataset && img.dataset.name) return img.dataset.name;
    // nearest card heading text as a fallback
    var card = img.closest('.card, .glass-card, [class*="card"]');
    if (card) { var h = card.querySelector('p,span,h1,h2,h3,strong'); if (h && h.textContent) return h.textContent.trim().slice(0, 60); }
    return '';
  }

  // Delegated — works for avatars rendered now or later, on every page, no per-site edits.
  document.addEventListener('click', function (e) {
    var img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (!img || !isAvatarImg(img)) return;
    e.preventDefault(); e.stopPropagation();
    window.openProfilePhotoPreview({ imageUrl: realSrc(img), name: nameFor(img) });
  }, true); // capture: fire before other avatar onclicks (e.g. account menu) so the photo previews

  // Hover affordance: tag qualifying avatars on first pointerover (cheap, no observers).
  document.addEventListener('pointerover', function (e) {
    var img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (!img || img.getAttribute('data-be-pfp') === '1') return;
    if (isAvatarImg(img)) { img.setAttribute('data-be-pfp', '1'); if (!img.title) img.title = 'View photo'; }
  }, true);
})();
