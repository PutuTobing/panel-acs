#!/usr/bin/env node
/* Uji koreksi tipe X_*_IPMode (dualstack).
 *
 * LATAR — eksperimen terkontrol oleh operator, 2026-09-25, SN HWTC1006F0F0:
 *
 *     panel: IPv4-only → dualstack   → ONU GAGAL tersambung ke MikroTik
 *     panel: kembali ke IPv4-only    → tersambung lagi
 *     WEB ONU: IPv4-only → dualstack → BERHASIL tersambung
 *
 * Perangkat sama, tujuan sama. Jadi firmware-nya jelas sanggup dualstack, dan
 * yang salah adalah APA yang dikirim panel.
 *
 * SEBABNYA TIPE DATA. Yang dilaporkan ONU sendiri (armada 2026-09-25):
 *
 *     HWTC  X_CT-COM_IPMode   xsd:string        28 unit   nilai "1" / "3"
 *     HWTC  X_CT-COM_IPMode   xsd:unsignedInt    2 unit
 *     CDTC/ZICG/ZTEG  X_CT-COM_IPMode  xsd:unsignedInt
 *     ZTE   X_CMCC_IPMode     xsd:int          891 unit
 *     ZTE   X_ZTE-COM_IPMode  xsd:string        24 unit   'Both' / 'IPv4'
 *
 * Panel selalu mengirim xsd:unsignedInt. Untuk HWTC itu salah tipe — dan
 * akibatnya bukan sekadar parameter ditolak, WAN-nya ikut tidak mau naik.
 * Semua unit HWTC yang dualstack-nya jalan menyimpan "3" sebagai STRING.
 *
 * YANG DIJAGA BERKAS INI:
 *   1. Koreksi hanya untuk xsd:string. Tipe angka TIDAK diutak-atik — ZTE
 *      melaporkan xsd:int sementara panel mengirim xsd:unsignedInt, dan itu
 *      sudah berjalan pada 891 unit. Menyeragamkannya demi kerapian berarti
 *      mengusik jalur yang sehat.
 *   2. Nilainya ikut jadi string ("3", bukan 3) saat tipenya string.
 *   3. Probe-nya READ-ONLY — tidak boleh berubah jadi perintah ke ONU.
 *   4. Terpasang di KETIGA jalur yang menulis IPMode: edit, create, dualstack.
 *   5. Gagal probe → kembali ke perilaku lama, bukan membatalkan penyimpanan.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ddJs = fs.readFileSync(path.join(ROOT, 'js', 'device-detail.js'), 'utf8');
const ddC  = ddJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// ── 1. Fungsi koreksi ada dan berperilaku benar ──
ok(/function _koreksiIpMode\(/.test(ddC), '_koreksiIpMode ada');

const badan = ddC.slice(ddC.indexOf('function _koreksiIpMode'),
                        ddC.indexOf('function ', ddC.indexOf('function _koreksiIpMode') + 40));

ok(/ACS\.probeParam\(/.test(badan), 'memakai probeParam (READ-ONLY)');
ok(!/tasks|setParameterValues|connection_request/.test(badan),
   'koreksi tipe TIDAK mengirim perintah apa pun ke ONU');

// Inti aturannya: hanya string yang menimpa tebakan.
ok(/p\.type === 'xsd:string'/.test(badan),
   'hanya tipe xsd:string yang menimpa tebakan');
ok(!/xsd:int'/.test(badan) && !/xsd:unsignedInt'\s*\)/.test(badan),
   'tipe angka tidak ikut diubah (ZTE 891 unit tetap seperti semula)');

// Nilainya juga harus jadi string, bukan hanya tipenya.
ok(/String\(params\[idx\]\[1\]\)/.test(badan),
   'nilai ikut dijadikan string ("3", bukan 3)');

// Gagal probe tidak boleh menggagalkan penyimpanan.
ok(/\.catch\(function\(\)\s*\{\s*return params;/.test(badan),
   'gagal probe → kembali ke perilaku lama, penyimpanan tetap jalan');

// Parameter yang tak ada di daftar → jangan menyentuh apa pun.
ok(/if \(idx < 0\) return Promise\.resolve\(params\)/.test(badan),
   'daftar tanpa IPMode dikembalikan apa adanya');
ok(/if \(!namaIpMode\) return Promise\.resolve\(params\)/.test(badan),
   'profil tanpa params.ipMode dilewati tanpa probe');

// ── 2. Terpasang di KETIGA jalur penulis IPMode ──
// Kalau salah satu terlewat, gejalanya kembali persis seperti laporan
// operator — dan hanya pada sebagian aksi, yang jauh lebih sulit dilacak.
const pasang = (ddC.match(/_koreksiIpMode\(/g) || []).length;
ok(pasang >= 4, 'terpasang di semua jalur penulis IPMode (dapat ' + pasang + ' penyebutan)');

// Edit memakai rencana Port Binding (pb.params, 2026-09-29), Create memakai pbParams.
const POLA_KOREKSI = /_koreksiIpMode\(d, base, P\.ipMode, params\.concat\(pb\.?[Pp]arams\)\)/g;
ok(/_koreksiIpMode\(d, base, P\.ipMode, params\.concat\(pb\.params\)\)/.test(ddC),
   'jalur EDIT memakai koreksi');
ok(/_koreksiIpMode\(d, connBase, ds\.param,/.test(ddC),
   'jalur DUALSTACK (create) memakai koreksi');
ok((ddC.match(POLA_KOREKSI) || []).length >= 2,
   'jalur CREATE dan EDIT keduanya memakai koreksi');

// Koreksi harus terjadi SEBELUM dikirim.
const iKoreksi = ddC.indexOf('_koreksiIpMode(d, base, P.ipMode');
const iKirim   = ddC.indexOf('_setParamGuard(d, semua)');
ok(iKoreksi > 0 && iKirim > iKoreksi, 'koreksi dijalankan sebelum _setParamGuard');

// ── 3. Jalur penyusunan parameter lain tidak ikut berubah ──
// Perbaikan ini sengaja hanya menyentuh entri IPMode. Kalau suatu saat ada
// yang menjadikannya penulisan tambahan, uji ini gagal.
ok(!/_koreksiIpMode[\s\S]{0,200}_pushParam/.test(badan),
   'koreksi tidak menambah parameter baru, hanya mengubah entri yang ada');
ok(/params\[idx\] = \[jalur,/.test(badan),
   'entri lama DIGANTI di tempat, bukan ditambahkan');

console.log('ipmodetype: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
