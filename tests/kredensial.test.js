#!/usr/bin/env node
/* Uji kredensial web ONU — username terkunci = hanya password (F9V, 2026-10-02).
 *
 * LATAR: operator membuka web ONU F9V — login hanya memilih "Klik User" / "Klik
 * Administrator" lalu password; username tidak bisa diganti. Panel dulu menawarkan
 * "Username Baru" dan menulis AdminName/UserName. Nama asli juga berbeda antar-unit
 * (AdminName 'fujitomo' vs 'superadmin'), jadi teks tetap di profil bisa menyesatkan.
 *
 * YANG DIJAGA:
 *   1. Profil F9V ETCH/FOTC: kedua username dikunci, password tetap bisa diubah.
 *   2. Seed localStorage lama (tanpa kunci) TIDAK membuka kunci kembali.
 *   3. Form terkunci tanpa input username; Simpan mengirim HANYA password.
 *   4. Nama asli dibaca dari cache (GET), tanpa task ke ONU.
 *   5. Model lain tak berubah (Huawei/F6600P tetap bisa ganti username).
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
const el = {};
const elemen = id => el[id] || (el[id] = { id, value: '', textContent: '', innerHTML: '', style: {},
  disabled: false, addEventListener(t, f) { this.klik = f; } });
const ctx = {
  console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout,
  localStorage: { getItem: k => (k === 'acs_vendor_security' ? simpanan : null), setItem() {} },
  document: { getElementById: id => elemen(id), querySelectorAll: () => [], addEventListener() {} },
};
vm.createContext(ctx);
vm.runInContext(baca('settings.js'), ctx);

// ══ 1. Profil F9V ══
['ETCH', 'FOTC'].forEach(m => {
  const f = ctx.getVendorSecurityConfig('F9V', '78C1A7', m);
  ok(f && f.adminSuperUserLocked === true && f.adminUserUserLocked === true, m + ': kedua username dikunci');
  ok(f && f.adminSuperPassPath === 'InternetGatewayDevice.X_CU_Function.Web.AdminPassword'
     && f.adminUserPassPath === 'InternetGatewayDevice.X_CU_Function.Web.UserPassword', m + ': password tetap bisa diubah');
  ok(f && !f.adminSuperCurrentUser && !f.adminUserCurrentUser, m + ': tanpa nama tetap (nama asli dari cache)');
});

// ══ 2. Seed localStorage lama tak membuka kunci ══
simpanan = JSON.stringify([{ id: 'lama', manufacturer: 'FOTC', productClasses: 'F9V', template: 'TR098',
  passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i',
  adminSuperPassPath: 'InternetGatewayDevice.X_CU_Function.Web.AdminPassword',
  adminSuperUserPath: 'InternetGatewayDevice.X_CU_Function.Web.AdminName', adminSuperCurrentUser: 'fujitomo',
  adminUserPassPath: 'InternetGatewayDevice.X_CU_Function.Web.UserPassword',
  adminUserUserPath: 'InternetGatewayDevice.X_CU_Function.Web.UserName', adminUserCurrentUser: 'admin' }]);
const lama = ctx.getVendorSecurityConfig('F9V', '78C1A7', 'FOTC');
ok(lama.id === 'lama' && lama.adminSuperUserLocked === true && lama.adminUserUserLocked === true,
   'seed lama tetap dipakai, tetapi kunci username dari kode menang');
ok(lama.adminSuperCurrentUser === undefined, 'nama tetap usang dari seed lama dibuang');
ok(JSON.parse(simpanan)[0].adminSuperUserLocked === undefined, 'objek simpanan tidak dimutasi');
simpanan = '[]';

// ══ 5. Model lain tak berubah ══
const hw = ctx.getVendorSecurityConfig('HG8245W5-6T', '', 'Huawei Technologies Co., Ltd');
ok(hw && !hw.adminSuperUserLocked && hw.adminSuperUserPath, 'Huawei HG8245W5-6T: username tetap bisa diganti');
const f66 = ctx.getVendorSecurityConfig('F6600P', 'BCBD84', 'ZTE');
ok(f66 && !f66.adminUserUserLocked && f66.adminUserUserPath === 'InternetGatewayDevice.User.2.Username',
   'F6600P: username tetap bisa diganti');
const ct = ctx.getVendorSecurityConfig('GM220-S', 'AC8B6A', 'ZICG');
ok(ct && ct.adminSuperUserLocked === true && ct.adminSuperCurrentUser === 'telecomadmin' && !ct.adminSuperUserPath,
   'X_CT-COM: telecomadmin tetap terkunci, tanpa path username');

// ══ 3 & 4. Form & Simpan (potongan device-detail.js asli) ══
const dd = baca('device-detail.js');
const iris = n => { const i = dd.indexOf('function ' + n + '('); let j = dd.indexOf('{', i), k = 0;
  for (; j < dd.length; j++) { if (dd[j] === '{') k++; else if (dd[j] === '}' && --k === 0) break; } return dd.slice(i, j + 1); };
const terkirim = [], dibaca = [];
ctx._esc = s => String(s);
ctx._settStatus = () => {};
ctx._setParamGuard = (d, params) => { terkirim.push(params); return Promise.resolve(); };
ctx._updateFaultSection = () => {};
ctx._settFaultIv = null;
ctx.ACS = { cachedValues: async (id, paths) => { dibaca.push(paths);
  return { 'InternetGatewayDevice.X_CU_Function.Web.AdminName': 'superadmin',
           'InternetGatewayDevice.X_CU_Function.Web.UserName': 'admin' }; } };
['_credSection', '_renderSettingTab', '_settNamaTerkunci', '_settSaveAdmin'].forEach(n => vm.runInContext(iris(n), ctx));

(async () => {
  const wadah = { innerHTML: '' };
  ctx._renderSettingTab({ id: '78C1A7-F9V-ELWRP93H6275578', model: 'F9V', mfr: 'FOTC' }, wadah);
  const h = wadah.innerHTML;
  ok(!/id="stg-super-user"/.test(h) && !/id="stg-user-user"/.test(h), 'F9V: tidak ada input Username Baru');
  ok((h.match(/fa-lock/g) || []).length === 2 && /dikunci, tidak dapat diubah/.test(h), 'F9V: dua baris username terkunci');
  ok(/id="stg-super-pass"/.test(h) && /id="stg-user-pass"/.test(h), 'F9V: input password tetap ada');

  await new Promise(r => setTimeout(r, 0));
  ok(dibaca.length === 1 && dibaca[0].length === 2, 'nama asli dibaca dalam SATU GET cache');
  ok(el['stg-super-curuser'].textContent === 'superadmin' && el['stg-user-curuser'].textContent === 'admin',
     'label terkunci menampilkan nama dari cache');

  elemen('stg-super-pass').value = elemen('stg-super-pass2').value = 'rahasia1';
  el['stg-super-btn'].klik();
  elemen('stg-user-pass').value = elemen('stg-user-pass2').value = 'rahasia2';
  el['stg-user-btn'].klik();
  ok(terkirim.length === 2, 'dua kali Simpan → dua pengiriman');
  ok(terkirim.every(p => p.length === 1), 'setiap Simpan mengirim SATU parameter');
  ok(terkirim[0][0][0] === 'InternetGatewayDevice.X_CU_Function.Web.AdminPassword'
     && terkirim[1][0][0] === 'InternetGatewayDevice.X_CU_Function.Web.UserPassword', 'yang dikirim hanya password');
  ok(!JSON.stringify(terkirim).match(/AdminName|UserName/), 'AdminName/UserName tidak pernah ditulis');

  // Model dengan username bisa diganti (Huawei) tetap mengirim username bila diisi
  terkirim.length = 0;
  Object.keys(el).forEach(k => delete el[k]);
  ctx._renderSettingTab({ id: 'X', model: 'HG8245W5-6T', mfr: 'Huawei Technologies Co., Ltd' }, wadah);
  ok(/id="stg-super-user"/.test(wadah.innerHTML), 'Huawei: input Username Baru tetap ada');
  elemen('stg-super-user').value = 'Support2';
  elemen('stg-super-pass').value = elemen('stg-super-pass2').value = 'rahasia3';
  el['stg-super-btn'].klik();
  ok(terkirim.length === 1 && terkirim[0].length === 2
     && terkirim[0][0][0] === 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.UserName',
     'Huawei: username + password terkirim');

  const fnSimpan = iris('_settSaveAdmin');
  ok(!/lockedUser/.test(fnSimpan), 'tak ada lagi jalur "kirim username terkunci"');
  ok(!/setParam|addObject|deleteObject|refreshObject/.test(iris('_settNamaTerkunci')), 'pembacaan nama tidak menulis apa pun');

  console.log(`kredensial: ${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
