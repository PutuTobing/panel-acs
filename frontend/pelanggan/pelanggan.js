/* ═══════════════════════════════════════════════════════════════
   Portal pelanggan — "WiFi Saya" (2026-10-03)

   Untuk akun ber-role "pelanggan": melihat ONU miliknya (model, RX Power, suhu,
   perangkat terhubung) dan mengatur WiFi — nama & password, nyala/mati SSID —
   serta restart router dan refresh ringan.

   Semua keputusan keamanan ada di server (backend/pelanggan.py):
     • hanya ONU yang dipasangkan administrator pada akun ini;
     • halaman ini TIDAK pernah mengirim nama parameter — hanya {slot, nama, sandi,
       aktif}; server yang menyusun perintahnya lalu mengirimnya lewat pagar & kunci
       operasi yang sama dengan panel.
   Dokumen ONU dibaca dengan kode panel (ACS.mapDevice, _lapData) supaya angkanya sama.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Pel = { user: null, onu: [], cs: '6282217835764', aktif: null, d: null, L: null, sibuk: false };
const $ = id => document.getElementById(id);
const BATAS_TUNGGU = 120000;      // = ACS.SUMMON_WAIT_MS: ONU lambat butuh ~60 dtk membalas

// ─── Jaringan ────────────────────────────────────────────────────
async function minta(url, opsi) {
  opsi = opsi || {};
  const init = { method: opsi.method || 'GET', credentials: 'same-origin', headers: {} };
  if (opsi.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opsi.body);
  }
  const r = await fetch(url, init);
  let data = null;
  try { data = await r.json(); } catch (_) { /* body kosong */ }
  if (r.status === 401 && url !== '/auth/login') { tampilLogin(); }
  return { status: r.status, data: data || {} };
}

// ─── Util tampilan ───────────────────────────────────────────────
const esc = s => escHtml(s);
function nomorCs() {
  const n = String(Pel.cs || '').replace(/^62/, '0');
  return n.replace(/^(\d{4})(\d{4})(\d+)$/, '$1-$2-$3');
}
function tautanWa(teks) {
  return 'https://wa.me/' + encodeURIComponent(Pel.cs) + '?text=' + encodeURIComponent(teks);
}
let _toastT = null;
function toast(pesan, jenis) {
  const t = $('plToast');
  t.className = 'pl-toast ' + (jenis || 'info');
  t.textContent = pesan;
  t.hidden = false;
  clearTimeout(_toastT);
  _toastT = setTimeout(() => { t.hidden = true; }, 4200);
}

function bukaLembar(html) {
  $('plLembar').innerHTML = html;
  $('plLapis').hidden = false;
  requestAnimationFrame(() => $('plLapis').classList.add('buka'));
}
function tutupLembar() {
  if (Pel.sibuk) return;                    // perintah sedang berjalan — jangan hilangkan statusnya
  $('plLapis').classList.remove('buka');
  setTimeout(() => { $('plLapis').hidden = true; $('plLembar').innerHTML = ''; }, 180);
}

/* Permintaan pengguna (2026-10-03): bila perintah gagal / ONU tak menjawab, tampilkan
   pesan dan arahkan ke WhatsApp CS dengan teks yang sudah terisi. Seluruh kartunya tautan. */
function tampilGagal(teksWa, rincian) {
  bukaLembar('<div class="pl-gagal">'
    + '<div class="pl-gagal-ikon"><i class="fas fa-triangle-exclamation"></i></div>'
    + '<h3>Router belum merespons</h3>'
    + '<p>Saat ini router tidak merespon, mohon menunggu atau hubungi customer service di WhatsApp '
    + '<b>' + esc(nomorCs()) + '</b>.</p>'
    + (rincian ? '<p class="pl-redup">' + esc(rincian) + '</p>' : '')
    + '<a class="pl-btn wa" href="' + esc(tautanWa(teksWa)) + '" target="_blank" rel="noopener">'
    + '<i class="fab fa-whatsapp"></i> Hubungi CS lewat WhatsApp</a>'
    + '<button type="button" class="pl-btn" data-aksi="tutup">Tutup</button></div>');
}

// ─── Login ───────────────────────────────────────────────────────
function tampilLogin(pesan) {
  $('plApp').hidden = true;
  $('plLogin').hidden = false;
  $('plBantuanLogin').href = tautanWa('Halo, saya lupa password akun WiFi Saya');
  const g = $('plLoginGalat');
  g.hidden = !pesan;
  g.textContent = pesan || '';
}

async function masuk(e) {
  e.preventDefault();
  const tombol = $('plMasuk');
  tombol.disabled = true;
  const r = await minta('/auth/login', { method: 'POST',
    body: { username: $('plUser').value.trim(), password: $('plPass').value } });
  tombol.disabled = false;
  if (r.status !== 200) { tampilLogin(r.data.error || 'Gagal masuk'); return; }
  $('plPass').value = '';
  mulai();
}

async function keluar() {
  await minta('/auth/logout', { method: 'POST' });
  Pel.user = null;
  tampilLogin();
}

// ─── Mulai ───────────────────────────────────────────────────────
async function mulai() {
  const me = await minta('/auth/me');
  if (me.status !== 200) { tampilLogin(); return; }
  const u = me.data.user;
  if (u.role !== 'pelanggan') {
    // Akun staf membuka alamat pelanggan → antar ke panel.
    location.replace('/');
    return;
  }
  Pel.user = u;
  $('plLogin').hidden = true;
  $('plApp').hidden = false;
  $('plNama').textContent = u.name || u.username;
  const r = await minta('/pel/onu');
  if (r.status !== 200) { $('plIsi').innerHTML = '<div class="pl-muat">' + esc(r.data.error || 'Gagal memuat') + '</div>'; return; }
  Pel.onu = r.data.onu || [];
  Pel.cs = r.data.cs || Pel.cs;
  // Pemetaan & ambang dari server — supaya angka di sini sama dengan di panel.
  try {
    if (r.data.vpMapping && typeof VPMap !== 'undefined') VPMap.setPeta(r.data.vpMapping);
    if (r.data.params) localStorage.setItem('acsConfig', JSON.stringify(r.data.params));
  } catch (_) { /* penyimpanan diblokir — pakai bawaan */ }
  $('plBantuan').href = tautanWa('Halo, saya butuh bantuan untuk WiFi saya');
  if (!Pel.onu.length) {
    $('plIsi').innerHTML = '<div class="pl-kosong"><i class="fas fa-router"></i>'
      + '<p>Belum ada router yang terhubung ke akun Anda.</p>'
      + '<a class="pl-btn wa" href="' + esc(tautanWa('Halo, akun WiFi Saya belum terhubung ke router saya')) + '" target="_blank" rel="noopener">'
      + '<i class="fab fa-whatsapp"></i> Hubungi customer service</a></div>';
    return;
  }
  let pilih = null;
  try { pilih = localStorage.getItem('plOnu'); } catch (_) { /* abaikan */ }
  gambarPilihan();
  muatOnu(Pel.onu.some(o => o.id === pilih) ? pilih : Pel.onu[0].id);
}

function gambarPilihan() {
  const w = $('plPilihOnu');
  w.hidden = Pel.onu.length < 2;
  w.innerHTML = Pel.onu.map(o => '<button type="button" data-onu="' + esc(o.id) + '"'
    + (o.id === Pel.aktif ? ' class="aktif"' : '') + '><i class="fas fa-router"></i> ' + esc(o.sn) + '</button>').join('');
}

async function muatOnu(id) {
  Pel.aktif = id;
  try { localStorage.setItem('plOnu', id); } catch (_) { /* abaikan */ }
  gambarPilihan();
  const r = await minta('/pel/onu/' + encodeURIComponent(id));
  if (r.status !== 200) {
    $('plIsi').innerHTML = '<div class="pl-muat">' + esc(r.data.error || 'Gagal memuat data router') + '</div>';
    return;
  }
  Pel.d = ACS.mapDevice(r.data.dok);
  Pel.L = _lapData(Pel.d);
  gambar();
}

