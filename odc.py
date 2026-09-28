#!/usr/bin/env python3
"""
SKY ACS — Data ODC: topologi jalur kabel FTTH + kalkulasi redaman.

BENTUKNYA POHON, BUKAN GRAF BEBAS
  Satu serat fisik hanya menuju satu tempat, jadi tiap keluaran punya paling
  banyak satu anak:

      PON (input_dbm)
       └─ ODP            tap coupler: keluaran MERAH (porsi besar)
           ├─ merah → ODP berikutnya            (backbone berantai)
           └─ biru  → splitter  ATAU  splitter_odc
                        splitter      : port-portnya menuju PELANGGAN (ujung)
                        splitter_odc  : tiap portnya bisa menuju ODP lain

  Karena berbentuk pohon, dayanya bisa dihitung dalam satu penelusuran dari
  akar — tak perlu deteksi siklus, dan tak mungkin ada node yang dayanya
  bergantung pada dirinya sendiri.

KENAPA HITUNGANNYA DI SERVER, BUKAN DI BROWSER
  Angka yang sama harus keluar di layar, di ekspor PDF, dan di laporan mana
  pun nanti. Dua salinan rumus di dua tempat akan berbeda suatu hari, dan
  bedanya tidak akan terlihat sebagai galat — hanya sebagai dua angka yang
  sama-sama tampak masuk akal.

AMBANG "IDEAL"
  Memakai Ambang RX Power yang SUDAH ADA di Parameter Aplikasi (rxGood /
  rxFair). Daya yang sampai di ONU dan RX power ONU adalah besaran yang sama
  persis — kalau ambangnya dipisah, satu ONU bisa dinilai "Poor" di halaman
  Device tapi "IDEAL" di diagram ODC pada saat yang sama.

  Satu hal yang tidak dimiliki ambang lama: batas ATAS. RX power terlalu kuat
  membuat penerima ONU jenuh dan justru merusak — jadi ditambahkan di sini.
"""

import db
import config_store

# Di atas ini penerima ONU jenuh. Bukan preferensi, melainkan batas fisik
# yang berlaku umum untuk GPON/GEPON — karena itu tidak dibuat bisa disetel,
# tidak seperti rxGood/rxFair.
OVERLOAD_DBM = -8.0

MAX_NAMA = 64
MAX_KETERANGAN = 200
MAX_NODE = 400          # pagar kewarasan; satu PON tak pernah sebesar ini
MIN_INPUT_DBM, MAX_INPUT_DBM = -40.0, 20.0

TIPE_NODE = ('odp', 'splitter', 'splitter_odc')


class OdcError(ValueError):
    def __init__(self, message, impact=None):
        super(OdcError, self).__init__(message)
        self.impact = impact or None


# ═══════════════════════════════════════════════════════════════
#  Pembantu
# ═══════════════════════════════════════════════════════════════
def _rows(sql, args=()):
    return [dict(r) for r in db.conn().execute(sql, args).fetchall()]


def _one(sql, args=()):
    r = db.conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _teks(nilai, label, maks, wajib=True):
    s = ('' if nilai is None else str(nilai)).strip()
    if wajib and not s:
        raise OdcError('%s wajib diisi.' % label)
    if len(s) > maks:
        raise OdcError('%s maksimal %d karakter.' % (label, maks))
    return s


def _int(nilai, label, boleh_kosong=False):
    if nilai in (None, '', 'null'):
        if boleh_kosong:
            return None
        raise OdcError('%s wajib diisi.' % label)
    try:
        return int(nilai)
    except (TypeError, ValueError):
        raise OdcError('%s tidak sah.' % label)


def _dbm(nilai, label):
    try:
        v = float(nilai)
    except (TypeError, ValueError):
        raise OdcError('%s harus berupa angka.' % label)
    if v != v or v in (float('inf'), float('-inf')):
        raise OdcError('%s harus berupa angka.' % label)
    if not (MIN_INPUT_DBM <= v <= MAX_INPUT_DBM):
        raise OdcError('%s harus antara %g dan %g dBm.'
                       % (label, MIN_INPUT_DBM, MAX_INPUT_DBM))
    return round(v, 2)


