#!/usr/bin/env node
/* Potret tampilan panel — untuk MEMERIKSA perubahan UI dengan mata, bukan menebak.

   Yang dijalankan (semuanya lokal & sementara, TIDAK menyentuh GenieACS maupun data/sky.db):
     1. GenieACS TIRUAN (NBI palsu) yang menyajikan dokumen perangkat contoh. Perintah
        tulis TIDAK diteruskan ke mana pun: dicatat, lalu setParameterValues diterapkan ke
        dokumen di memori dan _lastInform dimajukan — meniru ONU yang menjalankannya,
        supaya alur "Simpan → menunggu ONU → daftar tampil lagi" bisa diperiksa.
     2. Panel sungguhan (backend/server.py) dengan basis data SEMENTARA dan satu akun uji,
        diarahkan ke NBI tiruan itu.
     3. Browser tanpa jendela (Edge/Chrome) yang dikendalikan lewat DevTools Protocol:
        login, buka halaman, klik, lalu simpan tangkapan layar di beberapa ukuran layar.

   Pemakaian:
       node tools/potret.js <skenario.js> [--data <folder dokumen>] [--keluar <folder hasil>] [--segar] [--xss]

   --data    folder berisi dokumen perangkat (*.json, bentuk GenieACS). Tanpa ini dipakai
             dua perangkat contoh BUATAN dari tools/potret-contoh.js.
             JANGAN menyimpan dokumen ONU pelanggan di dalam repositori.
   --segar   anggap semua perangkat baru saja melapor (tampil Online), berapa pun
             umur dokumennya.
   --kosong  panel tanpa akun sama sekali (baru dipasang) — untuk memeriksa layar instalasi;
             skenario mulai TANPA login.
   --xss     (hanya dokumen contoh) sisipkan teks ber-HTML pada nama WiFi/perangkat —
             untuk memeriksa bahwa semuanya tampil sebagai teks.

   <skenario.js> mengekspor fungsi async (h) => {…}. Alat yang tersedia di `h`:
       h.daftar            daftar _id perangkat di folder data
       h.ukuran(l, t, hp)  ukuran layar (hp=true → emulasi ponsel)
       h.buka(path)        buka alamat panel, mis. '/devices/<id>'
       h.tunggu(sel, ms)   tunggu sampai selector ada
       h.klik(sel)         klik elemen
       h.js(kode)          jalankan JavaScript di halaman, kembalikan hasilnya
       h.tidur(ms)
       h.dok               dokumen NBI tiruan; d.__saatRefresh = fn(d) dipanggil saat refreshObject "dijalankan"
       h.potret(nama, {penuh})   simpan <nama>.png (penuh=true → seluruh tinggi halaman)
       h.masuk(akun)       keluar lalu masuk sebagai akun lain: h.akun.admin / h.akun.user
                           (role user) / h.akun.pelanggan (portal /pelanggan, ONU contoh pertama). Muat ulang halaman sesudahnya dengan h.buka().
       h.permintaan        semua permintaan yang dikirim BROWSER ke panel: [{metode, url, status}]
                           — untuk menghitung berapa kali satu halaman bertanya ke server
                           (permintaan kembar, bolak-balik). Kosongkan dengan .length = 0.
       h.bacaan            semua GET yang sampai ke NBI tiruan: [url] — beban baca ke GenieACS.

   Perintah tulis yang dikirim panel (POST/DELETE ke NBI) hanya DICATAT oleh NBI
   tiruan — tidak ke mana-mana. Hasil catatannya ada di h.catatan. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (nama, bawaan) => {
  const i = process.argv.indexOf('--' + nama);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : bawaan;
};
const SKENARIO = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null;
const DATA   = arg('data', null) ? path.resolve(arg('data', null)) : null;   // null → dokumen contoh buatan
const KELUAR = path.resolve(arg('keluar', path.join(os.tmpdir(), 'potret-panel')));
const SEGAR  = process.argv.includes('--segar');
const KOSONG = process.argv.includes('--kosong');   // panel baru dipasang: belum ada satu akun pun
const AKUN   = { username: 'penguji', password: 'Potret-Uji-2026', name: 'Akun Uji' };
// Akun kedua ber-role user — untuk memeriksa apa yang tampil bagi teknisi biasa (h.masuk).
const AKUN_USER = { username: 'teknisi', password: 'Teknisi-Uji-2026', name: 'Teknisi Uji' };
// Akun ketiga ber-role pelanggan, dipasangkan ke ONU contoh PERTAMA — untuk portal /pelanggan.
const AKUN_PEL = { username: 'pelanggan1', password: 'Pelanggan123', name: 'Pelanggan Satu' };

const portBebas = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const tidur = ms => new Promise(r => setTimeout(r, ms));

// ── 1. NBI tiruan ───────────────────────────────────────────────────────────
function muatDokumen() {
  let dok;
  if (!DATA) {
    dok = require('./potret-contoh').buat({ xss: process.argv.includes('--xss') });
  } else {
    if (!fs.existsSync(DATA)) throw new Error('Folder data tidak ada: ' + DATA);
    dok = fs.readdirSync(DATA).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')));
  }
  return dok
    .map(d => { if (SEGAR) d._lastInform = new Date(Date.now() - 90000).toISOString(); return d; });
}
// Tiru ONU yang menjalankan perintah: nilai setParameterValues masuk ke dokumen di
// memori, dan _lastInform maju (panel menunggu perubahan itu sebelum menggambar ulang).
function tirukan(dok, pathname, badan) {
  const m = /^\/devices\/([^/]+)\/tasks/.exec(pathname);
  if (!m) return;
  const d = dok.find(x => x._id === decodeURIComponent(m[1]));
  if (!d) return;
  let t = null;
  try { t = JSON.parse(badan); } catch (_) { t = null; }
  const kini = new Date().toISOString();
  if (t && t.name === 'setParameterValues' && Array.isArray(t.parameterValues)) {
    t.parameterValues.forEach(p => {
      const bagian = String(p[0]).split('.');
      let o = d;
      for (let i = 0; i < bagian.length - 1; i++) {
        if (!o[bagian[i]] || typeof o[bagian[i]] !== 'object') o[bagian[i]] = { _object: true, _writable: true };
        o = o[bagian[i]];
      }
      const daun = bagian[bagian.length - 1];
      o[daun] = Object.assign({ _object: false, _writable: true }, o[daun] || {},
                              { _value: p[1], _type: p[2] || (o[daun] && o[daun]._type) || 'xsd:string', _timestamp: kini });
    });
  }
  d._lastInform = kini;
}
function mulaiNbi(dok, catatan, bacaan) {
  const antre = [];                  // task refreshObject yang "belum dijalankan ONU"
  const gagal = [];                  // fault tiruan (lihat 'GAGAL-UJI')
  const cocok = (d, q) => {
    if (!q || typeof q !== 'object') return true;
    if (q._id !== undefined) return typeof q._id === 'string' ? d._id === q._id : true;
    const sn = q['_deviceId._SerialNumber'];
    if (typeof sn === 'string') return (d._deviceId || {})._SerialNumber === sn;
    return true;
  };
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const u = new URL(req.url, 'http://x');
      let badan = '';
      req.on('data', c => { badan += c; });
      req.on('end', () => {
        const json = (st, o) => { rsp.writeHead(st, { 'Content-Type': 'application/json' }); rsp.end(JSON.stringify(o)); };
        if (req.method !== 'GET') {            // tulis → dicatat + ditirukan di memori
          catatan.push({ metode: req.method, url: req.url, badan: badan.slice(0, 4000) });
          const id = 'tugas-' + catatan.length;
          // refreshObject meniru ONU yang lambat: mengantre ~4 dtk (jawaban 202, task
          // tampak di /tasks), lalu "dijalankan": data berubah (dok.__saatRefresh) dan
          // _lastInform maju. Perintah lain langsung tuntas seperti sebelumnya.
          const mt = /^\/devices\/([^/]+)\/tasks/.exec(u.pathname);
          let t = null;
          try { t = JSON.parse(badan); } catch (_) { t = null; }
          // Nilai 'GAGAL-UJI' pada setParameterValues meniru ONU yang menolak perintah:
          // jawaban 202 + fault berkanal task_<id> (seperti GenieACS sungguhan).
          if (mt && t && t.name === 'setParameterValues' && Array.isArray(t.parameterValues)
              && t.parameterValues.some(p => p[1] === 'GAGAL-UJI')) {
            const devId = decodeURIComponent(mt[1]);
            antre.push({ _id: id, device: devId, name: 'setParameterValues' });
            gagal.push({ _id: devId + ':task_' + id, device: devId, channel: 'task_' + id, code: 'cwmp.9007', message: 'Invalid parameter value' });
            return json(202, { _id: id, device: devId, name: 'setParameterValues' });
          }
          if (mt && t && t.name === 'refreshObject') {
            const devId = decodeURIComponent(mt[1]);
            antre.push({ _id: id, device: devId, name: 'refreshObject' });
            setTimeout(() => {
              const d = dok.find(x => x._id === devId);
              if (d && typeof d.__saatRefresh === 'function') d.__saatRefresh(d);
              if (d) d._lastInform = new Date().toISOString();
              const i = antre.findIndex(x => x._id === id);
              if (i >= 0) antre.splice(i, 1);
            }, 4000);
            return json(202, { _id: id, device: devId, name: 'refreshObject' });
          }
          tirukan(dok, u.pathname, badan);
          return json(200, { _id: id });
        }
        bacaan.push(req.url);
        if (u.pathname.replace(/\/$/, '') === '/faults') {
          let q = null;
          try { q = JSON.parse(u.searchParams.get('query') || 'null'); } catch (_) { q = null; }
          return json(200, gagal.filter(x => !q || !q.device || x.device === q.device));
        }
        if (u.pathname.replace(/\/$/, '') === '/tasks') {
          let q = null;
          try { q = JSON.parse(u.searchParams.get('query') || 'null'); } catch (_) { q = null; }
          return json(200, antre.filter(x => !q || !q.device || x.device === q.device));
        }
        if (u.pathname.replace(/\/$/, '') === '/devices') {
          let q = null;
          try { q = JSON.parse(u.searchParams.get('query') || 'null'); } catch (_) { q = null; }
          return json(200, dok.filter(d => cocok(d, q)));
        }
        return json(200, []);                   // /faults, /tasks, dst.
      });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

// ── 2. Panel dengan basis data sementara ────────────────────────────────────
function mulaiPanel(port, portNbi, tmp, onuPel) {
  const AKUN_BOOT = `auth.create_user(${JSON.stringify(AKUN.username)}, ${JSON.stringify(AKUN.password)}, ${JSON.stringify(AKUN.name)}, role='administrator')
auth.create_user(${JSON.stringify(AKUN_USER.username)}, ${JSON.stringify(AKUN_USER.password)}, ${JSON.stringify(AKUN_USER.name)}, role='user')
_pel = auth.create_user(${JSON.stringify(AKUN_PEL.username)}, ${JSON.stringify(AKUN_PEL.password)}, ${JSON.stringify(AKUN_PEL.name)}, role='pelanggan')
import pelanggan
pelanggan.atur_onu_akun(_pel['id'], [{'id': ${JSON.stringify(String(onuPel || ''))}}])
`;
  const boot = `
import sys, os
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'backend'))})
import db, auth
auth.DATA_DIR = ${JSON.stringify(tmp)}
db.set_path(os.path.join(${JSON.stringify(tmp)}, 'sky.db'))
db.init()
${KOSONG ? '' : AKUN_BOOT}import config_store, server
config_store.acs_set({'protocol': 'http', 'host': '127.0.0.1', 'port': ${portNbi}, 'base_path': ''})
print('SIAP', flush=True)
srv = server.ThreadingHTTPServer(('127.0.0.1', ${port}), server.SPAHandler)
srv.daemon_threads = True
srv.serve_forever()
`;
  return new Promise((res, rej) => {
    // Windows: 'python'; Linux/Mac biasanya 'python3'. SKY_PYTHON menimpa keduanya.
    const py = process.env.SKY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const p = spawn(py, ['-c', boot], { cwd: ROOT, env: Object.assign({}, process.env,
      { SKY_CONFIG: path.join(tmp, 'config.json'), PYTHONIOENCODING: 'utf-8' }) });
    let log = '';
    const t = setTimeout(() => rej(new Error('panel tidak siap:\n' + log)), 20000);
    p.stdout.on('data', c => { log += c; if (/SIAP/.test(log)) { clearTimeout(t); res(p); } });
    p.stderr.on('data', c => { log += c; });
    p.on('exit', k => { clearTimeout(t); rej(new Error('panel berhenti (kode ' + k + '):\n' + log)); });
  });
}

// ── 3. Browser tanpa jendela + DevTools Protocol ────────────────────────────
function cariBrowser() {
  const calon = [process.env.SKY_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  const ada = calon.find(c => fs.existsSync(c));
  if (!ada) throw new Error('Browser tidak ditemukan. Setel SKY_BROWSER ke lokasi chrome/msedge.');
  return ada;
}
function mulaiBrowser(tmp) {
  return new Promise((res, rej) => {
    const p = spawn(cariBrowser(), ['--headless=new', '--remote-debugging-port=0',
      '--user-data-dir=' + path.join(tmp, 'profil'), '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-extensions', '--mute-audio', 'about:blank']);
    let err = '';
    const t = setTimeout(() => rej(new Error('browser tidak siap:\n' + err)), 20000);
    p.stderr.on('data', c => {
      err += c;
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(err);
      if (m) { clearTimeout(t); res({ proses: p, ws: m[1] }); }
    });
    p.on('exit', k => { clearTimeout(t); rej(new Error('browser berhenti (kode ' + k + '):\n' + err)); });
  });
}
function cdp(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const tunggu = new Map();
    const dengar = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && tunggu.has(m.id)) {
        const { ya, tidak } = tunggu.get(m.id); tunggu.delete(m.id);
        m.error ? tidak(new Error(m.error.message)) : ya(m.result);
      } else if (m.method) dengar.forEach(f => f(m));
    });
    ws.addEventListener('error', () => rej(new Error('WebSocket DevTools gagal')));
    ws.addEventListener('open', () => res({
      kirim: (method, params, sessionId) => new Promise((ya, tidak) => {
        const n = ++id; tunggu.set(n, { ya, tidak });
        ws.send(JSON.stringify(Object.assign({ id: n, method, params: params || {} }, sessionId ? { sessionId } : {})));
      }),
      saat: f => dengar.push(f),
      tutup: () => ws.close(),
    }));
  });
}

// Dipakai juga oleh tests/tampilan.test.js untuk tahu apakah browser tersedia.
module.exports = { cariBrowser };

// ── Jalankan (hanya bila dipanggil langsung, bukan di-require) ───────────────
if (require.main === module) (async () => {
  if (!SKENARIO) { console.error('Pemakaian: node tools/potret.js <skenario.js> [--data folder] [--keluar folder] [--segar]'); process.exit(2); }
  fs.mkdirSync(KELUAR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skypotret-'));
  const dok = muatDokumen();
  const catatan = [];
  const bacaan = [];
  const permintaan = [];
  const bersih = [];
  let kode = 0;
  try {
    const nbi = await mulaiNbi(dok, catatan, bacaan);                 bersih.push(() => nbi.close());
    const port = await portBebas();
    const panel = await mulaiPanel(port, nbi.address().port, tmp, dok[0] && dok[0]._id); bersih.push(() => panel.kill());
    panel.removeAllListeners('exit');
    const br = await mulaiBrowser(tmp);                       bersih.push(() => br.proses.kill());
    br.proses.removeAllListeners('exit');
    const c = await cdp(br.ws);                               bersih.push(() => c.tutup());
    const { targetId } = await c.kirim('Target.createTarget', { url: 'about:blank' });
    const { sessionId: S } = await c.kirim('Target.attachToTarget', { targetId, flatten: true });
    const galatHalaman = [];
    c.saat(m => {
      if (m.method === 'Runtime.exceptionThrown') galatHalaman.push(m.params.exceptionDetails.exception
        ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
        galatHalaman.push('console.error: ' + m.params.args.map(a => a.value || a.description || '').join(' '));
      // Permintaan browser → panel (bukan data:, bukan CDN): dicatat untuk h.permintaan.
      if (m.method === 'Network.requestWillBeSent' && /^https?:\/\/127\.0\.0\.1:/.test(m.params.request.url)) {
        permintaan.push({ id: m.params.requestId, metode: m.params.request.method,
                          url: m.params.request.url.replace(/^https?:\/\/[^/]+/, ''), status: 0 });
      }
      if (m.method === 'Network.responseReceived') {
        const r = permintaan.find(x => x.id === m.params.requestId && !x.status);
        if (r) r.status = m.params.response.status;
      }
      if (m.method === 'Log.entryAdded') {
        const e = m.params.entry || {};
        if (e.level === 'error' && /Content Security Policy|integrity|Subresource/i.test(e.text || ''))
          galatHalaman.push('keamanan: ' + e.text);
      }
    });
    await c.kirim('Page.enable', {}, S);
    await c.kirim('Runtime.enable', {}, S);
    // Pelanggaran Content-Security-Policy & SRI dilaporkan browser lewat Log, bukan console —
    // tanpa ini pustaka yang diblokir CSP (ikon hilang, grafik tak muncul) lolos diam-diam.
    await c.kirim('Log.enable', {}, S);
    await c.kirim('Network.enable', {}, S);
    const BASE = 'http://127.0.0.1:' + port;

    const js = async kode2 => {
      const r = await c.kirim('Runtime.evaluate', { expression: kode2, awaitPromise: true, returnByValue: true }, S);
      if (r.exceptionDetails) throw new Error('JS halaman: ' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
      return r.result.value;
    };
    const muat = async url => {
      const selesai = new Promise(ya => {
        const f = m => { if (m.method === 'Page.loadEventFired') ya(); };
        c.saat(f);
      });
      await c.kirim('Page.navigate', { url }, S);
      await Promise.race([selesai, tidur(15000)]);
    };
    let layar = { lebar: 1440, tinggi: 900, hp: false };
    const setLayar = (lebar, tinggi, hp) => c.kirim('Emulation.setDeviceMetricsOverride',
      { width: lebar, height: tinggi, deviceScaleFactor: hp ? 2 : 1, mobile: !!hp }, S);
    const h = {
      daftar: dok.map(d => d._id),
      dok,                 // dokumen NBI tiruan — skenario boleh mengubahnya (mis. __saatRefresh)
      catatan,
      bacaan,
      permintaan,
      galat: galatHalaman,
      tidur,
      js,
      ukuran: (lebar, tinggi, hp) => { layar = { lebar, tinggi, hp: !!hp }; return setLayar(lebar, tinggi, hp); },
      buka: async p => { await muat(BASE + p); await tidur(400); },
      tunggu: async (sel, ms) => {
        const batas = Date.now() + (ms || 10000);
        while (Date.now() < batas) {
          if (await js('!!document.querySelector(' + JSON.stringify(sel) + ')')) return true;
          await tidur(120);
        }
        throw new Error('tidak muncul: ' + sel);
      },
      klik: async sel => {
        const ok = await js('(function(){var e=document.querySelector(' + JSON.stringify(sel)
          + ');if(!e)return false;e.click();return true;})()');
        if (!ok) throw new Error('tidak ada untuk diklik: ' + sel);
        await tidur(350);
      },
      potret: async (nama, o) => {
        o = o || {};
        if (o.penuh) {
          // Seluruh tinggi isi halaman. Panel menggulir di dalam #contentArea (body tidak
          // menggulir), jadi layar ditinggikan dulu sampai semua isi terlihat, lalu dikembalikan.
          const t = await js('(function(){var c=document.getElementById("contentArea");'
            + 'return Math.ceil(c ? c.scrollHeight + c.getBoundingClientRect().top + 8 : document.documentElement.scrollHeight);})()');
          await setLayar(layar.lebar, Math.min(Math.max(t, layar.tinggi), 9000), layar.hp);
          await tidur(350);
        }
        const r = await c.kirim('Page.captureScreenshot', { format: 'png' }, S);
        if (o.penuh) await setLayar(layar.lebar, layar.tinggi, layar.hp);
        const f = path.join(KELUAR, nama + '.png');
        fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
        console.log('  potret →', f);
        return f;
      },
    };

    // Login lewat API yang sama dengan form login.
    h.akun = { admin: AKUN, user: AKUN_USER, pelanggan: AKUN_PEL };
    h.masuk = async akun => {
      akun = akun || AKUN;
      await js('fetch("/auth/logout",{method:"POST"}).then(r=>r.status)');
      const s = await js('fetch("/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:'
        + JSON.stringify(JSON.stringify({ username: akun.username, password: akun.password })) + '}).then(r=>r.status)');
      if (s !== 200) throw new Error('login ' + akun.username + ' gagal: HTTP ' + s);
    };
    await h.ukuran(1440, 900, false);
    await h.buka('/');
    if (!KOSONG) await h.masuk(AKUN);

    await require(SKENARIO)(h);
    if (galatHalaman.length) {
      console.log('\nGalat JavaScript di halaman (' + galatHalaman.length + '):');
      [...new Set(galatHalaman)].slice(0, 15).forEach(g => console.log('  ✗ ' + String(g).split('\n')[0].slice(0, 300)));
      kode = 1;
    }
    if (catatan.length) console.log('\nPerintah tulis yang dicatat NBI tiruan: ' + catatan.length);
  } catch (e) {
    console.error('GAGAL: ' + (e && e.stack || e));
    kode = 1;
  } finally {
    for (const f of bersih.reverse()) { try { f(); } catch (_) { /* sudah mati */ } }
    await tidur(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* profil browser masih terkunci */ }
    process.exit(kode);
  }
})();
