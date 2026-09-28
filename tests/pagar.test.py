#!/usr/bin/env python3
"""Uji pagar keselamatan jalur NBI (acs_guard.py).

Pagar ini lahir dari 2026-08-02, hari ketika aplikasi ini membebani ONU-nya
sendiri sampai 12 unit ZL-2113X membeku dan tidak pulih. Yang diuji di sini
bukan "fiturnya jalan", melainkan apakah pagarnya MENAHAN saat ditembus —
karena penjaga di browser (dialog konfirmasi, _adaTaskKembar) semuanya bisa
dilewati dengan satu perintah curl.

Karena itu setiap kasus di bawah memanggil acs_guard langsung dengan body
mentah, persis seperti penyerang atau kode baru yang lupa aturannya.

Yang dijaga, masing-masing dari kejadian nyata:
  • `factoryReset` tidak pernah dipakai panel — tapi selama ia bisa lewat, ia
    satu salah-ketik dari bencana yang tak bisa dibatalkan.
  • `refreshObject` tanpa objectName = seluruh pohon. HWTC ZL-2113X membalas
    ~450 ms per RPC; SN HWTCA90D86D8 senyap total di tengah penyusuran.
  • Membaca `ManagementServer` mencemari cache password write-only dengan ""
    → provision `inform` melihat nilai berbeda → satu penulisan flash tiap
    Refresh. Itulah write-loop yang menghabiskan siklus tulis ONU.
  • 32 task dengan `parameterNames` bertanda koma harus dihapus manual; tiap
    task seperti itu gagal di SETIAP sesi ONU selamanya.
  • Provision berjalan pada setiap sesi setiap ONU — 1.796 kali lipat. Panel
    tidak boleh menulisnya, sekarang maupun nanti.

Dan yang sama pentingnya — apa yang TIDAK boleh ikut terlarang:
  • `reboot` adalah perkakas sah teknisi (ada tombolnya, ada dialognya).
  • Membaca (GET) tidak pernah dibatasi.
  • Membatalkan task justru MENGURANGI beban ONU, jadi tetap boleh walau mode
    aman menyala.
"""
import os, sys, json, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import db

db.set_path(os.path.join(tempfile.mkdtemp(prefix='skypagar-'), 'sky.db'))
import acs_guard

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)


def task(**kw):
    """Bungkus jadi POST /api/devices/X/tasks dengan body JSON."""
    return acs_guard.periksa('POST', '/api/devices/AAA-BBB-CCC/tasks',
                             json.dumps(kw).encode())


def lolos(hasil, m):
    ok(hasil is None, m + ' (ditolak: %s)' % (hasil or {}).get('kode'))


def ditolak(hasil, kode, m):
    ok(hasil is not None and hasil['kode'] == kode,
       m + ' (dapat: %s)' % ((hasil or {}).get('kode') or 'LOLOS'))


# ══ 1. Baca tidak pernah dibatasi ══
# Seluruh dokumen ini bersandar pada satu janji: membaca dari cache GenieACS
# gratis bagi ONU. Kalau pagar ikut menghambat GET, janji itu batal.
for jalur in ('/api/devices', '/api/devices/X/tasks', '/api/provisions',
              '/api/faults', '/api/virtualParameters'):
    lolos(acs_guard.periksa('GET', jalur, None), 'GET %s bebas' % jalur)
lolos(acs_guard.periksa('GET', '/api/devices', None, mode_aman=True),
      'GET tetap bebas walau mode aman menyala')

# ══ 2. Task yang ditolak mentah ══
ditolak(task(name='factoryReset'), 'task_terlarang', 'factoryReset ditolak')
ditolak(task(name='FactoryReset'), 'task_terlarang', 'penolakan tidak peka huruf besar/kecil')
ditolak(task(name='  factoryreset  '), 'task_terlarang', 'spasi di sekeliling nama tidak menolong')
ditolak(task(name='download', fileType='1 Firmware Upgrade Image'),
        'task_terlarang', 'download firmware ditolak')
ditolak(task(name='upload'), 'task_terlarang', 'upload ditolak')

