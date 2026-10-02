// Uji reconcile "Segarkan Default" (settings.js) — menyembuhkan seed usang
// tanpa menyentuh entri kustom pengguna. Eval settings.js + assertion dlm
// satu eval (pola difftest-vendor.js) agar deklarasi terlihat.
const fs = require('fs');
const path = require('path');
const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'settings.js'), 'utf8');

const store = {};
const localStorage = { getItem(k){ return k in store ? store[k] : null; }, setItem(k,v){ store[k] = String(v); } };
const PAGE_INIT = {};
let lastToast = '';
function showToast(m){ lastToast = m; }
const document = { getElementById: function(){ return null; } };
function confirm(){ return true; }

let pass = 0, fail = 0;
function ok(c, m){ if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

const tests = `
;(function(){
  store['acs_vendor_security'] = JSON.stringify([
    { id: 'x1', productClasses: 'F663NV9', passwordPath: 'KeyPassphrase',
      beaconWpa: 'WPA/WPA2', beaconOpen: 'Basic', encOpen: 'None' },
    { id: 'x2', oui: 'AABBCC', productClasses: 'MyCustomONU', passwordPath: 'KeyPassphrase',
      beaconWpa: 'WPA/WPA2', beaconOpen: 'None', encOpen: 'None' },
  ]);
  _refreshDefaults(_vmSecLoad, _vmSecSave, _vmSecDefaults, function(){}, 'WiFi config');
  var after = JSON.parse(store['acs_vendor_security']);
  ok(after.some(function(e){ return e.oui === 'AABBCC' && e.productClasses === 'MyCustomONU' && e.beaconOpen === 'None'; }),
     'entri kustom pengguna dipertahankan');
  var f663 = after.filter(function(e){ return !e.oui && e.productClasses === 'F663NV9'; });
  ok(f663.length === 1, 'tepat satu entri default F663NV9 (tak ada duplikat)');
  ok(f663.length === 1 && f663[0].beaconOpen === 'None', 'seed usang Basic -> disegarkan ke None');
  ok(!after.some(function(e){ return e.productClasses === 'F663NV9' && e.beaconOpen === 'Basic'; }),
     'tak ada sisa Basic pada scope F663NV9');

  // ── Seed usang yang DIPENSIUNKAN harus DIBUANG (bukan dianggap entri kustom) ──
  // Entri generik GM220-S/MQ220 (X_CMCC) adalah ranjau: bikin ONU X_CT-COM CIOT/ZICG
  // jatuh ke jalur create yang salah. Sudah dihapus dari default → harus disapu.
  store['acs_vendor_wan'] = JSON.stringify([
    { id: 'g1', productClasses: 'GM220-S,GM220', wanRoot: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.' },
    { id: 'g2', productClasses: 'MQ220',         wanRoot: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.' },
    { id: 'k1', oui: 'AABBCC', productClasses: 'MyCustomONU', wanRoot: 'X.' },
  ]);
  _refreshDefaults(_vcfgLoad, _vcfgSave, _vcfgDefaults, function(){}, 'Vendor config');
  var wan = JSON.parse(store['acs_vendor_wan']);
  ok(!wan.some(function(e){ return !e.manufacturer && !e.oui && /gm220|mq220/i.test(e.productClasses || ''); }),
     'seed usang generik GM220/MQ220 DIBUANG saat Segarkan Default');
  ok(wan.some(function(e){ return e.oui === 'AABBCC' && e.productClasses === 'MyCustomONU'; }),
     'entri kustom pengguna TETAP dipertahankan (bukan ikut tersapu)');
  var ciot = wan.filter(function(e){ return e.manufacturer === 'CIOT'; });
  ok(ciot.length === 1 && ciot[0].vlanNode === 'X_CT-COM_WANGponLinkConfig' && ciot[0].features.createNewWcd === true,
     'entri CIOT (X_CT-COM/GPON, createNewWcd) tersimpan di Vendor config');
  var zicg = wan.filter(function(e){ return e.manufacturer === 'ZICG'; });
  ok(zicg.length === 1 && zicg[0].vlanNode === 'X_CT-COM_WANEponLinkConfig', 'entri ZICG tetap utuh (EPON)');
})();
`;

eval(settingsSrc + tests);

if (fail === 0) console.log('lulus: ' + pass + ' assertion\n✓ Reconcile menyembuhkan seed usang & mempertahankan entri kustom.');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }
