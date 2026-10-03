"""Jejak operasi ONU yang bisa dibaca manusia — untuk menu Log (2026-10-03).

Sebelum ini hanya REBOOT yang meninggalkan jejak (`onu_reboot`, berisi alamat NBI
mentah). Mengganti WAN, nama/password WiFi, atau akun web ONU tidak tercatat sama
sekali: bila pelanggan mengeluh "WiFi saya berubah sendiri", tidak ada cara mengetahui
siapa yang mengubahnya dan kapan.

Modul ini HANYA menerjemahkan satu permintaan NBI menjadi (aksi, deviceId, uraian);
ia tidak mengirim apa pun dan tidak menyentuh basis data. Uraian adalah potongan kalimat
yang menyambung nama akun ("BUDI <uraian>"); `{onu}` di dalamnya diganti "ONU <SN>". Pencatatannya dilakukan
server.py sesudah GenieACS menjawab, supaya hasilnya (berhasil / diantrekan / gagal)
ikut tertulis.

Aturan yang dijaga uji (tests/log.test.py):
  • NILAI parameter tidak pernah ikut — hanya NAMA. Password WiFi, password PPPoE dan
    akun web ONU lewat di sini; jejak yang memuat nilainya sama saja membocorkannya
    kepada siapa pun yang boleh membuka menu Log. Satu-satunya nilai yang dibaca adalah
    `Enable` SSID (true/false), untuk membedakan "menyalakan" dari "mematikan".
  • Perintah BACA (getParameterValues, getParameterNames) tidak dicatat: halaman detail
    mengirimnya berkali-kali dan catatan yang penting akan tenggelam.
"""

import json
import re
import urllib.parse

MAKS_NAMA = 6       # nama parameter yang ditulis per catatan; sisanya diringkas "+N lain"

_RE_WLAN   = re.compile(r'\.WLANConfiguration\.(\d+)\.(.+)$', re.I)
_RE_SANDI  = re.compile(r'passphrase|presharedkey|wepkey|password', re.I)
_RE_WAN    = re.compile(r'\.WANDevice\.|WANConnectionDevice|WANPPPConnection|WANIPConnection', re.I)
# Akun web ONU ada di tempat berbeda per vendor (User.1.Password, UserInterface.X_HW_WebUserInfo,
# DeviceInfo.X_CT-COM_TeleComAccount, X_CU_Function.Web.AdminPassword…). Yang sama: namanya
# memuat salah satu kata ini, dan letaknya di luar WLAN/WAN (keduanya dicocokkan lebih dulu).
_RE_AKUN   = re.compile(r'user|pass|admin|account', re.I)
_RE_BENAR  = re.compile(r'^(true|1|on|yes|enabled?)$', re.I)


def _daun(nama):
    """Segmen terakhir nama parameter: '….WANPPPConnection.1.Username' → 'Username'."""
    return str(nama).rsplit('.', 1)[-1]


def _ringkas(nama):
    unik = list(dict.fromkeys(nama))
    if len(unik) > MAKS_NAMA:
        return ', '.join(unik[:MAKS_NAMA]) + ', +%d lain' % (len(unik) - MAKS_NAMA)
    return ', '.join(unik)


def _uraikan_tulis(pv):
    """setParameterValues → (aksi, uraian). pv = [[nama, nilai, tipe?], ...]."""
    wifi, wan, akun, lain = {}, [], False, []
    for baris in pv if isinstance(pv, list) else []:
        if not isinstance(baris, (list, tuple)) or not baris:
            continue
        nama = str(baris[0])
        m = _RE_WLAN.search(nama)
        if m:
            slot, ekor = m.group(1), m.group(2)
            s = wifi.setdefault(slot, {'nama': False, 'sandi': False, 'aktif': None, 'lain': []})
            if ekor == 'SSID':
                s['nama'] = True
            elif _RE_SANDI.search(ekor):
                s['sandi'] = True
            elif ekor == 'Enable':
                s['aktif'] = bool(_RE_BENAR.match(str(baris[1] if len(baris) > 1 else '')))
            else:
                s['lain'].append(_daun(ekor))
        elif _RE_WAN.search(nama):
            wan.append(_daun(nama))
        elif _RE_AKUN.search(nama):
            akun = True
        else:
            lain.append(_daun(nama))

    bagian, aksi = [], None
    if wan:
        aksi = 'onu.wan'
        bagian.append('mengubah WAN (%s)' % _ringkas(wan))
    for slot in sorted(wifi, key=lambda x: int(x)):
        s = wifi[slot]
        aksi = aksi or 'onu.wifi'
        apa = []
        if s['nama'] and s['sandi']:
            apa.append('mengganti nama & password WiFi')
        elif s['nama']:
            apa.append('mengganti nama WiFi')
        elif s['sandi']:
            apa.append('mengganti password WiFi')
        if s['aktif'] is not None:
            apa.append('menyalakan WiFi' if s['aktif'] else 'mematikan WiFi')
        if s['lain']:
            apa.append('mengubah pengaturan WiFi: ' + _ringkas(s['lain']))
        bagian.append(', '.join(apa) + ' (SSID %s)' % slot)
    if akun:
        aksi = aksi or 'onu.akunweb'
        bagian.append('mengganti akun web ONU')
    if lain:
        aksi = aksi or 'onu.ubah'
        bagian.append('mengubah parameter (%s)' % _ringkas(lain))
    if not bagian:
        return None
    return aksi, '; '.join(bagian)


