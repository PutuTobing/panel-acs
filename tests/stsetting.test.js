#!/usr/bin/env node
/* Uji tampilan menu Setting (PRD Modul 4).
 *
 * Keempat kriteria penerimaan Modul 4 bisa diperiksa mesin:
 *   1. blok menyesuaikan isi — tidak dipaksa selebar layar
 *   2. ada animasi/transisi pada hover, klik, dan perpindahan sub-menu
 *   3. hierarki kategori tetap jelas walau diringkas — TERMASUK di layar kecil
 *   4. tetap responsif
 *
 * Yang paling dijaga di sini justru hal-hal yang rusak diam-diam:
 *   • @keyframes ditulis di dalam @media (hanya terdaftar saat query cocok)
 *   • animasi menyentuh properti layout tiap frame
 *   • label kategori disembunyikan di layar kecil → hierarki hilang
 *   • transition: all — biaya tersembunyi karena propertinya tak pernah ditulis
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css  = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'settings.css'), 'utf8');
const base = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'base.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'frontend', 'pages', 'settings.html'), 'utf8');
const js   = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'settings.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

/* Komentar dibuang dulu — komentar yang MENJELASKAN sebuah larangan tidak boleh
   terbaca sebagai pelanggarannya. Positif-palsu jenis ini sudah pernah terjadi
   di suite lain proyek ini. */
const cssC  = css.replace(/\/\*[\s\S]*?\*\//g, '');
const baseC = base.replace(/\/\*[\s\S]*?\*\//g, '');
const htmlC = html.replace(/<!--[\s\S]*?-->/g, '');
const jsC   = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function rules(sel, src) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|[},])\\s*' + esc + '(?![\\w-])\\s*\\{([^}]*)\\}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(src || cssC)) !== null) out.push(m[1]);
  return out;
}
const rule = (sel, src) => rules(sel, src).join(' ; ') || null;

/* Isi @media, dengan kurung bersarang dihitung benar — regex `[\s\S]*?\n}`
   akan berhenti di kurung tutup aturan PERTAMA di dalamnya, bukan di ujung
   media query-nya. */
function mediaBlock(query) {
  const start = cssC.indexOf(query);
  if (start < 0) return null;
  let i = cssC.indexOf('{', start), depth = 0;
  for (let j = i; j < cssC.length; j++) {
    if (cssC[j] === '{') depth++;
    else if (cssC[j] === '}') { depth--; if (depth === 0) return cssC.slice(i + 1, j); }
  }
  return null;
}

// ── 1. Blok menyesuaikan isi ──
const sec = rule('.st-section');
ok(sec && /max-width:\s*\d+px/.test(sec),
   'section punya max-width — form pendek tidak direntangkan selebar monitor');
const secMax = sec && parseInt((sec.match(/max-width:\s*(\d+)px/) || [])[1], 10);
ok(secMax && secMax >= 800 && secMax <= 1200,
   'max-width section wajar (dapat: ' + secMax + 'px) — cukup untuk tabel, tidak boros untuk form');

// Grid isi juga dibatasi, masing-masing sesuai kepadatan isinya.
['.acct-grid', '.sys-grid'].forEach(s => {
  const r = rule(s);
  ok(r && /max-width:\s*\d+px/.test(r), s + ' dibatasi lebarnya');
});
// Menu Tampilan isinya cuma 2 tombol tema — tak boleh selebar 1060px.
ok(/id="stSecDisplay"[\s\S]{0,400}?max-width:\s*520px/.test(htmlC),
   'menu Tampilan (isi paling sedikit) dibatasi paling sempit');

// Tabel harus tetap bisa digeser sendiri, kalau tidak pembatasan lebar
// justru memotong kolomnya.
const wrap = rule('.vm-table-wrap');
ok(wrap && /overflow-x:\s*auto/.test(wrap),
   'tabel menggeser sendiri di dalam blok (lebar dibatasi ≠ kolom terpotong)');

// ── 2. Animasi & transisi ──
const item = rule('.st-nav-item');
ok(item && /transition:/.test(item), 'menu punya transition');
ok(item && !/transition:\s*all/.test(item),
   'BUKAN `transition: all` — properti disebut satu per satu agar biayanya terlihat');
ok(!/transition:\s*all/.test(cssC), 'tidak ada `transition: all` tersisa di settings.css');

