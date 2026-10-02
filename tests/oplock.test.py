#!/usr/bin/env python3
"""Uji kunci operasi per-ONU, mode "ikut", dan masa istirahat (ops_lock.py).

MASALAH YANG DITUTUP: aplikasi ini dipakai banyak orang. Kalau A menekan Refresh
pada satu ONU dan B menekan Refresh pada ONU yang sama tiga detik kemudian, ONU
itu menerima DUA connection-request dan menyusuri pohonnya DUA KALI untuk
menghasilkan data yang sama persis. Yang bertambah hanya beban CPU-nya, dan
pelanggan di baliknya merasakannya sebagai internet melambat.

Penjaga lama (`_adaTaskKembar`) tidak menutup ini: ia JavaScript di browser dan
hanya melihat tab miliknya sendiri. Dua browser memeriksa bersamaan, keduanya
lolos. Karena itu uji di bawah memakai thread sungguhan yang berlomba, bukan
pemanggilan berurutan yang selalu menang.

Yang dijaga:
  • Dua permintaan sama pada satu ONU → SATU task, yang kedua "ikut".
  • Permintaan berbeda pada ONU yang sedang bekerja → ditolak, bukan diikutkan
    (menyimpan SSID tidak bisa "menumpang" pada refresh).
  • Masa istirahat sesudah summon: 60 dtk normal, 300 dtk model rapuh.
  • Masa istirahat TIDAK menghalangi penulisan — teknisi yang baru menyegarkan
    lalu menyimpan SSID tidak boleh diblokir semenit.
  • Batas 5 operasi serentak se-armada — menahan satu orang memilih 200 ONU.
  • Kunci lepas sendiri (TTL 120 dtk) kalau browser pemiliknya ditutup.
  • Pengikut tetap dapat hasilnya walau menanya sesudah operasinya selesai.
"""
import os, sys, json, time, tempfile, threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend'))
import db
db.set_path(os.path.join(tempfile.mkdtemp(prefix='skyops-'), 'sky.db'))
import ops_lock

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

