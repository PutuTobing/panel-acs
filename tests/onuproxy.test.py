#!/usr/bin/env python3
"""Uji proxy web UI ONU (onu_proxy.py).

Fitur ini menjadikan panel gerbang ke jaringan manajemen 1742 ONU. Yang diuji
di sini bukan "halamannya muncul", melainkan apakah PAGARNYA benar-benar
menahan — karena kalau jebol, yang bocor adalah seluruh jaringan internal.

Yang paling dijaga:
  • SSRF lewat ConnectionRequestURL. Nilai itu DILAPORKAN ONU — data yang
    dikendalikan perangkat. ONU yang disusupi cukup melaporkan
    http://127.0.0.1:7557/ dan proxy akan menyambungkan pemanggil ke NBI
    GenieACS yang TIDAK berautentikasi.
  • Cookie ONU bocor lintas ONU (PATH=/) atau menimpa sesi panel.
  • Cookie sesi PANEL bocor ke ONU.
  • Redirect yang menyeret browser operator ke IP internal yang tak terjangkau.
"""
import os, sys, json, socket, threading, tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend'))
import db, onu_proxy
from auth import SESSION_COOKIE

db.set_path(os.path.join(tempfile.mkdtemp(prefix='skyonu-'), 'sky.db'))

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)


def cru(url):
    """Bentuk jawaban GenieACS untuk satu perangkat."""
    return [{'InternetGatewayDevice': {'ManagementServer':
             {'ConnectionRequestURL': {'_value': url}}}}]


# ══ split_path ══
d, t = onu_proxy.split_path('/onu/ABC-123/')
ok(d == 'ABC-123' and t == '/', 'split_path: id + root')
d, t = onu_proxy.split_path('/onu/ABC-123/a/b.html')
ok(d == 'ABC-123' and t == '/a/b.html', 'split_path: id + path bersarang')
d, t = onu_proxy.split_path('/onu/688AF0-F663NV9-ZTEGCACBC9E4/x')
ok(d == '688AF0-F663NV9-ZTEGCACBC9E4', 'split_path: deviceId GenieACS asli (banyak tanda hubung)')
d, t = onu_proxy.split_path('/onu/a%2Fb/x')
ok(d == 'a/b', 'split_path: deviceId ter-encode dibuka')
ok(onu_proxy.split_path('/devices/x') == (None, None), 'split_path: path lain diabaikan')
ok(onu_proxy.split_path('/onu/') == (None, None), 'split_path: tanpa deviceId ditolak')

# ══ referer_device_id: routing sticky untuk SPA ONU (path absolut) ══
# SPA C-DATA memuat '/js/app.js','/boaform/...' dari root; Referer dokumennya
# tetap /onu/<id>/ dan itu yang mengembalikannya ke ONU yang benar.
rdi = onu_proxy.referer_device_id
ok(rdi('http://panel:8081/onu/ABC-123/index.html') == 'ABC-123',
   'referer: id diambil dari halaman ONU')
ok(rdi('http://panel:8081/onu/ABC-123/#/wifi/advance') == 'ABC-123',
   'referer: fragmen hash-router diabaikan (id tetap benar)')
# id C-DATA memuat %2D — WAJIB dikembalikan APA ADANYA (tanpa unquote), kalau
# tidak, disusun ulang lalu di-unquote lagi = id rusak & ONU tak ketemu.
ok(rdi('http://p/onu/505B1D-FD514GD%252DR460-DF18%252D2503002632/index.html')
   == '505B1D-FD514GD%252DR460-DF18%252D2503002632',
   'referer: id ber-%2D dikembalikan apa adanya (tak di-unquote)')
ok(rdi('http://panel/dashboard') is None, 'referer halaman PANEL → None (panel tak terbajak)')
ok(rdi('http://panel/') is None, 'referer root panel → None')
ok(rdi('') is None and rdi(None) is None, 'referer kosong/none → None')
ok(rdi('http://panel/onu/') is None, 'referer /onu/ tanpa id → None')
# Bukti susun-ulang benar: /onu/<seg> + path → split_path memulihkan id asli.
_seg = rdi('http://p/onu/505B1D-FD514GD%252DR460-X/index.html')
_did, _tail = onu_proxy.split_path(onu_proxy.PREFIX + _seg + '/js/app.js')
ok(_did == '505B1D-FD514GD%2DR460-X' and _tail == '/js/app.js',
   'susun-ulang /onu/<seg><path> → split_path memulihkan id C-DATA + tail benar')

# ══ INTI: daftar-izin IP (penahan SSRF) ══
for good in ('10.17.4.207', '10.18.1.180', '10.0.0.5', '192.168.1.1'):
    try:
        onu_proxy.validate_host(good); allowed = True
    except onu_proxy.OnuError:
        allowed = False
    ok(allowed, 'IP jaringan manajemen diizinkan: ' + good)

# Inilah serangan yang sesungguhnya: ONU melaporkan alamat yang menunjuk balik
# ke server. NBI GenieACS di 127.0.0.1:7557 TIDAK berautentikasi.
for bad, why in [
    ('127.0.0.1',       'loopback → NBI GenieACS tanpa auth'),
    ('127.0.0.53',      'loopback lain'),
    ('169.254.169.254', 'link-local → endpoint metadata cloud'),
    ('8.8.8.8',         'IP publik'),
    ('1.1.1.1',         'IP publik'),
    ('224.0.0.1',       'multicast'),
    ('0.0.0.0',         'alamat tak tentu'),
]:
    try:
        onu_proxy.validate_host(bad); blocked = False
    except onu_proxy.OnuError:
        blocked = True
    ok(blocked, 'DITOLAK — %s (%s)' % (bad, why))

# Nama host tidak diterima: resolusinya sendiri bisa diarahkan (DNS rebinding).
for bad in ('localhost', 'evil.example.com', '10.17.4.207.evil.com'):
    try:
        onu_proxy.validate_host(bad); blocked = False
    except onu_proxy.OnuError:
        blocked = True
    ok(blocked, 'nama host ditolak (hanya IP): ' + bad)

# ══ resolve_device: IP datang dari GenieACS, bukan dari klien ══
onu_proxy._cache.clear()
host = onu_proxy.resolve_device('D1', 'http://acs',
                               fetch=lambda u: cru('http://10.17.4.207:58000/xyz'))
ok(host == '10.17.4.207', 'IP diambil dari ConnectionRequestURL')

# ── Bentuk CRU LINTAS-VENDOR: sebagian TANPA path setelah port ──
# Regex lama mewajibkan '/' setelah port sehingga bentuk 'http://ip:port' (CIOT/
# ETCH/ZICG/TRKG) GAGAL — remote mati padahal IP jelas terbaca. Ini regresinya.
for cru_val, want, label in [
    ('http://10.17.5.43:58000',        '10.17.5.43',  'CIOT: port tanpa path'),
    ('http://10.17.6.224:58000',       '10.17.6.224', 'ETCH: port tanpa path'),
    ('http://10.17.7.199:7547/tr069',  '10.17.7.199', 'CDTC: ada path /tr069'),
    ('http://10.17.5.64:7547/tr69',    '10.17.5.64',  'HWTC: ada path /tr69'),
    ('http://10.17.4.207:58000/jCe',   '10.17.4.207', 'ZTE: ada path acak'),
    ('http://10.17.1.9',               '10.17.1.9',   'tanpa port & tanpa path'),
    ('http://10.17.1.9:80?x=1',        '10.17.1.9',   'langsung query tanpa path'),
]:
    onu_proxy._cache.clear()
    got = onu_proxy.resolve_device('D', 'http://acs', fetch=lambda u, v=cru_val: cru(v))
    ok(got == want, f'CRU {label} → {want}')

# ONU melaporkan alamat jahat → proxy WAJIB menolak, bukan menurut.
onu_proxy._cache.clear()
try:
    onu_proxy.resolve_device('EVIL', 'http://acs',
                             fetch=lambda u: cru('http://127.0.0.1:7557/x'))
    blocked = False
except onu_proxy.OnuError as e:
    blocked = (e.status == 403)
ok(blocked, 'ONU yang melaporkan 127.0.0.1 DITOLAK (tak bisa dipakai menembus NBI)')

onu_proxy._cache.clear()
try:
    onu_proxy.resolve_device('EVIL2', 'http://acs',
                             fetch=lambda u: cru('http://169.254.169.254/latest/meta-data/'))
    blocked = False
except onu_proxy.OnuError:
    blocked = True
ok(blocked, 'ONU yang melaporkan endpoint metadata DITOLAK')

onu_proxy._cache.clear()
try:
    onu_proxy.resolve_device('X', 'http://acs', fetch=lambda u: [])
    ok(False, 'perangkat tak ada → OnuError')
