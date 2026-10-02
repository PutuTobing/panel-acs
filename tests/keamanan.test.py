#!/usr/bin/env python3
"""Uji keamanan lapisan HTTP panel (2026-10-03).

BAHAYA YANG DIJAGA:
  1. Permintaan dari SITUS/ORIGIN LAIN. Dulu server memantulkan Origin apa pun bersama
     Access-Control-Allow-Credentials, dan /api menjawab Access-Control-Allow-Origin: *.
     Cookie SameSite=Strict menahan situs luar, tetapi tidak menahan origin "satu situs"
     (port lain di alamat yang sama, mis. UI GenieACS :3000): skrip di sana bisa memakai
     sesi operator untuk memerintah ONU. Kini ditolak (Sec-Fetch-Site / Origin).
  2. Penyadapan. Panel bisa melayani HTTPS sendiri bila ada sertifikat; cookie sesi lalu
     ber-Secure dan browser diberi HSTS.
  3. Header keamanan: CSP daftar-izin, Permissions-Policy, CORP — hanya pada halaman
     panel, tidak pada halaman ONU yang diteruskan proxy.
  4. Pustaka dari CDN dikunci SRI; pesan toast & legenda dashboard tidak lagi HTML mentah.

Memakai DB sementara; tidak menyentuh data/sky.db maupun GenieACS.
"""
import os, sys, json, tempfile, threading, http.client, ssl, shutil, re
from http.server import ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import db, auth
TMP = tempfile.mkdtemp(prefix='skyaman-')
auth.DATA_DIR = TMP
db.set_path(os.path.join(TMP, 'sky.db'))
import server
import buat_sertifikat

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

db.init()
auth.create_user('penguji', 'Rahasia-Kuat-2026', 'Penguji', role='administrator')
server.SPAHandler.log_message = lambda *a, **k: None
# Alamat GenieACS diarahkan ke port MATI di komputer ini. Tanpa ini panel uji memakai
# bawaan 127.0.0.1:7557 — yang di laptop operator kadang diteruskan ke GenieACS PRODUKSI.
# Uji tidak boleh bertanya ke sana sama sekali, bahkan sekadar membaca.
import socket as _sk, config_store
_s = _sk.socket(); _s.bind(('127.0.0.1', 0)); _port_mati = _s.getsockname()[1]; _s.close()
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': _port_mati, 'base_path': ''})
ok(str(_port_mati) in server.get_genieacs_url() and ':7557' not in server.get_genieacs_url(),
   'uji memakai alamat GenieACS tiruan (port mati), bukan 127.0.0.1:7557')

def jalankan(srv):
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]

def minta(port, metode, path, body=None, header=None, tls=None):
    if tls:
        c = http.client.HTTPSConnection('127.0.0.1', port, timeout=20, context=tls)
    else:
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
    h = {'Content-Type': 'application/json'}
    h.update(header or {})
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse(); raw = r.read(); hd = {k.lower(): v for k, v in r.getheaders()}
    sc = r.getheader('Set-Cookie'); c.close()
    try: d = json.loads(raw or b'{}')
    except Exception: d = {}
    return r.status, d, hd, sc

LOGIN = {'username': 'penguji', 'password': 'Rahasia-Kuat-2026'}

# ══ 1. Permintaan lintas-situs ══
srv = server.buat_server('127.0.0.1', 0)
ok(not server._TLS_AKTIF, 'tanpa sertifikat → HTTP polos seperti dulu')
port = jalankan(srv)
asal = 'http://127.0.0.1:%d' % port
try:
    st, d, hd, sc = minta(port, 'POST', '/auth/login', LOGIN)
    ok(st == 200 and sc and 'HttpOnly' in sc and 'SameSite=Strict' in sc, 'login biasa (tanpa header browser) tetap jalan')
    ok('Secure' not in (sc or ''), 'HTTP polos → cookie TANPA Secure (kalau ada, login akan gagal terus)')
    ck = {'Cookie': sc.split(';')[0]}
    ok(not any(k.startswith('access-control-') for k in hd), 'jawaban API tidak memuat header CORS apa pun')

    st, d, hd, _ = minta(port, 'GET', '/auth/me', None, dict(ck, **{'Sec-Fetch-Site': 'same-origin', 'Origin': asal}))
    ok(st == 200, 'dari panel sendiri (same-origin) → diterima')
    for sfs in ('cross-site', 'same-site'):
        st, d, hd, _ = minta(port, 'GET', '/auth/me', None, dict(ck, **{'Sec-Fetch-Site': sfs}))
        ok(st == 403 and 'situs lain' in d.get('error', ''), 'Sec-Fetch-Site: %s → 403 (GET pun ditolak)' % sfs)
        st, d, hd, _ = minta(port, 'POST', '/auth/login', LOGIN, {'Sec-Fetch-Site': sfs})
        ok(st == 403, 'Sec-Fetch-Site: %s → login ditolak (login CSRF)' % sfs)
    st, d, hd, _ = minta(port, 'GET', '/api/devices', None, dict(ck, **{'Sec-Fetch-Site': 'cross-site'}))
    ok(st == 403, '/api dari situs lain → 403 (sebelum sampai ke GenieACS)')
    st, d, hd, _ = minta(port, 'POST', '/config/vendor-profiles', {'kind': 'wan', 'daftar': []},
                         dict(ck, **{'Sec-Fetch-Site': 'same-site'}))
    ok(st == 403, '/config dari port lain di alamat yang sama (same-site) → 403')

    # Browser lama tanpa Sec-Fetch-Site: Origin yang dipakai
    st, d, hd, _ = minta(port, 'POST', '/auth/login', LOGIN, {'Origin': 'http://evil.example'})
    ok(st == 403, 'POST ber-Origin situs lain → 403')
    st, d, hd, _ = minta(port, 'POST', '/auth/login', LOGIN, {'Origin': 'null'})
    ok(st == 403, "POST ber-Origin 'null' (iframe sandbox / berkas lokal) → 403")
    st, d, hd, _ = minta(port, 'POST', '/auth/login', LOGIN, {'Origin': 'http://127.0.0.1:%d' % (port + 1)})
    ok(st == 403, 'POST dari port lain di alamat yang sama → 403')
    st, d, hd, _ = minta(port, 'POST', '/auth/login', LOGIN, {'Origin': asal})
    ok(st == 200, 'POST ber-Origin alamat panel sendiri → diterima')
    st, d, hd, _ = minta(port, 'POST', '/auth/login', LOGIN,
                         {'Origin': 'https://panel.contoh', 'X-Forwarded-Host': 'panel.contoh'})
    ok(st == 200, 'di belakang reverse proxy: Origin = X-Forwarded-Host → diterima')
    os.environ['SKY_ORIGIN'] = 'https://panel.lain.contoh'
    st, d, hd, _ = minta(port, 'POST', '/auth/login', LOGIN, {'Origin': 'https://panel.lain.contoh'})
    ok(st == 200, 'SKY_ORIGIN menambah alamat panel yang sah')
    del os.environ['SKY_ORIGIN']
    st, d, hd, _ = minta(port, 'GET', '/auth/me', None, dict(ck, **{'Origin': 'http://evil.example'}))
    ok(st == 200, 'GET tanpa Sec-Fetch-Site tidak diperiksa Origin-nya (tak mengubah apa pun, dan tak terbaca lintas-origin)')

    # Pre-flight: tak pernah mengizinkan origin lain
    st, d, hd, _ = minta(port, 'OPTIONS', '/auth/login', None,
                         {'Origin': 'http://evil.example', 'Access-Control-Request-Method': 'POST'})
    ok(st == 204 and not any(k.startswith('access-control-') for k in hd), 'pre-flight dijawab TANPA izin lintas-origin')

    aksi = [r['action'] for r in db.conn().execute('SELECT action FROM audit_log').fetchall()]
    ok(aksi.count('security.cross_site.denied') >= 8, 'penolakan tercatat di audit log')

    # ── Header keamanan ──
    st, d, hd, _ = minta(port, 'GET', '/', None)
    csp = hd.get('content-security-policy', '')
    ok(st == 200 and "connect-src 'self'" in csp and "object-src 'none'" in csp and "frame-ancestors 'self'" in csp
       and "base-uri 'self'" in csp, 'halaman panel ber-CSP (connect-src self, object-src none, frame-ancestors self)')
    ok('cdn.jsdelivr.net' not in csp and 'https://cdnjs.cloudflare.com' in csp, 'CSP hanya mengizinkan CDN yang memang dipakai')
    ok(hd.get('x-content-type-options') == 'nosniff' and hd.get('x-frame-options') == 'SAMEORIGIN'
       and 'camera=()' in hd.get('permissions-policy', '') and hd.get('cross-origin-resource-policy') == 'same-origin',
       'nosniff, X-Frame-Options, Permissions-Policy, CORP terpasang')
    ok('strict-transport-security' not in hd, 'HTTP polos → tanpa HSTS')
    st, d, hd, _ = minta(port, 'GET', '/onu/CONTOH-ONU/', None, ck)
    ok('content-security-policy' not in hd, 'halaman ONU (proxy) TIDAK diberi CSP panel — itu halaman milik perangkat')
