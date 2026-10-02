#!/usr/bin/env python3
"""
SKY ACS — Master Data (rancangannya di dokumen PRD "sub menu maps dan data odc" §3 —
dokumen kerja internal, tidak ikut repositori).

Data referensi yang dipakai seluruh diagram Data ODC:
    md_olt   daftar OLT
    md_pon   port PON, milik satu OLT
    md_tap   rasio tap coupler + redaman output biru (kecil) & merah (besar)
    md_plc   PLC splitter + redaman & jumlah port

KENAPA DI DATABASE, BUKAN DI KODE
  Angka redaman berbeda antar vendor, dan yang tahu angka sebenarnya adalah
  operator yang memegang alat ukur — bukan orang yang menulis programnya.
  Menaruhnya di kode berarti setiap koreksi angka menuntut rilis baru.

KENAPA VALIDASINYA DI SINI, BUKAN DI FORM
  Form bisa dilewati (curl, DevTools). Rasio '10/95' yang lolos ke database
  akan menghasilkan perhitungan daya yang salah di SETIAP diagram yang
  memakainya, dan salahnya tidak kentara — angkanya tetap keluar, hanya
  keliru. Jadi batas-batasnya ditegakkan di server.

TENTANG MENGHAPUS
  PRD §3.3 meminta peringatan, bukan blokir keras. Pola yang dipakai:
  hapus TANPA `force` mengembalikan 409 beserta rincian apa saja yang ikut
  terdampak; klien menampilkan rinciannya, lalu mengulang dengan `force=1`
  bila pengguna tetap mau. Jadi tidak ada penghapusan diam-diam, dan tidak
  ada pula jalan buntu.
"""

import re

import db

# ─── Batas yang sah ───
# Redaman 0 dB berarti "tanpa rugi sama sekali" — mustahil pada komponen pasif,
# dan biasanya tanda kolom terisi kosong. Batas atas 60 dB jauh di atas
# komponen mana pun yang wajar dipakai (PLC 1:64 ± 21 dB).
MAX_LOSS_DB   = 60.0
MAX_NAMA      = 64
MAX_KETERANGAN = 200
MAX_PORT      = 128

RE_TAP = re.compile(r'^\s*(\d{1,2})\s*/\s*(\d{1,3})\s*$')
RE_PLC = re.compile(r'^\s*1\s*:\s*(\d{1,3})\s*$')


class MasterDataError(ValueError):
    """Galat yang aman ditampilkan apa adanya ke pengguna."""

    def __init__(self, message, impact=None):
        super(MasterDataError, self).__init__(message)
        self.impact = impact or None


# ═══════════════════════════════════════════════════════════════
#  Pembantu
# ═══════════════════════════════════════════════════════════════
def _rows(sql, args=()):
    c = db.conn()
    return [dict(r) for r in c.execute(sql, args).fetchall()]


def _one(sql, args=()):
    r = db.conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _teks(nilai, label, maks, wajib=True):
    s = ('' if nilai is None else str(nilai)).strip()
    if wajib and not s:
        raise MasterDataError('%s wajib diisi.' % label)
    if len(s) > maks:
        raise MasterDataError('%s maksimal %d karakter.' % (label, maks))
    return s


def _loss(nilai, label):
    try:
        v = float(nilai)
    except (TypeError, ValueError):
        raise MasterDataError('%s harus berupa angka.' % label)
    if v != v or v in (float('inf'), float('-inf')):
        raise MasterDataError('%s harus berupa angka.' % label)
    if v <= 0:
        raise MasterDataError('%s harus lebih besar dari 0 dB — '
                              'komponen pasif selalu punya rugi daya.' % label)
    if v > MAX_LOSS_DB:
        raise MasterDataError('%s maksimal %g dB.' % (label, MAX_LOSS_DB))
    return round(v, 2)


def _int_id(nilai, label):
    try:
        return int(nilai)
    except (TypeError, ValueError):
        raise MasterDataError('%s tidak sah.' % label)


def _unik(e, label, nilai):
    """Ubah galat UNIQUE dari SQLite jadi kalimat yang berguna."""
    if 'UNIQUE' in str(e):
        raise MasterDataError('%s "%s" sudah ada.' % (label, nilai))
    raise


