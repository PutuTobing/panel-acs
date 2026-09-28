// Uji generateConnectionGroups: C-DATA (tanpa TotalAssociations) → satu grup WiFi
// gabungan dari Hosts.Host; ZTE (punya TotalAssociations) → distribusi per-SSID lama.
// Eval fungsi asli (is5GHz + generateConnectionGroups) dari device-detail.js.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'device-detail.js'), 'utf8');

function fn(name) {
  var m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('tak ketemu: ' + name);
  return m[0];
}
const code = fn('is5GHz') + '\n' + fn('generateConnectionGroups')
  + '\nmodule.exports={generateConnectionGroups:generateConnectionGroups};';
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const { generateConnectionGroups } = mod.exports;

let pass = 0, fail = 0;
function ok(c, m){ if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

// ── C-DATA: 2 SSID aktif, associations=0 (tak ada TotalAssociations), 3 klien WiFi ──
const cdata = {
  ssids: [
    { idx: 1, name: 'ELANG RACING 5G', enabled: true, associations: 0, standard: 'ac', channel: 255 },
    { idx: 6, name: 'CINTA JAYA',      enabled: true, associations: 0, standard: '',   channel: 0 },
  ],
  hostList: [
    { name: 'itel', ip: '192.168.101.5', mac: 'aa:bb:cc:00:00:01', type: '802.11' },
    { name: 'vivo', ip: '192.168.101.2', mac: 'aa:bb:cc:00:00:02', type: '802.11' },
    { name: 'V2348',ip: '192.168.101.3', mac: 'aa:bb:cc:00:00:03', type: '802.11' },
  ],
};
const gc = generateConnectionGroups(cdata);
const wifiG = gc.filter(g => g.type !== 'lan');
ok(wifiG.length === 1, 'C-DATA: satu grup WiFi gabungan (got ' + wifiG.length + ')');
ok(wifiG[0] && wifiG[0].count === 3, 'C-DATA: jumlah = 3 klien WiFi (got ' + (wifiG[0]&&wifiG[0].count) + ')');
ok(wifiG[0] && wifiG[0].devices.length === 3, 'C-DATA: 3 perangkat tampil dengan detail');
ok(wifiG[0] && wifiG[0].devices[0].name === 'itel', 'C-DATA: nama perangkat terbaca');

// ── C-DATA + band (X_CMS_WirelessTerminal): atribusi klien ke SSID 2,4G vs 5G ──
const cdataBand = {
  mfr: 'CDTC',
  ssids: [
    { idx: 1, name: 'ELANG RACING 5G', enabled: true, associations: 0, standard: 'ac', channel: 255 },
    { idx: 6, name: 'CINTA JAYA',      enabled: true, associations: 0, standard: '',   channel: 0 },
  ],
  hostList: [
    { name: 'V2348', ip: '192.168.101.3', mac: 'a', type: '802.11', band: '2.4G', negotiationRate: '144Mbps', addressSource: 'DHCP' },
    { name: 'vivo',  ip: '192.168.101.4', mac: 'b', type: '802.11', band: '5G',   negotiationRate: '866Mbps', addressSource: 'DHCP' },
    { name: 'itel',  ip: '192.168.101.5', mac: 'c', type: '802.11', band: '2.4G' },
  ],
};
const gb = generateConnectionGroups(cdataBand).filter(g => g.type !== 'lan');
ok(gb.length === 2, 'C-DATA band: 2 grup WiFi (5G + 2,4G) — bukan gabungan (got ' + gb.length + ')');
const g5 = gb.find(g => g.meta === '5GHz'), g24 = gb.find(g => g.meta === '2.4GHz');
ok(g5 && g5.name === 'ELANG RACING 5G' && g5.count === 1, 'C-DATA band: 5G = ELANG RACING (1 klien: vivo)');
ok(g24 && g24.name === 'CINTA JAYA' && g24.count === 2, 'C-DATA band: 2,4G = CINTA JAYA (2 klien: V2348+itel)');
ok(g5 && g5.devices[0].name === 'vivo', 'C-DATA band: klien 5G teratribusi benar');
ok(g24 && g24.devices.map(d=>d.name).sort().join(',') === 'V2348,itel', 'C-DATA band: klien 2,4G teratribusi benar');
// Detail lengkap utk popup hover (hanya klien ber-band C-DATA)
ok(g5.devices[0].detail && g5.devices[0].detail.negotiationRate === '866Mbps' && g5.devices[0].detail.band === '5G',
   'C-DATA band: device.detail bawa negotiationRate+band (untuk popup hover)');
ok(g5.devices[0].detail.addressSource === 'DHCP' && g5.devices[0].detail.mac === 'b',
   'C-DATA band: device.detail bawa addressSource+MAC');

// ── C-DATA FD512XW-R460: TANPA X_CMS (band=null) → atribusi via Layer2Interface→WLAN.N ──
// Firmware ini TAK melaporkan X_CMS_WirelessTerminal/NegotiationRate; band diturunkan
// dari SSID yang ditunjuk Layer2Interface. Popup tetap tampil (rate=null saja).
const cdataL2 = {
  mfr: 'CDTC',
  ssids: [
    { idx: 1, name: 'RUMAH-2.4G', enabled: true, associations: 0, standard: '',   channel: 6  },
    { idx: 5, name: 'RUMAH-5G',   enabled: true, associations: 0, standard: 'ac', channel: 36 },
  ],
  hostList: [
    { name: 'OPPO',   ip: '10.0.0.2', mac: 'a', type: '802.11', band: null, negotiationRate: null, addressSource: 'DHCP', layer2: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1' },
    { name: 'realme', ip: '10.0.0.3', mac: 'b', type: '802.11', band: null, negotiationRate: null, addressSource: 'DHCP', layer2: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5' },
  ],
};
const gl = generateConnectionGroups(cdataL2).filter(g => g.type !== 'lan');
ok(gl.length === 2, 'C-DATA L2: 2 grup SSID (via Layer2Interface), bukan gabungan');
const l24 = gl.find(g => g.name === 'RUMAH-2.4G'), l5 = gl.find(g => g.name === 'RUMAH-5G');
ok(l24 && l24.count === 1 && l24.devices[0].name === 'OPPO',   'C-DATA L2: OPPO→WLANConfiguration.1 (RUMAH-2.4G)');
ok(l5  && l5.count === 1  && l5.devices[0].name === 'realme', 'C-DATA L2: realme→WLANConfiguration.5 (RUMAH-5G)');
ok(l24.devices[0].detail && l24.devices[0].detail.band === '2.4G' && l24.devices[0].detail.ssid === 'RUMAH-2.4G',
   'C-DATA L2: detail band DITURUNKAN dari SSID + nama SSID (X_CMS_WirelessTerminal absen)');
ok(l24.devices[0].detail.negotiationRate === null,
   'C-DATA L2: NegotiationRate=null (FD512XW tak lapor) — popup tetap tampil field lain');

// ── C-DATA FD512XW: TotalAssociations>0 TAPI tetap pakai Layer2 (atribusi presisi) ──
// Kasus DF1D-2412014403 nyata: WLAN.1 lapor TotalAssociations=3. Harus TETAP lewat
// jalur Layer2Interface (bukan distribusi pool ZTE) → popup dpt band+ssid.
const cdataAssoc = {
  mfr: 'CDTC',
  ssids: [ { idx: 1, name: 'VANOWISESA', enabled: true, associations: 3, standard: 'b,g,n', channel: 0 } ],
  hostList: [
    { name: 'OPPO',    ip: '1', mac: 'a', type: '802.11', band: null, negotiationRate: null, addressSource: 'DHCP', layer2: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1' },
    { name: 'realme',  ip: '2', mac: 'b', type: '802.11', band: null, negotiationRate: null, addressSource: 'DHCP', layer2: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1' },
    { name: 'Infinix', ip: '3', mac: 'c', type: '802.11', band: null, negotiationRate: null, addressSource: 'DHCP', layer2: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1' },
  ],
};
const ga = generateConnectionGroups(cdataAssoc).filter(g => g.type !== 'lan');
ok(ga.length === 1 && ga[0].name === 'VANOWISESA' && ga[0].count === 3, 'C-DATA assoc>0: 3 host tetap ke VANOWISESA via Layer2');
ok(ga[0].devices[0].detail && ga[0].devices[0].detail.band === '2.4G' && ga[0].devices[0].detail.ssid === 'VANOWISESA',
   'C-DATA assoc>0: popup dpt band+ssid (bukan null) walau TotalAssociations>0');

// ── HWTC ZL-2113X: mfr='HWTC' → keluarga X_CT-COM juga → jalur atribusi Layer2 ──
// Firmware pakai InterfaceType='WLAN' (dinormalkan ke '802.11' di api.js) + Layer2Interface;
// TANPA X_CMS (band diturunkan dari SSID). Single-band 2.4G, WLAN.1='RENO' aktif. Popup
// harus tetap tampil (band+ssid dari Layer2; rate null). Gate isCtCom WAJIB cakup HWTC.
const hwtc = {
  mfr: 'HWTC',
  ssids: [ { idx: 1, name: 'RENO', enabled: true, associations: 2, standard: '', channel: 0 } ],
  hostList: [
    { name: 'vivo-2007', ip: '192.168.1.6', mac: 'a', type: '802.11', band: null, negotiationRate: null, addressSource: 'DHCP', layer2: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1' },
    { name: 'realme-C11', ip: '192.168.1.4', mac: 'b', type: 'Ethernet' },
  ],
};
const gh = generateConnectionGroups(hwtc);
const ghw = gh.filter(g => g.type !== 'lan');
ok(ghw.length === 1 && ghw[0].name === 'RENO' && ghw[0].count === 1, 'HWTC: 1 klien WiFi → RENO via Layer2 (bukan distribusi)');
ok(ghw[0].devices[0].name === 'vivo-2007' && ghw[0].devices[0].detail && ghw[0].devices[0].detail.band === '2.4G' && ghw[0].devices[0].detail.ssid === 'RENO',
   'HWTC: popup dpt band(2.4G,dari SSID)+ssid, gate isCtCom cakup HWTC');
ok(gh.some(g => g.type === 'lan' && g.count === 1), 'HWTC: klien Ethernet → grup LAN (1)');

// ── ZTE: 2 SSID aktif dgn TotalAssociations nyata → distribusi per-SSID (tak berubah) ──
const zte = {
  ssids: [
    { idx: 1, name: 'ZTE-2G', enabled: true, associations: 2, standard: 'n',  channel: 6 },
    { idx: 5, name: 'ZTE-5G', enabled: true, associations: 1, standard: 'ac', channel: 36 },
  ],
  hostList: [
    { name: 'a', ip: '10.0.0.1', mac: 'a', type: '802.11' },
    { name: 'b', ip: '10.0.0.2', mac: 'b', type: '802.11' },
    { name: 'c', ip: '10.0.0.3', mac: 'c', type: '802.11' },
  ],
};
const gz = generateConnectionGroups(zte);
const zg = gz.filter(g => g.type !== 'lan');
ok(zg.length === 2, 'ZTE: tetap distribusi per-SSID (2 grup) — perilaku lama utuh');
ok(zg[0] && zg[0].count === 2 && zg[0].devices.length === 2, 'ZTE: SSID1 dapat 2 klien');
ok(zg[1] && zg[1].count === 1 && zg[1].devices.length === 1, 'ZTE: SSID5 dapat 1 klien');
// Popup kini UNIVERSAL: setiap klien nirkabel dapat detail (info dasar bila tak ada radio).
ok(zg[0].devices[0].detail && zg[0].devices[0].detail.ssid === 'ZTE-2G',
   'ZTE: klien nirkabel dapat popup detail (SSID) — popup universal lintas vendor');
ok(zg[0].devices[0].detail.band === '2.4G',
   'ZTE: band di detail DITURUNKAN dari SSID (is5GHz) walau host tak bawa band');
// Distribusi per-SSID & jumlah TIDAK berubah (byte-identik) — hanya detail yang ditambah.
ok(zg[0].count === 2 && zg[1].count === 1, 'ZTE: jumlah & distribusi per-SSID tetap (tak berubah)');


// ── Huawei (X_HW): TotalAssociations=2 tapi kolam Hosts berisi 6 (4 sudah tak aktif,
//    sudah tersaring di api.js). Atribusi HARUS lewat telemetri radio (radio.ssidIdx),
//    BUKAN bagi rata "ambil N pertama dari kolam" — urutan kolam tak dijamin. ──
const hw = {
  mfr: 'Huawei Technologies Co., Ltd',
  ssids: [
    { idx: 1, name: 'VIKA', enabled: true, associations: 2, channel: 6 },
    { idx: 2, name: 'VIKA-Tamu', enabled: true, associations: 0, channel: 6 },
  ],
  hostList: [
    { name: 'OPPO-A12', ip: '192.168.100.4', mac: 'fc:a5:d0:98:10:3b', type: '802.11',
      radio: { ssidIdx: 1, rssi: -61 }, layer2: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1' },
    { name: 'realme-Note-60x', ip: '192.168.100.2', mac: '92:b4:7e:12:92:26', type: '802.11',
      radio: { ssidIdx: 1, rssi: -46 }, layer2: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1' },
  ],
};
const hwG = generateConnectionGroups(hw);
const hwS1 = hwG.find(g => g.id === 'ssid1');
const hwS2 = hwG.find(g => g.id === 'ssid2');
ok(hwS1 && hwS1.count === 2 && hwS1.devices.length === 2, 'Huawei: 2 klien masuk SSID1 (dari telemetri radio)');
ok(hwS2 && hwS2.count === 0, 'Huawei: SSID2 kosong (bukan kebagian sisa kolam)');
ok(hwG.reduce((s, g) => s + g.count, 0) === hw.hostList.length,
   'Huawei: TOTAL grup == jumlah klien aktif → angka Topologi & Perangkat Terhubung SAMA');
ok(hwS1.devices[0].detail && hwS1.devices[0].detail.radio,
   'Huawei: klien dapat popup detail (telemetri radio ada)');

if (fail === 0) console.log('lulus: ' + pass + ' assertion\n✓ Peta koneksi: C-DATA grup gabungan, ZTE distribusi per-SSID (utuh).');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }
