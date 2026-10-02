#!/usr/bin/env python3
"""
SKY ACS — ringkasan kesehatan ACS untuk halaman Settings → Kesehatan ACS (PRD §8).

═══ KENAPA ADA ═══

2026-09-29 butuh skrip terpisah dan setengah jam menggali untuk mengetahui:
  • 207 task menggantung, 192 di antaranya > 7 hari (bom waktu);
  • 12 dari 14 kegagalan task berasal dari SATU baris berkoma di konfigurasi
    UI GenieACS, bukan dari panel;
  • 36 fault too_many_commits dari provision, bukan dari perintah panel.
Halaman ini menampilkan hal yang sama dalam satu klik, supaya operator tahu
KAPAN ada masalah dan DI MANA sumbernya tanpa perlu menggali.

═══ MURNI BACA ═══

Hanya GET /faults dan GET /tasks berprojection, ditambah data panel sendiri.
Tidak satu pun perintah dikirim ke ONU; membuka halaman ini berulang kali
tidak menambah beban apa pun pada armada.
"""

import collections
import datetime
import json
import os
import time
import urllib.parse
import urllib.request

import antrean
import acs_guard
import db
import ops_lock

BOM_WAKTU_JAM = 24          # task mengantre selama ini hampir pasti tak ditunggu siapa pun
BATAS_DAFTAR  = 30


def _get(base, path, auth=None, timeout=30):
    req = urllib.request.Request(base.rstrip('/') + path)
    if auth:
        req.add_header('Authorization', auth)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b'[]')


def _umur_jam(ts, sekarang):
    try:
        t = datetime.datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
        return max(0.0, (sekarang - t.timestamp()) / 3600)
    except Exception:
        return None


def _kelompok_umur(jam):
    if jam is None:
        return '?'
    if jam < 1:
        return '< 1 jam'
    if jam < 24:
        return '1–24 jam'
    if jam < 24 * 7:
        return '1–7 hari'
    return '> 7 hari'


URUTAN_UMUR = ['< 1 jam', '1–24 jam', '1–7 hari', '> 7 hari', '?']


def _hitung(iterable):
    return [{'nama': k, 'n': n} for k, n in collections.Counter(iterable).most_common()]


def _umur_tabel(daftar_jam):
    c = collections.Counter(_kelompok_umur(j) for j in daftar_jam)
    return [{'nama': k, 'n': c.get(k, 0)} for k in URUTAN_UMUR if c.get(k, 0)]


def _jejak_24jam(sekarang):
    batas = time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(sekarang - 86400))
    rows = db.conn().execute(
        '''SELECT action, COUNT(*) AS n FROM audit_log
           WHERE created_at >= ? AND action IN ('acs_ditolak','task_kedaluwarsa','onu_reboot')
           GROUP BY action''', (batas,)).fetchall()
    out = {'acs_ditolak': 0, 'task_kedaluwarsa': 0, 'onu_reboot': 0}
    out.update({r['action']: r['n'] for r in rows})
    return out


