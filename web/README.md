# LokalBiz AI Web

UI MVP LokalBiz AI berada terpisah dari backend di direktori `web/`, sehingga dependensi dan perubahan antarmuka tidak mengganggu pekerjaan API.

Jalankan backend sesuai petunjuk pada README proyek, lalu di terminal lain jalankan:

```bash
cd web
npm install
npm run dev
```

Frontend selalu memakai path same-origin `/api`. Vite hanya meneruskan request ke backend HTTP di loopback; target eksternal ditolak. `npm run local` dari root repo menyesuaikan proxy dengan `PORT` backend.

Saat pertama membuka UI, buat akun atau masuk menggunakan email dan kata sandi. Browser mengelola sesi melalui cookie `HttpOnly`; frontend mengirim request dengan `credentials: 'include'` dan tidak membaca atau menyimpan token sesi di Web Storage. Frontend mengambil CSRF token dari `GET /api/auth/csrf`, menyimpannya hanya di memori halaman, dan mengirimkannya melalui `X-CSRF-Token` pada request mutasi. Keluar memakai `POST /api/auth/logout`.

Setelah autentikasi berhasil, UI mencari ruang usaha lewat `GET /api/businesses/current`; jika belum ada, UI meminta nama usaha dan zona waktunya.

UI memakai data dari API, tidak menampilkan angka contoh. Produk arsip dapat dipindahkan ke arsip, tetapi endpoint daftar backend hanya mengembalikan produk aktif; halaman arsip belum tersedia di kontrak API saat ini.
