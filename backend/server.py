#!/usr/bin/env python3
"""
Panel ACS — SPA HTTP Server
Serves index.html for all non-asset routes so client-side routing
with the History API works correctly on page refresh.
Also proxies /api/* to GenieACS NBI at port 7557.

Usage:
    python3 server.py [port]   (default port: 8081)
"""

import ipaddress
import os
import sys
import json
import re
import time
import socket
import ssl
import subprocess
import threading
import http.cookies
import urllib.request
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import db
import auth
import config_store
import masterdata
import odc as odc_mod
import tag as tag_mod
import pelanggan
import mitra
import onu_proxy
import acs_guard
import ops_lock
import antrean
import kesehatan
import logonu
import cadangan
import pembaruan

# Struktur (2026-10-03): backend/ = kode server, frontend/ = berkas yang disajikan ke
# browser, data/ = basis data. AKAR WEB sengaja frontend/ SAJA — berkas Python, data/,
# tests/, tools/ berada di luar akar web sehingga mustahil terlayani sebagai berkas statis.
AKAR_PROYEK  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIRECTORY    = os.path.join(AKAR_PROYEK, 'frontend')      # akar web
# SKY_HOST=127.0.0.1 → hanya bisa dibuka dari komputer ini (pasang reverse proxy ber-HTTPS
# di depannya untuk akses publik). Bawaan 0.0.0.0 = semua antarmuka, seperti sebelumnya.
HOST         = os.environ.get('SKY_HOST') or '0.0.0.0'
PORT         = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
API_PREFIX   = '/api'
# Dapat ditimpa lewat SKY_CONFIG. Ini BUKAN kenyamanan: tanpa itu, tes yang
# memanggil POST /config menulis ke config.json ASLI — dan panel produksi
# 1742 ONU diam-diam diarahkan ulang ke host karangan milik tes. Sudah pernah
# terjadi di sini; isolasi tes tidak boleh bergantung pada tes yang "sopan".
CONFIG_PATH  = os.environ.get('SKY_CONFIG') or os.path.join(AKAR_PROYEK, 'config.json')
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
# /maps /settings /log. Dijaga oleh tests/routes.test.py.
SETTINGS_PREFIX = '/config/'

# Status operasi ONU yang sedang berjalan. SENGAJA di luar /api/*: jalur itu
# diteruskan ke GenieACS, sedangkan ini murni milik panel — dan pengikut yang
# menanyakannya tidak boleh menyentuh ONU sama sekali.
OPS_PREFIX = '/ops/'

# Batas ukuran body: tanpa ini, satu POST raksasa bisa menghabiskan RAM server.
MAX_BODY = 256 * 1024


# Satu sumber: berkas VERSION di akar proyek. Tombol Update membandingkannya dengan
# VERSION di GitHub, jadi angka ini tidak boleh ditulis di dua tempat (pembaruan.py).
APP_VERSION = pembaruan.versi()
# Dipanggil sesudah pembaruan diterapkan. Variabel modul supaya uji bisa menggantinya —
# uji tidak boleh benar-benar mengganti proses yang sedang menjalankannya.
MULAI_ULANG = pembaruan.mulai_ulang
_kunci_update = threading.Lock()
STARTED_TS  = time.time()
STARTED_AT  = time.strftime('%Y-%m-%dT%H:%M:%S')
# Tanda pengenal PROSES yang sedang melayani. Sesudah tombol Update, browser menunggu
# tanda ini BERUBAH sebelum memuat ulang halaman. Membandingkan versi/commit tidak cukup
# (ditemukan saat uji nyata 2026-10-03): keduanya dibaca dari berkas, jadi proses LAMA
# pun sudah menjawab dengan angka baru selama 1,5 detik sebelum ia berganti — halaman
# dimuat ulang tepat saat panel sedang mati. Di Linux nomor proses tetap (exec), maka
# waktu mulainya ikut dipakai.
ID_PROSES   = '%d-%d' % (os.getpid(), int(STARTED_TS * 1000))


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


# ── HTTPS bawaan (2026-10-03) ──
# Password & cookie sesi yang melintas di HTTP polos bisa disadap siapa pun di jalur
# jaringan — hashing sekuat apa pun tak menolong. Dua cara menutupnya:
#   1. reverse proxy ber-HTTPS (Caddy/nginx) di depan panel + SKY_HTTPS=1, atau
#   2. panel melayani HTTPS SENDIRI bila sertifikat & kuncinya tersedia:
#        SKY_TLS_CERT / SKY_TLS_KEY (path berkas PEM), atau
#        data/tls/cert.pem + data/tls/key.pem  (buat dengan tools/buat_sertifikat.py).
# Tanpa berkas itu perilakunya tetap seperti dulu (HTTP polos + peringatan saat start).
TLS_CERT = os.environ.get('SKY_TLS_CERT') or os.path.join(AKAR_PROYEK, 'data', 'tls', 'cert.pem')
TLS_KEY  = os.environ.get('SKY_TLS_KEY')  or os.path.join(AKAR_PROYEK, 'data', 'tls', 'key.pem')
_TLS_AKTIF = False          # diisi buat_server() bila socket benar-benar dibungkus TLS


def _https_enabled():
    """Apakah panel benar-benar dilayani lewat HTTPS?

    True bila panel sendiri melayani TLS (buat_server), atau bila SKY_HTTPS=1 —
    setel itu HANYA bila ada TLS di depannya (nginx/Caddy). Flag ini menambahkan
    atribut `Secure` pada cookie sesi dan header HSTS. Jangan disetel di HTTP polos:
    cookie-nya justru tak akan pernah terkirim dan login akan tampak "gagal terus".
    """
    return _TLS_AKTIF or os.environ.get('SKY_HTTPS') == '1'


