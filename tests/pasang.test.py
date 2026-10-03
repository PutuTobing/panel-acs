#!/usr/bin/env python3
"""Uji skrip pemasang tools/pasang.sh (2026-10-03).

Skrip itu dijalankan sebagai ROOT di server orang, sering lewat `curl … | sudo bash`,
jadi yang dijaga adalah sifat-sifat yang tidak boleh hilang saat ia disunting:

  • berhenti pada galat pertama (set -euo pipefail), akhir baris LF;
  • panel tidak dijalankan sebagai root; data/ hanya untuk akun panel (0700);
  • tidak pernah menghapus atau menimpa data yang sudah ada;
  • pembaruan ulang hanya maju lurus (--ff-only).

Skripnya sendiri TIDAK dijalankan di sini (butuh Ubuntu + root). Sintaksnya diperiksa
dengan `bash -n` bila bash ada.
"""
import os, re, shutil, subprocess, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
JALUR = os.path.join(ROOT, 'tools', 'pasang.sh')

_p, _f = 0, 0
def ok(c, m):
    global _p, _f
    if c: _p += 1
    else:
        _f += 1
        print('  ✗ ' + m)

mentah = open(JALUR, 'rb').read()
s = mentah.decode('utf-8')
kode = '\n'.join(b for b in s.splitlines() if not b.lstrip().startswith('#'))     # tanpa komentar

ok(mentah.startswith(b'#!/usr/bin/env bash\n') and b'\r' not in mentah, 'shebang bash dan akhir baris LF (CRLF membuat bash gagal di Linux)')
ok('set -euo pipefail' in kode, 'berhenti pada galat pertama (set -euo pipefail)')
bash = shutil.which('bash')
if bash:
    r = subprocess.run([bash, '-n', JALUR], capture_output=True, text=True)
    ok(r.returncode == 0, 'bash -n: sintaks sah — ' + r.stderr.strip()[:200])
else:
    print('  (bash tidak ada — pemeriksaan sintaks dilewati)')

ok('"$(id -u)" -eq 0' in kode, 'menolak dijalankan tanpa hak root (dengan pesan, bukan gagal di tengah)')
ok('User=$SKY_USER' in kode and re.search(r'case "\$SKY_USER" in root\|', kode) and '--shell /usr/sbin/nologin' in kode,
   'layanan berjalan sebagai akun sistem tanpa login — bukan root')
ok('Restart=always' in kode and 'systemctl enable' in kode, 'layanan menyala sendiri saat server dinyalakan dan dinyalakan ulang bila mati')
ok('NoNewPrivileges=true' in kode and 'UMask=0077' in kode, 'pengerasan layanan: tanpa hak tambahan, berkas baru hanya untuk akun panel')
ok(re.search(r'install -d -m 700 -o "\$SKY_USER" -g "\$SKY_USER" "\$SKY_DIR/data"', kode), 'folder data/ dibuat 0700 milik akun panel')
ok(not re.search(r'\brm\s+-[a-zA-Z]*r', kode) and 'git reset' not in kode and '--force' not in kode and 'clean -' not in kode,
   'tidak ada perintah yang menghapus atau menimpa paksa (rm -r, reset, --force, clean)')
ok('pull --ff-only' in kode, 'menjalankan ulang pada panel yang sudah ada: git pull hanya maju')
blok = kode.split('if [ -n "$SKY_DATA_DARI" ]; then')[1].split('\nfi\n')[0]
ok('if [ -f "$SKY_DIR/data/sky.db" ]; then' in blok and blok.index('sky.db" ]; then') < blok.index('cp -a'),
   'data lama hanya disalin bila panel baru BELUM punya basis data')
ok('[ -e "$SKY_DIR" ] && [ -n "$(ls -A "$SKY_DIR"' in kode, 'folder tujuan yang sudah berisi berkas lain tidak ditimpa')
ok('ss -ltnH "sport = :$SKY_PORT"' in kode, 'port yang sudah dipakai program lain terdeteksi sebelum layanan dipasang')
ok(re.search(r"case \"\$SKY_PORT\" in ''\|\*\[!0-9\]\*\)", kode) and 'case "$SKY_DIR" in /*)' in kode,
   'nilai SKY_PORT / SKY_DIR diperiksa sebelum dipakai')
# Jalur dari variabel selalu berada DI DALAM tanda kutip ganda (folder ber-spasi tidak boleh
# terpecah menjadi dua argumen). Isi berkas unit systemd (heredoc) bukan perintah shell.
luar_heredoc = re.sub(r'<<EOF\n.*?\nEOF\n', '\n', kode, flags=re.S)
tanpa_kutip = [b.strip() for b in luar_heredoc.splitlines()
               for m in re.finditer(r'\$\{?(SKY_DIR|SKY_DATA_DARI|UNIT)\b', b)
               # di dalam "…" = jumlah kutip sebelumnya ganjil, atau tepat diawali kutip
               # (kutip bersarang di dalam "$( … )").
               if b[:m.start()].count('"') % 2 == 0 and not b[:m.start()].endswith('"')
               and not re.match(r'\s*(SKY_\w+|UNIT)=', b)]
ok(not tanpa_kutip, 'jalur dari variabel selalu dikutip — %r' % tanpa_kutip[:2])
readme = open(os.path.join(ROOT, 'README.md'), encoding='utf-8').read()
ok('raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo bash' in readme
   and 'raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo bash' in s,
   'perintah satu baris di README sama dengan yang tertulis di skrip')
ok('SETUP_CODE.txt' in kode, 'kode instalasi ditampilkan di akhir pemasangan')

print(f'pasang: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