// ─── Gambar halaman ──────────────────────────────────────────────
function gambar() {
  const d = Pel.d, L = Pel.L;
  const grup = {};
  generateConnectionGroups(d).forEach(g => { grup[g.id] = g; });
  const petak = (ikon, label, nilai, mutu) => '<div class="pl-petak' + (mutu ? ' ' + mutu.kls : '') + '">'
    + '<span><i class="fas ' + ikon + '"></i> ' + label + '</span><b>' + nilai + '</b>'
    + (mutu ? '<em>' + esc(mutu.teks) + '</em>' : '') + '</div>';

  const ssids = d.ssids || [];
  const kartuSsid = s => {
    const g = grup['ssid' + s.idx];
    const aman = /wpa|11i/i.test(String(s.beaconType || ''));
    const nama = (g && g.devices || []).map(x => (x.name && x.name !== '—') ? x.name : 'tanpa nama');
    return '<div class="pl-wifi' + (s.enabled ? '' : ' mati') + '">'
      + '<div class="pl-wifi-atas"><i class="fas fa-wifi"></i>'
      + '<div class="pl-wifi-nama"><b>' + esc(s.name) + '</b><small>' + (is5GHz(s) ? '5 GHz' : '2.4 GHz')
      + (aman ? ' · <i class="fas fa-lock"></i> berpassword' : ' · tanpa password') + '</small></div>'
      + '<label class="pl-saklar" title="' + (s.enabled ? 'Matikan' : 'Nyalakan') + ' WiFi ini">'
      + '<input type="checkbox" data-saklar="' + s.idx + '"' + (s.enabled ? ' checked' : '') + '><span></span></label></div>'
      + (s.enabled ? '<div class="pl-wifi-klien">' + (nama.length
          ? '<span class="pl-jml">' + nama.length + ' perangkat terhubung</span>'
            + nama.map(n => '<span class="pl-chip"><i class="fas fa-mobile-screen"></i>' + esc(n) + '</span>').join('')
          : '<span class="pl-jml">Belum ada perangkat terhubung</span>') + '</div>' : '')
      + '<button type="button" class="pl-btn kecil" data-ubah="' + s.idx + '"><i class="fas fa-pen"></i> Ubah nama &amp; password</button>'
      + '</div>';
  };
  const nyala = ssids.filter(s => s.enabled), mati = ssids.filter(s => !s.enabled);
  const lan = grup.lan;

  $('plIsi').innerHTML =
      '<div class="pl-perangkat">'
    + '<div class="pl-foto">' + (L.foto ? '<img src="' + esc(L.foto) + '" alt="">' : '<i class="fas fa-router"></i>') + '</div>'
    + '<div class="pl-id"><small>Router Anda</small><b>' + esc(L.model) + '</b>'
    + (L.mfr ? '<span>' + esc(L.mfr) + '</span>' : '')
    + '<span class="pl-status ' + (L.online ? 'on' : 'off') + '"><i></i> ' + (L.online ? 'Online' : 'Offline') + '</span></div></div>'
    + (L.online ? '' : '<div class="pl-catatan"><i class="fas fa-circle-info"></i> Router sedang tidak terhubung. '
        + 'Data di bawah adalah data terakhir' + (L.segarPenuh ? ' (' + esc(L.segarPenuh) + ')' : '') + '.</div>')
    + '<div class="pl-stat">'
    + petak('fa-signal', 'Sinyal Optik', L.rx != null ? esc(L.rx.toFixed(2)) + ' <small>dBm</small>' : '—', L.rxMutu)
    + petak('fa-temperature-half', 'Suhu Router', L.suhu != null ? esc(String(L.suhu)) + ' <small>°C</small>' : '—', L.suhuMutu)
    + petak('fa-stopwatch', 'Menyala', L.uptime ? esc(L.uptime) : '—')
    + petak('fa-mobile-screen', 'Perangkat', esc(String(L.total)) + ' <small>terhubung</small>')
    + '</div>'
    + '<div class="pl-aksi">'
    + '<button type="button" class="pl-btn" id="plRefresh"><i class="fas fa-rotate"></i> Perbarui data</button>'
    + '<button type="button" class="pl-btn bahaya" id="plReboot"><i class="fas fa-power-off"></i> Restart router</button>'
    + '</div>'
    + '<h2 class="pl-judul"><i class="fas fa-wifi"></i> WiFi Anda</h2>'
    + (nyala.map(kartuSsid).join('') || '<div class="pl-catatan">Semua WiFi sedang mati.</div>')
    + (mati.length ? '<details class="pl-mati"><summary>WiFi yang dimatikan (' + mati.length + ')</summary>'
        + mati.map(kartuSsid).join('') + '</details>' : '')
    + (lan && lan.count ? '<h2 class="pl-judul"><i class="fas fa-ethernet"></i> Terhubung lewat kabel</h2>'
        + '<div class="pl-wifi"><div class="pl-wifi-klien">'
        + lan.devices.map(x => '<span class="pl-chip"><i class="fas fa-desktop"></i>'
            + esc(x.name && x.name !== '—' ? x.name : 'tanpa nama') + '</span>').join('') + '</div></div>' : '')
    + '<p class="pl-segar">Data terakhir dari router: <b>' + esc(L.segarPenuh || L.segar || '—') + '</b></p>';
}

