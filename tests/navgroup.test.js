#!/usr/bin/env node
/* Uji menu bercabang di sidebar: Maps → Peta Jaringan / Data ODC / Master Data.
 *
 * Yang dijaga di sini adalah hal-hal yang rusak DIAM-DIAM — tampilan tetap
 * terlihat benar, tapi perilakunya salah:
 *
 *  1. Induk "Maps" tidak boleh punya data-page. Kalau ia punya, mengkliknya
 *     akan memuat /pages/maps.html padahal Maps bukan halaman lagi — yang
 *     muncul halaman kosong tanpa ada yang tahu kenapa.
 *
 *  2. navigateTo() harus membersihkan .active dari .nav-subitem juga. Kalau
 *     hanya .nav-item yang dibersihkan, sorotan cabang menempel selamanya
 *     dan sidebar menunjukkan DUA menu aktif sekaligus.
 *
 *  3. Rail sempit (74px) harus menyembunyikan cabang, TAPI laci ponsel harus
 *     mengembalikannya sebagai `grid` — bukan `revert`. `revert` mengembalikan
 *     display bawaan (block), dan itu membunuh animasi 0fr→1fr sehingga
 *     cabangnya tak pernah bisa dibuka di ponsel.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const idx  = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'main.js'), 'utf8');
const base = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'base.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const stripHtml = s => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs   = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripCss  = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

const idxC  = stripHtml(idx);
const mainC = stripJs(main);
const baseC = stripCss(base);

// ═══ 1 · Struktur sidebar ═══
const grp = (idxC.match(/<div class="nav-group" data-group="maps"[^>]*>([\s\S]*?)\n      <\/div>/) || [])[1] || '';
ok(!!grp, 'grup nav Maps ditemukan di index.html');

const toggle = (grp.match(/<a[^>]*class="nav-item nav-group-toggle"[^>]*>/) || [])[0] || '';
ok(!!toggle, 'induk Maps memakai .nav-item.nav-group-toggle');
ok(!/data-page/.test(toggle),
   'induk Maps TIDAK punya data-page — kalau punya, mengkliknya memuat halaman yang tak ada');
ok(/nav-caret/.test(grp), 'ada ikon caret penanda bisa dibuka/tutup');

[['maps', 'Peta Jaringan'], ['odc', 'Data ODC'], ['master-data', 'Master Data']]
  .forEach(([p, label]) => {
    const re = new RegExp('<a[^>]*class="nav-subitem"[^>]*data-page="' + p + '"');
    ok(re.test(grp), 'cabang ada & data-page benar: ' + p);
    ok(grp.includes(label), 'label cabang tampil: ' + label);
  });
ok((grp.match(/class="nav-subitem"/g) || []).length === 3, 'tepat 3 cabang di bawah Maps');

// Menu lain tidak boleh ikut terseret ke dalam grup.
['dashboard', 'devices', 'settings'].forEach(p => {
  // class-nya boleh membawa modifier lain (mis. "nav-item active" di Dashboard)
  ok(new RegExp('class="nav-item[^"]*"[^>]*data-page="' + p + '"').test(idxC),
     'menu datar tetap utuh: ' + p);
  ok(!grp.includes('data-page="' + p + '"'), p + ' tidak ikut masuk ke grup Maps');
});

// ═══ 2 · Routing ═══
// main.js utuh tak bisa di-require (ada optional chaining + DOM), jadi
// potongan fungsinya diekstrak — yang diuji fungsinya sendiri, bukan tiruan.
const from = main.indexOf('function pageToPath');
const to   = main.indexOf('// ─── Navigation (fetch-based) ───');
ok(from >= 0 && to > from, 'potongan fungsi routing ditemukan di main.js');
const App = { currentDevice: null };
// eslint-disable-next-line no-eval
const R = eval('(function(){' + main.slice(from, to) +
               ';return {pageToPath,pathToPage,NAV_GROUPS,groupOfPage};})()');

const ROUTES = {
  dashboard: '/dashboard',
  devices:   '/devices',
  settings:  '/settings',
  maps:      '/maps',
  odc:       '/maps/odc',
  'master-data': '/maps/master-data',
};
Object.keys(ROUTES).forEach(page => {
  ok(R.pageToPath(page) === ROUTES[page], 'pageToPath(' + page + ') → ' + ROUTES[page]);
  ok(R.pathToPage(ROUTES[page]) === page, 'pathToPage(' + ROUTES[page] + ') → ' + page);
  // URL yang di-bookmark sering membawa garis miring di ujung.
  ok(R.pathToPage(ROUTES[page] + '/') === page, 'garis miring di ujung tetap terpetakan: ' + page);
});
// /maps tidak boleh menelan cabangnya (prefix-match yang terlalu longgar).
ok(R.pathToPage('/maps/odc') !== 'maps', '/maps/odc TIDAK jatuh kembali ke halaman maps');
ok(R.pathToPage('/maps/entah-apa') === 'dashboard', 'cabang tak dikenal jatuh aman ke dashboard');

// ═══ 3 · Peta grup ═══
ok(R.NAV_GROUPS && Array.isArray(R.NAV_GROUPS.maps), 'NAV_GROUPS.maps adalah daftar');
ok(R.NAV_GROUPS.maps.join(',') === 'maps,odc,master-data', 'isi NAV_GROUPS.maps benar & berurutan');
['maps', 'odc', 'master-data'].forEach(p =>
  ok(R.groupOfPage(p) === 'maps', 'groupOfPage(' + p + ') → maps'));
['dashboard', 'devices', 'settings'].forEach(p =>
  ok(R.groupOfPage(p) === null, 'groupOfPage(' + p + ') → null (bukan anggota grup)'));

// Daftar di NAV_GROUPS harus cocok dengan yang benar-benar ada di sidebar —
// kalau meleset, induknya tak pernah menyala di halaman yang terlewat.
R.NAV_GROUPS.maps.forEach(p =>
  ok(grp.includes('data-page="' + p + '"'), 'NAV_GROUPS.maps sinkron dengan sidebar: ' + p));

// ═══ 4 · PAGE_META ═══
const meta = (mainC.match(/const PAGE_META = \{([\s\S]*?)\n\};/) || [])[1] || '';
ok(!!meta, 'blok PAGE_META ditemukan');
['odc', "'master-data'"].forEach(k =>
  ok(new RegExp('(^|\\s)' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*\\{').test(meta),
     'PAGE_META punya entri: ' + k));
ok(/title:\s*'Data ODC'/.test(meta),      'judul header Data ODC terdaftar');
ok(/title:\s*'Master Data'/.test(meta),   'judul header Master Data terdaftar');
ok(/title:\s*'Peta Jaringan'/.test(meta), 'Maps berganti judul jadi Peta Jaringan');

// ═══ 5 · Pengikatan klik ═══
// Diperiksa DI DALAM initNavigation, bukan di seluruh berkas: pola
// `.nav-item, .nav-subitem` muncul juga di navigateTo, jadi pencarian
// global tetap hijau walau pengikatan kliknya sendiri sudah rusak.
const initNav = (mainC.match(/function initNavigation\(\)[\s\S]*?\n\}/) || [])[0] || '';
ok(!!initNav, 'fungsi initNavigation ditemukan');
ok(/querySelectorAll\('\.nav-group-toggle'\)/.test(initNav),
   'induk grup punya penanganan klik sendiri (buka/tutup)');
ok(/classList\.toggle\('open'\)/.test(initNav), 'klik induk membuka/menutup cabang');
ok(/querySelectorAll\('\.nav-item, \.nav-subitem'\)/.test(initNav),
   'cabang ikut terikat navigasi — tanpa ini cabang tidak bisa diklik sama sekali');

// ═══ 6 · Keadaan aktif ═══
const navTo = (mainC.match(/async function navigateTo[\s\S]*?\n\}/) || [])[0] || '';
ok(!!navTo, 'fungsi navigateTo ditemukan');
ok(/querySelectorAll\('\.nav-item, \.nav-subitem'\)[\s\S]{0,90}remove\('active'\)/.test(navTo),
   '.active dibersihkan dari .nav-subitem juga — kalau tidak, dua menu tampak aktif sekaligus');
ok(/querySelector\(`\[data-page="\$\{navPage\}"\]`\)/.test(navTo),
   'pemilih aktif tidak dipatok ke .nav-item (cabang memakai kelas berbeda)');
ok(/has-active/.test(navTo), 'induk grup ikut ditandai saat salah satu cabangnya aktif');
ok(/classList\.add\('open'\)/.test(navTo),
   'grup dibuka otomatis — item aktif tidak boleh tersembunyi di grup tertutup');

// ═══ 7 · Laci ponsel ═══
const drawer = (mainC.match(/sidebar\.querySelectorAll\([^)]*\)\.forEach[\s\S]{0,220}/) || [])[0] || '';
ok(/\.nav-item\[data-page\]/.test(drawer),
   'penutup laci mengecualikan induk grup — membuka cabang tak boleh langsung menutup laci');
ok(/\.nav-subitem/.test(drawer), 'memilih cabang tetap menutup laci ponsel');

// ═══ 8 · CSS ═══
ok(/\.nav-sub\s*\{[\s\S]{0,200}grid-template-rows:\s*0fr/.test(baseC),
   'buka-tutup memakai grid-template-rows 0fr (tinggi sebenarnya, bukan max-height tebakan)');
ok(/\.nav-group\.open\s*>\s*\.nav-sub\s*\{\s*grid-template-rows:\s*1fr/.test(baseC),
   'keadaan terbuka → 1fr');
ok(!/\.nav-sub[\s\S]{0,160}max-height/.test(baseC),
   'TIDAK memakai max-height — angkanya selalu salah begitu jumlah cabang berubah');
ok(/\.nav-subitem\s*\{/.test(baseC), 'ada gaya .nav-subitem');
ok(/\.nav-subitem\.active\s*\{/.test(baseC), 'cabang aktif punya gaya tersendiri');
ok(/\.nav-sub::before/.test(baseC), 'ada garis induk (trunk) yang menghubungkan cabang');
ok(/\.nav-group\.has-active\s*>\s*\.nav-group-toggle/.test(baseC),
   'induk menyala saat cabangnya aktif — satu-satunya petunjuk posisi di rail sempit');

// Rail sempit menyembunyikan; laci ponsel mengembalikan sebagai grid.
const collapsed = (baseC.match(/\.sidebar\.collapsed \.brand-text[\s\S]*?display:\s*none;/) || [])[0] || '';
ok(/\.nav-sub/.test(collapsed) && /\.nav-caret/.test(collapsed),
   'rail 74px menyembunyikan cabang & caret');
const mob = (baseC.match(/@media \(max-width: 768px\)[\s\S]*?\n\}/) || [])[0] || '';
ok(/\.sidebar\.collapsed \.nav-sub\s*\{\s*display:\s*grid/.test(mob),
   'di ponsel cabang dikembalikan sebagai GRID, bukan revert (revert=block → animasi mati)');
ok(!/\.nav-sub[^;{]*\}?\s*\{?[^}]*display:\s*revert[^}]*\}\s*$/.test(
     (mob.match(/\.sidebar\.collapsed \.nav-sub[^}]*\}/) || [''])[0]),
   '.nav-sub tidak ikut daftar `revert`');

// ═══ 9 · Halaman ═══
[['odc', 'page-odc'], ['master-data', 'page-master-data']].forEach(([f, id]) => {
  const p = path.join(ROOT, 'frontend', 'pages', f + '.html');
  ok(fs.existsSync(p), 'berkas halaman ada: pages/' + f + '.html');
  if (fs.existsSync(p)) {
    const h = fs.readFileSync(p, 'utf8');
    ok(new RegExp('<div class="page" id="' + id + '">').test(h),
       'pages/' + f + '.html memakai pembungkus .page dengan id ' + id);
  }
});

console.log('navgroup: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
