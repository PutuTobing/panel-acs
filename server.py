#!/usr/bin/env python3
"""Peluncur Panel ACS SKY TECH.

    python server.py            # port 8081
    python server.py 8082       # port lain

Kode server ada di backend/, berkas tampilan di frontend/, data di data/.
Berkas ini hanya menjalankan backend/server.py — supaya cara menjalankan panel
tidak berubah sesudah struktur folder dirapikan (2026-10-03).
"""
import os
import runpy
import sys

BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend')
sys.path.insert(0, BACKEND)
runpy.run_path(os.path.join(BACKEND, 'server.py'), run_name='__main__')