except onu_proxy.OnuError as e:
    ok(e.status == 404, 'perangkat tak ada → 404')

onu_proxy._cache.clear()
try:
    onu_proxy.resolve_device('X', 'http://acs', fetch=lambda u: cru(''))
    ok(False, 'ConnectionRequestURL kosong → OnuError')
except onu_proxy.OnuError as e:
    ok(e.kind == 'no-address', 'ConnectionRequestURL kosong → pesan yang jelas, bukan crash')

# Cache tidak boleh menyeberang antar perangkat.
onu_proxy._cache.clear()
onu_proxy.resolve_device('A', 'http://acs', fetch=lambda u: cru('http://10.17.0.1/x'))
onu_proxy.resolve_device('B', 'http://acs', fetch=lambda u: cru('http://10.17.0.2/x'))
ok(onu_proxy._cache['A'][0] == '10.17.0.1' and onu_proxy._cache['B'][0] == '10.17.0.2',
   'cache per-deviceId (ONU A tidak pernah dipetakan ke IP ONU B)')

# ══ Penulisan ulang cookie ══
r = onu_proxy.rewrite_set_cookie('_TESTCOOKIEHTTP=1; PATH=/; HttpOnly', 'D1', SESSION_COOKIE)
ok('Path=/onu/D1/' in r, 'cookie ONU dibatasi ke path proxy-nya (PATH=/ → /onu/D1/)')
ok('Path=/;' not in r and not r.endswith('Path=/'), 'PATH=/ asli tidak tersisa')
ok('HttpOnly' in r, 'atribut lain dipertahankan')
ok('_TESTCOOKIEHTTP=1' in r, 'nama & nilai cookie utuh')

r = onu_proxy.rewrite_set_cookie('sid=abc', 'D1', SESSION_COOKIE)
ok('Path=/onu/D1/' in r, 'cookie tanpa Path tetap diberi path proxy')

# Inilah yang mencegah sesi ONU A terbawa saat membuka ONU B.
a = onu_proxy.rewrite_set_cookie('sid=aaa; PATH=/', 'ONU-A', SESSION_COOKIE)
b = onu_proxy.rewrite_set_cookie('sid=bbb; PATH=/', 'ONU-B', SESSION_COOKIE)
ok('/onu/ONU-A/' in a and '/onu/ONU-B/' in b, 'tiap ONU dapat ruang cookie sendiri')

# ONU tidak boleh menimpa cookie sesi panel.
ok(onu_proxy.rewrite_set_cookie(f'{SESSION_COOKIE}=palsu; PATH=/', 'D1', SESSION_COOKIE) is None,
   'ONU DILARANG menyetel cookie sesi panel (pengambilalihan sesi)')
ok(onu_proxy.rewrite_set_cookie(f'{SESSION_COOKIE.upper()}=palsu', 'D1', SESSION_COOKIE) is None,
   'blokir cookie sesi tidak peduli besar-kecil huruf')

r = onu_proxy.rewrite_set_cookie('sid=x; Domain=onu.local; PATH=/', 'D1', SESSION_COOKIE)
ok('Domain' not in r, 'atribut Domain dari ONU dibuang (tak bermakna di origin panel)')
r = onu_proxy.rewrite_set_cookie('sid=x; PATH=/; Secure', 'D1', SESSION_COOKIE)
ok('Secure' not in r, 'atribut Secure dibuang (panel bisa HTTP polos → cookie tak akan terkirim)')

# ══ Cookie panel tidak boleh bocor KE ONU ══
c = onu_proxy._strip_panel_cookies(f'{SESSION_COOKIE}=rahasia; lain=1')
ok(SESSION_COOKIE not in c, 'cookie sesi panel TIDAK diteruskan ke ONU')
ok('lain=1' in c, 'cookie lain tetap diteruskan')
ok('rahasia' not in c, 'nilai token sesi tidak bocor')

# ══ Penulisan ulang Location ══
r = onu_proxy.rewrite_location('http://10.17.1.224/login.html', 'D1', '10.17.1.224')
ok(r == '/onu/D1/login.html', 'redirect absolut ke ONU ditarik ke dalam proxy')
r = onu_proxy.rewrite_location('/index.html', 'D1', '10.17.1.224')
ok(r == '/onu/D1/index.html', 'redirect root-relatif diberi prefix')
r = onu_proxy.rewrite_location('sub/x.html', 'D1', '10.17.1.224')
ok(r == 'sub/x.html', 'redirect relatif dibiarkan (sudah benar sendiri)')
r = onu_proxy.rewrite_location('http://lain.example/x', 'D1', '10.17.1.224')
ok(r == 'http://lain.example/x', 'redirect ke host LAIN tidak ditarik masuk (jangkauan tak melebar diam-diam)')

