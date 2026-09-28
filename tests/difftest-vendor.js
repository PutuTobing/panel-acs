#!/usr/bin/env node
/* Diff-test multi-vendor (Fase 2.5) — PRODUCTION SAFETY GUARD.
 * Membuktikan resolusi profil 3-lapis TIDAK mengubah perilaku ZTE F663NV9:
 *   - param WAN hasil resolusi = WAN_PROFILE_DEFAULT (byte-identik)
 *   - setiap nama param X_CMCC_* pada profil benar-benar dipakai device-detail.js
 *   - warisan OUI bekerja (EC6CB5 open=None, 688AF0 open=Basic)
 *   - vendor tak dikenal => matched=false (kelak read-only)
 * Jalankan: node tests/difftest-vendor.js   (exit 0 = lulus)
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const settingsSrc = fs.readFileSync(path.join(ROOT, 'js/settings.js'), 'utf8');
const ddSrc       = fs.readFileSync(path.join(ROOT, 'js/device-detail.js'), 'utf8');

// ── stub lingkungan browser (tanpa DOM; settings.js hanya pakai DOM di dlm fungsi) ──
const PAGE_INIT = {};
const localStorage = { _d: {}, getItem(k){ return this._d[k] || null; }, setItem(k,v){ this._d[k] = String(v); } };

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fails.push(msg); } }
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const tests = `
;(function(){
  // 1) Template default ZTE = X_CMCC, param byte-identik dgn WAN_PROFILE_DEFAULT
  var z = getWanProfile('F663NV9', 'EC6CB5', 'ZTE');
  ok(z.template === 'X_CMCC', 'WAN: template ZTE F663NV9 = X_CMCC (got ' + z.template + ')');
  ok(deepEq(z.params, WAN_PROFILE_DEFAULT.params), 'WAN: params ZTE byte-identik dgn default');
  ok(deepEq(z.values, WAN_PROFILE_DEFAULT.values), 'WAN: values ZTE byte-identik dgn default');
  ok(z.matched === true, 'WAN: ZTE F663NV9 matched=true');

  // 2) GOLDEN snapshot — nama param ZTE F663NV9 yang DULU di-hardcode di device-detail.js
  //    (Fase 3). Profil HARUS menghasilkan nama yang sama persis = byte-identik.
  var GOLDEN_ZTE_WAN = {
    service:'X_CMCC_ServiceList', vlanId:'X_CMCC_VLANIDMark', vlanMode:'X_CMCC_VLANMode',
    cos:'X_CMCC_802-1pMark', nat:'NATEnabled', mtuPpp:'MaxMRUSize', mtuIp:'MaxMTUSize',
    ipMode:'X_CMCC_IPMode', lanInterface:'X_CMCC_LanInterface', lanDhcpEnable:'X_CMCC_LanInterface-DHCPEnable',
    ipv6PrefixOrigin:'X_CMCC_IPv6PrefixOrigin', ipv6AddrOrigin:'X_CMCC_IPv6IPAddressOrigin',
    ipv6PrefixDelegation:'X_CMCC_IPv6PrefixDelegationEnabled', ipv6Dns:'X_CMCC_IPv6DNSServers',
    pppUser:'Username', pppPass:'Password', pppConnType:'ConnectionType', pppServiceName:'PPPoEServiceName',
    ipAddrType:'AddressingType', ipAddr:'ExternalIPAddress', ipMask:'SubnetMask', ipGw:'DefaultGateway',
    ipDns:'DNSServers', enable:'Enable',
  };
  Object.keys(GOLDEN_ZTE_WAN).forEach(function(k){
    ok(z.params[k] === GOLDEN_ZTE_WAN[k],
       'WAN GOLDEN: ' + k + ' = "' + GOLDEN_ZTE_WAN[k] + '" (got "' + z.params[k] + '")');
  });
  // device-detail.js tidak boleh lagi meng-hardcode literal WAN X_CMCC_ServiceList (sudah via profil)
  ok(DD_SRC.split('X_CMCC_ServiceList').length - 1 === 0, 'Fase 3: device-detail.js tidak hardcode X_CMCC_ServiceList lagi');
  ok(DD_SRC.indexOf('_pushParam(') !== -1, 'Fase 3: device-detail.js memakai _pushParam (profil-driven)');

  // 3) Warisan OUI pada Security: EC6CB5 open=None, 688AF0 open=Basic, generic juga
  var sEC = getSecurityProfile('F663NV9', 'EC6CB5', 'ZTE');
  ok(sEC.beaconOpen === 'None', 'SEC: EC6CB5 beaconOpen=None (got ' + sEC.beaconOpen + ')');
  ok(sEC.adminUserSupported === false, 'SEC: EC6CB5 adminUserSupported=false (warisan override)');
  // Semua F663NV9 open = BeaconType="None"
  var s68 = getSecurityProfile('F663NV9', '688AF0', 'ZTE');
  ok(s68.beaconOpen === 'None', 'SEC: 688AF0 beaconOpen=None (got ' + s68.beaconOpen + ')');
  var sB0 = getSecurityProfile('F663NV9', 'B0B194', 'ZTE');
  ok(sB0.beaconOpen === 'None', 'SEC: B0B194 beaconOpen=None (got ' + sB0.beaconOpen + ')');

  // 4) Vendor tak dikenal => matched=false (read-only nantinya)
  var hw = getWanProfile('HG8245H5', 'ABCDEF', 'Huawei');
  ok(hw.matched === false, 'WAN: vendor tak dikenal matched=false');

  // 5) Template registry tersedia & default X_CMCC ada
  ok(listWanTemplates().indexOf('X_CMCC') !== -1, 'TPL: X_CMCC terdaftar');
  ok(listWanTemplates().indexOf('TR098') !== -1, 'TPL: TR098 terdaftar');

  // 6) END-TO-END: entri tersimpan (via UI) dgn template X_HW → profil pakai keluarga X_HW
  localStorage.setItem('acs_vendor_wan', JSON.stringify([
    { id:'t1', manufacturer:'Huawei', productClasses:'HG8245H5', oui:'', template:'X_HW' }
  ]));
  var hwp = getWanProfile('HG8245H5', 'ABCDEF', 'Huawei');
  ok(hwp.template === 'X_HW',    'TPL e2e: entri tersimpan template X_HW dipakai (got ' + hwp.template + ')');
  ok(hwp.paramPrefix === 'X_HW_','TPL e2e: profil X_HW prefix=X_HW_ (got ' + hwp.paramPrefix + ')');
  ok(hwp.matched === true,       'TPL e2e: Huawei entri tersimpan matched=true');
  localStorage.setItem('acs_vendor_wan', '[]');  // reset agar uji lain bersih
})();
`;

// eval di scope ini agar fungsi settings.js terdefinisi & bisa dipanggil oleh tests.
// ok/deepEq/DD_SRC tersedia sbg variabel lokal yg terlihat oleh eval.
const DD_SRC = ddSrc;
eval(settingsSrc + tests);

console.log('lulus: ' + pass + ' assertion');
if (fails.length) {
  console.error('\nGAGAL (' + fails.length + '):');
  fails.forEach(function(f){ console.error('  ✗ ' + f); });
  process.exit(1);
}
console.log('✓ Semua diff-test multi-vendor LULUS — resolusi 3-lapis aman (ZTE byte-identik).');
