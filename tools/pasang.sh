#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Pemasang Panel ACS SKY TECH untuk Ubuntu / Debian (2026-10-03)
#
#  Satu perintah di server (VM) yang baru:
#
#    curl -fsSL https://raw.githubusercontent.com/PutuTobing/panel-acs/main/tools/pasang.sh | sudo bash
#
#  Yang dikerjakan:
#    1. memasang git, python3, openssl (lewat apt);
#    2. membuat akun sistem tanpa login (skyacs) — panel TIDAK berjalan sebagai root;
#    3. mengambil panel dari GitHub ke /opt/panel-acs;
#    4. memilih port: 8081, atau port kosong berikutnya (8082, 8083, …) bila terpakai.
#       Port yang terpilih DISIMPAN di /etc/default/panel-acs dan tidak berubah lagi —
#       baik saat server dinyalakan ulang, panel diperbarui, maupun skrip ini dijalankan ulang;
#    5. mendaftarkannya sebagai layanan systemd (menyala sendiri saat server dinyalakan,
#       dinyalakan ulang bila mati);
#    6. menampilkan alamat panel dan kode instalasi untuk membuat administrator pertama.
#
#  Aman dijalankan ULANG: panel yang sudah ada hanya diperbarui (git pull maju lurus),
#  port & pengaturannya dipertahankan, dan folder data/ (akun, pengaturan, Log, cadangan)
#  tidak pernah disentuh.
#
#  Pilihan (variabel lingkungan, semuanya opsional):
#    SKY_DIR=/opt/panel-acs    folder pemasangan
#    SKY_PORT=8082             paksa port tertentu (tanpa ini: 8081 atau port kosong berikutnya)
#    SKY_USER=skyacs           akun sistem yang menjalankan panel
#    SKY_REPO=https://github.com/PutuTobing/panel-acs.git
#    SKY_BRANCH=main
#    SKY_DATA_DARI=/home/btd/panel-acs/data   salin data panel LAMA (hanya bila panel baru
#                                             belum punya basis data)
#    SKY_HOST=127.0.0.1  SKY_PROXY=1  SKY_HTTPS=1  SKY_ORIGIN=https://panel.domain.id
#                              untuk panel di belakang nginx/Caddy — lihat README
#  Contoh:  curl -fsSL …/pasang.sh | sudo SKY_PORT=8090 bash
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SKY_DIR="${SKY_DIR:-/opt/panel-acs}"
SKY_USER="${SKY_USER:-skyacs}"
SKY_REPO="${SKY_REPO:-https://github.com/PutuTobing/panel-acs.git}"
SKY_BRANCH="${SKY_BRANCH:-main}"
SKY_DATA_DARI="${SKY_DATA_DARI:-}"
PORT_DIMINTA="${SKY_PORT:-}"
PORT_AWAL=8081
PORT_AKHIR=8099
LAYANAN="panel-acs"
UNIT="/etc/systemd/system/${LAYANAN}.service"
BERKAS_ENV="/etc/default/${LAYANAN}"

# Pesan ke stderr: sebagian fungsi mengembalikan hasilnya lewat stdout (pilih_port).
info()  { printf '\033[1;34m[pasang]\033[0m %s\n' "$*" >&2; }
gagal() { printf '\033[1;31m[pasang] GAGAL:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Prasyarat ───────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || gagal "jalankan dengan sudo (butuh hak root untuk memasang layanan)."
command -v apt-get  >/dev/null 2>&1 || gagal "skrip ini untuk Ubuntu/Debian (apt-get tidak ditemukan)."
command -v systemctl >/dev/null 2>&1 || gagal "systemd tidak ditemukan; jalankan panel manual: python3 server.py"
if [ -n "$PORT_DIMINTA" ]; then
  case "$PORT_DIMINTA" in *[!0-9]*) gagal "SKY_PORT harus angka (dapat: '$PORT_DIMINTA')." ;; esac
  [ "$PORT_DIMINTA" -ge 1024 ] && [ "$PORT_DIMINTA" -le 65535 ] || gagal "SKY_PORT harus antara 1024 dan 65535."
