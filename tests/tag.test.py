#!/usr/bin/env python3
"""Uji tag panel untuk ONU — MITRA-SURYA, MITRA-BAYU, … (2026-10-03).

YANG DIJAGA:
  1. Nama tag dirapikan & divalidasi DI SERVER (form bisa dilewati).
  2. Wewenang: membaca semua staf; membuat/memasang/melepas butuh izin "buatTag"
     (administrator selalu punya); menghapus nama tag khusus administrator.
  3. Tag panel tidak pernah menyentuh GenieACS (tak ada permintaan ke NBI).
  4. Semua perubahan tercatat di audit log.

Memakai DB sementara; GenieACS diarahkan ke port MATI — tidak menyentuh produksi.
"""
import os, sys, re, json, socket, tempfile, threading, http.client
from http.server import ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db, auth
TMP = tempfile.mkdtemp(prefix='skytag-')
auth.DATA_DIR = TMP
db.set_path(os.path.join(TMP, 'sky.db'))
db.init()
import config_store, tag

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

_s = socket.socket(); _s.bind(('127.0.0.1', 0)); _port_mati = _s.getsockname()[1]; _s.close()
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': _port_mati, 'base_path': ''})

ADM = auth.create_user('admin.tag', 'Admin#Tag-2026x', 'Admin', role='administrator')
USR = auth.create_user('teknisi.tag', 'Teknisi#Tag-2026', 'Teknisi', role='user')

# ══ 1. Modul ══
ok(tag.rapikan_nama('  mitra surya ') == 'MITRA-SURYA', 'nama dirapikan: spasi → "-", huruf besar')
for salah in ('', '-AWAL', 'A' * 33, 'TAG<script>', 'TAG"X', 'MITRA/SURYA'):
    try:
        tag.rapikan_nama(salah); ok(False, 'nama tak sah lolos: %r' % salah)
    except tag.TagError:
        ok(True, '')
t = tag.buat('mitra surya', None, ADM)
ok(t['nama'] == 'MITRA-SURYA' and re.match(r'^#[0-9a-f]{6}$', t['warna']), 'tag dibuat dengan warna bawaan')
try:
    tag.buat('MITRA-SURYA', None, ADM); ok(False, 'tag kembar lolos')
except tag.TagError:
    ok(True, '')
try:
    tag.buat('MITRA-X', 'red;background:url(x)', ADM); ok(False, 'warna sembarang lolos')
except tag.TagError:
    ok(True, '')
ok(tag.pasang('MITRA-SURYA', ['DEV-1', 'DEV-2', 'DEV-1'], actor=ADM) == 2, 'pasang ke 2 ONU (kembar diabaikan)')
ok(tag.pasang('MITRA-SURYA', ['DEV-1'], actor=ADM) == 0, 'pasang ulang tidak menggandakan')
tag.buat('MITRA-BAYU', '#22c55e', ADM)
tag.pasang('MITRA-BAYU', ['DEV-2'], actor=ADM)
ok(tag.per_perangkat() == {'DEV-1': ['MITRA-SURYA'], 'DEV-2': ['MITRA-BAYU', 'MITRA-SURYA']}, 'satu ONU boleh memegang beberapa tag')
ok([(x['nama'], x['jumlah']) for x in tag.daftar()] == [('MITRA-BAYU', 1), ('MITRA-SURYA', 2)], 'daftar tag beserta jumlah ONU')
ok(tag.pasang('MITRA-SURYA', ['DEV-2'], lepas=True, actor=ADM) == 1 and tag.per_perangkat()['DEV-2'] == ['MITRA-BAYU'], 'lepas tag')
# ubah nama / warna: pasangan dengan ONU ikut pindah, tidak ada yang terlepas
u = tag.ubah('MITRA-BAYU', 'mitra bayu jaya', '#0ea5e9', ADM)
ok(u == {'nama': 'MITRA-BAYU-JAYA', 'warna': '#0ea5e9'} and tag.per_perangkat()['DEV-2'] == ['MITRA-BAYU-JAYA'],
   'ubah nama & warna: ONU yang memakainya ikut nama baru')
for salah in (('MITRA-BAYU-JAYA', 'MITRA-SURYA', None), ('MITRA-BAYU-JAYA', 'a<b', None),
              ('MITRA-BAYU-JAYA', None, 'merah'), ('TIDAK-ADA', 'X', None)):
    try:
        tag.ubah(*salah, actor=ADM); ok(False, 'ubah tak sah lolos: %r' % (salah,))
    except tag.TagError:
        ok(True, '')
tag.ubah('MITRA-BAYU-JAYA', 'MITRA-BAYU', None, ADM)
for salah in ([], 'DEV-1', [5], ['x' * 300]):
    try:
        tag.pasang('MITRA-SURYA', salah, actor=ADM); ok(False, 'daftar perangkat tak sah lolos: %r' % (salah,))
    except tag.TagError:
        ok(True, '')
try:
    tag.pasang('BELUM-ADA', ['DEV-1'], actor=ADM); ok(False, 'pasang tag yang belum ada lolos')
except tag.TagError:
    ok(True, '')

