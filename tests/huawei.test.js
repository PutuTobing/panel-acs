#!/usr/bin/env node
/* Uji dukungan Huawei HG8245W5-6T (X_HW, firmware V5) — 2026-10-01.
 *
 * LATAR: SN 485754432B16F9AE tidak punya profil vendor → jatuh ke X_CMCC (ZTE).
 * Simpan WAN mengirim X_CMCC_VLANIDMark dst ke Huawei; Buat WAN menaruh VLAN di
 * '...WCD.N.undefined.X_HW_VLAN'; binding ditulis boolean padahal firmware V5
 * melaporkan xsd:unsignedInt; checkbox SSID 1-4 padahal WiFi 5GHz ada di slot 5.
 *
 * Data uji di bawah = bentuk yang DILAPORKAN ONU itu (dibaca read-only).
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
  let j = src.indexOf('{', i), dalam = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') dalam++;
    else if (src[j] === '}' && --dalam === 0) break;
  }
  return src.slice(i, j + 1);
}

// ── settings.js asli (profil vendor) ──
const ctx = {
  console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout() {},
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
};
vm.createContext(ctx);
vm.runInContext(baca('settings.js'), ctx);

const HW = 'Huawei Technologies Co., Ltd';

// ══ 1. Profil WAN HG8245W5-6T ══
const w = ctx.getWanProfile('HG8245W5-6T', '00259E', HW);
ok(w.matched === true, 'HG8245W5-6T punya profil WAN (tidak lagi jatuh ke ZTE)');
ok(w.template === 'X_HW', 'template X_HW (dapat ' + w.template + ')');
ok(w.params.vlanId === 'X_HW_VLAN' && w.params.vlanMode === '', 'VLAN = X_HW_VLAN pada koneksi, tanpa mode');
ok(w.params.service === 'X_HW_SERVICELIST' && w.params.cos === 'X_HW_PRI', 'Service & CoS X_HW');
ok(w.params.pppConnType === '', 'ConnectionType PPP tidak dipush (ONU melapor IP_Routed)');
ok(w.params.mtuPpp === 'MaxMRUSize' && w.params.mtuIp === 'MaxMTUSize', 'MTU PPP & IP');
ok(!Object.values(w.params).some(v => /X_CMCC/.test(v || '')), 'tidak ada satu pun nama X_CMCC');
ok(w.features.createNewWcd === true, 'satu WCD per WAN (WCD.1 INTERNET, WCD.2 TR069)');
ok(w.dualStack && w.dualStack.param === 'X_HW_IPv6Enable' && w.dualStack.valueOff === false,
   'dualstack X_HW_IPv6Enable, dan "IPv4 Only" = false');

// HG8245A/H tidak berubah
const h = ctx.getWanProfile('HG8245H', '00259E', HW);
ok(h.matched && h.params.mtuIp === '' && h.dualStack.valueOff === undefined,
   'profil HG8245A/H tidak ikut berubah');

// ══ 2. Profil WiFi HG8245W5-6T ══
const s = ctx.getSecurityProfile('HG8245W5-6T', '00259E', HW);
ok(s.matched === true, 'HG8245W5-6T punya profil WiFi');
ok(s.beaconWpa === 'WPAand11i', 'BeaconType WPA = WPAand11i (bukan WPA/WPA2 gaya ZTE)');
ok(s.passwordPath === 'PreSharedKey.1.KeyPassphrase', 'password WiFi = PreSharedKey.1.KeyPassphrase');
// band5MinIdx dibaca api.js lewat getVendorSecurityConfig (entri), bukan profil gabungan.
ok((ctx.getVendorSecurityConfig('HG8245W5-6T', '00259E', HW) || {}).band5MinIdx === 5,
   'slot 5 ke atas = 5GHz');
ok(/X_HW_WebUserInfo\.2\.Password/.test(s.adminSuperPassPath || ''), 'akun Support = X_HW_WebUserInfo.2');

// ══ 3. Pembacaan binding: tipe dicatat, slot sesuai perangkat ══
const ACS = new Function(baca('api.js') + '\n; return ACS;')();
const L = (v, t) => ({ _value: v, _writable: true, _type: t });
const U = v => L(v, 'xsd:unsignedInt');
const lanbind = on => {
  const n = {};
  [1, 2, 3, 4].forEach(i => { n['Lan' + i + 'Enable'] = U(on.includes('L' + i) ? 1 : 0); });
  [1, 2, 3, 4, 5, 6, 7, 8].forEach(i => { n['SSID' + i + 'Enable'] = U(on.includes('S' + i) ? 1 : 0); });
  return n;
};
const raw = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: {
  '1': { WANPPPConnection: { '1': {
    Name: L('1_INTERNET_R_VID_100', 'xsd:string'), Enable: L(true, 'xsd:boolean'),
    ConnectionType: L('IP_Routed', 'xsd:string'), Username: L('u', 'xsd:string'),
    X_HW_SERVICELIST: L('INTERNET', 'xsd:string'), X_HW_VLAN: U(100), X_HW_PRI: U(0),
    X_HW_IPv4Enable: L(true, 'xsd:boolean'), X_HW_IPv6Enable: L(true, 'xsd:boolean'),
    X_HW_LANBIND: lanbind(['L1', 'L2', 'L3', 'L4', 'S1', 'S5']),
  } } },
  '2': { WANIPConnection: { '1': {
    Name: L('2_TR069_R_VID_170', 'xsd:string'), Enable: L(true, 'xsd:boolean'),
    X_HW_SERVICELIST: L('TR069', 'xsd:string'), X_HW_VLAN: U(170),
    X_HW_IPv4Enable: L(true, 'xsd:boolean'), X_HW_IPv6Enable: L(false, 'xsd:boolean'),
    X_HW_LANBIND: lanbind([]),
  } } },
} } } } };
const kon = ACS.parseWanConnections(raw);
const ppp = kon.find(c => /WANPPPConnection/.test(c.basePath));
ok(ppp && ppp.lanBindType === 'xsd:unsignedInt', 'tipe binding dicatat dari laporan ONU (xsd:unsignedInt)');
ok(ppp && ppp.lanBindSlots.wlan.length === 8 && ppp.lanBindSlots.eth.length === 4, 'slot LAN1-4 & SSID1-8 terbaca');
ok(ppp && /WLANConfiguration\.5/.test(ppp.lanInterface) && /LANEthernetInterfaceConfig\.4/.test(ppp.lanInterface),
   'binding 5GHz (slot 5) & LAN4 terbaca dari nilai 1');
ok(ppp && !/WLANConfiguration\.2\b/.test(ppp.lanInterface), 'slot bernilai 0 tidak dianggap terikat');
const tr = kon.find(c => /WANIPConnection/.test(c.basePath));
ok(tr && tr.lanInterface === '', 'WAN TR069 (semua 0) → tanpa binding');
ok(ppp && ppp.vlanId === 100 && ppp.ipMode === 3, 'VLAN 100 & dualstack terbaca');

// ══ 4. Penulisan binding memakai tipe laporan ONU ══
const dd = strip(baca('device-detail.js'));
const ctx2 = {};
vm.createContext(ctx2);
vm.runInContext(iris(dd, '_wanLanParsed') + '\n' + iris(dd, '_lanBindBoolParams'), ctx2);
const B = 'IGD.WCD.1.PPP.1.';
const pilih = 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5';
const tulis = ctx2._lanBindBoolParams(ppp, B, pilih);
const cari = n => tulis.find(p => p[0] === B + 'X_HW_LANBIND.' + n);
ok(tulis.length === 12, '12 slot ditulis (LAN1-4, SSID1-8) — mencabut binding juga berlaku');
ok(cari('Lan2Enable')[1] === 1 && cari('Lan2Enable')[2] === 'xsd:unsignedInt', 'LAN2 dipilih → 1 (xsd:unsignedInt)');
ok(cari('SSID5Enable')[1] === 1, 'SSID5 (5GHz) dipilih → 1');
ok(cari('Lan1Enable')[1] === 0 && cari('SSID1Enable')[1] === 0, 'yang tak dipilih → 0');
const lama = Object.assign({}, ppp, { lanBindType: 'xsd:boolean' });
const tBool = ctx2._lanBindBoolParams(lama, B, pilih);
ok(tBool[1][1] === true && tBool[1][2] === 'xsd:boolean', 'HG8245A (boolean) tetap true/false');

// ══ 5. Tampilan, Buat WAN, Hapus WAN, dualstack ══
ok(/_lbConn/.test(dd) && /lanBindSlots\.wlan \|\| \[\]\)\.indexOf\(i\)/.test(dd),
   'checkbox SSID Huawei = instance WLAN yang ada ∩ slot binding (5GHz ikut, SSID fiktif hilang)');
const buat = iris(dd, '_wanDoCreateNewWcd');
ok(/else if \(devVlanNode\)/.test(buat) && /_pushParam\(params, connBase, P\.vlanId/.test(buat),
   'Buat WAN Huawei: VLAN pada koneksi baru, bukan node "undefined"');
const hapus = iris(dd, '_wanHandleDelete');
ok(/_sendiri/.test(hapus) && /delPath = _wcdPath/.test(hapus),
   'Hapus WAN: WCD ikut dihapus bila koneksi satu-satunya isinya');
const simpan = iris(dd, '_wanHandleSave');
ok(/\(\(conn\.ipMode \|\| 1\) >= 2\) === \(ipMode >= 2\)/.test(simpan), 'mode IP tak berubah → dualstack tidak dikirim ulang');
ok(/valueOff !== undefined/.test(simpan), 'valueOff=false (Huawei) tetap dikirim untuk IPv4 Only');
const apiC = strip(baca('api.js'));
ok(/lbBase \+ 'SSID' \+ n \+ 'Enable'/.test(apiC), 'Refresh membaca slot binding yang benar-benar ada (termasuk SSID5)');

// ══ 6. Klien WiFi: kolom tabel "Wifi Connected" UI GenieACS (2026-10-01) ══
const S = v => L(v, 'xsd:string');
const rawLan = { InternetGatewayDevice: { LANDevice: { '1': {
  Hosts: { Host: { '5': {
    HostName: S('V2120'), IPAddress: S('192.168.100.103'), MACAddress: S('ca:cc:32:f8:40:e8'),
    Active: L(true, 'xsd:boolean'), InterfaceType: S('SSID1'),
    Layer2Interface: S('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1'),
  } } },
  WLANConfiguration: { '1': { SSID: S('AMIN'), Enable: L(true, 'xsd:boolean'),
    AssociatedDevice: { '1': {
      AssociatedDeviceMACAddress: S('CA:CC:32:F8:40:E8'), X_HW_RSSI: S('-59'), X_HW_Noise: S('-93'),
      X_HW_SNR: S('34'), X_HW_SingalQuality: S('35'), X_HW_FrequencyWidth: S('20M'),
      X_HW_WorkingMode: S('11bgn'), X_HW_AntennaNum: S('1*1'), X_HW_TxRate: S('65'), X_HW_RxRate: S('52'),
      X_HW_BeamFormingSupported: S('0'), X_HW_DualBandSupported: S('1'), X_HW_PSMode: L(true, 'xsd:boolean'),
    } } } },
} } } };
const dev = ACS.mapDevice(Object.assign({ _id: 'X', _deviceId: {} }, rawLan));
const cl = (dev.hostList || []).find(x => x.mac === 'ca:cc:32:f8:40:e8') || {};
const r = cl.radio || {};
ok(r.width === '20M', 'Width Freq terbaca dari X_HW_FrequencyWidth');
ok(r.quality === 35, 'Quality terbaca dari X_HW_SingalQuality (ejaan firmware)');
ok(r.mode === '11bgn' && r.antenna === '1*1', 'Mode WiFi & antena Huawei terbaca');
ok(r.rssi === -59 && r.noise === -93 && r.snr === 34, 'RSSI/Noise/SNR terbaca');

const pop = dd.slice(dd.indexOf('async function _hostDetailBuka'), dd.indexOf('function _hostTipShow'));
ok(/'Width Freq', rd\.width/.test(pop), 'pop-up detail menampilkan Width Freq');
ok(/rd\.quality/.test(pop) && /rd\.antenna/.test(pop), 'pop-up detail menampilkan Quality & antena');
ok(!/ACS\.(setParam|postTask|summon)/.test(pop), 'pop-up tidak mengirim perintah tulis/summon');
ok(!/dct-ssid-key">Perangkat:/.test(dd) && !/ssid-info-k">Perangkat</.test(dd),
   'jumlah perangkat terhubung tidak lagi ditampilkan di menu SSID');

// ══ 7. SSID & radio HG8245W5-6T (2026-10-01) ══
const rawW = { InternetGatewayDevice: { LANDevice: { '1': { WLANConfiguration: {
  '5': { SSID: S('AMIN 5G'), Enable: L(true, 'xsd:boolean'), Channel: U(149), AutoChannelEnable: L(true, 'xsd:boolean'),
         PossibleChannels: S('36,40,44,48,52,56,60,64,149,153,157,161'), X_HW_HT20: U(3),
         X_HW_RFBand: S('5GHz'), Standard: S('11ac'), BeaconType: S('WPAand11i'),
         PreSharedKey: { '1': { KeyPassphrase: S(''), PreSharedKey: S('rahasia8') } } },
  '6': { SSID: S('X'), Enable: L(false, 'xsd:boolean'),
         PreSharedKey: { '1': { KeyPassphrase: S(''), PreSharedKey: S('a'.repeat(64)) } } },
} } } } };
const w5 = ACS.mapDevice(Object.assign({ _id: 'X', _deviceId: {} }, rawW)).ssids;
const s5 = w5.find(x => x.idx === 5), s6 = w5.find(x => x.idx === 6);
ok(s5.possibleChannels && s5.possibleChannels.join(',') === '36,40,44,48,52,56,60,64,149,153,157,161',
   'PossibleChannels dari ONU terbaca');
ok(s5.channelWidthType === 'hwht20' && s5.channelWidthVal === 3, 'bandwidth Huawei = X_HW_HT20 (enum), nilai 3 = Auto 5GHz');
ok(s5.password === 'rahasia8', 'password Huawei V5 di PreSharedKey.1.PreSharedKey tetap tampil');
ok(s6.password === '', 'kunci PSK heksadesimal 64 karakter tidak ditampilkan sebagai password');

const ctx3 = {};
vm.createContext(ctx3);
vm.runInContext(iris(dd, '_radioChOpts'), ctx3);
const opsi = ctx3._radioChOpts(true, 'auto', s5.possibleChannels);
ok(!/value="100"/.test(opsi) && !/value="165"/.test(opsi) && /value="149"/.test(opsi),
   'channel 5GHz hanya yang diizinkan ONU (tanpa 100-140 & 165)');
ok(/value="100"/.test(ctx3._radioChOpts(true, 'auto', null)), 'tanpa PossibleChannels → daftar umum seperti semula');
ok(/value="120" selected/.test(ctx3._radioChOpts(true, '120', s5.possibleChannels)),
   'channel yang sedang dipakai tetap tampil walau di luar daftar');
ok(/_radioChOpts\(g\.is5g, cur, rep\.possibleChannels \|\| /.test(dd), 'panel Channel memakai PossibleChannels (cadangan hanya bila belum terbaca)');
ok(/mc && parseInt\(mc, 10\) !== ssid\.maxClients/.test(dd), 'Maks Perangkat Terhubung hanya dikirim bila diubah');

console.log(`huawei: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
