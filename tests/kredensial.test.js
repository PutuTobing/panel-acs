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
const baca = f => fs.readFileSync(path.join(ROOT, 'frontend', 'js', f), 'utf8');
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

// ══ 2b. Seed lama yang mematikan User Admin tidak menahan akun yang dibuka di kode ══
simpanan = JSON.stringify([{ id: 'lama3', manufacturer: 'ZTE', productClasses: 'F679L,F670L', template: 'TR098',
  adminSuperPassPath: 'InternetGatewayDevice.User.1.Password', adminSuperUserPath: 'InternetGatewayDevice.User.1.Username',
  adminUserSupported: false, adminUserNote: 'catatan lama' }]);
const f670 = ctx.getVendorSecurityConfig('F670L', 'C0515C', 'ZTE');
ok(f670.id === 'lama3' && f670.adminUserSupported !== false && f670.adminUserNote === undefined
   && f670.adminUserPassPath === 'InternetGatewayDevice.User.2.Password', 'seed lama F670L: User Admin tetap terbuka (User.2)');
// …tetapi model yang di kode memang TIDAK punya akun user tetap mati
simpanan = '[]';
ok(ctx.getVendorSecurityConfig('GM220-S', 'AC8B6A', 'ZICG').adminUserSupported === false, 'ZICG GM220-S: User Admin tetap dimatikan');

// ══ 2c. F663NV3A/a & F463N (ZTE): path username Super Admin, juga atas seed lama ══
['F663NV3a', 'F663NV3A', 'F463N'].forEach(m => {
  const c = ctx.getVendorSecurityConfig(m, '4413D0', 'ZTE');
  ok(c && c.adminSuperUserPath === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username'
     && !c.adminSuperUserLocked && !/^VirtualParameters/.test(c.adminSuperPassPath || 'InternetGatewayDevice.'),
     m + ': username Super Admin terbaca & bisa diganti');
});
ok(!ctx.getVendorSecurityConfig('F663NV3A', '64E0AB', 'ZTEG').adminSuperUserPath, 'ZTEG F663NV3A (X_CT-COM) tidak ikut berubah');
simpanan = JSON.stringify([{ id: 'lama4', productClasses: 'F663NV3A,F663NV3a,F463N,F650,F9V', passwordPath: 'KeyPassphrase',
  beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None' }]);
ok(ctx.getVendorSecurityConfig('F663NV3a', '4413D0', 'ZTE').adminSuperUserPath, 'seed gabungan lama: path username tetap didapat');
simpanan = '[]';

// ══ 2d. C-DATA: akun X_CT-COM_TeleComAccount, dipisah per model (2026-10-03) ══
{
  const TCA = 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.';
  const x = ctx.getVendorSecurityConfig('FD512XW-R460', '505B1D', 'CDTC');
  ok(x.productClasses === 'FD512XW-R460' && x.adminSuperPassPath === TCA + 'Password' && x.adminSuperUserLocked === true
     && !x.adminSuperUserPath && x.adminUserSupported === false && x.wpaMinimal === true, 'FD512XW: password Super Admin saja, username terkunci');
  const g = ctx.getVendorSecurityConfig('FD514GD-R460', '505B1D', 'CDTC');
  ok(g.productClasses === 'FD514GD-R460' && g.adminSuperPassPath === TCA + 'Password' && g.adminSuperUserPath === TCA + 'Username'
     && !g.adminSuperUserLocked && g.wpaMinimal === true, 'FD514GD: username + password Super Admin');
  simpanan = JSON.stringify([{ id: 'lamaC', manufacturer: 'CDTC', productClasses: 'FD514GD-R460,FD512XW-R460', template: 'X_CT-COM',
    wpaMinimal: true, adminUserSupported: false }]);
  const sl = ctx.getVendorSecurityConfig('FD512XW-R460', '505B1D', 'CDTC');
  ok(sl.id === 'lamaC' && sl.adminSuperPassPath === TCA + 'Password' && sl.adminSuperUserLocked === true,
     'seed gabungan lama C-DATA: path akun dari kode tetap dipakai');
  simpanan = '[]';
}

// ══ 5. Model lain tak berubah ══
const hw = ctx.getVendorSecurityConfig('HG8245W5-6T', '', 'Huawei Technologies Co., Ltd');
ok(hw && !hw.adminSuperUserLocked && hw.adminSuperUserPath, 'Huawei HG8245W5-6T: username tetap bisa diganti');
const f66 = ctx.getVendorSecurityConfig('F6600P', 'BCBD84', 'ZTE');
ok(f66 && !f66.adminUserUserLocked && f66.adminUserUserPath === 'InternetGatewayDevice.User.2.Username',
   'F6600P: username tetap bisa diganti');
const ct = ctx.getVendorSecurityConfig('GM220-S', 'AC8B6A', 'ZICG');
ok(ct && ct.adminSuperUserLocked === true && ct.adminSuperCurrentUser === 'admin' && !ct.adminSuperUserPath,
   "ZICG GM220-S: username terkunci 'admin' (terbukti login operator 2026-10-02), tanpa path username");
const f650 = ctx.getVendorSecurityConfig('F650', '94FE9D', 'ZICG');
ok(f650 && f650.productClasses === 'F650' && f650.adminSuperUserLocked === true
   && /belum dipastikan/.test(f650.adminSuperCurrentUser), 'ZICG F650: entri sendiri, nama ditandai belum dipastikan');
['CIOT|GM220-S', 'CIOT|MQ220', 'ZTEG|F663NV3A', 'TRKG|Trikom F609'].forEach(x => {
  const [m, pc] = x.split('|'); const c = ctx.getVendorSecurityConfig(pc, '', m);
  ok(c && c.adminSuperUserLocked === true && /belum dipastikan/.test(c.adminSuperCurrentUser)
     && c.adminSuperPassPath === 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
     x + ': password tetap bisa diganti, nama tidak lagi diklaim pasti');
});
// Seed lama gabungan 'F650,GM220-S' (telecomadmin) di browser teknisi tidak boleh menang
simpanan = JSON.stringify([{ id: 'lama2', manufacturer: 'ZICG', productClasses: 'F650,GM220-S', template: 'X_CT-COM',
  adminSuperPassPath: 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
  adminSuperUserLocked: true, adminSuperCurrentUser: 'telecomadmin', adminUserSupported: false }]);
ok(ctx.getVendorSecurityConfig('GM220-S', 'AC8B6A', 'ZICG').adminSuperCurrentUser === 'admin',
   "seed lama 'telecomadmin' ditimpa nama yang benar dari kode");
simpanan = '[]';

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

  // Username ASLI ditampilkan juga pada model yang username-nya BISA diganti (F663NV9)
  Object.keys(el).forEach(k => delete el[k]); dibaca.length = 0; terkirim.length = 0;
  ctx.ACS.cachedValues = async (id, paths) => { dibaca.push(paths);
    return { 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username': 'superadmin' }; };
  ctx._renderSettingTab({ id: 'A0CFF5-F663NV9-X', model: 'F663NV9', mfr: 'ZTE' }, wadah);
  ok(/Username Saat Ini/.test(wadah.innerHTML) && /id="stg-super-user"/.test(wadah.innerHTML),
     'F663NV9: baris "Username Saat Ini" + input Username Baru');
  await new Promise(r => setTimeout(r, 0));
  ok(dibaca.length === 1 && dibaca[0].join() === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username',
     'F663NV9: nama dibaca dari cache (satu GET, hanya Super Admin)');
  ok(el['stg-super-curuser'].textContent === 'superadmin', 'F663NV9: nama asli unit ditampilkan');
  elemen('stg-super-pass').value = elemen('stg-super-pass2').value = 'rahasia4';
  el['stg-super-btn'].klik();
  ok(terkirim.length === 1 && terkirim[0].length === 1
     && terkirim[0][0][0] === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password',
     'F663NV9: password ditulis LANGSUNG ke X_CMCC_TeleComAccount (VP ditolak pagar server)');
  // Username + password pada F663NV3a (kasus operator, SN ZTEGCB980D05)
  Object.keys(el).forEach(k => delete el[k]); terkirim.length = 0;
  ctx._renderSettingTab({ id: '4413D0-F663NV3a-X', model: 'F663NV3a', mfr: 'ZTE' }, wadah);
  elemen('stg-super-user').value = 'SKY';
  elemen('stg-super-pass').value = elemen('stg-super-pass2').value = 'rahasia5';
  el['stg-super-btn'].klik();
  ok(terkirim.length === 1 && terkirim[0].map(p => p[0]).join() ===
     'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username,InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password',
     'F663NV3a: username + password ke X_CMCC_TeleComAccount');
  ok(!JSON.stringify(terkirim).match(/VirtualParameters/), 'tak ada VirtualParameters yang dikirim');
  ok(/dct-cred-disabled/.test(wadah.innerHTML), 'F663NV3a: User Admin tetap dimatikan');
  // Model tak dikenal (tanpa path asli) → form ditolak terus terang, bukan gagal saat Simpan
  ctx._renderSettingTab({ id: 'ABCDEF-XYZ123-X', model: 'XYZ123', mfr: 'Entah' }, wadah);
  ok(!/id="stg-super-pass"/.test(wadah.innerHTML) && /belum dipetakan/.test(wadah.innerHTML),
     'model tanpa path asli: tidak diberi form yang pasti ditolak pagar');

  // ZL-2113X (model rapuh): form Super Admin hanya aktif bila leaf password DIKENAL
  vm.runInContext(iris('_settCekAda'), ctx);
  const hw = ctx.getVendorSecurityConfig('ZL-2113X', 'HWTC', 'HWTC');
  ok(hw.adminSuperCekAda === true && hw.adminSuperUserLocked === true
     && hw.adminSuperPassPath === 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password'
     && hw.adminUserSupported === false, 'ZL-2113X: password Super Admin saja, dengan pengaman cek-ada');
  const cobaZl = async (jawab) => {
    Object.keys(el).forEach(k => delete el[k]); terkirim.length = 0;
    ctx.ACS.probeParam = async () => jawab;
    ctx._renderSettingTab({ id: 'HWTC-ZL%2D2113X-X', model: 'ZL-2113X', mfr: 'HWTC' }, wadah);
    const sebelum = el['stg-super-btn'].disabled;
    await new Promise(r => setTimeout(r, 0));
    return { sebelum, sesudah: el['stg-super-btn'].disabled };
  };
  let z = await cobaZl({ found: true, value: '', writable: true });
  ok(z.sebelum === true && z.sesudah === false, 'ZL-2113X: tombol mati dulu, dibuka sesudah leaf terbukti ada');
  z = await cobaZl({ found: true, isObject: true });
  ok(z.sesudah === true, 'ZL-2113X: node ada tapi isinya belum ditelusuri → tetap mati');
  z = await cobaZl({ found: false, reason: 'path' });
  ok(z.sesudah === true, 'ZL-2113X: firmware tanpa node akun → tetap mati (tak ada tulis coba-coba)');
  ok(!/setParam|postTask|refreshObject/.test(iris('_settCekAda')), 'pemeriksaan murni baca cache');

  // Tombol Remote: halaman awal per model (HWTC ZL-2113X → /cgi-bin/content.asp)
  vm.runInContext(iris('_remoteUrl'), ctx);
  ok(ctx._remoteUrl({ id: 'HWTC-ZL%2D2113X-HWTCDF640C28', model: 'ZL-2113X', mfr: 'HWTC' })
     === '/onu/HWTC-ZL%252D2113X-HWTCDF640C28/cgi-bin/content.asp', 'ZL-2113X: Remote → /cgi-bin/content.asp');
  ok(ctx._remoteUrl({ id: 'EC6CB5-F663NV9-X', model: 'F663NV9', mfr: 'ZTE' }) === '/onu/EC6CB5-F663NV9-X/', 'model lain: tetap akar');
  simpanan = JSON.stringify([{ id: 'j', manufacturer: 'HWTC', productClasses: 'ZL-2113X,ZL-4224X', template: 'X_CT-COM',
    remotePath: '//evil.example/x', adminSuperCekAda: true }]);
  ok(ctx._remoteUrl({ id: 'HWTC-ZL%2D2113X-X', model: 'ZL-2113X', mfr: 'HWTC' }) === '/onu/HWTC-ZL%252D2113X-X/',
     'remotePath yang tak sah (// atau ..) diabaikan → akar');
  simpanan = '[]';

  const fnSimpan = iris('_settSaveAdmin');
  ok(!/lockedUser/.test(fnSimpan), 'tak ada lagi jalur "kirim username terkunci"');
  ok(!/setParam|addObject|deleteObject|refreshObject/.test(iris('_settNamaTerkunci')), 'pembacaan nama tidak menulis apa pun');

  console.log(`kredensial: ${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
