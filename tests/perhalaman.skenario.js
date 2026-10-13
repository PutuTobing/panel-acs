/* Skenario uji browser pemilih jumlah ONU per halaman (20/40/60/100) — dijalankan
 * tests/perhalaman-tampilan.test.js lewat tools/potret.js (browser tanpa jendela, panel dengan
 * basis data sementara, GenieACS TIRUAN berisi 130 ONU buatan).
 *
 * Yang dijaga — di browser sungguhan:
 *   1. Bawaan 20 baris; empat tombol 20/40/60/100 di kaki tabel, 20 menyala.
 *   2. Klik 40/60/100 → jumlah baris, keterangan "Showing …", dan jumlah halaman ikut berubah,
 *      TANPA satu pun permintaan ke panel maupun baca ke GenieACS (tabel digambar dari data
 *      yang sudah dimuat) — dan tanpa POST (menata halaman tidak menulis apa pun).
 *   3. Pilihan diingat sesudah halaman dimuat ulang.
 *   4. Mengganti jumlah baris tetap di ONU yang sedang dilihat (bukan kembali ke halaman 1).
 *   5. Role user (tanpa izin Settings) tetap bisa memakainya.
 *   6. Di layar HP kaki tabel melipat rapi: tidak ada yang keluar dari lebar layar.
 */
'use strict';

