#!/usr/bin/env python3
"""Uji cookie cermin & pengalihan navigasi proxy web ONU (2026-10-02).

LATAR: tombol Remote pada ZTE F6600P menampilkan halaman login, tetapi Login
"tidak merespons". Web ONU itu memanggil API lewat path ABSOLUT
('/?_type=loginData&_tag=login_token'); cookie sesi ONU (SID) dibatasi ke
Path=/onu/<id>/ sehingga browser tidak mengirimnya ke '/', dan ONU membuat sesi
baru di tiap permintaan (diukur di SN ZTEGD4D5D1FF).

YANG DIJAGA:
  1. Tiap cookie ONU punya CERMIN ber-Path=/ dengan nama berawalan per-perangkat.
  2. Cermin dipulihkan ke nama asli HANYA untuk perangkatnya; milik ONU lain dibuang.
  3. Cookie sesi panel tetap tak pernah sampai ke ONU, dan ONU tak bisa menimpanya.
  4. Navigasi halaman lewat Referer dialihkan ke /onu/<id>/…, aset/XHR tidak.
"""
import os, sys, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend'))
import db, onu_proxy
from auth import SESSION_COOKIE

db.set_path(os.path.join(tempfile.mkdtemp(prefix='skyonuck-'), 'sky.db'))

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

A, B = 'BCBD84-F6600P-ZTEGD4D5D1FF', 'BCBD84-F6600P-ZTEGD3BE4ED4'
pa, pb = onu_proxy.mirror_prefix(A), onu_proxy.mirror_prefix(B)
ok(pa != pb and pa.startswith('__onu_') and pa.endswith('_'), 'awalan cermin berbeda per perangkat')

# ══ 1. Set-Cookie → cermin + versi ber-path ══
hdr = [('Set-Cookie', 'SID=abc123; PATH=/; HttpOnly; SameSite=strict'), ('Content-Type', 'text/xml')]
out = onu_proxy.filter_response_headers(hdr, A, '10.17.4.32', SESSION_COOKIE)
sc = [v for k, v in out if k == 'Set-Cookie']
ok(len(sc) == 2, 'satu cookie ONU → dua Set-Cookie')
ok(sc[0].startswith(pa + 'SID=abc123') and 'Path=/' in sc[0].split('; ') and '/onu/' not in sc[0],
   'cermin: nama berawalan, Path=/')
ok('HttpOnly' in sc[0] and 'SameSite=strict' in sc[0], 'cermin mempertahankan HttpOnly & SameSite')
ok(sc[1].startswith('SID=abc123') and 'Path=/onu/' in sc[1], 'versi asli tetap dibatasi path (terakhir)')
ok(not any(v.split('=')[0] == 'SID' and 'Path=/;' in v + ';' and '/onu/' not in v for v in sc),
   'nama ASLI tidak pernah dipasang di Path=/')

out = onu_proxy.filter_response_headers([('Set-Cookie', SESSION_COOKIE + '=jahat; Path=/')], A, 'x', SESSION_COOKIE)
ok(not [1 for k, v in out if k == 'Set-Cookie'], 'ONU tetap tak bisa menyetel cookie sesi panel (asli maupun cermin)')
ok(onu_proxy.mirror_set_cookie('sid=x; Domain=onu.local; PATH=/; Secure', A, SESSION_COOKIE).lower().count('domain') == 0,
   'cermin: Domain/Secure tetap dibuang')

# ══ 2. Cookie → ONU ══
ck = f'{SESSION_COOKIE}=rahasia; {pa}SID=abc123; {pb}SID=punyaB; lain=1'
c = onu_proxy._strip_panel_cookies(ck, A)
ok('SID=abc123' in c.split('; '), 'cermin perangkat ini dipulihkan ke nama asli')
ok('punyaB' not in c and '__onu_' not in c, 'cermin ONU LAIN tidak diteruskan; awalan tak bocor ke ONU')
ok('rahasia' not in c and SESSION_COOKIE not in c, 'cookie sesi panel tetap tidak diteruskan')
ok('lain=1' in c, 'cookie lain tetap diteruskan')
c = onu_proxy._strip_panel_cookies(f'SID=abc123; {pa}SID=abc123', A)
ok(c == 'SID=abc123', 'asli + cermin bersamaan → tidak ganda')
c = onu_proxy._strip_panel_cookies(f'{pb}SID=punyaB; x=1', A)
ok(c == 'x=1', 'hanya cermin ONU lain → tak ada SID yang terkirim')
ok(onu_proxy._strip_panel_cookies(f'{SESSION_COOKIE}=r; lain=1') == 'lain=1', 'pemanggilan lama (tanpa device) tetap bekerja')

