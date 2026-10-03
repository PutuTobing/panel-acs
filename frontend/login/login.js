/* ═══════════════════════════════════════════════════════════════
   Halaman /login — pintu masuk tunggal semua role (2026-10-03)

   Dulu layar login tertanam di index.html (panel) dan portal pelanggan punya form
   sendiri. Akibatnya: akun pelanggan yang masuk lewat panel sempat MELIHAT dashboard
   sekilas sebelum dialihkan (aplikasi panel keburu dimuat), dan ada dua tampilan login.
   Kini satu halaman ringan — tanpa kode panel, tanpa data ONU:
     belum ada akun sama sekali → form INSTALASI (membuat administrator pertama)
     sudah login                → langsung ke rumahnya
     berhasil masuk             → pelanggan ke /pelanggan, staf ke panel
   Pengalihan menurut role juga ditegakkan SERVER sebelum halaman apa pun dikirim
   (_alihkan_halaman di server.py) — halaman ini hanya menyamakan pengalamannya.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const $ = id => document.getElementById(id);
  // Tema mengikuti pilihan terakhir di perangkat ini (disimpan panel di localStorage).
  try { document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'light'); } catch (_) { /* abaikan */ }

  async function minta(url, body) {
    const o = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      o.method = 'POST';
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(body);
    }
    const r = await fetch(url, o);
    let d = null;
    try { d = await r.json(); } catch (_) { /* body kosong */ }
    return { ok: r.ok, status: r.status, data: d || {} };
  }

  /* Tujuan sesudah masuk. `lanjut` (alamat yang tadinya dibuka) hanya dipakai staf dan
     hanya bila ia jalur LOKAL milik panel — bukan alamat luar ("//jahat.example",
     "https://…") yang diselipkan orang lewat tautan. */
  function rumah(user) {
    if (user && user.role === 'pelanggan') return '/pelanggan';
    let lanjut = '';
    try { lanjut = new URLSearchParams(location.search).get('lanjut') || ''; } catch (_) { lanjut = ''; }
    return /^\/(dashboard|devices|maps|settings|log)(\/[A-Za-z0-9._~%-]*)*$/.test(lanjut) ? lanjut : '/';
  }
  const pergi = user => location.replace(rumah(user));

  function mata(tombol, input) {
    if (!tombol || !input) return;
    tombol.addEventListener('click', () => {
      const tampil = input.type === 'password';
      input.type = tampil ? 'text' : 'password';
      tombol.innerHTML = '<i class="fas fa-eye' + (tampil ? '-slash' : '') + '"></i>';
    });
  }
  function goyang(layar) {
    const kartu = layar.querySelector('.login-card');
    if (kartu) { kartu.classList.remove('shake'); void kartu.offsetWidth; kartu.classList.add('shake'); }
  }

  // ─── Form masuk ───
  // Catatan (dibawa dari main.js): banner "koneksi tidak terenkripsi" di layar ini
  // DIHAPUS atas permintaan (PRD 6.2). Yang hilang hanya teksnya, bukan risikonya —
  // selama panel dilayani lewat HTTP polos, password dan cookie sesi tetap melintas
  // sebagai teks terang. Peringatannya kini hanya muncul di log server tiap start;
  // hanya TLS yang benar-benar menutupnya (README bagian Keamanan).
  function tampilLogin() {
    $('setupScreen').hidden = true;
    $('loginScreen').hidden = false;
    const u = $('loginUser');
    if (u) setTimeout(() => u.focus(), 60);
  }
  mata($('loginEye'), $('loginPass'));
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('loginError'), btn = $('loginBtn');
    err.hidden = true;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Memeriksa…</span>';
    let r;
    try {
      r = await minta('/auth/login', { username: $('loginUser').value, password: $('loginPass').value });
    } catch (_) {
      r = { ok: false, data: { error: 'Server tidak bisa dihubungi' } };
    }
    if (r.ok) { $('loginPass').value = ''; pergi(r.data.user); return; }
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-right-to-bracket"></i> <span>Masuk</span>';
    err.textContent = r.data.error || 'Login gagal';
    err.hidden = false;
    goyang($('loginScreen'));
  });

  // ─── Form instalasi pertama (administrator pertama) ───
  function tampilSetup(butuhKode) {
    $('loginScreen').hidden = true;
    $('setupScreen').hidden = false;
    $('setupCodeWrap').hidden = !butuhKode;
    setTimeout(() => $('setupName').focus(), 60);
  }
  mata($('setupEye'), $('setupPass'));
  // Username diusulkan dari email (bagian sebelum @) selama belum diketik sendiri.
  $('setupEmail').addEventListener('input', () => {
    const us = $('setupUser');
    if (us.dataset.diketik) return;
    us.value = $('setupEmail').value.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  });
  $('setupUser').addEventListener('input', () => { $('setupUser').dataset.diketik = '1'; });
  $('setupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('setupError'), btn = $('setupBtn');
    const galat = t => { err.textContent = t; err.hidden = false; };
    err.hidden = true;
    if ($('setupPass').value !== $('setupPass2').value) { galat('Password dan ulangannya tidak sama.'); return; }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Membuat akun…</span>';
    let r;
    try {
      r = await minta('/auth/setup', { name: $('setupName').value.trim(), email: $('setupEmail').value.trim(),
        username: $('setupUser').value.trim(), password: $('setupPass').value, code: $('setupCode').value });
    } catch (_) {
      r = { ok: false, status: 0, data: { error: 'Server tidak bisa dihubungi' } };
    }
    if (r.ok) { pergi(r.data.user); return; }
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-user-shield"></i> <span>Buat akun administrator</span>';
    // 409 = akun sudah dibuat (mis. dari tab/komputer lain) → form masuk biasa.
    if (r.status === 409) { tampilLogin(); return; }
    galat(r.data.error || 'Gagal membuat akun');
    goyang($('setupScreen'));
  });

  const th = $('loginTahun');
  if (th) th.textContent = new Date().getFullYear();

  // ─── Mulai ───
  (async function mulai() {
    try {
      const me = await minta('/auth/me');
      if (me.ok && me.data.user) { pergi(me.data.user); return; }
      const s = await minta('/auth/setup');
      if (s.ok && s.data.perlu) { tampilSetup(!!s.data.butuhKode); return; }
    } catch (_) { /* server tak terjangkau → form masuk; pesannya muncul saat dicoba */ }
    tampilLogin();
  })();
})();
