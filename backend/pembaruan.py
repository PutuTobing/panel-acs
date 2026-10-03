"""Pembaruan panel dari GitHub tanpa memasang ulang (2026-10-03).

Panel dipasang dengan `git clone` (lihat tools/pasang.sh). Memperbaruinya dulu berarti
masuk ke server lewat SSH, `git pull`, lalu menyalakan ulang layanannya — pekerjaan yang
mudah terlupa satu langkahnya. Tombol Update di Settings → Tentang Sistem melakukan hal
yang sama, dengan pagar berikut:

  • HANYA dari remote `origin` dan cabang yang sedang terpasang — keduanya dibaca dari
    repositori di server ini. Permintaan dari browser tidak membawa alamat, cabang, atau
    perintah apa pun: tombol ini tidak bisa diarahkan mengambil kode dari tempat lain.
  • HANYA maju (fast-forward). Riwayat tidak pernah ditulis ulang; bila server punya
    commit sendiri atau berkas panel diubah langsung di server, pembaruan DIBATALKAN
    dengan penjelasan — tidak ada yang ditimpa diam-diam.
  • Basis data dicadangkan dulu (sky-sebelum-update-…). Migrasi skema berjalan sendiri
    saat panel menyala lagi.
  • Tidak dijalankan selagi ada perintah ONU yang sedang berjalan (diperiksa server.py):
    menyalakan ulang panel memutus permintaan yang sedang menunggu jawaban ONU.

Yang TIDAK dijamin modul ini: isi pembaruan itu sendiri. Siapa pun yang bisa menulis ke
repositori GitHub-nya menentukan kode yang berjalan di server — jaga akun GitHub itu
(2FA) seperti menjaga servernya.

`data/` (basis data, sertifikat, cadangan) diabaikan git, jadi tidak tersentuh pembaruan.
"""

import os
import re
import shutil
import subprocess
import sys
import threading
import time

AKAR          = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BERKAS_VERSI  = 'VERSION'
REMOTE        = 'origin'
BATAS_FETCH   = 60        # detik — GitHub yang lambat tidak boleh menggantung panel
MAKS_PERUBAHAN = 20       # judul commit yang ditampilkan

_RE_VERSI = re.compile(r'^\d+\.\d+\.\d+$')


class PembaruanError(Exception):
    """Pesan yang aman ditampilkan kepada administrator."""


def _versi_rapi(teks):
    teks = (teks or '').strip()
    return teks if _RE_VERSI.match(teks) else None


def versi():
    """Versi panel yang terpasang, dari berkas VERSION di akar proyek."""
    try:
        with open(os.path.join(AKAR, BERKAS_VERSI), encoding='utf-8') as f:
            return _versi_rapi(f.read()) or '0.0.0'
    except OSError:
        return '0.0.0'


