# API MVP LokalBiz AI

## Autentikasi

`POST /api/auth/register` dan `POST /api/auth/login` menerima `{ "email": "pemilik@example.com", "password": "minimal-8-karakter" }`. Email di-trim dan dinormalisasi menjadi lowercase; password minimal 8 karakter. Register sukses dengan HTTP 201 dan login dengan HTTP 200; body keduanya tepat `{ "data": { "user": { "id": "<userId>", "email": "pemilik@example.com" } } }`. JWT HS256 12 jam tidak dikirim dalam body: server menetapkannya pada cookie `lokalbiz_session` dengan `HttpOnly; SameSite=Lax; Path=/`, `Secure` saat `NODE_ENV=production`, dan masa hidup 12 jam. Password disimpan sebagai hash scrypt bersalt acak dan tidak pernah plaintext. Login/register mewajibkan `Origin` atau `Referer` yang origin-nya tercantum persis dalam `APP_ORIGINS` (daftar origin dipisahkan koma, tanpa path); `Host` tidak dipakai untuk menentukan kepercayaan. Email duplikat menghasilkan 409 `EMAIL_ALREADY_REGISTERED`; login untuk email tidak dikenal maupun password salah menghasilkan 401 `INVALID_CREDENTIALS` dengan pesan generik; input invalid menghasilkan 422 `VALIDATION_ERROR`.

Batas autentikasi yang aktif: pendaftaran menerima maksimal **5 permintaan valid per IP dalam 1 jam**; login menerima maksimal **30 permintaan per IP dalam 15 menit** dan **10 permintaan per pasangan email ternormalisasi + IP dalam 15 menit**. Kedua bucket login berlaku sekaligus. Permintaan yang lolos pemeriksaan origin dan validasi input dihitung, termasuk login berhasil dan email daftar yang sudah terpakai. Jendelanya tetap sejak permintaan pertama di jendela tersebut. Setelah ambang terlampaui, server mengembalikan HTTP 429 dengan `{ "error": { "code": "AUTH_RATE_LIMITED", "message": "Terlalu banyak percobaan autentikasi. Coba lagi nanti." } }` serta header `Retry-After` dalam detik. Tunggu sampai jendela terkait berakhir sebelum mencoba lagi.

Bucket disimpan di database aktif agar tetap berlaku setelah proses server dimulai ulang. Nilai IP dan email tidak disimpan mentah; kunci bucket adalah HMAC-SHA-256 dengan `AUTH_JWT_SECRET`. Perubahan `AUTH_JWT_SECRET` membuat identitas bucket baru. Secara default (`TRUST_PROXY_HOPS=0`), alamat IP diambil dari koneksi langsung dan header `X-Forwarded-For` tidak dipercaya. Jika server berada di belakang proxy, atur `TRUST_PROXY_HOPS` ke jumlah hop proxy tepercaya yang tepat dan batasi akses jaringan agar klien tidak dapat mengakses server langsung atau memalsukan rantai forwarded. Proses yang memakai database yang sama berbagi hitungan; proses dengan database terpisah memiliki bucket berbeda. Batas email+IP ini mengurangi percobaan berulang dari satu sumber, bukan perlindungan penuh terhadap serangan terdistribusi dari banyak IP.

Browser mengirim request dengan credentials agar cookie terikut. Untuk mendapatkan CSRF token, setelah login/register panggil `GET /api/auth/csrf` dengan cookie sesi; respons HTTP 200 berbentuk `{ "data": { "csrfToken": "<token>" } }`. UI menyimpan CSRF token hanya di memori halaman dan mengirimkannya sebagai `X-CSRF-Token` pada setiap `POST`, `PATCH`, dan `DELETE` dengan cookie, termasuk logout. Mutasi cookie-session juga harus menyertakan `Origin`/`Referer` yang diizinkan oleh `APP_ORIGINS`; origin dan token CSRF yang salah atau hilang ditolak. CORS hanya mengizinkan origin terdaftar dan credentials.

`POST /api/auth/logout` memerlukan sesi cookie aktif, origin yang diizinkan, dan CSRF token valid. Server menandai `jti` sebagai revoked di database aktif, menghapus cookie dengan atribut yang sama dan `Max-Age=0`, lalu mengembalikan `204 No Content`. Revokasi tetap berlaku setelah server restart; request dengan JWT yang sudah dicabut ditolak. Endpoint data masih menerima `Authorization: Bearer <token>` untuk klien non-browser lama; sesi browser menggunakan cookie.

## Database dan transaksi

