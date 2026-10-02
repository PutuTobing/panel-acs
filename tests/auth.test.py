#!/usr/bin/env python3
"""Uji modul autentikasi (auth.py).

Ini kode keamanan: yang diuji bukan "jalan atau tidak", tapi apakah PAGARNYA
benar-benar menahan — wewenang, brute-force, kebocoran informasi, dan aturan
yang bisa mengunci panel selamanya.
"""
import os, sys, time, tempfile, importlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend'))
import db
import auth

# Arahkan penyimpanan ke folder sementara — jangan sentuh data asli.
_tmp = tempfile.mkdtemp(prefix='skyauth-')
auth.DATA_DIR   = _tmp
# WAJIB diarahkan ke tmp: ensure_bootstrap() mengimpor berkas ini bila ada, dan
# menunjuk ke data/users.json asli berarti tes menarik masuk akun produksi.
auth.USERS_PATH = os.path.join(_tmp, 'users.json')
db.set_path(os.path.join(_tmp, 'sky.db'))

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

def reset():
    """DB baru dari nol tiap blok uji — bukan sekadar mengosongkan tabel, agar
    migrasi ikut teruji berulang kali."""
    db.close()
    for suffix in ('', '-wal', '-shm'):
        p = db.DB_PATH + suffix
        if os.path.exists(p):
            os.remove(p)
    db._initialized.discard(db.DB_PATH)
    auth._fail_ip.clear(); auth._fail_user.clear()

# ── Hashing ──
reset()
h = auth.hash_password('Rahasia#2026x')
ok(h['algo'] == 'scrypt', 'memakai scrypt (memory-hard), bukan SHA/MD5 yang cepat dibongkar GPU')
ok('Rahasia#2026x' not in str(h), 'password asli tidak tersimpan di record hash')
ok(auth.verify_password('Rahasia#2026x', h), 'password benar → terverifikasi')
ok(not auth.verify_password('Rahasia#2026y', h), 'password salah → ditolak')
ok(not auth.verify_password('', h), 'password kosong → ditolak')
h2 = auth.hash_password('Rahasia#2026x')
ok(h['salt'] != h2['salt'], 'salt acak per password (hash sama tidak menghasilkan record sama)')
ok(h['hash'] != h2['hash'], 'password identik → hash berbeda (rainbow table tak berguna)')
ok(not auth.verify_password('x', {'algo': 'md5', 'salt': 'a', 'hash': 'b'}), 'algoritma tak dikenal → ditolak, bukan error')
ok(not auth.verify_password('x', None), 'record kosong → ditolak, bukan error')

# ── Kebijakan password ──
ok(auth.password_problem('pendek') is not None, 'password pendek ditolak')
ok(auth.password_problem('semuahurufkecilsaja') is not None, 'password 1 kelas karakter ditolak')
ok(auth.password_problem('Rahasia#2026x') is None, 'password kuat diterima')

# Password acak WAJIB selalu lolos kebijakan sendiri. Diulang 300x karena
# bugnya bersifat acak: token_urlsafe() kadang cuma memuat 2 kelas karakter,
# sehingga bootstrap gagal sesekali — persis bug yang pernah terjadi di sini.
bad = [p for p in (auth.generate_password() for _ in range(300))
       if auth.password_problem(p) is not None]
ok(not bad, 'generate_password() selalu lolos kebijakan (300x); gagal: %r' % bad[:2])
ok(len(set(auth.generate_password() for _ in range(50))) == 50, 'password acak tidak berulang')

# ── Bootstrap ──
reset()
pw = auth.ensure_bootstrap()
ok(pw is not None and len(pw) >= 12, 'bootstrap membuat password ACAK (bukan admin/admin)')
users = auth.list_users()
ok(len(users) == 1 and users[0]['role'] == 'administrator', 'bootstrap membuat 1 administrator')
ok(auth.ensure_bootstrap() is None, 'bootstrap tidak jalan dua kali')

# ── Bentuk publik tidak membocorkan hash ──
u = auth.list_users()[0]
ok('pass' not in u and 'hash' not in str(u), 'data user yang dikirim ke browser TIDAK memuat hash/salt')

# ── Login ──
reset()
pw = auth.ensure_bootstrap()
admin, token = auth.authenticate('admin', pw, '1.1.1.1')
ok(admin['role'] == 'administrator', 'login admin berhasil')
ok(len(token) > 30, 'token sesi panjang & acak')
ok(auth.get_session_user(token)['id'] == admin['id'], 'sesi valid mengembalikan user')
ok(auth.get_session_user('token-palsu') is None, 'token palsu ditolak')
ok(auth.authenticate('ADMIN', pw, '1.1.1.1')[0]['id'] == admin['id'], 'username tidak case-sensitive')

