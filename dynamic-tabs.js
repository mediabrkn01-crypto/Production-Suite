/* ============================================================================
 * dynamic-tabs.js — Renders HR-published custom tabs on department pages.
 * Loaded by index.html, sales.html, academics.html (after common.js/leave-policy.js).
 * Exposes window.DynamicTabs.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var _sb = null;
  var _dept = '';
  var _role = '';
  var _tabs = [];
  var _loaded = {};

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var DynamicTabs = {

    init: async function (sb, department, role) {
      _sb = sb;
      _dept = department || '';
      _role = role || '';
      if (!_sb || !_dept) return;

      var { data, error } = await _sb.from('hr_custom_tabs')
        .select('id,slug,name,icon,target_departments')
        .eq('status', 'published')
        .order('sort_order');
      if (error || !data) return;

      _tabs = data.filter(function (t) {
        var depts = t.target_departments || [];
        return depts.indexOf('all') >= 0 || depts.indexOf(_dept) >= 0;
      });

      if (_tabs.length === 0) return;

      DynamicTabs._injectSidebar();
      DynamicTabs._injectContainers();
    },

    _injectSidebar: function () {
      var page = DynamicTabs._detectPage();
      var anchor = null;
      var sidebarEl = null;

      if (page === 'index') {
        // Insert before TOOLS section in desktop sidebar
        var sections = document.querySelectorAll('.nav-section-title');
        for (var i = 0; i < sections.length; i++) {
          if (sections[i].textContent.trim() === 'TOOLS') { anchor = sections[i]; sidebarEl = sections[i].parentElement; break; }
        }
      } else if (page === 'sales') {
        // Insert before the spacer div (flex:1) at end of aside
        var aside = document.getElementById('aside') || document.querySelector('aside');
        if (aside) {
          var spacer = aside.querySelector('[style*="flex:1"]');
          anchor = spacer;
          sidebarEl = aside;
        }
      } else if (page === 'academics') {
        // Insert before MY WORKSPACE section
        var navSections = document.querySelectorAll('.nav-section-title');
        for (var j = 0; j < navSections.length; j++) {
          if (navSections[j].textContent.trim() === 'MY WORKSPACE') { anchor = navSections[j]; sidebarEl = navSections[j].parentElement; break; }
        }
      }

      if (!sidebarEl) return;

      // Section header
      var header = document.createElement('div');
      header.className = 'nav-section-title';
      header.style.cssText = 'font-size:9px;text-transform:uppercase;color:#808a9d;letter-spacing:1px;margin:10px 0 6px;padding-left:8px;font-weight:600';
      header.textContent = 'COMPANY';
      header.setAttribute('data-dynamic-tabs', 'true');

      if (anchor) {
        sidebarEl.insertBefore(header, anchor);
      } else {
        sidebarEl.appendChild(header);
      }

      _tabs.forEach(function (t) {
        var btn = document.createElement('button');
        btn.className = page === 'academics' ? 'acad-nav-link sidebar-link' : 'sidebar-link';
        btn.id = 'nav-custom-' + t.slug;
        if (page === 'sales') btn.setAttribute('data-tab', 'custom-' + t.slug);
        btn.style.cssText = 'width:100%;text-align:left';
        btn.innerHTML = '<i data-lucide="' + esc(t.icon || 'file-text') + '" style="width:14px;height:14px"></i> ' + (page === 'sales' ? '<span class="be-nav-label">' + esc(t.name) + '</span>' : esc(t.name));
        btn.onclick = function () {
          DynamicTabs._switchTo(t);
        };

        if (anchor) {
          sidebarEl.insertBefore(btn, anchor);
        } else {
          sidebarEl.appendChild(btn);
        }
      });

      if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    _injectContainers: function () {
      var page = DynamicTabs._detectPage();
      var mainArea = null;

      if (page === 'index') {
        // Find the container that holds tab-content-* divs
        var sample = document.getElementById('tab-content-dashboard');
        if (sample) mainArea = sample.parentElement;
      } else if (page === 'sales') {
        var sampleTab = document.querySelector('.tab');
        if (sampleTab) mainArea = sampleTab.parentElement;
      } else if (page === 'academics') {
        var sampleAcad = document.querySelector('.acad-tab');
        if (sampleAcad) mainArea = sampleAcad.parentElement;
      }

      if (!mainArea) return;

      _tabs.forEach(function (t) {
        var div = document.createElement('div');
        if (page === 'index') {
          div.id = 'tab-content-custom-' + t.slug;
          div.className = 'space-y-6 hidden';
        } else if (page === 'sales') {
          div.id = 'tab-custom-' + t.slug;
          div.className = 'tab';
        } else if (page === 'academics') {
          div.id = 'tab-acad-custom-' + t.slug;
          div.className = 'acad-tab';
        }
        div.innerHTML = '<div style="padding:20px 0"><h1 style="font-size:18px;font-weight:700;color:#f1f5f9;margin:0 0 16px">' + esc(t.name) + '</h1><div id="dyntab-content-' + t.id.replace(/-/g, '') + '"></div></div>';
        mainArea.appendChild(div);
      });
    },

    _switchTo: function (tab) {
      var page = DynamicTabs._detectPage();

      if (page === 'index') {
        if (typeof switchTab === 'function') {
          // Hide all standard tabs first
          switchTab('custom-' + tab.slug);
        }
        // Fallback: manually show/hide
        document.querySelectorAll('[id^="tab-content-"]').forEach(function (el) { el.classList.add('hidden'); });
        document.querySelectorAll('.sidebar-link').forEach(function (el) { el.classList.remove('active'); });
        var target = document.getElementById('tab-content-custom-' + tab.slug);
        if (target) target.classList.remove('hidden');
        var navBtn = document.getElementById('nav-custom-' + tab.slug);
        if (navBtn) navBtn.classList.add('active');
        if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
      } else if (page === 'sales') {
        document.querySelectorAll('.tab').forEach(function (el) { el.classList.remove('on'); });
        document.querySelectorAll('.sidebar-link[data-tab]').forEach(function (el) { el.classList.remove('active'); });
        var salesTarget = document.getElementById('tab-custom-' + tab.slug);
        if (salesTarget) salesTarget.classList.add('on');
        var salesNav = document.getElementById('nav-custom-' + tab.slug);
        if (salesNav) salesNav.classList.add('active');
      } else if (page === 'academics') {
        document.querySelectorAll('.acad-nav-link').forEach(function (el) { el.classList.remove('active'); });
        document.querySelectorAll('.acad-tab').forEach(function (el) { el.classList.remove('on'); });
        var acadTarget = document.getElementById('tab-acad-custom-' + tab.slug);
        if (acadTarget) acadTarget.classList.add('on');
        var acadNav = document.getElementById('nav-custom-' + tab.slug);
        if (acadNav) acadNav.classList.add('active');
      }

      DynamicTabs._loadContent(tab);
    },

    _loadContent: async function (tab) {
      var containerId = 'dyntab-content-' + tab.id.replace(/-/g, '');
      var el = document.getElementById(containerId);
      if (!el) return;

      if (_loaded[tab.id]) return;
      _loaded[tab.id] = true;

      el.innerHTML = '<div style="text-align:center;padding:30px;color:#808a9d">Loading...</div>';

      var { data: sections, error } = await _sb.from('hr_custom_tab_sections')
        .select('*')
        .eq('tab_id', tab.id)
        .eq('visible', true)
        .order('sort_order');

      if (error) {
        el.innerHTML = '<div style="color:#f87171;padding:20px">Error loading tab content.</div>';
        _loaded[tab.id] = false;
        return;
      }

      if (!sections || sections.length === 0) {
        el.innerHTML = '<div style="text-align:center;padding:40px;color:#808a9d;font-size:13px">No content published yet.</div>';
        return;
      }

      var html = '';
      sections.forEach(function (sec) {
        html += DynamicTabs._renderSection(sec, tab.id);
      });
      el.innerHTML = html;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    _renderSection: function (sec, tabId) {
      var html = '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:14px">';
      if (sec.title) html += '<h2 style="font-size:14px;font-weight:700;color:#f1f5f9;margin:0 0 12px">' + esc(sec.title) + '</h2>';

      if (sec.section_type === 'text') {
        html += '<div style="font-size:13px;color:#c7cbe0;line-height:1.6">' + ((sec.content && sec.content.html) || '') + '</div>';
      } else if (sec.section_type === 'info') {
        var cards = (sec.content && sec.content.cards) || [];
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">';
        cards.forEach(function (c) {
          html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px">';
          html += '<div style="font-size:10px;color:#808a9d;text-transform:uppercase;letter-spacing:0.5px">' + esc(c.title) + '</div>';
          html += '<div style="font-size:16px;font-weight:700;color:#f1f5f9;margin-top:4px">' + esc(c.value) + '</div>';
          html += '</div>';
        });
        html += '</div>';
      } else if (sec.section_type === 'form') {
        html += DynamicTabs._renderForm(sec, tabId);
      } else if (sec.section_type === 'document') {
        var files = (sec.content && sec.content.files) || [];
        if (files.length === 0) {
          html += '<div style="font-size:12px;color:#808a9d">No documents uploaded yet.</div>';
        } else {
          files.forEach(function (f) {
            html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)">';
            html += '<i data-lucide="file" style="width:14px;height:14px;color:#808a9d"></i>';
            html += '<a href="' + esc(f.url || '#') + '" target="_blank" style="color:#3b82f6;font-size:12px;text-decoration:none">' + esc(f.name) + '</a>';
            html += '</div>';
          });
        }
      } else if (sec.section_type === 'table') {
        html += '<div id="dyntab-table-' + sec.id.replace(/-/g, '') + '" style="font-size:12px;color:#808a9d">Loading table data...</div>';
        DynamicTabs._loadTableData(sec);
      }

      html += '</div>';
      return html;
    },

    _renderForm: function (sec, tabId) {
      var fields = (sec.content && sec.content.fields) || [];
      if (fields.length === 0) return '<div style="font-size:12px;color:#808a9d">Form has no fields.</div>';

      var formId = 'dynform-' + sec.id.replace(/-/g, '');
      var inputStyle = 'width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:7px 10px;color:#f1f5f9;font-size:12px';

      var html = '<form id="' + formId + '" onsubmit="DynamicTabs._submitForm(event,\'' + tabId + '\',\'' + sec.id + '\')">';
      html += '<div style="display:grid;gap:10px">';
      fields.forEach(function (f) {
        html += '<div>';
        html += '<label style="display:block;font-size:10px;color:#808a9d;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">' + esc(f.label) + (f.required ? ' *' : '') + '</label>';
        if (f.type === 'textarea') {
          html += '<textarea name="' + esc(f.name) + '" ' + (f.required ? 'required' : '') + ' style="' + inputStyle + ';min-height:60px" placeholder="' + esc(f.label) + '"></textarea>';
        } else if (f.type === 'select') {
          html += '<select name="' + esc(f.name) + '" ' + (f.required ? 'required' : '') + ' style="' + inputStyle + '">';
          html += '<option value="">Select...</option>';
          (f.options || []).forEach(function (opt) {
            html += '<option value="' + esc(opt) + '">' + esc(opt) + '</option>';
          });
          html += '</select>';
        } else if (f.type === 'checkbox') {
          html += '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#f1f5f9;cursor:pointer"><input type="checkbox" name="' + esc(f.name) + '"> ' + esc(f.label) + '</label>';
        } else {
          html += '<input type="' + (f.type === 'date' ? 'date' : 'text') + '" name="' + esc(f.name) + '" ' + (f.required ? 'required' : '') + ' style="' + inputStyle + '" placeholder="' + esc(f.label) + '">';
        }
        html += '</div>';
      });
      html += '</div>';
      html += '<div style="margin-top:14px;display:flex;justify-content:flex-end">';
      html += '<button type="submit" style="padding:8px 20px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid rgba(16,185,129,.3);background:rgba(16,185,129,.1);color:#10b981;cursor:pointer">' + esc((sec.content && sec.content.submit_label) || 'Submit') + '</button>';
      html += '</div></form>';
      html += '<div id="' + formId + '-msg" style="display:none;margin-top:8px;padding:10px;border-radius:8px;font-size:12px"></div>';
      return html;
    },

    _submitForm: async function (e, tabId, sectionId) {
      e.preventDefault();
      var form = e.target;
      var formId = 'dynform-' + sectionId.replace(/-/g, '');
      var msgEl = document.getElementById(formId + '-msg');
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

      var formData = {};
      var inputs = form.querySelectorAll('input,textarea,select');
      inputs.forEach(function (inp) {
        if (!inp.name) return;
        if (inp.type === 'checkbox') {
          formData[inp.name] = inp.checked;
        } else {
          formData[inp.name] = inp.value;
        }
      });

      var submittedBy = (typeof activeEmail !== 'undefined' && activeEmail) ||
                        (typeof acadEmail !== 'undefined' && acadEmail) || 'unknown';

      var { error } = await _sb.from('hr_custom_tab_submissions').insert([{
        tab_id: tabId,
        section_id: sectionId,
        submitted_by: submittedBy,
        data: formData,
        status: 'submitted'
      }]);

      if (error) {
        if (msgEl) {
          msgEl.style.display = 'block';
          msgEl.style.background = 'rgba(248,113,113,0.1)';
          msgEl.style.color = '#f87171';
          msgEl.textContent = 'Error: ' + error.message;
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
        return;
      }

      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.style.background = 'rgba(16,185,129,0.1)';
        msgEl.style.color = '#10b981';
        msgEl.textContent = 'Submitted successfully!';
      }
      form.reset();
      if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
      setTimeout(function () { if (msgEl) msgEl.style.display = 'none'; }, 3000);
    },

    _loadTableData: async function (sec) {
      var el = document.getElementById('dyntab-table-' + sec.id.replace(/-/g, ''));
      if (!el) return;
      var cols = (sec.content && sec.content.columns) || [];

      var { data: subs } = await _sb.from('hr_custom_tab_submissions')
        .select('*')
        .eq('section_id', sec.id)
        .order('created_at', { ascending: false })
        .limit(100);

      subs = subs || [];
      if (subs.length === 0) {
        el.innerHTML = '<div style="color:#808a9d;font-size:12px">No data yet.</div>';
        return;
      }

      if (cols.length === 0) {
        var allKeys = {};
        subs.forEach(function (s) { Object.keys(s.data || {}).forEach(function (k) { allKeys[k] = true; }); });
        cols = Object.keys(allKeys).map(function (k) { return { key: k, label: k }; });
      }

      var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
      html += '<thead><tr style="border-bottom:1px solid rgba(255,255,255,0.08)">';
      cols.forEach(function (c) {
        html += '<th style="text-align:left;padding:6px 8px;color:#808a9d;font-weight:600">' + esc(c.label) + '</th>';
      });
      html += '</tr></thead><tbody>';
      subs.forEach(function (s) {
        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">';
        cols.forEach(function (c) {
          var v = s.data && s.data[c.key] !== undefined ? s.data[c.key] : '';
          html += '<td style="padding:6px 8px;color:#f1f5f9">' + esc(String(v)) + '</td>';
        });
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      el.innerHTML = html;
    },

    _detectPage: function () {
      if (typeof acadSwitchTab === 'function') return 'academics';
      var path = window.location.pathname.toLowerCase();
      if (path.indexOf('sales') >= 0) return 'sales';
      if (path.indexOf('academics') >= 0 || path.indexOf('acad') >= 0) return 'academics';
      return 'index';
    }
  };

  global.DynamicTabs = DynamicTabs;
})(typeof window !== 'undefined' ? window : globalThis);