def _core(nilai):
    n = _int(nilai if nilai not in (None, '') else 1, 'Warna core')
    if not (1 <= n <= 12):
        raise OdcError('Warna core harus 1–12 (standar TIA/EIA-598).')
    return n


# ═══════════════════════════════════════════════════════════════
#  Ambang
# ═══════════════════════════════════════════════════════════════
def ambang():
    p = config_store.params_get()
    return {
        'ideal':    float(p.get('rxGood', -20)),
        'cukup':    float(p.get('rxFair', -25)),
        'overload': OVERLOAD_DBM,
    }


def status_dbm(v, amb=None):
    """'kuat' | 'ideal' | 'cukup' | 'buruk' — kosong bila dayanya tak terhitung."""
    if v is None:
        return ''
    a = amb or ambang()
    if v > a['overload']:
        return 'kuat'          # jenuh — merusak penerima, bukan "sangat bagus"
    if v >= a['ideal']:
        return 'ideal'
    if v >= a['cukup']:
        return 'cukup'
    return 'buruk'


# ═══════════════════════════════════════════════════════════════
#  Daftar ODC
# ═══════════════════════════════════════════════════════════════
def list_get():
    rows = _rows('''SELECT o.*, l.nama AS olt_nama, p.nama AS pon_nama
                      FROM odc o
                      LEFT JOIN md_olt l ON l.id = o.olt_id
                      LEFT JOIN md_pon p ON p.id = o.pon_id
                  ORDER BY o.nama COLLATE NOCASE''')
    # Ringkasan tiap ODC dihitung di sini supaya daftarnya bisa menampilkan
    # kesehatan tanpa klien memanggil satu endpoint per baris.
    for r in rows:
        try:
            r['ringkasan'] = hitung(r['id'])['ringkasan']
        except OdcError:
            r['ringkasan'] = None
    return rows


def _cek_olt_pon(olt_id, pon_id):
    if olt_id is None:
        return None, None
    olt = _one('SELECT * FROM md_olt WHERE id=?', (olt_id,))
    if not olt:
        raise OdcError('OLT tidak ditemukan di Master Data.')
    if pon_id is None:
        return olt, None
    pon = _one('SELECT * FROM md_pon WHERE id=?', (pon_id,))
    if not pon:
        raise OdcError('Port PON tidak ditemukan di Master Data.')
    # Tanpa cek ini, satu ODC bisa tercatat memakai PON milik OLT lain —
    # dan di layar tetap terbaca wajar karena keduanya nama yang sah.
    if pon['olt_id'] != olt['id']:
        raise OdcError('Port PON "%s" bukan milik OLT "%s".' % (pon['nama'], olt['nama']))
    return olt, pon


def save(data, actor=None, ip='', odc_id=None):
    data = data or {}
    nama = _teks(data.get('nama'), 'Nama ODC', MAX_NAMA)
    ket  = _teks(data.get('keterangan'), 'Keterangan', MAX_KETERANGAN, wajib=False)
    olt_id = _int(data.get('olt_id'), 'OLT', boleh_kosong=True)
    pon_id = _int(data.get('pon_id'), 'PON', boleh_kosong=True)
    _cek_olt_pon(olt_id, pon_id)
    inp  = _dbm(data.get('input_dbm', 0) or 0, 'Input power')
    core = _core(data.get('core_line'))

    c, ts = db.conn(), db.now()
    siapa = (actor or {}).get('username', '') if isinstance(actor, dict) else str(actor or '')
    try:
        if odc_id is None:
            cur = c.execute('''INSERT INTO odc (nama, olt_id, pon_id, keterangan, input_dbm,
                                                core_line, created_at, updated_at, created_by)
                               VALUES (?,?,?,?,?,?,?,?,?)''',
                            (nama, olt_id, pon_id, ket, inp, core, ts, ts, siapa))
            odc_id = cur.lastrowid
            aksi = 'create'
        else:
            odc_id = _int(odc_id, 'ID ODC')
            if not _one('SELECT id FROM odc WHERE id=?', (odc_id,)):
                raise OdcError('ODC tidak ditemukan.')
            c.execute('''UPDATE odc SET nama=?, olt_id=?, pon_id=?, keterangan=?,
                                        input_dbm=?, core_line=?, updated_at=?
                          WHERE id=?''',
                      (nama, olt_id, pon_id, ket, inp, core, ts, odc_id))
            aksi = 'update'
        c.commit()
    except db.sqlite3.IntegrityError as e:
        c.rollback()
        if 'UNIQUE' in str(e):
            raise OdcError('ODC "%s" sudah ada.' % nama)
        raise
    db.audit('odc.' + aksi, nama, actor, ip)
    return _one('SELECT * FROM odc WHERE id=?', (odc_id,))


