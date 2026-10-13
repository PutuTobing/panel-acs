#!/usr/bin/env node
/* Uji pemilih jumlah ONU per halaman di tabel Device (20/40/60/100) — 2026-10-13.
 *
 * Yang dijaga:
 *   - pilihannya tepat 20, 40, 60, 100, dan tombol yang menyala = jumlah baris yang tampil;
 *   - pilihan tersimpan di BROWSER (localStorage), tidak pernah dikirim ke server/GenieACS;
 *   - nilai liar (5000, teks, sisa versi lain) diabaikan — tabel raksasa membekukan browser;
 *   - mengganti jumlah baris tidak melempar orang ke halaman 1: baris teratas tetap tampil;
 *   - "Baris per Halaman" di Settings tetap bawaan bagi yang belum memilih, dan menyimpan
 *     Settings tidak menimpa pilihan orang (satu penentu: perHalamanAktif).
 *
 * devices.js ASLI dimuat dengan global browser tiruan (pola tests/bulk.test.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const baca = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let lulus = 0, gagal = 0;
function ok(c, m) { if (c) lulus++; else { gagal++; console.error('  ✗ ' + m); } }

const stub = `
  var PAGE_INIT = {}; var PAGE_ACTIONS = {}; var PALETTE = ['#000'];
  function escHtml(s){ return String(s == null ? '' : s); }
  function showToast(){} function showConfirm(){} function setBtnBusy(){}
  function exportStamp(){ return 'S'; } function downloadCSV(){} function navigateTo(){}
  function rxClass(){ return 'rx-good'; }
  function authFetch(){ _HIT.jaringan++; return Promise.resolve({}); }
  var CSS = { escape: (s) => s };
  var localStorage = _LS;
  var _els = _ELS;
  function _el(){ return { style:{}, classList:{ toggle(){}, add(){}, remove(){}, contains(){ return false; } },
                          setAttribute(){}, closest(){ return null; }, hidden:false,
                          querySelector(){ return null; }, querySelectorAll(){ return []; },
                          addEventListener(){}, appendChild(){}, remove(){},
                          textContent:'', innerHTML:'', dataset:{},
                          checked:false, indeterminate:false, disabled:false }; }
  var document = {
    getElementById: (id) => (_els[id] = _els[id] || _el()),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => _el(), body: { appendChild(){} },
  };
  var App = _APP; var ACS = _ACS;
`;

// Penyimpanan browser tiruan — bisa dibuat "diblokir" (mode privat) lewat ls.rusak.
const ls = {
  isi: {}, rusak: false, tulis: 0,
  getItem(k) { if (this.rusak) throw new Error('diblokir'); return k in this.isi ? this.isi[k] : null; },
  setItem(k, v) { if (this.rusak) throw new Error('diblokir'); this.tulis++; this.isi[k] = String(v); },
  removeItem(k) { if (this.rusak) throw new Error('diblokir'); this.tulis++; delete this.isi[k]; },
};
const hit = { jaringan: 0 };
let perPageSettings = 20;
const jejak = fn => (...a) => { hit.jaringan++; return fn ? fn(...a) : Promise.resolve(); };
const fakeACS = {
  rxThr: () => ({ good: -20, fair: -25 }),
  getConfig: () => ({ perPage: perPageSettings }),          // cache lokal — bukan jaringan
  loadAll: jejak(), summon: jejak(), rebootSmart: jejak(), deleteDevice: jejak(),
  getStats: () => ({ rx: {}, offline: 0 }),
};
const els = {};
const App = {};
const M = new Function('_APP', '_ACS', '_LS', '_ELS', '_HIT',
  stub + baca('frontend', 'js', 'devices.js') +
  '\n; return { PER_HALAMAN_OPSI, PER_HALAMAN_KUNCI, perHalamanAktif, renderPerHalaman, setDevicePerPage,'
  + ' initDeviceTable, goPage, renderDeviceTable, renderPagination };'
)(App, fakeACS, ls, els, hit);

const armada = n => Array.from({ length: n }, (_, i) => ({
  id: 'd' + (i + 1), serial: 'CONTOH' + String(i + 1).padStart(4, '0'), model: 'M', mfr: 'V',
  rx: '-15', online: true, pppoe: 'u' + i, ssid: 's', ip: '10.0.0.1', vlan: '', odp: '', tags: '',
  lastInform: 'baru saja', aktifDevice: 1,
}));
const baris  = () => (els.deviceTableBody.innerHTML.match(/<tr data-id=/g) || []).length;
const info   = () => els.tblInfo.textContent;
const tombol = () => (els.perHalaman.innerHTML.match(/data-n="(\d+)"/g) || []).map(s => +/\d+/.exec(s)[0]);
const nyala  = () => { const m = /page-btn pp-btn active" data-n="(\d+)"/.exec(els.perHalaman.innerHTML); return m ? +m[1] : null; };
const hal    = () => (els.pagination.innerHTML.match(/goPage\((\d+)\)">\d+</g) || []).map(s => +/\d+/.exec(s)[0]);
function mulai(n, settings, simpanan) {
  ls.isi = {}; ls.rusak = false; ls.tulis = 0; hit.jaringan = 0;
  if (simpanan !== undefined) ls.isi[M.PER_HALAMAN_KUNCI] = simpanan;
  perPageSettings = settings;
  App.devices = armada(n); App.rawDevices = []; App.tagPanel = null; App.pendingDeviceFilter = null;
  App.selectedDevices = new Set();
  M.initDeviceTable();
}

// ── 1. Bawaan: belum pernah memilih → Settings (20) ──
ok(JSON.stringify(M.PER_HALAMAN_OPSI) === '[20,40,60,100]', 'pilihan tepat 20, 40, 60, 100');
mulai(130, 20);
ok(App.devicePerPage === 20 && baris() === 20, 'belum memilih → 20 baris (bawaan Settings) — ' + baris());
ok(JSON.stringify(tombol()) === '[20,40,60,100]' && nyala() === 20, 'empat tombol, 20 menyala — ' + JSON.stringify(tombol()) + ' / ' + nyala());
ok(/^Showing 1–20 of 130 devices$/.test(info()), 'keterangan "Showing 1–20 of 130 devices" — ' + info());
ok(ls.tulis === 0, 'membuka halaman tidak menulis apa pun ke penyimpanan');

// ── 2. Memilih 40 / 60 / 100 ──
M.setDevicePerPage(40);
ok(App.devicePerPage === 40 && baris() === 40 && nyala() === 40, 'pilih 40 → 40 baris, tombol 40 menyala');
ok(/^Showing 1–40 of 130 devices$/.test(info()), 'keterangan ikut berubah — ' + info());
ok(Math.max.apply(null, hal()) === 4, 'jumlah halaman ikut dihitung ulang (130/40 → 4) — ' + JSON.stringify(hal()));
ok(ls.isi[M.PER_HALAMAN_KUNCI] === '40', 'pilihan tersimpan di browser');
M.setDevicePerPage(60);
ok(baris() === 60 && nyala() === 60 && Math.max.apply(null, hal()) === 3, 'pilih 60 → 60 baris, 3 halaman');
M.setDevicePerPage(100);
ok(baris() === 100 && nyala() === 100 && /1–100 of 130/.test(info()), 'pilih 100 → 100 baris — ' + info());
M.goPage(2);
ok(baris() === 30 && /101–130 of 130/.test(info()), 'halaman terakhir berisi sisanya (30) — ' + info());
ok(hit.jaringan === 0, 'mengganti jumlah baris TIDAK memanggil server/GenieACS sama sekali — ' + hit.jaringan);

// ── 3. Tetap di ONU yang sedang dilihat ──
mulai(130, 20);
M.goPage(3);                                   // baris 41–60
M.setDevicePerPage(40);
ok(App.devicePage === 2 && /^Showing 41–80 of/.test(info()), 'halaman 3 (20-an) → halaman 2 (40-an): baris 41 tetap tampil — ' + info());
M.setDevicePerPage(20);
ok(App.devicePage === 3 && /^Showing 41–60 of/.test(info()), 'kembali ke 20 → halaman 3 lagi — ' + info());
M.goPage(6);                                   // baris 101–120
M.setDevicePerPage(100);
ok(App.devicePage === 2 && /^Showing 101–130 of/.test(info()), 'halaman 6 (20-an) → halaman 2 (100-an) — ' + info());
M.setDevicePerPage(100);
ok(App.devicePage === 2, 'menekan tombol yang sudah menyala tidak memindahkan halaman');

// ── 4. Nilai liar ditolak ──
mulai(130, 20);
[5000, 0, -20, 21, 'banyak', null, undefined, '40; alert(1)'].forEach(v => {
  const sebelum = App.devicePerPage;
  M.setDevicePerPage(v);
  if (v === '40; alert(1)') ok(App.devicePerPage === 40, 'parseInt mengambil angka di depan saja ("40; …" → 40)');
  else ok(App.devicePerPage === sebelum && baris() === sebelum, 'nilai ' + JSON.stringify(v) + ' diabaikan');
});
['5000', '0', '-1', 'abc', '', '25', '1e9'].forEach(v => {
  mulai(130, 20, v);
  ok(App.devicePerPage === 20 && baris() === 20, 'simpanan liar ' + JSON.stringify(v) + ' di browser diabaikan → ikut Settings');
});
mulai(130, 20, '60');
ok(App.devicePerPage === 60 && nyala() === 60 && baris() === 60, 'simpanan sah (60) dipakai saat halaman dibuka lagi');

// ── 5. Bawaan Settings di luar empat pilihan (mis. 25) ──
mulai(130, 25);
ok(App.devicePerPage === 25 && baris() === 25, 'belum memilih + Settings 25 → 25 baris');
ok(JSON.stringify(tombol()) === '[20,25,40,60,100]' && nyala() === 25, 'bawaan 25 ikut jadi tombol dan menyala — ' + JSON.stringify(tombol()));
M.setDevicePerPage(60);
ok(nyala() === 60 && tombol().indexOf(25) !== -1, 'sesudah pilih 60, tombol 25 (bawaan) tetap ada untuk kembali');
M.setDevicePerPage(25);
ok(App.devicePerPage === 25 && !(M.PER_HALAMAN_KUNCI in ls.isi), 'menekan bawaan → simpanan dihapus, kembali ikut Settings');
M.setDevicePerPage(33);
ok(App.devicePerPage === 25, 'angka lain di luar pilihan dan bukan bawaan Settings ditolak');
mulai(130, 50, '40');
ok(App.devicePerPage === 40 && JSON.stringify(tombol()) === '[20,40,50,60,100]', 'pilihan orang (40) menang atas Settings (50); 50 tetap tampil sebagai bawaan');

// ── 6. Penyimpanan diblokir (mode privat) ──
mulai(130, 20);
ls.rusak = true;
let jatuh = null;
try { M.setDevicePerPage(60); } catch (e) { jatuh = e; }
ok(!jatuh && App.devicePerPage === 60 && baris() === 60, 'penyimpanan diblokir → pilihan tetap berlaku di halaman ini, tanpa galat');
ok(M.perHalamanAktif() === 20, 'penyimpanan diblokir → penentu jatuh ke Settings, tidak melempar galat');

// ── 7. Armada kecil / kosong ──
mulai(7, 20);
M.setDevicePerPage(100);
ok(baris() === 7 && App.devicePage === 1, '7 ONU dengan 100/halaman → 7 baris, halaman 1');
mulai(0, 20);
ls.isi = {};
let jatuh2 = null;
try { M.setDevicePerPage(40); } catch (e) { jatuh2 = e; }
ok(!jatuh2 && App.devicePage === 1, 'armada kosong → tidak galat, tetap halaman 1');

// ── 8. Pemeriksaan statis: HTML, Settings, tak ada jaringan di kode pemilih ──
const html = baca('frontend', 'pages', 'devices.html');
ok(/<div class="tbl-footer">[\s\S]*id="tblInfo"[\s\S]*id="perHalaman"[\s\S]*id="pagination"/.test(html),
   'devices.html: pemilih (#perHalaman) ada di kaki tabel, di samping keterangan jumlah');
const src = baca('frontend', 'js', 'devices.js');
const blok = src.slice(src.indexOf('const PER_HALAMAN_OPSI'), src.indexOf('// ─── Column Visibility'));
ok(blok.length > 500 && !/authFetch|fetch\(|ACS\.(?!getConfig)|XMLHttpRequest/.test(blok),
   'kode pemilih tidak memanggil server maupun NBI (hanya ACS.getConfig = cache lokal)');
const stg = baca('frontend', 'js', 'settings.js');
const apn = stg.slice(stg.indexOf('function applyParamsNow'), stg.indexOf('function applyParamsNow') + 1600);
ok(/perHalamanAktif\(\)/.test(apn) && !/App\.devicePerPage = parseInt\(cfg\.perPage/.test(apn),
   'settings.js applyParamsNow memakai penentu yang sama (perHalamanAktif), tidak menimpa pilihan orang');
ok(/id="cfgPerPage"[\s\S]{0,400}20\/40\/60\/100/.test(baca('frontend', 'pages', 'settings.html')),
   'Settings menjelaskan bahwa angkanya bawaan dan pilihan di tabel Device menang');
ok(/\.tbl-footer\s*\{[^}]*flex-wrap:\s*wrap/.test(baca('frontend', 'css', 'devices.css')),
   'kaki tabel boleh melipat di layar sempit (tidak mendorong halaman melebar)');

// Temuan tinjauan 2026-10-13 (CSS): urutan & kekhususan aturan.
const css = baca('frontend', 'css', 'devices.css');
ok(/\.page-btn\.active:hover:not\(:disabled\)\s*\{[^}]*color:\s*#fff/.test(css),
   'tombol yang menyala tetap berangka putih saat kursor di atasnya (bukan ungu di atas ungu)');
ok(/\.page-btn\.pp-btn\s*\{[^}]*min-width/.test(css) && !/^\.pp-btn\s*\{[^}]*min-width/m.test(css),
   'lebar tombol pemilih memakai .page-btn.pp-btn (aturan satu kelas kalah dari .page-btn di bawahnya)');
ok(/\.tbl-footer \.pagination\s*\{[^}]*margin-left:\s*auto/.test(css),
   'nomor halaman tetap menempel di kanan saat kaki tabel melipat');

console.log(`perhalaman: ${lulus} lulus, ${gagal} gagal`);
process.exit(gagal ? 1 : 0);
