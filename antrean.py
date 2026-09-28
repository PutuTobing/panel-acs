#!/usr/bin/env python3
"""
SKY ACS — batas umur task panel yang mengantre di GenieACS.

═══ MASALAHNYA ═══

Bila ONU tidak menjawab connection-request, GenieACS membalas 202: task BARU
DIANTRE, dan akan dijalankan kapan pun ONU itu inform lagi — besok, bulan
depan, tanpa batas. Panel memberi tahu teknisi "perintah tersimpan, jangan
diulang", dan untuk ONU yang sekadar lambat itu benar.

Untuk ONU yang mati berhari-hari itu menjadi bom waktu. Diukur 2026-09-29:
207 task menggantung di 35 ONU, 192 di antaranya > 7 hari, termasuk:
  • ganti password WiFi berumur 44 hari — pelanggan yang sudah lama memakai
    password lain tiba-tiba terputus begitu ONU-nya menyala;
  • refreshObject seluruh pohon ZL-2113X dari 2026-08-01, dibuat sebelum
    acs_guard ada — jenis beban yang pernah membekukan model itu.

═══ ATURANNYA ═══

Task yang DIBUAT PANEL dan dijawab 202 dicatat di tabel `task_antre`. Penjaga
di thread latar memeriksanya tiap INTERVAL_PERIKSA detik:
  • sudah tidak ada di antrean GenieACS  → 'tuntas' (dijalankan, atau dihapus
    orang lain — keduanya bukan urusan penjaga lagi);
  • masih mengantre > KEDALUWARSA_MENIT  → DELETE task + fault-nya bila ada,
    status 'dibatalkan', dicatat ke audit_log `task_kedaluwarsa`.

Yang SENGAJA tidak disentuh: task yang bukan buatan panel (UI GenieACS,
skrip, provision). Penjaga ini tidak boleh berubah menjadi "hapus apa saja
yang tua" — itu keputusan manusia, bukan kode yang berjalan sendiri.

═══ KENAPA 30 MENIT ═══

Interval inform armada ini 300 dtk. ONU yang hidup pasti inform dalam 5
menit dan menjalankan task-nya; 30 menit = enam kesempatan. Task yang masih
mengantre sesudah itu berarti ONU mati atau terputus — dan ketika ia kembali,
teknisi yang mengirim perintah sudah lama pergi dan tidak mengharapkannya.
Lebih lama dari ini mulai memberi ruang bagi bom waktu; lebih pendek dari
~3 interval berisiko membatalkan task milik ONU yang sekadar terlambat inform.
"""

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import db

KEDALUWARSA_MENIT = 30
INTERVAL_PERIKSA  = 60
SIMPAN_RIWAYAT_HARI = 7        # baris tuntas/dibatalkan dibuang sesudah ini


# ═══════════════════════════════════════════════════════════════════
#  Pencatatan — dipanggil server.py::_proxy saat NBI menjawab 202
# ═══════════════════════════════════════════════════════════════════
def catat(task_id, device_id, nama='', pemilik='', sekarang=None):
    if not task_id or not device_id:
        return
    c = db.conn()
    c.execute('''INSERT OR IGNORE INTO task_antre (task_id, device_id, nama, pemilik, dibuat)
                 VALUES (?,?,?,?,?)''',
              (str(task_id), str(device_id), str(nama or ''), str(pemilik or ''),
               sekarang or time.time()))
    c.commit()


def catat_dari_jawaban(device_id, body_permintaan, data_jawaban, pemilik=''):
    """Ambil _id task dari jawaban 202 NBI lalu catat. Tidak pernah melempar:
    gagal mencatat tidak boleh membuat perintah yang SUDAH terkirim tampak gagal."""
    try:
        task = json.loads(data_jawaban.decode('utf-8')) if data_jawaban else {}
        if not isinstance(task, dict) or not task.get('_id'):
            return
        nama = task.get('name')
        if not nama:
            nama = (json.loads(body_permintaan.decode('utf-8')) or {}).get('name', '')
        catat(task['_id'], device_id, nama, pemilik)
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════
#  NBI — sengaja minimal: hanya GET antrean/fault dan DELETE satu task/fault
# ═══════════════════════════════════════════════════════════════════
def _nbi(method, base, path, auth=None, timeout=20):
    req = urllib.request.Request(base.rstrip('/') + path, method=method)
    if auth:
        req.add_header('Authorization', auth)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return r.status, (json.loads(raw) if raw else None)


def _q(obj):
    return urllib.parse.quote(json.dumps(obj), safe='')


