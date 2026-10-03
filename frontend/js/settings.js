/* ═══════════════════════════════════════════════════════════════
   Panel ACS — Settings Module
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── Config helpers ───────────────────────────────────────────────
function _cfgLoad() {
  try { return JSON.parse(localStorage.getItem('acsConfig') || '{}'); } catch { return {}; }
}
function _cfgSave(patch) {
  const merged = { ..._cfgLoad(), ...patch };
  localStorage.setItem('acsConfig', JSON.stringify(merged));
  return merged;
}
function _setVal(id, v) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === 'SELECT') {
    Array.from(el.options).forEach(o => { o.selected = String(o.value) === String(v); });
  } else {
    el.value = (v !== undefined && v !== null) ? v : '';
  }
}
function _getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

/* Sumber kebenaran pengaturan kini SERVER (tabel app_parameters /
   acs_connection_settings), bukan localStorage.

   localStorage tetap dipakai, tapi turun pangkat menjadi CACHE: ACS.getConfig()
   bersifat sinkron dan dipanggil dari banyak jalur render, jadi ia tak bisa
   menunggu jaringan. Polanya: saat boot tarik dari server sekali → tulis ke
   localStorage → seluruh kode lama jalan apa adanya.

   Ini menutup masalah nyata: dulu tiap browser memegang salinannya sendiri,
   sehingga dua operator bisa memakai ambang RX berbeda untuk panel yang sama. */
let _acsCfg = null;          // snapshot acs_connection_settings dari server

async function syncSettingsFromServer() {
  const d = await authFetch('/config/all');
  _cfgSave({
    onlineThresholdMin: d.params.onlineThresholdMin,
    perPage:            d.params.perPage,
    rxGood:             d.params.rxGood,
    rxFair:             d.params.rxFair,
    refreshInterval:    d.params.refreshInterval,
  });
  _acsCfg = d.acs;            // null bila tak memegang izin Koneksi ACS
  terapkanProfilServer(d.vendorProfiles);
  // Izin bisa berubah sejak login (administrator membuka/menutup menu). Disegarkan
  // tiap Settings dibuka supaya menu yang tampil sama dengan yang diizinkan server.
  if (App.user && Array.isArray(d.izin)) {
    App.user.izin = d.izin;
    const hal = document.getElementById('page-settings');
    if (hal) { applyRoleVisibility(hal); _stNavRapikan(); }
  }
  return d;
}

function _populateForm() {
  const cfg = _cfgLoad();
  _setVal('cfgRefresh',   cfg.refreshInterval || 60);
  _setVal('cfgOnlineMin', cfg.onlineThresholdMin || 10);
  _setVal('cfgPerPage',   cfg.perPage  || 20);
  _setVal('cfgRxGood',    cfg.rxGood  !== undefined ? cfg.rxGood  : -20);
  _setVal('cfgRxFair',    cfg.rxFair  !== undefined ? cfg.rxFair  : -25);
  _renderRxPreview();
  _populateAcsForm();
}

// ════════════════════════════════════════════════════════════════
// KONEKSI ACS
// ════════════════════════════════════════════════════════════════
function _populateAcsForm() {
  const a = _acsCfg;
  if (!a) return;
  _setVal('acsProtocol', a.protocol || 'http');
  _setVal('acsHost',     a.host || '127.0.0.1');
  _setVal('acsPort',     a.port || 7557);
  _setVal('acsBasePath', a.base_path || '');
  _setVal('acsAuthUser', a.auth_username || '');
  _setVal('acsAuthSecret', '');

  const chk = document.getElementById('acsAuthEnabled');
  if (chk) chk.checked = !!a.auth_enabled;
  _acsAuthToggle();

  // Rahasia tak pernah dikirim balik ke browser — yang ditampilkan hanya
  // FAKTA bahwa ia tersimpan, supaya operator tahu boleh mengosongkannya.
  const hint = document.getElementById('acsSecretHint');
  if (hint) hint.hidden = !a.auth_secret_set;

  _acsUrlPreview();
  _renderAcsLastTest(a);

  const by = document.getElementById('acsUpdatedBy');
  if (by) by.textContent = a.updated_by || '—';
  const at = document.getElementById('acsUpdatedAt');
  if (at) at.textContent = a.updated_at ? _acctDate(a.updated_at) : '—';
}

function _acsForm() {
  const chk = document.getElementById('acsAuthEnabled');
  return {
    protocol:      _getVal('acsProtocol') || 'http',
    host:          _getVal('acsHost').trim(),
    port:          parseInt(_getVal('acsPort'), 10) || 0,
    base_path:     _getVal('acsBasePath').trim(),
    auth_enabled:  !!(chk && chk.checked),
    auth_username: _getVal('acsAuthUser').trim(),
    auth_secret:   _getVal('acsAuthSecret'),
  };
}

function _acsUrlPreview() {
  const f = _acsForm();
  const base = f.base_path.replace(/^\/+|\/+$/g, '');
  const el = document.getElementById('acsUrlPreview');
  if (el) el.textContent = f.protocol + '://' + (f.host || '—') + ':' + (f.port || '—')
                         + (base ? '/' + base : '');
}

function _acsAuthToggle() {
  const chk  = document.getElementById('acsAuthEnabled');
  const body = document.getElementById('acsAuthBody');
  if (body) body.hidden = !(chk && chk.checked);
}

function _renderAcsLastTest(a) {
  const status = a.last_test_status || 'belum diuji';
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('acsLastStatus', status.charAt(0).toUpperCase() + status.slice(1));
  set('acsLastAt', a.last_test_at ? _acctDate(a.last_test_at) : '—');
  set('acsLastMsg', a.last_test_message || 'Belum pernah diuji.');

  const badge = document.getElementById('acsStatusBadge');
  if (badge) {
    const map = { sukses: ['bg-green', 'Terhubung'], gagal: ['bg-red', 'Gagal'] };
    const pair = map[status] || ['', 'Belum diuji'];
    badge.className = 'badge ' + pair[0];
    badge.innerHTML = '<i class="fas fa-circle" style="font-size:8px"></i> ' + pair[1];
  }
}

