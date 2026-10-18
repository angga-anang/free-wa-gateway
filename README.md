# FREE GW — Self-Hosted WhatsApp Gateway

Implementasi lengkap dari `Stitch_WhatsApp_Gateway_PRD.md` dan
`Stitch_WhatsApp_Gateway_Backend_PRD.md`: backend engine (Node.js/TypeScript
+ Baileys + BullMQ + PostgreSQL + Redis) beserta dashboard web 4 modul
(Monitoring, Device Management, Message Logs, API Settings & Webhooks).

```
freegw/
├── backend/          # REST API + WebSocket QR streaming + queue workers
├── frontend/          # Dashboard statis (HTML/CSS/JS vanilla), langsung fetch ke backend
├── install.sh         # Installer otomatis untuk server Linux (lihat bagian 1a)
├── uninstall.sh        # Uninstaller / pembersih (lihat bagian 1a)
└── docker-compose.yml # PostgreSQL + Redis untuk development
```

## 1a. Instalasi Otomatis (disarankan untuk VPS/aaPanel)

Untuk server Linux (Ubuntu/Debian/CentOS), `install.sh` melakukan semuanya
secara otomatis: instal Node.js 20.x, instal Docker (untuk PostgreSQL +
Redis), `npm install` + build backend, migrasi database, generate
`MASTER_KEY`, lalu mendaftarkan **satu systemd service** (`freegw-backend`)
yang otomatis start saat boot.

**Arsitektur satu-port**: backend menyajikan dashboard (frontend) langsung
dari port yang sama dengan API-nya. Ini artinya hanya ada **satu port** yang
perlu diekspos — baik untuk akses LAN biasa, reverse proxy (Nginx di
aaPanel), maupun tunnel (Cloudflare Tunnel, ngrok, dsb). Dashboard otomatis
tahu API-nya ada di domain/origin yang sama, jadi tidak perlu mengisi Base
URL secara manual di kondisi normal.

```bash
cd freegw
chmod +x install.sh uninstall.sh
sudo ./install.sh
```

Opsi yang tersedia:

```bash
sudo ./install.sh \
  --port 3000 \
  --cors-origin "https://gateway.namadomain.com" \
  --yes            # non-interaktif, langsung terima default
```

Gunakan `--skip-docker` jika PostgreSQL dan Redis sudah tersedia di server
Anda (mis. sudah dikelola aaPanel) — Anda tinggal set `DATABASE_URL` dan
`REDIS_URL` sendiri di `backend/.env` setelah instalasi.

Setelah selesai, script menampilkan URL dashboard+API, serta perintah
`systemctl status freegw-backend` / `journalctl -u freegw-backend -f` untuk
memantau log.

**Menghapus instalasi:**

```bash
sudo ./uninstall.sh                  # HAPUS TOTAL (default): service, container,
                                      # volume database, dan folder project ini sendiri

sudo ./uninstall.sh --keep-data      # hapus service/container, tapi data Postgres/Redis
                                      # (sesi WhatsApp, riwayat pesan, API key) tetap aman
sudo ./uninstall.sh --keep-files     # hapus semua termasuk data, tapi folder project
                                      # (kode sumber) tidak ikut dihapus
sudo ./uninstall.sh --keep-data --keep-files   # paling aman: cuma stop service & tutup port
```

Secara default, `uninstall.sh` membersihkan **semuanya tanpa sisa**: service
systemd, port firewall, container + volume Postgres/Redis (artinya seluruh
sesi WhatsApp/riwayat pesan/API key ikut terhapus), dan **folder project ini
sendiri** (termasuk `install.sh`/`uninstall.sh` yang sedang berjalan). Kalau
masih ingin bisa instal ulang tanpa mulai dari nol, gunakan `--keep-data`
dan/atau `--keep-files` sesuai kebutuhan.

## 1a-1. Reverse Proxy / Tunnel (Cloudflare Tunnel, ngrok, Nginx aaPanel, dst.)

Karena dashboard dan API sekarang satu port, setup tunnel/reverse proxy
jadi sederhana — arahkan **semua traffic ke satu port** (default 3000, atau
sesuai `--port` yang dipakai saat instalasi):

```
# Contoh Cloudflare Tunnel (cloudflared config.yml)
ingress:
  - hostname: wa.domainanda.com
    service: http://localhost:3000
  - service: http_status:404
```

Untuk Nginx (aaPanel atau manual), proxy semua path (termasuk WebSocket
`/ws/devices` untuk QR code) ke port yang sama:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Setelah tunnel/proxy aktif, buka dashboard lewat domain publiknya
(mis. `https://wa.domainanda.com/login.html`) — **Base URL tidak perlu
diisi manual**, karena dashboard otomatis menganggap backend ada di origin
yang sama dengan halaman yang sedang dibuka.

