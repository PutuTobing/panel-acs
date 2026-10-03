#!/usr/bin/env python3
"""
SKY ACS — Autentikasi & manajemen akun (di atas SQLite, lihat db.py).

Dipakai server.py. Sengaja dipisah agar bisa diuji tanpa menjalankan server.

KEPUTUSAN DESAIN (dan alasannya):

  • scrypt, bukan SHA-256 polos.
    Password TIDAK BOLEH di-hash dengan SHA/MD5: keduanya cepat, sehingga GPU
    bisa mencoba miliaran tebakan per detik. scrypt bersifat memory-hard —
    setiap tebakan menuntut RAM, yang justru mahal di GPU/ASIC.

  • Rate limit DIPERIKSA SEBELUM hashing.
    Ini krusial dan mudah terlewat: justru KARENA scrypt mahal (16 MB + ~30 ms
    per percobaan), endpoint login jadi senjata DoS — 200 permintaan sampah
    sekaligus bisa menghabiskan RAM/CPU server. Jadi urutannya wajib:
    tolak dulu berdasarkan kuota IP, baru hitung hash.

  • Sesi disimpan di server (bukan JWT di cookie), kini di tabel `sessions`.
    Sesi bisa dicabut seketika (mis. saat password diganti); JWT tidak bisa
    ditarik kembali sebelum kedaluwarsa. Karena kini di DB, sesi juga selamat
    dari restart — operator tidak terlempar keluar tiap server dijalankan ulang.

  • Rate-limit tetap di MEMORI, sengaja.
    Datanya berumur pendek (15 menit) dan ditulis pada tiap percobaan gagal —
    justru pada saat panel sedang dibanjiri. Menulisnya ke disk berarti memberi
    penyerang cara memaksa I/O tiap permintaan; hilang saat restart pun tidak
    merugikan.

  • Perbandingan hash memakai hmac.compare_digest (waktu tetap), agar lama
    proses tidak membocorkan seberapa benar tebakan penyerang.

BATAS YANG HARUS DISADARI (tidak bisa diatasi modul ini):
  Panel dilayani lewat HTTP polos. Password dan cookie sesi melintas sebagai
  TEKS TERANG. Siapa pun di jalur (apalagi dari internet) bisa menyadap dan
  memakai ulang sesi. Hashing sekuat apa pun TIDAK menutup lubang ini — hanya
  TLS/HTTPS yang bisa. Lihat catatan di README/serah-terima.
"""

import os
import json
import time
import hmac
import base64
import hashlib
import secrets
import threading
import re

import db

DIRECTORY  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # akar proyek (induk backend/)
DATA_DIR   = os.path.join(DIRECTORY, 'data')
# Hanya dipakai untuk impor sekali jalan dari format lama → SQLite.
USERS_PATH = os.path.join(DATA_DIR, 'users.json')

# ─── Parameter scrypt ───
# n=2**14 → ~16 MB & ~30 ms per verifikasi pada CPU biasa. Sengaja tidak lebih
# tinggi: server ini juga menjalankan GenieACS, dan biaya hash yang berlebihan
# berbalik menjadi peluang DoS (lihat catatan di atas).
SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_LEN = 2 ** 14, 8, 1, 32