fi
case "$SKY_DIR" in /*) ;; *) gagal "SKY_DIR harus alamat lengkap (diawali /)." ;; esac
# Layanan dikunci dari /home dan /root (ProtectHome) — panel di sana terpasang tetapi tak bisa menyala.
case "$SKY_DIR" in /home|/home/*|/root|/root/*) gagal "SKY_DIR tidak boleh di dalam /home atau /root. Pakai /opt/panel-acs (bawaan) atau folder lain di luar keduanya." ;; esac
case "$SKY_USER" in root|'') gagal "panel tidak boleh dijalankan sebagai root." ;; esac

info "memasang git, python3, openssl…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git python3 openssl ca-certificates curl >/dev/null

python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' \
  || gagal "butuh Python 3.8 atau lebih baru (terpasang: $(python3 -V 2>&1))."
python3 -c 'import sqlite3, ssl, hashlib; hashlib.scrypt' 2>/dev/null \
  || gagal "Python di server ini tidak punya sqlite3/ssl/scrypt yang dibutuhkan panel."

# ── Akun sistem ─────────────────────────────────────────────────────────────
if ! id -u "$SKY_USER" >/dev/null 2>&1; then
  info "membuat akun sistem '$SKY_USER' (tanpa login)…"
  useradd --system --home-dir "$SKY_DIR" --no-create-home --shell /usr/sbin/nologin "$SKY_USER"
fi
sebagai() { runuser -u "$SKY_USER" -- "$@"; }

# ── Kode panel ──────────────────────────────────────────────────────────────
if [ -d "$SKY_DIR/.git" ]; then
  info "panel sudah ada di $SKY_DIR — memperbarui (git pull, hanya maju)…"
  chown -R "$SKY_USER":"$SKY_USER" "$SKY_DIR"
  sebagai git -C "$SKY_DIR" pull --ff-only --quiet origin "$SKY_BRANCH" \
    || gagal "git pull gagal. Periksa: sudo -u $SKY_USER git -C $SKY_DIR status"
elif [ -e "$SKY_DIR" ] && [ -n "$(ls -A "$SKY_DIR" 2>/dev/null)" ]; then
  gagal "$SKY_DIR sudah ada dan berisi berkas lain. Pindahkan dulu, atau pilih folder lain: SKY_DIR=/opt/panel-acs2"
else
  info "mengambil panel dari $SKY_REPO ($SKY_BRANCH)…"
  install -d -m 755 -o "$SKY_USER" -g "$SKY_USER" "$SKY_DIR"
  sebagai git clone --quiet --branch "$SKY_BRANCH" "$SKY_REPO" "$SKY_DIR" \
    || gagal "git clone gagal. Periksa sambungan internet server ini dan alamat repositori."
fi
[ -f "$SKY_DIR/server.py" ] || gagal "server.py tidak ditemukan di $SKY_DIR — repositori tidak lengkap?"

# ── Data ────────────────────────────────────────────────────────────────────
# data/ memuat akun, hash password, kredensial NBI dan Log: hanya untuk akun panel.
install -d -m 700 -o "$SKY_USER" -g "$SKY_USER" "$SKY_DIR/data"
if [ -n "$SKY_DATA_DARI" ]; then
  [ -f "$SKY_DATA_DARI/sky.db" ] || gagal "SKY_DATA_DARI=$SKY_DATA_DARI tidak berisi sky.db."
  if [ -f "$SKY_DIR/data/sky.db" ]; then
    info "panel baru sudah punya basis data — data lama TIDAK disalin (tidak menimpa)."
  else
    info "menyalin data panel lama dari $SKY_DATA_DARI…"
    # Panel lama harus sudah dimatikan: basis data yang sedang dipakai bisa tersalin setengah.
    cp -a "$SKY_DATA_DARI/." "$SKY_DIR/data/"
    chown -R "$SKY_USER":"$SKY_USER" "$SKY_DIR/data"
    chmod 700 "$SKY_DIR/data"
  fi
fi

# ── Port ────────────────────────────────────────────────────────────────────
# Urutan: SKY_PORT yang diminta > port yang SUDAH tersimpan (pemasangan sebelumnya) >
# 8081 atau port kosong berikutnya. Sekali terpilih, port disimpan dan dipakai terus.
port_terpakai() {   # 0 (benar) bila port sedang dipakai program lain
  ! python3 -c 'import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", int(sys.argv[1]))); s.close()' "$1" 2>/dev/null
}
baca_env() {        # baca_env KUNCI → nilainya di berkas pengaturan (kosong bila tak ada)
  if [ -f "$BERKAS_ENV" ]; then
    sed -n "s/^$1=//p" "$BERKAS_ENV" | head -n 1
  fi
}
# Memilih port. Hasilnya ditulis ke stdout; pesannya ke stderr (lihat info/gagal).
# Dipisah sebagai fungsi supaya aturannya bisa diuji tanpa server (tests/pasang.test.py).
pilih_port() {
  local port calon
  if [ -n "$PORT_DIMINTA" ]; then
    port="$PORT_DIMINTA"
    # Port yang sedang dipakai layanan panel ini sendiri bukan "terpakai program lain".
    if [ "$port" != "$PORT_TERSIMPAN" ] || [ "$LAYANAN_HIDUP" -eq 0 ]; then
      if port_terpakai "$port"; then
        gagal "port $port (SKY_PORT) sudah dipakai program lain. Pilih port lain, atau jalankan tanpa SKY_PORT agar dipilihkan."
      fi
    fi
  elif [ -n "$PORT_TERSIMPAN" ]; then
    port="$PORT_TERSIMPAN"
    info "memakai port yang sudah tersimpan: $port (tidak diubah)."
    if [ "$LAYANAN_HIDUP" -eq 0 ] && port_terpakai "$port"; then
      gagal "port $port (tersimpan di $BERKAS_ENV) kini dipakai program lain. Matikan program itu, atau pindahkan panel: SKY_PORT=<port lain>."
    fi
  else
    port=""
    for calon in $(seq "$PORT_AWAL" "$PORT_AKHIR"); do
      if port_terpakai "$calon"; then
        info "port $calon sudah dipakai program lain — mencoba port berikutnya…"
      else
        port="$calon"
        break
      fi
    done
    if [ -z "$port" ]; then
      gagal "tidak ada port kosong antara $PORT_AWAL dan $PORT_AKHIR. Tentukan sendiri: SKY_PORT=<port>."
    fi
    if [ "$port" != "$PORT_AWAL" ]; then
      info "port $PORT_AWAL terpakai → panel memakai port $port (disimpan; tidak akan berubah lagi)."
    fi
  fi
  printf '%s\n' "$port"
}
PORT_TERSIMPAN="$(baca_env SKY_PORT)"
case "$PORT_TERSIMPAN" in ''|*[!0-9]*) PORT_TERSIMPAN="" ;; esac
LAYANAN_HIDUP=0
if systemctl is-active --quiet "$LAYANAN" 2>/dev/null; then
  LAYANAN_HIDUP=1
fi
PORT="$(pilih_port)"

# ── Berkas pengaturan layanan ───────────────────────────────────────────────
# Satu tempat untuk port dan mode proxy. Tidak pernah ditimpa: yang sudah ada hanya
# diperbarui pada kunci yang diberikan lewat variabel lingkungan saat skrip dijalankan.
setel_env() {       # setel_env KUNCI NILAI — ganti baris (juga yang masih berkomentar) atau tambahkan
  case "$2" in *[!A-Za-z0-9:/._,-]*) gagal "nilai $1 memuat karakter yang tidak diizinkan: '$2'" ;; esac
  if grep -q "^#\{0,1\}$1=" "$BERKAS_ENV"; then
    sed -i "0,/^#\{0,1\}$1=.*/s||$1=$2|" "$BERKAS_ENV"
  else
    printf '%s=%s\n' "$1" "$2" >> "$BERKAS_ENV"
  fi
}
if [ ! -f "$BERKAS_ENV" ]; then
  cat > "$BERKAS_ENV" <<'EOF'
