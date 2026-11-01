# LokalBiz AI

MVP web mobile-first untuk satu usaha dan satu pemilik. Backend memakai TypeScript, Express 5, dan SQLite bawaan Node.js; frontend memakai React dan Vite. Mata uang IDR, dan tanggal laporan mengikuti zona waktu usaha.

## Menjalankan di komputer lokal

Perlu Node.js 22.13 atau lebih baru. Setelah clone, jalankan dari direktori utama repo:

```bash
npm install
npm install --prefix web
cp .env.example .env
```

Di Windows PowerShell, gunakan `Copy-Item .env.example .env` untuk menyalin file contoh. Buat secret acak dengan Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Masukkan hasilnya ke `AUTH_JWT_SECRET` di `.env`. Jangan commit `.env` atau membagikan secret itu.

`APP_ORIGINS` pada `.env.example` sudah sesuai dengan alamat web lokal `http://127.0.0.1:5173`. Gunakan alamat tersebut saat membuka aplikasi agar pemeriksaan origin dan CSRF cocok.

### Pilih database lokal

SQLite tetap pilihan bawaan. Biarkan `DB_DRIVER=sqlite` dan `DATABASE_PATH=./data/lokalbiz.sqlite` di `.env`; tidak perlu menyalakan service database terpisah.

Untuk memakai MySQL dari XAMPP atau Laragon, nyalakan service MySQL dan buat database kosong terlebih dahulu. Lalu ubah `.env` menjadi `DB_DRIVER=mysql` dan isi `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, serta `MYSQL_DATABASE` dengan koneksi lokalmu. Default host dan port adalah `127.0.0.1` dan `3306`; hanya host loopback (`localhost`, `127.0.0.1`, atau `::1`) yang didukung, sedangkan host lain ditolak.

SQLite dan MySQL memakai skema masing-masing. Mengganti `DB_DRIVER` tidak memindahkan atau menyinkronkan data antardatabase. Migrasi skema berjalan saat aplikasi mulai; konfigurasi yang salah atau belum lengkap akan menghentikan startup.

Alur MySQL sudah lulus uji integrasi pada MariaDB 10.11.14 lokal, yang kompatibel dengan jalur MariaDB di XAMPP. Pengujian tidak dijalankan langsung pada instalasi XAMPP atau Laragon, jadi pastikan layanan dan kredensial database lokalmu cocok dengan konfigurasi di atas.

### Jalankan aplikasi

```bash
npm run local
```

Buka `http://127.0.0.1:5173`. Perintah ini menyalakan web dan API hanya di laptopmu (`127.0.0.1`); tekan `Ctrl+C` untuk menghentikan keduanya. Jika memilih MySQL, pastikan XAMPP atau Laragon tetap menjalankan MySQL. Gemini dipaksa nonaktif pada mode lokal.

### 3. Isi demo dengan data sintetis

Aplikasi tidak mengisi akun atau data contoh secara otomatis. Buat akun, buat usaha, lalu tambahkan produk dan transaksi fiktif untuk mencoba stok, laporan, prediksi, dan void. Gunakan data sintetis saja untuk portofolio; jangan masukkan data usaha nyata.

Mode lokal `npm run local` selalu memaksa assistant summary nonaktif. Jangan aktifkan Gemini untuk data usaha nyata; key atau pengaturan provider tidak boleh dimasukkan ke Git.

## Tes dan build

Dari direktori utama, jalankan tes dan pemeriksaan backend:

```bash
npm test
npm run typecheck
npm run build
```

Untuk build frontend:

```bash
cd web
npm run build
```

## Catatan teknis

- Sesi login memakai cookie `HttpOnly` selama 12 jam. Mutasi memerlukan CSRF token; `POST /api/auth/logout` mencabut sesi.
- Database lokal berada di `./data/lokalbiz.sqlite`; migrasi skema berjalan saat server mulai.
- Penjualan, penyesuaian stok, dan void memakai transaksi database atomik pada SQLite (driver default) maupun MySQL lokal. Jika stok tidak cukup, seluruh penjualan dibatalkan. Harga dan nama produk disalin ke snapshot transaksi.
- Penjualan mewajibkan `Idempotency-Key`. Void penuh hanya bisa dilakukan sekali, wajib menyertakan alasan, memulihkan stok, dan mempertahankan transaksi berstatus `VOIDED`.
- Lihat [kontrak API](docs/API.md) untuk produk, stok, transaksi, laporan, prediksi 30 hari, dan assistant summary.
- SQLite ditujukan untuk MVP satu host/proses. Jangan simpan file SQLite di filesystem yang tidak menjamin locking; untuk beberapa host atau throughput lebih tinggi, pindahkan persistensi ke PostgreSQL dengan invariant API yang sama.
