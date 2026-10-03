#!/usr/bin/env python3
"""Uji tombol Update — pembaruan panel dari GitHub (2026-10-03).

YANG DIJAGA:
  1. Hanya dari remote `origin` + cabang terpasang; permintaan browser tak membawa apa pun.
  2. Hanya maju (fast-forward): berkas panel yang diubah di server, atau riwayat yang
     bercabang, membuat pembaruan DIBATALKAN — tak ada yang ditimpa.
  3. Basis data dicadangkan SEBELUM berkas diubah; berkas tak terlacak (data/) utuh.
  4. Tidak dijalankan selagi ada perintah ONU berjalan; khusus administrator; tercatat.
  5. Tak ada pembaruan → panel tidak dinyalakan ulang.

"GitHub" di sini adalah repositori git sementara di folder temp — tidak ada jaringan,
dan repositori panel yang sesungguhnya tidak disentuh. Butuh program git; bila tak ada,
uji DILEWATI dengan keterangan.
"""
import os, sys, json, shutil, tempfile, threading, subprocess, http.client

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))

GIT = shutil.which('git')
if not GIT:
    print('pembaruan: dilewati — program git tidak ditemukan')
    sys.exit(0)

import db, auth
TMP = tempfile.mkdtemp(prefix='skyupd-')
auth.DATA_DIR = os.path.join(TMP, 'data')
db.set_path(os.path.join(TMP, 'data', 'sky.db'))
db.init()
import pembaruan, cadangan, config_store, ops_lock

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

