/* Portal pelanggan — pengganti kosong (2026-10-03).
   Halaman ini memakai ulang api.js, devices.js, dan device-detail.js agar dokumen ONU dibaca
   dengan kode yang SAMA dengan panel. Berkas-berkas itu mendaftarkan diri ke objek navigasi
   panel (PAGE_INIT dll.) dan memanggil beberapa util panel; di sini semuanya disediakan
   kosong/sederhana. Tidak ada satu pun yang memberi akses lebih: pagarnya di server. */
'use strict';
var App = { devices: [], user: null };
var PAGE_INIT = {}, PAGE_TEARDOWN = {}, PAGE_ACTIONS = {};
var PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444'];
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
