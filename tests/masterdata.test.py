#!/usr/bin/env python3
"""Uji Master Data (PRD sub menu maps & data odc §3) lewat HTTP sungguhan.

Dua hal yang dijaga di sini, dan keduanya bukan soal tampilan:

  1. PAGAR TULIS. Angka redaman di tabel ini adalah acuan SETIAP diagram ODC.
     Satu angka yang keliru tidak memunculkan galat apa pun — ia hanya
     menghasilkan daya yang berbeda, di semua diagram sekaligus, tanpa jejak.
     Jadi menulis harus tertutup untuk role `user`, dan penolakannya diuji
     lewat endpoint langsung (curl-style), bukan lewat menu yang disembunyikan.

  2. VALIDASI DI SERVER. Form bisa dilewati. Rasio '10/95' atau redaman
     tertukar (merah > biru) harus ditolak di sini, bukan hanya di layar.

  3. HAPUS TIDAK DIAM-DIAM. Menghapus yang masih dipakai menjawab 409 beserta
     rincian terdampak; baru dengan ?force=1 benar-benar terhapus. Membedakan
     409 dari 400 penting supaya klien tak perlu mencocokkan teks pesan.
"""
import os, sys, json, time, socket, tempfile, subprocess
import urllib.request, urllib.error, http.cookiejar

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

PORT = free_port()
TMP  = tempfile.mkdtemp(prefix='skymd-')
DB   = os.path.join(TMP, 'sky.db')
CFG  = os.path.join(TMP, 'config.json')

boot = f'''
import sys, os
sys.path.insert(0, {os.path.join(ROOT, 'backend')!r})
import db, auth
auth.DATA_DIR   = {TMP!r}
auth.USERS_PATH = os.path.join({TMP!r}, 'users.json')
db.set_path({DB!r})
pw = auth.ensure_bootstrap()
print('BOOTPW=' + pw, flush=True)
import server
srv = server.ThreadingHTTPServer(('127.0.0.1', {PORT}), server.SPAHandler)
srv.daemon_threads = True
srv.serve_forever()
'''
env = dict(os.environ, SKY_CONFIG=CFG)
proc = subprocess.Popen([sys.executable, '-c', boot], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, cwd=ROOT, env=env)
BOOTPW = None
t0 = time.time()
while time.time() - t0 < 15:
    line = proc.stdout.readline()
    if line.startswith('BOOTPW='):
        BOOTPW = line.strip().split('=', 1)[1]; break
    if proc.poll() is not None:
        print('server mati saat start:\n' + proc.stdout.read()); sys.exit(1)
if not BOOTPW:
    print('gagal membaca password bootstrap'); proc.kill(); sys.exit(1)

for _ in range(60):
    try:
        socket.create_connection(('127.0.0.1', PORT), 0.25).close(); break
    except OSError:
        time.sleep(0.1)

BASE = f'http://127.0.0.1:{PORT}'


