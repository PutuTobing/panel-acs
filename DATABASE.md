# Database SKY ACS — SQLite

Dokumen operasional: di mana datanya, cara backup, cara mengubah skema.

## Ringkasan

| | |
|---|---|
| Mesin | SQLite (bawaan Python — tanpa daemon, tanpa port, tanpa driver tambahan) |
| Berkas | `data/sky.db` (izin `0600`) |
| Mode jurnal | WAL — pembaca tidak pernah diblokir penulis |
| Lapisan kode | `backend/db.py` (koneksi + migrasi), `backend/auth.py` (akun & sesi) |

### Kenapa SQLite, bukan MySQL/MongoDB

Beban panel ini kecil — ribuan baris, tulisan jarang, **satu proses**. Diukur di
mesin ini dengan 2.500 pelanggan: baca semua pin peta **5,6 ms**, cari 1
pelanggan **0,13 ms**, seluruh basis data **740 KB**.

Menambah server database berarti menambah daemon yang bisa mati atau kehabisan
memori di mesin yang juga menjalankan GenieACS untuk ~1.742 ONU live, menambah
port yang harus dijaga, dan menambah ritual backup — tanpa satu pun keunggulan
MySQL (replikasi, banyak mesin penulis, ratusan tulisan/detik) yang benar-benar
terpakai di sini.

MongoDB pada port 27017 di mesin ini **milik GenieACS**. Jangan menaruh data
panel di sana: data kita akan bercampur dengan data yang ditulis dan dihapus
GenieACS.

**Kapan ini perlu ditinjau ulang:** panel dijalankan multi-proses/worker, ada
mesin lain yang ikut menulis, atau tulisan menembus ratusan per detik. Selama
tidak, SQLite masih jauh dari batasnya.

## Tabel

| Tabel | Isi |
|---|---|
| `users` | akun: nama, username, email, no. HP, role, status, hash password, timestamp |
| `sessions` | sesi login: token, IP, user-agent, kedaluwarsa |
| `audit_log` | jejak aksi (lihat di bawah) — sumber menu **Log**. Kolom `role` = role pelaku SAAT kejadian |
| `acs_connection_settings` | koneksi NBI GenieACS + hasil Test Connection terakhir |
| `app_parameters` | pengaturan menu Parameter Aplikasi; juga `vpMapping` (Pemetaan Parameter), `vendorProfilWan` / `vendorProfilSecurity` (profil vendor hasil suntingan admin — kosong = pakai bawaan di `js/settings.js`), dan `izinRole` (menu Settings yang dibuka untuk role user — kosong = bawaan *Akun Saya + Tentang Sistem*) |
| `display_settings` | preferensi tampilan |
| `akun_onu` | ONU milik akun ber-role pelanggan (portal `/pelanggan`, `backend/pelanggan.py`) |
| `akun_tag` | tag milik akun ber-role mitra (satu akun → satu tag; `backend/mitra.py`). "ONU mitra" = ONU bertag itu |
| `tag`, `tag_onu` | tag panel untuk ONU (mis. MITRA-SURYA) dan pasangannya dengan deviceId — hanya di panel, tidak dikirim ke GenieACS (`backend/tag.py`) |
| `schema_migrations` | versi skema yang sudah diterapkan |

### Aksi yang tercatat di `audit_log`

`login.success`, `login.failed`, `login.blocked`, `account.create`,
`account.update`, `account.delete`, `access.denied`, `acs_connection.update`,
`acs_connection.test`, `app_parameters.update`, `display_settings.update`,
`izin_role.update`, `tag.buat`, `tag.ubah`, `tag.pasang`, `tag.lepas`, `tag.hapus`, `pelanggan.onu`,
`logout`, `system.setup`, `system.migrate`, `cadangan.otomatis`, `cadangan.unduh`,
`sistem.update`, `sistem.update.gagal`, `mitra.tag`.

`izinRole` (di `app_parameters`) kini memuat izin role **user** dan **mitra**: menu Settings,
`buatTag`, dan izin panel — `menuDashboard`, `menuDevice`, `menuMaps`, `menuLog`, `onuSemua`,
`logSemua`, `aksiReboot`, `aksiHapus`, `aksiWan`, `aksiSsid`, `aksiSetting`, `aksiRemote`. Isinya
bertanda `_v: 2`; daftar lama tanpa tanda itu dibaca dengan izin panel bawaan ditambahkan, supaya
role user tidak kehilangan apa pun saat panel diperbarui.

