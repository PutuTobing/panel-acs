#!/usr/bin/env python3
"""Uji portal pelanggan — role `pelanggan` (2026-10-03).

YANG DIJAGA:
  1. Akun pelanggan hanya memakai jalur di daftar-izinnya: /pel/*, /auth/me, /auth/logout,
     akunnya sendiri. /api, /config, /ops, /onu, daftar akun → 403 (juga lewat curl).
  2. Hanya ONU yang dipasangkan administrator pada akun itu; ONU lain → 403.
  3. Pelanggan tak pernah mengirim nama parameter: server menyusun SSID / password / Enable
     untuk slot WLAN yang ADA di ONU itu, memakai jalur password per model (resep panel).
     Apa pun yang diselundupkan di body (parameterValues, path lain) diabaikan.
  4. Dokumen untuk browser: tanpa username/password PPPoE, akun web ONU, VP rahasia —
     password WiFi miliknya tetap ada.
  5. Perintah lewat jalur yang sama dengan panel (acs_guard + ops_lock → NBI) dan tercatat.

DB sementara; GenieACS = NBI TIRUAN di port lokal — tidak menyentuh produksi.
"""
import os, sys, json, copy, tempfile, threading, http.client, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db, auth
TMP = tempfile.mkdtemp(prefix='skypel-')
auth.DATA_DIR = TMP
db.set_path(os.path.join(TMP, 'sky.db'))
db.init()
import config_store, pelanggan

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

def leaf(v, w=True): return {'_value': v, '_writable': w, '_type': 'xsd:string'}
def wlan(nama, beacon='WPAand11i', aktif='true', **ekstra):
    o = {'SSID': leaf(nama), 'Enable': leaf(aktif), 'BeaconType': leaf(beacon), 'KeyPassphrase': leaf('sandi-lama-1')}
    o.update(ekstra)
    return o
DOK_ZTE = {
    '_id': 'AA11BB-F663NV9-ZTEGUJI0001',
    '_deviceId': {'_SerialNumber': 'ZTEGUJI0001', '_ProductClass': 'F663NV9', '_Manufacturer': 'ZTE', '_OUI': 'AA11BB'},
    '_lastInform': '2026-10-03T03:00:00.000Z',
    'VirtualParameters': {'RXPower': leaf('-19.20'), 'gettemp': leaf('47'), 'pppoeUsername': leaf('budi@sky'),
                          'pppoePassword': leaf('RAHASIA-PPPOE'), 'superAdmin': leaf('RAHASIA-ADMIN')},
    'InternetGatewayDevice': {
        'DeviceInfo': {'UpTime': leaf('9000'), 'X_CMCC_TeleComAccount': {'Username': leaf('telecomadmin'), 'Password': leaf('RAHASIA-WEB')}},
        'WANDevice': {'1': {'WANConnectionDevice': {'1': {'WANPPPConnection': {'1': {
            'Username': leaf('budi@sky'), 'Password': leaf('RAHASIA-PPPOE'), 'ExternalIPAddress': leaf('10.9.9.9')}}}}}},
        'LANDevice': {'1': {'WLANConfiguration': {
            '1': wlan('RUMAH BUDI'), '2': wlan('TAMU', beacon='None', aktif='false')}}},
        'ManagementServer': {'ConnectionRequestPassword': leaf('RAHASIA-CR')},
    },
}
DOK_HW = copy.deepcopy(DOK_ZTE)
DOK_HW['_id'] = '00E0FC-HG8245A-48575443AAAA0001'
DOK_HW['_deviceId'] = {'_SerialNumber': '48575443AAAA0001', '_ProductClass': 'HG8245A',
                       '_Manufacturer': 'Huawei Technologies Co., Ltd', '_OUI': '00E0FC'}
DOK_HW['InternetGatewayDevice']['LANDevice']['1']['WLANConfiguration']['1']['PreSharedKey'] = {'1': {'KeyPassphrase': leaf('x')}}
DOK_LAIN = copy.deepcopy(DOK_ZTE)
DOK_LAIN['_id'] = 'AA11BB-F663NV9-ZTEGORANGLAIN'
DOK_LAIN['_deviceId']['_SerialNumber'] = 'ZTEGORANGLAIN'
DOKS = {d['_id']: d for d in (DOK_ZTE, DOK_HW, DOK_LAIN)}

# ══ 1. Penyusun resep WiFi (murni) ══
def tolak(*a, **k):
    try:
        pelanggan.susun_wifi(*a, **k); return False
    except pelanggan.PelangganError:
        return True
B = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.'
ok(pelanggan.susun_wifi(DOK_ZTE, 1, nama='RUMAH BARU', sandi='SandiBaru123')
   == [[B + '1.SSID', 'RUMAH BARU', 'xsd:string'], [B + '1.KeyPassphrase', 'SandiBaru123', 'xsd:string']],
   'ZTE: nama + password → SSID & KeyPassphrase saja (sama dengan resep panel untuk SSID ber-WPA)')
ok(pelanggan.susun_wifi(DOK_HW, 1, sandi='SandiBaru123') == [[B + '1.PreSharedKey.1.KeyPassphrase', 'SandiBaru123', 'xsd:string']],
   'Huawei: password ke PreSharedKey.1.KeyPassphrase (profil HG8245A/H)')
ok(pelanggan.susun_wifi(DOK_ZTE, 2, aktif=True) == [[B + '2.Enable', True, 'xsd:boolean']], 'nyalakan SSID → Enable saja')
ok(tolak(DOK_ZTE, 2, sandi='SandiBaru123'), 'SSID tanpa password: pelanggan tak bisa memasang password sendiri (hubungi CS)')
ok(tolak(DOK_ZTE, 7, nama='X'), 'slot SSID yang tidak ada di ONU ditolak')
ok(tolak(DOK_ZTE, '1.SSID', nama='X') and tolak(DOK_ZTE, '../1', nama='X'), 'nomor slot karangan ditolak')
ok(tolak(DOK_ZTE, 1, nama='RUMAH BUDI'), 'tanpa perubahan → ditolak, tidak mengirim apa pun')
ok(tolak(DOK_ZTE, 1, nama='A' * 33) and tolak(DOK_ZTE, 1, nama='  ') and tolak(DOK_ZTE, 1, nama='A\nB'), 'nama WiFi 1–32 karakter tanpa karakter kontrol')
ok(tolak(DOK_ZTE, 1, sandi='pendek') and tolak(DOK_ZTE, 1, sandi='x' * 64) and tolak(DOK_ZTE, 1, sandi='sandiÄÖÜ1234'), 'password WiFi 8–63 karakter ASCII')
ok(tolak(DOK_ZTE, 1, aktif='true'), 'status SSID harus boolean sungguhan')
ok(tolak({'_id': 'x', 'Device': {}}, 1, nama='X'), 'model TR-181 (Device.*) belum didukung portal → ditolak')
config_store.vendor_set('security', [{'id': 'p1', 'productClasses': 'F663NV9', 'passwordPath': 'PreSharedKey.1.KeyPassphrase'}],
                        {'id': 'x', 'username': 'admin'})
dz = copy.deepcopy(DOK_ZTE)
dz['InternetGatewayDevice']['LANDevice']['1']['WLANConfiguration']['1']['PreSharedKey'] = {'1': {'KeyPassphrase': leaf('x')}}
ok(pelanggan.susun_wifi(dz, 1, sandi='SandiBaru123')[0][0].endswith('PreSharedKey.1.KeyPassphrase'),
   'profil Security Setting yang disimpan admin dihormati (jalur password per model)')
ok(pelanggan.susun_wifi(DOK_ZTE, 1, sandi='SandiBaru123')[0][0].endswith('.KeyPassphrase'),
   'jalur dari profil yang tak ada di ONU dilewati → jalur yang memang ada')
config_store.vendor_set('security', None, {'id': 'x', 'username': 'admin'})

# ══ 2. Dokumen untuk browser ══
bersih = json.dumps(pelanggan.bersihkan_dokumen(copy.deepcopy(DOK_ZTE)))
ok('RAHASIA' not in bersih and 'budi@sky' not in bersih and 'telecomadmin' not in bersih,
   'dokumen pelanggan tanpa password/username PPPoE, akun web ONU, VP rahasia')
ok('sandi-lama-1' in bersih and '-19.20' in bersih and 'RUMAH BUDI' in bersih and '10.9.9.9' in bersih,
   'password WiFi miliknya, RX, nama WiFi, IP tetap ada')
ok(set(pelanggan.PROYEKSI) >= {'InternetGatewayDevice.LANDevice'} and not any('ManagementServer' in x for x in pelanggan.PROYEKSI),
   'projection tetap di server; ManagementServer tak pernah diminta')

# ══ 3. Jalur ══
U = {'id': 'u9', 'role': 'pelanggan'}
ok(all(pelanggan.jalur_boleh(m, p, U) for m, p in [('GET', '/pel/onu', ), ('GET', '/auth/me'), ('POST', '/auth/logout'),
                                                    ('PATCH', '/auth/users/u9')]), 'jalur yang boleh')
ok(not any(pelanggan.jalur_boleh(m, p, U) for m, p in [('GET', '/api/devices'), ('GET', '/config/all'), ('GET', '/ops/'),
                                                        ('GET', '/auth/users'), ('PATCH', '/auth/users/u1'), ('GET', '/auth/audit'),
                                                        ('GET', '/pelanggan-palsu/../api')]), 'jalur selain itu ditolak')

# ══ 4. Lewat server sungguhan + NBI tiruan ══
class Nbi(BaseHTTPRequestHandler):
    tulis = []
    def log_message(self, *a): pass
    def _json(self, st, o):
        b = json.dumps(o).encode(); self.send_response(st); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = json.loads(urllib.parse.parse_qs(u.query).get('query', ['{}'])[0])
        if u.path == '/devices':
            if '_id' in q: return self._json(200, [DOKS[q['_id']]] if q['_id'] in DOKS else [])
            sn = q.get('_deviceId._SerialNumber')
            return self._json(200, [{'_id': d['_id']} for d in DOKS.values() if d['_deviceId']['_SerialNumber'] == sn])
        return self._json(200, [])
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        Nbi.tulis.append((self.path, json.loads(self.rfile.read(n) or b'{}')))
        self._json(200, {'_id': 'tugas-%d' % len(Nbi.tulis)})
nbi = ThreadingHTTPServer(('127.0.0.1', 0), Nbi)
threading.Thread(target=nbi.serve_forever, daemon=True).start()
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': nbi.server_address[1], 'base_path': ''})

import server
ADM = auth.create_user('admin.pel', 'Admin#Pel-2026x', 'Admin', role='administrator')
PEL = auth.create_user('pelanggan1', 'Pelanggan123', 'Pelanggan Satu', role='pelanggan')
STF = auth.create_user('teknisi.pel', 'Teknisi#Pel-2026', 'Teknisi', role='user')
srv = server.buat_server('127.0.0.1', 0)
server.SPAHandler.log_message = lambda *a, **k: None
threading.Thread(target=srv.serve_forever, daemon=True).start()
PORT = srv.server_address[1]

def minta(metode, path, ck=None, body=None):
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=30)
    h = {'Content-Type': 'application/json'}
    if ck: h['Cookie'] = ck
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse(); raw = r.read(); sc = r.getheader('Set-Cookie'); c.close()
    try: d = json.loads(raw or b'{}')
    except Exception: d = {}
    return r.status, d, sc
def login(u, p):
    st, d, sc = minta('POST', '/auth/login', None, {'username': u, 'password': p})
    assert st == 200, (u, st, d)
    return sc.split(';')[0], d['user']