# ─── Kebijakan sesi ───
# Dua batas independen; yang mana pun tercapai lebih dulu, sesi mati:
#
#   • IDLE — waktu diam sejak permintaan terakhir. Sengaja PENDEK (30 menit).
#     Inilah yang membuat "sudah lama tidak dibuka lalu diakses lagi → halaman
#     login", bukan langsung dasbor. Selama panel dipakai, last_seen ikut
#     diperbarui (lihat SESSION_TOUCH_SEC), jadi 30 menit itu dihitung dari
#     kegiatan TERAKHIR, bukan dari saat login. Operator aktif tak akan
#     terlempar; hanya sesi yang benar-benar ditinggalkan yang gugur.
#
#   • ABSOLUTE — umur maksimum apa pun yang terjadi. Walau dipakai terus, satu
#     sesi tidak boleh hidup melewati batas ini; setelahnya WAJIB login ulang.
#
# Cookie sesi sendiri dibuat TANPA Max-Age (lihat _session_cookie di server.py),
# jadi menutup browser sudah menghapus kredensial di sisi klien. Idle 30 menit
# menutup kasus "tab ditutup tapi browser tetap jalan / dipulihkan otomatis".
SESSION_IDLE_SEC     = 30 * 60         # tak aktif 30 menit → sesi mati
SESSION_ABSOLUTE_SEC = 12 * 3600       # umur maksimum, walau aktif terus
SESSION_COOKIE       = 'sky_sid'
# last_seen tidak ditulis tiap permintaan: itu berarti satu tulisan DB untuk
# SETIAP request, hanya demi presisi detik yang tak seorang pun butuhkan.
SESSION_TOUCH_SEC    = 60

# ─── Kebijakan anti brute-force ───
LOGIN_WINDOW_SEC   = 15 * 60           # jendela pengamatan
LOGIN_MAX_PER_IP   = 10                # gagal per IP dalam jendela
LOGIN_MAX_PER_USER = 5                 # gagal per username dalam jendela
LOCKOUT_SEC        = 15 * 60           # lama kunci setelah kuota habis

# 'pelanggan' (2026-10-03): akun pelanggan untuk portal /pelanggan — hanya ONU miliknya
# sendiri (tabel akun_onu), tak pernah menyentuh panel. Pagarnya di pelanggan.py & server.py.
ROLES    = ('administrator', 'user', 'pelanggan')
STATUSES = ('aktif', 'nonaktif')

_lock      = threading.RLock()
_fail_ip   = {}            # ip   -> [timestamp gagal, ...]
_fail_user = {}            # user -> [timestamp gagal, ...]


# ═══════════════════════════════════════════════════════════════
#  Password
# ═══════════════════════════════════════════════════════════════
def hash_password(password):
    """Menghasilkan record hash mandiri (algoritma + parameter ikut disimpan,
    supaya parameter bisa dinaikkan kelak tanpa mematahkan hash lama)."""
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode('utf-8'), salt=salt,
                        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_LEN)
    return {
        'algo': 'scrypt',
        'n': SCRYPT_N, 'r': SCRYPT_R, 'p': SCRYPT_P,
        'salt': base64.b64encode(salt).decode(),
        'hash': base64.b64encode(dk).decode(),
    }


def verify_password(password, rec):
    """Perbandingan waktu-tetap. Record cacat/tak dikenal → False, bukan error."""
    try:
        if isinstance(rec, str):
            rec = json.loads(rec)
        if not rec or rec.get('algo') != 'scrypt':
            return False
        salt = base64.b64decode(rec['salt'])
        want = base64.b64decode(rec['hash'])
        dk = hashlib.scrypt(password.encode('utf-8'), salt=salt,
                            n=int(rec['n']), r=int(rec['r']), p=int(rec['p']),
                            dklen=len(want))
        return hmac.compare_digest(dk, want)
    except Exception:
        return False


def generate_password(length=16):
    """Password acak yang DIJAMIN lolos password_problem().

    Jangan pakai secrets.token_urlsafe() untuk ini: keluarannya acak dari
    [A-Za-z0-9_-], sehingga kadang tidak memuat 3 kelas karakter dan ditolak
    kebijakan kita sendiri — bootstrap jadi gagal secara acak.
    """
    import string
    lower, upper, digit = string.ascii_lowercase, string.ascii_uppercase, string.digits
    symbol = '!@#$%^&*?-_'
    pools = (lower, upper, digit, symbol)
    # Satu dari tiap kelas dulu → syarat pasti terpenuhi, sisanya acak penuh.
    chars = [secrets.choice(p) for p in pools]
    allc = ''.join(pools)
    chars += [secrets.choice(allc) for _ in range(max(0, length - len(pools)))]
    # Diaduk agar posisi kelas tidak tertebak dari urutannya.
    secrets.SystemRandom().shuffle(chars)
    return ''.join(chars)


def password_problem(pw):
    """Mengembalikan alasan penolakan, atau None bila password diterima."""
    if not isinstance(pw, str) or len(pw) < 10:
        return 'Password minimal 10 karakter'
    if len(pw) > 256:
        return 'Password maksimal 256 karakter'
    classes = sum(bool(re.search(p, pw)) for p in
                  (r'[a-z]', r'[A-Z]', r'\d', r'[^A-Za-z0-9]'))
    if classes < 3:
        return 'Password harus memuat minimal 3 dari: huruf kecil, huruf besar, angka, simbol'
    return None


# ═══════════════════════════════════════════════════════════════
#  Penyimpanan pengguna
# ═══════════════════════════════════════════════════════════════
def _row_to_user(r):
    """Baris DB → dict internal (masih memuat hash — jangan dikirim ke browser)."""
    if r is None:
        return None
    u = dict(r)
    try:
        u['pass'] = json.loads(u.pop('password_hash') or '{}')
    except Exception:
        u['pass'] = {}
    # Nama kunci lama dipertahankan agar sisa aplikasi tak perlu diubah.
    u['createdAt'] = u.pop('created_at', '')
    u['lastLogin'] = u.pop('last_login_at', '')
    u['updatedAt'] = u.pop('updated_at', '')
    return u


def _read_users():
    """Semua pengguna sebagai list dict internal (urut waktu dibuat)."""
    rows = db.conn().execute('SELECT * FROM users ORDER BY created_at, id').fetchall()
    return [_row_to_user(r) for r in rows]


def public_user(u):
    """Bentuk yang aman dikirim ke browser — TANPA hash/salt."""
    return {
        'id': u['id'], 'username': u['username'], 'name': u.get('name', ''),
        'email': u.get('email', ''), 'phone': u.get('phone', ''),
        'role': u.get('role', 'user'), 'status': u.get('status', 'aktif'),
        'avatar': u.get('avatar', ''),
        'createdAt': u.get('createdAt', ''), 'lastLogin': u.get('lastLogin', ''),
    }


def find_user(users, username):
    """Cari dalam list (kompatibilitas). Untuk lookup langsung pakai get_by_username."""
    ul = (username or '').strip().lower()
    for u in users:
        if u['username'].lower() == ul:
            return u
    return None


def find_by_id(users, uid):
    for u in users:
        if u['id'] == uid:
            return u
    return None


def get_by_username(username):
    r = db.conn().execute('SELECT * FROM users WHERE username=? COLLATE NOCASE',
                          ((username or '').strip(),)).fetchone()
    return _row_to_user(r)


def get_by_id(uid):
    r = db.conn().execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
    return _row_to_user(r)


def count_admins():
    r = db.conn().execute(
        "SELECT COUNT(*) AS n FROM users WHERE role='administrator' AND status='aktif'").fetchone()
    return r['n']


USERNAME_RE = re.compile(r'^[a-zA-Z0-9._-]{3,32}$')
EMAIL_RE    = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
PHONE_RE    = re.compile(r'^[0-9+\-\s()]{6,24}$')


def validate_profile(name, email, phone):
    if not (name or '').strip():
        return 'Nama tidak boleh kosong'
    if len(name) > 80:
        return 'Nama maksimal 80 karakter'
    if email and not EMAIL_RE.match(email):
        return 'Format email tidak valid'
    if phone and not PHONE_RE.match(phone):
        return 'Format no. HP tidak valid'
    return None


