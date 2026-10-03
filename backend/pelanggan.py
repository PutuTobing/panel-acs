#!/usr/bin/env python3
"""
SKY ACS — Portal pelanggan (2026-10-03).

Akun ber-role `pelanggan` melihat dan mengatur ONU MILIKNYA SENDIRI dari HP: nama &
password WiFi, menyalakan/mematikan SSID, reboot, refresh ringan, serta melihat RX
Power, suhu, model, dan perangkat yang terhubung. Administrator memasangkan akun ↔ SN
di Settings → Manajemen Akun (tabel akun_onu).

KENAPA SATU PROSES DENGAN PANEL, BUKAN SERVER TERPISAH
  Kunci operasi ONU (ops_lock) hidup di memori SATU proses. Portal di proses lain tidak
  akan melihat bahwa teknisi sedang memerintah ONU yang sama — dua perintah berbenturan
  adalah sebab utama perintah gagal selama ini. Perintah pelanggan karena itu melewati
  jalur yang SAMA dengan panel: acs_guard (pagar) → ops_lock (kunci) → NBI.

PAGAR (semuanya di server; halaman pelanggan hanya tampilan)
  1. Daftar-izin jalur: akun pelanggan hanya boleh memanggil /pel/*, /auth/me,
     /auth/logout, dan mengubah akunnya sendiri. /api, /config, /ops, /onu → 403.
  2. Setiap /pel/onu/<id> diperiksa: deviceId harus terpasang pada akun itu.
  3. Pelanggan TIDAK pernah mengirim nama parameter. Ia hanya mengirim {slot, nama,
     sandi, aktif}; server yang menyusun parameternya (susun_wifi) — hanya SSID,
     password, dan Enable di WLANConfiguration.<slot> yang memang ada di ONU itu.
  4. Dokumen ONU yang dikirim ke browser diambil dengan projection TETAP dan dibersihkan
     dari semua username/password, KECUALI password WiFi miliknya sendiri.
"""

import json
import re
import urllib.parse
import urllib.request

import db
import config_store

ROLE = 'pelanggan'
PREFIX = '/pel'
# Nomor WhatsApp CS untuk tombol bantuan saat perintah gagal (permintaan 2026-10-03).
CS_WHATSAPP = '6282217835764'

# Projection TETAP untuk halaman pelanggan — cukup untuk ACS.mapDevice() menampilkan
# model, RX, suhu, uptime, SSID, dan perangkat terhubung. ManagementServer, akun web ONU
# (X_*_TeleComAccount, User.*), dan seluruh sisa pohon tidak pernah ikut.
PROYEKSI = (
    '_id', '_lastInform', '_registered', '_lastBoot', '_deviceId',
    'VirtualParameters',
    'InternetGatewayDevice.DeviceInfo',
    'InternetGatewayDevice.LANDevice',
    'InternetGatewayDevice.WANDevice',
)

# Pohon WAN hanya untuk RX & IP: kredensial PPPoE dibuang.
_KUNCI_RAHASIA = re.compile(r'(user ?name|password|passwd|pwd|secret|telecomaccount|^key$)', re.I)
_VP_RAHASIA = re.compile(r'(user|pass|admin|secret|pwd)', re.I)

MAKS_SSID = 32
RE_SLOT = re.compile(r'^\d{1,2}$')


class PelangganError(ValueError):
    """Galat yang aman ditampilkan apa adanya ke pelanggan."""


# ═══════════════════════════════════════════════════════════════
#  Akun ↔ ONU
# ═══════════════════════════════════════════════════════════════
def onu_akun(user_id):
    rows = db.conn().execute(
        'SELECT device_id, sn FROM akun_onu WHERE user_id = ? ORDER BY sn', (user_id,)).fetchall()
    return [{'id': r['device_id'], 'sn': r['sn']} for r in rows]


def milik(user, device_id):
    if not user or not device_id:
        return False
    return bool(db.conn().execute('SELECT 1 FROM akun_onu WHERE user_id = ? AND device_id = ?',
                                  (user.get('id'), device_id)).fetchone())


def sn_dari_id(device_id):
    """'AA11BB-F663NV9-ZTEGC0001' → 'ZTEGC0001' (segmen terakhir deviceId GenieACS)."""
    return urllib.parse.unquote(str(device_id).rsplit('-', 1)[-1])


