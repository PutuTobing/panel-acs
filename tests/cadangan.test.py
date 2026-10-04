#!/usr/bin/env python3
"""Uji cadangan basis data — otomatis harian + unduhan terenkripsi (2026-10-03).

YANG DIJAGA:
  1. Cadangan = salinan utuh satu berkas, TANPA sesi login (token sesi tersimpan apa
     adanya; cadangan yang bocor tidak boleh menjadi kunci masuk). Basis data yang
     sedang dipakai tidak tersentuh.
  2. Sekali sehari, simpan 14 terakhir; hanya berkas milik modul ini yang dipangkas.
     Cadangan yang gagal di tengah tidak meninggalkan berkas yang tampak sah.
  3. Unduhan terenkripsi (AES-256, kata sandi diketik administrator): isinya tak terbaca
     tanpa kata sandi, terbuka dengan perintah yang didokumentasikan, kata sandi tidak
     dicatat & tidak lewat argumen proses, berkas polos sementara selalu dihapus.
  4. Hanya administrator, dan password akunnya diminta lagi (dibatasi seperti login).

DB sementara; tidak menyentuh data/sky.db maupun GenieACS.
"""
import os, sys, json, time, gzip, sqlite3, tempfile, threading, subprocess, http.client

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db, auth
TMP = tempfile.mkdtemp(prefix='skycad-')
auth.DATA_DIR = TMP
db.set_path(os.path.join(TMP, 'sky.db'))
db.init()
import cadangan, config_store

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

ADM = auth.create_user('admin.cad', 'Admin#Cad-2026x', 'Admin', role='administrator')
STF = auth.create_user('teknisi.cad', 'Teknisi#Cad-2026', 'Teknisi', role='user')
PEL = auth.create_user('pelanggan.cad', 'Pelanggan123', 'Pelanggan', role='pelanggan')
TOKEN = auth.create_session(ADM['id'], '10.0.0.9')
F = cadangan.folder()

# ══ 1. Satu cadangan ══
ok(F == os.path.join(TMP, 'backup'), 'folder cadangan = data/backup di samping basis data')
p = cadangan.buat('otomatis')
nama = os.path.basename(p)
ok(os.path.isfile(p) and cadangan._RE_NAMA.match(nama) and nama.endswith('.db.gz') and os.listdir(F) == [nama],
   'cadangan ditulis sebagai SATU berkas dimampatkan sky-otomatis-<tanggal>-<jam>.db.gz — %r' % os.listdir(F))
# Dimampatkan (2026-10-04): 14 cadangan harian tidak boleh memakan 14× ukuran basis data.
isi_polos = gzip.open(p, 'rb').read()
ok(os.path.getsize(p) < len(isi_polos) / 2, 'cadangan dimampatkan: %d byte dari %d byte' % (os.path.getsize(p), len(isi_polos)))
polos = os.path.join(TMP, 'polos.db')
open(polos, 'wb').write(isi_polos)
c = sqlite3.connect(polos)
ok(c.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 3 and c.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 0,
   'isi cadangan: akun utuh, tabel sesi KOSONG')
ok(c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok' and c.execute('PRAGMA journal_mode').fetchone()[0] == 'delete',
   'cadangan lolos integrity_check dan bukan mode WAL (tak ada berkas -wal/-shm tertinggal)')
c.close()
ok(TOKEN.encode() not in isi_polos, 'token sesi tidak tersisa di berkas cadangan (termasuk di halaman kosong)')
ok(db.conn().execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 1 and auth.get_session_user(TOKEN),
   'basis data yang sedang dipakai tidak tersentuh: sesi tetap hidup')
if os.name != 'nt':
    ok(oct(os.stat(p).st_mode & 0o777) == '0o600' and oct(os.stat(F).st_mode & 0o777) == '0o700',
       'izin berkas 0600 di folder 0700')

# ══ 2. Jadwal & pemangkasan ══
ok(cadangan.perlu_otomatis() is False and cadangan.perlu_otomatis(time.time() + cadangan.JEDA_DETIK + 60) is True,
   'baru dicadangkan → belum perlu; sesudah sehari → perlu')
