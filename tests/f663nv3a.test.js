#!/usr/bin/env node
/* Uji F663NV3A — DUA varian, dua profil (2026-10-02).
 *
 * Product class 'F663NV3A' dipakai dua pabrikan dengan data model berbeda:
 *   ZTE  (82 unit) → X_CMCC, GPON  — kembaran F663NV9
 *   ZTEG (33 unit) → X_CT-COM, EPON — VLAN di node saudara, tanpa AutoChannelEnable
 * Panel memilih profil lewat Manufacturer yang dilaporkan ONU.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const baca = f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

let simpanan = '[]';
const ctx = {
  console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout, btoa: s => s,
  localStorage: { getItem: k => (k === 'acs_vendor_security' ? simpanan : null), setItem() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
  fetch: async () => ({ ok: true, status: 200, text: async () => '[]' }),
};
vm.createContext(ctx);
vm.runInContext(baca('settings.js'), ctx);
vm.runInContext(baca('api.js') + '\n;this.ACS = ACS;', ctx);

// ══ 1. Profil WAN ══
const wz = ctx.getWanProfile('F663NV3A', '6CD2BA', 'ZTE');
const wg = ctx.getWanProfile('F663NV3A', '28C01B', 'ZTEG');
ok(wz.matched && wz.template === 'X_CMCC' && wz.params.vlanId === 'X_CMCC_VLANIDMark', 'ZTE → X_CMCC');
ok(wg.matched && wg.template === 'X_CT-COM' && wg.params.service === 'X_CT-COM_ServiceList', 'ZTEG → X_CT-COM');
ok(ctx._vcfgDefaults().some(e => e.manufacturer === 'ZTE' && e.productClasses === 'F663NV3A')
   && ctx._vcfgDefaults().some(e => e.manufacturer === 'ZTEG' && e.productClasses === 'F663NV3A'), 'dua entri WAN eksplisit');
const w9 = ctx.getWanProfile('F663NV9', 'EC6CB5', 'ZTE');
ok(JSON.stringify(wz.params) === JSON.stringify(w9.params) && JSON.stringify(wz.features) === JSON.stringify(w9.features),
   'WAN ZTE F663NV3A = F663NV9 (tak ada yang bergeser)');
ok(JSON.stringify(ctx.getWanProfile('F663NV3a', '4413D0', 'ZTE').params) === JSON.stringify(w9.params), 'F663NV3a (huruf kecil) tak berubah');

// ══ 2. Profil WiFi/akun ══
const sz = ctx.getVendorSecurityConfig('F663NV3A', '6CD2BA', 'ZTE');
const sg = ctx.getVendorSecurityConfig('F663NV3A', '28C01B', 'ZTEG');
ok(sz.manufacturer === 'ZTE' && sz.adminSuperPassPath === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password'
   && sz.adminSuperUserPath === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username' && !sz.channelAutoZero,
   'ZTE: Super Admin X_CMCC_TeleComAccount; kanal cara biasa');
ok(ctx.getSecurityProfile('F663NV3A', '6CD2BA', 'ZTE').template === 'X_CMCC', 'ZTE: keluarga X_CMCC (User Admin tetap dimatikan)');
ok(sg.manufacturer === 'ZTEG' && sg.template === 'X_CT-COM' && sg.channelAutoZero === true
   && /X_CT-COM_TeleComAccount/.test(sg.adminSuperPassPath), 'ZTEG: X_CT-COM, kanal lewat Channel saja');
simpanan = JSON.stringify([{ id: 'lama', manufacturer: 'ZTEG', productClasses: 'F663NV3A', template: 'X_CT-COM', ssidFixedSlots: true }]);
ok(ctx.getVendorSecurityConfig('F663NV3A', '28C01B', 'ZTEG').channelAutoZero === true, 'seed lama ZTEG tetap mendapat channelAutoZero');
simpanan = '[]';

// ══ 3. Kanal ZTEG: tanpa AutoChannelEnable, PossibleChannels berbentuk rentang ══
const L = (v, w) => ({ _value: v, _writable: w !== false, _type: 'xsd:string' });
const wl = extra => ({ LANDevice: { '1': { WLANConfiguration: { '1': Object.assign({
  SSID: L('SI EMBAH'), Enable: L(true), BeaconType: L('WPA/WPA2'), Channel: L(0),
  PossibleChannels: L('1-13', false), ChannelsInUse: L('6', false), 'X_CT-COM_ChannelWidth': L(2) }, extra || {}) } } } });
const dg = ctx.ACS.mapDevice({ _id: '28C01B-F663NV3A-X', _deviceId: { _Manufacturer: 'ZTEG', _ProductClass: 'F663NV3A', _OUI: '28C01B' },
  InternetGatewayDevice: wl() });
const s = dg.ssids[0];
ok(s.channelWritable === true && s.channelNoAutoParam === true, 'ZTEG: kanal bisa diatur, ditandai tanpa AutoChannelEnable');
ok(JSON.stringify(s.possibleChannels) === JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12,13]), "PossibleChannels '1-13' diurai jadi 13 kanal");
// Model lain dengan Channel writable tapi tanpa AutoChannelEnable TIDAK ikut terbuka
const dx = ctx.ACS.mapDevice({ _id: '94FE9D-F650-X', _deviceId: { _Manufacturer: 'ZICG', _ProductClass: 'F650', _OUI: '94FE9D' },
  InternetGatewayDevice: wl() });
ok(dx.ssids[0].channelWritable === false && dx.ssids[0].channelNoAutoParam === false, 'ZICG F650 (belum diperiksa): tetap tertutup');
const dz = ctx.ACS.mapDevice({ _id: '6CD2BA-F663NV3A-X', _deviceId: { _Manufacturer: 'ZTE', _ProductClass: 'F663NV3A', _OUI: '6CD2BA' },
  InternetGatewayDevice: wl({ AutoChannelEnable: L(true), PossibleChannels: L('1,2,3', false) }) });
ok(dz.ssids[0].channelWritable === true && dz.ssids[0].channelNoAutoParam === false
   && dz.ssids[0].possibleChannels.join() === '1,2,3', 'ZTE: cara biasa; daftar berkoma tetap terbaca');

// ══ 4. Simpan kanal ZTEG: hanya Channel ══
const dd = baca('device-detail.js');
const iris = n => { const i = dd.indexOf('function ' + n + '('); let j = dd.indexOf('{', i), k = 0;
  for (; j < dd.length; j++) { if (dd[j] === '{') k++; else if (dd[j] === '}' && --k === 0) break; } return dd.slice(i, j + 1); };
function simpan(ssid, pilih) {
  const kirim = [];
  const c = { document: { getElementById: id => ({ rcCh_g: { value: pilih, dataset: {} }, btnRadioSave: {}, radioSaveStatus: { style: {} } })[id] || null },
    showToast() {}, App: {}, renderSsidTab() {}, pollForUpdate() {},
    _radioBands: () => [{ key: 'g', is5g: false, ssids: [ssid] }],
    _setParamGuard: (d, p) => { kirim.push(p); return new Promise(() => {}); } };
  vm.createContext(c); vm.runInContext(iris('_radioHandleSave'), c);
  c._radioHandleSave({ id: 'X' }, {});
  return (kirim[0] || []).map(p => p[0].split('.').pop() + '=' + p[1]);
}
ok(simpan(s, '6').join() === 'Channel=6', 'ZTEG Auto → kanal 6: hanya Channel=6');
ok(simpan(Object.assign({}, s, { channel: 6 }), 'auto').join() === 'Channel=0', 'ZTEG kanal 6 → Auto: hanya Channel=0');
ok(simpan(dz.ssids[0], '6').join() === 'AutoChannelEnable=false,Channel=6', 'ZTE: AutoChannelEnable + Channel seperti semula');

console.log(`f663nv3a: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
