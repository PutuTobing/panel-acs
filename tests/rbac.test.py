#!/usr/bin/env python3
"""Uji RBAC menu Akun (PRD Modul 3) lewat HTTP sungguhan.

Yang diuji di sini adalah inti permintaan PRD 7.2: role `user` TIDAK BOLEH
menjangkau Manajemen Akun "dengan cara apa pun, termasuk melalui akses
route/URL secara langsung".

Karena itu tes ini sengaja TIDAK menyentuh tampilan sama sekali. Menyembunyikan
menu di UI bukan kontrol akses — siapa pun bisa membuka DevTools atau memanggil
endpoint-nya dengan curl. Jadi yang diserang di sini adalah endpoint-nya
langsung, persis seperti penyerang sungguhan.
"""
import os, sys, json, time, socket, tempfile, subprocess
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
TMP  = tempfile.mkdtemp(prefix='skyrbac-')
DB   = os.path.join(TMP, 'sky.db')
CFG  = os.path.join(TMP, 'config.json')

boot = f'''
import sys, os
sys.path.insert(0, {ROOT!r})
import db, auth
auth.DATA_DIR   = {TMP!r}
auth.USERS_PATH = os.path.join({TMP!r}, 'users.json')
db.set_path({DB!r})
pw = auth.ensure_bootstrap()
print('BOOTPW=' + pw, flush=True)
import server
srv = server.ThreadingHTTPServer(('127.0.0.1', {PORT}), server.SPAHandler)
srv.daemon_threads = True
srv.serve_forever()
'''
# SKY_CONFIG WAJIB: tes ini memanggil POST /config dengan URL karangan. Tanpa
# isolasi, penulisannya mendarat di config.json ASLI dan mengarahkan ulang
# proxy panel produksi. Pernah terjadi persis begitu saat menguji-sabotase
# pagar admin — server sungguhan lalu menunjuk ke http://jahat.example:7557.
env = dict(os.environ, SKY_CONFIG=CFG)
proc = subprocess.Popen([sys.executable, '-c', boot], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, cwd=ROOT, env=env)
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

for _ in range(60):
    try:
        socket.create_connection(('127.0.0.1', PORT), 0.25).close(); break
    except OSError:
        time.sleep(0.1)

BASE = f'http://127.0.0.1:{PORT}'


