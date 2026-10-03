/* ═══════════════════════════════════════════════════════════════
   Panel ACS — Devices Module
   (Real data from GenieACS via /api proxy, device table, search/filter)
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── RX Class Helper (badge classes for the device table) ───
// NOTE: device-detail.js has its own rxSvClass() — keep these names distinct
// so the later-loaded module does not override this one (global scope).
function rxClass(rx) {
  const v = parseFloat(rx);
  if (isNaN(v)) return 'rx-na';
  const t = ACS.rxThr();
  if (v >= t.good) return 'rx-excellent';
  if (v >= t.fair) return 'rx-fair';
  return 'rx-poor';
}

/* ═══════════════════════════════════════════════════════════════
   FILTER MODEL
   App.deviceFilters is the single source of truth for every filter
   dimension. Each dimension has one bucket function (device → bucket
   key). Filtering, facet counts and the chips all derive from these,
   so a new dimension only needs one entry in DIM_DEFS.

   The bucket rules MUST mirror ACS.getStats() exactly — that is what
   makes "click a dashboard slice → same count in the table" true.
   ═══════════════════════════════════════════════════════════════ */

// device → bucket key, per dimension. '' as a filter value means "Semua".
const DIM_DEFS = {
  // RX Power — same thresholds/order as getStats(): rxThr() good/fair.
  rx: {
    label: 'RX Power', icon: 'fa-signal',
    bucket: d => {
      const v = parseFloat(d.rx);
      if (isNaN(v)) return 'na';
      const t = ACS.rxThr();
      if (v >= t.good) return 'excellent';
      if (v >= t.fair) return 'fair';
      return 'poor';
    },
    // Static buckets — RX classes are fixed, not data-derived.
    opts: () => [
      { v: 'excellent', label: 'Excellent', color: '#22c55e' },
      { v: 'fair',      label: 'Fair',      color: '#f59e0b' },
      { v: 'poor',      label: 'Poor',      color: '#ef4444' },
      { v: 'na',        label: 'N/A',       color: '#94a3b8' },
    ],
  },
  // Product Class — buckets come from the live fleet (same key as stats.prodMap).
  model: {
    label: 'Product Class', icon: 'fa-layer-group',
    bucket: d => d.model || 'Unknown',
    opts: () => _optsFromData('model'),
  },
  // PON Mode — GPON/EPON/… whatever the ONUs actually report.
  pon: {
    label: 'PON Mode', icon: 'fa-network-wired',
    bucket: d => d.ponMode || 'Unknown',
    opts: () => _optsFromData('pon', {
      GPON: '#6366f1', EPON: '#22c55e', Ethernet: '#f59e0b', Unknown: '#94a3b8',
    }),
  },
  // Registered — mutually exclusive age buckets, identical to getStats().reg.
  reg: {
    label: 'ONU Registered', icon: 'fa-user-plus',
    bucket: d => {
      if (!d.registeredRaw) return 'older';
      const age = Date.now() - new Date(d.registeredRaw).getTime();
      const day = 86400000;
      if (age < day)      return 'today';
      if (age < 2 * day)  return 'yesterday';
      if (age < 7 * day)  return 'week';
      if (age < 30 * day) return 'month';
      return 'older';
    },
    opts: () => [
      { v: 'today',     label: 'Hari Ini', color: '#6366f1' },
      { v: 'yesterday', label: 'Kemarin',  color: '#22c55e' },
      { v: 'week',      label: '7 Hari',   color: '#3b82f6' },
      { v: 'month',     label: '1 Bulan',  color: '#f59e0b' },
      { v: 'older',     label: 'Lebih Lama', color: '#94a3b8' },
    ],
  },
  // Temperature — same cut-offs as getStats().temp (no reading → Normal).
  temp: {
    label: 'Temperature', icon: 'fa-thermometer-half',
    bucket: d => (d.temp > 55 ? 'hot' : d.temp > 45 ? 'warm' : 'normal'),
    opts: () => [
      { v: 'normal', label: 'Normal', color: '#22c55e', hint: '< 45°C' },
      { v: 'warm',   label: 'Warm',   color: '#f59e0b', hint: '45 – 55°C' },
      { v: 'hot',    label: 'Hot',    color: '#ef4444', hint: '> 55°C' },
    ],
  },
  // Tag panel (MITRA-SURYA, …; 2026-10-03). Satu ONU bisa memegang beberapa tag, jadi
  // dicocokkan lewat `cocok`, bukan satu bucket. Daftar & warna dari server (tag.py).
  tag: {
    label: 'Tag', icon: 'fa-tag',
    bucket: d => (_tagOnu(d.id)[0] || ''),
    cocok: (d, v) => _tagOnu(d.id).indexOf(v) !== -1,
    opts: () => ((App.tagPanel && App.tagPanel.tag) || []).map(t => ({ v: t.nama, label: t.nama, color: t.warna })),
  },
  // Status / Vendor live in the toolbar selects but share this same model,
  // so dashboard cross-navigation can set them the same way.
  status: {
    label: 'Status', icon: 'fa-circle',
    bucket: d => (d.online ? 'online' : 'offline'),
    opts: () => [
      { v: 'online',  label: 'Online',  color: '#22c55e' },
      { v: 'offline', label: 'Offline', color: '#ef4444' },
    ],
  },
  vendor: {
    label: 'Vendor', icon: 'fa-industry',
    bucket: d => (d.mfr || '—'),
    opts: () => _optsFromData('vendor'),
  },
};
const DIM_KEYS = Object.keys(DIM_DEFS);

// Build option list for a data-derived dimension: every bucket present in the
// fleet, most common first. New vendors/models/PON modes appear on their own.
function _optsFromData(dim, colorMap) {
  const fn = DIM_DEFS[dim].bucket;
  const m  = {};
  (App.devices || []).forEach(d => { const k = fn(d); m[k] = (m[k] || 0) + 1; });
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([v], i) => ({
      v, label: v,
      color: (colorMap && colorMap[v]) || PALETTE[i % PALETTE.length],
    }));
}

function _filters() {
  if (!App.deviceFilters) App.deviceFilters = {};
  return App.deviceFilters;
}
// Does device d satisfy dimension `dim`'s current filter? ('' = Semua → yes)
function _matchDim(d, dim, val) {
  if (!val) return true;
  const def = DIM_DEFS[dim];
  return def.cocok ? def.cocok(d, val) : def.bucket(d) === val;
}
function _matchSearch(d) {
  const q = (App.deviceSearch || '').trim().toLowerCase();
  if (!q) return true;
  return ['serial', 'model', 'tags', 'pppoe', 'ssid', 'ssid2', 'ssid3', 'odp']
    .some(k => String(d[k] || '').toLowerCase().includes(q))
    || _tagOnu(d.id).some(t => t.toLowerCase().includes(q))
    || _cocokMac(d, q);
}

/* Cari MAC Address (2026-10-03). "ec:6c:b5", "EC-6C-B5", dan "ec6cb5" dianggap sama:
   pemisah dibuang, lalu dicocokkan sebagai POTONGAN dari MAC PON maupun MAC PPPoE ONU —
   jadi cukup mengetik sebagian (awal, tengah, atau akhir). Minimal 4 digit heksa supaya
   "ab" tidak ikut mencocokkan separuh armada; teks yang memuat huruf di luar heksa
   (nama model, SSID) tidak diperlakukan sebagai MAC. */
function _cocokMac(d, q) {
  if (/[^0-9a-f:\-. ]/.test(q)) return false;
  const h = q.replace(/[^0-9a-f]/g, '');
  if (h.length < 4) return false;
  return [d.ponMac, d.pppoeMac].some(m =>
    m && m !== '—' && String(m).toLowerCase().replace(/[^0-9a-f]/g, '').includes(h));
}

// ─── Filter ───
function getFilteredDevices() {
  const f = _filters();
  return (App.devices || []).filter(d =>
    _matchSearch(d) && DIM_KEYS.every(k => _matchDim(d, k, f[k])));
}

// Faceted count: how many devices land in `val` once EVERY OTHER dimension's
// filter is applied — i.e. the number you'd get if you picked this option.
function _facetCount(dim, val) {
  const f = _filters();
  return (App.devices || []).filter(d =>
    _matchSearch(d) &&
    DIM_KEYS.every(k => k === dim || _matchDim(d, k, f[k])) &&
    _matchDim(d, dim, val)
  ).length;
}

// Set one dimension and re-render everything that depends on it.
function setDeviceFilter(dim, val) {
  if (!DIM_DEFS[dim]) return;
  _filters()[dim] = val || '';
  App.devicePage = 1;
  syncFilterSelects();
  renderFilterChips();
  renderDeviceTable();
  renderPagination();
}

function clearDeviceFilters() {
  DIM_KEYS.forEach(k => { _filters()[k] = ''; });
  App.devicePage = 1;
  syncFilterSelects();
  renderFilterChips();
  renderDeviceTable();
  renderPagination();
}

// Push filter state back into the two native selects (kept for Status/Vendor)
// so the visible dropdown label never disagrees with App.deviceFilters.
function syncFilterSelects() {
  const f = _filters();
  [['statusFilter', 'status'], ['vendorFilter', 'vendor'], ['tagFilter', 'tag']].forEach(([id, dim]) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    if (sel.value !== (f[dim] || '')) sel.value = f[dim] || '';
    if (typeof sel._cdropSync === 'function') sel._cdropSync();
  });
}