finally:
    srv.shutdown(); srv.server_close()

# ══ 2. HTTPS bawaan ══
openssl = buat_sertifikat.cari_openssl()
if not openssl:
    print('  (HTTPS dilewati: program openssl tidak ditemukan di komputer ini)')
else:
    cert, key = os.path.join(TMP, 'cert.pem'), os.path.join(TMP, 'key.pem')
    san = buat_sertifikat.buat(cert, key, openssl=openssl)
    ok('IP:127.0.0.1' in san and 'DNS:localhost' in san, 'sertifikat berlaku untuk localhost & 127.0.0.1')
    srv = server.buat_server('127.0.0.1', 0, cert, key)
    ok(server._TLS_AKTIF and server._https_enabled(), 'sertifikat tersedia → panel melayani HTTPS sendiri')
    port = jalankan(srv)
    klien = ssl.create_default_context(cafile=cert)
    try:
        st, d, hd, _ = minta(port, 'GET', '/', None, tls=klien)
        ok(st == 200 and 'max-age=' in hd.get('strict-transport-security', ''), 'HTTPS jalan & browser diberi HSTS')
        st, d, hd, sc = minta(port, 'POST', '/auth/login', LOGIN, tls=klien)
        ok(st == 200 and sc and 'Secure' in sc and 'HttpOnly' in sc, 'di HTTPS cookie sesi ber-Secure + HttpOnly')
        import warnings
        warnings.simplefilter('ignore', DeprecationWarning)   # TLSv1 sengaja dipakai: harus DITOLAK
        lemah = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        lemah.check_hostname = False; lemah.verify_mode = ssl.CERT_NONE
        lemah.maximum_version = ssl.TLSVersion.TLSv1_1
        try:
            lemah.minimum_version = ssl.TLSVersion.TLSv1
        except ValueError:
            pass
        try:
            minta(port, 'GET', '/', None, tls=lemah)
            ok(False, 'TLS 1.1 ke bawah harus ditolak')
        except (ssl.SSLError, OSError):
            ok(True, '')
        # Klien yang tersambung lalu diam tidak menahan panel (jabat tangan di thread permintaan)
        import socket as _s
        diam = _s.create_connection(('127.0.0.1', port), timeout=5)
        try:
            st, d, hd, _ = minta(port, 'GET', '/auth/me', None, tls=klien)
            ok(st == 401, 'satu koneksi diam tidak membuat panel macet untuk klien lain')
        finally:
            diam.close()
    finally:
        srv.shutdown(); srv.server_close()
        server._TLS_AKTIF = False

# ══ 3. Sensor kredensial pada jawaban GenieACS ══
import acs_guard
from http.server import BaseHTTPRequestHandler
DOK = [{'_id': 'X-ONU-1', 'VirtualParameters': {
            'pppoePassword': {'_value': 'RAHASIA-PPPOE', '_type': 'xsd:string', '_writable': False},
            'WlanPassword': {'_value': 'RAHASIA-VPWIFI'}, 'superAdmin': {'_value': 'RAHASIA-SUPER'},
            'pppoeUsername': {'_value': 'budi@sky'}},
        'InternetGatewayDevice': {
            'DeviceInfo': {'X_CMCC_TeleComAccount': {'Password': {'_value': 'RAHASIA-WEB', '_writable': True},
                                                     'Username': {'_value': 'admin'}}},
            'ManagementServer': {'ConnectionRequestPassword': {'_value': 'RAHASIA-CR'}},
            'LANDevice': {'1': {'WLANConfiguration': {'1': {
                'KeyPassphrase': {'_value': 'wifi-ditampilkan'},
                'PreSharedKey': {'1': {'PreSharedKey': {'_value': 'psk-ditampilkan'}}}}}}}}}]