ok(cadangan.jalankan_bila_perlu() is None and len(os.listdir(F)) == 1, 'penjaga tidak mencadangkan dua kali dalam sehari')
os.remove(p)
ok(cadangan.perlu_otomatis() is True, 'belum ada cadangan → perlu')
# 20 cadangan lama (satu per hari) + berkas lain yang BUKAN milik modul ini
for i in range(20):
    open(os.path.join(F, 'sky-otomatis-202609%02d-020000.db' % (i + 1)), 'wb').write(b'x')
for lain in ('sky-20260901-010101.db', 'antrean-20260901.json', 'sky-sebelum-update-20260901-010101.db', 'sky-otomatis-catatan.txt'):
    open(os.path.join(F, lain), 'wb').write(b'y')
baru = cadangan.jalankan_bila_perlu()
oto = [b['nama'] for b in cadangan.daftar('otomatis')]
ok(bool(baru) and len(oto) == cadangan.SIMPAN == 14 and oto[0] == os.path.basename(baru)
   and oto[-1] == 'sky-otomatis-20260908-020000.db',
   'sesudah cadangan baru: 14 terbaru disimpan, yang lebih lama dihapus — %r' % oto[-2:])
ok(all(os.path.exists(os.path.join(F, x)) for x in ('sky-20260901-010101.db', 'antrean-20260901.json',
                                                     'sky-sebelum-update-20260901-010101.db', 'sky-otomatis-catatan.txt')),
   'berkas lain di folder itu (cadangan manual, JSON Kesehatan ACS, sebelum-update) tidak disentuh')
ok(any(r['action'] == 'cadangan.otomatis' and r['detail'] == os.path.basename(baru) for r in db.audit_list(limit=20)),
   'cadangan otomatis tercatat di Log')
ok(cadangan.daftar('otomatis')[0]['waktu'][:4] == time.strftime('%Y') and cadangan.daftar('otomatis')[0]['ukuran'] > 1000,
   'daftar memuat waktu & ukuran')
# gagal di tengah → tak ada berkas yang tampak sah, dan galatnya terlihat
asli = cadangan._salin
def rusak(tujuan):
    open(tujuan, 'wb').write(b'setengah jadi')
    raise OSError('disk penuh (tiruan)')
cadangan._salin = rusak
sebelum = sorted(os.listdir(F))
hasil = cadangan.jalankan_bila_perlu(time.time() + cadangan.JEDA_DETIK + 60)
cadangan._salin = asli
ok(hasil is None and sorted(os.listdir(F)) == sebelum and 'disk penuh' in cadangan.galat_terakhir,
   'cadangan yang gagal tidak meninggalkan berkas (.tmp dibuang) dan galatnya dilaporkan: %r' % cadangan.galat_terakhir)
ok(cadangan.ringkasan()['galat'] and cadangan.ringkasan()['simpan'] == 14, 'ringkasan untuk Settings memuat galat & jumlah simpan')
cadangan.galat_terakhir = ''

# ── Ruang disk: cadangan tidak boleh menjadi penyebab disk penuh ──
ruang_asli = cadangan.ruang
cadangan.ruang = lambda: (10 * 1024 * 1024, 20 * 1024 ** 3)            # tersisa 10 MB
hasil = cadangan.jalankan_bila_perlu(time.time() + cadangan.JEDA_DETIK + 60)
ok(hasil is None and sorted(os.listdir(F)) == sebelum and 'ruang disk tersisa 10 MB' in cadangan.galat_terakhir,
   'disk hampir penuh → cadangan DILEWATI dan dilaporkan: %r' % cadangan.galat_terakhir)
cadangan.ruang = ruang_asli
cadangan.galat_terakhir = ''
r = cadangan.ringkasan()
ok(r['dbUkuran'] > 0 and r['diskBebas'] > 0 and r['diskTotal'] >= r['diskBebas'] and r['cadanganUkuran'] > 0 and r['logBaris'] > 0,
   'ringkasan memuat ukuran basis data, total cadangan, sisa disk, dan jumlah catatan Log')

# ── Perawatan harian: Log lama dipangkas, sesi kedaluwarsa dibuang ──
c = db.conn()
lama = time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(time.time() - 400 * 86400))
for i in range(5):
    c.execute("INSERT INTO audit_log (username, role, action, detail, ip_address, created_at) VALUES ('lama', '', 'uji.lama', ?, '', ?)", (str(i), lama))
