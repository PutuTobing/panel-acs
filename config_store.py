#!/usr/bin/env python3
"""
SKY ACS — pengaturan aplikasi di atas SQLite (lihat db.py).

Menggantikan config.json + localStorage sebagai sumber kebenaran untuk:
  • acs_connection_settings — target proxy NBI GenieACS
  • app_parameters          — Parameter Aplikasi
  • display_settings        — preferensi tampilan (per pengguna)

KENAPA PINDAH DARI localStorage:
  Sebelumnya seluruh pengaturan hidup di localStorage browser dan server tidak
  pernah dibacanya (klien bahkan tak pernah memanggil GET /config). Akibatnya
  nyata, bukan teoretis: dua operator di dua browser bisa memegang ambang RX
  dan profil vendor yang BERBEDA untuk panel yang sama, lalu mendorong
  parameter berbeda ke ONU yang sama. Pengaturan bersama harus tinggal di
  tempat yang bersama.

CATATAN KREDENSIAL NBI (penting, dan berbeda dari password akun):
  PRD meminta kredensial ACS "tidak disimpan dalam bentuk plaintext". Untuk
  password AKUN itu benar dan sudah dilakukan (scrypt, lihat auth.py). Untuk
  kredensial NBI itu tidak mungkin: panel harus MENGIRIMKAN ulang kredensial
  itu ke GenieACS pada setiap permintaan. Hash bersifat satu arah — nilai yang
  di-hash tidak bisa dikirim sebagai Basic auth.

  Mengenkripsinya pun hanya teater selama kuncinya berada di disk yang sama:
  siapa pun yang bisa membaca sky.db juga bisa membaca kuncinya. Jadi rahasia
  ini disimpan apa adanya di sky.db yang berizin 0600 — perlindungan yang sama
  dengan hash password, yaitu terhadap pengguna lain di server ini.

  Ini tetap lebih baik daripada sebelumnya: dulu kredensial NBI hidup di
  localStorage tiap browser, terbaca oleh XSS apa pun dan tersebar di banyak
  mesin. Perlindungan sesungguhnya untuk lalu lintas NBI adalah membatasi
  akses jaringan ke port 7557, bukan menyandikan kredensialnya.
"""

import os
import json
import socket
import time
import urllib.request
import urllib.error
import urllib.parse

import db

DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# ─── Parameter Aplikasi: default + batas yang sah ───
# Batasnya ditegakkan di SERVER, bukan hanya di form: form bisa dilewati
# (curl/DevTools), dan perPage=10_000_000 akan membekukan browser operator.
PARAM_SPEC = {
    'onlineThresholdMin': {'type': 'int',   'default': 10,  'min': 1,   'max': 60},
    'perPage':            {'type': 'int',   'default': 20,  'min': 5,   'max': 200},
    'rxGood':             {'type': 'float', 'default': -20, 'min': -40, 'max': 0},
    'rxFair':             {'type': 'float', 'default': -25, 'min': -40, 'max': 0},
    'refreshInterval':    {'type': 'int',   'default': 60,  'min': 0,   'max': 3600},
}

DISPLAY_SPEC = {
    # Bahasa SENGAJA tidak ada: aplikasi dikunci ke Bahasa Indonesia (PRD 5.3).
    'theme': {'type': 'enum', 'default': 'light', 'values': ('light', 'dark')},
}

ACS_DEFAULT = {
    'protocol': 'http', 'host': '127.0.0.1', 'port': 7557, 'base_path': '',
    'auth_enabled': 0, 'auth_username': '', 'auth_secret': '',
}


# ═══════════════════════════════════════════════════════════════
#  Parameter Aplikasi
# ═══════════════════════════════════════════════════════════════
def _coerce(spec, value):
    """Ubah nilai mentah → tipe yang benar, atau lempar ValueError."""
    t = spec['type']
    if t == 'enum':
        v = str(value)
        if v not in spec['values']:
            raise ValueError(f'Nilai harus salah satu dari: {", ".join(spec["values"])}')
        return v
    try:
        v = int(value) if t == 'int' else float(value)
    except (TypeError, ValueError):
        raise ValueError('Nilai harus berupa angka')
    if v < spec['min'] or v > spec['max']:
        raise ValueError(f'Nilai harus antara {spec["min"]} dan {spec["max"]}')
    return v


