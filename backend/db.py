#!/usr/bin/env python3
"""
SKY ACS — lapisan database (SQLite).

Dipakai auth.py dan server.py. Dipisah agar bisa diuji tanpa menjalankan server.

KEPUTUSAN DESAIN (dan alasannya):

  • SQLite, bukan MySQL/Postgres.
    Beban panel ini kecil (ribuan baris, tulisan jarang, SATU proses) dan
    sqlite3 sudah ada di dalam Python — nol daemon, nol port, nol driver.
    Menambah server database berarti menambah proses yang bisa mati/OOM di
    mesin yang juga menjalankan GenieACS untuk ~1742 ONU live, tanpa satu pun
    manfaatnya terpakai. Backup = salin satu berkas.

  • Koneksi THREAD-LOCAL, bukan satu koneksi global.
    server.py memakai ThreadingHTTPServer: tiap permintaan dilayani thread
    berbeda. Objek koneksi sqlite3 tidak aman dipakai lintas thread (default
    check_same_thread=True akan melempar ProgrammingError). Satu koneksi per
    thread menutup ini tanpa mengunci apa pun.

  • journal_mode=WAL.
    Tanpa WAL, satu penulis MEMBLOKIR semua pembaca. Dengan WAL, pembaca tidak
    pernah diblokir penulis — persis pola panel ini: banyak baca, sesekali
    tulis. WAL bersifat persisten pada berkas DB (cukup disetel sekali), tapi
    tetap disetel tiap koneksi agar DB baru/di-restore ikut benar.

  • busy_timeout.
    SQLite mengizinkan banyak pembaca tapi hanya SATU penulis pada satu waktu.
    Tanpa busy_timeout, tulisan yang bertabrakan langsung gagal
    'database is locked'. Dengan timeout, ia menunggu sebentar lalu berhasil.

  • foreign_keys=ON.
    SQLite mematikan penegakan foreign key SECARA DEFAULT (demi kompatibilitas
    mundur), dan setelannya per-koneksi — bukan per-database. Jadi kalau tidak
    disetel di tiap koneksi, ON DELETE CASCADE pada sessions/audit_log diam-diam
    tidak berjalan dan baris yatim menumpuk.

  • Migrasi berversi, bukan CREATE TABLE tersebar.
    Skema berubah lewat daftar MIGRATIONS yang dijalankan berurutan dan dicatat
    di tabel schema_migrations. Tiap migrasi jalan tepat sekali, dalam satu
    transaksi, dan urutannya sama di mesin mana pun.
"""

import os
import sqlite3
import threading
import time

DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # akar proyek (induk backend/)
DATA_DIR = os.path.join(DIRECTORY, 'data')
DB_NAME = 'sky.db'

# Bisa ditimpa tes (lihat set_path) agar tidak menyentuh DB produksi.
DB_PATH = os.path.join(DATA_DIR, DB_NAME)

_local = threading.local()
_init_lock = threading.RLock()
_initialized = set()          # DB_PATH yang migrasinya sudah dijalankan


def set_path(path):
    """Arahkan lapisan DB ke berkas lain (dipakai tes).

    Koneksi thread-local yang lama ikut ditutup — kalau tidak, thread yang
    sudah punya koneksi akan tetap menulis ke DB lama tanpa suara.
    """
    global DB_PATH
    close()
    with _init_lock:
        _initialized.discard(DB_PATH)
        DB_PATH = path
    return DB_PATH


def close():
    """Tutup koneksi milik thread ini (bila ada)."""
    c = getattr(_local, 'conn', None)
    if c is not None:
        try:
            c.close()
        except Exception:
            pass
    _local.conn = None
    _local.path = None


def conn():
    """Koneksi milik thread ini, sudah dimigrasi dan siap pakai."""
    c = getattr(_local, 'conn', None)
    # Bila DB_PATH berubah (mis. oleh tes), koneksi lama tidak boleh dipakai lagi.
    if c is not None and getattr(_local, 'path', None) == DB_PATH:
        return c
    close()

    _ensure_dir()
    c = sqlite3.connect(DB_PATH, timeout=10.0)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA journal_mode=WAL')
    c.execute('PRAGMA foreign_keys=ON')       # per-koneksi — wajib, lihat docstring
    c.execute('PRAGMA busy_timeout=5000')
    c.execute('PRAGMA synchronous=NORMAL')    # aman di WAL, jauh lebih cepat dari FULL
    _local.conn = c
    _local.path = DB_PATH

    _migrate(c)
    return c


