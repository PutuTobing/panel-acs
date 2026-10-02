// Uji resolusi profil C-DATA (CDTC / FD514GD-R460 / X_CT-COM) + jaminan
// ONU ZTE TIDAK terpengaruh flag resep minimal. Pola eval difftest.
const fs = require('fs');
const path = require('path');
const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'settings.js'), 'utf8');

const store = {};
const localStorage = { getItem(k){ return k in store ? store[k] : null; }, setItem(k,v){ store[k] = String(v); } };
const PAGE_INIT = {};
function showToast(){}
const document = { getElementById: function(){ return null; } };

let pass = 0, fail = 0;
function ok(c, m){ if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

const tests = `
;(function(){
  // C-DATA: getVendorSecurityConfig (dipakai _ssidHandleSave) — model FD514GD-R460,
  // OUI 505B1D, manufacturer CDTC. Cocok via tier Manufacturer+Product.
  var c = getVendorSecurityConfig('FD514GD-R460', '505B1D', 'CDTC');
  ok(!!c, 'C-DATA: entri profil ketemu');
  ok(c && c.beaconWpa === 'WPAand11i', 'C-DATA: beaconWpa=WPAand11i (got ' + (c&&c.beaconWpa) + ')');
  ok(c && c.beaconOpen === 'None', 'C-DATA: beaconOpen=None');
  ok(c && c.wpaMinimal === true,  'C-DATA: wpaMinimal=true (resep WPA minimal)');
  ok(c && c.openMinimal === true, 'C-DATA: openMinimal=true (resep open minimal)');
  ok(c && c.passwordPath === 'KeyPassphrase', 'C-DATA: passwordPath=KeyPassphrase');
  ok(c && c.adminUserSupported === false, 'C-DATA: User Admin dinonaktifkan');
  ok(c && c.ssidFixedSlots === true, 'C-DATA: ssidFixedSlots=true (Tambah SSID = aktifkan slot, bukan addObject)');
  // Sibling FD512XW-R460 juga resolve ke profil C-DATA yang sama.
  var c2 = getVendorSecurityConfig('FD512XW-R460', '505B1D', 'CDTC');
  ok(c2 && c2.beaconWpa === 'WPAand11i' && c2.wpaMinimal === true, 'C-DATA: FD512XW-R460 sibling resolve sama');
  // Template lapisan = X_CT-COM (bukan X_CMCC → form User Admin tak di-hide oleh _isCmcc,
  // tapi adminUserSupported:false yang menyembunyikan).
  var prof = getSecurityProfile('FD514GD-R460', '505B1D', 'CDTC');
  ok(prof && prof.template === 'X_CT-COM', 'C-DATA: template X_CT-COM (got ' + (prof&&prof.template) + ')');

  // ZTE: TIDAK punya flag minimal → resep lama ZTE dipakai (byte-identik).
  var z = getVendorSecurityConfig('F663NV9', 'EC6CB5', 'ZTE');
  ok(z && z.beaconWpa === 'WPA/WPA2', 'ZTE: beaconWpa tetap WPA/WPA2');
  ok(z && z.wpaMinimal === undefined,  'ZTE: wpaMinimal ABSEN (resep ZTE penuh, tak berubah)');
  ok(z && z.openMinimal === undefined, 'ZTE: openMinimal ABSEN (resep ZTE penuh, tak berubah)');
  ok(z && z.ssidFixedSlots === undefined, 'ZTE: ssidFixedSlots ABSEN (Tambah SSID = addObject dinamis, tak berubah)');

  // ── Binding LAN/SSID di WAN aktif utk C-DATA via X_CT-COM_LanInterface ──
  var wc = getWanProfile('FD514GD-R460', '505B1D', 'CDTC');
  ok(wc && wc.features && wc.features.lanBinding === true, 'C-DATA: features.lanBinding=true → seksi binding LAN/SSID TAMPIL');
  ok(wc && wc.params && wc.params.lanInterface === 'X_CT-COM_LanInterface', 'C-DATA: lanInterface=X_CT-COM_LanInterface (binding)');
  ok(wc && wc.params && wc.params.lanDhcpEnable === 'X_CT-COM_LanInterface-DHCPEnable', 'C-DATA: lanDhcpEnable=X_CT-COM_LanInterface-DHCPEnable (verifikasi live DF1D)');
  ok(wc && wc.features && wc.features.bindShowSlot === true, 'C-DATA: bindShowSlot=true → label binding tampilkan nomor slot WLAN');
  var wz = getWanProfile('F663NV9', 'EC6CB5', 'ZTE');
  ok(wz && wz.features && wz.features.lanBinding === true, 'ZTE: features.lanBinding=true (byte-identik)');
  ok(wz && wz.features && wz.features.bindShowSlot === undefined, 'ZTE: bindShowSlot ABSEN (label binding tak berubah, byte-identik)');
  ok(wz && wz.params && wz.params.lanInterface === 'X_CMCC_LanInterface', 'ZTE: lanInterface=X_CMCC_LanInterface (tak berubah)');
  var zNV3a = getVendorSecurityConfig('F663NV3a', '689FF0', 'ZTE');
  ok(zNV3a && zNV3a.wpaMinimal === undefined && zNV3a.openMinimal === undefined, 'ZTE NV3a: tak ada flag minimal');

  // ── ZICG (F650/GM220-S): X_CT-COM tapi resep security STANDAR (BeaconType WPA/WPA2,
  //    param mode PENUH terekspos) → beaconWpa=WPA/WPA2, TANPA flag minimal ──
  var zi = getVendorSecurityConfig('GM220-S', 'ZICG', 'ZICG');
  ok(!!zi, 'ZICG: entri profil ketemu');
  ok(zi && zi.beaconWpa === 'WPA/WPA2', 'ZICG: beaconWpa=WPA/WPA2 (spt ZTE, BUKAN WPAand11i)');
  ok(zi && zi.beaconOpen === 'None', 'ZICG: beaconOpen=None');
  ok(zi && zi.wpaMinimal === undefined && zi.openMinimal === undefined, 'ZICG: TANPA flag minimal (param mode penuh terekspos → recipe standar)');
  ok(zi && zi.passwordPath === 'KeyPassphrase', 'ZICG: passwordPath=KeyPassphrase');
  ok(zi && zi.ssidFixedSlots === true, 'ZICG: ssidFixedSlots=true (slot X_CT-COM tetap)');
  ok(zi && zi.adminUserSupported === false, 'ZICG: User Admin dinonaktifkan');
  ok(zi && zi.adminSuperPassPath === 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
     'ZICG: super admin PASSWORD → X_CT-COM_TeleComAccount.Password (writable, verified)');
  ok(zi && zi.adminSuperUserLocked === true && /admin/.test(zi.adminSuperCurrentUser),
     'ZICG: super admin USERNAME dikunci (tak diekspos firmware)');
  var ziF650 = getVendorSecurityConfig('F650', 'ZICG', 'ZICG');
  ok(ziF650 && ziF650.beaconWpa === 'WPA/WPA2', 'ZICG: F650 sibling resolve sama (WPA/WPA2)');
  // ZICG F650 (manufacturer ZICG) TIDAK boleh ketarik ke recipe ZTE F650 (X_CMCC) — Tier-2 menang
  var ziWan = getWanProfile('GM220-S', 'ZICG', 'ZICG');
  ok(ziWan && ziWan.template === 'X_CT-COM', 'ZICG WAN: template X_CT-COM (bukan X_CMCC ZTE)');
  ok(ziWan && ziWan.vlanNode === 'X_CT-COM_WANEponLinkConfig', 'ZICG WAN: vlanNode=EPON');
  ok(ziWan && ziWan.params && ziWan.params.pppConnType === '', 'ZICG WAN: pppConnType kosong (ConnectionType=IP_Routed)');
  ok(ziWan && ziWan.features && ziWan.features.canAddDelete === true, 'ZICG WAN: create AKTIF');
  ok(ziWan && ziWan.features && ziWan.features.createNewWcd === true, 'ZICG WAN: create = WCD baru (X_CT-COM), bukan jalur generik X_CMCC');

  // ── CIOT (GM220-S/MQ220): X_CT-COM GPON, resep security STANDAR (spt ZICG) ──
  var ci = getVendorSecurityConfig('GM220-S', '1C25E1', 'CIOT');
  ok(!!ci, 'CIOT: entri profil ketemu');
  ok(ci && ci.beaconWpa === 'WPA/WPA2', 'CIOT: beaconWpa=WPA/WPA2 (param mode penuh terekspos)');
  ok(ci && ci.wpaMinimal === undefined && ci.openMinimal === undefined, 'CIOT: TANPA flag minimal (recipe standar)');
  ok(ci && ci.passwordPath === 'KeyPassphrase', 'CIOT: passwordPath=KeyPassphrase');
  ok(ci && ci.ssidFixedSlots === true, 'CIOT: ssidFixedSlots=true (4 slot WLAN tetap)');
  ok(ci && ci.adminSuperPassPath === 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
     'CIOT: super admin PASSWORD → TeleComAccount.Password (writable, verified)');
  ok(ci && ci.adminSuperUserLocked === true && /belum dipastikan/.test(ci.adminSuperCurrentUser),
     'CIOT: username super admin dikunci, nama ditandai belum dipastikan');
  ok(ci && ci.adminUserSupported === false, 'CIOT: User Admin dinonaktifkan');
  var ciMq = getVendorSecurityConfig('MQ220', '1C25E1', 'CIOT');
  ok(ciMq && ciMq.beaconWpa === 'WPA/WPA2' && ciMq.ssidFixedSlots === true, 'CIOT: MQ220 sibling resolve sama');
  // CIOT WAN: Tier-2 (manufacturer) HARUS menang atas entri generik product-only GM220-S/MQ220 (X_CMCC)
  var ciWan = getWanProfile('GM220-S', '1C25E1', 'CIOT');
  ok(ciWan && ciWan.template === 'X_CT-COM', 'CIOT WAN: template X_CT-COM (Tier-2 menang atas generik X_CMCC)');
  ok(ciWan && ciWan.vlanNode === 'X_CT-COM_WANGponLinkConfig', 'CIOT WAN: vlanNode=GPON (bukan EPON spt ZICG)');
  ok(ciWan && ciWan.params && ciWan.params.pppConnType === '', 'CIOT WAN: pppConnType kosong (ConnectionType=IP_Routed)');
  ok(ciWan && ciWan.params && ciWan.params.service === 'X_CT-COM_ServiceList', 'CIOT WAN: service=X_CT-COM_ServiceList');
  ok(ciWan && ciWan.features && ciWan.features.canAddDelete === true && ciWan.features.createNewWcd === true,
     'CIOT WAN: create AKTIF via WCD baru (X_CT-COM)');
  var ciWanMq = getWanProfile('MQ220', '1C25E1', 'CIOT');
  ok(ciWanMq && ciWanMq.template === 'X_CT-COM' && ciWanMq.vlanNode === 'X_CT-COM_WANGponLinkConfig',
     'CIOT WAN: MQ220 sibling resolve sama (GPON)');
  // ZICG GM220-S TIDAK boleh ketarik ke CIOT (vlanNode EPON tetap) — dan sebaliknya
  ok(getWanProfile('GM220-S', 'ZICG', 'ZICG').vlanNode === 'X_CT-COM_WANEponLinkConfig',
     'ZICG GM220-S tetap EPON (tak tertukar dgn CIOT GPON)');

  // ── Entri generik product-only GM220-S/GM220/MQ220 SUDAH DIHAPUS (ranjau X_CMCC) ──
  var genWan = _vcfgDefaults().filter(function(e){
    return !e.manufacturer && !e.oui && /gm220|mq220/i.test(e.productClasses || ''); });
  ok(genWan.length === 0, 'WAN: entri generik GM220/MQ220 (X_CMCC) tak ada lagi di default');
  var genSec = _vmSecDefaults().filter(function(e){
    return !e.manufacturer && !e.oui && /gm220|mq220/i.test(e.productClasses || ''); });
  ok(genSec.length === 0, 'Security: entri generik GM220-S/MQ220 (beaconOpen Basic usang) tak ada lagi');
  // ── HWTC ZL-4224X (dual band, 8 slot): ikut entri HWTC + band dari NOMOR SLOT ──
  var h42 = getVendorSecurityConfig('ZL-4224X', 'HWTC', 'HWTC');
  ok(!!h42, 'HWTC ZL-4224X: entri ketemu (tak lagi jatuh ke default X_CMCC)');
  ok(h42 && h42.beaconWpa === 'WPAand11i' && h42.wpaMinimal === true, 'HWTC ZL-4224X: resep minimal sama ZL-2113X');
  ok(h42 && h42.band5MinIdx === 5, 'HWTC ZL-4224X: band5MinIdx=5 (slot 1-4 = 2.4G, 5-8 = 5G)');
  var h21 = getVendorSecurityConfig('ZL-2113X', 'HWTC', 'HWTC');
  ok(h21 && h21.band5MinIdx === 5, 'HWTC ZL-2113X: band5MinIdx ikut ada — tak berefek (hanya 4 slot)');
  var w42 = getWanProfile('ZL-4224X', 'HWTC', 'HWTC');
  ok(w42 && w42.template === 'X_CT-COM', 'HWTC ZL-4224X WAN: template X_CT-COM (bukan X_CMCC default)');
  ok(w42 && w42.features && w42.features.createNewWcd === true, 'HWTC ZL-4224X WAN: create = WCD baru');
  // Logika band (salinan is5GHz di device-detail.js): band5 boolean MENANG atas heuristik.
  function is5(s) {
    if (typeof s.band5 === 'boolean') return s.band5;
    if (s.channel >= 36) return true;
    var n = (s.name || '').toLowerCase();
    if (n.indexOf('5g') !== -1) return true;
    var std = (s.standard || '').toLowerCase();
    return std === 'ac' || std === 'ax';
  }
  // Kasus nyata HWTCDF6EA948: slot 1 & 5 NAMA SAMA, Channel=0, Standard kosong.
  ok(is5({ idx:5, band5:true,  name:'BTD-TEAM YOGA', channel:0, standard:'' }) === true,
     'ZL-4224X slot 5 (nama sama dgn 2.4G, Ch=0) → 5G lewat band5MinIdx');
  ok(is5({ idx:1, band5:false, name:'BTD-TEAM YOGA', channel:0, standard:'' }) === false,
     'ZL-4224X slot 1 → 2.4G (tak tertukar)');
  // ZTE: band5 undefined → heuristik lama UTUH (byte-identik)
  ok(is5({ idx:5, name:'ZTE-5G', channel:0, standard:'' }) === true,  'ZTE: heuristik nama "5G" tetap jalan');
  ok(is5({ idx:5, name:'RumahKu', channel:36, standard:'' }) === true, 'ZTE: heuristik Channel>=36 tetap jalan');
  ok(is5({ idx:1, name:'RumahKu', channel:6,  standard:'' }) === false,'ZTE: 2.4G tetap 2.4G');

  // ── ZTEG (34) & TRKG (7): X_CT-COM/EPON walau product class 'F663NV3A'/'Trikom F609' ──
  // Tier-2 (manufacturer) HARUS menang atas entri ZTE product-only (X_CMCC) yang sebelumnya
  // salah menarik mereka. Sebaliknya, ZTE ASLI dgn F663NV3A tetap X_CMCC (byte-identik).
  var zg = getWanProfile('F663NV3A', '64E0AB', 'ZTEG');
  ok(zg.template === 'X_CT-COM', 'ZTEG F663NV3A: WAN X_CT-COM (bukan X_CMCC ZTE)');
  ok(zg.vlanNode === 'X_CT-COM_WANEponLinkConfig', 'ZTEG: vlanNode EPON');
  ok(zg.params.service === 'X_CT-COM_ServiceList' && zg.params.vlanId === 'VLANIDMark', 'ZTEG: param X_CT-COM');
  ok(zg.features.createNewWcd === true, 'ZTEG: create = WCD baru');
  var tk = getWanProfile('Trikom F609', '08AA9A', 'TRKG');
  ok(tk.template === 'X_CT-COM' && tk.vlanNode === 'X_CT-COM_WANEponLinkConfig', 'TRKG Trikom F609: WAN X_CT-COM/EPON');
  var zgS = getVendorSecurityConfig('F663NV3A', '64E0AB', 'ZTEG');
  ok(zgS && zgS.beaconWpa === 'WPA/WPA2' && zgS.wpaMinimal === undefined, 'ZTEG: resep security STANDAR (param mode penuh)');
  ok(zgS && zgS.adminSuperPassPath === 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password',
     'ZTEG: super admin → TeleComAccount.Password');
  var tkS = getVendorSecurityConfig('Trikom F609', '08AA9A', 'TRKG');
  ok(tkS && tkS.beaconWpa === 'WPA/WPA2' && tkS.beaconOpen === 'None', 'TRKG: resep standar, open=None (bukan Basic usang)');
  // ZTE ASLI tak boleh ikut berubah
  var zteReal = getWanProfile('F663NV3A', 'EC6CB5', 'ZTE');
  ok(zteReal.template === 'X_CMCC' && zteReal.vlanNode == null, 'ZTE asli F663NV3A: tetap X_CMCC (byte-identik)');

  // ── ZTE F679L/F670L (11): X_ZTE-COM — Tier-2 (mfr ZTE + produk) atas entri ZTE lama ──
  var zl = getWanProfile('F679L', '304074', 'ZTE');
  ok(zl.template === 'X_ZTE-COM', 'F679L: template X_ZTE-COM (bukan X_CMCC)');
  ok(zl.params.vlanId === 'X_ZTE-COM_VLANID', 'F679L: vlanId=X_ZTE-COM_VLANID (VLAN pada koneksi)');
  ok(zl.params.vlanMode === '', 'F679L: vlanMode KOSONG (VLANEnable = boolean, bukan mode)');
  ok(zl.params.vlanEnable === 'X_ZTE-COM_VLANEnable', 'F679L: vlanEnable dipush terpisah sbg boolean');
  ok(zl.params.service === 'X_ZTE-COM_ServiceList', 'F679L: service=X_ZTE-COM_ServiceList');
  ok(zl.vlanNode == null && zl.vlanOnWcd == null, 'F679L: VLAN pada koneksi (bukan node saudara / leaf WCD)');
  ok(zl.features.createNewWcd === false, 'F679L: create = koneksi baru di WCD.1 (bukan WCD baru)');
  ok(zl.features.ipMode === false && zl.features.ipv6 === false, 'F679L: IP Mode & IPv6 dimatikan (X_ZTE-COM_IPMode string)');
  // Create 2 fase: ConnectionType lebih dulu (objek baru lahir 'Unconfigured' → 9002)
  ok(zl.createConnType && zl.createConnType.ppp === 'IP_Routed',
     "F679L: create kirim ConnectionType='IP_Routed' DULU (PPPoE_Routed tak ada di firmware ini)");
  ok(zl.createConnType.pppBridged === 'PPPoE_Bridged', 'F679L: PPPoE bridged = PPPoE_Bridged');
  ok(zl.params.pppConnType === '', 'F679L: ConnectionType TIDAK ikut batch utama (sudah dikirim di fase A)');
  ok(zl.params.name === 'Name', 'F679L: koneksi baru diberi Name (firmware menamai INTERNET/TR69)');
  // Dualstack IPv4+IPv6 saat create (resep dari 3 ONU F679L yang IPv6-nya Connected)
  ok(zl.dualStack && zl.dualStack.param === 'X_ZTE-COM_IPMode', 'F679L: dualstack via X_ZTE-COM_IPMode');
  ok(zl.dualStack.value === 'Both' && zl.dualStack.type === 'xsd:string',
     "F679L: IPMode = STRING 'Both' (bukan integer 3 gaya X_CMCC/X_CT-COM)");
  var zlSlaac = (zl.dualStack.slaac || []).map(function(s){ return s[0]; });
  ok(zlSlaac.indexOf('X_ZTE-COM_SlaacEnable') >= 0 && zlSlaac.indexOf('X_ZTE-COM_Dhcpv6IAPDEnable') >= 0
     && zlSlaac.indexOf('X_ZTE-COM_IPv6AcquireMode') >= 0,
     'F679L: SLAAC + DHCPv6 IA-PD + AcquireMode ikut dipush saat create');
  ok(getWanProfile('F663NV9', 'EC6CB5', 'ZTE').dualStack === undefined,
     'ZTE F663NV9: TANPA dualStack → create tak menambah langkah IPv6 (byte-identik)');
  // Binding lewat tabel Port Binding (menu "Port Binding" di web ONU)
  ok(zl.features.lanBinding === true && zl.features.portBindingTable === true,
     'F679L: binding LAN/SSID AKTIF via tabel X_ZTE-COM_PortBinding');
  ok(zl.params.lanInterface === '' && zl.params.lanDhcpEnable === '',
     'F679L: binding BUKAN param koneksi → lanInterface/lanDhcpEnable kosong (checkbox DHCP disembunyikan)');
  // ZTE F663 tak boleh ikut create 2-fase / Name / tabel binding (byte-identik)
  var f663w = getWanProfile('F663NV9', 'EC6CB5', 'ZTE');
  ok(f663w.createConnType === undefined, 'ZTE F663NV9: TANPA createConnType → alur create lama (byte-identik)');
  ok(f663w.params.name === undefined,    'ZTE F663NV9: Name tak dipush saat create (byte-identik)');
  ok(f663w.features.portBindingTable === undefined && f663w.params.lanInterface === 'X_CMCC_LanInterface',
     'ZTE F663NV9: binding tetap via param koneksi X_CMCC_LanInterface');
  ok(zl.params.mtuPpp === '', 'F679L: MTU tak dipush (MaxMRUSize absen di F670L)');
  ok(getWanProfile('F670L', '34243E', 'ZTE').template === 'X_ZTE-COM', 'F670L: sibling resolve sama');
  var zlS = getVendorSecurityConfig('F679L', '304074', 'ZTE');
  ok(zlS && zlS.beaconWpa === 'WPAand11i', "F679L: beaconWpa='WPAand11i' (BUKAN WPA/WPA2 gaya F663 → hindari 9007)");
  ok(zlS && zlS.wpaMinimal === undefined, 'F679L: WPA = resep STANDAR (param mode lengkap, diuji live OK)');
  ok(zlS && zlS.openMinimal === true, "F679L: open = HANYA BeaconType='None' (BasicAuthenticationMode='OpenSystem' → 9007, diuji live)");
  ok(zlS && zlS.beaconOpen === 'None', "F679L: beaconOpen='None'");
  // ZTE F663 (X_CMCC) TETAP memakai resep open lama (BasicAuthenticationMode='OpenSystem')
  ok(getVendorSecurityConfig('F663NV9', 'EC6CB5', 'ZTE').openMinimal === undefined,
     'ZTE F663NV9: openMinimal ABSEN → resep open lama utuh (byte-identik)');
  ok(zlS && zlS.adminSuperPassPath === 'InternetGatewayDevice.User.1.Password', 'F679L: super admin password = User.1.Password');
  ok(zlS && zlS.adminSuperUserPath === 'InternetGatewayDevice.User.1.Username', 'F679L: username super admin BISA diubah (User.1.Username)');
  ok(zlS && zlS.band5MinIdx === undefined, 'F679L: TANPA band5MinIdx (band dari Channel>=36 sudah benar)');
  // ── Huawei HG8245A/H (3): X_HW — VLAN pada koneksi, binding boolean, tanpa akun web ──
  var hwW = getWanProfile('HG8245A', '00259E', 'Huawei Technologies Co., Ltd');
  ok(hwW.template === 'X_HW', 'Huawei: template X_HW');
  ok(hwW.params.vlanId === 'X_HW_VLAN' && hwW.params.vlanMode === '',
     'Huawei: VLAN=X_HW_VLAN pada koneksi, TANPA mode tagged');
  ok(hwW.params.service === 'X_HW_SERVICELIST' && hwW.params.cos === 'X_HW_PRI', 'Huawei: ServiceList & CoS X_HW');
  ok(hwW.params.pppConnType === '', "Huawei: ConnectionType tak dipush (PPPoE ber-'IP_Routed')");
  ok(hwW.features.createNewWcd === true, 'Huawei: create = WCD baru per WAN');
  ok(hwW.features.lanBinding === true && hwW.params.lanInterface === '',
     'Huawei: binding AKTIF tapi BUKAN param string (boolean X_HW_LANBIND)');
  ok(hwW.dualStack.param === 'X_HW_IPv6Enable' && hwW.dualStack.type === 'xsd:boolean',
     'Huawei: dualstack = boolean X_HW_IPv6Enable (bukan leaf IPMode)');
  ok(getWanProfile('HG8245H', '00259E', 'Huawei Technologies Co., Ltd').template === 'X_HW',
     'Huawei: HG8245H sibling resolve sama');
  var hwS = getVendorSecurityConfig('HG8245A', '00259E', 'Huawei Technologies Co., Ltd');
  ok(hwS && hwS.passwordPath === 'PreSharedKey.1.KeyPassphrase',
     'Huawei: password SSID = PreSharedKey.1.KeyPassphrase (path bertitik, bukan leaf)');
  ok(hwS && hwS.beaconWpa === 'WPAand11i' && hwS.wpaMinimal === undefined, 'Huawei: resep STANDAR, BeaconType WPAand11i');
  ok(hwS && hwS.adminSuperPassPath === 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.Password',
     'Huawei: super admin = X_HW_WebUserInfo.2 (Support) — node baru terlihat setelah refreshObject');
  ok(hwS && hwS.adminUserPassPath === 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.Password',
     'Huawei: user admin = X_HW_WebUserInfo.1 (Admin)');
  ok(hwS && hwS.adminSuperSupported === undefined && hwS.adminUserSupported === undefined,
     'Huawei: kedua form kredensial AKTIF (username & password writable)');
  ok(getVendorSecurityConfig('F663NV9', 'EC6CB5', 'ZTE').adminSuperSupported === undefined,
     'ZTE F663NV9: super admin tetap AKTIF (byte-identik)');

  // ── F9V ETCH/FOTC: kedua PASSWORD bisa diubah (flag _writable firmware KELIRU — diuji
  //    live 2026-07-13); USERNAME DIKUNCI (2026-10-02: login web hanya Klik User/Administrator) ──
  ['ETCH', 'FOTC'].forEach(function(m) {
    var f = getVendorSecurityConfig('F9V', '', m);
    ok(f && f.adminSuperPassPath === 'InternetGatewayDevice.X_CU_Function.Web.AdminPassword'
         && f.adminSuperUserPath === 'InternetGatewayDevice.X_CU_Function.Web.AdminName',
       m + ' F9V: super admin password AdminPassword (AdminName hanya untuk tampilan)');
    ok(f && f.adminUserPassPath === 'InternetGatewayDevice.X_CU_Function.Web.UserPassword'
         && f.adminUserUserPath === 'InternetGatewayDevice.X_CU_Function.Web.UserName',
       m + ' F9V: akun USER dibuka (UserPassword — dulu salah dimatikan)');
    ok(f && f.adminUserSupported === undefined, m + ' F9V: form User Admin TIDAK disembunyikan');
    ok(f && f.adminSuperUserLocked === true && f.adminUserUserLocked === true,
       m + ' F9V: username super admin & user admin DIKUNCI');
  });

  // ── CMDC H1S-3 (1): X_CMCC (kembaran ZTE F663) — hanya entri SECURITY, WAN pakai default ──
  var cmW = getWanProfile('H1S-3', '1869DA', 'CMDC');
  ok(cmW.template === 'X_CMCC' && cmW.params.vlanId === 'X_CMCC_VLANIDMark',
     'CMDC: WAN pakai template default X_CMCC (data model sama ZTE F663 → tak perlu entri sendiri)');
  var cmS = getVendorSecurityConfig('H1S-3', '1869DA', 'CMDC');
  ok(cmS && cmS.beaconWpa === 'WPA/WPA2' && cmS.passwordPath === 'KeyPassphrase',
     'CMDC: resep security gaya ZTE (WPA/WPA2, KeyPassphrase terbaca)');
  ok(cmS && cmS.adminSuperPassPath === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password'
        && cmS.adminSuperUserPath === 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username',
     'CMDC: super admin = X_CMCC_TeleComAccount (username JUGA bisa diubah, VP universal tak bisa)');
  ok(cmS && cmS.adminUserSupported === false, 'CMDC: tak ada akun user terpisah');
  // ZTE F663 TIDAK boleh ikut ketarik entri CMDC (Tier-2 manufacturer, bukan product-only)
  ok(getVendorSecurityConfig('F663NV9', 'EC6CB5', 'ZTE').adminSuperPassPath === 'VirtualParameters.superAdmin',
     'ZTE F663NV9: super admin TETAP lewat VP universal (entri CMDC Tier-2 tak menariknya)');

  // ZTE F663 (X_CMCC) TIDAK boleh tertarik ke entri baru — byte-identik
  var f663 = getWanProfile('F663NV9', 'EC6CB5', 'ZTE');
  ok(f663.template === 'X_CMCC' && f663.params.vlanId === 'X_CMCC_VLANIDMark', 'ZTE F663NV9: tetap X_CMCC (byte-identik)');
  ok(f663.params.vlanEnable === undefined, 'ZTE F663NV9: vlanEnable ABSEN → tak ada push boolean tambahan (byte-identik)');
  var f663S = getVendorSecurityConfig('F663NV9', 'EC6CB5', 'ZTE');
  ok(f663S && f663S.beaconWpa === 'WPA/WPA2', 'ZTE F663NV9: beaconWpa tetap WPA/WPA2 (byte-identik)');

  // ZTE F650 (product-only) TETAP ADA — jangan ikut terhapus (byte-identik)
  var zteF650 = _vcfgDefaults().filter(function(e){
    return !e.manufacturer && !e.oui && /(^|,)\s*F650\s*(,|$)/i.test(e.productClasses || ''); });
  ok(zteF650.length === 1, 'ZTE: entri product-only F663/F650 tetap utuh (byte-identik)');
})();
`;

eval(settingsSrc + tests);

if (fail === 0) console.log('lulus: ' + pass + ' assertion\n✓ Profil C-DATA resolve benar & resep minimal HANYA C-DATA (ZTE utuh).');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }
