// Uji pemetaan foto ONT (Manufacturer + Product Class → berkas gambar).
//
// Yang dijaga:
//  1. Setiap berkas yang dirujuk ONT_PHOTO_RULES benar-benar ADA di
//     pages/gambar/ — aturan yang menunjuk berkas tak ada = ikon fallback
//     diam-diam, tanpa error apa pun.
//  2. Pencocokan TIDAK peduli huruf besar-kecil. Fleet nyata melaporkan
//     'F663NV3a' (145 unit) DAN 'F663NV3A' (82 unit) untuk model yang sama;
//     server Linux case-sensitive, jadi pencocokan mentah akan meleset.
//  3. INTI perubahan ini: model 'GM220-S' dipakai DUA vendor (CIOT & ZICG)
//     dengan gambar BERBEDA. Resolusi wajib melihat Manufacturer, bukan model
//     saja — kalau tidak, ZICG akan tampil memakai gambar CIOT (atau sebaliknya).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'frontend', 'js', 'devices.js'), 'utf8');

const stub = `
  var PAGE_INIT = {}; var PAGE_ACTIONS = {}; var PALETTE = ['#000'];
  function escHtml(s){ return String(s == null ? '' : s); }
  var App = {}; var ACS = { rxThr: () => ({good:-20, fair:-25}) };
  var document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
`;
const { ONT_PHOTOS, ONT_PHOTO_RULES, ontPhotoUrl } = new Function(
  stub + src + '\n; return { ONT_PHOTOS: ONT_PHOTOS, ONT_PHOTO_RULES: ONT_PHOTO_RULES, ontPhotoUrl: ontPhotoUrl };')();

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

const dir = path.join(root, 'frontend', 'pages', 'gambar');
const onDisk = fs.readdirSync(dir);
const G = f => '/pages/gambar/' + encodeURIComponent(f);

// ── 1. Setiap berkas yang dirujuk aturan benar-benar ada di disk ──
ok(ONT_PHOTO_RULES.length > 0, 'ONT_PHOTO_RULES tidak kosong');
ok(ONT_PHOTOS.length > 0, 'ONT_PHOTOS (daftar berkas unik) tidak kosong');
ONT_PHOTOS.forEach(f => {
  ok(onDisk.includes(f), `berkas "${f}" ada di pages/gambar/`);
});
// Tiap aturan wajib menyebut mfr atau model — aturan tanpa syarat akan menyambar
// semua ONU (termasuk yang seharusnya ikon fallback).
ONT_PHOTO_RULES.forEach((r, i) => {
  ok(!!(r.mfr || r.model), `aturan #${i} punya syarat (mfr atau model), bukan joker`);
  ok(!!r.file, `aturan #${i} menyebut berkas`);
});

// ── 2. Pemetaan sesuai permintaan (mfr, model) → gambar, dari data fleet NYATA ──
const cases = [
  // [manufacturer, productClass, berkas yang diharapkan]
  ['CIOT', 'GM220-S',      'GM220-S.png'],      // CIOT → GM220-S.png
  ['CIOT', 'MQ220',        'GM220-S.png'],      // CIOT vendor-level (MQ220 ikut)
  ['ETCH', 'F9V',          'F9V.png'],
  ['FOTC', 'F9V',          'F9V.png'],
  ['Huawei Technologies Co., Ltd', 'HG8245A', 'HG8245A.png'],
  ['HWTC', 'ZL-2113X',     'ZL-2113X.png'],
  ['TRKG', 'Trikom F609',  'Trikom F609.png'],
  ['ZICG', 'GM220-S',      'Trikom F609.png'],  // ZICG GM220-S → Trikom F609 (BUKAN GM220-S.png!)
  ['ZICG', 'F650',         'Trikom F609.png'],
  ['ZTEG', 'F663NV3A',     'F663NV3A.png'],
  ['ZTE',  'F663NV3A',     'F663NV3A.png'],
  ['ZTE',  'F663NV3a',     'F663NV3A.png'],     // ejaan huruf kecil tetap cocok
  ['ZTE',  'F663NV9',      'F663NV9.PNG'],
  ['ZTE',  'F670L',        'F670L.png'],
  ['ZTE',  'F679L',        'F670L.png'],
  ['CDTC', 'FD512XW-R460', 'FD512XW-R460.png'], // C-DATA (existing) tetap jalan
  ['CDTC', 'FD514GD-R460', 'FD514GD-R460.png'],
];
cases.forEach(([mfr, model, file]) => {
  ok(ontPhotoUrl(model, mfr) === G(file),
     `${mfr} ${model} → ${file}`);
});

// ── 3. INTI: model sama, vendor beda → gambar beda ──
ok(ontPhotoUrl('GM220-S', 'CIOT') !== ontPhotoUrl('GM220-S', 'ZICG'),
   'GM220-S: CIOT dan ZICG menghasilkan gambar BERBEDA (pembeda vendor bekerja)');
ok(ontPhotoUrl('GM220-S', 'CIOT') === G('GM220-S.png'), 'GM220-S CIOT = GM220-S.png');
ok(ontPhotoUrl('GM220-S', 'ZICG') === G('Trikom F609.png'), 'GM220-S ZICG = Trikom F609.png');

// ── 4. Tidak peduli kapital & spasi berlebih ──
ok(ontPhotoUrl('f663nv9', 'zte') === G('F663NV9.PNG'), 'huruf kecil tetap cocok');
ok(ontPhotoUrl('  F663NV9  ', ' ZTE ') === G('F663NV9.PNG'), 'spasi berlebih diabaikan');
ok(ontPhotoUrl('zl-2113x', 'hwtc') === G('ZL-2113X.png'), 'HWTC huruf kecil tetap cocok');

// ── 5. Model tanpa foto → null (ikon fallback), bukan URL ngawur ──
// Nilai NYATA di fleet yang memang tak diminta punya foto.
[['ZTE', 'F609'], ['ZTE', 'F463N'], ['CMDC', 'H1S-3'], ['HWTC', 'ZL-4224X'],
 ['ZTE', 'F663NV3a-XPON'], ['', ''], ['—', '—'], [null, null], [undefined, undefined]]
  .forEach(([model, mfr]) =>
    ok(ontPhotoUrl(model, mfr) === null,
       `tanpa foto → null (${JSON.stringify(mfr)} ${JSON.stringify(model)})`));

// ── 6. Nama berkas ter-encode aman untuk URL (spasi di 'Trikom F609.png') ──
ok(!/ /.test(ontPhotoUrl('Trikom F609', 'TRKG')), "URL 'Trikom F609' tak memuat spasi mentah");
ok(/%20/.test(ontPhotoUrl('Trikom F609', 'TRKG')), 'spasi di nama berkas di-encode jadi %20');

// ── 7. Laporan cakupan terhadap fleet NYATA (mfr, model, jumlah) ──
// Angka dari NBI produksi saat fitur dibuat — konteks, bukan asersi.
const fleet = [
  ['ZTE', 'F663NV9', 1160], ['HWTC', 'ZL-2113X', 203], ['ZTE', 'F663NV3a', 145],
  ['ZTE', 'F663NV3A', 82], ['ZTEG', 'F663NV3A', 34], ['ZICG', 'F650', 23],
  ['CIOT', 'GM220-S', 21], ['ZICG', 'GM220-S', 17], ['ETCH', 'F9V', 11],
  ['ZTE', 'F679L', 10], ['TRKG', 'Trikom F609', 7], ['ZTE', 'F463N', 6],
  ['FOTC', 'F9V', 6], ['CIOT', 'MQ220', 4], ['CDTC', 'FD512XW-R460', 4],
  ['ZTE', 'F609', 3], ['CDTC', 'FD514GD-R460', 1], ['CMDC', 'H1S-3', 1],
  ['Huawei Technologies Co., Ltd', 'HG8245A', 1], ['ZTE', 'F670L', 1],
  ['ZTE', 'F663NV3a-XPON', 1], ['HWTC', 'ZL-4224X', 1],
];
const total   = fleet.reduce((s, [, , n]) => s + n, 0);
const covered = fleet.filter(([mfr, m]) => ontPhotoUrl(m, mfr)).reduce((s, [, , n]) => s + n, 0);
const pct = (covered / total * 100).toFixed(1);
console.log(`  cakupan foto: ${covered}/${total} ONU (${pct}%) punya foto model`);
fleet.filter(([mfr, m]) => !ontPhotoUrl(m, mfr))
  .forEach(([mfr, m, n]) => console.log(`    tanpa foto: ${mfr} ${m} (${n} unit)`));

console.log(`ontphoto: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
