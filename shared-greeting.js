/* ============================================================================
   SHARED live time-of-day greeting — index.html, hr.html, academics.html all
   include this one file. One getGreetingByTime() + one initLiveGreeting()
   used by all three pages; each page supplies its own thin name-resolution
   callback (employee display name → profile full name → auth display name →
   safe fallback — spec's own priority order) and a mount point.
   ============================================================================ */
(function () {
  // 05:00-11:59 Morning, 12:00-16:59 Afternoon, 17:00-20:59 Evening, 21:00-04:59 Night —
  // spec's own recommended ranges. Local device time, same clock the rest of each page's
  // own date/time chip already reads from (new Date()), not a separate time source.
  window.getGreetingByTime = function (date) {
    var h = (date || new Date()).getHours();
    if (h >= 5 && h < 12) return 'Good Morning';
    if (h >= 12 && h < 17) return 'Good Afternoon';
    if (h >= 17 && h < 21) return 'Good Evening';
    return 'Good Night';
  };

  // Called early, right after a mount element exists — deliberately NOT gated on
  // batches/students/reports/attendance/notifications (spec item 8): renders a neutral
  // greeting immediately if the real name isn't resolved yet, then updates in place the
  // moment getName() starts returning one (each page's own getName() callback already reads
  // from data that's typically available fast — activeUser/currentUser.name — but this
  // never blocks on it).
  window.initLiveGreeting = function (opts) {
    var el = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;
    if (!el) return;

    function render() {
      var name = (typeof opts.getName === 'function' && opts.getName()) || null;
      el.textContent = name ? (getGreetingByTime() + ', ' + name) : (getGreetingByTime() + '!');
    }

    render();
    // Once-per-minute check (spec: "do NOT run an expensive interval every second") — cheap
    // enough that a per-page fresh name lookup on every tick is fine, and it's what lets the
    // greeting flip from "Good Morning" to "Good Afternoon" live at the boundary with no
    // page reload, and also lets it pick up the real name once it resolves if the first
    // render happened before login data was ready.
    if (!el.dataset.beGreetingInterval) {
      el.dataset.beGreetingInterval = '1';
      setInterval(render, 60000);
    }
    // Exposed so a page can force an immediate re-render right when it knows the real name
    // just became available (e.g. right after login resolves), rather than waiting up to a
    // minute for the next tick.
    return render;
  };
})();
