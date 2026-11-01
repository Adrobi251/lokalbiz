# LokalBiz AI — fondasi backend MVP

Backend REST untuk satu usaha dan satu pemilik. API memakai TypeScript, Express 5, dan SQLite bawaan Node.js 22.13+; SQLite memberi transaksi atomik tanpa service database tambahan untuk MVP. Mata uang IDR dan tanggal laporan mengikuti zona waktu usaha.

## Menjalankan

```bash
cp .env.example .env
# Ganti AUTH_JWT_SECRET dengan nilai acak minimal 32 byte.
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

Daftar akun lewat `POST /api/auth/register` dan masuk lewat `POST /api/auth/login`. Backend menerbitkan JWT HS256 12 jam dalam cookie `HttpOnly`, menolak mutasi tanpa CSRF token, dan menyediakan `POST /api/auth/logout` untuk mencabut sesi. Untuk pengembangan lokal, `APP_ORIGINS` harus memuat origin frontend yang tepat. Setelah masuk, `GET /api/businesses/current` menemukan usaha aktif; jika belum ada, buat lewat `POST /api/businesses`. Semua data usaha berada di `/api/businesses/{businessId}/...` dan dibatasi berdasarkan membership. SQLite lokal berada di `./data/lokalbiz.sqlite`; migrasi skema dijalankan otomatis saat server mulai.

Penjualan, penyesuaian stok, dan void menggunakan transaksi tulis `BEGIN IMMEDIATE`. Bila satu item kurang stok, seluruh penjualan rollback. Nama dan harga jual disalin ke snapshot item. Produk arsip tidak dapat dijual, tetapi histori transaksi tetap menampilkan snapshot. Setiap produk mencatat stok awal sebagai `StockMovement` beralasan `INITIAL_STOCK`, termasuk bila jumlahnya nol; penyesuaian manual meminta `newQuantity` dan alasan.

Penjualan mewajibkan `Idempotency-Key`. Hash payload dan respons tersimpan bersama transaksi dalam database yang sama; retry dengan key/payload sama mengembalikan transaksi pertama, sedangkan key sama dengan payload berbeda ditolak. Void penuh hanya sekali, wajib alasan, memulihkan stok atomik, dan mempertahankan transaksi berstatus `VOIDED`.

Lihat [kontrak API](docs/API.md) untuk bentuk final respons produk, stok, transaksi, laporan, prediksi 30 hari, dan assistant summary.

SQLite sesuai untuk MVP satu host/proses. Untuk beberapa host atau throughput lebih tinggi, pindahkan persistensi ke PostgreSQL dengan invariant API yang sama. Jangan simpan file SQLite di filesystem yang tidak menjamin locking.

Assistant summary menggunakan interface provider injeksi. Tanpa transaksi selesai, respons menyatakan `dataStatus:"INSUFFICIENT_DATA"`; jika ada transaksi tetapi provider belum dikonfigurasi, endpoint memberi 503. Integrasi Gemini Free opsional lewat 9Router lokal hanya aktif ketika gate `LOCAL_GEMINI_SUMMARY_ENABLED=true` dan seluruh pengaturan runtime tersedia. Provider hanya mengirim agregat (`totalRevenue`, `transactionCount`, `unitsSold`) dan menerima teks yang cocok persis dengan template server; periode berasal dari server. Tanpa pengaturan lengkap, data bisnis tidak dikirim ke penyedia eksternal.
