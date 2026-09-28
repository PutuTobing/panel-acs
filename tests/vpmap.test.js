#!/usr/bin/env node
/* Uji lapisan pemetaan VirtualParameter & umur data (js/vpmap.js).
 *
 * LATAR. Tiap pemasangan GenieACS menamai VP-nya sendiri, dan cakupannya tidak
 * seragam antar firmware. Diukur pada armada ini 2026-08-02 (ONU aktif saja):
 *
 *     model          unit   IPTR069   PonMac   getpppuptime   getVlan
 *     F663NV9        1112      37%       0%          99%        100%
 *     ZL-2113X        152      13%     100%          15%         85%
 *     Trikom F609       5       0%       0%         100%        100%
 *     F679L            10     100%     100%         100%          0%
 *
 * Artinya memetakan satu field ke SATU nama VP tidak pernah cukup. Berkas yang
 * diuji di sini mengubahnya jadi rantai kandidat.
 *
 * YANG PALING DIJAGA — dan alasan berkas ini ada:
 *
 *   1. KANDIDAT PERTAMA TIAP FIELD = PERILAKU LAMA. Menambah kandidat tidak
 *      boleh pernah mengubah nilai yang sudah tampil, hanya mengisi yang
 *      tadinya '—'. Kalau ini jebol, 1.796 halaman perangkat berubah diam-diam.
 *
 *   2. URUTAN KANDIDAT SERIAL TIDAK BOLEH BERGESER. Salah serial berarti salah
 *      perangkat — kesalahan termahal di aplikasi ini.
 *
 *   3. TIDAK ADA SUMBER YANG MENYURUH ONU BEKERJA. Seluruh rantai dibaca dari
 *      dokumen yang sudah tersimpan di GenieACS. Kalau suatu saat ada yang
 *      menyelipkan pemanggilan task ke sini, seluruh janji "gratis bagi ONU"
 *      batal.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'js', 'vpmap.js'), 'utf8');
eval(src);                                   // → globalThis.VPMap

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const leaf = (v, t) => ({ _value: v, _timestamp: t || '2026-08-03T04:00:00.000Z',
                          _object: false, _type: 'xsd:string' });

// ── 1. Bentuk bawaan ──
ok(!!VPMap.BAWAAN.fields, 'ada pemetaan bawaan');
ok(VPMap.periksa(VPMap.BAWAAN) === null,
   'pemetaan bawaan lolos pemeriksaannya sendiri: ' + VPMap.periksa(VPMap.BAWAAN));

// Kandidat pertama WAJIB sama dengan yang dibaca panel sebelum ada pemetaan.
// Ini penjaga utama berkas ini — lihat catatan 1 di kepala berkas.
const PERTAMA_LAMA = {
  rxPower:   'VirtualParameters.RXPower',
  txPower:   'VirtualParameters.getTXPower',
  suhu:      'VirtualParameters.gettemp',
  ponMode:   'VirtualParameters.getponmode',
  ipTr069:   'VirtualParameters.IPTR069',
  pppoeUser: 'VirtualParameters.pppoeUsername',
  pppoePass: 'VirtualParameters.pppoePassword',
  ipPppoe:   'VirtualParameters.pppoeIP',
  vlan:      'VirtualParameters.getVlan',
  wlanPass:  'VirtualParameters.WlanPassword',
  uptime:    'VirtualParameters.getdeviceuptime',
  pppUptime: 'VirtualParameters.getpppuptime',
  klienAktif:'VirtualParameters.activedevices',
  ponMac:    'VirtualParameters.PonMac',
  pppoeMac:  'VirtualParameters.pppoeMac',
  serial:    '@deviceIdSerial',
};
Object.keys(PERTAMA_LAMA).forEach(k => {
  const f = VPMap.BAWAAN.fields[k];
  ok(f && f.sumber[0] === PERTAMA_LAMA[k],
     'kandidat #1 ' + k + ' = ' + PERTAMA_LAMA[k]
     + ' (dapat ' + (f ? f.sumber[0] : 'FIELD HILANG') + ')');
});

// Urutan serial dikunci utuh, bukan hanya kandidat pertamanya.
ok(JSON.stringify(VPMap.BAWAAN.fields.serial.sumber) === JSON.stringify(
     ['@deviceIdSerial', 'InternetGatewayDevice.DeviceInfo.SerialNumber',
      'VirtualParameters.getSerialNumber', '@idSerial']),
   'urutan kandidat serial sama persis dengan perilaku panel sebelumnya');

// ── 2. Rantai: yang pertama TERISI menang ──
const dok = {
  _id: '64E0AB-F663NV3A-ZTEG1B874818',
  _deviceId: { _SerialNumber: 'ZTEG1B874818', _ProductClass: 'F663NV3A' },
  _lastInform: '2026-08-03T04:00:00.000Z',
  VirtualParameters: {
    RXPower: leaf('-24.09 dBm'),
    IPTR069: leaf(''),                       // kosong — persis keadaan nyata
    pppoeUsername: leaf(''),
  },
  InternetGatewayDevice: {
    ManagementServer: { ConnectionRequestURL: leaf('http://10.17.1.126:58000/jCeEgZ') },
    WANDevice: { 1: { WANConnectionDevice: { 1: {
      WANPPPConnection: { 1: { Username: leaf('1400451MANGKU@sky') } } } } } },
  },
};

let r = VPMap.resolve(dok, 'rxPower');
ok(r.nilai === '-24.09 dBm' && r.indeks === 0, 'kandidat #1 terisi → dipakai');

r = VPMap.resolve(dok, 'ipTr069');
ok(r.nilai === '10.17.1.126',
   'VP kosong → jatuh ke kandidat berikutnya (dapat ' + r.nilai + ')');
ok(r.sumber === '@hostConnectionRequest', 'sumber yang menang ikut dilaporkan');
ok(r.indeks === 2, 'indeks kandidat ikut dilaporkan (dapat ' + r.indeks + ')');

r = VPMap.resolve(dok, 'pppoeUser');
ok(r.nilai === '1400451MANGKU@sky', 'jalur TR-069 mentah dipakai saat VP kosong');

r = VPMap.resolve(dok, 'vlan');
ok(r.nilai === null && r.indeks === -1, 'seluruh kandidat kosong → null, indeks -1');

// String kosong & spasi TIDAK dianggap terisi — kalau dianggap terisi, seluruh
// rantai berhenti di VP kosong dan pemetaan ini tak ada gunanya.
ok(VPMap._terisi('') === false, 'string kosong bukan "terisi"');
ok(VPMap._terisi('   ') === false, 'spasi saja bukan "terisi"');
ok(VPMap._terisi(0) === true, 'angka 0 TETAP terisi (0 klien itu jawaban sah)');
ok(VPMap._terisi(false) === true, 'false TETAP terisi');

// ── 3. Wildcard ──
const dokW = { A: { 10: { B: leaf('sepuluh') }, 2: { B: leaf('dua') },
                    x: { B: leaf('abaikan') } } };
ok(JSON.stringify(VPMap._telusuri(dokW, ['A', '*', 'B']).map(n => n._value))
     === JSON.stringify(['dua', 'sepuluh']),
   'wildcard menelusuri instance urut ANGKA (2 sebelum 10), bukan urut teks');

const dokIp = {
  VirtualParameters: { IPTR069: leaf('') },
  InternetGatewayDevice: { WANDevice: { 1: { WANConnectionDevice: {
    2: { WANIPConnection: { 1: { ExternalIPAddress: leaf('10.9.9.9') } } } } } } },
};
ok(VPMap.resolve(dokIp, 'ipTr069').nilai === '10.9.9.9',
   'wildcard menemukan instance yang bukan .1');

// ── 4. Transformasi ──
ok(VPMap._ubah('12', 'angka') === 12, 'transform angka');
ok(VPMap._ubah('abc', 'angka') === null, 'transform angka pada teks → null');
ok(VPMap._ubah('-24.093', 'dbm') === '-24.09', 'transform dbm dibulatkan 2 desimal');
ok(VPMap._ubah('1', 'bool') === true, 'transform bool');
ok(VPMap._ubah('AABBCCDDEEFF', 'mac') === 'AA:BB:CC:DD:EE:FF', 'transform mac');
ok(VPMap._ubah('bukan-mac', 'mac') === 'bukan-mac', 'mac tak berbentuk dikembalikan apa adanya');

// ── 5. Umur data (butir 6) ──
const T0 = new Date('2026-08-03T12:00:00.000Z').getTime();
const pada = (menit) => VPMap.umur(new Date(T0 - menit * 60000).toISOString(), T0);
ok(pada(0).teks === 'baru saja', 'umur < 1 menit → "baru saja"');
ok(pada(3).teks === '3 menit lalu', 'umur menit');
ok(pada(90).teks === '1 jam lalu', 'umur jam');
ok(pada(3000).teks === '2 hari lalu', 'umur hari');
ok(pada(5).tingkat === 'segar', '< 15 menit → segar');
ok(pada(30).tingkat === 'redup', '15–60 menit → redup');
ok(pada(90).tingkat === 'tua', '> 60 menit → tua');
ok(pada(90).perluSegar === true, 'yang tua ditandai perlu disegarkan');
ok(pada(5).perluSegar === false, 'yang segar tidak mengajak menekan Refresh');
ok(VPMap.umur(null) === null, 'tanpa timestamp → null (bukan "baru saja")');
ok(VPMap.umur('bukan tanggal') === null, 'timestamp tak terbaca → null');

// Umur diambil dari sumber yang BENAR-BENAR dipakai, bukan kandidat pertama.
const dokU = {
  VirtualParameters: { IPTR069: leaf('', '2020-01-01T00:00:00.000Z') },
  InternetGatewayDevice: { ManagementServer: {
    ConnectionRequestURL: leaf('http://10.0.0.5:58000/x', '2026-08-03T11:59:00.000Z') } },
};
ok(VPMap.resolve(dokU, 'ipTr069').waktu === '2026-08-03T11:59:00.000Z',
   'umur mengikuti kandidat yang menang, bukan kandidat pertama yang kosong');
ok(VPMap.umurSemua(dokU).ipTr069 === '2026-08-03T11:59:00.000Z',
   'umurSemua memakai sumber yang sama dengan nilainya');

// ── 6. Pemeriksaan bentuk ──
const salah = (m) => VPMap.periksa(m) !== null;
ok(salah(null), 'null ditolak');
ok(salah({}), 'tanpa fields ditolak');
ok(salah({ fields: { tidakDikenal: { sumber: ['VirtualParameters.X'] } } }),
   'field tak dikenal ditolak');
ok(salah({ fields: { rxPower: { sumber: [] } } }), 'sumber kosong ditolak');
ok(salah({ fields: { rxPower: { sumber: ['Wlan.SSID'] } } }),
   'sumber tanpa awalan sah ditolak');
ok(salah({ fields: { rxPower: { sumber: ['VirtualParameters.A,VirtualParameters.B'] } } }),
   'sumber bertanda koma ditolak (bentuk 32 task cacat)');
ok(salah({ fields: { rxPower: { sumber: ['@tidakAda'] } } }),
   'sumber turunan karangan ditolak');
ok(salah({ fields: { rxPower: { sumber: ['VirtualParameters.X'], transform: 'aneh' } } }),
   'transformasi tak dikenal ditolak');
ok(VPMap.periksa({ fields: { rxPower: { sumber: ['VirtualParameters.X',
                                                 '@hostConnectionRequest'] } } }) === null,
   'pemetaan wajar diterima');

// ── 7. Proyeksi ──
// Rantai kandidat tak ada gunanya kalau jalurnya tidak ikut terambil dari NBI.
const proy = VPMap.proyeksi();
ok(proy.indexOf('InternetGatewayDevice.ManagementServer.ConnectionRequestURL') >= 0,
   'proyeksi menyertakan ConnectionRequestURL (dibutuhkan @hostConnectionRequest)');
ok(proy.some(p => p === 'InternetGatewayDevice.WANDevice'),
   'jalur ber-wildcard diproyeksikan sampai sebelum tanda * saja');
ok(!proy.some(p => p.indexOf('*') >= 0), 'tidak ada tanda * yang bocor ke proyeksi');
ok(!proy.some(p => p.charAt(0) === '@'), 'sumber turunan tidak ikut jadi proyeksi');

// ── 8. Cakupan (deteksi otomatis) ──
const contoh = [
  { VirtualParameters: { IPTR069: leaf('1.1.1.1') } },
  { VirtualParameters: { IPTR069: leaf('') },
    InternetGatewayDevice: { ManagementServer: {
      ConnectionRequestURL: leaf('http://2.2.2.2:58000/x') } } },
  { VirtualParameters: { IPTR069: leaf('') } },
];
const cak = VPMap.cakupan(contoh);
ok(cak.ipTr069.terisi === 2 && cak.ipTr069.persen === 67,
   'cakupan menghitung berapa perangkat yang terisi (dapat '
   + cak.ipTr069.terisi + '/' + cak.ipTr069.total + ')');
ok(cak.ipTr069.perSumber[0].dipakai === 1 && cak.ipTr069.perSumber[2].dipakai === 1,
   'cakupan merinci kandidat MANA yang bekerja — itu yang menuntun perbaikan');

// ── 9. Penjaga keselamatan ──
// Seluruh berkas ini harus MURNI BACA. Kalau suatu saat ada yang menyelipkan
// pengiriman task ke sini, janji "menambah kandidat tidak membebani ONU" batal.
const bersih = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/fetch\s*\(/.test(bersih), 'vpmap.js tidak memanggil fetch — murni baca dari dokumen');
ok(!/tasks/.test(bersih), 'vpmap.js tidak menyentuh endpoint tasks');
ok(!/refreshObject|setParameterValues|reboot|factoryReset/.test(bersih),
   'vpmap.js tidak mengenal satu pun perintah ke ONU');

// api.js harus benar-benar memakainya, dan tetap punya jalan mundur.
const apiSrc = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
ok(/VPMap\.nilai\(raw,/.test(apiSrc), 'mapDevice memakai VPMap.nilai');
ok(/VPMap\.umurSemua\(raw\)/.test(apiSrc), 'mapDevice membawa umur data ke UI');
ok(/_gabungProyeksi/.test(apiSrc), 'proyeksi digabung dengan kebutuhan pemetaan');
ok(/catch \(_\) \{ \/\* jatuh ke perilaku lama \*\/ \}/.test(apiSrc),
   'ada jalan mundur bila vpmap.js gagal dimuat');

const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(idx.indexOf('/js/vpmap.js') < idx.indexOf('/js/api.js'),
   'vpmap.js dimuat SEBELUM api.js');

console.log('vpmap: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