def delete(odc_id, actor=None, ip='', force=False):
    odc_id = _int(odc_id, 'ID ODC')
    row = _one('SELECT * FROM odc WHERE id=?', (odc_id,))
    if not row:
        raise OdcError('ODC tidak ditemukan.')
    n = db.conn().execute('SELECT COUNT(*) FROM odc_node WHERE odc_id=?', (odc_id,)).fetchone()[0]
    if n and not force:
        raise OdcError('Topologi "%s" berisi %d node.' % (row['nama'], n),
                       impact={'jenis': 'node', 'jumlah': n, 'daftar': [
                           r['nama'] or r['tipe'] for r in
                           _rows('SELECT nama, tipe FROM odc_node WHERE odc_id=? LIMIT 20', (odc_id,))]})
    c = db.conn()
    c.execute('DELETE FROM odc_node WHERE odc_id=?', (odc_id,))
    c.execute('DELETE FROM odc WHERE id=?', (odc_id,))
    c.commit()
    db.audit('odc.delete', '%s (%d node)' % (row['nama'], n), actor, ip)
    return {'deleted': odc_id, 'node_terhapus': n}


# ═══════════════════════════════════════════════════════════════
#  Node
# ═══════════════════════════════════════════════════════════════
def _plc_ports(plc):
    return int(plc['jumlah_port']) if plc else 0


def _cek_slot(odc_id, parent_id, parent_port, kecuali=None):
    """Pastikan keluaran itu belum ditempati node lain."""
    if parent_id is None:
        sql = 'SELECT * FROM odc_node WHERE odc_id=? AND parent_id IS NULL'
        args = [odc_id]
    else:
        sql = 'SELECT * FROM odc_node WHERE odc_id=? AND parent_id=? AND parent_port=?'
        args = [odc_id, parent_id, parent_port]
    for r in _rows(sql, tuple(args)):
        if kecuali is not None and r['id'] == kecuali:
            continue
        if parent_id is None:
            raise OdcError('ODC ini sudah punya jalur dari PON. '
                           'Satu port PON hanya membawa satu serat keluar.')
        raise OdcError('Keluaran itu sudah terpakai oleh "%s".' % (r['nama'] or r['tipe']))


def _cek_parent(odc_id, parent_id, parent_port, tipe):
    """Boleh tidaknya sebuah node menempel di keluaran tertentu."""
    if parent_id is None:
        if tipe != 'odp':
            raise OdcError('Hanya ODP yang boleh langsung menempel di PON.')
        return
    p = _one('SELECT * FROM odc_node WHERE id=? AND odc_id=?', (parent_id, odc_id))
    if not p:
        raise OdcError('Node induk tidak ditemukan.')

    if p['tipe'] == 'odp':
        # ODP yang langsung memakai PLC adalah titik AKHIR: seratnya habis
        # dibagi ke pelanggan, tidak ada porsi besar yang tersisa untuk
        # diteruskan. Tanpa penjaga ini, cabang di bawahnya akan tergambar
        # rapi dengan daya yang tidak pernah benar-benar ada.
        if p['mode'] == 'plc':
            raise OdcError('"%s" memakai PLC splitter langsung — port-portnya '
                           'menuju pelanggan dan tidak punya keluaran untuk '
                           'disambung lagi.' % (p['nama'] or 'ODP'))
        if parent_port == 'merah':
            # Merah = porsi besar = backbone. Menaruh splitter di sini berarti
            # membuang seluruh sisa daya jalur — hampir pasti salah pasang.
            if tipe != 'odp':
                raise OdcError('Keluaran merah adalah jalur utama (porsi besar) — '
                               'isinya harus ODP berikutnya, bukan splitter.')
        elif parent_port == 'biru':
            if tipe == 'odp':
                raise OdcError('Keluaran biru adalah porsi kecil, tujuannya splitter — '
                               'ODP berikutnya disambung dari keluaran merah.')
        else:
            raise OdcError('Keluaran ODP hanya "merah" atau "biru".')
        return

    # Induk berupa splitter
    if p['tipe'] == 'splitter':
        raise OdcError('Splitter ujung port-portnya menuju pelanggan — '
                       'tidak bisa disambung ke ODP. Pakai "Splitter ODC" untuk itu.')
    if tipe != 'odp':
        raise OdcError('Port splitter ODC hanya bisa menuju ODP.')
    plc = _one('SELECT * FROM md_plc WHERE id=?', (p['plc_id'],)) if p['plc_id'] else None
    n = _plc_ports(plc)
    if not (parent_port.startswith('p') and parent_port[1:].isdigit()):
        raise OdcError('Nomor port tidak sah.')
    k = int(parent_port[1:])
    if not (1 <= k <= n):
        raise OdcError('Splitter ini hanya punya %d port (diminta port %d).' % (n, k))


def node_save(odc_id, data, actor=None, ip='', node_id=None):
    odc_id = _int(odc_id, 'ID ODC')
    o = _one('SELECT * FROM odc WHERE id=?', (odc_id,))
    if not o:
        raise OdcError('ODC tidak ditemukan.')
    data = data or {}

    lama = None
    if node_id is not None:
        node_id = _int(node_id, 'ID node')
        lama = _one('SELECT * FROM odc_node WHERE id=? AND odc_id=?', (node_id, odc_id))
        if not lama:
            raise OdcError('Node tidak ditemukan.')

    tipe = str(data.get('tipe') or (lama or {}).get('tipe') or '').strip()
    if tipe not in TIPE_NODE:
        raise OdcError('Jenis node tidak dikenal.')

    if lama is None:
        jml = db.conn().execute('SELECT COUNT(*) FROM odc_node WHERE odc_id=?', (odc_id,)).fetchone()[0]
        if jml >= MAX_NODE:
            raise OdcError('Satu topologi dibatasi %d node.' % MAX_NODE)
        parent_id   = _int(data.get('parent_id'), 'Node induk', boleh_kosong=True)
        parent_port = str(data.get('parent_port') or '').strip()
        _cek_parent(odc_id, parent_id, parent_port, tipe)
        _cek_slot(odc_id, parent_id, parent_port)
    else:
        # Memindahkan node ke induk lain di luar cakupan: hapus lalu buat lagi.
        parent_id, parent_port = lama['parent_id'], lama['parent_port']

    nama = _teks(data.get('nama'), 'Nama', MAX_NAMA,
                 wajib=(tipe == 'odp')) or _nama_bawaan(tipe)
    core = _core(data.get('core', (lama or {}).get('core', 1)))

    tap_id = plc_id = None
    mode = 'tap'
    if tipe == 'odp':
        mode = str(data.get('mode') or (lama or {}).get('mode') or 'tap').strip()
        if mode not in ('tap', 'plc'):
            raise OdcError('Mode ODP hanya "tap" (pakai rasio) atau "plc" (langsung splitter).')
        # Berganti mode saat sudah bercabang akan memutus cabangnya tanpa
        # suara: keluaran yang menopangnya lenyap, tapi barisnya tetap ada di
        # database dan tetap tergambar.
        if lama is not None and mode != lama['mode']:
            anak = _rows('SELECT nama, tipe FROM odc_node WHERE parent_id=?', (lama['id'],))
            if anak:
                raise OdcError(
                    'Mode tidak bisa diubah selagi "%s" masih membawahi %d node. '
                    'Hapus cabangnya lebih dulu.' % (lama['nama'] or 'ODP', len(anak)),
                    impact={'jenis': 'node', 'jumlah': len(anak),
                            'daftar': [a['nama'] or a['tipe'] for a in anak]})
        if mode == 'tap':
            tap_id = _int(data.get('tap_id'), 'Rasio splitter', boleh_kosong=True)
            if tap_id is not None and not _one('SELECT id FROM md_tap WHERE id=?', (tap_id,)):
                raise OdcError('Rasio tidak ditemukan di Master Data.')
        else:
            plc_id = _int(data.get('plc_id'), 'PLC splitter', boleh_kosong=True)
            if plc_id is not None and not _one('SELECT id FROM md_plc WHERE id=?', (plc_id,)):
                raise OdcError('PLC splitter tidak ditemukan di Master Data.')
    else:
        plc_id = _int(data.get('plc_id'), 'PLC splitter', boleh_kosong=True)
        if plc_id is not None and not _one('SELECT id FROM md_plc WHERE id=?', (plc_id,)):
            raise OdcError('PLC splitter tidak ditemukan di Master Data.')
        if lama is not None and plc_id != lama['plc_id']:
            _cek_kurang_port(odc_id, lama['id'], plc_id)

    c, ts = db.conn(), db.now()
    try:
        if lama is None:
            cur = c.execute('''INSERT INTO odc_node (odc_id, tipe, nama, parent_id, parent_port,
                                                     tap_id, plc_id, core, mode,
                                                     created_at, updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?)''',
                            (odc_id, tipe, nama, parent_id, parent_port,
                             tap_id, plc_id, core, mode, ts, ts))
            node_id = cur.lastrowid
            aksi = 'node.create'
        else:
            c.execute('''UPDATE odc_node SET nama=?, tap_id=?, plc_id=?, core=?, mode=?,
                                             updated_at=? WHERE id=?''',
                      (nama, tap_id, plc_id, core, mode, ts, node_id))
            aksi = 'node.update'
        c.commit()
    except db.sqlite3.IntegrityError as e:
        c.rollback()
        if 'UNIQUE' in str(e):
            raise OdcError('Keluaran itu sudah terpakai.')
        raise
    c.execute('UPDATE odc SET updated_at=? WHERE id=?', (ts, odc_id))
    c.commit()
    db.audit('odc.' + aksi, '%s / %s' % (o['nama'], nama), actor, ip)
    return _one('SELECT * FROM odc_node WHERE id=?', (node_id,))


def _cek_kurang_port(odc_id, node_id, plc_id_baru):
    """Mengecilkan splitter tidak boleh memutus cabang yang sudah tersambung.

    Mengubah 1:8 → 1:4 sementara port 5–8 sudah menuju ODP akan meninggalkan
    cabang yang tak punya sumber daya. Diagramnya tetap tergambar, tapi
    angkanya berhenti masuk akal — jadi ditolak, dengan menyebutkan port
    mana yang menghalangi."""
    plc = _one('SELECT * FROM md_plc WHERE id=?', (plc_id_baru,)) if plc_id_baru else None
    n = _plc_ports(plc)
    tersambung = []
    for r in _rows('SELECT parent_port FROM odc_node WHERE parent_id=?', (node_id,)):
        p = r['parent_port']
        if p.startswith('p') and p[1:].isdigit() and int(p[1:]) > n:
            tersambung.append(p)
    if tersambung:
        raise OdcError('Splitter tidak bisa dikecilkan: port %s masih tersambung ke ODP.'
                       % ', '.join(sorted(tersambung)))


def node_move(odc_id, node_id, data, actor=None, ip=''):
    """Pindahkan node ke keluaran lain (menarik port splitter ke sebuah ODP).

    PENJAGA SIKLUS. Memindahkan sebuah node ke bawah turunannya sendiri
    membuat cabang yang dayanya bergantung pada dirinya sendiri — penelusuran
    di hitung() tidak akan pernah selesai, dan cabang itu lenyap dari layar
    tanpa satu pun pesan galat. Karena itu diperiksa lebih dulu, bukan
    diserahkan pada batas kedalaman.
    """
    odc_id  = _int(odc_id, 'ID ODC')
    node_id = _int(node_id, 'ID node')
    row = _one('SELECT * FROM odc_node WHERE id=? AND odc_id=?', (node_id, odc_id))
    if not row:
        raise OdcError('Node tidak ditemukan.')

    data = data or {}
    parent_id   = _int(data.get('parent_id'), 'Node induk', boleh_kosong=True)
    parent_port = str(data.get('parent_port') or '').strip()

    if parent_id == node_id:
        raise OdcError('Node tidak bisa disambungkan ke dirinya sendiri.')
    if parent_id is not None:
        turunan = {t['id'] for t in _turunan(odc_id, node_id)}
        if parent_id in turunan:
            raise OdcError('Tujuan itu berada di bawah node yang dipindahkan — '
                           'jalurnya akan berputar kembali ke dirinya sendiri.')

    _cek_parent(odc_id, parent_id, parent_port, row['tipe'])
    _cek_slot(odc_id, parent_id, parent_port, kecuali=node_id)

    c, ts = db.conn(), db.now()
    try:
        c.execute('UPDATE odc_node SET parent_id=?, parent_port=?, updated_at=? WHERE id=?',
                  (parent_id, parent_port, ts, node_id))
        c.execute('UPDATE odc SET updated_at=? WHERE id=?', (ts, odc_id))
        c.commit()
    except db.sqlite3.IntegrityError as e:
        c.rollback()
        if 'UNIQUE' in str(e):
            raise OdcError('Keluaran itu sudah terpakai.')
        raise
    db.audit('odc.node.move', '%s → %s' % (row['nama'] or row['tipe'], parent_port or 'PON'), actor, ip)
    return _one('SELECT * FROM odc_node WHERE id=?', (node_id,))


def node_pos(odc_id, node_id, data, actor=None, ip=''):
    """Simpan posisi node yang digeser.

    Endpoint tersendiri, TERPISAH dari node_save: menggeser kartu tidak boleh
    menyeret ikut validasi rasio, aturan sambungan, dan jejak audit. Selain
    berisik, satu node dengan rasio yang belum dipilih akan menolak disimpan
    — padahal yang diubah hanya letaknya di layar.

    Sengaja TIDAK dicatat di audit log: menggeser kartu tak mengubah satu pun
    angka daya, dan ratusan baris "node digeser" akan menenggelamkan jejak
    yang benar-benar penting.
    """
    odc_id  = _int(odc_id, 'ID ODC')
    node_id = _int(node_id, 'ID node')
    if not _one('SELECT id FROM odc_node WHERE id=? AND odc_id=?', (node_id, odc_id)):
        raise OdcError('Node tidak ditemukan.')
    data = data or {}

    # Mengembalikan ke otomatis TIDAK ditangani di sini — itu tugas rapikan(),
    # yang mengosongkan seluruh topologi sekaligus. Sempat ada cabang 'reset'
    # di fungsi ini, tapi tak ada satu pun pemanggilnya: jalur mati yang tampak
    # hidup justru menyesatkan orang berikutnya.
    try:
        x, y = float(data.get('x')), float(data.get('y'))
    except (TypeError, ValueError):
        raise OdcError('Posisi tidak sah.')
    if x != x or y != y or abs(x) > 100000 or abs(y) > 100000:
        raise OdcError('Posisi di luar batas wajar.')
    x, y = round(x, 1), round(y, 1)

    c = db.conn()
    c.execute('UPDATE odc_node SET pos_x=?, pos_y=? WHERE id=?', (x, y, node_id))
    c.commit()
    return {'id': node_id, 'pos_x': x, 'pos_y': y}


def rapikan(odc_id, actor=None, ip=''):
    """Kembalikan seluruh node ke tata letak otomatis."""
    odc_id = _int(odc_id, 'ID ODC')
    o = _one('SELECT nama FROM odc WHERE id=?', (odc_id,))
    if not o:
        raise OdcError('ODC tidak ditemukan.')
    c = db.conn()
    cur = c.execute('UPDATE odc_node SET pos_x=NULL, pos_y=NULL'
                    ' WHERE odc_id=? AND (pos_x IS NOT NULL OR pos_y IS NOT NULL)', (odc_id,))
    c.commit()
    db.audit('odc.rapikan', '%s (%d node)' % (o['nama'], cur.rowcount), actor, ip)
    return {'direset': cur.rowcount}


