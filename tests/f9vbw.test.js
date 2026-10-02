#!/usr/bin/env node
/* Uji lebar kanal F9V (X_CU, leaf BandWidth string) — pilihan Auto (2026-10-02).
 *
 * LATAR: panel hanya menawarkan 20MHz/40MHz untuk F9V karena catatan lama menyebut
 * 'Auto' diabaikan firmware → operator tak bisa kembali ke Auto (20/40MHz).
 * Diukur ulang di SN ELWRP93H6275858: tulis 'Auto' lalu baca balik dari ONU → keempat
 * slot 'Auto', 0 fault. Jadi Auto ditawarkan; nilainya string persis 'Auto'.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const dd = fs.readFileSync(path.join(__dirname, '..', 'js', 'device-detail.js'), 'utf8');
const iris = n => { const i = dd.indexOf('function ' + n + '('); let j = dd.indexOf('{', i), k = 0;
  for (; j < dd.length; j++) { if (dd[j] === '{') k++; else if (dd[j] === '}' && --k === 0) break; } return dd.slice(i, j + 1); };
const ctx = { _esc: s => String(s) };
vm.createContext(ctx);
vm.runInContext(iris('_radioBwOpts') + iris('_radioBwOptsSafe'), ctx);

const nilai = h => (h.match(/value="[^"]*"/g) || []).map(x => x.slice(7, -1));
const dari40 = ctx._radioBwOptsSafe('bwstr', '40MHz', false, []);
ok(JSON.stringify(nilai(dari40)) === '["Auto","20MHz","40MHz"]', 'F9V: pilihan Auto, 20MHz, 40MHz');
ok(/value="Auto">Auto \(20\/40 MHz\)/.test(dari40), 'Auto berlabel "Auto (20/40 MHz)", nilainya string persis "Auto"');
ok(/value="40MHz" selected/.test(dari40) && (dari40.match(/selected/g) || []).length === 1, 'nilai ONU 40MHz terpilih');
const dariAuto = ctx._radioBwOptsSafe('bwstr', 'Auto', false, []);
ok(/value="Auto" selected/.test(dariAuto) && !/nilai ONU saat ini/.test(dariAuto),
   'ONU yang sudah Auto tampil sebagai Auto, bukan opsi sisipan');
ok(!/80MHz|160MHz/.test(ctx._radioBwOpts('bwstr', 'Auto', true, ['160MHz'])), 'F9V tidak ditawari 80/160MHz');

// Model lain tak berubah
ok(JSON.stringify(nilai(ctx._radioBwOpts('xcmcc', 2, false))) === '["2","0","1"]', 'X_CMCC tetap 2/0/1');
ok(JSON.stringify(nilai(ctx._radioBwOpts('ztecom', 'Auto', false))) === '["Auto","20MHz","40MHz"]', 'X_ZTE-COM 2.4GHz tetap');

console.log(`f9vbw: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
