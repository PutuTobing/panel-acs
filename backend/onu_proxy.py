#!/usr/bin/env python3
"""
SKY ACS — proxy web UI ONU.

Memungkinkan operator membuka halaman admin ONU dari panel, termasuk dari luar
jaringan, tanpa VPN: browser berbicara ke panel, panel yang berbicara ke IP
manajemen ONU di 10.17.x.x / 10.18.x.x.

    Browser  →  panel  /onu/<deviceId>/...  →  http://10.17.x.x/...

KENAPA INI BISA JALAN (diverifikasi ke ONU sungguhan, bukan diasumsikan):
  • Web UI ONU tidak memakai satu pun path absolut — seluruhnya relatif. Itulah
    yang membuat proxy berbasis prefix cukup, TANPA perlu menulis ulang HTML.
  • X-Frame-Options: SAMEORIGIN dan CSP 'self' pada ONU tidak menghalangi:
    di balik proxy, halamannya memang menjadi same-origin dengan panel.
  • Keterjangkauan ditentukan JARINGAN, bukan per-ONU. Diukur berurutan
    (bukan paralel — pemindaian paralel memberi hasil menyesatkan):
        10.17.x.x → 12/12 port 80 terbuka   (1215 ONU, bisa di-remote)
        10.18.x.x →  0/12 port 80 terbuka   (525 ONU, TERBLOKIR)
    ONU di 10.18 sehat: ping 1,2 ms dan port CWMP 58000 terbuka. Hanya port
    80-nya yang difilter — hampir pasti aturan firewall MikroTik yang belum
    mencakup blok itu. Jadi ini BUKAN "halaman admin dimatikan pada ONU", dan
    bukan sesuatu yang bisa diperbaiki dari sisi kode.

═══ KEAMANAN — BACA SEBELUM MENGUBAH APA PUN DI BERKAS INI ═══

Fitur ini menjadikan panel gerbang ke jaringan manajemen. Dua hal yang
menahannya, dan keduanya wajib tetap ada:

  1. IP TIDAK PERNAH DATANG DARI KLIEN.
     Klien hanya menyebut deviceId; IP-nya dicari sendiri dari GenieACS.
     Kalau klien boleh menyebut IP, endpoint ini menjadi SSRF sempurna:
     "proxy-kan saya ke mana pun yang bisa dijangkau server".

  2. DAFTAR-IZIN IP, BUKAN DAFTAR-TOLAK.
     Ini yang paling mudah diremehkan: ConnectionRequestURL DILAPORKAN OLEH
     ONU. Itu data yang dikendalikan perangkat. ONU yang disusupi cukup
     melaporkan ConnectionRequestURL = http://127.0.0.1:7557/ dan proxy ini
     akan dengan patuh menyambungkan pemanggil ke NBI GenieACS — yang TIDAK
     BERAUTENTIKASI dan menguasai 1742 ONU. Karena itu hanya rentang privat
     yang diizinkan, dan loopback/link-local ditolak mentah.

  3. Cookie ONU WAJIB dibatasi path-nya.
     ONU mengirim `Set-Cookie: _TESTCOOKIEHTTP=1; PATH=/`. Tanpa penulisan
     ulang, cookie itu tersimpan untuk SELURUH origin panel — ikut terkirim ke
     ONU lain (sesi tertukar) dan ke endpoint panel sendiri.

  4. ONU tidak boleh menimpa cookie sesi panel.
     Kalau ONU menyetel cookie bernama sama dengan cookie sesi kita, sesi
     operator ikut tertimpa. Nama itu diblokir mentah.
"""

import hashlib
import ipaddress
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

import db

PREFIX = '/onu/'

# Rentang tempat ONU boleh berada. Jaringan manajemen di sini 10.17.0.0/21 dan
# 10.18.x.x; rentang privat lain diizinkan agar penempatan lain tetap bekerja.
# Yang TIDAK boleh: loopback (menjangkau panel/NBI sendiri), link-local
# (169.254.169.254 = endpoint metadata cloud), multicast, dan seluruh IP publik.
ALLOWED_NETS = [
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.168.0.0/16'),
]

# Port yang boleh dituju. ONU melayani UI-nya di 80; 443/8080 disediakan untuk
# perangkat yang memakainya. CWMP (7547/58000) sengaja TIDAK ada di sini —
# itu jalur ACS, bukan halaman untuk dibuka manusia.
ALLOWED_PORTS = {80, 443, 8080, 8443}