# Daftar-izin, bukan daftar-tolak: nama yang tak dikenal ikut ditolak, karena
# daftar-tolak selalu ketinggalan dari apa yang belum terpikirkan.
ditolak(task(name='setParameterAttributes'), 'task_asing', 'nama di luar daftar-izin ditolak')
ditolak(task(name='scriptInject'), 'task_asing', 'nama karangan ditolak')
ditolak(task(), 'tanpa_nama', 'perintah tanpa name ditolak')
ditolak(acs_guard.periksa('POST', '/api/devices/X/tasks', b'{bukan json'),
        'json_cacat', 'body bukan JSON ditolak')
ditolak(acs_guard.periksa('POST', '/api/devices/X/tasks', None),
        'body_kosong', 'body kosong ditolak')

# ══ 3. reboot SENGAJA tetap boleh ══
# Panel punya tombol reboot satuan dan massal, lengkap dengan dialog peringatan.
# Yang salah bukan kemampuannya, melainkan kalau ia terjadi tanpa jejak.
lolos(task(name='reboot'), 'reboot tetap diizinkan (perkakas sah teknisi)')

# ══ 4. refreshObject ══
ditolak(task(name='refreshObject', objectName=''), 'pohon_penuh',
        'refreshObject objectName kosong = seluruh pohon → ditolak')
ditolak(task(name='refreshObject', objectName='   '), 'pohon_penuh',
        'objectName berisi spasi saja juga ditolak')
ditolak(task(name='refreshObject'), 'pohon_penuh',
        'refreshObject tanpa objectName ditolak')
ditolak(task(name='refreshObject',
             objectName='InternetGatewayDevice.ManagementServer'),
        'baca_terlarang', 'menyegarkan ManagementServer ditolak (cache password tercemar)')
ditolak(task(name='refreshObject',
             objectName='Device.ManagementServer.ConnectionRequestPassword'),
        'baca_terlarang', 'jalur Device.* ManagementServer juga ditolak')
lolos(task(name='refreshObject', objectName='InternetGatewayDevice.WANDevice'),
      'refreshObject sub-pohon WANDevice diizinkan')
lolos(task(name='refreshObject', objectName='InternetGatewayDevice.DeviceInfo'),
      'refreshObject DeviceInfo diizinkan')
ditolak(task(name='refreshObject', objectName='*'), 'nama_cacat',
        'objectName "*" ditolak')
ditolak(task(name='refreshObject', objectName='Wlan'), 'nama_cacat',
        'objectName karangan ditolak')

# Batas yang jujur: akar model data TETAP diizinkan, walau isinya sama saja
# dengan seluruh pohon. ACS.summon() mengirimnya untuk setiap model non-rapuh —
# menolaknya di sini berarti mematikan Refresh untuk ~1.600 ONU tanpa
# penggantinya. Mempersempitnya pekerjaan §5.2 PRD, bukan pekerjaan pagar.
lolos(task(name='refreshObject', objectName='InternetGatewayDevice'),
      'akar InternetGatewayDevice diizinkan (dipakai ACS.summon hari ini)')
lolos(task(name='refreshObject', objectName='Device'),
      'akar Device (TR-181) diizinkan')

# ══ 5. Bentuk perintah cacat — 32 task yang harus dihapus manual ══
ditolak(task(name='getParameterValues',
             parameterNames=['InternetGatewayDevice.DeviceInfo.UpTime,'
                             'InternetGatewayDevice.DeviceInfo.SoftwareVersion']),
        'nama_cacat', 'parameterNames bertanda koma ditolak (bentuk 32 task cacat)')
ditolak(task(name='setParameterValues',
             parameterValues=[['InternetGatewayDevice.A,InternetGatewayDevice.B', 1, 'xsd:int']]),
        'nama_cacat', 'koma pada parameterValues juga ditolak')
ditolak(task(name='getParameterValues', parameterNames='bukan larik'),
        'bentuk_salah', 'parameterNames bukan larik ditolak')
ditolak(task(name='getParameterValues'), 'baca_tanpa_nama',
        'getParameterValues tanpa parameterNames ditolak (= minta seluruh pohon)')
ditolak(task(name='getParameterValues', parameterNames=['Wlan.Ssid']),
        'nama_cacat', 'nama tanpa awalan sah ditolak')
ditolak(task(name='getParameterValues',
             parameterNames=['InternetGatewayDevice.X'] * (acs_guard.MAKS_PARAM_BACA + 1)),
        'terlalu_banyak', 'pembacaan melebihi batas ditolak')
lolos(task(name='getParameterValues',
           parameterNames=['InternetGatewayDevice.DeviceInfo.UpTime',
                           'Device.DeviceInfo.UpTime']),
      'pembacaan wajar diizinkan')

