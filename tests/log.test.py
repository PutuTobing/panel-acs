#!/usr/bin/env python3
"""Uji menu Log — aktivitas per role & akun (2026-10-03).

YANG DIJAGA:
  1. Setiap operasi ONU lewat panel (WAN, WiFi, akun web, reboot, refresh, tambah/hapus
     objek, hapus perangkat) meninggalkan SATU baris berupa kalimat + SN + hasilnya,
     dicatat sesudah GenieACS menjawab. Dulu hanya reboot yang tercatat.
  2. NILAI tidak pernah ikut tercatat: password WiFi, password PPPoE, akun web ONU.
  3. Role pelaku tersimpan SAAT kejadian (kolom `role`, migrasi 10) dan bisa disaring:
     ALL / administrator / user / pelanggan, nama akun, jenis kejadian, kata cari.
  4. Perintah baca tidak membanjiri Log; refresh beruntun dicatat sekali per menit.
  5. Menu Log khusus administrator — role user & pelanggan ditolak SERVER.
  6. Login gagal pada akun yang ada tercatat atas nama akun itu; username karangan
     tidak pernah masuk daftar saringan "nama akun".

DB sementara; GenieACS = NBI TIRUAN di port lokal — tidak menyentuh produksi.
"""
import os, sys, json, tempfile, threading, http.client, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db, auth
TMP = tempfile.mkdtemp(prefix='skylog-')
auth.DATA_DIR = TMP

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

# ══ 1. Migrasi 10: catatan lama mendapat role dari akunnya ══
semua = list(db.MIGRATIONS)
ok(semua[-1][0] >= 10 and [m for m in semua if m[0] == 10][0][2].count('ALTER TABLE audit_log ADD COLUMN role') == 1,
   'migrasi 10 menambah kolom role pada audit_log')
db.set_path(os.path.join(TMP, 'lama.db'))
db.MIGRATIONS = [m for m in semua if m[0] < 10]
db.init()
c = db.conn()
c.execute("INSERT INTO users (id, username, password_hash, name, role, status, created_at, updated_at)"
          " VALUES ('u-lama', 'lama', 'x', 'Lama', 'user', 'aktif', ?, ?)", (db.now(), db.now()))
c.execute("INSERT INTO audit_log (user_id, username, action, detail, ip_address, created_at)"
          " VALUES ('u-lama', 'lama', 'onu_reboot', '/api/devices/AA-B-SN1/tasks', '', ?)", (db.now(),))
c.execute("INSERT INTO audit_log (user_id, username, action, detail, ip_address, created_at)"
          " VALUES (NULL, '', 'login.failed', 'username=x', '', ?)", (db.now(),))
c.commit()
db.MIGRATIONS = semua
db.set_path(os.path.join(TMP, 'lama.db'))      # tutup + lupakan "sudah dimigrasi" → seperti panel dinyalakan ulang
db.init()
lama = {r['action']: r['role'] for r in db.conn().execute('SELECT action, role FROM audit_log')}
ok(lama == {'onu_reboot': 'user', 'login.failed': ''},
   'catatan sebelum migrasi: role diisi dari akunnya; yang tanpa akun tetap kosong — dapat %r' % lama)
db.close()

# ══ 2. Penerjemah perintah → kalimat (murni) ══
import logonu
I = 'InternetGatewayDevice.'
DEV = 'AA11BB-F663NV9-ZTEGUJI0001'
def u(tugas, metode='POST', jalur='/devices/' + DEV + '/tasks?connection_request'):
    return logonu.uraikan(metode, jalur, json.dumps(tugas).encode())
W = I + 'LANDevice.1.WLANConfiguration.'
h = u({'name': 'setParameterValues', 'parameterValues': [[W + '1.SSID', 'RUMAH-RAHASIA', 'xsd:string'],
                                                         [W + '1.PreSharedKey.1.KeyPassphrase', 'SANDI-RAHASIA', 'xsd:string']]})
ok(h == ('onu.wifi', DEV, 'mengganti nama & password WiFi (SSID 1) pada {onu}'), 'nama + password WiFi → satu kalimat: %r' % (h,))
ok(u({'name': 'setParameterValues', 'parameterValues': [[W + '1.KeyPassphrase', 'x']]})[2] == 'mengganti password WiFi (SSID 1) pada {onu}',
   'password WiFi saja')
ok(u({'name': 'setParameterValues', 'parameterValues': [[W + '5.Enable', False, 'xsd:boolean']]})[2] == 'mematikan WiFi (SSID 5) pada {onu}'
   and u({'name': 'setParameterValues', 'parameterValues': [[W + '2.Enable', 'true']]})[2] == 'menyalakan WiFi (SSID 2) pada {onu}',
   'nyala / mati SSID dibedakan')
P = I + 'WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.'
h = u({'name': 'setParameterValues', 'parameterValues': [[P + 'Username', 'budi@sky'], [P + 'Password', 'PPPOE-RAHASIA'],
                                                         [I + 'WANDevice.1.WANConnectionDevice.2.X_ZTE-COM_VLANID', 100]]})
ok(h[0] == 'onu.wan' and h[2] == 'mengubah WAN (Username, Password, X_ZTE-COM_VLANID) pada {onu}', 'WAN: nama parameter saja — %r' % (h,))
ok(all(u({'name': 'setParameterValues', 'parameterValues': [[p, 'AKUN-RAHASIA']]})[:1] == ('onu.akunweb',) for p in (
       I + 'User.1.Password', I + 'UserInterface.X_HW_WebUserInfo.2.Password', I + 'X_CU_Function.Web.AdminPassword',
       I + 'DeviceInfo.X_CT-COM_TeleComAccount.Password')), 'akun web ONU dikenali di jalur tiap vendor')
ok(u({'name': 'setParameterValues', 'parameterValues': [[I + 'Time.NTPServer1', 'x']]})[:1] == ('onu.ubah',), 'parameter lain → onu.ubah')
banyak = u({'name': 'setParameterValues', 'parameterValues': [[P + 'P%d' % i, i] for i in range(15)]})[2]
ok('+9 lain' in banyak and 'P7' not in banyak, 'daftar nama panjang diringkas: ' + banyak)
ok(u({'name': 'addObject', 'objectName': I + 'WANDevice.1.WANConnectionDevice.2.WANPPPConnection'})
   == ('onu.wan', DEV, 'menambah koneksi WAN (WANPPPConnection) pada {onu}')
   and u({'name': 'deleteObject', 'objectName': I + 'WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2'})[2]
   == 'menghapus koneksi WAN (WANPPPConnection.2) pada {onu}', 'tambah / hapus koneksi WAN')
ok(u({'name': 'reboot'}) == ('onu_reboot', DEV, 'me-reboot {onu}'), 'reboot memakai nama aksi lama (dihitung Kesehatan Sistem)')
ok(u({'name': 'refreshObject', 'objectName': I + 'LANDevice.1'})[0] == 'onu.refresh', 'refresh dikenali')
ok(u({'name': 'getParameterValues', 'parameterNames': ['a']}) is None and u({'name': 'getParameterNames'}) is None,
   'perintah BACA tidak dicatat')
ok(u({}, 'DELETE', '/devices/' + DEV) == ('onu.hapus', DEV, 'menghapus {onu} dari GenieACS'), 'hapus perangkat dari ACS')
ok(u({}, 'DELETE', '/tasks/abc') is None and u({}, 'GET', '/devices/?query=x') is None
   and logonu.uraikan('POST', '/devices/x/tasks', b'bukan json') is None and logonu.uraikan('POST', '/devices/x/tasks', b'[1]') is None,
   'selain itu (termasuk body rusak) → None, tidak pernah melempar')
semua_teks = json.dumps([u({'name': 'setParameterValues', 'parameterValues': [[W + '1.SSID', 'RUMAH-RAHASIA'], [W + '1.KeyPassphrase', 'SANDI-RAHASIA'],
                                                                                 [P + 'Password', 'PPPOE-RAHASIA'], [I + 'User.1.Password', 'AKUN-RAHASIA']]})])
ok('RAHASIA' not in semua_teks, 'tidak satu pun NILAI masuk ke uraian')
ok(logonu.hasil(200) == 'berhasil' and logonu.hasil(202).startswith('diantrekan') and logonu.hasil(504) == 'gagal (HTTP 504)', 'kata hasil')

