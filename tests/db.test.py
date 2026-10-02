#!/usr/bin/env python3
"""Uji lapisan database (db.py).

Yang diuji di sini bukan "SQLite jalan atau tidak" — itu sudah pasti. Yang
diuji adalah hal-hal yang GAGAL DIAM-DIAM kalau salah setel:

  • foreign_keys mati diam-diam (default SQLite OFF, dan per-koneksi)
  • koneksi dipakai lintas thread (server ini ThreadingHTTPServer)
  • migrasi jalan dua kali / tidak jalan sama sekali
  • audit_log ikut terhapus saat akunnya dihapus (jejak hilang justru saat
    paling dibutuhkan)
  • backup menghasilkan berkas rusak
"""
import os, sys, time, sqlite3, tempfile, threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend'))
import db

_tmp = tempfile.mkdtemp(prefix='skydb-')
db.set_path(os.path.join(_tmp, 'sky.db'))

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

def fresh():
    db.close()
    for s in ('', '-wal', '-shm'):
        p = db.DB_PATH + s
        if os.path.exists(p):
            os.remove(p)
    db._initialized.discard(db.DB_PATH)


def mkuser(uid='u1', username='budi', role='user'):
    c = db.conn()
    c.execute('''INSERT INTO users (id, username, name, role, status, password_hash,
                                    created_at, updated_at)
                 VALUES (?,?,?,?,'aktif','{}',?,?)''',
              (uid, username, username.title(), role, db.now(), db.now()))
    c.commit()
    return uid


# ── Migrasi ──
fresh()
c = db.conn()
tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
for t in ('users', 'sessions', 'audit_log', 'acs_connection_settings',
          'app_parameters', 'display_settings', 'schema_migrations'):
    ok(t in tables, 'tabel %s dibuat migrasi' % t)

ok(db.schema_version() == max(m[0] for m in db.MIGRATIONS),
   'schema_version = versi migrasi tertinggi')

# Migrasi tidak boleh jalan dua kali (kalau iya → CREATE TABLE error / data hilang)
n_before = c.execute('SELECT COUNT(*) FROM schema_migrations').fetchone()[0]
db._initialized.discard(db.DB_PATH)
db._migrate(db.conn())
n_after = db.conn().execute('SELECT COUNT(*) FROM schema_migrations').fetchone()[0]
ok(n_before == n_after, 'migrasi idempoten — tidak dijalankan ulang pada DB yang sudah siap')

# Versi migrasi tidak boleh kembar/turun — kalau kembar, satu di antaranya
# tidak akan pernah jalan di mesin yang sudah menerapkan versi itu.
vers = [m[0] for m in db.MIGRATIONS]
ok(len(vers) == len(set(vers)), 'nomor versi migrasi unik')
ok(vers == sorted(vers), 'nomor versi migrasi menaik')

# ── PRAGMA yang menentukan ──
ok(db.conn().execute('PRAGMA journal_mode').fetchone()[0].lower() == 'wal',
   'journal_mode=WAL (pembaca tidak diblokir penulis)')
ok(db.conn().execute('PRAGMA foreign_keys').fetchone()[0] == 1,
   'foreign_keys=ON (SQLite default OFF — kalau lolos, CASCADE diam-diam mati)')

# ── FK benar-benar DITEGAKKAN, bukan sekadar tertulis di skema ──
fresh()
mkuser('u1', 'budi')
c = db.conn()
c.execute('''INSERT INTO sessions (id, user_id, token, created_at, last_seen, expires_at)
             VALUES ('s1','u1','tok1',?,?,?)''', (time.time(), time.time(), time.time() + 999))
c.commit()
ok(c.execute("SELECT COUNT(*) FROM sessions WHERE user_id='u1'").fetchone()[0] == 1, 'sesi tersimpan')
c.execute("DELETE FROM users WHERE id='u1'")
c.commit()
ok(c.execute("SELECT COUNT(*) FROM sessions WHERE user_id='u1'").fetchone()[0] == 0,
   'hapus user → sesinya ikut terhapus (ON DELETE CASCADE benar-benar jalan)')

# user_id tak dikenal harus DITOLAK (bukti FK aktif)
try:
    c.execute('''INSERT INTO sessions (id, user_id, token, created_at, last_seen, expires_at)
                 VALUES ('s2','hantu','tok2',?,?,?)''', (time.time(), time.time(), time.time() + 999))
    c.commit(); rejected = False
except sqlite3.IntegrityError:
    c.rollback(); rejected = True
ok(rejected, 'sesi dengan user_id tak dikenal ditolak FK')

# ── audit_log TIDAK ikut terhapus bersama pelakunya ──
fresh()
mkuser('u1', 'budi')
db.audit('account.update', 'ubah nama', {'id': 'u1', 'username': 'budi'}, '1.2.3.4')
c = db.conn()
ok(c.execute('SELECT COUNT(*) FROM audit_log').fetchone()[0] == 1, 'audit tercatat')
c.execute("DELETE FROM users WHERE id='u1'"); c.commit()
row = c.execute('SELECT * FROM audit_log').fetchone()
ok(row is not None, 'hapus user TIDAK menghapus jejak auditnya (SET NULL, bukan CASCADE)')
ok(row['user_id'] is None and row['username'] == 'budi',
   'jejak audit tetap menyimpan username walau akunnya sudah hilang')

# ── audit() tidak boleh melempar, apa pun yang terjadi ──
fresh()
db.conn()
try:
    db.audit('x.y', 'pelaku tak dikenal', {'id': 'tidak-ada', 'username': 'hantu'}, '9.9.9.9')
    threw = False
