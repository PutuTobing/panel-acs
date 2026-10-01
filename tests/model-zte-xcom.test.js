#!/usr/bin/env node
/* Uji profil ZTE keluarga X_ZTE-COM: F679L, F670L, dan F6600P (C2, 2026-10-02).
 *
 * LATAR: F6600P (WiFi 6) tidak punya profil → jatuh ke X_CMCC (ZTE F663). Audit
 * read-only SN ZTEGD3BE4ED4 membuktikan strukturnya identik F679L/F670L, dan tanpa
 * profil Simpan WAN mengirim ConnectionType='PPPoE_Routed' — nilai yang tak dikenal
 * firmware ini (PossibleConnectionTypes PPP = 'IP_Routed,PPPoE_Bridged').
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const ctx = {
  console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout() {},
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'settings.js'), 'utf8'), ctx);

// ══ 1. F6600P memakai profil yang sama dengan F679L/F670L ══
const w  = ctx.getWanProfile('F6600P', 'BCBD84', 'ZTE');
const wf = ctx.getWanProfile('F679L', 'BCBD84', 'ZTE');
ok(w.matched === true && w.template === 'X_ZTE-COM', 'F6600P punya profil WAN X_ZTE-COM (tidak lagi jatuh ke X_CMCC)');
ok(JSON.stringify(w.params) === JSON.stringify(wf.params), 'param WAN F6600P = F679L');
ok(w.params.vlanId === 'X_ZTE-COM_VLANID' && w.params.vlanEnable === 'X_ZTE-COM_VLANEnable'
   && w.params.service === 'X_ZTE-COM_ServiceList' && w.params.cos === 'X_ZTE-COM_8021P',
   'VLAN/service/CoS X_ZTE-COM pada koneksi');
ok(w.params.pppConnType === '', 'ConnectionType PPP TIDAK dipush saat edit (firmware tak kenal PPPoE_Routed)');
ok(w.createConnType && w.createConnType.ppp === 'IP_Routed', 'Buat WAN PPPoE memakai IP_Routed');
ok(!Object.values(w.params).some(v => /X_CMCC/.test(v || '')), 'tidak ada nama X_CMCC');
ok(w.features.portBindingTable === true && w.features.createNewWcd === false,
   'binding lewat tabel X_ZTE-COM_PortBinding; WAN baru di WCD.1');
ok(w.dualStack && w.dualStack.param === 'X_ZTE-COM_IPMode' && w.dualStack.type === 'xsd:string'
   && w.dualStack.valueOff === 'IPv4', 'dualstack: IPMode string Both/IPv4');

// ══ 2. WiFi & akun ══
const s = ctx.getVendorSecurityConfig('F6600P', 'BCBD84', 'ZTE');
ok(s && s.beaconWpa === 'WPAand11i' && s.beaconOpen === 'None' && s.openMinimal === true,
   'WiFi F6600P: WPAand11i, open None minimal (sama F679L)');
ok(s && s.adminSuperPassPath === 'InternetGatewayDevice.User.1.Password', 'Super Admin = User.1');
ok(s && s.adminUserSupported === false, 'User Admin tetap nonaktif (profil gabungan)');

// ══ 3. F679L & F670L tidak berubah ══
['F679L', 'F670L'].forEach(m => {
  const p = ctx.getWanProfile(m, 'X', 'ZTE');
  ok(p.matched && p.template === 'X_ZTE-COM', m + ' tetap X_ZTE-COM');
});
ok(ctx.getWanProfile('F663NV9', 'EC6CB5', 'ZTE').template === 'X_CMCC', 'F663NV9 tetap X_CMCC');

console.log(`model-zte-xcom: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
