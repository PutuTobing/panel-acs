#!/usr/bin/env python3
"""Uji penyimpanan & penegakan Pemetaan Parameter di sisi server.

Logika pemetaannya diuji di tests/vpmap.test.js. Yang diuji DI SINI adalah dua
hal yang hanya bisa salah di sisi server:

  1. DAFTAR FIELD DI DUA TEMPAT. Bawaan pemetaan hidup di js/vpmap.js (di sana
     ia dipakai), tetapi server harus memvalidasi tanpa menjalankan JavaScript —
     jadi daftar fieldnya terpaksa ditulis ulang di config_store.py. Duplikasi
     seperti itu selalu berakhir dengan dua daftar yang diam-diam berbeda:
     seseorang menambah field di panel, server menolaknya sebagai "tidak
     dikenal", dan tak ada yang tahu kenapa. Uji ini MEMBACA kedua berkas dan
     membandingkannya.

  2. VALIDASI DITEGAKKAN DI SERVER, BUKAN DI FORMULIR. Formulir bisa dilewati
     dengan satu curl, dan pemetaan cacat membuat SELURUH halaman perangkat
     menampilkan '—' tanpa ada yang tahu sebabnya.
"""
import os, sys, re, json, tempfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import db
db.set_path(os.path.join(tempfile.mkdtemp(prefix='skyvp-'), 'sky.db'))
import config_store

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)


# ══ 1. Daftar field & turunan harus sama dengan js/vpmap.js ══
js = open(os.path.join(ROOT, 'js', 'vpmap.js'), encoding='utf-8').read()

# Field = kunci tingkat atas di dalam blok BAWAAN.fields { ... }
blok = js[js.index('fields: {'):js.index('const TRANSFORMASI')]
field_js = set(re.findall(r'^      (\w+): \{', blok, re.M))
ok(field_js == set(config_store.VP_FIELDS),
   'daftar field config_store.py == js/vpmap.js\n     hanya di JS: %s\n     hanya di PY: %s'
   % (sorted(field_js - set(config_store.VP_FIELDS)),
      sorted(set(config_store.VP_FIELDS) - field_js)))

turunan_js = set(re.findall(r'^    (\w+): function \(raw\)', js, re.M))
ok(turunan_js == set(config_store.VP_TURUNAN),
   'daftar sumber turunan sama di kedua berkas (JS: %s, PY: %s)'
   % (sorted(turunan_js), sorted(config_store.VP_TURUNAN)))

tr_js = re.search(r"const TRANSFORMASI = \[([^\]]*)\]", js).group(1)
tr_js = set(re.findall(r"'(\w+)'", tr_js))
ok(tr_js == set(config_store.VP_TRANSFORMASI),
   'daftar transformasi sama di kedua berkas (JS: %s, PY: %s)'
   % (sorted(tr_js), sorted(config_store.VP_TRANSFORMASI)))


# ══ 2. Validasi server ══
def sah(m):   return config_store.vp_validate(m) is None
def tolak(m): return config_store.vp_validate(m) is not None

ok(tolak(None), 'None ditolak')
ok(tolak('bukan objek'), 'string ditolak')
ok(tolak({}), 'tanpa fields ditolak')
ok(tolak({'fields': {}}), 'fields kosong ditolak')
ok(tolak({'fields': {'ngawur': {'sumber': ['VirtualParameters.X']}}}),
   'field tak dikenal ditolak')
ok(tolak({'fields': {'rxPower': {'sumber': []}}}), 'sumber kosong ditolak')
ok(tolak({'fields': {'rxPower': {'sumber': ['Wlan.SSID']}}}),
   'sumber tanpa awalan sah ditolak')
ok(tolak({'fields': {'rxPower': {'sumber': ['VirtualParameters.A,VirtualParameters.B']}}}),
   'sumber bertanda koma ditolak')
ok(tolak({'fields': {'rxPower': {'sumber': ['@karangan']}}}),
   'sumber turunan karangan ditolak')
ok(tolak({'fields': {'rxPower': {'sumber': ['VirtualParameters.X'], 'transform': 'aneh'}}}),
   'transformasi tak dikenal ditolak')
ok(tolak({'fields': {'rxPower': {'sumber': ['VirtualParameters.X'] * 13}}}),
   'sumber berlebihan ditolak (batas %d)' % config_store.VP_MAKS_SUMBER)
ok(tolak({'fields': {'rxPower': {'sumber': ['   ']}}}), 'sumber berisi spasi ditolak')
ok(sah({'fields': {'rxPower': {'sumber': ['VirtualParameters.RXPower',
                                          'InternetGatewayDevice.WANDevice.1.X.RXPower',
                                          '@hostConnectionRequest']}}}),
   'pemetaan wajar diterima')
ok(sah({'fields': {'serial': {'sumber': ['@deviceIdSerial', '@idSerial']}}}),
   'kedua sumber turunan serial dikenali server')


# ══ 3. Simpan / baca / kembalikan ══
db.conn()
ok(config_store.vp_get() is None,
   'bawaan: tidak ada pemetaan tersimpan (panel memakai bawaannya sendiri)')

peta = {'version': 1, 'fields': {'ipTr069': {
    'label': 'IP TR-069',
    'sumber': ['VirtualParameters.IPTR069', '@hostConnectionRequest']}}}
config_store.vp_set(peta, actor={'id': None, 'username': 'admin'})
ok(config_store.vp_get() == peta, 'pemetaan tersimpan & terbaca utuh')

gagal = False
try:
    config_store.vp_set({'fields': {'rxPower': {'sumber': ['Salah.Awalan']}}},
                        actor={'id': None, 'username': 'admin'})
except ValueError:
    gagal = True
ok(gagal, 'menyimpan pemetaan cacat melempar ValueError')
ok(config_store.vp_get() == peta, 'pemetaan lama tidak rusak oleh simpan yang gagal')

config_store.vp_set(None, actor={'id': None, 'username': 'admin'})
ok(config_store.vp_get() is None, 'mengirim None mengembalikan ke bawaan')

rows = db.audit_list(limit=20)
ok(any(r['action'] == 'vpmap.set' for r in rows), 'menyimpan pemetaan tercatat di audit')
ok(any(r['action'] == 'vpmap.reset' for r in rows), 'mengembalikan ke bawaan tercatat')

# Baris rusak di basis data tidak boleh mematikan halaman perangkat.
db.kv_set('app_parameters', config_store.VP_MAPPING_KEY, '{bukan json')
ok(config_store.vp_get() is None,
   'JSON rusak di DB → jatuh ke bawaan, bukan melempar galat ke halaman')


# ══ 4. Jalur server terpasang ══
src = open(os.path.join(ROOT, 'server.py'), encoding='utf-8').read()
ok("'/config/vp-mapping' and method == 'GET'" in src, 'ada endpoint baca pemetaan')
ok("'/config/vp-mapping' and method == 'POST'" in src, 'ada endpoint simpan pemetaan')
ok(re.search(r"vp-mapping' and method == 'POST'[\s\S]{0,200}_require_admin", src),
   'menyimpan pemetaan hanya untuk administrator')
ok("'vpMapping': config_store.vp_get()" in src,
   'pemetaan ikut dikirim di /config/all supaya siap sebelum halaman pertama digambar')

main = open(os.path.join(ROOT, 'js', 'main.js'), encoding='utf-8').read()
ok('VPMap.setPeta(d.vpMapping)' in main, 'panel memasang pemetaan dari server saat boot')

# Halaman Settings-nya harus murni baca — kalau halaman untuk MEMPERBAIKI
# pembacaan justru membebani ONU, ia melawan tujuannya sendiri.
st = open(os.path.join(ROOT, 'js', 'settings.js'), encoding='utf-8').read()
awal = st.index('function renderVpMap')
akhir = st.index('async function saveParamConfig')
bagian = st[awal:akhir]
ok('/tasks' not in bagian, 'halaman Pemetaan tidak pernah mengirim task ke ONU')
ok(bagian.count("fetch(url, { credentials: 'same-origin' })") >= 1,
   'pengambilan dokumen memakai GET biasa')
# Satu-satunya POST yang boleh ada di halaman ini adalah menyimpan pemetaan itu
# sendiri — ke panel, bukan ke GenieACS.
post_ke = re.findall(r"authFetch\('([^']+)',\s*\{\s*method:\s*'POST'", bagian)
ok(set(post_ke) <= {'/config/vp-mapping'},
   'satu-satunya POST di halaman Pemetaan adalah /config/vp-mapping (dapat %s)' % post_ke)

print('vpmap-server: %d lulus, %d gagal' % (_p, _f))
sys.exit(1 if _f else 0)
