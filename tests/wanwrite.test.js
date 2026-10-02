// Uji mapping TULIS WAN C-DATA (getWanProfile) + simulasi base VLAN node-saudara.
// C-DATA: template X_CT-COM, service=X_CT-COM_ServiceList, VLAN=VLANIDMark di
// X_CT-COM_WANEponLinkConfig, MTU dikosongkan, create dimatikan. ZTE tak berubah.
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
  // ── C-DATA WAN profile ──
  var p = getWanProfile('FD514GD-R460', '505B1D', 'CDTC');
  ok(p.template === 'X_CT-COM', 'C-DATA: template X_CT-COM (got ' + p.template + ')');
  ok(p.matched === true, 'C-DATA: matched=true');
  ok(p.params.service === 'X_CT-COM_ServiceList', 'C-DATA: service=X_CT-COM_ServiceList');
  ok(p.params.vlanId === 'VLANIDMark', 'C-DATA: vlanId param=VLANIDMark');
  ok(p.params.vlanMode === 'Mode', 'C-DATA: vlanMode param=Mode');
  ok(p.vlanNode === 'X_CT-COM_WANEponLinkConfig', 'C-DATA: vlanNode di-set (VLAN node saudara)');
  ok(p.params.mtuPpp === '', 'C-DATA: mtuPpp DIKOSONGKAN (tak dipush)');
  ok(p.params.pppConnType === '', 'C-DATA: pppConnType DIKOSONGKAN (ConnectionType=PPPoE_Routed picu 9007 di FD512XW → jangan push)');
  ok(p.params.pppUser === 'Username', 'C-DATA: pppUser=Username (dari template)');
  ok(p.params.pppPass === 'Password', 'C-DATA: pppPass=Password');
  ok(p.features.canAddDelete === true, 'C-DATA: create/delete WAN AKTIF');
  ok(p.features.createNewWcd === true, 'C-DATA: model create = WANConnectionDevice baru');
  // Binding LAN/SSID: C-DATA pakai X_CT-COM_LanInterface (dikonfirmasi user)
  ok(p.params.lanInterface === 'X_CT-COM_LanInterface', 'C-DATA: lanInterface=X_CT-COM_LanInterface (binding)');
  ok(p.params.lanDhcpEnable === 'X_CT-COM_LanInterface-DHCPEnable', 'C-DATA: lanDhcpEnable=X_CT-COM_LanInterface-DHCPEnable');
  // IPv6/IPMode di form EDIT dipetakan ke X_CT-COM (terverifikasi writable DF1D)
  ok(p.params.ipMode === 'X_CT-COM_IPMode', 'C-DATA edit: ipMode=X_CT-COM_IPMode');
  ok(p.params.ipv6AddrOrigin === 'X_CT-COM_IPv6IPAddressOrigin', 'C-DATA edit: ipv6AddrOrigin=X_CT-COM_IPv6IPAddressOrigin (SLAAC)');
  ok(p.params.ipv6PrefixOrigin === 'X_CT-COM_IPv6PrefixOrigin', 'C-DATA edit: ipv6PrefixOrigin=X_CT-COM_IPv6PrefixOrigin');
  ok(p.params.ipv6Dns === 'X_CT-COM_IPv6DNSServers', 'C-DATA edit: ipv6Dns=X_CT-COM_IPv6DNSServers');

  // Simulasi base VLAN NODE-TERDETEKSI per-perangkat (logika device-detail: conn.vlanNode||prof.vlanNode).
  var basePath = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';
  // (a) unit EPON: conn.vlanNode terdeteksi 'X_CT-COM_WANEponLinkConfig'
  var eponNode = 'X_CT-COM_WANEponLinkConfig';
  var vlanBaseE = basePath.replace(/\\.(WANPPPConnection|WANIPConnection)\\.\\d+$/, '.') + (eponNode || p.vlanNode) + '.';
  ok((vlanBaseE + p.params.vlanId) === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_CT-COM_WANEponLinkConfig.VLANIDMark',
     'C-DATA EPON: path VLAN ke WANEponLinkConfig');
  // (b) unit GPON: conn.vlanNode terdeteksi 'X_CT-COM_WANGponLinkConfig' → path ikut Gpon
  var gponNode = 'X_CT-COM_WANGponLinkConfig';
  var vlanBaseG = basePath.replace(/\\.(WANPPPConnection|WANIPConnection)\\.\\d+$/, '.') + (gponNode || p.vlanNode) + '.';
  ok((vlanBaseG + p.params.vlanId) === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_CT-COM_WANGponLinkConfig.VLANIDMark',
     'C-DATA GPON: path VLAN ke WANGponLinkConfig (varian GPON FD512XW)');
  // (c) fallback default profil (tanpa deteksi) = EPON
  ok(p.vlanNode === 'X_CT-COM_WANEponLinkConfig', 'C-DATA: vlanNode default profil = EPON (fallback create)');

  // Simulasi konstruksi path alur CREATE (WANConnectionDevice baru): index WCD & koneksi
  // ditentukan ONU (mis. WCD baru=2, koneksi=1). Logika device-detail _wanDoCreateNewWcd.
  var wcdParent = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice';
  var newWcdIdx = 2, newConnIdx = 1, connChild = 'WANPPPConnection';
  var connBase = wcdParent + '.' + newWcdIdx + '.' + connChild + '.' + newConnIdx + '.';
  var vlanBaseC = wcdParent + '.' + newWcdIdx + '.' + p.vlanNode + '.';
  ok(connBase === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.',
     'C-DATA create: connBase di WCD baru benar');
  ok((connBase + p.params.service) === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.X_CT-COM_ServiceList',
     'C-DATA create: ServiceList ke koneksi WCD baru');
  ok((vlanBaseC + p.params.vlanId) === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.X_CT-COM_WANEponLinkConfig.VLANIDMark',
     'C-DATA create: VLAN ke EPON WCD baru (independen dari WCD.1)');

  // ── Dualstack (X_CT-COM_IPMode=3) — field best-effort khusus C-DATA ──
  ok(p.dualStack && p.dualStack.param === 'X_CT-COM_IPMode', 'C-DATA: dualStack.param = X_CT-COM_IPMode');
  ok(p.dualStack.value === 3, 'C-DATA: dualStack.value = 3 (IPv4/IPv6)');
  // path push IPMode ke bawah koneksi WCD baru (bukan node EPON)
  ok((connBase + p.dualStack.param) === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.X_CT-COM_IPMode',
     'C-DATA create: IPMode dipush ke koneksi (WANPPPConnection), bukan EPON');

  // ── SLAAC (IPv6 stateless) — daftar param terpisah dari IPMode ──
  ok(Array.isArray(p.dualStack.slaac) && p.dualStack.slaac.length === 2, 'C-DATA: dualStack.slaac = 2 param');
  ok(p.dualStack.slaac[0][0] === 'X_CT-COM_IPv6IPAddressOrigin' && p.dualStack.slaac[0][1] === 'AutoConfigured',
     'C-DATA SLAAC: IPAddressOrigin=AutoConfigured (SLAAC, bukan DHCPv6 stateful)');
  ok(p.dualStack.slaac[1][0] === 'X_CT-COM_IPv6PrefixOrigin' && p.dualStack.slaac[1][1] === 'PrefixDelegation',
     'C-DATA SLAAC: PrefixOrigin=PrefixDelegation (DHCPv6-PD)');
  // path SLAAC juga ke bawah koneksi
  var slaacPaths = p.dualStack.slaac.map(function(s){ return connBase + s[0]; });
  ok(slaacPaths[0] === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.X_CT-COM_IPv6IPAddressOrigin',
     'C-DATA SLAAC: path IPAddressOrigin ke koneksi WCD baru');

  // ── Simulasi logika DELETE (device-detail _wanHandleDelete) ──
  // C-DATA (vlanNode + createNewWcd) → hapus SELURUH WANConnectionDevice (VLAN ikut).
  var connPath = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1';
  var isCdata = !!(p.vlanNode && p.features && p.features.createNewWcd);
  var delPath = isCdata ? connPath.replace(/\\.(WANPPPConnection|WANIPConnection)\\.\\d+$/, '') : connPath;
  ok(delPath === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2',
     'C-DATA delete: target = WANConnectionDevice.2 (hapus WCD penuh → VLAN node saudara ikut terhapus)');

  // FD512XW-R460 sibling → profil sama
  var p2 = getWanProfile('FD512XW-R460', '505B1D', 'CDTC');
  ok(p2.template === 'X_CT-COM' && p2.vlanNode === 'X_CT-COM_WANEponLinkConfig', 'C-DATA: FD512XW-R460 resolve sama');

  // ── HWTC ZL-2113X: profil X_CT-COM (spt C-DATA) tapi ZL-2113X punya 2 firmware ──
  var h = getWanProfile('ZL-2113X', 'HWTC', 'HWTC');
  ok(h.template === 'X_CT-COM', 'HWTC: template X_CT-COM (got ' + h.template + ')');
  ok(h.params.vlanId === 'VLANIDMark', 'HWTC: vlanId param=VLANIDMark (untuk node saudara GPON)');
  ok(h.vlanNode === 'X_CT-COM_WANGponLinkConfig', 'HWTC: vlanNode default = GPON');
  ok(h.features.canAddDelete === true, 'HWTC: create/delete WAN AKTIF');
  ok(h.features.createNewWcd === true, 'HWTC: model create = WANConnectionDevice baru');
  ok(h.dualStack && h.dualStack.param === 'X_CT-COM_IPMode', 'HWTC: dualStack IPMode=3 (best-effort saat create)');
  // (a) firmware GPON: conn.vlanNode terdeteksi Gpon, conn.vlanOnConn null → node saudara
  var hBase = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';
  var hVlanOnConnG = null, hVlanNodeG = 'X_CT-COM_WANGponLinkConfig';
  var hNodeG = hVlanOnConnG ? null : (hVlanNodeG || h.vlanNode);
  var hBaseG = hNodeG ? hBase.replace(/\\.(WANPPPConnection|WANIPConnection)\\.\\d+$/, '.') + hNodeG + '.' : hBase + '.';
  var hIdNameG = hVlanOnConnG ? hVlanOnConnG + '_VLANIDMark' : h.params.vlanId;
  ok((hBaseG + hIdNameG) === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_CT-COM_WANGponLinkConfig.VLANIDMark',
     'HWTC-GPON: VLAN push ke node saudara Gpon');
  // (b) firmware EPON (Realtek): conn.vlanOnConn='X_CT-COM' → ABAIKAN vlanNode, push ke koneksi
  var hVlanOnConnE = 'X_CT-COM', hVlanNodeE = null;
  var hNodeE = hVlanOnConnE ? null : (hVlanNodeE || h.vlanNode);
  var hBaseE = hNodeE ? hBase.replace(/\\.(WANPPPConnection|WANIPConnection)\\.\\d+$/, '.') + hNodeE + '.' : hBase + '.';
  var hIdNameE = hVlanOnConnE ? hVlanOnConnE + '_VLANIDMark' : h.params.vlanId;
  ok((hBaseE + hIdNameE) === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CT-COM_VLANIDMark',
     'HWTC-EPON: vlanOnConn menang → VLAN push ke KONEKSI (X_CT-COM_VLANIDMark), BUKAN node saudara');

  // ── HWTC CREATE (_wanDoCreateNewWcd): VLAN WAN baru per SKEMA perangkat ──
  var wcdParent = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice';
  var newWcd = '2', newConnIdx = '1';
  var connBase = wcdParent + '.' + newWcd + '.WANPPPConnection.' + newConnIdx + '.';
  // (a) GPON create: devVlanOnConn null → VLAN ke node saudara WCD baru
  var cDevOnConnG = null, cDevNodeG = 'X_CT-COM_WANGponLinkConfig';
  var cGpath = cDevOnConnG
    ? connBase + cDevOnConnG + '_VLANIDMark'
    : wcdParent + '.' + newWcd + '.' + (cDevNodeG || h.vlanNode) + '.' + h.params.vlanId;
  ok(cGpath === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.X_CT-COM_WANGponLinkConfig.VLANIDMark',
     'HWTC-GPON create: VLAN → node saudara WCD baru (WANGponLinkConfig)');
  // (b) EPON create: devVlanOnConn='X_CT-COM' → VLAN ke KONEKSI baru
  var cDevOnConnE = 'X_CT-COM';
  var cEpath = cDevOnConnE
    ? connBase + cDevOnConnE + '_VLANIDMark'
    : wcdParent + '.' + newWcd + '.' + h.vlanNode + '.' + h.params.vlanId;
  ok(cEpath === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.X_CT-COM_VLANIDMark',
     'HWTC-EPON create: VLAN → koneksi baru (X_CT-COM_VLANIDMark), bukan node saudara');

  // ── ZTE: tak berubah (template X_CMCC, VLAN di bawah koneksi, tanpa vlanNode) ──
  var z = getWanProfile('F663NV9', 'EC6CB5', 'ZTE');
  ok(z.template === 'X_CMCC', 'ZTE: template X_CMCC (tak berubah)');
  ok(z.params.vlanId === 'X_CMCC_VLANIDMark', 'ZTE: vlanId=X_CMCC_VLANIDMark');
  ok(z.vlanNode == null, 'ZTE: vlanNode ABSEN → VLAN di base koneksi (byte-identik)');
  ok(z.dualStack == null, 'ZTE: dualStack ABSEN → tak ada push IPMode terpisah (byte-identik)');
  // ZTE delete: TIDAK createNewWcd → hapus koneksi apa adanya (byte-identik)
  var zConn = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2';
  var zIsCdata = !!(z.vlanNode && z.features && z.features.createNewWcd);
  var zDel = zIsCdata ? zConn.replace(/\\.(WANPPPConnection|WANIPConnection)\\.\\d+$/, '') : zConn;
  ok(zDel === zConn, 'ZTE delete: target = koneksi (WANPPPConnection.2), WCD utuh (byte-identik)');
  ok(z.features.canAddDelete === true, 'ZTE: create/delete tetap aktif');
  ok(z.params.mtuPpp === 'MaxMRUSize', 'ZTE: MTU tetap dipush (MaxMRUSize)');

  // ── Jaring pengaman create: perangkat X_CT-COM + profil generik → HARUS BATAL ──
  // Menyalin logika gate di _wanHandleSave (device-detail.js): penanda skema diambil
  // dari KONEKSI perangkat (vlanNode/vlanOnConn), bukan dari profil.
  function guardBlocks(conns, prof) {
    var devCtCom = conns.some(function(c){ return c && (c.vlanNode || c.vlanOnConn || c.vlanOnWcd); });
    return devCtCom && !(prof && prof.features && prof.features.createNewWcd);
  }
  var ctComConns = [{ vlanNode: 'X_CT-COM_WANGponLinkConfig', vlanOnConn: null }];  // CIOT/ZICG/HWTC-GPON
  var eponConns  = [{ vlanNode: null, vlanOnConn: 'X_CT-COM' }];                    // HWTC-EPON
  var zteConns   = [{ vlanNode: null, vlanOnConn: null }];                          // ZTE
  // Profil generik lama (product-only GM220-S) = X_CMCC tanpa createNewWcd
  var genericGm = getWanProfile('GM220-S', '', '');
  ok(!(genericGm.features && genericGm.features.createNewWcd), 'Generik GM220-S: createNewWcd ABSEN (jalur X_CMCC lama)');
  ok(guardBlocks(ctComConns, genericGm) === true,
     'GUARD: ONU X_CT-COM + profil generik → create DIBATALKAN (tak menyisakan koneksi kosong)');
  ok(guardBlocks(eponConns, genericGm) === true,
     'GUARD: ONU HWTC-EPON (VLAN pada koneksi) + profil generik → create DIBATALKAN');
  // Profil vendor yang benar → guard TIDAK menghalangi
  ok(guardBlocks(ctComConns, getWanProfile('GM220-S', '1C25E1', 'CIOT')) === false, 'GUARD: CIOT profil benar → create LANJUT');
  ok(guardBlocks(ctComConns, getWanProfile('GM220-S', 'ZICG',   'ZICG')) === false, 'GUARD: ZICG profil benar → create LANJUT');
  ok(guardBlocks(eponConns,  getWanProfile('ZL-2113X','HWTC',   'HWTC')) === false, 'GUARD: HWTC profil benar → create LANJUT');
  // ZTE: tak punya penanda X_CT-COM → guard TIDAK PERNAH aktif (byte-identik)
  ok(guardBlocks(zteConns, z) === false, 'GUARD: ZTE tak tersentuh (vlanNode/vlanOnConn null) — byte-identik');
  ok(guardBlocks([], z) === false, 'GUARD: perangkat tanpa koneksi terbaca → tak diblokir');

  // ── SKEMA E — X_CU (F9V ETCH/FOTC): VLAN = LEAF di WANConnectionDevice ──
  var cu = getWanProfile('F9V', '78C1A7', 'ETCH');
  ok(cu.template === 'X_CU', 'F9V ETCH: template X_CU (bukan X_CMCC ZTE)');
  ok(cu.vlanOnWcd === true, 'F9V: vlanOnWcd=true (VLAN di base WCD)');
  ok(cu.vlanNode == null, 'F9V: TANPA vlanNode (bukan node saudara PON)');
  ok(cu.params.vlanId === 'X_CU_VLAN', 'F9V: vlanId=X_CU_VLAN');
  ok(cu.params.vlanMode === '', 'F9V: vlanMode KOSONG (X_CU_VLANEnabled = enable, bukan mode) → tak dipush');
  ok(cu.params.service === 'X_CU_ServiceList', 'F9V: service=X_CU_ServiceList');
  ok(cu.params.mtuPpp === '' && cu.params.pppConnType === '', 'F9V: MTU & pppConnType tak dipush');
  ok(getWanProfile('F9V', '78C1A7', 'FOTC').template === 'X_CU', 'F9V FOTC: entri kembar resolve sama');
  // C4 (2026-10-02): X_CU_LanInterface-DHCPEnable ada di 0/26 koneksi WAN (15 unit).
  ok(cu.params.lanDhcpEnable === '' && getWanProfile('F9V', '78C1A7', 'FOTC').params.lanDhcpEnable === '',
     'F9V ETCH & FOTC: lanDhcpEnable KOSONG (param tak ada di ONU → tak pernah dikirim)');
  ok(cu.params.lanInterface === 'X_CU_LanInterface', 'F9V: binding tetap X_CU_LanInterface (ada 26/26)');
  ok(cu.features.createNewWcd === true, 'F9V: create = WCD baru');

  // EDIT: base VLAN = base WCD (segmen koneksi dipangkas), bukan node saudara/koneksi.
  var cuConn = { basePath: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1',
                 vlanNode: null, vlanOnConn: null, vlanOnWcd: 'X_CU' };
  var cuWcdBase = cuConn.basePath.replace(/\\.(WANPPPConnection|WANIPConnection)\\.\\d+$/, '.');
  var cuVlanNode = (cuConn.vlanOnConn || cuConn.vlanOnWcd) ? null : (cuConn.vlanNode || cu.vlanNode);
  var cuVlanBase = cuVlanNode ? cuWcdBase + cuVlanNode + '.' : (cuConn.vlanOnWcd ? cuWcdBase : cuConn.basePath + '.');
  ok(cuVlanBase + cu.params.vlanId === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_CU_VLAN',
     'F9V edit: VLAN → WANConnectionDevice.1.X_CU_VLAN (leaf di WCD)');
  // CREATE: VLAN → leaf di WCD BARU
  ok('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.' + cu.params.vlanId
     === 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.X_CU_VLAN',
     'F9V create: VLAN → WCD baru .X_CU_VLAN');
  // Guard: F9V ONU + profil generik ZTE (X_CMCC) → create DIBATALKAN
  ok(guardBlocks([{ vlanNode:null, vlanOnConn:null, vlanOnWcd:'X_CU' }], getWanProfile('F9V','','')) === true,
     'GUARD: ONU X_CU + profil generik → create DIBATALKAN');
  ok(guardBlocks([{ vlanNode:null, vlanOnConn:null, vlanOnWcd:'X_CU' }], cu) === false,
     'GUARD: F9V profil benar → create LANJUT');
  // C-DATA & ZTE tak boleh ikut punya vlanOnWcd
  ok(getWanProfile('FD514GD-R460','505B1D','CDTC').vlanOnWcd == null, 'C-DATA: vlanOnWcd ABSEN (tetap node saudara)');
  ok(z.vlanOnWcd == null, 'ZTE: vlanOnWcd ABSEN (byte-identik)');

  // ── C-DATA: WAN IPoE baru HARUS 'IP_Routed' (2026-10-03, FD512XW SN CDTC1DD3548E) ──
  // WANIPConnection hasil addObject lahir 'IP_Bridged' → WAN TR069 dari panel tampil "Bridge".
  ['FD512XW-R460', 'FD514GD-R460'].forEach(function(pc) {
    var c = getWanProfile(pc, '505B1D', 'CDTC');
    ok(c.createConnType && c.createConnType.ip === 'IP_Routed', pc + ': Buat WAN IP → ConnectionType IP_Routed dikirim dulu');
    ok(c.createConnType.ppp === undefined && c.createConnType.pppBridged === undefined && c.params.pppConnType === '',
       pc + ': PPPoE tidak disentuh (ConnectionType PPP tetap tak dipush)');
  });
  ok(getWanProfile('F663NV9','EC6CB5','ZTE').createConnType == null, 'ZTE F663NV9: tanpa createConnType (byte-identik)');
  ok(getWanProfile('ZL-2113X','HWTC','HWTC').createConnType == null, 'HWTC ZL-2113X: tidak ikut berubah');
  // GUA From = Auto khusus C-DATA (uji operator 2026-10-03)
  ok(getWanProfile('FD512XW-R460','505B1D','CDTC').ipv6GuaAuto === true && getWanProfile('FD514GD-R460','505B1D','CDTC').ipv6GuaAuto === true,
     'C-DATA: ipv6GuaAuto');
  ok(!getWanProfile('F663NV9','EC6CB5','ZTE').ipv6GuaAuto && !getWanProfile('ZL-2113X','HWTC','HWTC').ipv6GuaAuto
     && !getWanProfile('F9V','78C1A7','FOTC').ipv6GuaAuto, 'vendor lain: form Edit tetap mengikuti nilai ONU');
})();
`;

eval(settingsSrc + tests);

if (fail === 0) console.log('lulus: ' + pass + ' assertion\n✓ Mapping tulis WAN C-DATA benar (VLAN node-saudara; create = WCD baru); ZTE utuh.');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }
