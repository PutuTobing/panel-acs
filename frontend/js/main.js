/* ═══════════════════════════════════════════════════════════════
   Panel ACS — Main Application Logic
   (App state, navigation, theme, clock, sidebar, modals, utils)
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── App State ───
const App = {
  theme: localStorage.getItem('theme') || 'light',
  // Logged-in identity. Placeholder until the account system lands — then this
  // will be set from the authenticated user. Overridable via localStorage today.
  adminName: localStorage.getItem('adminName') || 'Administrator',
  currentPage: 'dashboard',
  devicePage: 1,
  devicePerPage: 20,
  deviceSearch: '',
  // Device-table filters, keyed by dimension (see DIM_DEFS in devices.js).
  deviceFilters: {},
  // Filter parked by a dashboard drill-down, consumed by initDeviceTable().
  pendingDeviceFilter: null,
};

// ─── Page Init Registry (each module registers its own init) ───
const PAGE_INIT = {};

/* ─── Page identity shown in the header centre ───
   One entry per page; navigateTo() applies it. This is the only place a page
   title/subtitle lives now — the old per-page .page-header blocks are gone. */
const PAGE_META = {
  dashboard: {
    icon: 'fa-gauge-high',
    title: 'Dashboard Overview',
    sub:   'Monitoring real-time perangkat ONT di jaringan',
  },
  devices: {
    icon: 'fa-network-wired',
    title: 'Device',
    sub:   'Daftar & kontrol perangkat ONU terdaftar',
  },
  'device-detail': {
    icon: 'fa-router',
    title: 'Detail Perangkat',
    sub:   'Informasi & konfigurasi satu ONU',
  },
  maps: {
    icon: 'fa-location-dot',
    title: 'Peta Jaringan',
    sub:   'Sebaran pelanggan, ODP, dan jalur kabel',
  },
  odc: {
    icon: 'fa-diagram-project',
    title: 'Data ODC',
    sub:   'Topologi jalur kabel & kalkulasi redaman',
  },
  /* Bukan halaman tersendiri — hanya judul header saat kanvas topologi
     dibuka DI DALAM halaman odc. Sengaja tidak punya rute: tautannya
     tetap /maps/odc/<id>, yang dipetakan ke halaman 'odc'. */
  'odc-topologi': {
    icon: 'fa-project-diagram',
    title: 'Topologi FTTH',
    sub:   'Jalur kabel dari PON sampai port pelanggan',
  },
  'master-data': {
    icon: 'fa-database',
    title: 'Master Data',
    sub:   'OLT, PON, rasio splitter & PLC splitter',
  },
  settings: {
    icon: 'fa-sliders',
    title: 'Settings',
    sub:   'Konfigurasi sistem, akun, dan parameter vendor ONU',
  },
  log: {
    icon: 'fa-clock-rotate-left',
    title: 'Log',
    sub:   'Aktivitas tiap role & akun: masuk, perubahan ONU, pengaturan',
  },
};

/* ─── Contextual header actions ───
   Each page module registers what its Refresh/Export buttons should do:
     PAGE_ACTIONS.devices = { refresh: fn(btn), export: fn(btn), exportTitle: '…' }
   Pages with no entry (maps, settings) get disabled buttons rather than
   missing ones, so the header never reflows between pages. */
const PAGE_ACTIONS = {};
// ─── Page Teardown Registry (called when leaving a page — stop timers etc.) ───
const PAGE_TEARDOWN = {};

// ─── Counter Animation ───
function animateCounters(rootId) {
  const root = document.getElementById(rootId || 'page-dashboard');
  if (!root) return;
  const duration = 900;

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function runCount(el, target, isFloat, dec, suffix) {
    if (target === 0) {
      el.textContent = isFloat ? `0.${'0'.repeat(dec)}%` : `0${suffix}`;
      return;
    }
    const startTime = performance.now();
    function tick(now) {
      const elapsed  = Math.min(now - startTime, duration);
      const progress = easeOut(elapsed / duration);
      const cur      = progress * target;
      el.textContent = isFloat
        ? cur.toFixed(dec) + '%'
        : Math.round(cur).toLocaleString('id-ID').replace(/\./g, ',') + suffix;
      if (elapsed < duration) requestAnimationFrame(tick);
      else el.textContent = isFloat
        ? target.toFixed(dec) + '%'
        : target.toLocaleString('id-ID').replace(/\./g, ',') + suffix;
    }
    requestAnimationFrame(tick);
  }

  // Integer: [data-count]
  root.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    const suffix = el.dataset.suffix || '';
    runCount(el, target, false, 0, suffix);
  });

  // Float/percent: [data-countf]
  root.querySelectorAll('[data-countf]').forEach(el => {
    const target = parseFloat(el.dataset.countf);
    const dec    = parseInt(el.dataset.dec || '1', 10);
    runCount(el, target, true, dec, '');
  });
}

/* ═══════════════════════════════════════════════════════════════
   AUTENTIKASI (sisi klien)
   Kredensial hidup di cookie HttpOnly — JS SENGAJA tidak bisa membacanya,
   supaya XSS tak bisa mencuri sesi. Karena itu status login hanya bisa
   diketahui dengan bertanya ke server (/auth/me), bukan dari localStorage.
   ═══════════════════════════════════════════════════════════════ */
