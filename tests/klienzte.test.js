#!/usr/bin/env node
/* Uji detail klien WiFi ZTE (F6600P dkk) — IPv6 & telemetri radio (2026-10-02).
 *
 * LATAR: pop-up detail klien NOC-BTD di F6600P (SN ZTEGD3BE4ED4) menulis "IPv6 tidak
 * dilaporkan" padahal ZTE menyimpannya di X_ZTE-COM_IPV6Address
 * ('fe80::…;::;::;::;::'). AssociatedDevice klien punya 42 leaf dikenal (laju TX/RX,
 * SNR, noise, mode, paket, retry…) tetapi hanya 5 yang pernah dibaca.
 *
 * YANG DIJAGA:
 *   1. fetchHostDetail meminta telemetri radio klien itu dalam getParameterValues YANG
 *      SAMA — hanya nama yang dikenal, dan hanya bila MAC instance masih milik klien itu.
 *   2. Rekaman radio membawa nomor instance (adIdx).
 *   3. Pop-up mengurai IPv6 ZTE, menampilkan Kualitas Link, dan menggambar ulang radio.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const baca = f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const L = v => ({ _value: v, _writable: true, _type: 'xsd:string' });
const DIKENAL = { _writable: false };
const RB = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice.2';
let instMac = '70:08:94:9E:EE:E7';
const dikirim = [];
const ctx = {
  console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout, btoa: s => s,
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
  fetch: async (url, opt) => {
    const u = decodeURIComponent(url);
    if (opt && opt.method === 'POST') {
      dikirim.push(JSON.parse(opt.body));
      return { ok: true, status: 200, text: async () => '{"_id":"t1"}' };
    }
    let body = [];
    if (u.indexOf('projection=' + RB) >= 0) {
      body = [{ InternetGatewayDevice: { LANDevice: { '1': { WLANConfiguration: { '5': { AssociatedDevice: { '2': {
        AssociatedDeviceMACAddress: L(instMac), AssociatedDeviceRssi: L(-68),
        'X_ZTE-COM_WLAN_SNR': DIKENAL, 'X_ZTE-COM_TXRate': DIKENAL, 'X_ZTE-COM_WLAN_ClientMode': DIKENAL,
        'X_ZTE-COM_WLAN_RetryCount': DIKENAL, 'X_ZTE-COM_Tidak_Diminta': DIKENAL,
      } } } } } } } }];
    } else if (u.indexOf('Hosts.Host.42') >= 0) {
      body = [{ InternetGatewayDevice: { LANDevice: { '1': { Hosts: { Host: { '42': {
        HostName: L('NOC-BTD'), 'X_ZTE-COM_IPV6Address': L('fe80::2e71:f2b3:8933:9222;::;::;::;::'),
      } } } } } } }];
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  },
};
vm.createContext(ctx);
vm.runInContext(baca('settings.js'), ctx);
vm.runInContext(baca('api.js') + '\n;this.ACS = ACS;', ctx);

(async () => {
  // ══ 1. fetchHostDetail + telemetri radio ══
  const rd = { ssidIdx: 5, adIdx: 2 };
  const out = await ctx.ACS.fetchHostDetail('X', 42, rd, '70:08:94:9e:ee:e7');
  const nama = (dikirim[0] || {}).parameterNames || [];
  ok(dikirim.length === 1 && dikirim[0].name === 'getParameterValues', 'tetap SATU getParameterValues per klik');
  ok(nama.some(n => n.endsWith('Hosts.Host.42.X_ZTE-COM_IPV6Address')), 'IPv6 ZTE ikut dibaca');
  ok(nama.indexOf(RB + '.X_ZTE-COM_WLAN_SNR') >= 0 && nama.indexOf(RB + '.X_ZTE-COM_TXRate') >= 0
     && nama.indexOf(RB + '.X_ZTE-COM_WLAN_RetryCount') >= 0, 'telemetri radio klien ikut dibaca');
  ok(nama.indexOf(RB + '.X_ZTE-COM_Tidak_Diminta') < 0, 'hanya nama dari daftar yang berguna');
  ok(!nama.some(n => /X_HW_TxRate$/.test(n) && n.indexOf(RB) === 0), 'nama yang tak dikenal instance itu tidak diminta');
  ok(out && out['X_ZTE-COM_IPV6Address'], 'hasil detail memuat IPv6 ZTE');

  dikirim.length = 0; instMac = 'AA:BB:CC:00:00:01';
  await ctx.ACS.fetchHostDetail('X', 42, rd, '70:08:94:9e:ee:e7');
  ok(!(dikirim[0].parameterNames || []).some(n => n.indexOf(RB) === 0),
     'instance sudah milik klien lain (MAC beda) → telemetri TIDAK dibaca');
  dikirim.length = 0;
  await ctx.ACS.fetchHostDetail('X', 42);
  ok(dikirim[0].parameterNames.every(n => n.indexOf('Hosts.Host.42.') > 0), 'tanpa rekaman radio → hanya detail host');

  // ══ 2. Rekaman radio membawa nomor instance ══
  const dev = ctx.ACS.mapDevice({ _id: 'Y', _deviceId: {}, InternetGatewayDevice: { LANDevice: { '1': {
    Hosts: { Host: { '42': { HostName: L('NOC-BTD'), MACAddress: L('70:08:94:9e:ee:e7'), IPAddress: L('192.168.1.29'),
      Active: { _value: true, _type: 'xsd:boolean' }, InterfaceType: L('802.11'),
      Layer2Interface: L('InternetGatewayDevice.LANDevice.1.WLANConfiguration.5') } } },
    WLANConfiguration: { '5': { SSID: L('HTS'), AssociatedDevice: { '2': {
      AssociatedDeviceMACAddress: L('70:08:94:9e:ee:e7'), AssociatedDeviceRssi: L(-68),
      'X_ZTE-COM_WLAN_RetransCount': L('12'), 'X_ZTE-COM_WLAN_ErrorsSent': L('3') } } } } } } } });
  const r = ((dev.hostList || []).find(x => x.mac === '70:08:94:9e:ee:e7') || {}).radio || {};
  ok(r.adIdx === 2 && r.ssidIdx === 5, 'radio.adIdx & ssidIdx tercatat');
  ok(r.retrans === 12 && r.errSent === 3, 'retransmisi & error kirim terbaca');

  // ══ 3. Pop-up ══
  const dd = baca('device-detail.js');
  const pop = dd.slice(dd.indexOf('async function _hostDetailBuka'), dd.indexOf('\nfunction _hostTipShow('));
  ok(/ACS\.fetchHostDetail\(d\.id, idx, rd, h\.mac \|\| mac\)/.test(pop), 'pop-up meneruskan rekaman radio & MAC');
  ok(/X_ZTE-COM_IPV6Address/.test(pop) && /fe80:/.test(pop) && /x !== '::'/.test(pop), 'IPv6 ZTE diurai (link-local & global, :: dibuang)');
  ok(/Kualitas Link/.test(pop) && /'Retry'/.test(pop) && /'Retransmisi'/.test(pop), 'bagian Kualitas Link ada');
  ok(/ACS\.fetchDevice\(d\.id\)/.test(pop) && /rEl\.innerHTML = radioHtml/.test(pop), 'radio digambar ulang dengan angka segar');
  ok(/'ClientID'/.test(pop), 'DHCP Client ID ditampilkan');
  ok(!/setParam|addObject|deleteObject|refreshObject/.test(pop), 'pop-up tidak menulis apa pun');

  console.log(`klienzte: ${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