def atur_onu_akun(user_id, daftar, actor=None, ip=''):
    """Ganti seluruh daftar ONU milik akun. daftar = [{'id': deviceId, 'sn': sn}]."""
    u = db.conn().execute('SELECT username, role FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        raise PelangganError('Akun tidak ditemukan')
    if u['role'] != ROLE:
        raise PelangganError('ONU hanya bisa dipasangkan pada akun ber-role pelanggan')
    if not isinstance(daftar, list) or len(daftar) > 20:
        raise PelangganError('Daftar ONU tidak sah (maks 20 ONU per akun)')
    bersih = {}
    for x in daftar:
        did = (x or {}).get('id') if isinstance(x, dict) else None
        if not isinstance(did, str) or not did.strip() or len(did) > 200:
            raise PelangganError('Device ID tidak sah')
        sn = str((x or {}).get('sn') or sn_dari_id(did))[:64]
        bersih[did.strip()] = sn
    c = db.conn()
    lama = {r['device_id'] for r in c.execute('SELECT device_id FROM akun_onu WHERE user_id = ?', (user_id,))}
    c.execute('DELETE FROM akun_onu WHERE user_id = ?', (user_id,))
    for did, sn in bersih.items():
        c.execute('INSERT INTO akun_onu (user_id, device_id, sn, ditambah_oleh, ditambah_at) VALUES (?,?,?,?,?)',
                  (user_id, did, sn, (actor or {}).get('username', ''), db.now()))
    c.commit()
    baru = set(bersih)
    if baru != lama:
        db.audit('pelanggan.onu', f'akun={u["username"]} · ONU: ' + (', '.join(sorted(bersih.values())) or '(kosong)'),
                 actor, ip)
    return onu_akun(user_id)


# ═══════════════════════════════════════════════════════════════
#  Daftar-izin jalur untuk akun pelanggan
# ═══════════════════════════════════════════════════════════════
def jalur_boleh(method, path, user):
    p = path.split('?')[0]
    if p == PREFIX or p.startswith(PREFIX + '/'):
        return True
    if p in ('/auth/me', '/auth/logout', '/auth/login'):
        return True
    # Profil & password SENDIRI (auth.update_user tetap menolak role/status).
    if method in ('PATCH', 'POST') and user and p == '/auth/users/' + str(user.get('id')):
        return True
    return False


# ═══════════════════════════════════════════════════════════════
#  Dokumen ONU untuk browser pelanggan
# ═══════════════════════════════════════════════════════════════
def bersihkan_dokumen(doc):
    """Buang username/password dari dokumen, KECUALI password WiFi (WLANConfiguration)
    — itu password jaringannya sendiri dan memang perlu ia lihat/ganti."""
    def jalan(o, di_wlan):
        if isinstance(o, dict):
            keluar = {}
            for k, v in o.items():
                wlan = di_wlan or k == 'WLANConfiguration'
                if not wlan and isinstance(v, dict) and _KUNCI_RAHASIA.search(k):
                    continue
                keluar[k] = jalan(v, wlan)
            return keluar
        if isinstance(o, list):
            return [jalan(x, di_wlan) for x in o]
        return o
    doc = jalan(doc, False)
    vp = doc.get('VirtualParameters')
    if isinstance(vp, dict):
        doc['VirtualParameters'] = {k: v for k, v in vp.items() if not _VP_RAHASIA.search(k)}
    return doc


# ═══════════════════════════════════════════════════════════════
#  Penyusun perintah WiFi — pelanggan tidak pernah mengirim nama parameter
# ═══════════════════════════════════════════════════════════════
def _nilai(o):
    return o.get('_value') if isinstance(o, dict) else None


def _jalur_sandi_profil(doc):
    """Urutan jalur password menurut profil Security Setting (bila admin pernah
    menyimpannya), lalu aturan bawaan: Huawei → PreSharedKey.1.KeyPassphrase
    (HG8245A/H/W5: dua-duanya ada, profil memilih ini), lainnya → KeyPassphrase."""
    did = doc.get('_deviceId') or {}
    model = str(did.get('_ProductClass') or '').strip().lower()
    mfr = str(did.get('_Manufacturer') or '').strip().lower()
    oui = str(did.get('_OUI') or '').strip().upper()
    urut = []
    for e in (config_store.vendor_get('security') or []):
        pcs = [x.strip().lower() for x in str(e.get('productClasses') or '').split(',') if x.strip()]
        if pcs and model not in pcs:
            continue
        if e.get('oui') and str(e['oui']).strip().upper() != oui:
            continue
        if e.get('manufacturer') and str(e['manufacturer']).strip().lower() != mfr:
            continue
        if e.get('passwordPath'):
            urut.append(str(e['passwordPath']))
            break
    bawaan = (['PreSharedKey.1.KeyPassphrase', 'KeyPassphrase'] if 'huawei' in mfr
              else ['KeyPassphrase', 'PreSharedKey.1.KeyPassphrase'])
    return [p for i, p in enumerate(urut + bawaan) if p not in (urut + bawaan)[:i]]


def _ambil(o, jalur):
    for k in jalur.split('.'):
        if not isinstance(o, dict):
            return None
        o = o.get(k)
    return o


def _wpa(beacon):
    b = str(beacon or '').lower()
    return 'wpa' in b or b == '11i'


def _teks_sah(t, nama):
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in t):
        raise PelangganError(nama + ' tidak boleh memuat karakter kontrol')