> Kalau field Base URL di halaman Login/Settings terlanjur berisi alamat
> LAN lama (mis. `http://192.168.x.x:3000`) dari sebelum fitur ini ada,
> klik tombol **"Reset ke Otomatis"** di kedua halaman tersebut untuk
> menghapus override itu.

## 1b. Instalasi Manual

Jika lebih suka mengatur sendiri langkah demi langkah (atau develop di
mesin lokal), ikuti bagian 2–3 di bawah ini.

## 1. Prasyarat

- Node.js 20+ (wajib — Baileys mensyaratkan Node.js 20 atau lebih baru)
- Docker (untuk PostgreSQL + Redis) — atau instal keduanya secara manual
- Nomor WhatsApp yang bisa dipakai untuk memindai QR (gunakan nomor
  khusus/testing, bukan nomor utama, karena otomasi berisiko kena banned
  oleh WhatsApp jika volume terlalu tinggi atau pola terlalu robotic)

## 2. Menjalankan Backend

```bash
cd freegw

# 1) Nyalakan PostgreSQL + Redis
docker compose up -d

# 2) Install dependencies backend
cd backend
npm install

# 3) Siapkan environment variables
cp .env.example .env
# Generate MASTER_KEY (wajib, untuk enkripsi AES-256-GCM sesi WhatsApp):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Tempel hasilnya ke MASTER_KEY= di file .env

# 4) Jalankan migrasi database (membuat tabel devices, message_logs, api_configs, dst.)
npm run migrate

# 5) Jalankan server (mode development, auto-reload)
npm run dev
# atau untuk production:
npm run build && npm start
```

Backend berjalan di `http://localhost:3000` (bisa diubah lewat `PORT` di `.env`).
Endpoint WebSocket untuk streaming QR: `ws://localhost:3000/ws/devices?deviceId=<id>`.

## 3. Mengakses Dashboard

Sejak backend bisa menyajikan frontend langsung (lihat bagian 1a-1), cara
paling sederhana adalah: **buka backend langsung di browser**, tidak perlu
menjalankan server statis terpisah.

```bash
# Backend (dari langkah 2 di atas) sudah berjalan di http://localhost:3000
# — buka langsung:
```

Buka `http://localhost:3000` — Anda akan diarahkan ke halaman **Login**
terlebih dahulu (lihat bagian 3a di bawah) sebelum bisa mengakses dashboard
sama sekali. **Base URL tidak perlu diisi** karena dashboard otomatis
menganggap backend ada di origin yang sama dengan halaman yang sedang dibuka
— berlaku juga saat diakses lewat LAN IP, domain kustom, atau tunnel.

Setelah login, buka halaman **Settings**:

1. Karena belum ada API key sama sekali, tombol **Buat API Key Pertama** akan
   muncul (endpoint bootstrap ini satu-satunya yang boleh diakses tanpa
   token, dan otomatis terkunci begitu key pertama dibuat).
2. Key yang tampil hanya ditampilkan sekali — simpan baik-baik. Dashboard
   otomatis menyimpannya di `localStorage` browser Anda.
3. Buka halaman **Perangkat**, klik **Perangkat Baru**, lalu klik
   **Hubungkan / QR** untuk memindai QR dari WhatsApp di ponsel Anda.

> **Catatan penting:** API key disimpan di `localStorage` **per
> browser/perangkat** — bukan tersimpan di server. Kalau Anda buka
> dashboard dari browser lain, HP lain, atau mode incognito, **API key
> tetap harus di-generate atau ditempel ulang** di masing-masing browser
> tersebut. Ini disengaja: API key tidak ditanam ke file statis publik agar
> tidak bisa diambil siapa pun yang kebetulan membuka dashboard di jaringan
> yang sama.

### Menjalankan frontend sebagai server terpisah (opsional, lanjutan)

Kalau karena alasan tertentu Anda tetap ingin menyajikan frontend dari
server statis terpisah (misalnya lewat CDN, atau di port berbeda),
folder `frontend/` tetap bisa dijalankan mandiri:

```bash
cd frontend
npx serve -l 8090
```

Dalam mode ini, Base URL backend HARUS diisi manual di halaman
Login/Settings (karena originnya berbeda dari backend), dan `CORS_ORIGIN`
di `backend/.env` harus disetel ke origin frontend tersebut
(mis. `http://localhost:8090`) agar browser tidak diblokir CORS.

## 3a. Login Dashboard (Gerbang Keamanan UI)

