#!/usr/bin/env python3
"""
SKY ACS — pagar keselamatan jalur NBI.

Semua perintah panel ke ONU lewat satu pintu: `server.py::_proxy` → GenieACS
NBI. Berkas ini adalah penjaga di pintu itu.

═══ KENAPA DI SERVER, BUKAN DI BROWSER ═══

Panel sudah punya penjaga di sisi klien (`_adaTaskKembar`, `_cekTipeNilai`,
dialog konfirmasi). Semuanya berguna, dan semuanya bisa dilewati dengan satu
perintah curl atau satu tab DevTools. Pagar yang bisa dilewati dari luar UI
bukan pagar — ia hanya dokumentasi yang kebetulan berjalan.

Karena itu aturan di sini ditegakkan terhadap **body permintaan**, bukan
terhadap fungsi mana yang memanggilnya, dan diuji dengan cara memanggil server
langsung (`tests/pagar.test.py`).

═══ APA YANG DIJAGA, DAN DARI KEJADIAN NYATA APA ═══

1. `factoryReset` / `download` / `upload` — tidak pernah dipakai panel, dan
   akibatnya tidak bisa dibatalkan. 2026-08-02 armada ini sempat kehilangan
   konfigurasi sejumlah ONU; sebabnya ternyata penulisan flash berulang, BUKAN
   factoryReset. Tapi selama nama itu bisa lewat, ia adalah satu salah-ketik
   dari bencana yang lebih besar. Ditolak mentah.

2. Penulisan ke `ManagementServer.*` — wilayah provision `inform`, bukan panel.
   Bila panel ikut menulis, dua penulis berebut nilai yang sama dan ONU
   menerima penulisan flash bergantian tanpa henti. Panel memang tidak pernah
   menulis ke sana hari ini; pagar ini menjaga agar besok juga tidak.

3. `refreshObject` dengan objectName kosong = menyusuri SELURUH pohon. Pada
   HWTC ZL-2113X (~450 ms per RPC, >1.100 leaf) itu menahan CPU-nya
   menit-menitan; SN HWTCA90D86D8 senyap total di tengah penyusuran.

4. `refreshObject` pada `ManagementServer` — parameter password di sana bersifat
   write-only: ONU membalas string kosong, cache tercemar `""`, lalu provision
   `inform` melihat nilainya berbeda dan menulis ulang ke flash. Satu Refresh =
   satu penulisan flash. Itulah write-loop yang menghabiskan siklus tulis ONU.

5. Bentuk perintah yang cacat. 2026-08-02 ditemukan 32 task dengan
   `parameterNames` berisi satu string bertanda koma (mestinya larik). Task
   seperti itu gagal di SETIAP sesi ONU selamanya dan menghasilkan
   `script.Error` — 10 fault di antaranya baru bersih setelah task-nya dihapus
   manual. Ditolak sebelum masuk antrean, bukan dibersihkan setelahnya.

6. Koleksi konfigurasi GenieACS (`provisions`, `virtualParameters`, `presets`,
   `files`). Provision adalah kode yang berjalan pada SETIAP sesi SETIAP ONU:
   satu baris keliru berbiaya 1.796 kali lipat. Perubahannya harus dilakukan
   manusia yang sadar, dengan prosedur (salin dulu, satu perubahan, uji satu
   ONU, tunggu cache 5,5 menit, verifikasi satu siklus inform). Panel tidak
   boleh menulisnya, sekarang maupun nanti. MEMBACA tetap boleh — halaman
   pemeriksa VP/Provision justru butuh itu.

═══ APA YANG SENGAJA *TIDAK* DILARANG ═══

`reboot` **boleh**. Panel memang punya tombol reboot (satuan di halaman detail,
massal di daftar perangkat) lengkap dengan dialog peringatan, dan itu perkakas
sah seorang teknisi. Yang salah bukan kemampuannya, melainkan kalau ia terjadi
tanpa jejak. Jadi reboot: dicatat ke audit, dan ikut berhenti saat mode aman.

Menulis parameter reboot per-vendor (`rebootParam` di Settings) juga boleh,
dengan alasan yang sama.

Pagar ini juga TIDAK menjaga akses langsung ke GenieACS (`:3000`) atau ke NBI
(`:7557`). Siapa pun yang bisa menjangkaunya tetap bisa mengirim apa saja.
Itu pekerjaan lain — dan mendesak, karena kedua port itu kini mendengarkan di
0.0.0.0 tanpa penyaring.
"""