except Exception:
    threw = True
ok(not threw, 'audit dengan user_id tak dikenal tidak melempar (aksi utama tak boleh gagal karena logging)')
row = db.conn().execute("SELECT * FROM audit_log WHERE action='x.y'").fetchone()
ok(row is not None and row['user_id'] is None,
   'pelaku tak dikenal tetap tercatat sebagai NULL — percobaan bobol tidak hilang dari log')

# ── Username unik case-insensitive ──
fresh()
mkuser('u1', 'budi')
try:
    mkuser('u2', 'BUDI'); dup = False
except sqlite3.IntegrityError:
    db.conn().rollback(); dup = True
ok(dup, 'username duplikat beda kapital ditolak indeks UNIQUE ... COLLATE NOCASE')

# ── Thread-safety: server ini ThreadingHTTPServer ──
fresh()
db.conn()
errors, conns = [], []
def worker(i):
    try:
        c = db.conn()          # tiap thread dapat koneksinya sendiri
        # Objeknya DITAHAN, bukan id()-nya: begitu thread mati, koneksinya
        # dibebaskan dan CPython memakai ulang alamat memori itu — id() jadi
        # kembar dan tes lolos/gagal secara palsu.
        conns.append(c)
        c.execute('''INSERT INTO users (id, username, name, role, status, password_hash,
                                        created_at, updated_at)
                     VALUES (?,?,?,'user','aktif','{}',?,?)''',
                  ('t%d' % i, 'user%d' % i, 'U%d' % i, db.now(), db.now()))
        c.commit()
    except Exception as e:
        errors.append(repr(e))

ths = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
[t.start() for t in ths]; [t.join() for t in ths]
ok(not errors, 'tulis dari 12 thread sekaligus tanpa error: %r' % errors[:2])
ok(db.conn().execute('SELECT COUNT(*) FROM users').fetchone()[0] == 12,
   '12 baris dari 12 thread benar-benar tersimpan')
ok(len(set(id(c) for c in conns)) == 12,
   'tiap thread memakai koneksi TERPISAH (koneksi sqlite3 tak aman lintas thread)')

# ── Key-value settings ──
fresh()
db.kv_set('app_parameters', 'perPage', 25, {'id': 'u1', 'username': 'admin'})
ok(db.kv_get('app_parameters', 'perPage') == '25', 'kv_set lalu kv_get')
db.kv_set('app_parameters', 'perPage', 50, {'id': 'u1', 'username': 'admin'})
ok(db.kv_get('app_parameters', 'perPage') == '50', 'kv_set menimpa nilai lama (UPSERT)')
ok(db.kv_get('app_parameters', 'tidakada', 'bawaan') == 'bawaan', 'kv_get memakai nilai default')
row = db.conn().execute("SELECT * FROM app_parameters WHERE key='perPage'").fetchone()
ok(row['updated_by'] == 'admin' and row['updated_at'], 'kv menyimpan updated_by & updated_at (bisa diaudit)')

# Nama tabel diinterpolasi ke SQL → whitelist-nya harus benar-benar menahan
for bad in ('users', 'app_parameters; DROP TABLE users', 'sqlite_master'):
    try:
        db.kv_get(bad, 'x'); guarded = False
    except ValueError:
        guarded = True
    ok(guarded, 'tabel kv di luar whitelist ditolak: %r' % bad)

# ── Backup ──
fresh()
mkuser('u1', 'budi')
dest = db.backup(os.path.join(_tmp, 'bk'))
ok(os.path.exists(dest), 'backup menghasilkan berkas')
b = sqlite3.connect(dest)
ok(b.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'berkas backup tidak rusak')
ok(b.execute("SELECT username FROM users WHERE id='u1'").fetchone()[0] == 'budi',
   'backup memuat data yang sama')
b.close()
ok(oct(os.stat(dest).st_mode)[-3:] == '600', 'backup berizin 0600 (memuat hash password)')

# Backup harus konsisten walau diambil SELAGI ada tulisan berjalan — inilah
# alasan memakai API backup SQLite, bukan shutil.copy.
stop = threading.Event()
def writer():
    i = 0
    while not stop.is_set() and i < 500:
        try:
            c = db.conn()
            c.execute('''INSERT INTO users (id, username, name, role, status, password_hash,
                                            created_at, updated_at)
                         VALUES (?,?,?,'user','aktif','{}',?,?)''',
                      ('w%d' % i, 'w%d' % i, 'W', db.now(), db.now()))
            c.commit()
        except Exception:
            pass
        i += 1
w = threading.Thread(target=writer); w.start()
time.sleep(0.02)
dest2 = db.backup(os.path.join(_tmp, 'bk'))
stop.set(); w.join()
b2 = sqlite3.connect(dest2)
ok(b2.execute('PRAGMA integrity_check').fetchone()[0] == 'ok',
   'backup selagi ada tulisan berjalan tetap konsisten (bukan salinan setengah jadi)')
b2.close()

# ── Izin berkas DB ──
ok(oct(os.stat(db.DB_PATH).st_mode)[-3:] == '600',
   'sky.db berizin 0600 — hash password tak terbaca user lain di server')

# ── set_path benar-benar memindahkan target ──
other = os.path.join(_tmp, 'lain.db')
db.set_path(other)
ok(db.DB_PATH == other, 'set_path mengubah target')
db.conn().execute('SELECT 1 FROM users')     # migrasi jalan di DB baru
ok(db.conn().execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0,
   'DB baru benar-benar kosong (koneksi lama tidak bocor ke sini)')

print('db: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
