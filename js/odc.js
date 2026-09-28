/* ═══════════════════════════════════════════════════════════════
   Panel ACS — Data ODC: topologi jalur kabel FTTH

   SELURUH ANGKA DAYA DATANG DARI SERVER (odc.py). Berkas ini tidak
   pernah menghitung dB sendiri — kalau rumusnya disalin ke sini, suatu
   hari layar dan ekspor PDF akan menampilkan dua angka berbeda yang
   sama-sama tampak masuk akal, dan tak ada yang tahu mana yang benar.

   TATA LETAK: otomatis dulu, manual bila perlu. Topologi FTTH selalu
   pohon (satu serat menuju satu tempat), jadi posisi awalnya bisa
   disimpulkan — tak ada yang perlu ditata sendiri untuk mulai bekerja.
   Kartu yang PERNAH digeser menyimpan koordinatnya (pos_x/pos_y) dan
   sejak itu tidak ikut dihitung ulang; sisanya tetap menata diri. Jadi
   menambah cabang baru tidak pernah mengacak susunan yang sudah diatur
   tangan. Tombol Rapikan mengembalikan semuanya ke otomatis.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

let _odcItems = [];
let _odcData  = null;        // hasil /config/odc/<id>
let _odcMaster = null;       // master data (rasio, plc, olt, pon)
let _odcView  = { x: 30, y: 20, k: 0.9 };
let _odcLaid  = [];          // node yang sedang tergambar, lengkap dengan _x/_y

const ODC_CARD_W = 190;
const ODC_COL_GAP = 70;
const ODC_ROW_GAP = 16;

/* Warna core standar TIA/EIA-598 — urutan 1..12 persis urutan di kabel. */
const ODC_CORES = [
  { n: 1,  nama: 'Biru',    hex: '#0072CE' }, { n: 2,  nama: 'Oranye', hex: '#F5811F' },
  { n: 3,  nama: 'Hijau',   hex: '#00A651' }, { n: 4,  nama: 'Coklat', hex: '#7B4A2D' },
  { n: 5,  nama: 'Abu-abu', hex: '#9AA3AD' }, { n: 6,  nama: 'Putih',  hex: '#F2F4F7' },
  { n: 7,  nama: 'Merah',   hex: '#E4322B' }, { n: 8,  nama: 'Hitam',  hex: '#22262E' },
  { n: 9,  nama: 'Kuning',  hex: '#F2C200' }, { n: 10, nama: 'Ungu',   hex: '#7D3F98' },
  { n: 11, nama: 'Pink',    hex: '#F49AC1' }, { n: 12, nama: 'Tosca',  hex: '#00B2A9' },
];
const odcCore = n => ODC_CORES[((n || 1) - 1 + 12) % 12];

const ODC_ST = {
  kuat:  { l: 'TERLALU KUAT', i: 'fa-bolt' },
  ideal: { l: 'IDEAL',        i: 'fa-check' },
  cukup: { l: 'CUKUP',        i: 'fa-triangle-exclamation' },
  buruk: { l: 'LEMAH',        i: 'fa-xmark' },
};

const _odcAdmin = () => !!(App.user && App.user.role === 'administrator');
const _odcFmt = v => (v === null || v === undefined)
  ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2);

function _odcPill(st) {
  if (!st || !ODC_ST[st]) return '';
  return '<span class="pill pill-' + st + '"><i class="fas ' + ODC_ST[st].i + '"></i>'
       + ODC_ST[st].l + '</span>';
}

// ═══════════════════════════════════════════════════════════════
//  1 · DAFTAR
// ═══════════════════════════════════════════════════════════════
function renderOdcList() {
  const body = document.getElementById('odcBody');
  if (!body) return;
  const q = (document.getElementById('odcCari') || {}).value || '';
  const cari = q.trim().toLowerCase();
  const rows = _odcItems.filter(r => !cari
    || (r.nama || '').toLowerCase().indexOf(cari) >= 0
    || (r.olt_nama || '').toLowerCase().indexOf(cari) >= 0
    || (r.pon_nama || '').toLowerCase().indexOf(cari) >= 0);

  if (!rows.length) {
    body.innerHTML = '<tr><td class="msd-empty" colspan="6"><i class="fas fa-diagram-project"></i> '
      + (cari ? 'Tidak ada ODC yang cocok dengan pencarian.'
              : 'Belum ada ODC. Tambahkan satu untuk mulai memetakan jalur kabel.')
      + '</td></tr>';
    return;
  }

  body.innerHTML = rows.map(r => {
    const g = r.ringkasan || {};
    const tot = (g.kuat || 0) + (g.ideal || 0) + (g.cukup || 0) + (g.buruk || 0);
    const seg = (n, k) => n ? '<i style="width:' + (n / tot * 100) + '%;background:var(--' + k + ')"></i>' : '';
    const sehat = tot
      ? '<div class="odl-health">' + seg(g.ideal, 'ideal') + seg(g.cukup, 'cukup')
        + seg(g.buruk, 'buruk') + seg(g.kuat, 'kuat') + '</div>'
        + '<span class="odl-hl">' + (g.ideal || 0) + ' ideal · ' + tot + ' port</span>'
      : '<span class="msd-muted">belum ada port pelanggan</span>';

    return '<tr>'
      + '<td class="fw6">' + escHtml(r.nama) + (r.keterangan
          ? '<small class="odc-ket">' + escHtml(r.keterangan) + '</small>' : '') + '</td>'
      + '<td class="msd-muted">' + (escHtml(r.olt_nama) || '—') + '</td>'
      + '<td class="msd-mono msd-muted">' + (escHtml(r.pon_nama) || '—') + '</td>'
      + '<td class="msd-mono fw6">' + _odcFmt(r.input_dbm) + '<em class="odc-u">dBm</em></td>'
      + '<td>' + sehat + '</td>'
      + '<td><div class="odc-act">'
      +   '<button class="btn btn-primary btn-sm" data-odc-view="' + r.id + '">'
      +     '<i class="fas fa-diagram-project"></i> View</button>'
      +   (_odcAdmin()
          ? '<button class="rowbtn" title="Edit" data-odc-edit="' + r.id + '"><i class="fas fa-pen"></i></button>'
            + '<button class="rowbtn dgr" title="Hapus" data-odc-del="' + r.id + '"><i class="fas fa-trash"></i></button>'
          : '')
      + '</div></td></tr>';
  }).join('');
}

// ── Form tambah / ubah ODC ──
function openOdcEditor(row) {
  const edit = !!row;
  row = row || {};
  const olt = (_odcMaster && _odcMaster.olt) || [];
  const pon = (_odcMaster && _odcMaster.pon) || [];

  if (!olt.length) {
    showToast('Tambahkan OLT di Master Data lebih dulu', 'error');
    return;
  }

  const opsiOlt = '<option value="">— pilih OLT —</option>' + olt.map(o =>
    '<option value="' + o.id + '"' + (o.id === row.olt_id ? ' selected' : '') + '>'
    + escHtml(o.nama) + '</option>').join('');

  const prev = document.getElementById('odcEd');
  if (prev) prev.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'odcEd';
  ov.innerHTML =
    '<div class="modal" style="max-width:540px">'
    + '<div class="modal-header"><h3><i class="fas ' + (edit ? 'fa-pen' : 'fa-plus') + '"></i> '
    +   (edit ? 'Edit ODC' : 'Tambah ODC') + '</h3>'
    + '<button class="modal-close" data-act="no"><i class="fas fa-xmark"></i></button></div>'
    + '<div class="modal-body">'
    +   '<div class="login-error" id="odcErr" hidden></div>'
    +   '<div class="form-group"><label>Nama ODC</label>'
    +     '<input class="form-input" id="odcFNama" spellcheck="false" placeholder="ODC-JIMBARAN-CORE" value="'
    +     escHtml(row.nama || '') + '"></div>'
    +   '<div class="form-row">'
    +     '<div class="form-group"><label>OLT</label>'
    +       '<select class="form-input" id="odcFOlt">' + opsiOlt + '</select></div>'
    +     '<div class="form-group"><label>Port PON</label>'
    +       '<select class="form-input" id="odcFPon"></select>'
    +       '<small class="msd-hint">Hanya PON milik OLT terpilih.</small></div>'
    +   '</div>'
    +   '<div class="form-group"><label>Simulasi Input Power <small>(dBm)</small></label>'
    +     '<input class="form-input" type="number" step="0.01" id="odcFInp" placeholder="7.35" value="'
    +     (row.input_dbm !== undefined && row.input_dbm !== null ? row.input_dbm : '') + '">'
    +     '<small class="msd-hint">Daya kirim PON hasil ukur di OLT.</small></div>'
    +   '<div class="form-group"><label>Keterangan</label>'
    +     '<input class="form-input" id="odcFKet" placeholder="Lokasi / catatan" value="'
    +     escHtml(row.keterangan || '') + '"></div>'
    +   '<div class="btn-row" style="justify-content:flex-end;gap:8px">'
    +     '<button class="btn btn-ghost" data-act="no">Batal</button>'
    +     '<button class="btn btn-primary" data-act="yes"><i class="fas fa-save"></i> Simpan</button>'
    +   '</div>'
    + '</div></div>';
  document.body.appendChild(ov);

  // PON selalu mengikuti OLT terpilih. Kalau daftarnya tidak disaring, orang
  // bisa memilih PON milik OLT lain — dan di layar tetap terbaca wajar.
  const selOlt = document.getElementById('odcFOlt');
  const selPon = document.getElementById('odcFPon');
  const isiPon = () => {
    const id = parseInt(selOlt.value, 10);
    const daftar = pon.filter(p => p.olt_id === id);
    selPon.innerHTML = '<option value="">— pilih PON —</option>' + daftar.map(p =>
      '<option value="' + p.id + '"' + (p.id === row.pon_id ? ' selected' : '') + '>'
      + escHtml(p.nama) + '</option>').join('');
    selPon.disabled = !daftar.length;
    if (!daftar.length && id) {
      selPon.innerHTML = '<option value="">(OLT ini belum punya PON)</option>';
    }
  };
  selOlt.onchange = isiPon;
  isiPon();

  const close = () => ov.remove();
  ov.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]');
    if (!act) { if (e.target === ov) close(); return; }
    if (act.dataset.act === 'no') { close(); return; }
    act.disabled = true;
    try {
      await authFetch('/config/odc' + (edit ? '/' + row.id : ''), {
        method: 'POST',
        body: {
          nama: document.getElementById('odcFNama').value,
          olt_id: selOlt.value || null,
          pon_id: selPon.value || null,
          input_dbm: document.getElementById('odcFInp').value || 0,
          keterangan: document.getElementById('odcFKet').value,
        },
      });
      close();
      showToast(edit ? 'ODC diperbarui' : 'ODC ditambahkan', 'success');
      if (_odcData && edit && _odcData.odc.id === row.id) await bukaOdc(row.id);
      else await muatOdcList();
    } catch (ex) {
      act.disabled = false;
      const el = document.getElementById('odcErr');
      el.textContent = ex.message; el.hidden = false;
    }
  });
  setTimeout(() => { const f = ov.querySelector('input'); if (f) f.focus(); }, 60);
}

/* Hapus apa pun (ODC atau node) dengan pola yang sama: coba tanpa force,
   kalau server menjawab 409 tampilkan rincian terdampak lalu ulangi. */
async function _odcHapus(url, judul, satuan, sesudah) {
  try {
    await authFetch(url, { method: 'DELETE' });
    showToast(judul + ' dihapus', 'success');
    await sesudah();
    return;
  } catch (ex) {
    const imp = ex.data && ex.data.impact;
    if (ex.status !== 409 || !imp) { showToast(ex.message, 'error'); return; }

    const daftar = (imp.daftar || []).map(d =>
      '<div class="imp-row"><i class="fas fa-diagram-project"></i> <b>' + escHtml(d) + '</b></div>').join('');
    const sisa = imp.jumlah - (imp.daftar || []).length;
    showConfirm({
      title: 'Hapus ' + judul + '?',
      icon: 'fa-triangle-exclamation',
      danger: true,
      requireText: 'HAPUS',
      yesLabel: 'Hapus',
      message: '<div class="imp-head"><i class="fas fa-triangle-exclamation"></i><div>'
        + '<b>' + escHtml(judul) + ' membawahi ' + imp.jumlah + ' ' + satuan + '</b>'
        + '<p>Seluruhnya ikut terhapus. Cabang tanpa induk tidak punya arti — '
        + 'dayanya tidak bisa dihitung dari mana pun.</p></div></div>'
        + '<div class="imp-cap">Ikut terhapus</div><div class="imp-list">' + daftar
        + (sisa > 0 ? '<div class="imp-row msd-muted">… dan ' + sisa + ' lainnya</div>' : '')
        + '</div>',
    }, async () => {
      try {
        await authFetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'force=1', { method: 'DELETE' });
        showToast(judul + ' dihapus', 'success');
        await sesudah();
      } catch (e2) { showToast(e2.message, 'error'); }
    });
  }
}

// ═══════════════════════════════════════════════════════════════
//  2 · TOPOLOGI — tata letak
// ═══════════════════════════════════════════════════════════════
/* Hanya ODP yang punya kartu sendiri. Splitter menempel DI DALAM kartu
   induknya — di lapangan pun keduanya memang satu kotak fisik, dan menggambar
   splitter sebagai kartu terpisah membuat orang mengira ia perangkat lain di
   tiang berbeda. */
function _odcTinggiKartu(n) {
  let h = 26 + 16;                       // kepala + padding badan
  if (n.mode === 'plc') return h + 19 + 62;   // masuk + blok "langsung ke pelanggan"
  h += 11;                               // meter pembagi daya
  h += 3 * 19;                           // masuk + output 1 + output 2
  const sp = n._splitter;
  if (sp) {
    const port = (sp.ports || []).length;
    h += 34;                             // kepala blok + baris "tiap port"
    h += Math.ceil(port / 7) * 18 + 8;   // kisi port
  }
  if (n._slotBebas) h += 24;             // baris tombol tambah
  return h;
}

/* Susun ulang pohon menjadi daftar KARTU (ODP saja).
   Anak sebuah kartu = ODP di keluaran merahnya + ODP di port-port splitter
   ODC-nya. Splitter ujung tidak punya anak: portnya milik pelanggan. */
function _odcKartuAnak(n) {
  const out = [];
  const merah = n.anak && n.anak.merah;
  if (merah) out.push({ node: merah, port: 'merah' });
  const sp = n._splitter;
  if (sp && sp.tipe === 'splitter_odc') {
    Object.keys(sp.anak || {}).sort().forEach(k => out.push({ node: sp.anak[k], port: k, sp: sp }));
  }
  return out;
}

function _odcSiapkan(pohon) {
  const kartu = [];
  (function jalan(n, dalam) {
    // Splitter dipindahkan dari "anak" menjadi bagian dari kartunya.
    n._splitter = (n.anak && n.anak.biru) || null;
    n._depth = dalam;
    const anak = _odcKartuAnak(n);
    n._slotBebas = n.mode !== 'plc' && (!(n.anak && n.anak.merah) || !n._splitter);
    n._kids = anak.map(a => a.node);
    n._sambung = anak;
    kartu.push(n);
    anak.forEach(a => jalan(a.node, dalam + 1));
  })(pohon, 0);
  return kartu;
}

/* Posisi disimpulkan dari bentuk pohon:
     x = kedalaman kartu       (jalur mengalir ke kanan, seperti seratnya)
     y = titik tengah anaknya, lalu tabrakan dalam satu kolom didorong
   Dorongan itu perlu: menempatkan induk tepat di tengah anaknya bisa membuat
   dua induk di kolom yang sama saling menumpuk, dan kartu yang tertimbun
   mustahil diklik.

   Kartu yang PERNAH digeser (pos_x terisi) memakai posisinya sendiri dan tidak
   ikut dihitung ulang. */
function _odcLayout(pohon) {
  if (!pohon) return [];
  const kartu = _odcSiapkan(pohon);
  let cursor = 0;

  (function tempat(n) {
    n._x = n._depth * (ODC_CARD_W + ODC_COL_GAP);
    if (!n._kids.length) {
      n._y = cursor;
      cursor += _odcTinggiKartu(n) + ODC_ROW_GAP;
    } else {
      n._kids.forEach(tempat);
      const a = n._kids[0], z = n._kids[n._kids.length - 1];
      n._y = (a._y + z._y + _odcTinggiKartu(z) - _odcTinggiKartu(n)) / 2;
    }
  })(pohon);

  const bawah = {};
  kartu.slice().sort((x, y) => (x._depth - y._depth) || (x._y - y._y)).forEach(n => {
    const min = bawah[n._depth];
    if (min !== undefined && n._y < min) n._y = min;
    bawah[n._depth] = n._y + _odcTinggiKartu(n) + ODC_ROW_GAP;
  });

  const minY = Math.min.apply(null, kartu.map(n => n._y));
  kartu.forEach(n => {
    n._y -= minY;
    // != null menangkap null DAN undefined sekaligus. Perbandingan dengan 0
    // tidak bisa dipakai: 0 adalah koordinat yang sah.
    if (n.pos_x != null) n._x = n.pos_x;
    if (n.pos_y != null) n._y = n.pos_y;
  });
  return kartu;
}

// ═══════════════════════════════════════════════════════════════
//  3 · TOPOLOGI — gambar
// ═══════════════════════════════════════════════════════════════
function _odcAksi(id, judul) {
  if (!_odcAdmin()) return '';
  return '<span class="oc-act">'
    + '<button title="Ubah ' + judul + '" data-node-edit="' + id + '"><i class="fas fa-pen"></i></button>'
    + '<button class="dgr" title="Hapus ' + judul + '" data-node-del="' + id + '"><i class="fas fa-trash"></i></button>'
    + '</span>';
}

/* Blok splitter di dalam kartu ODP.

   Bedanya dua watak splitter dibuat terlihat, bukan sekadar tertulis:
     • ujung        → langsung menampilkan hasil tiap port + statusnya
     • distribusi   → port digambar sebagai bundaran di TEPI kartu, karena
                      hanya bundaran itu yang bisa ditarik ke ODP lain */
function _odcBlokSplitter(sp) {
  if (!sp) return '';
  const distribusi = sp.tipe === 'splitter_odc';
  const p = sp.plc;
  const jml = (sp.ports || []).length;

  let isi;
  if (distribusi) {
    isi = '<div class="oc-sp-port">'
      + (sp.ports || []).map(pt =>
          '<span class="oc-dot' + (pt.terpakai ? ' used' : '') + '" '
          + 'data-sp="' + sp.id + '" data-port="' + pt.port + '" '
          + 'title="Port ' + pt.nomor + ' · ' + _odcFmt(pt.dbm) + ' dBm'
          + (pt.terpakai ? ' (terpakai)' : ' — tarik ke ODP, atau klik untuk membuat baru') + '">'
          + '<b>' + pt.nomor + '</b></span>').join('')
      + '</div>'
      + '<div class="oc-sp-ket">' + jml + ' port keluaran · ' + _odcFmt(sp.out_dbm) + ' dBm</div>';
  } else {
    isi = '<div class="oc-sp-out">' + _odcFmt(sp.out_dbm) + '<em>dBm</em>'
        + _odcPill(_odcStatusSplitter(sp)) + '</div>'
        + '<div class="oc-sp-ket">' + jml + ' port pelanggan</div>';
  }

  return '<div class="oc-sp' + (distribusi ? ' odc' : '') + '">'
    + '<div class="oc-sp-hd"><i class="fas fa-code-branch"></i>'
    +   '<span>' + escHtml(sp.nama) + '</span>'
    +   '<b>' + (p ? escHtml(p.rasio) : 'PLC?') + '</b>'
    +   _odcAksi(sp.id, 'splitter')
    + '</div>' + isi + '</div>';
}

function _odcStatusSplitter(sp) {
  const p = (sp.ports || [])[0];
  return p ? p.status : '';
}

function _odcKartu(n) {
  // ODP yang langsung memakai PLC adalah titik akhir: tak ada keluaran
  // merah/biru, jadi meter pembagi & dua baris output tidak punya arti.
  if (n.mode === 'plc') return _odcKartuLangsung(n);
  const t = n.tap;
  const kecil = t ? parseInt(String(t.rasio).split('/')[0], 10) : 50;
  const besar = 100 - kecil;
  const sp = n._splitter;
  const adaMerah = !!(n.anak && n.anak.merah);

  const slot = [];
  if (!adaMerah) slot.push(_odcTombolTambah(n.id, 'merah', 'ODP', 'odp'));
  if (!sp)       slot.push(_odcTombolTambah(n.id, 'biru', 'Splitter', 'splitter'));

  return '<div class="oc-node" data-id="' + n.id + '" '
    + 'style="left:' + n._x + 'px;top:' + n._y + 'px">'
    + '<div class="oc-hd"><i class="fas fa-box"></i>'
    +   '<span class="oc-nm">' + escHtml(n.nama) + '</span>'
    +   '<b class="oc-tag">' + (t ? escHtml(t.rasio) : 'rasio?') + '</b>'
    +   _odcAksi(n.id, 'ODP')
    + '</div>'
    + '<div class="oc-bd">'
    +   '<div class="oc-split"><i class="sp-red" style="width:' + besar + '%"></i>'
    +     '<i class="sp-blue" style="width:' + kecil + '%"></i></div>'
    +   '<div class="oc-r"><span>Masuk</span><b>' + _odcFmt(n.in_dbm) + '</b></div>'
    +   '<div class="oc-r"><span><i class="oc-f" style="background:#E4322B"></i>Out 1 · '
    +     besar + '%</span><b>' + _odcFmt(n.out_merah) + '</b>'
    +     '<span class="oc-port oc-p-red" data-node="' + n.id + '" data-port="merah"></span></div>'
    +   '<div class="oc-r"><span><i class="oc-f" style="background:#0072CE"></i>Out 2 · '
    +     kecil + '%</span><b>' + _odcFmt(n.out_biru) + '</b></div>'
    +   _odcBlokSplitter(sp)
    +   (slot.length ? '<div class="oc-slots">' + slot.join('') + '</div>' : '')
    + '</div>'
    + '<span class="oc-port oc-p-in" data-node="' + n.id + '" data-port="in"></span>'
    + '</div>';
}

/* ODP mode "langsung PLC" — bentuknya sengaja MIRIP blok splitter ujung,
   karena memang itu yang terjadi di lapangan: seratnya masuk dan langsung
   dibagi ke pelanggan tanpa tap coupler. */
function _odcKartuLangsung(n) {
  const p = n.plc;
  const jml = (n.ports || []).length;
  const st = (n.ports || [])[0] ? n.ports[0].status : '';
  return '<div class="oc-node oc-langsung" data-id="' + n.id + '" '
    + 'style="left:' + n._x + 'px;top:' + n._y + 'px">'
    + '<div class="oc-hd"><i class="fas fa-box"></i>'
    +   '<span class="oc-nm">' + escHtml(n.nama) + '</span>'
    +   '<b class="oc-tag">' + (p ? escHtml(p.rasio) : 'PLC?') + '</b>'
    +   _odcAksi(n.id, 'ODP')
    + '</div>'
    + '<div class="oc-bd">'
    +   '<div class="oc-r"><span>Masuk</span><b>' + _odcFmt(n.in_dbm) + '</b></div>'
    +   '<div class="oc-sp">'
    +     '<div class="oc-sp-hd"><i class="fas fa-code-branch"></i>'
    +       '<span>Langsung ke pelanggan</span></div>'
    +     '<div class="oc-sp-out">' + _odcFmt(n.out_dbm) + '<em>dBm</em>' + _odcPill(st) + '</div>'
    +     '<div class="oc-sp-ket">' + jml + ' port pelanggan</div>'
    +   '</div>'
    + '</div>'
    + '<span class="oc-port oc-p-in" data-node="' + n.id + '" data-port="in"></span>'
    + '</div>';
}

function _odcTombolTambah(nodeId, port, label, jenis) {
  if (!_odcAdmin()) return '';
  return '<button class="oc-add" data-add-parent="' + (nodeId === null ? '' : nodeId) + '" '
    + 'data-add-port="' + port + '" data-add-jenis="' + jenis + '">'
    + '<i class="fas fa-plus"></i>' + label + '</button>';
}

/* Kabel sementara saat bundaran port ditarik. Digambar di lapisan SVG
   terpisah supaya tidak ikut terhapus setiap kali garis tetap digambar
   ulang, dan tidak pernah tertinggal di layar saat drag dibatalkan. */
function _odcGambarTarik(t, ev) {
  const cv = document.getElementById('odcCanvas');
  let svg = document.getElementById('odcTarik');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'odcTarik';
    svg.setAttribute('class', 'oc-tarik');
    cv.appendChild(svg);
  }
  const r = cv.getBoundingClientRect();
  const a = t.el.getBoundingClientRect();
  const x1 = a.left - r.left + a.width / 2, y1 = a.top - r.top + a.height / 2;
  const x2 = ev.clientX - r.left, y2 = ev.clientY - r.top;
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.45);
  svg.setAttribute('width', r.width);
  svg.setAttribute('height', r.height);
  svg.innerHTML = '<path d="M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1
    + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2 + '" fill="none" '
    + 'stroke="var(--primary)" stroke-width="2.5" stroke-dasharray="5 4" stroke-linecap="round"/>';
}

function _odcHapusTarik() {
  const svg = document.getElementById('odcTarik');
  if (svg) svg.remove();
}

function renderOdcTopo() {
  const wrapNodes  = document.getElementById('odcNodes');
  const wrapEdges  = document.getElementById('odcEdges');
  const wrapLabels = document.getElementById('odcLabels');
  if (!wrapNodes || !_odcData) return;

  const d = _odcData;
  document.getElementById('odcNama').textContent = d.odc.nama;
  document.getElementById('odcSumber').textContent =
    (d.odc.olt_nama || 'OLT belum dipilih') + ' · ' + (d.odc.pon_nama || 'PON belum dipilih')
    + ' · input ' + _odcFmt(d.odc.input_dbm) + ' dBm';

  if (!d.pohon) {
    wrapNodes.innerHTML =
      '<div class="oc-kosong">'
      + '<i class="fas fa-diagram-project"></i>'
      + '<b>Belum ada jalur</b>'
      + '<p>Mulai dari keluaran PON — tambahkan ODP pertama, lalu sambungkan '
      + 'keluaran merahnya ke ODP berikutnya dan biru ke splitter.</p>'
      + (_odcAdmin()
          ? '<button class="btn btn-primary" data-add-parent="" data-add-port="" data-add-jenis="odp">'
            + '<i class="fas fa-plus"></i> Tambah ODP pertama</button>'
          : '<span class="msd-muted">Hanya administrator yang bisa mengubah topologi.</span>')
      + '</div>';
    wrapEdges.innerHTML = '';
    wrapLabels.innerHTML = '';
    _odcRingkasan();
    return;
  }

  _odcLaid = _odcLayout(d.pohon);
  wrapNodes.innerHTML = _odcLaid.map(_odcKartu).join('');
  wrapNodes.classList.toggle('oc-can-drag', _odcAdmin());
  _odcGaris(_odcLaid);
  _odcRingkasan();
}

/* Garis digambar dua lapis: selubung gelap lalu warna core di atasnya.
   Bukan hiasan — core "Putih" mustahil terlihat di latar terang tanpa
   selubung, persis seperti jaket kabel aslinya. */
function _odcGaris(kartu) {
  const world = document.getElementById('odcWorld');
  const wrapEdges  = document.getElementById('odcEdges');
  const wrapLabels = document.getElementById('odcLabels');
  if (!world || !wrapEdges) return;
  const wRect = world.getBoundingClientRect();
  const k = _odcView.k || 1;

  const ukur = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: (r.left - wRect.left + r.width / 2) / k, y: (r.top - wRect.top + r.height / 2) / k };
  };
  const dariMerah = id => ukur(document.querySelector(
    '#odcNodes .oc-port[data-node="' + id + '"][data-port="merah"]'));
  const dariPort = (spId, port) => ukur(document.querySelector(
    '#odcNodes .oc-dot[data-sp="' + spId + '"][data-port="' + port + '"]'));
  const keMasuk = id => ukur(document.querySelector(
    '#odcNodes .oc-port[data-node="' + id + '"][data-port="in"]'));

  let path = '', lbl = '';
  kartu.forEach(n => {
    (n._sambung || []).forEach(s => {
      const A = s.port === 'merah' ? dariMerah(n.id) : dariPort(s.sp.id, s.port);
      const B = keMasuk(s.node.id);
      if (!A || !B) return;
      const dx = Math.max(40, Math.abs(B.x - A.x) * 0.45);
      const dd = 'M' + A.x + ',' + A.y + ' C' + (A.x + dx) + ',' + A.y
               + ' ' + (B.x - dx) + ',' + B.y + ' ' + B.x + ',' + B.y;
      const c = odcCore(s.node.core);
      path += '<path d="' + dd + '" fill="none" stroke="rgba(15,23,42,.55)" stroke-width="5" stroke-linecap="round"/>'
           +  '<path d="' + dd + '" fill="none" stroke="' + c.hex + '" stroke-width="2.6" stroke-linecap="round"/>';
      const nilai = s.port === 'merah' ? n.out_merah : s.sp.out_dbm;
      lbl += '<div class="oc-elbl" style="left:' + ((A.x + B.x) / 2) + 'px;top:' + ((A.y + B.y) / 2) + 'px">'
          +  'C' + c.n + ' · ' + _odcFmt(nilai) + '</div>';
    });
  });
  wrapEdges.innerHTML = path;
  wrapLabels.innerHTML = lbl;
  const maxX = Math.max.apply(null, kartu.map(n => n._x + ODC_CARD_W).concat([600]));
  const maxY = Math.max.apply(null, kartu.map(n => n._y + _odcTinggiKartu(n)).concat([400]));
  wrapEdges.setAttribute('width', maxX + 80);
  wrapEdges.setAttribute('height', maxY + 80);
}

function _odcRingkasan() {
  const g = (_odcData && _odcData.ringkasan) || {};
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v || 0; };
  set('odcSOdp', g.odp); set('odcSSpl', g.splitter); set('odcSPort', g.port);
  const L = document.getElementById('odcLegend');
  if (L) L.innerHTML = ['ideal', 'cukup', 'buruk', 'kuat'].map(x =>
    '<span><i class="dot" style="background:var(--' + x + ')"></i>'
    + ODC_ST[x].l.toLowerCase() + ' <b>' + (g[x] || 0) + '</b></span>').join('');
}