def create_user(username, password, name, email='', phone='', role='user',
                status='aktif', actor=None, ip=''):
    """Membuat pengguna. Melempar ValueError bila input ditolak."""
    with _lock:
        username = (username or '').strip()
        if not USERNAME_RE.match(username):
            raise ValueError('Username 3–32 karakter, hanya huruf/angka/titik/garis')
        if get_by_username(username):
            raise ValueError('Username sudah dipakai')
        if role not in ROLES:
            raise ValueError('Role tidak dikenal')
        if status not in STATUSES:
            raise ValueError('Status tidak dikenal')
        problem = password_problem(password)
        if problem:
            raise ValueError(problem)
        problem = validate_profile(name, email, phone)
        if problem:
            raise ValueError(problem)

        uid = secrets.token_hex(8)
        ts = db.now()
        c = db.conn()
        c.execute('''INSERT INTO users (id, username, name, email, phone, role, status,
                                        avatar, password_hash, created_at, updated_at, last_login_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                  (uid, username, name.strip(), (email or '').strip(), (phone or '').strip(),
                   role, status, '', json.dumps(hash_password(password)), ts, ts, ''))
        c.commit()
        u = get_by_id(uid)
        db.audit('account.create', f'username={username} role={role} status={status}',
                 actor, ip)
        return public_user(u)


def update_user(uid, fields, actor, ip=''):
    """Perubahan profil/username/role/status/password.

    Aturan wewenang (inti permintaan): administrator boleh mengubah SIAPA PUN;
    user biasa hanya boleh mengubah dirinya sendiri dan TIDAK boleh menyentuh
    role maupun status — kalau boleh, ia tinggal menaikkan dirinya jadi
    administrator, atau menonaktifkan orang lain.
    """
    with _lock:
        target = get_by_id(uid)
        if not target:
            raise ValueError('Pengguna tidak ditemukan')

        is_admin = actor.get('role') == 'administrator'
        is_self  = actor.get('id') == uid
        if not is_admin and not is_self:
            db.audit('access.denied',
                     f'percobaan mengubah pengguna lain (target={target["username"]})',
                     actor, ip)
            raise PermissionError('Hanya administrator yang dapat mengubah pengguna lain')

        changes = []

        # ── Role ──
        if 'role' in fields and fields['role'] != target.get('role'):
            if not is_admin:
                db.audit('access.denied', 'percobaan mengubah role sendiri', actor, ip)
                raise PermissionError('Hanya administrator yang dapat mengubah role')
            if fields['role'] not in ROLES:
                raise ValueError('Role tidak dikenal')
            # Jangan sampai admin terakhir hilang → panel terkunci selamanya.
            if target.get('role') == 'administrator' and count_admins() <= 1:
                raise ValueError('Tidak bisa menurunkan administrator terakhir')
            changes.append(f'role: {target["role"]} → {fields["role"]}')
            target['role'] = fields['role']

        # ── Status aktif/nonaktif ──
        if 'status' in fields and fields['status'] != target.get('status'):
            if not is_admin:
                db.audit('access.denied', 'percobaan mengubah status akun', actor, ip)
                raise PermissionError('Hanya administrator yang dapat mengubah status akun')
            if fields['status'] not in STATUSES:
                raise ValueError('Status tidak dikenal')
            if is_self and fields['status'] != 'aktif':
                raise ValueError('Tidak bisa menonaktifkan akun sendiri')
            # Menonaktifkan admin terakhir = mengunci panel, sama saja dengan
            # menurunkan role-nya. count_admins() hanya menghitung yang aktif.
            if (target.get('role') == 'administrator'
                    and target.get('status') == 'aktif'
                    and fields['status'] != 'aktif'
                    and count_admins() <= 1):
                raise ValueError('Tidak bisa menonaktifkan administrator terakhir')
            changes.append(f'status: {target["status"]} → {fields["status"]}')
            target['status'] = fields['status']

        # ── Username ──
        if 'username' in fields:
            newname = (fields['username'] or '').strip()
            if newname.lower() != target['username'].lower():
                if not USERNAME_RE.match(newname):
                    raise ValueError('Username 3–32 karakter, hanya huruf/angka/titik/garis')
                if get_by_username(newname):
                    raise ValueError('Username sudah dipakai')
                changes.append(f'username: {target["username"]} → {newname}')
            target['username'] = newname or target['username']

        # ── Profil ──
        name  = fields.get('name',  target.get('name', ''))
        email = fields.get('email', target.get('email', ''))
        phone = fields.get('phone', target.get('phone', ''))
        problem = validate_profile(name, email, phone)
        if problem:
            raise ValueError(problem)
        target['name'], target['email'], target['phone'] = (
            name.strip(), (email or '').strip(), (phone or '').strip())

        pass_json = None
        if fields.get('password'):
            # User biasa mengganti password SENDIRI wajib menyertakan password
            # lama; administrator boleh mereset milik orang lain tanpa itu.
            if is_self and not is_admin:
                if not verify_password(fields.get('currentPassword') or '', target['pass']):
                    raise PermissionError('Password lama salah')
            problem = password_problem(fields['password'])
            if problem:
                raise ValueError(problem)
            pass_json = json.dumps(hash_password(fields['password']))
            changes.append('password diganti')

        c = db.conn()
        if pass_json is None:
            c.execute('''UPDATE users SET username=?, name=?, email=?, phone=?,
                                          role=?, status=?, updated_at=? WHERE id=?''',
                      (target['username'], target['name'], target['email'], target['phone'],
                       target['role'], target['status'], db.now(), uid))
        else:
            c.execute('''UPDATE users SET username=?, name=?, email=?, phone=?,
                                          role=?, status=?, password_hash=?, updated_at=?
                         WHERE id=?''',
                      (target['username'], target['name'], target['email'], target['phone'],
                       target['role'], target['status'], pass_json, db.now(), uid))
        c.commit()

        if pass_json is not None:
            # Password berganti → semua sesi milik user itu dicabut. Kalau tidak,
            # sesi yang sudah dicuri tetap hidup meski password sudah diganti.
            destroy_user_sessions(uid)
        if target['status'] != 'aktif':
            # Akun dinonaktifkan tapi sesinya masih hidup = nonaktif yang tidak
            # menonaktifkan apa pun sampai sesinya kedaluwarsa sendiri.
            destroy_user_sessions(uid)

        if changes:
            db.audit('account.update',
                     f'target={target["username"]} · ' + '; '.join(changes), actor, ip)
        return public_user(get_by_id(uid))


def delete_user(uid, actor, ip=''):
    with _lock:
        if actor.get('role') != 'administrator':
            db.audit('access.denied', f'percobaan menghapus pengguna (id={uid})', actor, ip)
            raise PermissionError('Hanya administrator yang dapat menghapus pengguna')
        if actor.get('id') == uid:
            raise ValueError('Tidak bisa menghapus akun sendiri')
        target = get_by_id(uid)
        if not target:
            raise ValueError('Pengguna tidak ditemukan')
        # Tidak perlu cek "administrator terakhir" di sini: menghapus admin
        # menuntut pelakunya admin LAIN (dua aturan di atas), jadi selalu ada
        # ≥2 admin dan yang terakhir mustahil terhapus lewat jalur ini.
        # Admin terakhir tetap aman: hapus-diri-sendiri ditolak, dan
        # menurunkan/menonaktifkan admin terakhir ditolak di update_user().
        destroy_user_sessions(uid)
        # Audit ditulis SEBELUM baris user hilang: user_id di audit_log memakai
        # ON DELETE SET NULL, jadi jejaknya tetap ada (username tetap tercatat).
        db.audit('account.delete', f'target={target["username"]} role={target["role"]}',
                 actor, ip)
        c = db.conn()
        c.execute('DELETE FROM users WHERE id=?', (uid,))
        c.commit()
        return True


def list_users():
    return [public_user(u) for u in _read_users()]


# ═══════════════════════════════════════════════════════════════
#  Anti brute-force  (dipanggil SEBELUM hashing — lihat catatan modul)
# ═══════════════════════════════════════════════════════════════
def _prune(bucket, key, now):
    times = [t for t in bucket.get(key, []) if now - t < LOGIN_WINDOW_SEC]
    if times:
        bucket[key] = times
    else:
        bucket.pop(key, None)
    return times


def login_blocked(ip, username):
    """(diblokir?, sisa detik). Diperiksa sebelum password diverifikasi."""
    now = time.time()
    with _lock:
        ip_fails = _prune(_fail_ip, ip, now)
        us_fails = _prune(_fail_user, (username or '').lower(), now)
        if len(ip_fails) >= LOGIN_MAX_PER_IP:
            return True, int(LOCKOUT_SEC - (now - ip_fails[-1]))
        if len(us_fails) >= LOGIN_MAX_PER_USER:
            return True, int(LOCKOUT_SEC - (now - us_fails[-1]))
    return False, 0


def record_failure(ip, username):
    now = time.time()
    with _lock:
        _fail_ip.setdefault(ip, []).append(now)
        _fail_user.setdefault((username or '').lower(), []).append(now)


def clear_failures(ip, username):
    with _lock:
        _fail_ip.pop(ip, None)
        _fail_user.pop((username or '').lower(), None)


# ═══════════════════════════════════════════════════════════════
#  Sesi  (tabel `sessions`)
# ═══════════════════════════════════════════════════════════════
def create_session(user_id, ip, user_agent=''):
    token = secrets.token_urlsafe(32)          # 256 bit — tak bisa ditebak
    now = time.time()
    c = db.conn()
    c.execute('''INSERT INTO sessions (id, user_id, token, ip_address, user_agent,
                                       created_at, last_seen, expires_at)
                 VALUES (?,?,?,?,?,?,?,?)''',
              (secrets.token_hex(8), user_id, token, ip or '', (user_agent or '')[:255],
               now, now, now + SESSION_ABSOLUTE_SEC))
    c.commit()
    return token


def get_session_user(token):
    """Mengembalikan user publik + role, atau None bila sesi mati/kedaluwarsa."""
    if not token:
        return None
    now = time.time()
    c = db.conn()
    s = c.execute('SELECT * FROM sessions WHERE token=?', (token,)).fetchone()
    if not s:
        return None
    if now > s['expires_at'] or (now - s['last_seen']) > SESSION_IDLE_SEC:
        c.execute('DELETE FROM sessions WHERE token=?', (token,))
        c.commit()
        return None
    if now - s['last_seen'] > SESSION_TOUCH_SEC:
        c.execute('UPDATE sessions SET last_seen=? WHERE token=?', (now, token))
        c.commit()

    u = get_by_id(s['user_id'])
    if not u:                                   # user dihapus saat sesi hidup
        destroy_session(token)
        return None
    if u.get('status') != 'aktif':              # dinonaktifkan saat sesi hidup
        destroy_session(token)
        return None
    return public_user(u)


def destroy_session(token):
    if not token:
        return
    c = db.conn()
    c.execute('DELETE FROM sessions WHERE token=?', (token,))
    c.commit()


def destroy_user_sessions(uid):
    c = db.conn()
    c.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
    c.commit()


def destroy_all_sessions():
    c = db.conn()
    c.execute('DELETE FROM sessions')
    c.commit()


def list_sessions(uid=None):
    c = db.conn()
    if uid:
        rows = c.execute('SELECT * FROM sessions WHERE user_id=? ORDER BY last_seen DESC',
                         (uid,)).fetchall()
    else:
        rows = c.execute('SELECT * FROM sessions ORDER BY last_seen DESC').fetchall()
    return [dict(r) for r in rows]


def purge_expired_sessions():
    now = time.time()
    c = db.conn()
    c.execute('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?',
              (now, now - SESSION_IDLE_SEC))
    c.commit()


def touch_last_login(uid):
    c = db.conn()
    c.execute('UPDATE users SET last_login_at=? WHERE id=?', (db.now(), uid))
    c.commit()


def authenticate(username, password, ip, user_agent=''):
    """(user_publik, token) bila sukses; melempar PermissionError bila gagal.

    Pesan gagal sengaja sama untuk 'username tak ada', 'password salah', dan
    'akun nonaktif' — membedakannya sama saja memberi tahu penyerang username
    mana yang valid.
    """
    u = get_by_username(username)
    # Menu Log menyaring per akun & role: percobaan gagal pada akun yang MEMANG ADA dicatat
    # atas nama akun itu (tanpa user_id — tak ada sesi). Username karangan tetap hanya
    # tertulis di keterangan, supaya daftar saringan tak bisa dibanjiri penyerang.
    akun = (u['username'], u.get('role', '')) if u else None
    blocked, wait = login_blocked(ip, username)
    if blocked:
        db.audit('login.blocked', f'username={username}', None, ip, akun=akun)
        raise PermissionError(
            f'Terlalu banyak percobaan gagal. Coba lagi dalam {max(1, wait // 60)} menit.')

    ok = bool(u) and verify_password(password or '', u.get('pass'))
    if ok and u.get('status') != 'aktif':
        record_failure(ip, username)
        db.audit('login.failed', f'username={username} alasan=akun nonaktif', None, ip, akun=akun)
        raise PermissionError('Username atau password salah')
    if not ok:
        record_failure(ip, username)
        db.audit('login.failed', f'username={username}', None, ip, akun=akun)
        raise PermissionError('Username atau password salah')

    clear_failures(ip, username)
    touch_last_login(u['id'])
    token = create_session(u['id'], ip, user_agent)
    pub = public_user(get_by_id(u['id']))
    db.audit('login.success', f'username={u["username"]}', pub, ip)
    return pub, token


# ═══════════════════════════════════════════════════════════════
#  Bootstrap & impor dari format lama
# ═══════════════════════════════════════════════════════════════
def import_legacy_users():
    """Impor data/users.json → SQLite, sekali jalan.

    Ini bukan kemewahan: akun administrator yang sedang dipakai ADA di berkas
    itu. Tanpa impor, migrasi ke SQLite akan menghapus satu-satunya jalan masuk
    ke panel dan operator terkunci di luar.

    Hash password ikut dipindahkan apa adanya (formatnya sama), jadi password
    yang sudah dipakai tetap berlaku.
    """
    c = db.conn()
    if c.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']:
        return 0                      # sudah ada isinya → jangan timpa
    if not os.path.exists(USERS_PATH):
        return 0
    try:
        with open(USERS_PATH) as f:
            legacy = json.load(f)
        if not isinstance(legacy, list):
            return 0
    except Exception:
        return 0

    n = 0
    for u in legacy:
        try:
            ts = u.get('createdAt') or db.now()
            c.execute('''INSERT INTO users (id, username, name, email, phone, role, status,
                                            avatar, password_hash, created_at, updated_at,
                                            last_login_at)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                      (u.get('id') or secrets.token_hex(8), u['username'],
                       u.get('name', ''), u.get('email', ''), u.get('phone', ''),
                       u.get('role', 'user'), u.get('status', 'aktif'), u.get('avatar', ''),
                       json.dumps(u.get('pass') or {}), ts, ts, u.get('lastLogin', '')))
            n += 1
        except Exception:
            continue
    c.commit()
    if n:
        db.audit('system.migrate', f'{n} akun diimpor dari users.json ke SQLite')
        # Berkas lama diberi akhiran .imported supaya tidak terbaca lagi, tapi
        # TIDAK dihapus — bila ada yang salah, datanya masih ada untuk diperiksa.
        try:
            os.replace(USERS_PATH, USERS_PATH + '.imported')
        except Exception:
            pass
    return n