API publik sama untuk kedua driver database. `DB_DRIVER=sqlite` adalah pilihan bawaan; `DB_DRIVER=mysql` memakai MySQL lokal melalui konfigurasi `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, dan `MYSQL_DATABASE`. Pengguna menyalakan service MySQL/MariaDB lokal dan membuat database terlebih dahulu. `MYSQL_HOST` hanya boleh `localhost`, `127.0.0.1`, atau `::1`; host non-loopback ditolak sebelum koneksi dibuka.

Kedua driver memakai set migrasi terpisah: SQLite memakai `migrations/*.sql`, sedangkan MySQL memakai `migrations/mysql/*.sql`. Saat startup, aplikasi menjalankan migrasi untuk driver dan database yang dipilih. Mengganti driver tidak menyalin atau memindahkan data antardatabase.

Pembuatan penjualan, penyesuaian stok, dan void memakai transaksi database atomik pada kedua driver; jika suatu langkah gagal, seluruh perubahan terkait dibatalkan. Jalur MySQL lulus uji integrasi dan alur API sintetis pada MariaDB 10.11.14 lokal. Pengujian tersebut tidak dijalankan langsung pada instalasi XAMPP atau Laragon, dan bukan klaim pengujian Oracle MySQL 8.

## Aturan umum

Semua endpoint data usaha memakai prefix `/api/businesses/{businessId}`. Route onboarding adalah `GET /api/businesses/current`, yang mencari usaha aktif berdasarkan user dari sesi JWT dan `POST /api/businesses`, yang membuat usaha pertama untuk user login. Backend memverifikasi JWT HS256 dari `AUTH_JWT_SECRET`, memastikan `jti` memiliki sesi aktif yang belum kedaluwarsa atau dicabut, mengambil user dari claim `sub`, lalu memastikan `businessId` pada path cocok dengan keanggotaan `OWNER` aktif. Jangan mengirim atau mempercayai ID usaha dari body sebagai pengganti pemeriksaan ini. Request JSON dibatasi 64 KB.

Semua error berbentuk `{ "error": { "code": "...", "message": "...", "details": ... } }`; `details` hanya muncul bila ada. Error umum: `400` request/header wajib tidak ada atau JSON rusak; `401` token tidak ada/tidak valid/kedaluwarsa; `403` tidak memiliki keanggotaan aktif; `404` usaha/path/resource tidak ditemukan; `413` payload terlalu besar; `422` validasi atau batas nilai; `429` batas autentikasi terlampaui; `500` kegagalan server; `503` konfigurasi autentikasi/provider belum tersedia. Nilai uang selalu integer rupiah dan currency `IDR`.

| Operasi | Sukses | Error spesifik yang dapat dikembalikan |
|---|---:|---|
| `POST /api/auth/register` | 201 | 403 `ORIGIN_NOT_ALLOWED`; 409 `EMAIL_ALREADY_REGISTERED`; 422 `VALIDATION_ERROR`; 429 `AUTH_RATE_LIMITED` |
| `POST /api/auth/login` | 200 | 401 `INVALID_CREDENTIALS`; 403 `ORIGIN_NOT_ALLOWED`; 422 `VALIDATION_ERROR`; 429 `AUTH_RATE_LIMITED` |
| `GET /api/auth/csrf` | 200 | 401 `UNAUTHENTICATED`, `COOKIE_SESSION_REQUIRED`; 401 `INVALID_TOKEN` |
| `POST /api/auth/logout` | 204 | 401 `UNAUTHENTICATED`, `COOKIE_SESSION_REQUIRED`, `INVALID_TOKEN`; 403 `ORIGIN_NOT_ALLOWED`, `CSRF_TOKEN_INVALID` |
| `POST /api/businesses` | 201 | 409 `BUSINESS_ALREADY_EXISTS`; 422 `VALIDATION_ERROR`, `INVALID_TIME_ZONE` |
| `GET /api/businesses/current` | 200 | 404 `BUSINESS_NOT_FOUND` |
| `GET /api/businesses/{businessId}` | 200 | 403 `BUSINESS_MEMBERSHIP_REQUIRED`; 404 `BUSINESS_NOT_FOUND` |
| `GET /api/businesses/{businessId}/products` | 200 | 422 `VALIDATION_ERROR` |
| `POST /api/businesses/{businessId}/products` | 201 | 409 `SKU_ALREADY_EXISTS`; 422 `VALIDATION_ERROR` |
| `GET /api/businesses/{businessId}/products/{productId}` | 200 | 404 `PRODUCT_NOT_FOUND`; 422 `VALIDATION_ERROR` |
| `PATCH /api/businesses/{businessId}/products/{productId}` | 200 | 404 `PRODUCT_NOT_FOUND`; 409 `SKU_ALREADY_EXISTS`; 422 `VALIDATION_ERROR` |
| `POST /api/businesses/{businessId}/products/{productId}/stock-adjustments` | 201 | 404 `PRODUCT_NOT_FOUND`; 422 `VALIDATION_ERROR`, `NO_STOCK_CHANGE` |
| `GET /api/businesses/{businessId}/inventory/alerts` | 200 | — |
| `GET /api/businesses/{businessId}/inventory/forecasts` | 200 | 422 `VALIDATION_ERROR`, `INVALID_FORECAST_WINDOW` |
| `GET /api/businesses/{businessId}/reports/sales` | 200 | 422 `VALIDATION_ERROR`, `INVALID_DATE`, `INVALID_DATE_RANGE`, `DATE_RANGE_TOO_LARGE`, `AGGREGATE_OUT_OF_RANGE` |
| `GET /api/businesses/{businessId}/transactions` | 200 | 422 `VALIDATION_ERROR`, `INVALID_DATE`, `INVALID_DATE_RANGE` |
| `POST /api/businesses/{businessId}/transactions` | 201 | 400 `IDEMPOTENCY_KEY_REQUIRED`; 404 `PRODUCT_NOT_FOUND`; 409 `PRODUCT_ARCHIVED`, `INSUFFICIENT_STOCK`, `IDEMPOTENCY_KEY_REUSED`; 422 `VALIDATION_ERROR`, `AMOUNT_OUT_OF_RANGE` |
| `GET /api/businesses/{businessId}/transactions/{transactionId}` | 200 | 404 `TRANSACTION_NOT_FOUND`; 422 `VALIDATION_ERROR` |
| `POST /api/businesses/{businessId}/transactions/{transactionId}/void` | 200 | 404 `TRANSACTION_NOT_FOUND`; 409 `TRANSACTION_ALREADY_VOIDED`; 422 `VALIDATION_ERROR` |
| `POST /api/businesses/{businessId}/assistant/summaries` | 200 | 422 `VALIDATION_ERROR`, `INVALID_DATE`, `INVALID_DATE_RANGE`; 503 `AI_SUMMARY_NOT_CONFIGURED` |

Status dan kode autentikasi/konfigurasi umum yang juga dapat berlaku pada endpoint adalah 401 `UNAUTHENTICATED`/`INVALID_TOKEN`, 403 `BUSINESS_MEMBERSHIP_REQUIRED`, 404 `BUSINESS_NOT_FOUND`, 413 `PAYLOAD_TOO_LARGE`, 500 `INTERNAL_SERVER_ERROR`, serta 503 `AUTH_NOT_CONFIGURED`. Endpoint tenant yang dipanggil tanpa prefix kanonis mengembalikan 404 `BUSINESS_PATH_REQUIRED`.

## Bentuk umum daftar

Daftar produk dan transaksi memakai pagination berikut. Default `page=1`, `pageSize=20`; `pageSize` maksimal 100.

```json
{
  "data": ["<item>"],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 0,
    "totalPages": 0
  }
}
```

## Usaha

`GET /api/businesses/current` menggunakan identitas JWT untuk menemukan usaha aktif milik user, tanpa menerima `businessId` dari klien. Sukses HTTP 200 mengembalikan `{data:{id,name,currency:"IDR",timeZone,createdAt}}`; jika user belum memiliki usaha, hasilnya 404 `BUSINESS_NOT_FOUND`. `POST /api/businesses` menerima `{ "name": "Warung", "timeZone": "Asia/Jakarta" }`. `name` wajib 1–120 karakter; `timeZone` harus zona waktu IANA valid. Sukses HTTP 201 mengembalikan bentuk data usaha yang sama. Setiap user hanya dapat membuat satu usaha pada MVP. `GET /api/businesses/{businessId}` juga mengembalikan bentuk data usaha yang sama setelah memverifikasi keanggotaan aktif.

## Produk, stok, dan alert

`GET /api/businesses/{businessId}/products?search=&page=1&pageSize=20` mencari substring nama/SKU pada produk aktif dan mengembalikan daftar terpaginasikan. `POST /api/businesses/{businessId}/products` menerima `{name,sku?,sellingPrice,initialStock?,minStock?}`. `name` 1–160 karakter, `sku` maksimal 80 karakter, `sellingPrice` integer 0–9.000.000.000.000, dan jumlah stok/batas minimum integer 0–1.000.000. Default `initialStock=0`, `minStock=5`. Setiap pembuatan produk mencatat StockMovement `INITIAL` dengan alasan sistem `INITIAL_STOCK`, termasuk bila jumlah awal nol. Sukses HTTP 201 mengembalikan produk.

Bentuk produk: `{id,name,sku,sellingPrice,currency:"IDR",stockQuantity,minStock,isArchived,createdAt,updatedAt}`. `GET /api/businesses/{businessId}/products/{productId}` mengembalikan `{data:<produk>}`; produk arsip tidak tersedia pada katalog/detail produk. `PATCH` pada path yang sama menerima satu atau lebih dari `{name,sku,sellingPrice,minStock,isArchived}`. Tidak ada field stok pada PATCH. Sukses HTTP 200 mengembalikan `{data:<produk>}`.

`POST /api/businesses/{businessId}/products/{productId}/stock-adjustments` menerima `{newQuantity,reason}`. `newQuantity` adalah jumlah akhir nonnegatif maksimal 1.000.000; `reason` wajib 1–500 karakter. Sukses HTTP 201:

```json
{
  "data": {
    "id": "<movementId>",
    "productId": "<productId>",
    "stockQuantity": 5,
    "movement": {
      "id": "<movementId>",
      "type": "ADJUSTMENT",
      "previousQuantity": 2,
      "quantityDelta": 3,
      "newQuantity": 5,
      "reason": "Hitung stok rak",
      "createdAt": "<ISO-8601>"
    }
  }
}
```

Delta dihitung server; request tanpa perubahan stok ditolak sebagai 422 `NO_STOCK_CHANGE`. Perubahan saldo dan StockMovement dicatat atomik.

`GET /api/businesses/{businessId}/inventory/alerts` mengembalikan `{data:{items:[{type,productId,productName,stockQuantity,minStock}],totalItems}}`. Peringatan aktif jika `stockQuantity <= minStock`; `type` bernilai `OUT_OF_STOCK` pada stok nol dan `LOW_STOCK` pada stok positif. Produk arsip dikecualikan.

## Transaksi, idempotensi, dan void

`POST /api/businesses/{businessId}/transactions` menerima header `Idempotency-Key` (1–128 karakter) dan body `{ "items": [{ "productId": "<UUID>", "quantity": 2 }] }`. Item berjumlah 1–100; setiap quantity integer positif maksimal 1.000.000; setiap productId hanya boleh muncul sekali. Klien tidak mengirim harga atau total. Server mengambil harga aktif terbaru, menyimpan snapshot nama/harga `unitPrice`, menghitung `lineTotal`/`totalAmount`, membuat transaksi/item, mencatat gerakan stok, dan mengurangi stok atomik.

Sukses HTTP 201:

```json
{
  "data": {
    "id": "<transactionId>",
    "status": "COMPLETED",
    "createdAt": "<ISO-8601>",
    "currency": "IDR",
    "items": [{
      "productId": "<UUID>",
      "productName": "Kopi",
      "quantity": 2,
      "unitPrice": 2500,
      "lineTotal": 5000
    }],
    "totalAmount": 5000
  }
}
```

Stok kurang menghasilkan HTTP 409 `{error:{code:"INSUFFICIENT_STOCK",message,details:{items:[{productId,available,requested}]}}}`; seluruh perubahan rollback. Produk arsip menghasilkan 409 `PRODUCT_ARCHIVED`. Key sama dan payload sama mengembalikan respons transaksi pertama; key sama dan payload berbeda menghasilkan 409 `IDEMPOTENCY_KEY_REUSED`.

`GET /api/businesses/{businessId}/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&status=COMPLETED|VOIDED&page=1&pageSize=20` menerima filter opsional `from`, `to`, `status`, `page`, `pageSize`. Tanggal ditafsirkan menurut zona usaha; `from` inklusif dan `to` eksklusif. Setiap item daftar berbentuk `{id,status,createdAt,currency,totalAmount,voidedAt,voidReason}`. `GET /api/businesses/{businessId}/transactions/{transactionId}` mengembalikan `{data:{id,status,createdAt,currency,totalAmount,voidedAt,voidReason,items:[{productId,productName,quantity,unitPrice,lineTotal}]}}`; `voidedAt` dan `voidReason` bernilai `null` sebelum void. Histori tetap menggunakan snapshot lama walau produk diubah atau diarsipkan.

`POST /api/businesses/{businessId}/transactions/{transactionId}/void` menerima `{ "reason": "Salah input kasir" }`; alasan wajib 1–500 karakter. Void penuh hanya sekali. Sukses HTTP 200 mengembalikan detail transaksi lengkap dengan bentuk yang sama seperti endpoint detail, status `VOIDED`, `voidedAt` terisi, dan `voidReason` berisi alasan. Pemulihan stok, gerakan `VOID`, dan perubahan status atomik. Void kedua ditolak dengan 409 `TRANSACTION_ALREADY_VOIDED`; refund parsial tidak tersedia.

## Laporan, prediksi, dan assistant summary

`GET /api/businesses/{businessId}/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD` mewajibkan kedua tanggal dan memakai rentang `[from,to)` menurut zona waktu usaha, maksimal 366 hari. Respons HTTP 200 berbentuk `{data:{period:{from,to,startAt,endAt,timeZone},currency:"IDR",totalRevenue,transactionCount,unitsSold,dailyRevenue,topProducts}}`. `totalRevenue` adalah pendapatan kotor dari transaksi `COMPLETED`; transaksi `VOIDED` dikecualikan. `dailyRevenue` memiliki satu item per tanggal lokal termasuk nol: `{date,totalRevenue,transactionCount}`. `topProducts` berisi maksimal lima `{productId,productName,quantitySold,revenue}`, diurutkan kuantitas lalu revenue.

`GET /api/businesses/{businessId}/inventory/forecasts?windowDays=30` menggunakan jendela tepat 30 hari. `windowDays` default 30; nilai lain ditolak 422 `INVALID_FORECAST_WINDOW`. Respons `{data:{from,to,timeZone,items:[...]}}`; tiap item memuat `{productId,productName,stockQuantity,averageUnitsPerDay,estimatedDaysRemaining,insufficientData,historyDays,from,to,status}`. Riwayat produk dibatasi maksimal 30 hari sejak produk dibuat. Jika `historyDays < 14`, status `INSUFFICIENT_DATA`, `insufficientData:true`, rata-rata dan estimasi `null`. Jika cukup riwayat namun laju penjualan nol, status `NO_RECENT_SALES`, rata-rata `0`, estimasi `null`. Selain itu status `READY`; estimasi hari stok dibulatkan satu angka desimal.

`POST /api/businesses/{businessId}/assistant/summaries` menerima `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }` dengan tanggal akhir eksklusif menurut zona usaha. Provider Gemini yang disetujui hanya menerima agregat terhitung server (`totalRevenue`, `transactionCount`, `unitsSold`); tanggal, nama usaha, timezone, dan transaksi mentah tidak dikirim ke model. Respons provider harus tepat cocok dengan template tiga fakta (`summary`, `highlights`) yang dibangun dari agregat; angka, tanggal, tren, hubungan sebab-akibat, saran, atau klaim lain yang tidak ada di format itu ditolak. Sukses HTTP 200 mengembalikan `{data:{period:{from,to,timeZone},summary,dataStatus,highlights}}`; label periode bersumber dari nilai server, bukan output model. `dataStatus` bernilai `READY` jika ada transaksi selesai pada periode, atau `INSUFFICIENT_DATA` bila tidak. Tanpa provider dan tanpa transaksi selesai, endpoint mengembalikan ringkasan status `INSUFFICIENT_DATA`; bila ada transaksi tetapi provider tidak aktif/terkonfigurasi, HTTP 503 `AI_SUMMARY_NOT_CONFIGURED`; jika panggilan atau respons provider gagal/invalid, HTTP 503 `AI_SUMMARY_UNAVAILABLE` tanpa detail credential atau upstream.

Wiring Gemini Free hanya aktif jika `LOCAL_GEMINI_SUMMARY_ENABLED=true` serta `LOCAL_GEMINI_ROUTER_BASE_URL`, `LOCAL_GEMINI_ROUTER_MODEL`, dan `LOCAL_GEMINI_ROUTER_API_KEY` disuntikkan ke environment proses saat startup. URL wajib loopback HTTP dengan path `/v1`; model harus tepat `gemini/gemini-3.5-flash-lite`. Bila konfigurasi tidak lengkap atau tidak cocok, provider tetap nonaktif. Jangan menulis key ke source, `.env.example`, atau log. Provider tidak mencoba model lain. Google Free Tier dapat memakai isi permintaan untuk peningkatan produk; aktifkan hanya dengan persetujuan dan patuhi batas data yang disepakati.

## Jaminan data

Set migrasi SQLite dan MySQL membuat tabel domain yang sama: `business`, `business_membership`, `product`, `stock_movement`, `sales_transaction`, `transaction_item`, dan `idempotency_record`. Foreign key komposit membatasi relasi lintas usaha. Constraint menjaga IDR, nilai uang/stok, snapshot item, status transaksi, alasan void, dan key idempotensi unik per usaha. Penjualan, penyesuaian, dan void memakai transaksi tulis pada driver database aktif; kegagalan membatalkan semua perubahan terkait.