def g(cwd, *a):
    r = subprocess.run([GIT, '-c', 'user.name=Uji', '-c', 'user.email=uji@contoh.id', '-c', 'commit.gpgsign=false',
                        '-c', 'core.autocrlf=false', '-c', 'protocol.file.allow=always'] + list(a),
                       cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 0, (a, r.stderr)
    return r.stdout.strip()
def tulis(folder, nama, isi):
    os.makedirs(os.path.dirname(os.path.join(folder, nama)), exist_ok=True)
    with open(os.path.join(folder, nama), 'w', encoding='utf-8', newline='') as f: f.write(isi)
def baca(folder, nama):
    with open(os.path.join(folder, nama), encoding='utf-8') as f: return f.read()
def terbit(pesan, berkas):
    """Satu commit baru di "GitHub". berkas = {nama: isi}."""
    for nama, isi in berkas.items(): tulis(SUMBER, nama, isi)
    g(SUMBER, 'add', '-A'); g(SUMBER, 'commit', '-q', '-m', pesan); g(SUMBER, 'push', '-q', 'asal', 'main')
def gagal(fn, *a, **k):
    try:
        fn(*a, **k); return ''
    except pembaruan.PembaruanError as e:
        return str(e)

SUMBER, ASAL, PANEL = (os.path.join(TMP, x) for x in ('sumber', 'asal.git', 'panel'))
os.makedirs(SUMBER)
g(SUMBER, 'init', '-q', '-b', 'main')
tulis(SUMBER, 'VERSION', '1.1.0\n'); tulis(SUMBER, 'server.py', '# panel v1.1.0\n')
g(SUMBER, 'add', '-A'); g(SUMBER, 'commit', '-q', '-m', 'Rilis 1.1.0')
g(TMP, 'clone', '-q', '--bare', SUMBER, ASAL)
g(SUMBER, 'remote', 'add', 'asal', ASAL)
g(TMP, 'clone', '-q', ASAL, PANEL)
pembaruan.AKAR = PANEL

# ══ 1. Keadaan pemasangan ══
ok(pembaruan.versi() == '1.1.0', 'versi dibaca dari berkas VERSION')
k = pembaruan.keadaan()
ok(k['bisa'] and k['cabang'] == 'main' and k['bersih'] and len(k['commit']) >= 7 and k['alasan'] == '', 'pemasangan lewat git clone bisa diperbarui — %r' % k)
p = pembaruan.periksa()
ok(p['tersedia'] is False and p['tertinggal'] == 0 and p['versiBaru'] == '1.1.0', 'sudah versi terbaru → tak ada yang ditawarkan')
ok(pembaruan._tanpa_rahasia('https://budi:ghp_RAHASIA@github.com/a/b.git') == 'https://github.com/a/b.git',
   'token di alamat remote tidak pernah dikirim ke browser')
tulis(PANEL, 'VERSION', 'bukan-versi; rm -rf /\n')
ok(pembaruan.versi() == '0.0.0', 'isi VERSION yang tak berbentuk versi diabaikan')
g(PANEL, 'checkout', '-q', '--', 'VERSION')

# ══ 2. Ada versi baru ══
terbit('Perbaikan A', {'VERSION': '1.1.1\n', 'server.py': '# panel v1.1.1\n'})
terbit('Fitur <b>B</b>', {'baru.txt': 'berkas baru\n'})
p = pembaruan.periksa()
ok(p['tersedia'] and p['tertinggal'] == 2 and p['mendahului'] == 0 and p['versiBaru'] == '1.1.1' and p['versi'] == '1.1.0'
   and p['perubahan'] == ['Fitur <b>B</b>', 'Perbaikan A'], 'periksa: 2 perubahan, versi baru 1.1.1 — %r' % {x: p[x] for x in ('tertinggal', 'versiBaru', 'perubahan')})
ok(baca(PANEL, 'VERSION') == '1.1.0\n' and not os.path.exists(os.path.join(PANEL, 'baru.txt')), 'memeriksa TIDAK mengubah berkas panel')

# berkas panel diubah langsung di server → batal
panggilan = []
tulis(PANEL, 'server.py', '# diubah teknisi langsung di server\n')
pesan = gagal(pembaruan.pasang, sebelum=lambda: panggilan.append('cadangan'))
ok('diubah langsung' in pesan and baca(PANEL, 'server.py').startswith('# diubah teknisi') and baca(PANEL, 'VERSION') == '1.1.0\n' and panggilan == [],
   'berkas panel yang diubah di server → pembaruan dibatalkan, tak ada yang ditimpa: %r' % pesan[:60])
g(PANEL, 'checkout', '-q', '--', 'server.py')

# berkas tak terlacak (data/) tidak menghalangi dan tidak tersentuh
tulis(PANEL, 'data/sky.db', 'BASIS-DATA')
ok(pembaruan.keadaan()['bersih'], 'berkas di luar git (data/) tidak dihitung sebagai perubahan')
h = pembaruan.pasang(sebelum=lambda: panggilan.append(baca(PANEL, 'VERSION')))
ok(h['berubah'] and h['versiDari'] == '1.1.0' and h['versiKe'] == '1.1.1' and h['dari'] != h['ke'], 'pembaruan terpasang: %r' % h)
ok(panggilan == ['1.1.0\n'], 'cadangan dipanggil SATU kali dan SEBELUM berkas berubah — %r' % panggilan)
ok(baca(PANEL, 'server.py') == '# panel v1.1.1\n' and baca(PANEL, 'baru.txt') == 'berkas baru\n' and baca(PANEL, 'data/sky.db') == 'BASIS-DATA',
   'berkas panel versi baru; data/ utuh')
ok(g(PANEL, 'rev-parse', 'HEAD') == g(ASAL, 'rev-parse', 'main'), 'server kini persis di commit GitHub')
h = pembaruan.pasang(sebelum=lambda: panggilan.append('lagi'))
ok(h['berubah'] is False and panggilan == ['1.1.0\n'], 'sudah terbaru → tidak ada yang dikerjakan, cadangan tidak dibuat')

# riwayat bercabang → batal
tulis(PANEL, 'lokal.txt', 'commit di server\n'); g(PANEL, 'add', '-A'); g(PANEL, 'commit', '-q', '-m', 'commit lokal')
terbit('Perbaikan C', {'VERSION': '1.1.2\n'})
kepala = g(PANEL, 'rev-parse', 'HEAD')
pesan = gagal(pembaruan.pasang)
ok('bercabang' in pesan and g(PANEL, 'rev-parse', 'HEAD') == kepala and baca(PANEL, 'VERSION') == '1.1.1\n',
   'server punya commit sendiri → pembaruan dibatalkan, riwayat tidak ditulis ulang: %r' % pesan[:50])

# GitHub tak terjangkau
g(PANEL, 'remote', 'set-url', 'origin', os.path.join(TMP, 'tidak-ada.git'))
ok('Tidak bisa mengambil kabar' in gagal(pembaruan.periksa), 'GitHub tak terjangkau → pesan yang jelas, bukan galat mentah')
g(PANEL, 'remote', 'set-url', 'origin', ASAL)

# bukan pemasangan git / di dalam repositori lain
KOSONG = os.path.join(TMP, 'kosong'); os.makedirs(KOSONG)
pembaruan.AKAR = KOSONG
k = pembaruan.keadaan()
ok(k['bisa'] is False and 'git clone' in k['alasan'] and 'git clone' in gagal(pembaruan.periksa), 'bukan hasil git clone → tombol Update dimatikan dengan alasan')
DALAM = os.path.join(PANEL, 'sub'); os.makedirs(DALAM)
pembaruan.AKAR = DALAM
ok(pembaruan.keadaan()['bisa'] is False and 'repositori git lain' in pembaruan.keadaan()['alasan'],
   'folder panel di dalam repositori lain → tidak pernah memperbarui repositori induknya')

src = open(os.path.join(ROOT, 'backend', 'pembaruan.py'), encoding='utf-8').read()
ok('shell=True' not in src and "'--ff-only'" in src and 'reset' not in src.split('def pasang')[1].split('def mulai_ulang')[0]
   and '--force' not in src, 'git dijalankan tanpa shell, hanya --ff-only; tak ada reset/force')
ok("GIT_TERMINAL_PROMPT='0'" in src, 'git tidak pernah berhenti menunggu username/password')

# ══ 3. Lewat server ══
PANEL2 = os.path.join(TMP, 'panel2')
g(TMP, 'clone', '-q', ASAL, PANEL2)
g(PANEL2, 'reset', '-q', '--hard', 'HEAD~1')            # tertinggal satu rilis (1.1.1 → 1.1.2)
pembaruan.AKAR = PANEL2
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': 1, 'base_path': ''})     # port mati
import server
ulang = []
server.MULAI_ULANG = lambda *a, **k: ulang.append(1)
ADM = auth.create_user('admin.upd', 'Admin#Upd-2026x', 'Admin', role='administrator')
STF = auth.create_user('teknisi.upd', 'Teknisi#Upd-2026', 'Teknisi', role='user')
PEL = auth.create_user('pelanggan.upd', 'Pelanggan123', 'Pelanggan', role='pelanggan')
srv = server.buat_server('127.0.0.1', 0)
server.SPAHandler.log_message = lambda *a, **k: None
threading.Thread(target=srv.serve_forever, daemon=True).start()
PORT = srv.server_address[1]

def minta(metode, path, ck=None, body=None, kepala=None):
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=120)
    hd = {'Content-Type': 'application/json'}
    if ck: hd['Cookie'] = ck
    hd.update(kepala or {})
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=hd)
    r = c.getresponse(); raw = r.read(); sc = r.getheader('Set-Cookie'); c.close()
    try: d = json.loads(raw or b'{}')
    except Exception: d = {}
    return r.status, d, sc
