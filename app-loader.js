"use strict";

// Coding safety: close blocks first, prefer early returns, use try/catch for runtime failures,
// keep indentation consistent, and use template literals for multiline HTML/text.
/* Local-first loader untuk library eksternal (human.js, jszip.min.js).
   Coba muat salinan lokal dulu (folder ./lib/) supaya aplikasi tetap
   bisa mendeteksi wajah saat internet kelas mati/lambat. Kalau file
   lokal belum ada (belum diunduh manual), otomatis fallback ke CDN.
   Aman dipakai bersama tungguLibraryGlobal() yang sudah menunggu
   sampai 15 detik sebelum menyerah, jadi urutan lokal->CDN tidak
   memengaruhi logika yang memakai Human/JSZip. */
function muatLibraryLokalDuluBaruCDN(pathLokal, urlCDN) {
    window.__libraryLoadState = window.__libraryLoadState || {};
    window.__libraryLoadPromises = window.__libraryLoadPromises || {};

    const namaLibrary = /human/i.test(`${pathLokal} ${urlCDN}`) ? 'Human' : 'JSZip';

    if (window[namaLibrary]) {
        const siap = Promise.resolve(window[namaLibrary]);
        window.__libraryLoadPromises[namaLibrary] = siap;
        window.__libraryLoadState[namaLibrary] = {
            siap: true,
            sumber: 'sudah-tersedia',
            waktu: Date.now()
        };
        return siap;
    }

    if (window.__libraryLoadPromises[namaLibrary]) {
        return window.__libraryLoadPromises[namaLibrary];
    }

    const tandaiSiap = sumber => {
        window.__libraryLoadState[namaLibrary] = {
            siap: true,
            sumber,
            waktu: Date.now()
        };
        window.dispatchEvent(new CustomEvent('librarySiap', {
            detail: { nama: namaLibrary, sumber }
        }));
        return window[namaLibrary];
    };

    const tandaiGagal = (sumber, url, error) => {
        window.__libraryLoadState[namaLibrary] = {
            siap: false,
            sumber,
            url,
            waktu: Date.now(),
            error: error?.message || String(error || '')
        };
        window.dispatchEvent(new CustomEvent('libraryGagal', {
            detail: { nama: namaLibrary, sumber, url, error }
        }));
    };

    const loadScript = (url, sumber) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => {
            if (window[namaLibrary]) {
                resolve(tandaiSiap(sumber));
                return;
            }
            const error = new Error(`${namaLibrary} tidak ditemukan setelah script dimuat: ${url}`);
            tandaiGagal(sumber, url, error);
            reject(error);
        };
        script.onerror = () => {
            const error = new Error(`Gagal memuat ${namaLibrary}: ${url}`);
            tandaiGagal(sumber, url, error);
            reject(error);
        };
        document.head.appendChild(script);
    });

    const promise = loadScript(pathLokal, 'lokal').catch(async localError => {
        console.warn(
            `${pathLokal} tidak tersedia atau tidak menyediakan ${namaLibrary}; mencoba CDN: ${urlCDN}`,
            localError
        );
        try {
            return await loadScript(urlCDN, 'cdn');
        } catch (cdnError) {
            const error = new Error(`Library ${namaLibrary} gagal dimuat dari lokal dan CDN.`);
            error.cause = cdnError;
            throw error;
        }
    });

    // Simpan promise SEBELUM script async diberi kesempatan selesai agar
    // semua pemanggil berikutnya menunggu satu operasi yang sama.
    window.__libraryLoadPromises[namaLibrary] = promise;
    return promise;
}

// AKHIR BLOK LOADER LIBRARY: seluruh fungsi di atas wajib tetap tertutup.

// Library tidak lagi di-download saat parsing <head>. Loader hanya
// didaftarkan; Human dimuat saat kamera benar-benar dibutuhkan, sedangkan
// JSZip dimuat secara lazy ketika ekspor CSV diminta.
window.__lazyLoadHuman = () => muatLibraryLokalDuluBaruCDN(
    './lib/human.js',
    'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/dist/human.js'
).catch(error => {
    console.warn('Lazy load Human gagal:', error);
    throw error;
});

window.__lazyLoadJSZip = () => muatLibraryLokalDuluBaruCDN(
    './lib/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
).catch(error => {
    console.warn('Lazy load JSZip gagal:', error);
    throw error;
});
