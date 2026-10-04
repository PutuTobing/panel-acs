"""Cadangan basis data panel (2026-10-03).

Basis data akun, pengaturan, tag dan Log hidup di SATU berkas (data/sky.db) yang sengaja
tidak ikut repositori. Berkasnya bertahan saat server dimatikan/dinyalakan — yang belum
ada adalah jalan pulang bila disk rusak, berkas terhapus, atau pembaruan berakibat buruk.
Modul ini memberi dua hal:

  1. CADANGAN OTOMATIS harian di data/backup/sky-otomatis-<tanggal>-<jam>.db, disimpan
     SIMPAN (14) terakhir. Dibuat lewat API backup SQLite (aman selagi panel dipakai),
     berizin 0600 di folder 0700.
  2. UNDUHAN TERENKRIPSI untuk disimpan di luar server: AES-256-CBC, kunci diturunkan
     dari kata sandi dengan PBKDF2-SHA256 (ITER_PBKDF2 putaran), dikerjakan program
     `openssl` — format baku yang bisa dibuka di komputer mana pun dengan satu perintah
     (lihat DATABASE.md). Kata sandinya diketik administrator saat mengunduh dan TIDAK
     disimpan di mana pun: server yang dibobol tidak ikut membuka cadangan lama.

KENAPA BUKAN MENGENKRIPSI sky.db DI TEMPAT: kunci untuk membukanya harus ada di disk yang
sama agar panel bisa menyala sendiri sesudah listrik padam — siapa pun yang bisa membaca
berkasnya juga bisa membaca kuncinya (alasan yang sama dengan catatan kredensial NBI di
config_store.py). Yang benar-benar melindungi berkas di server adalah izin 0600 dan
enkripsi disk milik sistem operasi; yang melindungi salinan yang KELUAR dari server
adalah enkripsi ber-kata-sandi di sini. Password akun sendiri tidak pernah tersimpan —
hanya hash scrypt-nya.

RUANG DISK (keputusan 2026-10-04) — panel berjalan bertahun-tahun di VM berdisk kecil:
  • cadangan harian DIMAMPATKAN (gzip, ±1/5 ukuran aslinya) dan jumlahnya tetap (14 + 5
    "sebelum-update"), jadi ruang yang dipakai cadangan terbatas ±4× ukuran basis data;
  • cadangan DILEWATI bila ruang disk tersisa kurang dari yang dibutuhkannya (dan itu
    dilaporkan di Settings) — cadangan tidak boleh menjadi penyebab disk penuh;
  • catatan Log yang lebih tua dari "Simpan Log" (Parameter Aplikasi, bawaan 365 hari,
    0 = selamanya) dipangkas sekali sehari — tanpa itu basis data tumbuh tanpa batas;
  • sesi login yang kedaluwarsa dibuang sekali sehari (dulu hanya saat panel dinyalakan).

Setiap salinan DIBERSIHKAN dari tabel `sessions`: token sesi tersimpan apa adanya, dan
cadangan yang bocor tidak boleh menjadi kunci masuk. Memulihkan cadangan = semua orang
login ulang.
"""

import gzip
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time

import db

SIMPAN        = 14          # cadangan otomatis yang dipertahankan
SIMPAN_UPDATE = 5           # cadangan "sebelum-update" yang dipertahankan
JEDA_DETIK    = 24 * 3600   # satu cadangan otomatis per hari
PERIKSA_DETIK = 1800        # seberapa sering penjaga memeriksa
ITER_PBKDF2   = 600000
SANDI_MIN     = 10
SANDI_MAKS    = 128

RUANG_MIN_MB  = 200         # di bawah ini cadangan dilewati, berapa pun ukuran basis datanya
# .db.gz = bentuk sekarang (dimampatkan); .db = cadangan dari sebelum 2026-10-04 — masih
# dikenali supaya ikut dihitung dan dipangkas.
_RE_NAMA  = re.compile(r'^sky-(otomatis|sebelum-update)-(\d{8}-\d{6})\.db(\.gz)?$')
_RE_SANDI = re.compile(r'^[\x20-\x7e]+$')      # ASCII tercetak: sama di Windows & Linux

galat_terakhir = ''         # pesan kegagalan cadangan otomatis terakhir ('' = baik)


class CadanganError(Exception):
    """Pesan yang aman ditampilkan kepada administrator."""


