#!/usr/bin/env node
/* Uji info radio: daya pancar & kanal dipakai + pembacaan sekali saat panel dibuka (2026-10-03).
 *
 * LATAR: operator meminta daya pancar WiFi ditampilkan. Di GM220-S nilainya ada
 * (X_CT-COM_PowerValue = 20 dBm) tetapi belum pernah dibaca di 34 dari 36 unit, jadi
 * panel membacanya SEKALI saat "Channel & Bandwidth" dibuka — hanya leaf yang dikenal,
 * hanya slot wakil tiap band, dan tidak pernah untuk model rapuh (ZL-2113X).
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const baca = f => fs.readFileSync(path.join(ROOT, 'frontend', 'js', f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const ctx = {
  console, PAGE_INIT: {}, showToast() {}, App: {}, window: {}, setTimeout, btoa: s => s,
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
  fetch: async () => ({ ok: true, status: 200, text: async () => '[]' }),
};
vm.createContext(ctx);
vm.runInContext(baca('settings.js'), ctx);
vm.runInContext(baca('api.js') + '\n;this.ACS = ACS;', ctx);

// ══ 1. Parsing ══
const L = v => ({ _value: v, _writable: true, _type: 'xsd:string' });
const DIKENAL = { _writable: false };
const dev = (wl, mf, pc) => ctx.ACS.mapDevice({ _id: 'X-' + pc + '-1', _deviceId: { _Manufacturer: mf, _ProductClass: pc, _OUI: 'X' },
  InternetGatewayDevice: { LANDevice: { '1': { WLANConfiguration: { '1': Object.assign({ SSID: L('A'), Enable: L(true), Channel: L(0) }, wl) } } } } });
let s = dev({ 'X_CT-COM_PowerValue': L(20), TransmitPower: L(100), ChannelsInUse: L('13') }, 'CIOT', 'GM220-S').ssids[0];
ok(s.txPowerDbm === 20 && s.txPowerPct === 100 && s.channelInUse === 13, 'GM220-S: 20 dBm, 100%, kanal dipakai 13');
s = dev({ X_CMCC_PowerValue: L('20'), TransmitPower: L('100') }, 'ZTE', 'F663NV9').ssids[0];
ok(s.txPowerDbm === 20 && s.txPowerPct === 100 && s.channelInUse === null, 'F663NV9: dari X_CMCC_PowerValue');
s = dev({ 'X_CT-COM_PowerValue': DIKENAL, TransmitPower: DIKENAL, ChannelsInUse: DIKENAL }, 'CIOT', 'GM220-S').ssids[0];
ok(s.txPowerDbm === null && s.txPowerPct === null && s.channelInUse === null, 'dikenal tapi belum dibaca → null (bukan 0/NaN)');

// PossibleChannels HWTC ZL-2113X: rentang per-wilayah yang bertumpuk → tidak dipakai
s = dev({ PossibleChannels: L('1-11,1-13,10-11,10-13,14,1-14,3-9'), AutoChannelEnable: L(true) }, 'HWTC', 'ZL-2113X').ssids[0];
ok(s.possibleChannels === null, 'ZL-2113X: daftar bertumpuk → null (panel pakai daftar umum, tanpa kanal ganda)');
s = dev({ PossibleChannels: L('1-13') }, 'CIOT', 'GM220-S').ssids[0];
ok(s.possibleChannels && s.possibleChannels.length === 13, "rentang tunggal '1-13' tetap dipakai");

// ══ 2. Tampilan ══
const dd = baca('device-detail.js');
const iris = n => { const i = dd.indexOf('function ' + n + '('); let j = dd.indexOf('{', i), k = 0;
  for (; j < dd.length; j++) { if (dd[j] === '{') k++; else if (dd[j] === '}' && --k === 0) break; } return dd.slice(i, j + 1); };
const c2 = { _esc: x => String(x) }; vm.createContext(c2); vm.runInContext(iris('_radioInfoHtml'), c2);
ok(/Daya pancar <b>20 dBm \(100%\)<\/b>/.test(c2._radioInfoHtml({ txPowerDbm: 20, txPowerPct: 100, channelInUse: 6 }))
   && /Kanal dipakai <b>6<\/b>/.test(c2._radioInfoHtml({ txPowerDbm: 20, txPowerPct: 100, channelInUse: 6 })), 'dBm + persen + kanal dipakai');
ok(/Daya pancar <b>100%<\/b>/.test(c2._radioInfoHtml({ txPowerDbm: null, txPowerPct: 100 })), 'hanya persen bila dBm tak ada');
ok(c2._radioInfoHtml({ txPowerDbm: null, txPowerPct: null, channelInUse: null }) === '', 'tak ada data → tak ada baris kosong');
ok(/_radioInfoHtml\(rep\)/.test(iris('_radioShowConfig')), 'kartu band menampilkan info radio');

// ══ 3. Pembacaan sekali saat panel dibuka ══
async function buka(model, belum) {
  const log = { baca: [], kirim: [], tampil: 0 };
  const c = { App: {}, document: { getElementById: () => null },
    _radioBands: () => [{ key: '24', rep: { idx: 1 } }, { key: '5', rep: { idx: 5 } }],
    _radioShowConfig: () => { log.tampil++; }, _tungguTask: async () => ({ ok: true }),
    ACS: { MODEL_RAPUH: ['ZL-2113X'], TASK_WAIT_MS: 1,
      belumDibaca: async (id, p) => { log.baca.push(p); return belum; },
      postTask: async (id, t) => { log.kirim.push(t); return { taskId: 't' }; },
      fetchDevice: async () => ({ id: 'X', model }) } };
  vm.createContext(c);
  vm.runInContext(dd.slice(dd.indexOf('var _RADIO_BACA = ['), dd.indexOf('async function _radioBuka')) + 'async ' + iris('_radioBuka'), c);
  await c._radioBuka({ id: 'X', model }, { innerHTML: '' });
  return log;
}
(async () => {
  const P = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.X_CT-COM_PowerValue';
  let g = await buka('GM220-S', [P]);
  ok(g.baca.length === 1 && g.baca[0].every(p => /WLANConfiguration\.(1|5)\./.test(p)), 'hanya slot wakil tiap band yang diperiksa');
  ok(g.kirim.length === 1 && g.kirim[0].name === 'getParameterValues' && g.kirim[0].parameterNames.join() === P,
     'SATU getParameterValues, hanya leaf yang belum dibaca');
  ok(g.tampil === 1, 'panel dibuka sesudah pembacaan');
  g = await buka('GM220-S', []);
  ok(g.kirim.length === 0 && g.tampil === 1, 'semua sudah terbaca → tidak ada perintah ke ONU');
  g = await buka('ZL-2113X', [P]);
  ok(g.baca.length === 0 && g.kirim.length === 0 && g.tampil === 1, 'ZL-2113X (rapuh): tidak pernah ada pembacaan tambahan');
  ok(!/setParam|refreshObject|addObject/.test(iris('_radioBuka')), 'pembukaan panel tidak menulis apa pun');
  // Pola lama /_radioBuka\(d, container\)/ ikut cocok dengan DEFINISI fungsinya, jadi
  // tak membuktikan apa-apa soal tombolnya. Kini tombol membukanya di pop-up (2026-10-03).
  ok(/radioBtn\.addEventListener\('click', function\(\) \{\s*_radioBuka\(d, _popBuka\(container/.test(dd),
     'tombol Channel & Bandwidth memakai _radioBuka (di dalam pop-up)');

  console.log(`radioinfo: ${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