import json
import os

import db

API_PREFIX = '/api'

# ─── Nama task ────────────────────────────────────────────────────
# Hanya yang benar-benar dipakai panel. Nama di luar daftar ini ditolak:
# daftar-izin, bukan daftar-tolak. Alasannya sama seperti di onu_proxy.py —
# daftar-tolak selalu ketinggalan satu langkah dari apa yang belum terpikirkan.
TASK_DIKENAL = {
    'refreshobject', 'getparametervalues', 'getparameternames',
    'setparametervalues', 'addobject', 'deleteobject', 'reboot',
}

# Ditolak mentah walaupun GenieACS mendukungnya.
TASK_TERLARANG = {'factoryreset', 'download', 'upload'}

# ─── Nama parameter ───────────────────────────────────────────────
AWALAN_SAH = ('InternetGatewayDevice.', 'Device.')

# Dicocokkan pada nama yang sudah di-lowercase.
TULIS_TERLARANG = (
    'managementserver.',        # kredensial ACS + interval = wilayah provision
    'factoryreset',
    'restorefactorydefault',
)

BACA_TERLARANG = (
    'managementserver.',        # cache tercemar "" → memicu write-loop
)

# 32 = batas yang sama dipakai GenieACS untuk jumlah commit per sesi. Lebih dari
# itu dalam satu task berarti niatnya salah, bukan besar. Penulisan terbesar
# panel hari ini (simpan SSID lengkap dengan mode keamanan) memakai ~12.
MAKS_PARAM_TULIS = 32
# Baca berbatas jauh lebih longgar. Angka 64 sempat dipasang di sini dan
# TERNYATA SALAH: `ACS.refresh()` menyebut **141 nama** dalam satu permintaan —
# itu memang disengaja, dan justru cara yang benar (satu pembacaan terarah lebih
# murah bagi ONU daripada menyusuri pohon). Diukur, bukan ditebak. 256 tetap
# menahan kasus patologis (dump seluruh pohon = ribuan nama) tanpa menghalangi
# pekerjaan sah.
MAKS_PARAM_BACA = 256

# Tabel di akar pohon yang SAH untuk addObject walau hanya dua segmen.
#
# ZTE F670L/F679L menyimpan binding port LAN di tabel akar
# InternetGatewayDevice.X_ZTE-COM_PortBinding.{i}.{WANInterface,LANInterface}.
# Koneksi yang belum punya entri memerlukan addObject pada tabel itu sendiri —
# dan aturan "minimal 3 segmen" di bawah menolaknya. Terukur 2026-09-29 pada
# ZTEGD0528061 (F670L): SETIAP pengaturan port binding ditolak
# "terlalu dekat ke akar pohon", jadi fitur itu mati total di model ini.
#
# Menambah SATU entri kosong di tabel ini tidak berbahaya — tidak seperti
# addObject di akar lain. Sengaja daftar nama persis, bukan pola: pengecualian
# yang bisa melebar diam-diam bukan pengecualian. deleteObject tidak ikut.
ADDOBJECT_AKAR_SAH = frozenset({
    'InternetGatewayDevice.X_ZTE-COM_PortBinding',
})

# Koleksi GenieACS yang tidak boleh ditulis panel (baca tetap bebas).
KOLEKSI_TERKUNCI = ('provisions', 'virtualparameters', 'presets', 'files',
                    'permissions', 'users', 'config')


# ═══════════════════════════════════════════════════════════════════
#  Mode aman
# ═══════════════════════════════════════════════════════════════════
def mode_aman_aktif():
    """Apakah seluruh penulisan ke ONU sedang dihentikan?

    Dua sumber, sengaja: env untuk keadaan darurat (panel bisa dinyalakan ulang
    dalam keadaan aman tanpa menyentuh basis data), dan basis data untuk
    sakelar di Settings serta untuk pemutus arus otomatis.
    """
    if str(os.environ.get('SKY_READONLY', '')).strip() in ('1', 'true', 'yes'):
        return True
    try:
        return str(db.kv_get('app_parameters', 'modeAman', '0')).strip() == '1'
    except Exception:
        # Basis data bermasalah bukan alasan untuk membuka pagar, tapi juga
        # bukan alasan untuk mengunci panel yang sedang dipakai. Env di atas
        # tetap menjadi jalan darurat.
        return False