def kumpulkan(base, auth=None, sekarang=None):
    sekarang = sekarang or time.time()
    hasil = {
        'dibuat':    time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(sekarang)),
        'modeAman':  acs_guard.mode_aman_aktif(),
        'panel':     antrean.ringkasan(sekarang),
        'operasi':   ops_lock.keadaan(),
        'jejak24j':  _jejak_24jam(sekarang),
        'nbiGalat':  None,
        'fault':     None,
        'antrean':   None,
        'peringatan': [],
    }

    try:
        faults = _get(base, '/faults/?projection=device,channel,code,message,retries,timestamp', auth)
        tasks  = _get(base, '/tasks/?projection=device,name,timestamp', auth)
    except Exception as e:
        # GenieACS mati justru saat halaman ini paling dibutuhkan: bagian milik
        # panel tetap ditampilkan, bukan seluruh halaman gagal.
        hasil['nbiGalat'] = f'Tidak bisa membaca GenieACS di {base}: {e}'
        hasil['peringatan'].append({'tingkat': 'bahaya', 'teks': hasil['nbiGalat']})
        return hasil

    # ── Fault ────────────────────────────────────────────────────
    f_jam = [_umur_jam(f.get('timestamp'), sekarang) for f in faults]
    dari_task = [f for f in faults if str(f.get('channel', '')).startswith('task_')]
    daftar = sorted(dari_task, key=lambda f: -(f.get('retries') or 0))[:BATAS_DAFTAR]
    hasil['fault'] = {
        'total':    len(faults),
        'dariTask': len(dari_task),
        'dariProvision': len(faults) - len(dari_task),
        'perKode':  _hitung(f.get('code', '?') for f in faults),
        'perModel': _hitung(ops_lock.model_dari_id(f.get('device', '')) or '?' for f in faults),
        'umur':     _umur_tabel(f_jam),
        'daftarTask': [{
            'device':  f.get('device', ''),
            'model':   ops_lock.model_dari_id(f.get('device', '')),
            'kode':    f.get('code', ''),
            'pesan':   str(f.get('message', ''))[:160],
            'retries': f.get('retries') or 0,
            'umurJam': round(_umur_jam(f.get('timestamp'), sekarang) or 0, 1),
        } for f in daftar],
    }

    # ── Antrean task ─────────────────────────────────────────────
    t_jam = [(t, _umur_jam(t.get('timestamp'), sekarang)) for t in tasks]
    bom = [(t, j) for t, j in t_jam if j is not None and j > BOM_WAKTU_JAM]
    tertua = sorted(t_jam, key=lambda x: -(x[1] or 0))[:BATAS_DAFTAR]
    hasil['antrean'] = {
        'total':    len(tasks),
        'onu':      len({t.get('device') for t in tasks}),
        'bomWaktu': len(bom),
        'perNama':  _hitung(t.get('name', '?') for t in tasks),
        'umur':     _umur_tabel(j for _, j in t_jam),
        'tertua': [{
            'device':  t.get('device', ''),
            'model':   ops_lock.model_dari_id(t.get('device', '')),
            'nama':    t.get('name', ''),
            'umurJam': round(j or 0, 1),
        } for t, j in tertua],
    }

    # ── Peringatan: sebab yang paling mungkin, dalam bahasa operator ──
    P = hasil['peringatan']
    if bom:
        tulis = sum(1 for t, _ in bom if t.get('name') in ('setParameterValues', 'addObject', 'deleteObject', 'reboot'))
        P.append({'tingkat': 'bahaya',
                  'teks': f'{len(bom)} perintah mengantre lebih dari {BOM_WAKTU_JAM} jam'
                          + (f', {tulis} di antaranya MENULIS ke ONU' if tulis else '')
                          + '. Perintah ini akan berlaku mendadak begitu ONU-nya online lagi. '
                            'Perintah panel yang dikirim sejak batas umur aktif dibatalkan '
                          + f'otomatis sesudah {antrean.KEDALUWARSA_MENIT} menit; yang lebih '
                            'lama dari itu, atau dibuat alat lain (UI GenieACS, skrip), perlu '
                            'dibersihkan manual.'})
    tak_sah = [f for f in dari_task if 'Invalid parameter path' in str(f.get('message', ''))]
    if tak_sah:
        P.append({'tingkat': 'waspada',
                  'teks': f'{len(tak_sah)} perintah gagal "Invalid parameter path". Biasanya berasal '
                          'dari tombol Summon di UI GenieACS (:3000) yang daftar parameternya memuat '
                          'baris berkoma (dua path dalam satu baris). Perintah seperti ini gagal di '
                          'SETIAP sesi ONU dan tidak akan pernah berhasil.'})
    ulang = [f for f in dari_task if (f.get('retries') or 0) >= 5]
    if ulang:
        P.append({'tingkat': 'waspada',
                  'teks': f'{len(ulang)} perintah sudah diulang ≥5 kali oleh GenieACS. Setiap '
                          'pengulangan adalah sesi tambahan bagi ONU itu.'})
    tmc = sum(1 for f in faults if f.get('code') == 'too_many_commits')
    if tmc:
        P.append({'tingkat': 'info',
                  'teks': f'{tmc} fault too_many_commits berasal dari provision GenieACS, bukan '
                          'dari perintah panel (lihat PRD §9.9).'})
    if hasil['modeAman']:
        P.append({'tingkat': 'info', 'teks': 'Mode aman aktif — semua perintah ke ONU dihentikan.'})
    return hasil


# ═══════════════════════════════════════════════════════════════════
#  Tombol "Bersihkan antrean lama"
#
#  Dijalankan pertama kali 2026-09-29 sebagai skrip: 207 task → 0, 14 fault
#  task → 0. Kini tombol di halaman ini, dengan aturan yang sama:
#
#    • DITEKAN MANUSIA, tidak pernah berjalan sendiri. Berbeda dari antrean.py
#      (yang hanya membatalkan task buatan panel), ini ikut menghapus task
#      buatan alat lain — keputusan seperti itu milik operator, bukan timer.
#    • Dua langkah: calon_bersih() menampilkan daftarnya, bersihkan() menghapus
#      HANYA id dari daftar itu yang MASIH memenuhi kriteria saat itu juga.
#      Klien tidak bisa menyuruh server menghapus task sembarang; task yang
#      baru masuk di antara "Periksa" dan "Bersihkan" tidak ikut terhapus.
#    • Cadangan JSON di data/backup/ sebelum menghapus, dan jejak di audit_log.
#
#  Menghapus dari antrean tidak mengirim apa pun ke ONU — justru mencegah
#  perintah basi sampai ke sana.
# ═══════════════════════════════════════════════════════════════════
def _alasan_bersih(t, fault, sekarang):
    jam = _umur_jam(t.get('timestamp'), sekarang)
    if fault and 'Invalid parameter path' in str(fault.get('message', '')):
        return 'cacat: Invalid parameter path — tidak akan pernah berhasil'
    if jam is not None and jam > BOM_WAKTU_JAM:
        return f'mengantre > {BOM_WAKTU_JAM} jam'
    return None


