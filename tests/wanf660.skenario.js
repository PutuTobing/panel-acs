/* Skenario uji browser form WAN keluarga X_CMCC pada perangkat BUATAN berbentuk ZTE F660 —
 * dijalankan tests/wanf660.test.js lewat tools/potret.js (browser tanpa jendela, panel dengan
 * basis data sementara, GenieACS TIRUAN).
 *
 * LATAR (audit 2026-10-13, F660 SN ZTERQDGK3N44927 — hanya dibaca): ONU itu punya PPPoE BRIDGE
 * ber-VLAN mode 1 (transparent) dan MaxMRUSize 0. Form Edit hanya mengenal Tagged/Untagged dan
 * mengisi MTU dengan bawaan 1480, sehingga menekan Simpan TANPA mengubah apa pun mengirim
 * X_CMCC_VLANMode=2 dan MaxMRUSize=1480 ke koneksi pelanggan.
 *
 * Yang dijaga — di browser sungguhan, sampai ke perintah yang (tidak) dikirim:
 *   1. Koneksi transparent tampil sebagai Transparent dan Simpan tanpa perubahan = NOL perintah.
 *   2. Koneksi routed biasa TIDAK berubah perilakunya (dua pilihan, MTU terisi, nol perintah).
 *   3. Mengubah MTU memang mengirim MTU — dan hanya itu.
 *   4. Tab Setting F660: Super Admin lewat X_CMCC_TeleComAccount; User Admin dimatikan.
 */
'use strict';

module.exports = async (h) => {
  let lulus = 0, gagal = 0;
  const ok = (c, m) => { if (c) lulus++; else { gagal++; console.log('  ✗ ' + m); } };
  const id = h.daftar[0];
  const buka = async () => {
    await h.buka('/devices/' + encodeURIComponent(id));
    await h.tunggu('#dctWan .wan-card', 15000);
    await h.tidur(500);
  };
  const tombolEdit = n => h.js('(function(){var b=[].filter.call(document.querySelectorAll("#dctWan [id^=wan-edit-]"),'
    + 'function(x){return /ppp/i.test(x.id)&&/_' + n + '$/.test(x.id);})[0];return b?"#"+b.id:null;})()');
  const form = () => h.js('(function(){var m=document.getElementById("wanVlanMode"),u=document.getElementById("wanMtu"),g=document.getElementById("wanVlanIdGroup");'
    + 'return {mode:m&&m.value,opsi:m?[].map.call(m.options,function(o){return o.value;}).join():"",teks:m?m.options[m.selectedIndex].textContent:"",'
    + 'mtu:u?u.value:null,ph:u?u.placeholder:"",vid:g?getComputedStyle(g).display:""};})()');
  const status = () => h.js('(function(){var s=document.getElementById("wanSaveStatus");return s?s.innerText:"";})()');
  const tulis = () => h.catatan.filter(c => /setParameterValues|addObject|deleteObject/.test(c.badan));

  await h.ukuran(1440, 900, false);

  // ══ 1. PPPoE bridge transparent (VLAN 0, mode 1, MRU 0) ══
  await buka();
  ok(await h.js('[].some.call(document.querySelectorAll("#dctWan .wan-card"),function(c){return /Transparent/.test(c.innerText);})'),
     'kartu WAN bridge menulis "(Transparent)"');
  await h.klik(await tombolEdit(5)); await h.tunggu('#wanSaveBtn', 15000); await h.tidur(800);
  let f = await form();
  ok(f.mode === '1' && f.opsi === '2,0,1' && /Transparent/.test(f.teks), 'VLAN Mode terpilih Transparent — ' + JSON.stringify(f));
  ok(f.vid === 'none', 'isian VLAN ID disembunyikan untuk Transparent');
  ok(f.mtu === '' && /bawaan ONU/.test(f.ph), 'MTU tampil kosong dengan keterangan (ONU melapor 0), bukan 1480');
  let n = tulis().length;
  await h.klik('#wanSaveBtn'); await h.tidur(2200);
  ok(tulis().length === n && /Tidak ada perubahan/.test(await status()),
     'Simpan TANPA perubahan pada bridge transparent = NOL perintah ke ONU — terkirim: ' + JSON.stringify(tulis().slice(n).map(c => c.badan.slice(0, 160))));

  // ══ 2. Koneksi routed biasa: perilaku lama ══
  await buka();
  await h.klik(await tombolEdit(2)); await h.tunggu('#wanSaveBtn', 15000); await h.tidur(800);
  f = await form();
  ok(f.mode === '2' && f.opsi === '2,0' && f.mtu === '1480' && f.vid !== 'none', 'koneksi routed: Tagged, dua pilihan saja, MTU 1480 — ' + JSON.stringify(f));
  n = tulis().length;
  await h.klik('#wanSaveBtn'); await h.tidur(2200);
  ok(tulis().length === n, 'Simpan tanpa perubahan pada koneksi routed = nol perintah');

  // ══ 3. Mengisi MTU pada bridge memang mengirim MTU — dan hanya itu ══
  await buka();
  await h.klik(await tombolEdit(5)); await h.tunggu('#wanSaveBtn', 15000); await h.tidur(800);
  await h.js('(function(){var u=document.getElementById("wanMtu");u.value="1492";u.dispatchEvent(new Event("input",{bubbles:true}));u.dispatchEvent(new Event("change",{bubbles:true}));return 1;})()');
  n = tulis().length;
  await h.klik('#wanSaveBtn'); await h.tidur(2600);
  const baru = tulis().slice(n).map(c => { try { return JSON.parse(c.badan); } catch (_) { return {}; } });
  const nilai = baru.reduce((a, t) => a.concat(t.parameterValues || []), []);
  ok(nilai.length === 1 && /WANPPPConnection\.5\.MaxMRUSize$/.test(nilai[0][0]) && Number(nilai[0][1]) === 1492,
     'mengisi MTU 1492 → hanya MaxMRUSize koneksi itu yang terkirim — ' + JSON.stringify(nilai));

  // ══ 4. Tab Setting F660 ══
  await buka();
  await h.js('(function(){var t=[].filter.call(document.querySelectorAll(".dct-tab, [data-tab]"),function(x){return /Setting/i.test(x.textContent);})[0];if(t)t.click();return !!t;})()');
  await h.tunggu('#stg-super-btn', 10000); await h.tidur(1200);
  const st = await h.js('(function(){var u=document.getElementById("stg-super-curuser");return {superAda:!!document.getElementById("stg-super-btn"),userAda:!!document.getElementById("stg-user-btn"),'
    + 'nama:u?u.textContent:"",teks:(document.getElementById("page-device-detail").innerText||"").replace(/\\s+/g," ")};})()');
  ok(st.superAda && !st.userAda, 'Setting: form Super Admin aktif, form User Admin tidak ada');
  ok(/F660 \(X_CMCC\)/.test(st.teks) && !/belum dipetakan/.test(st.teks), 'User Admin dimatikan dengan keterangan model (bukan "path belum dipetakan")');

  ok(h.galat.length === 0, 'tidak ada galat JavaScript di halaman' + (h.galat.length ? ': ' + String(h.galat[0]).split('\n')[0] : ''));
  console.log('wanf660: ' + lulus + ' lulus, ' + gagal + ' gagal');
  if (gagal) throw new Error(gagal + ' pemeriksaan gagal');
};
