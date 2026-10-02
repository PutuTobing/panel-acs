#!/usr/bin/env node
/* Uji pagar tipe nilai di ACS.setParam (js/api.js).
 *
 * Kenapa ini ada: 2026-07-17 panel menulis BandWidth = "[object Object]" ke
 * F670L ZTEGCF8AA37E. JSON.stringify dengan patuh mengubah objek jadi teks,
 * GenieACS menerimanya tanpa keluhan, ONU menolaknya, dan task itu MENGGANTUNG
 * di antrian — dicoba ulang tiap perangkat terhubung. Baru ketahuan 12 hari
 * kemudian saat mengaudit penyebab ONU ter-reset setelah mati lampu, karena
 * task tertunda dieksekusi PERSIS saat listrik pulih.
 *
 * Yang dijaga:
 *  1. Nilai non-primitif harus DITOLAK sebelum permintaan jaringan dibuat.
 *     Gagal di sini = diam: panel melapor sukses, ONU tak pernah berubah.
 *  2. Nilai sah (teks/angka/boolean, termasuk 0 dan string kosong) harus
 *     TETAP lolos. Pagar yang terlalu ketat memblokir pekerjaan nyata.
 *  3. setParam harus benar-benar MEMANGGIL pagarnya, sebelum apiFetch.
 *     Fungsinya boleh sempurna tapi tak berguna kalau tak dipanggil.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'api.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// ═══ Ambil fungsi pagar dari api.js dan jalankan ═══
function iris(kode, tanda) {
  const mulai = kode.indexOf(tanda);
  if (mulai < 0) return null;
  let dalam = 0, lihat = false;
  for (let i = mulai; i < kode.length; i++) {
    if (kode[i] === '{') { dalam++; lihat = true; }
    else if (kode[i] === '}') { dalam--; if (lihat && dalam === 0) return kode.slice(mulai, i + 1); }
  }
  return null;
}

const potongan = iris(src, 'function _cekTipeNilai');
ok(potongan !== null, 'fungsi _cekTipeNilai ditemukan di js/api.js');
if (!potongan) { console.log(`\n${pass} lulus, ${fail} gagal`); process.exit(1); }

const _cekTipeNilai = new Function(
  'return (' + potongan.replace(/^function _cekTipeNilai/, 'function') + ');')();
ok(typeof _cekTipeNilai === 'function', 'pagar berhasil diekstrak & dapat dipanggil');

// Penting: penolakan hanya sah kalau datang DARI pagar. Kalau ekstraksi gagal,
// pemanggilan melempar TypeError dan setiap uji "menolak" akan lulus palsu —
// persis jenis kegagalan diam yang tes ini dibuat untuk mencegah.
const tolak = (nilai, label) => {
  let kena = false, pesanE = '';
  try { _cekTipeNilai([['IGD.X.Y', nilai, 'xsd:string']]); }
  catch (e) { kena = true; pesanE = e.message; }
  ok(kena && !/is not a function/.test(pesanE), 'menolak ' + label);
};
const terima = (nilai, label) => {
  let lolos = true;
  try { _cekTipeNilai([['IGD.X.Y', nilai, 'xsd:string']]); } catch (e) { lolos = false; }
  ok(lolos, 'menerima ' + label);
};

// ═══ 1 · Nilai non-primitif ditolak ═══
tolak({},              'objek kosong {}');
tolak({ a: 1 },        'objek berisi (biang "[object Object]")');
tolak([1, 2],          'array');
tolak(null,            'null');
tolak(undefined,       'undefined');
tolak(NaN,             'NaN');
tolak(Infinity,        'Infinity');
tolak(function () {},  'fungsi');

// Bukti spesifik: nilai yang benar-benar merusak ONU 17 Juli.
let pesan = '';
try { _cekTipeNilai([['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BandWidth', {}, 'xsd:string']]); }
catch (e) { pesan = e.message; }
ok(/BandWidth/.test(pesan), 'pesan galat menyebut path yang bermasalah');
ok(/objek/.test(pesan),     'pesan galat menyebut JENIS nilai yang salah');
ok(!/\[object Object\]/.test(pesan), 'pesan galat tidak ikut merangkai objek jadi teks');

// ═══ 2 · Nilai sah tetap lolos (pagar tidak boleh kelewat ketat) ═══
terima('40MHz',  'teks biasa');
terima('',       'teks kosong (mis. hapus SSID password)');
terima(0,        'angka nol');
terima(-75,      'angka negatif');
terima(1.5,      'angka pecahan');
terima(true,     'boolean true');
terima(false,    'boolean false');

// ═══ 3 · Bentuk daftar yang cacat ditolak ═══
const tolakDaftar = (daftar, label) => {
  let kena = false;
  try { _cekTipeNilai(daftar); } catch (e) { kena = true; }
  ok(kena, 'menolak ' + label);
};
tolakDaftar([],                         'daftar kosong');
tolakDaftar(null,                       'daftar null');
tolakDaftar('bukan array',              'daftar bukan array');
tolakDaftar([['IGD.X.Y']],              'pasangan tanpa nilai');
tolakDaftar([[ '', 'v', 'xsd:string']], 'path kosong');
tolakDaftar([[null, 'v', 'xsd:string']],'path null');

// Satu nilai busuk di tengah daftar sah harus tetap membatalkan SEMUANYA —
// kalau tidak, sebagian perubahan terkirim dan ONU jadi setengah terkonfigurasi.
tolakDaftar([['A.B', 'ok', 'xsd:string'], ['C.D', {}, 'xsd:string']],
            'daftar yang hanya SATU elemennya busuk');

// ═══ 4 · setParam benar-benar memanggil pagarnya, SEBELUM kirim ═══
// Komentar HARUS dibuang dulu: tanpa ini, panggilan yang di-comment-out
// (`// _cekTipeNilai(paramList);`) tetap cocok dengan regex dan sabotase lolos.
const srcBersih = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const badan = iris(srcBersih, 'async function setParam');
ok(badan !== null, 'fungsi setParam ditemukan');
if (badan) {
  ok(/_cekTipeNilai\(paramList\)/.test(badan),
     'setParam MEMANGGIL _cekTipeNilai(paramList)');
  // Sejak 2026-08-02 setParam mengirim lewat postTask() (pembungkus yang menunggu
  // kepastian nasib task), bukan apiFetch langsung. Yang dijaga tetap sama:
  // validasi WAJIB terjadi sebelum panggilan pengirim mana pun.
  const posCek = badan.indexOf('_cekTipeNilai(paramList)');
  const kandidat = ['postTask(', 'apiFetchStatus(', 'apiFetch(']
    .map(function(n) { return badan.indexOf(n); })
    .filter(function(p) { return p >= 0; });
  const posKirim = kandidat.length ? Math.min.apply(null, kandidat) : -1;
  ok(posCek >= 0 && posKirim >= 0 && posCek < posKirim,
     'pagar dipanggil SEBELUM pengiriman (bukan sesudah permintaan terlanjur dikirim)');

  // postTask HARUS satu-satunya jalan keluar setParam — kalau suatu saat ada yang
  // menambahkan fetch langsung di sini, pagar tipe bisa terlewati.
  ok(!/fetch\(/.test(badan),
     'setParam tidak memanggil fetch() langsung (harus lewat postTask)');
}

// Pagar lama untuk enum tidak boleh ikut terhapus.
ok(/_validateEnumParams/.test(src) || fs.existsSync(path.join(ROOT, 'tests', 'enumguard.test.js')),
   'pagar enum yang sudah ada tetap utuh');

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
