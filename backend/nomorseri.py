"""Nomor seri GPON: dua tulisan untuk nomor yang SAMA (2026-10-13).

Nomor seri ONU GPON = 4 huruf kode vendor + 8 digit heksa, mis. `HWTCCAF31CB0` — itulah yang
tercetak di stiker perangkat, tampil di OLT, dan dipakai teknisi. Sebagian ONU (di armada ini:
Huawei HG8145V5, HG8245A, HG8245W5-6T) melaporkannya ke ACS dengan huruf vendor DITULIS DALAM
HEKSA: `48575443CAF31CB0` (48 57 54 43 = "HWTC"). GenieACS menyimpan apa yang dilaporkan,
jadi `_deviceId._SerialNumber` dan `_id` perangkat itu berbentuk heksa.

KEJADIAN: ONU baru SN HWTCCAF31CB0 sudah inform ke GenieACS tetapi "tidak ada" di panel.
Perangkatnya ada di daftar — sebagai 48575443CAF31CB0 — dan pencarian hanya mencocokkan
tulisan itu. Diukur 2026-10-13 pada 2.016 perangkat: 4 berbentuk heksa (semuanya HWTC,
dan pada keempatnya VirtualParameters.getSerialNumber = bentuk huruf hasil aturan di bawah),
1.940 sudah berbentuk huruf.

Modul ini satu-satunya tempat aturan itu di sisi server; padanannya di browser ada di
frontend/js/api.js (snLabel / snBentuk) dan keduanya dijaga uji yang sama datanya.

ATURAN — sengaja sempit, karena salah nomor seri berarti salah perangkat:
  • hanya 16 karakter heksa yang 4 byte pertamanya HURUF BESAR A–Z yang dianggap bentuk heksa;
  • tulisan lain apa pun (C-DATA 'DF1D-2412014404', serial 16 heksa biasa) dikembalikan utuh;
  • perintah ke ONU TIDAK pernah memakai nomor seri — selalu _id perangkat. Aturan ini hanya
    untuk tampilan, pencarian, dan mencari perangkat dari SN yang diketik orang.
"""

import re

_RE_HEKSA = re.compile(r'^[0-9A-Fa-f]{16}$')
_RE_LABEL = re.compile(r'^[A-Za-z]{4}[0-9A-Fa-f]{8}$')
_RE_VENDOR = re.compile(r'^[A-Z]{4}$')


def label(sn):
    """Tulisan yang dipakai manusia: '48575443CAF31CB0' → 'HWTCCAF31CB0'. Selain bentuk
    heksa GPON, nilai dikembalikan apa adanya."""
    s = str(sn or '').strip()
    if _RE_HEKSA.match(s):
        try:
            vendor = bytes.fromhex(s[:8]).decode('ascii')
        except ValueError:
            return s
        if _RE_VENDOR.match(vendor):
            return vendor + s[8:].upper()
    return s


def heksa(sn):
    """Kebalikannya: 'HWTCCAF31CB0' → '48575443CAF31CB0'. None bila bukan bentuk huruf GPON."""
    s = str(sn or '').strip()
    if not _RE_LABEL.match(s):
        return None
    return s[:4].upper().encode('ascii').hex().upper() + s[4:].upper()


def bentuk(sn):
    """Semua tulisan yang mungkin tersimpan di GenieACS untuk SN yang diketik orang —
    dipakai sebagai daftar `$in` saat mencari perangkat. Urutan: yang diketik lebih dulu."""
    s = str(sn or '').strip()
    hasil = []
    for calon in (s, s.upper(), label(s), label(s.upper()), heksa(s)):
        if calon and calon not in hasil:
            hasil.append(calon)
    return hasil
