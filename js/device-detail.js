/* ═══════════════════════════════════════════════════════════════
   Panel ACS — Device Detail Module
   (Topology, GPON stats, connected clients, device info grid)
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── Fault poll interval handle (Setting tab) ─────────────────
var _settFaultIv = null;

// ─── rxSvClass helper: CSS class name for RX power value (device-detail) ───
// Distinct name from devices.js rxClass() to avoid global override (load order).
function rxSvClass(rx) {
  const v = parseFloat(rx);
  if (isNaN(v)) return '';
  const t = ACS.rxThr();
  return v >= t.good ? 'sv-green' : v >= t.fair ? 'sv-amber' : 'sv-red';
}

// ─── Detect 5GHz from SSID metadata ───
function is5GHz(ssid) {
  // Sumber OTORITATIF: band dari nomor slot (profil vendor band5MinIdx — mis. HWTC
  // ZL-4224X: slot 1-4 = 2.4G, 5-8 = 5G). Dipakai HANYA bila profil menyatakannya;
  // vendor lain (ZTE dll) → band5 undefined → heuristik lama, byte-identik.
  if (typeof ssid.band5 === 'boolean') return ssid.band5;
  if (ssid.channel >= 36) return true;
  const n = (ssid.name || '').toLowerCase();
  if (n.includes('5g') || n.includes('5ghz')) return true;
  const std = (ssid.standard || '').toLowerCase();
  return std === 'ac' || std === 'ax';
}

// ─── Generate SSID + LAN connection groups from real GenieACS data ───
function generateConnectionGroups(d) {
  const wifiHosts = (d.hostList || []).filter(h => h.type === '802.11');
  const lanHosts  = (d.hostList || []).filter(h => h.type === 'Ethernet');
  const groups    = [];

  // Keluarga X_CT-COM (CDTC/C-DATA & HWTC): host bisa membawa detail kaya
  // (X_CMS_WirelessTerminal/NegotiationRate — C-DATA FD514GD) ATAU Layer2Interface→
  // WLANConfiguration.N (FD512XW & HWTC ZL-2113X). Vendor lain (mis. ZTE) memiliki param
  // host yang MIRIP (Layer2Interface/AddressSource juga ada) → gate fitur ini via
  // manufacturer agar jalur ZTE TAK berubah (byte-identik). HWTC: InterfaceType='WLAN'
  // sudah dinormalkan ke '802.11' di api.js; band diturunkan dari SSID (tak ada X_CMS).
  // Huawei ikut: ia melaporkan Layer2Interface='WLANConfiguration.N' per klien —
  // atribusi klien→SSID yang PASTI, bukan tebakan. Tanpa masuk jalur ini,
  // klien Huawei jatuh ke pembagian buta menurut TotalAssociations dan bisa
  // nyangkut di SSID yang salah. ZTE sengaja TIDAK ikut walau punya param
  // serupa — jalurnya sudah berjalan pada 1.500 unit dan dijaga byte-identik.
  const isCtCom = /CDTC|HWTC|Huawei/i.test(String((d && d.mfr) || ''));
  // Atribusi PRESISI klien→SSID juga dipakai bila firmware melaporkan telemetri radio
  // per-klien (AssociatedDevice → h.radio.ssidIdx): Huawei X_HW, ZTE F679L, dst. Tanpa ini
  // klien dibagi BUTA menurut TotalAssociations (ambil N pertama dari kolam Hosts.Host) —
  // urutan kolam tak dijamin, jadi klien bisa nyangkut di SSID yang salah / hilang dari
  // daftar. ZTE F663 (tak punya AssociatedDevice) tetap di jalur lama → byte-identik.

  // Objek perangkat utk UI. SETIAP klien nirkabel diberi `detail` → popup hover muncul di
  // SEMUA vendor. Isi popup MENYESUAIKAN data yang ada: bila firmware melaporkan telemetri
  // radio (h.radio — ZTE F679L/F670L, Huawei) tampil sinyal/laju; bila tidak (F9V, F663,
  // C-DATA tanpa X_CMS) tampil info dasar yang selalu ada dari Hosts.Host — SSID, band, MAC,
  // IP, sumber alamat. `ssid` opsional → mengisi band turunan + nama SSID terhubung.
  const _hostDev = (h, icon, ssid) => {
    // hostIdx dibawa agar baris ini bisa menarik detail lengkapnya sendiri
    // (per klien — lihat ACS.fetchHostDetail). Klien tanpa indeks tidak
    // mendapat tombol, bukan tombol yang gagal saat ditekan.
    const dev = { name: h.name, ip: h.ip, mac: h.mac, icon: icon, hostIdx: h.hostIdx };
    const rd = h.radio || null;
    if (h.type === '802.11') dev.detail = {
      name: h.name, ip: h.ip, mac: h.mac,
      band: h.band || (ssid ? (is5GHz(ssid) ? '5G' : '2.4G') : null),
      ssid: ssid ? ssid.name : null,
      negotiationRate: h.negotiationRate || null,
      addressSource:   h.addressSource || null,
      radio: rd,   // null → popup tampil versi info dasar
    };
    return dev;
  };

  // WiFi groups: only enabled SSIDs
  const enabledSsids = (d.ssids || []).filter(s => s.enabled);

  // Jumlah asosiasi per-SSID (dari TotalAssociations). Sebagian vendor (mis. C-DATA
  // X_CT-COM) TIDAK melaporkan TotalAssociations → semua SSID = 0 walau ada klien
  // WiFi nyata di Hosts.Host. ZTE (punya TotalAssociations>0) memakai jalur distribusi
  // per-SSID lama — tak berubah.
  const totalAssoc = enabledSsids.reduce((s, x) => s + (x.associations || 0), 0);

  // Atribusi klien→SSID C-DATA. Dua sumber (lebih akurat dari distribusi TotalAssociations):
  //  (1) Layer2Interface → 'WLANConfiguration.N' = SSID tepat (FD512XW-R460).
  //  (2) X_CMS_WirelessTerminal (h.band '2.4G'/'5G') → SSID aktif pertama band cocok (FD514GD-R460).
  // Dipakai utk C-DATA bila salah satu sumber ada — TERMASUK saat TotalAssociations>0
  // (FD512XW lapor TotalAssociations tapi Layer2Interface memberi atribusi per-host presisi).
  const wlanIdxOf   = h => {
    // (0) SSID dari telemetri radio (paling tepat: dilaporkan radio itu sendiri).
    if (h.radio && h.radio.ssidIdx) return h.radio.ssidIdx;
    const m = /WLANConfiguration\.(\d+)/.exec(String(h.layer2 || '')); return m ? parseInt(m[1]) : null;
  };
  const bandKeyOf   = b => /5/.test(String(b || '')) ? '5G' : '2.4G';
  const wifiHasAttr = wifiHosts.some(h => h.band || wlanIdxOf(h) != null);
  const hasRadioIdx = wifiHosts.some(h => h.radio && h.radio.ssidIdx);

  if ((isCtCom || hasRadioIdx) && wifiHosts.length > 0 && wifiHasAttr) {
    const assigned    = {};   // ssidIdx → [hosts]
    const enabledIdx  = {};   enabledSsids.forEach(s => { enabledIdx[s.idx] = s; });
    const firstByBand = {};   enabledSsids.forEach(s => { const b = is5GHz(s) ? '5G' : '2.4G'; if (!firstByBand[b]) firstByBand[b] = s; });
    const leftover    = [];
    wifiHosts.forEach(h => {
      const wi = wlanIdxOf(h);
      const target = (wi != null && enabledIdx[wi]) ? enabledIdx[wi]        // (1) Layer2 tepat
                   : (h.band && firstByBand[bandKeyOf(h.band)]) ? firstByBand[bandKeyOf(h.band)] // (2) band
                   : null;
      if (target) (assigned[target.idx] = assigned[target.idx] || []).push(h);
      else leftover.push(h);
    });
    enabledSsids.forEach(ssid => {
      const band5 = is5GHz(ssid);
      const mine  = assigned[ssid.idx] || [];
      groups.push({
        id:      'ssid' + ssid.idx,
        label:   'SSID ' + ssid.idx,
        name:    ssid.name,
        meta:    band5 ? '5GHz' : '2.4GHz',
        type:    band5 ? 'wifi5' : (ssid.idx === 1 ? 'wifi2' : 'guest'),
        count:   mine.length,
        devices: mine.map(h => _hostDev(h, 'fa-mobile-screen', ssid)),
      });
    });
    // Klien yang tak bisa diatribusikan (band/WLAN tanpa SSID aktif cocok) → grup cadangan.
    if (leftover.length > 0) {
      groups.push({
        id: 'wifi', label: 'WiFi', name: 'Perangkat WiFi lain', meta: 'WiFi', type: 'wifi5',
        count: leftover.length,
        devices: leftover.map(h => _hostDev(h, 'fa-mobile-screen')),
      });
    }
  } else if (totalAssoc === 0 && wifiHosts.length > 0) {
    groups.push({
      id:      'wifi',
      label:   'WiFi',
      name:    'Perangkat WiFi',
      meta:    'WiFi',
      type:    'wifi5',
      count:   wifiHosts.length,
      devices: wifiHosts.map(h => _hostDev(h, 'fa-mobile-screen')),
    });
  } else {
    // Distribute Hosts.Host pool by TotalAssociations count per SSID (perilaku ZTE).
    let wifiPool = [...wifiHosts];
    enabledSsids.forEach(ssid => {
      const band    = is5GHz(ssid);
      const bandLbl = band ? '5GHz' : '2.4GHz';
      const type    = band ? 'wifi5' : (ssid.idx === 1 ? 'wifi2' : 'guest');
      // Take `associations` hosts from pool for this SSID
      const assocCount = ssid.associations || 0;
      const take       = Math.min(assocCount, wifiPool.length);
      const devices    = wifiPool.splice(0, take).map(h => _hostDev(h, 'fa-mobile-screen', ssid));
      groups.push({
        id:      'ssid' + ssid.idx,
        label:   'SSID ' + ssid.idx,
        name:    ssid.name,
        meta:    bandLbl,
        type,
        count:   assocCount,   // real count from TotalAssociations
        devices,               // real device list matched from Hosts.Host
      });
    });
  }

  // LAN group: show if there are Ethernet hosts
  if (lanHosts.length > 0) {
    groups.push({
      id:      'lan',
      label:   'LAN',
      name:    'LAN Clients',
      meta:    'Ethernet',
      type:    'lan',
      count:   lanHosts.length,
      devices: lanHosts.map(h => _hostDev(h, 'fa-desktop')),
    });
  }

  return groups;
}

// ─── Popup hover detail perangkat WiFi C-DATA ─────────────────────────────────
// Tooltip di-append ke <body> (position:fixed) agar tak terpotong container
// scroll/overflow milik daftar klien. Data dibaca dari data-* attribute baris.
function _hostTipEl() {
  var t = document.getElementById('hostTip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'hostTip';
    t.className = 'host-tip';
    document.body.appendChild(t);
    // Popup dijangkarkan pada posisi baris SAAT kursor masuk. Bila halaman di-scroll
    // atau jendela diubah ukurannya, jangkar itu jadi basi → sembunyikan (bukan
    // mengikuti), agar tak ada kotak melayang lepas dari barisnya.
    window.addEventListener('scroll', _hostTipHide, true);   // true: tangkap scroll container
    window.addEventListener('resize', _hostTipHide);
  }
  return t;
}
// Kualitas sinyal WiFi dari RSSI (dBm) — ambang lapangan yang lazim.
function _rssiQual(rssi) {
  if (rssi == null || isNaN(rssi)) return null;
  if (rssi >= -55) return { label: 'Sangat Baik', cls: 'q-exc',  pct: 100 };
  if (rssi >= -65) return { label: 'Baik',        cls: 'q-good', pct: 75  };
  if (rssi >= -72) return { label: 'Cukup',       cls: 'q-fair', pct: 50  };
  if (rssi >= -80) return { label: 'Lemah',       cls: 'q-weak', pct: 28  };
  return              { label: 'Sangat Lemah',    cls: 'q-bad',  pct: 12  };
}
function _fmtBytes(n) {
  var v = parseFloat(n);
  if (isNaN(v) || v <= 0) return null;
  var u = ['B','KB','MB','GB','TB'], i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + u[i];
}
/* ─── Detail lengkap satu klien ─────────────────────────────────────────────
   Popup hover menampilkan apa yang SUDAH tersimpan. Tombol ini menarik yang
   BELUM pernah dibaca: IPv6, sisa lease, sumber alamat, kelas vendor, dan —
   pada Huawei — RSSI, laju negosiasi, serta byte terpakai.

   Sengaja per klien dan hanya saat ditekan. Provision `default` cuma
   menyegarkan empat field Hosts.Host; membaca sisanya secara berkala berarti
   ±43.000 pembacaan parameter se-armada tiap penyegaran, pada sub-pohon yang
   sudah paling berat. Satu klien = ~16 parameter, ±2,6 detik. */
var _hostDetailModal = null;

function _hostDetailEl() {
  if (_hostDetailModal && document.body.contains(_hostDetailModal)) return _hostDetailModal;
  var el = document.createElement('div');
  el.className = 'hd-overlay hidden';
  el.innerHTML = '<div class="hd-box">'
    + '<div class="hd-head"><span id="hdTitle"></span>'
    + '<button type="button" class="hd-close" title="Tutup">&times;</button></div>'
    + '<div class="hd-body" id="hdBody"></div></div>';
  el.addEventListener('click', function(e) {
    if (e.target === el || e.target.classList.contains('hd-close')) _hostDetailTutup();
  });
  document.body.appendChild(el);
  _hostDetailModal = el;
  return el;
}

function _hostDetailTutup() {
  if (_hostDetailModal) _hostDetailModal.classList.add('hidden');
}

async function _hostDetailBuka(btn) {
  var d = App.currentDevice;
  if (!d) return;
  var idx  = btn.dataset.hostIdx;
  var nama = btn.dataset.hostName || 'Klien';
  var el   = _hostDetailEl();
  el.classList.remove('hidden');
  document.getElementById('hdTitle').innerHTML =
    '<i class="fas fa-mobile-screen"></i> ' + _esc(nama);
  document.getElementById('hdBody').innerHTML =
    '<div class="hd-load"><i class="fas fa-spinner fa-spin"></i> '
    + 'Menarik detail dari ONU…</div>';

  var data = null, galat = null;
  try {
    data = await ACS.fetchHostDetail(d.id, idx);
  } catch (e) {
    galat = (e && e.pagar) ? e.message
          : 'Gagal menarik detail: ' + ((e && e.message) || 'tidak diketahui');
  }

  var body = document.getElementById('hdBody');
  if (!body) return;
  if (galat) { body.innerHTML = '<div class="hd-kosong">' + _esc(galat) + '</div>'; return; }
  if (!data || !Object.keys(data).length) {
    body.innerHTML = '<div class="hd-kosong">ONU tidak melaporkan detail tambahan '
                   + 'untuk klien ini.</div>';
    return;
  }

  /* Label + ikon + WARNA, dikelompokkan menurut maknanya supaya mata bisa
     memindai: identitas (ungu), alamat (biru), IPv6 (cyan), DHCP (amber),
     radio (hijau), trafik (slate). Urutannya disengaja — yang paling dicari
     saat menangani keluhan ada di atas. */
  var LBL = {
    X_HW_RSSI:           ['fa-signal',           'RSSI',              'hdi-green'],
    X_HW_NegotiatedRate: ['fa-gauge-high',       'Laju negosiasi',    'hdi-green'],
    InterfaceType:       ['fa-wifi',             'Terhubung lewat',   'hdi-purple'],
    HostName:            ['fa-tag',              'Nama perangkat',    'hdi-purple'],
    MACAddress:          ['fa-network-wired',    'MAC',               'hdi-purple'],
    IPAddress:           ['fa-location-dot',     'IPv4',              'hdi-blue'],
    IPv6Address:         ['fa-globe',            'IPv6',              'hdi-cyan'],
    IPv6LinkLocal:       ['fa-link',             'IPv6 link-local',   'hdi-cyan'],
    AddressSource:       ['fa-server',           'Sumber alamat',     'hdi-amber'],
    LeaseTimeRemaining:  ['fa-hourglass-half',   'Sisa lease DHCP',   'hdi-amber'],
    VendorClassID:       ['fa-industry',         'Kelas vendor',      'hdi-slate'],
    UserClassID:         ['fa-user-tag',         'Kelas pengguna',    'hdi-slate'],
    Layer2Interface:     ['fa-diagram-project',  'Antarmuka L2',      'hdi-slate'],
    Active:              ['fa-circle-dot',       'Aktif',             'hdi-green'],
    'X_HW_Stats.BytesSent':     ['fa-arrow-down', 'Diunduh perangkat', 'hdi-slate'],
    'X_HW_Stats.BytesReceived': ['fa-arrow-up',   'Diunggah perangkat','hdi-slate'],
  };

  var fmt = function(k, v) {
    if (k === 'LeaseTimeRemaining') {
      var det = parseInt(v, 10);
      if (isNaN(det)) return String(v);
      if (det < 0) return 'tak terbatas';
      return _fmtUptime(det);
    }
    if (k === 'X_HW_RSSI')           return v + ' dBm';
    if (k === 'X_HW_NegotiatedRate') return v + ' Mbps';
    if (k.indexOf('X_HW_Stats.') === 0) return _fmtBytes(v);
    if (k === 'Active') return (String(v).toLowerCase() === 'true' || v === 1) ? 'Ya' : 'Tidak';
    if (k === 'IPv6Address') return String(v).split(',').join('\n');
    if (k === 'Layer2Interface') return String(v).replace(/^InternetGatewayDevice\./, '');
    return String(v);
  };

  /* Blok SINYAL paling atas, dengan analisa kualitas yang SAMA PERSIS dengan
     popup Perangkat Terhubung (_rssiQual) — ambang dan warnanya satu sumber,
     supaya "Baik" di satu tempat tidak berarti "Cukup" di tempat lain. */
  var sig = '';
  var rssi = (data.X_HW_RSSI !== undefined) ? parseFloat(data.X_HW_RSSI) : null;
  var q = _rssiQual(rssi);
  if (q) {
    sig = '<div class="hd-sig ' + q.cls + '">'
      + '<div class="ht-sig-top"><span class="ht-sig-lbl"><i class="fas fa-signal"></i> Kualitas Sinyal</span>'
      + '<span class="ht-sig-val">' + rssi + ' dBm <em>' + q.label + '</em></span></div>'
      + '<div class="ht-sig-bar"><span style="width:' + q.pct + '%"></span></div>'
      + (data.X_HW_NegotiatedRate !== undefined
          ? '<div class="ht-sig-sub">Laju negosiasi ' + _esc(String(data.X_HW_NegotiatedRate)) + ' Mbps</div>'
          : '')
      + '</div>';
  }

  // RSSI & laju sudah tampil di blok sinyal — jangan diulang sebagai baris.
  var lewati = q ? { X_HW_RSSI: 1, X_HW_NegotiatedRate: 1 } : {};

  var baris = Object.keys(LBL)
    .filter(function(k){ return data[k] !== undefined && !lewati[k]; })
    .map(function(k, i) {
      var m = LBL[k];
      // --i dipakai CSS untuk menunda animasi masuk tiap baris (efek berjenjang).
      return '<div class="hd-row" style="--i:' + i + '">'
           + '<span class="hd-lbl"><i class="fas ' + m[0] + ' hd-ico ' + m[2] + '"></i>'
           + '<span>' + m[1] + '</span></span>'
           + '<span class="hd-val">' + _esc(fmt(k, data[k])) + '</span></div>';
    }).join('');

  // Field yang diminta tapi tidak dilaporkan — dikatakan, bukan disembunyikan.
  // Tanpa ini operator tidak tahu bedanya "ONU tidak punya" dan "panel lupa minta".
  var tidakAda = Object.keys(LBL).filter(function(k){ return data[k] === undefined; });
  var catatan = tidakAda.length
    ? '<div class="hd-note"><i class="fas fa-circle-info"></i> Tidak dilaporkan ONU ini: '
      + tidakAda.map(function(k){ return LBL[k][1]; }).join(', ') + '</div>'
    : '';

  body.innerHTML = sig + baris + catatan;
}

function _hostTipShow(el, ev) {
  var t  = _hostTipEl();
  var ds = el.dataset;
  var row = function(ic, lbl, val) {
    return val ? '<div class="ht-row"><span class="ht-lbl"><i class="fas ' + ic + '"></i> ' + lbl
      + '</span><span class="ht-val">' + _esc(val) + '</span></div>' : '';
  };
  // Telemetri radio (JSON di data-radio) — hanya ada bila firmware melaporkannya.
  var rd = null;
  try { rd = ds.radio ? JSON.parse(ds.radio) : null; } catch (_) { rd = null; }

  var html = '<div class="ht-head"><i class="fas fa-mobile-screen"></i> ' + _esc(ds.host || '—') + '</div>';

  // Blok SINYAL: bar kualitas + RSSI/SNR/noise. Paling atas karena paling dicari saat
  // menangani keluhan "wifi lemah".
  var q = rd ? _rssiQual(rd.rssi) : null;
  if (q) {
    html += '<div class="ht-sig ' + q.cls + '">'
      + '<div class="ht-sig-top"><span class="ht-sig-lbl"><i class="fas fa-signal"></i> Sinyal</span>'
      + '<span class="ht-sig-val">' + rd.rssi + ' dBm <em>' + q.label + '</em></span></div>'
      + '<div class="ht-sig-bar"><span style="width:' + q.pct + '%"></span></div>'
      + '<div class="ht-sig-sub">'
      + (rd.snr   != null ? 'SNR ' + rd.snr + ' dB' : '')
      + (rd.noise != null ? (rd.snr != null ? ' &middot; ' : '') + 'Noise ' + rd.noise + ' dBm' : '')
      + '</div></div>';
  }

  html += row('fa-wifi',            'SSID',          ds.ssid)
       +  row('fa-tower-broadcast', 'Wireless Band', ds.band);

  if (rd) {
    // Laju link (bukan throughput sesaat): laju negosiasi TX/RX ke perangkat ini.
    if (rd.txRate != null) html += row('fa-arrow-up',   'Laju TX (link)', rd.txRate + ' Mbps');
    if (rd.rxRate != null) html += row('fa-arrow-down', 'Laju RX (link)', rd.rxRate + ' Mbps');
    html += row('fa-microchip',    'Mode WiFi',    rd.mode);
    html += row('fa-arrows-left-right-to-line', 'Lebar Kanal', rd.width);
    // Sudut pandang PELANGGAN: byte yang DIKIRIM ONU ke perangkat = download-nya
    // perangkat; byte yang DITERIMA ONU dari perangkat = upload-nya. (Counter kumulatif
    // sejak perangkat terhubung — bukan laju sesaat.)
    var down = _fmtBytes(rd.bytesSent);    // ONU → perangkat
    var up   = _fmtBytes(rd.bytesRecv);    // perangkat → ONU
    if (down) html += row('fa-cloud-arrow-down', 'Pemakaian Download', down);
    if (up)   html += row('fa-cloud-arrow-up',   'Pemakaian Upload',   up);
    if (rd.pktFail != null && rd.pktFail > 0) html += row('fa-triangle-exclamation', 'Paket gagal', rd.pktFail);
    if (rd.retry   != null && rd.retry   > 0) html += row('fa-rotate-right', 'Retry', rd.retry);
    if (rd.stayTime) html += row('fa-clock', 'Terhubung selama', _fmtDuration(rd.stayTime));
  } else {
    html += row('fa-gauge-high', 'Negotiation Rate', ds.rate);
  }

  html += row('fa-ethernet',     'MAC Address',    ds.mac)
       +  row('fa-location-dot', 'IP Address',     ds.ip)
       +  row('fa-server',       'Address Source', ds.src);
  t.innerHTML = html;
  // Tampilkan dulu (agar offsetWidth/Height terukur), baru jangkarkan.
  t.style.display = 'block';
  _hostTipAnchor(el);
}
// Popup DIAM (tidak mengikuti kursor): dijangkarkan ke baris perangkat yang di-hover.
// Default muncul di KANAN baris, sejajar tengahnya; bila ruang kanan kurang → pindah ke
// KIRI. Posisi dipatok sekali saat kursor masuk, lalu tidak berubah selama hover — mata
// tak perlu mengejar tooltip yang bergoyang.
function _hostTipAnchor(el) {
  var t = document.getElementById('hostTip');
  if (!t || !el) return;
  var r  = el.getBoundingClientRect();
  var tw = t.offsetWidth, th = t.offsetHeight;
  var gap = 12, edge = 8;

  var side = 'right';
  var left = r.right + gap;
  if (left + tw > window.innerWidth - edge) {          // tak muat di kanan → ke kiri
    left = r.left - tw - gap;
    side = 'left';
  }
  if (left < edge) {                                    // sempit di dua sisi → tumpuk di bawah
    left = Math.min(Math.max(r.left, edge), window.innerWidth - tw - edge);
    side = 'below';
  }

  var top = (side === 'below')
    ? r.bottom + gap
    : r.top + (r.height / 2) - (th / 2);                // sejajar tengah baris
  if (top + th > window.innerHeight - edge) top = window.innerHeight - th - edge;
  if (top < edge) top = edge;

  t.className = 'host-tip tip-' + side;                 // arah animasi masuk & posisi caret
  t.style.left = left + 'px';
  t.style.top  = top + 'px';
}
// Dipertahankan sbg no-op: markup lama (dan cache browser) mungkin masih memanggil
// onmousemove="_hostTipMove(event)". Popup kini diam → tak melakukan apa pun.
function _hostTipMove() { /* popup diam — tak mengikuti kursor */ }
function _hostTipHide() {
  var t = document.getElementById('hostTip');
  if (t) { t.style.display = 'none'; t.className = 'host-tip'; }
}

// ─── Toggle Config Tab (called from inline onclick) ───
function showConfigTab(tab) {
  // Fault poll runs ONLY while the Setting tab is visible.
  if (tab === 'setting') {
    _updateFaultSection();                                 // immediate refresh on open
    if (_settFaultIv) clearInterval(_settFaultIv);
    _settFaultIv = setInterval(_updateFaultSection, 20000);
  } else if (_settFaultIv) {
    clearInterval(_settFaultIv);
    _settFaultIv = null;
  }
  ['wan', 'ssid', 'setting'].forEach(t => {
    var el  = document.getElementById('dct' + t.charAt(0).toUpperCase() + t.slice(1));
    var btn = document.querySelector('.dct-tab[onclick*="' + t + '"]');
    if (!el || !btn) return;
    const on = (t === tab);
    el.classList.toggle('dct-hidden', !on);
    btn.classList.toggle('dct-active', on);
    btn.setAttribute('aria-selected', String(on));   // tampilan/aksesibilitas saja
  });
}

// ─── Render ONU Config Tabs (WAN / SSID / Setting) ───
function renderConfigPanel(d) {
  // ── WAN Tab ──────────────────────────────────────────────
  var wanEl = document.getElementById('dctWan');
  if (wanEl) _renderWanTab(d, wanEl);

  // ── SSID Tab ─────────────────────────────────────────────
  var ssidEl = document.getElementById('dctSsid');
  if (ssidEl) renderSsidTab(d, ssidEl);

  // ── Setting Tab ───────────────────────────────────────────
  var settEl = document.getElementById('dctSetting');
  if (settEl) _renderSettingTab(d, settEl);
}

// ─── WAN Tab ─────────────────────────────────────────────────────────────────

// Unique ID key for a WAN connection (used as HTML element suffix)
function _wanCid(conn) {
  return conn.wcdIdx + '_' + conn.type + '_' + conn.connIdx;
}

// Generate a display name from actual params (not the ONU-stored Name which may be stale/wrong)
function _wanConnName(conn) {
  var svc = (conn.serviceList || '').toUpperCase();
  return conn.wcdIdx + (svc ? '_' + svc : '') + '_R_VID_' + conn.vlanId;
}

// ─── Fase 3: resolusi profil WAN per-vendor ─────────────────────────────────
// getWanProfile() untuk ZTE F663NV9 menghasilkan nama param X_CMCC_* yang IDENTIK
// dengan hardcode lama (diverifikasi tests/difftest-vendor.js — snapshot GOLDEN).
// Bila profil vendor TIDAK mengisi suatu nama param (string kosong), param itu
// DILEWATI lewat _pushParam — tidak pernah jatuh ke nama X_CMCC, sehingga param
// ZTE tidak akan terkirim ke ONU vendor lain.
function _wanProfileFor(d) {
  if (typeof getWanProfile !== 'function') return null;
  var oui = String((d && d.id) || '').slice(0, 6).toUpperCase();
  return getWanProfile(d ? d.model : '', oui, d ? d.mfr : '');
}
// Tambah [base+name, val, type] ke params HANYA bila 'name' tak kosong.
function _pushParam(params, base, name, val, type) {
  if (name) params.push([base + name, val, type]);
}

/* ─── IPMode: pakai tipe yang DILAPORKAN ONU, bukan tebakan ──────────────────

   MASALAHNYA, diukur 2026-09-25 pada SN HWTC1006F0F0. Operator mengubah WAN
   dari IPv4-only ke dualstack lewat panel → ONU gagal tersambung ke MikroTik.
   Dikembalikan ke IPv4-only → tersambung. Diubah ke dualstack lewat WEB ONU
   → BERHASIL tersambung. Perangkat sama, tujuan sama; jadi bedanya ada pada
   APA yang dikirim, bukan pada kemampuan firmware-nya.

   Sebabnya tipe data. Yang dilaporkan ONU sendiri:

       HWTC  X_CT-COM_IPMode   xsd:string        28 unit   nilai "1" / "3"
       HWTC  X_CT-COM_IPMode   xsd:unsignedInt    2 unit
       CDTC/ZICG/ZTEG  X_CT-COM_IPMode  xsd:unsignedInt
       ZTE   X_CMCC_IPMode     xsd:int          891 unit
       ZTE   X_ZTE-COM_IPMode  xsd:string        24 unit   'Both' / 'IPv4'

   Panel selalu mengirim `xsd:unsignedInt`. Untuk HWTC itu salah tipe, dan
   akibatnya bukan sekadar ditolak — WAN-nya ikut tidak mau naik. Semua unit
   HWTC yang dualstack-nya berjalan menyimpan "3" sebagai STRING, dan semuanya
   disetel dari web ONU, bukan dari panel.

   KENAPA HANYA MENYESUAIKAN UNTUK STRING. Tipe angka dibiarkan apa adanya:
   ZTE melaporkan `xsd:int` sementara panel mengirim `xsd:unsignedInt`, dan itu
   sudah berjalan pada 891 unit selama berbulan-bulan. Mengubahnya berarti
   mengusik jalur yang terbukti sehat demi kerapian belaka — dan diff-test ZTE
   yang byte-identik ada justru untuk mencegah itu.

   Probe-nya READ-ONLY (projection ke dokumen yang sudah ada di GenieACS) —
   tidak ada perintah yang dikirim ke ONU.

   Dipasang sebagai koreksi TEPAT SEBELUM kirim, bukan saat menyusun daftar:
   dengan begitu seluruh jalur penyusunan parameter tetap sama persis, dan
   satu-satunya yang berubah adalah tipe pada entri IPMode — itu pun hanya
   bila ONU-nya sendiri bilang string. */
function _koreksiIpMode(d, base, namaIpMode, params) {
  if (!namaIpMode) return Promise.resolve(params);
  var jalur = base + namaIpMode;
  var idx = -1;
  for (var i = 0; i < params.length; i++) if (params[i][0] === jalur) { idx = i; break; }
  if (idx < 0) return Promise.resolve(params);

  return ACS.probeParam(d.id, jalur)
    .then(function(p) {
      if (p && p.found && p.type === 'xsd:string') {
        params[idx] = [jalur, String(params[idx][1]), 'xsd:string'];
      }
      return params;
    })
    .catch(function() { return params; });   // gagal probe → perilaku lama
}

// ─── JARING PENGAMAN: validasi enum PRA-PUSH (client-side) ───────────────────
// Tujuan: nilai enum yang PASTI invalid tidak pernah sampai ke ONU produksi
// (mencegah CWMP 9007 / fault). Hanya param yang himpunan enum-nya FIRMWARE-
// INVARIANT (sama di semua vendor TR-069/TR-098) yang dibatasi. `BeaconType`
// SENGAJA TIDAK divalidasi — itu "master switch" yang label-nya beragam antar
// vendor (mis. ZTE "WPA/WPA2"); nilai open yang salah pada BeaconType tetap
// tertangkap lewat BasicEncryptionModes yang DIVALIDASI di bawah.
// Cocokkan berdasarkan SUFFIX nama param (segmen terakhir) → berlaku untuk base
// path apa pun (WLANConfiguration.X. dsb). Hanya nilai string yang diperiksa.
var _ENUM_ALLOW = {
  // TR-098 WLANConfiguration: hanya {None, WEPEncryption}. "Basic" = penyebab
  // fault 688AF0 (nilai BeaconType salah tempat) → SELALU invalid di sini.
  'BasicEncryptionModes':     ['None', 'WEPEncryption'],
  // Mode enkripsi WPA/IEEE11i: tak pernah menerima "None"/"Basic".
  'WPAEncryptionModes':       ['TKIPEncryption', 'AESEncryption', 'TKIPandAESEncryption'],
  'IEEE11iEncryptionModes':   ['TKIPEncryption', 'AESEncryption', 'TKIPandAESEncryption'],
  // Mode autentikasi WPA/IEEE11i: hanya PSK/EAP.
  'WPAAuthenticationMode':    ['PSKAuthentication', 'EAPAuthentication'],
  'IEEE11iAuthenticationMode':['PSKAuthentication', 'EAPAuthentication'],
  // TR-098 + "OpenSystem" (enum sah firmware ZTE CMCC, terverifikasi live).
  'BasicAuthenticationMode':  ['None', 'EAPAuthentication', 'SharedAuthentication', 'OpenSystem'],
};
// Kembalikan array pelanggaran [{name, value, allowed}] (kosong = semua sah).
function _validateEnumParams(params) {
  var bad = [];
  for (var i = 0; i < (params || []).length; i++) {
    var p = params[i]; if (!p) continue;
    var full = p[0], val = p[1];
    if (typeof val !== 'string') continue;                 // hanya enum string
    var suffix = String(full).split('.').pop();
    var allow = _ENUM_ALLOW[suffix];
    if (allow && allow.indexOf(val) === -1) {
      bad.push({ name: suffix, value: val, allowed: allow });
    }
  }
  return bad;
}
// Choke point tunggal: validasi lalu ACS.setParam. Bila ada pelanggaran →
// BLOKIR (toast + Promise.reject) sehingga task TIDAK diantre ke ONU. Catch di
// pemanggil menampilkan/mereset UI seperti error biasa.
// ─── Binding LAN/SSID lewat TABEL Port Binding (ZTE F679L/F670L) ─────────────
// Vendor lain menyimpan binding sbg param DI DALAM koneksi (X_CMCC_LanInterface dst) →
// d.portBindingRoot null, fungsi ini mengembalikan [] (nol efek, ZTE F663 byte-identik).
// ZTE F679L memakai tabel root X_ZTE-COM_PortBinding.{i}.{WANInterface,LANInterface} —
// menu "Port Binding" di web ONU. Entri dipetakan ke koneksi lewat WANInterface; koneksi
// yang belum punya entri (WAN baru) → entri dibuat dulu (addObject), lalu WANInterface diisi.
// ─── Binding LAN/SSID BOOLEAN per port (Huawei X_HW_LANBIND) ─────────────────
// Sub-node di dalam koneksi: X_HW_LANBIND.{Lan1..NEnable, SSID1..MEnable} (xsd:boolean).
// Checkbox UI menghasilkan string path (format vendor lain) → di sini dikembalikan ke
// boolean untuk SETIAP slot yang ada di perangkat (yang tak dicentang = false, supaya
// mencabut binding juga berfungsi). Vendor lain: conn.lanBindNode absen → [] (nol efek).
function _lanBindBoolParams(conn, connBase, lanIface) {
  if (!conn || !conn.lanBindNode || !conn.lanBindSlots) return [];
  var sel    = _wanLanParsed(lanIface || '');
  var prefix = connBase + conn.lanBindNode + '.';
  var out    = [];
  (conn.lanBindSlots.eth || []).forEach(function(n) {
    out.push([prefix + 'Lan' + n + 'Enable', sel.eth.indexOf(n) >= 0, 'xsd:boolean']);
  });
  (conn.lanBindSlots.wlan || []).forEach(function(n) {
    out.push([prefix + 'SSID' + n + 'Enable', sel.wlan.indexOf(n) >= 0, 'xsd:boolean']);
  });
  return out;
}

function _portBindingParams(d, conn, lanIface) {
  var root = d.portBindingRoot;
  if (!root || !conn) return Promise.resolve([]);
  if (conn.portBindingIdx) {
    return Promise.resolve([[root + '.' + conn.portBindingIdx + '.LANInterface', lanIface || '', 'xsd:string']]);
  }
  if (!lanIface) return Promise.resolve([]);   // belum ada entri & tak ada yang dibinding
  return ACS.addObject(d.id, root)
    .then(function() { return ACS.listChildIndices(d.id, root); })
    .then(function(idxs) {
      if (!idxs || !idxs.length) return [];
      var idx = Math.max.apply(null, idxs);
      return [
        [root + '.' + idx + '.WANInterface', conn.basePath, 'xsd:string'],
        [root + '.' + idx + '.LANInterface', lanIface,      'xsd:string'],
      ];
    });
}

// ─── Dualstack IPv4+IPv6 untuk WAN yang BARU dibuat ──────────────────────────
// Dipakai KEDUA jalur create (createNewWcd & generik). Selalu langkah TERPISAH dari batch
// inti: WAN minimal (IPv4) sudah jadi saat ini dipanggil, jadi kegagalan IPv6 tak boleh
// menggagalkan create. Profil tanpa dualStack (ZTE F663) → {dualOk:null} (nol efek).
//   dualStack.param/value/type : master IP mode (X_CT-COM_IPMode=3 int; X_ZTE-COM_IPMode='Both' string)
//   dualStack.slaac            : param IPv6 lanjutan [nama, nilai, tipe]
// Batch slaac dicoba sekaligus; bila ONU menolak (satu param tak ada di firmware → seluruh
// batch 9005), diulang SATU PER SATU agar param yang ada tetap masuk.
function _wanApplyDualStack(d, prof, connBase) {
  var ds = prof && prof.dualStack;
  if (!ds || !ds.param) return Promise.resolve({ dualOk: null, slaacOk: null });
  var vType = ds.type || 'xsd:unsignedInt';
  // Tipe IPMode dikoreksi dari laporan ONU — sebagian firmware HWTC
  // mendeklarasikannya xsd:string, dan salah tipe membuat WAN gagal naik.
  return _koreksiIpMode(d, connBase, ds.param, [[connBase + ds.param, ds.value, vType]])
    .then(function(pp) { return _setParamGuard(d, pp); })
    .then(function() {
      if (!ds.slaac || !ds.slaac.length) return { dualOk: true, slaacOk: null };
      var list = ds.slaac.map(function(s) { return [connBase + s[0], s[1], s[2]]; });
      return _setParamGuard(d, list)
        .then(function() { return { dualOk: true, slaacOk: true }; })
        .catch(function() {
          // Batch ditolak — coba per-param; sebagian firmware tak punya semua leaf IPv6.
          var okAny = false;
          return list.reduce(function(chain, p) {
            return chain.then(function() {
              return _setParamGuard(d, [p]).then(function(){ okAny = true; }).catch(function(){});
            });
          }, Promise.resolve()).then(function() { return { dualOk: true, slaacOk: okAny }; });
        });
    })
    .catch(function(e) {
      // BEDAKAN "ONU menolak" dari "perintah belum sampai".
      //
      // Sebelum 2026-08-02 semua galat di sini dipukul rata jadi dualOk:false,
      // yang ditampilkan sebagai "dualstack tak diterima ONU". Pada perangkat
      // yang sesinya batal (mis. fault too_many_commits pada F663NV3A), perintah
      // IPMode TIDAK PERNAH sampai ke ONU — WAN-nya jadi IPv4 saja, lalu panel
      // menyalahkan ONU. Operator pun menyimpulkan firmware-nya tak mendukung
      // IPv6, padahal cuma belum terkirim dan tinggal diulang.
      if (e && e.menunggu) return { dualOk: null, slaacOk: null, menunggu: true };
      return { dualOk: false, slaacOk: null };
    });
}

// Gerbang tunggal SEMUA penulisan parameter (WAN, SSID, radio, dualstack).
//
// Sejak 2026-08-02 fungsi ini MENUNGGU kepastian dari GenieACS, bukan sekadar
// "permintaan terkirim". Dulu ia selesai begitu POST dibalas — termasuk saat
// balasannya 202 (baru diantre) — sehingga penyimpanan yang belum tentu sampai
// ke ONU sudah dilaporkan berhasil. Kini menolak (throw) bila ONU menolak, dan
// menandai `menunggu` bila ONU belum terhubung supaya pemanggil bisa
// membedakan "gagal" dari "belum dijalankan".
//
// Tidak ada tambahan operasi tulis: parameter yang dikirim persis sama.
async function _setParamGuard(d, params, setTeks, label) {
  var bad = _validateEnumParams(params);
  if (bad.length) {
    var msg = 'Nilai parameter invalid (dibatalkan sebelum dikirim ke ONU): '
      + bad.map(function(b) {
          return b.name + '="' + b.value + '" (sah: ' + b.allowed.join('/') + ')';
        }).join('; ');
    if (typeof showToast === 'function') showToast(msg, 'error');
    throw new Error(msg);
  }
  var hasil = await ACS.setParam(d.id, params);
  var r = await _tungguTask(d.id, hasil, setTeks, label || 'Menunggu ONU menerapkan');
  if (!r.ok) {
    var err = new Error(r.alasan);
    err.menunggu = !!r.menunggu;
    err.ditolak  = !!r.ditolak;
    throw err;
  }
  return r;
}

/* ─── Kirim HANYA yang berubah (PRD §6.1) ────────────────────────────────────

   Sebelum 2026-09-29 Simpan WAN mendorong SELURUH form (±11–15 parameter)
   walau yang diubah hanya VLAN. Terukur di antrean GenieACS hari itu:
     • ZL-2113X: 11 parameter dalam satu SetParameterValues → session_terminated.
       Model ini pernah membeku 12 unit sesudah satu penulisan.
     • F663NV3A: ServiceList "OTHER,TR069" ikut terkirim ulang ke WAN TR069
       → cwmp.9002, diulang 9 kali di setiap sesi.
   Nilai lama sudah ada di cache GenieACS, jadi membandingkannya gratis (satu
   GET, tanpa satu pun RPC ke ONU).

   Tiga aturan menjaga agar penyaringan tidak MERUSAK penulisan:
     1. GRUP. Firmware memvalidasi kecocokan antar-parameter (contoh nyata:
        ZTE menolak BeaconType='None' sendirian, 9007). Maka bila SATU anggota
        grup berubah, SELURUH anggota grupnya ikut dikirim.
     2. SELALU. Parameter write-only (password) tidak bisa dibandingkan —
        cache-nya "" atau basi. Bila diisi operator, selalu dikirim.
     3. TIDAK ADA DI CACHE = BERUBAH. Lebih baik terkirim daripada diam-diam
        hilang. Gagal membaca cache → kirim semua (perilaku lama), bukan batal. */
function _bool01(v) {
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1';
}
function _nilaiSama(baru, lama, type) {
  if (lama === undefined || lama === null) return false;
  if (type === 'xsd:boolean') return _bool01(baru) === _bool01(lama);
  if (/int$/i.test(type || '')) {
    return String(lama).trim() !== '' && Number(baru) === Number(lama);
  }
  return String(baru) === String(lama);
}
// params: [[path, nilai, tipe], ...]; cache: {path: nilai}; grup: [[path,...],...];
// selalu: [path,...]. Urutan params dipertahankan (ZTE memproses berurutan).
function _saringParamBerubah(params, cache, grup, selalu) {
  cache = cache || {}; grup = grup || []; selalu = selalu || [];
  var berubah = {};
  params.forEach(function(p) {
    if (selalu.indexOf(p[0]) >= 0 || !_nilaiSama(p[1], cache[p[0]], p[2])) berubah[p[0]] = true;
  });
  grup.forEach(function(g) {
    if (g.some(function(path) { return berubah[path]; })) {
      g.forEach(function(path) { berubah[path] = true; });
    }
  });
  var kirim = [], sama = [];
  params.forEach(function(p) { (berubah[p[0]] ? kirim : sama).push(p); });
  return { kirim: kirim, sama: sama };
}

// WAN yang membawa TR069 adalah jalur GenieACS ke ONU itu sendiri. Salah ubah
// (VLAN, ServiceList, binding) = ONU putus dari ACS dan hanya bisa dipulihkan
// di lokasi. Karena itu setiap perubahan padanya wajib dikonfirmasi, dengan
// daftar persis apa yang akan dikirim.
function _konfirmasiWanTr069(kirim) {
  return new Promise(function(resolve) {
    var daftar = kirim.map(function(p) {
      var nama = p[0].split('.').pop();
      var nilai = /pass|key/i.test(nama) ? '••••' : String(p[1]);
      return '<li><code>' + escHtml(nama) + '</code> → <b>' + escHtml(nilai) + '</b></li>';
    }).join('');
    showConfirm({
      title: 'Ubah WAN TR069?', icon: 'fa-triangle-exclamation', danger: true,
      yesLabel: 'Ya, kirim ke ONU',
      message: 'WAN ini dipakai GenieACS untuk berbicara dengan ONU. Bila salah '
             + 'ubah, ONU bisa putus dari ACS dan hanya bisa dipulihkan di lokasi.'
             + '<ul style="margin:10px 0 0 18px">' + daftar + '</ul>',
      onCancel: function() { resolve(false); },
    }, function() { resolve(true); });
  });
}

async function _wanHanyaBerubah(d, conn, semua, grup, selalu) {
  var cache;
  try {
    cache = await ACS.cachedValues(d.id, semua.map(function(p) { return p[0]; }));
  } catch (e) {
    return semua;
  }
  var s = _saringParamBerubah(semua, cache, grup, selalu);
  if (s.kirim.length && /TR069/i.test((conn && conn.serviceList) || '')) {
    if (!(await _konfirmasiWanTr069(s.kirim))) {
      var x = new Error('Dibatalkan — tidak ada yang dikirim ke ONU');
      x.dibatalkan = true;
      throw x;
    }
  }
  return s.kirim;
}

// Parse X_CMCC_LanInterface string into { eth:[1,2,..], wlan:[1,2,..] }
function _wanLanParsed(lanInterface) {
  var eth = [], wlan = [];
  (lanInterface || '').split(',').forEach(function(p) {
    p = p.trim();
    var m;
    if ((m = p.match(/LANEthernetInterfaceConfig\.(\d+)$/))) eth.push(parseInt(m[1], 10));
    else if ((m = p.match(/WLANConfiguration\.(\d+)$/))) wlan.push(parseInt(m[1], 10));
  });
  return { eth: eth, wlan: wlan };
}

// Build X_CMCC_LanInterface string from checked checkboxes in container
function _wanLanStr(container) {
  var parts = [];
  var inps = container.querySelectorAll('.wan-lan-inp');
  inps.forEach(function(inp) { if (inp.checked) parts.push(inp.dataset.ifpath); });
  return parts.join(',');
}

// Can this connection be deleted?
// Rule: TR069 connections cannot be deleted.
// INTERNET can only be deleted if there is a separate TR069 connection.
function _wanCanDelete(conn, allConns) {
  var svc = (conn.serviceList || '').toUpperCase();
  if (svc.indexOf('TR069') >= 0) return false;
  if (svc.indexOf('INTERNET') < 0) return false;
  return allConns.some(function(c) {
    return c.basePath !== conn.basePath && (c.serviceList || '').toUpperCase().indexOf('TR069') >= 0;
  });
}

// Status message for WAN form
function _wanStatus(el, msg, type) {
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.textContent = msg;
  el.className = 'wan-save-status wan-st-' + (type || 'info');
}