try:
    cka, _ = login('admin.pel', 'Admin#Pel-2026x')
    ckp, up = login('pelanggan1', 'Pelanggan123')
    ckt, _ = login('teknisi.pel', 'Teknisi#Pel-2026')
    ok(up['role'] == 'pelanggan', 'password contoh "Pelanggan123" memenuhi kebijakan & role pelanggan bisa login')

    # pasangkan ONU (admin)
    st, d, _ = minta('POST', '/config/akun-onu/' + PEL['id'], ckt, {'sn': ['ZTEGUJI0001']})
    ok(st == 403, 'role user tidak bisa memasangkan ONU ke akun pelanggan')
    st, d, _ = minta('POST', '/config/akun-onu/' + STF['id'], cka, {'sn': ['ZTEGUJI0001']})
    ok(st == 400, 'ONU hanya bisa dipasangkan ke akun ber-role pelanggan')
    st, d, _ = minta('POST', '/config/akun-onu/' + PEL['id'], cka, {'sn': ['TIDAKADA999']})
    ok(st == 400 and 'tidak ditemukan' in d.get('error', ''), 'SN yang tak ada di ACS ditolak')
    st, d, _ = minta('POST', '/config/akun-onu/' + PEL['id'], cka, {'sn': ['ZTEGUJI0001', '48575443AAAA0001']})
    ok(st == 200 and [o['sn'] for o in d['onu']] == ['48575443AAAA0001', 'ZTEGUJI0001'], 'admin memasangkan 2 ONU lewat SN')

    # pagar jalur
    for m, p in [('GET', '/api/devices?projection=_id'), ('GET', '/config/all'), ('GET', '/config/tag'), ('GET', '/ops/'),
                 ('GET', '/auth/users'), ('POST', '/api/devices/' + urllib.parse.quote(DOK_ZTE['_id']) + '/tasks'),
                 ('PATCH', '/auth/users/' + ADM['id']), ('GET', '/config')]:
        st, _, _ = minta(m, p, ckp, {} if m != 'GET' else None)
        ok(st == 403, 'pelanggan ditolak %s %s (dapat %d)' % (m, p, st))
    st, _, _ = minta('GET', '/onu/' + urllib.parse.quote(DOK_ZTE['_id']) + '/', ckp)
    ok(st == 403, 'pelanggan tidak bisa membuka web admin ONU (/onu/)')
    st, d, _ = minta('GET', '/auth/me', ckp)
    ok(st == 200 and d['user']['role'] == 'pelanggan', 'pelanggan boleh /auth/me')
    st, _, _ = minta('GET', '/pel/onu', ckt)
    ok(st == 403, 'akun staf tidak memakai /pel (khusus pelanggan)')

    st, d, _ = minta('GET', '/pel/onu', ckp)
    ok(st == 200 and len(d['onu']) == 2 and d['cs'] == '6282217835764' and 'params' in d, 'daftar ONU milik pelanggan + nomor CS')
    st, d, _ = minta('GET', '/pel/onu/' + urllib.parse.quote(DOK_LAIN['_id'], safe=''), ckp)
    ok(st == 403, 'ONU milik orang lain → 403')
    st, d, _ = minta('GET', '/pel/onu/' + urllib.parse.quote(DOK_ZTE['_id'], safe=''), ckp)
    teks = json.dumps(d)
    ok(st == 200 and 'RUMAH BUDI' in teks and 'RAHASIA' not in teks and 'budi@sky' not in teks,
       'dokumen ONU sendiri: tanpa kredensial PPPoE/akun web ONU')

    # tulis
    Nbi.tulis.clear()
    enc = urllib.parse.quote(DOK_ZTE['_id'], safe='')
    st, d, _ = minta('POST', '/pel/onu/' + enc + '/wifi', ckp,
                     {'slot': 1, 'nama': 'RUMAH BARU', 'sandi': 'SandiBaru123',
                      'parameterValues': [['InternetGatewayDevice.ManagementServer.URL', 'http://jahat', 'xsd:string']],
                      'path': 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password'})
    ok(st == 200 and len(Nbi.tulis) == 1, 'ubah WiFi → tepat satu perintah ke NBI')
    jalur, tugas = Nbi.tulis[-1] if Nbi.tulis else ('', {})
    ok(tugas == {'name': 'setParameterValues', 'parameterValues': [
        [B + '1.SSID', 'RUMAH BARU', 'xsd:string'], [B + '1.KeyPassphrase', 'SandiBaru123', 'xsd:string']]},
       'isi perintah disusun server; parameterValues/path selundupan diabaikan')
    ok(jalur.startswith('/devices/' + enc + '/tasks') and 'connection_request' in jalur, 'dikirim lewat jalur task panel (connection_request)')
    st, d, _ = minta('POST', '/pel/onu/' + enc + '/wifi', ckp, {'slot': 2, 'sandi': 'SandiBaru123'})
    ok(st == 400 and 'customer service' in d.get('error', ''), 'password pada WiFi tanpa password → 400 berpenjelasan')
    st, d, _ = minta('POST', '/pel/onu/' + urllib.parse.quote(DOK_LAIN['_id'], safe='') + '/reboot', ckp, {})
    ok(st == 403 and len(Nbi.tulis) == 1, 'reboot ONU orang lain ditolak, tak ada yang terkirim')
    st, d, _ = minta('POST', '/pel/onu/' + urllib.parse.quote(DOK_HW['_id'], safe='') + '/reboot', ckp, {})
    ok(st == 200 and Nbi.tulis[-1][1] == {'name': 'reboot'}, 'reboot ONU sendiri')
    st, d, _ = minta('POST', '/pel/onu/' + urllib.parse.quote(DOK_HW['_id'], safe='') + '/refresh', ckp, {})
    ok(st in (200, 429) and (st == 429 or Nbi.tulis[-1][1] == {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice.LANDevice.1'}),
       'refresh ringan: hanya LANDevice.1 (WiFi & perangkat terhubung) — atau ditahan masa istirahat')
    st, d, _ = minta('GET', '/pel/onu/' + enc + '/tugas/tugas-1', ckp)
    ok(st == 200 and d.get('state') == 'selesai', 'nasib task dapat ditanyakan (selesai)')
    st, _, _ = minta('PATCH', '/auth/users/' + PEL['id'], ckp, {'role': 'administrator'})
    ok(st == 403, 'pelanggan tidak bisa mengangkat dirinya jadi administrator')
finally:
    srv.shutdown(); srv.server_close(); nbi.shutdown()

aksi = [r['action'] + ' ' + r['detail'] for r in db.audit_list(limit=300)]
ok(any(a.startswith('pelanggan.wifi ') and 'SSID, KeyPassphrase' in a for a in aksi), 'ubah WiFi tercatat (nama parameter saja)')
ok(not any('SandiBaru123' in a for a in aksi), 'password WiFi baru TIDAK pernah tercatat di audit log')
ok(any(a.startswith('pelanggan.onu ') for a in aksi) and any(a.startswith('access.denied ') and 'pelanggan' in a for a in aksi),
   'pemasangan ONU & percobaan terlarang tercatat')

# ══ 5. Halaman ══
html = open(os.path.join(ROOT, 'frontend', 'pelanggan', 'index.html'), encoding='utf-8').read()
js = open(os.path.join(ROOT, 'frontend', 'pelanggan', 'pelanggan.js'), encoding='utf-8').read()
ok('name=\"viewport\"' in html.replace("'", '"') and 'integrity="sha512-' in html, 'halaman HP (viewport) & Font Awesome ber-SRI')
ok('/api/' not in js and "'/config" not in js and 'parameterValues' not in js, 'halaman pelanggan tak memanggil /api atau /config dan tak menyusun parameter')
ok('Saat ini router tidak merespon, mohon menunggu atau hubungi customer service di WhatsApp' in js
   and 'saya mengalami kendala mengganti nama dan password wifi saya' in js and 'wa.me/' in js,
   'gagal → pesan & tautan WhatsApp CS sesuai permintaan')

import shutil
shutil.rmtree(TMP, ignore_errors=True)
print(f'pelanggan: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
