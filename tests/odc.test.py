#!/usr/bin/env python3
"""Uji Data ODC — topologi FTTH — lewat HTTP sungguhan.

Yang dijaga di sini bukan tampilan, melainkan hal-hal yang salahnya TIDAK
memunculkan galat apa pun, hanya angka yang berbeda:

  1. ATURAN SAMBUNGAN. Keluaran merah = porsi besar (backbone) → isinya ODP.
     Keluaran biru = porsi kecil → isinya splitter. Tertukar berarti seluruh
     sisa jalur kehilangan dayanya, dan diagramnya tetap tergambar rapi.

  2. SATU SERAT SATU TUJUAN. Dua node tidak boleh menempel di keluaran yang
     sama; kalau bisa, dayanya terhitung dua kali.

  3. KALKULASI BERANTAI. Daya harus merambat dari PON sampai port terjauh,
     dan status IDEAL/CUKUP/LEMAH mengikuti Ambang RX Power yang SUDAH ADA
     — bukan ambang kedua yang bisa berbeda diam-diam.

  4. HAPUS TIDAK DIAM-DIAM. Menghapus node bercabang menjawab 409 + rincian.
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
TMP  = tempfile.mkdtemp(prefix='skyodc-')
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
BOOTPW, t0 = None, time.time()
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
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

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
    call(adm, '/auth/login', 'POST', {'username': 'admin', 'password': BOOTPW})
    call(adm, '/auth/users', 'POST', {
        'username': 'teknisi', 'password': 'Tekn#Kuat2026', 'name': 'T',
        'email': 't@x.id', 'phone': '081200000000', 'role': 'user'})
    usr = client()
    call(usr, '/auth/login', 'POST', {'username': 'teknisi', 'password': 'Tekn#Kuat2026'})

    st, md = call(adm, '/config/master')
    TAP = {r['rasio']: r['id'] for r in md['tap']}
    PLC = {r['rasio']: r['id'] for r in md['plc']}
    st, d = call(adm, '/config/master/olt', 'POST', {'nama': 'OLT-SKY-01'})
    OLT = d['row']['id']
    st, d = call(adm, '/config/master/pon', 'POST', {'olt_id': OLT, 'nama': 'PON 1/3'})
    PON = d['row']['id']
    st, d = call(adm, '/config/master/olt', 'POST', {'nama': 'OLT-LAIN'})
    OLT2 = d['row']['id']

    # ══ Daftar & pembuatan ══
    st, d = call(adm, '/config/odc')
    ok(st == 200 and d['items'] == [], 'daftar ODC mulai kosong')

    st, d = call(adm, '/config/odc', 'POST',
                 {'nama': 'ODC-JIMBARAN', 'olt_id': OLT, 'pon_id': PON, 'input_dbm': 7.35})
    ok(st == 200, 'ODC dibuat')
    ODC = d['odc']['id']
    ok(d['odc']['input_dbm'] == 7.35, 'input power tersimpan sebagai angka')

    st, d = call(adm, '/config/odc', 'POST', {'nama': 'odc-jimbaran', 'olt_id': OLT})
    ok(st == 400 and 'sudah ada' in d.get('error', ''), 'nama ODC unik tanpa peduli besar-kecil huruf')

    # PON milik OLT lain harus ditolak — di layar keduanya nama yang sah,
    # jadi hanya server yang bisa menangkapnya.
    st, d = call(adm, '/config/odc', 'POST', {'nama': 'ODC-SALAH', 'olt_id': OLT2, 'pon_id': PON})
    ok(st == 400 and 'bukan milik' in d.get('error', ''), 'PON milik OLT lain DITOLAK')

    for bad, lbl in [({'nama': '', 'olt_id': OLT}, 'nama kosong'),
                     ({'nama': 'X', 'olt_id': OLT, 'input_dbm': 999}, 'input di luar batas wajar'),
                     ({'nama': 'X', 'olt_id': OLT, 'input_dbm': 'abc'}, 'input bukan angka')]:
        st, _ = call(adm, '/config/odc', 'POST', bad)
        ok(st == 400, 'ditolak: ' + lbl)

    # ══ Pagar tulis ══
    st, _ = call(usr, '/config/odc', 'POST', {'nama': 'ODC-SELUNDUP', 'olt_id': OLT})
    ok(st == 403, 'role user DITOLAK membuat ODC (endpoint langsung)')
    st, _ = call(usr, '/config/odc/%d/node' % ODC, 'POST', {'tipe': 'odp', 'nama': 'X'})
    ok(st == 403, 'role user DITOLAK menambah node')
    st, d = call(usr, '/config/odc/%d' % ODC)
    ok(st == 200, 'role user BOLEH membaca topologi')
    st, _ = call(client(), '/config/odc')
    ok(st == 401, 'tanpa login DITOLAK')

    # ══ Membangun pohon ══
    st, d = call(adm, '/config/odc/%d/node' % ODC,
                 'POST', {'tipe': 'odp', 'nama': 'ODP-01', 'tap_id': TAP['10/90'], 'core': 1})
    ok(st == 200, 'ODP akar dibuat')
    A = d['node']['id']

    st, d = call(adm, '/config/odc/%d/node' % ODC, 'POST',
                 {'tipe': 'odp', 'nama': 'ODP-02', 'tap_id': TAP['20/80'],
                  'parent_id': A, 'parent_port': 'merah', 'core': 2})
    ok(st == 200, 'ODP kedua disambung dari keluaran merah')
    B = d['node']['id']

    st, d = call(adm, '/config/odc/%d/node' % ODC, 'POST',
                 {'tipe': 'splitter', 'plc_id': PLC['1:16'], 'parent_id': A, 'parent_port': 'biru'})
    ok(st == 200, 'splitter ujung disambung dari keluaran biru')
    S = d['node']['id']

    st, d = call(adm, '/config/odc/%d/node' % ODC, 'POST',
                 {'tipe': 'splitter_odc', 'plc_id': PLC['1:4'], 'parent_id': B, 'parent_port': 'biru'})
    ok(st == 200, 'splitter ODC (distribusi) disambung dari biru')
    D = d['node']['id']

    st, d = call(adm, '/config/odc/%d/node' % ODC, 'POST',
                 {'tipe': 'odp', 'nama': 'ODP-03', 'tap_id': TAP['50/50'],
                  'parent_id': D, 'parent_port': 'p2'})
    ok(st == 200, 'port splitter ODC bisa menuju ODP lain')

    # ══ Aturan sambungan ══
    TOLAK = [
        ({'tipe': 'splitter', 'plc_id': PLC['1:8'], 'parent_id': B, 'parent_port': 'merah'},
         'splitter di keluaran MERAH', 'merah'),
        ({'tipe': 'odp', 'nama': 'X', 'tap_id': TAP['50/50'], 'parent_id': B, 'parent_port': 'biru'},
         'ODP di keluaran BIRU', 'biru'),
        ({'tipe': 'odp', 'nama': 'X', 'tap_id': TAP['50/50'], 'parent_id': S, 'parent_port': 'p1'},
         'ODP di port splitter UJUNG', 'pelanggan'),
        ({'tipe': 'odp', 'nama': 'X', 'tap_id': TAP['50/50'], 'parent_id': D, 'parent_port': 'p9'},
         'port melebihi jumlah splitter', '4 port'),
        ({'tipe': 'odp', 'nama': 'X', 'tap_id': TAP['50/50'], 'parent_id': A, 'parent_port': 'merah'},
         'keluaran yang sudah terpakai', 'terpakai'),
        ({'tipe': 'odp', 'nama': 'X', 'tap_id': TAP['50/50']},
         'akar kedua (satu PON satu serat)', 'satu serat'),
        ({'tipe': 'splitter', 'plc_id': PLC['1:8']},
         'splitter langsung di PON', 'Hanya ODP'),
        ({'tipe': 'entahapa', 'parent_id': A, 'parent_port': 'biru'},
         'jenis node tak dikenal', 'tidak dikenal'),
    ]
    for body, lbl, petunjuk in TOLAK:
        st, d = call(adm, '/config/odc/%d/node' % ODC, 'POST', body)
        pesan = d.get('error', '')
        ok(st == 400, 'ditolak: ' + lbl)
        # Isi pesannya ikut diperiksa — tanpa ini, penolakan karena sebab LAIN
        # tetap menghijaukan tes.
        ok(petunjuk.lower() in pesan.lower(),
           'alasannya memang "' + lbl + '" — pesan: ' + pesan[:60])

    # ══ Kalkulasi berantai ══
    st, d = call(adm, '/config/odc/%d' % ODC)
    ok(st == 200 and d['pohon'], 'topologi terbaca beserta hasil hitung')
    node = {n['id']: n for n in d['nodes']}

    # 10/90 → merah 0.65 dB, biru 10.32 dB (dari tabel spesifikasi Sky Tech)
    ok(node[A]['in_dbm'] == 7.35, 'akar menerima input power apa adanya')
    ok(abs(node[A]['out_merah'] - 6.70) < .01, 'ODP-01 merah = 7.35 − 0.65 = 6.70')
    ok(abs(node[A]['out_biru'] + 2.97) < .01,  'ODP-01 biru  = 7.35 − 10.32 = −2.97')
    ok(abs(node[B]['in_dbm'] - 6.70) < .01, 'ODP-02 menerima dari keluaran MERAH induknya')
    ok(abs(node[S]['in_dbm'] + 2.97) < .01, 'splitter menerima dari keluaran BIRU induknya')
    ok(abs(node[S]['out_dbm'] + 16.67) < .01, 'port splitter = −2.97 − 13.70 = −16.67')
    ok(len(node[S]['ports']) == 16, '1:16 menghasilkan 16 port')
    ok(all(p['status'] == 'ideal' for p in node[S]['ports']),
       '−16.67 dBm dinilai IDEAL (memakai Ambang RX Power yang sudah ada)')
    ok(abs(node[D]['out_dbm'] + 7.77) < .01, 'splitter distribusi meneruskan daya ke portnya')

    g = d['ringkasan']
    ok(g['odp'] == 3 and g['splitter'] == 2, 'ringkasan menghitung ODP & splitter')
    ok(g['ideal'] == 16,
       'HANYA port splitter UJUNG yang dinilai — port distribusi masih di tengah jalan')
    ok(d['ambang']['ideal'] == -20 and d['ambang']['cukup'] == -25,
       'ambang diambil dari Parameter Aplikasi, bukan angka tertanam')
    ok(d['ambang']['overload'] == -8, 'ada batas ATAS: terlalu kuat membuat penerima ONU jenuh')

    # Mengubah input power harus merambat ke SELURUH hilir.
    call(adm, '/config/odc/%d' % ODC, 'POST',
         {'nama': 'ODC-JIMBARAN', 'olt_id': OLT, 'pon_id': PON, 'input_dbm': 3.0})
    st, d2 = call(adm, '/config/odc/%d' % ODC)
    n2 = {n['id']: n for n in d2['nodes']}
    ok(abs(n2[S]['out_dbm'] + 21.02) < .01,
       'mengubah input power merambat sampai port terjauh (−21.02)')
    ok(all(p['status'] == 'cukup' for p in n2[S]['ports']),
       'statusnya ikut berubah IDEAL → CUKUP tanpa menyentuh node mana pun')
    call(adm, '/config/odc/%d' % ODC, 'POST',
         {'nama': 'ODC-JIMBARAN', 'olt_id': OLT, 'pon_id': PON, 'input_dbm': 7.35})

    # Rasio belum dipilih → dayanya None, BUKAN 0. Nol adalah nilai sah.
    st, d = call(adm, '/config/odc', 'POST', {'nama': 'ODC-KOSONG', 'olt_id': OLT, 'input_dbm': 5})
    K = d['odc']['id']
    call(adm, '/config/odc/%d/node' % K, 'POST', {'tipe': 'odp', 'nama': 'ODP-X'})
    st, d = call(adm, '/config/odc/%d' % K)
    ok(d['pohon']['out_merah'] is None,
       'ODP tanpa rasio → daya null, bukan 0 (0 dBm adalah nilai yang sah)')

    # ══ Mengecilkan splitter tidak boleh memutus cabang ══
    st, d = call(adm, '/config/odc/%d/node/%d' % (ODC, D), 'POST',
                 {'tipe': 'splitter_odc', 'plc_id': PLC['1:2']})
    ok(st == 200, '1:4 → 1:2 boleh selama port yang terpakai (p2) masih ada')
    call(adm, '/config/odc/%d/node/%d' % (ODC, D), 'POST',
         {'tipe': 'splitter_odc', 'plc_id': PLC['1:8']})
    st, d = call(adm, '/config/odc/%d/node' % ODC, 'POST',
                 {'tipe': 'odp', 'nama': 'ODP-JAUH', 'tap_id': TAP['50/50'],
                  'parent_id': D, 'parent_port': 'p7'})
    ok(st == 200, 'port p7 tersambung pada splitter 1:8')
    st, d = call(adm, '/config/odc/%d/node/%d' % (ODC, D), 'POST',
                 {'tipe': 'splitter_odc', 'plc_id': PLC['1:4']})
    ok(st == 400 and 'p7' in d.get('error', ''),
       'mengecilkan splitter DITOLAK bila ada port terpakai di luar jangkauan baru')

    # ══ Hapus ══
    st, d = call(adm, '/config/odc/%d/node/%d' % (ODC, A), 'DELETE')
    ok(st == 409, 'menghapus node bercabang menjawab 409, bukan langsung hapus')
    ok((d.get('impact') or {}).get('jumlah', 0) >= 4, 'rincian menyebut jumlah turunan')
    st, d = call(adm, '/config/odc/%d' % ODC)
    ok(d['pohon'] is not None, 'topologi MASIH utuh setelah 409')

    st, d = call(adm, '/config/odc/%d/node/%d?force=1' % (ODC, A), 'DELETE')
    ok(st == 200 and d['turunan_terhapus'] >= 4, 'dengan force: node + seluruh turunannya hilang')
    st, d = call(adm, '/config/odc/%d' % ODC)
    ok(d['pohon'] is None and d['nodes'] == [], 'tidak ada node yatim yang tertinggal')

    st, d = call(adm, '/config/odc/%d' % K, 'DELETE')
    ok(st == 409, 'menghapus ODC yang berisi node minta konfirmasi')
    st, d = call(adm, '/config/odc/%d?force=1' % K, 'DELETE')
    ok(st == 200, 'dengan force: ODC terhapus')
    st, d = call(adm, '/config/odc/%d' % K)
    ok(st == 400, 'ODC yang sudah dihapus tidak bisa dibaca lagi')

    # ══ Master Data kini tahu dirinya dipakai ══
    st, d = call(adm, '/config/odc', 'POST', {'nama': 'ODC-PAKAI', 'olt_id': OLT, 'input_dbm': 6})
    P = d['odc']['id']
    call(adm, '/config/odc/%d/node' % P, 'POST',
         {'tipe': 'odp', 'nama': 'ODP-P', 'tap_id': TAP['30/70']})
    st, d = call(adm, '/config/master/tap/%d' % TAP['30/70'], 'DELETE')
    ok(st == 409, 'rasio yang dipakai topologi tidak bisa dihapus tanpa konfirmasi')
    ok('ODC-PAKAI' in ((d.get('impact') or {}).get('daftar') or []),
       'Master Data menyebut NAMA ODC yang memakainya')

    # ══ Bentuk permintaan salah ══
    st, _ = call(adm, '/config/odc/999999')
    ok(st == 400, 'ODC tak dikenal → 400, bukan 500')
    st, _ = call(adm, '/config/odc/%d/node/999999' % P, 'DELETE')
    ok(st == 400, 'node tak dikenal → 400')
    st, _ = call(adm, '/config/odc', 'DELETE')
    ok(st == 400, 'menghapus tanpa id → 400')

    # ══ Posisi node yang digeser ══
    st, d = call(adm, '/config/odc/%d' % P)
    NP = d['pohon']['id']
    ok(d['pohon']['pos_x'] is None,
       'node baru belum punya posisi — NULL berarti "ikut tata letak otomatis"')

    st, d = call(adm, '/config/odc/%d/node/%d/pos' % (P, NP), 'POST', {'x': 420, 'y': 133.5})
    ok(st == 200 and d['pos_x'] == 420 and d['pos_y'] == 133.5, 'posisi tersimpan')
    st, d = call(adm, '/config/odc/%d' % P)
    ok(d['pohon']['pos_x'] == 420, 'posisi ikut terbaca saat topologi dimuat')

    # 0 WAJIB tersimpan sebagai 0, bukan diperlakukan sebagai "kosong" —
    # pojok kiri-atas adalah tempat yang sah untuk sebuah kartu.
    st, d = call(adm, '/config/odc/%d/node/%d/pos' % (P, NP), 'POST', {'x': 0, 'y': 0})
    ok(st == 200 and d['pos_x'] == 0, 'koordinat 0 tersimpan sebagai 0, bukan NULL')

    for bad, lbl in [({'x': 'abc', 'y': 1}, 'posisi bukan angka'),
                     ({'x': 1}, 'posisi tidak lengkap'),
                     ({'x': 1e9, 'y': 0}, 'posisi di luar batas wajar')]:
        st, _ = call(adm, '/config/odc/%d/node/%d/pos' % (P, NP), 'POST', bad)
        ok(st == 400, 'ditolak: ' + lbl)

    st, _ = call(usr, '/config/odc/%d/node/%d/pos' % (P, NP), 'POST', {'x': 5, 'y': 5})
    ok(st == 403, 'role user DITOLAK menggeser node')

    # Menggeser TIDAK boleh menyeret validasi node — ODP tanpa rasio pun
    # harus tetap bisa dipindah.
    st, d = call(adm, '/config/odc/%d/node' % P, 'POST',
                 {'tipe': 'odp', 'nama': 'ODP-TANPA-RASIO',
                  'parent_id': NP, 'parent_port': 'merah'})
    TR = d['node']['id']
    st, _ = call(adm, '/config/odc/%d/node/%d/pos' % (P, TR), 'POST', {'x': 10, 'y': 20})
    ok(st == 200, 'node yang rasionya belum dipilih tetap bisa digeser')

    st, d = call(adm, '/config/odc/%d/rapikan' % P, 'POST')
    ok(st == 200 and d['direset'] == 2, 'Rapikan mengembalikan node yang digeser ke otomatis')
    st, d = call(adm, '/config/odc/%d' % P)
    ok(d['pohon']['pos_x'] is None, 'setelah Rapikan posisinya NULL lagi')
    st, d = call(adm, '/config/odc/%d/rapikan' % P, 'POST')
    ok(st == 200 and d['direset'] == 0, 'Rapikan pada topologi yang sudah otomatis: aman, 0 node')
    st, _ = call(usr, '/config/odc/%d/rapikan' % P, 'POST')
    ok(st == 403, 'role user DITOLAK merapikan')

    # ══ Slot kosong untuk tombol "Add ODP" di pojok kanan ══
    st, d = call(adm, '/config/odc/%d/slot' % P)
    ok(st == 200, 'daftar slot kosong tersedia')
    lab = [s['label'] for s in d['slot']]
    ok(not any('jalur utama' in l for l in lab),
       'akar yang sudah terisi TIDAK ditawarkan lagi')
    ok(any('Output 1' in l for l in lab), 'keluaran merah yang kosong ditawarkan')

    st, d = call(adm, '/config/odc/%d/slot' % ODC)
    ok(any('PON' in s['label'] for s in d['slot']),
       'topologi kosong menawarkan PON sebagai titik sambung pertama')

    # Splitter ODC membuka port baru; splitter UJUNG tidak — portnya milik
    # pelanggan, bukan tempat menyambung ODP.
    st, d = call(adm, '/config/odc', 'POST', {'nama': 'ODC-SLOT', 'olt_id': OLT, 'input_dbm': 6})
    SL = d['odc']['id']
    st, d = call(adm, '/config/odc/%d/node' % SL, 'POST',
                 {'tipe': 'odp', 'nama': 'ODP-S', 'tap_id': TAP['10/90']})
    SA = d['node']['id']
    call(adm, '/config/odc/%d/node' % SL, 'POST',
         {'tipe': 'splitter', 'plc_id': PLC['1:8'], 'parent_id': SA, 'parent_port': 'biru'})
    st, d = call(adm, '/config/odc/%d/slot' % SL)
    ok(not any('Port' in s['label'] for s in d['slot']),
       'port splitter UJUNG tidak pernah ditawarkan sebagai titik sambung')

    st, d = call(adm, '/config/odc', 'POST', {'nama': 'ODC-SLOT2', 'olt_id': OLT, 'input_dbm': 6})
    SL2 = d['odc']['id']
    st, d = call(adm, '/config/odc/%d/node' % SL2, 'POST',
                 {'tipe': 'odp', 'nama': 'ODP-T', 'tap_id': TAP['10/90']})
    TA = d['node']['id']
    call(adm, '/config/odc/%d/node' % SL2, 'POST',
         {'tipe': 'splitter_odc', 'plc_id': PLC['1:4'], 'parent_id': TA, 'parent_port': 'biru'})
    st, d = call(adm, '/config/odc/%d/slot' % SL2)
    ok(len([s for s in d['slot'] if 'Port' in s['label']]) == 4,
       'splitter ODC 1:4 membuka tepat 4 titik sambung baru')

    # ══ Mode ODP: rasio (tap) vs langsung PLC ══
    st, d = call(adm, '/config/odc', 'POST', {'nama': 'ODC-MODE', 'olt_id': OLT, 'input_dbm': 5})
    MD = d['odc']['id']
    st, d = call(adm, '/config/odc/%d/node' % MD, 'POST',
                 {'tipe': 'odp', 'nama': 'MD-01', 'tap_id': TAP['10/90']})
    D1 = d['node']['id']
    ok(d['node']['mode'] == 'tap', 'ODP bawaan tetap mode "tap" — perilaku lama tak berubah')

    st, d = call(adm, '/config/odc/%d/node' % MD, 'POST',
                 {'tipe': 'odp', 'nama': 'MD-AKHIR', 'mode': 'plc', 'plc_id': PLC['1:8'],
                  'parent_id': D1, 'parent_port': 'merah'})
    ok(st == 200 and d['node']['mode'] == 'plc', 'ODP bisa dibuat dengan mode langsung PLC')
    DA = d['node']['id']

    st, d = call(adm, '/config/odc/%d' % MD)
    n = {x['id']: x for x in d['nodes']}
    # 10/90 merah = 0.65 dB → 5 − 0.65 = 4.35 ; PLC 1:8 = 10.5 dB → −6.15
    ok(abs(n[DA]['in_dbm'] - 4.35) < .01, 'ODP langsung menerima daya dari keluaran merah induknya')
    ok(abs(n[DA]['out_dbm'] + 6.15) < .01, 'dayanya dikurangi redaman PLC: 4.35 − 10.50 = −6.15')
    ok(n[DA]['out_merah'] is None and n[DA]['out_biru'] is None,
       'ODP langsung TIDAK punya keluaran merah/biru — seratnya habis dibagi')
    ok(len(n[DA]['ports']) == 8, '1:8 menghasilkan 8 port pelanggan')
    ok(d['ringkasan']['kuat'] == 8,
       'port −6.15 dBm dinilai TERLALU KUAT (di atas batas jenuh −8) dan ikut dihitung')

    # Titik akhir tidak boleh disambung lagi — cabang di bawahnya akan
    # tergambar rapi dengan daya yang tidak pernah benar-benar ada.
    for port, lbl in [('merah', 'keluaran merah'), ('biru', 'keluaran biru')]:
        st, d = call(adm, '/config/odc/%d/node' % MD, 'POST',
                     {'tipe': 'odp', 'nama': 'X', 'tap_id': TAP['50/50'],
                      'parent_id': DA, 'parent_port': port})
        ok(st == 400 and 'pelanggan' in d.get('error', ''),
           'menyambung ke ' + lbl + ' ODP-langsung DITOLAK')

    st, d = call(adm, '/config/odc/%d/slot' % MD)
    ok(not any('MD-AKHIR' in s2['label'] for s2 in d['slot']),
       'ODP langsung tidak pernah ditawarkan sebagai titik sambung')

    # Berganti mode saat masih bercabang memutus cabangnya tanpa suara.
    st, d = call(adm, '/config/odc/%d/node/%d' % (MD, D1), 'POST',
                 {'tipe': 'odp', 'nama': 'MD-01', 'mode': 'plc', 'plc_id': PLC['1:4']})
    ok(st == 409 and 'membawahi' in d.get('error', ''),
       'mengubah mode ODP yang masih bercabang DITOLAK, dengan rincian')
    st, d = call(adm, '/config/odc/%d' % MD)
    ok({x['id']: x for x in d['nodes']}[D1]['mode'] == 'tap',
       'modenya tidak berubah setelah penolakan')

    st, _ = call(adm, '/config/odc/%d/node/%d' % (MD, DA), 'POST',
                 {'tipe': 'odp', 'nama': 'MD-AKHIR', 'mode': 'plc', 'plc_id': PLC['1:16']})
    ok(st == 200, 'mengganti rasio PLC pada ODP langsung (tanpa cabang) boleh')

    st, d = call(adm, '/config/odc/%d/node' % MD, 'POST',
                 {'tipe': 'odp', 'nama': 'Y', 'mode': 'entah', 'parent_id': D1, 'parent_port': 'biru'})
    ok(st == 400, 'mode yang tidak dikenal DITOLAK')

    # ══ Splitter tidak butuh nama ══
    # Kolom namanya dihapus dari form, jadi klien tidak mengirim apa pun.
    # Server harus memberi nama bawaan sesuai jenisnya — bukan menyimpan
    # string kosong yang lalu tampil sebagai kartu tanpa judul.
    st, d = call(adm, '/config/odc', 'POST', {'nama': 'ODC-NAMA', 'olt_id': OLT, 'input_dbm': 6})
    NN = d['odc']['id']
    st, d = call(adm, '/config/odc/%d/node' % NN, 'POST',
                 {'tipe': 'odp', 'nama': 'N-01', 'tap_id': TAP['10/90']})
    N1 = d['node']['id']
    st, d = call(adm, '/config/odc/%d/node' % NN, 'POST',
                 {'tipe': 'splitter', 'plc_id': PLC['1:8'], 'parent_id': N1, 'parent_port': 'biru'})
    ok(st == 200 and d['node']['nama'] == 'Splitter',
       'splitter tanpa nama diberi nama bawaan "Splitter"')
    st, d = call(adm, '/config/odc/%d/node' % NN, 'POST',
                 {'tipe': 'odp', 'nama': 'N-02', 'tap_id': TAP['20/80'],
                  'parent_id': N1, 'parent_port': 'merah'})
    N2 = d['node']['id']
    st, d = call(adm, '/config/odc/%d/node' % NN, 'POST',
                 {'tipe': 'splitter_odc', 'plc_id': PLC['1:4'],
                  'parent_id': N2, 'parent_port': 'biru'})
    ok(st == 200 and d['node']['nama'] == 'Splitter ODC',
       'splitter distribusi diberi nama bawaan "Splitter ODC"')
    # ODP TETAP wajib bernama — itu yang dicari tim di lapangan.
    st, _ = call(adm, '/config/odc/%d/node' % NN, 'POST',
                 {'tipe': 'odp', 'tap_id': TAP['50/50'], 'parent_id': N2, 'parent_port': 'merah'})
    ok(st == 400, 'ODP tanpa nama tetap DITOLAK')

    # ══ Memindahkan node (tarik bundaran port ke ODP) ══
    st, d = call(adm, '/config/odc', 'POST', {'nama': 'ODC-PINDAH', 'olt_id': OLT, 'input_dbm': 7})
    MV = d['odc']['id']
    st, d = call(adm, '/config/odc/%d/node' % MV, 'POST',
                 {'tipe': 'odp', 'nama': 'M-01', 'tap_id': TAP['10/90']})
    M1 = d['node']['id']
    st, d = call(adm, '/config/odc/%d/node' % MV, 'POST',
                 {'tipe': 'splitter_odc', 'plc_id': PLC['1:4'], 'parent_id': M1, 'parent_port': 'biru'})
    MS = d['node']['id']
    st, d = call(adm, '/config/odc/%d/node' % MV, 'POST',
                 {'tipe': 'odp', 'nama': 'M-02', 'tap_id': TAP['20/80'],
                  'parent_id': M1, 'parent_port': 'merah'})
    M2 = d['node']['id']

    st, d = call(adm, '/config/odc/%d/node/%d/pindah' % (MV, M2), 'POST',
                 {'parent_id': MS, 'parent_port': 'p1'})
    ok(st == 200, 'ODP dipindah dari keluaran merah ke port splitter ODC')
    st, d = call(adm, '/config/odc/%d' % MV)
    n = {x['id']: x for x in d['nodes']}
    ok(n[M2]['parent_id'] == MS and n[M2]['parent_port'] == 'p1', 'induk barunya tercatat')
    ok(abs(n[M2]['in_dbm'] - n[MS]['out_dbm']) < .01,
       'dayanya ikut dihitung ulang dari sumber yang baru')

    # Penjaga siklus: memindahkan node ke bawah turunannya sendiri membuat
    # cabang yang dayanya bergantung pada dirinya sendiri — penelusuran tak
    # akan pernah selesai dan cabang itu lenyap tanpa pesan galat.
    st, d = call(adm, '/config/odc/%d/node/%d/pindah' % (MV, M1), 'POST',
                 {'parent_id': MS, 'parent_port': 'p2'})
    ok(st == 400 and 'berputar' in d.get('error', ''),
       'memindahkan node ke bawah turunannya sendiri DITOLAK (penjaga siklus)')
    st, d = call(adm, '/config/odc/%d/node/%d/pindah' % (MV, M1), 'POST',
                 {'parent_id': M1, 'parent_port': 'merah'})
    ok(st == 400 and 'dirinya sendiri' in d.get('error', ''), 'menyambung ke diri sendiri DITOLAK')

    st, d = call(adm, '/config/odc/%d' % MV)
    ok(d['pohon'] is not None, 'topologi tetap utuh setelah percobaan yang ditolak')

    st, d = call(adm, '/config/odc/%d/node/%d/pindah' % (MV, M2), 'POST',
                 {'parent_id': MS, 'parent_port': 'p9'})
    ok(st == 400, 'port di luar jumlah splitter DITOLAK')
    st, d = call(adm, '/config/odc/%d/node/%d/pindah' % (MV, M2), 'POST',
                 {'parent_id': M1, 'parent_port': 'biru'})
    ok(st == 400, 'ODP tetap tidak boleh menempel di keluaran biru walau lewat pindah')
    st, _ = call(usr, '/config/odc/%d/node/%d/pindah' % (MV, M2), 'POST',
                 {'parent_id': MS, 'parent_port': 'p3'})
    ok(st == 403, 'role user DITOLAK memindahkan node')

    # Memindahkan ke slot yang sudah terisi node LAIN harus ditolak, tapi
    # memindahkan ke slotnya sendiri (tidak berpindah) tetap boleh.
    st, d = call(adm, '/config/odc/%d/node/%d/pindah' % (MV, M2), 'POST',
                 {'parent_id': MS, 'parent_port': 'p1'})
    ok(st == 200, 'memindahkan ke slotnya sendiri tidak dianggap bentrok')

    st, d = call(adm, '/auth/audit?limit=200')
    aksi = {r['action'] for r in (d.get('entries') or [])}
    ok(any(a.startswith('odc.') for a in aksi), 'perubahan topologi tercatat di audit log')

finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print('odc: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
