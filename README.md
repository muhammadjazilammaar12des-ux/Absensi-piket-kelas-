# Absensi Piket Kelas — GitHub Pages

Struktur repository:

```text
/
├─ index.html
├─ manifest.json
├─ sw.js
└─ .nojekyll
```

## Publikasi dengan GitHub Pages

1. Buat repository baru di GitHub.
2. Upload seluruh isi folder ini ke branch `main` pada **root** repository.
3. Buka **Settings → Pages**.
4. Pada **Build and deployment**, pilih **Deploy from a branch**.
5. Pilih branch `main` dan folder `/ (root)`, lalu **Save**.
6. Setelah selesai, buka:
   `https://USERNAME.github.io/NAMA-REPOSITORY/`

## Kamera

Aplikasi kamera memerlukan secure context. GitHub Pages memakai HTTPS, sehingga halaman dapat meminta izin kamera melalui browser utama seperti Chrome/Edge/Safari.

## AI

HTML sudah memiliki fallback:
- library Human dari CDN jsDelivr;
- model AI dari `vladmandic.github.io/human-models`;
- backend WASM TensorFlow dari CDN.

Upload yang diterima pada percakapan ini hanya berisi `index.html`, sehingga folder `lib/` dan `models/` belum dibundel. Artinya versi ini **siap untuk penggunaan online**, tetapi belum merupakan paket AI yang sepenuhnya offline.

## Backend opsional

URL REST API tetap kosong secara default. Aplikasi masih dapat dipakai dalam mode lokal pada perangkat. Backend hanya diperlukan bila data ingin disinkronkan antar-perangkat.