def set_mode_aman(aktif, actor=None, alasan=''):
    """Nyalakan/matikan mode aman. Selalu meninggalkan jejak."""
    db.kv_set('app_parameters', 'modeAman', '1' if aktif else '0', actor=actor)
    db.audit('mode_aman_nyala' if aktif else 'mode_aman_mati',
             alasan or '(tanpa alasan)', actor=actor)


# ═══════════════════════════════════════════════════════════════════
#  Pemeriksaan
# ═══════════════════════════════════════════════════════════════════
def _tolak(status, kode, pesan):
    return {'status': status, 'kode': kode, 'pesan': pesan}


def _jalur_nbi(path):
    """'/api/devices/x%2Fy/tasks?connection_request' → '/devices/x%2Fy/tasks'."""
    p = (path or '').split('?')[0]
    if p.startswith(API_PREFIX):
        p = p[len(API_PREFIX):]
    return p or '/'


def _koleksi(jalur):
    """Segmen pertama sesudah '/'. '/devices/abc/tasks' → 'devices'."""
    bagian = [s for s in jalur.split('/') if s]
    return bagian[0].lower() if bagian else ''


def _adalah_endpoint_task(jalur):
    bagian = [s for s in jalur.split('/') if s]
    return (len(bagian) == 3 and bagian[0].lower() == 'devices'
            and bagian[2].lower() == 'tasks')


def _nama_param_sah(nama):
    """Alasan penolakan, atau None bila sah."""
    if not isinstance(nama, str) or not nama.strip():
        return 'nama parameter kosong'
    if ',' in nama:
        # Inilah bentuk 32 task cacat itu: satu string berisi banyak nama
        # dipisah koma. GenieACS memperlakukannya sebagai SATU nama parameter
        # yang tidak ada di ONU mana pun, dan task-nya gagal selamanya.
        return f'nama parameter mengandung koma (mestinya larik terpisah): {nama[:80]}'
    if not nama.startswith(AWALAN_SAH):
        return f'nama parameter harus diawali InternetGatewayDevice. atau Device.: {nama[:80]}'
    return None


def _periksa_daftar_baca(daftar):
    if daftar is None:
        # getParameterValues tanpa parameterNames = minta seluruh pohon.
        return _tolak(400, 'baca_tanpa_nama',
                      'getParameterValues wajib menyebut parameterNames')
    if not isinstance(daftar, list):
        return _tolak(400, 'bentuk_salah', 'parameterNames harus berupa larik')
    if len(daftar) > MAKS_PARAM_BACA:
        return _tolak(400, 'terlalu_banyak',
                      f'maksimum {MAKS_PARAM_BACA} parameter per pembacaan '
                      f'(diminta {len(daftar)})')
    for nama in daftar:
        alasan = _nama_param_sah(nama)
        if alasan:
            return _tolak(400, 'nama_cacat', alasan)
        rendah = nama.lower()
        for larang in BACA_TERLARANG:
            if larang in rendah:
                return _tolak(403, 'baca_terlarang',
                              f'membaca {nama} mencemari cache dengan nilai kosong '
                              f'dan memicu penulisan flash tiap sesi')
    return None


def _periksa_daftar_tulis(daftar):
    if not isinstance(daftar, list) or not daftar:
        return _tolak(400, 'bentuk_salah',
                      'parameterValues harus berupa larik dan tidak boleh kosong')
    if len(daftar) > MAKS_PARAM_TULIS:
        return _tolak(400, 'terlalu_banyak',
                      f'maksimum {MAKS_PARAM_TULIS} parameter per penulisan '
                      f'(diminta {len(daftar)})')
    for baris in daftar:
        if not isinstance(baris, list) or len(baris) < 2:
            return _tolak(400, 'bentuk_salah',
                          'tiap parameterValues harus [nama, nilai] atau [nama, nilai, tipe]')
        alasan = _nama_param_sah(baris[0])
        if alasan:
            return _tolak(400, 'nama_cacat', alasan)
        rendah = baris[0].lower()
        for larang in TULIS_TERLARANG:
            if larang in rendah:
                return _tolak(403, 'tulis_terlarang',
                              f'panel tidak boleh menulis {baris[0]} — '
                              f'itu wilayah provision GenieACS')
    return None