def login(u, pw):
    st, d, sc = minta('POST', '/auth/login', None, {'username': u, 'password': pw})
    assert st == 200, (u, st, d)
    return sc.split(';')[0]
try:
    cka, ckt, ckp = login('admin.upd', 'Admin#Upd-2026x'), login('teknisi.upd', 'Teknisi#Upd-2026'), login('pelanggan.upd', 'Pelanggan123')
    for m, pth in (('GET', '/config/pembaruan'), ('POST', '/config/pembaruan/periksa'), ('POST', '/config/pembaruan/pasang')):
        b = {} if m == 'POST' else None
        ok(minta(m, pth, ckt, b)[0] == 403 and minta(m, pth, ckp, b)[0] == 403 and minta(m, pth, None, b)[0] == 401,
           '%s %s: role user & pelanggan 403, tanpa sesi 401' % (m, pth))
    ok(ulang == [] and baca(PANEL2, 'VERSION') == '1.1.1\n', 'percobaan tanpa hak tidak mengubah apa pun')
    st, d, _ = minta('GET', '/config/pembaruan', cka)
    ok(st == 200 and d['versi'] == '1.1.1' and d['bisa'] and d['cabang'] == 'main' and 'tertinggal' not in d,
       'GET: keadaan terpasang, tanpa menghubungi GitHub')
    proses = d.get('proses')
    ok(proses == server.ID_PROSES and str(os.getpid()) in proses, 'GET menyertakan tanda proses yang sedang melayani')
    st, d, _ = minta('POST', '/config/pembaruan/periksa', cka, {'cabang': 'jahat', 'url': 'https://jahat.contoh/x.git'})
    ok(st == 200 and d['tersedia'] and d['versiBaru'] == '1.1.2' and d['perubahan'] == ['Perbaikan C'] and d['cabang'] == 'main'
       and g(PANEL2, 'remote', 'get-url', 'origin') == ASAL,
       'periksa: versi 1.1.2 tersedia; cabang/alamat kiriman browser diabaikan')
    st, d, _ = minta('POST', '/config/pembaruan/pasang', cka, {}, {'Sec-Fetch-Site': 'cross-site'})
    ok(st == 403 and baca(PANEL2, 'VERSION') == '1.1.1\n', 'permintaan dari situs lain ditolak')
    ops_lock.mulai('AA-B-SN1', 'teknisi.upd', {'name': 'reboot'})
    st, d, _ = minta('POST', '/config/pembaruan/pasang', cka, {})
    ok(st == 409 and 'perintah ONU' in d.get('error', '') and baca(PANEL2, 'VERSION') == '1.1.1\n' and ulang == [],
       'ada perintah ONU berjalan → pembaruan ditunda (409)')
    ops_lock.reset()
    st, d, _ = minta('POST', '/config/pembaruan/pasang', cka, {})
    ok(st == 200 and d['berubah'] and d['mulaiUlang'] and d['versiDari'] == '1.1.1' and d['versiKe'] == '1.1.2'
       and baca(PANEL2, 'VERSION') == '1.1.2\n', 'pasang: berkas panel menjadi 1.1.2 — %r' % d)
    ok(ulang == [1], 'panel dinyalakan ulang tepat satu kali sesudah pembaruan')
    # Proses LAMA sudah menjawab dengan versi baru (dibaca dari berkas) — karena itu browser
    # menunggu TANDA PROSES berubah, bukan versinya (lihat ID_PROSES di server.py).
    st2, d2, _ = minta('GET', '/config/pembaruan', cka)
    ok(d['proses'] == proses and d2['versi'] == '1.1.2' and d2['proses'] == proses,
       'jawaban pasang membawa tanda proses lama; versi di berkas sudah baru walau prosesnya belum berganti')
    ok([b['nama'] for b in cadangan.daftar('sebelum-update')] and os.path.dirname(db.DB_PATH) == os.path.join(TMP, 'data'),
       'basis data dicadangkan sebelum pembaruan (sky-sebelum-update-…)')
    jejak = [r for r in db.audit_list(limit=50) if r['action'] == 'sistem.update']
    ok(len(jejak) == 1 and jejak[0]['username'] == 'admin.upd' and 'v1.1.1' in jejak[0]['detail'] and 'v1.1.2' in jejak[0]['detail'],
       'pembaruan tercatat di Log: dari versi berapa ke berapa')
    st, d, _ = minta('POST', '/config/pembaruan/pasang', cka, {})
    ok(st == 200 and d['berubah'] is False and d['mulaiUlang'] is False and ulang == [1], 'sudah terbaru → tidak dinyalakan ulang')
    tulis(PANEL2, 'server.py', '# diubah di server\n')
    terbit('Perbaikan D', {'VERSION': '1.1.3\n'})
    st, d, _ = minta('POST', '/config/pembaruan/pasang', cka, {})
    ok(st == 400 and 'diubah langsung' in d.get('error', '') and ulang == [1]
       and any(r['action'] == 'sistem.update.gagal' for r in db.audit_list(limit=50)), 'pembaruan yang dibatalkan: 400 + tercatat, tanpa nyala ulang')
