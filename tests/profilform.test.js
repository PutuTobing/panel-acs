#!/usr/bin/env node
/* Uji form profil di menu Settings (Vendor Configuration & Security Setting) — 2026-10-03.
 *
 * LATAR: setelan hasil audit model (encModes, channelAutoZero, remotePath, kunci username,
 * createConnType, ipv6GuaAuto, …) dulu hanya bisa diubah di kode. Kini ada kolomnya di form.
 * Sekaligus menutup bahaya lama: Simpan di form Vendor Configuration MENGGANTI entri
 * seluruhnya, sehingga vlanNode/dualStack/createConnType profil C-DATA dkk terbuang diam-diam.
 *
 * YANG DIJAGA:
 *   1. Buka → Simpan TANPA mengubah apa pun tidak mengubah profil efektif.
 *   2. Field tanpa kolom di form tidak terbuang.
 *   3. Pilihan operator (disunting) dihormati — tidak ditimpa tambalan dari kode.
 *   4. Isian yang salah (JSON rusak, path Remote ke luar) ditolak sebelum disimpan.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const simpanan = {};
const el = {};
const toast = [];
const elemen = id => el[id] || (el[id] = { id, value: '', checked: false, innerHTML: '', textContent: '', style: {},
  classList: { add() {}, remove() {} }, addEventListener() {}, querySelectorAll: () => [], appendChild() {} });
const ctx = {
  console, PAGE_INIT: {}, App: {}, window: {}, setTimeout, confirm: () => true,
  showToast: (m, t) => toast.push(t + ':' + m),
  localStorage: { getItem: k => (k in simpanan ? simpanan[k] : null), setItem: (k, v) => { simpanan[k] = v; } },
  document: { getElementById: elemen, querySelectorAll: () => [], addEventListener() {},
    createElement: () => elemen('_baru' + Math.random()) },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'settings.js'), 'utf8'), ctx);
const html = fs.readFileSync(path.join(ROOT, 'frontend', 'pages', 'settings.html'), 'utf8');

const SEC = 'acs_vendor_security', WAN = 'acs_vendor_wan';
const efSec = (pc, oui, mf) => JSON.parse(JSON.stringify(ctx.getVendorSecurityConfig(pc, oui, mf)));
const bersih = o => { const c = Object.assign({}, o); ['id', 'disunting', 'features', 'ssidRoot', 'channelWidthParam',
  'channelWidthType', 'template', 'oui', 'manufacturer', 'productClasses'].forEach(k => delete c[k]);
  Object.keys(c).forEach(k => { if (c[k] === '' || c[k] === false || c[k] == null || (Array.isArray(c[k]) && !c[k].length)) delete c[k]; });
  if (c.adminUserSupported === true) delete c.adminUserSupported;
  return JSON.stringify(c, Object.keys(c).sort()); };

// ══ 0. Kolom-kolom baru ada di halaman ══
['vmAdminSuperUserPath', 'vmAdminSuperCurrentUser', 'vmAdminSuperUserLocked', 'vmAdminUserUserPath', 'vmAdminUserUserLocked',
 'vmAdminUserSupported', 'vmAdminUserNote', 'vmAdminSuperCekAda', 'vmChannelAutoZero', 'vmBw5Extra', 'vmRemotePath', 'vmEncModes',
 'vcfgCreateCtIp', 'vcfgCreateCtPpp', 'vcfgIpv6GuaAuto'].forEach(id => ok(html.indexOf('id="' + id + '"') >= 0, 'kolom ' + id + ' ada di settings.html'));

// ══ 1. Security: buka → simpan tanpa perubahan, pada SEED LAMA (tanpa field baru) ══
const KASUS = [
  ['F9V', '78C1A7', 'FOTC'], ['F670L', 'C0515C', 'ZTE'], ['F6600P', 'BCBD84', 'ZTE'], ['ZL-2113X', 'HWTC', 'HWTC'],
  ['GM220-S', '1C25E1', 'CIOT'], ['FD512XW-R460', '505B1D', 'CDTC'], ['F663NV3A', '28C01B', 'ZTEG'],
  ['HG8245W5-6T', '00259E', 'Huawei Technologies Co., Ltd'],
];
KASUS.forEach(([pc, oui, mf]) => {
  // Seed lama = default kode tanpa field-field hasil audit (seperti di browser teknisi lama).
  const def = ctx._vendorMatch(ctx._vmSecDefaults(), pc, oui, mf);
  const lama = { id: 'lama-' + pc, manufacturer: def.manufacturer, productClasses: def.productClasses, template: def.template,
    passwordPath: def.passwordPath, beaconWpa: def.beaconWpa, beaconOpen: def.beaconOpen, encOpen: def.encOpen,
    ssidFixedSlots: def.ssidFixedSlots, openMinimal: def.openMinimal, wpaMinimal: def.wpaMinimal, band5MinIdx: def.band5MinIdx };
  simpanan[SEC] = JSON.stringify([lama]);
  const sebelum = bersih(efSec(pc, oui, mf));
  toast.length = 0;
  ctx.vmSecEdit('lama-' + pc);
  ctx.vmSecSave();
  const tersimpan = JSON.parse(simpanan[SEC])[0];
  const sesudah = bersih(efSec(pc, oui, mf));
  ok(tersimpan.disunting === true && !toast.some(t => /^error/.test(t)), pc + ': tersimpan & ditandai disunting');
  ok(sebelum === sesudah, pc + ': buka→simpan tanpa perubahan TIDAK mengubah profil efektif');
  ok(tersimpan.ssidFixedSlots === lama.ssidFixedSlots && tersimpan.wpaMinimal === lama.wpaMinimal && tersimpan.band5MinIdx === lama.band5MinIdx,
     pc + ': field tanpa kolom (ssidFixedSlots/wpaMinimal/band5MinIdx) tidak terbuang');
});

// ══ 2. Pilihan operator dihormati ══
simpanan[SEC] = '[]';
ctx.vmSecSeedDefaults();
let daftar = JSON.parse(simpanan[SEC]);
const f9v = daftar.find(e => e.manufacturer === 'FOTC');
ctx.vmSecEdit(f9v.id);
ok(el.vmAdminSuperUserLocked.checked === true && /X_CU_Function\.Web\.AdminName$/.test(el.vmAdminSuperUserPath.value), 'F9V: form menampilkan kunci & path username');
el.vmAdminSuperUserLocked.checked = false;
ctx.vmSecSave();
ok(ctx.getVendorSecurityConfig('F9V', '78C1A7', 'FOTC').adminSuperUserLocked === false, 'operator membuka kunci → dihormati (tidak ditimpa kode)');

const zl = JSON.parse(simpanan[SEC]).find(e => /ZL-2113X/.test(e.productClasses));
ctx.vmSecEdit(zl.id);
ok(el.vmRemotePath.value === '/cgi-bin/content.asp' && el.vmAdminSuperCekAda.checked === true, 'ZL-2113X: halaman Remote & pengaman tampil di form');
el.vmRemotePath.value = '/cgi-bin/index2.asp';
ctx.vmSecSave();
ok(ctx.getVendorSecurityConfig('ZL-2113X', 'HWTC', 'HWTC').remotePath === '/cgi-bin/index2.asp', 'halaman Remote bisa diubah dari form');

const f670 = JSON.parse(simpanan[SEC]).find(e => e.productClasses === 'F679L,F670L');
ctx.vmSecEdit(f670.id);
ok(/"wpamix"/.test(el.vmEncModes.value) && /"WPAand11i"/.test(el.vmEncModes.value), 'F670L: pilihan enkripsi tampil sebagai JSON');

// ══ 4. Isian salah ditolak ══
const sblm = simpanan[SEC];
el.vmEncModes.value = '[{ rusak'; toast.length = 0; ctx.vmSecSave();
ok(simpanan[SEC] === sblm && toast.some(t => /^error:.*JSON/.test(t)), 'JSON enkripsi rusak → ditolak, tidak tersimpan');
el.vmEncModes.value = '[{"id":"wpa","label":"x","beacon":"11i"}]'; toast.length = 0; ctx.vmSecSave();
ok(simpanan[SEC] === sblm && toast.some(t => /^error/.test(t)), 'id "wpa"/"none" dilarang (bentrok dengan pilihan bawaan)');
el.vmEncModes.value = ''; el.vmRemotePath.value = '//evil.example/x'; toast.length = 0; ctx.vmSecSave();
ok(simpanan[SEC] === sblm && toast.some(t => /^error:.*Remote/.test(t)), 'halaman Remote ke luar panel → ditolak');
el.vmRemotePath.value = 'http://x/'; toast.length = 0; ctx.vmSecSave();
ok(simpanan[SEC] === sblm, 'halaman Remote ber-skema → ditolak');
el.vmRemotePath.value = '';

// ══ 3. Vendor Configuration: Simpan tidak lagi membuang field ══
// _vcfgReadParamsGrid membaca DOM grid; ditiru dengan params entri apa adanya.
let paramsKini = {};
ctx._vcfgFillParamsGrid = p => { paramsKini = JSON.parse(JSON.stringify(p)); };
ctx._vcfgReadParamsGrid = () => paramsKini;
simpanan[WAN] = '[]';
ctx.vcfgSeedDefaults();
const wSebelum = JSON.stringify(ctx.getWanProfile('FD512XW-R460', '505B1D', 'CDTC'));
const cd = JSON.parse(simpanan[WAN]).find(e => e.manufacturer === 'CDTC');
ctx.vcfgEdit(cd.id);
ok(el.vcfgCreateCtIp.value === 'IP_Routed' && el.vcfgIpv6GuaAuto.checked === true, 'C-DATA: ConnectionType WAN IP & GUA Auto tampil di form');
ctx.vcfgSave();
const cd2 = JSON.parse(simpanan[WAN]).find(e => e.id === cd.id);
ok(cd2.vlanNode === cd.vlanNode && JSON.stringify(cd2.dualStack) === JSON.stringify(cd.dualStack) && cd2.vlanNode,
   'C-DATA: vlanNode & dualStack TIDAK terbuang saat Simpan');
ok(JSON.stringify(cd2.createConnType) === '{"ip":"IP_Routed"}' && cd2.ipv6GuaAuto === true, 'createConnType & ipv6GuaAuto tersimpan');
const wSesudah = ctx.getWanProfile('FD512XW-R460', '505B1D', 'CDTC');
const urut = o => JSON.stringify(o, Object.keys(o).sort());   // urutan kunci boleh beda, isinya tidak
ok(wSesudah.vlanNode && wSesudah.dualStack && wSesudah.createConnType.ip === 'IP_Routed' && wSesudah.ipv6GuaAuto === true
   && urut(wSesudah.params) === urut(JSON.parse(wSebelum).params), 'C-DATA: profil WAN efektif utuh sesudah buka→simpan');
// Operator mengosongkan → dihormati
ctx.vcfgEdit(cd.id); el.vcfgCreateCtIp.value = ''; el.vcfgIpv6GuaAuto.checked = false; ctx.vcfgSave();
const wKosong = ctx.getWanProfile('FD512XW-R460', '505B1D', 'CDTC');
ok(!wKosong.createConnType && !wKosong.ipv6GuaAuto, 'operator mengosongkan ConnectionType/GUA → tidak ditambal ulang dari kode');
// Entri F679L: pppBridged di createConnType tidak hilang
const zx = JSON.parse(simpanan[WAN]).find(e => e.productClasses === 'F679L,F670L');
ctx.vcfgEdit(zx.id); ctx.vcfgSave();
const zx2 = JSON.parse(simpanan[WAN]).find(e => e.id === zx.id);
ok(zx2.createConnType && zx2.createConnType.pppBridged === 'PPPoE_Bridged' && zx2.createConnType.ip === 'IP_Routed', 'F679L: createConnType.pppBridged tetap ada');

console.log(`profilform: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