c.execute("INSERT INTO sessions (id, user_id, token, ip_address, user_agent, created_at, last_seen, expires_at) VALUES ('basi', ?, 'token-basi', '', '', 1, 1, 2)", (ADM['id'],))
c.commit()
n_baru = c.execute("SELECT COUNT(*) FROM audit_log WHERE action != 'uji.lama'").fetchone()[0]
ok(config_store.params_get()['logSimpanHari'] == 365, 'bawaan: Log disimpan 365 hari')
config_store.params_set({'logSimpanHari': 0}, ADM)
cadangan.rawat()
ok(c.execute("SELECT COUNT(*) FROM audit_log WHERE action = 'uji.lama'").fetchone()[0] == 5, 'Simpan Log = 0 → tidak ada yang dipangkas (selamanya)')
ok(c.execute("SELECT COUNT(*) FROM sessions WHERE id = 'basi'").fetchone()[0] == 0 and auth.get_session_user(TOKEN),
   'perawatan harian membuang sesi kedaluwarsa; sesi yang hidup tetap')
config_store.params_set({'logSimpanHari': 365}, ADM)
cadangan.rawat()
ok(c.execute("SELECT COUNT(*) FROM audit_log WHERE action = 'uji.lama'").fetchone()[0] == 0
   and c.execute("SELECT COUNT(*) FROM audit_log WHERE action NOT IN ('uji.lama', 'log.pangkas', 'app_parameters.update')").fetchone()[0] >= n_baru - 2,
   'Simpan Log = 365 hari → catatan berumur 400 hari dipangkas, yang baru tetap')
ok(any(r['action'] == 'log.pangkas' and '5 catatan' in r['detail'] for r in db.audit_list(limit=10)), 'pemangkasan itu sendiri tercatat di Log')
try:
    config_store.params_set({'logSimpanHari': -5}, ADM); ok(False, 'nilai negatif harus ditolak')
except ValueError:
    ok(True, 'Simpan Log di luar 0–3650 ditolak server')

# ══ 3. Unduhan terenkripsi ══
SANDI = 'Kata Sandi #Cadangan-2026'
ok(all(cadangan.sandi_bermasalah(s) for s in ('pendek', 'x' * 129, 'sandi\nbaris dua 123', 'sandiÄÖ12345678', ' spasi di depan 1', None, 12345678901))
   and cadangan.sandi_bermasalah(SANDI) is None, 'kata sandi cadangan: 10–128 karakter ASCII tercetak, tanpa spasi di ujung')
src = open(os.path.join(ROOT, 'backend', 'cadangan.py'), encoding='utf-8').read()
ok("'-pass', 'stdin'" in src and 'input=(sandi' in src and 'pass:' not in src and "'-k'" not in src,
   'kata sandi diberikan ke openssl lewat STDIN, bukan argumen proses')
ok(cadangan.ITER_PBKDF2 >= 600000 and '-aes-256-cbc' in src and '-pbkdf2' in src, 'AES-256 + PBKDF2 ≥ 600.000 putaran')
OPENSSL = cadangan.cari_openssl()
if not OPENSSL:
    print('  (openssl tidak ditemukan — pemeriksaan isi berkas terenkripsi dilewati)')
    try:
        cadangan.unduh_terenkripsi(SANDI); ok(False, 'tanpa openssl harus ditolak')
    except cadangan.CadanganError as e:
        ok('openssl' in str(e), 'tanpa openssl: ditolak dengan penjelasan')