async function authFetch(path, opts) {
  const o = Object.assign({ credentials: 'same-origin', headers: {} }, opts || {});
  if (o.body && typeof o.body !== 'string') {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(path, o);
  let data = null;
  try { data = await r.json(); } catch (_) { /* body kosong */ }
  // Muatan galat ikut dibawa (bukan hanya teks pesannya): endpoint Master Data
  // menjawab 409 beserta rincian APA saja yang akan ikut terhapus, dan
  // rincian itu yang ditampilkan ke pengguna sebelum ia memutuskan.
  if (!r.ok) throw Object.assign(new Error((data && data.error) || ('HTTP ' + r.status)),
                                 { status: r.status, data: data });
  return data;
}

/* Halaman login kini /login (frontend/login/) untuk SEMUA role — bukan lagi layar yang
   tertanam di sini (2026-10-03). Sesi habis / belum login / logout → ke sana. Alamat yang
   sedang dibuka ikut dibawa (lanjut=…) supaya staf kembali ke halaman yang sama sesudah
   masuk; login.js hanya menerima jalur lokal milik panel. */
function keLogin(bawaAlamat) {
  const p = window.location.pathname;
  const lanjut = (bawaAlamat && p && p !== '/' && p !== '/login') ? '?lanjut=' + encodeURIComponent(p) : '';
  window.location.replace('/login' + lanjut);
}

function applyUser(user) {
  App.user = user || null;
  App.adminName = (user && (user.name || user.username)) || 'Administrator';
  applyAdminIdentity();
  applyRoleVisibility();
}

/* Sembunyikan elemen [data-admin-only] bila role bukan administrator, dan
   elemen [data-izin="<kunci>"] bila pengguna tak memegang izin itu (menu Settings
   yang dibuka administrator per role — lihat config_store.IZIN_KUNCI).
   WAJIB dipanggil ulang setiap kali HTML halaman disuntikkan: halaman dimuat
   secara dinamis SETELAH login, jadi sekali panggil saat applyUser() hanya
   menjangkau elemen yang saat itu sudah ada di DOM — elemen di dalam
   pages/*.html belum lahir dan akan tampil apa adanya.

   Ini murni kerapian tampilan, BUKAN kontrol akses: menu yang disembunyikan
   tetap bisa dipanggil lewat endpoint langsung. Pagar sebenarnya ada di
   server (_require_admin & _izin di server.py). */
function applyRoleVisibility(root) {
  const admin = isAdmin();
  (root || document).querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = !admin; });
  (root || document).querySelectorAll('[data-izin]').forEach(el => { el.hidden = !punyaIzin(el.dataset.izin); });
}

function isAdmin() { return !!App.user && App.user.role === 'administrator'; }

/* Daftar izin datang bersama data pengguna (/auth/me, login) dan disegarkan tiap
   Settings dibuka (/config/all). "Akun Saya" selalu terbuka: mengganti password
   sendiri tidak boleh bisa dicabut — server menegakkan hal yang sama. */
function punyaIzin(kunci) {
  if (isAdmin() || kunci === 'akunSaya') return true;
  return !!App.user && Array.isArray(App.user.izin) && App.user.izin.indexOf(kunci) !== -1;
}

/* Server sudah mengalihkan sebelum mengirim halaman ini (belum login → /login, akun
   pelanggan → /pelanggan). Pemeriksaan di sini menutup sisanya: cookie sesi ber-SameSite
   Strict tidak ikut pada kunjungan yang berasal dari situs lain (tautan di chat), dan sesi
   bisa habis sesudah halaman terbuka. Aplikasi (#app) baru ditampilkan SESUDAH sesi staf
   dipastikan — dulu akun pelanggan sempat melihat dashboard sekilas sebelum dialihkan. */
async function bootAuth() {
  let d = null;
  try { d = await authFetch('/auth/me'); } catch (_) { d = null; }
  if (!d || !d.user) { keLogin(true); return false; }
  if (d.user.role === 'pelanggan') { window.location.replace('/pelanggan'); return false; }
  applyUser(d.user);
  const app = document.getElementById('app');
  if (app) app.hidden = false;
  refreshModeAmanBar();
  return true;
}

/* Spanduk mode aman.

   Ditanyakan ke server, bukan disimpan di klien: mode aman bisa dinyalakan oleh
   admin lain — atau nanti oleh pemutus arus otomatis — dan browser yang sudah
   telanjur terbuka tidak akan pernah tahu. Tanpa ini, operator akan melihat
   setiap tombol simpan menolak tanpa satu pun petunjuk sebabnya. */
async function refreshModeAmanBar() {
  const bar = document.getElementById('modeAmanBar');
  if (!bar) return;
  try {
    const d = await authFetch('/config/mode-aman');
    bar.classList.toggle('hidden', !d.aktif);
  } catch (_) {
    // Gagal bertanya bukan alasan menampilkan peringatan palsu — pagar di
    // server tetap bekerja apa pun yang tergambar di layar.
    bar.classList.add('hidden');
  }
}

async function doLogout() {
  try { await authFetch('/auth/logout', { method: 'POST', body: {} }); } catch (_) { /* tetap keluar */ }
  App.user = null;
  App.devices = [];            // jangan tinggalkan data ONU di memori setelah keluar
  App.rawDevices = [];
  keLogin(false);
}

