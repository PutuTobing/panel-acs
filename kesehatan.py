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