def folder():
    return os.path.join(os.path.dirname(db.DB_PATH) or '.', 'backup')


def _izin(path, mode):
    """chmod tanpa pernah melempar — di Windows ini memang tidak berarti apa-apa."""
    try:
        os.chmod(path, mode)
    except Exception:
        pass


def amankan_folder():
    """Folder data & cadangan hanya untuk akun yang menjalankan panel (0700).

    Dipanggil saat panel dinyalakan (server.py), bukan saat modul diimpor: uji yang
    menunjuk basis data ke folder lain tidak boleh mengubah izin folder itu."""
    _izin(os.path.dirname(db.DB_PATH) or '.', 0o700)
    os.makedirs(folder(), exist_ok=True)
    _izin(folder(), 0o700)


def _salin(tujuan):
    """Salinan konsisten sky.db ke `tujuan`, TANPA sesi login, satu berkas utuh."""
    target = sqlite3.connect(tujuan)
    try:
        db.conn().backup(target)
        # Salinan mewarisi mode WAL; kembalikan ke satu berkas supaya tidak ada
        # '-wal'/'-shm' yang tertinggal di samping cadangan.
        target.execute('PRAGMA journal_mode=DELETE')
        target.execute('PRAGMA secure_delete=ON')
        target.execute('DELETE FROM sessions')
        target.commit()
        target.execute('VACUUM')        # token yang dihapus tidak tersisa di halaman kosong
    finally:
        target.close()
    _izin(tujuan, 0o600)


def ruang():
    """(bebas, total) disk tempat cadangan disimpan, dalam byte. (None, None) bila tak terbaca."""
    try:
        u = shutil.disk_usage(folder() if os.path.isdir(folder()) else (os.path.dirname(db.DB_PATH) or '.'))
        return u.free, u.total
    except OSError:
        return None, None


def ukuran_db():
    """Ruang yang dipakai basis data di disk: sky.db + sky.db-wal.

    Dalam mode WAL tulisan terbaru hidup di berkas '-wal' sampai dipindahkan ke berkas
    utama; menghitung sky.db saja melaporkan "4 KB" untuk basis data yang sebenarnya
    ratusan KB (terlihat di kartu Tentang Sistem, 2026-10-04)."""
    total = 0
    for p in (db.DB_PATH, db.DB_PATH + '-wal'):
        try:
            total += os.path.getsize(p)
        except OSError:
            pass
    return total


