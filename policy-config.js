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
        var { data, error } = await sb
          .from('hr_policy_config')
          .select('policy_key, settings')
          .eq('status', 'active');
        if (error) { console.warn('[PolicyConfig] fetch error:', error.message); return; }
        (data || []).forEach(function (row) {
          if (row.policy_key && row.settings) _cache[row.policy_key] = row.settings;
        });
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
