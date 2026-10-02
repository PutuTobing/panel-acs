#!/usr/bin/env python3
"""Uji penyimpanan Profil Vendor di server (2026-10-03).

Sebelumnya profil (Vendor Configuration & Security Setting) hanya hidup di
localStorage tiap browser: perubahan admin tak sampai ke teknisi lain, hilang saat
data browser dibersihkan, dan role `user` bisa mengubah profil yang menentukan
parameter apa yang ditulis ke ONU pelanggan.

YANG DIJAGA:
  1. Validasi DI SERVER (form bisa dilewati dengan satu curl).
  2. Hanya administrator yang boleh menyimpan; semua yang login boleh membaca.
  3. Belum pernah disimpan = None → panel memakai bawaan dari kode.
  4. Boot (/config/all) membawa profil, dan jalur ini bukan rute SPA.
"""
import os, sys, json, tempfile, threading, http.client
from http.server import ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db
db.set_path(os.path.join(tempfile.mkdtemp(prefix='skyvendor-'), 'sky.db'))
import config_store

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

SAH = [{'id': 'a1', 'manufacturer': 'CDTC', 'productClasses': 'FD512XW-R460', 'template': 'X_CT-COM',
        'adminSuperPassPath': 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
        'remotePath': '/cgi-bin/content.asp', 'disunting': True,
        'encModes': [{'id': 'wpa2aes', 'label': 'WPA2-PSK-AES', 'beacon': '11i', 'set': {'IEEE11iEncryptionModes': 'AESEncryption'}}]}]
ADMIN = {'id': 'u1', 'username': 'admin', 'role': 'administrator'}

# ══ 1. Simpan & baca ══
ok(config_store.vendor_get('wan') is None and config_store.vendor_get('security') is None, 'belum pernah disimpan → None (pakai bawaan kode)')
ok(config_store.vendor_set('security', SAH, ADMIN) == SAH and config_store.vendor_get('security') == SAH, 'daftar tersimpan & terbaca utuh')
ok(config_store.vendor_get('wan') is None, 'jenis lain tidak ikut terisi')
ok(config_store.vendor_get_all() == {'wan': None, 'security': SAH}, 'vendor_get_all')
ok(config_store.vendor_set('security', [], ADMIN) is None and config_store.vendor_get('security') is None,
   'daftar kosong = kembali ke bawaan (None), bukan "tanpa profil sama sekali"')
config_store.vendor_set('security', SAH, ADMIN)
ok(config_store.vendor_set('security', None, ADMIN) is None and config_store.vendor_get('security') is None, 'None = reset ke bawaan')

# ══ 2. Validasi ══
def tolak(kind, daftar):
    try:
        config_store.vendor_set(kind, daftar, ADMIN); return False
    except ValueError:
        return True
e = dict(SAH[0])
ok(tolak('lain', SAH), 'jenis tak dikenal ditolak')
ok(tolak('security', {'a': 1}), 'bukan larik ditolak')
ok(tolak('security', [dict(e, id='')]), 'tanpa id ditolak')
ok(tolak('security', [e, dict(e)]), 'id kembar ditolak')
ok(tolak('security', [{'id': 'x'}]), 'tanpa OUI/Manufacturer/Product ditolak')
ok(tolak('security', [dict(e, remotePath='//evil.example/x')]) and tolak('security', [dict(e, remotePath='http://x/')])
   and tolak('security', [dict(e, remotePath='/a/../b')]), 'halaman Remote ke luar panel ditolak')
ok(tolak('security', [dict(e, adminSuperPassPath='rm -rf')]) and tolak('security', [dict(e, adminUserUserPath='A.B,C.D')]),
   'path akun di luar awalan sah / berkoma ditolak')
ok(tolak('security', [dict(e, encModes=[{'id': 'wpa', 'label': 'x', 'beacon': '11i'}])])
   and tolak('security', [dict(e, encModes='x')]) and tolak('security', [dict(e, encModes=[{'id': 'a'}])]), 'pilihan enkripsi cacat ditolak')