def params_get():
    stored = db.kv_get_all('app_parameters')
    out = {}
    for key, spec in PARAM_SPEC.items():
        if key in stored:
            try:
                out[key] = _coerce(spec, stored[key])
                continue
            except ValueError:
                pass          # nilai rusak di DB → jatuh ke default, jangan meledak
        out[key] = spec['default']
    return out


def params_set(patch, actor=None, ip=''):
    """Simpan Parameter Aplikasi. Melempar ValueError bila ditolak."""
    clean = {}
    for key, raw in (patch or {}).items():
        if key not in PARAM_SPEC:
            continue                      # kunci asing diabaikan, bukan disimpan
        clean[key] = _coerce(PARAM_SPEC[key], raw)

    merged = {**params_get(), **clean}
    # Aturan lintas-field: ambang "bagus" harus di ATAS ambang "cukup", kalau
    # tidak setiap ONU jatuh ke kategori yang salah tanpa peringatan apa pun.
    if merged['rxGood'] <= merged['rxFair']:
        raise ValueError('RX Batas Bagus harus lebih besar dari Batas Cukup')

    before = params_get()
    for key, val in clean.items():
        db.kv_set('app_parameters', key, val, actor)

    changed = [f'{k}: {before[k]} → {v}' for k, v in clean.items() if before.get(k) != v]
    if changed:
        db.audit('app_parameters.update', '; '.join(changed), actor, ip)
    return params_get()


# ═══════════════════════════════════════════════════════════════
#  Preferensi tampilan (per pengguna)
# ═══════════════════════════════════════════════════════════════
def _display_key(key, uid):
    # Tema adalah preferensi PRIBADI. Menyimpannya sebagai satu nilai global
    # berarti admin yang memilih tema gelap ikut menggelapkan panel semua
    # orang. Jadi kuncinya diberi ruang nama per pengguna.
    return f'{key}:{uid}'


def display_get(uid):
    out = {}
    for key, spec in DISPLAY_SPEC.items():
        raw = db.kv_get('display_settings', _display_key(key, uid))
        try:
            out[key] = _coerce(spec, raw) if raw is not None else spec['default']
        except ValueError:
            out[key] = spec['default']
    return out


def display_set(patch, actor, ip=''):
    uid = actor['id']
    clean = {}
    for key, raw in (patch or {}).items():
        if key not in DISPLAY_SPEC:
            continue
        clean[key] = _coerce(DISPLAY_SPEC[key], raw)
    for key, val in clean.items():
        db.kv_set('display_settings', _display_key(key, uid), val, actor)
    if clean:
        db.audit('display_settings.update',
                 '; '.join(f'{k}={v}' for k, v in clean.items()), actor, ip)
    return display_get(uid)


# ═══════════════════════════════════════════════════════════════
#  Koneksi ACS
# ═══════════════════════════════════════════════════════════════
def acs_get(include_secret=False):
    r = db.conn().execute('SELECT * FROM acs_connection_settings WHERE id=1').fetchone()
    if not r:
        row = dict(ACS_DEFAULT)
        row.update({'last_test_status': 'belum diuji', 'last_test_at': '',
                    'last_test_message': '', 'updated_at': '', 'updated_by': ''})
    else:
        row = dict(r)
        row.pop('id', None)
    row['auth_enabled'] = bool(row.get('auth_enabled'))
    # Rahasia tak pernah ikut ke browser tanpa diminta eksplisit; yang dikirim
    # hanya FAKTA bahwa rahasianya ada, supaya form bisa menampilkan "tersimpan".
    row['auth_secret_set'] = bool(row.get('auth_secret'))
    if not include_secret:
        row.pop('auth_secret', None)
    row['url'] = build_url(row)
    return row


def build_url(cfg):
    proto = cfg.get('protocol') or 'http'
    host = cfg.get('host') or '127.0.0.1'
    port = int(cfg.get('port') or 7557)
    base = (cfg.get('base_path') or '').strip('/')
    url = f'{proto}://{host}:{port}'
    if base:
        url += '/' + base
    return url


def validate_acs(cfg):
    """Melempar ValueError bila konfigurasi tidak sah."""
    if cfg.get('protocol') not in ('http', 'https'):
        raise ValueError('Protokol harus http atau https')
    host = (cfg.get('host') or '').strip()
    if not host:
        raise ValueError('Host tidak boleh kosong')
    # Host diselipkan ke URL lalu dipanggil server (SSRF). Tolak apa pun yang
    # bisa menyelundupkan skema/path/kredensial ke dalamnya.
    if any(ch in host for ch in ('/', '\\', ' ', '@', '?', '#', ':')):
        raise ValueError('Host tidak boleh memuat / \\ spasi @ ? # atau :')
    try:
        port = int(cfg.get('port'))
    except (TypeError, ValueError):
        raise ValueError('Port harus berupa angka')
    if not (1 <= port <= 65535):
        raise ValueError('Port harus 1–65535')
    if cfg.get('auth_enabled') and not (cfg.get('auth_username') or '').strip():
        raise ValueError('Username wajib diisi bila autentikasi NBI diaktifkan')
    return True


def acs_set(patch, actor=None, ip=''):
    cur = acs_get(include_secret=True)
    new = {
        'protocol':      (patch.get('protocol') or cur.get('protocol') or 'http'),
        'host':          str(patch.get('host', cur.get('host'))).strip(),
        'port':          patch.get('port', cur.get('port')),
        'base_path':     str(patch.get('base_path', cur.get('base_path') or '')).strip(),
        'auth_enabled':  1 if patch.get('auth_enabled') else 0,
        'auth_username': str(patch.get('auth_username', cur.get('auth_username') or '')).strip(),
    }
    validate_acs(new)

    # Rahasia hanya ditimpa bila BENAR-BENAR dikirim. Form menampilkan rahasia
    # sebagai kosong (tidak pernah dikirim balik ke browser) — tanpa aturan ini,
    # menyimpan perubahan host akan diam-diam menghapus kredensialnya.
    if 'auth_secret' in patch and patch['auth_secret'] != '':
        new['auth_secret'] = str(patch['auth_secret'])
    else:
        new['auth_secret'] = cur.get('auth_secret') or ''
    if not new['auth_enabled']:
        new['auth_secret'] = ''
        new['auth_username'] = ''

    c = db.conn()
    c.execute('''INSERT INTO acs_connection_settings
                    (id, protocol, host, port, base_path, auth_enabled, auth_username,
                     auth_secret, updated_at, updated_by)
                 VALUES (1,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                    protocol=excluded.protocol, host=excluded.host, port=excluded.port,
                    base_path=excluded.base_path, auth_enabled=excluded.auth_enabled,
                    auth_username=excluded.auth_username, auth_secret=excluded.auth_secret,
                    updated_at=excluded.updated_at, updated_by=excluded.updated_by''',
              (new['protocol'], new['host'], int(new['port']), new['base_path'],
               new['auth_enabled'], new['auth_username'], new['auth_secret'],
               db.now(), (actor or {}).get('username', '')))
    c.commit()

    before, after = build_url(cur), build_url(new)
    detail = f'{before} → {after}' if before != after else f'{after} (auth diperbarui)'
    db.audit('acs_connection.update', detail, actor, ip)
    return acs_get()


def acs_url():
    """Target proxy. Dibaca tiap permintaan agar perubahan langsung berlaku
    tanpa restart server."""
    try:
        return build_url(acs_get())
    except Exception:
        return build_url(ACS_DEFAULT)


def acs_auth_header():
    cfg = acs_get(include_secret=True)
    if not cfg.get('auth_enabled') or not cfg.get('auth_username'):
        return None
    import base64
    raw = f'{cfg["auth_username"]}:{cfg.get("auth_secret") or ""}'.encode()
    return 'Basic ' + base64.b64encode(raw).decode()