# ═══════════════════════════════════════════════════════════════
#  Bacaan gabungan — dipakai halaman Master Data & (nanti) kanvas ODC
# ═══════════════════════════════════════════════════════════════
def all_get():
    olt = _rows('SELECT * FROM md_olt ORDER BY nama COLLATE NOCASE')
    pon = _rows('''SELECT p.*, o.nama AS olt_nama
                     FROM md_pon p JOIN md_olt o ON o.id = p.olt_id
                 ORDER BY o.nama COLLATE NOCASE, p.nama COLLATE NOCASE''')
    # Jumlah PON per OLT dihitung sekali di sini, bukan lewat satu query per
    # baris di klien — daftarnya kecil, tapi polanya yang menular.
    jml = {}
    for p in pon:
        jml[p['olt_id']] = jml.get(p['olt_id'], 0) + 1
    for o in olt:
        o['jumlah_pon'] = jml.get(o['id'], 0)
    return {
        'olt': olt,
        'pon': pon,
        'tap': _rows('SELECT * FROM md_tap ORDER BY urut, rasio'),
        'plc': _rows('SELECT * FROM md_plc ORDER BY urut, jumlah_port'),
    }


# ═══════════════════════════════════════════════════════════════
#  OLT
# ═══════════════════════════════════════════════════════════════
def olt_save(data, actor=None, ip='', olt_id=None):
    nama = _teks((data or {}).get('nama'), 'Nama OLT', MAX_NAMA)
    ket  = _teks((data or {}).get('keterangan'), 'Keterangan', MAX_KETERANGAN, wajib=False)
    c, ts = db.conn(), db.now()
    try:
        if olt_id is None:
            cur = c.execute('INSERT INTO md_olt (nama, keterangan, created_at, updated_at)'
                            ' VALUES (?,?,?,?)', (nama, ket, ts, ts))
            olt_id = cur.lastrowid
            aksi = 'create'
        else:
            olt_id = _int_id(olt_id, 'ID OLT')
            if not _one('SELECT id FROM md_olt WHERE id=?', (olt_id,)):
                raise MasterDataError('OLT tidak ditemukan.')
            c.execute('UPDATE md_olt SET nama=?, keterangan=?, updated_at=? WHERE id=?',
                      (nama, ket, ts, olt_id))
            aksi = 'update'
        c.commit()
    except db.sqlite3.IntegrityError as e:
        c.rollback()
        _unik(e, 'OLT', nama)
    db.audit('masterdata.olt.' + aksi, nama, actor, ip)
    return _one('SELECT * FROM md_olt WHERE id=?', (olt_id,))


def olt_delete(olt_id, actor=None, ip='', force=False):
    olt_id = _int_id(olt_id, 'ID OLT')
    row = _one('SELECT * FROM md_olt WHERE id=?', (olt_id,))
    if not row:
        raise MasterDataError('OLT tidak ditemukan.')
    pon = _rows('SELECT nama FROM md_pon WHERE olt_id=? ORDER BY nama', (olt_id,))
    if pon and not force:
        raise MasterDataError(
            'OLT "%s" masih memiliki %d port PON.' % (row['nama'], len(pon)),
            impact={'jenis': 'pon', 'jumlah': len(pon),
                    'daftar': [p['nama'] for p in pon][:20]})
    c = db.conn()
    c.execute('DELETE FROM md_pon WHERE olt_id=?', (olt_id,))   # eksplisit, tidak bergantung PRAGMA
    c.execute('DELETE FROM md_olt WHERE id=?', (olt_id,))
    c.commit()
    db.audit('masterdata.olt.delete', '%s (%d PON ikut terhapus)' % (row['nama'], len(pon)), actor, ip)
    return {'deleted': olt_id, 'pon_terhapus': len(pon)}


# ═══════════════════════════════════════════════════════════════
#  PON
# ═══════════════════════════════════════════════════════════════
def pon_save(data, actor=None, ip='', pon_id=None):
    data = data or {}
    olt_id = _int_id(data.get('olt_id'), 'OLT induk')
    olt = _one('SELECT nama FROM md_olt WHERE id=?', (olt_id,))
    if not olt:
        raise MasterDataError('OLT induk tidak ditemukan.')
    nama = _teks(data.get('nama'), 'Nama PON', MAX_NAMA)
    ket  = _teks(data.get('keterangan'), 'Keterangan', MAX_KETERANGAN, wajib=False)
    c, ts = db.conn(), db.now()
    try:
        if pon_id is None:
            cur = c.execute('INSERT INTO md_pon (olt_id, nama, keterangan, created_at, updated_at)'
                            ' VALUES (?,?,?,?,?)', (olt_id, nama, ket, ts, ts))
            pon_id = cur.lastrowid
            aksi = 'create'
        else:
            pon_id = _int_id(pon_id, 'ID PON')
            if not _one('SELECT id FROM md_pon WHERE id=?', (pon_id,)):
                raise MasterDataError('PON tidak ditemukan.')
            c.execute('UPDATE md_pon SET olt_id=?, nama=?, keterangan=?, updated_at=? WHERE id=?',
                      (olt_id, nama, ket, ts, pon_id))
            aksi = 'update'
        c.commit()
    except db.sqlite3.IntegrityError as e:
        c.rollback()
        _unik(e, 'PON "%s" pada %s' % (nama, olt['nama']), nama)
    db.audit('masterdata.pon.' + aksi, '%s / %s' % (olt['nama'], nama), actor, ip)
    return _one('SELECT * FROM md_pon WHERE id=?', (pon_id,))


