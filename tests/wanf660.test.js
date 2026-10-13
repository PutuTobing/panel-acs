#!/usr/bin/env node
/* Uji browser form WAN X_CMCC: VLAN transparent & MTU 0 tidak ikut berubah saat Simpan
 * (2026-10-13). Lihat tests/wanf660.skenario.js untuk latar dan yang dijaga.
 *
 * Perangkatnya BUATAN: dokumen contoh tools/potret-contoh.js diberi bentuk ZTE F660 dan satu
 * PPPoE bridge (VLAN 0, X_CMCC_VLANMode 1, MaxMRUSize 0). Tidak ada dokumen ONU asli, tidak
 * menyentuh data/sky.db maupun GenieACS sungguhan. Butuh Edge/Chrome; bila tak ada, uji
 * DILEWATI dengan keterangan — bukan gagal.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let browser = null;
try { browser = require(path.join(ROOT, 'tools', 'potret.js')).cariBrowser(); } catch (_) { browser = null; }
if (!browser) {
  console.log('wanf660: dilewati — browser (Edge/Chrome) tidak ditemukan; setel SKY_BROWSER untuk menjalankannya');
  process.exit(0);
}

// ── Dokumen perangkat buatan ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skywanf660-'));
const data = path.join(tmp, 'data'), keluar = path.join(tmp, 'potret');
fs.mkdirSync(data); fs.mkdirSync(keluar);
const d = require(path.join(ROOT, 'tools', 'potret-contoh')).buat({})[0];
const leaf = (v, t) => ({ _object: false, _writable: true, _timestamp: new Date().toISOString(), _type: t, _value: v });
d._id = 'F4B5AA-F660-ZTERCONTOH0660';
d._deviceId = Object.assign({}, d._deviceId, { _ProductClass: 'F660', _OUI: 'F4B5AA', _SerialNumber: 'ZTERCONTOH0660', _Manufacturer: 'ZTE' });
const ppp = d.InternetGatewayDevice.WANDevice['1'].WANConnectionDevice['1'].WANPPPConnection;
ppp['5'] = Object.assign(JSON.parse(JSON.stringify(ppp['2'])), {
  Name: leaf('4_INTERNET_B_VID_0', 'xsd:string'), ConnectionType: leaf('PPPoE_Bridged', 'xsd:string'), Username: leaf('', 'xsd:string'),
  ExternalIPAddress: leaf('0.0.0.0', 'xsd:string'), NATEnabled: leaf(false, 'xsd:boolean'), Uptime: leaf(0, 'xsd:unsignedInt'),
  MaxMRUSize: leaf(0, 'xsd:unsignedInt'), X_CMCC_VLANIDMark: leaf(0, 'xsd:int'), X_CMCC_VLANMode: leaf(1, 'xsd:int'),
  X_CMCC_LanInterface: leaf('InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4', 'xsd:string'),
});
// Akun web F660: X_CMCC_TeleComAccount (nama 'admin'); password kosong seperti yang dikirim ONU.
d.InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount = { _object: true, _writable: false,
  Enable: leaf(true, 'xsd:boolean'), Username: leaf('admin', 'xsd:string'), Password: leaf('', 'xsd:string') };
fs.writeFileSync(path.join(data, 'f660.json'), JSON.stringify(d));

function jalankan() {
  return spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'potret.js'), path.join(__dirname, 'wanf660.skenario.js'), '--data', data, '--segar', '--keluar', keluar,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
}
let p = jalankan();
// Browser tanpa jendela sesekali macet saat mesin sibuk (lihat tests/tampilan.test.js) — satu kali ulang.
if (!/^wanf660: \d+ lulus/m.test((p.stdout || '') + (p.stderr || ''))) p = jalankan();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* biarkan */ }

const baris = ((p.stdout || '') + (p.stderr || '')).trim().split(/\r?\n/).filter(Boolean);
const ringkas = baris.filter(b => /^wanf660: /.test(b)).pop();
baris.filter(b => b !== ringkas && !/potret →|Perintah tulis yang dicatat/.test(b)).forEach(b => console.log(b));
if (p.error) console.log('  ✗ gagal menjalankan browser: ' + p.error.message);
console.log(ringkas || 'wanf660: 0 lulus, 1 gagal (skenario tidak selesai)');
process.exit(p.status === 0 && ringkas && / 0 gagal/.test(ringkas) ? 0 : 1);