// ═══════════════════════════════════════════════════════════════
//  4 · Tambah / ubah node
// ═══════════════════════════════════════════════════════════════
function openNodeEditor(opts) {
  const M = _odcMaster || { tap: [], plc: [] };
  const edit = !!opts.node;
  const n = opts.node || {};
  const jenis = edit ? n.tipe : opts.jenis;
  const isOdp = jenis === 'odp';

  // Di keluaran biru pengguna memilih SATU dari dua watak splitter. Bedanya
  // bukan kosmetik: yang satu berakhir di pelanggan, yang lain meneruskan
  // ke ODP lain — dan pilihan itu menentukan apa yang boleh disambung nanti.
  // Dipakai tombol "Add ODP" di pojok kanan — lihat tambahOdpDariAtas().
  const pilihSlot = (!edit && opts.slots && opts.slots.length)
    ? '<div class="form-group"><label>Sambungkan ke</label>'
      + '<select class="form-input" id="odcNSlot">'
      + opts.slots.map((s, i) => '<option value="' + i + '">' + escHtml(s.label) + '</option>').join('')
      + '</select><small class="msd-hint">Hanya keluaran yang masih kosong.</small></div>' : '';

  /* Nama HANYA untuk ODP.

     Nama ODP dipakai tim lapangan untuk mencari kotaknya di tiang, jadi harus
     bebas. Splitter tidak pernah dicari sendiri — ia selalu disebut lewat ODP
     yang menaunginya ("splitter di ODP-JIMBARAN-01"), dan namanya sudah
     ditentukan oleh rasionya. Kolom yang isinya selalu sama hanya menambah
     satu langkah tanpa memberi apa pun. */
  const pilihNama = isOdp
    ? '<div class="form-group"><label>Nama ODP</label>'
      + '<input class="form-input" id="odcNNama" spellcheck="false" '
      + 'placeholder="ODP-JIMBARAN-01" value="' + escHtml(n.nama || '') + '"></div>'
    : '';

  /* PRD §4.4 mode A/B — ditanyakan untuk SETIAP ODP, baru maupun lama.

     Rasio  : lewat tap coupler, menyisakan porsi besar untuk diteruskan.
     Splitter: serat masuk langsung dibagi ke pelanggan. Itu titik akhir —
               tidak ada porsi besar yang tersisa. */
  const modeAwal = (edit ? (n.mode || 'tap') : 'tap');
  const pilihMode = isOdp
    ? '<div class="form-group"><label>Cara membagi</label>'
      + '<div class="mode2" id="odcNMode">'
      +   '<button type="button" data-m="tap"' + (modeAwal === 'tap' ? ' class="on"' : '') + '>'
      +     'Rasio<small>tap coupler · jalur lanjut</small></button>'
      +   '<button type="button" data-m="plc"' + (modeAwal === 'plc' ? ' class="on"' : '') + '>'
      +     'Splitter<small>langsung ke pelanggan</small></button>'
      + '</div></div>'
    : '';

  const opsiPlcOdp = '<option value="">— pilih splitter —</option>' + (M.plc || []).map(p =>
    '<option value="' + p.id + '"' + (p.id === n.plc_id ? ' selected' : '') + '>'
    + escHtml(p.rasio) + ' — ' + p.jumlah_port + ' port, ' + p.loss_db.toFixed(2) + ' dB'
    + '</option>').join('');

  const pilihJenis = (!edit && opts.port === 'biru')
    ? '<div class="form-group"><label>Jenis splitter</label>'
      + '<div class="mode2" id="odcJenis">'
      +   '<button type="button" data-j="splitter" class="on">Splitter'
      +     '<small>port → pelanggan</small></button>'
      +   '<button type="button" data-j="splitter_odc">Splitter ODC'
      +     '<small>port → ODP lain</small></button>'
      + '</div></div>' : '';

  const opsiTap = '<option value="">— pilih rasio —</option>' + (M.tap || []).map(t =>
    '<option value="' + t.id + '"' + (t.id === n.tap_id ? ' selected' : '') + '>'
    + escHtml(t.rasio) + ' — biru ' + t.loss_biru.toFixed(2) + ' dB / merah ' + t.loss_merah.toFixed(2) + ' dB'
    + '</option>').join('');
  const opsiPlc = '<option value="">— pilih splitter —</option>' + (M.plc || []).map(p =>
    '<option value="' + p.id + '"' + (p.id === n.plc_id ? ' selected' : '') + '>'
    + escHtml(p.rasio) + ' — ' + p.jumlah_port + ' port, ' + p.loss_db.toFixed(2) + ' dB'
    + '</option>').join('');

  /* Warna core HANYA untuk ODP.

     Splitter — baik yang ujung maupun distribusi — duduk di dalam kotak ODP
     yang sama; tidak ada serat antar-kotak yang perlu diberi warna, jadi
     menanyakannya hanya membuat orang mengarang jawaban. Warna dipilih di
     ODP yang menerima serat itu. */
  const pilihCore = isOdp
    ? '<div class="form-group"><label>Warna core kabel masuk</label>'
      + '<div class="cores" id="odcNCore">'
      + ODC_CORES.map(c =>
          '<div class="core' + ((n.core || 1) === c.n ? ' on' : '') + '" data-c="' + c.n + '" '
          + 'title="Core ' + c.n + ' — ' + c.nama + '" style="background:' + c.hex + '"></div>').join('')
      + '</div><small class="msd-hint">Urutan TIA/EIA-598 — sama dengan urutan core di kabel asli.</small></div>'
    : '';

  const prev = document.getElementById('odcNodeEd');
  if (prev) prev.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'odcNodeEd';
  ov.innerHTML =
    '<div class="modal modal-slim">'
    + '<div class="modal-header"><h3><i class="fas ' + (edit ? 'fa-pen' : 'fa-plus') + '"></i> '
    +   (edit ? 'Ubah ' + escHtml(n.nama) : 'Tambah ' + (isOdp ? 'ODP' : 'Splitter')) + '</h3>'
    + '<button class="modal-close" data-act="no"><i class="fas fa-xmark"></i></button></div>'
    + '<div class="modal-body">'
    +   '<div class="login-error" id="odcNErr" hidden></div>'
    +   pilihSlot
    +   pilihJenis
    +   pilihNama
    +   pilihMode
    +   '<div class="form-group" id="odcWrapTap"'
    +     ((isOdp && modeAwal === 'tap') ? '' : ' hidden') + '>'
    +     '<label>Rasio splitter (tap coupler)</label>'
    +     '<select class="form-input" id="odcNTap">' + opsiTap + '</select>'
    +     '<small class="msd-hint">Output 1 (merah) porsi besar, Output 2 (biru) porsi kecil.</small></div>'
    +   '<div class="form-group" id="odcWrapPlcOdp"'
    +     ((isOdp && modeAwal === 'plc') ? '' : ' hidden') + '>'
    +     '<label>PLC splitter</label>'
    +     '<select class="form-input" id="odcNPlcOdp">' + opsiPlcOdp + '</select>'
    +     '<small class="msd-hint">Serat masuk langsung dibagi ke pelanggan — '
    +     'ODP ini menjadi titik akhir jalur.</small></div>'
    +   '<div class="form-group" id="odcWrapPlc"' + (isOdp ? ' hidden' : '') + '>'
    +     '<label>PLC splitter</label>'
    +     '<select class="form-input" id="odcNPlc">' + opsiPlc + '</select></div>'
    +   pilihCore
    +   '<div class="btn-row" style="justify-content:flex-end;gap:8px">'
    +     '<button class="btn btn-ghost" data-act="no">Batal</button>'
    +     '<button class="btn btn-primary" data-act="yes"><i class="fas fa-save"></i> Simpan</button>'
    +   '</div>'
    + '</div></div>';
  document.body.appendChild(ov);

  let jenisPilih = jenis;
  let modePilih = modeAwal;
  let core = n.core || 1;

  const mw = document.getElementById('odcNMode');
  if (mw) mw.onclick = e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    mw.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    modePilih = b.dataset.m;
    // Hanya satu yang relevan pada satu saat; menampilkan keduanya membuat
    // orang mengisi kolom yang tidak akan pernah dipakai.
    document.getElementById('odcWrapTap').hidden    = modePilih !== 'tap';
    document.getElementById('odcWrapPlcOdp').hidden = modePilih !== 'plc';
  };
  const jw = document.getElementById('odcJenis');
  if (jw) jw.onclick = e => {
    const b = e.target.closest('[data-j]');
    if (!b) return;
    jw.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    jenisPilih = b.dataset.j;
  };
  // Hanya ada saat menyunting ODP — splitter tidak punya pilihan core.
  const cw = document.getElementById('odcNCore');
  if (cw) cw.onclick = e => {
    const c = e.target.closest('.core');
    if (!c) return;
    cw.querySelectorAll('.core').forEach(x => x.classList.remove('on'));
    c.classList.add('on');
    core = parseInt(c.dataset.c, 10);
  };

  const close = () => ov.remove();
  ov.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]');
    if (!act) { if (e.target === ov) close(); return; }
    if (act.dataset.act === 'no') { close(); return; }
    act.disabled = true;
    const nw = document.getElementById('odcNNama');
    const body = { tipe: jenisPilih, core: core };
    // Splitter tidak punya kolom nama; server memberinya nama bawaan sesuai
    // jenisnya. Mengirim string kosong pun sama hasilnya, tapi tidak
    // mengirimnya sama sekali lebih jujur soal apa yang sebenarnya diatur.
    if (nw) body.nama = nw.value;
    if (jenisPilih === 'odp') {
      body.mode = modePilih;
      if (modePilih === 'tap') body.tap_id = document.getElementById('odcNTap').value || null;
      else                     body.plc_id = document.getElementById('odcNPlcOdp').value || null;
    } else {
      body.plc_id = document.getElementById('odcNPlc').value || null;
    }
    if (!edit) {
      const sw = document.getElementById('odcNSlot');
      const s  = sw ? opts.slots[parseInt(sw.value, 10)] : null;
      body.parent_id   = s ? s.parent_id : (opts.parentId || null);
      body.parent_port = s ? s.port : (opts.port || '');
    }
    try {
      await authFetch('/config/odc/' + _odcData.odc.id + '/node' + (edit ? '/' + n.id : ''),
                      { method: 'POST', body: body });
      close();
      await bukaOdc(_odcData.odc.id);
    } catch (ex) {
      act.disabled = false;
      const el = document.getElementById('odcNErr');
      el.textContent = ex.message; el.hidden = false;
    }
  });
  setTimeout(() => { const f = ov.querySelector('input'); if (f) f.focus(); }, 60);
}