# ═══════════════════════════════════════════════════════════════════
#  Satu putaran penjaga
# ═══════════════════════════════════════════════════════════════════
def periksa_sekali(base, auth=None, sekarang=None):
    """Kembalian: {'tuntas': n, 'dibatalkan': n, 'gagal': n, 'mengantre': n}.

    Dipisah dari thread-nya agar bisa diuji langsung dengan NBI tiruan."""
    sekarang = sekarang or time.time()
    c = db.conn()
    rows = [dict(r) for r in c.execute(
        "SELECT * FROM task_antre WHERE status='mengantre'").fetchall()]
    hasil = {'tuntas': 0, 'dibatalkan': 0, 'gagal': 0, 'mengantre': 0}
    if not rows:
        _buang_riwayat(c, sekarang)
        return hasil

    # Satu GET untuk semua perangkat. _id task adalah ObjectId di MongoDB, jadi
    # dicocokkan di sini — kueri NBI dengan _id berupa string tidak akan cocok.
    devs = sorted({r['device_id'] for r in rows})
    _, antre = _nbi('GET', base, '/tasks/?query=' + _q({'device': {'$in': devs}})
                    + '&projection=_id', auth)
    masih = {t.get('_id') for t in (antre or [])}

    batas = KEDALUWARSA_MENIT * 60
    for r in rows:
        tid = r['task_id']
        if tid not in masih:
            c.execute("UPDATE task_antre SET status='tuntas', selesai=? WHERE task_id=?",
                      (sekarang, tid))
            hasil['tuntas'] += 1
            continue
        if sekarang - r['dibuat'] <= batas:
            hasil['mengantre'] += 1
            continue
        try:
            _batalkan(base, auth, r)
        except Exception:
            # 503 "Device is in session", jaringan putus, dsb. — coba lagi pada
            # putaran berikutnya; baris tetap 'mengantre'.
            hasil['gagal'] += 1
            continue
        c.execute("UPDATE task_antre SET status='dibatalkan', selesai=? WHERE task_id=?",
                  (sekarang, tid))
        umur = int((sekarang - r['dibuat']) / 60)
        db.audit('task_kedaluwarsa',
                 f"{r['nama']} · {r['device_id']} · mengantre {umur} menit tanpa dijalankan "
                 f"ONU → dibatalkan · dikirim oleh {r['pemilik'] or '?'} · task {tid}")
        hasil['dibatalkan'] += 1
    c.commit()
    _buang_riwayat(c, sekarang)
    return hasil


def _batalkan(base, auth, r):
    tid = r['task_id']
    try:
        _nbi('DELETE', base, '/tasks/' + urllib.parse.quote(tid, safe=''), auth)
    except urllib.error.HTTPError as e:
        if e.code != 404:          # 404 = sudah hilang di antara GET dan DELETE
            raise
    # Task yang gagal meninggalkan fault berkanal task_<id>; tanpa dihapus ia
    # tetap tampil sebagai kegagalan aktif di ONU itu.
    fid = f"{r['device_id']}:task_{tid}"
    _, ada = _nbi('GET', base, '/faults/?query=' + _q({'_id': fid}) + '&projection=_id', auth)
    if ada:
        try:
            _nbi('DELETE', base, '/faults/' + urllib.parse.quote(fid, safe=''), auth)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise


def _buang_riwayat(c, sekarang):
    c.execute("DELETE FROM task_antre WHERE status!='mengantre' AND selesai < ?",
              (sekarang - SIMPAN_RIWAYAT_HARI * 86400,))
    c.commit()


# ═══════════════════════════════════════════════════════════════════
#  Ringkasan untuk halaman kesehatan
# ═══════════════════════════════════════════════════════════════════
def ringkasan(sekarang=None):
    sekarang = sekarang or time.time()
    c = db.conn()
    per_status = {r['status']: r['n'] for r in c.execute(
        'SELECT status, COUNT(*) AS n FROM task_antre GROUP BY status')}
    mengantre = [dict(r) for r in c.execute(
        "SELECT * FROM task_antre WHERE status='mengantre' ORDER BY dibuat")]
    for r in mengantre:
        r['umurMenit'] = int((sekarang - r['dibuat']) / 60)
    dibatalkan_24j = c.execute(
        "SELECT COUNT(*) AS n FROM task_antre WHERE status='dibatalkan' AND selesai >= ?",
        (sekarang - 86400,)).fetchone()['n']
    return {
        'kedaluwarsaMenit': KEDALUWARSA_MENIT,
        'perStatus':        per_status,
        'mengantre':        mengantre,
        'dibatalkan24Jam':  dibatalkan_24j,
    }


# ═══════════════════════════════════════════════════════════════════
#  Thread latar
# ═══════════════════════════════════════════════════════════════════
_thread = None


def mulai_penjaga(base_fn, auth_fn=None):
    """base_fn/auth_fn dibaca ulang tiap putaran: mengubah Koneksi ACS di
    Settings langsung berlaku, sama seperti proxy."""
    global _thread
    if _thread is not None:
        return _thread

    def _loop():
        while True:
            time.sleep(INTERVAL_PERIKSA)
            try:
                periksa_sekali(base_fn(), auth_fn() if auth_fn else None)
            except Exception:
                # GenieACS mati sebentar tidak boleh membunuh penjaga.
                pass

    _thread = threading.Thread(target=_loop, name='penjaga-antrean', daemon=True)
    _thread.start()
    return _thread