// ─── Identity (header greeting + account card) ───
// Single source of truth for the displayed user name. When the account/auth
// system arrives, call setAdminName() after login to update the whole header.
function applyAdminIdentity() {
  const name = App.adminName || 'Administrator';
  const greet = document.getElementById('greetName');
  if (greet) greet.textContent = name;
  document.querySelectorAll('.admin-name').forEach(el => { el.textContent = name; });
  const av = document.querySelector('.admin-avatar');
  if (av) av.textContent = (name.trim()[0] || 'A').toUpperCase();
  // Peran sungguhan dari server. Dulu kartu ini selalu bertuliskan "Super Admin",
  // juga untuk akun ber-role user (2026-10-03).
  const peran = document.querySelector('.admin-role');
  if (peran && App.user) peran.innerHTML = '<i class="fas fa-shield-halved"></i> '
    + (App.user.role === 'administrator' ? 'Administrator' : 'User');
}
function setAdminName(name) {
  App.adminName = name || 'Administrator';
  localStorage.setItem('adminName', App.adminName);
  applyAdminIdentity();
}

/* ─── Header centre: page photo ───
   Pages with a visual identity (Detail Perangkat → the ONU's own photo) can
   replace the header icon. Pass null to fall back to the PAGE_META icon.
   Token guard: a slow image must not paint after the user already left. */
let _pageIconToken = 0;
function setPageIconPhoto(url) {
  const wrap = document.getElementById('hdrPageIconWrap');
  const img  = document.getElementById('hdrPageImg');
  const ico  = document.getElementById('hdrPageIcon');
  if (!wrap || !img || !ico) return;
  const token = ++_pageIconToken;
  const showIcon = () => {
    if (token !== _pageIconToken) return;
    img.hidden = true; ico.hidden = false;
    wrap.classList.remove('has-photo');
  };

  showIcon();                       // sembunyikan dulu — lihat alasan di bawah
  if (!url) return;

  // Dimuat lewat Image() terpisah, baru <img> yang tampak diisi setelah foto
  // dipastikan ada. Dua alasan:
  //   • tanpa ini, foto ONU SEBELUMNYA masih terlihat sampai yang baru selesai
  //     dimuat — sekejap header menampilkan model yang salah;
  //   • menyetel img.src ke nilai yang sama belum tentu memicu onload lagi,
  //     sehingga render ulang ONU yang sama bisa membuat foto tak pernah muncul.
  const probe = new Image();
  probe.onload = () => {
    if (token !== _pageIconToken) return;
    img.src = url;
    img.hidden = false; ico.hidden = true;
    wrap.classList.add('has-photo');
  };
  probe.onerror = showIcon;         // model tanpa foto → tetap ikon
  probe.src = url;
}

/* ─── Header centre: reflect the active page ─── */
function applyPageMeta(page) {
  const m = PAGE_META[page];
  if (!m) return;
  const icon  = document.getElementById('hdrPageIcon');
  const title = document.getElementById('hdrPageTitle');
  const sub   = document.getElementById('hdrPageSub');
  // Reset ke ikon dulu: halaman berikutnya belum tentu punya foto, dan foto
  // ONU sebelumnya tak boleh tertinggal di header.
  setPageIconPhoto(null);
  if (icon)  icon.className = 'fas ' + m.icon;
  if (title) title.textContent = m.title;
  if (sub)   sub.textContent   = m.sub;
  document.title = 'SKY ACS — ' + m.title;

  // Replay the swap animation. Removing the class and forcing a reflow before
  // re-adding it is what makes it restart; without that, navigating to the
  // same-classed element would leave the animation already "finished".
  const wrap = document.getElementById('hdrPage');
  if (wrap) {
    wrap.classList.remove('swap');
    void wrap.offsetWidth;
    wrap.classList.add('swap');
  }
}

/* ─── Header contextual actions (Refresh / Export) ───
   The buttons live in the header permanently; what they DO is looked up from
   PAGE_ACTIONS by the current page at click time. */
function updateHeaderActions() {
  const act = PAGE_ACTIONS[App.currentPage] || null;
  const meta = PAGE_META[App.currentPage];
  const label = meta ? meta.title : 'halaman ini';
  const rBtn = document.getElementById('hdrRefresh');
  const xBtn = document.getElementById('hdrExport');
  if (rBtn) {
    rBtn.disabled = !(act && act.refresh);
    rBtn.title = act && act.refresh ? 'Refresh ' + label : 'Refresh tidak tersedia di halaman ini';
  }
  if (xBtn) {
    xBtn.disabled = !(act && act.export);
    xBtn.title = act && act.export
      ? (act.exportTitle || 'Export ' + label)
      : 'Export tidak tersedia di halaman ini';
  }
}

/* Swap a header icon-button into a spinner while its action runs. Remembers the
   original icon on the element itself, so it restores correctly even if two
   actions overlap. */
function setBtnBusy(btn, busy) {
  if (!btn) return;
  const i = btn.querySelector('i');
  if (!i) return;
  if (busy) {
    if (!btn.dataset.icon) btn.dataset.icon = i.className;
    i.className = 'fas fa-spinner fa-spin';
    btn.disabled = true;
  } else {
    if (btn.dataset.icon) { i.className = btn.dataset.icon; delete btn.dataset.icon; }
    btn.disabled = false;
  }
}

/* ─── CSV export helper (shared by every page's Export action) ───
   `rows` is an array of arrays; values are escaped per RFC 4180. The leading
   BOM is what makes Excel read it as UTF-8 — without it, ODP/serial strings
   with non-ASCII characters arrive mangled.
   Separator is ';' because Excel on an id-ID locale splits on semicolons;
   with ',' the whole row would land in a single column. */