// Format uptime seconds → human readable
// Format durasi dari DETIK → 'hari jam menit detik' (Indonesia, lengkap & jelas).
function _fmtDuration(sec) {
  sec = Math.floor(Number(sec) || 0);
  if (sec <= 0) return '—';
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
      m = Math.floor((sec % 3600) / 60), s = sec % 60;
  var p = [];
  if (d) p.push(d + ' hari');
  if (h) p.push(h + ' jam');
  if (m) p.push(m + ' menit');
  if (s || !p.length) p.push(s + ' detik');
  return p.join(' ');
}
// Uptime bisa datang sebagai DETIK (angka, mis. WAN conn.uptime) ATAU string VP
// ('9d 08:47:23' / '08:47:23'). Normalkan keduanya ke format hari/jam/menit/detik.
function _fmtUptime(val) {
  if (val == null || val === '' || val === '—') return '—';
  if (typeof val === 'number' || /^\d+$/.test(String(val).trim())) return _fmtDuration(parseInt(val, 10));
  var s = String(val).trim();
  var m = /^(?:(\d+)\s*d\s*)?(\d+):(\d+):(\d+)$/i.exec(s);   // '9d 08:47:23' atau '08:47:23'
  if (m) {
    var days = parseInt(m[1] || '0', 10);
    return _fmtDuration(((days * 24 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 60 + parseInt(m[4], 10));
  }
  return s;   // format tak dikenal → tampilkan apa adanya
}
// WAN card memakai DETIK (conn.uptime) → delegasikan ke formatter durasi.
function _wanUptime(sec) { return _fmtDuration(sec); }

// ─── WAN Tab: List View ───────────────────────────────────────────────────────
function _renderWanTab(d, container) {
  var conns = d.wanConnections || [];
  // canAddDelete: profil vendor boleh mematikan create/delete WAN (mis. C-DATA —
  // addObject/deleteObject berisiko reboot & struktur EPON belum diuji tulis). ZTE
  // & vendor default = true (tak berubah). Hanya EDIT yang selalu tersedia.
  var canAdd = ((_wanProfileFor(d).features) || {}).canAddDelete !== false;
  var addHtml = canAdd
    ? '<button class="wan-add-btn" id="wanAddBtn"><i class="fas fa-plus"></i> Tambah</button>'
    : '';

  if (conns.length === 0) {
    container.innerHTML =
      '<div class="wan-empty"><i class="fas fa-plug-circle-xmark"></i>'
      + '<p>Data WAN Connection tidak tersedia.<br><small>Klik Refresh untuk memuat data dari ONU.</small></p></div>'
      + (canAdd ? '<div style="padding:8px 16px">'
          + '<button class="wan-add-btn" id="wanAddBtn"><i class="fas fa-plus"></i> Tambah WAN Connection</button>'
          + '</div>' : '');
    var addBtn = document.getElementById('wanAddBtn');
    if (addBtn) addBtn.addEventListener('click', function() { _wanShowEdit(d, null, [], container); });
    return;
  }

  var html = '<div class="wan-list-hdr">'
    + '<span class="wan-list-title"><i class="fas fa-globe"></i> WAN Connections</span>'
    + addHtml
    + '</div>';

  conns.forEach(function(conn) {
    var cid = _wanCid(conn);
    var svc = (conn.serviceList || '').toUpperCase();
    var isTR069    = svc.indexOf('TR069') >= 0;
    var isInternet = svc.indexOf('INTERNET') >= 0;
    // Sebagian firmware (mis. HWTC-EPON Realtek) TIDAK melaporkan ConnectionStatus →
    // kosong. Bila koneksi aktif & sudah dapat IP publik (ExternalIPAddress), perlakukan
    // sebagai Connected agar status tak salah tampil "belum konek".
    var isConn     = conn.connectionStatus === 'Connected'
                  || (!conn.connectionStatus && conn.enable && !!conn.externalIp);
    var canDel     = canAdd && _wanCanDelete(conn, conns);

    var svcLabel = (isTR069 && isInternet) ? 'TR069 + INTERNET'
                 : (isTR069 ? 'TR069' : (isInternet ? 'INTERNET' : (conn.serviceList || '—')));
    var svcCls   = isTR069 ? 'wan-badge-tr69' : (isInternet ? 'wan-badge-internet' : 'wan-badge-other');
    var protoCls = conn.type === 'ppp' ? 'wan-proto-pppoe' : 'wan-proto-ip';
    var protoLbl = conn.type === 'ppp' ? 'PPPoE' : 'IP/DHCP';

    // IPv6 di kartu WAN. ipMode>=2 berlaku lintas-vendor: X_CMCC/X_CT-COM/X_CU memberi
    // integer, X_ZTE-COM memberi string 'Both' yang dipetakan ke 3 di api.js.
    var hasIPv6  = conn.ipMode >= 2;
    var _v6ok    = function(v) { return v && v !== '::' && v !== '::/' && v.length > 4; };
    var ipv6Row  = '';
    if (hasIPv6 && _v6ok(conn.ipv6Ip)) {
      ipv6Row += '<div class="wan-card-row"><span class="wan-card-key">IPv6:</span>'
        + '<span class="wan-card-val"><code>' + _esc(conn.ipv6Ip) + '</code></span></div>';
    }
    if (hasIPv6 && _v6ok(conn.ipv6Prefix)) {
      ipv6Row += '<div class="wan-card-row"><span class="wan-card-key">IPv6 Prefix:</span>'
        + '<span class="wan-card-val"><code>' + _esc(conn.ipv6Prefix) + '</code></span></div>';
    }
    // Dualstack AKTIF tapi belum ada alamat → katakan apa adanya. Diam di sini menyesatkan:
    // operator mengira dualstack gagal dipasang, padahal ONU sudah dualstack & sedang/gagal
    // MEMINTA alamat ke jaringan (mis. BNG hanya memberi IPv6/PD ke satu sesi per pelanggan).
    if (hasIPv6 && !ipv6Row) {
      ipv6Row = '<div class="wan-card-row"><span class="wan-card-key">IPv6:</span>'
        + '<span class="wan-card-val">'
        + (conn.ipv6ConnStatus && conn.ipv6ConnStatus !== 'Connected'
            ? _esc(conn.ipv6ConnStatus)
            : 'Dualstack aktif — alamat belum diperoleh dari jaringan')
        + '</span></div>';
    }

    html += '<div class="wan-card" id="wan-card-' + cid + '">'
      + '<div class="wan-card-hdr">'
      + '<div class="wan-card-badges">'
      + '<span class="wan-badge ' + svcCls + '">' + svcLabel + '</span>'
      + '<span class="wan-badge ' + protoCls + '">' + protoLbl + '</span>'
      + (conn.enable ? '' : '<span class="wan-badge wan-badge-disabled">Nonaktif</span>')
      + '</div>'
      + '<span class="wan-card-name">' + _esc(_wanConnName(conn)) + '</span>'
      + '<div class="wan-card-right">'
      + '<label class="ssid-sw" title="' + (conn.enable ? 'Nonaktifkan' : 'Aktifkan') + '">'
      + '<input type="checkbox" class="ssid-sw-inp" id="wan-tog-' + cid + '"' + (conn.enable ? ' checked' : '') + '>'
      + '<span class="ssid-sw-track"><span class="ssid-sw-thumb"></span></span>'
      + '</label>'
      + '</div>'
      + '</div>'
      + '<div class="wan-card-rows">'
      + '<div class="wan-card-row"><span class="wan-card-key">Status:</span>'
      + '<span class="wan-card-val ' + (isConn ? 'wan-st-up' : (conn.connectionStatus ? 'wan-st-dn' : '')) + '">'
      + (isConn ? '<i class="fas fa-circle-dot"></i> Connected'
                : (conn.connectionStatus
                    ? '<i class="fas fa-circle-xmark"></i> ' + _esc(conn.connectionStatus)
                    : '<i class="fas fa-circle-minus" style="color:var(--text-muted)"></i> <span style="color:var(--text-muted)">Klik Refresh</span>'))
      + '</span></div>'
      + (conn.externalIp ? '<div class="wan-card-row"><span class="wan-card-key">IP:</span>'
        + '<span class="wan-card-val"><code>' + _esc(conn.externalIp) + '</code></span></div>' : '')
      + '<div class="wan-card-row"><span class="wan-card-key">VLAN:</span>'
      + '<span class="wan-card-val"><code>' + conn.vlanId + '</code>'
      + (conn.vlanMode === 0 ? ' <small style="color:var(--text-muted)">(Untagged)</small>' : '') + '</span></div>'
      + (conn.type === 'ppp' && conn.username
        ? '<div class="wan-card-row"><span class="wan-card-key">PPPoE User:</span>'
          + '<span class="wan-card-val"><code>' + _esc(conn.username) + '</code></span></div>' : '')
      + ipv6Row
      + (conn.dnsServers ? '<div class="wan-card-row"><span class="wan-card-key">DNS:</span>'
        + '<span class="wan-card-val"><code>' + _esc(conn.dnsServers) + '</code></span></div>' : '')
      + (conn.uptime ? '<div class="wan-card-row"><span class="wan-card-key">Uptime:</span>'
        + '<span class="wan-card-val">' + _wanUptime(conn.uptime) + '</span></div>' : '')
      + '</div>'
      + '<div class="wan-card-foot">'
      + '<div class="wan-toggle-st" id="wan-tog-st-' + cid + '" style="display:none"></div>'
      + '<button class="wan-edit-btn" id="wan-edit-' + cid + '"><i class="fas fa-sliders"></i> Edit</button>'
      + (canDel ? '<button class="wan-del-btn" id="wan-del-' + cid + '"><i class="fas fa-trash"></i> Hapus</button>' : '')
      + (isTR069 ? '<span class="wan-protected-note"><i class="fas fa-lock"></i> TR069 dilindungi</span>' : '')
      + '</div>'
      + '</div>';
  });

  container.innerHTML = html;

  // Wire events
  conns.forEach(function(conn) {
    var cid = _wanCid(conn);
    var editBtn = document.getElementById('wan-edit-' + cid);
    if (editBtn) editBtn.addEventListener('click', function() { _wanShowEdit(d, conn, conns, container); });
    if (_wanCanDelete(conn, conns)) {
      var delBtn = document.getElementById('wan-del-' + cid);
      if (delBtn) delBtn.addEventListener('click', function() { _wanHandleDelete(d, conn, container); });
    }
    var tog = document.getElementById('wan-tog-' + cid);
    if (tog) {
      tog.addEventListener('change', function() { _wanHandleToggle(d, conn, tog, container); });
    }
  });

  var addBtn2 = document.getElementById('wanAddBtn');
  if (addBtn2) addBtn2.addEventListener('click', function() { _wanShowEdit(d, null, conns, container); });
}

// ─── WAN Tab: Edit / Create Form ─────────────────────────────────────────────
function _wanShowEdit(d, conn, allConns, container) {
  var isNew     = !conn;
  var ethCount  = d.lanEthCount || 4;
  var ssidCount = (d.ssids || []).length || 4;
  // Binding LAN/SSID ke WAN: hanya vendor yang punya param binding (ZTE X_CMCC_LanInterface).
  // C-DATA (X_CT-COM) TIDAK mengekspos param ini (& tak ada port eth di TR-069) → sembunyikan
  // seksi binding agar tak menampilkan LAN/SSID palsu yang tak berpengaruh. features.lanBinding
  // = false utk C-DATA (template X_CT-COM), true utk ZTE (byte-identik).
  var showBinding = ((_wanProfileFor(d).features) || {}).lanBinding !== false;
  // bindShowSlot (C-DATA): tampilkan nomor slot WLAN di label checkbox binding, agar
  // operator bisa korelasikan dgn "SSID1/SSID2" di web ONU (slot layanan). ZTE: absen.
  var _bindShowSlot = ((_wanProfileFor(d).features) || {}).bindShowSlot === true;
  // Punya param DHCP-per-WAN? (ZTE F663 ya; ZTE F679L yang membinding lewat tabel Port
  // Binding tidak) → menentukan tampil/tidaknya checkbox "Enable DHCP".
  var _bindHasDhcp  = !!((_wanProfileFor(d).params || {}).lanDhcpEnable);
  // ZTE F679L/F670L: binding = tabel X_ZTE-COM_PortBinding, yaitu menu "Port Binding" di web
  // ONU. Pakai judul yang sama agar operator langsung mengenali seksi ini.
  var _bindTable    = ((_wanProfileFor(d).features) || {}).portBindingTable === true;
  var _bindTitle    = _bindTable
    ? 'Port Binding — LAN &amp; SSID yang masuk ke WAN ini'
    : 'Binding LAN Interface &amp; SSID';
  // Daftar {idx,name} SSID untuk checkbox binding (SEMUA slot 1..max) — dipakai form edit
  // & create. Bindability C-DATA tak bisa diturunkan dari data (uji DF1D: slot nonaktif
  // WLAN.3/.4 justru bindable) → tampilkan semua, operator pilih. Label = nama SSID + indeks
  // agar mudah dikorelasikan dgn "SSID1/SSID2" di web ONU.
  var _bindSsidList = (function(){ var a = []; for (var _si = 1; _si <= Math.max(ssidCount, 4); _si++) {
      var o = (d.ssids || []).find(function(s){ return s.idx === _si; }) || {};
      a.push({ idx: _si, name: o.name || ('SSID ' + _si) }); } return a; })();

  // VLAN controls — shared between create and edit
  // Renamed options: "Tagged" / "Untagged" (was "Tagged (802.1q)")
  // VLAN ID group shown/hidden based on VLAN Mode selection
  var vlanModeVal = isNew ? 2 : (conn.vlanMode !== undefined ? conn.vlanMode : 2);
  var isTagged    = vlanModeVal !== 0;
  var vlanModeHtml =
    '<div class="wan-form-group">'
    + '<label class="wan-form-label"><i class="fas fa-layer-group"></i> VLAN Mode</label>'
    + '<select class="wan-form-select" id="wanVlanMode">'
    + '<option value="2"' + (isTagged ? ' selected' : '') + '>Tagged</option>'
    + '<option value="0"' + (!isTagged ? ' selected' : '') + '>Untagged</option>'
    + '</select>'
    + '</div>';
  var vlanIdHtml =
    '<div class="wan-form-group" id="wanVlanIdGroup"' + (!isTagged ? ' style="display:none"' : '') + '>'
    + '<label class="wan-form-label"><i class="fas fa-tag"></i> VLAN ID</label>'
    + '<input class="wan-form-input" type="number" id="wanVlanId" value="' + (conn && conn.vlanId ? conn.vlanId : '') + '" min="1" max="4094" placeholder="1-4094">'
    + '</div>';

  // Shared: wire VLAN Mode → VLAN ID group toggle
  function wireVlanToggle() {
    var sel = document.getElementById('wanVlanMode');
    var grp = document.getElementById('wanVlanIdGroup');
    if (sel && grp) sel.addEventListener('change', function() {
      grp.style.display = parseInt(sel.value, 10) !== 0 ? '' : 'none';
    });
  }

  // ════════════════════════════════════════════════════════════
  //  EDIT FORM — existing connection
  // ════════════════════════════════════════════════════════════
  if (!isNew) {
    var lanBound = _wanLanParsed(conn.lanInterface);
    // Ports bound by OTHER WAN connections (warning, not disabled)
    var otherBoundEth = [], otherBoundWlan = [];
    allConns.forEach(function(c) {
      if (c.basePath === conn.basePath) return;
      var p = _wanLanParsed(c.lanInterface || '');
      p.eth.forEach(function(e)  { if (otherBoundEth.indexOf(e)  < 0) otherBoundEth.push(e); });
      p.wlan.forEach(function(w) { if (otherBoundWlan.indexOf(w) < 0) otherBoundWlan.push(w); });
    });
    var lanHtml = '';
    if (showBinding) {
    lanHtml  = '<div class="wan-form-group">'
      + '<label class="wan-form-label"><i class="fas fa-network-wired"></i> ' + _bindTitle + '</label>'
      + '<div class="wan-lan-grid">';
    for (var ei = 1; ei <= ethCount; ei++) {
      var epath   = 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.' + ei;
      var echk    = lanBound.eth.indexOf(ei) >= 0;
      var eOther  = !echk && otherBoundEth.indexOf(ei) >= 0;
      lanHtml += '<label class="wan-lan-cb' + (eOther ? ' wan-lan-used' : '') + '"'
        + (eOther ? ' title="Sudah digunakan WAN lain \u2014 pilih jika ingin berbagi port"' : '') + '>'
        + '<input type="checkbox" class="wan-lan-inp" data-ifpath="' + epath + '"'
        + (echk ? ' checked' : '') + '>'
        + ' LAN' + ei + (eOther ? ' <small style="color:#e6a817">(terpakai)</small>' : '') + '</label>';
    }
    _bindSsidList.forEach(function(item) {
      var si      = item.idx;
      var spath   = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + si;
      var sname   = item.name;
      var schk    = lanBound.wlan.indexOf(si) >= 0;
      var sOther  = !schk && otherBoundWlan.indexOf(si) >= 0;
      lanHtml += '<label class="wan-lan-cb' + (sOther ? ' wan-lan-used' : '') + '"'
        + (sOther ? ' title="Sudah digunakan WAN lain \u2014 pilih jika ingin berbagi port"' : '') + '>'
        + '<input type="checkbox" class="wan-lan-inp" data-ifpath="' + spath + '"'
        + (schk ? ' checked' : '') + '>'
        + ' ' + _esc(sname)
        + (_bindShowSlot ? ' <small style="opacity:.6">\u00b7 WLAN' + si + '</small>' : '')
        + (sOther ? ' <small style="color:#e6a817">(terpakai)</small>' : '') + '</label>';
    });
    lanHtml += '</div>'
      // Checkbox DHCP hanya bila vendor punya param DHCP-per-WAN (ZTE F663: X_CMCC_
      // LanInterface-DHCPEnable). ZTE F679L membinding lewat TABEL Port Binding yang tak
      // punya leaf DHCP → jangan tampilkan kontrol yang tak dikirim ke mana pun.
      + (_bindHasDhcp
          ? '<label class="wan-lan-cb wan-dhcp-cb" style="margin-top:5px">'
            + '<input type="checkbox" id="wanDhcpEnable"' + (conn.dhcpEnabled ? ' checked' : '') + '>'
            + ' Enable DHCP untuk LAN yang terhubung</label>'
          : '')
      + '</div>';
    }

    var ipModeVal = conn.ipMode || 1;
    var ipModeHtml =
      '<div class="wan-form-group">'
      + '<label class="wan-form-label"><i class="fas fa-globe"></i> Mode IP</label>'
      + '<select class="wan-form-select" id="wanIpMode">'
      + '<option value="1"' + (ipModeVal === 1 ? ' selected' : '') + '>IPv4 Only</option>'
      + '<option value="3"' + (ipModeVal === 3 ? ' selected' : '') + '>IPv4 + IPv6 (Dual Stack)</option>'
      + '<option value="2"' + (ipModeVal === 2 ? ' selected' : '') + '>IPv6 Only</option>'
      + '</select>'
      + '<small class="wan-svc-note" id="wanIpModeNote" style="display:none"></small>'
      + '</div>';

    // Kontrol IPv6 lanjutan (Prefix Origin / GUA / DNS) HANYA bila profil vendor punya
    // param-nya. ZTE F679L (X_ZTE-COM) tak mengekspos leaf-leaf itu (IPv6 diatur lewat
    // IPMode + DHCPv6/SLAAC enable) → tampilkan blok INFO saja, jangan kontrol yang tak
    // dikirim ke mana pun. Vendor lain (ZTE F663, C-DATA, F9V): tak berubah.
    var _v6Editable = !!((_wanProfileFor(d).params || {}).ipv6PrefixOrigin);
    var ipv6SectionHtml =
      '<div id="wanIpv6Section" style="' + (ipModeVal < 2 ? 'display:none' : '') + '">'
      + (!_v6Editable ? '' :
        '<div class="wan-form-group">'
      + '<label class="wan-form-label"><i class="fas fa-arrow-up-from-bracket"></i> Prefix Acquisition Method</label>'
      + '<select class="wan-form-select" id="wanIpv6PrefixOrigin">'
      + '<option value="PrefixDelegation"' + (conn.ipv6PrefixOrigin !== 'Static' && conn.ipv6PrefixOrigin !== 'None' ? ' selected' : '') + '>DHCPv6 / Prefix Delegation</option>'
      + '<option value="Static"' + (conn.ipv6PrefixOrigin === 'Static' ? ' selected' : '') + '>Static</option>'
      + '<option value="None"' + (conn.ipv6PrefixOrigin === 'None' ? ' selected' : '') + '>None</option>'
      + '</select>'
      + '</div>'
      + '<div class="wan-form-group">'
      + '<label class="wan-form-label"><i class="fas fa-location-dot"></i> GUA From (IPv6 Address Source)</label>'
      + '<select class="wan-form-select" id="wanIpv6AddrOrigin">'
      + '<option value="AutoConfigured"' + (conn.ipv6IpOrigin !== 'Static' && conn.ipv6IpOrigin !== 'None' ? ' selected' : '') + '>Auto (SLAAC)</option>'
      + '<option value="Static"' + (conn.ipv6IpOrigin === 'Static' ? ' selected' : '') + '>Static</option>'
      + '<option value="None"' + (conn.ipv6IpOrigin === 'None' ? ' selected' : '') + '>None</option>'
      + '</select>'
      + '</div>'
      + '<div class="wan-form-group">'
      + '<label class="wan-form-label"><i class="fas fa-server"></i> IPv6 DNS</label>'
      + '<input class="wan-form-input" type="text" id="wanIpv6Dns" value="' + _esc(conn.ipv6Dns || '') + '" placeholder="2001:4860:4860::8888,2001:4860:4860::8844">'
      + '</div>')
      + ((conn.ipv6Prefix && conn.ipv6Prefix.length > 4 && conn.ipv6Prefix !== '::')
         || (conn.ipv6Ip && conn.ipv6Ip.length > 4 && conn.ipv6Ip !== '::')
         || conn.ipv6ConnStatus
        ? '<div class="wan-ipv6-info">'
          + (conn.ipv6Prefix && conn.ipv6Prefix.length > 4 && conn.ipv6Prefix !== '::'
            ? '<div class="wan-info-row"><span class="wan-info-k">Prefix saat ini:</span><span class="wan-info-v"><code>' + _esc(conn.ipv6Prefix) + '</code></span></div>' : '')
          + (conn.ipv6Ip && conn.ipv6Ip !== '::'
            ? '<div class="wan-info-row"><span class="wan-info-k">IPv6 Address:</span><span class="wan-info-v"><code>' + _esc(conn.ipv6Ip) + '</code></span></div>' : '')
          + (conn.ipv6LinkLocal
            ? '<div class="wan-info-row"><span class="wan-info-k">Link-Local:</span><span class="wan-info-v"><code>' + _esc(conn.ipv6LinkLocal) + '</code></span></div>' : '')
          + (conn.ipv6Dns && !_v6Editable
            ? '<div class="wan-info-row"><span class="wan-info-k">DNS IPv6:</span><span class="wan-info-v"><code>' + _esc(conn.ipv6Dns) + '</code></span></div>' : '')
          + (conn.ipv6ConnStatus
            ? '<div class="wan-info-row"><span class="wan-info-k">Status IPv6:</span><span class="wan-info-v">' + _esc(conn.ipv6ConnStatus) + '</span></div>' : '')
          + '</div>'
        : '')
      + '</div>';

    var pppTopHtml = '<div id="wanPppFieldsTop"' + (conn.type !== 'ppp' ? ' style="display:none"' : '') + '>'
      + '<div class="wan-form-group"><label class="wan-form-label"><i class="fas fa-circle-info"></i> Service Name</label>'
      + '<input class="wan-form-input" type="text" id="wanPppSvcName" value="" disabled style="opacity:.45;cursor:not-allowed">'
      + '<small style="display:block;margin-top:4px;color:var(--text-muted)"><i class="fas fa-triangle-exclamation" style="color:#f59e0b"></i> Tidak didukung ONU ZTE F663NV9 — parameter ini tidak dikirim ke perangkat.</small>'
      + '</div></div>';

    var pppHtml = '<div id="wanPppFields"' + (conn.type !== 'ppp' ? ' style="display:none"' : '') + '>'
      + '<div class="wan-form-group"><label class="wan-form-label"><i class="fas fa-user"></i> Username PPPoE</label>'
      + '<input class="wan-form-input" type="text" id="wanPppUser" value="' + _esc(conn.username || '') + '" autocomplete="username" placeholder="Username PPPoE"></div>'
      + '<div class="wan-form-group"><label class="wan-form-label"><i class="fas fa-key"></i> Password PPPoE</label>'
      + '<input class="wan-form-input" type="password" id="wanPppPass" value="" autocomplete="new-password" placeholder="Kosongkan jika tidak diubah"></div>'
      + '<div class="wan-form-group"><label class="wan-form-label"><i class="fas fa-tag"></i> PPPoE Connection Type</label>'
      + '<select class="wan-form-select" id="wanPppConnType">'
      + '<option value="PPPoE_Routed"' + (conn.connectionType !== 'PPPoE_Bridged' ? ' selected' : '') + '>PPPoE Routed</option>'
      + '<option value="PPPoE_Bridged"' + (conn.connectionType === 'PPPoE_Bridged' ? ' selected' : '') + '>PPPoE Bridged</option>'
      + '</select></div></div>';

    var isTr       = conn.type === 'ip';
    var ipAddrType = conn.addressingType === 'Static' ? 'Static' : 'DHCP';
    var ipHtml = '<div id="wanIpFields"' + (!isTr ? ' style="display:none"' : '') + '>'
      + '<div class="wan-form-group"><label class="wan-form-label"><i class="fas fa-ethernet"></i> Addressing Type</label>'
      + '<select class="wan-form-select" id="wanIpAddrType">'
      + '<option value="DHCP"' + (ipAddrType === 'DHCP' ? ' selected' : '') + '>DHCP (Auto)</option>'
      + '<option value="Static"' + (ipAddrType === 'Static' ? ' selected' : '') + '>Static</option>'
      + '</select></div>'
      + '<div id="wanIpStaticFields"' + (ipAddrType !== 'Static' ? ' style="display:none"' : '') + '>'
      + '<div class="wan-form-group"><label class="wan-form-label">IP Address</label>'
      + '<input class="wan-form-input" type="text" id="wanIpAddr" value="' + _esc(conn.externalIp || '') + '" placeholder="x.x.x.x"></div>'
      + '<div class="wan-form-group"><label class="wan-form-label">Subnet Mask</label>'
      + '<input class="wan-form-input" type="text" id="wanIpMask" value="' + _esc(conn.subnetMask || '') + '" placeholder="255.255.255.0"></div>'
      + '<div class="wan-form-group"><label class="wan-form-label">Default Gateway</label>'
      + '<input class="wan-form-input" type="text" id="wanIpGw" value="' + _esc(conn.gateway || '') + '" placeholder="x.x.x.1"></div>'
      + '<div class="wan-form-group"><label class="wan-form-label">DNS Servers</label>'
      + '<input class="wan-form-input" type="text" id="wanIpDns" value="' + _esc(conn.dnsServers || '') + '" placeholder="8.8.8.8,8.8.4.4"></div>'
      + '</div></div>';

    var statusHtml = '';
    if (conn.connectionStatus || conn.externalIp || conn.uptime) {
      statusHtml = '<div class="wan-status-info">'
        + '<div class="wan-form-label" style="margin-bottom:6px"><i class="fas fa-circle-info"></i> Informasi Status</div>'
        + (conn.connectionStatus
          ? '<div class="wan-info-row"><span class="wan-info-k">Status:</span>'
            + '<span class="wan-info-v ' + (conn.connectionStatus === 'Connected' ? 'wan-st-up' : 'wan-st-dn') + '">'
            + conn.connectionStatus + '</span></div>' : '')
        + (conn.externalIp
          ? '<div class="wan-info-row"><span class="wan-info-k">IP Address:</span>'
            + '<span class="wan-info-v"><code>' + _esc(conn.externalIp) + '</code></span></div>' : '')
        + (conn.remoteIp
          ? '<div class="wan-info-row"><span class="wan-info-k">Remote / GW:</span>'
            + '<span class="wan-info-v"><code>' + _esc(conn.remoteIp) + '</code></span></div>' : '')
        + (conn.dnsServers
          ? '<div class="wan-info-row"><span class="wan-info-k">DNS:</span>'
            + '<span class="wan-info-v"><code>' + _esc(conn.dnsServers) + '</code></span></div>' : '')
        + (conn.uptime
          ? '<div class="wan-info-row"><span class="wan-info-k">Uptime:</span>'
            + '<span class="wan-info-v">' + _wanUptime(conn.uptime) + '</span></div>' : '')
        + '</div>';
    }

    container.innerHTML =
      '<div class="wan-edit-panel">'
      + '<div class="wan-edit-hdr">'
      + '<button class="ssid-back-btn" id="wanBackBtn"><i class="fas fa-arrow-left"></i> Kembali</button>'
      + '<span class="wan-edit-title"><i class="fas fa-sliders"></i> Edit: ' + _esc(_wanConnName(conn)) + '</span>'
      + '</div>'
      + pppTopHtml
      + _wanServiceFieldHtml(conn.serviceList)
      + '<div class="wan-form-group">'
      + '<label class="wan-form-label"><i class="fas fa-plug"></i> Tipe Koneksi</label>'
      + '<span class="wan-badge ' + (conn.type === 'ppp' ? 'wan-proto-pppoe' : 'wan-proto-ip') + '" style="font-size:11px;padding:3px 10px">'
      + (conn.type === 'ppp' ? 'PPPoE' : 'IP/DHCP') + '</span>'
      + '</div>'
      + ipModeHtml
      + vlanModeHtml
      + vlanIdHtml
      + (isTr ? '' :
          '<div id="wanExtraFields">'
          + '<div class="wan-form-group">'
          + '<label class="wan-form-label"><i class="fas fa-arrow-up-9-1"></i> 802.1p CoS Priority</label>'
          + '<select class="wan-form-select" id="wanCos">'
          + [0,1,2,3,4,5,6,7].map(function(v){
              return '<option value="' + v + '"' + (conn.cos === v ? ' selected' : '') + '>' + v + '</option>';
            }).join('')
          + '</select>'
          + '</div>'
          + '<div class="wan-form-group">'
          + '<label class="wan-form-label"><i class="fas fa-shield-halved"></i> NAT</label>'
          + '<select class="wan-form-select" id="wanNat">'
          + '<option value="1"' + (conn.nat ? ' selected' : '') + '>Enabled</option>'
          + '<option value="0"' + (!conn.nat ? ' selected' : '') + '>Disabled</option>'
          + '</select>'
          + '</div>'
          + '<div class="wan-form-group">'
          + '<label class="wan-form-label"><i class="fas fa-ruler"></i> MTU</label>'
          + '<input class="wan-form-input" type="number" id="wanMtu" value="' + (conn.mtu || 1480) + '" min="576" max="9000" placeholder="1480">'
          + '</div>'
          + pppHtml
          + ipHtml
          + ipv6SectionHtml
          + lanHtml
          + '</div>')
      + statusHtml
      + '<div class="wan-save-status" id="wanSaveStatus" style="display:none"></div>'
      + '<button class="wan-save-btn" id="wanSaveBtn"><i class="fas fa-floppy-disk"></i> Simpan Perubahan</button>'
      + '</div>';

    var backEdit = document.getElementById('wanBackBtn');
    var saveBtnE = document.getElementById('wanSaveBtn');
    if (backEdit) backEdit.addEventListener('click', function() { _renderWanTab(d, container); });
    var ipModeSel = document.getElementById('wanIpMode');
    var ipv6Sec   = document.getElementById('wanIpv6Section');
    if (ipModeSel && ipv6Sec) {
      ipModeSel.addEventListener('change', function() {
        ipv6Sec.style.display = parseInt(ipModeSel.value, 10) >= 2 ? '' : 'none';
      });
    }
    var ipAddrSel   = document.getElementById('wanIpAddrType');
    var ipStaticFld = document.getElementById('wanIpStaticFields');
    if (ipAddrSel && ipStaticFld) {
      ipAddrSel.addEventListener('change', function() {
        ipStaticFld.style.display = ipAddrSel.value === 'Static' ? '' : 'none';
      });
    }
    // Service menentukan apa yang mungkin — lihat _wanTerapkanAturanService().
    ['wanSvcInternet', 'wanSvcTr069'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', _wanTerapkanAturanService);
    });
    _wanTerapkanAturanService();
    wireVlanToggle();
    if (saveBtnE) saveBtnE.addEventListener('click', function() {
      _wanHandleSave(d, conn, false, allConns, container);
    });
    return;
  }

  // ════════════════════════════════════════════════════════════
  //  CREATE FORM — simplified, new connection
  // ════════════════════════════════════════════════════════════

  // Port availability: collect LAN/SSID indexes already bound by existing WAN connections
  var boundEth = [], boundWlan = [];
  allConns.forEach(function(c) {
    var p = _wanLanParsed(c.lanInterface || '');
    p.eth.forEach(function(e) { if (boundEth.indexOf(e) < 0) boundEth.push(e); });
    p.wlan.forEach(function(w) { if (boundWlan.indexOf(w) < 0) boundWlan.push(w); });
  });

  // LAN/SSID checkboxes — disabled (grayed) for ports bound by another WAN connection.
  // Disembunyikan utk vendor tanpa param binding (C-DATA X_CT-COM) — lihat showBinding.
  var lanHtml = '';
  if (showBinding) {
  lanHtml = '<div class="wan-form-group">'
    + '<label class="wan-form-label"><i class="fas fa-network-wired"></i> ' + _bindTitle + '</label>'
    + '<div class="wan-lan-grid">';
  for (var ei = 1; ei <= ethCount; ei++) {
    var epath  = 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.' + ei;
    var isBndE = boundEth.indexOf(ei) >= 0;
    lanHtml += '<label class="wan-lan-cb' + (isBndE ? ' wan-lan-used' : '') + '"'
      + (isBndE ? ' title="Sudah digunakan WAN lain — pilih jika ingin berbagi port"' : '') + '>'
      + '<input type="checkbox" class="wan-lan-inp" data-ifpath="' + epath + '">'
      + ' LAN' + ei + (isBndE ? ' <small style="color:#e6a817">(terpakai)</small>' : '') + '</label>';
  }
  _bindSsidList.forEach(function(item) {
    var si      = item.idx;
    var spath   = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + si;
    var sname   = item.name;
    var isBndS  = boundWlan.indexOf(si) >= 0;
    lanHtml += '<label class="wan-lan-cb' + (isBndS ? ' wan-lan-used' : '') + '"'
      + (isBndS ? ' title="Sudah digunakan WAN lain — pilih jika ingin berbagi port"' : '') + '>'
      + '<input type="checkbox" class="wan-lan-inp" data-ifpath="' + spath + '">'
      + ' ' + _esc(sname)
      + (_bindShowSlot ? ' <small style="opacity:.6">· WLAN' + si + '</small>' : '')
      + (isBndS ? ' <small style="color:#e6a817">(terpakai)</small>' : '') + '</label>';
  });
  lanHtml += '</div></div>';
  }

  // IPv6 — always dual stack for new connections; only show prefix/addr method options (no DNS input)
  var ipv6SectionHtml =
    '<div id="wanIpv6Section">'
    + '<div class="wan-form-group">'
    + '<label class="wan-form-label"><i class="fas fa-arrow-up-from-bracket"></i> Prefix Acquisition Method</label>'
    + '<select class="wan-form-select" id="wanIpv6PrefixOrigin">'
    + '<option value="PrefixDelegation" selected>DHCPv6 / Prefix Delegation</option>'
    + '<option value="Static">Static</option>'
    + '<option value="None">None</option>'
    + '</select>'
    + '</div>'
    + '<div class="wan-form-group">'
    + '<label class="wan-form-label"><i class="fas fa-location-dot"></i> GUA From (IPv6 Address Source)</label>'
    + '<select class="wan-form-select" id="wanIpv6AddrOrigin">'
    + '<option value="AutoConfigured" selected>Auto (SLAAC)</option>'
    + '<option value="Static">Static</option>'
    + '<option value="None">None</option>'
    + '</select>'
    + '</div>'
    + '</div>';

  // IP/DHCP addressing — shown only for IP/TR069 connection type
  var ipHtml =
    '<div id="wanIpFields" style="display:none">'
    + '<div class="wan-form-group"><label class="wan-form-label"><i class="fas fa-ethernet"></i> Addressing Type</label>'
    + '<select class="wan-form-select" id="wanIpAddrType"><option value="DHCP" selected>DHCP (Auto)</option><option value="Static">Static</option></select>'
    + '</div>'
    + '<div id="wanIpStaticFields" style="display:none">'
    + '<div class="wan-form-group"><label class="wan-form-label">IP Address</label>'
    + '<input class="wan-form-input" type="text" id="wanIpAddr" placeholder="x.x.x.x"></div>'
    + '<div class="wan-form-group"><label class="wan-form-label">Subnet Mask</label>'
    + '<input class="wan-form-input" type="text" id="wanIpMask" placeholder="255.255.255.0"></div>'
    + '<div class="wan-form-group"><label class="wan-form-label">Default Gateway</label>'
    + '<input class="wan-form-input" type="text" id="wanIpGw" placeholder="x.x.x.1"></div>'
    + '<div class="wan-form-group"><label class="wan-form-label">DNS Servers</label>'
    + '<input class="wan-form-input" type="text" id="wanIpDns" placeholder="8.8.8.8,8.8.4.4"></div>'
    + '</div></div>';

  container.innerHTML =
    '<div class="wan-edit-panel">'
    + '<div class="wan-edit-hdr">'
    + '<button class="ssid-back-btn" id="wanBackBtn"><i class="fas fa-arrow-left"></i> Kembali</button>'
    + '<span class="wan-edit-title"><i class="fas fa-plus-circle"></i> Tambah WAN Connection Baru</span>'
    + '</div>'

    // 1. Service Name — disabled, ONU ZTE F663NV9 tidak mendukung PPPoEServiceName
    + '<div class="wan-form-group" id="wanSvcNameGroup">'
    + '<label class="wan-form-label"><i class="fas fa-circle-info"></i> Service Name</label>'
    + '<input class="wan-form-input" type="text" id="wanPppSvcName" value="" disabled style="opacity:.45;cursor:not-allowed">'
    + '<small style="display:block;margin-top:4px;color:var(--text-muted)"><i class="fas fa-triangle-exclamation" style="color:#f59e0b"></i> Tidak didukung ONU ZTE F663NV9 — parameter ini tidak dikirim ke perangkat.</small>'
    + '</div>'

    // 2. Service (checkbox — dukung gabungan TR069,INTERNET)
    + _wanServiceFieldHtml('INTERNET')

    // 3. Tipe Koneksi
    + '<div class="wan-form-group">'
    + '<label class="wan-form-label"><i class="fas fa-plug"></i> Tipe Koneksi</label>'
    + '<select class="wan-form-select" id="wanConnType">'
    + '<option value="ppp">PPPoE</option>'
    + '<option value="ip">IP/DHCP (TR069)</option>'
    + '</select>'
    + '</div>'

    // 4. VLAN Mode + 5. VLAN ID (conditional)
    + vlanModeHtml
    + vlanIdHtml

    // 6. PPPoE credentials — hidden for IP/TR069
    + '<div id="wanPppFields">'
    + '<div class="wan-form-group"><label class="wan-form-label"><i class="fas fa-user"></i> Username PPPoE</label>'
    + '<input class="wan-form-input" type="text" id="wanPppUser" autocomplete="username" placeholder="Username PPPoE"></div>'
    + '<div class="wan-form-group"><label class="wan-form-label"><i class="fas fa-key"></i> Password PPPoE</label>'
    + '<input class="wan-form-input" type="password" id="wanPppPass" autocomplete="new-password" placeholder="Password PPPoE"></div>'
    + '</div>'

    // 7. IPv6 settings — hidden for IP/TR069 (auto: Dual Stack, PrefixDelegation, SLAAC, DNS from server)
    + ipv6SectionHtml

    // 8. IP/DHCP addressing — shown for IP/TR069 type only
    + ipHtml

    // 9. LAN/SSID binding with port availability indicator
    + lanHtml

    + '<div class="wan-save-status" id="wanSaveStatus" style="display:none"></div>'
    + '<button class="wan-save-btn" id="wanSaveBtn"><i class="fas fa-plus-circle"></i> Buat WAN Connection</button>'
    + '</div>';

  // ── Wire events for create form ──
  var backBtn     = document.getElementById('wanBackBtn');
  var connTypeSel = document.getElementById('wanConnType');
  var saveBtn     = document.getElementById('wanSaveBtn');
  if (backBtn) backBtn.addEventListener('click', function() { _renderWanTab(d, container); });

  // Service menentukan apa yang mungkin — lihat _wanTerapkanAturanService().
  // Dipasang di KEDUA form (edit & create): keduanya memakai
  // _wanServiceFieldHtml(), jadi id checkbox-nya sama.
  ['wanSvcInternet', 'wanSvcTr069'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', _wanTerapkanAturanService);
  });
  _wanTerapkanAturanService();   // terapkan sekali saat form digambar

  // Tipe Koneksi toggle: PPPoE shows Service Name + PPPoE creds + IPv6; IP shows IP fields
  if (connTypeSel) connTypeSel.addEventListener('change', function() {
    var isPpp    = connTypeSel.value === 'ppp';
    var svcNmGrp = document.getElementById('wanSvcNameGroup');
    var pppFlds  = document.getElementById('wanPppFields');
    var ipv6Sec  = document.getElementById('wanIpv6Section');
    var ipFlds   = document.getElementById('wanIpFields');
    if (svcNmGrp) svcNmGrp.style.display = isPpp ? '' : 'none';
    if (pppFlds)  pppFlds.style.display   = isPpp ? '' : 'none';
    if (ipv6Sec)  ipv6Sec.style.display   = isPpp ? '' : 'none';
    if (ipFlds)   ipFlds.style.display    = isPpp ? 'none' : '';
  });

  // IP Addressing type → show/hide static fields
  var ipAddrSel   = document.getElementById('wanIpAddrType');
  var ipStaticFld = document.getElementById('wanIpStaticFields');
  if (ipAddrSel && ipStaticFld) {
    ipAddrSel.addEventListener('change', function() {
      ipStaticFld.style.display = ipAddrSel.value === 'Static' ? '' : 'none';
    });
  }

  wireVlanToggle();
  if (saveBtn) saveBtn.addEventListener('click', function() {
    _wanHandleSave(d, null, true, allConns, container);
  });
}

// ─── Service (ServiceList) sbg checkbox — dukung nilai GABUNGAN ─────────────────
// Form lama memakai <select> tunggal: koneksi "TR069,INTERNET" yang diedit akan
// kehilangan salah satu service saat Simpan. Checkbox INTERNET+TR069 + helper di
// bawah memperbaiki itu DAN mempertahankan token lain (VOIP/IPTV) yang tak dikelola.
function _wanServiceFieldHtml(serviceList) {
  var u = (serviceList || '').toUpperCase();
  var hasInt = u.indexOf('INTERNET') >= 0;
  var hasTr  = u.indexOf('TR069') >= 0;
  var unknown = (serviceList || '').split(',').map(function(s){ return s.trim(); })
    .filter(function(t){ var x = t.toUpperCase(); return t && x !== 'INTERNET' && x !== 'TR069'; });
  return '<div class="wan-form-group">'
    + '<label class="wan-form-label"><i class="fas fa-server"></i> Service</label>'
    + '<div class="wan-svc-checks">'
    + '<label class="wan-svc-check"><input type="checkbox" id="wanSvcInternet"' + (hasInt ? ' checked' : '') + '> <span>INTERNET</span></label>'
    + '<label class="wan-svc-check"><input type="checkbox" id="wanSvcTr069"' + (hasTr ? ' checked' : '') + '> <span>TR069</span></label>'
    + '</div>'
    + (unknown.length
        ? '<small class="wan-svc-note"><i class="fas fa-circle-info"></i> Service lain dipertahankan: <code>' + _esc(unknown.join(',')) + '</code></small>'
        : '')
    + '<small class="wan-svc-note">Pilih satu atau keduanya (mis. TR069 + INTERNET pada satu PPPoE).</small>'
    + '</div>';
}

