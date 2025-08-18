from flask import Flask, jsonify, request, send_from_directory, session, redirect, url_for, render_template
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps
import os
import psycopg2 
from psycopg2.extras import DictCursor
from urllib.parse import urlparse
import time
from collections import defaultdict
# PERBAIKAN: Menggunakan wildcard import untuk mengatasi ImportError di lingkungan build
from pysnmp.hlapi import *

# --- Inisialisasi Aplikasi ---
app = Flask(__name__, static_folder='.', static_url_path='')
app.secret_key = os.environ.get('SECRET_KEY', 'default-secret-key-for-dev')
CORS(app)

# --- KONFIGURASI (diambil dari Environment Variables) ---
OLT_IP = os.environ.get('OLT_IP', 'ate.gigabit.my.id')
SNMP_COMMUNITY = os.environ.get('SNMP_COMMUNITY', 'public')
SNMP_PORT = int(os.environ.get('SNMP_PORT', 60303))
OID_ONT_STATUS = '1.3.6.1.4.1.25355.3.2.6.3.2.1.39'
OID_ONT_MAC = '1.3.6.1.4.1.25355.3.2.6.3.2.1.11'
OID_ONT_RX_POWER = '1.3.6.1.4.1.25355.3.2.6.14.2.1.8.1'

CACHE_DURATION = 60
ont_cached_data = None
ont_last_cache_time = 0

DATABASE_URL = os.environ.get('DATABASE_URL')

# --- FUNGSI DATABASE (PostgreSQL) ---
def get_db_connection():
    if DATABASE_URL is None:
        raise Exception("DATABASE_URL environment variable is not set.")
    
    result = urlparse(DATABASE_URL)
    username = result.username
    password = result.password
    database = result.path[1:]
    hostname = result.hostname
    port = result.port

    conn = psycopg2.connect(
        dbname=database,
        user=username,
        password=password,
        host=hostname,
        port=port
    )
    return conn

def init_db():
    print("Mengecek dan membuat tabel jika belum ada...")
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT to_regclass('public.users');")
    table_exists = cursor.fetchone()[0]

    if table_exists:
        print("Database sudah diinisialisasi sebelumnya.")
        conn.close()
        return

    print("Membuat tabel baru untuk PostgreSQL...")
    cursor.execute('''
        CREATE TABLE devices (
            id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, lat REAL NOT NULL,
            lng REAL NOT NULL, parent_name TEXT, ont_id TEXT,
            deskripsi TEXT, kapasitas INTEGER
        )
    ''')
    cursor.execute('''
        CREATE TABLE route_points (
            id SERIAL PRIMARY KEY, group_name TEXT NOT NULL, lat REAL NOT NULL,
            lng REAL NOT NULL, sequence INTEGER NOT NULL
        )
    ''')
    cursor.execute('''
        CREATE TABLE users (
            id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL
        )
    ''')

    default_password = 'admin'
    hashed_password = generate_password_hash(default_password)
    cursor.execute('INSERT INTO users (username, password_hash) VALUES (%s, %s)', ('admin', hashed_password))
    print(f"Pengguna 'admin' berhasil ditambahkan.")

    teknisi_password = 'teknisi'
    hashed_password_teknisi = generate_password_hash(teknisi_password)
    cursor.execute('INSERT INTO users (username, password_hash) VALUES (%s, %s)', ('teknisi', hashed_password_teknisi))
    print(f"Pengguna 'teknisi' berhasil ditambahkan.")
    
    conn.commit()
    cursor.close()
    conn.close()
    print("Database dan tabel berhasil dibuat.")