ok(rule('.st-nav-item:hover'), 'ada keadaan hover');
ok(rule('.st-nav-item:active') && /transform/.test(rule('.st-nav-item:active')),
   'ada umpan balik saat diklik (:active)');
ok(rule('.st-nav-item:hover i'), 'ikon ikut bergerak saat hover');
ok(rule('.st-nav-item:focus-visible'),
   'fokus keyboard terlihat — menu ini <button> dan bisa di-Tab');

const bar = rule('.st-nav-item.active::before');
ok(bar && /var\(--grad-accent\)/.test(bar),
   'penanda aktif memakai --grad-accent (bahasa visual sidebar utama, bukan penanda baru)');
ok(bar && /animation:\s*stBarV/.test(bar), 'penanda aktif beranimasi');

// Perpindahan antar sub-menu
ok(/\.st-section:not\(\.hidden\)\s*\{[^}]*animation:\s*stSecIn/.test(cssC),
   'perpindahan antar sub-menu beranimasi');
ok(/_stNavInit/.test(jsC) && /classList\.add\('hidden'\)/.test(jsC),
   'perpindahan section memakai kelas .hidden (display none→block memulai ulang animasi CSS)');

// PERFORMA: hanya transform/opacity.
['stSecIn', 'stBarV', 'stBarH'].forEach(name => {
  const m = cssC.match(new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\}'));
  ok(!!m, '@keyframes ' + name + ' ada');
  if (!m) return;
  const props = (m[1].match(/[a-z-]+\s*:/g) || []).map(s => s.replace(/[\s:]/g, ''));
  const bad = props.filter(p => !['transform', 'opacity'].includes(p));
  ok(bad.length === 0,
     '@keyframes ' + name + ' hanya transform/opacity; melanggar: ' + JSON.stringify(bad));
});

/* stBarV/stBarH sengaja TIDAK memakai ulang barGrow milik sidebar utama.
   barGrow menganimasikan `height: 0 → 62%`; di mode mendatar (≤960px) tinggi
   barnya 2px, sehingga barGrow memekarkannya ke ~62% tinggi tombol lalu
   menyusut mendadak — cacat yang terlihat. */
ok(/@keyframes\s+barGrow[\s\S]*?height/.test(baseC),
   'barGrow (sidebar utama) memang menganimasikan height — dasar keputusan di bawah');
ok(!/animation:\s*barGrow/.test(cssC),
   'st-nav TIDAK memakai ulang barGrow (height-based → cacat di mode mendatar)');