CONNECT_TIMEOUT = 8
CACHE_TTL = 60          # deviceId → IP; ONU tidak berpindah IP tiap detik

_cache = {}             # device_id -> (host, expires_at)

# Header yang TIDAK boleh diteruskan apa adanya.
# hop-by-hop (RFC 7230) + yang akan berbohong bila diteruskan.
_HOP = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade',
    'content-length',   # dihitung ulang; meneruskan yang lama = respons rusak
    'host',             # harus menunjuk ONU, bukan panel
}

# Header respons yang dibuang karena PANEL sudah mengirimkannya sendiri lewat
# send_response(). Meneruskan punya ONU menghasilkan header ganda pada tiap
# permintaan — tidak fatal, tapi membuat respons rancu dan sulit dibaca saat
# menelusuri masalah.
_SERVER_OWNED = {'server', 'date'}


class OnuError(Exception):
    """Kegagalan yang aman ditampilkan ke operator."""
    def __init__(self, message, kind='error', status=502):
        super().__init__(message)
        self.kind = kind
        self.status = status


def split_path(path):
    """'/onu/<id>/a/b?c=1' → ('<id>', '/a/b?c=1'). Mengembalikan (None, None)
    bila bukan path proxy."""
    if not path.startswith(PREFIX):
        return None, None
    rest = path[len(PREFIX):]
    if not rest:
        return None, None
    parts = rest.split('/', 1)
    device_id = urllib.parse.unquote(parts[0])
    tail = '/' + (parts[1] if len(parts) > 1 else '')
    return device_id, tail


def referer_device_id(referer):
    """Ambil segmen deviceId (MASIH ter-encode) dari sebuah URL Referer bila
    ia menunjuk halaman ONU ('.../onu/<id>/...'); None bila bukan.

    Dipakai routing sticky di server: SPA admin ONU (mis. C-DATA/Vue, webpack
    publicPath '/') memuat aset & memanggil API lewat path ABSOLUT ('/js/app.js',
    '/boaform/...') yang tak berawalan /onu/<id>/. Referer dokumennya tetap
    menunjuk /onu/<id>/ (router hash-mode), jadi dari situ kita tahu request itu
    milik ONU mana.

    Segmen id DIKEMBALIKAN APA ADANYA — tidak di-unquote — supaya '%2D' pada id
    C-DATA tetap utuh; pemanggil menyusunnya kembali jadi /onu/<seg><path> dan
    split_path yang meng-unquote sekali, persis alur /onu/ normal."""
    if not referer:
        return None
    try:
        p = urllib.parse.urlparse(referer).path
    except Exception:
        return None
    if not p.startswith(PREFIX):
        return None
    seg = p[len(PREFIX):].split('/', 1)[0]
    return seg or None


def escaped_path(path, referer):
    """Perbaiki path yang "keluar" dari prefiks perangkat karena '../'.

    Halaman utama web ZTE F6600P (dokumen di /onu/<id>/) memuat gambar lewat
    '../img/x.gif'. Browser menyelesaikannya menjadi '/onu/img/x.gif' — segmen
    deviceId hilang, proxy mengira perangkatnya bernama 'img' → 404, dan halaman
    tampil tanpa gambar (2026-10-02, SN ZTEGD4D5D1FF).

    Bila Referer menunjuk halaman ONU dan segmen pertama path BUKAN deviceId
    (deviceId GenieACS selalu 'OUI-Kelas-Serial', jadi pasti memuat '-'),
    kembalikan path dengan deviceId dari Referer disisipkan lagi. Selain itu None.
    Perangkat tetap ditentukan Referer + GenieACS, bukan oleh isi path."""
    raw = referer_device_id(referer)
    if not raw or not path.startswith(PREFIX):
        return None
    rest = path[len(PREFIX):]
    seg = urllib.parse.unquote(rest.split('?', 1)[0].split('/', 1)[0])
    if not seg or '-' in seg or seg == urllib.parse.unquote(raw):
        return None
    return PREFIX + raw + '/' + rest


