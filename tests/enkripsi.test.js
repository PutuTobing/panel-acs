#!/usr/bin/env node
/* Uji pilihan Encryption Type SSID per model — F670L/F679L (2026-10-02).
 *
 * LATAR: panel hanya punya "None" dan "WPA/WPA2 Personal". Operator ingin memilih mode
 * seperti di web ONU (WPA2-PSK-AES / WPA/WPA2-PSK-TKIP/AES). Pemetaan dibaca dari armada:
 *   WPA2-PSK-AES          = BeaconType '11i'       + IEEE11i AES
 *   WPA/WPA2-PSK-TKIP/AES = BeaconType 'WPAand11i' + WPA & IEEE11i TKIPandAES
 * Model tanpa encModes di profil TIDAK boleh berubah sedikit pun.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const baca = f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

let simpanan = '[]', el = {}, kirim = [], toast = [];
const ctx = {
  console, PAGE_INIT: {}, App: {}, window: {}, setTimeout,
  showToast: (m, t) => toast.push(t + ':' + m),
  localStorage: { getItem: k => (k === 'acs_vendor_security' ? simpanan : null), setItem() {} },
  document: { getElementById: id => el[id] || null, querySelectorAll: () => [], addEventListener() {} },
  _setParamGuard: (d, p) => { kirim.push(p); return new Promise(() => {}); },
  pollForUpdate() {}, renderSsidTab() {},
};
vm.createContext(ctx);
vm.runInContext(baca('settings.js'), ctx);
const dd = baca('device-detail.js');
const iris = n => { const i = dd.indexOf('function ' + n + '('); let j = dd.indexOf('{', i), k = 0;
  for (; j < dd.length; j++) { if (dd[j] === '{') k++; else if (dd[j] === '}' && --k === 0) break; } return dd.slice(i, j + 1); };
['_esc', '_isWpaAuth', '_ssidSecurity', '_ssidEncModes', '_ssidEncCocok', '_ssidShowConfig', '_ssidHandleSave']
  .forEach(n => vm.runInContext(iris(n), ctx));

const F670 = { id: '44A3C7-F670L-X', model: 'F670L', mfr: 'ZTE', ssids: [] };
const F663 = { id: 'EC6CB5-F663NV9-X', model: 'F663NV9', mfr: 'ZTE', ssids: [] };
const P = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.';
const form = (d, beacon) => { const w = { innerHTML: '' }; el = {};
  ctx._ssidShowConfig(d, { idx: 1, name: 'CELINE', beaconType: beacon, enabled: true, channel: 8 }, w); return w.innerHTML; };
const simpan = (d, beacon, pilih, pw) => { kirim = []; toast = [];
  el = { scSSID: { value: 'CELINE' }, scAuthType: { value: pilih }, scPass: { value: pw || '' }, btnSsidSave: {}, ssidSaveStatus: { style: {} } };
  ctx._ssidHandleSave(d, { idx: 1, name: 'CELINE', beaconType: beacon, hasXCmcc: d === F663 }, {});
  const o = {}; (kirim[0] || []).forEach(p => { o[p[0].replace(P, '')] = p[1]; }); return o; };

// ══ 1. Form F670L/F679L ══
let h = form(F670, '11i');
ok(/value="wpa2aes" selected>[^<]*WPA2-PSK-AES</.test(h), 'ONU 11i → terpilih WPA2-PSK-AES');
ok(/value="wpamix">[^<]*WPA\/WPA2-PSK-TKIP\/AES</.test(h) && /value="none"/.test(h), 'pilihan WPA/WPA2-PSK-TKIP/AES & None ada');
ok(!/EAP/.test(h) && !/WPA\/WPA2 Personal/.test(h), 'EAP tidak ditawarkan; pilihan umum lama diganti');
ok(/value="wpamix" selected/.test(form(F670, 'WPAand11i')), 'ONU WPAand11i → terpilih WPA/WPA2-PSK-TKIP/AES');
h = form(F670, 'WPA');
ok(/value="wpa" selected>[^<]*WPA \(nilai ONU saat ini\)/.test(h), 'mode ONU tak dikenal profil → ditampilkan apa adanya');
ok(/value="wpamix"/.test(form({ id: 'X', model: 'F679L', mfr: 'ZTE' }, '11i')), 'F679L mendapat pilihan yang sama');

// ══ 2. Simpan F670L ══
let o = simpan(F670, '11i', 'wpamix');
ok(JSON.stringify(o) === JSON.stringify({ BeaconType: 'WPAand11i', WPAAuthenticationMode: 'PSKAuthentication',
  IEEE11iAuthenticationMode: 'PSKAuthentication', WPAEncryptionModes: 'TKIPandAESEncryption',
  IEEE11iEncryptionModes: 'TKIPandAESEncryption' }), '11i → TKIP/AES: BeaconType + 4 mode, tanpa yang lain');
o = simpan(F670, 'WPAand11i', 'wpa2aes');
ok(JSON.stringify(o) === JSON.stringify({ BeaconType: '11i', IEEE11iAuthenticationMode: 'PSKAuthentication',
  IEEE11iEncryptionModes: 'AESEncryption' }), 'TKIP/AES → WPA2-PSK-AES: BeaconType 11i + IEEE11i AES');
simpan(F670, '11i', 'wpa2aes');
ok(kirim.length === 0 && toast.some(t => /Tidak ada perubahan/.test(t)), 'mode sama → tidak ada yang dikirim');
o = simpan(F670, '11i', 'wpa2aes', 'rahasia123');
ok(Object.keys(o).join() === 'KeyPassphrase', 'mode sama + password → hanya password');
simpan(F670, 'WPA', 'wpa');
ok(kirim.length === 0, 'mode ONU tak dikenal & tak diubah → tidak dikirim');
o = simpan(F670, 'None', 'wpamix', 'rahasia123');
ok(o.BeaconType === 'WPAand11i' && o.KeyPassphrase === 'rahasia123', 'Open → TKIP/AES + password');
o = simpan(F670, '11i', 'none');
ok(JSON.stringify(o) === '{"BeaconType":"None"}', 'ke Open tetap resep minimal lama');

// ══ 3. Model lain tak berubah ══
h = form(F663, 'WPA/WPA2');
ok(/value="wpa" selected>[^<]*WPA\/WPA2 Personal \(password\)</.test(h) && !/wpamix/.test(h), 'F663NV9: form lama');
o = simpan(F663, 'None', 'wpa', 'rahasia123');
ok(JSON.stringify(Object.keys(o)) === JSON.stringify(['BeaconType', 'WPAAuthenticationMode', 'IEEE11iAuthenticationMode',
  'WPAEncryptionModes', 'IEEE11iEncryptionModes', 'KeyPassphrase']) && o.BeaconType === 'WPA/WPA2', 'F663NV9: resep WPA lama, urutan sama');
const F66 = { id: 'BCBD84-F6600P-X', model: 'F6600P', mfr: 'ZTE', ssids: [] };
h = form(F66, 'WPAand11i');
ok(/value="wpamix" selected/.test(h) && /value="wpa2aes"/.test(h), 'F6600P: dua mode WPA2 ditawarkan');
ok(!/WPA3|SAE/.test(h), 'F6600P: WPA3 BELUM ditawarkan (nilainya belum diukur)');
h = form(F66, 'WPA3');
ok(/value="wpa" selected>[^<]*WPA3 \(nilai ONU saat ini\)/.test(h), 'F6600P: mode tak dikenal (mis. WPA3 dari web ONU) tampil apa adanya');
simpan(F66, 'WPA3', 'wpa', 'rahasia123');
ok(kirim.length === 1 && kirim[0].length === 1 && /KeyPassphrase$/.test(kirim[0][0][0]), 'F6600P: mode tak dikenal tidak ditimpa saat ganti password');
ok(!ctx.getVendorSecurityConfig('HG8245W5-6T', '', 'Huawei Technologies Co., Ltd').encModes, 'Huawei tidak diberi encModes');

// ══ 4. Seed localStorage lama tetap mendapat encModes ══
simpanan = JSON.stringify([{ id: 'lama', manufacturer: 'ZTE', productClasses: 'F679L,F670L', template: 'TR098',
  beaconWpa: 'WPAand11i', openMinimal: true }]);
ok(/value="wpamix"/.test(form(F670, '11i')), 'seed lama: pilihan enkripsi tetap muncul');
simpanan = '[]';

console.log(`enkripsi: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