def _periksa_objek(nama, minimal_segmen, label):
    if not isinstance(nama, str) or not nama.strip():
        return _tolak(400, 'objek_kosong', f'{label} wajib menyebut objectName')
    # Kedalaman diperiksa LEBIH DULU supaya 'InternetGatewayDevice' saja
    # ditolak dengan alasan yang sebenarnya (terlalu dekat akar), bukan dengan
    # 'nama cacat' yang menyesatkan pembacanya.
    segmen = [s for s in nama.rstrip('.').split('.') if s]
    if len(segmen) < minimal_segmen:
        return _tolak(403, 'objek_terlalu_tinggi',
                      f'{label} pada {nama} terlalu dekat ke akar pohon — '
                      f'sebut instance yang spesifik')
    alasan = _nama_param_sah(nama)
    if alasan:
        return _tolak(400, 'nama_cacat', alasan)
    return None


def periksa_task(body):
    """Periksa isi POST /devices/{id}/tasks. None = boleh lewat."""
    if not body:
        return _tolak(400, 'body_kosong', 'perintah tanpa isi')
    try:
        data = json.loads(body.decode('utf-8') if isinstance(body, bytes) else body)
    except Exception:
        return _tolak(400, 'json_cacat', 'isi perintah bukan JSON yang sah')
    if not isinstance(data, dict):
        return _tolak(400, 'json_cacat', 'isi perintah harus objek JSON')

    nama = data.get('name')
    if not isinstance(nama, str) or not nama.strip():
        return _tolak(400, 'tanpa_nama', 'perintah tidak menyebut name')
    n = nama.strip().lower()

    if n in TASK_TERLARANG:
        return _tolak(403, 'task_terlarang',
                      f'perintah "{nama}" tidak pernah dipakai panel dan '
                      f'akibatnya tidak dapat dibatalkan')
    if n not in TASK_DIKENAL:
        return _tolak(403, 'task_asing',
                      f'perintah "{nama}" tidak dikenal panel')

    if n == 'refreshobject':
        obj = data.get('objectName')
        if not isinstance(obj, str) or not obj.strip():
            return _tolak(403, 'pohon_penuh',
                          'refreshObject tanpa objectName menyusuri seluruh pohon ONU — '
                          'sebut sub-pohon yang dibutuhkan')
        if 'managementserver' in obj.lower():
            return _tolak(403, 'baca_terlarang',
                          'menyegarkan ManagementServer mencemari cache password '
                          'dan memicu penulisan flash tiap sesi')
        # ── Batas yang jujur ──
        # Tombol Refresh mengirim objectName = 'InternetGatewayDevice' untuk
        # model non-rapuh. Itu SAMA SAJA dengan menyusuri seluruh pohon —
        # persis yang membuat SN HWTCA90D86D8 senyap. Tapi pagar bukan
        # tempatnya diperbaiki: menolaknya di sini berarti mematikan Refresh
        # untuk ~1.600 ONU seketika, tanpa ada penggantinya.
        #
        # Mempersempitnya adalah pekerjaan §5.2 PRD (summon per seksi), yang
        # perlu memastikan dulu tidak ada sub-pohon tampilan yang hilang —
        # panel juga membaca X_CT-COM_UserInfo, User.1, Firewall, dan lainnya
        # di luar tiga sub-pohon yang dipakai model rapuh.
        #
        # Jadi akar model data diizinkan, dan yang ditolak hanya bentuk yang
        # tidak punya arti sama sekali (kosong, '*', nama karangan).
        if obj.strip().rstrip('.') in ('InternetGatewayDevice', 'Device'):
            return None
        alasan = _nama_param_sah(obj)
        return _tolak(400, 'nama_cacat', alasan) if alasan else None

    if n in ('getparametervalues', 'getparameternames'):
        return _periksa_daftar_baca(data.get('parameterNames'))

    if n == 'setparametervalues':
        return _periksa_daftar_tulis(data.get('parameterValues'))

    if n == 'addobject':
        # addObject menunjuk INDUK ('...WANConnectionDevice'), jadi 3 segmen
        # sudah cukup dalam — kecuali tabel akar yang terdaftar di atas.
        nama = data.get('objectName')
        if isinstance(nama, str) and nama.rstrip('.') in ADDOBJECT_AKAR_SAH:
            return None
        return _periksa_objek(nama, 3, 'addObject')

    if n == 'deleteobject':
        # deleteObject menunjuk INSTANCE ('...WANConnectionDevice.2'). Empat
        # segmen menahan 'InternetGatewayDevice.WANDevice.1' — yang berarti
        # membuang seluruh sisi WAN sebuah ONU dalam satu perintah.
        return _periksa_objek(data.get('objectName'), 4, 'deleteObject')

    return None   # reboot: sah, tanpa argumen apa pun


