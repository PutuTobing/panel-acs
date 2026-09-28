// Uji parseWanConnections: baca VLAN/ServiceList C-DATA dari X_CT-COM
// (X_CT-COM_WANEponLinkConfig.VLANIDMark + WANPPPConnection.1.X_CT-COM_ServiceList),
// sedangkan ZTE tetap membaca X_CMCC_* (tak berubah). Memuat js/api.js asli via
// new Function (IIFE mengembalikan ACS; tak ada ref browser saat load).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');
const ACS = new Function(src + '\n; return ACS;')();

let pass = 0, fail = 0;
function ok(c, m){ if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

// Leaf GenieACS: {_value, _writable}
const L = (v) => ({ _value: v, _writable: true });

// ── C-DATA (X_CT-COM / EPON): ServiceList di bawah koneksi, VLAN di node saudara ──
const cdataRaw = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('1_TR069_INTERNET_R_VID_100'), Enable: L('True'),
    ConnectionType: L('PPPoE_Routed'), Username: L('user@sku'),
    'X_CT-COM_ServiceList': L('TR069,INTERNET'),
  } },
  'X_CT-COM_WANEponLinkConfig': { VLANIDMark: L('100'), Mode: L('2') },
} } } } } };

const c = ACS.parseWanConnections(cdataRaw);
ok(c.length === 1, 'C-DATA: 1 koneksi ter-parse');
ok(c[0] && c[0].vlanId === 100, 'C-DATA: VLAN dibaca dari X_CT-COM_WANEponLinkConfig.VLANIDMark = 100 (got ' + (c[0]&&c[0].vlanId) + ')');
ok(c[0] && c[0].vlanMode === 2, 'C-DATA: VLANMode dari EPON Mode = 2');
ok(c[0] && c[0].serviceList === 'TR069,INTERNET', 'C-DATA: ServiceList dari X_CT-COM_ServiceList');
ok(c[0] && c[0].vlanNode === 'X_CT-COM_WANEponLinkConfig', 'C-DATA EPON: vlanNode terdeteksi = WANEponLinkConfig');

// ── C-DATA varian GPON (FD512XW-R460 GPON): VLAN di X_CT-COM_WANGponLinkConfig ──
const gponRaw = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('1_TR069_INTERNET_R_VID_100'), Enable: L('True'),
    ConnectionType: L('PPPoE_Routed'), 'X_CT-COM_ServiceList': L('TR069,INTERNET'),
  } },
  'X_CT-COM_WANGponLinkConfig': { VLANIDMark: L('100'), Mode: L('2') },
} } } } } };
const g = ACS.parseWanConnections(gponRaw);
ok(g[0] && g[0].vlanId === 100, 'C-DATA GPON: VLAN dibaca dari X_CT-COM_WANGponLinkConfig.VLANIDMark = 100');
ok(g[0] && g[0].vlanNode === 'X_CT-COM_WANGponLinkConfig', 'C-DATA GPON: vlanNode terdeteksi = WANGponLinkConfig (bukan Epon)');

// ── HWTC-EPON (Realtek RTL960x): VLAN PADA koneksi (X_CT-COM_VLANIDMark), TANPA node saudara ──
// Skema ke-3: bukan X_CMCC (ZTE) & bukan node link Epon/Gpon (C-DATA/HWTC-GPON).
const hwtcEpon = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('1_TR069_INTERNET_R_VID_100'), Enable: L('True'),
    ConnectionType: L('IP_Routed'), Username: L('1000001PELANGGAN@CONTOH'),
    'X_CT-COM_ServiceList': L('TR069,INTERNET'),
    'X_CT-COM_VLANIDMark': L('100'), 'X_CT-COM_VLANMode': L('2'),
  } },
  WANEthernetLinkConfig: {},   // ada tapi TANPA VLANIDMark (bukan pembawa VLAN)
} } } } } };
const he = ACS.parseWanConnections(hwtcEpon)[0];
ok(he && he.vlanId === 100, 'HWTC-EPON: VLAN dibaca dari X_CT-COM_VLANIDMark PADA koneksi = 100 (got ' + (he&&he.vlanId) + ')');
ok(he && he.vlanMode === 2, 'HWTC-EPON: VLANMode dari X_CT-COM_VLANMode = 2');
ok(he && he.vlanNode === null, 'HWTC-EPON: vlanNode null (tak ada node saudara Epon/Gpon)');
ok(he && he.vlanOnConn === 'X_CT-COM', 'HWTC-EPON: vlanOnConn=X_CT-COM (penulis push VLAN ke koneksi, bukan node)');
ok(he && he.serviceList === 'TR069,INTERNET', 'HWTC-EPON: ServiceList dari X_CT-COM_ServiceList');