# Pengaturan Panel ACS SKY TECH — dibaca layanan panel-acs saat dinyalakan.
# Sesudah mengubah berkas ini:  sudo systemctl restart panel-acs
#
# Port panel. Dipilih saat pemasangan dan TIDAK berubah sendiri.
SKY_PORT=8081
#
# ── Panel di belakang nginx / Caddy (lihat README "Memasang di belakang nginx") ──
# Hanya dengarkan dari komputer ini (nginx yang melayani dari luar):
#SKY_HOST=127.0.0.1
# Ada reverse proxy di depan → alamat pengunjung dibaca dari X-Real-IP, dan form
# instalasi pertama selalu meminta kode instalasi:
#SKY_PROXY=1
# Proxy melayani HTTPS → cookie sesi diberi atribut Secure. JANGAN dinyalakan bila
# panel masih dibuka lewat http:// (login akan gagal terus):
#SKY_HTTPS=1
# Alamat publik panel bila berbeda dari yang dilihat server:
#SKY_ORIGIN=https://panel.domain-anda.com
EOF
  chmod 644 "$BERKAS_ENV"
fi
setel_env SKY_PORT "$PORT"
for kunci in SKY_HOST SKY_PROXY SKY_HTTPS SKY_ORIGIN; do
  nilai="$(printenv "$kunci" || true)"
  if [ -n "$nilai" ]; then
    setel_env "$kunci" "$nilai"
  fi