function downloadCSV(filename, rows) {
  const esc = (v) => {
    const s = (v == null ? '' : String(v));
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv  = rows.map(r => r.map(esc).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Date stamp for export filenames (local date, not UTC — an export made at
// 07:00 WIB must not be stamped with the previous day).
function exportStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
       + '_' + p(d.getHours()) + p(d.getMinutes());
}

function initHeaderActions() {
  const rBtn = document.getElementById('hdrRefresh');
  const xBtn = document.getElementById('hdrExport');
  if (rBtn) rBtn.addEventListener('click', function () {
    const act = PAGE_ACTIONS[App.currentPage];
    if (act && act.refresh) act.refresh(this);
  });
  if (xBtn) xBtn.addEventListener('click', function () {
    const act = PAGE_ACTIONS[App.currentPage];
    if (act && act.export) act.export(this);
  });
}

// ─── Theme ───
function initTheme() {
  setTheme(App.theme);
}

function setTheme(theme, persist) {
  App.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // localStorage tetap ditulis sebagai cache: tema harus terpasang SEBELUM
  // permintaan jaringan apa pun selesai, kalau tidak halaman berkedip terang
  // dulu setiap kali dimuat.
  localStorage.setItem('theme', theme);
  const icon = document.getElementById('themeIcon');
  if (icon) icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  // Sync settings page theme opts (if settings page is currently loaded)
  document.querySelectorAll('.theme-opt').forEach(el => el.classList.remove('active'));
  const opt = document.getElementById(theme === 'dark' ? 'optDark' : 'optLight');
  if (opt) opt.classList.add('active');

  // Simpan ke akun (display_settings) agar temanya ikut ke browser mana pun.
  // persist === false dipakai saat MEMUAT tema dari server — tanpa itu, memuat
  // akan langsung menulis balik nilai yang sama ke server pada tiap boot.
  if (persist !== false && App.user) {
    authFetch('/config/display', { method: 'POST', body: { theme } })
      .catch(() => { /* tema tetap berlaku lokal; simpan gagal bukan alasan gagal total */ });
  }
}

// ─── Clock ───
function initClock() {
  updateClock();
  setInterval(updateClock, 1000);
}
function updateClock() {
  const now    = new Date();
  const days   = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'];
  const t = document.getElementById('hdrTime');
  const d = document.getElementById('hdrDate');
  if (t) t.textContent = now.toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  if (d) d.textContent = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

// ─── URL Routing Helpers ───
function pageToPath(page) {
  if (page === 'device-detail' && App.currentDevice) {
    return '/devices/' + encodeURIComponent(App.currentDevice.id || App.currentDevice.serial || 'detail');
  }
  const map = {
    dashboard: '/dashboard', devices: '/devices', settings: '/settings', log: '/log',
    // Cabang Maps memakai URL bersarang supaya tautan yang di-bookmark
    // menceritakan tempatnya sendiri, bukan sekadar '/odc'.
    maps: '/maps', odc: '/maps/odc', 'master-data': '/maps/master-data',
  };
  // Topologi yang sedang dibuka ikut masuk URL, supaya tautannya bisa
  // dibagikan & dimuat ulang tanpa kembali ke daftar.
  if (page === 'odc' && App.currentOdc) return '/maps/odc/' + App.currentOdc.id;
  return map[page] || '/' + page;
}

function pathToPage(pathname) {
  const p = pathname.replace(/\/$/, '') || '/';
  if (p === '/' || p === '/dashboard') return 'dashboard';
  if (p === '/devices') return 'devices';
  if (p.startsWith('/devices/') && p.length > '/devices/'.length) return 'device-detail';
  if (p === '/maps') return 'maps';
  if (p === '/maps/odc') return 'odc';
  // /maps/odc/<id> tetap halaman 'odc'; id-nya dibaca initOdc() dari URL,
  // sama seperti device-detail membaca perangkatnya.
  if (/^\/maps\/odc\/\d+$/.test(p)) return 'odc';
  if (p === '/maps/master-data') return 'master-data';
  if (p === '/settings') return 'settings';
  if (p === '/log') return 'log';
  return 'dashboard';
}

/* ─── Peta grup navigasi ───
   Satu-satunya sumber kebenaran tentang halaman mana milik grup mana.
   Dipakai navigateTo() untuk menyalakan induk & membuka cabangnya. */
const NAV_GROUPS = { maps: ['maps', 'odc', 'master-data'] };

function groupOfPage(page) {
  for (const g in NAV_GROUPS) if (NAV_GROUPS[g].indexOf(page) >= 0) return g;
  return null;
}

// ─── Navigation (fetch-based) ───
function initNavigation() {
  // Induk grup tak punya data-page, jadi ia lolos dari loop navigasi di bawah
  // dengan sendirinya — tugasnya hanya membuka/menutup cabang.
  document.querySelectorAll('.nav-group-toggle').forEach(tgl => {
    tgl.addEventListener('click', e => {
      e.preventDefault();
      const grp = tgl.closest('.nav-group');
      if (grp) grp.classList.toggle('open');
    });
  });

  document.querySelectorAll('.nav-item, .nav-subitem').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const page = item.dataset.page;
      if (page) navigateTo(page);
    });
  });

  // Handle browser back/forward
  window.addEventListener('popstate', e => {
    const page = (e.state && e.state.page) ? e.state.page : pathToPage(window.location.pathname);
    if (page === 'device-detail') bukaDetailDariUrl();
    else navigateTo(page, true);
  });
}

