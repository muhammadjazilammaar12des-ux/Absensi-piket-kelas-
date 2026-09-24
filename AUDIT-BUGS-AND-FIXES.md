# Audit Bug & Error — Absensi Piket Kelas Recovery v37

## Hasil audit

Audit dilakukan lintas `index.html`, `app-main.js`, `app-utils.js`, `app-loader.js`, `manifest.json`, `sw.js`, dan paket deploy.

### Temuan yang diperbaiki

| Prioritas | Temuan | Perbaikan |
|---|---|---|
| KRITIS | `index.html` dan Service Worker mereferensikan `error-telemetry.js`, tetapi file tidak ada di paket | Ditambahkan `error-telemetry.js` dengan global error/unhandled-rejection capture yang fail-silent dan tidak mengirim data keluar |
| KRITIS | Service Worker `cache.addAll()` gagal total bila satu asset inti tidak ditemukan | Asset yang dirujuk sekarang lengkap; file telemetry ditambahkan ke paket |
| TINGGI | Service Worker lama menangani GET cross-origin dan dapat berakhir pada `respondWith(undefined)` | Fetch dibatasi ke same-origin; fallback kegagalan memakai `Response.error()`; navigasi memakai network-first + `index.html` offline fallback |
| TINGGI | Semua GET same-origin berpotensi masuk cache, termasuk endpoint data/API | Hanya dokumen/script/style/manifest/image/font dan folder `/lib/` + `/models/` yang dicache |
| TINGGI | `preserveKeys` pada helper localStorage justru dihapus ketika quota penuh | Logika diubah sehingga `preserveKeys` benar-benar dilindungi |
| TINGGI | Reset data tidak membersihkan `attendanceOutbox` | Reset sekarang menghapus semua store aplikasi yang tersedia, termasuk antrean sinkronisasi |
| TINGGI | Reset data tidak menghapus state lock/failure PIN guru | Key PIN lock/failure ikut dihapus saat reset penuh |
| TINGGI | Hapus seluruh riwayat absensi tidak membersihkan `attendanceOutbox` | Riwayat + foto + antrean sinkronisasi dibersihkan bersama |
| MENENGAH | `sudahAbsen` bisa tertinggal `true` ketika tab tetap hidup melewati pergantian hari | State dibuat sadar tanggal sesi sehingga status lama tidak mematikan sesi hari berikutnya |
| MENENGAH | Handler "Buka di browser" melakukan `await clipboard` sebelum `window.open` | Popup dibuka lebih dahulu ketika user activation masih aktif; ada fallback ke `location.assign()` bila popup diblokir |
| MENENGAH | Auto-prune riwayat memakai transaksi readonly tanpa lifecycle handler lengkap | Pembacaan sekarang menunggu transaksi `complete/error/abort` sebelum melanjutkan dan selalu menutup DB di `finally` |
| RENDAH | Marker build di `index.html` masih `recovery_v36` sementara paket lain sudah v37 | Marker diperbarui ke `recovery_v37` |

## Temuan yang perlu diperhatikan

### Asset AI offline
Paket upload yang diaudit tidak berisi folder `lib/` dan `models/`. Kode sudah memiliki fallback CDN, tetapi mode AI offline penuh tetap membutuhkan asset Human/WASM/model lokal tersebut.

### Manifest PWA
`manifest.json` valid, tetapi belum memiliki deklarasi icon 192/512. Ini tidak mencegah halaman utama berjalan, tetapi branding instalasi PWA menjadi minimal.

### Batas keamanan PIN
PIN guru memakai hash+salt dan lockout client-side. Ini cocok sebagai proteksi lokal perangkat, bukan sebagai autentikasi antar-perangkat. Untuk keamanan server, tetap perlukan autentikasi guru di backend.

## Verifikasi otomatis

- `node --check app-main.js` — PASS
- `node --check app-loader.js` — PASS
- `node --check app-utils.js` — PASS
- `node --check sw.js` — PASS
- `node --check error-telemetry.js` — PASS
- `manifest.json` parse — PASS
- Semua `script src` lokal pada `index.html` ditemukan — PASS
- Referensi `getElementById()` yang terdeteksi cocok dengan ID HTML — PASS

## Catatan

Smoke test browser penuh tidak dijadikan bukti keberhasilan karena environment headless tidak menyelesaikan lifecycle aplikasi/network dalam batas eksekusi. Karena itu hasil di atas adalah static/runtime-structure audit, bukan pengganti uji kamera fisik pada HP nyata.