def validate_host(host):
    """Melempar OnuError bila host di luar daftar-izin.

    Menerima IP saja, sengaja tidak menerima nama host: nama harus di-resolve
    dulu, dan resolusi itu sendiri bisa diarahkan ke mana pun (DNS rebinding).
    """
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        raise OnuError(f'Alamat ONU tidak valid: {host}', 'invalid', 400)
    if ip.is_loopback:
        raise OnuError('Alamat loopback ditolak', 'blocked', 403)
    if ip.is_link_local or ip.is_multicast or ip.is_reserved:
        raise OnuError('Alamat khusus ditolak', 'blocked', 403)
    if not any(ip in net for net in ALLOWED_NETS):
        raise OnuError(
            f'Alamat {host} di luar jaringan manajemen yang diizinkan', 'blocked', 403)
    return str(ip)


def resolve_device(device_id, nbi_url, fetch=None):
    """deviceId → IP manajemen, dari ConnectionRequestURL di GenieACS.

    IP TIDAK PERNAH diambil dari permintaan klien — lihat catatan keamanan.
    `fetch` bisa disuntik oleh tes.
    """
    now = time.time()
    hit = _cache.get(device_id)
    if hit and hit[1] > now:
        return hit[0]

    q = urllib.parse.quote(f'{{"_id":"{device_id}"}}')
    proj = 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL'
    url = f'{nbi_url}/devices/?query={q}&projection={proj}'

    try:
        raw = fetch(url) if fetch else _http_get_json(url)
    except Exception as e:
        raise OnuError(f'Gagal membaca data perangkat dari GenieACS: {e}', 'acs', 502)

    if not raw:
        raise OnuError('Perangkat tidak ditemukan di GenieACS', 'not-found', 404)

    cru = (((raw[0].get('InternetGatewayDevice') or {})
            .get('ManagementServer') or {})
           .get('ConnectionRequestURL') or {}).get('_value')
    if not cru:
        raise OnuError(
            'ONU belum melaporkan alamat manajemennya (ConnectionRequestURL kosong)',
            'no-address', 404)

    # '/' di akhir OPSIONAL: sebagian vendor melaporkan ConnectionRequestURL
    # lengkap dengan path ('.../tr069', ZTE '.../jCeEg...'), sebagian lain hanya
    # 'http://10.17.5.43:58000' tanpa path sama sekali. Regex lama mewajibkan
    # '/' sehingga bentuk kedua GAGAL — memutus remote untuk CIOT/ETCH/ZICG/TRKG
    # walau IP-nya jelas terbaca. Yang kita butuh cuma IP-nya.
    m = re.match(r'^https?://([0-9.]+)(?::\d+)?(?:[/?#]|$)', cru)
    if not m:
        raise OnuError(f'Alamat manajemen tidak dikenali: {cru}', 'invalid', 502)

    host = validate_host(m.group(1))
    _cache[device_id] = (host, now + CACHE_TTL)
    return host


def _http_get_json(url):
    import json
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read() or b'[]')


def probe(host, port=80, timeout=3):
    """Apakah ONU mendengarkan? TCP connect saja — tidak mengirim apa pun ke
    perangkat, jadi tak mungkin memicu aksi."""
    try:
        with socket.create_connection((host, port), timeout):
            return True
    except OSError:
        return False


def rewrite_set_cookie(value, device_id, session_cookie_name):
    """Batasi cookie ONU ke path proxy-nya sendiri.

    ONU mengirim `PATH=/`. Dibiarkan begitu, cookie itu berlaku untuk seluruh
    origin panel: ikut terkirim ke ONU LAIN (sesi tertukar — operator membuka
    ONU B lalu melihat sesi ONU A) dan ke endpoint panel sendiri.

    Mengembalikan None bila cookie harus dibuang sama sekali.
    """
    name = value.split('=', 1)[0].strip().lower()
    # ONU tidak boleh menyentuh cookie sesi panel — itu setara pengambilalihan.
    if name == session_cookie_name.lower():
        return None

    scoped = f'{PREFIX}{urllib.parse.quote(device_id)}/'
    parts = [p.strip() for p in value.split(';')]
    out, seen_path = [], False
    for p in parts:
        low = p.lower()
        if low.startswith('path='):
            out.append('Path=' + scoped)
            seen_path = True
        elif low.startswith('domain='):
            continue          # domain ONU tak bermakna di origin panel
        elif low == 'secure':
            continue          # panel bisa HTTP polos; Secure = cookie tak pernah terkirim
        else:
            out.append(p)
    if not seen_path:
        out.append('Path=' + scoped)
    return '; '.join(out)


# ── Cookie CERMIN untuk permintaan ber-path ABSOLUT (2026-10-02) ──────────────
# Web ZTE F6600P memanggil API-nya lewat path absolut dari root:
# '/?_type=loginData&_tag=login_token'. Permintaan itu sampai ke ONU lewat routing
# Referer, tetapi cookie sesi ONU (SID) sudah kita batasi ke Path=/onu/<id>/ —
# browser TIDAK mengirimnya ke '/'. ONU lalu membuat sesi BARU di setiap permintaan
# (diukur di SN ZTEGD4D5D1FF: tanpa cookie, tiap GET token membalas SID berbeda),
# token login tak pernah cocok, dan tombol Login "tidak merespons".
#
# Maka tiap cookie ONU juga disimpan sebagai CERMIN ber-Path=/ dengan nama
# berawalan khas per-perangkat. Saat meneruskan ke ONU, hanya cermin milik
# perangkat ITU yang dikembalikan ke nama aslinya; cermin perangkat lain dibuang.
# Jadi cookie tetap tidak bocor lintas ONU, dan nama aslinya tak pernah ada di
# Path=/ (tak bisa bertabrakan dengan cookie panel).
MIRROR_PREFIX = '__onu_'


def mirror_prefix(device_id):
    return MIRROR_PREFIX + hashlib.sha1(device_id.encode('utf-8')).hexdigest()[:10] + '_'


def mirror_set_cookie(value, device_id, session_cookie_name):
    """Versi cermin sebuah Set-Cookie ONU: nama berawalan per-perangkat, Path=/.
    None bila cookie itu memang harus dibuang."""
    scoped = rewrite_set_cookie(value, device_id, session_cookie_name)
    if not scoped or '=' not in scoped.split(';', 1)[0]:
        return None
    parts = [p.strip() for p in scoped.split(';')]
    out = [mirror_prefix(device_id) + parts[0]]
    for p in parts[1:]:
        out.append('Path=/' if p.lower().startswith('path=') else p)
    return '; '.join(out)


def rewrite_location(value, device_id, host):
    """Jaga redirect tetap di dalam proxy.

    ONU mengirim Location absolut ke IP-nya sendiri (mis.
    http://10.17.1.224/login.html). Diteruskan apa adanya, browser operator —
    yang berada di luar jaringan — akan mencoba menghubungi 10.17.1.224
    langsung dan gagal. Justru itu yang ingin dihindari fitur ini.
    """
    base = f'{PREFIX}{urllib.parse.quote(device_id)}'
    if not value:
        return value
    m = re.match(r'^https?://([0-9.]+)(?::\d+)?(/.*)?$', value)
    if m:
        # Hanya redirect ke ONU ITU SENDIRI yang ditulis ulang. Redirect ke
        # host lain dibiarkan apa adanya — menariknya ke dalam proxy justru
        # memperluas jangkauannya diam-diam.
        if m.group(1) != host:
            return value
        return base + (m.group(2) or '/')
    if value.startswith('/'):
        return base + value
    return value          # relatif — sudah benar dengan sendirinya


# ── HTTPS di port 80 (Huawei HG8245W5-6T, 2026-10-03) ─────────────────────────
# Web ONU ini dilayani lewat HTTPS **di port 80**. Permintaan HTTP polos ke port itu
# hanya dibalas halaman pengalih berisi skrip:
#     window.location = "https://" + HostInfo + ":" + SSLPort      (SSLPort = '80')
# Di balik proxy, HostInfo adalah alamat PANEL → browser dilempar ke
# https://127.0.0.1:80 dan tombol Remote tampak mati (diukur di SN 485754432B16F9AE:
# HTTP:80 = halaman pengalih, HTTPS:80 = halaman login asli).
# Begitu halaman pengalih itu terlihat, perangkatnya diingat dan permintaannya diulang
# lewat TLS. Sertifikat ONU tanda-tangan-sendiri, jadi TIDAK diverifikasi — setara
# dengan HTTP polos yang dipakai ONU lain; daftar-izin IP & port tetap berlaku.
TLS_TTL = 3600
_tls_devices = {}       # device_id -> kedaluwarsa


def uses_tls(device_id):
    exp = _tls_devices.get(device_id)
    return bool(exp and exp > time.time())


