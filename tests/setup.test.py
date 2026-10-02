#!/usr/bin/env python3
"""Uji instalasi pertama: halaman pembuatan administrator pertama (2026-10-03).

Dulu akun pertama dibuat otomatis ('admin' + password acak di FIRST_LOGIN.txt).
Kini pemasang mengisi sendiri nama, email, username dan password.

BAHAYA YANG DIJAGA: selama belum ada akun, siapa pun yang lebih dulu membuka panel
bisa mengklaim jabatan administrator. Maka:
  1. Hanya diterima dari komputer tempat panel berjalan (loopback), ATAU dengan kode
     instalasi sekali-pakai yang hanya terbaca oleh pemegang server.
  2. Tebakan kode dibatasi seperti login.
  3. Begitu akun pertama ada, jalur ini tertutup (409) — selamanya.
  4. Password tetap melewati kebijakan yang sama dengan akun lain.
"""
import os, sys, json, tempfile, threading, http.client
from http.server import ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db, auth
TMP = tempfile.mkdtemp(prefix='skysetup-')
auth.DATA_DIR = TMP
db.set_path(os.path.join(TMP, 'sky.db'))
import server

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

KODE_FILE = os.path.join(TMP, auth.SETUP_CODE_FILE)
SAH = {'name': 'Putu Tobing', 'email': 'putu@sky.co.id', 'username': 'putu.admin', 'password': 'Rahasia-Kuat-2026'}

# ══ 1. Persiapan saat server mulai ══
ok(auth.needs_setup() is True, 'DB baru → perlu instalasi')
kode = auth.prepare_setup()
ok(isinstance(kode, str) and len(kode) == 14 and kode.count('-') == 2, 'kode instalasi dibuat (XXXX-XXXX-XXXX)')
ok(os.path.isfile(KODE_FILE) and kode in open(KODE_FILE).read(), 'kode juga ditulis ke data/SETUP_CODE.txt')
ok(auth.setup_code_ok(kode) and auth.setup_code_ok(' ' + kode.lower() + ' '), 'kode benar diterima (spasi/huruf kecil ditoleransi)')
ok(not auth.setup_code_ok('') and not auth.setup_code_ok(None) and not auth.setup_code_ok('AAAA-AAAA-AAAA'), 'kode kosong/salah ditolak')
ok(db.conn().execute('SELECT COUNT(*) AS n FROM users').fetchone()['n'] == 0, 'TIDAK ada akun bawaan yang dibuat otomatis')

