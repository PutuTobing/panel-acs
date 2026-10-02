/* ═══════════════════════════════════════════════════════════════
   Panel ACS — GenieACS API Client
   All requests go through /api/* which the SPA server proxies
   to GenieACS NBI on port 7557.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const ACS = (() => {
  const BASE = '/api';

  // ─── Safe nested value extractor for GenieACS objects ─────────
  // Walks an object by path and returns ._value of the leaf.
  // e.g. gv(igd, 'DeviceInfo', 'SoftwareVersion') → "V9.0.0P1T8"
  function gv(obj, ...path) {
    let cur = obj;
    for (const key of path) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[key];
    }
    if (cur != null && typeof cur === 'object' && '_value' in cur) return cur._value;
    return cur;
  }

  // ─── Online threshold: device is online if informed within 10 min ──
  // Hosts.Host.Active TIDAK seragam antar-vendor: ZTE/C-DATA melaporkan BOOLEAN,
  // Huawei melaporkan ANGKA 1/0. Satu helper dipakai SEMUA penghitung klien (hostList,
  // lanClients, wlanClients) — dulu masing-masing punya cek sendiri, dan wlanClients
  // (dipakai panel Topologi) tertinggal → jumlah WiFi di Topologi beda dgn daftar
  // Perangkat Terhubung. Param ABSEN → dianggap aktif (perilaku lama).
  function hostActive(v) {
    return !(v === false || v === 0 || v === '0' || String(v).toLowerCase() === 'false');
  }

  function isOnline(raw) {
    if (!raw._lastInform) return false;
    const mins = (getConfig().onlineThresholdMin || 10);
    return (Date.now() - new Date(raw._lastInform).getTime()) < mins * 60 * 1000;
  }

  // ─── Relative timestamp formatter ─────────────────────────────
  function relTime(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60)    return `${s} detik lalu`;
    if (s < 3600)  return `${Math.floor(s / 60)} menit lalu`;
    if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
    return `${Math.floor(s / 86400)} hari lalu`;
  }

  // ─── Date formatter (for registered) ──────────────────────────
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // ─── Parse all WAN connections from raw GenieACS device ─────────────────
  // Nama node tabel Port Binding di root InternetGatewayDevice (ZTE F679L/F670L).
  const PORT_BINDING_NODE = 'X_ZTE-COM_PortBinding';

  function parseWanConnections(raw) {
    const igd  = raw.InternetGatewayDevice || {};
    const wan1 = ((igd.WANDevice || {})['1']) || {};
    const wcdAll = wan1.WANConnectionDevice || {};
    const conns = [];

    // Type-safe extractors: gv() can return a GenieACS metadata object
    // {_object,_timestamp,_writable} when a parameter has no _value yet.
    // These helpers coerce to proper JS primitives.
    const gs  = v => (v != null && typeof v !== 'object') ? String(v) : '';
    const gi  = (v, d) => { const n = parseInt(v); return isNaN(n) ? (d || 0) : n; };
    const gb  = v => gs(v).toUpperCase() === 'TRUE';
    // has(): true bila parameter punya nilai primitif nyata (bukan null / objek
    // metadata GenieACS kosong). Dipakai untuk fallback baca ZTE(X_CMCC) → C-DATA(X_CT-COM).
    const has = v => v != null && typeof v !== 'object';
    // gvx(): baca param dgn fallback vendor — X_CMCC (ZTE) dulu, kalau absen X_CT-COM (C-DATA).
    // ZTE (X_CMCC ada) → byte-identik. C-DATA (X_CMCC absen) → pakai X_CT-COM.
    // gvx: coba beberapa nama param berurutan, kembalikan nilai pertama yang ADA
    // (has = non-null & bukan objek). Bila tak ada yang cocok, kembalikan nilai nama
    // TERAKHIR (perilaku identik versi 2-arg lama). Dipakai lintas-vendor: X_CMCC (ZTE)
    // vs X_CT-COM (C-DATA/HWTC), termasuk leaf yang namanya beda antar-firmware CT-COM
    // (mis. IPv6 status: C-DATA 'X_CT-COM_IPv6ConnStatus' vs HWTC 'X_CT-COM_IPv6ConnectionStatus').
    const gvx = (x, ...names) => {
      for (let i = 0; i < names.length; i++) { const v = gv(x, names[i]); if (has(v)) return v; }
      return gv(x, names[names.length - 1]);
    };
    // Fallback VLAN dari NAMA koneksi (konvensi ISP '..._R_VID_<vlan>'). Sebagian firmware
    // (mis. HWTC-EPON Realtek RTL960x) TIDAK mengekspos nilai VLAN via parameter TR-069 apa
    // pun — leaf X_CT-COM_VLANIDMark tetap kosong walau di-Summon; satu-satunya sumber ter-
    // baca = VID di Name (yang juga yang tampil di GenieACS). Dipakai HANYA bila tak ada
    // nilai VLAN dari parameter (vlanId=0) → vendor lain (ZTE/C-DATA) tak terpengaruh.
    // IPMode lintas-vendor. X_CMCC/X_CT-COM/X_CU = INTEGER (1=IPv4, 2=IPv6, 3=dualstack).
    // X_ZTE-COM (F679L/F670L) = STRING ('IPv4'/'IPv6'/'Both') → petakan ke angka yang sama
    // agar UI (kartu WAN & form) memakai satu konvensi. Tak dikenal → 1 (IPv4), spt semula.
    const ipModeNum = (v) => {
      if (v == null || typeof v === 'object') return 1;
      const s = String(v).trim().toLowerCase();
      if (s === 'both') return 3;
      if (s === 'ipv6') return 2;
      if (s === 'ipv4') return 1;
      const n = parseInt(v);
      return isNaN(n) ? 1 : n;
    };

    // Huawei (X_HW): IPv6 tak berupa leaf X_*_IPv6IPAddress, melainkan sub-tabel
    // X_HW_IPv6.{IPv6Address.1.IPAddress, IPv6Prefix.1.Prefix, ...}; mode IP ditentukan
    // sepasang boolean X_HW_IPv4Enable/X_HW_IPv6Enable (bukan satu leaf IPMode).
    const hwV6 = (c, ...path) => gv(c, 'X_HW_IPv6', ...path);
    const hwIpMode = (c) => {
      const v4 = gv(c, 'X_HW_IPv4Enable'), v6 = gv(c, 'X_HW_IPv6Enable');
      if (v4 == null && v6 == null) return null;      // bukan Huawei → biarkan jalur lama
      const on4 = gb(v4), on6 = gb(v6);
      return on4 && on6 ? 3 : on6 ? 2 : 1;
    };

    const vidFromName = (nm) => { const m = /_VID_(\d+)/i.exec(String(nm || '')); return m ? parseInt(m[1], 10) : 0; };

    // ─── BINDING BOOLEAN (X_HW — Huawei HG8245A/H) ───
    // Skema binding KETIGA. Vendor lain memakai SATU string berisi path dipisah koma
    // (X_CMCC_LanInterface dst) atau tabel Port Binding (X_ZTE-COM). Huawei memakai sub-node
    // di dalam koneksi berisi leaf BOOLEAN per port: X_HW_LANBIND.{Lan1..NEnable, SSID1..MEnable}.
    // Diterjemahkan ke string path yang sama seperti vendor lain → UI binding dipakai ulang
    // apa adanya; penulisannya dikembalikan lagi ke boolean (lihat device-detail).
    const LANBIND_NODE = 'X_HW_LANBIND';
    // TIPE leaf-nya ikut dicatat: HG8245A melaporkan xsd:boolean, HG8245W5-6T (firmware
    // V5, diukur 2026-10-01 SN 485754432B16F9AE) melaporkan xsd:unsignedInt 1/0. Penulis
    // binding memakai tipe ini — sama alasannya dengan koreksi IPMode HWTC: salah tipe
    // bisa membuat ONU menolak seluruh perintah.
    const lanBindRead = (c) => {
      const node = c && c[LANBIND_NODE];
      if (!node || typeof node !== 'object') return null;
      const slots = { eth: [], wlan: [] }, on = [];
      let type = null;
      Object.keys(node).filter(k => k[0] !== '_').forEach(k => {
        const mE = /^Lan(\d+)Enable$/.exec(k), mS = /^SSID(\d+)Enable$/.exec(k);
        if (!mE && !mS) return;
        const n = parseInt(mE ? mE[1] : mS[1]);
        const path = 'InternetGatewayDevice.LANDevice.1.'
                   + (mE ? 'LANEthernetInterfaceConfig.' : 'WLANConfiguration.') + n;
        (mE ? slots.eth : slots.wlan).push(n);
        if (!type && node[k] && node[k]._type) type = node[k]._type;
        // gb() hanya mengenali 'true'. Firmware V5 melapor 1/0 → tanpa ini SEMUA
        // checkbox binding tampil kosong, dan Simpan berikutnya mencabut binding
        // yang sebenarnya aktif di ONU.
        const sv = gs(gv(node, k)).toUpperCase();
        if (sv === 'TRUE' || sv === '1') on.push(path);
      });
      slots.eth.sort((a, b) => a - b); slots.wlan.sort((a, b) => a - b);
      return { node: LANBIND_NODE, slots, type, lan: on.join(',') };
    };

    // ─── TABEL PORT BINDING (X_ZTE-COM — F679L/F670L) ───
    // Vendor lain (ZTE X_CMCC, C-DATA/HWTC X_CT-COM, F9V X_CU) menyimpan binding LAN
    // sebagai SATU param DI DALAM koneksi (X_CMCC_LanInterface dst). ZTE F679L memakai
    // TABEL TERPISAH di root: X_ZTE-COM_PortBinding.{i}.{WANInterface,LANInterface} —
    // persis menu "Port Binding" di web ONU. Isinya sama-sama daftar path LAN/WLAN
    // dipisah koma, jadi peta ini cukup mengisi conn.lanInterface seperti vendor lain
    // (UI binding yang sudah ada langsung bisa dipakai ulang) + conn.portBindingIdx
    // sebagai alamat tulisnya. Perangkat tanpa tabel ini → peta kosong (byte-identik).
    const pbTable = igd[PORT_BINDING_NODE] || {};
    const pbByWan = {};
    Object.keys(pbTable).filter(k => k[0] !== '_').forEach(pbIdx => {
      const e = pbTable[pbIdx];
      if (!e || typeof e !== 'object') return;
      const wanPath = gs(gv(e, 'WANInterface'));
      if (!wanPath) return;
      pbByWan[wanPath] = { idx: parseInt(pbIdx), lan: gs(gv(e, 'LANInterface')) };
    });

    Object.keys(wcdAll).filter(k => k[0] !== '_').forEach(wcdIdx => {
      const wcd = wcdAll[wcdIdx];
      if (!wcd || typeof wcd !== 'object') return;
      // C-DATA (X_CT-COM): VLAN berada di node SAUDARA koneksi ini, bukan di bawah
      // WANPPPConnection/WANIPConnection seperti ZTE X_CMCC_VLANIDMark. Nama node
      // bergantung TIPE PON perangkat: EPON → X_CT-COM_WANEponLinkConfig, GPON →
      // X_CT-COM_WANGponLinkConfig (model FD512XW-R460 ada varian EPON & GPON!).
      // Deteksi mana yang ADA di pohon; simpan namanya di conn.vlanNode utk penulisan.
      const linkNodeName = wcd['X_CT-COM_WANGponLinkConfig'] ? 'X_CT-COM_WANGponLinkConfig'
                         : wcd['X_CT-COM_WANEponLinkConfig'] ? 'X_CT-COM_WANEponLinkConfig'
                         : null;
      const epon = (linkNodeName ? wcd[linkNodeName] : null) || {};
      // (E) X_CU (China Unicom — F9V ETCH/FOTC): VLAN bukan node anak & bukan pada
      // koneksi, melainkan LEAF LANGSUNG di WANConnectionDevice: X_CU_VLAN (unsignedInt,
      // writable) + X_CU_VLANEnabled + X_CU_802_1p. Tandai agar penulis push ke base WCD.
      const vlanOnWcd = (!linkNodeName && wcd && ('X_CU_VLAN' in wcd)) ? 'X_CU' : null;

      // PPP Connections (PPPoE)
      const pppConns = wcd.WANPPPConnection || {};
      Object.keys(pppConns).filter(k => k[0] !== '_').forEach(pppIdx => {
        const ppp = pppConns[pppIdx];
        if (!ppp || typeof ppp !== 'object') return;
        const base = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wcdIdx}.WANPPPConnection.${pppIdx}`;
        const pppName = gs(gv(ppp, 'Name'));
        // VLAN 3 skema: (A) X_CMCC pada koneksi (ZTE); (B) node saudara Epon/Gpon
        // (C-DATA & HWTC-GPON); (C) X_CT-COM_VLANIDMark PADA koneksi (HWTC-EPON). Prioritas
        // A→B→C, lalu fallback (D) VID dari Name bila semua param kosong (HWTC-EPON Realtek).
        let pppVlan = has(gv(ppp, 'X_CMCC_VLANIDMark')) ? gi(gv(ppp, 'X_CMCC_VLANIDMark'), 0)
                    : has(gv(epon, 'VLANIDMark'))       ? gi(gv(epon, 'VLANIDMark'), 0)
                    : has(gv(ppp, 'X_CT-COM_VLANIDMark')) ? gi(gv(ppp, 'X_CT-COM_VLANIDMark'), 0)
                    : has(gv(ppp, 'X_ZTE-COM_VLANID'))    ? gi(gv(ppp, 'X_ZTE-COM_VLANID'), 0)   // (F) X_ZTE-COM: VLAN pada koneksi
                    : has(gv(ppp, 'X_HW_VLAN'))           ? gi(gv(ppp, 'X_HW_VLAN'), 0)          // (G) X_HW (Huawei): VLAN pada koneksi
                    : gi(gv(wcd, 'X_CU_VLAN'), 0);   // (E) X_CU: VLAN leaf di WCD
        if (!pppVlan) pppVlan = vidFromName(pppName);
        conns.push({
          wcdIdx:    parseInt(wcdIdx),
          type:      'ppp',
          connIdx:   parseInt(pppIdx),
          basePath:  base,
          name:             pppName,
          enable:           gb(gv(ppp, 'Enable')),
          connectionType:   gs(gv(ppp, 'ConnectionType'))    || 'PPPoE_Routed',
          connectionStatus: gs(gv(ppp, 'ConnectionStatus')),
          connectionTrigger:gs(gv(ppp, 'ConnectionTrigger')) || 'AlwaysOn',
          serviceList: gs(gvx(ppp, 'X_CMCC_ServiceList', 'X_CT-COM_ServiceList', 'X_CU_ServiceList', 'X_ZTE-COM_ServiceList', 'X_HW_SERVICELIST')),
          vlanId:   pppVlan,
          vlanMode: has(gv(ppp, 'X_CMCC_VLANMode')) ? gi(gv(ppp, 'X_CMCC_VLANMode'), 2)
                  : has(gv(epon, 'Mode'))           ? gi(gv(epon, 'Mode'), 2)
                  : gi(gv(ppp, 'X_CT-COM_VLANMode'), 2),
          vlanNode:  linkNodeName,   // node PON saudara terdeteksi (Epon/Gpon) — null utk ZTE & HWTC-EPON
          // HWTC-EPON: VLAN pada koneksi berprefix X_CT-COM (bukan node saudara) → tandai
          // prefix agar penulis (device-detail) push ke koneksi, bukan node link.
          vlanOnConn: (!linkNodeName && ppp && typeof ppp === 'object' && ('X_CT-COM_VLANIDMark' in ppp)) ? 'X_CT-COM' : null,
          vlanOnWcd:  vlanOnWcd,   // (E) X_CU: VLAN = leaf X_CU_VLAN di base WCD
          cos:       gi(gvx(ppp, 'X_CMCC_802-1pMark', 'X_ZTE-COM_8021P', 'X_HW_PRI'),  0),
          nat:       gb(gv(ppp, 'NATEnabled')),
          mtu:       gi(gv(ppp, 'MaxMRUSize'), 1480),
          username:         gs(gv(ppp, 'Username')),
          pppoeServiceName: gs(gv(ppp, 'PPPoEServiceName')),
          pppoeAcName:      gs(gv(ppp, 'PPPoEACName')),
          externalIp:       gs(gv(ppp, 'ExternalIPAddress')),
          remoteIp:         gs(gv(ppp, 'RemoteIPAddress')),
          dnsServers:       gs(gv(ppp, 'DNSServers')),
          uptime:    gi(gv(ppp, 'Uptime'), 0),
          ipMode:    hwIpMode(ppp) != null ? hwIpMode(ppp)
                   : ipModeNum(gvx(ppp, 'X_CMCC_IPMode', 'X_CT-COM_IPMode', 'X_CU_IPMode', 'X_ZTE-COM_IPMode')),
          ipv6ConnStatus:   gs(gvx(ppp, 'X_CMCC_IPv6ConnStatus', 'X_CT-COM_IPv6ConnStatus', 'X_CT-COM_IPv6ConnectionStatus', 'X_CU_IPv6ConnStatus', 'X_ZTE-COM_IPv6ConnStatus')),
          ipv6Ip:           gs(has(gvx(ppp, 'X_CMCC_IPv6IPAddress', 'X_CT-COM_IPv6IPAddress', 'X_CU_IPv6IPAddress', 'X_ZTE-COM_ExternalIPv6Address'))
                              ? gvx(ppp, 'X_CMCC_IPv6IPAddress', 'X_CT-COM_IPv6IPAddress', 'X_CU_IPv6IPAddress', 'X_ZTE-COM_ExternalIPv6Address')
                              : hwV6(ppp, 'IPv6Address', '1', 'IPAddress')),
          ipv6Prefix:       gs(has(gvx(ppp, 'X_CMCC_IPv6Prefix', 'X_CT-COM_IPv6Prefix', 'X_CU_IPv6Prefix', 'X_ZTE-COM_PD'))
                              ? gvx(ppp, 'X_CMCC_IPv6Prefix', 'X_CT-COM_IPv6Prefix', 'X_CU_IPv6Prefix', 'X_ZTE-COM_PD')
                              : hwV6(ppp, 'IPv6Prefix', '1', 'Prefix')),
          ipv6PrefixOrigin: gs(gvx(ppp, 'X_CMCC_IPv6PrefixOrigin', 'X_CT-COM_IPv6PrefixOrigin', 'X_CU_IPv6PrefixOrigin')),
          ipv6IpOrigin:     gs(gvx(ppp, 'X_CMCC_IPv6IPAddressOrigin', 'X_CT-COM_IPv6IPAddressOrigin', 'X_CU_IPv6IPAddressOrigin', 'X_ZTE-COM_IPv6AcquireMode')),
          ipv6Dns:          gs(gvx(ppp, 'X_CMCC_IPv6DNSServers', 'X_CT-COM_IPv6DNSServers', 'X_CU_IPv6DNSServers', 'X_ZTE-COM_IPv6DNSServers')),
          ipv6Gateway:      gs(gvx(ppp, 'X_CMCC_DefaultIPv6Gateway', 'X_CT-COM_DefaultIPv6Gateway', 'X_CU_DefaultIPv6Gateway')),
          ipv6LinkLocal:    gs(gv(ppp, 'X_ZTE-COM_LLA')),
          ipv6PfxDelegate:  gb(gvx(ppp, 'X_CMCC_IPv6PrefixDelegationEnabled', 'X_CT-COM_IPv6PrefixDelegationEnabled', 'X_CU_IPv6PrefixDelegationEnabled')),
          // gb() = false juga untuk nilai yang BELUM PERNAH DIBACA. Penanda ini membedakan
          // "ONU melapor mati" dari "belum tahu" (dipakai peringatan di form Edit WAN).
          ipv6PfxDelegateOff: (function() {
            var x = gvx(ppp, 'X_CMCC_IPv6PrefixDelegationEnabled', 'X_CT-COM_IPv6PrefixDelegationEnabled', 'X_CU_IPv6PrefixDelegationEnabled');
            return x != null && typeof x !== 'object' && /^(false|0)$/i.test(String(x));
          })(),
          lanInterface:     gs(gvx(ppp, 'X_CMCC_LanInterface', 'X_CT-COM_LanInterface', 'X_CU_LanInterface')),
          lanBind:          lanBindRead(ppp),   // Huawei X_HW_LANBIND (boolean per port); null di vendor lain
          dhcpEnabled:      gb(gvx(ppp, 'X_CMCC_LanInterface-DHCPEnable', 'X_CT-COM_LanInterface-DHCPEnable', 'X_CU_LanInterface-DHCPEnable')),
        });
      });

      // IP Connections (DHCP/static)
      const ipConns = wcd.WANIPConnection || {};
      Object.keys(ipConns).filter(k => k[0] !== '_').forEach(ipIdx => {
        const ip = ipConns[ipIdx];
        if (!ip || typeof ip !== 'object') return;
        const base = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wcdIdx}.WANIPConnection.${ipIdx}`;
        const ipName = gs(gv(ip, 'Name'));
        // VLAN 3 skema (lihat blok PPP): A=X_CMCC koneksi (ZTE); B=node saudara Epon/Gpon;
        // C=X_CT-COM_VLANIDMark pada koneksi (HWTC-EPON). A→B→C, lalu D=VID dari Name.
        let ipVlan = has(gv(ip, 'X_CMCC_VLANIDMark')) ? gi(gv(ip, 'X_CMCC_VLANIDMark'), 0)
                   : has(gv(epon, 'VLANIDMark'))      ? gi(gv(epon, 'VLANIDMark'), 0)
                   : has(gv(ip, 'X_CT-COM_VLANIDMark')) ? gi(gv(ip, 'X_CT-COM_VLANIDMark'), 0)
                   : has(gv(ip, 'X_ZTE-COM_VLANID'))    ? gi(gv(ip, 'X_ZTE-COM_VLANID'), 0)   // (F) X_ZTE-COM
                   : has(gv(ip, 'X_HW_VLAN'))           ? gi(gv(ip, 'X_HW_VLAN'), 0)          // (G) X_HW (Huawei)
                   : gi(gv(wcd, 'X_CU_VLAN'), 0);   // (E) X_CU: VLAN leaf di WCD
        if (!ipVlan) ipVlan = vidFromName(ipName);
        conns.push({
          wcdIdx:    parseInt(wcdIdx),
          type:      'ip',
          connIdx:   parseInt(ipIdx),
          basePath:  base,
          name:             ipName,
          enable:           gb(gv(ip, 'Enable')),
          connectionType:   gs(gv(ip, 'ConnectionType'))    || 'IP_Routed',
          connectionStatus: gs(gv(ip, 'ConnectionStatus')),
          connectionTrigger:gs(gv(ip, 'ConnectionTrigger')) || 'AlwaysOn',
          serviceList: gs(gvx(ip, 'X_CMCC_ServiceList', 'X_CT-COM_ServiceList', 'X_CU_ServiceList', 'X_ZTE-COM_ServiceList', 'X_HW_SERVICELIST')),
          vlanId:   ipVlan,
          vlanMode: has(gv(ip, 'X_CMCC_VLANMode')) ? gi(gv(ip, 'X_CMCC_VLANMode'), 2)
                  : has(gv(epon, 'Mode'))          ? gi(gv(epon, 'Mode'), 2)
                  : gi(gv(ip, 'X_CT-COM_VLANMode'), 2),
          vlanNode:  linkNodeName,   // node PON saudara terdeteksi (Epon/Gpon) — null utk ZTE & HWTC-EPON
          vlanOnConn: (!linkNodeName && ip && typeof ip === 'object' && ('X_CT-COM_VLANIDMark' in ip)) ? 'X_CT-COM' : null,
          vlanOnWcd:  vlanOnWcd,   // (E) X_CU: VLAN = leaf X_CU_VLAN di base WCD
          cos:       gi(gvx(ip, 'X_CMCC_802-1pMark', 'X_ZTE-COM_8021P', 'X_HW_PRI'),  0),
          nat:       gb(gv(ip, 'NATEnabled')),
          mtu:       gi(gv(ip, 'MaxMTUSize'), 1500),
          addressingType:   gs(gv(ip, 'AddressingType')) || 'DHCP',
          externalIp:       gs(gv(ip, 'ExternalIPAddress')),
          subnetMask:       gs(gv(ip, 'SubnetMask')),
          gateway:          gs(gv(ip, 'DefaultGateway')),
          dnsServers:       gs(gv(ip, 'DNSServers')),
          uptime:    gi(gv(ip, 'Uptime'), 0),
          ipMode:    hwIpMode(ip) != null ? hwIpMode(ip)
                   : ipModeNum(gvx(ip, 'X_CMCC_IPMode', 'X_CT-COM_IPMode', 'X_CU_IPMode', 'X_ZTE-COM_IPMode')),
          ipv6ConnStatus:   gs(gvx(ip, 'X_CMCC_IPv6ConnStatus', 'X_CT-COM_IPv6ConnStatus', 'X_CT-COM_IPv6ConnectionStatus', 'X_CU_IPv6ConnStatus', 'X_ZTE-COM_IPv6ConnStatus')),
          ipv6Ip:           gs(has(gvx(ip, 'X_CMCC_IPv6IPAddress', 'X_CT-COM_IPv6IPAddress', 'X_CU_IPv6IPAddress', 'X_ZTE-COM_ExternalIPv6Address'))
                              ? gvx(ip, 'X_CMCC_IPv6IPAddress', 'X_CT-COM_IPv6IPAddress', 'X_CU_IPv6IPAddress', 'X_ZTE-COM_ExternalIPv6Address')
                              : hwV6(ip, 'IPv6Address', '1', 'IPAddress')),
          ipv6Prefix:       gs(has(gvx(ip, 'X_CMCC_IPv6Prefix', 'X_CT-COM_IPv6Prefix', 'X_CU_IPv6Prefix', 'X_ZTE-COM_PD'))
                              ? gvx(ip, 'X_CMCC_IPv6Prefix', 'X_CT-COM_IPv6Prefix', 'X_CU_IPv6Prefix', 'X_ZTE-COM_PD')
                              : hwV6(ip, 'IPv6Prefix', '1', 'Prefix')),
          ipv6PrefixOrigin: gs(gvx(ip, 'X_CMCC_IPv6PrefixOrigin', 'X_CT-COM_IPv6PrefixOrigin', 'X_CU_IPv6PrefixOrigin')),
          ipv6IpOrigin:     gs(gvx(ip, 'X_CMCC_IPv6IPAddressOrigin', 'X_CT-COM_IPv6IPAddressOrigin', 'X_CU_IPv6IPAddressOrigin', 'X_ZTE-COM_IPv6AcquireMode')),
          ipv6Dns:          gs(gvx(ip, 'X_CMCC_IPv6DNSServers', 'X_CT-COM_IPv6DNSServers', 'X_CU_IPv6DNSServers', 'X_ZTE-COM_IPv6DNSServers')),
          lanInterface:     gs(gvx(ip, 'X_CMCC_LanInterface', 'X_CT-COM_LanInterface', 'X_CU_LanInterface')),
          lanBind:          lanBindRead(ip),   // Huawei X_HW_LANBIND (boolean per port); null di vendor lain
          dhcpEnabled:      gb(gvx(ip, 'X_CMCC_LanInterface-DHCPEnable', 'X_CT-COM_LanInterface-DHCPEnable', 'X_CU_LanInterface-DHCPEnable')),
        });
      });
    });

    // Binding dari tabel Port Binding → conn.lanInterface (format sama: path dipisah koma)
    // + alamat tulisnya (portBindingIdx). Perangkat tanpa tabel: peta kosong → tak berubah.
    conns.forEach(c => {
      const e = pbByWan[c.basePath];
      if (e) { c.lanInterface = e.lan; c.portBindingIdx = e.idx; }
      // Huawei: boolean per port → string path (format vendor lain) + alamat tulisnya.
      if (c.lanBind) {
        c.lanInterface  = c.lanBind.lan;
        c.lanBindNode   = c.lanBind.node;
        c.lanBindSlots  = c.lanBind.slots;
        c.lanBindType   = c.lanBind.type;
      }
      delete c.lanBind;
    });

    // Sort: by WCD index first, then by connection type (ip before ppp → TR069 first),
    // then by connection index.
    return conns.sort((a, b) => {
      if (a.wcdIdx !== b.wcdIdx) return a.wcdIdx - b.wcdIdx;
      // ip (TR069/DHCP) before ppp (INTERNET/PPPoE) within same WCD
      if (a.type !== b.type) return a.type === 'ip' ? -1 : 1;
      return a.connIdx - b.connIdx;
    });
  }

  // ─── Map raw GenieACS device → panel-internal device object ───
  function mapDevice(raw) {
    if (!raw) return null;
    const did  = raw._deviceId || {};
    const igd  = raw.InternetGatewayDevice || {};
    const vp   = raw.VirtualParameters || {};
    const di   = igd.DeviceInfo || {};
    const wan1 = ((igd.WANDevice || {})['1']) || {};
    const wcd1 = ((wan1.WANConnectionDevice || {})['1']) || {};
    const ppp1 = ((wcd1.WANPPPConnection || {})['1']) || {};
    const gpon = wan1.X_CMCC_GponInterfaceConfig || {};
    const wlan = ((igd.LANDevice || {})['1'] || {}).WLANConfiguration || {};

    /* ── Pemetaan VirtualParameter ─────────────────────────────────
       pm(kunci, lama) = "pakai rantai kandidat; kalau seluruhnya kosong,
       pakai perilaku lama". Kandidat PERTAMA tiap field memang sama persis
       dengan perilaku lama itu, jadi nilai yang selama ini tampil tidak pernah
       berubah — yang berubah hanya field yang tadinya '—' menjadi terisi.

       Argumen `lama` sengaja tetap dihitung: kalau vpmap.js gagal dimuat,
       panel jatuh ke perilaku lama, bukan ke halaman kosong. */
    const pm = function (kunci, lama) {
      try {
        if (typeof VPMap !== 'undefined') {
          const v = VPMap.nilai(raw, kunci);
          if (v !== null && v !== undefined && String(v).trim() !== '') return v;
        }
      } catch (_) { /* jatuh ke perilaku lama */ }
      return lama;
    };

    // Serial number: UTAMAKAN DeviceID.SerialNumber (_deviceId._SerialNumber) —
    // sumber otoritatif & bersih dari Inform DeviceIdStruct, selalu ada di tiap query.
    // _id GenieACS meng-encode '-' internal komponen jadi '%2D' (mis. C-DATA
    // '505B1D-FD512XW%2DR460-DF1D%2D2412014404') → parsing SN dari _id menghasilkan
    // 'DF1D%2D2412014404' (tak jelas). Fallback _id tetap disediakan tapi %2D di-decode.
    const idParts  = (raw._id || '').split('-');
    const idSerial = idParts.slice(2).join('-').replace(/%2D/gi, '-');
    const serial   = pm('serial',
                        did._SerialNumber || gv(di, 'SerialNumber')
                        || gv(vp, 'getSerialNumber') || idSerial) || '';

    // Tags from GenieACS _tags array
    const tagsArr = Array.isArray(raw._tags) ? raw._tags : [];
    const tags    = tagsArr.join(' ');

    // ODP tag (format: ODP-xxx)
    const odp = tagsArr.find(t => /^ODP-/i.test(t)) || '—';

    // RX Power from VP (already in dBm, e.g. "-23.57 dBm")
    const rxStr = String(pm('rxPower', gv(vp, 'RXPower')) || '');
    const rx    = parseFloat(rxStr);

    // Temperature (integer °C from VP)
    const temp = parseFloat(pm('suhu', gv(vp, 'gettemp'))) || 0;

    // Data-model root (TR-098 InternetGatewayDevice vs TR-181 Device) —
    // used for vendor-agnostic summon/refresh (refreshObject on the right root).
    const root = raw.Device ? 'Device' : 'InternetGatewayDevice';

    // ── Band SSID dari NOMOR SLOT (vendor slot-tetap dual-band) ───────────────
    // is5GHz() menebak band dari Channel (>=36), nama ('5G'), atau Standard (ac/ax).
    // Pada HWTC ZL-4224X ketiganya BUNTU: Channel=0 (auto), Standard/RFBand tak
    // diekspos, dan SSID 5G bawaan bisa bernama SAMA dgn yang 2.4G (slot 1 & 5 =
    // 'BTD-TEAM YOGA') → radio 5G salah dibaca 2.4G. Firmware slot-tetap menaruh band
    // pada nomor slot (1-4 = 2.4G, 5-8 = 5G), jadi profil vendor boleh menyatakannya
    // lewat band5MinIdx. Vendor tanpa band5MinIdx (mis. ZTE) → band5 undefined →
    // is5GHz() memakai heuristik lama, byte-identik.
    let _band5Min = 0;
    try {
      const _sc = (typeof getVendorSecurityConfig === 'function')
        ? getVendorSecurityConfig(did._ProductClass || gv(di, 'ProductClass') || '',
                                  did._OUI || gv(di, 'ManufacturerOUI') || '',
                                  did._Manufacturer || gv(di, 'Manufacturer') || '')
        : null;
      if (_sc && _sc.band5MinIdx > 0) _band5Min = _sc.band5MinIdx;
    } catch (_) { /* profil tak tersedia → heuristik lama */ }

    return {
      // Identity
      id:           raw._id     || '',
      serial,
      tags,
      root,
      model:        did._ProductClass  || gv(di, 'ProductClass')  || '—',
      mfr:          did._Manufacturer  || gv(di, 'Manufacturer')  || '—',
      oui:          did._OUI           || gv(di, 'ManufacturerOUI') || '—',
      odp,

      // Signal
      rx:           isNaN(rx) ? '—' : rx.toFixed(2),
      rxRaw:        rxStr,
      temp,
      tx:           pm('txPower', gv(vp, 'getTXPower')) || '',   // TX Power (kosong bila model tak mengeksposnya)
      ponMode:      pm('ponMode', gv(vp, 'getponmode') || gv(wan1, 'WANCommonInterfaceConfig', 'WANAccessType')) || 'GPON',

      // Status
      online:       isOnline(raw),
      lastInform:   relTime(raw._lastInform),
      lastInformRaw: raw._lastInform || '',
      registered:   fmtDate(raw._registered),
      registeredRaw: raw._registered || '',
      lastBootRaw:  raw._lastBoot || '',

      // PPPoE / WAN
      pppoe:        pm('pppoeUser', gv(vp, 'pppoeUsername') || gv(ppp1, 'Username')) || '—',
      pppoePass:    pm('pppoePass', gv(vp, 'pppoePassword')) || '',
      ip:           pm('ipPppoe', gv(vp, 'pppoeIP') || gv(ppp1, 'ExternalIPAddress')) || '—',
      vlan:         pm('vlan', gv(vp, 'getVlan')) || '—',

      // WiFi
      ssid:         gv(wlan, '1', 'SSID')   || '—',
      ssid2:        gv(wlan, '2', 'SSID')   || '—',
      ssid3:        gv(wlan, '3', 'SSID')   || '—',
      wlanPass:     pm('wlanPass', gv(vp, 'WlanPassword')) || '',

      // Device info
      hwVer:        gv(di, 'HardwareVersion') || '—',
      swVer:        gv(di, 'SoftwareVersion') || '—',
      uptime:       pm('uptime', gv(vp, 'getdeviceuptime')) || '—',
      pppUptime:    pm('pppUptime', gv(vp, 'getpppuptime')) || '—',
      aktifDevice:  parseInt(pm('klienAktif', gv(vp, 'activedevices'))) || 0,

      // Network
      ponMac:       pm('ponMac', gv(vp, 'PonMac')) || '—',
      pppoeMac:     pm('pppoeMac', gv(vp, 'pppoeMac')) || '—',
      iptr069:      pm('ipTr069', gv(vp, 'IPTR069')) || '—',

      // All WAN connections (from all WANConnectionDevice instances)
      wanConnections: parseWanConnections(raw),

      /* ── Umur data per field ──────────────────────────────────
         GenieACS menyimpan `_timestamp` pada tiap leaf. Membawanya sampai ke
         UI adalah cara termurah mengurangi beban ONU yang kita punya: teknisi
         menekan Refresh terutama karena RAGU apakah angka di layar masih
         benar. Begitu layar mengatakan "3 menit lalu", keraguannya hilang dan
         kliknya tidak terjadi — nol perintah ke ONU.

         Diambil dari sumber yang BENAR-BENAR dipakai (kandidat keberapa pun
         yang menang), bukan dari kandidat pertama. */
      umur: (function () {
        try {
          return (typeof VPMap !== 'undefined') ? VPMap.umurSemua(raw) : {};
        } catch (_) { return {}; }
      })(),

      // Root tabel Port Binding (ZTE F679L/F670L) — null pada vendor lain, yang menyimpan
      // binding LAN sebagai param di dalam koneksi. Dipakai penulis binding di device-detail.
      portBindingRoot: igd[PORT_BINDING_NODE] ? ('InternetGatewayDevice.' + PORT_BINDING_NODE) : null,

      // Number of LAN Ethernet ports and SSID slots
      lanEthCount: (() => {
        const eth = (((igd.LANDevice || {})['1'] || {}).LANEthernetInterfaceConfig) || {};
        return Object.keys(eth).filter(k => k[0] !== '_').length || 4;
      })(),

      // LAN/WLAN client breakdown from Hosts table
      lanClients:   (() => {
        const h = (((igd.LANDevice || {})['1'] || {}).Hosts || {}).Host;
        if (!h || typeof h !== 'object') return -1; // -1 = no data
        return Object.values(h).filter(e =>
          e && typeof e === 'object' && hostActive(gv(e, 'Active')) &&
          String(gv(e, 'InterfaceType') || '') === 'Ethernet'
        ).length;
      })(),
      wlanClients:  (() => {
        const h = (((igd.LANDevice || {})['1'] || {}).Hosts || {}).Host;
        if (!h || typeof h !== 'object') return -1; // -1 = no data
        return Object.values(h).filter(e => {
          if (!e || typeof e !== 'object' || !hostActive(gv(e, 'Active'))) return false;
          // C-DATA kadang tak isi InterfaceType tapi ada X_CMS_WirelessTerminal (band) → nirkabel.
          // HWTC ZL-2113X memakai InterfaceType='WLAN' (bukan '802.11') → nirkabel juga.
          const wt = gv(e, 'X_CMS_WirelessTerminal');
          const it = String(gv(e, 'InterfaceType') || '');
          return it === '802.11' || /^WLAN/i.test(it) ||
                 (wt != null && String(wt).trim() !== '');
        }).length;
      })(),

      // Real SSID list: array of {idx, name, enabled, channel, ...}
      ssids: (() => {
        const wlanConf = ((igd.LANDevice || {})['1'] || {}).WLANConfiguration || {};
        // gv() mengembalikan OBJEK metadata ({_writable,_type} tanpa _value) untuk leaf
        // yang dikenal tetapi belum pernah DIBACA. Diukur 2026-10-02: Trikom F609 & ZICG
        // F650 belum punya nilai SSID di cache → name = objek → is5GHz() melempar dan
        // tab SSID gagal digambar. Semua field di sini harus nilai primitif.
        const pv = (x) => (x != null && typeof x !== 'object') ? x : undefined;
        const _bwBersih = (x) => (x == null || typeof x === 'object'
                                  || (typeof x === 'number' && isNaN(x))) ? null : x;
        return Object.entries(wlanConf)
          .filter(([k]) => !k.startsWith('_'))
          .sort(([a], [b]) => parseInt(a) - parseInt(b))
          .map(([idx, v]) => ({
            idx:          parseInt(idx),
            // band5: true/false bila ADA sumber yang pasti; selain itu undefined →
            // is5GHz() memakai heuristik lama (byte-identik untuk vendor lain).
            //
            // X_HW_RFBand didahulukan karena ia OTORITATIF: firmware Huawei
            // menyatakan bandnya sendiri ('2.4GHz' / '5GHz'), tidak perlu ditebak
            // dari nomor kanal atau nama SSID. Itu penting sejak lebar kanal
            // ditawarkan per band — kalau band salah terdeteksi, daftar pilihan
            // lebar kanalnya ikut salah (5GHz punya Auto 80/40/20, 2.4GHz tidak).
            // Vendor lain tak punya leaf ini → jatuh ke perilaku lama.
            band5:        (function() {
                            const rf = String(gv(v, 'X_HW_RFBand') || '');
                            if (/^5/.test(rf)) return true;
                            if (/^2/.test(rf)) return false;
                            return _band5Min ? (parseInt(idx) >= _band5Min) : undefined;
                          })(),
            name:         pv(gv(v, 'SSID')) || `SSID${idx}`,
            enabled:      String(pv(gv(v, 'Enable')) || '').toUpperCase() === 'TRUE',
            channel:      parseInt(pv(gv(v, 'Channel')) || 0) || 0,
            autoChannel:  String(pv(gv(v, 'AutoChannelEnable')) || '').toUpperCase() === 'TRUE',
            associations: parseInt(pv(gv(v, 'TotalAssociations')) || 0) || 0,
            standard:     String(pv(gv(v, 'Standard')) || '').toLowerCase(),
            beaconType:   pv(gv(v, 'BeaconType')) || '',
            // Bandwidth: try multiple vendor param names
            bandwidth:    pv(gv(v, 'OperatingChannelBandwidth')) ||
                          pv(gv(v, 'X_CMCC_ChannelBandwidth'))  ||
                          pv(gv(v, 'X_ZTE-COM_ChannelBandwidth')) ||
                          pv(gv(v, 'X_ZTE-COM_OperatingChannelBandwidth')) ||   // F679L/F670L
                          pv(gv(v, 'BandWidth')) || null,   // F9V (X_CU): string '20MHz'/'40MHz'
            // Password SSID — ditampilkan di kartu SSID bila firmware mengeksposnya.
            // Dua tempat penyimpanan: (1) KeyPassphrase langsung (ZTE dsb), (2) node
            // PreSharedKey.1.KeyPassphrase (F9V/X_CU — KeyPassphrase langsung justru
            // KOSONG walau writable). Ambil yang pertama BERISI. Banyak firmware sengaja
            // tak mengembalikan password (kosong) → biarkan '' → UI menyembunyikan baris.
            // gv() bisa mengembalikan OBJEK metadata GenieACS ({_writable:…} tanpa _value)
            // untuk leaf yang ada tapi belum pernah dibaca — objek itu truthy, sehingga
            // rantai '||' lama berhenti di situ dan password tampil '[object Object]'
            // (mis. F9V FOTC: KeyPassphrase kosong, password asli di PreSharedKey.1).
            // Ambil nilai PRIMITIF pertama yang tidak kosong.
            password:     (function() {
              var cands = [gv(v, 'KeyPassphrase'),
                           gv(v, 'PreSharedKey', '1', 'KeyPassphrase'),
                           gv(v, 'PreSharedKey', '1', 'PreSharedKey')];
              for (var i = 0; i < cands.length; i++) {
                var c = cands[i];
                if (c == null || typeof c === 'object' || String(c) === '') continue;
                // PreSharedKey standar TR-098 = kunci turunan 64 heksadesimal, BUKAN
                // password WiFi — jangan ditampilkan seolah password. (Huawei V5 kebetulan
                // menaruh passphrase 8 karakter di sini, dan itu tetap dipakai.)
                if (i === 2 && /^[0-9a-f]{64}$/i.test(String(c))) continue;
                return String(c);
              }
              return '';
            })(),
            // Max clients: try multiple vendor param names
            maxClients:   gv(v, 'MaxAssociatedDevices') != null ? parseInt(gv(v, 'MaxAssociatedDevices')) :
                          gv(v, 'X_CMCC_MaxAssociatedDevices') != null ? parseInt(gv(v, 'X_CMCC_MaxAssociatedDevices')) : null,
            ssidHidden:   String(gv(v, 'SSIDAdvertisementEnabled') || 'TRUE').toUpperCase() !== 'TRUE',
            // Detect X_CMCC vendor prefix (ZTE F663NV9 etc.) — affects encryption mode values
            hasXCmcc:     Object.keys(v).some(function(k){ return k.startsWith('X_CMCC'); }),
            // Channel & bandwidth control
            channelWritable:  !!(v.Channel && v.Channel._writable === true &&
                                 v.AutoChannelEnable && v.AutoChannelEnable._writable === true),
            // Channel yang DIIZINKAN radio ini menurut ONU sendiri (PossibleChannels,
            // mis. Huawei HG8245W5-6T 5GHz = '36,...,64,149,...,161'). Daftar umum di
            // panel memuat 100-140 & 165 yang ditolak radio ini (2026-10-01).
            // null = tak dilaporkan → panel memakai daftar umum seperti semula.
            possibleChannels: (function() {
              var pc = gv(v, 'PossibleChannels');
              if (pc == null || typeof pc === 'object') return null;
              var arr = String(pc).split(/[,\s]+/).map(function(x){ return parseInt(x, 10); })
                .filter(function(n){ return n > 0; });
              return arr.length ? arr : null;
            })(),
            // channelWidthType: 'xcmcc' (X_CMCC_ChannelWidth 0/1/2, ZTE) | 'ctcom'
            // (X_CT-COM_ChannelWidth 0/1/2, HWTC — enkoding sama X_CMCC) | 'standard'
            // (OperatingChannelBandwidth, string) | 'bwstr' (BandWidth, string 'Auto'/
            // '20MHz'/'40MHz' — F9V/X_CU; 'Auto' diukur ulang 2026-10-02 pada SN
            // ELWRP93H6275858: DITERAPKAN, lihat _radioBwOpts) | null.
            // 'hwht20' (Huawei X_HW_HT20, unsignedInt) — ENUM LEBAR KANAL, bukan
            // sakelar. Diukur pada SN 485754432B16F9AE 2026-09-25 dengan mengubah
            // dari web ONU lalu menarik parameternya:
            //   0 = Auto 20/40 (2.4GHz) · 1 = 20MHz · 2 = 40MHz · 3 = Auto 80/40/20 (5GHz)
            // Catatan lama "1 = paksa HT20, 0 = 20/40" KELIRU (lihat _radioBwOpts).
            channelWidthType: (v.X_HW_HT20 && v.X_HW_HT20._writable === true) ? 'hwht20'
                            : (v.X_CMCC_ChannelWidth && v.X_CMCC_ChannelWidth._writable === true) ? 'xcmcc'
                            : (v['X_CT-COM_ChannelWidth'] && v['X_CT-COM_ChannelWidth']._writable === true) ? 'ctcom'
                            : (v.OperatingChannelBandwidth && v.OperatingChannelBandwidth._writable === true) ? 'standard'
                            : (v['X_ZTE-COM_OperatingChannelBandwidth'] && v['X_ZTE-COM_OperatingChannelBandwidth']._writable === true) ? 'ztecom'
                            : (v.BandWidth && v.BandWidth._writable === true) ? 'bwstr'
                            : null,
            // ── PARAM TULIS vs PARAM BACA (pelajaran ZTE F679L, SN ZTEGD77F8C07) ─────
            // Firmware X_ZTE-COM punya DUA parameter lebar kanal:
            //   BandWidth                            = SETELAN master ('Auto'/'20MHz'/'40MHz'/'80MHz')
            //   X_ZTE-COM_OperatingChannelBandwidth  = HASIL operasi radio saat ini
            // Menulis ke yang KEDUA percuma: selama master masih 'Auto', radio memilih
            // sendiri (mis. 20MHz karena coexistence 2.4GHz) dan MENIMPA BALIK nilai kita —
            // slot nonaktif tampak "berhasil" (radionya diam) sedangkan slot AKTIF kembali
            // ke 20MHz tanpa fault. Diverifikasi live: menulis BandWidth='40MHz' membuat
            // master DAN hasil operasi jadi 40MHz dan BERTAHAN.
            // channelWidthParam = param yang HARUS ditulis; channelWidthVal = nilai master
            // (yang dipilih operator); channelWidthOper = lebar kanal yang benar-benar dipakai.
            channelWidthParam: (v.X_HW_HT20 && v.X_HW_HT20._writable === true) ? 'X_HW_HT20'
                            : (v.X_CMCC_ChannelWidth && v.X_CMCC_ChannelWidth._writable === true) ? 'X_CMCC_ChannelWidth'
                            : (v['X_CT-COM_ChannelWidth'] && v['X_CT-COM_ChannelWidth']._writable === true) ? 'X_CT-COM_ChannelWidth'
                            : (v.OperatingChannelBandwidth && v.OperatingChannelBandwidth._writable === true) ? 'OperatingChannelBandwidth'
                            // X_ZTE-COM: tulis ke master 'BandWidth' bila ada & writable.
                            : (v['X_ZTE-COM_OperatingChannelBandwidth'] && v['X_ZTE-COM_OperatingChannelBandwidth']._writable === true)
                              ? ((v.BandWidth && v.BandWidth._writable === true) ? 'BandWidth' : 'X_ZTE-COM_OperatingChannelBandwidth')
                            : (v.BandWidth && v.BandWidth._writable === true) ? 'BandWidth'
                            : null,
            // channelWidthVal: integer for xcmcc/ctcom (0=20M,1=40M,2=Auto), string lainnya.
            // Utk X_ZTE-COM diambil dari MASTER (BandWidth) — itulah yang dipilih operator.
            // Hasil akhir dibersihkan: leaf yang dikenal tapi belum dibaca menghasilkan
            // objek metadata → parseInt = NaN. NaN/objek = "belum diketahui" = null, agar
            // pengaman bandwidth di _radioHandleSave mengenalinya (audit 2026-10-02).
            channelWidthVal:  _bwBersih(gv(v, 'X_HW_HT20') != null ? parseInt(gv(v, 'X_HW_HT20'))
                            : gv(v, 'X_CMCC_ChannelWidth') != null ? parseInt(gv(v, 'X_CMCC_ChannelWidth'))
                            : gv(v, 'X_CT-COM_ChannelWidth') != null ? parseInt(gv(v, 'X_CT-COM_ChannelWidth'))
                            : gv(v, 'OperatingChannelBandwidth') != null ? gv(v, 'OperatingChannelBandwidth')
                            : (v['X_ZTE-COM_OperatingChannelBandwidth'] && gv(v, 'BandWidth') != null) ? gv(v, 'BandWidth')
                            : gv(v, 'X_ZTE-COM_OperatingChannelBandwidth') != null ? gv(v, 'X_ZTE-COM_OperatingChannelBandwidth')
                            : gv(v, 'BandWidth') != null ? gv(v, 'BandWidth') : null),
            // Lebar kanal yang BENAR-BENAR dipakai radio (bisa beda dari master saat 'Auto').
            channelWidthOper: _bwBersih(gv(v, 'X_ZTE-COM_OperatingChannelBandwidth')),
          }));
      })(),

      // Real host list: array of {name, ip, mac, type, band}
      // Membaca SEMUA Hosts.Host.* (bukan hanya .1). Untuk C-DATA (X_CT-COM), tiap
      // host membawa X_CMS_WirelessTerminal = '2.4G'/'5G' yang menandai radio band —
      // dipakai device-detail untuk mengatribusikan klien ke SSID 2,4G vs 5G. Vendor
      // yang tak punya param ini (mis. ZTE) → band=null (jalur lama tak berubah).
      hostList: (() => {
        const h = (((igd.LANDevice || {})['1'] || {}).Hosts || {}).Host;
        if (!h || typeof h !== 'object') return [];

        // ── Telemetri radio per-klien dari WLANConfiguration.N.AssociatedDevice ──
        // Sebagian firmware (ZTE F679L/F670L X_ZTE-COM, dan sebagian vendor lain)
        // melaporkan RSSI/SNR/noise/laju TX-RX/mode/lebar-kanal per klien nirkabel.
        // Dikunci berdasarkan MAC lalu digabungkan ke Hosts.Host (yang membawa nama &
        // IP). Firmware tanpa data ini → peta kosong → host tak dapat field tambahan
        // (popup tetap seperti semula). Laju TR-069 dalam kbps → dikonversi ke Mbps.
        const assoc = (() => {
          const map = {};
          const wlanConf = ((igd.LANDevice || {})['1'] || {}).WLANConfiguration || {};
          const num = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
          // pickNum(): nilai numerik pertama yang ADA dari beberapa nama param (lintas vendor).
          const pickNum = (a, names) => {
            for (let i = 0; i < names.length; i++) { const n = num(gv(a, names[i])); if (n != null) return n; }
            return null;
          };
          const pickStr = (a, names) => {
            for (let i = 0; i < names.length; i++) {
              const v = gv(a, names[i]);
              if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim();
            }
            return null;
          };
          // Laju: SATUAN BEDA ANTAR-VENDOR — ZTE X_ZTE-COM_* = kbps (65000), HWTC/Huawei
          // X_HW_* = Mbps (65). Tak ada penanda satuan di TR-069 → pakai besaran nilainya:
          // >= 1000 pasti kbps (link WiFi rumah tak sampai 1000 Mbps di TR-069 ini).
          const toMbps = (v) => {
            const n = num(v);
            if (n == null || n <= 0) return null;
            return n >= 1000 ? Math.round(n / 100) / 10 : Math.round(n * 10) / 10;
          };
          // RSSI valid = dBm negatif. HWTC ZL-2113X mengekspos SignalStrength=0 (dummy)
          // padahal RSSI aslinya di X_HW_RSSI → 0/positif DIBUANG agar tak tampil "0 dBm".
          const toRssi = (v) => { const n = num(v); return (n != null && n < 0) ? n : null; };

          Object.keys(wlanConf).filter(k => k[0] !== '_').forEach(wIdx => {
            const w  = wlanConf[wIdx] || {};
            const ad = w.AssociatedDevice || {};
            Object.keys(ad).filter(k => k[0] !== '_').forEach(aIdx => {
              const a = ad[aIdx];
              if (!a || typeof a !== 'object') return;
              const mac = pickStr(a, ['AssociatedDeviceMACAddress', 'X_ZTE-COM_MACAddress', 'MACAddress']);
              if (!mac) return;

              // RSSI: urutan PENTING — nama vendor spesifik dulu, 'SignalStrength' generik
              // paling akhir (nilainya sering dummy).
              let rssi = null;
              const rssiNames = ['AssociatedDeviceRssi', 'X_ZTE-COM_WLAN_RSSI', 'X_HW_RSSI',
                                 'RSSI', 'X_ZTE-COM_Rssi', 'X_ZTE-COM_SignalStrength', 'SignalStrength'];
              for (let i = 0; i < rssiNames.length && rssi == null; i++) rssi = toRssi(gv(a, rssiNames[i]));

              const rec = {
                ssidIdx:   parseInt(wIdx, 10),
                rssi:      rssi,
                snr:       pickNum(a, ['X_ZTE-COM_WLAN_SNR', 'X_HW_SNR']),
                noise:     pickNum(a, ['X_ZTE-COM_WLAN_Noise', 'X_HW_Noise']),
                txRate:    toMbps(pickNum(a, ['X_ZTE-COM_TXRate', 'X_HW_TxRate', 'AssociatedDeviceRate', 'LastDataTransmitRate'])),
                rxRate:    toMbps(pickNum(a, ['X_ZTE-COM_RXRate', 'X_HW_RxRate'])),
                width:     pickStr(a, ['AssociatedDeviceBandWidth', 'X_ZTE-COM_WLAN_ClientChannelWidth', 'X_HW_FrequencyWidth']),
                mode:      pickStr(a, ['X_ZTE-COM_WLAN_ClientMode', 'X_HW_WorkingMode']),
                // Huawei (dibaca dari cache, diukur 2026-10-01 HG8245W5-6T): kolom yang sama
                // dengan tabel "Wifi Connected" di UI GenieACS. Nama X_HW_SingalQuality
                // memang salah eja di firmware-nya — jangan "dibetulkan".
                quality:   pickNum(a, ['X_HW_SingalQuality', 'X_HW_SignalQuality']),
                antenna:   pickStr(a, ['X_HW_AntennaNum']),
                beamform:  pickStr(a, ['X_HW_BeamFormingSupported']),
                psMode:    gv(a, 'X_HW_PSMode'),
                dualBand:  pickStr(a, ['X_HW_DualBandSupported']),
                radio:     pickStr(a, ['X_ZTE-COM_WLAN_Radio']),
                // Nama yang dilaporkan radio (Huawei: X_HW_AssociatedDevicedescriptions,
                // mis. 'V2027') — berguna saat Hosts.Host tak punya HostName.
                label:     pickStr(a, ['X_ZTE-COM_AssociatedDeviceName', 'X_HW_AssociatedDevicedescriptions']),
                bytesSent: pickNum(a, ['X_ZTE-COM_WLAN_BytesSend', 'X_ZTE-COM_BytesSent']),
                bytesRecv: pickNum(a, ['X_ZTE-COM_WLAN_BytesReceived', 'X_ZTE-COM_BytesReceived']),
                pktSent:   pickNum(a, ['X_ZTE-COM_TxSucPkt', 'X_ZTE-COM_PacketsSent']),
                pktRecv:   pickNum(a, ['X_ZTE-COM_RxSucPkt', 'X_ZTE-COM_PacketsReceived']),
                pktFail:   (pickNum(a, ['X_ZTE-COM_TxFailPkt']) || 0) + (pickNum(a, ['X_ZTE-COM_RxFailPkt']) || 0),
                retry:     pickNum(a, ['X_ZTE-COM_WLAN_RetryCount']),
                // stayTime = DETIK. HWTC X_HW_Uptime berformat '286:17190:57' (bukan detik,
                // makna tak jelas) → hanya diterima bila murni angka (Huawei: '1247').
                stayTime:  (function() {
                  const raw = pickStr(a, ['X_ZTE-COM_StayTime', 'X_HW_Uptime']);
                  return (raw && /^\d+$/.test(raw)) ? parseInt(raw, 10) : null;
                })(),
                auth:      gv(a, 'AssociatedDeviceAuthenticationState'),
                // Nomor instance AssociatedDevice — dipakai pop-up detail untuk membaca
                // telemetri klien INI saja (fetchHostDetail). Instance bergeser saat klien
                // datang-pergi, maka MAC selalu dicocokkan ulang sebelum dipakai.
                adIdx:     parseInt(aIdx, 10),
                retrans:   pickNum(a, ['X_ZTE-COM_WLAN_RetransCount', 'X_ZTE-COM_WLAN_Retransmissions']),
                errSent:   pickNum(a, ['X_ZTE-COM_WLAN_ErrorsSent']),
              };
              // Hanya simpan bila ADA isinya (hindari entri kosong: firmware kadang
              // membuat instance AssociatedDevice tanpa nilai sama sekali).
              if (rec.rssi != null || rec.txRate != null || rec.mode) map[mac.toLowerCase()] = rec;
            });
          });
          return map;
        })();

        // Object.entries, bukan values: INDEKS Host.N ikut dibawa. Tanpa itu,
        // panel tak bisa menyusun jalur parameter untuk menarik detail satu klien
        // (mis. '...Hosts.Host.7.X_HW_RSSI') — dan detail lengkap hanya bisa
        // diambil per klien, bukan sekaligus, agar tidak membebani ONU.
        return Object.entries(h)
          .filter(([k, e]) => k[0] !== '_' && e && typeof e === 'object'
                              && hostActive(gv(e, 'Active')))
          .map(([hostIdx, e]) => {
            const wt   = gv(e, 'X_CMS_WirelessTerminal'); // '2.4G' | '5G' | null (C-DATA)
            const band = wt != null && String(wt).trim() !== '' ? String(wt).trim() : null;
            // Normalisasi tipe nirkabel → '802.11' agar logika grup hilir seragam:
            //  - C-DATA kadang kosong tapi ada band (X_CMS_WirelessTerminal) → nirkabel.
            //  - HWTC ZL-2113X memakai InterfaceType='WLAN' (bukan '802.11') → nirkabel.
            let type = gv(e, 'InterfaceType');
            if ((type == null || type === '') && band) type = '802.11';
            else if (/^WLAN/i.test(String(type || ''))) type = '802.11';
            // Huawei melaporkan InterfaceType = 'SSID1'..'SSID8' — bukan '802.11'
            // maupun 'WLAN'. Tanpa normalisasi ini klien Huawei tidak masuk
            // hitungan nirkabel MAUPUN LAN, sehingga daftarnya kosong dan panel
            // hanya menulis "N perangkat terhubung — detail tidak dilaporkan
            // ONU" padahal datanya ADA. Terlihat pada SN 485754432B16F9AE:
            // 3 klien aktif, semuanya IfType='SSID1'.
            else if (/^SSID\d/i.test(String(type || ''))) type = '802.11';
            const mac  = gv(e, 'MACAddress') || '—';
            const radio = assoc[String(mac).toLowerCase()] || null;
            // gv() bisa mengembalikan OBJEK metadata GenieACS (leaf ada tapi belum berisi
            // _value — klien yang baru muncul) → tampil '[object Object]' di popup. prim()
            // hanya meneruskan nilai PRIMITIF non-kosong; sisanya jadi null.
            const prim = (v) => (v != null && typeof v !== 'object' && String(v) !== '') ? v : null;
            return {
              // Indeks Host.N — dipakai menarik detail lengkap klien ini saja.
              hostIdx: hostIdx,
              // Nama: HostName dulu; bila kosong pakai nama yang dilaporkan radio
              // (Huawei X_HW_AssociatedDevicedescriptions / ZTE AssociatedDeviceName).
              name: prim(gv(e, 'HostName')) || (radio && radio.label) || '—',
              ip:   prim(gv(e, 'IPAddress')) || '—',
              mac:  mac,
              type: type || '—',
              // band: dari X_CMS (C-DATA) ATAU dari radio klien (X_ZTE-COM: '2.4GHz'/'5GHz')
              band: band || (radio && radio.radio ? (/5/.test(radio.radio) ? '5G' : '2.4G') : null),
              // Telemetri radio per-klien (null bila firmware tak melaporkannya).
              radio: radio,
              // Detail tambahan C-DATA (untuk popup hover): laju negosiasi & sumber alamat.
              negotiationRate: prim(gv(e, 'X_CMS_NegotiationRate')),
              addressSource:   prim(gv(e, 'AddressSource')),
              // Layer2Interface → 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.N'.
              // Dipakai FD512XW-R460 (yang TAK punya X_CMS_WirelessTerminal) untuk
              // mengaitkan klien ke SSID/WLAN tepat → atribusi grup & band lebih akurat.
              layer2: gv(e, 'Layer2Interface') || null,
            };
          });
      })(),
    };
  }

  // ─── Projection for device list (all fields needed for table + stats) ──
  const LIST_PROJ = [
    '_id', '_lastInform', '_registered', '_lastBoot', '_tags', '_deviceId',
    'VirtualParameters.RXPower',
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppoeIP',
    'VirtualParameters.activedevices',
    'VirtualParameters.getponmode',
    'VirtualParameters.gettemp',
    'VirtualParameters.getVlan',
    'VirtualParameters.getSerialNumber',
    'InternetGatewayDevice.DeviceInfo.HardwareVersion',
    'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
  ];

  // ─── Proyeksi + jalur yang dibutuhkan pemetaan VP ─────────────
  // Rantai kandidat tidak ada gunanya kalau jalurnya tidak ikut terambil.
  // Menggabungkannya di sini tetap MURNI BACA: projection hanya memilih bagian
  // dokumen yang SUDAH tersimpan di GenieACS, tidak menyuruhnya bertanya ke ONU.
  function _gabungProyeksi(dasar) {
    const set = {};
    dasar.forEach(function (p) { set[p] = true; });
    try {
      if (typeof VPMap !== 'undefined') {
        VPMap.proyeksi().forEach(function (p) { set[p] = true; });
      }
    } catch (_) { /* tanpa VPMap → proyeksi dasar, perilaku lama */ }
    return Object.keys(set).join(',');
  }

  // ─── Projection for device detail (full) ──────────────────────
  const DETAIL_PROJ = [
    '_id', '_lastInform', '_registered', '_lastBoot', '_tags', '_deviceId',
    'VirtualParameters',
    'InternetGatewayDevice.DeviceInfo',
    'InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig',
    // Projeksi SELURUH subtree WLANConfiguration (semua instance) — bukan hanya
    // 1..4. Tata-letak radio beragam antar vendor: ZTE F663 muat di 1..4, tetapi
    // C-DATA memakai 5G=WLAN.1..5 & 2.4G=WLAN.6..10 → membatasi ke 1..4 menyembunyikan
    // SSID 2,4G (mis. WLAN.6). Projeksi induk mengembalikan semua instance yang ada
    // di DB (aman: dipakai HANYA untuk detail 1 perangkat, bukan list).
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration',
    'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig',
    'InternetGatewayDevice.LANDevice.1.Hosts.Host',
    // Tabel Port Binding (ZTE F679L/F670L): X_ZTE-COM_PortBinding.{i}.{WANInterface,
    // LANInterface}. WAJIB diproyeksikan — tanpa ini objek perangkat sampai ke panel TANPA
    // tabelnya, sehingga portBindingRoot=null & conn.portBindingIdx kosong: checkbox binding
    // tampil kosong dan penyimpanan TIDAK menulis apa pun (diam-diam). Perangkat vendor lain
    // tak punya node ini → proyeksi ekstra ini tak berefek apa-apa.
    'InternetGatewayDevice.X_ZTE-COM_PortBinding',
  ];

  // ─── Config reader (from localStorage, set by settings page) ──
  function getConfig() {
    try { return JSON.parse(localStorage.getItem('acsConfig') || '{}'); } catch { return {}; }
  }

  // ─── RX Power thresholds (dBm) from config, with safe defaults ──
  // good: ≥ good → Excellent · ≥ fair → Fair · else Poor
  function rxThr() {
    const c = getConfig();
    const g = parseFloat(c.rxGood), f = parseFloat(c.rxFair);
    return { good: isNaN(g) ? -20 : g, fair: isNaN(f) ? -25 : f };
  }

  // ─── HTTP helper ──────────────────────────────────────────────
  // ─── Kegagalan: bedakan penolakan pagar dari kegagalan GenieACS ───
  // 403/503 dari pagar keselamatan panel BUKAN kesalahan GenieACS, dan
  // menampilkannya sebagai "GenieACS 403" mengirim teknisi memeriksa server
  // yang salah — persis alasan 401 sudah ditangani terpisah di bawah.
  // Penanda `pagar: true` ditambahkan server.py; pesannya sudah berbahasa
  // Indonesia dan sudah menjelaskan sebabnya, jadi diteruskan apa adanya.
  async function _lempar(resp, path, teks) {
    let j = null;
    try { j = JSON.parse(teks); } catch (_) {}
    if (j && j.pagar) {
      const e = new Error(j.error || 'Perintah ditolak pagar keselamatan');
      e.pagar = true;
      e.kode  = j.kode || '';
      throw e;
    }
    throw new Error(`GenieACS ${resp.status} ${path}: ${(teks || '').slice(0, 120)}`);
  }

  async function apiFetch(path, options = {}) {
    const cfg = getConfig();
    const headers = { ...(options.headers || {}) };
    if (cfg.acsUser) {
      headers['Authorization'] = 'Basic ' + btoa((cfg.acsUser || '') + ':' + (cfg.acsPass || ''));
    }
    const resp = await fetch(BASE + path, { ...options, credentials: 'same-origin', headers });
    // 401 datang dari panel (sesi habis/dicabut), BUKAN dari GenieACS. Tanpa
    // penanganan ini, sesi yang kedaluwarsa di tengah pemakaian akan tampil
    // sebagai badai "GenieACS 401" yang membingungkan, bukan permintaan login.
    if (resp.status === 401) {
      if (typeof showLogin === 'function') showLogin(true);
      throw new Error('Sesi berakhir — silakan masuk kembali');
    }
    // 200 and 202 are both success (202 = task queued / connection_request sent)
    if (!resp.ok && resp.status !== 202) {
      const text = await resp.text().catch(() => '');
      await _lempar(resp, path, text);
    }
    // GenieACS returns an empty body on some success responses (e.g. DELETE
    // /devices/<id> → 200 no content). resp.json() would throw on "" → tolerate
    // empty body by returning null instead.
    const raw = await resp.text();
    return raw ? JSON.parse(raw) : null;
  }

  // ─── Load ALL devices (for list view + stats) ─────────────────
  // Stores results in App.rawDevices and App.devices.
  async function loadAll() {
    const raw      = await apiFetch(`/devices?projection=${encodeURIComponent(_gabungProyeksi(LIST_PROJ))}`);
    App.rawDevices = raw;
    App.devices    = raw.map(mapDevice).filter(Boolean);
    return App.devices;
  }

  // ─── Fetch single device with full projection ──────────────────
  async function fetchDevice(deviceId) {
    const q    = encodeURIComponent(JSON.stringify({ _id: deviceId }));
    const proj = encodeURIComponent(_gabungProyeksi(DETAIL_PROJ));
    const arr  = await apiFetch(`/devices?query=${q}&projection=${proj}`);
    if (!arr || !arr.length) throw new Error('Device not found: ' + deviceId);
    return mapDevice(arr[0]);
  }

  // ─── Compute dashboard stats from App.devices ─────────────────
  function getStats() {
    const devs  = App.devices || [];
    const total = devs.length;
    const now   = Date.now();

    const rx     = { excellent: 0, fair: 0, poor: 0, na: 0 };
    const temp   = { normal: 0, warm: 0, hot: 0 };
    const prodMap = {};
    const ponMap  = {};
    let online = 0;

    // Registered buckets: today, yesterday, 7 days, 1 month
    const reg = { today: 0, yesterday: 0, week: 0, month: 0 };
    const msDay = 86400000;

    devs.forEach(d => {
      if (d.online) online++;

      // RX
      const _t  = rxThr();
      const rxV = parseFloat(d.rx);
      if (isNaN(rxV))         rx.na++;
      else if (rxV >= _t.good) rx.excellent++;
      else if (rxV >= _t.fair) rx.fair++;
      else                     rx.poor++;

      // Temp
      if (d.temp > 55)       temp.hot++;
      else if (d.temp > 45)  temp.warm++;
      else                   temp.normal++;

      // Product class
      const m = d.model || 'Unknown';
      prodMap[m] = (prodMap[m] || 0) + 1;

      // PON mode
      const p = d.ponMode || 'Unknown';
      ponMap[p] = (ponMap[p] || 0) + 1;

      // Registered
      if (d.registeredRaw) {
        const age = now - new Date(d.registeredRaw).getTime();
        if (age < msDay)      reg.today++;
        else if (age < 2 * msDay) reg.yesterday++;
        else if (age < 7 * msDay) reg.week++;
        else if (age < 30 * msDay) reg.month++;
      }
    });

    return { total, online, offline: total - online, rx, temp, prodMap, ponMap, reg };
  }

  // ─── Fetch faults count ───────────────────────────────────────
  async function fetchFaultCount() {
    const arr = await apiFetch('/faults');
    return Array.isArray(arr) ? arr.length : 0;
  }

  // ─── Fetch faults for a specific device ──────────────────────
  async function getFaults(deviceId) {
    const q = encodeURIComponent(JSON.stringify({ device: deviceId }));
    try {
      const arr = await apiFetch(`/faults?query=${q}`);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  // ─── Last-week activity (real data) for dashboard events card ──
  // GenieACS NBI keeps no historical RPC log, so we derive real "events"
  // from device timestamps in App.devices + the active fault count.
  function getWeekEvents(faultCount) {
    const devs = App.devices || [];
    const now  = Date.now();
    const week = 7 * 86400000;
    let reg = 0, boot = 0, inform = 0, offline = 0;
    devs.forEach(d => {
      if (d.registeredRaw && (now - new Date(d.registeredRaw).getTime()) < week) reg++;
      if (d.lastBootRaw   && (now - new Date(d.lastBootRaw).getTime())   < week) boot++;
      if (d.lastInformRaw && (now - new Date(d.lastInformRaw).getTime()) < week) inform++;
      if (!d.online) offline++;
    });
    return [
      { label: 'ONU Terdaftar (7 hari)', color: '#22c55e', count: reg },
      { label: 'ONU Reboot (7 hari)',    color: '#f59e0b', count: boot },
      { label: 'ONU Inform (7 hari)',    color: '#6366f1', count: inform },
      { label: 'Fault Aktif',            color: '#ef4444', count: faultCount || 0 },
      { label: 'ONU Offline',            color: '#8b5cf6', count: offline },
    ];
  }

  // ─── Fetch recently registered (last 5) ───────────────────────
  function getRecentlyRegistered(n = 5) {
    const devs = (App.devices || []).filter(d => d.registeredRaw);
    devs.sort((a, b) => new Date(b.registeredRaw) - new Date(a.registeredRaw));
    return devs.slice(0, n);
  }

  // ─── Pagar tipe nilai — jaring terakhir sebelum apa pun sampai ke ONU ──────────
  // JSON.stringify mengubah objek/array jadi teks yang diterima GenieACS tanpa
  // keluhan, lalu ONU menolaknya selamanya dan task menggantung di antrian —
  // dicoba ulang tiap perangkat terhubung, termasuk tepat saat listrik pulih.
  // Kejadian nyata 2026-07-17: BandWidth ditulis "[object Object]" ke F670L dan
  // task itu masih membusuk di antrian 12 hari kemudian.
  // Sengaja di ACS.setParam, bukan di _setParamGuard, agar SEMUA pemanggil
  // terlindungi — termasuk settings.js dan jalur massal.
  function _cekTipeNilai(paramList) {
    if (!Array.isArray(paramList) || paramList.length === 0)
      throw new Error('Daftar parameter kosong — tidak ada yang dikirim ke ONU.');
    paramList.forEach(function (p, i) {
      const no = '#' + (i + 1);
      if (!Array.isArray(p) || p.length < 2)
        throw new Error('Parameter ' + no + ' bukan pasangan [path, nilai, tipe].');
      const path = p[0], val = p[1], t = typeof val;
      if (typeof path !== 'string' || !path.trim())
        throw new Error('Parameter ' + no + ' tidak punya path.');
      let salah = null;
      if (val === null)               salah = 'null';
      else if (val === undefined)     salah = 'undefined';
      else if (Array.isArray(val))    salah = 'array';
      else if (t === 'object')        salah = 'objek';
      else if (t === 'function')      salah = 'fungsi';
      else if (t === 'number' && !isFinite(val)) salah = String(val);
      if (salah)
        throw new Error('Nilai tidak sah untuk ' + path + ' — panel mengirim ' + salah
          + ', bukan teks/angka/boolean. Dibatalkan, tidak ada yang dikirim ke ONU.');
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MENUNGGU TASK SELESAI — 2026-08-02
  //
  // Masalah UTAMA-nya bukan angka timeout, melainkan panel MENGABAIKAN kode
  // status. Perilaku GenieACS yang terukur 2026-08-02:
  //   - connection-request BERHASIL → GenieACS menahan permintaan sampai task
  //     tuntas lalu membalas 200, WALAU timeout-nya cuma 3000 (diuji pada HWTC
  //     ZL-2113X: timeout=3000 → HTTP 200 setelah 21 dtk; timeout=90000 → 200
  //     setelah 14,8 dtk). Jadi timeout bukan penentu 200/202.
  //   - connection-request GAGAL (mis. 33 unit ZTEG yang ConnectionRequestURL-nya
  //     tanpa jalur) → GenieACS menyerah setelah timeout dan membalas
  //     **202 = baru diantre**.
  // Timeout dinaikkan sekadar memberi ONU lambat kesempatan lebih panjang;
  // yang benar-benar memperbaiki adalah MEMBACA status itu.
  //
  // Dulu panel memperlakukan 202 sama dengan 200 lalu MENEBAK hasilnya dari
  // berubahnya `_lastInform`. Tebakan itu salah dua arah:
  //   - operasi yang BERHASIL dilaporkan "ONU tidak merespons" (terjadi 2026-08-02
  //     pada penghapusan WAN ZTEG1B874818 — koneksi benar-benar terhapus tapi
  //     panel bilang gagal);
  //   - operasi yang GAGAL bisa terlihat sukses, sebab `_lastInform` berubah pada
  //     sesi mana pun, termasuk sesi yang faultnya membatalkan pekerjaan.
  //
  // Akibat terburuknya pada create WAN yang bertahap (addObject WCD → tunggu
  // indeks → addObject koneksi → set parameter): langkah 1 berhasil, penantian
  // langkah 2 kehabisan waktu, urutan putus, dan **WCD kosong tertinggal**. Tiap
  // percobaan ulang menambah satu lagi (terlihat langsung: WCD.4, 5, 6 kosong).
  //
  // 90 dtk dipilih karena harus melampaui jeda connection-request terlama yang
  // terukur di armada ini (HWTC ZL-2113X ~60 dtk, lihat SUMMON_WAIT_MS).
  // ONU yang responsif tetap selesai dalam ~1 dtk (ZTE F663NV9 terukur 1,1 dtk)
  // — GenieACS membalas begitu task tuntas, bukan menunggu sampai batas.
  //
  // PENTING: ini TIDAK menambah satu pun operasi tulis ke ONU. Yang dikirim
  // persis sama; hanya penantian jawabannya yang diperpanjang. Justru
  // MENGURANGI tulisan, sebab percobaan ulang & objek yatim jadi hilang.
  // ═══════════════════════════════════════════════════════════════════════════
  const TASK_WAIT_MS = 90000;

  // apiFetch yang MEMBUKA kode status — perlu untuk membedakan
  // 200 (task tuntas di sesi) dari 202 (task baru masuk antrean).
  async function apiFetchStatus(path, options = {}) {
    const cfg = getConfig();
    const headers = { ...(options.headers || {}) };
    if (cfg.acsUser) {
      headers['Authorization'] = 'Basic ' + btoa((cfg.acsUser || '') + ':' + (cfg.acsPass || ''));
    }
    const resp = await fetch(BASE + path, { ...options, credentials: 'same-origin', headers });
    if (resp.status === 401) {
      if (typeof showLogin === 'function') showLogin(true);
      throw new Error('Sesi berakhir — silakan masuk kembali');
    }
    if (!resp.ok && resp.status !== 202) {
      const text = await resp.text().catch(() => '');
      await _lempar(resp, path, text);
    }
    const raw = await resp.text();
    return { status: resp.status, data: raw ? JSON.parse(raw) : null };
  }

  // Kirim satu task dan tunggu sampai GenieACS memastikan nasibnya.
  // Kembalian: { done:true, task } bila ONU sudah menjalankannya,
  //            { done:false, taskId, task } bila masih mengantre.
  async function postTask(deviceId, body) {
    const enc = encodeURIComponent(deviceId);
    const r = await apiFetchStatus(
      `/devices/${enc}/tasks?connection_request&timeout=${TASK_WAIT_MS}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
    const task = r.data || null;
    // Server bisa menjawab 200 tanpa membuat task: itu terjadi saat permintaan
    // ini DIIKUTKAN pada operasi identik yang sedang dikerjakan orang lain
    // (lihat ops_lock.py). Tanpa cabang ini, `done: true` akan berbohong —
    // panel mengira perintahnya sudah dijalankan padahal ia menumpang.
    if (task && task.diikutkan) {
      return { done: false, diikutkan: true, op: task, taskId: null, task: null };
    }
    return { done: r.status === 200, taskId: task && task._id, task };
  }

  // ─── Menunggu operasi milik orang lain ────────────────────────
  // Murni baca ke panel sendiri (/ops/...), TIDAK menyentuh ONU sama sekali.
  async function opStatus(opId) {
    const r = await fetch('/ops/' + encodeURIComponent(opId), { credentials: 'same-origin' });
    if (!r.ok) return null;
    return r.json();
  }

  async function tungguOp(opId, maxMs, onTick) {
    const batas = maxMs || SUMMON_WAIT_MS;
    const mulai = Date.now();
    while (Date.now() - mulai < batas) {
      const o = await opStatus(opId);
      if (!o) return null;                       // sudah lama selesai / tak dikenal
      if (o.state !== 'berjalan') return o;
      if (onTick) onTick(o, Math.ceil((batas - (Date.now() - mulai)) / 1000));
      await new Promise(r => setTimeout(r, 2000));
    }
    return { state: 'berjalan' };
  }

  /* ─── Hapus fault ───────────────────────────────────────────────
     Membersihkan fault yang menyumbat antrean sebuah ONU.

     YANG SEBENARNYA TERJADI DI GENIEACS — penting, karena tidak terlihat dari
     nama endpoint-nya. Diperiksa langsung di sumber genieacs-nbi 1.2.13:

         let s = [hapusFault(id)];
         if (channel.startsWith("task_")) s.push(hapusTask(ObjectId(...)));

     Jadi untuk fault berkanal `task_<id>`, satu panggilan ini menghapus
     DUA hal sekaligus: fault-nya DAN task yang menyebabkannya. Itu memang
     yang dibutuhkan — task yang gagal permanen (mis. cwmp.9003 "Invalid
     arguments") akan gagal lagi di setiap sesi selamanya kalau task-nya
     dibiarkan, sehingga menghapus fault-nya saja percuma.

     Konsekuensinya: perintah yang mengantre itu DIBATALKAN. Pemanggil wajib
     mengatakannya kepada operator, bukan menghapus diam-diam.

     Dua hal lain dari sumber yang sama:
       • Bila ONU sedang dalam sesi, GenieACS menjawab 503 "Device is in
         session" — bukan kegagalan, cukup diulang beberapa detik kemudian.
       • Bila bagian `task_<id>` bukan ObjectId yang sah, handler-nya melempar
         galat SEBELUM header terkirim, dan jawabannya TIDAK PERNAH datang —
         koneksinya menggantung. Karena itu panggilan ini memakai batas waktu
         sendiri; tanpa itu, tombolnya berputar selamanya.                    */
  async function deleteFault(faultId) {
    const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const jam = ac ? setTimeout(function() { ac.abort(); }, 15000) : null;
    try {
      const r = await apiFetchStatus('/faults/' + encodeURIComponent(faultId),
                                     ac ? { method: 'DELETE', signal: ac.signal }
                                        : { method: 'DELETE' });
      return { ok: true, status: r.status };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const x = new Error('GenieACS tidak menjawab — fault ini mungkin rusak bentuknya. '
                          + 'Perlu dibersihkan dari sisi server.');
        x.menggantung = true;
        throw x;
      }
      // 503 = ONU sedang membuka sesi saat itu juga. Bukan gagal — hanya
      // belum bisa, dan beberapa detik lagi sudah bisa.
      if (e && /\b503\b|in session/i.test(e.message || '')) {
        const x = new Error('ONU sedang terhubung ke ACS saat ini. '
                          + 'Coba lagi beberapa detik lagi.');
        x.sedangSesi = true;
        throw x;
      }
      throw e;
    } finally {
      if (jam) clearTimeout(jam);
    }
  }

  /* ─── Detail satu klien ─────────────────────────────────────────
     Menarik field Hosts.Host yang TIDAK pernah dibaca berkala.

     KENAPA PER KLIEN, BUKAN SEKALIGUS. Provision `default` hanya menyegarkan
     empat field (HostName, IPAddress, MACAddress, InterfaceType) — itu sebabnya
     hanya keempatnya yang punya cakupan tinggi di armada. Sisanya kosong bukan
     karena ONU tak punya, melainkan karena tak pernah diminta.

     Diukur 2026-09-25 pada 5.393 entri klien di 1.543 ONU aktif:
         HostName/IPAddress/MACAddress/InterfaceType   78–100%
         LeaseTimeRemaining / AddressSource            1–5%
         IPv6Address / VendorClassID / X_HW_*          0%

     Membacanya berkala akan sangat mahal: 8 field × ~3,5 klien × 1.543 ONU
     ≈ 43.000 pembacaan parameter tiap penyegaran, pada sub-pohon yang sudah
     paling berat (instance Hosts bersifat dinamis). Jadi dibaca SAAT DIBUKA,
     untuk SATU klien saja — terukur ±2,6 detik dan ~14 parameter.

     Field X_HW_* hanya ada di Huawei; ONU lain membalas 9005 untuk nama yang
     tak dikenal, dan GenieACS menandainya tidak ada lalu melanjutkan (diperiksa
     di armada: perangkat ber-9005 tetap inform normal, fault 0). Jadi aman
     diminta untuk semua vendor — yang tak punya sekadar tidak terisi. */
  const HOST_DETAIL_FIELDS = [
    'HostName', 'IPAddress', 'IPv6Address', 'IPv6LinkLocal', 'InterfaceType',
    'Layer2Interface', 'LeaseTimeRemaining', 'MACAddress', 'AddressSource',
    'UserClassID', 'VendorClassID', 'Active',
    'X_HW_NegotiatedRate', 'X_HW_RSSI',
    'X_HW_Stats.BytesReceived', 'X_HW_Stats.BytesSent',
    // ZTE X_CMCC (F663NV9, dibaca 2026-10-02 SN ZTEGCD813F45): pemakaian data per klien.
    // Node Host.N.X_CMCC_Stats hanya berisi dua leaf ini (unsignedInt 32-bit, RO).
    'X_CMCC_Stats.BytesReceived', 'X_CMCC_Stats.BytesSent',
    // ZTE (F6600P dkk, 2026-10-02): IPv6 klien TIDAK di IPv6Address standar, melainkan
    // satu string bertitik-koma 'fe80::…;::;::;::;::' (link-local + slot global).
    'X_ZTE-COM_IPV6Address', 'ClientID',
  ];

  /* Telemetri radio klien yang berguna untuk NOC — dibaca bersama detail host, dalam
     getParameterValues YANG SAMA (tetap satu perintah per klik). Hanya nama yang
     DIKENAL pada instance AssociatedDevice klien itu yang diminta. Diukur 2026-10-02
     pada F6600P SN ZTEGD3BE4ED4: 42 leaf dikenal per klien, hanya 5 yang pernah dibaca. */
  const RADIO_DETAIL_FIELDS = [
    'X_ZTE-COM_WLAN_ClientMode', 'X_ZTE-COM_WLAN_SNR', 'X_ZTE-COM_WLAN_Noise',
    'X_ZTE-COM_TXRate', 'X_ZTE-COM_RXRate', 'X_ZTE-COM_StayTime',
    'X_ZTE-COM_WLAN_BytesSend', 'X_ZTE-COM_WLAN_BytesReceived',
    'X_ZTE-COM_TxSucPkt', 'X_ZTE-COM_RxSucPkt', 'X_ZTE-COM_TxFailPkt', 'X_ZTE-COM_RxFailPkt',
    'X_ZTE-COM_WLAN_RetryCount', 'X_ZTE-COM_WLAN_RetransCount', 'X_ZTE-COM_WLAN_ErrorsSent',
    'AssociatedDeviceRssi', 'AssociatedDeviceBandWidth',
    'X_HW_RSSI', 'X_HW_SNR', 'X_HW_Noise', 'X_HW_TxRate', 'X_HW_RxRate', 'X_HW_WorkingMode',
    'X_HW_SingalQuality', 'X_HW_FrequencyWidth', 'X_HW_Uptime',
  ];

  // radio (opsional): rekaman radio klien dari cache (punya ssidIdx, adIdx, dan MAC
  // host diberikan lewat mac) → telemetri klien itu ikut disegarkan.
  async function fetchHostDetail(deviceId, hostIdx, radio, mac) {
    const base = 'InternetGatewayDevice.LANDevice.1.Hosts.Host.' + hostIdx + '.';
    const names = HOST_DETAIL_FIELDS.map(f => base + f);
    if (radio && radio.ssidIdx && radio.adIdx >= 0 && mac) {
      try {
        const rb = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + radio.ssidIdx
                 + '.AssociatedDevice.' + radio.adIdx;
        const qr = encodeURIComponent(JSON.stringify({ _id: deviceId }));
        const ar = await apiFetch(`/devices?query=${qr}&projection=${encodeURIComponent(rb)}`);
        let inst = ar && ar[0];
        for (const p of rb.split('.')) { if (inst == null) break; inst = inst[p]; }
        if (inst && typeof inst === 'object') {
          const m = ['AssociatedDeviceMACAddress', 'X_ZTE-COM_MACAddress', 'MACAddress']
            .map(k => inst[k] && inst[k]._value).find(v => v != null && v !== '');
          // Instance bergeser saat klien datang-pergi: baca HANYA bila masih milik klien ini.
          if (m && String(m).toLowerCase() === String(mac).toLowerCase()) {
            RADIO_DETAIL_FIELDS.filter(f => inst[f] && typeof inst[f] === 'object')
              .forEach(f => names.push(rb + '.' + f));
          }
        }
      } catch (_) { /* tanpa telemetri tambahan — detail host tetap dibaca */ }
    }
    // Dikirim lewat postTask agar tunduk pada pagar & kunci yang sama dengan
    // perintah lain — bukan jalan pintas sendiri.
    await postTask(deviceId, { name: 'getParameterValues', parameterNames: names });
    // Baca hasilnya dari cache GenieACS (sudah diperbarui oleh task di atas).
    const q    = encodeURIComponent(JSON.stringify({ _id: deviceId }));
    const proj = encodeURIComponent(base.slice(0, -1));
    const arr  = await apiFetch(`/devices?query=${q}&projection=${proj}`);
    if (!arr || !arr.length) return null;
    let node = arr[0];
    for (const p of base.slice(0, -1).split('.')) {
      if (node == null) return null;
      node = node[p];
    }
    if (!node) return null;
    const out = {};
    HOST_DETAIL_FIELDS.forEach(f => {
      let cur = node;
      for (const p of f.split('.')) { if (cur == null) break; cur = cur[p]; }
      if (cur && typeof cur === 'object' && '_value' in cur
          && cur._value !== null && String(cur._value) !== '') {
        out[f] = cur._value;
      }
    });
    return out;
  }

  // Task yang masih mengantre untuk sebuah perangkat (READ-ONLY, tak menyentuh ONU).
  // Dipakai untuk mencegah penumpukan task kembar — sumber WCD yatim.
  async function pendingTasks(deviceId) {
    const q = encodeURIComponent(JSON.stringify({ device: deviceId }));
    return (await apiFetch(`/tasks?query=${q}`)) || [];
  }

  // Nasib sebuah task: 'selesai' | 'gagal' (dengan fault) | 'menunggu'.
  // Task yang tuntas DIHAPUS GenieACS dari koleksi tasks; yang bermasalah
  // meninggalkan fault berkanal `task_<id>`. Keduanya READ-ONLY.
  async function taskOutcome(deviceId, taskId) {
    const qf = encodeURIComponent(JSON.stringify({ device: deviceId }));
    const [tasks, faults] = await Promise.all([
      pendingTasks(deviceId),
      apiFetch(`/faults?query=${qf}`).catch(() => []),
    ]);
    const fault = (faults || []).find(f => f.channel === 'task_' + taskId);
    if (fault) return { state: 'gagal', code: fault.code, message: fault.message };
    if (!(tasks || []).some(t => t._id === taskId)) return { state: 'selesai' };
    return { state: 'menunggu' };
  }

  // Tunggu sampai task punya kepastian. onTick(sisaDetik) untuk penanda bergerak.
  async function awaitTask(deviceId, taskId, maxMs, onTick) {
    const batas = maxMs || TASK_WAIT_MS;
    const mulai = Date.now();
    while (Date.now() - mulai < batas) {
      const o = await taskOutcome(deviceId, taskId);
      if (o.state !== 'menunggu') return o;
      if (onTick) onTick(Math.ceil((batas - (Date.now() - mulai)) / 1000));
      await new Promise(r => setTimeout(r, 2000));
    }
    return { state: 'menunggu' };
  }

  // ─── Task: Set parameter values (WLAN name, password, settings) ───
  // paramList: array of ["param.path", value, "xsd:type"]
  async function setParam(deviceId, paramList) {
    _cekTipeNilai(paramList);
    return postTask(deviceId, { name: 'setParameterValues', parameterValues: paramList });
  }

  // ─── Task: Add object (e.g. new WLANConfiguration instance) ────
  async function addObject(deviceId, objectName) {
    return postTask(deviceId, { name: 'addObject', objectName });
  }

  // ─── Read-only: enumerasi index instance anak (numerik) di parentPath ─────────
  // Dipakai create multi-langkah (mis. C-DATA: addObject WANConnectionDevice →
  // baca index WCD baru yang DITENTUKAN ONU, bukan mengasumsikan max+1). GET DB
  // (projection) — TIDAK antre task ke ONU → aman (tak bisa memicu reboot).
  async function listChildIndices(deviceId, parentPath) {
    const q    = encodeURIComponent(JSON.stringify({ _id: deviceId }));
    const proj = encodeURIComponent(parentPath);
    const arr  = await apiFetch(`/devices?query=${q}&projection=${proj}`);
    if (!arr || !arr.length) return [];
    let node = arr[0];
    const parts = parentPath.split('.');
    for (let i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== 'object') return [];
      node = node[parts[i]];
    }
    if (!node || typeof node !== 'object') return [];
    return Object.keys(node)
      .filter(k => k[0] !== '_' && /^\d+$/.test(k))
      .map(Number).sort((a, b) => a - b);
  }

  // ─── Task: Delete object (e.g. remove WANPPPConnection instance) ──
  async function deleteObject(deviceId, objectName) {
    return postTask(deviceId, { name: 'deleteObject', objectName });
  }

  // ─── Delete device from GenieACS ──────────────────────────────
  // DELETE /devices/<id> removes the device RECORD from the GenieACS database.
  // This does NOT touch the ONU (no reboot/reset RPC is sent) — it only clears
  // the stale entry. If the ONU is still alive and informs again, GenieACS
  // re-registers it automatically. Safe for cleaning up offline/dead devices.
  async function deleteDevice(deviceId) {
    const enc = encodeURIComponent(deviceId);
    return apiFetch(`/devices/${enc}`, { method: 'DELETE' });
  }

  // ─── Task: Reboot device ──────────────────────────────────────
  // 'reboot' is a standard TR-069 RPC and works across all compliant ONU
  // vendors (it is an RPC, not a vendor-specific parameter).
  async function reboot(deviceId) {
    const enc = encodeURIComponent(deviceId);
    return apiFetch(`/devices/${enc}/tasks?connection_request&timeout=3000`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: 'reboot' }),
    });
  }

  // ─── Vendor-aware reboot ──────────────────────────────────────
  // Default: standard Reboot RPC (vendor-agnostic). If a vendor's config
  // (Settings → Vendor Configuration) defines `rebootParam`, write that
  // boolean parameter instead — for ONUs that reboot via a parameter.
  async function rebootSmart(d) {
    let vc = null;
    try { if (typeof getVendorWanConfig === 'function') vc = getVendorWanConfig(d.model); } catch (_) {}
    if (vc && vc.rebootParam) {
      const val = (vc.rebootValue !== undefined && vc.rebootValue !== '') ? vc.rebootValue : true;
      return setParam(d.id, [[vc.rebootParam, val, 'xsd:boolean']]);
    }
    return reboot(d.id);
  }

  // ─── Berapa lama menunggu ONU membalas connection-request ─────
  // TR-069 membolehkan CPE MENOLAK connection-request yang datang kurang dari
  // satu menit sejak yang terakhir. Sebagian firmware menerapkannya sebagai
  // jeda tetap: CR diterima, tapi ONU baru menelepon balik ~60 detik kemudian.
  //
  // Terukur 2026-08-02 pada HWTC ZL-2113X (207 unit, SN HWTC1006F0F0):
  //   tiga summon berturut-turut → 60,4 dtk / 60,0 dtk / 59,5 dtk, semuanya
  //   HTTP 200 (berhasil, bukan gagal). Log CWMP memastikan jedanya ada pada
  //   ONU membalas CR, bukan pada lamanya sesi.
  // ZTE F663NV9 dkk membalas dalam 2-10 dtk, jadi angka ini tak merugikan mereka
  // — poll berhenti begitu _lastInform berubah, bukan menunggu sampai batas.
  //
  // Batas lama (30 dtk di halaman detail) SELALU habis lebih dulu untuk
  // ZL-2113X → refresh yang sebenarnya BERHASIL dilaporkan "ONU tidak merespons".
  // 120 dtk memberi ruang dua kali lipat jeda 60 dtk itu.
  const SUMMON_WAIT_MS = 120000;

  // ─── Task: Summon / Refresh ───────────────────────────────────
  // Vendor-agnostic "summon" like GenieACS: send a connection request and
  // refresh the device's whole data-model tree (refreshObject on its root —
  // 'InternetGatewayDevice' for TR-098, 'Device' for TR-181). This adapts to
  // each vendor's parameter tree automatically (no hardcoded param list).
  // ═══════════════════════════════════════════════════════════════════════════
  // MODEL YANG TAK KUAT DISUSURI SELURUH POHON — 2026-08-02
  //
  // HWTC ZL-2113X (Realtek, ~209 unit) membalas SETIAP RPC dalam ~450 ms.
  // Terukur dari log pada SN HWTCA90D86D8:
  //     11:39:11.376 GetParameterValues
  //     11:39:11.865 GetParameterNames   (+489 ms)
  //     11:39:12.315 GetParameterNames   (+450 ms)
  //     11:39:12.765 GetParameterValues  (+450 ms)
  //     ...lalu ONU SENYAP TOTAL dan tidak pernah kembali.
  // Menyusuri seluruh pohon (~21 sub-pohon tingkat atas, >1100 leaf) berarti
  // menahan CPU ONU murah itu selama menit-menitan. Pelanggan merasakannya
  // sebagai "internet berat" dan ONU sulit di-remote — persis keluhan operator.
  //
  // Dua keuntungan sekaligus dengan melewati `ManagementServer`:
  //   1. Bebannya turun drastis (3 sub-pohon, bukan 21).
  //   2. Cache Password & ConnectionRequestPassword TIDAK tercemar "" -- itulah
  //      yang selama ini memicu provision menulis ulang ke flash tiap Refresh
  //      (lihat catatan panjang di provision `inform`). Model ini terbukti
  //      rapuh terhadap penulisan: 12 unit tumbang setelah satu SetParameterValues.
  //
  // Panel tidak menampilkan apa pun dari ManagementServer, jadi tak ada data
  // yang hilang. DeviceInfo/WANDevice/LANDevice mencakup semua yang dirender:
  // firmware & uptime, WAN/VLAN/PPPoE, SSID, dan daftar perangkat terhubung.
  // ═══════════════════════════════════════════════════════════════════════════
  const MODEL_RAPUH = ['ZL-2113X'];
  const SUBPOHON_PANEL = ['DeviceInfo', 'WANDevice', 'LANDevice'];

  async function summon(deviceId, root, model) {
    const enc  = encodeURIComponent(deviceId);
    const base = root || 'InternetGatewayDevice';
    const kirim = (obj) => apiFetch(`/devices/${enc}/tasks?connection_request&timeout=3000`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: 'refreshObject', objectName: obj }),
    });
    if (MODEL_RAPUH.indexOf(model) < 0) return kirim(base);
    // Berurutan, bukan paralel: ONU ini hanya sanggup satu percakapan.
    let hasil = null;
    for (const s of SUBPOHON_PANEL) hasil = await kirim(base + '.' + s);
    return hasil;
  }

  // ─── Task: Summon device via connection_request ──────────────────
  // GenieACS 1.2.x: connection_request sends CR to ONU then returns 202
  // immediately (CR sent, task pending). Device will connect back in 2-10s.
  // Both 200 and 202 are success here (200=done in active session, 202=CR sent).
  async function refresh(deviceId, wanConnections) {
    const enc = encodeURIComponent(deviceId);
    // Build explicit list of all parameters the panel displays.
    // This ensures MongoDB is updated with fresh ONU data after each inform.
    const wlanParams = [];
    [1, 2, 3, 4].forEach(function(n) {
      var base = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + n + '.';
      [
        'SSID', 'Enable', 'Status', 'BSSID',
        'Channel', 'AutoChannelEnable', 'PossibleChannels',
        'Standard', 'TotalAssociations',
        'BeaconType', 'BasicEncryptionModes',
        'WPAEncryptionModes', 'IEEE11iEncryptionModes',
        'WPAAuthenticationMode', 'IEEE11iAuthenticationMode',
        'KeyPassphrase', 'SSIDAdvertisementEnabled',
        'MaxAssociatedDevices', 'X_CMCC_MaxAssociatedDevices',
        'X_CMCC_ChannelWidth', 'OperatingChannelBandwidth',
        'X_CMCC_RFBand', 'X_CMCC_PowerValue',
      ].forEach(function(p) { wlanParams.push(base + p); });
    });
    const parameterNames = [
      // Device info
      'InternetGatewayDevice.DeviceInfo.HardwareVersion',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      // WAN / PPPoE
      'InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.WANAccessType',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.RemoteIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.DNSServers',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ConnectionStatus',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ConnectionType',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Enable',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Name',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.NATEnabled',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.MaxMRUSize',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.PPPoEServiceName',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.PPPoEACName',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Uptime',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_VLANIDMark',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_VLANMode',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_802-1pMark',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_ServiceList',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_IPMode',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_IPv6ConnStatus',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_IPv6IPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_IPv6Prefix',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_IPv6PrefixOrigin',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_IPv6IPAddressOrigin',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_IPv6DNSServers',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_IPv6PrefixDelegationEnabled',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_DefaultIPv6Gateway',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_LanInterface',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_CMCC_LanInterface-DHCPEnable',
      // WAN / IP (TR069)
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ConnectionStatus',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.DefaultGateway',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.DNSServers',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.AddressingType',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Enable',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Name',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.NATEnabled',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.MaxMTUSize',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.SubnetMask',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Uptime',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_CMCC_VLANIDMark',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_CMCC_VLANMode',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_CMCC_ServiceList',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_CMCC_IPMode',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_CMCC_LanInterface',
    ].concat(wlanParams);

    // Dynamically add runtime status params for all known WAN connections
    // (not just WCD.1 which is hardcoded above). This ensures ConnectionStatus,
    // ExternalIPAddress, DNS, Uptime etc. are refreshed for WAN 2, 3, ...
    var wanRuntimeFields = [
      'ConnectionStatus', 'ExternalIPAddress', 'RemoteIPAddress', 'DNSServers',
      'Uptime', 'X_CMCC_IPv6ConnStatus', 'X_CMCC_IPv6IPAddress', 'X_CMCC_IPv6Prefix',
      'X_CMCC_IPv6DNSServers',
      // C-DATA (X_CT-COM): binding LAN/SSID + IPMode/SLAAC + status IPv6 per-koneksi.
      // Tanpa ini GenieACS tak men-cache X_CT-COM_* → binding & IPv6 tak tampil di UI.
      'X_CT-COM_LanInterface', 'X_CT-COM_LanInterface-DHCPEnable', 'X_CT-COM_ServiceList',
      'X_CT-COM_IPMode', 'X_CT-COM_IPv6IPAddressOrigin', 'X_CT-COM_IPv6PrefixOrigin',
      'X_CT-COM_IPv6ConnStatus', 'X_CT-COM_IPv6IPAddress', 'X_CT-COM_IPv6Prefix',
      'X_CT-COM_IPv6DNSServers', 'X_CT-COM_DefaultIPv6Gateway', 'X_CT-COM_IPv6PrefixDelegationEnabled',
      // HWTC-EPON (Realtek): VLAN pada koneksi berprefix X_CT-COM + status IPv6 ejaan
      // 'ConnectionStatus'. Tanpa ini Refresh tertarget tak men-cache VLAN → tampil 0.
      'X_CT-COM_VLANIDMark', 'X_CT-COM_VLANMode', 'X_CT-COM_IPv6ConnectionStatus',
      // X_CU (China Unicom — F9V ETCH/FOTC): cermin X_CT-COM dgn awalan X_CU. VLAN sendiri
      // ada di LEAF WCD (X_CU_VLAN), bukan di koneksi → tak masuk daftar per-koneksi ini.
      'X_CU_ServiceList', 'X_CU_LanInterface', 'X_CU_LanInterface-DHCPEnable', 'X_CU_IPMode',
      'X_CU_IPv6ConnStatus', 'X_CU_IPv6IPAddress', 'X_CU_IPv6Prefix', 'X_CU_IPv6DNSServers',
      'X_CU_IPv6IPAddressOrigin', 'X_CU_IPv6PrefixOrigin', 'X_CU_IPv6PrefixDelegationEnabled',
      // X_ZTE-COM (F679L/F670L): VLAN & ServiceList ADA PADA KONEKSI (skema F).
      'X_ZTE-COM_VLANID', 'X_ZTE-COM_VLANEnable', 'X_ZTE-COM_ServiceList', 'X_ZTE-COM_8021P',
      // IPv6: alamat = ExternalIPv6Address, prefix PD = 'PD' (leaf 'Prefix' SELALU kosong di
      // firmware ini), link-local = LLA, cara peroleh = IPv6AcquireMode.
      'X_ZTE-COM_IPMode', 'X_ZTE-COM_IPv6ConnStatus', 'X_ZTE-COM_ExternalIPv6Address',
      'X_ZTE-COM_IPv6DNSServers', 'X_ZTE-COM_PD', 'X_ZTE-COM_LLA', 'X_ZTE-COM_IPv6AcquireMode',
      // X_HW (Huawei HG8245A/H): VLAN/ServiceList/CoS + binding boolean + IPv6. Alamat &
      // prefix IPv6 ada di SUB-TABEL (X_HW_IPv6.IPv6Address.1 / IPv6Prefix.1) — tanpa
      // didaftarkan di sini, WAN yang BARU dibuat menyala dualstack di ONU tetapi panel
      // tak punya alamatnya (GenieACS hanya menyimpan yang pernah dibacanya) → kolom IPv6
      // tampak kosong seolah dualstack gagal.
      'X_HW_VLAN', 'X_HW_SERVICELIST', 'X_HW_PRI', 'X_HW_IPv4Enable', 'X_HW_IPv6Enable',
      'X_HW_IPv6.IPv6Address.1.IPAddress', 'X_HW_IPv6.IPv6Address.1.Origin',
      'X_HW_IPv6.IPv6Prefix.1.Prefix', 'X_HW_IPv6.IPv6Prefix.1.Origin',
      'X_HW_IPv6.IPv6Address.1.DefaultGateway',
      'X_HW_LANBIND.Lan1Enable', 'X_HW_LANBIND.Lan2Enable', 'X_HW_LANBIND.Lan3Enable',
      'X_HW_LANBIND.Lan4Enable', 'X_HW_LANBIND.SSID1Enable', 'X_HW_LANBIND.SSID2Enable',
      'X_HW_LANBIND.SSID3Enable', 'X_HW_LANBIND.SSID4Enable',
    ];
    (wanConnections || []).forEach(function(conn) {
      if (!conn || !conn.basePath) return;
      wanRuntimeFields.forEach(function(f) {
        var p = conn.basePath + '.' + f;
        if (parameterNames.indexOf(p) < 0) parameterNames.push(p);
      });
      // Tabel Port Binding (ZTE F679L): ambil ulang isi entri milik koneksi ini agar
      // centang di panel = keadaan NYATA di ONU (bukan sisa cache). Koneksi vendor lain
      // tak punya portBindingIdx → tak ada tambahan.
      if (conn.portBindingIdx) {
        var pbBase = 'InternetGatewayDevice.' + PORT_BINDING_NODE + '.' + conn.portBindingIdx + '.';
        ['WANInterface', 'LANInterface'].forEach(function(f) {
          if (parameterNames.indexOf(pbBase + f) < 0) parameterNames.push(pbBase + f);
        });
      }
      // Huawei X_HW_LANBIND: slot yang BENAR-BENAR ada pada koneksi ini. Daftar tetap di
      // atas hanya Lan1-4/SSID1-4 (HG8245A); HG8245W5-6T punya SSID1-8 dan radio 5GHz-nya
      // di slot 5 — tanpa ini binding 5GHz tak pernah ikut disegarkan.
      if (conn.lanBindNode && conn.lanBindSlots) {
        var lbBase = conn.basePath + '.' + conn.lanBindNode + '.';
        (conn.lanBindSlots.eth || []).forEach(function(n) {
          if (parameterNames.indexOf(lbBase + 'Lan' + n + 'Enable') < 0) parameterNames.push(lbBase + 'Lan' + n + 'Enable');
        });
        (conn.lanBindSlots.wlan || []).forEach(function(n) {
          if (parameterNames.indexOf(lbBase + 'SSID' + n + 'Enable') < 0) parameterNames.push(lbBase + 'SSID' + n + 'Enable');
        });
      }
    });

    // Tabel Hosts & AssociatedDevice berisi INSTANCE DINAMIS (klien datang-pergi) → tak bisa
    // disebut satu per satu dalam getParameterValues. refreshObject membaca ulang seluruh
    // sub-pohonnya, termasuk instance yang baru muncul. Read-only (tak bisa memicu reboot).
    // Tanpa ini "Perangkat Terhubung" hanya sesegar inform terakhir ONU.
    var refreshTrees = [
      'InternetGatewayDevice.LANDevice.1.Hosts',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration',
    ];
    refreshTrees.forEach(function(obj) {
      apiFetch(`/devices/${enc}/tasks?timeout=3000`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: 'refreshObject', objectName: obj }),
      }).catch(function() { /* best-effort: daftar klien tetap dari inform terakhir */ });
    });

    return apiFetch(`/devices/${enc}/tasks?connection_request&timeout=3000`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: 'getParameterValues', parameterNames }),
    });
  }

  // ─── Probe a single parameter from GenieACS DB (READ-ONLY) ─────
  // Reads the last-known value GenieACS already holds via a targeted
  // projection. Does NOT queue any task/connection-request to the ONU
  // → aman & instan (tidak bisa memicu reboot/commit apa pun).
  // idOrSerial: full device _id (mengandung '-') ATAU serial number saja.
  // Returns: { found:true, value, writable, type }
  //        | { found:true, isObject:true }        (node objek/instance, bukan leaf)
  //        | { found:false, reason:'device'|'path' }
  async function probeParam(idOrSerial, fullPath) {
    idOrSerial = (idOrSerial || '').trim();
    fullPath   = (fullPath   || '').trim();
    if (!idOrSerial || !fullPath) throw new Error('SN/Device ID dan path wajib diisi');
    const query = idOrSerial.indexOf('-') >= 0
      ? { _id: idOrSerial }
      : { '_deviceId._SerialNumber': idOrSerial };
    const q    = encodeURIComponent(JSON.stringify(query));
    const proj = encodeURIComponent(fullPath);
    const arr  = await apiFetch(`/devices?query=${q}&projection=${proj}`);
    if (!arr || !arr.length) return { found: false, reason: 'device' };
    let node = arr[0];
    const parts = fullPath.split('.');
    for (let i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== 'object') return { found: false, reason: 'path' };
      node = node[parts[i]];
    }
    if (node == null) return { found: false, reason: 'path' };
    if (typeof node === 'object' && '_value' in node) {
      return { found: true, value: node._value, writable: node._writable, type: node._type };
    }
    return { found: true, isObject: true };
  }

  // ─── Nilai yang sudah ada di cache GenieACS untuk sejumlah path ──
  // READ-ONLY, satu GET berprojection: tidak mengantre apa pun ke ONU. Dipakai
  // penyimpanan WAN untuk mengirim HANYA parameter yang berubah (PRD §6.1).
  // Kembalian { path: nilai } — path yang tak ada di cache tidak muncul, dan
  // pemanggil wajib menganggapnya "berubah" (lebih baik terkirim daripada hilang).
  async function cachedValues(deviceId, paths) {
    const q    = encodeURIComponent(JSON.stringify({ _id: deviceId }));
    const proj = encodeURIComponent(paths.join(','));
    const arr  = await apiFetch(`/devices?query=${q}&projection=${proj}`);
    const out  = {};
    if (!arr || !arr.length) return out;
    paths.forEach(p => {
      let node = arr[0];
      for (const k of p.split('.')) {
        if (node == null || typeof node !== 'object') { node = undefined; break; }
        node = node[k];
      }
      if (node && typeof node === 'object' && '_value' in node) out[p] = node._value;
    });
    return out;
  }

  // ─── Path yang DIKENAL GenieACS tetapi nilainya BELUM PERNAH DIBACA ──
  // READ-ONLY. Diukur 2026-10-02 (audit 12 ONT): di F463N, F609, F663NV3A, MQ220,
  // GM220-S, Trikom F609, F650 nama X_*_IPMode/LanInterface/VLANMode/MTU dikenal
  // (hasil GetParameterNames) tetapi tak pernah dibaca — form Edit WAN lalu
  // menampilkan nilai BAWAAN (binding kosong, IPv4, MTU 1480) dan Simpan tanpa
  // perubahan mengirimnya: binding tercabut, IPv6 mati. Hanya path yang ADA
  // (node tanpa _value, bukan objek) dikembalikan — path yang tak dikenal sama
  // sekali tidak, karena membacanya hanya menghasilkan 9005.
  async function belumDibaca(deviceId, paths) {
    if (!paths || !paths.length) return [];
    const q    = encodeURIComponent(JSON.stringify({ _id: deviceId }));
    const proj = encodeURIComponent(paths.join(','));
    const arr  = await apiFetch(`/devices?query=${q}&projection=${proj}`);
    if (!arr || !arr.length) return [];
    return paths.filter(p => {
      let node = arr[0];
      for (const k of p.split('.')) {
        if (node == null || typeof node !== 'object') return false;
        node = node[k];
      }
      return !!node && typeof node === 'object' && !('_value' in node) && !node._object;
    });
  }

  return {
    cachedValues, belumDibaca,
    loadAll, fetchDevice, getStats, fetchFaultCount, getFaults,
    getRecentlyRegistered, getWeekEvents, reboot, rebootSmart, summon,
    refresh, setParam, addObject, deleteObject, deleteDevice, probeParam, listChildIndices,
    mapDevice, isOnline, relTime, fmtDate, getConfig, rxThr, parseWanConnections,
    SUMMON_WAIT_MS, TASK_WAIT_MS, postTask, pendingTasks, taskOutcome, awaitTask,
    opStatus, tungguOp, MODEL_RAPUH, deleteFault, fetchHostDetail, HOST_DETAIL_FIELDS,
  };
})();