# Batas baca sempat dipasang 64 dan itu KELIRU: ACS.refresh() menyebut 141 nama
# dalam satu permintaan — disengaja, dan justru cara yang benar (satu pembacaan
# terarah lebih murah bagi ONU daripada menyusuri pohon). Uji ini menahan agar
# batasnya tidak diperketat lagi tanpa mengukur dulu.
ok(acs_guard.MAKS_PARAM_BACA >= 141,
   'batas baca menampung 141 nama yang dikirim ACS.refresh() (dapat %d)'
   % acs_guard.MAKS_PARAM_BACA)
lolos(task(name='getParameterValues',
           parameterNames=['InternetGatewayDevice.P%d' % i for i in range(141)]),
      'pembacaan 141 nama (bentuk nyata ACS.refresh) diizinkan')

ditolak(task(name='setParameterValues', parameterValues=[]),
        'bentuk_salah', 'penulisan kosong ditolak')
ditolak(task(name='setParameterValues',
             parameterValues=['InternetGatewayDevice.A']),
        'bentuk_salah', 'parameterValues bukan larik-dari-larik ditolak')
ditolak(task(name='setParameterValues',
             parameterValues=[['InternetGatewayDevice.A', 1, 'xsd:int']]
                             * (acs_guard.MAKS_PARAM_TULIS + 1)),
        'terlalu_banyak', 'penulisan melebihi 32 parameter ditolak')

# ══ 6. Parameter yang tidak boleh ditulis panel ══
# Wilayah provision `inform`. Kalau panel ikut menulis, dua penulis berebut
# nilai yang sama dan ONU menerima penulisan flash bergantian tanpa henti.
for nama in ('InternetGatewayDevice.ManagementServer.ConnectionRequestPassword',
             'InternetGatewayDevice.ManagementServer.PeriodicInformInterval',
             'InternetGatewayDevice.ManagementServer.URL',
             'Device.ManagementServer.Password',
             'InternetGatewayDevice.X_CT-COM_FactoryReset',
             'InternetGatewayDevice.LANDevice.1.RestoreFactoryDefault'):
    ditolak(task(name='setParameterValues', parameterValues=[[nama, 'x', 'xsd:string']]),
            'tulis_terlarang', 'menulis %s ditolak' % nama.split('.')[-1])

# Yang WAJIB tetap lolos — ini pekerjaan sehari-hari panel.
for nama in ('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
             'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
             'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
             'InternetGatewayDevice.WANDevice.1.X_CT-COM_WANEponLinkConfig.VLANIDMark'):
    lolos(task(name='setParameterValues', parameterValues=[[nama, 'x', 'xsd:string']]),
          'menulis %s tetap boleh' % nama.split('.')[-1])

# Membaca KeyPassphrase tetap boleh: halaman SSID memang menampilkannya, dan
# parameter itu bukan wilayah provision. Yang dilarang hanya ManagementServer.
lolos(task(name='getParameterValues',
           parameterNames=['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase']),
      'membaca KeyPassphrase tetap boleh (dipakai halaman SSID)')
ditolak(task(name='getParameterValues',
             parameterNames=['InternetGatewayDevice.ManagementServer.ConnectionRequestPassword']),
        'baca_terlarang', 'membaca password ManagementServer ditolak')

# ══ 7. addObject / deleteObject ══
lolos(task(name='addObject',
           objectName='InternetGatewayDevice.WANDevice.1.WANConnectionDevice'),
      'addObject pada induk WANConnectionDevice diizinkan')
ditolak(task(name='addObject', objectName='InternetGatewayDevice'),
        'objek_terlalu_tinggi', 'addObject di akar pohon ditolak')
ditolak(task(name='addObject', objectName=''), 'objek_kosong',
        'addObject tanpa objectName ditolak')
# Tabel Port Binding ZTE F670L/F679L ada di akar pohon. 2026-09-29: setiap
# pengaturan port binding di ZTEGD0528061 ditolak "terlalu dekat ke akar".
lolos(task(name='addObject', objectName='InternetGatewayDevice.X_ZTE-COM_PortBinding'),
      'addObject pada tabel Port Binding ZTE diizinkan (pengecualian terdaftar)')
lolos(task(name='addObject', objectName='InternetGatewayDevice.X_ZTE-COM_PortBinding.'),
      'titik di ujung tidak mengubah hasilnya')
ditolak(task(name='addObject', objectName='InternetGatewayDevice.X_ZTE-COM_Lain'),
        'objek_terlalu_tinggi', 'tabel akar lain tetap ditolak — pengecualian nama persis, bukan pola')
ditolak(task(name='addObject', objectName='Device.X_ZTE-COM_PortBinding'),
        'objek_terlalu_tinggi', 'pengecualian hanya untuk pohon InternetGatewayDevice')
ditolak(task(name='deleteObject', objectName='InternetGatewayDevice.X_ZTE-COM_PortBinding'),
        'objek_terlalu_tinggi', 'deleteObject seluruh tabel Port Binding tetap ditolak')

lolos(task(name='deleteObject',
           objectName='InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2'),
      'deleteObject satu WCD diizinkan')
lolos(task(name='deleteObject',
           objectName='InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1'),
      'deleteObject satu koneksi diizinkan')
# Ini yang paling penting: satu perintah yang membuang seluruh sisi WAN sebuah ONU.
ditolak(task(name='deleteObject', objectName='InternetGatewayDevice.WANDevice.1'),
        'objek_terlalu_tinggi', 'deleteObject seluruh WANDevice.1 ditolak')
ditolak(task(name='deleteObject', objectName='InternetGatewayDevice.LANDevice.1'),
        'objek_terlalu_tinggi', 'deleteObject seluruh LANDevice.1 ditolak')

# ══ 8. Koleksi konfigurasi GenieACS terkunci ══
# Provision = kode yang berjalan pada setiap sesi setiap ONU. Perubahannya
# dilakukan manusia yang sadar, dengan prosedur — bukan oleh aplikasi.
for koleksi in ('provisions', 'virtualParameters', 'presets', 'files'):
    ditolak(acs_guard.periksa('POST', '/api/%s/x' % koleksi, b'{}'),
            'koleksi_terkunci', 'POST /%s ditolak' % koleksi)
    ditolak(acs_guard.periksa('DELETE', '/api/%s/x' % koleksi, None),
            'koleksi_terkunci', 'DELETE /%s ditolak' % koleksi)
    lolos(acs_guard.periksa('GET', '/api/%s' % koleksi, None),
          'GET /%s tetap boleh (halaman pemeriksa membutuhkannya)' % koleksi)

# ══ 9. Mode aman ══
ditolak(acs_guard.periksa('POST', '/api/devices/X/tasks',
                          json.dumps({'name': 'reboot'}).encode(), mode_aman=True),
        'mode_aman', 'mode aman menghentikan reboot')
ditolak(acs_guard.periksa('POST', '/api/devices/X/tasks',
                          json.dumps({'name': 'setParameterValues',
                                      'parameterValues': [['InternetGatewayDevice.A', 1]]}).encode(),
                          mode_aman=True),
        'mode_aman', 'mode aman menghentikan penulisan')
# Summon juga berhenti: ia memang tidak mengubah apa pun, tapi tetap membebani
# CPU ONU — dan saat mode aman menyala, yang kita mau justru ONU dibiarkan tenang.
ditolak(acs_guard.periksa('POST', '/api/devices/X/tasks',
                          json.dumps({'name': 'refreshObject',
                                      'objectName': 'InternetGatewayDevice.WANDevice'}).encode(),
                          mode_aman=True),
        'mode_aman', 'mode aman menghentikan summon')
# Tapi membatalkan perintah yang telanjur mengantre harus tetap bisa.
lolos(acs_guard.periksa('DELETE', '/api/tasks/abc123', None, mode_aman=True),
      'membatalkan task tetap boleh saat mode aman')
lolos(acs_guard.periksa('DELETE', '/api/faults/abc', None, mode_aman=True),
      'membersihkan fault tetap boleh saat mode aman')

# Larangan mutlak harus menang atas mode aman: alasan penolakan yang benar
# lebih berguna daripada "sedang mode aman" yang menyesatkan.
ditolak(acs_guard.periksa('POST', '/api/provisions/inform', b'{}', mode_aman=True),
        'koleksi_terkunci', 'koleksi terkunci ditolak dengan alasannya sendiri, bukan mode_aman')

# ══ 10. Sakelar mode aman tersimpan & berjejak ══
db.conn()
ok(acs_guard.mode_aman_aktif() is False, 'bawaan: mode aman mati')
acs_guard.set_mode_aman(True, actor={'id': None, 'username': 'admin'}, alasan='uji')
ok(acs_guard.mode_aman_aktif() is True, 'mode aman menyala setelah disetel')
acs_guard.set_mode_aman(False, actor={'id': None, 'username': 'admin'}, alasan='uji selesai')
ok(acs_guard.mode_aman_aktif() is False, 'mode aman mati setelah dimatikan')

rows = db.audit_list(limit=20)
ok(any(r['action'] == 'mode_aman_nyala' for r in rows), 'menyalakan mode aman tercatat')
ok(any(r['action'] == 'mode_aman_mati' for r in rows), 'mematikan mode aman tercatat')

# Env adalah jalan darurat: panel bisa dinyalakan ulang dalam keadaan aman
# tanpa menyentuh basis data, dan tak seorang pun bisa mematikannya dari UI.
os.environ['SKY_READONLY'] = '1'
ok(acs_guard.mode_aman_aktif() is True, 'SKY_READONLY=1 menyalakan mode aman')
acs_guard.set_mode_aman(False, actor={'id': None, 'username': 'admin'}, alasan='coba matikan')
ok(acs_guard.mode_aman_aktif() is True, 'mode aman dari env TIDAK bisa dimatikan lewat UI')
del os.environ['SKY_READONLY']

# ══ 11. Pagar ditegakkan di jalur yang benar-benar dilewati permintaan ══
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                        'server.py'), encoding='utf-8').read()
i_body  = src.find('body = self.rfile.read(content_length)')
i_pagar = src.find('acs_guard.periksa(')
i_kirim = src.find('urllib.request.Request(target')
ok(0 < i_body < i_pagar < i_kirim,
   'acs_guard.periksa dipanggil sesudah body dibaca dan SEBELUM diteruskan ke NBI')
ok('acs_guard.mode_aman_aktif()' in src, 'mode aman ikut diperiksa di _proxy')
ok('_catat_tolakan' in src, 'penolakan meninggalkan jejak audit')
ok("db.audit('onu_reboot'" in src, 'reboot dicatat ke audit')


# ═══════════════════════════════════════════════════════════════════
#  12. Ujung-ke-ujung: server sungguhan, permintaan mentah
# ═══════════════════════════════════════════════════════════════════
# Bagian di atas menguji aturannya. Bagian ini menguji bahwa aturannya
# benar-benar berdiri di jalur yang dilewati permintaan — dikirim seperti
# penyerang atau skrip mengirimnya, tanpa menyentuh satu tombol pun di UI.
import socket, subprocess, time, threading, urllib.request, urllib.error, http.cookiejar

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

def _free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

PORT = _free_port()
NBI  = _free_port()
TMP  = tempfile.mkdtemp(prefix='skypagar-e2e-')

# NBI tiruan: mencatat apa yang BERHASIL menembus pagar. Kalau sebuah perintah
# terlarang sampai ke sini, pagarnya bocor — dan itulah yang diuji, bukan
# sekadar kode jawaban HTTP-nya.
_sampai = []
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer as _THS

class _NBI(BaseHTTPRequestHandler):
    def _catat(self):
        n = int(self.headers.get('Content-Length') or 0)
        _sampai.append((self.command, self.path, self.rfile.read(n) if n else b''))
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')
    do_GET = do_POST = do_DELETE = _catat
    def log_message(self, *a): pass

_nbi = _THS(('127.0.0.1', NBI), _NBI); _nbi.daemon_threads = True
threading.Thread(target=_nbi.serve_forever, daemon=True).start()

boot = f'''
import sys, os
sys.path.insert(0, {ROOT!r})
import db, auth
auth.DATA_DIR   = {TMP!r}
auth.USERS_PATH = os.path.join({TMP!r}, 'users.json')
db.set_path(os.path.join({TMP!r}, 'sky.db'))
pw = auth.ensure_bootstrap()
print('BOOTPW=' + pw, flush=True)
import config_store, server
config_store.acs_set({{'protocol':'http','host':'127.0.0.1','port':{NBI},'base_path':''}})
srv = server.ThreadingHTTPServer(('127.0.0.1', {PORT}), server.SPAHandler)
srv.daemon_threads = True
srv.serve_forever()
'''
proc = subprocess.Popen([sys.executable, '-c', boot], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, cwd=ROOT)
BOOTPW, t0 = None, time.time()
while time.time() - t0 < 20:
    line = proc.stdout.readline()
    if line.startswith('BOOTPW='):
        BOOTPW = line.strip().split('=', 1)[1]; break
    if proc.poll() is not None:
        print('server mati saat start:\n' + proc.stdout.read()); sys.exit(1)