req, _ = onu_proxy.build_request(A, '10.17.4.32', '/?_type=loginData&_tag=login_token', 'GET', None, {'Cookie': ck})
ok(req.get_header('Cookie') == 'lain=1; SID=abc123', 'build_request meneruskan SID milik perangkatnya saja')

# ══ 4. Pengalihan GET lewat Referer (server.py) ══
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend', 'server.py'), encoding='utf-8').read()
ok("self.send_header('Location', onu_proxy.PREFIX + raw + self.path)" in src, 'GET lewat Referer dialihkan ke /onu/<id><path>')
ok("if self.command == 'GET' and not xhr:" in src, 'GET non-XHR dialihkan (302)')
ok("if self.command == 'POST' and not xhr:" in src and 'self.send_response(307)' in src,
   'form POST dialihkan dengan 307 (metode & isi terkirim ulang) — dokumen hasil login tetap di /onu/<id>/')

# ══ 5. Path yang keluar dari prefiks karena '../' ══
R = 'http://127.0.0.1:8081/onu/BCBD84-F6600P-ZTEGD4D5D1FF/'
ep = onu_proxy.escaped_path
ok(ep('/onu/img/home_adev_head.gif', R) == '/onu/BCBD84-F6600P-ZTEGD4D5D1FF/img/home_adev_head.gif',
   "'/onu/img/x.gif' → deviceId dari Referer disisipkan lagi")
ok(ep('/onu/img/a.gif?v=1', R) == '/onu/BCBD84-F6600P-ZTEGD4D5D1FF/img/a.gif?v=1', 'query string utuh')
ok(ep('/onu/BCBD84-F6600P-ZTEGD4D5D1FF/img/a.gif', R) is None, 'path yang sudah benar tidak diubah')
ok(ep('/onu/BCBD84-F6600P-ZTEGD3BE4ED4/', R) is None, 'deviceId LAIN tidak pernah ditimpa Referer')
ok(ep('/onu/img/a.gif', 'http://127.0.0.1:8081/devices/x') is None and ep('/onu/img/a.gif', '') is None,
   'tanpa Referer halaman ONU → tidak diubah (tetap 404)')
RC = 'http://h/onu/48575443-FD514GD%2DR460-X1/index.html'
ok(ep('/onu/js/app.js', RC) == '/onu/48575443-FD514GD%2DR460-X1/js/app.js', "id ber-'%2D' dipertahankan apa adanya")
ok('onu_proxy.escaped_path(self.path' in src, 'server memakai escaped_path sebelum memilih perangkat')

# ══ 6. Alur login HWTC ZL-2113X lewat server sungguhan (ONU & sesi ditiru) ══
import threading, http.client
import server
from http.server import ThreadingHTTPServer
ID = 'HWTC-ZL%2D2113X-HWTCDF640C28'          # id asli memuat '%2D'
SEG = 'HWTC-ZL%252D2113X-HWTCDF640C28'       # bentuknya di URL
diteruskan = []
server.SPAHandler._current_user = lambda self: 'penguji'
server.SPAHandler.log_message = lambda *a, **k: None
onu_proxy.resolve_device = lambda device_id, nbi, fetch=None: '10.17.7.26'
def _forward_tiruan(req, timeout=8):
    diteruskan.append((req.get_method(), req.full_url, req.data))
    return 200, [('Content-Type', 'text/html')], b'<html>ok</html>'
