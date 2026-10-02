#!/usr/bin/env node
/* Uji Simpan Channel & Bandwidth — verifikasi hanya untuk yang DIKIRIM (2026-10-02).
 *
 * LATAR (F670L SN ZTEGD35DA32A): ganti Channel dari Auto ke kanal tetap selalu berakhir
 * galat merah "ONU mengabaikan Bandwidth pada SSID …". ONU sebenarnya MENERIMA (diuji
 * ulang: HTTP 200, 0 fault). Penyebab: panel memverifikasi bandwidth SEMUA slot dari isi
 * dropdown walau bandwidth tak dikirim; BandWidth unit itu belum pernah dibaca (null) →
 * 'Auto' vs null selalu berbeda. Juga: PossibleChannels belum dibaca → 5GHz menawarkan
 * kanal 100–140/165 yang tak didukung keluarga ini.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const dd = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'device-detail.js'), 'utf8');
const iris = n => { const i = dd.indexOf('function ' + n + '('); let j = dd.indexOf('{', i), k = 0;
  for (; j < dd.length; j++) { if (dd[j] === '{') k++; else if (dd[j] === '}' && --k === 0) break; } return dd.slice(i, j + 1); };

let TIPE = 'ztecom', AUTO_AWAL = true;
const slot = (idx, ch, auto, bw) => ({ idx, channel: ch, autoChannel: AUTO_AWAL, channelWritable: true,
  channelWidthType: TIPE, channelWidthParam: 'BandWidth', channelWidthVal: bw, channelWidthOper: null });
function jalankan(bwAwal, pilih) {
  const el = {
    rcCh_g24: { value: pilih.ch, dataset: { awal: 'auto' } },
    rcBw_g24: { value: pilih.bw, dataset: { awal: 'Auto' } },
    btnRadioSave: {}, radioSaveStatus: { style: {} },
  };
  const toast = [], kirim = [];
  const ssids = [slot(1, 8, true, bwAwal), slot(2, 8, true, bwAwal)];
  const ctx = {
    document: { getElementById: id => el[id] || null },
    showToast: (m, t) => toast.push(t + ':' + m), App: {}, renderSsidTab() {},
    _radioBands: () => [{ key: 'g24', is5g: false, ssids }],
    _setParamGuard: (d, p) => { kirim.push(p); return Promise.resolve(); },
    // ONU melapor ulang: channel sudah tetap, bandwidth tetap seperti semula.
    pollForUpdate: (prev, selesai) => selesai({ ssids: ssids.map(s =>
      Object.assign({}, s, { autoChannel: false, channelWidthVal: pilih.bwJadi !== undefined ? pilih.bwJadi : bwAwal })) }),
  };
  vm.createContext(ctx);
  vm.runInContext(iris('_radioHandleSave'), ctx);
  ctx._radioHandleSave({ id: 'X', lastInform: 'a' }, {});
  return new Promise(r => setTimeout(() => r({ toast, kirim: kirim[0] || [] }), 0));
}

(async () => {
  // 1. Kasus lapangan: bandwidth belum pernah dibaca, operator hanya ganti channel
  let h = await jalankan(null, { ch: '8', bw: 'Auto' });
  ok(h.kirim.length === 4 && h.kirim.every(p => /AutoChannelEnable$|Channel$/.test(p[0])), 'hanya channel yang dikirim (2 slot × 2 param)');
  ok(!h.toast.some(t => /mengabaikan Bandwidth/.test(t)), 'TIDAK ada galat palsu "ONU mengabaikan Bandwidth"');
  ok(h.toast.some(t => /^success:/.test(t)), 'dilaporkan berhasil');

  // 2. Bandwidth terbaca & tidak diubah → tetap tanpa galat
  h = await jalankan('40MHz', { ch: '8', bw: '40MHz' });
  ok(h.kirim.length === 4 && h.toast.some(t => /^success:/.test(t)), 'bandwidth sama → tak dikirim, berhasil');

  // 3. Bandwidth DIUBAH dan ONU mengabaikannya → galat tetap muncul (penjaga tidak dilemahkan)
  h = await jalankan('40MHz', { ch: 'auto', bw: '20MHz' });
  ok(h.kirim.length === 2 && h.kirim.every(p => /BandWidth$/.test(p[0])), 'hanya BandWidth yang dikirim');
  ok(h.toast.some(t => /^error:ONU mengabaikan Bandwidth pada SSID 1, SSID 2/.test(t)), 'ONU mengabaikan bandwidth yang DIKIRIM → galat');

  // 4. Bandwidth diubah dan diterapkan → berhasil
  h = await jalankan('40MHz', { ch: 'auto', bw: '20MHz', bwJadi: '20MHz' });
  ok(h.toast.some(t => /^success:/.test(t)), 'bandwidth diterapkan → berhasil');

  // 4b. Kembali ke AUTO: ZTE X_ZTE-COM menolak Channel=0 (cwmp.9003) → hanya AutoChannelEnable
  AUTO_AWAL = false;
  h = await jalankan('40MHz', { ch: 'auto', bw: '40MHz' });
  ok(h.kirim.length === 2 && h.kirim.every(p => /AutoChannelEnable$/.test(p[0]) && p[1] === 'true'),
     'ztecom → Auto: hanya AutoChannelEnable=true per slot, TANPA Channel=0');
  h = await jalankan('40MHz', { ch: '6', bw: '40MHz' });
  ok(h.kirim.length === 4 && h.kirim.some(p => /Channel$/.test(p[0]) && p[1] === 6), 'ztecom → kanal tetap: Channel tetap dikirim');
  TIPE = 'xcmcc';
  h = await jalankan(2, { ch: 'auto', bw: '2' });
  ok(h.kirim.length === 4 && h.kirim.some(p => /\.Channel$/.test(p[0]) && p[1] === 0), 'X_CMCC → Auto: tetap seperti semula (Channel=0 ikut)');
  TIPE = 'ztecom'; AUTO_AWAL = true;

  // 5. Daftar kanal cadangan 5GHz
  const c2 = { _esc: s => String(s) }; vm.createContext(c2);
  vm.runInContext(iris('_radioChCadangan') + iris('_radioChOpts'), c2);
  const cad = c2._radioChCadangan(true, 'ztecom');
  ok(JSON.stringify(cad) === '[36,40,44,48,52,56,60,64,149,153,157,161]', 'ZTE X_ZTE-COM 5GHz: daftar terbukti armada');
  ok(!/value="(100|140|165)"/.test(c2._radioChOpts(true, '60', cad)), 'kanal 100–140/165 tidak ditawarkan');
  ok(c2._radioChCadangan(false, 'ztecom') === null && c2._radioChCadangan(true, 'xcmcc') === null, '2.4GHz & vendor lain: tak berubah');
  ok(/rep\.possibleChannels \|\| _radioChCadangan\(g\.is5g, rep\.channelWidthType\)/.test(dd), 'PossibleChannels dari ONU tetap diutamakan');

  console.log(`radiosimpan: ${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