def _cukup_ruang():
    """Melempar CadanganError bila disk terlalu penuh untuk satu cadangan lagi.

    Yang dibutuhkan: salinan polos sementara (= ukuran basis data) + hasil mampatnya.
    Batasnya 2× ukuran basis data, minimal RUANG_MIN_MB."""
    bebas, _ = ruang()
    if bebas is None:
        return
    butuh = max(RUANG_MIN_MB * 1024 * 1024, 2 * ukuran_db())
    if bebas < butuh:
        raise CadanganError('ruang disk tersisa %d MB, kurang dari %d MB yang dibutuhkan — cadangan dilewati'
                            % (bebas // 1048576, butuh // 1048576))


def buat(jenis='otomatis'):
    """Tulis satu cadangan (dimampatkan gzip) ke folder cadangan. → path berkasnya."""
    os.makedirs(folder(), exist_ok=True)
    _izin(folder(), 0o700)
    _cukup_ruang()
    tujuan = os.path.join(folder(), 'sky-%s-%s.db.gz' % (jenis, time.strftime('%Y%m%d-%H%M%S')))
    # Tulis ke nama sementara dulu: cadangan yang terputus di tengah (disk penuh, listrik
    # padam) tidak boleh tampak seperti cadangan yang sah.
    polos, sementara = tujuan + '.polos.tmp', tujuan + '.tmp'
    try:
        _salin(polos)
        with open(polos, 'rb') as asal, gzip.open(sementara, 'wb', compresslevel=6) as hasil:
            shutil.copyfileobj(asal, hasil, 1024 * 1024)
        _izin(sementara, 0o600)
        os.replace(sementara, tujuan)
    finally:
        for sisa in (polos, sementara):
            if os.path.exists(sisa):
                try:
                    os.remove(sisa)
                except Exception:
                    pass
    return tujuan


def daftar(jenis='otomatis'):
    """Cadangan yang ada, terbaru lebih dulu: [{nama, ukuran, waktu}]."""
    hasil = []
    try:
        isi = os.listdir(folder())
    except OSError:
        return hasil
    for nama in isi:
        m = _RE_NAMA.match(nama)
        if not m or m.group(1) != jenis:
            continue
        try:
            ukuran = os.path.getsize(os.path.join(folder(), nama))
        except OSError:
            continue
        t = m.group(2)
        hasil.append({'nama': nama, 'ukuran': ukuran,
                      'waktu': '%s-%s-%sT%s:%s:%s' % (t[0:4], t[4:6], t[6:8], t[9:11], t[11:13], t[13:15])})
    hasil.sort(key=lambda x: x['nama'], reverse=True)
    return hasil


def pangkas(jenis='otomatis', simpan=SIMPAN):
    """Hapus cadangan `jenis` yang paling lama sampai tersisa `simpan`. → jumlah terhapus.

    Hanya berkas yang namanya cocok pola cadangan modul ini — berkas lain di folder itu
    (cadangan JSON Kesehatan ACS, salinan manual) tidak pernah disentuh."""
    terhapus = 0
    for b in daftar(jenis)[max(0, int(simpan)):]:
        try:
            os.remove(os.path.join(folder(), b['nama']))
            terhapus += 1
        except OSError:
            pass
    return terhapus


def perlu_otomatis(sekarang=None):
    """True bila belum ada cadangan otomatis atau yang terbaru sudah berumur ≥ JEDA_DETIK.

    Umur dibaca dari NAMA berkas, bukan mtime: mtime berubah saat berkas disalin."""
    ada = daftar('otomatis')
    if not ada:
        return True
    try:
        terakhir = time.mktime(time.strptime(ada[0]['waktu'], '%Y-%m-%dT%H:%M:%S'))
    except ValueError:
        return True
    return (sekarang if sekarang is not None else time.time()) - terakhir >= JEDA_DETIK


def rawat():
    """Perawatan harian basis data, dijalankan SESUDAH cadangan hari itu dibuat (jadi yang
    dipangkas masih ada di cadangan terakhir). Tidak pernah melempar."""
    try:
        import config_store
        hari = int(config_store.params_get().get('logSimpanHari') or 0)
        if hari > 0:
            n = db.audit_pangkas(hari)
            if n:
                db.audit('log.pangkas', '%d catatan Log yang lebih tua dari %d hari dihapus' % (n, hari))
    except Exception:
        pass
    try:
        import auth
        auth.purge_expired_sessions()
    except Exception:
        pass


def jalankan_bila_perlu(sekarang=None):
    """Satu putaran penjaga: cadangkan bila sudah waktunya, pangkas, lalu rawat. → path | None."""
    global galat_terakhir
    if not perlu_otomatis(sekarang):
        return None
    try:
        tujuan = buat('otomatis')
        pangkas('otomatis', SIMPAN)
        galat_terakhir = ''
        db.audit('cadangan.otomatis', os.path.basename(tujuan))
    except CadanganError as e:
        galat_terakhir = str(e)
        return None
    except Exception as e:
        galat_terakhir = '%s: %s' % (type(e).__name__, e)
        return None
    rawat()
    return tujuan


_thread = None


def mulai_penjaga():
    """Thread latar: cadangan pertama begitu panel menyala (bila yang terakhir sudah
    lebih dari sehari), lalu diperiksa tiap PERIKSA_DETIK. Dimulai dari server.py —
    uji yang mengimpor modul ini tidak ikut menulis cadangan."""
    global _thread
    if _thread is not None:
        return _thread

    def _loop():
        while True:
            jalankan_bila_perlu()
            time.sleep(PERIKSA_DETIK)

    _thread = threading.Thread(target=_loop, name='penjaga-cadangan', daemon=True)
    _thread.start()
    return _thread


# ═══════════════════════════════════════════════════════════════
#  Unduhan terenkripsi
# ═══════════════════════════════════════════════════════════════
def cari_openssl():
    calon = [shutil.which('openssl'),
             r'C:\Program Files\Git\usr\bin\openssl.exe',
             r'C:\Program Files\Git\mingw64\bin\openssl.exe',
             r'C:\Program Files (x86)\Git\usr\bin\openssl.exe']
    for c in calon:
        if c and os.path.isfile(c):
            return c
    return None


def sandi_bermasalah(sandi):
    """Alasan kata sandi cadangan ditolak, atau None bila boleh."""
    if not isinstance(sandi, str) or len(sandi) < SANDI_MIN:
        return 'Kata sandi cadangan minimal %d karakter' % SANDI_MIN
    if len(sandi) > SANDI_MAKS:
        return 'Kata sandi cadangan maksimal %d karakter' % SANDI_MAKS
    if not _RE_SANDI.match(sandi):
        return 'Kata sandi cadangan hanya boleh huruf, angka, spasi dan simbol biasa (ASCII)'
    if sandi != sandi.strip():
        return 'Kata sandi cadangan tidak boleh diawali atau diakhiri spasi'
    return None


def perintah_buka(nama):
    """Perintah untuk membuka berkas terenkripsi — ditampilkan di panel & DATABASE.md."""
    return ('openssl enc -d -aes-256-cbc -pbkdf2 -iter %d -md sha256 -in %s -out sky.db'
            % (ITER_PBKDF2, nama))


def unduh_terenkripsi(sandi, openssl=None):
    """Cadangan segar, terenkripsi dengan `sandi`. → (nama berkas, isi bytes).

    Kata sandi diberikan ke openssl lewat STDIN — bukan argumen (terlihat di daftar
    proses) dan bukan variabel lingkungan (diwarisi anak proses). Berkas polos sementara
    ditulis di folder cadangan (0700) dan selalu dihapus, berhasil ataupun gagal."""
    masalah = sandi_bermasalah(sandi)
    if masalah:
        raise CadanganError(masalah)
    openssl = openssl or cari_openssl()
    if not openssl:
        raise CadanganError('Program openssl tidak ditemukan di server ini, jadi cadangan tidak bisa '
                            'dienkripsi. Di Ubuntu: sudo apt install openssl')
    os.makedirs(folder(), exist_ok=True)
    _izin(folder(), 0o700)
    kerja = tempfile.mkdtemp(prefix='unduh-', dir=folder())
    try:
        polos, sandi_out = os.path.join(kerja, 'sky.db'), os.path.join(kerja, 'sky.db.enc')
        _salin(polos)
        try:
            p = subprocess.run(
                [openssl, 'enc', '-aes-256-cbc', '-pbkdf2', '-iter', str(ITER_PBKDF2), '-md', 'sha256',
                 '-salt', '-in', polos, '-out', sandi_out, '-pass', 'stdin'],
                input=(sandi + '\n').encode('ascii'), capture_output=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise CadanganError('openssl gagal dijalankan: %s' % type(e).__name__)
        if p.returncode != 0 or not os.path.isfile(sandi_out):
            # stderr openssl tidak memuat kata sandi; dipotong supaya pesannya tetap ringkas.
            raise CadanganError('openssl gagal mengenkripsi: '
                                + (p.stderr or b'').decode('utf-8', 'replace').strip()[:200])
        with open(sandi_out, 'rb') as f:
            isi = f.read()
        if not isi.startswith(b'Salted__'):
            raise CadanganError('Hasil enkripsi tidak dikenali')
        return 'sky-cadangan-%s.db.enc' % time.strftime('%Y%m%d-%H%M%S'), isi
    finally:
        shutil.rmtree(kerja, ignore_errors=True)


def ringkasan():
    """Keadaan cadangan untuk kartu "Cadangan Data" di Settings → Tentang Sistem."""
    ada = daftar('otomatis')
    bebas, total_disk = ruang()
    c = db.conn()
    log = c.execute('SELECT COUNT(*) AS n, MIN(created_at) AS tertua FROM audit_log').fetchone()
    return {
        # Ruang: basis data, seluruh cadangan (otomatis + sebelum-update), dan sisa disk.
        'dbUkuran': ukuran_db(),
        'cadanganUkuran': sum(b['ukuran'] for b in ada) + sum(b['ukuran'] for b in daftar('sebelum-update')),
        'diskBebas': bebas, 'diskTotal': total_disk,
        'logBaris': log['n'], 'logTertua': log['tertua'] or '',
        'otomatis': ada,
        'simpan': SIMPAN,
        'enkripsi': bool(cari_openssl()),
        'sandiMin': SANDI_MIN,
        'galat': galat_terakhir,
        'total': sum(b['ukuran'] for b in ada),
        'perintahBuka': perintah_buka('<berkas>'),
    }