onu_proxy.forward = _forward_tiruan
onu_proxy.audit_open = lambda *a, **k: None
srv = ThreadingHTTPServer(('127.0.0.1', 0), server.SPAHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
def minta(metode, path, referer=None, body=None, xhr=False):
    c = http.client.HTTPConnection('127.0.0.1', srv.server_address[1], timeout=10)
    h = {}
    if referer: h['Referer'] = 'http://127.0.0.1:8081' + referer
    if xhr: h['X-Requested-With'] = 'XMLHttpRequest'
    if body is not None: h['Content-Type'] = 'application/x-www-form-urlencoded'
    c.request(metode, path, body=body, headers=h)
    r = c.getresponse(); r.read(); c.close()
    return r.status, r.getheader('Location')
try:
    R = '/onu/' + SEG + '/cgi-bin/index2.asp'
    st, loc = minta('POST', '/cgi-bin/index2.asp', R, 'Username=a&Logged=1')
    ok(st == 307 and loc == R, 'form login POST ke path absolut → 307 ke /onu/<id>/… (dapat %s %s)' % (st, loc))
    ok(not diteruskan, 'POST yang dialihkan TIDAK diteruskan dua kali ke ONU')
    st, loc = minta('POST', R, R, 'Username=a&Logged=1')
    ok(st == 200 and len(diteruskan) == 1 and diteruskan[0][0] == 'POST'
       and diteruskan[0][1] == 'http://10.17.7.26/cgi-bin/index2.asp' and diteruskan[0][2] == b'Username=a&Logged=1',
       'POST ulang ke alamat berprefiks sampai ke ONU dengan isi utuh')
    st, loc = minta('GET', '/cgi-bin/content.asp', R)
    ok(st == 302 and loc == '/onu/' + SEG + '/cgi-bin/content.asp', 'pindah ke content.asp → tetap di dalam /onu/<id>/')
    diteruskan.clear()
    st, loc = minta('POST', '/cgi-bin/x.cgi', R, 'a=1', xhr=True)
    ok(st == 200 and len(diteruskan) == 1, 'XHR POST tetap dilayani di tempat')
    st, loc = minta('GET', '/cgi-bin/content.asp')
    ok(st == 200 and loc is None and len(diteruskan) == 1, 'tanpa Referer halaman ONU → tidak dibajak (panel menjawab sendiri)')
    # ── HTTPS di port 80 (Huawei HG8245W5-6T): halaman pengalih → ulangi lewat TLS ──
    STUB = b'<script>var SSLPort = 80;var HostInfo = window.location.host;function LoadFrame(){window.location="https://" + HostInfo + ":" + SSLPort;}</script>'
    def _forward_hw(req, timeout=8):
        diteruskan.append((req.get_method(), req.full_url, req.data))
        if req.full_url.startswith('http://'):
            return 200, [('Content-Type', 'text/html')], STUB
        return 200, [('Content-Type', 'text/html')], b'<html>login asli</html>'
    onu_proxy.forward = _forward_hw
    onu_proxy._tls_devices.clear(); diteruskan.clear()
    HW = '/onu/00259E-HG8245W5%252D6T-485754432B16F9AE/'
    st, loc = minta('GET', HW)
    ok(st == 200 and [d[1] for d in diteruskan] == ['http://10.17.7.26/', 'https://10.17.7.26:80/'],
       'halaman pengalih terlihat → permintaan diulang lewat https://<ip>:80/ (dapat %s)' % [d[1] for d in diteruskan])
    diteruskan.clear()
    minta('GET', HW + 'login.asp')
    ok([d[1] for d in diteruskan] == ['https://10.17.7.26:80/login.asp'], 'permintaan berikutnya langsung TLS (perangkat diingat)')
    diteruskan.clear()
    minta('GET', '/onu/' + SEG + '/')
    ok(diteruskan and diteruskan[0][1].startswith('http://'), 'ONU lain tetap HTTP polos')
finally:
    srv.shutdown()

ok(onu_proxy.is_https_stub(200, b'x' * 30000) is False and onu_proxy.is_https_stub(200, b'<html>biasa</html>') is False
   and onu_proxy.is_https_stub(404, STUB) is False, 'halaman biasa / besar / galat bukan halaman pengalih')
ok(onu_proxy.is_https_stub(200, b'<script>var SSLPort =80;window.location="https://" + SSLHostIp + ":" + SSLPort;</script>'),
   'varian HG8245A (SSLHostIp) juga dikenali')
ok(onu_proxy.is_https_stub(200, b'<a href="https://contoh">x</a> SSLPort') is False, 'tautan https biasa bukan halaman pengalih')
ok(onu_proxy._tls_context().options & 0x4, 'TLS mengizinkan renegosiasi gaya lama (firmware HG8245A)')
r1, t1 = onu_proxy.build_request('D', '10.18.2.139', '/a', 'GET', None, {}, tls=True)
ok(t1 == 'https://10.18.2.139:80/a' and r1.get_header('Host') == '10.18.2.139:80', 'TLS di port 80: target & Host benar')
r2, t2 = onu_proxy.build_request('D', '10.18.2.139', '/a', 'GET', None, {})
ok(t2 == 'http://10.18.2.139/a', 'bawaan tetap HTTP polos')
try:
    onu_proxy.build_request('D', '10.18.2.139', '/', 'GET', None, {}, port=7547, tls=True); ok(False, 'port di luar daftar-izin harus ditolak')
except onu_proxy.OnuError:
    ok(True, 'TLS tidak membuka port di luar daftar-izin')

print(f'onucookie: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
