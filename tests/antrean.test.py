#!/usr/bin/env python3
"""Uji batas umur task panel yang mengantre di GenieACS (antrean.py).

MASALAH YANG DITUTUP (diukur 2026-09-29): 207 task menggantung di 35 ONU,
192 di antaranya > 7 hari — termasuk ganti password WiFi berumur 44 hari yang
akan berlaku mendadak begitu ONU-nya menyala lagi.

Yang dijaga:
  • Jawaban 202 dari NBI (ONU tak menjawab CR) dicatat; 200 tidak.
  • Task yang masih mengantre > KEDALUWARSA_MENIT dibatalkan — task DAN fault-nya.
  • Task yang sudah dijalankan ONU ditandai tuntas, tidak di-DELETE.
  • Task yang BUKAN buatan panel tidak pernah disentuh.
  • NBI menolak (503 "Device is in session") → dicoba lagi, tidak ditandai batal.
  • Angka batas di JS sama dengan di server.
"""
import os, sys, re, json, time, tempfile, threading, socket, subprocess
import urllib.request, urllib.parse, urllib.error, http.cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import db
db.set_path(os.path.join(tempfile.mkdtemp(prefix='skyantre-'), 'sky.db'))
import antrean

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)


# ══ NBI tiruan: antrean + fault di memori, mencatat setiap DELETE ══
class NBI:
    tasks, faults, hapus, tolak_503 = {}, {}, [], False

class _H(BaseHTTPRequestHandler):
    def _jawab(self, code, obj=None):
        raw = json.dumps(obj).encode() if obj is not None else b''
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = json.loads(urllib.parse.parse_qs(u.query).get('query', ['{}'])[0])
        if u.path.rstrip('/') == '/tasks':
            devs = (q.get('device') or {}).get('$in', [])
            self._jawab(200, [{'_id': t['_id']} for t in NBI.tasks.values() if t['device'] in devs])
        elif u.path.rstrip('/') == '/faults':
            self._jawab(200, [{'_id': q['_id']}] if q.get('_id') in NBI.faults else [])
        else:
            self._jawab(404)

    def do_DELETE(self):
        if NBI.tolak_503:
            self._jawab(503, {'error': 'Device is in session'}); return
        u = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        NBI.hapus.append(u)
        if u.startswith('/tasks/'):
            self._jawab(200 if NBI.tasks.pop(u[7:], None) else 404)
        elif u.startswith('/faults/'):
            self._jawab(200 if NBI.faults.pop(u[8:], None) else 404)
        else:
            self._jawab(404)

    def do_POST(self):          # dipakai uji ujung-ke-ujung di bawah
        n = int(self.headers.get('Content-Length') or 0)
        isi = json.loads(self.rfile.read(n) or b'{}')
        tid = 'e2e%09d' % len(NBI.tasks)
        dev = urllib.parse.unquote(self.path.split('/')[2])
        NBI.tasks[tid] = {'_id': tid, 'device': dev}
        self._jawab(202, dict(isi, _id=tid, device=dev))

    def log_message(self, *a): pass

def _free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

