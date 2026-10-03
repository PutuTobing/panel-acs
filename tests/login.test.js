#!/usr/bin/env node
/* Uji halaman Login (PRD Modul 2).
 *
 * Kriteria penerimaan PRD 6.5 sebagian besar bisa diperiksa mesin, jadi
 * diperiksa mesin — bukan dengan "kelihatannya sudah benar".
 *
 * Yang dijaga di sini terutama hal-hal yang RUSAK DIAM-DIAM:
 *   • animasi menyentuh properti yang memicu layout/paint tiap frame
 *   • backdrop-filter menyelinap masuk (pemicu crash GPU Chrome/Windows yang
 *     sudah terdokumentasi di proyek ini)
 *   • kartu login jadi tembus pandang → kontras form ikut turun (langgar 6.3)
 *   • sisa elemen/kode peringatan HTTP yang katanya sudah dihapus
 *   • prefers-reduced-motion tidak dihormati
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Sejak 2026-10-03 layar login adalah halaman sendiri (/login) untuk semua role: markup di
// frontend/login/index.html, logika di frontend/login/login.js. Gayanya tetap di base.css.
const html = fs.readFileSync(path.join(ROOT, 'frontend', 'login', 'index.html'), 'utf8');
const css  = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'base.css'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'frontend', 'login', 'login.js'), 'utf8')
           + fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'main.js'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

/* Komentar dibuang sebelum diperiksa. Tanpa ini, komentar yang MENJELASKAN
   sebuah aturan (mis. "backdrop-filter dilarang") akan terbaca sebagai
   pelanggaran aturan itu — persis jenis positif-palsu yang pernah terjadi di
   suite lain proyek ini. */
const stripCss  = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripHtml = s => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs   = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const cssC  = stripCss(css);
const htmlC = stripHtml(html);
const mainC = stripJs(main);

/* Kumpulkan SEMUA blok untuk satu selektor, bukan yang pertama saja.
   CSS mengizinkan satu selektor punya banyak aturan terpisah — .login-brand
   misalnya punya blok tata letak DAN blok animasi di tempat berbeda. Mengambil
   yang pertama saja membuat tes melaporkan properti "hilang" padahal ada. */
function rule(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // (?![\w-]) supaya `.login-card` tidak ikut mencomot `.login-card::after`,
  // dan `.login-brand` tidak mencomot `.login-brand-txt`.
  const re = new RegExp('(?:^|[},])\\s*' + esc + '(?![\\w-])\\s*\\{([^}]*)\\}', 'g');
  const found = [];
  let m;
  while ((m = re.exec(cssC)) !== null) found.push(m[1]);
  return found.length ? found.join(' ; ') : null;
}

/* Hanya isi layar login. PRD Modul 2 cakupannya HALAMAN LOGIN saja — brand di
   sidebar aplikasi ada di luar cakupan dan sengaja tidak diubah. Tanpa
   pembatasan ini, tes akan menuduh "SKY ACS masih tersisa" padahal yang
   ditemukannya adalah brand sidebar yang memang tidak diminta berubah. */
function loginBlock() {
  const start = htmlC.indexOf('<div class="login-screen"');
  const end = htmlC.indexOf('<div class="app-layout"');
  return htmlC.slice(start, end > start ? end : undefined);
}
const LOGIN = loginBlock();

// ── 6.1 Perubahan konten ──
ok(/<span class="login-name">SKY TECH<\/span>/.test(LOGIN),
   'brand baris 1 = "SKY TECH"');
ok(/<span class="login-sub">PT Sky Base Technology Digital<\/span>/.test(LOGIN),
   'brand baris 2 = "PT Sky Base Technology Digital"');
ok(/<h1 class="login-title">PANEL ACS SKY TECH<\/h1>/.test(LOGIN),
   'login-title = "PANEL ACS SKY TECH"');
ok(!/SKY ACS<\/span>/.test(LOGIN), 'teks brand lama "SKY ACS" tidak tersisa di layar login');
ok(!/ONU OMCI Management<\/span>/.test(LOGIN),
   'sub-teks brand lama "ONU OMCI Management" tidak tersisa di layar login');

const desc = LOGIN.match(/<p class="login-desc">([^<]*)</);
ok(!!desc, 'login-desc ada');
if (desc) {
  const t = desc[1];
  ok(!/Gunakan akun/.test(t), 'sub-teks lama (instruksi login) sudah diganti');
  ok(/TR-069|OMCI/.test(t), 'sub-teks bernuansa manajemen sistem (menyebut TR-069/OMCI)');
  // PRD: "bukan lagi berupa instruksi/perintah login"
  ok(!/^(Masuk|Silakan|Gunakan|Login|Ketik|Isi)\b/i.test(t.trim()),
     'sub-teks bukan kalimat perintah/instruksi: %s'.replace('%s', t));
}