def periksa(method, path, body, mode_aman=False):
    """Penjaga utama. None = teruskan ke NBI; dict = tolak.

    Urutannya disengaja: larangan mutlak lebih dulu, mode aman sesudahnya.
    Perintah yang memang tidak boleh ada harus ditolak dengan alasan yang
    sebenarnya, bukan dengan "sedang mode aman" yang menyesatkan.
    """
    metode = (method or 'GET').upper()
    jalur = _jalur_nbi(path)

    if metode in ('GET', 'HEAD', 'OPTIONS'):
        return None                      # baca tidak pernah dibatasi

    koleksi = _koleksi(jalur)
    if koleksi in KOLEKSI_TERKUNCI:
        return _tolak(403, 'koleksi_terkunci',
                      f'panel tidak boleh mengubah {koleksi} di GenieACS — '
                      f'perubahan provision/VP dilakukan manual dengan prosedur')

    # Membatalkan task atau membersihkan fault JUSTRU mengurangi beban ONU,
    # jadi tetap boleh walau mode aman menyala. Kalau tidak, satu-satunya cara
    # menghentikan perintah yang sudah telanjur mengantre ikut terkunci.
    if metode == 'DELETE' and koleksi in ('tasks', 'faults'):
        return None

    if mode_aman:
        return _tolak(503, 'mode_aman',
                      'Mode aman sedang aktif — seluruh perintah ke ONU dihentikan. '
                      'Pembacaan data tetap berjalan normal.')

    if metode == 'POST' and _adalah_endpoint_task(jalur):
        return periksa_task(body)

    return None


# ═══ Sensor kredensial pada jawaban NBI (2026-10-03) ══════════════════════════
#
# Dokumen perangkat dari GenieACS ikut membawa NILAI kredensial yang pernah dilaporkan
# ONU: password PPPoE pelanggan (VP pppoePassword), password akun web ONU (Super/User
# Admin), password ConnectionRequest/ACS di ManagementServer, dst. Panel TIDAK PERNAH
# menampilkannya — tetapi dulu semuanya tetap terkirim ke setiap browser yang login,
# termasuk akun peran "user", tersimpan di memori tab dan alat developer browser.
#
# Maka nilainya dikosongkan di sini, sebelum jawaban meninggalkan server. Simpulnya
# tetap ada (tipe, writable, timestamp), jadi pemeriksaan "apakah ONU ini punya leaf
# password?" (mis. _settCekAda untuk ZL-2113X) tetap bekerja.
#
# SENGAJA TIDAK disensor: KeyPassphrase / PreSharedKey — password WiFi yang memang
# ditampilkan kartu SSID (di balik tombol mata) untuk membantu pelanggan yang lupa.
# Daftar task yang mengantre (parameterValues [path, nilai, tipe]) ikut disensor:
# isinya bisa password yang diketik operator lain.
import re as _re

_RAHASIA = _re.compile(r'(?:password|passwd|pwd|secret)$|^superadmin$', _re.I)
_MUNGKIN_RAHASIA = _re.compile(rb'(?i)password|passwd|pwd|secret|superadmin')


def _sensor(o):
    n = 0
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, dict) and '_value' in v and _RAHASIA.search(k):
                if v['_value'] not in ('', None):
                    v['_value'] = ''
                    n += 1
            elif isinstance(v, (dict, list)):
                n += _sensor(v)
    elif isinstance(o, list):
        if (len(o) >= 2 and isinstance(o[0], str) and isinstance(o[1], str) and o[1]
                and _RAHASIA.search(o[0].rsplit('.', 1)[-1])):
            o[1] = ''
            n += 1
        for v in o:
            if isinstance(v, (dict, list)):
                n += _sensor(v)
    return n


def sensor_kredensial(data):
    """bytes JSON dari NBI → bytes dengan nilai kredensial dikosongkan.

    Jawaban tanpa nama kunci yang mencurigakan (mis. daftar perangkat berproyeksi
    ringan) dikembalikan apa adanya tanpa di-parse — murah untuk 1.800 ONU."""
    if not data or not _MUNGKIN_RAHASIA.search(data):
        return data
    try:
        obj = json.loads(data)
    except ValueError:
        return data
    if not _sensor(obj):
        return data
    return json.dumps(obj, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
