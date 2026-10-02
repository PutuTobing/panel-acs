#!/usr/bin/env python3
"""Uji tombol "Bersihkan antrean lama" (kesehatan.calon_bersih / bersihkan).

LATAR: 2026-09-29 pembersihan pertama dijalankan sebagai skrip — 207 task
menggantung (192 > 7 hari, termasuk ganti password WiFi berumur 44 hari) → 0.
Kini menjadi tombol, jadi pagarnya harus diuji:

  • Periksa murni baca; hanya task > 24 jam atau cacat yang terpilih.
  • Bersihkan hanya menghapus id yang diminta DAN masih memenuhi kriteria —
    klien tidak bisa menyuruh server menghapus task sembarang.
  • Cadangan lengkap ditulis SEBELUM menghapus; jejak di audit_log.
  • Fault task_<id> ikut dihapus.
  • ONU sedang dalam sesi (503) → dilaporkan gagal, bukan dianggap berhasil.
  • POST khusus administrator (dijaga di server).
"""
import os, sys, re, json, time, tempfile, threading, socket, datetime
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db
TMP = tempfile.mkdtemp(prefix='skybersih-')
db.set_path(os.path.join(TMP, 'sky.db'))
import kesehatan

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

SEKARANG = time.time()
def iso(jam):
    return datetime.datetime.fromtimestamp(SEKARANG - jam * 3600, datetime.timezone.utc
                                           ).isoformat().replace('+00:00', 'Z')
DEV = '64E0AB-F663NV3A-ZTEG1B874818'
ZL  = 'HWTC-ZL%2D2113X-HWTC101792A0'

class NBI:
    tasks, faults, metode, tolak = {}, {}, [], set()

def isi_awal():
    NBI.tasks = {
        'tua':   {'_id': 'tua', 'device': DEV, 'name': 'setParameterValues', 'timestamp': iso(1062),
                  'parameterValues': [['X.KeyPassphrase', 'rahasia', 'xsd:string']]},
        'cacat': {'_id': 'cacat', 'device': ZL, 'name': 'getParameterValues', 'timestamp': iso(2)},
        'muda':  {'_id': 'muda', 'device': DEV, 'name': 'refreshObject', 'timestamp': iso(0.1)},
    }
    NBI.faults = {
        ZL + ':task_cacat': {'_id': ZL + ':task_cacat', 'device': ZL, 'channel': 'task_cacat',
                             'code': 'script.Error', 'message': 'Invalid parameter path'},
        DEV + ':default':   {'_id': DEV + ':default', 'device': DEV, 'channel': 'default',
                             'code': 'too_many_commits', 'message': 'x'},
    }
    NBI.metode, NBI.tolak = [], set()

class _H(BaseHTTPRequestHandler):
    def _jawab(self, code, obj=None):
        raw = json.dumps(obj).encode() if obj is not None else b''
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        NBI.metode.append('GET')
        u = urllib.parse.urlparse(self.path)
        q = json.loads(urllib.parse.parse_qs(u.query).get('query', ['{}'])[0])
        if u.path.rstrip('/') == '/tasks':
            devs = (q.get('device') or {}).get('$in')
            self._jawab(200, [t for t in NBI.tasks.values() if devs is None or t['device'] in devs])
        elif u.path.rstrip('/') == '/faults':
            fs = list(NBI.faults.values())
            if '_id' in q: fs = [f for f in fs if f['_id'] == q['_id']]
            self._jawab(200, fs)
        else:
            self._jawab(404)
    def do_DELETE(self):
        NBI.metode.append('DELETE')
        p = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if p.startswith('/tasks/'):
            if p[7:] in NBI.tolak:
                self._jawab(503, {'error': 'Device is in session'}); return
            self._jawab(200 if NBI.tasks.pop(p[7:], None) else 404)
        elif p.startswith('/faults/'):
            self._jawab(200 if NBI.faults.pop(p[8:], None) else 404)
        else:
            self._jawab(404)
    do_POST = do_PUT = lambda self: (NBI.metode.append(self.command), self._jawab(405))
    def log_message(self, *a): pass

def _free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
PORT = _free_port()
_srv = ThreadingHTTPServer(('127.0.0.1', PORT), _H); _srv.daemon_threads = True
threading.Thread(target=_srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % PORT
ADMIN = {'id': None, 'username': 'andi'}

# ══ 1. Periksa: murni baca, kriteria benar ══
isi_awal()
c = kesehatan.calon_bersih(BASE, sekarang=SEKARANG)
ok(set(NBI.metode) == {'GET'}, 'Periksa hanya GET')
ids = {x['id'] for x in c['daftar']}
ok(ids == {'tua', 'cacat'}, 'terpilih: yang > 24 jam dan yang cacat; yang muda tidak (dapat %s)' % ids)
ok(c['menulis'] == 1 and c['onu'] == 2, 'jumlah yang menulis ke ONU & jumlah ONU')
alasan = {x['id']: x['alasan'] for x in c['daftar']}
ok('Invalid parameter path' in alasan['cacat'] and '24 jam' in alasan['tua'], 'alasan per perintah')
ok(json.dumps(c), 'hasil Periksa bisa di-JSON-kan')

# ══ 2. Klien tidak bisa menyelundupkan id ══
r = kesehatan.bersihkan(BASE, None, ['muda', 'tidak-ada'], ADMIN, sekarang=SEKARANG)
ok(r['dihapus'] == 0 and 'muda' in NBI.tasks, 'id yang tak memenuhi kriteria tidak dihapus')
ok(r['dilewati'] == 2 and r['cadangan'] is None, 'dilaporkan dilewati, tanpa cadangan kosong')

# ══ 3. Bersihkan: cadangan dulu, lalu hapus task + fault-nya ══
isi_awal()
r = kesehatan.bersihkan(BASE, None, ['tua', 'cacat'], ADMIN, sekarang=SEKARANG)
ok(r['dihapus'] == 2 and not r['gagal'], 'dua perintah dihapus (dapat %s)' % r)
ok(set(NBI.tasks) == {'muda'}, 'yang muda tetap mengantre')
ok(ZL + ':task_cacat' not in NBI.faults, 'fault task_<id> ikut dihapus')
ok(DEV + ':default' in NBI.faults, 'fault provision (bukan task) tidak disentuh')
berkas = os.path.join(TMP, 'backup', r['cadangan'] or '-')
ok(os.path.exists(berkas), 'berkas cadangan ada di folder backup di samping DB')
with open(berkas, encoding='utf-8') as f:
    cad = json.load(f)
ok({t['_id'] for t in cad['tasks']} == {'tua', 'cacat'} and cad['oleh'] == 'andi',
   'cadangan memuat task yang dihapus + siapa yang membersihkan')
ok(any('parameterValues' in t for t in cad['tasks']),
   'cadangan berisi isi LENGKAP task (bukan hanya projection)')
jejak = db.audit_list(action='antrean_dibersihkan')
ok(jejak and '2 task dihapus' in jejak[0]['detail'] and jejak[0]['username'] == 'andi',
   'audit_log mencatat pembersihan beserta pelakunya')

# ══ 4. ONU sedang dalam sesi → dilaporkan gagal ══
isi_awal()
NBI.tolak = {'tua'}
r = kesehatan.bersihkan(BASE, None, ['tua', 'cacat'], ADMIN, sekarang=SEKARANG)
ok(r['dihapus'] == 1 and len(r['gagal']) == 1 and r['gagal'][0]['id'] == 'tua',
   '503 dilaporkan sebagai gagal, sisanya tetap dihapus')
ok('tua' in NBI.tasks, 'task yang gagal dihapus masih ada (bisa dicoba lagi)')

# ══ 5. Server & tampilan ══
def baca(p):
    with open(os.path.join(ROOT, p), encoding='utf-8') as f: return f.read()
srv, sjs, html = baca('backend/server.py'), baca('frontend/js/settings.js'), baca('frontend/pages/settings.html')
blok = srv[srv.index("path == '/config/kesehatan/bersihkan' and method == 'POST'"):]
blok = blok[:blok.index('return\n', blok.index('bersihkan('))]
# Sejak 2026-10-03: administrator, atau role yang ia beri menu Kesehatan ACS
# (tests/izinrole.test.py menguji penolakannya lewat HTTP).
ok("_izin(user, 'kesehatan'" in blok, 'POST bersihkan dijaga izin menu Kesehatan ACS (dicek di server)')
ok(re.search(r'data-izin="kesehatan">\s*<div class="card-header">\s*<h3[^>]*><i class="fas fa-broom"', html),
   'kotak Bersihkan disembunyikan dari role tanpa izin Kesehatan ACS')
fn = sjs[sjs.index('function _kshBersihSiapkan'):sjs.index('/* ── Pemetaan Parameter')]
ok('showConfirm(' in fn, 'Bersihkan wajib dikonfirmasi')
ok('ids: c.daftar.map(x => x.id)' in fn, 'yang dikirim hanya id dari daftar Periksa')
ok(not re.search(r'setInterval|setTimeout', fn), 'tidak pernah berjalan sendiri (tanpa timer)')

print('bersihkan: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
