#!/usr/bin/env python3
"""Uji panel di belakang reverse proxy (nginx/Caddy) — SKY_PROXY=1 / SKY_HTTPS=1 (2026-10-04).

LATAR: di belakang proxy, SEMUA pengunjung tersambung dari 127.0.0.1. Dua akibatnya:
  • form instalasi pertama menganggap pengunjung dari internet "komputer server sendiri"
    dan tidak meminta kode instalasi → siapa pun yang lebih dulu membuka panel baru bisa
    menjadi administrator;
  • pembatas login per-IP menghitung semua orang sebagai satu alamat, dan Log mencatat
    127.0.0.1 untuk semua kejadian.

YANG DIJAGA:
  1. Mode proxy → instalasi pertama SELALU butuh kode.
  2. Alamat asli dibaca dari X-Real-IP / entri TERAKHIR X-Forwarded-For — hanya dalam mode
     proxy dan hanya bila soketnya loopback; tanpa mode proxy header itu diabaikan
     (klien tak bisa memalsukan alamatnya).
  3. Role selain administrator hanya membaca koleksi NBI yang dipakai panel.
  4. Sesi dicari sekali per permintaan.

DB sementara; GenieACS diarahkan ke port mati — tidak menyentuh produksi.
"""
import os, sys, json, tempfile, threading, http.client

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
for k in ('SKY_PROXY', 'SKY_HTTPS'):
    os.environ.pop(k, None)
import db, auth
TMP = tempfile.mkdtemp(prefix='skyproxy-')
auth.DATA_DIR = TMP
db.set_path(os.path.join(TMP, 'sky.db'))
db.init()
import config_store, server
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': 1, 'base_path': ''})     # port mati

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

KODE = auth.prepare_setup()
srv = server.buat_server('127.0.0.1', 0)
server.SPAHandler.log_message = lambda *a, **k: None
threading.Thread(target=srv.serve_forever, daemon=True).start()
PORT = srv.server_address[1]

def minta(metode, path, body=None, kepala=None, ck=None):
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=30)
    hd = {'Content-Type': 'application/json'}
    if ck: hd['Cookie'] = ck
    hd.update(kepala or {})
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=hd)
    r = c.getresponse(); raw = r.read(); sc = r.getheader('Set-Cookie'); c.close()
    try: d = json.loads(raw or b'{}')
    except Exception: d = {}
    return r.status, d, sc
def ip_terakhir(aksi):
    return db.audit_list(limit=1, action=aksi)[0]['ip_address']
ADMIN = {'name': 'Admin Proxy', 'email': 'a@contoh.id', 'username': 'admin.proxy', 'password': 'Admin#Proxy-2026'}
SALAH = {'username': 'tidak.ada', 'password': 'salah'}