// ── 6.2 Peringatan HTTP dihapus SEPENUHNYA (elemen + logika) ──
ok(!/loginWarn/.test(html), 'elemen #loginWarn hilang dari HTML');
ok(!/login-warn/.test(LOGIN), 'komponen .login-warn hilang dari HTML');
ok(!/tidak terenkripsi/i.test(LOGIN), 'teks "tidak terenkripsi" hilang dari layar login');
ok(!/dapat disadap/i.test(LOGIN), 'teks "dapat disadap" hilang dari layar login');
ok(!/loginWarn/.test(mainC), 'logika #loginWarn hilang dari main.js (bukan cuma elemennya)');
ok(!/\.login-warn\s*\{/.test(cssC), 'aturan CSS .login-warn ikut dihapus (tak ada gaya yatim)');
// Spacing: .login-foot dulu diikuti .login-warn. Ia kini elemen terakhir, jadi
// tidak boleh ada margin-bottom yatim yang menyisakan ruang kosong.
const foot = rule('.login-foot');
ok(foot && !/margin-bottom/.test(foot),
   'tidak ada margin-bottom yatim di .login-foot setelah peringatan dihapus');

// ── 6.3 Animasi background ──
ok(/class="login-bg"/.test(LOGIN), 'login-bg masih ada');
ok(/lb-aurora/.test(LOGIN) && /lb-grid/.test(LOGIN), 'lapisan animasi latar terpasang di HTML');
ok(/aria-hidden="true"/.test(LOGIN.match(/<div class="login-bg"[^>]*>/)[0]),
   'latar dekoratif aria-hidden (tak dibacakan pembaca layar)');

const bg = rule('.login-bg');
ok(bg && /pointer-events:\s*none/.test(bg),
   'latar pointer-events:none — tak pernah menghalangi klik ke form');

// Animasi HARUS kontinu (PRD: "halus dan kontinu")
ok(/animation:\s*lbGrid\s+\d+s\s+linear\s+infinite/.test(cssC), 'grid beranimasi kontinu (infinite)');
const auroraAnims = cssC.match(/animation:\s*lbDrift\d\s+(\d+)s[^;]*infinite/g) || [];
ok(auroraAnims.length === 3, 'ketiga aurora beranimasi kontinu (dapat: %d)'.replace('%d', auroraAnims.length));

// Lambat = tidak mengganggu. Latar login yang berkedip menarik mata dari
// kolom password.
const durs = (cssC.match(/animation:\s*lb\w+\s+(\d+)s/g) || [])
  .map(s => parseInt(s.match(/(\d+)s/)[1], 10));
ok(durs.length >= 4, 'durasi animasi latar terbaca');
ok(durs.every(d => d >= 18), 'semua animasi latar lambat (≥18s/siklus): ' + JSON.stringify(durs));

// Durasi aurora tidak boleh berkelipatan — kalau iya, formasinya berulang
// dan polanya terasa mekanis.
const dr = [26, 32, 38];
ok(dr.every(d => cssC.includes(d + 's')), 'aurora memakai durasi 26/32/38s (tidak berkelipatan)');

// PERFORMA: hanya transform/opacity yang boleh dianimasikan.
const kfNames = ['lbGrid', 'lbDrift1', 'lbDrift2', 'lbDrift3', 'loginIn', 'loginRise', 'loginSheen'];
kfNames.forEach(name => {
  const m = cssC.match(new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\}'));
  ok(!!m, '@keyframes ' + name + ' ada');
  if (!m) return;
  const body = m[1];
  const props = (body.match(/^\s*[a-z-]+\s*:/gm) || [])
    .map(s => s.replace(/[\s:]/g, ''))
    .filter(p => p !== 'from' && p !== 'to');
  const allowed = ['transform', 'opacity'];
  const bad = props.filter(p => !allowed.includes(p));
  ok(bad.length === 0,
     '@keyframes ' + name + ' hanya menganimasikan transform/opacity (GPU); melanggar: ' + JSON.stringify(bad));
});

// Menganimasikan background-position pada gradien = repaint layar penuh tiap
// frame. Ini godaan paling jelas untuk efek "grid berjalan" — dilarang.
ok(!/@keyframes[\s\S]*?background-position/.test(cssC),
   'tidak ada @keyframes yang menganimasikan background-position (repaint tiap frame)');

// backdrop-filter = pemicu crash GPU Chrome/Windows yang sudah terdokumentasi.
// filter biasa pada elemen sendiri boleh — bebannya jauh lebih ringan.
ok(!/backdrop-filter/.test(cssC), 'tanpa backdrop-filter di mana pun (pemicu crash GPU)');

// KONTRAS (PRD 6.3: "tidak boleh mengurangi kontras/keterbacaan form")
const card = rule('.login-card');
ok(card && /background:\s*var\(--surface\)/.test(card),
   'kartu login OPAQUE — gerak di latar tak menyentuh kontras teks form');
ok(card && !/opacity/.test(card), 'kartu login tidak diberi opacity (teks tetap pekat)');

const screen = rule('.login-screen');
ok(screen && /overflow:\s*hidden/.test(screen),
   'aurora yang melampaui tepi tidak memunculkan scrollbar');

// ── 6.4 Animasi login-card ──
ok(card && /animation:\s*loginIn/.test(card), 'kartu punya animasi masuk');
const sheen = rule('.login-card::after');
ok(sheen && /pointer-events:\s*none/.test(sheen),
   'lapisan sheen pointer-events:none — tak menghalangi klik ke field');
ok(/animation:\s*loginSheen[^;]*\s1\s/.test(cssC),
   'sheen berjalan SEKALI (bukan infinite) — kilau berdenyut di sebelah kolom password mengganggu');

// PRD 6.4: "Efek tidak boleh menghambat kecepatan pengguna mengisi form."
// main.js memfokuskan #loginUser pada 60ms; jadi tak boleh ada penundaan
// animasi pada form yang melampaui itu secara berarti.
const delays = [];
['.login-brand', '.login-title', '.login-desc', '.login-form', '.login-foot'].forEach(sel => {
  const r = rule(sel);
  // (\d*\.?\d+) — BUKAN (\d+(\.\d+)?): CSS menulis `.34s`, tanpa angka di depan
  // titik. Pola yang mensyaratkan digit pertama diam-diam tidak cocok apa pun,
  // dan tesnya lalu melaporkan "animasi tidak terpasang" padahal terpasang.
  const m = r && r.match(/animation:\s*loginRise\s+(\d*\.?\d+)s\s+var\(--ease-spring\)\s+(\d*\.?\d+)s/);
  if (m) delays.push({ sel, dur: parseFloat(m[1]), delay: parseFloat(m[2]) });
});
ok(delays.length >= 4, 'animasi bertahap terpasang pada isi kartu');
const formAnim = delays.find(d => d.sel === '.login-form');
ok(formAnim && formAnim.delay <= 0.15,
   'form muncul cepat (delay ≤150ms) — operator yang langsung mengetik tidak menunggu');
ok(delays.every(d => d.dur + d.delay <= 0.6),
   'seluruh animasi kartu selesai <600ms: ' + JSON.stringify(delays.map(d => d.dur + d.delay)));
ok(/setTimeout\(\(\) => u\.focus\(\), 60\)/.test(mainC),
   'fokus otomatis ke username tetap ada (mengetik bisa langsung)');

// ── Aksesibilitas: reduced motion ──
const rm = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
ok(!!rm, 'ada blok @media prefers-reduced-motion');
if (rm) {
  ok(/animation-duration:\s*\.?0*\.?\d+ms\s*!important/.test(rm[1]),
     'reduced-motion memangkas durasi animasi ke ~0');
  ok(/animation-iteration-count:\s*1\s*!important/.test(rm[1]),
     'reduced-motion menghentikan animasi infinite (aurora & grid ikut berhenti)');
  // Sengaja BUKAN `animation: none`: animasi yang dibatalkan total tak pernah
  // menembakkan animationend, dan kode yang menunggunya akan menggantung.
  ok(!/animation:\s*none/.test(rm[1]),
     'reduced-motion memakai durasi ~0, bukan animation:none (animationend tetap menyala)');
  // transition sengaja TIDAK nol: transisi yang benar-benar 0 membuat
  // antarmuka terasa menyentak. .08s ada di bawah ambang gerak yang terasa.
  ok(/transition-duration:\s*\.08s\s*!important/.test(rm[1]),
     'reduced-motion menyisakan transisi .08s (bukan 0 yang menyentak)');
  // Hanya BOLEH ada satu penjaga global. Dua blok `*` !important dengan
  // spesifisitas sama = yang belakangan menang diam-diam.
  const guards = (css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*/g) || []);
  ok(guards.length === 1,
     'hanya satu penjaga reduced-motion global di base.css (dapat: ' + guards.length + ')');
}

// ── Satu halaman login untuk semua role ──
ok(!/id="loginScreen"|id="setupScreen"/.test(panel), 'layar login/instalasi tidak lagi tertanam di index.html panel');
ok(/location\.replace\(rumah\(user\)\)/.test(mainC) && /user\.role === 'pelanggan'\) return '\/pelanggan'/.test(mainC),
   'sesudah masuk: pelanggan ke /pelanggan, staf ke panel');
ok(main.includes('/^\\/(dashboard|devices|maps|settings|log)(\\/[A-Za-z0-9._~%-]*)*$/.test(lanjut)'),
   'tujuan sesudah login hanya jalur lokal panel (bukan alamat luar yang diselipkan lewat tautan)');
ok(!/panel|api\.js|device-detail/.test(html.match(/<script[^>]*>/g).join('')), 'halaman login tidak memuat kode panel');

// ── Daftar akun tetap mengarah ke btd.co.id ──
ok(/href="https:\/\/btd\.co\.id\/"/.test(LOGIN), 'tautan daftar mengarah ke https://btd.co.id/');
ok(/rel="noopener noreferrer"/.test(LOGIN),
   'tautan keluar memakai noopener (tab baru tak bisa menyetir tab panel)');

console.log('login: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
