# Absensi Piket — Recovery v36

## Isi paket

- `index.html` — UI utama
- `app-utils.js` — translation, template helper, DOM-ready helper
- `app-loader.js` — lazy loader Human/JSZip
- `app-main.js` — logika aplikasi, kamera, AI, IndexedDB
- `error-telemetry.js` — runtime error guard
- `manifest.json` — metadata PWA
- `sw.js` — Service Worker dengan cache v36

## Perbaikan utama v36

- Service Worker mencache `manifest.json` dan hanya memakai `index.html` sebagai fallback untuk request navigasi.
- PWA cache dinaikkan ke v36 sehingga cache versi aplikasi lama dibersihkan saat aktivasi.
- Tracker wajah sintetis memakai nearest-center/size matching ketika Human tidak menyediakan `face.id`; ini mencegah liveness reset hanya karena pergeseran kecil.
- Escape menutup modal standar dan modal khusus.
- Object URL preview foto saran dipertahankan sampai preview benar-benar dibersihkan.
- Penurunan resolusi kamera mempertahankan rasio 9:16 / 16:9.
- Prefix Safari untuk `backdrop-filter`.
- Pinch-to-zoom tidak lagi diblokir oleh viewport meta.
- `overscroll-behavior-x: none` ditambahkan untuk mengurangi navigasi horizontal yang tidak disengaja.
- Lifecycle kamera membersihkan `srcObject` dan buffer video.
- Persistent Storage tetap diminta saat bootstrap.
- Wake Lock, canvas synchronization, visibility lifecycle, dan IndexedDB transaction abort handler dipertahankan.

## Deploy

Upload seluruh file paket ke root repository GitHub Pages. Pertahankan folder `.github/workflows/` yang sudah ada di repository.

Aset AI lokal seperti `lib/` dan `models/` tetap harus tersedia bila ingin mode offline AI penuh.
