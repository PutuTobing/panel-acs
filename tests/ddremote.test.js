#!/usr/bin/env node
/* Uji tombol Remote di hero Detail Perangkat.
 *
 * Yang dijaga di sini adalah dua hal yang rusak diam-diam:
 *
 *  1. window.open HARUS dipanggil langsung di dalam handler klik.
 *     Menyisipkan `await` apa pun di depannya memutus rantai gestur pengguna
 *     dan browser MEMBLOKIR tabnya sebagai popup — tombolnya lalu tampak
 *     "kadang tidak berfungsi", gejala yang sangat sulit dilacak.
 *
 *  2. Sisa-sisa modal Remote yang lama. Tab baru membuat modal + iframe +
 *     pengecekan status jadi kode mati; kode mati yang tampak hidup lebih
 *     berbahaya daripada tidak ada kodenya.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ddHtml = fs.readFileSync(path.join(ROOT, 'frontend', 'pages', 'device-detail.html'), 'utf8');
const ddJs   = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'device-detail.js'), 'utf8');
const ddCss  = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'device-detail.css'), 'utf8');
const devJs  = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'devices.js'), 'utf8');
const devCss = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'devices.css'), 'utf8');
const idx    = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const stripHtml = s => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs   = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripCss  = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

const ddHtmlC = stripHtml(ddHtml);
const ddJsC   = stripJs(ddJs);
const ddCssC  = stripCss(ddCss);
const devJsC  = stripJs(devJs);
const idxC    = stripHtml(idx);

// ── Tombol ada di hero, bersama Refresh & Reboot ──
const hero = (ddHtmlC.match(/<div class="dd-hero-actions">([\s\S]*?)<\/div>/) || [])[1] || '';
ok(!!hero, 'blok dd-hero-actions ditemukan');
ok(/id="btnRemoteDevice"/.test(hero), 'tombol Remote berada DI DALAM dd-hero-actions');
ok(/id="btnRefreshDevice"/.test(hero), 'Refresh tetap di hero');
ok(/id="btnRebootDevice"/.test(hero), 'Reboot tetap di hero');
ok(/class="drp-btn drp-remote"/.test(hero), 'Remote memakai gaya tombol hero yang sama (.drp-btn)');

// Urutan: aksi paling tidak berbahaya di kiri, Reboot (memutus pelanggan) di kanan.
const order = ['btnRemoteDevice', 'btnRefreshDevice', 'btnRebootDevice']
  .map(id => hero.indexOf(id));
ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
   'urutan tombol: Remote → Refresh → Reboot (Reboot paling kanan, paling berbahaya)');

// Penanda tab baru — tab yang muncul tiba-tiba tanpa isyarat itu mengagetkan.
ok(/drp-ext/.test(hero), 'ada ikon penanda "membuka tab baru"');
ok(/title="[^"]*tab baru[^"]*"/.test(hero), 'title tombol menyebut tab baru');

// ── Remote WAJIB pakai .onclick (menimpa), BUKAN addEventListener (menambah) ──
// initDeviceDetail() dipanggil ULANG tiap Refresh selesai, sedangkan tombol hero
// ada di HTML statis & tak dibangun ulang. addEventListener menumpuk satu listener
// tiap init → window.open ganda → DUA tab (bug yang dilaporkan). .onclick hanya
// menyimpan satu handler. Refresh & Reboot memakai pola sama.
ok(/btnRemote\.onclick\s*=/.test(ddJsC),
   'Remote di-bind lewat .onclick (idempoten) — tidak menumpuk listener saat re-init');
ok(!/btnRemote\.addEventListener\(/.test(ddJsC),
   'Remote TIDAK memakai addEventListener (mencegah 2 tab saat initDeviceDetail dipanggil ulang)');

// ── window.open dipanggil di dalam gestur klik, TANPA await di depannya ──
const handler = (ddJsC.match(
  /btnRemote\.onclick\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \};/) || [])[1];
ok(!!handler, 'handler klik Remote ditemukan');
if (handler) {
  ok(/window\.open\(/.test(handler), 'handler membuka tab baru lewat window.open');
  // Hanya BOLEH satu window.open — dua panggilan = dua tab dari satu klik.
  ok((handler.match(/window\.open\(/g) || []).length === 1,
     'tepat SATU window.open dalam handler (bukan dua)');
  ok(!/await/.test(handler),
     'TIDAK ada await sebelum window.open — await memutus gestur pengguna & tab diblokir popup blocker');
  ok(/'_blank'/.test(handler), 'dibuka di tab baru (_blank)');
  ok(/noopener/.test(handler),
     'memakai noopener — tanpa itu halaman ONU bisa menyetir tab panel lewat window.opener');
  // Alamatnya kini disusun _remoteUrl (halaman awal per model, 2026-10-03) — syaratnya sama.
  const iUrl = ddJs.indexOf('function _remoteUrl('), jUrl = ddJs.indexOf('\n}', iUrl);
  const urlFn = ddJs.slice(iUrl, jUrl);
  ok(/window\.open\(_remoteUrl\(d\)/.test(handler), 'handler memakai _remoteUrl(d)');
  ok(/encodeURIComponent\(d\.id\)/.test(urlFn), 'deviceId di-encode ke URL');
  ok(/return '\/onu\/' \+/.test(urlFn), 'menuju proxy panel /onu/, bukan IP ONU langsung');
  ok(!/https?:|172\.1[78]\./.test(urlFn), '_remoteUrl tak pernah menyusun alamat ber-host');
  // Browser luar TIDAK bisa menjangkau 10.17.x.x — kalau tautannya langsung
  // ke IP ONU, seluruh gunanya fitur ini hilang.
  ok(!/172\.1[78]\./.test(handler), 'tidak menautkan langsung ke IP internal ONU');
}

// Handler bukan fungsi async — async membuat await mudah menyelinap kembali.
ok(!/btnRemote\.onclick\s*=\s*async/.test(ddJsC),
   'handler Remote bukan async (menutup pintu masuknya await)');

// ── Gaya ──
ok(/\.drp-remote\s*\{/.test(ddCssC), 'ada gaya .drp-remote');
ok(/\.drp-remote[\s\S]{0,120}var\(--cyan\)/.test(ddCssC),
   'Remote memakai token --cyan yang sudah ada, bukan warna baru');
ok(/\.drp-ext\s*\{/.test(ddCssC), 'ada gaya ikon penanda tab baru');

// ── Sisa-sisa modal lama harus BERSIH ──
[['openRemoteOnu', devJsC], ['closeRemoteOnu', devJsC], ['_initRemote', devJsC],
 ['_rmDevice', devJsC], ['act-remote', devJsC]].forEach(([sym, src]) => {
  ok(!src.includes(sym), 'sisa modal lama dibuang dari devices.js: ' + sym);
});
ok(!/modalRemote/.test(idxC), 'modal #modalRemote dibuang dari index.html');
ok(!/rmFrame|rmChecking|rmBlocked/.test(idxC), 'elemen iframe/keadaan modal dibuang');
ok(!/modal-remote|\.rm-frame|\.rm-state/.test(stripCss(devCss)),
   'gaya modal Remote dibuang dari devices.css');

// Tombol Remote tidak boleh tertinggal di baris tabel.
const row = (devJsC.match(/<td class="col-actions">([\s\S]*?)<\/td>/) || [])[1] || '';
ok(!!row, 'blok kolom aksi tabel ditemukan');
ok(!/openRemoteOnu|act-remote/.test(row), 'tombol Remote tidak lagi di baris tabel');
['showDeviceDetail', 'refreshDeviceRow', 'rebootDeviceRow', 'deleteDeviceRow']
  .forEach(fn => ok(row.includes(fn), 'aksi tabel lain tetap utuh: ' + fn));

// ── Endpoint status kini tak terpakai dari klien mana pun ──
// Ia tetap hidup di server (berguna untuk diagnosa), tapi tidak boleh ada
// pemanggil yang menggantung di klien.
const allJs = ['main.js', 'devices.js', 'device-detail.js', 'settings.js', 'dashboard.js']
  .map(f => fs.readFileSync(path.join(ROOT, 'frontend', 'js', f), 'utf8')).join('\n');
ok(!/onu-status/.test(stripJs(allJs)),
   'tidak ada pemanggil /config/onu-status yang menggantung di klien');

console.log('ddremote: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
