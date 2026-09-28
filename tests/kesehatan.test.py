#!/usr/bin/env python3
"""Uji halaman Kesehatan ACS (kesehatan.py + Settings → Kesehatan ACS).

LATAR (2026-09-29): butuh skrip terpisah dan setengah jam menggali untuk
mengetahui bahwa 192 task sudah menggantung > 7 hari dan 12 dari 14 kegagalan
berasal dari satu baris berkoma di UI GenieACS. Halaman ini harus menunjukkan
hal yang sama dalam satu klik.

Yang dijaga:
  • Murni baca: NBI hanya menerima GET — tidak ada POST/DELETE sama sekali.
  • Bom waktu (> 24 jam) terhitung, dan perintah TULIS di antaranya disebut.
  • "Invalid parameter path" diarahkan ke sebab yang paling mungkin (UI GenieACS).
  • too_many_commits disebut berasal dari provision, bukan dari panel.
  • GenieACS mati → bagian milik panel tetap tampil, bukan seluruh halaman gagal.
  • Menu dan bagian halaman terpasang di Settings.
"""
import os, sys, re, json, time, tempfile, threading, socket, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import db
db.set_path(os.path.join(tempfile.mkdtemp(prefix='skyksh-'), 'sky.db'))
import kesehatan, antrean

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

SEKARANG = time.time()
def iso(jam_lalu):
    return datetime.datetime.fromtimestamp(SEKARANG - jam_lalu * 3600,
                                           datetime.timezone.utc).isoformat().replace('+00:00', 'Z')

ZL  = 'HWTC-ZL%2D2113X-HWTC101792A0'
F3A = '64E0AB-F663NV3A-ZTEG1B874818'
FAULTS = [
    {'_id': ZL + ':task_a', 'device': ZL, 'channel': 'task_a', 'code': 'script.Error',
     'message': 'Invalid parameter path', 'retries': 13, 'timestamp': iso(700)},
    {'_id': F3A + ':task_b', 'device': F3A, 'channel': 'task_b', 'code': 'cwmp.9002',
     'message': 'Internal error', 'retries': 9, 'timestamp': iso(50)},
    {'_id': F3A + ':default', 'device': F3A, 'channel': 'default', 'code': 'too_many_commits',
     'message': 'Too many commit iterations', 'retries': 2, 'timestamp': iso(3)},
]
TASKS = [
    {'_id': 'a', 'device': ZL,  'name': 'getParameterValues', 'timestamp': iso(700)},
    {'_id': 'c', 'device': F3A, 'name': 'setParameterValues', 'timestamp': iso(1062)},
    {'_id': 'd', 'device': F3A, 'name': 'refreshObject',      'timestamp': iso(0.2)},
]

class NBI:
    metode = []
    mati = False

class _H(BaseHTTPRequestHandler):
    def _semua(self):
        NBI.metode.append(self.command)
        if self.path.startswith('/faults'): isi = FAULTS
        elif self.path.startswith('/tasks'): isi = TASKS
        else: isi = []
        raw = json.dumps(isi).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    do_GET = do_POST = do_DELETE = do_PUT = _semua
    def log_message(self, *a): pass

def _free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
PORT = _free_port()
_srv = ThreadingHTTPServer(('127.0.0.1', PORT), _H); _srv.daemon_threads = True
threading.Thread(target=_srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % PORT

antrean.catat('d', F3A, 'refreshObject', 'andi', sekarang=SEKARANG - 60)
db.audit('acs_ditolak', 'uji')

h = kesehatan.kumpulkan(BASE, sekarang=SEKARANG)

# ══ 1. Murni baca ══
ok(NBI.metode and set(NBI.metode) == {'GET'}, 'NBI hanya menerima GET (dapat %s)' % NBI.metode)
ok(json.dumps(h, ensure_ascii=False), 'hasil bisa di-JSON-kan')

# ══ 2. Angka ══
ok(h['fault']['total'] == 3 and h['fault']['dariTask'] == 2 and h['fault']['dariProvision'] == 1,
   'fault dipisah: dari perintah vs dari provision')
ok(h['antrean']['total'] == 3 and h['antrean']['bomWaktu'] == 2, 'bom waktu = task > 24 jam (2)')
ok(h['antrean']['onu'] == 2, 'jumlah ONU yang punya antrean')
ok(h['fault']['daftarTask'][0]['retries'] == 13 and h['fault']['daftarTask'][0]['model'] == 'ZL-2113X',
   'daftar fault diurutkan dari yang paling sering diulang, model terbaca')
ok(h['antrean']['tertua'][0]['nama'] == 'setParameterValues', 'antrean tertua di urutan pertama')
ok(h['jejak24j']['acs_ditolak'] == 1, 'jejak 24 jam dari audit_log')
ok(len(h['panel']['mengantre']) == 1, 'antrean milik panel ikut tampil')

# ══ 3. Peringatan menunjuk sebab ══
teks = ' '.join(p['teks'] for p in h['peringatan'])
ok('2 perintah mengantre lebih dari 24 jam' in teks and '1 di antaranya MENULIS' in teks,
   'bom waktu disebut, termasuk yang menulis ke ONU')
ok('Invalid parameter path' in teks and 'UI GenieACS' in teks,
   '"Invalid parameter path" diarahkan ke Summon UI GenieACS')
ok('≥5 kali' in teks, 'perintah yang diulang berkali-kali disebut')
ok('too_many_commits' in teks and 'provision' in teks, 'too_many_commits disebut dari provision')
ok(any(p['tingkat'] == 'bahaya' for p in h['peringatan']), 'bom waktu bertingkat bahaya')

# ══ 4. GenieACS mati → bagian panel tetap tampil ══
mati = kesehatan.kumpulkan('http://127.0.0.1:%d' % _free_port(), sekarang=SEKARANG)
ok(mati['nbiGalat'] and mati['fault'] is None, 'NBI mati → nbiGalat terisi, bukan melempar')
ok(mati['panel']['mengantre'] and 'jejak24j' in mati, 'data milik panel tetap ada')

# ══ 5. Tampilan terpasang ══
def baca(p):
    with open(os.path.join(ROOT, p), encoding='utf-8') as f: return f.read()
html, sjs, srv = baca('pages/settings.html'), baca('js/settings.js'), baca('server.py')
ok('data-section="stSecKesehatan"' in html and 'id="stSecKesehatan"' in html, 'menu & bagian Kesehatan ACS ada')
ok("'stSecKesehatan') renderKesehatan()" in sjs, 'menu memanggil renderKesehatan')
fn = sjs[sjs.index('async function renderKesehatan'):sjs.index('/* ── Tombol "Bersihkan antrean lama"')]
ok("authFetch('/config/kesehatan')" in fn, 'halaman membaca /config/kesehatan')
ok(not re.search(r'tasks|method:|postTask|setParam', fn), 'halaman tidak mengirim perintah apa pun')
ok(re.search(r"path == '/config/kesehatan' and method == 'GET'", srv), 'server melayani GET /config/kesehatan')
ok('_kshEsc(x.pesan)' in fn and '_kshEsc(x.device)' in fn, 'teks dari GenieACS di-escape (bukan HTML mentah)')

print('kesehatan: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
