#!/usr/bin/env python3
"""
Panel ACS — SPA HTTP Server
Serves index.html for all non-asset routes so client-side routing
with the History API works correctly on page refresh.
Also proxies /api/* to GenieACS NBI at port 7557.

Usage:
    python3 server.py [port]   (default port: 8081)
"""

import os
import sys
import json
import time
import socket
import subprocess
import http.cookies
import urllib.request
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import db
import auth
import config_store
import masterdata
import odc as odc_mod
import onu_proxy
import acs_guard
import ops_lock
import antrean
import kesehatan

DIRECTORY    = os.path.dirname(os.path.abspath(__file__))
HOST         = '0.0.0.0'
PORT         = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
API_PREFIX   = '/api'
# Dapat ditimpa lewat SKY_CONFIG. Ini BUKAN kenyamanan: tanpa itu, tes yang
# memanggil POST /config menulis ke config.json ASLI — dan panel produksi
# 1742 ONU diam-diam diarahkan ulang ke host karangan milik tes. Sudah pernah
# terjadi di sini; isolasi tes tidak boleh bergantung pada tes yang "sopan".
CONFIG_PATH  = os.environ.get('SKY_CONFIG') or os.path.join(DIRECTORY, 'config.json')
CONFIG_PREFIX = '/config'
AUTH_PREFIX  = '/auth'
# Endpoint pengaturan hidup DI BAWAH /config, bukan di /settings.
#
# Ini bukan selera penamaan. '/settings' adalah ALAMAT HALAMAN SPA (lihat
# pageToPath di main.js). Memakai path yang sama untuk API berarti server
# menjawab JSON ketika pengguna me-refresh halaman Settings — navigasi di dalam
# aplikasi tampak baik-baik saja karena halaman dimuat lewat JS, jadi tabrakan
# ini hanya muncul saat Ctrl+R. Persis itu yang sempat terjadi.
#
# Rute SPA yang TIDAK BOLEH dipakai API: / /dashboard /devices /devices/<id>
# /maps /settings. Dijaga oleh tests/routes.test.py.
SETTINGS_PREFIX = '/config/'

# Status operasi ONU yang sedang berjalan. SENGAJA di luar /api/*: jalur itu
# diteruskan ke GenieACS, sedangkan ini murni milik panel — dan pengikut yang
# menanyakannya tidak boleh menyentuh ONU sama sekali.
OPS_PREFIX = '/ops/'

# Batas ukuran body: tanpa ini, satu POST raksasa bisa menghabiskan RAM server.
MAX_BODY = 256 * 1024


APP_VERSION = '1.1.0'
STARTED_TS  = time.time()
STARTED_AT  = time.strftime('%Y-%m-%dT%H:%M:%S')


# ═══════════════════════════════════════════════════════════════
#  Probe info sistem (untuk menu "Tentang Sistem")
#
#  Semua fungsi di bawah ini WAJIB mengembalikan '—' bila gagal, tidak boleh
#  melempar: menu "Tentang" yang membuat panel error 500 jauh lebih buruk
#  daripada satu baris versi yang tidak terbaca.
# ═══════════════════════════════════════════════════════════════
def _probe_cmd(cmd, timeout=3):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        v = (out.stdout or out.stderr).strip().splitlines()
        return v[0].strip() if v else None
    except Exception:
        return None


def _probe_pkg(name):
    """Versi paket npm global (GenieACS dipasang lewat npm)."""
    for base in ('/usr/lib/node_modules', '/usr/local/lib/node_modules'):
        p = os.path.join(base, name, 'package.json')
        try:
            with open(p) as f:
                return 'v' + json.load(f)['version']
        except Exception:
            continue
    return None


def _probe_mongo():
    """Versi MongoDB lewat protokol wire-nya sendiri.

    Sengaja tidak memanggil klien `mongo`/`mongosh`: keduanya sering tidak
    terpasang di server yang hanya menjalankan mongod. Perintah buildInfo di
    bawah adalah operasi baca murni.
    """
    v = _probe_cmd(['mongod', '--version'])
    if v and 'db version' in v:
        return v.split('db version')[-1].strip()
    return v or None


def _file_size(p):
    try:
        return os.path.getsize(p)
    except Exception:
        return 0


def _fmt_size(n):
    if not n:
        return '—'
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return f'{n:.0f} {unit}' if unit == 'B' else f'{n:.1f} {unit}'
        n /= 1024
    return f'{n:.1f} TB'


def _fmt_uptime(sec):
    sec = int(max(0, sec))
    d, sec = divmod(sec, 86400)
    h, sec = divmod(sec, 3600)
    m, _ = divmod(sec, 60)
    if d:
        return f'{d} hari {h} jam'
    if h:
        return f'{h} jam {m} menit'
    return f'{m} menit'


def _https_enabled():
    """Apakah panel benar-benar dilayani lewat HTTPS?

    Server ini sendiri HTTP polos. Setel SKY_HTTPS=1 HANYA bila ada TLS di
    depannya (nginx/Caddy) — flag itu menambahkan atribut `Secure` pada cookie
    sesi. Jangan disetel di HTTP polos: cookie-nya justru tak akan pernah
    terkirim dan login akan tampak "gagal terus".
    """
    return os.environ.get('SKY_HTTPS') == '1'

# Default config
_DEFAULT_CFG = {
    'acsUrl':             'http://127.0.0.1:7557',
    'acsUser':            '',
    'acsPass':            '',
    'refreshInterval':    60,
    'onlineThresholdMin': 10,
    'perPage':            20,
}

# ═══════════════════════════════════════════════════════════════
#  /config — lapisan kompatibilitas di atas SQLite
#
#  Sumber kebenaran kini tabel acs_connection_settings + app_parameters
#  (lihat config_store.py). Bentuk lama {acsUrl, perPage, ...} dipertahankan
#  agar klien & tes yang sudah ada tidak patah, tapi berkas config.json TIDAK
#  lagi dibaca saat melayani permintaan — hanya diimpor sekali saat start.
# ═══════════════════════════════════════════════════════════════
def load_config():
    """Bentuk lama, dirakit dari DB."""
    acs = config_store.acs_get()
    cfg = dict(_DEFAULT_CFG)
    cfg.update(config_store.params_get())
    cfg['acsUrl'] = acs['url']
    cfg['acsUser'] = acs.get('auth_username') or ''
    cfg['acsPass'] = ''            # rahasia tak pernah dikirim ke browser
    return cfg


def save_config(data, actor=None, ip=''):
    """Terima bentuk lama, tuliskan ke tabel yang benar."""
    if 'acsUrl' in data:
        parsed = urllib.parse.urlparse(str(data.get('acsUrl') or ''))
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            raise ValueError('acsUrl harus berupa URL http/https yang valid')
        config_store.acs_set({
            'protocol': parsed.scheme,
            'host': parsed.hostname,
            'port': parsed.port or (443 if parsed.scheme == 'https' else 7557),
            'base_path': (parsed.path or '').strip('/'),
            'auth_enabled': bool(data.get('acsUser')),
            'auth_username': data.get('acsUser') or '',
            'auth_secret': data.get('acsPass') or '',
        }, actor, ip)

    params = {k: data[k] for k in config_store.PARAM_SPEC if k in data}
    if params:
        config_store.params_set(params, actor, ip)
    return load_config()


def get_genieacs_url():
    # Dibaca dari DB tiap dipanggil: mengubah target ACS langsung berlaku,
    # tanpa restart server.
    return config_store.acs_url()

# File extensions that must be served as real static assets.
ASSET_EXTS = {
    '.html', '.css', '.js', '.json',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.map', '.txt',
}


class SPAHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    # ═══════════════════════════════════════════════════════════
    #  AUTENTIKASI
    # ═══════════════════════════════════════════════════════════
    def _client_ip(self):
        # Tanpa reverse proxy tepercaya di depan, X-Forwarded-For BOLEH DIPALSUKAN
        # klien — memakainya berarti penyerang tinggal mengarang IP baru tiap
        # percobaan dan rate limit per-IP jadi tak berguna. Pakai IP soket asli.
        return self.client_address[0]

    def _cookie(self, name):
        raw = self.headers.get('Cookie')
        if not raw:
            return None
        try:
            c = http.cookies.SimpleCookie(raw)
            return c[name].value if name in c else None
        except Exception:
            return None

    def _current_user(self):
        return auth.get_session_user(self._cookie(auth.SESSION_COOKIE))

    def _read_json(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            return None

    def _json(self, code, payload, cookie=None):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        origin = self.headers.get('Origin')
        # Kredensial dikirim lewat cookie, jadi '*' TIDAK boleh dipakai bersama
        # Allow-Credentials. Panel & API satu origin → cukup pantulkan origin-nya.
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Credentials', 'true')

    def _session_cookie(self, token, max_age=None):
        """Susun header Set-Cookie untuk sesi.

        max_age=None → COOKIE SESI (tanpa atribut Max-Age/Expires). Browser
        membuangnya begitu sesi browser berakhir — menutup jendela/keluar dari
        browser sudah menghapus kredensial, tidak menyisakannya di disk sampai
        kedaluwarsa. Ini setengah dari jawaban "tutup lalu buka lagi → login";
        setengah lainnya adalah idle-timeout pendek di sisi server (auth.py),
        yang menutup kasus tab-ditutup-tapi-browser-dipulihkan.

        max_age=0 → hapus cookie sekarang juga (dipakai saat logout).
        """
        parts = [
            f'{auth.SESSION_COOKIE}={token}',
            'Path=/',
        ]
        if max_age is not None:
            parts.append(f'Max-Age={max_age}')
        parts += [
            'HttpOnly',            # JS tak bisa membacanya → XSS tak bisa mencuri sesi
            'SameSite=Strict',     # cookie tak ikut pada request lintas-situs → CSRF tertutup
        ]
        # 'Secure' hanya bermakna di HTTPS. Panel ini HTTP polos, jadi flag itu
        # justru akan membuat cookie tak pernah terkirim. Lihat peringatan TLS.
        if _https_enabled():
            parts.append('Secure')
        return '; '.join(parts)

    def _handle_auth(self):
        path   = self.path.split('?')[0]
        method = self.command
        user   = self._current_user()

        # ── Login ──
        if path == AUTH_PREFIX + '/login' and method == 'POST':
            data = self._read_json() or {}
            try:
                u, token = auth.authenticate(
                    str(data.get('username') or ''), str(data.get('password') or ''),
                    self._client_ip(), self.headers.get('User-Agent', ''))
            except PermissionError as e:
                self._json(401, {'error': str(e)})
                return
            # Cookie sesi (tanpa Max-Age): dibuang saat browser ditutup. Batas
            # umur sesungguhnya ditegakkan di server (idle 30 mnt / absolut 12 jam).
            self._json(200, {'user': u},
                       cookie=self._session_cookie(token))
            return

        # ── Logout ──
        if path == AUTH_PREFIX + '/logout' and method == 'POST':
            auth.destroy_session(self._cookie(auth.SESSION_COOKIE))
            self._json(200, {'ok': True}, cookie=self._session_cookie('', 0))
            return

        # ── Siapa saya ──
        if path == AUTH_PREFIX + '/me' and method == 'GET':
            if not user:
                self._json(401, {'error': 'Belum login'})
                return
            self._json(200, {'user': user})
            return

        # ── Semua di bawah ini wajib login ──
        if not user:
            self._json(401, {'error': 'Belum login'})
            return

        # ── Daftar pengguna (hanya administrator) ──
        if path == AUTH_PREFIX + '/users' and method == 'GET':
            if not self._require_admin(user, 'melihat daftar pengguna'):
                return
            self._json(200, {'users': auth.list_users()})
            return

        # ── Buat pengguna (hanya administrator) ──
        if path == AUTH_PREFIX + '/users' and method == 'POST':
            if not self._require_admin(user, 'membuat pengguna baru'):
                return
            d = self._read_json() or {}
            try:
                u = auth.create_user(
                    str(d.get('username') or ''), str(d.get('password') or ''),
                    str(d.get('name') or ''), str(d.get('email') or ''),
                    str(d.get('phone') or ''), str(d.get('role') or 'user'),
                    str(d.get('status') or 'aktif'), actor=user, ip=self._client_ip())
            except ValueError as e:
                self._json(400, {'error': str(e)})
                return
            self._json(200, {'user': u})
            return

        # ── Riwayat audit (hanya administrator) ──
        if path == AUTH_PREFIX + '/audit' and method == 'GET':
            if not self._require_admin(user, 'melihat audit log'):
                return
            q = urllib.parse.parse_qs(self.path.split('?')[1]) if '?' in self.path else {}
            try:
                limit = max(1, min(500, int(q.get('limit', ['100'])[0])))
            except ValueError:
                limit = 100
            self._json(200, {'entries': db.audit_list(limit=limit,
                                                      action=(q.get('action') or [None])[0])})
            return

        # ── Ubah / hapus pengguna ──
        if path.startswith(AUTH_PREFIX + '/users/'):
            uid = path[len(AUTH_PREFIX + '/users/'):]
            try:
                if method in ('PATCH', 'POST'):
                    d = self._read_json() or {}
                    allowed = {k: d[k] for k in
                               ('name', 'username', 'email', 'phone', 'role', 'status',
                                'password', 'currentPassword')
                               if k in d}
                    self._json(200, {'user': auth.update_user(uid, allowed, user,
                                                              ip=self._client_ip())})
                    return
                if method == 'DELETE':
                    auth.delete_user(uid, user, ip=self._client_ip())
                    self._json(200, {'ok': True})
                    return
            except PermissionError as e:
                self._json(403, {'error': str(e)})
                return
            except ValueError as e:
                self._json(400, {'error': str(e)})
                return

        self._json(404, {'error': 'Endpoint tidak dikenal'})

    def _require_admin(self, user, what):
        """Pagar administrator + jejaknya.

        Menyembunyikan menu di UI BUKAN kontrol akses — endpoint tetap bisa
        dipanggil langsung (curl, DevTools). Di sinilah penolakan sebenarnya
        terjadi, dan percobaannya dicatat: kalau role `user` mengetuk pintu
        administrator, itu justru kejadian yang paling ingin diketahui.
        """
        if user.get('role') == 'administrator':
            return True
        db.audit('access.denied', f'percobaan {what} oleh role {user.get("role")}',
                 user, self._client_ip())
        self._json(403, {'error': 'Hanya administrator'})
        return False

    # ── Aset statis: WAJIB revalidasi ────────────────────────────
    # SimpleHTTPRequestHandler tidak mengirim Cache-Control sama sekali, sehingga
    # browser memakai *heuristic caching* (menebak masa berlaku dari Last-Modified):
    # makin lama sebuah file tak berubah, makin lama pula ia dipakai dari cache TANPA
    # menanyakan server. Akibatnya JS yang baru diperbarui bisa tetap versi lama walau
    # halaman di-reload — inilah yang membuat entri vendor baru (mis. CIOT) tak aktif
    # dan create WAN jatuh ke jalur generik. 'no-cache' TIDAK melarang cache, hanya
    # mewajibkan revalidasi tiap muat (304 Not Modified — tetap murah).
    # Dulu di sini ada pasangan send_head()/end_headers() kedua yang menyetel
    # Cache-Control 'no-cache, must-revalidate' untuk aset statis. Itu KODE MATI:
    # end_headers() didefinisikan lagi di bawah dalam kelas yang sama, dan di
    # Python definisi terakhir menggantikan yang sebelumnya — jadi versi ini
    # tidak pernah sekali pun dipanggil, walau komentarnya menjelaskan bug nyata
    # yang katanya diperbaikinya.
    #
    # Niatnya (JS/CSS wajib divalidasi ulang tiap muat) tetap tercapai, kebetulan:
    # end_headers() yang hidup mengirim 'no-store, no-cache, must-revalidate'
    # untuk apa pun yang bukan gambar/font — lebih kuat lagi. Satu definisi saja,
    # ada di dekat akhir kelas ini.

    # ── Jejak untuk pagar ────────────────────────────────────────
    def _potong(self, body, n=300):
        if not body:
            return ''
        try:
            return body.decode('utf-8', 'replace')[:n]
        except Exception:
            return ''

    def _catat_tolakan(self, tolakan, body):
        """Setiap penolakan meninggalkan jejak — termasuk yang datang dari luar
        UI. Penolakan yang senyap membuat pagar tak bisa dibedakan dari bug."""
        try:
            db.audit('acs_ditolak',
                     f"{tolakan['kode']} · {self.command} {self.path.split('?')[0]} "
                     f"· {tolakan['pesan']} · isi={self._potong(body)}",
                     actor=self._current_user(), ip=self._client_ip())
        except Exception:
            pass

    def _catat_reboot(self, body):
        if not body or b'reboot' not in body:
            return
        try:
            if json.loads(body.decode('utf-8')).get('name') != 'reboot':
                return
        except Exception:
            return
        try:
            db.audit('onu_reboot', self.path.split('?')[0],
                     actor=self._current_user(), ip=self._client_ip())
        except Exception:
            pass

    # ── Kunci operasi per-ONU ────────────────────────────────────
    def _device_id_task(self):
        """ID perangkat bila ini POST /api/devices/{id}/tasks — kalau bukan, None."""
        if self.command != 'POST':
            return None
        p = self.path.split('?')[0]
        if not p.startswith(API_PREFIX):
            return None
        bagian = [s for s in p[len(API_PREFIX):].split('/') if s]
        if len(bagian) == 3 and bagian[0] == 'devices' and bagian[2] == 'tasks':
            return urllib.parse.unquote(bagian[1])
        return None

    def _mulai_operasi(self, body):
        """None bila tak perlu dikunci, operasi bila boleh lanjut, False bila
        permintaan sudah dijawab (diikutkan atau ditolak)."""
        dev = self._device_id_task()
        if dev is None:
            return None
        try:
            tugas = json.loads(body.decode('utf-8')) if body else {}
        except Exception:
            tugas = {}
        user    = self._current_user() or {}
        pemilik = user.get('username') or '?'
        hasil, data = ops_lock.mulai(dev, pemilik, tugas)

        if hasil == 'mulai':
            return data

        if hasil == 'ikut':
            # Sengaja 200, bukan 429: bagi pemanggil ini BUKAN kegagalan —
            # pekerjaannya memang sedang dikerjakan, hanya oleh orang lain.
            # Yang penting: tidak ada task tambahan yang dikirim ke ONU.
            jawab = ops_lock.ringkas(data)
            jawab['diikutkan'] = True
            self._json(200, jawab)
            return False

        if hasil == 'istirahat':
            self._json(429, {
                'error': (f'ONU ini baru saja disegarkan. Tunggu {data} detik lagi — '
                          f'menyegarkan berulang tidak mempercepat ONU, hanya menambah '
                          f'beban CPU-nya.'),
                'kode': 'istirahat', 'sisaDetik': data, 'pagar': True})
            return False

        if hasil == 'penuh':
            self._json(429, {
                'error': (f'Sudah ada {data} operasi ONU berjalan bersamaan (batas '
                          f'{ops_lock.MAKS_SERENTAK}). Coba lagi sebentar.'),
                'kode': 'antre', 'berjalan': data, 'pagar': True})
            return False

        # 'sibuk' — perintah berbeda pada ONU yang sedang bekerja.
        jawab = ops_lock.ringkas(data)
        jawab.update({
            'error': (f'ONU ini sedang mengerjakan "{data["jenis"]}" atas permintaan '
                      f'{data["pemilik"]} ({jawab["sejakDtk"]} detik lalu). '
                      f'Tunggu sampai selesai.'),
            'kode': 'sibuk', 'pagar': True})
        self._json(429, jawab)
        return False

    def _tutup_operasi(self, op, state, kode):
        if not op:
            return
        try:
            ops_lock.selesai(op['opId'], state, {'status': kode})
        except Exception:
            pass

    def _handle_ops(self):
        """GET /ops/<opId> — dipakai pengikut untuk menunggu hasil operasi
        milik orang lain, tanpa mengirim apa pun ke ONU."""
        if not self._require_login():
            return
        op_id = self.path.split('?')[0][len(OPS_PREFIX):].strip('/')
        if op_id == '':
            self._json(200, ops_lock.keadaan())
            return
        op = ops_lock.status(op_id)
        if not op:
            self._json(404, {'error': 'Operasi tidak dikenal atau sudah lama selesai'})
            return
        self._json(200, ops_lock.ringkas(op))

    # ── Proxy helper ─────────────────────────────────────────────
    def _proxy(self):
        """Forward /api/... → GenieACS /..."""
        # Strip /api prefix, keep path + query string
        target = get_genieacs_url() + self.path[len(API_PREFIX):]
        content_length = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(content_length) if content_length > 0 else None

        # ── Pagar keselamatan ────────────────────────────────────
        # Satu-satunya tempat seluruh perintah panel bertemu sebelum sampai ke
        # ONU. Penjaga di browser (dialog konfirmasi, _adaTaskKembar,
        # _cekTipeNilai) tetap berguna untuk UX, tapi bisa dilewati dengan satu
        # curl — jadi kata terakhir ada di sini. Lihat acs_guard.py.
        tolakan = acs_guard.periksa(self.command, self.path, body,
                                    mode_aman=acs_guard.mode_aman_aktif())
        if tolakan:
            self._catat_tolakan(tolakan, body)
            self._json(tolakan['status'], {
                'error':  tolakan['pesan'],
                'kode':   tolakan['kode'],
                'pagar':  True,
            })
            return

        # Reboot sah, tetapi tidak boleh tanpa jejak: sampai hari ini satu-satunya
        # cara mengetahui siapa me-reboot ONU adalah menebak dari log CWMP.
        self._catat_reboot(body)

        # ── Kunci operasi per-ONU ────────────────────────────────
        # Satu ONU mengerjakan satu perintah pada satu waktu, siapa pun
        # pengirimnya. Peminta kedua dengan perintah SAMA diikutkan (tidak
        # menambah task ke ONU); perintah berbeda ditolak dengan alasannya.
        # Lihat ops_lock.py.
        op = self._mulai_operasi(body)
        if op is False:      # sudah dijawab (diikutkan / ditolak)
            return

        req = urllib.request.Request(target, data=body, method=self.command)
        ct  = self.headers.get('Content-Type', 'application/json')
        req.add_header('Content-Type', ct)
        # Kredensial NBI kini tersimpan di server (acs_connection_settings),
        # jadi tiap browser tak perlu lagi menyimpan sendiri. Header dari klien
        # tetap dihormati bila ada, demi kompatibilitas mundur.
        client_auth = self.headers.get('Authorization')
        if client_auth:
            req.add_header('Authorization', client_auth)
        else:
            try:
                h = config_store.acs_auth_header()
                if h:
                    req.add_header('Authorization', h)
            except Exception:
                pass

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
                self._tutup_operasi(op, 'selesai', resp.status)
                # 202 = ONU tak menjawab, task baru diantre. Dicatat agar tidak
                # berlaku mendadak berhari-hari kemudian — lihat antrean.py.
                if resp.status == 202:
                    dev = self._device_id_task()
                    if dev:
                        antrean.catat_dari_jawaban(
                            dev, body, data,
                            (self._current_user() or {}).get('username', ''))
                self.send_response(resp.status)
                self.send_header('Content-Type',
                                 resp.headers.get('Content-Type', 'application/json'))
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self._tutup_operasi(op, 'gagal', e.code)
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._tutup_operasi(op, 'gagal', 502)
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    # ── CORS pre-flight ───────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        # BUKAN '*': kredensial kini dikirim lewat cookie, dan '*' bersama
        # Allow-Credentials ditolak browser. Panel & API satu origin.
        self._cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    # ── /config endpoint (bentuk lama, kini di atas DB) ───────────
    def _handle_config_get(self):
        cfg = load_config()
        acs = config_store.acs_get()
        if acs.get('auth_secret_set'):
            cfg['acsPassSet'] = True
        data = json.dumps(cfg, indent=2).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def _handle_config_post(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length > MAX_BODY:
            self._json(413, {'error': 'Body terlalu besar'})
            return
        body = self.rfile.read(length)
        try:
            incoming = json.loads(body)
            cfg = save_config(incoming, self._current_user(), self._client_ip())
            data = json.dumps(cfg).encode()
            self.send_response(200)
        except Exception as e:
            data = json.dumps({'error': str(e)}).encode()
            self.send_response(400)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    # ── /settings — antarmuka baru (per-tabel, beraudit) ──────────
    # ═══ Master Data — OLT / PON / rasio tap coupler / PLC splitter ═══
    #
    # MEMBACA: siapa pun yang sudah login. Angka redaman bukan rahasia, dan
    # teknisi memerlukannya justru saat menelusuri jalur di lapangan.
    #
    # MENULIS: administrator saja. Satu angka redaman yang keliru di sini
    # diam-diam menghitung ulang SETIAP diagram ODC yang memakainya — salahnya
    # tidak terlihat sebagai galat, hanya sebagai angka yang berbeda.
    #
    # (Saat menu Hak Akses selesai, batas ini yang akan dibacanya. Sampai itu
    # ada, administrator adalah default yang aman.)
    _MASTER_SAVE = {
        'olt': masterdata.olt_save, 'pon': masterdata.pon_save,
        'tap': masterdata.tap_save, 'plc': masterdata.plc_save,
    }
    _MASTER_DELETE = {
        'olt': masterdata.olt_delete, 'pon': masterdata.pon_delete,
        'tap': masterdata.tap_delete, 'plc': masterdata.plc_delete,
    }

    def _handle_master(self, path, method, user, ip):
        rest = path[len('/config/master'):].strip('/')

        if method == 'GET' and not rest:
            self._json(200, masterdata.all_get())
            return

        parts = [p for p in rest.split('/') if p]
        jenis = parts[0] if parts else ''
        if jenis not in self._MASTER_SAVE:
            self._json(404, {'error': 'Jenis master data tidak dikenal'})
            return
        row_id = parts[1] if len(parts) > 1 else None

        if method not in ('POST', 'DELETE'):
            self._json(405, {'error': 'Metode tidak didukung'})
            return
        if not self._require_admin(user, 'mengubah Master Data'):
            return

        qs    = urllib.parse.parse_qs(self.path.partition('?')[2])
        force = qs.get('force', ['0'])[0] in ('1', 'true', 'ya')

        try:
            if method == 'POST':
                self._json(200, {'row': self._MASTER_SAVE[jenis](
                    self._read_json() or {}, user, ip, row_id)})
            else:
                if row_id is None:
                    self._json(400, {'error': 'ID wajib disertakan untuk menghapus'})
                    return
                self._json(200, self._MASTER_DELETE[jenis](row_id, user, ip, force))
        except masterdata.MasterDataError as e:
            # 409 = "ada yang terdampak, konfirmasikan dulu" — bukan 400, supaya
            # klien bisa membedakan isian yang salah dari penghapusan yang
            # butuh persetujuan, tanpa mencocokkan teks pesan.
            self._json(409 if e.impact else 400,
                       {'error': str(e), 'impact': e.impact})

    # ═══ Data ODC — topologi jalur kabel FTTH ═══
    #
    #   GET    /config/odc              daftar ODC + ringkasan kesehatannya
    #   GET    /config/odc/<id>         satu topologi, LENGKAP dengan hasil hitung
    #   POST   /config/odc[/<id>]       tambah / ubah ODC
    #   DELETE /config/odc/<id>         hapus (409 bila masih berisi node)
    #   POST   /config/odc/<id>/node[/<nid>]   tambah / ubah node
    #   DELETE /config/odc/<id>/node/<nid>     hapus node + turunannya
    #
    # Membaca terbuka untuk semua yang login; menulis administrator, sama
    # dengan Master Data — dan karena alasan yang sama.
    def _handle_odc(self, path, method, user, ip):
        parts = [p for p in path[len('/config/odc'):].strip('/').split('/') if p]
        qs    = urllib.parse.parse_qs(self.path.partition('?')[2])
        force = qs.get('force', ['0'])[0] in ('1', 'true', 'ya')

        try:
            if method == 'GET':
                if not parts:
                    self._json(200, {'items': odc_mod.list_get()})
                elif len(parts) >= 2 and parts[1] == 'slot':
                    self._json(200, {'slot': odc_mod.slot_kosong(parts[0])})
                else:
                    self._json(200, odc_mod.hitung(parts[0]))
                return

            if method not in ('POST', 'DELETE'):
                self._json(405, {'error': 'Metode tidak didukung'})
                return
            if not self._require_admin(user, 'mengubah Data ODC'):
                return

            body = self._read_json() or {}
            is_node = len(parts) >= 2 and parts[1] == 'node'

            if method == 'POST':
                if parts and len(parts) >= 2 and parts[1] == 'rapikan':
                    self._json(200, odc_mod.rapikan(parts[0], user, ip))
                elif is_node:
                    nid = parts[2] if len(parts) > 2 else None
                    # Menggeser kartu punya jalurnya sendiri: ia tidak boleh
                    # menyeret validasi rasio/sambungan, dan tidak dicatat audit.
                    if len(parts) > 3 and parts[3] == 'pos':
                        self._json(200, odc_mod.node_pos(parts[0], nid, body, user, ip))
                    elif len(parts) > 3 and parts[3] == 'pindah':
                        self._json(200, {'node': odc_mod.node_move(parts[0], nid, body, user, ip)})
                    else:
                        self._json(200, {'node': odc_mod.node_save(parts[0], body, user, ip, nid)})
                else:
                    self._json(200, {'odc': odc_mod.save(
                        body, user, ip, parts[0] if parts else None)})
                return

            if not parts:
                self._json(400, {'error': 'ID wajib disertakan untuk menghapus'})
                return
            if is_node:
                if len(parts) < 3:
                    self._json(400, {'error': 'ID node wajib disertakan'})
                    return
                self._json(200, odc_mod.node_delete(parts[0], parts[2], user, ip, force))
            else:
                self._json(200, odc_mod.delete(parts[0], user, ip, force))

        except odc_mod.OdcError as e:
            # 409 = "ada yang terdampak, konfirmasikan dulu"; 400 = isian salah.
            self._json(409 if e.impact else 400, {'error': str(e), 'impact': e.impact})

    def _handle_settings(self):
        path = self.path.split('?')[0]
        method = self.command
        user = self._current_user()
        if not user:
            self._json(401, {'error': 'Belum login'})
            return
        ip = self._client_ip()

        # Semua pengaturan sekaligus — dipakai saat boot untuk menyelaraskan
        # klien dengan server (sebelumnya klien tak pernah bertanya sama sekali).
        if path == '/config/all' and method == 'GET':
            self._json(200, {
                'params': config_store.params_get(),
                'display': config_store.display_get(user['id']),
                'acs': config_store.acs_get(),
                'isAdmin': user['role'] == 'administrator',
                # null = belum pernah disunting → panel memakai bawaan di
                # js/vpmap.js. Dikirim di sini supaya pemetaan sudah siap
                # sebelum tabel perangkat pertama digambar.
                'vpMapping': config_store.vp_get(),
            })
            return

        # ── Pemetaan VirtualParameter ────────────────────────────
        if path == '/config/vp-mapping' and method == 'GET':
            self._json(200, {'mapping': config_store.vp_get(),
                             'fields': list(config_store.VP_FIELDS),
                             'turunan': list(config_store.VP_TURUNAN),
                             'transformasi': list(config_store.VP_TRANSFORMASI)})
            return

        if path == '/config/vp-mapping' and method == 'POST':
            if not self._require_admin(user, 'mengubah Pemetaan Parameter'):
                return
            d = self._read_json() or {}
            try:
                hasil = config_store.vp_set(d.get('mapping'), user, ip)
            except ValueError as e:
                self._json(400, {'error': str(e)})
                return
            self._json(200, {'mapping': hasil})
            return

        # ── Mode aman ────────────────────────────────────────────
        # Sengaja endpoint sendiri, bukan bagian dari /config/params: ini
        # sakelar darurat, dan saat darurat orang tidak boleh perlu mengirim
        # seluruh formulir pengaturan hanya untuk menghentikan penulisan.
        if path == '/config/mode-aman' and method == 'GET':
            self._json(200, {
                'aktif':     acs_guard.mode_aman_aktif(),
                'dariEnv':   str(os.environ.get('SKY_READONLY', '')).strip() in ('1', 'true', 'yes'),
                'bisaUbah':  user['role'] == 'administrator',
            })
            return

        if path == '/config/mode-aman' and method == 'POST':
            if not self._require_admin(user, 'mengubah Mode Aman'):
                return
            data   = self._read_json() or {}
            aktif  = bool(data.get('aktif'))
            alasan = str(data.get('alasan') or '').strip()[:200]
            # Mematikan pagar wajib beralasan; menyalakannya tidak — dalam
            # keadaan darurat, mengetik alasan adalah hambatan yang salah.
            if not aktif and not alasan:
                self._json(400, {'error': 'Sebutkan alasan mematikan mode aman'})
                return
            acs_guard.set_mode_aman(aktif, actor=user, alasan=alasan)
            self._json(200, {'aktif': acs_guard.mode_aman_aktif()})
            return

        if path == '/config/params' and method == 'POST':
            if not self._require_admin(user, 'mengubah Parameter Aplikasi'):
                return
            try:
                self._json(200, {'params': config_store.params_set(
                    self._read_json() or {}, user, ip)})
            except ValueError as e:
                self._json(400, {'error': str(e)})
            return

        # Tampilan itu preferensi PRIBADI — tiap pengguna mengatur miliknya
        # sendiri, jadi sengaja tidak dibatasi administrator.
        if path == '/config/display' and method == 'POST':
            try:
                self._json(200, {'display': config_store.display_set(
                    self._read_json() or {}, user, ip)})
            except ValueError as e:
                self._json(400, {'error': str(e)})
            return

        if path == '/config/acs' and method == 'POST':
            if not self._require_admin(user, 'mengubah Koneksi ACS'):
                return
            try:
                self._json(200, {'acs': config_store.acs_set(
                    self._read_json() or {}, user, ip)})
            except ValueError as e:
                self._json(400, {'error': str(e)})
            return

        # Menguji koneksi = memaksa server menghubungi host pilihan pemanggil.
        # Itu SSRF bila dibiarkan terbuka, jadi khusus administrator.
        if path == '/config/acs/test' and method == 'POST':
            if not self._require_admin(user, 'menguji Koneksi ACS'):
                return
            self._json(200, config_store.acs_test(self._read_json() or {}, user, ip))
            return

        if path.startswith('/config/master'):
            self._handle_master(path, method, user, ip)
            return

        if path.startswith('/config/odc'):
            self._handle_odc(path, method, user, ip)
            return

        if path == '/config/about' and method == 'GET':
            self._json(200, self._about_info())
            return

        # Ringkasan fault, antrean, dan pagar (kesehatan.py). Murni baca —
        # boleh dibuka semua role, sesering apa pun.
        if path == '/config/kesehatan' and method == 'GET':
            self._json(200, kesehatan.kumpulkan(get_genieacs_url(),
                                                config_store.acs_auth_header()))
            return

        # Tombol "Bersihkan antrean lama": GET = daftar calon (murni baca),
        # POST = hapus id terpilih yang masih memenuhi kriteria. Menghapus task
        # milik alat lain adalah keputusan operator → khusus administrator.
        if path == '/config/kesehatan/bersihkan' and method == 'GET':
            try:
                self._json(200, kesehatan.calon_bersih(get_genieacs_url(),
                                                       config_store.acs_auth_header()))
            except Exception as e:
                self._json(502, {'error': f'Tidak bisa membaca GenieACS: {e}'})
            return

        if path == '/config/kesehatan/bersihkan' and method == 'POST':
            if not self._require_admin(user, 'membersihkan antrean GenieACS'):
                return
            data = self._read_json() or {}
            try:
                self._json(200, kesehatan.bersihkan(get_genieacs_url(),
                                                    config_store.acs_auth_header(),
                                                    data.get('ids') or [], user, ip))
            except Exception as e:
                self._json(502, {'error': f'Gagal membersihkan: {e}'})
            return

        # Apakah halaman admin ONU ini bisa dibuka? Dipakai UI untuk memutuskan
        # menampilkan tombol atau penjelasan — ~37% ONU memang tidak
        # mendengarkan di port 80, dan itu keadaan normal, bukan galat.
        if path.startswith('/config/onu-status/') and method == 'GET':
            device_id = urllib.parse.unquote(path[len('/config/onu-status/'):])
            try:
                host = onu_proxy.resolve_device(device_id, get_genieacs_url())
            except onu_proxy.OnuError as e:
                self._json(200, {'reachable': False, 'kind': e.kind, 'message': str(e)})
                return
            okey = onu_proxy.probe(host)
            self._json(200, {
                'reachable': okey,
                'host': host,
                'kind': 'ok' if okey else 'refused',
                'message': ('Halaman admin ONU siap dibuka.' if okey else
                            'Port 80 ke ONU ini tidak terjangkau. Perangkatnya '
                            'kemungkinan sehat — periksa aturan firewall untuk '
                            'blok alamatnya.'),
            })
            return

        self._json(404, {'error': 'Endpoint tidak dikenal'})

    # ── Routing sticky ONU lewat Referer ─────────────────────────
    def _onu_referer_id(self):
        """Segmen deviceId (MASIH ter-encode) bila permintaan ini datang DARI
        halaman ONU — dilihat dari header Referer. None bila bukan.

        KENAPA ada: sebagian panel admin ONU adalah SPA (mis. C-DATA berbasis
        Vue, webpack publicPath '/') yang memuat aset DAN memanggil API lewat
        path ABSOLUT dari root: '/js/app.js', '/css/app.css', '/boaform/...'.
        Path itu tak berawalan /onu/<id>/, jadi ia nyasar ke panel dan SPA-nya
        tak pernah hidup — persis kenapa C-DATA "tak bisa diremote", sementara
        ZTE F663 (path relatif) selamat.

        Router C-DATA hash-mode, jadi URL DOKUMEN tetap '/onu/<id>/...' dan tak
        pernah kehilangan prefiks; Referer tiap sub-permintaan pasti menunjuk ke
        situ. Itu yang kita pakai untuk mengembalikannya ke ONU yang benar.

        AMAN untuk panel: halaman panel sendiri TAK PERNAH ber-Referer /onu/,
        jadi aset & API panel tak mungkin ikut terbajak. Segmen id diambil apa
        adanya (tanpa unquote) supaya '%2D' pada id C-DATA tetap utuh — split_path
        yang akan meng-unquote-nya sekali, sama seperti alur /onu/ biasa.

        Logika parsing-nya murni & diuji di onu_proxy.referer_device_id()."""
        return onu_proxy.referer_device_id(self.headers.get('Referer') or '')

    def _maybe_onu_by_referer(self):
        """True bila permintaan ini ditangani sebagai sub-sumber ONU (via Referer).

        Jalur milik panel (/onu, /auth, /config, /api) TAK PERNAH dibajak — panel
        menanganinya sendiri seperti biasa."""
        p = self.path.split('?')[0]
        if (p.startswith(onu_proxy.PREFIX) or p.startswith(AUTH_PREFIX)
                or p.startswith(SETTINGS_PREFIX) or p == CONFIG_PREFIX
                or p.startswith(OPS_PREFIX)
                or self._is_api()):
            return False
        raw = self._onu_referer_id()
        if not raw:
            return False
        # GET (halaman & aset) → ALIHKAN ke /onu/<id><path> supaya alamatnya TETAP
        # berprefiks (2026-10-02, ZTE F6600P). Bila dilayani di tempat:
        #   • sesudah login dokumen berpindah ke '/' → Referer /onu/ hilang;
        #   • '/css/x.css' memuat '../img/y.png' → Referer-nya '/css/x.css', bukan
        #     /onu/ → gambar nyasar ke panel.
        # XHR (X-Requested-With) tetap dilayani di tempat: jalur itu sudah terbukti
        # bekerja untuk token/login, dan jawabannya tidak memuat sumber lain.
        xhr = (self.headers.get('X-Requested-With') or '').lower() == 'xmlhttprequest'
        if self.command == 'GET' and not xhr:
            self.send_response(302)
            self.send_header('Location', onu_proxy.PREFIX + raw + self.path)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return True
        # FORM POST (login web ONU) juga dialihkan — dengan 307 supaya metode & isi
        # ikut terkirim ulang. HWTC ZL-2113X (2026-10-03): form login mem-POST ke
        # '/cgi-bin/index2.asp'; dilayani di tempat, dokumen hasilnya beralamat
        # '/cgi-bin/index2.asp' (tanpa /onu/), lalu skripnya pindah ke
        # '/cgi-bin/content.asp' dengan Referer yang sudah bukan /onu/ → jatuh ke
        # beranda panel. Isi permintaan dibaca habis dulu agar sambungan tetap waras.
        if self.command == 'POST' and not xhr:
            n = int(self.headers.get('Content-Length') or 0)
            if n > 0:
                self.rfile.read(n)
            self.send_response(307)
            self.send_header('Location', onu_proxy.PREFIX + raw + self.path)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return True
        # Bentuk ulang jadi /onu/<id><path-asli> lalu tangani lewat jalur ONU.
        self.path = onu_proxy.PREFIX + raw + self.path
        self._handle_onu()
        return True

    # ── Proxy web UI ONU:  /onu/<deviceId>/...  ──────────────────
    def _handle_onu(self):
        """Teruskan permintaan ke halaman admin ONU.

        Ini menjadikan panel gerbang ke jaringan manajemen, jadi pagarnya ada
        di sini dan di onu_proxy.py — bukan di UI. Lihat catatan keamanan di
        onu_proxy.py sebelum mengubah apa pun.
        """
        user = self._current_user()
        if not user:
            # Bukan JSON: yang meminta path ini adalah <iframe>, dan operator
            # perlu melihat kalimat, bukan {"error": ...}.
            self._onu_error(401, 'Sesi berakhir', 'Silakan masuk kembali ke panel.')
            return

        # '../img/x.gif' dari halaman ONU → '/onu/img/x.gif': sisipkan lagi deviceId.
        diperbaiki = onu_proxy.escaped_path(self.path, self.headers.get('Referer') or '')
        if diperbaiki:
            self.path = diperbaiki

        device_id, tail = onu_proxy.split_path(self.path.split('?')[0])
        if not device_id:
            self._onu_error(400, 'Alamat tidak lengkap', 'Device ID tidak disebutkan.')
            return
        qs = self.path.split('?', 1)[1] if '?' in self.path else ''
        if qs:
            tail += '?' + qs

        try:
            host = onu_proxy.resolve_device(device_id, get_genieacs_url())
        except onu_proxy.OnuError as e:
            self._onu_error(e.status, 'Tidak bisa membuka ONU', str(e))
            return

        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n > 0 else None

        try:
            tls = onu_proxy.uses_tls(device_id)
            req, target = onu_proxy.build_request(
                device_id, host, tail, self.command, body, dict(self.headers), tls=tls)
            status, headers, data = onu_proxy.forward(req)
            # ONU yang web-nya HTTPS di port 80 (Huawei): HTTP polos hanya dibalas
            # halaman pengalih. Ingat perangkatnya, lalu ulangi permintaan lewat TLS.
            if not tls and self.command == 'GET' and onu_proxy.is_https_stub(status, data):
                onu_proxy.mark_tls(device_id)
                req, target = onu_proxy.build_request(
                    device_id, host, tail, self.command, body, dict(self.headers), tls=True)
                status, headers, data = onu_proxy.forward(req)
        except onu_proxy.OnuError as e:
            self._onu_error(e.status, 'Tidak bisa membuka ONU', str(e))
            return

        # Hanya pembukaan halaman utama yang dicatat; memuat tiap gambar/CSS
        # akan menenggelamkan audit log dalam derau.
        if tail.split('?')[0] in ('/', '/index.html'):
            onu_proxy.audit_open(device_id, host, user, self._client_ip())

        self.send_response(status)
        for k, v in onu_proxy.filter_response_headers(
                headers, device_id, host, auth.SESSION_COOKIE):
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def _onu_error(self, status, title, message):
        """Halaman galat untuk dilihat manusia di dalam iframe."""
        html = f'''<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<title>{title}</title><style>
body{{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;
background:#f6f9fc;color:#0f172a}}
.b{{max-width:420px;padding:28px;text-align:center}}
h1{{font-size:16px;margin:0 0 8px}}
p{{font-size:13px;line-height:1.6;color:#64748b;margin:0}}
.i{{font-size:32px;margin-bottom:12px}}
</style></head><body><div class="b"><div class="i">🔌</div>
<h1>{title}</h1><p>{message}</p></div></body></html>'''
        data = html.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _about_info(self):
        """Info sistem LANGSUNG dari mesin ini.

        Sebelumnya nilai-nilai ini ditulis tetap di HTML ("MongoDB v4.4.30",
        "Versi 1.0.0") — angka yang tak pernah berubah walau kenyataannya
        berubah, yang justru lebih berbahaya daripada tidak menampilkan apa pun.
        """
        import platform
        info = {
            'app': 'Panel ACS Sky Tech',
            'appVersion': APP_VERSION,
            'python': platform.python_version(),
            'platform': f'{platform.system()} {platform.release()}',
            'hostname': socket.gethostname(),
            'schema': db.schema_version(),
            'dbPath': db.DB_PATH,
            'dbSize': _fmt_size(_file_size(db.DB_PATH)),
            'startedAt': STARTED_AT,
            'uptime': _fmt_uptime(time.time() - STARTED_TS),
            'https': _https_enabled(),
            'acsUrl': config_store.acs_url(),
            'genieacs': '—',
            'mongodb': '—',
            'deviceCount': None,
        }
        try:
            info['users'] = db.conn().execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']
            info['sessions'] = db.conn().execute('SELECT COUNT(*) AS n FROM sessions').fetchone()['n']
        except Exception:
            pass
        # Versi GenieACS & MongoDB dibaca dari sistem, bukan ditebak.
        info['genieacs'] = _probe_cmd(['genieacs-cwmp', '--version']) or _probe_pkg('genieacs')
        info['mongodb'] = _probe_mongo()
        return info

    def _serve_index(self):
        """Serve index.html with cache-busting version injected into all JS/CSS URLs."""
        import time, re
        idx_path = os.path.join(DIRECTORY, 'index.html')
        try:
            with open(idx_path, 'r', encoding='utf-8') as f:
                html = f.read()
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        ts = str(int(time.time()))
        # Replace any existing ?v=... or inject fresh ?v=<timestamp> on all local JS/CSS
        html = re.sub(r'(src|href)="(/[^"]+\.(?:js|css))(?:\?[^"]*)?(")',
                      lambda m: f'{m.group(1)}="{m.group(2)}?v={ts}{m.group(3)}',
                      html)
        data = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.end_headers()
        self.wfile.write(data)

    def _require_login(self):
        """True bila permintaan boleh lanjut. INI penutup lubang utamanya:
        sebelum ini, siapa pun yang bisa menjangkau port panel dapat memanggil
        /api/* dan mengendalikan 1742 ONU tanpa kredensial apa pun."""
        if self._current_user():
            return True
        self._json(401, {'error': 'Belum login'})
        return False

    def _is_api(self):
        p = self.path.split('?')[0]
        return p.startswith(API_PREFIX + '/') or p == API_PREFIX

    def do_GET(self):
        if self.path.startswith(onu_proxy.PREFIX):
            self._handle_onu()
            return
        if self._maybe_onu_by_referer():
            return
        if self.path.split('?')[0].startswith(AUTH_PREFIX):
            self._handle_auth()
            return
        if self.path.split('?')[0].startswith(SETTINGS_PREFIX):
            self._handle_settings()
            return
        if self.path.split('?')[0].startswith(OPS_PREFIX):
            self._handle_ops()
            return
        if self.path == CONFIG_PREFIX:
            if not self._require_login():
                return
            self._handle_config_get()
            return
        if self._is_api():
            if not self._require_login():
                return
            self._proxy()
            return
        # Strip query string for path resolution, decode %20 etc.
        path    = urllib.parse.unquote(self.path.split('?')[0].split('#')[0])
        fs_path = os.path.join(DIRECTORY, path.lstrip('/'))
        _, ext  = os.path.splitext(fs_path)

        if path == '/' or path == '/index.html' or (ext.lower() not in ASSET_EXTS) or not os.path.isfile(fs_path):
            self._serve_index()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith(onu_proxy.PREFIX):
            self._handle_onu()
            return
        if self._maybe_onu_by_referer():
            return
        if self.path.split('?')[0].startswith(AUTH_PREFIX):
            self._handle_auth()
            return
        if self.path.split('?')[0].startswith(SETTINGS_PREFIX):
            self._handle_settings()
            return
        if self.path == CONFIG_PREFIX:
            if not self._require_login():
                return
            # Mengubah acsUrl = mengarahkan ulang proxy → hanya administrator.
            if not self._require_admin(self._current_user(), 'mengubah konfigurasi sistem'):
                return
            self._handle_config_post()
            return
        if self._is_api():
            if not self._require_login():
                return
            self._proxy()
            return
        self.send_response(405)
        self.end_headers()

    def do_PATCH(self):
        if self.path.startswith(onu_proxy.PREFIX):
            self._handle_onu()
            return
        if self._maybe_onu_by_referer():
            return
        if self.path.split('?')[0].startswith(AUTH_PREFIX):
            self._handle_auth()
            return
        self.send_response(405)
        self.end_headers()

    def do_DELETE(self):
        if self.path.startswith(onu_proxy.PREFIX):
            self._handle_onu()
            return
        if self._maybe_onu_by_referer():
            return
        if self.path.split('?')[0].startswith(AUTH_PREFIX):
            self._handle_auth()
            return
        # Master Data adalah CRUD pertama yang benar-benar butuh DELETE —
        # sebelum ini /config/ hanya dilayani lewat GET & POST.
        if self.path.split('?')[0].startswith(SETTINGS_PREFIX):
            self._handle_settings()
            return
        if self._is_api():
            if not self._require_login():
                return
            self._proxy()
            return
        self.send_response(405)
        self.end_headers()

    def log_message(self, fmt, *args):
        print(f'[{self.log_date_time_string()}] {self.address_string()} → {fmt % args}')

    def end_headers(self):
        """SATU-SATUNYA end_headers di kelas ini — lihat catatan di atas.

        Aset gambar/font di-cache 5 menit; sisanya (HTML, JS, CSS, API) wajib
        divalidasi ulang tiap muat. Tanpa itu browser memakai *heuristic
        caching* — menebak masa berlaku dari Last-Modified — sehingga JS yang
        baru diperbarui bisa tetap versi lama walau halaman di-reload.
        """
        # Proxy ONU dikecualikan: ONU sudah mengirim Cache-Control-nya sendiri
        # ('no-cache,no-store'), dan menambah punya kita menghasilkan header
        # ganda pada tiap permintaan. Perangkatnya yang paling tahu halamannya
        # boleh di-cache atau tidak.
        if not self.path.startswith(onu_proxy.PREFIX):
            path = urllib.parse.unquote(self.path.split('?')[0])
            _, ext = os.path.splitext(path)
            if ext.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.svg',
                               '.woff', '.woff2', '.ttf', '.otf', '.eot'}:
                self.send_header('Cache-Control', 'public, max-age=300')
            else:
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            # ── Header keamanan (hanya untuk respons panel sendiri) ──
            # Sengaja TIDAK dipasang pada /onu/: itu respons milik ONU yang
            # diteruskan apa adanya; menambah header di sini bisa berbentrokan
            # dengan header yang sudah dikirim perangkat (lihat catatan di atas).
            #
            #   nosniff       — browser tak boleh menebak-nebak tipe konten;
            #                   menutup serangan yang menyelundupkan skrip lewat
            #                   berkas yang seolah gambar/teks.
            #   SAMEORIGIN    — panel tak boleh dibingkai situs lain → menutup
            #                   clickjacking (halaman jebakan yang menumpuk klik
            #                   korban ke atas panel yang tak terlihat).
            #   no-referrer   — URL panel (yang memuat deviceId/serial) tak ikut
            #                   bocor ke situs luar saat pengguna mengeklik tautan
            #                   keluar seperti tombol registrasi di layar login.
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'SAMEORIGIN')
            self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()