/* ─── Membuka halaman detail satu ONU ───
   SATU pintu untuk semua jalan masuk: daftar perangkat, dashboard, alamat langsung,
   F5, dan tombol Back/Forward browser. Tiga aturan (2026-10-03):

   1. Yang tampil SELALU perangkat yang diminta. Dulu saat panel dimuat, salinan
      perangkat di sessionStorage dipakai apa pun isinya: membuka /devices/B di tab
      yang terakhir melihat A menampilkan A di bawah alamat B — dan tombol Reboot,
      Simpan WAN, dst. bekerja pada A. Ditemukan uji tampilan, bukan laporan lapangan,
      tetapi akibatnya adalah perintah ke ONU yang salah.
   2. Jawaban yang terlambat datang untuk perangkat LAIN dibuang. Dulu membuka A lalu
      cepat-cepat B bisa membuat halaman B digambar ulang dengan data A.
   3. Dokumen perangkat tidak lagi disalin ke sessionStorage. Isinya memuat password
      WiFi/PPPoE yang terbaca dari ONU; memuat ulang cukup satu GET ke cache GenieACS
      (tanpa perintah ke ONU), dan hasilnya data TERBARU, bukan salinan saat tab dibuka.

   awal (opsional) = data ringkas dari daftar: halaman digambar seketika dengannya
   (ditandai _ringkas agar bagian yang butuh data lengkap menampilkan "Memuat…"),
   lalu dilengkapi begitu dokumen penuh tiba. */
let _detailToken = 0;
function bukaDetailPerangkat(id, awal) {
  const token = ++_detailToken;
  if (awal) {
    App.currentDevice = Object.assign({}, awal, { _ringkas: true });
    navigateTo('device-detail');
  }
  return ACS.fetchDevice(id).then(full => {
    if (token !== _detailToken) return;        // operator sudah membuka halaman/perangkat lain
    App.currentDevice = full;
    if (App.currentPage === 'device-detail' && typeof initDeviceDetail === 'function'
        && document.getElementById('page-device-detail')) initDeviceDetail();
    else navigateTo('device-detail', true);
  }).catch(() => {
    if (token !== _detailToken) return;
    // Data ringkas dari daftar tetap berguna; tanpa data sama sekali → kembali ke daftar.
    if (!awal) navigateTo('devices', true);
    else if (App.currentDevice && App.currentDevice.id === id) {
      delete App.currentDevice._ringkas;
      if (typeof initDeviceDetail === 'function') initDeviceDetail();
    }
  });
}

// Alamat /devices/<id> dibuka langsung, dimuat ulang, atau dicapai lewat Back/Forward.
function bukaDetailDariUrl() {
  let id = '';
  try { id = decodeURIComponent(window.location.pathname.replace(/^\/devices\//, '').trim()); } catch (_) { id = ''; }
  if (!id || id === 'detail' || typeof ACS === 'undefined') { navigateTo('devices', true); return; }
  if (App.currentDevice && App.currentDevice.id === id) {
    // Masih di memori dan memang perangkat ini → gambar seketika, lalu segarkan.
    navigateTo('device-detail', true);
  } else {
    App.currentDevice = null;
    App.currentPage = 'device-detail';
    const ca = document.getElementById('contentArea');
    if (ca) ca.innerHTML = '<div class="page"><div class="card"><div class="card-body" style="text-align:center;'
      + 'color:var(--text-muted);padding:34px 16px"><i class="fas fa-spinner fa-spin" style="font-size:20px"></i>'
      + '<div style="margin-top:10px;font-size:13px">Memuat data perangkat…</div></div></div></div>';
  }
  bukaDetailPerangkat(id);
}

// skipHistory = true when called from popstate or initial URL parse
async function navigateTo(page, skipHistory) {
  // Pindah ke halaman selain detail ONU → pemuatan detail yang masih berjalan dibatalkan
  // (jawabannya tak boleh menarik operator kembali ke halaman detail).
  if (page !== 'device-detail') _detailToken++;

  // Tear down the page we're leaving (stop its timers/intervals)
  const _prevPage = App.currentPage;
  if (_prevPage !== page && PAGE_TEARDOWN[_prevPage]) {
    try { PAGE_TEARDOWN[_prevPage](); } catch (_) {}
  }
  App.currentPage = page;

  // Berpindah halaman = titik alami untuk memeriksa ulang. Cukup untuk membuat
  // spanduk muncul di browser yang sudah terbuka saat admin lain menyalakannya,
  // tanpa menambah pengutipan berkala yang tak perlu.
  refreshModeAmanBar();

  // ─── Update browser URL ───
  const path = pageToPath(page);
  if (!skipHistory) {
    if (window.location.pathname !== path) {
      history.pushState({ page, deviceId: App.currentDevice ? App.currentDevice.id : null }, '', path);
    } else {
      history.replaceState({ page, deviceId: App.currentDevice ? App.currentDevice.id : null }, '', path);
    }
  } else {
    // Stamp state on the current entry so popstate can read it back
    history.replaceState({ page }, '', window.location.pathname);
  }

  // ─── Update nav active state ───
  // Highlight 'devices' nav item when on device-detail
  const navPage = page === 'device-detail' ? 'devices' : page;
  document.querySelectorAll('.nav-item, .nav-subitem').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${navPage}"]`);
  if (navItem) navItem.classList.add('active');

  // Induk grup: nyalakan yang memuat halaman ini, dan buka cabangnya supaya
  // item aktif tidak tersembunyi di balik grup yang terlanjur tertutup.
  const grp = groupOfPage(navPage);
  document.querySelectorAll('.nav-group').forEach(g => {
    const mine = g.dataset.group === grp;
    g.classList.toggle('has-active', mine);
    if (mine) g.classList.add('open');
  });

  // ─── Update header centre title + contextual actions ───
  applyPageMeta(page);
  updateHeaderActions();

  // ─── Fetch and inject page HTML ───
  const contentArea = document.getElementById('contentArea');
  try {
    const res = await fetch(`/pages/${page}.html`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    contentArea.innerHTML = await res.text();
  } catch (e) {
    contentArea.innerHTML = `<div class="page"><div class="card"><div class="card-body">
      <p style="color:var(--red)"><i class="fas fa-circle-exclamation"></i> Gagal memuat halaman: ${e.message}</p>
    </div></div></div>`;
    return;
  }

  // Halaman baru saja masuk DOM — elemen khusus admin di dalamnya belum
  // pernah tersentuh applyUser(), jadi terapkan di sini sebelum init berjalan.
  applyRoleVisibility(contentArea);

  // ─── Call page-specific init ───
  if (PAGE_INIT[page]) PAGE_INIT[page]();
}

// ─── Sidebar Toggle ───
function initSidebarToggle() {
  const btn      = document.getElementById('sidebarToggle');
  const sidebar  = document.getElementById('sidebar');
  const scrim    = document.getElementById('sidebarScrim');
  if (!btn || !sidebar) return;
  let collapsed  = false;

  const closeDrawer = () => {
    sidebar.classList.remove('open');
    if (scrim) scrim.classList.remove('show');
  };

  btn.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      const open = sidebar.classList.toggle('open');
      if (scrim) scrim.classList.toggle('show', open);
    } else {
      collapsed = !collapsed;
      sidebar.classList.toggle('collapsed', collapsed);
    }
  });

  // Tap the dimmed backdrop → close the mobile drawer
  if (scrim) scrim.addEventListener('click', closeDrawer);

  // Selecting a menu item on mobile should dismiss the drawer
  // Induk grup DIKECUALIKAN: membuka cabang lalu lacinya langsung menutup
  // berarti cabang itu tak pernah sempat terlihat.
  sidebar.querySelectorAll('.nav-item[data-page], .nav-subitem').forEach(item => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeDrawer();
    });
  });

  // Returning to desktop width must clear any lingering mobile state
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeDrawer();
  });
}