Sejak fitur ini ditambahkan, dashboard **tidak bisa dibuka sama sekali**
tanpa login — ini lapisan keamanan terpisah dari API key, dan melindungi
antarmuka UI-nya sendiri (bukan cuma endpoint API).

- **Kunjungan pertama**: karena belum ada password dashboard sama sekali,
  halaman Login akan menampilkan form **"Buat Password Dashboard"**. Isi
  password (min. 8 karakter), ulangi, submit — Anda langsung masuk dan
  password tersebut jadi kunci dashboard untuk seterusnya.
- **Kunjungan berikutnya** (browser/perangkat lain, atau setelah sesi
  habis): form login biasa, minta password yang sama.
- Sesi login disimpan di `sessionStorage` (bukan `localStorage`) — otomatis
  hilang saat tab/browser ditutup, dan kedaluwarsa otomatis setelah 12 jam
  di server.
- Ada proteksi brute-force sederhana: 5x percobaan password salah dari IP
  yang sama akan dikunci selama 5 menit.
- Lupa password dashboard? Reset langsung dari database (ganti
  `freegw_postgres` kalau memakai nama container lain):
  ```bash
  docker exec -it freegw_postgres psql -U freegw -d freegw_gateway \
    -c "DELETE FROM dashboard_auth; DELETE FROM dashboard_sessions;"
  ```
  Setelah itu, kunjungan berikutnya ke dashboard akan kembali menampilkan
  form "Buat Password Dashboard" seperti pertama kali instal.

Login ini **terpisah total** dari API key di halaman Settings — API key
tetap dipakai backend untuk otentikasi request `POST /api/v1/messages/send`
dan endpoint lain dari aplikasi eksternal (PHP, Node, dsb), sedangkan
password dashboard hanya menggerbangi siapa saja yang boleh membuka
antarmuka web-nya.



## 4. Alur Kirim Pesan (contoh)

```bash
curl -X POST http://localhost:3000/api/v1/messages/send \
  -H "Authorization: Bearer fgw_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "instance_id": "<device-id-dari-halaman-Perangkat>",
    "recipient": "6281234567890",
    "type": "text",
    "content": { "text": "Kode OTP Anda: 93821" }
  }'
```

Response `202 Accepted` berisi `job_id` dan `message_id` — pesan langsung
masuk antrean Redis (BullMQ), diproses worker dengan jeda acak 2–5 detik per
perangkat (menghindari deteksi spam WhatsApp), dan retry otomatis hingga 3x
dengan exponential backoff jika gagal transient.

## 4a. Migrasi dari Gateway WA Lama (Legacy Compatibility Layer)

Kalau Anda punya web app lama yang sudah terhubung ke gateway WA bergaya
`x-api-key` + `/send-message`, `/send-media`, `/status`, dsb — FREE GW
menyediakan **layer kompatibilitas** yang meniru persis kontrak API
tersebut, jadi aplikasi lama bisa langsung pakai FREE GW **tanpa ubah kode
sama sekali**, cukup ganti Base URL dan API Key di konfigurasinya.

Dokumentasi lengkap endpoint-nya (format sama seperti dokumentasi gateway
lama Anda): **[`API_LEGACY_COMPAT.txt`](./API_LEGACY_COMPAT.txt)**.

Kalau API key lama Anda ter-hardcode di kode aplikasi dan tidak praktis
diubah, saat Generate Key di Settings centang **"Pakai key kustom"** dan
tempelkan persis key lama tersebut — FREE GW akan mendaftarkannya apa
adanya, jadi aplikasi lama hanya perlu diarahkan ke Base URL baru, tanpa
menyentuh baris kode terkait API key sama sekali.

Endpoint yang didukung: `GET /status`, `POST /send-message`,
`POST /send-button` (otomatis jadi teks biasa — WhatsApp modern tidak lagi
mendukung tombol interaktif), `POST /send-media`, `POST /send-bulk`,
`POST /validate-number`, `GET /groups`, `POST /set-webhook`,
`POST /send-file`, `POST /send-base64`, `POST /device/reset`.

> **Penting untuk instalasi yang sudah ada**: layer ini menambah kolom
> `default_device_id` ke tabel `api_configs`. Jalankan migrasi sekali lagi
> setelah update kode:
> ```bash
> cd backend && npm run migrate
> ```

## 4b. Jeda Anti-Banned & Zona Waktu (dari Dashboard)

