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

## Keamanan

Panel ini memegang kendali atas ONU pelanggan. Sebelum membukanya ke jaringan lain atau
ke internet, perhatikan hal berikut.

**1. Pakai HTTPS (wajib bila panel diakses dari luar komputer ini).** Di HTTP polos,
password dan cookie sesi melintas sebagai teks terang dan bisa disadap. Pilih salah satu:

- *Jaringan kantor:* buat sertifikat, lalu jalankan ulang panel. Panel otomatis melayani
  HTTPS bila `data/tls/cert.pem` dan `data/tls/key.pem` ada.

  ```
  python tools/buat_sertifikat.py            # butuh openssl (ikut terpasang bersama Git for Windows)
  python server.py                           # → https://<alamat>:8081/
  ```

  Sertifikatnya ditandatangani sendiri, jadi browser memperingatkan sampai sertifikat itu
  dipercaya di perangkat tersebut. Path lain bisa ditunjuk lewat `SKY_TLS_CERT` dan `SKY_TLS_KEY`.

- *Internet:* letakkan reverse proxy ber-HTTPS di depan panel. Caddy mengurus sertifikat
  Let's Encrypt sendiri:

  ```
  # Caddyfile
  panel.domain-anda.com {
      reverse_proxy 127.0.0.1:8081
  }
  ```

  lalu jalankan panel hanya untuk komputer itu sendiri, dan beri tahu bahwa ada TLS di depannya:

  ```
  SKY_HOST=127.0.0.1 SKY_HTTPS=1 python server.py
  ```

  (nginx: teruskan header Host asli dengan `proxy_set_header Host $host;`.)

**2. Permintaan dari situs lain ditolak.** API panel hanya menerima permintaan dari halaman
panel sendiri (dicek lewat header `Sec-Fetch-Site`/`Origin` yang diisi browser). Bila panel
dibuka lewat alamat yang berbeda dari yang dilihat server, daftarkan alamat itu:
`SKY_ORIGIN=https://panel.domain-anda.com`.

**3. Header keamanan.** Halaman panel dikirim dengan Content-Security-Policy (hanya boleh
memuat kode dari panel sendiri dan dua CDN yang dikunci *integrity hash*), pelarangan
dibingkai situs lain, dan HSTS saat HTTPS.

**4. Akun.** Tidak ada akun bawaan; password di-hash (scrypt), sesi berakhir sendiri bila
tidak dipakai, percobaan login dibatasi, dan setiap perubahan tercatat di audit log.
Berikan peran *administrator* hanya kepada yang memang mengubah pengaturan. Akun ber-peran
*user* di Settings hanya membuka **Akun Saya** dan **Tentang Sistem**; menu lain dibuka
administrator per menu di Settings → Manajemen Akun → **Hak Akses Role User** (ditegakkan
di server). Mengelola akun dan mengatur hak akses tetap khusus administrator.

**Portal pelanggan.** Akun ber-role *pelanggan* masuk lewat `https://<alamat>/pelanggan`
dan hanya melihat ONU yang dipasangkan administrator (Settings → Manajemen Akun → isi SN):
RX Power, suhu, model, perangkat terhubung, ubah nama/password WiFi, nyala/mati SSID,
restart router. Perintahnya disusun server dan melewati pagar & kunci operasi yang sama
dengan panel; seluruh API panel tertutup untuk akun ini. Karena pelanggan mengaksesnya dari
internet, pasang HTTPS (butir 1) sebelum membagikan alamatnya.

**5. Data.** `data/` berisi basis data akun & pengaturan, sertifikat HTTPS, dan cadangan —
jangan dibagikan dan jangan dimasukkan ke Git (sudah diabaikan `.gitignore`).

**6. Tombol Remote.** Halaman admin ONU dibuka lewat panel (`/onu/<id>/`) di alamat yang sama
dengan panel. Gunakan hanya untuk ONU yang Anda percayai isinya; lihat catatan keamanan
di `backend/onu_proxy.py`.

## Struktur folder

| Folder | Isi |
|---|---|
| `server.py` | peluncur; hanya menjalankan `backend/server.py` |
| `backend/` | kode server (Python): login & akun, pagar perintah ke GenieACS, kunci operasi ONU, proxy web ONU, basis data |
| `frontend/` | tampilan yang dikirim ke browser: `index.html`, `pages/`, `js/`, `css/`, `maps/` |
| `data/` | basis data `sky.db` (akun, pengaturan, profil vendor, master data). Tidak masuk Git |
| `tests/` | uji otomatis |
| `tools/` | alat bantu, mis. `audit_ont.js` (audit model ONT, hanya membaca) |

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
`DATABASE.md`.

Dokumen kerja internal (rencana, ceklis audit model ONT, aturan keselamatan terhadap
GenieACS produksi) sengaja tidak disertakan di repositori ini.