# ── Pesan gagal tidak membocorkan username mana yang ada ──
reset(); pw = auth.ensure_bootstrap()
m1 = m2 = ''
try: auth.authenticate('admin', 'SalahSekali#1', '2.2.2.2')
except PermissionError as e: m1 = str(e)
try: auth.authenticate('tidakada', 'SalahSekali#1', '3.3.3.3')
except PermissionError as e: m2 = str(e)
ok(m1 == m2 and m1 != '', 'pesan gagal identik untuk user tak ada vs password salah (tak membocorkan username valid)')

# ── Brute-force: dikunci per username ──
reset(); pw = auth.ensure_bootstrap()
for i in range(auth.LOGIN_MAX_PER_USER):
    try: auth.authenticate('admin', 'Salah#123456', '9.9.9.%d' % i)   # IP beda2
    except PermissionError: pass
blocked = False
try: auth.authenticate('admin', pw, '9.9.9.250')                       # password BENAR
except PermissionError as e: blocked = 'Terlalu banyak' in str(e)
ok(blocked, 'kuota per-username mengunci walau penyerang berganti IP')

# ── Brute-force: dikunci per IP ──
reset(); pw = auth.ensure_bootstrap()
for i in range(auth.LOGIN_MAX_PER_IP):
    try: auth.authenticate('user%d' % i, 'Salah#123456', '5.5.5.5')    # username beda2
    except PermissionError: pass
blocked = False
try: auth.authenticate('admin', pw, '5.5.5.5')
except PermissionError as e: blocked = 'Terlalu banyak' in str(e)
ok(blocked, 'kuota per-IP mengunci walau penyerang berganti username')

# ── Rate limit diperiksa SEBELUM hashing (kalau tidak, login jadi senjata DoS) ──
reset(); pw = auth.ensure_bootstrap()
calls = {'n': 0}
_orig = auth.verify_password
def counting(p, r):
    calls['n'] += 1
    return _orig(p, r)
auth.verify_password = counting
for i in range(auth.LOGIN_MAX_PER_USER + 6):
    try: auth.authenticate('admin', 'Salah#123456', '7.7.7.7')
    except PermissionError: pass
auth.verify_password = _orig
ok(calls['n'] <= auth.LOGIN_MAX_PER_USER,
   'setelah terkunci, scrypt TIDAK dijalankan lagi (%d verifikasi) — banjir login tak membakar CPU/RAM' % calls['n'])

# ── Login sukses membersihkan hitungan gagal ──
reset(); pw = auth.ensure_bootstrap()
try: auth.authenticate('admin', 'Salah#123456', '4.4.4.4')
except PermissionError: pass
auth.authenticate('admin', pw, '4.4.4.4')
ok(auth.login_blocked('4.4.4.4', 'admin')[0] is False, 'login sukses mereset hitungan gagal')

# ── Wewenang: user biasa vs administrator ──
reset(); pw = auth.ensure_bootstrap()
adm = auth.list_users()[0]
bud = auth.create_user('budi', 'Budi#Kuat2026', 'Budi', 'budi@x.id', '081234567890', 'user')
ok(bud['role'] == 'user', 'user biasa dibuat')

# user TIDAK boleh mengubah orang lain
try:
    auth.update_user(adm['id'], {'name': 'Diretas'}, actor=bud); denied = False
except PermissionError: denied = True
ok(denied, 'user biasa TIDAK bisa mengubah data pengguna lain')

# user TIDAK boleh menaikkan rolenya sendiri
try:
    auth.update_user(bud['id'], {'role': 'administrator'}, actor=bud); denied = False
except PermissionError: denied = True
ok(denied, 'user biasa TIDAK bisa menaikkan dirinya jadi administrator')

# user BOLEH mengubah datanya sendiri
r = auth.update_user(bud['id'], {'name': 'Budi Santoso', 'phone': '08123456789'}, actor=bud)
ok(r['name'] == 'Budi Santoso', 'user biasa BISA mengubah data dirinya sendiri')

# user ganti password sendiri wajib password lama
try:
    auth.update_user(bud['id'], {'password': 'BaruSekali#9'}, actor=bud); denied = False
except PermissionError: denied = True
ok(denied, 'ganti password sendiri tanpa password lama → ditolak')
try:
    auth.update_user(bud['id'], {'password': 'BaruSekali#9', 'currentPassword': 'salah'}, actor=bud); denied = False
except PermissionError: denied = True
ok(denied, 'password lama salah → ditolak')
auth.update_user(bud['id'], {'password': 'BaruSekali#9', 'currentPassword': 'Budi#Kuat2026'}, actor=bud)
ok(auth.authenticate('budi', 'BaruSekali#9', '1.2.3.4')[0]['id'] == bud['id'], 'ganti password sendiri dgn password lama benar → berhasil')