// ─── Form ubah WiFi ──────────────────────────────────────────────
function bukaUbah(idx) {
  const s = (Pel.d.ssids || []).find(x => x.idx === idx);
  if (!s) return;
  const aman = /wpa|11i/i.test(String(s.beaconType || ''));
  bukaLembar('<form class="pl-form" id="plFormWifi">'
    + '<h3><i class="fas fa-wifi"></i> Ubah WiFi</h3>'
    + '<label>Nama WiFi<input id="plNamaWifi" maxlength="32" autocomplete="off" spellcheck="false" required value="' + esc(s.name) + '"></label>'
    + (aman
        ? '<label>Password WiFi<span class="pl-sandi"><input id="plSandiWifi" type="password" minlength="8" maxlength="63"'
          + ' autocomplete="new-password" spellcheck="false" placeholder="Minimal 8 karakter" value="' + esc(s.password || '') + '">'
          + '<button type="button" class="pl-mata" data-mata="plSandiWifi" aria-label="Tampilkan password"><i class="fas fa-eye"></i></button></span></label>'
          + '<p class="pl-redup">Kosongkan atau biarkan bila password tidak diganti.</p>'
        : '<p class="pl-catatan">WiFi ini tanpa password. Untuk memasang password, hubungi customer service.</p>')
    + '<div class="pl-galat" id="plWifiGalat" hidden></div>'
    + '<div class="pl-status-kirim" id="plWifiStatus" hidden></div>'
    + '<div class="pl-form-tombol"><button type="button" class="pl-btn" data-aksi="tutup">Batal</button>'
    + '<button type="submit" class="pl-btn utama" id="plSimpanWifi"><i class="fas fa-floppy-disk"></i> Simpan</button></div>'
    + '<p class="pl-redup">Sesudah disimpan, semua HP/laptop perlu tersambung ulang ke WiFi dengan nama/password baru.</p>'
    + '</form>');
  $('plFormWifi').addEventListener('submit', e => {
    e.preventDefault();
    const nama = $('plNamaWifi').value.trim();
    const sandiEl = $('plSandiWifi');
    const sandi = sandiEl ? sandiEl.value : '';
    const body = { slot: idx };
    if (nama !== s.name) body.nama = nama;
    if (sandiEl && sandi && sandi !== (s.password || '')) body.sandi = sandi;
    const g = $('plWifiGalat');
    if (!nama) { g.textContent = 'Nama WiFi tidak boleh kosong'; g.hidden = false; return; }
    if (body.sandi !== undefined && (body.sandi.length < 8 || body.sandi.length > 63)) {
      g.textContent = 'Password WiFi 8–63 karakter'; g.hidden = false; return;
    }
    if (body.nama === undefined && body.sandi === undefined) { g.textContent = 'Tidak ada perubahan'; g.hidden = false; return; }
    g.hidden = true;
    kirim('wifi', body, {
      tombol: $('plSimpanWifi'), status: $('plWifiStatus'),
      berhasil: 'WiFi berhasil diubah. Sambungkan ulang perangkat Anda ke WiFi ' + nama + '.',
      teksWa: 'saya mengalami kendala mengganti nama dan password wifi saya',
      galatForm: g,
    });
  });
}

