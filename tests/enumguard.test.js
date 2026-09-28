// Uji jaring pengaman validasi enum pra-push (device-detail.js).
// Meng-eval _ENUM_ALLOW + _validateEnumParams langsung dari sumber agar
// yang diuji adalah kode produksi, bukan salinan.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'device-detail.js'), 'utf8');

function extract(name, kind) {
  // ambil blok 'var _ENUM_ALLOW = {...};' atau 'function _validateEnumParams(...){...}'
  var re = kind === 'var'
    ? new RegExp('var ' + name + ' = \\{[\\s\\S]*?\\n\\};')
    : new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}');
  var m = src.match(re);
  if (!m) throw new Error('tak ketemu: ' + name);
  return m[0];
}

const code = extract('_ENUM_ALLOW', 'var') + '\n' + extract('_validateEnumParams', 'fn') + '\nmodule.exports={_validateEnumParams:_validateEnumParams,_ENUM_ALLOW:_ENUM_ALLOW};';
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const { _validateEnumParams } = mod.exports;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
const B = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.';

// 1) Semua nilai flow terverifikasi HARUS lolos (0 pelanggaran).
const good = [
  [B + 'BeaconType', 'WPA/WPA2', 'xsd:string'],
  [B + 'BeaconType', 'None', 'xsd:string'],
  [B + 'BeaconType', 'Basic', 'xsd:string'],          // TR-098 open non-CMCC — tak divalidasi
  [B + 'BasicAuthenticationMode', 'OpenSystem', 'xsd:string'],
  [B + 'WPAAuthenticationMode', 'PSKAuthentication', 'xsd:string'],
  [B + 'IEEE11iAuthenticationMode', 'PSKAuthentication', 'xsd:string'],
  [B + 'WPAEncryptionModes', 'TKIPandAESEncryption', 'xsd:string'],
  [B + 'IEEE11iEncryptionModes', 'TKIPandAESEncryption', 'xsd:string'],
  [B + 'BasicEncryptionModes', 'None', 'xsd:string'],
  [B + 'BasicEncryptionModes', 'WEPEncryption', 'xsd:string'],
  [B + 'SSID', 'Basic', 'xsd:string'],                // param non-enum bernilai 'Basic' — abaikan
  [B + 'Channel', 6, 'xsd:unsignedInt'],              // non-string — abaikan
];
ok(_validateEnumParams(good).length === 0, 'flow terverifikasi harus 0 pelanggaran (dapat: ' + JSON.stringify(_validateEnumParams(good)) + ')');

// 2) Bug 688AF0: BasicEncryptionModes='Basic' HARUS terblokir.
const bad688 = [[B + 'BeaconType', 'Basic', 'xsd:string'], [B + 'BasicEncryptionModes', 'Basic', 'xsd:string']];
var v = _validateEnumParams(bad688);
ok(v.length === 1 && v[0].name === 'BasicEncryptionModes' && v[0].value === 'Basic', '688AF0 BasicEncryptionModes=Basic harus terblokir');

// 3) Menulis 'None' ke mode WPA/IEEE11i (penyebab 9007) HARUS terblokir.
ok(_validateEnumParams([[B + 'WPAEncryptionModes', 'None', 'xsd:string']]).length === 1, 'WPAEncryptionModes=None harus terblokir');
ok(_validateEnumParams([[B + 'IEEE11iAuthenticationMode', 'None', 'xsd:string']]).length === 1, 'IEEE11iAuthenticationMode=None harus terblokir');

// 4) Typo enum sembarang HARUS terblokir.
ok(_validateEnumParams([[B + 'BasicAuthenticationMode', 'OpenSytem', 'xsd:string']]).length === 1, 'typo OpenSytem harus terblokir');

if (fail === 0) console.log('lulus: ' + pass + ' assertion\n✓ Jaring pengaman enum pra-push AMAN (nilai sah lolos, nilai invalid terblokir).');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }
