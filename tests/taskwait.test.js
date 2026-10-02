#!/usr/bin/env node
/* Uji: panel HARUS menunggu kepastian nasib task, bukan menebak dari _lastInform.
 *
 * LATAR (produksi, 2026-08-02):
 * Semua task dikirim dengan `timeout=3000`. GenieACS menahan permintaan HTTP
 * hanya 3 detik lalu membalas 202 = "baru diantre" — BUKAN selesai. Panel
 * memperlakukan 202 sama dengan 200, lalu menyimpulkan hasilnya dari berubahnya
 * `_lastInform`. Dua kegagalan nyata muncul dari situ:
 *
 *   1. Penghapusan WAN pada ZTEG1B874818 BERHASIL (koneksi 1_INTERNET_R_VID_100
 *      benar-benar terhapus), tapi panel melaporkan "ONU tidak merespons".
 *   2. Create WAN bertahap (addObject WCD → tunggu indeks → addObject koneksi →
 *      set parameter) putus di langkah penantian. Langkah 1 sudah terlanjur
 *      jalan, sehingga tiap percobaan meninggalkan SATU WAN Device KOSONG.
 *      Terlihat langsung di perangkat itu: WCD.4, WCD.5, WCD.6 semuanya kosong.
 *
 * `_lastInform` memang bukan bukti: ia berubah pada SETIAP sesi — termasuk sesi
 * yang faultnya membatalkan pekerjaan — dan tidak berubah bila ONU menjalankan
 * task pada sesi yang panel keburu berhenti menunggu.
 *
 * Yang dijaga berkas ini: jalur tulis menunggu jawaban GenieACS yang sebenarnya,
 * tidak menumpuk perintah kembar, dan tetap READ-ONLY saat memeriksa status.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'frontend', 'js', f), 'utf8');
const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const apiC = stripJs(read('api.js'));
const ddC  = stripJs(read('device-detail.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// Potong badan sebuah fungsi (seimbang kurung kurawal) agar asersi tidak bocor
// ke fungsi tetangga.
function iris(src, tanda) {
  const i = src.indexOf(tanda);
  if (i < 0) return null;
  const buka = src.indexOf('{', i);
  if (buka < 0) return null;
  let n = 0;
  for (let j = buka; j < src.length; j++) {
    if (src[j] === '{') n++;
    else if (src[j] === '}') { n--; if (!n) return src.slice(buka, j + 1); }
  }
  return null;
}

// ── 1. Batas tunggu task ──
const m = apiC.match(/const\s+TASK_WAIT_MS\s*=\s*(\d+)/);
ok(!!m, 'api.js mendefinisikan TASK_WAIT_MS');
const nilai = m ? parseInt(m[1], 10) : 0;
// Harus melampaui jeda connection-request terlama yang terukur (HWTC ~60 dtk),
// jika tidak, ONU lambat kembali dilaporkan gagal padahal perintahnya jalan.
ok(nilai >= 90000, 'TASK_WAIT_MS >= 90000 ms (jeda CR HWTC ~60 dtk; dapat ' + nilai + ')');
ok(nilai <= 300000, 'TASK_WAIT_MS <= 300000 ms (jangan menggantung tanpa batas; dapat ' + nilai + ')');
ok(/return\s*\{[\s\S]*TASK_WAIT_MS[\s\S]*\}/.test(apiC), 'TASK_WAIT_MS diekspor dari ACS');

// ── 2. Tidak ada lagi timeout=3000 di jalur TULIS ──
['setParam', 'addObject', 'deleteObject'].forEach(function(fn) {
  const badan = iris(apiC, 'async function ' + fn);
  ok(badan !== null, fn + ' ditemukan');
  if (!badan) return;
  ok(!/timeout=3000/.test(badan), fn + ' tidak lagi memakai timeout=3000');
  ok(/postTask\(/.test(badan), fn + ' mengirim lewat postTask()');
});

// ── 3. postTask membedakan 200 (tuntas) dari 202 (mengantre) ──
const bPost = iris(apiC, 'async function postTask');
ok(bPost !== null, 'postTask ditemukan');
if (bPost) {
  ok(/apiFetchStatus\(/.test(bPost), 'postTask memakai apiFetchStatus (membuka kode status)');
  ok(/status\s*===\s*200/.test(bPost), 'postTask menandai selesai HANYA pada HTTP 200');
  ok(/TASK_WAIT_MS/.test(bPost), 'postTask memakai TASK_WAIT_MS sebagai timeout NBI');
}

// ── 4. Nasib task dibaca dari GenieACS, bukan ditebak ──
const bOut = iris(apiC, 'async function taskOutcome');
ok(bOut !== null, 'taskOutcome ditemukan');
if (bOut) {
  ok(/'task_'\s*\+\s*taskId|`task_\$\{taskId\}`/.test(bOut),
     'taskOutcome mencocokkan fault lewat kanal task_<id>');
  ok(/'selesai'/.test(bOut) && /'gagal'/.test(bOut) && /'menunggu'/.test(bOut),
     'taskOutcome membedakan selesai / gagal / menunggu');
  // Pemeriksaan status WAJIB read-only: tak boleh mengantre apa pun ke ONU.
  ok(!/method:\s*'POST'/.test(bOut) && !/connection_request/.test(bOut),
     'taskOutcome READ-ONLY (tidak mengirim task/connection-request ke ONU)');
}

// ── 5. Pemakaian di sisi panel ──
ok(/async function _tungguTask/.test(ddC), 'device-detail.js punya _tungguTask');
ok(/async function _adaTaskKembar/.test(ddC), 'device-detail.js punya _adaTaskKembar');

const bDel = iris(ddC, 'function _wanHandleDelete');
ok(bDel !== null, '_wanHandleDelete ditemukan');
if (bDel) {
  ok(/_tungguTask\(/.test(bDel), 'hapus WAN menunggu nasib task');
  ok(/_adaTaskKembar\(/.test(bDel), 'hapus WAN menolak perintah kembar');
  ok(!/pollForUpdate\(/.test(bDel), 'hapus WAN tidak lagi menebak dari _lastInform');
}

const bCreate = iris(ddC, 'async function _wanDoCreateNewWcd');
ok(bCreate !== null, '_wanDoCreateNewWcd ditemukan');
if (bCreate) {
  ok(/_adaTaskKembar\(/.test(bCreate), 'create WAN menolak bila addObject sudah mengantre');
  const jml = (bCreate.match(/_tungguTask\(/g) || []).length;
  ok(jml >= 2, 'create WAN menunggu kepastian di KEDUA langkah addObject (dapat ' + jml + ')');
  ok(/wcdYatim/.test(bCreate), 'create WAN mencatat WCD yang terlanjur dibuat');
  ok(/KOSONG/.test(bCreate), 'kegagalan create menyebut WAN kosong yang tertinggal');
}

// ── 6. Gerbang parameter menolak, bukan diam-diam lolos ──
const bGuard = iris(ddC, 'async function _setParamGuard');
ok(bGuard !== null, '_setParamGuard ditemukan & async');
if (bGuard) {
  ok(/_tungguTask\(/.test(bGuard), '_setParamGuard menunggu kepastian task');
  ok(/throw\s+err/.test(bGuard), '_setParamGuard melempar galat bila tidak berhasil');
  ok(/menunggu/.test(bGuard) && /ditolak/.test(bGuard),
     '_setParamGuard membedakan "ONU menolak" dari "belum dijalankan"');
}

// ── 6b. Dualstack: "belum sampai" ≠ "ditolak ONU" ──
// 2026-08-02, ZTEG1B874818: WAN baru keluar IPv4-only dan panel melaporkan
// "dualstack tak diterima ONU". Padahal ONU tak menolak apa pun — sesinya batal
// (fault too_many_commits) sehingga perintah IPMode tak pernah terkirim.
// Salah label ini membuat operator menyimpulkan firmware-nya tak ber-IPv6.
const bDual = iris(ddC, 'function _wanApplyDualStack');
ok(bDual !== null, '_wanApplyDualStack ditemukan');
if (bDual) {
  ok(/e\s*&&\s*e\.menunggu/.test(bDual),
     '_wanApplyDualStack memeriksa penanda menunggu pada galat');
  ok(/menunggu:\s*true/.test(bDual),
     '_wanApplyDualStack mengembalikan status menunggu (bukan dualOk:false)');
  // Kalau perintahnya cuma belum sampai, JANGAN klaim ONU menolak.
  const posMenunggu = bDual.indexOf('e.menunggu');
  const posFalse    = bDual.indexOf('dualOk: false');
  ok(posMenunggu >= 0 && posFalse >= 0 && posMenunggu < posFalse,
     'cabang menunggu diperiksa SEBELUM menyimpulkan ditolak');
}

// Pilihan IP Mode operator harus sampai ke jalur create X_CT-COM.
ok(/_wanDoCreateNewWcd\(d, newType, svc, vlanId, vlanMode, natVal, container, allConns, stEl, saveBtn, lanIface, ipMode\)/.test(ddC),
   'ipMode diteruskan ke _wanDoCreateNewWcd (dulu hilang diam-diam)');
if (bCreate) {
  ok(/mauIpv6/.test(bCreate), 'create menghormati pilihan IP Mode (mauIpv6)');
  ok(/ipMode === undefined/.test(bCreate),
     'pemanggil lama tanpa ipMode tetap berperilaku seperti semula');
  ok(/dualMenunggu/.test(bCreate),
     'create membedakan dualstack "belum sampai" dari "ditolak" saat melapor');
}

// ── 7. JARING PENGAMAN: tak ada reboot/factory-reset yang menyelinap ──
// Perubahan ini menyentuh setiap jalur tulis. Kalau suatu saat ada yang
// menyisipkan reboot ke dalamnya, ONU pelanggan bisa ter-restart massal.
[['postTask', bPost], ['taskOutcome', bOut], ['_tungguTask', iris(ddC, 'async function _tungguTask')],
 ['_adaTaskKembar', iris(ddC, 'async function _adaTaskKembar')], ['_setParamGuard', bGuard]]
  .forEach(function(p) {
    if (!p[1]) return;
    ok(!/factoryReset|"reboot"|'reboot'/.test(p[1]),
       p[0] + ' tidak mengirim reboot/factory-reset');
  });

console.log('taskwait: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