def _git(*arg, timeout=20):
    """Jalankan git di akar proyek. → (kode, stdout, stderr). Tidak pernah melempar.

    GIT_TERMINAL_PROMPT=0: git tidak boleh berhenti menunggu username/password (repositori
    yang dijadikan privat) — tanpa itu permintaan menggantung sampai batas waktu."""
    git = shutil.which('git')
    if not git:
        return 127, '', 'git tidak terpasang'
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', LC_ALL='C', LANG='C')
    try:
        p = subprocess.run([git] + list(arg), cwd=AKAR, capture_output=True, timeout=timeout,
                           env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return 124, '', 'git tidak menjawab dalam %d detik' % timeout
    except OSError as e:
        return 126, '', type(e).__name__
    return (p.returncode, p.stdout.decode('utf-8', 'replace').strip(),
            p.stderr.decode('utf-8', 'replace').strip())


def _tanpa_rahasia(url):
    """'https://user:token@github.com/x/y.git' → 'https://github.com/x/y.git'."""
    return re.sub(r'(?<=://)[^/@]*@', '', url or '')


def keadaan():
    """Keadaan pemasangan TANPA menghubungi jaringan."""
    k = {'versi': versi(), 'bisa': False, 'alasan': '', 'commit': '', 'cabang': '',
         'sumber': '', 'bersih': True}
    if not shutil.which('git'):
        k['alasan'] = 'Program git tidak terpasang di server ini (Ubuntu: sudo apt install git).'
        return k
    kode, atas, galat = _git('rev-parse', '--show-toplevel')
    if kode != 0:
        # "dubious ownership": folder panel dimiliki akun lain daripada yang menjalankan panel.
        k['alasan'] = ('Folder panel dimiliki akun lain daripada yang menjalankan panel; git menolaknya. '
                       'Samakan pemiliknya (lihat README bagian Memasang).' if 'dubious' in galat
                       else 'Panel ini tidak dipasang lewat git clone, jadi tidak bisa diperbarui dari sini.')
        return k
    if os.path.normcase(os.path.realpath(atas)) != os.path.normcase(os.path.realpath(AKAR)):
        k['alasan'] = 'Folder panel berada di dalam repositori git lain; pembaruan otomatis dimatikan.'
        return k
    k['commit'] = _git('rev-parse', '--short', 'HEAD')[1]
    k['cabang'] = _git('rev-parse', '--abbrev-ref', 'HEAD')[1]
    kode, url, _ = _git('remote', 'get-url', REMOTE)
    k['sumber'] = _tanpa_rahasia(url) if kode == 0 else ''
    # Hanya berkas yang DILACAK git: data/ dan berkas baru buatan server tidak dihitung.
    k['bersih'] = _git('status', '--porcelain', '--untracked-files=no')[1] == ''
    if not k['commit'] or k['cabang'] in ('', 'HEAD'):
        k['alasan'] = 'Panel tidak berada di sebuah cabang git (detached HEAD); perbarui secara manual.'
    elif not k['sumber']:
        k['alasan'] = 'Repositori di server ini tidak punya remote "origin".'
    else:
        k['bisa'] = True
    return k


def periksa():
    """Tanyakan ke GitHub apakah ada versi baru (git fetch — tidak mengubah berkas panel)."""
    k = keadaan()
    if not k['bisa']:
        raise PembaruanError(k['alasan'])
    kode, _, galat = _git('fetch', '--quiet', REMOTE, k['cabang'], timeout=BATAS_FETCH)
    if kode != 0:
        raise PembaruanError('Tidak bisa mengambil kabar dari GitHub: ' + (galat.splitlines() or ['?'])[-1][:200])
    sasaran = '%s/%s' % (REMOTE, k['cabang'])

    def _hitung(rentang):
        kode, keluar, _ = _git('rev-list', '--count', rentang)
        return int(keluar) if kode == 0 and keluar.isdigit() else 0

    k['tertinggal'] = _hitung('HEAD..' + sasaran)       # commit di GitHub yang belum terpasang
    k['mendahului'] = _hitung(sasaran + '..HEAD')       # commit di server yang tak ada di GitHub
    k['commitBaru'] = _git('rev-parse', '--short', sasaran)[1]
    k['versiBaru']  = _versi_rapi(_git('show', '%s:%s' % (sasaran, BERKAS_VERSI))[1]) or k['versi']
    kode, keluar, _ = _git('log', '--format=%s', '-n', str(MAKS_PERUBAHAN), 'HEAD..' + sasaran)
    k['perubahan']  = [b[:160] for b in keluar.splitlines() if b.strip()] if kode == 0 else []
    k['tersedia']   = k['tertinggal'] > 0
    return k


def pasang(sebelum=None):
    """Terapkan pembaruan (fast-forward ke origin/<cabang>). → dict hasil.

    `sebelum` dipanggil tepat sebelum berkas diubah (server.py: cadangkan basis data).
    Panel BELUM dinyalakan ulang di sini — itu tugas pemanggil (mulai_ulang)."""
    p = periksa()
    hasil = {'dari': p['commit'], 'ke': p['commit'], 'versiDari': p['versi'], 'versiKe': p['versi'],
             'berubah': False}
    if not p['tersedia']:
        return hasil
    if not p['bersih']:
        raise PembaruanError('Ada berkas panel yang diubah langsung di server ini. Pembaruan dibatalkan '
                             'supaya perubahan itu tidak tertimpa — periksa dengan "git status".')
    if p['mendahului']:
        raise PembaruanError('Server ini punya %d commit yang tidak ada di GitHub (riwayat bercabang). '
                             'Pembaruan otomatis hanya bisa maju lurus; selesaikan secara manual.' % p['mendahului'])
    if sebelum:
        sebelum()
    kode, _, galat = _git('merge', '--ff-only', '%s/%s' % (REMOTE, p['cabang']), timeout=120)
    if kode != 0:
        raise PembaruanError('git gagal menerapkan pembaruan: ' + (galat.splitlines() or ['?'])[-1][:200])
    hasil.update(ke=_git('rev-parse', '--short', 'HEAD')[1], versiKe=versi(), berubah=True)
    return hasil


def mulai_ulang(tunda=1.5, argumen=None):
    """Ganti proses panel dengan yang baru supaya kode hasil pembaruan terbaca.

    Ditunda sebentar agar jawaban HTTP untuk tombol Update sempat terkirim. Di Linux
    proses DIGANTI di tempat (exec): nomor prosesnya tetap, jadi systemd tidak melihat
    layanannya mati. Di Windows exec tidak mengutip argumen ber-spasi dengan benar, jadi
    proses baru dijalankan lalu yang lama keluar. Bila keduanya gagal, proses keluar dengan
    kode 3 dan systemd (Restart=always) yang menyalakannya lagi."""
    perintah = [sys.executable, os.path.join(AKAR, 'server.py')] + list(sys.argv[1:] if argumen is None else argumen)

    def _jalan():
        time.sleep(tunda)
        try:
            if os.name == 'nt':
                subprocess.Popen(perintah, cwd=AKAR)
                os._exit(0)
            os.execv(sys.executable, perintah)
        except Exception:
            os._exit(3)

    t = threading.Thread(target=_jalan, name='mulai-ulang', daemon=True)
    t.start()
    return t