/* Kirim satu perintah lalu tunggu NASIBNYA (bukan sekadar terkirim):
     200            → ONU sudah menjalankan di sesi itu
     202 + _id      → mengantre; tanya /pel/onu/<id>/tugas/<taskId> sampai selesai/gagal
     400            → isian ditolak server (tampil di form)
     429            → ONU sedang mengerjakan perintah lain / masa istirahat
     lainnya/timeout → pesan "router tidak merespon" + WhatsApp CS. */
async function kirim(aksi, body, o) {
  if (Pel.sibuk) return 'ditolak';
  Pel.sibuk = true;
  const tombol = o.tombol, asli = tombol ? tombol.innerHTML : '';
  const status = t => { if (o.status) { o.status.hidden = !t; o.status.textContent = t || ''; } };
  if (tombol) { tombol.disabled = true; tombol.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengirim…'; }
  status('Mengirim perintah ke router…');
  const pulih = () => { Pel.sibuk = false; if (tombol) { tombol.disabled = false; tombol.innerHTML = asli; } };
  let hasil = 'gagal', rincian = '';
  try {
    const r = await minta('/pel/onu/' + encodeURIComponent(Pel.aktif) + '/' + aksi, { method: 'POST', body: body || {} });
    if (r.status === 400 && o.galatForm) {
      pulih(); status('');
      o.galatForm.textContent = r.data.error || 'Isian ditolak';
      o.galatForm.hidden = false;
      return 'ditolak';
    }
    if (r.status === 429) {
      pulih(); status('');
      toast(r.data.error || 'Router sedang memproses perintah lain. Coba lagi sebentar.', 'info');
      return 'ditolak';
    }
    if (r.status === 200 && !r.data.diikutkan) hasil = 'selesai';
    else if ((r.status === 202 || r.status === 200) && r.data._id) {
      const mulai = Date.now();
      hasil = 'menunggu';
      while (Date.now() - mulai < BATAS_TUNGGU) {
        status('Menunggu router menerapkan… ' + Math.ceil((BATAS_TUNGGU - (Date.now() - mulai)) / 1000) + ' dtk');
        await new Promise(res => setTimeout(res, 3000));
        const t = await minta('/pel/onu/' + encodeURIComponent(Pel.aktif) + '/tugas/' + encodeURIComponent(r.data._id));
        if (t.status === 200 && t.data.state !== 'menunggu') { hasil = t.data.state; break; }
      }
    } else if (r.status === 200 && r.data.diikutkan) {
      hasil = 'selesai';           // perintah yang sama sedang dikerjakan — hasilnya sama
    } else {
      rincian = r.data.error || '';
    }
  } catch (_) {
    rincian = 'Koneksi ke server terputus.';
  }
  pulih();
  status('');
  if (hasil === 'selesai') {
    if (aksi !== 'refresh') tutupLembar();
    toast(o.berhasil, 'sukses');
    setTimeout(() => muatOnu(Pel.aktif), aksi === 'reboot' ? 0 : 800);
  } else {
    tutupLembar();
    setTimeout(() => tampilGagal(o.teksWa, rincian), 200);
  }
  return hasil;
}

function saklar(idx, nyala, el) {
  const s = (Pel.d.ssids || []).find(x => x.idx === idx);
  const nama = s ? s.name : 'WiFi';
  const balik = () => { el.checked = !nyala; };
  if (!nyala && (Pel.d.ssids || []).filter(x => x.enabled).length === 1) {
    if (!window.confirm('Ini satu-satunya WiFi yang menyala. Bila dimatikan, semua perangkat WiFi terputus. Lanjutkan?')) { balik(); return; }
  }
  el.disabled = true;
  kirim('wifi', { slot: idx, aktif: nyala }, {
    berhasil: 'WiFi ' + nama + (nyala ? ' dinyalakan' : ' dimatikan'),
    teksWa: 'saya mengalami kendala mengganti nama dan password wifi saya',
  }).then(h => { el.disabled = false; if (h !== 'selesai') balik(); });
}

function restart() {
  bukaLembar('<div class="pl-form"><h3><i class="fas fa-power-off"></i> Restart router?</h3>'
    + '<p>Internet & WiFi akan terputus sekitar 1–3 menit selama router menyala ulang.</p>'
    + '<div class="pl-status-kirim" id="plRebootStatus" hidden></div>'
    + '<div class="pl-form-tombol"><button type="button" class="pl-btn" data-aksi="tutup">Batal</button>'
    + '<button type="button" class="pl-btn bahaya" id="plYaReboot"><i class="fas fa-power-off"></i> Ya, restart</button></div></div>');
  $('plYaReboot').addEventListener('click', () => kirim('reboot', {}, {
    tombol: $('plYaReboot'), status: $('plRebootStatus'),
    berhasil: 'Router sedang restart. Internet akan kembali dalam 1–3 menit.',
    teksWa: 'saya mengalami kendala saat restart router saya',
  }));
}

function perbarui(tombol) {
  kirim('refresh', {}, {
    tombol: tombol,
    berhasil: 'Data WiFi & perangkat terhubung sudah diperbarui',
    teksWa: 'saya mengalami kendala memperbarui data router saya',
  });
}

function bukaAkun() {
  bukaLembar('<form class="pl-form" id="plFormAkun"><h3><i class="fas fa-user"></i> Ganti password akun</h3>'
    + '<p class="pl-redup">Akun: <b>' + esc(Pel.user.username) + '</b></p>'
    + '<label>Password lama<input type="password" id="plSandiLama" autocomplete="current-password" required></label>'
    + '<label>Password baru<input type="password" id="plSandiBaru" autocomplete="new-password" minlength="10" required></label>'
    + '<p class="pl-redup">Minimal 10 karakter, memuat 3 dari: huruf kecil, huruf besar, angka, simbol.</p>'
    + '<div class="pl-galat" id="plAkunGalat" hidden></div>'
    + '<div class="pl-form-tombol"><button type="button" class="pl-btn" data-aksi="tutup">Batal</button>'
    + '<button type="submit" class="pl-btn utama"><i class="fas fa-key"></i> Simpan</button></div></form>');
  $('plFormAkun').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await minta('/auth/users/' + encodeURIComponent(Pel.user.id), { method: 'PATCH',
      body: { password: $('plSandiBaru').value, currentPassword: $('plSandiLama').value } });
    if (r.status !== 200) { const g = $('plAkunGalat'); g.textContent = r.data.error || 'Gagal'; g.hidden = false; return; }
    tutupLembar();
    toast('Password akun diganti. Silakan masuk kembali.', 'sukses');
    setTimeout(() => tampilLogin(), 1200);
  });
}

