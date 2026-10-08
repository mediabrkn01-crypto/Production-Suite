/* ════════════════════════════════════════════════════════════════════════════
   JarvisWakeWordService (window.JarvisWake) — "Hey Jarvis" voice activation.

   • Detection runs ON THIS DEVICE (Picovoice Porcupine, WebAssembly). Microphone audio is
     never uploaded while waiting for the wake word; nothing is recorded or stored. Only the
     question spoken after activation goes to Jarvis (the same pipeline as a globe tap).
   • One mic stream (Picovoice WebVoiceProcessor, 16 kHz frames) feeds both the detector and
     a ~0.5 s ring buffer, so "Hey Jarvis, who has classes today?" keeps its beginning.
   • Paused while Jarvis is busy (listening / thinking / checking ERP / speaking) so its own
     voice can't wake it; resumes at IDLE. Overlapping sessions are impossible.
   • Starts only for a signed-in ERP employee (settings come from the `jarvis` function,
     which verifies the ERP session). Preference per employee on this device.
   • Lifecycle: stops the mic when the tab is hidden, restarts when visible again if the
     preference is ON and microphone permission still exists. Also restores after reload.

   API: active() · start() · stop() · pause() · resume() · enable() · disable() ·
        shouldOffer() · offer(cb) · onWakeDetected(fn)
   Event: window 'jarvis.wake' (detail {type:'jarvis.wake', phrase:'hey-jarvis'})
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.JarvisWake) return;
  var CDN_WVP = 'https://cdn.jsdelivr.net/npm/@picovoice/web-voice-processor@4.0.10/dist/iife/index.min.js';
  var CDN_PORCUPINE = 'https://cdn.jsdelivr.net/npm/@picovoice/porcupine-web@4.0.1/dist/iife/index.min.js';
  var RING_FRAMES = 16;      // 16 × 512 samples ≈ 0.5 s at 16 kHz
  var PREROLL_FRAMES = 8;    // ≈ 0.25 s handed to the question recorder

  var S = { cfg: null, cfgP: null, porcupine: null, tap: null, running: false, detecting: false, starting: null,
            ring: [], fns: [], chip: null, status: 'off', error: null };
  var embedded = /[?&]embed=1\b/.test(location.search) || window.self !== window.top;

  function email() { return window.BESession && BESession.currentEmail ? BESession.currentEmail() : ''; }
  function prefKey() { return 'jarvis_wake_pref:' + email(); }
  function pref() { try { return localStorage.getItem(prefKey()); } catch (_) { return null; } }
  function setPref(v) { try { localStorage.setItem(prefKey(), v); } catch (_) {} }
  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebAssembly && window.AudioContext && window.Worker);
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[data-jw="' + src + '"]')) return res();
      var s = document.createElement('script'); s.src = src; s.async = true; s.dataset.jw = src;
      s.onload = function () { res(); }; s.onerror = function () { rej(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }
  async function micPermission() {
    try { var p = await navigator.permissions.query({ name: 'microphone' }); return p.state; } catch (_) { return 'unknown'; }
  }

  /** Wake settings for the signed-in employee (server verifies the ERP session). */
  function config() {
    if (S.cfgP) return S.cfgP;
    var tk = window.BESession && BESession.token();
    if (!tk || !window.BESession) return Promise.resolve(null);
    S.cfgP = fetch(BESession.url + '/functions/v1/jarvis?config=wake', {
      headers: { 'apikey': BESession.anonKey, 'Authorization': 'Bearer ' + BESession.anonKey, 'x-erp-session': tk }
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { S.cfg = j && j.wake; return S.cfg; })
      .catch(function () { S.cfgP = null; return null; });
    return S.cfgP;
  }

  // ── soft activation "ding" (≈220 ms, quiet) ──────────────────────────────────
  var dingCtx = null;
  function ding() {
    try {
      dingCtx = dingCtx || new (window.AudioContext || window.webkitAudioContext)();
      var t = dingCtx.currentTime, g = dingCtx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      g.connect(dingCtx.destination);
      [[880, 0], [1318.5, 0.07]].forEach(function (n) {
        var o = dingCtx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(n[0], t + n[1]);
        o.connect(g); o.start(t + n[1]); o.stop(t + 0.23);
      });
    } catch (_) {}
  }

  function onDetected() {
    var JV = window.JarvisVoice;
    if (!JV || JV.state !== 'IDLE' || (JV.listening && JV.listening())) return;   // never overlap a session
    ding();
    var ev = { type: 'jarvis.wake', phrase: 'hey-jarvis' };
    try { window.dispatchEvent(new CustomEvent('jarvis.wake', { detail: ev })); } catch (_) {}
    S.fns.forEach(function (f) { try { f(ev); } catch (_) {} });
    JV.startFromStream(S.ring.slice(-PREROLL_FRAMES), true);
  }

  async function start() {
    if (S.running || embedded || !supported()) return S.running;
    if (S.starting) return S.starting;
    S.starting = (async function () {
      var c = await config();
      if (!c || !c.enabled || !c.accessKey) { setStatus(c && !c.enabled ? 'unconfigured' : 'off'); return false; }
      try {
        await loadScript(CDN_WVP); await loadScript(CDN_PORCUPINE);
        var WVP = window.WebVoiceProcessor.WebVoiceProcessor, PW = window.PorcupineWeb;
        if (!S.porcupine) {
          var keyword = { builtin: PW.BuiltInKeyword.Jarvis, sensitivity: c.sensitivity };
          if (c.keywordUrl) {
            var ok = await fetch(c.keywordUrl, { method: 'HEAD' }).then(function (r) { return r.ok; }).catch(function () { return false; });
            if (ok) keyword = { publicPath: c.keywordUrl, label: 'hey-jarvis', sensitivity: c.sensitivity };
          }
          S.porcupine = await PW.PorcupineWorker.create(c.accessKey, keyword, onDetected,
            { publicPath: c.modelUrl, customWritePath: 'jarvis_porcupine_v4', version: 1 },
            { processErrorCallback: function (e) { S.error = String(e); } });
          S.keyword = keyword.label || 'jarvis';
        }
        if (!S.tap) S.tap = { onmessage: function (e) {
          if (!e.data || e.data.command !== 'process') return;
          var f = e.data.inputFrame;
          S.ring.push(f); if (S.ring.length > RING_FRAMES) S.ring.shift();
          if (window.JarvisVoice) JarvisVoice.feed(f);
        } };
        await WVP.subscribe(S.tap);
        S.running = true;
        resume();
        setStatus('on');
        return true;
      } catch (e) {
        S.error = e && e.message || String(e);
        console.warn('[jarvis-wake]', S.error);
        setStatus(/permission|denied|notallowed/i.test(S.error) ? 'blocked' : 'error');
        return false;
      } finally { S.starting = null; }
    })();
    return S.starting;
  }
  async function stop() {
    S.running = false; S.detecting = false; S.ring = [];
    try { var WVP = window.WebVoiceProcessor && WebVoiceProcessor.WebVoiceProcessor; if (WVP) await WVP.unsubscribe([S.tap, S.porcupine].filter(Boolean)); } catch (_) {}   // no engines left → microphone released
    setStatus(pref() === 'on' ? 'paused' : 'off');
  }
  function pause() {
    if (!S.detecting || !S.porcupine) return;
    S.detecting = false;
    try { WebVoiceProcessor.WebVoiceProcessor.unsubscribe(S.porcupine); } catch (_) {}
  }
  function resume() {
    if (!S.running || S.detecting || !S.porcupine) return;
    var JV = window.JarvisVoice;
    if (JV && JV.state !== 'IDLE') return;
    S.detecting = true;
    try { WebVoiceProcessor.WebVoiceProcessor.subscribe(S.porcupine); } catch (_) {}
  }

  // ── status chip (● Hey Jarvis on) ────────────────────────────────────────────
  var LABEL = { on: '● “Hey Jarvis” on', off: 'Hey Jarvis off', paused: '● “Hey Jarvis” paused', blocked: 'Mic blocked — tap to retry',
    error: 'Voice activation unavailable', unconfigured: '' };
  function setStatus(s) {
    S.status = s;
    var c = S.chip; if (!c) return;
    c.textContent = LABEL[s] || '';
    c.hidden = !LABEL[s];
    c.dataset.state = s;
    c.title = s === 'on' ? 'Wake word is detected on this device. Nothing is sent until you say “Hey Jarvis”. Tap to turn off.'
      : 'Tap to turn on voice activation (“Hey Jarvis”).';
  }
  function css() {
    if (document.getElementById('jw-css')) return;
    var st = document.createElement('style'); st.id = 'jw-css';
    st.textContent = '.jw-chip{display:inline-flex;align-items:center;gap:6px;margin-top:6px;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(10,8,14,.7);color:rgba(255,255,255,.6);font:600 10px Inter,system-ui,sans-serif;letter-spacing:.04em;cursor:pointer;white-space:nowrap}'
      + '.jw-chip[data-state="on"]{color:#2fe08c;border-color:rgba(47,224,140,.35)}.jw-chip[data-state="paused"]{color:#ffc24b;border-color:rgba(255,194,75,.35)}'
      + '.jw-chip[data-state="blocked"],.jw-chip[data-state="error"]{color:#ff8a8a;border-color:rgba(255,77,94,.35)}.jw-chip:focus-visible{outline:2px solid #fff;outline-offset:2px}'
      + '.jw-offer p{font-size:14px;line-height:1.7;margin:0 0 6px}.jw-offer small{display:block;font-size:12px;color:rgba(255,255,255,.55);margin:0 0 14px;line-height:1.6}'
      + '.jw-offer .jw-row{display:flex;flex-direction:column;gap:8px}.jw-offer .jw-later{background:none;border:none;color:rgba(255,255,255,.55);font:600 12px Inter,system-ui,sans-serif;cursor:pointer;padding:8px}';
    document.head.appendChild(st);
  }
  function mountChip(host) {
    if (!host || S.chip) return;
    css();
    var b = document.createElement('button'); b.type = 'button'; b.className = 'jw-chip';
    b.addEventListener('click', function (e) { e.stopPropagation(); if (S.status === 'on' || S.status === 'paused') JarvisWake.disable(); else JarvisWake.enable(); });
    b.addEventListener('pointerup', function (e) { e.stopPropagation(); }, true);
    host.appendChild(b); S.chip = b;
    setStatus(S.status);
  }

  // ── first-use offer ─────────────────────────────────────────────────────────
  function sheet(title, html) {
    var JV = window.JarvisVoice;
    if (JV && JV.sheet) return JV.sheet('JARVIS', title, '', html);
  }
  function closeSheet() { var JV = window.JarvisVoice; if (JV && JV.closeSheet) JV.closeSheet(); }

  window.JarvisWake = {
    active: function () { return S.running; },
    get status() { return S.status; },
    start: start, stop: stop, pause: pause, resume: resume,
    onWakeDetected: function (fn) { if (typeof fn === 'function') S.fns.push(fn); },
    enable: async function () { setPref('on'); var ok = await start(); if (!ok && S.status !== 'unconfigured') setPref('off'); return ok; },
    disable: async function () { setPref('off'); await stop(); setStatus('off'); },
    /** First time someone uses Jarvis on this device (and the feature is configured). */
    shouldOffer: function () { return !embedded && supported() && !pref() && !!(S.cfg && S.cfg.enabled); },
    offer: function (cont) {
      css();
      sheet('Enable voice activation',
        '<div class="jw-offer"><p>Allow microphone access so you can start Jarvis by saying <b>“Hey Jarvis”</b>.</p>'
        + '<small>The wake phrase is detected on this device. Nothing is recorded or sent until you say “Hey Jarvis” — then only your question goes to Jarvis. You can turn it off any time.</small>'
        + '<div class="jw-row"><button type="button" class="l-btn" id="jw-enable">Enable “Hey Jarvis”</button><button type="button" class="jw-later" id="jw-later">Not now — just use tap</button></div></div>');
      var en = document.getElementById('jw-enable'), later = document.getElementById('jw-later');
      if (en) en.onclick = async function () { en.disabled = true; en.textContent = 'Allow the microphone…'; await JarvisWake.enable(); closeSheet(); if (cont) cont(); };
      if (later) later.onclick = function () { setPref('off'); setStatus('off'); closeSheet(); if (cont) cont(); };
    },
    mountChip: mountChip,
    get _debug() { return { running: S.running, detecting: S.detecting, status: S.status, error: S.error, keyword: S.keyword, cfg: !!S.cfg }; }
  };

  // ── wiring with the one Jarvis voice engine ─────────────────────────────────
  function wire() {
    var JV = window.JarvisVoice;
    if (!JV || !JV.initialized || embedded) return false;
    if (!(window.BESession && BESession.token())) return false;     // ERP session required
    JV.onStateChange(function (s) { if (s === 'IDLE') resume(); else pause(); });
    var host = document.querySelector('[data-jarvis-chip]'); if (host) mountChip(host);
    config().then(async function (c) {
      if (!c || !c.enabled) { setStatus('unconfigured'); return; }
      setStatus(pref() === 'on' ? 'paused' : 'off');
      if (pref() === 'on' && (await micPermission()) !== 'denied') start();   // restore after reload
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { if (S.running) stop(); }
      else if (pref() === 'on' && !S.running) micPermission().then(function (p) { if (p !== 'denied') start(); });
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted && pref() === 'on' && !S.running) start(); });
    return true;
  }
  var tries = 0;
  (function waitForJarvis() {
    if (wire()) return;
    if (++tries < 120) setTimeout(waitForJarvis, 1000);
  })();
})();