def slot_kosong(odc_id):
    """Keluaran mana saja yang masih bisa menerima ODP baru.

    Dipakai tombol "Tambah ODP" di pojok kanan: tanpa daftar ini, tombol itu
    tidak punya cara tahu ke mana ODP-nya harus disambung, dan pengguna harus
    menebak-nebak kartu mana yang punya slot tersisa."""
    odc_id = _int(odc_id, 'ID ODC')
    if not _one('SELECT id FROM odc WHERE id=?', (odc_id,)):
        raise OdcError('ODC tidak ditemukan.')
    nodes = _rows('SELECT * FROM odc_node WHERE odc_id=? ORDER BY id', (odc_id,))
    plc = {r['id']: r for r in _rows('SELECT * FROM md_plc')}
    dipakai = set()
    for n in nodes:
        dipakai.add((n['parent_id'], n['parent_port']))

    slot = []
    if (None, '') not in dipakai:
        slot.append({'parent_id': None, 'port': '', 'label': 'PON — jalur utama'})
    for n in nodes:
        if n['tipe'] == 'odp':
            if n['mode'] == 'plc':
                continue          # titik akhir — tak ada keluaran untuk disambung
            if (n['id'], 'merah') not in dipakai:
                slot.append({'parent_id': n['id'], 'port': 'merah',
                             'label': '%s → Output 1 (merah)' % n['nama']})
        elif n['tipe'] == 'splitter_odc':
            p = plc.get(n['plc_id'])
            for i in range(1, _plc_ports(p) + 1):
                if (n['id'], 'p%d' % i) not in dipakai:
                    slot.append({'parent_id': n['id'], 'port': 'p%d' % i,
                                 'label': '%s → Port %d' % (n['nama'], i)})
    return slot


def _nama_bawaan(tipe):
    return {'splitter': 'Splitter', 'splitter_odc': 'Splitter ODC'}.get(tipe, 'ODP')


def node_delete(odc_id, node_id, actor=None, ip='', force=False):
    odc_id  = _int(odc_id, 'ID ODC')
    node_id = _int(node_id, 'ID node')
    row = _one('SELECT * FROM odc_node WHERE id=? AND odc_id=?', (node_id, odc_id))
    if not row:
        raise OdcError('Node tidak ditemukan.')

    turunan = _turunan(odc_id, node_id)
    if turunan and not force:
        raise OdcError('"%s" masih membawahi %d node.' % (row['nama'] or row['tipe'], len(turunan)),
                       impact={'jenis': 'node', 'jumlah': len(turunan),
                               'daftar': [t['nama'] or t['tipe'] for t in turunan][:20]})
    c = db.conn()
    ids = [node_id] + [t['id'] for t in turunan]
    c.executemany('DELETE FROM odc_node WHERE id=?', [(i,) for i in reversed(ids)])
    c.execute('UPDATE odc SET updated_at=? WHERE id=?', (db.now(), odc_id))
    c.commit()
    db.audit('odc.node.delete', '%s (+%d turunan)' % (row['nama'] or row['tipe'], len(turunan)), actor, ip)
    return {'deleted': node_id, 'turunan_terhapus': len(turunan)}


def _turunan(odc_id, node_id):
    """Seluruh node di bawah satu node, dalam urutan dari atas ke bawah."""
    semua = _rows('SELECT * FROM odc_node WHERE odc_id=?', (odc_id,))
    anak = {}
    for n in semua:
        anak.setdefault(n['parent_id'], []).append(n)
    keluar, antre = [], list(anak.get(node_id, []))
    while antre:
        n = antre.pop(0)
        keluar.append(n)
        antre.extend(anak.get(n['id'], []))
    return keluar


