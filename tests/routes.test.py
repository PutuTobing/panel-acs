#!/usr/bin/env python3
"""Uji perutean SPA vs API — penjaga tabrakan alamat.

KENAPA BERKAS INI ADA (bug nyata, bukan hipotesis):

  Endpoint pengaturan sempat dipasang di '/settings'. Padahal '/settings' juga
  ALAMAT HALAMAN Settings di SPA (lihat pageToPath di main.js). Selama pengguna
  menavigasi di dalam aplikasi, halaman dimuat lewat JS sehingga semuanya tampak
  normal — tapi begitu pengguna menekan Ctrl+R di halaman Settings, browser
  meminta '/settings' ke server dan server menjawab JSON mentah. Panelnya lenyap,
  berganti tumpukan JSON.

  Tak satu pun tes yang ada menangkapnya: semuanya memanggil endpoint lewat
  fetch, tak ada yang MEMUAT HALAMAN seperti browser sungguhan.

  Jadi yang dijaga di sini: setiap rute SPA harus mengembalikan HTML, dan setiap
  endpoint API harus mengembalikan JSON. Dua ruang nama itu tidak boleh
  bertabrakan lagi.
"""
import os, sys, json, time, socket, tempfile, subprocess, re
import urllib.request, urllib.error, http.cookiejar

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)

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
TMP  = tempfile.mkdtemp(prefix='skyroute-')

boot = f'''
import sys, os
sys.path.insert(0, {ROOT!r})
import db, auth
auth.DATA_DIR   = {TMP!r}
auth.USERS_PATH = os.path.join({TMP!r}, 'users.json')
db.set_path(os.path.join({TMP!r}, 'sky.db'))
pw = auth.ensure_bootstrap()
print('BOOTPW=' + pw, flush=True)
import server
srv = server.ThreadingHTTPServer(('127.0.0.1', {PORT}), server.SPAHandler)
srv.daemon_threads = True
srv.serve_forever()
'''
env = dict(os.environ, SKY_CONFIG=os.path.join(TMP, 'config.json'))
proc = subprocess.Popen([sys.executable, '-c', boot], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, cwd=ROOT, env=env)
BOOTPW = None
t0 = time.time()
while time.time() - t0 < 15:
    line = proc.stdout.readline()
    if line.startswith('BOOTPW='):
        BOOTPW = line.strip().split('=', 1)[1]; break
    if proc.poll() is not None:
        print('server mati:\n' + proc.stdout.read()); sys.exit(1)
if not BOOTPW:
    print('gagal baca bootstrap'); proc.kill(); sys.exit(1)
for _ in range(60):
    try:
        socket.create_connection(('127.0.0.1', PORT), 0.25).close(); break
    except OSError:
        time.sleep(0.1)

BASE = f'http://127.0.0.1:{PORT}'
cj = http.cookiejar.CookieJar()
OP = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def get(path, accept='text/html'):
    """Ambil sebuah path PERSIS seperti browser saat memuat/refresh halaman."""
    req = urllib.request.Request(BASE + path, method='GET')
    req.add_header('Accept', accept)
    try:
        with OP.open(req, timeout=10) as r:
            return r.status, r.headers.get('Content-Type', ''), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', ''), e.read().decode('utf-8', 'replace')


def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    try:
        with OP.open(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}


try:
    st, _ = post('/auth/login', {'username': 'admin', 'password': BOOTPW})
    ok(st == 200, 'login berhasil')

    # ── Rute SPA: sumber kebenarannya pageToPath() di main.js ──
    main_js = open(os.path.join(ROOT, 'js', 'main.js')).read()
    m = re.search(r'const map = \{([^}]*)\}', main_js)
    ok(bool(m), 'peta rute SPA ditemukan di main.js')
    spa_paths = re.findall(r"'(/[^']*)'", m.group(1)) if m else []
    ok(len(spa_paths) >= 4, 'rute SPA terbaca dari main.js: %r' % spa_paths)

    # Setiap rute SPA HARUS mengembalikan HTML aplikasi — inilah yang gagal.
    for p in spa_paths + ['/', '/devices/688AF0-F663NV9-ZTEGCACBC9E4']:
        st, ct, body = get(p)
        ok(st == 200, 'GET %s → 200' % p)
        ok('text/html' in ct, 'GET %s → Content-Type HTML, bukan %r' % (p, ct))
        ok('<div class="app-layout"' in body,
           'GET %s mengembalikan aplikasi (refresh browser tidak rusak)' % p)
        ok(not body.lstrip().startswith('{'),
           'GET %s TIDAK mengembalikan JSON mentah — bug tabrakan /settings' % p)

    # ── Endpoint API harus JSON ──
    for p in ('/config', '/config/all', '/config/about'):
        st, ct, body = get(p, accept='application/json')
        ok(st == 200, 'GET %s → 200' % p)
        ok('application/json' in ct, 'GET %s → JSON' % p)
        try:
            json.loads(body); parsed = True
        except Exception:
            parsed = False
        ok(parsed, 'GET %s body JSON valid' % p)

    # ── Inti penjaga: API dan rute SPA tidak boleh saling menimpa ──
    # Diambil dari konstanta server, bukan ditulis ulang, supaya penjaga ini
    # ikut bergerak bila prefix-nya diubah lagi.
    import server as srv_mod
    api_prefixes = [srv_mod.API_PREFIX, srv_mod.AUTH_PREFIX,
                    srv_mod.CONFIG_PREFIX, srv_mod.SETTINGS_PREFIX]
    for pref in api_prefixes:
        clean = '/' + pref.strip('/')
        ok(clean not in spa_paths,
           'prefix API %r tidak menabrak rute SPA %r' % (pref, spa_paths))

    ok(srv_mod.SETTINGS_PREFIX.rstrip('/') != '/settings',
       'endpoint pengaturan TIDAK dipasang di /settings (alamat halaman SPA)')

    # ── Aset statis tetap statis, bukan tertelan fallback SPA ──
    for p, want in (('/js/main.js', 'javascript'), ('/css/base.css', 'css')):
        st, ct, _ = get(p)
        ok(st == 200 and want in ct, 'aset %s dilayani apa adanya (%s)' % (p, ct))

    # Path tak dikenal → aplikasi (SPA routing), bukan 404 kosong.
    st, ct, body = get('/halaman-yang-tidak-ada')
    ok(st == 200 and '<div class="app-layout"' in body,
       'path tak dikenal jatuh ke aplikasi, bukan 404 telanjang')

    # ── Tanpa login, halaman tetap terkirim (login digambar klien) ──
    anon = urllib.request.build_opener()
    req = urllib.request.Request(BASE + '/settings', method='GET')
    # Dibungkus try: bila /settings kembali ditabrak API, ia menjawab 401 dan
    # urllib melempar. Tanpa penanganan ini, tesnya MELEDAK alih-alih gagal
    # dengan rapi — dan tes yang meledak menyembunyikan hasil tes lain di
    # bawahnya, persis saat kita paling butuh membaca semuanya.
    try:
        with anon.open(req, timeout=10) as r:
            body = r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        body = '<HTTP %d — /settings dijawab API, bukan halaman>' % e.code
    ok('loginScreen' in body,
       'tanpa sesi, /settings tetap mengirim aplikasi berisi layar login')
    # Tapi DATA-nya tetap terkunci.
    req = urllib.request.Request(BASE + '/config/all', method='GET')
    try:
        anon.open(req, timeout=10); code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    ok(code == 401, 'tanpa sesi, /config/all tetap 401 (halaman boleh, data tidak)')

finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print('routes: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
