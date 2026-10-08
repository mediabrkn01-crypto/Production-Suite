/* ════════════════════════════════════════════════════════════════════════════
   JARVIS voice client — connects a deck globe (Manager Command Deck) to the Jarvis
   backend (Supabase Edge Function `jarvis`). No UI redesign: it drives the globe's
   glow/scale, one caption line (ui.sub) and the page's own sheet (ui.sheet) for
   sign-in and text fallbacks.

   Flow (tap the globe):
     tap → LISTENING (mic → 16 kHz PCM, auto-stops after ~1.2 s of silence; tap again
     to stop early) → POST audio → Server-Sent Events back:
       state · transcript.partial/final · assistant.text · audio.chunk · error · done
     Audio chunks play as they arrive (MediaSource), else once the turn ends.

   Auth: Supabase Auth email sign-in on the ERP project (one-time code, or the magic
   link in the same email). The backend verifies the token and resolves the role
   from HR — this file never decides who may see what.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var STATE_LABEL = {
    IDLE: 'Tap the globe · JARVIS listens', LISTENING: 'LISTENING… tap to send', TRANSCRIBING: 'HEARING YOU…',
    THINKING: 'THINKING…', CHECKING_ERP: 'CHECKING ERP…', CHECKING_CRM: 'CHECKING CRM…', SPEAKING: 'SPEAKING', ERROR: 'JARVIS ERROR'
  };
  var STATE_GLOW = {          // r,g,b for the globe's drop-shadow per state
    LISTENING: '237,31,81', TRANSCRIBING: '240,88,37', THINKING: '77,159,255', CHECKING_ERP: '255,194,75',
    CHECKING_CRM: '255,194,75', SPEAKING: '47,224,140', ERROR: '255,77,94'
  };
  var cfg = null, sb = null, ui = null;
  var state = 'IDLE', busy = false, rec = null, abortCtl = null, player = null;
  var sessionId = (function () { try { var s = sessionStorage.getItem('jarvis_session'); if (!s) { s = 'deck-' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('jarvis_session', s); } return s; } catch (_) { return 'deck-' + Date.now(); } })();

  function closeSheet() { var f = (ui && ui.closeSheet) || window.closeSheet; if (typeof f === 'function') { try { f(); } catch (_) {} } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setState(s) {
    state = s;
    if (ui && ui.sub) ui.sub.textContent = STATE_LABEL[s] || s;
    var g = ui && ui.globe;
    if (g) {
      var c = STATE_GLOW[s];
      g.style.filter = c ? 'drop-shadow(0 0 ' + (s === 'SPEAKING' ? 46 : 30) + 'px rgba(' + c + ',.65))' : '';
      if (window._g && _g.controls) _g.controls().autoRotateSpeed = s === 'IDLE' ? .55 : (s === 'CHECKING_ERP' || s === 'CHECKING_CRM' ? 4 : 1.6);
    }
    if (typeof ui?.onState === 'function') { try { ui.onState(s); } catch (_) {} }
  }
  function say(text, ms) {
    if (!ui || !ui.sub) return;
    ui.sub.textContent = text;
    clearTimeout(ui.sub._jh);
    ui.sub._jh = setTimeout(function () { if (state === 'IDLE') ui.sub.textContent = STATE_LABEL.IDLE; }, ms || 9000);
  }

  // ── auth (Supabase Auth on the ERP project) ──────────────────────────────────
  function client() {
    if (!sb) sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { storageKey: 'jarvis-erp-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    return sb;
  }
  async function token() {
    var r = await client().auth.getSession();
    return r && r.data && r.data.session ? r.data.session.access_token : null;
  }
  function signInSheet() {
    return new Promise(function (resolve) {
      if (typeof ui.sheet !== 'function') { resolve(false); return; }
      ui.sheet('JARVIS', 'Sign in to Jarvis', 'Use your work email — the one linked to your ERP employee record.',
        '<div style="display:flex;flex-direction:column;gap:10px;margin-top:6px">' +
        '<input class="l-inp" id="jv-email" type="email" autocomplete="email" placeholder="you@company.com" style="margin:0" value="' + esc(ui.email || '') + '">' +
        '<button class="l-btn" id="jv-send" type="button">Email me a sign-in code</button>' +
        '<div id="jv-step2" style="display:none;flex-direction:column;gap:10px">' +
        '<input class="l-inp" id="jv-code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code from the email" style="margin:0">' +
        '<button class="l-btn" id="jv-verify" type="button">Verify &amp; start Jarvis</button></div>' +
        '<div class="l-msg" id="jv-msg"></div><div class="eb" style="margin-top:4px">You can also just tap the link in that email on this device.</div></div>');
      var $ = function (id) { return document.getElementById(id); };
      var msg = function (t, err) { var m = $('jv-msg'); if (m) { m.className = 'l-msg' + (err ? ' err' : ''); m.textContent = t; } };
      $('jv-send').onclick = async function () {
        var email = ($('jv-email').value || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg('Enter your work email.', true); return; }
        this.disabled = true; msg('Sending…');
        var r = await client().auth.signInWithOtp({ email: email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
        this.disabled = false;
        if (r.error) { msg(r.error.message || 'Could not send the email.', true); return; }
        $('jv-step2').style.display = 'flex'; msg('Check your inbox for the code (or link).');
        $('jv-code').focus();
      };
      $('jv-verify').onclick = async function () {
        var email = ($('jv-email').value || '').trim().toLowerCase(), code = ($('jv-code').value || '').replace(/\D/g, '');
        if (code.length < 6) { msg('Enter the code from the email.', true); return; }
        this.disabled = true; msg('Verifying…');
        var r = await client().auth.verifyOtp({ email: email, token: code, type: 'email' });
        this.disabled = false;
        if (r.error) { msg('That code did not work — request a new one.', true); return; }
        closeSheet();
        resolve(true);
      };
      var poll = setInterval(async function () { if (await token()) { clearInterval(poll); closeSheet(); resolve(true); } }, 1500);
      setTimeout(function () { clearInterval(poll); }, 15 * 60000);
    });
  }

  // ── microphone → 16 kHz PCM16 with a simple end-of-speech detector ─────────────
  async function startCapture() {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var src = ctx.createMediaStreamSource(stream);
    var an = ctx.createAnalyser(); an.fftSize = 256; src.connect(an);
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    var chunks = [], ratio = ctx.sampleRate / 16000, heard = false, silentMs = 0, started = Date.now();
    var buf = new Uint8Array(an.frequencyBinCount);
    var r = { stream: stream, ctx: ctx, an: an, chunks: chunks, stopped: false, onAutoStop: null };
    proc.onaudioprocess = function (e) {
      if (r.stopped) return;
      var input = e.inputBuffer.getChannelData(0);
      var outLen = Math.floor(input.length / ratio), out = new Int16Array(outLen), energy = 0;
      for (var i = 0; i < outLen; i++) {
        var s = input[Math.floor(i * ratio)]; energy += s * s;
        out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      }
      chunks.push(out);
      var rms = Math.sqrt(energy / Math.max(1, outLen)), ms = input.length / ctx.sampleRate * 1000;
      if (rms > 0.02) { heard = true; silentMs = 0; } else if (heard) silentMs += ms;
      if ((heard && silentMs > 1200) || Date.now() - started > 30000) { if (r.onAutoStop) r.onAutoStop(); }
    };
    src.connect(proc); proc.connect(ctx.destination);
    r.proc = proc;
    // existing globe "voice" animation
    (function loop() {
      if (r.stopped) return;
      an.getByteFrequencyData(buf);
      var v = buf.reduce(function (a, b) { return a + b; }, 0) / buf.length / 255;
      if (ui.globe && ui.scale) ui.globe.style.transform = ui.scale(1 + v * .18);
      r.raf = requestAnimationFrame(loop);
    })();
    r.heard = function () { return heard; };
    return r;
  }
  function stopCapture(r) {
    if (!r || r.stopped) return null;
    r.stopped = true; cancelAnimationFrame(r.raf);
    try { r.proc.disconnect(); } catch (_) {}
    try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
    try { r.ctx.close(); } catch (_) {}
    if (ui.globe && ui.scale) ui.globe.style.transform = ui.scale(1);
    var n = r.chunks.reduce(function (a, c) { return a + c.length; }, 0), pcm = new Int16Array(n), o = 0;
    r.chunks.forEach(function (c) { pcm.set(c, o); o += c.length; });
    return pcm;
  }

  // ── streamed MP3 playback ─────────────────────────────────────────────────────
  function makePlayer() {
    var MS = window.ManagedMediaSource || window.MediaSource;
    var audio = new Audio(), queue = [], all = [], sb2 = null, ended = false, usingMS = !!(MS && MS.isTypeSupported && MS.isTypeSupported('audio/mpeg'));
    audio.disableRemotePlayback = true;
    var p = { audio: audio, done: false };
    if (usingMS) {
      var ms = new MS(); audio.src = URL.createObjectURL(ms);
      ms.addEventListener('sourceopen', function () {
        sb2 = ms.addSourceBuffer('audio/mpeg'); sb2.mode = 'sequence';
        sb2.addEventListener('updateend', pump); pump();
      });
      var pump = function () {
        if (!sb2 || sb2.updating) return;
        if (queue.length) { try { sb2.appendBuffer(queue.shift()); } catch (_) {} }
        else if (ended && ms.readyState === 'open') { try { ms.endOfStream(); } catch (_) {} }
      };
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
    var tk = await token();
    if (!tk) { setState('IDLE'); say('Sign in to use Jarvis'); return; }
    busy = true; abortCtl = new AbortController();
    setState('TRANSCRIBING');
    var answer = '', ttsFailed = false, gotAudio = false, transcript = '';
    player = makePlayer();
    try {
      var res = await fetch(cfg.fn + '?session=' + encodeURIComponent(sessionId) + '&rate=16000', {
        method: 'POST', signal: abortCtl.signal,
        headers: { 'Authorization': 'Bearer ' + tk, 'apikey': cfg.key, 'Content-Type': 'application/octet-stream' },
        body: pcm.buffer
      });
      if (!res.ok) {
        var j = {}; try { j = await res.json(); } catch (_) {}
        if (res.status === 401) { try { await client().auth.signOut(); } catch (_) {} }
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
      // Text fallback in the existing sheet when there was no voice (or the answer is long).
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

  window.JarvisVoice = {
    /** opts: { url, key, fn, sub, globe, scale(fn), sheet(fn), onState?, onTranscript? } */
    init: function (opts) {
      cfg = { url: opts.url, key: opts.key, fn: opts.fn || (opts.url + '/functions/v1/jarvis') };
      ui = opts; client();
    },
    get state() { return state; },
    /** Globe tap. */
    toggle: async function () {
      if (!cfg) return false;
      if (busy) { if (abortCtl) abortCtl.abort(); if (player) player.stop(); setState('IDLE'); return true; }
      if (state === 'SPEAKING') { if (player) player.stop(); setState('IDLE'); return true; }
      if (rec) { await finishListening(); return true; }
      if (!(await token())) { const ok = await signInSheet(); if (!ok) return true; }
      try { rec = await startCapture(); } catch (e) { say('Mic blocked — allow it in the browser bar'); return true; }
      rec.onAutoStop = function () { finishListening(); };
      setState('LISTENING');
      return true;
    },
    signOut: function () { return client().auth.signOut(); }
  };
})();