# ══ 3. Lewat server sungguhan + NBI tiruan ══
db.set_path(os.path.join(TMP, 'sky.db'))
db.init()
import config_store

class Nbi(BaseHTTPRequestHandler):
    tulis = []
    def log_message(self, *a): pass
    def _json(self, st, o):
        b = json.dumps(o).encode(); self.send_response(st); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self): self._json(200, [])
    def do_DELETE(self): Nbi.tulis.append((self.path, None)); self._json(200, {})
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        t = json.loads(self.rfile.read(n) or b'{}'); Nbi.tulis.append((self.path, t))
        if 'ANTRE' in json.dumps(t): return self._json(202, {'_id': 'antre-1'})      # ONU tak menjawab
        if 'RUSAK' in json.dumps(t): return self._json(500, {'error': 'rusak'})
        self._json(200, {'_id': 'tugas-%d' % len(Nbi.tulis)})
nbi = ThreadingHTTPServer(('127.0.0.1', 0), Nbi)
threading.Thread(target=nbi.serve_forever, daemon=True).start()
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': nbi.server_address[1], 'base_path': ''})

import server, pelanggan, ops_lock
ADM = auth.create_user('admin.log', 'Admin#Log-2026x', 'Admin', role='administrator')
STF = auth.create_user('teknisi.log', 'Teknisi#Log-2026', 'Teknisi', role='user')
PEL = auth.create_user('budi', 'Pelanggan123', 'Budi', role='pelanggan')
srv = server.buat_server('127.0.0.1', 0)
server.SPAHandler.log_message = lambda *a, **k: None
threading.Thread(target=srv.serve_forever, daemon=True).start()
PORT = srv.server_address[1]

def minta(metode, path, ck=None, body=None):
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=30)
    hd = {'Content-Type': 'application/json'}
    if ck: hd['Cookie'] = ck
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=hd)
    r = c.getresponse(); raw = r.read(); sc = r.getheader('Set-Cookie'); c.close()
    try: d = json.loads(raw or b'{}')
    except Exception: d = {}
    return r.status, d, sc
def login(usr, pw):
    st, d, sc = minta('POST', '/auth/login', None, {'username': usr, 'password': pw})
    assert st == 200, (usr, st, d)
    return sc.split(';')[0]
def baris(**k):
    return db.audit_cari(limit=500, **k)[0]
def bebaskan(dev):
    """Uji mengirim perintah beruntun ke ONU yang sama; masa istirahat ops_lock bukan
    pokok uji ini (dijaga tests/oplock.test.py)."""
    ops_lock.reset()

