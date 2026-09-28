#!/usr/bin/env node
/* Uji tampilan Master Data: kisi kotak kecil untuk rasio & PLC.
 *
 * Yang dijaga di sini rusak DIAM-DIAM — layarnya tetap tampak benar:
 *
 *  1. Pendengar klik harus terpasang di KEDUA wadah. Tombol Edit/Hapus
 *     pindah dari <tbody> ke kisi; kalau pendengarnya tertinggal di tbody
 *     saja, tombolnya tetap tergambar rapi tapi tidak melakukan apa pun.
 *
 *  2. Tombol aksi ber-opacity:0 sampai disorot. Tanpa aturan :focus-visible,
 *     pengguna papan ketik tidak akan pernah bisa menjangkaunya — tombolnya
 *     dapat fokus tapi tetap tak terlihat sama sekali.
 *
 *  3. Kisi dan tabel harus saling meniadakan. Kalau keduanya tampil, daftar
 *     yang sama muncul dua kali.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const js   = fs.readFileSync(path.join(ROOT, 'js', 'master-data.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'pages', 'master-data.html'), 'utf8');
const css  = fs.readFileSync(path.join(ROOT, 'css', 'maps.css'), 'utf8');
const idx  = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const stripJs   = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripHtml = s => s.replace(/<!--[\s\S]*?-->/g, '');
const stripCss  = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

const jsC   = stripJs(js);
const htmlC = stripHtml(html);
const cssC  = stripCss(css);

// ═══ 1 · Dua wadah ada & saling meniadakan ═══
ok(/id="msdGrid"/.test(htmlC), 'wadah kisi #msdGrid ada di halaman');
ok(/id="msdTableWrap"/.test(htmlC), 'wadah tabel #msdTableWrap ada di halaman');
ok(/id="msdGrid"[^>]*\shidden/.test(htmlC),
   'kisi mulai tersembunyi — tanpa itu ia berkedip muncul sebelum data termuat');

const pakai = (jsC.match(/const pakaiKisi = [^;]+;/) || [])[0] || '';
ok(/_mdTab === 'tap'/.test(pakai) && /_mdTab === 'plc'/.test(pakai),
   'kisi dipakai untuk tap & plc (isinya angka pendek)');
ok(!/_mdTab === 'olt'/.test(pakai) && !/_mdTab === 'pon'/.test(pakai),
   'OLT & PON TIDAK memakai kisi — teks bebasnya akan terpotong di kotak kecil');
ok(/grid\.hidden\s*=\s*!pakaiKisi/.test(jsC) && /tbl\.hidden\s*=\s*pakaiKisi/.test(jsC),
   'kisi & tabel saling meniadakan — kalau keduanya tampil, daftarnya dobel');

// ═══ 2 · Klik terpasang di KEDUA wadah ═══
const init = (jsC.match(/function initMasterData\(\)[\s\S]*?\n\}/) || [])[0] || '';
ok(!!init, 'fungsi initMasterData ditemukan');
ok(/\['msdBody',\s*'msdGrid'\]/.test(init),
   'pendengar klik dipasang di tbody DAN kisi — tanpa ini tombol di kotak mati diam-diam');
ok(/data-md-edit/.test(jsC) && /data-md-del/.test(jsC), 'tombol edit & hapus punya penanda data');

// Kotak memang membawa tombolnya sendiri (bukan mengandalkan .rowact tabel).
const tile = (jsC.match(/function _mdTile[\s\S]*?\n\}/) || [])[0] || '';
ok(!!tile, 'fungsi _mdTile ditemukan');
ok(/data-md-edit/.test(tile) && /data-md-del/.test(tile), 'kotak memuat tombol edit & hapus');
ok(/_mdAdmin\(\)/.test(tile),
   'tombol di kotak hanya untuk administrator (pagar sebenarnya tetap di server)');

// ═══ 3 · Isi kotak ═══
ok(/msd-tile-hd/.test(jsC), 'kotak menampilkan rasio sebagai judul');
const val = (jsC.match(/function _mdVal[\s\S]*?\n\}/) || [])[0] || '';
ok(/toFixed\(2\)/.test(val), 'angka redaman ditampilkan 2 desimal (10.32, bukan 10.3)');
ok(/msd-d/.test(val), 'ada titik warna serat di tiap angka');
// Rasio wajib menampilkan KEDUA sisi — satu sisi saja membuat orang mengira
// nilai yang lain tidak ada.
const tap = (jsC.match(/if \(_mdTab === 'tap'\)[\s\S]*?return;/) || [])[0] || '';
ok((tap.match(/_mdVal\(/g) || []).length === 2, 'kotak rasio menampilkan biru DAN merah');
ok(/_mdVal\('b'/.test(tap) && /_mdVal\('r'/.test(tap), 'warnanya biru & merah, sesuai keluaran aslinya');
const plc = (jsC.match(/if \(_mdTab === 'plc'\)[\s\S]*?return;/) || [])[0] || '';
ok(/jumlah_port/.test(plc), 'kotak PLC menyebut jumlah port');

// ═══ 4 · Tidak ada kode mati ═══
ok(!/_mdBar/.test(jsC),
   '_mdBar (bar redaman gaya tabel) dibuang — kode mati yang tampak hidup lebih berbahaya');
ok(!/msd-lossbar/.test(cssC), 'gaya .msd-lossbar ikut dibuang dari CSS');
ok(!/msd-lossbar/.test(jsC), 'tidak ada sisa .msd-lossbar di JS');

// ═══ 5 · CSS ═══
ok(/\.msd-grid\s*\{[\s\S]{0,200}grid-template-columns:\s*repeat\(auto-fill/.test(cssC),
   'kisi memakai auto-fill — jumlah kolom mengikuti lebar layar, bukan angka tetap');
ok(/minmax\(104px/.test(cssC),
   'lebar minimum kotak dipatok agar angka + satuan tidak membungkus');
ok(/\.msd-tile\s*\{/.test(cssC), 'ada gaya .msd-tile');
ok(/\.msd-tile-act\s*\{[\s\S]{0,220}position:\s*absolute/.test(cssC),
   'aksi ditumpuk di pojok (absolute) — kalau memakan ruang tetap, kotaknya jadi dua kali lebih tinggi');
ok(/\.msd-tile:hover \.msd-tile-act[\s\S]{0,120}opacity:\s*1/.test(cssC),
   'aksi muncul saat kotak disorot');
ok(/\.msd-tile-act button:focus-visible[\s\S]{0,120}opacity:\s*1/.test(cssC),
   'aksi bisa dijangkau papan ketik — opacity:0 tanpa aturan ini membuatnya mustahil di-Tab');
ok(/\.msd-empty[\s\S]{0,160}grid-column:\s*1 \/ -1/.test(cssC),
   'pesan "belum ada data" menyeberangi seluruh kolom kisi, bukan selebar satu kotak');
ok(/@media \(max-width: 480px\)[\s\S]{0,260}\.msd-grid/.test(cssC),
   'kotak mengecil di layar ponsel');
// Titik serat BULAT — bentuk inilah yang membedakannya dari pil status.
ok(/\.msd-d\s*\{[\s\S]{0,160}border-radius:\s*50%/.test(cssC),
   'titik warna serat berbentuk bulat (bukan pil) — merah backbone ≠ merah bahaya');

// ═══ 6 · Terpasang di aplikasi ═══
ok(/<script src="\/js\/master-data\.js">/.test(idx), 'master-data.js dimuat index.html');
ok(/PAGE_INIT\['master-data'\]/.test(jsC), 'halaman terdaftar di PAGE_INIT');
ok(/PAGE_ACTIONS\['master-data'\]/.test(jsC), 'tombol Refresh di header terhubung');

console.log('mdgrid: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
