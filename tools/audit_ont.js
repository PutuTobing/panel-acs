#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Audit satu ONT — MURNI BACA.

       node tools/audit_ont.js <SN atau sebagian _id> [--json berkas.json]
       SKY_NBI=http://127.0.0.1:7557   (bawaan)

   Menjalankan langkah PRD TUGAS/CEKLIS-AUDIT-MODEL-ONT.md secara otomatis:
   mengambil dokumen ONU dari GenieACS (GET berprojection), lalu menjalankan KODE
   PANEL ASLI (js/settings.js, js/api.js, potongan js/device-detail.js) terhadap
   dokumen itu — jadi yang diperiksa adalah perilaku panel sungguhan, bukan
   tiruannya.

   TIDAK PERNAH mengirim apa pun ke ONU: hanya GET ke NBI. Tidak ada POST/PUT/
   DELETE di berkas ini, dan tidak boleh ada.

   Lahir 2026-10-02 dari audit HG8245W5-6T: model tanpa profil jatuh ke profil
   ZTE X_CMCC, tipe data salah (binding 1/0 vs boolean), dan daftar opsi umum
   (channel 5GHz) — tiga kesalahan yang hanya terlihat bila kode panel dijalankan
   terhadap data ONU yang nyata.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const NBI  = (process.env.SKY_NBI || 'http://127.0.0.1:7557').replace(/\/$/, '');
const RAHASIA = /pass|key|psk|secret/i;

// ── NBI: hanya GET ─────────────────────────────────────────────────
async function get(p) {
  const r = await fetch(NBI + p, { method: 'GET' });
  if (!r.ok) throw new Error('NBI ' + r.status + ' untuk ' + p.slice(0, 80));
  return r.json();
}
const q = o => encodeURIComponent(JSON.stringify(o));

// ── Kode panel asli ────────────────────────────────────────────────
function muatPanel() {
  const ctx = {
    console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'settings.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8') + '\n;this.ACS = ACS;', ctx);
  const dd = fs.readFileSync(path.join(ROOT, 'js', 'device-detail.js'), 'utf8');
  const iris = n => {
    const i = dd.indexOf('function ' + n + '(');
    if (i < 0) throw new Error('fungsi ' + n + ' tidak ditemukan di device-detail.js');
    let j = dd.indexOf('{', i), k = 0;
    for (; j < dd.length; j++) { if (dd[j] === '{') k++; else if (dd[j] === '}' && --k === 0) break; }
    return dd.slice(i, j + 1);
  };
  vm.runInContext(['is5GHz', '_bool01', '_nilaiSama', '_saringParamBerubah', '_wanLanParsed',
                   '_wanProfileFor', '_wanPathForm',
                   '_lanBindBoolParams', '_portBindingRencana', '_radioChOpts', '_radioBwOpts',
                   '_isWpaAuth'].map(iris).join('\n'), ctx);
  return ctx;
}

// ── Pembantu dokumen ───────────────────────────────────────────────
function node(doc, p) {
  let n = doc;
  for (const k of p.split('.')) { if (n == null || typeof n !== 'object') return undefined; n = n[k]; }
  return n;
}
function leaf(doc, p) {
  const n = node(doc, p);
  return (n && typeof n === 'object' && '_value' in n) ? n : null;
}
function tampil(p, v) { return RAHASIA.test(p) ? (v === '' || v == null ? '(kosong)' : '***') : JSON.stringify(v); }
// Tiga keadaan, dan bedanya penting (2026-10-02): leaf yang DIKENAL GenieACS tetapi
// nilainya belum pernah dibaca (objek {_writable,…} tanpa _value) ADA di ONU — profil
// panel benar, hanya cache-nya kosong. Hanya yang sama sekali tak dikenal = tidak ada.
function cekPath(doc, p) {
  const l = leaf(doc, p);
  if (!l) {
    const n = node(doc, p);
    if (n && typeof n === 'object' && !n._object) {
      return { ada: true, belumDibaca: true, w: n._writable === true,
               teks: '◐ ada di ONU, nilai BELUM PERNAH DIBACA' + (n._writable === false ? ' (read-only)' : '') };
    }
    return { ada: false, teks: '✗ tidak dikenal di ONU' };
  }
  const w = l._writable === true;
  return { ada: true, w, tipe: l._type, nilai: l._value,
           teks: (w ? '✓' : '⚠ read-only') + ' ' + l._type + ' = ' + tampil(p, l._value) };
}