# ═══════════════════════════════════════════════════════════════
#  Kalkulasi
# ═══════════════════════════════════════════════════════════════
def hitung(odc_id):
    odc_id = _int(odc_id, 'ID ODC')
    o = _one('''SELECT o.*, l.nama AS olt_nama, p.nama AS pon_nama
                  FROM odc o
                  LEFT JOIN md_olt l ON l.id = o.olt_id
                  LEFT JOIN md_pon p ON p.id = o.pon_id
                 WHERE o.id=?''', (odc_id,))
    if not o:
        raise OdcError('ODC tidak ditemukan.')

    tap = {r['id']: r for r in _rows('SELECT * FROM md_tap')}
    plc = {r['id']: r for r in _rows('SELECT * FROM md_plc')}
    amb = ambang()

    nodes = _rows('SELECT * FROM odc_node WHERE odc_id=? ORDER BY id', (odc_id,))
    anak = {}
    for n in nodes:
        anak.setdefault(n['parent_id'], {})[n['parent_port']] = n

    hasil, ring = [], {'odp': 0, 'splitter': 0, 'port': 0, 'terpakai': 0,
                       'kuat': 0, 'ideal': 0, 'cukup': 0, 'buruk': 0}

    def telusuri(node, masuk, dalam):
        out = dict(node)
        out['in_dbm'] = masuk
        out['depth']  = dalam
        out['anak']   = {}

        if node['tipe'] == 'odp' and node['mode'] == 'plc':
            # Titik akhir: seratnya langsung dibagi PLC ke pelanggan. Bentuk
            # keluarannya sengaja dibuat SAMA dengan splitter ujung supaya
            # tampilan & ringkasan tak perlu tahu bedanya.
            ring['odp'] += 1
            p = plc.get(node['plc_id'])
            out['plc'] = p
            out['out_merah'] = out['out_biru'] = None
            keluar = None if (p is None or masuk is None) else round(masuk - p['loss_db'], 2)
            out['out_dbm'] = keluar
            out['ports'] = []
            st = status_dbm(keluar, amb)
            for i in range(1, _plc_ports(p) + 1):
                ring['port'] += 1
                if st:
                    ring[st] = ring.get(st, 0) + 1
                out['ports'].append({'port': 'p%d' % i, 'nomor': i, 'dbm': keluar,
                                     'status': st, 'terpakai': False})
        elif node['tipe'] == 'odp':
            ring['odp'] += 1
            t = tap.get(node['tap_id'])
            out['tap'] = t
            # Rasio belum dipilih → dayanya SENGAJA None, bukan 0. Angka 0 dBm
            # adalah nilai yang sah dan akan terbaca sebagai hasil hitung.
            if t is None or masuk is None:
                out['out_merah'] = out['out_biru'] = None
            else:
                out['out_merah'] = round(masuk - t['loss_merah'], 2)
                out['out_biru']  = round(masuk - t['loss_biru'], 2)
            out['status_merah'] = status_dbm(out['out_merah'], amb)
            out['status_biru']  = status_dbm(out['out_biru'], amb)
            for port, nilai in (('merah', out['out_merah']), ('biru', out['out_biru'])):
                k = anak.get(node['id'], {}).get(port)
                if k:
                    out['anak'][port] = telusuri(k, nilai, dalam + 1)
        else:
            ring['splitter'] += 1
            p = plc.get(node['plc_id'])
            out['plc'] = p
            n_port = _plc_ports(p)
            keluar = None if (p is None or masuk is None) else round(masuk - p['loss_db'], 2)
            out['out_dbm'] = keluar
            out['ports'] = []
            for i in range(1, n_port + 1):
                key = 'p%d' % i
                k = anak.get(node['id'], {}).get(key)
                st = status_dbm(keluar, amb)
                port = {'port': key, 'nomor': i, 'dbm': keluar, 'status': st,
                        'terpakai': bool(k)}
                ring['port'] += 1
                if node['tipe'] == 'splitter':
                    # Port splitter ujung = port pelanggan. Hanya ini yang
                    # dinilai IDEAL/tidak; port distribusi masih di tengah jalan.
                    if st:
                        ring[st] = ring.get(st, 0) + 1
                else:
                    if k:
                        ring['terpakai'] += 1
                        out['anak'][key] = telusuri(k, keluar, dalam + 1)
                out['ports'].append(port)
        hasil.append(out)
        return out

    akar = anak.get(None, {}).get('')
    pohon = telusuri(akar, round(float(o['input_dbm']), 2), 0) if akar else None

    return {
        'odc': o,
        'ambang': amb,
        'pohon': pohon,
        'nodes': hasil,
        'ringkasan': ring,
    }
