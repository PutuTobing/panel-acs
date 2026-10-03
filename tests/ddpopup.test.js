#!/usr/bin/env node
/* Uji pop-up halaman Detail ONU, laporan pelanggan, dan pintu masuk halaman detail
 * (2026-10-03).
 *
 * LATAR: form Edit/Tambah WAN, Konfigurasi SSID dan Channel & Bandwidth dipindah dari
 * dalam tab ke pop-up. Fungsi form sengaja TIDAK diubah — yang berpindah hanya tempat
 * ia digambar. Uji ini menjaga sambungan-sambungan yang membuat itu aman:
 *   1. _popKeAsal(): alur simpan/batal yang memanggil _renderWanTab()/renderSsidTab()
 *      dengan wadah pop-up harus berakhir menggambar di TAB ASAL.
 *   2. _popTutup(wadah) hanya menutup pop-up milik wadah itu (panggilan telat dari form
 *      lama tak boleh menutup form lain yang baru dibuka).
 *   3. Nilai form Tambah WAN ditangkap SEBELUM perintah pertama dikirim.
 *   4. Laporan pelanggan: isinya dari data yang ada, tanpa kredensial, tanpa perintah.
 *   5. Halaman detail selalu menampilkan perangkat yang DIMINTA (bukan salinan lama).
 *
 * Perilaku di browser sungguhan (pop-up terbuka, HP, escape teks) dijaga
 * tests/tampilan.test.js.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const baca = (...p) => fs.readFileSync(path.join(ROOT, 'frontend', ...p), 'utf8');
const dd   = baca('js', 'device-detail.js');
const main = baca('js', 'main.js');
const css  = baca('css', 'device-detail.css');
const base = baca('css', 'base.css');
const html = baca('pages', 'device-detail.html');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
const stripJs  = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripCss = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const ddC = stripJs(dd), cssC = stripCss(css);
const iris = (src, n) => {
  const i = src.search(new RegExp('(async\\s+)?function ' + n + '\\('));
  if (i < 0) return '';
  let j = src.indexOf('{', src.indexOf(')', i)), k = 0;
  for (; j < src.length; j++) { if (src[j] === '{') k++; else if (src[j] === '}' && --k === 0) break; }
  return src.slice(i, j + 1);
};

// ══ 1. Sambungan pop-up ↔ tab asal ══
{
  const dibuang = [];
  const ctx = { _popLapis: null, document: { body: { contains: () => false }, removeEventListener() {} },
                setTimeout: f => f(), showToast: m => dibuang.push(m) };
  vm.createContext(ctx);
  vm.runInContext('var _popLapis = null;\n' + iris(dd, '_popTutup') + '\n' + iris(dd, '_popKeAsal'), ctx);
  const tab = { nama: 'tab' };
  ok(ctx._popKeAsal(tab) === tab, 'kontainer tab biasa dikembalikan apa adanya');
  ok(ctx._popKeAsal(null) === null, 'null tidak melempar galat');

  const lapis = (wadah, sibuk) => { const l = { _wadah: wadah, dilepas: false, querySelector: () => (sibuk ? {} : null),
    cloneNode() { throw new Error('tanpa DOM'); }, parentNode: { removeChild() { l.dilepas = true; } } }; return l; };
  const w1 = { _popAsal: tab }, w2 = { _popAsal: tab };
  let L = lapis(w1);
  vm.runInContext('_popLapis = L', Object.assign(ctx, { L }));
  ok(ctx._popKeAsal(w1) === tab && L.dilepas && vm.runInContext('_popLapis', ctx) === null,
     'wadah pop-up → pop-up ditutup, tab asal dikembalikan');
  ok(ctx._popKeAsal(w1) === tab, 'wadah yang pop-upnya sudah tertutup tetap mengarah ke tab asal');

  L = lapis(w2);
  vm.runInContext('_popLapis = L', Object.assign(ctx, { L }));
  ok(ctx._popKeAsal(w1) === tab && !L.dilepas && vm.runInContext('_popLapis', ctx) === L,
     'panggilan telat dari form LAMA tidak menutup pop-up form lain');
  ctx._popTutup(w2);
  ok(L.dilepas && dibuang.length === 0, 'menutup lewat alur simpan tidak memunculkan toast "perintah tetap berjalan"');
  L = lapis(w2, true);
  vm.runInContext('_popLapis = L', Object.assign(ctx, { L }));
  ctx._popTutup(w2, true);
  ok(dibuang.length === 1 && /tetap berjalan/.test(dibuang[0]),
     'ditutup OPERATOR selagi mengirim → diberi tahu perintahnya tetap berjalan');

  ok(/^function _renderWanTab\(d, container\) \{\s*(\/\/[^\n]*\n\s*)*container = _popKeAsal\(container\);/m.test(dd),
     '_renderWanTab memulai dengan _popKeAsal');
  ok(/^function renderSsidTab\(d, container\) \{\s*(\/\/[^\n]*\n\s*)*container = _popKeAsal\(container\);/m.test(dd),
     'renderSsidTab memulai dengan _popKeAsal');
  ok(/_wanShowEdit\(d, conn, semua, _popBuka\(container, /.test(ddC), 'Edit/Tambah WAN dibuka lewat _popBuka');
  ok(/_ssidShowConfig\(d, ssid, _popBuka\(container, /.test(ddC), 'Konfigurasi SSID dibuka lewat _popBuka');
  ok(/_ssidShowConfig\(nd, ns, _popBuka\(container, /.test(ddC), 'slot SSID yang baru diaktifkan juga dibuka di pop-up');
  const fb = iris(dd, '_popBuka');
  ok(/if \(typeof document === 'undefined' \|\| !document\.body \|\| !document\.createElement\) return asal;/.test(fb),
     'tanpa DOM utuh, form tetap digambar di kontainer asal (uji lain bergantung pada ini)');
  ok(!/'click'[\s\S]{0,80}e\.target === lapis[\s\S]{0,60}_popTutup/.test(stripJs(fb)) && /pop-goyang/.test(fb),
     'klik latar tidak menutup form — hanya isyarat goyang');
  const ft = iris(dd, '_popTutup');
  ok(/removeAttribute\('id'\)/.test(ft) && /replaceChild\(hantu, lapis\)/.test(ft),
     'bayangan penutup tidak membawa id isian (form berikutnya memakai id yang sama)');
  ok(/if \(_popLapis\) \{\s*_popTutup\(\);/.test(stripJs(iris(dd, 'renderConfigPanel'))),
     'halaman digambar ulang → form pop-up yang masih terbuka ditutup (tak menimpa nilai terbaru)');
  ok(/_popTutup\(\); _lapTutup\(\); _fotoTutup\(\);/.test(ddC.slice(ddC.indexOf("PAGE_TEARDOWN['device-detail']"))),
     'meninggalkan halaman menutup semua lapisan');
}

// ══ 2. Form: id isian tetap, nilai ditangkap sebelum kirim ══
{
  const f = iris(dd, '_wanShowEditForm');
  ['wanBackBtn', 'wanSaveBtn', 'wanSaveStatus', 'wanVlanMode', 'wanVlanId', 'wanIpMode', 'wanCos', 'wanNat', 'wanMtu',
   'wanPppUser', 'wanPppPass', 'wanPppConnType', 'wanIpv6Section', 'wanIpv6PrefixOrigin', 'wanIpv6AddrOrigin',
   'wanIpv6Dns', 'wanIpAddrType', 'wanConnType', 'wanDhcpEnable', 'wanExtraFields', 'wanPppFields', 'wanIpFields']
    .forEach(id => ok(f.indexOf('id="' + id + '"') >= 0, 'form WAN masih memuat #' + id));
  ok(/class="wan-lan-inp" data-ifpath="/.test(f), 'checkbox binding tetap .wan-lan-inp ber-data-ifpath');
  ok(!/wanPppSvcName/.test(stripJs(f)), 'isian mati "Service Name" sudah dibuang dari form');
  ok(/snEl\s*\?\s*snEl\.value\.trim\(\)\s*:\s*''/.test(iris(dd, '_wanHandleSave')),
     '_wanHandleSave tetap aman tanpa isian Service Name (null → tidak dikirim)');

  const c = stripJs(iris(dd, '_wanDoCreate'));
  const iNilai = c.indexOf("document.getElementById('wanPppUser')"), iKirim = c.indexOf('ACS.addObject(');
  ok(iNilai > 0 && iKirim > 0 && iNilai < iKirim,
     'Tambah WAN: username/password PPPoE ditangkap SEBELUM addObject dikirim');
  ok(c.indexOf("getElementById('wanPppUser')", iKirim) < 0, 'tidak ada pembacaan form sesudah perintah dikirim');
  const w = stripJs(iris(dd, '_wanDoCreateNewWcd'));
  ok(w.indexOf("document.getElementById('wanPppUser')") < w.indexOf('ACS.addObject('),
     'Tambah WAN (WCD baru): nilai form juga ditangkap lebih dulu');
  ok(/_renderWanTab\(ndErr, \(container && container\._popAsal\) \|\| container\)/.test(w),
     'gagal membuat WAN → daftar disegarkan di tab asal, pesan galat tetap terbaca di pop-up');

  ['btnSsidBack', 'btnSsidSave', 'ssidSaveStatus', 'scSSID', 'scAuthType', 'scPass', 'scPassGroup', 'btnShowPass']
    .forEach(id => ok(iris(dd, '_ssidShowConfig').indexOf('id="' + id + '"') >= 0, 'form SSID masih memuat #' + id));
  ['btnRadioBack', 'btnRadioSave', 'radioSaveStatus']
    .forEach(id => ok(iris(dd, '_radioShowConfig').indexOf('id="' + id + '"') >= 0, 'form radio masih memuat #' + id));
  ok(/<div class="radio-note lebar"><i class="fas fa-circle-info"><\/i><span>/.test(iris(dd, '_radioShowConfig')),
     'teks catatan radio dibungkus satu <span> (tidak terbelah oleh flex)');
}

// ══ 3. Gaya pop-up ══
{
  const z = (s, sel) => { const m = new RegExp(sel.replace(/[.]/g, '\\.') + '\\s*\\{[^}]*z-index:\\s*(\\d+)').exec(s); return m ? +m[1] : null; };
  const zPop = z(cssC, '.pop-lapis'), zModal = z(stripCss(base), '.modal-overlay');
  ok(zPop !== null && zModal !== null && zPop < zModal,
     'pop-up form (' + zPop + ') di BAWAH dialog konfirmasi (' + zModal + ') — "Ubah WAN TR069?" harus tampil di atas form');
  ok(z(cssC, '.lap-lapis') < zModal && z(cssC, '.foto-lapis') < zModal, 'laporan & foto juga di bawah dialog konfirmasi');
  ok(/\.pop-badan\s*\{[^}]*overflow-y:\s*auto/.test(cssC) && /\.pop-kaki\s*\{[^}]*flex:\s*none/.test(cssC),
     'hanya badan form yang menggulir; kaki (tombol Simpan) selalu terlihat');
  ok(/@media \(max-width: 640px\)[\s\S]*?\.pop-lapis\s*\{[^}]*align-items:\s*flex-end/.test(cssC),
     'di HP pop-up menempel di bawah layar');
  ok(/\.pop-blok\s*\{\s*display:\s*contents/.test(cssC), 'pembungkus isian ikut kisi induk (display: contents)');
  // Semua grid-template-areas di berkas ini milik .dd-body (dijaga ddresponsive.test.js):
  // hero & pop-up tidak boleh menambah yang baru.
  ok((cssC.match(/grid-template-areas/g) || []).length === 3, 'tidak ada grid-template-areas baru di luar .dd-body');
  ok(!/backdrop-filter/.test(cssC), 'tanpa backdrop-filter');
  ok(/\.dd-right-panel\s*\{\s*flex-direction:\s*column;\s*align-items:\s*stretch/.test(cssC),
     'HP: kartu rel kanan melebar penuh (dulu menyusut selebar isinya)');
  ok(/id="btnLaporanDevice"/.test(html) && html.indexOf('btnLaporanDevice') < html.indexOf('btnRemoteDevice'),
     'tombol Laporan ada di hero, di kiri Remote (Reboot tetap paling kanan)');
}

// ══ 4. Laporan pelanggan ══
{
  const ctx = { console, ACS: { rxThr: () => ({ good: -20, fair: -25 }) },
                ontPhotoUrl: (m) => (m === 'F663NV9' ? '/pages/gambar/F663NV9.PNG' : null),
                generateConnectionGroups: null, is5GHz: null };
  vm.createContext(ctx);
  vm.runInContext(['is5GHz', 'generateConnectionGroups', '_esc', '_uptimeDetik', '_durasiRingkas', '_lapData', '_lapKlien',
                   '_lapHtml', '_lapTeks'].map(n => iris(dd, n)).join('\n'), ctx);

  ok(ctx._uptimeDetik('3d 05:12:40') === 277960 && ctx._uptimeDetik('05:12:40') === 18760 && ctx._uptimeDetik(90) === 90
     && ctx._uptimeDetik('—') === null && ctx._uptimeDetik('entah') === null, '_uptimeDetik: teks VP & detik');
  ok(ctx._durasiRingkas(277960) === '3 hari 5 jam' && ctx._durasiRingkas(18760) === '5 jam 12 menit'
     && ctx._durasiRingkas(125) === '2 menit' && ctx._durasiRingkas(20) === 'kurang dari 1 menit'
     && ctx._durasiRingkas(0) === '—', '_durasiRingkas: dua satuan terbesar');

  const d = {
    id: 'AA11BB-F663NV9-SNUJI1', model: 'F663NV9', mfr: 'ZTE', serial: 'SNUJI1', online: true, lastInform: '2 menit lalu',
    rx: '-18.42', temp: 48, ip: '10.99.1.25', uptime: '3d 05:12:40', pppUptime: '1d 02:03:04',
    ponMac: 'AA:11:BB:00:10:01', pppoeMac: 'AA:11:BB:00:10:02', iptr069: '10.98.0.25',
    pppoe: 'rahasia-user@sky', pppoePass: 'RAHASIA-PPPOE', wlanPass: 'RAHASIA-WIFI', aktifDevice: 4,
    wanConnections: [{ type: 'ppp', uptime: 93784, username: 'rahasia-user@sky' }],
    ssids: [{ idx: 1, name: 'RUMAH <b>UJI</b>', enabled: true, channel: 6, associations: 3, password: 'RAHASIA-SSID' },
            { idx: 2, name: 'TAMU', enabled: false, channel: 6, associations: 0 }],
    hostList: [{ name: 'HP-<script>x</script>', ip: '192.168.1.3', mac: 'DE:AD:BE:00:00:01', type: '802.11', hostIdx: 1 },
               { name: 'Laptop', ip: '192.168.1.4', mac: 'DE:AD:BE:00:00:02', type: '802.11', hostIdx: 2 },
               { name: '—', ip: '192.168.1.5', mac: 'DE:AD:BE:00:00:03', type: '802.11', hostIdx: 3 },
               { name: 'TV', ip: '192.168.1.6', mac: 'DE:AD:BE:00:00:04', type: 'Ethernet', hostIdx: 4 }],
  };
  const L = ctx._lapData(d, new Date(2026, 9, 3, 5, 20));
  ok(L.model === 'F663NV9' && L.online === true && L.sn === 'SNUJI1' && L.mac === 'AA:11:BB:00:10:01', 'identitas perangkat');
  ok(L.rx === -18.42 && L.rxMutu.teks === 'Baik' && L.suhu === 48 && L.suhuMutu.teks === 'Normal', 'RX & suhu beserta mutunya');
  ok(L.ip === '10.99.1.25' && L.uptime === '3 hari 5 jam' && L.uptimeLabel === 'Uptime Perangkat' && L.sesi === '1 hari 2 jam',
     'IP PPPoE, uptime perangkat, lama sesi');
  ok(L.blok.length === 2 && L.blok[0].nama === 'RUMAH <b>UJI</b>' && L.blok[0].jumlah === 3 && L.blok[0].klien.length === 3
     && L.blok[1].jenis === 'lan' && L.blok[1].klien.join() === 'TV', 'WiFi aktif + LAN; SSID nonaktif tidak ikut');
  ok(L.total === 4, 'jumlah perangkat = jumlah di kartu Perangkat Terhubung');
  const k = ctx._lapKlien(L.blok[0]);
  ok(k.nama.length === 2 && k.tanpaNama === 1, 'perangkat tanpa nama dihitung terpisah');

  const semua = JSON.stringify(L) + ctx._lapHtml(L) + ctx._lapTeks(L);
  ok(!/RAHASIA/.test(semua), 'password WiFi/PPPoE TIDAK PERNAH masuk laporan');
  ok(!/rahasia-user/.test(semua), 'username PPPoE tidak masuk laporan');
  ok(!/10\.98\.0\.25/.test(semua) && !/192\.168\.1\./.test(semua) && !/DE:AD:BE/.test(semua),
     'IP TR-069 serta IP/MAC perangkat pelanggan tidak masuk laporan');
  const h = ctx._lapHtml(L);
  ok(!/<script>x<\/script>/.test(h) && /HP-&lt;script&gt;/.test(h) && /RUMAH &lt;b&gt;UJI&lt;\/b&gt;/.test(h),
     'nama WiFi & hostname di-escape di HTML laporan');
  ok(/Laporan Kondisi Perangkat/.test(h) && /lap-status on/.test(h) && !/lap-catatan/.test(h), 'kartu online tanpa peringatan');
  const t = ctx._lapTeks(L);
  ok(/RX Power\s*: -18\.42 dBm \(Baik\)/.test(t) && /SN\s*: SNUJI1/.test(t) && /RUMAH <b>UJI<\/b> \(2\.4 GHz\) terhubung 3 perangkat:/.test(t),
     'versi teks memuat angka yang sama');
  // Bentuk daftar mengikuti contoh operator (2026-10-03): nama perangkat bernomor, satu per baris.
  ok(/terhubung 3 perangkat:\n\nberikut informasi nama perangkat\n1\. HP-<script>x<\/script>\n2\. Laptop\n3\. tanpa nama\n\n- Kabel LAN \(Ethernet\) terhubung 1 perangkat:/.test(t),
     'teks Salin: daftar nama bernomor, "tanpa nama" ikut dinomori, antar-SSID dipisah baris kosong');
  ok(!/,\s*$/m.test(t.split('WiFi &')[1]), 'teks Salin: tanpa koma menggantung di ujung baris');

  const off = ctx._lapData(Object.assign({}, d, { online: false, rx: '—', temp: 0, uptime: '—', ssids: [], hostList: [] }));
  ok(off.rx === null && off.rxMutu === null && off.suhu === null, 'nilai tak terbaca → kosong, bukan angka palsu');
  ok(off.uptimeLabel === 'Lama Tersambung' && off.uptime === '1 hari 2 jam' && off.sesi === '',
     'tanpa uptime perangkat → lama sesi PPPoE, dengan label yang jujur');
  ok(/lap-status off/.test(ctx._lapHtml(off)) && /tidak terhubung/.test(ctx._lapHtml(off)), 'offline → peringatan data terakhir');
  ok(off.total === 4 && off.blok.length === 0, 'tanpa tabel host → jumlah dari penghitung ONU');

  const lemah = ctx._lapData(Object.assign({}, d, { rx: '-27.70', temp: 70 }));
  ok(lemah.rxMutu.teks === 'Lemah' && lemah.suhuMutu.teks === 'Panas', 'ambang RX dari pengaturan panel; suhu > 65 = Panas');
  const banyak = { jenis: 'wifi', nama: 'X', pita: '5 GHz', jumlah: 22, klien: Array.from({ length: 20 }, (_, i) => 'HP' + i) };
  const kb = ctx._lapKlien(banyak);
  ok(kb.nama.length === 14 && kb.lebih === 6 && kb.takTerdaftar === 2, 'daftar panjang dipangkas, sisanya disebut jumlahnya');

  // Membuka laporan tidak boleh mengirim apa pun.
  const lap = stripJs(iris(dd, '_lapData') + iris(dd, '_lapHtml') + iris(dd, '_lapTeks') + iris(dd, '_lapBuka')
                     + iris(dd, '_lapIsi') + iris(dd, '_lapKlik') + iris(dd, '_lapScreenshot') + iris(dd, '_lapGambar'));
  ok(!/ACS\.(?!rxThr)\w+/.test(lap) && !/fetch\(|postTask|setParam|summon/.test(lap),
     'laporan murni dari data di memori — tidak memanggil NBI sama sekali');
  ok(!/pppoePass|wlanPass|\.password|iptr069|pppoe\b/.test(lap), 'kode laporan tidak menyentuh field kredensial');
  // Dari menu Device (klik SN): satu GET dokumen dari basis data GenieACS, tak ada lainnya.
  const lbp = stripJs(iris(dd, '_lapBukaPerangkat'));
  ok(/ACS\.fetchDevice\(deviceId\)/.test(lbp) && !/ACS\.(?!fetchDevice)\w+/.test(lbp) && !/postTask|setParam|summon|refresh/.test(lbp),
     'laporan dari menu Device: hanya ACS.fetchDevice (data terakhir GenieACS), tanpa perintah ke ONU');
  const devJs = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'devices.js'), 'utf8');
  ok(/function showOntInfo\(el\)[\s\S]{0,120}_lapBukaPerangkat\(d\.id\)/.test(devJs)
     && !/id="modalOnt"/.test(fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8')),
     'klik SN membuka laporan; modal lama "Informasi ONT" sudah dibuang');
  // Screenshot: pustaka disimpan di panel (bukan CDN), gambar 1080 px, kartu 360×780.
  const h2c = path.join(ROOT, 'frontend', 'js', 'pustaka', 'html2canvas.min.js');
  ok(fs.existsSync(h2c) && /html2canvas 1\.4\.1/.test(fs.readFileSync(h2c, 'utf8').slice(0, 200)),
     'html2canvas 1.4.1 tersimpan di frontend/js/pustaka (tak bergantung CDN)');
  ok(/scale: 1080 \/ lebar/.test(iris(dd, '_lapGambar')) && /showSaveFilePicker/.test(iris(dd, '_lapScreenshot'))
     && /a\.download = nama/.test(iris(dd, '_lapScreenshot')), 'Screenshot: PNG 1080 px, simpan ke folder pilihan atau unduhan');
  ok(/\.lap-kartu \{[^}]*max-width: 360px;[^}]*min-height: 780px/.test(cssC), 'kartu laporan 360 × 780 (→ 1080 × 2340)');
}

// ══ 5. Teks dari perangkat di-escape ══
{
  const rg = iris(dd, 'renderConnectionGroups');
  ok(/_esc\(c\.name\)/.test(rg) && /_esc\(c\.ip\)/.test(rg) && /_esc\(c\.mac\)/.test(rg) && /_esc\(g\.name\)/.test(rg),
     'daftar Perangkat Terhubung: hostname, IP, MAC, nama SSID di-escape');
  ok(!/\$\{c\.name\}|\$\{c\.ip\}|\$\{c\.mac\}|\$\{g\.name\}/.test(rg), 'tidak ada lagi sisipan mentah ke innerHTML');
  const rh = iris(dd, 'renderHero');
  ok(/\$\{_esc\(t\)\}/.test(rh) && /\$\{_esc\(val\)\}/.test(rh), 'hero: tag & nilai metrik di-escape');
  ok(/const ipv4 = \/\^\\d\{1,3\}\(\\\.\\d\{1,3\}\)\{3\}\$\/\.test\(String\(val\)\)/.test(rh),
     'hero: tautan IP hanya dibuat untuk alamat IPv4 yang sah');
  const ri = iris(dd, 'renderDeviceInfo');
  ok(!/split\('@'\)\[0\]/.test(ri) && /escHtml\(d\.pppoe/.test(ri), 'Device Information: PPPoE user tampil LENGKAP & di-escape');
  ok(!/\$\{d\.(mfr|model|oui|hwVer|swVer|registered|tx|ponMode)\b/.test(ri), 'Device Information: nilai lewat t()/escHtml');
}

// ══ 6. Halaman detail selalu menampilkan perangkat yang diminta ══
{
  const semuaJs = ['main.js', 'devices.js', 'dashboard.js', 'device-detail.js'].map(f => stripJs(baca('js', f))).join('\n');
  ok(!/sessionStorage\.(setItem|getItem)\('currentDevice'/.test(semuaJs),
     'dokumen perangkat (berisi password WiFi/PPPoE) tidak lagi disalin ke sessionStorage');
  ok(/sessionStorage\.removeItem\('currentDevice'\)/.test(main), 'salinan lama di tab operator dibuang saat panel dimuat');
  ok(/bukaDetailPerangkat\(d\.id, d\)/.test(stripJs(baca('js', 'devices.js')))
     && /bukaDetailPerangkat\(d\.id, d\)/.test(stripJs(baca('js', 'dashboard.js'))),
     'daftar perangkat & dashboard memakai satu pintu yang sama');

  const log = [];
  let selesai = {};
  const ctx = { App: { currentPage: 'devices', currentDevice: null }, log,
    document: { getElementById: id => (id === 'page-device-detail' ? {} : (id === 'contentArea' ? { innerHTML: '' } : null)) },
    window: { location: { pathname: '/devices/B' } }, decodeURIComponent,
    navigateTo: (p, s) => { log.push('nav:' + p); ctx.App.currentPage = p; },
    initDeviceDetail: () => log.push('init:' + ctx.App.currentDevice.id),
    ACS: { fetchDevice: id => new Promise((ya, tidak) => { selesai[id] = { ya, tidak }; }) } };
  vm.createContext(ctx);
  vm.runInContext('let _detailToken = 0;\n' + iris(main, 'bukaDetailPerangkat') + '\n' + iris(main, 'bukaDetailDariUrl')
    + '\nfunction batalkan() { _detailToken++; }', ctx);
  const tik = () => new Promise(r => setImmediate(r));

  (async () => {
    // (a) buka A dari daftar, lalu cepat-cepat B → jawaban A yang terlambat dibuang
    ctx.bukaDetailPerangkat('A', { id: 'A', model: 'x' });
    ok(ctx.App.currentDevice.id === 'A' && ctx.App.currentDevice._ringkas === true, 'data ringkas daftar ditandai _ringkas');
    ctx.bukaDetailPerangkat('B', { id: 'B', model: 'x' });
    selesai.A.ya({ id: 'A', penuh: true }); await tik();
    ok(ctx.App.currentDevice.id === 'B', 'jawaban terlambat untuk ONU A TIDAK menimpa halaman ONU B');
    selesai.B.ya({ id: 'B', penuh: true }); await tik();
    ok(ctx.App.currentDevice.penuh === true && !ctx.App.currentDevice._ringkas && log[log.length - 1] === 'init:B',
       'dokumen lengkap B dipasang & halaman digambar ulang');

    // (b) alamat /devices/B dibuka saat memori masih berisi A → B yang dimuat
    log.length = 0; selesai = {};
    ctx.App.currentDevice = { id: 'A', penuh: true };
    ctx.bukaDetailDariUrl();
    ok(ctx.App.currentDevice === null && !!selesai.B && !selesai.A, 'alamat menunjuk B → A dibuang dari memori, B diambil dari ACS');
    selesai.B.ya({ id: 'B', penuh: true }); await tik();
    ok(ctx.App.currentDevice.id === 'B' && log.some(x => /^(nav:device-detail|init:B)$/.test(x)), 'yang tampil perangkat di alamat');

    // (c) operator pindah halaman sebelum jawaban tiba → tidak ditarik kembali
    log.length = 0; selesai = {};
    ctx.window.location.pathname = '/devices/C';
    ctx.App.currentDevice = null;
    ctx.bukaDetailDariUrl();
    ctx.batalkan();                       // navigateTo('dashboard') menaikkan token
    selesai.C.ya({ id: 'C' }); await tik();
    ok(log.length === 0 && ctx.App.currentDevice === null, 'pindah halaman membatalkan pemuatan detail yang tertunda');
    ok(/if \(page !== 'device-detail'\) _detailToken\+\+;/.test(iris(main, 'navigateTo')), 'navigateTo menaikkan token saat pindah halaman');

    // (d) perangkat tak ditemukan lewat alamat → kembali ke daftar
    log.length = 0; selesai = {};
    ctx.bukaDetailDariUrl();
    selesai.C.tidak(new Error('Device not found')); await tik();
    ok(log.join() === 'nav:devices', 'perangkat tak ada di ACS → kembali ke daftar, bukan halaman kosong');

    // Data ringkas tidak boleh menampilkan "tidak tersedia" yang keliru
    ok(/if \(d\._ringkas\) \{[\s\S]{0,400}Memuat konfigurasi/.test(iris(dd, 'renderConfigPanel')),
       'data ringkas → tab menampilkan "Memuat…", bukan "Data WAN tidak tersedia"');

    console.log(`ddpopup: ${pass} lulus, ${fail} gagal`);
    process.exit(fail ? 1 : 0);
  })();
}