/* Tombol "Add ODP" di pojok kanan.

   Tombol yang letaknya jauh dari kartu mana pun tidak punya cara tahu ke mana
   ODP-nya harus disambung — jadi server yang menyebutkan keluaran mana saja
   yang masih kosong, lalu pengguna memilih. Klien sengaja tidak menyimpulkan
   sendiri: ia tak pernah memegang gambaran utuh isi database. */
async function tambahOdpDariAtas() {
  if (!_odcData) return;
  let slot;
  try {
    slot = (await authFetch('/config/odc/' + _odcData.odc.id + '/slot')).slot || [];
  } catch (e) { showToast(e.message, 'error'); return; }

  if (!slot.length) {
    showToast('Tidak ada keluaran yang masih kosong. Tambahkan Splitter ODC '
            + 'untuk membuka port baru.', 'error');
    return;
  }
  openNodeEditor({ jenis: 'odp', slots: slot });
}

// ═══════════════════════════════════════════════════════════════
//  5 · Layar, muat, pasang
// ═══════════════════════════════════════════════════════════════
function _odcLayar(topo) {
  const l = document.getElementById('odcList');
  const t = document.getElementById('odcTopo');
  const c = document.getElementById('contentArea');
  if (!l || !t) return;
  l.hidden = topo;
  t.hidden = !topo;
  // Kanvas mengisi seluruh area dan menggulir sendiri; padding & gulir
  // .content-area harus dilepas atau akan muncul dua scrollbar bersarang.
  if (c) {
    c.style.padding  = topo ? '0' : '';
    c.style.overflow = topo ? 'hidden' : '';
  }
  // Rantai tinggi harus utuh sampai ke kanvas, kalau tidak .oc-wrap yang
  // absolute akan berpatokan ke viewport dan menyelinap ke balik header.
  const pg = document.getElementById('page-odc');
  if (pg) pg.classList.toggle('odc-full', topo);
  applyPageMeta(topo ? 'odc-topologi' : 'odc');
}

function _odcApplyView() {
  const w = document.getElementById('odcWorld');
  if (w) w.style.transform = 'translate(' + _odcView.x + 'px,' + _odcView.y + 'px) scale(' + _odcView.k + ')';
  const v = document.getElementById('odcZVal');
  if (v) v.textContent = Math.round(_odcView.k * 100) + '%';
}

function _odcFitView() {
  const cv = document.getElementById('odcCanvas');
  const nodes = document.querySelectorAll('#odcNodes .oc-node');
  if (!cv || !nodes.length) { _odcView = { x: 30, y: 20, k: 0.9 }; _odcApplyView(); return; }
  let mx = 0, my = 0;
  nodes.forEach(el => {
    mx = Math.max(mx, parseFloat(el.style.left) + ODC_CARD_W);
    my = Math.max(my, parseFloat(el.style.top) + el.offsetHeight);
  });
  const r = cv.getBoundingClientRect();
  _odcView.k = Math.max(0.35, Math.min(1.1, Math.min((r.width - 60) / mx, (r.height - 60) / my)));
  _odcView.x = 30; _odcView.y = 20;
  _odcApplyView();
}

async function muatOdcList() {
  try {
    const d = await authFetch('/config/odc');
    _odcItems = d.items || [];
  } catch (e) {
    _odcItems = [];
    showToast('Gagal memuat Data ODC: ' + e.message, 'error');
  }
  renderOdcList();
}

async function bukaOdc(id) {
  try {
    _odcData = await authFetch('/config/odc/' + id);
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }
  App.currentOdc = { id: _odcData.odc.id, nama: _odcData.odc.nama };
  try { sessionStorage.setItem('currentOdc', JSON.stringify(App.currentOdc)); } catch (_) {}
  _odcLayar(true);
  renderOdcTopo();
  // Garis diukur dari DOM sungguhan, jadi harus digambar SETELAH kartunya
  // benar-benar tampil — selagi section-nya hidden, ukurannya nol semua.
  setTimeout(() => {
    _odcFitView();
    const daftar = _odcData.pohon ? _odcLayout(_odcData.pohon) : [];
    if (daftar.length) _odcGaris(daftar);
  }, 30);
}

