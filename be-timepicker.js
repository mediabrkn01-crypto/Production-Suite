/**
 * BE Time Picker — Broken English clock picker (one design for every page).
 * - Auto-attaches to every input[type="time"] (writes HH:MM 24h, fires input + change).
 * - BETimePicker.pick({ value:'HH:MM', title, onConfirm(time24), onClear }) for custom callers
 *   (e.g. academics.html's openClockPicker) — same dialog, caller decides where the value goes.
 * Tap or drag on the dial: hour first, then it moves to minutes. Any minute can be dragged to;
 * the dial labels every 5. Esc / backdrop = cancel. Namespace: window.BETimePicker
 */
(function(){
  'use strict';
  var active = null; // { h, m, ap, mode, opts, root }

  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function to24(h, ap){ return ap === 'AM' ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12); }
  function parse(val){
    var p = String(val || '').split(':');
    if (p.length < 2 || isNaN(+p[0])) { var now = new Date(); return { h: ((now.getHours() + 11) % 12) + 1, m: 0, ap: now.getHours() < 12 ? 'AM' : 'PM' }; }
    var h24 = +p[0], m = +p[1] || 0;
    return { h: ((h24 + 11) % 12) + 1, m: m, ap: h24 < 12 ? 'AM' : 'PM' };
  }
  function fire(input){
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var SIZE = 232, C = SIZE / 2, R_NUM = 88;
  function dialSvg(s){
    var isH = s.mode === 'hour';
    var selAngle = isH ? (s.h % 12) * 30 : s.m * 6;
    var rad = selAngle * Math.PI / 180;
    var hx = C + (R_NUM - 17) * Math.sin(rad), hy = C - (R_NUM - 17) * Math.cos(rad);
    var bx = C + R_NUM * Math.sin(rad), by = C - R_NUM * Math.cos(rad);
    var out = '<circle cx="' + C + '" cy="' + C + '" r="' + (C - 2) + '" class="tp-face"/>';
    // minute ticks (every minute faint, every 5 stronger) — only in minute mode
    if (!isH) for (var t = 0; t < 60; t++) {
      if (t % 5 === 0) continue;
      var a = t * 6 * Math.PI / 180, r1 = C - 10, r2 = C - 14;
      out += '<line x1="' + (C + r1 * Math.sin(a)) + '" y1="' + (C - r1 * Math.cos(a)) + '" x2="' + (C + r2 * Math.sin(a)) + '" y2="' + (C - r2 * Math.cos(a)) + '" class="tp-tick"/>';
    }
    out += '<line x1="' + C + '" y1="' + C + '" x2="' + hx + '" y2="' + hy + '" class="tp-hand"/>';
    out += '<circle cx="' + C + '" cy="' + C + '" r="4.5" class="tp-pivot"/>';
    out += '<circle cx="' + bx + '" cy="' + by + '" r="18" class="tp-sel"/>';
    // a minute that isn't on a 5-step: show its own value inside the selector bubble
    if (!isH && s.m % 5 !== 0) out += '<text x="' + bx + '" y="' + (by + 4.5) + '" class="tp-num on">' + pad(s.m) + '</text>';
    for (var i = 0; i < 12; i++) {
      var val = isH ? (i === 0 ? 12 : i) : i * 5;
      var ang = i * 30 * Math.PI / 180;
      var x = C + R_NUM * Math.sin(ang), y = C - R_NUM * Math.cos(ang);
      var on = isH ? val === s.h : val === s.m;
      out += '<text x="' + x + '" y="' + (y + 4.5) + '" class="tp-num' + (on ? ' on' : '') + '">' + (isH ? val : pad(val)) + '</text>';
    }
    return out;
  }

  function render(){
    var s = active; if (!s) return;
    var r = s.root;
    r.querySelector('[data-seg="h"]').textContent = pad(s.h);
    r.querySelector('[data-seg="m"]').textContent = pad(s.m);
    r.querySelector('[data-seg="h"]').classList.toggle('on', s.mode === 'hour');
    r.querySelector('[data-seg="m"]').classList.toggle('on', s.mode === 'minute');
    r.querySelector('[data-ap="AM"]').classList.toggle('on', s.ap === 'AM');
    r.querySelector('[data-ap="PM"]').classList.toggle('on', s.ap === 'PM');
    r.querySelector('.tp-hint').textContent = s.mode === 'hour' ? 'Pick the hour' : 'Pick the minutes';
    r.querySelector('.tp-dial').innerHTML = dialSvg(s);
  }

  function angleAt(svg, x, y){
    var b = svg.getBoundingClientRect();
    var d = Math.atan2(x - (b.left + b.width / 2), -(y - (b.top + b.height / 2))) * 180 / Math.PI;
    return d < 0 ? d + 360 : d;
  }

  function close(){
    if (!active) return;
    var root = active.root;
    root.classList.remove('open');
    setTimeout(function(){ if (root.parentNode) root.parentNode.removeChild(root); }, 160);
    document.removeEventListener('keydown', onKey, true);
    active = null;
  }
  function confirm(){
    var s = active; if (!s) return;
    var t = pad(to24(s.h, s.ap)) + ':' + pad(s.m);
    var cb = s.opts.onConfirm;
    close();
    if (typeof cb === 'function') cb(t);
  }
  function onKey(e){
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  }

  function pick(opts){
    opts = opts || {};
    close();
    var p = parse(opts.value);
    var root = document.createElement('div');
    root.className = 'tp-overlay';
    root.innerHTML =
      '<div class="tp-box" role="dialog" aria-modal="true" aria-label="' + (opts.title || 'Select time') + '">' +
        '<div class="tp-top">' +
          '<div class="tp-title">' + (opts.title || 'Select time') + '</div>' +
          '<div class="tp-read">' +
            '<button type="button" class="tp-seg" data-seg="h" aria-label="Hour"></button><span class="tp-colon">:</span>' +
            '<button type="button" class="tp-seg" data-seg="m" aria-label="Minutes"></button>' +
            '<div class="tp-ap" role="group" aria-label="AM or PM"><button type="button" data-ap="AM">AM</button><button type="button" data-ap="PM">PM</button></div>' +
          '</div>' +
          '<div class="tp-hint"></div>' +
        '</div>' +
        '<svg class="tp-dial" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" aria-hidden="true"></svg>' +
        '<div class="tp-foot">' +
          (typeof opts.onClear === 'function' ? '<button type="button" class="tp-link" data-act="clear">Clear</button>' : '<span></span>') +
          '<div class="tp-btns"><button type="button" class="tp-btn" data-act="cancel">Cancel</button><button type="button" class="tp-btn pri" data-act="ok">Set time</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    active = { h: p.h, m: p.m, ap: p.ap, mode: 'hour', opts: opts, root: root };

    root.addEventListener('mousedown', function(e){ if (e.target === root) { e.preventDefault(); close(); } });
    root.addEventListener('click', function(e){
      var b = e.target.closest('button'); if (!b || !active) return;
      if (b.dataset.seg) { active.mode = b.dataset.seg === 'h' ? 'hour' : 'minute'; render(); }
      else if (b.dataset.ap) { active.ap = b.dataset.ap; render(); }
      else if (b.dataset.act === 'cancel') close();
      else if (b.dataset.act === 'ok') confirm();
      else if (b.dataset.act === 'clear') { var cb = active.opts.onClear; close(); cb(); }
    });
    var svg = root.querySelector('.tp-dial');
    svg.addEventListener('pointerdown', function(e){
      if (!active) return;
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      var set = function(ev){
        var d = angleAt(svg, ev.clientX, ev.clientY);
        if (active.mode === 'hour') active.h = Math.round(d / 30) % 12 || 12;
        else active.m = Math.round(d / 6) % 60;
        render();
      };
      set(e);
      var move = function(ev){ set(ev); };
      var up = function(){
        svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up);
        if (active && active.mode === 'hour') { active.mode = 'minute'; render(); }
      };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    });
    document.addEventListener('keydown', onKey, true);
    render();
    void root.offsetWidth;   // commit the start state so the fade-in runs (works even in background tabs)
    root.classList.add('open');
  }

  // input[type=time] → same dialog, value written back as HH:MM (24h)
  function open(input){
    pick({
      value: input.value,
      title: input.getAttribute('aria-label') || input.getAttribute('placeholder') || 'Select time',
      onConfirm: function(t){ input.value = t; fire(input); },
      onClear: function(){ input.value = ''; fire(input); }
    });
  }
  function attach(input){
    if (input._beTPAttached) return;
    input._beTPAttached = true;
    if (input.readOnly) return;   // readonly time fields (e.g. auto-computed end times) stay as-is
    var go = function(e){ e.preventDefault(); if (e.type === 'mousedown') input.blur(); if (!active) open(input); };
    input.addEventListener('mousedown', go);
    input.addEventListener('touchstart', go, { passive: false });
    input.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' ') go(e); });
  }
  function init(){
    document.querySelectorAll('input[type="time"]').forEach(attach);
    if (window.MutationObserver) new MutationObserver(function(ms){
      ms.forEach(function(m){ m.addedNodes.forEach(function(n){
        if (n.nodeType !== 1) return;
        if (n.matches && n.matches('input[type="time"]')) attach(n);
        if (n.querySelectorAll) n.querySelectorAll('input[type="time"]').forEach(attach);
      }); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.BETimePicker = { pick: pick, open: open, close: close, attach: attach };
})();
