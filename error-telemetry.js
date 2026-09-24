"use strict";

/*
 * Runtime error guard kecil dan non-invasive.
 * Tidak mengirim data ke server dan tidak menyimpan error ke localStorage.
 * Tujuannya hanya menjaga diagnostik dari error JavaScript/unhandled promise
 * tanpa membuat error handler sendiri menjadi sumber crash baru.
 */
(() => {
    const MAX_ERRORS = 50;
    const store = Array.isArray(window.__runtimeErrors)
        ? window.__runtimeErrors
        : [];
    window.__runtimeErrors = store;

    const normalisasiError = value => {
        if (!value) return { name: '', message: 'Unknown runtime error', stack: '' };
        if (value instanceof Error) {
            return {
                name: String(value.name || 'Error'),
                message: String(value.message || value),
                stack: String(value.stack || '')
            };
        }
        if (typeof value === 'object') {
            return {
                name: String(value.name || 'Error'),
                message: String(value.message || JSON.stringify(value)),
                stack: String(value.stack || '')
            };
        }
        return { name: 'Error', message: String(value), stack: '' };
    };

    const catat = (type, value, extra = {}) => {
        try {
            const error = normalisasiError(value);
            const entry = {
                type: String(type || 'runtime'),
                name: error.name,
                message: error.message.slice(0, 2000),
                stack: error.stack.slice(0, 6000),
                time: Date.now(),
                ...extra
            };
            store.push(entry);
            while (store.length > MAX_ERRORS) store.shift();
            window.dispatchEvent(new CustomEvent('runtimeErrorCaptured', { detail: entry }));
        } catch (_) {
            // Error handler wajib fail-silent.
        }
    };

    window.__reportRuntimeError = catat;

    window.addEventListener('error', event => {
        catat('error', event?.error || event?.message || 'window.error', {
            source: event?.filename || '',
            line: Number(event?.lineno || 0),
            column: Number(event?.colno || 0)
        });
    });

    window.addEventListener('unhandledrejection', event => {
        catat('unhandledrejection', event?.reason || 'Unhandled promise rejection');
    });
})();
