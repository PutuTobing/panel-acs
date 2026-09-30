#!/usr/bin/env python3
"""Jalankan seluruh uji (Python + JavaScript) dengan satu perintah.

    python tests/jalankan_semua.py            # semua uji
    python tests/jalankan_semua.py oplock     # hanya uji yang namanya memuat "oplock"

Semua uji memakai database sementara dan NBI GenieACS tiruan — tidak ada yang
menyentuh data/sky.db atau GenieACS sungguhan.

Di Windows, empat uji gagal karena perbedaan sistem operasi, bukan bug panel
(panel produksi berjalan di Linux). Uji itu ditandai "khusus Linux" agar tidak
disangka regresi; di Linux mereka dihitung seperti uji lain.
"""
import os
import subprocess
import sys
import time

TESTS = os.path.dirname(os.path.abspath(__file__))

# Uji yang bergantung pada perilaku Linux: izin berkas 0600 (auth), menghapus
# berkas yang masih terbuka (db), dan kode galat soket untuk port tertutup /
# koneksi terputus (onuproxy, server_auth).
KHUSUS_LINUX = {'auth.test.py', 'db.test.py', 'onuproxy.test.py', 'server_auth.test.py'}


def daftar_uji(saring):
    for nama in sorted(os.listdir(TESTS)):
        if not (nama.endswith('.test.py') or nama.endswith('.test.js')
                or nama == 'difftest-vendor.js'):
            continue
        if saring and saring not in nama:
            continue
        yield nama


def main():
    # Terminal Windows yang output-nya dialihkan (mis. Git Bash) memakai cp1252 dan
    # gagal mencetak ✓/✗ — laporan uji tidak boleh jatuh karena itu.
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    saring = sys.argv[1] if len(sys.argv) > 1 else ''
    windows = os.name == 'nt'
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    lulus, gagal, dimaklumi = [], [], []

    for nama in daftar_uji(saring):
        exe = sys.executable if nama.endswith('.py') else 'node'
        mulai = time.time()
        p = subprocess.run([exe, os.path.join(TESTS, nama)], capture_output=True,
                           text=True, encoding='utf-8', errors='replace', env=env)
        dtk = time.time() - mulai
        baris = (p.stdout + p.stderr).strip().splitlines()
        akhir = baris[-1].strip() if baris else ''
        if p.returncode == 0:
            lulus.append(nama)
            print(f'  ✓ {nama:<26} {dtk:5.1f} dtk  {akhir[:70]}')
        elif windows and nama in KHUSUS_LINUX:
            dimaklumi.append(nama)
            print(f'  ~ {nama:<26} {dtk:5.1f} dtk  khusus Linux — gagal di Windows, bukan bug')
        else:
            gagal.append(nama)
            print(f'  ✗ {nama:<26} {dtk:5.1f} dtk')
            for b in baris[-15:]:
                print('      ' + b)

    print()
    print(f'Lulus: {len(lulus)}   Gagal: {len(gagal)}'
          + (f'   Khusus Linux (dilewati di Windows): {len(dimaklumi)}' if dimaklumi else ''))
    if gagal:
        print('GAGAL: ' + ', '.join(gagal))
    sys.exit(1 if gagal else 0)


if __name__ == '__main__':
    main()
