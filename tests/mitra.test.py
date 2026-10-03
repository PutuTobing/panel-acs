#!/usr/bin/env python3
"""Uji role MITRA dan izin panel per role (2026-10-04).

YANG DIJAGA (semuanya di SERVER — menu yang disembunyikan browser bukan pagar):
  1. Akun mitra terikat pada tag MITRA-<USERNAME>; tag yang sudah ada dipakai beserta ONU-nya.
  2. Bawaan mitra: hanya ONU bertag miliknya, hanya melihat & Refresh. ONU lain tidak
     terbaca (daftar, detail, task, fault) dan tidak bisa diperintah.
  3. Aksi (reboot, hapus, WAN, WiFi, Setting, Remote) hanya bila dicentang administrator;
     satu permintaan berisi beberapa jenis perubahan butuh SEMUA izinnya.
  4. Menu Dashboard/Device/Maps/Log per role; Log tanpa `logSemua` = hanya akunnya sendiri.
  5. Mitra terbatas tidak bisa mengklaim ONU lain lewat tag.
  6. Role user TIDAK berubah oleh pembaruan ini (izin lama tanpa izin panel tetap penuh).
  7. Aktivitas mitra tercatat di Log dengan role-nya.

DB sementara; GenieACS = NBI TIRUAN di port lokal — tidak menyentuh produksi.
"""
import os, sys, json, tempfile, threading, http.client, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db, auth
TMP = tempfile.mkdtemp(prefix='skymitra-')
auth.DATA_DIR = TMP
db.set_path(os.path.join(TMP, 'sky.db'))
db.init()
import config_store, tag as tag_mod, mitra, logonu, ops_lock

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

A, B, C = 'AA11BB-F670L-ZTEGMITRA0001', 'AA11BB-F670L-ZTEGMITRA0002', 'AA11BB-F663NV9-ZTEGORANGLAIN'
I = 'InternetGatewayDevice.'
W, P = I + 'LANDevice.1.WLANConfiguration.1.', I + 'WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.'

# ══ 1. Nama tag & jenis perintah (murni) ══
ok(mitra.nama_tag('surya') == 'MITRA-SURYA' and mitra.nama_tag('Mitra-Bayu') == 'MITRA-BAYU' and mitra.nama_tag('mitra surya') == 'MITRA-SURYA',
   'username → tag MITRA-<USERNAME> (awalan tidak digandakan)')
j = lambda o, m='POST', p='/devices/x/tasks': logonu.jenis(m, p, json.dumps(o).encode() if o is not None else None)
ok(j({'name': 'refreshObject', 'objectName': I}) == {'baca'} and j({'name': 'getParameterValues'}) == {'baca'} and j(None, 'GET', '/devices') == {'baca'},
   'refresh & baca = jenis "baca"')
ok(j({'name': 'reboot'}) == {'reboot'} and j(None, 'DELETE', '/devices/x') == {'hapus'} and j(None, 'DELETE', '/faults/x:task_1') == {'bersih'},
   'reboot / hapus ONU / hapus fault dikenali')
ok(j({'name': 'setParameterValues', 'parameterValues': [[W + 'SSID', 'a'], [I + 'User.1.Password', 'b'], [P + 'Username', 'c']]}) == {'wifi', 'akunweb', 'wan'},
   'satu setParameterValues berisi tiga jenis → ketiganya terlihat pagar')
ok(j({'name': 'addObject', 'objectName': I + 'WANDevice.1.WANConnectionDevice.1.WANPPPConnection'}) == {'wan'}
   and j({'name': 'factoryReset'}) == {'lain'} and logonu.jenis('POST', '/devices/x/tasks', b'rusak') == {'lain'}
   and j({'name': 'reboot'}, 'POST', '/presets') == {'lain'}, 'tambah WAN = wan; yang tak dikenali = "lain" (butuh semua izin)')

