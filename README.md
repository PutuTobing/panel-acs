# Panel ACS SKY TECH

Panel web untuk mengelola ONU/ONT pelanggan PT Sky Base Technology Digital lewat
GenieACS (TR-069): melihat perangkat, mengatur WAN, SSID, kredensial web ONU, dan
membuka halaman admin ONU dari satu tempat. Dilengkapi peta & topologi ODC, portal
pelanggan, akun mitra, Log aktivitas, cadangan otomatis, dan tombol Update.

Python 3 saja (tanpa pustaka tambahan) + JavaScript biasa (tanpa npm, tanpa proses build).

**Isi:** [Memasang di server](#1-memasang-di-server-ubuntu--debian) ·
[Membawa data panel lama](#2-membawa-data-dari-panel-lama) ·
[Di belakang nginx](#3-memasang-di-belakang-nginx) ·
[Memperbarui](#4-memperbarui) ·
[Menjalankan di laptop](#5-menjalankan-di-laptop) ·
[Keamanan](#keamanan) ·
[Data, cadangan & ruang disk](#data-cadangan--ruang-disk)

---

## 1. Memasang di server (Ubuntu / Debian)

**Yang dibutuhkan:** VM/server Ubuntu 22.04+ atau Debian 12+, bisa mengakses GitHub, dan
bisa menjangkau NBI GenieACS (port `7557`). Tidak perlu memasang apa pun lebih dulu.

**Satu perintah:**

```
curl -fsSL https://raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo bash
```

(Server tanpa `curl`: `wget -qO- https://raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo bash`.)

Yang dikerjakan skrip itu, berurutan:

1. memasang `git`, `python3`, `openssl`;
2. membuat akun sistem tanpa login (`skyacs`) — panel **tidak** berjalan sebagai root;
3. mengambil panel ke `/opt/panel-acs`;
4. **memilih port**: `8081`. Bila port itu sudah dipakai program lain, ia memberi tahu lalu
   memakai port kosong berikutnya (`8082`, `8083`, … sampai `8099`);
5. mendaftarkan layanan `panel-acs` (menyala sendiri saat server dinyalakan, dinyalakan
   ulang bila mati);
6. menampilkan **alamat panel** dan **kode instalasi**.

**Port tidak berubah-ubah.** Port yang terpilih disimpan di `/etc/default/panel-acs`
(`SKY_PORT=…`) dan dipakai terus — saat server dinyalakan ulang, saat panel diperbarui,
maupun saat perintah pemasang dijalankan lagi. Untuk memindahkannya dengan sengaja:
`curl -fsSL …/tools/pasang.sh | sudo SKY_PORT=8090 bash`.

**Sesudah terpasang:**

1. Buka alamat yang ditampilkan, mis. `http://10.0.0.5:8081/`.
2. Halaman instalasi muncul: isi nama, email, username, password, dan **kode instalasi**
   yang tercetak di akhir pemasangan (juga ada di `/opt/panel-acs/data/SETUP_CODE.txt`).
   Akun itu menjadi administrator pertama; kodenya sekali pakai.
3. Masuk, lalu **Settings → Koneksi ACS**: isi alamat NBI GenieACS dan tekan *Test Connection*.
4. Bila firewall `ufw` aktif: `sudo ufw allow 8081/tcp` (sesuaikan port-nya).

Skrip aman dijalankan ulang: panel yang sudah ada hanya diperbarui, port dan pengaturannya
dipertahankan, dan folder `data/` tidak disentuh.

| Keperluan | Perintah |
|---|---|
| Keadaan layanan | `sudo systemctl status panel-acs` |
| Catatan panel (langsung) | `sudo journalctl -u panel-acs -f` |
| Menyalakan ulang | `sudo systemctl restart panel-acs` |
| Melihat port & pengaturan | `cat /etc/default/panel-acs` |
| Mencopot | `sudo systemctl disable --now panel-acs && sudo rm /etc/systemd/system/panel-acs.service /etc/default/panel-acs` (folder `/opt/panel-acs` dan datanya tetap ada sampai dihapus sendiri) |

Pilihan pemasang (semuanya opsional, ditulis sebelum `bash`):

| Variabel | Arti |
|---|---|
| `SKY_PORT=8090` | paksa port tertentu (tanpa ini: 8081 atau port kosong berikutnya) |
| `SKY_DIR=/opt/panel-acs` | folder pemasangan |
| `SKY_DATA_DARI=/folder/data` | salin data panel lama — lihat bagian 2 |
| `SKY_HOST`, `SKY_PROXY`, `SKY_HTTPS`, `SKY_ORIGIN` | untuk panel di belakang nginx — lihat bagian 3 |

## 2. Membawa data dari panel lama

Semua data panel (akun, pengaturan, profil vendor, tag, master data, ODC, Log) ada di **satu
berkas**: `data/sky.db`. Memindahkan panel = memindahkan berkas itu.

Di panel lama (boleh selagi menyala) buat salinan yang utuh, lalu kirim ke server baru:

```
python backend/db.py backup                              # → data/backup/sky-<tanggal>-<jam>.db
scp data/backup/sky-<tanggal>-<jam>.db  namauser@ALAMAT-SERVER:sky.db
```

Di server baru, **sebelum** panel dipasang:

```
mkdir -p ~/panel-data && mv ~/sky.db ~/panel-data/sky.db
curl -fsSL https://raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo SKY_DATA_DARI=$HOME/panel-data bash
rm -rf ~/panel-data                                      # salinan sementara memuat hash password
```

Panel langsung memakai akun lama (tanpa halaman instalasi). Data lama **hanya** disalin
bila panel baru belum punya basis data — tidak pernah menimpa. Bila panel sudah terlanjur
terpasang, pulihkan manual seperti di `DATABASE.md` bagian *Memulihkan*.

## 3. Memasang di belakang nginx

Dipakai bila panel dibuka lewat nama domain, port 80/443, atau HTTPS. Panel tetap berjalan
di port-nya sendiri, tetapi hanya untuk komputer itu; nginx yang menerima pengunjung.

**Port yang terlibat**

| Port | Program | Dibuka ke |
|---|---|---|
| `8081` (atau `SKY_PORT`) | panel | hanya `127.0.0.1` — **jangan** dibuka di firewall |
| `80`, `443` | nginx | pengunjung panel |
| `7557` | GenieACS NBI | hanya dari server panel (panel → GenieACS); jangan ke internet |

**Langkah**

```
# 1. nginx + contoh pengaturan yang ikut repositori
sudo apt install -y nginx
sudo cp /opt/panel-acs/tools/nginx-panel-acs.conf /etc/nginx/sites-available/panel-acs
sudo nano /etc/nginx/sites-available/panel-acs      # ganti server_name; cocokkan port bila bukan 8081
sudo ln -s /etc/nginx/sites-available/panel-acs /etc/nginx/sites-enabled/panel-acs
sudo nginx -t && sudo systemctl reload nginx

# 2. beri tahu panel bahwa ia di belakang proxy (port & data tidak berubah)
curl -fsSL https://raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo SKY_HOST=127.0.0.1 SKY_PROXY=1 bash

# 3. firewall: hanya nginx yang terbuka
sudo ufw allow 'Nginx Full'
```

Langkah 2 sama dengan menyunting `/etc/default/panel-acs` (`SKY_HOST=127.0.0.1`,
`SKY_PROXY=1`) lalu `sudo systemctl restart panel-acs`. Sekarang panel terbuka di
`http://panel.domain-anda.com/`.

**HTTPS (wajib bila dibuka dari internet)** — sertifikat gratis Let's Encrypt; domain harus
sudah mengarah ke server ini:

```
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d panel.domain-anda.com        # menambah bagian 443 & pengalihan http → https
curl -fsSL https://raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo SKY_HTTPS=1 bash
```

`SKY_HTTPS=1` membuat cookie sesi hanya dikirim lewat HTTPS. **Nyalakan sesudah HTTPS
benar-benar jalan** — bila dinyalakan saat panel masih dibuka lewat `http://`, login akan
gagal terus (matikan lagi dengan memberi `#` di depan barisnya di `/etc/default/panel-acs`).

Yang diteruskan nginx ke panel (sudah ada di contoh; jangan dihapus):

| Baris | Kenapa |
|---|---|
| `proxy_pass http://127.0.0.1:8081;` | alamat panel |
| `proxy_set_header Host $http_host;` dan `X-Forwarded-Host $http_host;` | panel menolak permintaan dari situs lain dengan mencocokkan alamat ini |
| `proxy_set_header X-Real-IP $remote_addr;` dan `X-Forwarded-For $proxy_add_x_forwarded_for;` | alamat asli pengunjung untuk Log dan pembatas percobaan login |
| `proxy_read_timeout 300s;` | perintah ke ONU dan tombol Update butuh waktu |

Dalam mode proxy, halaman instalasi pertama **selalu** meminta kode instalasi (pengunjung
dari internet tidak bisa mengklaim administrator). Bila alamat di browser berbeda dari yang
diteruskan nginx (mis. ada proxy lain di depannya), daftarkan:
`SKY_ORIGIN=https://panel.domain-anda.com`.

*Tanpa domain (jaringan kantor saja):* nginx tidak wajib. Panel bisa melayani HTTPS sendiri
dengan sertifikat buatan sendiri:
`sudo -u skyacs python3 /opt/panel-acs/tools/buat_sertifikat.py && sudo systemctl restart panel-acs`
→ `https://<alamat-server>:8081/` (browser memperingatkan sampai sertifikatnya dipercaya).

*Caddy* sebagai pengganti nginx (mengurus sertifikat sendiri) — pengaturan panelnya sama
(`SKY_HOST=127.0.0.1`, `SKY_PROXY=1`, `SKY_HTTPS=1`):

```
panel.domain-anda.com {
    reverse_proxy 127.0.0.1:8081
}
```

## 4. Memperbarui

Administrator: **Settings → Tentang Sistem → Pembaruan → Periksa pembaruan**, lalu **Update**
bila ada versi baru. Panel mengambil versi terbaru dari GitHub, mencadangkan basis data
(`data/backup/sky-sebelum-update-…`), lalu menyala ulang sendiri dalam beberapa detik — tanpa
memasang ulang. Akun, pengaturan, tag, Log, dan port tidak berubah.

Pembaruan hanya maju lurus dari repositori asal (`origin`): bila berkas panel pernah diubah
langsung di server, pembaruan dibatalkan dengan penjelasan dan tidak ada yang ditimpa.
Cara lain yang setara: jalankan lagi perintah pemasang, atau
`sudo -u skyacs git -C /opt/panel-acs pull --ff-only && sudo systemctl restart panel-acs`.

Nomor versi ada di berkas `VERSION`. Kembali ke versi sebelumnya (bila pembaruan bermasalah):
lihat catatan `sistem.update` di menu Log untuk kode commit lamanya, lalu
`sudo -u skyacs git -C /opt/panel-acs reset --hard <commit-lama> && sudo systemctl restart panel-acs`;
bila skema basis data ikut berubah, pulihkan juga cadangan `sky-sebelum-update-…` (lihat `DATABASE.md`).

> Siapa pun yang bisa menulis ke repositori GitHub ini menentukan kode yang berjalan di
> server. Jaga akun GitHub-nya (2FA) seperti menjaga servernya.

## 5. Menjalankan di laptop

Untuk mencoba atau mengembangkan. Butuh Python 3.8+ dan Git:

```
git clone https://github.com/PutuTobing/panel-acs.git
cd panel-acs
python server.py          # http://localhost:8081
python server.py 8082     # bila port 8081 terpakai (panel memberi tahu)
```

Saat panel belum punya akun, alamat apa pun mengantar ke halaman instalasi. Dari komputer
tempat panel dijalankan form itu langsung bisa dipakai; dari komputer lain ia meminta **kode
instalasi** yang tercetak di terminal dan tersimpan di `data/SETUP_CODE.txt`.

Pengaturan lewat variabel lingkungan: `SKY_PORT`, `SKY_HOST` (alamat dengar, bawaan
`0.0.0.0`), `SKY_PROXY=1`, `SKY_HTTPS=1`, `SKY_ORIGIN`, `SKY_TLS_CERT` / `SKY_TLS_KEY`.

---

## Keamanan

Panel ini memegang kendali atas ONU pelanggan. Sebelum membukanya ke jaringan lain atau
ke internet, perhatikan hal berikut.

**1. Pakai HTTPS (wajib bila panel diakses dari luar server).** Di HTTP polos, password dan
cookie sesi melintas sebagai teks terang dan bisa disadap. Lihat bagian 3: nginx + certbot
untuk internet, atau sertifikat buatan sendiri (`tools/buat_sertifikat.py`) untuk jaringan kantor.

**2. Permintaan dari situs lain ditolak.** API panel hanya menerima permintaan dari halaman
panel sendiri (dicek lewat header `Sec-Fetch-Site`/`Origin` yang diisi browser).

**Pagar perintah.** Setiap perintah ke ONU melewati daftar-izin di server (`backend/acs_guard.py`):
perintah yang tidak dipakai panel (reset pabrik, unduh firmware, dst.) ditolak apa pun role-nya.
Kueri baca ke GenieACS juga dibatasi pada operator yang dipakai panel — operator yang
menjalankan kode di basis data GenieACS (`$where`, `$function`, `$regex`) ditolak.

**Teks dari luar selalu diperlakukan sebagai teks.** Nama WiFi, hostname, dan nilai lain yang
dilaporkan ONU tidak pernah dijalankan browser; ekspor CSV memberi tanda petik pada sel yang
diawali `=`, `+`, `-`, `@` supaya Excel tidak menjalankannya sebagai rumus.

**3. Header keamanan.** Halaman panel dikirim dengan Content-Security-Policy (hanya boleh
memuat kode dari panel sendiri dan dua CDN yang dikunci *integrity hash*), pelarangan
dibingkai situs lain, dan HSTS saat HTTPS.

**4. Akun.** Tidak ada akun bawaan; password di-hash (scrypt), sesi berakhir sendiri bila
tidak dipakai 30 menit, percobaan login dibatasi per akun dan per alamat, dan setiap perubahan
tercatat di Log. Berikan peran *administrator* hanya kepada yang memang mengubah pengaturan.
Hak role lain diatur administrator di Settings → Manajemen Akun → **Hak Akses Role** dan
ditegakkan di server — menyembunyikan tombol di browser hanya untuk kerapian.

| Role | Bawaan |
|---|---|
| administrator | semua |
| user (teknisi) | Dashboard, Device, Maps, semua aksi ONU; di Settings hanya *Akun Saya* dan *Tentang Sistem* |
| mitra | hanya ONU bertag miliknya, hanya Refresh dan melihat perangkat terhubung |
| pelanggan | hanya portal `/pelanggan` untuk ONU miliknya |

**Satu halaman login.** Semua role masuk lewat `/login`; sesudah masuk, staf diantar ke
panel dan pelanggan ke portalnya (`/pelanggan`).

**Portal pelanggan.** Akun ber-role *pelanggan* hanya melihat ONU yang dipasangkan kepadanya
(Settings → Manajemen Akun → isi SN): RX Power, suhu, model, perangkat terhubung, ubah
nama/password WiFi, nyala/mati SSID, restart router. Perintahnya disusun server dan melewati
pagar & kunci operasi yang sama dengan panel; seluruh API panel tertutup untuk akun ini.

**Role mitra.** Akun ber-role *mitra* terikat pada satu tag panel: username `surya` → tag
`MITRA-SURYA` (dibuat otomatis; tag yang sudah ada dipakai beserta ONU-nya). Administrator
mengatur menu sidebar (Dashboard, Device, Maps, Log), lingkup ONU (hanya ONU mitra / semua),
dan aksi (reboot, hapus, ubah WAN, SSID, Setting, Remote) yang dibuka. ONU lain tidak terbaca
dan aksi yang tidak dicentang ditolak server. Akun mitra hanya melihat dan memakai tagnya
sendiri. Administrator juga bisa mendelegasikan pengelolaan akun (membuat, mengedit,
menghapus — per role sasaran) ke role lain; akun administrator tidak pernah termasuk.

**Log aktivitas.** Menu **Log** menampilkan siapa melakukan apa: masuk/keluar, perubahan
WAN, WiFi, reboot dan refresh ONU oleh staf, mitra maupun pelanggan, perubahan akun dan
pengaturan, serta percobaan yang ditolak. Bisa disaring menurut role, nama akun, dan jenis
kejadian. Yang dicatat adalah kejadiannya — nilai password tidak pernah ditulis.

**5. Data.** `data/` berisi basis data akun & pengaturan, sertifikat HTTPS, dan cadangan —
jangan dibagikan dan jangan dimasukkan ke Git (sudah diabaikan `.gitignore`).

**6. Tombol Remote.** Halaman admin ONU dibuka lewat panel (`/onu/<id>/`) di alamat yang sama
dengan panel. Gunakan hanya untuk ONU yang Anda percayai isinya; lihat catatan keamanan
di `backend/onu_proxy.py`.

## Data, cadangan & ruang disk

Semua data panel ada di `data/sky.db` (di server: `/opt/panel-acs/data/sky.db`) dan tetap ada
saat server dimatikan, dinyalakan ulang, atau panel diperbarui. Folder itu hanya terbaca akun
`skyacs` (izin `0700`, berkas `0600`), berada di luar folder yang dilayani ke browser, dan
tidak ikut Git. Password akun tidak tersimpan — hanya hash-nya.

Panel dirancang agar **tidak memenuhi disk** walau berjalan bertahun-tahun:

| Yang tumbuh | Pembatasnya |
|---|---|
| Cadangan harian (`data/backup/`) | sekali sehari, dimampatkan (gzip), **14 terakhir** disimpan; cadangan *sebelum-update* 5 terakhir |
| Catatan Log | yang lebih tua dari **365 hari** dihapus sekali sehari (Settings → Parameter Aplikasi → *Simpan Log*; 0 = selamanya) |
| Sesi login kedaluwarsa, riwayat antrean task | dibuang otomatis |
| Disk hampir penuh | cadangan **dilewati** (dan dilaporkan) bila sisa ruang kurang dari 200 MB — cadangan tidak boleh menjadi penyebab disk penuh |

Ukuran basis data, cadangan, dan sisa ruang disk terlihat di Settings → Tentang Sistem →
**Cadangan Data**. Sebagai gambaran: basis data panel yang dipakai untuk ±2.000 ONU berukuran
kurang dari 1 MB. Satu-satunya isi yang terus bertambah adalah Log, dan itu dibatasi umur.

Cadangan di server ikut hilang bila disk servernya rusak. Dari kartu yang sama administrator
bisa mengunduh salinan **terenkripsi** (AES-256, kata sandi sendiri) untuk disimpan di luar
server — lakukan berkala. Cara membuka dan memulihkannya ada di `DATABASE.md`.

## Struktur folder

| Folder | Isi |
|---|---|
| `server.py` | peluncur; hanya menjalankan `backend/server.py` |
| `backend/` | kode server (Python): login & akun, pagar perintah ke GenieACS, kunci operasi ONU, proxy web ONU, basis data, cadangan, pembaruan |
| `frontend/` | tampilan yang dikirim ke browser: `index.html`, `pages/`, `js/`, `css/`, `maps/`, `login/`, `pelanggan/` |
| `data/` | basis data `sky.db` dan cadangannya. Tidak masuk Git |
| `tests/` | uji otomatis |
| `tools/` | `pasang.sh` (pemasang Ubuntu), `nginx-panel-acs.conf` (contoh nginx), `buat_sertifikat.py` (HTTPS), `audit_ont.js` (audit model ONT, hanya membaca), `potret.js` (uji tampilan di browser) |
| `VERSION` | nomor versi panel (dibaca server dan tombol Update) |

Browser hanya bisa mengambil isi `frontend/`. Kode server dan basis data berada di
luar folder itu, sehingga tidak bisa diunduh lewat alamat web.

## Uji

```
python tests/jalankan_semua.py           # semua uji
python tests/jalankan_semua.py oplock    # satu uji
```

Di Windows beberapa uji ditandai "khusus Linux" (izin berkas, soket) dan dilewati.

Dokumen kerja internal (rencana, ceklis audit model ONT, aturan keselamatan terhadap
GenieACS produksi) sengaja tidak disertakan di repositori ini.

---

<sub>Copyright © 2026 SKY TECH — NOC KALCER · PT Sky Base Technology Digital</sub>
