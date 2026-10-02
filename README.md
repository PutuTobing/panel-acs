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

Akun admin pertama dibuat otomatis dengan password acak yang ditulis sekali ke
`data/FIRST_LOGIN.txt`. Alamat GenieACS diatur di Settings → Koneksi ACS.

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
