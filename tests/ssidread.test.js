// Uji pemetaan SSID di api.js (mapDevice):
//  (1) PASSWORD SSID — dibaca dari KeyPassphrase ATAU node PreSharedKey.1.KeyPassphrase
//      (F9V/X_CU menaruhnya di PreSharedKey; KeyPassphrase langsung justru KOSONG).
//      Firmware yang tak mengekspos password → '' → UI tak menampilkan barisnya.
//  (2) channelWidthType 'bwstr' — leaf 'BandWidth' string ('20MHz'/'40MHz') milik F9V.
//      ZTE (X_CMCC_ChannelWidth) & HWTC (X_CT-COM_ChannelWidth) TIDAK boleh berubah.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');
// mapDevice memanggil getVendorSecurityConfig (band5MinIdx) & getConfig → sediakan stub.
const stub = `
  var localStorage = { getItem: function(){ return null; }, setItem: function(){} };
  function getVendorSecurityConfig(){ return null; }
`;
const ACS = new Function(stub + src + '\n; return ACS;')();

let pass = 0, fail = 0;
function ok(c, m){ if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

const L  = (v) => ({ _value: v, _writable: true });
const LR = (v) => ({ _value: v, _writable: false });   // read-only

function dev(wlan) {
  return ACS.mapDevice({
    _id: '78C1A7-F9V-ELWRP93H6152818',
    _deviceId: { _Manufacturer: 'ETCH', _ProductClass: 'F9V', _OUI: '78C1A7', _SerialNumber: 'X' },
    InternetGatewayDevice: { LANDevice: { '1': { WLANConfiguration: wlan } } },
  });
}

// ── F9V (X_CU): password di PreSharedKey.1.KeyPassphrase, KeyPassphrase langsung KOSONG ──
const f9v = dev({
  '1': {
    SSID: L('EXSEL'), Enable: L('True'), Channel: L(2), BeaconType: L('WPAand11i'),
    KeyPassphrase: L(''),
    PreSharedKey: { '1': { KeyPassphrase: L('contoh2014'), PreSharedKey: L('') } },
    BandWidth: L('40MHz'),
    AutoChannelEnable: L('True'),
  },
});
ok(f9v.ssids.length === 1, 'F9V: 1 SSID ter-parse');
ok(f9v.ssids[0].password === 'contoh2014', 'F9V: password dari PreSharedKey.1.KeyPassphrase (KeyPassphrase kosong)');
ok(f9v.ssids[0].channelWidthType === 'bwstr', "F9V: channelWidthType='bwstr' (leaf BandWidth writable)");
ok(f9v.ssids[0].channelWidthVal === '40MHz', 'F9V: channelWidthVal = 40MHz (string)');
ok(f9v.ssids[0].bandwidth === '40MHz', 'F9V: bandwidth terbaca dari BandWidth');

// ── Password langsung di KeyPassphrase (vendor lain) — tetap terbaca ──
const direct = dev({ '1': { SSID: L('RUMAH'), Enable: L('True'), KeyPassphrase: L('rahasia123') } });
ok(direct.ssids[0].password === 'rahasia123', 'KeyPassphrase langsung → password terbaca');

// ── Firmware yang TIDAK mengekspos password → '' (UI menyembunyikan baris) ──
const nopw = dev({ '1': { SSID: L('RUMAH'), Enable: L('True'), KeyPassphrase: L('') } });
ok(nopw.ssids[0].password === '', 'Tanpa password terekspos → string kosong (baris disembunyikan)');
const nokey = dev({ '1': { SSID: L('RUMAH'), Enable: L('True') } });
ok(nokey.ssids[0].password === '', 'Tanpa leaf KeyPassphrase sama sekali → kosong (tak crash)');

// ── BandWidth READ-ONLY → BUKAN 'bwstr' (kontrol tak ditawarkan) ──
const roBw = dev({ '1': { SSID: L('X'), Enable: L('True'), BandWidth: LR('40MHz') } });
ok(roBw.ssids[0].channelWidthType === null, 'BandWidth read-only → channelWidthType null (tak bisa diatur)');

// ── ZTE (X_CMCC) & HWTC (X_CT-COM): tipe lama TIDAK berubah (byte-identik) ──
const zte = dev({ '1': { SSID: L('ZTE'), Enable: L('True'), X_CMCC_ChannelWidth: L(1), KeyPassphrase: L('zte123') } });
ok(zte.ssids[0].channelWidthType === 'xcmcc', 'ZTE: channelWidthType tetap xcmcc');
ok(zte.ssids[0].channelWidthVal === 1,        'ZTE: channelWidthVal tetap integer 1');
ok(zte.ssids[0].password === 'zte123',        'ZTE: password dari KeyPassphrase');
const hwtc = dev({ '1': { SSID: L('HWTC'), Enable: L('True'), 'X_CT-COM_ChannelWidth': L(0) } });
ok(hwtc.ssids[0].channelWidthType === 'ctcom', 'HWTC: channelWidthType tetap ctcom');
// Prioritas: X_CMCC menang atas BandWidth bila keduanya ada
const both = dev({ '1': { SSID: L('X'), Enable: L('True'), X_CMCC_ChannelWidth: L(2), BandWidth: L('40MHz') } });
ok(both.ssids[0].channelWidthType === 'xcmcc', 'Prioritas: X_CMCC_ChannelWidth menang atas BandWidth');

if (fail === 0) console.log('lulus: ' + pass + ' assertion\n✓ Password SSID (KeyPassphrase/PreSharedKey) & bandwidth F9V (bwstr) benar; ZTE/HWTC utuh.');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }

// ═══ Telemetri radio per-klien (WLANConfiguration.N.AssociatedDevice) ═══
// F679L/F670L (X_ZTE-COM) melaporkan RSSI/SNR/noise/laju/mode per klien nirkabel.
// Digabungkan ke Hosts.Host lewat MAC. Firmware tanpa data ini → host.radio = null
// (popup C-DATA lama tak berubah).
function devFull(raw) { return ACS.mapDevice(Object.assign({
  _id: 'F8731A-F679L-ZTEGD77F8C07',
  _deviceId: { _Manufacturer: 'ZTE', _ProductClass: 'F679L', _OUI: 'F8731A', _SerialNumber: 'X' },
}, raw)); }

const zteFull = devFull({ InternetGatewayDevice: { LANDevice: { '1': {
  Hosts: { Host: { '15': {
    HostName: L('IPC'), IPAddress: L('192.168.1.6'), MACAddress: L('30:DD:AA:3B:93:EC'),
    InterfaceType: L('802.11'), Active: L('True'), AddressSource: L('DHCP'),
  } } },
  WLANConfiguration: { '1': {
    SSID: L('KAYLA'), Enable: L('True'), Channel: L(1),
    AssociatedDevice: { '8': {
      AssociatedDeviceMACAddress: L('30:dd:aa:3b:93:ec'),
      AssociatedDeviceRssi: L(-74), 'X_ZTE-COM_WLAN_SNR': L(20), 'X_ZTE-COM_WLAN_Noise': L(-95),
      'X_ZTE-COM_TXRate': L(65000), 'X_ZTE-COM_RXRate': L(58500),
      AssociatedDeviceBandWidth: L('20MHz'), 'X_ZTE-COM_WLAN_ClientMode': L('11n'),
      'X_ZTE-COM_WLAN_Radio': L('2.4GHz'),
      'X_ZTE-COM_WLAN_BytesSend': L(49744582), 'X_ZTE-COM_WLAN_BytesReceived': L(1379057008),
      'X_ZTE-COM_TxFailPkt': L(0), 'X_ZTE-COM_RxFailPkt': L(0),
      'X_ZTE-COM_WLAN_RetryCount': L(10), 'X_ZTE-COM_StayTime': L('630030'),
    } },
  } },
} } } });
const hz = zteFull.hostList[0];
ok(!!hz.radio, 'F679L: host dapat telemetri radio (dicocokkan via MAC, beda huruf besar/kecil)');
ok(hz.radio && hz.radio.rssi === -74, 'F679L: RSSI -74 dBm');
ok(hz.radio && hz.radio.snr === 20 && hz.radio.noise === -95, 'F679L: SNR & noise terbaca');
ok(hz.radio && hz.radio.txRate === 65 && hz.radio.rxRate === 58.5, 'F679L: laju kbps → Mbps (65000→65, 58500→58.5)');
ok(hz.radio && hz.radio.mode === '11n' && hz.radio.width === '20MHz', 'F679L: mode & lebar kanal terbaca');
ok(hz.band === '2.4G', 'F679L: band host diturunkan dari radio klien (2.4GHz)');
ok(hz.radio && hz.radio.bytesSent === 49744582 && hz.radio.bytesRecv === 1379057008, 'F679L: byte TX/RX terbaca');
ok(hz.radio && hz.radio.stayTime === 630030, 'F679L: lama terhubung terbaca');

// Instance AssociatedDevice KOSONG (firmware kadang bikin entri tanpa nilai) → diabaikan
const zteEmpty = devFull({ InternetGatewayDevice: { LANDevice: { '1': {
  Hosts: { Host: { '1': { HostName: L('X'), MACAddress: L('aa:bb:cc:dd:ee:ff'), InterfaceType: L('802.11'), Active: L('True') } } },
  WLANConfiguration: { '1': { SSID: L('S'), Enable: L('True'),
    AssociatedDevice: { '9': { AssociatedDeviceMACAddress: L('aa:bb:cc:dd:ee:ff') } } } },
} } } });
ok(zteEmpty.hostList[0].radio === null, 'Entri AssociatedDevice tanpa nilai → radio null (tak bikin popup kosong)');

// Vendor tanpa AssociatedDevice (C-DATA / ZTE F663) → radio null, perilaku lama utuh
const noAssoc = devFull({ InternetGatewayDevice: { LANDevice: { '1': {
  Hosts: { Host: { '1': { HostName: L('PC'), MACAddress: L('11:22:33:44:55:66'), InterfaceType: L('Ethernet'), Active: L('True') } } },
  WLANConfiguration: { '1': { SSID: L('S'), Enable: L('True') } },
} } } });
ok(noAssoc.hostList[0].radio === null, 'Tanpa AssociatedDevice → radio null (popup C-DATA lama tak berubah)');
ok(noAssoc.hostList[0].band === null, 'Tanpa telemetri → band tetap null (tak mengarang)');

if (fail === 0) console.log('lulus (dgn telemetri radio): ' + pass + ' assertion ✓');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }

// ═══ Telemetri lintas-vendor: HWTC/Huawei (X_HW_*) ═══
// SATUAN LAJU BEDA: ZTE X_ZTE-COM_* = kbps (65000), HWTC/Huawei X_HW_* = Mbps (65).
// Dan HWTC mengekspos SignalStrength=0 (dummy) — RSSI asli di X_HW_RSSI.
const hwtcCli = devFull({ InternetGatewayDevice: { LANDevice: { '1': {
  Hosts: { Host: { '1': { HostName: L('HP-Budi'), IPAddress: L('192.168.1.9'),
    MACAddress: L('90:31:4B:F8:F3:F3'), InterfaceType: L('WLAN'), Active: L('True') } } },
  WLANConfiguration: { '1': { SSID: L('RENO'), Enable: L('True'),
    AssociatedDevice: { '1': {
      AssociatedDeviceMACAddress: L('90:31:4B:F8:F3:F3'),
      SignalStrength: L(0), X_HW_RSSI: L(-52), X_HW_RxRate: L(65), X_HW_TxRate: L(65),
      X_HW_Uptime: L('286:17190:57'),
    } } } },
} } } });
const hh = hwtcCli.hostList[0];
ok(hh.radio && hh.radio.rssi === -52, 'HWTC: RSSI dari X_HW_RSSI (-52), BUKAN SignalStrength=0 dummy');
ok(hh.radio && hh.radio.txRate === 65 && hh.radio.rxRate === 65, 'HWTC: laju 65 sudah Mbps → tidak dibagi 1000');
ok(hh.radio && hh.radio.stayTime === null, "HWTC: X_HW_Uptime '286:17190:57' bukan detik → diabaikan (tak mengarang)");

const hw = devFull({ InternetGatewayDevice: { LANDevice: { '1': {
  Hosts: { Host: { '1': { HostName: L(''), IPAddress: L('192.168.100.28'),
    MACAddress: L('0C:98:38:CE:2B:5D'), InterfaceType: L('802.11'), Active: L('True') } } },
  WLANConfiguration: { '1': { SSID: L('HW'), Enable: L('True'),
    AssociatedDevice: { '1': {
      AssociatedDeviceMACAddress: L('0C:98:38:CE:2B:5D'),
      X_HW_RSSI: L('-47'), X_HW_Noise: L('-90'), X_HW_Uptime: L('1247'),
      X_HW_AssociatedDevicedescriptions: L('V2027'),
    } } } },
} } } });
const hw1 = hw.hostList[0];
ok(hw1.radio && hw1.radio.rssi === -47, 'Huawei: RSSI string "-47" → angka -47');
ok(hw1.radio && hw1.radio.noise === -90, 'Huawei: noise dari X_HW_Noise');
ok(hw1.radio && hw1.radio.stayTime === 1247, 'Huawei: X_HW_Uptime numerik → detik');
ok(hw1.name === 'V2027', 'Huawei: HostName kosong → pakai nama dari radio (X_HW_AssociatedDevicedescriptions)');

// RSSI positif/0 dari firmware mana pun → dibuang (bukan dBm yang sah)
const bogus = devFull({ InternetGatewayDevice: { LANDevice: { '1': {
  Hosts: { Host: { '1': { HostName: L('X'), MACAddress: L('11:11:11:11:11:11'), InterfaceType: L('802.11'), Active: L('True') } } },
  WLANConfiguration: { '1': { SSID: L('S'), Enable: L('True'),
    AssociatedDevice: { '1': { AssociatedDeviceMACAddress: L('11:11:11:11:11:11'), SignalStrength: L(0) } } } },
} } } });
ok(bogus.hostList[0].radio === null, 'RSSI 0 dBm (dummy) → telemetri diabaikan, tak ada popup palsu');

if (fail === 0) console.log('lulus (lintas-vendor ZTE/HWTC/Huawei): ' + pass + ' assertion ✓');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }

// ═══ PARAM TULIS lebar kanal: master vs hasil operasi (pelajaran F679L) ═══
// X_ZTE-COM punya BandWidth (master, ditulis) + X_ZTE-COM_OperatingChannelBandwidth
// (hasil operasi radio, JANGAN ditulis — akan ditimpa balik saat master 'Auto').
const zteBw = dev({
  '1': { SSID: L('KAYLA'), Enable: L('True'), Channel: L(1),
         BandWidth: L('Auto'), 'X_ZTE-COM_OperatingChannelBandwidth': L('20MHz') },
});
ok(zteBw.ssids[0].channelWidthType === 'ztecom', 'F679L: tipe ztecom');
ok(zteBw.ssids[0].channelWidthParam === 'BandWidth', 'F679L: TULIS ke BandWidth (master), bukan Operating');
ok(zteBw.ssids[0].channelWidthVal === 'Auto', 'F679L: nilai master = Auto (yang dipilih operator)');
ok(zteBw.ssids[0].channelWidthOper === '20MHz', 'F679L: lebar kanal nyata radio = 20MHz (beda dari master)');

// Tanpa BandWidth (firmware X_ZTE-COM lain) → jatuh ke param Operating
const zteNoMaster = dev({ '1': { SSID: L('X'), Enable: L('True'),
  'X_ZTE-COM_OperatingChannelBandwidth': L('80MHz') } });
ok(zteNoMaster.ssids[0].channelWidthParam === 'X_ZTE-COM_OperatingChannelBandwidth',
   'X_ZTE-COM tanpa BandWidth → tulis ke Operating (cadangan)');

// Vendor lain: param tulis TIDAK berubah (byte-identik)
const zteOld = dev({ '1': { SSID: L('X'), Enable: L('True'), X_CMCC_ChannelWidth: L(1) } });
ok(zteOld.ssids[0].channelWidthParam === 'X_CMCC_ChannelWidth', 'ZTE F663: tetap tulis X_CMCC_ChannelWidth');
const hwtcW = dev({ '1': { SSID: L('X'), Enable: L('True'), 'X_CT-COM_ChannelWidth': L(0) } });
ok(hwtcW.ssids[0].channelWidthParam === 'X_CT-COM_ChannelWidth', 'HWTC: tetap tulis X_CT-COM_ChannelWidth');
const f9vW = dev({ '1': { SSID: L('X'), Enable: L('True'), BandWidth: L('40MHz') } });
ok(f9vW.ssids[0].channelWidthType === 'bwstr' && f9vW.ssids[0].channelWidthParam === 'BandWidth',
   'F9V: tetap tulis BandWidth');
ok(f9vW.ssids[0].channelWidthOper === null, 'F9V: tak punya param hasil operasi → null');


// ── Hosts.Host.Active: BOOLEAN (ZTE/C-DATA) vs ANGKA 1/0 (Huawei) ──────────────
// Bug lapangan: filter lama (Active !== false) meloloskan angka 0 → perangkat yang sudah
// TIDAK terhubung ikut terhitung sebagai klien aktif.
const hostsRaw = { InternetGatewayDevice: { LANDevice: { '1': {
  WLANConfiguration: { '1': { SSID: L('VIKA'), Enable: L('True'), BeaconType: L('WPAand11i'),
    TotalAssociations: L('2'), Channel: L('6'),
    AssociatedDevice: {
      '1': { AssociatedDeviceMACAddress: L('FC:A5:D0:98:10:3B'), 'X_HW_RSSI': L('-61'),
             'X_HW_AssociatedDevicedescriptions': L('OPPO-A12'), 'X_HW_Uptime': L('54') },
    } } },
  Hosts: { Host: {
    '1': { Active: L(1), HostName: L('OPPO-A12'),   IPAddress: L('192.168.100.4'),
           MACAddress: L('fc:a5:d0:98:10:3b'), InterfaceType: L('802.11'),
           Layer2Interface: L('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1') },
    '2': { Active: L(0), HostName: L('POCO-M3'),    IPAddress: L('192.168.100.3'),
           MACAddress: L('9e:03:15:39:43:7f'), InterfaceType: L('802.11') },
    '3': { Active: L('0'), HostName: L('POCO-X5'),  IPAddress: L('192.168.100.8'),
           MACAddress: L('b6:6c:13:a7:97:c8'), InterfaceType: L('802.11') },
    '4': { Active: L(false), HostName: L('Lama'),   IPAddress: L('192.168.100.9'),
           MACAddress: L('aa:bb:cc:dd:ee:ff'), InterfaceType: L('802.11') },
    '5': { HostName: L('TanpaFlag'), IPAddress: L('192.168.100.10'),
           MACAddress: L('11:22:33:44:55:66'), InterfaceType: L('Ethernet') },
  } },
} } } };
const hosts = ACS.mapDevice(hostsRaw).hostList;
const names = hosts.map(h => h.name).sort();
ok(hosts.length === 2, 'Hosts: hanya yang AKTIF ditampilkan (got ' + hosts.length + ')');
ok(names.indexOf('OPPO-A12') >= 0, 'Hosts: Active=1 (angka) → aktif');
ok(names.indexOf('TanpaFlag') >= 0, 'Hosts: tanpa param Active → tetap dianggap aktif (perilaku lama)');
ok(names.indexOf('POCO-M3') < 0 && names.indexOf('POCO-X5') < 0,
   'Hosts: Active=0 (angka & string) → BUKAN klien aktif (bug lama: lolos filter)');
ok(names.indexOf('Lama') < 0, 'Hosts: Active=false (boolean) → tetap tersaring spt semula');
const oppo = hosts.find(h => h.name === 'OPPO-A12');
ok(oppo && oppo.radio && oppo.radio.ssidIdx === 1,
   'Huawei: klien terkait ke SSID lewat telemetri radio (atribusi presisi, bukan bagi rata)');
ok(oppo && oppo.radio.rssi === -61, 'Huawei: RSSI per-klien dari X_HW_RSSI');
ok(oppo && oppo.radio.stayTime === 54, 'Huawei: lama terhubung dari X_HW_Uptime (angka murni)');


// ── Password SSID: leaf metadata TANPA _value tak boleh jadi '[object Object]' ────
// F9V FOTC (live SN ELWRP93H6275858): KeyPassphrase tingkat atas KOSONG, password asli
// ada di PreSharedKey.1.KeyPassphrase. Pada slot yang belum pernah dibaca, KeyPassphrase
// berupa objek metadata (truthy) → rantai '||' lama berhenti di situ.
const pwRaw = { InternetGatewayDevice: { LANDevice: { '1': { WLANConfiguration: {
  '1': { SSID: L('BAGAS'), Enable: L('True'), BeaconType: L('WPAand11i'),
         KeyPassphrase: L(''), PreSharedKey: { '1': { KeyPassphrase: L('Contoh200908') } } },
  '2': { SSID: L('SSID2'), Enable: L('False'), BeaconType: L('WPAand11i'),
         KeyPassphrase: { _writable: true },   // leaf ADA tapi tanpa _value
         PreSharedKey: { '1': { KeyPassphrase: L('c0nt0h7x') } } },
  '3': { SSID: L('SSID3'), Enable: L('False'), BeaconType: L('None') },   // tak ada password
} } } } };
const pw = ACS.mapDevice(pwRaw).ssids;
ok(pw[0].password === 'Contoh200908', 'F9V: password dibaca dari PreSharedKey.1 saat KeyPassphrase kosong');
ok(pw[1].password === 'c0nt0h7x',   'F9V: leaf metadata tanpa _value DILEWATI (bukan "[object Object]")');
ok(pw[2].password === '',           'Tanpa password sama sekali → string kosong (UI menyembunyikan baris)');

if (fail === 0) console.log('lulus (param tulis lebar kanal): ' + pass + ' assertion ✓');
else { console.error('GAGAL: ' + fail + ' assertion'); process.exit(1); }
