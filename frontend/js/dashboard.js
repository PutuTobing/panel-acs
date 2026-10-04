/* ═══════════════════════════════════════════════════════════════
   Panel ACS — Dashboard Module
   (Real data from GenieACS via ACS.loadAll() + ACS.getStats())
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── Live data containers (populated by loadDashboardData) ───
let _DASH_STATS = null;   // set after loadDashboardData()

// Fallback palette for product chart
const PALETTE = [
  '#6366f1','#22c55e','#10b981','#3b82f6','#f59e0b',
  '#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#06b6d4','#94a3b8',
];

// ─── Static RX display labels ───
const RX_META = [
  { label: 'Excellent', color: '#22c55e', range: '≥ −20 dBm',     key: 'excellent' },
  { label: 'Fair',      color: '#f59e0b', range: '−20 s/d −25 dBm', key: 'fair'    },
  { label: 'Poor',      color: '#ef4444', range: '< −25 dBm',      key: 'poor'     },
  { label: 'N/A',       color: '#94a3b8', range: 'Tidak ada data', key: 'na'       },
];

// ─── Static Temp display labels ───
const TEMP_META = [
  { label: 'Normal', color: '#22c55e', range: '< 45°C',   key: 'normal' },
  { label: 'Warm',   color: '#f59e0b', range: '45 – 55°C', key: 'warm'  },
  { label: 'Hot',    color: '#ef4444', range: '> 55°C',    key: 'hot'   },
];

// ─── Registered display labels ───
const REG_LABELS = ['Hari Ini', 'Kemarin', '7 Hari', '1 Bulan'];
// Filter values behind those bars — same order, same buckets as DIM_DEFS.reg.
const REG_KEYS   = ['today', 'yesterday', 'week', 'month'];

/* ─── Drill-down: dashboard → Device page with a filter applied ───
   Every clickable element carries data-dim / data-v; one delegated listener
   on the page turns that into gotoDevicesFiltered() (defined in devices.js).
   Keeping it declarative means charts, legends and bar lists all share one
   code path — nothing to keep in sync. */
function _drill(dim, val) {
  if (!dim || !_drillable(val)) return;
  if (typeof gotoDevicesFiltered === 'function') gotoDevicesFiltered({ [dim]: String(val) });
}

// Show a pointer cursor while the mouse is over a clickable chart segment.
function _cursorOnHover(chart) {
  if (!chart || !chart.canvas) return;
  chart.canvas.addEventListener('mousemove', e => {
    const hit = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
    chart.canvas.style.cursor = hit.length ? 'pointer' : 'default';
  });
}
// "Others"/"Lainnya" are display-only aggregates — they map to no single
// filter value, so they stay non-clickable.
function _drillable(val) {
  return val != null && val !== '' && val !== 'Others' && val !== 'Lainnya';
}
// Class suffix + attributes for a drill-down target (used by the templates).
function _drillCls(val)  { return _drillable(val) ? ' cl-click' : ''; }
function _drillAttrs(dim, val, label) {
  if (!_drillable(val)) return '';
  return ` data-dim="${dim}" data-v="${escHtml(String(val))}"`
       + ` role="button" tabindex="0" title="Lihat ${escHtml(String(label || val))} di menu Device"`;
}

// ─── Chart instances ───
let rxChart   = null;
let prodChart = null;
let ponChart  = null;
let regChart  = null;
let tempChart = null;

// ─── Charts ───
function initCharts(stats) {
  if (!stats) return;
  initRxChart(stats);
  initProductChart(stats);
  initPonChart(stats);
  initRegisteredChart(stats);
  initTempChart(stats);
}

