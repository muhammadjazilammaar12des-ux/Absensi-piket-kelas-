"use strict";

/*
 * EARLY ERROR TELEMETRY / CRASH BUFFER
 * Dipasang paling awal di <head> agar error sebelum app-main.js dimuat
 * tetap tertangkap. Tidak mengirim data ke pihak ketiga dan tidak menyimpan
 * stack trace ke localStorage; buffer hanya hidup selama halaman aktif.
 * Integrasi Sentry/Raygun dapat dipasang di fungsi terimaError() bila backend
 * telemetri dan DSN resmi sudah tersedia.
 */
(() => {
    if (window.__absensiEarlyTelemetryInstalled) return;
    window.__absensiEarlyTelemetryInstalled = true;

    const MAX_BUFFER = 12;
    window.__absensiEarlyErrorBuffer = window.__absensiEarlyErrorBuffer || [];

    const terimaError = (jenis, error, metadata = {}) => {
        const message = String(error?.message || metadata.message || error || 'Unknown error');
        const item = {
            jenis,
            message: message.slice(0, 500),
            waktu: new Date().toISOString()
        };

        window.__absensiEarlyErrorBuffer.push(item);
        if (window.__absensiEarlyErrorBuffer.length > MAX_BUFFER) {
            window.__absensiEarlyErrorBuffer.shift();
        }

        console.error(`[EARLY:${jenis}]`, error || metadata.message || item.message);

        // Hook opsional untuk provider telemetri resmi.
        try {
            if (typeof window.onAbsensiRuntimeError === 'function') {
                window.onAbsensiRuntimeError(item);
            }
        } catch (_) {}
    };

    window.addEventListener('error', event => {
        if (event?.error instanceof Error) {
            terimaError('window.error', event.error);
            return;
        }
        terimaError('window.error', new Error(event?.message || 'Runtime error'));
    });

    window.addEventListener('unhandledrejection', event => {
        const reason = event?.reason instanceof Error
            ? event.reason
            : new Error(String(event?.reason ?? 'Unhandled Promise rejection'));
        terimaError('unhandledrejection', reason);
    });
})();