def _ensure_dir():
    d = os.path.dirname(DB_PATH)
    if d:
        os.makedirs(d, exist_ok=True)


def now():
    """Stempel waktu ISO lokal — format sama dengan data lama di users.json."""
    return time.strftime('%Y-%m-%dT%H:%M:%S')


# ═══════════════════════════════════════════════════════════════
#  Migrasi skema
# ═══════════════════════════════════════════════════════════════
# Tiap entri: (versi, deskripsi, SQL). Versi WAJIB naik dan TIDAK BOLEH diubah
# setelah dirilis — mengubah migrasi lama berarti mesin yang sudah menjalankannya
# tidak akan pernah menerapkan perubahan itu.

MIGRATIONS = [
    (1, 'skema awal: users, sessions, audit_log, acs_connection_settings, app_parameters, display_settings', '''
        CREATE TABLE users (
            id            TEXT PRIMARY KEY,
            username      TEXT NOT NULL,
            name          TEXT NOT NULL DEFAULT '',
            email         TEXT NOT NULL DEFAULT '',
            phone         TEXT NOT NULL DEFAULT '',
            role          TEXT NOT NULL DEFAULT 'user',
            status        TEXT NOT NULL DEFAULT 'aktif',
            avatar        TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL DEFAULT '',
            updated_at    TEXT NOT NULL DEFAULT '',
            last_login_at TEXT NOT NULL DEFAULT ''
        );
        -- Username dibandingkan case-insensitive saat login, jadi keunikannya
        -- harus ditegakkan case-insensitive juga. Tanpa COLLATE NOCASE, 'Admin'
        -- dan 'admin' bisa sama-sama terdaftar lalu saling bentrok saat login.
        CREATE UNIQUE INDEX ix_users_username ON users (username COLLATE NOCASE);
        CREATE INDEX ix_users_role ON users (role);

        CREATE TABLE sessions (
            id         TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            token      TEXT NOT NULL UNIQUE,
            ip_address TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            last_seen  REAL NOT NULL,
            expires_at REAL NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        );
        CREATE INDEX ix_sessions_token ON sessions (token);
        CREATE INDEX ix_sessions_user ON sessions (user_id);

        CREATE TABLE audit_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT,
            username   TEXT NOT NULL DEFAULT '',
            action     TEXT NOT NULL,
            detail     TEXT NOT NULL DEFAULT '',
            ip_address TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            -- Pelaku boleh dihapus tanpa menghapus jejaknya: SET NULL, bukan
            -- CASCADE. Audit log yang ikut terhapus saat akunnya dihapus tidak
            -- ada gunanya sebagai audit — justru itu jejak yang paling dicari.
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
        );
        CREATE INDEX ix_audit_created ON audit_log (created_at DESC);
        CREATE INDEX ix_audit_action ON audit_log (action);
        CREATE INDEX ix_audit_user ON audit_log (user_id);

        CREATE TABLE acs_connection_settings (
            id                INTEGER PRIMARY KEY CHECK (id = 1),
            protocol          TEXT NOT NULL DEFAULT 'http',
            host              TEXT NOT NULL DEFAULT '127.0.0.1',
            port              INTEGER NOT NULL DEFAULT 7557,
            base_path         TEXT NOT NULL DEFAULT '',
            auth_enabled      INTEGER NOT NULL DEFAULT 0,
            auth_username     TEXT NOT NULL DEFAULT '',
            auth_secret       TEXT NOT NULL DEFAULT '',
            last_test_status  TEXT NOT NULL DEFAULT 'belum diuji',
            last_test_at      TEXT NOT NULL DEFAULT '',
            last_test_message TEXT NOT NULL DEFAULT '',
            updated_at        TEXT NOT NULL DEFAULT '',
            updated_by        TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE app_parameters (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            updated_by TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE display_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            updated_by TEXT NOT NULL DEFAULT ''
        );
    '''),

    (2, 'Master Data: OLT, PON, rasio tap coupler, PLC splitter', '''
        CREATE TABLE md_olt (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            nama       TEXT NOT NULL,
            keterangan TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        -- Nama OLT dipakai manusia untuk mencocokkan perangkat di lapangan.
        -- 'OLT-SKY-01' dan 'olt-sky-01' yang hidup berdampingan hanya akan
        -- membuat dua entri untuk satu perangkat yang sama.
        CREATE UNIQUE INDEX ix_md_olt_nama ON md_olt (nama COLLATE NOCASE);

        CREATE TABLE md_pon (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            olt_id     INTEGER NOT NULL,
            nama       TEXT NOT NULL,
            keterangan TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            -- PON tanpa OLT induk tidak punya arti apa pun. Menghapus OLT
            -- memang menghapus port-portnya — tapi UI wajib memperlihatkan
            -- berapa yang akan ikut terhapus SEBELUM itu terjadi.
            FOREIGN KEY (olt_id) REFERENCES md_olt (id) ON DELETE CASCADE
        );
        -- Nomor port unik PER OLT, bukan global: 'PON 1/1' wajar ada di
        -- setiap OLT.
        CREATE UNIQUE INDEX ix_md_pon_nama ON md_pon (olt_id, nama COLLATE NOCASE);
        CREATE INDEX ix_md_pon_olt ON md_pon (olt_id);

        CREATE TABLE md_tap (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            rasio      TEXT NOT NULL,
            -- 'biru' = porsi KECIL, 'merah' = porsi BESAR. Penamaannya
            -- mengikuti warna output di perangkat aslinya, bukan urutan angka.
            loss_biru  REAL NOT NULL,
            loss_merah REAL NOT NULL,
            urut       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX ix_md_tap_rasio ON md_tap (rasio COLLATE NOCASE);

        CREATE TABLE md_plc (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            rasio       TEXT NOT NULL,
            loss_db     REAL NOT NULL,
            jumlah_port INTEGER NOT NULL,
            urut        INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT '',
            updated_at  TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX ix_md_plc_rasio ON md_plc (rasio COLLATE NOCASE);

        -- ─── Nilai awal ───
        -- Angka redaman di bawah adalah spesifikasi UMUM tap coupler & PLC di
        -- pasaran, disemai SEKALI saja supaya panel langsung bisa dipakai.
        -- Setelah ini nilainya milik pengguna: tidak ada proses yang menimpanya
        -- kembali, karena tiap vendor punya angka sendiri dan menimpa nilai
        -- hasil ukur operator jauh lebih berbahaya daripada seed yang usang.
        INSERT INTO md_tap (rasio, loss_biru, loss_merah, urut) VALUES
            ('1/99',  22.0, 0.4,  1),  ('5/95',  14.5, 0.5,  2),
            ('10/90', 10.5, 0.7,  3),  ('15/85',  8.7, 1.0,  4),
            ('20/80',  7.6, 1.2,  5),  ('25/75',  6.6, 1.5,  6),
            ('30/70',  5.8, 1.9,  7),  ('35/65',  5.0, 2.2,  8),
            ('40/60',  4.6, 2.7,  9),  ('45/55',  4.0, 3.1, 10),
            ('50/50',  3.6, 3.6, 11);

        INSERT INTO md_plc (rasio, loss_db, jumlah_port, urut) VALUES
            ('1:2',   3.7,  2, 1), ('1:4',   7.2,  4, 2),
            ('1:8',  10.5,  8, 3), ('1:16', 13.7, 16, 4),
            ('1:32', 17.0, 32, 5), ('1:64', 20.5, 64, 6);

        -- Stempel waktu disetel lewat UPDATE terpisah, bukan di dalam VALUES
        -- di atas. Menuliskannya per baris membuat daftar angkanya jauh lebih
        -- sulit dibaca dan diperiksa ulang — dan daftar inilah yang paling
        -- mungkin dikoreksi orang di kemudian hari.
        UPDATE md_tap SET created_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),
                          updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime');
        UPDATE md_plc SET created_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),
                          updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime');
    '''),

    (3, 'rasio tap coupler: ganti angka umum dengan tabel spesifikasi Sky Tech (14 rasio)', '''
        -- Seed v2 memakai angka UMUM tap coupler di pasaran, karena saat itu
        -- angka sebenarnya belum ada. Tabel di "PRD TUGAS/ukuran rasio.png"
        -- adalah spesifikasi yang benar-benar dipakai, dan menambah tiga rasio
        -- yang belum ada sama sekali (2/98, 3/97, 8/92).
        --
        -- Di gambar angkanya bertanda MINUS karena ditulis sebagai redaman
        -- (mis. -10,32 dB). Kolom di sini menyimpan BESARNYA saja, sebab
        -- perhitungannya sudah mengurangkan: keluaran = masukan - redaman.
        -- Menyimpan tanda minus akan membuat daya justru bertambah di tiap
        -- splitter — dan hasilnya tetap tampak seperti angka yang wajar.
        --
        -- Tiap UPDATE diberi syarat "nilainya masih sama persis dengan seed
        -- v2". Kalau operator sudah mengubah suatu baris dengan hasil ukurnya
        -- sendiri, baris itu TIDAK tersentuh. Menimpa angka hasil ukur dengan
        -- angka dari tabel jauh lebih berbahaya daripada membiarkan satu baris
        -- tertinggal, karena tidak ada yang akan tahu nilainya pernah berubah.
        UPDATE md_tap SET loss_biru=22.00, loss_merah=0.24, urut=1,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='1/99'  AND loss_biru=22.0 AND loss_merah=0.4;
        UPDATE md_tap SET loss_biru=13.88, loss_merah=0.39, urut=5,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='5/95'  AND loss_biru=14.5 AND loss_merah=0.5;
        UPDATE md_tap SET loss_biru=10.32, loss_merah=0.65, urut=10,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='10/90' AND loss_biru=10.5 AND loss_merah=0.7;
        UPDATE md_tap SET loss_biru=8.56,  loss_merah=0.90, urut=15,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='15/85' AND loss_biru=8.7 AND loss_merah=1.0;
        UPDATE md_tap SET loss_biru=7.27,  loss_merah=1.20, urut=20,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='20/80' AND loss_biru=7.6 AND loss_merah=1.2;
        UPDATE md_tap SET loss_biru=6.28,  loss_merah=1.45, urut=25,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='25/75' AND loss_biru=6.6 AND loss_merah=1.5;
        UPDATE md_tap SET loss_biru=5.47,  loss_merah=1.75, urut=30,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='30/70' AND loss_biru=5.8 AND loss_merah=1.9;
        UPDATE md_tap SET loss_biru=4.79,  loss_merah=2.07, urut=35,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='35/65' AND loss_biru=5.0 AND loss_merah=2.2;
        UPDATE md_tap SET loss_biru=4.20,  loss_merah=2.42, urut=40,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='40/60' AND loss_biru=4.6 AND loss_merah=2.7;
        UPDATE md_tap SET loss_biru=3.69,  loss_merah=2.81, urut=45,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='45/55' AND loss_biru=4.0 AND loss_merah=3.1;
        UPDATE md_tap SET loss_biru=3.22,  loss_merah=3.22, urut=50,
               updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
         WHERE rasio='50/50' AND loss_biru=3.6 AND loss_merah=3.6;

        -- OR IGNORE: kalau operator sudah menambahkannya sendiri lebih dulu,
        -- miliknya yang dipertahankan.
        INSERT OR IGNORE INTO md_tap (rasio, loss_biru, loss_merah, urut, created_at, updated_at)
        VALUES
            ('2/98', 20.00, 0.28, 2, strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),
                                     strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
            ('3/97', 17.60, 0.32, 3, strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),
                                     strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
            ('8/92', 11.33, 0.56, 8, strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),
                                     strftime('%Y-%m-%dT%H:%M:%S','now','localtime'));
    '''),

    (4, 'Data ODC: topologi jalur kabel FTTH (odc + odc_node)', '''
        CREATE TABLE odc (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            nama       TEXT NOT NULL,
            olt_id     INTEGER,
            pon_id     INTEGER,
            keterangan TEXT NOT NULL DEFAULT '',
            -- Daya kirim PON hasil ukur, diisi manual. REAL, bukan TEXT:
            -- angka yang disimpan sebagai teks akan diurutkan '-9' > '-10'.
            input_dbm  REAL NOT NULL DEFAULT 0,
            core_line  INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            -- SET NULL, bukan CASCADE: menghapus OLT dari Master Data tidak
            -- boleh ikut melenyapkan topologi yang sudah dipetakan di lapangan.
            -- Topologinya tetap ada, hanya kehilangan acuan induknya.
            FOREIGN KEY (olt_id) REFERENCES md_olt (id) ON DELETE SET NULL,
            FOREIGN KEY (pon_id) REFERENCES md_pon (id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX ix_odc_nama ON odc (nama COLLATE NOCASE);
        CREATE INDEX ix_odc_olt ON odc (olt_id);

        CREATE TABLE odc_node (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            odc_id      INTEGER NOT NULL,
            -- 'odp'          : tap coupler, keluaran merah (besar) + biru (kecil)
            -- 'splitter'     : PLC ujung — port-portnya menuju pelanggan
            -- 'splitter_odc' : PLC distribusi — tiap portnya bisa menuju ODP lain
            tipe        TEXT NOT NULL,
            nama        TEXT NOT NULL DEFAULT '',
            parent_id   INTEGER,
            -- '' (akar, langsung dari PON) | 'merah' | 'biru' | 'p1'..'pN'
            parent_port TEXT NOT NULL DEFAULT '',
            tap_id      INTEGER,
            plc_id      INTEGER,
            core        INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT '',
            updated_at  TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (odc_id)    REFERENCES odc (id)      ON DELETE CASCADE,
            -- Menghapus satu node menghapus seluruh cabang di bawahnya.
            -- Cabang yatim tidak punya arti: tanpa induk, dayanya tak terhitung.
            FOREIGN KEY (parent_id) REFERENCES odc_node (id) ON DELETE CASCADE,
            FOREIGN KEY (tap_id)    REFERENCES md_tap (id)   ON DELETE SET NULL,
            FOREIGN KEY (plc_id)    REFERENCES md_plc (id)   ON DELETE SET NULL
        );
        CREATE INDEX ix_odc_node_odc    ON odc_node (odc_id);
        CREATE INDEX ix_odc_node_parent ON odc_node (parent_id);
        -- Satu serat fisik hanya bisa menuju SATU tempat. Tanpa indeks ini,
        -- dua node bisa sama-sama mengaku menempel di keluaran biru yang sama
        -- dan dayanya terhitung dua kali.
        -- Catatan: SQLite menganggap NULL selalu berbeda, jadi baris akar
        -- (parent_id NULL) TIDAK terjaga di sini — keunikannya ditegakkan
        -- di odc.py.
        CREATE UNIQUE INDEX ix_odc_node_slot ON odc_node (odc_id, parent_id, parent_port);
    '''),

    (5, 'Data ODC: posisi node yang digeser manual', '''
        -- NULL = "ikuti tata letak otomatis". Itu sebabnya kolomnya boleh
        -- kosong dan TIDAK diberi DEFAULT 0: nol adalah koordinat yang sah
        -- (pojok kiri-atas), jadi ia tak bisa dipakai menandai "belum diatur".
        -- Node yang belum pernah digeser akan selalu ikut tertata rapi
        -- sendiri saat cabang baru ditambahkan.
        ALTER TABLE odc_node ADD COLUMN pos_x REAL;
        ALTER TABLE odc_node ADD COLUMN pos_y REAL;
    '''),

    (6, 'Data ODC: mode ODP — pakai rasio tap coupler atau langsung PLC splitter', '''
        -- PRD §4.4 mode A/B. 'tap' = lewat tap coupler, menghasilkan keluaran
        -- merah (porsi besar, lanjut) + biru (porsi kecil, ke splitter).
        -- 'plc' = tanpa tap sama sekali: serat masuk langsung dibagi PLC ke
        -- banyak pelanggan. Itu titik AKHIR jalur — tidak ada porsi besar yang
        -- tersisa untuk diteruskan.
        --
        -- DEFAULT 'tap' bukan sekadar nilai awal: seluruh ODP yang sudah
        -- terlanjur dibuat memang bekerja dengan tap coupler, jadi baris lama
        -- harus tetap berperilaku persis seperti sebelumnya.
        ALTER TABLE odc_node ADD COLUMN mode TEXT NOT NULL DEFAULT 'tap';
    '''),

    (7, 'Antrean task panel di GenieACS: batas umur agar tak berlaku mendadak (antrean.py)', '''
        -- Diukur 2026-09-29: 207 task menggantung di 35 ONU, 192 di antaranya
        -- > 7 hari, termasuk ganti password WiFi berumur 44 hari yang akan
        -- berlaku begitu ONU-nya online lagi. Tabel ini mencatat task yang
        -- DIBUAT PANEL dan dijawab 202 (baru diantre) supaya penjaga di
        -- antrean.py bisa membatalkannya setelah batas umur — juga sesudah
        -- panel di-restart, alasan ia di DB dan bukan di memori.
        --
        -- Waktu disimpan sebagai epoch (REAL), bukan teks seperti tabel lain:
        -- satu-satunya pemakaiannya adalah menghitung umur.
        CREATE TABLE task_antre (
            task_id    TEXT PRIMARY KEY,
            device_id  TEXT NOT NULL,
            nama       TEXT NOT NULL DEFAULT '',
            pemilik    TEXT NOT NULL DEFAULT '',
            dibuat     REAL NOT NULL,
            status     TEXT NOT NULL DEFAULT 'mengantre',  -- mengantre | tuntas | dibatalkan
            selesai    REAL
        );
        CREATE INDEX idx_task_antre_status ON task_antre(status);
    '''),
]


