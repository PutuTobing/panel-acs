/* ═══════════════════════════════════════════════════════════════
   Menu Log — aktivitas tiap role & akun (2026-10-03)

   Sumbernya tabel audit_log yang sudah lama ditulis server, tetapi dulu tak punya
   halaman: untuk tahu siapa me-reboot sebuah ONU orang harus membuka basis data.
   Halaman ini HANYA membaca (GET /auth/audit, khusus administrator — pagarnya di
   server). Saringan role / nama akun / jenis kejadian / kata cari semuanya dikerjakan
   server, supaya "Muat lebih banyak" tetap benar pada puluhan ribu catatan.

   Yang ditampilkan adalah kalimat ("mengganti password WiFi (SSID 1) pada ONU …"),
   bukan kode aksi. Kalimat operasi ONU disusun server (backend/logonu.py); di sini
   hanya label untuk aksi lain. Aksi yang belum dikenal tetap tampil apa adanya —
   catatan tidak boleh hilang hanya karena labelnya belum ditulis.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const PER_HALAMAN = 100;
  const st = { role: '', akun: '', kategori: '', q: '', baris: [], adaLagi: false, akunSemua: [], token: 0 };

  /* aksi → [ikon, label]. Label kosong = keterangan dari server sudah berupa kalimat. */
  const AKSI = {
    'login.success':        ['fa-right-to-bracket', 'masuk'],
    'login.failed':         ['fa-triangle-exclamation', 'gagal masuk — username atau password salah'],
    'login.blocked':        ['fa-ban', 'ditahan sementara — terlalu banyak percobaan masuk'],
    'logout':               ['fa-right-from-bracket', 'keluar'],
    'system.setup':         ['fa-flag-checkered', 'instalasi panel'],
    'system.setup.denied':  ['fa-ban', 'instalasi ditolak'],
    'system.migrate':       ['fa-database', 'impor data lama'],
    'onu.wifi':             ['fa-wifi', ''],
    'onu.wan':              ['fa-globe', ''],
    'onu.akunweb':          ['fa-key', ''],
    'onu.ubah':             ['fa-sliders', ''],
    'onu.refresh':          ['fa-rotate', ''],
    'onu.hapus':            ['fa-trash', ''],
    'onu_reboot':           ['fa-power-off', ''],
    'onu.remote.open':      ['fa-arrow-up-right-from-square', 'membuka halaman admin ONU'],
    'pelanggan.wifi':       ['fa-wifi', 'mengubah WiFi'],
    'pelanggan.reboot':     ['fa-power-off', 'me-restart router'],
    'pelanggan.refresh':    ['fa-rotate', 'memperbarui data'],
    'pelanggan.onu':        ['fa-link', 'mengatur ONU milik akun pelanggan'],
    'acs_ditolak':          ['fa-shield-halved', 'perintah ditolak pagar keselamatan'],
    'task_kedaluwarsa':     ['fa-hourglass-end', 'task antrean dibatalkan (terlalu lama menunggu)'],
    'antrean_dibersihkan':  ['fa-broom', 'membersihkan antrean & fault'],
    'access.denied':        ['fa-lock', 'akses ditolak'],
    'security.cross_site.denied': ['fa-shield-halved', 'permintaan dari situs lain ditolak'],
    'account.create':       ['fa-user-plus', 'membuat akun'],
    'account.update':       ['fa-user-pen', 'mengubah akun'],
    'account.delete':       ['fa-user-minus', 'menghapus akun'],
    'izin_role.update':     ['fa-user-shield', 'mengubah hak akses role'],
    'mitra.tag':            ['fa-tag', 'mengikat akun mitra ke tagnya'],
    'tag.buat':             ['fa-tag', 'membuat tag'],
    'tag.ubah':             ['fa-tag', 'mengubah tag'],
    'tag.hapus':            ['fa-tag', 'menghapus tag'],
    'tag.pasang':           ['fa-tag', 'memasang tag'],
    'tag.lepas':            ['fa-tag', 'melepas tag'],
    'app_parameters.update':   ['fa-gear', 'mengubah parameter panel'],
    'display_settings.update': ['fa-palette', 'mengubah tampilan'],
    'acs_connection.update':   ['fa-plug', 'mengubah koneksi ACS'],
    'acs_connection.test':     ['fa-plug-circle-check', 'menguji koneksi ACS'],
    'vpmap.set':            ['fa-diagram-project', 'mengubah pemetaan VP'],
    'vpmap.reset':          ['fa-diagram-project', 'mengembalikan pemetaan VP ke bawaan'],
    'vendor.set':           ['fa-microchip', 'mengubah profil vendor'],
    'vendor.reset':         ['fa-microchip', 'mengembalikan profil vendor ke bawaan'],
    'mode_aman_nyala':      ['fa-shield-heart', 'menyalakan Mode Aman'],
    'mode_aman_mati':       ['fa-shield-heart', 'mematikan Mode Aman'],
    'cadangan.otomatis':    ['fa-box-archive', 'cadangan harian basis data dibuat'],
    'cadangan.unduh':       ['fa-file-shield', 'mengunduh cadangan terenkripsi'],
    'log.pangkas':          ['fa-broom', 'Log lama dipangkas'],
    'sistem.update':        ['fa-cloud-arrow-down', 'memperbarui panel'],
    'sistem.update.gagal':  ['fa-cloud-arrow-down', 'pembaruan panel dibatalkan'],
  };
  /* Kejadian yang dikerjakan panel sendiri (tanpa pelaku manusia): ditulis "Sistem",
     bukan "Tanpa akun" — yang terakhir berarti orang yang belum/gagal masuk. */
  const OLEH_SISTEM = ['cadangan.otomatis', 'task_kedaluwarsa', 'system.migrate', 'log.pangkas'];
  /* Keluarga aksi yang anggotanya banyak (masterdata.olt.create, odc.node.move, …). */
  const AWALAN = [
    ['masterdata.', 'fa-database', 'mengubah Master Data'],
    ['odc.',        'fa-diagram-project', 'mengubah Data ODC'],
  ];
  const ROLE_LABEL = { administrator: 'Administrator', user: 'User', pelanggan: 'Pelanggan', mitra: 'Mitra' };
  const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];
  const HARI  = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  const el = (id) => document.getElementById(id);

  function kenali(aksi) {
    if (AKSI[aksi]) return AKSI[aksi];
    for (const a of AWALAN) if (aksi.indexOf(a[0]) === 0) return [a[1], a[2]];
    return ['fa-circle-dot', aksi];
  }

  /* Catatan reboot lama (sebelum 2026-10-03) menyimpan alamat NBI mentah
     ('/api/devices/<id>/tasks'); tampilkan sebagai kalimat seperti catatan baru. */
  function uraian(b) {
    const k = kenali(b.action);
    let teks = b.detail || '', hasil = '';
    if (b.action === 'onu_reboot' && /^\/api\/devices\//.test(teks)) {
      let sn = teks.split('/')[3] || '';
      try { sn = decodeURIComponent(sn); } catch (_) { /* biarkan apa adanya */ }
      teks = 'me-reboot ONU ' + sn.split('-').pop();
    }
    if (!k[1]) {
      const m = /^(.*) — (berhasil|diantrekan[^—]*|gagal[^—]*)$/.exec(teks);
      if (m) { teks = m[1]; hasil = m[2]; }
      return { ikon: k[0], kalimat: teks || b.action, rincian: '', hasil: hasil };
    }
    // Masuk/keluar: 'username=budi' hanya mengulang nama akun di depannya. Yang perlu
    // terlihat adalah username yang DIKETIK bila bukan akun yang ada (percobaan bobol).
    const mu = /^username=(.*?)(?: alasan=(.*))?$/.exec(teks);
    if (mu && /^(login\.|logout$)/.test(b.action)) {
      teks = [mu[1] !== b.username ? 'username yang diketik: ' + mu[1] : '', mu[2] || ''].filter(Boolean).join(' · ');
    }
    return { ikon: k[0], kalimat: k[1], rincian: teks, hasil: '' };
  }

  function kelasHasil(h) {
    return h.indexOf('berhasil') === 0 ? 'ok' : h.indexOf('gagal') === 0 ? 'gagal' : 'antre';
  }

  /* created_at = jam SERVER tanpa zona ('2026-10-03T14:05:09'); dibaca apa adanya. */
  function pecahWaktu(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(s || '');
    if (!m) return { hari: s || '—', jam: '' };
    return { hari: m[1] + '-' + m[2] + '-' + m[3], jam: m[4], d: new Date(+m[1], +m[2] - 1, +m[3]) };
  }
  function judulHari(w) {
    if (!w.d) return w.hari;
    const kini = new Date(), awal = new Date(kini.getFullYear(), kini.getMonth(), kini.getDate());
    const selisih = Math.round((awal - w.d) / 86400000);
    const tgl = HARI[w.d.getDay()] + ', ' + w.d.getDate() + ' ' + BULAN[w.d.getMonth()] + ' ' + w.d.getFullYear();
    return selisih === 0 ? 'Hari ini · ' + tgl : selisih === 1 ? 'Kemarin · ' + tgl : tgl;
  }

  function barisHtml(b) {
    const u = uraian(b), w = pecahWaktu(b.created_at);
    const role = b.role || '';
    return '<div class="log-baris kat-' + escHtml(b.kategori || 'pengaturan') + '" data-id="' + escHtml(b.id) + '">'
      + '<span class="log-jam">' + escHtml(w.jam) + '</span>'
      + '<span class="log-ikon"><i class="fas ' + escHtml(u.ikon) + '"></i></span>'
      + '<div class="log-isi">'
        + '<div class="log-kalimat">'
          + (b.username
              ? '<b class="log-akun">' + escHtml(b.username) + '</b>'
              : '<b class="log-akun tanpa">' + (OLEH_SISTEM.indexOf(b.action) >= 0 ? 'Sistem' : 'Tanpa akun') + '</b>')
          + (role ? '<span class="log-role role-' + escHtml(role) + '">' + escHtml(ROLE_LABEL[role] || role) + '</span>' : '')
          + '<span class="log-teks">' + escHtml(u.kalimat) + '</span>'
          + (u.hasil ? '<span class="log-hasil ' + kelasHasil(u.hasil) + '">' + escHtml(u.hasil) + '</span>' : '')
        + '</div>'
        + (u.rincian ? '<div class="log-rincian">' + escHtml(u.rincian) + '</div>' : '')
      + '</div>'
      + '<span class="log-ip" title="Alamat IP">' + escHtml(b.ip_address || '') + '</span>'
      + '</div>';
  }

  function gambar() {
    const wadah = el('logDaftar');
    if (!wadah) return;
    if (!st.baris.length) {
      const tersaring = st.role || st.akun || st.kategori || st.q;
      wadah.innerHTML = '<div class="log-kosong"><i class="fas fa-clipboard-list"></i> '
        + (tersaring ? 'Tidak ada catatan yang cocok dengan saringan ini' : 'Belum ada catatan') + '</div>';
    } else {
      let html = '', hari = null;
      st.baris.forEach(function (b) {
        const w = pecahWaktu(b.created_at);
        if (w.hari !== hari) {
          hari = w.hari;
          html += '<div class="log-hari">' + escHtml(judulHari(w)) + '</div>';
        }
        html += barisHtml(b);
      });
      wadah.innerHTML = html;
    }
    const j = el('logJumlah'), lagi = el('logLagi');
    if (j) j.textContent = st.baris.length
      ? st.baris.length + ' catatan ditampilkan' + (st.adaLagi ? ' — masih ada yang lebih lama' : '')
      : '';
    if (lagi) lagi.hidden = !st.adaLagi;
  }

  /* Daftar "nama akun" mengikuti role yang dipilih; pilihan yang tak lagi ada dilepas. */
  function isiAkun() {
    const sel = el('logAkun');
    if (!sel) return;
    const daftar = st.akunSemua.filter(function (a) { return !st.role || a.role === st.role; });
    if (st.akun && !daftar.some(function (a) { return a.username === st.akun; })) st.akun = '';
    sel.innerHTML = '<option value="">Semua akun</option>' + daftar.map(function (a) {
      return '<option value="' + escHtml(a.username) + '"' + (a.username === st.akun ? ' selected' : '') + '>'
        + escHtml(a.username) + '</option>';
    }).join('');
    if (sel._cdropSync) sel._cdropSync();
  }

  async function muat(tambah) {
    const wadah = el('logDaftar');
    if (!wadah) return;
    const token = ++st.token;
    const p = new URLSearchParams({ limit: PER_HALAMAN });
    if (st.role) p.set('role', st.role);
    if (st.akun) p.set('akun', st.akun);
    if (st.kategori) p.set('kategori', st.kategori);
    if (st.q) p.set('q', st.q);
    if (tambah && st.baris.length) p.set('sebelum', st.baris[st.baris.length - 1].id);
    const lagi = el('logLagi');
    if (lagi) lagi.disabled = true;
    if (!tambah) wadah.classList.add('memuat');
    try {
      const d = await authFetch('/auth/audit?' + p.toString());
      if (token !== st.token) return;               // saringan sudah berubah lagi
      st.baris = tambah ? st.baris.concat(d.entries || []) : (d.entries || []);
      st.adaLagi = !!d.adaLagi;
      if (d.akun) { st.akunSemua = d.akun; isiAkun(); }
      // Role yang hanya boleh melihat lognya sendiri (izin tanpa logSemua): saringan role &
      // akun tidak berguna — server toh memaksa akunnya sendiri — jadi disembunyikan.
      const sendiri = !!d.sendiri;
      [el('logRole'), el('logAkun') && (el('logAkun').closest('.cdrop') || el('logAkun'))].forEach(function (x) {
        if (x) x.hidden = sendiri;
      });
      gambar();
    } catch (e) {
      if (token !== st.token) return;
      wadah.innerHTML = '<div class="log-kosong galat"><i class="fas fa-circle-exclamation"></i> '
        + escHtml(e.status === 403 ? 'Menu Log hanya untuk administrator atau role yang diberi izin.' : 'Gagal memuat catatan: ' + (e.message || 'galat')) + '</div>';
      if (el('logJumlah')) el('logJumlah').textContent = '';
      if (lagi) lagi.hidden = true;
    } finally {
      if (token === st.token) {
        wadah.classList.remove('memuat');
        if (lagi) lagi.disabled = false;
      }
    }
  }

  function initLog() {
    if (!el('page-log')) return;
    // Saringan dimulai dari awal tiap kali menu dibuka: default-nya ALL.
    st.role = ''; st.akun = ''; st.kategori = ''; st.q = ''; st.baris = []; st.adaLagi = false;

    el('logRole').addEventListener('click', function (e) {
      const btn = e.target.closest('.seg-btn');
      if (!btn || btn.classList.contains('on')) return;
      el('logRole').querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('on', b === btn); });
      st.role = btn.dataset.role || '';
      isiAkun();
      muat(false);
    });
    el('logAkun').addEventListener('change', function () { st.akun = this.value; muat(false); });
    el('logKategori').addEventListener('change', function () { st.kategori = this.value; muat(false); });
    let tunda = null;
    el('logCari').addEventListener('input', function () {
      const v = this.value.trim();
      clearTimeout(tunda);
      tunda = setTimeout(function () { if (v !== st.q) { st.q = v; muat(false); } }, 300);
    });
    el('logLagi').addEventListener('click', function () { muat(true); });
    if (typeof enhanceSelect === 'function') {
      enhanceSelect(el('logAkun'));
      enhanceSelect(el('logKategori'));
    }
    muat(false);
  }

  /* Export = catatan yang SEDANG tampil (mengikuti saringan). Keterangan memuat teks yang
     diketik orang luar (mis. username pada login gagal): sel yang diawali = + - @ diberi
     tanda petik supaya Excel tidak menjalankannya sebagai rumus. */
  function ekspor() {
    if (!st.baris.length) { showToast('Tidak ada catatan untuk diekspor', 'error'); return; }
    const aman = function (v) { v = v == null ? '' : String(v); return /^[=+\-@]/.test(v) ? "'" + v : v; };
    const rows = [['Waktu', 'Akun', 'Role', 'Kejadian', 'Keterangan', 'Hasil', 'IP', 'Kode aksi']];
    st.baris.forEach(function (b) {
      const u = uraian(b);
      rows.push([(b.created_at || '').replace('T', ' '), b.username || '', b.role || '', u.kalimat, u.rincian,
                 u.hasil, b.ip_address || '', b.action].map(aman));
    });
    downloadCSV('sky-acs-log_' + exportStamp() + '.csv', rows);
  }

  PAGE_INIT['log'] = initLog;
  PAGE_ACTIONS.log = {
    refresh: function (btn) {
      setBtnBusy(btn, true);
      return muat(false).finally(function () { setBtnBusy(btn, false); });
    },
    export: ekspor,
    exportTitle: 'Export catatan yang tampil (CSV)',
  };
})();
