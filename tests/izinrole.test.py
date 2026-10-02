#!/usr/bin/env python3
"""Uji hak akses role per sub-menu Settings (2026-10-03).

Permintaan pengguna: role `user` di Settings hanya membuka "Akun Saya" dan "Tentang
Sistem"; menu lain dibuka administrator per menu. Lihat config_store.IZIN_KUNCI.

YANG DIJAGA:
  1. Penyimpanan: bawaan, normalisasi, "Akun Saya" tak bisa dicabut, administrator
     tak bisa dikurangi, isian cacat ditolak, baris rusak → bawaan (yang tersempit).
  2. Pagar DI SERVER (bukan di menu): tiap endpoint menu → 403 tanpa izin, lolos
     sesudah administrator membukanya. Mengelola akun & mengatur izin tetap khusus
     administrator, apa pun izinnya — kalau tidak, pemegang izin bisa mengangkat
     dirinya sendiri jadi administrator.
  3. Data yang tak perlu bagi role user tidak dikirim: alamat/akun NBI, letak berkas DB.
  4. Kunci di server = atribut data-izin di settings.html = label di settings.js.

Memakai DB sementara; GenieACS diarahkan ke port MATI — tidak menyentuh produksi.
"""
import os, sys, re, json, socket, tempfile, threading, http.client
from http.server import ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db, auth
TMP = tempfile.mkdtemp(prefix='skyizin-')
auth.DATA_DIR = TMP
db.set_path(os.path.join(TMP, 'sky.db'))
db.init()
import config_store

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

# Alamat GenieACS → port mati di komputer ini. Bawaan 127.0.0.1:7557 di laptop operator
# kadang diteruskan ke GenieACS PRODUKSI; uji tidak boleh bertanya ke sana sama sekali.
_s = socket.socket(); _s.bind(('127.0.0.1', 0)); _port_mati = _s.getsockname()[1]; _s.close()
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': _port_mati, 'base_path': ''})

SEMUA = list(config_store.IZIN_KUNCI)
ADM = auth.create_user('admin.uji', 'Admin#Uji-2026', 'Admin Uji', role='administrator')
USR = auth.create_user('teknisi.uji', 'Teknisi#Uji-2026', 'Teknisi Uji', role='user')
LAIN = auth.create_user('teknisi.lain', 'Teknisi#Lain-2026', 'Teknisi Lain', role='user')

# ══ 1. Penyimpanan ══
ok(config_store.izin_role_get() == {'user': ['akunSaya', 'tentang']}, 'bawaan role user: Akun Saya + Tentang Sistem')
ok(config_store.izin_user(ADM) == SEMUA, 'administrator memegang semua izin')
ok(config_store.izin_user(USR) == ['akunSaya', 'tentang'], 'role user memakai bawaan')
ok(config_store.izin_user({'role': 'tamu'}) == ['akunSaya'] and config_store.izin_user(None) == ['akunSaya'],
   'role tak dikenal / tanpa pengguna: hanya Akun Saya')
ok(config_store.izin_role_set('user', ['tentang', 'kesehatan', 'kesehatan'], ADM) == ['akunSaya', 'kesehatan', 'tentang'],
   'disimpan rapi: urut kunci, tanpa kembar, Akun Saya selalu ikut')
ok(config_store.izin_punya(USR, 'kesehatan') and not config_store.izin_punya(USR, 'koneksiAcs'), 'izin_punya mengikuti simpanan')
ok(config_store.izin_role_set('user', [], ADM) == ['akunSaya'], 'semua dicabut → Akun Saya tetap ada (ganti password sendiri)')
def tolak(role, daftar):
    try:
        config_store.izin_role_set(role, daftar, ADM); return False
    except ValueError:
        return True
ok(tolak('administrator', ['akunSaya']), 'izin administrator tidak bisa diubah (tak bisa dikurangi)')
ok(tolak('tamu', ['akunSaya']), 'role tak dikenal ditolak')
ok(tolak('user', ['akunSaya', 'jadiAdmin']), 'kunci izin tak dikenal ditolak')
ok(tolak('user', 'tentang') and tolak('user', [1, 2]) and tolak('user', None), 'bukan larik teks ditolak')
ok(config_store.izin_user(USR) == ['akunSaya'], 'yang ditolak tidak pernah tersimpan')
db.kv_set('app_parameters', config_store.IZIN_ROLE_KEY, '{rusak')
ok(config_store.izin_role_get() == {'user': ['akunSaya', 'tentang']}, 'baris rusak di DB → bawaan, Settings tidak mati')
db.kv_set('app_parameters', config_store.IZIN_ROLE_KEY, json.dumps({'user': ['tentang', 'asing', 5]}))
ok(config_store.izin_user(USR) == ['akunSaya', 'tentang'], 'kunci asing di DB diabaikan')
config_store.izin_role_set('user', ['akunSaya', 'tentang'], ADM)
jejak = [r['detail'] for r in db.audit_list(action='izin_role.update')]
ok(any('dibuka: kesehatan' in d for d in jejak) and any('ditutup:' in d for d in jejak),
   'setiap perubahan izin tercatat di audit log (menu yang dibuka & ditutup)')

# ══ 2. Lewat server ══
import server
PENGGUNA = {'adm': ADM, 'usr': USR}
server.SPAHandler._current_user = lambda self: PENGGUNA.get(self.headers.get('X-Uji') or '')
server.SPAHandler.log_message = lambda *a, **k: None
srv = ThreadingHTTPServer(('127.0.0.1', 0), server.SPAHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def minta(metode, path, siapa=None, body=None):
    c = http.client.HTTPConnection('127.0.0.1', srv.server_address[1], timeout=20)
    h = {'Content-Type': 'application/json'}
    if siapa: h['X-Uji'] = siapa
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse(); raw = r.read(); c.close()
    try: return r.status, json.loads(raw or b'{}')
    except Exception: return r.status, {}

def buka(*kunci):
    st, d = minta('POST', '/config/izin-role', 'adm', {'role': 'user', 'izin': list(kunci)})
    assert st == 200, (st, d)

# Endpoint per menu. Isian yang dikirim sengaja TIDAK sah / tanpa efek: yang diuji di sini
# pagar izinnya (403 vs bukan-403), bukan isinya — dan tak satu pun boleh mengubah apa-apa.
TITIK = [
    ('manajemenAkun',  'GET',  '/auth/users', None),
    ('koneksiAcs',     'POST', '/config/acs', {'protocol': 'file', 'host': 'x', 'port': 1}),
    ('koneksiAcs',     'POST', '/config/acs/test', {'protocol': 'file', 'host': '', 'port': 0}),
    ('parameter',      'POST', '/config/params', {'perPage': 1}),
    ('keselamatan',    'POST', '/config/mode-aman', {'aktif': False}),
    ('kesehatan',      'GET',  '/config/kesehatan', None),
    ('kesehatan',      'GET',  '/config/kesehatan/bersihkan', None),
    ('kesehatan',      'POST', '/config/kesehatan/bersihkan', {'ids': []}),
    ('pemetaanVp',     'POST', '/config/vp-mapping', {'mapping': {'fields': {'bukanField': {}}}}),
    ('vendorWan',      'POST', '/config/vendor-profiles', {'kind': 'wan', 'list': [{'id': ''}]}),
    ('vendorSecurity', 'POST', '/config/vendor-profiles', {'kind': 'security', 'list': [{'id': ''}]}),
    ('tentang',        'GET',  '/config/about', None),
]
try:
    # ── bawaan: hanya Akun Saya + Tentang Sistem ──
    for kunci, m, p, b in TITIK:
        st, d = minta(m, p, 'usr', b)
        if kunci == 'tentang':
            ok(st == 200, 'bawaan: Tentang Sistem terbuka untuk role user')
        else:
            ok(st == 403, 'bawaan: role user ditolak %s %s (izin %s), dapat %d' % (m, p, kunci, st))
        st, d = minta(m, p, 'adm', b)
        ok(st != 403, 'administrator lolos pagar %s %s (dapat %d)' % (m, p, st))
    ok(config_store.acs_url().endswith(':%d' % _port_mati) and config_store.params_get()['perPage'] != 1,
       'isian tak sah di atas tidak mengubah apa pun')
    ok(not config_store.vendor_get('wan') and config_store.vp_get() is None, 'profil & pemetaan tetap bawaan')
    st, d = minta('POST', '/config/vendor-profiles', 'usr', {'kind': 'aneh', 'list': []})
    ok(st == 400, 'jenis profil tak dikenal → 400 (bukan diam-diam dipetakan ke izin lain)')

    # ── data yang dikirim ke role user ──
    st, d = minta('GET', '/auth/me', 'usr')
    ok(st == 200 and d['user'].get('izin') == ['akunSaya', 'tentang'], '/auth/me membawa daftar izin (menu langsung rapi)')
    st, d = minta('GET', '/config/all', 'usr')
    ok(st == 200 and d.get('izin') == ['akunSaya', 'tentang'] and d.get('acs') is None,
       '/config/all role user: izin ikut, alamat & akun NBI TIDAK')
    ok(d.get('params') and 'vpMapping' in d and 'vendorProfiles' in d, '/config/all tetap membawa data operasional')
    st, d = minta('GET', '/config/all', 'adm')
    ok(d.get('izin') == SEMUA and d.get('acs') and d['acs'].get('url'), '/config/all administrator: lengkap')
    st, d = minta('GET', '/config/about', 'usr')
    ok(st == 200 and d.get('acsUrl') is None and d.get('dbPath') is None and d.get('appVersion'),
       'Tentang Sistem role user: tanpa alamat NBI & letak berkas DB')
    st, d = minta('GET', '/config/about', 'adm')
    ok(d.get('acsUrl') and d.get('dbPath'), 'Tentang Sistem administrator: lengkap')
    st, d = minta('GET', '/config', 'usr')
    ok(st == 200 and d.get('acsUrl') == '' and d.get('acsUser') == '', '/config (bentuk lama) role user: alamat NBI dikosongkan')
    st, d = minta('GET', '/config/mode-aman', 'usr')
    ok(st == 200 and d.get('bisaUbah') is False, 'status mode aman tetap terbaca semua role (bilah peringatan), bisaUbah=false')
    st, d = minta('GET', '/config/vendor-profiles', 'usr')
    ok(st == 200 and d.get('bisaUbah') == {'wan': False, 'security': False}, 'profil vendor terbaca; bisaUbah per jenis')

    # ── hak akses itu sendiri: khusus administrator ──
    st, _ = minta('GET', '/config/izin-role', 'usr')
    ok(st == 403, 'role user tidak bisa membaca pengaturan izin')
    st, _ = minta('POST', '/config/izin-role', 'usr', {'role': 'user', 'izin': SEMUA})
    ok(st == 403 and config_store.izin_user(USR) == ['akunSaya', 'tentang'], 'role user tidak bisa memberi dirinya izin')
    st, d = minta('GET', '/config/izin-role', 'adm')
    ok(st == 200 and d.get('kunci') == SEMUA and d.get('wajib') == ['akunSaya'] and d.get('role') == {'user': ['akunSaya', 'tentang']},
       'administrator membaca daftar kunci, yang wajib, dan izin per role')
    st, d = minta('POST', '/config/izin-role', 'adm', {'role': 'administrator', 'izin': ['akunSaya']})
    ok(st == 400, 'izin administrator tidak bisa dikurangi lewat HTTP')
    st, d = minta('POST', '/config/izin-role', 'adm', {'role': 'user', 'izin': ['rahasia']})
    ok(st == 400 and 'tidak dikenal' in d.get('error', ''), 'kunci asing ditolak dengan alasan')

    # ── administrator membuka semua menu → setiap pagar lolos ──
    buka(*SEMUA)
    for kunci, m, p, b in TITIK:
        st, d = minta(m, p, 'usr', b)
        ok(st != 403, 'sesudah dibuka: role user lolos %s %s (dapat %d)' % (m, p, st))
    st, d = minta('GET', '/config/all', 'usr')
    ok(d.get('acs') and d['acs'].get('url'), 'izin Koneksi ACS → form Koneksi ACS terisi')
    st, d = minta('GET', '/config/mode-aman', 'usr')
    ok(d.get('bisaUbah') is True, 'izin Keselamatan ONU → tombol Mode Aman aktif')
    st, d = minta('GET', '/config/vendor-profiles', 'usr')
    ok(d.get('bisaUbah') == {'wan': True, 'security': True}, 'izin profil vendor → bisaUbah per jenis')

    # ── tetapi mengelola akun TETAP khusus administrator ──
    st, d = minta('GET', '/auth/users', 'usr')
    ok(st == 200 and len(d.get('users', [])) == 3, 'izin Manajemen Akun → daftar akun TERBACA')
    st, _ = minta('POST', '/auth/users', 'usr', {'username': 'sisipan', 'password': 'Sisipan#Kuat-2026',
                                                 'name': 'Sisipan', 'role': 'administrator'})
    ok(st == 403 and not auth.get_by_username('sisipan'), 'izin Manajemen Akun TIDAK bisa membuat akun')
    st, _ = minta('PATCH', '/auth/users/' + USR['id'], 'usr', {'role': 'administrator'})
    ok(st == 403 and auth.get_by_id(USR['id'])['role'] == 'user', 'izin Manajemen Akun TIDAK bisa mengangkat diri jadi administrator')
    st, _ = minta('PATCH', '/auth/users/' + LAIN['id'], 'usr', {'status': 'nonaktif'})
    ok(st == 403 and auth.get_by_id(LAIN['id'])['status'] == 'aktif', 'izin Manajemen Akun TIDAK bisa mengubah akun lain')
    st, _ = minta('DELETE', '/auth/users/' + LAIN['id'], 'usr')
    ok(st == 403 and auth.get_by_id(LAIN['id']), 'izin Manajemen Akun TIDAK bisa menghapus akun')
    st, _ = minta('GET', '/auth/audit', 'usr')
    ok(st == 403, 'audit log tetap khusus administrator')
    st, _ = minta('GET', '/config/izin-role', 'usr')
    ok(st == 403, 'dengan SEMUA izin pun, pengaturan izin tetap khusus administrator')
    st, d = minta('PATCH', '/auth/users/' + USR['id'], 'usr', {'name': 'Teknisi Baru'})
    ok(st == 200 and d['user']['name'] == 'Teknisi Baru' and d['user'].get('izin') == SEMUA,
       'mengubah profil sendiri tetap bisa; jawabannya membawa izin (menu tidak "hilang" sesudah simpan)')

    # ── izin dicabut → langsung berlaku (dibaca dari DB tiap permintaan) ──
    buka('akunSaya')
    st, _ = minta('GET', '/config/about', 'usr')
    ok(st == 403, 'Tentang Sistem pun bisa ditutup administrator — langsung berlaku tanpa login ulang')
    st, d = minta('GET', '/auth/me', 'usr')
    ok(d['user'].get('izin') == ['akunSaya'], '/auth/me mengikuti perubahan izin')

    jejak = [r['detail'] for r in db.audit_list(limit=500, action='access.denied')]
    ok(any('tanpa izin "kesehatan"' in x for x in jejak) and any('teknisi.uji' in r['username'] for r in db.audit_list(limit=500, action='access.denied')),
       'percobaan tanpa izin tercatat di audit log beserta pelaku & kunci izinnya')
finally:
    srv.shutdown(); srv.server_close()

# ══ 3. Kunci server = HTML = label di browser ══
html = open(os.path.join(ROOT, 'frontend', 'pages', 'settings.html'), encoding='utf-8').read()
sjs = open(os.path.join(ROOT, 'frontend', 'js', 'settings.js'), encoding='utf-8').read()
mjs = open(os.path.join(ROOT, 'frontend', 'js', 'main.js'), encoding='utf-8').read()
nav = re.findall(r'<button class="st-nav-item[^"]*" data-section="(\w+)"([^>]*)>', html)
ok(len(nav) == len(SEMUA), 'setiap sub-menu Settings punya satu kunci izin (%d menu, %d kunci)' % (len(nav), len(SEMUA)))
peta = {}
for sec, attr in nav:
    m = re.search(r'data-izin="(\w+)"', attr)
    ok(bool(m), 'menu %s bertanda data-izin' % sec)
    if m:
        peta[sec] = m.group(1)
ok(sorted(peta.values()) == sorted(SEMUA), 'kunci di menu Settings = config_store.IZIN_KUNCI')
for sec, kunci in peta.items():
    ok(re.search(r'<div class="st-section[^"]*" id="%s" data-izin="%s"' % (sec, kunci), html),
       'bagian %s bertanda izin yang sama dengan menunya (%s)' % (sec, kunci))
ok('data-admin-only' not in re.search(r'<nav class="st-nav">[\s\S]*?</nav>', html).group(0),
   'tak ada lagi menu Settings yang dikunci keras "khusus admin" — semuanya lewat izin')
ok(re.search(r'id="btnAddUser"[^>]*data-admin-only', html), 'tombol Tambah Akun khusus administrator')
ok(re.search(r'class="card st-card izin-kartu" data-admin-only', html), 'kartu Hak Akses Role User khusus administrator')
label = re.search(r'const _IZIN_INFO = \{([\s\S]*?)\n\};', sjs)
ok(label and sorted(re.findall(r'^\s*(\w+):\s*\[', label.group(1), re.M)) == sorted(SEMUA),
   'label tiap izin di settings.js lengkap & sama dengan kunci server')
ok('data-izin-kunci="' in sjs and 'data-izin="\' +' not in sjs,
   'kotak centang memakai data-izin-kunci (data-izin akan ikut disembunyikan applyRoleVisibility)')
fn = mjs[mjs.index('function applyRoleVisibility'):mjs.index('function punyaIzin')]
ok("querySelectorAll('[data-izin]')" in fn and 'punyaIzin(el.dataset.izin)' in fn, 'applyRoleVisibility menyembunyikan menu tanpa izin')
fn = mjs[mjs.index('function punyaIzin'):mjs.index('function punyaIzin') + 400]
ok("kunci === 'akunSaya'" in fn and 'isAdmin()' in fn, 'punyaIzin: administrator & Akun Saya selalu boleh')
ok('App.user.izin = d.izin' in sjs and '_stNavRapikan()' in sjs, 'izin disegarkan tiap Settings dibuka, menu kosong dirapikan')
ok("authFetch('/config/izin-role', { method: 'POST'" in sjs and 'showConfirm(' in sjs[sjs.index('function simpanIzinRole'):],
   'admin menyimpan lewat /config/izin-role; membuka menu berisiko wajib dikonfirmasi')

import shutil
shutil.rmtree(TMP, ignore_errors=True)
print(f'izinrole: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