// ─── Pemasangan ──────────────────────────────────────────────────
document.addEventListener('click', e => {
  const mata = e.target.closest('[data-mata]');
  if (mata) {
    const inp = $(mata.dataset.mata);
    if (inp) { inp.type = inp.type === 'password' ? 'text' : 'password'; mata.innerHTML = '<i class="fas fa-eye' + (inp.type === 'text' ? '-slash' : '') + '"></i>'; }
    return;
  }
  if (e.target.closest('[data-aksi="tutup"]') || e.target === $('plLapis')) { tutupLembar(); return; }
  const onu = e.target.closest('[data-onu]');
  if (onu) { muatOnu(onu.dataset.onu); return; }
  const ubah = e.target.closest('[data-ubah]');
  if (ubah) { bukaUbah(parseInt(ubah.dataset.ubah, 10)); return; }
  if (e.target.closest('#plReboot')) { restart(); return; }
  const ref = e.target.closest('#plRefresh');
  if (ref) { perbarui(ref); return; }
  if (e.target.closest('#plKeluar')) { keluar(); return; }
  if (e.target.closest('#plAkun')) { bukaAkun(); }
});
document.addEventListener('change', e => {
  const s = e.target.closest('[data-saklar]');
  if (s) saklar(parseInt(s.dataset.saklar, 10), s.checked, s);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') tutupLembar(); });
$('plFormLogin').addEventListener('submit', masuk);

mulai();