def ensure_bootstrap():
    """Saat pertama kali jalan, buat 1 administrator dengan password ACAK dan
    cetak ke konsol. Sengaja BUKAN admin/admin: kredensial default yang bisa
    ditebak adalah cara paling umum panel seperti ini dibobol."""
    db.init()
    if import_legacy_users():
        return None
    if db.conn().execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']:
        return None
    pw = generate_password(16)
    create_user('admin', pw, 'Administrator', role='administrator')
    return pw


# ═══════════════════════════════════════════════════════════════
#  Instalasi pertama  (2026-10-03)
# ═══════════════════════════════════════════════════════════════
# Dulu akun pertama dibuat otomatis ('admin' + password acak di FIRST_LOGIN.txt).
# Kini pemasang mengisi sendiri nama, email, username, dan password di halaman
# instalasi; akun itu menjadi administrator.
#
# BAHAYANYA: selama belum ada akun, siapa pun yang lebih dulu membuka panel bisa
# mengklaim jabatan administrator. Maka halaman instalasi hanya diterima
#   (a) dari komputer tempat panel dijalankan (loopback), ATAU
#   (b) dengan KODE INSTALASI sekali-pakai yang dicetak di terminal server dan
#       ditulis ke data/SETUP_CODE.txt — hanya orang yang memegang servernya
#       yang bisa membacanya.
# Begitu akun pertama ada, jalur ini tertutup selamanya (409).
SETUP_CODE_FILE = 'SETUP_CODE.txt'
_setup_code = None


