#!/usr/bin/env node
/* Uji lebar kanal Huawei (X_HW_HT20) — per band.
 *
 * DIUKUR, BUKAN DIASUMSIKAN. SN 485754432B16F9AE (HG8245W5-6T), 2026-09-25.
 * Operator mengubah lebar kanal dari web ONU satu per satu; tiap langkah
 * parameternya ditarik ulang lewat getParameterValues:
 *
 *     setelan di web ONU     2.4GHz            5GHz
 *     Auto                   HT20=0  20MHz     HT20=3  80MHz
 *     20 MHz                 HT20=1  20MHz     HT20=1  20MHz
 *     40 MHz                 HT20=2  40MHz     HT20=2  40MHz
 *
 * → X_HW_HT20 adalah ENUM LEBAR KANAL:
 *     0 = Auto 20/40 (2.4GHz) · 1 = 20MHz · 2 = 40MHz · 3 = Auto 80/40/20 (5GHz)
 *
 * KEKELIRUAN YANG DITUTUP BERKAS INI. Sebelumnya panel menyatakan
 * "0 = 20/40, HT20 mati" dan MELABELINYA "40 MHz" — asumsi dari model lain
 * (HG8245A/H single-band) tanpa uji tulis. Akibatnya:
 *   • memilih "40 MHz" sebenarnya menyetel AUTO
 *   • 40 MHz yang sesungguhnya (nilai 2) tidak pernah bisa dipilih
 *   • nilai 3 (Auto 5GHz) tidak punya nama sama sekali
 * Gejalanya diam — tidak ada galat, hanya setelan yang bukan yang dipilih.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ddSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'device-detail.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'api.js'), 'utf8');

// Potong tepat pada penutup fungsinya ("\n}\n"), bukan pada "function"
// berikutnya — di antara keduanya ada blok komentar milik fungsi setelahnya.
const i = ddSrc.indexOf('function _radioBwOpts');
const j = ddSrc.indexOf('\n}\n', i) + 2;
const bwOpts = new Function(ddSrc.slice(i, j) + '; return _radioBwOpts;')();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const nilai = html => (html.match(/value="(\d+)"/g) || []).map(s => s.match(/\d+/)[0]);
const label = html => (html.match(/>([^<]+)<\/option>/g) || []).map(s => s.slice(1, -10));

// ── 5 GHz ──
const h5 = bwOpts('hwht20', 3, true);
ok(JSON.stringify(nilai(h5)) === JSON.stringify(['3', '2', '1']),
   '5GHz menawarkan 3 (auto) / 2 (40) / 1 (20) — dapat ' + JSON.stringify(nilai(h5)));
ok(/Auto \(80\/40\/20 MHz\)/.test(h5), '5GHz: auto dilabeli 80/40/20 seperti di web ONU');
ok(/>40 MHz</.test(h5) && />20 MHz</.test(h5), '5GHz: 40 dan 20 MHz tersedia');
ok(!/value="0"/.test(h5), '5GHz TIDAK menawarkan nilai 0 (belum pernah terlihat di band ini)');

// ── 2,4 GHz ──
const h24 = bwOpts('hwht20', 0, false);
ok(JSON.stringify(nilai(h24)) === JSON.stringify(['0', '2', '1']),
   '2.4GHz menawarkan 0 (auto) / 2 (40) / 1 (20) — dapat ' + JSON.stringify(nilai(h24)));
ok(/Auto \(20\/40 MHz\)/.test(h24), '2.4GHz: auto dilabeli 20/40 (tanpa 80)');
ok(!/value="3"/.test(h24), '2.4GHz TIDAK menawarkan nilai 3 (belum pernah terlihat di band ini)');
ok(!/80/.test(h24), '2.4GHz tidak menyebut 80 MHz sama sekali');

// ── Nilai TERUKUR tidak boleh bergeser artinya ──
// Inilah inti perbaikannya: 2 = 40 MHz di KEDUA band, 1 = 20 MHz di keduanya.
[[true, '5GHz'], [false, '2.4GHz']].forEach(function(b) {
  const h = bwOpts('hwht20', 2, b[0]);
  ok(/value="2"[^>]*>40 MHz</.test(h), b[1] + ': nilai 2 dilabeli 40 MHz');
  ok(/value="1"[^>]*>20 MHz</.test(h), b[1] + ': nilai 1 dilabeli 20 MHz');
  ok(/value="2" selected/.test(h), b[1] + ': nilai terpilih tersorot benar');
});

// Label lama yang KELIRU tidak boleh kembali.
const semua = h5 + h24;
ok(!/HT20 mati|HT20 aktif/.test(semua),
   'label lama "HT20 mati/aktif" sudah tidak ada');
ok(!/value="0"[^>]*>40 MHz</.test(semua),
   'nilai 0 TIDAK lagi dilabeli "40 MHz" — itu kekeliruan yang diperbaiki');

// ── Deteksi band harus otoritatif untuk Huawei ──
// Kalau band salah terbaca, daftar pilihan ikut salah — 5GHz punya Auto
// 80/40/20 yang tidak boleh muncul di 2.4GHz.
ok(/X_HW_RFBand/.test(apiSrc), 'api.js membaca X_HW_RFBand');
// Ambil wilayah di sekitar pemakaian X_HW_RFBand — 'band5:' saja muncul di
// beberapa tempat (termasuk komentar), jadi tidak bisa jadi jangkar.
// Jangkar pada KODE-nya, bukan pada komentar yang menyebutnya lebih dulu.
const iB = apiSrc.indexOf("gv(v, 'X_HW_RFBand')");
// 1200 karakter: sejak 2026-10-04 di antara pemeriksaan X_HW_RFBand dan jalur lama ada
// pemeriksaan band ZTE (X_ZTE-COM_OperatingFrequencyBand) beserta catatannya.
const blokBand = apiSrc.slice(iB, iB + 1200);
ok(/X_HW_RFBand/.test(blokBand), 'X_HW_RFBand dipakai untuk menentukan band5');
ok(/\/\^5\/\.test\(rf\)/.test(blokBand), 'RFBand diawali 5 → band 5GHz');
ok(/\/\^2\/\.test\(rf\)/.test(blokBand), 'RFBand diawali 2 → band 2.4GHz');
ok(/_band5Min/.test(blokBand),
   'vendor tanpa X_HW_RFBand tetap memakai jalur lama (band5MinIdx/heuristik)');

// ── Enkoding penulisan tetap unsignedInt ──
ok(/channelWidthType === 'hwht20'\)/.test(ddSrc)
   && /isInt \? 'xsd:unsignedInt'/.test(ddSrc),
   'X_HW_HT20 ditulis sebagai xsd:unsignedInt (sesuai tipe yang dilaporkan ONU)');

// Komentar yang menyesatkan sudah diperbaiki — kalau tidak, orang berikutnya
// membaca "1 = paksa HT20, 0 = 20/40" dan mengulang kekeliruan yang sama.
ok(!/1 = paksa HT20\/20MHz, 0 = 20\/40MHz/.test(apiSrc),
   'catatan lama yang keliru di api.js sudah diganti');

console.log('hwbandwidth: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
