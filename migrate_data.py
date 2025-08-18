import sqlite3
import psycopg2
import os
from urllib.parse import urlparse
from psycopg2.extras import execute_values
from werkzeug.security import generate_password_hash

# --- KONFIGURASI ---
# Nama file database SQLite lokal Anda
LOCAL_DB_FILE = 'network.db' 

# Ambil URL koneksi database PostgreSQL dari environment variable
# Anda akan mendapatkan URL ini dari dasbor Render setelah membuat database
DATABASE_URL = os.environ.get('DATABASE_URL')

def get_pg_connection():
    """Membuat koneksi ke database PostgreSQL di Render."""
    if not DATABASE_URL:
        raise Exception("Error: DATABASE_URL environment variable tidak di-set. \nJalankan skrip dengan format: DATABASE_URL='...' python migrate_data.py")
    
    result = urlparse(DATABASE_URL)
    return psycopg2.connect(
        dbname=result.path[1:],
        user=result.username,
        password=result.password,
        host=result.hostname,
        port=result.port
    )

def get_sqlite_connection():
    """Membuat koneksi ke database SQLite lokal."""
    if not os.path.exists(LOCAL_DB_FILE):
        raise FileNotFoundError(f"Error: File database '{LOCAL_DB_FILE}' tidak ditemukan di folder ini.")
    conn = sqlite3.connect(LOCAL_DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def create_tables_if_not_exist():
    """FUNGSI YANG DIPERBARUI: Membuat SEMUA tabel di PostgreSQL jika belum ada."""
    print("Mengecek dan membuat tabel di PostgreSQL jika diperlukan...")
    conn = get_pg_connection()
    cursor = conn.cursor()
    
    # Membuat tabel devices
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS devices (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            parent_name TEXT,
            ont_id TEXT,
            deskripsi TEXT,
            kapasitas INTEGER
        )
    ''')
    # Membuat tabel route_points
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS route_points (
            id SERIAL PRIMARY KEY,
            group_name TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            sequence INTEGER NOT NULL
        )
    ''')
    # MEMBUAT TABEL USERS YANG HILANG
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL
        )
    ''')

    # Cek apakah user 'admin' sudah ada
    cursor.execute("SELECT * FROM users WHERE username = 'admin'")
    if cursor.fetchone() is None:
        print("Menambahkan pengguna default 'admin'...")
        admin_pass = generate_password_hash('admin')
        cursor.execute("INSERT INTO users (username, password_hash) VALUES (%s, %s)", ('admin', admin_pass))
    
    # Cek apakah user 'teknisi' sudah ada
    cursor.execute("SELECT * FROM users WHERE username = 'teknisi'")
    if cursor.fetchone() is None:
        print("Menambahkan pengguna default 'teknisi'...")
        teknisi_pass = generate_password_hash('teknisi')
        cursor.execute("INSERT INTO users (username, password_hash) VALUES (%s, %s)", ('teknisi', teknisi_pass))

    conn.commit()
    cursor.close()
    conn.close()
    print("Pengecekan tabel selesai.")


def migrate_table(table_name, columns):
    """Membaca data dari tabel SQLite dan menulisnya ke PostgreSQL."""
    print(f"Memulai migrasi untuk tabel: '{table_name}'...")
    
    sqlite_conn = get_sqlite_connection()
    pg_conn = get_pg_connection()
    
    sqlite_cursor = sqlite_conn.cursor()
    pg_cursor = pg_conn.cursor()

    # 1. Baca semua data dari SQLite
    sqlite_cursor.execute(f"SELECT {', '.join(columns)} FROM {table_name}")
    rows = sqlite_cursor.fetchall()
    
    if not rows:
        print(f"Tidak ada data untuk dimigrasi di tabel '{table_name}'.")
        sqlite_conn.close()
        pg_conn.close()
        return

    print(f"Ditemukan {len(rows)} baris data di tabel '{table_name}' (SQLite).")

    # 2. Hapus data lama di PostgreSQL (opsional, untuk menghindari duplikat)
    print(f"Menghapus data lama di tabel '{table_name}' (PostgreSQL)...")
    pg_cursor.execute(f"TRUNCATE TABLE {table_name} RESTART IDENTITY CASCADE")

    # 3. Masukkan data ke PostgreSQL
    # Membuat daftar tuple dari baris data
    data_to_insert = [tuple(row) for row in rows]
    
    # Membuat string query
    cols_str = ", ".join(columns)
    query = f"INSERT INTO {table_name} ({cols_str}) VALUES %s"

    try:
        execute_values(pg_cursor, query, data_to_insert)
        pg_conn.commit()
        print(f"Berhasil! {len(data_to_insert)} baris data telah dimasukkan ke tabel '{table_name}' (PostgreSQL).")
    except Exception as e:
        print(f"Terjadi error saat memasukkan data: {e}")
        pg_conn.rollback()
    finally:
        sqlite_conn.close()
        pg_conn.close()

if __name__ == '__main__':
    # Pastikan Anda sudah menginstal library yang dibutuhkan secara lokal:
    # pip install psycopg2-binary werkzeug
    
    # 1. Panggil fungsi baru untuk membuat semua tabel terlebih dahulu
    create_tables_if_not_exist()

    # 2. Lanjutkan dengan migrasi data seperti sebelumnya
    devices_columns = ['name', 'lat', 'lng', 'parent_name', 'ont_id', 'deskripsi', 'kapasitas']
    migrate_table('devices', devices_columns)

    print("-" * 20)

    route_points_columns = ['group_name', 'lat', 'lng', 'sequence']
    migrate_table('route_points', route_points_columns)

    print("\nMigrasi data selesai.")