// @keyframes di dalam @media hanya terdaftar selagi query cocok — pelajaran
// yang sudah pernah didapat di proyek ini (lihat --bx di devices.css).
['stSecIn', 'stBarV', 'stBarH'].forEach(name => {
  const at = cssC.indexOf('@keyframes ' + name);
  const mediaStarts = [...cssC.matchAll(/@media[^{]*\{/g)].map(m => m.index);
  const insideMedia = mediaStarts.some(start => {
    let depth = 0;
    for (let j = cssC.indexOf('{', start); j < cssC.length; j++) {
      if (cssC[j] === '{') depth++;
      else if (cssC[j] === '}') { depth--; if (depth === 0) return at > start && at < j; }
    }
    return false;
  });
  ok(!insideMedia, '@keyframes ' + name + ' didefinisikan di tingkat atas, BUKAN di dalam @media');
});

ok(!/backdrop-filter/.test(cssC), 'tanpa backdrop-filter (pemicu crash GPU Chrome/Windows)');

// ── 3. Hierarki kategori ──
/* Ambil lewat exec + capture group, bukan match(/g) + replace: match dengan
   flag /g membuang capture group-nya, dan `.replace(/.*>/,'')` yang menyusul
   menyisakan '<' di ujung ('AKUN<') sehingga perbandingannya selalu meleset. */
const groups = [];
{
  const re = /<div class="st-nav-group">([^<]*)</g;
  let m;
  while ((m = re.exec(htmlC)) !== null) groups.push(m[1].trim());
}
ok(groups.length >= 4, 'ada label kategori: ' + JSON.stringify(groups));
['AKUN', 'SISTEM'].forEach(g => ok(groups.includes(g), 'kategori ' + g + ' ada'));

const grp = rule('.st-nav-group');
ok(grp && /text-transform:\s*uppercase/.test(grp) && /font-weight:\s*8\d\d/.test(grp),
   'label kategori dibedakan jelas dari item menu (kapital + tebal)');
ok(rule('.st-nav-group::after'), 'label kategori punya garis pemisah');

// ── 4. Responsif ──
const m960 = mediaBlock('@media (max-width: 960px)');
ok(!!m960, 'ada breakpoint 960px');
if (m960) {
  ok(/flex-direction:\s*column/.test(m960), 'layout menumpuk di layar sempit');
  ok(/overflow-x:\s*auto/.test(m960), 'navigasi digeser mendatar, bukan membungkus');
  ok(/flex-wrap:\s*nowrap/.test(m960), 'navigasi satu baris');

  /* INI kriteria PRD yang paling mudah dilanggar: versi lama menulis
     `.st-nav-group { display: none }` di sini, sehingga di layar kecil tersisa
     8 tombol setara tanpa petunjuk kategori sama sekali. */
  const grpMobile = rules('.st-nav-group', m960).join(' ');
  ok(!/display:\s*none/.test(grpMobile),
     'label kategori TETAP TAMPIL di layar kecil (hierarki tidak hilang saat diringkas)');

  const barMobile = rules('.st-nav-item.active::before', m960).join(' ');
  ok(/bottom:/.test(barMobile),
     'penanda aktif pindah ke bawah saat menu mendatar (penanda kiri tak menunjuk apa pun)');
  ok(/animation-name:\s*stBarH/.test(barMobile),
     'animasi penanda ikut berputar arah (memekar mendatar, bukan tegak)');
}

const m560 = mediaBlock('@media (max-width: 560px)');
ok(!!m560, 'ada breakpoint 560px untuk ponsel');

// Grid isi ikut menumpuk di layar sempit — kalau tidak, kolom 320px berdesakan.
ok(/@media\s*\(max-width:\s*900px\)[\s\S]*?\.sys-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(cssC),
   'sys-grid menumpuk jadi 1 kolom di layar sempit');
ok(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.acct-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(cssC),
   'acct-grid menumpuk jadi 1 kolom di layar sempit');

// ── Konsistensi dengan sistem desain yang sudah ada ──
const tokens = ['--ease-spring', '--grad-accent', '--primary', '--border', '--text-muted'];
tokens.forEach(t => ok(cssC.includes(t), 'memakai token yang sudah ada: ' + t));
/* Warna: yang dilarang adalah MENCIPTAKAN bahasa baru, bukan memakai hex.

   Palet di bawah sudah lebih dulu ada di berkas ini dan di device-detail.css
   (.vcfg-probe-result, .vm-btn-del) untuk teks status sukses/gagal. Token
   --green/--red sengaja TIDAK dipakai di sana: #22c55e sebagai teks di atas
   --green-light kontrasnya terlalu rendah untuk dibaca. Jadi memakainya =
   konsisten dengan yang ada; menambah warna DI LUAR daftar ini = bahasa baru.

   Daftar ini sengaja eksplisit supaya tetap menggigit: #ff00ff tetap tertangkap. */
const PALET_ADA = [
  '#ef4444', '#16a34a', '#dc2626', '#4ade80', '#f87171',  // status sukses/gagal
  '#ffffff', '#fff',                                       // teks di atas --primary
  '#000',   // BUKAN warna: dipakai di mask-image cincin avatar, di mana hitam
            // berarti "tampilkan". Menggantinya dengan token warna justru salah.
];
const rawHex = [...new Set((cssC.match(/#[0-9a-fA-F]{3,6}\b/g) || [])
  .map(h => h.toLowerCase()))]
  .filter(h => !PALET_ADA.includes(h));
ok(rawHex.length === 0,
   'tidak ada warna baru di luar palet yang sudah ada: ' + JSON.stringify(rawHex));

// Kode BARU harus memakai token di mana token-nya memang ada.
['.st-nav-item', '.st-nav-group', '.st-section-hdr h3', '.acct-hero', '.sys-grid']
  .forEach(sel => {
    const r = rule(sel);
    if (!r) return;
    const hex = (r.match(/#[0-9a-fA-F]{3,6}\b/g) || []);
    ok(hex.length === 0, sel + ' memakai token, bukan hex mentah: ' + JSON.stringify(hex));
  });

console.log('stsetting: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
