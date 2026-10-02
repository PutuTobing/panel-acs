#!/usr/bin/env python3
"""Buat sertifikat HTTPS untuk panel: data/tls/cert.pem + data/tls/key.pem.

    python tools/buat_sertifikat.py                     # localhost + IP komputer ini
    python tools/buat_sertifikat.py panel.kantor 10.0.0.5   # tambah nama/IP lain

Sesudahnya `python server.py` melayani HTTPS dengan sendirinya — password dan cookie
sesi tak lagi melintas sebagai teks terang di jaringan (2026-10-03).

Sertifikat ini DITANDATANGANI SENDIRI: browser akan menampilkan peringatan "koneksi tidak
pribadi" sampai sertifikatnya dipercaya di perangkat itu. Untuk jaringan kantor itu wajar.
Untuk akses PUBLIK (internet) pakai sertifikat resmi — paling mudah reverse proxy Caddy
yang mengurus Let's Encrypt otomatis; lihat README.md bagian "Keamanan".

Butuh program `openssl` (ada di Linux/Mac, dan ikut terpasang bersama Git for Windows).
Tidak ada yang dikirim ke mana pun; kunci privat dibuat di komputer ini dan tidak
pernah meninggalkannya.
"""
import ipaddress
import os
import shutil
import socket
import subprocess
import sys

AKAR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TUJUAN = os.path.join(AKAR, 'data', 'tls')


def cari_openssl():
    calon = [shutil.which('openssl'),
             r'C:\Program Files\Git\usr\bin\openssl.exe',
             r'C:\Program Files\Git\mingw64\bin\openssl.exe',
             r'C:\Program Files (x86)\Git\usr\bin\openssl.exe']
    for c in calon:
        if c and os.path.isfile(c):
            return c
    return None


def nama_alt(tambahan):
    """subjectAltName: localhost, 127.0.0.1, IP LAN komputer ini, dan nama tambahan."""
    dns, ip = ['localhost'], ['127.0.0.1']
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            a = info[4][0]
            if a not in ip and not a.startswith('169.254.'):
                ip.append(a)
    except OSError:
        pass
    for t in tambahan:
        try:
            ipaddress.ip_address(t)
            if t not in ip:
                ip.append(t)
        except ValueError:
            if t not in dns:
                dns.append(t)
    return 'subjectAltName=' + ','.join(['DNS:' + d for d in dns] + ['IP:' + i for i in ip])


def buat(cert, key, tambahan=(), hari=825, openssl=None):
    """Tulis sertifikat self-signed (RSA 2048, SHA-256). Kembalikan subjectAltName-nya."""
    openssl = openssl or cari_openssl()
    if not openssl:
        raise RuntimeError('program openssl tidak ditemukan')
    san = nama_alt(tambahan)
    os.makedirs(os.path.dirname(cert), exist_ok=True)
    subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
                    '-days', str(hari), '-subj', '/CN=Panel ACS SKY TECH',
                    '-keyout', key, '-out', cert, '-addext', san],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        os.chmod(key, 0o600)        # kunci privat hanya untuk pemilik (berlaku di Linux/Mac)
    except OSError:
        pass
    return san


def main():
    cert = os.path.join(TUJUAN, 'cert.pem')
    key = os.path.join(TUJUAN, 'key.pem')
    if os.path.exists(cert) or os.path.exists(key):
        print('Sertifikat sudah ada di ' + TUJUAN + '.')
        print('Hapus cert.pem & key.pem lebih dulu bila memang ingin membuat ulang.')
        return 1
    try:
        san = buat(cert, key, sys.argv[1:])
    except RuntimeError as e:
        print('GAGAL: ' + str(e) + '. Pasang OpenSSL (atau Git for Windows), lalu ulangi.')
        return 1
    except subprocess.CalledProcessError as e:
        print('GAGAL menjalankan openssl:\n' + (e.stderr or b'').decode('utf-8', 'replace'))
        return 1
    print('Sertifikat dibuat:')
    print('  ' + cert)
    print('  ' + key + '   (kunci privat — jangan dibagikan, tidak ikut Git)')
    print('  berlaku untuk: ' + san.split('=', 1)[1])
    print('Jalankan ulang panel: python server.py  → alamatnya kini https://…')
    return 0


if __name__ == '__main__':
    sys.exit(main())
