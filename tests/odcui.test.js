#!/usr/bin/env node
/* Uji sisi tampilan Data ODC.
 *
 * Yang dijaga di sini rusak DIAM-DIAM — layarnya tetap tergambar:
 *
 *  1. KONTEKS POSISI KANVAS. .oc-wrap memakai position:absolute, sedangkan
 *     .content-area tidak punya position:relative. Tanpa #odcTopo yang
 *     berposisi, kanvas berpatokan ke VIEWPORT: bilah atasnya menyelinap ke
 *     balik header dan nama ODC-nya lenyap. Itu bug "judul saat View" yang
 *     sudah pernah terjadi sekali.
 *
 *  2. pos_x != null, BUKAN truthiness. Koordinat 0 adalah pojok kiri-atas —
 *     tempat yang sah. `if (n.pos_x)` membuat kartu yang digeser ke sana
 *     melompat balik ke tata letak otomatis, dan hanya di titik itu.
 *
 *  3. Pembagian skala zoom saat menggeser. Tanpa itu kartu bergerak lebih
 *     cepat daripada kursor saat diperkecil — terasa seperti "meleset".
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const js   = fs.readFileSync(path.join(ROOT, 'js', 'odc.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'pages', 'odc.html'), 'utf8');
const css  = fs.readFileSync(path.join(ROOT, 'css', 'maps.css'), 'utf8');
const idx  = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const stripJs   = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripHtml = s => s.replace(/<!--[\s\S]*?-->/g, '');
const stripCss  = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

const jsC = stripJs(js), htmlC = stripHtml(html), cssC = stripCss(css), mainC = stripJs(main);

// ═══ 1 · Bug judul: rantai konteks posisi ═══
ok(/#odcTopo\s*\{[^}]*position:\s*relative/.test(cssC),
   '#odcTopo BERPOSISI — tanpa ini kanvas berpatokan ke viewport dan judulnya tertutup header');
ok(/#odcTopo\s*\{[^}]*min-height:\s*0/.test(cssC),
   '#odcTopo min-height:0 — butir flex menolak menyusut, kanvas akan melebihi layar');
ok(/#page-odc\.odc-full\s*\{[^}]*flex:\s*1/.test(cssC),
   'halaman ikut memenuhi tinggi saat topologi tampil');
ok(/\.oc-wrap\s*\{[^}]*position:\s*absolute/.test(cssC), '.oc-wrap tetap absolute di dalamnya');
ok(/classList\.toggle\('odc-full',\s*topo\)/.test(jsC),
   'kelas odc-full dipasang/dilepas mengikuti layar yang aktif');
// Kelasnya harus DILEPAS saat kembali ke daftar, kalau tidak daftar ikut
// terkunci setinggi layar dan tidak bisa digulir.
const layar = (jsC.match(/function _odcLayar[\s\S]*?\n\}/) || [])[0] || '';
ok(/topo/.test(layar) && /odc-full/.test(layar), 'toggle-nya berada di _odcLayar, satu tempat');
ok(/applyPageMeta\(topo \? 'odc-topologi' : 'odc'\)/.test(layar),
   'judul header mengikuti layar yang aktif');
ok(/'odc-topologi':\s*\{/.test(mainC), "PAGE_META punya entri 'odc-topologi'");

// ═══ 2 · Geser kartu ═══
ok(/pos_x != null/.test(jsC),
   'posisi diperiksa dengan != null — 0 adalah koordinat yang SAH, bukan "belum diatur"');
ok(!/if \(n\.pos_x\)\s/.test(jsC), 'TIDAK memakai truthiness untuk pos_x');
// KEDUA sumbu harus dibagi. Memeriksa "ada pembagian di suatu tempat" tidak
// cukup: melepasnya di sumbu X saja tetap membuat kartu meleset mendatar,
// dan pemeriksaan longgar semacam itu sempat meloloskan sabotase.
ok(/drag\.ox \+ \(e\.clientX - drag\.sx\) \/ _odcView\.k/.test(jsC),
   'perpindahan sumbu X dibagi skala zoom');
ok(/drag\.oy \+ \(e\.clientY - drag\.sy\) \/ _odcView\.k/.test(jsC),
   'perpindahan sumbu Y dibagi skala zoom');
ok(/e\.target\.closest\('button'\)/.test(jsC) && /closest\('\.oc-port'\)/.test(jsC),
   'menyeret dari atas tombol/port diabaikan — kalau tidak, klik terasa "kadang tidak berfungsi"');
ok(/if \(!_odcAdmin\(\)\) return;/.test(jsC), 'bukan administrator tidak bisa menggeser');
ok(/\/node\/' \+ d\.node\.id \+ '\/pos'/.test(jsC), 'posisi disimpan ke endpoint khusus');
ok(/oc-can-drag/.test(jsC) && /\.oc-can-drag \.oc-node\s*\{[^}]*cursor:\s*grab/.test(cssC),
   'kursor grab hanya muncul untuk yang benar-benar bisa menggeser');
ok(/\.dragging/.test(cssC), 'ada penanda visual saat kartu sedang diseret');
ok(/_odcGaris\(_odcLaid\)/.test(jsC), 'garis ikut mengalir saat kartu digeser');

// ═══ 3 · Tombol Add ODP di pojok kanan ═══
const tools = (htmlC.match(/<div class="oc-tools">([\s\S]*?)<\/div>/) || [])[1] || '';
ok(!!tools, 'blok oc-tools ditemukan');
ok(/id="odcAddOdp"/.test(tools), 'tombol Add ODP berada di pojok kanan (oc-tools)');
ok(/class="btn btn-primary btn-sm" id="odcAddOdp"/.test(tools),
   'Add ODP tampil sebagai aksi utama, bukan ikon samar');
// Diperiksa PADA tombolnya sendiri, bukan "ada data-admin-only di blok ini":
// tombol Data ODC di sebelahnya juga punya atribut itu, jadi pemeriksaan
// selingkup blok tetap hijau walau pagarnya dicabut dari Add ODP.
ok(/id="odcAddOdp"[^>]*data-admin-only/.test(tools),
   'Add ODP sendiri bertanda data-admin-only — disembunyikan untuk role user');
ok(/id="odcRapikan"/.test(tools), 'tombol Rapikan ada di pojok kanan juga');
// Urutan: aksi yang tidak berbahaya di kiri, penambah data di kanan.
ok(tools.indexOf('odcAddOdp') > tools.indexOf('odcFit'),
   'Add ODP paling kanan, setelah alat tampilan');

ok(/function tambahOdpDariAtas/.test(jsC), 'ada penanganan tombol Add ODP');
ok(/'\/config\/odc\/' \+ _odcData\.odc\.id \+ '\/slot'/.test(jsC),
   'daftar titik sambung diminta dari SERVER — klien tak pernah memegang gambaran utuh');
ok(/odcNSlot/.test(jsC), 'ada pemilih "Sambungkan ke" di form');
const kirim = (jsC.match(/if \(!edit\) \{[\s\S]*?\n    \}/) || [])[0] || '';
ok(/opts\.slots\[parseInt/.test(kirim), 'slot terpilih dipakai sebagai induk saat menyimpan');

// ═══ 4 · Terpasang ═══
ok(/<script src="\/js\/odc\.js">/.test(idx), 'odc.js dimuat index.html');
ok(/PAGE_INIT\['odc'\]/.test(jsC), 'halaman terdaftar di PAGE_INIT');
ok(/PAGE_TEARDOWN\['odc'\]/.test(jsC),
   'padding & overflow .content-area dipulihkan saat meninggalkan halaman');
ok(/\/\^\\\/maps\\\/odc\\\/\\d\+\$\//.test(mainC.replace(/\s/g, ''))
   || /maps\\\/odc\\\/\\d\+/.test(mainC), 'rute /maps/odc/<id> terpetakan ke halaman odc');

// ═══ 5 · Splitter menyatu di dalam kartu ODP ═══
// Splitter TIDAK boleh punya kartu sendiri: di lapangan ia satu kotak dengan
// ODP-nya, dan menggambarnya terpisah membuat orang mengira itu perangkat
// lain di tiang berbeda.
ok(/n\._splitter = \(n\.anak && n\.anak\.biru\) \|\| null/.test(jsC),
   'splitter dipindahkan dari "anak" menjadi bagian dari kartu induknya');
ok(/function _odcBlokSplitter/.test(jsC), 'ada blok splitter di dalam kartu');
ok(/\.oc-sp\s*\{/.test(cssC), 'ada gaya blok splitter');
ok(/\.oc-sp\.odc\s*\{/.test(cssC), 'splitter distribusi dibedakan secara visual dari yang ujung');

// Bedanya dua watak splitter harus TERLIHAT, bukan cuma tertulis.
const blok = (jsC.match(/function _odcBlokSplitter[\s\S]*?\n\}/) || [])[0] || '';
ok(/oc-sp-out/.test(blok), 'splitter UJUNG langsung menampilkan hasil tiap port');
ok(/_odcPill/.test(blok), 'splitter ujung menampilkan status IDEAL/CUKUP/LEMAH');
ok(/oc-dot/.test(blok) && /pt\.nomor/.test(blok),
   'splitter DISTRIBUSI menampilkan port sebagai bundaran bernomor');
ok(/oc-sp-ket/.test(blok), 'ada keterangan jumlah port keluaran');

// ═══ 6 · Warna core hanya untuk ODP ═══
// Splitter duduk di kotak yang sama dengan ODP-nya; tak ada serat antar-kotak
// yang perlu diberi warna, jadi menanyakannya hanya mengundang jawaban asal.
ok(/const pilihCore = isOdp/.test(jsC),
   'pemilih warna core hanya muncul untuk ODP');
ok(/if \(cw\) cw\.onclick/.test(jsC),
   'penanganan klik core menoleransi ketiadaannya (splitter tidak punya)');

// ═══ 7 · Tarik bundaran port → ODP ═══
// Bentuk penugasannya diuji utuh, bukan sekadar "polanya ada di berkas":
// `const dot = null && e.target.closest('.oc-dot')` tetap memuat pola itu
// sambil mematikan fiturnya, dan sabotase semacam itu sempat lolos.
ok(/const dot = e\.target\.closest\('\.oc-dot'\);/.test(jsC),
   'bundaran port bisa mulai ditarik');
ok(/function _odcGambarTarik\(/.test(jsC), 'ada kabel sementara saat menarik');
ok(/function _odcHapusTarik\(/.test(jsC), 'fungsi pembersih kabel sementara ada');
// Definisinya saja tidak cukup — yang menjaga layar tetap bersih adalah
// PEMANGGILANNYA saat drag berakhir. Mengganti nama fungsinya tetap
// mencocokkan pemeriksaan berbasis awalan.
ok(/_odcHapusTarik\(\);/.test(jsC),
   'kabel sementara benar-benar dihapus saat drag selesai — tidak tertinggal di layar');
ok(/oc-target/.test(jsC) && /\.oc-node\.oc-target/.test(cssC),
   'ODP sasaran disorot sebelum kabel dilepas');
ok(/\/pindah'/.test(jsC), 'melepas di atas ODP memanggil endpoint pindah');
// Bundaran ditangani SEBELUM geser kartu, kalau tidak menariknya hanya
// akan menggeser kartunya dan sambungan tak pernah bisa dibuat.
ok(jsC.indexOf("closest('.oc-dot')") < jsC.indexOf("const kartu = e.target.closest('.oc-node')"),
   'bundaran diperiksa sebelum geser kartu');

// ═══ 8 · Ukuran kartu ═══
ok(/const ODC_CARD_W = 190;/.test(jsC), 'kartu dipersempit (216 → 190)');
ok(/\.oc-node\s*\{[^}]*font-size:\s*10px/.test(cssC), 'huruf dasar kartu diperkecil');
ok(/\.oc-node\s*\{[^}]*width:\s*190px/.test(cssC), 'lebar CSS sejalan dengan ODC_CARD_W');

// ═══ 9 · Nama & ukuran form ═══
// Nama hanya untuk ODP: nama ODP dipakai mencari kotaknya di tiang, sedangkan
// splitter selalu disebut lewat ODP yang menaunginya.
ok(/const pilihNama = isOdp/.test(jsC), 'kolom nama hanya muncul untuk ODP');
ok(/if \(nw\) body\.nama = nw\.value;/.test(jsC),
   'nama hanya dikirim bila kolomnya memang ada — tidak membaca elemen yang tak dirender');
// Membaca .value dari elemen yang tidak ada akan melempar TypeError dan
// tombol Simpan berhenti bekerja tanpa pesan apa pun.
ok(!/document\.getElementById\('odcNNama'\)\.value/.test(jsC),
   'tidak ada pembacaan .value tanpa penjaga');

ok(/'<div class="modal modal-slim">'/.test(jsC),
   'form node memakai kelas modal-slim, bukan lebar tertanam di atribut style');
ok(/\.modal-slim\s*\{[^}]*max-width:\s*380px/.test(cssC), 'modal diramping ke 380px');
ok(/\.modal-slim \.form-group\s*\{[^}]*margin-bottom:\s*11px/.test(cssC),
   'jarak antar-kolom dirapatkan');
ok(/\.modal-slim \.cores\s*\{[^}]*repeat\(12/.test(cssC),
   'petak warna core jadi dua baris rapat, tidak lagi melar mendominasi form');
// Semua aturan WAJIB berpagar .modal-slim. Menyentuh .modal global akan
// ikut mengecilkan modal Informasi ONT dan konfirmasi hapus yang memang
// butuh ruang lega.
// Diperiksa terbalik: SETIAP pemilih di blok ini wajib diawali .modal-slim.
// Mencari daftar-hitam nama kelas tidak bisa diandalkan — pola `\.modal\b`
// ikut mencocokkan `.modal-slim` itu sendiri, dan versi pertama pemeriksaan
// ini gagal justru karena itu.
// Tanpa batas irisan: yang diuji adalah SETIAP pemilih yang menyebut
// modal-slim wajib DIAWALI olehnya. Versi sebelumnya mengiris dari
// '.modal-slim {' sampai akhir berkas, jadi aturan apa pun yang ditambahkan
// di bawahnya ikut terjaring — batas semacam itu pasti patah suatu hari.
const nakal = (cssC.match(/^[^@\s}][^{}\n]*\{/gm) || [])
  .map(x => x.replace(/\{$/, '').trim())
  .filter(sel => sel.indexOf('modal-slim') >= 0)
  .filter(sel => !sel.split(',').every(p => p.trim().indexOf('.modal-slim') === 0));
ok(nakal.length === 0,
   'setiap aturan berpagar .modal-slim — modal lain (Informasi ONT, konfirmasi) tetap lega'
   + (nakal.length ? ' | bocor: ' + nakal.join(' / ') : ''));

// ═══ 10 · Mode ODP: Rasio vs Splitter (PRD §4.4 A/B) ═══
ok(/const pilihMode = isOdp/.test(jsC), 'pilihan cara membagi hanya untuk ODP');
ok(/data-m="tap"/.test(jsC) && /data-m="plc"/.test(jsC), 'dua mode: Rasio dan Splitter');
ok(/id="odcNPlcOdp"/.test(jsC), 'ada dropdown 1:2 / 1:4 / dst untuk mode Splitter');
ok(/body\.mode = modePilih/.test(jsC), 'mode ikut terkirim ke server');
// Hanya satu kolom yang relevan pada satu saat; menampilkan keduanya membuat
// orang mengisi kolom yang tidak akan pernah dipakai.
ok(/odcWrapTap'\)\.hidden\s*=\s*modePilih !== 'tap'/.test(jsC),
   'kolom rasio disembunyikan saat mode Splitter');
ok(/odcWrapPlcOdp'\)\.hidden\s*=\s*modePilih !== 'plc'/.test(jsC),
   'kolom PLC disembunyikan saat mode Rasio');

// `'…' + + (cond ? '' : ' hidden')` itu UNARY PLUS: hasilnya "…NaN" dan
// atribut hidden tak pernah terpasang, sehingga KEDUA dropdown tampil
// bersamaan. node --check tetap lolos karena sintaksnya sah.
ok(!/\+\s*\+\s*\(\(/.test(jsC),
   'tidak ada "+ +" (unary plus) yang diam-diam mengubah string jadi NaN');
ok(/'<div class="form-group" id="odcWrapTap"'\s*\n?\s*\+\s*\(\(isOdp/.test(jsC),
   'atribut hidden dirangkai dengan benar');

ok(/function _odcKartuLangsung/.test(jsC), 'ODP mode langsung punya kartunya sendiri');
ok(/if \(n\.mode === 'plc'\) return _odcKartuLangsung\(n\);/.test(jsC),
   'kartu titik akhir dipakai untuk mode plc — bukan meter pembagi merah/biru');
ok(/n\._slotBebas = n\.mode !== 'plc'/.test(jsC),
   'titik akhir tidak menawarkan slot tambah — tak ada keluaran tersisa');
ok(/\.oc-node\.oc-langsung\s*\{[^}]*border-left/.test(cssC),
   'titik akhir dibedakan dengan tepi tebal, bukan warna saja');

// ═══ 11 · Tidak ada rumus dB di klien ═══
// Angka daya HARUS datang dari server. Rumus yang disalin ke sini akan
// berbeda dari ekspor PDF suatu hari, dan bedanya tidak terlihat sebagai galat.
ok(!/loss_biru\s*[-+]/.test(jsC) && !/in_dbm\s*-\s*/.test(jsC),
   'tidak ada pengurangan redaman di klien — seluruh angka datang dari server');

console.log('odcui: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
