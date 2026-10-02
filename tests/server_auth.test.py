#!/usr/bin/env python3
"""Uji lapisan auth di server.py lewat HTTP sungguhan.

auth.py sudah diuji terpisah. Yang diuji DI SINI adalah sambungannya: apakah
rute benar-benar terkunci. Ini yang menentukan, karena sebelum ada auth,
siapa pun yang menjangkau port panel bisa memanggil /api/* dan mengendalikan
1742 ONU tanpa kredensial.
"""
import os, sys, json, time, socket, tempfile, threading, subprocess
import urllib.request, urllib.error, http.cookiejar

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

PORT = free_port()
TMP  = tempfile.mkdtemp(prefix='skysrv-')

# Server dijalankan sebagai proses terpisah dengan DATA_DIR sementara, supaya
# database asli tidak tersentuh.
boot = f'''
import sys, os
sys.path.insert(0, {os.path.join(ROOT, 'backend')!r})
import db, auth
auth.DATA_DIR   = {TMP!r}
auth.USERS_PATH = os.path.join({TMP!r}, 'users.json')
db.set_path(os.path.join({TMP!r}, 'sky.db'))
pw = auth.ensure_bootstrap()
print('BOOTPW=' + pw, flush=True)
import server
server.auth = auth
srv = server.ThreadingHTTPServer(('127.0.0.1', {PORT}), server.SPAHandler)
srv.daemon_threads = True
srv.serve_forever()
'''
proc = subprocess.Popen([sys.executable, '-c', boot], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, cwd=ROOT)
BOOTPW = None
t0 = time.time()
while time.time() - t0 < 15:
    line = proc.stdout.readline()
    if line.startswith('BOOTPW='):
        BOOTPW = line.strip().split('=', 1)[1]
        break
    if proc.poll() is not None:
        print('server mati saat start:\n' + proc.stdout.read()); sys.exit(1)
if not BOOTPW:
    print('gagal membaca password bootstrap'); proc.kill(); sys.exit(1)

# Tunggu port siap
for _ in range(60):
    try:
        s = socket.create_connection(('127.0.0.1', PORT), 0.3); s.close(); break
    except Exception: time.sleep(0.1)

BASE = f'http://127.0.0.1:{PORT}'

def call(path, method='GET', data=None, opener=None, ):
    req = urllib.request.Request(BASE + path, method=method)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header('Content-Type', 'application/json')
    op = opener or urllib.request.build_opener()
    try:
        r = op.open(req, body, timeout=8)
        raw = r.read().decode()
        try: return r.status, json.loads(raw)
        except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw

try:
    # ── TANPA login: semua jalur data harus tertutup ──
    for path, method in [('/api/devices', 'GET'), ('/api/devices/x', 'DELETE'),
                         ('/api', 'GET'), ('/config', 'GET'), ('/config', 'POST'),
                         ('/auth/users', 'GET'), ('/auth/me', 'GET')]:
        code, _ = call(path, method, data={} if method == 'POST' else None)
        ok(code == 401, f'tanpa login {method} {path} → 401 (dapat {code})')

    # ── index.html tetap boleh (kalau tidak, halaman login tak bisa dimuat) ──
    code, _ = call('/')
    ok(code == 200, 'halaman / tetap dapat dimuat tanpa login (untuk layar login)')

    # ── Login salah ──
    code, body = call('/auth/login', 'POST', {'username': 'admin', 'password': 'salah'})
    ok(code == 401, 'login password salah → 401')
    ok('salah' in str(body.get('error', '')).lower(), 'pesan gagal login jelas')

    # ── Login benar → dapat cookie ──
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    code, body = call('/auth/login', 'POST', {'username': 'admin', 'password': BOOTPW}, opener=op)
    ok(code == 200 and body['user']['role'] == 'administrator', 'login benar → 200 + user admin')
    ok('pass' not in str(body), 'respons login tidak memuat hash password')

    cookie = next((c for c in cj if c.name == 'sky_sid'), None)
    ok(cookie is not None, 'cookie sesi dikirim')

    # ── Cookie sesi HARUS berupa cookie-sesi browser: TANPA Max-Age/Expires ──
    # Ini yang membuat "tutup browser → buka lagi → login", bukan langsung
    # dasbor. Kalau ada Max-Age, cookie jadi persisten dan bertahan melewati
    # penutupan browser — persis bug yang diperbaiki. Header dibaca mentah
    # karena CookieJar tidak mengekspos Max-Age apa adanya.
    def raw_setcookie(path, data):
        req = urllib.request.Request(BASE + path, method='POST',
                                     data=json.dumps(data).encode())
        req.add_header('Content-Type', 'application/json')
        try:
            r = urllib.request.build_opener().open(req, timeout=8)
            return r.headers.get_all('Set-Cookie') or []
        except urllib.error.HTTPError as e:
            return e.headers.get_all('Set-Cookie') or []

    login_sc = ' '.join(raw_setcookie('/auth/login',
                        {'username': 'admin', 'password': BOOTPW}))
    ok('sky_sid=' in login_sc, 'login mengirim Set-Cookie sky_sid')
    ok('Max-Age' not in login_sc and 'max-age' not in login_sc.lower(),
       'cookie sesi TANPA Max-Age (cookie-sesi, hilang saat browser ditutup)')
    ok('Expires' not in login_sc,
       'cookie sesi TANPA Expires (bukan cookie persisten)')
    ok('HttpOnly' in login_sc, 'cookie sesi HttpOnly (XSS tak bisa mencurinya)')
    ok('SameSite=Strict' in login_sc, 'cookie sesi SameSite=Strict (CSRF tertutup)')

    # ── Logout harus MENGHAPUS cookie: Max-Age=0 ──
    logout_sc = ' '.join(raw_setcookie('/auth/logout', {}))
    ok('Max-Age=0' in logout_sc.replace(' ', '') or 'Max-Age=0' in logout_sc,
       'logout memasang Max-Age=0 untuk menghapus cookie seketika')

    # ── Header keamanan pada respons panel ──
    def headers_of(path):
        try:
            r = urllib.request.build_opener().open(BASE + path, timeout=8)
            return dict(r.headers)
        except urllib.error.HTTPError as e:
            return dict(e.headers)
    h = headers_of('/')
    ok(h.get('X-Content-Type-Options', '').lower() == 'nosniff',
       'X-Content-Type-Options: nosniff (browser tak menebak tipe konten)')
    ok(h.get('X-Frame-Options', '').upper() == 'SAMEORIGIN',
       'X-Frame-Options: SAMEORIGIN (anti-clickjacking)')
    ok('no-referrer' in h.get('Referrer-Policy', '').lower(),
       'Referrer-Policy: no-referrer (URL panel tak bocor ke situs luar)')

    # ── Dengan sesi: /auth/me jalan ──
    code, body = call('/auth/me', opener=op)
    ok(code == 200 and body['user']['username'] == 'admin', 'sesi valid → /auth/me 200')

    # ── /config kini boleh dibaca ──
    code, _ = call('/config', opener=op)
    ok(code == 200, 'sesi valid → /config 200')

    # ── Routing sticky ONU lewat Referer ──
    # SPA admin ONU (mis. C-DATA) memuat aset & API lewat path ABSOLUT dari root
    # ('/js/app.js'). Referer dokumennya /onu/<id>/ mengembalikannya ke ONU.
    def get_ref(path, referer=None):
        req = urllib.request.Request(BASE + path, method='GET')
        if referer:
            req.add_header('Referer', BASE + referer)
        try:
            r = op.open(req, timeout=10); return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    # /js/main.js TANPA Referer ONU → panel menyajikan berkasnya sendiri (JS asli).
    s_plain, b_plain = get_ref('/js/main.js')
    ok(s_plain == 200 and b'function' in b_plain and len(b_plain) > 2000,
       'aset panel /js/main.js (tanpa Referer ONU) → JS panel asli, TAK terbajak')

    # /js/main.js DENGAN Referer /onu/<id-palsu>/ → dirutekan ke ONU; id tak ada
    # di GenieACS → halaman galat ONU (🔌), BUKAN main.js panel. Membuktikan
    # request path-absolut sungguh berbelok ke jalur ONU.
    s_ref, b_ref = get_ref('/js/main.js', referer='/onu/TIDAKADA-XYZ/index.html')
    ok(b_ref != b_plain and b'function' not in b_ref[:200],
       'Referer /onu/ MEMBELOKKAN /js/main.js ke jalur ONU (bukan aset panel)')
    ok(('ONU' in b_ref.decode('utf-8', 'replace')) or s_ref in (404, 502, 403),
       'id ONU tak dikenal → halaman galat ONU, bukan dasbor panel')

    # KESELAMATAN: jalur milik panel TAK PERNAH dibajak walau Referer /onu/.
    req = urllib.request.Request(BASE + '/auth/me')
    req.add_header('Referer', BASE + '/onu/TIDAKADA-XYZ/index.html')
    r = op.open(req, timeout=10); me = json.loads(r.read())
    ok(me.get('user', {}).get('username') == 'admin',
       '/auth/me dengan Referer /onu/ tetap ditangani PANEL (jalur panel tak terbajak)')

    # ── Buat user biasa ──
    code, body = call('/auth/users', 'POST',
                      {'username': 'budi', 'password': 'Budi#Kuat2026', 'name': 'Budi',
                       'email': 'budi@x.id', 'phone': '081234567890', 'role': 'user'}, opener=op)
    ok(code == 200 and body['user']['role'] == 'user', 'admin membuat user biasa → 200')

    # ── Sesi user biasa ──
    cj2 = http.cookiejar.CookieJar()
    op2 = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj2))
    code, _ = call('/auth/login', 'POST', {'username': 'budi', 'password': 'Budi#Kuat2026'}, opener=op2)
    ok(code == 200, 'user biasa bisa login')

    # user biasa TIDAK boleh melihat daftar user
    code, _ = call('/auth/users', opener=op2)
    ok(code == 403, 'user biasa → /auth/users 403')
    # user biasa TIDAK boleh membuat user
    code, _ = call('/auth/users', 'POST', {'username': 'x1y2', 'password': 'Kuat#Sekali9', 'name': 'X'}, opener=op2)
    ok(code == 403, 'user biasa → buat user 403')
    # user biasa TIDAK boleh mengubah konfigurasi ACS
    code, _ = call('/config', 'POST', {'acsUrl': 'http://127.0.0.1:7557'}, opener=op2)
    ok(code == 403, 'user biasa → ubah config ACS 403')
    # tapi user biasa TETAP boleh memakai data ONU (full akses operasional)
    code, _ = call('/config', opener=op2)
    ok(code == 200, 'user biasa TETAP bisa baca /config (akses operasional penuh)')

    # ── Logout mencabut sesi ──
    code, _ = call('/auth/logout', 'POST', {}, opener=op2)
    ok(code == 200, 'logout → 200')
    code, _ = call('/auth/me', opener=op2)
    ok(code == 401, 'setelah logout, sesi mati → 401')

    # ── Body raksasa ditolak (pelindung RAM) ──
    big = 'a' * (300 * 1024)
    code, _ = call('/auth/login', 'POST', {'username': big, 'password': big})
    ok(code in (400, 401), f'body > MAX_BODY tidak menjatuhkan server (dapat {code})')

    # ── Server masih hidup setelah semua itu ──
    code, _ = call('/')
    ok(code == 200, 'server tetap sehat di akhir pengujian')

finally:
    proc.kill()

print('server_auth: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
