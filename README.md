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

**Instalasi pertama.** Basis data akun tidak ikut repositori. Saat panel belum punya akun,
alamat apa pun mengantar ke `/login` yang menampilkan form instalasi: isi nama, email, username dan password. Akun itu menjadi administrator.
Form ini langsung bisa dipakai dari komputer tempat panel dijalankan. Bila dibuka dari
komputer lain, form meminta **kode instalasi** yang tercetak di terminal server dan
tersimpan di `data/SETUP_CODE.txt`. Sesudah akun pertama dibuat, halaman instalasi tidak
muncul lagi. Alamat GenieACS diatur di Settings → Koneksi ACS.

## Memasang di server (Ubuntu / Debian)

Satu perintah di server atau VM yang baru:

```
curl -fsSL https://raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo bash
```

Skrip itu memasang `git`, `python3` dan `openssl`, membuat akun sistem tanpa login (`skyacs`)
— panel tidak berjalan sebagai root —, mengambil panel ke `/opt/panel-acs`, dan mendaftarkannya
sebagai layanan `panel-acs` yang menyala sendiri saat server dinyalakan. Di akhir ia
menampilkan alamat panel dan **kode instalasi** untuk membuat administrator pertama.

Pilihan lewat variabel, mis. port lain atau membawa data panel lama (matikan panel lama dulu):

```
curl -fsSL …/tools/pasang.sh | sudo SKY_PORT=8082 bash
curl -fsSL …/tools/pasang.sh | sudo SKY_DATA_DARI=/home/btd/panel-acs/data bash
```

Aman dijalankan ulang: panel yang sudah ada hanya diperbarui dan folder `data/` tidak disentuh.

| Keperluan | Perintah |
|---|---|
| Keadaan layanan | `sudo systemctl status panel-acs` |
| Catatan panel | `sudo journalctl -u panel-acs -f` |
| Menyalakan ulang | `sudo systemctl restart panel-acs` |
| Mencopot | `sudo systemctl disable --now panel-acs && sudo rm /etc/systemd/system/panel-acs.service` (folder `/opt/panel-acs` dan datanya tetap ada sampai dihapus sendiri) |

Memasang manual (laptop, atau sistem tanpa systemd):

```
git clone https://github.com/PutuTobing/panel-acs.git
cd panel-acs
python server.py
```

## Memperbarui

Administrator: **Settings → Tentang Sistem → Pembaruan → Periksa pembaruan**, lalu **Update**
bila ada versi baru. Panel mengambil versi terbaru dari GitHub, mencadangkan basis data
(`data/backup/sky-sebelum-update-…`), lalu menyala ulang sendiri dalam beberapa detik — tanpa
memasang ulang. Akun, pengaturan, tag dan Log tidak berubah.

Pembaruan hanya maju lurus dari repositori asal (`origin`): bila berkas panel pernah diubah
langsung di server, pembaruan dibatalkan dengan penjelasan dan tidak ada yang ditimpa.
Cara manual yang setara: `sudo -u skyacs git -C /opt/panel-acs pull --ff-only && sudo systemctl restart panel-acs`.

Nomor versi ada di berkas `VERSION`. Kembali ke versi sebelumnya (bila pembaruan bermasalah):
lihat catatan `sistem.update` di menu Log untuk kode commit lamanya, lalu
`sudo -u skyacs git -C /opt/panel-acs reset --hard <commit-lama> && sudo systemctl restart panel-acs`;
bila skema basis data ikut berubah, pulihkan juga cadangan `sky-sebelum-update-…` (lihat `DATABASE.md`).

> Siapa pun yang bisa menulis ke repositori GitHub ini menentukan kode yang berjalan di
> server. Jaga akun GitHub-nya (2FA) seperti menjaga servernya.

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

**Satu halaman login.** Semua role masuk lewat `https://<alamat>/login`; sesudah masuk,
staf diantar ke panel dan pelanggan ke portalnya (`/pelanggan`). Logout kembali ke `/login`.

**Portal pelanggan.** Akun ber-role *pelanggan* hanya melihat ONU yang dipasangkan administrator (Settings → Manajemen Akun → isi SN):
RX Power, suhu, model, perangkat terhubung, ubah nama/password WiFi, nyala/mati SSID,
restart router. Perintahnya disusun server dan melewati pagar & kunci operasi yang sama
dengan panel; seluruh API panel tertutup untuk akun ini. Karena pelanggan mengaksesnya dari
internet, pasang HTTPS (butir 1) sebelum membagikan alamatnya.

**Role mitra.** Akun ber-role *mitra* terikat pada satu tag panel: username `surya` → tag
`MITRA-SURYA` (dibuat otomatis; tag yang sudah ada dipakai beserta ONU-nya). Bawaannya mitra
hanya melihat ONU bertag miliknya di Dashboard dan Device, dan hanya bisa Refresh serta melihat
perangkat terhubung. Administrator mengatur sisanya di Settings → Manajemen Akun → **Hak Akses
Role** (pilih role User atau Mitra): menu sidebar (Dashboard, Device, Maps, Log), lingkup ONU
(hanya ONU mitra / semua), aksi (reboot, hapus, ubah WAN, SSID, Setting, Remote), dan menu
Settings. Semuanya ditegakkan server: ONU lain tidak terbaca dan aksi yang tidak dicentang ditolak.

**Log aktivitas.** Menu **Log** (administrator, atau role yang diberi izin — bisa dibatasi ke aktivitas akunnya sendiri) menampilkan siapa melakukan apa:
masuk/keluar, perubahan WAN, WiFi, reboot dan refresh ONU oleh staf maupun pelanggan,
perubahan akun dan pengaturan, serta percobaan yang ditolak. Bisa disaring menurut role
(ALL, administrator, user, pelanggan), nama akun, dan jenis kejadian. Yang dicatat adalah
kejadiannya — nilai password tidak pernah ditulis.

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
| `tools/` | alat bantu: `pasang.sh` (pemasang Ubuntu), `buat_sertifikat.py` (HTTPS), `audit_ont.js` (audit model ONT, hanya membaca) |
| `VERSION` | nomor versi panel (dibaca server dan tombol Update) |

Browser hanya bisa mengambil isi `frontend/`. Kode server dan basis data berada di
luar folder itu, sehingga tidak bisa diunduh lewat alamat web.

## Uji

```
python tests/jalankan_semua.py           # semua uji
python tests/jalankan_semua.py oplock    # satu uji
```

Di Windows beberapa uji ditandai "khusus Linux" (izin berkas, soket) dan dilewati.

## Data & cadangan

Semua data panel ada di `data/sky.db` dan tetap ada saat server dimatikan atau dinyalakan
ulang. Panel mencadangkannya sendiri sekali sehari ke `data/backup/` (14 terakhir disimpan),
dan administrator bisa mengunduh salinan **terenkripsi** (AES-256, kata sandi sendiri) dari
Settings → Tentang Sistem → Cadangan Data untuk disimpan di luar server. Cara membuka dan
memulihkannya ada di `DATABASE.md`.

Dokumen kerja internal (rencana, ceklis audit model ONT, aturan keselamatan terhadap
GenieACS produksi) sengaja tidak disertakan di repositori ini.