// ── HWTC-EPON NYATA: X_CT-COM_VLANIDMark ADA tapi KOSONG (node tanpa _value walau di-Summon) ──
// Firmware Realtek tak pernah melaporkan nilai VLAN → satu-satunya sumber = VID di Name
// ('..._R_VID_100'), sama seperti yang tampil di GenieACS. Fallback Name harus mengisi 100.
const hwtcEmptyVlan = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('1_TR069_INTERNET_R_VID_100'), Enable: L('True'),
    'X_CT-COM_ServiceList': L('TR069,INTERNET'),
    'X_CT-COM_VLANIDMark': { _writable: true },   // node KOSONG (tanpa _value) — seperti live pasca-Summon
    'X_CT-COM_VLANMode':   { _writable: true },
  } },
} } } } } };
const hev = ACS.parseWanConnections(hwtcEmptyVlan)[0];
ok(hev && hev.vlanId === 100, 'HWTC-EPON: VLAN kosong di param → fallback VID dari Name = 100 (got ' + (hev&&hev.vlanId) + ')');
ok(hev && hev.vlanOnConn === 'X_CT-COM', 'HWTC-EPON: vlanOnConn tetap X_CT-COM (key VLANIDMark ada walau kosong)');

// ── ZTE tanpa VLAN & Name generik (tanpa _VID_) → tetap 0 (fallback Name tak salah picu) ──
const zteGenericName = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': { Name: L('INTERNET'), Enable: L('True') } },
} } } } } };
const zgn = ACS.parseWanConnections(zteGenericName)[0];
ok(zgn && zgn.vlanId === 0, 'Fallback aman: Name tanpa _VID_ → vlanId tetap 0 (tak salah picu)');

// ── C-DATA binding LAN/SSID via X_CT-COM_LanInterface (format = X_CMCC: daftar path) ──
const bindRaw = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('1_TR069_INTERNET'), Enable: L('True'),
    'X_CT-COM_ServiceList': L('TR069,INTERNET'),
    'X_CT-COM_LanInterface': L('InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,InternetGatewayDevice.LANDevice.1.WLANConfiguration.3'),
    'X_CT-COM_LanInterface-DHCPEnable': L('True'),
  } },
  'X_CT-COM_WANEponLinkConfig': { VLANIDMark: L('100'), Mode: L('2') },
} } } } } };
const bc = ACS.parseWanConnections(bindRaw)[0];
ok(bc && bc.lanInterface.indexOf('LANEthernetInterfaceConfig.1') >= 0 && bc.lanInterface.indexOf('WLANConfiguration.3') >= 0,
   'C-DATA: lanInterface dibaca dari X_CT-COM_LanInterface (eth1 + wlan3, verifikasi live DF1D)');
ok(bc && bc.dhcpEnabled === true, 'C-DATA: dhcpEnabled dibaca dari X_CT-COM_LanInterface-DHCPEnable');

// ── C-DATA IPv6/dualstack: ipMode + status/alamat via X_CT-COM_* (fallback dari X_CMCC) ──
const v6Raw = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('3_INTERNET'), Enable: L('True'), 'X_CT-COM_ServiceList': L('INTERNET'),
    'X_CT-COM_IPMode': L('3'),
    'X_CT-COM_IPv6ConnStatus': L('Connected'),
    'X_CT-COM_IPv6IPAddress': L('2001:df6:ac40:f100:525b:1dff:fed3:5495'),
    'X_CT-COM_IPv6Prefix': L('2001:df6:ac40:f097::/64'),
    'X_CT-COM_IPv6IPAddressOrigin': L('AutoConfigured'),
    'X_CT-COM_IPv6PrefixOrigin': L('PrefixDelegation'),
  } },
  'X_CT-COM_WANEponLinkConfig': { VLANIDMark: L('100'), Mode: L('2') },
} } } } } };
const v6 = ACS.parseWanConnections(v6Raw)[0];
ok(v6 && v6.ipMode === 3, 'C-DATA: ipMode=3 dibaca dari X_CT-COM_IPMode (>=2 → seksi IPv6 tampil)');
ok(v6 && v6.ipv6ConnStatus === 'Connected', 'C-DATA: ipv6ConnStatus dari X_CT-COM_IPv6ConnStatus');
ok(v6 && v6.ipv6Ip.indexOf('2001:df6') === 0, 'C-DATA: ipv6Ip dari X_CT-COM_IPv6IPAddress');
ok(v6 && v6.ipv6Prefix.indexOf('/64') > 0, 'C-DATA: ipv6Prefix dari X_CT-COM_IPv6Prefix');
// ZTE tetap baca X_CMCC_IPMode (byte-identik)
const zv6 = ACS.parseWanConnections({ InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': { Name: L('INTERNET'), Enable: L('True'), 'X_CMCC_IPMode': L('3'), 'X_CMCC_IPv6IPAddress': L('2401::1') } },
} } } } } })[0];
ok(zv6 && zv6.ipMode === 3 && zv6.ipv6Ip === '2401::1', 'ZTE: ipMode/ipv6Ip tetap dari X_CMCC (byte-identik)');