function initRxChart(stats) {
  const canvas   = document.getElementById('rxPowerChart');
  const legendEl = document.getElementById('rxLegend');
  if (!canvas) return;
  if (rxChart) { rxChart.destroy(); rxChart = null; }

  const RX_DATA = RX_META.map(m => ({ ...m, count: stats.rx[m.key] || 0 }));
  const total   = RX_DATA.reduce((s, d) => s + d.count, 0);

  if (legendEl) {
    legendEl.innerHTML = RX_DATA.map(d => {
      const pct = total ? ((d.count / total) * 100).toFixed(1) : '0.0';
      return `
        <div class="cl-item${_drillCls(d.key)}"${_drillAttrs('rx', d.key, d.label)}>
          <span class="cl-dot" style="background:${d.color}"></span>
          <span class="cl-name">${d.label}</span>
          <div class="cl-right">
            <span class="cl-pct" style="color:${d.color}" data-countf="${pct}">0%</span>
            <span class="cl-num" data-count="${d.count}" data-suffix=" ONU">0 ONU</span>
          </div>
          <i class="fas fa-arrow-right cl-go" aria-hidden="true"></i>
        </div>`;
    }).join('');
  }

  const centerLabel = document.getElementById('rxCenterLabel');
  const centerVal   = document.getElementById('rxCenterVal');
  const centerSub   = document.getElementById('rxCenterSub');
  function resetCenter() {
    if (centerLabel) { centerLabel.textContent = 'RX Power'; centerLabel.style.color = ''; }
    if (centerVal)   { centerVal.textContent = '100%';       centerVal.style.color = ''; }
    if (centerSub)   centerSub.textContent = `${total.toLocaleString()} ONU`;
  }
  resetCenter();

  rxChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: RX_DATA.map(d => d.count),
        backgroundColor: RX_DATA.map(d => d.color),
        borderWidth: 0, hoverOffset: 10, hoverBorderWidth: 0,
      }],
    },
    options: {
      cutout: '72%',
      layout: { padding: 12 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      onHover: (evt, elements) => {
        if (elements.length > 0) {
          const d   = RX_DATA[elements[0].index];
          const pct = total ? ((d.count / total) * 100).toFixed(1) : '0.0';
          if (centerLabel) { centerLabel.textContent = d.label; centerLabel.style.color = d.color; }
          if (centerVal)   { centerVal.textContent = pct + '%'; centerVal.style.color = d.color; }
          if (centerSub)   centerSub.textContent = d.count.toLocaleString() + ' ONU';
        } else { resetCenter(); }
      },
      onClick: (evt, elements) => {
        if (elements.length > 0) _drill('rx', RX_DATA[elements[0].index].key);
      },
      animation: { animateScale: true, duration: 800 },
    },
  });
  _cursorOnHover(rxChart);
}

function initProductChart(stats) {
  const canvas   = document.getElementById('productChart');
  const legendEl = document.getElementById('productLegend');
  if (!canvas) return;
  if (prodChart) { prodChart.destroy(); prodChart = null; }

  // Build sorted product data from stats.prodMap
  const entries = Object.entries(stats.prodMap || {})
    .sort((a, b) => b[1] - a[1]);
  // Show top 11, lump rest as "Others"
  let others = 0;
  const labels = [], data = [], colors = [];
  entries.forEach(([lbl, cnt], i) => {
    if (i < 11) { labels.push(lbl); data.push(cnt); colors.push(PALETTE[i]); }
    else others += cnt;
  });
  if (others > 0) { labels.push('Others'); data.push(others); colors.push(PALETTE[11]); }

  const total = data.reduce((s, v) => s + v, 0);

  if (legendEl) {
    legendEl.innerHTML = labels.map((lbl, i) => {
      const pct = total ? ((data[i] / total) * 100).toFixed(1) : '0.0';
      return `
        <div class="cl-item${_drillCls(lbl)}"${_drillAttrs('model', lbl, lbl)}>
          <span class="cl-dot" style="background:${colors[i]}"></span>
          <span class="cl-name">${escHtml(lbl)}</span>
          <div class="cl-right">
            <span class="cl-pct" style="color:${colors[i]}" data-countf="${pct}">0%</span>
            <span class="cl-num" data-count="${data[i]}" data-suffix=" ONU">0 ONU</span>
          </div>
          <i class="fas fa-arrow-right cl-go" aria-hidden="true"></i>
        </div>`;
    }).join('');
  }

  prodChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data,
        backgroundColor: colors,
        borderWidth: 0, hoverOffset: 10, hoverBorderWidth: 0,
      }],
    },
    options: {
      cutout: '72%',
      layout: { padding: 12 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      onHover: (evt, elements) => {
        const centerLabel = document.getElementById('prodCenterLabel');
        const centerVal   = document.getElementById('prodCenterVal');
        const centerSub   = document.getElementById('prodCenterSub');
        if (elements.length > 0) {
          const i   = elements[0].index;
          const pct = total ? ((data[i] / total) * 100).toFixed(1) : '0.0';
          if (centerLabel) { centerLabel.textContent = labels[i]; centerLabel.style.color = colors[i]; }
          if (centerVal)   { centerVal.textContent = pct + '%';   centerVal.style.color   = colors[i]; }
          if (centerSub)   centerSub.textContent = data[i].toLocaleString() + ' ONU';
        } else {
          if (centerLabel) { centerLabel.textContent = 'Product'; centerLabel.style.color = ''; }
          if (centerVal)   { centerVal.textContent = '100%';      centerVal.style.color = ''; }
          if (centerSub)   centerSub.textContent = `${total.toLocaleString()} ONU`;
        }
      },
      onClick: (evt, elements) => {
        if (elements.length > 0) _drill('model', labels[elements[0].index]);
      },
      animation: { animateScale: true, duration: 800 },
    },
  });
  _cursorOnHover(prodChart);
}

function initPonChart(stats) {
  const canvas   = document.getElementById('ponModeChart');
  const legendEl = document.getElementById('ponLegend');
  if (!canvas) return;
  if (ponChart) { ponChart.destroy(); ponChart = null; }

  const ponColors = { GPON: '#6366f1', EPON: '#22c55e', Ethernet: '#f59e0b', Unknown: '#94a3b8' };
  const PON_DATA = Object.entries(stats.ponMap || {}).map(([label, count]) => ({
    label, count, color: ponColors[label] || '#94a3b8',
  }));
  const total = PON_DATA.reduce((s, d) => s + d.count, 0);
  const centerLabel = document.getElementById('ponCenterLabel');
  const centerVal   = document.getElementById('ponCenterVal');
  const centerSub   = document.getElementById('ponCenterSub');

  function resetCenter() {
    if (centerLabel) { centerLabel.textContent = 'PON Mode'; centerLabel.style.color = ''; }
    if (centerVal)   { centerVal.textContent = '100%';        centerVal.style.color = ''; }
    if (centerSub)   centerSub.textContent = `${total.toLocaleString()} ONU`;
  }
  resetCenter();

  if (legendEl) {
    legendEl.innerHTML = PON_DATA.map(d => {
      const pct = ((d.count / total) * 100).toFixed(1);
      return `<div class="cl-item${_drillCls(d.label)}"${_drillAttrs('pon', d.label, d.label)}>
        <span class="cl-dot" style="background:${d.color}"></span>
        <span class="cl-name">${escHtml(d.label)}</span>
        <div class="cl-right">
          <span class="cl-pct" style="color:${d.color}" data-countf="${pct}">0%</span>
          <span class="cl-num" data-count="${d.count}" data-suffix=" ONU">0 ONU</span>
        </div>
        <i class="fas fa-arrow-right cl-go" aria-hidden="true"></i>
      </div>`;
    }).join('');
  }

  ponChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: PON_DATA.map(d => d.count),
        backgroundColor: PON_DATA.map(d => d.color),
        borderWidth: 0, hoverOffset: 10, hoverBorderWidth: 0,
      }],
    },
    options: {
      cutout: '72%',
      layout: { padding: 12 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      onHover: (evt, elements) => {
        if (elements.length > 0) {
          const d   = PON_DATA[elements[0].index];
          const pct = total ? ((d.count / total) * 100).toFixed(1) : '0.0';
          if (centerLabel) { centerLabel.textContent = d.label;  centerLabel.style.color = d.color; }
          if (centerVal)   { centerVal.textContent = pct + '%';  centerVal.style.color   = d.color; }
          if (centerSub)   centerSub.textContent = d.count.toLocaleString() + ' ONU';
        } else { resetCenter(); }
      },
      onClick: (evt, elements) => {
        if (elements.length > 0) _drill('pon', PON_DATA[elements[0].index].label);
      },
      animation: { animateScale: true, duration: 800 },
    },
  });
  _cursorOnHover(ponChart);
}

function initRegisteredChart(stats) {
  const canvas = document.getElementById('registeredChart');
  if (!canvas) return;
  if (regChart) { regChart.destroy(); regChart = null; }

  const regData   = stats.reg || {};
  const regValues = [regData.today || 0, regData.yesterday || 0, regData.week || 0, regData.month || 0];
  const regColors = ['#6366f1', '#22c55e', '#3b82f6', '#f59e0b'];

  regChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: REG_LABELS,
      datasets: [{
        label: 'ONU Terdaftar',
        data: regValues,
        backgroundColor: regColors.map(c => c + 'cc'),
        borderColor: regColors,
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(15,23,42,.92)',
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            title: ctx => ctx[0].label,
            label: ctx => `  ${ctx.parsed.y} ONU terdaftar`,
            footer: () => 'Klik untuk lihat daftarnya',
          },
        },
      },
      onClick: (evt, elements) => {
        if (elements.length > 0) _drill('reg', REG_KEYS[elements[0].index]);
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 12, weight: '600' }, color: 'rgba(100,116,139,.9)' },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(100,116,139,.1)', drawBorder: false },
          ticks: {
            stepSize: 50,
            font: { size: 11 },
            color: 'rgba(100,116,139,.7)',
            callback: v => v === 0 ? '0' : v,
          },
          border: { display: false },
        },
      },
      animation: { duration: 800 },
    },
  });
  _cursorOnHover(regChart);
}

function initTempChart(stats) {
  const canvas   = document.getElementById('tempChart');
  const legendEl = document.getElementById('tempLegend');
  if (!canvas) return;
  if (tempChart) { tempChart.destroy(); tempChart = null; }

  const TEMP_DATA = TEMP_META.map(m => ({ ...m, count: stats.temp[m.key] || 0 }));
  const total     = TEMP_DATA.reduce((s, d) => s + d.count, 0);
  const centerLabel = document.getElementById('tempCenterLabel');
  const centerVal   = document.getElementById('tempCenterVal');
  const centerSub   = document.getElementById('tempCenterSub');

  function resetCenter() {
    if (centerLabel) { centerLabel.textContent = 'Suhu ONU'; centerLabel.style.color = ''; }
    if (centerVal)   { centerVal.textContent = '100%';        centerVal.style.color = ''; }
    if (centerSub)   centerSub.textContent = `${total.toLocaleString()} ONU`;
  }
  resetCenter();

  if (legendEl) {
    legendEl.innerHTML = TEMP_DATA.map(d => {
      const pct = total ? ((d.count / total) * 100).toFixed(1) : '0.0';
      return `<div class="cl-item${_drillCls(d.key)}"${_drillAttrs('temp', d.key, d.label)}>
        <span class="cl-dot" style="background:${d.color}"></span>
        <span class="cl-name">${d.label}</span>
        <div class="cl-right">
          <span class="cl-pct" style="color:${d.color}" data-countf="${pct}">0%</span>
          <span class="cl-num"><span data-count="${d.count}" data-suffix=" ONU">0 ONU</span>&nbsp;<span style="color:var(--text-muted);font-weight:400">${d.range}</span></span>
        </div>
        <i class="fas fa-arrow-right cl-go" aria-hidden="true"></i>
      </div>`;
    }).join('');
  }

  tempChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: TEMP_DATA.map(d => d.count),
        backgroundColor: TEMP_DATA.map(d => d.color),
        borderWidth: 0, hoverOffset: 10, hoverBorderWidth: 0,
      }],
    },
    options: {
      cutout: '72%',
      layout: { padding: 12 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      onHover: (evt, elements) => {
        const centerLabel = document.getElementById('tempCenterLabel');
        const centerVal   = document.getElementById('tempCenterVal');
        const centerSub   = document.getElementById('tempCenterSub');
        if (elements.length > 0) {
          const d   = TEMP_DATA[elements[0].index];
          const pct = total ? ((d.count / total) * 100).toFixed(1) : '0.0';
          if (centerLabel) { centerLabel.textContent = d.range;  centerLabel.style.color = d.color; }
          if (centerVal)   { centerVal.textContent = pct + '%';  centerVal.style.color   = d.color; }
          if (centerSub)   centerSub.textContent = d.count.toLocaleString() + ' ONU';
        } else {
          if (centerLabel) { centerLabel.textContent = 'Suhu ONU'; centerLabel.style.color = ''; }
          if (centerVal)   { centerVal.textContent = '100%';        centerVal.style.color = ''; }
          if (centerSub)   centerSub.textContent = `${total.toLocaleString()} ONU`;
        }
      },
      onClick: (evt, elements) => {
        if (elements.length > 0) _drill('temp', TEMP_DATA[elements[0].index].key);
      },
      animation: { animateScale: true, duration: 800 },
    },
  });
  _cursorOnHover(tempChart);
}

// ─── Recent Provisions (from real data) ───
function renderRecentProvisions() {
  const tbody = document.getElementById('recentProvBody');
  if (!tbody) return;
  const recent = ACS.getRecentlyRegistered(5);
  if (!recent.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:20px">Tidak ada data</td></tr>';
    return;
  }
  tbody.innerHTML = recent.map(d =>
    `<tr>
      <td><span class="device-id-badge">${escHtml(d.id)}</span></td>
      <td>${escHtml(d.model)}</td>
      <td style="font-family:monospace;font-size:12px;letter-spacing:.02em">${escHtml(d.serial)}</td>
      <td><div class="datetime-cell">
        <span class="date-day">${escHtml(d.registered.split(',')[0])}</span>
        <span class="date-time">${escHtml(d.registered.split(',')[1] || '')}</span>
      </div></td>
    </tr>`
  ).join('');
}

// ─── Last Week Events (real data from ACS.getWeekEvents) ───
function renderLastWeekEvents(faultCount) {
  const tbody = document.getElementById('lastWeekBody');
  if (!tbody) return;
  const rows = ACS.getWeekEvents(faultCount);
  tbody.innerHTML = rows.map(r =>
    `<tr>
      <td><span class="ev-dot" style="background:${r.color}"></span>${escHtml(r.label)}</td>
      <td class="text-right fw6" data-count="${r.count}">0</td>
    </tr>`
  ).join('');
}