# ─── Test Connection ──────────────────────────────────────────────
def acs_test(cfg, actor=None, ip='', timeout=6):
    """Uji koneksi NYATA ke host/port pada FORM, bukan ke konfigurasi tersimpan.

    Membedakan JENIS kegagalannya, karena itulah yang menentukan langkah
    berikutnya bagi operator: 'connection refused' berarti port salah atau
    layanannya mati; 'timeout' berarti paketnya ditelan firewall; 'host tidak
    ditemukan' berarti salah ketik nama. Pesan 'gagal' tunggal tidak memberi
    tahu apa pun.

    Selalu mengembalikan dict — tidak melempar — supaya UI selalu punya sesuatu
    untuk ditampilkan.
    """
    try:
        validate_acs(cfg)
    except ValueError as e:
        return _test_done('gagal', 'invalid', str(e), actor, ip, save=False)

    url = build_url(cfg)
    # projection=_id WAJIB, bukan optimasi.
    #
    # Tanpa itu, NBI mengirim SELURUH pohon parameter perangkat: satu ONU F663NV9
    # di jaringan ini = 228 KB. Uji koneksi tidak butuh satu byte pun dari isinya
    # — hanya butuh tahu bahwa yang menjawab benar-benar NBI. Dengan projection,
    # jawabannya 41 byte.
    #
    # Ini bukan hipotesis: versi pertama fungsi ini membaca 64 KB pertama lalu
    # mem-parse-nya. JSON 228 KB yang terpotong di 64 KB otomatis gagal di-parse,
    # sehingga GenieACS yang SEHAT dilaporkan sebagai "bukan NBI". Lolos di semua
    # tes (NBI palsu menjawab JSON mungil) dan hanya ketahuan saat diuji ke
    # server sungguhan.
    target = url + '/devices/?limit=1&projection=_id'
    req = urllib.request.Request(target, method='GET')

    if cfg.get('auth_enabled') and (cfg.get('auth_username') or '').strip():
        import base64
        secret = cfg.get('auth_secret')
        if secret in (None, ''):
            # Form mengirim rahasia kosong = "jangan ubah" → pakai yang tersimpan.
            secret = acs_get(include_secret=True).get('auth_secret') or ''
        raw = f'{cfg["auth_username"]}:{secret}'.encode()
        req.add_header('Authorization', 'Basic ' + base64.b64encode(raw).decode())

    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            # Batas tetap ada (jawaban tak dikenal tak boleh menghabiskan RAM),
            # tapi kini jauh di atas jawaban NBI yang sah agar tidak memotong
            # JSON yang benar. Lihat catatan projection di atas.
            body = resp.read(2 * 1024 * 1024)
            ms = int((time.perf_counter() - t0) * 1000)
            try:
                data = json.loads(body)
                n = len(data) if isinstance(data, list) else '?'
                extra = f', {n} perangkat terbaca'
            except Exception:
                # 200 tapi bukan JSON = hampir pasti bukan NBI (mis. UI GenieACS
                # di port 3000, atau halaman login proxy). Jangan sebut sukses.
                return _test_done(
                    'gagal', 'bukan-nbi',
                    f'HTTP {resp.status} tapi jawabannya bukan JSON — '
                    f'{url} sepertinya bukan NBI GenieACS (NBI biasanya di port 7557).',
                    actor, ip)
            return _test_done('sukses', 'ok',
                              f'HTTP {resp.status} dalam {ms} ms{extra}.', actor, ip)

    except urllib.error.HTTPError as e:
        ms = int((time.perf_counter() - t0) * 1000)
        if e.code in (401, 403):
            msg = (f'HTTP {e.code} — NBI menolak kredensial. '
                   'Aktifkan autentikasi NBI dan isi username/password yang benar.')
            return _test_done('gagal', 'auth', msg, actor, ip)
        if e.code == 404:
            msg = (f'HTTP 404 — terhubung, tapi endpoint /devices tidak ada. '
                   f'Periksa Base Path, atau {url} bukan NBI GenieACS.')
            return _test_done('gagal', 'not-found', msg, actor, ip)
        return _test_done('gagal', 'http',
                          f'HTTP {e.code} {e.reason} dari {url} ({ms} ms).', actor, ip)

    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, socket.timeout):
            return _test_done('gagal', 'timeout',
                              f'Timeout setelah {timeout} detik — {url} tidak menjawab. '
                              'Biasanya paket ditelan firewall, atau host salah.',
                              actor, ip)
        if isinstance(reason, socket.gaierror):
            return _test_done('gagal', 'dns',
                              f'Host "{cfg.get("host")}" tidak ditemukan (DNS gagal). '
                              'Periksa ejaan nama host, atau pakai alamat IP.',
                              actor, ip)
        if isinstance(reason, ConnectionRefusedError) or 'refused' in str(reason).lower():
            return _test_done('gagal', 'refused',
                              f'Koneksi ditolak — {url} dapat dijangkau, tapi tidak ada '
                              'yang mendengarkan di port itu. Periksa port (NBI = 7557) '
                              'dan apakah layanan GenieACS berjalan.',
                              actor, ip)
        return _test_done('gagal', 'network', f'Gagal menghubungi {url}: {reason}', actor, ip)

    except socket.timeout:
        return _test_done('gagal', 'timeout',
                          f'Timeout setelah {timeout} detik — {url} tidak menjawab.',
                          actor, ip)
    except Exception as e:
        return _test_done('gagal', 'error', f'Gagal: {e}', actor, ip)


def _test_done(status, kind, message, actor, ip, save=True):
    if save:
        try:
            c = db.conn()
            c.execute('''INSERT INTO acs_connection_settings (id, last_test_status,
                             last_test_at, last_test_message)
                         VALUES (1,?,?,?)
                         ON CONFLICT(id) DO UPDATE SET
                             last_test_status=excluded.last_test_status,
                             last_test_at=excluded.last_test_at,
                             last_test_message=excluded.last_test_message''',
                      (status, db.now(), message))
            c.commit()
        except Exception:
            pass
    db.audit('acs_connection.test', f'{status} ({kind}): {message[:120]}', actor, ip)
    return {'status': status, 'kind': kind, 'message': message, 'at': db.now()}


# ═══════════════════════════════════════════════════════════════
#  Impor sekali jalan dari config.json
# ═══════════════════════════════════════════════════════════════
def import_legacy_config(path=None):
    """config.json → tabel, sekali jalan.

    Tanpa ini, migrasi ke DB akan mengembalikan target proxy ke default
    127.0.0.1:7557 dan diam-diam memutus panel yang NBI-nya di mesin lain.
    """
    path = path or os.path.join(DIRECTORY, 'config.json')
    c = db.conn()
    has_acs = c.execute('SELECT COUNT(*) AS n FROM acs_connection_settings').fetchone()['n']
    has_par = c.execute('SELECT COUNT(*) AS n FROM app_parameters').fetchone()['n']
    if has_acs and has_par:
        return 0
    if not os.path.exists(path):
        return 0
    try:
        with open(path) as f:
            legacy = json.load(f)
    except Exception:
        return 0

    n = 0
    if not has_acs:
        u = urllib.parse.urlparse(str(legacy.get('acsUrl') or ''))
        if u.scheme in ('http', 'https') and u.hostname:
            acs_set({
                'protocol': u.scheme, 'host': u.hostname,
                'port': u.port or (443 if u.scheme == 'https' else 7557),
                'base_path': (u.path or '').strip('/'),
                'auth_enabled': bool(legacy.get('acsUser')),
                'auth_username': legacy.get('acsUser') or '',
                # acsPass memang tak pernah tersimpan di config.json (by design
                # versi lama), jadi tak ada yang bisa dipindahkan.
                'auth_secret': '',
            })
            n += 1

    if not has_par:
        patch = {k: legacy[k] for k in PARAM_SPEC if k in legacy}
        if patch:
            try:
                params_set(patch)
                n += 1
            except ValueError:
                pass

    if n:
        db.audit('system.migrate', f'config.json diimpor ke SQLite ({n} bagian)')
        try:
            os.replace(path, path + '.imported')
        except Exception:
            pass
    return n


# ═══════════════════════════════════════════════════════════════
#  Pemetaan VirtualParameter  (lihat js/vpmap.js)
# ═══════════════════════════════════════════════════════════════
# Tiap pemasangan GenieACS menamai VP-nya sendiri dan cakupannya tak seragam
# antar firmware, jadi tiap field dipetakan ke RANTAI kandidat, bukan satu nama.
#
# Bawaannya hidup di js/vpmap.js — di sanalah ia dipakai. Yang disimpan di sini
# HANYA hasil suntingan operator. Selama belum pernah disunting, kunci ini tidak
# ada dan panel memakai bawaan; itu sengaja, supaya pembaruan bawaan tidak
# tertimpa salinan basi di basis data.
VP_MAPPING_KEY = 'vpMapping'