# ══ 2. NBI tiruan ══
class Nbi(BaseHTTPRequestHandler):
    tulis = []
    def log_message(self, *a): pass
    def _json(self, st, o):
        b = json.dumps(o).encode(); self.send_response(st); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = json.loads(urllib.parse.parse_qs(u.query).get('query', ['{}'])[0])
        kol = u.path.strip('/')
        if kol == 'devices':
            arr = [{'_id': x, 'VirtualParameters': {'RXPower': {'_value': '-20'}}} for x in (A, B, C)]
            return self._json(200, [d for d in arr if '_id' not in q or d['_id'] == q['_id']])
        if kol == 'tasks':  return self._json(200, [{'_id': 't' + x[-4:], 'device': x, 'name': 'refreshObject'} for x in (A, C)])
        if kol == 'faults': return self._json(200, [{'_id': x + ':task_1', 'device': x, 'code': 'cwmp.9002'} for x in (B, C)])
        return self._json(200, [{'_id': 'rahasia-preset'}])
    def do_DELETE(self): Nbi.tulis.append(('DELETE', self.path, None)); self._json(200, {})
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        Nbi.tulis.append(('POST', self.path, json.loads(self.rfile.read(n) or b'{}')))
        self._json(200, {'_id': 'tugas-%d' % len(Nbi.tulis)})
nbi = ThreadingHTTPServer(('127.0.0.1', 0), Nbi)
threading.Thread(target=nbi.serve_forever, daemon=True).start()
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': nbi.server_address[1], 'base_path': ''})

import server
ADM = auth.create_user('admin.mitra', 'Admin#Mitra-2026', 'Admin', role='administrator')
USR = auth.create_user('teknisi.mitra', 'Teknisi#Mitra-2026', 'Teknisi', role='user')
# Tag MITRA-SURYA SUDAH ada dan sudah menempel di ONU A & B (keadaan panel sebelum role mitra).
tag_mod.buat('MITRA-SURYA', None, ADM, '')
tag_mod.pasang('MITRA-SURYA', [A, B], False, ADM, '')
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
    except Exception: d = raw
    return r.status, d, sc
def login(u, pw):
    st, d, sc = minta('POST', '/auth/login', None, {'username': u, 'password': pw})
    assert st == 200, (u, st, d)
    return sc.split(';')[0], d['user']
def tugas(dev): return '/api/devices/' + urllib.parse.quote(dev, safe='') + '/tasks?connection_request&timeout=3000'
def izin_mitra(*tambah):
    st, d, _ = minta('POST', '/config/izin-role', cka, {'role': 'mitra', 'izin': ['akunSaya', 'tentang', 'menuDashboard', 'menuDevice'] + list(tambah)})
    assert st == 200, d
def terkirim(): return len(Nbi.tulis)
REFRESH = {'name': 'refreshObject', 'objectName': I + 'LANDevice.1'}
WIFI = {'name': 'setParameterValues', 'parameterValues': [[W + 'SSID', 'BARU', 'xsd:string']]}

try:
    cka, _ = login('admin.mitra', 'Admin#Mitra-2026')
    ckt, _ = login('teknisi.mitra', 'Teknisi#Mitra-2026')

    # ── akun mitra ↔ tag ──
    st, d, _ = minta('POST', '/auth/users', ckt, {'username': 'surya', 'password': 'Mitra#Surya-2026', 'name': 'Surya', 'role': 'mitra'})
    ok(st == 403, 'role user tidak bisa membuat akun mitra')
    st, d, _ = minta('POST', '/auth/users', cka, {'username': 'surya', 'password': 'Mitra#Surya-2026', 'name': 'Surya', 'role': 'mitra'})
    SURYA = d.get('user', {})
    ok(st == 200 and SURYA.get('role') == 'mitra' and SURYA.get('tagMitra') == 'MITRA-SURYA', 'akun mitra "surya" terikat pada tag MITRA-SURYA yang sudah ada')
    ok(mitra.perangkat(SURYA) == {A, B}, 'ONU bertag MITRA-SURYA langsung menjadi ONU mitra itu')
    st, d, _ = minta('POST', '/auth/users', cka, {'username': 'mitra-bayu', 'password': 'Mitra#Bayu-2026x', 'name': 'Bayu', 'role': 'mitra'})
    BAYU = d.get('user', {})
    ok(st == 200 and BAYU.get('tagMitra') == 'MITRA-BAYU' and any(t['nama'] == 'MITRA-BAYU' for t in tag_mod.daftar()) and mitra.perangkat(BAYU) == set(),
       'tag yang belum ada dibuat otomatis (MITRA-BAYU), awalnya tanpa ONU')
    st, d, _ = minta('GET', '/auth/users', cka)
    ok({u['username']: u.get('tagMitra') for u in d['users']} == {'admin.mitra': '', 'teknisi.mitra': '', 'surya': 'MITRA-SURYA', 'mitra-bayu': 'MITRA-BAYU'},
       'daftar akun menyertakan tag tiap akun mitra')
    cks, us = login('surya', 'Mitra#Surya-2026')
    ckb, _ = login('mitra-bayu', 'Mitra#Bayu-2026x')
    ok(us['role'] == 'mitra' and set(us['izin']) == {'akunSaya', 'tentang', 'menuDashboard', 'menuDevice'}, 'izin bawaan mitra: Akun Saya, Tentang, Dashboard, Device')

    # ── lingkup: hanya ONU mitra ──
    st, d, _ = minta('GET', '/api/devices/?projection=_id', cks)
    ok(st == 200 and [x['_id'] for x in d] == [A, B], 'daftar ONU mitra: hanya A & B — %r' % (d,))
    st, d, _ = minta('GET', '/api/devices/?query=' + urllib.parse.quote(json.dumps({'_id': C})), cks)
    ok(st == 200 and d == [], 'detail ONU orang lain tidak terbaca walau diminta langsung')
    st, d, _ = minta('GET', '/api/devices/?projection=_id', ckb)
    ok(st == 200 and d == [], 'mitra tanpa ONU bertag melihat daftar kosong (bukan semua)')
    st, d, _ = minta('GET', '/api/tasks/', cks); st2, d2, _ = minta('GET', '/api/faults/', cks)
    ok([x['device'] for x in d] == [A] and [x['device'] for x in d2] == [B], 'task & fault ONU lain disaring')
    st, d, _ = minta('GET', '/api/presets/', cks)
    ok(st == 403 and 'rahasia-preset' not in json.dumps(d), 'koleksi NBI selain devices/tasks/faults tertutup bagi mitra terbatas')

    # ── aksi bawaan: hanya baca/refresh, hanya ONU sendiri ──
    n = terkirim()
    st, _, _ = minta('POST', tugas(A), cks, REFRESH)
    ok(st == 200 and terkirim() == n + 1, 'mitra boleh Refresh ONU miliknya')
    ops_lock.reset(); n = terkirim()
    st, d, _ = minta('POST', tugas(C), cks, REFRESH)
    ok(st == 403 and terkirim() == n and d.get('kode') == 'izin_role', 'Refresh ONU orang lain ditolak, tak ada yang terkirim')
    for nama, metode, alamat, isi in (
            ('reboot', 'POST', tugas(A), {'name': 'reboot'}), ('ubah WiFi', 'POST', tugas(A), WIFI),
            ('ubah WAN', 'POST', tugas(A), {'name': 'setParameterValues', 'parameterValues': [[P + 'Username', 'x', 'xsd:string']]}),
            ('tambah WAN', 'POST', tugas(A), {'name': 'addObject', 'objectName': I + 'WANDevice.1.WANConnectionDevice.1.WANPPPConnection'}),
            ('akun web ONU', 'POST', tugas(A), {'name': 'setParameterValues', 'parameterValues': [[I + 'User.1.Password', 'x', 'xsd:string']]}),
            ('hapus ONU', 'DELETE', '/api/devices/' + urllib.parse.quote(A, safe=''), None),
            ('hapus fault', 'DELETE', '/api/faults/' + urllib.parse.quote(B + ':task_1', safe=''), None)):
        ops_lock.reset(); n = terkirim()
        st, d, _ = minta(metode, alamat, cks, isi)
        ok(st == 403 and terkirim() == n, 'bawaan mitra: %s DITOLAK server (dapat %d)' % (nama, st))
    st, _, _ = minta('GET', '/onu/' + urllib.parse.quote(A, safe='') + '/', cks)
    ok(st == 403, 'bawaan mitra: Remote web ONU ditolak')

    # ── administrator mencentang sebagian aksi ──
    izin_mitra('aksiReboot', 'aksiSsid')
    ops_lock.reset(); n = terkirim()
    st, _, _ = minta('POST', tugas(A), cks, {'name': 'reboot'})
    ok(st == 200 and terkirim() == n + 1, 'izin Reboot → reboot ONU sendiri diterima')
    ops_lock.reset()
    st, _, _ = minta('POST', tugas(A), cks, WIFI)
    ok(st == 200, 'izin Ubah SSID → ganti nama WiFi diterima')
    ops_lock.reset(); n = terkirim()
    st, _, _ = minta('POST', tugas(C), cks, {'name': 'reboot'})
    ok(st == 403 and terkirim() == n, 'izin Reboot TIDAK berlaku untuk ONU orang lain')
    ops_lock.reset(); n = terkirim()
    st, _, _ = minta('POST', tugas(A), cks, {'name': 'setParameterValues', 'parameterValues': [[W + 'SSID', 'x', 'xsd:string'], [I + 'User.1.Password', 'y', 'xsd:string']]})
    ok(st == 403 and terkirim() == n, 'WiFi + akun web dalam satu perintah: tanpa izin Setting → SELURUHNYA ditolak')
    st, _, _ = minta('POST', tugas(A), cks, {'name': 'setParameterValues', 'parameterValues': [[P + 'Password', 'y', 'xsd:string']]})
    ok(st == 403, 'WAN tetap ditolak (tidak dicentang)')

    # ── lingkup semua ONU ──
    izin_mitra('onuSemua')
    st, d, _ = minta('GET', '/api/devices/?projection=_id', cks)
    ok([x['_id'] for x in d] == [A, B, C], 'izin "Semua ONU" → mitra melihat seluruh ONU')
    ops_lock.reset()
    st, _, _ = minta('POST', tugas(C), cks, REFRESH)
    ok(st == 200, '… dan boleh Refresh ONU mana pun')
    izin_mitra()

    # ── menu ──
    st, _, _ = minta('GET', '/config/master', cks); st2, _, _ = minta('GET', '/config/odc', cks)
    ok(st == 403 and st2 == 403, 'tanpa menu Maps: Master Data & Data ODC ditolak')
    st, _, _ = minta('GET', '/auth/audit', cks)
    ok(st == 403, 'tanpa menu Log: Log ditolak')
    for alamat in ('/config/kesehatan', '/auth/users', '/config/izin-role', '/config/cadangan', '/config/pembaruan'):
        ok(minta('GET', alamat, cks)[0] == 403, 'mitra ditolak GET ' + alamat)
    ok(minta('GET', '/config/about', cks)[0] == 200 and minta('GET', '/auth/me', cks)[0] == 200, 'Tentang Sistem & akunnya sendiri terbuka')
    st, _, _ = minta('PATCH', '/auth/users/' + SURYA['id'], cks, {'role': 'administrator'})
    ok(st == 403 and auth.get_by_id(SURYA['id'])['role'] == 'mitra', 'mitra tidak bisa mengangkat dirinya jadi administrator')
    minta('POST', '/config/izin-role', cka, {'role': 'mitra', 'izin': ['akunSaya', 'tentang', 'menuMaps']})
    st, d, _ = minta('GET', '/api/devices/?projection=_id', cks)
    ok(st == 403 and minta('GET', '/config/master', cks)[0] == 200, 'tanpa menu Dashboard & Device: data ONU tertutup; menu Maps terbuka')

    # ── Log: sendiri vs semua ──
    izin_mitra('menuLog')
    st, d, _ = minta('GET', '/auth/audit?akun=admin.mitra&role=administrator', cks)
    ok(st == 200 and d['sendiri'] is True and d['entries'] and all(e['username'] == 'surya' for e in d['entries'])
       and [a['username'] for a in d['akun']] == ['surya'], 'menu Log tanpa "semua akun": hanya aktivitasnya sendiri, apa pun saringan yang dikirim')
    ok(minta('GET', '/auth/audit?action=login.success', cks)[1]['entries'] and all(e['username'] == 'surya' for e in minta('GET', '/auth/audit?action=login.success', cks)[1]['entries']),
       'bentuk lama ?action= tidak menjadi jalan memutar')
    izin_mitra('menuLog', 'logSemua')
    st, d, _ = minta('GET', '/auth/audit', cks)
    ok(st == 200 and d['sendiri'] is False and {'admin.mitra', 'surya'} <= {e['username'] for e in d['entries']}, 'izin "Log semua akun" → semua akun terlihat')
    st, d, _ = minta('GET', '/auth/audit?role=mitra', cka)
    aksi = [e['action'] + ' ' + e['detail'] for e in d['entries']]
    ok(st == 200 and all(e['role'] == 'mitra' for e in d['entries']) and any(a.startswith('onu_reboot me-reboot ONU ZTEGMITRA0001') for a in aksi)
       and any(a.startswith('access.denied role mitra tidak diizinkan') for a in aksi) and any(a.startswith('login.success') for a in aksi),
       'Log menyaring role mitra: login, perintah ONU, dan penolakan tercatat')
    izin_mitra()

    # ── tag: mitra terbatas tidak bisa mengklaim ONU lain ──
    st, d, _ = minta('GET', '/config/tag', cks)
    ok(st == 200 and set(d['perangkat']) == {A, B} and d['tagMitra'] == 'MITRA-SURYA', 'peta tag untuk mitra: hanya ONU miliknya')
    izin_mitra('buatTag')
    st, d, _ = minta('POST', '/config/tag/pasang', cks, {'nama': 'MITRA-SURYA', 'perangkat': [C]})
    ok(st == 403 and mitra.perangkat(SURYA) == {A, B}, 'dengan izin tag pun, mitra tidak bisa menempelkan tagnya ke ONU orang lain')
    st, d, _ = minta('POST', '/config/tag/pasang', cks, {'nama': 'MITRA-SURYA', 'perangkat': [A]})
    ok(st == 200, 'menandai ONU miliknya sendiri tetap boleh')
    izin_mitra()

    # ── /ops disaring ──
    ops_lock.reset(); ops_lock.mulai(C, 'teknisi.mitra', {'name': 'reboot'}); ops_lock.mulai(A, 'surya', {'name': 'refreshObject', 'objectName': I})
    st, d, _ = minta('GET', '/ops/', cks)
    ok(st == 200 and [o['perangkat'] for o in d['berjalan']] == [A], 'status operasi: mitra hanya melihat operasi ONU miliknya')
    ops_lock.reset()

    # ── role berubah → ikatan dilepas ──
    st, d, _ = minta('PATCH', '/auth/users/' + BAYU['id'], cka, {'role': 'user'})
    ok(st == 200 and mitra.tag_akun(BAYU['id']) == '' and any(t['nama'] == 'MITRA-BAYU' for t in tag_mod.daftar()), 'role diganti dari mitra → ikatan tag dilepas (tagnya tetap ada)')

    # ── role user tidak berubah ──
    ops_lock.reset()
    st, d, _ = minta('GET', '/api/devices/?projection=_id', ckt)
    ok([x['_id'] for x in d] == [A, B, C] and minta('POST', tugas(C), ckt, {'name': 'reboot'})[0] == 200 and minta('GET', '/api/presets/', ckt)[0] == 200,
       'role user (bawaan): semua ONU, reboot, dan koleksi lain tetap seperti sebelumnya')
    ok(minta('GET', '/auth/audit', ckt)[0] == 403 and minta('GET', '/config/master', ckt)[0] == 200, 'role user: Log tetap tertutup, Maps tetap terbuka')
    # Izin yang tersimpan SEBELUM pembaruan ini (tanpa '_v', hanya menu Settings):
    db.kv_set('app_parameters', config_store.IZIN_ROLE_KEY, json.dumps({'user': ['akunSaya', 'tentang', 'kesehatan']}))
    ops_lock.reset()
    ok(set(config_store.IZIN_BAWAAN['user']) <= set(config_store.izin_user(USR)) and 'kesehatan' in config_store.izin_user(USR)
       and minta('POST', tugas(C), ckt, {'name': 'reboot'})[0] == 200,
       'izin lama tanpa izin panel: teknisi TIDAK kehilangan Dashboard/Device/aksi sesudah pembaruan')
    minta('POST', '/config/izin-role', cka, {'role': 'user', 'izin': ['akunSaya', 'tentang', 'menuDevice', 'onuSemua']})
    ops_lock.reset(); n = terkirim()
    ok(minta('POST', tugas(C), ckt, {'name': 'reboot'})[0] == 403 and terkirim() == n and minta('POST', tugas(C), ckt, REFRESH)[0] == 200,
       'administrator mencabut Reboot dari role user → reboot ditolak, Refresh tetap boleh')
    ok(minta('POST', '/config/izin-role', cks, {'role': 'mitra', 'izin': list(config_store.IZIN_KUNCI)})[0] == 403, 'mitra tidak bisa memberi dirinya izin')
