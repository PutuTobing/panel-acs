// Uji ikon halaman di header (setPageIconPhoto).
//
// Perilaku yang dijaga:
//   • Halaman tanpa foto → ikon PAGE_META, bukan foto ONU yang tertinggal.
//   • Detail Perangkat → foto ONU, latar gradasi diganti (kelas has-photo).
//   • Gambar gagal muat → jatuh ke ikon, bukan kotak kosong.
//   • TOKEN GUARD: foto yang lambat termuat TIDAK boleh muncul setelah
//     pengguna berpindah halaman — inilah bug halus yang paling mungkin lolos
//     dari mata (header Dashboard tiba-tiba menampilkan foto ONU).
//
// Catatan: main.js utuh tak bisa dimuat di Node 12 (ada optional chaining di
// openModal), jadi potongan fungsinya diekstrak. Yang diuji fungsinya sendiri.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
const from = src.indexOf('let _pageIconToken');
const to   = src.indexOf('/* ─── Header centre: reflect the active page ─── */');
if (from < 0 || to < 0 || to <= from) {
  console.error('  ✗ tidak menemukan potongan setPageIconPhoto di main.js');
  process.exit(1);
}
const slice = src.slice(from, to);

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

function mkEl() {
  return {
    hidden: false, src: '', onload: null, onerror: null,
    _cls: new Set(),
    classList: {
      add(c)    { this._o._cls.add(c); },
      remove(c) { this._o._cls.delete(c); },
      has(c)    { return this._o._cls.has(c); },
    },
  };
}
function wire(el) { el.classList._o = el; return el; }

let els, setPageIconPhoto, probes;
function reset() {
  els = { hdrPageIconWrap: wire(mkEl()), hdrPageImg: wire(mkEl()), hdrPageIcon: wire(mkEl()) };
  probes = [];
  const document = { getElementById: (id) => els[id] || null };
  // Image() palsu: menangkap tiap pemuatan agar tes bisa memicu load/error
  // kapan pun — termasuk SETELAH pengguna berpindah halaman.
  function Image() { const p = { src: '', onload: null, onerror: null }; probes.push(p); return p; }
  setPageIconPhoto = new Function('document', 'Image',
    slice + '\n; return setPageIconPhoto;')(document, Image);
}
const hasPhoto = () => els.hdrPageIconWrap._cls.has('has-photo');
const lastProbe = () => probes[probes.length - 1];

// ── 1. Tanpa foto → ikon ──
reset();
setPageIconPhoto(null);
ok(els.hdrPageImg.hidden === true,  'url null → gambar disembunyikan');
ok(els.hdrPageIcon.hidden === false, 'url null → ikon tampil');
ok(!hasPhoto(), 'url null → kelas has-photo dilepas (gradasi kembali)');

// ── 2. Ada foto → gambar, HANYA setelah benar-benar termuat ──
reset();
setPageIconPhoto('/pages/gambar/F663NV9.PNG');
ok(lastProbe().src === '/pages/gambar/F663NV9.PNG', 'foto dimuat lewat probe');
ok(els.hdrPageImg.hidden === true,   'sebelum termuat → gambar tersembunyi (tak ada kedip kotak kosong)');
ok(els.hdrPageIcon.hidden === false, 'sebelum termuat → ikon yang tampil');
lastProbe().onload();
ok(els.hdrPageImg.src === '/pages/gambar/F663NV9.PNG', 'setelah termuat → src dipasang ke <img>');
ok(els.hdrPageImg.hidden === false, 'setelah termuat → gambar tampil');
ok(els.hdrPageIcon.hidden === true,  'setelah termuat → ikon disembunyikan');
ok(hasPhoto(), 'setelah termuat → has-photo dipasang (latar netral, bukan gradasi)');

// ── 3. Gambar gagal muat → kembali ke ikon, <img> tak pernah diisi ──
reset();
setPageIconPhoto('/pages/gambar/TIDAK-ADA.png');
lastProbe().onerror();
ok(els.hdrPageIcon.hidden === false, 'gagal muat → ikon tampil');
ok(els.hdrPageImg.hidden === true,   'gagal muat → gambar tetap tersembunyi');
ok(els.hdrPageImg.src === '',        'gagal muat → <img> tak pernah diisi src rusak');
ok(!hasPhoto(), 'gagal muat → has-photo tidak dipasang');

// ── 4. TOKEN GUARD: foto lambat tidak boleh muncul setelah pindah halaman ──
reset();
setPageIconPhoto('/pages/gambar/F663NV9.PNG');   // buka Detail Perangkat
const slow = lastProbe();                        // fotonya masih dimuat…
setPageIconPhoto(null);                          // …pengguna keburu ke Dashboard
ok(els.hdrPageIcon.hidden === false, 'pindah halaman → ikon tampil');
slow.onload();                                   // foto ONU baru selesai SEKARANG
ok(els.hdrPageImg.hidden === true,
   'foto ONU yang telat termuat TIDAK muncul di header halaman lain');
ok(!hasPhoto(), 'foto telat tidak memasang has-photo di halaman lain');

// ── 5. Ganti ONU cepat: hanya foto ONU terakhir yang menang ──
reset();
setPageIconPhoto('/pages/gambar/FD514GD-R460.png');
const probeA = lastProbe();                      // ONU A lambat
setPageIconPhoto('/pages/gambar/F663NV9.PNG');   // pengguna buka ONU B
const probeB = lastProbe();
probeB.onload();                                 // B termuat
probeA.onload();                                 // A telat menyusul
ok(els.hdrPageImg.src === '/pages/gambar/F663NV9.PNG',
   'foto tetap milik ONU terakhir (A yang telat tidak menimpa dengan model salah)');
ok(els.hdrPageImg.hidden === false, 'foto ONU terakhir tetap tampil');

// ── 6. Render ulang ONU yang sama → foto tetap muncul ──
// (Kalau <img>.src dipakai langsung, menyetel nilai yang sama belum tentu
//  memicu onload lagi → foto bisa hilang saat initDeviceDetail dijalankan ulang.)
reset();
setPageIconPhoto('/pages/gambar/F663NV9.PNG');
lastProbe().onload();
setPageIconPhoto('/pages/gambar/F663NV9.PNG');   // renderHero jalan lagi (fetch latar)
lastProbe().onload();
ok(els.hdrPageImg.hidden === false, 'render ulang ONU sama → foto tetap tampil');
ok(hasPhoto(), 'render ulang ONU sama → has-photo tetap terpasang');

console.log(`pageicon: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