def _calon(base, auth, sekarang):
    tasks  = _get(base, '/tasks/?projection=device,name,timestamp', auth)
    faults = _get(base, '/faults/?projection=device,channel,code,message', auth)
    f_task = {str(f.get('channel', ''))[5:]: f for f in faults
              if str(f.get('channel', '')).startswith('task_')}
    out = []
    for t in tasks:
        alasan = _alasan_bersih(t, f_task.get(t.get('_id')), sekarang)
        if alasan:
            out.append((t, alasan))
    return out


def calon_bersih(base, auth=None, sekarang=None):
    """Langkah 1 — daftar task yang akan dihapus. Murni baca."""
    sekarang = sekarang or time.time()
    calon = _calon(base, auth, sekarang)
    tulis = ('setParameterValues', 'addObject', 'deleteObject', 'reboot')
    return {
        'batasJam': BOM_WAKTU_JAM,
        'jumlah':   len(calon),
        'menulis':  sum(1 for t, _ in calon if t.get('name') in tulis),
        'onu':      len({t.get('device') for t, _ in calon}),
        'perNama':  _hitung(t.get('name', '?') for t, _ in calon),
        'daftar': [{
            'id':      t.get('_id'),
            'device':  t.get('device', ''),
            'model':   ops_lock.model_dari_id(t.get('device', '')),
            'nama':    t.get('name', ''),
            'umurJam': round(_umur_jam(t.get('timestamp'), sekarang) or 0, 1),
            'alasan':  alasan,
        } for t, alasan in calon],
    }


def bersihkan(base, auth, ids, actor=None, ip='', sekarang=None):
    """Langkah 2 — hapus id terpilih yang MASIH memenuhi kriteria."""
    sekarang = sekarang or time.time()
    diminta = {str(i) for i in (ids or [])}
    # Diambil ulang dari NBI: kriteria dinilai sekarang, bukan dipercaya dari klien.
    target = [(t, a) for t, a in _calon(base, auth, sekarang) if t.get('_id') in diminta]
    hasil = {'dihapus': 0, 'gagal': [], 'dilewati': len(diminta) - len(target), 'cadangan': None}
    if not target:
        return hasil

    # Cadangan dulu: isi task (termasuk password WiFi pelanggan) hanya boleh
    # hilang dari GenieACS bila salinannya sudah tersimpan. Isi lengkap diambil
    # per ONU karena daftar di atas sengaja berprojection.
    devs = sorted({t['device'] for t, _ in target})
    lengkap = _get(base, '/tasks/?query=' + urllib.parse.quote(json.dumps(
        {'device': {'$in': devs}}), safe=''), auth)
    ids_target = {t['_id'] for t, _ in target}
    folder = os.path.join(os.path.dirname(db.DB_PATH) or '.', 'backup')
    os.makedirs(folder, exist_ok=True)
    berkas = os.path.join(folder, time.strftime('genieacs-tasks-dihapus-%Y%m%d-%H%M%S.json',
                                                time.localtime(sekarang)))
    with open(berkas, 'w', encoding='utf-8') as f:
        json.dump({'dibuat': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(sekarang)),
                   'oleh': (actor or {}).get('username', '') if isinstance(actor, dict) else '',
                   'nbi': base,
                   'tasks': [t for t in lengkap if t.get('_id') in ids_target]},
                  f, ensure_ascii=False, indent=1)
    try:
        os.chmod(berkas, 0o600)
    except Exception:
        pass
    hasil['cadangan'] = os.path.basename(berkas)

    for t, _ in target:
        try:
            antrean.hapus_task(base, auth, t['device'], t['_id'])
            hasil['dihapus'] += 1
        except Exception as e:
            # 503 "Device is in session" dan sejenisnya: dilaporkan, bisa
            # dicoba lagi dengan menekan tombol yang sama.
            hasil['gagal'].append({'id': t['_id'], 'device': t['device'], 'galat': str(e)[:120]})

    db.audit('antrean_dibersihkan',
             f"{hasil['dihapus']} task dihapus dari antrean GenieACS, {len(hasil['gagal'])} gagal, "
             f"{hasil['dilewati']} dilewati (tak lagi memenuhi kriteria) · cadangan {hasil['cadangan']}",
             actor=actor, ip=ip)
    return hasil