// ── ZTE (X_CMCC): VLAN di bawah koneksi — harus tetap dipakai, TIDAK jatuh ke EPON ──
const zteRaw = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('INTERNET'), Enable: L('True'), ConnectionType: L('PPPoE_Routed'),
    'X_CMCC_ServiceList': L('INTERNET'),
    'X_CMCC_VLANIDMark': L('170'), 'X_CMCC_VLANMode': L('2'),
  } },
} } } } } };

const z = ACS.parseWanConnections(zteRaw);
ok(z.length === 1, 'ZTE: 1 koneksi ter-parse');
ok(z[0] && z[0].vlanId === 170, 'ZTE: VLAN tetap dari X_CMCC_VLANIDMark = 170 (tak berubah)');
ok(z[0] && z[0].serviceList === 'INTERNET', 'ZTE: ServiceList tetap dari X_CMCC_ServiceList');

// ── ZTE tanpa EPON node & tanpa VLAN → default 0 (tak crash) ──
const zteNoVlan = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': { Name: L('INTERNET'), Enable: L('True') } },
} } } } } };
const z2 = ACS.parseWanConnections(zteNoVlan);
ok(z2[0] && z2[0].vlanId === 0, 'Fallback aman: tanpa VLAN & tanpa EPON → 0');

// ── SKEMA E — X_CU (F9V ETCH/FOTC): VLAN = leaf X_CU_VLAN di WANConnectionDevice ──
const cuRaw = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  'X_CU_VLAN': L('100'), 'X_CU_VLANEnabled': L('True'),
  WANPPPConnection: { '1': {
    Name: L('1_TR069_INTERNET_R_VID_100'), Enable: L('True'), ConnectionType: L('IP_Routed'),
    'X_CU_ServiceList': L('TR069,INTERNET'), 'X_CU_IPMode': L('3'),
    'X_CU_IPv6ConnStatus': L('Connected'), 'X_CU_LanInterface': L('LAN1'),
    Username: L('1000002PELANGGAN@CONTOH'),
  } },
} } } } } };
const cu = ACS.parseWanConnections(cuRaw);
ok(cu.length === 1, 'X_CU: 1 koneksi ter-parse');
ok(cu[0].vlanId === 100, 'X_CU: VLAN 100 dibaca dari leaf WCD X_CU_VLAN');
ok(cu[0].vlanOnWcd === 'X_CU', 'X_CU: conn.vlanOnWcd ditandai (penulis push ke base WCD)');
ok(cu[0].vlanNode == null && cu[0].vlanOnConn == null, 'X_CU: bukan node saudara & bukan VLAN-pada-koneksi');
ok(cu[0].serviceList === 'TR069,INTERNET', 'X_CU: ServiceList dari X_CU_ServiceList');
ok(cu[0].ipMode === 3, 'X_CU: ipMode dari X_CU_IPMode');
ok(cu[0].ipv6ConnStatus === 'Connected', 'X_CU: status IPv6 dari X_CU_IPv6ConnStatus');
ok(cu[0].lanInterface === 'LAN1', 'X_CU: binding LAN dari X_CU_LanInterface');
// X_CU tanpa leaf VLAN → fallback VID dari Name (skema D) tetap jalan
const cuNoLeaf = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': { Name: L('1_INTERNET_R_VID_852'), Enable: L('True') } },
} } } } } };
ok(ACS.parseWanConnections(cuNoLeaf)[0].vlanId === 852, 'X_CU: tanpa leaf VLAN → fallback VID dari Name');
// ZTE tak boleh ikut ter-tandai vlanOnWcd
ok(z[0].vlanOnWcd == null, 'ZTE: vlanOnWcd null (byte-identik)');

// ── ZTE F679L: TABEL Port Binding (X_ZTE-COM_PortBinding) → conn.lanInterface ──
// Binding di F679L bukan param dalam koneksi, melainkan tabel root yang memetakan
// WANInterface → daftar LANInterface (menu "Port Binding" di web ONU).
const PB_WAN = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';
const PB_LAN = 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,'
             + 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5';
const zlRaw = { InternetGatewayDevice: {
  'X_ZTE-COM_PortBinding': { '1': { WANInterface: L(PB_WAN), LANInterface: L(PB_LAN) } },
  WANDevice: { '1': { WANConnectionDevice: { '1': {
    WANPPPConnection: { '1': { Name: L('INTERNET'), Enable: L('True'),
      'X_ZTE-COM_ServiceList': L('INTERNET'), 'X_ZTE-COM_VLANID': L('100'), 'X_ZTE-COM_VLANEnable': L('True') } },
    WANIPConnection:  { '1': { Name: L('TR69'), Enable: L('True'),
      'X_ZTE-COM_ServiceList': L('TR069'), 'X_ZTE-COM_VLANID': L('170') } },
  } } } },
} };
const zlc = ACS.parseWanConnections(zlRaw);
const zlPpp = zlc.find(c => c.type === 'ppp');
const zlIp  = zlc.find(c => c.type === 'ip');
ok(zlPpp && zlPpp.lanInterface === PB_LAN, 'F679L: lanInterface diisi dari tabel Port Binding');
ok(zlPpp && zlPpp.portBindingIdx === 1,    'F679L: portBindingIdx = indeks entri tabel (alamat tulis)');
ok(zlIp  && zlIp.lanInterface === '',      'F679L: koneksi TR069 tanpa entri tabel → binding kosong');
ok(zlIp  && zlIp.portBindingIdx == null,   'F679L: tanpa entri tabel → portBindingIdx absen (UI akan addObject)');
ok(ACS.mapDevice(zlRaw).portBindingRoot === 'InternetGatewayDevice.X_ZTE-COM_PortBinding',
   'F679L: portBindingRoot diekspos ke penulis binding');
// ZTE F663 & C-DATA: tak punya tabel → tak ada efek (byte-identik)
ok(z[0].portBindingIdx == null && z[0].lanInterface === '', 'ZTE F663: tanpa tabel Port Binding → binding tak tersentuh');
ok(ACS.mapDevice(cdataRaw).portBindingRoot === null, 'C-DATA: portBindingRoot null');

// ── Huawei HG8245A (X_HW): VLAN pada koneksi, binding BOOLEAN, IPv6 sub-tabel ──
const hwRaw = { InternetGatewayDevice: { WANDevice: { '1': { WANConnectionDevice: { '1': {
  WANPPPConnection: { '1': {
    Name: L('1_INTERNET_R_VID_100'), Enable: L('True'), ConnectionType: L('IP_Routed'),
    'X_HW_SERVICELIST': L('INTERNET'), 'X_HW_VLAN': L('100'), 'X_HW_PRI': L('0'),
    'X_HW_IPv4Enable': L('True'), 'X_HW_IPv6Enable': L('True'),
    'X_HW_IPv6': { IPv6Address: { '1': { IPAddress: L('2001:df6::1') } },
                   IPv6Prefix:  { '1': { Prefix:    L('2001:df6:ac40::/64') } } },
    'X_HW_LANBIND': { Lan1Enable: L('True'),  Lan2Enable: L('False'),
                      Lan3Enable: L('False'), Lan4Enable: L('False'),
                      SSID1Enable: L('True'), SSID2Enable: L('False'),
                      SSID3Enable: L('False'), SSID4Enable: L('False') },
  } },
} } } } } };
const hw = ACS.parseWanConnections(hwRaw)[0];
ok(hw && hw.vlanId === 100, 'Huawei: VLAN dari X_HW_VLAN (bukan fallback nama)');
ok(hw && hw.serviceList === 'INTERNET', 'Huawei: ServiceList dari X_HW_SERVICELIST');
ok(hw && hw.ipMode === 3, 'Huawei: dualstack dari PASANGAN boolean IPv4Enable+IPv6Enable → 3');
ok(hw && hw.ipv6Ip === '2001:df6::1', 'Huawei: alamat IPv6 dari sub-tabel X_HW_IPv6.IPv6Address.1');
ok(hw && hw.ipv6Prefix === '2001:df6:ac40::/64', 'Huawei: prefix PD dari X_HW_IPv6.IPv6Prefix.1');
ok(hw && hw.lanBindNode === 'X_HW_LANBIND', 'Huawei: binding = sub-node boolean (alamat tulis)');
ok(hw && hw.lanInterface === 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,'
       + 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1',
   'Huawei: boolean per port diterjemahkan ke string path (UI binding dipakai ulang)');
ok(hw && hw.lanBindSlots.eth.length === 4 && hw.lanBindSlots.wlan.length === 4,
   'Huawei: slot binding terbaca dari perangkat (4 LAN + 4 SSID)');
// Vendor lain tak ikut ter-tandai
ok(z[0].lanBindNode == null, 'ZTE F663: lanBindNode ABSEN (binding tetap via string param)');

if (fail === 0) console.log('lulus: ' + pass + ' assertion\n✓ Pembacaan WAN VLAN/ServiceList: C-DATA via X_CT-COM, ZTE via X_CMCC (utuh); tabel Port Binding F679L.');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }
