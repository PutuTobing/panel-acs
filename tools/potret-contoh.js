/* Dokumen perangkat CONTOH untuk tools/potret.js dan uji tampilan.

   SELURUHNYA BUATAN — tidak ada satu pun nilai yang berasal dari ONU pelanggan:
   nomor seri "CONTOH…", OUI rekaan, alamat dari rentang dokumentasi/privat, nama
   WiFi & nama perangkat karangan. Bentuknya mengikuti dokumen GenieACS (tiap daun
   {_value,_type,_writable,_timestamp}) dan hanya memuat bagian yang dibaca panel.

   Dua perangkat:
     1. F663NV9  (keluarga X_CMCC, satu pita 2.4 GHz, EPON)  — model terbanyak di armada.
     2. F670L    (keluarga X_ZTE-COM, dua pita, GPON, tabel Port Binding, telemetri klien).

   buat({ xss: true }) menyisipkan teks ber-HTML pada nama WiFi, nama perangkat,
   username PPPoE dan tag — dipakai uji tampilan untuk memastikan semuanya tampil
   sebagai TEKS, bukan dijalankan browser. */
'use strict';

function buat(opsi) {
  opsi = opsi || {};
  const kini = Date.now();
  const iso = (mundurMs) => new Date(kini - mundurMs).toISOString();
  const cap = iso(2 * 60 * 1000);
  // Daun & objek ala GenieACS.
  const L = (v, t, w) => ({ _value: v, _type: t || 'xsd:string', _writable: !!w, _object: false, _timestamp: cap });
  const S = (v, w) => L(v, 'xsd:string', w);
  const B = (v, w) => L(v, 'xsd:boolean', w);
  const U = (v, w) => L(v, 'xsd:unsignedInt', w);
  const I = (v, w) => L(v, 'xsd:int', w);
  const O = (o, w) => Object.assign({ _object: true, _writable: !!w, _timestamp: cap }, o);
  const VP = (o) => { const r = { _object: true, _writable: false, _timestamp: cap }; Object.keys(o).forEach(k => { r[k] = S(o[k], false); }); return r; };
  const jahat = (aman, teks) => (opsi.xss ? teks : aman);
  const X = '"><img src=x onerror="window.__xssKena=1">';

  const host = (nama, ip, mac, jenis, ekstra) => O(Object.assign({
    HostName: S(nama), IPAddress: S(ip), MACAddress: S(mac), InterfaceType: S(jenis),
    Active: B(true), AddressSource: S('DHCP'), LeaseTimeRemaining: I(71000),
  }, ekstra || {}));

  // ── 1. F663NV9 (X_CMCC) ──────────────────────────────────────────────────
  const wlanCmcc = (ssid, aktif, beacon, klien) => O({
    Enable: B(aktif, true), SSID: S(ssid, true), BeaconType: S(beacon, true),
    Channel: U(6, true), AutoChannelEnable: B(true, true), ChannelsInUse: S('6'),
    PossibleChannels: S('1-13'), Standard: S('b,g,n', true), TotalAssociations: U(klien),
    TransmitPower: U(100, true), X_CMCC_PowerValue: U(20), X_CMCC_ChannelWidth: U(2, true),
    BasicAuthenticationMode: S('OpenSystem', true), BasicEncryptionModes: S('None', true),
    WPAAuthenticationMode: S('PSKAuthentication', true), WPAEncryptionModes: S('TKIPandAESEncryption', true),
    IEEE11iAuthenticationMode: S('PSKAuthentication', true), IEEE11iEncryptionModes: S('TKIPandAESEncryption', true),
    KeyPassphrase: S('', true), SSIDAdvertisementEnabled: B(true, true),
  }, true);
  const lanIf = n => 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.' + n;
  const wlIf  = n => 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + n;

  const f663 = {
    _id: 'AA11BB-F663NV9-ZTEGCONTOH0001',
    _deviceId: { _Manufacturer: 'ZTE', _OUI: 'AA11BB', _ProductClass: 'F663NV9', _SerialNumber: 'ZTEGCONTOH0001' },
    _lastInform: iso(2 * 60 * 1000), _registered: iso(190 * 86400000), _lastBoot: iso(3 * 86400000),
    _tags: opsi.xss ? ['contoh', '<b>tag</b>'] : ['contoh'],
    VirtualParameters: VP({
      RXPower: '-18.42', getTXPower: '2.31 dBm', gettemp: '48', getponmode: 'EPON', getVlan: '100/170',
      pppoeUsername: jahat('budi.contoh@sky', 'budi' + X + '@sky'), pppoeIP: '10.99.1.25', pppoeMac: 'AA:11:BB:00:10:02',
      PonMac: 'AA:11:BB:00:10:01', IPTR069: '10.98.0.25', activedevices: '4',
      getdeviceuptime: '3d 05:12:40', getpppuptime: '1d 02:03:04', getSerialNumber: 'ZTEGCONTOH0001',
    }),
    InternetGatewayDevice: O({
      DeviceInfo: O({
        HardwareVersion: S('V9.0'), SoftwareVersion: S('V9.0.0P1T8'), Manufacturer: S('ZTE'),
        ManufacturerOUI: S('AA11BB'), ProductClass: S('F663NV9'), SerialNumber: S('ZTEGCONTOH0001'),
        X_CMCC_TeleComAccount: O({ Enable: B(true, true), Username: S('admin', true), Password: S('', true) }),
      }),
      WANDevice: O({ '1': O({
        WANCommonInterfaceConfig: O({ WANAccessType: S('EPON') }),
        WANConnectionDevice: O({ '1': O({
          WANIPConnection: O({ '1': O({
            Enable: B(true, true), Name: S('1_TR069_R_VID_170', true), ConnectionStatus: S('Connected'),
            ConnectionType: S('IP_Routed', true), AddressingType: S('DHCP', true),
            ExternalIPAddress: S('10.98.0.25', true), SubnetMask: S('255.255.248.0', true),
            DefaultGateway: S('10.98.0.1', true), DNSServers: S('10.98.0.1,192.0.2.53', true),
            NATEnabled: B(false, true), MaxMTUSize: U(1500, true), Uptime: U(245000),
            X_CMCC_ServiceList: S('TR069', true), X_CMCC_VLANIDMark: I(170, true), X_CMCC_VLANMode: I(2, true),
            'X_CMCC_802-1pMark': I(0, true), X_CMCC_IPMode: I(1, true), X_CMCC_LanInterface: S('', true),
            'X_CMCC_LanInterface-DHCPEnable': B(false, true),
          }, true) }, true),
          WANPPPConnection: O({ '2': O({
            Enable: B(true, true), Name: S('1_INTERNET_R_VID_100', true), ConnectionStatus: S('Connected'),
            ConnectionType: S('PPPoE_Routed', true), ConnectionTrigger: S('AlwaysOn', true),
            Username: S(jahat('budi.contoh@sky', 'budi' + X + '@sky'), true), Password: S('', true),
            ExternalIPAddress: S('10.99.1.25'), RemoteIPAddress: S('10.99.0.1'),
            DNSServers: S('192.0.2.53,192.0.2.54'), NATEnabled: B(true, true), MaxMRUSize: U(1480, true),
            Uptime: U(93784),
            X_CMCC_ServiceList: S('INTERNET', true), X_CMCC_VLANIDMark: I(100, true), X_CMCC_VLANMode: I(2, true),
            'X_CMCC_802-1pMark': I(0, true), X_CMCC_IPMode: I(3, true),
            X_CMCC_IPv6ConnStatus: S('Connected'), X_CMCC_IPv6IPAddress: S('2001:db8:10:25::1', true),
            X_CMCC_IPv6Prefix: S('2001:db8:1025::/56', true), X_CMCC_IPv6PrefixOrigin: S('PrefixDelegation', true),
            X_CMCC_IPv6IPAddressOrigin: S('AutoConfigured', true), X_CMCC_IPv6DNSServers: S('2001:db8::53', true),
            X_CMCC_IPv6PrefixDelegationEnabled: B(true, true),
            X_CMCC_LanInterface: S([lanIf(1), lanIf(2), lanIf(3), wlIf(1)].join(','), true),
            'X_CMCC_LanInterface-DHCPEnable': B(true, true),
          }, true) }, true),
        }, true) }, true),
      }) }),
      LANDevice: O({ '1': O({
        LANEthernetInterfaceConfig: O({ '1': O({ Enable: B(true, true), Status: S('Up') }), '2': O({ Enable: B(true, true), Status: S('NoLink') }),
                                        '3': O({ Enable: B(true, true), Status: S('NoLink') }), '4': O({ Enable: B(true, true), Status: S('NoLink') }) }),
        WLANConfiguration: O({
          '1': wlanCmcc(jahat('RUMAH BUDI', 'RUMAH' + X), true, 'WPA/WPA2', 3),
          '2': wlanCmcc('RUMAH BUDI TAMU', false, 'None', 0),
          '3': wlanCmcc('SSID3', false, 'WPA/WPA2', 0),
          '4': wlanCmcc('SSID4', false, 'WPA/WPA2', 0),
        }, true),
        Hosts: O({ Host: O({
          '1': host(jahat('HP-Budi', 'HP' + X), '192.168.1.3', 'DE:AD:BE:00:00:01', '802.11'),
          '2': host('Laptop-Kantor', '192.168.1.4', 'DE:AD:BE:00:00:02', '802.11'),
          '3': host('', '192.168.1.5', 'DE:AD:BE:00:00:03', '802.11'),
          '4': host('TV-Ruang-Tamu', '192.168.1.6', 'DE:AD:BE:00:00:04', 'Ethernet'),
        }) }),
      }) }),
    }),
  };

  // ── 2. F670L (X_ZTE-COM, dua pita) ───────────────────────────────────────
  const klienRadio = (mac, rssi) => O({
    AssociatedDeviceMACAddress: S(mac), 'X_ZTE-COM_WLAN_RSSI': I(rssi), 'X_ZTE-COM_WLAN_SNR': I(rssi + 95),
    'X_ZTE-COM_TXRate': U(144000), 'X_ZTE-COM_RXRate': U(72000), 'X_ZTE-COM_WLAN_ClientMode': S('11ac'),
  });
  const wlanZte = (ssid, aktif, ch, bw, klien) => O({
    Enable: B(aktif, true), SSID: S(ssid, true), BeaconType: S('WPAand11i', true),
    Channel: U(ch, true), AutoChannelEnable: B(false, true), ChannelsInUse: S(String(ch)),
    PossibleChannels: S(ch > 14 ? '36,40,44,48,52,56,60,64,149,153,157,161' : '1-13'),
    Standard: S(ch > 14 ? 'a,n,ac' : 'b,g,n', true), TotalAssociations: U(Object.keys(klien || {}).length),
    TransmitPower: U(100, true), BandWidth: S(bw, true), 'X_ZTE-COM_OperatingChannelBandwidth': S(bw, true),
    WPAAuthenticationMode: S('PSKAuthentication', true), WPAEncryptionModes: S('TKIPandAESEncryption', true),
    IEEE11iAuthenticationMode: S('PSKAuthentication', true), IEEE11iEncryptionModes: S('TKIPandAESEncryption', true),
    KeyPassphrase: S('', true), MaxAssociatedDevices: U(32, true),
    AssociatedDevice: O(klien || {}),
  }, true);
  const pppZte = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';

  const f670 = {
    _id: 'CC22DD-F670L-ZTEGCONTOH0002',
    _deviceId: { _Manufacturer: 'ZTE', _OUI: 'CC22DD', _ProductClass: 'F670L', _SerialNumber: 'ZTEGCONTOH0002' },
    _lastInform: iso(4 * 60 * 1000), _registered: iso(40 * 86400000), _lastBoot: iso(12 * 86400000),
    _tags: ['contoh'],
    VirtualParameters: VP({
      RXPower: '-26.10', getTXPower: '2.20 dBm', gettemp: '58', getponmode: 'GPON', getVlan: '100',
      pppoeUsername: 'siti.contoh@sky', pppoeIP: '10.99.2.40', pppoeMac: 'CC:22:DD:00:20:02',
      PonMac: 'CC:22:DD:00:20:01', IPTR069: '10.99.2.40', activedevices: '5',
      getdeviceuptime: '12d 08:47:23', getpppuptime: '6d 01:00:10', getSerialNumber: 'ZTEGCONTOH0002',
    }),
    InternetGatewayDevice: O({
      DeviceInfo: O({
        HardwareVersion: S('V9.0'), SoftwareVersion: S('V9.0.11P1N84A'), Manufacturer: S('ZTE'),
        ManufacturerOUI: S('CC22DD'), ProductClass: S('F670L'), SerialNumber: S('ZTEGCONTOH0002'),
      }),
      WANDevice: O({ '1': O({
        WANCommonInterfaceConfig: O({ WANAccessType: S('GPON') }),
        WANConnectionDevice: O({ '1': O({
          WANPPPConnection: O({ '1': O({
            Enable: B(true, true), Name: S('INTERNET_TR069_VID_100', true), ConnectionStatus: S('Connected'),
            ConnectionType: S('IP_Routed', true), Username: S('siti.contoh@sky', true), Password: S('', true),
            ExternalIPAddress: S('10.99.2.40'), RemoteIPAddress: S('10.99.0.1'), DNSServers: S('192.0.2.53'),
            NATEnabled: B(true, true), MaxMRUSize: U(1492, true), Uptime: U(522010),
            'X_ZTE-COM_ServiceList': S('TR069,INTERNET', true), 'X_ZTE-COM_VLANID': I(100, true),
            'X_ZTE-COM_VLANEnable': B(true, true), 'X_ZTE-COM_8021P': I(0, true), 'X_ZTE-COM_IPMode': S('IPv4', true),
          }, true) }, true),
        }, true) }, true),
      }) }),
      'X_ZTE-COM_PortBinding': O({ '1': O({
        WANInterface: S(pppZte, true),
        LANInterface: S([lanIf(1), lanIf(2), wlIf(1), wlIf(5)].join(','), true),
      }, true) }, true),
      LANDevice: O({ '1': O({
        LANEthernetInterfaceConfig: O({ '1': O({ Enable: B(true, true) }), '2': O({ Enable: B(true, true) }),
                                        '3': O({ Enable: B(true, true) }), '4': O({ Enable: B(true, true) }) }),
        WLANConfiguration: O({
          '1': wlanZte('KELUARGA SITI', true, 6, '20MHz', { '1': klienRadio('DE:AD:BE:00:01:01', -58) }),
          '2': wlanZte('SSID2', false, 6, '20MHz'),
          '5': wlanZte('KELUARGA SITI 5G', true, 52, '80MHz', {
            '1': klienRadio('DE:AD:BE:00:01:02', -49), '2': klienRadio('DE:AD:BE:00:01:03', -71),
            '3': klienRadio('DE:AD:BE:00:01:04', -83) }),
          '6': wlanZte('SSID6', false, 52, '80MHz'),
        }, true),
        Hosts: O({ Host: O({
          '1': host('Galaxy-A15', '192.168.1.10', 'DE:AD:BE:00:01:01', '802.11'),
          '2': host('iPhone-Siti', '192.168.1.11', 'DE:AD:BE:00:01:02', '802.11'),
          '3': host('Redmi-Note-12', '192.168.1.12', 'DE:AD:BE:00:01:03', '802.11'),
          '4': host('SmartTV', '192.168.1.13', 'DE:AD:BE:00:01:04', '802.11'),
          '5': host('PC-Kasir', '192.168.1.14', 'DE:AD:BE:00:01:05', 'Ethernet'),
        }) }),
      }) }),
    }),
  };

  return [f663, f670];
}

module.exports = { buat };

// Dijalankan langsung: tulis dokumen contoh sebagai berkas JSON ke sebuah folder.
//     node tools/potret-contoh.js <folder> [--xss]
if (require.main === module) {
  const fs = require('fs'), path = require('path');
  const tujuan = process.argv[2];
  if (!tujuan) { console.error('Pemakaian: node tools/potret-contoh.js <folder> [--xss]'); process.exit(2); }
  fs.mkdirSync(tujuan, { recursive: true });
  buat({ xss: process.argv.includes('--xss') }).forEach(d => {
    fs.writeFileSync(path.join(tujuan, d._id + '.json'), JSON.stringify(d));
    console.log('  tulis ' + d._id + '.json');
  });
}
