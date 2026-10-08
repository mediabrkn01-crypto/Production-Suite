/* ════════════════════════════════════════════════════════════════════════════
   JARVIS voice client — the built-in ERP assistant. No separate login: it uses the
   ERP session of whoever is signed in (BESession token from the normal portal login).
   The server re-resolves identity + access from HR on every question.

   Two hosts:
     • Manager Command Deck — drives the existing globe (JarvisVoice.init({globe, sub, …}))
     • every other portal   — a small floating Jarvis orb (auto, see bottom of file)

   Tap → LISTENING (mic → 16 kHz PCM, auto-stops after ~1.2 s of silence; tap again to
   send) → POST to the `jarvis` edge function → Server-Sent Events:
     state · transcript.partial/final · assistant.text · audio.chunk · error · done
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.JarvisVoice) return;
  var EXPIRED = 'Your session has expired. Please sign in again to continue using Jarvis.';
  var STATE_LABEL = {
    IDLE: 'Tap the globe · JARVIS listens', WAKE_DETECTED: 'Yes?', LISTENING: 'LISTENING… tap to send', TRANSCRIBING: 'HEARING YOU…',
    THINKING: 'THINKING…', CHECKING_ERP: 'CHECKING ERP…', CHECKING_CRM: 'CHECKING CRM…', SPEAKING: 'SPEAKING', ERROR: 'JARVIS ERROR'
  };
  var STATE_GLOW = {
    WAKE_DETECTED: '255,255,255', LISTENING: '237,31,81', TRANSCRIBING: '240,88,37', THINKING: '77,159,255', CHECKING_ERP: '255,194,75',
    CHECKING_CRM: '255,194,75', SPEAKING: '47,224,140', ERROR: '255,77,94'
  };
  var cfg = null, ui = null;
  var state = 'IDLE', busy = false, rec = null, abortCtl = null, player = null, stateFns = [];
  var sessionId = (function () { try { var s = sessionStorage.getItem('jarvis_session'); if (!s) { s = 'erp-' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('jarvis_session', s); } return s; } catch (_) { return 'erp-' + Date.now(); } })();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setState(s) {
    state = s;
    if (ui.sub) ui.sub.textContent = ui.idleLabel && s === 'IDLE' ? ui.idleLabel : (STATE_LABEL[s] || s);
    var g = ui.globe;
    if (g) {
      var c = STATE_GLOW[s];
      g.style.filter = c ? 'drop-shadow(0 0 ' + (s === 'SPEAKING' ? 46 : 30) + 'px rgba(' + c + ',.65))' : '';
      if (window._g && _g.controls) _g.controls().autoRotateSpeed = s === 'IDLE' ? .5 : (s === 'CHECKING_ERP' || s === 'CHECKING_CRM' ? 4 : 1.6);
    }
    if (typeof ui.onState === 'function') { try { ui.onState(s); } catch (_) {} }
    stateFns.forEach(function (f) { try { f(s); } catch (_) {} });
  }
  function say(text, ms) {
    if (!ui.sub) return;
    ui.sub.textContent = text;
    clearTimeout(ui.sub._jh);
    ui.sub._jh = setTimeout(function () { if (state === 'IDLE') ui.sub.textContent = ui.idleLabel || STATE_LABEL.IDLE; }, ms || 9000);
  }

  // ── ERP session (no Jarvis login) ─────────────────────────────────────────────
  function token() { return window.BESession ? BESession.token() : null; }
  function signInAgain() {
    try { if (window.BESession) BESession.clear(BESession.currentEmail()); } catch (_) {}
    try { ['be_active_email', 'be_active_user', 'be_active_role', 'be_media_academic_session'].forEach(function (k) { localStorage.removeItem(k); }); } catch (_) {}
    location.href = 'index.html';
  }
  function sessionExpired() {
    setState('IDLE'); say(EXPIRED, 12000);
    if (typeof ui.sheet === 'function') {
      ui.sheet('JARVIS', 'Session expired', '', '<div style="font-size:14px;line-height:1.7;margin-bottom:14px">' + EXPIRED + '</div><button type="button" class="l-btn" id="jv-relogin">Sign in again</button>');
      var b = document.getElementById('jv-relogin'); if (b) b.onclick = signInAgain;
    }
  }

  // ── one recorder: 16 kHz PCM16 frames + a simple end-of-speech detector. Fed either by
  //    its own microphone (tap) or by the wake-word service's stream (no second mic, keeps
  //    the words right after "Hey Jarvis"). ────────────────────────────────────────────
  function makeRecorder() {
    var chunks = [], heard = false, silentMs = 0, started = Date.now(), level = 0;
    var r = { chunks: chunks, stopped: false, onAutoStop: null };
    r.push = function (out) {           // out: Int16Array @ 16 kHz
      if (r.stopped || !out || !out.length) return;
      chunks.push(out);
      var energy = 0; for (var i = 0; i < out.length; i++) { var v = out[i] / 32768; energy += v * v; }
      var rms = Math.sqrt(energy / out.length), ms = out.length / 16;
      level = Math.min(1, rms * 6);
      if (rms > 0.02) { heard = true; silentMs = 0; } else if (heard) silentMs += ms;
      if ((heard && silentMs > (r.silenceMs || 1200)) || Date.now() - started > 30000 || (!heard && Date.now() - started > (r.noSpeechMs || 8000))) { if (r.onAutoStop) r.onAutoStop(); }
    };
    r.level = function () { return level; };
    r.heard = function () { return heard; };
    r.raf = 0;
    (function loop() {
      if (r.stopped) return;
      if (ui.globe && ui.scale) ui.globe.style.transform = ui.scale(1 + level * .18);
      r.raf = requestAnimationFrame(loop);
    })();
    return r;
  }
  async function startCapture() {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var src = ctx.createMediaStreamSource(stream);
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    var ratio = ctx.sampleRate / 16000;
    var r = makeRecorder();
    r.stream = stream; r.ctx = ctx;
    proc.onaudioprocess = function (e) {
      if (r.stopped) return;
      var input = e.inputBuffer.getChannelData(0);
      var outLen = Math.floor(input.length / ratio), out = new Int16Array(outLen);
      for (var i = 0; i < outLen; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(input[Math.floor(i * ratio)] * 32767)));
      r.push(out);
    };
    src.connect(proc); proc.connect(ctx.destination);
    r.proc = proc;
    return r;
  }
  function stopCapture(r) {
    if (!r || r.stopped) return null;
    r.stopped = true; cancelAnimationFrame(r.raf);
    if (r.proc) {   // own microphone (tap); wake-fed recorders share the wake service's stream
      try { r.proc.disconnect(); } catch (_) {}
      try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
      try { r.ctx.close(); } catch (_) {}
    }
    if (ui.globe && ui.scale) ui.globe.style.transform = ui.scale(1);
    var n = r.chunks.reduce(function (a, c) { return a + c.length; }, 0), pcm = new Int16Array(n), o = 0;
    r.chunks.forEach(function (c) { pcm.set(c, o); o += c.length; });
    return pcm;
  }

  // ── streamed MP3 playback ─────────────────────────────────────────────────────
  function makePlayer() {
    var MS = window.ManagedMediaSource || window.MediaSource;
    var audio = new Audio(), queue = [], all = [], sbuf = null, ended = false, usingMS = !!(MS && MS.isTypeSupported && MS.isTypeSupported('audio/mpeg'));
    audio.disableRemotePlayback = true;
    var p = { audio: audio };
    if (usingMS) {
      var ms = new MS(); audio.src = URL.createObjectURL(ms);
      var pump = function () {
        if (!sbuf || sbuf.updating) return;
        if (queue.length) { try { sbuf.appendBuffer(queue.shift()); } catch (_) {} }
        else if (ended && ms.readyState === 'open') { try { ms.endOfStream(); } catch (_) {} }
      };
      ms.addEventListener('sourceopen', function () { sbuf = ms.addSourceBuffer('audio/mpeg'); sbuf.mode = 'sequence'; sbuf.addEventListener('updateend', pump); pump(); });
      p.push = function (u8) { queue.push(u8); pump(); if (audio.paused) audio.play().catch(function () {}); };
      p.end = function () { ended = true; pump(); };
    } else {
      p.push = function (u8) { all.push(u8); };
      p.end = function () { if (!all.length) return; audio.src = URL.createObjectURL(new Blob(all, { type: 'audio/mpeg' })); audio.play().catch(function () {}); };
    }
    p.stop = function () { try { audio.pause(); } catch (_) {} };
    return p;
  }
  function b64ToU8(b64) { var s = atob(b64), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

  // ── one turn: POST audio, read SSE ────────────────────────────────────────────
  async function send(pcm) {
    var tk = token();
    if (!tk) { sessionExpired(); return; }
    busy = true; abortCtl = new AbortController();
    setState('TRANSCRIBING');
    var answer = '', ttsFailed = false, gotAudio = false, transcript = '';
    player = makePlayer();
    try {
      var res = await fetch(cfg.fn + '?session=' + encodeURIComponent(sessionId) + '&rate=16000', {
        method: 'POST', signal: abortCtl.signal,
        headers: { 'Authorization': 'Bearer ' + cfg.key, 'apikey': cfg.key, 'x-erp-session': tk, 'Content-Type': 'application/octet-stream' },
        body: pcm.buffer
      });
      if (!res.ok) {
        var j = {}; try { j = await res.json(); } catch (_) {}
        if (res.status === 401 || j.code === 'SESSION_EXPIRED') { sessionExpired(); return; }
        setState('ERROR'); say(j.error || 'Jarvis is unavailable right now.'); setTimeout(function () { setState('IDLE'); }, 2500);
        return;
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      for (;;) {
        var step = await reader.read(); if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          var block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          var line = block.split('\n').filter(function (l) { return l.indexOf('data:') === 0; }).map(function (l) { return l.slice(5).trim(); }).join('');
          if (!line) continue;
          var ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.type === 'state') { if (ev.state !== 'IDLE') setState(ev.state); }
          else if (ev.type === 'transcript.partial') say('“' + ev.text + '”', 15000);
          else if (ev.type === 'transcript.final') { transcript = ev.text; say('“' + ev.text + '”', 15000); if (ui.onTranscript) try { ui.onTranscript(ev.text); } catch (_) {} }
          else if (ev.type === 'assistant.text') { answer = ev.text; }
          else if (ev.type === 'audio.chunk') { gotAudio = true; player.push(b64ToU8(ev.audio)); }
          else if (ev.type === 'error') { if (ev.code === 'TTS_UNAVAILABLE') ttsFailed = true; else if (!answer) answer = ev.message; }
        }
      }
      player.end();
      if (answer) say(answer, Math.min(30000, 4000 + answer.length * 70));
      if (answer && (ttsFailed || !gotAudio || answer.length > 220) && typeof ui.sheet === 'function') {
        ui.sheet('JARVIS', transcript ? '“' + transcript + '”' : 'Jarvis', ttsFailed ? 'Voice unavailable — text answer' : 'Live ERP answer', '<div style="font-size:14px;line-height:1.7;white-space:pre-wrap">' + esc(answer) + '</div>');
      }
      if (gotAudio) {
        setState('SPEAKING');
        await new Promise(function (r) { player.audio.onended = r; player.audio.onerror = r; setTimeout(r, 60000); });
      }
      setState('IDLE'); if (answer) say(answer, 8000);
    } catch (e) {
      if (e && e.name === 'AbortError') { setState('IDLE'); return; }
      setState('ERROR'); say('Jarvis could not be reached. Check your connection.'); setTimeout(function () { setState('IDLE'); }, 2500);
    } finally { busy = false; abortCtl = null; }
  }

  async function finishListening() {
    if (!rec) return;
    var r = rec; rec = null;
    var heard = r.heard(), pcm = stopCapture(r);
    if (!heard || !pcm || pcm.length < 16000 * 0.4) { setState('IDLE'); say('I didn\'t catch anything — tap and speak.'); return; }
    await send(pcm);
  }

  // ── default sheet (portals without their own) ─────────────────────────────────
  var sheetEl = null;
  function defaultCloseSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; } }
  function defaultSheet(sub, title, meta, html) {
    defaultCloseSheet(); css();
    sheetEl = document.createElement('div'); sheetEl.className = 'jv-sheet-bg';
    sheetEl.innerHTML = '<div class="jv-sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="jv-sheet-h"><div><div class="jv-eb">' + esc(sub) + '</div><h3>' + esc(title) + '</h3>' + (meta ? '<span>' + esc(meta) + '</span>' : '') + '</div><button type="button" aria-label="Close">✕</button></div><div class="jv-sheet-b">' + html + '</div></div>';
    sheetEl.addEventListener('click', function (e) { if (e.target === sheetEl || e.target.closest('.jv-sheet-h button')) defaultCloseSheet(); });
    document.body.appendChild(sheetEl);
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheetEl) defaultCloseSheet(); });

  var _css = false;
  function css() {
    if (_css) return; _css = true;
    var s = document.createElement('style');
    s.textContent = [
      '.jv-orb{position:fixed;right:22px;bottom:22px;z-index:140;display:flex;align-items:center;gap:10px;flex-direction:row-reverse}',
      '.jv-orb .jw-chip{margin-top:6px;font-size:9px;padding:3px 8px}',
      '.jv-orb-btn{width:58px;height:58px;border-radius:50%;border:none;cursor:pointer;background:radial-gradient(circle at 32% 30%,#ff7a94,#ed1f51 45%,#5c0d22 90%);box-shadow:0 0 26px rgba(237,31,81,.55),0 10px 30px rgba(0,0,0,.5);transition:transform .09s linear,filter .3s;animation:jvBreathe 3.2s ease-in-out infinite}',
      '.jv-orb-btn:focus-visible{outline:2px solid #fff;outline-offset:3px}',
      '@keyframes jvBreathe{0%,100%{box-shadow:0 0 22px rgba(237,31,81,.45),0 10px 30px rgba(0,0,0,.5)}50%{box-shadow:0 0 38px rgba(237,31,81,.75),0 10px 30px rgba(0,0,0,.5)}}',
      '.jv-orb-cap{max-width:min(320px,70vw);padding:8px 12px;border-radius:12px;background:rgba(10,8,14,.92);border:1px solid rgba(255,255,255,.1);color:#f2f1ee;font:600 11px Inter,system-ui,sans-serif;letter-spacing:.04em;box-shadow:0 10px 30px rgba(0,0,0,.5);opacity:0;transform:translateX(6px);transition:opacity .2s,transform .2s;pointer-events:none}',
      '.jv-orb.show-cap .jv-orb-cap,.jv-orb:hover .jv-orb-cap{opacity:1;transform:none}',
      '@media (max-width:820px){.jv-orb{bottom:calc(92px + env(safe-area-inset-bottom,0px));right:14px}.jv-orb-btn{width:50px;height:50px}}',
      '@media (prefers-reduced-motion:reduce){.jv-orb-btn{animation:none}}',
      '.jv-sheet-bg{position:fixed;inset:0;z-index:2100;background:rgba(3,3,7,.55);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;padding:16px}',
      '.jv-sheet{width:min(560px,100%);max-height:80vh;overflow:auto;background:linear-gradient(165deg,rgba(30,24,32,.96),rgba(9,7,13,.98));border:1px solid rgba(255,255,255,.13);border-radius:20px;box-shadow:0 50px 130px rgba(0,0,0,.9);color:#f2f1ee;font:13px Inter,system-ui,sans-serif}',
      '.jv-sheet-h{display:flex;justify-content:space-between;gap:12px;padding:18px 20px 12px;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.jv-sheet-h h3{margin:3px 0 2px;font-size:17px;font-weight:800}.jv-sheet-h span{font-size:12px;color:rgba(255,255,255,.55)}',
      '.jv-sheet-h button{width:32px;height:32px;border-radius:50%;border:none;background:rgba(255,255,255,.08);color:#f2f1ee;cursor:pointer;flex-shrink:0}',
      '.jv-sheet-b{padding:16px 20px 20px}',
      '.jv-eb{font:600 9.5px Barlow,Inter,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.3)}',
      '.jv-sheet .l-btn{width:100%;padding:12px;border:none;border-radius:11px;background:linear-gradient(120deg,#ed1f51,#f05825);color:#fff;font-weight:700;font-size:12px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}'
    ].join('');
    document.head.appendChild(s);
  }

  /** Floating orb for portals without the Manager globe. */
  function mountOrb() {
    css();
    var wrap = document.createElement('div'); wrap.className = 'jv-orb';
    wrap.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center"><button type="button" class="jv-orb-btn" aria-label="Ask Jarvis"></button><div data-jarvis-chip></div></div><div class="jv-orb-cap" aria-live="polite">Tap to ask Jarvis</div>';
    document.body.appendChild(wrap);
    var btn = wrap.querySelector('.jv-orb-btn'), cap = wrap.querySelector('.jv-orb-cap');
    return { wrap: wrap, btn: btn, cap: cap };
  }

  window.JarvisVoice = {
    /** opts: { globe?, sub?, scale?, sheet?, closeSheet?, onState?, onTranscript?, idleLabel? } */
    init: function (opts) {
      opts = opts || {};
      var B = window.BESession || {};
      cfg = { key: opts.key || B.anonKey, fn: opts.fn || ((opts.url || B.url) + '/functions/v1/jarvis') };
      ui = Object.assign({}, opts);
      if (!ui.sheet) { ui.sheet = defaultSheet; ui.closeSheet = defaultCloseSheet; }
    },
    get state() { return state; },
    toggle: async function () {
      if (!cfg) return false;
      if (busy) { if (abortCtl) abortCtl.abort(); if (player) player.stop(); setState('IDLE'); return true; }
      if (state === 'SPEAKING') { if (player) player.stop(); setState('IDLE'); return true; }
      if (rec) { await finishListening(); return true; }
      if (!token()) { sessionExpired(); return true; }
      var W = window.JarvisWake;
      if (W && W.shouldOffer && W.shouldOffer()) { W.offer(function () { JarvisVoice.toggle(); }); return true; }
      if (W && W.active && W.active()) { JarvisVoice.startFromStream([], false); return true; }   // same mic stream as the wake word
      try { rec = await startCapture(); } catch (e) { say('Mic blocked — allow it in the browser bar'); return true; }
      rec.onAutoStop = function () { finishListening(); };
      setState('LISTENING');
      return true;
    },
    /** Start a turn fed by the wake-word stream (JarvisWake.feed). preroll: Int16Array frames
     *  captured just before activation so "Hey Jarvis, who has classes…" keeps its start. */
    startFromStream: function (preroll, fromWake) {
      if (!cfg || busy || rec || state !== 'IDLE') return false;
      if (!token()) { sessionExpired(); return false; }
      rec = makeRecorder(); rec.external = true;
      rec.noSpeechMs = 6000;
      (preroll || []).forEach(function (f) { rec.push(f); });
      rec.onAutoStop = function () { finishListening(); };
      if (fromWake) {
        setState('WAKE_DETECTED'); say('Yes? I\'m listening…', 4000);
        setTimeout(function () { if (rec) setState('LISTENING'); }, 450);
      } else setState('LISTENING');
      return true;
    },
    /** Frames from the wake-word stream while a stream-fed turn is listening. */
    feed: function (frame) { if (rec && rec.external) rec.push(frame); },
    listening: function () { return !!rec; },
    sheet: function (sub, title, meta, html) { if (ui && ui.sheet) ui.sheet(sub, title, meta, html); },
    closeSheet: function () { if (ui && ui.closeSheet) ui.closeSheet(); },
    onStateChange: function (fn) { if (typeof fn === 'function') stateFns.push(fn); },
    get initialized() { return !!cfg; },
    /** Floating orb mode — used automatically on every portal except the Manager deck. */
    mountOrb: function () {
      if (cfg && ui && ui.globe) return;
      var o = mountOrb();
      JarvisVoice.init({
        sub: o.cap, idleLabel: 'Tap to ask Jarvis',
        onState: function (s) {
          o.wrap.classList.toggle('show-cap', s !== 'IDLE');
          var c = STATE_GLOW[s]; o.btn.style.filter = c ? 'drop-shadow(0 0 18px rgba(' + c + ',.9))' : '';
        },
        globe: o.btn, scale: function (s) { return 'scale(' + s + ')'; }
      });
      o.btn.addEventListener('click', function () { JarvisVoice.toggle(); });
      o.wrap.addEventListener('mouseenter', function () { if (state === 'IDLE') o.cap.textContent = 'Tap to ask Jarvis'; });
    }
  };

  // Auto: on any portal page loaded with <script src="jarvis-voice.js" data-jarvis-orb>, show the
  // orb once someone is signed in (not inside the Manager deck's embedded frames).
  var me = document.currentScript;
  if (me && me.hasAttribute('data-jarvis-orb')) {
    var embedded = /[?&]embed=1\b/.test(location.search) || window.self !== window.top;
    var tries = 0;
    var tryMount = function () {
      if (embedded || (cfg && ui && ui.globe)) return;
      var signedIn = window.BESession && BESession.currentEmail();
      if (signedIn) { JarvisVoice.mountOrb(); return; }
      if (++tries < 120) setTimeout(tryMount, 1000);   // wait for login on this page
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(tryMount, 600); });
    else setTimeout(tryMount, 600);
  }
})();
