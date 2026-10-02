// Penjaga regresi halaman Detail Perangkat.
//
// Latar (bug nyata yang pernah ada):
//  1. `.dd-right-panel { display: none }` di bawah 1300px dan `.dd-left`
//     di bawah 1100px. Akibatnya di laptop 1280px Panel Aksi (Refresh/REBOOT)
//     dan Device Information LENYAP — ONU tak bisa direboot dari halaman ini.
//     Aturannya: layar sempit harus MELIPAT, bukan menghapus fungsi.
//  2. Foto ONU di topologi default-nya F663NV9.PNG, sehingga 544 ONU non-ZTE
//     (HWTC ZL-2113X, CIOT, Huawei, …) tampil sebagai ZTE. Sumber foto kini
//     satu: ontPhotoUrl() di devices.js.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css     = fs.readFileSync(path.join(root, 'frontend', 'css', 'device-detail.css'), 'utf8');
const jsRaw   = fs.readFileSync(path.join(root, 'frontend', 'js', 'device-detail.js'), 'utf8');
const htmlRaw = fs.readFileSync(path.join(root, 'frontend', 'pages', 'device-detail.html'), 'utf8');

// Komentar dibuang: yang diuji adalah KODE, bukan penjelasan di dalamnya.
// (Komentar di sini justru menyebut bug lama—termasuk nama berkas—sebagai
// dokumentasi, dan itu memang harus boleh.)
const js   = jsRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const html = htmlRaw.replace(/<!--[\s\S]*?-->/g, '');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

// Buang komentar agar penjelasan di dalamnya tidak ikut ter-match.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

// ── 1. Bagian fungsional tidak boleh disembunyikan di breakpoint mana pun ──
// Ini yang membuat Reboot/Device Information/daftar klien hilang di laptop & HP.
const MUST_STAY = ['.dd-right-panel', '.dd-left', '.dd-hero-metrics', '.dd-center'];
MUST_STAY.forEach(sel => {
  // Cari blok aturan untuk selektor ini, lalu periksa apakah ada display:none.
  const re = new RegExp('\\' + sel + '\\s*(,[^{]*)?\\{([^}]*)\\}', 'g');
  let m, hides = false;
  while ((m = re.exec(cssCode))) {
    if (/display\s*:\s*none/i.test(m[2])) hides = true;
  }
  ok(!hides, `${sel} tidak pernah display:none (fungsi harus melipat, bukan dihapus)`);
});

// ── 2. Layout memakai grid-template-areas agar bisa melipat ──
ok(/grid-template-areas/.test(cssCode), 'dd-body memakai grid-template-areas (bisa reflow)');
const areaBlocks = cssCode.match(/grid-template-areas\s*:[^;]+;/g) || [];
ok(areaBlocks.length >= 3, `ada layout untuk desktop/laptop/tablet (ditemukan ${areaBlocks.length})`);
['left', 'center', 'right'].forEach(a => {
  ok(new RegExp('grid-area:\\s*' + a).test(cssCode), `.dd-* punya grid-area: ${a}`);
});
// Setiap layout harus tetap memuat ketiga area — kalau ada yang hilang dari
// template, elemennya tidak ter-render meski tidak display:none.
areaBlocks.forEach((b, i) => {
  ['left', 'center', 'right'].forEach(a => {
    ok(b.includes(a), `layout #${i + 1} tetap memuat area "${a}"`);
  });
});

// ── 3. Foto ONU: satu sumber, tanpa default vendor yang menyesatkan ──
ok(!/_MODEL_IMG/.test(js), 'peta foto duplikat (_MODEL_IMG) sudah dihapus');
ok(/ontPhotoUrl/.test(js), 'memakai ontPhotoUrl() bersama dari devices.js');
// Tidak boleh ada foto model yang di-hardcode sebagai default/fallback.
ok(!/F663NV9\.PNG/.test(js), 'tidak ada default hardcode F663NV9 di JS');
ok(!/F663NV9\.PNG/.test(html), 'tidak ada foto ONU hardcode di HTML topologi');
ok(/ddTopoOnuFb/.test(html) && /ddTopoOnuFb/.test(js), 'ada ikon fallback untuk model tanpa foto');