/* ─── Aturan alur: Service menentukan apa yang mungkin ──────────────────────

   Dua aturan, keduanya berdasar pengukuran seluruh armada 2026-09-25 —
   bukan asumsi.

   ATURAN 1 — dualstack hanya pada WAN INTERNET murni.

       vendor   susunan            WAN   ber-IPMode dualstack
       HWTC     INTERNET saja       11        8
       HWTC     TR069+INTERNET      13        0
       ZTE      INTERNET saja      360      351
       ZTE      TR069+INTERNET     172        1

     Dari 185 WAN gabungan di armada, hanya 1 yang ber-dualstack — dan itu pun
     kemungkinan ServiceList salah label. Sebabnya masuk akal: WAN gabungan
     MEMBAWA sesi TR-069 itu sendiri. Mengubahnya ke dualstack berarti
     menegosiasi ulang koneksi yang sedang dipakai ONU untuk bicara ke ACS —
     jalur manajemennya putus di tengah perubahan, lalu ONU mengembalikannya.
     Terbukti langsung pada SN HWTCDF632AE8: perintah diterima tanpa fault,
     tetapi IPMode tetap "1".

     Jadi pilihan dualstack dimatikan, bukan dibiarkan gagal diam-diam.

   ATURAN 2 — TR069 tanpa INTERNET selalu IP/DHCP.

       TR069 saja | IP/DHCP   687 WAN
       TR069 saja | PPPoE       0 WAN

     Nol dari 687. WAN manajemen memang tidak pernah PPPoE.

   Keduanya hanya membatasi PILIHAN di layar. Tidak ada parameter tambahan
   yang dikirim ke ONU. */
function _wanTerapkanAturanService() {
  var intEl = document.getElementById('wanSvcInternet');
  var trEl  = document.getElementById('wanSvcTr069');
  if (!intEl && !trEl) return;
  var adaInt = !!(intEl && intEl.checked);
  var adaTr  = !!(trEl  && trEl.checked);

  // ── Aturan 1 ──
  var ipSel = document.getElementById('wanIpMode');
  if (ipSel) {
    var gabung = adaInt && adaTr;
    Array.prototype.forEach.call(ipSel.options, function(op) {
      if (op.value !== '1') op.disabled = gabung;
    });
    if (gabung && ipSel.value !== '1') ipSel.value = '1';
    var ket = document.getElementById('wanIpModeNote');
    if (ket) {
      ket.innerHTML = gabung
        ? '<i class="fas fa-circle-info"></i> WAN ini membawa <strong>TR069</strong>. '
          + 'Dual Stack tidak dapat dipakai pada WAN yang sekaligus menjadi jalur '
          + 'manajemen — ONU akan menolak dan mengembalikannya ke IPv4. '
          + 'Untuk IPv6, pisahkan INTERNET ke WAN tersendiri.'
        : '';
      ket.style.display = gabung ? '' : 'none';
    }
  }

  // ── Aturan 2 ──
  var ctSel = document.getElementById('wanConnType');
  if (ctSel) {
    var wajibIp = adaTr && !adaInt;
    if (wajibIp && ctSel.value !== 'ip') {
      ctSel.value = 'ip';
      // Beri tahu penangan yang sudah ada supaya bidang PPPoE/IP ikut berganti.
      ctSel.dispatchEvent(new Event('change'));
    }
    ctSel.disabled = wajibIp;
    ctSel.title = wajibIp
      ? 'WAN khusus TR069 selalu IP/DHCP — tidak pernah PPPoE'
      : '';
  }
}

// Bangun nilai ServiceList dari checkbox, MEMPERTAHANKAN urutan & token tak dikenal.
function _wanServiceStr(origServiceList) {
  var intEl = document.getElementById('wanSvcInternet');
  var trEl  = document.getElementById('wanSvcTr069');
  var wantInt = !!(intEl && intEl.checked);
  var wantTr  = !!(trEl  && trEl.checked);
  var out = [];
  (origServiceList || '').split(',').forEach(function(raw) {
    var tok = raw.trim(); if (!tok) return;
    var x = tok.toUpperCase();
    if (x === 'INTERNET') { if (wantInt) out.push(tok); }
    else if (x === 'TR069') { if (wantTr) out.push(tok); }
    else out.push(tok); // token tak dikelola UI — jangan sampai hilang
  });
  var has = function(name) { return out.some(function(t){ return t.toUpperCase() === name; }); };
  if (wantTr  && !has('TR069'))    out.push('TR069');     // konvensi fleet: TR069 dulu
  if (wantInt && !has('INTERNET')) out.push('INTERNET');
  return out.join(',');
}

// ─── WAN Tab: Save (Edit) ─────────────────────────────────────────────────────
function _wanHandleSave(d, conn, isNew, allConns, container) {
  var stEl    = document.getElementById('wanSaveStatus');
  var saveBtn = document.getElementById('wanSaveBtn');

  var svc      = _wanServiceStr(conn ? conn.serviceList : '');
  if (!svc) {
    _wanStatus(stEl, 'Pilih minimal satu Service (INTERNET / TR069)', 'error');
    return;
  }

  // Use explicit radix 10 for all parseInt calls.
  var vlanId   = parseInt((document.getElementById('wanVlanId')   || {}).value, 10);
  if (isNaN(vlanId)) vlanId = 0;
  var vlanMode = parseInt((document.getElementById('wanVlanMode') || {}).value, 10);
  if (isNaN(vlanMode)) vlanMode = 2;
  // IP Mode: new connections always use Dual Stack (3); existing connections read from form
  var ipMode = isNew ? 3 : parseInt(((document.getElementById('wanIpMode') || {}).value), 10);
  if (!isNew && isNaN(ipMode)) ipMode = 1;

  // CoS / NAT / MTU: not shown in create form — use safe auto-values; for edit read DOM or conn fallback
  var cosEl  = document.getElementById('wanCos');
  var natEl  = document.getElementById('wanNat');
  var mtuEl  = document.getElementById('wanMtu');
  var dhcpEl = document.getElementById('wanDhcpEnable');
  var cos    = cosEl  ? parseInt(cosEl.value,  10) : (conn ? conn.cos           : 0);
  if (isNaN(cos)) cos = 0;
  var natVal = natEl  ? parseInt(natEl.value,  10) : (conn ? (conn.nat ? 1 : 0) : 1);
  if (isNaN(natVal)) natVal = 1;
  var mtu    = mtuEl  ? parseInt(mtuEl.value,  10) : (conn ? conn.mtu           : 1480);
  if (isNaN(mtu)) mtu = 1480;
  // DHCP: auto-enabled for new connections; for edit use checkbox or conn fallback
  var dhcpEn   = isNew ? true : (dhcpEl ? dhcpEl.checked : (conn ? !!conn.dhcpEnabled : false));
  // LAN interface: always read checkboxes for create; for edit read them bila seksi binding
  // dirender. Patokannya checkbox binding itu sendiri (BUKAN checkbox DHCP): ZTE F679L punya
  // binding (tabel Port Binding) tapi TIDAK punya param DHCP-per-WAN → checkbox DHCP absen.
  var hasBindCb = !!container.querySelector('.wan-lan-inp');
  var lanIface = (isNew || hasBindCb) ? _wanLanStr(container) : (conn ? (conn.lanInterface || '') : '');

  // Validation: VLAN ID only required when Tagged mode is selected
  if (vlanMode !== 0 && (vlanId < 1 || vlanId > 4094)) {
    _wanStatus(stEl, 'VLAN ID tidak valid (harus 1–4094)', 'error'); return;
  }
  if (mtuEl && (!mtu || mtu < 576 || mtu > 9000)) {
    _wanStatus(stEl, 'MTU tidak valid (576–9000)', 'error'); return;
  }

  // Create mode
  if (isNew) {
    var typeEl  = document.getElementById('wanConnType');
    var newType = typeEl ? typeEl.value : 'ppp';
    var cprof   = _wanProfileFor(d);
    // ── Jaring pengaman skema (data-driven, bukan dari profil) ──────────────
    // Perangkat keluarga X_CT-COM SELALU membawa penanda skema pada koneksinya:
    // vlanNode (node PON saudara: C-DATA/HWTC-GPON/ZICG/CIOT) atau vlanOnConn
    // (VLAN pada koneksi: HWTC-EPON). Bila penanda itu ADA tetapi profil yang
    // resolve TIDAK punya createNewWcd, berarti profil vendornya tidak cocok
    // (mis. jatuh ke entri generik X_CMCC karena settings.js tertinggal cache).
    // Melanjutkan akan: addObject koneksi di dalam WCD pelanggan + push param
    // X_CMCC yang tak ada di ONU → gagal & MENYISAKAN koneksi kosong (kasus nyata
    // ZICG011FB914 & CIOT12462630). Lebih baik berhenti dengan pesan jelas.
    // ZTE: vlanNode & vlanOnConn selalu null → tak pernah kena (byte-identik).
    var _devCtCom = (d.wanConnections || []).some(function(c){ return c && (c.vlanNode || c.vlanOnConn || c.vlanOnWcd); });
    if (_devCtCom && !(cprof && cprof.features && cprof.features.createNewWcd)) {
      _wanStatus(stEl, 'Profil vendor tidak cocok untuk perangkat ini (skema X_CT-COM, '
        + 'profil aktif: ' + ((cprof && cprof.template) || 'X_CMCC') + '). WAN baru TIDAK dibuat '
        + 'agar tak menyisakan koneksi kosong. Muat ulang halaman (Ctrl+Shift+R), lalu '
        + 'Settings → Vendor config → Segarkan Default.', 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-plus-circle"></i> Buat WAN Connection'; }
      return;
    }
    // C-DATA (X_CT-COM/EPON): tiap WAN = WANConnectionDevice BARU dgn VLAN sendiri
    // (VLAN di node saudara EPON). Alur create khusus, tak mengganggu koneksi lama.
    // X_CU (F9V): model sama (WCD baru), tapi VLAN = leaf di WCD → tanpa vlanNode,
    // ditandai vlanOnWcd di profil. Keduanya lewat _wanDoCreateNewWcd.
    if (cprof && (cprof.vlanNode || cprof.vlanOnWcd) && cprof.features && cprof.features.createNewWcd) {
      _wanDoCreateNewWcd(d, newType, svc, vlanId, vlanMode, natVal, container, allConns, stEl, saveBtn, lanIface, ipMode);
    } else {
      _wanDoCreate(d, newType, svc, vlanId, vlanMode, cos, natVal, mtu, ipMode, lanIface, dhcpEn, container, allConns, stEl, saveBtn);
    }
    return;
  }

  // Edit mode: build params. Nama param dari profil vendor (ZTE F663NV9 = X_CMCC_*,
  // byte-identik dgn hardcode lama). Urutan dipertahankan; nama kosong dilewati.
  var base = conn.basePath + '.';
  var prof = _wanProfileFor(d);
  var P    = (prof && prof.params) || (typeof WAN_PROFILE_DEFAULT !== 'undefined' ? WAN_PROFILE_DEFAULT.params : {});
  // C-DATA (X_CT-COM/EPON): VLAN berada di node SAUDARA koneksi (WANConnectionDevice.N.
  // X_CT-COM_WANEponLinkConfig.*), bukan di bawah koneksi seperti ZTE. Bila profil
  // menyetel 'vlanNode', push VLAN ke base saudara itu. Tanpa vlanNode (ZTE) → base
  // koneksi seperti semula (byte-identik).
  // Node VLAN C-DATA bergantung TIPE PON: pakai yang TERDETEKSI dari perangkat ini
  // (conn.vlanNode = Epon/Gpon), fallback ke default profil. ZTE: conn.vlanNode null &
  // prof.vlanNode undefined → base koneksi (byte-identik).
  // HWTC-EPON (Realtek): VLAN ada PADA koneksi berprefix X_CT-COM (conn.vlanOnConn),
  // TANPA node saudara — walau profil default menyetel vlanNode Gpon. Deteksi per-
  // perangkat menang: push X_CT-COM_VLANIDMark/VLANMode ke base koneksi. Jangan pakai
  // node saudara di sini (node itu tak ada di firmware EPON → bisa 9005).
  // X_CU (F9V ETCH/FOTC): VLAN = LEAF LANGSUNG di WANConnectionDevice (X_CU_VLAN), bukan
  // node saudara & bukan pada koneksi → base VLAN = base WCD (koneksi dipangkas), nama
  // param dari profil (P.vlanId='X_CU_VLAN'). P.vlanMode dikosongkan di profil X_CU
  // (X_CU_VLANEnabled = enable boolean, BUKAN mode tagged/untagged) → _pushParam melewatinya.
  var _wcdBase   = conn.basePath.replace(/\.(WANPPPConnection|WANIPConnection)\.\d+$/, '.');
  var _vlanNode  = (conn.vlanOnConn || conn.vlanOnWcd) ? null : (conn.vlanNode || (prof && prof.vlanNode));
  var vlanBase   = _vlanNode      ? _wcdBase + _vlanNode + '.'
                 : conn.vlanOnWcd ? _wcdBase
                 : base;
  var vlanIdName   = conn.vlanOnConn ? conn.vlanOnConn + '_VLANIDMark' : P.vlanId;
  var vlanModeName = conn.vlanOnConn ? conn.vlanOnConn + '_VLANMode'   : P.vlanMode;
  var params = [];
  _pushParam(params, base,     P.service,  svc,      'xsd:string');
  _pushParam(params, vlanBase, vlanIdName,   vlanId,   'xsd:unsignedInt');
  _pushParam(params, vlanBase, vlanModeName, vlanMode, 'xsd:unsignedInt');
  // X_ZTE-COM (F679L/F670L): VLAN aktif ditentukan leaf BOOLEAN terpisah (VLANEnable),
  // bukan mode tagged/untagged. Tagged (vlanMode!=0) & VLAN ID valid → true.
  if (P.vlanEnable) _pushParam(params, vlanBase, P.vlanEnable, (vlanMode !== 0 && vlanId > 0), 'xsd:boolean');
  _pushParam(params, base, P.cos,      cos,      'xsd:unsignedInt');
  _pushParam(params, base, P.nat,      !!natVal, 'xsd:boolean');
  _pushParam(params, base, (conn.type === 'ppp' ? P.mtuPpp : P.mtuIp), mtu, 'xsd:unsignedInt');
  _pushParam(params, base, P.ipMode,       ipMode,   'xsd:unsignedInt');
  _pushParam(params, base, P.lanInterface,  lanIface, 'xsd:string');
  _pushParam(params, base, P.lanDhcpEnable, dhcpEn,   'xsd:boolean');
  // Huawei: binding = boolean per port di dalam koneksi (P.lanInterface kosong di profilnya).
  params = params.concat(_lanBindBoolParams(conn, base, lanIface));

  // IPv6
  if (ipMode >= 2) {
    var pfxOriEl = document.getElementById('wanIpv6PrefixOrigin');
    var adOriEl  = document.getElementById('wanIpv6AddrOrigin');
    var ipv6DnsEl= document.getElementById('wanIpv6Dns');
    var pfxOri   = pfxOriEl ? pfxOriEl.value : 'PrefixDelegation';
    var adOri    = adOriEl  ? adOriEl.value  : 'AutoConfigured';
    var ipv6Dns  = ipv6DnsEl ? ipv6DnsEl.value.trim() : '';
    _pushParam(params, base, P.ipv6PrefixOrigin,     pfxOri,              'xsd:string');
    _pushParam(params, base, P.ipv6AddrOrigin,       adOri,               'xsd:string');
    _pushParam(params, base, P.ipv6PrefixDelegation, pfxOri === 'PrefixDelegation', 'xsd:boolean');
    if (ipv6Dns) _pushParam(params, base, P.ipv6Dns, ipv6Dns, 'xsd:string');
  }

  // PPPoE specific
  if (conn.type === 'ppp') {
    var userEl  = document.getElementById('wanPppUser');
    var passEl  = document.getElementById('wanPppPass');
    var ctEl    = document.getElementById('wanPppConnType');
    var snEl    = document.getElementById('wanPppSvcName');
    var user    = userEl ? userEl.value.trim() : '';
    var pass    = passEl ? passEl.value : '';
    var ct      = ctEl  ? ctEl.value   : 'PPPoE_Routed';
    var sn      = snEl  ? snEl.value.trim() : '';
    if (user) _pushParam(params, base, P.pppUser, user, 'xsd:string');
    if (pass) _pushParam(params, base, P.pppPass, pass, 'xsd:string');
    _pushParam(params, base, P.pppConnType, ct, 'xsd:string');
    if (sn)   _pushParam(params, base, P.pppServiceName, sn, 'xsd:string');
  }

  // IP specific
  if (conn.type === 'ip') {
    var atEl = document.getElementById('wanIpAddrType');
    var at   = atEl ? atEl.value : 'DHCP';
    _pushParam(params, base, P.ipAddrType, at, 'xsd:string');
    if (at === 'Static') {
      var ipEl  = document.getElementById('wanIpAddr');
      var mkEl  = document.getElementById('wanIpMask');
      var gwEl  = document.getElementById('wanIpGw');
      var dns4El= document.getElementById('wanIpDns');
      if (ipEl  && ipEl.value)  _pushParam(params, base, P.ipAddr, ipEl.value.trim(),  'xsd:string');
      if (mkEl  && mkEl.value)  _pushParam(params, base, P.ipMask, mkEl.value.trim(),  'xsd:string');
      if (gwEl  && gwEl.value)  _pushParam(params, base, P.ipGw,   gwEl.value.trim(),  'xsd:string');
      if (dns4El&& dns4El.value)_pushParam(params, base, P.ipDns,  dns4El.value.trim(),'xsd:string');
    }
  }

  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengirim…'; }
  _wanStatus(stEl, 'Konfigurasi sedang dikirim ke ONU…', 'info');

  var prevRaw = d.lastInformRaw || d.lastInform;
  // Grup parameter yang divalidasi bersama oleh firmware — lihat _saringParamBerubah.
  // Nama kosong menghasilkan path yang tak ada di params, jadi tak berpengaruh.
  var grup = [
    [vlanBase + vlanIdName, vlanBase + vlanModeName, vlanBase + (P.vlanEnable || '')],
    [base + P.ipMode, base + P.ipv6PrefixOrigin, base + P.ipv6AddrOrigin,
     base + P.ipv6PrefixDelegation, base + P.ipv6Dns],
    [base + P.ipAddrType, base + P.ipAddr, base + P.ipMask, base + P.ipGw, base + P.ipDns],
  ];
  var selalu = P.pppPass ? [base + P.pppPass] : [];
  var adaKirim = false;
  // Vendor tabel Port Binding (ZTE F679L): binding ditulis ke entri tabel, bukan ke koneksi.
  // Vendor lain: _portBindingParams() → [] (tak ada tambahan param, byte-identik).
  _portBindingParams(d, conn, lanIface)
    // Koreksi tipe IPMode tepat sebelum kirim — lihat _koreksiIpMode().
    .then(function(pbParams) {
      // Binding LAN: string lanInterface, boolean per-port Huawei, dan entri tabel
      // Port Binding satu kesatuan — sebagian saja berarti port setengah terikat.
      var bind = [base + P.lanInterface, base + P.lanDhcpEnable]
        .concat(_lanBindBoolParams(conn, base, lanIface).map(function(p) { return p[0]; }))
        .concat(pbParams.map(function(p) { return p[0]; }));
      grup.push(bind);
      return _koreksiIpMode(d, base, P.ipMode, params.concat(pbParams));
    })
    // Hanya yang berubah dibanding cache GenieACS (PRD §6.1); WAN TR069 dikonfirmasi.
    .then(function(semua) { return _wanHanyaBerubah(d, conn, semua, grup, selalu); })
    .then(function(kirim) {
      if (!kirim.length) return null;
      adaKirim = true;
      return _setParamGuard(d, kirim);
    })
    // IP Mode utk vendor yang TIDAK punya params.ipMode tapi punya profil dualStack
    // (ZTE F679L: IPMode = string 'Both'/'IPv4'). Tanpa ini pilihan "Dual Stack" di form
    // edit tak menulis apa pun. Vendor dgn params.ipMode (ZTE F663, C-DATA) → dilewati:
    // IPMode-nya sudah ikut batch utama di atas (byte-identik).
    .then(function() {
      if (P.ipMode || !prof.dualStack) return null;
      adaKirim = true;
      if (ipMode >= 2) return _wanApplyDualStack(d, prof, base);
      if (prof.dualStack.valueOff) {
        return _setParamGuard(d, [[base + prof.dualStack.param, prof.dualStack.valueOff,
                                   prof.dualStack.type || 'xsd:unsignedInt']]).catch(function(){});
      }
      return null;
    })
    .then(function() {
      if (!adaKirim) {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan Perubahan'; }
        _wanStatus(stEl, 'Tidak ada perubahan — tidak ada yang dikirim ke ONU', 'info');
        showToast('Tidak ada perubahan untuk dikirim', 'info');
        return;
      }
      _wanStatus(stEl, 'Menunggu ONU menerapkan perubahan…', 'info');
      pollForUpdate(prevRaw,
        function(nd) {
          App.currentDevice = nd;
          // Patch the in-memory conn with the values we just sent.
          // GenieACS cache may not reflect the change yet (stale after setParameterValues),
          // so we override the relevant fields before re-rendering the card.
          if (nd.wanConnections) {
            var savedC = nd.wanConnections.find(function(x) { return x.basePath === conn.basePath; });
            if (savedC) {
              savedC.vlanId      = vlanId;
              savedC.vlanMode    = vlanMode;
              savedC.ipMode      = ipMode;
              savedC.serviceList = svc;
              if (cosEl) savedC.cos = cos;
              if (natEl) savedC.nat = !!natVal;
              if (mtuEl) savedC.mtu = mtu;
            }
          }
          showToast('Konfigurasi WAN berhasil diterapkan', 'success');
          _renderWanTab(nd, container);
        },
        function() {
          if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan Perubahan'; }
          _wanStatus(stEl, 'ONU tidak merespons — coba ulangi', 'error');
          showToast('ONU tidak merespons (timeout)', 'error');
        }
      );
    })
    .catch(function(e) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan Perubahan'; }
      if (e && e.dibatalkan) { _wanStatus(stEl, e.message, 'info'); return; }
      _wanStatus(stEl, 'Gagal mengirim: ' + (e.message || 'Error'), 'error');
      showToast('Gagal mengirim konfigurasi WAN', 'error');
    });
}

// ─── WAN Tab: Create New Connection ──────────────────────────────────────────
function _wanDoCreate(d, type, svc, vlanId, vlanMode, cos, natVal, mtu, ipMode, lanIface, dhcpEn, container, allConns, stEl, saveBtn) {
  var wcdIdx    = allConns.length > 0 ? allConns[0].wcdIdx : 1;
  var connChild = type === 'ppp' ? 'WANPPPConnection' : 'WANIPConnection';
  var parentPath= 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.' + wcdIdx + '.' + connChild;

  _wanStatus(stEl, 'Membuat WAN Connection baru…', 'info');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Membuat…'; }

  var prevRaw = d.lastInformRaw || d.lastInform;
  ACS.addObject(d.id, parentPath)
    .then(function() {
      _wanStatus(stEl, 'Menunggu ONU membuat instance baru…', 'info');
      // Capture form values before DOM changes
      var userEl   = document.getElementById('wanPppUser');
      var passEl   = document.getElementById('wanPppPass');
      var ctEl     = document.getElementById('wanPppConnType');
      var snEl     = document.getElementById('wanPppSvcName');
      var pfxOriEl = document.getElementById('wanIpv6PrefixOrigin');
      var adOriEl  = document.getElementById('wanIpv6AddrOrigin');
      var ipv6DnsEl= document.getElementById('wanIpv6Dns');
      var user     = userEl  ? userEl.value.trim() : '';
      var pass     = passEl  ? passEl.value : '';
      var ct       = ctEl    ? ctEl.value : 'PPPoE_Routed';
      var sn       = snEl    ? snEl.value.trim() : '';
      var pfxOri   = pfxOriEl? pfxOriEl.value : 'PrefixDelegation';
      var adOri    = adOriEl ? adOriEl.value  : 'AutoConfigured';
      var ipv6Dns  = ipv6DnsEl ? ipv6DnsEl.value.trim() : '';

      pollForUpdate(prevRaw,
        function(nd) {
          App.currentDevice = nd;
          // Find the newly-created connection (not in previous allConns)
          var prevPaths = (d.wanConnections || []).map(function(c){ return c.basePath; });
          var newConn   = (nd.wanConnections || []).find(function(c){
            return c.type === type && prevPaths.indexOf(c.basePath) < 0;
          });
          if (!newConn) {
            showToast('WAN Connection ditambahkan — refresh untuk melihat', 'info');
            _renderWanTab(nd, container);
            return;
          }
          // Set parameters on the new instance.
          // Only send the most essential params to avoid atomic TR-069 batch failures:
          // CoS, MTU, ConnectionTrigger, and IPv6 params are omitted from initial create
          // because the ONU may reject them on a freshly-created instance, causing the
          // entire batch to roll back (including VLANIDMark → random ONU default).
          // Nama param dari profil vendor (ZTE F663NV9 = X_CMCC_*, byte-identik).
          var base = newConn.basePath + '.';
          var prof = _wanProfileFor(d);
          var P    = (prof && prof.params) || (typeof WAN_PROFILE_DEFAULT !== 'undefined' ? WAN_PROFILE_DEFAULT.params : {});
          var V    = (prof && prof.values) || {};
          var params = [];
          _pushParam(params, base, P.service,  svc,      'xsd:string');
          _pushParam(params, base, P.vlanId,   vlanId,   'xsd:unsignedInt');
          _pushParam(params, base, P.vlanMode, vlanMode, 'xsd:unsignedInt');
          // X_ZTE-COM: VLAN aktif = leaf BOOLEAN terpisah (lihat _wanHandleSave).
          if (P.vlanEnable) _pushParam(params, base, P.vlanEnable, (vlanMode !== 0 && vlanId > 0), 'xsd:boolean');
          _pushParam(params, base, P.ipMode,   ipMode,   'xsd:unsignedInt');
          _pushParam(params, base, P.nat,      !!natVal, 'xsd:boolean');
          _pushParam(params, base, P.enable,   true,     'xsd:boolean');
          if (lanIface) {
            _pushParam(params, base, P.lanInterface,  lanIface, 'xsd:string');
            _pushParam(params, base, P.lanDhcpEnable, dhcpEn,   'xsd:boolean');
          }
          if (type === 'ppp') {
            _pushParam(params, base, P.pppConnType, ct, 'xsd:string');
            if (user) _pushParam(params, base, P.pppUser, user, 'xsd:string');
            if (pass) _pushParam(params, base, P.pppPass, pass, 'xsd:string');
          }
          if (type === 'ip') {
            _pushParam(params, base, P.pppConnType, V.ipRouted || 'IP_Routed', 'xsd:string');
            _pushParam(params, base, P.ipAddrType,  'DHCP',                    'xsd:string');
          }
          // Nama koneksi (profil yang menyediakan params.name — ZTE F679L). Firmware menamai
          // koneksinya sendiri ('INTERNET'/'TR69'); tanpa Name, koneksi baru tampil kosong di
          // web ONU & daftar panel. VID disisipkan agar unik antar-WAN & terbaca vidFromName.
          if (P.name) _pushParam(params, base, P.name, (svc || 'WAN') + (vlanId > 0 ? '_VID_' + vlanId : ''), 'xsd:string');

          // FASE A — ConnectionType DULU (profil createConnType; ZTE F679L). Objek hasil
          // addObject lahir 'Unconfigured'; batch param apa pun ke objek itu ditolak ONU
          // dgn cwmp.9002 "Internal error" untuk SELURUH objek → WAN yatim tanpa konfigurasi.
          // Firmware lain (ZTE F663, C-DATA dst) tak punya createConnType → ctFirst kosong,
          // alur lama persis (byte-identik).
          var CT      = prof && prof.createConnType;
          var ctFirst = [];
          if (CT) {
            var ctVal = type === 'ppp'
              ? ((ct === 'PPPoE_Bridged' && CT.pppBridged) ? CT.pppBridged : CT.ppp)
              : CT.ip;
            if (ctVal) ctFirst.push([base + (prof.connTypePath || 'ConnectionType'), ctVal, 'xsd:string']);
          }

          _wanStatus(stEl, 'Mengkonfigurasi WAN Connection baru…', 'info');
          var prevRaw2 = nd.lastInformRaw || nd.lastInform;
          (ctFirst.length ? _setParamGuard(d, ctFirst) : Promise.resolve())
            .then(function() { return _portBindingParams(d, newConn, lanIface); })
            // Koreksi tipe IPMode tepat sebelum kirim — lihat _koreksiIpMode().
            .then(function(pbParams) { return _koreksiIpMode(d, base, P.ipMode, params.concat(pbParams)); })
            .then(function(semua) { return _setParamGuard(d, semua); })
            // Dualstack IPv4+IPv6 (profil dualStack — ZTE F679L: IPMode='Both' + DHCPv6/SLAAC).
            // Best-effort SETELAH WAN inti jadi; profil tanpa dualStack (ZTE F663) → nol efek.
            .then(function() {
              return type === 'ppp' ? _wanApplyDualStack(d, prof, base) : { dualOk: null, slaacOk: null };
            })
            .then(function(ds) {
              pollForUpdate(prevRaw2,
                function(nd2) {
                  App.currentDevice = nd2;
                  // Patch the new conn with the values we just sent so UI shows
                  // correct data even if GenieACS cache is still stale.
                  if (nd2.wanConnections) {
                    var nc = nd2.wanConnections.find(function(x){ return x.basePath === newConn.basePath; });
                    if (nc) {
                      nc.vlanId      = vlanId;
                      nc.vlanMode    = vlanMode;
                      nc.ipMode      = ipMode;
                      nc.serviceList = svc;
                      nc.nat         = !!natVal;
                      if (lanIface) { nc.lanInterface = lanIface; nc.dhcpEnabled = dhcpEn; }
                      if (type === 'ppp') { nc.connectionType = ct; if (user) nc.username = user; }
                    }
                  }
                  if (ds.dualOk === true && ds.slaacOk !== false)
                    showToast('WAN Connection berhasil dibuat — IPv4/IPv6 dualstack aktif', 'success');
                  else if (ds.dualOk === true)
                    showToast('WAN Connection dibuat, dualstack aktif — sebagian param IPv6 ditolak ONU', 'info');
                  else if (ds.dualOk === false)
                    showToast('WAN Connection dibuat, namun dualstack (IPMode) ditolak ONU — WAN aktif IPv4', 'info');
                  else
                    showToast('WAN Connection berhasil dibuat', 'success');
                  _renderWanTab(nd2, container);

                  // GenieACS belum punya param runtime (IP/status/uptime) koneksi yang
                  // baru dibuat karena addObject/setParam hanya MENULIS (tidak GET).
                  // Kirim 1 connection_request berisi daftar koneksi TERKINI (termasuk
                  // koneksi baru) agar IP-nya terambil, lalu render ulang. Aman (tanpa reboot).
                  var _prevRaw3 = nd2.lastInformRaw || nd2.lastInform;
                  ACS.refresh(d.id, nd2.wanConnections)
                    .then(function() {
                      pollForUpdate(_prevRaw3, function(nd3) {
                        App.currentDevice = nd3;
                        _renderWanTab(nd3, container);
                      }, function() { /* IP menyusul saat ONU sudah dapat alamat — klik Refresh */ }, 25000);
                    })
                    .catch(function() { /* best-effort; IP bisa diambil via tombol Refresh */ });
                },
                function()    { showToast('WAN dibuat tapi ONU tidak merespons konfirmasi — refresh manual', 'error'); _renderWanTab(nd, container); }
              );
            })
            .catch(function(e) {
              showToast('Gagal mengkonfigurasi WAN baru: ' + (e.message || 'Error'), 'error');
              _renderWanTab(nd, container);
            });
        },
        function() {
          if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-plus-circle"></i> Buat WAN Connection'; }
          _wanStatus(stEl, 'ONU tidak merespons', 'error');
          showToast('ONU tidak merespons', 'error');
        }
      );
    })
    .catch(function(e) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-plus-circle"></i> Buat WAN Connection'; }
      _wanStatus(stEl, 'Gagal membuat WAN Connection: ' + (e.message || 'Error'), 'error');
      showToast('Gagal membuat WAN Connection', 'error');
    });
}