# ══ build_request ══
req, target = onu_proxy.build_request('D1', '10.17.1.224', '/a?b=1', 'GET', None,
                                      {'User-Agent': 'x', 'Content-Length': '0',
                                       'Host': 'panel', 'Connection': 'keep-alive'})
ok(target == 'http://10.17.1.224/a?b=1', 'URL target benar')
ok(req.get_header('Host') == '10.17.1.224', 'Host menunjuk ONU, bukan panel')
ok(req.get_header('Content-length') is None, 'Content-Length lama tidak diteruskan')
ok(req.get_header('Connection') is None, 'header hop-by-hop tidak diteruskan')
ok(req.get_header('User-agent') == 'x', 'header biasa diteruskan')

for bad_port in (7547, 58000, 22, 3306, 27017):
    try:
        onu_proxy.build_request('D1', '10.17.1.224', '/', 'GET', None, {}, port=bad_port)
        blocked = False
    except onu_proxy.OnuError:
        blocked = True
    ok(blocked, 'port %d ditolak (bukan halaman untuk manusia)' % bad_port)

req, target = onu_proxy.build_request('D1', '10.17.1.224', '/', 'GET', None, {}, port=443)
ok(target.startswith('https://'), 'port 443 → https')

# ══ forward: terhadap ONU palsu yang NYATA ══
class FakeOnu(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/redir':
            self.send_response(302)
            self.send_header('Location', 'http://%s/login.html' % self.server.server_address[0])
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        body = b'<html><title>ZXHN F663NV9</title></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=gb2312')
        self.send_header('Set-Cookie', '_TESTCOOKIEHTTP=1; PATH=/; HttpOnly')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        got = self.rfile.read(n)
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(got)))
        self.end_headers()
        self.wfile.write(got)
    def log_message(self, *a): pass

srv = ThreadingHTTPServer(('127.0.0.1', 0), FakeOnu)
srv.daemon_threads = True
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

# Port ONU palsu bukan 80, jadi build_request dilewati — yang diuji forward().
import urllib.request as _u
req = _u.Request(f'http://127.0.0.1:{port}/', method='GET')
status, headers, data = onu_proxy.forward(req)
ok(status == 200, 'forward: 200 dari ONU')
ok(b'F663NV9' in data, 'forward: body ONU utuh')
hd = {k.lower(): v for k, v in headers}
ok('gb2312' in hd.get('content-type', ''),
   'Content-Type ONU diteruskan apa adanya (gb2312 — salah encoding = halaman jadi sampah)')

out = onu_proxy.filter_response_headers(headers, 'D1', '127.0.0.1', SESSION_COOKIE)
od = {k.lower(): v for k, v in out}
ok('Path=/onu/D1/' in od.get('set-cookie', ''), 'filter: cookie ONU dibatasi path')
# Panel sudah mengirim Server/Date sendiri lewat send_response(); meneruskan
# punya ONU membuat tiap respons punya header ganda.
ok('server' not in od, 'header Server milik ONU dibuang (panel sudah mengirimnya)')
ok('date' not in od, 'header Date milik ONU dibuang (panel sudah mengirimnya)')
ok(od.get('x-frame-options') == 'SAMEORIGIN',
   'X-Frame-Options DIPERTAHANKAN — di balik proxy halamannya memang same-origin')
ok('content-length' not in od, 'Content-Length lama dibuang (dihitung ulang)')

# POST harus utuh — halaman login ONU memakainya.
req = _u.Request(f'http://127.0.0.1:{port}/', data=b'user=admin&pass=x', method='POST')
status, headers, data = onu_proxy.forward(req)
ok(status == 200 and data == b'user=admin&pass=x', 'forward: body POST diteruskan utuh (login ONU)')

