/* ============================================================================
 * policy-config.js — DB-backed policy configuration loader.
 *
 * Loaded BEFORE leave-policy.js in every HTML page. Fetches active policy
 * settings from hr_policy_config and exposes them via window.PolicyConfig.
 * If the DB row is missing or the fetch fails, consumers fall back to their
 * own hardcoded defaults — zero-risk migration path.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var _cache = {};
  var _loaded = false;
  var _sb = null;

  var PolicyConfig = {
    load: async function (sb) {
      _sb = sb;
      try {
        // Active version, plus any "scheduled" version whose effective date has arrived —
        // the newest in-force one wins, so a future-dated policy switches on by itself.
        var { data, error } = await sb
          .from('hr_policy_config')
          .select('policy_key, settings, status, effective_date, version')
          .in('status', ['active', 'scheduled']);
        if (error) { console.warn('[PolicyConfig] fetch error:', error.message); return; }
        var today = new Date(); today = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        var best = {};
        (data || []).forEach(function (row) {
          if (!row.policy_key || !row.settings) return;
          if (row.status === 'scheduled' && String(row.effective_date || '') > today) return;
          var cur = best[row.policy_key];
          var rank = String(row.effective_date || '') + '#' + String(1e6 + (row.version || 0));
          if (!cur || rank > cur.rank) best[row.policy_key] = { rank: rank, settings: row.settings };
        });
        Object.keys(best).forEach(function (k) { _cache[k] = best[k].settings; });
        _loaded = true;
      } catch (e) {
        console.warn('[PolicyConfig] load failed:', e.message);
      }
    },

    refresh: async function () {
      if (_sb) await PolicyConfig.load(_sb);
    },

    get: function (policyKey) {
      return _cache[policyKey] || null;
    },

    getLeavePolicy: function () {
      return _cache['leave'] || {};
    },

    isLoaded: function () { return _loaded; }
  };

  global.PolicyConfig = PolicyConfig;
})(typeof window !== 'undefined' ? window : globalThis);
