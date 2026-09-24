"use strict";

/* =====================================================
   GLOBAL RUNTIME ERROR GUARD
   - Menangkap runtime error dan unhandled Promise rejection.
   - Detail tetap dicatat ke Console untuk debugging.
   - UI hanya menerima pesan umum agar tidak membocorkan stack/error internal.
   - Tidak memakai debugger/eval atau dependency eksternal.
===================================================== */
(() => {
    if (window.__absensiGlobalErrorGuardInstalled) return;
    window.__absensiGlobalErrorGuardInstalled = true;

    let errorTerakhir = '';
    let waktuErrorTerakhir = 0;

    const laporkanErrorRuntime = (jenis, error) => {
        const message = error?.message || String(error || 'Unknown error');
        console.error(`[${jenis}]`, error);

        const fingerprint = `${jenis}:${message}`;
        const sekarang = Date.now();
        if (fingerprint === errorTerakhir && sekarang - waktuErrorTerakhir < 5000) return;

        errorTerakhir = fingerprint;
        waktuErrorTerakhir = sekarang;

        try {
            const pesan = konfigurasi?.bahasa === 'en'
                ? 'A system error occurred. Please try again.'
                : 'Terjadi kesalahan sistem. Silakan coba lagi.';
            tampilkanToast(pesan, 4200);
        } catch (_) {
            // Error guard sendiri tidak boleh menjadi sumber error baru.
        }
    };

    window.addEventListener('error', event => {
        if (event?.error instanceof Error) {
            laporkanErrorRuntime('window.error', event.error);
            return;
        }
        laporkanErrorRuntime('window.error', new Error(event?.message || 'Runtime error'));
    });

    window.addEventListener('unhandledrejection', event => {
        const reason = event?.reason instanceof Error
            ? event.reason
            : new Error(String(event?.reason ?? 'Unhandled Promise rejection'));
        laporkanErrorRuntime('unhandledrejection', reason);
        // Jangan preventDefault: Console browser tetap menerima detail debugging.
    });
})();
