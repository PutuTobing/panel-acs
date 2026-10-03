#!/usr/bin/env node
/* Uji profil ZTE keluarga X_ZTE-COM: F679L, F670L, dan F6600P (C2, 2026-10-02).
 *
 * F6600P kini PROFIL SENDIRI (permintaan operator): isi WAN salinan F679L, tetapi
 * akun web DUA (User.1 admin, User.2 user) dan 5GHz WiFi 6 menawarkan 160MHz —
 * tanpa menggeser F679L/F670L yang sudah teruji.
 *
 * LATAR: F6600P (WiFi 6) tidak punya profil → jatuh ke X_CMCC (ZTE F663). Audit
 * read-only SN ZTEGD3BE4ED4 membuktikan strukturnya identik F679L/F670L, dan tanpa
 * profil Simpan WAN mengirim ConnectionType='PPPoE_Routed' — nilai yang tak dikenal
 * firmware ini (PossibleConnectionTypes PPP = 'IP_Routed,PPPoE_Bridged').
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const ctx = {
  console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout() {},
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'settings.js'), 'utf8'), ctx);

// ══ 1. F6600P memakai profil yang sama dengan F679L/F670L ══
const w  = ctx.getWanProfile('F6600P', 'BCBD84', 'ZTE');
const wf = ctx.getWanProfile('F679L', 'BCBD84', 'ZTE');
ok(w.matched === true && w.template === 'X_ZTE-COM', 'F6600P punya profil WAN X_ZTE-COM (tidak lagi jatuh ke X_CMCC)');
ok(JSON.stringify(w.params) === JSON.stringify(wf.params), 'param WAN F6600P = F679L');
ok(w.params.vlanId === 'X_ZTE-COM_VLANID' && w.params.vlanEnable === 'X_ZTE-COM_VLANEnable'
   && w.params.service === 'X_ZTE-COM_ServiceList' && w.params.cos === 'X_ZTE-COM_8021P',
   'VLAN/service/CoS X_ZTE-COM pada koneksi');
ok(w.params.pppConnType === '', 'ConnectionType PPP TIDAK dipush saat edit (firmware tak kenal PPPoE_Routed)');
ok(w.createConnType && w.createConnType.ppp === 'IP_Routed', 'Buat WAN PPPoE memakai IP_Routed');
ok(!Object.values(w.params).some(v => /X_CMCC/.test(v || '')), 'tidak ada nama X_CMCC');
ok(w.features.portBindingTable === true && w.features.createNewWcd === false,
   'binding lewat tabel X_ZTE-COM_PortBinding; WAN baru di WCD.1');
ok(w.dualStack && w.dualStack.param === 'X_ZTE-COM_IPMode' && w.dualStack.type === 'xsd:string'
   && w.dualStack.valueOff === 'IPv4', 'dualstack: IPMode string Both/IPv4');

// ══ 2. WiFi & akun ══
const s = ctx.getVendorSecurityConfig('F6600P', 'BCBD84', 'ZTE');
ok(s && s.beaconWpa === 'WPAand11i' && s.beaconOpen === 'None' && s.openMinimal === true,
   'WiFi F6600P: WPAand11i, open None minimal (sama F679L)');
ok(s && s.adminSuperPassPath === 'InternetGatewayDevice.User.1.Password', 'Super Admin = User.1');
ok(s && s.productClasses === 'F6600P', 'F6600P punya entri WiFi/akun sendiri');
ok(s && s.adminSuperUserPath === 'InternetGatewayDevice.User.1.Username', 'Super Admin username = User.1');
ok(s && s.adminUserSupported !== false && s.adminUserPassPath === 'InternetGatewayDevice.User.2.Password'
   && s.adminUserUserPath === 'InternetGatewayDevice.User.2.Username', 'User Admin = User.2 (aktif)');
ok(s && JSON.stringify(s.bw5Extra) === '["160MHz"]', 'F6600P menawarkan 160MHz di 5GHz');
ok(!s.band5MinIdx, 'tanpa band5MinIdx (slot 9 = 2.4GHz)');
const f679s = ctx.getVendorSecurityConfig('F679L', 'X', 'ZTE');
ok(f679s && f679s.productClasses === 'F679L,F670L' && !f679s.bw5Extra, 'F679L/F670L tetap tanpa 160MHz');
// User.2 ('user') terbukti ada & writable di armada F670L/F679L (2026-10-02) → User Admin dibuka
['F670L', 'F679L'].forEach(m => {
  const c = ctx.getVendorSecurityConfig(m, 'C0515C', 'ZTE');
  ok(c && c.adminUserSupported !== false && c.adminUserPassPath === 'InternetGatewayDevice.User.2.Password'
     && c.adminUserUserPath === 'InternetGatewayDevice.User.2.Username' && !c.adminUserUserLocked,
     m + ': User Admin = User.2 (username & password bisa diganti)');
  ok(c.adminSuperPassPath === 'InternetGatewayDevice.User.1.Password', m + ': Super Admin tetap User.1');
});
ok(ctx.getWanProfile('F6600P', 'BCBD84', 'ZTE') && ctx._vcfgDefaults().filter(e => /F6600P/.test(e.productClasses)).length === 1
   && ctx._vcfgDefaults().some(e => e.productClasses === 'F679L,F670L'), 'entri WAN F6600P terpisah dari F679L/F670L');

// ══ 2b. Pilihan 160MHz hanya bila profil menyatakannya ══
const dd = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'device-detail.js'), 'utf8');
const iris = n => { const i = dd.indexOf('function ' + n + '('); let j = dd.indexOf('{', i), k = 0;
  for (; j < dd.length; j++) { if (dd[j] === '{') k++; else if (dd[j] === '}' && --k === 0) break; } return dd.slice(i, j + 1); };
vm.runInContext(iris('_radioBwOpts'), ctx);
ok(/value="160MHz"/.test(ctx._radioBwOpts('ztecom', 'Auto', true, ['160MHz'])), '5GHz + bw5Extra → ada 160MHz');
ok(!/160MHz/.test(ctx._radioBwOpts('ztecom', 'Auto', true)), 'tanpa bw5Extra (F679L) → tanpa 160MHz');
ok(!/160MHz/.test(ctx._radioBwOpts('ztecom', 'Auto', false, ['160MHz'])), '2.4GHz tidak pernah mendapat 160MHz');
ok(/_radioBwOptsSafe\(rep\.channelWidthType, rep\.channelWidthVal, g\.is5g, g\.is5g \? _bw5Extra : \[\]\)/.test(dd),
   'panel Channel & Bandwidth meneruskan bw5Extra hanya untuk 5GHz');

// ══ 3. F679L & F670L tidak berubah ══
['F679L', 'F670L'].forEach(m => {
  const p = ctx.getWanProfile(m, 'X', 'ZTE');
  ok(p.matched && p.template === 'X_ZTE-COM', m + ' tetap X_ZTE-COM');
});
ok(ctx.getWanProfile('F663NV9', 'EC6CB5', 'ZTE').template === 'X_CMCC', 'F663NV9 tetap X_CMCC');

// ══ 4. F672Y (2026-10-04) — profil sendiri, hasil audit murni baca SN ZTEGDACB6962 ══
// Tanpa profil: 7 nama parameter WAN X_CMCC tak dikenal ONU dan Simpan WAN mengirim
// ConnectionType='PPPoE_Routed' (tidak ada di PossibleConnectionTypes firmware ini).
{
  const y = ctx.getWanProfile('F672Y', '389148', 'ZTE');
  ok(y.matched === true && y.template === 'X_ZTE-COM', 'F672Y punya profil WAN X_ZTE-COM (tidak lagi jatuh ke X_CMCC)');
  ok(JSON.stringify(y.params) === JSON.stringify(wf.params) && JSON.stringify(y.features) === JSON.stringify(wf.features),
     'param & fitur WAN F672Y = F679L (leaf koneksinya terbukti sama)');
  ok(y.params.pppConnType === '' && y.createConnType.ppp === 'IP_Routed' && y.createConnType.pppBridged === 'PPPoE_Bridged',
     'F672Y: ConnectionType PPP tidak dipush saat edit; WAN baru IP_Routed / PPPoE_Bridged');
  ok(y.features.mtu === false && y.params.mtuPpp === '' && y.params.mtuIp === '',
     'F672Y: MTU belum dibuka (leaf ada, tetapi belum diuji tulis)');
  ok(y.dualStack.param === 'X_ZTE-COM_IPMode' && y.dualStack.slaac.length === 5, 'F672Y: resep dualstack keluarga X_ZTE-COM');
  ok(ctx._vcfgDefaults().filter(e => /F672Y/.test(e.productClasses)).length === 1
     && ctx._vcfgDefaults().find(e => /F672Y/.test(e.productClasses)).productClasses === 'F672Y',
     'entri WAN F672Y terpisah (tidak menumpang entri model lain)');
  const ys = ctx.getVendorSecurityConfig('F672Y', '389148', 'ZTE');
  ok(ys && ys.productClasses === 'F672Y' && ys.beaconWpa === 'WPAand11i' && ys.beaconOpen === 'None'
     && ys.passwordPath === 'KeyPassphrase', 'F672Y: resep WiFi WPAand11i / None, password di KeyPassphrase');
  ok(ys.adminSuperPassPath === 'InternetGatewayDevice.User.1.Password' && ys.adminSuperUserPath === 'InternetGatewayDevice.User.1.Username'
     && ys.adminUserPassPath === 'InternetGatewayDevice.User.2.Password' && ys.adminUserUserPath === 'InternetGatewayDevice.User.2.Username'
     && ys.adminUserSupported !== false && !ys.adminSuperUserLocked && !ys.adminUserUserLocked,
     'F672Y: Super Admin = User.1, User Admin = User.2 — username & password keduanya bisa diganti');
  ok(!ys.bw5Extra && !ys.band5MinIdx, 'F672Y (WiFi 5): tanpa 160MHz, band tidak dari nomor slot');
  ok(Array.isArray(ys.encModes) && ys.encModes.map(m => m.id).join() === 'wpa2aes,wpamix', 'F672Y: dua pilihan Encryption Type');

  // Band & keadaan radio dibaca dari yang DINYATAKAN ONU (dokumen buatan, bukan data asli).
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'api.js'), 'utf8') + '\n;this.ACS = ACS;', ctx);
  const leaf = (v, t) => ({ _value: v, _type: t || 'xsd:string', _writable: true });
  const slot = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, leaf(v, typeof v === 'boolean' ? 'xsd:boolean' : 'xsd:string')]));
  const dok = (model, mfr, wlan) => ({
    _id: 'AA11BB-' + model + '-UJI0001', _lastInform: new Date().toISOString(),
    _deviceId: { _ProductClass: model, _Manufacturer: mfr, _OUI: 'AA11BB', _SerialNumber: 'UJI0001' },
    InternetGatewayDevice: { LANDevice: { 1: { WLANConfiguration: wlan } } },
  });
  const dy = ctx.ACS.mapDevice(dok('F672Y', 'ZTE', {
    1: slot({ SSID: 'RUMAH', Enable: true, Channel: 6, RadioEnabled: true, Status: 'Up', 'X_ZTE-COM_OperatingFrequencyBand': '2.4GHz' }),
    5: slot({ SSID: 'RUMAH', Enable: true, Channel: 36, RadioEnabled: false, Status: 'Disabled', 'X_ZTE-COM_OperatingFrequencyBand': '5GHz' }),
    6: slot({ SSID: 'SSID6', Enable: false, Channel: 0, RadioEnabled: false, Status: 'Disabled', 'X_ZTE-COM_OperatingFrequencyBand': '5GHz' }),
    9: slot({ SSID: 'Net5g-palsu', Enable: false, Channel: 0, RadioEnabled: true, Status: 'Disabled', 'X_ZTE-COM_OperatingFrequencyBand': '2.4GHz' }),
  }));
  const ke = n => dy.ssids.find(x => x.idx === n);
  ok(ke(6).band5 === true && ke(5).band5 === true, 'slot 5GHz yang MATI (Channel 0, nama "SSID6") tetap dikenali 5GHz dari leaf band ONU');
  ok(ke(1).band5 === false && ke(9).band5 === false, 'slot 2.4GHz dikenali 2.4GHz walau namanya memuat "5g"');
  ok(ke(5).radioOff === true && ke(1).radioOff === false && ke(6).radioOff === false,
     'SSID tercentang aktif + radio mati + Status Disabled → radioOff (SSID yang memang nonaktif: tidak)');
  // HWTC melaporkan RadioEnabled=false pada radio yang hidup (25 unit di armada) → tidak boleh ikut.
  const dz = ctx.ACS.mapDevice(dok('ZL-2113X', 'HWTC', {
    1: slot({ SSID: 'PELANGGAN', Enable: true, Channel: 6, RadioEnabled: false, Status: 'Up' }),
  }));
  ok(dz.ssids[0].radioOff === false, 'RadioEnabled=false saja (Status Up, mis. HWTC ZL-2113X) TIDAK dianggap radio mati');
  ok(dz.ssids[0].band5 === undefined || dz.ssids[0].band5 === false, 'model tanpa leaf band ZTE → perilaku lama');
  vm.runInContext(iris('is5GHz') + iris('_uptimeDetik') + iris('_durasiRingkas') + iris('generateConnectionGroups') + iris('_lapData'), ctx);
  ctx.ontPhotoUrl = () => null;
  const Ly = ctx._lapData(dy);
  ok(Ly.blok.filter(b => b.jenis === 'wifi').length === 1 && Ly.blok[0].pita === '2.4 GHz',
     'laporan pelanggan: WiFi yang radionya mati tidak disebut sebagai WiFi aktif');
}

// ══ 5. Kartu "Kondisi Perangkat" (2026-10-04) — CPU, memori, galat optik, port LAN ══
// Dokumen buatan yang meniru bentuk leaf F672Y (nilai karangan).
{
  const L = (v, t) => ({ _value: v, _type: t || 'xsd:string', _timestamp: '2026-10-04T03:00:00.000Z' });
  const belumDibaca = { _writable: false };                // dikenal tetapi belum pernah dibaca
  const buat = (model, mfr, di, pon, eth) => ({
    _id: 'AA11BB-' + model + '-UJI0002', _lastInform: new Date().toISOString(),
    _deviceId: { _ProductClass: model, _Manufacturer: mfr, _OUI: 'AA11BB', _SerialNumber: 'UJI0002' },
    InternetGatewayDevice: { DeviceInfo: di, WANDevice: { 1: pon ? { 'X_ZTE-COM_WANPONInterfaceConfig': pon } : {} },
                             LANDevice: { 1: { LANEthernetInterfaceConfig: eth || {} } } },
  });
  const k = ctx.ACS.mapDevice(buat('F672Y', 'ZTE',
    { 'X_ZTE-COM_CpuUsed': L('3%;2%'), 'X_ZTE-COM_MemUsed': L('66%'), MemoryStatus: { Total: L(131072, 'xsd:unsignedInt') } },
    { SupplyVoltage: L('3260'), BiasCurrent: L('14.20'), Stats: { FECError: L('0', 'xsd:any'), HECError: L('7', 'xsd:any'), DropPackets: belumDibaca } },
    { 1: { Enable: L(true, 'xsd:boolean'), Status: L('Up') }, 2: { Enable: L(true, 'xsd:boolean'), Status: L('NoLink') },
      3: { Enable: L(false, 'xsd:boolean'), Status: L('NoLink') }, 4: { Enable: L(true, 'xsd:boolean'), Status: belumDibaca } })).kondisi;
  ok(k && k.cpu.join() === '3,2' && k.mem === 66 && k.memTotalMb === 128, 'CPU per inti "3%;2%" → [3,2]; memori 66% dari 128 MB');
  ok(k.optik.fec === 0 && k.optik.hec === 7 && k.optik.buang === null && k.optik.tegangan === 3260 && k.optik.bias === 14.2,
     'galat optik: angka dari teks; leaf yang belum dibaca → null (bukan 0)');
  ok(k.port.map(p => p.no + ':' + p.keadaan).join() === '1:terhubung,2:kosong,3:mati,4:',
     'port LAN: Up → terhubung, NoLink → kosong, Enable=false → mati, belum terbaca → kosong tanda');
  ok(k.dibacaRaw === '2026-10-04T03:00:00.000Z' && typeof k.dibaca === 'string' && k.dibaca,
     'waktu pembacaan diambil dari stempel leaf (bukan waktu inform)');
  ok(ctx.ACS.mapDevice(buat('F663NV9', 'ZTE', { SoftwareVersion: L('V1') }, null,
       { 1: { Enable: L(true, 'xsd:boolean'), Status: L('Up') } })).kondisi === null,
     'model tanpa leaf X_ZTE-COM (mis. F663NV9) → kondisi null → kartu tidak tampil');
  ok(ctx.ACS.mapDevice(buat('F672Y', 'ZTE', { 'X_ZTE-COM_CpuUsed': belumDibaca, 'X_ZTE-COM_MemUsed': belumDibaca }, null, {})).kondisi === null,
     'leaf dikenal tetapi belum dibaca → tidak ada kartu berisi angka kosong');
  ok(ctx.ACS.mapDevice(buat('F672Y', 'ZTE', { 'X_ZTE-COM_CpuUsed': L('250%;abc'), 'X_ZTE-COM_MemUsed': L('66%') }, null, {})).kondisi.cpu.length === 0,
     'angka CPU di luar 0–100 dibuang, bukan ditampilkan');

  // Tampilan: teks dari ONU di-escape; warna mengikuti ambang.
  vm.runInContext(iris('_esc') + iris('_kondisiTingkat') + iris('_kondisiHtml'), ctx);
  const h = ctx._kondisiHtml(k);
  ok(/CPU[\s\S]*?kd-baik">3%/.test(h) && /2 inti: 3% · 2%/.test(h) && /Memori terpakai[\s\S]*?66%/.test(h) && /dari 128 MB/.test(h),
     'kartu: CPU (inti tertinggi + rincian) dan memori dengan totalnya');
  ok(/Ada galat/.test(h) && /kd-angka kd-awas[^>]*><b>7<\/b><span>Galat HEC/.test(h) && !/Paket dibuang/.test(h)
     && /3,26 <small>V<\/small>/.test(h) && /14,2 <small>mA<\/small>/.test(h),
     'jalur optik: galat > 0 ditandai; yang belum terbaca tidak ditampilkan; tegangan mV → V');
  ok(/1 dari 4 terhubung/.test(h) && /kd-p-terhubung[^>]*>[\s\S]*?LAN 1/.test(h) && /kd-p-mati[^>]*>[\s\S]*?LAN 3/.test(h),
     'port LAN: ringkasan jumlah + keadaan tiap port');
  ok(ctx._kondisiTingkat(59, 60, 85) === 'baik' && ctx._kondisiTingkat(60, 60, 85) === 'awas' && ctx._kondisiTingkat(85, 60, 85) === 'buruk',
     'ambang warna: baik / awas / buruk');
  const jahat = ctx._kondisiHtml({ cpu: [5], mem: null, optik: null, port: [{ no: 1, keadaan: '', status: '<img src=x onerror=alert(1)>' }] });
  ok(!/<img/.test(jahat) && /&lt;img/.test(jahat), 'teks status dari ONU di-escape');
  ok(!/(?<![A-Za-z])ACS\.|fetch\(|postTask/.test(iris('_kondisiHtml') + iris('renderKondisi')),
     'kartu murni dari data di memori — membukanya tidak mengirim apa pun ke ONU');
}

console.log(`model-zte-xcom: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