else:
    isi_folder = sorted(os.listdir(F))
    nama_enc, isi = cadangan.unduh_terenkripsi(SANDI)
    ok(nama_enc.startswith('sky-cadangan-') and nama_enc.endswith('.db.enc') and isi.startswith(b'Salted__'),
       'berkas unduhan: sky-cadangan-<waktu>.db.enc berformat openssl')
    ok(b'SQLite format' not in isi and b'admin.cad' not in isi and b'scrypt' not in isi, 'isi berkas tidak terbaca tanpa kata sandi')
    ok(sorted(os.listdir(F)) == isi_folder, 'berkas polos sementara dihapus dari server')
    enc, buka = os.path.join(TMP, nama_enc), os.path.join(TMP, 'buka.db')
    open(enc, 'wb').write(isi)
    # Perintah yang DITAMPILKAN kepada administrator harus benar-benar membuka berkasnya.
    perintah = cadangan.perintah_buka(enc).split()
    ok(perintah[:3] == ['openssl', 'enc', '-d'] and perintah[-2:] == ['-out', 'sky.db'], 'perintah buka berbentuk openssl enc -d … -out sky.db')
    cmd = [OPENSSL] + perintah[1:-1] + [buka, '-pass', 'stdin']
    r = subprocess.run(cmd, input=(SANDI + '\n').encode(), capture_output=True)
    c = sqlite3.connect(buka)
    ok(r.returncode == 0 and c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
       and [x[0] for x in c.execute('SELECT username FROM users ORDER BY username')] == ['admin.cad', 'pelanggan.cad', 'teknisi.cad']
       and c.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 0,
       'dengan kata sandi yang benar: basis data utuh, tanpa sesi')
    c.close()
    r = subprocess.run(cmd[:-3] + [os.path.join(TMP, 'salah.db'), '-pass', 'stdin'], input=b'kata sandi salah 123\n', capture_output=True)
    salah = open(os.path.join(TMP, 'salah.db'), 'rb').read() if os.path.exists(os.path.join(TMP, 'salah.db')) else b''
    ok(r.returncode != 0 or not salah.startswith(b'SQLite format'), 'kata sandi salah → tidak terbuka')
    try:
        cadangan.unduh_terenkripsi('pendek'); ok(False, 'kata sandi pendek harus ditolak')
    except cadangan.CadanganError:
        ok(sorted(os.listdir(F)) == isi_folder, 'kata sandi pendek ditolak sebelum apa pun ditulis')

# ══ 4. Lewat server ══
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': 1, 'base_path': ''})     # port mati
import server
ok(cadangan._thread is None, 'mengimpor server TIDAK menyalakan penjaga cadangan (hanya saat panel dijalankan)')
srv = server.buat_server('127.0.0.1', 0)
server.SPAHandler.log_message = lambda *a, **k: None
threading.Thread(target=srv.serve_forever, daemon=True).start()
PORT = srv.server_address[1]

def minta(metode, path, ck=None, body=None, kepala=None):
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=60)
    hd = {'Content-Type': 'application/json'}
    if ck: hd['Cookie'] = ck
    hd.update(kepala or {})
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=hd)
    r = c.getresponse(); raw = r.read(); kep = dict(r.getheaders()); c.close()
    try: d = json.loads(raw)
    except Exception: d = {}
    return r.status, d, kep, raw
def login(u, pw):
    st, d, kep, _ = minta('POST', '/auth/login', None, {'username': u, 'password': pw})
    assert st == 200, (u, st, d)
    return kep['Set-Cookie'].split(';')[0]