def _migrate(c):
    """Terapkan migrasi yang belum dijalankan. Aman dipanggil berkali-kali."""
    with _init_lock:
        if DB_PATH in _initialized:
            return
        c.execute('''CREATE TABLE IF NOT EXISTS schema_migrations (
                         version    INTEGER PRIMARY KEY,
                         description TEXT NOT NULL DEFAULT '',
                         applied_at TEXT NOT NULL
                     )''')
        c.commit()
        done = {r[0] for r in c.execute('SELECT version FROM schema_migrations')}

        for version, desc, sql in MIGRATIONS:
            if version in done:
                continue
            # Satu migrasi = satu transaksi. Kalau gagal di tengah, tidak ada
            # separuh skema yang tertinggal dan versinya tidak tercatat.
            try:
                c.executescript(sql)
                c.execute('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?,?,?)',
                          (version, desc, now()))
                c.commit()
            except Exception:
                c.rollback()
                raise

        _initialized.add(DB_PATH)
        _secure_file()


def _secure_file():
    """DB memuat hash password → hanya pemilik proses yang boleh membacanya."""
    for p in (DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm'):
        try:
            if os.path.exists(p):
                os.chmod(p, 0o600)
        except Exception:
            pass


def schema_version():
    rows = conn().execute('SELECT MAX(version) AS v FROM schema_migrations').fetchone()
    return rows['v'] or 0


def init():
    """Paksa buka + migrasi (dipanggil saat server start agar gagal cepat)."""
    conn()
    return DB_PATH


# ═══════════════════════════════════════════════════════════════
#  Backup
# ═══════════════════════════════════════════════════════════════
def backup(dest_dir=None):
    """Salinan konsisten memakai API backup bawaan SQLite.

    Sengaja BUKAN shutil.copy: menyalin berkas .db yang sedang dipakai bisa
    menghasilkan salinan rusak (tulisan setengah jalan + WAL yang belum
    ter-checkpoint tidak ikut). API backup menyalin lewat mesin SQLite sendiri,
    aman dijalankan selagi server melayani permintaan.
    """
    dest_dir = dest_dir or os.path.join(os.path.dirname(DB_PATH) or '.', 'backup')
    os.makedirs(dest_dir, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    dest = os.path.join(dest_dir, f'sky-{stamp}.db')
    target = sqlite3.connect(dest)
    try:
        conn().backup(target)
    finally:
        target.close()
    try:
        os.chmod(dest, 0o600)
    except Exception:
        pass
    return dest


# ═══════════════════════════════════════════════════════════════
#  Audit log
# ═══════════════════════════════════════════════════════════════
def audit(action, detail='', actor=None, ip=''):
    """Catat aksi sensitif.

    Tidak pernah melempar: kegagalan mencatat audit tidak boleh menggagalkan
    aksi yang sedang berjalan (mis. login jadi error hanya karena log penuh).
    """
    try:
        c = conn()
        uid = (actor or {}).get('id') if isinstance(actor, dict) else None
        uname = (actor or {}).get('username', '') if isinstance(actor, dict) else ''
        # user_id punya FOREIGN KEY ke users; pelaku yang tak dikenal (mis. login
        # gagal dengan username karangan) harus masuk sebagai NULL, bukan id palsu
        # — kalau tidak, INSERT-nya ditolak dan justru percobaan bobol yang paling
        # ingin kita catat malah hilang. Username tetap disimpan apa adanya.
        if uid is not None:
            row = c.execute('SELECT 1 FROM users WHERE id=?', (uid,)).fetchone()
            if not row:
                uid = None
        c.execute('''INSERT INTO audit_log (user_id, username, action, detail, ip_address, created_at)
                     VALUES (?,?,?,?,?,?)''',
                  (uid, uname or '', action, detail or '', ip or '', now()))
        c.commit()
    except Exception:
        pass


def audit_list(limit=100, offset=0, action=None):
    c = conn()
    if action:
        rows = c.execute('''SELECT * FROM audit_log WHERE action=?
                            ORDER BY id DESC LIMIT ? OFFSET ?''',
                         (action, limit, offset)).fetchall()
    else:
        rows = c.execute('''SELECT * FROM audit_log
                            ORDER BY id DESC LIMIT ? OFFSET ?''',
                         (limit, offset)).fetchall()
    return [dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════
#  Key-value settings (app_parameters, display_settings)
# ═══════════════════════════════════════════════════════════════
def kv_get_all(table):
    _guard_kv(table)
    rows = conn().execute(f'SELECT key, value FROM {table}').fetchall()
    return {r['key']: r['value'] for r in rows}


def kv_get(table, key, default=None):
    _guard_kv(table)
    r = conn().execute(f'SELECT value FROM {table} WHERE key=?', (key,)).fetchone()
    return r['value'] if r else default


def kv_set(table, key, value, actor=None):
    _guard_kv(table)
    c = conn()
    by = (actor or {}).get('username', '') if isinstance(actor, dict) else ''
    c.execute(f'''INSERT INTO {table} (key, value, updated_at, updated_by) VALUES (?,?,?,?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                      updated_at=excluded.updated_at, updated_by=excluded.updated_by''',
              (key, str(value), now(), by))
    c.commit()


_KV_TABLES = ('app_parameters', 'display_settings')


def _guard_kv(table):
    # Nama tabel tidak bisa diparameterkan di SQL, jadi ia diinterpolasi ke
    # string query. Whitelist ini yang menahan agar itu tidak menjadi injeksi.
    if table not in _KV_TABLES:
        raise ValueError(f'Tabel kv tidak dikenal: {table}')


# ═══════════════════════════════════════════════════════════════
#  CLI:  python3 db.py backup | info
# ═══════════════════════════════════════════════════════════════
if __name__ == '__main__':
    import sys

    cmd = sys.argv[1] if len(sys.argv) > 1 else 'info'

    if cmd == 'backup':
        dest = backup(sys.argv[2] if len(sys.argv) > 2 else None)
        size = os.path.getsize(dest) / 1024
        print(f'Backup selesai → {dest}  ({size:.1f} KB)')

    elif cmd == 'info':
        init()
        c = conn()
        print(f'Berkas       : {DB_PATH}')
        print(f'Ukuran       : {os.path.getsize(DB_PATH) / 1024:.1f} KB')
        print(f'Skema versi  : {schema_version()}')
        print(f'Journal mode : {c.execute("PRAGMA journal_mode").fetchone()[0]}')
        print(f'Foreign keys : {"ON" if c.execute("PRAGMA foreign_keys").fetchone()[0] else "OFF"}')
        print(f'Integritas   : {c.execute("PRAGMA integrity_check").fetchone()[0]}')
        print('\nJumlah baris per tabel:')
        for t in ('users', 'sessions', 'audit_log', 'acs_connection_settings',
                  'app_parameters', 'display_settings'):
            n = c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
            print(f'  {t:26s} {n:6d}')
        print('\nMigrasi terpasang:')
        for r in c.execute('SELECT version, description, applied_at FROM schema_migrations ORDER BY version'):
            print(f'  v{r[0]}  {r[2]}  {r[1]}')

    else:
        print(__doc__)
        print('Perintah: info | backup [folder-tujuan]')
        sys.exit(1)
