/**
 * BE Live — one shared Supabase Realtime connection for every portal.
 *
 * This is about DATA changes (leave, attendance, tasks, batches, payroll…). Deployed code
 * updates are handled separately by be-update.js.
 *
 *   BELive.on(key, specs, handler, opts)
 *     key      unique name; calling again with the same key replaces the old subscription
 *     specs    'table' | { table, filter?, event? } | an array of those
 *     handler  fn(events, info) — events: the postgres_changes payloads collected during the
 *              debounce window; info.resync === true when called because the connection came
 *              back (or the tab woke up) and events may have been missed: reload from the DB.
 *     opts     { debounce: ms (default 500) }
 *   BELive.off(key)
 *   BELive.state        'connecting' | 'connected' | 'reconnecting' | 'offline'
 *   BELive.onState(fn)
 *   BELive.resync()     ask every subscriber to reload now
 *   BELive.whenIdle(root, fn)  run fn now, or once the user stops editing inside root
 *
 * All subscriptions share ONE channel. It is rebuilt (debounced) when subscriptions change,
 * re-joined with backoff on errors, and every reconnect triggers a resync so nothing is lost.
 * Namespace: window.BELive
 */
(function () {
  'use strict';
  if (window.BELive) return;

  var pendingIdle = new WeakMap();
  var subs = {}, channel = null, client = null, rebuildT = null, retryT = null, retryN = 0;
  var state = 'connecting', everConnected = false, needResync = false, stateFns = [], hiddenAt = 0;

  function getClient() {
    if (client) return client;
    try { if (typeof dbInstance !== 'undefined' && dbInstance && dbInstance.channel) return (client = dbInstance); } catch (_) {}
    try { if (typeof sb !== 'undefined' && sb && sb.channel) return (client = sb); } catch (_) {}
    return null;
  }
  function norm(specs) {
    return (Array.isArray(specs) ? specs : [specs]).filter(Boolean).map(function (s) {
      return typeof s === 'string' ? { table: s, event: '*' } : { table: s.table, filter: s.filter || undefined, event: s.event || '*' };
    });
  }

  // ───────────────────────────── state + pill
  function setState(s) {
    if (s === state) return;
    state = s;
    stateFns.forEach(function (f) { try { f(s); } catch (_) {} });
    pill();
  }
  var pillEl = null, pillT = null;
  function pill() {
    clearTimeout(pillT);
    if (state === 'connected' || state === 'connecting') { if (pillEl) pillEl.classList.remove('on'); return; }
    // Short blips are normal (the socket re-joins in a second) — only show after 4 s.
    pillT = setTimeout(function () {
      if (state === 'connected' || state === 'connecting') return;
      if (!pillEl) {
        var st = document.createElement('style'); st.textContent =
          '.bel-pill{position:fixed;left:50%;bottom:18px;transform:translate(-50%,12px);z-index:2147482990;display:flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;background:#11162a;border:1px solid rgba(255,255,255,.12);color:#cbd5e1;font:600 12px Inter,system-ui,sans-serif;box-shadow:0 12px 30px -10px rgba(0,0,0,.7);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}' +
          '.bel-pill.on{opacity:1;transform:translate(-50%,0)}.bel-pill i{width:8px;height:8px;border-radius:50%;background:#fbbf24;animation:belP 1.2s ease-in-out infinite}' +
          '.bel-pill[data-s=offline] i{background:#f87171;animation:none}@keyframes belP{50%{opacity:.35}}' +
          '@media (max-width:640px){.bel-pill{bottom:calc(18px + 76px)}}@media (prefers-reduced-motion:reduce){.bel-pill i{animation:none}}';
        document.head.appendChild(st);
        pillEl = document.createElement('div'); pillEl.className = 'bel-pill'; pillEl.setAttribute('role', 'status'); pillEl.setAttribute('aria-live', 'polite');
        document.body.appendChild(pillEl);
      }
      pillEl.dataset.s = state;
      pillEl.innerHTML = '<i></i>' + (state === 'offline' ? 'Offline — showing the last loaded data' : 'Reconnecting… live updates paused');
      pillEl.classList.add('on');
    }, 4000);
  }

  // ───────────────────────────── dispatch
  function deliver(sub, payload) {
    if (payload) sub.queue.push(payload);
    clearTimeout(sub.timer);
    sub.timer = setTimeout(function () {
      var evs = sub.queue; sub.queue = [];
      var info = { resync: !!sub.resyncPending }; sub.resyncPending = false;
      try { var r = sub.handler(evs, info); if (r && r.catch) r.catch(function (e) { console.warn('[BELive] ' + sub.key + ':', e && e.message); }); }
      catch (e) { console.warn('[BELive] ' + sub.key + ':', e && e.message); }
    }, sub.debounce);
  }
  function resyncAll() {
    Object.keys(subs).forEach(function (k) { subs[k].resyncPending = true; deliver(subs[k]); });
  }

  // ───────────────────────────── channel lifecycle
  function teardown() {
    clearTimeout(retryT);
    var c = getClient(), old = channel;
    channel = null;                       // first, so the old channel's CLOSED callback is ignored
    if (old && c) { try { c.removeChannel(old); } catch (_) {} }
  }
  // planned = rebuilt only because subscriptions changed (not a dropped connection) — no resync.
  function build(planned) {
    clearTimeout(rebuildT);
    teardown();
    var c = getClient(), keys = Object.keys(subs);
    if (!c || !keys.length) return;
    if (!navigator.onLine) { setState('offline'); return; }
    var ch = c.channel('be-live-' + Math.random().toString(36).slice(2, 9));
    keys.forEach(function (k) {
      var sub = subs[k];
      sub.specs.forEach(function (sp) {
        var cfg = { event: sp.event, schema: 'public', table: sp.table };
        if (sp.filter) cfg.filter = sp.filter;
        ch.on('postgres_changes', cfg, function (p) { if (subs[k] === sub) deliver(sub, p); });
      });
    });
    channel = ch;
    if (!(planned && state === 'connected')) setState(everConnected ? 'reconnecting' : 'connecting');
    ch.subscribe(function (status) {
      if (channel !== ch) return;
      if (status === 'SUBSCRIBED') {
        retryN = 0;
        var wasDown = everConnected && state !== 'connected';
        everConnected = true; setState('connected');
        if (wasDown || needResync) { needResync = false; resyncAll(); }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (everConnected) needResync = true;
        setState(navigator.onLine ? 'reconnecting' : 'offline');
        // supabase-js re-joins by itself; if it hasn't within a while, rebuild from scratch.
        clearTimeout(retryT);
        retryT = setTimeout(function () { if (channel === ch && state !== 'connected') build(false); }, Math.min(30000, 3000 * Math.pow(2, retryN++)));
      }
    });
  }
  function scheduleBuild() { clearTimeout(rebuildT); rebuildT = setTimeout(function () { build(true); }, 250); }

  window.addEventListener('offline', function () { if (everConnected) needResync = true; setState('offline'); });
  window.addEventListener('online', function () { needResync = true; retryN = 0; build(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    // Phones/laptops throttle or drop sockets while asleep — after a long absence reload anyway.
    if (hiddenAt && Date.now() - hiddenAt > 120000) {
      if (state !== 'connected') { needResync = true; build(); } else resyncAll();
    }
    hiddenAt = 0;
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) { needResync = true; build(); } });

  window.BELive = {
    use: function (c) { if (c && c.channel && c !== client) { client = c; scheduleBuild(); } return this; },
    on: function (key, specs, handler, opts) {
      if (!key || typeof handler !== 'function') return;
      var old = subs[key]; if (old) clearTimeout(old.timer);
      subs[key] = { key: key, specs: norm(specs), handler: handler, debounce: (opts && opts.debounce) != null ? opts.debounce : 500, queue: [], timer: null };
      scheduleBuild();
    },
    off: function (key) { var s = subs[key]; if (!s) return; clearTimeout(s.timer); delete subs[key]; scheduleBuild(); },
    get state() { return state; },
    get keys() { return Object.keys(subs); },
    get _debug() { var c = getClient(); return { topic: channel && channel.topic, chState: channel && channel.state, clientChannels: c && c.getChannels ? c.getChannels().map(function (x) { return x.topic + ':' + x.state; }) : null, bindings: channel && channel.bindings && channel.bindings.postgres_changes ? channel.bindings.postgres_changes.length : null }; },
    onState: function (fn) { if (typeof fn === 'function') stateFns.push(fn); },
    resync: resyncAll,
    /** Run fn now unless the user is editing inside root; then wait until they stop.
     *  Never interrupts typing — repeated calls for the same root collapse into one. */
    whenIdle: function (root, fn) {
      var busy = root && window.BEUpdate && BEUpdate.isEditingIn(root);
      if (!busy) { try { fn(); } catch (e) { console.warn('[BELive] refresh:', e && e.message); } return; }
      var p = pendingIdle.get(root); pendingIdle.set(root, fn);
      if (p) return;
      var self = this;
      (function wait() { setTimeout(function () {
        if (window.BEUpdate && BEUpdate.isEditingIn(root)) return wait();
        var f = pendingIdle.get(root); pendingIdle.delete(root); self.whenIdle(root, f);
      }, 3000); })();
    }
  };
  window.addEventListener('beforeunload', teardown);
})();
