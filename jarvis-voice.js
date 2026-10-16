/* ════════════════════════════════════════════════════════════════════════════
   JARVIS voice client — realtime, full-duplex conversation with the ERP assistant.
   No separate login: uses the ERP session of whoever is signed in (BESession token).

   Pipeline (2026-10-16 upgrade):
     mic (kept open for the whole conversation, echo-cancelled)
       → AudioWorklet: 16 kHz PCM16, 20 ms frames
       → client VAD (adaptive noise floor): speech start / end-of-utterance in ~0.5 s
       → WebSocket to the `jarvis` edge function: frames stream WHILE the user talks
         (server runs live STT, then the LLM streams, tools run in parallel, TTS speaks
          phrase by phrase)
       → streamed MP3 playback starts with the first phrase
     Barge-in: speaking over Jarvis stops the audio at once, tells the server to abort the
     old answer, and the new question streams immediately (with 300 ms of pre-roll so the
     first word is kept). Stale audio/text from an interrupted turn is ignored by turn id.
     After an answer Jarvis keeps listening for a follow-up; the conversation ends after
     ~12 s of silence or a tap.

   States (deterministic): IDLE · LISTENING · USER_SPEAKING · TRANSCRIBING · THINKING ·
   CHECKING_ERP · SPEAKING · INTERRUPTED · ERROR   (+ WAKE_DETECTED from jarvis-wake.js)

   Fallback: if the realtime socket can't open, one turn is recorded and POSTed (old path).
   Dev telemetry: localStorage.jarvis_debug = '1' (or ?jarvis_debug) → per-stage timings.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.JarvisVoice) return;
  var EXPIRED = 'Your session has expired. Please sign in again to continue using Jarvis.';
  var STATE_LABEL = {
    IDLE: 'Tap the globe · JARVIS listens', WAKE_DETECTED: 'Yes?', LISTENING: 'Listening…', USER_SPEAKING: 'Listening…',
    TRANSCRIBING: 'Understanding…', THINKING: 'Thinking…', CHECKING_ERP: 'Checking the ERP…', CHECKING_CRM: 'Checking the CRM…',
    SPEAKING: 'Speaking · talk to interrupt', INTERRUPTED: 'Go ahead…', ERROR: 'JARVIS ERROR'
  };
  var STATE_GLOW = {
    WAKE_DETECTED: '255,255,255', LISTENING: '237,31,81', USER_SPEAKING: '255,90,120', TRANSCRIBING: '240,88,37', THINKING: '77,159,255',
    CHECKING_ERP: '255,194,75', CHECKING_CRM: '255,194,75', SPEAKING: '47,224,140', INTERRUPTED: '255,90,120', ERROR: '255,77,94'
  };
  // VAD / conversation tuning
  var FRAME_MS = 20, PREROLL_MS = 320, START_MS = 80, END_SILENCE_MS = 560, MIN_SPEECH_MS = 260,
      BARGE_MS = 200, FOLLOWUP_IDLE_MS = 12000, NO_SPEECH_MS = 9000, MAX_UTTER_MS = 30000;
  var DEBUG = (function () { try { return localStorage.getItem('jarvis_debug') === '1' || /[?&]jarvis_debug\b/.test(location.search); } catch (_) { return false; } })();

  var cfg = null, ui = null, stateFns = [];
  var state = 'IDLE';
  var sessionId = (function () { try { var s = sessionStorage.getItem('jarvis_session'); if (!s) { s = 'erp-' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('jarvis_session', s); } return s; } catch (_) { return 'erp-' + Date.now(); } })();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function now() { return performance.now(); }
  function setState(s) {
    if (state === s) return;
    state = s;
    if (ui.sub && !ui._holdSub) ui.sub.textContent = ui.idleLabel && s === 'IDLE' ? ui.idleLabel : (STATE_LABEL[s] || s);
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
    if (ms) ui.sub._jh = setTimeout(function () { if (state === 'IDLE') ui.sub.textContent = ui.idleLabel || STATE_LABEL.IDLE; }, ms);
  }

  // ── ERP session (no Jarvis login) ─────────────────────────────────────────────
  function token() { return window.BESession ? BESession.token() : null; }
  function signInAgain() {
    try { if (window.BESession) BESession.clear(BESession.currentEmail()); } catch (_) {}
    try { ['be_active_email', 'be_active_user', 'be_active_role', 'be_media_academic_session'].forEach(function (k) { localStorage.removeItem(k); }); } catch (_) {}
    location.href = 'app.html';
  }
  function sessionExpired() {
    endConversation(); say(EXPIRED, 12000);
    if (typeof ui.sheet === 'function') {
      ui.sheet('JARVIS', 'Session expired', '', '<div style="font-size:14px;line-height:1.7;margin-bottom:14px">' + EXPIRED + '</div><button type="button" class="l-btn" id="jv-relogin">Sign in again</button>');
      var b = document.getElementById('jv-relogin'); if (b) b.onclick = signInAgain;
    }
  }

  // ── telemetry ─────────────────────────────────────────────────────────────────
  var T = {};
  function tmark(k, v) { T[k] = Math.round(v != null ? v : now() - (T._t0 || now())); }
  function tflush(turn) {
    if (!DEBUG) return;
    try { console.groupCollapsed('%cJarvis turn ' + turn + ' latency', 'color:#2fe08c'); console.table(Object.assign({}, T, { _t0: undefined })); console.groupEnd(); } catch (_) {}
    if (ui.sub) { var keys = ['mic_ready', 'ws_ready', 'stt_final', 'llm_first_token', 'erp_tools', 'tts_first_audio', 'first_audio_played'];
      var dbg = keys.filter(function (k) { return T[k] != null; }).map(function (k) { return k.replace(/_/g, ' ') + ' ' + T[k] + 'ms'; }).join(' · ');
      if (dbg) console.log('[jarvis] ' + dbg); }
  }

  // ── streamed MP3 playback (one player per turn; stop() is instant) ─────────────
  function makePlayer() {
    var MS = window.ManagedMediaSource || window.MediaSource;
    var audio = new Audio(), queue = [], all = [], sbuf = null, ended = false, stopped = false, url = '';
    var usingMS = !!(MS && MS.isTypeSupported && MS.isTypeSupported('audio/mpeg'));
    audio.disableRemotePlayback = true;
    var p = { audio: audio, started: false, playing: false };
    audio.addEventListener('playing', function () { p.playing = true; if (!p.started) { p.started = true; if (p.onStart) p.onStart(); } });
    audio.addEventListener('ended', function () { p.playing = false; if (p.onEnd) p.onEnd(); });
    audio.addEventListener('pause', function () { p.playing = false; });
    if (usingMS) {
      var ms = new MS(); url = URL.createObjectURL(ms); audio.src = url;
      var pump = function () {
        if (stopped || !sbuf || sbuf.updating) return;
        if (queue.length) { try { sbuf.appendBuffer(queue.shift()); } catch (_) {} }
        else if (ended && ms.readyState === 'open') { try { ms.endOfStream(); } catch (_) {} }
      };
      ms.addEventListener('sourceopen', function () { try { sbuf = ms.addSourceBuffer('audio/mpeg'); sbuf.mode = 'sequence'; sbuf.addEventListener('updateend', pump); pump(); } catch (_) {} });
      p.push = function (u8) { if (stopped) return; queue.push(u8); pump(); if (audio.paused) audio.play().catch(function () {}); };
      p.end = function () { ended = true; pump(); if (!p.started && !queue.length && p.onEnd) setTimeout(function () { if (!p.started) p.onEnd(); }, 50); };
    } else {
      p.push = function (u8) { if (!stopped) all.push(u8); };
      p.end = function () { if (stopped) return; if (!all.length) { if (p.onEnd) p.onEnd(); return; } url = URL.createObjectURL(new Blob(all, { type: 'audio/mpeg' })); audio.src = url; audio.play().catch(function () { if (p.onEnd) p.onEnd(); }); };
    }
    p.stop = function () { stopped = true; queue = []; try { audio.pause(); } catch (_) {} try { audio.removeAttribute('src'); audio.load(); } catch (_) {} if (url) try { URL.revokeObjectURL(url); } catch (_) {} };
    return p;
  }
  function b64ToU8(b64) { var s = atob(b64), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

  // ── microphone: AudioWorklet → 16 kHz PCM16 20 ms frames (ScriptProcessor fallback) ──
  var WORKLET = "class P extends AudioWorkletProcessor{constructor(){super();this.r=sampleRate/16000;this.b=[];this.n=320}" +
    "process(i){const c=i[0]&&i[0][0];if(!c)return true;for(let k=0;k<c.length;k+=this.r){this.b.push(c[Math.floor(k)])}" +
    "while(this.b.length>=this.n){const f=this.b.splice(0,this.n),o=new Int16Array(this.n);for(let j=0;j<this.n;j++){const v=Math.max(-1,Math.min(1,f[j]));o[j]=v<0?v*32768:v*32767}this.port.postMessage(o,[o.buffer])}return true}}" +
    "registerProcessor('jv-pcm',P)";
  var mic = null;   // { stream, ctx, node, src }
  async function openMic(onFrame) {
    var t0 = now();
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    var Ctx = window.AudioContext || window.webkitAudioContext, ctx = new Ctx();
    var src = ctx.createMediaStreamSource(stream), node;
    try {
      var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'jv-pcm');
      node.port.onmessage = function (e) { onFrame(e.data); };
      src.connect(node);
    } catch (_) {
      node = ctx.createScriptProcessor(1024, 1, 1);
      var ratio = ctx.sampleRate / 16000, carry = [];
      node.onaudioprocess = function (e) {
        var input = e.inputBuffer.getChannelData(0);
        for (var k = 0; k < input.length; k += ratio) carry.push(input[Math.floor(k)]);
        while (carry.length >= 320) { var f = carry.splice(0, 320), o = new Int16Array(320); for (var j = 0; j < 320; j++) { var v = Math.max(-1, Math.min(1, f[j])); o[j] = v < 0 ? v * 32768 : v * 32767; } onFrame(o); }
      };
      src.connect(node); node.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') try { await ctx.resume(); } catch (_) {}
    mic = { stream: stream, ctx: ctx, node: node, src: src };
    tmark('mic_ready', now() - t0);
    return mic;
  }
  function closeMic() {
    if (!mic) return;
    try { mic.src.disconnect(); } catch (_) {}
    try { mic.node.disconnect(); } catch (_) {}
    try { mic.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
    try { mic.ctx.close(); } catch (_) {}
    mic = null;
  }

  // ── realtime socket ─────────────────────────────────────────────────────────────
  var ws = null, wsReady = null, wsOk = false, pingT = 0;
  function wsUrl() { return cfg.fn.replace(/^http/, 'ws'); }
  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1) && wsReady) return wsReady;
    var t0 = now();
    wsReady = new Promise(function (resolve, reject) {
      var s;
      try { s = new WebSocket(wsUrl() + '?apikey=' + encodeURIComponent(cfg.key)); } catch (e) { reject(e); return; }
      s.binaryType = 'arraybuffer';
      var to = setTimeout(function () { reject(new Error('timeout')); try { s.close(); } catch (_) {} }, 6000);
      wsOk = false;
      s.onopen = function () { s.send(JSON.stringify({ type: 'hello', token: token(), session: sessionId, rate: 16000 })); };
      s.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.type === 'ready') { clearTimeout(to); wsOk = true; conv.turn = m.turn || 0; conv.floor = 0; tmark('ws_ready', now() - t0); flushOutbox(s); resolve(s); return; }
        if (m.type === 'error' && /SESSION|AUTH|FORBIDDEN/.test(m.code || '') && !wsOk) { clearTimeout(to); reject(Object.assign(new Error(m.message), { code: m.code })); return; }
        onServer(m);
      };
      s.onclose = function (e) {
        clearTimeout(to); clearInterval(pingT);
        if (ws === s) { ws = null; wsReady = null; }
        if (e.code === 4401) { sessionExpired(); }
        else if (conv.active && (state === 'TRANSCRIBING' || state === 'THINKING' || state === 'CHECKING_ERP')) { setState('ERROR'); say('Connection lost — tap to try again.', 6000); setTimeout(function () { if (state === 'ERROR') endConversation(); }, 1500); }
        reject(new Error('closed'));
      };
      s.onerror = function () {};
      ws = s;
    });
    wsReady.then(function (s) { clearInterval(pingT); pingT = setInterval(function () { try { s.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (_) {} }, 20000); }, function () {});
    return wsReady;
  }
  // Anything sent before the socket says "ready" (the user may start talking during the
  // ~0.3–1 s connect) is queued in order and flushed on ready — no word is lost.
  var outbox = [];
  function wsSend(o) {
    var m = typeof o === 'string' || o instanceof ArrayBuffer ? o : JSON.stringify(o);
    if (ws && ws.readyState === 1 && wsOk) { try { ws.send(m); } catch (_) {} }
    else if (conv.active && outbox.length < 2000) outbox.push(m);
  }
  function flushOutbox(s) { var q = outbox; outbox = []; q.forEach(function (m) { try { s.send(m); } catch (_) {} }); }

  // ── conversation state ─────────────────────────────────────────────────────────
  var conv = { active: false, turn: 0, floor: 0, player: null, answer: '', transcript: '', idleT: 0, external: false };
  var onFrameHook = null;   // legacy single-turn recorder takes the frames when set
  var vad = { floor: 0.006, speaking: false, voiced: 0, silent: 0, speechMs: 0, utterStart: 0, ring: [], startedAt: 0, lastSpeech: 0, serverEnd: false, level: 0 };

  function rms(f) { var e = 0; for (var i = 0; i < f.length; i++) { var v = f[i] / 32768; e += v * v; } return Math.sqrt(e / f.length); }
  function onFrame(f) {
    if (onFrameHook) return onFrameHook(f);
    if (!conv.active) return;
    var r = rms(f);
    vad.level = Math.min(1, r * 6);
    // pre-roll ring (always), so the first syllable before detection is kept
    vad.ring.push(f); if (vad.ring.length > PREROLL_MS / FRAME_MS) vad.ring.shift();
    var speaking = state === 'SPEAKING' && conv.player && conv.player.playing;
    // adaptive noise floor (only learnt while nobody — user or Jarvis — is talking)
    if (!vad.speaking && !speaking) vad.floor = vad.floor * 0.97 + Math.min(r, 0.05) * 0.03;
    var thr = Math.max(0.012, vad.floor * 3), bargeThr = Math.max(0.035, vad.floor * 6);
    if (!vad.speaking) {
      var hot = r > (speaking ? bargeThr : thr);
      vad.voiced = hot ? vad.voiced + FRAME_MS : 0;
      if (vad.voiced >= (speaking ? BARGE_MS : START_MS)) speechStart(speaking);
      else if (!speaking && state === 'LISTENING' && vad.startedAt && now() - vad.startedAt > (conv.turn ? FOLLOWUP_IDLE_MS : NO_SPEECH_MS)) { endConversation(); say(conv.turn ? 'Tap the globe to ask again' : 'I didn\'t catch anything — tap and speak.', 4000); }
      return;
    }
    // inside an utterance: stream the frame
    wsSend(f.buffer.slice(0));
    if (r > thr * 0.8) { vad.silent = 0; vad.speechMs += FRAME_MS; vad.lastSpeech = now(); }
    else vad.silent += FRAME_MS;
    var endAfter = vad.serverEnd ? 260 : END_SILENCE_MS;
    if (vad.silent >= endAfter || now() - vad.utterStart > MAX_UTTER_MS) speechEnd();
  }
  function speechStart(barge) {
    vad.speaking = true; vad.silent = 0; vad.speechMs = vad.voiced; vad.utterStart = now(); vad.serverEnd = false; vad.voiced = 0;
    T = { _t0: now() };
    conv.floor = conv.turn + 1;     // the server opens a new turn on speech_start
    if (barge || (conv.player && conv.player.playing)) {
      // BARGE-IN: silence Jarvis immediately; the server aborts the old LLM/TTS on speech_start.
      if (conv.player) { conv.player.stop(); conv.player = null; }
      setState('INTERRUPTED');
    }
    wsSend({ type: 'speech_start' });
    vad.ring.forEach(function (fr) { wsSend(fr.buffer.slice(0)); });
    vad.ring = [];
    setState('USER_SPEAKING');
    ui._holdSub = false; say('…');
  }
  function speechEnd() {
    vad.speaking = false; vad.voiced = 0;
    if (vad.speechMs < MIN_SPEECH_MS) { wsSend({ type: 'cancel' }); setState('LISTENING'); vad.startedAt = now(); return; }
    T.vad_end = Math.round(now() - vad.lastSpeech);
    T._t0 = now();   // latency is measured from the end of the user's speech
    wsSend({ type: 'speech_end', vad_ms: T.vad_end });
    setState('TRANSCRIBING');
  }

  function onServer(m) {
    if (m.type === 'pong') return;
    // Turn ids: anything from an interrupted/older turn is dropped (conv.floor is raised the
    // instant the user barges in, before the server's new turn id even arrives).
    if (m.turn != null && (m.turn < conv.floor || m.turn < conv.turn)) return;
    if (m.turn != null && m.turn > conv.turn) { conv.turn = m.turn; conv.answer = ''; conv.transcript = ''; newPlayer(); }
    switch (m.type) {
      case 'state':
        if (m.state === 'IDLE') { if (!m.interrupted && !(conv.player && (conv.player.playing || !conv.player.done))) toListening(); }
        else if (m.state === 'LISTENING') { if (!vad.speaking && state !== 'USER_SPEAKING') setState('LISTENING'); }
        else if (m.state === 'SPEAKING') { /* set when audio actually starts */ }
        else if (!vad.speaking) setState(m.state);
        break;
      case 'stt.speech_end': vad.serverEnd = true; break;
      case 'transcript.partial': if (vad.speaking || state === 'TRANSCRIBING') say('“' + m.text + '”'); if (!T.first_partial) T.first_partial = Math.round(now() - vad.utterStart); break;
      case 'transcript.final': conv.transcript = m.text; say('“' + m.text + '”'); if (ui.onTranscript) try { ui.onTranscript(m.text); } catch (_) {} break;
      case 'status': if (!vad.speaking) { ui._holdSub = true; say(m.text); } break;
      case 'assistant.delta': conv.answer += m.text; if (!vad.speaking) { ui._holdSub = true; say(conv.answer.slice(-220)); } break;
      case 'assistant.text': conv.answer = m.text; if (!vad.speaking) { ui._holdSub = true; say(m.text.length > 220 ? m.text.slice(0, 217) + '…' : m.text); } break;
      case 'audio.chunk': if (conv.player) conv.player.push(b64ToU8(m.audio)); break;
      case 'timing': T[m.stage] = m.ms; break;
      case 'error':
        if (m.code === 'TTS_UNAVAILABLE') { showSheet(true); break; }
        if (m.code === 'STT_EMPTY') { say('I didn\'t catch that — go ahead.', 3000); toListening(); break; }
        ui._holdSub = false; setState('ERROR'); say(m.message || 'Jarvis is unavailable right now.', 6000);
        setTimeout(function () { if (state === 'ERROR') toListening(); }, 1800);
        break;
      case 'done':
        if (conv.player) { conv.player.done = true; conv.player.end(); }
        if (m.timings) Object.keys(m.timings).forEach(function (k) { if (T[k] == null) T[k] = m.timings[k]; });
        if (!m.tts) { tflush(conv.turn); showSheet(false); toListening(); }
        else if (conv.answer.length > 260) showSheet(false);
        break;
    }
  }
  function newPlayer() {
    if (conv.player) conv.player.stop();
    var p = makePlayer();
    p.onStart = function () { if (p !== conv.player) return; tmark('first_audio_played'); setState('SPEAKING'); };
    p.onEnd = function () { if (p !== conv.player) return; tflush(conv.turn); conv.player = null; toListening(); };
    conv.player = p;
  }
  function toListening() {
    if (!conv.active) { setState('IDLE'); return; }
    ui._holdSub = false;
    vad.startedAt = now(); vad.voiced = 0;
    setState('LISTENING');
    if (conv.answer) say(conv.answer.length > 220 ? conv.answer.slice(0, 217) + '…' : conv.answer);
  }
  function showSheet(ttsFailed) {
    if (!conv.answer || typeof ui.sheet !== 'function') return;
    if (!ttsFailed && conv.answer.length <= 260) return;
    ui.sheet('JARVIS', conv.transcript ? '“' + conv.transcript + '”' : 'Jarvis', ttsFailed ? 'Voice unavailable — text answer' : 'Live ERP answer', '<div style="font-size:14px;line-height:1.7;white-space:pre-wrap">' + esc(conv.answer) + '</div>');
  }

  async function startConversation(opts) {
    opts = opts || {};
    if (!token()) { sessionExpired(); return; }
    conv.active = true; conv.external = !!opts.external; conv.answer = ''; conv.transcript = '';
    vad.speaking = false; vad.voiced = 0; vad.ring = []; vad.startedAt = now();
    T = { _t0: now() };
    setState(opts.fromWake ? 'WAKE_DETECTED' : 'LISTENING');
    if (opts.fromWake) say('Yes? I\'m listening…', 4000);
    // Mic and socket open IN PARALLEL; frames before the socket is ready stay in the pre-roll ring.
    var micP = conv.external ? Promise.resolve() : openMic(onFrame);
    var wsP = connect();
    try { await micP; } catch (e) { conv.active = false; setState('IDLE'); say('Mic blocked — allow it in the browser bar', 6000); return; }
    try { await wsP; } catch (e) {
      if (e && /SESSION/.test(e.code || '')) { sessionExpired(); return; }
      legacyTurn(); return;                                          // old POST path, one turn
    }
    if (opts.preroll) opts.preroll.forEach(function (f) { onFrame(f); });
    if (opts.fromWake) setTimeout(function () { if (state === 'WAKE_DETECTED') setState('LISTENING'); }, 450);
    (function loop() {   // globe/orb level meter
      if (!conv.active) { if (ui.globe && ui.scale) ui.globe.style.transform = ui.scale(1); return; }
      if (ui.globe && ui.scale) ui.globe.style.transform = ui.scale(1 + vad.level * .18);
      requestAnimationFrame(loop);
    })();
  }
  function endConversation() {
    if (vad.speaking) wsSend({ type: 'cancel' });
    if (state !== 'IDLE' && state !== 'LISTENING') wsSend({ type: 'interrupt' });
    conv.active = false; vad.speaking = false; outbox = [];
    if (conv.player) { conv.player.stop(); conv.player = null; }
    if (!conv.external) closeMic();
    conv.external = false;
    ui._holdSub = false;
    setState('IDLE');
  }

  // ── legacy single-turn fallback (record → POST → SSE) when the socket is unavailable ──
  var legacy = null;
  function legacyTurn() {
    setState('LISTENING'); say('Listening…');
    legacy = { chunks: [], heard: false, silent: 0, t: now() };
    var prev = onFrameHook; onFrameHook = function (f) {
      var r = rms(f); legacy.chunks.push(f);
      if (r > 0.02) { legacy.heard = true; legacy.silent = 0; } else if (legacy.heard) legacy.silent += FRAME_MS;
      if ((legacy.heard && legacy.silent > 700) || now() - legacy.t > 20000) { onFrameHook = prev; postTurn(); }
    };
  }
  async function postTurn() {
    var L = legacy; legacy = null;
    var n = L.chunks.reduce(function (a, c) { return a + c.length; }, 0), pcm = new Int16Array(n), o = 0;
    L.chunks.forEach(function (c) { pcm.set(c, o); o += c.length; });
    if (!L.heard || n < 16000 * 0.4) { endConversation(); say('I didn\'t catch anything — tap and speak.', 4000); return; }
    setState('TRANSCRIBING');
    var player = makePlayer(), answer = '', got = false;
    try {
      var res = await fetch(cfg.fn + '?session=' + encodeURIComponent(sessionId) + '&rate=16000', { method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.key, 'apikey': cfg.key, 'x-erp-session': token(), 'Content-Type': 'application/octet-stream' }, body: pcm.buffer });
      if (!res.ok) { var j = {}; try { j = await res.json(); } catch (_) {} if (res.status === 401) { sessionExpired(); return; } setState('ERROR'); say(j.error || 'Jarvis is unavailable right now.', 5000); setTimeout(endConversation, 2500); return; }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      for (;;) {
        var step = await reader.read(); if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        var idx; while ((idx = buf.indexOf('\n\n')) >= 0) {
          var line = buf.slice(0, idx).split('\n').filter(function (l) { return l.indexOf('data:') === 0; }).map(function (l) { return l.slice(5).trim(); }).join(''); buf = buf.slice(idx + 2);
          if (!line) continue; var ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.type === 'state' && ev.state !== 'IDLE') setState(ev.state);
          else if (ev.type === 'transcript.final' || ev.type === 'transcript.partial') say('“' + ev.text + '”');
          else if (ev.type === 'assistant.delta') { answer += ev.text; say(answer.slice(-220)); }
          else if (ev.type === 'assistant.text') answer = ev.text;
          else if (ev.type === 'audio.chunk') { got = true; player.push(b64ToU8(ev.audio)); }
          else if (ev.type === 'error' && !answer) answer = ev.message;
        }
      }
      player.end(); if (answer) say(answer, 12000);
      if (got) { setState('SPEAKING'); await new Promise(function (r) { player.onEnd = r; setTimeout(r, 60000); }); }
    } catch (_) { setState('ERROR'); say('Jarvis could not be reached. Check your connection.', 5000); }
    endConversation(); if (answer) say(answer, 8000);
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
      '.jv-orb-cap{max-width:min(340px,70vw);padding:9px 13px;border-radius:12px;background:rgba(10,8,14,.94);border:1px solid rgba(255,255,255,.1);color:#f2f1ee;font:600 12px/1.45 Inter,system-ui,sans-serif;letter-spacing:.01em;box-shadow:0 10px 30px rgba(0,0,0,.5);opacity:0;transform:translateX(6px);transition:opacity .2s,transform .2s;pointer-events:none}',
      '.jv-orb.show-cap .jv-orb-cap,.jv-orb:hover .jv-orb-cap{opacity:1;transform:none}',
      '@media (max-width:820px){.jv-orb{bottom:calc(92px + env(safe-area-inset-bottom,0px));right:14px}.jv-orb-btn{width:50px;height:50px}}',
      '@media (max-width:560px){.jv-orb{bottom:calc(84px + env(safe-area-inset-bottom,0px));right:12px}.jv-orb-btn{width:44px;height:44px}.jv-orb-cap{max-width:calc(100vw - 90px)}}',
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

  function mountOrb() {
    css();
    var wrap = document.createElement('div'); wrap.className = 'jv-orb';
    wrap.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center"><button type="button" class="jv-orb-btn" aria-label="Ask Jarvis"></button><div data-jarvis-chip></div></div><div class="jv-orb-cap" aria-live="polite">Tap to ask Jarvis</div>';
    document.body.appendChild(wrap);
    return { wrap: wrap, btn: wrap.querySelector('.jv-orb-btn'), cap: wrap.querySelector('.jv-orb-cap') };
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
    /** Tap: start a conversation · while Jarvis talks: stop the answer and listen · otherwise end. */
    toggle: async function () {
      if (!cfg) return false;
      if (conv.active) {
        if (state === 'SPEAKING' || state === 'THINKING' || state === 'CHECKING_ERP' || state === 'CHECKING_CRM' || state === 'TRANSCRIBING') {
          wsSend({ type: 'interrupt' }); if (conv.player) { conv.player.stop(); conv.player = null; } conv.floor = conv.turn + 1; toListening(); return true;
        }
        endConversation(); return true;
      }
      if (!token()) { sessionExpired(); return true; }
      var W = window.JarvisWake;
      if (W && W.shouldOffer && W.shouldOffer()) { W.offer(function () { JarvisVoice.toggle(); }); return true; }
      if (W && W.active && W.active()) { startConversation({ external: true }); return true; }   // share the wake-word mic stream
      startConversation({});
      return true;
    },
    /** Wake word ("Hey Jarvis"): start a conversation fed by the wake service's stream. */
    startFromStream: function (preroll, fromWake) {
      if (!cfg || conv.active || state !== 'IDLE') return false;
      if (!token()) { sessionExpired(); return false; }
      startConversation({ external: true, fromWake: fromWake, preroll: preroll || [] });
      return true;
    },
    /** Frames (Int16Array @16 kHz) from the wake-word stream while a stream-fed conversation runs. */
    feed: function (frame) { if (conv.active && conv.external && frame) { for (var i = 0; i + 320 <= frame.length; i += 320) onFrame(frame.subarray(i, i + 320)); } },
    listening: function () { return conv.active; },
    /** Typed question into the same conversation. */
    ask: async function (text) { if (!cfg || !text) return; try { await connect(); } catch (_) { return; } if (conv.player) { conv.player.stop(); conv.player = null; } conv.floor = conv.turn + 1; wsSend({ type: 'text', text: String(text) }); setState('THINKING'); },
    /** Open the socket early (hover / page idle) so the first tap answers faster. */
    warm: function () { if (cfg && token() && !ws) connect().catch(function () {}); },
    sheet: function (sub, title, meta, html) { if (ui && ui.sheet) ui.sheet(sub, title, meta, html); },
    closeSheet: function () { if (ui && ui.closeSheet) ui.closeSheet(); },
    onStateChange: function (fn) { if (typeof fn === 'function') stateFns.push(fn); },
    get initialized() { return !!cfg; },
    /** Last turn's latency breakdown (dev telemetry). */
    get timings() { return Object.assign({}, T); },
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
      o.btn.addEventListener('pointerenter', function () { JarvisVoice.warm(); });
      o.btn.addEventListener('touchstart', function () { JarvisVoice.warm(); }, { passive: true });
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
      if (++tries < 120) setTimeout(tryMount, 1000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(tryMount, 600); });
    else setTimeout(tryMount, 600);
  }
})();
