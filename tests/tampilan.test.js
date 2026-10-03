#!/usr/bin/env node
/* Uji tampilan di BROWSER SUNGGUHAN (tanpa jendela) — halaman Detail ONU (2026-10-03).
 *
 * Uji lain di folder ini kebanyakan membaca kode sebagai teks; itu tak bisa memastikan
 * bahwa pop-up benar-benar terbuka, bahwa kartu tidak meluber di layar HP, atau bahwa
 * teks ber-HTML dari ONU tidak dijalankan browser. Uji ini menjalankan panel dengan
 * basis data SEMENTARA terhadap GenieACS TIRUAN (tools/potret.js), lalu memeriksa
 * halaman yang benar-benar digambar. Lihat tests/tampilan.skenario.js.
 *
 * Tidak ada yang menyentuh data/sky.db maupun GenieACS sungguhan.
 *
 * Butuh Edge/Chrome. Bila tak ada (mis. server tanpa browser), uji ini DILEWATI dengan
 * keterangan — bukan gagal. Setel SKY_BROWSER untuk menunjuk browser di lokasi lain.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let browser = null;
try { browser = require(path.join(ROOT, 'tools', 'potret.js')).cariBrowser(); } catch (_) { browser = null; }
if (!browser) {
  console.log('tampilan: dilewati — browser (Edge/Chrome) tidak ditemukan; setel SKY_BROWSER untuk menjalankannya');
  process.exit(0);
}

function jalankan() {
  const keluar = fs.mkdtempSync(path.join(os.tmpdir(), 'skytampilan-'));
  const p = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'potret.js'), path.join(__dirname, 'tampilan.skenario.js'),
    '--segar', '--xss', '--keluar', keluar,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  try { fs.rmSync(keluar, { recursive: true, force: true }); } catch (_) { /* biarkan */ }
  const baris = ((p.stdout || '') + (p.stderr || '')).trim().split(/\r?\n/).filter(Boolean);
  return { p, baris, ringkas: baris.filter(b => /^tampilan: /.test(b)).pop() };
}
/* Skenario yang BERHENTI sebelum mencetak ringkasan (2026-10-03: sekali terjadi saat
   seluruh uji dijalankan berurutan dan laptop sibuk — sebuah penantian habis waktu,
   lima kali diulang sendirian selalu lulus) diulang SEKALI: itu gangguan alat, bukan
   temuan. Pemeriksaan yang gagal (ada ringkasan "N gagal") TIDAK pernah diulang. */
let { p, baris, ringkas } = jalankan();
if (!ringkas) {
  baris.slice(-6).forEach(b => console.log('  (percobaan 1) ' + b));
  ({ p, baris, ringkas } = jalankan());
}
// Rincian kegagalan dulu, ringkasan sebagai baris TERAKHIR (dibaca jalankan_semua.py).
baris.filter(b => b !== ringkas).forEach(b => console.log(b));
if (p.error) console.log('  ✗ gagal menjalankan browser: ' + p.error.message);
console.log(ringkas || 'tampilan: 0 lulus, 1 gagal (skenario tidak selesai)');
process.exit(p.status === 0 && ringkas && / 0 gagal/.test(ringkas) ? 0 : 1);
