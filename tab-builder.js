/* ============================================================================
 * tab-builder.js — HR Tab Builder for creating/managing custom tabs.
 * Loaded only by hr.html. Exposes window.TabBuilder.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var _sb = null;
  var _tabs = [];
  var _currentTab = null;
  var _sections = [];

  var DEPT_OPTIONS = [
    { value: 'all', label: 'All Departments' },
    { value: 'production', label: 'Media / Production' },
    { value: 'education', label: 'Academic' },
    { value: 'sales', label: 'Sales' },
    { value: 'hr', label: 'HR' },
    { value: 'accounts', label: 'Accounts' }
  ];

  var SECTION_TYPES = [
    { value: 'text', label: 'Rich Text', icon: 'type' },
    { value: 'form', label: 'Form', icon: 'clipboard-list' },
    { value: 'table', label: 'Data Table', icon: 'table' },
    { value: 'document', label: 'Documents', icon: 'file-up' },
    { value: 'info', label: 'Info Cards', icon: 'info' }
  ];

  var FIELD_TYPES = [
    { value: 'text', label: 'Text' },
    { value: 'textarea', label: 'Long Text' },
    { value: 'select', label: 'Dropdown' },
    { value: 'date', label: 'Date' },
    { value: 'file', label: 'File Upload' },
    { value: 'checkbox', label: 'Checkbox' }
  ];

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function slugify(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tab-' + Date.now();
  }

  var TabBuilder = {
    init: function (sb) { _sb = sb; },

    renderList: async function () {
      var el = document.getElementById('hr-tab-builder-content');
      if (!el) return;
      el.innerHTML = '<div style="text-align:center;padding:40px;color:#808a9d">Loading tabs...</div>';
      var { data, error } = await _sb.from('hr_custom_tabs').select('*').order('updated_at', { ascending: false });
      if (error) { el.innerHTML = '<div style="color:#f87171;padding:20px">Error: ' + error.message + '</div>'; return; }
      _tabs = data || [];

      var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
      html += '<div style="font-size:13px;color:#808a9d">' + _tabs.length + ' custom tab' + (_tabs.length !== 1 ? 's' : '') + '</div>';
      html += '<button onclick="TabBuilder.openEditor(null)" style="padding:8px 16px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid rgba(59,130,246,.3);background:rgba(59,130,246,.12);color:#3b82f6;cursor:pointer">+ New Tab</button>';
      html += '</div>';

      if (_tabs.length === 0) {
        html += '<div style="text-align:center;padding:60px 20px;color:#808a9d;font-size:13px">No custom tabs yet. Click "+ New Tab" to create one.</div>';
      } else {
        html += '<div style="display:grid;gap:10px">';
        _tabs.forEach(function (t) {
          var statusColor = t.status === 'published' ? '#10b981' : t.status === 'draft' ? '#f59e0b' : t.status === 'archived' ? '#808a9d' : '#f87171';
          var depts = (t.target_departments || []).join(', ') || 'None';
          html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px">';
          html += '<div style="flex:1;min-width:0">';
          html += '<div style="display:flex;align-items:center;gap:8px">';
          html += '<span style="font-size:14px;font-weight:600;color:#f1f5f9">' + esc(t.name) + '</span>';
          html += '<span style="font-size:10px;font-weight:600;color:' + statusColor + ';text-transform:uppercase;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.04)">' + t.status + '</span>';
          html += '</div>';
          html += '<div style="font-size:11px;color:#808a9d;margin-top:2px">' + esc(depts) + (t.description ? ' · ' + esc(t.description) : '') + '</div>';
          html += '</div>';
          html += '<div style="display:flex;gap:6px;flex-shrink:0">';
          html += '<button onclick="TabBuilder.openEditor(\'' + t.id + '\')" style="font-size:11px;padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#f1f5f9;cursor:pointer">Edit</button>';
          if (t.status === 'draft') {
            html += '<button onclick="TabBuilder.publish(\'' + t.id + '\')" style="font-size:11px;padding:5px 10px;border-radius:6px;border:1px solid rgba(16,185,129,.3);background:rgba(16,185,129,.08);color:#10b981;cursor:pointer">Publish</button>';
          } else if (t.status === 'published') {
            html += '<button onclick="TabBuilder.unpublish(\'' + t.id + '\')" style="font-size:11px;padding:5px 10px;border-radius:6px;border:1px solid rgba(245,158,11,.3);background:rgba(245,158,11,.08);color:#f59e0b;cursor:pointer">Unpublish</button>';
            html += '<button onclick="TabBuilder.viewSubmissions(\'' + t.id + '\')" style="font-size:11px;padding:5px 10px;border-radius:6px;border:1px solid rgba(59,130,246,.3);background:rgba(59,130,246,.08);color:#3b82f6;cursor:pointer">Submissions</button>';
          }
          if (t.status !== 'archived') {
            html += '<button onclick="TabBuilder.archive(\'' + t.id + '\')" style="font-size:11px;padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);color:#808a9d;cursor:pointer">Archive</button>';
          }
          html += '</div></div>';
        });
        html += '</div>';
      }
      el.innerHTML = html;
      if (window.lucide) lucide.createIcons();
    },

    openEditor: async function (tabId) {
      var el = document.getElementById('hr-tab-builder-content');
      if (!el) return;
      _currentTab = null;
      _sections = [];

      if (tabId) {
        var { data: tab } = await _sb.from('hr_custom_tabs').select('*').eq('id', tabId).maybeSingle();
        if (!tab) { alert('Tab not found.'); return; }
        _currentTab = tab;
        var { data: secs } = await _sb.from('hr_custom_tab_sections').select('*').eq('tab_id', tabId).order('sort_order');
        _sections = secs || [];
      }

      _renderEditor(el);
    },

    publish: async function (tabId) {
      if (!confirm('Publish this tab? It will become visible to targeted departments.')) return;
      await _sb.from('hr_custom_tabs').update({ status: 'published', published_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', tabId);
      TabBuilder.renderList();
    },

    unpublish: async function (tabId) {
      if (!confirm('Unpublish this tab? It will be hidden from all departments.')) return;
      await _sb.from('hr_custom_tabs').update({ status: 'unpublished', updated_at: new Date().toISOString() }).eq('id', tabId);
      TabBuilder.renderList();
    },

    archive: async function (tabId) {
      if (!confirm('Archive this tab?')) return;
      await _sb.from('hr_custom_tabs').update({ status: 'archived', archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', tabId);
      TabBuilder.renderList();
    },

    viewSubmissions: async function (tabId) {
      var el = document.getElementById('hr-tab-builder-content');
      if (!el) return;
      el.innerHTML = '<div style="text-align:center;padding:40px;color:#808a9d">Loading submissions...</div>';
      var { data: tab } = await _sb.from('hr_custom_tabs').select('name').eq('id', tabId).maybeSingle();
      var { data: subs, error } = await _sb.from('hr_custom_tab_submissions')
        .select('*').eq('tab_id', tabId).order('created_at', { ascending: false });
      if (error) { el.innerHTML = '<div style="color:#f87171">Error: ' + error.message + '</div>'; return; }
      subs = subs || [];

      var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
      html += '<div><span style="font-size:15px;font-weight:700;color:#f1f5f9">' + esc(tab ? tab.name : '') + '</span>';
      html += '<span style="font-size:12px;color:#808a9d;margin-left:8px">' + subs.length + ' submission' + (subs.length !== 1 ? 's' : '') + '</span></div>';
      html += '<div style="display:flex;gap:8px">';
      if (subs.length > 0) {
        html += '<button onclick="TabBuilder._exportCSV(\'' + tabId + '\')" style="font-size:11px;padding:5px 12px;border-radius:6px;border:1px solid rgba(16,185,129,.3);background:rgba(16,185,129,.08);color:#10b981;cursor:pointer">Export CSV</button>';
      }
      html += '<button onclick="TabBuilder.renderList()" style="font-size:11px;padding:5px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#f1f5f9;cursor:pointer">Back</button>';
      html += '</div></div>';

      if (subs.length === 0) {
        html += '<div style="text-align:center;padding:40px;color:#808a9d;font-size:13px">No submissions yet.</div>';
      } else {
        var allKeys = {};
        subs.forEach(function (s) { Object.keys(s.data || {}).forEach(function (k) { allKeys[k] = true; }); });
        var cols = Object.keys(allKeys);
        html += '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="border-bottom:1px solid rgba(255,255,255,0.08)">';
        html += '<th style="text-align:left;padding:6px 8px;color:#808a9d;font-weight:600">Submitted By</th>';
        html += '<th style="text-align:left;padding:6px 8px;color:#808a9d;font-weight:600">Date</th>';
        cols.forEach(function (c) {
          html += '<th style="text-align:left;padding:6px 8px;color:#808a9d;font-weight:600">' + esc(c) + '</th>';
        });
        html += '<th style="text-align:left;padding:6px 8px;color:#808a9d;font-weight:600">Status</th>';
        html += '</tr></thead><tbody>';
        subs.forEach(function (s) {
          html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">';
          html += '<td style="padding:6px 8px;color:#f1f5f9">' + esc(s.submitted_by) + '</td>';
          html += '<td style="padding:6px 8px;color:#808a9d">' + new Date(s.created_at).toLocaleDateString() + '</td>';
          cols.forEach(function (c) {
            var v = s.data && s.data[c] !== undefined ? s.data[c] : '';
            html += '<td style="padding:6px 8px;color:#f1f5f9">' + esc(String(v)) + '</td>';
          });
          var sc = s.status === 'reviewed' ? '#10b981' : '#f59e0b';
          html += '<td style="padding:6px 8px"><span style="color:' + sc + ';font-weight:600;text-transform:capitalize">' + (s.status || 'submitted') + '</span></td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
      }
      el.innerHTML = html;
    },

    _exportCSV: async function (tabId) {
      var { data: subs } = await _sb.from('hr_custom_tab_submissions').select('*').eq('tab_id', tabId).order('created_at', { ascending: false });
      if (!subs || subs.length === 0) return;
      var allKeys = {};
      subs.forEach(function (s) { Object.keys(s.data || {}).forEach(function (k) { allKeys[k] = true; }); });
      var cols = ['submitted_by', 'created_at'].concat(Object.keys(allKeys)).concat(['status']);
      var csvRows = [cols.join(',')];
      subs.forEach(function (s) {
        var row = [s.submitted_by, new Date(s.created_at).toISOString()];
        Object.keys(allKeys).forEach(function (k) { row.push('"' + String(s.data && s.data[k] !== undefined ? s.data[k] : '').replace(/"/g, '""') + '"'); });
        row.push(s.status || 'submitted');
        csvRows.push(row.join(','));
      });
      var blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'submissions-' + tabId.slice(0, 8) + '.csv';
      a.click();
    }
  };

  function _renderEditor(el) {
    var t = _currentTab || {};
    var isNew = !t.id;
    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
    html += '<h2 style="font-size:16px;font-weight:700;color:#f1f5f9;margin:0">' + (isNew ? 'New Tab' : 'Edit Tab') + '</h2>';
    html += '<button onclick="TabBuilder.renderList()" style="font-size:11px;padding:5px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#f1f5f9;cursor:pointer">Back to List</button>';
    html += '</div>';

    // Tab settings card
    html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:16px">';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
    html += _field('Tab Name', '<input id="tb-name" type="text" value="' + esc(t.name || '') + '" placeholder="e.g. Feedback Form" style="' + _inputStyle() + '">');
    html += _field('Description', '<input id="tb-desc" type="text" value="' + esc(t.description || '') + '" placeholder="Short description..." style="' + _inputStyle() + '">');
    html += _field('Icon (Lucide name)', '<input id="tb-icon" type="text" value="' + esc(t.icon || 'file-text') + '" placeholder="file-text" style="' + _inputStyle() + '">');
    html += _field('Sort Order', '<input id="tb-sort" type="number" value="' + (t.sort_order || 0) + '" style="' + _inputStyle() + '">');
    html += '</div>';

    // Department targeting
    html += '<div style="margin-top:12px">';
    html += '<div style="font-size:10px;color:#808a9d;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Target Departments</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
    var currentDepts = t.target_departments || [];
    DEPT_OPTIONS.forEach(function (d) {
      var checked = currentDepts.indexOf(d.value) >= 0;
      html += '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#f1f5f9;cursor:pointer;padding:4px 8px;border-radius:6px;background:' + (checked ? 'rgba(59,130,246,.15)' : 'rgba(255,255,255,0.03)') + ';border:1px solid ' + (checked ? 'rgba(59,130,246,.3)' : 'rgba(255,255,255,0.06)') + '">';
      html += '<input type="checkbox" class="tb-dept" value="' + d.value + '" ' + (checked ? 'checked' : '') + '> ' + d.label;
      html += '</label>';
    });
    html += '</div></div>';

    // Role targeting
    html += '<div style="margin-top:12px">';
    html += '<div style="font-size:10px;color:#808a9d;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Visible To Roles (empty = all)</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
    var ROLE_OPTIONS = [
      { value: 'admin', label: 'Admin / HR' },
      { value: 'manager', label: 'Manager' },
      { value: 'employee', label: 'Employee' },
      { value: 'social_media', label: 'Social Media' },
      { value: 'trainer', label: 'Trainer' }
    ];
    var currentRoles = t.target_roles || [];
    ROLE_OPTIONS.forEach(function (r) {
      var checked = currentRoles.indexOf(r.value) >= 0;
      html += '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#f1f5f9;cursor:pointer;padding:4px 8px;border-radius:6px;background:' + (checked ? 'rgba(168,85,247,.15)' : 'rgba(255,255,255,0.03)') + ';border:1px solid ' + (checked ? 'rgba(168,85,247,.3)' : 'rgba(255,255,255,0.06)') + '">';
      html += '<input type="checkbox" class="tb-role" value="' + r.value + '" ' + (checked ? 'checked' : '') + '> ' + r.label;
      html += '</label>';
    });
    html += '</div></div>';
    html += '</div>';

    // Sections
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">';
    html += '<h3 style="font-size:14px;font-weight:600;color:#f1f5f9;margin:0">Sections (' + _sections.length + ')</h3>';
    html += '<div style="display:flex;gap:6px">';
    SECTION_TYPES.forEach(function (st) {
      html += '<button onclick="TabBuilder._addSection(\'' + st.value + '\')" style="font-size:10px;padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:#808a9d;cursor:pointer">+ ' + st.label + '</button>';
    });
    html += '</div></div>';

    _sections.forEach(function (sec, idx) {
      html += _renderSectionCard(sec, idx);
    });

    // Save buttons
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">';
    html += '<button onclick="TabBuilder._saveTab(\'draft\')" style="padding:8px 16px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid rgba(245,158,11,.3);background:rgba(245,158,11,.1);color:#f59e0b;cursor:pointer">Save as Draft</button>';
    html += '<button onclick="TabBuilder._saveTab(\'published\')" style="padding:8px 16px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid rgba(16,185,129,.3);background:rgba(16,185,129,.1);color:#10b981;cursor:pointer">Save &amp; Publish</button>';
    html += '</div>';

    el.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  }

  function _field(label, input) {
    return '<div><div style="font-size:10px;color:#808a9d;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">' + label + '</div>' + input + '</div>';
  }

  function _inputStyle() {
    return 'width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:7px 10px;color:#f1f5f9;font-size:12px';
  }

  function _renderSectionCard(sec, idx) {
    var typeLabel = SECTION_TYPES.find(function (s) { return s.value === sec.section_type; });
    typeLabel = typeLabel ? typeLabel.label : sec.section_type;
    var html = '<div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;margin-bottom:10px">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
    html += '<div style="display:flex;align-items:center;gap:6px">';
    html += '<span style="font-size:10px;font-weight:600;color:#808a9d;text-transform:uppercase;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.04)">' + typeLabel + '</span>';
    html += '<input type="text" value="' + esc(sec.title || '') + '" placeholder="Section title..." onchange="TabBuilder._updateSectionTitle(' + idx + ', this.value)" style="font-size:13px;font-weight:600;color:#f1f5f9;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.08);padding:2px 4px">';
    html += '</div>';
    html += '<div style="display:flex;gap:4px">';
    if (idx > 0) html += '<button onclick="TabBuilder._moveSection(' + idx + ',-1)" style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.06);background:none;color:#808a9d;cursor:pointer">&uarr;</button>';
    if (idx < _sections.length - 1) html += '<button onclick="TabBuilder._moveSection(' + idx + ',1)" style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.06);background:none;color:#808a9d;cursor:pointer">&darr;</button>';
    html += '<button onclick="TabBuilder._removeSection(' + idx + ')" style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid rgba(248,113,113,.2);background:rgba(248,113,113,.06);color:#f87171;cursor:pointer">&times;</button>';
    html += '</div></div>';

    // Section-type-specific editor
    if (sec.section_type === 'text') {
      html += '<textarea onchange="TabBuilder._updateSectionContent(' + idx + ',{html:this.value})" style="width:100%;min-height:80px;' + _inputStyle() + '" placeholder="HTML content...">' + esc((sec.content && sec.content.html) || '') + '</textarea>';
    } else if (sec.section_type === 'info') {
      var cards = (sec.content && sec.content.cards) || [];
      html += '<div id="tb-info-' + idx + '">';
      cards.forEach(function (c, ci) {
        html += '<div style="display:flex;gap:6px;margin-bottom:4px">';
        html += '<input type="text" value="' + esc(c.title || '') + '" placeholder="Title" onchange="TabBuilder._updateInfoCard(' + idx + ',' + ci + ',\'title\',this.value)" style="flex:1;' + _inputStyle() + '">';
        html += '<input type="text" value="' + esc(c.value || '') + '" placeholder="Value" onchange="TabBuilder._updateInfoCard(' + idx + ',' + ci + ',\'value\',this.value)" style="flex:1;' + _inputStyle() + '">';
        html += '</div>';
      });
      html += '<button onclick="TabBuilder._addInfoCard(' + idx + ')" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.08);background:none;color:#808a9d;cursor:pointer;margin-top:4px">+ Card</button>';
      html += '</div>';
    } else if (sec.section_type === 'form') {
      var fields = (sec.content && sec.content.fields) || [];
      html += '<div id="tb-form-' + idx + '">';
      fields.forEach(function (f, fi) {
        html += '<div style="display:flex;gap:6px;margin-bottom:4px;align-items:center">';
        html += '<input type="text" value="' + esc(f.label || '') + '" placeholder="Label" onchange="TabBuilder._updateFormField(' + idx + ',' + fi + ',\'label\',this.value)" style="flex:2;' + _inputStyle() + '">';
        html += '<input type="text" value="' + esc(f.name || '') + '" placeholder="field_name" onchange="TabBuilder._updateFormField(' + idx + ',' + fi + ',\'name\',this.value)" style="flex:1;' + _inputStyle() + '">';
        html += '<select onchange="TabBuilder._updateFormField(' + idx + ',' + fi + ',\'type\',this.value)" style="flex:1;' + _inputStyle() + '">';
        FIELD_TYPES.forEach(function (ft) {
          html += '<option value="' + ft.value + '"' + (f.type === ft.value ? ' selected' : '') + '>' + ft.label + '</option>';
        });
        html += '</select>';
        html += '<label style="display:flex;align-items:center;gap:3px;font-size:10px;color:#808a9d;white-space:nowrap"><input type="checkbox" ' + (f.required ? 'checked' : '') + ' onchange="TabBuilder._updateFormField(' + idx + ',' + fi + ',\'required\',this.checked)"> Req</label>';
        html += '<button onclick="TabBuilder._removeFormField(' + idx + ',' + fi + ')" style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid rgba(248,113,113,.2);background:none;color:#f87171;cursor:pointer">&times;</button>';
        html += '</div>';
        if (f.type === 'select') {
          html += '<input type="text" value="' + esc((f.options || []).join(', ')) + '" placeholder="Options (comma-separated)" onchange="TabBuilder._updateFormField(' + idx + ',' + fi + ',\'options\',this.value.split(\',\').map(function(s){return s.trim()}).filter(Boolean))" style="margin-bottom:6px;margin-left:20px;width:calc(100% - 20px);' + _inputStyle() + '">';
        }
      });
      html += '<button onclick="TabBuilder._addFormField(' + idx + ')" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.08);background:none;color:#808a9d;cursor:pointer;margin-top:4px">+ Field</button>';
      html += '</div>';
    } else if (sec.section_type === 'document') {
      var files = (sec.content && sec.content.files) || [];
      html += '<div id="tb-docs-' + idx + '">';
      files.forEach(function (f, fi) {
        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">';
        html += '<i data-lucide="file" style="width:12px;height:12px;color:#808a9d;flex-shrink:0"></i>';
        html += '<span style="font-size:12px;color:#f1f5f9;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.name) + '</span>';
        html += '<button onclick="TabBuilder._removeDoc(' + idx + ',' + fi + ')" style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid rgba(248,113,113,.2);background:none;color:#f87171;cursor:pointer;flex-shrink:0">&times;</button>';
        html += '</div>';
      });
      html += '<label style="display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:4px 10px;border-radius:6px;border:1px solid rgba(59,130,246,.3);background:rgba(59,130,246,.08);color:#3b82f6;cursor:pointer;margin-top:4px">';
      html += '<i data-lucide="upload" style="width:12px;height:12px"></i> Upload File';
      html += '<input type="file" style="display:none" onchange="TabBuilder._uploadDoc(' + idx + ',this)">';
      html += '</label>';
      html += '</div>';
    } else if (sec.section_type === 'table') {
      html += '<div style="font-size:11px;color:#808a9d;padding:10px">Table displays form submissions automatically.</div>';
    }

    html += '</div>';
    return html;
  }

  // Section manipulation
  TabBuilder._addSection = function (type) {
    _sections.push({ section_type: type, title: '', content: type === 'form' ? { fields: [] } : type === 'info' ? { cards: [] } : {}, sort_order: _sections.length, visible: true });
    _renderEditor(document.getElementById('hr-tab-builder-content'));
  };

  TabBuilder._removeSection = function (idx) {
    if (!confirm('Remove this section?')) return;
    _sections.splice(idx, 1);
    _renderEditor(document.getElementById('hr-tab-builder-content'));
  };

  TabBuilder._moveSection = function (idx, dir) {
    var other = idx + dir;
    if (other < 0 || other >= _sections.length) return;
    var tmp = _sections[idx];
    _sections[idx] = _sections[other];
    _sections[other] = tmp;
    _renderEditor(document.getElementById('hr-tab-builder-content'));
  };

  TabBuilder._updateSectionTitle = function (idx, val) { _sections[idx].title = val; };

  TabBuilder._updateSectionContent = function (idx, content) {
    Object.assign(_sections[idx].content, content);
  };

  // Form field manipulation
  TabBuilder._addFormField = function (idx) {
    if (!_sections[idx].content.fields) _sections[idx].content.fields = [];
    _sections[idx].content.fields.push({ name: '', label: '', type: 'text', required: false });
    _renderEditor(document.getElementById('hr-tab-builder-content'));
  };

  TabBuilder._removeFormField = function (secIdx, fieldIdx) {
    _sections[secIdx].content.fields.splice(fieldIdx, 1);
    _renderEditor(document.getElementById('hr-tab-builder-content'));
  };

  TabBuilder._updateFormField = function (secIdx, fieldIdx, key, val) {
    _sections[secIdx].content.fields[fieldIdx][key] = val;
  };

  // Info card manipulation
  TabBuilder._addInfoCard = function (idx) {
    if (!_sections[idx].content.cards) _sections[idx].content.cards = [];
    _sections[idx].content.cards.push({ title: '', value: '' });
    _renderEditor(document.getElementById('hr-tab-builder-content'));
  };

  TabBuilder._updateInfoCard = function (secIdx, cardIdx, key, val) {
    _sections[secIdx].content.cards[cardIdx][key] = val;
  };

  // Document manipulation
  TabBuilder._uploadDoc = async function (secIdx, input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    var path = 'docs/' + Date.now() + '-' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    var { data, error } = await _sb.storage.from('custom-tab-docs').upload(path, file, { upsert: true });
    if (error) { alert('Upload failed: ' + error.message); return; }
    var { data: urlData } = _sb.storage.from('custom-tab-docs').getPublicUrl(path);
    if (!_sections[secIdx].content.files) _sections[secIdx].content.files = [];
    _sections[secIdx].content.files.push({ name: file.name, url: urlData.publicUrl, uploaded_at: new Date().toISOString() });
    _renderEditor(document.getElementById('hr-tab-builder-content'));
  };

  TabBuilder._removeDoc = function (secIdx, fileIdx) {
    _sections[secIdx].content.files.splice(fileIdx, 1);
    _renderEditor(document.getElementById('hr-tab-builder-content'));
  };

  // Save tab + sections
  TabBuilder._saveTab = async function (status) {
    var name = document.getElementById('tb-name').value.trim();
    if (!name) { alert('Tab name required.'); return; }
    var desc = document.getElementById('tb-desc').value.trim();
    var icon = document.getElementById('tb-icon').value.trim() || 'file-text';
    var sortOrder = parseInt(document.getElementById('tb-sort').value) || 0;
    var deptCheckboxes = document.querySelectorAll('.tb-dept:checked');
    var depts = [];
    deptCheckboxes.forEach(function (cb) { depts.push(cb.value); });
    if (depts.length === 0) { alert('Select at least one department.'); return; }
    var roleCheckboxes = document.querySelectorAll('.tb-role:checked');
    var roles = [];
    roleCheckboxes.forEach(function (cb) { roles.push(cb.value); });

    var tabData = {
      name: name, description: desc || null, icon: icon,
      target_departments: depts, target_roles: roles, sort_order: sortOrder,
      status: status, updated_at: new Date().toISOString()
    };

    var tabId;
    if (_currentTab && _currentTab.id) {
      tabId = _currentTab.id;
      var { error } = await _sb.from('hr_custom_tabs').update(tabData).eq('id', tabId);
      if (error) { alert('Error saving tab: ' + error.message); return; }
    } else {
      tabData.slug = slugify(name);
      tabData.created_by = (typeof activeEmail !== 'undefined' ? activeEmail : '') || 'unknown';
      if (status === 'published') tabData.published_at = new Date().toISOString();
      var { data: newTab, error } = await _sb.from('hr_custom_tabs').insert([tabData]).select().single();
      if (error) { alert('Error creating tab: ' + error.message); return; }
      tabId = newTab.id;
    }

    // Delete existing sections and re-insert
    await _sb.from('hr_custom_tab_sections').delete().eq('tab_id', tabId);
    if (_sections.length > 0) {
      var secRows = _sections.map(function (s, i) {
        return { tab_id: tabId, section_type: s.section_type, title: s.title || null, content: s.content || {}, sort_order: i, visible: s.visible !== false };
      });
      var { error: secErr } = await _sb.from('hr_custom_tab_sections').insert(secRows);
      if (secErr) { alert('Sections error: ' + secErr.message); return; }
    }

    TabBuilder.renderList();
  };

  global.TabBuilder = TabBuilder;
})(typeof window !== 'undefined' ? window : globalThis);