// ─── WAN Tab: Create New Connection — model "WANConnectionDevice BARU" ────────
// Untuk C-DATA (X_CT-COM/EPON): VLAN ada di node SAUDARA per-WCD, sehingga tiap
// WAN baru harus punya WANConnectionDevice sendiri (VLAN independen, tak mengubah
// koneksi lama). Alur: addObject WCD → baca index WCD baru (ditentukan ONU, via
// listChildIndices read-only) → addObject koneksi di dalamnya → baca index koneksi
// → setParam (koneksi ke base koneksi, VLAN ke base EPON WCD). addObject bertahap
// (bukan churn) untuk minimalkan risiko too_many_commits.
function _wanDelay(ms) { return new Promise(function(res){ setTimeout(res, ms); }); }
async function _wanPollNewIndex(devId, parentPath, before, tries) {
  // 40×1.5s = 60 dtk: ONU pada subnet jauh / firmware lambat (mis. ZICG) kadang butuh
  // >22 dtk melapor instance baru pasca-addObject (sama seperti kelambatan CR di Refresh).
  tries = tries || 40;
  for (var i = 0; i < tries; i++) {
    var now = await ACS.listChildIndices(devId, parentPath);
    var neu = now.filter(function(x){ return before.indexOf(x) < 0; });
    if (neu.length) return neu[neu.length - 1];
    await _wanDelay(1500);
  }
  throw new Error('instance baru tak terdeteksi (timeout)');
}
// ipMode: pilihan "IP Mode" di form (1=IPv4, 2=IPv6, 3=dualstack). Sampai
// 2026-08-02 argumen ini TIDAK diteruskan ke sini sama sekali, sehingga jalur
// X_CT-COM (C-DATA/HWTC/ZICG/ZTEG) mengabaikan pilihan operator dan selalu
// mencoba dualstack. Tak terlihat karena create memang mengunci ipMode=3, tapi
// begitu operator memilih "IPv4 Only" pilihannya dibuang diam-diam.
async function _wanDoCreateNewWcd(d, type, svc, vlanId, vlanMode, natVal, container, allConns, stEl, saveBtn, lanIface, ipMode) {
  var prof = _wanProfileFor(d);
  var P    = (prof && prof.params) || {};
  var V    = (prof && prof.values) || {};
  var connChild = type === 'ppp' ? 'WANPPPConnection' : 'WANIPConnection';
  var wcdParent = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice';

  // Tangkap nilai form SEBELUM DOM berubah.
  var userEl = document.getElementById('wanPppUser');
  var passEl = document.getElementById('wanPppPass');
  var ctEl   = document.getElementById('wanPppConnType');
  var user   = userEl ? userEl.value.trim() : '';
  var pass   = passEl ? passEl.value : '';
  var ct     = ctEl   ? ctEl.value : 'PPPoE_Routed';

  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Membuat…'; }
  var wcdYatim = null;   // indeks WCD yang sudah terlanjur dibuat, bila urutan putus
  try {
    // 1) WANConnectionDevice baru.
    //
    // Menolak bila sudah ada addObject yang mengantre untuk induk yang sama.
    // Tanpa penjaga ini, klik ulang saat ONU lambat membuat SATU WCD KOSONG
    // per klik — terjadi 2026-08-02 di ZTEG1B874818 (WCD.4, 5, 6 semuanya
    // kosong) karena urutan create putus di langkah penantian.
    if (await _adaTaskKembar(d.id, 'addObject', wcdParent)) {
      throw new Error('Sudah ada permintaan pembuatan WAN yang mengantre untuk ONU ini. '
                    + 'Tunggu sampai selesai — mengulang hanya membuat WAN kosong berulang.');
    }
    _wanStatus(stEl, 'Membuat WAN Connection Device baru… (1/3)', 'info');
    var beforeWcd = await ACS.listChildIndices(d.id, wcdParent);
    var hAdd = await ACS.addObject(d.id, wcdParent);
    // Pastikan ONU BENAR-BENAR sudah menjalankannya sebelum lanjut. Dulu langkah
    // ini hanya "kirim lalu intip cache", sehingga langkah 2 & 3 bisa berjalan
    // di atas WCD yang belum ada.
    var rAdd = await _tungguTask(d.id, hAdd,
      function(t) { _wanStatus(stEl, t + ' (1/3)', 'info'); }, 'Menunggu ONU membuat WAN Device');
    if (!rAdd.ok) throw new Error(rAdd.alasan);
    var newWcdIdx = await _wanPollNewIndex(d.id, wcdParent, beforeWcd);
    wcdYatim = newWcdIdx;   // dicatat: bila langkah berikutnya gagal, ini tertinggal kosong

    // 2) Koneksi (PPPoE/IP) di dalam WCD baru. Sebagian firmware (mis. ZICG) OTOMATIS
    //    membuat koneksi default saat WCD dibuat → PAKAI yang sudah ada (jangan addObject
    //    lagi, itu menyisakan koneksi kosong kedua). Bila belum ada, baru addObject.
    var connParent = wcdParent + '.' + newWcdIdx + '.' + connChild;
    var existConn  = await ACS.listChildIndices(d.id, connParent);
    var newConnIdx;
    if (existConn.length) {
      _wanStatus(stEl, 'Memakai koneksi bawaan WCD ' + newWcdIdx + '… (2/3)', 'info');
      newConnIdx = existConn[existConn.length - 1];
    } else {
      _wanStatus(stEl, 'Membuat koneksi di WCD ' + newWcdIdx + '… (2/3)', 'info');
      var hConn = await ACS.addObject(d.id, connParent);
      var rConn = await _tungguTask(d.id, hConn,
        function(t) { _wanStatus(stEl, t + ' (2/3)', 'info'); }, 'Menunggu ONU membuat koneksi');
      if (!rConn.ok) throw new Error(rConn.alasan);
      newConnIdx = await _wanPollNewIndex(d.id, connParent, existConn);
    }

    // 3) Set parameter: koneksi → base koneksi; VLAN → sesuai SKEMA perangkat.
    //  - Node saudara PON (C-DATA & HWTC-GPON): VLAN di WCD.N.X_CT-COM_WAN{Gpon,Epon}
    //    LinkConfig. Node terdeteksi dari koneksi yang ada (semua WCD 1 perangkat sama
    //    tipe PON); fallback default profil (hardcode Epon bisa 9005 di unit GPON).
    //  - On-connection (HWTC-EPON Realtek): VLAN pada koneksi (X_CT-COM_VLANIDMark),
    //    TANPA node saudara → deteksi via conn.vlanOnConn.
    //  - On-WCD (X_CU / F9V ETCH-FOTC): VLAN = leaf X_CU_VLAN LANGSUNG di WCD baru
    //    → deteksi via conn.vlanOnWcd; VLAN mode tak dipush (P.vlanMode kosong di profil).
    var devVlanOnConn = (d.wanConnections || []).map(function(c){ return c.vlanOnConn; }).find(Boolean);
    var devVlanOnWcd  = (d.wanConnections || []).map(function(c){ return c.vlanOnWcd;  }).find(Boolean);
    var devVlanNode   = (d.wanConnections || []).map(function(c){ return c.vlanNode;   }).find(Boolean) || prof.vlanNode;
    var connBase = connParent + '.' + newConnIdx + '.';
    var params = [];
    _pushParam(params, connBase, P.service,  svc,      'xsd:string');
    if (devVlanOnConn) {
      // HWTC-EPON: VLAN berprefix X_CT-COM PADA koneksi baru (bukan node saudara).
      _pushParam(params, connBase, devVlanOnConn + '_VLANIDMark', vlanId,   'xsd:unsignedInt');
      _pushParam(params, connBase, devVlanOnConn + '_VLANMode',   vlanMode, 'xsd:unsignedInt');
    } else if (devVlanOnWcd) {
      // X_CU: leaf VLAN di base WCD baru.
      var wcdBase = wcdParent + '.' + newWcdIdx + '.';
      _pushParam(params, wcdBase, P.vlanId,   vlanId,   'xsd:unsignedInt');
      _pushParam(params, wcdBase, P.vlanMode, vlanMode, 'xsd:unsignedInt');
    } else {
      var vlanBase = wcdParent + '.' + newWcdIdx + '.' + devVlanNode + '.';
      _pushParam(params, vlanBase, P.vlanId,   vlanId,   'xsd:unsignedInt');
      _pushParam(params, vlanBase, P.vlanMode, vlanMode, 'xsd:unsignedInt');
    }
    _pushParam(params, connBase, P.nat,      !!natVal, 'xsd:boolean');
    _pushParam(params, connBase, P.enable,   true,     'xsd:boolean');
    // Huawei (X_HW_LANBIND): binding LAN/SSID koneksi BARU = boolean per port. Slot diambil
    // dari koneksi yang sudah ada di perangkat ini (semua koneksi punya sub-node yang sama).
    // Vendor lain: tak ada lanBindNode → tak menambah param apa pun.
    var _lbRef = (d.wanConnections || []).find(function(c){ return c.lanBindNode; });
    if (_lbRef && lanIface) params = params.concat(_lanBindBoolParams(_lbRef, connBase, lanIface));
    if (type === 'ppp') {
      _pushParam(params, connBase, P.pppConnType, ct, 'xsd:string');
      if (user) _pushParam(params, connBase, P.pppUser, user, 'xsd:string');
      if (pass) _pushParam(params, connBase, P.pppPass, pass, 'xsd:string');
    } else {
      _pushParam(params, connBase, P.pppConnType, V.ipRouted || 'IP_Routed', 'xsd:string');
      _pushParam(params, connBase, P.ipAddrType,  'DHCP',                    'xsd:string');
    }
    _wanStatus(stEl, 'Mengkonfigurasi koneksi baru… (3/3)', 'info');
    await _setParamGuard(d, params);

    // IPv4/IPv6 dualstack (C-DATA X_CT-COM_IPMode=3): langkah TERPISAH & best-effort.
    // Batch inti di atas sudah sukses (WAN minimal IPv4 sudah jadi); IPMode belum tentu
    // didukung tiap firmware → dipush sendiri agar kegagalannya TIDAK menggagalkan create.
    var dualOk = null, slaacOk = null, dualMenunggu = false;
    // Hormati pilihan operator: hanya kejar IPv6 bila IP Mode >= 2. Bila argumen
    // tak dikirim (pemanggil lama), pertahankan perilaku lama = coba dualstack.
    var mauIpv6 = (ipMode === undefined || ipMode === null) ? true : (ipMode >= 2);
    if (type === 'ppp' && mauIpv6) {
      _wanStatus(stEl, 'Menerapkan IPv4 + IPv6 (dualstack)…', 'info');
      var dsRes = await _wanApplyDualStack(d, prof, connBase);
      dualOk       = dsRes.dualOk;
      slaacOk      = dsRes.slaacOk;
      dualMenunggu = !!dsRes.menunggu;
    }

    // Muat ulang data & render.
    var nd = await ACS.fetchDevice(d.id);
    App.currentDevice = nd;
    var okMsg = 'WAN Connection baru berhasil dibuat (WCD ' + newWcdIdx + ')';
    if (dualOk === true && slaacOk === true)       showToast(okMsg + ' — dualstack + IPv6 SLAAC aktif', 'success');
    else if (dualOk === true && slaacOk === false) showToast(okMsg + ' — dualstack aktif, tapi SLAAC tak diterima ONU (IPv6 default/stateful)', 'info');
    else if (dualOk === true)                      showToast(okMsg + ' — IPv4/IPv6 dualstack aktif', 'success');
    else if (dualMenunggu)                         showToast(okMsg + ' — WAN aktif IPv4. Perintah dualstack BELUM sampai ke ONU (bukan ditolak); buka Edit WAN lalu pilih "IPv4 + IPv6" untuk mengulanginya.', 'info');
    else if (dualOk === false)                     showToast(okMsg + ', namun dualstack (IPMode) tak diterima ONU — WAN aktif IPv4', 'info');
    else showToast(okMsg, 'success');
    _renderWanTab(nd, container);

    // Best-effort: minta IP koneksi baru (connection_request, tanpa reboot).
    try {
      var prevRaw = nd.lastInformRaw || nd.lastInform;
      await ACS.refresh(d.id, nd.wanConnections);
      pollForUpdate(prevRaw, function(nd2){ App.currentDevice = nd2; _renderWanTab(nd2, container); },
        function(){ /* IP menyusul — klik Refresh */ }, 25000);
    } catch (_) { /* best-effort */ }
  } catch (e) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-plus-circle"></i> Buat WAN Connection'; }
    // Sebut WCD yang terlanjur dibuat. Diam soal ini adalah sebab teknisi
    // mengulang berkali-kali dan menumpuk WAN kosong tanpa menyadarinya.
    var sisa = (wcdYatim !== null)
      ? ' Catatan: WAN Device ke-' + wcdYatim + ' TERLANJUR dibuat dan kini KOSONG '
        + '(tanpa koneksi). Hapus lewat daftar WAN, atau lanjutkan mengisinya — '
        + 'JANGAN menekan Buat lagi, itu akan menambah WAN kosong baru.'
      : '';
    _wanStatus(stEl, 'Gagal membuat WAN baru: ' + (e.message || 'Error') + sisa, 'error');
    showToast('Gagal membuat WAN Connection baru: ' + (e.message || 'Error'), 'error');
    // Muat ulang agar WCD yatim langsung TERLIHAT di daftar dan bisa dihapus.
    try {
      var ndErr = await ACS.fetchDevice(d.id);
      App.currentDevice = ndErr;
      _renderWanTab(ndErr, container);
    } catch (_) { /* tampilan lama tetap dipakai */ }
  }
}

// ─── WAN Tab: Delete ─────────────────────────────────────────────────────────
function _wanHandleDelete(d, conn, container) {
  showConfirm({
    title:    'Hapus WAN Connection ini?',
    icon:     'fa-trash',
    danger:   true,
    yesLabel: 'Hapus',
    noLabel:  'Batal',
    message:  'Koneksi internet dari VLAN ini akan terputus. ONU tetap bisa diremote melalui TR069.'
            + '<div style="margin-top:10px;padding:8px 12px;background:var(--surface2);border-radius:8px;font-family:monospace;font-size:12px">'
            + _esc(_wanConnName(conn)) + '</div>',
  }, function() {
    var cid  = _wanCid(conn);
    var stEl = document.getElementById('wan-tog-st-' + cid);
    if (stEl) { stEl.textContent = 'Menghapus…'; stEl.className = 'wan-toggle-st'; stEl.style.display = 'block'; }

    // C-DATA/EPON (createNewWcd): VLAN ada di node SAUDARA koneksi
    // (WANConnectionDevice.N.X_CT-COM_WANEponLinkConfig). Menghapus hanya koneksi
    // menyisakan WCD kosong beserta VLAN-nya. Karena di model ini tiap WAN = satu
    // WANConnectionDevice sendiri, hapus SELURUH WCD agar VLAN ikut terhapus.
    // ZTE (tanpa createNewWcd) → hapus koneksi seperti semula (byte-identik).
    var _dprof = _wanProfileFor(d);
    var delPath = conn.basePath;
    if (_dprof && (_dprof.vlanNode || _dprof.vlanOnWcd) && _dprof.features && _dprof.features.createNewWcd) {
      delPath = conn.basePath.replace(/\.(WANPPPConnection|WANIPConnection)\.\d+$/, '');
    }

    var setTeks = function(t) { if (stEl) { stEl.textContent = t; stEl.className = 'wan-toggle-st'; } };

    (async function() {
      try {
        if (await _adaTaskKembar(d.id, 'deleteObject', delPath)) {
          setTeks('Perintah hapus untuk koneksi ini sudah mengantre — tunggu, jangan diulang.');
          showToast('Perintah hapus sudah mengantre untuk koneksi ini — tidak dikirim ulang', 'info');
          return;
        }
        setTeks('Mengirim perintah hapus…');
        var hasil = await ACS.deleteObject(d.id, delPath);
        var r = await _tungguTask(d.id, hasil, setTeks, 'Menunggu ONU menjalankan hapus');

        // Muat ulang data apa pun hasilnya — supaya yang tampil = keadaan NYATA
        // di ONU, bukan asumsi panel.
        var nd = await ACS.fetchDevice(d.id);
        App.currentDevice = nd;
        _renderWanTab(nd, container);

        if (r.ok) { showToast('WAN Connection berhasil dihapus', 'success'); return; }
        if (stEl) { stEl.textContent = r.alasan; stEl.className = 'wan-toggle-st st-err'; }
        showToast(r.menunggu ? 'Perintah hapus tersimpan — menunggu ONU terhubung'
                             : 'Gagal menghapus: ' + r.alasan,
                  r.menunggu ? 'info' : 'error');
      } catch (e) {
        if (stEl) { stEl.textContent = 'Gagal: ' + (e.message || 'Error'); stEl.className = 'wan-toggle-st st-err'; }
        showToast('Gagal menghapus WAN Connection: ' + (e.message || 'Error'), 'error');
      }
    })();
  });
}

// ─── WAN Tab: Toggle Enable ───────────────────────────────────────────────────
function _wanHandleToggle(d, conn, inp, container) {
  var newEnable = inp.checked;
  var cid  = _wanCid(conn);
  var stEl = document.getElementById('wan-tog-st-' + cid);

  inp.disabled = true;
  if (stEl) { stEl.textContent = 'Mengirim…'; stEl.className = 'wan-toggle-st'; stEl.style.display = 'block'; }

  var path    = conn.basePath + '.Enable';
  var setTeks = function(t) { if (stEl) { stEl.textContent = t; stEl.className = 'wan-toggle-st'; } };

  (async function() {
    try {
      await _setParamGuard(d, [[path, newEnable, 'xsd:boolean']], setTeks,
                           newEnable ? 'Menunggu ONU mengaktifkan' : 'Menunggu ONU menonaktifkan');
      var nd = await ACS.fetchDevice(d.id);
      App.currentDevice = nd;
      showToast(newEnable ? 'WAN diaktifkan' : 'WAN dinonaktifkan', 'success');
      _renderWanTab(nd, container);
    } catch (e) {
      // Kembalikan sakelar HANYA bila ONU benar-benar menolak. Kalau perintahnya
      // masih mengantre, mengembalikan sakelar itu bohong — perintahnya tetap
      // akan dijalankan saat ONU terhubung.
      inp.disabled = false;
      if (e && e.menunggu) {
        if (stEl) { stEl.textContent = e.message; stEl.className = 'wan-toggle-st'; stEl.style.display = 'block'; }
        showToast('Perintah tersimpan — menunggu ONU terhubung', 'info');
      } else {
        inp.checked = !newEnable;
        if (stEl) { stEl.textContent = (e && e.message) || 'Gagal mengirim'; stEl.className = 'wan-toggle-st st-err'; stEl.style.display = 'block'; }
        showToast('Gagal mengubah status WAN: ' + ((e && e.message) || 'Error'), 'error');
      }
    }
  })();
}

// ─── Setting Tab helpers ──────────────────────────────────────────────────────
// Build one credential change section.
// cfg: { passPath, userPath, userLocked, currentUser }
//   passPath    — TR-069 path to write password; empty → show "not configured" notice
//   userPath    — TR-069 path to write username; empty → no username field
//   userLocked  — true → show read-only locked username row (no userPath needed)
//   currentUser — display name shown when locked
function _credSection(id, title, icon, cfg) {
  var passPath    = cfg.passPath    || '';
  var userPath    = cfg.userPath    || '';
  var userLocked  = !!cfg.userLocked;
  var currentUser = cfg.currentUser || '';

  // Firmware tidak mendukung penggantian akun ini → tampilkan notis, jangan beri form
  // yang menyesatkan (mis. akun "user" pada CMCC ZTE F663NV9 tidak dapat diubah via TR-069).
  if (cfg.unsupported) {
    var note = cfg.unsupportedNote || 'Penggantian kredensial ini tidak didukung firmware perangkat.';
    return '<div class="dct-setting-section dct-cred-disabled">'
      + '<div class="dct-setting-label"><i class="fas ' + icon + '"></i> ' + title + '</div>'
      + '<div class="dct-cred-nopath"><i class="fas fa-ban"></i> ' + _esc(note) + '</div>'
      + '</div>';
  }

  if (!passPath) {
    return '<div class="dct-setting-section">'
      + '<div class="dct-setting-label"><i class="fas ' + icon + '"></i> ' + title + '</div>'
      + '<div class="dct-cred-nopath"><i class="fas fa-circle-info"></i> Path parameter belum dikonfigurasi untuk model ini.</div>'
      + '</div>';
  }

  // Username row: locked display, editable input, or omitted
  var userRow = '';
  if (userLocked) {
    userRow = '<div class="dct-cred-row">'
      + '<label class="dct-cred-label">Username</label>'
      + '<div class="dct-cred-locked"><i class="fas fa-lock"></i> '
      + _esc(currentUser || '(tidak diketahui)')
      + '<span class="dct-cred-lock-note">dikunci, tidak dapat diubah</span></div>'
      + '</div>';
  } else if (userPath) {
    userRow = '<div class="dct-cred-row"><label class="dct-cred-label">Username Baru</label>'
      + '<input class="dct-cred-input" type="text" id="' + id + '-user" autocomplete="username" placeholder="Kosongkan jika tidak diubah"></div>';
  }

  return '<div class="dct-setting-section">'
    + '<div class="dct-setting-label"><i class="fas ' + icon + '"></i> ' + title + '</div>'
    + '<div class="dct-cred-form">'
    + userRow
    + '<div class="dct-cred-row"><label class="dct-cred-label">Password Baru</label>'
    + '<input class="dct-cred-input" type="password" id="' + id + '-pass" autocomplete="new-password" placeholder="Minimal 5 karakter"></div>'
    + '<div class="dct-cred-row"><label class="dct-cred-label">Konfirmasi Password</label>'
    + '<input class="dct-cred-input" type="password" id="' + id + '-pass2" autocomplete="new-password" placeholder="Ulangi password baru"></div>'
    + '<div class="dct-cred-status" id="' + id + '-status" style="display:none"></div>'
    + '<button class="dct-cred-btn" id="' + id + '-btn"><i class="fas fa-floppy-disk"></i> Simpan ' + title + '</button>'
    + '</div></div>';
}

function _renderSettingTab(d, container) {
  var oui  = String(d.id || '').slice(0, 6).toUpperCase();
  var vCfg = (typeof getVendorSecurityConfig === 'function') ? getVendorSecurityConfig(d.model, oui, d.mfr) : null;
  // Profil keamanan teresolusi (untuk deteksi keluarga firmware via template).
  var secProf = (typeof getSecurityProfile === 'function') ? getSecurityProfile(d.model, oui, d.mfr) : null;

  // Fallback ke VirtualParameters universal jika vendor config tidak mendefinisikan path
  var superCfg = {
    passPath:    (vCfg && vCfg.adminSuperPassPath) || 'VirtualParameters.superAdmin',
    userPath:    (vCfg && vCfg.adminSuperUserPath) || '',
    userLocked:  !!(vCfg && vCfg.adminSuperUserLocked),
    currentUser: (vCfg && vCfg.adminSuperCurrentUser) || '',
    // Vendor yang firmware-nya TIDAK mengekspos akun web sama sekali (Huawei HG8245A/H).
    // Tanpa ini form jatuh ke VirtualParameters.superAdmin (skrip universal) yang akan
    // "berhasil" tanpa mengubah apa pun di ONU — lebih buruk daripada menolak terus terang.
    unsupported:     (vCfg && vCfg.adminSuperSupported === false),
    unsupportedNote: (vCfg && vCfg.adminSuperNote) || '',
  };
  // Akun "user" TIDAK dapat diubah via TR-069 pada firmware CMCC ZTE F663 (diverifikasi
  // F663NV9 & F663NV3a: satu-satunya akun web = X_CMCC_TeleComAccount = super-admin;
  // node UserInterface/User/X_ZTE-COM tidak ada → VP userPassword/userAdmin no-op).
  // DETEKSI RUNTIME berbasis template profil (X_CMCC) → kebal terhadap entri
  // localStorage lama yang belum menandai adminUserSupported:false. Tetap hormati
  // adminUserSupported:false yang eksplisit (mis. bila vendor lain juga tak mendukung).
  var _isCmcc = !!(secProf && secProf.template === 'X_CMCC');
  var userUnsupported = (vCfg && vCfg.adminUserSupported === false) || _isCmcc;
  var userCfg = {
    passPath:    (vCfg && vCfg.adminUserPassPath)  || 'VirtualParameters.userPassword',
    userPath:    (vCfg && vCfg.adminUserUserPath)  || 'VirtualParameters.userAdmin',
    userLocked:  !!(vCfg && vCfg.adminUserUserLocked),
    currentUser: (vCfg && vCfg.adminUserCurrentUser) || '',
    unsupported:     userUnsupported,
    unsupportedNote: (vCfg && vCfg.adminUserNote)
      || (_isCmcc ? 'Firmware CMCC ZTE (keluarga F663) hanya mengekspos akun Super Admin via TR-069 — akun "user" tidak dapat diubah dari ACS.' : ''),
  };

  container.innerHTML =
    _credSection('stg-super', 'Ganti Kredensial Super Admin', 'fa-crown', superCfg)
    + _credSection('stg-user',  'Ganti Kredensial User Admin',  'fa-user',  userCfg)
    + '<div class="dct-setting-section">'
    + '<div class="dct-setting-label"><i class="fas fa-circle-exclamation"></i> Informasi Fault</div>'
    + '<div id="stg-fault-content"><i class="fas fa-spinner fa-spin" style="font-size:11px;color:var(--text-muted)"></i> Memuat...</div>'
    + '</div>';

  if (superCfg.passPath) {
    var btnS = document.getElementById('stg-super-btn');
    if (btnS) btnS.addEventListener('click', function() {
      _settSaveAdmin(d, 'super', superCfg.passPath, superCfg.userPath, superCfg.userLocked ? superCfg.currentUser : '');
    });
  }
  if (userCfg.passPath) {
    var btnU = document.getElementById('stg-user-btn');
    if (btnU) btnU.addEventListener('click', function() {
      _settSaveAdmin(d, 'user', userCfg.passPath, userCfg.userPath, userCfg.userLocked ? userCfg.currentUser : '');
    });
  }

  // Render isi awal sekali; polling berkala baru dimulai oleh showConfigTab
  // ketika tab Setting benar-benar dibuka (hemat resource saat tab tersembunyi).
  if (_settFaultIv) { clearInterval(_settFaultIv); _settFaultIv = null; }
  _updateFaultSection();
}

// Save admin credential via setParameterValues task
// lockedUser: bila username dikunci (tak ada input) tapi userPath dikonfigurasi,
// kirim username tetap ini bersama password (mis. X_CMCC_UserInfo.ServiceName='user').
function _settSaveAdmin(d, role, passPath, userPath, lockedUser) {
  var pfx      = 'stg-' + role;
  var passEl   = document.getElementById(pfx + '-pass');
  var pass2El  = document.getElementById(pfx + '-pass2');
  var userEl   = userPath ? document.getElementById(pfx + '-user') : null;
  var statusEl = document.getElementById(pfx + '-status');
  var btnEl    = document.getElementById(pfx + '-btn');

  var pass  = passEl  ? passEl.value  : '';
  var pass2 = pass2El ? pass2El.value : '';
  // Username: dari input bila ada; jika dikunci, pakai lockedUser yang dikonfigurasi.
  var user  = userEl ? userEl.value.trim() : (lockedUser || '');

  if (!pass)          { _settStatus(statusEl, 'Password tidak boleh kosong.', 'error'); return; }
  if (pass.length < 5){ _settStatus(statusEl, 'Password minimal 5 karakter.', 'error'); return; }
  if (pass !== pass2) { _settStatus(statusEl, 'Konfirmasi password tidak cocok.', 'error'); return; }

  var params   = [];
  if (user && userPath) params.push([userPath, user, 'xsd:string']);
  params.push([passPath, pass, 'xsd:string']);

  var roleName = role === 'super' ? 'Super Admin' : 'User Admin';
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyimpan...'; }
  _settStatus(statusEl, '', '');

  _setParamGuard(d, params)
    .then(function() {
      _settStatus(statusEl, 'Berhasil disimpan. ONU akan menerapkan perubahan.', 'success');
      if (passEl)  passEl.value  = '';
      if (pass2El) pass2El.value = '';
      if (userEl)  userEl.value  = '';
    })
    .catch(function(e) {
      _settStatus(statusEl, 'Gagal menyimpan: ' + (e.message || String(e)), 'error');
    })
    .finally(function() {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan ' + roleName;
      }
    });
}

function _settStatus(el, msg, type) {
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.textContent = msg;
  el.className = 'dct-cred-status dct-cs-' + (type || 'info');
}

// Refresh the fault section using latest App.currentDevice data + GenieACS faults API
function _updateFaultSection() {
  var el = document.getElementById('stg-fault-content');
  if (!el) return;
  var d = App.currentDevice;
  if (!d) return;

  var faults = [];
  if (!d.online) faults.push({ icon: 'fa-plug-circle-xmark', msg: 'ONU Offline — tidak ada koneksi ke OLT', cls: 'fault-error' });
  var rxv = parseFloat(d.rx);
  if (!isNaN(rxv) && rxv < -25) faults.push({ icon: 'fa-signal-weak', msg: 'Sinyal Optik Lemah: ' + d.rx + ' dBm (< -25 dBm)', cls: 'dct-fault-warn' });
  // Suhu nyata dari VirtualParameters.gettemp (d.temp), bukan turunan dari RX power.
  // 0 / tidak terbaca → diabaikan (jangan munculkan fault palsu).
  var tv = parseFloat(d.temp);
  if (!isNaN(tv) && tv > 65) faults.push({ icon: 'fa-temperature-arrow-up', msg: 'Suhu ONU Tinggi: ' + tv + '°C (> 65°C)', cls: 'fault-error' });

  ACS.getFaults(d.id)
    .then(function(acsFaults) {
      acsFaults.forEach(function(f) {
        var code = f.code || f.channel || 'fault';
        var msg  = f.message || f.detail || 'GenieACS Fault';
        var prov = f.provisions ? (' — ' + f.provisions) : '';
        var ch   = f.channel || '';
        faults.push({
          icon: 'fa-circle-xmark',
          msg:  '[' + code + '] ' + msg + prov,
          cls:  'fault-error',
          // _id GenieACS berbentuk "<deviceId>:<channel>". Bila tak terkirim,
          // susun sendiri — tanpa id, tombol hapus tidak bisa ditampilkan.
          id:   f._id || (ch ? (d.id + ':' + ch) : ''),
          // Kanal `task_*` berarti ada perintah mengantre yang ikut terhapus.
          punyaTugas: /^task_/.test(ch),
        });
      });
      el.innerHTML = _buildFaultHtml(faults);
      _pasangTombolFault(d);
    })
    .catch(function() {
      el.innerHTML = _buildFaultHtml(faults);
      _pasangTombolFault(d);
    });
}