// Gambar ODP boleh tetap hardcode — ia bukan per-model.
ok(/ODP BOX\.PNG/.test(html), 'gambar ODP tetap ada (bukan per-model, wajar hardcode)');

// ── 4. Panel Aksi ada di hero (bukan kolom yang bisa melipat ke bawah) ──
// Reboot memutus pelanggan; ia harus terjangkau tanpa scroll di layar mana pun.
const heroBlock = (html.match(/<div class="dd-hero-actions">[\s\S]*?<\/div>/) || [''])[0];
ok(/dd-hero-actions/.test(html), 'ada .dd-hero-actions di hero');
ok(/btnRebootDevice/.test(heroBlock), 'tombol Reboot berada di dalam hero actions');
ok(/btnRefreshDevice/.test(heroBlock), 'tombol Refresh berada di dalam hero actions');
ok(!/drp-card|drp-title|drp-group/.test(html + cssCode), 'sisa kartu Panel Aksi lama sudah bersih');

// ── 5. Label RX di topologi benar-benar berwarna ──
// rxSvClass() mengembalikan sv-green/sv-amber/sv-red, tetapi kelas itu semula
// HANYA didefinisikan untuk .gpon-stat-val — dipasang di elemen lain = tak berefek.
['sv-green', 'sv-amber', 'sv-red'].forEach(c => {
  ok(new RegExp('\\.dtc-line-lbl\\.' + c).test(cssCode),
     `.dtc-line-lbl.${c} punya aturan warna sendiri (kelas dari rxSvClass tak berefek tanpa ini)`);
});
ok(/ddTopoRx/.test(js) && /ddTopoRx/.test(html), 'label RX pada ruas ODP→ONU terpasang');
// Garis 2px meng-clip isinya; label butuh overflow visible.
ok(/\.dtc-line\s*\{[^}]*overflow:\s*visible/.test(cssCode),
   '.dtc-line overflow:visible agar label ruas tidak terpotong');

// ── 6. Salin teks harus jalan di http biasa (bukan hanya https/localhost) ──
// Panel dilayani lewat http://<IP-LAN>:8081 → navigator.clipboard UNDEFINED.
const mainJs = fs.readFileSync(path.join(root, 'frontend', 'js', 'main.js'), 'utf8');
ok(/function copyText/.test(mainJs), 'ada helper copyText bersama');
ok(/execCommand\(\s*['"]copy['"]\s*\)/.test(mainJs),
   'copyText punya jalur cadangan execCommand (navigator.clipboard tak ada di http biasa)');
ok(/isSecureContext/.test(mainJs), 'copyText memeriksa secure context sebelum pakai navigator.clipboard');
// Tak boleh ada yang memakai navigator.clipboard langsung: di http LAN ia
// undefined, dan tombolnya diam-diam mati (persis bug salin password SSID).
ok(!/navigator\.clipboard/.test(js),
   'device-detail.js tidak memakai navigator.clipboard langsung — semua lewat copyText()');

// ── 7. Tab WAN/SSID/Setting: segmented control + aksesibel ──
ok(/role="tablist"/.test(html), 'tab bar punya role="tablist"');
ok((html.match(/role="tab"/g) || []).length === 3, 'ketiga tab punya role="tab"');
ok((html.match(/role="tabpanel"/g) || []).length === 3, 'ketiga panel punya role="tabpanel"');
ok(/aria-selected/.test(js), 'showConfigTab menyinkronkan aria-selected');
// Panel yang di-tab harus benar-benar ada (aria-controls menunjuk id nyata).
(html.match(/aria-controls="(\w+)"/g) || []).forEach(m => {
  const id = m.match(/"(\w+)"/)[1];
  ok(new RegExp('id="' + id + '"').test(html), `aria-controls menunjuk id nyata: ${id}`);
});

console.log(`ddresponsive: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
