#!/usr/bin/env node
/* Uji batas tunggu Refresh/Summon (ACS.SUMMON_WAIT_MS).
 *
 * LATAR: 2026-08-02, laporan "HWTC ZL-2113X kalau di-refresh selalu gagal /
 * ONU tidak merespon". Ternyata refresh-nya BERHASIL — panel yang menyerah
 * kecepatan. Diukur langsung pada SN HWTC1006F0F0 lewat NBI:
 *
 *     summon #1 → HTTP 200, 60,4 dtk
 *     summon #2 → HTTP 200, 60,0 dtk
 *     summon #3 → HTTP 200, 59,5 dtk
 *
 * Log CWMP memastikan jedanya ada pada ONU membalas connection-request
 * (09:09:25 dan 09:10:25 — tepat 60 dtk sesudah tiap CR), bukan pada lamanya
 * sesi. TR-069 memang membolehkan CPE menolak CR yang datang kurang dari
 * semenit sejak yang terakhir, dan firmware ini menerapkannya sebagai jeda
 * tetap. 207 unit ZL-2113X di lapangan berperilaku sama.
 *
 * Yang dijaga berkas ini:
 *   1. Batas tunggu harus punya margin nyata di atas 60 dtk. Angka 30 dtk
 *      (dulu di halaman detail) dan 60 dtk (pas di ambang) sama-sama
 *      menghasilkan laporan "gagal" yang keliru.
 *   2. Kedua penunggu (pollForUpdate & ACS.tungguTask) memakai konstanta yang
 *      SAMA. Dulu keduanya menyimpan angka sendiri-sendiri dan berbeda diam-
 *      diam — halaman detail 30 dtk, tabel 60 dtk — sehingga tombol yang
 *      terlihat sama berperilaku beda.
 *   3. Ada penanda yang bergerak selama menunggu. Tanpa itu layar tampak
 *      menggantung, teknisi menekan Refresh berulang, dan tiap klik menambah
 *      task di antrean ACS (satu ONU sempat menumpuk 18 task karena ini).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'frontend', 'js', f), 'utf8');
const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const apiJs = read('api.js');
const ddJs  = read('device-detail.js');
const devJs = read('devices.js');

const apiC = stripJs(apiJs);
const ddC  = stripJs(ddJs);
const devC = stripJs(devJs);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// ── 1. Konstanta ada, cukup besar, dan diekspor ──
const m = apiC.match(/const\s+SUMMON_WAIT_MS\s*=\s*(\d+)/);
ok(!!m, 'api.js mendefinisikan SUMMON_WAIT_MS');

const nilai = m ? parseInt(m[1], 10) : 0;
// 90 dtk = 60 dtk terukur + margin 50%. Di bawah ini, ZL-2113X kembali
// dilaporkan "tidak merespons" padahal refresh-nya berhasil.
ok(nilai >= 90000,
   'SUMMON_WAIT_MS >= 90000 ms (terukur ~60 dtk pada ZL-2113X; dapat ' + nilai + ')');
// Batas atas: menunggu terlalu lama membuat tombol terkunci tanpa guna kalau
// ONU-nya memang mati.
ok(nilai <= 300000,
   'SUMMON_WAIT_MS <= 300000 ms (jangan mengunci tombol berlebihan; dapat ' + nilai + ')');

ok(/return\s*\{[\s\S]*SUMMON_WAIT_MS[\s\S]*\}/.test(apiC),
   'SUMMON_WAIT_MS diekspor dari modul ACS');

// ── 2. Kedua penunggu memakai konstanta bersama, bukan angka sendiri ──
ok(/const\s+MAX\s*=\s*maxWait\s*\|\|[\s\S]{0,120}?SUMMON_WAIT_MS/.test(ddC),
   'pollForUpdate (device-detail.js) memakai ACS.SUMMON_WAIT_MS sebagai default');

// Penunggu tabel Device kini ACS.tungguTask (api.js, 2026-10-03): menunggu nasib task,
// bukan _lastInform — dan batasnya tetap konstanta yang sama.
ok(/async function tungguTask\([\s\S]{0,200}?batas\s*=\s*maxMs\s*\|\|\s*SUMMON_WAIT_MS/.test(apiC)
   && /ACS\.tungguTask\(d\.id, h,/.test(devC),
   'ACS.tungguTask (dipakai tabel Device) memakai SUMMON_WAIT_MS');

// ── 3. Tombol Refresh tak boleh menimpa dengan angka pendek lagi ──
// Inilah bug aslinya: pollForUpdate default-nya sudah 60 dtk, tapi pemanggil
// di tombol Refresh menimpanya dengan 30000.
ok(!/pollForUpdate\([\s\S]{0,1200}?\b30000\)/.test(ddC),
   'tombol Refresh tidak lagi menimpa batas tunggu dengan 30000 ms');

// Sejak 2026-10-03 tombol Refresh menunggu nasib task (ACS.tungguTask), bukan _lastInform.
ok(/ACS\.tungguTask\(d\.id, hasilSummon, null, batasTunggu\)/.test(ddC),
   'tombol Refresh meneruskan batasTunggu (dari SUMMON_WAIT_MS) ke ACS.tungguTask');
ok(/ACS\.muatSesudah\(d\.id, informSebelum\)/.test(ddC) && /informSebelum = await ACS\.lastInform\(d\.id\)/.test(ddC),
   'dokumen dibaca ulang sampai _lastInform berubah dari nilai TERKINI sebelum refresh');

ok(/batasTunggu\s*=\s*\(ACS\s*&&\s*ACS\.SUMMON_WAIT_MS\)/.test(ddC),
   'batasTunggu bersumber dari ACS.SUMMON_WAIT_MS, bukan angka tertulis');

// ── 4. Penanda bergerak selama menunggu ──
ok(/Menunggu ONU membalas…\s*'\s*\+\s*sisa/.test(ddC),
   'status menampilkan sisa detik, bukan teks diam');

ok(/setInterval\(tampilkanSisa,\s*1000\)/.test(ddC),
   'sisa detik diperbarui tiap 1000 ms oleh setInterval');

ok(/tampilkanSisa\(\);\s*\n\s*let ivHitung/.test(ddC),
   'hitung mundur tampil seketika (dipanggil sekali sebelum setInterval)');

ok(/clearInterval\(ivHitung\)/.test(ddC),
   'hitung mundur dihentikan (tidak bocor sebagai timer menggantung)');

// Dihentikan di KEDUA cabang — berhasil maupun kehabisan waktu.
const badanTombol = ddC.slice(ddC.indexOf('btnRefresh.onclick'));
const jumlahHenti = (badanTombol.match(/hentikanHitung\(\)/g) || []).length;
ok(jumlahHenti >= 2,
   'hentikanHitung() dipanggil di cabang berhasil DAN cabang kehabisan waktu (dapat ' + jumlahHenti + ')');

// ── 5. Pesan waktu habis tidak lagi mengajak klik ulang ──
// "coba lagi sebentar" mendorong teknisi menekan berulang; tiap klik
// menambah task baru di ACS tanpa mempercepat ONU.
ok(!/coba lagi sebentar/i.test(ddC),
   'pesan waktu habis tidak mengajak "coba lagi sebentar" (mencegah tumpukan task)');

// ── 5b. Model rapuh: JANGAN susuri seluruh pohon ──
// 2026-08-02: HWTC ZL-2113X membalas tiap RPC ~450 ms. Menyusuri seluruh pohon
// (~21 sub-pohon, >1100 leaf) menahan CPU-nya menit-menitan; SN HWTCA90D86D8
// senyap total di tengah penyusuran dan tak pernah kembali. Melewati
// ManagementServer sekaligus mencegah cache password tercemar "" — pemicu
// penulisan flash tiap Refresh, dan model ini terbukti rapuh terhadap penulisan
// (12 unit tumbang setelah satu SetParameterValues).
ok(/const\s+MODEL_RAPUH\s*=\s*\[[^\]]*'ZL-2113X'/.test(apiC),
   'ZL-2113X terdaftar sebagai model rapuh');
ok(/const\s+SUBPOHON_PANEL\s*=/.test(apiC), 'ada daftar sub-pohon terbatas untuk model rapuh');

const bSummon = apiC.slice(apiC.indexOf('async function summon'),
                           apiC.indexOf('async function refresh'));
ok(/MODEL_RAPUH\.indexOf\(model\)\s*<\s*0/.test(bSummon),
   'summon memeriksa model sebelum memilih cara refresh');
ok(!/ManagementServer/.test(String(apiC.match(/const\s+SUBPOHON_PANEL\s*=\s*\[[^\]]*\]/) || '')),
   'ManagementServer TIDAK ikut disegarkan pada model rapuh (cegah cache password tercemar)');
['DeviceInfo', 'WANDevice', 'LANDevice'].forEach(function(s) {
  ok(new RegExp("'" + s + "'").test(String(apiC.match(/const\s+SUBPOHON_PANEL\s*=\s*\[[^\]]*\]/) || '')),
     'sub-pohon ' + s + ' tetap disegarkan (data panel tak hilang)');
});
ok(/for \(const s of SUBPOHON_PANEL\) hasil = await kirim/.test(bSummon),
   'sub-pohon dikirim BERURUTAN (ONU rapuh hanya sanggup satu percakapan)');

// Model harus benar-benar sampai ke summon dari SEMUA pemanggil.
ok(/ACS\.summon\(d\.id, d\.root, d\.model\)/.test(ddC),
   'device-detail meneruskan d.model ke summon');
const devJs2 = stripJs(read('devices.js'));
const pemanggil = (devJs2.match(/ACS\.summon\([^)]*\)/g) || []);
ok(pemanggil.length >= 2 && pemanggil.every(function(c) { return /d\.model/.test(c); }),
   'semua pemanggil summon di devices.js meneruskan d.model (dapat ' + pemanggil.join(' | ') + ')');

// ── 6. Refresh tetap operasi BACA — tak boleh menyentuh flash ONU ──
// Penjaga keselamatan: yang dikirim tombol Refresh hanya refreshObject
// (GetParameterNames/GetParameterValues). Kalau suatu saat ada yang
// menyelipkan setParameterValues/reboot ke jalur ini, uji ini gagal.
const summonFn = apiC.slice(apiC.indexOf('async function summon'),
                            apiC.indexOf('async function refresh'));
ok(/refreshObject/.test(summonFn), 'summon() mengirim refreshObject');
ok(!/setParameterValues|"reboot"|'reboot'|factoryReset/.test(summonFn),
   'summon() tidak mengirim penulisan/reboot/factory-reset apa pun');

console.log('summonwait: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