def pon_delete(pon_id, actor=None, ip='', force=False):
    pon_id = _int_id(pon_id, 'ID PON')
    row = _one('SELECT * FROM md_pon WHERE id=?', (pon_id,))
    if not row:
        raise MasterDataError('PON tidak ditemukan.')
    c = db.conn()
    c.execute('DELETE FROM md_pon WHERE id=?', (pon_id,))
    c.commit()
    db.audit('masterdata.pon.delete', row['nama'], actor, ip)
    return {'deleted': pon_id}


# ═══════════════════════════════════════════════════════════════
#  Rasio tap coupler
# ═══════════════════════════════════════════════════════════════
def _rasio_tap(nilai):
    """Normalkan '10 / 90' → '10/90', sekaligus pastikan totalnya 100%.

    Total yang tidak 100 bukan sekadar salah ketik: ia menghasilkan diagram
    yang tampak benar tapi dayanya tidak pernah bisa cocok dengan hasil ukur
    di lapangan, dan penyebabnya nyaris mustahil dilacak dari layar."""
    m = RE_TAP.match('' if nilai is None else str(nilai))
    if not m:
        raise MasterDataError('Rasio harus berbentuk "kecil/besar", contoh 10/90.')
    kecil, besar = int(m.group(1)), int(m.group(2))
    if kecil + besar != 100:
        raise MasterDataError('Rasio %d/%d totalnya %d%%, seharusnya 100%%.'
                              % (kecil, besar, kecil + besar))
    if kecil <= 0 or kecil > besar:
        raise MasterDataError('Angka pertama adalah porsi KECIL (output biru) '
                              'dan harus lebih kecil dari porsi besar.')
    return '%d/%d' % (kecil, besar), kecil


def tap_save(data, actor=None, ip='', tap_id=None):
    data = data or {}
    rasio, kecil = _rasio_tap(data.get('rasio'))
    biru  = _loss(data.get('loss_biru'),  'Redaman output biru')
    merah = _loss(data.get('loss_merah'), 'Redaman output merah')
    # Porsi kecil selalu kehilangan lebih banyak daya. Tertukar = seluruh
    # diagram menghitung terbalik, dan angkanya tetap "masuk akal" di layar.
    if merah > biru:
        raise MasterDataError(
            'Redaman output merah (%.2f dB) tidak boleh lebih besar daripada '
            'output biru (%.2f dB) — merah membawa porsi besar, jadi rugi '
            'dayanya lebih kecil. Kemungkinan kedua kolom tertukar.' % (merah, biru))
    c, ts = db.conn(), db.now()
    try:
        if tap_id is None:
            cur = c.execute('INSERT INTO md_tap (rasio, loss_biru, loss_merah, urut,'
                            ' created_at, updated_at) VALUES (?,?,?,?,?,?)',
                            (rasio, biru, merah, kecil, ts, ts))
            tap_id = cur.lastrowid
            aksi = 'create'
        else:
            tap_id = _int_id(tap_id, 'ID rasio')
            if not _one('SELECT id FROM md_tap WHERE id=?', (tap_id,)):
                raise MasterDataError('Rasio tidak ditemukan.')
            c.execute('UPDATE md_tap SET rasio=?, loss_biru=?, loss_merah=?, urut=?,'
                      ' updated_at=? WHERE id=?', (rasio, biru, merah, kecil, ts, tap_id))
            aksi = 'update'
        c.commit()
    except db.sqlite3.IntegrityError as e:
        c.rollback()
        _unik(e, 'Rasio', rasio)
    db.audit('masterdata.tap.' + aksi, '%s (biru %.2f / merah %.2f dB)' % (rasio, biru, merah), actor, ip)
    return _one('SELECT * FROM md_tap WHERE id=?', (tap_id,))