Operasi ONU (siapa pun pelakunya — administrator, user, atau pelanggan lewat portal):
`onu.wan`, `onu.wifi`, `onu.akunweb`, `onu.ubah`, `onu.refresh`, `onu.hapus`, `onu_reboot`.
Keterangannya berupa kalimat + SN + hasil, mis.
`mengganti password WiFi (SSID 1) pada ONU ZTEG… — berhasil`, dan ditulis sesudah GenieACS
menjawab (`berhasil` / `diantrekan (ONU belum menjawab)` / `gagal (HTTP n)`). Disusun
`backend/logonu.py`. **Nilai tidak pernah dicatat** — hanya nama parameter; password WiFi,
PPPoE, dan akun web ONU tidak ada di basis data ini. Perintah baca tidak dicatat, dan refresh
beruntun pada ONU yang sama dicatat sekali per menit per akun.
(`pelanggan.wifi`, `pelanggan.reboot`, `pelanggan.refresh` hanya ada pada catatan lama —
sejak 2026-10-03 pelanggan memakai nama aksi `onu.*` yang sama, dibedakan kolom `role`.)

Penolakan pagar keselamatan (`acs_ditolak`) mencatat nama task dan nama parameter yang
ditolak — juga tanpa nilai. Catatan penolakan sebelum 2026-10-04 menyimpan potongan mentah isi
permintaan (`… · isi={…}`), yang bisa memuat password yang hendak ditulis: isinya **tidak
ditampilkan** di menu Log, ekspor CSV, maupun API, tetapi masih ada di berkas basis data. Untuk
menghapusnya permanen (panel dimatikan dulu):
`sqlite3 data/sky.db "UPDATE audit_log SET detail = substr(detail, 1, instr(detail, ' · isi=') - 1) WHERE action='acs_ditolak' AND instr(detail, ' · isi=') > 0"`.

Menu **Log** (khusus administrator, `GET /auth/audit`) menyaring catatan ini menurut role,
nama akun, jenis kejadian, dan kata cari. Login gagal pada akun yang ada dicatat atas nama
akun itu; username karangan hanya tertulis di keterangan. Catatan tidak dihapus otomatis.

`access.denied` mencatat percobaan role `user` menjangkau fungsi khusus
administrator — termasuk lewat pemanggilan endpoint langsung, bukan hanya lewat
menu.

Pelaku yang akunnya dihapus tidak menghapus jejaknya: kolom `user_id` memakai
`ON DELETE SET NULL` dan `username` tetap tersimpan sebagai teks.

## Backup

### Otomatis (sejak 2026-10-03)

Selama panel menyala, `backend/cadangan.py` menyalin basis data **sekali sehari** ke
`data/backup/sky-otomatis-<tanggal>-<jam>.db` dan menyimpan **14 terakhir** (yang lebih lama
dihapus; berkas lain di folder itu tidak disentuh). Cadangan pertama dibuat begitu panel
dinyalakan bila yang terakhir sudah berumur lebih dari sehari. Keadaannya terlihat di
Settings → Tentang Sistem → **Cadangan Data**, dan tiap cadangan tercatat di menu Log
(`cadangan.otomatis`).

Tombol Update (Settings → Tentang Sistem → Pembaruan) membuat cadangan
`sky-sebelum-update-<tanggal>-<jam>.db` sebelum mengubah berkas panel; 5 terakhir disimpan.

Setiap cadangan **tidak memuat sesi login** (tabel `sessions` dikosongkan pada salinannya):
memulihkan cadangan berarti semua orang login ulang. Berkas berizin `0600` di folder `0700`.

### Salinan di luar server — terenkripsi

Cadangan di `data/backup` ikut hilang bila disk servernya rusak. Administrator bisa mengunduh
salinan terenkripsi dari Settings → Tentang Sistem → **Unduh cadangan terenkripsi**:

- dienkripsi **AES-256** (CBC) dengan kunci turunan PBKDF2-SHA256 600.000 putaran dari kata
  sandi yang diketik saat mengunduh — dikerjakan program `openssl` di server;
- kata sandi itu **tidak disimpan** di server. Bila lupa, berkasnya tidak bisa dibuka;
- password akun administrator diminta lagi sebelum unduhan diberikan, dan tercatat di Log
  (`cadangan.unduh`).

