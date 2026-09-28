#!/usr/bin/env node
/* Uji tombol "Detail klien" di Perangkat Terhubung.
 *
 * KENAPA PER KLIEN DAN HANYA SAAT DITEKAN — ini inti rancangannya.
 *
 * Provision `default` hanya menyegarkan EMPAT field Hosts.Host:
 *     HostName · IPAddress · MACAddress · InterfaceType
 *
 * Diukur 2026-09-25 pada 5.393 entri klien di 1.543 ONU aktif, dan cakupannya
 * persis mengikuti daftar itu:
 *     keempat field di atas ............ 78–100%
 *     LeaseTimeRemaining / AddressSource  1–5%
 *     IPv6Address / VendorClassID / X_HW_* 0%
 *
 * Jadi 0% BUKAN berarti ONU tak punya — melainkan tak pernah diminta. (Pelajaran
 * yang sama dengan flag _writable: cache kosong bukan bukti tak didukung.)
 *
 * Membacanya berkala akan berbiaya ±43.000 pembacaan parameter se-armada tiap
 * penyegaran (8 field × ~3,5 klien × 1.543 ONU), pada sub-pohon yang SUDAH
 * paling berat karena instance Hosts bersifat dinamis. Satu klien saat dibuka
 * = ~16 parameter. Itulah yang dijaga berkas ini: jangan sampai suatu saat
 * seseorang memindahkannya ke pembacaan berkala.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const apiJs = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const ddJs  = fs.readFileSync(path.join(ROOT, 'js', 'device-detail.js'), 'utf8');
const cssS  = fs.readFileSync(path.join(ROOT, 'css', 'device-detail.css'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const apiC  = strip(apiJs);
const ddC   = strip(ddJs);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// ── 1. Indeks host dibawa ──
// Tanpa indeks, jalur parameter tak bisa disusun dan detail per klien mustahil.
ok(/Object\.entries\(h\)/.test(apiC), 'hostList memakai Object.entries (indeks ikut terbawa)');
ok(/hostIdx: hostIdx/.test(apiC), 'hostIdx disertakan pada tiap entri host');
ok(/hostIdx: h\.hostIdx/.test(ddC), 'hostIdx diteruskan ke baris klien di UI');
ok(/k\[0\] !== '_'/.test(apiC), 'kunci metadata GenieACS (_…) disaring dari daftar host');

// ── 2. Pengambilan detail ──
ok(/async function fetchHostDetail\(/.test(apiC), 'ACS.fetchHostDetail ada');
ok(/fetchHostDetail/.test(apiJs.slice(apiJs.indexOf('return {'))), 'diekspor dari modul ACS');

const b = apiC.slice(apiC.indexOf('const HOST_DETAIL_FIELDS'),
                     apiC.indexOf('async function pendingTasks'));
ok(/Hosts\.Host\.' \+ hostIdx/.test(b), 'jalur dibangun dari indeks klien yang ditekan');
ok(/getParameterValues/.test(b), 'memakai getParameterValues (baca, bukan tulis)');
ok(!/setParameterValues|reboot|addObject|deleteObject/.test(b),
   'tidak menulis apa pun ke ONU');
ok(/postTask\(/.test(b),
   'dikirim lewat postTask — tunduk pada pagar & kunci yang sama, bukan jalan pintas');

// Hanya SATU klien per panggilan. Ini pembatas biaya yang sesungguhnya.
ok(!/Hosts\.Host\.\*/.test(b), 'tidak memakai wildcard Host.* (itu akan menarik semua klien)');
const nField = (apiC.match(/const HOST_DETAIL_FIELDS = \[([\s\S]*?)\]/) || ['', ''])[1]
  .split(',').filter(x => x.trim()).length;
ok(nField > 0 && nField <= 20,
   'jumlah field per klien wajar (dapat ' + nField + ', batas 20)');

// Field yang memang berguna harus ada — inilah yang diminta operator.
['IPv6Address', 'LeaseTimeRemaining', 'AddressSource', 'UserClassID',
 'X_HW_NegotiatedRate', 'X_HW_RSSI', 'X_HW_Stats.BytesSent'].forEach(f => {
  ok(apiC.indexOf("'" + f + "'") >= 0, 'field ' + f + ' ikut diminta');
});

// ── 3. TIDAK boleh menjadi pembacaan berkala ──
// Penjaga terpenting berkas ini. Kalau field-field ini masuk ke proyeksi atau
// ke timer, biayanya kembali ke ±43.000 pembacaan per penyegaran.
ok(!/X_HW_RSSI/.test(apiC.slice(apiC.indexOf('const LIST_PROJ'),
                                apiC.indexOf('function _gabungProyeksi'))),
   'field detail TIDAK masuk proyeksi daftar perangkat');
ok(!/setInterval[\s\S]{0,200}fetchHostDetail/.test(ddC),
   'fetchHostDetail tidak dipanggil dari timer mana pun');
