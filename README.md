# Panel ACS SKY TECH

Panel web untuk mengelola ONU/ONT pelanggan PT Sky Base Technology Digital lewat
GenieACS (TR-069): melihat perangkat, mengatur WAN, SSID, kredensial web ONU, dan
membuka halaman admin ONU dari satu tempat.

## Menjalankan

Butuh Python 3 (tanpa pustaka tambahan). Dari folder ini:

```
python server.py          # http://localhost:8081
python server.py 8082     # bila port 8081 terpakai
```

**Instalasi pertama.** Saat panel belum punya akun, halaman pertama yang muncul adalah
form instalasi: isi nama, email, username dan password. Akun itu menjadi administrator.
Form ini langsung bisa dipakai dari komputer tempat panel dijalankan. Bila dibuka dari
komputer lain, form meminta **kode instalasi** yang tercetak di terminal server dan
tersimpan di `data/SETUP_CODE.txt`. Sesudah akun pertama dibuat, halaman instalasi tidak
muncul lagi. Alamat GenieACS diatur di Settings → Koneksi ACS.

Memasang dari GitHub:

```
git clone https://github.com/PutuTobing/panel-acs.git
cd panel-acs
python server.py
```

## Struktur folder

| Folder | Isi |
|---|---|
| `server.py` | peluncur; hanya menjalankan `backend/server.py` |
| `backend/` | kode server (Python): login & akun, pagar perintah ke GenieACS, kunci operasi ONU, proxy web ONU, basis data |
| `frontend/` | tampilan yang dikirim ke browser: `index.html`, `pages/`, `js/`, `css/`, `maps/` |
| `data/` | basis data `sky.db` (akun, pengaturan, profil vendor, master data). Tidak masuk Git |
| `tests/` | uji otomatis |
| `tools/` | alat bantu, mis. `audit_ont.js` (audit model ONT, hanya membaca) |
| `PRD TUGAS/` | dokumen rencana dan ceklis audit model ONT |

Browser hanya bisa mengambil isi `frontend/`. Kode server dan basis data berada di
luar folder itu, sehingga tidak bisa diunduh lewat alamat web.

## Uji

```
python tests/jalankan_semua.py           # semua uji
python tests/jalankan_semua.py oplock    # satu uji
```

Di Windows beberapa uji ditandai "khusus Linux" (izin berkas, soket) dan dilewati.

## Data & cadangan

Semua data panel ada di `data/sky.db`. Cara mencadangkan dan memulihkan ada di
`DATABASE.md`. Aturan keselamatan untuk bekerja terhadap GenieACS produksi ada di
`CLAUDE.md` — baca sebelum menjalankan skrip apa pun terhadap ONU.