ok(tolak('wan', [dict(id=str(i), productClasses='X') for i in range(201)]), 'lebih dari 200 entri ditolak')
ok(tolak('wan', [dict(id='b', productClasses='X', besar='z' * 400000)]), 'daftar raksasa ditolak')
ok(config_store.vendor_get('security') is None and config_store.vendor_get('wan') is None, 'yang ditolak tidak pernah tersimpan')
ok(not tolak('security', [dict(e, adminSuperPassPath='', remotePath='', encModes=[])]), 'kolom kosong sah')
config_store.vendor_set('security', None, ADMIN)

# ══ 3. Lewat server: RBAC & boot ══
import server, auth
PENGGUNA = {'adm': {'id': 'u1', 'username': 'admin', 'role': 'administrator'},
            'usr': {'id': 'u2', 'username': 'teknisi', 'role': 'user'}}
server.SPAHandler._current_user = lambda self: PENGGUNA.get((self.headers.get('X-Uji') or ''))
server.SPAHandler.log_message = lambda *a, **k: None
srv = ThreadingHTTPServer(('127.0.0.1', 0), server.SPAHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
def minta(metode, path, siapa=None, body=None):
    c = http.client.HTTPConnection('127.0.0.1', srv.server_address[1], timeout=10)
    h = {'Content-Type': 'application/json'}
    if siapa: h['X-Uji'] = siapa
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse(); raw = r.read(); c.close()
    try: return r.status, json.loads(raw or b'{}')
    except Exception: return r.status, {}
try:
    st, _ = minta('GET', '/config/vendor-profiles')
    ok(st == 401, 'tanpa login → 401')
    st, d = minta('POST', '/config/vendor-profiles', 'usr', {'kind': 'security', 'list': SAH})
    ok(st == 403 and config_store.vendor_get('security') is None, 'role user TIDAK boleh menyimpan (403) & tidak tersimpan')
    st, d = minta('POST', '/config/vendor-profiles', 'adm', {'kind': 'security', 'list': [dict(e, remotePath='//x')]})
    ok(st == 400 and 'Remote' in (d.get('error') or ''), 'isian tak sah → 400 dengan alasan')
    st, d = minta('POST', '/config/vendor-profiles', 'adm', {'kind': 'security', 'list': SAH})
    ok(st == 200 and d.get('list') == SAH, 'administrator menyimpan → 200')
    st, d = minta('GET', '/config/vendor-profiles', 'usr')
    ok(st == 200 and d['profiles']['security'] == SAH and d['bisaUbah'] == {'wan': False, 'security': False},
       'role user boleh MEMBACA; bisaUbah=false untuk kedua jenis (izin bawaan)')
    st, d = minta('GET', '/config/all', 'usr')
    ok(st == 200 and d.get('vendorProfiles') == {'wan': None, 'security': SAH}, 'boot /config/all membawa profil vendor')
    rows = db.conn().execute("SELECT action FROM audit_log WHERE action LIKE 'vendor.%' OR action='access.denied'").fetchall()
    aksi = [r['action'] for r in rows]
    ok('vendor.set' in aksi and 'access.denied' in aksi, 'perubahan & percobaan ditolak tercatat di audit log')
finally:
    srv.shutdown()

# ══ 4. Sisi browser memakai jalur ini ══
js = open(os.path.join(ROOT, 'frontend', 'js', 'settings.js'), encoding='utf-8').read()
mainjs = open(os.path.join(ROOT, 'frontend', 'js', 'main.js'), encoding='utf-8').read()
ok("authFetch('/config/vendor-profiles', { method: 'POST'" in js, 'form menyimpan ke /config/vendor-profiles')
ok(js.count("simpanProfilServer('wan'") >= 3 and js.count("simpanProfilServer('security'") >= 3, 'Simpan, Hapus, Segarkan Default → server (kedua menu)')
ok('terapkanProfilServer(d.vendorProfiles)' in mainjs and 'terapkanProfilServer(d.vendorProfiles)' in js, 'profil server dipasang saat boot & saat Settings dibuka')
ok("localStorage.setItem(_PROFIL_KUNCI[kind], JSON.stringify(daftarLama))" in js, 'gagal simpan → cache browser dikembalikan')

print(f'vendorprofil: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