TUGAS = [{'_id': 't1', 'device': 'X-ONU-1', 'name': 'setParameterValues', 'parameterValues': [
    ['InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password', 'RAHASIA-TUGAS', 'xsd:string'],
    ['InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username', 'budi@sky', 'xsd:string']]}]

out = json.loads(acs_guard.sensor_kredensial(json.dumps(DOK).encode()))[0]
vp, igd = out['VirtualParameters'], out['InternetGatewayDevice']
ok(vp['pppoePassword']['_value'] == '' and vp['WlanPassword']['_value'] == '' and vp['superAdmin']['_value'] == '',
   'sensor: password PPPoE, VP WiFi & Super Admin dikosongkan')
ok(igd['DeviceInfo']['X_CMCC_TeleComAccount']['Password']['_value'] == ''
   and igd['ManagementServer']['ConnectionRequestPassword']['_value'] == '', 'sensor: password akun web ONU & ConnectionRequest dikosongkan')
ok(igd['DeviceInfo']['X_CMCC_TeleComAccount']['Password']['_writable'] is True and vp['pppoePassword']['_type'] == 'xsd:string',
   'sensor: simpul tetap ada (cek "leaf password tersedia?" tetap bekerja)')
w = igd['LANDevice']['1']['WLANConfiguration']['1']
ok(w['KeyPassphrase']['_value'] == 'wifi-ditampilkan' and w['PreSharedKey']['1']['PreSharedKey']['_value'] == 'psk-ditampilkan',
   'sensor: password WiFi (KeyPassphrase/PreSharedKey) TIDAK disentuh — kartu SSID menampilkannya')
ok(vp['pppoeUsername']['_value'] == 'budi@sky' and igd['DeviceInfo']['X_CMCC_TeleComAccount']['Username']['_value'] == 'admin',
   'sensor: username tidak disensor')
t = json.loads(acs_guard.sensor_kredensial(json.dumps(TUGAS).encode()))[0]['parameterValues']
ok(t[0][1] == '' and t[1][1] == 'budi@sky', 'sensor: password di task yang mengantre dikosongkan, isian lain utuh')
ringan = json.dumps([{'_id': 'A', 'VirtualParameters': {'RXPower': {'_value': '-18'}}}]).encode()
ok(acs_guard.sensor_kredensial(ringan) is ringan, 'jawaban tanpa kunci rahasia tidak di-parse ulang (cepat untuk daftar 1.800 ONU)')

class NbiTiruan(BaseHTTPRequestHandler):
    tulis = []
    auth = []              # header Authorization yang sampai ke "GenieACS"
    tolak401 = False
    def log_message(self, *a): pass
    def do_GET(self):
        NbiTiruan.auth.append(self.headers.get('Authorization'))
        if NbiTiruan.tolak401:
            self.send_response(401); self.send_header('Content-Length', '0'); self.end_headers(); return
        badan = json.dumps(TUGAS if self.path.startswith('/tasks') else DOK).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(badan))); self.end_headers(); self.wfile.write(badan)
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        NbiTiruan.tulis.append(self.rfile.read(n))
        badan = b'{"_id":"tugas-baru"}'
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(badan))); self.end_headers(); self.wfile.write(badan)
nbi = ThreadingHTTPServer(('127.0.0.1', 0), NbiTiruan)
threading.Thread(target=nbi.serve_forever, daemon=True).start()
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': nbi.server_address[1], 'base_path': ''})
srv = server.buat_server('127.0.0.1', 0)
port = jalankan(srv)
try:
    st, d, hd, sc = minta(port, 'POST', '/auth/login', LOGIN)
    ck = {'Cookie': sc.split(';')[0]}
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
    c.request('GET', '/api/devices?query=%7B%22_id%22%3A%22X-ONU-1%22%7D', headers=ck)
    raw = c.getresponse().read().decode('utf-8'); c.close()
    ok('RAHASIA' not in raw and 'wifi-ditampilkan' in raw and 'budi@sky' in raw,
       'lewat /api: browser tidak pernah menerima nilai kredensial ONU (password WiFi tetap)')
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
    c.request('GET', '/api/tasks?query=%7B%7D', headers=ck)
    raw = c.getresponse().read().decode('utf-8'); c.close()
    ok('RAHASIA' not in raw, 'lewat /api/tasks: password di task orang lain tidak terkirim')
    tugas = {'name': 'setParameterValues', 'parameterValues': [
        ['InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password', 'Sandi-Baru-123', 'xsd:string']]}
    st, d, hd, _ = minta(port, 'POST', '/api/devices/X-ONU-1/tasks?connection_request', tugas, ck)
    ok(st == 200 and NbiTiruan.tulis and b'Sandi-Baru-123' in NbiTiruan.tulis[-1],
       'perintah TULIS tidak disensor — password baru tetap sampai ke GenieACS')

    # Kredensial NBI hanya dari server. Dulu header kiriman browser (username NBI +
    # password KOSONG dari cache-nya) yang diteruskan ke GenieACS.
    import base64
    config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': nbi.server_address[1], 'base_path': '',
                          'auth_enabled': True, 'auth_username': 'nbi-panel', 'auth_secret': 'Sandi-NBI-9'})
    NbiTiruan.auth.clear()
    palsu = 'Basic ' + base64.b64encode(b'nbi-panel:').decode()
    st, d, hd, _ = minta(port, 'GET', '/api/devices?query=%7B%7D', None, dict(ck, Authorization=palsu))
    ok(st == 200 and NbiTiruan.auth == ['Basic ' + base64.b64encode(b'nbi-panel:Sandi-NBI-9').decode()],
       'GenieACS menerima kredensial NBI dari server, bukan header Authorization kiriman browser')
    NbiTiruan.tolak401 = True
    st, d, hd, _ = minta(port, 'GET', '/api/devices?query=%7B%7D', None, ck)
    ok(st == 502 and 'Koneksi ACS' in (d.get('error') or ''),
       '401 dari GenieACS → 502 berpenjelasan, bukan 401 (browser akan mengira sesi panel habis)')
    NbiTiruan.tolak401 = False