# ══ 2. Lewat server ══
server.SPAHandler.log_message = lambda *a, **k: None
lokal = {'v': True}
server.SPAHandler._dari_loopback = lambda self: lokal['v']
srv = ThreadingHTTPServer(('127.0.0.1', 0), server.SPAHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
def minta(metode, path, body=None, cookie=None):
    c = http.client.HTTPConnection('127.0.0.1', srv.server_address[1], timeout=20)
    h = {'Content-Type': 'application/json'}
    if cookie: h['Cookie'] = cookie
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse(); raw = r.read(); sc = r.getheader('Set-Cookie'); c.close()
    try: d = json.loads(raw or b'{}')
    except Exception: d = {}
    return r.status, d, sc
try:
    st, d, _ = minta('GET', '/auth/setup')
    ok(st == 200 and d == {'perlu': True, 'butuhKode': False}, 'status: perlu instalasi; dari komputer server tak butuh kode')
    lokal['v'] = False
    st, d, _ = minta('GET', '/auth/setup')
    ok(d.get('butuhKode') is True, 'dari komputer lain → butuh kode')

    # dari komputer lain tanpa / dengan kode salah
    st, d, _ = minta('POST', '/auth/setup', SAH)
    ok(st == 403 and auth.needs_setup(), 'komputer lain TANPA kode → 403, akun tidak dibuat')
    st, d, _ = minta('POST', '/auth/setup', dict(SAH, code='ZZZZ-ZZZZ-ZZZZ'))
    ok(st == 403 and auth.needs_setup(), 'kode salah → 403')
    kodes = [minta('POST', '/auth/setup', dict(SAH, code='QQQQ-QQQQ-QQQ%d' % i))[0] for i in range(12)]
    ok(429 in kodes, 'tebakan kode dibatasi (429 sesudah beberapa kali)')
    st, d, _ = minta('POST', '/auth/setup', dict(SAH, code=kode))
    ok(st == 429 and auth.needs_setup(), 'selama diblokir, kode benar pun ditahan')
    auth.clear_failures('127.0.0.1', '__setup__')

    # isian tak sah
    st, d, _ = minta('POST', '/auth/setup', dict(SAH, code=kode, password='pendek'))
    ok(st == 400 and 'Password' in d.get('error', '') and auth.needs_setup(), 'password lemah → 400 (kebijakan yang sama)')
    st, d, _ = minta('POST', '/auth/setup', dict(SAH, code=kode, username='a b'))
    ok(st == 400 and auth.needs_setup(), 'username tak sah → 400')

    # berhasil dengan kode
    st, d, sc = minta('POST', '/auth/setup', dict(SAH, code=kode))
    ok(st == 200 and d['user']['role'] == 'administrator' and d['user']['username'] == 'putu.admin'
       and d['user']['name'] == 'Putu Tobing' and d['user']['email'] == 'putu@sky.co.id', 'akun pertama dibuat sebagai administrator')
    ok(sc and auth.SESSION_COOKIE in sc and 'HttpOnly' in sc, 'langsung masuk (cookie sesi HttpOnly)')
    ok('password' not in json.dumps(d).lower() or 'password_hash' not in json.dumps(d), 'jawaban tidak memuat hash password')
    st2, d2, _ = minta('GET', '/auth/me', cookie=sc.split(';')[0])
    ok(st2 == 200 and d2['user']['username'] == 'putu.admin', 'sesi dari instalasi berlaku')
    ok(not os.path.exists(KODE_FILE) and not auth.setup_code_ok(kode), 'kode instalasi hangus & berkasnya terhapus')

    # tertutup selamanya
    lokal['v'] = True
    st, d, _ = minta('GET', '/auth/setup')
    ok(d == {'perlu': False, 'butuhKode': False}, 'status: tidak perlu instalasi lagi')
    st, d, _ = minta('POST', '/auth/setup', dict(SAH, username='penyusup', code=kode))
    ok(st == 409 and auth.get_by_username('penyusup') is None, 'instalasi kedua DITOLAK (409), walau dari komputer server')
    n_admin = db.conn().execute("SELECT COUNT(*) AS n FROM users").fetchone()['n']
    ok(n_admin == 1, 'tetap hanya satu akun')
    aksi = [r['action'] for r in db.conn().execute('SELECT action FROM audit_log').fetchall()]
    ok('system.setup' in aksi and 'system.setup.denied' in aksi, 'instalasi & percobaan ditolak tercatat di audit log')
    # login biasa dengan akun itu
    st, d, _ = minta('POST', '/auth/login', {'username': 'putu.admin', 'password': SAH['password']})
    ok(st == 200, 'bisa login dengan akun yang dibuat')
finally:
    srv.shutdown()

ok(auth.prepare_setup() is None, 'sesudah ada akun, server tidak lagi membuat kode instalasi')

# ══ 3. Sisi browser & server utama ══
html = open(os.path.join(ROOT, 'frontend', 'index.html'), encoding='utf-8').read()
js   = open(os.path.join(ROOT, 'frontend', 'js', 'main.js'), encoding='utf-8').read()
src  = open(os.path.join(ROOT, 'backend', 'server.py'), encoding='utf-8').read()
for i in ('setupScreen', 'setupForm', 'setupName', 'setupEmail', 'setupUser', 'setupPass', 'setupPass2', 'setupCode', 'setupError', 'setupBtn'):
    ok('id="%s"' % i in html, 'elemen #%s ada di index.html' % i)
ok('<link rel="icon" type="image/png" href="/pages/gambar/SKY%20ICON.png">' in html, 'favicon memakai logo SKY ICON.png')
ok(os.path.isfile(os.path.join(ROOT, 'frontend', 'pages', 'gambar', 'SKY ICON.png')), 'berkas logo ada')
ok("authFetch('/auth/setup')" in js and 'initSetupForm();' in js and "showSetup(true, !!s.butuhKode)" in js, 'browser menanyakan status instalasi saat belum login')
ok('auth.prepare_setup()' in src and 'ensure_bootstrap()' not in src and 'FIRST_LOGIN' not in src,
   'server tidak lagi membuat akun bawaan / FIRST_LOGIN.txt')

print(f'setup: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