done

# ── Layanan systemd ─────────────────────────────────────────────────────────
info "mendaftarkan layanan $LAYANAN (port $PORT)…"
cat > "$UNIT" <<EOF
[Unit]
Description=Panel ACS SKY TECH
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SKY_USER
Group=$SKY_USER
WorkingDirectory=$SKY_DIR
# Port & mode proxy: $BERKAS_ENV (SKY_PORT, SKY_HOST, SKY_PROXY, SKY_HTTPS, SKY_ORIGIN).
EnvironmentFile=-$BERKAS_ENV
ExecStart=/usr/bin/python3 "$SKY_DIR/server.py"
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=HOME=$SKY_DIR
# Berkas baru (basis data, cadangan) hanya terbaca akun panel.
UMask=0077
# Pengerasan: panel tak butuh hak tambahan, /home, atau menulis ke sistem.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable --quiet "$LAYANAN"
systemctl restart "$LAYANAN"

# ── Tunggu panel menjawab ───────────────────────────────────────────────────
info "menunggu panel menyala…"
# Panel melayani HTTPS sendiri bila data/tls/cert.pem ada (mis. ikut tersalin dari panel
# lama) — dicoba dua-duanya, dan yang menjawab dipakai untuk alamat di akhir.
SKEMA=""
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/login" 2>/dev/null; then
    SKEMA="http"; break
  fi
  if curl -fsSk -o /dev/null --max-time 2 "https://127.0.0.1:$PORT/login" 2>/dev/null; then
    SKEMA="https"; break
  fi
  sleep 1
done
if [ -z "$SKEMA" ]; then
  journalctl -u "$LAYANAN" -n 30 --no-pager || true
  gagal "panel tidak menjawab di port $PORT. Catatan layanan ada di atas (journalctl -u $LAYANAN)."
fi

# ── Selesai ─────────────────────────────────────────────────────────────────
ALAMAT="$(hostname -I 2>/dev/null | awk '{print $1}')"
VERSI="$(cat "$SKY_DIR/VERSION" 2>/dev/null || echo '?')"
HOST_PANEL="$(baca_env SKY_HOST)"
echo
echo "══════════════════════════════════════════════════════════════"
echo "  Panel ACS SKY TECH v$VERSI terpasang."
if [ "$HOST_PANEL" = "127.0.0.1" ]; then
  echo "  Panel hanya mendengarkan di komputer ini (127.0.0.1:$PORT) —"
  echo "  dibuka lewat nginx/Caddy di depannya, bukan langsung ke port ini."
else
  echo "  Buka:  $SKEMA://${ALAMAT:-<alamat-server>}:$PORT/"
fi
if [ -f "$SKY_DIR/data/SETUP_CODE.txt" ]; then
  echo
  echo "  INSTALASI PERTAMA — belum ada akun. Halaman itu meminta kode ini"
  echo "  untuk membuat administrator pertama:"
  echo
  # Baris ketiga berkas itu: XXXX-XXXX-XXXX (lihat backend/auth.py prepare_setup).
  KODE="$(grep -Eo '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$' "$SKY_DIR/data/SETUP_CODE.txt" | head -n 1 || true)"
  echo "      ${KODE:-(lihat $SKY_DIR/data/SETUP_CODE.txt)}"
  echo
  echo "  Kode ini sekali pakai dan terhapus sesudah administrator dibuat."
fi
echo
echo "  Port panel      : $PORT  (tersimpan di $BERKAS_ENV)"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  echo "  Firewall (ufw) aktif — buka portnya:  sudo ufw allow $PORT/tcp"
fi
echo
echo "  Perintah berguna:"
echo "    sudo systemctl status $LAYANAN      keadaan layanan"
echo "    sudo journalctl -u $LAYANAN -f      catatan panel (langsung)"
echo "    sudo systemctl restart $LAYANAN     menyalakan ulang"
echo "  Memperbarui: Settings → Tentang Sistem → Pembaruan (tombol Update),"
echo "  atau jalankan lagi perintah pemasang ini."
if [ "$SKEMA" = "http" ] && [ "$(baca_env SKY_HTTPS)" != "1" ]; then
  echo
  echo "  PENTING: panel masih HTTP polos. Sebelum dibuka ke jaringan lain /"
  echo "  internet, pasang HTTPS (nginx + certbot) — lihat README bagian"
  echo "  \"Memasang di belakang nginx\"."
fi
echo "══════════════════════════════════════════════════════════════"