# --- FUNGSI SNMP HELPER (DIPERBARUI DENGAN TIMEOUT DAN ERROR HANDLING) ---
def snmp_walk(oid):
    results = {}
    print(f"pysnmp: Walking OID {oid} on {OLT_IP}:{SNMP_PORT}")
    try:
        iterator = nextCmd(
            SnmpEngine(),
            CommunityData(SNMP_COMMUNITY, mpModel=1),
            UdpTransportTarget((OLT_IP, SNMP_PORT), timeout=10, retries=1),
            ContextData(),
            ObjectType(ObjectIdentity(oid)),
            lexicographicMode=False
        )

        for errorIndication, errorStatus, errorIndex, varBinds in iterator:
            if errorIndication:
                print(f"pysnmp Error: {errorIndication}")
                return {} 
            elif errorStatus:
                print(f'pysnmp Error: {errorStatus.prettyPrint()} at {errorIndex and varBinds[int(errorIndex) - 1][0] or "?"}')
                break
            else:
                for varBind in varBinds:
                    full_oid_str = str(varBind[0])
                    value = str(varBind[1])
                    
                    base_oid_len = len(oid.split('.'))
                    index_part = ".".join(full_oid_str.split('.')[base_oid_len:])
                    
                    if varBind[1].is_printable:
                        value = varBind[1].prettyPrint()
                    else:
                        value = ' '.join(['%02x' % x for x in varBind[1].asNumbers()])

                    results[index_part] = value
    except Exception as e:
        print(f"An unexpected pysnmp error occurred: {e}")
        return {} 

    print(f"pysnmp: Walk for OID {oid} finished. Found {len(results)} items.")
    return results

def get_ont_data():
    onts = defaultdict(dict)
    print("Fetching Status, MAC, and Rx Power...")
    status_data = snmp_walk(OID_ONT_STATUS)
    if not status_data:
        print("Gagal mengambil data status. Membatalkan pengambilan data ONT.")
        return []

    mac_data = snmp_walk(OID_ONT_MAC)
    rx_power_data = snmp_walk(OID_ONT_RX_POWER)
    
    for index, status_val in status_data.items():
        if status_val == '1': onts[index]['status'] = 'online'
        elif status_val == '2': onts[index]['status'] = 'offline'
        else: onts[index]['status'] = 'unknown'
        try:
            parts = [int(p) for p in index.split('.')]
            if len(parts) >= 3:
                onts[index]['slot'], onts[index]['pon_port'], onts[index]['onu_index'] = parts[0], parts[1], parts[2]
        except (ValueError, IndexError): pass

    for index, mac_val in mac_data.items():
        onts[index]['mac'] = mac_val.replace(' ', ':').upper() if mac_val else 'N/A'

    for rx_power_index, rx_power_val in rx_power_data.items():
        main_index_for_rx = f"1.{rx_power_index}"
        try:
            val_str = str(rx_power_val).strip()
            rx_float = float(val_str) / 100.0 
            onts[main_index_for_rx]['rx_power'] = rx_float
        except (ValueError, TypeError):
            onts[main_index_for_rx]['rx_power'] = None

    for index, data in onts.items():
        if data.get('status') == 'offline' and data.get('rx_power') is None:
            onts[index]['status'] = 'poweroff'
            
    return [data for data in onts.values() if 'status' in data]


# --- OTENTIKASI & API ENDPOINTS ---
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            if request.path.startswith('/api/'):
                return jsonify({"error": "Akses ditolak, silakan login"}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

@app.route('/')
@login_required
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        
        conn = get_db_connection()
        with conn.cursor(cursor_factory=DictCursor) as cursor:
            cursor.execute('SELECT * FROM users WHERE username = %s', (username,))
            user = cursor.fetchone()
        conn.close()

        if user and check_password_hash(user['password_hash'], password):
            session.clear()
            session['user_id'] = user['id']
            session['username'] = user['username']
            return redirect(url_for('serve_index'))

        error_message = 'Username atau password salah.'
        return render_template('login.html', error=error_message)

    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/api/user_info')
@login_required
def user_info():
    return jsonify({'username': session.get('username')})

@app.route('/api/devices', methods=['GET'])
@login_required
def get_devices():
    conn = get_db_connection()
    with conn.cursor(cursor_factory=DictCursor) as cursor:
        cursor.execute('SELECT * FROM devices')
        devices = cursor.fetchall()
    conn.close()
    return jsonify([dict(row) for row in devices])

@app.route('/api/devices', methods=['POST'])
@login_required
def add_device():
    new_device = request.json
    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=DictCursor) as cursor:
            cursor.execute(
                'INSERT INTO devices (name, lat, lng, parent_name, ont_id, deskripsi, kapasitas) VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id',
                (new_device['name'], new_device['lat'], new_device['lng'], new_device.get('parent_name'), 
                 new_device.get('ont_id'), new_device.get('deskripsi'), new_device.get('kapasitas'))
            )
            new_id = cursor.fetchone()['id']
            new_device['id'] = new_id
        conn.commit()
    except psycopg2.IntegrityError:
        conn.close()
        return jsonify({'error': 'Nama perangkat sudah ada'}), 400
    finally:
        conn.close()
    return jsonify(new_device), 201