for _ in range(60):
    try:
        s = socket.create_connection(('127.0.0.1', PORT), 0.3); s.close(); break
    except Exception: time.sleep(0.1)

BASE = 'http://127.0.0.1:%d' % PORT
_cj = http.cookiejar.CookieJar()
_op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj))

def call(path, method='GET', data=None):
    req = urllib.request.Request(BASE + path, method=method)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header('Content-Type', 'application/json')
    try:
        r = _op.open(req, body, timeout=8)
        raw = r.read().decode()
        try: return r.status, json.loads(raw)
        except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw

try:
    code, _ = call('/auth/login', 'POST', {'username': 'admin', 'password': BOOTPW})
    ok(code == 200, 'e2e: login admin berhasil')

    _sampai.clear()
    code, body = call('/api/devices/AAA/tasks', 'POST', {'name': 'factoryReset'})
    ok(code == 403, 'e2e: factoryReset lewat HTTP mentah → 403 (dapat %s)' % code)
    ok(isinstance(body, dict) and body.get('pagar') is True,
       'e2e: jawaban menandai dirinya sebagai penolakan pagar, bukan galat GenieACS')
    ok(_sampai == [], 'e2e: factoryReset TIDAK PERNAH sampai ke NBI')

    _sampai.clear()
    code, _ = call('/api/devices/AAA/tasks', 'POST', {'name': 'refreshObject', 'objectName': ''})
    ok(code == 403 and _sampai == [], 'e2e: refresh seluruh pohon tidak sampai ke NBI')

    _sampai.clear()
    code, _ = call('/api/provisions/inform', 'POST', {'script': 'apa saja'})
    ok(code == 403 and _sampai == [], 'e2e: menulis provision tidak sampai ke NBI')

    # Yang sah HARUS tetap lewat — pagar yang menahan pekerjaan normal sama
    # rusaknya dengan pagar yang bocor.
    _sampai.clear()
    code, _ = call('/api/devices/AAA/tasks', 'POST',
                   {'name': 'setParameterValues',
                    'parameterValues': [['InternetGatewayDevice.LANDevice.1.'
                                         'WLANConfiguration.1.SSID', 'RumahBudi', 'xsd:string']]})
    ok(code == 200, 'e2e: menyimpan SSID tetap berhasil (dapat %s)' % code)
    ok(len(_sampai) == 1 and b'RumahBudi' in _sampai[0][2],
       'e2e: perintah sah benar-benar diteruskan ke NBI apa adanya')

    _sampai.clear()
    code, _ = call('/api/devices?query=%7B%7D', 'GET')
    ok(code == 200 and len(_sampai) == 1, 'e2e: GET diteruskan tanpa hambatan')

    # ── Alur Refresh yang SEBENARNYA dikirim panel ──
    # Ini yang paling mudah dirusak tanpa sadar: pagar yang tampak masuk akal
    # di atas kertas ternyata menolak pekerjaan sehari-hari. Bentuk di bawah
    # diambil dari js/api.js — summon() dan refresh() — bukan dikarang.
    _sampai.clear()
    code, _ = call('/api/devices/AAA/tasks?connection_request&timeout=3000', 'POST',
                   {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice'})
    ok(code == 200 and len(_sampai) == 1,
       'e2e: summon model non-rapuh (akar IGD) tetap lewat — dapat %s' % code)

    _sampai.clear()
    for sub in ('DeviceInfo', 'WANDevice', 'LANDevice'):
        call('/api/devices/AAA/tasks?connection_request&timeout=3000', 'POST',
             {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice.' + sub})
    ok(len(_sampai) == 3, 'e2e: summon model rapuh (3 sub-pohon) tetap lewat')

    _sampai.clear()
    code, _ = call('/api/devices/AAA/tasks?connection_request&timeout=3000', 'POST',
                   {'name': 'getParameterValues',
                    'parameterNames': ['InternetGatewayDevice.P%d' % i for i in range(141)]})
    ok(code == 200 and len(_sampai) == 1,
       'e2e: pembacaan 141 nama (ACS.refresh) tetap lewat — dapat %s' % code)

    # Reboot: lewat, tapi berjejak.
    _sampai.clear()
    code, _ = call('/api/devices/AAA/tasks', 'POST', {'name': 'reboot'})
    ok(code == 200 and len(_sampai) == 1, 'e2e: reboot tetap diizinkan')

    # Mode aman lewat endpoint sungguhan.
    code, body = call('/config/mode-aman', 'GET')
    ok(code == 200 and body.get('aktif') is False, 'e2e: mode aman awalnya mati')
    code, body = call('/config/mode-aman', 'POST', {'aktif': True})
    ok(code == 200 and body.get('aktif') is True, 'e2e: mode aman dinyalakan')

    _sampai.clear()
    code, body = call('/api/devices/AAA/tasks', 'POST', {'name': 'reboot'})
    ok(code == 503 and _sampai == [], 'e2e: mode aman menahan reboot di server')
    code, _ = call('/api/devices?query=%7B%7D', 'GET')
    ok(code == 200, 'e2e: pembacaan tetap jalan saat mode aman')

    # Mematikan tanpa alasan ditolak — jejaknya yang menjadi taruhan.
    code, _ = call('/config/mode-aman', 'POST', {'aktif': False})
    ok(code == 400, 'e2e: mematikan mode aman tanpa alasan ditolak')
    code, body = call('/config/mode-aman', 'POST', {'aktif': False, 'alasan': 'uji selesai'})
    ok(code == 200 and body.get('aktif') is False, 'e2e: mematikan dengan alasan berhasil')
finally:
    proc.kill()
    _nbi.shutdown()


# ═══════════════════════════════════════════════════════════════════
#  13. Pagar tidak boleh menolak lalu lintas panel sendiri
# ═══════════════════════════════════════════════════════════════════
# Kasus-kasus di atas dikarang oleh penulis uji, dan penulis uji punya
# kelemahan tetap: ia mengarang bentuk yang sudah ia pikirkan. Bagian ini
# mengambil perintah SUNGGUHAN yang dibentuk js/api.js — dengan menjalankannya
# — lalu melewatkan tiap perintah itu ke pagar.
#
# Inilah yang menangkap kekeliruan batas 64 nama: bentuk yang dikirim panel
# ternyata 141. Tanpa langkah ini, pagarnya lulus semua uji dan mematikan
# tombol Refresh di produksi.
NODE = r'''
const fs = require('fs');
const src = fs.readFileSync('js/api.js', 'utf8');
global.window = {}; global.localStorage = { getItem: () => null, setItem: () => {} };
const dikirim = [];
global.fetch = async (u, o) => {
  if (o && o.body) dikirim.push(JSON.parse(o.body));
  return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
};
eval(src + '; globalThis.__ACS = ACS;');
(async () => {
  await __ACS.summon('X', 'InternetGatewayDevice', 'F663NV9');
  await __ACS.summon('X', 'InternetGatewayDevice', 'ZL-2113X');
  await __ACS.refresh('X', []);
  await __ACS.setParam('X', [['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', 'A', 'xsd:string']]);
  await __ACS.addObject('X', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice');
  await __ACS.deleteObject('X', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2');
  console.log(JSON.stringify(dikirim));
})();
'''

_r = subprocess.run(['node', '-e', NODE], capture_output=True, text=True, cwd=ROOT)
if _r.returncode != 0:
    ok(False, 'gagal menjalankan js/api.js untuk mengambil perintah nyata: '
              + (_r.stderr or _r.stdout)[-300:])
else:
    _nyata = json.loads(_r.stdout.strip().splitlines()[-1])
    ok(len(_nyata) >= 6,
       'terkumpul perintah nyata dari js/api.js (dapat %d)' % len(_nyata))
    for _t in _nyata:
        _h = acs_guard.periksa('POST', '/api/devices/X/tasks', json.dumps(_t).encode())
        _label = _t.get('name', '?')
        if _t.get('objectName'):
            _label += ' ' + str(_t['objectName'])[:45]
        if _t.get('parameterNames'):
            _label += ' (%d nama)' % len(_t['parameterNames'])
        if _t.get('parameterValues'):
            _label += ' (%d nilai)' % len(_t['parameterValues'])
        ok(_h is None, 'perintah nyata panel LOLOS pagar: %s → ditolak %s'
                       % (_label, (_h or {}).get('kode')))

print('pagar: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