finally:
    srv.shutdown(); srv.server_close(); nbi.shutdown()

# ══ 4. Sisi browser & kode ══
html = open(os.path.join(ROOT, 'frontend', 'index.html'), encoding='utf-8').read()
cdn = re.findall(r'<(?:script|link)[^>]+(?:src|href)="(https://[^"]+)"[^>]*>', html)
ext = [m for m in re.finditer(r'<(script|link)\b[^>]*?(?:src|href)="(https://(?!fonts\.googleapis)[^"]+)"[^>]*>', html)]
ok(len(ext) == 2, 'dua pustaka CDN yang dipakai: Chart.js & Font Awesome (dapat %d)' % len(ext))
for m in ext:
    tag = m.group(0)
    ok('integrity="sha512-' in tag and 'crossorigin="anonymous"' in tag,
       'pustaka CDN dikunci SRI + crossorigin: ' + m.group(2).split('/')[-1])
ok('cdn.jsdelivr.net' not in html, 'tidak memuat berkas buatan-dinamis jsDelivr (tak aman di-SRI)')
main = open(os.path.join(ROOT, 'frontend', 'js', 'main.js'), encoding='utf-8').read()
toast = main[main.index('function showToast'):main.index('function showToast') + 1400]
ok('createTextNode' in toast and '${msg}' not in toast, 'pesan toast dimasukkan sebagai TEKS, bukan HTML')
dash = open(os.path.join(ROOT, 'frontend', 'js', 'dashboard.js'), encoding='utf-8').read()
ok('<span class="cl-name">${escHtml(lbl)}</span>' in dash and '<span class="cl-name">${lbl}</span>' not in dash,
   'legenda Product Class (nama model dari ONU) di-escape')
src = open(os.path.join(ROOT, 'backend', 'server.py'), encoding='utf-8').read()
ok("send_header('Access-Control-Allow-Origin'" not in src, 'server tidak lagi mengirim Access-Control-Allow-Origin')
apijs = open(os.path.join(ROOT, 'frontend', 'js', 'api.js'), encoding='utf-8').read()
setjs = open(os.path.join(ROOT, 'frontend', 'js', 'settings.js'), encoding='utf-8').read()
ok("headers['Authorization']" not in apijs and 'acsPass' not in apijs,
   'browser tidak mengirim kredensial NBI ke /api')
ok('delete lama.acsPass' in main and not re.search(r'acsUser:\s*d\.acs', main + setjs),
   'sisa username/password NBI dibuang dari cache browser dan tidak disimpan lagi')

shutil.rmtree(TMP, ignore_errors=True)
print(f'keamanan: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