// ─── Modal Helpers ───
function initModals() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

// ─── HTML escape (shared by dashboard/devices renderers) ───
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Auto Refresh (driven by Settings → refreshInterval, in seconds) ───
let _autoRefreshIv = null;
function setupAutoRefresh() {
  if (_autoRefreshIv) { clearInterval(_autoRefreshIv); _autoRefreshIv = null; }
  const sec = parseInt((typeof ACS !== 'undefined' ? ACS.getConfig().refreshInterval : 0), 10);
  if (!sec || sec <= 0) return;            // 0 / Disabled → no auto refresh
  _autoRefreshIv = setInterval(autoRefreshTick, sec * 1000);
}
async function autoRefreshTick() {
  // Only refresh data-heavy list/overview pages; never disturb detail editing
  if (App.currentPage !== 'dashboard' && App.currentPage !== 'devices') return;
  try { await ACS.loadAll(); } catch (_) { return; }
  if (App.currentPage === 'dashboard') {
    if (typeof initDashboard === 'function') initDashboard();
  } else if (App.currentPage === 'devices' && typeof renderDeviceTable === 'function') {
    // Re-render preserving current search/filter/page
    if (typeof populateVendorFilter === 'function') populateVendorFilter();
    renderDeviceTable();
    renderPagination();
    if (typeof updateSignalStats === 'function') updateSignalStats();
    if (typeof updateDeviceCountBadge === 'function') updateDeviceCountBadge();
  }
}

// ─── Password Toggle ───
function togglePass(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

// ─── Confirmation Modal ───
// showConfirm({title, message(HTML allowed), yesLabel, noLabel, icon, danger}, onConfirm)
/* opts.requireText — for irreversible / high-blast-radius actions: the confirm
   button stays disabled until the user types this exact word. Deliberate
   friction, so a bulk delete or a bulk reboot of live customer ONUs can never
   happen from a single mis-click. */
function showConfirm(opts, onConfirm) {
  opts = opts || {};
  const prev = document.getElementById('appConfirm');
  if (prev) prev.remove();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'appConfirm';
  const need = opts.requireText || '';
  ov.innerHTML =
    '<div class="modal" style="max-width:460px">'
    + '<div class="modal-header"><h3>'
    + (opts.icon ? '<i class="fas ' + opts.icon + '"></i> ' : '')
    + escHtml(opts.title || 'Konfirmasi')
    + '</h3><button class="modal-close" data-act="no"><i class="fas fa-xmark"></i></button></div>'
    + '<div class="modal-body">'
    + '<div style="font-size:13px;line-height:1.65">' + (opts.message || '') + '</div>'
    + (need
        ? '<div class="cf-type"><label>Ketik <b>' + escHtml(need) + '</b> untuk mengonfirmasi</label>'
          + '<input type="text" id="cfType" autocomplete="off" spellcheck="false" placeholder="' + escHtml(need) + '"></div>'
        : '')
    + '<div class="btn-row" style="margin-top:18px;justify-content:flex-end;gap:8px">'
    + '<button class="btn btn-ghost" data-act="no">' + escHtml(opts.noLabel || 'Batal') + '</button>'
    + '<button class="btn ' + (opts.danger ? 'btn-amber' : 'btn-primary') + '" data-act="yes"'
    + (need ? ' disabled' : '') + '>'
    + escHtml(opts.yesLabel || 'Ya') + '</button>'
    + '</div></div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();

  if (need) {
    const inp = ov.querySelector('#cfType');
    const yes = ov.querySelector('[data-act="yes"]');
    const check = () => { yes.disabled = inp.value.trim().toUpperCase() !== need.toUpperCase(); };
    inp.addEventListener('input', check);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !yes.disabled) yes.click();
    });
    setTimeout(() => inp.focus(), 50);
  }

  // opts.onCancel: dipanggil bila dialog ditutup tanpa "Ya". Tanpa ini pemanggil
  // yang menunggu jawaban (mis. tombol Simpan WAN yang sudah "Mengirim…") tak
  // pernah tahu operator membatalkan, dan tombolnya macet.
  const batal = () => { close(); if (typeof opts.onCancel === 'function') opts.onCancel(); };
  ov.addEventListener('click', e => {
    if (e.target === ov) { batal(); return; }
    const act = e.target.closest('[data-act]');
    if (!act || act.disabled) return;
    if (act.dataset.act === 'yes') { close(); if (typeof onConfirm === 'function') onConfirm(); }
    else batal();
  });
}