module.exports = async (h) => {
  let lulus = 0, gagal = 0;
  const ok = (c, m) => { if (c) lulus++; else { gagal++; console.log('  ✗ ' + m); } };
  const buka = async () => {
    await h.buka('/devices');
    await h.tunggu('#deviceTableBody tr[data-id]', 20000);
    await h.tidur(1500);                    // /config/tag & kawan-kawan selesai dulu
  };
  const lihat = () => h.js('(function(){var q=function(s){return document.querySelectorAll(s);};'
    + 'var a=document.querySelector("#perHalaman .pp-btn.active");'
    + 'var p=[].map.call(q("#pagination .page-btn"),function(b){return parseInt(b.textContent,10);}).filter(function(n){return !isNaN(n);});'
    + 'return {baris:q("#deviceTableBody tr[data-id]").length,info:document.getElementById("tblInfo").textContent,'
    + 'tombol:[].map.call(q("#perHalaman .pp-btn"),function(b){return b.textContent;}).join(),'
    + 'nyala:a?a.textContent:"",halAkhir:p.length?Math.max.apply(null,p):0,'
    + 'pertama:(q("#deviceTableBody tr[data-id] .sn-link")[0]||{}).textContent||""};})()');
  const pilih = n => h.klik('#perHalaman .pp-btn[data-n="' + n + '"]');

  await h.ukuran(1440, 900, false);
  await h.js('(function(){try{localStorage.removeItem("devPerHalaman");}catch(e){}return 1;})()');

  // ══ 1. Bawaan ══
  await buka();
  let s = await lihat();
  ok(s.baris === 20 && /^Showing 1–20 of 130 devices$/.test(s.info), 'bawaan: 20 baris dari 130 — ' + JSON.stringify(s));
  ok(s.tombol === '20,40,60,100' && s.nyala === '20', 'empat tombol 20/40/60/100, 20 menyala — ' + s.tombol + ' / ' + s.nyala);
  ok(s.halAkhir === 7, 'halaman terakhir 7 (130/20) — ' + s.halAkhir);
  const kaki = await h.js('(function(){var f=document.querySelector(".tbl-footer"),i=document.getElementById("tblInfo").getBoundingClientRect(),'
    + 'p=document.getElementById("perHalaman").getBoundingClientRect(),g=document.getElementById("pagination").getBoundingClientRect();'
    + 'return {dalam:f.contains(document.getElementById("perHalaman")),sebaris:Math.abs((i.top+i.bottom)/2-(p.top+p.bottom)/2)<12,'
    + 'kananInfo:p.left>=i.right-1,kiriHal:p.right<=g.left+1};})()');
  ok(kaki.dalam && kaki.sebaris && kaki.kananInfo && kaki.kiriHal,
     'pemilih berada di kaki tabel, sebaris, di antara keterangan jumlah dan nomor halaman — ' + JSON.stringify(kaki));
  await h.potret('perhalaman-1-bawaan');

  // ══ 2. Memilih — tanpa permintaan apa pun ══
  for (const [n, hal] of [[40, 4], [60, 3], [100, 2]]) {
    const np = h.permintaan.length, nb = h.bacaan.length, nc = h.catatan.length;
    await pilih(n);
    await h.tidur(400);
    s = await lihat();
    ok(s.baris === n && s.nyala === String(n) && new RegExp('^Showing 1–' + n + ' of 130 devices$').test(s.info),
       'pilih ' + n + ' → ' + n + ' baris, tombol menyala, keterangan cocok — ' + JSON.stringify(s));
    ok(s.halAkhir === hal, 'pilih ' + n + ' → ' + hal + ' halaman — ' + s.halAkhir);
    ok(h.permintaan.length === np && h.bacaan.length === nb && h.catatan.length === nc,
       'pilih ' + n + ' → nol permintaan ke panel, nol baca ke GenieACS, nol perintah — '
       + JSON.stringify(h.permintaan.slice(np).map(r => r.metode + ' ' + r.url)));
  }
  await h.potret('perhalaman-2-seratus', { penuh: true });

  // ══ 3. Diingat sesudah dimuat ulang ══
  await pilih(40);
  await buka();
  s = await lihat();
  ok(s.baris === 40 && s.nyala === '40', 'sesudah dimuat ulang tetap 40 baris — ' + JSON.stringify(s));
  ok(!h.permintaan.some(r => r.metode !== 'GET' && !/\/auth\/(login|logout)/.test(r.url)),
     'tidak ada permintaan tulis ke panel selama uji — '
     + JSON.stringify(h.permintaan.filter(r => r.metode !== 'GET').map(r => r.metode + ' ' + r.url)));

  // ══ 4. Tetap di ONU yang sedang dilihat ══
  await h.js('goPage(2)'); await h.tidur(300);
  s = await lihat();
  const sn41 = s.pertama;
  ok(/^Showing 41–80 of/.test(s.info) && !!sn41, 'halaman 2 dari 40-an = baris 41–80 — ' + s.info);
  await pilih(20); await h.tidur(300);
  s = await lihat();
  ok(/^Showing 41–60 of/.test(s.info) && s.pertama === sn41, 'ganti ke 20 → tetap mulai dari ONU yang sama (baris 41) — ' + s.info + ' / ' + s.pertama);
  await pilih(100); await h.tidur(300);
  s = await lihat();
  ok(/^Showing 1–100 of/.test(s.info) && s.baris === 100, 'ganti ke 100 → halaman yang memuat baris 41 (1–100) — ' + s.info);

  // Fokus papan ketik tidak hilang: Tab ke tombol → Enter membangun ulang tombol-tombolnya.
  const fk = await h.js('(function(){var b=document.querySelector(\'#perHalaman .pp-btn[data-n="60"]\');b.focus();b.click();'
    + 'var a=document.activeElement;return {di:!!a&&a.classList.contains("pp-btn"),n:a?a.textContent:"",tekan:a?a.getAttribute("aria-pressed"):""};})()');
  ok(fk.di && fk.n === '60' && fk.tekan === 'true', 'sesudah memilih lewat papan ketik, fokus tetap di tombol yang menyala — ' + JSON.stringify(fk));

  // Layar pas-pasan (1024px): dua baris tetap, nomor halaman menempel di kanan di halaman
  // mana pun — tombol ">" tidak berpindah tempat saat halaman diganti.
  await h.ukuran(1024, 700, false); await h.tidur(400);
  await pilih(20); await h.tidur(300);
  const tepi = () => h.js('(function(){var f=document.querySelector(".tbl-footer"),g=document.getElementById("pagination").getBoundingClientRect(),'
    + 'i=document.getElementById("tblInfo").getBoundingClientRect(),c=getComputedStyle(f);'
    + 'return {sela:Math.round(f.getBoundingClientRect().right-parseFloat(c.paddingRight)-parseFloat(c.borderRightWidth)-g.right),bawah:g.top>=i.bottom-1};})()');
  await h.js('goPage(1)'); await h.tidur(250);
  const t1 = await tepi();
  await h.js('goPage(4)'); await h.tidur(250);
  const t4 = await tepi();
  ok(Math.abs(t1.sela) <= 1 && Math.abs(t4.sela) <= 1 && t1.bawah && t4.bawah,
     '1024px: nomor halaman di baris kedua, menempel di kanan di halaman 1 maupun 4 — ' + JSON.stringify([t1, t4]));
  await h.potret('perhalaman-4-1024');
  await h.ukuran(1440, 900, false); await h.tidur(300);
  await pilih(100); await h.tidur(300);

  // ══ 5. Role user ══
  await h.masuk(h.akun.user);
  await buka();
  s = await lihat();
  ok(s.tombol === '20,40,60,100' && s.baris === 100, 'role user: pemilih tampil; pilihan browser ini (100) tetap berlaku — ' + JSON.stringify(s));
  await pilih(60); await h.tidur(300);
  s = await lihat();
  ok(s.baris === 60 && s.nyala === '60', 'role user bisa mengganti jumlah baris — ' + JSON.stringify(s));
  ok(!h.permintaan.some(r => r.status === 403), 'tidak ada permintaan yang ditolak (403) saat role user memakainya');

  // ══ 6. Layar HP ══
  await h.ukuran(390, 844, true);
  await buka();
  const hp = await h.js('(function(){var f=document.querySelector(".tbl-footer"),l=document.documentElement.clientWidth;'
    + 'var luar=[].filter.call(f.querySelectorAll("*"),function(e){var r=e.getBoundingClientRect();return r.width>0&&(r.right>l+1||r.left<-1);}).length;'
    + 'return {lebar:l,meluap:f.scrollWidth-f.clientWidth,luar:luar,tombol:document.querySelectorAll("#perHalaman .pp-btn").length};})()');
  ok(hp.tombol === 4 && hp.meluap <= 1 && hp.luar === 0, 'HP 390px: kaki tabel tidak meluap, tak ada elemen keluar layar — ' + JSON.stringify(hp));
  await pilih(20); await h.tidur(300);
  s = await lihat();
  ok(s.baris === 20 && s.nyala === '20', 'HP: tombol bisa ditekan — ' + JSON.stringify(s));
  await h.js('(function(){var c=document.getElementById("contentArea");if(c)c.scrollTop=c.scrollHeight;window.scrollTo(0,document.body.scrollHeight);return 1;})()');
  await h.tidur(300);
  await h.potret('perhalaman-3-hp');

  await h.js('(function(){try{localStorage.removeItem("devPerHalaman");}catch(e){}return 1;})()');
  ok(h.galat.length === 0, 'tidak ada galat JavaScript di halaman' + (h.galat.length ? ': ' + String(h.galat[0]).split('\n')[0] : ''));
  console.log('perhalaman-tampilan: ' + lulus + ' lulus, ' + gagal + ' gagal');
  if (gagal) throw new Error(gagal + ' pemeriksaan gagal');
};