def client():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def call(op, path, method='GET', body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with op.open(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}


try:
    adm = client()
    st, d = call(adm, '/auth/login', 'POST', {'username': 'admin', 'password': BOOTPW})
    ok(st == 200, 'administrator bisa login')

    st, d = call(adm, '/auth/users', 'POST', {
        'username': 'teknisi', 'password': 'Tekn#Kuat2026', 'name': 'Teknisi',
        'email': 't@x.id', 'phone': '081200000000', 'role': 'user'})
    ok(st == 200, 'akun role user dibuat')
    usr = client()
    st, _ = call(usr, '/auth/login', 'POST', {'username': 'teknisi', 'password': 'Tekn#Kuat2026'})
    ok(st == 200, 'role user bisa login')

    # ══ Seed ══
    st, d = call(adm, '/config/master')
    ok(st == 200, 'GET /config/master hidup')
    ok(len(d['tap']) == 14, 'seed 14 rasio tap coupler terpasang (tabel spesifikasi Sky Tech)')
    ok(len(d['plc']) == 6,  'seed 6 PLC splitter terpasang')
    ok(d['olt'] == [] and d['pon'] == [], 'OLT & PON mulai kosong (data lapangan, bukan seed)')
    t1090 = [r for r in d['tap'] if r['rasio'] == '10/90'][0]
    ok(t1090['loss_biru'] == 10.32 and t1090['loss_merah'] == 0.65,
       'seed 10/90 memakai angka tabel spesifikasi: biru 10.32 dB, merah 0.65 dB')
    # Gambar sumbernya menulis redaman bertanda MINUS. Kolomnya menyimpan
    # BESARNYA saja — kalau tandanya ikut tersimpan, tiap splitter justru
    # MENAMBAH daya, dan hasilnya tetap tampak seperti angka yang wajar.
    ok(all(r['loss_biru'] > 0 and r['loss_merah'] > 0 for r in d['tap']),
       'redaman disimpan sebagai besaran positif, bukan angka negatif dari gambar')
    ok(all(r['loss_biru'] >= r['loss_merah'] for r in d['tap']),
       'porsi kecil (biru) selalu rugi daya >= porsi besar (merah) di SELURUH tabel')
    for rr in ('2/98', '3/97', '8/92'):
        ok(any(r['rasio'] == rr for r in d['tap']), 'rasio ' + rr + ' ikut terpasang')
    ok([r['rasio'] for r in d['tap']] ==
       ['1/99','2/98','3/97','5/95','8/92','10/90','15/85','20/80',
        '25/75','30/70','35/65','40/60','45/55','50/50'],
       'seluruh rasio terurut dari porsi terkecil ke terbesar')
    ok(all(r['created_at'] for r in d['tap']), 'baris seed punya stempel waktu, bukan string kosong')

    # ══ Membaca terbuka untuk semua yang sudah login ══
    st, d2 = call(usr, '/config/master')
    ok(st == 200 and len(d2['tap']) == 14,
       'role user BOLEH membaca Master Data (dibutuhkan saat menelusuri jalur)')
    st, _ = call(client(), '/config/master')
    ok(st == 401, 'tanpa login DITOLAK')

    # ══ Menulis hanya administrator — diuji lewat endpoint langsung ══
    for jenis, body in [('olt', {'nama': 'OLT-SELUNDUP'}),
                        ('tap', {'rasio': '50/50', 'loss_biru': 3.6, 'loss_merah': 3.6}),
                        ('plc', {'rasio': '1:128', 'loss_db': 24}),
                        ('pon', {'olt_id': 1, 'nama': 'PON 9/9'})]:
        st, _ = call(usr, '/config/master/' + jenis, 'POST', body)
        ok(st == 403, 'role user DITOLAK menambah ' + jenis + ' (endpoint langsung)')
    st, _ = call(usr, '/config/master/tap/1', 'DELETE')
    ok(st == 403, 'role user DITOLAK menghapus rasio')
    st, _ = call(usr, '/config/master/tap/1', 'POST', {'rasio': '10/90', 'loss_biru': 1, 'loss_merah': 1})
    ok(st == 403, 'role user DITOLAK mengubah rasio yang ada')

    # ══ Validasi ditegakkan di server ══
    # Tiap kasus memakai rasio yang BELUM ada di seed. Kalau memakai '10/90',
    # penolakannya datang dari indeks unik ("sudah ada") dan menutupi validasi
    # yang sebenarnya sedang diuji — status 400-nya benar, sebabnya salah.
    # Dua sabotase sempat lolos persis karena itu.
    TOLAK = [
        ({'rasio': '10/95', 'loss_biru': 10.5, 'loss_merah': 0.7}, 'total bukan 100%',       '100%'),
        ({'rasio': '60/40', 'loss_biru': 3,    'loss_merah': 2},   'angka pertama bukan porsi kecil', 'KECIL'),
        ({'rasio': 'sepuluh', 'loss_biru': 1,  'loss_merah': 1},   'rasio bukan angka',      'kecil/besar'),
        ({'rasio': '18/82', 'loss_biru': 0.9,  'loss_merah': 8.7}, 'redaman biru & merah tertukar', 'tertukar'),
        # Nol/negatif diuji pada kolom MERAH, bukan biru. Kalau biru dibuat 0,
        # cek "tertukar" yang lebih dulu berjalan ikut menolaknya — dan
        # pesannya memuat "(0.00 dB)" sehingga tetap cocok dengan petunjuk
        # apa pun soal nol. Satu sabotase lolos persis lewat celah itu.
        ({'rasio': '22/78', 'loss_biru': 6.6,  'loss_merah': 0},   'redaman 0 dB',    'lebih besar dari 0'),
        ({'rasio': '28/72', 'loss_biru': 5.8,  'loss_merah': -5},  'redaman negatif', 'lebih besar dari 0'),
        ({'rasio': '33/67', 'loss_biru': 999,  'loss_merah': 1.2}, 'redaman di luar batas wajar', 'maksimal'),
        ({'rasio': '42/58', 'loss_biru': 'abc','loss_merah': 1.2}, 'redaman bukan angka',    'angka'),
    ]
    for body, label, petunjuk in TOLAK:
        st, d = call(adm, '/config/master/tap', 'POST', body)
        pesan = d.get('error', '')
        ok(st == 400 and pesan, 'ditolak (400) + alasan: ' + label)
        # Isi pesannya ikut diperiksa: tanpa ini, penolakan karena sebab LAIN
        # (mis. duplikat) tetap menghijaukan tes.
        ok(petunjuk.lower() in pesan.lower(),
           'alasannya memang soal "' + label + '", bukan sebab lain — pesan: ' + pesan[:70])
        st, d = call(adm, '/config/master')
        ok(not any(r['rasio'] == body['rasio'] for r in d['tap']),
           'baris yang ditolak TIDAK tersimpan: ' + str(body['rasio']))

    st, d = call(adm, '/config/master/tap', 'POST',
                 {'rasio': '10/90', 'loss_biru': 10.5, 'loss_merah': 0.7})
    ok(st == 400 and 'sudah ada' in d.get('error', ''), 'rasio duplikat ditolak dengan kalimat yang jelas')

    st, d = call(adm, '/config/master/tap', 'POST',
                 {'rasio': ' 12 / 88 ', 'loss_biru': 9.1, 'loss_merah': 0.9})
    ok(st == 200 and d['row']['rasio'] == '12/88', 'spasi di sekitar rasio dinormalkan')
    TAP_BARU = d['row']['id']

    for body, label in [({'rasio': '1:9999', 'loss_db': 10}, 'PLC melebihi batas port'),
                        ({'rasio': '1:1', 'loss_db': 3},     'PLC 1:1 bukan pembagi'),
                        ({'rasio': '2:8', 'loss_db': 10},    'PLC bukan bentuk 1:N')]:
        st, _ = call(adm, '/config/master/plc', 'POST', body)
        ok(st == 400, 'ditolak: ' + label)

    st, d = call(adm, '/config/master/plc', 'POST', {'rasio': '1:128', 'loss_db': 24.5})
    ok(st == 200 and d['row']['jumlah_port'] == 128,
       'jumlah port diturunkan dari rasio, bukan diisi terpisah')

    # ══ OLT & PON ══
    st, d = call(adm, '/config/master/olt', 'POST', {'nama': 'OLT-SKY-01', 'keterangan': 'Jimbaran'})
    ok(st == 200, 'OLT dibuat')
    OLT = d['row']['id']
    st, d = call(adm, '/config/master/olt', 'POST', {'nama': 'olt-sky-01'})
    ok(st == 400 and 'sudah ada' in d.get('error', ''),
       'nama OLT unik tanpa peduli besar-kecil huruf (satu perangkat, satu entri)')
    st, _ = call(adm, '/config/master/olt', 'POST', {'nama': '   '})
    ok(st == 400, 'nama OLT kosong ditolak')

    st, d = call(adm, '/config/master/pon', 'POST', {'olt_id': OLT, 'nama': 'PON 1/3'})
    ok(st == 200, 'PON dibuat')
    PON = d['row']['id']
    st, _ = call(adm, '/config/master/pon', 'POST', {'olt_id': OLT, 'nama': 'PON 1/3'})
    ok(st == 400, 'PON duplikat pada OLT yang sama ditolak')
    st, d = call(adm, '/config/master/olt', 'POST', {'nama': 'OLT-SKY-02'})
    OLT2 = d['row']['id']
    st, _ = call(adm, '/config/master/pon', 'POST', {'olt_id': OLT2, 'nama': 'PON 1/3'})
    ok(st == 200, 'nama PON yang sama BOLEH ada di OLT berbeda (unik per OLT)')
    st, _ = call(adm, '/config/master/pon', 'POST', {'olt_id': 99999, 'nama': 'PON X'})
    ok(st == 400, 'PON dengan OLT induk tak dikenal ditolak')

    st, d = call(adm, '/config/master')
    o1 = [r for r in d['olt'] if r['id'] == OLT][0]
    ok(o1['jumlah_pon'] == 1, 'jumlah PON dihitung server, bukan satu query per baris di klien')
    ok(all('olt_nama' in r for r in d['pon']), 'daftar PON membawa nama OLT induknya')

    # ══ Hapus: 409 + rincian dampak, lalu force ══
    st, d = call(adm, '/config/master/olt/' + str(OLT), 'DELETE')
    ok(st == 409, 'menghapus OLT yang punya PON menjawab 409 (bukan 400) — perlu konfirmasi')
    imp = d.get('impact') or {}
    ok(imp.get('jenis') == 'pon' and imp.get('jumlah') == 1, 'rincian dampak menyebut jenis & jumlah')
    ok('PON 1/3' in (imp.get('daftar') or []), 'rincian menyebut NAMA yang akan ikut terhapus')

    st, d = call(adm, '/config/master')
    ok(any(r['id'] == OLT for r in d['olt']), 'OLT MASIH ADA setelah 409 — tidak terhapus diam-diam')

    st, d = call(adm, '/config/master/olt/' + str(OLT) + '?force=1', 'DELETE')
    ok(st == 200 and d.get('pon_terhapus') == 1, 'dengan force: terhapus beserta PON-nya')
    st, d = call(adm, '/config/master')
    ok(not any(r['id'] == OLT for r in d['olt']), 'OLT benar-benar hilang')
    ok(not any(r['id'] == PON for r in d['pon']), 'PON anaknya ikut hilang, tidak jadi baris yatim')

    # Rasio belum dipakai topologi mana pun → hapus langsung, tanpa 409.
    st, _ = call(adm, '/config/master/tap/' + str(TAP_BARU), 'DELETE')
    ok(st == 200, 'rasio yang belum dipakai terhapus tanpa konfirmasi tambahan')

    # ══ Bentuk permintaan yang salah ══
    st, _ = call(adm, '/config/master/entahapa', 'POST', {'nama': 'x'})
    ok(st == 404, 'jenis master data tak dikenal → 404')
    st, _ = call(adm, '/config/master/tap/999999', 'DELETE')
    ok(st == 400, 'menghapus id yang tidak ada → 400, bukan 500')
    st, _ = call(adm, '/config/master/tap/999999', 'POST', {'rasio': '10/90', 'loss_biru': 2, 'loss_merah': 1})
    ok(st == 400, 'mengubah id yang tidak ada → 400')
    st, _ = call(adm, '/config/master/tap', 'DELETE')
    ok(st == 400, 'menghapus tanpa id → 400')

    # ══ Jejak audit ══
    st, d = call(adm, '/auth/audit?limit=200')
    aksi = {r['action'] for r in (d.get('entries') or [])}
    ok(st == 200 and aksi, 'endpoint audit menjawab dengan entri')
    ok(any(a.startswith('masterdata.') for a in aksi),
       'perubahan Master Data tercatat di audit log')
    ok('access.denied' in aksi, 'percobaan role user menembus pagar ikut tercatat')

finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print('masterdata: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
