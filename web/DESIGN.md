# Arah desain LokalBiz AI

## Design Read

Aplikasi operasional untuk pemilik toko kecil, usaha kuliner, dan bisnis lokal di Indonesia, dengan bahasa visual pembukuan yang rapi dan praktis. Dials: ENERGY 1 / RHYTHM 2 / MOTION 1.

## Keputusan visual

- **Palet:** hijau daun tua menjadi warna tindakan utama karena mudah dikenali sebagai tindakan yang aman; latar hangat menyerupai halaman buku catatan agar tabel dan angka tetap nyaman dibaca; amber hanya menandai stok yang perlu perhatian. Status gagal memakai warna merah semantik.
- **Tipografi:** system sans agar cepat dirender tanpa font unduhan dan tetap jelas pada perangkat pemilik usaha; angka memakai fitur tabular agar nominal sejajar.
- **Komposisi:** navigasi samping pada layar lebar dan navigasi bawah pada ponsel menjaga lima pekerjaan utama selalu mudah dijangkau. Ringkasan menonjolkan pendapatan periode dan kondisi stok, bukan deretan metrik yang tidak membantu keputusan.
- **Motif identitas:** garis buku kas pada ringkasan transaksi dan penanda baris aktif menunjukkan hubungan dengan pencatatan usaha; penanda warna hanya dipakai untuk state aktif atau peringatan.
- **Ritme:** susunan daftar dan tabel dibuat konsisten untuk pekerjaan rutin, sementara layar Ringkasan dan Jual memakai komposisi yang berbeda sesuai keputusan pengguna.
- **Gerak:** hanya hover, fokus, dan perubahan state singkat; gerak non-esensial dihentikan saat `prefers-reduced-motion` aktif.
- **Tema:** tema terang menjadi awal karena layar berisi data dan formulir; sakelar tema gelap tetap tersedia, dengan token kontras yang terpisah dan setara.
- **Aset:** tidak ada logo, foto profil, atau gambar stok. Nama produk tampil sebagai teks sampai pemilik meminta identitas visual khusus.