# Harus sama persis dengan Object.keys(VPMap.BAWAAN.fields) di js/vpmap.js.
# Dijaga oleh tests/vpmap.test.py — kalau salah satu berubah sendiri, uji gagal.
VP_FIELDS = (
    'rxPower', 'txPower', 'suhu', 'ponMode', 'ipTr069', 'pppoeUser',
    'pppoePass', 'ipPppoe', 'vlan', 'wlanPass', 'uptime', 'pppUptime',
    'klienAktif', 'ponMac', 'pppoeMac', 'serial',
)
VP_TRANSFORMASI = ('teks', 'angka', 'dbm', 'bool', 'mac')
VP_TURUNAN      = ('hostConnectionRequest', 'deviceIdSerial', 'idSerial')
VP_AWALAN       = ('VirtualParameters.', 'InternetGatewayDevice.', 'Device.')
VP_MAKS_SUMBER  = 12


def vp_validate(mapping):
    """Kembalikan pesan galat, atau None bila sah.

    Ditegakkan DI SERVER, bukan hanya di formulir: formulir bisa dilewati, dan
    pemetaan yang cacat membuat seluruh halaman perangkat menampilkan '—' tanpa
    ada yang tahu sebabnya.
    """
    if not isinstance(mapping, dict):
        return 'Pemetaan harus berupa objek'
    fields = mapping.get('fields')
    if not isinstance(fields, dict) or not fields:
        return 'Pemetaan tidak punya "fields"'
    for key, f in fields.items():
        if key not in VP_FIELDS:
            return f'Field tidak dikenal: {key}'
        if not isinstance(f, dict):
            return f'Field {key} harus berupa objek'
        sumber = f.get('sumber') or f.get('sources')
        if not isinstance(sumber, list) or not sumber:
            return f'Field {key} harus punya minimal satu sumber'
        if len(sumber) > VP_MAKS_SUMBER:
            return f'Field {key} punya terlalu banyak sumber (maks {VP_MAKS_SUMBER})'
        for s in sumber:
            if not isinstance(s, str) or not s.strip():
                return f'Sumber kosong pada field {key}'
            if s.startswith('@'):
                if s[1:] not in VP_TURUNAN:
                    return f'Sumber turunan tidak dikenal: {s}'
                continue
            if ',' in s:
                return f'Sumber tidak boleh mengandung koma: {s}'
            if not s.startswith(VP_AWALAN):
                return ('Sumber harus diawali VirtualParameters., '
                        f'InternetGatewayDevice., atau Device. — dapat: {s}')
        tr = f.get('transform')
        if tr and tr not in VP_TRANSFORMASI:
            return f'Transformasi tidak dikenal pada {key}: {tr}'
    return None


def vp_get():
    """Pemetaan tersimpan, atau None bila operator belum pernah menyuntingnya."""
    raw = db.kv_get('app_parameters', VP_MAPPING_KEY, None)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        # Baris rusak tidak boleh mematikan halaman perangkat — jatuh ke bawaan.
        return None


def vp_set(mapping, actor=None, ip=''):
    """Simpan pemetaan. Kirim None/{} untuk kembali ke bawaan."""
    if mapping in (None, {}) or not (mapping or {}).get('fields'):
        db.kv_set('app_parameters', VP_MAPPING_KEY, '', actor=actor)
        db.audit('vpmap.reset', 'pemetaan VP dikembalikan ke bawaan',
                 actor=actor, ip=ip)
        return None
    problem = vp_validate(mapping)
    if problem:
        raise ValueError(problem)
    db.kv_set('app_parameters', VP_MAPPING_KEY, json.dumps(mapping), actor=actor)
    db.audit('vpmap.set',
             'field disunting: ' + ', '.join(sorted(mapping['fields'].keys())),
             actor=actor, ip=ip)
    return mapping