const nPanggil = (ddC.match(/ACS\.fetchHostDetail\(/g) || []).length;
ok(nPanggil === 1, 'fetchHostDetail dipanggil dari SATU tempat saja (dapat ' + nPanggil + ')');

// ── 4. Tombol muncul saat kursor mengarah ke baris ──
ok(/cg-detail-btn/.test(ddC), 'tombol detail ada di baris klien');
ok(/_hostDetailBuka\(this\)/.test(ddC), 'tombol memanggil pembuka detail');
ok(/event\.stopPropagation\(\)/.test(ddC),
   'klik tombol tidak ikut melipat/membuka grup di belakangnya');
ok(/c\.hostIdx \?/.test(ddC),
   'klien TANPA indeks tidak diberi tombol — bukan tombol yang gagal saat ditekan');
ok(/\.cg-device:hover \.cg-detail-btn/.test(cssS), 'tombol muncul saat kursor di baris');
ok(/\.cg-detail-btn:focus-visible/.test(cssS),
   'tombol tetap terjangkau lewat keyboard, bukan hanya tetikus');
ok(/@media \(max-width: 560px\)[\s\S]{0,200}cg-detail-btn \{ opacity: 1/.test(cssS),
   'di layar sentuh (tanpa hover) tombol selalu terlihat');

// ── 5. Kejujuran tampilan ──
const bd = ddC.slice(ddC.indexOf('async function _hostDetailBuka'),
                     ddC.indexOf('function _hostTipShow'));
ok(/Menarik detail dari ONU/.test(bd), 'ada penanda sedang menarik data');
ok(/hd-note|Tidak dilaporkan ONU ini/.test(bd),
   'field yang diminta tapi tak dilaporkan DIKATAKAN, bukan disembunyikan');
ok(/e\.pagar/.test(bd), 'penolakan pagar/kunci ditampilkan apa adanya, bukan "gagal"');
ok(/tidak melaporkan detail tambahan/.test(bd), 'kasus kosong punya pesannya sendiri');


// ── 6. Klien Huawei harus MUNCUL, bukan hilang ──
// Gejala nyata 2026-09-25: panel menulis "3 perangkat terhubung — detail tidak
// dilaporkan ONU" padahal Hosts.Host berisi ketiganya lengkap. Sebabnya Huawei
// melaporkan InterfaceType='SSID1'..'SSID8' — bukan '802.11' maupun 'WLAN' —
// sehingga klien tak lolos filter nirkabel MAUPUN LAN dan lenyap dari daftar.
// Tanpa penjaga ini, tombol Detail Klien pun tak pernah terlihat.
ok(/\/\^SSID\\d\/i\.test/.test(apiC),
   "InterfaceType 'SSID1'..'SSID8' dinormalkan jadi nirkabel");
ok(/CDTC\|HWTC\|Huawei/i.test(ddC),
   'Huawei masuk jalur atribusi klien→SSID yang presisi');
// ZTE sengaja TIDAK ikut: jalurnya sudah berjalan di ~1.500 unit dan dijaga
// byte-identik oleh difftest.
ok(!/CDTC\|HWTC\|Huawei\|ZTE/i.test(ddC),
   'ZTE TIDAK ikut diubah (jalur lama dipertahankan byte-identik)');


// ── 7. Sinyal di ATAS + analisa kualitas yang konsisten ──
// Ambang dan warna WAJIB satu sumber dengan popup Perangkat Terhubung.
// Kalau dihitung sendiri di sini, "Baik" di satu tempat bisa berarti "Cukup"
// di tempat lain — dan operator kehilangan kepercayaan pada keduanya.
const bdet = ddC.slice(ddC.indexOf('async function _hostDetailBuka'),
                       ddC.indexOf('function _hostTipShow'));
ok(/_rssiQual\(/.test(bdet), 'memakai _rssiQual yang sama dengan popup, bukan ambang sendiri');
ok(!/-55|-65|-72|-80/.test(bdet), 'tidak menyalin ambang RSSI ke tempat kedua');
ok(/body\.innerHTML = sig \+ baris/.test(bdet), 'blok sinyal dirender PALING ATAS');
ok(/ht-sig-bar/.test(bdet), 'ada bar kualitas, bukan angka telanjang');
ok(/lewati/.test(bdet), 'RSSI & laju tidak diulang sebagai baris biasa');

// ── 8. Ikon berwarna & animasi ──
ok(/hdi-purple|hdi-blue|hdi-cyan|hdi-amber|hdi-green|hdi-slate/.test(bdet),
   'tiap field membawa kelas warna ikon');
ok(/--i:/.test(bdet), 'indeks baris dikirim ke CSS untuk animasi berjenjang');
['hdi-purple','hdi-blue','hdi-cyan','hdi-amber','hdi-green','hdi-slate'].forEach(c => {
  ok(new RegExp('\\.' + c + '\\s*\\{').test(cssS), 'gaya ' + c + ' ada');
});
ok(/\.hd-row:hover/.test(cssS), 'baris bereaksi saat kursor mengarah padanya');
ok(/\.hd-row:hover \.hd-ico/.test(cssS), 'ikon ikut beranimasi saat hover');
ok(/\.hd-row::before/.test(cssS), 'ada garis aksen yang menyapu masuk');
ok(/@keyframes hd-row-in/.test(cssS) && /@keyframes hd-sig-in/.test(cssS),
   'animasi masuk didefinisikan');

// Animasi harus murah: hanya transform & opacity (ditangani compositor).
// Komentar dibuang dulu — blok ini MENYEBUT backdrop-filter untuk menjelaskan
// kenapa ia tidak dipakai, dan itu bukan pemakaian.
const blokAnim = cssS.slice(cssS.indexOf('/* ─── Detail Klien: sinyal'))
                     .replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/backdrop-filter/.test(blokAnim), 'tanpa backdrop-filter (pemicu crash GPU)');
ok(!/@keyframes[^}]*\b(width|height|margin|padding|top|left)\s*:/.test(blokAnim),
   'keyframes tidak menganimasikan properti yang memicu reflow');
ok(/prefers-reduced-motion/.test(blokAnim),
   'menghormati pengguna yang mematikan animasi di sistemnya');

console.log('hostdetail: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