// ── Laporan ────────────────────────────────────────────────────────
const laporan = { ringkas: [], baris: [] };
let bagianNow = '';
function bagian(t) { bagianNow = t; laporan.baris.push('\n══ ' + t + ' ══'); }
function tulis(s) { laporan.baris.push(s); }
function temuan(tingkat, s) {               // tingkat: '✓' | '⚠' | '✗' | 'ℹ'
  laporan.baris.push('  ' + tingkat + ' ' + s);
  if (tingkat === '⚠' || tingkat === '✗') laporan.ringkas.push(tingkat + ' [' + bagianNow + '] ' + s);
}

// ═══════════════════════════════════════════════════════════════════
async function audit(sn) {
  const cari = await get('/devices/?query=' + q({ _id: { $regex: sn } }) + '&projection=_id');
  if (!cari.length) throw new Error('Perangkat dengan SN/_id "' + sn + '" tidak ditemukan');
  if (cari.length > 1) throw new Error('SN ambigu, cocok ' + cari.length + ' perangkat: '
                                       + cari.map(x => x._id).join(', '));
  const id = cari[0]._id;
  const proj = ['_id', '_deviceId', '_lastInform', '_lastBoot', 'VirtualParameters',
    'InternetGatewayDevice.DeviceInfo', 'InternetGatewayDevice.WANDevice',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration', 'InternetGatewayDevice.LANDevice.1.Hosts',
    'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig', 'InternetGatewayDevice.UserInterface',
    'InternetGatewayDevice.X_ZTE-COM_PortBinding', 'InternetGatewayDevice.X_CU_Function',
    'InternetGatewayDevice.X_CMCC_UserInfo', 'InternetGatewayDevice.X_CT-COM_UserInfo'].join(',');
  const doc = (await get('/devices/?query=' + q({ _id: id }) + '&projection=' + proj))[0];
  const faults = await get('/faults/?query=' + q({ device: id }) + '&projection=code,channel,message,timestamp');

  const P = muatPanel();
  const di = doc._deviceId || {};
  const pc = di._ProductClass, oui = di._OUI, mfr = di._Manufacturer;
  const umurJam = doc._lastInform ? (Date.now() - Date.parse(doc._lastInform)) / 3600000 : null;

  bagian('Perangkat');
  tulis('  ' + id);
  tulis('  Model ' + pc + ' · ' + mfr + ' · OUI ' + oui + ' · fw '
        + ((leaf(doc, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion') || {})._value)
        + ' · inform ' + (umurJam == null ? '?' : umurJam.toFixed(1) + ' jam lalu'));
  if (umurJam == null || umurJam > 1) temuan('⚠', 'ONU tidak inform dalam 1 jam terakhir — data cache bisa basi, uji tulis ditunda');
  faults.forEach(f => temuan('⚠', 'fault ' + f.code + ' @' + f.channel + ' — ' + String(f.message || '').slice(0, 80)));

  // ── Profil ──
  bagian('Profil panel');
  const w = P.getWanProfile(pc, oui, mfr), s = P.getSecurityProfile(pc, oui, mfr);
  const vsec = P.getVendorSecurityConfig(pc, oui, mfr) || {};
  tulis('  WAN : matched=' + w.matched + ' template=' + w.template + ' label=' + w.label);
  tulis('  WiFi: matched=' + s.matched + ' template=' + s.template);
  if (!w.matched) temuan('✗', 'tidak ada profil WAN — panel memakai profil ZTE X_CMCC untuk model ini');
  if (!s.matched) temuan('✗', 'tidak ada profil WiFi — panel memakai resep ZTE X_CMCC');

  const d = P.ACS.mapDevice(doc);
  const cache = p => { const l = leaf(doc, p); return l ? l._value : undefined; };

  // ── WAN ──
  bagian('WAN Connection');
  const WP = w.params || {};
  (d.wanConnections || []).forEach(conn => {
    const base = conn.basePath + '.';
    const tipe = conn.type;
    tulis('\n  [' + conn.basePath.replace('InternetGatewayDevice.WANDevice.1.', '') + '] ' + tipe
          + ' · service=' + conn.serviceList + ' · VLAN ' + conn.vlanId + ' mode ' + conn.vlanMode
          + ' · ipMode ' + conn.ipMode + ' · status ' + conn.connectionStatus);
    tulis('    binding: ' + (conn.lanBindNode ? 'per-port ' + conn.lanBindNode + ' (' + conn.lanBindType + ')'
          : conn.portBindingIdx ? 'tabel PortBinding #' + conn.portBindingIdx
          : d.portBindingRoot ? 'tabel PortBinding (belum ada entri)'
          : WP.lanInterface ? 'string ' + WP.lanInterface : 'tidak ada')
          + ' → ' + (conn.lanInterface || '(kosong)').replace(/InternetGatewayDevice\.LANDevice\.1\./g, ''));

    // Lokasi VLAN — sama dengan _wanHandleSave
    const wcd = conn.basePath.replace(/\.(WANPPPConnection|WANIPConnection)\.\d+$/, '.');
    const vNode = (conn.vlanOnConn || conn.vlanOnWcd) ? null : (conn.vlanNode || w.vlanNode);
    const vBase = vNode ? wcd + vNode + '.' : conn.vlanOnWcd ? wcd : base;
    const vId   = conn.vlanOnConn ? conn.vlanOnConn + '_VLANIDMark' : WP.vlanId;
    const vMode = conn.vlanOnConn ? conn.vlanOnConn + '_VLANMode'   : WP.vlanMode;

    const belumDibaca = [];
    const kunci = [['service', base + WP.service], ['vlanId', vBase + vId], ['vlanMode', vBase + vMode],
                   ['vlanEnable', WP.vlanEnable ? vBase + WP.vlanEnable : null],
                   ['cos', base + WP.cos], ['nat', base + WP.nat],
                   ['mtu', base + (tipe === 'ppp' ? WP.mtuPpp : WP.mtuIp)], ['ipMode', base + WP.ipMode],
                   ['lanInterface', base + WP.lanInterface], ['lanDhcpEnable', base + WP.lanDhcpEnable]];
    if (tipe === 'ppp') kunci.push(['pppUser', base + WP.pppUser], ['pppPass', base + WP.pppPass],
                                   ['pppConnType', base + WP.pppConnType]);
    else kunci.push(['ipAddrType', base + WP.ipAddrType]);
    kunci.forEach(([k, p]) => {
      const nama = p && p.slice(p.lastIndexOf('.') + 1);
      if (!p || !nama || nama === 'undefined') { tulis('    · ' + k.padEnd(13) + ' (tidak dipakai profil)'); return; }
      const c = cekPath(doc, p);
      tulis('    · ' + k.padEnd(13) + p.replace(base, '').replace(wcd, 'WCD.') + ' → ' + c.teks);
      const kon = conn.basePath.split('.').slice(-2).join('.');
      if (!c.ada) temuan('✗', kon + ' ' + k + ': ' + p.replace(wcd, 'WCD.') + ' tidak dikenal di ONU');
      else if (c.belumDibaca) belumDibaca.push(k);
      else if (!c.w && k !== 'pppPass') temuan('⚠', k + ': ' + nama + ' read-only');
    });
    if (belumDibaca.length) temuan('⚠', conn.basePath.split('.').slice(-2).join('.')
      + ': nilai belum pernah dibaca GenieACS → form Edit menampilkan nilai BAWAAN untuk: ' + belumDibaca.join(', '));
    if (w.dualStack && w.dualStack.param) {
      const c = cekPath(doc, base + w.dualStack.param);
      tulis('    · dualStack    ' + w.dualStack.param + ' → ' + c.teks + ' (profil ' + (w.dualStack.type || 'xsd:unsignedInt') + ')');
      if (!c.ada) temuan('✗', 'dualStack ' + w.dualStack.param + ' tidak dikenal di ONU');
      else if (c.belumDibaca) {}
      else if (c.tipe !== (w.dualStack.type || 'xsd:unsignedInt') && !/string/.test(c.tipe))
        temuan('⚠', 'dualStack tipe ONU ' + c.tipe + ' ≠ profil ' + (w.dualStack.type || 'xsd:unsignedInt'));
    }
    // Leaf vendor pada koneksi yang TIDAK dipakai profil (petunjuk profil kurang lengkap).
    const dipakai = new Set(kunci.map(x => x[1]));
    const vendorLeaf = Object.keys(node(doc, conn.basePath) || {})
      .filter(k => /^X_/.test(k) && /VLAN|Service|LanInterface|IPMode|Bind/i.test(k) && leaf(doc, base + k)
                   && !dipakai.has(base + k));
    if (vendorLeaf.length) tulis('    ℹ leaf vendor tak dipakai profil: ' + vendorLeaf.join(', '));

    // Simulasi Simpan tanpa perubahan — meniru _wanHandleSave (form terisi apa adanya).
    const isTr = tipe === 'ip';
    const params = [];
    const push = (b, n, v, t) => { if (n) params.push([b + n, v, t]); };
    const vlanMode = conn.vlanMode !== undefined ? (conn.vlanMode !== 0 ? 2 : 0) : 2;
    const vlanIdV = parseInt(conn.vlanId, 10) || 0;
    let cosV = isTr ? conn.cos : (conn.cos == null ? 0 : conn.cos); if (isNaN(cosV) || cosV == null) cosV = 0;
    const natV = conn.nat ? 1 : 0;
    let mtuV = isTr ? conn.mtu : (conn.mtu || 1480); mtuV = parseInt(mtuV, 10); if (isNaN(mtuV)) mtuV = 1480;
    const ipModeV = conn.ipMode || 1;
    push(base, WP.service, conn.serviceList, 'xsd:string');
    push(vBase, vId, vlanIdV, 'xsd:unsignedInt');
    push(vBase, vMode, vlanMode, 'xsd:unsignedInt');
    if (WP.vlanEnable) push(vBase, WP.vlanEnable, vlanMode !== 0 && vlanIdV > 0, 'xsd:boolean');
    push(base, WP.cos, cosV, 'xsd:unsignedInt');
    push(base, WP.nat, !!natV, 'xsd:boolean');
    push(base, tipe === 'ppp' ? WP.mtuPpp : WP.mtuIp, mtuV, 'xsd:unsignedInt');
    push(base, WP.ipMode, ipModeV, 'xsd:unsignedInt');
    push(base, WP.lanInterface, conn.lanInterface || '', 'xsd:string');
    push(base, WP.lanDhcpEnable, !!conn.dhcpEnabled, 'xsd:boolean');
    P._lanBindBoolParams(conn, base, conn.lanInterface).forEach(x => params.push(x));
    if (ipModeV >= 2) {
      const v6 = !!WP.ipv6PrefixOrigin && !isTr;
      const pfx = v6 ? (conn.ipv6PrefixOrigin === 'Static' || conn.ipv6PrefixOrigin === 'None' ? conn.ipv6PrefixOrigin : 'PrefixDelegation') : 'PrefixDelegation';
      const ad  = v6 ? (conn.ipv6IpOrigin === 'Static' || conn.ipv6IpOrigin === 'None' ? conn.ipv6IpOrigin : 'AutoConfigured') : 'AutoConfigured';
      push(base, WP.ipv6PrefixOrigin, pfx, 'xsd:string');
      push(base, WP.ipv6AddrOrigin, ad, 'xsd:string');
      push(base, WP.ipv6PrefixDelegation, pfx === 'PrefixDelegation', 'xsd:boolean');
      if (v6 && conn.ipv6Dns) push(base, WP.ipv6Dns, conn.ipv6Dns, 'xsd:string');
    }
    if (tipe === 'ppp') {
      if (conn.username) push(base, WP.pppUser, conn.username, 'xsd:string');
      push(base, WP.pppConnType, conn.connectionType === 'PPPoE_Bridged' ? 'PPPoE_Bridged' : 'PPPoE_Routed', 'xsd:string');
    } else {
      push(base, WP.ipAddrType, 'DHCP', 'xsd:string');   // form IP tidak menampilkan isian ini
    }
    const pb = P._portBindingRencana(d, conn, conn.lanInterface);
    pb.params.forEach(x => params.push(x));
    // _koreksiIpMode: tipe string di ONU → nilai string
    const ipl = WP.ipMode && leaf(doc, base + WP.ipMode);
    params.forEach((x, i) => { if (ipl && x[0] === base + WP.ipMode && ipl._type === 'xsd:string') params[i] = [x[0], String(x[1]), 'xsd:string']; });
    const cacheMap = {}; params.forEach(x => { cacheMap[x[0]] = cache(x[0]); });
    // Panel sejak 2026-10-02 (C1): sebelum form Edit tampil, nilai yang dikenal tapi belum
    // dibaca dibaca dulu; bila tetap tak diketahui, isian yang tak disentuh tidak dikirim.
    const akanDibaca = P._wanPathForm(d, conn).filter(p => {
      const n = node(doc, p); return n && typeof n === 'object' && !('_value' in n) && !n._object;
    });
    if (akanDibaca.length) temuan('ℹ', 'Edit WAN akan MEMBACA dulu ' + akanDibaca.length + ' nilai dari ONU: '
      + akanDibaca.map(x => x.replace(base, '').replace(wcd, 'WCD.')).join(', '));
    const s2 = P._saringParamBerubah(params, cacheMap, [], [], () => false);
    if (s2.kirim.length || pb.perluBuat) {
      temuan('✗', 'Simpan WAN tanpa perubahan akan MENGIRIM ' + s2.kirim.length + ' param'
             + (pb.perluBuat ? ' + membuat entri PortBinding' : '') + ': '
             + s2.kirim.map(x => x[0].replace(base, '').replace(wcd, 'WCD.') + '=' + tampil(x[0], x[1])
                            + ' (cache ' + (cacheMap[x[0]] === undefined ? 'belum dibaca' : tampil(x[0], cacheMap[x[0]])) + ')').join('; '));
    } else temuan('✓', 'Simpan WAN tanpa perubahan = 0 param');
  });
  if (!(d.wanConnections || []).length) temuan('⚠', 'tidak ada koneksi WAN yang terbaca');

  // ── SSID ──
  bagian('SSID');
  const pwPath = vsec.passwordPath || 'KeyPassphrase';
  tulis('  profil: password=' + pwPath + ' beaconWpa=' + (vsec.beaconWpa || 'WPA/WPA2 (bawaan)')
        + ' beaconOpen=' + (vsec.beaconOpen || 'None') + (vsec.wpaMinimal ? ' wpaMinimal' : '')
        + (vsec.band5MinIdx ? ' band5MinIdx=' + vsec.band5MinIdx : ''));
  (d.ssids || []).forEach(ss => {
    const b = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + ss.idx + '.';
    const band5 = P.is5GHz(ss);
    tulis('\n  [WLAN.' + ss.idx + '] "' + ss.name + '" ' + (band5 ? '5GHz' : '2.4GHz') + (ss.enabled ? ' aktif' : ' nonaktif')
          + ' · Beacon ' + ss.beaconType + ' · password ' + (ss.password ? 'terbaca' : 'tidak terbaca'));
    const nm = cekPath(doc, b + 'SSID');
    tulis('    · SSID         ' + nm.teks);
    if (nm.belumDibaca) temuan('⚠', 'WLAN.' + ss.idx + ' nama SSID belum pernah dibaca GenieACS');
    else if (!nm.w) temuan('✗', 'WLAN.' + ss.idx + ' SSID tidak bisa ditulis');
    const pw = cekPath(doc, b + pwPath);
    tulis('    · password     ' + pwPath + ' → ' + pw.teks);
    if (!pw.ada) temuan('✗', 'WLAN.' + ss.idx + ' password ' + pwPath + ' tidak dikenal di ONU');
    else if (!pw.belumDibaca && !pw.w) temuan('✗', 'WLAN.' + ss.idx + ' password ' + pwPath + ' read-only');
    if (ss.enabled && P._isWpaAuth(ss.beaconType) && ss.beaconType !== (vsec.beaconWpa || 'WPA/WPA2'))
      temuan('⚠', 'WLAN.' + ss.idx + ' BeaconType ONU "' + ss.beaconType + '" ≠ beaconWpa profil "' + (vsec.beaconWpa || 'WPA/WPA2') + '"');
    // Channel
    if (ss.channelWritable) {
      const opsi = [...P._radioChOpts(band5, ss.autoChannel ? 'auto' : String(ss.channel), ss.possibleChannels)
                      .matchAll(/value="(\w+)"/g)].map(m => m[1]);
      tulis('    · channel      sekarang ' + (ss.autoChannel ? 'Auto' : ss.channel) + ' · ONU izinkan '
            + (ss.possibleChannels ? ss.possibleChannels.join(',') : '(tak dilaporkan)') + ' · panel tawarkan ' + opsi.join(','));
      if (!ss.possibleChannels) temuan('ℹ', 'WLAN.' + ss.idx + ' PossibleChannels tidak dilaporkan — panel memakai daftar umum');
    } else tulis('    · channel      tidak bisa diatur (Channel/AutoChannelEnable tidak writable)');
    // Bandwidth
    if (ss.channelWidthType) {
      const opsi = [...P._radioBwOpts(ss.channelWidthType, ss.channelWidthVal, band5).matchAll(/value="([^"]+)"/g)].map(m => m[1]);
      tulis('    · bandwidth    ' + ss.channelWidthParam + ' (' + ss.channelWidthType + ') sekarang ' + JSON.stringify(ss.channelWidthVal)
            + (ss.channelWidthOper ? ' operasi ' + ss.channelWidthOper : '') + ' · opsi ' + opsi.join(','));
      if (ss.channelWidthVal == null) temuan('⚠', 'WLAN.' + ss.idx + ' nilai bandwidth belum pernah dibaca');
      else if (opsi.indexOf(String(ss.channelWidthVal)) < 0)
        temuan('⚠', 'WLAN.' + ss.idx + ' nilai bandwidth ONU ' + JSON.stringify(ss.channelWidthVal) + ' tidak ada di opsi panel (enum belum diukur?)');
    } else tulis('    · bandwidth    tidak bisa diatur dari panel');
    if (ss.maxClients != null) tulis('    · maks klien   ' + ss.maxClients);
  });
  if (!(d.ssids || []).length) temuan('⚠', 'tidak ada WLANConfiguration yang terbaca');

  // ── Setting ──
  bagian('Setting (akun web)');
  const akun = [['Super Admin', vsec.adminSuperUserPath, vsec.adminSuperPassPath || 'VirtualParameters.superAdmin', vsec.adminSuperSupported === false],
                ['User Admin',  vsec.adminUserUserPath  || (s.template === 'X_CMCC' ? '' : 'VirtualParameters.userAdmin'),
                                vsec.adminUserPassPath  || 'VirtualParameters.userPassword',
                                vsec.adminUserSupported === false || s.template === 'X_CMCC']];
  akun.forEach(([nm, up, pp, off]) => {
    if (off) { tulis('  ' + nm + ': dinonaktifkan untuk model ini' + (vsec.adminUserNote && nm === 'User Admin' ? ' — ' + vsec.adminUserNote : '')); return; }
    const cu = up && !/^VirtualParameters\./.test(up) ? cekPath(doc, up) : null;
    const cp = !/^VirtualParameters\./.test(pp) ? cekPath(doc, pp) : null;
    tulis('  ' + nm + ': user ' + (up || '-') + (cu ? ' → ' + cu.teks : '') + ' · pass ' + pp + (cp ? ' → ' + cp.teks : ' (lewat VirtualParameter)'));
    if (cp && !cp.ada) temuan('✗', nm + ' password ' + pp + ' tidak dikenal di ONU');
    else if (cp && !cp.belumDibaca && !cp.w) temuan('⚠', nm + ' password ' + pp + ' ditandai read-only oleh ONU');
    if (/^VirtualParameters\./.test(pp)) temuan('ℹ', nm + ' lewat VirtualParameter (path asli tidak didefinisikan di profil)');
  });

  // ── Monitoring ──
  bagian('Monitoring (cache, gratis bagi ONU)');
  const dibaca = new Set(['AssociatedDeviceMACAddress', 'X_ZTE-COM_MACAddress', 'MACAddress', 'AssociatedDeviceRssi',
    'X_ZTE-COM_WLAN_RSSI', 'X_HW_RSSI', 'RSSI', 'X_ZTE-COM_Rssi', 'X_ZTE-COM_SignalStrength', 'SignalStrength',
    'X_ZTE-COM_WLAN_SNR', 'X_HW_SNR', 'X_ZTE-COM_WLAN_Noise', 'X_HW_Noise', 'X_ZTE-COM_TXRate', 'X_HW_TxRate',
    'AssociatedDeviceRate', 'LastDataTransmitRate', 'X_ZTE-COM_RXRate', 'X_HW_RxRate', 'AssociatedDeviceBandWidth',
    'X_ZTE-COM_WLAN_ClientChannelWidth', 'X_HW_FrequencyWidth', 'X_ZTE-COM_WLAN_ClientMode', 'X_HW_WorkingMode',
    'X_HW_SingalQuality', 'X_HW_SignalQuality', 'X_HW_AntennaNum', 'X_HW_BeamFormingSupported', 'X_HW_PSMode',
    'X_HW_DualBandSupported', 'X_ZTE-COM_WLAN_Radio', 'X_ZTE-COM_AssociatedDeviceName', 'X_HW_AssociatedDevicedescriptions',
    'X_ZTE-COM_WLAN_BytesSend', 'X_ZTE-COM_BytesSent', 'X_ZTE-COM_WLAN_BytesReceived', 'X_ZTE-COM_BytesReceived',
    'X_ZTE-COM_TxSucPkt', 'X_ZTE-COM_PacketsSent', 'X_ZTE-COM_RxSucPkt', 'X_ZTE-COM_PacketsReceived',
    'X_ZTE-COM_TxFailPkt', 'X_ZTE-COM_RxFailPkt', 'X_ZTE-COM_WLAN_RetryCount', 'X_ZTE-COM_StayTime', 'X_HW_Uptime',
    'AssociatedDeviceAuthenticationState', 'AssociatedDeviceIPAddress']);
  const adField = {};
  Object.keys(node(doc, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration') || {}).filter(k => k[0] !== '_').forEach(wi => {
    const ad = node(doc, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + wi + '.AssociatedDevice') || {};
    Object.keys(ad).filter(k => k[0] !== '_').forEach(ai => {
      Object.keys(ad[ai] || {}).filter(f => f[0] !== '_' && ad[ai][f] && '_value' in ad[ai][f]).forEach(f => {
        if (!(f in adField) || adField[f] === '' ) adField[f] = ad[ai][f]._value;
      });
    });
  });
  const adKeys = Object.keys(adField);
  if (!adKeys.length) tulis('  Klien WiFi (AssociatedDevice): tidak ada di cache');
  else {
    const baru = adKeys.filter(k => !dibaca.has(k));
    tulis('  Klien WiFi: ' + adKeys.length + ' field di cache; sudah dibaca panel: ' + adKeys.filter(k => dibaca.has(k)).join(', '));
    if (baru.length) temuan('ℹ', 'field klien WiFi belum dibaca panel: '
      + baru.map(k => k + '=' + tampil(k, adField[k])).join(', '));
  }
  const hl = d.hostList || [];
  tulis('  Perangkat terhubung (panel): ' + hl.length + ' aktif; dengan telemetri radio: ' + hl.filter(h => h.radio).length);
  // Optik & info perangkat
  const optik = [];
  const cariOptik = (n, p) => {
    if (!n || typeof n !== 'object') return;
    if ('_value' in n) { if (/Temperature|Voltage|Bias|TXPower|RXPower|TxPower|RxPower|Current/i.test(p)) optik.push([p, n._value]); return; }
    Object.keys(n).filter(k => k[0] !== '_').forEach(k => cariOptik(n[k], p + '.' + k));
  };
  Object.keys(node(doc, 'InternetGatewayDevice.WANDevice.1') || {}).filter(k => /InterfaceConfig|PON|Optical/i.test(k))
    .forEach(k => cariOptik(node(doc, 'InternetGatewayDevice.WANDevice.1.' + k), k));
  tulis('  Panel menampilkan: RX ' + d.rx + ' · TX ' + d.tx + ' · suhu ' + d.temp + ' · mode ' + (d.ponMode || d.mode));
  if (optik.length) tulis('  Optik di cache: ' + optik.map(([p, v]) => p.replace(/^.*?\./, '') + '=' + v).join(', '));

  return { id, model: pc, mfr, laporan };
}

(async () => {
  const sn = process.argv[2];
  if (!sn) { console.error('Pakai: node tools/audit_ont.js <SN> [--json berkas]'); process.exit(2); }
  try {
    const h = await audit(sn);
    console.log(h.laporan.baris.join('\n'));
    console.log('\n══ RINGKASAN ══');
    console.log(h.laporan.ringkas.length ? h.laporan.ringkas.join('\n') : '  ✓ tidak ada temuan ⚠/✗');
    const j = process.argv.indexOf('--json');
    if (j > 0 && process.argv[j + 1]) {
      fs.writeFileSync(process.argv[j + 1], JSON.stringify({ id: h.id, model: h.model, mfr: h.mfr, ringkas: h.laporan.ringkas }, null, 1));
    }
  } catch (e) {
    console.error('Gagal: ' + e.message);
    process.exit(1);
  }
})();
