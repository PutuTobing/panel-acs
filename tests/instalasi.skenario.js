/* Skenario instalasi pertama — dijalankan tests/instalasi.test.js lewat tools/potret.js
 * dengan --kosong (panel baru dipasang: basis data sementara TANPA satu akun pun).
 *
 * Yang dijaga: alur yang dilalui orang yang baru memasang panel di server baru —
 *   alamat apa pun → /login → form INSTALASI (bukan form masuk) → buat administrator
 *   → langsung masuk panel → administrator bisa membuat akun user & pelanggan
 *   → sesudah itu /login menampilkan form masuk biasa, dan instalasi kedua ditolak.
 */
'use strict';

module.exports = async (h) => {
  let lulus = 0, gagal = 0;
  const ok = (c, m) => { if (c) lulus++; else { gagal++; console.log('  ✗ ' + m); } };
  const isi = (id, v) => h.js('(function(){var e=document.getElementById(' + JSON.stringify(id) + ');e.value=' + JSON.stringify(v)
    + ';e.dispatchEvent(new Event("input",{bubbles:true}));})()');
  const SANDI = 'Instalasi#Kuat-2026';

  await h.ukuran(412, 915, true);
  await h.buka('/');
  // Form instalasi baru tampil sesudah halaman bertanya ke server (/auth/setup). Ditunggu
  // sampai muncul — jeda tetap 0,9 detik pernah kurang saat seluruh uji berjalan beruntun
  // dan laptop sibuk (2026-10-04: gagal sekali, lulus saat dijalankan sendirian).
  try { await h.tunggu('#setupScreen:not([hidden])', 10000); } catch (_) { /* dinilai pemeriksaan di bawah */ }
  ok(await h.js('location.pathname') === '/login', 'panel kosong: alamat utama dialihkan ke /login');
  ok(await h.js('!document.getElementById("setupScreen").hidden && document.getElementById("loginScreen").hidden'),
     'yang tampil form INSTALASI (belum ada akun untuk dipakai masuk)');
  ok(await h.js('document.getElementById("setupCodeWrap").hidden'), 'dari komputer server sendiri tidak diminta kode instalasi');
  ok(await h.js('(function(){var k=document.querySelector("#setupScreen .login-card").getBoundingClientRect();return k.left>=0&&k.right<=window.innerWidth+1;})()'),
     'form instalasi muat di layar HP');

  await isi('setupName', 'Admin Baru'); await isi('setupEmail', 'admin.baru@contoh.id');
  ok(await h.js('document.getElementById("setupUser").value') === 'admin.baru', 'username diusulkan dari email');
  await isi('setupPass', SANDI); await isi('setupPass2', 'beda');
  await h.klik('#setupBtn');
  ok(await h.js('!document.getElementById("setupError").hidden && /tidak sama/.test(document.getElementById("setupError").textContent)'),
     'password & ulangannya berbeda → ditolak dengan penjelasan');
  await isi('setupPass2', SANDI);
  await h.klik('#setupBtn');
  await h.tunggu('#app:not([hidden])', 15000);
  ok(await h.js('location.pathname') === '/' && await h.js('/Administrator/.test(document.querySelector(".admin-role").textContent)'),
     'akun pertama dibuat → langsung masuk panel sebagai Administrator');

  // Administrator membuat akun user & pelanggan (database akun tidak ikut repositori —
  // semuanya lahir dari sini).
  const buat = (u, role) => h.js('fetch("/auth/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify('
    + JSON.stringify({ username: u, password: 'Akun#Baru-2026x', name: u, role }) + ')}).then(function(r){return r.status;})');
  ok(await buat('teknisi.satu', 'user') === 200 && await buat('pelanggan.satu', 'pelanggan') === 200,
     'administrator bisa membuat akun user dan pelanggan');
  ok(await h.js('fetch("/auth/users").then(function(r){return r.json();}).then(function(d){return d.users.map(function(u){return u.role;}).sort().join();})')
     === 'administrator,pelanggan,user', 'ketiga role tersimpan di basis data');
  ok(await h.js('fetch("/auth/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"penyusup",password:"'
    + SANDI + '",name:"x",email:"x@x.id"})}).then(function(r){return r.status;})') === 409, 'instalasi kedua ditolak (409)');

  await h.js('fetch("/auth/logout",{method:"POST"}).then(function(r){return r.status;})');
  await h.buka('/'); await h.tidur(800);
  ok(await h.js('location.pathname') === '/login' && await h.js('!document.getElementById("loginScreen").hidden && document.getElementById("setupScreen").hidden'),
     'sesudah ada akun: /login menampilkan form masuk, bukan instalasi');
  ok(h.galat.length === 0, 'tidak ada galat JavaScript' + (h.galat.length ? ': ' + String(h.galat[0]).split('\n')[0] : ''));

  console.log('instalasi: ' + lulus + ' lulus, ' + gagal + ' gagal');
  if (gagal) throw new Error(gagal + ' pemeriksaan instalasi gagal');
};
