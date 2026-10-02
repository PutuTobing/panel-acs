#!/usr/bin/env python3
"""
SKY ACS — kunci operasi per-ONU, mode "ikut", dan masa istirahat.

═══ MASALAHNYA ═══

Aplikasi ini dipakai banyak orang sekaligus. Kalau A menekan Refresh pada ONU
tertentu dan B menekan Refresh pada ONU yang sama tiga detik kemudian, ONU itu
menerima DUA connection-request dan mengerjakan DUA penyusuran pohon — untuk
menghasilkan data yang sama persis. Yang bertambah hanya beban CPU-nya, dan
pelanggan di baliknya merasakannya sebagai internet melambat.

Penjaga yang sudah ada (`_adaTaskKembar` di browser) tidak menutup ini: ia hanya
melihat tab miliknya sendiri. Dua browser memeriksa bersamaan, keduanya lolos.

`server.py` adalah titik sempit tempat semua pengguna bertemu, dan sesinya
tersimpan di tabel `sessions` sehingga server tahu SIAPA peminta. Panel berjalan
sebagai satu proses `ThreadingHTTPServer`, jadi `dict` + `threading.RLock` sudah
cukup — tidak perlu Redis, tidak perlu tabel baru.

═══ TIGA ATURAN ═══

1. KUNCI PER-ONU. Satu ONU mengerjakan satu operasi pada satu waktu.

2. MODE "IKUT" (pilihan operator, bukan bawaan saya). Peminta kedua TIDAK
   ditolak — ia diikutkan pada operasi yang sedang berjalan dan menerima hasil
   yang sama. Tidak ada task tambahan yang dikirim ke ONU. Ini hanya berlaku
   bila permintaannya SAMA PERSIS; perintah yang berbeda tidak bisa "ikut"
   pada perintah lain, jadi ia ditolak dengan alasan yang jelas.

3. MASA ISTIRAHAT. Sesudah satu summon, ONU beristirahat — siapa pun yang
   meminta berikutnya. Inilah pelindung CPU yang sebenarnya: berapa pun jumlah
   pengguna dan klik, ONU tidak bisa dipaksa menyusuri pohon yang SAMA lebih
   sering dari batas ini.

   Masa istirahat SENGAJA hanya berlaku untuk summon/refresh, bukan untuk
   penulisan. Alasannya praktis: teknisi yang baru menyegarkan lalu menyimpan
   SSID tidak boleh diblokir semenit hanya karena ia menyegarkan lebih dulu.
   Beban dari penulisan dibatasi hal lain (jatah tulis per jam, §6.3 PRD),
   bukan oleh masa istirahat.

   DAN — ini ditemukan oleh uji, bukan oleh perencanaan — masa istirahat
   dihitung per (ONU, PERINTAH), bukan per ONU saja. Sebabnya: summon untuk
   model rapuh sengaja dipecah menjadi TIGA permintaan berurutan (DeviceInfo,
   WANDevice, LANDevice) karena ONU-nya hanya sanggup satu percakapan. Kalau
   masa istirahat dipasang per-ONU, permintaan kedua dan ketiga ikut terblokir
   — dan Refresh mati justru pada satu-satunya model yang paling perlu
   dilindungi.

   Per-perintah tetap menutup masalah aslinya: menekan Refresh berulang
   mengirim perintah yang SAMA PERSIS, jadi klik kedua tetap ditolak. Yang
   tidak ditutupnya: pemanggil yang sengaja mengarang objectName berbeda-beda
   untuk menghindar. Itu diterima — batas 5 operasi serentak se-armada tetap
   berlaku, dan panel sendiri hanya pernah mengirim nama yang tetap.

═══ KENAPA ANGKANYA SEGITU ═══

  TTL_OPERASI = 120 dtk   Connection-request terlama yang terukur 2026-08-02
                          adalah 60 detik (HWTC ZL-2113X, tiga kali berturut:
                          60,4 / 60,0 / 59,5). Tercepat 1,1 detik (ZTE F663NV9).
                          120 memberi ruang dua kali lipat. Tanpa kedaluwarsa,
                          satu browser yang ditutup di tengah jalan mengunci
                          ONU-nya selamanya.

  ISTIRAHAT_NORMAL = 60   Sama dengan jeda minimum connection-request di TR-069.
  ISTIRAHAT_RAPUH = 300   ZL-2113X membalas ~450 ms per RPC dan pernah senyap
                          total di tengah penyusuran pohon. Ia butuh jeda yang
                          jauh lebih longgar.

  MAKS_SERENTAK = 5       Se-aplikasi, bukan per-pengguna. Menahan kasus yang
                          jauh lebih merusak daripada dua orang bertabrakan:
                          SATU orang memilih 200 ONU lalu menekan Refresh
                          massal.
"""

