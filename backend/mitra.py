"""Role MITRA — akun kemitraan yang terikat pada satu tag panel (2026-10-04).

Sebelumnya ONU mitra hanya DITANDAI (tag MITRA-SURYA, MITRA-BAYU di tag.py) dan disaring
teknisi. Kini mitra punya akun sendiri: akun ber-role `mitra` terikat pada SATU tag, dan
"ONU mitra" = ONU yang memakai tag itu.

  • Tag dibuat otomatis dari username saat akun dibuat: 'surya' / 'mitra-surya' →
    MITRA-SURYA. Tag yang sudah ada dipakai apa adanya beserta ONU-nya.
  • Ikatannya lewat id tag (tabel akun_tag), jadi mengganti nama/warna tag tidak memutusnya.
  • Yang boleh dilakukan mitra diatur administrator per izin (config_store: menuDashboard,
    menuDevice, onuSemua, aksiReboot, …). Tanpa izin `onuSemua`, mitra TERBATAS: server
    hanya memberinya ONU bertag miliknya — lihat lingkup() dan pagarnya di server.py.

Semua pagar ditegakkan SERVER (server._pagar_peran). Menu yang disembunyikan di browser
hanya kerapian.
"""

import json
import urllib.parse

import db
import config_store
import tag as tag_mod

ROLE = 'mitra'
AWALAN = 'MITRA-'


def nama_tag(username):
    """'surya' → 'MITRA-SURYA'; 'mitra-bayu' → 'MITRA-BAYU'. Melempar TagError bila tak sah."""
    n = tag_mod.rapikan_nama(username)
    return n if n.startswith(AWALAN) else tag_mod.rapikan_nama(AWALAN + n)


def ikat(user, actor=None, ip=''):
    """Pastikan akun mitra terikat pada tagnya (dibuat bila belum ada). → nama tag.

    Akun yang SUDAH terikat tidak diikat ulang: mengganti username tidak boleh diam-diam
    memindahkan mitra ke kumpulan ONU lain."""
    c = db.conn()
    r = c.execute('''SELECT t.nama FROM akun_tag a JOIN tag t ON t.id = a.tag_id
                      WHERE a.user_id = ?''', (user['id'],)).fetchone()
    if r:
        return r['nama']
    nama = nama_tag(user['username'])
    t = c.execute('SELECT id FROM tag WHERE nama = ?', (nama,)).fetchone()
    if not t:
        tag_mod.buat(nama, None, actor, ip)
        t = c.execute('SELECT id FROM tag WHERE nama = ?', (nama,)).fetchone()
    c.execute('INSERT OR REPLACE INTO akun_tag (user_id, tag_id, diikat_at) VALUES (?,?,?)',
              (user['id'], t['id'], db.now()))
    c.commit()
    db.audit('mitra.tag', f'akun={user["username"]} · tag {nama}', actor, ip)
    return nama


def lepas(user_id):
    """Role akun berubah dari mitra → ikatan dibuang (tag dan ONU-nya tetap ada)."""
    c = db.conn()
    c.execute('DELETE FROM akun_tag WHERE user_id = ?', (user_id,))
    c.commit()


def tag_akun(user_id):
    r = db.conn().execute('''SELECT t.nama FROM akun_tag a JOIN tag t ON t.id = a.tag_id
                              WHERE a.user_id = ?''', (user_id,)).fetchone()
    return r['nama'] if r else ''


def semua_ikatan():
    """{user_id: nama tag} — untuk tabel Manajemen Akun."""
    return {r['user_id']: r['nama'] for r in db.conn().execute(
        'SELECT a.user_id, t.nama FROM akun_tag a JOIN tag t ON t.id = a.tag_id')}


def perangkat(user):
    """Himpunan deviceId milik mitra ini (ONU bertag miliknya)."""
    if not isinstance(user, dict):
        return set()
    return {r['device_id'] for r in db.conn().execute(
        '''SELECT o.device_id FROM tag_onu o JOIN akun_tag a ON a.tag_id = o.tag_id
            WHERE a.user_id = ?''', (user.get('id'),))}


def lingkup(user):
    """None = boleh semua ONU; himpunan deviceId = HANYA itu.

    Dibatasi bila role mitra dan administrator tidak mencentang `onuSemua`. Mitra tanpa
    ikatan tag → himpunan kosong (tidak melihat apa pun), bukan semua."""
    if not isinstance(user, dict) or user.get('role') != ROLE:
        return None
    if config_store.izin_punya(user, 'onuSemua'):
        return None
    return perangkat(user)


# ── Penyaring jawaban NBI untuk mitra yang terbatas ────────────────
def saring_jawaban(koleksi, data, milik):
    """Buang entri milik ONU lain dari jawaban GET NBI. → bytes JSON.

    Disaring di JAWABAN, bukan dengan menyisipkan syarat ke kueri: daftar ratusan deviceId
    di alamat melampaui batas panjang header GenieACS. Jawaban yang tak bisa dibaca sebagai
    larik → larik kosong (gagal TERTUTUP: lebih baik kosong daripada bocor)."""
    try:
        arr = json.loads(data.decode('utf-8'))
    except Exception:
        return b'[]'
    if not isinstance(arr, list):
        return b'[]'
    kunci = '_id' if koleksi == 'devices' else 'device'
    return json.dumps([x for x in arr if isinstance(x, dict) and x.get(kunci) in milik]).encode('utf-8')


def id_dari_fault(fault_id):
    """Id fault GenieACS = '<deviceId>:<channel>' → deviceId."""
    return urllib.parse.unquote(str(fault_id)).rsplit(':', 1)[0]