try:
    cka, ckt, ckp = login('admin.cad', 'Admin#Cad-2026x'), login('teknisi.cad', 'Teknisi#Cad-2026'), login('pelanggan.cad', 'Pelanggan123')
    st, d, _, _ = minta('GET', '/config/cadangan', cka)
    ok(st == 200 and len(d['otomatis']) == 14 and d['simpan'] == 14 and d['enkripsi'] == bool(OPENSSL) and '<berkas>' in d['perintahBuka'],
       'administrator melihat keadaan cadangan')
    ok(minta('GET', '/config/cadangan', ckt)[0] == 403 and minta('GET', '/config/cadangan', ckp)[0] == 403
       and minta('GET', '/config/cadangan')[0] == 401, 'role user & pelanggan 403, tanpa sesi 401')
    B = {'sandi': SANDI, 'password': 'Admin#Cad-2026x'}
    ok(minta('POST', '/config/cadangan/unduh', ckt, dict(B, password='Teknisi#Cad-2026'))[0] == 403
       and minta('POST', '/config/cadangan/unduh', ckp, dict(B, password='Pelanggan123'))[0] == 403
       and minta('POST', '/config/cadangan/unduh', None, B)[0] == 401, 'unduh: hanya administrator')
    # Penolakan dikirim SEBELUM isi permintaan dibaca. Dulu di Windows klien kadang menerima
    # "connection aborted" alih-alih jawabannya (uji ini gagal ±1 dari 3 kali). Server kini
    # membuang sisa isi permintaan dulu (_habiskan_body). CATATAN JUJUR: gejalanya soal
    # waktu — pemeriksaan ini menjaga perilakunya, tetapi TIDAK selalu gagal bila
    # perbaikannya dicabut (dicoba 2026-10-04: tetap lulus sekali).
    besar = {'sandi': 'x' * 200000, 'password': 'y'}
    kode = []
    for ck in (None, ckt, ckp) * 3:
        try: kode.append(minta('POST', '/config/cadangan/unduh', ck, besar)[0])
        except OSError as e: kode.append(type(e).__name__)
    ok(kode == [401, 403, 403] * 3, 'penolakan tetap sampai ke klien walau isi permintaan besar belum dibaca — %r' % kode)
    st, d, _, _ = minta('POST', '/config/cadangan/unduh', cka, B, {'Sec-Fetch-Site': 'cross-site'})
    ok(st == 403, 'permintaan dari situs lain ditolak (tak bisa dipicu halaman jebakan)')
    ok(minta('GET', '/config/cadangan/unduh', cka)[0] in (404, 405), 'unduhan hanya lewat POST — kata sandi tak pernah di alamat')
    st, d, _, raw = minta('POST', '/config/cadangan/unduh', cka, dict(B, password='salah-total'))
    ok(st == 403 and 'Password akun' in d.get('error', '') and not raw.startswith(b'Salted__'), 'password akun salah → 403, tak ada berkas')
    ok(any(r['action'] == 'access.denied' and 'unduh cadangan' in r['detail'] and r['username'] == 'admin.cad' for r in db.audit_list(limit=30)),
       'percobaan dengan password salah tercatat')
    st, d, _, _ = minta('POST', '/config/cadangan/unduh', cka, dict(B, sandi='pendek'))
    ok(st == 400 and 'minimal' in d.get('error', ''), 'kata sandi cadangan terlalu pendek → 400 berpenjelasan')
    if OPENSSL:
        st, d, kep, raw = minta('POST', '/config/cadangan/unduh', cka, B)
        ok(st == 200 and kep.get('Content-Type') == 'application/octet-stream' and raw.startswith(b'Salted__')
           and kep.get('Content-Disposition', '').startswith('attachment; filename="sky-cadangan-')
           and 'no-store' in kep.get('Cache-Control', ''), 'unduhan: berkas terenkripsi sebagai lampiran, tidak di-cache')
        jejak = [r for r in db.audit_list(limit=30) if r['action'] == 'cadangan.unduh']
        ok(len(jejak) == 1 and jejak[0]['username'] == 'admin.cad' and 'terenkripsi' in jejak[0]['detail'], 'unduhan tercatat di Log')
        ok(SANDI not in json.dumps(db.audit_list(limit=200)) and 'Admin#Cad' not in json.dumps(db.audit_list(limit=200)),
           'kata sandi cadangan & password akun tidak pernah tercatat')
    # pembatas percobaan (sama dengan login)
    for _ in range(auth.LOGIN_MAX_PER_USER + 1):
        st, d, _, _ = minta('POST', '/config/cadangan/unduh', cka, dict(B, password='tebak-tebakan'))
    ok(st == 429, 'menebak password akun lewat unduhan dibatasi (429) — dapat %d' % st)
finally:
    srv.shutdown(); srv.server_close()

# ══ 5. Halaman ══
html = open(os.path.join(ROOT, 'frontend', 'pages', 'settings.html'), encoding='utf-8').read()
js = open(os.path.join(ROOT, 'frontend', 'js', 'settings.js'), encoding='utf-8').read()
import re
kartu = re.search(r'<div[^>]*id="cadKartu"[^>]*>', html)
ok(bool(kartu) and 'data-admin-only' in kartu.group(0) and 'id="cadModal"' in html, 'kartu Cadangan Data khusus administrator')
ok(all(('id="%s"' % i) in html and 'type="password"' in html.split('id="%s"' % i)[0].rsplit('<input', 1)[1] for i in ('cadSandi', 'cadSandi2', 'cadPassword')),
   'ketiga isian kata sandi bertipe password')
fn = js.split('async function unduhCadangan')[1].split('\n}\n')[0]
ok("method: 'POST'" in fn and 'localStorage' not in fn and 'sessionStorage' not in fn and "_setVal(id, '')" in fn,
   'browser mengirim kata sandi lewat POST, tidak menyimpannya, dan mengosongkan isian sesudah unduh')
main_src = open(os.path.join(ROOT, 'backend', 'server.py'), encoding='utf-8').read()
ok(main_src.index("if __name__ == '__main__':") < main_src.index('cadangan.mulai_penjaga()'), 'penjaga cadangan dinyalakan saat panel dijalankan')

print(f'cadangan: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
