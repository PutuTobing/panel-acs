#!/usr/bin/env node
/* Uji: Simpan WAN hanya mengirim parameter yang BERUBAH (PRD §6.1).
 *
 * LATAR (antrean GenieACS, 2026-09-29):
 *   • ZL-2113X: 11 parameter dalam satu SetParameterValues → session_terminated.
 *     Model ini pernah membeku 12 unit sesudah satu penulisan.
 *   • F663NV3A: ServiceList "OTHER,TR069" terkirim ulang ke WAN TR069 walau
 *     tak diubah → cwmp.9002, diulang 9 kali di setiap sesi.
 *
 * YANG DIJAGA:
 *   1. Nilai sama dengan cache → tidak dikirim; tak ada perubahan → tak ada task.
 *   2. Perbandingan sadar tipe (boolean "1"/true, angka "100"/100).
 *   3. Satu anggota grup berubah → seluruh grup ikut (firmware memvalidasi
 *      kecocokan antar-parameter).
 *   4. Password selalu dikirim bila diisi; path yang tak ada di cache = berubah.
 *   5. Urutan asli dipertahankan (ZTE memproses berurutan).
 *   6. Pembacaan cache READ-ONLY; WAN TR069 wajib dikonfirmasi.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const dd   = fs.readFileSync(path.join(ROOT, 'js', 'device-detail.js'), 'utf8');
const api  = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ddC  = strip(dd);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// Ambil badan fungsi apa adanya dari berkasnya — yang diuji kode sungguhan.
function iris(src, nama) {
  const i = src.indexOf('function ' + nama + '(');
  if (i < 0) return '';
  let j = src.indexOf('{', i), dalam = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') dalam++;
    else if (src[j] === '}' && --dalam === 0) break;
  }
  return src.slice(i, j + 1);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(['_bool01', '_nilaiSama', '_saringParamBerubah'].map(n => iris(ddC, n)).join('\n'), ctx);
const saring = ctx._saringParamBerubah;
ok(typeof saring === 'function', '_saringParamBerubah ada dan bisa dijalankan');

const B = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.';

// ══ 1. Kasus nyata ZL-2113X: hanya VLAN diubah → hanya grup VLAN yang terkirim ══
const form = [
  [B + 'X_CT-COM_ServiceList', 'INTERNET', 'xsd:string'],
  [B + 'X_CT-COM_VLANIDMark', 200, 'xsd:unsignedInt'],
  [B + 'X_CT-COM_VLANMode', 2, 'xsd:unsignedInt'],
  [B + 'NATEnabled', true, 'xsd:boolean'],
  [B + 'X_CT-COM_IPMode', '3', 'xsd:string'],
  [B + 'X_CT-COM_LanInterface', 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4', 'xsd:string'],
  [B + 'X_CT-COM_LanInterface-DHCPEnable', false, 'xsd:boolean'],
  [B + 'X_CT-COM_IPv6PrefixOrigin', 'PrefixDelegation', 'xsd:string'],
  [B + 'X_CT-COM_IPv6IPAddressOrigin', 'None', 'xsd:string'],
  [B + 'X_CT-COM_IPv6PrefixDelegationEnabled', true, 'xsd:boolean'],
  [B + 'Username', 'pelanggan@G2', 'xsd:string'],
];
const cache = {
  [B + 'X_CT-COM_ServiceList']: 'INTERNET',
  [B + 'X_CT-COM_VLANIDMark']: '100',          // ← satu-satunya yang berubah
  [B + 'X_CT-COM_VLANMode']: 2,
  [B + 'NATEnabled']: '1',                      // boolean dilaporkan "1"
  [B + 'X_CT-COM_IPMode']: '3',
  [B + 'X_CT-COM_LanInterface']: 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4',
  [B + 'X_CT-COM_LanInterface-DHCPEnable']: false,
  [B + 'X_CT-COM_IPv6PrefixOrigin']: 'PrefixDelegation',
  [B + 'X_CT-COM_IPv6IPAddressOrigin']: 'None',
  [B + 'X_CT-COM_IPv6PrefixDelegationEnabled']: 'true',
  [B + 'Username']: 'pelanggan@G2',
};
const grupVlan = [B + 'X_CT-COM_VLANIDMark', B + 'X_CT-COM_VLANMode', B + 'undefined'];
const grupIp = [B + 'X_CT-COM_IPMode', B + 'X_CT-COM_IPv6PrefixOrigin',
                B + 'X_CT-COM_IPv6IPAddressOrigin', B + 'X_CT-COM_IPv6PrefixDelegationEnabled'];
let s = saring(form, cache, [grupVlan, grupIp], []);
ok(s.kirim.length === 2, 'ZL-2113X: 11 parameter → 2 terkirim (dapat ' + s.kirim.length + ')');
ok(s.kirim[0][0].endsWith('VLANIDMark') && s.kirim[1][0].endsWith('VLANMode'),
   'yang terkirim = VLAN ID + pasangan grupnya (VLANMode), urutan asli');
ok(!s.kirim.some(p => p[0].endsWith('ServiceList')), 'ServiceList yang tak berubah tidak dikirim ulang');

// ══ 2. Tidak ada perubahan → tidak ada yang dikirim ══
s = saring(form, Object.assign({}, cache, { [B + 'X_CT-COM_VLANIDMark']: 200 }), [grupVlan, grupIp], []);
ok(s.kirim.length === 0, 'form tanpa perubahan → nol parameter (tak ada task ke ONU)');

// ══ 3. Perbandingan sadar tipe ══
const t = (baru, lama, tipe) => saring([['X.a', baru, tipe]], { 'X.a': lama }, [], []).kirim.length === 0;
ok(t(true, '1', 'xsd:boolean') && t(false, '0', 'xsd:boolean') && t(true, 'true', 'xsd:boolean'),
   'boolean: true == "1" == "true", false == "0"');
ok(!t(true, false, 'xsd:boolean'), 'boolean yang benar-benar beda terdeteksi');
ok(t(100, '100', 'xsd:unsignedInt') && t('3', 3, 'xsd:int'), 'angka: 100 == "100"');
ok(!t(0, '', 'xsd:unsignedInt'), 'angka: cache kosong "" tidak dianggap sama dengan 0');
ok(!t('a', 'A', 'xsd:string'), 'string dibandingkan persis');

// ══ 4. Grup IPv6: ubah IPMode → seluruh grup IP ikut ══
s = saring(form, Object.assign({}, cache, { [B + 'X_CT-COM_VLANIDMark']: 200, [B + 'X_CT-COM_IPMode']: '1' }),
           [grupVlan, grupIp], []);
ok(s.kirim.length === 4 && s.kirim.every(p => grupIp.includes(p[0])),
   'IPMode berubah → keempat parameter grup IP/IPv6 dikirim bersama');

// ══ 5. Password selalu; path tak ada di cache = berubah ══
const pw = [[B + 'Password', 'rahasia', 'xsd:string'], [B + 'Username', 'u', 'xsd:string']];
s = saring(pw, { [B + 'Password']: 'rahasia', [B + 'Username']: 'u' }, [], [B + 'Password']);
ok(s.kirim.length === 1 && s.kirim[0][0].endsWith('Password'),
   'password (write-only) selalu dikirim walau cache kebetulan sama');
s = saring([[B + 'X_Baru', 'v', 'xsd:string']], {}, [], []);
ok(s.kirim.length === 1, 'path yang tak ada di cache dianggap berubah (dikirim)');

// ══ 6. Terpasang di _wanHandleSave ══
const save = iris(ddC, '_wanHandleSave');
ok(/_wanHanyaBerubah\(/.test(save), '_wanHandleSave memakai _wanHanyaBerubah');
ok(/if \(!kirim\.length\) return null/.test(save), 'nol perubahan → _setParamGuard tidak dipanggil');
ok(/Tidak ada perubahan/.test(save), 'operator diberi tahu bila tidak ada yang dikirim');
ok(/selalu\s*=\s*P\.pppPass/.test(save), 'password PPPoE masuk daftar "selalu"');
ok(/_lanBindBoolParams/.test(save) && /pbParams\.map/.test(save),
   'binding LAN (string, boolean per-port, tabel Port Binding) satu grup');

// ══ 7. Cache READ-ONLY; WAN TR069 dikonfirmasi; gagal baca → perilaku lama ══
const cv = iris(strip(api), 'cachedValues');
ok(cv && /\/devices\?query=/.test(cv), 'ACS.cachedValues membaca /devices berprojection');
ok(!/tasks|connection_request|method:/.test(cv), 'ACS.cachedValues tidak mengirim perintah ke ONU');
const hb = iris(ddC, '_wanHanyaBerubah');
ok(/TR069/.test(hb) && /_konfirmasiWanTr069/.test(hb), 'WAN ber-TR069 wajib dikonfirmasi');
ok(/catch \(e\) \{\s*return semua;/.test(hb), 'gagal membaca cache → kirim semua, bukan membatalkan');
ok(/onCancel/.test(iris(ddC, '_konfirmasiWanTr069')), 'batal di dialog tidak membuat tombol macet');

console.log(`writediff: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
