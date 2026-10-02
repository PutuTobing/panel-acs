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

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
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

# ══ 4. Pengalihan navigasi (server.py) ══
import server
class H:
    def __init__(s, h, cmd='GET'): s.headers, s.command = h, cmd
nav = server.Handler._is_navigasi if hasattr(server, 'Handler') else None
if nav is None:
    kelas = [v for v in vars(server).values() if isinstance(v, type) and hasattr(v, '_is_navigasi')]
    nav = kelas[0]._is_navigasi
ok(nav(H({'Sec-Fetch-Mode': 'navigate'})) is True, 'Sec-Fetch-Mode navigate → navigasi')
ok(nav(H({'Sec-Fetch-Mode': 'cors', 'Accept': 'text/html'})) is False, 'Sec-Fetch-Mode cors → bukan')
ok(nav(H({'Accept': 'text/html,application/xhtml+xml'})) is True, 'tanpa Sec-Fetch: Accept text/html → navigasi')
ok(nav(H({'Accept': 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest'})) is False, 'XHR jQuery → bukan')
ok(nav(H({'Accept': '*/*'})) is False and nav(H({'Accept': 'image/avif,image/webp'})) is False, 'aset → bukan')
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server.py'), encoding='utf-8').read()
ok("self.send_header('Location', onu_proxy.PREFIX + raw + self.path)" in src, 'navigasi lewat Referer dialihkan ke /onu/<id><path>')

print(f'onucookie: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