Membuka berkasnya (di komputer mana pun yang punya `openssl`; perintah yang sama ditampilkan
panel sesudah unduhan):

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in sky-cadangan-XXXX.db.enc -out sky.db
```

`openssl` menanyakan kata sandinya. Hasilnya `sky.db` biasa — pulihkan seperti di bawah.

> **Kenapa `data/sky.db` sendiri tidak dienkripsi?** Agar panel bisa menyala sendiri sesudah
> listrik padam, kunci pembukanya harus ada di disk yang sama — siapa pun yang bisa membaca
> berkasnya juga bisa membaca kuncinya. Yang melindungi berkas di server adalah izin `0600`
> (hanya akun yang menjalankan panel) dan, bila diinginkan, enkripsi disk milik sistem operasi.
> Password akun tidak pernah tersimpan — hanya hash scrypt-nya.

### Manual

```bash
python3 backend/db.py backup                 # → data/backup/sky-YYYYmmdd-HHMMSS.db
python3 backend/db.py backup /mnt/cadangan   # ke folder lain
python3 backend/db.py info                   # ukuran, versi skema, integritas, jumlah baris
```

Aman dijalankan **selagi server melayani permintaan** — memakai API backup
bawaan SQLite, bukan penyalinan berkas biasa.

> **Jangan** backup dengan `cp data/sky.db ...` selagi server hidup. Berkas
> `.db` yang sedang dipakai bisa tersalin di tengah tulisan, dan isi WAL yang
> belum ter-checkpoint tidak ikut — hasilnya salinan yang rusak atau tertinggal
> beberapa transaksi. Kalau server benar-benar berhenti, `cp` baru aman, dan
> ketiga berkas (`sky.db`, `sky.db-wal`, `sky.db-shm`) harus ikut.

Cadangan manual tidak dipangkas otomatis dan — berbeda dari cadangan otomatis — masih
memuat sesi login; hapus sendiri bila sudah tidak diperlukan.

### Memulihkan

Hentikan server, salin berkas cadangan menjadi `data/sky.db`, hapus `data/sky.db-wal` dan
`data/sky.db-shm` bila ada, lalu jalankan server lagi. Bila cadangannya dari versi panel yang
lebih lama, migrasi skema berjalan sendiri saat server menyala.

## Mengubah skema (migrasi)

Skema **tidak pernah** diubah dengan menulis langsung ke berkas DB. Tambahkan
entri baru di daftar `MIGRATIONS` pada `backend/db.py`:

```python
MIGRATIONS = [
    (1, 'skema awal: ...', '''...'''),
    (2, 'tambah tabel pelanggan', '''
        CREATE TABLE pelanggan ( ... );
    '''),
]
```

Migrasi dijalankan otomatis saat server start, berurutan, masing-masing dalam
satu transaksi, dan dicatat di `schema_migrations` sehingga tiap versi jalan
tepat sekali.

> **Aturan yang tidak boleh dilanggar:** migrasi yang sudah dirilis tidak boleh
> diubah isinya, dan nomor versinya tidak boleh dipakai ulang. Mesin yang sudah
> menerapkan versi itu tidak akan pernah menjalankannya lagi — perubahannya
> hanya akan muncul di instalasi baru, dan kedua mesin diam-diam berbeda skema.
> Selalu tambah versi baru.

## Migrasi dari `users.json` (sudah dijalankan)

Versi lama menyimpan akun di `data/users.json`. Saat pertama kali berjalan di
atas SQLite, `auth.import_legacy_users()` memindahkan seluruh akun beserta hash
passwordnya — password lama tetap berlaku, `id` dan `createdAt` dipertahankan.

Berkas lama diganti nama menjadi `users.json.imported`, **tidak dihapus**, agar
datanya masih bisa diperiksa bila ada yang janggal. Impor hanya berjalan bila
tabel `users` masih kosong, jadi tidak mungkin menggandakan akun.

## Catatan keamanan

`sky.db` memuat hash password (scrypt) → izinnya `0600`, begitu pula berkas
backup. Ini melindungi dari user lain **di server yang sama**.

Yang **tidak** ditutup oleh database: panel masih dilayani lewat HTTP polos,
jadi password dan cookie sesi melintas sebagai teks terang di jaringan. Hanya
TLS yang menutup itu — pasang nginx/Caddy di depan panel lalu jalankan dengan
`SKY_HTTPS=1`.