SUMMON = {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice'}
TULIS  = {'name': 'setParameterValues',
          'parameterValues': [['InternetGatewayDevice.LANDevice.1.'
                               'WLANConfiguration.1.SSID', 'A', 'xsd:string']]}

ZTE  = '64E0AB-F663NV3A-ZTEG1B874818'
HWTC = 'HWTC-ZL%2D2113X-HWTCA90D86D8'


# ══ 1. Model dibaca dari ID — tanpa memanggil GenieACS ══
# ID GenieACS berbentuk OUI-ProductClass-SerialNumber, dan tanda hubung di
# dalam ProductClass di-persen-kodekan jadi %2D. Kalau pembacaan ini salah,
# ZL-2113X akan dapat masa istirahat model biasa — persis model yang paling
# tidak boleh dipaksa.
ok(ops_lock.model_dari_id(ZTE) == 'F663NV3A', 'model ZTE terbaca dari ID')
ok(ops_lock.model_dari_id(HWTC) == 'ZL-2113X',
   'model ZL-2113X terbaca (%%2D di-decode) — dapat: %s' % ops_lock.model_dari_id(HWTC))
ok(ops_lock.model_dari_id('') == '', 'ID kosong tidak meledak')
ok(ops_lock.model_dari_id('acak') == '', 'ID tak berbentuk tidak meledak')
ok(ops_lock.masa_istirahat(HWTC) == ops_lock.ISTIRAHAT_RAPUH,
   'ZL-2113X dapat masa istirahat panjang (300 dtk)')
ok(ops_lock.masa_istirahat(ZTE) == ops_lock.ISTIRAHAT_NORMAL,
   'model biasa dapat masa istirahat 60 dtk')


# ══ 2. Mode "ikut": dua orang, satu ONU, satu task ══
ops_lock.reset()
h1, op1 = ops_lock.mulai(ZTE, 'andi', SUMMON)
ok(h1 == 'mulai', 'peminta pertama mendapat kunci')
h2, op2 = ops_lock.mulai(ZTE, 'budi', SUMMON)
ok(h2 == 'ikut', 'peminta kedua DIIKUTKAN, bukan ditolak (dapat %s)' % h2)
ok(op2['opId'] == op1['opId'], 'pengikut menunjuk operasi yang sama')
ok('budi' in op1['pengikut'], 'nama pengikut tercatat')

# Yang paling penting dari seluruh berkas ini: ONU hanya menerima SATU perintah.
ok(len([o for o in ops_lock.keadaan()['berjalan'] if o['perangkat'] == ZTE]) == 1,
   'hanya SATU operasi berjalan untuk ONU itu')

# Orang ketiga juga ikut, bukan menumpuk.
h3, op3 = ops_lock.mulai(ZTE, 'cici', SUMMON)
ok(h3 == 'ikut' and op3['opId'] == op1['opId'], 'peminta ketiga ikut ke operasi yang sama')


# ══ 3. Perintah BERBEDA tidak boleh menumpang ══
# Menyimpan SSID bukan "versi lain" dari menyegarkan — hasilnya beda, jadi
# mengikutkannya berarti berbohong pada pemanggil.
h4, op4 = ops_lock.mulai(ZTE, 'dedi', TULIS)
ok(h4 == 'sibuk', 'perintah berbeda ditolak dengan alasan sibuk (dapat %s)' % h4)
ok(op4['pemilik'] == 'andi', 'penolakan menyebut siapa yang sedang memakai')


# ══ 4. Masa istirahat sesudah summon ══
ops_lock.selesai(op1['opId'], 'selesai', {'status': 200})
ok(ops_lock.keadaan()['berjalan'] == [], 'kunci lepas setelah operasi selesai')

h5, sisa = ops_lock.mulai(ZTE, 'andi', SUMMON)
ok(h5 == 'istirahat', 'summon berikutnya kena masa istirahat (dapat %s)' % h5)
ok(0 < sisa <= ops_lock.ISTIRAHAT_NORMAL + 1,
   'sisa detik masuk akal (dapat %s)' % sisa)

# Masa istirahat berlaku untuk SIAPA PUN — bukan hanya orang yang menyegarkan.
h6, _ = ops_lock.mulai(ZTE, 'budi', SUMMON)
ok(h6 == 'istirahat', 'pengguna lain pun ikut kena masa istirahat ONU itu')

# Tapi PENULISAN tidak boleh ikut terkunci: teknisi yang baru menyegarkan lalu
# menyimpan SSID tidak boleh menunggu semenit tanpa alasan.
h7, op7 = ops_lock.mulai(ZTE, 'andi', TULIS)
ok(h7 == 'mulai', 'penulisan TIDAK kena masa istirahat summon (dapat %s)' % h7)
ops_lock.selesai(op7['opId'], 'selesai')

# ...dan penulisan tidak memulai masa istirahat baru.
h8, op8 = ops_lock.mulai(ZTE, 'andi', TULIS)
ok(h8 == 'mulai', 'penulisan berikutnya tetap boleh')
ops_lock.selesai(op8['opId'], 'selesai')


# ══ 4b. Summon model rapuh: TIGA sub-pohon berurutan harus semuanya lewat ══
# Ini cacat nyata yang ditemukan uji e2e, bukan kasus karangan. ACS.summon()
# untuk ZL-2113X sengaja memecah refresh menjadi DeviceInfo → WANDevice →
# LANDevice, berurutan, karena ONU-nya hanya sanggup satu percakapan. Dengan
# masa istirahat per-ONU, permintaan kedua dan ketiga ikut terblokir — Refresh
# mati justru pada satu-satunya model yang paling perlu dilindungi.
# Karena itu masa istirahat dihitung per (ONU, PERINTAH).
ops_lock.reset()
for sub in ('DeviceInfo', 'WANDevice', 'LANDevice'):
    perintah = {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice.' + sub}
    h, o = ops_lock.mulai(HWTC, 'andi', perintah)
    ok(h == 'mulai', 'summon rapuh sub-pohon %s lewat (dapat %s)' % (sub, h))
    if h == 'mulai':
        ops_lock.selesai(o['opId'], 'selesai')

# ...tapi mengulang sub-pohon yang SAMA tetap ditolak. Inilah yang menutup
# masalah aslinya: teknisi menekan Refresh berulang mengirim perintah identik.
h, sisa = ops_lock.mulai(HWTC, 'andi', {'name': 'refreshObject',
                                        'objectName': 'InternetGatewayDevice.WANDevice'})
ok(h == 'istirahat', 'mengulang sub-pohon yang sama tetap ditolak (dapat %s)' % h)
ok(sisa > ops_lock.ISTIRAHAT_NORMAL,
   'ZL-2113X memakai masa istirahat panjang, bukan yang normal (dapat %s dtk)' % sisa)

# Menekan Refresh dua kali pada model biasa juga tetap ditolak pada klik kedua.
ops_lock.reset()
h, o = ops_lock.mulai(ZTE, 'andi', SUMMON)
ops_lock.selesai(o['opId'], 'selesai')
h2, _ = ops_lock.mulai(ZTE, 'andi', SUMMON)
ok(h2 == 'istirahat', 'klik Refresh kedua pada ONU yang sama ditolak (dapat %s)' % h2)


# ══ 5. Batas serentak se-armada ══
# Ini yang menahan kasus paling merusak: SATU orang memilih 200 ONU.
ops_lock.reset()
dibuka = []
for i in range(ops_lock.MAKS_SERENTAK):
    h, o = ops_lock.mulai('AAAAAA-M%d-SN%d' % (i, i), 'andi', SUMMON)
    ok(h == 'mulai', 'operasi ke-%d masih diizinkan' % (i + 1))
    dibuka.append(o)
h, n = ops_lock.mulai('AAAAAA-MX-SNX', 'andi', SUMMON)
ok(h == 'penuh', 'operasi melebihi batas serentak ditolak (dapat %s)' % h)
ok(n == ops_lock.MAKS_SERENTAK, 'penolakan menyebut jumlah yang sedang berjalan')

ops_lock.selesai(dibuka[0]['opId'], 'selesai')
h, o = ops_lock.mulai('AAAAAA-MX-SNX', 'andi', SUMMON)
ok(h == 'mulai', 'satu selesai → slot terbuka lagi')


# ══ 6. Kunci lepas sendiri kalau browser pemiliknya ditutup ══
# Tanpa kedaluwarsa, satu tab yang ditutup di tengah jalan mengunci ONU-nya
# selamanya dan tak seorang pun tahu kenapa.
ops_lock.reset()
h, op = ops_lock.mulai(ZTE, 'andi', SUMMON)
ok(h == 'mulai', 'operasi dimulai')
op['mulai'] = time.time() - (ops_lock.TTL_OPERASI + 5)     # pura-pura terlantar
h, op9 = ops_lock.mulai(ZTE, 'budi', SUMMON)
ok(h == 'mulai', 'kunci terlantar lepas sendiri sesudah TTL (dapat %s)' % h)
ok(op9['opId'] != op['opId'], 'operasi baru, bukan meneruskan yang terlantar')
ops_lock.selesai(op9['opId'], 'selesai')


# ══ 7. Pengikut tetap menerima hasil, walau terlambat menanya ══
# Kalau operasi yang sudah selesai langsung dibuang, pengikut yang menanya satu
# detik terlambat menerima "tidak dikenal" dan menyangka perintahnya hilang.
ops_lock.reset()
h, op = ops_lock.mulai(ZTE, 'andi', SUMMON)
ops_lock.mulai(ZTE, 'budi', SUMMON)
ops_lock.selesai(op['opId'], 'selesai', {'status': 200})
st = ops_lock.status(op['opId'])
ok(st is not None, 'operasi yang sudah selesai masih bisa ditanyakan')
ok(st['state'] == 'selesai', 'pengikut melihat state selesai')
ok(st['hasil'] == {'status': 200}, 'pengikut menerima hasil yang sama')
r = ops_lock.ringkas(st)
ok(json.dumps(r), 'ringkas() bisa di-JSON-kan (set tidak boleh bocor)')
ok(r['pengikut'] == ['budi'], 'daftar pengikut ikut terkirim')
ok(ops_lock.status('tidakada') is None, 'opId karangan → None')


# ══ 8. Perlombaan sungguhan antar-thread ══
# Bagian sebelumnya memanggil berurutan, dan pemanggilan berurutan SELALU
# menang. Kejadian yang sebenarnya adalah dua permintaan HTTP tiba pada saat
# yang sama di dua thread berbeda. Kalau kuncinya tidak benar-benar atomik,
# di sinilah ia terlihat.
ops_lock.reset()
hasil, kunci_hasil = [], threading.Lock()
mulai_bersama = threading.Event()

def penyerbu(nama):
    mulai_bersama.wait()
    h, _ = ops_lock.mulai(ZTE, nama, SUMMON)
    with kunci_hasil:
        hasil.append(h)

utas = [threading.Thread(target=penyerbu, args=('user%d' % i,)) for i in range(20)]
for t in utas: t.start()
mulai_bersama.set()
for t in utas: t.join()

ok(hasil.count('mulai') == 1,
   '20 permintaan serentak → TEPAT SATU yang mengirim ke ONU (dapat %d)'
   % hasil.count('mulai'))
ok(hasil.count('ikut') == 19,
   '19 sisanya diikutkan, tidak ada yang ditolak (dapat %d ikut, %d lain)'
   % (hasil.count('ikut'), len(hasil) - hasil.count('mulai') - hasil.count('ikut')))


# ══ 9. Angka batas tidak boleh diperlonggar diam-diam ══
ok(ops_lock.TTL_OPERASI >= 120,
   'TTL >= 120 dtk (CR terlama terukur 60 dtk pada ZL-2113X, beri ruang 2x)')
ok(ops_lock.ISTIRAHAT_RAPUH >= 300, 'masa istirahat model rapuh >= 300 dtk')
ok(ops_lock.ISTIRAHAT_NORMAL >= 60, 'masa istirahat normal >= 60 dtk')
ok(ops_lock.MAKS_SERENTAK <= 5, 'batas serentak <= 5')
ok('ZL-2113X' in ops_lock.MODEL_RAPUH, 'ZL-2113X terdaftar rapuh')


# ══ 10. Terpasang di jalur yang benar-benar dilewati permintaan ══
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
src = open(os.path.join(ROOT, 'backend', 'server.py'), encoding='utf-8').read()
i_pagar = src.find('acs_guard.periksa(')
i_kunci = src.find('self._mulai_operasi(body)')
i_kirim = src.find('urllib.request.Request(target')
ok(0 < i_pagar < i_kunci < i_kirim,
   'kunci dipasang sesudah pagar dan SEBELUM permintaan diteruskan ke NBI')
ok(src.count('self._tutup_operasi(') >= 3,
   'operasi ditutup di KETIGA cabang (berhasil, HTTPError, galat lain) — '
   'kalau satu terlewat, ONU-nya terkunci sampai TTL habis')
ok("OPS_PREFIX = '/ops/'" in src, 'ada jalur /ops/ untuk pengikut')
ok('_handle_ops' in src, 'jalur /ops/ ditangani')

# Halaman pengikut TIDAK boleh menyentuh ONU: ia hanya membaca registry panel.
badan = src[src.find('def _handle_ops'):src.find('def _proxy')]
ok('urlopen' not in badan and 'Request(' not in badan,
   '/ops/ murni baca dari memori panel — tidak menghubungi GenieACS maupun ONU')

# Panel harus benar-benar memakai jawabannya.
js_api = open(os.path.join(ROOT, 'frontend', 'js', 'api.js'), encoding='utf-8').read()
ok('diikutkan' in js_api, 'api.js mengenali jawaban "diikutkan"')
ok('opStatus' in js_api and 'tungguOp' in js_api, 'api.js menyediakan penunggu operasi')
js_dev = open(os.path.join(ROOT, 'frontend', 'js', 'devices.js'), encoding='utf-8').read()
ok('MAKS_BULK_REFRESH' in js_dev, 'refresh massal punya batas jumlah')
ok(int(js_dev.split('MAKS_BULK_REFRESH = ')[1].split(';')[0]) <= 50,
   'batas refresh massal <= 50 ONU per aksi')
ok('_runBatch(rapuh, kirim, 1' in js_dev,
   'model rapuh dikerjakan satu per satu pada refresh massal')
ok('_runBatch(biasa, kirim, 3' in js_dev,
   'model biasa turun ke 3 serentak (dulu 4, tanpa batas apa pun)')
ok('_runBatch(devs, d => ACS.summon' not in js_dev,
   'bentuk lama tanpa batas sudah tidak ada')


# ═══════════════════════════════════════════════════════════════════
#  11. Ujung-ke-ujung: dua pengguna sungguhan, satu ONU, satu detik
# ═══════════════════════════════════════════════════════════════════
# Bagian di atas menguji logikanya. Bagian ini menguji kejadian yang
# sebenarnya ditanyakan: "user A sedang refresh ONU A, user B tidak sengaja
# ingin refresh ONU A juga." Dua akun berbeda, dua sesi berbeda, server
# sungguhan, dan NBI tiruan yang SENGAJA lambat supaya operasi A masih
# berjalan saat B menekan tombol.
#
# Yang dihitung bukan kode HTTP-nya, melainkan berapa perintah yang benar-benar
# SAMPAI ke NBI — karena itulah yang menjadi beban CPU ONU.
import socket, subprocess, urllib.request, urllib.error, http.cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer as _THS

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

def _free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

PORT, NBI = _free_port(), _free_port()
TMP = tempfile.mkdtemp(prefix='skyops-e2e-')
_sampai, _sampai_kunci = [], threading.Lock()

class _NBI(BaseHTTPRequestHandler):
    def _catat(self):
        n = int(self.headers.get('Content-Length') or 0)
        isi = self.rfile.read(n) if n else b''
        with _sampai_kunci:
            _sampai.append((self.command, self.path, isi))
        # Lambat DISENGAJA: connection-request nyata pada ZL-2113X memakan ~60
        # detik. Kalau NBI tiruan menjawab seketika, operasi A sudah selesai
        # sebelum B sempat menekan apa pun, dan ujinya tidak menguji apa-apa.
        if self.command == 'POST':
            time.sleep(1.5)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')
    do_GET = do_POST = do_DELETE = _catat
    def log_message(self, *a): pass

_nbi = _THS(('127.0.0.1', NBI), _NBI); _nbi.daemon_threads = True
threading.Thread(target=_nbi.serve_forever, daemon=True).start()

boot = '''
import sys, os
sys.path.insert(0, %r)
import db, auth
auth.DATA_DIR   = %r
auth.USERS_PATH = os.path.join(%r, 'users.json')
db.set_path(os.path.join(%r, 'sky.db'))
pw = auth.ensure_bootstrap()
print('BOOTPW=' + pw, flush=True)
import config_store, server
config_store.acs_set({'protocol':'http','host':'127.0.0.1','port':%d,'base_path':''})
srv = server.ThreadingHTTPServer(('127.0.0.1', %d), server.SPAHandler)
srv.daemon_threads = True
srv.serve_forever()
''' % (os.path.join(ROOT, 'backend'), TMP, TMP, TMP, NBI, PORT)

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

def sesi():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def call(op, path, method='GET', data=None):
    req = urllib.request.Request(BASE + path, method=method)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header('Content-Type', 'application/json')
    try:
        r = op.open(req, body, timeout=20)
        raw = r.read().decode()
        try: return r.status, json.loads(raw)
        except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw

DEV = '64E0AB-F663NV3A-ZTEG1B874818'
JALUR = '/api/devices/' + urllib.parse.quote(DEV, safe='') + '/tasks?connection_request&timeout=3000'

try:
    opA = sesi()
    code, _ = call(opA, '/auth/login', 'POST', {'username': 'admin', 'password': BOOTPW})
    ok(code == 200, 'e2e: user A (admin) masuk')

    # User B: akun sungguhan yang berbeda, bukan tab kedua akun yang sama.
    code, isi = call(opA, '/auth/users', 'POST',
                     {'username': 'budi', 'password': 'RahasiaBudi123',
                      'name': 'Budi Teknisi', 'role': 'user'})
    ok(code in (200, 201), 'e2e: akun kedua dibuat (dapat %s %s)' % (code, isi))
    opB = sesi()
    code, _ = call(opB, '/auth/login', 'POST',
                   {'username': 'budi', 'password': 'RahasiaBudi123'})
    ok(code == 200, 'e2e: user B (budi) masuk dengan akunnya sendiri (dapat %s)' % code)

    # ── Kejadiannya: A menekan Refresh, B menekan Refresh 0,3 detik kemudian ──
    with _sampai_kunci:
        _sampai.clear()
    jawab = {}
    def tekanA():
        jawab['A'] = call(opA, JALUR, 'POST',
                          {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice'})
    tA = threading.Thread(target=tekanA); tA.start()
    time.sleep(0.3)
    jawab['B'] = call(opB, JALUR, 'POST',
                      {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice'})
    tA.join()

    kodeB, isiB = jawab['B']
    ok(kodeB == 200, 'e2e: user B tidak ditolak — dapat %s' % kodeB)
    ok(isinstance(isiB, dict) and isiB.get('diikutkan') is True,
       'e2e: permintaan user B DIIKUTKAN, bukan dikirim ulang')
    ok(isinstance(isiB, dict) and isiB.get('pemilik') == 'admin',
       'e2e: user B diberi tahu siapa pemiliknya (dapat %s)'
       % (isiB.get('pemilik') if isinstance(isiB, dict) else isiB))

    with _sampai_kunci:
        tugas = [s for s in _sampai if s[0] == 'POST']
    ok(len(tugas) == 1,
       'e2e: ONU hanya menerima SATU perintah untuk dua penekanan (dapat %d)' % len(tugas))

    # ── Pengikut bisa menunggu hasilnya lewat /ops/ ──
    code, st = call(opB, '/ops/' + isiB['opId'])
    ok(code == 200 and st['state'] in ('selesai', 'berjalan'),
       'e2e: user B bisa menanyakan nasib operasi lewat /ops/ (dapat %s)' % code)

    with _sampai_kunci:
        sebelum = len(_sampai)
    call(opB, '/ops/' + isiB['opId'])
    with _sampai_kunci:
        ok(len(_sampai) == sebelum,
           'e2e: menanyakan /ops/ TIDAK menyentuh ONU sama sekali')

    # ── Klik ketiga sesudah selesai: kena masa istirahat ──
    code, isi = call(opA, JALUR, 'POST',
                     {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice'})
    ok(code == 429 and isinstance(isi, dict) and isi.get('kode') == 'istirahat',
       'e2e: Refresh berulang kena masa istirahat (dapat %s/%s)'
       % (code, isi.get('kode') if isinstance(isi, dict) else '-'))
    ok(isinstance(isi, dict) and isi.get('sisaDetik', 0) > 0,
       'e2e: penolakan menyebut sisa detik')

    # ── Tapi menyimpan SSID tetap boleh: ia tidak kena masa istirahat summon ──
    with _sampai_kunci:
        sebelum = len(_sampai)
    code, _ = call(opA, JALUR, 'POST',
                   {'name': 'setParameterValues',
                    'parameterValues': [['InternetGatewayDevice.LANDevice.1.'
                                         'WLANConfiguration.1.SSID', 'A', 'xsd:string']]})
    ok(code == 200, 'e2e: menyimpan SSID tetap lewat walau ONU baru disegarkan (dapat %s)' % code)
    with _sampai_kunci:
        ok(len(_sampai) > sebelum, 'e2e: penulisan benar-benar diteruskan ke NBI')
finally:
    proc.kill()
    _nbi.shutdown()

print('oplock: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
