/* ═══════════════════════════════════════════════════════════════
   Panel ACS — Master Data
   (OLT, PON, rasio tap coupler, PLC splitter)

   Data di halaman ini adalah acuan SELURUH diagram Data ODC. Karena itu
   dua hal dijaga ketat di sini:

     • Validasinya juga ada di server (masterdata.py). Yang di sini hanya
       supaya salahnya ketahuan sebelum menekan Simpan — bukan penggantinya.

     • Menghapus tidak pernah diam-diam. Server menjawab 409 beserta daftar
       apa saja yang ikut terdampak; daftar itu ditampilkan lebih dulu, dan
       penghapusan baru diulang dengan force setelah pengguna setuju.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

let _mdData = { olt: [], pon: [], tap: [], plc: [] };
let _mdTab  = 'tap';

const MD_SPEC = {
  tap: {
    label: 'Rasio Splitter (Tap Coupler)',
    satuan: 'rasio',
    icon:  'fa-arrows-split-up-and-left',
    tambah: 'Tambah Rasio',
    kosong: 'Belum ada rasio splitter.',
    kunci: r => r.rasio,
  },
  plc: {
    label: 'PLC Splitter',
    satuan: 'PLC splitter',
    icon:  'fa-code-branch',
    tambah: 'Tambah PLC',
    kosong: 'Belum ada PLC splitter.',
    kunci: r => r.rasio,
  },
  olt: {
    label: 'OLT',
    satuan: 'OLT',
    icon:  'fa-server',
    tambah: 'Tambah OLT',
    kosong: 'Belum ada OLT terdaftar. Tambahkan OLT lebih dulu — port PON menggantung padanya.',
    kunci: r => r.nama,
  },
  pon: {
    label: 'Port PON',
    satuan: 'PON',
    icon:  'fa-ethernet',
    tambah: 'Tambah PON',
    kosong: 'Belum ada port PON.',
    kunci: r => r.nama,
  },
};

const _mdAdmin = () => !!(App.user && App.user.role === 'administrator');

function _mdActions(type, id) {
  if (!_mdAdmin()) return '';
  return '<div class="rowact">'
    + '<button title="Edit" data-md-edit="' + id + '"><i class="fas fa-pen"></i></button>'
    + '<button class="dgr" title="Hapus" data-md-del="' + id + '"><i class="fas fa-trash"></i></button>'
    + '</div>';
}

// ═══════════ Render ═══════════
/* Kotak kecil untuk data yang isinya hanya angka pendek (rasio & PLC).
   Aksinya ditumpuk di pojok dan baru muncul saat disorot — kalau ikut
   menempati ruang tetap, kotaknya jadi dua kali lebih besar dan seluruh
   gunanya hilang. */
function _mdTile(inner, id) {
  return '<div class="msd-tile">' + inner
    + (_mdAdmin()
        ? '<div class="msd-tile-act">'
          + '<button title="Edit" data-md-edit="' + id + '"><i class="fas fa-pen"></i></button>'
          + '<button class="dgr" title="Hapus" data-md-del="' + id + '"><i class="fas fa-trash"></i></button>'
          + '</div>'
        : '')
    + '</div>';
}

function _mdVal(warna, angka) {
  return '<span class="msd-tile-v"><i class="msd-d ' + warna + '"></i>'
       + angka.toFixed(2) + '<em>dB</em></span>';
}

function renderMasterData() {
  const head = document.getElementById('msdHead');
  const body = document.getElementById('msdBody');
  const grid = document.getElementById('msdGrid');
  const tbl  = document.getElementById('msdTableWrap');
  const foot = document.getElementById('msdFoot');
  if (!head || !body || !grid || !tbl) return;

  const spec = MD_SPEC[_mdTab];
  const rows = _mdData[_mdTab] || [];
  const act  = _mdAdmin() ? '<th style="width:78px"></th>' : '';
  const pakaiKisi = (_mdTab === 'tap' || _mdTab === 'plc');

  grid.hidden = !pakaiKisi;
  tbl.hidden  = pakaiKisi;

  document.getElementById('msdTitle').textContent   = spec.label;
  document.getElementById('msdIcon').className      = 'fas ' + spec.icon;
  document.getElementById('msdAddLabel').textContent = spec.tambah;

  ['tap', 'plc', 'olt', 'pon'].forEach(t => {
    const el = document.getElementById('msdCount' + t.charAt(0).toUpperCase() + t.slice(1));
    if (el) el.textContent = (_mdData[t] || []).length;
  });
  document.querySelectorAll('.msd-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.md === _mdTab));

  if (!rows.length) {
    head.innerHTML = '';
    const kosong = '<i class="fas ' + spec.icon + '"></i> ' + escHtml(spec.kosong);
    if (pakaiKisi) grid.innerHTML = '<div class="msd-empty">' + kosong + '</div>';
    else           body.innerHTML = '<tr><td class="msd-empty">' + kosong + '</td></tr>';
    foot.textContent = '';
    return;
  }

  if (_mdTab === 'tap') {
    grid.innerHTML = rows.map(r => _mdTile(
      '<b class="msd-tile-hd">' + escHtml(r.rasio) + '</b>'
      + _mdVal('b', r.loss_biru)
      + _mdVal('r', r.loss_merah), r.id)).join('');
    foot.textContent = 'Angka pertama adalah porsi kecil — keluaran biru, di baris atas. '
      + 'Porsi kecil selalu kehilangan lebih banyak daya daripada porsi besar (merah).';
    return;
  }

  if (_mdTab === 'plc') {
    grid.innerHTML = rows.map(r => _mdTile(
      '<b class="msd-tile-hd">' + escHtml(r.rasio) + '</b>'
      + _mdVal('c', r.loss_db)
      + '<span class="msd-tile-sub">' + r.jumlah_port + ' port</span>', r.id)).join('');
    foot.textContent = 'Redaman PLC dihitung dari satu masukan ke setiap keluaran.';
    return;
  }

  if (_mdTab === 'olt') {
    head.innerHTML = '<tr><th>Nama OLT</th><th>Keterangan</th><th style="width:110px">Port PON</th>' + act + '</tr>';
    body.innerHTML = rows.map(r =>
      '<tr><td class="fw6">' + escHtml(r.nama) + '</td>'
      + '<td class="msd-muted">' + (escHtml(r.keterangan) || '—') + '</td>'
      + '<td>' + (r.jumlah_pon
          ? '<span class="badge bg-violet">' + r.jumlah_pon + ' PON</span>'
          : '<span class="msd-muted">belum ada</span>') + '</td>'
      + (act ? '<td>' + _mdActions('olt', r.id) + '</td>' : '') + '</tr>').join('');
    foot.textContent = '';
    return;
  }

  // PON
  head.innerHTML = '<tr><th style="width:190px">OLT Induk</th><th>Nama PON</th><th>Keterangan</th>' + act + '</tr>';
  body.innerHTML = rows.map(r =>
    '<tr><td class="msd-muted"><i class="fas fa-server"></i> ' + escHtml(r.olt_nama) + '</td>'
    + '<td class="fw6 msd-mono">' + escHtml(r.nama) + '</td>'
    + '<td class="msd-muted">' + (escHtml(r.keterangan) || '—') + '</td>'
    + (act ? '<td>' + _mdActions('pon', r.id) + '</td>' : '') + '</tr>').join('');
  foot.textContent = '';
}

// ═══════════ Form tambah / edit ═══════════
function _mdFields(type, row) {
  row = row || {};
  const opt = (_mdData.olt || []).map(o =>
    '<option value="' + o.id + '"' + (o.id === row.olt_id ? ' selected' : '') + '>'
    + escHtml(o.nama) + '</option>').join('');

  if (type === 'tap') return ''
    + _fld('Rasio', '<input class="form-input" id="mdRasio" placeholder="10/90" spellcheck="false" value="'
        + escHtml(row.rasio || '') + '">', 'Porsi kecil / porsi besar. Totalnya harus 100.')
    + '<div class="form-row">'
    + _fld('Redaman Output Biru (dB)', '<input class="form-input" type="number" step="0.01" min="0.01" id="mdBiru" value="'
        + (row.loss_biru != null ? row.loss_biru : '') + '">', 'Porsi kecil — rugi dayanya lebih besar.')
    + _fld('Redaman Output Merah (dB)', '<input class="form-input" type="number" step="0.01" min="0.01" id="mdMerah" value="'
        + (row.loss_merah != null ? row.loss_merah : '') + '">', 'Porsi besar — rugi dayanya lebih kecil.')
    + '</div>';

  if (type === 'plc') return ''
    + _fld('Rasio PLC', '<input class="form-input" id="mdRasio" placeholder="1:8" spellcheck="false" value="'
        + escHtml(row.rasio || '') + '">', 'Bentuk 1:N, mis. 1:8. Jumlah port diambil dari N.')
    + _fld('Redaman (dB)', '<input class="form-input" type="number" step="0.01" min="0.01" id="mdLoss" value="'
        + (row.loss_db != null ? row.loss_db : '') + '">', 'Dari satu masukan ke setiap keluaran.');

  if (type === 'olt') return ''
    + _fld('Nama OLT', '<input class="form-input" id="mdNama" placeholder="OLT-SKY-01" spellcheck="false" value="'
        + escHtml(row.nama || '') + '">')
    + _fld('Keterangan', '<input class="form-input" id="mdKet" placeholder="Lokasi / catatan" value="'
        + escHtml(row.keterangan || '') + '">', 'Boleh dikosongkan.');

  return ''
    + _fld('OLT Induk', '<select class="form-input" id="mdOlt">' + opt + '</select>')
    + _fld('Nama PON', '<input class="form-input" id="mdNama" placeholder="PON 1/3" spellcheck="false" value="'
        + escHtml(row.nama || '') + '">', 'Boleh sama antar OLT — keunikannya per OLT.')
    + _fld('Keterangan', '<input class="form-input" id="mdKet" placeholder="Catatan" value="'
        + escHtml(row.keterangan || '') + '">', 'Boleh dikosongkan.');
}

function _fld(label, input, hint) {
  return '<div class="form-group"><label>' + escHtml(label) + '</label>' + input
       + (hint ? '<small class="msd-hint">' + escHtml(hint) + '</small>' : '') + '</div>';
}

function _mdCollect(type) {
  const v = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  if (type === 'tap') return { rasio: v('mdRasio'), loss_biru: v('mdBiru'), loss_merah: v('mdMerah') };
  if (type === 'plc') return { rasio: v('mdRasio'), loss_db: v('mdLoss') };
  if (type === 'olt') return { nama: v('mdNama'), keterangan: v('mdKet') };
  return { olt_id: v('mdOlt'), nama: v('mdNama'), keterangan: v('mdKet') };
}

function openMasterEditor(type, row) {
  const spec = MD_SPEC[type];
  const edit = !!row;

  if (type === 'pon' && !(_mdData.olt || []).length) {
    showToast('Tambahkan OLT lebih dulu — port PON harus punya induk', 'error');
    return;
  }

  const prev = document.getElementById('mdEditor');
  if (prev) prev.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'mdEditor';
  ov.innerHTML =
    '<div class="modal" style="max-width:520px">'
    + '<div class="modal-header"><h3><i class="fas ' + (edit ? 'fa-pen' : 'fa-plus') + '"></i> '
    +   escHtml((edit ? 'Edit ' : 'Tambah ') + spec.satuan) + '</h3>'
    + '<button class="modal-close" data-act="no"><i class="fas fa-xmark"></i></button></div>'
    + '<div class="modal-body">'
    +   '<div class="login-error" id="mdErr" hidden></div>'
    +   _mdFields(type, row)
    +   '<div class="btn-row" style="margin-top:4px;justify-content:flex-end;gap:8px">'
    +     '<button class="btn btn-ghost" data-act="no">Batal</button>'
    +     '<button class="btn btn-primary" data-act="yes"><i class="fas fa-save"></i> Simpan</button>'
    +   '</div>'
    + '</div></div>';
  document.body.appendChild(ov);

  const close = () => ov.remove();
  const err = msg => {
    const e = document.getElementById('mdErr');
    e.textContent = msg; e.hidden = false;
  };

  ov.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]');
    if (!act) { if (e.target === ov) close(); return; }
    if (act.dataset.act === 'no') { close(); return; }

    act.disabled = true;
    try {
      await authFetch('/config/master/' + type + (edit ? '/' + row.id : ''),
                      { method: 'POST', body: _mdCollect(type) });
      close();
      showToast((edit ? 'Perubahan disimpan' : 'Data ditambahkan') + ' — ' + spec.satuan, 'success');
      await loadMasterData();
    } catch (ex) {
      act.disabled = false;
      err(ex.message);
    }
  });

  const first = ov.querySelector('input, select');
  if (first) setTimeout(() => first.focus(), 60);
}