Sejak fitur ini ditambahkan, jeda pengiriman (F-BE-202) tidak lagi cuma bisa
diatur lewat `backend/.env` — bisa diubah langsung dari **Settings → 3. Jeda
Pengiriman & Zona Waktu**, berlaku seketika tanpa restart server (disimpan
di tabel `gateway_settings`, dengan guardrail minimum 500ms supaya tidak
sengaja mematikan proteksi anti-banned-nya).

Di bagian yang sama juga ada pilihan **Zona Waktu Tampilan** untuk kolom
Waktu di Dashboard & Riwayat Pesan: Otomatis (ikuti timezone browser), WIB/
WITA/WIT, atau ikut persis timezone server. Preferensi ini tersimpan per
browser (localStorage), jadi setiap orang yang buka dashboard bisa pilih
sendiri tanpa memengaruhi tampilan orang lain.

## 5. Pemetaan Fitur PRD → Kode

| Requirement PRD | Implementasi |
|---|---|
| F-BE-101 QR via WebSocket | `backend/src/whatsapp/instanceManager.ts` + `backend/src/ws/qrSocket.ts` |
| F-BE-102 Session persistence terenkripsi | `backend/src/whatsapp/authStore.ts` + `backend/src/lib/crypto.ts` (AES-256-GCM) |
| F-BE-103 Lifecycle actions | `POST /api/v1/devices/:id/{initialize,logout,restart}`, `GET /:id/status` |
| F-BE-201/202/203 Queue, delay, retry | `backend/src/queue/messageQueue.ts` |
| F-BE-301 Bearer auth | `backend/src/middleware/auth.ts` |
| Login gate dashboard (tambahan, bukan dari PRD asli) | `backend/src/routes/dashboardAuth.ts` + `frontend/login.html` |
| F-BE-302 Messaging dispatch | `POST /api/v1/messages/send` di `backend/src/routes/messages.ts` |
| F-BE-401/402 Webhook dispatcher | `backend/src/queue/webhookQueue.ts`, terpicu dari event Baileys di `instanceManager.ts` |
| Modul Dashboard (3.1) | `frontend/index.html` + `backend/src/routes/dashboard.ts` |
| Modul Device Management (3.2) | `frontend/devices.html` + `backend/src/routes/devices.ts` |
| Modul Message Logs (3.3) | `frontend/logs.html` + `GET/POST /api/v1/messages/logs*` |
| Modul API Settings & Webhooks (3.4) | `frontend/settings.html` + `backend/src/routes/apiKeys.ts` |
| Legacy Compat Layer (tambahan, bukan dari PRD asli) | `backend/src/routes/compat.ts` + `backend/src/middleware/compatAuth.ts` + `backend/src/services/messageService.ts` — lihat [`API_LEGACY_COMPAT.txt`](./API_LEGACY_COMPAT.txt) |
| NFR-BE-501 Enkripsi at rest | `auth_secret` terenkripsi AES-256-GCM sebelum disimpan ke Postgres |
| NFR-BE-503 Auto-healing reconnect | Listener `connection.update` di `instanceManager.ts`, reconnect terjadwal setiap `SOCKET_HEALTHCHECK_INTERVAL_MS` |

## 6. Catatan Penting

- **Library headless**: implementasi memakai
  [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys),
  yang berkomunikasi langsung lewat protokol WebSocket WhatsApp Web (tanpa
  Puppeteer/Chromium), sehingga jauh lebih ringan untuk dijalankan di
  aaPanel/VPS dibanding `whatsapp-web.js`. Jika Anda tetap ingin memakai
  `whatsapp-web.js`, bagian yang perlu diganti hanya `instanceManager.ts` dan
  `authStore.ts` — kontrak REST API/queue/webhook tidak perlu berubah.
- **Risiko pemblokiran nomor**: WhatsApp dapat memblokir nomor yang terdeteksi
  melakukan automasi massal. Gunakan jeda pengiriman yang wajar (sudah
  di-default 2–5 detik/pesan sesuai PRD), hindari broadcast ke nomor yang
  belum pernah berinteraksi, dan pertimbangkan WhatsApp Business API resmi
  untuk volume produksi yang sangat tinggi.
- **Scaling ke 50–100 pesan/detik** (target NFR 4.2 di PRD utama) dicapai
  dengan menjalankan beberapa *instance* backend (masing-masing memegang
  device WhatsApp berbeda) di belakang load balancer, semuanya berbagi Redis
  dan PostgreSQL yang sama.
- Endpoint bootstrap (`POST /api/v1/auth/keys` tanpa token) **hanya aktif
  selama tabel `api_configs` kosong**. Setelah key pertama dibuat, seluruh
  endpoint `/api/v1/auth/*` otomatis mewajibkan Bearer token seperti endpoint
  lainnya.