async function saveAcsConfig() {
  const btn = document.getElementById('btnSaveAcs');
  setBtnBusy(btn, true);
  try {
    const d = await authFetch('/config/acs', { method: 'POST', body: _acsForm() });
    _acsCfg = d.acs;
    _populateAcsForm();
    showToast('Koneksi ACS disimpan — proxy langsung diarahkan ulang', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

/* Uji koneksi ke nilai yang ada di FORM, bukan ke konfigurasi tersimpan.

   Versi lama memanggil ACS.loadAll(), yang selalu memakai konfigurasi yang
   SUDAH tersimpan — jadi mengubah host lalu menekan "Test Koneksi" tetap
   menguji host LAMA dan melaporkan "berhasil". Persis kebalikan dari gunanya
   tombol ini. Pengujian kini dijalankan server terhadap isi form. */
async function testAcsConnection() {
  const btn = document.getElementById('btnTestAcs');
  const box = document.getElementById('acsTestResult');
  setBtnBusy(btn, true);
  if (box) {
    box.hidden = false;
    box.className = 'acs-test-result testing';
    box.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Menghubungi '
                  + _vmEsc(_acsForm().host) + '…</span>';
  }
  try {
    const r = await authFetch('/config/acs/test', { method: 'POST', body: _acsForm() });
    const good = r.status === 'sukses';
    if (box) {
      box.className = 'acs-test-result ' + (good ? 'ok' : 'err');
      box.innerHTML = '<i class="fas fa-' + (good ? 'circle-check' : 'circle-xmark') + '"></i>'
                    + '<span>' + _vmEsc(r.message) + '</span>';
    }
    showToast(good ? 'Koneksi berhasil' : 'Koneksi gagal', good ? 'success' : 'error');
    try {
      _acsCfg = (await authFetch('/config/all')).acs;
      _renderAcsLastTest(_acsCfg);
    } catch (_) { /* hasil uji sudah tampil; menyegarkan panel samping opsional */ }
  } catch (e) {
    if (box) {
      box.className = 'acs-test-result err';
      box.innerHTML = '<i class="fas fa-circle-xmark"></i><span>' + _vmEsc(e.message) + '</span>';
    }
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

// ════════════════════════════════════════════════════════════════
// PARAMETER APLIKASI
// ════════════════════════════════════════════════════════════════
function _renderRxPreview() {
  const g = parseFloat(_getVal('cfgRxGood'));
  const f = parseFloat(_getVal('cfgRxFair'));
  if (isNaN(g) || isNaN(f)) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('rxpGood', '≥ ' + g + ' dBm');
  set('rxpFair', f + ' … ' + g + ' dBm');
  set('rxpPoor', '< ' + f + ' dBm');
  // Umpan balik seketika saat ambangnya terbalik — jangan tunggu tombol Simpan
  // untuk memberi tahu bahwa kombinasinya mustahil.
  const wrap = document.getElementById('rxPreview');
  if (wrap) wrap.classList.toggle('rx-invalid', g <= f);
}

/* ── Keselamatan ONU: Mode Aman ──────────────────────────────────
   Sakelar darurat. Menyalakannya tidak butuh alasan — saat darurat, mengetik
   alasan adalah hambatan yang salah. MEMATIKANNYA butuh alasan, karena itulah
   saat seseorang membuka kembali jalur yang sengaja ditutup, dan enam bulan
   lagi orang perlu tahu kenapa. Server menegakkan syarat itu juga. */
async function renderPagar() {
  const st  = document.getElementById('pagarStatus');
  const btn = document.getElementById('btnPagarToggle');
  if (!st || !btn) return;
  st.textContent = 'Memuat…';
  st.className   = 'pagar-status';
  let d;
  try {
    d = await authFetch('/config/mode-aman');
  } catch (e) {
    st.textContent = 'Gagal membaca status: ' + e.message;
    st.className   = 'pagar-status pagar-off';
    return;
  }
  st.className   = 'pagar-status ' + (d.aktif ? 'pagar-on' : 'pagar-off');
  st.textContent = d.aktif
    ? 'MODE AMAN AKTIF — perintah ke ONU dihentikan, pembacaan tetap berjalan.'
    : 'Normal — perintah ke ONU berjalan seperti biasa.';

  btn.innerHTML = '<i class="fas fa-shield-halved"></i> '
                + (d.aktif ? 'Matikan Mode Aman' : 'Nyalakan Mode Aman');
  // Mode aman dari SKY_READONLY sengaja tidak bisa dimatikan lewat layar: itu
  // jalan darurat agar panel bisa dinyalakan ulang dalam keadaan aman tanpa
  // seorang pun bisa membukanya kembali dari jarak jauh.
  btn.disabled = (!d.bisaUbah) || (d.aktif && d.dariEnv);
  btn.title = d.aktif && d.dariEnv
    ? 'Dinyalakan lewat SKY_READONLY — hanya bisa dimatikan dari server'
    : (d.bisaUbah ? '' : 'Belum diberi izin mengubah Mode Aman');

  btn.onclick = async function() {
    let alasan = '';
    if (d.aktif) {
      alasan = window.prompt('Alasan mematikan mode aman?') || '';
      if (!alasan.trim()) return;
    }
    setBtnBusy(btn, true);
    try {
      await authFetch('/config/mode-aman',
                      { method: 'POST', body: { aktif: !d.aktif, alasan: alasan } });
      showToast(d.aktif ? 'Mode aman dimatikan' : 'Mode aman menyala — perintah ke ONU dihentikan',
                d.aktif ? 'success' : 'info');
      await renderPagar();
      if (typeof refreshModeAmanBar === 'function') refreshModeAmanBar();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBtnBusy(btn, false);
    }
  };
}

/* ── Kesehatan ACS (PRD §8) ──────────────────────────────────────
   Murni baca: server merangkum GET /faults dan GET /tasks plus data panel
   sendiri (kesehatan.py). Membuka halaman ini tidak mengirim apa pun ke ONU. */
function _kshEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function _kshUmur(jam) {
  if (jam < 1)  return Math.round(jam * 60) + ' mnt';
  if (jam < 48) return Math.round(jam) + ' jam';
  return Math.round(jam / 24) + ' hari';
}
function _kshChips(el, judul, daftar) {
  if (!el) return;
  el.innerHTML = (daftar || []).length
    ? '<span class="ksh-chip"><b>' + _kshEsc(judul) + '</b></span>'
      + daftar.map(x => '<span class="ksh-chip">' + _kshEsc(x.nama) + ' · ' + x.n + '</span>').join('')
    : '';
}

async function renderKesehatan() {
  const $ = id => document.getElementById(id);
  const btn = $('btnKesehatanSegarkan');
  if (btn) btn.onclick = renderKesehatan;
  const per = $('kshPeringatan');
  if (!per) return;
  per.innerHTML = '<div class="ksh-pesan">Memuat…</div>';
  let d;
  try {
    d = await authFetch('/config/kesehatan');
  } catch (e) {
    per.innerHTML = '<div class="ksh-pesan bahaya">Gagal memuat: ' + _kshEsc(e.message) + '</div>';
    return;
  }

  $('kshWaktu').innerHTML = '<i class="fas fa-circle-info"></i> Diperbarui ' + _kshEsc(d.dibuat)
    + ' · murni baca — tidak mengirim apa pun ke ONU.';
  $('kshBatasMenit').textContent = d.panel.kedaluwarsaMenit;

  per.innerHTML = d.peringatan.length
    ? d.peringatan.map(p => '<div class="ksh-pesan ' + _kshEsc(p.tingkat) + '">'
                            + _kshEsc(p.teks) + '</div>').join('')
    : '<div class="ksh-pesan baik"><i class="fas fa-circle-check"></i> '
      + 'Tidak ada tanda bahaya. Tidak ada perintah menggantung lama dan tidak ada '
      + 'perintah yang gagal berulang.</div>';

  const f = d.fault || {}, a = d.antrean || {}, j = d.jejak24j || {};
  const kotak = (n, label, bahaya) => '<div class="ksh-kotak' + (bahaya && n ? ' bahaya' : '')
    + '"><b>' + (n == null ? '—' : n) + '</b><span>' + label + '</span></div>';
  $('kshAngka').innerHTML =
      kotak(f.dariTask, 'perintah gagal', true)
    + kotak(f.dariProvision, 'fault dari provision')
    + kotak(a.total, 'perintah mengantre')
    + kotak(a.bomWaktu, 'mengantre > 24 jam', true)
    + kotak(d.panel.dibatalkan24Jam, 'dibatalkan otomatis (24 jam)')
    + kotak((d.operasi.berjalan || []).length, 'operasi berjalan')
    + kotak(j.acs_ditolak, 'ditolak pagar (24 jam)')
    + kotak(j.onu_reboot, 'reboot (24 jam)');

  if (d.nbiGalat) {
    $('kshFaultTabel').innerHTML = '';
    $('kshAntreTabel').innerHTML = '';
    return;
  }

  _kshChips($('kshFaultRingkas'), 'Kode', f.perKode);
  $('kshFaultTabel').innerHTML = (f.daftarTask || []).length
    ? '<thead><tr><th>ONU</th><th>Model</th><th>Kode</th><th>Pesan</th><th>Diulang</th><th>Umur</th></tr></thead><tbody>'
      + f.daftarTask.map(x => '<tr><td class="ksh-mono">' + _kshEsc(x.device) + '</td><td>'
          + _kshEsc(x.model) + '</td><td>' + _kshEsc(x.kode) + '</td><td>' + _kshEsc(x.pesan)
          + '</td><td>' + x.retries + '×</td><td>' + _kshUmur(x.umurJam) + '</td></tr>').join('')
      + '</tbody>'
    : '<tbody><tr><td>Tidak ada perintah yang sedang gagal.</td></tr></tbody>';

  _kshBersihSiapkan();
  _kshChips($('kshAntreRingkas'), 'Umur', a.umur);
  $('kshAntreTabel').innerHTML = (a.tertua || []).length
    ? '<thead><tr><th>ONU</th><th>Model</th><th>Perintah</th><th>Umur</th></tr></thead><tbody>'
      + a.tertua.map(x => '<tr><td class="ksh-mono">' + _kshEsc(x.device) + '</td><td>'
          + _kshEsc(x.model) + '</td><td>' + _kshEsc(x.nama) + '</td><td>'
          + _kshUmur(x.umurJam) + '</td></tr>').join('')
      + '</tbody>'
    : '<tbody><tr><td>Antrean kosong.</td></tr></tbody>';
}

/* ── Tombol "Bersihkan antrean lama" (khusus administrator) ──────
   Dua langkah: Periksa (murni baca, menampilkan daftar) → Bersihkan (dengan
   konfirmasi). Yang dikirim ke server hanya id dari daftar Periksa; server
   menilai ulang kriterianya sendiri sebelum menghapus (kesehatan.bersihkan). */
function _kshBersihSiapkan() {
  const periksa = document.getElementById('btnBersihPeriksa');
  const jalankan = document.getElementById('btnBersihJalankan');
  const hasil = document.getElementById('kshBersihHasil');
  if (!periksa || !jalankan || !hasil) return;
  jalankan.hidden = true;
  hasil.innerHTML = '';

  periksa.onclick = async function() {
    jalankan.hidden = true;
    setBtnBusy(periksa, true);
    let c;
    try {
      c = await authFetch('/config/kesehatan/bersihkan');
    } catch (e) {
      hasil.innerHTML = '<div class="ksh-pesan bahaya">' + _kshEsc(e.message) + '</div>';
      return;
    } finally {
      setBtnBusy(periksa, false);
    }
    if (!c.jumlah) {
      hasil.innerHTML = '<div class="ksh-pesan baik"><i class="fas fa-circle-check"></i> '
        + 'Tidak ada perintah yang perlu dibersihkan.</div>';
      return;
    }
    hasil.innerHTML = '<div class="ksh-pesan waspada"><b>' + c.jumlah + ' perintah</b> di '
      + c.onu + ' ONU akan dihapus'
      + (c.menulis ? ', <b>' + c.menulis + ' di antaranya menulis ke ONU</b>' : '') + '.</div>'
      + '<div class="ksh-scroll" style="margin-top:8px"><table class="data-table">'
      + '<thead><tr><th>ONU</th><th>Model</th><th>Perintah</th><th>Umur</th><th>Alasan</th></tr></thead><tbody>'
      + c.daftar.map(x => '<tr><td class="ksh-mono">' + _kshEsc(x.device) + '</td><td>'
          + _kshEsc(x.model) + '</td><td>' + _kshEsc(x.nama) + '</td><td>' + _kshUmur(x.umurJam)
          + '</td><td>' + _kshEsc(x.alasan) + '</td></tr>').join('')
      + '</tbody></table></div>';
    jalankan.hidden = false;
    jalankan.innerHTML = '<i class="fas fa-broom"></i> Bersihkan ' + c.jumlah + ' perintah';

    jalankan.onclick = function() {
      showConfirm({
        title: 'Bersihkan antrean?', icon: 'fa-broom', danger: true,
        yesLabel: 'Ya, hapus ' + c.jumlah + ' perintah',
        message: c.jumlah + ' perintah akan dihapus dari antrean GenieACS dan tidak akan '
               + 'dijalankan ONU. Salinannya disimpan ke <code>data/backup/</code>.',
      }, async function() {
        setBtnBusy(jalankan, true);
        try {
          const r = await authFetch('/config/kesehatan/bersihkan',
                                    { method: 'POST', body: { ids: c.daftar.map(x => x.id) } });
          const gagal = (r.gagal || []).length;
          showToast(r.dihapus + ' perintah dibersihkan' + (gagal ? ', ' + gagal + ' gagal' : ''),
                    gagal ? 'info' : 'success');
          await renderKesehatan();
          const h = document.getElementById('kshBersihHasil');
          if (h) h.innerHTML = '<div class="ksh-pesan ' + (gagal ? 'waspada' : 'baik') + '">'
            + r.dihapus + ' perintah dihapus'
            + (r.dilewati ? ', ' + r.dilewati + ' dilewati (sudah tidak memenuhi kriteria)' : '')
            + (gagal ? ', ' + gagal + ' gagal (ONU sedang terhubung — tekan Periksa lalu coba lagi)' : '')
            + (r.cadangan ? '. Cadangan: <code>data/backup/' + _kshEsc(r.cadangan) + '</code>' : '')
            + '</div>';
        } catch (e) {
          showToast(e.message, 'error');
        } finally {
          setBtnBusy(jalankan, false);
        }
      });
    };
  };
}

/* ── Pemetaan Parameter (VirtualParameter) ───────────────────────
   Seluruh halaman ini MURNI BACA. "Uji pemetaan" dan "Deteksi otomatis"
   mengambil dokumen perangkat yang sudah tersimpan di GenieACS lewat GET —
   tidak satu pun task dikirim ke ONU. Itu bukan kebetulan: kalau halaman untuk
   MEMPERBAIKI pembacaan justru membebani ONU, ia melawan tujuannya sendiri. */
let _vpKerja = null;      // salinan yang sedang disunting

function _vpEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderVpMap() {
  const el = document.getElementById('vpList');
  if (!el || typeof VPMap === 'undefined') return;
  if (!_vpKerja) _vpKerja = JSON.parse(JSON.stringify(VPMap.peta()));

  const f = _vpKerja.fields || {};
  el.innerHTML = Object.keys(f).map(function (k) {
    const daftar = f[k].sumber || f[k].sources || [];
    const baris = daftar.map(function (s, i) {
      return '<div class="vp-src">'
        + '<span class="vp-num">' + (i + 1) + '</span>'
        + '<input class="form-input vp-in" data-field="' + k + '" data-idx="' + i + '"'
        + ' value="' + _vpEsc(s) + '" spellcheck="false">'
        + '<button class="vm-btn-icon vp-up" data-field="' + k + '" data-idx="' + i + '"'
        + ' title="Naikkan prioritas"' + (i === 0 ? ' disabled' : '')
        + '><i class="fas fa-arrow-up"></i></button>'
        + '<button class="vm-btn-icon vp-del" data-field="' + k + '" data-idx="' + i + '"'
        + ' title="Hapus kandidat"' + (daftar.length < 2 ? ' disabled' : '')
        + '><i class="fas fa-xmark"></i></button>'
        + '</div>';
    }).join('');
    return '<div class="vp-field" data-field="' + k + '">'
      + '<div class="vp-head"><strong>' + _vpEsc(f[k].label || k) + '</strong>'
      + '<code class="vp-key">' + _vpEsc(k) + '</code></div>'
      + baris
      + '<button class="btn btn-outline btn-sm vp-add" data-field="' + k + '">'
      + '<i class="fas fa-plus"></i> Tambah kandidat</button>'
      + '</div>';
  }).join('');
}

function _vpBaca() {
  document.querySelectorAll('#vpList .vp-in').forEach(function (inp) {
    const f = _vpKerja.fields[inp.dataset.field];
    if (!f) return;
    const arr = f.sumber || f.sources || [];
    arr[parseInt(inp.dataset.idx, 10)] = inp.value.trim();
    f.sumber = arr;
    delete f.sources;
  });
  // Kandidat kosong dibuang, bukan disimpan — sumber kosong hanya jadi
  // langkah sia-sia yang dilewati resolver pada setiap perangkat.
  Object.keys(_vpKerja.fields).forEach(function (k) {
    const f = _vpKerja.fields[k];
    f.sumber = (f.sumber || []).filter(function (s) { return s && s.trim(); });
  });
}

function _vpPesan(html, jenis) {
  const el = document.getElementById('vpHasil');
  if (!el) return;
  el.className = 'vp-hasil vp-' + (jenis || 'info');
  el.innerHTML = html;
}

async function _vpSimpan() {
  _vpBaca();
  const salah = VPMap.periksa(_vpKerja);
  if (salah) { showToast(salah, 'error'); return; }
  const btn = document.getElementById('btnVpSave');
  setBtnBusy(btn, true);
  try {
    await authFetch('/config/vp-mapping', { method: 'POST', body: { mapping: _vpKerja } });
    VPMap.setPeta(JSON.parse(JSON.stringify(_vpKerja)));
    showToast('Pemetaan disimpan & langsung dipakai', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

/* Uji pemetaan pada SATU perangkat.
   Menampilkan kandidat KEBERAPA yang menang untuk tiap field — tanpa itu,
   salah pemetaan baru ketahuan berbulan-bulan kemudian ketika seseorang
   kebetulan menyadari sebuah kolom selalu kosong. */
async function _vpUji() {
  _vpBaca();
  const salah = VPMap.periksa(_vpKerja);
  if (salah) { showToast(salah, 'error'); return; }
  const sn = window.prompt('Serial number atau ID perangkat untuk diuji:',
                           (App.currentDevice && App.currentDevice.serial) || '');
  if (!sn || !sn.trim()) return;
  const btn = document.getElementById('btnVpTest');
  setBtnBusy(btn, true);
  try {
    const dok = await _vpAmbilDokumen(sn.trim(), 1);
    if (!dok.length) { showToast('Perangkat tidak ditemukan', 'error'); return; }
    const d = dok[0];
    const baris = Object.keys(_vpKerja.fields).map(function (k) {
      const r = VPMap.resolve(d, k, _vpKerja);
      const isi = (r.nilai === null || r.nilai === undefined || String(r.nilai) === '');
      const umur = r.waktu ? VPMap.umur(r.waktu) : null;
      return '<tr>'
        + '<td>' + _vpEsc(_vpKerja.fields[k].label || k) + '</td>'
        + '<td>' + (isi ? '<span class="vp-kosong">— kosong</span>'
                        : '<strong>' + _vpEsc(r.nilai) + '</strong>') + '</td>'
        + '<td>' + (isi ? '<span class="vp-kosong">seluruh kandidat kosong</span>'
                        : '#' + (r.indeks + 1) + ' <code>' + _vpEsc(r.sumber) + '</code>') + '</td>'
        + '<td>' + (umur ? _vpEsc(umur.teks) : '—') + '</td>'
        + '</tr>';
    }).join('');
    _vpPesan('<div class="vp-hasil-hdr"><i class="fas fa-vial"></i> Hasil uji pada <code>'
      + _vpEsc(d._id) + '</code> — murni baca, tidak ada perintah dikirim ke ONU</div>'
      + '<div class="vp-tabel-bungkus"><table class="vp-tabel"><thead><tr>'
      + '<th>Field</th><th>Nilai</th><th>Kandidat yang dipakai</th><th>Umur data</th>'
      + '</tr></thead><tbody>' + baris + '</tbody></table></div>', 'info');
    document.getElementById('vpHasil').classList.remove('hidden');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

/* Deteksi otomatis: pindai contoh perangkat lintas model, laporkan berapa
   persen yang terisi per field dan kandidat mana yang benar-benar bekerja. */
async function _vpDeteksi() {
  _vpBaca();
  const btn = document.getElementById('btnVpDetect');
  setBtnBusy(btn, true);
  try {
    const dok = await _vpAmbilDokumen(null, 60);
    if (!dok.length) { showToast('Tidak ada perangkat aktif untuk dipindai', 'error'); return; }
    const c = VPMap.cakupan(dok, _vpKerja);
    const baris = Object.keys(c).map(function (k) {
      const s = c[k];
      const warna = s.persen >= 95 ? 'vp-baik' : (s.persen >= 50 ? 'vp-sedang' : 'vp-buruk');
      const rinci = s.perSumber.filter(function (x) { return x.dipakai > 0; })
        .map(function (x) { return '<code>' + _vpEsc(x.sumber) + '</code> ' + x.persen + '%'; })
        .join(' · ') || '<span class="vp-kosong">tidak ada kandidat yang terisi</span>';
      return '<tr><td>' + _vpEsc(s.label) + '</td>'
        + '<td class="' + warna + '"><strong>' + s.persen + '%</strong></td>'
        + '<td>' + rinci + '</td></tr>';
    }).join('');
    _vpPesan('<div class="vp-hasil-hdr"><i class="fas fa-wand-magic-sparkles"></i> '
      + 'Cakupan pada ' + dok.length + ' perangkat aktif — murni baca, '
      + 'tidak ada perintah dikirim ke ONU</div>'
      + '<div class="vp-tabel-bungkus"><table class="vp-tabel"><thead><tr>'
      + '<th>Field</th><th>Terisi</th><th>Kandidat yang bekerja</th>'
      + '</tr></thead><tbody>' + baris + '</tbody></table></div>', 'info');
    document.getElementById('vpHasil').classList.remove('hidden');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

/* Ambil dokumen perangkat APA ADANYA dari GenieACS — tanpa projection, supaya
   kandidat jalur mana pun bisa diuji, termasuk yang belum ada di proyeksi
   panel. GET murni: tidak mengantre task, tidak menyentuh ONU. */
async function _vpAmbilDokumen(sn, batas) {
  let q;
  if (sn) {
    q = { $or: [{ _id: sn }, { '_deviceId._SerialNumber': sn }] };
  } else {
    q = { _lastInform: { $gt: new Date(Date.now() - 3600000).toISOString() } };
  }
  const url = '/api/devices?query=' + encodeURIComponent(JSON.stringify(q))
            + '&limit=' + (batas || 1);
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Gagal membaca perangkat dari GenieACS (' + r.status + ')');
  return r.json();
}

function _vpReset() {
  showConfirm({
    title: 'Kembalikan ke bawaan?',
    icon: 'fa-rotate-left',
    yesLabel: 'Kembalikan',
    message: 'Seluruh kandidat yang Anda sunting akan dibuang dan panel kembali '
           + 'memakai pemetaan bawaan.',
  }, async () => {
    try {
      await authFetch('/config/vp-mapping', { method: 'POST', body: { mapping: null } });
      VPMap.setPeta(null);
      _vpKerja = VPMap.bawaan();
      renderVpMap();
      showToast('Pemetaan dikembalikan ke bawaan', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  });
}

/* Delegasi: daftar digambar ulang terus-menerus, jadi listener dipasang sekali
   di induknya — pola yang sama dipakai tabel Vendor Configuration. */
function _vpInit() {
  const list = document.getElementById('vpList');
  if (list && !list.dataset.siap) {
    list.dataset.siap = '1';
    list.addEventListener('click', function (e) {
      const t = e.target.closest('.vp-add, .vp-del, .vp-up');
      if (!t) return;
      _vpBaca();
      const f = _vpKerja.fields[t.dataset.field];
      if (!f) return;
      const arr = f.sumber || [];
      if (t.classList.contains('vp-add')) arr.push('');
      else if (t.classList.contains('vp-del')) arr.splice(parseInt(t.dataset.idx, 10), 1);
      else {
        const i = parseInt(t.dataset.idx, 10);
        if (i > 0) { const x = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = x; }
      }
      f.sumber = arr;
      renderVpMap();
    });
  }
  const pasang = (id, fn) => {
    const b = document.getElementById(id);
    if (b && !b.dataset.siap) { b.dataset.siap = '1'; b.addEventListener('click', fn); }
  };
  pasang('btnVpSave',   _vpSimpan);
  pasang('btnVpTest',   _vpUji);
  pasang('btnVpDetect', _vpDeteksi);
  pasang('btnVpReset',  _vpReset);
}

async function saveParamConfig() {
  const btn = document.getElementById('btnSaveParam');
  const body = {
    onlineThresholdMin: parseInt(_getVal('cfgOnlineMin'), 10),
    perPage:            parseInt(_getVal('cfgPerPage'), 10),
    rxGood:             parseFloat(_getVal('cfgRxGood')),
    rxFair:             parseFloat(_getVal('cfgRxFair')),
    refreshInterval:    parseInt(_getVal('cfgRefresh'), 10),
  };
  setBtnBusy(btn, true);
  try {
    const d = await authFetch('/config/params', { method: 'POST', body });
    _cfgSave(d.params);
    applyParamsNow();
    showToast('Parameter disimpan & langsung diterapkan', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

/* Terapkan parameter SEKARANG, tanpa memuat ulang halaman.

   PRD 5.2 menuntut perubahan "benar-benar diikuti perilaku aplikasi tanpa
   intervensi manual tambahan". Sebelumnya tidak: menyimpan hanya menulis ke
   localStorage, sementara d.online sudah terlanjur dihitung saat data dimuat
   dan tabelnya sudah terlanjur tergambar. Operator harus menebak sendiri bahwa
   ia perlu pindah halaman agar angkanya berubah.

   Status online dihitung ULANG dari lastInformRaw yang memang masih tersimpan
   di tiap perangkat — jadi tak perlu menarik ulang 1742 ONU dari GenieACS
   hanya untuk mengubah satu ambang batas. */
function applyParamsNow() {
  const cfg = _cfgLoad();

  const mins = parseInt(cfg.onlineThresholdMin, 10) || 10;
  if (Array.isArray(App.devices)) {
    const now = Date.now();
    App.devices.forEach(function (d) {
      d.online = !!d.lastInformRaw &&
                 (now - new Date(d.lastInformRaw).getTime()) < mins * 60 * 1000;
    });
  }

  App.devicePerPage = parseInt(cfg.perPage, 10) || 20;
  App.devicePage = 1;              // ukuran halaman berubah → halaman 7 bisa tak ada lagi

  if (typeof setupAutoRefresh === 'function') setupAutoRefresh();

  // Gambar ulang hanya halaman yang sedang dibuka. Ambang RX dibaca saat render
  // (ACS.rxThr()), jadi render ulang saja sudah cukup.
  if (App.currentPage === 'dashboard' && typeof initDashboard === 'function') initDashboard();
  if (App.currentPage === 'devices' && typeof _renderAfterLoad === 'function') _renderAfterLoad();
}

// ════════════════════════════════════════════════════════════════
// TENTANG SISTEM — data live dari server
// ════════════════════════════════════════════════════════════════
async function renderAbout() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  try {
    const d = await authFetch('/config/about');
    set('abApp', d.app);
    set('abVersion', 'v' + d.appVersion);
    set('abSchema', 'v' + d.schema);
    set('abDbSize', d.dbSize);
    set('abUsers', d.users !== undefined ? d.users : '—');
    set('abSessions', d.sessions !== undefined ? d.sessions : '—');
    set('abHost', d.hostname);
    set('abPlatform', d.platform);
    set('abPython', d.python);
    set('abUptime', d.uptime);
    set('abHttps', d.https ? 'HTTPS (terenkripsi)' : 'HTTP (tidak terenkripsi)');
    set('abGenie', d.genieacs || '—');
    set('abMongo', d.mongodb || '—');
    // Kosong untuk yang tak memegang izin Koneksi ACS — server sengaja tak mengirimnya.
    set('abAcsUrl', d.acsUrl || '—');
  } catch (e) {
    set('abApp', 'Gagal memuat: ' + e.message);
  }
  renderCadangan();
  renderPembaruan();
  // Jumlah perangkat datang dari GenieACS, bukan dari server panel.
  const tot = document.getElementById('stTotalDevices');
  if (!tot) return;
  if (App.devices && App.devices.length) {
    tot.textContent = App.devices.length.toLocaleString('id-ID');
  } else {
    ACS.loadAll().then(function (ds) { tot.textContent = ds.length.toLocaleString('id-ID'); })
                 .catch(function () { tot.textContent = '—'; });
  }
}

// ════════════════════════════════════════════════════════════════
// PEMBARUAN (administrator) — kartu di Tentang Sistem
//
// Server yang memutuskan dari mana dan ke versi apa (backend/pembaruan.py): browser hanya
// meminta "periksa" dan "pasang", tanpa mengirim alamat atau cabang. Judul perubahan
// berasal dari GitHub → selalu ditampilkan sebagai teks.
// ════════════════════════════════════════════════════════════════
function _updGambar(d) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('updVersi', 'v' + d.versi + (d.commit ? ' (' + d.commit + ')' : ''));
  set('updSumber', d.sumber ? d.sumber.replace(/^https?:\/\//, '').replace(/\.git$/, '') + ' · ' + d.cabang : '—');
  set('updStatus', !d.bisa ? d.alasan
    : d.tertinggal === undefined ? 'Belum diperiksa'
    : d.tersedia ? 'Tersedia v' + d.versiBaru + ' — ' + d.tertinggal + ' perubahan'
    : 'Sudah versi terbaru');
  const periksa = document.getElementById('btnUpdPeriksa'), pasang = document.getElementById('btnUpdPasang');
  if (periksa) periksa.disabled = !d.bisa;
  if (pasang) { pasang.hidden = !d.tersedia; pasang.dataset.versi = d.versiBaru || ''; }
  const daftar = document.getElementById('updPerubahan');
  if (daftar) {
    daftar.hidden = !(d.tersedia && d.perubahan && d.perubahan.length);
    daftar.innerHTML = daftar.hidden ? '' : '<b>Yang berubah</b><ul>'
      + d.perubahan.map(function(x) { return '<li>' + escHtml(x) + '</li>'; }).join('') + '</ul>'
      + (d.tertinggal > d.perubahan.length ? '<small>… dan ' + (d.tertinggal - d.perubahan.length) + ' lainnya</small>' : '');
  }
}

async function renderPembaruan() {
  if (!isAdmin() || !document.getElementById('updKartu')) return;
  try {
    _updGambar(await authFetch('/config/pembaruan'));
  } catch (e) {
    const el = document.getElementById('updStatus');
    if (el) el.textContent = 'Gagal memuat: ' + e.message;
  }
}

async function periksaPembaruan() {
  const btn = document.getElementById('btnUpdPeriksa'), st = document.getElementById('updStatus');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memeriksa…';
  try {
    _updGambar(await authFetch('/config/pembaruan/periksa', { method: 'POST', body: {} }));
  } catch (e) {
    if (st) st.textContent = 'Gagal memeriksa — ' + e.message;
    btn.disabled = false;
  } finally {
    btn.innerHTML = '<i class="fas fa-magnifying-glass"></i> Periksa pembaruan';
  }
}

function pasangPembaruan() {
  const btn = document.getElementById('btnUpdPasang'), st = document.getElementById('updStatus');
  showConfirm({
    title: 'Pasang pembaruan?', icon: 'fa-cloud-arrow-down', yesLabel: 'Update sekarang',
    message: 'Panel akan diperbarui ke <b>v' + escHtml(btn.dataset.versi || '?') + '</b> lalu menyala ulang '
      + '(± 10 detik). Basis data dicadangkan lebih dulu.<br><br>Semua orang yang sedang membuka panel perlu '
      + 'memuat ulang halamannya sesudah itu.',
  }, async function() {
    btn.disabled = true;
    document.getElementById('btnUpdPeriksa').disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memasang…';
    let menyalaUlang = false;
    try {
      const h = await authFetch('/config/pembaruan/pasang', { method: 'POST', body: {} });
      if (!h.mulaiUlang) { showToast('Panel sudah versi terbaru', 'success'); return renderPembaruan(); }
      // Tombol dibiarkan mati sampai halaman dimuat ulang: klik kedua saat panel sedang
      // berganti proses hanya menghasilkan galat sambungan yang membingungkan.
      menyalaUlang = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyala ulang…';
      if (st) st.textContent = 'v' + h.versiKe + ' terpasang — panel sedang menyala ulang…';
      _updTungguNyala(h.proses, 0);
    } catch (e) {
      if (st) st.textContent = 'Pembaruan dibatalkan — ' + e.message;
      showToast('Pembaruan dibatalkan: ' + e.message, 'error');
      document.getElementById('btnUpdPeriksa').disabled = false;
    } finally {
      if (!menyalaUlang) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-download"></i> Update';
      }
    }
  });
}

/* Panel mati sebentar saat berganti proses. Tanyakan tiap 1,5 detik sampai PROSES yang
   baru menjawab, lalu muat ulang halaman supaya browser memakai JS/CSS versi baru.
   Yang dibandingkan tanda proses, BUKAN versi/commit: proses lama pun sudah menjawab
   dengan versi baru (dibaca dari berkas) sebelum ia berganti — memuat ulang saat itu
   berarti membuka panel tepat ketika ia mati. Menyerah sesudah ±90 detik dengan petunjuk. */
function _updTungguNyala(prosesLama, ke) {
  setTimeout(async function() {
    let d = null;
    try { d = await authFetch('/config/pembaruan'); } catch (_) { d = null; }
    if (d && d.proses && d.proses !== prosesLama) { window.location.reload(); return; }
    if (ke >= 60) {
      const st = document.getElementById('updStatus'), btn = document.getElementById('btnUpdPasang');
      if (st) st.textContent = 'Panel belum menjawab. Muat ulang halaman ini; bila tetap tidak bisa, periksa layanan panel di server.';
      if (btn) btn.innerHTML = '<i class="fas fa-download"></i> Update';
      return;
    }
    _updTungguNyala(prosesLama, ke + 1);
  }, 1500);
}

// ════════════════════════════════════════════════════════════════
// CADANGAN DATA (administrator) — kartu di Tentang Sistem
//
// Cadangan harian dibuat server sendiri (backend/cadangan.py); di sini hanya keadaannya
// dan unduhan terenkripsi. Kata sandi cadangan dikirim sekali lewat POST lalu dibuang —
// tidak disimpan di server maupun di browser.
// ════════════════════════════════════════════════════════════════
let _cadInfo = null;

function _cadUkuran(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

async function renderCadangan() {
  if (!isAdmin() || !document.getElementById('cadKartu')) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  try {
    const d = _cadInfo = await authFetch('/config/cadangan');
    const ada = d.otomatis || [];
    set('cadStatus', d.galat ? 'Gagal — ' + d.galat : 'Aktif — sekali sehari, ' + d.simpan + ' terakhir disimpan');
    set('cadTerakhir', ada.length ? _acctDate(ada[0].waktu) : 'Belum ada (dibuat saat panel menyala)');
    set('cadJumlah', ada.length ? ada.length + ' berkas · ' + _cadUkuran(d.total) : '—');
    const btn = document.getElementById('btnCadUnduh');
    if (btn) {
      btn.disabled = !d.enkripsi;
      btn.title = d.enkripsi ? '' : 'Program openssl tidak ditemukan di server (Ubuntu: sudo apt install openssl)';
    }
  } catch (e) {
    set('cadStatus', 'Gagal memuat: ' + e.message);
  }
}

function bukaCadModal() {
  ['cadSandi', 'cadSandi2', 'cadPassword'].forEach(function(id) { _setVal(id, ''); });
  ['cadGalat', 'cadHasil'].forEach(function(id) { const el = document.getElementById(id); if (el) el.hidden = true; });
  const m = document.getElementById('cadModal');
  if (m) m.classList.remove('hidden');
  const f = document.getElementById('cadSandi');
  if (f) f.focus();
}

async function unduhCadangan() {
  const galat = document.getElementById('cadGalat'), hasil = document.getElementById('cadHasil');
  const btn = document.getElementById('btnCadKirim');
  const tolak = function(pesan) { galat.textContent = pesan; galat.hidden = false; hasil.hidden = true; };
  const sandi = _getVal('cadSandi'), min = (_cadInfo && _cadInfo.sandiMin) || 10;
  if (sandi.length < min) return tolak('Kata sandi cadangan minimal ' + min + ' karakter');
  if (sandi !== _getVal('cadSandi2')) return tolak('Kata sandi cadangan dan ulangannya tidak sama');
  if (!_getVal('cadPassword')) return tolak('Isi password akun Anda');
  galat.hidden = true;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengenkripsi…';
  try {
    // Bukan authFetch: jawabannya berkas biner, bukan JSON.
    const r = await fetch('/config/cadangan/unduh', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandi: sandi, password: _getVal('cadPassword') }),
    });
    if (!r.ok) {
      let pesan = 'HTTP ' + r.status;
      try { pesan = (await r.json()).error || pesan; } catch (_) { /* bukan JSON */ }
      return tolak(pesan);
    }
    const nama = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'sky-cadangan.db.enc';
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = nama;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    ['cadSandi', 'cadSandi2', 'cadPassword'].forEach(function(id) { _setVal(id, ''); });
    document.getElementById('cadHasilNama').textContent = nama;
    document.getElementById('cadPerintah').textContent =
      ((_cadInfo && _cadInfo.perintahBuka) || '').replace('<berkas>', nama);
    hasil.hidden = false;
  } catch (e) {
    tolak('Gagal mengunduh: ' + (e.message || 'galat jaringan'));
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-download"></i> Enkripsi &amp; Unduh';
  }
}

// ════════════════════════════════════════════════════════════════
// AKUN — "Akun Saya" (semua role) & "Manajemen Akun" (administrator)
//
// Menyembunyikan menu BUKAN kontrol akses: endpoint tetap bisa dipanggil
// langsung lewat DevTools/curl. Semua aturan wewenang di sini hanya
// mencerminkan pagar yang sesungguhnya berdiri di server (auth.py +
// _require_admin di server.py). Kalau keduanya berbeda, yang benar server.
// ════════════════════════════════════════════════════════════════
const _ROLE_LABEL = { administrator: 'Administrator', user: 'User', pelanggan: 'Pelanggan' };

function _acctDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric',
                                     hour: '2-digit', minute: '2-digit' });
}

function _acctInitials(name, username) {
  const src = String(name || username || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* Ukuran kekuatan password. Sengaja mencerminkan password_problem() di
   auth.py: kalau meter bilang "kuat" tapi server menolak, itu justru
   membingungkan. Server tetap pemutusnya — ini hanya umpan balik. */
function _pwStrength(pw) {
  pw = String(pw || '');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(re => re.test(pw)).length;
  if (!pw.length)                     return { pct: 0,   label: '—',            cls: '' };
  if (pw.length < 10)                 return { pct: 25,  label: 'Terlalu pendek (min. 10)', cls: 'pw-weak' };
  if (classes < 3)                    return { pct: 45,  label: 'Kurang variasi karakter',  cls: 'pw-weak' };
  if (pw.length < 14)                 return { pct: 72,  label: 'Cukup kuat',    cls: 'pw-ok' };
  return                                     { pct: 100, label: 'Kuat',          cls: 'pw-strong' };
}

function _pwMeterBind(inputId, meterId, fillId, textId) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.addEventListener('input', function () {
    const m = document.getElementById(meterId);
    const f = document.getElementById(fillId);
    const t = document.getElementById(textId);
    const s = _pwStrength(inp.value);
    if (m) m.hidden = !inp.value;
    if (f) { f.style.width = s.pct + '%'; f.className = s.cls; }
    if (t) t.textContent = s.label;
  });
}

// ─── Akun Saya ────────────────────────────────────────────────────
function renderMyAccount() {
  const u = App.user;
  if (!u) return;

  const txt = document.getElementById('myAvatarTxt');
  if (txt) txt.textContent = _acctInitials(u.name, u.username);
  // Foto profil per pengguna belum ada; strukturnya sudah siap menerimanya —
  // begitu u.avatar terisi URL, <img> tinggal tampil tanpa mengubah layout.
  const img = document.getElementById('myAvatarImg');
  if (img) {
    if (u.avatar) { img.src = u.avatar; img.hidden = false; }
    else { img.hidden = true; img.removeAttribute('src'); }
  }
  const wrap = document.getElementById('myAvatar');
  if (wrap) wrap.classList.toggle('has-photo', !!u.avatar);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('myHeroName', u.name || u.username);
  set('myHeroUser', '@' + u.username);
  set('myHeroEmail', u.email || '—');
  set('myHeroPhone', u.phone || '—');
  set('myHeroLogin', _acctDate(u.lastLogin));
  set('myHeroCreated', _acctDate(u.createdAt));

  const role = document.getElementById('myHeroRole');
  if (role) {
    role.innerHTML = '<i class="fas fa-shield-halved"></i> ' + (_ROLE_LABEL[u.role] || u.role);
    role.className = 'acct-role role-' + u.role;
  }
  const st = document.getElementById('myHeroStatus');
  if (st) {
    const aktif = (u.status || 'aktif') === 'aktif';
    st.textContent = aktif ? 'Aktif' : 'Nonaktif';
    st.className = 'acct-status ' + (aktif ? 'st-on' : 'st-off');
  }

  _setVal('myName', u.name);
  _setVal('myUsername', u.username);
  _setVal('myEmail', u.email);
  _setVal('myPhone', u.phone);
}

async function saveMyProfile() {
  const btn = document.getElementById('btnSaveMyProfile');
  const body = {
    name:     _getVal('myName').trim(),
    username: _getVal('myUsername').trim(),
    email:    _getVal('myEmail').trim(),
    phone:    _getVal('myPhone').trim(),
  };
  if (!body.name) { showToast('Nama tidak boleh kosong', 'error'); return; }
  setBtnBusy(btn, true);
  try {
    const d = await authFetch('/auth/users/' + App.user.id, { method: 'PATCH', body });
    applyUser(d.user);          // header & sapaan ikut berubah seketika
    renderMyAccount();
    showToast('Data akun disimpan', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeMyPassword() {
  const btn  = document.getElementById('btnChangeMyPass');
  const oldP = _getVal('myOldPass');
  const newP = _getVal('myNewPass');
  const conf = _getVal('myConfPass');
  if (!oldP)            { showToast('Password lama wajib diisi', 'error'); return; }
  if (newP !== conf)    { showToast('Konfirmasi password tidak sama', 'error'); return; }
  if (newP === oldP)    { showToast('Password baru sama dengan password lama', 'error'); return; }

  setBtnBusy(btn, true);
  try {
    await authFetch('/auth/users/' + App.user.id, {
      method: 'PATCH',
      body: { password: newP, currentPassword: oldP },
    });
    ['myOldPass', 'myNewPass', 'myConfPass'].forEach(id => _setVal(id, ''));
    const m = document.getElementById('myPwMeter'); if (m) m.hidden = true;
    // Server mencabut SEMUA sesi user ini saat password berganti — termasuk
    // sesi ini. Jadi tidak ada gunanya berpura-pura masih login: antar saja
    // kembali ke layar masuk dengan penjelasan.
    showToast('Password diganti. Silakan masuk kembali.', 'success');
    setTimeout(() => { App.user = null; keLogin(false); }, 1200);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

// ─── Manajemen Akun (administrator) ───────────────────────────────
let _usrCache = [];
let _usrEditId = null;

async function renderUsersTable() {
  const tb = document.getElementById('usrTableBody');
  if (!tb) return;
  try {
    const d = await authFetch('/auth/users');
    _usrCache = d.users || [];
  } catch (e) {
    tb.innerHTML = '<tr><td colspan="6" class="vm-empty-row">Gagal memuat: ' + _vmEsc(e.message) + '</td></tr>';
    return;
  }
  const badge = document.getElementById('usersCountBadge');
  if (badge) badge.textContent = _usrCache.length;
  _usrFilterRender();
  // SN milik akun pelanggan (khusus administrator — server menolak role lain).
  if (isAdmin()) {
    _usrCache.filter(function(u) { return u.role === 'pelanggan'; }).forEach(function(u) {
      authFetch('/config/akun-onu/' + encodeURIComponent(u.id)).then(function(d) {
        _usrOnu[u.id] = d.onu || [];
        _usrFilterRender();
      }).catch(function() { /* daftar akun tetap tampil tanpa SN */ });
    });
  }
}
let _usrOnu = {};          // userId → [{id, sn}] untuk akun ber-role pelanggan
let _usrRole = '';         // saringan role di atas tabel ('' = ALL)

function _usrFilterRender() {
  const tb = document.getElementById('usrTableBody');
  if (!tb) return;
  // Angka di tombol saringan = jumlah akun tiap role (seluruhnya, bukan hasil pencarian).
  document.querySelectorAll('#usrRoleFilter .seg-btn').forEach(function(b) {
    const r = b.dataset.role || '', n = b.querySelector('.seg-n');
    b.classList.toggle('on', r === _usrRole);
    if (n) n.textContent = r ? _usrCache.filter(function(u) { return u.role === r; }).length : _usrCache.length;
  });
  const q = (_getVal('usrSearch') || '').trim().toLowerCase();
  const rows = _usrCache.filter(u => (!_usrRole || u.role === _usrRole) && (!q ||
    (u.name || '').toLowerCase().includes(q) ||
    (u.username || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q)));

  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6" class="vm-empty-row">'
      + (q || _usrRole ? 'Tidak ada akun yang cocok dengan saringan' : 'Belum ada akun') + '</td></tr>';
    return;
  }

  const me = App.user ? App.user.id : '';
  // Role user yang diberi izin "Manajemen Akun" hanya MELIHAT: tombol ubah/hapus tidak
  // digambar sama sekali (server toh menolaknya — lihat auth.update_user/delete_user).
  const admin = isAdmin();
  tb.innerHTML = rows.map(u => {
    const aktif = (u.status || 'aktif') === 'aktif';
    const self  = u.id === me;
    return '<tr>'
      + '<td><div class="usr-cell">'
        + '<span class="usr-ava">' + _vmEsc(_acctInitials(u.name, u.username)) + '</span>'
        + '<span class="usr-id"><b>' + _vmEsc(u.name || u.username) + '</b>'
        + '<small>@' + _vmEsc(u.username) + (self ? ' · Anda' : '') + '</small></span>'
      + '</div></td>'
      + '<td><span class="usr-contact">' + _vmEsc(u.email || '—')
        + '<small>' + _vmEsc(u.phone || '—') + '</small></span></td>'
      + '<td><span class="acct-role role-' + _vmEsc(u.role) + '">'
        + '<i class="fas fa-shield-halved"></i> ' + _vmEsc(_ROLE_LABEL[u.role] || u.role) + '</span>'
        + (u.role === 'pelanggan' && _usrOnu[u.id] && _usrOnu[u.id].length
            ? '<small class="usr-onu">' + _usrOnu[u.id].map(function(o) { return _vmEsc(o.sn); }).join(', ') + '</small>' : '')
        + '</td>'
      + '<td><span class="acct-status ' + (aktif ? 'st-on' : 'st-off') + '">'
        + (aktif ? 'Aktif' : 'Nonaktif') + '</span></td>'
      + '<td><span class="usr-last">' + _vmEsc(_acctDate(u.lastLogin)) + '</span></td>'
      + (!admin ? '<td><span class="usr-lihat" title="Hanya administrator yang bisa mengubah akun">'
                  + '<i class="fas fa-eye"></i> lihat saja</span></td>' : '<td><div class="usr-acts">'
        + '<button class="usr-act" data-act="edit" data-id="' + _vmEsc(u.id) + '" title="Ubah akun">'
          + '<i class="fas fa-pen"></i></button>'
        + '<button class="usr-act" data-act="toggle" data-id="' + _vmEsc(u.id) + '" title="'
          + (aktif ? 'Nonaktifkan akun' : 'Aktifkan akun') + '"' + (self ? ' disabled' : '') + '>'
          + '<i class="fas fa-' + (aktif ? 'user-slash' : 'user-check') + '"></i></button>'
        + '<button class="usr-act usr-act-danger" data-act="del" data-id="' + _vmEsc(u.id) + '" title="'
          + (self ? 'Tidak bisa menghapus akun sendiri' : 'Hapus akun') + '"' + (self ? ' disabled' : '') + '>'
          + '<i class="fas fa-trash"></i></button>'
      + '</div></td>')
      + '</tr>';
  }).join('');
}

function openUserModal(id) {
  _usrEditId = id || null;
  const u = id ? _usrCache.find(x => x.id === id) : null;
  const title = document.getElementById('usrModalTitle');
  if (title) title.innerHTML = u
    ? '<i class="fas fa-user-pen"></i> Ubah Akun'
    : '<i class="fas fa-user-plus"></i> Tambah Akun';

  _setVal('usrName',     u ? u.name : '');
  _setVal('usrUsername', u ? u.username : '');
  _setVal('usrEmail',    u ? u.email : '');
  _setVal('usrPhone',    u ? u.phone : '');
  _setVal('usrRole',     u ? u.role : 'user');
  _setVal('usrStatus',   u ? (u.status || 'aktif') : 'aktif');
  _setVal('usrPass',     '');
  _setVal('usrOnuSn',    u && _usrOnu[u.id] ? _usrOnu[u.id].map(function(o) { return o.sn; }).join(', ') : '');
  _usrOnuToggle();

  const lbl  = document.getElementById('usrPassLabel');
  const hint = document.getElementById('usrPassHint');
  if (lbl)  lbl.textContent = u ? 'Reset Password (opsional)' : 'Password';
  if (hint) hint.textContent = u
    ? 'Kosongkan bila password tidak diganti. Mengganti password akan mengeluarkan pengguna dari semua perangkat.'
    : 'Minimal 10 karakter, memuat 3 dari: huruf kecil, huruf besar, angka, simbol';
  const m = document.getElementById('usrPwMeter'); if (m) m.hidden = true;

  openModal('usrModal');
  setTimeout(() => { const n = document.getElementById('usrName'); if (n) n.focus(); }, 60);
}

// Kolom SN hanya untuk role pelanggan.
function _usrOnuToggle() {
  const g = document.getElementById('usrOnuGrup');
  if (g) g.hidden = _getVal('usrRole') !== 'pelanggan';
}

async function saveUser() {
  const btn = document.getElementById('btnUsrSave');
  const body = {
    name:     _getVal('usrName').trim(),
    username: _getVal('usrUsername').trim(),
    email:    _getVal('usrEmail').trim(),
    phone:    _getVal('usrPhone').trim(),
    role:     _getVal('usrRole'),
    status:   _getVal('usrStatus'),
  };
  const pw = _getVal('usrPass');
  if (!body.name)     { showToast('Nama tidak boleh kosong', 'error'); return; }
  if (!body.username) { showToast('Username tidak boleh kosong', 'error'); return; }
  if (!_usrEditId && !pw) { showToast('Password wajib diisi untuk akun baru', 'error'); return; }
  if (pw) body.password = pw;

  setBtnBusy(btn, true);
  try {
    let uid = _usrEditId;
    if (_usrEditId) {
      await authFetch('/auth/users/' + _usrEditId, { method: 'PATCH', body });
      showToast('Akun diperbarui', 'success');
      // Bila yang diubah adalah diri sendiri, header & "Akun Saya" ikut basi.
      if (_usrEditId === (App.user || {}).id) {
        try { applyUser((await authFetch('/auth/me')).user); renderMyAccount(); } catch (_) {}
      }
    } else {
      const baru = await authFetch('/auth/users', { method: 'POST', body });
      uid = baru && baru.user && baru.user.id;
      showToast('Akun dibuat', 'success');
    }
    if (body.role === 'pelanggan' && uid) {
      const sn = (_getVal('usrOnuSn') || '').split(/[\s,;]+/).map(function(x) { return x.trim(); }).filter(Boolean);
      try {
        const r = await authFetch('/config/akun-onu/' + encodeURIComponent(uid), { method: 'POST', body: { sn: sn } });
        _usrOnu[uid] = r.onu || [];
        showToast('ONU pelanggan: ' + (_usrOnu[uid].map(function(o) { return o.sn; }).join(', ') || 'belum ada'), 'success');
      } catch (e) {
        showToast('Akun tersimpan, tetapi ONU belum terpasang: ' + e.message, 'error');
      }
    }
    closeModal('usrModal');
    renderUsersTable();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

function toggleUserStatus(id) {
  const u = _usrCache.find(x => x.id === id);
  if (!u) return;
  const aktif = (u.status || 'aktif') === 'aktif';
  const next  = aktif ? 'nonaktif' : 'aktif';
  const who   = _vmEsc(u.name || u.username);

  showConfirm({
    title: aktif ? 'Nonaktifkan akun?' : 'Aktifkan akun?',
    icon:  aktif ? 'fa-user-slash' : 'fa-user-check',
    danger: aktif,
    yesLabel: aktif ? 'Nonaktifkan' : 'Aktifkan',
    message: aktif
      ? '<p>Akun <b>' + who + '</b> tidak akan bisa masuk lagi, dan sesinya yang sedang aktif '
        + 'akan langsung diputus.</p><p style="margin-top:8px;color:var(--text-muted)">'
        + 'Datanya tidak dihapus — akun bisa diaktifkan kembali kapan saja.</p>'
      : '<p>Akun <b>' + who + '</b> akan bisa masuk kembali ke panel.</p>',
  }, async () => {
    try {
      await authFetch('/auth/users/' + id, { method: 'PATCH', body: { status: next } });
      showToast(aktif ? 'Akun dinonaktifkan' : 'Akun diaktifkan', 'success');
      renderUsersTable();
    } catch (e) { showToast(e.message, 'error'); }
  });
}

function deleteUserAccount(id) {
  const u = _usrCache.find(x => x.id === id);
  if (!u) return;
  const who = _vmEsc(u.name || u.username);

  showConfirm({
    title: 'Hapus akun permanen?',
    icon: 'fa-triangle-exclamation',
    danger: true,
    yesLabel: 'Hapus Akun',
    requireText: 'HAPUS',
    message:
      '<p>Akun <b>' + who + '</b> (@' + _vmEsc(u.username) + ') akan <b>dihapus permanen</b> '
      + 'dan sesinya langsung diputus.</p>'
      + '<p style="margin-top:8px"><b>Tindakan ini tidak dapat dibatalkan.</b> '
      + 'Untuk mencabut akses sementara, gunakan <b>Nonaktifkan</b> — datanya tetap utuh '
      + 'dan bisa dipulihkan.</p>'
      + '<p style="margin-top:8px;color:var(--text-muted)">Jejak aktivitas akun ini tetap '
      + 'tersimpan di audit log.</p>',
  }, async () => {
    try {
      await authFetch('/auth/users/' + id, { method: 'DELETE' });
      showToast('Akun dihapus', 'success');
      renderUsersTable();
    } catch (e) { showToast(e.message, 'error'); }
  });
}

function _initAccount() {
  renderMyAccount();

  const bp = document.getElementById('btnSaveMyProfile');
  if (bp) bp.addEventListener('click', saveMyProfile);
  const bc = document.getElementById('btnChangeMyPass');
  if (bc) bc.addEventListener('click', changeMyPassword);
  _pwMeterBind('myNewPass', 'myPwMeter', 'myPwFill', 'myPwText');
  _pwMeterBind('usrPass',   'usrPwMeter', 'usrPwFill', 'usrPwText');
  const rl = document.getElementById('usrRole');
  if (rl) rl.addEventListener('change', _usrOnuToggle);

  const add = document.getElementById('btnAddUser');
  if (add) add.addEventListener('click', () => openUserModal(null));
  const search = document.getElementById('usrSearch');
  if (search) search.addEventListener('input', _usrFilterRender);
  const saring = document.getElementById('usrRoleFilter');
  if (saring) saring.addEventListener('click', function(e) {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    _usrRole = b.dataset.role || '';
    _usrFilterRender();
  });
  const save = document.getElementById('btnUsrSave');
  if (save) save.addEventListener('click', saveUser);
  _bindModal('usrModal', 'btnUsrClose', 'btnUsrCancel');

  const gen = document.getElementById('btnUsrGenPass');
  if (gen) gen.addEventListener('click', () => {
    const pw = _genPassword();
    _setVal('usrPass', pw);
    const inp = document.getElementById('usrPass');
    if (inp) { inp.type = 'text'; inp.dispatchEvent(new Event('input')); }
    copyWithFeedback(pw, gen, 'Tersalin');
  });

  // Delegasi: baris tabel digambar ulang terus-menerus, jadi listener
  // ditempel sekali di tbody — bukan di tiap tombol.
  const tb = document.getElementById('usrTableBody');
  if (tb) tb.addEventListener('click', function (e) {
    const b = e.target.closest('.usr-act');
    if (!b || b.disabled) return;
    const id = b.dataset.id;
    if (b.dataset.act === 'edit')   openUserModal(id);
    if (b.dataset.act === 'toggle') toggleUserStatus(id);
    if (b.dataset.act === 'del')    deleteUserAccount(id);
  });

  const izin = document.getElementById('izinDaftar');
  if (izin) izin.addEventListener('change', _izinCekUbah);
  const izinSimpan = document.getElementById('btnIzinSimpan');
  if (izinSimpan) izinSimpan.addEventListener('click', simpanIzinRole);
}

// ─── Hak Akses Role User (administrator) ──────────────────────────
// Label & penjelasan tiap kunci izin. Kuncinya sama dengan config_store.IZIN_KUNCI
// (dijaga tests/izinrole.test.py); urutan dan daftar yang digambar mengikuti server.
// Tanda "berisiko": menu yang mengubah apa yang ditulis ke ONU pelanggan atau ke
// mana seluruh panel terhubung — salah isi berdampak ke semua teknisi sekaligus.
const _IZIN_INFO = {
  akunSaya:       ['Akun Saya', 'Profil & password sendiri — selalu terbuka.'],
  manajemenAkun:  ['Manajemen Akun', 'Hanya MELIHAT daftar akun. Menambah, mengubah, dan menghapus akun tetap khusus administrator.'],
  koneksiAcs:     ['Koneksi ACS', 'Melihat & mengubah alamat GenieACS. Salah isi membuat seluruh panel kehilangan data ONU.', true],
  parameter:      ['Parameter Aplikasi', 'Ambang RX, batas online, jumlah baris, interval refresh — berlaku untuk semua akun.'],
  keselamatan:    ['Keselamatan ONU', 'Menyalakan & mematikan Mode Aman (penghenti semua perintah ke ONU).', true],
  kesehatan:      ['Kesehatan ACS', 'Melihat perintah gagal & antrean GenieACS, dan membersihkan antrean lama.'],
  pemetaanVp:     ['Pemetaan Parameter', 'Mengubah dari mana panel membaca RX, PPPoE, suhu, dan lainnya.', true],
  tampilan:       ['Tampilan', 'Tema terang/gelap — pribadi, hanya untuk akunnya sendiri.'],
  vendorWan:      ['Vendor Configuration', 'Profil WAN per model ONU — menentukan parameter yang DITULIS ke ONU pelanggan.', true],
  vendorSecurity: ['Security Setting', 'Profil WiFi & akun web per model ONU — menentukan parameter yang DITULIS ke ONU.', true],
  tentang:        ['Tentang Sistem', 'Versi aplikasi & status server.'],
  buatTag:        ['Buat Tag (menu Device)', 'Membuat tag baru (mis. MITRA-SURYA) dan memasang/melepasnya pada ONU. Menghapus nama tag tetap khusus administrator.'],
};
let _izinData = null;        // jawaban GET /config/izin-role yang terakhir

async function renderIzinRole() {
  const box = document.getElementById('izinDaftar');
  if (!box || !isAdmin()) return;
  try {
    _izinData = await authFetch('/config/izin-role');
  } catch (e) {
    box.innerHTML = '<div class="izin-muat">Gagal memuat: ' + _vmEsc(e.message) + '</div>';
    return;
  }
  const punya = (_izinData.role && _izinData.role.user) || [];
  const wajib = _izinData.wajib || [];
  // data-izin-kunci, BUKAN data-izin: atribut data-izin dipakai applyRoleVisibility()
  // untuk menyembunyikan elemen — barisnya akan ikut lenyap.
  box.innerHTML = (_izinData.kunci || []).map(function (k) {
    const info = _IZIN_INFO[k] || [k, ''];
    const tetap = wajib.indexOf(k) !== -1;
    return '<label class="izin-baris' + (tetap ? ' tetap' : '') + '">'
      + '<input type="checkbox" data-izin-kunci="' + _vmEsc(k) + '"'
      + (tetap || punya.indexOf(k) !== -1 ? ' checked' : '') + (tetap ? ' disabled' : '') + '>'
      + '<span class="izin-teks"><span class="izin-judul"><b>' + _vmEsc(info[0]) + '</b>'
      + (info[2] ? '<span class="izin-tanda risiko">berisiko</span>' : '')
      + (tetap ? '<span class="izin-tanda">selalu</span>' : '') + '</span>'
      + '<small>' + _vmEsc(info[1]) + '</small></span>'
      + '</label>';
  }).join('');
  _izinCekUbah();
}

function _izinTerpilih() {
  return Array.from(document.querySelectorAll('#izinDaftar input[data-izin-kunci]:checked'))
    .map(function (el) { return el.dataset.izinKunci; });
}

function _izinCekUbah() {
  const btn = document.getElementById('btnIzinSimpan');
  const st  = document.getElementById('izinStatus');
  if (!btn || !_izinData) return;
  const berubah = _izinTerpilih().join(',') !== ((_izinData.role && _izinData.role.user) || []).join(',');
  btn.disabled = !berubah;
  if (st) st.textContent = berubah ? 'Ada perubahan yang belum disimpan.' : '';
}

function simpanIzinRole() {
  const btn = document.getElementById('btnIzinSimpan');
  if (!_izinData) return;
  const izin = _izinTerpilih();
  const lama = (_izinData.role && _izinData.role.user) || [];
  const kirim = async function () {
    setBtnBusy(btn, true);
    try {
      const r = await authFetch('/config/izin-role', { method: 'POST', body: { role: 'user', izin: izin } });
      _izinData.role.user = r.izin;
      showToast('Hak akses role user disimpan — langsung berlaku di server', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBtnBusy(btn, false);
      _izinCekUbah();
      const st = document.getElementById('izinStatus');
      if (st && btn.disabled) st.textContent = 'Tersimpan. Akun yang sedang login melihat menunya '
        + 'berubah saat membuka Settings berikutnya.';
    }
  };
  // Membuka menu berisiko untuk SEMUA akun role user sekaligus pantas dikonfirmasi.
  const baruBerisiko = izin.filter(function (k) {
    return lama.indexOf(k) === -1 && _IZIN_INFO[k] && _IZIN_INFO[k][2];
  });
  if (!baruBerisiko.length) { kirim(); return; }
  showConfirm({
    title: 'Buka menu berisiko?',
    icon: 'fa-triangle-exclamation',
    danger: true,
    yesLabel: 'Ya, buka',
    message: '<p>Semua akun ber-role <b>user</b> akan bisa membuka <b>dan mengubah</b>:</p><ul style="margin:8px 0 0 18px">'
      + baruBerisiko.map(function (k) {
          return '<li><b>' + _vmEsc(_IZIN_INFO[k][0]) + '</b> — ' + _vmEsc(_IZIN_INFO[k][1]) + '</li>';
        }).join('')
      + '</ul><p style="margin-top:8px;color:var(--text-muted)">Setiap perubahan tetap tercatat di audit log '
      + 'beserta pelakunya.</p>',
  }, kirim);
}

/* Password acak sisi klien. Cermin dari generate_password() di auth.py:
   satu karakter dari tiap kelas dulu, baru sisanya acak — kalau murni acak,
   hasilnya kadang tidak memenuhi kebijakan server dan ditolak secara acak. */
function _genPassword(len) {
  len = len || 16;
  const pools = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ',
                 '23456789', '!@#$%^&*?-_'];
  const rnd = n => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  };
  const all = pools.join('');
  const out = pools.map(p => p[rnd(p.length)]);
  while (out.length < len) out.push(all[rnd(all.length)]);
  for (let i = out.length - 1; i > 0; i--) {          // Fisher–Yates
    const j = rnd(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

// ════════════════════════════════════════════════════════════════
// MENU SYSTEM — pemasangan pemicu
// ════════════════════════════════════════════════════════════════
function _initSystem() {
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };

  on('btnSaveAcs', 'click', saveAcsConfig);
  on('btnTestAcs', 'click', testAcsConnection);
  on('acsAuthEnabled', 'change', _acsAuthToggle);
  ['acsProtocol', 'acsHost', 'acsPort', 'acsBasePath'].forEach(id => {
    on(id, 'input', _acsUrlPreview);
    on(id, 'change', _acsUrlPreview);
  });

  on('btnSaveParam', 'click', saveParamConfig);
  on('cfgRxGood', 'input', _renderRxPreview);
  on('cfgRxFair', 'input', _renderRxPreview);

  on('btnAboutRefresh', 'click', renderAbout);
  on('btnUpdPeriksa', 'click', periksaPembaruan);
  on('btnUpdPasang', 'click', pasangPembaruan);
  on('btnCadUnduh', 'click', bukaCadModal);
  on('btnCadKirim', 'click', unduhCadangan);
  _bindModal('cadModal', 'btnCadClose', 'btnCadCancel');
}

// ════════════════════════════════════════════════════════════════
// SIDEBAR NAVIGATION
// ════════════════════════════════════════════════════════════════
function _stNavInit() {
  const items = document.querySelectorAll('.st-nav-item');
  items.forEach(function(btn) {
    btn.addEventListener('click', function() {
      items.forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.st-section').forEach(function(s) { s.classList.add('hidden'); });
      btn.classList.add('active');
      const sec = document.getElementById(btn.dataset.section);
      if (sec) sec.classList.remove('hidden');
      // Lazy-render tables when section is shown
      if (btn.dataset.section === 'stSecVendorCfg') renderVcfgTable();
      if (btn.dataset.section === 'stSecSecurity')  renderVmSecTable();
      if (btn.dataset.section === 'stSecUsers')     { renderUsersTable(); renderIzinRole(); }
      if (btn.dataset.section === 'stSecMyAccount') renderMyAccount();
      if (btn.dataset.section === 'stSecAbout')     renderAbout();
      if (btn.dataset.section === 'stSecPagar')     renderPagar();
      if (btn.dataset.section === 'stSecKesehatan') renderKesehatan();
      if (btn.dataset.section === 'stSecVpMap')     renderVpMap();
    });
  });
}

/* Kelompok menu (AKUN, SISTEM, …) yang seluruh isinya tersembunyi ikut disembunyikan:
   role user bawaan hanya melihat "Akun Saya" & "Tentang Sistem", dan judul "SISTEM"
   tanpa isi di bawahnya terlihat seperti menu yang rusak. Bila menu yang sedang aktif
   ternyata tak boleh dibuka (izinnya baru dicabut), pindah ke menu pertama yang boleh. */
function _stNavRapikan() {
  const nav = document.querySelector('.st-nav');
  if (!nav) return;
  let judul = null, ikut = [], adaIsi = false;
  const tutup = function () {
    if (!judul) return;
    judul.hidden = !adaIsi;
    ikut.forEach(function (el) { el.hidden = !adaIsi; });
  };
  Array.from(nav.children).forEach(function (el) {
    if (el.classList.contains('st-nav-group')) { tutup(); judul = el; ikut = []; adaIsi = false; }
    else if (el.classList.contains('st-nav-sublabel')) ikut.push(el);
    else if (el.classList.contains('st-nav-item') && !el.hidden) adaIsi = true;
  });
  tutup();
  const aktif = nav.querySelector('.st-nav-item.active');
  if (!aktif || aktif.hidden) {
    const pertama = nav.querySelector('.st-nav-item:not([hidden])');
    if (pertama) pertama.click();
  }
}

function _stUpdateBadges() {
  const vcEl = document.getElementById('vcfgCountBadge');
  const vsEl = document.getElementById('vmsecCountBadge');
  if (vcEl) vcEl.textContent = _vcfgLoad().length;
  if (vsEl) vsEl.textContent = _vmSecLoad().length;
}

// ════════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ════════════════════════════════════════════════════════════════
function _vmEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _vmUid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function _vmFld(id, val) {
  var el = document.getElementById(id); if (el) el.value = val || '';
}
// Checkbox helpers (multi-vendor feature flags)
function _vmChk(id, val) { var el = document.getElementById(id); if (el) el.checked = !!val; }
function _vmChkGet(id)   { var el = document.getElementById(id); return el ? !!el.checked : false; }
function _bindModal(overlayId, closeBtnId, cancelBtnId) {
  var overlay   = document.getElementById(overlayId);
  var closeBtn  = document.getElementById(closeBtnId);
  var cancelBtn = document.getElementById(cancelBtnId);
  if (overlay)   overlay.addEventListener('click',  function(e) { if (e.target === overlay) overlay.classList.add('hidden'); });
  if (closeBtn)  closeBtn.addEventListener('click',  function() { overlay.classList.add('hidden'); });
  if (cancelBtn) cancelBtn.addEventListener('click', function() { overlay.classList.add('hidden'); });
}

// ════════════════════════════════════════════════════════════════
// VENDOR CONFIG — WAN Account (PPPoE / Bridge / DHCP / Static)
// localStorage key: 'acs_vendor_wan'
// ════════════════════════════════════════════════════════════════
const _VCFG_KEY = 'acs_vendor_wan';

function _vcfgLoad() {
  try { return JSON.parse(localStorage.getItem(_VCFG_KEY) || '[]'); } catch { return []; }
}
function _vcfgSave(list) {
  localStorage.setItem(_VCFG_KEY, JSON.stringify(list));
}

/* ─── Profil vendor disimpan di SERVER (2026-10-03) ───────────────────────────
   localStorage turun pangkat menjadi CACHE (sama seperti acsConfig): dibaca sinkron
   oleh seluruh kode lama, tetapi isinya mengikuti server. Menyimpan dari form =
   kirim ke server dulu; bila server menolak (bukan administrator, isian tak sah,
   server tak terjangkau) cache dikembalikan ke keadaan semula — supaya tidak ada
   browser yang diam-diam memakai profil berbeda dari teknisi lain.              */
var _PROFIL_KUNCI = { wan: 'acs_vendor_wan', security: 'acs_vendor_security' };

// Dipanggil saat boot (main.js) & saat halaman Settings dibuka.
function terapkanProfilServer(vp) {
  if (!vp) return;
  Object.keys(_PROFIL_KUNCI).forEach(function(kind) {
    if (Array.isArray(vp[kind])) localStorage.setItem(_PROFIL_KUNCI[kind], JSON.stringify(vp[kind]));
  });
}

// simpanFn: fungsi yang menulis cache (mis. _vmSecSave). Kembalian: Promise<boolean>.
function simpanProfilServer(kind, daftarBaru, daftarLama, render) {
  localStorage.setItem(_PROFIL_KUNCI[kind], JSON.stringify(daftarBaru));
  if (typeof authFetch !== 'function') return Promise.resolve(true);   // uji / tanpa server
  return authFetch('/config/vendor-profiles', { method: 'POST', body: { kind: kind, list: daftarBaru } })
    .then(function() { return true; })
    .catch(function(e) {
      localStorage.setItem(_PROFIL_KUNCI[kind], JSON.stringify(daftarLama));
      if (typeof render === 'function') render();
      var pesan = (e && e.status === 403) ? 'Anda belum diberi izin mengubah profil vendor ini.'
                : 'Profil TIDAK tersimpan di server: ' + ((e && e.message) || 'galat') + '. Perubahan dibatalkan.';
      showToast(pesan, 'error');
      return false;
    });
}

// ─── Pencocokan vendor BERLAPIS (specificity) — dipakai WAN & Security ───
// Prioritas: (1) OUI + Product, (2) Manufacturer + Product, (3) Product saja.
// Tanpa entri Manufacturer/OUI, hasilnya identik dengan pencocokan Product-only lama
// (backward-compatible / aman produksi).
function _vendorMatch(entries, productClass, oui, manufacturer) {
  var pc = (productClass  || '').trim().toLowerCase();
  var ou = (oui           || '').trim().toUpperCase();
  var mf = (manufacturer  || '').trim().toLowerCase();
  function eOui(e){ return (e.oui || '').trim().toUpperCase(); }
  function eMfr(e){ return (e.manufacturer || '').trim().toLowerCase(); }
  function hasPc(e){ return !!(e && e.productClasses && e.productClasses.trim()); }
  function pcMatch(e){
    return hasPc(e) && pc &&
      e.productClasses.split(',').map(function(s){ return s.trim().toLowerCase(); }).indexOf(pc) !== -1;
  }
  // pcOk = cocok produk ATAU entri tanpa Product Class (wildcard — berlaku untuk semua produk).
  // Ini yang membuat entri "OUI saja" otomatis cocok ke ONU ber-OUI itu tanpa perlu Product Class.
  function pcOk(e){ return !hasPc(e) || pcMatch(e); }
  var i, e;
  // Tier 1 — OUI (paling spesifik). Product Class opsional → OUI bisa berdiri sendiri.
  if (ou) for (i = 0; i < entries.length; i++) { e = entries[i]; if (eOui(e) === ou && pcOk(e)) return e; }
  // Tier 2 — Manufacturer (Product Class opsional)
  if (mf) for (i = 0; i < entries.length; i++) { e = entries[i]; if (!eOui(e) && eMfr(e) === mf && pcOk(e)) return e; }
  // Tier 3 — Product saja (wajib ada Product Class; tanpa OUI & Manufacturer) — perilaku lama
  for (i = 0; i < entries.length; i++) { e = entries[i]; if (!eOui(e) && !eMfr(e) && pcMatch(e)) return e; }
  return null;
}

// ─── DESAIN 3-LAPIS: rantai pencocokan untuk WARISAN ───
// Kembalikan entri yang cocok diurut dari paling UMUM → paling SPESIFIK:
//   [ Product, Manufacturer+Product, OUI ]  (maks 1 per tier; tier yang tak cocok dilewati).
// Pemanggil me-merge berurutan sehingga lapis lebih spesifik menimpa lapis umum
// (mis. OUI EC6CB5 hanya mengubah beaconOpen, sisanya warisan dari profil ZTE+F663NV9).
function _vendorMatchChain(entries, productClass, oui, manufacturer) {
  var pc = (productClass || '').trim().toLowerCase();
  var ou = (oui          || '').trim().toUpperCase();
  var mf = (manufacturer || '').trim().toLowerCase();
  function eOui(e){ return (e.oui || '').trim().toUpperCase(); }
  function eMfr(e){ return (e.manufacturer || '').trim().toLowerCase(); }
  function hasPc(e){ return !!(e && e.productClasses && e.productClasses.trim()); }
  function pcMatch(e){
    return hasPc(e) && pc &&
      e.productClasses.split(',').map(function(s){ return s.trim().toLowerCase(); }).indexOf(pc) !== -1;
  }
  function pcOk(e){ return !hasPc(e) || pcMatch(e); }
  function firstWhere(fn){ for (var i = 0; i < entries.length; i++){ if (fn(entries[i])) return entries[i]; } return null; }
  var chain = [], hit;
  // Lapis umum: Product saja
  hit = firstWhere(function(e){ return !eOui(e) && !eMfr(e) && pcMatch(e); }); if (hit) chain.push(hit);
  // Lapis tengah: Manufacturer (+Product opsional)
  if (mf) { hit = firstWhere(function(e){ return !eOui(e) && eMfr(e) === mf && pcOk(e); }); if (hit) chain.push(hit); }
  // Lapis spesifik: OUI (+Product opsional)
  if (ou) { hit = firstWhere(function(e){ return eOui(e) === ou && pcOk(e); }); if (hit) chain.push(hit); }
  return chain;
}

// PUBLIC — called by device-detail.js / api.js. manufacturer & oui opsional (backward-compatible).
function getVendorWanConfig(productClass, oui, manufacturer) {
  // localStorage diutamakan (override user), default sebagai cadangan.
  return _vendorMatch(_vcfgLoad().concat(_vcfgDefaults()), productClass, oui, manufacturer);
}

// ════════════════════════════════════════════════════════════════
// FASE 1 — WAN PROFILE (skema lengkap multi-vendor)
// Default = profil F663NV9 (CMCC) yang nilainya IDENTIK dengan path
// hardcoded di device-detail.js saat ini (behavior-preserving).
// getWanProfile() menggabungkan entri tersimpan (acs_vendor_wan) DI ATAS
// default ini. Belum dipakai device-detail (Fase 3) → nol efek runtime.
// CATATAN: getVendorWanConfig() di atas TIDAK diubah (dipakai api.js untuk rebootParam).
// ════════════════════════════════════════════════════════════════
var WAN_PROFILE_DEFAULT = {
  label:       'ZTE CMCC (F663 family)',
  dataModel:   'TR098',
  wanRoot:     'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.',
  connChildPpp:'WANPPPConnection',
  connChildIp: 'WANIPConnection',
  paramPrefix: 'X_CMCC_',   // informatif untuk vendor baru; default menyimpan nama param penuh
  features: { vlan:true, ipMode:true, lanBinding:true, ipv6:true, cos:true, nat:true, mtu:true, pppServiceName:false, canAddDelete:true },
  // Nama param PENUH (persis seperti yang dikirim device-detail.js sekarang)
  params: {
    service:              'X_CMCC_ServiceList',
    vlanId:               'X_CMCC_VLANIDMark',
    vlanMode:             'X_CMCC_VLANMode',
    cos:                  'X_CMCC_802-1pMark',
    nat:                  'NATEnabled',
    mtuPpp:               'MaxMRUSize',
    mtuIp:                'MaxMTUSize',
    ipMode:               'X_CMCC_IPMode',
    lanInterface:         'X_CMCC_LanInterface',
    lanDhcpEnable:        'X_CMCC_LanInterface-DHCPEnable',
    ipv6PrefixOrigin:     'X_CMCC_IPv6PrefixOrigin',
    ipv6AddrOrigin:       'X_CMCC_IPv6IPAddressOrigin',
    ipv6PrefixDelegation: 'X_CMCC_IPv6PrefixDelegationEnabled',
    ipv6Dns:              'X_CMCC_IPv6DNSServers',
    pppUser:              'Username',
    pppPass:              'Password',
    pppConnType:          'ConnectionType',
    pppServiceName:       'PPPoEServiceName',
    ipAddrType:           'AddressingType',
    ipAddr:               'ExternalIPAddress',
    ipMask:               'SubnetMask',
    ipGw:                 'DefaultGateway',
    ipDns:                'DNSServers',
    enable:               'Enable',
  },
  values: {
    pppoe:'PPPoE', ipRouted:'IP_Routed', ipBridged:'IP_Bridged', static:'Static_IP',
    pppRouted:'PPPoE_Routed', pppBridged:'PPPoE_Bridged',
  },
};

// Gabungkan entri tersimpan (skema lama/tipis ATAU baru) di atas default lengkap.
function _wanProfileMerge(base, over) {
  var p = JSON.parse(JSON.stringify(base));
  if (!over) return p;
  // paramPrefix boleh string kosong (TR-098 murni) → diperlakukan sebagai nilai eksplisit
  if (typeof over.paramPrefix === 'string') p.paramPrefix = over.paramPrefix;
  ['label','dataModel','wanRoot','connChildPpp','connChildIp','productClasses','oui','rebootParam','vlanNode','vlanOnWcd','dualStack','createConnType','ipv6GuaAuto']
    .forEach(function(k){ if (over[k] != null && over[k] !== '') p[k] = over[k]; });
  if (over.features) for (var f in over.features) p.features[f] = over.features[f];
  // params: '' eksplisit = KOSONGKAN (param tak didukung vendor → _pushParam melewati);
  // undefined = warisi dari template. (Entri lama tanpa .params tak terpengaruh.)
  if (over.params)   for (var k in over.params)   { if (over.params[k] !== undefined) p.params[k] = over.params[k]; }
  if (over.values)   for (var v in over.values)   { if (over.values[v]) p.values[v] = over.values[v]; }
  return p;
}

// ─── DESAIN 3-LAPIS — Lapis 1: TEMPLATE PARAMETER WAN (keluarga, dipakai ulang) ───
// X_CMCC = WAN_PROFILE_DEFAULT (profil F663NV9 produksi, akurat).
// TR098/X_CT-COM/X_HW = baseline aman: field standar TR-098 terisi; param
// vendor-spesifik (service/vlan/lanInterface/ipv6…) DIKOSONGKAN + fitur dimatikan,
// agar operator vendor baru cukup mengisi 3 path inti (sesuai workflow yang diminta).
// Tidak pernah mengirim nama param tebakan ke ONU.
var _WAN_STD_PARAMS = {
  nat:'NATEnabled', mtuPpp:'MaxMRUSize', mtuIp:'MaxMTUSize',
  pppUser:'Username', pppPass:'Password', pppConnType:'ConnectionType', pppServiceName:'PPPoEServiceName',
  ipAddrType:'AddressingType', ipAddr:'ExternalIPAddress', ipMask:'SubnetMask',
  ipGw:'DefaultGateway', ipDns:'DNSServers', enable:'Enable',
  service:'', vlanId:'', vlanMode:'', cos:'', ipMode:'', lanInterface:'', lanDhcpEnable:'',
  ipv6PrefixOrigin:'', ipv6AddrOrigin:'', ipv6PrefixDelegation:'', ipv6Dns:'',
};
function _wanBaseline(label, prefix) {
  return {
    label: label, dataModel:'TR098',
    wanRoot:'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.',
    connChildPpp:'WANPPPConnection', connChildIp:'WANIPConnection',
    paramPrefix: prefix,
    features:{ vlan:false, ipMode:false, lanBinding:false, ipv6:false, cos:false, nat:true, mtu:true, pppServiceName:false, canAddDelete:true },
    params: JSON.parse(JSON.stringify(_WAN_STD_PARAMS)),
    values:{ pppoe:'PPPoE', ipRouted:'IP_Routed', ipBridged:'IP_Bridged', static:'Static_IP', pppRouted:'PPPoE_Routed', pppBridged:'PPPoE_Bridged' },
  };
}
var WAN_TEMPLATES = {
  'X_CMCC':   WAN_PROFILE_DEFAULT,                       // CMCC ZTE F663 — akurat (produksi)
  'TR098':    _wanBaseline('TR-098 standar', ''),        // generik, tanpa prefix vendor
  'X_CT-COM': _wanBaseline('China Telecom (X_CT-COM)', 'X_CT-COM_'),
  'X_HW':     _wanBaseline('Huawei (X_HW)', 'X_HW_'),
  'X_CU':     _wanBaseline('China Unicom (X_CU)', 'X_CU_'),   // F9V ETCH/FOTC
  'X_ZTE-COM': _wanBaseline('ZTE baru (X_ZTE-COM)', 'X_ZTE-COM_'),  // F679L/F670L
};
// localStorage 'acs_param_templates' boleh menimpa/menambah template (dipakai UI nanti).
const _TPL_KEY = 'acs_param_templates';
function _paramTemplatesLoad() {
  try { return JSON.parse(localStorage.getItem(_TPL_KEY) || '{}'); } catch { return {}; }
}
function _wanTemplate(name) {
  var stored = _paramTemplatesLoad().wan || {};
  if (name && stored[name]) return stored[name];
  if (name && WAN_TEMPLATES[name]) return WAN_TEMPLATES[name];
  return WAN_PROFILE_DEFAULT;   // default = X_CMCC → backward-compatible (byte-identik ZTE)
}
function listWanTemplates() {
  var names = {}; Object.keys(WAN_TEMPLATES).forEach(function(k){ names[k]=1; });
  Object.keys(_paramTemplatesLoad().wan || {}).forEach(function(k){ names[k]=1; });
  return Object.keys(names);
}

// PUBLIC (dipakai Fase 3). matched=false → vendor tanpa profil (kelak read-only).
// Resolusi 3-lapis: template (Lapis 1) → rantai entri umum→spesifik (Lapis 2 & 3).
function getWanProfile(productClass, oui, manufacturer) {
  var chain = _vendorMatchChain(_vcfgLoad().concat(_vcfgDefaults()), productClass, oui, manufacturer);
  // template diambil dari entri paling spesifik yang menyebut .template; default X_CMCC
  var tplName = '';
  for (var i = chain.length - 1; i >= 0; i--) { if (chain[i].template) { tplName = chain[i].template; break; } }
  var prof = _wanProfileMerge(_wanTemplate(tplName), null);  // deep-clone template sbg base
  for (var j = 0; j < chain.length; j++) { prof = _wanProfileMerge(prof, chain[j]); }
  prof.matched  = chain.length > 0;
  prof.template = tplName || 'X_CMCC';
  // createConnType = fakta firmware dari KODE (tipe koneksi objek baru). Seed localStorage
  // lama di browser teknisi belum membawanya → WAN baru tetap lahir salah (C-DATA 2026-10-03).
  var disuntingW = chain.length && chain[chain.length - 1].disunting;
  if (disuntingW) return prof;
  if (!prof.createConnType) {
    var dchain = _vendorMatchChain(_vcfgDefaults(), productClass, oui, manufacturer);
    for (var k = dchain.length - 1; k >= 0; k--) {
      if (dchain[k].createConnType) { prof.createConnType = JSON.parse(JSON.stringify(dchain[k].createConnType)); break; }
    }
  }
  if (!prof.ipv6GuaAuto && _vendorMatchChain(_vcfgDefaults(), productClass, oui, manufacturer)
        .some(function(e) { return e.ipv6GuaAuto; })) prof.ipv6GuaAuto = true;
  return prof;
}

// ─── Default WAN vendor data ─────────────────────────────────────
function _vcfgDefaults() {
  // All use TR-098 (InternetGatewayDevice.*) — standard GPON ONU path
  var wanRoot     = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.';
  var pppoeUser   = 'WANPPPConnection.1.Username';
  var pppoePass   = 'WANPPPConnection.1.Password';
  var connType    = 'WANIPConnection.1.ConnectionType';
  var enablePath  = 'WANIPConnection.1.Enable';
  return [
    // ZTE F663 / F463 / F650 / F9V — confirmed TR-098
    { id: _vmUid(), productClasses: 'F663NV9,F663NV3A,F663NV3a,F463N,F650,F9V',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP' },
    // Trikom F609 — ZTE-compatible TR-098 (ZL-2113X DIPINDAH ke entri HWTC X_CT-COM di bawah)
    { id: _vmUid(), productClasses: 'Trikom F609',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP' },
    // GM220-S / GM220 / MQ220 — entri generik X_CMCC DIHAPUS 2026-07-13.
    // Seluruh GM220-S/MQ220 di lapangan adalah CIOT (25) atau ZICG (17) — keduanya
    // X_CT-COM dan sudah punya entri Tier-2 (manufacturer) sendiri di bawah. Entri
    // generik product-only ini justru RANJAU: bila entri vendor tak terpakai (mis. JS
    // ter-cache), ia menarik ONU X_CT-COM ke jalur X_CMCC → create WAN menambah koneksi
    // di dalam WCD pelanggan & mendorong param tak-ada → gagal + sisa koneksi kosong
    // (kasus nyata: ZICG011FB914, CIOT12462630). Perangkat GM220 tak dikenal kini jatuh
    // ke default profil (X_CMCC) tanpa entri — perilaku efektif sama, tanpa ranjau.
    // ─── C-DATA (CDTC) FD514GD-R460 / FD512XW-R460 — TR-098 rasa X_CT-COM (EPON) ───
    // Diverifikasi read-only 2026-07-09 (DF18-2503002632 & DF1D-2412014404):
    //  - PPPoE: WANPPPConnection.1.{Username,Password,ConnectionType} (dari template X_CT-COM).
    //  - ServiceList: WANPPPConnection.1.X_CT-COM_ServiceList (di bawah koneksi).
    //  - VLAN: X_CT-COM_WANEponLinkConfig.{VLANIDMark,Mode} — node SAUDARA koneksi
    //    (bukan di bawahnya) → 'vlanNode'; device-detail push VLAN ke wcdBase+vlanNode.
    //  - MTU DIKOSONGKAN (MaxMRUSize tak ada di FD514GD) → tak dipush.
    //  - create/delete WAN DIMATIKAN (canAddDelete:false): addObject bisa reboot; hanya EDIT.
    { id: _vmUid(), manufacturer: 'CDTC', productClasses: 'FD514GD-R460,FD512XW-R460',
      template: 'X_CT-COM',
      // BUAT WAN IPoE (2026-10-03, operator, FD512XW SN CDTC1DD3548E): WANIPConnection hasil
      // addObject lahir 'IP_Bridged'. Panel tak mengirim ConnectionType (pppConnType sengaja
      // kosong, lihat di bawah) → WAN TR069 yang dibuat dari panel tampil "Bridge" di web ONU,
      // padahal seharusnya IPoE/DHCP. WAN TR069 yang benar di armada = 'IP_Routed'. Hanya
      // tipe IP yang disetel; PPPoE tetap seperti semula (tanpa .ppp).
      createConnType: { ip: 'IP_Routed' },
      // GUA From = Auto (SLAAC) (2026-10-03, uji operator): C-DATA baru mendapat IPv6 bila
      // X_CT-COM_IPv6IPAddressOrigin = 'AutoConfigured'. Form Edit memilih Auto untuk koneksi
      // dualstack walau ONU melapor 'None', dengan peringatan; Buat WAN sudah mengirim Auto
      // (dualStack.slaac di bawah — kini terbukti di lapangan).
      ipv6GuaAuto: true,
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      vlanNode: 'X_CT-COM_WANEponLinkConfig',
      // pppConnType DIKOSONGKAN: ConnectionType C-DATA beragam antar-model (FD514GD=
      // 'PPPoE_Routed', FD512XW='IP_Routed') & tipe koneksi ditentukan node
      // WANPPPConnection + Username, bukan nilai ConnectionType. Memaksa 'PPPoE_Routed'
      // (gaya ZTE) memicu cwmp.9003 di FD512XW → jangan push, biarkan default ONU.
      // lanInterface = X_CT-COM_LanInterface (binding LAN/SSID ke WAN — dikonfirmasi user;
      // format daftar-path spt X_CMCC). vlanNode default EPON, tapi PENULISAN pakai node
      // TERDETEKSI per-perangkat (conn.vlanNode Epon/Gpon) sebab FD512XW-R460 ada 2 varian.
      // IPv6/IPMode di form EDIT: param X_CT-COM terverifikasi writable (DF1D WCD.3).
      // create pakai dualStack (best-effort); edit pakai params ini (batch utama).
      params:   { service: 'X_CT-COM_ServiceList', vlanId: 'VLANIDMark', vlanMode: 'Mode', mtuPpp: '', mtuIp: '', pppConnType: '',
                  lanInterface: 'X_CT-COM_LanInterface', lanDhcpEnable: 'X_CT-COM_LanInterface-DHCPEnable',
                  ipMode: 'X_CT-COM_IPMode', ipv6PrefixOrigin: 'X_CT-COM_IPv6PrefixOrigin', ipv6AddrOrigin: 'X_CT-COM_IPv6IPAddressOrigin',
                  ipv6PrefixDelegation: 'X_CT-COM_IPv6PrefixDelegationEnabled', ipv6Dns: 'X_CT-COM_IPv6DNSServers' },
      // IPv4/IPv6 dualstack: standar China Telecom (CTC) X_CT-COM_IPMode
      // (1=IPv4, 2=IPv6, 3=IPv4/IPv6). ONU C-DATA di-provision IPv4 saja secara
      // default → koneksi baru dipush IPMode=3 sebagai langkah TERPISAH & best-effort
      // (di luar batch inti), sebab param ini belum ter-instansiasi di firmware
      // manapun yang teramati; bila nama/nilai beda per-firmware, WAN tetap terbuat
      // (IPv4) & tidak menggagalkan create. Push di bawah koneksi (WANPPPConnection.i).
      //
      // slaac: IPv6 stateless (SLAAC) — alamat via Router Advertisement, BUKAN stateful
      // DHCPv6 (default firmware = stateful → tak dapat IPv6 dari server user). Nama param
      // mengikuti konvensi X_CMCC ZTE dgn prefix X_CT-COM_ (IPAddressOrigin='AutoConfigured'
      // = SLAAC; PrefixOrigin='PrefixDelegation' = DHCPv6-PD). Di-push langkah TERSENDIRI
      // (try/catch terpisah dari IPMode) agar tebakan nama/nilai yang salah TIDAK
      // meregres dualstack yang sudah terbukti. BELUM diverifikasi live.
      dualStack: {
        param: 'X_CT-COM_IPMode', value: 3,
        slaac: [
          ['X_CT-COM_IPv6IPAddressOrigin', 'AutoConfigured',  'xsd:string'],
          ['X_CT-COM_IPv6PrefixOrigin',    'PrefixDelegation','xsd:string'],
        ],
      },
      // create AKTIF via model 'createNewWcd': tiap WAN baru = WANConnectionDevice
      // BARU (VLAN sendiri di node EPON-nya), meniru "Add WAN" UI native ONU —
      // TIDAK mengganggu VLAN koneksi lama. addObject C-DATA belum teruji reboot →
      // user uji di ONU cadangan dulu.
      // CATATAN binding SSID: bindability TAK bisa diturunkan dari TR-069 (uji lapangan
      // DF1D: justru slot WLAN.3/.4 [HGW-*] yang bindable sbg SSID1/SSID2 ONU, sedang
      // WLAN.1/.2 [YOGA/wkwkwkw] = SSID primer terkunci ke bridge default → tak bisa
      // di-bind). → JANGAN saring; tampilkan semua slot. bindShowSlot: tampilkan nomor
      // slot WLAN di label checkbox (ONU "SSIDn" = slot layanan; mis. WLAN3→SSID1).
      features: { canAddDelete: true, vlan: true, createNewWcd: true, lanBinding: true, bindShowSlot: true, ipMode: true, ipv6: true } },
    // ─── HWTC ZL-2113X — TR-098 rasa X_CT-COM (Huawei ODM, keluarga sama C-DATA) ───
    // FINAL 2026-07-12 — TERVERIFIKASI LIVE user: read WAN (EPON+GPON), edit VLAN/PPPoE,
    // CREATE WAN (EPON & GPON), channel width, panel radio. Ringkasan model:
    //  - GPON (SN HWTCDF6CDFE8): WCD.1=TR069(WANIPConnection,VID170), WCD.3=INTERNET
    //    (WANPPPConnection PPPoE,VID100). VLAN di node SAUDARA X_CT-COM_WANGponLinkConfig.
    //    WCD index tak selalu 1 (deteksi dinamis). Model create = C-DATA (createNewWcd).
    //  - EPON (SN HWTCD1B48118, Realtek RTL960x): WCD.1 tunggal gabungan; VLAN PADA
    //    koneksi (X_CT-COM_VLANIDMark) & di NAMA ('_R_VID_n'); reader fallback baca VID
    //    dari Name; writer create push VLAN ke koneksi via conn.vlanOnConn.
    //  - ServiceList/LanInterface/IPMode/IPv6* = nama X_CT-COM IDENTIK C-DATA (writable).
    //    Beda leaf STATUS baca: X_CT-COM_IPv6ConnectionStatus (HWTC) / IPv6ConnStatus (EPON).
    //  - ConnectionType='IP_Routed' walau koneksi PPPoE → pppConnType'' (jangan push).
    // ZL-4224X (1 unit, SW ZL_V2.3.1.6, EPON) DITAMBAHKAN 2026-07-13: skema WAN IDENTIK
    // ZL-2113X (X_CT-COM, VLAN di node saudara X_CT-COM_WANEponLinkConfig; multi-WCD:
    // WCD1 INTERNET VID100 + WCD2 TR069 VID170). Sebelumnya TAK cocok entri mana pun →
    // jatuh ke default X_CMCC (ranjau: tulisan SSID/WAN pakai nama param yang tak ada).
    // Node PON dibaca per-perangkat, jadi vlanNode Gpon di bawah hanya cadangan.
    { id: _vmUid(), manufacturer: 'HWTC', productClasses: 'ZL-2113X,ZL-4224X',
      template: 'X_CT-COM',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      vlanNode: 'X_CT-COM_WANGponLinkConfig',
      params:   { service: 'X_CT-COM_ServiceList', vlanId: 'VLANIDMark', vlanMode: 'Mode', mtuPpp: '', mtuIp: '', pppConnType: '',
                  lanInterface: 'X_CT-COM_LanInterface', lanDhcpEnable: 'X_CT-COM_LanInterface-DHCPEnable',
                  ipMode: 'X_CT-COM_IPMode', ipv6PrefixOrigin: 'X_CT-COM_IPv6PrefixOrigin', ipv6AddrOrigin: 'X_CT-COM_IPv6IPAddressOrigin',
                  ipv6PrefixDelegation: 'X_CT-COM_IPv6PrefixDelegationEnabled', ipv6Dns: 'X_CT-COM_IPv6DNSServers' },
      // dualStack: IPv4/IPv6 (X_CT-COM_IPMode=3) + SLAAC — nama param IDENTIK C-DATA
      // (dikonfirmasi ada di pohon HWTC). Best-effort saat create (langkah terpisah).
      dualStack: {
        param: 'X_CT-COM_IPMode', value: 3,
        slaac: [
          ['X_CT-COM_IPv6IPAddressOrigin', 'AutoConfigured',  'xsd:string'],
          ['X_CT-COM_IPv6PrefixOrigin',    'PrefixDelegation','xsd:string'],
        ],
      },
      // create AKTIF (model createNewWcd = tiap WAN baru → WANConnectionDevice sendiri,
      // VLAN independen). GPON = model C-DATA (VLAN di node saudara X_CT-COM_
      // WANGponLinkConfig). EPON (Realtek) = VLAN pada koneksi (X_CT-COM_VLANIDMark) via
      // conn.vlanOnConn. TERVERIFIKASI LIVE user 2026-07-12: create WAN sukses EPON & GPON.
      features: { canAddDelete: true, vlan: true, createNewWcd: true, lanBinding: true, bindShowSlot: true, ipMode: true, ipv6: true } },
    // ─── ZICG F650 / GM220-S — TR-098 rasa X_CT-COM (EPON), keluarga sama C-DATA/HWTC ───
    // Diverifikasi read-only 2026-07-12 (SN ZICG10317382 F650 & ZICG11B6737E GM220-S, live):
    //  - EPON: VLAN di node SAUDARA X_CT-COM_WANEponLinkConfig (VID100); WCD tunggal
    //    gabungan TR069+INTERNET; ConnectionType='IP_Routed' walau PPPoE → pppConnType''.
    //  - ServiceList/LanInterface/IPMode/IPv6*/ChannelWidth = X_CT-COM (identik C-DATA).
    //    IPv6 status leaf = X_CT-COM_IPv6ConnStatus (spt C-DATA; ditangani reader gvx).
    //  - create WAN AKTIF via model createNewWcd (tiap WAN baru = WANConnectionDevice
    //    sendiri, VLAN independen di node saudara EPON) — model X_CT-COM terbukti (C-DATA/
    //    HWTC). WAJIB lewat jalur ini, BUKAN entri generik GM220-S lama (X_CMCC) yang
    //    mendorong param tak-ada → gagal & sisakan koneksi kosong (kasus SN ZICG011FB914
    //    WANPPPConnection.2). Tier-2 (manufacturer ZICG) MENANG atas generik product-only.
    //    ⚠️ firmware ZICG tak seragam (OUI/versi beda, KW/refurb) → uji ONU cadangan dulu.
    { id: _vmUid(), manufacturer: 'ZICG', productClasses: 'F650,GM220-S',
      template: 'X_CT-COM',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      vlanNode: 'X_CT-COM_WANEponLinkConfig',
      params:   { service: 'X_CT-COM_ServiceList', vlanId: 'VLANIDMark', vlanMode: 'Mode', mtuPpp: '', mtuIp: '', pppConnType: '',
                  lanInterface: 'X_CT-COM_LanInterface', lanDhcpEnable: 'X_CT-COM_LanInterface-DHCPEnable',
                  ipMode: 'X_CT-COM_IPMode', ipv6PrefixOrigin: 'X_CT-COM_IPv6PrefixOrigin', ipv6AddrOrigin: 'X_CT-COM_IPv6IPAddressOrigin',
                  ipv6PrefixDelegation: 'X_CT-COM_IPv6PrefixDelegationEnabled', ipv6Dns: 'X_CT-COM_IPv6DNSServers' },
      dualStack: {
        param: 'X_CT-COM_IPMode', value: 3,
        slaac: [
          ['X_CT-COM_IPv6IPAddressOrigin', 'AutoConfigured',  'xsd:string'],
          ['X_CT-COM_IPv6PrefixOrigin',    'PrefixDelegation','xsd:string'],
        ],
      },
      features: { canAddDelete: true, vlan: true, createNewWcd: true, lanBinding: true, bindShowSlot: true, ipMode: true, ipv6: true } },
    // ─── CIOT GM220-S / MQ220 — TR-098 rasa X_CT-COM (GPON) — FINAL, TERVERIFIKASI LIVE ───
    // Uji tulis 2026-07-13 (SN CIOT12462630): SSID ✓, channel width ✓, super admin ✓,
    // create WAN ✓ (lewat createNewWcd). addObject WANConnectionDevice DIDUKUNG firmware
    // (WCD baru terbentuk); latensi connection-request ~35 dtk → poll 60 dtk memadai.
    // Diverifikasi read-only 2026-07-13 (SN CIOT12462630 GM220-S & CIOT1744EA78 MQ220, live):
    //  - GPON (semua 25 unit): VLAN di node SAUDARA X_CT-COM_WANGponLinkConfig (VID100,
    //    Mode=2); WCD.1 tunggal gabungan TR069+INTERNET; ConnectionType='IP_Routed' walau
    //    PPPoE → pppConnType ''. Firmware SERAGAM (TM-V2.0.6/2.0.7/2.1.6, MQ-V2.0.6) —
    //    beda dari ZICG yang tak seragam.
    //  - PPP mengekspos set X_CT-COM PENUH: ServiceList, LanInterface(+DHCPEnable), IPMode,
    //    IPv6* (status leaf X_CT-COM_IPv6ConnStatus, ditangani reader gvx).
    //  - WANConnectionDevice _object+_writable → create WAN via createNewWcd (model X_CT-COM
    //    terbukti C-DATA/HWTC/ZICG). Tier-2 (manufacturer CIOT) MENANG atas entri generik
    //    product-only 'GM220-S,GM220'/'MQ220' (X_CMCC) yang akan mendorong param tak-ada.
    { id: _vmUid(), manufacturer: 'CIOT', productClasses: 'GM220-S,MQ220',
      template: 'X_CT-COM',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      vlanNode: 'X_CT-COM_WANGponLinkConfig',
      params:   { service: 'X_CT-COM_ServiceList', vlanId: 'VLANIDMark', vlanMode: 'Mode', mtuPpp: '', mtuIp: '', pppConnType: '',
                  lanInterface: 'X_CT-COM_LanInterface', lanDhcpEnable: 'X_CT-COM_LanInterface-DHCPEnable',
                  ipMode: 'X_CT-COM_IPMode', ipv6PrefixOrigin: 'X_CT-COM_IPv6PrefixOrigin', ipv6AddrOrigin: 'X_CT-COM_IPv6IPAddressOrigin',
                  ipv6PrefixDelegation: 'X_CT-COM_IPv6PrefixDelegationEnabled', ipv6Dns: 'X_CT-COM_IPv6DNSServers' },
      dualStack: {
        param: 'X_CT-COM_IPMode', value: 3,
        slaac: [
          ['X_CT-COM_IPv6IPAddressOrigin', 'AutoConfigured',  'xsd:string'],
          ['X_CT-COM_IPv6PrefixOrigin',    'PrefixDelegation','xsd:string'],
        ],
      },
      features: { canAddDelete: true, vlan: true, createNewWcd: true, lanBinding: true, bindShowSlot: true, ipMode: true, ipv6: true } },
    // ─── ZTE F663NV3A (82) — X_CMCC — PROFIL EKSPLISIT (2026-10-02, permintaan operator) ───
    // Product class 'F663NV3A' dipakai DUA pabrikan dengan data model berbeda: ZTE (X_CMCC,
    // GPON, kembaran F663NV9) dan ZTEG (X_CT-COM, EPON — entri di bawah). Panel memilih
    // lewat Manufacturer yang dilaporkan ONU. Dulu varian ZTE hanya "kebetulan" jatuh ke
    // entri product-only; kini tertulis jelas. Isi = template X_CMCC apa adanya (audit
    // SN ZTEGCC709721 & ZTEGCB94D6FD: semua nama param X_CMCC ada).
    { id: _vmUid(), manufacturer: 'ZTE', productClasses: 'F663NV3A',
      template: 'X_CMCC',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP' },
    // ─── ZTEG F663NV3A (34) & TRKG Trikom F609 (7) — X_CT-COM/EPON, ODM SAMA ZICG ───
    // Diverifikasi read-only 2026-07-13 (SN ZTEG1B7272B0 & TRKG9A465286, live).
    // ⚠️ TEMUAN PENTING: keduanya BUKAN ZTE X_CMCC walau product class-nya 'F663NV3A' /
    // 'Trikom F609' (yang selama ini cocok ke entri ZTE product-only). Data model mereka
    // X_CT-COM (SW V1.0.0P1T6 — sama persis ZICG F650): VLAN di node saudara
    // X_CT-COM_WANEponLinkConfig, ServiceList/LanInterface/IPMode/IPv6 = X_CT-COM.
    // Tanpa entri Tier-2 ini, edit VLAN/WAN mendorong nama param X_CMCC yang TAK ADA.
    // Resep = salinan ZICG (terbukti). Node PON dibaca per-perangkat; vlanNode = cadangan.
    { id: _vmUid(), manufacturer: 'ZTEG', productClasses: 'F663NV3A',
      template: 'X_CT-COM',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      vlanNode: 'X_CT-COM_WANEponLinkConfig',
      params:   { service: 'X_CT-COM_ServiceList', vlanId: 'VLANIDMark', vlanMode: 'Mode', mtuPpp: '', mtuIp: '', pppConnType: '',
                  lanInterface: 'X_CT-COM_LanInterface', lanDhcpEnable: 'X_CT-COM_LanInterface-DHCPEnable',
                  ipMode: 'X_CT-COM_IPMode', ipv6PrefixOrigin: 'X_CT-COM_IPv6PrefixOrigin', ipv6AddrOrigin: 'X_CT-COM_IPv6IPAddressOrigin',
                  ipv6PrefixDelegation: 'X_CT-COM_IPv6PrefixDelegationEnabled', ipv6Dns: 'X_CT-COM_IPv6DNSServers' },
      dualStack: {
        param: 'X_CT-COM_IPMode', value: 3,
        slaac: [
          ['X_CT-COM_IPv6IPAddressOrigin', 'AutoConfigured',  'xsd:string'],
          ['X_CT-COM_IPv6PrefixOrigin',    'PrefixDelegation','xsd:string'],
        ],
      },
      features: { canAddDelete: true, vlan: true, createNewWcd: true, lanBinding: true, bindShowSlot: true, ipMode: true, ipv6: true } },
    { id: _vmUid(), manufacturer: 'TRKG', productClasses: 'Trikom F609',
      template: 'X_CT-COM',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      vlanNode: 'X_CT-COM_WANEponLinkConfig',
      params:   { service: 'X_CT-COM_ServiceList', vlanId: 'VLANIDMark', vlanMode: 'Mode', mtuPpp: '', mtuIp: '', pppConnType: '',
                  lanInterface: 'X_CT-COM_LanInterface', lanDhcpEnable: 'X_CT-COM_LanInterface-DHCPEnable',
                  ipMode: 'X_CT-COM_IPMode', ipv6PrefixOrigin: 'X_CT-COM_IPv6PrefixOrigin', ipv6AddrOrigin: 'X_CT-COM_IPv6IPAddressOrigin',
                  ipv6PrefixDelegation: 'X_CT-COM_IPv6PrefixDelegationEnabled', ipv6Dns: 'X_CT-COM_IPv6DNSServers' },
      dualStack: {
        param: 'X_CT-COM_IPMode', value: 3,
        slaac: [
          ['X_CT-COM_IPv6IPAddressOrigin', 'AutoConfigured',  'xsd:string'],
          ['X_CT-COM_IPv6PrefixOrigin',    'PrefixDelegation','xsd:string'],
        ],
      },
      features: { canAddDelete: true, vlan: true, createNewWcd: true, lanBinding: true, bindShowSlot: true, ipMode: true, ipv6: true } },
    // ─── ETCH / FOTC F9V (17 unit) — X_CU (China Unicom), EPON — SKEMA VLAN KE-5 ───
    // Diverifikasi read-only 2026-07-13 (SN ELWRP93H8543270 ETCH & ELWRP93H6275497 FOTC):
    //  - Namespace X_CU_* (BUKAN X_CMCC/X_CT-COM) — sebelumnya keliru cocok ke entri ZTE
    //    product-only 'F9V' → tulisan WAN mendorong nama param X_CMCC yang TAK ADA.
    //  - VLAN = LEAF LANGSUNG di WANConnectionDevice: X_CU_VLAN (unsignedInt, writable,
    //    terbaca 100) — bukan node saudara (C-DATA) & bukan pada koneksi (HWTC-EPON).
    //    Ditandai vlanOnWcd → api.js set conn.vlanOnWcd, device-detail push ke base WCD.
    //  - vlanMode DIKOSONGKAN: X_CU_VLANEnabled adalah enable boolean, BUKAN mode
    //    tagged/untagged → jangan dipush (bisa mematikan VLAN).
    //  - Koneksi: X_CU_ServiceList / X_CU_LanInterface / X_CU_IPMode / X_CU_IPv6*
    //    (cermin X_CT-COM). ConnectionType='IP_Routed' walau PPPoE → pppConnType ''.
    //  - WCD _object+_writable → create = WCD baru (FOTC sudah punya WCD1+WCD2).
    //  ⚠️ Belum ada uji tulis — uji di ONU cadangan dulu.
    // CATATAN: manufacturer dicocokkan PERSIS (bukan daftar koma) → ETCH & FOTC = 2 entri
    // terpisah dengan isi identik (kedua merek memakai firmware/OUI 78C1A7 yang sama).
    { id: _vmUid(), manufacturer: 'ETCH', productClasses: 'F9V',
      template: 'X_CU',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      vlanOnWcd: true,
      params:   { service: 'X_CU_ServiceList', vlanId: 'X_CU_VLAN', vlanMode: '', mtuPpp: '', mtuIp: '', pppConnType: '',
                  // lanDhcpEnable KOSONG (C4, 2026-10-02): X_CU_LanInterface-DHCPEnable ada di
                  // 0 dari 26 koneksi WAN pada 15 unit F9V (ETCH & FOTC). Dulu ikut terkirim
                  // begitu binding diubah → ONU menolak SELURUH Simpan WAN (9005).
                  lanInterface: 'X_CU_LanInterface', lanDhcpEnable: '',
                  ipMode: 'X_CU_IPMode', ipv6PrefixOrigin: 'X_CU_IPv6PrefixOrigin', ipv6AddrOrigin: 'X_CU_IPv6IPAddressOrigin',
                  ipv6PrefixDelegation: 'X_CU_IPv6PrefixDelegationEnabled', ipv6Dns: 'X_CU_IPv6DNSServers' },
      dualStack: {
        param: 'X_CU_IPMode', value: 3,
        slaac: [
          ['X_CU_IPv6IPAddressOrigin', 'AutoConfigured',  'xsd:string'],
          ['X_CU_IPv6PrefixOrigin',    'PrefixDelegation','xsd:string'],
        ],
      },
      features: { canAddDelete: true, vlan: true, createNewWcd: true, lanBinding: true, bindShowSlot: true, ipMode: true, ipv6: true } },
    // ─── ZTE F679L (10) & F670L (1) — X_ZTE-COM, GPON — SKEMA VLAN KE-6 ───
    // Diverifikasi read-only 2026-07-13 (SN ZTEGD5D56FBD F679L & ZTEGCF8AA37E F670L):
    //  - Namespace X_ZTE-COM_* (BUKAN X_CMCC F663!) — sebelumnya jatuh ke default X_CMCC.
    //  - VLAN ADA PADA KONEKSI: X_ZTE-COM_VLANID (unsignedInt, writable, 100/170), plus
    //    X_ZTE-COM_VLANEnable (BOOLEAN — enable, BUKAN mode tagged) & X_ZTE-COM_8021P (CoS).
    //    → vlanMode DIKOSONGKAN; pakai field 'vlanEnable' (dipush sbg xsd:boolean).
    //  - Model WAN spt ZTE: SATU WCD.1 berisi banyak koneksi (F670L: PPP.2 + IP.1) →
    //    create = tambah koneksi di WCD.1 (jalur generik), BUKAN createNewWcd.
    //  - X_ZTE-COM_IPMode bernilai STRING ('IPv4'/'Both'), bukan integer 1/2/3 → panel
    //    IP Mode & dual-stack DIMATIKAN (ipMode/ipv6 false) agar tak mendorong nilai salah.
    //  - MTU dikosongkan (MaxMRUSize ada di F679L tapi TIDAK di F670L → jangan dipush).
    //  - CREATE 2 FASE (createConnType) — DIUJI LIVE 2026-07-13 di SN ZTEGD5D56FBD:
    //      addObject → koneksi lahir dgn ConnectionType='Unconfigured'. Batch param apa pun
    //      ke objek 'Unconfigured' (termasuk Enable=true) ditolak cwmp.9002 "Internal error"
    //      pada SELURUH objek → WAN yatim (persis keluhan operator). Kirim ConnectionType
    //      LEBIH DULU sbg task terpisah, lalu batch penuh → semua param masuk, 0 fault.
    //      Nilai: PPPoE routed = 'IP_Routed' (PossibleConnectionTypes ONU hanya
    //      'IP_Routed,PPPoE_Bridged' — 'PPPoE_Routed' gaya F663 TIDAK ADA di firmware ini).
    //  - params.name: firmware menamai koneksi ('INTERNET'/'TR69'); panel mengisi Name saat
    //    create agar koneksi baru tak bernama kosong di web ONU & daftar panel.
    //  - BINDING = TABEL TERPISAH, bukan param di koneksi: X_ZTE-COM_PortBinding.{i}.
    //    {WANInterface,LANInterface} — inilah menu "Port Binding" di web ONU (centang LAN1-4
    //    & SSID mana yang masuk ke WAN Internet). lanBinding:true + portBindingTable:true →
    //    UI binding lama dipakai ulang, penulisan diarahkan ke tabel (lihat device-detail).
    { id: _vmUid(), manufacturer: 'ZTE', productClasses: 'F679L,F670L',
      template: 'X_ZTE-COM',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      createConnType: { ppp: 'IP_Routed', pppBridged: 'PPPoE_Bridged', ip: 'IP_Routed' },
      // DUALSTACK IPv4+IPv6 saat create. X_ZTE-COM_IPMode bernilai STRING ('IPv4'/'Both'),
      // BUKAN integer 1/2/3 gaya X_CMCC/X_CT-COM → dualStack.type wajib 'xsd:string'.
      // Resep disalin dari 3 ONU F679L di fleet yang IPv6-nya SUDAH Connected (ZTEGD363010B,
      // ZTEGD9D3777D, ZTEGCF8AA37E): Both + AcquireMode Auto + DHCPv6 IA-NA & IA-PD + SLAAC
      // + PD-GUA. PDGUAEnable TIDAK ada di semua firmware (absen di ZTEGCF8AA37E) → param
      // IPv6 dipush best-effort satu per satu bila batch ditolak (lihat _wanApplyDualStack).
      dualStack: {
        param: 'X_ZTE-COM_IPMode', value: 'Both', type: 'xsd:string',
        valueOff: 'IPv4',   // pilihan "IPv4 Only" di form edit → matikan dualstack
        slaac: [
          ['X_ZTE-COM_IPv6AcquireMode',   'Auto', 'xsd:string'],
          ['X_ZTE-COM_Dhcpv6IANAEnable',  true,   'xsd:boolean'],
          ['X_ZTE-COM_Dhcpv6IAPDEnable',  true,   'xsd:boolean'],
          ['X_ZTE-COM_SlaacEnable',       true,   'xsd:boolean'],
          ['X_ZTE-COM_PDGUAEnable',       true,   'xsd:boolean'],
        ],
      },
      params:   { service: 'X_ZTE-COM_ServiceList', vlanId: 'X_ZTE-COM_VLANID', vlanMode: '',
                  vlanEnable: 'X_ZTE-COM_VLANEnable', cos: 'X_ZTE-COM_8021P', name: 'Name',
                  mtuPpp: '', mtuIp: '', pppConnType: '',
                  lanInterface: '', lanDhcpEnable: '', ipMode: '',
                  ipv6PrefixOrigin: '', ipv6AddrOrigin: '', ipv6PrefixDelegation: '', ipv6Dns: '' },
      features: { canAddDelete: true, vlan: true, cos: true, nat: true, mtu: false,
                  createNewWcd: false, lanBinding: true, portBindingTable: true,
                  bindShowSlot: true, ipMode: false, ipv6: false } },
    // ─── ZTE F6600P (2) — X_ZTE-COM, WiFi 6 — PROFIL SENDIRI (2026-10-02) ───
    // Isi WAN-nya SALINAN entri F679L/F670L di atas: audit read-only SN ZTEGD3BE4ED4
    // membuktikan leaf koneksi identik (X_ZTE-COM_VLANID/VLANEnable/ServiceList/8021P,
    // IPMode string 'IPv4'), PossibleConnectionTypes PPP = 'IP_Routed,PPPoE_Bridged',
    // param IPv6 dualstack lengkap (termasuk PDGUAEnable), dan tabel X_ZTE-COM_PortBinding.
    // Sengaja entri TERPISAH (permintaan operator): penyesuaian F6600P kelak tidak boleh
    // menggeser F679L/F670L yang sudah teruji, dan sebaliknya.
    // Tanpa profil ia jatuh ke X_CMCC dan Simpan WAN mengirim ConnectionType='PPPoE_Routed'
    // yang tak dikenal firmware ini. ⚠️ Belum ada uji tulis di F6600P.
    { id: _vmUid(), manufacturer: 'ZTE', productClasses: 'F6600P',
      template: 'X_ZTE-COM',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      createConnType: { ppp: 'IP_Routed', pppBridged: 'PPPoE_Bridged', ip: 'IP_Routed' },
      // DUALSTACK IPv4+IPv6 saat create. X_ZTE-COM_IPMode bernilai STRING ('IPv4'/'Both'),
      // BUKAN integer 1/2/3 gaya X_CMCC/X_CT-COM → dualStack.type wajib 'xsd:string'.
      // Resep disalin dari 3 ONU F679L di fleet yang IPv6-nya SUDAH Connected (ZTEGD363010B,
      // ZTEGD9D3777D, ZTEGCF8AA37E): Both + AcquireMode Auto + DHCPv6 IA-NA & IA-PD + SLAAC
      // + PD-GUA. PDGUAEnable TIDAK ada di semua firmware (absen di ZTEGCF8AA37E) → param
      // IPv6 dipush best-effort satu per satu bila batch ditolak (lihat _wanApplyDualStack).
      dualStack: {
        param: 'X_ZTE-COM_IPMode', value: 'Both', type: 'xsd:string',
        valueOff: 'IPv4',   // pilihan "IPv4 Only" di form edit → matikan dualstack
        slaac: [
          ['X_ZTE-COM_IPv6AcquireMode',   'Auto', 'xsd:string'],
          ['X_ZTE-COM_Dhcpv6IANAEnable',  true,   'xsd:boolean'],
          ['X_ZTE-COM_Dhcpv6IAPDEnable',  true,   'xsd:boolean'],
          ['X_ZTE-COM_SlaacEnable',       true,   'xsd:boolean'],
          ['X_ZTE-COM_PDGUAEnable',       true,   'xsd:boolean'],
        ],
      },
      params:   { service: 'X_ZTE-COM_ServiceList', vlanId: 'X_ZTE-COM_VLANID', vlanMode: '',
                  vlanEnable: 'X_ZTE-COM_VLANEnable', cos: 'X_ZTE-COM_8021P', name: 'Name',
                  mtuPpp: '', mtuIp: '', pppConnType: '',
                  lanInterface: '', lanDhcpEnable: '', ipMode: '',
                  ipv6PrefixOrigin: '', ipv6AddrOrigin: '', ipv6PrefixDelegation: '', ipv6Dns: '' },
      features: { canAddDelete: true, vlan: true, cos: true, nat: true, mtu: false,
                  createNewWcd: false, lanBinding: true, portBindingTable: true,
                  bindShowSlot: true, ipMode: false, ipv6: false } },
    // ─── Huawei HG8245A (2) & HG8245H (1) — X_HW, GPON — SKEMA VLAN & BINDING SENDIRI ───
    // Disurvei read-only 2026-07-13 (SN 4857544320FDA69B, HW 323.E / V3R013C10S128; unit
    // lain terakhir inform Mei → praktis mati):
    //  - VLAN PADA KONEKSI: X_HW_VLAN (unsignedInt). TIDAK ada mode tagged/untagged →
    //    vlanMode DIKOSONGKAN. CoS = X_HW_PRI. ServiceList = X_HW_SERVICELIST.
    //  - Nama koneksi berpola ISP ('1_INTERNET_R_VID_100') → VID juga terbaca dari Name.
    //  - Model WAN: SATU WCD per WAN (WCD.1=INTERNET PPPoE, WCD.2=TR069 IP) → createNewWcd.
    //  - ConnectionType='IP_Routed' walau PPPoE → pppConnType '' (jangan dipush).
    //  - BINDING = SKEMA KE-3: sub-node BOOLEAN di dalam koneksi, X_HW_LANBIND.
    //    {Lan1..4Enable, SSID1..4Enable} — bukan string path (X_CMCC/X_CT-COM) & bukan tabel
    //    root (X_ZTE-COM). Dibaca/ditulis lewat lanBindNode (api.js/device-detail.js).
    //  - DUALSTACK: sepasang boolean X_HW_IPv4Enable/X_HW_IPv6Enable (bukan leaf IPMode);
    //    alamat & prefix ada di sub-tabel X_HW_IPv6.{IPv6Address.1.IPAddress, IPv6Prefix.1.
    //    Prefix}. Unit yang disurvei SUDAH dualstack (GUA + PD aktif).
    //  ⚠️ BELUM ada uji tulis — hanya 1 unit hidup, milik pelanggan.
    { id: _vmUid(), manufacturer: 'Huawei Technologies Co., Ltd', productClasses: 'HG8245A,HG8245H',
      template: 'X_HW',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      dualStack: {
        param: 'X_HW_IPv6Enable', value: true, type: 'xsd:boolean',
        slaac: [['X_HW_IPv4Enable', true, 'xsd:boolean']],
      },
      params:   { service: 'X_HW_SERVICELIST', vlanId: 'X_HW_VLAN', vlanMode: '', cos: 'X_HW_PRI',
                  mtuPpp: 'MaxMRUSize', mtuIp: '', pppConnType: '',
                  lanInterface: '', lanDhcpEnable: '', ipMode: '',
                  ipv6PrefixOrigin: '', ipv6AddrOrigin: '', ipv6PrefixDelegation: '', ipv6Dns: '' },
      features: { canAddDelete: true, vlan: true, cos: true, nat: true, mtu: true,
                  createNewWcd: true, lanBinding: true, bindShowSlot: true,
                  ipMode: false, ipv6: false } },
    // ─── Huawei HG8245W5-6T (1) — X_HW, generasi firmware V5 ───
    // Disurvei read-only 2026-10-01 (SN 485754432B16F9AE, HW 1A3D.C / V5R020C10S246,
    // PPPoE Connected + dualstack aktif). Sebelumnya model ini TIDAK punya profil →
    // jatuh ke X_CMCC (ZTE): simpan WAN mengirim X_CMCC_VLANIDMark dst ke Huawei dan
    // buat WAN menambah koneksi DI DALAM WCD pelanggan. Beda dari HG8245A/H:
    //  - X_HW_LANBIND.* bertipe xsd:unsignedInt (1/0), BUKAN boolean; slot SSID1..8.
    //    Tipe ditulis sesuai laporan ONU (lihat _lanBindBoolParams).
    //  - Koneksi IP punya MaxMTUSize writable → mtuIp diisi.
    //  - valueOff: pilihan "IPv4 Only" mematikan X_HW_IPv6Enable (dulu tak berefek).
    // Sama dgn HG8245A/H: VLAN=X_HW_VLAN pada koneksi (tanpa mode), CoS=X_HW_PRI,
    // Service=X_HW_SERVICELIST, satu WCD per WAN (WCD.1 INTERNET, WCD.2 TR069),
    // ConnectionType PPP terbaca 'IP_Routed' → jangan dipush.
    { id: _vmUid(), manufacturer: 'Huawei Technologies Co., Ltd', productClasses: 'HG8245W5-6T',
      template: 'X_HW',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      dualStack: {
        param: 'X_HW_IPv6Enable', value: true, type: 'xsd:boolean', valueOff: false,
        slaac: [['X_HW_IPv4Enable', true, 'xsd:boolean']],
      },
      params:   { service: 'X_HW_SERVICELIST', vlanId: 'X_HW_VLAN', vlanMode: '', cos: 'X_HW_PRI',
                  mtuPpp: 'MaxMRUSize', mtuIp: 'MaxMTUSize', pppConnType: '',
                  lanInterface: '', lanDhcpEnable: '', ipMode: '',
                  ipv6PrefixOrigin: '', ipv6AddrOrigin: '', ipv6PrefixDelegation: '', ipv6Dns: '' },
      features: { canAddDelete: true, vlan: true, cos: true, nat: true, mtu: true,
                  createNewWcd: true, lanBinding: true, bindShowSlot: true,
                  ipMode: false, ipv6: false } },
    { id: _vmUid(), manufacturer: 'FOTC', productClasses: 'F9V',
      template: 'X_CU',
      wanRoot: wanRoot, pppoeUser: pppoeUser, pppoePass: pppoePass,
      connTypePath: connType, enablePath: enablePath,
      valBridge: 'IP_Bridged', valDhcp: 'IP_Routed', valPppoe: 'PPPoE', valStatic: 'Static_IP',
      vlanOnWcd: true,
      params:   { service: 'X_CU_ServiceList', vlanId: 'X_CU_VLAN', vlanMode: '', mtuPpp: '', mtuIp: '', pppConnType: '',
                  // lanDhcpEnable KOSONG (C4, 2026-10-02): X_CU_LanInterface-DHCPEnable ada di
                  // 0 dari 26 koneksi WAN pada 15 unit F9V (ETCH & FOTC). Dulu ikut terkirim
                  // begitu binding diubah → ONU menolak SELURUH Simpan WAN (9005).
                  lanInterface: 'X_CU_LanInterface', lanDhcpEnable: '',
                  ipMode: 'X_CU_IPMode', ipv6PrefixOrigin: 'X_CU_IPv6PrefixOrigin', ipv6AddrOrigin: 'X_CU_IPv6IPAddressOrigin',
                  ipv6PrefixDelegation: 'X_CU_IPv6PrefixDelegationEnabled', ipv6Dns: 'X_CU_IPv6DNSServers' },
      dualStack: {
        param: 'X_CU_IPMode', value: 3,
        slaac: [
          ['X_CU_IPv6IPAddressOrigin', 'AutoConfigured',  'xsd:string'],
          ['X_CU_IPv6PrefixOrigin',    'PrefixDelegation','xsd:string'],
        ],
      },
      features: { canAddDelete: true, vlan: true, createNewWcd: true, lanBinding: true, bindShowSlot: true, ipMode: true, ipv6: true } },
  ];
}
function vcfgSeedDefaults(diam) {
  var existing = _vcfgLoad();
  var toAdd    = _vcfgDefaults().filter(function(def) {
    var defPcs = def.productClasses.split(',').map(function(s){ return s.trim().toLowerCase(); });
    return !existing.some(function(e) {
      var ePcs = e.productClasses.split(',').map(function(s){ return s.trim().toLowerCase(); });
      return defPcs.some(function(p){ return ePcs.indexOf(p) !== -1; });
    });
  });
  if (toAdd.length === 0) { if (!diam) showToast('Data default sudah ada', 'info'); return; }
  _vcfgSave(existing.concat(toAdd));
  renderVcfgTable();
  if (!diam) showToast('Data default vendor config dimuat (' + toAdd.length + ' entri)', 'success');
}

function renderVcfgTable() {
  var tbody = document.getElementById('vcfgTableBody');
  if (!tbody) return;
  var list = _vcfgLoad();
  _stUpdateBadges();
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="vm-empty-row">'
      + 'Belum ada konfigurasi &mdash; '
      + '<button class="vm-btn-seed" onclick="vcfgSeedDefaults()"><i class="fas fa-wand-magic-sparkles"></i> Muat Data Default</button>'
      + ' atau klik <strong>Add Vendor Config</strong>'
      + '</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(function(c) {
    var pcs = c.productClasses.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    var pcHtml = pcs.map(function(p){ return '<span class="vm-badge">' + _vmEsc(p) + '</span>'; }).join(' ');
    var scope = [];
    if (c.manufacturer) scope.push('<i class="fas fa-industry"></i> ' + _vmEsc(c.manufacturer));
    if (c.oui)          scope.push('<i class="fas fa-fingerprint"></i> ' + _vmEsc(c.oui));
    var scopeHtml = scope.length ? '<div style="font-size:10px;color:var(--text-muted);margin-top:3px">' + scope.join(' &middot; ') + '</div>' : '';
    return '<tr>'
      + '<td><div class="vm-pc-cell">' + pcHtml + '</div>' + scopeHtml + '</td>'
      + '<td><code class="vm-code vm-code-sm">' + _vmEsc(c.wanRoot || '\u2014') + '</code></td>'
      + '<td><code class="vm-code vm-code-sm">' + _vmEsc(c.pppoeUser || '\u2014') + '</code></td>'
      + '<td><code class="vm-code vm-code-sm">' + _vmEsc(c.connTypePath || '\u2014') + '</code></td>'
      + '<td class="vm-actions-cell">'
      + '<button class="vm-btn-icon" title="Edit" onclick="vcfgEdit(\'' + c.id + '\')"><i class="fas fa-pen-to-square"></i></button>'
      + '<button class="vm-btn-icon" title="Duplikat" onclick="vcfgDuplicate(\'' + c.id + '\')"><i class="fas fa-copy"></i></button>'
      + '<button class="vm-btn-icon vm-btn-del" title="Hapus" onclick="vcfgDelete(\'' + c.id + '\')"><i class="fas fa-trash"></i></button>'
      + '</td></tr>';
  }).join('');
}

var _vcfgEditId = null;

// 24 param WAN dikelompokkan utk grid terstruktur (pengganti textarea JSON).
// Kunci = nama internal (dipakai device-detail via getWanProfile().params[<kunci>]);
// nilai input = nama/path TR-069 vendor. Kosong → _pushParam melewati (tak dikirim).
var _WAN_PARAM_FIELDS = [
  { grp: 'Service / VLAN / QoS', items: [
      ['service','Service List'], ['vlanId','VLAN ID'], ['vlanMode','VLAN Mode'], ['cos','CoS (802.1p)'] ] },
  { grp: 'Mode & Kontrol', items: [
      ['ipMode','IP Mode'], ['nat','NAT'], ['enable','Enable'], ['pppConnType','Connection Type'] ] },
  { grp: 'MTU', items: [
      ['mtuPpp','MTU PPPoE (MRU)'], ['mtuIp','MTU IP'] ] },
  { grp: 'LAN Binding', items: [
      ['lanInterface','LAN Interface'], ['lanDhcpEnable','LAN DHCP Enable'] ] },
  { grp: 'PPPoE', items: [
      ['pppUser','PPPoE Username'], ['pppPass','PPPoE Password'], ['pppServiceName','PPPoE Service Name'] ] },
  { grp: 'IP Statis', items: [
      ['ipAddrType','Addressing Type'], ['ipAddr','IP Address'], ['ipMask','Subnet Mask'],
      ['ipGw','Default Gateway'], ['ipDns','DNS Servers'] ] },
  { grp: 'IPv6', items: [
      ['ipv6PrefixOrigin','IPv6 Prefix Origin'], ['ipv6AddrOrigin','IPv6 Address Origin'],
      ['ipv6PrefixDelegation','IPv6 Prefix Delegation'], ['ipv6Dns','IPv6 DNS'] ] },
];

function _vcfgFillParamsGrid(params) {
  var grid = document.getElementById('vcfgParamsGrid');
  if (!grid) return;
  params = params || {};
  var html = '';
  _WAN_PARAM_FIELDS.forEach(function(sec) {
    html += '<div class="vcfg-pgrp">' + _vmEsc(sec.grp) + '</div><div class="vcfg-prow">';
    sec.items.forEach(function(it) {
      var key = it[0], val = params[key] != null ? params[key] : '';
      html += '<div class="vcfg-pcell"><label>' + _vmEsc(it[1]) + '</label>'
        + '<div class="vcfg-pcell-inrow">'
        + '<input class="form-input" id="vcfgP_' + key + '" value="' + _vmEsc(val) + '" placeholder="(kosong = tidak dikirim)">'
        + '<button type="button" class="vcfg-probe-mini" title="Uji param ini ke perangkat" onclick="_vcfgFieldProbe(\'' + key + '\')"><i class="fas fa-satellite-dish"></i></button>'
        + '</div></div>';
    });
    html += '</div>';
  });
  grid.innerHTML = html;
}

function _vcfgReadParamsGrid() {
  var out = {};
  _WAN_PARAM_FIELDS.forEach(function(sec) {
    sec.items.forEach(function(it) {
      var el = document.getElementById('vcfgP_' + it[0]);
      out[it[0]] = el ? el.value.trim() : '';
    });
  });
  return out;
}

// ════════════════════════════════════════════════════════════════
// UJI PARAM KE PERANGKAT — baca nilai dari DB GenieACS (READ-ONLY).
// ACS.probeParam TIDAK mengirim task/connection-request ke ONU →
// aman total (tak mungkin memicu reboot/commit). Hanya membaca nilai
// terakhir yang sudah dipegang GenieACS.
// ════════════════════════════════════════════════════════════════
async function _paramProbe(snId, pathId, resultId) {
  var res = document.getElementById(resultId);
  if (!res) return;
  var sn   = (_getVal(snId)   || '').trim();
  var path = (_getVal(pathId) || '').trim();
  if (!sn || !path) { res.className = 'vcfg-probe-result err'; res.textContent = 'Isi SN/Device ID dan path dulu.'; return; }
  if (typeof ACS === 'undefined' || typeof ACS.probeParam !== 'function') {
    res.className = 'vcfg-probe-result err'; res.textContent = 'API tidak tersedia.'; return;
  }
  res.className = 'vcfg-probe-result'; res.textContent = 'Menguji…';
  try {
    var r = await ACS.probeParam(sn, path);
    if (!r.found && r.reason === 'device') { res.className = 'vcfg-probe-result err'; res.textContent = '✗ Device tidak ditemukan: ' + sn; return; }
    if (!r.found) { res.className = 'vcfg-probe-result err'; res.textContent = '✗ Path tidak ada di DB GenieACS (mungkin belum di-refresh / path salah)'; return; }
    if (r.isObject) { res.className = 'vcfg-probe-result ok'; res.textContent = '✓ Node ada (objek/instance) — bukan nilai tunggal'; return; }
    res.className = 'vcfg-probe-result ok';
    res.textContent = '✓ Ada — nilai: "' + String(r.value) + '"' + (r.writable === false ? ' (read-only)' : (r.writable === true ? ' (writable)' : ''));
  } catch (e) {
    res.className = 'vcfg-probe-result err'; res.textContent = '✗ Error: ' + (e && e.message ? e.message : e);
  }
}

// Bangun tebakan path penuh WAN dari wanRoot entri + instance .1.
// Param WAN ada di bawah child koneksi (PPP/IP) — default tebak WANPPPConnection.1.
function _vcfgGuessPath(paramName) {
  var root = (_getVal('vcfgWanRoot') || '').trim() || 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.';
  if (root.charAt(root.length - 1) !== '.') root += '.';
  return root + 'WANPPPConnection.1.' + paramName;
}

// Klik "Uji" pada satu field param WAN → isi path tebakan lalu jalankan probe.
function _vcfgFieldProbe(key) {
  var el = document.getElementById('vcfgP_' + key);
  var name = el ? el.value.trim() : '';
  if (!name) { showToast('Field ini kosong — tidak ada param untuk diuji', 'info'); return; }
  _vmFld('vcfgProbePath', _vcfgGuessPath(name));
  _paramProbe('vcfgProbeSn', 'vcfgProbePath', 'vcfgProbeResult');
}

// Isi field "profil lengkap" (label/prefix/features/params/values) dari sebuah objek profil
function _vcfgFillProfile(p) {
  _vmFld('vcfgLabel',       p.label || '');
  _vmFld('vcfgParamPrefix', p.paramPrefix != null ? p.paramPrefix : '');
  var feat = p.features || {};
  ['vlan','ipMode','lanBinding','ipv6','cos','nat','mtu','canAddDelete']
    .forEach(function(f){ _vmChk('vcfgFeat_' + f, feat[f]); });
  _vcfgFillParamsGrid(p.params || {});
  _vmFld('vcfgValuesJson', JSON.stringify(p.values || {}, null, 2));
  // Lanjutan (hasil audit model): tipe koneksi WAN baru & bawaan GUA From.
  var ct = p.createConnType || {};
  _vmFld('vcfgCreateCtIp',  ct.ip  || '');
  _vmFld('vcfgCreateCtPpp', ct.ppp || '');
  _vmChk('vcfgIpv6GuaAuto', p.ipv6GuaAuto);
}

function vcfgAdd() {
  _vcfgEditId = null;
  var t = document.getElementById('vcfgModalTitle');
  if (t) t.innerHTML = '<i class="fas fa-plus"></i> Add Vendor Config';
  ['vcfgProductClasses','vcfgManufacturer','vcfgOui','vcfgWanRoot','vcfgPppoeUser','vcfgPppoePass',
   'vcfgConnTypePath','vcfgEnablePath','vcfgValBridge','vcfgValDhcp',
   'vcfgValPppoe','vcfgValStatic'].forEach(function(id){ _vmFld(id,''); });
  // defaults (skema lama)
  _vmFld('vcfgValBridge','IP_Bridged'); _vmFld('vcfgValDhcp','IP_Routed');
  _vmFld('vcfgValPppoe','PPPoE');       _vmFld('vcfgValStatic','Static_IP');
  // defaults (profil lengkap) — prefill dari template X_CMCC agar operator tinggal menyesuaikan
  _fillTemplateSelect('vcfgTemplate', listWanTemplates(), 'X_CMCC');
  _vcfgFillProfile(WAN_PROFILE_DEFAULT);
  document.getElementById('vcfgModal').classList.remove('hidden');
}

function vcfgEdit(id) {
  var list = _vcfgLoad();
  var c = null;
  for (var i = 0; i < list.length; i++) { if (list[i].id === id) { c = list[i]; break; } }
  if (!c) return;
  _vcfgEditId = id;
  var t = document.getElementById('vcfgModalTitle');
  if (t) t.innerHTML = '<i class="fas fa-pen-to-square"></i> Edit Vendor Config';
  _vmFld('vcfgProductClasses', c.productClasses);
  _vmFld('vcfgManufacturer',   c.manufacturer);
  _vmFld('vcfgOui',            c.oui);
  _vmFld('vcfgWanRoot',        c.wanRoot);
  _vmFld('vcfgPppoeUser',      c.pppoeUser);
  _vmFld('vcfgPppoePass',      c.pppoePass);
  _vmFld('vcfgConnTypePath',   c.connTypePath);
  _vmFld('vcfgEnablePath',     c.enablePath);
  _vmFld('vcfgValBridge',      c.valBridge);
  _vmFld('vcfgValDhcp',        c.valDhcp);
  _vmFld('vcfgValPppoe',       c.valPppoe);
  _vmFld('vcfgValStatic',      c.valStatic);
  // Profil lengkap: tampilkan hasil merge (template entri + override tersimpan)
  _fillTemplateSelect('vcfgTemplate', listWanTemplates(), c.template || 'X_CMCC');
  // Nilai EFEKTIF (termasuk tambalan dari kode untuk seed lama) — supaya yang tampil di
  // form sama dengan yang benar-benar dipakai panel, dan Simpan tidak menghilangkannya.
  var ef = _wanProfileMerge(_wanTemplate(c.template), c);
  var dW = _vendorMatch(_vcfgDefaults(), (c.productClasses || '').split(',')[0].trim(), c.oui, c.manufacturer);
  if (!c.disunting && dW) {
    if (!ef.createConnType && dW.createConnType) ef.createConnType = dW.createConnType;
    if (!ef.ipv6GuaAuto && dW.ipv6GuaAuto) ef.ipv6GuaAuto = true;
  }
  _vcfgFillProfile(ef);
  document.getElementById('vcfgModal').classList.remove('hidden');
}

// Duplikat: isi modal dari entri sumber TAPI simpan sebagai entri BARU
// (editId=null). Operator tinggal ubah OUI/Product agar tak bentrok scope.
function vcfgDuplicate(id) {
  vcfgEdit(id);            // reuse: isi seluruh field dari entri sumber
  _vcfgEditId = null;      // → Simpan akan membuat entri baru, sumber tetap utuh
  var t = document.getElementById('vcfgModalTitle');
  if (t) t.innerHTML = '<i class="fas fa-copy"></i> Duplikat Vendor Config (entri baru)';
  showToast('Duplikat: ubah OUI/Product agar tak bentrok, lalu Simpan', 'info');
}

function vcfgDelete(id) {
  if (!confirm('Hapus konfigurasi vendor ini?')) return;
  var lamaW = _vcfgLoad();
  simpanProfilServer('wan', lamaW.filter(function(x){ return x.id !== id; }), lamaW, renderVcfgTable)
    .then(function(ok) { if (ok) { renderVcfgTable(); showToast('Konfigurasi vendor dihapus', 'success'); } });
}

function vcfgSave() {
  var pcs  = (_getVal('vcfgProductClasses') || '').trim();
  var _mfr = _getVal('vcfgManufacturer').trim();
  var _oui = _getVal('vcfgOui').trim().toUpperCase();
  if (!pcs && !_oui && !_mfr) { showToast('Isi minimal salah satu: OUI, Manufacturer, atau Product Class', 'error'); return; }
  // Params dari grid terstruktur; Values map masih JSON (jarang diubah)
  var paramsObj = _vcfgReadParamsGrid();
  var valuesObj;
  try { valuesObj = JSON.parse(_getVal('vcfgValuesJson') || '{}'); }
  catch (e) { showToast('Values Map bukan JSON valid', 'error'); return; }
  if (typeof valuesObj !== 'object' || Array.isArray(valuesObj)) { showToast('Values Map harus berupa objek JSON', 'error'); return; }
  var entry = {
    id:           _vcfgEditId || _vmUid(),
    productClasses: pcs,
    manufacturer: _mfr,
    oui:          _oui,
    wanRoot:      _getVal('vcfgWanRoot').trim(),
    pppoeUser:    _getVal('vcfgPppoeUser').trim(),
    pppoePass:    _getVal('vcfgPppoePass').trim(),
    connTypePath: _getVal('vcfgConnTypePath').trim(),
    enablePath:   _getVal('vcfgEnablePath').trim(),
    valBridge:    _getVal('vcfgValBridge').trim()  || 'IP_Bridged',
    valDhcp:      _getVal('vcfgValDhcp').trim()    || 'IP_Routed',
    valPppoe:     _getVal('vcfgValPppoe').trim()   || 'PPPoE',
    valStatic:    _getVal('vcfgValStatic').trim()  || 'Static_IP',
    // ── Profil lengkap multi-vendor (Fase 1/2) ──
    template:     _getVal('vcfgTemplate') || 'X_CMCC',   // Lapis 1: keluarga param
    label:        _getVal('vcfgLabel').trim(),
    paramPrefix:  _getVal('vcfgParamPrefix'),     // boleh string kosong (TR-098 murni)
    features: {
      vlan:         _vmChkGet('vcfgFeat_vlan'),
      ipMode:       _vmChkGet('vcfgFeat_ipMode'),
      lanBinding:   _vmChkGet('vcfgFeat_lanBinding'),
      ipv6:         _vmChkGet('vcfgFeat_ipv6'),
      cos:          _vmChkGet('vcfgFeat_cos'),
      nat:          _vmChkGet('vcfgFeat_nat'),
      mtu:          _vmChkGet('vcfgFeat_mtu'),
      canAddDelete: _vmChkGet('vcfgFeat_canAddDelete'),
    },
    params: paramsObj,
    values: valuesObj,
    // Ditandai agar tambalan otomatis dari kode tidak menimpa pilihan operator.
    disunting: true,
    ipv6GuaAuto: _vmChkGet('vcfgIpv6GuaAuto'),
  };
  var list = _vcfgLoad();
  if (_vcfgEditId) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== _vcfgEditId) continue;
      // GABUNG, bukan ganti. Sebelum 2026-10-03 entri DIGANTI seluruhnya, sehingga membuka
      // lalu menyimpan profil C-DATA/Huawei/ZTE X_ZTE-COM dari form ini diam-diam membuang
      // field yang tak punya kolom: vlanNode, vlanOnWcd, dualStack, createConnType,
      // ipv6GuaAuto — dan VLAN/dualstack model itu rusak tanpa pesan apa pun.
      var lama = list[i];
      var ct = Object.assign({}, lama.createConnType || {});
      var ctIp = _getVal('vcfgCreateCtIp').trim(), ctPpp = _getVal('vcfgCreateCtPpp').trim();
      if (ctIp) ct.ip = ctIp; else delete ct.ip;
      if (ctPpp) ct.ppp = ctPpp; else delete ct.ppp;
      list[i] = Object.assign({}, lama, entry);
      if (Object.keys(ct).length) list[i].createConnType = ct; else delete list[i].createConnType;
      break;
    }
  } else {
    var ctB = {};
    if (_getVal('vcfgCreateCtIp').trim())  ctB.ip  = _getVal('vcfgCreateCtIp').trim();
    if (_getVal('vcfgCreateCtPpp').trim()) ctB.ppp = _getVal('vcfgCreateCtPpp').trim();
    if (Object.keys(ctB).length) entry.createConnType = ctB;
    list.push(entry);
  }
  // Ke server dulu (berlaku untuk SEMUA teknisi); cache browser mengikuti.
  simpanProfilServer('wan', list, _vcfgLoad(), renderVcfgTable).then(function(ok) {
    if (!ok) return;
    document.getElementById('vcfgModal').classList.add('hidden');
    renderVcfgTable();
    showToast('Konfigurasi vendor disimpan untuk semua pengguna', 'success');
  });
}

// ════════════════════════════════════════════════════════════════
// SECURITY SETTING — WiFi / SSID params per vendor
// localStorage key: 'acs_vendor_security'
// ════════════════════════════════════════════════════════════════
const _VM_KEY = 'acs_vendor_security';

function _vmSecLoad() {
  try { return JSON.parse(localStorage.getItem(_VM_KEY) || '[]'); } catch { return []; }
}
function _vmSecSave(list) {
  localStorage.setItem(_VM_KEY, JSON.stringify(list));
}

// PUBLIC — called by device-detail.js when configuring SSID
// getVendorSecurityConfig(productClass, oui, manufacturer)
// Pencocokan berlapis via _vendorMatch: OUI+Product → Manufacturer+Product → Product.
// localStorage (config user) diutamakan, hardcoded defaults sebagai cadangan
// (A802DB/EC6CB5 OUI-specific tetap menang via Tier 1).
function getVendorSecurityConfig(productClass, oui, manufacturer) {
  var hit = _vendorMatch(_vmSecLoad().concat(_vmSecDefaults()), productClass, oui, manufacturer);
  // KUNCI USERNAME dari default kode SELALU menang atas seed localStorage lama
  // (2026-10-02, F9V). Kunci = fakta firmware (login web F9V hanya "Klik User /
  // Klik Administrator" + password), bukan selera pengguna. Seed lama di browser
  // teknisi belum membawa kunci → tanpa ini form tetap menawarkan "Username Baru".
  // Sama untuk AKUN YANG DIBUKA di kode (2026-10-02, F670L/F679L User.2): seed lama masih
  // membawa adminUserSupported:false → form User Admin tetap mati di browser teknisi.
  // Entri yang DISIMPAN operator lewat form Security Setting (disunting:true) dipakai apa
  // adanya — form itu sudah menampilkan nilai efektif saat dibuka, jadi tidak ada yang hilang.
  if (hit && hit.disunting) return hit;
  var def = hit && _vendorMatch(_vmSecDefaults(), productClass, oui, manufacturer);
  if (!def) return hit;
  var buka = hit.adminUserSupported === false && def.adminUserSupported !== false && !!def.adminUserPassPath;
  // encModes (pilihan Encryption Type) = fakta firmware dari kode; seed lama tak membawanya.
  var enc = !!def.encModes && !hit.encModes;
  // Path username Super Admin yang baru dikenal kode (F663NV3A/a, F463N) — seed lama belum punya.
  var usr = !!def.adminSuperUserPath && !hit.adminSuperUserPath && !hit.adminSuperUserLocked
         && (hit.adminSuperPassPath || '') === (def.adminSuperPassPath || '');
  var chz = !!def.channelAutoZero && !hit.channelAutoZero;
  // Pengaman "form hanya bila parameternya dikenal" (model rapuh) selalu ikut dari kode.
  var cek = !!def.adminSuperCekAda && !hit.adminSuperCekAda;
  var rmt = !!def.remotePath && !hit.remotePath;
  // Path akun Super Admin ASLI yang baru dipetakan di kode (C-DATA, 2026-10-03): seed lama
  // tak punya path atau masih menunjuk VirtualParameters (ditolak pagar) → pakai dari kode.
  var akn = /^InternetGatewayDevice\./.test(def.adminSuperPassPath || '')
         && !/^InternetGatewayDevice\./.test(hit.adminSuperPassPath || '') && hit.adminSuperSupported !== false;
  if (!rmt && !akn && !def.adminSuperUserLocked && !def.adminUserUserLocked && !buka && !enc && !usr && !chz && !cek) return hit;
  var out = Object.assign({}, hit);
  if (chz) out.channelAutoZero = true;
  if (def.remotePath && !hit.remotePath) out.remotePath = def.remotePath;
  if (akn) ['adminSuperPassPath', 'adminSuperUserPath', 'adminSuperUserLocked', 'adminSuperCurrentUser'].forEach(function(k) {
    if (def[k] !== undefined) out[k] = def[k]; else delete out[k];
  });
  if (cek) { out.adminSuperCekAda = true; if (!hit.adminSuperPassPath) out.adminSuperPassPath = def.adminSuperPassPath; }
  if (enc) out.encModes = def.encModes;
  if (usr) out.adminSuperUserPath = def.adminSuperUserPath;
  if (buka) {
    ['adminUserSupported', 'adminUserNote', 'adminUserPassPath', 'adminUserUserPath',
     'adminUserUserLocked', 'adminUserCurrentUser'].forEach(function(k) {
      if (def[k] !== undefined) out[k] = def[k]; else delete out[k];
    });
  }
  ['adminSuper', 'adminUser'].forEach(function(r) {
    if (!def[r + 'UserLocked']) return;
    out[r + 'UserLocked'] = true;
    [r + 'UserPath', r + 'CurrentUser'].forEach(function(k) {
      if (def[k] !== undefined) out[k] = def[k]; else delete out[k];
    });
  });
  return out;
}

// ════════════════════════════════════════════════════════════════
// FASE 1 — SECURITY/SSID PROFILE (skema lengkap multi-vendor)
// Default = profil F663NV9 (nilai identik dengan device-detail.js sekarang).
// getSecurityProfile() menggabungkan getVendorSecurityConfig() DI ATAS default
// ini (nilai per-varian seperti beaconOpen/encOpen tetap menang). Belum dipakai
// device-detail (Fase 4) → nol efek runtime.
// ════════════════════════════════════════════════════════════════
var SECURITY_PROFILE_DEFAULT = {
  ssidRoot:           'InternetGatewayDevice.LANDevice.1.WLANConfiguration.',
  passwordPath:       'KeyPassphrase',
  beaconWpa:          'WPA/WPA2',
  beaconOpen:         'None',   // fakta fleet: open=None di semua F663NV9 ("Basic" tak pernah dipakai)
  encOpen:            'None',
  wpaEncryptionModes: 'TKIPandAESEncryption',
  channelWidthParam:  'X_CMCC_ChannelWidth',
  channelWidthType:   'xcmcc',
  adminSuperPassPath: 'VirtualParameters.superAdmin',
  adminUserPassPath:  'VirtualParameters.userPassword',
  features: { addSsid:true, channel:true, bandwidth:true, maxClients:true },
};

function _secProfileMerge(base, over) {
  var p = JSON.parse(JSON.stringify(base));
  if (!over) return p;
  ['ssidRoot','passwordPath','beaconWpa','beaconOpen','encOpen','wpaEncryptionModes',
   'channelWidthParam','channelWidthType','adminSuperPassPath','adminSuperUserPath',
   'adminSuperUserLocked','adminSuperCurrentUser','adminUserPassPath','adminUserUserPath',
   'adminUserUserLocked','adminUserCurrentUser','adminUserSupported','adminUserNote',
   'adminSuperSupported','adminSuperNote',
   'productClasses','oui']
    .forEach(function(k){ if (over[k] != null && over[k] !== '') p[k] = over[k]; });
  if (over.features) for (var f in over.features) p.features[f] = over.features[f];
  return p;
}

// ─── DESAIN 3-LAPIS — Lapis 1: TEMPLATE Security (keluarga, dipakai ulang) ───
// X_CMCC = SECURITY_PROFILE_DEFAULT (akurat). TR098 = standar WLAN TR-098
// (open BeaconType "None", channel width standar) untuk vendor non-CMCC.
var SECURITY_TEMPLATES = {
  'X_CMCC': SECURITY_PROFILE_DEFAULT,
  'TR098': {
    ssidRoot:'InternetGatewayDevice.LANDevice.1.WLANConfiguration.',
    passwordPath:'KeyPassphrase', beaconWpa:'WPA/WPA2', beaconOpen:'None', encOpen:'None',
    wpaEncryptionModes:'TKIPandAESEncryption', channelWidthParam:'', channelWidthType:'standard',
    adminSuperPassPath:'VirtualParameters.superAdmin', adminUserPassPath:'VirtualParameters.userPassword',
    features:{ addSsid:true, channel:true, bandwidth:false, maxClients:true },
  },
};
function _secTemplate(name) {
  var stored = _paramTemplatesLoad().security || {};
  if (name && stored[name]) return stored[name];
  if (name && SECURITY_TEMPLATES[name]) return SECURITY_TEMPLATES[name];
  return SECURITY_PROFILE_DEFAULT;   // default = X_CMCC → backward-compatible
}
function listSecurityTemplates() {
  var names = {}; Object.keys(SECURITY_TEMPLATES).forEach(function(k){ names[k]=1; });
  Object.keys(_paramTemplatesLoad().security || {}).forEach(function(k){ names[k]=1; });
  return Object.keys(names);
}

// ─── UI: selector template (dipakai modal Vendor Config & Security) ───
// Isi <select> dgn daftar template; tandai 'current' sebagai terpilih (default X_CMCC).
function _fillTemplateSelect(selectId, names, current) {
  var sel = document.getElementById(selectId);
  if (!sel) return;
  var cur = current || 'X_CMCC';
  sel.innerHTML = names.map(function(n){
    return '<option value="' + _vmEsc(n) + '"' + (n === cur ? ' selected' : '') + '>' + _vmEsc(n) + '</option>';
  }).join('');
}
// "Terapkan" template WAN → prefill prefix + features + params/values dari template terpilih.
function _applyWanTemplate() {
  var sel = document.getElementById('vcfgTemplate');
  var name = sel ? sel.value : 'X_CMCC';
  _vcfgFillProfile(_wanTemplate(name));
  showToast('Template "' + name + '" diterapkan ke field params', 'info');
}
// "Terapkan" template Security → prefill field WiFi/SSID dari template terpilih.
function _applySecTemplate() {
  var sel = document.getElementById('vmTemplate');
  var name = sel ? sel.value : 'X_CMCC';
  var t = _secTemplate(name);
  _vmFld('vmPasswordPath', t.passwordPath || 'KeyPassphrase');
  _vmFld('vmBeaconOpen',   t.beaconOpen   || 'None');
  _vmFld('vmEncOpen',      t.encOpen      || 'None');
  _vmSecFillProfile(t);
  showToast('Template "' + name + '" diterapkan ke field WiFi', 'info');
}

// PUBLIC (dipakai Fase 4). matched=false → vendor tanpa profil (kelak read-only).
// Resolusi 3-lapis: template → rantai entri umum→spesifik (warisan).
function getSecurityProfile(productClass, oui, manufacturer) {
  var chain = _vendorMatchChain(_vmSecLoad().concat(_vmSecDefaults()), productClass, oui, manufacturer);
  var tplName = '';
  for (var i = chain.length - 1; i >= 0; i--) { if (chain[i].template) { tplName = chain[i].template; break; } }
  var prof = _secProfileMerge(_secTemplate(tplName), null);
  for (var j = 0; j < chain.length; j++) { prof = _secProfileMerge(prof, chain[j]); }
  prof.matched  = chain.length > 0;
  prof.template = tplName || 'X_CMCC';
  return prof;
}

// ─── Default WiFi security data ──────────────────────────────────
function _vmSecDefaults() {
  return [
    // ZTE F663NV9 — A802DB variant: BeaconType="None" untuk open (standar TR-098)
    // Entri ini diprioritaskan di atas entri F663NV9 umum ketika OUI cocok.
    { id: _vmUid(), oui: 'A802DB', productClasses: 'F663NV9',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      adminSuperPassPath: 'VirtualParameters.superAdmin',
      adminSuperUserPath: 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username',
      adminUserPassPath:  'VirtualParameters.userPassword',
      adminUserUserLocked: true, adminUserCurrentUser: 'user' },
    // ZTE F663NV9 — varian EC6CB5 (firmware CMCC):
    //  - WiFi open = BeaconType "None" (standar TR-098), BUKAN "Basic".
    //  - Super Admin via VP superAdmin → menulis X_CMCC_TeleComAccount.Password (terbukti efektif).
    //  - User Admin TIDAK didukung firmware ini: model data CMCC hanya mengekspos satu akun
    //    web (X_CMCC_TeleComAccount = admin). Node X_CMCC_UserInfo hanyalah command write-only
    //    (kosong di 1300+ ONU; Status/Result=99 saat dipakai) dan VP userPassword tak punya
    //    path CMCC. Karena itu form User Admin dinonaktifkan agar tidak menyesatkan operator.
    { id: _vmUid(), oui: 'EC6CB5', productClasses: 'F663NV9',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      adminSuperPassPath: 'VirtualParameters.superAdmin',
      adminSuperUserPath: 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username',
      adminUserSupported: false,
      adminUserNote: 'Firmware CMCC ZTE F663NV9 tidak mengekspos akun "user" via TR-069 — hanya Super Admin yang dapat diubah dari jarak jauh.' },
    // ZTE F663NV9 (688AF0, B0B194, dst): open = BeaconType="None" (BUKAN "Basic").
    // FAKTA FLEET (1098 ONU F663NV9): BeaconType hanya "WPA/WPA2"/"None"/"WPA2".
    { id: _vmUid(), productClasses: 'F663NV9',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      adminSuperPassPath: 'VirtualParameters.superAdmin',
      adminSuperUserPath: 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username',
      adminUserPassPath:  'VirtualParameters.userPassword',
      adminUserUserLocked: true, adminUserCurrentUser: 'user' },
    // ZTE F663NV3A/a, F463N, F650, F9V — standar ZTE tanpa X_CMCC, BeaconType="None" untuk open
    // Dipisah 2026-10-02: F663NV3A/a & F463N buatan ZTE punya X_CMCC_TeleComAccount.Username
    // (writable; armada: 'admin' / 'superadmin') → form menampilkan username ASLI & bisa
    // menggantinya. F650/F9V tanpa pabrikan yang dikenal tetap seperti semula.
    { id: _vmUid(), productClasses: 'F663NV3A,F663NV3a,F463N',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      adminSuperUserPath: 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username' },
    { id: _vmUid(), productClasses: 'F650,F9V',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None' },
    // ZL-2113X DIPINDAH ke entri HWTC X_CT-COM di bawah (BeaconType WPAand11i, resep minimal)
    // Trikom F609 — ZTE rebrand
    { id: _vmUid(), productClasses: 'Trikom F609',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'Basic', encOpen: 'None' },
    // GM220-S, MQ220 — entri generik DIHAPUS 2026-07-13 (semua unit = CIOT/ZICG, punya
    // entri Tier-2 X_CT-COM sendiri). Entri ini juga menyimpan beaconOpen='Basic' yang
    // USANG (open system yang benar = 'None').
    // ─── C-DATA (CDTC) FD514GD-R460 / FD512XW-R460 — TR-098 rasa X_CT-COM (EPON) ───
    // Diverifikasi read-only 2026-07-09 (SN DF18-2503002632): BeaconType WPA="WPAand11i",
    // open="None". Data model TIDAK mengekspos param mode (WPA/Basic/IEEE11i Auth+Enc) —
    // HANYA BeaconType → resep MINIMAL (openMinimal/wpaMinimal) agar tak mendorong
    // param tak-ada (9005/9007). Password default KeyPassphrase; bila tak nyangkut saat
    // uji, ganti ke PreSharedKey.1.KeyPassphrase via Settings (keduanya writable).
    // Akun admin: hanya X_CT-COM_UserInfo.UserName (tanpa path password jelas, tanpa VP
    // superAdmin) → User Admin dinonaktifkan sampai terverifikasi.
    // AKUN WEB C-DATA (2026-10-03, baca 8 unit): X_CT-COM_TeleComAccount ADA dan writable —
    // FD512XW-R460: {Enable, Password}; FD514GD-R460: {Enable, Password, Username}. Catatan
    // lama "tanpa path password jelas" keliru (node itu waktu itu belum ditelusuri). Entri
    // dipisah per model karena hanya FD514GD yang punya Username. Tak ada akun user.
    // ⚠️ Belum diuji tulis.
    { id: _vmUid(), manufacturer: 'CDTC', productClasses: 'FD512XW-R460',
      template: 'X_CT-COM',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      openMinimal: true, wpaMinimal: true,
      // ssidFixedSlots: slot WLAN C-DATA pra-instansiasi & TETAP (FD514GD=10 slot [5G idx
      // 1-5, 2.4G idx 6-10], FD512XW=4 slot). addObject WLANConfiguration TIDAK didukung →
      // "Tambah SSID" = AKTIFKAN slot nonaktif berikutnya (bukan buat instance baru).
      ssidFixedSlots: true,
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
      adminSuperUserLocked: true,
      adminSuperCurrentUser: 'telecomadmin (belum dipastikan, coba juga: admin)',
      adminUserSupported: false,
      adminUserNote: 'C-DATA FD512XW: hanya password Super Admin yang ada di data TR-069; username & akun user tidak diekspos.' },
    { id: _vmUid(), manufacturer: 'CDTC', productClasses: 'FD514GD-R460',
      template: 'X_CT-COM',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      openMinimal: true, wpaMinimal: true,
      // ssidFixedSlots: slot WLAN C-DATA pra-instansiasi & TETAP (FD514GD=10 slot [5G idx
      // 1-5, 2.4G idx 6-10], FD512XW=4 slot). addObject WLANConfiguration TIDAK didukung →
      // "Tambah SSID" = AKTIFKAN slot nonaktif berikutnya (bukan buat instance baru).
      ssidFixedSlots: true,
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
      adminSuperUserPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Username',
      adminUserSupported: false,
      adminUserNote: 'C-DATA FD514GD: hanya akun Super Admin (username & password) yang ada di data TR-069; akun user tidak diekspos.' },
    // ─── HWTC ZL-2113X — X_CT-COM (Huawei ODM, resep security sama C-DATA) ───
    // FINAL 2026-07-12 — TERVERIFIKASI LIVE user: rename/pass SSID, WPA/None, channel &
    // channel width (panel Radio). BeaconType='WPAand11i' (SAMA C-DATA, BUKAN ZTE
    // 'WPA/WPA2'). Single-band 2.4G, 4 slot WLAN TETAP (WLAN.1 aktif, .2-.4 nonaktif).
    //  - ssidNoAdd: 4 slot sudah semua ter-instansiasi → tombol "Tambah SSID" disembunyikan.
    //  - Channel Width: firmware GPON ekspos X_CT-COM_ChannelWidth (kontrol muncul otomatis,
    //    data-driven di api.js — bukan flag di sini); EPON Realtek tak ekspos (kontrol hilang).
    //  - Password KeyPassphrase (terbukti nyangkut). Akun admin web: hanya
    //    X_CT-COM_UserInfo.UserName (tanpa path password) → adminUserSupported:false.
    // ZL-4224X (1 unit) DITAMBAHKAN 2026-07-13 — resep security IDENTIK ZL-2113X
    // (BeaconType WPAand11i, KeyPassphrase, X_CT-COM_ChannelWidth), BEDA-nya: DUAL BAND
    // dengan 8 slot TETAP → slot 1-4 = 2.4G, slot 5-8 = 5G (band5MinIdx). Ini WAJIB:
    // Channel=0 (auto), Standard/RFBand tak diekspos, dan SSID 5G bawaan bisa bernama
    // SAMA dgn 2.4G → tanpa band5MinIdx, radio 5G salah dibaca sebagai 2.4G.
    // Pada ZL-2113X (4 slot, 2.4G saja) band5MinIdx:5 tak berefek — tak ada slot >=5.
    { id: _vmUid(), manufacturer: 'HWTC', productClasses: 'ZL-2113X,ZL-4224X',
      template: 'X_CT-COM',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      openMinimal: true, wpaMinimal: true,
      ssidFixedSlots: true,
      band5MinIdx: 5,
      // ssidNoAdd: ZL-2113X sudah punya 4 slot SSID TETAP (semua ter-instansiasi) & tak bisa
      // addObject → tombol "Tambah SSID" DISEMBUNYIKAN. Operator cukup aktif/nonaktifkan slot
      // yang ada lewat toggle per-kartu SSID.
      ssidNoAdd: true,
      // AKUN WEB (2026-10-03, baca 259 unit ZL-2113X): X_CT-COM_TeleComAccount {Enable,
      // Password} writable ADA di firmware ZL_V2.2.x yang sudah ditelusuri (26 unit), tetapi
      // node itu TIDAK ADA di firmware V1.0.3 (41 unit) & ZL_V2.1.1.8 (14 unit), dan belum
      // ditelusuri di 177 unit lain. Model ini RAPUH (12 unit membeku sesudah satu
      // SetParameterValues) → menulis ke parameter yang tak ada tidak boleh dicoba-coba:
      // adminSuperCekAda membuat form HANYA aktif bila leaf Password unit itu sudah dikenal
      // GenieACS. Username tak diekspos. ⚠️ Belum diuji tulis.
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
      adminSuperUserLocked: true,
      adminSuperCurrentUser: 'telecomadmin (belum dipastikan, coba juga: admin)',
      adminSuperCekAda: true,
      // Tombol Remote langsung ke halaman kerja web ONU (akar '/' hanya skrip pengalih).
      remotePath: '/cgi-bin/content.asp',
      adminUserSupported: false,
      adminUserNote: 'HWTC (X_CT-COM): tidak ada akun "user" di data TR-069 — hanya password Super Admin (pada firmware yang menyediakannya).' },
    // ─── ZICG F650 / GM220-S — X_CT-COM tapi resep security STANDAR (bukan minimal) ───
    // Diverifikasi read-only 2026-07-12 (SN ZICG11B6737E GM220-S, live): BEDA dari
    // C-DATA/HWTC — WLAN mengekspos SET PENUH param mode (WPAAuthenticationMode,
    // IEEE11i*, BasicAuthenticationMode, dll) + KeyPassphrase + PreSharedKey, dan
    // BeaconType='WPA/WPA2' (SEPERTI ZTE, BUKAN 'WPAand11i'). → pakai recipe STANDAR
    // (tanpa flag minimal): WPA push mode-params lengkap, open push BasicAuthenticationMode=
    // 'OpenSystem'+BeaconType='None'. Semua param ADA → aman (tak 9005/9007). Password
    // KeyPassphrase. Slot WLAN tetap (GM220-S 4 slot 2.4G) → ssidFixedSlots (add=aktifkan
    // slot). Channel width otomatis (X_CT-COM_ChannelWidth, data-driven di api.js).
    // Admin: hanya X_CT-COM_UserInfo.UserName → adminUserSupported:false.
    { id: _vmUid(), manufacturer: 'ZICG', productClasses: 'F650',
      template: 'X_CT-COM',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      // Super Admin web: PASSWORD di X_CT-COM_TeleComAccount.Password (writable, verified
      // 2026-07-12 SN ZICG11B6737E). USERNAME super admin TIDAK diekspos firmware (node
      // TeleComAccount hanya Enable+Password; tak ada .Username) → dikunci ke 'telecomadmin'
      // (standar China Telecom). Param username lain yang writable (X_CT-COM_UserInfo.UserName
      // = SN, ServiceManage Ftp/Telnet, ManagementServer.Username='onu') BUKAN akun web
      // super admin → jangan diutak-atik (bisa ganggu identitas/ACS).
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
      adminSuperUserLocked: true,
      // Username F650 BELUM pernah diuji login (GM220-S ternyata 'admin', lihat entri berikut).
      adminSuperCurrentUser: 'telecomadmin (belum dipastikan, coba juga: admin)',
      adminUserSupported: false,
      adminUserNote: 'ZICG (X_CT-COM): hanya akun Super Admin yang bisa diubah via TR-069 — passwordnya saja; username super admin & akun user lain tak diekspos firmware.' },
    // ZICG GM220-S — dipisah dari F650 (2026-10-02) karena username-nya TERBUKTI 'admin'.
    { id: _vmUid(), manufacturer: 'ZICG', productClasses: 'GM220-S',
      template: 'X_CT-COM',
      // Kanal tanpa AutoChannelEnable (2026-10-02, baca armada GM220-S/MQ220): Channel writable,
      // semua unit ber-Channel=0 sementara ChannelsInUse=13/1 → 0 = Auto. Sama dengan ZTEG
      // F663NV3A. ⚠️ Menulis kanal tetap belum diuji tulis.
      channelAutoZero: true,
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      // Super Admin web: PASSWORD di X_CT-COM_TeleComAccount.Password (writable, verified
      // 2026-07-12 SN ZICG11B6737E). USERNAME super admin TIDAK diekspos firmware (node
      // TeleComAccount hanya Enable+Password; tak ada .Username) → dikunci ke 'telecomadmin'
      // (standar China Telecom). Param username lain yang writable (X_CT-COM_UserInfo.UserName
      // = SN, ServiceManage Ftp/Telnet, ManagementServer.Username='onu') BUKAN akun web
      // super admin → jangan diutak-atik (bisa ganggu identitas/ACS).
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
      adminSuperUserLocked: true,
      // USERNAME = 'admin', BUKAN 'telecomadmin' (2026-10-02, operator, SN ZICG189410C7):
      // sesudah password diganti dari panel, login web 'telecomadmin' GAGAL, 'admin' BERHASIL.
      // 'telecomadmin' dulu hanya ASUMSI standar China Telecom, tak pernah diuji login.
      // Akun 'user' ada di web ONU tetapi tak punya node TR-069 (dicek ulang: UserInterface,
      // User, X_CT-COM_UserInfo=LOID, ServiceManage=FTP/Telnet) → tetap tak bisa diubah.
      adminSuperCurrentUser: 'admin',
      adminUserSupported: false,
      adminUserNote: 'ZICG (X_CT-COM): hanya akun Super Admin (username admin) yang bisa diubah via TR-069 — passwordnya saja. Akun "user" ada di web ONU tetapi tidak diekspos firmware ke TR-069, jadi username & passwordnya hanya bisa diganti dari web ONU.' },
    // ─── CIOT GM220-S / MQ220 — X_CT-COM, resep security STANDAR — FINAL, TERVERIFIKASI ───
    // Uji tulis live 2026-07-13 (SN CIOT12462630): ubah SSID ✓, channel width ✓
    // (X_CT-COM_ChannelWidth), ganti password Super Admin ✓ (TeleComAccount.Password).
    // Diverifikasi read-only 2026-07-13 (SN CIOT12462630 & CIOT1744EA78, live): WLAN
    // mengekspos SET PENUH param mode (WPAAuthenticationMode/WPAEncryptionModes/IEEE11i*/
    // Basic*) + KeyPassphrase + PreSharedKey, BeaconType='WPA/WPA2' (spt ZTE/ZICG, BUKAN
    // 'WPAand11i') → recipe STANDAR, TANPA flag minimal. 4 slot WLAN 2.4G tetap (slot 2-4
    // Enable=false) → ssidFixedSlots. Channel width = X_CT-COM_ChannelWidth (writable,
    // data-driven di api.js → panel radio). Super Admin: X_CT-COM_TeleComAccount
    // {Enable,Password} writable, Password='admin' (verified) — TANPA .Username → username
    // dikunci 'telecomadmin'. Akun user lain tak diekspos → adminUserSupported:false.
    { id: _vmUid(), manufacturer: 'CIOT', productClasses: 'GM220-S,MQ220',
      template: 'X_CT-COM',
      // Kanal tanpa AutoChannelEnable (2026-10-02, baca armada GM220-S/MQ220): Channel writable,
      // semua unit ber-Channel=0 sementara ChannelsInUse=13/1 → 0 = Auto. Sama dengan ZTEG
      // F663NV3A. ⚠️ Menulis kanal tetap belum diuji tulis.
      channelAutoZero: true,
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
      adminSuperUserLocked: true,
      // 'telecomadmin' = asumsi, belum diuji login; ZICG GM220-S terbukti 'admin' (2026-10-02).
      adminSuperCurrentUser: 'telecomadmin (belum dipastikan, coba juga: admin)',
      adminUserSupported: false,
      adminUserNote: 'CIOT (X_CT-COM): hanya akun Super Admin yang bisa diubah via TR-069 — passwordnya saja; username super admin & akun user lain tak diekspos firmware.' },
    // ─── ZTEG F663NV3A (34) & TRKG Trikom F609 (7) — X_CT-COM, resep STANDAR (spt ZICG) ───
    // Diverifikasi read-only 2026-07-13 (SN ZTEG1B7272B0 & TRKG9A465286, live): WLAN
    // mengekspos param mode PENUH (WPA/IEEE11i/Basic) + KeyPassphrase + X_CT-COM_ChannelWidth
    // → resep STANDAR (tanpa flag minimal). ⚠️ Sebelumnya keduanya cocok ke entri ZTE
    // product-only (X_CMCC) — SALAH data model. Super Admin: X_CT-COM_TeleComAccount
    // (anak node baru terisi setelah refreshObject, spt CIOT) → password saja, username
    // dikunci telecomadmin. Slot WLAN terlihat 1 tapi node addObject-able (spt ZICG F650)
    // → ssidFixedSlots + fallback addObject di _ssidHandleAdd menangani penambahan SSID.
    // ZTE F663NV3A (X_CMCC) — pasangan eksplisit entri ZTEG di bawah (2026-10-02). Resep WiFi
    // sama dengan F663NV3a/F663NV9; Super Admin = X_CMCC_TeleComAccount {Username, Password}
    // (username armada: 'superadmin'); akun user tak ada di data model. Pencocokan product
    // class TIDAK peka huruf besar/kecil, jadi F663NV3a (ZTE) ikut entri ini — memang sekeluarga.
    { id: _vmUid(), manufacturer: 'ZTE', productClasses: 'F663NV3A',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password',
      adminSuperUserPath: 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username' },
    { id: _vmUid(), manufacturer: 'ZTEG', productClasses: 'F663NV3A',
      template: 'X_CT-COM',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      // KANAL tanpa AutoChannelEnable (2026-10-02, baca 33 unit ZTEG): leaf Channel writable,
      // AutoChannelEnable TIDAK ADA. 30 unit ber-Channel=0 sementara ChannelsInUse=1/6 →
      // 0 = Auto. Maka kanal diatur lewat Channel saja (0 = Auto, n = tetap).
      // ⚠️ Menulis kanal tetap belum diuji tulis.
      channelAutoZero: true,
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
      adminSuperUserLocked: true,
      // 'telecomadmin' = asumsi, belum diuji login; ZICG GM220-S terbukti 'admin' (2026-10-02).
      adminSuperCurrentUser: 'telecomadmin (belum dipastikan, coba juga: admin)',
      adminUserSupported: false,
      adminUserNote: 'ZTEG (X_CT-COM): hanya Super Admin yang bisa diubah via TR-069 — passwordnya saja.' },
    { id: _vmUid(), manufacturer: 'TRKG', productClasses: 'Trikom F609',
      template: 'X_CT-COM',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
      adminSuperUserLocked: true,
      // 'telecomadmin' = asumsi, belum diuji login; ZICG GM220-S terbukti 'admin' (2026-10-02).
      adminSuperCurrentUser: 'telecomadmin (belum dipastikan, coba juga: admin)',
      adminUserSupported: false,
      adminUserNote: 'TRKG (X_CT-COM): hanya Super Admin yang bisa diubah via TR-069 — passwordnya saja.' },
    // ─── ETCH / FOTC F9V (17) — X_CU (China Unicom), resep security STANDAR ───
    // Diverifikasi read-only 2026-07-13 (SN ELWRP93H8543270 & ELWRP93H6275497): 4 slot
    // WLAN 2.4G, BeaconType='WPAand11i' TAPI param mode LENGKAP terekspos (WPA/IEEE11i/
    // Basic) → resep STANDAR dgn beaconWpa='WPAand11i' (bukan minimal: param ada semua).
    // KeyPassphrase writable. Channel width: TIDAK ada X_*ChannelWidth/
    // OperatingChannelBandwidth (hanya 'BandWidth' read-only) → panel radio otomatis
    // hanya menampilkan Channel (data-driven di api.js, tak perlu flag).
    // Super Admin (diverifikasi live 2026-07-13, SN ELWRP93H6152818):
    //   InternetGatewayDevice.X_CU_Function.Web.AdminPassword  → WRITABLE ✓
    //   ...Web.AdminName ('fujitomo')  → READ-ONLY  → username super admin DIKUNCI.
    //   ...Web.UserPassword/UserName ('admin') → READ-ONLY → akun user tak bisa diubah.
    // Pakai path LANGSUNG, bukan VirtualParameters.superAdmin: VP universal menembak
    // BANYAK path lintas-vendor sekaligus (rawan 9005 di path yang tak ada). Di dua ONU
    // F9V yang disurvei lebih awal node X_CU_Function tampak KOSONG — itu hanya karena
    // belum pernah dibaca GenieACS (butuh refreshObject), bukan karena tak ada.
    // ─── ZTE F679L (10) & F670L (1) — X_ZTE-COM, resep security STANDAR ───
    // Diverifikasi read-only 2026-07-13 (SN ZTEGD5D56FBD & ZTEGCF8AA37E):
    //  - 8 slot WLAN DUAL BAND (1-4 = 2.4G ch1-13, 5-8 = 5G ch149). Band terdeteksi dari
    //    Channel>=36 (heuristik lama SUDAH benar) → TIDAK perlu band5MinIdx.
    //  - BeaconType asli 'WPAand11i' (slot kosong '11i', open 'None'); param mode LENGKAP
    //    terekspos → resep STANDAR dgn beaconWpa='WPAand11i' (BUKAN 'WPA/WPA2' gaya F663 —
    //    itulah yang bikin 9007 di keluarga non-X_CMCC).
    //  - openMinimal:true — DIUJI LIVE 2026-07-13 di slot nonaktif SN ZTEGD5D56FBD:
    //      BasicAuthenticationMode='OpenSystem'  → cwmp.9007 Invalid parameter value
    //                                              (batch DITOLAK SELURUHNYA, nama SSID
    //                                               ikut gagal tersimpan)
    //      BeaconType='None' saja                → OK
    //    Enum BasicAuthenticationMode firmware ini tak mengenal 'OpenSystem' (SSID open
    //    bawaan ONU memakai BasicAuthenticationMode='None'). WPA standar (BeaconType
    //    'WPAand11i' + 4 param mode) diuji live juga → OK, jadi wpaMinimal TIDAK dipakai.
    //  - Channel width: X_ZTE-COM_OperatingChannelBandwidth (string) → tipe 'ztecom' di
    //    api.js; 2.4G '40MHz', 5G '80MHz' (opsi 80MHz hanya utk 5G).
    //  - Password SSID TERBACA (KeyPassphrase/PreSharedKey) → tampil di kartu SSID.
    //  - Akun web: InternetGatewayDevice.User.1.{Username,Password} — KEDUANYA writable
    //    (Username='admin'). VP superAdmin universal mengembalikan kosong di ONU ini.
    //    Catatan lama "hanya SATU akun" KELIRU (2026-10-02, baca armada): User.2
    //    {Username='user', Password} ADA dan writable di F670L (8 unit) & F679L (12 unit)
    //    yang node User-nya sudah ditelusuri — sama dengan F6600P. User Admin dibuka.
    //    ⚠️ User.2 belum diuji tulis.
    { id: _vmUid(), manufacturer: 'ZTE', productClasses: 'F679L,F670L',
      template: 'TR098',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      openMinimal: true,
      ssidFixedSlots: true,
      adminSuperPassPath: 'InternetGatewayDevice.User.1.Password',
      adminSuperUserPath: 'InternetGatewayDevice.User.1.Username',
      adminSuperCurrentUser: 'admin',
      adminUserPassPath: 'InternetGatewayDevice.User.2.Password',
      adminUserUserPath: 'InternetGatewayDevice.User.2.Username',
      adminUserCurrentUser: 'user',
      // ENCRYPTION TYPE seperti web ONU (2026-10-02). Nilai dibaca dari armada (33 unit,
      // SSID aktif), bukan ditebak:
      //   web "WPA2-PSK-AES"          = BeaconType '11i'       + IEEE11i AES   (SN ZTEGD6D53AF7
      //                                 persis begini saat web-nya menampilkan WPA2-PSK-AES)
      //   web "WPA/WPA2-PSK-TKIP/AES" = BeaconType 'WPAand11i' + WPA & IEEE11i TKIPandAES
      //                                 (12 SSID di armada berisi kombinasi ini)
      // "No Security" = pilihan None/Open yang sudah ada. "WPA/WPA2-EAP-AES" sengaja TIDAK
      // ditawarkan: butuh server RADIUS. ⚠️ Belum diuji tulis.
      encModes: [
        { id: 'wpa2aes', label: 'WPA2-PSK-AES', beacon: '11i',
          set: { IEEE11iAuthenticationMode: 'PSKAuthentication', IEEE11iEncryptionModes: 'AESEncryption' } },
        { id: 'wpamix', label: 'WPA/WPA2-PSK-TKIP/AES', beacon: 'WPAand11i',
          set: { WPAAuthenticationMode: 'PSKAuthentication', IEEE11iAuthenticationMode: 'PSKAuthentication',
                 WPAEncryptionModes: 'TKIPandAESEncryption', IEEE11iEncryptionModes: 'TKIPandAESEncryption' } },
      ] },
    // ─── ZTE F6600P (2) — X_ZTE-COM, WiFi 6 — PROFIL SENDIRI (2026-10-02) ───
    // Audit read-only SN ZTEGD3BE4ED4:
    //  - 10 slot WLAN: 1-4 & 9 = 2.4GHz, 5-8 & 10 = 5GHz → band dari Channel/heuristik,
    //    BUKAN band5MinIdx (slot 9 adalah 2.4GHz — band5MinIdx 5 akan salah membacanya).
    //  - BeaconType WPA 'WPAand11i', open 'None', KeyPassphrase writable → resep sama
    //    dengan F679L (openMinimal diwarisi dari keluarga X_ZTE-COM; belum diuji di F6600P).
    //  - Lebar kanal: master 'BandWidth' (tipe 'ztecom'). Radio 5GHz WiFi 6 SEDANG memakai
    //    '160MHz' (BandWidth = X_ZTE-COM_OperatingChannelBandwidth = '160MHz') → nilai itu
    //    diterima firmware ini, maka ditawarkan lewat bw5Extra (khusus F6600P). Kanal 5GHz
    //    yang diizinkan 36–64 = tepat satu blok 160MHz.
    //  - AKUN WEB: DUA akun, keduanya writable — User.1 'admin' (super) dan User.2 'user'.
    //    Beda dengan F679L/F670L yang hanya punya User.1. Tidak ada provision yang menulis
    //    User.* (hanya VP superAdmin/userPassword, yang tak dipanggil provision default).
    //  ⚠️ Belum ada uji tulis di F6600P.
    { id: _vmUid(), manufacturer: 'ZTE', productClasses: 'F6600P',
      template: 'TR098',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      openMinimal: true,
      ssidFixedSlots: true,
      bw5Extra: ['160MHz'],
      adminSuperPassPath:    'InternetGatewayDevice.User.1.Password',
      adminSuperUserPath:    'InternetGatewayDevice.User.1.Username',
      adminSuperCurrentUser: 'admin',
      adminUserPassPath:     'InternetGatewayDevice.User.2.Password',
      adminUserUserPath:     'InternetGatewayDevice.User.2.Username',
      adminUserCurrentUser:  'user',
      // ENCRYPTION TYPE (2026-10-02, baca SN ZTEGD4D5D1FF & ZTEGD3BE4ED4): dua mode WPA2
      // berisi nilai yang SAMA dengan F670L/F679L (slot '11i'+AES, slot 'WPAand11i'+
      // TKIPandAES), dan F670L sudah diuji operator berhasil. WPA3(SAE) dan
      // WPA2-PSK(AES)/WPA3(SAE) ada di web ONU tetapi SENGAJA BELUM ditawarkan: data model
      // tak punya leaf WPA3/SAE, dan belum ada satu pun SSID bermode itu untuk dibaca
      // nilainya — harus DIUKUR dulu (setel di web ONU → baca balik), bukan ditebak.
      encModes: [
        { id: 'wpa2aes', label: 'WPA2-PSK-AES', beacon: '11i',
          set: { IEEE11iAuthenticationMode: 'PSKAuthentication', IEEE11iEncryptionModes: 'AESEncryption' } },
        { id: 'wpamix', label: 'WPA/WPA2-PSK-TKIP/AES', beacon: 'WPAand11i',
          set: { WPAAuthenticationMode: 'PSKAuthentication', IEEE11iAuthenticationMode: 'PSKAuthentication',
                 WPAEncryptionModes: 'TKIPandAESEncryption', IEEE11iEncryptionModes: 'TKIPandAESEncryption' } },
      ] },
    // ─── CMDC H1S-3 (1) — X_CMCC (SAMA keluarga ZTE F663) ───
    // Disurvei read-only 2026-07-13 (SN CMDCB207680A, HW/SW V2.0):
    //  - Data model X_CMCC PERSIS keluarga ZTE F663 (X_CMCC_VLANIDMark/VLANMode/ServiceList/
    //    LanInterface/IPMode + X_CMCC_ChannelWidth) → template WAN default SUDAH benar; tak
    //    perlu entri WAN sendiri. Entri ini hanya utk akun web & slot SSID.
    //  - BeaconType='WPA/WPA2' (gaya ZTE), KeyPassphrase TERBACA → password SSID tampil.
    //    4 slot WLAN pra-instansiasi (2 aktif) → ssidFixedSlots.
    //  - Akun web: DeviceInfo.X_CMCC_TeleComAccount.{Username='telecomadmin', Password} —
    //    KEDUANYA writable & terbaca (terlihat SETELAH refreshObject; sebelumnya node ini
    //    kosong di cache GenieACS). VP universal 'superAdmin' hanya menulis Password; dgn
    //    path eksplisit ini username pun bisa diubah. Tak ada akun "user" terpisah
    //    (UserInterface kosong) → adminUserSupported:false.
    { id: _vmUid(), manufacturer: 'CMDC', productClasses: 'H1S-3',
      template: 'X_CMCC',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      adminSuperPassPath:    'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password',
      adminSuperUserPath:    'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username',
      adminSuperCurrentUser: 'telecomadmin',
      adminUserSupported: false,
      adminUserNote: 'CMDC H1S-3 (X_CMCC): firmware hanya mengekspos SATU akun web (TeleComAccount = super admin) — tak ada akun "user" terpisah.' },
    // ─── Huawei HG8245A/HG8245H (3) — X_HW ───
    // Disurvei read-only 2026-07-13 (SN 4857544320FDA69B) SETELAH refreshObject:
    //  - HANYA 1 slot WLAN yang diinstansiasi firmware (2.4GHz, RFBand='2.4GHz',
    //    Standard='11bgn') → single band, band5MinIdx tak relevan.
    //  - BeaconType='WPAand11i' (writable) + param mode LENGKAP (WPA/IEEE11i Auth+Enc)
    //    → resep STANDAR dgn beaconWpa='WPAand11i' (BUKAN 'WPA/WPA2' gaya ZTE F663).
    //  - PASSWORD BUKAN leaf langsung: PreSharedKey.1.KeyPassphrase (writable, terbaca
    //    kosong = firmware menyembunyikannya) → passwordPath berupa PATH BERTITIK.
    //  - Lebar kanal: X_HW_HT20 (unsignedInt) = sakelar "paksa HT20", bukan lebar kanal
    //    langsung → tipe 'hwht20' di api.js (1 = kunci 20MHz, 0 = 20/40MHz).
    //  - AKUN WEB: InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.{1,2}.{UserName,
    //    Password} — SEMUA writable. Node ini TIDAK tampak saat survei pertama karena
    //    GenieACS belum pernah membacanya (butuh refreshObject) — BUKAN karena tak ada.
    //    Terbaca 2026-07-13 di SN 4857544320FDA69B: .1 UserName='Admin' (akun user),
    //    .2 UserName='Support' (akun super/ISP) — indeks ini sama dgn yang dipakai skrip
    //    VirtualParameter GenieACS (superAdmin → .2 lalu .1; userPassword → .1 lalu .2).
    //    Password terbaca KOSONG (disembunyikan firmware) → hanya bisa ditulis, bukan dibaca.
    //  ⚠️ BELUM ada uji tulis — hanya 1 unit hidup, milik pelanggan.
    { id: _vmUid(), manufacturer: 'Huawei Technologies Co., Ltd', productClasses: 'HG8245A,HG8245H',
      template: 'TR098',
      passwordPath: 'PreSharedKey.1.KeyPassphrase',
      beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      adminSuperPassPath:    'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.Password',
      adminSuperUserPath:    'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.UserName',
      adminSuperCurrentUser: 'Support',
      adminUserPassPath:     'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.Password',
      adminUserUserPath:     'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.UserName',
      adminUserCurrentUser:  'Admin' },
    // ─── Huawei HG8245W5-6T (1) — X_HW V5, DUAL BAND ───
    // Disurvei read-only 2026-10-01 (SN 485754432B16F9AE):
    //  - WLAN.1 = 2.4GHz (X_HW_RFBand='2.4GHz', 11bgn), WLAN.5 = 5GHz ('5GHz', 11ac).
    //    Slot Huawei tetap: 1-4 = 2.4G, 5-8 = 5G → band5MinIdx 5 (sama pola HWTC).
    //  - BeaconType='WPAand11i' writable. KeyPassphrase DAN PreSharedKey.1.KeyPassphrase
    //    sama-sama writable → ikut HG8245H (PreSharedKey.1.KeyPassphrase).
    //  - X_HW_HT20 = enum lebar kanal (0/1/2/3), diukur pada SN yang sama 2026-09-25.
    //  - Akun web X_HW_WebUserInfo.1 (Admin) / .2 (Support) — sama dgn HG8245H.
    //  ⚠️ Belum ada uji tulis WiFi di model ini.
    { id: _vmUid(), manufacturer: 'Huawei Technologies Co., Ltd', productClasses: 'HG8245W5-6T',
      template: 'TR098',
      passwordPath: 'PreSharedKey.1.KeyPassphrase',
      beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      band5MinIdx: 5,
      adminSuperPassPath:    'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.Password',
      adminSuperUserPath:    'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.UserName',
      adminSuperCurrentUser: 'Support',
      adminUserPassPath:     'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.Password',
      adminUserUserPath:     'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.UserName',
      adminUserCurrentUser:  'Admin' },
    { id: _vmUid(), manufacturer: 'ETCH', productClasses: 'F9V',
      template: 'TR098',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      // AKUN WEB F9V — DIUJI LIVE 2026-07-13 (SN ELWRP93H6275858). GenieACS menandai
      // AdminName/UserName/UserPassword sebagai _writable=FALSE, TETAPI itu KELIRU: menulis
      // nilai ke ketiganya DITERIMA ONU (task selesai, 0 fault — parameter yang benar-benar
      // read-only akan dibalas cwmp.9008). Jadi keempatnya dibuka. Pelajaran: flag _writable
      // dari firmware TIDAK selalu jujur — buktikan dgn tulis-nilai-sama sebelum mematikan fitur.
      // USERNAME DIKUNCI (2026-10-02): operator membuka web F9V — login hanya memilih
      // "Klik User" / "Klik Administrator" lalu password; username tak dipakai dan tak
      // bisa diganti di sana. Maka panel hanya mengganti PASSWORD. *UserPath kini hanya
      // untuk MENAMPILKAN nama asli dari cache (tidak pernah ditulis): armada berbeda —
      // AdminName 'fujitomo' di sebagian unit, 'superadmin' di 3 unit ETCH.
      adminSuperPassPath:    'InternetGatewayDevice.X_CU_Function.Web.AdminPassword',
      adminSuperUserPath:    'InternetGatewayDevice.X_CU_Function.Web.AdminName',
      adminSuperUserLocked:  true,
      adminUserPassPath:     'InternetGatewayDevice.X_CU_Function.Web.UserPassword',
      adminUserUserPath:     'InternetGatewayDevice.X_CU_Function.Web.UserName',
      adminUserUserLocked:   true },
    { id: _vmUid(), manufacturer: 'FOTC', productClasses: 'F9V',
      template: 'TR098',
      passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i', beaconOpen: 'None', encOpen: 'None',
      ssidFixedSlots: true,
      // AKUN WEB F9V — DIUJI LIVE 2026-07-13 (SN ELWRP93H6275858). GenieACS menandai
      // AdminName/UserName/UserPassword sebagai _writable=FALSE, TETAPI itu KELIRU: menulis
      // nilai ke ketiganya DITERIMA ONU (task selesai, 0 fault — parameter yang benar-benar
      // read-only akan dibalas cwmp.9008). Jadi keempatnya dibuka. Pelajaran: flag _writable
      // dari firmware TIDAK selalu jujur — buktikan dgn tulis-nilai-sama sebelum mematikan fitur.
      // USERNAME DIKUNCI (2026-10-02) — sama dengan entri ETCH di atas: hanya password.
      adminSuperPassPath:    'InternetGatewayDevice.X_CU_Function.Web.AdminPassword',
      adminSuperUserPath:    'InternetGatewayDevice.X_CU_Function.Web.AdminName',
      adminSuperUserLocked:  true,
      adminUserPassPath:     'InternetGatewayDevice.X_CU_Function.Web.UserPassword',
      adminUserUserPath:     'InternetGatewayDevice.X_CU_Function.Web.UserName',
      adminUserUserLocked:   true },
  ];
}
function vmSecSeedDefaults(diam) {
  var existing = _vmSecLoad();
  var toAdd    = _vmSecDefaults().filter(function(def) {
    var defOui = def.oui || '';
    var defPcs = def.productClasses.split(',').map(function(s){ return s.trim().toLowerCase(); });
    return !existing.some(function(e) {
      if ((e.oui || '') !== defOui) return false;
      var ePcs = e.productClasses.split(',').map(function(s){ return s.trim().toLowerCase(); });
      return defPcs.some(function(p){ return ePcs.indexOf(p) !== -1; });
    });
  });
  if (toAdd.length === 0) { if (!diam) showToast('Data default sudah ada', 'info'); return; }
  _vmSecSave(existing.concat(toAdd));
  renderVmSecTable();
  if (!diam) showToast('Data default WiFi config dimuat (' + toAdd.length + ' entri)', 'success');
}

// ─── SEGARKAN DEFAULT (reconcile stale seed) ─────────────────────────────────
// Masalah akar 688AF0: seed lama di localStorage (mis. beaconOpen:'Basic') TIDAK
// ikut ter-update saat default kode diperbaiki (seed hanya menambah, tak pernah
// memperbarui). Fungsi ini menyetel ulang HANYA entri yang scope-nya identik
// dengan default bawaan (oui + daftar productClasses sama) ke nilai known-good
// terbaru. Entri dgn scope BUATAN pengguna (kombinasi berbeda) tak tersentuh.
function _scopeIdent(e) {
  var oui = (e.oui || '').trim().toUpperCase();
  var pcs = (e.productClasses || '').split(',')
    .map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean).sort().join(',');
  return oui + '|' + pcs;
}
// Scope default yang DIPENSIUNKAN: dulu pernah di-seed ke localStorage, kini dihapus
// dari default kode. Tanpa daftar ini, "Segarkan Default" akan menyangka mereka entri
// kustom pengguna dan MEMPERTAHANKANNYA — padahal justru itu ranjaunya (entri generik
// X_CMCC untuk GM220-S/GM220/MQ220 yang menarik ONU X_CT-COM CIOT/ZICG ke jalur salah).
// Format = keluaran _scopeIdent: OUI + '|' + productClasses huruf kecil, DIURUTKAN
// alfabetis (mis. 'GM220-S,GM220' → '|gm220,gm220-s').
var _RETIRED_SCOPES = {
  '|gm220,gm220-s': true,   // WAN generik lama
  '|mq220':         true,   // WAN generik lama
  '|gm220-s,mq220': true,   // Security generik lama (beaconOpen 'Basic' usang)
  // Security ZICG gabungan lama: dipisah 2026-10-02 (GM220-S username 'admin', F650 belum
  // dipastikan). Entri WAN ber-scope sama masih default → langsung ditambahkan ulang.
  '|f650,gm220-s':  true,
  '|fd512xw-r460,fd514gd-r460': true,   // Security C-DATA gabungan lama (dipisah 2026-10-03)
  // Security ZTE gabungan lama: dipisah 2026-10-02 (F663NV3A/a & F463N mendapat path username).
  '|f463n,f650,f663nv3a,f663nv3a,f9v': true,
};
function _refreshDefaults(loadFn, saveFn, defsFn, renderFn, label) {
  var defs = defsFn();
  var defIdents = {};
  defs.forEach(function(d){ defIdents[_scopeIdent(d)] = true; });
  var list    = loadFn();
  // Buang seed usang yang scope-nya sudah dipensiunkan (tak ada lagi di default).
  var live    = list.filter(function(e){ return !_RETIRED_SCOPES[_scopeIdent(e)]; });
  var retired = list.length - live.length;
  // Pertahankan entri yang scope-nya TIDAK sama dgn default mana pun (kustom Anda).
  var kept    = live.filter(function(e){ return !defIdents[_scopeIdent(e)]; });
  var removed = live.length - kept.length;
  // Tambah ulang semua default dengan nilai known-good terbaru (id baru).
  var fresh = kept.concat(defs.map(function(d){ d.id = _vmUid(); return d; }));
  saveFn(fresh);
  renderFn();
  showToast(label + ': ' + defs.length + ' entri default disegarkan'
    + (removed ? ' (' + removed + ' entri default lama diganti)' : '')
    + (retired ? ' (' + retired + ' entri usang dibuang)' : ''), 'success');
}
function vmSecRefreshDefaults() {
  if (typeof confirm === 'function' && !confirm(
      'Segarkan entri default WiFi ke nilai known-good terbaru?\n\n'
    + 'Entri default bawaan (mis. F663NV9, F663NV3A) disetel ulang — memperbaiki '
    + 'seed lama yang usang (mis. Open="Basic" → "None"). Entri dengan scope '
    + 'buatan Anda sendiri TIDAK terpengaruh.')) return;
  _refreshDefaults(_vmSecLoad, function(baru) { simpanProfilServer('security', baru, _vmSecLoad(), renderVmSecTable); },
                   _vmSecDefaults, renderVmSecTable, 'WiFi config');
}
function vcfgRefreshDefaults() {
  if (typeof confirm === 'function' && !confirm(
      'Segarkan entri default Vendor Config ke nilai known-good terbaru?\n\n'
    + 'Entri default bawaan disetel ulang. Entri dengan scope buatan Anda '
    + 'sendiri TIDAK terpengaruh.')) return;
  _refreshDefaults(_vcfgLoad, function(baru) { simpanProfilServer('wan', baru, _vcfgLoad(), renderVcfgTable); },
                   _vcfgDefaults, renderVcfgTable, 'Vendor config');
}

function renderVmSecTable() {
  var tbody = document.getElementById('vmSecTableBody');
  if (!tbody) return;
  var list = _vmSecLoad();
  _stUpdateBadges();
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="vm-empty-row">'
      + 'Belum ada konfigurasi &mdash; '
      + '<button class="vm-btn-seed" onclick="vmSecSeedDefaults()"><i class="fas fa-wand-magic-sparkles"></i> Muat Data Default</button>'
      + ' atau klik <strong>Add WiFi Config</strong>'
      + '</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(function(c) {
    var pcs = c.productClasses.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    var pcHtml = pcs.map(function(p){ return '<span class="vm-badge">' + _vmEsc(p) + '</span>'; }).join(' ');
    var scope = [];
    if (c.manufacturer) scope.push('<i class="fas fa-industry"></i> ' + _vmEsc(c.manufacturer));
    if (c.oui)          scope.push('<i class="fas fa-fingerprint"></i> ' + _vmEsc(c.oui));
    var scopeHtml = scope.length ? '<div style="font-size:10px;color:var(--text-muted);margin-top:3px">' + scope.join(' &middot; ') + '</div>' : '';
    return '<tr>'
      + '<td><div class="vm-pc-cell">' + pcHtml + '</div>' + scopeHtml + '</td>'
      + '<td><code class="vm-code">' + _vmEsc(c.passwordPath || 'KeyPassphrase') + '</code></td>'
      + '<td><span class="vm-badge vm-badge-wpa">' + _vmEsc(c.beaconWpa || 'WPA/WPA2') + '</span></td>'
      + '<td><span class="vm-badge vm-badge-open">' + _vmEsc(c.beaconOpen || 'None') + '</span></td>'
      + '<td><span class="vm-badge">' + _vmEsc(c.encOpen || 'None') + '</span></td>'
      + '<td class="vm-actions-cell">'
      + '<button class="vm-btn-icon" title="Edit" onclick="vmSecEdit(\'' + c.id + '\')"><i class="fas fa-pen-to-square"></i></button>'
      + '<button class="vm-btn-icon" title="Duplikat" onclick="vmSecDuplicate(\'' + c.id + '\')"><i class="fas fa-copy"></i></button>'
      + '<button class="vm-btn-icon vm-btn-del" title="Hapus" onclick="vmSecDelete(\'' + c.id + '\')"><i class="fas fa-trash"></i></button>'
      + '</td></tr>';
  }).join('');
}

var _vmEditId = null;

// Isi field "lanjutan" (ssidRoot/channelWidth/admin/features) dari objek profil
function _vmSecFillProfile(p) {
  _vmFld('vmSsidRoot',            p.ssidRoot || '');
  _vmFld('vmChannelWidthParam',   p.channelWidthParam || '');
  _vmFld('vmChannelWidthType',    p.channelWidthType || 'xcmcc');
  _vmFld('vmAdminSuperPassPath',  p.adminSuperPassPath || '');
  _vmFld('vmAdminUserPassPath',   p.adminUserPassPath || '');
  var feat = p.features || {};
  ['addSsid','channel','bandwidth','maxClients'].forEach(function(f){ _vmChk('vmFeat_' + f, feat[f]); });
  // Lanjutan (hasil audit model) — lihat pages/settings.html.
  _vmFld('vmAdminSuperUserPath',    p.adminSuperUserPath || '');
  _vmFld('vmAdminSuperCurrentUser', p.adminSuperCurrentUser || '');
  _vmFld('vmAdminUserUserPath',     p.adminUserUserPath || '');
  _vmFld('vmAdminUserCurrentUser',  p.adminUserCurrentUser || '');
  _vmFld('vmAdminUserNote',         p.adminUserNote || '');
  _vmChk('vmAdminSuperUserLocked',  p.adminSuperUserLocked);
  _vmChk('vmAdminUserUserLocked',   p.adminUserUserLocked);
  _vmChk('vmAdminUserSupported',    p.adminUserSupported !== false);
  _vmChk('vmAdminSuperCekAda',      p.adminSuperCekAda);
  _vmChk('vmChannelAutoZero',       p.channelAutoZero);
  _vmFld('vmBw5Extra',              (p.bw5Extra || []).join(','));
  _vmFld('vmRemotePath',            p.remotePath || '');
  _vmFld('vmEncModes',              p.encModes && p.encModes.length ? JSON.stringify(p.encModes, null, 2) : '');
}

function vmSecAdd() {
  _vmEditId = null;
  var t = document.getElementById('vmSecModalTitle');
  if (t) t.innerHTML = '<i class="fas fa-shield-halved"></i> Add WiFi Config';
  _vmFld('vmProductClasses',''); _vmFld('vmManufacturer',''); _vmFld('vmOui','');
  _vmFld('vmPasswordPath','KeyPassphrase');
  _vmFld('vmBeaconWpa','WPA/WPA2'); _vmFld('vmBeaconOpen','None'); _vmFld('vmEncOpen','None');
  _fillTemplateSelect('vmTemplate', listSecurityTemplates(), 'X_CMCC');
  _vmSecFillProfile(SECURITY_PROFILE_DEFAULT);   // prefill field lanjutan dari default F663NV9
  document.getElementById('vmSecModal').classList.remove('hidden');
}

function vmSecEdit(id) {
  var list = _vmSecLoad();
  var c = null;
  for (var i = 0; i < list.length; i++) { if (list[i].id === id) { c = list[i]; break; } }
  if (!c) return;
  _vmEditId = id;
  var t = document.getElementById('vmSecModalTitle');
  if (t) t.innerHTML = '<i class="fas fa-pen-to-square"></i> Edit WiFi Config';
  _vmFld('vmProductClasses', c.productClasses);
  _vmFld('vmManufacturer',   c.manufacturer);
  _vmFld('vmOui',            c.oui);
  _vmFld('vmPasswordPath',   c.passwordPath);
  _vmFld('vmBeaconWpa',      c.beaconWpa);
  _vmFld('vmBeaconOpen',     c.beaconOpen);
  _vmFld('vmEncOpen',        c.encOpen);
  // Field lanjutan: tampilkan hasil merge (template entri + override tersimpan)
  _fillTemplateSelect('vmTemplate', listSecurityTemplates(), c.template || 'X_CMCC');
  // Nilai EFEKTIF: entri tersimpan + tambalan dari kode (seed lama) — sama dengan yang
  // dipakai panel. Field di luar daftar _secProfileMerge (encModes, remotePath, dst.)
  // disalin langsung.
  var ef = c.disunting ? c
    : (getVendorSecurityConfig((c.productClasses || '').split(',')[0].trim(), c.oui, c.manufacturer) || c);
  if (ef.id !== c.id) ef = c;      // entri ini tidak menang untuk scope-nya → tampilkan apa adanya
  var pf = _secProfileMerge(_secTemplate(c.template), ef);
  ['adminSuperCekAda', 'channelAutoZero', 'bw5Extra', 'remotePath', 'encModes'].forEach(function(k) { pf[k] = ef[k]; });
  // Path akun: tampilkan yang tersimpan di ENTRI, bukan bawaan template (VirtualParameters).
  pf.adminSuperPassPath = ef.adminSuperPassPath || '';
  pf.adminUserPassPath  = ef.adminUserPassPath  || '';
  _vmSecFillProfile(pf);
  document.getElementById('vmSecModal').classList.remove('hidden');
}

// Duplikat WiFi config: isi dari entri sumber, simpan sebagai entri BARU.
function vmSecDuplicate(id) {
  vmSecEdit(id);
  _vmEditId = null;
  var t = document.getElementById('vmSecModalTitle');
  if (t) t.innerHTML = '<i class="fas fa-copy"></i> Duplikat WiFi Config (entri baru)';
  showToast('Duplikat: ubah OUI/Product agar tak bentrok, lalu Simpan', 'info');
}

function vmSecDelete(id) {
  if (!confirm('Hapus konfigurasi WiFi ini?')) return;
  var lamaS = _vmSecLoad();
  simpanProfilServer('security', lamaS.filter(function(x){ return x.id !== id; }), lamaS, renderVmSecTable)
    .then(function(ok) { if (ok) { renderVmSecTable(); showToast('Konfigurasi WiFi dihapus', 'success'); } });
}

function vmSecSave() {
  var pcs     = (_getVal('vmProductClasses') || '').trim();
  var pwdPath = (_getVal('vmPasswordPath')   || 'KeyPassphrase').trim() || 'KeyPassphrase';
  var bWpa    = (_getVal('vmBeaconWpa')      || 'WPA/WPA2').trim()     || 'WPA/WPA2';
  var bOpen   = (_getVal('vmBeaconOpen')     || 'None').trim()         || 'None';
  var enc     = (_getVal('vmEncOpen')        || 'None').trim()         || 'None';
  var _mfr    = _getVal('vmManufacturer').trim();
  var _oui    = _getVal('vmOui').trim().toUpperCase();
  if (!pcs && !_oui && !_mfr) { showToast('Isi minimal salah satu: OUI, Manufacturer, atau Product Class', 'error'); return; }
  // Validasi field lanjutan SEBELUM apa pun disimpan — isian yang salah tidak boleh
  // diam-diam menjadi profil yang dipakai ke ONU pelanggan.
  var remotePath = _getVal('vmRemotePath').trim();
  if (remotePath && (!/^\/[A-Za-z0-9._~\/-]*$/.test(remotePath) || remotePath.indexOf('//') >= 0 || remotePath.indexOf('..') >= 0)) {
    showToast('Halaman awal Remote harus berupa path lokal yang diawali "/" (tanpa http:// dan tanpa "..")', 'error'); return;
  }
  var encModes = [];
  var encTeks = _getVal('vmEncModes').trim();
  if (encTeks) {
    try { encModes = JSON.parse(encTeks); } catch (e) { showToast('Pilihan Encryption Type bukan JSON yang sah', 'error'); return; }
    var sah = Array.isArray(encModes) && encModes.every(function(m) {
      return m && typeof m.id === 'string' && m.id && m.id !== 'none' && m.id !== 'wpa'
          && typeof m.label === 'string' && m.label && typeof m.beacon === 'string' && m.beacon
          && (m.set == null || (typeof m.set === 'object' && !Array.isArray(m.set)));
    });
    if (!sah) { showToast('Tiap pilihan enkripsi wajib punya id, label, beacon (dan set berupa objek). id tidak boleh "none"/"wpa".', 'error'); return; }
  }
  // Field lanjutan (Fase 1/2) + grouping vendor (Manufacturer / OUI)
  var adv = {
    manufacturer:       _mfr,
    oui:                _oui,
    template:           _getVal('vmTemplate') || 'X_CMCC',   // Lapis 1: keluarga param
    ssidRoot:           _getVal('vmSsidRoot').trim(),
    channelWidthParam:  _getVal('vmChannelWidthParam').trim(),
    channelWidthType:   _getVal('vmChannelWidthType').trim() || 'xcmcc',
    adminSuperPassPath: _getVal('vmAdminSuperPassPath').trim(),
    adminUserPassPath:  _getVal('vmAdminUserPassPath').trim(),
    // ── Lanjutan (hasil audit model, 2026-10-03) ──
    adminSuperUserPath:    _getVal('vmAdminSuperUserPath').trim(),
    adminSuperCurrentUser: _getVal('vmAdminSuperCurrentUser').trim(),
    adminSuperUserLocked:  _vmChkGet('vmAdminSuperUserLocked'),
    adminUserUserPath:     _getVal('vmAdminUserUserPath').trim(),
    adminUserCurrentUser:  _getVal('vmAdminUserCurrentUser').trim(),
    adminUserUserLocked:   _vmChkGet('vmAdminUserUserLocked'),
    adminUserSupported:    _vmChkGet('vmAdminUserSupported'),
    adminUserNote:         _getVal('vmAdminUserNote').trim(),
    adminSuperCekAda:      _vmChkGet('vmAdminSuperCekAda'),
    channelAutoZero:       _vmChkGet('vmChannelAutoZero'),
    bw5Extra:              _getVal('vmBw5Extra').split(',').map(function(x) { return x.trim(); }).filter(Boolean),
    remotePath:            remotePath,
    encModes:              encModes,
    // Ditandai agar tambalan otomatis dari kode tidak menimpa pilihan operator.
    disunting:             true,
    features: {
      addSsid:    _vmChkGet('vmFeat_addSsid'),
      channel:    _vmChkGet('vmFeat_channel'),
      bandwidth:  _vmChkGet('vmFeat_bandwidth'),
      maxClients: _vmChkGet('vmFeat_maxClients'),
    },
  };
  var list = _vmSecLoad();
  if (_vmEditId) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === _vmEditId) {
        list[i] = Object.assign({}, list[i], { id: _vmEditId, productClasses: pcs, passwordPath: pwdPath, beaconWpa: bWpa, beaconOpen: bOpen, encOpen: enc }, adv);
        break;
      }
    }
  } else {
    list.push(Object.assign({ id: _vmUid(), productClasses: pcs, passwordPath: pwdPath, beaconWpa: bWpa, beaconOpen: bOpen, encOpen: enc }, adv));
  }
  // Ke server dulu (berlaku untuk SEMUA teknisi); cache browser mengikuti.
  simpanProfilServer('security', list, _vmSecLoad(), renderVmSecTable).then(function(ok) {
    if (!ok) return;
    document.getElementById('vmSecModal').classList.add('hidden');
    renderVmSecTable();
    showToast('Konfigurasi WiFi disimpan untuk semua pengguna', 'success');
  });
}

// ════════════════════════════════════════════════════════════════
// PAGE INIT
// ════════════════════════════════════════════════════════════════
function initSettings() {
  setTheme(App.theme);
  _populateForm();
  _stNavInit();
  _stNavRapikan();
  _initAccount();
  _initSystem();
  _vpInit();

  // Form diisi dari cache dulu (instan), lalu diselaraskan dengan server.
  // Urutannya begini supaya field tidak berkedip kosong saat jaringan lambat.
  syncSettingsFromServer()
    .then(function () { _populateForm(); renderVcfgTable(); renderVmSecTable(); })
    .catch(function () { /* offline → cache tetap dipakai */ });

  // Auto-seed defaults on first load (jika belum ada data). Diam: ini pengisian cache
  // browser, bukan tindakan pengguna — dulu toast-nya muncul tiap Settings pertama kali
  // dibuka di browser baru, juga bagi role user yang tak punya menu profil vendor.
  if (_vcfgLoad().length === 0)  vcfgSeedDefaults(true);
  if (_vmSecLoad().length === 0) vmSecSeedDefaults(true);

  // Wire Vendor Config (WAN) modal
  var addVcfg = document.getElementById('btnAddVcfg');
  if (addVcfg) addVcfg.addEventListener('click', vcfgAdd);
  var refreshVcfg = document.getElementById('btnRefreshVcfg');
  if (refreshVcfg) refreshVcfg.addEventListener('click', vcfgRefreshDefaults);
  var saveVcfg = document.getElementById('btnVcfgSave');
  if (saveVcfg) saveVcfg.addEventListener('click', vcfgSave);
  var applyVcfgTpl = document.getElementById('vcfgApplyTpl');
  if (applyVcfgTpl) applyVcfgTpl.addEventListener('click', _applyWanTemplate);
  _bindModal('vcfgModal',  'btnVcfgClose',  'btnVcfgCancel');

  // Wire Security Setting (WiFi) modal
  var addVmSec = document.getElementById('btnAddVmSec');
  if (addVmSec) addVmSec.addEventListener('click', vmSecAdd);
  var refreshVmSec = document.getElementById('btnRefreshVmSec');
  if (refreshVmSec) refreshVmSec.addEventListener('click', vmSecRefreshDefaults);
  var saveVmSec = document.getElementById('btnVmSecSave');
  if (saveVmSec) saveVmSec.addEventListener('click', vmSecSave);
  var applyVmTpl = document.getElementById('vmApplyTpl');
  if (applyVmTpl) applyVmTpl.addEventListener('click', _applySecTemplate);
  _bindModal('vmSecModal', 'btnVmSecClose', 'btnVmSecCancel');

  // Wire tombol "Uji Param ke Perangkat" (probe read-only) di kedua modal
  var vcfgProbe = document.getElementById('vcfgProbeBtn');
  if (vcfgProbe) vcfgProbe.addEventListener('click', function(){ _paramProbe('vcfgProbeSn','vcfgProbePath','vcfgProbeResult'); });
  var vmProbe = document.getElementById('vmProbeBtn');
  if (vmProbe) vmProbe.addEventListener('click', function(){ _paramProbe('vmProbeSn','vmProbePath','vmProbeResult'); });

  // Update sidebar count badges
  _stUpdateBadges();

  // About → Total Devices (use cached list, otherwise fetch)
  var totEl = document.getElementById('stTotalDevices');
  if (totEl) {
    if (App.devices && App.devices.length) {
      totEl.textContent = App.devices.length.toLocaleString('id-ID');
    } else {
      ACS.loadAll()
        .then(function(ds) { totEl.textContent = ds.length.toLocaleString('id-ID'); })
        .catch(function() { totEl.textContent = '—'; });
    }
  }
}

PAGE_INIT['settings'] = initSettings;