def _uraikan_objek(nama_task, objek):
    """addObject / deleteObject → (aksi, uraian). Hanya nama objeknya yang ditulis."""
    objek = str(objek or '').rstrip('.')
    kata = 'menambah' if nama_task == 'addobject' else 'menghapus'
    if _RE_WAN.search(objek):
        # 'WANPPPConnection' atau 'WANPPPConnection.2' — cukup untuk tahu yang mana.
        m = re.search(r'(WAN(?:PPP|IP)Connection(?:\.\d+)?|WANConnectionDevice(?:\.\d+)?)$', objek, re.I)
        return 'onu.wan', '%s koneksi WAN (%s)' % (kata, m.group(1) if m else _daun(objek))
    return 'onu.ubah', '%s objek %s' % (kata, '.'.join(objek.split('.')[-2:]) or '?')


def uraikan(metode, jalur, body):
    """Satu permintaan NBI → (aksi, deviceId, uraian), atau None bila tak perlu dicatat.

    jalur = alamat NBI tanpa awalan /api dan tanpa query, mis. '/devices/<id>/tasks'.
    Tidak pernah melempar: jejak yang gagal disusun tidak boleh menggagalkan perintahnya.
    """
    try:
        bagian = [urllib.parse.unquote(x) for x in str(jalur).split('?')[0].split('/') if x]
        if not bagian or bagian[0] != 'devices' or len(bagian) < 2:
            return None
        dev = bagian[1]
        if metode == 'DELETE' and len(bagian) == 2:
            return 'onu.hapus', dev, 'menghapus {onu} dari GenieACS'
        if metode != 'POST' or len(bagian) != 3 or bagian[2] != 'tasks':
            return None
        tugas = json.loads(body.decode('utf-8')) if body else {}
        if not isinstance(tugas, dict):
            return None
        nama = str(tugas.get('name') or '').lower()
        if nama == 'reboot':
            # Nama aksi lama dipertahankan: Kesehatan Sistem menghitung 'onu_reboot' 24 jam.
            return 'onu_reboot', dev, 'me-reboot {onu}'
        if nama == 'refreshobject':
            return 'onu.refresh', dev, 'menyegarkan data {onu}'
        if nama == 'setparametervalues':
            h = _uraikan_tulis(tugas.get('parameterValues'))
            return (h[0], dev, h[1] + ' pada {onu}') if h else None
        if nama in ('addobject', 'deleteobject'):
            h = _uraikan_objek(nama, tugas.get('objectName'))
            return h[0], dev, h[1] + ' pada {onu}'
    except Exception:
        return None
    return None


def isi_tanpa_nilai(body):
    """Ringkasan isi permintaan untuk jejak PENOLAKAN pagar: nama task dan NAMA parameter.

    Dulu 300 karakter pertama isi permintaan dicatat mentah ('isi={…}'). Perintah tulis
    yang ditolak (mis. saat Mode Aman menyala) memuat nilai yang hendak ditulis — password
    WiFi/PPPoE ikut masuk catatan, dan menu Log menampilkannya (ditemukan saat pemeriksaan
    keamanan 2026-10-04). Untuk membedakan "ditolak pagar" dari bug, nama sudah cukup."""
    if not body:
        return '(kosong)'
    try:
        o = json.loads(body.decode('utf-8'))
    except Exception:
        return 'bukan JSON (%d byte)' % len(body)
    if not isinstance(o, dict):
        return 'JSON bukan objek (%d byte)' % len(body)
    bagian = ['task=' + str(o.get('name'))[:40]]
    pv = o.get('parameterValues')
    if isinstance(pv, list):
        bagian.append('parameter: ' + (_ringkas([str(b[0])[:120] for b in pv
                                                 if isinstance(b, (list, tuple)) and b]) or '-'))
    pn = o.get('parameterNames')
    if isinstance(pn, list):
        bagian.append('parameterNames: ' + (_ringkas([str(x)[:120] for x in pn]) or '-'))
    if o.get('objectName'):
        bagian.append('objek: ' + str(o['objectName'])[:160])
    return '; '.join(bagian)


def hasil(status):
    """Kode jawaban GenieACS → kata yang ditulis di ujung catatan."""
    if status == 200:
        return 'berhasil'
    if status == 202:
        # Task tersimpan di antrean GenieACS: ONU tidak menjawab panggilan, atau
        # menjawab dengan fault. Bukan gagal final, tapi juga belum diterapkan.
        return 'diantrekan (ONU belum menjawab)'
    return 'gagal (HTTP %s)' % status