function initOdc() {
  const m = window.location.pathname.match(/^\/maps\/odc\/(\d+)/);

  const cari = document.getElementById('odcCari');
  if (cari) cari.oninput = renderOdcList;

  const add = document.getElementById('odcAdd');
  if (add) add.onclick = () => openOdcEditor(null);

  const back = document.getElementById('odcBack');
  if (back) back.onclick = () => {
    App.currentOdc = null;
    history.pushState({ page: 'odc' }, '', '/maps/odc');
    _odcLayar(false);
    muatOdcList();
  };

  const edh = document.getElementById('odcEditHdr');
  if (edh) edh.onclick = () => { if (_odcData) openOdcEditor(_odcData.odc); };

  const addOdp = document.getElementById('odcAddOdp');
  if (addOdp) addOdp.onclick = tambahOdpDariAtas;

  const rapi = document.getElementById('odcRapikan');
  if (rapi) rapi.onclick = async () => {
    if (!_odcData) return;
    try {
      const r = await authFetch('/config/odc/' + _odcData.odc.id + '/rapikan', { method: 'POST' });
      showToast(r.direset
        ? r.direset + ' node dikembalikan ke tata letak otomatis'
        : 'Tata letak sudah otomatis seluruhnya', 'success');
      await bukaOdc(_odcData.odc.id);
    } catch (e) { showToast(e.message, 'error'); }
  };

  const fit = document.getElementById('odcFit');
  if (fit) fit.onclick = _odcFitView;
  const zi = document.getElementById('odcZIn');
  if (zi) zi.onclick = () => { _odcView.k = Math.min(1.6, _odcView.k * 1.15); _odcApplyView(); };
  const zo = document.getElementById('odcZOut');
  if (zo) zo.onclick = () => { _odcView.k = Math.max(0.3, _odcView.k / 1.15); _odcApplyView(); };

  // Geser kartu ODP/splitter, atau geser latar kanvas
  const cv = document.getElementById('odcCanvas');
  if (cv) {
    let drag = null, tarik = null;
    cv.addEventListener('mousedown', e => {
      // Tombol & port punya tugasnya sendiri — menyeret dari atasnya akan
      // membuat klik biasa terasa "kadang tidak berfungsi".
      if (e.target.closest('button') || e.target.closest('.oc-port')) return;

      // Bundaran port splitter ODC: tarik ke sebuah ODP untuk menjadikan
      // port itu sumber inputnya. Ditangani SEBELUM geser kartu — kalau
      // tidak, menarik dari bundaran hanya akan menggeser kartunya.
      const dot = e.target.closest('.oc-dot');
      if (dot) {
        if (!_odcAdmin()) return;
        tarik = { sp: +dot.dataset.sp, port: dot.dataset.port, el: dot, moved: false };
        dot.classList.add('narik');
        e.preventDefault();
        return;
      }

      const kartu = e.target.closest('.oc-node');
      if (kartu) {
        if (!_odcAdmin()) return;      // bukan admin: kartunya diam, latar tak ikut tergeser
        const n = _odcLaid.filter(x => x.id === +kartu.dataset.id)[0];
        if (!n) return;
        drag = { node: n, el: kartu, sx: e.clientX, sy: e.clientY,
                 ox: n._x, oy: n._y, moved: false };
        kartu.classList.add('dragging');
        e.preventDefault();
        return;
      }
      drag = { pan: true, sx: e.clientX, sy: e.clientY, ox: _odcView.x, oy: _odcView.y };
      cv.classList.add('panning');
    });

    window.addEventListener('mousemove', e => {
      if (tarik) {
        tarik.moved = true;
        _odcGambarTarik(tarik, e);
        // Sasaran disorot supaya jelas ODP mana yang akan tersambung —
        // melepas kabel di tempat yang salah jauh lebih mudah diperbaiki
        // kalau terlihat sebelum dilepas.
        const atas = document.elementFromPoint(e.clientX, e.clientY);
        const kartu = atas && atas.closest && atas.closest('.oc-node');
        document.querySelectorAll('#odcNodes .oc-node.oc-target')
          .forEach(x => x.classList.remove('oc-target'));
        if (kartu) kartu.classList.add('oc-target');
        return;
      }
      if (!drag) return;
      if (drag.pan) {
        _odcView.x = drag.ox + (e.clientX - drag.sx);
        _odcView.y = drag.oy + (e.clientY - drag.sy);
        _odcApplyView();
        return;
      }
      // Dibagi skala zoom: tanpa itu, kartu bergerak lebih cepat daripada
      // kursor saat diperkecil dan lebih lambat saat diperbesar.
      drag.node._x = Math.round(drag.ox + (e.clientX - drag.sx) / _odcView.k);
      drag.node._y = Math.round(drag.oy + (e.clientY - drag.sy) / _odcView.k);
      drag.moved = true;
      drag.el.style.left = drag.node._x + 'px';
      drag.el.style.top  = drag.node._y + 'px';
      _odcGaris(_odcLaid);
    });

    window.addEventListener('mouseup', async e => {
      if (tarik) {
        const t = tarik;
        tarik = null;
        t.el.classList.remove('narik');
        _odcHapusTarik();
        document.querySelectorAll('#odcNodes .oc-node.oc-target')
          .forEach(x => x.classList.remove('oc-target'));

        const atas = document.elementFromPoint(e.clientX, e.clientY);
        const kartu = atas && atas.closest && atas.closest('.oc-node');
        if (!t.moved && !kartu) {
          // Klik biasa di bundaran kosong → buat ODP baru di port itu.
          openNodeEditor({ parentId: t.sp, port: t.port, jenis: 'odp' });
          return;
        }
        if (!kartu) return;
        try {
          await authFetch('/config/odc/' + _odcData.odc.id + '/node/' + kartu.dataset.id + '/pindah',
                          { method: 'POST', body: { parent_id: t.sp, parent_port: t.port } });
          await bukaOdc(_odcData.odc.id);
        } catch (err) { showToast(err.message, 'error'); }
        return;
      }
      const d = drag;
      drag = null;
      cv.classList.remove('panning');
      if (!d || d.pan) return;
      d.el.classList.remove('dragging');
      if (!d.moved || !_odcData) return;
      d.node.pos_x = d.node._x;
      d.node.pos_y = d.node._y;
      // Disimpan diam-diam. Menggeser kartu tidak mengubah satu pun angka
      // daya, jadi tidak perlu memuat ulang topologi maupun memberi notifikasi.
      authFetch('/config/odc/' + _odcData.odc.id + '/node/' + d.node.id + '/pos',
                { method: 'POST', body: { x: d.node._x, y: d.node._y } })
        .catch(err => showToast('Posisi gagal disimpan: ' + err.message, 'error'));
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const before = _odcView.k;
      _odcView.k = Math.max(0.3, Math.min(1.6, _odcView.k * (e.deltaY < 0 ? 1.1 : 0.9)));
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      _odcView.x = mx - (mx - _odcView.x) * (_odcView.k / before);
      _odcView.y = my - (my - _odcView.y) * (_odcView.k / before);
      _odcApplyView();
    }, { passive: false });
  }

  // Satu pendengar untuk seluruh aksi baris & node: isinya digambar ulang
  // tiap kali data berubah, jadi pendengar per tombol akan hilang-timbul.
  const page = document.getElementById('page-odc');
  if (page) page.onclick = e => {
    const t = el => e.target.closest('[' + el + ']');
    const view = t('data-odc-view'), ed = t('data-odc-edit'), dl = t('data-odc-del');
    if (view) { bukaOdc(parseInt(view.dataset.odcView, 10)); return; }
    if (ed)   { openOdcEditor(_odcItems.filter(r => r.id === +ed.dataset.odcEdit)[0]); return; }
    if (dl) {
      const row = _odcItems.filter(r => r.id === +dl.dataset.odcDel)[0];
      if (row) _odcHapus('/config/odc/' + row.id, row.nama, 'node', muatOdcList);
      return;
    }
    const add2 = t('data-add-jenis');
    if (add2) {
      openNodeEditor({
        parentId: add2.dataset.addParent ? parseInt(add2.dataset.addParent, 10) : null,
        port: add2.dataset.addPort || '',
        jenis: add2.dataset.addJenis,
      });
      return;
    }
    const ne = t('data-node-edit'), nd = t('data-node-del');
    if (ne || nd) {
      const id = parseInt((ne || nd).dataset.nodeEdit || (nd).dataset.nodeDel, 10);
      const node = (_odcData.nodes || []).filter(x => x.id === id)[0];
      if (!node) return;
      if (ne) openNodeEditor({ node: node });
      else _odcHapus('/config/odc/' + _odcData.odc.id + '/node/' + id,
                     node.nama || node.tipe, 'node', () => bukaOdc(_odcData.odc.id));
    }
  };

  // Master data dipakai seluruh dropdown di halaman ini.
  authFetch('/config/master').then(d => { _odcMaster = d; }).catch(() => { _odcMaster = null; });

  if (m) bukaOdc(parseInt(m[1], 10));
  else { _odcLayar(false); muatOdcList(); }
}

PAGE_INIT['odc'] = initOdc;
PAGE_ACTIONS['odc'] = {
  refresh: () => (_odcData && !document.getElementById('odcTopo').hidden)
    ? bukaOdc(_odcData.odc.id) : muatOdcList(),
};
PAGE_TEARDOWN['odc'] = () => {
  const c = document.getElementById('contentArea');
  if (c) { c.style.padding = ''; c.style.overflow = ''; }
};
