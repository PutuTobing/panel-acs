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
#    4. mendaftarkannya sebagai layanan systemd (menyala sendiri saat server dinyalakan,
#       dinyalakan ulang bila mati);
#    5. menampilkan alamat panel dan kode instalasi untuk membuat administrator pertama.
#
#  Aman dijalankan ULANG: panel yang sudah ada hanya diperbarui (git pull maju lurus),
#  dan folder data/ (akun, pengaturan, Log, cadangan) tidak pernah disentuh.
#
#  Pilihan (variabel lingkungan, semuanya opsional):
#    SKY_DIR=/opt/panel-acs    folder pemasangan
#    SKY_PORT=8081             port panel
#    SKY_USER=skyacs           akun sistem yang menjalankan panel
#    SKY_REPO=https://github.com/PutuTobing/panel-acs.git
#    SKY_BRANCH=main
#    SKY_DATA_DARI=/home/btd/panel-acs/data   salin data panel LAMA (hanya bila panel baru
#                                             belum punya basis data)
#  Contoh:  curl -fsSL …/pasang.sh | sudo SKY_PORT=8082 bash
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SKY_DIR="${SKY_DIR:-/opt/panel-acs}"
SKY_PORT="${SKY_PORT:-8081}"
SKY_USER="${SKY_USER:-skyacs}"
SKY_REPO="${SKY_REPO:-https://github.com/PutuTobing/panel-acs.git}"
SKY_BRANCH="${SKY_BRANCH:-main}"
SKY_DATA_DARI="${SKY_DATA_DARI:-}"
LAYANAN="panel-acs"
UNIT="/etc/systemd/system/${LAYANAN}.service"

info()  { printf '\033[1;34m[pasang]\033[0m %s\n' "$*"; }
gagal() { printf '\033[1;31m[pasang] GAGAL:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Prasyarat ───────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || gagal "jalankan dengan sudo (butuh hak root untuk memasang layanan)."
command -v apt-get  >/dev/null 2>&1 || gagal "skrip ini untuk Ubuntu/Debian (apt-get tidak ditemukan)."
command -v systemctl >/dev/null 2>&1 || gagal "systemd tidak ditemukan; jalankan panel manual: python3 server.py"
case "$SKY_PORT" in ''|*[!0-9]*) gagal "SKY_PORT harus angka (dapat: '$SKY_PORT')." ;; esac
[ "$SKY_PORT" -ge 1024 ] && [ "$SKY_PORT" -le 65535 ] || gagal "SKY_PORT harus antara 1024 dan 65535."
case "$SKY_DIR" in /*) ;; *) gagal "SKY_DIR harus alamat lengkap (diawali /)." ;; esac
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
if ! systemctl is-active --quiet "$LAYANAN" 2>/dev/null; then
  if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$SKY_PORT" 2>/dev/null | grep -q .; then
    gagal "port $SKY_PORT sudah dipakai program lain (panel lama?). Matikan dulu program itu, atau pasang di port lain: SKY_PORT=8082"
  fi
fi

# ── Layanan systemd ─────────────────────────────────────────────────────────
info "mendaftarkan layanan $LAYANAN…"
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
ExecStart=/usr/bin/python3 $SKY_DIR/server.py $SKY_PORT
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
nyala=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$SKY_PORT/login" 2>/dev/null \
     || curl -fsSk -o /dev/null --max-time 2 "https://127.0.0.1:$SKY_PORT/login" 2>/dev/null; then
    nyala=1; break
  fi
  sleep 1
done
if [ "$nyala" -ne 1 ]; then
  journalctl -u "$LAYANAN" -n 30 --no-pager || true
  gagal "panel tidak menjawab di port $SKY_PORT. Catatan layanan ada di atas (journalctl -u $LAYANAN)."
fi

# ── Selesai ─────────────────────────────────────────────────────────────────
ALAMAT="$(hostname -I 2>/dev/null | awk '{print $1}')"
VERSI="$(cat "$SKY_DIR/VERSION" 2>/dev/null || echo '?')"
echo
echo "══════════════════════════════════════════════════════════════"
echo "  Panel ACS SKY TECH v$VERSI terpasang."
echo "  Buka:  http://${ALAMAT:-<alamat-server>}:$SKY_PORT/"
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
echo "  Perintah berguna:"
echo "    sudo systemctl status $LAYANAN      keadaan layanan"
echo "    sudo journalctl -u $LAYANAN -f      catatan panel (langsung)"
echo "    sudo systemctl restart $LAYANAN     menyalakan ulang"
echo "  Memperbarui: Settings → Tentang Sistem → Pembaruan (tombol Update),"
echo "  atau jalankan lagi perintah pemasang ini."
echo
echo "  PENTING: panel masih HTTP polos. Sebelum dibuka ke jaringan lain /"
echo "  internet, pasang HTTPS — lihat README bagian Keamanan."
echo "══════════════════════════════════════════════════════════════"
