#!/usr/bin/env python3
"""Uji backend/nomorseri.py — dua tulisan nomor seri GPON (2026-10-13).

KEJADIAN: ONU baru SN HWTCCAF31CB0 "tidak ada" di panel; di GenieACS ia tersimpan sebagai
48575443CAF31CB0 (huruf vendor ditulis dalam heksa). Lihat catatan di modulnya.

YANG DIJAGA:
  1. label(): hanya 16 heksa yang 4 byte pertamanya huruf besar A–Z yang diubah; apa pun
     selain itu dikembalikan utuh — salah nomor seri berarti salah perangkat.
  2. heksa() kebalikan persisnya; label(heksa(x)) == x untuk SN berhuruf.
  3. bentuk(): daftar tulisan untuk kueri `$in`, yang diketik lebih dulu, tanpa kembaran.
  4. SN di kalimat Log dan di akun pelanggan memakai tulisan yang sama dengan panel.

Kesamaan hasil dengan aturan di browser (api.js) dijaga tests/snheksa.test.js.
Tidak menyentuh jaringan maupun basis data sungguhan.
"""
import os, sys, tempfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'backend'))
import db
db.set_path(os.path.join(tempfile.mkdtemp(prefix='skysn-'), 'sky.db'))
import nomorseri, pelanggan

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

# ══ 1. label ══
ok(nomorseri.label('48575443CAF31CB0') == 'HWTCCAF31CB0', 'heksa Huawei → huruf (kasus yang dilaporkan)')
ok(nomorseri.label('5A544547AAAA0001') == 'ZTEGAAAA0001' and nomorseri.label('46485454aaaa0002') == 'FHTTAAAA0002', 'vendor lain & heksa huruf kecil')
ok(nomorseri.label('  48575443CAF31CB0\n') == 'HWTCCAF31CB0', 'spasi tepi dibuang')
for utuh in ('HWTCCAF31CB0', 'ZTEGC0FFEE01', 'DF1D-2412014404', '1234567890ABCDEF', '',
             '6877746343414633',        # "hwtc" huruf kecil — bukan kode vendor GPON
             '4857544331', '48575443CAF31CB0A', '48573143CAF31CB0', '4857544ZCAF31CB0',
             'FFFFFFFFFFFFFFFF', '0000000000000000', 'AC1234567890ABCD',
             '8057544331323334'):      # byte pertama 0x80: bukan ASCII
    ok(nomorseri.label(utuh) == utuh, 'tidak diubah: %r → %r' % (utuh, nomorseri.label(utuh)))
ok(nomorseri.label(None) == '' and nomorseri.label(12345) == '12345', 'None → kosong; bukan teks → teksnya')

# ══ 2. heksa ══
ok(nomorseri.heksa('HWTCCAF31CB0') == '48575443CAF31CB0' and nomorseri.heksa('hwtccaf31cb0') == '48575443CAF31CB0', 'huruf → heksa, huruf kecil diterima')
ok(all(nomorseri.heksa(x) is None for x in ('48575443CAF31CB0', 'DF1D-2412014404', 'HWTCCAF31CB', 'HWT1CAF31CB0', '', 'HWTCCAF31CBZ')),
   'yang bukan 4 huruf + 8 heksa → None')
for sn in ('HWTCCAF31CB0', 'ZTEGAAAA0001', 'ALCLFFFFFFFF', 'ABCD00000000'):
    ok(nomorseri.label(nomorseri.heksa(sn)) == sn, 'pulang-pergi huruf → heksa → huruf: ' + sn)

# ══ 3. bentuk ══
ok(nomorseri.bentuk('HWTCCAF31CB0') == ['HWTCCAF31CB0', '48575443CAF31CB0'], 'bentuk(huruf) = [huruf, heksa]')
ok(nomorseri.bentuk('48575443CAF31CB0') == ['48575443CAF31CB0', 'HWTCCAF31CB0'], 'bentuk(heksa) = [heksa, huruf]')
ok(nomorseri.bentuk('hwtccaf31cb0') == ['hwtccaf31cb0', 'HWTCCAF31CB0', '48575443CAF31CB0'], 'huruf kecil: yang diketik, kapital, heksa')
ok(nomorseri.bentuk('ZTEGC0FFEE01') == ['ZTEGC0FFEE01', '5A544547C0FFEE01'], 'SN berhuruf vendor lain juga mendapat tulisan heksanya')
ok(nomorseri.bentuk('DF1D-2412014404') == ['DF1D-2412014404'] and nomorseri.bentuk('') == [] and nomorseri.bentuk(None) == [],
   'SN biasa → dirinya saja; kosong → daftar kosong')
ok(all(isinstance(x, str) and x for b in ('HWTCCAF31CB0', 'x', 'abc') for x in nomorseri.bentuk(b)), 'isi daftar selalu teks tak kosong (aman untuk kueri $in)')

# ══ 4. SN di Log & akun pelanggan ══
ok(pelanggan.sn_dari_id('00259E-HG8145V5-48575443CAF31CB0') == 'HWTCCAF31CB0', 'Log: SN ONU Huawei ditulis berhuruf, sama dengan yang tampil di panel')
ok(pelanggan.sn_dari_id('AA11BB-F663NV9-ZTEGC0001') == 'ZTEGC0001' and pelanggan.sn_dari_id('505B1D-FD512XW%2DR460-DF1D%2D2412014404') == 'DF1D-2412014404',
   'deviceId lain: perilaku lama tidak berubah')
db.init()
import auth
u = auth.create_user('pel.sn', 'Pelanggan#SN-2026', 'Pelanggan SN', role='pelanggan')
c = db.conn()
c.execute('INSERT INTO akun_onu (user_id, device_id, sn, ditambah_oleh, ditambah_at) VALUES (?,?,?,?,?)',
          (u['id'], '00259E-HG8145V5-48575443AAAA0001', '48575443AAAA0001', 'uji', db.now()))
c.commit()
ok(pelanggan.onu_akun(u['id']) == [{'id': '00259E-HG8145V5-48575443AAAA0001', 'sn': 'HWTCAAAA0001'}],
   'pasangan lama (SN tersimpan heksa) ditampilkan berhuruf; device_id tidak berubah')

print(f'nomorseri: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