@app.route('/api/devices/<int:device_id>/location', methods=['PUT'])
@login_required
def update_device_location(device_id):
    data = request.json
    conn = get_db_connection()
    with conn.cursor() as cursor:
        cursor.execute('UPDATE devices SET lat = %s, lng = %s WHERE id = %s', (data['lat'], data['lng'], device_id))
    conn.commit()
    conn.close()
    return jsonify({'status': 'success'})

@app.route('/api/devices/<int:device_id>', methods=['DELETE'])
@login_required
def delete_device(device_id):
    conn = get_db_connection()
    with conn.cursor(cursor_factory=DictCursor) as cursor:
        cursor.execute('SELECT name FROM devices WHERE id = %s', (device_id,))
        device_to_delete = cursor.fetchone()
        if device_to_delete:
            device_name = device_to_delete['name']
            cursor.execute('DELETE FROM route_points WHERE group_name LIKE %s', (f"{device_name}-%",))
            cursor.execute('DELETE FROM route_points WHERE group_name LIKE %s', (f"%-{device_name}",))
        cursor.execute('DELETE FROM devices WHERE id = %s', (device_id,))
    conn.commit()
    conn.close()
    return jsonify({'status': 'success'})

@app.route('/api/routes', methods=['GET', 'POST'])
@login_required
def handle_routes():
    conn = get_db_connection()
    if request.method == 'POST':
        data = request.json
        group_name = data.get('group_name')
        points = data.get('points')
        if not group_name or not points:
            return jsonify({'error': 'Data tidak lengkap'}), 400
        with conn.cursor() as cursor:
            cursor.execute('DELETE FROM route_points WHERE group_name = %s', (group_name,))
            points_to_insert = []
            for i, point in enumerate(points):
                points_to_insert.append((group_name, point['lat'], point['lng'], i))
            psycopg2.extras.execute_values(
                cursor,
                'INSERT INTO route_points (group_name, lat, lng, sequence) VALUES %s',
                points_to_insert
            )
        conn.commit()
        conn.close()
        return jsonify({'status': 'success', 'points_added': len(points_to_insert)})
    else: # GET
        with conn.cursor(cursor_factory=DictCursor) as cursor:
            cursor.execute('SELECT * FROM route_points ORDER BY group_name, sequence')
            points = cursor.fetchall()
        conn.close()
        routes = {}
        for point in points:
            p = dict(point)
            if p['group_name'] not in routes:
                routes[p['group_name']] = []
            routes[p['group_name']].append([p['lat'], p['lng']])
        return jsonify(routes)

@app.route('/api/ont_data', methods=['GET'])
@login_required
def ont_data_api():
    global ont_cached_data, ont_last_cache_time
    current_time = time.time()
    if ont_cached_data and (current_time - ont_last_cache_time) < CACHE_DURATION:
        print(f"[{time.strftime('%H:%M:%S')}] Menyajikan data ONT dari cache.")
        return jsonify(ont_cached_data)
    
    print(f"[{time.strftime('%H:%M:%S')}] Cache ONT kadaluwarsa. Memulai pemindaian SNMP...")
    new_data = get_ont_data()
    ont_cached_data = new_data
    ont_last_cache_time = current_time
    print(f"[{time.strftime('%H:%M:%S')}] Data ONT baru disimpan di cache. Total: {len(new_data)} perangkat.")
    return jsonify(new_data)

if __name__ == '__main__':
    print("Aplikasi berjalan dalam mode development.")
    app.run(debug=True, host='0.0.0.0', port=5000)