# admin BOLEH reset password orang lain TANPA password lama
auth.update_user(bud['id'], {'password': 'ResetAdmin#7'}, actor=adm)
ok(auth.authenticate('budi', 'ResetAdmin#7', '1.2.3.4')[0]['id'] == bud['id'], 'administrator BISA reset password user lain tanpa password lama')
# admin BOLEH ubah data & role orang lain
auth.update_user(bud['id'], {'name': 'Budi S', 'role': 'administrator'}, actor=adm)
ok(auth.find_by_id(auth._read_users(), bud['id'])['role'] == 'administrator', 'administrator BISA mengubah role user lain')

# ── Ganti password mencabut sesi lama (sesi curian jadi tak berguna) ──
reset(); pw = auth.ensure_bootstrap()
adm = auth.list_users()[0]
bud = auth.create_user('budi', 'Budi#Kuat2026', 'Budi')
_, tok = auth.authenticate('budi', 'Budi#Kuat2026', '1.2.3.4')
ok(auth.get_session_user(tok) is not None, 'sesi budi aktif')
auth.update_user(bud['id'], {'password': 'GantiPaksa#5'}, actor=adm)
ok(auth.get_session_user(tok) is None, 'ganti password MENCABUT sesi lama (sesi curian mati)')

# ── Menghapus user mencabut sesinya ──
reset(); pw = auth.ensure_bootstrap()
adm = auth.list_users()[0]
bud = auth.create_user('budi', 'Budi#Kuat2026', 'Budi')
_, tok = auth.authenticate('budi', 'Budi#Kuat2026', '1.2.3.4')
auth.delete_user(bud['id'], actor=adm)
ok(auth.get_session_user(tok) is None, 'hapus user → sesinya langsung mati')

# ── Tidak boleh mengunci diri dari panel ──
reset(); pw = auth.ensure_bootstrap()
adm = auth.list_users()[0]
try: auth.delete_user(adm['id'], actor=adm); denied = False
except ValueError: denied = True
ok(denied, 'admin tidak bisa menghapus akun sendiri')
try: auth.update_user(adm['id'], {'role': 'user'}, actor=adm); denied = False
except ValueError: denied = True
ok(denied, 'administrator TERAKHIR tidak bisa diturunkan (panel tak bisa terkunci selamanya)')
bud = auth.create_user('budi', 'Budi#Kuat2026', 'Budi', role='user')
try: auth.delete_user(adm['id'], actor=bud); denied = False
except PermissionError: denied = True
ok(denied, 'user biasa tidak bisa menghapus administrator')

# Admin BOLEH menghapus admin lain (jalur sah), dan admin terakhir tetap aman
# karena hapus-diri ditolak + turun-role admin terakhir ditolak. Ketiganya
# bersama menjamin panel tak pernah kehilangan seluruh administrator.
adm2 = auth.create_user('admin2', 'Kuat#Sekali9', 'Admin 2', role='administrator')
auth.delete_user(adm2['id'], actor=adm)
admins = [u for u in auth.list_users() if u['role'] == 'administrator']
ok(len(admins) == 1, 'administrator bisa menghapus administrator lain')
try: auth.delete_user(admins[0]['id'], actor=admins[0]); denied = False
except ValueError: denied = True
ok(denied, 'administrator terakhir tetap tak terhapus (dijaga aturan hapus-diri)')
try: auth.update_user(admins[0]['id'], {'role': 'user'}, actor=admins[0]); denied = False
except ValueError: denied = True
ok(denied, 'administrator terakhir tetap tak bisa diturunkan → panel selalu punya admin')

# ── Validasi input ──
reset(); auth.ensure_bootstrap()
for bad, why in [('ad', 'terlalu pendek'), ('a b', 'ada spasi'), ('a' * 40, 'terlalu panjang'), ('admin!', 'karakter aneh')]:
    try: auth.create_user(bad, 'Kuat#Sekali9', 'X'); bad_ok = False
    except ValueError: bad_ok = True
    ok(bad_ok, 'username ditolak (%s): %r' % (why, bad))
try: auth.create_user('duaorang', 'Kuat#Sekali9', 'X', email='bukan-email'); bad_ok = False
except ValueError: bad_ok = True
ok(bad_ok, 'email tidak valid ditolak')
auth.create_user('budi', 'Kuat#Sekali9', 'Budi')
try: auth.create_user('BUDI', 'Kuat#Sekali9', 'Budi 2'); bad_ok = False
except ValueError: bad_ok = True
ok(bad_ok, 'username duplikat (beda kapital) ditolak')

# ── Berkas database hanya boleh dibaca pemilik ──
mode = oct(os.stat(db.DB_PATH).st_mode)[-3:]
ok(mode == '600', 'sky.db berizin 0600 (hash tak terbaca user lain di server), dapat: %s' % mode)

print('auth: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
