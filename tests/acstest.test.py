#!/usr/bin/env python3
"""Uji "Test Connection" Koneksi ACS (PRD 5.1).

PRD menuntut kegagalan yang "informatif dan dapat dibedakan (connection
refused, timeout, host tidak ditemukan, response error, dsb.)". Satu pesan
"gagal" untuk semua kasus tidak memberi tahu operator apa pun — port salah,
firewall menelan paket, dan salah ketik nama host menuntut tindakan yang
berbeda.

Karena itu tiap mode kegagalan di sini DIBUAT SUNGGUHAN (soket nyata, server
nyata), bukan ditiru dengan mock. Mock hanya akan menguji bahwa saya bisa
menulis mock.
"""
import os, sys, json, time, socket, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import db, config_store

_tmp = tempfile.mkdtemp(prefix='skyacs-')
db.set_path(os.path.join(_tmp, 'sky.db'))

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def serve(handler_cls):
    port = free_port()
    srv = ThreadingHTTPServer(('127.0.0.1', port), handler_cls)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


def cfg(host='127.0.0.1', port=7557, proto='http', **kw):
    d = {'protocol': proto, 'host': host, 'port': port, 'base_path': ''}
    d.update(kw)
    return d


# ── Palsu: NBI GenieACS yang sehat ──
class FakeNBI(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps([{'_id': 'ONU-1'}]).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass


class Unauthorized(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(401); self.send_header('Content-Length', '0'); self.end_headers()
    def log_message(self, *a): pass


class NotFound(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers()
    def log_message(self, *a): pass


class ServerError(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(500); self.send_header('Content-Length', '0'); self.end_headers()
    def log_message(self, *a): pass


class HtmlPage(BaseHTTPRequestHandler):
    """Menjawab 200 tapi HTML — mis. UI GenieACS di port 3000, bukan NBI."""
    def do_GET(self):
        body = b'<html><title>GenieACS</title></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass


class BigNBI(BaseHTTPRequestHandler):
    """NBI yang menjawab JSON BESAR, seperti aslinya.

    REGRESI NYATA: GenieACS mengirim seluruh pohon parameter perangkat kecuali
    diminta sebaliknya — satu ONU F663NV9 = 228 KB. Versi pertama acs_test()
    membaca hanya 64 KB pertama lalu mem-parse-nya; JSON yang terpotong jelas
    gagal di-parse, sehingga GenieACS SEHAT dilaporkan "bukan NBI".

    Bug itu lolos dari seluruh tes ini karena FakeNBI menjawab JSON mungil, dan
    baru ketahuan saat diuji ke server produksi. Handler inilah yang menutup
    lubang itu: ia memeriksa BAIK bahwa panel meminta projection, MAUPUN bahwa
    jawaban besar tetap terbaca utuh.
    """
    def do_GET(self):
        # Hormati projection persis seperti GenieACS: kecil bila diminta,
        # raksasa bila tidak.
        if 'projection=_id' in self.path:
            payload = [{'_id': 'ONU-1'}]
        else:
            payload = [{'_id': 'ONU-1', 'InternetGatewayDevice':
                        {'p%d' % i: {'_value': 'x' * 200} for i in range(1200)}}]
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass


# ── Jawaban NBI yang besar TIDAK boleh salah dibaca sebagai "bukan NBI" ──
srv, port = serve(BigNBI)
r = config_store.acs_test(cfg(port=port))
ok(r['status'] == 'sukses',
   'NBI yang menjawab JSON besar tetap dikenali sukses (bukan "bukan-nbi") — regresi 228 KB')
ok(r['kind'] == 'ok', 'jawaban besar → kind=ok')
srv.shutdown()

# Panel HARUS meminta projection, bukan menarik seluruh pohon parameter hanya
# untuk menguji koneksi.
class ProjectionSpy(BaseHTTPRequestHandler):
    seen = []
    def do_GET(self):
        ProjectionSpy.seen.append(self.path)
        body = json.dumps([{'_id': 'x'}]).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

srv, port = serve(ProjectionSpy)
config_store.acs_test(cfg(port=port))
srv.shutdown()
ok(ProjectionSpy.seen and 'projection=_id' in ProjectionSpy.seen[0],
   'uji koneksi meminta projection=_id (41 byte, bukan 228 KB per ONU)')
ok(ProjectionSpy.seen and 'limit=1' in ProjectionSpy.seen[0],
   'uji koneksi meminta limit=1 (tidak menarik 1742 ONU)')

# ── SUKSES ──
srv, port = serve(FakeNBI)
r = config_store.acs_test(cfg(port=port))
ok(r['status'] == 'sukses', 'NBI sehat → sukses')
ok(r['kind'] == 'ok', 'jenis hasil = ok')
ok('HTTP 200' in r['message'], 'pesan sukses menyebut status HTTP (PRD: "info singkat dari response")')
ok('ms' in r['message'], 'pesan sukses menyebut waktu respons')
ok('1 perangkat' in r['message'], 'pesan sukses menyebut jumlah perangkat terbaca')
srv.shutdown()

# Hasil pengujian WAJIB tersimpan (PRD: simpan status, waktu, pesan)
saved = config_store.acs_get()
ok(saved['last_test_status'] == 'sukses', 'hasil uji tersimpan: status')
ok(saved['last_test_at'], 'hasil uji tersimpan: waktu')
ok('HTTP 200' in saved['last_test_message'], 'hasil uji tersimpan: pesan')

# ── CONNECTION REFUSED — port tertutup ──
closed = free_port()          # dibebaskan → tak ada yang mendengarkan
r = config_store.acs_test(cfg(port=closed))
ok(r['status'] == 'gagal', 'port tertutup → gagal')
ok(r['kind'] == 'refused', 'port tertutup dikenali sebagai "refused", bukan error umum')
ok('7557' in r['message'] or 'port' in r['message'].lower(),
   'pesan refused mengarahkan operator memeriksa port')

# ── DNS — host tidak ada ──
r = config_store.acs_test(cfg(host='host-yang-pasti-tidak-ada.invalid'))
ok(r['status'] == 'gagal', 'host tak dikenal → gagal')
ok(r['kind'] == 'dns', 'host tak dikenal dikenali sebagai "dns"')
ok('tidak ditemukan' in r['message'], 'pesan DNS menyebut host tidak ditemukan')

# ── TIMEOUT — soket menerima lalu diam ──
# Ini yang paling penting dibedakan dari "refused": refused berarti port salah,
# timeout hampir selalu berarti firewall menelan paket. Keduanya tampak sama
# bagi pengguna kalau pesannya digabung.
lst = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
lst.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
lst.bind(('127.0.0.1', 0))
lst.listen(1)
dead_port = lst.getsockname()[1]
t0 = time.time()
r = config_store.acs_test(cfg(port=dead_port), timeout=1)
elapsed = time.time() - t0
lst.close()
ok(r['status'] == 'gagal', 'server yang diam → gagal')
ok(r['kind'] == 'timeout', 'server yang diam dikenali sebagai "timeout", BUKAN "refused"')
ok(elapsed < 4, 'timeout dihormati (%.1fs) — tidak menggantung UI' % elapsed)

# ── HTTP 401/403 — kredensial ditolak ──
srv, port = serve(Unauthorized)
r = config_store.acs_test(cfg(port=port))
ok(r['kind'] == 'auth', 'HTTP 401 dikenali sebagai masalah kredensial')
ok('kredensial' in r['message'].lower(), 'pesan 401 mengarahkan ke kredensial NBI')
srv.shutdown()

# ── HTTP 404 — nyambung tapi bukan endpoint NBI ──
srv, port = serve(NotFound)
r = config_store.acs_test(cfg(port=port))
ok(r['kind'] == 'not-found', 'HTTP 404 dikenali terpisah')
ok('Base Path' in r['message'], 'pesan 404 mengarahkan memeriksa Base Path')
srv.shutdown()

# ── HTTP 500 ──
srv, port = serve(ServerError)
r = config_store.acs_test(cfg(port=port))
ok(r['kind'] == 'http', 'HTTP 500 dikenali sebagai response error')
ok('500' in r['message'], 'pesan menyebut kode HTTP-nya')
srv.shutdown()

# ── 200 tapi bukan NBI — jebakan paling halus ──
# Mengarahkan panel ke port 3000 (UI GenieACS) menjawab 200 OK. Kalau uji
# koneksi hanya melihat status HTTP, ia akan bilang "berhasil" lalu SELURUH
# panel diam-diam menunjuk ke alamat yang salah.
srv, port = serve(HtmlPage)
r = config_store.acs_test(cfg(port=port))
ok(r['status'] == 'gagal', 'HTTP 200 tapi HTML → TIDAK dianggap sukses')
ok(r['kind'] == 'bukan-nbi', 'jawaban non-JSON dikenali sebagai "bukan NBI"')
ok('7557' in r['message'], 'pesan mengingatkan NBI biasanya di port 7557')
srv.shutdown()

# ── Konfigurasi tak sah ditolak sebelum menyentuh jaringan ──
r = config_store.acs_test(cfg(proto='file'))
ok(r['kind'] == 'invalid', 'protokol tak sah ditolak tanpa permintaan jaringan')
r = config_store.acs_test(cfg(host='a b'))
ok(r['kind'] == 'invalid', 'host berspasi ditolak')

# Uji yang gagal karena config tak sah TIDAK boleh menimpa hasil uji tersimpan
before = config_store.acs_get()['last_test_status']
config_store.acs_test(cfg(proto='gopher'))
ok(config_store.acs_get()['last_test_status'] == before,
   'config tak sah tidak menimpa hasil uji terakhir yang sah')

# ── Auth NBI benar-benar dikirim ──
class NeedsAuth(BaseHTTPRequestHandler):
    def do_GET(self):
        got = self.headers.get('Authorization') or ''
        if got.startswith('Basic '):
            body = json.dumps([{'_id': 'ok'}]).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json')
        else:
            body = b''
            self.send_response(401)
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

srv, port = serve(NeedsAuth)
r = config_store.acs_test(cfg(port=port))
ok(r['kind'] == 'auth', 'tanpa kredensial → NBI berauth menolak')
r = config_store.acs_test(cfg(port=port, auth_enabled=True,
                              auth_username='admin', auth_secret='rahasia'))
ok(r['status'] == 'sukses', 'dengan kredensial → berhasil (Basic auth benar-benar dikirim)')
srv.shutdown()

# ── Kredensial NBI bersifat OPSIONAL (PRD 5.1: NBI default tanpa auth) ──
srv, port = serve(FakeNBI)
saved = config_store.acs_set(cfg(port=port))
ok(saved['auth_enabled'] is False, 'auth NBI mati secara default')
ok(config_store.acs_auth_header() is None, 'tanpa auth → tidak ada header Authorization dikirim')
r = config_store.acs_test(cfg(port=port))
ok(r['status'] == 'sukses', 'NBI tanpa auth tetap bisa diuji tanpa mengisi kredensial')
srv.shutdown()

# ── Menyimpan tanpa mengirim rahasia TIDAK boleh menghapus rahasia lama ──
config_store.acs_set(cfg(port=7557, auth_enabled=True,
                         auth_username='admin', auth_secret='rahasia-lama'))
config_store.acs_set(cfg(port=7558, auth_enabled=True, auth_username='admin'))
ok(config_store.acs_get(include_secret=True)['auth_secret'] == 'rahasia-lama',
   'ubah host tanpa mengisi ulang password TIDAK menghapus kredensial tersimpan')

# ── Mematikan auth membersihkan rahasia ──
config_store.acs_set(cfg(port=7557, auth_enabled=False))
ok(config_store.acs_get(include_secret=True)['auth_secret'] == '',
   'auth dimatikan → rahasia ikut dihapus (tak ada sisa kredensial menganggur)')

# ── Rahasia tak pernah bocor ke browser ──
config_store.acs_set(cfg(auth_enabled=True, auth_username='admin', auth_secret='sangat-rahasia'))
pub = config_store.acs_get()
ok('auth_secret' not in pub, 'acs_get() untuk browser TIDAK memuat rahasia')
ok(pub['auth_secret_set'] is True, 'browser hanya diberi tahu bahwa rahasianya ada')
ok('sangat-rahasia' not in json.dumps(pub), 'rahasia tidak bocor lewat field lain')

# ── build_url ──
ok(config_store.build_url(cfg()) == 'http://127.0.0.1:7557', 'URL dasar')
ok(config_store.build_url(cfg(proto='https', port=443)) == 'https://127.0.0.1:443', 'URL https')
ok(config_store.build_url(cfg(base_path='nbi')) == 'http://127.0.0.1:7557/nbi', 'URL dengan base path')
ok(config_store.build_url(cfg(base_path='/nbi/')) == 'http://127.0.0.1:7557/nbi',
   'base path dinormalkan (garis miring berlebih tidak menghasilkan // )')

# ── Host NBI di server LAIN (PRD 5.1: bukan hanya localhost) ──
srv, port = serve(FakeNBI)
saved = config_store.acs_set(cfg(host='localhost', port=port))
ok(saved['host'] == 'localhost', 'host selain 127.0.0.1 diterima (NBI boleh di mesin lain)')
ok(config_store.acs_url() == f'http://localhost:{port}', 'target proxy mengikuti host tersimpan')
r = config_store.acs_test(cfg(host='localhost', port=port))
ok(r['status'] == 'sukses', 'NBI di host terpisah bisa diuji')
srv.shutdown()

# ── Audit ──
acts = [e['action'] for e in db.audit_list(limit=200)]
ok('acs_connection.test' in acts, 'setiap uji koneksi tercatat di audit_log')
ok('acs_connection.update' in acts, 'setiap perubahan koneksi tercatat di audit_log')

print('acstest: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