def needs_setup():
    """True bila belum ada satu pun akun (panel baru dipasang)."""
    db.init()
    return not db.conn().execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']


def prepare_setup():
    """Dipanggil saat server mulai. Mengembalikan kode instalasi bila panel
    belum punya akun, atau None bila sudah. Akun lama (users.json) tetap
    diimpor dulu seperti sebelumnya."""
    global _setup_code
    db.init()
    import_legacy_users()
    if not needs_setup():
        _hapus_berkas_kode()
        _setup_code = None
        return None
    # Huruf besar + angka tanpa karakter yang mudah tertukar (0/O, 1/I/L).
    abjad = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    _setup_code = '-'.join(''.join(secrets.choice(abjad) for _ in range(4)) for _ in range(3))
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        p = os.path.join(DATA_DIR, SETUP_CODE_FILE)
        with open(p, 'w') as f:
            f.write('SKY ACS — kode instalasi (sekali pakai)\n'
                    '=======================================\n'
                    f'{_setup_code}\n\n'
                    'Dipakai di halaman instalasi bila panel dibuka dari komputer lain.\n'
                    'Berkas ini terhapus sendiri sesudah akun administrator dibuat.\n')
        os.chmod(p, 0o600)
    except Exception:
        pass          # kode tetap tercetak di terminal
    return _setup_code


def _hapus_berkas_kode():
    try:
        os.remove(os.path.join(DATA_DIR, SETUP_CODE_FILE))
    except OSError:
        pass


def setup_code_ok(kode):
    """Perbandingan waktu-tetap; kode kosong / belum disiapkan = selalu salah."""
    if not _setup_code or not isinstance(kode, str):
        return False
    bersih = kode.strip().upper().replace(' ', '')
    return hmac.compare_digest(bersih.encode(), _setup_code.encode())


def setup_first_admin(username, password, name, email='', ip=''):
    """Buat administrator PERTAMA. PermissionError bila sudah ada akun."""
    global _setup_code
    with _lock:
        if not needs_setup():
            raise PermissionError('Panel sudah punya akun administrator')
        u = create_user(username, password, name, email=email, role='administrator', ip=ip)
        _setup_code = None
        _hapus_berkas_kode()
        db.audit('system.setup', f'administrator pertama dibuat: {u["username"]}', u, ip)
        return u