// ─── Update stat cards with real data ───
function updateStatCards(stats, faultCount) {
  const root = document.getElementById('page-dashboard');
  if (!root) return;

  const onlinePct  = stats.total ? ((stats.online  / stats.total) * 100).toFixed(1) : '0.0';
  const offlinePct = stats.total ? ((stats.offline / stats.total) * 100).toFixed(1) : '0.0';

  // Update data-count attributes so animateCounters picks them up
  const cards = root.querySelectorAll('.stat-card');
  if (cards[0]) cards[0].querySelector('[data-count]').dataset.count = stats.total;
  if (cards[1]) {
    cards[1].querySelector('[data-count]').dataset.count    = stats.online;
    const pill = cards[1].querySelector('[data-countf]');
    if (pill) pill.dataset.countf = onlinePct;
  }
  if (cards[2]) {
    cards[2].querySelector('[data-count]').dataset.count    = stats.offline;
    const pill = cards[2].querySelector('[data-countf]');
    if (pill) pill.dataset.countf = offlinePct;
  }
  if (cards[3]) cards[3].querySelector('[data-count]').dataset.count = faultCount;

  // Update badge counts in chart headers
  root.querySelectorAll('.badge').forEach(b => {
    if (b.textContent.includes('Devices') || b.textContent.includes('ONU')) {
      b.innerHTML = `<i class="fas fa-database"></i> ${stats.total.toLocaleString()} Devices`;
    }
  });
}

// ─── Dashboard Entry Point ───
// ═══════════════════════════════════════════════════════════════
//  DASHBOARD EXTRAS — distribusi & watchlist (semua dari data real,
//  dihitung dari App.devices; tidak ada nilai yang di-hardcode)
// ═══════════════════════════════════════════════════════════════
const STALE_MS  = 24 * 3600 * 1000;   // "tidak inform" bila > 24 jam
const REBOOT_MS = 24 * 3600 * 1000;   // "baru reboot" bila < 24 jam
const VERYSTALE_MS = 7 * 86400000;    // sorotan bila > 7 hari

// Open a device detail page from any dashboard list (by GenieACS id)
function openDeviceById(id) {
  const d = (App.devices || []).find(x => x.id === id);
  if (!d) return;
  bukaDetailPerangkat(d.id, d);     // satu pintu — lihat main.js
}