if __name__ == '__main__':
    # DB dibuka & dimigrasi di sini, bukan saat permintaan pertama datang:
    # skema yang gagal harus menghentikan server sekarang, bukan muncul sebagai
    # error 500 acak di tengah jam kerja.
    db.init()
    auth.purge_expired_sessions()
    # config.json → tabel, sekali jalan. Tanpa ini, panel yang NBI-nya di mesin
    # lain akan diam-diam kembali menunjuk 127.0.0.1 setelah migrasi.
    config_store.import_legacy_config(CONFIG_PATH)

    # Akun pertama dibuat di sini, dengan password ACAK yang hanya tercetak
    # sekali. Bukan admin/admin — kredensial default yang bisa ditebak adalah
    # cara paling umum panel seperti ini dibobol.
    _boot_pw = auth.ensure_bootstrap()

    # Membatalkan task panel yang mengantre terlalu lama (antrean.py). Dimulai
    # di sini, bukan saat import: tes yang mengimpor server tidak boleh ikut
    # menjalankan thread yang menghapus task di NBI.
    antrean.mulai_penjaga(get_genieacs_url, config_store.acs_auth_header)

    server = ThreadingHTTPServer((HOST, PORT), SPAHandler)
    server.daemon_threads = True  # kill threads when main process exits
    print(f'SKY ACS server running at http://{HOST}:{PORT}/', flush=True)
    print(f'Database : {db.DB_PATH} (SQLite, skema v{db.schema_version()})', flush=True)
    print(f'API proxy: /api/* → {get_genieacs_url()}/*  (wajib login)', flush=True)

    if _boot_pw:
        # Password JUGA ditulis ke berkas, bukan sekadar dicetak.
        # Alasannya nyata: server ini dijalankan di latar dengan output
        # dialihkan ke log, dan stdout Python block-buffered saat bukan TTY —
        # sehingga cetakan tertahan di buffer dan password HILANG untuk
        # selamanya, padahal akunnya sudah terlanjur dibuat.
        pw_file = os.path.join(auth.DATA_DIR, 'FIRST_LOGIN.txt')
        try:
            os.makedirs(auth.DATA_DIR, exist_ok=True)
            with open(pw_file, 'w') as f:
                f.write(
                    'SKY ACS — kredensial administrator pertama\n'
                    '==========================================\n'
                    f'Username : admin\n'
                    f'Password : {_boot_pw}\n\n'
                    'Segera masuk, ganti password lewat Settings > Akun & Keamanan,\n'
                    'lalu HAPUS berkas ini.\n'
                )
            os.chmod(pw_file, 0o600)
        except Exception as e:
            print(f'  (gagal menulis {pw_file}: {e})', flush=True)

        print('\n' + '═' * 62, flush=True)
        print('  AKUN ADMINISTRATOR PERTAMA DIBUAT', flush=True)
        print('    Username : admin', flush=True)
        print(f'    Password : {_boot_pw}', flush=True)
        print(f'  Juga disimpan di: {pw_file}', flush=True)
        print('  Catat, ganti lewat Settings → Akun & Keamanan, lalu hapus', flush=True)
        print('  berkas tersebut.', flush=True)
        print('═' * 62, flush=True)

    if not _https_enabled():
        print('\n' + '!' * 62, flush=True)
        print('  PERINGATAN: panel dilayani lewat HTTP polos.', flush=True)
        print('  Password dan cookie sesi melintas sebagai TEKS TERANG, dan', flush=True)
        print('  siapa pun di jalur jaringan dapat menyadap lalu memakai ulang', flush=True)
        print('  sesi Anda. Hashing sekuat apa pun TIDAK menutup lubang ini —', flush=True)
        print('  hanya TLS/HTTPS yang bisa.', flush=True)
        print('  Pasang TLS (nginx/Caddy) di depan panel, lalu jalankan dengan', flush=True)
        print('  SKY_HTTPS=1 agar cookie sesi memakai atribut Secure.', flush=True)
        print('!' * 62, flush=True)
    print('\nPress Ctrl+C to stop.\n', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.', flush=True)
