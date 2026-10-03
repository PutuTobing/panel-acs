#!/usr/bin/env node
/* Uji alur INSTALASI PERTAMA di browser sungguhan (2026-10-03).
 *
 * Basis data akun tidak ikut repositori: panel yang baru dipasang di server baru memang
 * mulai tanpa satu akun pun, dan orang pertama yang membukanya harus bisa membuat
 * administrator lewat layar instalasi. Uji ini menjalankan panel dengan basis data
 * SEMENTARA yang kosong (tools/potret.js --kosong) dan menempuh alur itu dari awal.
 * Lihat tests/instalasi.skenario.js.
 *
 * Tidak ada yang menyentuh data/sky.db maupun GenieACS sungguhan. Butuh Edge/Chrome;
 * bila tak ada, uji DILEWATI dengan keterangan — bukan gagal.
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
  console.log('instalasi: dilewati — browser (Edge/Chrome) tidak ditemukan; setel SKY_BROWSER untuk menjalankannya');
  process.exit(0);
}

const keluar = fs.mkdtempSync(path.join(os.tmpdir(), 'skyinstal-'));
const p = spawnSync(process.execPath, [
  path.join(ROOT, 'tools', 'potret.js'), path.join(__dirname, 'instalasi.skenario.js'), '--kosong', '--keluar', keluar,
], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
try { fs.rmSync(keluar, { recursive: true, force: true }); } catch (_) { /* biarkan */ }

const baris = ((p.stdout || '') + (p.stderr || '')).trim().split(/\r?\n/).filter(Boolean);
const ringkas = baris.filter(b => /^instalasi: /.test(b)).pop();
baris.filter(b => b !== ringkas).forEach(b => console.log(b));
if (p.error) console.log('  ✗ gagal menjalankan browser: ' + p.error.message);
console.log(ringkas || 'instalasi: 0 lulus, 1 gagal (skenario tidak selesai)');
process.exit(p.status === 0 && ringkas && / 0 gagal/.test(ringkas) ? 0 : 1);