import threading
import time
import urllib.parse
import uuid

TTL_OPERASI      = 120
ISTIRAHAT_NORMAL = 60
ISTIRAHAT_RAPUH  = 300
MAKS_SERENTAK    = 5

# Sama dengan MODEL_RAPUH di js/api.js. Kelak pindah ke Settings vendor (§6.4
# PRD) supaya model baru bisa ditandai tanpa mengubah kode di dua tempat.
MODEL_RAPUH = ('ZL-2113X',)

# Nama task yang dianggap "summon" — inilah yang kena masa istirahat.
TASK_SUMMON = ('refreshobject',)

_kunci     = threading.RLock()
_ops       = {}     # deviceId -> operasi yang sedang berjalan
_istirahat = {}     # (deviceId, tanda) -> epoch kapan boleh di-summon lagi
_per_id    = {}     # opId -> deviceId


# ═══════════════════════════════════════════════════════════════════
#  Model perangkat — tanpa satu pun panggilan jaringan
# ═══════════════════════════════════════════════════════════════════
def model_dari_id(device_id):
    """'HWTC-ZL%2D2113X-HWTCA90D86D8' → 'ZL-2113X'.

    ID GenieACS berbentuk OUI-ProductClass-SerialNumber, dan tanda hubung DI
    DALAM ProductClass di-persen-kodekan jadi %2D. Karena itu membelah dengan
    '-' selalu menghasilkan tepat tiga bagian, dan bagian tengahnya tinggal
    di-decode. Diperiksa terhadap data nyata: seluruh 1.797 perangkat mengikuti
    bentuk ini.

    Artinya kelas model diketahui GRATIS — tanpa bertanya ke GenieACS, tanpa
    cache yang bisa basi, tanpa menunda pemeriksaan kunci.
    """
    if not device_id:
        return ''
    bagian = str(device_id).split('-')
    if len(bagian) < 3:
        return ''
    return urllib.parse.unquote('-'.join(bagian[1:-1]))


def masa_istirahat(device_id):
    return ISTIRAHAT_RAPUH if model_dari_id(device_id) in MODEL_RAPUH else ISTIRAHAT_NORMAL


# ═══════════════════════════════════════════════════════════════════
#  Registry
# ═══════════════════════════════════════════════════════════════════
def _bersihkan(sekarang=None):
    """Buang operasi yang kedaluwarsa. Dipanggil sambil memegang _kunci."""
    sekarang = sekarang or time.time()
    basi = [d for d, op in _ops.items()
            if op['state'] == 'berjalan' and sekarang - op['mulai'] > TTL_OPERASI]
    for d in basi:
        op = _ops.pop(d, None)
        if op:
            op['state']  = 'kedaluwarsa'
            op['selesai'] = sekarang
            # Tetap disimpan sebentar agar pengikut menerima kabar, bukan
            # menggantung menunggu opId yang tiba-tiba lenyap.
            _per_id[op['opId']] = None
    for k, sampai in list(_istirahat.items()):
        if sampai <= sekarang:
            _istirahat.pop(k, None)


def _tanda(body_task):
    """Tanda pengenal isi perintah: dua permintaan dengan tanda sama boleh saling
    mengikuti, yang berbeda tidak. Sengaja kasar — nama + objek sudah cukup
    membedakan 'segarkan WANDevice' dari 'simpan SSID'."""
    if not isinstance(body_task, dict):
        return '?'
    nama = str(body_task.get('name', '')).lower()
    obj  = str(body_task.get('objectName', ''))
    return nama + '|' + obj


