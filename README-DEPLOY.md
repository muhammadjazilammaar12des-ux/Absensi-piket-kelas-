# Absensi Piket — Recovery v34

Struktur deployment GitHub Pages:

- `index.html` — halaman utama
- `app-loader.js` — loader Human/JSZip local-first + CDN fallback
- `app-main.js` — seluruh JavaScript aplikasi utama
- `error-telemetry.js` — error buffer awal di `<head>` tanpa provider eksternal
- `sw.js` — Service Worker dengan cache name baru dan penghapusan cache versi lama

Asset yang sudah dirujuk oleh aplikasi tetap harus ikut repository, misalnya `manifest.json`, `lib/`, dan `models/` sesuai source.

Untuk GitHub Pages, letakkan file-file ini di root repository sehingga URL utama menggunakan `index.html`.