/* Tombol hapus fault.

   KENAPA ADA: fault yang tersimpan di GenieACS menyumbat antrean ONU-nya.
   Selama fault dari sebuah task masih ada, perintah berikutnya untuk ONU itu
   ikut tertahan — jadi Refresh terasa "tidak mempan" tanpa penjelasan. Sampai
   sekarang satu-satunya cara membersihkannya adalah lewat basis data.

   PENTING: untuk fault berkanal `task_*`, GenieACS ikut MENGHAPUS task-nya
   (diperiksa di sumber genieacs-nbi 1.2.13). Itu memang yang diperlukan —
   task yang gagal permanen akan gagal lagi di tiap sesi selamanya — tetapi
   artinya perintah yang mengantre dibatalkan. Operator harus diberi tahu,
   bukan dibiarkan menebak. */
function _pasangTombolFault(d) {
  // Isi bagian ini digambar ulang tiap 20 detik, jadi listener lama ikut
  // terbuang bersama elemennya. Pasang baru setiap kali — tidak perlu penjaga
  // "sudah terpasang", dan tidak ada listener yang menumpuk.
  var el = document.getElementById('stg-fault-content');
  if (!el) return;

  el.querySelectorAll('.dct-fault-del').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _hapusFault(d, [{ id: btn.dataset.fault, punyaTugas: !!btn.dataset.tugas }], btn);
    });
  });

  var semua = document.getElementById('btnHapusSemuaFault');
  if (semua) semua.addEventListener('click', function() {
    var daftar = [];
    el.querySelectorAll('.dct-fault-del').forEach(function(b) {
      daftar.push({ id: b.dataset.fault, punyaTugas: !!b.dataset.tugas });
    });
    _hapusFault(d, daftar, semua);
  });
}

function _hapusFault(d, daftar, btn) {
  if (!daftar.length) return;
  var adaTugas = daftar.some(function(x) { return x.punyaTugas; });
  var judul = daftar.length > 1 ? 'Hapus ' + daftar.length + ' fault?' : 'Hapus fault ini?';

  showConfirm({
    title: judul,
    icon: 'fa-trash-can',
    yesLabel: 'Hapus',
    message: 'Fault dihapus dari GenieACS agar antrean perintah ONU ini tidak lagi tersumbat.'
      + (adaTugas
          ? '<div style="margin-top:10px;padding:9px 11px;background:var(--amber-light);'
            + 'border-radius:8px;font-size:12.5px;line-height:1.5">'
            + '<i class="fas fa-triangle-exclamation"></i> '
            + '<strong>Perintah yang mengantre ikut dibatalkan.</strong> '
            + 'Fault ini berasal dari sebuah task, dan GenieACS menghapus task-nya sekaligus. '
            + 'Itu memang perlu — task yang gagal permanen akan gagal lagi di setiap sesi — '
            + 'tetapi perubahan yang belum sempat terkirim harus dikirim ulang.</div>'
          : '')
      + '<div style="margin-top:8px;color:var(--text-muted);font-size:12px">'
      + 'Tidak ada perintah apa pun yang dikirim ke ONU. Ini hanya membersihkan '
      + 'catatan di sisi ACS.</div>',
  }, function() {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    var ok = 0, gagal = 0, pesan = '';
    // Berurutan, bukan paralel: GenieACS mengunci sesi per-perangkat saat
    // menghapus, jadi permintaan serentak ke ONU yang sama saling menolak
    // dengan 503.
    var rantai = Promise.resolve();
    daftar.forEach(function(f) {
      rantai = rantai.then(function() {
        return ACS.deleteFault(f.id)
          .then(function() { ok++; })
          .catch(function(e) { gagal++; pesan = e.message || 'gagal'; });
      });
    });
    rantai.then(function() {
      if (gagal) {
        showToast(ok ? (ok + ' fault dihapus, ' + gagal + ' gagal: ' + pesan) : pesan,
                  gagal && !ok ? 'error' : 'info');
      } else {
        showToast(ok > 1 ? (ok + ' fault dihapus — antrean ONU bersih')
                         : 'Fault dihapus — antrean ONU bersih', 'success');
      }
      _updateFaultSection();
    });
  });
}

/* Daftar fault.

   Dua jenis baris yang sengaja dibedakan:

     • Fault TURUNAN (ONU offline, sinyal lemah, suhu tinggi) — dihitung panel
       dari data perangkat. Tidak ada yang bisa dihapus; ia hilang sendiri
       ketika keadaannya membaik. Tidak diberi tombol, supaya tidak ada yang
       menekan lalu bingung kenapa tak terjadi apa-apa.

     • Fault GENIEACS (punya `id`) — tersimpan nyata di basis data ACS dan
       MENYUMBAT antrean ONU: selama fault dari sebuah task masih ada,
       perintah berikutnya untuk ONU itu ikut tertahan. Inilah yang perlu
       tombol hapus. */
function _buildFaultHtml(faults) {
  if (faults.length === 0) {
    return '<div class="dct-fault-ok"><i class="fas fa-circle-check"></i> Tidak ada fault terdeteksi</div>';
  }
  var bisaHapus = faults.filter(function(f) { return f.id; });
  var kepala = bisaHapus.length > 1
    ? '<div class="dct-fault-head">'
      + '<span>' + bisaHapus.length + ' fault tersimpan di GenieACS</span>'
      + '<button type="button" class="dct-fault-clear-all" id="btnHapusSemuaFault">'
      + '<i class="fas fa-broom"></i> Hapus semua</button></div>'
    : '';
  return kepala + '<div class="dct-fault-list">'
    + faults.map(function(f) {
        var tombol = f.id
          ? '<button type="button" class="dct-fault-del" data-fault="' + _esc(f.id) + '"'
            + ' data-tugas="' + (f.punyaTugas ? '1' : '') + '"'
            + ' title="Hapus fault ini dari GenieACS">'
            + '<i class="fas fa-trash-can"></i></button>'
          : '';
        return '<div class="dct-fault-item ' + (f.cls || '') + '">'
             + '<i class="fas ' + f.icon + '"></i> '
             + '<span class="dct-fault-msg">' + _esc(f.msg) + '</span>'
             + tombol + '</div>';
      }).join('')
    + '</div>';
}

// ─── SSID Tab: shared poll helper ────────────────────────────────────────────
// Polls fetchDevice every 2s until _lastInform changes from prevRaw.
// Calls onDone(newDevice) or onTimeout() after maxWait ms.
function pollForUpdate(prevRaw, onDone, onTimeout, maxWait) {
  const POLL = 2000;
  // Batas tunggu default = ACS.SUMMON_WAIT_MS (lihat alasan & hasil ukur di api.js).
  // Singkatnya: sebagian ONU menahan connection-request ~60 dtk sebelum menelepon
  // balik, jadi batas 30-60 dtk melaporkan "tidak merespons" untuk refresh yang
  // sebenarnya berhasil. Poll berhenti segera setelah _lastInform berubah, jadi
  // batas yang longgar tidak memperlambat ONU yang responsif.
  const MAX  = maxWait || (typeof ACS !== 'undefined' && ACS.SUMMON_WAIT_MS) || 120000;
  let waited = 0;
  const iv = setInterval(async () => {
    waited += POLL;
    if (waited > MAX) { clearInterval(iv); onTimeout(); return; }
    try {
      const nd = await ACS.fetchDevice(App.currentDevice.id);
      const newRaw = nd && (nd.lastInformRaw || nd.lastInform);
      if (nd && newRaw && newRaw !== prevRaw) { clearInterval(iv); onDone(nd); }
    } catch (_) {}
  }, POLL);
  return iv;
}

// ─── Nasib sebuah task: laporkan APA ADANYA, jangan menebak ──────────────────
//
// Sebelum 2026-08-02 panel menyimpulkan berhasil/gagal dari berubahnya
// `_lastInform`. Itu bukan bukti: `_lastInform` berubah pada SETIAP sesi,
// termasuk sesi yang faultnya membatalkan pekerjaan — dan tidak berubah sama
// sekali bila ONU menjalankan task pada sesi yang panel keburu berhenti
// menunggu. Keduanya sudah terjadi di produksi: penghapusan WAN yang BERHASIL
// dilaporkan "ONU tidak merespons", membuat teknisi mengulang dan meninggalkan
// objek yatim.
//
// Sekarang: GenieACS yang ditanya. Task tuntas dihapus dari koleksi `tasks`;
// task bermasalah meninggalkan fault berkanal `task_<id>`. Keduanya READ-ONLY
// (GET biasa) — tidak mengantre apa pun ke ONU, jadi tak bisa memicu tulis flash.
//
// Kembalian: {ok:true} | {ok:false, alasan, ditolak?, menunggu?}
async function _tungguTask(devId, hasil, setTeks, labelTunggu) {
  if (hasil && hasil.done) return { ok: true };
  if (!hasil || !hasil.taskId) {
    return { ok: false, alasan: 'ACS tidak mengembalikan ID task — perintah tidak tercatat' };
  }
  var o = await ACS.awaitTask(devId, hasil.taskId, ACS.TASK_WAIT_MS, function(sisa) {
    if (setTeks) setTeks((labelTunggu || 'Menunggu ONU') + '… ' + sisa + ' dtk');
  });
  if (o.state === 'selesai') return { ok: true };
  if (o.state === 'gagal') {
    return { ok: false, ditolak: true,
             alasan: 'ONU menolak perintah (' + o.code + ': ' + (o.message || '-') + ')' };
  }
  return { ok: false, menunggu: true,
           alasan: 'ONU belum terhubung. Perintah tersimpan di ACS dan akan '
                 + 'dijalankan saat ONU inform berikutnya — jangan diulang, '
                 + 'pengulangan hanya menumpuk perintah kembar. Bila dalam '
                 + TASK_KEDALUWARSA_MENIT + ' menit ONU belum juga menjalankannya, '
                 + 'panel membatalkannya otomatis agar tidak berlaku mendadak '
                 + 'di kemudian hari.' };
}

// Harus sama dengan antrean.KEDALUWARSA_MENIT di server (dijaga
// tests/antrean.test.py). Server-lah yang membatalkan; angka ini hanya untuk
// memberi tahu teknisi apa yang akan terjadi.
var TASK_KEDALUWARSA_MENIT = 30;

// Apakah sudah ada task sejenis yang mengantre untuk perangkat ini?
// Mencegah penumpukan perintah kembar — sumber WAN Connection kosong yang yatim.
async function _adaTaskKembar(devId, nama, objectName) {
  try {
    var antre = await ACS.pendingTasks(devId);
    return (antre || []).some(function(t) {
      return t.name === nama && (!objectName || t.objectName === objectName);
    });
  } catch (_) { return false; }
}

// ─── Sanitize string for safe innerHTML use ───────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Decode BeaconType → human label + CSS class ─────────────────────────────
function _ssidSecurity(beaconType) {
  const b = (beaconType || '').toLowerCase();
  if (b.includes('wpa') && (b.includes('wpa2') || b.includes('11i'))) return { label: 'WPA/WPA2', cls: 'sec-wpa2' };
  if (b === '11i' || b.includes('wpa2'))  return { label: 'WPA2',     cls: 'sec-wpa2' };
  if (b === 'wpa'  || b.includes('wpa'))  return { label: 'WPA',      cls: 'sec-wpa'  };
  if (b === 'basic' || b === 'none' || b === '') return { label: 'Open/None', cls: 'sec-open' };
  return { label: beaconType || '—', cls: '' };
}

// ─── Radio (Channel & Bandwidth) — properti per-BAND, dipakai bersama semua SSID ──
// Channel & ChannelWidth adalah properti RADIO fisik: semua SSID pada band yang sama
// (mis. 2.4GHz WLAN.1–4) berbagi nilai yang sama. Panel ini mengatur sekali lalu
// menerapkan ke SELURUH slot band tsb → tak ada lagi ketidakcocokan antar-SSID.
function _radioBands(d) {
  var order = ['24', '5'], map = {};
  (d.ssids || []).forEach(function(s) {
    var k = is5GHz(s) ? '5' : '24';
    (map[k] = map[k] || { key: k, is5g: k === '5', label: k === '5' ? '5 GHz' : '2.4 GHz', ssids: [] }).ssids.push(s);
  });
  return order.filter(function(k){ return map[k]; }).map(function(k) {
    var g = map[k];
    g.rep = g.ssids.filter(function(s){ return s.enabled; })[0] || g.ssids[0];  // wakil utk nilai saat ini
    return g;
  });
}
// Ada kontrol radio bila minimal satu SSID punya channel writable ATAU tipe bandwidth.
function _radioHasControls(d) {
  return (d.ssids || []).some(function(s){ return s.channelWritable || s.channelWidthType; });
}
function _radioChOpts(is5g, cur) {
  var list = is5g
    ? [36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,149,153,157,161,165]
    : [1,2,3,4,5,6,7,8,9,10,11,12,13];
  var suf = is5g ? ' (5 GHz)' : ' (2.4 GHz)';
  var html = '<option value="auto"' + (cur === 'auto' ? ' selected' : '') + '>Auto</option>';
  list.forEach(function(c){ html += '<option value="' + c + '"' + (cur === String(c) ? ' selected' : '') + '>' + c + suf + '</option>'; });
  return html;
}
function _radioBwOpts(type, curVal, is5g) {
  // X_ZTE-COM (F679L/F670L): leaf X_ZTE-COM_OperatingChannelBandwidth bernilai STRING.
  // Diverifikasi live: 2.4G = '40MHz', 5G = '80MHz' → opsi 80MHz HANYA ditawarkan di 5G
  // (radio 2.4G tak mendukung 80MHz).
  if (type === 'ztecom') {
    // 'Auto' = biarkan radio memilih (nilai bawaan firmware). Pilih 20/40/80 utk MENGUNCI.
    // Catatan lapangan: dgn 'Auto' di 2.4GHz, radio sering turun ke 20MHz krn coexistence.
    var opts = is5g ? ['Auto','20MHz','40MHz','80MHz'] : ['Auto','20MHz','40MHz'];
    return opts.map(function(b){
      var lbl = b === 'Auto' ? 'Auto (radio yang memilih)' : b;
      return '<option value="' + b + '"' + (curVal === b ? ' selected' : '') + '>' + lbl + '</option>';
    }).join('');
  }
  /* Huawei (X_HW_HT20) — DIUKUR LANGSUNG, bukan diasumsikan.
     SN 485754432B16F9AE (HG8245W5-6T), 2026-09-25. Operator mengubah lebar
     kanal dari web ONU satu per satu; tiap langkah parameternya ditarik ulang:

         setelan di web ONU     2.4GHz          5GHz
         Auto                   HT20=0  20MHz   HT20=3  80MHz
         20 MHz                 HT20=1  20MHz   HT20=1  20MHz
         40 MHz                 HT20=2  40MHz   HT20=2  40MHz

     Jadi X_HW_HT20 adalah ENUM LEBAR KANAL, bukan sakelar on/off:
         0 = Auto 20/40   (2.4GHz)
         1 = 20 MHz       (kedua band)
         2 = 40 MHz       (kedua band)
         3 = Auto 80/40/20 (5GHz)

     KEKELIRUAN YANG DIPERBAIKI DI SINI. Sebelumnya berkas ini menyatakan
     "0 = 20/40, HT20 mati" dan melabelinya **"40 MHz"**. Asumsi itu dibuat
     2026-07-13 dari model LAIN (HG8245A/H, single-band) tanpa uji tulis, dan
     ternyata terbalik: 0 adalah AUTO. Akibatnya siapa pun yang memilih
     "40 MHz" di panel sebenarnya menyetel Auto — dan 40 MHz yang sesungguhnya
     (nilai 2) tidak pernah bisa dipilih sama sekali.

     Nilai 3 pada 2.4GHz dan 0 pada 5GHz BELUM pernah terlihat, jadi sengaja
     tidak ditawarkan. Lebih baik kehilangan satu pilihan yang mungkin ada
     daripada menawarkan yang mungkin ditolak firmware.

     Yang ditampilkan adalah SETELAN (X_HW_HT20), bukan lebar operasi
     (X_HW_CurrentOperatingChannelBandwidth yang read-only). Pada mode Auto
     keduanya sering berbeda — 2.4GHz di atas menunjukkan Auto tetapi beroperasi
     20MHz karena kanal 11 ramai. Menampilkan lebar operasi akan membuat
     pengguna mengira setelannya gagal tersimpan. */
  if (type === 'hwht20') {
    var hw = is5g
      ? [{v:3,l:'Auto (80/40/20 MHz)'},{v:2,l:'40 MHz'},{v:1,l:'20 MHz'}]
      : [{v:0,l:'Auto (20/40 MHz)'},   {v:2,l:'40 MHz'},{v:1,l:'20 MHz'}];
    return hw.map(function(o){
      return '<option value="' + o.v + '"' + (curVal === o.v ? ' selected' : '') + '>' + o.l + '</option>';
    }).join('');
  }
  if (type === 'xcmcc' || type === 'ctcom') {
    return [{v:2,l:'Auto (20/40 MHz)'},{v:0,l:'20 MHz'},{v:1,l:'40 MHz'}].map(function(o){
      return '<option value="' + o.v + '"' + (curVal === o.v ? ' selected' : '') + '>' + o.l + '</option>';
    }).join('');
  }
  // F9V (X_CU) — leaf 'BandWidth' string. HANYA 20MHz & 40MHz: diuji live pada
  // SN ELWRP93H6152818 → keduanya diterapkan, sedangkan 'Auto' diterima tanpa error
  // TAPI nilainya tak pernah berubah (diabaikan firmware) → jangan tawarkan.
  if (type === 'bwstr') {
    return ['20MHz','40MHz'].map(function(b){
      return '<option value="' + b + '"' + (curVal === b ? ' selected' : '') + '>' + b + '</option>';
    }).join('');
  }
  return ['Auto','20MHz','40MHz','20/40MHz'].map(function(b){
    return '<option value="' + b + '"' + (curVal === b ? ' selected' : '') + '>' + b + '</option>';
  }).join('');
}
// Jaring pengaman UI: bila nilai ONU saat ini TIDAK ada di daftar opsi, <select> diam-diam
// memilih opsi PERTAMA → dropdown menampilkan kondisi PALSU (mis. ONU 80MHz, tapi tampil
// '20MHz'), dan operator mengira sudah benar padahal tak pernah dikirim. Sisipkan nilai
// asli sbg opsi terpilih agar dropdown SELALU jujur mencerminkan ONU.
function _radioBwOptsSafe(type, curVal, is5g) {
  var html = _radioBwOpts(type, curVal, is5g);
  var cur  = (curVal == null || curVal === '') ? null : String(curVal);
  if (cur && html.indexOf('value="' + cur + '"') === -1) {
    html = '<option value="' + _esc(cur) + '" selected>' + _esc(cur) + ' (nilai ONU saat ini)</option>' + html;
  }
  return html;
}
function _radioShowConfig(d, container) {
  var bands = _radioBands(d);
  var sections = bands.map(function(g) {
    var rep = g.rep || {};
    var chHtml = '', bwHtml = '';
    if (rep.channelWritable) {
      var cur = (rep.autoChannel || rep.channel === 0) ? 'auto' : String(rep.channel);
      chHtml = '<div class="ssid-form-group">'
        + '<label class="ssid-form-label"><i class="fas fa-broadcast-tower"></i> Channel</label>'
        + '<select class="ssid-form-select" id="rcCh_' + g.key + '">' + _radioChOpts(g.is5g, cur) + '</select></div>';
    }
    if (rep.channelWidthType) {
      // Tampilkan nilai ONU saat ini secara EKSPLISIT di label — agar operator langsung
      // tahu apakah dropdown benar-benar mencerminkan perangkat (bukan tebakan browser).
      var bwCur = (rep.channelWidthVal == null || rep.channelWidthVal === '') ? null
                : (rep.channelWidthType === 'xcmcc' || rep.channelWidthType === 'ctcom')
                  ? ({ 0: '20 MHz', 1: '40 MHz', 2: 'Auto 20/40' }[rep.channelWidthVal] || rep.channelWidthVal)
                  : rep.channelWidthVal;
      // Bila master 'Auto' (atau beda dgn lebar kanal yang benar-benar dipakai radio),
      // tampilkan keduanya — supaya jelas kenapa "sudah 40MHz" tapi radio jalan di 20MHz.
      var bwOper = rep.channelWidthOper || null;
      var bwTxt  = bwCur ? String(bwCur) : null;
      if (bwTxt && bwOper && String(bwOper) !== bwTxt) bwTxt += ' \u2192 radio: ' + bwOper;
      bwHtml = '<div class="ssid-form-group">'
        + '<label class="ssid-form-label"><i class="fas fa-chart-bar"></i> Channel Bandwidth'
        + (bwTxt ? '<span class="rc-cur">Saat ini: ' + _esc(bwTxt) + '</span>' : '')
        + '</label>'
        + '<select class="ssid-form-select" id="rcBw_' + g.key + '">' + _radioBwOptsSafe(rep.channelWidthType, rep.channelWidthVal, g.is5g) + '</select></div>';
    }
    if (!chHtml && !bwHtml) return '';
    return '<div class="radio-band-card">'
      + '<div class="radio-band-head">'
      + '<span class="radio-band-badge' + (g.is5g ? ' band5' : '') + '">' + g.label + '</span>'
      + '<span class="radio-band-sub">' + g.ssids.length + ' SSID sepita</span>'
      + '</div>' + chHtml + bwHtml + '</div>';
  }).join('');

  container.innerHTML =
    '<div class="ssid-cfg-panel">'
    + '<div class="ssid-cfg-hdr">'
    + '<button class="ssid-back-btn" id="btnRadioBack"><i class="fas fa-arrow-left"></i> Kembali</button>'
    + '<span class="ssid-cfg-title"><i class="fas fa-tower-broadcast"></i> Channel &amp; Bandwidth</span>'
    + '</div>'
    + '<div class="radio-note"><i class="fas fa-circle-info"></i> Pengaturan Channel &amp; Bandwidth berlaku untuk <b>semua SSID</b> pada radio yang sama (mis. SSID 1–4). Mengubah salah satu = mengubah semuanya.</div>'
    + (sections || '<div class="ssid-form-hint" style="text-align:center;padding:16px">Perangkat ini tidak mengekspos kontrol Channel/Bandwidth via TR-069.</div>')
    + '<div class="ssid-save-status" id="radioSaveStatus" style="display:none"></div>'
    + '<button class="ssid-save-btn" id="btnRadioSave"><i class="fas fa-floppy-disk"></i> Simpan &amp; Terapkan ke Semua SSID</button>'
    + '</div>';

  var back = document.getElementById('btnRadioBack');
  if (back) back.addEventListener('click', function(){ renderSsidTab(d, container); });
  var save = document.getElementById('btnRadioSave');
  if (save) save.addEventListener('click', function(){ _radioHandleSave(d, container); });
}
function _radioHandleSave(d, container) {
  var bands  = _radioBands(d);
  var params = [];
  bands.forEach(function(g) {
    var chEl = document.getElementById('rcCh_' + g.key);
    var bwEl = document.getElementById('rcBw_' + g.key);
    var chVal = chEl ? chEl.value : null;
    var bwVal = bwEl ? bwEl.value : null;
    // Terapkan ke SETIAP slot band ini (semua SSID sepita) agar nilainya seragam.
    g.ssids.forEach(function(s) {
      var base = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + s.idx + '.';
      if (chVal !== null && s.channelWritable) {
        var prevAuto = (s.autoChannel || s.channel === 0);
        var nowAuto  = chVal === 'auto';
        var newCh    = nowAuto ? 0 : parseInt(chVal, 10);
        if (prevAuto !== nowAuto || (!nowAuto && newCh !== s.channel)) {
          params.push([base + 'AutoChannelEnable', nowAuto ? 'true' : 'false', 'xsd:boolean']);
          params.push([base + 'Channel',           newCh,                      'xsd:unsignedInt']);
        }
      }
      // Tulis ke param yang DITENTUKAN api.js (channelWidthParam) — untuk X_ZTE-COM itu
      // 'BandWidth' (master), BUKAN X_ZTE-COM_OperatingChannelBandwidth yang cuma hasil
      // operasi radio & akan ditimpa balik. Tipe menentukan ENKODING nilainya saja.
      if (bwVal !== null && s.channelWidthType && s.channelWidthParam) {
        var isInt = (s.channelWidthType === 'xcmcc' || s.channelWidthType === 'ctcom'
                  || s.channelWidthType === 'hwht20');   // Huawei X_HW_HT20 = unsignedInt 0/1/2/3
        var newVal = isInt ? parseInt(bwVal, 10) : bwVal;
        if (newVal !== s.channelWidthVal) {
          params.push([base + s.channelWidthParam, newVal, isInt ? 'xsd:unsignedInt' : 'xsd:string']);
        }
      }
    });
  });
  if (params.length === 0) { showToast('Tidak ada perubahan untuk disimpan', 'error'); return; }

  var btn  = document.getElementById('btnRadioSave');
  var stEl = document.getElementById('radioSaveStatus');
  if (btn)  { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengirim…'; }
  if (stEl) { stEl.textContent = 'Menerapkan Channel & Bandwidth ke semua SSID…'; stEl.className = 'ssid-save-status st-info'; stEl.style.display = 'block'; }

  // Rekam nilai bandwidth yang DIMINTA per SSID → dipakai untuk VERIFIKASI setelah ONU
  // merespons. Sebagian firmware menerima SetParameterValues (tanpa fault) tetapi DIAM-DIAM
  // mengabaikan nilainya (mis. 'Auto' pada F9V). Tanpa verifikasi, panel akan melapor
  // "berhasil" padahal tak ada yang berubah — persis keluhan yang sulit dilacak.
  var wantBw = {};
  bands.forEach(function(g) {
    var bwEl = document.getElementById('rcBw_' + g.key);
    if (!bwEl) return;
    g.ssids.forEach(function(s) { if (s.channelWidthType) wantBw[s.idx] = bwEl.value; });
  });

  var prevRaw = d.lastInformRaw || d.lastInform;
  _setParamGuard(d, params)
    .then(function() {
      if (stEl) stEl.textContent = 'Menunggu ONU menerapkan perubahan…';
      pollForUpdate(prevRaw,
        function(nd) {
          App.currentDevice = nd;
          // Verifikasi: bandingkan nilai BARU di ONU dengan yang diminta.
          var ignored = (nd.ssids || []).filter(function(s) {
            var want = wantBw[s.idx];
            if (want == null || !s.channelWidthType) return false;
            var got = s.channelWidthVal;
            if (s.channelWidthType === 'xcmcc' || s.channelWidthType === 'ctcom') {
              return parseInt(want, 10) !== got;
            }
            return String(want) !== String(got);
          });
          if (ignored.length) {
            var slots = ignored.map(function(s){ return 'SSID ' + s.idx; }).join(', ');
            showToast('ONU mengabaikan Bandwidth pada ' + slots + ' — nilai tak berubah', 'error');
          } else if ((nd.ssids || []).some(function(s) {
            // Master tersimpan, TAPI radio memakai lebar lain (mis. 'Auto' → 20MHz karena
            // coexistence 2.4GHz). Bukan kegagalan panel — beri tahu apa adanya.
            return wantBw[s.idx] != null && s.channelWidthOper
                && String(s.channelWidthOper) !== String(s.channelWidthVal);
          })) {
            showToast('Tersimpan, tetapi radio memakai lebar kanal lain (lihat "Saat ini")', 'info');
          } else {
            showToast('Channel & Bandwidth diterapkan ke semua SSID', 'success');
          }
          renderSsidTab(nd, container);
        },
        function() {
          if (btn)  { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan &amp; Terapkan ke Semua SSID'; }
          if (stEl) { stEl.textContent = 'ONU tidak merespons — coba ulangi'; stEl.className = 'ssid-save-status st-err'; }
          showToast('ONU tidak merespons (timeout)', 'error');
        }
      );
    })
    .catch(function(e) {
      if (btn)  { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan &amp; Terapkan ke Semua SSID'; }
      if (stEl) { stEl.textContent = 'Gagal: ' + (e.message || 'Error'); stEl.className = 'ssid-save-status st-err'; }
      showToast('Gagal mengirim konfigurasi', 'error');
    });
}

// ─── SSID Tab — LIST VIEW ─────────────────────────────────────────────────────
function renderSsidTab(d, container) {
  const allSsids = d.ssids || [];
  if (allSsids.length === 0) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)"><i class="fas fa-circle-info" style="margin-right:6px"></i>Data SSID tidak tersedia</div>';
    return;
  }

  // Tombol "Tambah SSID": ATURAN UMUM (semua vendor) — sembunyikan bila perangkat SUDAH
  // menampilkan >=4 SSID (mis. slot tetap C-DATA/HWTC/ZICG yang semua slotnya tampil, atau
  // perangkat yang memang sudah 4) → cukup aktif/nonaktifkan slot yang ada. TETAP tampil
  // bila slot sedikit (mis. hanya 1) agar masih bisa menambah. ssidNoAdd (per-vendor) =
  // paksa sembunyi terlepas dari jumlah.
  var _oui   = String(d.id || '').slice(0, 6).toUpperCase();
  var _secC  = (typeof getVendorSecurityConfig === 'function') ? getVendorSecurityConfig(d.model, _oui, d.mfr) : null;
  var _canAdd = !(_secC && _secC.ssidNoAdd) && (allSsids.length < 4);
  // Channel & Bandwidth = properti RADIO (dipakai bersama semua SSID sepita). Tampilkan
  // tombol pengaturan radio khusus bila ada SSID yang punya kontrol channel/bandwidth.
  var _radioAvail = _radioHasControls(d);

  container.innerHTML =
    '<div class="ssid-list-hdr">'
    + (_radioAvail ? '<button class="ssid-radio-btn" id="btnRadioCfg"><i class="fas fa-tower-broadcast"></i> Channel &amp; Bandwidth</button>' : '')
    + (_canAdd ? '<button class="ssid-add-btn" id="btnAddSsid"><i class="fas fa-plus"></i> Tambah SSID</button>' : '')
    + '</div>'
    + allSsids.map(function(s) {
        const band5   = is5GHz(s);
        const bandLbl = band5 ? '5GHz' : '2.4GHz';
        const bandCls = band5 ? 'band5' : (s.idx > 2 ? 'bandg' : '');
        const chLbl   = (s.autoChannel || s.channel === 0) ? 'Auto' : String(s.channel);
        const assoc   = s.associations || 0;
        const sec     = _ssidSecurity(s.beaconType);
        return '<div class="dct-ssid-card">'
          + '<div class="dct-ssid-header">'
          + '<span class="dct-ssid-band ' + bandCls + '">' + bandLbl + '</span>'
          + '<span class="dct-ssid-name">' + _esc(s.name) + '</span>'
          + '<div class="ssid-hdr-right">'
          + '<label class="ssid-sw" title="' + (s.enabled ? 'Nonaktifkan SSID' : 'Aktifkan SSID') + '">'
          + '<input type="checkbox" class="ssid-sw-inp" data-idx="' + s.idx + '"' + (s.enabled ? ' checked' : '') + '>'
          + '<span class="ssid-sw-track"><span class="ssid-sw-thumb"></span></span>'
          + '</label>'
          + '<span class="dct-ssid-status' + (s.enabled ? ' is-on' : '') + '" id="ssidStatus' + s.idx + '">'
          + (s.enabled ? 'Aktif' : 'Nonaktif') + '</span>'
          + '</div></div>'
          + '<div class="dct-ssid-rows">'
          + '<div class="dct-ssid-row"><span class="dct-ssid-key">Label:</span><span class="dct-ssid-val">SSID ' + s.idx + '</span></div>'
          + '<div class="dct-ssid-row"><span class="dct-ssid-key">Channel:</span><span class="dct-ssid-val">' + chLbl + '</span></div>'
          + ((s.channelWidthType === 'xcmcc' || s.channelWidthType === 'ctcom') && s.channelWidthVal != null
              ? '<div class="dct-ssid-row"><span class="dct-ssid-key">Bandwidth:</span><span class="dct-ssid-val">' + ({0:'20 MHz',1:'40 MHz',2:'Auto 20/40'}[s.channelWidthVal] || s.channelWidthVal) + '</span></div>'
              : (s.channelWidthType === 'standard' || s.channelWidthType === 'bwstr' || s.channelWidthType === 'ztecom') && s.channelWidthVal != null
              ? '<div class="dct-ssid-row"><span class="dct-ssid-key">Bandwidth:</span><span class="dct-ssid-val">' + s.channelWidthVal + '</span></div>'
              : '')
          + '<div class="dct-ssid-row"><span class="dct-ssid-key">Keamanan:</span><span class="dct-ssid-val ssid-sec ' + sec.cls + '">' + sec.label + '</span></div>'
          // Password: hanya bila firmware benar-benar mengeksposnya (F9V/X_CU lewat
          // PreSharedKey.1.KeyPassphrase). Mayoritas firmware mengembalikan kosong →
          // baris ini tak muncul sama sekali (tak ada placeholder menyesatkan).
          // Default TERSEMBUNYI (titik-titik) + tombol mata utk menampilkan & salin.
          + (s.password
              ? '<div class="dct-ssid-row"><span class="dct-ssid-key">Password:</span>'
                + '<span class="dct-ssid-val ssid-pw" id="ssidPw' + s.idx + '" data-pw="' + _esc(s.password) + '" data-shown="0">'
                + '<code class="ssid-pw-dots">••••••••</code>'
                + '<button class="ssid-pw-btn" data-pwidx="' + s.idx + '" title="Tampilkan password"><i class="fas fa-eye"></i></button>'
                + '<button class="ssid-pw-btn" data-pwcopy="' + s.idx + '" title="Salin password"><i class="fas fa-copy"></i></button>'
                + '</span></div>'
              : '')
          + '<div class="dct-ssid-row"><span class="dct-ssid-key">Perangkat:</span><span class="dct-ssid-val">' + assoc + ' terhubung</span></div>'
          + '</div>'
          + '<div class="ssid-card-foot">'
          + '<div class="ssid-toggle-st" id="ssidToggleSt' + s.idx + '" style="display:none"></div>'
          + '<button class="ssid-cfg-btn" data-idx="' + s.idx + '"><i class="fas fa-sliders"></i> Konfigurasi</button>'
          + '</div></div>';
      }).join('');

  // Wire toggle events
  container.querySelectorAll('.ssid-sw-inp').forEach(function(inp) {
    inp.addEventListener('change', function() {
      const idx  = parseInt(inp.dataset.idx, 10);
      const ssid = allSsids.find(function(s){ return s.idx === idx; });
      if (ssid) _ssidHandleToggle(d, ssid, inp, container);
    });
  });

  // Password SSID: tampilkan/sembunyikan + salin (hanya ada bila firmware mengeksposnya)
  container.querySelectorAll('[data-pwidx]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var wrap = document.getElementById('ssidPw' + btn.dataset.pwidx);
      if (!wrap) return;
      var shown = wrap.dataset.shown === '1';
      wrap.dataset.shown = shown ? '0' : '1';
      var code = wrap.querySelector('code');
      if (code) code.textContent = shown ? '••••••••' : wrap.dataset.pw;
      btn.innerHTML = '<i class="fas fa-eye' + (shown ? '' : '-slash') + '"></i>';
      btn.title = shown ? 'Tampilkan password' : 'Sembunyikan password';
    });
  });
  container.querySelectorAll('[data-pwcopy]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var wrap = document.getElementById('ssidPw' + btn.dataset.pwcopy);
      if (!wrap) return;
      var pw = wrap.dataset.pw || '';
      // Lewat copyText() (main.js): navigator.clipboard HANYA ada di secure
      // context, sedangkan panel diakses via http://<IP-LAN>:8081 — jalur lama
      // selalu jatuh ke "Clipboard tak tersedia" dan tombol ini tak pernah
      // berfungsi bagi operator. copyText punya cadangan execCommand.
      copyText(pw).then(
        function(){ showToast('Password SSID disalin', 'success'); },
        function(e){ showToast('Gagal menyalin password: ' + (e && e.message ? e.message : 'Error'), 'error'); });
    });
  });

  // Wire config buttons
  container.querySelectorAll('.ssid-cfg-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const idx  = parseInt(btn.dataset.idx, 10);
      const ssid = allSsids.find(function(s){ return s.idx === idx; });
      if (ssid) _ssidShowConfig(d, ssid, container);
    });
  });

  // Add SSID
  var addBtn = document.getElementById('btnAddSsid');
  if (addBtn) addBtn.addEventListener('click', function() {
    _ssidHandleAdd(d, container);
  });

  // Channel & Bandwidth (radio-level)
  var radioBtn = document.getElementById('btnRadioCfg');
  if (radioBtn) radioBtn.addEventListener('click', function() {
    _radioShowConfig(d, container);
  });
}

