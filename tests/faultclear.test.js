#!/usr/bin/env node
/* Uji tombol hapus fault (ACS.deleteFault + bagian Informasi Fault).
 *
 * LATAR. 2026-09-25: operator menyunting WAN pada SN HWTC10070328 dan Refresh
 * berikutnya tidak mempan. Sebabnya sebuah fault tersimpan di GenieACS:
 *
 *     channel  task_6ab68a754e027b27558520e9
 *     code     cwmp.9003  "Invalid arguments"
 *
 * Selama fault dari sebuah task masih ada, perintah berikutnya untuk ONU itu
 * ikut tertahan — jadi Refresh "tidak terjadi apa-apa" tanpa penjelasan, dan
 * satu-satunya cara membersihkannya adalah lewat basis data.
 *
 * YANG PALING PENTING DIJAGA DI SINI — perilaku GenieACS yang tidak terlihat
 * dari nama endpoint-nya. Dibaca langsung dari sumber genieacs-nbi 1.2.13:
 *
 *     let s = [hapusFault(id)];
 *     if (channel.startsWith("task_")) s.push(hapusTask(ObjectId(...)));
 *
 * Satu DELETE /faults/<id> menghapus fault DAN task penyebabnya. Itu memang
 * yang dibutuhkan (task yang gagal permanen akan gagal lagi selamanya), tetapi
 * berarti perintah yang mengantre DIBATALKAN. Kalau suatu saat peringatan itu
 * hilang dari layar, operator akan kehilangan perubahan tanpa tahu sebabnya —
 * dan itulah yang diuji di sini.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const apiJs = read('js/api.js');
const ddJs  = read('js/device-detail.js');
const cssS  = read('css/device-detail.css');
const apiC  = strip(apiJs);
const ddC   = strip(ddJs);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// ── 1. API ──
ok(/async function deleteFault\(/.test(apiC), 'ACS.deleteFault ada');
ok(/return\s*\{[\s\S]*deleteFault[\s\S]*\}/.test(apiC), 'deleteFault diekspor');

const badan = apiC.slice(apiC.indexOf('async function deleteFault'),
                         apiC.indexOf('async function pendingTasks'));
ok(/method: 'DELETE'/.test(badan), 'memakai metode DELETE');
ok(/\/faults\/'\s*\+\s*encodeURIComponent\(faultId\)/.test(badan),
   'id fault di-encode (mengandung ":" dan "%" dari _id GenieACS)');

// Handler GenieACS melempar SEBELUM header terkirim bila bagian task_<id>
// bukan ObjectId sah — jawabannya tidak pernah datang. Tanpa batas waktu,
// tombolnya berputar selamanya.
ok(/AbortController/.test(badan), 'ada batas waktu sendiri (AbortController)');
ok(/setTimeout\([\s\S]{0,40}abort\(\)/.test(badan), 'abort dipicu timer');
ok(/clearTimeout/.test(badan), 'timer dibersihkan (tidak bocor)');
ok(/AbortError/.test(badan), 'kasus menggantung dikenali');

// 503 "Device is in session" bukan kegagalan — hanya belum bisa.
ok(/503|in session/i.test(badan), 'kasus ONU sedang bersesi ditangani');
ok(/sedangSesi/.test(badan), 'penanda sedangSesi diberikan ke pemanggil');

// Menghapus fault TIDAK boleh berubah jadi mengirim perintah ke ONU.
ok(!/connection_request/.test(badan), 'tidak mengirim connection request');
ok(!/setParameterValues|refreshObject|reboot/.test(badan),
   'tidak mengirim perintah apa pun ke ONU');

// ── 2. Tombol muncul hanya untuk fault yang benar-benar bisa dihapus ──
// _buildFaultHtml berada SESUDAH _hapusFault di berkasnya, jadi potongannya
// diambil dari sana sampai akhir fungsi berikutnya.
const iBuild = ddC.indexOf('function _buildFaultHtml');
const bBuild = ddC.slice(iBuild, ddC.indexOf('function ', iBuild + 40));
ok(/f\.id\s*\n?\s*\?/.test(bBuild) || /f\.id\s*$/m.test(bBuild) || /\bf\.id\b/.test(bBuild),
   'tombol hapus digantungkan pada adanya f.id');
ok(/dct-fault-del/.test(bBuild), 'kelas tombol hapus per-fault ada');
ok(/data-fault="/.test(bBuild), 'id fault dibawa di atribut data');
ok(/btnHapusSemuaFault/.test(bBuild), 'ada tombol hapus semua');
ok(/bisaHapus\.length > 1/.test(bBuild),
   'tombol hapus semua hanya muncul bila fault ACS lebih dari satu');

// Fault turunan (offline/sinyal/suhu) tidak punya id → tidak boleh bertombol.
// Tombol yang tak melakukan apa-apa lebih buruk daripada tidak ada tombol.
const bUpdate = ddC.slice(ddC.indexOf('function _updateFaultSection'),
                          ddC.indexOf('function _pasangTombolFault'));
const turunan = bUpdate.slice(0, bUpdate.indexOf('ACS.getFaults'));
ok(!/\bid:/.test(turunan),
   'fault turunan (offline/sinyal/suhu) TIDAK diberi id → tidak bertombol');
ok(/id:\s*f\._id/.test(bUpdate), 'fault dari GenieACS memakai _id aslinya');
ok(/punyaTugas:\s*\/\^task_\/\.test\(ch\)/.test(bUpdate),
   'fault berkanal task_* ditandai punyaTugas');

// ── 3. Peringatan pembatalan task WAJIB ada ──
// Ini penjaga terpenting berkas ini. GenieACS ikut menghapus task-nya; kalau
// operator tidak diberi tahu, perubahan WAN yang belum terkirim hilang diam-diam.
const bHapus = ddC.slice(ddC.indexOf('function _hapusFault'),
                         ddC.indexOf('function _buildFaultHtml'));
ok(/showConfirm\(/.test(bHapus), 'menghapus fault selalu lewat konfirmasi');
ok(/adaTugas/.test(bHapus), 'konfirmasi membedakan fault yang membawa task');
ok(/ikut dibatalkan|ikut dihapus/i.test(bHapus),
   'konfirmasi menyebut bahwa perintah yang mengantre ikut dibatalkan');
ok(/dikirim ulang/i.test(bHapus),
   'konfirmasi memberi tahu perubahan harus dikirim ulang');
ok(/Tidak ada perintah apa pun yang dikirim ke ONU/i.test(bHapus),
   'konfirmasi menegaskan ONU tidak disentuh');

// Berurutan, bukan paralel: GenieACS mengunci sesi per-perangkat saat
// menghapus, jadi permintaan serentak ke ONU yang sama saling menolak 503.
ok(/rantai = rantai\.then/.test(bHapus),
   'hapus-semua dikirim BERURUTAN (paralel saling menolak 503)');
ok(!/Promise\.all/.test(bHapus), 'tidak memakai Promise.all pada satu ONU yang sama');

// Sesudah menghapus, daftar digambar ulang — bukan dibiarkan basi.
ok(/_updateFaultSection\(\)/.test(bHapus), 'daftar fault dimuat ulang sesudah dihapus');

// ── 4. Berlaku untuk SEMUA tipe ONU ──
// Permintaannya eksplisit: bukan hanya untuk satu SN atau satu model.
ok(!/HWTC10070328/.test(ddC), 'tidak ada SN yang dipatok di kode');
ok(!/ZL-2113X/.test(bBuild + bHapus), 'tidak ada model yang dipatok di jalur ini');
ok(!/_vendorCfg|getVendorWanConfig/.test(bBuild + bHapus),
   'tidak bergantung profil vendor — berlaku untuk semua tipe ONU');

// ── 5. Pagar server harus MENGIZINKAN ini ──
// Membatalkan perintah justru MENGURANGI beban ONU, jadi harus tetap boleh
// bahkan saat mode aman menyala.
const guard = read('acs_guard.py');
ok(/KOLEKSI_TERKUNCI = \([^)]*\)/.test(guard), 'daftar koleksi terkunci ada');
const terkunci = guard.match(/KOLEKSI_TERKUNCI = \(([^)]*)\)/)[1];
ok(!/'faults'/.test(terkunci), "koleksi 'faults' TIDAK terkunci");
ok(/metode == 'DELETE' and koleksi in \('tasks', 'faults'\)/.test(guard),
   'DELETE faults/tasks tetap diizinkan walau mode aman menyala');

// ── 6. Gaya ──
ok(/\.dct-fault-del\s*\{/.test(cssS), 'gaya tombol hapus ada');
ok(/\.dct-fault-clear-all\s*\{/.test(cssS), 'gaya tombol hapus semua ada');
ok(/\.dct-fault-msg\s*\{[^}]*flex:\s*1/.test(cssS),
   'teks fault mengisi ruang, tombol tidak terdorong keluar');
ok(/\.dct-fault-del:disabled/.test(cssS), 'keadaan tombol nonaktif digayakan');
// Komentar dibuang dulu: berkas ini MENYEBUT backdrop-filter untuk menjelaskan
// kenapa ia dihindari, dan menyebut bukan memakai.
ok(!/backdrop-filter/.test(cssS.replace(/\/\*[\s\S]*?\*\//g, '')),
   'tanpa backdrop-filter (pemicu crash GPU)');

console.log('faultclear: %d lulus, %d gagal', pass, fail);
process.exit(fail ? 1 : 0);
