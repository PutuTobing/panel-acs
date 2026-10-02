# Database SKY ACS — SQLite

Dokumen operasional: di mana datanya, cara backup, cara mengubah skema.

## Ringkasan

| | |
|---|---|
| Mesin | SQLite (bawaan Python — tanpa daemon, tanpa port, tanpa driver tambahan) |
| Berkas | `data/sky.db` (izin `0600`) |
| Mode jurnal | WAL — pembaca tidak pernah diblokir penulis |
| Lapisan kode | `db.py` (koneksi + migrasi), `auth.py` (akun & sesi) |

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
| `audit_log` | jejak aksi sensitif (lihat di bawah) |
| `acs_connection_settings` | koneksi NBI GenieACS + hasil Test Connection terakhir |
| `app_parameters` | pengaturan menu Parameter Aplikasi; juga `vpMapping` (Pemetaan Parameter) dan `vendorProfilWan` / `vendorProfilSecurity` (profil vendor hasil suntingan admin — kosong = pakai bawaan di `js/settings.js`) |
| `display_settings` | preferensi tampilan |
| `schema_migrations` | versi skema yang sudah diterapkan |

### Aksi yang tercatat di `audit_log`

`login.success`, `login.failed`, `login.blocked`, `account.create`,
`account.update`, `account.delete`, `access.denied`, `acs_connection.update`,
`acs_connection.test`, `app_parameters.update`, `display_settings.update`,
`system.migrate`.

`access.denied` mencatat percobaan role `user` menjangkau fungsi khusus
administrator — termasuk lewat pemanggilan endpoint langsung, bukan hanya lewat
menu.

Pelaku yang akunnya dihapus tidak menghapus jejaknya: kolom `user_id` memakai
`ON DELETE SET NULL` dan `username` tetap tersimpan sebagai teks.

## Backup

```bash
python3 db.py backup                 # → data/backup/sky-YYYYmmdd-HHMMSS.db
python3 db.py backup /mnt/cadangan   # ke folder lain
python3 db.py info                   # ukuran, versi skema, integritas, jumlah baris
```

Aman dijalankan **selagi server melayani permintaan** — memakai API backup
bawaan SQLite, bukan penyalinan berkas biasa.

> **Jangan** backup dengan `cp data/sky.db ...` selagi server hidup. Berkas
> `.db` yang sedang dipakai bisa tersalin di tengah tulisan, dan isi WAL yang
> belum ter-checkpoint tidak ikut — hasilnya salinan yang rusak atau tertinggal
> beberapa transaksi. Kalau server benar-benar berhenti, `cp` baru aman, dan
> ketiga berkas (`sky.db`, `sky.db-wal`, `sky.db-shm`) harus ikut.

Backup terjadwal, mis. tiap malam pukul 02:00 (`crontab -e`):

```
0 2 * * * cd /home/btd/panel-acs && /usr/bin/python3 db.py backup >> /var/log/sky-backup.log 2>&1
```

Memulihkan: hentikan server, salin berkas backup menjadi `data/sky.db`, hapus
`data/sky.db-wal` dan `data/sky.db-shm` bila ada, lalu jalankan server lagi.

## Mengubah skema (migrasi)

Skema **tidak pernah** diubah dengan menulis langsung ke berkas DB. Tambahkan
entri baru di daftar `MIGRATIONS` pada `db.py`:

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