def client():
    """Klien dengan toples cookie sendiri — tiap peran punya sesinya."""
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def call(op, path, method='GET', body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with op.open(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}


try:
    # ── Siapkan: admin login, buat 1 akun role user ──
    adm = client()
    st, d = call(adm, '/auth/login', 'POST', {'username': 'admin', 'password': BOOTPW})
    ok(st == 200 and d['user']['role'] == 'administrator', 'administrator bisa login')
    ADMIN_ID = d['user']['id']

    st, d = call(adm, '/auth/users', 'POST', {
        'username': 'budi', 'password': 'Budi#Kuat2026', 'name': 'Budi Santoso',
        'email': 'budi@x.id', 'phone': '081234567890', 'role': 'user'})
    ok(st == 200 and d['user']['role'] == 'user', 'administrator bisa membuat akun role user')
    BUDI_ID = d['user']['id']
    ok(d['user'].get('status') == 'aktif', 'akun baru berstatus aktif')

    usr = client()
    st, d = call(usr, '/auth/login', 'POST', {'username': 'budi', 'password': 'Budi#Kuat2026'})
    ok(st == 200 and d['user']['role'] == 'user', 'role user bisa login')

    # ══ PRD 7.2 — role user TIDAK BOLEH menjangkau Manajemen Akun ══
    st, _ = call(usr, '/auth/users')
    ok(st == 403, 'role user DITOLAK melihat daftar pengguna (endpoint langsung, bukan lewat menu)')

    st, _ = call(usr, '/auth/users', 'POST', {
        'username': 'sisip', 'password': 'Sisip#Kuat9', 'name': 'Sisipan', 'role': 'administrator'})
    ok(st == 403, 'role user DITOLAK membuat akun baru')

    st, _ = call(usr, '/auth/users/' + ADMIN_ID, 'PATCH', {'name': 'Diretas'})
    ok(st == 403, 'role user DITOLAK mengubah data pengguna lain')

    st, _ = call(usr, '/auth/users/' + ADMIN_ID, 'DELETE')
    ok(st == 403, 'role user DITOLAK menghapus pengguna lain')

    st, _ = call(usr, '/auth/users/' + BUDI_ID, 'PATCH', {'role': 'administrator'})
    ok(st == 403, 'role user DITOLAK menaikkan dirinya jadi administrator')

    st, _ = call(usr, '/auth/users/' + BUDI_ID, 'PATCH', {'status': 'nonaktif'})
    ok(st == 403, 'role user DITOLAK mengubah status akunnya sendiri')

    st, _ = call(usr, '/auth/audit')
    ok(st == 403, 'role user DITOLAK membaca audit log')

    st, _ = call(usr, '/config', 'POST', {'acsUrl': 'http://jahat.example:7557'})
    ok(st == 403, 'role user DITOLAK mengubah konfigurasi (mengarahkan ulang proxy ACS)')

    # ══ PRD 7.3 — role user TETAP bisa mengurus akunnya sendiri ══
    st, d = call(usr, '/auth/users/' + BUDI_ID, 'PATCH',
                 {'name': 'Budi S', 'email': 'budi2@x.id', 'phone': '08999999999'})
    ok(st == 200 and d['user']['name'] == 'Budi S', 'role user BISA mengubah nama/email/HP miliknya')

    st, d = call(usr, '/auth/users/' + BUDI_ID, 'PATCH', {'username': 'budi.s'})
    ok(st == 200 and d['user']['username'] == 'budi.s', 'role user BISA mengubah username miliknya')

    st, _ = call(usr, '/auth/users/' + BUDI_ID, 'PATCH', {'password': 'BaruBudi#9'})
    ok(st == 403, 'ganti password sendiri TANPA password lama ditolak')

    st, _ = call(usr, '/auth/users/' + BUDI_ID, 'PATCH',
                 {'password': 'BaruBudi#9', 'currentPassword': 'Budi#Kuat2026'})
    ok(st == 200, 'ganti password sendiri DENGAN password lama benar → berhasil')

    # Ganti password mencabut sesi — sesi lama harus mati seketika.
    st, _ = call(usr, '/auth/me')
    ok(st == 401, 'sesi lama mati setelah password diganti (sesi curian jadi tak berguna)')

    usr = client()
    st, _ = call(usr, '/auth/login', 'POST', {'username': 'budi.s', 'password': 'BaruBudi#9'})
    ok(st == 200, 'login dengan password baru berhasil')

    # ══ PRD 7.2 — percobaan akses tidak sah TERCATAT di audit_log ══
    st, d = call(adm, '/auth/audit?limit=200')
    ok(st == 200, 'administrator BISA membaca audit log')
    entries = d.get('entries', [])
    denied = [e for e in entries if e['action'] == 'access.denied']
    ok(len(denied) >= 8,
       'percobaan akses tidak sah tercatat di audit_log (%d entri access.denied)' % len(denied))
    ok(any('budi' in (e['username'] or '') for e in denied),
       'jejak access.denied menyebut PELAKUNYA, bukan sekadar "ditolak"')
    ok(any(e['ip_address'] for e in denied), 'jejak access.denied menyimpan IP sumber')

    acts = {e['action'] for e in entries}
    for a in ('login.success', 'account.create', 'account.update', 'access.denied'):
        ok(a in acts, 'audit_log mencatat aksi %s' % a)

    # ══ Administrator: aktifkan / nonaktifkan / hapus ══
    st, d = call(adm, '/auth/users/' + BUDI_ID, 'PATCH', {'status': 'nonaktif'})
    ok(st == 200 and d['user']['status'] == 'nonaktif', 'administrator BISA menonaktifkan akun')

    st, _ = call(usr, '/auth/me')
    ok(st == 401, 'akun dinonaktifkan → sesinya yang sedang aktif langsung diputus')

    bad = client()
    st, _ = call(bad, '/auth/login', 'POST', {'username': 'budi.s', 'password': 'BaruBudi#9'})
    ok(st == 401, 'akun nonaktif TIDAK bisa login walau passwordnya benar')

    st, d = call(adm, '/auth/users/' + BUDI_ID, 'PATCH', {'status': 'aktif'})
    ok(st == 200 and d['user']['status'] == 'aktif', 'administrator BISA mengaktifkan kembali akun')

    back = client()
    st, _ = call(back, '/auth/login', 'POST', {'username': 'budi.s', 'password': 'BaruBudi#9'})
    ok(st == 200, 'akun yang diaktifkan kembali bisa login lagi')

    st, _ = call(adm, '/auth/users/' + BUDI_ID, 'DELETE')
    ok(st == 200, 'administrator BISA menghapus akun')
    st, d = call(adm, '/auth/users')
    ok(all(u['id'] != BUDI_ID for u in d['users']), 'akun benar-benar terhapus dari daftar')

    # Jejak akun yang sudah dihapus TIDAK boleh ikut hilang.
    st, d = call(adm, '/auth/audit?limit=200')
    ok(any('budi' in (e['username'] or '') for e in d['entries']),
       'jejak audit akun yang sudah DIHAPUS tetap ada (audit yang ikut terhapus tak berguna)')

    # ══ Admin terakhir tidak boleh mengunci panel ══
    st, _ = call(adm, '/auth/users/' + ADMIN_ID, 'PATCH', {'role': 'user'})
    ok(st == 400, 'administrator TERAKHIR tidak bisa diturunkan lewat HTTP')
    st, _ = call(adm, '/auth/users/' + ADMIN_ID, 'PATCH', {'status': 'nonaktif'})
    ok(st == 400, 'administrator TERAKHIR tidak bisa dinonaktifkan (panel tak bisa terkunci)')
    st, _ = call(adm, '/auth/users/' + ADMIN_ID, 'DELETE')
    ok(st == 400, 'administrator tidak bisa menghapus akun sendiri')
    st, d = call(adm, '/auth/me')
    ok(st == 200 and d['user']['role'] == 'administrator', 'administrator tetap utuh setelah semua percobaan')

    # ══ Tanpa login: tidak ada satu pun endpoint akun yang terbuka ══
    anon = client()
    for path, method in (('/auth/users', 'GET'), ('/auth/users', 'POST'),
                         ('/auth/audit', 'GET'), ('/auth/me', 'GET')):
        st, _ = call(anon, path, method, {} if method == 'POST' else None)
        ok(st == 401, 'tanpa login: %s %s ditolak 401' % (method, path))

    # ══ Isolasi tes: konfigurasi ASLI tidak boleh tersentuh ══
    # Bukan basa-basi. Tes ini mem-POST acsUrl karangan; kalau isolasinya jebol,
    # proxy panel produksi (1742 ONU) ikut diarahkan ulang. Pernah terjadi
    # persis begitu. Dibuktikan, bukan diasumsikan.
    st, _ = call(adm, '/config', 'POST', {'acsUrl': 'http://uji-isolasi.invalid:7557'})
    ok(st == 200, 'administrator BISA mengubah konfigurasi')
    st, d = call(adm, '/config')
    ok(d.get('acsUrl') == 'http://uji-isolasi.invalid:7557',
       'perubahan acsUrl tersimpan & terbaca kembali')

    # Sumber kebenaran kini DB (yang sudah diisolasi lewat db.set_path), dan
    # /config TIDAK lagi menulis berkas apa pun — jadi tak ada lagi jalur yang
    # bisa menyentuh config.json asli. Kedua fakta itu dikunci di sini.
    real_cfg = os.path.join(ROOT, 'config.json')
    if os.path.exists(real_cfg):
        with open(real_cfg) as f:
            ok('uji-isolasi.invalid' not in f.read(),
               'config.json ASLI tidak tersentuh tes')
    ok(not os.path.exists(CFG),
       'POST /config tidak menulis berkas config.json sama sekali (sumbernya DB)')
    import sqlite3 as _sq
    _c = _sq.connect(DB)
    host = _c.execute('SELECT host FROM acs_connection_settings WHERE id=1').fetchone()
    _c.close()
    ok(host and host[0] == 'uji-isolasi.invalid',
       'perubahan mendarat di DB sementara milik tes, bukan di produksi')

    # ══ Validasi Koneksi ACS ditegakkan di SERVER, bukan hanya di form ══
    for bad, why in (
        ({'protocol': 'file', 'host': 'x', 'port': 7557}, 'protokol file:// ditolak'),
        ({'protocol': 'http', 'host': 'a/b', 'port': 7557}, 'host dengan / ditolak'),
        ({'protocol': 'http', 'host': 'a@b', 'port': 7557}, 'host dengan @ ditolak'),
        ({'protocol': 'http', 'host': 'x', 'port': 0}, 'port 0 ditolak'),
        ({'protocol': 'http', 'host': 'x', 'port': 99999}, 'port di luar jangkauan ditolak'),
        ({'protocol': 'http', 'host': '', 'port': 7557}, 'host kosong ditolak'),
        ({'protocol': 'http', 'host': 'x', 'port': 7557,
          'auth_enabled': True, 'auth_username': ''}, 'auth aktif tanpa username ditolak'),
    ):
        st, _ = call(adm, '/config/acs', 'POST', bad)
        ok(st == 400, 'Koneksi ACS: ' + why)

    # ══ Parameter Aplikasi: batas ditegakkan di server ══
    for bad, why in (
        ({'perPage': 10000000}, 'perPage raksasa ditolak (akan membekukan browser)'),
        ({'perPage': 1}, 'perPage di bawah batas ditolak'),
        ({'onlineThresholdMin': 0}, 'onlineThresholdMin 0 ditolak'),
        ({'rxGood': -30, 'rxFair': -25}, 'rxGood <= rxFair ditolak (semua ONU salah kategori)'),
        ({'perPage': 'banyak'}, 'perPage non-angka ditolak'),
    ):
        st, _ = call(adm, '/config/params', 'POST', bad)
        ok(st == 400, 'Parameter: ' + why)

    st, d = call(adm, '/config/params', 'POST', {'perPage': 50, 'rxGood': -18, 'rxFair': -24})
    ok(st == 200 and d['params']['perPage'] == 50, 'Parameter yang sah tersimpan')

    st, d = call(adm, '/config/all')
    ok(d['params']['rxGood'] == -18, 'Parameter terbaca kembali dari server (bukan localStorage)')

    # Kunci asing tidak boleh diselundupkan masuk ke tabel pengaturan.
    st, _ = call(adm, '/config/params', 'POST', {'perPage': 30, 'jahat': 'x'})
    ok(st == 200, 'kunci asing diabaikan, bukan menggagalkan permintaan')
    st, d = call(adm, '/config/all')
    ok('jahat' not in d['params'], 'kunci asing TIDAK ikut tersimpan')

    # ══ Tampilan: preferensi PRIBADI, bukan global ══
    st, d = call(adm, '/config/display', 'POST', {'theme': 'dark'})
    ok(st == 200 and d['display']['theme'] == 'dark', 'admin bisa menyimpan tema miliknya')
    st, _ = call(adm, '/config/display', 'POST', {'bahasa': 'en'})
    st, d = call(adm, '/config/all')
    ok('bahasa' not in d['display'],
       'pengaturan Bahasa TIDAK ada & tak bisa diselundupkan (PRD 5.3: dikunci Bahasa Indonesia)')

    # ══ Tentang Sistem: data LIVE, bukan hardcode ══
    st, d = call(adm, '/config/about')
    ok(st == 200, 'endpoint Tentang Sistem hidup')
    ok(d.get('hostname') == socket.gethostname(), 'hostname diambil live dari mesin ini')
    # Dibandingkan dengan versi migrasi TERAKHIR, bukan angka beku: yang diuji
    # adalah "dilaporkan live". Angka tetap membuat tes ini gagal tiap kali ada
    # migrasi baru — kegagalan yang tidak menandakan apa pun.
    #
    # MIGRATIONS dibaca sebagai konstanta modul; ini TIDAK membuka koneksi
    # database, jadi proses tes tak pernah menyentuh data/sky.db produksi.
    import db as _db
    ok(d.get('schema') == _db.MIGRATIONS[-1][0], 'versi skema DB dilaporkan live')
    ok(d.get('python', '').startswith('3.'), 'versi Python dilaporkan live')
    ok('uptime' in d and d['uptime'], 'uptime dilaporkan live')

finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print('rbac: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
