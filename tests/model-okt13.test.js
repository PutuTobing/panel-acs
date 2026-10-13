#!/usr/bin/env node
/* Uji profil hasil audit 2026-10-13: ZTE F660, F670, F1611A, F672Y (unit kedua) dan
 * Huawei HG8145V5 — WAN, SSID, dan Setting (akun web).
 *
 * LATAR (audit MURNI BACA terhadap lima ONU pilihan operator): empat model belum punya
 * profil dan jatuh ke templat X_CMCC (ZTE F663). Akibatnya di F670/F1611A/HG8145V5 tujuh
 * nama parameter WAN tidak dikenal ONU dan Simpan TANPA perubahan mengirim
 * ConnectionType='PPPoE_Routed'; di F670 ganti password WiFi ditulis ke leaf yang tidak ada;
 * form Super Admin menunjuk VirtualParameters (ditolak pagar). Di F660 (X_CMCC asli) Simpan
 * tanpa perubahan mengubah MaxMRUSize 0 → 1480 dan VLAN mode transparent (1) → tagged (2).
 *
 * Yang dijaga:
 *   1. Tiap model punya profil SENDIRI dengan nama parameter yang terbaca dari ONU-nya.
 *   2. Yang BELUM terbukti tidak ditawarkan: F670 tanpa binding / dualstack / tambah-hapus
 *      WAN / form akun; akun F1611A & F672Y hanya aktif bila parameternya dikenal (cek-ada).
 *   3. Form WAN tidak mengubah keadaan yang tidak disentuh (MTU 0, VLAN transparent).
 *   4. Band slot F672Y benar walau ONU belum melaporkan bandnya; noise & SNR klien terbaca.
 *   5. Model lain TIDAK berubah (F663NV9, F679L/F670L, F6600P, HG8245W5-6T).
 *
 * Semua dokumen perangkat di sini buatan (nama & SN karangan).
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const JS = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

function konteks(simpanan) {
  const isi = Object.assign({}, simpanan || {});
  const ctx = { console, PAGE_INIT: {}, PAGE_TEARDOWN: {}, showToast() {}, App: {}, setTimeout() {}, clearTimeout() {},
    localStorage: { getItem: k => (k in isi ? isi[k] : null), setItem(k, v) { isi[k] = String(v); } },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, text: async () => '[]' }) };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(JS('vpmap.js'), ctx);
  vm.runInContext(JS('settings.js'), ctx);
  vm.runInContext(JS('api.js') + '\nthis.ACS = ACS;', ctx);
  return ctx;
}
const ctx = konteks();
const ZTE = 'ZTE', HW = 'Huawei Technologies Co., Ltd';
const sama = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ══ 1. F660 — X_CMCC asli ══
let w = ctx.getWanProfile('F660', 'F4B5AA', ZTE), s = ctx.getVendorSecurityConfig('F660', 'F4B5AA', ZTE);
ok(w.matched === true && w.template === 'X_CMCC', 'F660: profil WAN sendiri, templat X_CMCC');
ok(sama(w.params, ctx.getWanProfile('F663NV9', 'A0CFF5', ZTE).params) && w.features.canAddDelete === true,
   'F660: nama parameter WAN = keluarga F663 (terbukti dikenal ONU-nya)');
ok(s && s.productClasses === 'F660' && s.passwordPath === 'KeyPassphrase' && s.beaconWpa === 'WPA' && s.beaconOpen === 'None',
   'F660: WiFi KeyPassphrase; BeaconType WPA = "WPA" (satu-satunya nilai yang terlihat di firmware ini)');
ok(s.adminSuperPassPath === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password'
   && s.adminSuperUserPath === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username' && s.adminSuperCurrentUser === 'admin',
   'F660: Super Admin = X_CMCC_TeleComAccount (nama & password), bukan VirtualParameters');
ok(s.adminUserSupported === false && /F660/.test(s.adminUserNote || ''), 'F660: User Admin dimatikan dengan keterangan (tak ada node akun user)');
ok(ctx.getSecurityProfile('F660', 'F4B5AA', ZTE).template === 'X_CMCC', 'F660: templat keamanan X_CMCC');

// ══ 2. F670 (fw V6) — X_ZTE-COM generasi lama, serba hati-hati ══
w = ctx.getWanProfile('F670', 'E44E12', ZTE); s = ctx.getVendorSecurityConfig('F670', 'E44E12', ZTE);
ok(w.matched === true && w.template === 'X_ZTE-COM', 'F670: profil WAN sendiri X_ZTE-COM (tidak lagi jatuh ke X_CMCC)');
ok(w.params.service === 'X_ZTE-COM_ServiceList' && w.params.vlanId === 'X_ZTE-COM_VLANID' && w.params.vlanEnable === 'X_ZTE-COM_VLANEnable'
   && w.params.cos === 'X_ZTE-COM_8021P' && w.params.vlanMode === '', 'F670: service/VLAN/CoS memakai nama X_ZTE-COM pada koneksi');
ok(w.params.pppConnType === '' && w.params.mtuPpp === '' && w.params.mtuIp === '' && w.params.ipMode === '' && w.params.lanInterface === '',
   'F670: ConnectionType PPP, MTU, IP mode, dan binding TIDAK dikirim (belum pernah terbaca)');
ok(!Object.values(w.params).some(v => /X_CMCC/.test(v || '')), 'F670: tidak ada nama X_CMCC tersisa');
ok(!w.dualStack && w.features.ipMode === false && w.features.ipv6 === false,
   'F670: tanpa resep dualstack (leaf IPv6-nya bernama lain daripada F670L/F679L)');
ok(w.features.lanBinding === false && w.features.portBindingTable === false, 'F670: binding dimatikan (format X_ZTE-COM_LanInterface belum terbaca; tak ada tabel PortBinding)');
ok(w.features.canAddDelete === false && !w.createConnType, 'F670: Tambah/Hapus WAN dimatikan sampai PossibleConnectionTypes terbaca');
ok(w.features.vlan === true && w.features.cos === true && w.features.nat === true && w.features.mtu === false, 'F670: yang bisa disunting = VLAN, CoS, NAT');
ok(ctx._vcfgDefaults().filter(e => e.productClasses === 'F670').length === 1 && ctx.getWanProfile('F670L', 'C0515C', ZTE).features.portBindingTable === true
   && ctx.getWanProfile('F670L', 'C0515C', ZTE).dualStack, 'F670 entri terpisah — F670L tidak ikut berubah');
ok(s && s.productClasses === 'F670' && s.passwordPath === 'PreSharedKey.1.KeyPassphrase',
   'F670: password WiFi di PreSharedKey.1.KeyPassphrase (KeyPassphrase langsung tidak dikenal ONU)');
ok(s.beaconWpa === 'WPAand11i' && s.wpaMinimal === true && s.openMinimal === true && !s.encModes,
   'F670: resep minimal dua arah; Encryption Type tidak ditawarkan (param mode belum terbaca)');
ok(s.band5MinIdx === 5 && s.ssidFixedSlots === true, 'F670: slot 1-4 = 2.4GHz, 5-8 = 5GHz');
ok(s.adminSuperSupported === false && /Refresh/.test(s.adminSuperNote || '') && s.adminUserSupported === false && !s.adminSuperPassPath,
   'F670: form akun dimatikan dengan petunjuk (node akun belum dikenal GenieACS) — bukan menunjuk VirtualParameters');

// ══ 3. F1611A — salinan F672Y, akun ber-pengaman ══
w = ctx.getWanProfile('F1611A', '648505', ZTE); s = ctx.getVendorSecurityConfig('F1611A', '648505', ZTE);
const wY = ctx.getWanProfile('F672Y', '14CA56', ZTE);
ok(w.matched === true && w.template === 'X_ZTE-COM' && sama(w.params, wY.params) && sama(w.features, wY.features) && sama(w.dualStack, wY.dualStack)
   && sama(w.createConnType, wY.createConnType), 'F1611A: profil WAN = F672Y (leaf koneksi identik, tabel PortBinding ada)');
ok(ctx._vcfgDefaults().filter(e => e.productClasses === 'F1611A').length === 1, 'F1611A: entri WAN terpisah');
ok(s && s.productClasses === 'F1611A' && s.passwordPath === 'KeyPassphrase' && s.beaconWpa === 'WPAand11i' && s.openMinimal === true && s.band5MinIdx === 5,
   'F1611A: WiFi keluarga X_ZTE-COM; 8 slot (5-8 = 5GHz)');
ok(Array.isArray(s.encModes) && s.encModes.map(m => m.beacon).join() === '11i,WPAand11i' && !s.bw5Extra, 'F1611A: dua pilihan Encryption Type; 160MHz tidak ditawarkan');
ok(s.adminSuperPassPath === 'InternetGatewayDevice.User.1.Password' && s.adminUserPassPath === 'InternetGatewayDevice.User.2.Password'
   && s.adminSuperCekAda === true && s.adminUserCekAda === true,
   'F1611A: Super = User.1, User = User.2, keduanya dengan pengaman cek-ada (node User belum ditelusuri)');

// ══ 4. HG8145V5 — salinan HG8245W5-6T ══
w = ctx.getWanProfile('HG8145V5', '00259E', HW); s = ctx.getVendorSecurityConfig('HG8145V5', '00259E', HW);
const wW5 = ctx.getWanProfile('HG8245W5-6T', '00259E', HW);
ok(w.matched === true && w.template === 'X_HW' && sama(w.params, wW5.params) && sama(w.features, wW5.features) && sama(w.dualStack, wW5.dualStack),
   'HG8145V5: profil WAN = HG8245W5-6T (X_HW_VLAN / X_HW_PRI / X_HW_SERVICELIST, satu WCD per WAN)');
ok(w.params.pppConnType === '' && w.params.mtuPpp === 'MaxMRUSize' && w.params.mtuIp === 'MaxMTUSize' && w.features.createNewWcd === true,
   'HG8145V5: ConnectionType PPP tidak dipush (ONU melapor IP_Routed); MTU PPP & IP bisa diatur');
ok(s && s.productClasses === 'HG8145V5' && s.passwordPath === 'PreSharedKey.1.KeyPassphrase' && s.beaconWpa === 'WPAand11i' && s.band5MinIdx === 5,
   'HG8145V5: WiFi X_HW V5 (WLAN.1 2.4GHz, WLAN.5 5GHz)');
ok(s.adminSuperPassPath === 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.Password'
   && s.adminUserPassPath === 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.Password'
   && s.adminSuperUserPath.endsWith('X_HW_WebUserInfo.2.UserName') && s.adminUserUserPath.endsWith('X_HW_WebUserInfo.1.UserName'),
   'HG8145V5: Super = WebUserInfo.2, User = WebUserInfo.1 (nama & password)');
ok(!s.adminSuperCurrentUser && !s.adminUserCurrentUser, 'HG8145V5: tanpa nama bawaan — nama akun berbeda antar unit (telecomadmin/root vs Support/Admin)');
ok(ctx.getVendorSecurityConfig('HG8245W5-6T', '00259E', HW).adminSuperCurrentUser === 'Support' && ctx._vcfgDefaults().filter(e => e.productClasses === 'HG8145V5').length === 1,
   'HG8245W5-6T tidak berubah; HG8145V5 entri terpisah');

// ══ 5. F672Y — band per slot & pengaman akun ══
s = ctx.getVendorSecurityConfig('F672Y', '14CA56', ZTE);
ok(sama(s.band5Idx, [5, 6, 7, 8, 10]) && s.adminSuperCekAda === true && s.adminUserCekAda === true && !s.band5MinIdx,
   'F672Y: band5Idx [5,6,7,8,10] (slot 9 = 2.4GHz) dan cek-ada untuk kedua akun');
const leaf = v => ({ _object: false, _writable: true, _value: v });
const tanpaNilai = () => ({ _object: false, _writable: true });
const slot = (ssid, ch, lain) => Object.assign({ SSID: leaf(ssid), Enable: leaf(false), Channel: leaf(ch), BeaconType: leaf('11i') }, lain || {});
const dokY = { _id: '14CA56-F672Y-ZTEGAAAA0001', _lastInform: new Date().toISOString(),
  _deviceId: { _Manufacturer: ZTE, _OUI: '14CA56', _ProductClass: 'F672Y', _SerialNumber: 'ZTEGAAAA0001' },
  InternetGatewayDevice: { LANDevice: { 1: { WLANConfiguration: {
    1: slot('RUMAH', 8), 4: slot('SSID4', 8),
    5: slot('RUMAH-5G', 36, { 'X_ZTE-COM_OperatingFrequencyBand': tanpaNilai() }),
    6: slot('SSID6', 0, { 'X_ZTE-COM_OperatingFrequencyBand': tanpaNilai() }),     // 5GHz mati: Channel 0, band belum terbaca
    8: slot('SSID8', 0), 9: slot('Pabrik2.4g', 8), 10: slot('Pabrik', 0),
    7: slot('SSID7', 0, { 'X_ZTE-COM_OperatingFrequencyBand': leaf('2.4GHz') }),    // leaf dari ONU SELALU didahulukan
  } } } } };
const band = ctx.ACS.mapDevice(dokY).ssids.reduce((o, x) => (o[x.idx] = x.band5, o), {});
ok(band[1] === false && band[4] === false && band[9] === false, 'F672Y: slot 1-4 & 9 = 2.4GHz');
ok(band[5] === true && band[6] === true && band[8] === true && band[10] === true,
   'F672Y: slot 5GHz yang mati (Channel 0, band belum terbaca) tetap terbaca 5GHz — dapat ' + JSON.stringify(band));
ok(band[7] === false, 'bila ONU melaporkan bandnya sendiri, laporan ONU yang dipakai (bukan peta slot)');
const dokL = JSON.parse(JSON.stringify(dokY)); dokL._deviceId._ProductClass = 'F679L'; dokL._id = 'AAAAAA-F679L-ZTEGAAAA0002';
const bandL = ctx.ACS.mapDevice(dokL).ssids.reduce((o, x) => (o[x.idx] = x.band5, o), {});
ok(bandL[6] === undefined && bandL[10] === undefined && bandL[7] === false, 'model lain (F679L) tidak memakai peta slot F672Y — perilaku lama');

// ══ 6. Seed profil lama di browser/server ikut ditambal; yang disunting operator dibiarkan ══
const seedLama = [{ id: 'lama', manufacturer: ZTE, productClasses: 'F672Y', template: 'TR098', passwordPath: 'KeyPassphrase', beaconWpa: 'WPAand11i',
  beaconOpen: 'None', encOpen: 'None', adminSuperPassPath: 'InternetGatewayDevice.User.1.Password', adminUserPassPath: 'InternetGatewayDevice.User.2.Password' }];
let c2 = konteks({ acs_vendor_security: JSON.stringify(seedLama) });
let s2 = c2.getVendorSecurityConfig('F672Y', '14CA56', ZTE);
ok(s2.id === 'lama' && sama(s2.band5Idx, [5, 6, 7, 8, 10]) && s2.adminUserCekAda === true && s2.adminSuperCekAda === true,
   'seed F672Y lama (tanpa band5Idx / cek-ada) ditambal dari kode');
c2 = konteks({ acs_vendor_security: JSON.stringify([Object.assign({}, seedLama[0], { disunting: true })]) });
s2 = c2.getVendorSecurityConfig('F672Y', '14CA56', ZTE);
ok(!s2.band5Idx && !s2.adminUserCekAda, 'entri yang disimpan operator lewat form (disunting) dipakai apa adanya');

// ══ 7. VLAN transparent hanya untuk X_CMCC ══
const koneksi = isi => ({ _id: 'F4B5AA-F660-ZTERAAAA0003', _lastInform: new Date().toISOString(),
  _deviceId: { _Manufacturer: ZTE, _OUI: 'F4B5AA', _ProductClass: 'F660', _SerialNumber: 'ZTERAAAA0003' },
  InternetGatewayDevice: { WANDevice: { 1: { WANConnectionDevice: { 1: isi } } } } });
const pppCmcc = (mode, vid, mru) => ({ Enable: leaf(true), Name: leaf('x'), ConnectionType: leaf('PPPoE_Bridged'), X_CMCC_ServiceList: leaf('INTERNET'),
  X_CMCC_VLANIDMark: leaf(vid), X_CMCC_VLANMode: leaf(mode), MaxMRUSize: leaf(mru), Username: leaf('') });
const wc = ctx.ACS.mapDevice(koneksi({ WANPPPConnection: { 4: pppCmcc(2, 1001, 0), 5: pppCmcc(1, 0, 0), 6: pppCmcc(0, 0, 1492) } })).wanConnections;
const k = n => wc.find(x => x.connIdx === n);
ok(k(5).vlanMode === 1 && k(5).vlanTransparan === true, 'X_CMCC_VLANMode 1 ditandai transparent');
ok(k(4).vlanTransparan === false && k(6).vlanTransparan === false && k(4).vlanMode === 2 && k(6).vlanMode === 0, 'mode 2 (tagged) & 0 (untagged) tidak ditandai');
ok(k(4).mtu === 0 && k(6).mtu === 1492, 'MaxMRUSize 0 terbaca 0 (bukan diganti bawaan 1480)');
const wcCt = ctx.ACS.mapDevice({ _id: 'AAAAAA-FD512XW%2DR460-DF1D%2D0000000001', _lastInform: new Date().toISOString(),
  _deviceId: { _Manufacturer: 'CDTC', _OUI: 'AAAAAA', _ProductClass: 'FD512XW-R460', _SerialNumber: 'DF1D-0000000001' },
  InternetGatewayDevice: { WANDevice: { 1: { WANConnectionDevice: { 1: {
    'X_CT-COM_WANGponLinkConfig': { VLANIDMark: leaf(100), Mode: leaf(1) },
    WANPPPConnection: { 1: { Enable: leaf(true), Name: leaf('x'), 'X_CT-COM_ServiceList': leaf('INTERNET'), Username: leaf('u') } } } } } } } }).wanConnections;
ok(wcCt.length === 1 && wcCt[0].vlanMode === 1 && wcCt[0].vlanTransparan === false,
   'angka 1 pada node VLAN vendor lain (X_CT-COM) TIDAK dianggap transparent — maknanya tidak diasumsikan sama');

// ══ 8. Form WAN & Setting (kode yang dijalankan browser) ══
const dd = JS('device-detail.js');
ok(dd.includes('var isTransparan = !isNew && !!conn.vlanTransparan && vlanModeVal === 1;')
   && dd.includes("(isTransparan ? '<option value=\"1\" selected>Transparent (seperti di ONU sekarang)</option>' : '')")
   && dd.includes("'<option value=\"0\"' + (!isTagged && !isTransparan ? ' selected' : '') + '>Untagged</option>'"),
   'form WAN: pilihan Transparent hanya muncul bila ONU sedang memakainya, dan terpilih');
ok(dd.includes('if (vlanMode === 2 && (vlanId < 1 || vlanId > 4094))') && dd.includes("parseInt(sel.value, 10) === 2 ? '' : 'none'"),
   'VLAN ID hanya diwajibkan/ditampilkan untuk Tagged');
ok(dd.includes("value=\"' + (conn.mtu === 0 ? '' : (conn.mtu || 1480)) + '\"")
   && dd.includes("var mtuDibiarkan = !!(mtuEl && !isNew && conn && conn.mtu === 0 && String(mtuEl.value).trim() === '');")
   && dd.includes('if (mtuEl && !mtuDibiarkan && (!mtu || mtu < 576 || mtu > 9000))'),
   'MTU 0 di ONU tampil kosong; kosong = tidak diubah (dulu 1480 ikut terkirim)');
ok(dd.includes("_settCekAda(d, 'stg-user', userCfg.passPath, 'User Admin')") && dd.includes("_settCekAda(d, 'stg-super', superCfg.passPath, 'Super Admin')")
   && dd.includes('function _settCekAda(d, pfx, passPath, namaAkun)'), 'Setting: pengaman cek-ada untuk Super Admin DAN User Admin');
const alat = fs.readFileSync(path.join(__dirname, '..', 'tools', 'audit_ont.js'), 'utf8');
ok(alat.includes('conn.vlanTransparan && conn.vlanMode === 1 ? 1') && alat.includes('conn.mtu === 0 ? 0 : (conn.mtu || 1480)'),
   'alat audit meniru form yang baru (transparent & MTU 0) — simulasinya tidak boleh tertinggal dari form');

// ══ 9. Klien WiFi: noise X_ZTE-COM_Noise & SNR terhitung ══
const dokK = { _id: '648505-F1611A-ZTE0AAAA0004', _lastInform: new Date().toISOString(),
  _deviceId: { _Manufacturer: ZTE, _OUI: '648505', _ProductClass: 'F1611A', _SerialNumber: 'ZTE0AAAA0004' },
  InternetGatewayDevice: { LANDevice: { 1: {
    Hosts: { Host: { 1: { Active: leaf(true), MACAddress: leaf('8c:aa:ce:00:00:01'), IPAddress: leaf('192.168.1.2'), InterfaceType: leaf('802.11'), HostName: leaf('HP-Contoh') },
                     2: { Active: leaf(true), MACAddress: leaf('8c:aa:ce:00:00:02'), IPAddress: leaf('192.168.1.3'), InterfaceType: leaf('802.11'), HostName: leaf('HP-Dua') } } },
    WLANConfiguration: { 1: Object.assign(slot('RUMAH', 6), { Enable: leaf(true), TotalAssociations: leaf(2), AssociatedDevice: {
      1: { AssociatedDeviceMACAddress: leaf('8c:aa:ce:00:00:01'), AssociatedDeviceRssi: leaf(-59), 'X_ZTE-COM_Noise': leaf(-98), AssociatedDeviceBandWidth: leaf('20MHz') },
      2: { AssociatedDeviceMACAddress: leaf('8c:aa:ce:00:00:02'), AssociatedDeviceRssi: leaf(-70) } } }) } } } } };
const hosts = ctx.ACS.mapDevice(dokK).hostList;
const h1 = hosts.find(h => /00:01$/i.test(h.mac)), h2 = hosts.find(h => /00:02$/i.test(h.mac));
ok(h1 && h1.radio && h1.radio.rssi === -59 && h1.radio.noise === -98 && h1.radio.snr === 39, 'noise terbaca dari X_ZTE-COM_Noise; SNR = RSSI − noise = 39 dB — dapat ' + JSON.stringify(h1 && h1.radio && [h1.radio.rssi, h1.radio.noise, h1.radio.snr]));
ok(h2 && h2.radio && h2.radio.rssi === -70 && h2.radio.snr == null, 'tanpa noise → SNR tidak dikarang');
ok(/RADIO_DETAIL_FIELDS = \[[\s\S]*?'X_ZTE-COM_Noise'/.test(JS('api.js')), 'pop-up klien ikut membaca X_ZTE-COM_Noise bila belum terbaca');

// ══ 9b. Kartu Kondisi Perangkat untuk X_CMCC: galat jalur optik & port LAN (dari cache) ══
const dokKd = koneksi({ WANPPPConnection: { 7: pppCmcc(2, 1001, 1480) } });
dokKd.InternetGatewayDevice.WANDevice[1].X_CMCC_GponInterfaceConfig = { BiasCurrent: leaf(6275), RXPower: leaf(197),
  Stats: { FECError: leaf(1), HECError: leaf(0), DropPackets: leaf(111) } };
dokKd.InternetGatewayDevice.LANDevice = { 1: { LANEthernetInterfaceConfig: {
  1: { Enable: leaf('TRUE'), Status: leaf('Up') }, 2: { Enable: leaf('TRUE'), Status: leaf('NoLink') },
  3: { Enable: leaf('FALSE'), Status: leaf('NoLink') }, 4: { Enable: leaf('TRUE'), Status: leaf('NoLink') } } } };
const kd = ctx.ACS.mapDevice(dokKd).kondisi;
ok(kd && kd.optik && kd.optik.fec === 1 && kd.optik.hec === 0 && kd.optik.buang === 111,
   'F660 (X_CMCC): galat FEC/HEC & paket dibuang terbaca dari X_CMCC_GponInterfaceConfig.Stats — ' + JSON.stringify(kd && kd.optik));
ok(kd && kd.optik.tegangan == null && kd.optik.bias == null && kd.cpu.length === 0 && kd.mem == null,
   'tegangan & arus laser TIDAK ditampilkan untuk X_CMCC (satuan BiasCurrent-nya belum dipastikan); tanpa CPU/memori');
ok(kd && kd.port.map(p => p.keadaan).join() === 'terhubung,kosong,mati,kosong', 'keadaan tiap port LAN ikut tampil');
ok(ctx.ACS.mapDevice(koneksi({ WANPPPConnection: { 7: pppCmcc(2, 1001, 1480) } })).kondisi === null,
   'ONU X_CMCC yang tidak melaporkan penghitung itu: kartu tetap tidak tampil');

// ══ 10. Model lama tidak berubah ══
const f663 = ctx.getWanProfile('F663NV9', 'A0CFF5', ZTE);
ok(f663.template === 'X_CMCC' && f663.params.vlanMode === 'X_CMCC_VLANMode' && f663.params.pppConnType === 'ConnectionType' && f663.features.mtu === true,
   'F663NV9 tetap X_CMCC lengkap');
ok(ctx.getVendorSecurityConfig('F663NV9', 'A0CFF5', ZTE).beaconWpa === 'WPA/WPA2' && ctx.getVendorSecurityConfig('F6600P', 'BCBD84', ZTE).bw5Extra.join() === '160MHz'
   && !ctx.getVendorSecurityConfig('F679L', 'X', ZTE).adminUserCekAda, 'profil WiFi F663NV9 / F6600P / F679L tidak ikut berubah');

console.log('model-okt13: ' + pass + ' lulus, ' + fail + ' gagal');
process.exit(fail ? 1 : 0);
