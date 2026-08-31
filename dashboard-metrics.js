/* ============================================================================
   SHARED metric-strip builder — index.html, hr.html, academics.html all
   include this one file (paired with dashboard-metrics.css). One function,
   used by every page's own dashboard render code with that page's own
   metric data/colors/click targets — the component/markup is shared, the
   data stays module-specific (spec: "Same metric component pattern.
   Different data. Different module-specific labels.").
   ============================================================================ */
function metricStripHTML(items) {
    return '<div class="metric-strip">' + items.map(function (m) {
        var clickable = m.onclick ? ' data-clickable onclick="' + m.onclick + '"' : '';
        var chevron = m.onclick ? '<svg class="metric-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>' : '';
        return '<div class="metric-item"' + clickable + ' style="--mc:' + m.color + ';--mc-dim:' + m.color + '55;--mc-bg:' + m.color + '1f;--mc-glow:' + m.color + '33">'
            + '<div class="metric-ring"><i data-lucide="' + m.icon + '" style="width:20px;height:20px"></i></div>'
            + '<div class="metric-body">'
                + '<div class="metric-value">' + m.value + '</div>'
                + '<div class="metric-label" title="' + m.label + '">' + m.label + '</div>'
                + '<div class="metric-status"><span class="metric-dot"></span>' + m.status + '</div>'
            + '</div>'
            + chevron
        + '</div>';
    }).join('') + '</div>';
}