def _konteks_tls(cert, key):
    """SSLContext server: TLS 1.2+ saja, sertifikat & kunci dari berkas PEM."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    return ctx


class _PanelServer(ThreadingHTTPServer):
    """ThreadingHTTPServer yang tidak menumpahkan jejak galat penuh untuk koneksi rusak.

    Di HTTPS, setiap pemindai port, klien TLS lama yang ditolak, atau browser yang
    mengetik http:// ke port HTTPS menghasilkan galat jabat tangan — wajar, tapi dulu
    tiap kejadian mencetak traceback 20 baris dan menenggelamkan log yang penting."""
    def handle_error(self, request, client_address):
        e = sys.exc_info()[1]
        if isinstance(e, (ssl.SSLError, ConnectionError, socket.timeout, TimeoutError)):
            print(f'[koneksi] {client_address[0]}: {type(e).__name__}: {str(e)[:120]}', flush=True)
            return
        super().handle_error(request, client_address)


def buat_server(host=None, port=None, cert=None, key=None):
    """Server panel, ber-TLS bila sertifikat & kunci tersedia.

    Jabat tangan TLS sengaja TIDAK dilakukan saat accept() (do_handshake_on_connect=
    False): di sana ia berjalan di thread utama, dan satu klien yang tersambung tanpa
    mengirim apa pun akan menahan seluruh panel. Kini jabat tangan terjadi pada baca
    pertama, di thread milik permintaan itu sendiri (dibatasi SPAHandler.timeout)."""
    global _TLS_AKTIF
    cert = cert or TLS_CERT
    key  = key or TLS_KEY
    srv = _PanelServer((host or HOST, PORT if port is None else port), SPAHandler)
    srv.daemon_threads = True
    if os.path.isfile(cert) and os.path.isfile(key):
        srv.socket = _konteks_tls(cert, key).wrap_socket(
            srv.socket, server_side=True, do_handshake_on_connect=False)
        _TLS_AKTIF = True
    return srv

# Content-Security-Policy untuk halaman panel (bukan /onu/ — itu halaman milik ONU).
# Sumber luar HANYA dua CDN yang memang dipakai index.html (dikunci SRI di sana) dan
# Google Fonts. Mengubah daftar ini = menambah pihak yang bisa menjalankan kode di panel.
_CSP = '; '.join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
])

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
    # Batas waktu baca/tulis ke KLIEN (bukan ke NBI/ONU). Tanpa ini, klien yang tersambung
    # lalu diam — termasuk jabat tangan TLS yang tak pernah selesai — menahan satu thread
    # selamanya. 120 dtk jauh di atas permintaan normal mana pun.
    timeout = 120

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    # ── Isi permintaan yang belum dibaca ─────────────────────────
    # Banyak jawaban dikirim SEBELUM isi permintaan dibaca: 401 belum login, 403 bukan
    # administrator, 403 lintas-situs, 404. Server lalu menutup sambungan sementara isi
    # kiriman klien masih menunggu di soket — di Windows itu berakhir sebagai RST, dan
    # klien menerima "connection aborted" (WinError 10053) alih-alih jawaban 4xx-nya.
    # 2026-10-03 hal ini ditambal untuk isi kebesaran (_buang_body); 2026-10-04 muncul
    # lagi pada POST /config/cadangan/unduh yang ditolak (uji gagal ±1 dari 3 kali).
    # Kini berlaku umum: rfile menghitung byte yang sudah dibaca, dan _json() membuang
    # sisa isi permintaan sebelum menjawab.
    class _HitungBaca:
        def __init__(self, f):
            self._f, self.n = f, 0

        def read(self, *a):
            b = self._f.read(*a)
            self.n += len(b)
            return b

        def readline(self, *a):
            b = self._f.readline(*a)
            self.n += len(b)
            return b

        def __getattr__(self, k):
            return getattr(self._f, k)

    def setup(self):
        super().setup()
        self.rfile = SPAHandler._HitungBaca(self.rfile)

    def parse_request(self):
        ok = super().parse_request()
        self.rfile.n = 0            # baris permintaan & header selesai → yang dihitung hanya isi
        return ok

    def _habiskan_body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except (ValueError, AttributeError):
            return
        sisa = n - getattr(self.rfile, 'n', n)
        if sisa > 0:
            self._buang_body(sisa)

    # ═══════════════════════════════════════════════════════════
    #  AUTENTIKASI
    # ═══════════════════════════════════════════════════════════
    def _client_ip(self):
        # Tanpa reverse proxy tepercaya di depan, X-Forwarded-For BOLEH DIPALSUKAN
        # klien — memakainya berarti penyerang tinggal mengarang IP baru tiap
        # percobaan dan rate limit per-IP jadi tak berguna. Pakai IP soket asli.
        return self.client_address[0]

    def _dari_loopback(self):
        """Permintaan datang dari komputer tempat panel dijalankan (IP soket asli)."""
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

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
        if n <= 0:
            return None
        if n > MAX_BODY:
            self._buang_body(n)
            return None
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            return None

    def _buang_body(self, n):
        """Body kebesaran: baca lalu buang (sampai 4×MAX_BODY) sebelum menjawab galat.

        Bila server menjawab sementara klien masih mengirim, Windows memutus koneksi klien
        ("connection aborted", WinError 10053) — klien tak pernah menerima jawaban 4xx-nya
        (2026-10-03; inilah sebab uji server_auth gagal acak di Windows). Di atas 4×MAX_BODY
        tidak dibaca (itu sudah serangan, bukan salah kirim) dan koneksi ditutup."""
        if n > 4 * MAX_BODY:
            self.close_connection = True
            return
        sisa = n
        try:
            while sisa > 0:
                potong = self.rfile.read(min(sisa, 65536))
                if not potong:
                    break
                sisa -= len(potong)
        except OSError:
            self.close_connection = True

    def _json(self, code, payload, cookie=None):
        body = json.dumps(payload).encode('utf-8')
        self._habiskan_body()       # lihat catatan _HitungBaca di atas
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        """Sengaja TIDAK mengirim header CORS apa pun (2026-10-03).

        Panel & API-nya satu origin — browser tak butuh CORS untuk itu. Dulu Origin
        pemanggil dipantulkan begitu saja bersama Allow-Credentials: situs SEMBARANG
        boleh membaca jawaban API dengan sesi operator, sepanjang browser mengirim
        cookie-nya. SameSite=Strict menahan situs luar, tetapi tidak menahan origin
        "satu situs" — mis. port lain di alamat yang sama (UI GenieACS :3000). Kini
        origin lain tidak pernah diizinkan membaca; penjaga _tolak_lintas_situs()
        menolaknya bahkan sebelum diproses."""
        return

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
            self._json(200, {'user': self._dengan_izin(u)},
                       cookie=self._session_cookie(token))
            return

        # ── Instalasi pertama (lihat catatan di auth.py) ──
        if path == AUTH_PREFIX + '/setup' and method == 'GET':
            lokal = self._dari_loopback()
            self._json(200, {'perlu': auth.needs_setup(), 'butuhKode': not lokal})
            return

        if path == AUTH_PREFIX + '/setup' and method == 'POST':
            ip = self._client_ip()
            if not auth.needs_setup():
                self._json(409, {'error': 'Panel sudah punya akun administrator. Silakan masuk.'})
                return
            data = self._read_json() or {}
            if not self._dari_loopback():
                # Dari komputer lain: wajib kode instalasi, dan tebakannya dibatasi
                # dengan pembatas yang sama seperti login.
                if auth.login_blocked(ip, '__setup__')[0]:
                    self._json(429, {'error': 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.'})
                    return
                if not auth.setup_code_ok(data.get('code')):
                    auth.record_failure(ip, '__setup__')
                    db.audit('system.setup.denied', 'kode instalasi salah', None, ip)
                    self._json(403, {'error': 'Kode instalasi salah. Lihat terminal server atau berkas data/SETUP_CODE.txt.'})
                    return
            username = str(data.get('username') or '')
            password = str(data.get('password') or '')
            try:
                auth.setup_first_admin(username, password, str(data.get('name') or ''),
                                       str(data.get('email') or ''), ip)
                u, token = auth.authenticate(username, password, ip, self.headers.get('User-Agent', ''))
            except PermissionError as e:
                self._json(409, {'error': str(e)})
                return
            except ValueError as e:
                self._json(400, {'error': str(e)})
                return
            self._json(200, {'user': self._dengan_izin(u)}, cookie=self._session_cookie(token))
            return

        # ── Logout ──
        if path == AUTH_PREFIX + '/logout' and method == 'POST':
            if user:
                db.audit('logout', f'username={user.get("username")}', user, self._client_ip())
            auth.destroy_session(self._cookie(auth.SESSION_COOKIE))
            self._json(200, {'ok': True}, cookie=self._session_cookie('', 0))
            return

        # ── Siapa saya ──
        if path == AUTH_PREFIX + '/me' and method == 'GET':
            if not user:
                self._json(401, {'error': 'Belum login'})
                return
            self._json(200, {'user': self._dengan_izin(user)})
            return

        # ── Semua di bawah ini wajib login ──
        if not user:
            self._json(401, {'error': 'Belum login'})
            return

        # ── Daftar pengguna (administrator, atau role yang diberi izin MELIHAT) ──
        # Izin "manajemenAkun" membuka daftar ini. Membuat/mengubah/menghapus akun butuh
        # izin kelola akun (config_store.kelola_akun: aksi + role sasaran, dicentang
        # administrator) dan TIDAK PERNAH menjangkau akun administrator — kalau bisa,
        # pemegang izin tinggal mengangkat dirinya sendiri jadi administrator.
        kelola = lambda aksi, role: config_store.kelola_akun(user, aksi, role)
        if path == AUTH_PREFIX + '/users' and method == 'GET':
            if not self._izin(user, 'manajemenAkun', 'melihat daftar pengguna'):
                return
            ikatan = mitra.semua_ikatan()
            jumlah = {t['nama']: t['jumlah'] for t in tag_mod.daftar()}
            self._json(200, {
                'users': [dict(u, tagMitra=ikatan.get(u['id'], ''), tagJumlah=jumlah.get(ikatan.get(u['id'], ''), 0))
                          for u in auth.list_users()],
                # Role yang boleh dibuat/diubah/dihapus pemanggil — untuk menggambar tombol.
                'kelola': {a: [r for r in auth.ROLES if kelola(a, r)] for a in ('buat', 'ubah', 'hapus')}})
            return

        # ── Buat pengguna (administrator, atau role yang diberi izin kelola akun) ──
        if path == AUTH_PREFIX + '/users' and method == 'POST':
            d = self._read_json() or {}
            if not isinstance(d, dict):
                d = {}
            if not kelola('buat', str(d.get('role') or 'user')):
                db.audit('access.denied', f'percobaan membuat akun ber-role {str(d.get("role") or "user")[:20]} '
                         f'oleh role {user.get("role")}', user, self._client_ip())
                self._json(403, {'error': 'Anda tidak diizinkan membuat akun dengan role itu'})
                return
            try:
                u = auth.create_user(
                    str(d.get('username') or ''), str(d.get('password') or ''),
                    str(d.get('name') or ''), str(d.get('email') or ''),
                    str(d.get('phone') or ''), str(d.get('role') or 'user'),
                    str(d.get('status') or 'aktif'), actor=user, ip=self._client_ip())
                # Akun mitra langsung terikat pada tag: yang dipilih di form, atau
                # MITRA-<USERNAME> (dibuat bila belum ada).
                if u.get('role') == mitra.ROLE:
                    nama = (mitra.atur_tag(u, d.get('tag'), user, self._client_ip()) if d.get('tag')
                            else mitra.ikat(u, user, self._client_ip()))
                    u = dict(u, tagMitra=nama)
            except ValueError as e:
                self._json(400, {'error': str(e)})
                return
            self._json(200, {'user': u})
            return

        # ── Riwayat audit (hanya administrator) ──
        if path == AUTH_PREFIX + '/audit' and method == 'GET':
            # Administrator selalu; role lain bila diberi izin menu Log. Tanpa izin
            # `logSemua` yang terlihat HANYA aktivitas akunnya sendiri — saringan akun
            # dipaksa server, apa pun yang dikirim browser.
            if not self._izin(user, 'menuLog', 'melihat audit log'):
                return
            sendiri = not config_store.izin_punya(user, 'logSemua')
            q = urllib.parse.parse_qs(self.path.split('?')[1]) if '?' in self.path else {}
            satu = lambda k: (q.get(k) or [''])[0].strip()[:120]
            try:
                limit = max(1, min(500, int(satu('limit') or 100)))
                sebelum = int(satu('sebelum')) if satu('sebelum') else None
            except ValueError:
                limit, sebelum = 100, None
            if satu('action') and not sendiri:      # bentuk lama: satu nama aksi persis
                self._json(200, {'entries': db.audit_list(limit=limit, action=satu('action'))})
                return
            role = satu('role')
            if role not in auth.ROLES + (db.LOG_ROLE_KOSONG,):
                role = None
            akun = user.get('username') if sendiri else (satu('akun') or None)
            baris, lagi = db.audit_cari(role=None if sendiri else role, akun=akun,
                                        kategori=satu('kategori') or None, q=satu('q') or None,
                                        sebelum=sebelum, limit=limit)
            jawab = {'entries': baris, 'adaLagi': lagi, 'sendiri': sendiri}
            if sebelum is None:     # halaman pertama: sekalian isi saringan "nama akun"
                jawab['akun'] = ([{'username': user.get('username'), 'role': user.get('role')}]
                                 if sendiri else db.audit_akun())
            self._json(200, jawab)
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
                    sebelum = auth.get_by_id(uid) or {}
                    u = auth.update_user(uid, allowed, user, ip=self._client_ip(), kelola=kelola)
                    # Ikatan tag mengikuti role. `tag` di badan permintaan = pasang / ganti /
                    # lepas ('' = lepas) — HANYA dari yang berwenang mengubah akun mitra dan
                    # bukan terhadap akunnya sendiri: mitra yang bisa mengganti tagnya sendiri
                    # tinggal mengambil ONU mitra lain.
                    if u.get('role') != mitra.ROLE:
                        mitra.lepas(u['id'])
                    elif 'tag' in d and uid != user.get('id') and kelola('ubah', mitra.ROLE):
                        mitra.atur_tag(u, d.get('tag'), user, self._client_ip())
                    elif sebelum.get('role') != mitra.ROLE:
                        mitra.ikat(u, user, self._client_ip())      # baru saja menjadi mitra
                    self._json(200, {'user': self._dengan_izin(u)})
                    return
                if method == 'DELETE':
                    auth.delete_user(uid, user, ip=self._client_ip(), kelola=kelola)
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

    def _izin(self, user, kunci, what):
        """Pagar hak akses per sub-menu Settings (2026-10-03) — lihat config_store.IZIN_KUNCI.

        Administrator selalu lolos; role lain hanya bila administrator membuka menu itu
        untuknya. Sama seperti _require_admin: penolakan dicatat, sebab menu yang
        tersembunyi tetap bisa dipanggil langsung lewat curl/DevTools.
        """
        if config_store.izin_punya(user, kunci):
            return True
        db.audit('access.denied', f'percobaan {what} tanpa izin "{kunci}" oleh role {user.get("role")}',
                 user, self._client_ip())
        self._json(403, {'error': 'Anda belum diberi akses ke menu ini. Minta administrator '
                                  'membukanya di Settings → Manajemen Akun.'})
        return False

    @staticmethod
    def _dengan_izin(u):
        """Data pengguna untuk browser + daftar izinnya, supaya menu Settings bisa langsung
        dirapikan begitu login tanpa permintaan tambahan. Hanya kerapian: pagarnya _izin()."""
        return dict(u, izin=config_store.izin_user(u)) if u else u

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
    def _catat_tolakan(self, tolakan, body):
        """Setiap penolakan meninggalkan jejak — termasuk yang datang dari luar
        UI. Penolakan yang senyap membuat pagar tak bisa dibedakan dari bug.

        Isi permintaan dicatat TANPA nilainya (logonu.isi_tanpa_nilai): dulu potongan
        mentahnya ikut, sehingga password yang hendak ditulis masuk ke catatan."""
        try:
            db.audit('acs_ditolak',
                     f"{tolakan['kode']} · {self.command} {self.path.split('?')[0]} "
                     f"· {tolakan['pesan']} · permintaan: {logonu.isi_tanpa_nilai(body)}",
                     actor=self._current_user(), ip=self._client_ip())
        except Exception:
            pass

    # Refresh yang sudah dicatat: (username, deviceId) → waktu. Satu klik Refresh mengirim
    # beberapa refreshObject (Hosts, WLANConfiguration, akar…); tanpa ini satu klik
    # menjadi tiga baris Log dan catatan yang penting tenggelam.
    _refresh_tercatat = {}
    JEDA_CATAT_REFRESH = 60

    def _catat_onu(self, jejak, status):
        """Tulis satu operasi ONU ke audit SESUDAH GenieACS menjawab (menu Log).

        jejak = hasil logonu.uraikan(); None = tidak dicatat (perintah baca).
        Dulu hanya reboot yang dicatat ('onu_reboot'), sebelum dikirim dan tanpa hasilnya —
        sehingga reboot yang ditolak kunci operasi pun tertulis seolah terjadi."""
        if not jejak:
            return
        try:
            aksi, dev, uraian = jejak
            user = self._current_user()
            if aksi == 'onu.refresh':
                kunci, kini = ((user or {}).get('username'), dev), time.time()
                tercatat = SPAHandler._refresh_tercatat
                if kini - tercatat.get(kunci, 0) < self.JEDA_CATAT_REFRESH:
                    return
                if len(tercatat) > 2000:        # buang yang lama, jangan tumbuh selamanya
                    for k in [k for k, t in list(tercatat.items()) if kini - t > self.JEDA_CATAT_REFRESH]:
                        tercatat.pop(k, None)
                tercatat[kunci] = kini
            db.audit(aksi, uraian.replace('{onu}', 'ONU ' + pelanggan.sn_dari_id(dev))
                     + ' — ' + logonu.hasil(status), actor=user, ip=self._client_ip())
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
        milik = mitra.lingkup(self._current_user())
        if op_id == '':
            k = ops_lock.keadaan()
            if milik is not None:
                k['berjalan'] = [o for o in k['berjalan'] if o.get('perangkat') in milik]
                k['istirahat'] = {d: s for d, s in k['istirahat'].items() if d in milik}
            self._json(200, k)
            return
        op = ops_lock.status(op_id)
        if not op or (milik is not None and op.get('perangkat') not in milik):
            self._json(404, {'error': 'Operasi tidak dikenal atau sudah lama selesai'})
            return
        self._json(200, ops_lock.ringkas(op))

    # ── Pagar peran untuk /api (2026-10-04) ───────────────────────
    # Izin yang dibutuhkan tiap JENIS perintah (logonu.jenis). 'baca' (GET, refresh,
    # getParameter*) selalu boleh bagi yang punya menu Dashboard/Device. Jenis yang tidak
    # dikenali ('lain') butuh SEMUA izin aksi: lebih baik menolak daripada meloloskan
    # perintah yang tidak dipahami pagar ini.
    _IZIN_JENIS = {'reboot': 'aksiReboot', 'hapus': 'aksiHapus', 'wan': 'aksiWan', 'ubah': 'aksiWan',
                   'wifi': 'aksiSsid', 'akunweb': 'aksiSetting', 'bersih': 'aksiSetting'}
    _NAMA_JENIS = {'reboot': 'me-reboot ONU', 'hapus': 'menghapus ONU', 'wan': 'mengubah WAN',
                   'ubah': 'mengubah pengaturan ONU', 'wifi': 'mengubah WiFi',
                   'akunweb': 'mengubah akun web ONU', 'bersih': 'menghapus fault/antrean',
                   'lain': 'menjalankan perintah ini'}
    _saring_mitra = None

    def _pagar_peran(self, body):
        """True (403 sudah terkirim) bila role pemanggil tidak berhak atas permintaan /api ini.

        Tiga lapis, semuanya untuk role selain administrator (pelanggan punya pagarnya
        sendiri di _handle_pel dan tidak pernah sampai ke sini lewat /api):
          1. menu    — tanpa menu Dashboard maupun Device, data ONU tertutup; perintah tulis
                       butuh menu Device;
          2. aksi    — reboot / hapus / WAN / WiFi / Setting sesuai centang administrator;
          3. lingkup — mitra tanpa `onuSemua` hanya menyentuh ONU bertag miliknya: perintah
                       ke ONU lain ditolak, dan daftar yang dibacanya disaring (mitra.py).
        """
        self._saring_mitra = None
        user = self._current_user()
        if not isinstance(user, dict) or user.get('role') in ('administrator', pelanggan.ROLE):
            return False
        izin = set(config_store.izin_user(user))
        jalur = self.path[len(API_PREFIX):]

        def tolak(apa):
            db.audit('access.denied', f'role {user.get("role")} tidak diizinkan {apa} · '
                     f'{self.command} {jalur.split("?")[0][:120]}', user, self._client_ip())
            self._json(403, {'error': 'Akun Anda tidak diizinkan ' + apa + '.', 'pagar': True, 'kode': 'izin_role'})
            return True

        if not ({'menuDashboard', 'menuDevice'} & izin):
            return tolak('membuka data ONU')
        jenis = logonu.jenis(self.command, jalur, body)
        tulis = jenis - {'baca'}
        if tulis and 'menuDevice' not in izin:
            return tolak('mengirim perintah ke ONU')
        for j in sorted(tulis):
            butuh = self._IZIN_JENIS.get(j)
            if butuh is None:
                if not all(k in izin for k in set(self._IZIN_JENIS.values())):
                    return tolak(self._NAMA_JENIS['lain'])
            elif butuh not in izin:
                return tolak(self._NAMA_JENIS[j])

        milik = mitra.lingkup(user)
        if milik is None:
            return False
        bagian = [urllib.parse.unquote(x) for x in jalur.split('?')[0].split('/') if x]
        koleksi = bagian[0] if bagian else ''
        if self.command == 'GET':
            # Hanya tiga koleksi berbentuk larik yang bisa disaring per ONU.
            if koleksi not in ('devices', 'tasks', 'faults') or len(bagian) != 1:
                return tolak('membuka data ini')
            self._saring_mitra = (koleksi, milik)
            return False
        if koleksi == 'devices' and len(bagian) >= 2:
            sasaran = bagian[1]
        elif koleksi == 'faults' and len(bagian) == 2:
            sasaran = mitra.id_dari_fault(bagian[1])
        elif koleksi == 'tasks' and len(bagian) == 2:
            # Task hanya bisa dipastikan pemiliknya bila tercatat di antrean panel.
            r = db.conn().execute('SELECT device_id FROM task_antre WHERE task_id = ?', (bagian[1],)).fetchone()
            sasaran = r['device_id'] if r else None
        else:
            sasaran = None
        if sasaran not in milik:
            return tolak('menyentuh ONU di luar ONU mitra Anda')
        return False

    # ── Proxy helper ─────────────────────────────────────────────
    def _proxy(self, body=None):
        """Forward /api/... → GenieACS /...

        `body` diisi oleh portal pelanggan (_handle_pel): perintah yang DISUSUN server
        dikirim lewat jalur yang sama persis — pagar acs_guard, kunci ops_lock, antrean."""
        # Strip /api prefix, keep path + query string
        target = get_genieacs_url() + self.path[len(API_PREFIX):]
        if body is None:
            content_length = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(content_length) if content_length > 0 else None

        # ── Pagar peran: menu, lingkup ONU, dan izin aksi per role (2026-10-04) ──
        if self._pagar_peran(body):
            return

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

        # Reboot (dan sejak 2026-10-03 setiap perubahan WAN/WiFi/akun web) sah, tetapi
        # tidak boleh tanpa jejak: dulu satu-satunya cara mengetahui siapa me-reboot ONU
        # adalah menebak dari log CWMP. Dicatat sesudah NBI menjawab — lihat _catat_onu.
        jejak = logonu.uraikan(self.command, self.path[len(API_PREFIX):], body)

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
        # Kredensial NBI HANYA dari server (acs_connection_settings). Dulu header
        # Authorization kiriman browser didahulukan "demi kompatibilitas mundur" — padahal
        # browser mengirim username NBI dengan password KOSONG (2026-10-03): begitu
        # autentikasi NBI dinyalakan, setiap permintaan ditolak GenieACS dan seluruh
        # operator tampak "sesi berakhir". Header dari klien kini tidak pernah diteruskan.
        try:
            h = config_store.acs_auth_header()
            if h:
                req.add_header('Authorization', h)
        except Exception:
            pass

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
                # Nilai kredensial (password PPPoE, akun web ONU, ACS) tidak pernah
                # dikirim ke browser — lihat acs_guard.sensor_kredensial.
                if self.command == 'GET':
                    data = acs_guard.sensor_kredensial(data)
                    # Mitra yang terbatas: entri milik ONU lain dibuang dari jawaban.
                    if self._saring_mitra:
                        data = mitra.saring_jawaban(self._saring_mitra[0], data, self._saring_mitra[1])
                self._tutup_operasi(op, 'selesai', resp.status)
                self._catat_onu(jejak, resp.status)
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
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self._tutup_operasi(op, 'gagal', e.code)
            self._catat_onu(jejak, e.code)
            if e.code == 401:
                # 401 dari GenieACS = kredensial NBI di Settings → Koneksi ACS salah. Bila
                # diteruskan apa adanya, browser mengira SESI PANEL yang berakhir dan melempar
                # operator ke layar login berulang-ulang, padahal login-nya baik-baik saja.
                self._json(502, {'error': 'GenieACS menolak kredensial NBI (HTTP 401). '
                                          'Administrator perlu memeriksa Settings → Koneksi ACS.'})
                return
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._tutup_operasi(op, 'gagal', 502)
            self._catat_onu(jejak, 502)
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    # ── CORS pre-flight ───────────────────────────────────────────
    def do_OPTIONS(self):
        # Pre-flight hanya dikirim browser untuk permintaan LINTAS-origin — yang tak pernah
        # diizinkan panel ini. Jawaban tanpa header Access-Control-Allow-* membuat browser
        # membatalkan permintaan aslinya (2026-10-03; dulu origin mana pun diizinkan).
        self.send_response(204)
        self.end_headers()

    # ── /config endpoint (bentuk lama, kini di atas DB) ───────────
    def _handle_config_get(self):
        cfg = load_config()
        acs = config_store.acs_get()
        if acs.get('auth_secret_set'):
            cfg['acsPassSet'] = True
        # Sama dengan /config/all: alamat & akun NBI hanya untuk pemegang menu Koneksi ACS.
        if not config_store.izin_punya(self._current_user(), 'koneksiAcs'):
            cfg['acsUrl'], cfg['acsUser'] = '', ''
            cfg.pop('acsPassSet', None)
        data = json.dumps(cfg, indent=2).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _handle_config_post(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length > MAX_BODY:
            self._buang_body(length)
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
    # (Hak Akses Role — 2026-10-03, config_store.IZIN_KUNCI — sengaja hanya mengatur
    # sub-menu Settings; Maps tetap terbuka untuk semua role. Menulis Master Data &
    # ODC tetap khusus administrator.)
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
                # Alamat & akun NBI hanya untuk yang memegang menu Koneksi ACS: browser tak
                # membutuhkannya (proxy /api yang menghubungi GenieACS), dan NBI yang
                # terbuka di jaringan bisa dipakai melewati semua pagar panel.
                'acs': (config_store.acs_get()
                        if config_store.izin_punya(user, 'koneksiAcs') else None),
                'izin': config_store.izin_user(user),
                'isAdmin': user['role'] == 'administrator',
                # null = belum pernah disunting → panel memakai bawaan di
                # js/vpmap.js. Dikirim di sini supaya pemetaan sudah siap
                # sebelum tabel perangkat pertama digambar.
                'vpMapping': config_store.vp_get(),
                # Profil vendor hasil suntingan admin (null = belum pernah →
                # panel memakai bawaan di js/settings.js). Satu sumber untuk
                # semua browser, bukan localStorage masing-masing.
                'vendorProfiles': config_store.vendor_get_all(),
            })
            return

        # ── Profil vendor (Vendor Configuration & Security Setting) ──
        # Membaca profil = data operasional (halaman perangkat memakainya) → semua role.
        _IZIN_PROFIL = {'wan': 'vendorWan', 'security': 'vendorSecurity'}
        if path == '/config/vendor-profiles' and method == 'GET':
            self._json(200, {'profiles': config_store.vendor_get_all(),
                             'bisaUbah': {k: config_store.izin_punya(user, v)
                                          for k, v in _IZIN_PROFIL.items()}})
            return

        if path == '/config/vendor-profiles' and method == 'POST':
            # Profil menentukan parameter APA yang ditulis ke ONU pelanggan — hanya
            # administrator, atau role yang ia beri menu Vendor Configuration / Security.
            d = self._read_json() or {}
            kunci = _IZIN_PROFIL.get(str(d.get('kind') or ''))
            if not kunci:
                self._json(400, {'error': 'Jenis profil tidak dikenal'})
                return
            if not self._izin(user, kunci, 'mengubah Profil Vendor'):
                return
            try:
                hasil = config_store.vendor_set(str(d.get('kind') or ''), d.get('list'), user, ip)
            except ValueError as e:
                self._json(400, {'error': str(e)})
                return
            self._json(200, {'kind': d.get('kind'), 'list': hasil})
            return

        # ── Pemetaan VirtualParameter ────────────────────────────
        if path == '/config/vp-mapping' and method == 'GET':
            self._json(200, {'mapping': config_store.vp_get(),
                             'fields': list(config_store.VP_FIELDS),
                             'turunan': list(config_store.VP_TURUNAN),
                             'transformasi': list(config_store.VP_TRANSFORMASI)})
            return

        if path == '/config/vp-mapping' and method == 'POST':
            if not self._izin(user, 'pemetaanVp', 'mengubah Pemetaan Parameter'):
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
                'bisaUbah':  config_store.izin_punya(user, 'keselamatan'),
            })
            return

        if path == '/config/mode-aman' and method == 'POST':
            if not self._izin(user, 'keselamatan', 'mengubah Mode Aman'):
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
            if not self._izin(user, 'parameter', 'mengubah Parameter Aplikasi'):
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
            if not self._izin(user, 'koneksiAcs', 'mengubah Koneksi ACS'):
                return
            try:
                self._json(200, {'acs': config_store.acs_set(
                    self._read_json() or {}, user, ip)})
            except ValueError as e:
                self._json(400, {'error': str(e)})
            return

        # Menguji koneksi = memaksa server menghubungi host pilihan pemanggil.
        # Itu SSRF bila dibiarkan terbuka, jadi hanya administrator atau role yang ia
        # beri menu Koneksi ACS (yang toh sudah bisa mengarahkan ulang proxy).
        if path == '/config/acs/test' and method == 'POST':
            if not self._izin(user, 'koneksiAcs', 'menguji Koneksi ACS'):
                return
            self._json(200, config_store.acs_test(self._read_json() or {}, user, ip))
            return

        # ── Tag panel untuk ONU (tag.py) ─────────────────────────
        # Membaca: semua akun staf (filter di menu Device). Membuat/memasang/melepas:
        # izin "buatTag". Menghapus nama tag: administrator saja.
        if path == '/config/tag' and method == 'GET':
            per = tag_mod.per_perangkat()
            semua_tag = tag_mod.daftar()
            if user.get('role') == mitra.ROLE:
                # Akun mitra HANYA melihat tagnya sendiri — apa pun izinnya (2026-10-04:
                # mitra dulu melihat nama tag mitra lain di saringan "Semua Tag").
                punya = mitra.tag_akun(user['id'])
                semua_tag = [t for t in semua_tag if t['nama'] == punya]
                per = {d: [punya] for d, t in per.items() if punya and punya in t}
            self._json(200, {'tag': semua_tag, 'perangkat': per,
                             'bisaBuat': config_store.izin_punya(user, 'buatTag'),
                             'bisaHapus': user.get('role') == 'administrator',
                             'tagMitra': mitra.tag_akun(user['id']) if user.get('role') == mitra.ROLE else ''})
            return

        if path in ('/config/tag', '/config/tag/pasang', '/config/tag/hapus', '/config/tag/ubah') and method == 'POST':
            d = self._read_json() or {}
            try:
                if path == '/config/tag/hapus':
                    if not self._require_admin(user, 'menghapus tag'):
                        return
                    self._json(200, {'terlepas': tag_mod.hapus(d.get('nama'), user, ip)})
                    return
                if path == '/config/tag/ubah':
                    # Mengganti nama/warna berdampak ke SEMUA ONU ber-tag itu dan ke filter
                    # semua teknisi → sama seperti menghapus: administrator saja.
                    if not self._require_admin(user, 'mengubah nama tag'):
                        return
                    self._json(200, {'tag': tag_mod.ubah(d.get('nama'), d.get('namaBaru'), d.get('warna'), user, ip)})
                    return
                if not self._izin(user, 'buatTag', 'membuat/memasang tag'):
                    return
                # Memasang tag mitra pada sebuah ONU = menyerahkan ONU itu ke mitra tersebut.
                # Mitra yang terbatas tidak boleh mengklaim ONU lain lewat jalan ini: ia hanya
                # boleh menandai ONU yang SUDAH miliknya.
                if user.get('role') == mitra.ROLE:
                    # Mitra hanya memakai tagnya sendiri: tidak membuat tag lain, tidak
                    # memasang/melepas tag mitra lain.
                    punya = mitra.tag_akun(user['id'])
                    try:
                        diminta = tag_mod.rapikan_nama(d.get('nama'))
                    except tag_mod.TagError:
                        diminta = None
                    if path == '/config/tag' or not punya or diminta != punya:
                        db.audit('access.denied', 'mitra mencoba memakai tag selain tagnya sendiri', user, ip)
                        self._json(403, {'error': 'Akun mitra hanya bisa memakai tagnya sendiri.'})
                        return
                milik = mitra.lingkup(user)
                if milik is not None and path == '/config/tag/pasang' and not (
                        isinstance(d.get('perangkat'), list) and all(x in milik for x in d['perangkat'])):
                    db.audit('access.denied', 'mitra mencoba memasang tag pada ONU di luar miliknya', user, ip)
                    self._json(403, {'error': 'Tag hanya bisa dipasang pada ONU mitra Anda.'})
                    return
                if path == '/config/tag':
                    self._json(200, {'tag': tag_mod.buat(d.get('nama'), d.get('warna'), user, ip)})
                else:
                    self._json(200, {'berubah': tag_mod.pasang(d.get('nama'), d.get('perangkat'),
                                                               bool(d.get('lepas')), user, ip)})
            except tag_mod.TagError as e:
                self._json(400, {'error': str(e)})
            return

        # ── Akun pelanggan ↔ ONU (Manajemen Akun) — khusus administrator ──
        # Administrator mengetik SN; server mencarinya di GenieACS (satu GET) dan
        # menyimpan deviceId-nya. Pelanggan hanya bisa menyentuh ONU di daftar ini.
        if path.startswith('/config/akun-onu/'):
            if not config_store.kelola_akun(user, 'ubah', pelanggan.ROLE) and not (
                    method == 'POST' and config_store.kelola_akun(user, 'buat', pelanggan.ROLE)):
                self._require_admin(user, 'mengatur ONU akun pelanggan')     # 403 + jejak
                return
            uid = urllib.parse.unquote(path[len('/config/akun-onu/'):])
            try:
                if method == 'GET':
                    self._json(200, {'onu': pelanggan.onu_akun(uid)})
                    return
                if method == 'POST':
                    d = self._read_json() or {}
                    sn = d.get('sn') if isinstance(d.get('sn'), list) else []
                    daftar = [self._cari_onu_sn(x) for x in sn[:20]]
                    self._json(200, {'onu': pelanggan.atur_onu_akun(uid, daftar, user, ip)})
                    return
            except pelanggan.PelangganError as e:
                self._json(400, {'error': str(e)})
                return

        # ── Hak akses role (kartu "Hak Akses Role User" di Manajemen Akun) ──
        # Khusus administrator, membaca maupun mengubah — izin tidak bisa didelegasikan.
        if path == '/config/izin-role' and method == 'GET':
            if not self._require_admin(user, 'melihat hak akses role'):
                return
            self._json(200, {'kunci': list(config_store.IZIN_KUNCI),
                             'wajib': list(config_store.IZIN_WAJIB),
                             'panel': list(config_store.IZIN_PANEL),
                             'role': config_store.izin_role_get()})
            return

        if path == '/config/izin-role' and method == 'POST':
            if not self._require_admin(user, 'mengubah hak akses role'):
                return
            d = self._read_json() or {}
            try:
                hasil = config_store.izin_role_set(str(d.get('role') or ''), d.get('izin'), user, ip)
            except ValueError as e:
                self._json(400, {'error': str(e)})
                return
            self._json(200, {'role': d.get('role'), 'izin': hasil})
            return

        if path.startswith('/config/master') or path.startswith('/config/odc'):
            # Master Data & Data ODC adalah isi menu Maps.
            if not self._izin(user, 'menuMaps', 'membuka menu Maps'):
                return
            if path.startswith('/config/master'):
                self._handle_master(path, method, user, ip)
            else:
                self._handle_odc(path, method, user, ip)
            return

        if path == '/config/about' and method == 'GET':
            if not self._izin(user, 'tentang', 'membuka Tentang Sistem'):
                return
            self._json(200, self._about_info(user))
            return

        # ── Pembaruan dari GitHub (pembaruan.py) — khusus administrator ──
        # Tak satu pun menerima alamat/cabang/perintah dari browser: sumbernya selalu
        # remote `origin` repositori di server ini.
        if path == '/config/pembaruan' and method == 'GET':
            if not self._require_admin(user, 'melihat pembaruan panel'):
                return
            self._json(200, dict(pembaruan.keadaan(), proses=ID_PROSES))
            return
        if path == '/config/pembaruan/periksa' and method == 'POST':
            if not self._require_admin(user, 'memeriksa pembaruan panel'):
                return
            try:
                self._json(200, pembaruan.periksa())
            except pembaruan.PembaruanError as e:
                self._json(400, {'error': str(e)})
            return
        if path == '/config/pembaruan/pasang' and method == 'POST':
            if not self._require_admin(user, 'memasang pembaruan panel'):
                return
            self._pasang_pembaruan(user, ip)
            return

        # ── Cadangan basis data (cadangan.py) — khusus administrator ──
        if path == '/config/cadangan' and method == 'GET':
            if not self._require_admin(user, 'melihat cadangan basis data'):
                return
            self._json(200, cadangan.ringkasan())
            return
        if path == '/config/cadangan/unduh' and method == 'POST':
            if not self._require_admin(user, 'mengunduh cadangan basis data'):
                return
            d = self._read_json()
            self._unduh_cadangan(user, d if isinstance(d, dict) else {}, ip)
            return

        # Ringkasan fault, antrean, dan pagar (kesehatan.py). Murni baca, tetapi
        # memuat daftar ONU & perintah yang gagal → hanya yang diberi menu ini.
        if path == '/config/kesehatan' and method == 'GET':
            if not self._izin(user, 'kesehatan', 'membuka Kesehatan ACS'):
                return
            self._json(200, kesehatan.kumpulkan(get_genieacs_url(),
                                                config_store.acs_auth_header()))
            return

        # Tombol "Bersihkan antrean lama": GET = daftar calon (murni baca),
        # POST = hapus id terpilih yang masih memenuhi kriteria. Menghapus task
        # milik alat lain adalah keputusan operator → administrator, atau role
        # yang ia beri menu Kesehatan ACS.
        if path == '/config/kesehatan/bersihkan' and method == 'GET':
            if not self._izin(user, 'kesehatan', 'memeriksa antrean lama'):
                return
            try:
                self._json(200, kesehatan.calon_bersih(get_genieacs_url(),
                                                       config_store.acs_auth_header()))
            except Exception as e:
                self._json(502, {'error': f'Tidak bisa membaca GenieACS: {e}'})
            return

        if path == '/config/kesehatan/bersihkan' and method == 'POST':
            if not self._izin(user, 'kesehatan', 'membersihkan antrean GenieACS'):
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
                or p == pelanggan.PREFIX or p.startswith(pelanggan.PREFIX + '/')
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
        if isinstance(user, dict) and user.get('role') == pelanggan.ROLE:
            self._onu_error(403, 'Tidak diizinkan', 'Akun pelanggan tidak bisa membuka halaman admin ONU.')
            return
        # Web admin ONU = kendali penuh atas ONU itu → izin tersendiri (aksiRemote).
        if isinstance(user, dict) and not config_store.izin_punya(user, 'aksiRemote'):
            self._onu_error(403, 'Tidak diizinkan', 'Akun Anda tidak diizinkan membuka halaman admin ONU.')
            return

        # '../img/x.gif' dari halaman ONU → '/onu/img/x.gif': sisipkan lagi deviceId.
        diperbaiki = onu_proxy.escaped_path(self.path, self.headers.get('Referer') or '')
        if diperbaiki:
            self.path = diperbaiki

        device_id, tail = onu_proxy.split_path(self.path.split('?')[0])
        if not device_id:
            self._onu_error(400, 'Alamat tidak lengkap', 'Device ID tidak disebutkan.')
            return
        milik = mitra.lingkup(user)
        if milik is not None and device_id not in milik and urllib.parse.unquote(device_id) not in milik:
            db.audit('access.denied', 'mitra mencoba membuka web admin ONU di luar miliknya', user, self._client_ip())
            self._onu_error(403, 'Tidak diizinkan', 'ONU ini bukan ONU mitra Anda.')
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

    def _pasang_pembaruan(self, user, ip):
        """Terapkan pembaruan lalu nyalakan ulang panel."""
        # Menyalakan ulang panel memutus permintaan yang sedang menunggu jawaban ONU:
        # perintahnya mungkin sudah sampai, tetapi hasilnya tak pernah tercatat.
        berjalan = len(ops_lock.keadaan()['berjalan'])
        if berjalan:
            self._json(409, {'error': f'Masih ada {berjalan} perintah ONU yang sedang berjalan. '
                                      f'Tunggu sampai selesai (maksimal 2 menit), lalu coba lagi.'})
            return
        if not _kunci_update.acquire(blocking=False):
            self._json(409, {'error': 'Pembaruan sedang dipasang oleh administrator lain.'})
            return
        try:
            def _cadangkan():
                cadangan.buat('sebelum-update')
                cadangan.pangkas('sebelum-update', cadangan.SIMPAN_UPDATE)
            try:
                h = pembaruan.pasang(sebelum=_cadangkan)
            except pembaruan.PembaruanError as e:
                db.audit('sistem.update.gagal', str(e)[:200], user, ip)
                self._json(400, {'error': str(e)})
                return
            except Exception as e:
                db.audit('sistem.update.gagal', type(e).__name__, user, ip)
                self._json(500, {'error': 'Pembaruan gagal: ' + type(e).__name__})
                return
            if h['berubah']:
                db.audit('sistem.update', f"v{h['versiDari']} ({h['dari']}) → v{h['versiKe']} ({h['ke']})", user, ip)
            self._json(200, dict(h, mulaiUlang=h['berubah'], proses=ID_PROSES))
            if h['berubah']:
                MULAI_ULANG()
        finally:
            _kunci_update.release()

    def _unduh_cadangan(self, user, d, ip):
        """Kirim cadangan terenkripsi sebagai berkas unduhan.

        Isinya SELURUH basis data (hash password semua akun, kredensial NBI, Log), jadi
        sesi administrator saja belum cukup: password akunnya diminta lagi. Sesi yang
        dibajak (laptop ditinggal terbuka, cookie tersadap di HTTP) tidak bisa membawa
        pulang basis data. Percobaan password dibatasi oleh pembatas yang sama dengan login.
        """
        blokir, tunggu = auth.login_blocked(ip, user.get('username'))
        if blokir:
            self._json(429, {'error': f'Terlalu banyak percobaan. Coba lagi dalam {max(1, tunggu // 60)} menit.'})
            return
        rec = auth.get_by_id(user['id'])
        if not rec or not auth.verify_password(str(d.get('password') or ''), rec.get('pass')):
            auth.record_failure(ip, user.get('username'))
            db.audit('access.denied', 'unduh cadangan: password akun salah', user, ip)
            self._json(403, {'error': 'Password akun Anda salah'})
            return
        try:
            nama, isi = cadangan.unduh_terenkripsi(d.get('sandi'))
        except cadangan.CadanganError as e:
            self._json(400, {'error': str(e)})
            return
        except Exception as e:
            self._json(500, {'error': 'Cadangan gagal dibuat: ' + type(e).__name__})
            return
        auth.clear_failures(ip, user.get('username'))
        db.audit('cadangan.unduh', f'{nama} ({_fmt_size(len(isi))}, terenkripsi)', user, ip)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Disposition', f'attachment; filename="{nama}"')
        self.send_header('Content-Length', str(len(isi)))
        self.end_headers()
        self.wfile.write(isi)

    def _about_info(self, user=None):
        """Info sistem LANGSUNG dari mesin ini.

        Sebelumnya nilai-nilai ini ditulis tetap di HTML ("MongoDB v4.4.30",
        "Versi 1.0.0") — angka yang tak pernah berubah walau kenyataannya
        berubah, yang justru lebih berbahaya daripada tidak menampilkan apa pun.

        Menu ini terbuka untuk role user secara bawaan, jadi letak berkas basis data
        dan alamat NBI hanya ikut untuk yang berhak (2026-10-03): keduanya bukan
        urusan teknisi lapangan, dan NBI yang terbuka di jaringan bisa dipakai
        melewati semua pagar panel.
        """
        import platform
        admin = (user or {}).get('role') == 'administrator'
        info = {
            'app': 'Panel ACS Sky Tech',
            'appVersion': APP_VERSION,
            'python': platform.python_version(),
            'platform': f'{platform.system()} {platform.release()}',
            'hostname': socket.gethostname(),
            'schema': db.schema_version(),
            'dbPath': db.DB_PATH if admin else None,
            'dbSize': _fmt_size(_file_size(db.DB_PATH)),
            'startedAt': STARTED_AT,
            'uptime': _fmt_uptime(time.time() - STARTED_TS),
            'https': _https_enabled(),
            'acsUrl': (config_store.acs_url()
                       if config_store.izin_punya(user, 'koneksiAcs') else None),
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

    # ── Penjaga permintaan dari situs/origin lain (2026-10-03) ─────────────
    # Semua yang memegang data & perintah panel. /onu/ tidak termasuk: itu halaman
    # milik ONU yang memang dibuka di tab tersendiri.
    _JALUR_PANEL = ('/api', '/auth', '/config', '/ops', pelanggan.PREFIX)

    def _origin_sendiri(self, origin):
        """Apakah Origin = alamat panel ini (Host, X-Forwarded-Host, atau SKY_ORIGIN)?"""
        try:
            netloc = (urllib.parse.urlsplit(origin).netloc or '').lower()
        except ValueError:
            return False
        if not netloc:
            return False                    # 'null' (iframe sandbox, file://) dsb.
        sah = {(self.headers.get('Host') or '').strip().lower()}
        # Di belakang reverse proxy Host bisa sudah diganti; X-Forwarded-Host aman dipakai
        # untuk pemeriksaan INI karena halaman jahat di browser tak bisa memalsukan header
        # tersebut tanpa preflight — dan preflight tak pernah kita izinkan.
        fwd = self.headers.get('X-Forwarded-Host')
        if fwd:
            sah.add(fwd.split(',')[0].strip().lower())
        for o in (os.environ.get('SKY_ORIGIN') or '').split(','):
            o = o.strip().lower()
            if o:
                sah.add(urllib.parse.urlsplit(o).netloc or o)
        sah.discard('')
        return netloc in sah

    # ── Portal pelanggan (pelanggan.py) ──────────────────────────
    def _is_pel(self):
        p = self.path.split('?')[0]
        return p == pelanggan.PREFIX or p.startswith(pelanggan.PREFIX + '/')

    def _tolak_pelanggan(self):
        """True (403 sudah terkirim) bila akun PELANGGAN memanggil jalur di luar daftar-izinnya.

        Daftar-izin, bukan daftar-tolak (pelanggan.jalur_boleh): akun pelanggan hanya
        memakai /pel/*, /auth/me, /auth/logout, dan akunnya sendiri. /api, /config, /ops
        tertutup — termasuk bila dipanggil langsung dengan curl memakai cookie-nya."""
        p = self.path.split('?')[0]
        if not any(p == x or p.startswith(x + '/') for x in self._JALUR_PANEL):
            return False                       # halaman & aset statis
        user = self._current_user()
        if not isinstance(user, dict) or user.get('role') != pelanggan.ROLE:
            return False
        if pelanggan.jalur_boleh(self.command, p, user):
            return False
        db.audit('access.denied', f'akun pelanggan mencoba {self.command} {p[:80]}', user, self._client_ip())
        self._json(403, {'error': 'Akun pelanggan hanya bisa membuka portal pelanggan.', 'portal': '/pelanggan'})
        return True

    # ── Halaman menurut sesi & role (2026-10-03) ──────────────────
    def _alihkan(self, lokasi):
        self.send_response(302)
        self.send_header('Location', lokasi)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _layani_halaman(self, jenis, path):
        """Kirim halaman yang sesuai sesi & role — atau ALIHKAN sebelum satu byte pun dari
        halaman yang salah terkirim:
            belum login → /login (pintu masuk tunggal; alamat asal dibawa di ?lanjut=)
            pelanggan   → /pelanggan        staf → panel
        Dulu pengalihan dilakukan JavaScript SESUDAH halaman panel dimuat, sehingga akun
        pelanggan sempat melihat dashboard sekilas (laporan operator, dua kali). Lokasi
        tujuan selalu jalur tetap milik panel — tidak pernah diambil dari permintaan.

        Kunjungan yang berasal dari situs lain (tautan di chat) tidak membawa cookie sesi
        (SameSite=Strict), jadi tampak "belum login" di sini; login.js memeriksa /auth/me
        dan meneruskan pemilik sesi ke rumahnya."""
        user = self._current_user()
        role = (user.get('role') if isinstance(user, dict) else 'user') if user else None
        rumah = '/pelanggan' if role == pelanggan.ROLE else '/'
        if jenis == 'login':
            if role:
                self._alihkan(rumah)
            else:
                self._serve_berkas('login')
            return
        if not role:
            polos = path in ('/', '/index.html', '/pelanggan', '/pelanggan/')
            self._alihkan('/login' + ('' if polos else '?lanjut=' + urllib.parse.quote(path, safe='/')))
            return
        if jenis == 'pelanggan':
            if role == pelanggan.ROLE:
                self._serve_berkas('pelanggan')
            else:
                self._alihkan('/')
            return
        if role == pelanggan.ROLE:
            self._alihkan('/pelanggan')
            return
        self._serve_index()

    def _serve_berkas(self, folder):
        """Halaman berdiri sendiri: frontend/<folder>/index.html (login, pelanggan)."""
        try:
            with open(os.path.join(DIRECTORY, folder, 'index.html'), 'rb') as f:
                data = f.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _cari_onu_sn(self, sn):
        """SN → {'id', 'sn'} dari GenieACS (satu GET, projection _id). Untuk administrator
        yang memasangkan ONU ke akun pelanggan."""
        sn = str(sn or '').strip()
        if not re.match(r'^[A-Za-z0-9._-]{4,40}$', sn):
            raise pelanggan.PelangganError('SN tidak sah: ' + sn[:40])
        q = urllib.parse.quote(json.dumps({'_deviceId._SerialNumber': sn}))
        try:
            arr = pelanggan.nbi_get(get_genieacs_url(), config_store.acs_auth_header(),
                                    f'/devices?query={q}&projection=_id')
        except Exception:
            raise pelanggan.PelangganError('ACS tidak bisa dihubungi untuk mencari SN ' + sn)
        if not arr:
            raise pelanggan.PelangganError('SN ' + sn + ' tidak ditemukan di ACS')
        return {'id': arr[0]['_id'], 'sn': sn}

    def _handle_pel(self):
        """Endpoint portal pelanggan. Setiap ONU diperiksa kepemilikannya; perintah ke ONU
        DISUSUN server lalu dikirim lewat _proxy — pagar & kunci operasi yang sama."""
        user = self._current_user()
        if not user:
            self._json(401, {'error': 'Belum login'})
            return
        if user.get('role') != pelanggan.ROLE:
            self._json(403, {'error': 'Khusus akun pelanggan'})
            return
        ip = self._client_ip()
        m = self.command
        bagian = [urllib.parse.unquote(x) for x in self.path.split('?')[0][len(pelanggan.PREFIX):].split('/') if x]
        badan = (self._read_json() or {}) if m == 'POST' else {}
        base, auth_h = get_genieacs_url(), config_store.acs_auth_header()
        try:
            if bagian == ['onu'] and m == 'GET':
                # Pemetaan VP & ambang RX/online dari server: portal membaca dokumen dengan
                # kode yang SAMA dengan panel (ACS.mapDevice), jadi angkanya harus sama.
                self._json(200, {'onu': pelanggan.onu_akun(user['id']), 'cs': pelanggan.CS_WHATSAPP,
                                 'vpMapping': config_store.vp_get(), 'params': config_store.params_get()})
                return
            if len(bagian) < 2 or bagian[0] != 'onu':
                self._json(404, {'error': 'Endpoint tidak dikenal'})
                return
            dev = bagian[1]
            if not pelanggan.milik(user, dev):
                db.audit('access.denied', f'pelanggan mencoba ONU bukan miliknya: {dev[:80]}', user, ip)
                self._json(403, {'error': 'ONU ini bukan milik akun Anda'})
                return
            aksi = bagian[2] if len(bagian) > 2 else ''
            if aksi == '' and m == 'GET':
                doc = pelanggan.ambil_dokumen(base, auth_h, dev)
                self._json(200, {'dok': pelanggan.bersihkan_dokumen(doc)})
                return
            if aksi == 'tugas' and len(bagian) == 4 and m == 'GET':
                self._json(200, {'state': pelanggan.nasib_task(base, auth_h, dev, bagian[3])})
                return
            if m == 'POST' and aksi in ('wifi', 'reboot', 'refresh'):
                if aksi == 'wifi':
                    doc = pelanggan.ambil_dokumen(base, auth_h, dev)
                    params = pelanggan.susun_wifi(doc, badan.get('slot'), badan.get('nama'),
                                                  badan.get('sandi'), badan.get('aktif'))
                    tugas = {'name': 'setParameterValues', 'parameterValues': params}
                elif aksi == 'reboot':
                    tugas = {'name': 'reboot'}
                else:
                    # Refresh RINGAN: hanya WiFi & perangkat terhubung (LANDevice.1).
                    tugas = {'name': 'refreshObject', 'objectName': 'InternetGatewayDevice.LANDevice.1'}
                # Jejaknya ditulis _proxy → _catat_onu, sama seperti perintah staf: satu baris
                # berisi apa yang diubah (NAMA saja, tanpa nilai password) dan hasilnya.
                # Dulu dicatat di sini SEBELUM dikirim ('pelanggan.wifi') — reboot jadi
                # tercatat dua kali dan tak satu pun memuat hasilnya.
                self.path = (API_PREFIX + '/devices/' + urllib.parse.quote(dev, safe='')
                             + '/tasks?connection_request&timeout=30000')
                self._proxy(json.dumps(tugas).encode('utf-8'))
                return
        except pelanggan.PelangganError as e:
            self._json(400, {'error': str(e)})
            return
        except Exception:
            self._json(502, {'error': 'ACS tidak bisa dihubungi saat ini. Coba lagi sebentar.'})
            return
        self._json(404, {'error': 'Endpoint tidak dikenal'})

    def _tolak_lintas_situs(self):
        """True (403 sudah terkirim) bila permintaan ke API panel datang dari situs lain.

        Lapis pertama: Sec-Fetch-Site — diisi BROWSER, tak bisa dipalsukan skrip halaman.
        'cross-site' = situs lain; 'same-site' = origin lain di situs yang sama (port lain
        di alamat yang sama, subdomain). Keduanya ditolak untuk SEMUA metode: panel tak
        pernah memanggil API-nya sendiri dari origin lain.
        Lapis kedua (browser lama tanpa Sec-Fetch-Site): untuk metode yang mengubah sesuatu,
        Origin — bila ada — wajib alamat panel ini.
        Klien non-browser (curl, uji) tak mengirim keduanya → tidak terpengaruh; mereka
        tetap wajib punya sesi yang sah."""
        p = self.path.split('?')[0]
        if not any(p == x or p.startswith(x + '/') for x in self._JALUR_PANEL):
            return False
        sfs = (self.headers.get('Sec-Fetch-Site') or '').strip().lower()
        alasan = None
        if sfs in ('cross-site', 'same-site'):
            alasan = 'Sec-Fetch-Site: ' + sfs
        elif self.command not in ('GET', 'HEAD'):
            origin = self.headers.get('Origin')
            if origin is not None and not self._origin_sendiri(origin):
                alasan = 'Origin: ' + origin[:100]
        if not alasan:
            return False
        try:
            db.audit('security.cross_site.denied', f'{self.command} {p} — {alasan}', None, self._client_ip())
        except Exception:
            pass
        self._json(403, {'error': 'Permintaan dari situs lain ditolak. Buka panel langsung dari alamatnya.'})
        return True

    def do_GET(self):
        if self.path.startswith(onu_proxy.PREFIX):
            self._handle_onu()
            return
        if self._maybe_onu_by_referer():
            return
        if self._tolak_lintas_situs():
            return
        if self._tolak_pelanggan():
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
        if self._is_pel():
            self._handle_pel()
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

        if path in ('/login', '/login/'):
            self._layani_halaman('login', path)
        elif path in ('/pelanggan', '/pelanggan/'):
            self._layani_halaman('pelanggan', path)
        elif path == '/' or path == '/index.html' or (ext.lower() not in ASSET_EXTS) or not os.path.isfile(fs_path):
            self._layani_halaman('panel', path)
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith(onu_proxy.PREFIX):
            self._handle_onu()
            return
        if self._maybe_onu_by_referer():
            return
        if self._tolak_lintas_situs():
            return
        if self._tolak_pelanggan():
            return
        if self.path.split('?')[0].startswith(AUTH_PREFIX):
            self._handle_auth()
            return
        if self.path.split('?')[0].startswith(SETTINGS_PREFIX):
            self._handle_settings()
            return
        if self._is_pel():
            self._handle_pel()
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
        if self._tolak_lintas_situs():
            return
        if self._tolak_pelanggan():
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
        if self._tolak_lintas_situs():
            return
        if self._tolak_pelanggan():
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
            #   CSP (2026-10-03) — daftar-izin sumber skrip/gaya/font/koneksi. Bila suatu
            #                   saat ada teks dari ONU yang lolos tanpa escape, skrip
            #                   sisipan tetap tak bisa memuat kode dari luar ataupun
            #                   mengirim data ke server lain (connect-src 'self').
            #                   'unsafe-inline' masih perlu: halaman memakai onclick="…".
            #   Permissions-Policy — kamera/mikrofon/lokasi tak pernah dipakai panel.
            #   CORP same-origin   — jawaban panel tak bisa disematkan origin lain.
            #   HSTS (hanya HTTPS) — browser menolak turun ke HTTP polos sesudah sekali HTTPS.
            self.send_header('Content-Security-Policy', _CSP)
            self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            if _https_enabled():
                self.send_header('Strict-Transport-Security', 'max-age=31536000')
        super().end_headers()


if __name__ == '__main__':
    # Keluaran yang dialihkan ke berkas di Windows memakai cp1252 dan MELEDAK pada karakter
    # seperti '→' — server mati tepat sesudah banner (2026-10-03). Ganti saja karakternya.
    for _aliran in (sys.stdout, sys.stderr):
        try:
            _aliran.reconfigure(errors='replace')
        except Exception:
            pass
    # DB dibuka & dimigrasi di sini, bukan saat permintaan pertama datang:
    # skema yang gagal harus menghentikan server sekarang, bukan muncul sebagai
    # error 500 acak di tengah jam kerja.
    db.init()
    auth.purge_expired_sessions()
    # config.json → tabel, sekali jalan. Tanpa ini, panel yang NBI-nya di mesin
    # lain akan diam-diam kembali menunjuk 127.0.0.1 setelah migrasi.
    config_store.import_legacy_config(CONFIG_PATH)

    # Panel baru (belum ada akun) → pemasang membuat administrator pertama lewat halaman
    # instalasi. Tak ada lagi akun bawaan: kredensial default yang bisa ditebak adalah
    # cara paling umum panel seperti ini dibobol. Lihat catatan di auth.py.
    _kode_setup = auth.prepare_setup()

    # Membatalkan task panel yang mengantre terlalu lama (antrean.py). Dimulai
    # di sini, bukan saat import: tes yang mengimpor server tidak boleh ikut
    # menjalankan thread yang menghapus task di NBI.
    antrean.mulai_penjaga(get_genieacs_url, config_store.acs_auth_header)

    # Cadangan harian basis data (cadangan.py): folder data hanya untuk akun yang
    # menjalankan panel, lalu penjaga yang mencadangkan sekali sehari & menyimpan 14 terakhir.
    cadangan.amankan_folder()
    cadangan.mulai_penjaga()

    try:
        server = buat_server()
    except (ssl.SSLError, OSError) as e:
        print(f'GAGAL memuat sertifikat TLS ({TLS_CERT}, {TLS_KEY}): {e}', flush=True)
        sys.exit(1)
    _skema = 'https' if _TLS_AKTIF else 'http'
    print(f'SKY ACS server running at {_skema}://{HOST}:{PORT}/', flush=True)
    if _TLS_AKTIF:
        print(f'HTTPS    : aktif (sertifikat {TLS_CERT})', flush=True)
    print(f'Database : {db.DB_PATH} (SQLite, skema v{db.schema_version()})', flush=True)
    print(f'API proxy: /api/* → {get_genieacs_url()}/*  (wajib login)', flush=True)

    if _kode_setup:
        print('\n' + '=' * 62, flush=True)
        print('  INSTALASI PERTAMA — belum ada akun.', flush=True)
        print(f'  Buka {_skema}://localhost:{PORT}/ di komputer ini, lalu isi nama,', flush=True)
        print('  email, username dan password untuk akun administrator.', flush=True)
        print('', flush=True)
        print('  Bila dibuka dari komputer LAIN, halaman itu meminta kode ini:', flush=True)
        print(f'      {_kode_setup}', flush=True)
        print(f'  (juga tersimpan di {os.path.join(auth.DATA_DIR, auth.SETUP_CODE_FILE)})', flush=True)
        print('=' * 62, flush=True)

    if not _https_enabled():
        print('\n' + '!' * 62, flush=True)
        print('  PERINGATAN: panel dilayani lewat HTTP polos.', flush=True)
        print('  Password dan cookie sesi melintas sebagai TEKS TERANG, dan', flush=True)
        print('  siapa pun di jalur jaringan dapat menyadap lalu memakai ulang', flush=True)
        print('  sesi Anda. Hashing sekuat apa pun TIDAK menutup lubang ini —', flush=True)
        print('  hanya TLS/HTTPS yang bisa.', flush=True)
        print('  Pilih salah satu:', flush=True)
        print('   • python tools/buat_sertifikat.py  → panel melayani HTTPS sendiri', flush=True)
        print('   • reverse proxy ber-HTTPS (Caddy/nginx) di depan panel, lalu', flush=True)
        print('     jalankan dengan SKY_HTTPS=1 (dan SKY_HOST=127.0.0.1).', flush=True)
        print('  Lihat README.md bagian "Keamanan".', flush=True)
        print('!' * 62, flush=True)
    print('\nPress Ctrl+C to stop.\n', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.', flush=True)