# ══ 2. Lewat server: wewenang ══
import server
PENGGUNA = {'adm': ADM, 'usr': USR}
server.SPAHandler._current_user = lambda self: PENGGUNA.get(self.headers.get('X-Uji') or '')
server.SPAHandler.log_message = lambda *a, **k: None
srv = ThreadingHTTPServer(('127.0.0.1', 0), server.SPAHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
def minta(metode, path, siapa=None, body=None):
    c = http.client.HTTPConnection('127.0.0.1', srv.server_address[1], timeout=20)
    h = {'Content-Type': 'application/json'}
    if siapa: h['X-Uji'] = siapa
    c.request(metode, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse(); raw = r.read(); c.close()
    try: return r.status, json.loads(raw or b'{}')
    except Exception: return r.status, {}
try:
    st, _ = minta('GET', '/config/tag')
    ok(st == 401, 'tanpa login → 401')
    st, d = minta('GET', '/config/tag', 'usr')
    ok(st == 200 and len(d['tag']) == 2 and d['perangkat'].get('DEV-1') == ['MITRA-SURYA']
       and d['bisaBuat'] is False and d['bisaHapus'] is False, 'role user membaca tag (untuk filter); tanpa izin buat/hapus')
    st, _ = minta('POST', '/config/tag', 'usr', {'nama': 'MITRA-USR'})
    ok(st == 403, 'role user tanpa izin "buatTag" → tidak bisa membuat tag')
    st, _ = minta('POST', '/config/tag/pasang', 'usr', {'nama': 'MITRA-SURYA', 'perangkat': ['DEV-9']})
    ok(st == 403 and 'DEV-9' not in tag.per_perangkat(), 'role user tanpa izin → tidak bisa memasang tag')
    st, _ = minta('POST', '/config/izin-role', 'adm', {'role': 'user', 'izin': ['akunSaya', 'tentang', 'buatTag']})
    ok(st == 200, 'administrator memberi izin "buatTag" ke role user')
    st, d = minta('POST', '/config/tag', 'usr', {'nama': 'mitra usr'})
    ok(st == 200 and d['tag']['nama'] == 'MITRA-USR', 'dengan izin: role user membuat tag')
    st, d = minta('POST', '/config/tag/pasang', 'usr', {'nama': 'MITRA-USR', 'perangkat': ['DEV-9']})
    ok(st == 200 and d['berubah'] == 1, 'dengan izin: role user memasang tag')
    st, _ = minta('POST', '/config/tag/hapus', 'usr', {'nama': 'MITRA-USR'})
    ok(st == 403 and any(x['nama'] == 'MITRA-USR' for x in tag.daftar()), 'menghapus nama tag tetap khusus administrator')
    st, _ = minta('POST', '/config/tag/ubah', 'usr', {'nama': 'MITRA-USR', 'namaBaru': 'MILIK-SAYA'})
    ok(st == 403 and any(x['nama'] == 'MITRA-USR' for x in tag.daftar()), 'mengubah nama tag khusus administrator (izin buatTag tidak cukup)')
    st, d = minta('POST', '/config/tag/ubah', 'adm', {'nama': 'MITRA-USR', 'namaBaru': 'mitra usr 2', 'warna': '#22c55e'})
    ok(st == 200 and d['tag'] == {'nama': 'MITRA-USR-2', 'warna': '#22c55e'} and tag.per_perangkat().get('DEV-9') == ['MITRA-USR-2'],
       'administrator mengubah nama & warna; ONU tetap ber-tag')
    minta('POST', '/config/tag/ubah', 'adm', {'nama': 'MITRA-USR-2', 'namaBaru': 'MITRA-USR'})
    st, d = minta('POST', '/config/tag', 'adm', {'nama': 'A B<'})
    ok(st == 400 and d.get('error'), 'nama tak sah → 400 berpenjelasan')
    st, d = minta('POST', '/config/tag/hapus', 'adm', {'nama': 'MITRA-USR'})
    ok(st == 200 and d['terlepas'] == 1 and 'DEV-9' not in tag.per_perangkat(), 'administrator menghapus tag → terlepas dari semua ONU')
finally:
    srv.shutdown(); srv.server_close()

aksi = {r['action'] for r in db.audit_list(limit=200)}
ok({'tag.buat', 'tag.pasang', 'tag.lepas', 'tag.hapus', 'tag.ubah', 'access.denied'} <= aksi, 'buat/pasang/lepas/hapus & penolakan tercatat di audit log')

# ══ 3. Tak menyentuh GenieACS ══
src = open(os.path.join(ROOT, 'backend', 'tag.py'), encoding='utf-8').read()
ok('urllib' not in src and 'acs_url' not in src and 'genieacs_url' not in src.lower(), 'tag.py tidak menghubungi GenieACS sama sekali')
js = open(os.path.join(ROOT, 'frontend', 'js', 'devices.js'), encoding='utf-8').read()
fn = js[js.index('function bukaTagModal'):js.index('// ─── Vendor filter')]
ok("onclick=\"aturTagBaris(this)\"" in js and "bukaTagModal([d.id]" in js, 'kolom Tags punya tombol atur tag per ONU (dicari lewat ID baris)')
ok(not re.search(r'(?<![A-Za-z])ACS\.', fn) and '/api/' not in fn, 'pop-up tag hanya memanggil /config/tag* (bukan NBI)')
ok("cocok: (d, v) => _tagOnu(d.id).indexOf(v) !== -1" in js and "'tag', 'rx'" in js, 'filter tag (bisa >1 tag per ONU) ada di panel Filter')
ok('escHtml(n)' in js[js.index('function _tagSel'):js.index('function muatTagPanel')], 'nama tag di-escape saat digambar')

import shutil
shutil.rmtree(TMP, ignore_errors=True)
print(f'tag: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