try:
    cka = login('admin.log', 'Admin#Log-2026x')
    ckt = login('teknisi.log', 'Teknisi#Log-2026')
    ckp = login('budi', 'Pelanggan123')
    enc = urllib.parse.quote(DEV, safe='')
    T = '/api/devices/' + enc + '/tasks?connection_request&timeout=3000'

    st, _, _ = minta('POST', T, ckt, {'name': 'setParameterValues', 'parameterValues': [
        [P + 'Username', 'budi@sky', 'xsd:string'], [P + 'Password', 'PPPOE-RAHASIA', 'xsd:string']]})
    r = [x for x in baris() if x['action'] == 'onu.wan']
    ok(st == 200 and len(r) == 1 and r[0]['username'] == 'teknisi.log' and r[0]['role'] == 'user'
       and r[0]['detail'] == 'mengubah WAN (Username, Password) pada ONU ZTEGUJI0001 — berhasil' and r[0]['kategori'] == 'onu',
       'perubahan WAN oleh role user tercatat: kalimat + SN + hasil + role — %r' % (r[:1],))
    bebaskan(DEV)
    st, _, _ = minta('POST', T, cka, {'name': 'setParameterValues', 'parameterValues': [[W + '1.SSID', 'ANTRE', 'xsd:string']]})
    r = [x for x in baris() if x['action'] == 'onu.wifi']
    ok(st == 202 and len(r) == 1 and r[0]['role'] == 'administrator' and r[0]['detail'].endswith('— diantrekan (ONU belum menjawab)'),
       'jawaban 202 tercatat "diantrekan", bukan "berhasil" — %r' % (r[:1],))
    bebaskan(DEV)
    st, _, _ = minta('POST', T, cka, {'name': 'setParameterValues', 'parameterValues': [[W + '1.SSID', 'RUSAK', 'xsd:string']]})
    ok(any(x['detail'].endswith('— gagal (HTTP 500)') for x in baris() if x['action'] == 'onu.wifi'), 'galat NBI tercatat "gagal (HTTP 500)"')
    bebaskan(DEV)
    st, _, _ = minta('POST', T, cka, {'name': 'reboot'})
    r = [x for x in baris() if x['action'] == 'onu_reboot']
    ok(st == 200 and len(r) == 1 and r[0]['detail'] == 'me-reboot ONU ZTEGUJI0001 — berhasil', 'reboot: satu baris berisi SN & hasil — %r' % (r[:1],))

    # baca & refresh
    bebaskan(DEV)
    n0 = len(baris())
    minta('POST', T, cka, {'name': 'getParameterValues', 'parameterNames': [W + '1.SSID']})
    ok(len(baris()) == n0, 'getParameterValues tidak menambah baris Log')
    for obj in ('LANDevice.1.Hosts', 'LANDevice.1.WLANConfiguration', 'LANDevice.1'):
        bebaskan(DEV)
        minta('POST', T, cka, {'name': 'refreshObject', 'objectName': I + obj})
    ok(sum(1 for x in baris() if x['action'] == 'onu.refresh') == 1, 'tiga refreshObject beruntun (satu klik Refresh) → SATU baris')
    bebaskan(DEV)
    minta('POST', T, ckt, {'name': 'refreshObject', 'objectName': I + 'LANDevice.1'})
    ok(sum(1 for x in baris() if x['action'] == 'onu.refresh') == 2, 'refresh oleh akun LAIN tetap tercatat')

    # perintah yang ditolak pagar tidak ditulis sebagai operasi ONU
    bebaskan(DEV)
    st, _, _ = minta('POST', T, cka, {'name': 'factoryReset'})
    ok(st != 200 and not any('factory' in x['detail'].lower() for x in baris() if x['action'].startswith('onu.'))
       and any(x['action'] == 'acs_ditolak' and x['kategori'] == 'keamanan' for x in baris()),
       'perintah yang ditolak pagar tercatat sebagai penolakan, bukan operasi ONU')
    # Penolakan dulu mencatat potongan mentah isi permintaan — termasuk password yang hendak
    # ditulis. Kini hanya nama task & nama parameter.
    import acs_guard
    acs_guard.set_mode_aman(True, actor=ADM, alasan='uji log')
    n_tulis = len(Nbi.tulis)
    st, _, _ = minta('POST', T, ckt, {'name': 'setParameterValues', 'parameterValues': [
        [W + '1.KeyPassphrase', 'SANDI-RAHASIA-DITOLAK', 'xsd:string'], [P + 'Password', 'PPPOE-RAHASIA-DITOLAK', 'xsd:string']]})
    acs_guard.set_mode_aman(False, actor=ADM, alasan='uji log selesai')
    tolak = [x for x in baris() if x['action'] == 'acs_ditolak'][0]
    mentah = json.dumps([dict(r) for r in db.conn().execute('SELECT detail FROM audit_log')])
    ok(st != 200 and len(Nbi.tulis) == n_tulis and 'RAHASIA' not in mentah
       and 'task=setParameterValues' in tolak['detail'] and 'KeyPassphrase' in tolak['detail'] and tolak['username'] == 'teknisi.log',
       'penolakan pagar mencatat nama task & parameter, TANPA nilainya — %r' % tolak['detail'][-110:])
    # Catatan lama (format "isi={…}") tetap ada di basis data, tetapi tidak keluar ke Log.
    db.audit('acs_ditolak', 'mode_aman · POST /api/devices/x/tasks · Mode aman · isi={"name":"setParameterValues","parameterValues":[["a.KeyPassphrase","BOCOR-LAMA"]]}', ADM, '')
    ok(not any('BOCOR-LAMA' in x['detail'] for x in baris()) and not any('BOCOR-LAMA' in x['detail'] for x in db.audit_list(limit=50))
       and any(x['detail'].endswith('isi: (disembunyikan — catatan lama)') for x in baris()),
       'isi mentah pada catatan penolakan LAMA disembunyikan saat dibaca (Log, ekspor, API)')

    # pelanggan (lewat /pel → jalur yang sama)
    pelanggan.atur_onu_akun(PEL['id'], [{'id': DEV, 'sn': 'ZTEGUJI0001'}], ADM, '')
    bebaskan(DEV)
    st, _, _ = minta('POST', '/pel/onu/' + enc + '/reboot', ckp, {})
    r = baris(role='pelanggan')
    ok(st == 200 and [x['action'] for x in r] == ['onu_reboot', 'login.success'] and r[0]['username'] == 'budi',
       'saringan role=pelanggan: login & reboot pelanggan saja — %r' % [x['action'] for x in r])

    # tidak ada nilai rahasia di seluruh catatan
    seluruh = json.dumps(baris())
    ok('RAHASIA' not in seluruh and 'budi@sky' not in seluruh and 'BOCOR-LAMA' not in seluruh, 'password/username PPPoE tidak pernah tercatat')

    # login gagal & logout
    minta('POST', '/auth/login', None, {'username': 'budi', 'password': 'salah-sekali'})
    minta('POST', '/auth/login', None, {'username': 'penyusup<script>', 'password': 'x'})
    gagal = [x for x in baris() if x['action'] == 'login.failed']
    ok(len(gagal) == 2 and {(x['username'], x['role']) for x in gagal} == {('budi', 'pelanggan'), ('', '')},
       'login gagal pada akun yang ada tercatat atas akun itu; username karangan tidak — %r' % [(x['username'], x['role']) for x in gagal])
    ok([a['username'] for a in db.audit_akun()] == ['admin.log', 'budi', 'teknisi.log'],
       'daftar saringan "nama akun" hanya berisi akun sungguhan — %r' % db.audit_akun())
    st, _, _ = minta('POST', '/auth/logout', ckt)
    ok(st == 200 and any(x['action'] == 'logout' and x['username'] == 'teknisi.log' for x in baris()), 'logout tercatat')
    ckt = login('teknisi.log', 'Teknisi#Log-2026')

    # ── GET /auth/audit ──
    st, _, _ = minta('GET', '/auth/audit', ckt)
    st2, _, _ = minta('GET', '/auth/audit', ckp)
    st3, _, _ = minta('GET', '/auth/audit')
    ok((st, st2, st3) == (403, 403, 401), 'Log khusus administrator: user 403, pelanggan 403, tanpa sesi 401 — %r' % ((st, st2, st3),))
    st, d, _ = minta('GET', '/auth/audit', cka)
    ok(st == 200 and len(d['entries']) > 8 and d['adaLagi'] is False and {a['username'] for a in d['akun']} == {'admin.log', 'budi', 'teknisi.log'}
       and all(k in d['entries'][0] for k in ('id', 'username', 'role', 'action', 'detail', 'ip_address', 'created_at', 'kategori')),
       'default ALL: semua catatan + daftar akun')
    ok([e['id'] for e in d['entries']] == sorted((e['id'] for e in d['entries']), reverse=True), 'terbaru lebih dulu')
    for role in ('administrator', 'user', 'pelanggan'):
        st, dr, _ = minta('GET', '/auth/audit?role=' + role, cka)
        ok(st == 200 and dr['entries'] and all(e['role'] == role for e in dr['entries']), 'saringan role=%s' % role)
    st, dr, _ = minta('GET', '/auth/audit?role=sistem', cka)
    ok(st == 200 and dr['entries'] and all(e['role'] == '' for e in dr['entries']), 'role=sistem → catatan tanpa akun')
    st, dr, _ = minta('GET', '/auth/audit?role=%27%20OR%201=1--', cka)
    ok(st == 200 and len(dr['entries']) == len(d['entries']), 'role tak dikenal diabaikan (bukan disisipkan ke SQL)')
    st, dr, _ = minta('GET', '/auth/audit?akun=budi', cka)
    ok(st == 200 and dr['entries'] and all(e['username'] == 'budi' for e in dr['entries']), 'saringan nama akun')
    st, dr, _ = minta('GET', '/auth/audit?kategori=onu', cka)
    ok(st == 200 and dr['entries'] and all(e['action'].startswith(('onu', 'acs_ditolak')) for e in dr['entries']), 'saringan jenis: operasi ONU')
    st, dr, _ = minta('GET', '/auth/audit?kategori=masuk&role=pelanggan', cka)
    ok(st == 200 and sorted(e['action'] for e in dr['entries']) == ['login.failed', 'login.success'], 'saringan digabung: masuk + pelanggan')
    st, dr, _ = minta('GET', '/auth/audit?kategori=pengaturan', cka)
    ok(st == 200 and dr['entries'] and all(e['kategori'] == 'pengaturan' for e in dr['entries'])
       and any(e['action'] == 'acs_connection.update' for e in dr['entries']), 'jenis "pengaturan" = yang bukan jenis lain')
    st, dr, _ = minta('GET', '/auth/audit?q=ZTEGUJI0001', cka)
    ok(st == 200 and dr['entries'] and all('ZTEGUJI0001' in e['detail'] for e in dr['entries']), 'cari SN')
    st, dr, _ = minta('GET', '/auth/audit?q=%25', cka)
    ok(st == 200 and dr['entries'] == [], 'tanda % yang diketik dicari apa adanya (bukan wildcard)')
    # halaman berikutnya memakai kursor id
    st, h1, _ = minta('GET', '/auth/audit?limit=3', cka)
    st, h2, _ = minta('GET', '/auth/audit?limit=3&sebelum=%d' % h1['entries'][-1]['id'], cka)
    ok(h1['adaLagi'] is True and 'akun' in h1 and 'akun' not in h2
       and [e['id'] for e in h1['entries'] + h2['entries']] == [e['id'] for e in d['entries'][:6]]
       or len(d['entries']) < 6, '"Muat lebih banyak": kursor id, tanpa baris ganda atau terlewat')
    st, dl, _ = minta('GET', '/auth/audit?action=logout', cka)
    ok(st == 200 and dl['entries'] and all(e['action'] == 'logout' for e in dl['entries']), 'bentuk lama ?action= tetap berlaku')