def susun_wifi(doc, slot, nama=None, sandi=None, aktif=None):
    """[[path, nilai, tipe], …] untuk satu SSID. Melempar PelangganError bila ditolak."""
    if 'InternetGatewayDevice' not in doc:
        raise PelangganError('Model ONU ini belum didukung portal — hubungi customer service')
    slot = str(slot)
    if not RE_SLOT.match(slot):
        raise PelangganError('Nomor SSID tidak sah')
    wlan = _ambil(doc, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + slot)
    if not isinstance(wlan, dict) or not isinstance(wlan.get('SSID'), dict):
        raise PelangganError('SSID ini tidak ada di ONU Anda')
    base = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + slot + '.'
    params = []

    if nama is not None:
        nama = str(nama).strip()
        if not nama or len(nama) > MAKS_SSID:
            raise PelangganError('Nama WiFi 1–32 karakter')
        _teks_sah(nama, 'Nama WiFi')
        if nama != str(_nilai(wlan['SSID']) or ''):
            params.append([base + 'SSID', nama, 'xsd:string'])

    if sandi is not None and sandi != '':
        sandi = str(sandi)
        if not (8 <= len(sandi) <= 63) or any(ord(ch) < 32 or ord(ch) > 126 for ch in sandi):
            raise PelangganError('Password WiFi 8–63 karakter (huruf, angka, simbol; tanpa huruf beraksen)')
        if not _wpa(_nilai(wlan.get('BeaconType'))):
            raise PelangganError('WiFi ini tanpa password. Untuk memasang password, hubungi customer service.')
        jalur = next((p for p in _jalur_sandi_profil(doc) if isinstance(_ambil(wlan, p), dict)), None)
        if not jalur:
            raise PelangganError('Password WiFi model ini belum bisa diubah dari portal — hubungi customer service')
        params.append([base + jalur, sandi, 'xsd:string'])

    if aktif is not None:
        if not isinstance(aktif, bool):
            raise PelangganError('Status SSID harus aktif/nonaktif')
        if aktif != (str(_nilai(wlan.get('Enable'))).lower() in ('true', '1')):
            params.append([base + 'Enable', aktif, 'xsd:boolean'])

    if not params:
        raise PelangganError('Tidak ada perubahan untuk disimpan')
    return params


# ═══════════════════════════════════════════════════════════════
#  Baca NBI (GET) — untuk dokumen & nasib task milik ONU pelanggan
# ═══════════════════════════════════════════════════════════════
def nbi_get(base_url, auth_header, path, timeout=20):
    req = urllib.request.Request(base_url + path, method='GET')
    if auth_header:
        req.add_header('Authorization', auth_header)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8') or 'null')


def ambil_dokumen(base_url, auth_header, device_id):
    q = urllib.parse.quote(json.dumps({'_id': device_id}))
    pr = urllib.parse.quote(','.join(PROYEKSI))
    arr = nbi_get(base_url, auth_header, f'/devices?query={q}&projection={pr}')
    if not arr:
        raise PelangganError('ONU tidak ditemukan di ACS')
    return arr[0]


def nasib_task(base_url, auth_header, device_id, task_id):
    """'selesai' | 'gagal' | 'menunggu' — sama dengan ACS.taskOutcome di api.js."""
    q = urllib.parse.quote(json.dumps({'device': device_id}))
    tasks = nbi_get(base_url, auth_header, f'/tasks?query={q}') or []
    faults = nbi_get(base_url, auth_header, f'/faults?query={q}') or []
    if any(isinstance(f, dict) and f.get('channel') == 'task_' + str(task_id) for f in faults):
        return 'gagal'
    if not any(isinstance(t, dict) and str(t.get('_id')) == str(task_id) for t in tasks):
        return 'selesai'
    return 'menunggu'
