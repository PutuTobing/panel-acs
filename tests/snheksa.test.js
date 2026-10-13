#!/usr/bin/env node
/* Uji nomor seri GPON berbentuk heksa (2026-10-13).
 *
 * KEJADIAN: ONU baru SN HWTCCAF31CB0 sudah inform ke GenieACS tetapi "tidak ada" di panel.
 * Perangkatnya ada di daftar — sebagai 48575443CAF31CB0, karena sebagian ONU Huawei
 * melaporkan huruf vendor dalam heksa (48 57 54 43 = "HWTC") — dan pencarian hanya
 * mencocokkan tulisan itu. Diukur pada 2.016 perangkat: 4 berbentuk heksa, 1.940 berhuruf.
 *
 * Yang dijaga:
 *   1. Aturan ubahnya SEMPIT: hanya 16 heksa yang 4 byte pertamanya huruf besar A–Z.
 *      Tulisan lain apa pun tidak disentuh (salah SN = salah perangkat).
 *   2. Panel menampilkan bentuk huruf; tulisan di GenieACS tetap tersedia (serialAcs) dan
 *      _id perangkat — yang dipakai SEMUA perintah — tidak berubah.
 *   3. Pencarian menemukan ONU dengan tulisan mana pun, sebagian maupun utuh.
 *   4. Mencari perangkat dari SN yang diketik memakai semua tulisannya ($in).
 *   5. Aturan di browser (api.js) dan di server (backend/nomorseri.py) memberi hasil yang
 *      SAMA untuk masukan yang sama — dijalankan dua-duanya, bukan dicocokkan sebagai teks.
 *
 * Semua SN di sini buatan. Fungsi yang diuji dijalankan sungguhan dari berkas aslinya.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const baca = f => fs.readFileSync(path.join(ROOT, 'frontend', 'js', f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// ── api.js + vpmap.js asli di kotak pasir ──
let urlTerakhir = '';
const ctx = { console, App: {}, setTimeout() {}, clearTimeout() {},
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
  fetch: async (u) => { urlTerakhir = String(u); return { ok: true, status: 200, text: async () => '[]' }; } };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(baca('vpmap.js'), ctx);
vm.runInContext(baca('api.js') + '\nthis.ACS = ACS;', ctx);
const ACS = ctx.ACS;

// ══ 1. Aturan ubah ══
ok(typeof ACS.snLabel === 'function' && typeof ACS.snBentuk === 'function', 'ACS.snLabel & ACS.snBentuk tersedia');
const SAMA = v => ok(ACS.snLabel(v) === String(v == null ? '' : v).trim(), 'tidak diubah: ' + JSON.stringify(v) + ' → ' + JSON.stringify(ACS.snLabel(v)));
ok(ACS.snLabel('48575443CAF31CB0') === 'HWTCCAF31CB0', 'heksa Huawei → huruf (kasus yang dilaporkan)');
ok(ACS.snLabel('5A544547AAAA0001') === 'ZTEGAAAA0001' && ACS.snLabel('46485454AAAA0002') === 'FHTTAAAA0002', 'vendor lain (ZTEG, FHTT) ikut aturan yang sama');
ok(ACS.snLabel('48575443caf31cb0') === 'HWTCCAF31CB0' && ACS.snLabel('  48575443CAF31CB0 ') === 'HWTCCAF31CB0', 'heksa huruf kecil / berspasi tepi → bentuk huruf kapital');
['HWTCCAF31CB0', 'ZTEGC0FFEE01', 'DF1D-2412014404', '1234567890ABCDEF', '0025 9E', '', null, undefined,
 '6877746343414633',            // 4 byte pertama huruf KECIL ("hwtc") — bukan kode vendor GPON
 '4857544331',                  // terlalu pendek
 '48575443CAF31CB0A',           // 17 karakter
 '48573143CAF31CB0',            // byte ketiga '1' (angka), bukan huruf
 '4857544ZCAF31CB0',            // bukan heksa
 'FFFFFFFFFFFFFFFF', '0000000000000000', 'AC1234567890ABCD'].forEach(SAMA);
ok(JSON.stringify(ACS.snBentuk('HWTCCAF31CB0')) === JSON.stringify(['HWTCCAF31CB0', '48575443CAF31CB0']), 'snBentuk(huruf) → [huruf, heksa]');
ok(JSON.stringify(ACS.snBentuk('48575443CAF31CB0')) === JSON.stringify(['48575443CAF31CB0', 'HWTCCAF31CB0']), 'snBentuk(heksa) → [heksa, huruf]');
ok(JSON.stringify(ACS.snBentuk('hwtccaf31cb0')) === JSON.stringify(['hwtccaf31cb0', 'HWTCCAF31CB0', '48575443CAF31CB0']), 'snBentuk(huruf kecil) memuat kapital & heksa');
ok(JSON.stringify(ACS.snBentuk('DF1D-2412014404')) === JSON.stringify(['DF1D-2412014404']) && ACS.snBentuk('').length === 0, 'SN biasa → hanya dirinya; kosong → daftar kosong');

// ══ 2. mapDevice: yang tampil bentuk huruf, identitas tidak berubah ══
const dok = (id, sn, vp) => ({ _id: id, _lastInform: '2026-10-13T03:12:04.214Z',
  _deviceId: { _Manufacturer: 'Huawei Technologies Co., Ltd', _OUI: '00259E', _ProductClass: id.split('-')[1], _SerialNumber: sn },
  VirtualParameters: vp ? { getSerialNumber: { _value: vp } } : {} });
const hw = ACS.mapDevice(dok('00259E-HG8145V5-48575443AAAA0001', '48575443AAAA0001', 'HWTCAAAA0001'));
ok(hw.serial === 'HWTCAAAA0001' && hw.serialAcs === '48575443AAAA0001', 'ONU ber-SN heksa: tampil HWTCAAAA0001, tulisan GenieACS tetap tersedia');
ok(hw.id === '00259E-HG8145V5-48575443AAAA0001', '_id perangkat (dipakai semua perintah) TIDAK berubah');
const hwTanpaVp = ACS.mapDevice(dok('00259E-HG8245A-48575443AAAA0003', '48575443AAAA0003', null));
ok(hwTanpaVp.serial === 'HWTCAAAA0003', 'tanpa VP getSerialNumber pun bentuk huruf diperoleh dari aturan (bukan dari VP)');
const zl = ACS.mapDevice(dok('AC1234-ZL%2D2113X-HWTCBBBB0002', 'HWTCBBBB0002', 'HWTCBBBB0002'));
ok(zl.serial === 'HWTCBBBB0002' && zl.serialAcs === 'HWTCBBBB0002', 'ONU yang sudah ber-SN huruf: tidak berubah');
const cd = ACS.mapDevice(dok('505B1D-FD512XW%2DR460-DF1D%2D2412014404', 'DF1D-2412014404', null));
ok(cd.serial === 'DF1D-2412014404' && cd.serialAcs === cd.serial, 'SN C-DATA (bukan GPON) tidak disentuh');

// ══ 3. Pencarian di menu Device ══
const dev = baca('devices.js');
const iris = nama => {
  const i = dev.indexOf('function ' + nama + '(');
  let j = dev.indexOf('{', i), dalam = 0;
  for (; j < dev.length; j++) { if (dev[j] === '{') dalam++; else if (dev[j] === '}' && --dalam === 0) break; }
  return dev.slice(i, j + 1);
};
vm.runInContext('function _tagOnu() { return []; }\n' + iris('_matchSearch') + '\n' + iris('_cocokMac')
  + '\nthis.cari = function (q, d) { App.deviceSearch = q; return _matchSearch(d); };', ctx);
for (const q of ['HWTCAAAA0001', 'hwtcaaaa0001', 'HWTCAAAA', 'AAAA0001', '48575443AAAA0001', '48575443aaaa0001', '48575443', 'HG8145V5']) {
  ok(ctx.cari(q, hw) === true, 'cari ' + JSON.stringify(q) + ' menemukan ONU ber-SN heksa');
}
ok(ctx.cari('48575443BBBB0002', zl) === true, 'SN heksa UTUH (dari OLT/GenieACS) menemukan ONU yang tampil berhuruf');
ok(ctx.cari('HWTCBBBB0002', hw) === false && ctx.cari('ZTEG', hw) === false && ctx.cari('48575443AAAA0009', hw) === false, 'SN lain tidak ikut cocok');
ok(ctx.cari('', hw) === true, 'tanpa kata cari → semua tampil');

// ══ 4. Mencari perangkat dari SN yang diketik ══
(async () => {
  await ACS.probeParam('HWTCAAAA0001', 'InternetGatewayDevice.DeviceInfo.SerialNumber');
  const q = JSON.parse(decodeURIComponent(/query=([^&]+)/.exec(urlTerakhir)[1]));
  ok(JSON.stringify(q) === JSON.stringify({ '_deviceId._SerialNumber': { $in: ['HWTCAAAA0001', '48575443AAAA0001'] } }),
     'probeParam(SN huruf) mencari kedua tulisan — ' + JSON.stringify(q));
  await ACS.probeParam('00259E-HG8145V5-48575443AAAA0001', 'InternetGatewayDevice.DeviceInfo.SerialNumber');
  ok(JSON.stringify(JSON.parse(decodeURIComponent(/query=([^&]+)/.exec(urlTerakhir)[1]))) === '{"_id":"00259E-HG8145V5-48575443AAAA0001"}',
     'probeParam(Device ID) tetap mencari _id persis');
  const st = baca('settings.js');
  ok(st.includes("'_deviceId._SerialNumber': { $in: ACS.snBentuk(sn) }"), 'Pemetaan Parameter → Uji menurut SN mencari kedua tulisan');
  const srv = fs.readFileSync(path.join(ROOT, 'backend', 'server.py'), 'utf8');
  ok(srv.includes("{'_deviceId._SerialNumber': {'$in': nomorseri.bentuk(sn)}}"), 'server: memasangkan ONU ke akun pelanggan mencari kedua tulisan');
  const guard = fs.readFileSync(path.join(ROOT, 'backend', 'acs_guard.py'), 'utf8');
  ok(/OPERATOR_BACA = frozenset\(\{[^}]*'\$in'/.test(guard), "operator $in ada di daftar-izin kueri baca (kalau tidak, pencarian SN ditolak pagar)");

  // ══ 5. Tampilan ══
  ok(/\$\{escHtml\(d\.serial\)\}<\/span><\/td>/.test(dev) && dev.includes("'Di GenieACS tertulis ' + escHtml(d.serialAcs)"),
     'tabel Device: kolom SN menampilkan bentuk huruf; tulisan GenieACS di keterangan sel (di-escape)');
  const dd = baca('device-detail.js');
  ok(dd.includes("'SN di GenieACS'") && dd.includes('`<code>${escHtml(d.serialAcs)}</code>`') && dd.includes('(d.serialAcs && d.serialAcs !== d.serial)'),
     'Detail ONU: baris "SN di GenieACS" hanya untuk ONU yang tulisannya berbeda');
  ok(dev.includes("'serialAcs'") && /ACS\.snLabel\(q\)/.test(iris('_matchSearch')), 'pencarian mencocokkan serialAcs dan mengubah SN heksa yang diketik');
  // Judul Detail ONU = ID perangkat di GenieACS: memakai tulisan GenieACS, supaya bila disalin
  // ke kolom "SN / Device ID" tetap ditemukan (temuan tinjauan 2026-10-13).
  ok(dd.includes("[d.id.split('-')[0], d.model, (d.serialAcs || d.serial)]"), 'judul Detail ONU memakai tulisan SN di GenieACS (sama dengan _id)');
  // Kesehatan ACS: _id mentah diberi tulisan hurufnya — fungsi aslinya dijalankan.
  const mulai = st.indexOf('function _kshEsc('), akhirKsh = st.indexOf('\n}\n', st.indexOf('function _kshOnu(')) + 3;
  vm.runInContext(st.slice(mulai, akhirKsh) + '\nthis._kshOnu = _kshOnu;', ctx);
  ok(ctx._kshOnu('00259E-HG8145V5-48575443AAAA0001') === '00259E-HG8145V5-48575443AAAA0001 <small class="ksh-sn">SN HWTCAAAA0001</small>',
     'Kesehatan ACS: ONU ber-SN heksa diberi tulisan hurufnya — ' + ctx._kshOnu('00259E-HG8145V5-48575443AAAA0001'));
  ok(ctx._kshOnu('AA11BB-F663NV9-ZTEGAAAA0002') === 'AA11BB-F663NV9-ZTEGAAAA0002' && ctx._kshOnu('<img src=x>') === '&lt;img src=x&gt;' && ctx._kshOnu(null) === '',
     'Kesehatan ACS: ONU lain tidak berubah; teks tetap di-escape');
  ok((st.match(/_kshOnu\(x\.device\)/g) || []).length === 3 && !/_kshEsc\(x\.device\)/.test(st), 'ketiga tabel Kesehatan ACS memakai _kshOnu');
  const alat = fs.readFileSync(path.join(ROOT, 'tools', 'audit_ont.js'), 'utf8');
  ok(alat.includes('muatPanel().ACS.snBentuk(sn)'), 'tools/audit_ont.js mencari semua tulisan SN (aturan yang sama dengan panel)');

  // ══ 6. Browser dan server memberi hasil yang SAMA (dijalankan dua-duanya) ══
  const masukan = ['48575443CAF31CB0', 'HWTCCAF31CB0', 'hwtccaf31cb0', '48575443caf31cb0', 'DF1D-2412014404', '', '1234567890ABCDEF',
                   '6877746343414633', '5A544547AAAA0001', 'ZTEGAAAA0001', 'FFFFFFFFFFFFFFFF', '48573143CAF31CB0', 'ABCD1234', ' HWTCAAAA0001 ',
                   'Ztegaaaa0001', '4142434445464748', '41424344454647GG', 'HWTCCAF31CB', 'HWTCCAF31CB01'];
  let benih = 20261013;                       // acak tertentukan: 16 heksa yang byte depannya sering huruf
  const acak = n => { benih = (benih * 1103515245 + 12345) & 0x7fffffff; return benih % n; };
  for (let i = 0; i < 200; i++) {
    let s = '';
    for (let b = 0; b < 4; b++) s += (acak(3) ? 0x41 + acak(26) : acak(256)).toString(16).padStart(2, '0');
    for (let b = 0; b < 8; b++) s += '0123456789abcdefABCDEF'[acak(22)];
    masukan.push(acak(2) ? s.toUpperCase() : s);
  }
  const py = process.env.SKY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const kode = 'import sys, json; sys.path.insert(0, sys.argv[1]); import nomorseri as n; '
             + 'print(json.dumps([[n.label(x), n.bentuk(x)] for x in json.loads(sys.stdin.read())]))';
  const r = spawnSync(py, ['-c', kode, path.join(ROOT, 'backend')], { input: JSON.stringify(masukan), encoding: 'utf8' });
  if (r.status !== 0) {
    console.log('  (python tidak bisa dijalankan — perbandingan browser/server dilewati: ' + String(r.stderr || r.error).slice(0, 80) + ')');
  } else {
    const dariPy = JSON.parse(r.stdout);
    const beda = masukan.filter((x, i) => ACS.snLabel(x) !== dariPy[i][0] || JSON.stringify(ACS.snBentuk(x)) !== JSON.stringify(dariPy[i][1]));
    ok(beda.length === 0, masukan.length + ' masukan: api.js dan nomorseri.py memberi hasil SAMA — berbeda pada ' + JSON.stringify(beda.slice(0, 3)));
    ok(masukan.filter(x => ACS.snLabel(x) !== x.trim()).length > 20, 'masukan acak memang memuat banyak SN yang diubah (ujinya tidak kosong)');
  }

  console.log('snheksa: ' + pass + ' lulus, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})();