// ─── Toggle SSID enable / disable ────────────────────────────────────────────
function _ssidHandleToggle(d, ssid, inp, container) {
  const newEnabled = inp.checked;
  const stEl  = document.getElementById('ssidToggleSt' + ssid.idx);
  inp.disabled = true;
  if (stEl) { stEl.textContent = 'Mengirim…'; stEl.className = 'ssid-toggle-st'; stEl.style.display = 'block'; }

  const path    = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + ssid.idx + '.Enable';
  const prevRaw = d.lastInformRaw || d.lastInform;

  ACS.setParam(d.id, [[path, newEnabled, 'xsd:boolean']])
    .then(function() {
      if (stEl) stEl.textContent = 'Menunggu ONU…';
      pollForUpdate(prevRaw,
        function(nd) {
          App.currentDevice = nd;
          showToast(newEnabled ? 'SSID berhasil diaktifkan' : 'SSID berhasil dinonaktifkan', 'success');
          // Re-render list with fresh data from ONU
          renderSsidTab(nd, container);
        },
        function() {
          inp.checked = !newEnabled; inp.disabled = false;
          if (stEl) { stEl.textContent = 'ONU tidak merespons'; stEl.className = 'ssid-toggle-st st-err'; }
          showToast('Gagal mengubah status SSID', 'error');
          setTimeout(function(){ if (stEl) stEl.style.display = 'none'; }, 5000);
        }
      );
    })
    .catch(function() {
      inp.checked = !newEnabled; inp.disabled = false;
      if (stEl) { stEl.textContent = 'Gagal mengirim perintah'; stEl.className = 'ssid-toggle-st st-err'; stEl.style.display = 'block'; }
      showToast('Gagal mengubah status SSID', 'error');
    });
}

// ─── Detect if beaconType is WPA-based ───────────────────────────────────────
function _isWpaAuth(beaconType) {
  var b = (beaconType || '').toLowerCase();
  return b.includes('wpa') || b === '11i';
}

// ─── SSID Config View ─────────────────────────────────────────────────────────
function _ssidShowConfig(d, ssid, container) {
  const sec    = _ssidSecurity(ssid.beaconType);
  const chLbl  = (ssid.autoChannel || ssid.channel === 0) ? 'Auto' : String(ssid.channel);
  const isWpa  = _isWpaAuth(ssid.beaconType);

  // Channel & Channel Bandwidth DIPINDAH ke panel RADIO khusus (tombol "Channel &
  // Bandwidth" di daftar SSID) karena keduanya properti radio yang dipakai bersama
  // SEMUA SSID sepita — mengaturnya per-SSID menyesatkan. Lihat _radioShowConfig.
  const mcHtml = ssid.maxClients != null
    ? '<div class="ssid-form-group">'
      + '<label class="ssid-form-label"><i class="fas fa-users"></i> Maks Perangkat Terhubung</label>'
      + '<input type="number" class="ssid-form-input" id="scMaxClients" value="' + ssid.maxClients + '" min="1" max="128">'
      + '</div>' : '';

  container.innerHTML =
    '<div class="ssid-cfg-panel">'
    + '<div class="ssid-cfg-hdr">'
    + '<button class="ssid-back-btn" id="btnSsidBack"><i class="fas fa-arrow-left"></i> Kembali</button>'
    + '<span class="ssid-cfg-title"><i class="fas fa-wifi"></i> Konfigurasi SSID ' + ssid.idx + '</span>'
    + '</div>'

    // Read-only info grid
    + '<div class="ssid-info-grid">'
    + '<div class="ssid-info-item"><span class="ssid-info-k">Keamanan</span>'
    + '<span class="ssid-info-v ssid-sec ' + sec.cls + '">' + sec.label + '</span></div>'
    + '<div class="ssid-info-item"><span class="ssid-info-k">Channel</span>'
    + '<span class="ssid-info-v">' + chLbl + '</span></div>'
    + '<div class="ssid-info-item"><span class="ssid-info-k">Perangkat</span>'
    + '<span class="ssid-info-v">' + (ssid.associations || 0) + ' terhubung</span></div>'
    + '<div class="ssid-info-item"><span class="ssid-info-k">Status</span>'
    + '<span class="ssid-info-v" style="color:' + (ssid.enabled ? 'var(--green)' : 'var(--text-muted)') + '">'
    + (ssid.enabled ? 'Aktif' : 'Nonaktif') + '</span></div>'
    + '</div>'

    // ── Editable fields ──
    + '<div class="ssid-form-group">'
    + '<label class="ssid-form-label"><i class="fas fa-wifi"></i> Nama SSID (ESSID)</label>'
    + '<input type="text" class="ssid-form-input" id="scSSID" value="' + _esc(ssid.name) + '" maxlength="32" placeholder="Nama WiFi">'
    + '</div>'

    // Authentication Type
    + '<div class="ssid-form-group">'
    + '<label class="ssid-form-label"><i class="fas fa-shield-halved"></i> Tipe Autentikasi</label>'
    + '<select class="ssid-form-select" id="scAuthType">'
    + '<option value="none"'  + (!isWpa ? ' selected' : '') + '>\uD83D\uDD13 None / Open (tanpa password)</option>'
    + '<option value="wpa"'   + ( isWpa ? ' selected' : '') + '>\uD83D\uDD12 WPA/WPA2 Personal (password)</option>'
    + '</select>'
    + '</div>'

    // Password field (shown only when WPA/WPA2)
    + '<div class="ssid-form-group" id="scPassGroup" style="' + (!isWpa ? 'display:none' : '') + '">'
    + '<label class="ssid-form-label"><i class="fas fa-key"></i> Password WiFi</label>'
    + '<div class="ssid-pass-wrap">'
    + '<input type="password" class="ssid-form-input" id="scPass" value="" placeholder="Kosongkan jika tidak diubah">'
    + '<button type="button" class="ssid-eye-btn" id="btnShowPass"><i class="fas fa-eye"></i></button>'
    + '</div>'
    + '<div class="ssid-form-hint">Minimal 8 karakter &bull; Kosongkan untuk tidak mengganti password</div>'
    + '</div>'

    + mcHtml

    + '<div class="ssid-save-status" id="ssidSaveStatus" style="display:none"></div>'
    + '<button class="ssid-save-btn" id="btnSsidSave"><i class="fas fa-floppy-disk"></i> Simpan Perubahan</button>'
    + '</div>';

  // Back button
  var backBtn = document.getElementById('btnSsidBack');
  if (backBtn) backBtn.addEventListener('click', function() { renderSsidTab(d, container); });

  // Auth type → show/hide password field
  var authSel = document.getElementById('scAuthType');
  var passGrp = document.getElementById('scPassGroup');
  if (authSel && passGrp) {
    authSel.addEventListener('change', function() {
      passGrp.style.display = authSel.value === 'wpa' ? '' : 'none';
      if (authSel.value !== 'wpa') {
        var p = document.getElementById('scPass');
        if (p) p.value = '';
      }
    });
  }

  // Show/hide password eye button
  var eyeBtn = document.getElementById('btnShowPass');
  if (eyeBtn) eyeBtn.addEventListener('click', function() {
    var passInp = document.getElementById('scPass');
    if (!passInp) return;
    var show = passInp.type === 'password';
    passInp.type = show ? 'text' : 'password';
    this.innerHTML = '<i class="fas fa-' + (show ? 'eye-slash' : 'eye') + '"></i>';
  });

  // Save
  var saveBtn2 = document.getElementById('btnSsidSave');
  if (saveBtn2) saveBtn2.addEventListener('click', function() { _ssidHandleSave(d, ssid, container); });
}