try:
    # ══ 1. Tanpa mode proxy: perilaku lama, header diabaikan ══
    st, d, _ = minta('GET', '/auth/setup')
    ok(d == {'perlu': True, 'butuhKode': False}, 'tanpa proxy: dari komputer server sendiri tidak butuh kode instalasi')
    minta('POST', '/auth/login', SALAH, {'X-Real-IP': '203.0.113.9', 'X-Forwarded-For': '198.51.100.7'})
    ok(ip_terakhir('login.failed') == '127.0.0.1', 'tanpa mode proxy: X-Real-IP / X-Forwarded-For kiriman klien DIABAIKAN')
    auth.clear_failures('127.0.0.1', 'tidak.ada')

    # ══ 2. SKY_PROXY=1 ══
    os.environ['SKY_PROXY'] = '1'
    st, d, _ = minta('GET', '/auth/setup', kepala={'X-Real-IP': '203.0.113.9'})
    ok(d == {'perlu': True, 'butuhKode': True}, 'mode proxy: instalasi pertama SELALU butuh kode (soket loopback = lewat proxy = siapa saja)')
    st, d, _ = minta('POST', '/auth/setup', ADMIN, {'X-Real-IP': '203.0.113.9'})
    ok(st == 403 and auth.needs_setup(), 'mode proxy: instalasi tanpa kode ditolak — pengunjung pertama tidak bisa mengklaim administrator')
    ok(ip_terakhir('system.setup.denied') == '203.0.113.9', 'penolakan itu tercatat dengan alamat ASLI pengunjung')
    st, d, _ = minta('GET', '/auth/setup')          # nginx lupa mengirim header pun tetap butuh kode
    ok(d.get('butuhKode') is True, 'mode proxy tanpa header alamat (nginx salah setel): tetap butuh kode')

    minta('POST', '/auth/login', SALAH, {'X-Forwarded-For': '10.1.1.1, 198.51.100.7'})
    ok(ip_terakhir('login.failed') == '198.51.100.7', 'X-Forwarded-For: yang dipakai entri TERAKHIR (ditulis proxy), bukan kiriman klien')
    minta('POST', '/auth/login', SALAH, {'X-Real-IP': '198.51.100.7', 'X-Forwarded-For': '10.1.1.1, 198.51.100.7'})
    ok(ip_terakhir('login.failed') == '198.51.100.7', 'nginx contoh (X-Real-IP = entri terakhir X-Forwarded-For): alamat itu dipakai')
    # Caddy menulis X-Forwarded-For tetapi meneruskan X-Real-IP kiriman pengunjung; nginx yang
    # hanya menyetel X-Real-IP meneruskan X-Forwarded-For kiriman pengunjung. Bila keduanya
    # berbeda, salah satunya karangan → tak satu pun dipercaya.
    minta('POST', '/auth/login', SALAH, {'X-Real-IP': '203.0.113.50', 'X-Forwarded-For': '198.51.100.7'})
    ok(ip_terakhir('login.failed') == '127.0.0.1', 'X-Real-IP ≠ X-Forwarded-For (salah satunya kiriman pengunjung) → tak dipercaya, alamat soket')
    minta('POST', '/auth/login', SALAH, {'X-Real-IP': 'bukan-ip<script>'})
    ok(ip_terakhir('login.failed') == '127.0.0.1', 'isi header yang bukan alamat IP ditolak → alamat soket')
    minta('POST', '/auth/login', SALAH, {'X-Real-IP': 'bukan-ip', 'X-Forwarded-For': '10.1.1.1, 198.51.100.8'})
    ok(ip_terakhir('login.failed') == '198.51.100.8', 'satu header rusak, satu sah → yang sah dipakai')
    auth.clear_failures('127.0.0.1', 'tidak.ada')

    # pembatas per-IP memakai alamat asli: satu pengunjung nakal tidak mengunci yang lain
    for i in range(auth.LOGIN_MAX_PER_IP + 1):
        st, d, _ = minta('POST', '/auth/login', {'username': 'acak%d' % i, 'password': 'x'}, {'X-Real-IP': '203.0.113.77'})
    ok(st == 401 and 'Terlalu banyak' in d.get('error', ''), 'pengunjung yang terus gagal diblokir menurut alamat aslinya')
    st, d, _ = minta('POST', '/auth/login', {'username': 'orang.lain', 'password': 'x'}, {'X-Real-IP': '203.0.113.78'})
    ok(st == 401 and 'Terlalu banyak' not in d.get('error', ''), '… pengunjung lain (alamat berbeda) TIDAK ikut terkunci')

    st, d, sc = minta('POST', '/auth/setup', dict(ADMIN, code=KODE), {'X-Real-IP': '203.0.113.9'})
    ok(st == 200 and not auth.needs_setup(), 'dengan kode instalasi yang benar: administrator pertama dibuat')
    cka = sc.split(';')[0]
    ok('Secure' not in sc, 'SKY_PROXY saja (nginx tanpa TLS): cookie tanpa atribut Secure — login tetap jalan di HTTP')

    # ══ 3. SKY_HTTPS=1 juga berarti di belakang proxy ══
    del os.environ['SKY_PROXY']; os.environ['SKY_HTTPS'] = '1'
    ok(server._di_belakang_proxy() and minta('GET', '/auth/setup')[1].get('butuhKode') is True, 'SKY_HTTPS=1 (TLS di proxy) → juga mode proxy')
    st, d, sc = minta('POST', '/auth/login', {'username': ADMIN['username'], 'password': ADMIN['password']}, {'X-Real-IP': '203.0.113.9'})
    ok(st == 200 and 'Secure' in sc and ip_terakhir('login.success') == '203.0.113.9', 'SKY_HTTPS=1: cookie Secure, login tercatat dengan alamat asli')
    del os.environ['SKY_HTTPS']

    # ══ 4. Baca NBI: daftar-izin koleksi untuk selain administrator ══
    auth.create_user('teknisi.proxy', 'Teknisi#Proxy-2026', 'Teknisi', role='user')
    st, d, sc = minta('POST', '/auth/login', {'username': 'teknisi.proxy', 'password': 'Teknisi#Proxy-2026'})
    ckt = sc.split(';')[0]
    for kol in ('provisions', 'virtual_parameters', 'presets', 'files', 'objects', 'config'):
        st, d, _ = minta('GET', '/api/' + kol + '/', ck=ckt)
        ok(st == 403 and d.get('kode') == 'izin_role', 'role user tidak bisa membaca /api/%s (skrip & pengaturan ACS)' % kol)
    for kol in ('devices', 'tasks', 'faults'):
        ok(minta('GET', '/api/' + kol + '/', ck=ckt)[0] != 403, 'role user tetap membaca /api/%s' % kol)
    ok(minta('GET', '/api/provisions/', ck=cka)[0] != 403, 'administrator tidak dibatasi')

    # ══ 4b. Kueri baca: operator berbahaya ditolak server, untuk role apa pun (2026-10-04) ══
    import urllib.parse
    jahat = urllib.parse.quote('{"$where":"while(true){}"}')
    for nama, ck in (('role user', ckt), ('administrator', cka)):
        st, d, _ = minta('GET', '/api/tasks/?query=' + jahat, ck=ck)
        ok(st == 403 and d.get('kode') == 'kueri_terlarang' and d.get('pagar') is True,
           '%s: GET /api/tasks dengan $where ditolak pagar (bukan diteruskan ke GenieACS)' % nama)
    ok('$where' in db.audit_list(limit=1, action='acs_ditolak')[0]['detail'], 'penolakan kueri tercatat di Log')

    # ══ 4c. Halaman galat tombol Remote: teks dari ONU tampil sebagai TEKS ══
    import onu_proxy
    def halaman(path, ck):
        c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=30)
        c.request('GET', path, headers={'Cookie': ck})
        r = c.getresponse(); isi = r.read().decode('utf-8', 'replace'); kepala = dict(r.getheaders()); c.close()
        return r.status, isi, kepala
    # ONU nakal melaporkan ConnectionRequestURL berisi HTML; GenieACS menyimpannya apa adanya.
    asli_get = onu_proxy._http_get_json
    onu_proxy._http_get_json = lambda url: [{'InternetGatewayDevice': {'ManagementServer': {
        'ConnectionRequestURL': {'_value': '<img src=x onerror=alert(1)><script>alert(2)</script>'}}}}]
    onu_proxy._cache.clear()
    st, isi, kepala = halaman('/onu/AA-B-NAKAL/', cka)
    onu_proxy._http_get_json = asli_get
    ok(st == 502 and 'Alamat manajemen tidak dikenali' in isi, 'ONU dengan alamat manajemen aneh → halaman galat')
    ok('<img' not in isi and '<script' not in isi and '&lt;img src=x onerror=alert(1)&gt;' in isi,
       'alamat manajemen ber-HTML tampil sebagai teks (di-escape) — tidak menjadi skrip di sesi staf')
    ok("default-src 'none'" in kepala.get('Content-Security-Policy', '') and kepala.get('X-Content-Type-Options') == 'nosniff',
       'halaman galat Remote membawa CSP ketat (lapis kedua)')
    onu_proxy._cache.clear()
    st, isi, kepala = halaman('/onu/AA-B-SN1/', cka)         # NBI port mati → pesan memuat "<urlopen error …>"
    ok(st == 502 and '<urlopen' not in isi and '&lt;urlopen' in isi, 'pesan galat sistem yang memuat tanda < > juga di-escape')

    # ══ 5. Sesi dicari sekali per permintaan ══
    asli, hitung = auth.get_session_user, []
    auth.get_session_user = lambda tok: (hitung.append(1), asli(tok))[1]
    minta('POST', '/api/devices/AA-B-SN1/tasks?connection_request', {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice.LANDevice.1'}, ck=ckt)
    auth.get_session_user = asli
    ok(len(hitung) == 1, 'satu POST /api membaca sesi SEKALI (dulu 5–7 kali) — dapat %d' % len(hitung))
finally:
    srv.shutdown(); srv.server_close()

print(f'proxy: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
