/* Skenario uji tampilan — dijalankan tests/tampilan.test.js lewat tools/potret.js
 * (browser sungguhan tanpa jendela, panel dengan basis data sementara, GenieACS TIRUAN,
 * dua perangkat contoh buatan dari tools/potret-contoh.js dengan teks ber-HTML).
 *
 * Yang dijaga adalah hal yang tak terlihat oleh uji statis:
 *   1. Form Edit/Tambah benar-benar terbuka sebagai POP-UP, dan daftar di belakangnya tetap ada.
 *   2. Pop-up tidak mengubah apa yang dikirim: Simpan tanpa perubahan → NOL perintah;
 *      mengubah VLAN → hanya grup VLAN yang terkirim; sesudah "ONU" menjalankan → pop-up
 *      tertutup dan daftar menampilkan nilai baru.
 *   3. Teks dari perangkat (nama WiFi, hostname, username) tampil sebagai TEKS — tidak
 *      dijalankan browser (dulu hostname disisipkan mentah ke innerHTML).
 *   4. Laporan pelanggan: isinya benar, tanpa perintah ke ONU.
 *   5. Layar HP (390px & 320px): tak ada kartu yang meluber ke samping; pop-up jadi lembar bawah.
 */
'use strict';

module.exports = async (h) => {
  let lulus = 0, gagal = 0;
  const ok = (c, m) => { if (c) lulus++; else { gagal++; console.log('  ✗ ' + m); } };
  const id1 = h.daftar.find(x => /F663NV9/.test(x));
  const id2 = h.daftar.find(x => /F670L/.test(x));
  const ada  = sel => h.js('!!document.querySelector(' + JSON.stringify(sel) + ')');
  // Pop-up "hidup" = lapisan yang bukan bayangan penutup.
  const popAda = () => h.js('!!document.querySelector(".pop-lapis:not(.pop-keluar)")');
  const esc = () => h.js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})), true');
  const tungguHilang = async (ms) => {
    const batas = Date.now() + ms;
    while (Date.now() < batas) { if (!(await popAda())) return true; await h.tidur(150); }
    return false;
  };
  const buka = async (id) => {
    await h.buka('/devices/' + encodeURIComponent(id));
    await h.tunggu('#ddInfoGrid .di-row', 15000);
    await h.tunggu('#dctWan .wan-card', 15000);
    await h.tidur(400);
  };
  const tulis = () => h.catatan.filter(c => /setParameterValues|addObject|deleteObject/.test(c.badan));

  // ══ 1. Desktop — halaman, escape, Device Information ══
  await h.ukuran(1440, 900, false);
  await buka(id1);
  ok(await h.js('window.__xssKena !== 1'), 'teks ber-HTML dari perangkat TIDAK dijalankan browser');
  ok(await h.js('!document.querySelector("#page-device-detail img[src=\\"x\\"]")'),
     'tidak ada elemen <img> sisipan dari nama WiFi / hostname / username');
  ok(await h.js('document.getElementById("ddClientList").textContent.includes("onerror")'),
     'hostname ber-HTML tampil apa adanya sebagai teks');
  ok(await h.js('document.getElementById("ddInfoGrid").textContent.includes("@sky")'),
     'PPPoE user tampil LENGKAP di Device Information (termasuk @realm)');
  ok(await h.js('(function(){var g=document.getElementById("ddInfoGrid").getBoundingClientRect();'
       + 'return [].every.call(document.querySelectorAll("#ddInfoGrid .di-row"),function(e){var r=e.getBoundingClientRect();'
       + 'return r.left>=g.left-1&&r.right<=g.right+1&&e.scrollWidth<=e.clientWidth+1;});})()'),
     'tidak ada petak Device Information yang keluar dari kartunya / terpotong');
  ok(await ada('#btnLaporanDevice') && await ada('#btnRebootDevice') && await ada('#btnRemoteDevice'),
     'tombol Laporan, Remote, Reboot ada di hero');

  // ══ 2. Edit WAN sebagai pop-up ══
  const tombolEdit = await h.js('(function(){var b=[].slice.call(document.querySelectorAll("#dctWan [id^=wan-edit-]"))'
    + '.filter(function(x){return /ppp/.test(x.id);})[0];return b?"#"+b.id:null;})()');
  ok(!!tombolEdit, 'tombol Edit koneksi PPPoE ditemukan');
  await h.klik(tombolEdit);
  await h.tunggu('#wanSaveBtn', 8000);
  ok(await h.js('!!document.getElementById("wanSaveBtn").closest(".pop-lapis")'), 'form Edit WAN berada di dalam pop-up');
  ok(await ada('#dctWan .wan-card'), 'daftar WAN tetap ada di belakang pop-up');
  ok(await h.js('document.querySelectorAll("#wanSaveBtn").length === 1 && document.querySelectorAll("#wanVlanId").length === 1'),
     'tidak ada id isian ganda di dokumen');
  ok(await h.js('getComputedStyle(document.querySelector(".pop-lapis")).zIndex === "950"'),
     'pop-up di lapisan 950 — di bawah dialog konfirmasi (1000)');
  ok(await h.js('document.getElementById("wanPppUser").value.includes("@sky")'), 'isian form terisi dari data ONU');

  // Klik latar tidak menutup; Esc menutup.
  await h.js('document.querySelector(".pop-lapis").dispatchEvent(new MouseEvent("mousedown",{bubbles:true})), true');
  await h.tidur(200);
  ok(await popAda(), 'klik di luar kotak TIDAK menutup form (isian tak hilang karena salah klik)');

  // Simpan tanpa mengubah apa pun → tidak ada perintah tulis.
  let sebelum = tulis().length;
  await h.klik('#wanSaveBtn');
  await h.tidur(1500);
  ok(tulis().length === sebelum, 'Simpan tanpa perubahan → NOL perintah tulis ke ONU');
  ok(await h.js('/Tidak ada perubahan/.test((document.getElementById("wanSaveStatus")||{}).textContent||"")'),
     'operator diberi tahu "Tidak ada perubahan"');
  ok(await popAda(), 'form tetap terbuka sesudah "tidak ada perubahan"');

  // Ubah VLAN ID → hanya grup VLAN yang terkirim, lalu pop-up tertutup & daftar diperbarui.
  await h.js('(function(){var e=document.getElementById("wanVlanId");e.value="101";'
    + 'e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  sebelum = tulis().length;
  await h.klik('#wanSaveBtn');
  ok(await tungguHilang(15000), 'sesudah ONU menjalankan perintah, pop-up tertutup sendiri');
  const baru = tulis().slice(sebelum);
  ok(baru.length === 1, 'tepat SATU perintah tulis untuk satu Simpan (dapat ' + baru.length + ')');
  let nama = [];
  try { nama = JSON.parse(baru[0].badan).parameterValues.map(p => p[0].split('.').pop() + '=' + p[1]); } catch (_) { nama = ['?']; }
  ok(nama.join() === 'X_CMCC_VLANIDMark=101,X_CMCC_VLANMode=2',
     'yang dikirim HANYA grup VLAN (dapat: ' + nama.join() + ')');
  await h.tunggu('#dctWan .wan-card', 8000);
  ok(await h.js('document.getElementById("dctWan").textContent.includes("101")'), 'daftar WAN menampilkan VLAN baru');
  ok(await h.js('document.querySelectorAll(".pop-lapis:not(.pop-keluar)").length === 0 && !document.getElementById("wanSaveBtn")'),
     'tidak ada sisa form di dokumen sesudah pop-up tertutup');

  // Esc menutup pop-up; halaman digambar ulang selagi form terbuka → form ditutup.
  await h.klik('#wanAddBtn');
  await h.tunggu('#wanConnType', 8000);
  ok(await h.js('!!document.getElementById("wanConnType").closest(".pop-lapis")'), 'form Tambah WAN berada di dalam pop-up');
  await esc(); await h.tidur(350);
  ok(!(await popAda()), 'Esc menutup pop-up');
  await h.klik('#wanAddBtn');
  await h.tunggu('#wanConnType', 8000);
  await h.js('initDeviceDetail(), true'); await h.tidur(400);
  ok(!(await popAda()), 'halaman digambar ulang (Refresh selesai) → form basi ditutup, tidak dibiarkan menimpa nilai baru');

  // ══ 3. SSID & Channel/Bandwidth ══
  await h.js('showConfigTab("ssid"), true'); await h.tidur(300);
  ok(await h.js('document.querySelectorAll("#dctSsid .dct-ssid-card").length === 4'), 'empat kartu SSID');
  ok(await h.js('document.querySelector("#dctSsid .dct-ssid-name").textContent.includes("onerror")'),
     'nama WiFi ber-HTML tampil sebagai teks');
  await h.klik('#dctSsid .ssid-cfg-btn');
  await h.tunggu('#btnSsidSave', 8000);
  ok(await h.js('!!document.getElementById("btnSsidSave").closest(".pop-lapis")'), 'Konfigurasi SSID berada di dalam pop-up');
  ok(await h.js('document.getElementById("scSSID").value.includes("onerror")'), 'nama SSID masuk ke isian apa adanya');
  await h.klik('#btnSsidBack'); await h.tidur(350);
  ok(!(await popAda()) && await ada('#dctSsid .dct-ssid-card'), 'Batal menutup pop-up dan daftar SSID tetap ada');
  await h.klik('#btnRadioCfg');
  await h.tunggu('#btnRadioSave', 8000);
  ok(await h.js('!!document.getElementById("btnRadioSave").closest(".pop-lapis")'), 'Channel & Bandwidth berada di dalam pop-up');
  ok(await h.js('(function(){var n=document.querySelector(".radio-note");return !!n&&n.children.length===2;})()'),
     'catatan radio = ikon + SATU blok teks (tidak terbelah jadi tiga kolom)');
  sebelum = tulis().length;
  await h.klik('#btnRadioSave'); await h.tidur(600);
  ok(tulis().length === sebelum, 'Simpan radio tanpa perubahan → NOL perintah tulis');
  await esc(); await h.tidur(350);

  // ══ 4. Laporan pelanggan & foto ══
  sebelum = h.catatan.length;
  await h.klik('#btnLaporanDevice');
  await h.tunggu('.lap-kartu', 5000);
  const teks = await h.js('document.querySelector(".lap-kartu").textContent');
  ok(/F663NV9/.test(teks) && /ZTEGCONTOH0001/.test(teks), 'laporan memuat model & nomor seri');
  ok(/-18\.42/.test(teks) && /48/.test(teks) && /10\.99\.1\.25/.test(teks), 'laporan memuat RX Power, suhu, IP PPPoE');
  ok(/AA:11:BB:00:10:01/.test(teks) && /3 hari 5 jam/.test(teks), 'laporan memuat MAC & uptime');
  ok(/Laptop-Kantor/.test(teks) && /TV-Ruang-Tamu/.test(teks) && /Kabel LAN/.test(teks),
     'laporan memuat nama perangkat terhubung (WiFi & LAN)');
  ok(/1 perangkat tanpa nama/.test(teks), 'perangkat tanpa nama dihitung, bukan dihilangkan');
  ok(!/192\.168\.1\./.test(teks) && !/DE:AD:BE/.test(teks), 'IP & MAC perangkat pelanggan TIDAK ikut ke laporan');
  ok(!/10\.98\.0\.25/.test(teks), 'IP TR-069 tidak ikut ke laporan');
  ok(await h.js('window.__xssKena !== 1 && !document.querySelector(".lap-kartu img[src=\\"x\\"]")'),
     'laporan: teks ber-HTML tetap teks');
  ok(h.catatan.length === sebelum, 'membuka laporan tidak mengirim apa pun ke ONU');
  await esc(); await h.tidur(300);
  ok(!(await ada('.lap-lapis:not(.pop-keluar)')), 'Esc menutup laporan');
  await h.klik('#ddHeroFoto');
  await h.tunggu('.foto-lapis', 5000);
  ok(await h.js('/F663NV9\\.PNG$/i.test(decodeURIComponent(document.querySelector(".foto-img").getAttribute("src")))'),
     'menekan foto ONU menampilkan foto model itu dalam ukuran besar');
  await esc(); await h.tidur(300);
  ok(!(await ada('.foto-lapis:not(.pop-keluar)')), 'Esc menutup foto');

  // ══ 5. Setting ══
  await h.js('showConfigTab("setting"), true'); await h.tidur(500);
  ok(await ada('#dctSetting .dct-setting-wrap #stg-super-pass'), 'form kredensial Super Admin ada di tab Setting');
  ok(await h.js('!document.getElementById("dctWan").classList.contains("dct-hidden") === false'),
     'tab lain tersembunyi saat Setting dibuka');

  // ══ 6. Perangkat lain di tab yang sama ══
  // Dulu alamat /devices/<B> yang dibuka di tab yang terakhir melihat A tetap menampilkan A
  // (salinan sessionStorage dipakai tanpa dicocokkan) — tombol Reboot/Simpan bekerja pada A.
  await buka(id2);
  ok(await h.js('document.getElementById("ddDeviceTitle").textContent.includes("ZTEGCONTOH0002") && App.currentDevice.id === '
       + JSON.stringify(id2)),
     'membuka alamat ONU lain menampilkan ONU ITU, bukan yang terakhir dilihat');
  ok(await h.js('sessionStorage.getItem("currentDevice") === null'),
     'dokumen perangkat (berisi password) tidak disimpan di sessionStorage');
  await h.js('showConfigTab("ssid"), true'); await h.tidur(300);
  await h.klik('#btnRadioCfg');
  await h.tunggu('#btnRadioSave', 8000);
  ok(await h.js('document.querySelectorAll(".pop-lapis .radio-band-card").length === 2'), 'F670L: kartu 2.4 GHz dan 5 GHz');
  await esc(); await h.tidur(350);

  // ══ 7. Layar HP ══
  const tanpaLuber = async (label) => {
    const hasil = await h.js('(function(){var w=document.documentElement.clientWidth,buruk=[];'
      + '[".dd-hero",".dd-topo-center-card",".dd-config-card",".dd-info-card",".dd-left-card"].forEach(function(s){'
      + 'var e=document.querySelector(s);if(!e)return buruk.push(s+" hilang");var r=e.getBoundingClientRect();'
      + 'if(r.width<w*0.8)buruk.push(s+" menyempit "+Math.round(r.width));'
      + 'if(r.right>w+1||r.left<-1)buruk.push(s+" keluar layar");});'
      + '[".dtc-row",".dd-hero-body",".di-grid","#dctWan"].forEach(function(s){var e=document.querySelector(s);'
      + 'if(e&&e.scrollWidth>e.clientWidth+1)buruk.push(s+" meluber "+(e.scrollWidth-e.clientWidth)+"px");});'
      + 'var c=document.getElementById("contentArea");if(c&&c.scrollWidth>c.clientWidth+1)buruk.push("halaman bergulir ke samping");'
      + 'return buruk.join("; ");})()');
    ok(hasil === '', label + ': tak ada kartu yang meluber/menyempit' + (hasil ? ' → ' + hasil : ''));
  };
  for (const [l, t] of [[390, 844], [320, 640]]) {
    await h.ukuran(l, t, true);
    await buka(id1);
    await tanpaLuber('layar ' + l + 'px (satu pita)');
    await buka(id2);
    await tanpaLuber('layar ' + l + 'px (dua pita, topologi bercabang)');
  }
  await h.klik('#wanAddBtn');
  await h.tunggu('#wanConnType', 8000); await h.tidur(450);
  ok(await h.js('(function(){var k=document.querySelector(".pop-kotak").getBoundingClientRect();'
       + 'return Math.abs(k.bottom-window.innerHeight)<=2&&k.left<=1&&k.right>=window.innerWidth-1;})()'),
     'di HP pop-up menjadi lembar selebar layar yang menempel di bawah');
  ok(await h.js('(function(){var b=document.querySelector(".pop-badan");return b.scrollWidth<=b.clientWidth+1;})()'),
     'isi form di HP tidak meluber ke samping');
  await esc(); await h.tidur(300);

  ok(h.galat.length === 0, 'tidak ada galat JavaScript di halaman' + (h.galat.length ? ': ' + String(h.galat[0]).split('\n')[0] : ''));

  console.log('tampilan: ' + lulus + ' lulus, ' + gagal + ' gagal');
  if (gagal) throw new Error(gagal + ' pemeriksaan tampilan gagal');
};
