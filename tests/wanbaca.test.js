#!/usr/bin/env node
/* Uji: nilai WAN yang BELUM PERNAH DIBACA tidak boleh tampil sebagai nilai bawaan
 * lalu ikut terkirim (C1, audit 12 ONT 2026-10-02).
 *
 * LATAR: di F463N, F609, F663NV3A, MQ220, GM220-S, Trikom F609, F650 GenieACS
 * mengenal nama X_*_IPMode / LanInterface / VLANMode / MTU tetapi nilainya tak
 * pernah dibaca. Form Edit menampilkan bawaan (binding kosong, IPv4, MTU 1480) dan
 * Simpan tanpa perubahan mengirim LanInterface="" (binding tercabut) & IPMode=1
 * (IPv6 mati).
 *
 * YANG DIJAGA:
 *   1. ACS.belumDibaca: hanya path yang DIKENAL tanpa nilai; yang bernilai dan yang
 *      tak dikenal sama sekali tidak ikut (membacanya = 9005).
 *   2. _wanPathForm menyebut path yang dipakai form untuk koneksi itu.
 *   3. _saringParamBerubah + boleh: nilai tak diketahui yang isiannya tak disentuh
 *      DITAHAN; yang disentuh dikirim; yang diketahui tetap dibandingkan seperti biasa.
 *   4. Alur: Edit membaca dulu sebelum form; Simpan memakai pengaman; bandwidth
 *      radio yang belum dibaca (NaN/null) tidak dikirim bila dropdown tak diubah.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const baca = f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
function iris(src, nama) {
  const i = src.indexOf('function ' + nama + '(');
  if (i < 0) return '';
  let j = src.indexOf('{', i), k = 0;
  for (; j < src.length; j++) { if (src[j] === '{') k++; else if (src[j] === '}' && --k === 0) break; }
  return src.slice(i, j + 1);
}

// ── Konteks: settings.js + api.js asli, fetch tiruan (GenieACS) ──
const B = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.';
const DIKENAL = { _writable: true };                       // dikenal, belum dibaca
const L = (v, t) => ({ _value: v, _writable: true, _type: t });
const DOC = { _id: 'X', InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('INTERNET', 'xsd:string'), Username: L('u', 'xsd:string'),
    X_CMCC_ServiceList: L('INTERNET', 'xsd:string'), X_CMCC_VLANIDMark: L(100, 'xsd:unsignedInt'),
    X_CMCC_VLANMode: DIKENAL, X_CMCC_IPMode: DIKENAL, X_CMCC_LanInterface: DIKENAL,
    'X_CMCC_LanInterface-DHCPEnable': DIKENAL, MaxMRUSize: DIKENAL, NATEnabled: L(true, 'xsd:boolean'),
  } },
} } } } } };
let terakhirUrl = '';
const ctx = {
  console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout, btoa: s => s,
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
  fetch: async (url) => { terakhirUrl = url; return { ok: true, status: 200, text: async () => JSON.stringify([DOC]) }; },
};
vm.createContext(ctx);
vm.runInContext(baca('settings.js'), ctx);
vm.runInContext(baca('api.js') + '\n;this.ACS = ACS;', ctx);
const dd = strip(baca('device-detail.js'));
vm.runInContext(['_bool01', '_nilaiSama', '_saringParamBerubah', '_wanLanParsed', '_lanBindBoolParams',
                 '_wanProfileFor', '_wanPathForm'].map(n => iris(dd, n)).join('\n'), ctx);

(async () => {
  // ══ 1. ACS.belumDibaca ══
  const belum = await ctx.ACS.belumDibaca('X', [B + 'X_CMCC_ServiceList', B + 'X_CMCC_IPMode',
    B + 'X_CMCC_LanInterface', B + 'TidakAdaSamaSekali', B + 'MaxMRUSize']);
  ok(belum.join(',') === [B + 'X_CMCC_IPMode', B + 'X_CMCC_LanInterface', B + 'MaxMRUSize'].join(','),
     'belumDibaca = dikenal tanpa nilai saja (dapat ' + belum.map(x => x.split('.').pop()) + ')');
  ok(/^\/api\/devices\?query=/.test(terakhirUrl) && /projection=/.test(terakhirUrl),
     'belumDibaca = satu GET berprojection (murni baca)');
  ok((await ctx.ACS.belumDibaca('X', [])).length === 0, 'tanpa path → tanpa permintaan');

  // ══ 2. _wanPathForm ══
  const d = { id: 'X', model: 'F663NV9', mfr: 'ZTE', wanConnections: [] };
  const conn = { basePath: B.slice(0, -1), type: 'ppp' };
  const jalur = ctx._wanPathForm(d, conn).map(x => x.replace(B, ''));
  ['X_CMCC_ServiceList', 'X_CMCC_VLANIDMark', 'X_CMCC_VLANMode', 'X_CMCC_IPMode', 'X_CMCC_LanInterface',
   'X_CMCC_LanInterface-DHCPEnable', 'MaxMRUSize', 'Username'].forEach(n =>
    ok(jalur.indexOf(n) >= 0, '_wanPathForm memuat ' + n));
  ok(jalur.indexOf('Password') < 0, '_wanPathForm tidak membaca password');

  // ══ 3. Pengaman nilai tak diketahui ══
  const params = [[B + 'X_CMCC_VLANIDMark', 100, 'xsd:unsignedInt'], [B + 'X_CMCC_VLANMode', 2, 'xsd:unsignedInt'],
                  [B + 'X_CMCC_IPMode', 1, 'xsd:unsignedInt'], [B + 'X_CMCC_LanInterface', '', 'xsd:string']];
  const cache = { [B + 'X_CMCC_VLANIDMark']: 100 };       // sisanya tak diketahui
  const grup = [[B + 'X_CMCC_VLANIDMark', B + 'X_CMCC_VLANMode']];
  let r = ctx._saringParamBerubah(params, cache, grup, [], () => false);
  ok(r.kirim.length === 0, 'tak ada isian disentuh → nilai tak diketahui DITAHAN (0 param)');
  r = ctx._saringParamBerubah(params, cache, grup, [], p => /LanInterface/.test(p));
  ok(r.kirim.length === 1 && /LanInterface/.test(r.kirim[0][0]), 'binding disentuh → hanya binding dikirim');
  r = ctx._saringParamBerubah([[B + 'X_CMCC_VLANIDMark', 200, 'xsd:unsignedInt'], [B + 'X_CMCC_VLANMode', 2, 'xsd:unsignedInt']],
                              cache, grup, [], () => false);
  ok(r.kirim.length === 1 && /VLANIDMark/.test(r.kirim[0][0]),
     'VLAN (diketahui) diubah → dikirim; pasangan grup yang tak diketahui tidak ikut terseret');
  r = ctx._saringParamBerubah(params, cache, grup, []);
  ok(r.kirim.length === 4, 'tanpa argumen boleh → perilaku lama (tak diketahui = berubah, grup ikut)');

  // ══ 4. Alur di panel ══
  const masuk = iris(dd, '_wanShowEdit');
  ok(/ACS\.belumDibaca\(d\.id, _wanPathForm\(d, conn\)\)/.test(masuk), 'Edit memeriksa nilai belum dibaca dulu');
  ok(/name: 'getParameterValues', parameterNames: belum/.test(masuk), 'yang belum dibaca dibaca lewat getParameterValues');
  ok(/ACS\.postTask\(/.test(masuk) && !/setParam|addObject|deleteObject|refreshObject/.test(masuk),
     'lewat postTask (pagar & kunci server), tanpa tulis dan tanpa refresh pohon');
  ok(/if \(!belum\.length\) return _wanShowEditForm/.test(masuk), 'semua sudah terbaca → form langsung terbuka');
  ok(/tidak akan dikirim/.test(masuk), 'pembacaan gagal → operator diberi tahu');
  ok(/dataset\.wanAwal = JSON\.stringify\(_wanFormSnapshot\(container\)\)/.test(dd), 'keadaan awal form dicatat');
  const simpan = iris(dd, '_wanHandleSave');
  ok(/_wanHanyaBerubah\([\s\S]*?boleh\)/.test(simpan), 'Simpan WAN memakai pengaman nilai tak diketahui');
  ok(/'@bind'/.test(simpan) && /'wanIpMode'/.test(simpan), 'binding & mode IP dipetakan ke isiannya');
  const radio = iris(dd, '_radioHandleSave');
  ok(/_bwTakTahu/.test(radio) && /isNaN\(s\.channelWidthVal\)/.test(radio),
     'bandwidth radio tak diketahui (null/NaN) tidak dikirim bila dropdown tak diubah');
  ok(/el\.dataset\.awal = el\.value/.test(iris(dd, '_radioShowConfig')), 'nilai awal dropdown radio dicatat');

  // ══ 5. api.js: lebar kanal belum dibaca = null (bukan NaN) ══
  const w = ctx.ACS.mapDevice({ _id: 'Y', _deviceId: {}, InternetGatewayDevice: { LANDevice: { '1': {
    WLANConfiguration: { '1': { SSID: L('A', 'xsd:string'), X_CMCC_ChannelWidth: DIKENAL } } } } } }).ssids[0];
  ok(w.channelWidthVal === null, 'X_CMCC_ChannelWidth belum dibaca → channelWidthVal null (dapat ' + w.channelWidthVal + ')');

  console.log(`wanbaca: ${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
