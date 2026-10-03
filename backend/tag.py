#!/usr/bin/env python3
"""
SKY ACS — Tag panel untuk ONU (2026-10-03).

Permintaan operator: beberapa ONU milik MITRA (mis. "Surya", "Bayu") ikut terhubung ke ACS
Sky Tech, dan daftar Device perlu dipisah per mitra. Tag GenieACS (`_tags`) sudah terlalu
banyak dan dipakai provision, jadi panel punya tag SENDIRI di basis data panel:
    tag      nama tag (MITRA-SURYA, MITRA-BAYU, …) + warna
    tag_onu  pasangan tag ↔ deviceId GenieACS

KENAPA TIDAK MENULIS KE `_tags` GENIEACS
  Panel tidak pernah menulis ke GenieACS selain task ke ONU yang diminta operator. Tag
  GenieACS bisa dibaca preset/provision; mengubahnya dari panel bisa diam-diam mengubah
  perilaku provisioning. Tag panel murni label di sisi panel — tidak ada yang terkirim ke
  ONU maupun ke GenieACS.

WEWENANG (dicek di server.py)
  membaca & memfilter   : semua akun staf
  membuat/memasang/melepas: administrator, atau role yang diberi izin "buatTag"
  menghapus nama tag     : administrator saja
"""

import re

import db

RE_NAMA = re.compile(r'^[A-Z0-9][A-Z0-9._-]{0,31}$')
RE_WARNA = re.compile(r'^#[0-9a-fA-F]{6}$')
WARNA_BAWAAN = ('#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#64748b')
MAKS_PERANGKAT = 2000          # satu permintaan pasang/lepas — lebih dari armada saat ini
MAKS_ID = 200                  # panjang deviceId GenieACS yang wajar


class TagError(ValueError):
    """Galat yang aman ditampilkan apa adanya ke pengguna."""


def rapikan_nama(nama):
    """'mitra surya' → 'MITRA-SURYA'. Spasi jadi '-', huruf besar semua."""
    n = re.sub(r'\s+', '-', str(nama or '').strip()).upper()
    if not RE_NAMA.match(n):
        raise TagError('Nama tag 1–32 karakter: huruf, angka, titik, garis bawah, atau tanda minus '
                       '(mis. MITRA-SURYA)')
    return n


def daftar():
    """[{nama, warna, jumlah}] urut nama."""
    rows = db.conn().execute('''
        SELECT t.nama, t.warna, COUNT(o.device_id) AS jumlah
          FROM tag t LEFT JOIN tag_onu o ON o.tag_id = t.id
         GROUP BY t.id ORDER BY t.nama''').fetchall()
    return [{'nama': r['nama'], 'warna': r['warna'], 'jumlah': r['jumlah']} for r in rows]


def per_perangkat():
    """{deviceId: [nama, …]} — untuk menempelkan tag ke daftar Device sekali muat."""
    out = {}
    for r in db.conn().execute('''
            SELECT o.device_id, t.nama FROM tag_onu o JOIN tag t ON t.id = o.tag_id
             ORDER BY t.nama''').fetchall():
        out.setdefault(r['device_id'], []).append(r['nama'])
    return out


def buat(nama, warna=None, actor=None, ip=''):
    nama = rapikan_nama(nama)
    if warna is not None and warna != '' and not RE_WARNA.match(str(warna)):
        raise TagError('Warna harus berbentuk #RRGGBB')
    c = db.conn()
    if c.execute('SELECT 1 FROM tag WHERE nama = ?', (nama,)).fetchone():
        raise TagError('Tag ' + nama + ' sudah ada')
    if not warna:
        n = c.execute('SELECT COUNT(*) AS n FROM tag').fetchone()['n']
        warna = WARNA_BAWAAN[n % len(WARNA_BAWAAN)]
    c.execute('INSERT INTO tag (nama, warna, dibuat_oleh, dibuat_at) VALUES (?,?,?,?)',
              (nama, warna, (actor or {}).get('username', ''), db.now()))
    c.commit()
    db.audit('tag.buat', nama, actor, ip)
    return {'nama': nama, 'warna': warna, 'jumlah': 0}


def hapus(nama, actor=None, ip=''):
    nama = rapikan_nama(nama)
    c = db.conn()
    r = c.execute('SELECT id FROM tag WHERE nama = ?', (nama,)).fetchone()
    if not r:
        raise TagError('Tag ' + nama + ' tidak ditemukan')
    n = c.execute('SELECT COUNT(*) AS n FROM tag_onu WHERE tag_id = ?', (r['id'],)).fetchone()['n']
    c.execute('DELETE FROM tag_onu WHERE tag_id = ?', (r['id'],))
    c.execute('DELETE FROM tag WHERE id = ?', (r['id'],))
    c.commit()
    db.audit('tag.hapus', f'{nama} (terlepas dari {n} ONU)', actor, ip)
    return n


def pasang(nama, perangkat, lepas=False, actor=None, ip=''):
    """Pasang (atau lepas) satu tag pada sekumpulan deviceId. Kembalikan jumlah yang berubah."""
    nama = rapikan_nama(nama)
    if not isinstance(perangkat, list) or not perangkat:
        raise TagError('Pilih minimal satu ONU')
    if len(perangkat) > MAKS_PERANGKAT:
        raise TagError(f'Terlalu banyak ONU sekaligus (maks {MAKS_PERANGKAT})')
    ids = []
    for d in perangkat:
        if not isinstance(d, str) or not d.strip() or len(d) > MAKS_ID:
            raise TagError('Device ID tidak sah')
        ids.append(d.strip())
    c = db.conn()
    r = c.execute('SELECT id FROM tag WHERE nama = ?', (nama,)).fetchone()
    if not r:
        raise TagError('Tag ' + nama + ' belum ada — buat dulu')
    berubah = 0
    for d in dict.fromkeys(ids):
        if lepas:
            berubah += c.execute('DELETE FROM tag_onu WHERE tag_id = ? AND device_id = ?',
                                 (r['id'], d)).rowcount
        else:
            berubah += c.execute('''INSERT OR IGNORE INTO tag_onu (tag_id, device_id, dipasang_oleh, dipasang_at)
                                    VALUES (?,?,?,?)''',
                                 (r['id'], d, (actor or {}).get('username', ''), db.now())).rowcount
    c.commit()
    if berubah:
        db.audit('tag.lepas' if lepas else 'tag.pasang', f'{nama}: {berubah} ONU', actor, ip)
    return berubah