def mark_tls(device_id):
    _tls_devices[device_id] = time.time() + TLS_TTL


def is_https_stub(status, body):
    """Halaman pengalih 'pindah ke https' milik firmware Huawei (lihat catatan di atas)."""
    if status != 200 or not body or len(body) > 20000:
        return False
    # Dua varian terlihat di lapangan: HG8245W5-6T '"https://" + HostInfo', HG8245A
    # '"https://" + SSLHostIp' — keduanya menyambung nama variabel lalu ':' + SSLPort.
    return bool(re.search(rb'window\.location\s*=\s*"https://"\s*\+\s*\w+', body)) and (b'SSLPort' in body)


def build_request(device_id, host, tail, method, body, headers, port=80, tls=False):
    """Susun urllib.Request untuk diteruskan ke ONU."""
    if port not in ALLOWED_PORTS:
        raise OnuError(f'Port {port} tidak diizinkan', 'blocked', 403)
    scheme = 'https' if (tls or port in (443, 8443)) else 'http'
    netloc = host if (port == (443 if scheme == 'https' else 80)) else f'{host}:{port}'
    target = f'{scheme}://{netloc}{tail}'

    req = urllib.request.Request(target, data=body, method=method)
    for k, v in (headers or {}).items():
        if k.lower() in _HOP:
            continue
        if k.lower() == 'cookie':
            v = _strip_panel_cookies(v, device_id)
            if not v:
                continue
        req.add_header(k, v)
    req.add_header('Host', netloc)
    return req, target


