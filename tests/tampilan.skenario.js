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
 *   6. Settings menurut hak akses role: role user hanya melihat menu yang dibuka
 *      administrator; kartu "Hak Akses Role User" menyimpan & meminta konfirmasi.
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

  // ══ 7b. Refresh satu baris di menu Device (2026-10-03) ══
  // Dulu: baris diisi data SEBELUM refresh bila ONU sempat inform rutin sejak daftar dimuat.
  await h.ukuran(1440, 900, false);
  await h.buka('/devices'); await h.tunggu('#deviceTableBody tr[data-id]'); await h.tidur(600);
  const dRef = h.dok.find(x => x._id === id1);
  dRef.__saatRefresh = x => { x.VirtualParameters.RXPower._value = '-21.05'; };
  dRef._lastInform = new Date().toISOString();       // inform rutin sesudah daftar dimuat
  const brs = 'document.querySelector(' + JSON.stringify('#deviceTableBody tr[data-id="' + id1 + '"]') + ')';
  const rxBaris = () => h.js('(function(){var t=' + brs + ';var m=t&&t.querySelector(".rx-badge");return m?m.textContent.trim():"(tak ada)";})()');
  await h.js(brs + '.querySelector(".act-refresh").click()');
  await h.tidur(1500);
  ok(await h.js('document.querySelectorAll(".proses-kartu").length') === 1, 'refresh baris: penanda proses tampil di kanan bawah');
  ok(await rxBaris() === '-18.42 dBm', 'selama ONU belum menjalankan refresh, baris TIDAK diisi data lama sebagai "baru" (dapat ' + await rxBaris() + ')');
  await h.tidur(5500);
  ok(await rxBaris() === '-21.05 dBm', 'sesudah refresh dijalankan ONU, baris menampilkan data terbaru (dapat ' + await rxBaris() + ')');
  ok(await h.js('/Perintah refresh berhasil dikirimkan ke ONU SN: ZTEGCONTOH0001/.test((document.querySelector(".app-toast")||{}).textContent||"")')
     && await h.js('document.querySelectorAll(".proses-kartu").length') === 0, 'penanda proses diganti notifikasi berhasil');
  delete dRef.__saatRefresh;

  // Reboot per baris: harus mengenai ONU yang TERTULIS di baris itu — juga saat tabel
  // sedang difilter/diurutkan lain (dulu baris dicari lewat nomor urut).
  await h.js('(function(){var s=document.getElementById("deviceSearch");s.value="CONTOH0002";s.dispatchEvent(new Event("input"));})()');
  await h.tidur(300);
  ok(await h.js('document.querySelectorAll("#deviceTableBody tr[data-id]").length') === 1, 'pencarian menyisakan satu baris (ONU kedua)');
  const sebelumReboot = h.catatan.length;
  await h.js('document.querySelector(' + JSON.stringify('#deviceTableBody tr[data-id="' + id2 + '"] .act-reboot') + ').click()');
  await h.tunggu('#appConfirm', 4000);
  ok(await h.js('/ZTEGCONTOH0002/.test(document.getElementById("appConfirm").textContent)'), 'konfirmasi reboot menyebut SN ONU di baris yang diklik');
  await h.klik('#appConfirm [data-act="yes"]'); await h.tidur(2800);
  const rb = h.catatan.slice(sebelumReboot);
  ok(rb.length === 1 && /"reboot"/.test(rb[0].badan) && rb[0].url.indexOf(encodeURIComponent(id2)) !== -1,
     'reboot terkirim tepat satu kali, ke ONU yang ditampilkan di baris itu');
  ok(await h.js('/Perintah reboot berhasil dikirimkan ke ONU SN: ZTEGCONTOH0002/.test((document.querySelector(".app-toast")||{}).textContent||"")'),
     'reboot berhasil → "Perintah reboot berhasil dikirimkan ke ONU SN: …"');
  // Cari MAC: pemisah bebas, cukup sebagian.
  const cari = async q => {
    await h.js('(function(){var s=document.getElementById("deviceSearch");s.value=' + JSON.stringify(q) + ';s.dispatchEvent(new Event("input"));})()');
    await h.tidur(250);
    return h.js('Array.from(document.querySelectorAll("#deviceTableBody tr[data-id]")).map(function(t){return t.dataset.id;}).join()');
  };
  ok(await cari('AA:11:BB:00:10') === id1 && await cari('aa-11-bb-00-10') === id1 && await cari('11bb0010') === id1,
     'cari MAC: "AA:11:BB…", "aa-11-bb…", "11bb0010" menemukan ONU yang sama');
  ok(await cari('00:00:5E:99') === '', 'MAC yang tidak ada → tabel kosong');
  await cari('');

  // ══ 7c. Klik SN → Laporan Kondisi Perangkat + Screenshot 1080 × 2340 (2026-10-03) ══
  const sebelumSn = h.catatan.length;
  await h.js('document.querySelector(' + JSON.stringify('#deviceTableBody tr[data-id="' + id1 + '"] .sn-cell') + ').click()');
  await h.tunggu('.lap-kartu', 8000); await h.tidur(500);
  const tSn = await h.js('document.querySelector(".lap-kartu").textContent');
  ok(/Laporan Kondisi Perangkat/.test(tSn) && /F663NV9/.test(tSn) && /-21\.05/.test(tSn) && /Data terakhir dari perangkat/.test(tSn),
     'klik SN membuka laporan dari data terakhir GenieACS (termasuk hasil refresh tadi)');
  ok(h.catatan.length === sebelumSn, 'membuka laporan dari menu Device tidak mengirim perintah ke ONU');
  ok(await h.js('(function(){var r=document.querySelector(".lap-kartu").getBoundingClientRect();return Math.round(r.width)+"x"+Math.round(r.height);})()') === '360x780',
     'kartu laporan berukuran layar HP: 360 × 780');
  const ukGambar = await h.js('_lapGambar(document.querySelector(".lap-kartu")).then(function(b){return createImageBitmap(b);}).then(function(i){return i.width+"x"+i.height;})');
  ok(ukGambar === '1080x2340', 'Screenshot menghasilkan PNG 1080 × 2340 (dapat ' + ukGambar + ')');
  ok(await h.js('/berikut informasi nama perangkat\\n1\\. /.test(_lapTeks(_lapEl._L))'), 'teks Salin memakai daftar nama bernomor');
  await h.js('_lapTutup()'); await h.tidur(250);

  // ══ 7d. Tag panel (MITRA-SURYA) — pasang lewat bilah aksi massal, lalu filter ══
  const sebelumTag = h.catatan.length;
  await h.klik('#btnSelect');
  await h.js('(function(){var c=document.querySelector(' + JSON.stringify('#deviceTableBody tr[data-id="' + id1 + '"] .row-cb') + ');c.checked=true;c.dispatchEvent(new Event("change",{bubbles:true}));})()');
  ok(await h.js('!document.getElementById("bulkTag").hidden'), 'administrator melihat tombol Tag di bilah aksi massal');
  await h.klik('#bulkTag');
  await h.js('document.getElementById("tagNamaBaru").value="mitra surya"');
  await h.klik('#tagModal [data-act="buat"]'); await h.tidur(1200);
  await h.js('document.getElementById("tagModal").remove()');
  await h.klik('#btnSelect');
  ok(await h.js('(function(){var c=document.querySelector(' + JSON.stringify('#deviceTableBody tr[data-id="' + id1 + '"] .tag-chip') + ');return c?c.textContent:"";})()') === 'MITRA-SURYA',
     'tag "mitra surya" dibuat sebagai MITRA-SURYA dan tampil di kolom Tags');
  await h.js('(function(){var s=document.getElementById("tagFilter");s.value="MITRA-SURYA";s.dispatchEvent(new Event("change"));})()');
  await h.tidur(300);
  ok(await h.js('document.querySelectorAll("#deviceTableBody tr[data-id]").length') === 1, 'filter tag menampilkan hanya ONU ber-tag MITRA-SURYA');
  ok(h.catatan.length === sebelumTag, 'tag tidak mengirim apa pun ke GenieACS/ONU');
  await h.js('(function(){var s=document.getElementById("tagFilter");s.value="";s.dispatchEvent(new Event("change"));})()');

  // ══ 8. Settings menurut hak akses role (2026-10-03) ══
  const menu = () => h.js('Array.from(document.querySelectorAll(".st-nav-item")).filter(function(b){'
    + 'return b.offsetParent!==null;}).map(function(b){return b.dataset.izin;}).join()');
  const grup = () => h.js('Array.from(document.querySelectorAll(".st-nav-group")).filter(function(g){'
    + 'return g.offsetParent!==null;}).map(function(g){return g.textContent.trim();}).join()');
  const keSettings = async () => { await h.buka('/settings'); await h.tunggu('.st-nav'); await h.tidur(900); };
  await h.ukuran(1440, 900, false);
  await h.masuk(h.akun.user);
  await keSettings();
  ok(await menu() === 'akunSaya,tentang', 'role user (bawaan): Settings hanya Akun Saya & Tentang Sistem — dapat ' + await menu());
  ok(await grup() === 'AKUN,INFO', 'judul kelompok tanpa isi (SISTEM, PREFIX VENDOR) ikut tersembunyi');
  ok(await h.js('/User/.test(document.querySelector(".admin-role").textContent)'), 'kartu nama di header menulis peran User, bukan "Super Admin"');
  await h.klik('.st-nav-item[data-izin="tentang"]'); await h.tidur(700);
  ok(await h.js('document.getElementById("abAcsUrl").textContent') === '—', 'Tentang Sistem role user: alamat NBI tidak ditampilkan');
  ok(await h.js('fetch("/config/kesehatan").then(function(r){return r.status;})') === 403, 'menu yang tak diizinkan juga ditolak server (403)');

  await h.masuk(h.akun.admin);
  await keSettings();
  ok((await menu()).split(',').length === 11, 'administrator melihat ke-11 menu Settings');
  // Catatan berisi <b>/<strong> di tengah kalimat: wadah flex/grid memecah tiap potongan
  // menjadi kolom ("lebih dari 24 jam" dan "30" terlepas dari kalimatnya, 2026-10-03).
  ok(await h.js('Array.from(document.querySelectorAll(".acct-note, .vm-sec-desc")).every(function(e){'
       + 'return !/flex|grid/.test(getComputedStyle(e).display);})'),
     'catatan di Settings mengalir sebagai kalimat utuh (bukan flex/grid)');
  await h.klik('.st-nav-item[data-izin="manajemenAkun"]');
  await h.tunggu('#izinDaftar input[data-izin-kunci]'); await h.tidur(300);
  ok(await h.js('document.querySelectorAll("#izinDaftar input[data-izin-kunci]").length') === 12, 'kartu Hak Akses: 11 menu + izin Buat Tag = 12 kotak centang');
  ok(await h.js('(function(){var c=document.querySelector(\'#izinDaftar input[data-izin-kunci="akunSaya"]\');return c.checked&&c.disabled;})()'),
     'Akun Saya tercentang & tak bisa dicabut');
  ok(await h.js('document.getElementById("btnIzinSimpan").disabled'), 'tombol Simpan mati selama tak ada perubahan');
  await h.klik('#izinDaftar input[data-izin-kunci="kesehatan"]');
  ok(await h.js('!document.getElementById("btnIzinSimpan").disabled'), 'mencentang menu → tombol Simpan aktif');
  await h.klik('#btnIzinSimpan'); await h.tidur(700);
  ok(await h.js('fetch("/config/izin-role").then(function(r){return r.json();}).then(function(d){return d.role.user.join();})')
     === 'akunSaya,kesehatan,tentang', 'izin tersimpan di server');
  await h.klik('#izinDaftar input[data-izin-kunci="koneksiAcs"]');
  await h.klik('#btnIzinSimpan'); await h.tidur(300);
  ok(await ada('#appConfirm'), 'membuka menu berisiko (Koneksi ACS) meminta konfirmasi');
  await h.klik('#appConfirm [data-act="no"]'); await h.tidur(300);
  ok(await h.js('fetch("/config/izin-role").then(function(r){return r.json();}).then(function(d){return d.role.user.indexOf("koneksiAcs");})') === -1,
     'konfirmasi dibatalkan → tidak tersimpan');

  await h.masuk(h.akun.user);
  await keSettings();
  ok(await menu() === 'akunSaya,kesehatan,tentang', 'role user melihat menu yang baru dibuka administrator');
  ok(await grup() === 'AKUN,SISTEM,INFO', 'kelompok SISTEM muncul karena kini ada isinya');
  await h.ukuran(390, 844, true);
  await keSettings();
  ok(await h.js('(function(){var c=document.getElementById("contentArea");return c.scrollWidth<=c.clientWidth+1;})()'),
     'Settings role user di HP: halaman tidak bergulir ke samping');
  await h.masuk(h.akun.admin);
  await keSettings();
  await h.klik('.st-nav-item[data-izin="manajemenAkun"]');
  await h.tunggu('#izinDaftar input[data-izin-kunci]'); await h.tidur(300);
  ok(await h.js('(function(){var k=document.querySelector(".izin-kartu");return k.scrollWidth<=k.clientWidth+1;})()'),
     'kartu Hak Akses di HP tidak meluber ke samping');

  // ══ 9. Portal pelanggan /pelanggan (2026-10-03) — HP Android ══
  await h.ukuran(412, 915, true);
  await h.masuk(h.akun.pelanggan);
  await h.buka('/'); await h.tidur(1500);
  ok(await h.js('location.pathname') === '/pelanggan', 'akun pelanggan yang membuka panel diantar ke portal /pelanggan');
  await h.tunggu('.pl-wifi', 10000); await h.tidur(300);
  const tPel = await h.js('document.getElementById("plIsi").innerText');
  ok(/F663NV9/.test(tPel) && /-21\.05/.test(tPel) && /48/.test(tPel) && /ZTE/.test(tPel), 'portal: model, manufacturer, RX Power (hasil refresh 7b), suhu');
  ok(/Laptop-Kantor/.test(tPel) && /TV-Ruang-Tamu/.test(tPel), 'portal: perangkat terhubung (WiFi & kabel) beserta namanya');
  ok(await h.js('window.__xssKena !== 1 && !document.querySelector("#plIsi img[src=\\"x\\"]")'), 'portal: nama ber-HTML dari perangkat tetap teks');
  ok(await h.js('(function(){var c=document.documentElement;return c.scrollWidth<=c.clientWidth+1;})()'), 'portal di HP tidak bergulir ke samping');
  ok(await h.js('fetch("/api/devices?projection=_id").then(function(r){return r.status;})') === 403
     && await h.js('fetch("/config/all").then(function(r){return r.status;})') === 403, 'portal: /api & /config tertutup untuk pelanggan');
  let sebelumPel = h.catatan.length;
  await h.js('document.querySelector("[data-ubah]").click()'); await h.tidur(400);
  await h.js('document.getElementById("plNamaWifi").value="WIFI PELANGGAN"; document.getElementById("plSandiWifi").value="SandiBaru123"');
  await h.js('document.getElementById("plSimpanWifi").click()'); await h.tidur(3500);
  const tulisPel = h.catatan.slice(sebelumPel).map(c => c.badan);
  ok(tulisPel.length === 1 && /WLANConfiguration\.1\.SSID/.test(tulisPel[0]) && /WLANConfiguration\.1\.KeyPassphrase/.test(tulisPel[0])
     && JSON.parse(tulisPel[0]).parameterValues.length === 2, 'ubah WiFi: satu perintah, hanya SSID & KeyPassphrase');
  ok(/berhasil diubah/.test(await h.js('document.getElementById("plToast").textContent')), 'ubah WiFi berhasil → notifikasi berhasil');
  await h.tidur(1500);
  ok(await h.js('document.querySelector(".pl-wifi-nama b").textContent') === 'WIFI PELANGGAN', 'nama WiFi baru tampil');
  // ONU menolak (fault) → pesan + WhatsApp CS
  await h.tidur(1000);
  await h.js('document.querySelector("[data-ubah]").click()'); await h.tidur(400);
  await h.js('document.getElementById("plNamaWifi").value="GAGAL-UJI"');
  await h.js('document.getElementById("plSimpanWifi").click()');
  await h.tunggu('.pl-gagal', 15000);
  const tGagal = await h.js('document.querySelector(".pl-gagal").innerText');
  ok(/Saat ini router tidak merespon, mohon menunggu atau hubungi customer service di WhatsApp 0822-1783-5764/.test(tGagal),
     'fault → pesan "router tidak merespon" dengan nomor CS');
  ok(await h.js('document.querySelector(".pl-gagal a.wa").href') === 'https://wa.me/6282217835764?text='
     + encodeURIComponent('saya mengalami kendala mengganti nama dan password wifi saya'),
     'tombol WhatsApp membuka chat CS dengan teks kendala yang sudah terisi');
  await h.potret('portal-gagal');
  await h.js('document.querySelector(".pl-gagal [data-aksi=tutup]").click()');
  await h.masuk(h.akun.admin);

  ok(h.galat.length === 0, 'tidak ada galat JavaScript di halaman' + (h.galat.length ? ': ' + String(h.galat[0]).split('\n')[0] : ''));

  console.log('tampilan: ' + lulus + ' lulus, ' + gagal + ' gagal');
  if (gagal) throw new Error(gagal + ' pemeriksaan tampilan gagal');
};