def tap_delete(tap_id, actor=None, ip='', force=False):
    tap_id = _int_id(tap_id, 'ID rasio')
    row = _one('SELECT * FROM md_tap WHERE id=?', (tap_id,))
    if not row:
        raise MasterDataError('Rasio tidak ditemukan.')
    pakai = _dipakai_odc('tap', tap_id)
    if pakai and not force:
        raise MasterDataError('Rasio "%s" masih dipakai %d topologi ODC.'
                              % (row['rasio'], len(pakai)),
                              impact={'jenis': 'odc', 'jumlah': len(pakai), 'daftar': pakai})
    c = db.conn()
    c.execute('DELETE FROM md_tap WHERE id=?', (tap_id,))
    c.commit()
    db.audit('masterdata.tap.delete', row['rasio'], actor, ip)
    return {'deleted': tap_id}


# ═══════════════════════════════════════════════════════════════
#  PLC splitter
# ═══════════════════════════════════════════════════════════════
def _rasio_plc(nilai):
    m = RE_PLC.match('' if nilai is None else str(nilai))
    if not m:
        raise MasterDataError('Rasio PLC harus berbentuk "1:N", contoh 1:8.')
    n = int(m.group(1))
    if n < 2:
        raise MasterDataError('PLC minimal membagi ke 2 port.')
    if n > MAX_PORT:
        raise MasterDataError('PLC maksimal %d port.' % MAX_PORT)
    return '1:%d' % n, n


def plc_save(data, actor=None, ip='', plc_id=None):
    data = data or {}
    rasio, jml = _rasio_plc((data or {}).get('rasio'))
    loss = _loss(data.get('loss_db'), 'Redaman')
    c, ts = db.conn(), db.now()
    try:
        if plc_id is None:
            cur = c.execute('INSERT INTO md_plc (rasio, loss_db, jumlah_port, urut,'
                            ' created_at, updated_at) VALUES (?,?,?,?,?,?)',
                            (rasio, loss, jml, jml, ts, ts))
            plc_id = cur.lastrowid
            aksi = 'create'
        else:
            plc_id = _int_id(plc_id, 'ID PLC')
            if not _one('SELECT id FROM md_plc WHERE id=?', (plc_id,)):
                raise MasterDataError('PLC splitter tidak ditemukan.')
            c.execute('UPDATE md_plc SET rasio=?, loss_db=?, jumlah_port=?, urut=?,'
                      ' updated_at=? WHERE id=?', (rasio, loss, jml, jml, ts, plc_id))
            aksi = 'update'
        c.commit()
    except db.sqlite3.IntegrityError as e:
        c.rollback()
        _unik(e, 'PLC splitter', rasio)
    db.audit('masterdata.plc.' + aksi, '%s (%.2f dB)' % (rasio, loss), actor, ip)
    return _one('SELECT * FROM md_plc WHERE id=?', (plc_id,))


def plc_delete(plc_id, actor=None, ip='', force=False):
    plc_id = _int_id(plc_id, 'ID PLC')
    row = _one('SELECT * FROM md_plc WHERE id=?', (plc_id,))
    if not row:
        raise MasterDataError('PLC splitter tidak ditemukan.')
    pakai = _dipakai_odc('plc', plc_id)
    if pakai and not force:
        raise MasterDataError('PLC "%s" masih dipakai %d topologi ODC.'
                              % (row['rasio'], len(pakai)),
                              impact={'jenis': 'odc', 'jumlah': len(pakai), 'daftar': pakai})
    c = db.conn()
    c.execute('DELETE FROM md_plc WHERE id=?', (plc_id,))
    c.commit()
    db.audit('masterdata.plc.delete', row['rasio'], actor, ip)
    return {'deleted': plc_id}


# ═══════════════════════════════════════════════════════════════
#  Pemakaian oleh Data ODC
# ═══════════════════════════════════════════════════════════════
def _dipakai_odc(jenis, ref_id):
    """Nama ODC mana saja yang memakai rasio/PLC ini.

    Tabel odc_node baru ada di Tahap 3. Sampai tabel itu ada, jawabannya
    'belum ada yang memakai' — dan itu memang benar, bukan penyangkalan
    sementara: tanpa tabelnya, memang belum ada topologi apa pun. Begitu
    tabelnya lahir, fungsi ini otomatis mulai menjawab dengan benar tanpa
    ada pemanggil yang perlu berubah."""
    c = db.conn()
    ada = c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='odc_node'").fetchone()
    if not ada:
        return []
    kolom = 'tap_id' if jenis == 'tap' else 'plc_id'
    rows = c.execute('SELECT DISTINCT o.nama FROM odc_node n JOIN odc o ON o.id = n.odc_id'
                     ' WHERE n.%s = ? ORDER BY o.nama' % kolom, (ref_id,)).fetchall()
    return [r[0] for r in rows]