// ═══════════ Hapus ═══════════
async function deleteMasterRow(type, row) {
  const spec = MD_SPEC[type];
  const nama = spec.kunci(row);

  // Percobaan pertama TANPA force: server yang memutuskan apakah ada yang
  // terdampak. Klien sengaja tidak menebak sendiri — ia tidak punya
  // gambaran utuh isi database.
  try {
    await authFetch('/config/master/' + type + '/' + row.id, { method: 'DELETE' });
    showToast(spec.satuan + ' "' + nama + '" dihapus', 'success');
    await loadMasterData();
    return;
  } catch (ex) {
    const imp = ex.data && ex.data.impact;
    if (ex.status !== 409 || !imp) {
      // Tidak ada yang terdampak → tetap konfirmasi biasa, lalu ulangi.
      if (ex.status === 409) { showToast(ex.message, 'error'); return; }
      showToast(ex.message, 'error');
      return;
    }
    _confirmDampak(type, row, nama, imp);
  }
}

function _confirmDampak(type, row, nama, imp) {
  const daftar = (imp.daftar || []).map(d =>
    '<div class="imp-row"><i class="fas ' + (imp.jenis === 'odc' ? 'fa-diagram-project' : 'fa-ethernet')
    + '"></i> <b>' + escHtml(d) + '</b></div>').join('');
  const sisa = imp.jumlah - (imp.daftar || []).length;

  const pesan =
    '<div class="imp-head"><i class="fas fa-triangle-exclamation"></i><div>'
    + '<b>' + escHtml(MD_SPEC[type].satuan + ' "' + nama + '" masih dipakai') + '</b>'
    + '<p>' + (imp.jenis === 'pon'
        ? escHtml(imp.jumlah + ' port PON di bawahnya akan ikut terhapus. Tindakan ini tidak bisa dibatalkan.')
        : escHtml(imp.jumlah + ' topologi ODC memakainya. Diagramnya tidak rusak — '
                  + 'nilainya dibekukan pada angka terakhir, tapi node yang memakainya tidak bisa '
                  + 'dihitung ulang sampai Anda memilih pengganti.'))
    + '</p></div></div>'
    + '<div class="imp-cap">Terdampak</div>'
    + '<div class="imp-list">' + daftar
    + (sisa > 0 ? '<div class="imp-row msd-muted">… dan ' + sisa + ' lainnya</div>' : '')
    + '</div>';

  showConfirm({
    title: 'Hapus ' + MD_SPEC[type].satuan + ' "' + nama + '"?',
    icon: 'fa-triangle-exclamation',
    message: pesan,
    requireText: 'HAPUS',
    danger: true,
    yesLabel: 'Hapus',
  }, async () => {
    try {
      await authFetch('/config/master/' + type + '/' + row.id + '?force=1', { method: 'DELETE' });
      showToast(MD_SPEC[type].satuan + ' "' + nama + '" dihapus', 'success');
      await loadMasterData();
    } catch (ex) {
      showToast(ex.message, 'error');
    }
  });
}

// ═══════════ Muat & pasang ═══════════
async function loadMasterData() {
  try {
    _mdData = await authFetch('/config/master');
  } catch (e) {
    _mdData = { olt: [], pon: [], tap: [], plc: [] };
    showToast('Gagal memuat Master Data: ' + e.message, 'error');
  }
  renderMasterData();
}

function initMasterData() {
  const tabs = document.getElementById('msdTabs');
  if (tabs) tabs.onclick = e => {
    const b = e.target.closest('.msd-tab');
    if (!b) return;
    _mdTab = b.dataset.md;
    renderMasterData();
  };

  const add = document.getElementById('msdAdd');
  if (add) add.onclick = () => openMasterEditor(_mdTab, null);

  // Satu pendengar di wadahnya, bukan satu per tombol: isinya digambar ulang
  // tiap kali data berubah, dan pendengar per tombol akan ikut hilang-timbul.
  // Dipasang di KEDUA wadah — tabel (OLT/PON) dan kisi kotak (rasio/PLC).
  const klik = e => {
    const ed = e.target.closest('[data-md-edit]');
    const dl = e.target.closest('[data-md-del]');
    if (!ed && !dl) return;
    const id  = parseInt((ed || dl).dataset.mdEdit || (ed || dl).dataset.mdDel, 10);
    const row = (_mdData[_mdTab] || []).filter(r => r.id === id)[0];
    if (!row) return;
    if (ed) openMasterEditor(_mdTab, row);
    else    deleteMasterRow(_mdTab, row);
  };
  ['msdBody', 'msdGrid'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.onclick = klik;
  });

  loadMasterData();
}

PAGE_INIT['master-data'] = initMasterData;
PAGE_ACTIONS['master-data'] = { refresh: () => loadMasterData() };
