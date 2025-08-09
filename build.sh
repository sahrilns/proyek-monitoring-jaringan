#!/bin/bash

# Keluar jika ada error
set -o errexit

# Instal semua library dari requirements.txt
pip install -r requirements.txt

# Jalankan fungsi init_db dari file app.py Anda
# Ini akan membuat tabel-tabel di database PostgreSQL Anda
python -c "from app import init_db; init_db()"