// Uji aksi massal pada tabel Device.
//
// Ini berjalan di mesin PRODUKSI dengan ~1800 ONU pelanggan, jadi yang diuji
// bukan cuma "jalan", tapi PAGAR-nya: batas konkurensi supaya ACS tidak
// dibanjiri, kegagalan satu ONU tidak menggagalkan sisanya, dan penghapusan
// hanya membuang ONU yang benar-benar dikonfirmasi server.
const fs = require('fs');
const path = require('path');
const load = (f) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', f), 'utf8');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

// ── Muat devices.js asli dengan global browser di-stub ──
const confirms = [];   // setiap showConfirm yang dipanggil ditangkap di sini
const toasts = [];
const stub = `
  var PAGE_INIT = {}; var PAGE_ACTIONS = {}; var PALETTE = ['#000'];
  function escHtml(s){ return String(s == null ? '' : s); }
  function showToast(m, t){ _TOASTS.push({ msg: m, type: t }); }
  function showConfirm(o, cb){ _CONFIRMS.push(o); o._run = cb; }
  function setBtnBusy(){} function exportStamp(){ return 'S'; } function downloadCSV(){}
  function navigateTo(){}
  var CSS = { escape: (s) => s };
  // Elemen di-cache per id supaya tes bisa memeriksa hidden/disabled/teks —
  // stub yang mengembalikan objek baru tiap panggilan akan menelan semuanya.
  var _els = _ELS;
  function _el(){ return { style:{}, _cls:{},
                          classList:{ toggle(c,v){ this._on = this._on||{}; this._on[c]=!!v; },
                                      add(c){ this._on = this._on||{}; this._on[c]=true; },
                                      remove(c){ this._on = this._on||{}; this._on[c]=false; } },
                          setAttribute(){}, closest(){ return null; }, hidden:false,
                          querySelector(){ return null; }, querySelectorAll(){ return []; },
                          addEventListener(){}, appendChild(){}, remove(){},
                          textContent:'', innerHTML:'', dataset:{},
                          checked:false, indeterminate:false, disabled:false }; }
  var document = {
    getElementById: (id) => (_els[id] = _els[id] || _el()),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => _el(),
    body: { appendChild(){} },
  };
  var App = _APP; var ACS = _ACS;
`;

// ACS palsu: kita kendalikan penuh siapa yang sukses & siapa yang gagal.
const calls = { summon: [], reboot: [], del: [] };
let inFlight = 0, maxInFlight = 0;
const track = (arr, id, shouldFail) => new Promise((res, rej) => {
  arr.push(id);
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  setTimeout(() => { inFlight--; shouldFail ? rej(new Error('gagal ' + id)) : res(); }, 5);
});
const FAIL_IDS = new Set(['d3']);
const fakeACS = {
  rxThr: () => ({ good: -20, fair: -25 }),
  getConfig: () => ({ perPage: 20 }),
  summon: (id) => track(calls.summon, id, FAIL_IDS.has(id)),
  rebootSmart: (d) => track(calls.reboot, d.id, FAIL_IDS.has(d.id)),
  deleteDevice: (id) => track(calls.del, id, FAIL_IDS.has(id)),
  loadAll: () => Promise.resolve(),
  getStats: () => ({ rx: {}, offline: 0 }),
};

const els = {};
const M = new Function('_APP', '_ACS', '_CONFIRMS', '_TOASTS', '_ELS',
  stub + load('devices.js') +
  '\n; return { _runBatch, _sel, _selDevices, bulkDelete, bulkReboot, bulkRefresh, setSelectMode, syncSelectionUI };'
)(globalThis.App = {}, fakeACS, confirms, toasts, els);

const mkDev = (i) => ({
  id: 'd' + i, serial: 'SN' + i, model: 'M', mfr: 'V', ponMode: 'GPON',
  rx: '-15', temp: 30, online: i % 2 === 0, registeredRaw: '',
});
const fleet = Array.from({ length: 6 }, (_, i) => mkDev(i + 1));

function reset() {
  App.devices = fleet.slice();
  App.rawDevices = fleet.map(d => ({ _id: d.id }));
  App.deviceFilters = {}; App.deviceSearch = ''; App.devicePage = 1; App.devicePerPage = 20;
  App.selectedDevices = new Set();
  confirms.length = 0; toasts.length = 0;
  calls.summon.length = 0; calls.reboot.length = 0; calls.del.length = 0;
  inFlight = 0; maxInFlight = 0;
}