finally:
    srv.shutdown(); srv.server_close(); nbi.shutdown()

# ══ 3. Halaman ══
import re
def baca(*p): return open(os.path.join(ROOT, 'frontend', *p), encoding='utf-8').read()
idx, st_html, sjs, mainjs, css = baca('index.html'), baca('pages', 'settings.html'), baca('js', 'settings.js'), baca('js', 'main.js'), baca('css', 'base.css')
for halaman, kunci in (('dashboard', 'menuDashboard'), ('devices', 'menuDevice'), ('log', 'menuLog')):
    ok(re.search(r'data-page="%s"[^>]*data-izin="%s"' % (halaman, kunci), idx), 'sidebar %s mengikuti izin %s' % (halaman, kunci))
ok(re.search(r'data-group="maps" data-izin="menuMaps"', idx), 'kelompok Maps mengikuti izin menuMaps')
ok('<option value="mitra">' in st_html and re.search(r'id="izinRolePilih"[\s\S]{0,300}data-role="user"[\s\S]{0,120}data-role="mitra"', st_html),
   'form akun punya role Mitra; kartu Hak Akses bisa memilih role User / Mitra')
info = re.search(r'const _IZIN_INFO = \{([\s\S]*?)\n\};', sjs)
ok(info and all(re.search(r'^\s*%s:\s*\[' % k, info.group(1), re.M) for k in config_store.IZIN_PANEL), 'tiap izin panel punya label di kartu Hak Akses')
ok(all(('html.tanpa-' + k) in css for k in ('aksiReboot', 'aksiHapus', 'aksiWan', 'aksiSsid', 'aksiSetting', 'aksiRemote'))
   and "IZIN_AKSI_ONU.forEach(k => document.documentElement.classList.toggle('tanpa-' + k, !punyaIzin(k)))" in mainjs,
   'tombol aksi yang tidak diizinkan disembunyikan (kerapian; pagarnya di server)')
ok('if (!halamanBoleh(page)) { page = halamanPertama(); skipHistory = false; }' in mainjs, 'halaman yang tidak diizinkan dialihkan ke menu pertama yang boleh')

print(f'mitra: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
