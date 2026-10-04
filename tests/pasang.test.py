#!/usr/bin/env python3
"""Uji skrip pemasang tools/pasang.sh (2026-10-03, port otomatis 2026-10-04).

Skrip itu dijalankan sebagai ROOT di server orang, sering lewat `curl … | sudo bash`,
jadi yang dijaga adalah sifat-sifat yang tidak boleh hilang saat ia disunting:

  • berhenti pada galat pertama (set -euo pipefail), akhir baris LF;
  • panel tidak dijalankan sebagai root; data/ hanya untuk akun panel (0700);
  • tidak pernah menghapus atau menimpa data yang sudah ada;
  • pembaruan ulang hanya maju lurus (--ff-only);
  • PORT: 8081, atau port kosong berikutnya bila terpakai — dan sekali terpilih TIDAK
    berubah lagi (tersimpan di /etc/default/panel-acs);
  • berkas pengaturan tidak pernah ditimpa; hanya kunci yang diminta yang diubah.

Skrip utuhnya TIDAK dijalankan di sini (butuh Ubuntu + root). Yang dijalankan sungguhan
(bila bash ada) adalah fungsi pemilih port dan penulis berkas pengaturan, dengan
pemeriksa port tiruan dan berkas sementara.
"""
import os, re, shutil, subprocess, sys, tempfile

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
    print('  (bash tidak ada — pemeriksaan sintaks & fungsi port dilewati)')

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
ok(re.search(r'case "\$PORT_DIMINTA" in \*\[!0-9\]\*\)', kode) and 'case "$SKY_DIR" in /*)' in kode,
   'nilai SKY_PORT / SKY_DIR diperiksa sebelum dipakai')
ok('ProtectHome=true' in kode and 'case "$SKY_DIR" in /home|/home/*|/root|/root/*) gagal' in kode,
   'SKY_DIR di /home atau /root ditolak — layanan dikunci dari folder itu (ProtectHome), panel tak akan bisa menyala')
# Port & mode proxy hidup di berkas pengaturan; unit tidak memuat nomor port, jadi menulis
# ulang unit (pemasangan ulang, pembaruan) tidak pernah mengubah port.
ok('EnvironmentFile=-$BERKAS_ENV' in kode and re.search(r'ExecStart=/usr/bin/python3 "\$SKY_DIR/server\.py"\n', kode)
   and 'BERKAS_ENV="/etc/default/${LAYANAN}"' in kode, 'layanan membaca port dari /etc/default/panel-acs (ExecStart tanpa nomor port)')
ok('if [ ! -f "$BERKAS_ENV" ]; then' in kode, 'berkas pengaturan hanya dibuat bila BELUM ada (tidak pernah ditimpa)')
ok('s.bind(("0.0.0.0", int(sys.argv[1])))' in kode, 'port diuji dengan benar-benar mencoba memakainya (bukan menebak dari daftar proses)')
# Jalur dari variabel selalu berada DI DALAM tanda kutip ganda (folder ber-spasi tidak boleh
# terpecah menjadi dua argumen). Isi berkas unit systemd (heredoc) bukan perintah shell.
luar_heredoc = re.sub(r"<<'?EOF'?\n.*?\nEOF\n", '\n', kode, flags=re.S)
tanpa_kutip = [b.strip() for b in luar_heredoc.splitlines()
               for m in re.finditer(r'\$\{?(SKY_DIR|SKY_DATA_DARI|UNIT|BERKAS_ENV)\b', b)
               # di dalam "…" = jumlah kutip sebelumnya ganjil, atau tepat diawali kutip
               # (kutip bersarang di dalam "$( … )").
               if b[:m.start()].count('"') % 2 == 0 and not b[:m.start()].endswith('"')
               and not re.match(r'\s*(SKY_\w+|UNIT|BERKAS_ENV)=', b)]
ok(not tanpa_kutip, 'jalur dari variabel selalu dikutip — %r' % tanpa_kutip[:2])
readme = open(os.path.join(ROOT, 'README.md'), encoding='utf-8').read()
ok('raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo bash' in readme
   and 'raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo bash' in s,
   'perintah satu baris di README sama dengan yang tertulis di skrip')
ok('SETUP_CODE.txt' in kode, 'kode instalasi ditampilkan di akhir pemasangan')

# ══ Fungsi port & berkas pengaturan — dijalankan sungguhan ══
def fungsi(nama):
    m = re.search(r'^' + nama + r'\(\) \{.*?^\}', s, re.M | re.S)
    assert m, nama
    return m.group(0)