finally:
    srv.shutdown(); srv.server_close()

# ══ 4. Sumber kebenaran versi & halaman ══
srv_src = open(os.path.join(ROOT, 'backend', 'server.py'), encoding='utf-8').read()
import re
ok('APP_VERSION = pembaruan.versi()' in srv_src and re.match(r'^\d+\.\d+\.\d+\n$', open(os.path.join(ROOT, 'VERSION'), encoding='utf-8').read()),
   'versi panel hanya ditulis di berkas VERSION')
blok = srv_src.split('def _pasang_pembaruan')[1].split('\n    def ')[0]
ok('_read_json' not in blok and 'pembaruan.pasang(sebelum=_cadangkan)' in blok, 'pemasangan tidak membaca apa pun dari badan permintaan')
html = open(os.path.join(ROOT, 'frontend', 'pages', 'settings.html'), encoding='utf-8').read()
js = open(os.path.join(ROOT, 'frontend', 'js', 'settings.js'), encoding='utf-8').read()
kartu = re.search(r'<div[^>]*id="updKartu"[^>]*>', html)
ok(bool(kartu) and 'data-admin-only' in kartu.group(0) and 'id="btnUpdPeriksa"' in html and 'id="btnUpdPasang"' in html,
   'kartu Pembaruan (Periksa + Update) khusus administrator')
ok('/config/pembaruan/pasang' in js and 'showConfirm' in js.split('function pasangPembaruan')[1].split('\n}\n')[0],
   'tombol Update meminta konfirmasi sebelum memasang')
tunggu = js.split('function _updTungguNyala')[1].split('\n}\n')[0]
ok('d.proses !== prosesLama' in tunggu and 'd.commit ===' not in tunggu and '_updTungguNyala(h.proses, 0)' in js,
   'halaman dimuat ulang sesudah PROSES baru menjawab, bukan begitu versinya berubah')
ok("d.perubahan.map(function(x) { return '<li>' + escHtml(x) + '</li>'; })" in js.split('function _updGambar')[1].split('\n}\n')[0],
   'judul perubahan dari GitHub ditampilkan sebagai teks (escHtml)')

print(f'pembaruan: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