/* ─── Salin teks ke clipboard ───
   navigator.clipboard HANYA tersedia di secure context (https / localhost).
   Panel ini dilayani lewat http://<IP-LAN>:8081, sehingga di browser operator
   navigator.clipboard UNDEFINED — tanpa jalur cadangan, tombol salin diam saja.
   execCommand memang usang, tapi ia satu-satunya yang bekerja di http biasa. */
function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return Promise.reject(new Error('teks kosong'));

  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(s);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    // Di luar layar tetapi tetap dapat diseleksi — execCommand butuh seleksi nyata.
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    ok ? resolve() : reject(new Error('penyalinan ditolak browser'));
  });
}

/* Salin GAMBAR PNG ke clipboard (2026-10-04, tombol "Salin Gambar" di laporan ONU).
   `gambar` = Blob atau janji (Promise) Blob. Berbeda dari teks, gambar TIDAK punya jalur
   cadangan execCommand: di http://<IP-LAN> clipboard gambar memang tidak ada, jadi janji
   ini DITOLAK dan pemanggil wajib menyediakan jalan lain (laporan: mengunduh berkasnya).
   Clipboard hanya boleh diminta selagi klik masih "segar", sedangkan gambarnya baru jadi
   sesaat kemudian — karena itu janji gambar diserahkan apa adanya ke ClipboardItem dan
   browser yang menunggunya. Browser yang tidak menerima janji di sana melempar galat →
   dicoba lagi sesudah gambarnya jadi. */
function copyImage(gambar) {
  if (!(window.isSecureContext && navigator.clipboard && navigator.clipboard.write
        && typeof ClipboardItem !== 'undefined')) {
    return Promise.reject(new Error('clipboard gambar tidak tersedia (butuh https atau localhost)'));
  }
  try {
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': gambar })]);
  } catch (_) {
    return Promise.resolve(gambar).then(blob =>
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]));
  }
}

function bisaSalinGambar() {
  return !!(window.isSecureContext && navigator.clipboard && navigator.clipboard.write
            && typeof ClipboardItem !== 'undefined');
}

// Salin + beri umpan balik pada tombolnya (dipakai baris Device Information).
function copyWithFeedback(text, btn, label) {
  copyText(text).then(() => {
    if (btn) {
      const i = btn.querySelector('i');
      if (i) {
        const orig = i.className;
        i.className = 'fas fa-check';
        btn.classList.add('ok');
        setTimeout(() => { i.className = orig; btn.classList.remove('ok'); }, 1200);
      }
    }
    showToast((label || 'Teks') + ' disalin', 'success');
  }).catch(e => showToast('Gagal menyalin: ' + (e.message || 'Error'), 'error'));
}

// ─── Toast Notification ───
/* Penanda proses di kanan bawah untuk pekerjaan yang lama (2026-10-03) — mis. refresh
   ONU yang bisa menunggu 60+ dtk. Beda dari showToast (hilang 3,5 dtk): tetap tampil
   sampai pekerjaannya selesai, satu kartu per pekerjaan, boleh bertumpuk. Teks selalu
   TEKS, bukan HTML (pesan fault dari ONU bisa ikut masuk).
     const p = tampilProses('Refresh …');  p.ubah('… 42 dtk');  p.selesai('Berhasil', 'success'); */
function tampilProses(teks) {
  let wadah = document.getElementById('prosesTumpuk');
  if (!wadah) {
    wadah = document.createElement('div');
    wadah.id = 'prosesTumpuk';
    wadah.className = 'proses-tumpuk';
    wadah.setAttribute('role', 'status');
    document.body.appendChild(wadah);
  }
  const el = document.createElement('div');
  el.className = 'proses-kartu';
  el.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span></span>';
  const span = el.querySelector('span');
  span.textContent = String(teks == null ? '' : teks);
  wadah.appendChild(el);
  return {
    ubah(t) { span.textContent = String(t == null ? '' : t); },
    selesai(t, tipe) {
      el.remove();
      if (t) showToast(t, tipe || 'success');
    },
  };
}
function _tinggiProses() {
  const w = document.getElementById('prosesTumpuk');
  return w && w.children.length ? w.offsetHeight + 10 : 0;
}

