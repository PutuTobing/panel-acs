#!/usr/bin/env node
/* Uji aturan alur WAN: Service menentukan apa yang mungkin.
 *
 * Dua aturan, keduanya berdasar pengukuran SELURUH armada 2026-09-25.
 *
 * ATURAN 1 — dualstack hanya pada WAN INTERNET murni.
 *
 *     vendor   susunan            WAN   ber-IPMode dualstack
 *     HWTC     INTERNET saja       11        8
 *     HWTC     TR069+INTERNET      13        0
 *     ZTE      INTERNET saja      360      351
 *     ZTE      TR069+INTERNET     172        1
 *
 *   Dari 185 WAN gabungan, hanya 1 ber-dualstack. Sebabnya: WAN gabungan
 *   MEMBAWA sesi TR-069 itu sendiri, jadi mengubahnya ke dualstack memutus
 *   jalur manajemen di tengah perubahan dan ONU mengembalikannya. Terbukti
 *   langsung pada SN HWTCDF632AE8 — perintah diterima TANPA fault, tetapi
 *   IPMode tetap "1".
 *
 *   Ini penting dijaga karena gejalanya menipu: tidak ada galat, tidak ada
 *   fault, penyimpanan "berhasil" — hanya tidak terjadi apa-apa. Operator bisa
 *   menghabiskan berjam-jam mengira panelnya rusak.
 *
 * ATURAN 2 — TR069 tanpa INTERNET selalu IP/DHCP.
 *
 *     TR069 saja | IP/DHCP   687 WAN
 *     TR069 saja | PPPoE       0 WAN
 *
 *   Nol dari 687.
 *
 * Keduanya hanya membatasi PILIHAN di layar — tidak menambah satu pun
 * parameter yang dikirim ke ONU. Itu juga yang dijaga di sini.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ddJs = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'device-detail.js'), 'utf8');
const ddC  = ddJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

ok(/function _wanTerapkanAturanService\(/.test(ddC), 'fungsi aturan ada');

const b = ddC.slice(ddC.indexOf('function _wanTerapkanAturanService'),
                    ddC.indexOf('function _wanServiceStr'));

// ── Aturan 1 ──
ok(/var adaInt = !!\(intEl && intEl\.checked\)/.test(b), 'membaca centang INTERNET');
ok(/var adaTr\s+= !!\(trEl\s+&& trEl\.checked\)/.test(b), 'membaca centang TR069');
ok(/gabung = adaInt && adaTr/.test(b), 'gabungan = INTERNET DAN TR069 dicentang');
ok(/op\.value !== '1'/.test(b) && /op\.disabled = gabung/.test(b),
   'pada WAN gabungan, semua pilihan selain IPv4 dimatikan');
ok(/if \(gabung && ipSel\.value !== '1'\) ipSel\.value = '1'/.test(b),
   'pilihan dipaksa kembali ke IPv4 bila sedang gabungan');

// Keterangan wajib ada — pilihan yang mati tanpa penjelasan sama
// membingungkannya dengan penyimpanan yang diam-diam gagal.
ok(/wanIpModeNote/.test(b), 'ada tempat keterangan untuk menjelaskan sebabnya');
ok(/jalur\s+manajemen|manajemen/i.test(b), 'keterangan menyebut alasannya (jalur manajemen)');
ok(/pisahkan INTERNET/i.test(b), 'keterangan memberi jalan keluar, bukan hanya melarang');
ok(/wanIpModeNote/.test(ddC.slice(0, ddC.indexOf('function _wanTerapkanAturanService'))),
   'tempat keterangan benar-benar digambar di form');

// ── Aturan 2 ──
ok(/wajibIp = adaTr && !adaInt/.test(b), 'TR069 tanpa INTERNET → wajib IP/DHCP');
ok(/ctSel\.value = 'ip'/.test(b), 'tipe koneksi dipaksa ke IP/DHCP');
ok(/ctSel\.disabled = wajibIp/.test(b), 'pilihan tipe koneksi dikunci saat TR069-saja');
ok(/dispatchEvent\(new Event\('change'\)\)/.test(b),
   'perubahan dibunyikan agar bidang PPPoE/IP ikut berganti — bukan hanya nilainya');
ok(/ctSel\.title/.test(b), 'alasan penguncian terbaca saat disentuh');

// ── Terpasang di KEDUA form ──
// Kalau hanya salah satu, gejalanya muncul kembali di form yang terlewat —
// dan itu jenis bug yang paling lama terdeteksi.
const pemicu = (ddC.match(/_wanTerapkanAturanService\(\)/g) || []).length;
ok(pemicu >= 2, 'aturan diterapkan saat form digambar di kedua form (dapat ' + pemicu + ')');
const listener = (ddC.match(/addEventListener\('change', _wanTerapkanAturanService\)/g) || []).length;
ok(listener >= 2, 'checkbox Service memicu aturan di kedua form (dapat ' + listener + ')');

// ── Tidak menambah penulisan ke ONU ──
ok(!/_setParamGuard|_pushParam|tasks/.test(b),
   'aturan hanya membatasi pilihan di layar — tidak mengirim apa pun ke ONU');
ok(!/ACS\./.test(b), 'tidak memanggil API sama sekali');

console.log('wanservicerule: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