def _strip_panel_cookies(cookie_header, device_id=None):
    """Jangan bocorkan cookie sesi PANEL ke ONU.

    Browser mengirim semua cookie yang path-nya cocok. Cookie sesi panel
    (Path=/) ikut terbawa ke /onu/... — dan meneruskannya berarti menyerahkan
    token sesi panel ke perangkat pihak ketiga. ONU tidak butuh, dan tidak
    boleh melihatnya.
    """
    from auth import SESSION_COOKIE
    mine = mirror_prefix(device_id) if device_id else None
    keep, mirrored = [], {}
    for part in (cookie_header or '').split(';'):
        part = part.strip()
        name = part.split('=', 1)[0].strip()
        if not name or name.lower() == SESSION_COOKIE.lower():
            continue
        if name.startswith(MIRROR_PREFIX):
            # Cermin: hanya milik perangkat INI yang dipulihkan ke nama aslinya;
            # cermin ONU lain tidak pernah diteruskan (sesi tak tertukar).
            if mine and name.startswith(mine):
                mirrored[name[len(mine):]] = part[len(mine):]
            continue
        keep.append(part)
    if mirrored:
        # Cermin menang atas cookie bernama sama (nilainya sama; mencegah ganda).
        keep = [p for p in keep if p.split('=', 1)[0].strip() not in mirrored]
        keep.extend(mirrored.values())
    return '; '.join(keep)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Jangan pernah mengikuti redirect di sisi server.

    urllib mengikuti 301/302 SECARA DIAM-DIAM. Untuk sebuah proxy itu salah,
    dan salahnya berlapis:

      • Redirect harus sampai ke BROWSER, supaya ia mengikutinya lewat proxy
        ini dengan Location yang sudah ditulis ulang. Kalau server yang
        mengikutinya, rewrite_location() tak pernah terpakai sama sekali.
      • urllib mengejar Location apa adanya — melewati validate_host(). ONU
        cukup menjawab `Location: http://127.0.0.1:7557/` dan seluruh
        daftar-izin IP terlompati. Jadi ini bukan sekadar kerapian, ini lubang
        SSRF yang menganga di belakang pagar yang sudah dipasang.
      • Cookie dan status aslinya hilang, diganti hasil akhir rantai redirect.
    """
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Opener tanpa pengikut redirect DAN tanpa penangan cookie: kalau tidak, cookie
# satu ONU akan tersimpan di proses server dan ikut terkirim ke ONU lain —
# sesi tertukar di sisi server, tak terlihat dari browser mana pun.
# TLS ke ONU: sertifikat tanda-tangan-sendiri & firmware lama (TLS/cipher usang) —
# tidak diverifikasi dan dilonggarkan, HANYA untuk koneksi ke IP privat yang sudah lolos
# validate_host. Lihat catatan "HTTPS di port 80" di atas.
def _tls_context():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1
        ctx.set_ciphers('DEFAULT:@SECLEVEL=0')
    except Exception:
        pass
    # Firmware lama (Huawei HG8245A V3R013, 2026-10-03) hanya bisa renegosiasi gaya lama;
    # OpenSSL 3 menolaknya ("unsafe legacy renegotiation disabled") kecuali opsi ini.
    ctx.options |= getattr(ssl, 'OP_LEGACY_SERVER_CONNECT', 0x4)
    return ctx


_opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=_tls_context()))


def _unreachable_hint(host):
    """Petunjuk tambahan untuk galat 'tak terjangkau', khusus blok yang kita tahu
    difilter firewall. TANPA ini, ONU di 10.18.x.x tampak seperti perangkat mati
    ('timeout') dan teknisi mendatangi perangkat yang sebenarnya SEHAT.

    Fakta lapangan: dari server panel, seluruh 10.18.x.x port 80 di-DROP (jadi
    TIMEOUT, bukan refused), sementara 10.17.x.x terbuka. Rutenya sama; yang
    membedakan hanya aturan filter di MikroTik. CWMP 7547 ke 10.18 tetap jalan
    (GenieACS mengelolanya), jadi perangkatnya hampir pasti hidup."""
    ip = (host or '').split(':')[0]
    if ip.startswith('10.18.'):
        return (' Perangkatnya kemungkinan SEHAT: pada jaringan ini port 80 ke '
                'blok 10.18.x.x difilter (di-drop) di firewall, sementara '
                '10.17.x.x terbuka. Buka port 80 blok itu di MikroTik agar bisa '
                'di-remote.')
    return ''


def forward(req, timeout=CONNECT_TIMEOUT):
    """Kirim ke ONU. Mengembalikan (status, headers_list, body).

    Galat HTTP dari ONU (401/404/302/…) BUKAN kegagalan proxy — diteruskan apa
    adanya supaya operator melihat halaman ONU yang sebenarnya.
    """
    host = getattr(req, 'host', '') or ''
    try:
        with _opener.open(req, timeout=timeout) as r:
            return r.status, list(r.headers.items()), r.read()
    except urllib.error.HTTPError as e:
        # Termasuk 301/302: _NoRedirect membuat urllib melaporkannya sebagai
        # HTTPError alih-alih mengejarnya. Persis yang kita inginkan.
        return e.code, list(e.headers.items()), e.read()
    except socket.timeout:
        raise OnuError('ONU tidak menjawab di port 80 (timeout).' + _unreachable_hint(host),
                       'timeout', 504)
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, socket.timeout):
            raise OnuError('ONU tidak menjawab di port 80 (timeout).' + _unreachable_hint(host),
                           'timeout', 504)
        if isinstance(reason, ConnectionRefusedError) or 'refused' in str(reason).lower():
            hint = _unreachable_hint(host) or (
                ' Perangkatnya kemungkinan sehat — periksa aturan firewall untuk '
                'blok ini.')
            raise OnuError('ONU menolak koneksi di port 80.' + hint, 'refused', 502)
        raise OnuError(f'Gagal menghubungi ONU: {reason}' + _unreachable_hint(host),
                       'network', 502)


def filter_response_headers(headers, device_id, host, session_cookie_name):
    """Bersihkan header dari ONU sebelum diteruskan ke browser."""
    out = []
    for k, v in headers:
        low = k.lower()
        if low in _HOP or low in _SERVER_OWNED:
            continue
        if low == 'set-cookie':
            nv = rewrite_set_cookie(v, device_id, session_cookie_name)
            if nv:
                # Cermin dulu, versi ber-path sesudahnya (lihat MIRROR_PREFIX).
                mv = mirror_set_cookie(v, device_id, session_cookie_name)
                if mv:
                    out.append(('Set-Cookie', mv))
                out.append(('Set-Cookie', nv))
            continue
        if low == 'location':
            out.append(('Location', rewrite_location(v, device_id, host)))
            continue
        # X-Frame-Options ONU adalah SAMEORIGIN. Di balik proxy halaman ini
        # MEMANG same-origin dengan panel, jadi meneruskannya justru benar —
        # iframe panel tetap boleh, situs lain tetap tidak.
        out.append((k, v))
    return out


def audit_open(device_id, host, actor, ip):
    db.audit('onu.remote.open', f'deviceId={device_id} host={host}', actor, ip)