function showToast(msg, type) {
  // Remove existing toasts
  document.querySelectorAll('.app-toast').forEach(t => t.remove());
  const colors = { success: '#22c55e', error: '#ef4444', info: '#6366f1' };
  const icons  = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info' };
  const t = document.createElement('div');
  t.className = 'app-toast';
  // Pesan selalu TEKS, tidak pernah HTML (2026-10-03): sebagian membawa keterangan dari
  // ONU — mis. FaultString CWMP yang diteruskan GenieACS saat perintah ditolak — dan
  // perangkat yang disusupi bisa menyelipkan tag di sana.
  t.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i>`;
  t.appendChild(document.createTextNode(' ' + String(msg == null ? '' : msg)));
  Object.assign(t.style, {
    // Di atas tumpukan penanda proses (tampilProses), bila ada — jangan saling tutup.
    position: 'fixed', bottom: (24 + _tinggiProses()) + 'px', right: '24px', zIndex: 9999,
    background: 'var(--surface)', border: `1.5px solid ${colors[type] || colors.info}`,
    color: colors[type] || colors.info, borderRadius: '10px',
    padding: '12px 18px', fontSize: '13px', fontWeight: '600',
    boxShadow: '0 4px 20px rgba(0,0,0,.15)', display: 'flex',
    alignItems: 'center', gap: '8px', maxWidth: '340px',
    animation: 'toastIn .25s ease',
  });
  // keyframes (inject once)
  if (!document.getElementById('toastKf')) {
    const s = document.createElement('style');
    s.id = 'toastKf';
    s.textContent = '@keyframes toastIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}';
    document.head.appendChild(s);
  }
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  applyAdminIdentity();
  initHeaderActions();
  initClock();
  initNavigation();
  initSidebarToggle();
  initModals();

  // Theme toggle button (always in header)
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    setTheme(App.theme === 'dark' ? 'light' : 'dark');
  });

  // Logout button (always in header)
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    showConfirm({
      title: 'Keluar dari SKY ACS?',
      icon: 'fa-right-from-bracket',
      yesLabel: 'Keluar',
      message: 'Sesi Anda akan diakhiri dan panel kembali ke halaman masuk.',
    }, doLogout);
  });

  // Data ONU baru dimuat SETELAH sesi dipastikan ada. Kalau halaman digambar
  // lebih dulu, setiap panggilan /api akan 401 dan pengguna melihat halaman
  // penuh error di balik layar login.
  bootAuth().then(okSession => { if (okSession) startApp(); });
});

// Semua yang butuh data ONU dijalankan di sini — dipanggil setelah login.
async function startApp() {
  // Pengaturan ditarik dari server SEBELUM halaman pertama dirender.
  // Urutannya penting: ambang RX & Online Threshold ikut menentukan hasil
  // pemetaan data ONU, jadi kalau data dimuat lebih dulu, halaman pertama
  // tergambar memakai nilai default lalu diam-diam berbeda dari milik operator
  // lain sampai halaman dipindah.
  //
  // Ini juga menutup celah lama: klien TIDAK PERNAH membaca konfigurasi server
  // sama sekali (GET /config tak pernah dipanggil), sehingga tiap browser
  // berjalan dengan pengaturannya sendiri.
  // Sisa versi lama: alamat, username, bahkan password NBI pernah disimpan di cache ini
  // lalu dikirim browser ke /api. Kredensial NBI kini hanya dipegang server
  // (2026-10-03) — buang sisanya dari browser ini, berhasil-tidaknya /config/all.
  try {
    const lama = JSON.parse(localStorage.getItem('acsConfig') || '{}');
    if ('acsPass' in lama || 'acsUser' in lama || 'acsUrl' in lama) {
      delete lama.acsPass; delete lama.acsUser; delete lama.acsUrl;
      localStorage.setItem('acsConfig', JSON.stringify(lama));
    }
  } catch (_) { /* penyimpanan diblokir / isi rusak */ }
  try {
    const d = await authFetch('/config/all');
    const cur = JSON.parse(localStorage.getItem('acsConfig') || '{}');
    localStorage.setItem('acsConfig', JSON.stringify(Object.assign(cur, d.params)));
    if (d.display && d.display.theme) setTheme(d.display.theme, false);
    // Pemetaan VP dipasang SEBELUM halaman pertama digambar. Kalau server tidak
    // mengirim apa-apa (belum pernah disunting), VPMap tetap memakai bawaannya
    // sendiri — bukan kosong.
    if (typeof VPMap !== 'undefined' && d.vpMapping) VPMap.setPeta(d.vpMapping);
    // Profil vendor dari server → cache browser, SEBELUM halaman perangkat pertama
    // digambar, supaya semua teknisi memakai profil yang sama (2026-10-03).
    if (typeof terapkanProfilServer === 'function') terapkanProfilServer(d.vendorProfiles);
  } catch (_) {
    // Gagal → jalan dengan cache localStorage. Panel tetap berguna.
  }

  // ─── Parse URL and load initial page ───
  // Salinan dokumen perangkat versi lama (memuat password WiFi/PPPoE) dibuang dari
  // penyimpanan tab — lihat bukaDetailPerangkat().
  try { sessionStorage.removeItem('currentDevice'); } catch (_) { /* penyimpanan diblokir */ }
  const startPage = pathToPage(window.location.pathname);
  if (startPage === 'device-detail') bukaDetailDariUrl();
  else navigateTo(startPage, true);

  // Start auto-refresh timer (reconfigured when ACS settings are saved)
  setupAutoRefresh();
}