finally:
    srv.shutdown(); srv.server_close(); nbi.shutdown()

# ══ 4. Halaman ══
def baca(*p): return open(os.path.join(ROOT, 'frontend', *p), encoding='utf-8').read()
idx, main, logjs, loghtml, st_html, st_js = (baca('index.html'), baca('js', 'main.js'), baca('js', 'log.js'),
                                             baca('pages', 'log.html'), baca('pages', 'settings.html'), baca('js', 'settings.js'))
import re
nav = re.search(r'<a[^>]*data-page="log"[^>]*>', idx)
ok(bool(nav) and 'data-izin="menuLog"' in nav.group(0) and '/js/log.js' in idx and '/css/log.css' in idx,
   'menu Log di sidebar, tampil untuk administrator dan role berizin menuLog (2026-10-04)')
ok("log: '/log'" in main and "if (p === '/log') return 'log';" in main and "PAGE_INIT['log']" in logjs, 'rute /log terdaftar dua arah')
tombol = re.findall(r'data-role="([a-z]*)"', loghtml)
ok(tombol == ['', 'administrator', 'user', 'pelanggan', 'mitra'] and re.search(r'class="seg-btn on" data-role=""', loghtml),
   'saringan role: ALL (default), administrator, user, pelanggan, mitra')
ok(set(re.findall(r'<option value="([a-z]+)"', loghtml)) == set(db.LOG_KATEGORI) | {'pengaturan'},
   'pilihan jenis kejadian di halaman = kelompok di server')
ok('innerHTML' in logjs and logjs.count('escHtml(') >= 12 and not re.search(r"\+ *b\.(detail|username|action|ip_address) *\+", logjs),
   'teks catatan (bisa berisi ketikan orang luar) selalu lewat escHtml')
ok('/auth/audit?' in logjs and 'sebelum' in logjs, 'halaman membaca /auth/audit dengan kursor')
ok(re.findall(r'data-role="([a-z]*)"', st_html.split('id="usrRoleFilter"')[1].split('</div>')[0]) == ['', 'administrator', 'user', 'pelanggan', 'mitra']
   and '_usrRole' in st_js, 'Manajemen Akun: tombol saringan role ALL / administrator / user / pelanggan')

print(f'log: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