buat_env = re.search(r'^if \[ ! -f "\$BERKAS_ENV" \]; then\n.*?^fi$', s, re.M | re.S)
ok(bool(buat_env), 'blok pembuat berkas pengaturan ditemukan')

if bash and buat_env:
    TMP = tempfile.mkdtemp(prefix='skypasang-')
    kerangka = os.path.join(TMP, 'uji.sh')
    with open(kerangka, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join([
            'set -euo pipefail',
            'BERKAS_ENV="$1"; PORT_AWAL=8081; PORT_AKHIR=8084',
            'info() { printf "[info] %s\\n" "$*" >&2; }',
            'gagal() { printf "[gagal] %s\\n" "$*" >&2; exit 1; }',
            fungsi('baca_env'), fungsi('setel_env'), fungsi('pilih_port'),
            # pemeriksa port tiruan: port di $TERPAKAI dianggap dipakai program lain
            'port_terpakai() { case " ${TERPAKAI:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }',
            'PORT_DIMINTA="${SKY_PORT:-}"',
            'PORT_TERSIMPAN="$(baca_env SKY_PORT)"',
            'case "$PORT_TERSIMPAN" in \'\'|*[!0-9]*) PORT_TERSIMPAN="" ;; esac',
            'LAYANAN_HIDUP="${HIDUP:-0}"',
            'PORT="$(pilih_port)"',
            'if [ "${SIMPAN:-0}" = 1 ]; then',
            buat_env.group(0),
            'setel_env SKY_PORT "$PORT"',
            'for kunci in SKY_HOST SKY_PROXY SKY_HTTPS SKY_ORIGIN; do',
            '  nilai="$(printenv "$kunci" || true)"',
            '  if [ -n "$nilai" ]; then setel_env "$kunci" "$nilai"; fi',
            'done',
            'fi',
            'echo "PORT=$PORT"', '']))

    def jalan(env_file, **env):
        lingkungan = {k: v for k, v in os.environ.items() if not k.startswith('SKY_')}
        lingkungan.update({k: str(v) for k, v in env.items()})
        r = subprocess.run([bash, kerangka.replace('\\', '/'), env_file.replace('\\', '/')], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', env=lingkungan)
        m = re.search(r'^PORT=(\d+)$', r.stdout, re.M)
        return r.returncode, (int(m.group(1)) if m else None), r.stderr
    def baris_aktif(env_file):
        return [b for b in open(env_file, encoding='utf-8').read().splitlines() if b and not b.startswith('#')]

    E = os.path.join(TMP, 'panel-acs.env')
    rc, port, err = jalan(E)
    ok((rc, port) == (0, 8081) and 'terpakai' not in err, 'server kosong → port 8081')
    rc, port, err = jalan(E, TERPAKAI='8081')
    ok((rc, port) == (0, 8082) and 'port 8081 sudah dipakai' in err and 'tidak akan berubah lagi' in err,
       'port 8081 dipakai program lain → 8082, dengan pemberitahuan — %r' % err.strip()[-90:])
    rc, port, err = jalan(E, TERPAKAI='8081 8082')
    ok((rc, port) == (0, 8083), '8081 & 8082 terpakai → 8083')
    rc, port, err = jalan(E, TERPAKAI='8081 8082 8083 8084')
    ok(rc != 0 and port is None and 'tidak ada port kosong' in err, 'semua port dalam rentang terpakai → berhenti dengan penjelasan (bukan memasang di port sembarang)')
    ok(not os.path.exists(E), 'sejauh ini belum ada berkas pengaturan yang ditulis')

    # Port yang terpilih DISIMPAN dan tidak berubah lagi.
    rc, port, err = jalan(E, TERPAKAI='8081', SIMPAN=1)
    ok((rc, port) == (0, 8082) and baris_aktif(E) == ['SKY_PORT=8082'], 'pemasangan pertama (8081 terpakai) menyimpan SKY_PORT=8082 — %r' % baris_aktif(E))
    rc, port, err = jalan(E, HIDUP=1, SIMPAN=1)
    ok((rc, port) == (0, 8082) and 'sudah tersimpan: 8082' in err and baris_aktif(E) == ['SKY_PORT=8082'],
       'dijalankan ulang saat 8081 SUDAH kosong → tetap 8082 (port tidak berubah)')
    rc, port, err = jalan(E, HIDUP=1, TERPAKAI='8082', SIMPAN=1)
    ok((rc, port) == (0, 8082), 'port yang dipakai layanan panel sendiri tidak dianggap "terpakai program lain"')
    rc, port, err = jalan(E, HIDUP=0, TERPAKAI='8082')
    ok(rc != 0 and 'kini dipakai program lain' in err, 'port tersimpan direbut program lain saat panel mati → berhenti dengan penjelasan, port TIDAK diganti diam-diam')

    # SKY_PORT eksplisit
    rc, port, err = jalan(E, HIDUP=1, SKY_PORT=8090, SIMPAN=1)
    ok((rc, port) == (0, 8090) and baris_aktif(E) == ['SKY_PORT=8090'], 'SKY_PORT eksplisit memindahkan port dan menyimpannya')
    rc, port, err = jalan(E, HIDUP=1, SKY_PORT=8091, TERPAKAI='8091')
    ok(rc != 0 and 'sudah dipakai program lain' in err, 'SKY_PORT eksplisit yang terpakai → ditolak (tidak diam-diam memilih port lain)')

    # Berkas pengaturan: kunci yang diminta saja yang berubah; suntingan tangan dipertahankan.
    isi = open(E, encoding='utf-8').read()
    ok('#SKY_HOST=127.0.0.1' in isi and '#SKY_PROXY=1' in isi and '#SKY_HTTPS=1' in isi, 'berkas bawaan memuat pilihan mode proxy sebagai komentar')
    with open(E, 'a', encoding='utf-8', newline='\n') as f:
        f.write('SKY_CATATAN=disunting-tangan\n')
    rc, port, err = jalan(E, HIDUP=1, SIMPAN=1, SKY_HOST='127.0.0.1', SKY_PROXY=1)
    ok(rc == 0 and port == 8090 and baris_aktif(E) == ['SKY_PORT=8090', 'SKY_HOST=127.0.0.1', 'SKY_PROXY=1', 'SKY_CATATAN=disunting-tangan'],
       'SKY_HOST/SKY_PROXY dari perintah pemasang mengaktifkan barisnya; port & suntingan tangan utuh — %r' % baris_aktif(E))
    rc, port, err = jalan(E, HIDUP=1, SIMPAN=1)
    ok(baris_aktif(E) == ['SKY_PORT=8090', 'SKY_HOST=127.0.0.1', 'SKY_PROXY=1', 'SKY_CATATAN=disunting-tangan'],
       'dijalankan ulang tanpa variabel → pengaturan mode proxy tidak hilang')
    rc, port, err = jalan(E, HIDUP=1, SIMPAN=1, SKY_ORIGIN='https://panel.contoh.id; rm -rf /')
    ok(rc != 0 and 'karakter yang tidak diizinkan' in err and 'rm -rf' not in open(E, encoding='utf-8').read(),
       'nilai berisi karakter aneh ditolak, tidak ditulis ke berkas pengaturan')
    shutil.rmtree(TMP, ignore_errors=True)

# ══ Repositori privat: token hanya-baca (2026-10-04) ══
# Token tidak boleh sampai ke tempat yang bisa dilihat orang: alamat remote ("git remote -v",
# kartu Pembaruan), argumen perintah git (daftar proses), atau keluaran skrip.
baris_token = [b.strip() for b in kode.splitlines() if 'SKY_TOKEN' in b]
ok(baris_token and all(not re.search(r'\bgit\b', b) and '$SKY_REPO' not in b.replace('case "$SKY_REPO"', '') for b in baris_token
                       if 'PETUNJUK_PRIVAT=' not in b),
   'token tidak pernah dipakai dalam perintah git maupun alamat repositori — %r' % [b[:60] for b in baris_token][:3])
ok(re.search(r'printf \'https://x-access-token:%s@%s\\n\' "\$SKY_TOKEN" "\$HOST_REPO" > "\$KRED"', kode)
   and 'umask 077' in kode and 'chmod 600 "$KRED"' in kode and 'install -d -m 700 -o "$SKY_USER" -g "$SKY_USER" "$KRED_DIR"' in kode,
   'token ditulis ke berkas 0600 di folder 0700 milik akun panel')
ok('KRED_DIR="/var/lib/${LAYANAN}"' in kode, 'berkas token di luar folder panel (tidak tersaji ke browser, tidak tampak di git status)')
ok(kode.count('GIT_TERMINAL_PROMPT=0 sebagai git') == 3,
   'git tidak pernah berhenti menunggu username/password (repositori privat tanpa token → gagal dengan petunjuk)')
ok('-c "credential.helper=$PEMBANTU_KRED"' in kode and 'config credential.helper "$PEMBANTU_KRED"' in kode,
   'credential helper dipasang saat clone DAN pada panel yang sudah ada (tombol Update memakai token yang sama)')
ok(not re.search(r'(info|echo|gagal)[^\n]*\$SKY_TOKEN', kode), 'token tidak pernah dicetak ke layar')

blok_token = re.search(r'^if \[ -n "\$SKY_TOKEN" \]; then\n  HOST_REPO=.*?^fi$', s, re.M | re.S)
cek_token = re.search(r'^if \[ -n "\$SKY_TOKEN" \]; then\n  case "\$SKY_TOKEN".*?^fi$', s, re.M | re.S)
ok(bool(blok_token) and bool(cek_token), 'blok token ditemukan')
if bash and blok_token and cek_token:
    TMPT = tempfile.mkdtemp(prefix='skytoken-')
    kerangka_t = os.path.join(TMPT, 'uji.sh')
    with open(kerangka_t, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join([
            'set -euo pipefail',
            'SKY_USER=skyacs; SKY_REPO="${REPO:-https://github.com/PutuTobing/panel-acs.git}"',
            'KRED_DIR="$1/kred"; KRED="$KRED_DIR/git-credentials"; SKY_TOKEN="${SKY_TOKEN:-}"',
            'info() { printf "[info] %s\\n" "$*" >&2; }',
            'gagal() { printf "[gagal] %s\\n" "$*" >&2; exit 1; }',
            # akun skyacs tidak ada di mesin uji: install/chown ditirukan, sisanya sungguhan
            'install() { mkdir -p "${@: -1}"; }',
            'chown() { :; }',
            cek_token.group(0), blok_token.group(0), '']))
    def token(**env):
        lingkungan = {k: v for k, v in os.environ.items() if not k.startswith('SKY_')}
        lingkungan.update(env)
        r = subprocess.run([bash, kerangka_t.replace('\\', '/'), TMPT.replace('\\', '/')], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', env=lingkungan)
        p = os.path.join(TMPT, 'kred', 'git-credentials')
        isi = open(p, encoding='utf-8').read() if os.path.exists(p) else None
        return r.returncode, isi, r.stdout + r.stderr
    rc, isi, keluar = token()
    ok(rc == 0 and isi is None, 'tanpa SKY_TOKEN: tidak ada berkas token yang dibuat (repositori publik tidak berubah)')
    rc, isi, keluar = token(SKY_TOKEN='github_pat_11ABCDEFG0_contohTOKEN123')
    ok(rc == 0 and isi == 'https://x-access-token:github_pat_11ABCDEFG0_contohTOKEN123@github.com\n',
       'SKY_TOKEN → satu baris kredensial untuk host repositori — %r' % isi)
    ok('github_pat_11ABCDEFG0' not in keluar, 'token tidak muncul di keluaran pemasang')
    for jahat in ('abc; rm -rf /', 'abc@evil.contoh', 'a b', "abc'$(id)", 'abc\ndef'):
        rc, isi2, keluar = token(SKY_TOKEN=jahat)
        ok(rc != 0 and 'bukan bagian dari token' in keluar, 'token berisi karakter aneh ditolak: %r' % jahat)
    rc, isi2, keluar = token(SKY_TOKEN='ghp_abc', REPO='git@github.com:PutuTobing/panel-acs.git')
    ok(rc != 0 and 'https://' in keluar, 'token dengan alamat repositori non-https ditolak')

    # git sungguhan: -c credential.helper=… saat clone ikut TERSIMPAN di repositori hasilnya.
    git = shutil.which('git')
    if git:
        asal, hasil = os.path.join(TMPT, 'asal'), os.path.join(TMPT, 'hasil')
        g = lambda cwd, *a: subprocess.run([git, '-c', 'user.name=Uji', '-c', 'user.email=uji@contoh.id', '-c', 'commit.gpgsign=false',
                                            '-c', 'protocol.file.allow=always'] + list(a), cwd=cwd, capture_output=True, text=True)
        os.makedirs(asal)
        g(asal, 'init', '-q', '-b', 'main'); open(os.path.join(asal, 'VERSION'), 'w').write('1.2.0\n')
        g(asal, 'add', '-A'); g(asal, 'commit', '-q', '-m', 'awal')
        pembantu = 'store --file=' + os.path.join(TMPT, 'kred', 'git-credentials').replace('\\', '/')
        r = g(TMPT, 'clone', '--quiet', '-c', 'credential.helper=' + pembantu, '--branch', 'main', asal, hasil)
        tersimpan = g(hasil, 'config', '--local', '--get', 'credential.helper').stdout.strip()
        url = g(hasil, 'remote', 'get-url', 'origin').stdout.strip()
        ok(r.returncode == 0 and tersimpan == pembantu, 'clone dengan -c credential.helper: tersimpan di repositori hasil — %r' % tersimpan)
        ok('@' not in url and 'x-access-token' not in url, 'alamat remote hasil clone tidak memuat kredensial')
    shutil.rmtree(TMPT, ignore_errors=True)
ok('Repositori privat' in readme and 'application/vnd.github.raw+json' in readme and 'sudo --preserve-env=SKY_TOKEN bash' in readme
   and 'Contents*: **Read-only**' in readme, 'README menjelaskan pemasangan dari repositori privat (token hanya-baca)')

# ══ Contoh nginx (tools/nginx-panel-acs.conf) ══
# Yang dijaga adalah baris yang bila hilang membuat panel di belakang nginx rusak atau
# melemah diam-diam: Host asli (pagar lintas-situs), alamat pengunjung (Log & pembatas
# login — lihat tests/proxy.test.py), dan batas waktu yang cukup untuk perintah ke ONU.
ng_mentah = open(os.path.join(ROOT, 'tools', 'nginx-panel-acs.conf'), 'rb').read()
ng = '\n'.join(b for b in ng_mentah.decode('utf-8').splitlines() if not b.lstrip().startswith('#'))
def arahan(nama, nilai):
    return re.search(r'^\s*' + re.escape(nama) + r'\s+' + re.escape(nilai) + r';\s*$', ng, re.M) is not None
ok(b'\r' not in ng_mentah and ng.count('{') == ng.count('}') == 2, 'nginx: akhir baris LF, kurung berpasangan (server + location)')
ok(arahan('proxy_pass', 'http://127.0.0.1:8081'), 'nginx: diteruskan ke panel di 127.0.0.1:8081')
ok(arahan('proxy_set_header Host', '$http_host') and arahan('proxy_set_header X-Forwarded-Host', '$http_host'),
   'nginx: Host asli beserta port-nya diteruskan ($http_host — $host membuang port, lalu semua tombol ditolak lintas-situs)')
ok(arahan('proxy_set_header X-Real-IP', '$remote_addr') and arahan('proxy_set_header X-Forwarded-For', '$proxy_add_x_forwarded_for'),
   'nginx: alamat asli pengunjung diteruskan lewat KEDUA header')
m = re.search(r'^\s*proxy_read_timeout\s+(\d+)s;', ng, re.M)
ok(bool(m) and int(m.group(1)) >= 180, 'nginx: batas waktu baca ≥ 180 dtk (perintah ONU ±1 mnt, Update sampai ±3 mnt)')
ok('tools/nginx-panel-acs.conf' in readme and 'sudo SKY_HOST=127.0.0.1 SKY_PROXY=1 bash /opt/panel-acs/tools/pasang.sh' in readme
   and 'sudo SKY_HTTPS=1 bash /opt/panel-acs/tools/pasang.sh' in readme and 'certbot --nginx' in readme,
   'README: langkah nginx menunjuk berkas contoh, mode proxy, dan HTTPS')

# ══ Server membaca SKY_PORT ══
kode_port = ('import os, sys; sys.path.insert(0, %r); sys.argv = %%r; os.environ.update(%%r); '
             'import db, tempfile; db.set_path(os.path.join(tempfile.mkdtemp(), "t.db")); import server; print(server.PORT)'
             % os.path.join(ROOT, 'backend'))
def port_server(argv, env):
    r = subprocess.run([sys.executable, '-c', kode_port % (argv, env)], capture_output=True, text=True,
                       env={k: v for k, v in os.environ.items() if k != 'SKY_PORT'})
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-200:]
ok(port_server(['server.py'], {}) == '8081' and port_server(['server.py'], {'SKY_PORT': '8093'}) == '8093'
   and port_server(['server.py', '8100'], {'SKY_PORT': '8093'}) == '8100' and port_server(['server.py'], {'SKY_PORT': 'abc'}) == '8081',
   'server: argumen > SKY_PORT > 8081; nilai tak sah diabaikan')

print(f'pasang: {_p} lulus, {_f} gagal')
sys.exit(1 if _f else 0)