# Redirect ONU → ditarik ke dalam proxy, TIDAK diikuti di sisi server.
# Dibungkus try: bila pengikut redirect kembali aktif, urllib akan mengejar
# Location-nya sendiri dan melempar — tanpa penanganan ini tesnya MELEDAK
# alih-alih gagal rapi, dan tes di bawahnya ikut hilang dari laporan.
req = _u.Request(f'http://127.0.0.1:{port}/redir', method='GET')
try:
    status, headers, _ = onu_proxy.forward(req)
    out = onu_proxy.filter_response_headers(headers, 'D1', '127.0.0.1', SESSION_COOKIE)
    od = {k.lower(): v for k, v in out}
except onu_proxy.OnuError as e:
    status, od = 0, {'location': '<redirect diikuti server: %s>' % e}
ok(status == 302,
   'redirect ONU TIDAK diikuti di sisi server (kalau diikuti, daftar-izin IP terlompati)')
ok(od.get('location') == '/onu/D1/login.html',
   'redirect ONU ditulis ulang ke path proxy (browser luar tak bisa menjangkau IP internal)')
srv.shutdown()

# ══ Kegagalan yang dapat dibedakan ══
s = socket.socket(); s.bind(('127.0.0.1', 0)); dead = s.getsockname()[1]; s.close()
try:
    onu_proxy.forward(_u.Request(f'http://127.0.0.1:{dead}/'), timeout=2)
    ok(False, 'port mati → OnuError')
except onu_proxy.OnuError as e:
    ok(e.kind == 'refused', 'port tertutup dikenali "refused"')
    # Pesannya TIDAK boleh menyalahkan ONU: diukur di lapangan, seluruh
    # 10.17.x.x terbuka dan seluruh 10.18.x.x terfilter walau perangkatnya
    # sehat (ping 1,2 ms, CWMP terbuka). Menuduh ONU membuat operator
    # membongkar perangkat yang tidak rusak.
    ok('firewall' in str(e).lower(),
       'pesan mengarahkan ke firewall, bukan menuduh ONU rusak')
    ok('sehat' in str(e).lower(),
       'pesan menyebut perangkatnya kemungkinan sehat')

# ── TIMEOUT (blok 10.18 di-DROP, jadi TIMEOUT bukan refused) ──
# Ini kasus NYATA: MikroTik men-drop port 80 ke 10.18.x.x. Tanpa petunjuk
# subnet, pesannya cuma "ONU tidak menjawab" → teknisi menyangka ONU mati.
# 203.0.113.x (TEST-NET-3) tak terjangkau → connect menggantung → timeout cepat.
try:
    onu_proxy.forward(_u.Request('http://203.0.113.1/'), timeout=1)
    ok(False, 'host tak terjangkau → OnuError')
except onu_proxy.OnuError as e:
    ok(e.kind in ('timeout', 'network'), 'host tak terjangkau → timeout/network, bukan crash')

# Petunjuk firewall bersifat UMUM (tidak menyebut blok alamat tertentu): galat
# "tak terjangkau" selalu mengarahkan ke firewall lebih dulu, bukan menuduh ONU.
msg = onu_proxy._unreachable_hint('10.18.4.84')
ok('firewall' in msg.lower() and 'sehat' in msg.lower() and 'port 80' in msg.lower(),
   '_unreachable_hint: sebut firewall + sehat + port 80')
ok(onu_proxy._unreachable_hint('10.0.0.5') == msg, '_unreachable_hint: sama untuk alamat mana pun')
import re as _re
ok(not _re.search(r'\d+\.\d+\.', msg), '_unreachable_hint: tidak memuat alamat jaringan')

# ══ probe: TCP connect saja, tidak mengirim apa pun ke ONU ══
srv2 = ThreadingHTTPServer(('127.0.0.1', 0), FakeOnu)
srv2.daemon_threads = True
p2 = srv2.server_address[1]
threading.Thread(target=srv2.serve_forever, daemon=True).start()
ok(onu_proxy.probe('127.0.0.1', p2) is True, 'probe: port hidup → True')
srv2.shutdown()
ok(onu_proxy.probe('127.0.0.1', dead, timeout=2) is False, 'probe: port mati → False')

# ══ Audit ══
db.conn()
onu_proxy.audit_open('D1', '10.17.1.224', {'id': None, 'username': 'admin'}, '1.2.3.4')
rows = db.audit_list(limit=5)
ok(any(r['action'] == 'onu.remote.open' for r in rows), 'membuka ONU tercatat di audit_log')
ok(any('10.17.1.224' in (r['detail'] or '') for r in rows), 'jejak menyebut ONU mana')

print('onuproxy: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