// Count devices by a key function → sorted [ [label, count], ... ] desc
function _countBy(devs, keyFn) {
  const m = {};
  devs.forEach(d => { const k = keyFn(d); m[k] = (m[k] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

// Render a ranked horizontal bar list into #id (top N + "Lainnya")
function _renderBarList(elId, entries, opts) {
  const el = document.getElementById(elId);
  if (!el) return 0;
  opts = opts || {};
  const topN  = opts.topN || 8;
  const total = entries.reduce((s, e) => s + e[1], 0);
  let rows = entries, others = 0;
  if (entries.length > topN) {
    rows   = entries.slice(0, topN);
    others = entries.slice(topN).reduce((s, e) => s + e[1], 0);
  }
  const max = rows.length ? rows[0][1] : 1;
  // opts.dim → rows become drill-down targets for that filter dimension.
  const dim = opts.dim || '';
  const rowHTML = (label, cnt, color) => {
    const pct = total ? (cnt / total * 100) : 0;
    const w   = max   ? (cnt / max   * 100) : 0;
    const hot = dim && _drillable(label);
    return `<div class="bar-row${hot ? ' bar-click' : ''}"${
      hot ? ` data-dim="${dim}" data-v="${escHtml(label)}" role="button" tabindex="0"` : ''}
      title="${escHtml(label)}${hot ? ' — klik untuk lihat di menu Device' : ''}">
      <span class="bar-label">${escHtml(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${w.toFixed(1)}%;background:${color}"></span></span>
      <span class="bar-val"><b>${cnt.toLocaleString('id-ID')}</b><i>${pct.toFixed(1)}%</i></span>
    </div>`;
  };
  let html = rows.map(([lbl, cnt], i) => rowHTML(lbl, cnt, PALETTE[i % PALETTE.length])).join('');
  if (others > 0) html += rowHTML('Lainnya', others, '#94a3b8');
  el.innerHTML = html || '<div class="watch-empty" style="color:var(--text-muted)"><i class="fas fa-inbox"></i> Belum ada data</div>';
  return total;
}

function renderVendorDist() {
  const devs = App.devices || [];
  const total = _renderBarList('vendorDist', _countBy(devs, d => d.mfr || '—'), { topN: 8, dim: 'vendor' });
  const b = document.getElementById('vendorTotal');
  if (b) b.textContent = total.toLocaleString('id-ID') + ' ONU';
}
function renderFirmwareDist() {
  const devs = App.devices || [];
  const total = _renderBarList('fwDist', _countBy(devs, d => (d.swVer && d.swVer !== '—') ? d.swVer : 'Tidak diketahui'), { topN: 8 });
  const b = document.getElementById('fwTotal');
  if (b) b.textContent = total.toLocaleString('id-ID') + ' ONU';
}
function renderVlanDist() {
  const devs = App.devices || [];
  const total = _renderBarList('vlanDist', _countBy(devs, d => (d.vlan && d.vlan !== '—') ? d.vlan : 'Tanpa VLAN'), { topN: 10 });
  const b = document.getElementById('vlanTotal');
  if (b) b.textContent = total.toLocaleString('id-ID') + ' ONU';
}

// PPPoE / WAN: dapat IP vs tidak (split bar)
function renderPppoeDist() {
  const el = document.getElementById('pppoeDist');
  if (!el) return;
  const devs = App.devices || [];
  const total  = devs.length;
  const active = devs.filter(d => d.ip && d.ip !== '—' && String(d.ip).trim() !== '').length;
  const idle   = total - active;
  const pa = total ? (active / total * 100) : 0;
  const pi = total ? (idle   / total * 100) : 0;
  el.innerHTML = `
    <div class="split-wrap">
      <div class="split-bar">
        <span class="split-seg" style="width:${pa.toFixed(1)}%;background:linear-gradient(90deg,#22c55e,#10b981)"></span>
        <span class="split-seg" style="width:${pi.toFixed(1)}%;background:var(--text-light)"></span>
      </div>
      <div class="split-legend">
        <div class="split-item">
          <span class="si-top"><span class="split-dot" style="background:#22c55e"></span> Dapat IP</span>
          <span class="si-val" style="color:var(--green)">${active.toLocaleString('id-ID')}</span>
          <span class="si-pct">${pa.toFixed(1)}%</span>
        </div>
        <div class="split-item" style="text-align:right;align-items:flex-end">
          <span class="si-top"><span class="split-dot" style="background:var(--text-light)"></span> Tanpa IP</span>
          <span class="si-val" style="color:var(--text-muted)">${idle.toLocaleString('id-ID')}</span>
          <span class="si-pct">${pi.toFixed(1)}%</span>
        </div>
      </div>
    </div>`;
}

// ─── Watchlists ───
function _fillWatch(elId, countElId, rowsHTML, count, emptyHTML, badgeColor) {
  const el = document.getElementById(elId);
  if (el) el.innerHTML = count ? rowsHTML : emptyHTML;
  const c = document.getElementById(countElId);
  if (c) { c.textContent = count; if (badgeColor) c.className = 'badge ' + badgeColor; }
  // Wire row activation (fresh DOM each render → no duplicate listeners).
  // Click OR keyboard (Enter/Space) opens the selected ONU's detail page.
  if (el) el.querySelectorAll('.watch-row').forEach(r => {
    const go = () => openDeviceById(r.dataset.id);
    r.addEventListener('click', go);
    r.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
}
function _watchRow(d, mainHTML, subHTML) {
  const dot = d.online
    ? '<span class="wr-dot" style="background:var(--green)" title="Online"></span>'
    : '<span class="wr-dot" style="background:var(--text-light)" title="Offline"></span>';
  return `<div class="watch-row" data-id="${escHtml(d.id)}" role="button" tabindex="0" title="Buka detail ONU ${escHtml(d.serial || '')}">
    <div class="wr-main">
      <span class="wr-serial">${dot}${escHtml(d.serial || '—')}</span>
      <span class="wr-model">${escHtml(d.model || '—')}${d.odp && d.odp !== '—' ? ' · ' + escHtml(d.odp) : ''}</span>
    </div>
    <div class="wr-metric">${mainHTML}${subHTML || ''}</div>
    <i class="fas fa-chevron-right wr-go" aria-hidden="true"></i>
  </div>`;
}

function renderRxWatch() {
  const t = ACS.rxThr();
  const rows = (App.devices || [])
    .map(d => ({ d, rx: parseFloat(d.rx) }))
    .filter(x => !isNaN(x.rx) && x.rx < t.fair)
    .sort((a, b) => a.rx - b.rx)
    .slice(0, 80);
  const html = rows.map(({ d, rx }) =>
    _watchRow(d,
      `<span class="m-main" style="color:var(--red)">${rx.toFixed(2)} dBm</span>`,
      `<span class="m-sub">ambang &lt; ${t.fair} dBm</span>`)).join('');
  _fillWatch('rxWatch', 'rxWatchCount', html, rows.length,
    '<div class="watch-empty"><i class="fas fa-circle-check"></i> Semua sinyal sehat</div>',
    rows.length ? 'bg-red' : 'bg-green');
}
function renderStaleWatch() {
  const now = Date.now();
  const rows = (App.devices || [])
    .filter(d => d.lastInformRaw && (now - new Date(d.lastInformRaw).getTime()) > STALE_MS)
    .map(d => ({ d, age: now - new Date(d.lastInformRaw).getTime() }))
    .sort((a, b) => b.age - a.age)
    .slice(0, 80);
  const html = rows.map(({ d, age }) => {
    const very = age > VERYSTALE_MS;
    return _watchRow(d,
      `<span class="m-main" style="color:var(--${very ? 'red' : 'amber'})">${ACS.relTime(d.lastInformRaw)}</span>`,
      `<span class="m-sub">inform terakhir</span>`);
  }).join('');
  _fillWatch('staleWatch', 'staleWatchCount', html, rows.length,
    '<div class="watch-empty"><i class="fas fa-circle-check"></i> Semua ONU inform terkini</div>',
    rows.length ? 'bg-amber' : 'bg-green');
}
function renderRebootWatch() {
  const now = Date.now();
  const rows = (App.devices || [])
    .filter(d => d.lastBootRaw && (now - new Date(d.lastBootRaw).getTime()) < REBOOT_MS)
    .map(d => ({ d, age: now - new Date(d.lastBootRaw).getTime() }))
    .sort((a, b) => a.age - b.age)
    .slice(0, 80);
  const html = rows.map(({ d }) =>
    _watchRow(d,
      `<span class="m-main" style="color:var(--amber)">${ACS.relTime(d.lastBootRaw)}</span>`,
      `<span class="m-sub">boot terakhir</span>`)).join('');
  _fillWatch('rebootWatch', 'rebootWatchCount', html, rows.length,
    '<div class="watch-empty"><i class="fas fa-circle-check"></i> Tidak ada reboot 24 jam terakhir</div>',
    rows.length ? 'bg-amber' : 'bg-green');
}

// Render every extra widget (call after devices are loaded)
function renderDashboardExtras() {
  renderVendorDist();
  renderFirmwareDist();
  renderVlanDist();
  renderPppoeDist();
  renderRxWatch();
  renderStaleWatch();
  renderRebootWatch();
}

// ─── Header action: re-fetch device list (read-only) & re-render ───
// Read-only: ACS.loadAll() + fetchFaultCount() are plain NBI GETs. No task is
// queued to any ONU, so this can never reboot or disturb a live customer.
function refreshDashboard(btn) {
  setBtnBusy(btn, true);
  Promise.all([ACS.loadAll(), ACS.fetchFaultCount().catch(() => 0)])
    .then(([devices, faultCount]) => {
      const stats = ACS.getStats();
      _DASH_STATS = stats;
      updateStatCards(stats, faultCount);
      initCharts(stats);
      renderRecentProvisions();
      renderLastWeekEvents(faultCount);
      renderDashboardExtras();
      setTimeout(() => animateCounters('page-dashboard'), 80);
      if (typeof showToast === 'function') showToast('Dashboard diperbarui', 'success');
    })
    .catch(err => {
      console.error('Dashboard refresh failed:', err);
      if (typeof showToast === 'function') showToast('Gagal memuat data', 'error');
    })
    .finally(() => setBtnBusy(btn, false));
}

/* ─── Header action: export the dashboard as a SUMMARY report ───
   Deliberately different from the Device export (which is the row-by-row
   table): this is the aggregated picture the dashboard shows — the same
   numbers, in the same buckets, so the file and the screen always agree. */
function exportDashboardCSV(btn) {
  const devs = App.devices || [];
  if (!devs.length) {
    if (typeof showToast === 'function') showToast('Belum ada data untuk diekspor', 'info');
    return;
  }
  const s = ACS.getStats();
  const pct = (n) => (s.total ? (n / s.total * 100).toFixed(1) + '%' : '0%');
  const rows = [];
  const section = (t) => { rows.push([]); rows.push([t]); };

  rows.push(['SKY ACS — Ringkasan Dashboard']);
  rows.push(['Dibuat', new Date().toLocaleString('id-ID')]);

  section('RINGKASAN');
  rows.push(['Metrik', 'Jumlah', 'Persentase']);
  rows.push(['Total Perangkat', s.total, '100%']);
  rows.push(['Online',  s.online,  pct(s.online)]);
  rows.push(['Offline', s.offline, pct(s.offline)]);

  section('RX POWER');
  rows.push(['Kategori', 'Jumlah', 'Persentase']);
  RX_META.forEach(m => rows.push([m.label + ' (' + m.range + ')', s.rx[m.key] || 0, pct(s.rx[m.key] || 0)]));

  section('TEMPERATURE');
  rows.push(['Kategori', 'Jumlah', 'Persentase']);
  TEMP_META.forEach(m => rows.push([m.label + ' (' + m.range + ')', s.temp[m.key] || 0, pct(s.temp[m.key] || 0)]));

  section('PON MODE');
  rows.push(['Mode', 'Jumlah', 'Persentase']);
  Object.entries(s.ponMap || {}).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => rows.push([k, v, pct(v)]));

  section('ONU REGISTERED');
  rows.push(['Periode', 'Jumlah']);
  REG_LABELS.forEach((l, i) => rows.push([l, s.reg[REG_KEYS[i]] || 0]));

  const dist = (title, keyFn) => {
    section(title);
    rows.push(['Nilai', 'Jumlah', 'Persentase']);
    _countBy(devs, keyFn).forEach(([k, v]) => rows.push([k, v, pct(v)]));
  };
  dist('DISTRIBUSI PRODUCT CLASS', d => d.model || 'Unknown');
  dist('DISTRIBUSI VENDOR',        d => d.mfr || '—');
  dist('DISTRIBUSI FIRMWARE',      d => (d.swVer && d.swVer !== '—') ? d.swVer : 'Tidak diketahui');
  dist('DISTRIBUSI VLAN',          d => (d.vlan && d.vlan !== '—') ? d.vlan : 'Tanpa VLAN');

  section('PPPoE / WAN');
  const active = devs.filter(d => d.ip && d.ip !== '—' && String(d.ip).trim() !== '').length;
  rows.push(['Status', 'Jumlah', 'Persentase']);
  rows.push(['Dapat IP', active, pct(active)]);
  rows.push(['Tanpa IP', s.total - active, pct(s.total - active)]);

  downloadCSV('sky-acs-ringkasan-dashboard_' + exportStamp() + '.csv', rows);
  if (typeof showToast === 'function') showToast('Ringkasan dashboard diekspor', 'success');
}

// One delegated listener covers every [data-dim] target on the page — chart
// legends and bar-list rows alike, including the ones re-rendered later.
function _wireDrillDown() {
  const root = document.getElementById('page-dashboard');
  // Sekali per DOM halaman. initDashboard() juga dipanggil auto-refresh & Simpan Parameter
  // TANPA halaman dimuat ulang: tanpa penanda ini pendengar bertambah tiap menit, dan satu
  // klik pada grafik berpindah ke menu Device berkali-kali (dashboard terbuka 1 jam =
  // ±60 perpindahan dan 60 permintaan kembar; ditemukan audit menu 2026-10-04).
  if (!root || root.dataset.drill) return;
  root.dataset.drill = '1';
  root.addEventListener('click', e => {
    const t = e.target.closest('[data-dim][data-v]');
    if (t) _drill(t.dataset.dim, t.dataset.v);
  });
  root.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-dim][data-v]');
    if (t) { e.preventDefault(); _drill(t.dataset.dim, t.dataset.v); }
  });
}

function initDashboard() {
  _wireDrillDown();

  // If data already loaded, render immediately from cache
  if (App.devices && App.devices.length > 0) {
    const stats = ACS.getStats();
    updateStatCards(stats, 0);
    initCharts(stats);
    renderRecentProvisions();
    renderLastWeekEvents(0);
    renderDashboardExtras();
    ACS.fetchFaultCount().then(n => {
      updateStatCards(stats, n);
      renderLastWeekEvents(n);
      animateCounters('page-dashboard');
    }).catch(() => {});
    setTimeout(() => animateCounters('page-dashboard'), 80);
    return;
  }

  // First load — show loading state in stat cards
  const root = document.getElementById('page-dashboard');
  if (root) root.querySelectorAll('.sc-value').forEach(el => {
    el.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:14px"></i>';
  });

  Promise.all([ACS.loadAll(), ACS.fetchFaultCount().catch(() => 0)])
    .then(([devices, faultCount]) => {
      const stats = ACS.getStats();
      _DASH_STATS = stats;
      updateStatCards(stats, faultCount);
      initCharts(stats);
      renderRecentProvisions();
      renderLastWeekEvents(faultCount);
      renderDashboardExtras();
      setTimeout(() => animateCounters('page-dashboard'), 80);
    })
    .catch(err => {
      console.error('Dashboard load failed:', err);
      if (root) root.querySelectorAll('.sc-value').forEach(el => {
        el.innerHTML = '<span style="color:var(--red);font-size:13px">Error</span>';
      });
    });
}

// Register with navigation
PAGE_INIT['dashboard'] = initDashboard;
// Register what the header's Refresh/Export buttons do while on this page
PAGE_ACTIONS['dashboard'] = {
  refresh: refreshDashboard,
  export:  exportDashboardCSV,
  exportTitle: 'Export ringkasan dashboard (Excel)',
};