def mulai(device_id, pemilik, body_task):
    """Coba mulai operasi. Mengembalikan (hasil, data).

    hasil:
      'mulai'      → teruskan ke GenieACS; data = operasi
      'ikut'       → JANGAN buat task; data = operasi yang diikuti
      'istirahat'  → tolak; data = sisa detik
      'penuh'      → tolak; data = jumlah operasi berjalan
      'sibuk'      → tolak; data = operasi lain yang sedang berjalan
    """
    nama  = str((body_task or {}).get('name', '')).lower()
    tanda = _tanda(body_task)
    with _kunci:
        sekarang = time.time()
        _bersihkan(sekarang)

        berjalan = _ops.get(device_id)
        if berjalan and berjalan['state'] == 'berjalan':
            if berjalan['tanda'] == tanda:
                berjalan['pengikut'].add(pemilik)
                return 'ikut', berjalan
            return 'sibuk', berjalan

        # Masa istirahat hanya untuk summon, dan per (ONU, perintah).
        # Lihat catatan aturan 3 di atas — dipecahnya summon model rapuh
        # menjadi tiga sub-pohon yang membuat kunci per-ONU saja tidak cukup.
        if nama in TASK_SUMMON:
            sampai = _istirahat.get((device_id, tanda), 0)
            if sampai > sekarang:
                return 'istirahat', int(sampai - sekarang) + 1

        aktif = sum(1 for o in _ops.values() if o['state'] == 'berjalan')
        if aktif >= MAKS_SERENTAK:
            return 'penuh', aktif

        op = {
            'opId':     uuid.uuid4().hex[:12],
            'perangkat': device_id,
            'pemilik':  pemilik,
            'jenis':    nama,
            'tanda':    tanda,
            'mulai':    sekarang,
            'state':    'berjalan',
            'hasil':    None,
            'pengikut': set(),
        }
        _ops[device_id] = op
        _per_id[op['opId']] = device_id
        return 'mulai', op


def selesai(op_id, state='selesai', hasil=None):
    """Tutup operasi dan mulai masa istirahat ONU-nya."""
    with _kunci:
        device_id = _per_id.get(op_id)
        if not device_id:
            return None
        op = _ops.get(device_id)
        if not op or op['opId'] != op_id:
            return None
        op['state']   = state
        op['hasil']   = hasil
        op['selesai'] = time.time()
        _ops.pop(device_id, None)
        # Istirahat dihitung dari SELESAINYA, bukan dari mulainya: ONU yang
        # butuh 60 detik untuk membalas tidak boleh langsung disuruh lagi
        # begitu ia baru saja selesai.
        if op['jenis'] in TASK_SUMMON:
            _istirahat[(device_id, op['tanda'])] = time.time() + masa_istirahat(device_id)
        _selesai_simpan(op)
        return op


# Operasi yang sudah selesai disimpan sebentar supaya pengikut sempat
# mengambil hasilnya. Tanpa ini, pengikut yang menanya 1 detik terlambat
# menerima "tidak ditemukan" dan menyangka operasinya gagal.
_riwayat = {}
SIMPAN_RIWAYAT = 120


def _selesai_simpan(op):
    _riwayat[op['opId']] = op
    batas = time.time() - SIMPAN_RIWAYAT
    for k, v in list(_riwayat.items()):
        if v.get('selesai', 0) < batas:
            _riwayat.pop(k, None)
            _per_id.pop(k, None)


def status(op_id):
    with _kunci:
        _bersihkan()
        device_id = _per_id.get(op_id)
        if device_id:
            op = _ops.get(device_id)
            if op and op['opId'] == op_id:
                return op
        return _riwayat.get(op_id)


def ringkas(op):
    """Bentuk yang aman dikirim ke browser (set tidak bisa di-JSON-kan)."""
    if not op:
        return None
    return {
        'opId':     op['opId'],
        'perangkat': op['perangkat'],
        'pemilik':  op['pemilik'],
        'jenis':    op['jenis'],
        'state':    op['state'],
        'sejakDtk': int(time.time() - op['mulai']),
        'pengikut': sorted(op['pengikut']),
        'hasil':    op.get('hasil'),
    }


def keadaan():
    """Untuk halaman kesehatan / diagnosis."""
    with _kunci:
        _bersihkan()
        sekarang = time.time()
        # Ditampilkan per ONU dengan sisa TERPANJANG — operator ingin tahu
        # "kapan ONU ini boleh disegarkan lagi", bukan rincian per sub-pohon.
        istirahat = {}
        for (dev, _tanda), sampai in _istirahat.items():
            sisa = int(sampai - sekarang)
            if sisa > 0:
                istirahat[dev] = max(istirahat.get(dev, 0), sisa)
        return {
            'berjalan':     [ringkas(o) for o in _ops.values()],
            'istirahat':    istirahat,
            'maksSerentak': MAKS_SERENTAK,
        }


def reset():
    """Hanya untuk pengujian."""
    with _kunci:
        _ops.clear()
        _istirahat.clear()
        _per_id.clear()
        _riwayat.clear()