NBI_PORT = _free_port()
_srv = ThreadingHTTPServer(('127.0.0.1', NBI_PORT), _H); _srv.daemon_threads = True
threading.Thread(target=_srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % NBI_PORT

def reset():
    NBI.tasks, NBI.faults, NBI.hapus, NBI.tolak_503 = {}, {}, [], False
    db.conn().execute('DELETE FROM task_antre'); db.conn().commit()

def status(tid):
    r = db.conn().execute('SELECT status FROM task_antre WHERE task_id=?', (tid,)).fetchone()
    return r['status'] if r else None

T0 = 1_800_000_000.0
BATAS = antrean.KEDALUWARSA_MENIT * 60
DEV = '64E0AB-F663NV3A-ZTEG1B874818'


# ══ 1. Masih muda → tidak disentuh ══
reset()
NBI.tasks['t1'] = {'_id': 't1', 'device': DEV}
antrean.catat('t1', DEV, 'setParameterValues', 'andi', sekarang=T0)
h = antrean.periksa_sekali(BASE, sekarang=T0 + BATAS - 60)
ok(h['mengantre'] == 1 and not NBI.hapus, 'task berumur < batas tidak dihapus')
ok(status('t1') == 'mengantre', 'status tetap mengantre')

# ══ 2. Lewat batas → task DAN fault-nya dihapus, dicatat ══
NBI.faults[DEV + ':task_t1'] = {}
h = antrean.periksa_sekali(BASE, sekarang=T0 + BATAS + 60)
ok(h['dibatalkan'] == 1, 'task lewat batas dibatalkan (dapat %s)' % h)
ok('/tasks/t1' in NBI.hapus, 'DELETE /tasks/<id> terkirim')
ok('/faults/' + DEV + ':task_t1' in NBI.hapus, 'fault task_<id> ikut dihapus')
ok(not NBI.tasks and not NBI.faults, 'antrean & fault di NBI bersih')
ok(status('t1') == 'dibatalkan', 'status dibatalkan')
jejak = db.audit_list(action='task_kedaluwarsa')
ok(jejak and 'andi' in jejak[0]['detail'] and DEV in jejak[0]['detail'],
   'audit_log mencatat task_kedaluwarsa beserta pengirim & ONU-nya')

# ══ 3. Sudah dijalankan ONU (hilang dari antrean) → tuntas, tanpa DELETE ══
reset()
antrean.catat('t2', DEV, 'refreshObject', 'budi', sekarang=T0)
h = antrean.periksa_sekali(BASE, sekarang=T0 + BATAS * 10)
ok(h['tuntas'] == 1 and not NBI.hapus, 'task yang sudah tuntas tidak di-DELETE')
ok(status('t2') == 'tuntas', 'status tuntas')

# ══ 4. Task bukan buatan panel tidak pernah disentuh ══
reset()
NBI.tasks['asing'] = {'_id': 'asing', 'device': DEV}       # mis. dari UI GenieACS
NBI.tasks['t3'] = {'_id': 't3', 'device': DEV}
antrean.catat('t3', DEV, 'setParameterValues', 'andi', sekarang=T0)
antrean.periksa_sekali(BASE, sekarang=T0 + BATAS * 100)
ok('asing' in NBI.tasks, 'task yang tidak dicatat panel tetap ada')
ok(all('asing' not in h for h in NBI.hapus), 'tidak ada DELETE untuk task asing')

# ══ 5. ONU sedang dalam sesi (503) → dicoba lagi nanti ══
reset()
NBI.tasks['t4'] = {'_id': 't4', 'device': DEV}
antrean.catat('t4', DEV, 'setParameterValues', 'andi', sekarang=T0)
NBI.tolak_503 = True
h = antrean.periksa_sekali(BASE, sekarang=T0 + BATAS + 60)
ok(h['gagal'] == 1 and status('t4') == 'mengantre', '503 → tetap mengantre, tidak dianggap batal')
NBI.tolak_503 = False
h = antrean.periksa_sekali(BASE, sekarang=T0 + BATAS + 120)
ok(h['dibatalkan'] == 1 and 't4' not in NBI.tasks, 'putaran berikutnya berhasil membatalkan')

# ══ 6. Riwayat lama dibuang, yang masih mengantre tidak ══
reset()
antrean.catat('lama', DEV, 'x', '', sekarang=T0)
db.conn().execute("UPDATE task_antre SET status='tuntas', selesai=?", (T0,)); db.conn().commit()
NBI.tasks['baru'] = {'_id': 'baru', 'device': DEV}
antrean.catat('baru', DEV, 'x', '', sekarang=T0 + 8 * 86400)
antrean.periksa_sekali(BASE, sekarang=T0 + 8 * 86400 + 1)
ok(status('lama') is None, 'baris tuntas > 7 hari dibuang')
ok(status('baru') == 'mengantre', 'baris yang masih mengantre tidak ikut terbuang')

# ══ 7. catat_dari_jawaban tidak pernah melempar ══
reset()
antrean.catat_dari_jawaban(DEV, b'{"name":"reboot"}', b'bukan json')
antrean.catat_dari_jawaban(DEV, None, None)
antrean.catat_dari_jawaban(DEV, b'{"name":"reboot"}', b'{"_id":"t5"}')
ok(status('t5') == 'mengantre', 'nama diambil dari permintaan bila jawaban tak menyebutnya')

# ══ 8. Ringkasan untuk halaman kesehatan ══
r = antrean.ringkasan(sekarang=time.time())
ok(r['kedaluwarsaMenit'] == antrean.KEDALUWARSA_MENIT and len(r['mengantre']) == 1,
   'ringkasan memuat batas & daftar yang mengantre')
ok(json.dumps(r), 'ringkasan bisa di-JSON-kan')

# ══ 9. Angka batas: JS == server, dan tidak diperlonggar diam-diam ══
with open(os.path.join(ROOT, 'js', 'device-detail.js'), encoding='utf-8') as f:
    m = re.search(r'TASK_KEDALUWARSA_MENIT\s*=\s*(\d+)', f.read())
ok(m and int(m.group(1)) == antrean.KEDALUWARSA_MENIT,
   'TASK_KEDALUWARSA_MENIT di device-detail.js == antrean.KEDALUWARSA_MENIT')
ok(15 <= antrean.KEDALUWARSA_MENIT <= 60,
   'batas 15–60 menit (≥3× interval inform 300 dtk, dan tetap pendek untuk mencegah bom waktu)')


# ══ 10. Ujung-ke-ujung: server sungguhan mencatat jawaban 202 ══
reset()
PORT, TMP = _free_port(), tempfile.mkdtemp(prefix='skyantre-e2e-')
boot = '''
import sys, os
sys.path.insert(0, %r)
import db, auth
auth.DATA_DIR = %r
db.set_path(os.path.join(%r, 'sky.db'))
print('BOOTPW=' + auth.ensure_bootstrap(), flush=True)
import config_store, server
config_store.acs_set({'protocol':'http','host':'127.0.0.1','port':%d,'base_path':''})
srv = server.ThreadingHTTPServer(('127.0.0.1', %d), server.SPAHandler)
srv.daemon_threads = True
srv.serve_forever()
''' % (ROOT, TMP, TMP, NBI_PORT, PORT)
proc = subprocess.Popen([sys.executable, '-c', boot], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, cwd=ROOT)
try:
    BOOTPW, t0 = None, time.time()
    while time.time() - t0 < 20:
        line = proc.stdout.readline()
        if line.startswith('BOOTPW='):
            BOOTPW = line.strip().split('=', 1)[1]; break
    for _ in range(60):
        try: socket.create_connection(('127.0.0.1', PORT), 0.3).close(); break
        except Exception: time.sleep(0.1)
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(path, data=None):
        req = urllib.request.Request('http://127.0.0.1:%d%s' % (PORT, path),
                                     method='POST' if data is not None else 'GET')
        req.add_header('Content-Type', 'application/json')
        try:
            r = op.open(req, json.dumps(data).encode() if data is not None else None, timeout=20)
            return r.status
        except urllib.error.HTTPError as e:
            return e.code
    ok(call('/auth/login', {'username': 'admin', 'password': BOOTPW}) == 200, 'e2e: login')
    code = call('/api/devices/' + urllib.parse.quote(DEV, safe='') + '/tasks?connection_request&timeout=3000',
                {'name': 'setParameterValues', 'parameterValues': [
                    ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', 'Uji', 'xsd:string']]})
    ok(code == 202, 'e2e: NBI menjawab 202 diteruskan apa adanya (dapat %s)' % code)
    db.set_path(os.path.join(TMP, 'sky.db'))
    rows = [dict(r) for r in db.conn().execute('SELECT * FROM task_antre')]
    ok(len(rows) == 1 and rows[0]['device_id'] == DEV and rows[0]['pemilik'] == 'admin'
       and rows[0]['nama'] == 'setParameterValues',
       'e2e: server mencatat task 202 beserta ONU, nama perintah, dan pengirimnya (dapat %s)' % rows)
finally:
    proc.terminate()

print('antrean: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
