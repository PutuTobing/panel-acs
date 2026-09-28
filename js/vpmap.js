/* ═══════════════════════════════════════════════════════════════════
   SKY ACS — Pemetaan VirtualParameter & umur data

   MASALAHNYA. Tiap pemasangan GenieACS menamai VirtualParameter-nya sendiri,
   dan cakupannya tidak seragam antar firmware. Diukur pada armada ini
   (2026-08-02, hanya ONU aktif):

       model          unit   IPTR069   PonMac   getpppuptime   getVlan
       F663NV9        1112      37%       0%          99%        100%
       ZL-2113X        152      13%     100%          15%         85%
       F663NV3a         98       9%       0%         100%        100%
       Trikom F609       5       0%       0%         100%        100%
       F679L            10     100%     100%         100%          0%

   Artinya memetakan satu field ke SATU nama VP tidak pernah cukup. Berkas ini
   mengubahnya menjadi RANTAI KANDIDAT: dicoba berurutan, yang pertama terisi
   dipakai.

   YANG PENTING — RANTAI INI TIDAK BERBIAYA BAGI ONU. Kandidat boleh berupa
   nama VP maupun jalur TR-069 mentah, dan keduanya dibaca dari dokumen
   perangkat yang SUDAH ada di GenieACS. Tidak ada satu pun perintah baru yang
   dikirim ke ONU. Lubang IPTR069 pada ~1.400 ONU bisa ditutup tanpa menyentuh
   GenieACS sama sekali.

   SATU MEKANISME, DUA KEGUNAAN. resolve() tidak hanya mengembalikan nilai,
   tetapi juga KANDIDAT KEBERAPA yang dipakai dan KAPAN nilai itu terakhir
   diperbarui. Yang kedua itulah bahan "umur data" — keterangan "3 menit lalu"
   di sebelah tiap field. Tanpa itu teknisi menekan Refresh karena ragu, dan
   tiap klik ragu adalah satu ONU yang disuruh bekerja tanpa perlu.

   ATURAN BAWAAN. Kandidat PERTAMA tiap field selalu sama persis dengan yang
   dibaca panel hari ini. Kandidat berikutnya hanya terpakai bila yang pertama
   kosong — jadi menambah kandidat tidak pernah mengubah nilai yang sudah
   tampil, hanya mengisi yang sebelumnya '—'.
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ─── Bawaan ────────────────────────────────────────────────────
  // `sumber` dicoba berurutan. Bentuknya:
  //   'VirtualParameters.X'                     → jalur langsung
  //   'InternetGatewayDevice.A.*.B'             → '*' = telusuri semua instance
  //   '@namaTurunan'                            → dihitung panel (lihat TURUNAN)
  const BAWAAN = {
    version: 1,
    fields: {
      rxPower: {
        label: 'RX Power', transform: 'teks',
        sumber: [
          'VirtualParameters.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
        ],
      },
      txPower: {
        label: 'TX Power', transform: 'teks',
        sumber: [
          'VirtualParameters.getTXPower',
          'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.TXPower',
          'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.TXPower',
          'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.TXPower',
        ],
      },
      suhu: {
        label: 'Suhu', transform: 'teks',
        sumber: ['VirtualParameters.gettemp'],
      },
      ponMode: {
        label: 'Mode PON', transform: 'teks',
        sumber: [
          'VirtualParameters.getponmode',
          'InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.WANAccessType',
        ],
      },
      // Lubang terbesar yang terukur: 9–40% pada sebagian besar model. Dua
      // kandidat terakhir menutupnya TANPA menyentuh GenieACS — keduanya sudah
      // ada di dokumen perangkat.
      ipTr069: {
        label: 'IP TR-069', transform: 'teks',
        sumber: [
          'VirtualParameters.IPTR069',
          'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ExternalIPAddress',
          '@hostConnectionRequest',
        ],
      },
      pppoeUser: {
        label: 'Pengguna PPPoE', transform: 'teks',
        sumber: [
          'VirtualParameters.pppoeUsername',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
          'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username',
          'InternetGatewayDevice.X_CT-COM_UserInfo.UserName',
          'InternetGatewayDevice.X_CU_UserInfo.UserName',
        ],
      },
      pppoePass: {
        label: 'Sandi PPPoE', transform: 'teks',
        sumber: ['VirtualParameters.pppoePassword'],
      },
      ipPppoe: {
        label: 'IP PPPoE', transform: 'teks',
        sumber: [
          'VirtualParameters.pppoeIP',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
          'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress',
        ],
      },
      vlan: {
        label: 'VLAN', transform: 'teks',
        sumber: [
          'VirtualParameters.getVlan',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_CT-COM_WANEponLinkConfig.VLANIDMark',
          'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.X_ZTE-COM_VLANID',
        ],
      },
      wlanPass: {
        label: 'Sandi WiFi', transform: 'teks',
        sumber: [
          'VirtualParameters.WlanPassword',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
        ],
      },
      uptime: {
        label: 'Uptime perangkat', transform: 'teks',
        sumber: [
          'VirtualParameters.getdeviceuptime',
          'InternetGatewayDevice.DeviceInfo.UpTime',
        ],
      },
      pppUptime: {
        label: 'Uptime PPPoE', transform: 'teks',
        sumber: [
          'VirtualParameters.getpppuptime',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Uptime',
        ],
      },
      klienAktif: {
        label: 'Perangkat terhubung', transform: 'angka',
        sumber: [
          'VirtualParameters.activedevices',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
        ],
      },
      ponMac: {
        label: 'MAC PON', transform: 'teks',
        sumber: [
          'VirtualParameters.PonMac',
          'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.MACAddress',
          'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.MACAddress',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
        ],
      },
      pppoeMac: {
        label: 'MAC PPPoE', transform: 'teks',
        sumber: [
          'VirtualParameters.pppoeMac',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.MACAddress',
        ],
      },
      serial: {
        label: 'Serial Number', transform: 'teks',
        // Urutan ini SAMA PERSIS dengan yang dipakai panel sebelum ada
        // pemetaan. Jangan diubah tanpa alasan: salah serial berarti salah
        // perangkat, dan itu kesalahan yang paling mahal di aplikasi ini.
        sumber: [
          '@deviceIdSerial',
          'InternetGatewayDevice.DeviceInfo.SerialNumber',
          'VirtualParameters.getSerialNumber',
          '@idSerial',
        ],
      },
    },
  };

  const TRANSFORMASI = ['teks', 'angka', 'dbm', 'bool', 'mac'];

  let _peta = null;      // pemetaan aktif (null = pakai bawaan)

  function bawaan() { return JSON.parse(JSON.stringify(BAWAAN)); }
  function peta()   { return _peta || BAWAAN; }
  function setPeta(m) {
    _peta = (m && m.fields && Object.keys(m.fields).length) ? m : null;
  }

  // ─── Sumber turunan ────────────────────────────────────────────
  // Dihitung panel dari data yang sudah ada. Tidak berbiaya bagi ONU.
  const TURUNAN = {
    // ConnectionRequestURL selalu terisi (GenieACS memerlukannya untuk bisa
    // memanggil ONU sama sekali), dan host-nya ADALAH alamat manajemen ONU.
    // Inilah yang menutup lubang IPTR069 pada ribuan perangkat.
    hostConnectionRequest: function (raw) {
      const n = jalurNode(raw, ['InternetGatewayDevice', 'ManagementServer',
                                'ConnectionRequestURL'])
             || jalurNode(raw, ['Device', 'ManagementServer', 'ConnectionRequestURL']);
      if (!n) return null;
      const url = String(nilaiNode(n) || '');
      const m = url.match(/^[a-z]+:\/\/([^:/]+)/i);
      if (!m) return null;
      return { nilai: m[1], waktu: waktuNode(n) };
    },
    // Sumber otoritatif serial: DeviceIdStruct dari Inform, selalu ada di tiap
    // query. Sengaja DIPISAH dari @idSerial supaya urutan kandidat serial
    // tetap sama persis dengan yang dipakai panel selama ini — identitas
    // perangkat bukan tempat untuk memperbaiki-baiki urutan.
    deviceIdSerial: function (raw) {
      const did = raw._deviceId || {};
      if (!did._SerialNumber) return null;
      return { nilai: did._SerialNumber, waktu: raw._lastInform || null };
    },
    // Cadangan terakhir: bedah dari _id GenieACS (OUI-ProductClass-Serial),
    // dengan '-' internal yang di-persen-kodekan dikembalikan.
    idSerial: function (raw) {
      const bagian = String(raw._id || '').split('-');
      if (bagian.length < 3) return null;
      return {
        nilai: bagian.slice(2).join('-').replace(/%2D/gi, '-'),
        waktu: raw._lastInform || null,
      };
    },
  };

  // ─── Penelusuran dokumen ───────────────────────────────────────
  function jalurNode(obj, bagian) {
    let cur = obj;
    for (let i = 0; i < bagian.length; i++) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[bagian[i]];
    }
    return (cur == null) ? null : cur;
  }

  function nilaiNode(n) {
    if (n == null) return null;
    if (typeof n === 'object') return ('_value' in n) ? n._value : null;
    return n;
  }

  function waktuNode(n) {
    return (n && typeof n === 'object' && n._timestamp) ? n._timestamp : null;
  }

  function terisi(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
  }

  /* Telusuri jalur yang mengandung '*'. Instance GenieACS adalah kunci angka,
     jadi '*' berarti "coba semua kunci angka, urut naik". Berhenti pada yang
     pertama terisi — itu perilaku yang sama dengan rantai kandidat, hanya di
     dalam satu jalur. */
  function telusuri(obj, bagian) {
    if (!bagian.length) return obj == null ? [] : [obj];
    const [kepala, ...sisa] = bagian;
    if (kepala !== '*') {
      const n = (obj && typeof obj === 'object') ? obj[kepala] : undefined;
      return (n == null) ? [] : telusuri(n, sisa);
    }
    if (!obj || typeof obj !== 'object') return [];
    const kunci = Object.keys(obj)
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const hasil = [];
    for (const k of kunci) hasil.push(...telusuri(obj[k], sisa));
    return hasil;
  }

  // ─── Transformasi ──────────────────────────────────────────────
  function ubah(nilai, jenis) {
    if (nilai === null || nilai === undefined) return nilai;
    switch (jenis) {
      case 'angka': {
        const n = parseFloat(nilai);
        return isNaN(n) ? null : n;
      }
      case 'dbm': {
        const n = parseFloat(nilai);
        return isNaN(n) ? null : n.toFixed(2);
      }
      case 'bool':
        return (nilai === true || nilai === 1 || nilai === '1'
                || String(nilai).toLowerCase() === 'true');
      case 'mac': {
        const s = String(nilai).replace(/[^0-9a-f]/gi, '').toUpperCase();
        if (s.length !== 12) return String(nilai);
        return s.match(/.{2}/g).join(':');
      }
      default:
        return nilai;
    }
  }

  // ─── Inti: selesaikan satu field ───────────────────────────────
  /* Mengembalikan { nilai, sumber, indeks, waktu } — atau nilai null bila
     seluruh kandidat kosong. `indeks` (kandidat keberapa) sengaja ikut
     dikembalikan: tanpa itu, salah pemetaan baru ketahuan berbulan-bulan
     kemudian. */
  function resolve(raw, kunci, petaDipakai) {
    const p = petaDipakai || peta();
    const f = (p.fields || {})[kunci];
    const kosong = { nilai: null, sumber: null, indeks: -1, waktu: null };
    if (!raw || !f) return kosong;

    const daftar = f.sumber || f.sources || [];
    for (let i = 0; i < daftar.length; i++) {
      const s = daftar[i];
      if (typeof s !== 'string' || !s) continue;

      if (s.charAt(0) === '@') {
        const fn = TURUNAN[s.slice(1)];
        if (!fn) continue;
        let t = null;
        try { t = fn(raw); } catch (_) { t = null; }
        if (t && terisi(t.nilai)) {
          return { nilai: ubah(t.nilai, f.transform), sumber: s, indeks: i, waktu: t.waktu };
        }
        continue;
      }

      const bagian = s.split('.');
      const node = (s.indexOf('*') >= 0) ? telusuri(raw, bagian)
                                         : [jalurNode(raw, bagian)];
      for (const n of node) {
        const v = nilaiNode(n);
        if (terisi(v)) {
          return { nilai: ubah(v, f.transform), sumber: s, indeks: i, waktu: waktuNode(n) };
        }
      }
    }
    return kosong;
  }

  /* Nilai saja — bentuk yang dipakai mapDevice. */
  function nilai(raw, kunci, bawaanBila) {
    const r = resolve(raw, kunci);
    return terisi(r.nilai) ? r.nilai : (bawaanBila === undefined ? null : bawaanBila);
  }

  /* Umur seluruh field sekaligus: { rxPower: '2026-08-03T…', … } */
  function umurSemua(raw) {
    const out = {};
    const p = peta();
    for (const k of Object.keys(p.fields || {})) {
      const r = resolve(raw, k, p);
      if (r.waktu) out[k] = r.waktu;
    }
    return out;
  }

  // ─── Proyeksi ──────────────────────────────────────────────────
  /* Jalur mentah hanya ikut terambil kalau diminta dalam projection NBI.
     Untuk jalur ber-wildcard, minta awalannya sampai sebelum '*' — GenieACS
     mengembalikan seluruh sub-pohon di bawah awalan itu.

     Ini tetap MURNI BACA: projection hanya memilih bagian dokumen yang sudah
     tersimpan, tidak menyuruh GenieACS bertanya ke ONU. */
  function proyeksi(petaDipakai) {
    const p = petaDipakai || peta();
    const set = {};
    for (const k of Object.keys(p.fields || {})) {
      const daftar = (p.fields[k].sumber || p.fields[k].sources || []);
      for (const s of daftar) {
        if (typeof s !== 'string' || !s || s.charAt(0) === '@') continue;
        const bintang = s.indexOf('.*');
        const jalur = (bintang >= 0) ? s.slice(0, bintang) : s;
        if (jalur) set[jalur] = true;
      }
    }
    // Sumber turunan butuh ConnectionRequestURL.
    set['InternetGatewayDevice.ManagementServer.ConnectionRequestURL'] = true;
    return Object.keys(set);
  }

  // ─── Pemeriksaan bentuk (dipakai server & Settings) ────────────
  function periksa(m) {
    if (!m || typeof m !== 'object') return 'Pemetaan harus berupa objek';
    if (!m.fields || typeof m.fields !== 'object') return 'Pemetaan tidak punya "fields"';
    const kunciSah = Object.keys(BAWAAN.fields);
    for (const k of Object.keys(m.fields)) {
      if (kunciSah.indexOf(k) < 0) return 'Field tidak dikenal: ' + k;
      const f = m.fields[k];
      if (!f || typeof f !== 'object') return 'Field ' + k + ' harus berupa objek';
      const daftar = f.sumber || f.sources;
      if (!Array.isArray(daftar) || !daftar.length)
        return 'Field ' + k + ' harus punya minimal satu sumber';
      if (daftar.length > 12) return 'Field ' + k + ' punya terlalu banyak sumber (maks 12)';
      for (const s of daftar) {
        if (typeof s !== 'string' || !s.trim())
          return 'Sumber kosong pada field ' + k;
        if (s.charAt(0) === '@') {
          if (!TURUNAN[s.slice(1)]) return 'Sumber turunan tidak dikenal: ' + s;
          continue;
        }
        if (!/^(InternetGatewayDevice|Device|VirtualParameters)\./.test(s))
          return 'Sumber harus diawali VirtualParameters., InternetGatewayDevice., '
               + 'atau Device. — dapat: ' + s;
        if (s.indexOf(',') >= 0) return 'Sumber tidak boleh mengandung koma: ' + s;
      }
      if (f.transform && TRANSFORMASI.indexOf(f.transform) < 0)
        return 'Transformasi tidak dikenal pada ' + k + ': ' + f.transform;
    }
    return null;
  }

  // ─── Deteksi otomatis ──────────────────────────────────────────
  /* Diberi sekumpulan dokumen perangkat, laporkan untuk tiap field: kandidat
     mana yang benar-benar terisi dan pada berapa persen perangkat. Murni
     hitungan atas data yang sudah ada — tidak ada perintah ke ONU. */
  function cakupan(dokumen, petaDipakai) {
    const p = petaDipakai || peta();
    const hasil = {};
    for (const k of Object.keys(p.fields || {})) {
      const daftar = (p.fields[k].sumber || p.fields[k].sources || []);
      const hitung = daftar.map(() => 0);
      let terisiTotal = 0;
      for (const d of dokumen) {
        const r = resolve(d, k, p);
        if (r.indeks >= 0) { hitung[r.indeks]++; terisiTotal++; }
      }
      const n = dokumen.length || 1;
      hasil[k] = {
        label:    p.fields[k].label || k,
        total:    dokumen.length,
        terisi:   terisiTotal,
        persen:   Math.round(terisiTotal * 100 / n),
        perSumber: daftar.map((s, i) => ({
          sumber: s, dipakai: hitung[i], persen: Math.round(hitung[i] * 100 / n),
        })),
      };
    }
    return hasil;
  }

  // ─── Umur data (butir 6) ───────────────────────────────────────
  const AMBANG_SEGAR = 15 * 60 * 1000;   // < 15 mnt → netral
  const AMBANG_TUA    = 60 * 60 * 1000;  // > 60 mnt → perlu disegarkan

  /* Ubah timestamp jadi keterangan siap tampil.
     Tanpa ini teknisi menekan Refresh karena ragu apakah angkanya masih benar —
     dan tiap klik ragu adalah satu ONU yang disuruh bekerja tanpa perlu. */
  function umur(waktu, sekarang) {
    if (!waktu) return null;
    const t = new Date(waktu).getTime();
    if (isNaN(t)) return null;
    const beda = Math.max(0, (sekarang || Date.now()) - t);
    const menit = Math.floor(beda / 60000);

    let teks;
    if (beda < 60000)        teks = 'baru saja';
    else if (menit < 60)     teks = menit + ' menit lalu';
    else if (menit < 1440)   teks = Math.floor(menit / 60) + ' jam lalu';
    else                     teks = Math.floor(menit / 1440) + ' hari lalu';

    const tingkat = beda < AMBANG_SEGAR ? 'segar'
                  : (beda <= AMBANG_TUA ? 'redup' : 'tua');
    return { teks, tingkat, menit, ms: beda, perluSegar: tingkat === 'tua' };
  }

  global.VPMap = {
    BAWAAN, TRANSFORMASI, TURUNAN,
    AMBANG_SEGAR, AMBANG_TUA,
    bawaan, peta, setPeta,
    resolve, nilai, umurSemua, proyeksi, periksa, cakupan, umur,
    // dibuka untuk pengujian
    _telusuri: telusuri, _ubah: ubah, _terisi: terisi,
  };
})(typeof window !== 'undefined' ? window : globalThis);
