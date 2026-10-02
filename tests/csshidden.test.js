// Penjaga regresi: elemen ber-atribut [hidden] HARUS benar-benar tersembunyi.
//
// Latar: `hidden` cuma gaya bawaan browser (display:none). Gaya author selalu
// mengalahkan gaya browser TANPA peduli specificity — jadi satu baris
// `.bulk-bar { display: flex }` diam-diam membuat elemen ber-[hidden] tetap
// tampil. Bug ini pernah lolos karena uji JS hanya memeriksa properti
// el.hidden (yang memang benar), bukan hasil render CSS-nya.
//
// Uji ini memeriksa kontraknya di level CSS: ada penjaga [hidden] global, ATAU
// setiap kelas yang memakai [hidden] tidak menyetel display sendiri.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'frontend');   // akar web (2026-10-03)
const readAll = (dir, ext) => fs.readdirSync(path.join(root, dir))
  .filter(f => f.endsWith(ext))
  .map(f => ({ name: dir + '/' + f, src: fs.readFileSync(path.join(root, dir, f), 'utf8') }));

const css  = readAll('css', '.css');
const html = readAll('pages', '.html').concat([{ name: 'index.html', src: fs.readFileSync(path.join(root, 'index.html'), 'utf8') }]);
const allCss = css.map(f => f.src).join('\n');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

// ── Penjaga global ada? ──
const guard = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(allCss);
ok(guard, 'ada penjaga global [hidden] { display: none !important } di CSS');

// ── Kumpulkan setiap elemen yang memakai atribut hidden di HTML ──
// Hanya atribut `hidden` berdiri sendiri — bukan class="... hidden".
const tags = [];
html.forEach(f => {
  const re = /<([a-z]+)\b([^>]*\bhidden\b[^>]*)>/gi;
  let m;
  while ((m = re.exec(f.src))) {
    const attrs = m[2];
    // Abaikan `class="hidden"` / id yang kebetulan mengandung kata hidden
    if (/class\s*=\s*"[^"]*\bhidden\b/.test(attrs)) continue;
    if (!/(^|\s)hidden(\s|=|$)/.test(attrs)) continue;
    const cls = (attrs.match(/class\s*=\s*"([^"]*)"/) || [, ''])[1].trim();
    const id  = (attrs.match(/id\s*=\s*"([^"]*)"/) || [, ''])[1];
    tags.push({ file: f.name, id, classes: cls ? cls.split(/\s+/) : [] });
  }
});

ok(tags.length > 0, 'menemukan elemen ber-[hidden] untuk diperiksa (' + tags.length + ')');

// ── Setiap elemen tsb harus benar-benar bisa tersembunyi ──
tags.forEach(t => {
  const risky = t.classes.filter(c => {
    // Apakah kelas ini menyetel display sendiri di suatu tempat?
    const re = new RegExp('\\.' + c.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&') + '\\s*\\{[^}]*display\\s*:', 'g');
    return re.test(allCss);
  });
  const label = (t.id || t.classes.join('.') || '?') + ' (' + t.file + ')';
  // Aman bila ada penjaga global, atau kelasnya memang tidak menyetel display.
  ok(guard || risky.length === 0,
     label + ' → kelas ' + risky.join(', ') + ' menyetel display sendiri sehingga [hidden] diabaikan');
});

console.log(`csshidden: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
