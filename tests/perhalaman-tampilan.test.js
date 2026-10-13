#!/usr/bin/env node
/* Uji browser pemilih jumlah ONU per halaman (20/40/60/100) di tabel Device — 2026-10-13.
 * Skenarionya: tests/perhalaman.skenario.js (dijalankan lewat tools/potret.js).
 *
 * Armadanya BUATAN: 130 salinan dokumen contoh tools/potret-contoh.js dengan nomor seri
 * "CONTOHPP0001…" — cukup banyak supaya 20/40/60/100 menghasilkan jumlah halaman berbeda.
 * Tidak ada dokumen ONU asli, tidak menyentuh data/sky.db maupun GenieACS sungguhan.
 * Butuh Edge/Chrome; bila tak ada, uji DILEWATI dengan keterangan — bukan gagal.
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
  console.log('perhalaman-tampilan: dilewati — browser (Edge/Chrome) tidak ditemukan; setel SKY_BROWSER untuk menjalankannya');
  process.exit(0);
}

// ── 130 perangkat buatan ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyperhal-'));
const data = path.join(tmp, 'data'), keluar = path.join(tmp, 'potret');
fs.mkdirSync(data); fs.mkdirSync(keluar);
const contoh = require(path.join(ROOT, 'tools', 'potret-contoh')).buat({})[0];
for (let i = 1; i <= 130; i++) {
  const d = JSON.parse(JSON.stringify(contoh));
  const sn = 'CONTOHPP' + String(i).padStart(4, '0');
  d._deviceId = Object.assign({}, d._deviceId, { _SerialNumber: sn });
  d._id = [d._deviceId._OUI, d._deviceId._ProductClass, sn].join('-');
  fs.writeFileSync(path.join(data, sn + '.json'), JSON.stringify(d));
}

function jalankan() {
  return spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'potret.js'), path.join(__dirname, 'perhalaman.skenario.js'), '--data', data, '--segar', '--keluar', keluar,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
}
let p = jalankan();
// Browser tanpa jendela sesekali macet saat mesin sibuk (lihat tests/tampilan.test.js) — satu kali ulang.
if (!/^perhalaman-tampilan: \d+ lulus/m.test((p.stdout || '') + (p.stderr || ''))) p = jalankan();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* biarkan */ }

const baris = ((p.stdout || '') + (p.stderr || '')).trim().split(/\r?\n/).filter(Boolean);
const ringkas = baris.filter(b => /^perhalaman-tampilan: /.test(b)).pop();
baris.filter(b => b !== ringkas && !/potret →|Perintah tulis yang dicatat/.test(b)).forEach(b => console.log(b));
if (p.error) console.log('  ✗ gagal menjalankan browser: ' + p.error.message);
console.log(ringkas || 'perhalaman-tampilan: 0 lulus, 1 gagal (skenario tidak selesai)');
process.exit(p.status === 0 && ringkas && / 0 gagal/.test(ringkas) ? 0 : 1);