// ─── Render Table ───
function renderDeviceTable() {
  const tbody  = document.getElementById('deviceTableBody');
  const infoEl = document.getElementById('tblInfo');
  if (!tbody) return;
  const filtered = getFilteredDevices();
  const total    = filtered.length;
  const start    = (App.devicePage - 1) * App.devicePerPage;
  const page     = filtered.slice(start, start + App.devicePerPage);

  tbody.innerHTML = page.map((d, idx) => `
    <tr data-id="${escHtml(d.id)}" class="${_sel().has(d.id) ? 'row-sel' : ''}">
      <td class="col-sel"><input type="checkbox" class="row-cb" data-id="${escHtml(d.id)}"${_sel().has(d.id) ? ' checked' : ''}></td>
      <td class="col-sn sn-cell" title="Lihat informasi ONT" onclick="showOntInfo(this)"><span class="sn-link">${escHtml(d.serial)}</span></td>
      <td class="col-tags">${_tagSel(d)}</td>
      <td class="col-device">${escHtml(d.model)}</td>
      <td class="col-odp"><span style="font-size:12px;color:var(--primary)">${escHtml(d.odp)}</span></td>
      <td><span class="rx-badge ${rxClass(d.rx)}">${escHtml(d.rx)} dBm</span></td>
      <td><span class="status-dot ${d.online ? 'online' : 'offline'}">${d.online ? 'Online' : 'Offline'}</span></td>
      <td class="col-wan" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;font-size:12px">${escHtml(d.pppoe)}</td>
      <td class="col-wan" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;font-size:12px">${escHtml(d.ssid)}</td>
      <td class="col-wan" style="font-family:monospace;font-size:12px">${escHtml(d.ip)}</td>
      <td class="col-wan">${d.vlan ? `<span class="badge bg-blue" style="font-size:11px">${escHtml(d.vlan)}</span>` : '—'}</td>
      <td class="col-inform" style="font-size:12px;color:var(--text-muted)">${d.lastInform}</td>
      <td class="col-aktif" style="font-size:12px;font-weight:600;text-align:center">${d.online ? `<span style="color:var(--green)">${d.aktifDevice} device</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="col-actions">
        <div style="display:flex;gap:4px">
          <button class="act-btn act-view"    onclick="showDeviceDetail(this)" title="Detail"><i class="fas fa-eye"></i></button>
          <button class="act-btn act-refresh" onclick="refreshDeviceRow(this)" title="Refresh (Summon data dari ONU)"><i class="fas fa-rotate"></i></button>
          <button class="act-btn act-reboot"  onclick="rebootDeviceRow(this)" title="Reboot ONU"><i class="fas fa-power-off"></i></button>
          <button class="act-btn act-delete"  onclick="deleteDeviceRow(this)" title="Hapus dari GenieACS"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
  applyColumnVisibility();
  syncSelectionUI();

  if (infoEl) infoEl.textContent = `Showing ${start + 1}–${Math.min(start + App.devicePerPage, total)} of ${total.toLocaleString()} devices`;
}

// ─── Pagination ───
function renderPagination() {
  const el = document.getElementById('pagination');
  if (!el) return;
  const filtered   = getFilteredDevices();
  const totalPages = Math.ceil(filtered.length / App.devicePerPage);
  const cur        = App.devicePage;

  let html = `<button class="page-btn" onclick="goPage(${cur - 1})" ${cur === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>`;
  const pages = new Set([1, 2, cur - 1, cur, cur + 1, totalPages - 1, totalPages].filter(p => p >= 1 && p <= totalPages));
  let prev = 0;
  Array.from(pages).sort((a, b) => a - b).forEach(p => {
    if (prev && p - prev > 1) html += `<span class="page-ellipsis">...</span>`;
    html += `<button class="page-btn ${p === cur ? 'active' : ''}" onclick="goPage(${p})">${p}</button>`;
    prev = p;
  });
  html += `<button class="page-btn" onclick="goPage(${cur + 1})" ${cur === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
  el.innerHTML = html;
}

function goPage(p) {
  const filtered   = getFilteredDevices();
  const totalPages = Math.ceil(filtered.length / App.devicePerPage);
  if (p < 1 || p > totalPages) return;
  App.devicePage = p;
  renderDeviceTable();
  renderPagination();
}

// ─── Column Visibility ───
function applyColumnVisibility() {
  if (!App.hiddenCols) return;
  App.hiddenCols.forEach(col => {
    document.querySelectorAll(`.col-${col}`).forEach(el => el.classList.add('col-hidden'));
  });
}

// ─── Loading state helper ───
function showTableLoading(msg) {
  const tbody = document.getElementById('deviceTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;padding:40px;color:var(--text-muted)">
    <i class="fas fa-spinner fa-spin" style="font-size:24px;margin-bottom:8px"></i><br>${msg}</td></tr>`;
}

// Everything that must run once App.devices is populated (both the cached and
// the freshly-fetched path go through here, so they can never drift apart).
function _renderAfterLoad() {
  populateVendorFilter();
  populateTagFilter();
  syncFilterSelects();
  renderFilterChips();
  renderDeviceTable();
  renderPagination();
  updateSignalStats();
  updateDeviceCountBadge();
}

// ─── Device Table Init ───
function initDeviceTable() {
  App.devicePage    = 1;
  App.deviceSearch  = '';
  App.deviceFilters = {};
  DIM_KEYS.forEach(k => { App.deviceFilters[k] = ''; });
  App.hiddenCols    = new Set();
  // Re-entering the page always starts with nothing selected — a selection
  // carried over from a previous visit would act on rows the user can't see.
  App.selectMode    = false;
  _sel().clear();

  // A dashboard click (gotoDevicesFiltered) parks its selection here; consume
  // it now so it survives the reset above and lands on the freshly built page.
  if (App.pendingDeviceFilter) {
    Object.keys(App.pendingDeviceFilter).forEach(k => {
      if (DIM_DEFS[k]) App.deviceFilters[k] = App.pendingDeviceFilter[k] || '';
    });
    App.pendingDeviceFilter = null;
  }
  // Apply "Baris per Halaman" from Settings (falls back to 20)
  App.devicePerPage      = parseInt(ACS.getConfig().perPage, 10) || 20;

  // If data already loaded (from dashboard), render immediately
  if (App.devices && App.devices.length > 0) {
    _renderAfterLoad();
    return;
  }

  showTableLoading('Memuat data perangkat dari GenieACS...');

  ACS.loadAll()
    .then(_renderAfterLoad)
    .catch(err => {
      const tbody = document.getElementById('deviceTableBody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;padding:40px;color:var(--red)">
        <i class="fas fa-triangle-exclamation"></i> Gagal memuat data: ${err.message}</td></tr>`;
    });
}

/* ═══ TAG PANEL (2026-10-03) ═══════════════════════════════════════
   Label milik panel untuk memisahkan ONU mitra (MITRA-SURYA, MITRA-BAYU, …). Disimpan di
   basis data panel (backend/tag.py), BUKAN di _tags GenieACS: tidak ada yang terkirim ke
   ONU maupun ke GenieACS. Server yang menentukan wewenangnya (izin "buatTag"; hapus nama
   tag khusus administrator) — tombol di sini hanya disembunyikan sebagai kerapian. */
function _tagOnu(id) {
  const p = App.tagPanel && App.tagPanel.perangkat;
  return (p && p[id]) || [];
}

function _tagWarna(nama) {
  const t = ((App.tagPanel && App.tagPanel.tag) || []).find(x => x.nama === nama);
  return t && /^#[0-9a-fA-F]{6}$/.test(t.warna) ? t.warna : '#6366f1';
}

// Isi kolom Tags: tag panel berwarna di depan, tag GenieACS (redup) di belakangnya.
function _tagSel(d) {
  const panel = _tagOnu(d.id).map(n =>
    `<span class="tag-chip" style="--tc:${_tagWarna(n)}">${escHtml(n)}</span>`).join('');
  const genie = d.tags && d.tags !== '—' ? `<span class="tag-genie">${escHtml(d.tags)}</span>` : '';
  // Tombol atur: hanya bagi yang berizin (server tetap yang memutuskan), tampil saat
  // kursor di baris itu — di layar sentuh selalu tampil samar.
  const atur = (App.tagPanel && App.tagPanel.bisaBuat)
    ? '<button type="button" class="tag-atur" onclick="aturTagBaris(this)" title="Atur tag ONU ini"><i class="fas fa-tag"></i></button>' : '';
  return '<div class="tag-sel">' + ((panel + genie) || '<span class="tag-genie">—</span>') + atur + '</div>';
}

function muatTagPanel() {
  if (typeof authFetch !== 'function') return Promise.resolve();
  return authFetch('/config/tag').then(d => {
    App.tagPanel = d || null;
    const b = document.getElementById('bulkTag');
    if (b) b.hidden = !(d && d.bisaBuat);
    populateTagFilter();
    syncFilterSelects();
    renderFilterChips();
    renderDeviceTable();
    renderPagination();
  }).catch(() => { /* tag tak terbaca → daftar Device tetap jalan tanpa tag */ });
}

function populateTagFilter() {
  const sel = document.getElementById('tagFilter');
  if (!sel) return;
  const daftar = (App.tagPanel && App.tagPanel.tag) || [];
  sel.innerHTML = '<option value="">Semua Tag</option>' + daftar.map(t =>
    `<option value="${escHtml(t.nama)}" data-icon="fa-tag" data-dot="${_tagWarna(t.nama)}">${escHtml(t.nama)} (${t.jumlah})</option>`).join('');
  const want = _filters().tag || '';
  if (want && daftar.some(t => t.nama === want)) sel.value = want;
  else if (want) _filters().tag = '';
  sel.hidden = !daftar.length;
  const wrap = sel.closest('.cdrop');
  if (wrap) wrap.hidden = !daftar.length;
  if (typeof sel._cdropSync === 'function') sel._cdropSync();
}

/* Pop-up tag — satu tempat untuk mengisi, mengubah, dan menghapus tag (2026-10-03).
   Dibuka dari tiga pintu: bilah aksi massal (banyak ONU terpilih), tombol kecil di kolom
   Tags (muncul saat kursor di baris itu), dan tombol Tag di Detail ONU (satu ONU).
     Pasang / Lepas        : izin "buatTag"
     Buat tag baru         : izin "buatTag"
     Ubah nama/warna, Hapus: administrator (berdampak ke semua ONU ber-tag itu)
   ids  : larik deviceId; bukan larik (mis. Event dari tombol) → pakai pilihan di tabel.
   opsi : { judul, sesudah } — sesudah() dipanggil tiap kali data tag berubah. */
function bukaTagModal(ids, opsi) {
  if (!Array.isArray(ids)) ids = Array.from(_sel());
  opsi = opsi || {};
  const lama = document.getElementById('tagModal');
  if (lama) lama.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'tagModal';
  ov.innerHTML = '<div class="modal tag-modal" style="max-width:500px">'
    + '<div class="modal-header"><h3><i class="fas fa-tag"></i> <span id="tagJudul"></span></h3>'
    + '<button class="modal-close" data-act="tutup"><i class="fas fa-xmark"></i></button></div>'
    + '<div class="modal-body"><div class="tag-daftar" id="tagDaftar"></div>'
    + '<div class="tag-baru"><input class="form-input" id="tagNamaBaru" maxlength="32" placeholder="Tag baru, mis. MITRA-SURYA" autocomplete="off">'
    + '<button class="btn btn-primary" data-act="buat"><i class="fas fa-plus"></i> Buat &amp; pasang</button></div>'
    + '<p class="tag-catatan">Tag hanya tersimpan di panel ini — tidak ada yang dikirim ke ONU maupun GenieACS. '
    + 'Satu ONU boleh memegang beberapa tag.</p></div></div>';
  document.body.appendChild(ov);
  ov.querySelector('#tagJudul').textContent = opsi.judul
    || ('Tag untuk ' + ids.length.toLocaleString('id-ID') + ' ONU terpilih');
  let sunting = '';                       // nama tag yang sedang diubah (administrator)

  const gambar = () => {
    const box = ov.querySelector('#tagDaftar');
    const daftar = (App.tagPanel && App.tagPanel.tag) || [];
    if (!daftar.length) { box.innerHTML = '<div class="tag-kosong">Belum ada tag. Buat yang pertama di bawah.</div>'; return; }
    const kelola = !!(App.tagPanel && App.tagPanel.bisaHapus);
    box.innerHTML = daftar.map(t => {
      const n = escHtml(t.nama), w = _tagWarna(t.nama);
      if (sunting === t.nama) {
        return `<div class="tag-baris sunting"><input class="form-input tag-in-nama" maxlength="32" value="${n}" aria-label="Nama tag">`
          + `<input type="color" class="tag-in-warna" value="${w}" aria-label="Warna tag">`
          + `<button class="btn btn-primary btn-sm" data-act="simpanUbah" data-tag="${n}"><i class="fas fa-check"></i> Simpan</button>`
          + '<button class="btn btn-ghost btn-sm" data-act="batalUbah">Batal</button></div>';
      }
      const sudah = ids.filter(id => _tagOnu(id).indexOf(t.nama) !== -1).length;
      const ket = ids.length === 1 ? (sudah ? 'terpasang' : 'belum terpasang')
        : (t.jumlah + ' ONU' + (sudah ? ' · ' + sudah + ' terpilih sudah' : ''));
      return `<div class="tag-baris${sudah ? ' pasang' : ''}"><span class="tag-chip" style="--tc:${w}">${n}</span>`
        + `<span class="tag-jml">${ket}</span>`
        + `<button class="btn btn-ghost btn-sm" data-act="pasang" data-tag="${n}"${sudah === ids.length ? ' disabled' : ''}><i class="fas fa-plus"></i> Pasang</button>`
        + `<button class="btn btn-ghost btn-sm" data-act="lepas" data-tag="${n}"${sudah ? '' : ' disabled'}><i class="fas fa-minus"></i> Lepas</button>`
        + (kelola ? `<button class="btn btn-ghost btn-sm" data-act="ubah" data-tag="${n}" title="Ubah nama / warna tag"><i class="fas fa-pen"></i></button>`
                  + `<button class="btn btn-ghost btn-sm" data-act="hapus" data-tag="${n}" title="Hapus tag ini dari semua ONU"><i class="fas fa-trash"></i></button>` : '')
        + '</div>';
    }).join('');
  };
  const segarkan = () => muatTagPanel().then(() => { gambar(); if (opsi.sesudah) opsi.sesudah(); });
  const kirim = (url, body, pesan) => authFetch(url, { method: 'POST', body })
    .then(r => { showToast(pesan(r), 'success'); return segarkan(); })
    .catch(e => showToast(e.message, 'error'));

  ov.addEventListener('click', e => {
    if (e.target === ov) { ov.remove(); return; }
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act, nama = b.dataset.tag;
    if (act === 'tutup') ov.remove();
    if (act === 'pasang') kirim('/config/tag/pasang', { nama, perangkat: ids }, r => nama + ' dipasang pada ' + r.berubah + ' ONU');
    if (act === 'lepas') kirim('/config/tag/pasang', { nama, perangkat: ids, lepas: true }, r => nama + ' dilepas dari ' + r.berubah + ' ONU');
    if (act === 'ubah') { sunting = nama; gambar(); const i = ov.querySelector('.tag-in-nama'); if (i) i.focus(); }
    if (act === 'batalUbah') { sunting = ''; gambar(); }
    if (act === 'simpanUbah') {
      const baris = b.closest('.tag-baris');
      const body = { nama, namaBaru: baris.querySelector('.tag-in-nama').value, warna: baris.querySelector('.tag-in-warna').value };
      authFetch('/config/tag/ubah', { method: 'POST', body })
        .then(r => {
          // Filter yang sedang memakai nama lama ikut pindah ke nama barunya.
          if (_filters().tag === nama) _filters().tag = r.tag.nama;
          sunting = '';
          showToast('Tag ' + nama + (r.tag.nama !== nama ? ' diubah menjadi ' + r.tag.nama : ' diperbarui'), 'success');
          return segarkan();
        })
        .catch(err => showToast(err.message, 'error'));
    }
    if (act === 'hapus') showConfirm({
      title: 'Hapus tag ' + nama + '?', icon: 'fa-trash', danger: true, yesLabel: 'Hapus tag',
      message: '<p>Tag <b>' + escHtml(nama) + '</b> akan dihapus dari daftar dan dilepas dari <b>semua</b> ONU yang memakainya.</p>',
    }, () => kirim('/config/tag/hapus', { nama }, r => nama + ' dihapus (terlepas dari ' + r.terlepas + ' ONU)'));
    if (act === 'buat') {
      const inp = ov.querySelector('#tagNamaBaru');
      const baru = (inp.value || '').trim();
      if (!baru) { inp.focus(); return; }
      authFetch('/config/tag', { method: 'POST', body: { nama: baru } })
        .then(r => kirim('/config/tag/pasang', { nama: r.tag.nama, perangkat: ids },
                         x => r.tag.nama + ' dibuat & dipasang pada ' + x.berubah + ' ONU'))
        .then(() => { inp.value = ''; })
        .catch(e => showToast(e.message, 'error'));
    }
  });
  ov.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'tagNamaBaru') ov.querySelector('[data-act="buat"]').click();
    if (e.target.classList.contains('tag-in-nama')) ov.querySelector('[data-act="simpanUbah"]').click();
  });
  gambar();
}

// Tombol kecil di kolom Tags (tampil saat kursor di baris): atur tag ONU baris itu.
function aturTagBaris(el) {
  const d = _onuBaris(el);
  if (d) bukaTagModal([d.id], { judul: 'Tag ONU ' + (d.serial || d.id) });
}

// ─── Vendor filter — auto-populate from live device data ───
// Builds the <select> options from the unique manufacturers actually present,
// so new ONU vendors appear automatically as the fleet grows. The current
// selection is preserved across refreshes (reset only if that vendor is gone).
function populateVendorFilter() {
  const sel = document.getElementById('vendorFilter');
  if (!sel) return;
  const cur = sel.value;
  const vendors = Array.from(new Set(
    (App.devices || [])
      .map(d => (d.mfr || '').trim())
      .filter(v => v && v !== '—')
  )).sort((a, b) => a.localeCompare(b));

  sel.innerHTML = '<option value="">All Vendor</option>' +
    vendors.map(v => `<option value="${escHtml(v)}" data-icon="fa-microchip">${escHtml(v)}</option>`).join('');

  const want = _filters().vendor || cur;
  if (want && vendors.includes(want)) {
    sel.value = want;                // keep the active/selected vendor
  } else if (want) {
    _filters().vendor = '';          // chosen vendor disappeared → fall back to All
  }
  if (typeof sel._cdropSync === 'function') sel._cdropSync();  // refresh custom dropdown label
}

// ─── Signal stat cards (Excellent / Fair / Poor / Offline) from real data ───
function updateSignalStats() {
  const root = document.getElementById('page-devices');
  if (!root) return;
  const s = ACS.getStats();
  const set = (sel, val) => {
    const card = root.querySelector(sel);
    const el   = card && card.querySelector('[data-count]');
    if (el) el.dataset.count = val;
  };
  set('.sig-card.excellent',   s.rx.excellent);
  set('.sig-card.fair',        s.rx.fair);
  set('.sig-card.poor',        s.rx.poor);
  set('.sig-card.offline-sig', s.offline);
}

function updateDeviceCountBadge() {
  // Animate the signal stat counters (Excellent / Fair / Poor / Offline)
  const sc = document.querySelectorAll('#page-devices [data-count]');
  if (sc.length) animateCounters('page-devices');
}

/* ═══════════════════════════════════════════════════════════════
   POPOVER — one shared instance for the Filter and Kolom panels.
   Mounted on <body> with position:fixed so no ancestor's overflow can
   clip it, and only one can be open at a time (no stacking, no leaks:
   closing removes the node and every listener it registered).
   ═══════════════════════════════════════════════════════════════ */
const Pop = {
  el: null,
  anchor: null,

  open(anchor, html, wire) {
    Pop.close();
    const p = document.createElement('div');
    p.className = 'tb-pop';
    p.setAttribute('role', 'dialog');
    p.innerHTML = html;
    document.body.appendChild(p);
    Pop.el = p;
    Pop.anchor = anchor;
    anchor.classList.add('on');
    anchor.setAttribute('aria-expanded', 'true');
    Pop.place();
    // Next frame → the .open transition actually runs (element must paint first)
    requestAnimationFrame(() => p.classList.add('open'));
    if (wire) wire(p);
    document.addEventListener('mousedown', Pop._doc, true);
    document.addEventListener('keydown', Pop._key);
    window.addEventListener('resize', Pop.place);
    // capture:true → also follows scrolls of inner containers, keeping the
    // panel glued to its button instead of drifting away.
    window.addEventListener('scroll', Pop.place, true);
    const x = p.querySelector('.pop-x');
    if (x) x.addEventListener('click', Pop.close);
  },

  place() {
    const p = Pop.el, a = Pop.anchor;
    if (!p || !a) return;
    // Phone → bottom sheet: full width, no anchoring maths needed.
    if (window.matchMedia('(max-width: 640px)').matches) { p.classList.add('sheet'); return; }
    p.classList.remove('sheet');
    const r = a.getBoundingClientRect();
    const w = p.offsetWidth, h = p.offsetHeight;
    let left = r.left;
    let top  = r.bottom + 8;
    if (left + w > window.innerWidth - 10) left = Math.max(10, window.innerWidth - w - 10);
    // Not enough room below → flip above the button.
    if (top + h > window.innerHeight - 10 && r.top - h - 8 > 10) top = r.top - h - 8;
    p.style.left = left + 'px';
    p.style.top  = top + 'px';
  },

  close() {
    const p = Pop.el, a = Pop.anchor;
    Pop.el = null; Pop.anchor = null;
    document.removeEventListener('mousedown', Pop._doc, true);
    document.removeEventListener('keydown', Pop._key);
    window.removeEventListener('resize', Pop.place);
    window.removeEventListener('scroll', Pop.place, true);
    if (a) { a.classList.remove('on'); a.setAttribute('aria-expanded', 'false'); }
    if (p) {
      p.classList.remove('open');
      // Let the closing transition finish before the node goes away.
      setTimeout(() => p.remove(), 160);
    }
  },

  // Clicks on the anchor are ignored here so its own handler can toggle.
  _doc(e) {
    if (Pop.el && !Pop.el.contains(e.target) && Pop.anchor && !Pop.anchor.contains(e.target)) Pop.close();
  },
  _key(e) { if (e.key === 'Escape') Pop.close(); },
};

// Toggle helper: clicking the open panel's own button closes it.
function _popToggle(anchor, buildHTML, wire) {
  if (Pop.anchor === anchor) { Pop.close(); return; }
  Pop.open(anchor, buildHTML(), wire);
}

// ─── Filter panel ───
// Dimensions shown inside the popover (Status/Vendor keep their toolbar
// dropdowns, so they are deliberately not repeated here).
const POP_DIMS = ['tag', 'rx', 'model', 'pon', 'reg', 'temp'];

function _filterPanelHTML() {
  const f = _filters();
  const secs = POP_DIMS.map(dim => {
    const def  = DIM_DEFS[dim];
    const cur  = f[dim] || '';
    const opts = def.opts();
    const all  = `<button class="pf-opt${cur ? '' : ' active'}" type="button" data-dim="${dim}" data-v="" title="Semua ${escHtml(def.label)}">
        <span class="pf-l"><i class="fas fa-layer-group pf-ic"></i><span class="pf-tx">Semua</span></span>
        <span class="pf-n">${_facetCount(dim, '').toLocaleString('id-ID')}</span>
      </button>`;
    const rows = opts.map(o => {
      const n = _facetCount(dim, o.v);
      const tip = escHtml(o.label) + (o.hint ? ' (' + escHtml(o.hint) + ')' : '');
      return `<button class="pf-opt${cur === o.v ? ' active' : ''}${n ? '' : ' empty'}" type="button" data-dim="${dim}" data-v="${escHtml(o.v)}" title="${tip}">
        <span class="pf-l"><span class="pf-dot" style="background:${o.color}"></span><span class="pf-tx">${escHtml(o.label)}</span>${
          o.hint ? `<i class="pf-hint">${escHtml(o.hint)}</i>` : ''}</span>
        <span class="pf-n">${n.toLocaleString('id-ID')}</span>
      </button>`;
    }).join('');
    return `<section class="pf-sec">
      <div class="pf-title"><i class="fas ${def.icon}"></i>${escHtml(def.label)}</div>
      <div class="pf-opts">${all}${rows}</div>
    </section>`;
  }).join('');

  return `<div class="pop-head">
      <span class="pop-t"><i class="fas fa-filter"></i> Filter Perangkat</span>
      <button class="pop-x" type="button" title="Tutup"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="pop-body pf-grid">${secs}</div>
    <div class="pop-foot">
      <span class="pop-hint" id="pfHint"></span>
      <button class="btn btn-ghost btn-sm" type="button" id="pfReset"><i class="fas fa-rotate-left"></i> Reset</button>
    </div>`;
}

function _wireFilterPanel(p) {
  _refreshFilterPanel();
  p.addEventListener('click', e => {
    const opt = e.target.closest('.pf-opt');
    if (opt) {
      // Clicking the active option again clears that dimension → every row is
      // a toggle, so no dead-end state that needs a separate "Semua" trip.
      const cur = _filters()[opt.dataset.dim] || '';
      setDeviceFilter(opt.dataset.dim, cur === opt.dataset.v ? '' : opt.dataset.v);
      _refreshFilterPanel();
      return;
    }
    if (e.target.closest('#pfReset')) { clearDeviceFilters(); _refreshFilterPanel(); }
  });
}

// Update the open filter panel IN PLACE — selection, facet counts and hint.
// Deliberately no innerHTML rebuild: re-creating the nodes would replay every
// section's entrance animation on each click (they stack and flicker), and it
// would also drop the popover's scroll position.
function _refreshFilterPanel() {
  const p = Pop.el;
  if (!p) return;
  const f = _filters();
  p.querySelectorAll('.pf-opt').forEach(opt => {
    const dim = opt.dataset.dim;
    const val = opt.dataset.v;
    const n   = _facetCount(dim, val);
    opt.classList.toggle('active', (f[dim] || '') === val);
    opt.classList.toggle('empty', n === 0);
    const nEl = opt.querySelector('.pf-n');
    if (nEl) nEl.textContent = n.toLocaleString('id-ID');
  });
  const hint = p.querySelector('#pfHint');
  if (hint) hint.textContent = getFilteredDevices().length.toLocaleString('id-ID') + ' perangkat cocok';
}

// ─── Kolom (column visibility) panel ───
const COL_DEFS = [
  { col: 'sn',      icon: 'fa-fingerprint',    label: 'Serial Number' },
  { col: 'tags',    icon: 'fa-tags',           label: 'Tags' },
  { col: 'odp',     icon: 'fa-building',       label: 'ODP' },
  { col: 'device',  icon: 'fa-router',         label: 'Model' },
  { col: 'wan',     icon: 'fa-globe',          label: 'WAN (PPPoE/SSID/IP/VLAN)' },
  { col: 'inform',  icon: 'fa-clock',          label: 'Last Inform' },
  { col: 'aktif',   icon: 'fa-network-wired',  label: 'Aktif Device' },
  { col: 'actions', icon: 'fa-bolt',           label: 'Actions' },
];

function _colPanelHTML() {
  const hidden = App.hiddenCols || new Set();
  const rows = COL_DEFS.map(c => `
    <button class="pc-opt${hidden.has(c.col) ? '' : ' active'}" type="button" data-col="${c.col}">
      <i class="fas ${c.icon} pc-ic"></i>
      <span class="pc-l">${escHtml(c.label)}</span>
      <span class="pc-sw"><span class="pc-knob"></span></span>
    </button>`).join('');
  return `<div class="pop-head">
      <span class="pop-t"><i class="fas fa-table-columns"></i> Tampilkan Kolom</span>
      <button class="pop-x" type="button" title="Tutup"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="pop-body pc-list">${rows}</div>
    <div class="pop-foot">
      <span class="pop-hint">Kolom tersembunyi tidak ikut tampil di tabel</span>
      <button class="btn btn-ghost btn-sm" type="button" id="pcAll"><i class="fas fa-eye"></i> Tampilkan semua</button>
    </div>`;
}

function _setCol(col, show) {
  if (show) App.hiddenCols.delete(col); else App.hiddenCols.add(col);
  document.querySelectorAll(`.col-${col}`).forEach(el => el.classList.toggle('col-hidden', !show));
}

function _wireColPanel(p) {
  p.addEventListener('click', e => {
    const opt = e.target.closest('.pc-opt');
    if (opt) {
      // toggle() returns the state AFTER toggling → that is exactly "show".
      _setCol(opt.dataset.col, opt.classList.toggle('active'));
      return;
    }
    if (e.target.closest('#pcAll')) {
      COL_DEFS.forEach(c => _setCol(c.col, true));
      p.querySelectorAll('.pc-opt').forEach(o => o.classList.add('active'));
    }
  });
}

// ─── Active-filter chips (visible summary next to the toolbar buttons) ───
// Remembers which dim→value pairs are already on screen, so a re-render only
// animates what genuinely changed.
let _chipSeen = {};

function renderFilterChips() {
  const el = document.getElementById('filterChips');
  const badge = document.getElementById('filterCount');
  const f = _filters();
  const active = DIM_KEYS.filter(k => f[k]);

  if (badge) {
    badge.textContent = active.length;
    badge.hidden = active.length === 0;
  }
  if (!el) return;

  if (!active.length) { el.innerHTML = ''; _chipSeen = {}; return; }
  const labelOf = (dim, val) => {
    const o = DIM_DEFS[dim].opts().find(x => x.v === val);
    return o ? o.label : val;
  };
  // Only chips whose value actually changed animate in. Without this, editing
  // one filter would replay the pop-in on every chip already on screen.
  const seen = _chipSeen || {};
  el.innerHTML = active.map(dim => {
    const val   = String(f[dim]);
    const isNew = seen[dim] !== val;
    return `
    <button class="fchip${isNew ? ' fchip-new' : ''}" type="button" data-dim="${dim}" title="Hapus filter ${escHtml(DIM_DEFS[dim].label)}">
      <i class="fas ${DIM_DEFS[dim].icon}"></i>
      <span class="fchip-k">${escHtml(DIM_DEFS[dim].label)}</span>
      <span class="fchip-v">${escHtml(String(labelOf(dim, val)))}</span>
      <i class="fas fa-xmark fchip-x"></i>
    </button>`;
  }).join('')
    + (active.length > 1
        ? '<button class="fchip fchip-clear" type="button" data-dim="__all"><i class="fas fa-rotate-left"></i> Reset semua</button>'
        : '');

  _chipSeen = {};
  active.forEach(dim => { _chipSeen[dim] = String(f[dim]); });
}

/* ═══════════════════════════════════════════════════════════════
   BULK SELECTION & ACTIONS

   Selection is a Set of GenieACS device IDs — NOT row indexes — so it
   survives paging, filtering, sorting and a full data reload. Rows read
   their checked state back from the Set on every render.

   Blast radius is real here: this runs against ~1800 live customer ONUs.
   Guardrails, deliberately:
     • Reboot / Delete require typing a word to confirm (showConfirm.requireText)
     • The confirm states how many of the selected ONUs are ONLINE — i.e. how
       many live customers are actually affected
     • Work runs through _runBatch() with a small concurrency cap, so we never
       fire hundreds of requests at the ACS at once
   ═══════════════════════════════════════════════════════════════ */
function _sel() {
  if (!App.selectedDevices) App.selectedDevices = new Set();
  return App.selectedDevices;
}
// Selected devices that still exist in the current list, as device objects.
function _selDevices() {
  const s = _sel();
  return (App.devices || []).filter(d => s.has(d.id));
}

function setSelectMode(on) {
  App.selectMode = !!on;
  const btn = document.getElementById('btnSelect');
  if (btn) {
    btn.classList.toggle('on', App.selectMode);
    btn.setAttribute('aria-pressed', String(App.selectMode));
  }
  const page = document.getElementById('page-devices');
  if (page) page.classList.toggle('sel-mode', App.selectMode);
  // Leaving select mode drops the selection — a hidden selection that still
  // acts on things would be a nasty surprise.
  if (!App.selectMode) _sel().clear();
  syncSelectionUI();
}

// Reflect the Set into the bulk bar + the header checkbox. Called after every
// table render, so paging never leaves the UI disagreeing with the Set.
function syncSelectionUI() {
  const n = _sel().size;
  // Visibility follows the "Pilih" button alone: press it and the panel is
  // there (so the actions are discoverable before anything is ticked), press
  // it again and it is gone entirely — it never lingers on the page.
  const show = !!App.selectMode;
  const bar  = document.getElementById('bulkBar');
  if (bar) bar.hidden = !show;
  // The panel floats over the page; this reserves room so it never covers the
  // pagination underneath it.
  const page = document.getElementById('page-devices');
  if (page) page.classList.toggle('has-sel', show);

  const c = document.getElementById('bulkCount');
  if (c) c.textContent = n.toLocaleString('id-ID');

  const sub = document.getElementById('bulkSub');
  if (sub) {
    const on = _selDevices().filter(d => d.online).length;
    sub.textContent = n
      ? `${on.toLocaleString('id-ID')} online · ${(n - on).toLocaleString('id-ID')} offline`
      : 'Centang ONU pada tabel';
  }

  // Nothing ticked → the acting buttons are inert. Only "Semua" stays live,
  // since that is how you get from zero to a selection.
  const busy = !!App._bulkBusy;
  ['bulkNone', 'bulkRefresh', 'bulkReboot', 'bulkDelete', 'bulkTag'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = busy || n === 0;
  });
  const allBtn = document.getElementById('bulkAll');
  if (allBtn) allBtn.disabled = busy;

  // Header checkbox tracks only the rows currently on screen.
  const all = document.getElementById('selAllPage');
  if (all) {
    const rows = Array.from(document.querySelectorAll('#deviceTableBody .row-cb'));
    const sel  = rows.filter(cb => cb.checked).length;
    all.checked = rows.length > 0 && sel === rows.length;
    all.indeterminate = sel > 0 && sel < rows.length;
  }
}

function toggleRow(id, on) {
  if (on) _sel().add(id); else _sel().delete(id);
  const tr = document.querySelector(`#deviceTableBody .row-cb[data-id="${CSS.escape(id)}"]`);
  if (tr && tr.closest('tr')) tr.closest('tr').classList.toggle('row-sel', on);
  syncSelectionUI();
}

/* Run `fn` over `items` with at most `limit` in flight at a time.
   A plain Promise.all over 1800 ONUs would open 1800 sockets and bury the ACS;
   this keeps a steady, survivable trickle and reports progress as it goes. */
function _runBatch(items, fn, limit, onProgress) {
  limit = limit || 4;
  let i = 0, done = 0, ok = 0, failed = 0;
  const errors = [];
  return new Promise(resolve => {
    if (!items.length) { resolve({ ok: 0, failed: 0, errors }); return; }
    const next = () => {
      if (i >= items.length) {
        if (done === items.length) resolve({ ok, failed, errors });
        return;
      }
      const item = items[i++];
      Promise.resolve()
        .then(() => fn(item))
        .then(() => { ok++; })
        .catch(e => { failed++; errors.push({ item, error: e && e.message ? e.message : String(e) }); })
        .then(() => {
          done++;
          if (onProgress) onProgress(done, items.length);
          if (done === items.length) resolve({ ok, failed, errors });
          else next();
        });
    };
    for (let k = 0; k < Math.min(limit, items.length); k++) next();
  });
}

// Progress UI inside the bulk bar
function _bulkBusy(on, label) {
  App._bulkBusy = !!on;
  const bar = document.getElementById('bulkBar');
  if (bar) bar.classList.toggle('busy', !!on);
  const p = document.getElementById('bulkProgress');
  if (p) p.hidden = !on;
  const t = document.getElementById('bpText');
  if (t && label) t.textContent = label;
  // Button enablement depends on BOTH busy and the selection size, so it is
  // decided in one place only — re-enabling blindly here would light up the
  // action buttons again even with nothing selected.
  syncSelectionUI();
}
function _bulkProgress(done, total, verb) {
  const f = document.getElementById('bpFill');
  if (f) f.style.width = (total ? (done / total * 100) : 0).toFixed(1) + '%';
  const t = document.getElementById('bpText');
  if (t) t.textContent = `${verb} ${done}/${total}…`;
}

// Shared summary block for the confirm dialogs
function _bulkSummary(devs) {
  const on = devs.filter(d => d.online).length;
  const sample = devs.slice(0, 5).map(d => escHtml(d.serial || d.id)).join(', ');
  const more = devs.length > 5 ? ` <i>+${devs.length - 5} lainnya</i>` : '';
  return '<div style="margin-top:10px;padding:10px 12px;background:var(--surface2);border-radius:8px;font-size:12px;line-height:1.8">'
    + '<div><strong>Jumlah dipilih:</strong> ' + devs.length.toLocaleString('id-ID') + ' ONU</div>'
    + '<div><strong>Online:</strong> <span style="color:var(--green)">' + on.toLocaleString('id-ID') + '</span>'
    + ' &nbsp;<strong>Offline:</strong> <span style="color:var(--text-muted)">' + (devs.length - on).toLocaleString('id-ID') + '</span></div>'
    + '<div style="margin-top:4px;color:var(--text-muted)"><strong>Contoh:</strong> ' + sample + more + '</div>'
    + '</div>';
}

// ─── Bulk: Refresh (summon) ───
/* ─── Refresh massal ─────────────────────────────────────────────

   Ini tombol paling berbahaya di aplikasi. Dua orang bertabrakan pada satu ONU
   membuat ONU itu bekerja dua kali; SATU orang memilih 200 ONU lalu menekan
   tombol ini membuat 200 ONU bekerja sekaligus. Yang kedua jauh lebih merusak,
   dan sampai sekarang tidak ada yang menahannya: empat ONU sekaligus, tanpa
   masa istirahat, tanpa pemeriksaan duplikat.

   Tiga pembatas sekarang:
     1. Jumlah per aksi dibatasi, dengan sisanya dikatakan terus-terang.
     2. Model rapuh dikerjakan PALING AKHIR dan SATU PER SATU. ZL-2113X membalas
        ~450 ms per perintah dan pernah senyap total di tengah penyusuran pohon.
     3. ONU yang baru saja disegarkan akan DILEWATI oleh kunci di server
        (ops_lock.py), bukan dipaksa. Itu dilaporkan sebagai "dilewati", bukan
        "gagal" — karena memang bukan kegagalan.                              */
const MAKS_BULK_REFRESH = 50;

function bulkRefresh() {
  const dipilih = _selDevices();
  if (!dipilih.length) return;

  const rapuhDari = (d) => ((ACS && ACS.MODEL_RAPUH) || []).indexOf(d.model) >= 0;
  // Rapuh ditaruh di belakang: kalau terkena batas jumlah, yang terpotong
  // justru ONU yang paling tidak boleh dipaksa.
  const urut  = dipilih.filter(d => !rapuhDari(d)).concat(dipilih.filter(rapuhDari));
  const devs  = urut.slice(0, MAKS_BULK_REFRESH);
  const sisa  = dipilih.length - devs.length;
  const biasa = devs.filter(d => !rapuhDari(d));
  const rapuh = devs.filter(rapuhDari);

  showConfirm({
    title: 'Refresh ' + devs.length + ' ONU?',
    icon: 'fa-rotate',
    yesLabel: 'Refresh Sekarang',
    message: 'Permintaan <strong>connection-request + refresh</strong> akan dikirim ke setiap ONU terpilih '
      + 'untuk menarik data terbaru. Ini <strong>tidak mereboot</strong> dan tidak memutus koneksi pelanggan.'
      + (sisa > 0
          ? '<div style="margin-top:10px;padding:9px 11px;background:var(--amber-light);border-radius:8px;'
            + 'color:var(--text);font-size:12.5px"><i class="fas fa-triangle-exclamation"></i> '
            + '<strong>' + sisa.toLocaleString('id-ID') + ' ONU tidak ikut dikirim.</strong> '
            + 'Satu aksi dibatasi ' + MAKS_BULK_REFRESH + ' ONU agar tidak membebani armada sekaligus. '
            + 'Jalankan sisanya setelah yang ini selesai.</div>'
          : '')
      + (rapuh.length
          ? '<div style="margin-top:8px;color:var(--text-muted);font-size:12px">'
            + rapuh.length + ' ONU model rapuh dikerjakan paling akhir, satu per satu.</div>'
          : '')
      + '<div style="margin-top:8px;color:var(--text-muted);font-size:12px">'
      + 'ONU yang baru saja disegarkan akan dilewati — menyegarkan berulang tidak mempercepat ONU. '
      + 'ONU yang offline datanya tersegarkan saat inform berikutnya.</div>'
      + _bulkSummary(devs),
  }, () => {
    _bulkBusy(true);

    let dilewati = 0;
    const sebab = {};
    const kirim = async (d) => {
      try {
        const h = await ACS.summon(d.id, d.root, d.model);
        if (h && h.diikutkan) { dilewati++; sebab.ikut = (sebab.ikut || 0) + 1; }
      } catch (e) {
        // Penolakan kunci/istirahat/antrean: ONU sengaja tidak diganggu.
        if (e && e.pagar) {
          dilewati++;
          sebab[e.kode || 'ditolak'] = (sebab[e.kode || 'ditolak'] || 0) + 1;
          return;
        }
        throw e;                       // kegagalan sungguhan
      }
    };

    let total = 0;
    const maju = () => _bulkProgress(++total, devs.length, 'Mengirim refresh');

    // Concurrency 3 (dulu 4). Server membatasi 5 operasi serentak se-aplikasi,
    // jadi angka di atas itu hanya menghasilkan penolakan, bukan kecepatan.
    _runBatch(biasa, kirim, 3, maju)
      .then(r1 => _runBatch(rapuh, kirim, 1, maju).then(r2 => ({
        ok:     r1.ok + r2.ok - dilewati,
        failed: r1.failed + r2.failed,
      })))
      .then(r => {
        _bulkBusy(false);
        const rinci = Object.keys(sebab).length
          ? ' (' + Object.keys(sebab).map(k => sebab[k] + ' ' + _sebabLewat(k)).join(', ') + ')'
          : '';
        showToast(`Refresh: ${Math.max(0, r.ok)} terkirim, ${dilewati} dilewati${rinci}`
                  + (r.failed ? `, ${r.failed} gagal` : '')
                  + '. Data tersegarkan saat ONU inform.',
                  r.failed ? 'info' : 'success');
      });
  });
}

function _sebabLewat(kode) {
  return {
    istirahat: 'masih istirahat',
    sibuk:     'sedang dipakai',
    antre:     'antrean penuh',
    ikut:      'diikutkan ke pengguna lain',
  }[kode] || 'ditolak';
}

// ─── Bulk: Reboot ───
function bulkReboot() {
  const devs = _selDevices();
  if (!devs.length) return;
  const on = devs.filter(d => d.online).length;
  showConfirm({
    title: 'Reboot ' + devs.length + ' ONU sekaligus?',
    icon: 'fa-power-off',
    danger: true,
    requireText: 'REBOOT',
    yesLabel: 'Reboot ' + devs.length + ' ONU',
    message: '<div style="padding:10px 12px;background:var(--red-light);border-radius:8px;color:var(--red);font-weight:600">'
      + '<i class="fas fa-triangle-exclamation"></i> '
      + on.toLocaleString('id-ID') + ' ONU dalam keadaan ONLINE akan dimulai ulang.</div>'
      + '<div style="margin-top:10px">Setiap ONU akan <strong>restart</strong> dan '
      + '<strong>koneksi internet pelanggan terputus</strong> selama kurang-lebih 1–3 menit. '
      + 'Perintah yang sudah terkirim <strong>tidak dapat dibatalkan</strong>.</div>'
      + _bulkSummary(devs),
  }, () => {
    _bulkBusy(true);
    // Concurrency 3: reboots are the most disruptive action here — trickle them
    // so the whole selection never drops offline in the same instant.
    _runBatch(devs, d => ACS.rebootSmart(d), 3,
      (done, total) => _bulkProgress(done, total, 'Mengirim reboot'))
      .then(r => {
        _bulkBusy(false);
        showToast(`Perintah reboot: ${r.ok} terkirim, ${r.failed} gagal`, r.failed ? 'error' : 'success');
      });
  });
}

// ─── Bulk: Delete ───
function bulkDelete() {
  const devs = _selDevices();
  if (!devs.length) return;
  const on = devs.filter(d => d.online).length;
  showConfirm({
    title: 'Hapus ' + devs.length + ' perangkat dari GenieACS?',
    icon: 'fa-trash',
    danger: true,
    requireText: 'HAPUS',
    yesLabel: 'Hapus ' + devs.length + ' Perangkat',
    message: '<div style="padding:10px 12px;background:var(--red-light);border-radius:8px;color:var(--red);font-weight:600">'
      + '<i class="fas fa-triangle-exclamation"></i> Tindakan ini TIDAK DAPAT DIBATALKAN.</div>'
      + '<div style="margin-top:10px">Catatan ' + devs.length.toLocaleString('id-ID') + ' perangkat ini akan '
      + '<strong>dihapus permanen dari database GenieACS</strong>, termasuk '
      + '<strong>tags, ODP, dan seluruh riwayat parameternya</strong>. Data tersebut '
      + '<strong>tidak dapat dipulihkan</strong>.</div>'
      + '<div style="margin-top:8px">Yang <em>tidak</em> terjadi: perangkat fisik '
      + '<strong>tidak direset dan tidak direboot</strong> — hanya entri di server ACS yang dihapus.</div>'
      + (on > 0
          ? '<div style="margin-top:8px;padding:8px 12px;background:var(--amber-light);border-radius:8px;font-size:12px;color:var(--amber)">'
            + '<i class="fas fa-circle-info"></i> <strong>' + on.toLocaleString('id-ID') + ' di antaranya ONLINE</strong> — '
            + 'ONU yang masih hidup akan mendaftar ulang otomatis saat inform berikutnya, '
            + 'tetapi <strong>tags dan ODP-nya hilang</strong> dan harus diisi ulang.</div>'
          : '')
      + _bulkSummary(devs),
  }, () => {
    _bulkBusy(true);
    const gone = [];
    _runBatch(devs, d => ACS.deleteDevice(d.id).then(() => gone.push(d.id)), 6,
      (done, total) => _bulkProgress(done, total, 'Menghapus'))
      .then(r => {
        // Drop only the ones the server actually confirmed deleted.
        const s = new Set(gone);
        App.devices    = (App.devices || []).filter(d => !s.has(d.id));
        App.rawDevices = (App.rawDevices || []).filter(x => !s.has(x && x._id));
        gone.forEach(id => _sel().delete(id));
        _bulkBusy(false);
        _renderAfterLoad();
        showToast(`Dihapus: ${r.ok} berhasil, ${r.failed} gagal`, r.failed ? 'error' : 'success');
      });
  });
}

function initSelection() {
  // State was already reset by initDeviceTable(); this just applies it to the
  // freshly injected DOM and wires the listeners.
  setSelectMode(false);

  const btn = document.getElementById('btnSelect');
  if (btn) btn.addEventListener('click', () => setSelectMode(!App.selectMode));

  // Row checkboxes — delegated, so re-rendered rows keep working
  const tbody = document.getElementById('deviceTableBody');
  if (tbody) tbody.addEventListener('change', e => {
    const cb = e.target.closest('.row-cb');
    if (cb) toggleRow(cb.dataset.id, cb.checked);
  });

  const all = document.getElementById('selAllPage');
  if (all) all.addEventListener('change', () => {
    document.querySelectorAll('#deviceTableBody .row-cb').forEach(cb => {
      cb.checked = all.checked;
      if (all.checked) _sel().add(cb.dataset.id); else _sel().delete(cb.dataset.id);
      const tr = cb.closest('tr');
      if (tr) tr.classList.toggle('row-sel', all.checked);
    });
    syncSelectionUI();
  });

  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
  on('bulkAll', () => {
    // Everything matching the current filter — not just this page.
    getFilteredDevices().forEach(d => _sel().add(d.id));
    renderDeviceTable();
  });
  on('bulkNone', () => { _sel().clear(); renderDeviceTable(); });
  on('bulkRefresh', bulkRefresh);
  on('bulkReboot',  bulkReboot);
  on('bulkDelete',  bulkDelete);
  on('bulkTag',     bukaTagModal);
}

// ─── Cross-navigation: dashboard → devices with a filter pre-selected ───
// Parks the selection on App and navigates; initDeviceTable() consumes it
// after its own reset, so the table lands already filtered.
function gotoDevicesFiltered(patch) {
  App.pendingDeviceFilter = patch || {};
  navigateTo('devices');
}

// ─── Search & Filter ───
function initSearch() {
  const searchEl = document.getElementById('deviceSearch');
  const statusEl = document.getElementById('statusFilter');
  const vendorEl = document.getElementById('vendorFilter');

  // Toolbar popovers
  const fBtn = document.getElementById('btnFilter');
  if (fBtn) fBtn.addEventListener('click', () => _popToggle(fBtn, _filterPanelHTML, _wireFilterPanel));
  const cBtn = document.getElementById('btnCols');
  if (cBtn) cBtn.addEventListener('click', () => _popToggle(cBtn, _colPanelHTML, _wireColPanel));

  // Chips — click removes that dimension (or resets everything)
  const chips = document.getElementById('filterChips');
  if (chips) chips.addEventListener('click', e => {
    const c = e.target.closest('.fchip');
    if (!c) return;
    if (c.dataset.dim === '__all') clearDeviceFilters();
    else setDeviceFilter(c.dataset.dim, '');
  });

  // Signal stat cards double as filters (Excellent/Fair/Poor → RX, Offline → Status)
  const sigMap = [
    ['.sig-card.excellent',   'rx',     'excellent'],
    ['.sig-card.fair',        'rx',     'fair'],
    ['.sig-card.poor',        'rx',     'poor'],
    ['.sig-card.offline-sig', 'status', 'offline'],
  ];
  sigMap.forEach(([sel, dim, val]) => {
    const card = document.querySelector(sel);
    if (!card) return;
    card.classList.add('sig-click');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.title = 'Filter: ' + DIM_DEFS[dim].label + ' = ' + val;
    // Clicking the already-active card clears it → the card is a toggle.
    const go = () => setDeviceFilter(dim, _filters()[dim] === val ? '' : val);
    card.addEventListener('click', go);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });

  if (searchEl) searchEl.addEventListener('input', () => {
    App.deviceSearch = searchEl.value;
    App.devicePage   = 1;
    renderDeviceTable();
    renderPagination();
  });
  // Status/Vendor keep their toolbar dropdowns but write into the same model,
  // so chips, facet counts and the table all stay in agreement.
  if (statusEl) statusEl.addEventListener('change', () => setDeviceFilter('status', statusEl.value));
  if (vendorEl) vendorEl.addEventListener('change', () => setDeviceFilter('vendor', vendorEl.value));
  const tagEl = document.getElementById('tagFilter');
  if (tagEl) tagEl.addEventListener('change', () => setDeviceFilter('tag', tagEl.value));
}

// ─── Device Detail — navigate to full page ───
function showDeviceDetail(el) {
  const d = _onuBaris(el);
  if (!d) return;

  // Halaman digambar seketika dengan data ringkas dari daftar, lalu dilengkapi dokumen
  // penuh — lihat bukaDetailPerangkat() di main.js (satu pintu untuk semua jalan masuk).
  bukaDetailPerangkat(d.id, d);
}

// (_fmtUptime versi berkas ini dihapus 2026-10-03: device-detail.js — yang dimuat
// belakangan — mendefinisikan fungsi global bernama sama, jadi yang di sini tak pernah
// terpanggil. Pemanggil di berkas ini memang selalu mendapat versi device-detail.js.)

// ─── Poll a device until its _lastInform changes (after summon/reboot) ───
/* ─── Foto ONU, dipetakan dari Manufacturer + Product Class ───
   MENGUBAH/MENAMBAH: taruh berkas di /pages/gambar/ lalu sunting ONT_PHOTO_RULES.

   KENAPA butuh Manufacturer, bukan model saja:
     Model 'GM220-S' dipakai DUA vendor berbeda — CIOT dan ZICG — tapi gambarnya
     BEDA (CIOT→GM220-S.png, ZICG→Trikom F609.png). Peta berbasis model saja
     tak mungkin membedakan keduanya. Karena itu resolusi kini melihat mfr.

   CARA aturan dicocokkan (BERURUTAN, yang pertama cocok menang):
     • sebuah aturan cocok bila SEMUA field yang ia tentukan cocok (tanpa peduli
       huruf besar-kecil). Field yang dikosongkan = joker (cocok apa saja).
     • karena itu taruh aturan spesifik-model di ATAS, aturan selumbar-vendor di
       BAWAH — supaya model yang butuh gambar khusus menang sebelum jatuh ke
       gambar default vendornya.

   KENAPA daftar eksplisit, bukan menebak URL dari nama:
     • Fleet melaporkan 'F663NV3A' DAN 'F663NV3a' untuk model yang sama; server
       Linux case-sensitive, jadi tebakan langsung meleset untuk salah satunya.
     • server.py mengirim index.html (200) untuk berkas tak ada, BUKAN 404 —
       menebak URL berarti mengunduh HTML sia-sia tiap kartu dibuka. */
const ONT_PHOTO_RULES = [
  // ── ZTE/ZTEG: satu vendor, banyak model, gambar berbeda → dibedakan per MODEL.
  { model: 'F663NV9',      file: 'F663NV9.PNG'      },
  { model: 'F663NV3A',     file: 'F663NV3A.png'     },  // termasuk ejaan 'F663NV3a'
  { model: 'F663NV3a-XPON', file: 'F663NV3A.png'    },  // varian XPON, casing sama (2026-10-03)
  { model: 'F670L',        file: 'F670L.png'        },
  { model: 'F679L',        file: 'F670L.png'        },
  { model: 'F6600P',       file: 'F6600P.png'       },
  // F463N & F609 (ZTE): casing-nya sama dengan Trikom F609 (permintaan operator 2026-10-03).
  { model: 'F463N',        file: 'Trikom F609.png'  },
  { model: 'F609',         file: 'Trikom F609.png'  },
  // ── Huawei: HG8245A khas Huawei, cukup dari model (Manufacturer-nya berupa
  //    teks panjang 'Huawei Technologies Co., Ltd', tak enak dicocokkan).
  { model: 'HG8245A',      file: 'HG8245A.png'      },
  { model: 'HG8245W5-6T',  file: 'HG8245W5-6T.png'  },
  // ── HWTC
  { model: 'ZL-2113X',     file: 'ZL-2113X.png'     },
  { model: 'ZL-4224X',     file: 'ZL-4224X.png'     },
  // ── C-DATA (CDTC) — sudah ada sebelumnya, dipertahankan.
  { model: 'FD512XW-R460', file: 'FD512XW-R460.png' },
  { model: 'FD514GD-R460', file: 'FD514GD-R460.png' },
  // ── Selumbar-vendor (semua model vendor ini satu gambar). WAJIB di bawah
  //    aturan-model di atas: mis. ZICG GM220-S harus jatuh ke sini, BUKAN ke
  //    gambar model GM220-S milik CIOT.
  { mfr: 'CIOT',           file: 'GM220-S.png'      },  // GM220-S & MQ220
  { mfr: 'ETCH',           file: 'F9V.png'          },
  { mfr: 'FOTC',           file: 'F9V.png'          },
  { mfr: 'ZICG',           file: 'Trikom F609.png'  },  // GM220-S & F650
  { mfr: 'TRKG',           file: 'Trikom F609.png'  },  // 'Trikom F609'
];

// Semua berkas unik yang dirujuk — dipakai uji "berkas benar-benar ada di disk".
const ONT_PHOTOS = ONT_PHOTO_RULES.reduce(
  (a, r) => (a.includes(r.file) ? a : a.concat(r.file)), []);

function ontPhotoUrl(model, mfr) {
  const m = String(model || '').trim().toUpperCase();
  const v = String(mfr   || '').trim().toUpperCase();
  for (const r of ONT_PHOTO_RULES) {
    if (r.model && r.model.toUpperCase() !== m) continue;
    if (r.mfr   && r.mfr.toUpperCase()   !== v) continue;
    if (r.model || r.mfr)                              // jangan pernah cocok tanpa syarat
      return '/pages/gambar/' + encodeURIComponent(r.file);
  }
  return null;
}

/* ─── ONU milik sebuah baris: dicari lewat ID di barisnya, BUKAN nomor urut (2026-10-03) ───
   Dulu tombol baris membawa nomor urut hasil filter (`refreshDeviceRow(17, this)`) dan
   mencarinya ulang saat diklik. Itu benar selama tabel selalu digambar ulang tiap daftar
   berubah — tetapi satu jalur yang lupa menggambar ulang berarti perintah (reboot!) jatuh
   ke ONU lain. Baris kini membawa data-id perangkatnya sendiri; apa pun urutan/isi daftar
   saat itu, yang diperintah PASTI ONU yang tertulis di baris yang diklik. */
function _onuBaris(el) {
  const tr = el && el.closest ? el.closest('tr[data-id]') : null;
  return tr ? (App.devices || []).find(x => x.id === tr.dataset.id) || null : null;
}

/* ─── Klik Serial Number → Laporan Kondisi Perangkat (2026-10-03) ───
   Dulu membuka modal kecil "Informasi ONT" dengan isi sendiri. Kini isinya SAMA dengan
   tombol Laporan di Detail ONU (_lapBukaPerangkat di device-detail.js): foto, RX, suhu,
   IP PPPoE, uptime, SN, MAC, WiFi & perangkat terhubung — dari data TERAKHIR di basis data
   GenieACS (satu GET). Tidak ada perintah ke ONU; data segar hanya lewat tombol Refresh.
   Modal lama, _ontPhoto, dan _uptimeText dibuang bersama modalnya. */
function showOntInfo(el) {
  const d = _onuBaris(el);
  if (d) _lapBukaPerangkat(d.id);
}

/* ─── Satu jalan untuk perintah per-baris (Refresh & Reboot) ───
   Pesan mengikuti permintaan operator 2026-10-03:
     selama berjalan → "Dalam proses refresh/reboot ONU SN: …" (kotak proses kanan bawah)
     ONU menjalankan → "Perintah … berhasil dikirimkan ke ONU SN: …"   (hijau)
     fault / ditolak → "Perintah … gagal — ONU SN: …"                  (merah)
     belum membalas  → perintah masih di antrean GenieACS (biru; BUKAN gagal, dan sengaja
                       tidak mengajak klik ulang — itu hanya menumpuk task).
   Yang ditunggu adalah NASIB task (ACS.tungguTask), bukan perubahan _lastInform: lihat
   catatan di api.js. Semua penantian murni GET. */
async function _aksiOnu(d, jenis, btn, kirim, sesudah) {
  const sn = d.serial || d.id;
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
  const proses = tampilProses('Dalam proses ' + jenis + ' ONU SN: ' + sn + '…');
  try {
    const h = await kirim();
    const r = await ACS.tungguTask(d.id, h,
      sisa => proses.ubah('Dalam proses ' + jenis + ' ONU SN: ' + sn + '… ' + sisa + ' dtk'));
    if (r.state === 'selesai') {
      if (sesudah) await sesudah();
      proses.selesai('Perintah ' + jenis + ' berhasil dikirimkan ke ONU SN: ' + sn, 'success');
    } else if (r.state === 'gagal') {
      proses.selesai('Perintah ' + jenis + ' gagal — ONU SN: ' + sn + (r.pesan ? ' (' + r.pesan + ')' : ''), 'error');
    } else {
      proses.selesai('Perintah ' + jenis + ' untuk ONU SN: ' + sn + ' masih di antrean — ONU belum merespons', 'info');
    }
  } catch (e) {
    // Masa istirahat / ONU sedang dipakai orang lain bukan kegagalan — pesannya sudah
    // menjelaskan sebabnya, jangan ditimpa kata "gagal".
    if (e && e.pagar) proses.selesai(e.message, 'info');
    else proses.selesai('Perintah ' + jenis + ' gagal — ONU SN: ' + sn + ' (' + ((e && e.message) || 'galat') + ')', 'error');
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// ─── Action: Refresh / Summon one ONU (fetch fresh data) ───
function refreshDeviceRow(btn) {
  const d = _onuBaris(btn);
  if (!d) return;
  let sebelum = '';
  _aksiOnu(d, 'refresh', btn,
    async () => {
      sebelum = await ACS.lastInform(d.id).catch(() => '');
      return ACS.summon(d.id, d.root, d.model);
    },
    async () => {
      const baru = await ACS.muatSesudah(d.id, sebelum);
      const i = (App.devices || []).findIndex(x => x.id === d.id);
      if (i >= 0) App.devices[i] = baru;
      renderDeviceTable();
      renderPagination();
      updateSignalStats();
      updateDeviceCountBadge();
      const tr = document.querySelector('#deviceTableBody tr[data-id="' + CSS.escape(d.id) + '"]');
      if (tr) tr.classList.add('row-segar');
    });
}

// ─── Action: Reboot one ONU (confirm → vendor-aware reboot) ───
function rebootDeviceRow(btn) {
  const d = _onuBaris(btn);
  if (!d) return;
  const info =
    '<div style="margin-top:10px;padding:10px 12px;background:var(--surface2);border-radius:8px;font-size:12px;line-height:1.8">'
    + '<div><strong>Serial:</strong> ' + escHtml(d.serial) + '</div>'
    + '<div><strong>Model:</strong> '  + escHtml(d.model)  + '</div>'
    + '<div><strong>PPPoE:</strong> '  + escHtml(d.pppoe || '—') + '</div>'
    + '<div><strong>Status:</strong> ' + (d.online ? 'Online' : 'Offline') + '</div>'
    + '</div>';
  showConfirm({
    title:    'Apakah Anda yakin reboot ONU ini?',
    icon:     'fa-power-off',
    danger:   true,
    yesLabel: 'Reboot ONU',
    noLabel:  'Batal',
    message:  'Perangkat akan dimulai ulang dan koneksi internet terputus sementara.' + info,
  }, () => _aksiOnu(d, 'reboot', btn, () => ACS.rebootSmart(d)));
}

// ─── Action: Delete one device from GenieACS (stale/offline cleanup) ───
// Removes the device RECORD from GenieACS. Does NOT reboot/reset the ONU —
// only clears the entry. A live ONU that informs again re-registers itself.
function deleteDeviceRow(btn) {
  const d = _onuBaris(btn);
  if (!d) return;
  const info =
    '<div style="margin-top:10px;padding:10px 12px;background:var(--surface2);border-radius:8px;font-size:12px;line-height:1.8">'
    + '<div><strong>Serial:</strong> ' + escHtml(d.serial) + '</div>'
    + '<div><strong>Model:</strong> '  + escHtml(d.model)  + '</div>'
    + '<div><strong>PPPoE:</strong> '  + escHtml(d.pppoe || '—') + '</div>'
    + '<div><strong>Status:</strong> ' + (d.online
        ? '<span style="color:var(--green)">Online</span>'
        : '<span style="color:var(--text-muted)">Offline</span>') + '</div>'
    + '</div>';
  const warn = d.online
    ? '<div style="margin-top:10px;padding:8px 12px;background:rgba(245,158,11,.12);'
      + 'border-radius:8px;font-size:12px;color:var(--amber,#f59e0b)">'
      + '<i class="fas fa-triangle-exclamation"></i> Perangkat ini <strong>ONLINE</strong> — '
      + 'jika masih aktif, ia akan mendaftar ulang otomatis saat inform berikutnya.</div>'
    : '';
  showConfirm({
    title:    'Hapus perangkat dari GenieACS?',
    icon:     'fa-trash',
    danger:   true,
    yesLabel: 'Hapus Perangkat',
    noLabel:  'Batal',
    message:  'Catatan perangkat ini akan <strong>dihapus dari GenieACS</strong>. '
            + 'Tindakan ini <strong>tidak mereset/reboot ONU</strong> — hanya menghapus '
            + 'entrinya di server ACS.' + info + warn,
  }, () => {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    ACS.deleteDevice(d.id)
      .then(() => {
        const i = (App.devices || []).findIndex(x => x.id === d.id);
        if (i >= 0) App.devices.splice(i, 1);
        const j = (App.rawDevices || []).findIndex(x => (x && x._id) === d.id);
        if (j >= 0) App.rawDevices.splice(j, 1);
        renderDeviceTable();
        renderPagination();
        updateSignalStats();
        updateDeviceCountBadge();
        showToast('Perangkat ' + (d.serial || '') + ' dihapus dari GenieACS', 'success');
      })
      .catch(e => {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash"></i>'; }
        showToast('Gagal menghapus: ' + (e.message || 'Error'), 'error');
      });
  });
}

// ─── Custom Dropdown — replaces the native <select> popup with a styled menu ───
// The native <select> is kept (hidden) so existing change-listeners and
// populateVendorFilter() keep working; we just sync value + dispatch 'change'.
function enhanceSelect(select) {
  if (!select || select.dataset.enhanced) return;
  select.dataset.enhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'cdrop';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);                       // move native select inside

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'cdrop-toggle';
  const menu = document.createElement('div');
  menu.className = 'cdrop-menu';
  wrap.appendChild(toggle);
  wrap.appendChild(menu);

  const triggerIcon = select.dataset.icon || '';

  const optHTML = (o) => {
    const ic  = o.dataset.icon || '';
    const dot = o.dataset.dot || '';
    const iconHtml = ic
      ? `<i class="fas ${ic} cdrop-ic"${dot ? ` style="color:${dot}"` : ''}></i>`
      : '';
    return `${iconHtml}<span class="cdrop-txt">${escHtml(o.textContent)}</span>`;
  };

  function syncLabel() {
    const o = select.options[select.selectedIndex] || select.options[0];
    const ti = triggerIcon ? `<i class="fas ${triggerIcon} cdrop-ic"></i>` : '';
    toggle.innerHTML = `${ti}<span class="cdrop-txt">${escHtml(o ? o.textContent : '')}</span>`
      + `<i class="fas fa-chevron-down cdrop-caret"></i>`;
  }
  function buildMenu() {
    menu.innerHTML = Array.from(select.options).map((o, i) =>
      `<div class="cdrop-opt${i === select.selectedIndex ? ' active' : ''}" data-i="${i}">
         <span class="cdrop-opt-l">${optHTML(o)}</span>
         <i class="fas fa-check cdrop-check"></i>
       </div>`).join('');
  }
  function open()  { buildMenu(); wrap.classList.add('open');
                     document.addEventListener('mousedown', onDoc, true);
                     document.addEventListener('keydown', onKey); }
  function close() { wrap.classList.remove('open');
                     document.removeEventListener('mousedown', onDoc, true);
                     document.removeEventListener('keydown', onKey); }
  function onDoc(e){ if (!wrap.contains(e.target)) close(); }
  function onKey(e){ if (e.key === 'Escape') close(); }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.contains('open') ? close() : open();
  });
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.cdrop-opt');
    if (!opt) return;
    select.selectedIndex = parseInt(opt.dataset.i, 10);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncLabel();
    close();
  });

  select._cdropSync = syncLabel;
  syncLabel();
}

function enhanceFilters() {
  ['statusFilter', 'vendorFilter', 'tagFilter'].forEach(id => enhanceSelect(document.getElementById(id)));
}

/* ─── Header action: reload the device list from GenieACS ───
   Read-only (NBI GET only) — unlike the per-row Refresh button, this queues NO
   task on any ONU, so it cannot disturb a live customer. Filters and search are
   intentionally preserved; only the data underneath is replaced. */
function refreshDevices(btn) {
  setBtnBusy(btn, true);
  ACS.loadAll()
    .then(() => {
      _renderAfterLoad();
      if (typeof showToast === 'function') {
        showToast('Data perangkat diperbarui (' + (App.devices || []).length.toLocaleString('id-ID') + ' ONU)', 'success');
      }
    })
    .catch(err => {
      console.error('Devices refresh failed:', err);
      if (typeof showToast === 'function') showToast('Gagal memuat data: ' + (err.message || 'Error'), 'error');
    })
    .finally(() => setBtnBusy(btn, false));
}

/* ─── Header action: export the device TABLE ───
   Exports exactly what the user is looking at — the filtered/searched rows, in
   the table's column order — and records the active filters in the header so
   the file explains its own scope. */
function exportDevicesCSV(btn) {
  const devs = getFilteredDevices();
  if (!devs.length) {
    if (typeof showToast === 'function') showToast('Tidak ada perangkat pada filter ini', 'info');
    return;
  }
  const f = _filters();
  const activeDims = DIM_KEYS.filter(k => f[k]);
  const labelOf = (dim, val) => {
    const o = DIM_DEFS[dim].opts().find(x => x.v === val);
    return o ? o.label : val;
  };

  const rows = [];
  rows.push(['SKY ACS — Daftar Perangkat ONU']);
  rows.push(['Dibuat', new Date().toLocaleString('id-ID')]);
  rows.push(['Filter aktif', activeDims.length
    ? activeDims.map(k => DIM_DEFS[k].label + ': ' + labelOf(k, f[k])).join(' | ')
    : 'Tidak ada (seluruh perangkat)']);
  rows.push(['Pencarian', App.deviceSearch || '—']);
  rows.push(['Jumlah baris', devs.length + ' dari ' + (App.devices || []).length + ' ONU']);
  rows.push([]);
  rows.push(['Serial Number', 'Tags', 'Model', 'Vendor', 'ODP', 'RX Power (dBm)',
             'Kategori RX', 'Status', 'PON Mode', 'Suhu (°C)', 'PPPoE User',
             'SSID', 'WAN IP', 'VLAN', 'Last Inform', 'Registered', 'Aktif Device']);

  const rxLabel = { excellent: 'Excellent', fair: 'Fair', poor: 'Poor', na: 'N/A' };
  devs.forEach(d => rows.push([
    d.serial, d.tags, d.model, d.mfr, d.odp,
    d.rx, rxLabel[DIM_DEFS.rx.bucket(d)] || '—',
    d.online ? 'Online' : 'Offline',
    d.ponMode, (d.temp === '' || d.temp == null) ? '—' : d.temp,
    d.pppoe, d.ssid, d.ip, d.vlan,
    d.lastInform, d.registered,
    d.online ? d.aktifDevice : '—',
  ]));

  downloadCSV('sky-acs-perangkat_' + exportStamp() + '.csv', rows);
  if (typeof showToast === 'function') showToast('Ekspor ' + devs.length + ' perangkat', 'success');
}

// ─── Devices Entry Point ───
function initDevices() {
  initDeviceTable();
  initSearch();
  initSelection();
  enhanceFilters();
  muatTagPanel();
}

// Register with navigation
PAGE_INIT['devices'] = initDevices;
// Register what the header's Refresh/Export buttons do while on this page
PAGE_ACTIONS['devices'] = {
  refresh: refreshDevices,
  export:  exportDevicesCSV,
  exportTitle: 'Export daftar perangkat sesuai filter (Excel)',
};
