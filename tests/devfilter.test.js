// Uji paritas filter Device vs statistik Dashboard.
//
// Janji ke pengguna: klik "Excellent" di dashboard → menu Device menampilkan
// PERSIS sebanyak itu. Itu hanya benar bila bucket DIM_DEFS (js/devices.js)
// identik dengan perhitungan ACS.getStats() (js/api.js). Uji ini memuat KEDUA
// modul asli lalu membandingkan hitungannya pada armada sintetis.
const fs = require('fs');
const path = require('path');

const load = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
const ACS = new Function(load('api.js') + '\n; return ACS;')();

// devices.js hanya berisi deklarasi di level atas; sediakan global yang
// disentuhnya saat load (PAGE_INIT, PALETTE, escHtml) lalu ambil DIM_DEFS.
const stub = `
  var PAGE_INIT = {}; var PAGE_ACTIONS = {};
  var PALETTE = ['#000'];
  function escHtml(s){ return String(s == null ? '' : s); }
  var App = _APP; var ACS = _ACS;
`;
const { DIM_DEFS, getFilteredDevices } = new Function('_APP', '_ACS',
  stub + load('devices.js') + '\n; return { DIM_DEFS: DIM_DEFS, getFilteredDevices: getFilteredDevices };'
)(globalThis.App = {}, ACS);

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }

// ── Armada sintetis: RX/suhu/PON/registrasi yang menyentuh setiap batas ──
const day = 86400000;
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
const dev = (o) => Object.assign({
  serial: 'S', model: 'M', mfr: 'V', ponMode: 'GPON',
  rx: '-15.00', temp: 30, online: true, registeredRaw: ago(5 * day),
}, o);

const fleet = [
  dev({ rx: '-15.00' }),               // excellent
  dev({ rx: '-20.00' }),               // excellent (tepat di ambang good)
  dev({ rx: '-22.00' }),               // fair
  dev({ rx: '-25.00' }),               // fair (tepat di ambang fair)
  dev({ rx: '-27.00' }),               // poor
  dev({ rx: '—' }),                    // na
  dev({ temp: 60 }),                   // hot
  dev({ temp: 50 }),                   // warm
  dev({ temp: 45 }),                   // normal (tepat di batas, tidak > 45)
  dev({ temp: undefined }),            // normal (ONU tanpa sensor suhu)
  dev({ ponMode: 'EPON' }),
  dev({ ponMode: 'EPON', mfr: 'ZTEG', model: 'F663NV3A' }),
  dev({ registeredRaw: ago(2 * 3600e3) }),   // today
  dev({ registeredRaw: ago(1.5 * day) }),    // yesterday
  dev({ registeredRaw: ago(20 * day) }),     // month
  dev({ registeredRaw: ago(90 * day) }),     // older
  dev({ registeredRaw: '' }),                // belum pernah registered → older
  dev({ online: false, rx: '-30.00' }),      // offline + poor
];

// ── Paritas: getStats() vs DIM_DEFS untuk tiap dimensi ──
function countByBucket(dim) {
  const m = {};
  fleet.forEach(d => { const k = DIM_DEFS[dim].bucket(d); m[k] = (m[k] || 0) + 1; });
  return m;
}

App.devices = fleet;
const stats = ACS.getStats();

['excellent', 'fair', 'poor', 'na'].forEach(k => {
  const mine = countByBucket('rx')[k] || 0;
  ok(mine === stats.rx[k], `RX ${k}: filter=${mine} stats=${stats.rx[k]}`);
});
['normal', 'warm', 'hot'].forEach(k => {
  const mine = countByBucket('temp')[k] || 0;
  ok(mine === stats.temp[k], `Temp ${k}: filter=${mine} stats=${stats.temp[k]}`);
});
Object.keys(stats.ponMap).forEach(k => {
  const mine = countByBucket('pon')[k] || 0;
  ok(mine === stats.ponMap[k], `PON ${k}: filter=${mine} stats=${stats.ponMap[k]}`);
});
Object.keys(stats.prodMap).forEach(k => {
  const mine = countByBucket('model')[k] || 0;
  ok(mine === stats.prodMap[k], `Model ${k}: filter=${mine} stats=${stats.prodMap[k]}`);
});
['today', 'yesterday', 'week', 'month'].forEach(k => {
  const mine = countByBucket('reg')[k] || 0;
  ok(mine === stats.reg[k], `Reg ${k}: filter=${mine} stats=${stats.reg[k]}`);
});

// ── getFilteredDevices benar-benar menyaring sesuai App.deviceFilters ──
App.deviceSearch = '';
App.deviceFilters = { rx: 'excellent' };
ok(getFilteredDevices().length === stats.rx.excellent,
   'filter rx=excellent → ' + getFilteredDevices().length + ' (harap ' + stats.rx.excellent + ')');

App.deviceFilters = { rx: 'poor', status: 'offline' };
ok(getFilteredDevices().length === 1, 'filter gabungan rx=poor+status=offline → 1');

App.deviceFilters = {};
ok(getFilteredDevices().length === fleet.length, 'tanpa filter → seluruh armada');

App.deviceFilters = { pon: 'EPON' };
App.deviceSearch = 'ZTEG';   // pencarian tidak melihat mfr → 0
ok(getFilteredDevices().length === 0, 'pencarian + filter digabung dengan AND');
App.deviceSearch = 'F663NV3A';
ok(getFilteredDevices().length === 1, 'pencarian model + filter PON → 1');

console.log(`devfilter: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