(async () => {
  // ── Panel mengikuti tombol Pilih, bukan jumlah yang dicentang ──
  reset();
  M.setSelectMode(false);
  ok(els.bulkBar.hidden === true, 'mode Pilih mati → panel tidak tampil');

  M.setSelectMode(true);
  ok(els.bulkBar.hidden === false, 'tekan Pilih → panel langsung tampil walau 0 dicentang');
  ok(els.bulkSub.textContent === 'Centang ONU pada tabel', 'panel memandu saat masih kosong');
  ok(els.bulkRefresh.disabled && els.bulkReboot.disabled && els.bulkDelete.disabled,
     'tanpa pilihan → tombol aksi mati (tak bisa diklik tanpa sasaran)');
  ok(els.bulkAll.disabled === false, '"Semua" tetap hidup — itu jalan dari nol ke terpilih');

  M._sel().add('d1'); M.syncSelectionUI();
  ok(!els.bulkRefresh.disabled && !els.bulkDelete.disabled, 'ada pilihan → tombol aksi hidup');
  ok(/online/.test(els.bulkSub.textContent), 'panel menampilkan rincian online/offline');

  M.setSelectMode(false);
  ok(els.bulkBar.hidden === true, 'tekan Pilih lagi → panel hilang sepenuhnya');
  ok(M._sel().size === 0, 'keluar mode Pilih mengosongkan seleksi');

  // ── _runBatch: menghormati batas konkurensi ──
  reset();
  let peak = 0, live = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await M._runBatch(items, () => new Promise(r => {
    live++; peak = Math.max(peak, live);
    setTimeout(() => { live--; r(); }, 4);
  }), 3);
  ok(peak <= 3, 'konkurensi tidak melebihi batas (puncak=' + peak + ', batas=3)');
  ok(peak > 1, 'tetap paralel, bukan serial satu-satu (puncak=' + peak + ')');

  // ── _runBatch: semua item tetap diproses walau ada yang gagal ──
  const seen = [];
  const r1 = await M._runBatch([1, 2, 3, 4, 5], (n) => {
    seen.push(n);
    return n === 3 ? Promise.reject(new Error('x')) : Promise.resolve();
  }, 2);
  ok(seen.length === 5, 'satu kegagalan tidak menghentikan sisanya (diproses=' + seen.length + '/5)');
  ok(r1.ok === 4 && r1.failed === 1, 'hitungan ok/gagal benar (' + r1.ok + '/' + r1.failed + ')');
  ok(r1.errors.length === 1 && /x/.test(r1.errors[0].error), 'pesan error terkumpul');

  // ── Bulk delete: hanya membuang yang dikonfirmasi server ──
  reset();
  ['d1', 'd2', 'd3'].forEach(id => M._sel().add(id));   // d3 disetel gagal
  M.bulkDelete();
  ok(confirms.length === 1, 'delete memunculkan konfirmasi');
  const cd = confirms[0];
  ok(cd.requireText === 'HAPUS', 'delete mewajibkan ketik "HAPUS" (dapat: ' + cd.requireText + ')');
  ok(cd.danger === true, 'delete ditandai danger');
  ok(/TIDAK DAPAT DIBATALKAN/.test(cd.message), 'delete menyatakan tidak dapat dibatalkan');
  ok(/tidak direset dan tidak direboot/.test(cd.message), 'delete menegaskan ONU fisik tidak direboot/reset');

  cd._run();                                  // pengguna menekan konfirmasi
  await new Promise(r => setTimeout(r, 80));
  ok(calls.del.length === 3, 'delete dikirim untuk 3 ONU terpilih');
  const ids = App.devices.map(d => d.id);
  ok(!ids.includes('d1') && !ids.includes('d2'), 'yang sukses dibuang dari daftar');
  ok(ids.includes('d3'), 'yang GAGAL tetap ada di daftar (tidak dibuang diam-diam)');
  ok(App.rawDevices.every(x => x._id !== 'd1'), 'rawDevices ikut dibersihkan');
  ok(M._sel().has('d3') && !M._sel().has('d1'), 'seleksi menyisakan yang gagal saja');

  // ── Bulk reboot: pagar konfirmasi ──
  reset();
  ['d1', 'd2', 'd4'].forEach(id => M._sel().add(id));
  M.bulkReboot();
  const cr = confirms[0];
  ok(cr.requireText === 'REBOOT', 'reboot mewajibkan ketik "REBOOT"');
  ok(/koneksi internet pelanggan terputus/.test(cr.message), 'reboot menjelaskan dampak ke pelanggan');
  ok(/2 ONU dalam keadaan ONLINE/.test(cr.message), 'reboot menyebut jumlah ONU online yang terdampak');
  cr._run();
  await new Promise(r => setTimeout(r, 80));
  ok(calls.reboot.length === 3, 'reboot dikirim ke 3 ONU terpilih');
  ok(maxInFlight <= 3, 'reboot dibatasi <=3 bersamaan (puncak=' + maxInFlight + ')');

  // ── Bulk refresh: TIDAK boleh minta ketik & tidak boleh mengaku reboot ──
  reset();
  ['d1', 'd2'].forEach(id => M._sel().add(id));
  M.bulkRefresh();
  const cf = confirms[0];
  ok(!cf.requireText, 'refresh tidak perlu ketik ulang (aksinya tidak merusak)');
  ok(!cf.danger, 'refresh tidak ditandai danger');
  ok(/tidak mereboot/.test(cf.message), 'refresh menegaskan tidak mereboot');
  cf._run();
  await new Promise(r => setTimeout(r, 60));
  ok(calls.summon.length === 2, 'refresh dikirim ke 2 ONU terpilih');

  // ── Seleksi tidak ikut terhapus/terkirim untuk ONU yang tak dipilih ──
  reset();
  M._sel().add('d5');
  M.bulkDelete(); confirms[0]._run();
  await new Promise(r => setTimeout(r, 60));
  ok(calls.del.length === 1 && calls.del[0] === 'd5', 'hanya ONU terpilih yang disentuh');

  console.log(`bulk: ${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