// ─── Save SSID config ─────────────────────────────────────────────────────────
function _ssidHandleSave(d, ssid, container) {
  var scSSID       = document.getElementById('scSSID');
  var scAuthType   = document.getElementById('scAuthType');
  var scPass       = document.getElementById('scPass');
  var scMaxClients = document.getElementById('scMaxClients');

  const ssidName = ((scSSID && scSSID.value) || '').trim();
  const authType = scAuthType ? scAuthType.value : (ssid.beaconType ? (_isWpaAuth(ssid.beaconType) ? 'wpa' : 'none') : 'wpa');
  const pass     = (authType === 'wpa' && scPass) ? scPass.value : '';
  const mc       = scMaxClients ? scMaxClients.value : null;

  if (!ssidName) { showToast('Nama SSID tidak boleh kosong', 'error'); return; }
  if (authType === 'wpa' && pass && pass.length < 8) { showToast('Password minimal 8 karakter', 'error'); return; }

  // Determine if auth type changed
  const prevIsWpa  = _isWpaAuth(ssid.beaconType);
  const nowIsWpa   = authType === 'wpa';
  const authChanged = prevIsWpa !== nowIsWpa;

  // Resolve vendor-specific security config (from Settings → Parameter Vendor)
  const _oui        = String(d.id || '').slice(0, 6).toUpperCase();
  const _vendorCfg  = (typeof getVendorSecurityConfig === 'function') ? getVendorSecurityConfig(d.model, _oui, d.mfr) : null;
  const _pwdPath    = (_vendorCfg && _vendorCfg.passwordPath) || 'KeyPassphrase';
  const _beaconWpa  = (_vendorCfg && _vendorCfg.beaconWpa)   || 'WPA/WPA2';
  // Tentukan BeaconType open-mode. Jika ada SSID lain yang sudah open di device yang sama,
  // ikuti nilai itu (paling andal). Jika tidak, pakai konfigurasi vendor (default "None").
  // FAKTA FLEET F663NV9: open SELALU "None"; "Basic" tidak pernah dipakai vendor mana pun
  // dan BasicEncryptionModes="Basic" adalah enum invalid → menyebabkan fault.
  const _refOpenSsid = (d.ssids || []).find(function(s) {
    return s.idx !== ssid.idx && !_isWpaAuth(s.beaconType) && s.beaconType;
  });
  const _beaconOpen = _refOpenSsid
    ? _refOpenSsid.beaconType
    : (ssid.hasXCmcc ? ((_vendorCfg && _vendorCfg.beaconOpen) || 'None') : 'None');
  const _encOpen = (_vendorCfg && _vendorCfg.encOpen) || 'None';
  // Resep auth PROFILE-DRIVEN (multi-vendor). Default (flag absen) = perilaku ZTE
  // X_CMCC PERSIS (byte-identik, terverifikasi live) — ONU ZTE TIDAK terpengaruh.
  // Vendor yg data-model-nya TAK mengekspos param mode (mis. C-DATA X_CT-COM:
  // hanya BeaconType) memakai resep MINIMAL agar tak mendorong param tak-ada
  // → 9005/9007. Flag ini HANYA di-set oleh entri profil C-DATA.
  //   wpaMinimal  : true → WPA  = HANYA BeaconType + KeyPassphrase (tanpa 4 param mode)
  //   openMinimal : true → Open = HANYA BeaconType='None' (tanpa BasicAuthenticationMode)
  const _wpaMinimal  = !!(_vendorCfg && _vendorCfg.wpaMinimal);
  const _openMinimal = !!(_vendorCfg && _vendorCfg.openMinimal);

  const base   = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + ssid.idx + '.';
  const params = [];
  if (ssidName !== ssid.name) params.push([base + 'SSID',          ssidName,             'xsd:string']);
  if (authChanged) {
    // FAKTA DATA-MODEL F663NV9 (diverifikasi pada ONU live, 2026-06-23):
    //   BeaconType adalah SATU-SATUNYA "master switch" yang nyata. Pada unit yang
    //   benar-benar open, BeaconType="None" sedangkan ke-6 param mode
    //   (Basic/WPA/IEEE11i Authentication+Encryption) TIDAK lagi dibaca firmware
    //   (type=None). Pada unit WPA, mode tsb berisi PSKAuthentication/TKIPandAES.
    //   Nilai "None" BUKAN anggota enum WPA*/IEEE11i* → menulis "None" ke param itu
    //   ditolak seluruh batch dgn CWMP 9007 (setParameterValuesFault:null).
    if (nowIsWpa && _wpaMinimal) {
      // → WPA MINIMAL (C-DATA X_CT-COM): firmware hanya mengekspos BeaconType;
      //   param mode diisi sendiri oleh firmware. Mendorong WPA*/IEEE11i* yang
      //   tak ada di model = 9005/9007. KeyPassphrase dikirim di bawah.
      params.push([base + 'BeaconType',                _beaconWpa,             'xsd:string']);
    } else if (nowIsWpa) {
      // → WPA: set BeaconType + mode WPA/IEEE11i yang valid (Basic* dibiarkan,
      //   firmware mengisinya sendiri). KeyPassphrase dikirim di bawah.
      params.push([base + 'BeaconType',                _beaconWpa,             'xsd:string']);
      params.push([base + 'WPAAuthenticationMode',     'PSKAuthentication',    'xsd:string']);
      params.push([base + 'IEEE11iAuthenticationMode', 'PSKAuthentication',    'xsd:string']);
      params.push([base + 'WPAEncryptionModes',        'TKIPandAESEncryption', 'xsd:string']);
      params.push([base + 'IEEE11iEncryptionModes',    'TKIPandAESEncryption', 'xsd:string']);
    } else if (_openMinimal) {
      // → Open MINIMAL (C-DATA X_CT-COM): cukup BeaconType='None' (open-system).
      //   Firmware tak punya BasicAuthenticationMode/mode-params → jangan dikirim.
      params.push([base + 'BeaconType',                (_beaconOpen || 'None'), 'xsd:string']);
    } else if (_beaconOpen === 'None' || ssid.hasXCmcc) {
      // → Open (None = open-system, tanpa password). State open yang sah pada
      //   F663NV9 (diverifikasi pada EC6CB5-...D4092 & 688AF0-...BC9E4):
      //     BeaconType="None"  +  BasicAuthenticationMode="OpenSystem".
      //   Param WPA/IEEE11i TIDAK diubah (tetap PSKAuthentication/TKIPandAES) —
      //   menulis "None" ke param itu = enum invalid → CWMP 9007. "OpenSystem"
      //   adalah enum sah di firmware ZTE ini (mirror nilai SSID open existing).
      //   ssid.hasXCmcc menandai ONU keluarga CMCC → open SELALU None; abaikan
      //   konfigurasi "Basic" usang (mis. sisa seed lama di localStorage) yang
      //   akan memicu BasicEncryptionModes="Basic" (enum invalid) → 9007.
      params.push([base + 'BasicAuthenticationMode',   'OpenSystem', 'xsd:string']);
      params.push([base + 'BeaconType',                'None',       'xsd:string']);
    } else {
      // Varian non-standar (open BeaconType selain "None"). BasicEncryptionModes
      // hanya menerima "None"/"WEPEncryption" — nilai lain (mis. "Basic") adalah
      // enum invalid → seluruh batch ditolak CWMP 9007. Sanitasi ke "None".
      var encSafe = (_encOpen === 'None' || _encOpen === 'WEPEncryption') ? _encOpen : 'None';
      params.push([base + 'BeaconType',             _beaconOpen, 'xsd:string']);
      params.push([base + 'BasicEncryptionModes',   encSafe,     'xsd:string']);
    }
  }
  if (nowIsWpa && pass)       params.push([base + _pwdPath,         pass,                 'xsd:string']);
  // Channel & Channel Bandwidth TIDAK lagi disimpan di sini — dipindah ke panel RADIO
  // (_radioHandleSave) yang menerapkannya ke SEMUA SSID sepita sekaligus.
  if (mc)                     params.push([base + 'MaxAssociatedDevices', parseInt(mc, 10), 'xsd:unsignedInt']);

  if (params.length === 0) { showToast('Tidak ada perubahan untuk disimpan', 'error'); return; }

  const btn  = document.getElementById('btnSsidSave');
  const stEl = document.getElementById('ssidSaveStatus');
  if (btn)  { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengirim…'; }
  if (stEl) { stEl.textContent = 'Konfigurasi sedang dikirim ke ONU…'; stEl.className = 'ssid-save-status st-info'; stEl.style.display = 'block'; }

  const prevRaw = d.lastInformRaw || d.lastInform;
  _setParamGuard(d, params)
    .then(function() {
      if (stEl) stEl.textContent = 'Proses konfigurasi berjalan, menunggu ONU menerapkan perubahan…';
      pollForUpdate(prevRaw,
        function(nd) {
          App.currentDevice = nd;
          showToast('Konfigurasi SSID berhasil diterapkan', 'success');
          // Kembali ke list dengan data WLAN terbaru dari ONU
          renderSsidTab(nd, container);
        },
        function() {
          if (btn)  { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan Perubahan'; }
          if (stEl) { stEl.textContent = 'ONU tidak merespons — coba ulangi'; stEl.className = 'ssid-save-status st-err'; }
          showToast('ONU tidak merespons (timeout)', 'error');
        }
      );
    })
    .catch(function(e) {
      if (btn)  { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan Perubahan'; }
      if (stEl) { stEl.textContent = 'Gagal: ' + (e.message || 'Error'); stEl.className = 'ssid-save-status st-err'; }
      showToast('Gagal mengirim konfigurasi', 'error');
    });
}

// ─── Add new SSID (addObject) ─────────────────────────────────────────────────
function _ssidHandleAdd(d, container) {
  // Vendor slot-tetap (C-DATA X_CT-COM): slot WLAN pra-instansiasi & TIDAK bisa addObject.
  // "Tambah" = aktifkan slot NONAKTIF pertama lalu buka konfigurasinya. ZTE (dinamis) tetap
  // pakai alur addObject di bawah — byte-identik.
  var _oui  = String(d.id || '').slice(0, 6).toUpperCase();
  var _vcfg = (typeof getVendorSecurityConfig === 'function') ? getVendorSecurityConfig(d.model, _oui, d.mfr) : null;
  if (_vcfg && _vcfg.ssidFixedSlots) {
    var _slots = d.ssids || [];
    var _off   = _slots.filter(function(s){ return !s.enabled; });
    // Bila MASIH ada slot nonaktif → aktifkan (mis. GM220-S/C-DATA punya slot cadangan).
    // Bila TAK ada slot nonaktif tersisa (mis. ZICG F650 yang cuma 1 slot tapi node
    // WLANConfiguration dinamis/_object=true) → JATUH ke alur "tambah dinamis" (addObject)
    // di bawah, bukan menolak "maks N". Perangkat yang benar-benar tetap (addObject tak
    // didukung) akan gagal anggun di alur itu.
    if (_off.length) {
    var slot = _off[0];
    var band = is5GHz(slot) ? '5GHz' : '2.4GHz';
    showConfirm({
      title:    'Aktifkan slot SSID baru?',
      icon:     'fa-plus',
      yesLabel: 'Aktifkan',
      noLabel:  'Batal',
      message:  'ONU C-DATA memakai slot SSID tetap (bukan tambah dinamis). Slot <b>#' + slot.idx
              + '</b> (' + band + ') akan diaktifkan sebagai SSID baru. Setelah aktif, ubah nama &amp; '
              + 'keamanan lewat tombol <b>Konfigurasi</b>.'
              + '<div style="margin-top:10px;padding:8px 12px;background:var(--surface2);border-radius:8px;font-family:monospace;font-size:12px">'
              + 'WLANConfiguration.' + slot.idx + '  ·  ' + _esc(slot.name || ('SSID ' + slot.idx)) + '</div>',
    }, function() {
      var btnF = document.getElementById('btnAddSsid');
      if (btnF) { btnF.disabled = true; btnF.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengaktifkan…'; }
      var pathF    = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + slot.idx + '.Enable';
      var prevRawF = d.lastInformRaw || d.lastInform;
      ACS.setParam(d.id, [[pathF, true, 'xsd:boolean']])
        .then(function() {
          pollForUpdate(prevRawF,
            function(nd) {
              App.currentDevice = nd;
              renderSsidTab(nd, container);
              showToast('Slot SSID #' + slot.idx + ' diaktifkan — atur nama & keamanan di Konfigurasi', 'success');
              var ns = (nd.ssids || []).find(function(s){ return s.idx === slot.idx; });
              if (ns) _ssidShowConfig(nd, ns, container);
            },
            function() {
              if (btnF) { btnF.disabled = false; btnF.innerHTML = '<i class="fas fa-plus"></i> Tambah SSID'; }
              showToast('ONU tidak merespons', 'error');
            }
          );
        })
        .catch(function() {
          if (btnF) { btnF.disabled = false; btnF.innerHTML = '<i class="fas fa-plus"></i> Tambah SSID'; }
          showToast('Gagal mengaktifkan slot SSID', 'error');
        });
    });
    return;
    }
    // (jatuh ke alur addObject dinamis di bawah — tak ada slot nonaktif tersisa)
  }

  showConfirm({
    title:    'Tambah SSID baru?',
    icon:     'fa-plus',
    yesLabel: 'Tambah',
    noLabel:  'Batal',
    message:  'ONU harus mendukung penambahan SSID secara dinamis.',
  }, function() {
    const btn = document.getElementById('btnAddSsid');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menambahkan…'; }
    const prevRaw = d.lastInformRaw || d.lastInform;
    ACS.addObject(d.id, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration')
      .then(function() {
        pollForUpdate(prevRaw,
          function(nd) {
            App.currentDevice = nd;
            renderSsidTab(nd, container);
            showToast('SSID baru berhasil ditambahkan', 'success');
          },
          function() {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus"></i> Tambah SSID'; }
            showToast('ONU tidak merespons', 'error');
          }
        );
      })
      .catch(function() {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus"></i> Tambah SSID'; }
        showToast('Gagal menambahkan SSID — perangkat mungkin tidak mendukung', 'error');
      });
  });
}

// ─── Toggle group expand / collapse (called from inline onclick) ───
function toggleGroup(id) {
  const body  = document.getElementById('group-' + id);
  const arrow = document.getElementById('arrow-' + id);
  if (body)  body.classList.toggle('cg-open');
  if (arrow) arrow.classList.toggle('cg-open');
}

// ─── Render SSID + LAN groups (left panel) ───
function renderConnectionGroups(d) {
  const listEl  = document.getElementById('ddClientList');
  const countEl = document.getElementById('ddClientCount');
  if (!listEl) return;

  const groups = generateConnectionGroups(d);

  // Total: sum of TotalAssociations across all enabled SSIDs + LAN, fallback aktifDevice
  const total = groups.length > 0
    ? groups.reduce((s, g) => s + (g.count !== undefined ? g.count : g.devices.length), 0)
    : (d.aktifDevice || 0);
  if (countEl) countEl.textContent = total;

  // Empty state — pakai .dd-empty yang sama dengan state "Memuat…" di HTML,
  // bukan inline style, agar keduanya konsisten.
  if (groups.length === 0) {
    listEl.innerHTML = '<div class="dd-empty">'
      + '<i class="fas fa-wifi" style="font-size:20px;opacity:.4"></i>'
      + 'Tidak ada SSID aktif atau perangkat terhubung</div>';
    return;
  }

  const iconMap = { wifi2: 'fa-wifi', wifi5: 'fa-wifi', guest: 'fa-wifi', lan: 'fa-ethernet' };
  const icoBg   = { wifi2: 'cgi-wifi2', wifi5: 'cgi-wifi5', guest: 'cgi-guest', lan: 'cgi-lan' };

  listEl.innerHTML = '<div class="conn-groups">' + groups.map(g => {
    const displayCount = g.count !== undefined ? g.count : g.devices.length;
    const has          = displayCount > 0;
    const hasList      = g.devices.length > 0;
    const icBg = icoBg[g.type] + (has && g.type === 'lan' ? ' cgi-lan-active' : '');

    const devRows = g.devices.map(c => {
      // Popup hover utk SEMUA klien nirkabel (lintas vendor). Isinya menyesuaikan: kaya bila
      // ada telemetri radio, info dasar (SSID/band/MAC/IP/sumber alamat) bila tidak.
      const dt = c.detail;
      // Popup DIAM: dijangkarkan ke baris ini (tanpa onmousemove — tak mengejar kursor).
      const tip = dt
        ? ' data-tip="1" onmouseenter="_hostTipShow(this,event)"'
          + ' onmouseleave="_hostTipHide()"'
          + ' data-host="' + _esc(dt.name || '') + '" data-ip="' + _esc(dt.ip || '') + '"'
          + ' data-mac="' + _esc(dt.mac || '') + '" data-band="' + _esc(dt.band || '') + '"'
          + ' data-ssid="' + _esc(dt.ssid || '') + '"'
          + ' data-rate="' + _esc(dt.negotiationRate || '') + '" data-src="' + _esc(dt.addressSource || '') + '"'
          // Telemetri radio dikirim sbg JSON (di-escape) — hanya bila firmware melaporkannya.
          + (dt.radio ? ' data-radio="' + _esc(JSON.stringify(dt.radio)) + '"' : '')
        : '';
      // Lencana sinyal ringkas di baris (tanpa perlu hover) — hanya bila RSSI dilaporkan.
      const _q  = (dt && dt.radio) ? _rssiQual(dt.radio.rssi) : null;
      const sig = _q
        ? `<span class="cg-sig ${_q.cls}" title="${_q.label}"><i class="fas fa-signal"></i> ${dt.radio.rssi} dBm</span>`
        : '';
      return `
      <div class="cg-device${dt ? ' cg-device-tip' : ''}"${tip}>
        <div class="cg-device-icon"><i class="fas ${c.icon}"></i></div>
        <div class="cg-device-info">
          <div class="cg-device-name">${c.name}</div>
          <div class="cg-device-meta">${c.ip} &middot; ${c.mac}</div>
        </div>
        ${sig}
        ${dt ? '<i class="fas fa-circle-info cg-tip-hint"></i>' : ''}
        ${c.hostIdx ? `<button type="button" class="cg-detail-btn"
             data-host-idx="${_esc(c.hostIdx)}" data-host-name="${_esc(c.name || '')}"
             title="Detail lengkap klien ini"
             onclick="event.stopPropagation();_hostDetailBuka(this)"><i class="fas fa-list-ul"></i></button>` : ''}
      </div>`;
    }).join('');

    // Show note if count > 0 but Hosts.Host has no detail for this SSID
    const noDetailNote = has && !hasList
      ? `<div class="cg-note"><i class="fas fa-circle-info"></i> ${displayCount} perangkat terhubung — detail tidak dilaporkan ONU</div>`
      : '';

    return `
      <div class="conn-group">
        <div class="cg-header${has ? '' : ' cg-empty'}" ${has ? `onclick="toggleGroup('${g.id}')"` : ''}>
          <div class="cg-left">
            <div class="cg-icon ${icBg}"><i class="fas ${iconMap[g.type]}"></i></div>
            <div class="cg-info">
              <div class="cg-name">${g.name}</div>
              <div class="cg-meta">${g.label} &middot; ${g.meta}</div>
            </div>
          </div>
          <div class="cg-right">
            <span class="cg-count ${has ? 'cg-count-active' : ''}">${displayCount}</span>
            ${has ? `<i class="fas fa-chevron-down cg-arrow cg-open" id="arrow-${g.id}"></i>` : ''}
          </div>
        </div>
        ${has ? `<div class="cg-body cg-open" id="group-${g.id}">${devRows}${noDetailNote}</div>` : ''}
      </div>`;
  }).join('') + '</div>';
}

// ─── Render dynamic end of topology (1 branch or fork) ───
function renderTopoEnd(d) {
  const el = document.getElementById('ddTopoEnd');
  if (!el) return;

  // Angka WiFi/LAN di Topologi HARUS sama dgn daftar "Perangkat Terhubung". Dulu keduanya
  // dihitung dari sumber BERBEDA (Topologi: tabel Hosts; daftar: grup SSID/TotalAssociations)
  // sehingga bisa berbeda tanpa alasan yang terlihat operator. Sekarang Topologi memakai
  // GRUP YANG SAMA sebagai sumber; tabel Hosts hanya dipakai bila grup tak terbentuk
  // (mis. firmware tanpa data SSID) — dan sentinel -1 (tak ada data Hosts) tetap dihormati.
  const _groups  = generateConnectionGroups(d);
  const _cnt     = g => (g.count !== undefined ? g.count : g.devices.length);
  const _hasData = d.lanClients >= 0 || d.wlanClients >= 0;
  const lan  = _groups.length && _hasData
    ? _groups.filter(g => g.id === 'lan').reduce((s, g) => s + _cnt(g), 0)
    : d.lanClients;     // -1 = no Hosts data, ≥0 = count
  const wlan = _groups.length && _hasData
    ? _groups.filter(g => g.id !== 'lan').reduce((s, g) => s + _cnt(g), 0)
    : d.wlanClients;    // -1 = no Hosts data, ≥0 = count
  const total = d.aktifDevice || 0;
  const hasWlanConfig = d.ssid && d.ssid !== '—';

  // Determine what to show
  const hostsAvailable = lan >= 0 && wlan >= 0;
  const showBothBranches = hostsAvailable
    ? (lan > 0 && wlan > 0)
    : false; // no Hosts data → single branch

  // Label helpers
  const nodeHtml = (iconCls, colorCls, label, count) => `
    <div class="dtc-node">
      <div class="dtc-icon ${colorCls}"><i class="fas ${iconCls}"></i></div>
      <span class="dtc-lbl">${label}</span>
      <span class="dtc-sub">${count >= 0 ? count + ' perangkat' : count}</span>
    </div>`;

  if (showBothBranches) {
    // ─ FORK: WiFi + LAN branches
    el.innerHTML = `
      <div class="dtc-fork-wrap">
        <div class="dtc-fork-branch dtc-fork-first">
          <div class="dtc-fork-seg"><div class="dtc-dot"></div></div>
          ${nodeHtml('fa-wifi', 'dtc-wlan', 'WiFi', wlan)}
        </div>
        <div class="dtc-fork-branch dtc-fork-last">
          <div class="dtc-fork-seg"><div class="dtc-dot" style="animation-delay:.6s"></div></div>
          ${nodeHtml('fa-network-wired', 'dtc-lan', 'LAN', lan)}
        </div>
      </div>`;
  } else {
    // ─ SINGLE branch
    let iconCls, colorCls, label, count;

    if (hostsAvailable && lan === 0 && wlan > 0) {
      // Only WiFi
      iconCls = 'fa-wifi'; colorCls = 'dtc-wlan'; label = 'WiFi'; count = wlan;
    } else if (hostsAvailable && wlan === 0 && lan > 0) {
      // Only LAN
      iconCls = 'fa-network-wired'; colorCls = 'dtc-lan'; label = 'LAN'; count = lan;
    } else if (hostsAvailable && lan === 0 && wlan === 0) {
      // Hosts table available but 0 active on both
      const useWlan = hasWlanConfig;
      iconCls = useWlan ? 'fa-wifi' : 'fa-network-wired';
      colorCls = useWlan ? 'dtc-wlan' : 'dtc-lan';
      label = useWlan ? 'WiFi' : 'LAN';
      count = `${total} perangkat`;
    } else {
      // No Hosts data → fallback: WLAN if SSID configured, else LAN
      const useWlan = hasWlanConfig;
      iconCls = useWlan ? 'fa-wifi' : 'fa-network-wired';
      colorCls = useWlan ? 'dtc-wlan' : 'dtc-lan';
      label = useWlan ? 'WiFi' : 'LAN';
      count = `${total} perangkat`;
    }

    el.innerHTML = nodeHtml(iconCls, colorCls, label, count);
  }
}

// ─── Render GPON Stats (top-right card) ───
function renderGpon(d) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  // ─ Topology card fields (all real data)
  set('ddTopoVlan',  d.vlan  || '—');
  set('ddTopoOdp',   d.odp && d.odp !== '—' ? d.odp : '—');
  set('ddTopoModel', d.model || '—');

  const statusDot = document.getElementById('ddTopoStatusDot');
  const statusTxt = document.getElementById('ddTopoStatus');
  if (statusDot) statusDot.style.color = d.online ? 'var(--green)' : 'var(--red)';
  if (statusTxt) statusTxt.textContent  = d.online ? 'Online'       : 'Offline';

  // ─ RX pada ruas ODP→ONU: menjadikan diagram informatif, bukan dekorasi.
  //   Ambang warnanya sama dengan tabel & dashboard (rxSvClass) agar konsisten.
  const rxLbl = document.getElementById('ddTopoRx');
  if (rxLbl) {
    const has = d.rx && d.rx !== '—';
    rxLbl.textContent = has ? d.rx + ' dBm' : '';
    rxLbl.className   = 'dtc-line-lbl' + (has ? ' ' + rxSvClass(d.rx) : '');
    rxLbl.hidden      = !has;
  }

  // ─ Gambar ONU per-model. Sumbernya satu: ontPhotoUrl() di devices.js — sama
  //   dengan modal "Informasi ONT", cocok tanpa peduli huruf besar-kecil.
  //   TIDAK ADA default foto vendor: model tanpa foto tampil ikon router.
  //   (Dulu default-nya F663NV9.PNG sehingga 544 ONU — HWTC ZL-2113X, CIOT,
  //   Huawei, dst — tampil sebagai ZTE. Itu menyesatkan operator.)
  //   Target khusus id=ddTopoOnuImg — JANGAN querySelector('.dtc-onu-img')
  //   karena gambar ODP juga pakai kelas itu & jadi elemen pertama.
  const onuImg = document.getElementById('ddTopoOnuImg');
  const onuFb  = document.getElementById('ddTopoOnuFb');
  if (onuImg && onuFb) {
    const url = typeof ontPhotoUrl === 'function' ? ontPhotoUrl(d.model, d.mfr) : null;
    const showFb = () => { onuImg.hidden = true;  onuFb.hidden = false; };
    const showImg = () => { onuImg.hidden = false; onuFb.hidden = true;  };
    showFb();
    if (url) {
      onuImg.onload  = showImg;
      onuImg.onerror = showFb;
      onuImg.src = url;
    }
  }

  // ─ Offline lines: ODP→ONU and ONU→end turn red with X + OFFLINE label
  const lineOdpOnu = document.getElementById('dtcLineOdpOnu');
  const lineOnuEnd = document.getElementById('dtcLineOnuEnd');
  if (lineOdpOnu) lineOdpOnu.classList.toggle('dtc-line--offline', !d.online);
  if (lineOnuEnd) lineOnuEnd.classList.toggle('dtc-line--offline', !d.online);

  // ─ Dynamic end (LAN / WiFi / fork)
  renderTopoEnd(d);
}

// Foto ONU bersumber dari ONT_PHOTOS/ontPhotoUrl() di devices.js (dimuat lebih
// dulu; lihat urutan <script> di index.html). Menambah foto model baru cukup di
// satu tempat itu — halaman ini ikut otomatis.

// ─── Render Hero Section (identity + live metric pills) ───
function renderHero(d) {

  // ONU image in hero icon (fallback: existing fa-router icon)
  const iconEl = document.querySelector('#page-device-detail .dd-hero-icon');
  const imgSrc = typeof ontPhotoUrl === 'function' ? ontPhotoUrl(d.model, d.mfr) : null;

  // Ikon halaman di header ikut identitas ONU ini — sumbernya sama dengan hero
  // (ontPhotoUrl), jadi keduanya tak mungkin menampilkan model berbeda.
  // imgSrc null → header memakai ikon fa-router dari PAGE_META['device-detail'].
  if (typeof setPageIconPhoto === 'function') setPageIconPhoto(imgSrc);

  if (iconEl) {
    if (imgSrc) {
      iconEl.innerHTML = `<img src="${imgSrc}" alt="${d.model}" style="width:44px;height:44px;object-fit:contain;border-radius:8px;">`;
      iconEl.style.background = 'transparent';
      iconEl.style.border     = 'none';
    } else {
      // Model tanpa gambar → kembalikan ikon router default (hindari gambar model sebelumnya tersisa).
      iconEl.innerHTML = '<i class="fas fa-router"></i>';
      iconEl.style.background = '';
      iconEl.style.border     = '';
    }
  }

  // Subtitle: Model · Manufacturer · Serial
  const subEl = document.getElementById('ddHeroSub');
  if (subEl) subEl.textContent = `${d.model}  ·  ${d.mfr}  ·  ${d.serial}`;

  // Status badge
  const statusEl = document.getElementById('ddDeviceStatus');
  if (statusEl) {
    statusEl.className   = `dd-status-badge ${d.online ? 'online' : 'offline'}`;
    statusEl.textContent = d.online ? '● Online' : '● Offline';
  }

  // Tags
  const tagsEl = document.getElementById('ddDeviceTags');
  if (tagsEl) {
    const parts = d.tags.replace(/-/g, ' ').split('@').map(s => s.trim()).filter(Boolean);
    tagsEl.innerHTML = parts.map(t => `<span class="dd-tag">${t}</span>`).join('');
  }

  // Metric pills (real data only)
  const rx    = parseFloat(d.rx);
  const temp  = d.temp > 0 ? d.temp : null;   // real temperature from VP
  const _rt   = ACS.rxThr();
  const rxCls = rx >= _rt.good ? 'dd-hm-green' : rx >= _rt.fair ? 'dd-hm-amber' : 'dd-hm-red';
  const tCls  = temp > 65 ? 'dd-hm-red'   : temp > 52  ? 'dd-hm-amber' : 'dd-hm-blue';

  function pill(icon, val, lbl, cls) {
    return `<div class="dd-hmetric ${cls}">
      <i class="fas ${icon} dd-hm-icon"></i>
      <span class="dd-hm-val">${val}</span>
      <span class="dd-hm-lbl">${lbl}</span>
    </div>`;
  }

  function pillLink(icon, val, lbl, cls, href) {
    const valHtml = href
      ? `<a href="${href}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline dotted;cursor:pointer;">${val}</a>`
      : val;
    return `<div class="dd-hmetric ${cls}">
      <i class="fas ${icon} dd-hm-icon"></i>
      <span class="dd-hm-val">${valHtml}</span>
      <span class="dd-hm-lbl">${lbl}</span>
    </div>`;
  }

  // TR-069 IP — strip port if present (e.g. "10.18.4.75:7547" → "10.18.4.75")
  const tr069ip = (d.iptr069 && d.iptr069 !== '—') ? d.iptr069.split(':')[0] : null;

  const metricsEl = document.getElementById('ddHeroMetrics');
  if (metricsEl) {
    metricsEl.innerHTML =
      pill('fa-arrow-down',       `${d.rx} dBm`, 'RX Power',   rxCls) +
      (temp != null ? pill('fa-temperature-half', `${temp}°C`, 'Suhu ONU', tCls) : '') +
      (d.online && d.ip && d.ip !== '—' ? pillLink('fa-network-wired', d.ip, 'IP PPPoE', 'dd-hm-blue', `http://${d.ip}/`) : '') +
      (tr069ip ? pillLink('fa-server', tr069ip, 'IP TR-069', 'dd-hm-slate', `http://${tr069ip}/`) : '') +
      pill('fa-clock', d.lastInform, 'Last Inform', 'dd-hm-slate') +
      (d.uptime ? pill('fa-stopwatch', d.uptime, 'Uptime', 'dd-hm-slate') : '');
  }
}

// ─── Render Device Info — REAL data only, no fakes ───
function renderDeviceInfo(d) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const deviceId = [d.id.split('-')[0], d.model, d.serial].filter(Boolean).join('-');
  set('ddDeviceTitle', deviceId);

  const gridEl = document.getElementById('ddInfoGrid');
  if (!gridEl) return;

  /* Umur data per baris.

     Ini pengurang beban ONU yang paling murah yang kita punya. Teknisi menekan
     Refresh terutama karena RAGU apakah angka di layar masih benar — dan tiap
     klik ragu adalah satu connection-request, satu penyusuran pohon, satu ONU
     yang bekerja tanpa perlu. Begitu layar sendiri berkata "3 menit lalu",
     keraguan itu hilang tanpa satu pun perintah dikirim.

     Diambil dari sumber yang BENAR-BENAR dipakai (kandidat keberapa pun yang
     menang di rantai pemetaan), bukan dari kandidat pertama. */
  function u(kunci) {
    try {
      if (typeof VPMap === 'undefined' || !d.umur || !d.umur[kunci]) return '';
      const a = VPMap.umur(d.umur[kunci]);
      if (!a) return '';
      return ` <span class="di-umur di-umur-${a.tingkat}"`
           + ` title="Data terakhir diperbarui ${a.teks}${a.perluSegar
               ? ' — tekan Refresh bila perlu angka terkini' : ''}">${a.teks}</span>`;
    } catch (_) { return ''; }
  }

  // r(...) argumen ke-5 (opsional) = teks yang bisa disalin, memunculkan tombol
  // salin di kanan baris; ke-6 = kunci field untuk keterangan umur data.
  function r(icon, icCls, key, val, copy, umurKunci) {
    const btn = copy
      ? `<button class="di-copy" type="button" data-copy="${escHtml(copy)}" data-label="${escHtml(key)}"
                 title="Salin ${escHtml(key)}"><i class="fas fa-copy"></i></button>`
      : '';
    return `<div class="di-row">
      <div class="di-icon ${icCls}"><i class="fas ${icon}"></i></div>
      <span class="di-key">${key}${umurKunci ? u(umurKunci) : ''}</span>
      <span class="di-val">${val}${btn}</span>
    </div>`;
  }
  // Judul kelompok — memecah 14 baris datar jadi blok yang bisa dipindai mata.
  function g(label) { return `<div class="di-group">${label}</div>`; }

  // ─ Signal metrics
  const rx      = parseFloat(d.rx);
  const _rt     = ACS.rxThr();
  const rxIcCls = rx >= _rt.good ? 'di-ic-green' : rx >= _rt.fair ? 'di-ic-amber' : 'di-ic-red';
  const rxTag   = rxSvClass(d.rx);

  // ─ PON mode color
  const ponColor = d.ponMode === 'GPON' ? 'var(--primary)'
                 : d.ponMode === 'EPON' ? 'var(--green)' : 'var(--amber)';

  // ─ MAC: prefer PON MAC, fallback PPPoE MAC
  const mac = (d.ponMac && d.ponMac !== '—')
    ? d.ponMac
    : (d.pppoeMac && d.pppoeMac !== '—' ? d.pppoeMac : '—');

  // ─ VLAN: utamakan VP getVlan; bila kosong (mis. HWTC-EPON yang VLAN-nya hanya
  //   terbaca dari nama koneksi) → ambil dari koneksi WAN utama (prioritas INTERNET).
  let vlanDisp = (d.vlan && d.vlan !== '—') ? String(d.vlan) : '';
  if (!vlanDisp && Array.isArray(d.wanConnections)) {
    const vc   = d.wanConnections.filter(c => c && c.vlanId);
    const pick = vc.find(c => /INTERNET/i.test(c.serviceList || '')) || vc[0];
    if (pick) vlanDisp = String(pick.vlanId);
  }
  if (!vlanDisp) vlanDisp = '—';

  // ─ Uptime: utamakan uptime koneksi PPPoE dari wanConnections (sumber paling tepat &
  //   lintas-WCD — VP getpppuptime bisa salah baca WCD pada GPON di mana koneksi PPP ada
  //   di WCD.3, bukan WCD.1). Fallback: VP PPP uptime, lalu uptime PERANGKAT (relabel
  //   jujur "Uptime") agar nilai SELALU terlihat.
  let upLabel = 'PPP Uptime';
  let upVal   = '—';
  const _pppConn = (d.wanConnections || []).filter(c => c && c.type === 'ppp' && c.uptime > 0)[0];
  if (_pppConn) upVal = _fmtUptime(_pppConn.uptime);
  if (upVal === '—') upVal = _fmtUptime(d.pppUptime);
  if (upVal === '—' && d.uptime) { upVal = _fmtUptime(d.uptime); upLabel = 'Uptime'; }

  // Dikelompokkan agar mudah dipindai. Urutan prioritas operator dipertahankan:
  // PPPoE User & VLAN tetap dua baris teratas.
  gridEl.innerHTML = [
    g('Layanan'),
    r('fa-user',            'di-ic-purple', 'PPPoE User',
      d.pppoe && d.pppoe !== '—'
        ? `<code>${d.pppoe.split('@')[0]}</code>` : '—',
      d.pppoe && d.pppoe !== '—' ? d.pppoe : '', 'pppoeUser'),
    r('fa-tag',             'di-ic-amber',  'VLAN',          vlanDisp, '', 'vlan'),
    r('fa-circle-dot',      d.online ? 'di-ic-green' : 'di-ic-red',
      'Status',        d.online
        ? '<span style="color:var(--green);font-weight:700">● Online</span>'
        : '<span style="color:var(--red)">● Offline</span>'),
    r('fa-hourglass-half',  'di-ic-blue',   upLabel,         upVal, '',
      upLabel === 'Uptime' ? 'uptime' : 'pppUptime'),

    g('Sinyal & Mode'),
    r('fa-arrow-down',      rxIcCls,        'RX Power',
      `<span class="${rxTag}">${d.rx !== '—' ? d.rx + ' dBm' : '—'}</span>`, '', 'rxPower'),
    r('fa-arrow-up',        d.tx ? 'di-ic-green' : 'di-ic-slate', 'TX Power',
      d.tx ? `<span style="color:var(--green);font-weight:600">${d.tx}</span>` : '—', '', 'txPower'),
    r('fa-broadcast-tower', 'di-ic-purple', 'Mode',
      `<span style="color:${ponColor};font-weight:800">${d.ponMode || '—'}</span>`, '', 'ponMode'),

    g('Perangkat'),
    r('fa-industry',        'di-ic-slate',  'Manufacturer',  d.mfr         || '—'),
    r('fa-microchip',       'di-ic-slate',  'Model',         d.model       || '—'),
    r('fa-ethernet',        'di-ic-purple', 'MAC Address',   mac !== '—' ? `<code>${mac}</code>` : '—',
      mac !== '—' ? mac : ''),
    r('fa-id-card',         'di-ic-slate',  'OUI',           d.oui         || '—'),

    g('Sistem'),
    r('fa-wrench',          'di-ic-amber',  'HW Version',    d.hwVer       || '—'),
    r('fa-code-branch',     'di-ic-amber',  'SW Version',    d.swVer       || '—'),
    r('fa-calendar-days',   'di-ic-purple', 'ACS Register',  d.registered  || '—'),
  ].join('');

  // Tombol salin — DOM dibangun ulang tiap render, jadi tak ada listener ganda.
  gridEl.querySelectorAll('.di-copy').forEach(btn => {
    btn.addEventListener('click', () => copyWithFeedback(btn.dataset.copy, btn, btn.dataset.label));
  });
}

// ─── Device Detail Entry Point ───
function initDeviceDetail() {
  const d = App.currentDevice;
  if (!d) { navigateTo('devices'); return; }

  // Clear any stray fault-poll timer from a previous render/visit
  if (_settFaultIv) { clearInterval(_settFaultIv); _settFaultIv = null; }

  // Always reset Refresh button to default state on every init
  const _btnR = document.getElementById('btnRefreshDevice');
  if (_btnR) { _btnR.disabled = false; _btnR.innerHTML = '<i class="fas fa-rotate"></i> Refresh'; }
  try { renderHero(d); }             catch (e) { console.error('renderHero:', e); }
  try { renderConnectionGroups(d); } catch (e) { console.error('renderConnectionGroups:', e); }
  try { renderGpon(d); }             catch (e) { console.error('renderGpon:', e); }
  try { renderDeviceInfo(d); }       catch (e) { console.error('renderDeviceInfo:', e); }
  try { renderConfigPanel(d); }      catch (e) { console.error('renderConfigPanel:', e); }

  /* ─ Remote: buka halaman admin ONU di tab baru ─
     Panel yang menghubungi 10.17.x.x, bukan browser — lihat onu_proxy.py.
     Karena itu ini juga bekerja dari luar jaringan, tanpa VPN.

     window.open dipanggil LANGSUNG di dalam handler klik, tanpa await apa pun
     di depannya. Ini bukan gaya penulisan: browser hanya mengizinkan membuka
     tab selagi masih berada di dalam gestur pengguna. Menyisipkan
     `await cekKeterjangkauan()` lebih dulu memutus rantai itu dan tabnya
     DIBLOKIR sebagai popup. Jadi keterjangkauan tidak diperiksa di sini —
     server yang menjelaskannya lewat halaman galat bila ONU tak menjawab.

     Catatan lapangan: keterjangkauan ditentukan JARINGAN, bukan per-ONU —
     seluruh 10.17.x.x terbuka (1215 ONU), seluruh 10.18.x.x terfilter di
     port 80 (525 ONU) walau perangkatnya sehat. */
  // WAJIB .onclick (menimpa), BUKAN addEventListener (menambah): initDeviceDetail()
  // dipanggil ULANG tiap Refresh selesai (lihat setTimeout di bawah), sedangkan
  // #btnRemoteDevice ada di HTML statis & TIDAK dibangun ulang. addEventListener
  // menumpuk satu listener tiap init → window.open terpanggil ganda → 2 tab.
  // .onclick hanya menyimpan satu handler, jadi berapa kali pun init dijalankan
  // tetap satu tab. (Refresh & Reboot memakai pola sama persis di bawah.)
  const btnRemote = document.getElementById('btnRemoteDevice');
  if (btnRemote) btnRemote.onclick = () => {
    if (!d || !d.id) return;
    window.open('/onu/' + encodeURIComponent(d.id) + '/', '_blank', 'noopener,noreferrer');
  };

  // ─ Refresh button: two-phase (send task → poll for ONU callback)
  const btnRefresh = document.getElementById('btnRefreshDevice');
  const refreshStatus = document.getElementById('refreshStatus');
  const setRefreshStatus = (msg, color) => {
    if (!refreshStatus) return;
    // Pakai atribut [hidden] (dijaga penjaga global di base.css) — bukan
    // style.display, agar CSS-lah yang menentukan tampilannya saat terlihat.
    if (msg) {
      refreshStatus.textContent = msg;
      refreshStatus.style.color = color || 'var(--text-muted)';
      refreshStatus.hidden = false;
    } else {
      refreshStatus.hidden = true;
    }
  };

  if (btnRefresh) {
    btnRefresh.onclick = async () => {
      btnRefresh.disabled = true;
      btnRefresh.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengirim CR...';
      setRefreshStatus('', '');

      const prevInformRaw = d.lastInformRaw || d.lastInform;

      // Phase 1: SUMMON — connection_request + refreshObject pada SELURUH pohon
      // data-model (persis tombol "Summon" GenieACS). Menyegarkan SEMUA parameter:
      // Hosts (perangkat terhubung), semua slot WLAN (termasuk 5-10 tempat SSID 2,4G
      // C-DATA), LAN, DeviceInfo, dan semua WANConnectionDevice — bukan hanya subset
      // WAN/WLAN 1-4 seperti ACS.refresh lama (itu sebabnya data dulu kurang lengkap
      // dibanding summon). Vendor-agnostik (pakai root TR-098/TR-181) & read-only
      // (GetParameterNames/Values rekursif) → tak memicu reboot/commit.
      try {
        const hasilSummon = await ACS.summon(d.id, d.root, d.model);
        // Mode "ikut": ONU ini sudah disegarkan orang lain saat ini juga.
        // Tidak ada perintah tambahan yang dikirim — kita hanya ikut menunggu
        // hasil yang sama. Inilah yang mencegah ONU mengerjakan pekerjaan
        // kembar ketika dua teknisi menekan Refresh berbarengan.
        if (hasilSummon && hasilSummon.diikutkan) {
          setRefreshStatus('Sedang disegarkan oleh ' + (hasilSummon.pemilik || 'pengguna lain')
                           + ' — Anda akan menerima hasilnya.', 'var(--text-muted)');
          showToast('ONU ini sedang disegarkan oleh ' + (hasilSummon.pemilik || 'pengguna lain')
                    + ' — permintaan Anda diikutkan, bukan diulang', 'info');
        } else {
          setRefreshStatus('Menunggu ONU terhubung…', 'var(--text-muted)');
        }
        btnRefresh.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menunggu...';
      } catch (e) {
        // Penolakan kunci/masa istirahat BUKAN kegagalan menghubungi ACS —
        // pesannya sudah menjelaskan sebabnya, jadi tampilkan apa adanya
        // daripada menggantinya dengan tebakan yang salah.
        const pesan = (e && e.pagar) ? e.message : 'Gagal mengirim perintah refresh';
        const warna = (e && e.kode === 'istirahat') ? 'var(--amber)' : '#ef4444';
        showToast(pesan, (e && e.pagar) ? 'info' : 'error');
        setRefreshStatus(pesan, warna);
        btnRefresh.disabled = false;
        btnRefresh.innerHTML = '<i class="fas fa-rotate"></i> Refresh';
        return;
      }

      // Phase 2: tunggu _lastInform berubah.
      //
      // Hitung mundur ditampilkan karena penantiannya memang bisa lama: ONU seperti
      // HWTC ZL-2113X baru membalas connection-request ~60 dtk kemudian (terukur
      // 2026-08-02, lihat catatan di api.js). Tanpa penanda yang bergerak, layar
      // tampak menggantung, teknisi menekan Refresh berulang kali, dan tiap klik
      // menambah task baru di antrean ACS — satu ONU pernah menumpuk 18 task karena
      // ini. Batas tunggu memakai ACS.SUMMON_WAIT_MS (120 dtk), bukan 30 dtk yang
      // dulu SELALU habis lebih dulu untuk model ini.
      const batasTunggu = (ACS && ACS.SUMMON_WAIT_MS) || 120000;
      const mulai = Date.now();
      const tampilkanSisa = function() {
        const sisa = Math.max(0, Math.ceil((batasTunggu - (Date.now() - mulai)) / 1000));
        setRefreshStatus('Menunggu ONU membalas… ' + sisa + ' dtk', 'var(--text-muted)');
      };
      // Tampilkan seketika — jangan biarkan layar kosong selama detik pertama.
      tampilkanSisa();
      let ivHitung = setInterval(tampilkanSisa, 1000);
      const hentikanHitung = function() {
        if (ivHitung) { clearInterval(ivHitung); ivHitung = null; }
      };

      pollForUpdate(prevInformRaw,
        function(nd) {
          hentikanHitung();
          App.currentDevice = nd;
          showToast('Selesai diperbarui', 'success');
          setRefreshStatus('Selesai diperbarui ✔', 'var(--green)');
          setTimeout(() => initDeviceDetail(), 600);
        },
        function() {
          hentikanHitung();
          // Task refreshObject SUDAH ter-antri di ACS (seperti Summon GenieACS) — ONU
          // belum inform ulang dalam tenggat. BUKAN kegagalan perintah; data akan
          // tersegarkan saat ONU inform berikutnya. Tampilkan data terakhir yang ada.
          // Sengaja TIDAK mengajak "coba lagi sebentar": klik ulang hanya menumpuk
          // task, tidak mempercepat ONU yang memang sedang tak menjawab.
          showToast('Perintah terkirim — ONU belum merespons, data akan tersegarkan saat inform berikutnya', 'info');
          setRefreshStatus('Perintah sudah tersimpan di ACS. ONU belum membalas — data akan tersegarkan sendiri saat inform berikutnya.', 'var(--amber)');
          btnRefresh.disabled = false;
          btnRefresh.innerHTML = '<i class="fas fa-rotate"></i> Refresh';
        },
        batasTunggu);
    };
  }

  // ─ Reboot button: send reboot task via GenieACS
  const btnReboot = document.getElementById('btnRebootDevice');
  if (btnReboot) {
    btnReboot.onclick = () => {
      showConfirm({
        title:    'Reboot ONU ini?',
        icon:     'fa-power-off',
        danger:   true,
        yesLabel: 'Reboot',
        noLabel:  'Batal',
        message:  'Koneksi internet akan terputus sementara.',
      }, async () => {
        btnReboot.disabled = true;
        btnReboot.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rebooting...';
        try {
          await ACS.reboot(d.id);
          showToast('Perintah reboot berhasil dikirim ke ONU', 'success');
        } catch (e) {
          showToast('Gagal reboot: ' + (e.message || e), 'error');
        } finally {
          setTimeout(() => {
            btnReboot.disabled = false;
            btnReboot.innerHTML = '<i class="fas fa-power-off"></i> Reboot';
          }, 6000);
        }
      });
    };
  }
}

// Register with navigation
PAGE_INIT['device-detail'] = initDeviceDetail;

// Stop the fault-poll timer when leaving the device-detail page
PAGE_TEARDOWN['device-detail'] = function() {
  if (_settFaultIv) { clearInterval(_settFaultIv); _settFaultIv = null; }
};
