
"use strict";
/* =====================================================
   KONSTANTA
===================================================== */

const STORAGE_KEY =
    'absensi_piket_config_v2';

const DB_NAME =
    'AbsensiPiketFaceDB';

const DB_VERSION = 10;

const STORE_NAME =
    'students';

const CONFIG_STORE_NAME =
    'config';

const SARAN_PHOTO_STORE =
    'suggestionPhotos';

// Antrean sinkronisasi absensi ke backend. Data lokal tetap menjadi sumber
// utama sehingga absensi tidak hilang ketika koneksi tidak stabil.
const ATTENDANCE_OUTBOX_STORE =
    'attendanceOutbox';


const namaHari = [
    'Minggu',
    'Senin',
    'Selasa',
    'Rabu',
    'Kamis',
    'Jumat',
    'Sabtu'
];


const hariKerja = [
    'Senin',
    'Selasa',
    'Rabu',
    'Kamis',
    'Jumat',
    'Sabtu',
    'Minggu'
];

const HARI_AKTIF_DEFAULT = [
    'Senin',
    'Selasa',
    'Rabu',
    'Kamis',
    'Jumat'
];

const BACKEND_API_DEFAULT = '';


/* =====================================================
   VARIABLE
===================================================== */

let konfigurasi = null;

let semuaSiswa = [];

let namaReguPiket = [];

let siswaReguHariIni = [];

let faceDatabase = [];

let fotoBerhasilMasuk = 0;

let sudahAbsen = false;

let videoTrack = null;

let gunakanKameraDepan = true;

let lampuNyala = false;

let aiInterval = null;
let aiLastDetectionAt = 0;
// Generation token: callback RAF lama tidak boleh hidup kembali setelah restart/switch.
let aiLoopGeneration = 0;
let aiRecoveryPromise = null;
let aiRecoveryLastAt = 0;
let webglContextLostDetected = false;
let webglContextTarget = null;
let webglContextLostHandler = null;
let webglContextRestoredHandler = null;

let studentIdFotoAktif = null;

let modelAiSiap = false;
let statusLiveness = 0; // status sesi ringkas; state detail disimpan per face.id
const trackerLiveness = new Map();
const AI_MULTI_FACE_MAX = 8;

let aiBusy = false;
let absensiSedangDiproses = false;
let wakeLock = null;
let kameraDijedaKarenaPindah = false;
let kameraDeviceIds = [];
let waktuServerOffsetMs = null;
let waktuServerTerakhir = 0;
let kameraPerformanceTimer = null;
let kameraPerformanceWarned = false;
let kameraResolutionReduced = false;
let kameraPerformanceSampleToken = 0;
let kameraSwitchInProgress = false;
// Singleton promise: klik/interaksi bersamaan hanya boleh memiliki satu siklus
// getUserMedia yang aktif pada satu waktu. Pemanggil lain menunggu Promise yang sama.
let kameraInitPromise = null;
let batteryWarningShown = false;
let flashLayarSedangAktif = false;
let modePrivasiTerindikasi = false;
let kameraBacklightLastWarnAt = 0;
let kameraThermalTimer = null;
let kameraThermalStopShown = false;
let autofocusSettleInProgress = null;

// Idempotency guard per sesi halaman agar satu laporan tidak tersimpan dua kali.
const laporanSedangDisimpan = new Set();

// Token permintaan kamera untuk mencegah zombie stream saat switch/cancel cepat.
let kameraRequestId = 0;

// Semua ObjectURL yang dibuat aplikasi dilacak agar dapat dicabut saat render ulang/cleanup.
const activeObjectURLs = new Set();
const studentObjectURLs = new Set();


function bersihkanObjectURLs(targetSet) {
    if (!targetSet || typeof targetSet.forEach !== 'function') return;
    targetSet.forEach(url => {
        if (typeof url !== 'string' || !url) return;
        try { URL.revokeObjectURL(url); } catch (_) {}
        activeObjectURLs.delete(url);
    });
    try { targetSet.clear(); } catch (_) {}
}

function bersihkanSemuaObjectURLs() {
    bersihkanObjectURLs(studentObjectURLs);
    bersihkanObjectURLs(activeObjectURLs);
}

const AI_MODEL_PATH_FROM_META =
    document.querySelector('meta[name="ai-model-path"]')?.content?.trim() || './models/';

const AI_MODEL_PATH_LOCAL =
    AI_MODEL_PATH_FROM_META.endsWith('/')
        ? AI_MODEL_PATH_FROM_META
        : `${AI_MODEL_PATH_FROM_META}/`;

const AI_WASM_PATH_FROM_META =
    document.querySelector('meta[name="ai-wasm-path"]')?.content?.trim() || './lib/';

const AI_WASM_PATH_LOCAL =
    AI_WASM_PATH_FROM_META.endsWith('/')
        ? AI_WASM_PATH_FROM_META
        : `${AI_WASM_PATH_FROM_META}/`;

// Human 3.3.6 memakai TFJS 4.22.x; path CDN ini disediakan sebagai fallback
// terakhir bila berkas WASM lokal tidak lengkap dan perangkat sedang online.
const AI_WASM_PATH_CDN =
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/';

const AI_DETECTION_FPS_GLOBAL = 10;
const AI_DETECTION_INTERVAL_MS_GLOBAL = 1000 / AI_DETECTION_FPS_GLOBAL; // maksimal 10 FPS inferensi AI untuk mode multi-wajah

function dapatkanProfilPerformaPerangkat() {
    const cores = Number(navigator?.hardwareConcurrency || 0);
    const memoryGb = Number(navigator?.deviceMemory || 0);

    if ((cores > 0 && cores <= 2) || (memoryGb > 0 && memoryGb <= 2)) {
        return { nama: 'hemat', fps: 5, intervalMs: 200, maxSide: 360 };
    }
    if ((cores > 0 && cores <= 4) || (memoryGb > 0 && memoryGb <= 4)) {
        return { nama: 'seimbang', fps: 7, intervalMs: 1000 / 7, maxSide: 480 };
    }
    return { nama: 'penuh', fps: AI_DETECTION_FPS_GLOBAL, intervalMs: AI_DETECTION_INTERVAL_MS_GLOBAL, maxSide: 640 };
}

let aiPerformanceProfile = dapatkanProfilPerformaPerangkat();
let aiDetectionIntervalMsAktif = aiPerformanceProfile.intervalMs;
// Minimum ukuran wajah yang akan dipakai untuk verifikasi identitas. Wajah
// lebih kecil tetap boleh dideteksi, tetapi descriptor-nya tidak dipercaya.
const AI_FACE_MIN_SIZE_PX = 80;
const AI_TEMPORAL_FRAME_COUNT = 5;
const AI_TEMPORAL_REQUIRED_FRAMES = 3;
const AI_FACE_MIN_MESH_SCORE = 0.75;
const AI_MESH_MIN_POINTS = 400;
const KAMERA_THERMAL_TIMEOUT_MS = 60000;
const AUTOFOCUS_SETTLE_MS = 450;

// Hard-limit kualitas untuk tahap identitas/pencocokan.
// Didefinisikan sebelum konstanta yang menggunakannya agar tidak terkena
// temporal-dead-zone ReferenceError saat script pertama kali dieksekusi.
const AI_IDENTITY_MIN_SCORE = 0.85;

// Human v3.3.6 menormalisasi similarity ke rentang 0..1.
// Ambang aplikasi 0.60 berada dalam rentang 0.4–0.6 dan dapat dikalibrasi
// berdasarkan kualitas kamera, pencahayaan, serta model embedding yang dipakai.
const AI_MATCH_THRESHOLD = 0.60;
const AI_MAX_DETECTED_FACES = 8;
const AI_FACE_MIN_BOX_SCORE = AI_IDENTITY_MIN_SCORE;
const AI_FACE_MIN_FACE_SCORE = AI_IDENTITY_MIN_SCORE;
// Human mengembalikan rotation angle dalam derajat pada FaceResult yang dipakai
// aplikasi ini. Karena itu toleransi liveness ditulis dalam derajat, bukan radian.
const AI_FACE_MAX_YAW = 30;
const AI_FACE_MAX_PITCH = 30;
const AI_LIVENESS_STRAIGHT_YAW_DEG = 20;
const AI_LIVENESS_STRAIGHT_PITCH_DEG = 20;
const AI_LIVENESS_RESET_YAW_DEG = 45;
const AI_LIVENESS_RESET_PITCH_DEG = 45;
const AI_LIVENESS_MOVEMENT_DELTA_DEG = 6;
const AI_LIVENESS_STABLE_STRAIGHT_FRAMES = 2;
const AI_LIVENESS_SAMPLE_COUNT = 8;
const AI_LIVENESS_SAMPLE_INTERVAL_MS = 140;
const AI_LIVENESS_ENGINE_MIN = 0.50;
// Engine liveness harus teramati pada beberapa frame sebelum challenge
// blink diterima. Ini mengurangi keputusan dari satu frame yang noisy.
const AI_LIVENESS_ENGINE_REQUIRED_FRAMES = 2;
const AI_LIVENESS_BLINK_MIN_MS = 10;
const AI_LIVENESS_BLINK_MAX_MS = 800;
const AI_BACKLIGHT_BOX_SCORE_MIN = 0.65;
const AI_BACKLIGHT_FACE_SCORE_MAX = 0.55;

// Detector preview tetap boleh bekerja lebih longgar agar UX kamera responsif.
const SAFE_FETCH_TIMEOUT_MS = 10000;

const HUMAN_MATCH_OPTIONS = {
    order: 2,
    multiplier: 25,
    min: 0.2,
    max: 0.8
};

// Mutex global untuk seluruh human.detect(). Preview AI tidak boleh
// memulai inferensi baru ketika proses lain sedang memakai engine Human.
let humanDetectionPromise = null;
const aiPerfStats = { count: 0, totalMs: 0, lastMs: 0 };
const previewFaceBuffer = [];
let previewFaceCount = 0;

let modelAiPromise = null;

/* Data sesi absensi terakhir menunggu pengguna menekan "Simpan & Selesai". */
let hasilAbsensiTerakhir = null;
let fotoAbsensiTerakhir = null;



/* =====================================================
   ELEMENT
===================================================== */

const video =
    document.getElementById('kamera');

const wadah =
    document.getElementById('wadah');

const statusAi =
    document.getElementById('status-ai');

let statusAISignatureTerakhir = '';

const loadingOverlay = document.getElementById('loadingOverlay');
const loadingOverlayTitle = document.getElementById('loadingOverlayTitle');
const loadingOverlayText = document.getElementById('loadingOverlayText');

let brightnessCanvas = null;
let brightnessContext = null;
let lastBrightnessCheckAt = 0;
let lastBrightnessValue = 128;
const AI_BRIGHTNESS_MIN = 42;
const AI_BRIGHTNESS_BACKLIGHT = 220;
const AI_BRIGHTNESS_CHECK_INTERVAL_MS = 1000;


const infoJadwal =
    document.getElementById('info-jadwal');

const infoKelas =
    document.getElementById('info-kelas');

const btnJepret =
    document.getElementById('btnJepret');

const garisScan =
    document.getElementById('garis-scan');

let audioContextJepret = null;

const btnFlash =
    document.getElementById('btnFlash');

const modalFoto =
    document.getElementById('modalFoto');

const inputFoto =
    document.getElementById('inputFoto');

const previewFoto =
    document.getElementById('previewFoto');

const guruPinModal = document.getElementById('guruPinModal');
const guruPinInput = document.getElementById('guruPinInput');
const guruPinNewInput = document.getElementById('guruPinNewInput');
const guruPinNewConfirm = document.getElementById('guruPinNewConfirm');
const guruPinExistingFields = document.getElementById('guruPinExistingFields');
const guruPinSetupFields = document.getElementById('guruPinSetupFields');
const guruPinError = document.getElementById('guruPinError');
const guruPinTitle = document.getElementById('guruPinTitle');
const guruPinDescription = document.getElementById('guruPinDescription');
const guruPinCancel = document.getElementById('guruPinCancel');
const guruPinSubmit = document.getElementById('guruPinSubmit');

let guruPinMode = 'verify';
let guruPinAsalHalaman = 'hal-1';
let guruPinGagal = 0;
let guruPinTerkunciSampai = 0;

const GURU_PIN_LOCK_KEY = 'guruPinTerkunciSampai';
const GURU_PIN_FAIL_KEY = 'guruPinGagalCount';

function muatStatusKunciPinGuru() {
    try {
        const sampai = Number(localStorage.getItem(GURU_PIN_LOCK_KEY) || 0);
        const gagal = Number(localStorage.getItem(GURU_PIN_FAIL_KEY) || 0);
        guruPinTerkunciSampai = Number.isFinite(sampai) && sampai > 0 ? sampai : 0;
        guruPinGagal = Number.isFinite(gagal) && gagal >= 0 ? gagal : 0;
    } catch (_) {
        guruPinTerkunciSampai = 0;
        guruPinGagal = 0;
    }
}

function simpanStatusKunciPinGuru() {
    try {
        if (guruPinTerkunciSampai > Date.now()) localStorage.setItem(GURU_PIN_LOCK_KEY, String(guruPinTerkunciSampai));
        else localStorage.removeItem(GURU_PIN_LOCK_KEY);
        localStorage.setItem(GURU_PIN_FAIL_KEY, String(guruPinGagal));
    } catch (_) {}
}

muatStatusKunciPinGuru();

function absensiBolehDiproses() {
    return (
        namaReguPiket.length > 0 &&
        faceDatabase.length > 0 &&
        Boolean(video?.srcObject) &&
        video.readyState >= 2
    );
}

function hentikanPantauanKamera() {
    kameraPerformanceSampleToken++;
    if (kameraPerformanceTimer) {
        clearTimeout(kameraPerformanceTimer);
        clearInterval(kameraPerformanceTimer);
        kameraPerformanceTimer = null;
    }
}

async function cekBateraiDanPeringatkan() {
    if (batteryWarningShown) return;

    try {
        if (typeof navigator.getBattery !== 'function') return;
        const battery = await navigator.getBattery();
        if (!battery || battery.charging === true || !Number.isFinite(battery.level)) return;

        if (battery.level <= 0.10) {
            batteryWarningShown = true;
            tampilkanToast(t('cameraBatteryWarning'), 4200);
        }
    } catch (error) {
        console.warn('Status baterai tidak tersedia:', error);
    }
}

async function turunkanResolusiKamera(stream = video?.srcObject) {
    if (kameraResolutionReduced) return false;
    const track = stream?.getVideoTracks?.()[0] || videoTrack;
    if (!track?.applyConstraints) return false;

    try {
        const capabilities = track.getCapabilities?.() || {};
        const maxWidth = Number(capabilities.width?.max || 0);
        const maxHeight = Number(capabilities.height?.max || 0);
        const idealWidth = maxWidth > 0 ? Math.min(640, maxWidth) : 640;
        const idealHeight = maxHeight > 0 ? Math.min(480, maxHeight) : 480;

        await track.applyConstraints({
            width: { ideal: idealWidth },
            height: { ideal: idealHeight },
            frameRate: { ideal: 15, max: 30 }
        });

        kameraResolutionReduced = true;
        await new Promise(resolve => {
            if (video?.requestVideoFrameCallback) {
                video.requestVideoFrameCallback(() => resolve());
            } else {
                setTimeout(resolve, 120);
            }
        });
        adaptCameraSize();
        sinkronkanCanvasAIPadaResize();
        aiLastDetectionAt = 0;
        return true;
    } catch (error) {
        console.warn('Penurunan resolusi kamera otomatis gagal:', error);
        return false;
    }
}

function mulaiPantauanKinerjaKamera() {
    hentikanPantauanKamera();
    kameraPerformanceWarned = false;
    kameraPerformanceSampleToken++;
    kameraResolutionReduced = false;

    if (!video || !video.srcObject) return;

    const sampleToken = kameraPerformanceSampleToken;
    const mulai = performance.now();
    let frameCount = 0;

    const beriPeringatan = () => {
        if (kameraPerformanceWarned || document.hidden || !video.srcObject) return;
        kameraPerformanceWarned = true;
        tampilkanToast(t('cameraPerformanceWarning'), 4200);
    };

    const evaluasiFPS = async () => {
        if (sampleToken !== kameraPerformanceSampleToken || !video.srcObject) return;
        const durasiMs = performance.now() - mulai;
        const fps = frameCount / Math.max(0.5, durasiMs / 1000);

        // Pertahankan feed kamera 720p. Bila rendering perangkat mulai turun,
        // cukup minta AI menurunkan ukuran frame inputnya secara adaptif.
        if (fps < 10) {
            aiPreviewMaxSide = Math.max(AI_INPUT_MAX_SIDE_MIN, Math.min(aiPreviewMaxSide, 480));
            aiLastPreviewInputAdjustAt = performance.now();
            console.warn(`FPS kamera turun ke ${fps.toFixed(1)}; AI preview dipertahankan pada maxSide=${aiPreviewMaxSide}px.`);
        }
        if (fps < 8) beriPeringatan();
    };

    if (typeof video.requestVideoFrameCallback === 'function') {
        const loop = (now) => {
            if (sampleToken !== kameraPerformanceSampleToken || !video.srcObject || document.hidden) return;
            frameCount += 1;
            const durasi = now - mulai;
            if (durasi >= 2600) {
                void evaluasiFPS();
                return;
            }
            video.requestVideoFrameCallback(loop);
        };
        video.requestVideoFrameCallback(loop);
        kameraPerformanceTimer = window.setTimeout(() => {
            if (sampleToken !== kameraPerformanceSampleToken) return;
            if (frameCount < 12 && !kameraPerformanceWarned) void evaluasiFPS();
            else if (frameCount > 0 && !kameraResolutionReduced) void evaluasiFPS();
        }, 3600);
        return;
    }

    const awalCurrentTime = Number(video.currentTime) || 0;
    let perubahan = 0;
    kameraPerformanceTimer = window.setInterval(() => {
        if (sampleToken !== kameraPerformanceSampleToken) return;
        if (!video.srcObject || document.hidden) return;
        const sekarang = Number(video.currentTime) || 0;
        if (sekarang > awalCurrentTime + 0.25) perubahan = 1;
        if (performance.now() - mulai >= 3200) {
            if (!perubahan) {
                aiPreviewMaxSide = AI_INPUT_MAX_SIDE_MIN;
                aiLastPreviewInputAdjustAt = performance.now();
                beriPeringatan();
            }
            hentikanPantauanKamera();
        }
    }, 500);
}

async function deteksiModePrivasi() {
    let indikasi = false;

    // Tidak ada API standar untuk berkata "ini Incognito". Karena itu
    // deteksi di sini hanya best-effort dan tidak boleh memblokir absensi.
    try {
        const storage = navigator.storage;
        if (storage?.estimate) {
            const estimate = await storage.estimate();
            const quota = Number(estimate?.quota || 0);
            if (quota > 0 && quota < 32 * 1024 * 1024) {
                indikasi = true;
            }
        }
    } catch (error) {
        console.warn('Deteksi mode privasi gagal:', error);
    }

    modePrivasiTerindikasi = indikasi;

    if (indikasi) {
        try {
            const key = 'absensiPrivateModeWarningShown';
            if (sessionStorage.getItem(key) !== '1') {
                sessionStorage.setItem(key, '1');
                tampilkanToast(t('cameraPrivateMode'), 4200);
            }
        } catch (_) {
            tampilkanToast(t('cameraPrivateMode'), 4200);
        }
    }
}

function tampilkanStatusKoneksi() {
    window.addEventListener('offline', () => {
        tampilkanToast(
            konfigurasi?.bahasa === 'en'
                ? 'Connection lost. Attendance data will continue to be saved locally.'
                : 'Sinyal terputus. Data absensi tetap akan disimpan di HP.',
            3600
        );
    });

    window.addEventListener('online', () => {
        tampilkanToast(t('onlineRestored'), 2400);
        sinkronkanWaktuServer().catch(() => {});
        sinkronkanAntreanAbsensi().catch(() => {});
        sinkronisasiSaranTertunda().catch(() => {});
    });
}

function terapkanPreviewKamera() {
    if (!video || !wadah) return;

    // Properti JS ikut dipasang supaya Safari/iOS lama tidak hanya
    // mengandalkan atribut HTML.
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');

    const aktif = Boolean(video.srcObject);
    wadah.classList.toggle(
        'kamera-cermin',
        aktif && gunakanKameraDepan
    );
}

const modalErrorKamera = document.getElementById('modalErrorKamera');
const teksErrorKamera = document.getElementById('teksErrorKamera');
const btnIzinKamera = document.getElementById('btnIzinKamera');
const btnTutupErrorKamera = document.getElementById('btnTutupErrorKamera');
const btnKameraFallback = document.getElementById('btnKameraFallback');

function pesanKonteksKamera(error) {
    const secure = window.isSecureContext === true;
    const name = error?.name || '';
    const en = konfigurasi?.bahasa === 'en';
    if (name === 'VirtualCameraError' || error?.virtualCamera) {
        return t('cameraVirtualError');
    }
    if (name === 'CanvasBlockedError') {
        return t('cameraPrivacyError');
    }
    if (name === 'IframeCameraError') {
        return t('cameraIframeError');
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
        return t('cameraBusyError');
    }
    if (!secure || name === 'SecurityError') {
        return en
            ? 'Live camera access is blocked because this HTML is opened from a local/download URL. Use HTTPS or localhost for live preview.'
            : 'Akses kamera langsung diblokir karena HTML ini dibuka dari file lokal/URL download. Gunakan HTTPS atau localhost untuk preview langsung, atau gunakan kamera perangkat di bawah.';
    }
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        return en
            ? 'Camera access is blocked. Allow camera permission in the browser site settings, then press Try Again. On iPhone/iPad, also check Settings > Safari > Camera.'
            : 'Akses kamera diblokir. Izinkan kamera pada pengaturan izin situs browser, lalu tekan Coba Lagi. Di iPhone/iPad, periksa juga Pengaturan > Safari > Kamera.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return en ? 'No camera device was found.' : 'Perangkat kamera tidak ditemukan.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
        return t('cameraBusyError');
    }
    if (name === 'NotSupportedError') {
        return t('cameraLegacyFallback');
    }
    if (name === 'TimeoutError') {
        return en
            ? 'The camera did not respond in time. This happens on some phones (e.g. MIUI/Xiaomi) that silently block the camera permission prompt. Check the camera permission for this browser in the phone\'s system Settings, then retry.'
            : 'Kamera tidak merespons dalam waktu wajar. Ini sering terjadi di sebagian HP (misalnya MIUI/Xiaomi) yang diam-diam memblokir izin kamera. Periksa izin kamera untuk browser ini di Pengaturan sistem HP, lalu coba lagi.';
    }
    return error?.message || t('cameraErrorText');
}


function konteksKameraTidakAman() {
    const secureDefined = typeof window.isSecureContext === 'boolean';
    const insecure = secureDefined && window.isSecureContext === false;
    return insecure || !navigator.mediaDevices?.getUserMedia;
}

async function cobaLagiAksesKamera() {
    if (konteksKameraTidakAman()) {
        tampilkanErrorKamera(new DOMException(
            konfigurasi?.bahasa === 'en'
                ? 'Live camera cannot be used from a downloaded HTML file. Open this app from HTTPS or localhost.'
                : 'Kamera live tidak dapat digunakan dari file HTML yang diunduh. Buka aplikasi melalui HTTPS atau localhost.',
            'SecurityError'
        ));
        return;
    }

    btnIzinKamera?.classList.add('loading-anim');
    btnKameraFallback?.classList.add('loading-anim');
    if (btnIzinKamera) btnIzinKamera.disabled = true;
    if (btnKameraFallback) btnKameraFallback.disabled = true;

    try {
        modalErrorKamera?.classList.remove('muncul');
        await mulaiKamera();
        if (video?.srcObject) {
            setKameraPlaceholder('', false);
            tampilkanToast(
                konfigurasi?.bahasa === 'en'
                    ? 'Camera is ready.'
                    : 'Kamera siap digunakan.',
                1800
            );
        }
    } catch (error) {
        console.error('Percobaan ulang akses kamera gagal:', error);
        tampilkanErrorKamera(error);
    } finally {
        btnIzinKamera?.classList.remove('loading-anim');
        btnKameraFallback?.classList.remove('loading-anim');
        const bolehCobaLagi = window.isSecureContext === true && Boolean(navigator.mediaDevices?.getUserMedia);
        if (btnIzinKamera) btnIzinKamera.disabled = !bolehCobaLagi;
        if (btnKameraFallback) btnKameraFallback.disabled = !bolehCobaLagi;
    }
}

btnIzinKamera?.addEventListener('click', cobaLagiAksesKamera);
btnTutupErrorKamera?.addEventListener('click', () => {
    modalErrorKamera?.classList.remove('muncul');
});

btnKameraFallback?.addEventListener('click', () => {
    cobaLagiAksesKamera().catch(() => {});
});

function tampilkanErrorKamera(error) {
    const pesan = pesanKonteksKamera(error);
    const secureDefined = typeof window.isSecureContext === 'boolean';
    const secure = !secureDefined || window.isSecureContext === true;
    const punyaGetUserMedia = Boolean(navigator.mediaDevices?.getUserMedia);
    const en = konfigurasi?.bahasa === 'en';

    if (teksErrorKamera) {
        const tambahanIframe = window.top !== window.self
            ? '\n\n' + t('cameraIframeError')
            : '';
        teksErrorKamera.textContent =
            pesan +
            tambahanIframe +
            '\n\n' +
            (secure
                ? t('cameraPermissionText')
                : (en
                    ? 'For live preview, open the app over HTTPS or localhost.'
                    : 'Untuk preview langsung, buka aplikasi melalui HTTPS atau localhost.')) +
            '\n\n' +
            (punyaGetUserMedia
                ? t('manualCameraOnly')
                : (en
                    ? 'This browser does not provide live camera access. Open the app in a modern browser such as Chrome, Edge, or Safari.'
                    : 'Browser ini tidak menyediakan akses kamera live. Buka aplikasi menggunakan browser modern seperti Chrome, Edge, atau Safari.'));
    }

    const judul = document.getElementById('judulErrorKamera');
    if (judul) judul.textContent = t('cameraErrorTitle');

    if (btnIzinKamera) {
        btnIzinKamera.disabled = !secure || !punyaGetUserMedia;
        btnIzinKamera.textContent = secure && punyaGetUserMedia
            ? t('cameraPermission')
            : (en ? 'Camera requires HTTPS' : 'Kamera membutuhkan HTTPS');
        btnIzinKamera.title = secure && punyaGetUserMedia
            ? ''
            : (en ? 'Open the app from an HTTPS website or localhost.' : 'Buka aplikasi dari website HTTPS atau localhost.');
    }

    // Jangan menyembunyikan tombol fallback secara paksa.
    // Fallback di aplikasi ini hanya berarti mencoba kembali kamera live,
    // bukan menerima foto galeri sebagai bukti absensi.
    if (btnKameraFallback) {
        btnKameraFallback.style.display = 'block';
        btnKameraFallback.disabled = !secure || !punyaGetUserMedia;
        btnKameraFallback.removeAttribute('aria-hidden');
        btnKameraFallback.removeAttribute('tabindex');
        btnKameraFallback.textContent = secure && punyaGetUserMedia
            ? (en ? 'Retry Camera' : 'Coba Lagi Kamera')
            : (en ? 'Use HTTPS / localhost' : 'Buka melalui HTTPS / localhost');
        btnKameraFallback.title = btnKameraFallback.disabled
            ? (en ? 'Live camera requires HTTPS or localhost.' : 'Kamera live membutuhkan HTTPS atau localhost.')
            : '';
    }

    modalErrorKamera?.classList.add('muncul');
}

/* =====================================================
   IKON SVG (PENGGANTI EMOJI KAMERA & ISTIRAHAT)
===================================================== */

const IKON_KAMERA =
    '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 8.5C4 7.67157 4.67157 7 5.5 7H7.17157C7.70201 7 8.21071 6.78929 8.58579 6.41421L9.41421 5.58579C9.78929 5.21071 10.298 5 10.8284 5H13.1716C13.702 5 14.2107 5.21071 14.5858 5.58579L15.4142 6.41421C15.7893 6.78929 16.298 7 16.8284 7H18.5C19.3284 7 20 7.67157 20 8.5V17.5C20 18.3284 19.3284 19 18.5 19H5.5C4.67157 19 4 18.3284 4 17.5V8.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.4" stroke="currentColor" stroke-width="1.6"/></svg>';

const IKON_ISTIRAHAT =
    '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';


/* =====================================================
   DATABASE INDEXEDDB
===================================================== */

function bukaDatabase() {

    return new Promise((resolve, reject) => {

        if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB tidak didukung oleh browser ini.'));
            return;
        }

        const request =
            indexedDB.open(
                DB_NAME,
                DB_VERSION
            );

        request.onupgradeneeded =
            event => {

                const db =
                    event.target.result;

                if (
                    !db.objectStoreNames.contains(
                        STORE_NAME
                    )
                ) {

                    db.createObjectStore(
                        STORE_NAME,
                        {
                            keyPath: 'id'
                        }
                    );

                }

                /* Foto bukti saran disimpan terpisah dari localStorage.
                   Ini mencegah gambar besar memenuhi kuota localStorage. */
                if (
                    !db.objectStoreNames.contains(
                        SARAN_PHOTO_STORE
                    )
                ) {

                    db.createObjectStore(
                        SARAN_PHOTO_STORE,
                        {
                            keyPath: 'id'
                        }
                    );

                }

                /* CONFIG_STORE_NAME ditambahkan pada versi migrasi ini.
                   Database lama yang belum memiliki store ini wajib
                   membuat store ini agar tombol Simpan Pengaturan tidak
                   melempar NotFoundError saat membuka transaction. */
                if (
                    !db.objectStoreNames.contains(
                        CONFIG_STORE_NAME
                    )
                ) {
                    db.createObjectStore(
                        CONFIG_STORE_NAME,
                        { keyPath: 'id' }
                    );
                }

                /* Laporan absensi mingguan untuk Ruang Guru. */
                if (!db.objectStoreNames.contains('attendanceRecords')) {
                    db.createObjectStore(
                        'attendanceRecords',
                        { keyPath: 'id' }
                    );
                }

                /* Foto bukti setiap sesi absensi disimpan terpisah dari metadata laporan. */
                if (!db.objectStoreNames.contains('attendancePhotos')) {
                    db.createObjectStore(
                        'attendancePhotos',
                        { keyPath: 'id' }
                    );
                }

                /* Antrean laporan yang belum berhasil disinkronkan ke backend. */
                if (!db.objectStoreNames.contains(ATTENDANCE_OUTBOX_STORE)) {
                    db.createObjectStore(
                        ATTENDANCE_OUTBOX_STORE,
                        { keyPath: 'id' }
                    );
                }

            };

        request.onblocked = () => {
            reject(new Error(
                'Database sedang terbuka di tab lain. Tutup tab aplikasi Absensi Piket yang lain, lalu coba lagi.'
            ));
        };

        request.onsuccess =
            event => {

                const db = event.target.result;

                /* Membebaskan koneksi saat database nanti perlu di-upgrade. */
                db.onversionchange = () => db.close();

                resolve(db);

            };

        request.onerror =
            () => {

                reject(
                    request.error ||
                    new Error('Database tidak dapat dibuka.')
                );

            };

    });

}


/* =====================================================
   ENKRIPSI DESCRIPTOR WAJAH (AES-GCM, kunci per perangkat)
   -----------------------------------------------------
   Descriptor/embedding wajah adalah data biometrik, jadi
   tidak disimpan mentah di IndexedDB. Kunci AES-256 dibuat
   sekali secara otomatis lalu disimpan di IndexedDB
   (CONFIG_STORE_NAME) pada perangkat yang sama.

   PENTING (batasan yang jujur): karena kuncinya tersimpan
   di perangkat yang sama dengan datanya, ini melindungi data
   kalau file databasenya di-copy/diekspor keluar perangkat,
   TAPI TIDAK melindungi dari orang yang punya akses langsung
   ke perangkat/browser ini. Untuk perlindungan dari akses
   langsung ke perangkat, perlu proteksi tambahan seperti PIN
   yang tidak disimpan otomatis di perangkat.
===================================================== */

const KUNCI_ENKRIPSI_WAJAH_ID = 'kunciEnkripsiWajahV1';
let _kunciEnkripsiWajahCache = null;

function _bufKeBase64(buf) {
    let biner = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) biner += String.fromCharCode(bytes[i]);
    return btoa(biner);
}

function _base64KeBuf(b64) {
    const biner = atob(b64);
    const bytes = new Uint8Array(biner.length);
    for (let i = 0; i < biner.length; i++) bytes[i] = biner.charCodeAt(i);
    return bytes.buffer;
}

async function _ambilRawKunciWajahDB() {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(CONFIG_STORE_NAME, 'readonly');
            const request = tx.objectStore(CONFIG_STORE_NAME).get(KUNCI_ENKRIPSI_WAJAH_ID);
            request.onsuccess = () => resolve(request.result?.raw || null);
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => db.close();
            tx.onabort = () => reject(tx.error || new Error('Pembacaan kunci enkripsi dibatalkan.'));
        } catch (error) {
            reject(error);
        }
    });
}

async function _simpanRawKunciWajahDB(rawBase64) {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(CONFIG_STORE_NAME, 'readwrite');
            tx.objectStore(CONFIG_STORE_NAME).put({
                id: KUNCI_ENKRIPSI_WAJAH_ID,
                raw: rawBase64,
                createdAt: Date.now()
            });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Penyimpanan kunci enkripsi dibatalkan.'));
        } catch (error) {
            reject(error);
        }
    });
}

async function dapatkanKunciEnkripsiWajah() {
    if (_kunciEnkripsiWajahCache) return _kunciEnkripsiWajahCache;

    if (!window.crypto?.subtle) {
        // Data biometrik tidak boleh pernah disimpan plaintext.
        // Gagal-aman jika Web Crypto tidak tersedia.
        throw Object.assign(
            new Error('Web Crypto API tidak tersedia. Data biometrik tidak dapat disimpan dengan aman pada browser ini.'),
            { name: 'BiometricProtectionError' }
        );
    }

    try {
        let rawBase64 = await _ambilRawKunciWajahDB();

        if (!rawBase64) {
            const kunciBaru = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
            );
            const rawBuf = await crypto.subtle.exportKey('raw', kunciBaru);
            rawBase64 = _bufKeBase64(rawBuf);
            await _simpanRawKunciWajahDB(rawBase64);
        }

        _kunciEnkripsiWajahCache = await crypto.subtle.importKey(
            'raw',
            _base64KeBuf(rawBase64),
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );

        return _kunciEnkripsiWajahCache;
    } catch (error) {
        console.error('Gagal menyiapkan kunci enkripsi data wajah:', error);
        return null;
    }
}

async function enkripsiEmbeddingWajah(embeddings) {
    const embeddingsNormal = normalisasiEmbeddingData(embeddings);
    if (!embeddingsNormal.length) return null;

    const kunci = await dapatkanKunciEnkripsiWajah();
    if (!kunci) return null;

    try {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(JSON.stringify(embeddingsNormal));
        const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kunci, plaintext);
        return {
            v: 1,
            iv: _bufKeBase64(iv),
            data: _bufKeBase64(cipherBuf)
        };
    } catch (error) {
        console.error('Enkripsi data wajah gagal:', error);
        return null;
    }
}

async function dekripsiEmbeddingWajah(paket) {
    if (!paket || !paket.data || !paket.iv) return [];

    const kunci = await dapatkanKunciEnkripsiWajah();
    if (!kunci) return [];

    try {
        const iv = new Uint8Array(_base64KeBuf(paket.iv));
        const cipherBuf = _base64KeBuf(paket.data);
        const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kunci, cipherBuf);
        const json = new TextDecoder().decode(plainBuf);
        const hasil = JSON.parse(json);
        // JSON.parse dapat menghasilkan Array biasa, typed-array-like object,
        // atau struktur legacy; normalkan kembali sebelum diberikan ke matcher.
        return normalisasiEmbeddingData(hasil);
    } catch (error) {
        // Bisa terjadi kalau file database dipindah ke perangkat lain
        // tanpa kunci yang sama -- data wajah dianggap kosong (aman,
        // tidak melempar error ke pemanggil), murid perlu didaftar ulang.
        console.error('Dekripsi data wajah gagal (kemungkinan kunci berbeda perangkat):', error);
        return [];
    }
}


/* =====================================================
   SIMPAN SISWA KE DATABASE
===================================================== */

async function simpanSiswaDB(siswa) {

    const siswaUntukDisimpan = { ...siswa };
    const embeddingSumber =
        siswaUntukDisimpan.faceEmbeddings ?? siswaUntukDisimpan.descriptorHuman;
    const embeddingNormal = normalisasiEmbeddingData(embeddingSumber);

    if (embeddingNormal.length) {
        // Fail closed: embedding biometrik hanya boleh masuk DB dalam bentuk
        // terenkripsi. Jangan pernah fallback ke faceEmbeddings/descriptorHuman
        // plaintext.
        let terenkripsi;
        try {
            terenkripsi = await enkripsiEmbeddingWajah(embeddingNormal);
        } catch (error) {
            throw error?.name === 'BiometricProtectionError'
                ? error
                : Object.assign(
                    new Error('Data biometrik tidak dapat dienkripsi sehingga tidak disimpan.'),
                    { name: 'BiometricProtectionError', cause: error }
                );
        }
        if (!terenkripsi) {
            throw Object.assign(
                new Error('Data biometrik tidak dapat dienkripsi sehingga tidak disimpan.'),
                { name: 'BiometricProtectionError' }
            );
        }
        siswaUntukDisimpan.faceEmbeddingsEnc = terenkripsi;
        siswaUntukDisimpan.descriptorHuman = null;
        siswaUntukDisimpan.faceEmbeddings = null;
    } else {
        // Bersihkan field plaintext lama sebelum menulis record tanpa embedding.
        siswaUntukDisimpan.descriptorHuman = null;
        siswaUntukDisimpan.faceEmbeddings = null;
    }

    const db =
        await bukaDatabase();

    return new Promise(
        (resolve, reject) => {

            const tx =
                db.transaction(
                    STORE_NAME,
                    'readwrite'
                );

            tx.objectStore(
                STORE_NAME
            ).put(siswaUntukDisimpan);

            tx.oncomplete =
                () => {
                    db.close();
                    resolve();
                };

            tx.onerror =
                () => {
                    const error = tx.error || new Error('Gagal menyimpan data siswa.');
                    db.close();
                    reject(error);
                };

            tx.onabort =
                () => {
                    const error = tx.error || new Error('Penyimpanan data siswa dibatalkan.');
                    db.close();
                    reject(error);
                };

        }
    );

}


/* =====================================================
   AMBIL SEMUA SISWA
===================================================== */

function _ambilSemuaSiswaDBMentah() {

    return bukaDatabase().then(db =>
        new Promise(
            (resolve, reject) => {

                const tx =
                    db.transaction(
                        STORE_NAME,
                        'readonly'
                    );

                const request =
                    tx.objectStore(
                        STORE_NAME
                    ).getAll();

                request.onsuccess =
                    () => {
                        resolve(
                            request.result || []
                        );
                    };

                request.onerror =
                    () => {
                        reject(
                            request.error || new Error('Gagal membaca data siswa.')
                        );
                    };

                tx.oncomplete =
                    () => db.close();

                tx.onerror =
                    () => {
                        db.close();
                    };

                tx.onabort =
                    () => {
                        db.close();
                        reject(
                            tx.error || new Error('Pembacaan data siswa dibatalkan.')
                        );
                    };

            }
        )
    );

}

async function ambilSemuaSiswaDB() {

    const daftarSiswa = await _ambilSemuaSiswaDBMentah();

    // Dekripsi descriptor wajah tiap siswa bila tersimpan terenkripsi.
    // Record lama yang masih membawa embedding plaintext dimigrasikan
    // ke format terenkripsi sebelum dipakai aplikasi.
    for (const siswa of daftarSiswa) {
        if (!siswa) continue;

        if (siswa.faceEmbeddingsEnc) {
            const hasil = await dekripsiEmbeddingWajah(siswa.faceEmbeddingsEnc);
            siswa.descriptorHuman = hasil;
            siswa.faceEmbeddings = hasil;
            continue;
        }

        const legacyEmbeddings = normalisasiEmbeddingWajah(siswa);
        if (!legacyEmbeddings.length) continue;

        try {
            siswa.faceEmbeddings = legacyEmbeddings;
            siswa.descriptorHuman = legacyEmbeddings;
            await simpanSiswaDB(siswa);
            // Tetap simpan hasil dekripsi di RAM sesi agar matcher tidak berubah.
            siswa.faceEmbeddings = legacyEmbeddings;
            siswa.descriptorHuman = legacyEmbeddings;
        } catch (error) {
            console.warn('Migrasi descriptor plaintext gagal; field biometrik akan dihapus dari record:', siswa.name, error);
            try {
                const tanpaBiometrik = { ...siswa, faceEmbeddings: null, descriptorHuman: null, faceEmbeddingsEnc: null };
                await simpanSiswaDB(tanpaBiometrik);
            } catch (wipeError) {
                console.warn('Gagal membersihkan descriptor plaintext lama:', wipeError);
            }
            siswa.faceEmbeddings = null;
            siswa.descriptorHuman = null;
        }
    }

    return daftarSiswa;

}


/* =====================================================
   HAPUS SISWA DATABASE
===================================================== */

async function hapusSiswaDB(id) {

    const db =
        await bukaDatabase();

    return new Promise(
        (resolve, reject) => {

            const tx =
                db.transaction(
                    STORE_NAME,
                    'readwrite'
                );

            tx.objectStore(
                STORE_NAME
            ).delete(id);

            tx.oncomplete =
                () => {
                    db.close();
                    resolve();
                };

            tx.onerror =
                () => {
                    const error = tx.error || new Error('Gagal menghapus data siswa.');
                    db.close();
                    reject(error);
                };

            tx.onabort =
                () => {
                    const error = tx.error || new Error('Penghapusan data siswa dibatalkan.');
                    db.close();
                    reject(error);
                };

        }
    );

}


/* =====================================================
   HAPUS SEMUA DATABASE
===================================================== */

async function kosongkanDatabase() {

    const db =
        await bukaDatabase();

    return new Promise(
        (resolve, reject) => {

            const stores = [STORE_NAME];

            /* Semua data aplikasi ikut dibersihkan agar reset benar-benar
               mengembalikan aplikasi ke kondisi awal. */
            [CONFIG_STORE_NAME, SARAN_PHOTO_STORE, 'attendanceRecords', 'attendancePhotos']
                .forEach(storeName => {
                    if (db.objectStoreNames.contains(storeName)) {
                        stores.push(storeName);
                    }
                });

            const tx =
                db.transaction(
                    stores,
                    'readwrite'
                );

            tx.objectStore(
                STORE_NAME
            ).clear();

            [CONFIG_STORE_NAME, SARAN_PHOTO_STORE, 'attendanceRecords', 'attendancePhotos']
                .forEach(storeName => {
                    if (stores.includes(storeName)) {
                        tx.objectStore(storeName).clear();
                    }
                });

            tx.oncomplete =
                () => {
                    db.close();
                    resolve();
                };

            tx.onerror =
                () => {
                    const error = tx.error || new Error('Gagal menghapus semua data.');
                    db.close();
                    reject(error);
                };

            tx.onabort =
                () => {
                    const error = tx.error || new Error('Penghapusan semua data dibatalkan.');
                    db.close();
                    reject(error);
                };

        }
    );

}


/* =====================================================
   ID SISWA
===================================================== */

function buatId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'siswa_' + crypto.randomUUID();
    }

    // Fallback untuk browser lama yang belum menyediakan randomUUID().
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(bytes);
        return 'siswa_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    return 'siswa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}


/* =====================================================
   MODAL NAMA SISWA
===================================================== */

const modalNamaSiswa = document.getElementById('modalNamaSiswa');
const inputNamaSiswaModal = document.getElementById('inputNamaSiswaModal');
const judulNamaSiswaModal = document.getElementById('judulNamaSiswaModal');
const deskripsiNamaSiswaModal = document.getElementById('deskripsiNamaSiswaModal');
const btnBatalNamaSiswaModal = document.getElementById('btnBatalNamaSiswaModal');
const btnSimpanNamaSiswaModal = document.getElementById('btnSimpanNamaSiswaModal');

let resolverModalNamaSiswa = null;

function bukaModalNamaSiswa({ mode = 'add', value = '' } = {}) {
    if (!modalNamaSiswa || !inputNamaSiswaModal) {
        // Jika elemen modal tidak tersedia, batalkan dengan aman.
        return Promise.resolve(null);
    }

    return new Promise(resolve => {
        resolverModalNamaSiswa = resolve;
        const isEdit = mode === 'edit';

        judulNamaSiswaModal.textContent = isEdit
            ? (t('editStudent') || 'Edit nama siswa')
            : (t('promptAddStudent') || 'Tambah Siswa');

        deskripsiNamaSiswaModal.textContent = isEdit
            ? (t('editStudentPrompt') || 'Edit nama siswa:')
            : (t('promptAddStudent') || 'Masukkan nama lengkap siswa:');

        inputNamaSiswaModal.value = value || '';
        inputNamaSiswaModal.placeholder = isEdit ? value : 'Contoh: Ahmad Fauzi';
        modalNamaSiswa.classList.add('muncul');
        modalNamaSiswa.setAttribute('aria-hidden', 'false');

        requestAnimationFrame(() => {
            inputNamaSiswaModal.focus();
            inputNamaSiswaModal.select();
        });
    });
}

function tutupModalNamaSiswa(nilai = null) {
    if (!modalNamaSiswa) return;
    modalNamaSiswa.classList.remove('muncul');
    modalNamaSiswa.setAttribute('aria-hidden', 'true');

    const resolve = resolverModalNamaSiswa;
    resolverModalNamaSiswa = null;
    if (resolve) resolve(nilai);
}

btnBatalNamaSiswaModal?.addEventListener('click', () => {
    tutupModalNamaSiswa(null);
});

btnSimpanNamaSiswaModal?.addEventListener('click', () => {
    tutupModalNamaSiswa(inputNamaSiswaModal?.value ?? '');
});

inputNamaSiswaModal?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        tutupModalNamaSiswa(inputNamaSiswaModal?.value ?? '');
    } else if (event.key === 'Escape') {
        event.preventDefault();
        tutupModalNamaSiswa(null);
    }
});

modalNamaSiswa?.addEventListener('click', event => {
    if (event.target === modalNamaSiswa) {
        tutupModalNamaSiswa(null);
    }
});

/* =====================================================
   TAMBAH SISWA
===================================================== */

async function tambahSiswaBaru() {

    const nama = await bukaModalNamaSiswa({
        mode: 'add',
        value: ''
    });

    if (nama === null) return;

    const namaBersih =
        nama.trim();


    if (!namaBersih) return;


    const sudahAda =
        semuaSiswa.some(
            siswa =>
                siswa.name.toLowerCase() ===
                namaBersih.toLowerCase()
        );


    if (sudahAda) {

        alert(t('duplicateStudent'));

        return;

    }


    const siswa = {

        id: buatId(),

        name: namaBersih,

        descriptor: null,

        photoBlob: null,

        createdAt:
            Date.now()

    };


    semuaSiswa.push(siswa);


    await simpanSiswaDB(siswa);

    renderSemuaSiswa();

    renderSemuaJadwal();

}


/* =====================================================
   STATUS DATA WAJAH
   Human AI menggunakan descriptorHuman. Foto tersimpan
   di photoBlob dan descriptorHuman menjadi sidik wajah AI.
===================================================== */

function ubahKeArrayNumerik(data) {
    if (data == null) return null;

    // TypedArray/Float32Array: tetap pertahankan nilai numeriknya, tetapi
    // normalisasi ke Array biasa agar format yang masuk/keluar IndexedDB,
    // JSON, dan matcher selalu konsisten.
    if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
        try {
            return Array.from(data, Number);
        } catch (_) {
            return null;
        }
    }

    if (Array.isArray(data)) {
        const hasil = data.map(Number);
        return hasil.every(Number.isFinite) ? hasil : null;
    }

    // JSON.stringify(Float32Array) menghasilkan objek berkunci "0", "1", ...
    // sehingga JSON.parse() dapat mengembalikannya sebagai plain object.
    if (typeof data === 'object') {
        const keys = Object.keys(data).sort((a, b) => Number(a) - Number(b));
        if (keys.length && keys.every(k => /^\d+$/.test(k))) {
            const hasil = keys.map(k => Number(data[k]));
            return hasil.every(Number.isFinite) ? hasil : null;
        }
    }

    return null;
}

function normalisasiEmbeddingData(data) {
    const sumber = data;
    if (sumber == null) return [];

    const tunggal = ubahKeArrayNumerik(sumber);
    if (tunggal?.length === 1024 && tunggal.every(Number.isFinite)) return [tunggal];

    // Embedding database biasanya berupa array berisi satu/lebih descriptor.
    if (Array.isArray(sumber) || (ArrayBuffer.isView(sumber) && !(sumber instanceof DataView))) {
        const daftar = Array.isArray(sumber) ? sumber : Array.from(sumber);
        const hasil = daftar
            .map(ubahKeArrayNumerik)
            .filter(item => Array.isArray(item) && item.length === 1024 && item.every(Number.isFinite));
        return hasil;
    }

    // Plain object hasil JSON.parse dari struktur typed-array bersarang.
    if (typeof sumber === 'object') {
        const keys = Object.keys(sumber).sort((a, b) => Number(a) - Number(b));
        if (keys.length && keys.every(k => /^\d+$/.test(k))) {
            const daftar = keys.map(k => sumber[k]);
            const hasil = daftar
                .map(ubahKeArrayNumerik)
                .filter(item => Array.isArray(item) && item.length === 1024 && item.every(Number.isFinite));
            return hasil;
        }
    }

    return [];
}

function normalisasiEmbeddingWajah(siswa) {
    if (!siswa) return [];
    const sumber = siswa.faceEmbeddings ?? siswa.descriptorHuman;
    return normalisasiEmbeddingData(sumber);
}

function siswaPunyaWajah(siswa) {
    return Boolean(siswa?.photoBlob && normalisasiEmbeddingWajah(siswa).length);
}

function buatPesanKosong(container, className, message) {
    if (!container) return null;

    const el = document.createElement('div');
    el.className = className;
    el.textContent = message || '';
    container.appendChild(el);
    return el;
}

function buatPreviewGambar(src, alt = '') {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    return img;
}

/* =====================================================
   RENDER SISWA
===================================================== */

function renderSemuaSiswa() {
    const container = document.getElementById('daftarSiswa');
    if (!container) return;

    bersihkanObjectURLs(studentObjectURLs);

    container.innerHTML = '';
    const keyword = String(document.getElementById('inputCariSiswa')?.value || '').trim().toLowerCase();

    if (semuaSiswa.length === 0) {
        const kosong = buatPesanKosong(container, 'daftar-siswa-kosong', t('noStudents'));
        if (kosong) {
            kosong.style.cssText = 'text-align:center;color:#888;font-size:13px;padding:15px;';
        }
        return;
    }

    const siswaTampil = keyword
        ? semuaSiswa.filter(siswa => String(siswa.name || '').toLowerCase().includes(keyword))
        : semuaSiswa;

    if (siswaTampil.length === 0) {
        const kosong = buatPesanKosong(container, 'daftar-siswa-kosong', t('noSearchResults'));
        if (kosong) {
            kosong.style.cssText = 'text-align:center;color:#888;font-size:13px;padding:15px;';
        }
        return;
    }

    siswaTampil.forEach(siswa => {
        const div = document.createElement('div');
        div.className = 'siswa-item';

        const foto = document.createElement('div');
        foto.className = 'siswa-foto';

        if (siswa.photoBlob) {
            const img = document.createElement('img');
            const objectUrl = URL.createObjectURL(siswa.photoBlob);
            activeObjectURLs.add(objectUrl);
            studentObjectURLs.add(objectUrl);
            img.src = objectUrl;
            const revoke = () => {
                try { URL.revokeObjectURL(objectUrl); } catch (_) {}
                activeObjectURLs.delete(objectUrl);
                studentObjectURLs.delete(objectUrl);
            };
            img.onload = revoke;
            img.onerror = revoke;
            foto.appendChild(img);
        } else {
            foto.innerText = '👤';
        }

        const info = document.createElement('div');
        info.className = 'siswa-info';

        const nama = document.createElement('div');
        nama.className = 'siswa-nama';
        nama.innerText = siswa.name;

        const status = document.createElement('div');
        const punyaWajah = siswaPunyaWajah(siswa);
        status.className = 'status-foto ' + (punyaWajah ? 'sudah' : '');
        status.innerText = punyaWajah ? t('photoRegistered') : t('photoMissing');

        info.append(nama, status);

        const aksi = document.createElement('div');
        aksi.className = 'siswa-aksi';

        const btnFoto = document.createElement('button');
        btnFoto.className = 'btn-foto ' + (punyaWajah ? 'sudah' : '');
        btnFoto.innerText = punyaWajah ? t('changePhoto') : t('addPhoto');
        btnFoto.type = 'button';
        btnFoto.onclick = () => bukaModalFoto(siswa.id);

        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn-edit-siswa';
        btnEdit.type = 'button';
        btnEdit.innerText = '✎';
        btnEdit.title = t('editStudent');
        btnEdit.setAttribute('aria-label', t('editStudent'));
        btnEdit.onclick = () => editSiswa(siswa.id);

        const btnHapus = document.createElement('button');
        btnHapus.className = 'btn-hapus-siswa';
        btnHapus.type = 'button';
        btnHapus.innerText = '×';
        btnHapus.title = t('deleteStudent');
        btnHapus.setAttribute('aria-label', t('deleteStudent'));
        btnHapus.onclick = () => hapusSiswa(siswa.id);

        aksi.append(btnFoto, btnEdit, btnHapus);
        div.append(foto, info, aksi);
        container.appendChild(div);
    });
}


/* =====================================================
   EDIT SISWA
===================================================== */

async function editSiswa(id) {
    const siswa = semuaSiswa.find(s => s.id === id);
    if (!siswa) return;

    const namaLama = siswa.name;
    const namaBaru = await bukaModalNamaSiswa({
        mode: 'edit',
        value: namaLama
    });
    if (namaBaru === null) return;

    const namaBersih = namaBaru.trim();
    if (!namaBersih) return;

    const duplikat = semuaSiswa.some(
        s => s.id !== id && String(s.name || '').trim().toLowerCase() === namaBersih.toLowerCase()
    );
    if (duplikat) {
        alert(t('duplicateStudent'));
        return;
    }

    if (namaBersih === namaLama) return;

    siswa.name = namaBersih;

    try {
        await simpanSiswaDB(siswa);
        renderSemuaSiswa();
        renderSemuaJadwal();
        faceDatabase = await siapkanDataWajah();
        tampilkanToast(t('editSaved'));
    } catch (error) {
        siswa.name = namaLama;
        renderSemuaSiswa();
        renderSemuaJadwal();
        alert(replaceTemplate(t('editSaveError'), { message: error?.message || t('openDbError') }));
    }
}


/* =====================================================
   TAMBAH SISWA MASSAL

   Sebelumnya memakai prompt() bawaan browser, yang hanya
   berupa kotak isian satu baris: tombol Enter langsung
   mengirim dialog (tidak bisa disisipi baris baru), dan
   saat menempel daftar nama bermulti-baris, browser sering
   menggabungkannya jadi satu baris teks. Akibatnya hanya
   satu "nama" panjang yang tersimpan -- persis seperti
   Tambah Siswa biasa. Diganti dengan modal bertextarea agar
   banyak baris benar-benar bisa diketik/ditempel.
===================================================== */

const modalSiswaMassal = document.getElementById('modalSiswaMassal');
const inputSiswaMassal = document.getElementById('inputSiswaMassal');
const infoSiswaMassal = document.getElementById('infoSiswaMassal');

const BULK_CHUNK_SIZE = 50;

function uraikanNamaMassal(teks) {
    return Array.from(new Set(
        String(teks || '')
            .split(/[,;\n]+/)
            .map(n => n.trim())
            .filter(Boolean)
    ));
}

function perbaruiInfoSiswaMassal() {
    if (!infoSiswaMassal || !inputSiswaMassal) return;

    const jumlah = uraikanNamaMassal(inputSiswaMassal.value).length;
    const max = 200;
    if (!jumlah) {
        infoSiswaMassal.textContent = '';
        return;
    }

    if (jumlah > max) {
        infoSiswaMassal.textContent = konfigurasi?.bahasa === 'en'
            ? `Maximum ${max} names per bulk insertion.`
            : `Maksimal ${max} nama per sekali tambah massal.`;
        infoSiswaMassal.style.color = 'var(--danger)';
        return;
    }

    infoSiswaMassal.textContent = replaceTemplate(t('bulkAddCount'), { count: jumlah });
    infoSiswaMassal.style.color = '#28a745';
}

inputSiswaMassal?.addEventListener('input', perbaruiInfoSiswaMassal);

function tambahSiswaMassal() {
    if (!modalSiswaMassal || !inputSiswaMassal) return;

    inputSiswaMassal.value = '';
    perbaruiInfoSiswaMassal();
    modalSiswaMassal.classList.add('muncul');

    setTimeout(() => inputSiswaMassal.focus(), 50);
}

function tutupModalSiswaMassal() {
    modalSiswaMassal?.classList.remove('muncul');
}

async function prosesSiswaMassal() {
    const namaArray = uraikanNamaMassal(inputSiswaMassal?.value);
    const MAX_BULK = 200;

    if (!namaArray.length) {
        alert(t('bulkAddEmpty'));
        return;
    }
    if (namaArray.length > MAX_BULK) {
        alert(konfigurasi?.bahasa === 'en'
            ? `Maximum ${MAX_BULK} names per bulk insertion.`
            : `Maksimal ${MAX_BULK} nama per sekali tambah massal.`);
        return;
    }

    const namaYangSudahAda = new Set(
        semuaSiswa.map(s => String(s.name || '').trim().toLowerCase())
    );

    const baru = [];
    let skipped = 0;
    for (const nama of namaArray) {
        const key = nama.toLowerCase();
        if (namaYangSudahAda.has(key)) {
            skipped++;
            continue;
        }
        const siswa = {
            id: buatId(),
            name: nama,
            descriptor: null,
            descriptorHuman: null,
            photoBlob: null,
            createdAt: Date.now()
        };
        namaYangSudahAda.add(key);
        baru.push(siswa);
    }

    if (!baru.length) {
        alert(replaceTemplate(t('bulkAddResult'), { added: 0, skipped }));
        return;
    }

    let db = null;
    try {
        db = await bukaDatabase();

        // Satu transaksi untuk seluruh batch: RAM baru berubah setelah transaksi complete.
        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                fn(value);
            };
            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                baru.forEach(siswa => store.put(siswa));
                tx.oncomplete = () => finish(resolve);
                tx.onerror = () => finish(reject, tx.error || new Error('Gagal menyimpan siswa massal.'));
                tx.onabort = () => finish(reject, tx.error || new Error('Penambahan siswa massal dibatalkan.'));
            } catch (error) {
                finish(reject, error);
            }
        });

        // Sinkronisasi konfigurasi juga diselesaikan sebelum UI dianggap berhasil.
        if (konfigurasi) {
            const configSebelum = konfigurasi;
            const configSesudah = {
                ...configSebelum,
                jadwal: { ...(configSebelum.jadwal || {}) }
            };
            konfigurasi = configSesudah;
            try {
                await simpanKonfigurasiDB(konfigurasi);
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(konfigurasi)); } catch (_) {}
            } catch (configError) {
                console.warn('Siswa sudah tersimpan, tetapi sinkronisasi konfigurasi gagal:', configError);
            }
        }

        db.close();
        db = null;

        semuaSiswa.push(...baru);
        renderSemuaSiswa();
        renderSemuaJadwal();
        tutupModalSiswaMassal();
        tampilkanToast(replaceTemplate(t('bulkAddResult'), { added: baru.length, skipped }));
    } catch (error) {
        try { db?.close?.(); } catch (_) {}
        alert(replaceTemplate(t('bulkSaveError'), { message: error?.message || t('openDbError') }));
    }
}


document.getElementById('inputCariSiswa')?.addEventListener('input', () => {
    renderSemuaSiswa();
});


/* =====================================================
   HAPUS SISWA
===================================================== */

async function hapusSiswa(id) {
    const siswa = semuaSiswa.find(s => s.id === id);
    if (!siswa) return;

    if (!confirm(replaceTemplate(t('confirmDeleteStudent'), { name: siswa.name }))) {
        return;
    }

    try {
        // IndexedDB menjadi sumber kebenaran: hapus di DB lebih dahulu.
        await hapusSiswaDB(id);

        // RAM hanya diubah setelah penghapusan DB berhasil.
        semuaSiswa = semuaSiswa.filter(s => s.id !== id);
        faceDatabase = Array.isArray(faceDatabase)
            ? faceDatabase.filter(item => item.id !== id)
            : [];

        if (konfigurasi) {
            for (const hari of hariKerja) {
                konfigurasi.jadwal[hari] = (konfigurasi.jadwal[hari] || []).filter(sid => sid !== id);
            }
            try {
                await simpanKonfigurasiDB(konfigurasi);
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(konfigurasi)); } catch (_) {}
            } catch (configError) {
                console.warn('Siswa terhapus tetapi jadwal gagal disimpan ulang:', configError);
            }
        }

        renderSemuaSiswa();
        renderSemuaJadwal();
        tampilkanToast(t('studentDeleted') || (konfigurasi?.bahasa === 'en' ? 'Student deleted.' : 'Siswa berhasil dihapus.'));
    } catch (error) {
        console.error('Gagal menghapus siswa dari DB:', error);
        alert(konfigurasi?.bahasa === 'en'
            ? 'The student could not be deleted from device storage.'
            : 'Siswa gagal dihapus dari penyimpanan perangkat.');
    }
}


/* =====================================================
   MODAL FOTO
===================================================== */

function bukaModalFoto(id) {

    const siswa =
        semuaSiswa.find(
            s => s.id === id
        );


    if (!siswa) return;


    studentIdFotoAktif =
        id;


    document.getElementById(
        'namaSiswaFoto'
    ).innerText =
        replaceTemplate(t('studentLabel'), { name: siswa.name });


    inputFoto.value = '';


    previewFoto.replaceChildren();
    const placeholder = document.createElement('span');
    placeholder.textContent = t('chooseFacePhoto');
    previewFoto.appendChild(placeholder);


    modalFoto.classList.add(
        'muncul'
    );

}


function tutupModalFoto() {

    modalFoto.classList.remove(
        'muncul'
    );

    studentIdFotoAktif = null;

}


/* =====================================================
   PREVIEW FILE
===================================================== */

inputFoto.addEventListener(
    'change',
    () => {

        const file =
            inputFoto.files[0];

        if (!file) return;


        const reader =
            new FileReader();


        reader.onload =
            event => {

                previewFoto.replaceChildren();
                const img = buatPreviewGambar(event?.target?.result || '', t('chooseFacePhoto'));
                previewFoto.appendChild(img);

            };


        reader.readAsDataURL(file);

    }
);


/* =====================================================
   BUAT FOTO 1:1
===================================================== */

function buatFotoSquare(file) {

    return new Promise(
        (resolve, reject) => {

            const reader =
                new FileReader();


            reader.onload =
                event => {

                    const img =
                        new Image();


                    img.onload =
                        () => {

                            // Catatan perbaikan: sebelumnya foto di-crop persegi dari
                            // bagian TENGAH (memotong sisi kiri/kanan atau atas/bawah).
                            // Ini berisiko memotong sebagian wajah pada foto potret
                            // dengan banyak ruang di atas kepala, sehingga AI kadang
                            // gagal mendeteksi wajah sama sekali. Sekarang seluruh
                            // foto asli selalu ditampilkan utuh ("contain"), diberi
                            // latar netral di sisi yang kosong, agar wajah tidak
                            // pernah terpotong sebelum diproses AI.
                            const skala =
                                Math.min(
                                    600 / img.width,
                                    600 / img.height
                                );

                            const lebarGambar =
                                img.width * skala;

                            const tinggiGambar =
                                img.height * skala;

                            const offsetX =
                                (600 - lebarGambar) / 2;

                            const offsetY =
                                (600 - tinggiGambar) / 2;


                            const canvas =
                                document.createElement(
                                    'canvas'
                                );


                            canvas.width =
                                600;

                            canvas.height =
                                600;


                            const ctx =
                                canvas.getContext(
                                    '2d'
                                );


                            ctx.fillStyle =
                                '#F4F5FA';

                            ctx.fillRect(
                                0,
                                0,
                                600,
                                600
                            );

                            ctx.drawImage(
                                img,
                                0,
                                0,
                                img.width,
                                img.height,
                                offsetX,
                                offsetY,
                                lebarGambar,
                                tinggiGambar
                            );


                            canvas.toBlob(
                                blob => {

                                    if (blob) {

                                        resolve(
                                            blob
                                        );

                                    } else {

                                        reject(
                                            new Error(
                                                'Gagal membuat foto.'
                                            )
                                        );

                                    }

                                },
                                'image/jpeg',
                                0.90
                            );

                        };


                    img.onerror =
                        () =>
                            reject(
                                new Error(
                                    'Foto tidak valid.'
                                )
                            );


                    img.src =
                        event.target.result;

                };


            reader.onerror =
                () =>
                    reject(
                        new Error(
                            'Gagal membaca foto.'
                        )
                    );


            reader.readAsDataURL(file);

        }
    );

}


/* =====================================================
   PEMBACA BLOB MENJADI HTMLImageElement
   Dipakai oleh proses pendaftaran 1 foto wajah.
===================================================== */
function loadImageElementFromBlob(blob) {
    return new Promise((resolve, reject) => {
        if (!(blob instanceof Blob) || !blob.size) {
            reject(new Error('Foto hasil pemrosesan tidak valid.'));
            return;
        }

        const url = URL.createObjectURL(blob);
        const img = new Image();

        const cleanup = () => {
            URL.revokeObjectURL(url);
            img.onload = null;
            img.onerror = null;
        };

        img.onload = () => {
            cleanup();
            resolve(img);
        };

        img.onerror = () => {
            cleanup();
            reject(new Error('Gagal memuat foto untuk analisis wajah.'));
        };

        img.src = url;
    });
}


/* =====================================================
   PROSES FOTO WAJAH
===================================================== */


function bunyikanSuaraJepret() {
    try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return false;

        if (!audioContextJepret) audioContextJepret = new AudioContextCtor();
        const ctx = audioContextJepret;
        const lanjut = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();

        void lanjut.then(() => {
            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, now);
            osc.frequency.exponentialRampToValueAtTime(100, now + 0.05);
            gain.gain.setValueAtTime(0.18, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.05);
            osc.addEventListener('ended', () => {
                try { osc.disconnect(); gain.disconnect(); } catch (_) {}
            }, { once: true });
        }).catch(error => console.warn('Audio jepret tidak dapat diputar:', error));

        return true;
    } catch (error) {
        console.warn('Audio jepret gagal dipanggil:', error);
        return false;
    }
}

async function prosesFotoWajah() {
    const targetStudentId = studentIdFotoAktif;
    const files = Array.from(inputFoto?.files || []).slice(0, 1);

    if (!targetStudentId || files.length !== 1) {
        alert(files.length ? t('chooseFacePhoto') : t('choosePhotoFirst'));
        return;
    }

    const file = files[0];
    if (!file.type.startsWith('image/')) {
        alert(t('fileMustBeImage'));
        return;
    }

    const siswaAwal = semuaSiswa.find(s => s.id === targetStudentId);
    if (!siswaAwal) return;

    const tombol = document.querySelector('#modalFoto .btn-proses-foto');
    if (tombol) tombol.disabled = true;

    try {
        tombol && (tombol.innerText = t('processLoadAI'));
        await muatModelAI();

        // Konteks siswa masih harus sama setelah setiap tahap async penting.
        if (studentIdFotoAktif !== targetStudentId) return;

        tombol && (tombol.innerText = konfigurasi?.bahasa === 'en' ? 'Analyzing face…' : 'Menganalisis wajah…');
        const squareBlob = await buatFotoSquare(file);
        const img = await loadImageElementFromBlob(squareBlob);

        const hasil = await deteksiHumanTerkunci(img, {
            face: {
                detector: { minConfidence: 0.25, minSize: 80, rotation: true, return: true },
                mesh: { enabled: true },
                description: { enabled: true },
                iris: { enabled: true },
                antispoof: { enabled: true },
                liveness: { enabled: true }
            },
            gesture: { enabled: false }
        });

        const facesHasil = normalisasiFaceResults(hasil);
        if (!facesHasil.length) throw new Error(t('errorFaceNotDetected'));
        if (facesHasil.length !== 1) throw new Error(t('errorOneFace'));

        const wajah = facesHasil[0];
        if (!wajah.embedding?.length || wajah.embedding.length !== 1024 || !wajah.embedding.every(Number.isFinite)) {
            throw new Error(t('errorEmbeddingFormat'));
        }

        const confidence = Number(wajah.faceScore ?? wajah.boxScore ?? 0);
        if (!Number.isFinite(confidence) || confidence < AI_IDENTITY_MIN_SCORE) throw new Error(t('errorFaceQuality'));

        const embedding = Array.from(wajah.embedding);
        const embeddings = [embedding];

        // Jangan pernah menyimpan hasil AI jika modal sudah berpindah ke siswa lain.
        if (studentIdFotoAktif !== targetStudentId) {
            console.warn('Proses AI dibatalkan karena konteks ID siswa telah berubah.');
            return;
        }

        const siswaIndex = semuaSiswa.findIndex(s => s.id === targetStudentId);
        if (siswaIndex === -1) return;

        const siswaTerbaru = semuaSiswa[siswaIndex];
        siswaTerbaru.photoBlob = squareBlob;
        siswaTerbaru.descriptorHuman = embeddings;
        siswaTerbaru.faceEmbeddings = embeddings;

        await simpanSiswaDB(siswaTerbaru);
        semuaSiswa[siswaIndex] = siswaTerbaru;

        if (studentIdFotoAktif !== targetStudentId) {
            console.warn('Konteks berubah setelah penyimpanan DB; state UI tidak diteruskan.');
            return;
        }

        renderSemuaSiswa();
        renderSemuaJadwal();
        tutupModalFoto();
        faceDatabase = await siapkanDataWajah();

        alert(
            replaceTemplate(t('successPhoto'), { name: siswaTerbaru.name }) +
            '\nTersimpan 1 referensi wajah.'
        );
    } catch (error) {
        console.error('Proses foto gagal:', error);
        const detail = error?.name === 'BiometricProtectionError'
            ? 'Data wajah tidak disimpan karena browser tidak menyediakan enkripsi biometrik yang aman.'
            : (error?.message || 'Pastikan foto berisi tepat satu wajah yang jelas.');
        alert(t('errorPhotoProcess') + '\n\n' + detail);
    } finally {
        if (tombol) {
            tombol.disabled = false;
            tombol.innerText = t('savePhoto');
        }
    }
}

function renderSemuaJadwal() {

    const area =
        document.getElementById(
            'areaJadwal'
        );


    area.innerHTML = '';


    hariKerja.forEach(
        hari => {

            const card =
                document.createElement(
                    'div'
                );

            card.className =
                'jadwal-card';


            const headerHari = document.createElement('div');
            headerHari.className = 'jadwal-header';

            const title = document.createElement('h3');
            const indexHari = namaHari.indexOf(hari);
            title.innerText = '📅 ' + hariTampilan(indexHari);

            const btnClear = document.createElement('button');
            btnClear.type = 'button';
            btnClear.className = 'btn-clear-jadwal';
            btnClear.textContent = t('clearSchedule');
            btnClear.disabled = !(
                konfigurasi?.jadwal?.[hari]?.length
            );
            btnClear.addEventListener('click', async () => {
                if (!konfigurasi) return;
                const adaJadwal = Array.isArray(konfigurasi.jadwal?.[hari]) && konfigurasi.jadwal[hari].length > 0;
                if (!adaJadwal) return;

                const yakin = confirm(
                    replaceTemplate(t('clearScheduleConfirm'), { day: hariTampilan(indexHari) })
                );
                if (!yakin) return;

                const jadwalLama = konfigurasi.jadwal?.[hari] || [];
                konfigurasi.jadwal = { ...(konfigurasi.jadwal || {}), [hari]: [] };

                try {
                    await simpanKonfigurasiDB(konfigurasi);
                    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(konfigurasi)); } catch (_) {}
                    renderSemuaJadwal();
                    tampilkanToast(
                        replaceTemplate(t('clearScheduleSaved'), { day: hariTampilan(indexHari) })
                    );
                } catch (error) {
                    konfigurasi.jadwal[hari] = jadwalLama;
                    renderSemuaJadwal();
                    alert(replaceTemplate(t('clearScheduleError'), { message: error?.message || t('openDbError') }));
                }
            });

            headerHari.appendChild(title);
            headerHari.appendChild(btnClear);
            card.appendChild(headerHari);


            const list =
                document.createElement(
                    'div'
                );

            list.className =
                'jadwal-list';


            if (semuaSiswa.length === 0) {
                buatPesanKosong(list, 'jadwal-kosong', t('emptySchedule'));
            } else {

                semuaSiswa.forEach(
                    siswa => {

                        const row =
                            document.createElement(
                                'div'
                            );

                        row.className =
                            'jadwal-siswa';


                        const checkbox =
                            document.createElement(
                                'input'
                            );

                        checkbox.type =
                            'checkbox';

                        checkbox.dataset.id =
                            siswa.id;


                        const jadwalSekarang =
                            konfigurasi &&
                            konfigurasi.jadwal &&
                            konfigurasi.jadwal[hari]
                            ? konfigurasi.jadwal[hari]
                            : [];


                        checkbox.checked =
                            jadwalSekarang.includes(
                                siswa.id
                            );


                        const label =
                            document.createElement(
                                'label'
                            );

                        label.innerText =
                            siswa.name;


                        if (!siswaPunyaWajah(siswa)) {
                            const keteranganWajah = document.createElement('span');
                            keteranganWajah.style.color = '#dc3545';
                            keteranganWajah.style.fontSize = '10px';
                            keteranganWajah.style.display = 'block';
                            keteranganWajah.textContent = t('noFacePhoto');
                            label.appendChild(keteranganWajah);
                        }


                        row.appendChild(
                            checkbox
                        );

                        row.appendChild(
                            label
                        );


                        list.appendChild(
                            row
                        );

                    }
                );

            }


            card.appendChild(
                list
            );


            area.appendChild(
                card
            );

        }
    );

}


async function simpanKonfigurasiDB(config) {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        let selesai = false;
        const tutupDanResolve = () => {
            if (selesai) return;
            selesai = true;
            db.close();
            resolve();
        };
        const tutupDanReject = error => {
            if (selesai) return;
            selesai = true;
            db.close();
            reject(error || new Error('Gagal menyimpan konfigurasi.'));
        };

        try {
            const tx = db.transaction(CONFIG_STORE_NAME, 'readwrite');
            tx.objectStore(CONFIG_STORE_NAME).put({
                id: 'main',
                data: config,
                updatedAt: Date.now()
            });
            tx.oncomplete = tutupDanResolve;
            tx.onerror = () => tutupDanReject(tx.error);
            tx.onabort = () => tutupDanReject(
                tx.error || new Error('Penyimpanan konfigurasi dibatalkan.')
            );
        } catch (error) {
            tutupDanReject(error);
        }
    });
}

async function ambilKonfigurasiDB() {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        let selesai = false;
        const selesaiBaca = value => {
            if (selesai) return;
            selesai = true;
            resolve(value);
        };
        const gagalBaca = error => {
            if (selesai) return;
            selesai = true;
            db.close();
            reject(error || new Error('Gagal membaca konfigurasi.'));
        };

        try {
            const tx = db.transaction(CONFIG_STORE_NAME, 'readonly');
            const request = tx.objectStore(CONFIG_STORE_NAME).get('main');
            request.onsuccess = () => selesaiBaca(request.result?.data || null);
            request.onerror = () => gagalBaca(request.error);
            tx.oncomplete = () => {
                db.close();
            };
            tx.onerror = () => {
                db.close();
            };
            tx.onabort = () => gagalBaca(
                tx.error || new Error('Pembacaan konfigurasi dibatalkan.')
            );
        } catch (error) {
            gagalBaca(error);
        }
    });
}

let toastTimer = null;
function tampilkanToast(pesan, durasi = 1800) {
    const toast = document.getElementById('appToast');
    if (!toast) return;
    toast.textContent = pesan;
    toast.classList.add('muncul');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('muncul'), durasi);
}

/* =====================================================
   SIMPAN SEMUA PENGATURAN
===================================================== */

let pengaturanSedangDisimpan = false;

async function simpanSemuaPengaturan() {
    if (pengaturanSedangDisimpan) return;
    pengaturanSedangDisimpan = true;
    const tombol = document.getElementById('btnSimpanPengaturan');
    if (tombol) tombol.disabled = true;
    try {
        return await simpanSemuaPengaturanImpl();
    } finally {
        pengaturanSedangDisimpan = false;
        if (tombol) tombol.disabled = false;
    }
}

async function simpanSemuaPengaturanImpl() {

    if (
        semuaSiswa.length === 0
    ) {

        alert(t('settingsNeedStudent'));

        return;

    }


    const siswaTanpaFoto =
        semuaSiswa.filter(
            siswa =>
                !siswaPunyaWajah(siswa)
        );


    if (
        siswaTanpaFoto.length > 0
    ) {

        const nama =
            siswaTanpaFoto
                .map(
                    s => s.name
                )
                .join(', ');


        const lanjut =
            confirm(
                replaceTemplate(t('missingFaceConfirm'), { names: nama })
            );


        if (!lanjut) return;

    }


    const jadwal = {};


    hariKerja.forEach(
        hari => {

            const checkbox =
                document.querySelectorAll(
                    `#areaJadwal .jadwal-card:nth-child(${hariKerja.indexOf(hari) + 1}) input[type="checkbox"]`
                );


            jadwal[hari] =
                Array.from(
                    checkbox
                )
                .filter(
                    cb => cb.checked
                )
                .map(
                    cb => cb.dataset.id
                );

        }
    );


    const totalJadwal =
        Object.values(jadwal)
            .reduce(
                (total, arr) =>
                    total + arr.length,
                0
            );

    const hariAktifPiket = Array.from(
        document.querySelectorAll('#hariAktifGrid input[type="checkbox"]:checked')
    )
    .map(cb => cb.dataset.hari)
    .filter(hari => hariKerja.includes(hari));

    if (hariAktifPiket.length === 0) {
        alert(konfigurasi?.bahasa === 'en'
            ? 'Select at least one active duty day.'
            : 'Pilih minimal satu hari aktif piket.');
        return;
    }

    const backendApiBaseUrl = normalizeBackendUrl(
        document.getElementById('inputBackendApiBaseUrl')?.value || ''
    );


    if (totalJadwal === 0) {

        alert(t('settingsNeedSchedule'));

        return;

    }


    /* PIN Ruang Guru dikelola dari Ruang Guru, bukan dari pengaturan murid.
       Saat menyimpan pengaturan kelas, PIN lama cukup dipertahankan apa adanya. */
    const guruPinHash = konfigurasi?.guruPinHash || '';
    const guruPinSalt = konfigurasi?.guruPinSalt || '';

    konfigurasi = {

        kelas:
            document.getElementById(
                'pilihKelas'
            ).value,

        jurusan:
            document.getElementById(
                'pilihJurusan'
            ).value,

        ruangan:
            document.getElementById(
                'pilihRuangan'
            ).value,

        guruPinHash,
        guruPinSalt,

        bahasa: document.getElementById('pilihBahasa')?.value === 'en' ? 'en' : 'id',
        rasioKamera: konfigurasi?.rasioKamera === '9:16' ? '9:16' : '16:9',
        hariAktifPiket,
        backendApiBaseUrl,

        jadwal

    };


    try {
        /* IndexedDB adalah sumber utama. */
        await simpanKonfigurasiDB(konfigurasi);
    } catch (error) {
        console.error('Gagal menyimpan konfigurasi ke IndexedDB:', error);
        alert(
            replaceTemplate(t('settingsSaveError'), {
                message: error?.message || (konfigurasi?.bahasa === 'en' ? 'Try again.' : 'Silakan coba lagi.')
            })
        );
        return;
    }

    /* localStorage hanya mirror kompatibilitas. Kegagalan mirror tidak boleh
       membuat pengguna mendapat pesan gagal, karena data utama sudah tersimpan. */
    try {
        setLocalStorageSafe(
            STORAGE_KEY,
            JSON.stringify(konfigurasi),
            { preserveKeys: [GURU_PIN_LOCK_KEY, GURU_PIN_FAIL_KEY] }
        );
    } catch (error) {
        console.warn(
            'Mirror localStorage tidak dapat diperbarui:',
            error
        );
    }


    terapkanBahasa(konfigurasi.bahasa);
    terapkanRasioKamera(konfigurasi.rasioKamera);

    // Pindah ke mode kamera segera setelah penyimpanan berhasil.
    // Tidak memakai alert agar dialog browser tidak menahan perpindahan layar.
    tampilkanToast(t('settingsSavedToast'));
    pastikanPenyimpananPermanen().catch(console.warn);
    autoPruneRiwayatAbsensi(30).catch(console.warn);

    await tampilkanKamera();

}


/* =====================================================
   LOAD CONFIG
===================================================== */

async function loadConfig() {

    semuaSiswa =
        await ambilSemuaSiswaDB();


    try {
        // IndexedDB menjadi sumber utama. Jika belum ada, migrasikan konfigurasi
        // lama dari localStorage sekali saja.
        konfigurasi = await ambilKonfigurasiDB();

        if (!konfigurasi) {
            let tersimpan = null;
            try {
                tersimpan = localStorage.getItem(STORAGE_KEY);
            } catch (error) {
                console.warn('LocalStorage tidak dapat dibaca saat loadConfig:', error);
            }

            if (tersimpan) {
                try {
                    konfigurasi = JSON.parse(tersimpan);
                    await simpanKonfigurasiDB(konfigurasi);
                } catch (error) {
                    console.warn(
                        'Konfigurasi lama di localStorage tidak valid:',
                        error
                    );
                    konfigurasi = null;
                }
            }
        }

        if (!konfigurasi) {
            buatSetupAwal();
            return false;
        }


        document.getElementById(
            'pilihKelas'
        ).value =
            konfigurasi.kelas;


        document.getElementById(
            'pilihJurusan'
        ).value =
            konfigurasi.jurusan;


        konfigurasi = {
            ...konfigurasi,
            bahasa: konfigurasi.bahasa === 'en' ? 'en' : 'id',
            rasioKamera: konfigurasi.rasioKamera === '9:16' ? '9:16' : '16:9',
            hariAktifPiket: Array.isArray(konfigurasi.hariAktifPiket)
                ? konfigurasi.hariAktifPiket.filter(hari => hariKerja.includes(hari))
                : [...HARI_AKTIF_DEFAULT],
            backendApiBaseUrl: normalizeBackendUrl(konfigurasi.backendApiBaseUrl || ''),
            jadwal: Object.fromEntries(
                hariKerja.map(hari => [
                    hari,
                    Array.isArray(konfigurasi.jadwal?.[hari]) ? konfigurasi.jadwal[hari] : []
                ])
            )
        };

        document.getElementById(
            'pilihRuangan'
        ).value =
            konfigurasi.ruangan;

        const pilihBahasa = document.getElementById('pilihBahasa');
        const pilihRasioKamera = document.getElementById('pilihRasioKamera');
        if (pilihBahasa) pilihBahasa.value = konfigurasi.bahasa;
        if (pilihRasioKamera) pilihRasioKamera.value = konfigurasi.rasioKamera;
        const backendInput = document.getElementById('inputBackendApiBaseUrl');
        if (backendInput) backendInput.value = konfigurasi.backendApiBaseUrl || '';
        terapkanBahasa(konfigurasi.bahasa);
        renderHariAktifPiket();
        updateBackendStatusText();
        terapkanRasioKamera(konfigurasi.rasioKamera);



        renderSemuaSiswa();

        renderSemuaJadwal();


        return true;


    } catch (error) {

        console.error(
            error
        );

        buatSetupAwal();

        return false;

    }

}



/* =====================================================
   BAHASA & TAMPILAN KAMERA
===================================================== */
const TRANSLATIONS = {
    id: {
        appTitle: 'Absensi Piket Kelas',
        setupTitle: 'ABSENSI PIKET KELAS',
        setupStudentDesc: 'Tambahkan semua siswa yang akan dikenali oleh sistem.\n                Setiap siswa cukup memiliki satu foto wajah yang jelas.',
        promptAddStudent: 'Masukkan nama lengkap siswa:',
        duplicateStudent: 'Nama siswa tersebut sudah terdaftar.',
        settingsNeedStudent: 'Tambahkan minimal satu siswa.',
        missingFaceConfirm: 'Siswa berikut belum memiliki foto wajah:\n\n{names}\n\nTetap simpan pengaturan?',
        settingsNeedSchedule: 'Pilih minimal satu siswa untuk jadwal piket.',
        settingsSaveError: 'Pengaturan gagal disimpan ke database browser.\n\n{message}',
        settingsSavedToast: 'Pengaturan tersimpan. Membuka kamera…',
        flashUnsupported: 'Flash tidak didukung perangkat ini.',
        resumeAttendance: 'Absen piket belum selesai.\n\nYuk lanjutkan lagi ya 🙂',
        openDbError: 'Gagal membuka database browser.',
        sizeTooLarge: 'Ukuran foto terlalu besar. Maksimal 15 MB sebelum dikompres.',
        exit: 'Keluar',
        noStudents: 'Belum ada siswa.',
        photoRegistered: '✓ Foto wajah terdaftar',
        photoMissing: '⚠ Foto wajah belum ada',
        changePhoto: 'Ganti Foto',
        addPhoto: 'Tambah Foto',
        confirmDeleteStudent: 'Hapus siswa "{name}"?',
        studentLabel: 'Siswa: {name}',
        chooseFacePhoto: 'Pilih 1 foto wajah yang jelas<br>dengan rasio 1:1',
        choosePhotoFirst: 'Pilih foto wajah terlebih dahulu.',
        fileMustBeImage: 'File harus berupa gambar.',
        processLoadAI: '⏳ Memuat AI…',
        processPreparePhoto: '⏳ Menyiapkan foto…',
        processAnalyzeFace: '⏳ Menganalisis wajah…',
        errorFaceNotDetected: 'Wajah tidak terdeteksi.',
        errorOneFace: 'Foto harus menampilkan tepat satu wajah.',
        errorEmbedding: 'Embedding wajah tidak berhasil dibuat.',
        errorEmbeddingFormat: 'Format embedding wajah tidak valid. Coba simpan foto lagi.',
        errorFaceQuality: 'Kualitas deteksi wajah terlalu rendah.',
        errorPhotoRead: 'Foto tidak dapat dibaca oleh browser.',
        errorPhotoProcess: 'Wajah tidak berhasil diproses.',
        successPhoto: 'Foto wajah {name} berhasil didaftarkan dengan AI Human. ✓',
        studentSetupRequired: 'Tambahkan siswa terlebih dahulu.',
        noFacePhoto: '⚠ Belum ada foto wajah',
        cameraRatioAria: 'Pengaturan rasio kamera',
        ratioPortrait: '9:16 — Portrait',
        ratioLandscape: '16:9 — Landscape',
        emptySchedule: 'Tambahkan siswa terlebih dahulu.',
        resultSave: 'Simpan & Selesai',
        savingReport: 'Menyimpan laporan…',
        reportUnavailableNow: 'Data hasil absensi belum tersedia. Silakan ambil foto lagi.',
        reportSaveError: 'Laporan absensi gagal disimpan.',
        resetWarningTitle: 'PERINGATAN!',
        resetWarningBody: 'Semua data siswa, foto wajah, jadwal, PIN Ruang Guru, laporan, dan foto bukti akan dihapus dari perangkat ini.',
        resetContinue: 'Lanjutkan?',
        resetFacesBody: 'Data wajah siswa juga akan dihapus.',
        resetConfirm: 'Yakin benar-benar ingin menghapus semuanya?',
        resetSuccess: 'Semua data berhasil dihapus.',
        cameraErrorTitle: '📷 Kamera belum dapat digunakan',
        preparingCamera: 'Kamera sedang dipersiapkan…',
        cameraStartMessage: 'Kamera belum dapat dimulai. Periksa izin kamera browser.',
        cameraErrorText: 'Izinkan akses kamera untuk melanjutkan absensi.',
        cameraClose: 'Tutup',
        cameraPermission: 'Izinkan Akses Kamera',
        cameraPermissionText: 'Izin kamera hanya dapat diberikan pada halaman HTTPS atau localhost. File HTML yang diunduh tidak dapat melewati pembatasan keamanan browser.',
        cameraBusyError: 'Kamera sedang digunakan oleh aplikasi lain. Harap matikan Video Call (WhatsApp/Zoom) atau tutup aplikasi kamera lain, lalu refresh halaman ini.',
        cameraLegacyFallback: 'Browser ini tidak menyediakan API kamera live. Gunakan browser modern (Chrome, Edge, atau Safari) dan buka aplikasi melalui HTTPS/localhost.',
        cameraPrivateMode: 'Anda mungkin berada di Mode Samaran/Privasi. Beberapa fitur offline dan PWA mungkin tidak berfungsi normal.',
        cameraVirtualError: 'Kamera virtual atau kamera palsu terdeteksi. Gunakan kamera bawaan perangkat untuk melanjutkan absensi.',
        cameraPrivacyError: 'Sistem privasi, extension, atau browser memblokir hasil pengambilan gambar. Matikan Shields/AdBlock untuk halaman ini atau gunakan browser utama.',
        cameraIframeError: 'Kamera dibuka di dalam iframe. Portal sekolah harus memberi izin camera pada iframe. Gunakan atribut: allow="camera; autoplay; fullscreen".',
        cameraIframeTitle: 'Kamera dalam iframe',
        cameraIframeText: 'Aplikasi sedang dibuka di dalam iframe. Portal sekolah harus mengizinkan kamera pada tag iframe agar kamera live dapat digunakan.',
        cameraUpdateTitle: 'Versi web terbaru tersedia',
        cameraUpdateText: 'Versi terbaru aplikasi absensi sudah siap. Perbarui halaman agar perubahan terbaru langsung digunakan.',
        cameraUpdateLater: 'Nanti',
        cameraUpdateNow: 'Perbarui Sekarang',
        cameraBatteryWarning: 'Baterai sangat rendah. Mode hemat daya dapat membuat kamera patah-patah atau lambat. Matikan Mode Hemat Daya sementara jika kamera bermasalah.',
        cameraPerformanceWarning: 'Kamera berjalan sangat lambat. Coba matikan Mode Hemat Daya, tutup aplikasi kamera/Video Call lain, lalu coba lagi.',
        cameraBacklightWarning: 'Pencahayaan wajah terlalu gelap karena cahaya dari belakang. Silakan berputar agar wajah menghadap sumber cahaya dan hindari jendela terang di belakang.',
        offlineAttendanceSaved: 'Sinyal terputus. Absensi tetap disimpan di HP dan tidak membutuhkan internet.',
        attendanceQueuedForSync: 'Absensi tersimpan di HP. Pengiriman ke server akan dicoba otomatis saat internet tersedia kembali.',
        attendanceSyncSuccess: '{count} absensi tertunda berhasil disinkronkan ke server.',
        onlineRestored: 'Koneksi internet kembali.',
        cameraStartError: 'Kamera belum dapat dimulai. Periksa izin kamera browser.',
        suggestionDescription: 'Masukan untuk kelas piket,<br>dari guru maupun murid',
        teacherTab: '👩‍🏫 Guru',
        studentTab: '🎓 Murid',
        roleTeacher: 'Guru',
        roleStudent: 'Siswa',
        writeSuggestionTeacher: '✍️ Tulis Saran (Guru)',
        writeSuggestionStudent: '✍️ Tulis Saran (Murid)',
        optionalName: 'Nama (opsional)',
        yourName: 'Nama Anda',
        suggestionLabel: 'Saran / Masukan',
        suggestionPlaceholder: 'Tulis saran Anda di sini...',
        proofPhotoOptional: '📷 Foto bukti (opsional)',
        sendSuggestion: 'Kirim Saran',
        emptySuggestions: 'Belum ada saran.',
        proofAttached: '📎 Foto bukti terlampir',
        proofPhoto: 'Foto bukti',
        removePhoto: 'Hapus foto',
        suggestionEmptyError: 'Saran tidak boleh kosong.',
        suggestionInappropriate: 'Saran mengandung kata yang tidak pantas.\n\nMohon gunakan bahasa yang sopan.',
        suggestionPhotoProcessError: 'Foto bukti gagal diproses. Saran belum dikirim.\n\nSilakan pilih foto lain.',
        suggestionPhotoSaveError: 'Foto bukti tidak dapat disimpan. Saran belum dikirim.',
        suggestionSaveError: 'Saran tidak dapat disimpan di perangkat ini. Silakan coba lagi.',
        suggestionThanksWithPhoto: 'Terima kasih, saran dan foto bukti sudah tersimpan! 🙏',
        suggestionThanks: 'Terima kasih, saran Anda sudah tersimpan! 🙏',
        reportPhotoAlt: 'Foto bukti absensi',
        photoPreviewAlt: 'Pratinjau foto bukti',
        removeProofPhoto: 'Hapus foto',
        setupDesc: 'Pengaturan sistem pertama kali.<br>Daftarkan siswa dan foto wajah mereka.',
        infoClass: '🏫 Informasi Kelas',
        classLabel: 'Kelas',
        majorLabel: 'Jurusan',
        roomLabel: 'Ruangan',
        preference: '🌐 Bahasa',
        language: 'Bahasa',
        cameraRatio: 'Rasio Kamera',
        ratioHint: 'Pilih tampilan kamera yang kamu mau.',
        studentData: '👤 Data Siswa',
        activeDaysTitle: '📅 Hari Aktif Piket',
        activeDaysDesc: 'Pilih hari yang diperbolehkan untuk absensi piket.',
        backendApiLabel: 'URL Backend REST API (opsional)',
        backendApiPlaceholder: 'https://domain-sekolah.example/api',
        backendApiHelp: 'Kosongkan bila aplikasi tetap dipakai lokal. Isi URL backend bila Kotak Saran dan data sekolah ingin disinkronkan antar-perangkat.',
        storageStatusChecking: 'Memeriksa penyimpanan permanen…',
        storageStatusPersisted: 'Penyimpanan permanen aktif di browser ini.',
        storageStatusRequested: 'Permintaan penyimpanan permanen sudah dikirim ke browser.',
        storageStatusUnavailable: 'Browser tidak menyediakan API penyimpanan permanen.',
        backendStatusLocal: 'Sinkronisasi backend: belum dikonfigurasi (mode lokal).',
        backendStatusConfigured: 'Sinkronisasi backend: URL API sudah dikonfigurasi.',
        backendStatusError: 'Sinkronisasi backend: endpoint tidak dapat dihubungi; data lokal tetap dipakai sebagai antrean.',
        manualCameraOnly: 'Absensi hanya dapat dilakukan dengan kamera live perangkat. Unggah foto dari galeri dinonaktifkan.',
        addStudent: '+ Tambah Siswa',
        saveSettings: '💾 Simpan Pengaturan & Mulai',
        suggestions: '💬 Kotak Saran (Guru & Murid)',
        teacherRoom: '👨‍🏫 Ruang Guru — Laporan Absensi',
        deleteAll: 'Hapus Semua Data',
        cameraTitle: 'ABSENSI PIKET KELAS',
        cameraClassInfo: 'KELAS {class} {major} • RUANGAN {room}',
        checkingSchedule: 'Mengecek jadwal hari ini…',
        preparingAI: 'Mempersiapkan AI…',
        noDutyToday: '{day} - LIBUR PIKET 🎉',
        noScheduleToday: 'BELUM ADA JADWAL PIKET {day}',
        scheduleToday: 'JADWAL {day}: {names}',
        noFaceRecognized: 'Tidak ada wajah dikenali',
        aiReadySavedOne: 'AI SIAP! (1 Wajah Terdaftar)',
        aiReadySavedMany: 'AI SIAP! ({count} Wajah Terdaftar)',
        aiReadyNoPhotos: 'AI SIAP! Belum ada data wajah',
        aiLoadError: 'AI gagal dimuat. Periksa koneksi internet lalu coba lagi.',
        cameraUnavailable: 'Kamera tidak tersedia. Gunakan HTTPS atau localhost.',
        videoPlayError: 'Video kamera tidak dapat diputar otomatis. Tekan tombol Izinkan Akses Kamera lalu coba lagi.',
        allPresent: 'Semua hadir! 🎉',
        noDutyMembers: 'Belum ada anggota piket hari ini.',
        aiNotReady: 'AI belum siap atau belum ada foto wajah terdaftar.',
        proofCreateError: 'Foto bukti absensi gagal dibuat. Silakan coba lagi.',
        analysisError: 'AI gagal menganalisis kamera.\n\n{message}',
        photoSaveDataError: 'Data hasil absensi belum tersedia. Silakan ambil foto lagi.',
        reportSaveFailDetail: 'Laporan absensi gagal disimpan.\n\n{message}',
        teacherTitle: 'RUANG GURU',
        suggestionTitle: 'KOTAK SARAN',
        savePhoto: 'Simpan Foto',
        cancel: 'Batal',
        facePhoto: 'Daftar Foto Wajah',
        permission: 'Izinkan Akses Kamera',
        close: 'Tutup',
        reportReload: '↻ Muat Ulang Laporan',
        resultPresent: 'Piket: ',
        resultAbsent: 'Tidak Piket: ',
        success: 'Yeay! Absen Piket<br>Berhasil Disimpan ✨',
        pinLockedTitle: 'Ruang Guru Terkunci',
        pinDescription: 'Masukkan PIN untuk melihat laporan absensi dan foto bukti.',
        pinSetupTitle: 'Buat PIN Ruang Guru',
        pinSetupDescription: 'Ruang Guru belum punya PIN. Buat PIN 4–8 digit dulu.',
        pinLabel: 'PIN Guru',
        pinNewLabel: 'Buat PIN Guru',
        pinConfirmLabel: 'Konfirmasi PIN',
        pinCancel: 'Batal',
        pinOpen: 'Buka Ruang Guru',
        pinSaveOpen: 'Simpan PIN & Buka',
        pinMinPlaceholder: 'Minimal 4 digit',
        pinRepeatPlaceholder: 'Ulangi PIN',
        pinEnterPlaceholder: 'Masukkan PIN',
        pinNote: 'PIN ini melindungi Ruang Guru di perangkat ini. Untuk keamanan antar-perangkat, laporan perlu memakai login guru di server.',
        pinInvalid: 'PIN harus 4–8 digit.',
        pinMismatch: 'PIN tidak cocok.',
        pinWrong: 'PIN salah. Sisa percobaan: ',
        pinLocked: 'Terlalu banyak percobaan. Coba lagi dalam ',
        pinLockedDetail: 'Terlalu banyak percobaan. Coba lagi dalam {seconds} detik.',
        pinLockedSuffix: ' detik.',
        pinProcessError: 'PIN tidak bisa diproses. Cek penyimpanan browser lalu coba lagi.',
        reportWeekCurrent: 'Minggu ini',
        reportWeekPrevious: 'Minggu sebelumnya',
        reportWeekNext: 'Minggu berikutnya',
        reportWeekDays: 'Senin–Minggu',
        reportAvailable: '🔔 Laporan minggu ini tersedia. Guru bisa melihat foto bukti dan daftar Piket/Tidak Piket di bawah.',
        reportEmptySaturday: '🔔 Belum ada laporan absensi minggu ini yang tersimpan di perangkat ini.',
        reportGrowing: 'Laporan minggu ini akan bertambah setiap kali absensi hari itu disimpan.',
        reportArchive: 'Menampilkan arsip laporan untuk minggu yang dipilih.',
        reportNotSaved: 'BELUM ADA',
        reportNoData: 'Belum ada laporan absensi yang tersimpan untuk hari ini.',
        reportSaved: 'TERSIMPAN',
        reportNoRecognized: 'Tidak ada siswa yang dikenali',
        reportAllPresent: 'Semua siswa terjadwal terdeteksi',
        reportOnDuty: 'Piket:',
        reportNotOnDuty: 'Tidak Piket:',
        reportFaces: 'Wajah terdeteksi:',
        reportSchedule: 'Jadwal:',
        reportLoadingPhoto: 'Memuat foto bukti…',
        reportPhotoMissing: 'Foto bukti tidak ditemukan.',
        reportPhotoUnreadable: 'Foto bukti tidak bisa dibaca.',
        ratioSaveError: 'Rasio kamera tidak dapat disimpan.',
        languageSaveError: 'Bahasa tidak dapat disimpan.',
        teacherInfo: 'Laporan absensi piket kelas',
        classRoomInfo: 'Kelas',
        roomInfo: 'Ruangan',
        notConfigured: 'Pengaturan kelas belum selesai.',
        searchStudentPlaceholder: '🔍 Cari nama siswa...',
        noSearchResults: 'Nama siswa tidak ditemukan.',
        bulkAddStudent: '📋 Tambah Siswa Massal',
        bulkAddModalDesc: 'Tulis satu nama per baris, atau pisahkan dengan koma.',
        bulkAddPlaceholder: 'Ahmad Fauzi\nBunga Lestari\nCitra Dewi, Dewi Anggraini',
        bulkAddConfirm: 'Tambahkan',
        bulkAddCount: '{count} nama terdeteksi.',
        bulkAddOverLimit: '{count} nama terdeteksi, maksimal {max}.',
        bulkAddEmpty: 'Masukkan minimal satu nama siswa.',
        bulkAddLimit: 'Maksimal {count} nama per sekali tambah.',
        bulkAddResult: '{added} siswa ditambahkan. {skipped} dilewati karena sudah ada.',
        editStudent: 'Edit nama siswa',
        deleteStudent: 'Hapus siswa',
        studentDeleted: 'Siswa berhasil dihapus.',
        editStudentPrompt: 'Edit nama siswa:',
        editSaved: 'Nama siswa berhasil diubah.',
        editSaveError: 'Nama siswa gagal disimpan.\n\n{message}',
        bulkSaveError: 'Siswa massal gagal disimpan.\n\n{message}',
        clearSchedule: 'Bersihkan',
        clearScheduleConfirm: 'Kosongkan jadwal piket hari {day}?',
        clearScheduleSaved: 'Jadwal {day} sudah dikosongkan.',
        clearScheduleError: 'Jadwal gagal dibersihkan.\n\n{message}',
        flipCamera: 'Ganti kamera',
        cameraFront: 'Kamera depan',
        cameraBack: 'Kamera belakang',
        cameraSwitchError: 'Kamera tidak bisa diganti. Coba lagi.',
        faceTooFar: 'Wajah terlalu jauh. Dekatkan wajah ke kamera lalu coba lagi.',
        ttsNoFace: 'Tidak ada siswa yang terdeteksi.',
        ttsDuty: '{names} hadir piket.',
        exportCSV: '📦 Ekspor Laporan + Foto (ZIP)',
        exportEmpty: 'Belum ada laporan untuk diekspor.',
        exportSuccess: 'Laporan berhasil diekspor.',
        exportError: 'Laporan gagal diekspor.\n\n{message}',
        clearHistory: '🗑️ Hapus Riwayat Absensi',
        clearHistoryConfirm: 'Semua riwayat absensi dan foto buktinya akan dihapus permanen. Data siswa, foto wajah, dan jadwal tidak akan dihapus. Lanjutkan?',
        clearHistorySuccess: 'Riwayat absensi berhasil dibersihkan.',
        clearHistoryEmpty: 'Tidak ada riwayat absensi yang perlu dihapus.',
        clearHistoryError: 'Riwayat absensi gagal dibersihkan.\n\n{message}',
        dayMon: 'Senin',
        dayTue: 'Selasa',
        dayWed: 'Rabu',
        dayThu: 'Kamis',
        dayFri: 'Jumat',
        daySat: 'Sabtu',
        daySun: 'Minggu'
    },
    en: {
        appTitle: 'Class Duty Attendance',
        setupTitle: 'CLASS DUTY ATTENDANCE',
        setupStudentDesc: 'Add all students the system should recognize.\n                One clear face photo per student is enough.',
        promptAddStudent: 'Enter the student’s full name:',
        duplicateStudent: 'That student name is already on the list.',
        settingsNeedStudent: 'Add at least one student.',
        missingFaceConfirm: 'These students don’t have a face photo yet:\n\n{names}\n\nSave the settings anyway?',
        settingsNeedSchedule: 'Pick at least one student for the duty schedule.',
        settingsSaveError: 'The settings could not be saved to browser storage.\n\n{message}',
        settingsSavedToast: 'Settings saved. Opening camera…',
        flashUnsupported: 'This device does not support flash.',
        resumeAttendance: 'Your duty attendance is not finished yet.\n\nLet’s continue 🙂',
        openDbError: 'The browser database could not be opened.',
        sizeTooLarge: 'That photo is too large. Max 15 MB before compression.',
        exit: 'Exit',
        noStudents: 'No students yet.',
        photoRegistered: '✓ Face photo added',
        photoMissing: '⚠ No face photo yet',
        changePhoto: 'Change Photo',
        addPhoto: 'Add Photo',
        confirmDeleteStudent: 'Delete student "{name}"?',
        studentLabel: 'Student: {name}',
        chooseFacePhoto: 'Pick a face photo<br>with a 1:1 ratio',
        choosePhotoFirst: 'Pick a face photo first.',
        fileMustBeImage: 'The file needs to be an image.',
        processLoadAI: '⏳ Loading AI…',
        processPreparePhoto: '⏳ Getting the photo ready…',
        processAnalyzeFace: '⏳ Checking the face…',
        errorFaceNotDetected: 'No face was detected.',
        errorOneFace: 'The photo needs to show exactly one face.',
        errorEmbedding: 'The face embedding could not be created.',
        errorEmbeddingFormat: 'The face embedding format is invalid. Try saving the photo again.',
        errorFaceQuality: 'Face detection quality is too low.',
        errorPhotoRead: 'The browser could not read the photo.',
        errorPhotoProcess: 'The face could not be processed.',
        successPhoto: 'Face photo for {name} was added successfully. ✓',
        studentSetupRequired: 'Add students first.',
        noFacePhoto: '⚠ No face photo yet',
        cameraRatioAria: 'Camera ratio settings',
        ratioPortrait: '9:16 — Portrait',
        ratioLandscape: '16:9 — Landscape',
        emptySchedule: 'Add students first.',
        resultSave: 'Save & Done',
        savingReport: 'Saving report…',
        reportUnavailableNow: 'Attendance results are not ready yet. Take a photo again.',
        reportSaveError: 'The attendance report could not be saved.',
        resetWarningTitle: 'WARNING!',
        resetWarningBody: 'All student data, face photos, schedules, Teacher Room PIN, reports, and proof photos will be removed from this device.',
        resetContinue: 'Continue?',
        resetFacesBody: 'Student face data will also be removed.',
        resetConfirm: 'Are you sure you want to delete everything?',
        resetSuccess: 'All data has been deleted.',
        cameraErrorTitle: '📷 Camera is not ready yet',
        preparingCamera: 'Getting the camera ready…',
        cameraStartMessage: 'The camera could not start. Check your browser permission.',
        cameraErrorText: 'Allow camera access to continue attendance.',
        cameraClose: 'Close',
        cameraPermission: 'Allow Camera',
        cameraPermissionText: 'Camera permission is only available on HTTPS or localhost. A downloaded HTML file cannot bypass browser security restrictions.',
        cameraBusyError: 'The camera is being used by another app. End the WhatsApp/Zoom video call or close another camera app, then refresh this page.',
        cameraLegacyFallback: 'This browser does not provide the live camera API. Use a modern browser such as Chrome, Edge, or Safari, and open the app over HTTPS/localhost.',
        cameraPrivateMode: 'You may be using Incognito/Private Mode. Some offline and PWA features may not work normally.',
        cameraVirtualError: 'A virtual or fake camera was detected. Use the device hardware camera to continue attendance.',
        cameraPrivacyError: 'Privacy protection, an extension, or the browser blocked image capture. Turn off Shields/AdBlock for this page or use a main browser.',
        cameraIframeError: 'The camera is running inside an iframe. The parent school portal must allow camera access. Use allow="camera; autoplay; fullscreen".',
        cameraIframeTitle: 'Camera inside iframe',
        cameraIframeText: 'This app is running inside an iframe. The school portal must explicitly allow camera access on the iframe for live camera to work.',
        cameraUpdateTitle: 'A newer web version is available',
        cameraUpdateText: 'The latest attendance app version is ready. Update the page to use the newest changes.',
        cameraUpdateLater: 'Later',
        cameraUpdateNow: 'Update Now',
        cameraBatteryWarning: 'Battery is very low. Battery Saver may make the camera slow or choppy. Temporarily turn Battery Saver off if the camera has problems.',
        cameraPerformanceWarning: 'The camera is running very slowly. Try turning off Battery Saver, closing other camera/video-call apps, then try again.',
        cameraBacklightWarning: 'The face is too dark because of strong backlighting. Turn so your face faces the light and avoid having a bright window behind you.',
        offlineAttendanceSaved: 'The signal is gone. Your attendance is still saved on this phone and does not require internet.',
        attendanceQueuedForSync: 'Attendance is saved on this phone. Server delivery will retry automatically when internet is available.',
        attendanceSyncSuccess: '{count} queued attendance record(s) synced to the server.',
        onlineRestored: 'Internet connection restored.',
        cameraStartError: 'The camera could not start. Check your browser permission.',
        suggestionDescription: 'Share feedback about the duty class,<br>from teachers or students',
        teacherTab: '👩‍🏫 Teacher',
        studentTab: '🎓 Student',
        roleTeacher: 'Teacher',
        roleStudent: 'Student',
        writeSuggestionTeacher: '✍️ Write a suggestion (Teacher)',
        writeSuggestionStudent: '✍️ Write a suggestion (Student)',
        optionalName: 'Name (optional)',
        yourName: 'Your name',
        suggestionLabel: 'Suggestion / Feedback',
        suggestionPlaceholder: 'Write your suggestion here...',
        proofPhotoOptional: '📷 Proof photo (optional)',
        sendSuggestion: 'Send suggestion',
        emptySuggestions: 'No suggestions yet.',
        proofAttached: '📎 Proof photo attached',
        proofPhoto: 'Proof photo',
        removePhoto: 'Remove photo',
        suggestionEmptyError: 'Your suggestion cannot be empty.',
        suggestionInappropriate: 'Your suggestion contains language that is not allowed.\n\nPlease keep it respectful.',
        suggestionPhotoProcessError: 'The proof photo could not be processed. The suggestion was not sent.\n\nPlease pick another photo.',
        suggestionPhotoSaveError: 'The proof photo could not be saved. The suggestion was not sent.',
        suggestionSaveError: 'The suggestion could not be saved on this device. Try again.',
        suggestionThanksWithPhoto: 'Thanks! Your suggestion and proof photo have been saved. 🙏',
        suggestionThanks: 'Thanks! Your suggestion has been saved. 🙏',
        reportPhotoAlt: 'Attendance proof photo',
        photoPreviewAlt: 'Proof photo preview',
        removeProofPhoto: 'Remove photo',
        setupDesc: 'Let’s get things set up.<br>Add students and their face photos.',
        infoClass: '🏫 Class Info',
        classLabel: 'Class',
        majorLabel: 'Major',
        roomLabel: 'Room',
        preference: '🌐 Language',
        language: 'Language',
        cameraRatio: 'Camera ratio',
        ratioHint: 'Pick the camera shape you want.',
        studentData: '👤 Students',
        activeDaysTitle: '📅 Active Duty Days',
        activeDaysDesc: 'Choose which days are allowed for duty attendance.',
        backendApiLabel: 'REST API Backend URL (optional)',
        backendApiPlaceholder: 'https://school-domain.example/api',
        backendApiHelp: 'Leave blank for local-only use. Enter a backend URL to synchronize Suggestions and school data across devices.',
        storageStatusChecking: 'Checking persistent storage…',
        storageStatusPersisted: 'Persistent storage is active in this browser.',
        storageStatusRequested: 'A persistent-storage request has been sent to the browser.',
        storageStatusUnavailable: 'This browser does not provide the persistent-storage API.',
        backendStatusLocal: 'Backend sync: not configured (local mode).',
        backendStatusConfigured: 'Backend sync: API URL configured.',
        backendStatusError: 'Backend sync: endpoint could not be reached; local data remains in the queue.',
        manualCameraOnly: 'Attendance requires the device live camera. Gallery-photo upload is disabled.',

        addStudent: '+ Add a student',
        saveSettings: '💾 Save & Start',
        suggestions: '💬 Suggestions (Teachers & Students)',
        teacherRoom: '👨‍🏫 Teacher Room — Attendance',
        deleteAll: 'Delete Everything',
        cameraTitle: 'CLASS DUTY ATTENDANCE',
        cameraClassInfo: 'CLASS {class} {major} • ROOM {room}',
        checkingSchedule: 'Checking today’s schedule…',
        preparingAI: 'Getting the AI ready…',
        noDutyToday: '{day} — No duty today 🎉',
        noScheduleToday: 'NO DUTY SCHEDULED FOR {day}',
        scheduleToday: '{day} schedule: {names}',
        noFaceRecognized: 'No face recognized',
        aiReadySavedOne: 'AI is ready! (1 face saved)',
        aiReadySavedMany: 'AI is ready! ({count} faces saved)',
        aiReadyNoPhotos: 'AI is ready, but no face photos are saved yet.',
        aiLoadError: 'The AI could not load. Check your internet connection and try again.',
        cameraUnavailable: 'Camera not available. Use HTTPS or localhost.',
        videoPlayError: 'The camera video could not start automatically. Tap Allow Camera and try again.',
        allPresent: 'Everyone’s here! 🎉',
        noDutyMembers: 'There are no duty members scheduled today.',
        aiNotReady: 'The AI is not ready yet or no face photos have been added.',
        proofCreateError: 'The attendance proof photo could not be created. Try again.',
        analysisError: 'The AI could not analyze the camera.\n\n{message}',
        photoSaveDataError: 'The attendance result data is not ready yet. Take a photo again.',
        reportSaveFailDetail: 'The attendance report could not be saved.\n\n{message}',
        teacherTitle: 'TEACHER ROOM',
        suggestionTitle: 'SUGGESTION BOX',
        savePhoto: 'Save Photo',
        cancel: 'Cancel',
        facePhoto: 'Face Photos',
        permission: 'Turn on Camera',
        close: 'Close',
        reportReload: '↻ Refresh Reports',
        resultPresent: 'On duty: ',
        resultAbsent: 'Not on duty: ',
        success: 'Yay! Attendance<br>Saved ✨',
        pinLockedTitle: 'Teacher Room Locked',
        pinDescription: 'Enter the PIN to see attendance reports and photos.',
        pinSetupTitle: 'Set Up Teacher PIN',
        pinSetupDescription: 'There’s no Teacher Room PIN yet. Set a 4–8 digit PIN first.',
        pinLabel: 'Teacher PIN',
        pinNewLabel: 'New Teacher PIN',
        pinConfirmLabel: 'Confirm PIN',
        pinCancel: 'Cancel',
        pinOpen: 'Open Teacher Room',
        pinSaveOpen: 'Save PIN & Open',
        pinMinPlaceholder: 'At least 4 digits',
        pinRepeatPlaceholder: 'Enter it again',
        pinEnterPlaceholder: 'Enter PIN',
        pinNote: 'This PIN protects the Teacher Room on this device. For real multi-device security, reports need a server login.',
        pinInvalid: 'PIN must be 4–8 digits.',
        pinMismatch: 'The PINs don’t match.',
        pinWrong: 'Wrong PIN. Tries left: ',
        pinLocked: 'Too many tries. Try again in ',
        pinLockedDetail: 'Too many tries. Try again in {seconds} seconds.',
        pinLockedSuffix: ' seconds.',
        pinProcessError: 'Something went wrong with the PIN. Check your browser storage and try again.',
        reportWeekCurrent: 'This week',
        reportWeekPrevious: 'Previous week',
        reportWeekNext: 'Next week',
        reportWeekDays: 'Monday–Sunday',
        reportAvailable: '🔔 This week’s Monday–Friday report is ready. You can check the photos and the On duty/Not on duty list below.',
        reportEmptySaturday: '🔔 It’s Saturday. There are no Monday–Friday attendance reports saved on this device yet.',
        reportGrowing: 'This week’s report updates whenever that day’s attendance is saved.',
        reportArchive: 'Showing reports for the week you picked.',
        reportNotSaved: 'NOT YET',
        reportNoData: 'No attendance report has been saved for this day yet.',
        reportSaved: 'SAVED',
        reportNoRecognized: 'No students recognized',
        reportAllPresent: 'All scheduled students were detected',
        reportOnDuty: 'On duty:',
        reportNotOnDuty: 'Not on duty:',
        reportFaces: 'Faces detected:',
        reportSchedule: 'Schedule:',
        reportLoadingPhoto: 'Loading proof photo…',
        reportPhotoMissing: 'Attendance photo not found.',
        reportPhotoUnreadable: 'Couldn’t open the attendance photo.',
        ratioSaveError: 'Camera size could not be saved.',
        languageSaveError: 'Language could not be saved.',
        teacherInfo: 'Class duty attendance report',
        classRoomInfo: 'Class',
        roomInfo: 'Room',
        notConfigured: 'Class setup is not complete yet.',
        searchStudentPlaceholder: '🔍 Search students...',
        noSearchResults: 'No students found.',
        bulkAddStudent: '📋 Add Students in Bulk',
        bulkAddModalDesc: 'Write one name per line, or separate them with commas.',
        bulkAddPlaceholder: 'Ahmad Fauzi\nBunga Lestari\nCitra Dewi, Dewi Anggraini',
        bulkAddConfirm: 'Add',
        bulkAddCount: '{count} names detected.',
        bulkAddOverLimit: '{count} names detected, {max} max.',
        bulkAddEmpty: 'Enter at least one student name.',
        bulkAddLimit: 'You can add up to {count} names at once.',
        bulkAddResult: '{added} students added. {skipped} skipped because they were already on the list.',
        editStudent: 'Edit student name',
        deleteStudent: 'Delete student',
        studentDeleted: 'Student deleted.',
        editStudentPrompt: 'Edit student name:',
        editSaved: 'Student name updated.',
        editSaveError: 'The student name could not be saved.\n\n{message}',
        bulkSaveError: 'The students could not be saved.\n\n{message}',
        clearSchedule: 'Clear',
        clearScheduleConfirm: 'Clear the duty schedule for {day}?',
        clearScheduleSaved: '{day} schedule cleared.',
        clearScheduleError: 'The schedule could not be cleared.\n\n{message}',
        flipCamera: 'Switch camera',
        cameraFront: 'Front camera',
        cameraBack: 'Back camera',
        cameraSwitchError: 'Couldn’t switch the camera. Try again.',
        faceTooFar: 'Your face is too far away. Move closer and try again.',
        ttsNoFace: 'No student was detected.',
        ttsDuty: 'On duty: {names}.',
        exportCSV: '📦 Export Report + Photos (ZIP)',
        exportEmpty: 'There are no reports to export yet.',
        exportSuccess: 'Report exported.',
        exportError: 'The report could not be exported.\n\n{message}',
        clearHistory: '🗑️ Clear Attendance History',
        clearHistoryConfirm: 'All attendance history and proof photos will be permanently deleted. Student data, face photos, and schedules will stay. Continue?',
        clearHistorySuccess: 'Attendance history cleared.',
        clearHistoryEmpty: 'There is no attendance history to clear.',
        clearHistoryError: 'Attendance history could not be cleared.\n\n{message}',
        dayMon: 'Monday',
        dayTue: 'Tuesday',
        dayWed: 'Wednesday',
        dayThu: 'Thursday',
        dayFri: 'Friday',
        daySat: 'Saturday',
        daySun: 'Sunday'
    }
};

function t(key) {
    const lang = konfigurasi?.bahasa === 'en' ? 'en' : 'id';
    return TRANSLATIONS[lang][key] ?? TRANSLATIONS.id[key] ?? key;
}

function hariTampilan(index) {
    const hariId = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
    const hariEn = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const lang = konfigurasi?.bahasa === 'en' ? 'en' : 'id';
    return (lang === 'en' ? hariEn : hariId)[index] || '';
}

function replaceTemplate(template, values = {}) {
    return String(template).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function terapkanBahasa(lang = 'id') {
    const safe = lang === 'en' ? 'en' : 'id';
    document.documentElement.lang = safe;
    document.title = t('appTitle');
    const setText = (id, key, html = false) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (html) el.innerHTML = t(key);
        else el.textContent = t(key);
    };

    setText('judulSetup','setupTitle');
    setText('deskripsiSetup','setupDesc',true);
    const deskripsiData = document.getElementById('deskripsiDataSiswa');
    if (deskripsiData) deskripsiData.innerHTML = t('setupStudentDesc').replace(/\n\s*/g, '<br>');
    setText('judulHariAktifPiket','activeDaysTitle');
    setText('deskripsiHariAktifPiket','activeDaysDesc');
    setText('labelBackendApi','backendApiLabel');
    const backendInputText = document.getElementById('inputBackendApiBaseUrl');
    if (backendInputText) backendInputText.placeholder = t('backendApiPlaceholder');
    setText('helpBackendApi','backendApiHelp');
    renderHariAktifPiket?.();
    updateBackendStatusText?.();
    setText('judulInfoKelas','infoClass');
    setText('labelKelas','classLabel');
    setText('labelJurusan','majorLabel');
    setText('labelRuangan','roomLabel');
    setText('judulPreferensi','preference');
    setText('labelBahasa','language');
    setText('labelRasioKamera','cameraRatio');
    setText('catatanRasioKamera','ratioHint');
    setText('judulDataSiswa','studentData');
    setText('btnTambahSiswa','addStudent');
    setText('btnTambahSiswaMassal','bulkAddStudent');
    setText('judulSiswaMassal','bulkAddStudent');
    setText('deskripsiSiswaMassal','bulkAddModalDesc');
    setText('btnBatalSiswaMassal','cancel');
    setText('btnProsesSiswaMassal','bulkAddConfirm');
    setText('btnBatalModalFoto','cancel');

    const inputMassal = document.getElementById('inputSiswaMassal');
    if (inputMassal) inputMassal.placeholder = t('bulkAddPlaceholder');
    perbaruiInfoSiswaMassal();
    const inputCariSiswa = document.getElementById('inputCariSiswa');
    if (inputCariSiswa) {
        inputCariSiswa.placeholder = t('searchStudentPlaceholder');
        inputCariSiswa.setAttribute('aria-label', t('searchStudentPlaceholder').replace('🔍 ',''));
    }

    setText('btnSimpanPengaturan','saveSettings');
    setText('btnKotakSaranSetup','suggestions');
    setText('btnRuangGuruSetup','teacherRoom');
    const reset = document.getElementById('btnHapusSemuaData');
    if (reset) reset.textContent = t('deleteAll');
    setText('judulKamera','cameraTitle');
    const infoJadwalEl = document.getElementById('info-jadwal');
    if (infoJadwalEl && !infoJadwalEl.classList.contains('empty-day')) infoJadwalEl.textContent = t('checkingSchedule');
    const statusAiEl = document.getElementById('status-ai');
    if (statusAiEl && !statusAiEl.dataset.runtimeText) statusAiEl.textContent = t('preparingAI');
    setText('judulRuangGuru','teacherTitle');

    // Sinkronkan status informasi kelas guru pada setiap pergantian bahasa.
    const guruInfo = document.getElementById('guruInfoKelas');
    if (guruInfo) {
        if (konfigurasi?.kelas && konfigurasi?.jurusan) {
            guruInfo.textContent = `${t('classRoomInfo')} ${konfigurasi.kelas} ${konfigurasi.jurusan} • ${t('roomInfo')} ${konfigurasi.ruangan || ''}`.trim();
        } else {
            guruInfo.textContent = t('notConfigured');
        }
    }

    setText('judulKotakSaran','suggestionTitle');
    setText('judulFotoWajah','facePhoto');
    const cameraRatioPanel = document.getElementById('panelRasioKamera');
    if (cameraRatioPanel) cameraRatioPanel.setAttribute('aria-label', t('cameraRatioAria'));
    const pilihRasio = document.getElementById('pilihRasioKamera');
    if (pilihRasio) {
        pilihRasio.setAttribute('aria-label', t('cameraRatio'));
        if (pilihRasio.options[0]) pilihRasio.options[0].textContent = t('ratioPortrait');
        if (pilihRasio.options[1]) pilihRasio.options[1].textContent = t('ratioLandscape');
    }
    const cameraPlaceholder = document.getElementById('kameraPlaceholderText');
    if (cameraPlaceholder && !cameraPlaceholder.dataset.runtimeText) cameraPlaceholder.textContent = t('preparingCamera');
    setText('btnSimpan','resultSave');
    setText('btnKeluar','exit');
    setText('deskripsiSaran','suggestionDescription',true);
    setText('judulTulisSaranGuru','writeSuggestionTeacher');
    setText('judulTulisSaranMurid','writeSuggestionStudent');
    setText('labelNamaSaranGuru','optionalName');
    setText('labelNamaSaranMurid','optionalName');
    setText('labelIsiSaranGuru','suggestionLabel');
    setText('labelIsiSaranMurid','suggestionLabel');
    setText('labelFotoSaranGuru','proofPhotoOptional');
    setText('labelFotoSaranMurid','proofPhotoOptional');
    setText('btnKirimSaranGuru','sendSuggestion');
    setText('btnKirimSaranMurid','sendSuggestion');
    const teacherTab = document.querySelector('.tab-btn[data-tab="guru"]');
    const studentTab = document.querySelector('.tab-btn[data-tab="murid"]');
    if (teacherTab) teacherTab.innerHTML = t('teacherTab');
    if (studentTab) studentTab.innerHTML = t('studentTab');
    const nameGuru = document.getElementById('namaSaranGuru');
    const nameMurid = document.getElementById('namaSaranMurid');
    const textGuru = document.getElementById('teksSaranGuru');
    const textMurid = document.getElementById('teksSaranMurid');
    if (nameGuru) nameGuru.placeholder = t('yourName');
    if (nameMurid) nameMurid.placeholder = t('yourName');
    if (textGuru) textGuru.placeholder = t('suggestionPlaceholder');
    if (textMurid) textMurid.placeholder = t('suggestionPlaceholder');
    setText('judulErrorKamera','cameraErrorTitle');
    setText('teksErrorKamera','cameraErrorText');
    setText('btnTutupErrorKamera','close');
    setText('btnIzinKamera','permission');
    if (btnKameraFallback) btnKameraFallback.textContent = safe === 'en' ? 'Retry Camera' : 'Coba Lagi Kamera';
    setText('guruRefresh','reportReload');
    setText('guruExportCSV','exportCSV');
    setText('guruHapusRiwayat','clearHistory');
    const btnFlipKamera = document.getElementById('btnFlipKamera');
    if (btnFlipKamera) {
        btnFlipKamera.setAttribute('aria-label', t('flipCamera'));
        btnFlipKamera.title = gunakanKameraDepan ? t('cameraBack') : t('cameraFront');
    }
    setText('guruPinLabel','pinLabel');
    setText('guruPinNewLabel','pinNewLabel');
    setText('guruPinConfirmLabel','pinConfirmLabel');
    setText('guruPinCancel','pinCancel');
    setText('guruPinNote','pinNote');
    const pinInput = document.getElementById('guruPinInput');
    const pinNew = document.getElementById('guruPinNewInput');
    const pinConfirm = document.getElementById('guruPinNewConfirm');
    if (pinInput) pinInput.placeholder = t('pinEnterPlaceholder');
    if (pinNew) pinNew.placeholder = t('pinMinPlaceholder');
    if (pinConfirm) pinConfirm.placeholder = t('pinRepeatPlaceholder');
    const success = document.querySelector('.teks-sukses');
    if (success) success.innerHTML = t('success');
    const btnSimpanFoto = document.querySelector('#modalFoto .btn-proses-foto');
    if (btnSimpanFoto) btnSimpanFoto.textContent = t('savePhoto');
    const previewFotoEl = document.getElementById('previewFoto');
    if (previewFotoEl && !previewFotoEl.querySelector('img')) previewFotoEl.innerHTML = t('chooseFacePhoto');
    const guruFotoPreview = document.getElementById('guruFotoPreview');
    if (guruFotoPreview) guruFotoPreview.alt = t('reportPhotoAlt');
    const guruPinCancelBtn = document.getElementById('guruPinCancel');
    if (guruPinCancelBtn) guruPinCancelBtn.textContent = t('pinCancel');
    const guruSubmitBtn = document.getElementById('guruPinSubmit');
    if (guruSubmitBtn) guruSubmitBtn.textContent = guruPinMode === 'verify' ? t('pinOpen') : t('pinSaveOpen');
    const hadir = document.getElementById('teksHadir');
    const absen = document.getElementById('teksAbsen');
    if (hadir && !hadir.dataset.dynamic) hadir.textContent = t('resultPresent') + '...';
    if (absen && !absen.dataset.dynamic) absen.textContent = t('resultAbsent') + '...';

    // Real-time translation for photo status + student data and current teacher report.
    renderSemuaSiswa?.();
    renderSemuaJadwal?.();
    if (!document.getElementById('halGuru')?.classList.contains('sembunyi')) {
        const hasilRenderGuru = renderRuangGuru?.();
        if (hasilRenderGuru && typeof hasilRenderGuru.catch === 'function') hasilRenderGuru.catch(() => {});
    }
}

function terapkanRasioKamera(rasio = '16:9') {
    const safe = rasio === '9:16' ? '9:16' : '16:9';
    const wadahEl = document.getElementById('wadah');
    if (!wadahEl) return;

    // Satu sumber aturan untuk ukuran visual kamera.
    // Flex-shrink dimatikan agar browser tidak memampatkan tinggi 9:16
    // hanya karena ruang vertikal halaman sedang terbatas.
    wadahEl.classList.toggle('rasio-9-16', safe === '9:16');
    wadahEl.classList.toggle('rasio-16-9', safe === '16:9');
    wadahEl.style.aspectRatio = safe === '9:16' ? '9 / 16' : '16 / 9';
    wadahEl.style.height = 'auto';
    wadahEl.style.flex = '0 0 auto';
    wadahEl.dataset.rasio = safe;
    requestAnimationFrame(adaptCameraSize);
}

function setKameraPlaceholder(teks = null, tampil = true) {
    const placeholder = document.getElementById('kameraPlaceholder');
    const text = document.getElementById('kameraPlaceholderText');
    if (!placeholder) return;

    if (text && teks) text.textContent = teks;
    placeholder.style.display = tampil ? 'flex' : 'none';
    document.getElementById('wadah')?.classList.toggle('kamera-aktif', !tampil);
}

function dapatkanTargetKamera(rasio) {
    // Jalur tampilan kamera tetap tajam pada HD 720p; frame kecil untuk AI
    // dibuat terpisah sehingga resolusi video utama tidak perlu diturunkan.
    return rasio === '9:16'
        ? { width: 720, height: 1280 }
        : { width: 1280, height: 720 };
} // Akhir fungsi dapatkanTargetKamera

/* =====================================================
   SETUP AWAL
===================================================== */

function buatSetupAwal() {

    konfigurasi = {

        kelas: '10',

        jurusan: 'DKV',

        ruangan: '1',

        guruPinHash: '',
        guruPinSalt: '',

        bahasa: 'id',
        rasioKamera: '16:9',

        hariAktifPiket: [...HARI_AKTIF_DEFAULT],
        backendApiBaseUrl: BACKEND_API_DEFAULT,

        jadwal: Object.fromEntries(hariKerja.map(hari => [hari, []]))

    };


    document.getElementById(
        'pilihKelas'
    ).value = '10';


    document.getElementById(
        'pilihJurusan'
    ).value = 'DKV';


    document.getElementById(
        'pilihRuangan'
    ).value = '1';

    const pilihBahasa = document.getElementById('pilihBahasa');
    if (pilihBahasa) pilihBahasa.value = 'id';
    const pilihRasioKamera = document.getElementById('pilihRasioKamera');
    if (pilihRasioKamera) pilihRasioKamera.value = '16:9';
    terapkanBahasa('id');
    terapkanRasioKamera('16:9');
    renderHariAktifPiket();
    updateBackendStatusText();


    renderSemuaSiswa();

    renderSemuaJadwal();

}



function getHariAktifPiket() {
    const configured = Array.isArray(konfigurasi?.hariAktifPiket)
        ? konfigurasi.hariAktifPiket
        : HARI_AKTIF_DEFAULT;
    const valid = configured.filter(hari => hariKerja.includes(hari));
    return valid.length ? [...new Set(valid)] : [...HARI_AKTIF_DEFAULT];
}

function renderHariAktifPiket() {
    const grid = document.getElementById('hariAktifGrid');
    if (!grid) return;

    const aktif = new Set(getHariAktifPiket());
    const dayIndexByName = {
        Minggu: 0, Senin: 1, Selasa: 2, Rabu: 3,
        Kamis: 4, Jumat: 5, Sabtu: 6
    };

    grid.innerHTML = '';
    hariKerja.forEach(hari => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 11px;border:1px solid var(--border);border-radius:12px;background:var(--surface-sunken);font-size:12.5px;font-weight:700;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.hari = hari;
        cb.checked = aktif.has(hari);
        cb.style.cssText = 'width:18px;height:18px;accent-color:var(--primary);';
        const text = document.createElement('span');
        text.textContent = hariTampilan(dayIndexByName[hari]);
        label.appendChild(cb);
        label.appendChild(text);
        grid.appendChild(label);
    });
}

function updateStorageStatusText(text) {
    const el = document.getElementById('storageStatus');
    if (el) el.textContent = text;
}

function updateBackendStatusText() {
    const el = document.getElementById('backendStatus');
    if (!el) return;
    const base = String(konfigurasi?.backendApiBaseUrl || '').trim();
    el.textContent = base ? t('backendStatusConfigured') : t('backendStatusLocal');
}

async function pastikanPenyimpananPermanen() {
    try {
        if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
            updateStorageStatusText(t('storageStatusUnavailable'));
            return false;
        }

        if (typeof navigator.storage.persisted === 'function') {
            const already = await navigator.storage.persisted();
            if (already) {
                updateStorageStatusText(t('storageStatusPersisted'));
                return true;
            }
        }

        updateStorageStatusText(t('storageStatusChecking'));
        const granted = await navigator.storage.persist();
        updateStorageStatusText(granted ? t('storageStatusPersisted') : t('storageStatusRequested'));
        return Boolean(granted);
    } catch (error) {
        console.warn('Permintaan penyimpanan permanen gagal:', error);
        updateStorageStatusText(t('storageStatusRequested'));
        return false;
    }
}

function buatIdLaporanUnik(waktuMs = Date.now()) {
    const d = new Date(waktuMs);
    const tanggal = tanggalISOBaru(d);
    const bagianWaktu = [
        String(d.getHours()).padStart(2, '0'),
        String(d.getMinutes()).padStart(2, '0'),
        String(d.getSeconds()).padStart(2, '0')
    ].join('-') + '-' + String(d.getMilliseconds()).padStart(3, '0');
    const acak = Math.random().toString(36).slice(2, 8);
    const key = `${tanggal}_${bagianWaktu}_${acak}`;
    return {
        id: `absensi_${key}`,
        photoId: `foto_absensi_${key}`
    };
}

function laporanIdValid(item) {
    const id = String(item?.id || '');
    const photoId = String(item?.photoId || '');
    if (!/^absensi_\d{4}-\d{2}-\d{2}(?:_|$)/.test(id)) return false;
    if (!photoId.startsWith('foto_absensi_')) return false;
    return photoId === `foto_absensi_${id.slice('absensi_'.length)}`;
}

function timestampLaporan(item) {
    const candidate = Number(item?.waktu);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(item?.tanggal || ''))) {
        const parsed = new Date(`${item.tanggal}T23:59:59`);
        const ts = parsed.getTime();
        if (Number.isFinite(ts)) return ts;
    }
    return NaN;
}

async function autoPruneRiwayatAbsensi(maxAgeDays = 30) {
    try {
        const db = await bukaDatabase();
        const records = await new Promise((resolve, reject) => {
            const tx = db.transaction('attendanceRecords', 'readonly');
            const req = tx.objectStore('attendanceRecords').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error('Gagal membaca riwayat absensi.'));
        });

        const batas = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        const kedaluwarsa = records.filter(item => {
            const ts = timestampLaporan(item);
            return Number.isFinite(ts) && ts < batas;
        });

        if (!kedaluwarsa.length) {
            db.close();
            return 0;
        }

        await new Promise((resolve, reject) => {
            const tx = db.transaction(['attendanceRecords', 'attendancePhotos'], 'readwrite');
            const recordsStore = tx.objectStore('attendanceRecords');
            const photosStore = tx.objectStore('attendancePhotos');

            for (const item of kedaluwarsa) {
                if (item?.id) recordsStore.delete(item.id);
                if (item?.photoId) photosStore.delete(item.photoId);
            }

            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Gagal membersihkan riwayat lama.'));
            tx.onabort = () => reject(tx.error || new Error('Pembersihan riwayat lama dibatalkan.'));
        });

        db.close();
        console.info(`Auto-prune: ${kedaluwarsa.length} laporan > ${maxAgeDays} hari dihapus.`);
        return kedaluwarsa.length;
    } catch (error) {
        console.warn('Auto-prune riwayat absensi gagal:', error);
        return 0;
    }
}

function normalizeBackendUrl(base) {
    return String(base || '').trim().replace(/\/+$/, '');
}

function getBackendApiBaseUrl() {
    return normalizeBackendUrl(
        konfigurasi?.backendApiBaseUrl ||
        (typeof window.ABSENSI_API_BASE_URL === 'string' ? window.ABSENSI_API_BASE_URL : BACKEND_API_DEFAULT)
    );
}

async function apiKirimSaran(item, fotoBlob, peran) {
    const base = getBackendApiBaseUrl();
    if (!base) return { configured: false, synced: false };

    const form = new FormData();
    form.append('id', String(item.id));
    form.append('role', String(peran));
    form.append('name', String(item.nama || ''));
    form.append('text', String(item.teks || ''));
    form.append('created_at', new Date(item.waktu || Date.now()).toISOString());
    form.append('class', String(konfigurasi?.kelas || ''));
    form.append('major', String(konfigurasi?.jurusan || ''));
    form.append('room', String(konfigurasi?.ruangan || ''));
    if (fotoBlob instanceof Blob) {
        form.append('photo', fotoBlob, `${item.id}.jpg`);
    }

    const response = await fetchDenganTimeout(`${base}/suggestions`, {
        method: 'POST',
        body: form,
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return { configured: true, synced: true };
}

async function apiAmbilSaran(peran) {
    const base = getBackendApiBaseUrl();
    if (!base) return null;

    const query = new URLSearchParams({
        role: peran,
        class: String(konfigurasi?.kelas || ''),
        major: String(konfigurasi?.jurusan || ''),
        room: String(konfigurasi?.ruangan || '')
    });

    const response = await fetchDenganTimeout(`${base}/suggestions?${query.toString()}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
    return list.map(item => ({
        id: item.id || buatId(),
        nama: item.nama ?? item.name ?? '',
        teks: item.teks ?? item.text ?? '',
        waktu: Number(item.waktu ?? item.created_at ?? Date.now()),
        photoId: item.photoId ?? null,
        photoUrl: item.photo_url ?? item.photoUrl ?? '',
        remote: true
    }));
}

async function sinkronisasiSaranTertunda() {
    const base = getBackendApiBaseUrl();
    if (!base) return;

    const semua = ambilSemuaSaran();
    let berubah = false;

    for (const peran of ['guru', 'murid']) {
        const daftar = Array.isArray(semua[peran]) ? semua[peran] : [];
        for (const item of daftar.filter(x => x && x.tersinkronServer !== true).slice(0, 20)) {
            try {
                const fotoBlob = item.photoId
                    ? await ambilFotoSaranDB(item.photoId)
                    : null;
                const hasil = await apiKirimSaran(item, fotoBlob, peran);
                if (hasil?.synced) {
                    item.tersinkronServer = true;
                    berubah = true;
                }
            } catch (error) {
                console.warn('Saran tertunda belum tersinkron:', item?.id, error);
                break;
            }
        }
    }

    if (berubah) {
        try { simpanSemuaSaran(semua); } catch (_) {}
    }
}

async function tungguLibraryGlobal(nama, timeoutMs = 8000) {
    if (window[nama]) return window[nama];

    const sharedPromise = window.__libraryLoadPromises?.[nama];
    if (sharedPromise) {
        try {
            return await Promise.race([
                sharedPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout memuat library ${nama}`)), timeoutMs))
            ]);
        } catch (error) {
            console.warn(`Library ${nama} belum siap:`, error);
            return window[nama] || null;
        }
    }

    return await new Promise(resolve => {
        let selesai = false;
        let timer = null;
        const cleanup = () => {
            window.removeEventListener('librarySiap', saatSiap);
            window.removeEventListener('libraryGagal', saatGagal);
            if (timer) clearTimeout(timer);
        };
        const beres = () => {
            if (selesai) return;
            selesai = true;
            cleanup();
            resolve(window[nama] || null);
        };
        const saatSiap = event => {
            if (event?.detail?.nama === nama && window[nama]) beres();
        };
        const saatGagal = event => {
            if (event?.detail?.nama === nama) beres();
        };

        window.addEventListener('librarySiap', saatSiap);
        window.addEventListener('libraryGagal', saatGagal);
        timer = setTimeout(beres, timeoutMs);

        // Race-proof: periksa lagi setelah listener terpasang karena library
        // bisa saja selesai di antara pemeriksaan awal dan addEventListener().
        if (window[nama]) beres();
        else if (window.__libraryLoadPromises?.[nama]) {
            window.__libraryLoadPromises[nama].finally(beres);
        }
    });
}


/* =====================================================
   BUKA PENGATURAN
===================================================== */

function bukaPengaturan() {

    if (!konfigurasi) return;


    hentikanKamera();


    document.getElementById(
        'hal-1'
    ).classList.add(
        'sembunyi'
    );


    document.getElementById(
        'halSetup'
    ).classList.remove(
        'sembunyi'
    );


    renderHariAktifPiket();
    renderSemuaSiswa();

    renderSemuaJadwal();

}


/* =====================================================
   ATURAN HARI KERJA
===================================================== */
function getHariIndexSekarang() { return new Date().getDay(); }
function isHariKerjaSekarang() {
    const index = getHariIndexSekarang();
    const hari = namaHari[index];
    return getHariAktifPiket().includes(hari);
}
function kameraDiizinkanHariIni() { return isHariKerjaSekarang(); }

/* =====================================================
   BATAS WAKTU KAMERA
   PERBAIKAN: di sebagian HP (terutama MIUI/Xiaomi dan beberapa
   browser bawaan Android lain), getUserMedia() kadang tidak pernah
   resolve maupun reject — dialog izin sistem gagal muncul atau
   ditahan diam-diam oleh pengaturan izin OS. Tanpa batas waktu,
   'await getUserMedia()' menggantung selamanya dan aplikasi
   terlihat "tidak merespons apa-apa" walau kodenya sebenarnya
   masih menunggu. Wrapper ini memberi batas waktu wajar supaya
   pengguna selalu mendapat pesan/alternatif dalam waktu singkat.
===================================================== */

const KAMERA_TIMEOUT_MS = 12000;

function denganBatasWaktuKamera(promise, ms, pesan) {
    return new Promise((resolve, reject) => {
        let selesai = false;

        const timer = setTimeout(() => {
            if (selesai) return;
            selesai = true;
            const err = new Error(pesan);
            err.name = 'TimeoutError';
            reject(err);
        }, ms);

        Promise.resolve(promise).then(
            value => {
                if (selesai) {
                    // Kamera baru merespons SETELAH kita berhenti menunggu
                    // (mis. dialog izin baru diketuk pengguna setelah modal
                    // error muncul). Kalau nilainya berupa MediaStream,
                    // matikan track-nya supaya lampu/indikator kamera tidak
                    // tetap menyala percuma di latar belakang.
                    try {
                        matikanKamera(value);
                    } catch (e) { /* abaikan */ }
                    return;
                }
                selesai = true;
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                if (selesai) return;
                selesai = true;
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/* =====================================================
   TAMPILKAN KAMERA
===================================================== */

async function tampilkanKamera() {

    // Ganti layar terlebih dahulu, sebelum proses AI/kamera yang async.
    // Dengan begitu pengguna tidak pernah tertahan di halaman pengaturan
    // hanya karena model AI atau kamera membutuhkan waktu untuk siap.
    const setup = document.getElementById('halSetup');
    const guru = document.getElementById('hal-3');
    const kameraHalaman = document.getElementById('hal-1');

    setup?.classList.add('sembunyi');
    guru?.classList.add('sembunyi');
    kameraHalaman?.classList.remove('sembunyi');
    kameraHalaman?.scrollTo({ top: 0, behavior: 'auto' });

    const rasioSaatIni = konfigurasi?.rasioKamera === '9:16' ? '9:16' : '16:9';
    const pilihRasio = document.getElementById('pilihRasioKamera');
    if (pilihRasio) pilihRasio.value = rasioSaatIni;
    terapkanRasioKamera(rasioSaatIni);
    setKameraPlaceholder(
        t('preparingCamera'),
        true
    );


    const hariIndex = getHariIndexSekarang();


    const hari =
        namaHari[hariIndex];
    const hariDisplay = hariTampilan(hariIndex);


    const daftarId =
        konfigurasi.jadwal[hari] ||
        [];


    siswaReguHariIni =
        daftarId
            .map(
                id =>
                    semuaSiswa.find(
                        siswa =>
                            siswa.id === id
                    )
            )
            .filter(Boolean);


    namaReguPiket =
        siswaReguHariIni.map(
            siswa =>
                siswa.name
        );


    infoKelas.innerText = replaceTemplate(
        t('cameraClassInfo'),
        {
            class: konfigurasi.kelas,
            major: konfigurasi.jurusan,
            room: konfigurasi.ruangan
        }
    );


    if (!kameraDiizinkanHariIni()) {

        infoJadwal.innerText =
            replaceTemplate(t('noDutyToday'), { day: hariDisplay.toUpperCase() });

        infoJadwal.className =
            'empty-day';


        statusAi.style.display =
            'none';


        btnJepret.innerHTML =
            IKON_ISTIRAHAT;

        btnJepret.disabled =
            true;


        sudahAbsen = true;
        hentikanKamera();
        faceDatabase = [];

        return;

    }


    if (
        namaReguPiket.length === 0
    ) {

        infoJadwal.innerText =
            replaceTemplate(t('noScheduleToday'), { day: hariDisplay.toUpperCase() });

        infoJadwal.className =
            'empty-day';

    } else {

        infoJadwal.innerText =
            replaceTemplate(t('scheduleToday'), {
                day: hariDisplay.toUpperCase(),
                names: namaReguPiket.join(', ')
            });

    }


    // Kamera ditampilkan dan dimulai terlebih dahulu.
    // Proses download/kompilasi model AI berjalan di background agar
    // pengguna tidak perlu menunggu layar kamera hanya karena AI.
    try {
        await mulaiKamera();
    } catch (error) {
        // PERBAIKAN: kegagalan di titik masuk utama sekarang
        // dicatat ke console (console.warn) tanpa memberi tahu pengguna
        // sama sekali. Akibatnya, di HP yang gagal membuka kamera (izin
        // diblokir sistem, kamera sibuk, atau permintaan izin tidak
        // pernah muncul/merespons — sering terjadi di HP MIUI/Xiaomi),
        // layar hanya diam menampilkan "Kamera sedang dipersiapkan…"
        // selamanya, seolah aplikasi tidak merespons. Sekarang modal
        // error kamera + instruksi untuk mengaktifkan kamera live selalu
        // ditampilkan, sama seperti titik-titik lain di aplikasi ini
        // yang sudah menangani kegagalan kamera dengan benar.
        console.warn('Kamera belum aktif:', error);
        tampilkanErrorKamera(error);
    }

    // Jangan await: AI dipersiapkan di background.
    mulaiAI().catch(error => {
        console.error('Gagal mempersiapkan AI Human:', error);
    });

}



/* =====================================================
   UTILITAS RUNTIME / VALIDASI GEOMETRI / NETWORK TIMEOUT
===================================================== */

function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
}

function normalisasiFaceResults(result) {
    if (!result || !Array.isArray(result.face) || result.face.length === 0) {
        return [];
    }
    return result.face.filter(Boolean);
}

function clampFaceBoxToVideo(box, width = video?.videoWidth || 0, height = video?.videoHeight || 0) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    const source = Array.isArray(box) ? box : [0, 0, 0, 0];
    let x = Number(source[0]) || 0;
    let y = Number(source[1]) || 0;
    let w = Math.max(0, Number(source[2]) || 0);
    let h = Math.max(0, Number(source[3]) || 0);

    x = clampNumber(x, 0, safeWidth);
    y = clampNumber(y, 0, safeHeight);
    w = Math.min(w, safeWidth - x);
    h = Math.min(h, safeHeight - y);

    return [x, y, w, h];
}

function isQuotaExceededError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'QuotaExceededError'
        || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || /quota|storage|disk space/i.test(message);
}

function setLocalStorageSafe(key, value, { preserveKeys = [] } = {}) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (error) {
        if (isQuotaExceededError(error)) {
            // Jangan pernah localStorage.clear(): itu dapat menghapus PIN/status aplikasi.
            for (const removable of preserveKeys) {
                if (removable === key) continue;
                try { localStorage.removeItem(removable); } catch (_) {}
            }
            try {
                localStorage.setItem(key, value);
                return true;
            } catch (retryError) {
                console.warn('localStorage penuh; item tidak dapat disimpan:', key, retryError);
                return false;
            }
        }
        console.warn('localStorage tidak tersedia:', key, error);
        return false;
    }
}

async function fetchDenganTimeout(input, init = {}, timeoutMs = SAFE_FETCH_TIMEOUT_MS) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    try {
        const requestInit = controller
            ? { ...init, signal: controller.signal }
            : init;
        if (controller) timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || SAFE_FETCH_TIMEOUT_MS));
        return await fetch(input, requestInit);
    } catch (error) {
        if (controller?.signal?.aborted) {
            const timeoutError = new Error('Permintaan jaringan melewati batas waktu.');
            timeoutError.name = 'TimeoutError';
            throw timeoutError;
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/* =====================================================
   AI HUMAN — ENGINE PENGENALAN WAJAH MODERN
   Menggantikan engine AI lama.
   Human menyediakan deteksi wajah + face mesh + embedding
   + anti-spoof + liveness dan pemilihan backend otomatis.
===================================================== */

// Jalur video utama dapat berjalan pada HD 720p/30 FPS, sedangkan Human
// menerima frame downscale terpisah melalui buatFrameInputAI().
const humanConfig = {
    // Human 3.3.6: prioritaskan WebGL pada browser modern, lalu turunkan ke
    // WASM bila WebGL gagal/ tidak tersedia. Model dan berkas WASM dibuat
    // local-first agar PWA dapat tetap bekerja offline bila aset lengkap.
    backend: 'webgl',
    wasmPath: AI_WASM_PATH_LOCAL,
    modelBasePath: './models/',

    debug: false,
    cacheModels: true,
    cacheSensitivity: 0.01,
    validateModels: true,

    filter: {
        enabled: true,
        equalization: true,
        autoBrightness: true
    },

    face: {
        enabled: true,

        detector: {
            enabled: true,
            rotation: true,
            return: true,
            mask: false,
            maxDetected: AI_MAX_DETECTED_FACES,
            minConfidence: 0.25,
            minSize: 80,
            scale: 1.25
        },

        // Mesh + rotation sangat disarankan oleh dokumentasi Human
        // untuk kualitas embedding/recognition.
        mesh: {
            enabled: true,
        },

        description: {
            enabled: true,
            minConfidence: 0.20
        },

        // Iris diaktifkan untuk membantu mendeteksi kedipan/gerakan mata
        // pada sesi kamera live. Pendaftaran foto statis tetap tidak memakai
        // hasil liveness sebagai syarat validasi.
        iris: {
            enabled: true
        },

        antispoof: {
            enabled: true
        },

        liveness: {
            enabled: true
        },

        attention: {
            enabled: false
        },

        emotion: {
            enabled: false
        },

        gear: {
            enabled: false
        }
    },

    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false },
    segmentation: { enabled: false }
};

// Singleton Human: kamera boleh dibuka/tutup berulang tanpa membuat engine AI baru.
// Instance ini sengaja dipertahankan selama lifecycle halaman agar model/WebGL
// cache tidak terus dibuat ulang setiap sesi kamera.
let human = null;
let humanBackendAktif = null;

// Fase 1: preview hanya mencari lokasi wajah. Tidak ada mesh, iris, embedding,
// antispoof, liveness, atau gesture setiap frame. Ini adalah jalur ringan untuk
// menjaga kamera tetap responsif.
const AI_PREVIEW_CONFIG = {
    face: {
        enabled: true,
        detector: {
            enabled: true,
            return: true,
            rotation: true,
            maxDetected: AI_MULTI_FACE_MAX,
            iouThreshold: 0.01,
            minConfidence: 0.25,
            minSize: AI_FACE_MIN_SIZE_PX
        },
        mesh: { enabled: false },
        iris: { enabled: false },
        description: { enabled: false },
        antispoof: { enabled: false },
        liveness: { enabled: false }
    },
    gesture: { enabled: false }
};

// Fase 2: liveness memakai mesh/iris/antispoof/liveness secara temporal.
// Fase 3 hanya mengaktifkan description sekali pada frame verifikasi identitas.
const AI_LIVENESS_CONFIG = {
    face: {
        enabled: true,
        detector: {
            enabled: true,
            return: true,
            rotation: true,
            maxDetected: AI_MULTI_FACE_MAX,
            iouThreshold: 0.01,
            minConfidence: 0.25,
            minSize: AI_FACE_MIN_SIZE_PX
        },
        mesh: { enabled: true },
        iris: { enabled: true },
        description: { enabled: false },
        antispoof: { enabled: true },
        liveness: { enabled: true }
    },
    gesture: { enabled: true }
};

function catatDurasiDeteksiAI(startTime, backend = humanBackendAktif) {
    const durasi = performance.now() - startTime;
    aiPerfStats.count++;
    aiPerfStats.totalMs += durasi;
    aiPerfStats.lastMs = durasi;
    if (aiPerfStats.count % 10 === 0) {
        const rata = aiPerfStats.totalMs / aiPerfStats.count;
        console.info(`AI detect perf: backend=${backend || 'unknown'}, last=${durasi.toFixed(1)}ms, avg=${rata.toFixed(1)}ms`);
    }
    return durasi;
}

function pastikanHumanTersedia() {
    if (human) return human;

    if (typeof Human === 'undefined' || typeof Human.Human !== 'function') {
        throw new Error('Mesin AI Human belum berhasil dimuat. Periksa koneksi internet atau buka ulang aplikasi.');
    }

    human = new Human.Human(humanConfig);

    if (human.env) {
        human.env.perfadd = false;
    }

    return human;
}

function apakahErrorWebGLContext(error) {
    const teks = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
    return /webgl|context.?lost|losecontext|backend error/.test(teks)
        || error?.name === 'BackendError';
}

function lepaskanPemantauanWebGLHuman() {
    const target = webglContextTarget;
    try {
        if (target && webglContextLostHandler) target.removeEventListener?.('webglcontextlost', webglContextLostHandler);
        if (target && webglContextRestoredHandler) target.removeEventListener?.('webglcontextrestored', webglContextRestoredHandler);
    } catch (error) {
        console.warn('Gagal melepas listener WebGL Human:', error);
    }
    webglContextTarget = null;
    webglContextLostHandler = null;
    webglContextRestoredHandler = null;
}

function dapatkanGLHuman() {
    try {
        const tf = human?.tf;
        const backend = tf?.backend?.();
        const gl = backend?.getGPGPUContext?.()?.gl;
        if (gl) return gl;
        const backendInstance = tf?.engine?.()?.backendInstance;
        return backendInstance?.getGPGPUContext?.()?.gl || null;
    } catch (error) {
        console.warn('Tidak dapat mengakses WebGL context Human:', error);
        return null;
    }
}

function pasangPemantauanWebGLHuman() {
    lepaskanPemantauanWebGLHuman();
    const gl = dapatkanGLHuman();
    if (!gl?.addEventListener) return false;

    webglContextTarget = gl;
    webglContextLostHandler = event => {
        try { event.preventDefault?.(); } catch (_) {}
        webglContextLostDetected = true;
        modelAiSiap = false;
        setStatusAI(
            konfigurasi?.bahasa === 'en' ? 'GPU context interrupted — recovering AI…' : 'Konteks GPU terputus — memulihkan AI…',
            '#ff9800',
            true
        );
        void pulihkanAISetelahWebGLContextLoss(event);
    };
    webglContextRestoredHandler = () => {
        if (webglContextLostDetected) void pulihkanAISetelahWebGLContextLoss(new Error('WebGL context restored'));
    };
    gl.addEventListener('webglcontextlost', webglContextLostHandler, false);
    gl.addEventListener('webglcontextrestored', webglContextRestoredHandler, false);
    return true;
}

async function pulihkanAISetelahWebGLContextLoss(error = null) {
    if (!apakahErrorWebGLContext(error) && !webglContextLostDetected) return false;
    if (aiRecoveryPromise) return aiRecoveryPromise;
    const sekarang = Date.now();
    if (sekarang - aiRecoveryLastAt < 2500) return false;
    aiRecoveryLastAt = sekarang;

    aiRecoveryPromise = (async () => {
        const tokenKamera = kameraRequestId;
        hentikanLoopDeteksi();
        aiBusy = false;
        modelAiSiap = false;
        lepaskanPemantauanWebGLHuman();

        try {
            lepaskanEngineHumanUntukFallback();
            const online = navigator.onLine !== false;
            const candidates = [
                { backend: 'wasm', modelPath: AI_MODEL_PATH_LOCAL, wasmPath: AI_WASM_PATH_LOCAL },
                ...(online ? [{ backend: 'wasm', modelPath: 'https://vladmandic.github.io/human-models/models/', wasmPath: AI_WASM_PATH_CDN }] : []),
                { backend: 'webgl', modelPath: online ? 'https://vladmandic.github.io/human-models/models/' : AI_MODEL_PATH_LOCAL, wasmPath: AI_WASM_PATH_LOCAL }
            ];
            let lastError = null;
            for (const opsi of candidates) {
                try {
                    await inisialisasiHumanDenganBackend(opsi.backend, opsi.modelPath, opsi.wasmPath);
                    modelAiSiap = true;
                    webglContextLostDetected = false;
                    pasangPemantauanWebGLHuman();
                    setStatusAI(
                        konfigurasi?.bahasa === 'en' ? `AI recovered (${opsi.backend.toUpperCase()})` : `AI pulih (${opsi.backend.toUpperCase()})`,
                        '#28a745',
                        false
                    );
                    if (tokenKamera === kameraRequestId && video?.srcObject && !sudahAbsen) mulaiPreviewAI();
                    return true;
                } catch (recoveryError) {
                    lastError = recoveryError;
                    console.warn(`Pemulihan Human gagal (${opsi.backend}):`, recoveryError);
                    lepaskanPemantauanWebGLHuman();
                    lepaskanEngineHumanUntukFallback();
                }
            }
            throw lastError || new Error('Semua jalur pemulihan AI gagal.');
        } catch (recoveryError) {
            modelAiSiap = false;
            console.error('Pemulihan AI setelah WebGL context loss gagal:', recoveryError);
            setStatusAI(
                konfigurasi?.bahasa === 'en' ? 'AI recovery failed. Reload the app.' : 'AI gagal dipulihkan. Silakan buka ulang aplikasi.',
                '#dc3545',
                false
            );
            return false;
        } finally {
            aiRecoveryPromise = null;
        }
    })();
    return aiRecoveryPromise;
}

/**
 * Menjamin hanya satu human.detect() aktif pada satu waktu.
 * - Preview AI memakai waitForExisting=false agar tidak membuat antrean.
 * - Proses absensi/pendaftaran menunggu inferensi yang sedang berjalan.
 */
async function deteksiHumanTerkunci(input, userConfig, { waitForExisting = true } = {}) {
    if (humanDetectionPromise) {
        if (!waitForExisting) return null;
        try {
            await humanDetectionPromise;
        } catch (_) {
            // Inferensi sebelumnya gagal; pemanggil berikutnya boleh mencoba lagi.
        }
    }

    let run;
    try {
        run = Promise.resolve(human.detect(input, userConfig));
    } catch (error) {
        throw error;
    }

    humanDetectionPromise = run;
    const mulaiDeteksi = performance.now();
    try {
        return await run;
    } catch (error) {
        if (apakahErrorWebGLContext(error)) void pulihkanAISetelahWebGLContextLoss(error);
        throw error;
    } finally {
        catatDurasiDeteksiAI(mulaiDeteksi);
        if (humanDetectionPromise === run) humanDetectionPromise = null;
    } // Akhir blok try/finally deteksiHumanTerkunci
}

const AI_INPUT_MAX_SIDE_DEFAULT = 640;
const AI_INPUT_MAX_SIDE_MIN = 360;
let aiInputCanvas = null;
let aiInputContext = null;
let aiPreviewMaxSide = AI_INPUT_MAX_SIDE_DEFAULT;
let aiPreviewFastRuns = 0;
let aiLastPreviewInputAdjustAt = 0;
let aiMemoryMonitorTimer = null;
let aiMemoryBaseline = null;
let aiMemoryLast = null;
let aiMemoryHighSamples = 0;
let aiMemoryLastWarningAt = 0;

function terapkanProfilPerformaAI() {
    aiPerformanceProfile = dapatkanProfilPerformaPerangkat();
    aiDetectionIntervalMsAktif = aiPerformanceProfile.intervalMs;
    aiPreviewMaxSide = aiPerformanceProfile.maxSide;
    aiPreviewFastRuns = 0;
    aiLastPreviewInputAdjustAt = performance.now();
    console.info('Profil performa AI:', {
        profile: aiPerformanceProfile.nama,
        cores: navigator?.hardwareConcurrency || 'unknown',
        deviceMemory: navigator?.deviceMemory || 'unknown',
        aiFps: aiPerformanceProfile.fps,
        maxSide: aiPreviewMaxSide
    });
}

function resetSnapshotMemoriAI() {
    aiMemoryBaseline = null;
    aiMemoryLast = null;
    aiMemoryHighSamples = 0;
}

function bulatkanDimensiFrameAI(value) {
    const angka = Math.max(2, Math.round(Number(value) || 2));
    return angka % 2 === 0 ? angka : angka - 1;
}

function dapatkanDimensiInputAI(profile = 'preview') {
    const sourceWidth = Number(video?.videoWidth || 1280);
    const sourceHeight = Number(video?.videoHeight || 720);
    const longSide = Math.max(sourceWidth, sourceHeight);
    const maxSide = profile === 'preview'
        ? aiPreviewMaxSide
        : AI_INPUT_MAX_SIDE_DEFAULT;
    const scale = Math.min(1, maxSide / Math.max(1, longSide));
    return {
        width: bulatkanDimensiFrameAI(sourceWidth * scale),
        height: bulatkanDimensiFrameAI(sourceHeight * scale)
    };
}

function pastikanCanvasInputAI(width, height) {
    if (!aiInputCanvas) {
        aiInputCanvas = document.createElement('canvas');
        aiInputCanvas.id = 'aiInputCanvas';
        aiInputCanvas.hidden = true;
        aiInputCanvas.setAttribute('aria-hidden', 'true');
        aiInputCanvas.style.display = 'none';
    }
    if (aiInputCanvas.width !== width) aiInputCanvas.width = width;
    if (aiInputCanvas.height !== height) aiInputCanvas.height = height;
    if (!aiInputContext) aiInputContext = aiInputCanvas.getContext('2d', { alpha: false });
    return aiInputContext;
}

async function buatFrameInputAI(profile = 'preview') {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;

    const { width, height } = dapatkanDimensiInputAI(profile);
    if (!(width > 1 && height > 1)) return null;

    // Prefer ImageBitmap resize: Human mendukung ImageBitmap sebagai input,
    // sehingga salinan frame dapat diperkecil sebelum inferensi tanpa membuat
    // canvas overlay 720p menjadi jalur pemrosesan AI.
    if (typeof window.createImageBitmap === 'function') {
        try {
            const bitmap = await window.createImageBitmap(video, {
                resizeWidth: width,
                resizeHeight: height,
                resizeQuality: 'medium'
            });
            return {
                source: bitmap,
                width,
                height,
                close: () => { try { bitmap.close(); } catch (_) {} }
            };
        } catch (error) {
            console.warn('ImageBitmap AI tidak tersedia; memakai canvas input:', error);
        }
    }

    const ctx = pastikanCanvasInputAI(width, height);
    if (!ctx) return null;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(video, 0, 0, width, height);
    return { source: aiInputCanvas, width, height, close: () => {} };
}

function skalaBoxHasilAI(box, inputWidth, inputHeight) {
    const source = Array.isArray(box) ? box : [0, 0, 0, 0];
    const sx = (video?.videoWidth || inputWidth) / Math.max(1, inputWidth);
    const sy = (video?.videoHeight || inputHeight) / Math.max(1, inputHeight);
    return [
        (Number(source[0]) || 0) * sx,
        (Number(source[1]) || 0) * sy,
        Math.max(0, (Number(source[2]) || 0) * sx),
        Math.max(0, (Number(source[3]) || 0) * sy)
    ];
}

function skalaHasilAIKeVideo(result, inputWidth, inputHeight) {
    if (!result || !Array.isArray(result.face)) return result;
    const videoWidth = Number(video?.videoWidth || inputWidth);
    const videoHeight = Number(video?.videoHeight || inputHeight);
    if (videoWidth === inputWidth && videoHeight === inputHeight) return result;

    return {
        ...result,
        face: result.face.map(face => ({
            ...face,
            box: skalaBoxHasilAI(face?.box, inputWidth, inputHeight)
        }))
    };
}

async function deteksiHumanDariFrameKecil(userConfig = {}, { waitForExisting = false, profile = 'preview' } = {}) {
    const frame = await buatFrameInputAI(profile);
    if (!frame) return null;

    try {
        const hasil = await deteksiHumanTerkunci(frame.source, userConfig, { waitForExisting });
        return skalaHasilAIKeVideo(hasil, frame.width, frame.height);
    } finally {
        frame.close?.();
    }
}

function adaptasiInputAIPreviewSetelahDeteksi() {
    const durasi = Number(aiPerfStats.lastMs);
    const sekarang = performance.now();
    if (!Number.isFinite(durasi) || sekarang - aiLastPreviewInputAdjustAt < 1800) return;

    if (durasi > 180 && aiPreviewMaxSide > AI_INPUT_MAX_SIDE_MIN) {
        aiPreviewMaxSide = aiPreviewMaxSide >= 640 ? 480 : 360;
        aiPreviewFastRuns = 0;
        aiLastPreviewInputAdjustAt = sekarang;
        console.info(`AI preview input diturunkan ke maxSide=${aiPreviewMaxSide}px karena detect=${durasi.toFixed(1)}ms`);
        return;
    }

    if (durasi < 105) aiPreviewFastRuns++;
    else aiPreviewFastRuns = 0;

    if (aiPreviewFastRuns >= 6 && aiPreviewMaxSide < AI_INPUT_MAX_SIDE_DEFAULT) {
        aiPreviewMaxSide = aiPreviewMaxSide >= 480 ? 640 : 480;
        aiPreviewFastRuns = 0;
        aiLastPreviewInputAdjustAt = sekarang;
        console.info(`AI preview input dinaikkan ke maxSide=${aiPreviewMaxSide}px setelah beberapa inferensi cepat.`);
    }
}

function mulaiPantauanMemoriAI() {
    if (aiMemoryMonitorTimer) return;
    resetSnapshotMemoriAI();

    aiMemoryMonitorTimer = window.setInterval(() => {
        try {
            const memory = human?.tf?.memory?.();
            if (!memory) return;

            const snapshot = {
                numTensors: Number(memory.numTensors) || 0,
                numBytes: Number(memory.numBytes) || 0,
                numDataBuffers: Number(memory.numDataBuffers) || 0,
                at: Date.now()
            };

            if (!aiMemoryBaseline) aiMemoryBaseline = snapshot;
            const baseline = aiMemoryBaseline;
            const deltaTensors = snapshot.numTensors - (baseline?.numTensors || 0);
            const deltaBytes = snapshot.numBytes - (baseline?.numBytes || 0);
            const terlaluTinggi = snapshot.numTensors > 1500;
            const bertumbuhTerus = deltaTensors > 350 && deltaBytes > 2 * 1024 * 1024;

            if (terlaluTinggi || bertumbuhTerus) {
                aiMemoryHighSamples++;
                const sekarang = Date.now();
                if (sekarang - aiMemoryLastWarningAt >= 12000) {
                    aiMemoryLastWarningAt = sekarang;
                    console.warn('Memori Tensor Human meningkat:', {
                        ...snapshot,
                        deltaTensors,
                        deltaBytes,
                        consecutiveSamples: aiMemoryHighSamples
                    });
                }

                // Jangan memanggil tf.dispose()/disposeVariables() per frame:
                // model Human memiliki tensor internal yang memang harus hidup.
                // Degradasi dilakukan ke input AI yang lebih ringan agar tekanan
                // RAM/GPU turun tanpa merusak bobot model.
                if (aiMemoryHighSamples >= 2) {
                    aiPreviewMaxSide = AI_INPUT_MAX_SIDE_MIN;
                    aiDetectionIntervalMsAktif = Math.max(200, aiDetectionIntervalMsAktif, 1000 / 5);
                    aiPreviewFastRuns = 0;
                    aiLastPreviewInputAdjustAt = performance.now();
                }
            } else {
                aiMemoryHighSamples = 0;
            }

            aiMemoryLast = snapshot;
        } catch (error) {
            console.warn('Pemantauan memori AI gagal:', error);
        }
    }, 7000);
}

function hentikanPantauanMemoriAI() {
    if (aiMemoryMonitorTimer) {
        clearInterval(aiMemoryMonitorTimer);
        aiMemoryMonitorTimer = null;
    }
    resetSnapshotMemoriAI();
}

async function deteksiWajahLoop(userConfig = {}, { waitForExisting = false } = {}) {
    // Public entry point untuk satu siklus deteksi. Video utama tetap 720p;
    // frame yang dikirim ke Human diperkecil terlebih dahulu.
    if (!modelAiSiap || !human || !video || !video.srcObject || video.readyState < 2 || video.paused) {
        return null;
    }

    const config = {
        face: {
            enabled: true,
            detector: {
                return: true,
                rotation: true,
                maxDetected: AI_MAX_DETECTED_FACES,
                ...(AI_PREVIEW_CONFIG.face?.detector || {}),
                ...(userConfig.face?.detector || {})
            },
            mesh: { ...(AI_PREVIEW_CONFIG.face?.mesh || {}) },
            iris: { ...(AI_PREVIEW_CONFIG.face?.iris || {}) },
            description: { ...(AI_PREVIEW_CONFIG.face?.description || {}) },
            antispoof: { ...(AI_PREVIEW_CONFIG.face?.antispoof || {}) },
            liveness: { ...(AI_PREVIEW_CONFIG.face?.liveness || {}) },
            ...(userConfig.face || {})
        },
        gesture: { ...(AI_PREVIEW_CONFIG.gesture || {}), ...(userConfig.gesture || {}) }
    };

    const hasil = await deteksiHumanDariFrameKecil(config, { waitForExisting, profile: 'preview' });
    adaptasiInputAIPreviewSetelahDeteksi();
    return hasil; // Akhir satu siklus deteksi
} // Akhir fungsi deteksiWajahLoop

function setStatusAI(teks, warna = '#007bff', loading = false) {
    if (!statusAi) return;

    const signature = `${teks || ''}\u0000${warna}\u0000${loading ? '1' : '0'}`;
    if (signature === statusAISignatureTerakhir && statusAi.style.display === 'block') return;

    statusAISignatureTerakhir = signature;
    statusAi.style.display = 'block';
    statusAi.textContent = teks || '';
    statusAi.dataset.runtimeText = teks || '';
    statusAi.style.color = warna;
    statusAi.classList.toggle('loading-anim', loading);
} // Akhir fungsi setStatusAI

function updateStatusWajahPreview(face) {
    if (!statusAi || !face) return;

    const en = konfigurasi?.bahasa === 'en';
    const ukuran = periksaUkuranWajah(face);
    const yaw = Number(face?.rotation?.angle?.yaw);
    const pitch = Number(face?.rotation?.angle?.pitch);
    const brightness = cekKecerahanFrameVideo();
    const backlight = wajahMengalamiBacklight(face) || brightness.backlight;
    const boxScore = Number(face?.boxScore);

    if (brightness.lowLight) {
        setStatusAI(en ? 'Move to a brighter place' : 'Pindahlah ke tempat yang lebih terang', '#d97706', false);
        return;
    }
    if (backlight) {
        setStatusAI(en ? 'Avoid strong backlight and face the light' : 'Hindari cahaya dari belakang dan hadap ke sumber cahaya', '#d97706', false);
        return;
    }
    if (!ukuran.layak) {
        setStatusAI(en ? 'Move a little closer to the camera' : 'Maju sedikit, posisikan wajah lebih dekat', '#d97706', false);
        return;
    }
    if ((Number.isFinite(yaw) && Math.abs(yaw) > AI_FACE_MAX_YAW) || (Number.isFinite(pitch) && Math.abs(pitch) > AI_FACE_MAX_PITCH)) {
        setStatusAI(en ? 'Face the camera straight' : 'Hadap lurus ke arah kamera', '#d97706', false);
        return;
    }
    if (Number.isFinite(boxScore) && boxScore < AI_FACE_MIN_BOX_SCORE) {
        setStatusAI(en ? 'Hold still and keep your face clearly visible' : 'Tahan posisi dan pastikan wajah terlihat jelas', '#2563eb', false);
        return;
    }

    setStatusAI(en ? 'Face detected • ready for verification' : 'Wajah terdeteksi • siap diverifikasi', '#2563eb', false);
} // Akhir fungsi updateStatusWajahPreview

function setAILoading(visible, title = '', textMessage = '') {
    if (!loadingOverlay) return;
    loadingOverlay.classList.toggle('muncul', Boolean(visible));
    loadingOverlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (loadingOverlayTitle && title) loadingOverlayTitle.textContent = title;
    if (loadingOverlayText && textMessage) loadingOverlayText.textContent = textMessage;
}

function cekKecerahanFrameVideo(force = false) {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        return { average: 128, lowLight: false, backlight: false };
    }
    const now = performance.now();
    if (!force && now - lastBrightnessCheckAt < AI_BRIGHTNESS_CHECK_INTERVAL_MS) {
        return {
            average: lastBrightnessValue,
            lowLight: lastBrightnessValue < AI_BRIGHTNESS_MIN,
            backlight: lastBrightnessValue > AI_BRIGHTNESS_BACKLIGHT
        };
    }
    lastBrightnessCheckAt = now;
    try {
        if (!brightnessCanvas) {
            brightnessCanvas = document.createElement('canvas');
            brightnessCanvas.width = 32;
            brightnessCanvas.height = 24;
            brightnessContext = brightnessCanvas.getContext('2d', { willReadFrequently: true });
        }
        brightnessContext.drawImage(video, 0, 0, 32, 24);
        const data = brightnessContext.getImageData(0, 0, 32, 24).data;
        let sum = 0;
        let max = 0;
        for (let i = 0; i < data.length; i += 4) {
            const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            sum += y;
            if (y > max) max = y;
        }
        lastBrightnessValue = sum / (data.length / 4);
        return {
            average: lastBrightnessValue,
            lowLight: lastBrightnessValue < AI_BRIGHTNESS_MIN,
            backlight: lastBrightnessValue > AI_BRIGHTNESS_BACKLIGHT && max > 245
        };
    } catch (_) {
        return { average: lastBrightnessValue, lowLight: false, backlight: false };
    }
}

async function periksaKameraVirtual() {
    if (!navigator.mediaDevices?.enumerateDevices) return false;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const keywords = ['virtual', 'obs', 'manycam', 'splitcam'];
        return devices
            .filter(device => device.kind === 'videoinput')
            .some(device => {
                const label = String(device.label || '').toLowerCase();
                return keywords.some(keyword => label.includes(keyword));
            });
    } catch (error) {
        console.warn('Pemeriksaan kamera virtual gagal:', error);
        return false;
    }
}

function tolakKameraVirtual() {
    const error = new DOMException(
        konfigurasi?.bahasa === 'en'
            ? 'A virtual camera was detected. Please use the physical camera on the device.'
            : 'Kamera virtual terdeteksi. Gunakan kamera asli perangkat.',
        'VirtualCameraError'
    );
    error.virtualCamera = true;
    return error;
}

/* =====================================================
   MUAT MODEL AI
===================================================== */

function lepaskanEngineHumanUntukFallback() {
    lepaskanPemantauanWebGLHuman();
    resetSnapshotMemoriAI();
    try {
        human?.models?.reset?.();
    } catch (error) {
        console.warn('Gagal mereset model Human sebelum fallback backend:', error);
    }
    human = null;
    humanBackendAktif = null;
}

async function inisialisasiHumanDenganBackend(backend, modelPath, wasmPath = AI_WASM_PATH_LOCAL) {
    humanConfig.backend = backend;
    humanConfig.modelBasePath = modelPath;
    humanConfig.wasmPath = wasmPath;

    lepaskanEngineHumanUntukFallback();
    const instance = pastikanHumanTersedia();
    await instance.init();
    await instance.load();
    if (typeof instance.warmup === 'function') {
        await instance.warmup();
        console.info(`Human AI warmup selesai: backend=${backend}`);
    }

    const backendAktif = instance.tf?.getBackend?.() || instance.tf?.backend?.()?.id || null;
    humanBackendAktif = backendAktif || backend;
    console.info(`Human AI backend aktif: ${humanBackendAktif}`);
    mulaiPantauanMemoriAI();

    // Jangan membiarkan backend diam-diam turun ke CPU/jenis lain lalu dianggap
    // sebagai jalur GPU. Kandidat berikutnya akan mencoba fallback yang benar.
    if (backendAktif && backendAktif !== backend) {
        throw new Error(`Backend Human tidak sesuai: diminta ${backend}, aktif ${backendAktif}.`);
    }

    pasangPemantauanWebGLHuman();
    return instance; // Akhir inisialisasi Human dengan backend
} // Akhir fungsi inisialisasiHumanDenganBackend

function muatModelAI() {
    if (modelAiPromise) return modelAiPromise;

    modelAiPromise = (async () => {
        const MODEL_LOKAL = AI_MODEL_PATH_LOCAL;
        const MODEL_CDN = 'https://vladmandic.github.io/human-models/models/';
        const online = navigator.onLine !== false;

        try {
            setAILoading(true,
                konfigurasi?.bahasa === 'en' ? 'Preparing AI' : 'Mempersiapkan AI',
                konfigurasi?.bahasa === 'en' ? 'Loading AI models and warming up the GPU. Please wait.' : 'Memuat model AI dan melakukan pemanasan GPU. Tunggu sebentar.'
            );
            setStatusAI(
                konfigurasi?.bahasa === 'en' ? 'Getting the AI ready…' : 'Memuat AI modern…',
                '#007bff',
                true
            );

            const asetLokalTersedia = await cekAsetModelLokal();
            if (typeof window.__lazyLoadHuman === 'function' && !window.Human) {
                await window.__lazyLoadHuman();
            }
            const humanLibrary = await tungguLibraryGlobal('Human', 15000);
            if (!humanLibrary) {
                throw new Error(
                    konfigurasi?.bahasa === 'en'
                        ? 'Human AI library failed to load. Check your internet connection and reload the app.'
                        : 'Library Human AI belum selesai dimuat. Periksa koneksi internet lalu buka ulang aplikasi.'
                );
            }

            const kandidat = [];
            const webgpuTersedia = typeof navigator?.gpu !== 'undefined';

            // WebGPU dicoba terlebih dahulu bila browser mengekspos navigator.gpu.
            // Human secara resmi mendukung webgpu, webgl, wasm, dan cpu; bila WebGPU
            // gagal, pipeline tetap turun ke WebGL/WASM seperti sebelumnya.
            if (webgpuTersedia && (asetLokalTersedia || !online)) {
                kandidat.push({ backend: 'webgpu', modelPath: MODEL_LOKAL, wasmPath: AI_WASM_PATH_LOCAL });
            }
            if (webgpuTersedia && online) kandidat.push({ backend: 'webgpu', modelPath: MODEL_CDN, wasmPath: AI_WASM_PATH_CDN });

            // Coba WebGL setelah WebGPU. Tidak membuat instance probe terpisah:
            // constructor Human sendiri sudah menginisialisasi backend dan bila
            // WebGL tidak stabil, kegagalan nyata akan langsung ditangkap oleh
            // loop kandidat lalu diturunkan ke WASM.
            if (asetLokalTersedia || !online) {
                kandidat.push({ backend: 'webgl', modelPath: MODEL_LOKAL, wasmPath: AI_WASM_PATH_LOCAL });
            }
            if (online) kandidat.push({ backend: 'webgl', modelPath: MODEL_CDN, wasmPath: AI_WASM_PATH_CDN });

            // WASM adalah fallback utama untuk perangkat/browser tanpa WebGL.
            if (asetLokalTersedia || !online) {
                kandidat.push({ backend: 'wasm', modelPath: MODEL_LOKAL, wasmPath: AI_WASM_PATH_LOCAL });
            }
            if (online) {
                kandidat.push({ backend: 'wasm', modelPath: MODEL_CDN, wasmPath: AI_WASM_PATH_CDN });
            }

            const kandidatUnik = kandidat.filter((item, index, arr) =>
                index === arr.findIndex(other =>
                    other.backend === item.backend &&
                    other.modelPath === item.modelPath &&
                    other.wasmPath === item.wasmPath
                )
            );

            if (!kandidatUnik.length) {
                throw new Error('Tidak ada kombinasi backend/model AI yang dapat digunakan pada kondisi jaringan saat ini.');
            }

            let errorTerakhir = null;
            for (const kandidatBackend of kandidatUnik) {
                try {
                    await inisialisasiHumanDenganBackend(
                        kandidatBackend.backend,
                        kandidatBackend.modelPath,
                        kandidatBackend.wasmPath
                    );

                    console.info(
                        `Human AI siap: backend=${kandidatBackend.backend}, model=${kandidatBackend.modelPath}`
                    );
                    if (statusAi) {
                        const mode = kandidatBackend.backend.toUpperCase();
                        setStatusAI(
                            konfigurasi?.bahasa === 'en'
                                ? `AI ready (${mode})`
                                : `AI siap (${mode})`,
                            '#28a745',
                            false
                        );
                    }
                    break;
                } catch (error) {
                    errorTerakhir = error;
                    const pesanError = String(error?.message || error || '');
                    if (kandidatBackend.backend === 'wasm' &&
                        /wasm|mime|content.?type|compile|response header|WebAssembly/i.test(pesanError)) {
                        console.warn(
                            'WASM gagal dimuat. Pastikan server mengirim .wasm sebagai application/wasm. ' +
                            'Human akan mencoba kandidat backend/model berikutnya.'
                        );
                    }
                    console.warn(
                        `Backend Human gagal (${kandidatBackend.backend}, ${kandidatBackend.modelPath}):`,
                        error
                    );
                    lepaskanEngineHumanUntukFallback();
                }
            }

            if (!human) throw errorTerakhir || new Error('Human AI gagal diinisialisasi.');

            modelAiSiap = true;
            setAILoading(false);
            return true;
        } catch (error) {
            modelAiPromise = null;
            modelAiSiap = false;
            setAILoading(false);
            throw error;
        }
    })();

    return modelAiPromise;
}

/* =====================================================
   MIGRASI / PEMBUATAN DATABASE WAJAH
   Foto lama tetap dipakai. Descriptor Human AI lama
   otomatis dibuat ulang dengan engine Human.
===================================================== */

async function siapkanDataWajah() {
    const database = [];
    for (const siswa of semuaSiswa) {
        try {
            let embeddings = normalisasiEmbeddingWajah(siswa);
            if (!embeddings.length) {
                if (!siswa.photoBlob) continue;
                const img = await loadImageElementFromBlob(siswa.photoBlob);
                const hasil = await deteksiHumanTerkunci(img, {
                    face: {
                        detector: { return: true, rotation: true, minSize: AI_FACE_MIN_SIZE_PX },
                        mesh: { enabled: true },
                        iris: { enabled: false },
                        description: { enabled: true },
                        antispoof: { enabled: false },
                        liveness: { enabled: false }
                    },
                    gesture: { enabled: false }
                });
                const facesHasil = normalisasiFaceResults(hasil);
                if (!facesHasil.length) continue;
                const embeddingSumber = facesHasil[0]?.embedding;
                if (!embeddingSumber?.length) continue;
                const embedding = Array.from(embeddingSumber);
                embeddings = [embedding];
                siswa.descriptorHuman = embeddings;
                siswa.faceEmbeddings = embeddings;
                await simpanSiswaDB(siswa);
            } else if (!Array.isArray(siswa.faceEmbeddings)) {
                siswa.descriptorHuman = embeddings;
                siswa.faceEmbeddings = embeddings;
                await simpanSiswaDB(siswa);
            }
            database.push({ id: siswa.id, name: siswa.name, embeddings });
        } catch (error) {
            console.warn('Gagal membuat embedding Human untuk:', siswa.name, error);
        }
    }
    return database;
}


/* =====================================================
   MULAI AI
===================================================== */

async function mulaiAI() {
    terapkanProfilPerformaAI();
    if (!kameraDiizinkanHariIni()) {
        btnJepret.disabled = true;
        return false;
    }

    // Pastikan tombol jepret tidak aktif selama model masih disiapkan.
    btnJepret.disabled = true;
    setStatusAI(
        konfigurasi?.bahasa === 'en' ? 'Preparing AI in background…' : 'Menyiapkan AI di latar belakang…',
        '#007bff',
        true
    );

    try {
        // Download + inisialisasi model berjalan tanpa menghalangi kamera.
        await muatModelAI();

        faceDatabase = await siapkanDataWajah();

        if (faceDatabase.length > 0) {
            setStatusAI(
                replaceTemplate(
                    faceDatabase.length === 1 ? t('aiReadySavedOne') : t('aiReadySavedMany'),
                    { count: faceDatabase.length }
                ),
                '#28a745',
                false
            );
        } else {
            setStatusAI(
                t('aiReadyNoPhotos'),
                '#dc3545',
                false
            );
        }

        btnJepret.disabled =
            !absensiBolehDiproses();

        return true;

    } catch (error) {
        console.error('Gagal memulai AI Human:', error);

        setStatusAI(
            t('aiLoadError'),
            '#dc3545',
            false
        );

        // Kegagalan AI bukan kegagalan kamera. Kamera tetap dibiarkan
        // tampil dan dapat digunakan untuk mengambil foto perangkat.
        btnJepret.disabled = true;
        return false;
    }
}

/* =====================================================
   LIVENESS / KUALIFIKASI WAJAH LIVE
===================================================== */

function verifikasiLiveness(face) {
    if (!face) return false;

    const boxScore = Number(face.boxScore);
    const faceScore = Number(face.faceScore);
    const yaw = Number(face.rotation?.angle?.yaw);
    const pitch = Number(face.rotation?.angle?.pitch);
    const mesh = Array.isArray(face.mesh) ? face.mesh : [];

    // Human 3.3.6 memakai faceScore untuk kualitas mesh/face result.
    if (!Number.isFinite(boxScore) || boxScore < AI_FACE_MIN_BOX_SCORE) return false;
    if (!Number.isFinite(faceScore) || faceScore < AI_FACE_MIN_FACE_SCORE) return false;
    if (mesh.length < AI_MESH_MIN_POINTS) return false;
    if (!Number.isFinite(yaw) || Math.abs(yaw) > AI_FACE_MAX_YAW) return false;
    if (!Number.isFinite(pitch) || Math.abs(pitch) > AI_FACE_MAX_PITCH) return false;

    // Confidence live/real tidak dijadikan syarat pada SETIAP frame. Satu frame
    // buruk karena blur atau kedipan tidak boleh langsung membatalkan sesi.
    // Sinyal engine dievaluasi secara temporal oleh deteksiFrameUntukAbsensi().
    return true;
}

function adaSinyalLivenessEngine(face) {
    const live = Number(face?.live);
    const real = Number(face?.real);
    return (Number.isFinite(live) && live >= AI_LIVENESS_ENGINE_MIN)
        || (Number.isFinite(real) && real >= AI_LIVENESS_ENGINE_MIN);
}

function skorLivenessEngine(face) {
    const nilai = [Number(face?.live), Number(face?.real)]
        .filter(Number.isFinite);
    return nilai.length ? Math.max(...nilai) : null;
}

function wajahLurusUntukLiveness(face) {
    const yaw = Number(face?.rotation?.angle?.yaw);
    const pitch = Number(face?.rotation?.angle?.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;

    return Math.abs(yaw) <= AI_LIVENESS_STRAIGHT_YAW_DEG
        && Math.abs(pitch) <= AI_LIVENESS_STRAIGHT_PITCH_DEG;
}

function wajahMiringEkstremUntukLiveness(face) {
    const yaw = Number(face?.rotation?.angle?.yaw);
    const pitch = Number(face?.rotation?.angle?.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return true;

    return Math.abs(yaw) > AI_LIVENESS_RESET_YAW_DEG
        || Math.abs(pitch) > AI_LIVENESS_RESET_PITCH_DEG;
}

function ambilNamaGesturDariHasil(result, faces = []) {
    const sumber = [];
    if (Array.isArray(result?.gesture)) sumber.push(...result.gesture);

    for (const face of Array.isArray(faces) ? faces : []) {
        if (Array.isArray(face?.gesture)) sumber.push(...face.gesture);
        if (Array.isArray(face?.gestures)) sumber.push(...face.gestures);
    }

    return sumber
        .map(item => String(typeof item === 'string' ? item : (item?.gesture || item?.name || item?.label || '')).trim().toLowerCase())
        .filter(Boolean);
}

function apakahGesturBlink(gestur) {
    return (Array.isArray(gestur) ? gestur : []).some(nama => /\bblink\b|eye.?blink|kedip/.test(String(nama).toLowerCase()));
}

/* =====================================================
   MATCHING WAJAH
===================================================== */

function periksaUkuranWajah(face) {
    const box = Array.isArray(face?.box) ? face.box : null;
    const lebar = Number(box?.[2] || 0);
    const tinggi = Number(box?.[3] || 0);
    const ukuranMinimum = Math.min(lebar, tinggi);

    if (!(ukuranMinimum >= AI_FACE_MIN_SIZE_PX)) {
        return {
            layak: false,
            ukuran: ukuranMinimum,
            pesan: 'Wajah terlalu kecil untuk verifikasi. Silakan maju sedikit agar wajah lebih dekat ke kamera.'
        };
    }

    return { layak: true, ukuran: ukuranMinimum, pesan: '' };
}

function periksaKualifikasiMesh(face) {
    const meshScore = Number(face?.faceScore);
    const mesh = Array.isArray(face?.mesh) ? face.mesh : [];

    // Human 3.3.6 menyebut faceScore sebagai mesh score. Tidak ada properti
    // face.meshConfidence pada FaceResult versi ini.
    return Number.isFinite(meshScore)
        && meshScore >= AI_FACE_MIN_MESH_SCORE
        && mesh.length >= AI_MESH_MIN_POINTS;
}

function wajahLayakUntukMatching(face) {
    if (!face?.embedding?.length) return false;

    const ukuran = periksaUkuranWajah(face);
    if (!ukuran.layak) return false;

    const boxScore = Number(face.boxScore);
    const faceScore = Number(face.faceScore);
    const yaw = Number(face.rotation?.angle?.yaw);
    const pitch = Number(face.rotation?.angle?.pitch);

    if (!periksaKualifikasiMesh(face)) return false;

    // Human 3.3.x menyediakan boxScore/faceScore dan rotation angle pada
    // FaceResult. Wajah dengan kualitas rendah atau sudut ekstrem tidak
    // dipakai untuk pencocokan descriptor agar false-positive berkurang.
    if (!(boxScore >= AI_FACE_MIN_BOX_SCORE && faceScore >= AI_FACE_MIN_FACE_SCORE)) {
        return false;
    }

    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;
    return Math.abs(yaw) < AI_FACE_MAX_YAW && Math.abs(pitch) < AI_FACE_MAX_PITCH;
}

function wajahMengalamiBacklight(face) {
    const boxScore = Number(face?.boxScore);
    const faceScore = Number(face?.faceScore);
    return Number.isFinite(boxScore) && Number.isFinite(faceScore)
        && boxScore >= AI_BACKLIGHT_BOX_SCORE_MIN
        && faceScore < AI_BACKLIGHT_FACE_SCORE_MAX;
}

function peringatkanBacklightSekali() {
    const sekarang = Date.now();
    if (sekarang - kameraBacklightLastWarnAt < 5000) return;
    kameraBacklightLastWarnAt = sekarang;
    tampilkanToast(t('cameraBacklightWarning'), 4200);
}

function namaGestur(result) {
    if (!Array.isArray(result?.gesture)) return [];
    return result.gesture
        .map(g => String(g?.gesture || '').trim().toLowerCase())
        .filter(Boolean);
}

function cariKecocokan(embedding) {
    const queryNormal = ubahKeArrayNumerik(embedding);
    if (!queryNormal?.length || !faceDatabase.length) return null;

    try {
        const queryDescriptor = new Float32Array(queryNormal);
        let terbaik = null;

        for (const item of faceDatabase) {
            for (const descriptor of (item.embeddings || [])) {
                const descriptorNormal = ubahKeArrayNumerik(descriptor);
                if (!descriptorNormal || descriptorNormal.length !== 1024) continue;

                // Human menerima descriptor numerik; casting eksplisit di batas
                // matcher mencegah kegagalan ketika sumbernya berasal dari
                // IndexedDB, JSON/API, atau Float32Array.
                const descriptorSiapPakai = new Float32Array(descriptorNormal);
                const similarity = human.match.similarity(
                    queryDescriptor,
                    descriptorSiapPakai,
                    HUMAN_MATCH_OPTIONS
                );
                if (!Number.isFinite(similarity)) continue;
                if (!terbaik || similarity > terbaik.similarity) terbaik = { ...item, similarity };
            }
        }
        return terbaik;
    } catch (error) {
        console.warn('Matching Human gagal:', error);
        return null;
    }
}

/* =====================================================
   KAMERA
===================================================== */

async function perbaruiDaftarKamera() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        kameraDeviceIds = devices
            .filter(device => device.kind === 'videoinput' && device.deviceId)
            .map(device => ({ id: device.deviceId, label: device.label || 'Camera' }));
        return kameraDeviceIds;
    } catch (error) {
        console.warn('enumerateDevices kamera gagal:', error);
        kameraDeviceIds = [];
        return [];
    }
}

function apakahKameraVirtual(label = '') {
    const nama = String(label || '').trim().toLowerCase();
    if (!nama) return false;
    return /(^|[\s_\-])virtual([\s_\-]|$)|\bobs\b|\bfake\b|\bwebcam\b|\bmanycam\b|\bsnap camera\b|\bcamera virtual\b/i.test(nama);
}

function validasiKameraHardware(videoTrack) {
    if (!videoTrack) return;
    const settings = videoTrack.getSettings?.() || {};
    const deviceId = settings.deviceId || '';
    const deviceInfo = kameraDeviceIds.find(device => device.id === deviceId);
    const label = videoTrack.label || deviceInfo?.label || '';

    if (apakahKameraVirtual(label)) {
        const err = new Error(t('cameraVirtualError'));
        err.name = 'VirtualCameraError';
        err.cameraLabel = label;
        try { videoTrack.stop(); } catch (_) {}
        if (video.srcObject) {
            try { video.srcObject.getTracks().forEach(track => track.stop()); } catch (_) {}
            video.srcObject = null;
        }
        throw err;
    }
}

async function validasiCanvasHasil(canvas) {
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error(t('cameraPrivacyError'));
    }

    // Validator juga memakai toBlob() agar tidak membuat Base64 besar secara
    // sinkron di main thread. Ini menjaga UI tetap responsif pada HP kelas rendah.
    let validationBlob = null;
    try {
        validationBlob = await new Promise((resolve, reject) => {
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null.')), 'image/jpeg', 0.55);
        });
    } catch (error) {
        const err = new Error(t('cameraPrivacyError'));
        err.name = 'CanvasBlockedError';
        throw err;
    }

    if (!(validationBlob instanceof Blob) || validationBlob.size < 1000 || validationBlob.type !== 'image/jpeg') {
        const err = new Error(t('cameraPrivacyError'));
        err.name = 'CanvasBlockedError';
        throw err;
    }

    try {
        const sampleCanvas = document.createElement('canvas');
        const sw = 24;
        const sh = 24;
        sampleCanvas.width = sw;
        sampleCanvas.height = sh;
        const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
        if (!sctx) throw new Error('no-context');

        sctx.drawImage(canvas, 0, 0, sw, sh);
        const pixels = sctx.getImageData(0, 0, sw, sh).data;

        let opaque = 0;
        let minLuma = 255;
        let maxLuma = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            const alpha = pixels[i + 3];
            if (alpha > 5) opaque++;
            const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
            minLuma = Math.min(minLuma, luma);
            maxLuma = Math.max(maxLuma, luma);
        }

        if (opaque < 8 || (maxLuma - minLuma < 1 && (minLuma <= 1 || minLuma >= 254))) {
            const err = new Error(t('cameraPrivacyError'));
            err.name = 'CanvasBlockedError';
            throw err;
        }
    } catch (error) {
        if (error?.name === 'CanvasBlockedError') throw error;
        const err = new Error(t('cameraPrivacyError'));
        err.name = 'CanvasBlockedError';
        throw err;
    }
}

function adaptCameraSize() {
    const wadahEl = document.getElementById('wadah');
    if (!wadahEl) return;
    const rasio = wadahEl.dataset.rasio === '9:16' ? 9 / 16 : 16 / 9;
    const lebarTersedia = Math.min(window.innerWidth * 0.90, wadahEl.dataset.rasio === '9:16' ? 380 : 560);
    const tinggiMaks = Math.max(180, window.innerHeight * 0.58);
    let width = lebarTersedia;
    let height = width / rasio;
    if (height > tinggiMaks) {
        height = tinggiMaks;
        width = height * rasio;
    }
    wadahEl.style.width = `${Math.round(width)}px`;
    wadahEl.style.height = `${Math.round(height)}px`;
    wadahEl.style.aspectRatio = `${rasio}`;
}

function sinkronkanCanvasAIPadaResize() {
    const canvas = document.getElementById('aiCanvas');
    if (!canvas || !video?.videoWidth || !video?.videoHeight) return;

    // DPR dibatasi 2x untuk mencegah backing-store canvas menjadi sangat besar
    // pada HP 2K/3K; ini tetap meningkatkan ketajaman dibanding CSS-pixel biasa.
    const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
    const width = video.videoWidth;
    const height = video.videoHeight;
    const widthPhysical = Math.max(1, Math.round(width * dpr));
    const heightPhysical = Math.max(1, Math.round(height * dpr));

    if (canvas.width !== widthPhysical || canvas.height !== heightPhysical) {
        canvas.width = widthPhysical;
        canvas.height = heightPhysical;
    }

    // Pertahankan rasio intrinsik yang sama dengan frame video. CSS object-fit
    // tetap dipakai bersama video sehingga crop/letterbox tidak berbeda.
    canvas.style.aspectRatio = `${width} / ${height}`;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'cover';
    canvas.style.objectPosition = 'center center';
    canvas.style.pointerEvents = 'none';
    // Canvas tetap normal. Preview kamera depan dicerminkan hanya pada video;
    // koordinat X overlay dicerminkan saat menggambar. Dengan begitu teks label
    // tidak ikut menjadi tulisan cermin.
    canvas.style.transform = 'none';

    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
    }
    aiLastDetectionAt = 0;
}

function pasangListenerSinkronisasiCanvasKamera() {
    if (!video || video.dataset.canvasSyncBound === '1') return;

    const jadwalkanSinkronisasi = () => {
        // RAF mencegah beberapa event metadata/resize berturut-turut melakukan
        // resize canvas berulang dalam satu frame browser.
        cancelAnimationFrame(Number(video.dataset.canvasSyncRaf || 0));
        const raf = requestAnimationFrame(() => {
            video.dataset.canvasSyncRaf = '';
            adaptCameraSize();
            sinkronkanCanvasAIPadaResize();
        });
        video.dataset.canvasSyncRaf = String(raf);
    };

    video.addEventListener('loadedmetadata', jadwalkanSinkronisasi, { passive: true });
    video.addEventListener('resize', jadwalkanSinkronisasi, { passive: true });
    video.addEventListener('canplay', jadwalkanSinkronisasi, { passive: true });
    video.dataset.canvasSyncBound = '1';
}

pasangListenerSinkronisasiCanvasKamera();
terapkanProfilPerformaAI();

function gambarOverlayCanvas(detectionResult) {
    const canvas = document.getElementById('aiCanvas');
    if (!canvas || !video?.videoWidth || !video?.videoHeight) return;

    sinkronkanCanvasAIPadaResize();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, video.videoWidth, video.videoHeight);

    // Human draw.all() memang mendukung canvas + Result, tetapi preview aplikasi
    // memiliki overlay label custom (nama/similarity/jadwal). Karena itu helper
    // ini menangani geometri/clear sementara renderer utama menggambar labelnya
    // secara atomik di dalam mulaiPreviewAI().
    return detectionResult;
}

function pastikanSecureContextKamera() {
    const secureDefined = typeof window.isSecureContext === 'boolean';
    const insecure = secureDefined && window.isSecureContext === false;
    const punyaGetUserMedia = Boolean(navigator.mediaDevices?.getUserMedia);

    if (!insecure && punyaGetUserMedia) return true;

    const protocol = String(location.protocol || '').toLowerCase();
    const sumberLokal = protocol === 'file:' || protocol === 'content:' || location.hostname === '';
    const detail = sumberLokal
        ? 'File HTML yang dibuka dari Download/content:// tidak diberi izin kamera live oleh browser. Aplikasi kamera harus dibuka dari HTTPS atau localhost.'
        : 'Halaman ini bukan Secure Context atau browser tidak menyediakan getUserMedia. Gunakan HTTPS/localhost dan browser utama seperti Chrome, Edge, atau Safari.';

    const error = new DOMException(detail, 'SecurityError');
    tampilkanErrorKamera(error);
    return false;
}

async function jagaLayarTetapMenyala() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return false;

    try {
        if (wakeLock && wakeLock.released === false) return true;

        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener?.('release', () => {
            wakeLock = null;
        });
        return true;
    } catch (error) {
        wakeLock = null;
        console.warn('Screen Wake Lock tidak tersedia/gagal:', error);
        return false;
    }
}

async function lepaskanWakeLock() {
    if (!wakeLock) return;
    const lock = wakeLock;
    wakeLock = null;
    try {
        await lock.release();
    } catch (error) {
        console.warn('Gagal melepas Screen Wake Lock:', error);
    }
}

async function terapkanKendaliOtomatisKamera(track) {
    if (!track?.applyConstraints) return false;

    try {
        const capabilities = track.getCapabilities?.() || {};
        const advanced = [];

        if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
            advanced.push({ focusMode: 'continuous' });
        }

        if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
            advanced.push({ exposureMode: 'continuous' });
        }

        if (!advanced.length) return false;
        await track.applyConstraints({ advanced });
        return true;
    } catch (error) {
        // Dukungan focus/exposure berbeda-beda antar device/browser. Kegagalan
        // di sini tidak boleh mematikan kamera yang sebenarnya masih usable.
        console.warn('Kendali autofocus/exposure kontinu tidak tersedia/diterapkan:', error);
        return false;
    }
}

async function mulaiKameraInternal() {
    const currentToken = ++kameraRequestId;
    hentikanKamera(false);

    if (!kameraDiizinkanHariIni()) {
        setKameraPlaceholder(t('preparingCamera'), true);
        return;
    }

    if (!pastikanSecureContextKamera()) {
        throw new DOMException(
            konfigurasi?.bahasa === 'en'
                ? 'Live camera requires HTTPS or localhost.'
                : 'Kamera langsung memerlukan HTTPS atau localhost.',
            'SecurityError'
        );
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        const error = new Error(t('manualCameraOnly'));
        error.name = 'NotSupportedError';
        throw error;
    }

    // Label kamera sering masih kosong sebelum izin diberikan. Cek sebelum
    // dan sesudah getUserMedia agar virtual camera yang teridentifikasi dapat ditolak.
    if (await periksaKameraVirtual()) {
        throw tolakKameraVirtual();
    }

    const rasio = konfigurasi?.rasioKamera === '9:16' ? '9:16' : '16:9';
    const target = dapatkanTargetKamera(rasio);
    let stream = null;

    const pesanTimeoutKamera = konfigurasi?.bahasa === 'en'
        ? 'The camera did not respond in time.'
        : 'Kamera tidak merespons dalam waktu wajar.';

    try {
        // Prioritaskan kamera depan untuk mode wefie; tetap beri fallback bila perangkat
        // tidak memenuhi constraint tersebut.
        const facingModeDiminta = gunakanKameraDepan ? 'user' : 'environment';
        const constraintsUtama = {
            audio: false,
            video: {
                facingMode: { exact: facingModeDiminta },
                width: { ideal: target.width, max: target.width },
                height: { ideal: target.height, max: target.height },
                aspectRatio: { ideal: target.width / target.height },
                frameRate: { ideal: 30, max: 30 }
            }
        };

        try {
            stream = await denganBatasWaktuKamera(
                navigator.mediaDevices.getUserMedia(constraintsUtama),
                KAMERA_TIMEOUT_MS,
                pesanTimeoutKamera
            );
        } catch (errorUtama) {
            if (errorUtama?.name === 'TimeoutError') throw errorUtama;
            if (!['OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(errorUtama?.name)) throw errorUtama;
            stream = await denganBatasWaktuKamera(
                navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: { ideal: facingModeDiminta },
                        width: { ideal: Math.min(target.width, 960), max: target.width },
                        height: { ideal: Math.min(target.height, 540), max: target.height },
                        frameRate: { ideal: 30, max: 30 }
                    }
                }),
                KAMERA_TIMEOUT_MS,
                pesanTimeoutKamera
            ).catch(async errorFallback => {
                if (errorFallback?.name === 'TimeoutError') throw errorFallback;
                if (!['OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(errorFallback?.name)) throw errorFallback;
                return await denganBatasWaktuKamera(
                    navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: {
                            facingMode: { ideal: facingModeDiminta },
                            width: { ideal: Math.min(target.width, 640), max: target.width },
                            height: { ideal: Math.min(target.height, 480), max: target.height },
                            frameRate: { ideal: 30, max: 30 }
                        }
                    }),
                    KAMERA_TIMEOUT_MS,
                    pesanTimeoutKamera
                );
            });
        }

        // Setelah izin diberikan, browser biasanya mengisi label perangkat.
        // Periksa ulang sebelum stream dipasang ke UI.
        if (await periksaKameraVirtual()) {
            matikanKamera(stream);
            throw tolakKameraVirtual();
        }

        // Stream ini datang dari request lama? Matikan langsung agar tidak jadi zombie stream.
        if (currentToken !== kameraRequestId) {
            matikanKamera(stream);
            return;
        }

        video.srcObject = stream;
        videoTrack = stream.getVideoTracks()[0] || null;
        await perbaruiDaftarKamera();
        validasiKameraHardware(videoTrack);

        if (currentToken !== kameraRequestId) {
            matikanKamera(stream);
            if (video.srcObject === stream) video.srcObject = null;
            videoTrack = null;
            return;
        }

        await terapkanKendaliOtomatisKamera(videoTrack);

        await cekBateraiDanPeringatkan();
        adaptCameraSize();
        lampuNyala = false;
        btnFlash.classList.remove('aktif');
        terapkanPreviewKamera();

        if (videoTrack) {
            const capabilities = videoTrack.getCapabilities?.();
            btnFlash.style.display = capabilities?.torch ? 'flex' : 'none';
        }

        await denganBatasWaktuKamera(
            new Promise(resolve => {
                if (video.readyState >= 1) return resolve();
                video.onloadedmetadata = () => resolve();
            }),
            KAMERA_TIMEOUT_MS,
            pesanTimeoutKamera
        );

        // Metadata menentukan dimensi intrinsik aktual perangkat (termasuk
        // perubahan orientasi/driver kamera). Sinkronkan canvas segera setelah
        // metadata tersedia, lalu listener persistent menangani perubahan berikutnya.
        adaptCameraSize();
        sinkronkanCanvasAIPadaResize();

        if (currentToken !== kameraRequestId) {
            matikanKamera(stream);
            if (video.srcObject === stream) video.srcObject = null;
            videoTrack = null;
            return;
        }

        try {
            await video.play();
            await jagaLayarTetapMenyala();
        } catch (error) {
            setKameraPlaceholder(t('cameraStartMessage'), true);
            throw new Error(t('videoPlayError'));
        }

        if (currentToken !== kameraRequestId) {
            matikanKamera(stream);
            if (video.srcObject === stream) video.srcObject = null;
            videoTrack = null;
            return;
        }

        setKameraPlaceholder('', false);
        mulaiTimerThermalKamera();
        mulaiPantauanKinerjaKamera();
        mulaiPreviewAI();
    } catch (error) {
        const requestIsStale = currentToken !== kameraRequestId;
        try {
            if (stream && typeof stream.getTracks === 'function') matikanKamera(stream);
        } catch (cleanupError) {
            console.warn('Gagal membersihkan stream kamera:', cleanupError);
        }

        if (video.srcObject === stream) video.srcObject = null;
        if (!requestIsStale) {
            videoTrack = null;
            btnFlash.style.display = 'none';
            terapkanPreviewKamera();
            setKameraPlaceholder(t('preparingCamera'), true);
        }

        if (!requestIsStale) throw error;
    } // Akhir blok try/catch utama mulaiKameraInternal
} // Akhir fungsi mulaiKameraInternal

function mulaiKamera() {
    if (kameraInitPromise) return kameraInitPromise;

    kameraInitPromise = (async () => {
        try {
            return await mulaiKameraInternal();
        } catch (error) {
            // Pemanggil tetap menerima rejection agar setiap jalur UI dapat
            // menampilkan fallback yang sesuai; Promise singleton hanya
            // mencegah eksekusi getUserMedia ganda.
            throw error;
        } finally {
            kameraInitPromise = null;
        }
    })();

    return kameraInitPromise;
}

/* =====================================================
   HENTIKAN KAMERA / CLEANUP STREAM
===================================================== */

function matikanKamera(stream) {
    if (!stream || typeof stream.getTracks !== 'function') {
        lampuNyala = false;
        btnFlash?.classList.remove('aktif');
        return;
    }
    try {
        const tracks = stream.getTracks();
        tracks.forEach(track => {
            if (lampuNyala && track?.applyConstraints) {
                void Promise.resolve(track.applyConstraints({ advanced: [{ torch: false }] }))
                    .catch(() => {})
                    .finally(() => {
                        try { track.stop(); } catch (_) {}
                    });
            } else {
                try { track.stop(); } catch (_) {}
            }
        });
    } catch (error) {
        console.warn('Gagal menghentikan stream kamera:', error);
    } finally {
        lampuNyala = false;
        btnFlash?.classList.remove('aktif');
    }
}

function hentikanLoopDeteksi() {
    // Invalidasi generasi SEBELUM cancelAnimationFrame agar callback async lama
    // yang masih menunggu human.detect() tidak menjadwalkan frame baru.
    aiLoopGeneration++;
    if (aiInterval) {
        cancelAnimationFrame(aiInterval);
        aiInterval = null;
    }
    aiLastDetectionAt = 0;
}

function hentikanKamera(invalidatePendingRequests = true) {
    if (invalidatePendingRequests) kameraRequestId++;

    if (kameraViewportSyncTimer) {
        clearTimeout(kameraViewportSyncTimer);
        kameraViewportSyncTimer = null;
    }
    if (cameraViewportSyncRaf) {
        cancelAnimationFrame(cameraViewportSyncRaf);
        cameraViewportSyncRaf = null;
    }

    hentikanTimerThermalKamera();
    void lepaskanWakeLock();
    hentikanPantauanKamera();
    hentikanLoopDeteksi();

    // human.detect() yang sudah berjalan tidak dapat dibatalkan secara paksa.
    // Mutex global memastikan panggilan berikutnya menunggu proses lama selesai.

    const canvas = document.getElementById('aiCanvas');
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);

    const stream = video?.srcObject;
    if (stream) {
        matikanKamera(stream);
        video.srcObject = null;
    }

    videoTrack = null;

    try {
        if (aiInputCanvas) {
            aiInputCanvas.width = 2;
            aiInputCanvas.height = 2;
            aiInputContext = null;
        }
    } catch (error) {
        console.warn('Gagal mereset canvas input AI:', error);
    }

    btnFlash.style.display = 'none';
    terapkanPreviewKamera();

    if (!video.srcObject) setKameraPlaceholder(t('preparingCamera'), true);
}

/* =====================================================
   PREVIEW AI
   Frekuensi dibuat moderat agar HP tidak terlalu panas.
===================================================== */

function mulaiPreviewAI() {
    terapkanProfilPerformaAI();
    // Start baru selalu membatalkan generasi loop sebelumnya.
    hentikanLoopDeteksi();
    const generation = aiLoopGeneration;

    const canvas =
        document.getElementById('aiCanvas') ||
        document.createElement('canvas');

    canvas.id = 'aiCanvas';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    // Overlay canvas memakai ukuran internal frame video dan object-fit:cover
    // yang sama dengan <video>. Karena itu crop/offset mengikuti geometri yang
    // sama dan bounding box Human tetap sinkron tanpa offset manual tambahan.
    canvas.style.objectFit = 'cover';
    canvas.style.transform = 'none'; // video saja yang dicerminkan; koordinat canvas dibalik secara matematis

    wadah.querySelectorAll('canvas').forEach(c => {
        if (c !== canvas) c.remove();
    });

    if (!canvas.parentElement) wadah.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    let running = false;
    let noFaceSince = 0;
    let noFaceWarningShown = false;

    // Preview tidak melakukan identity matching. Database baru disentuh setelah
    // fase liveness pada proses absensi lolos. Ini menghindari loop matching ke
    // seluruh IndexedDB pada saat kamera sedang live.

    // requestAnimationFrame menyelaraskan penjadwalan dengan siklus render
    // browser. human.detect() tetap asynchronous sehingga callback tidak
    // menumpuk ketika inferensi membutuhkan waktu lebih lama.
    const jadwalkanFrameBerikutnya = () => {
        if (generation !== aiLoopGeneration) return;
        aiInterval = requestAnimationFrame(loop);
    };

    const loop = async timestamp => {
        if (generation !== aiLoopGeneration) return;

        if (!video.srcObject || video.readyState < 2) {
            jadwalkanFrameBerikutnya();
            return;
        }

        const halKamera = document.getElementById('hal-1');
        if (!halKamera || halKamera.classList.contains('sembunyi') || garisScan.classList.contains('aktif')) {
            jadwalkanFrameBerikutnya();
            return;
        }

        // Refresh kamera tetap halus, tetapi inferensi AI dibatasi 12 FPS.
        if (timestamp - aiLastDetectionAt < aiDetectionIntervalMsAktif || running) {
            jadwalkanFrameBerikutnya();
            return;
        }

        aiLastDetectionAt = timestamp;
        const brightnessBeforeAI = cekKecerahanFrameVideo();
        if (brightnessBeforeAI.lowLight) {
            setStatusAI(
                konfigurasi?.bahasa === 'en' ? 'Move to a brighter place' : 'Pindahlah ke tempat yang lebih terang',
                '#d97706',
                false
            );
            jadwalkanFrameBerikutnya();
            return;
        }

        running = true;
        try {
            // FASE 1: hanya detector wajah + rotation. Tidak ada descriptor/matching.
            const hasil = await deteksiWajahLoop(AI_PREVIEW_CONFIG, { waitForExisting: false });
            if (generation !== aiLoopGeneration) return;
            if (!hasil) return;

            previewFaceCount = 0;
            if (Array.isArray(hasil?.face)) {
                const limit = Math.min(AI_MULTI_FACE_MAX, hasil.face.length);
                for (let i = 0; i < limit; i++) {
                    previewFaceBuffer[i] = hasil.face[i];
                }
                previewFaceCount = limit;
            }
            const facesPreview = previewFaceBuffer;
            facesPreview.length = previewFaceCount;
            const brightnessPreview = cekKecerahanFrameVideo();

            if (brightnessPreview.lowLight) {
                setStatusAI(
                    konfigurasi?.bahasa === 'en' ? 'Move to a brighter place' : 'Pindahlah ke tempat yang lebih terang',
                    '#d97706',
                    false
                );
                return;
            }

            if (!facesPreview.length) {
                gambarOverlayCanvas({ face: [] });
                if (!noFaceSince) noFaceSince = performance.now();
                setStatusAI(
                    konfigurasi?.bahasa === 'en'
                        ? 'Position your face inside the camera frame'
                        : 'Posisikan wajah di dalam bingkai kamera',
                    '#2563eb',
                    false
                );
                if (!noFaceWarningShown && performance.now() - noFaceSince >= 4000) {
                    noFaceWarningShown = true;
                    tampilkanToast(
                        konfigurasi?.bahasa === 'en'
                            ? 'Face not found. Move to a brighter area.'
                            : 'Wajah tidak ditemukan. Cari area yang lebih terang.',
                        4200
                    );
                }
                return;
            }

            noFaceSince = 0;
            noFaceWarningShown = false;

            gambarOverlayCanvas(hasil);
            const lebarVideo = video.videoWidth || 640;
            const tinggiVideo = video.videoHeight || 360;
            const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
            const lebarFisik = Math.max(1, Math.round(lebarVideo * dpr));
            const tinggiFisik = Math.max(1, Math.round(tinggiVideo * dpr));

            if (canvas.width !== lebarFisik || canvas.height !== tinggiFisik) {
                canvas.width = lebarFisik;
                canvas.height = tinggiFisik;
            }

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, lebarVideo, tinggiVideo);

            if (facesPreview.length === 1) updateStatusWajahPreview(facesPreview[0]);
            else if (facesPreview.length > 1) setStatusAI(konfigurasi?.bahasa === 'en' ? `${facesPreview.length} faces detected` : `${facesPreview.length} wajah terdeteksi`, '#2563eb', false);

            // Style statis dipasang satu kali per frame, bukan berulang untuk setiap wajah.
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.font = 'bold 14px sans-serif';
            ctx.textBaseline = 'bottom';

            facesPreview.forEach(wajah => {
                const [boxOriginalX, y, w, h] = clampFaceBoxToVideo(wajah?.box, lebarVideo, tinggiVideo);
                const isMirror = wadah?.classList.contains('kamera-cermin');
                const boxX = isMirror
                    ? clampNumber(lebarVideo - (boxOriginalX + w), 0, lebarVideo)
                    : boxOriginalX;

                ctx.strokeRect(boxX, y, w, h);

                const label = 'Wajah terdeteksi';
                const padding = 8;
                const textWidth = ctx.measureText(label).width;
                ctx.fillStyle = 'rgba(0,0,0,.72)';
                ctx.fillRect(boxX, Math.max(0, y - 30), textWidth + padding * 2, 28);
                ctx.fillStyle = '#fff';
                ctx.fillText(label, boxX + padding, Math.max(19, y - 10));
            });
        } catch (error) {
            console.warn('Preview AI Human:', error);
        } finally {
            running = false;
            jadwalkanFrameBerikutnya();
        }
    }; // Akhir loop preview AI



    jadwalkanFrameBerikutnya();
} // Akhir fungsi mulaiPreviewAI

/* =====================================================
   FLASH
===================================================== */

btnFlash?.addEventListener(
    'click',
    async () => {

        if (!videoTrack)
            return;


        try {

            lampuNyala =
                !lampuNyala;


            await videoTrack.applyConstraints({

                advanced: [
                    {
                        torch:
                            lampuNyala
                    }
                ]

            });


            btnFlash.classList.toggle(
                'aktif',
                lampuNyala
            );


        } catch (error) {

            alert(t('flashUnsupported'));

            lampuNyala =
                false;

        }

    }
);



document.getElementById('btnFlipKamera')?.addEventListener('click', async () => {
    if (aiBusy || kameraSwitchInProgress) return;
    if (!kameraDiizinkanHariIni()) {
        tampilkanToast(replaceTemplate(t('noDutyToday'), { day: hariTampilan(getHariIndexSekarang()).toUpperCase() }), 2200);
        return;
    }

    kameraSwitchInProgress = true;
    const arahSebelumnya = gunakanKameraDepan;
    gunakanKameraDepan = !gunakanKameraDepan;
    const tombol = document.getElementById('btnFlipKamera');
    tombol?.classList.toggle('aktif', gunakanKameraDepan);
    if (tombol) {
        tombol.setAttribute('aria-label', t('flipCamera'));
        tombol.title = gunakanKameraDepan ? t('cameraBack') : t('cameraFront');
    }

    try {
        // Lepas stream lama secara eksplisit sebelum meminta sensor kamera lagi.
        // Ini menghindari deadlock NotReadableError pada beberapa Android/WebView.
        kameraRequestId++;
        const streamLama = video?.srcObject;
        if (streamLama) matikanKamera(streamLama);
        if (video) {
            video.pause?.();
            video.srcObject = null;
        }
        videoTrack = null;
        hentikanLoopDeteksi();
        hentikanTimerThermalKamera();
        hentikanPantauanKamera();
        const canvas = document.getElementById('aiCanvas');
        canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        setKameraPlaceholder(
            gunakanKameraDepan ? t('cameraFront') : t('cameraBack'),
            true
        );

        // Jeda singkat agar OS benar-benar melepaskan sensor kamera lama.
        await new Promise(resolve => setTimeout(resolve, 220));
        await mulaiKamera();
        terapkanPreviewKamera();
        tampilkanToast(
            gunakanKameraDepan ? t('cameraFront') : t('cameraBack')
        );
    } catch (error) {
        console.error('Gagal mengganti kamera:', error);
        gunakanKameraDepan = arahSebelumnya;
        tombol?.classList.toggle('aktif', gunakanKameraDepan);
        if (tombol) tombol.title = gunakanKameraDepan ? t('cameraBack') : t('cameraFront');

        // Pastikan permintaan yang gagal tidak menyisakan stream yatim.
        const streamGagal = video?.srcObject;
        if (streamGagal) matikanKamera(streamGagal);
        if (video) video.srcObject = null;
        videoTrack = null;
        try {
            await new Promise(resolve => setTimeout(resolve, 220));
            await mulaiKamera();
        } catch (fallbackError) {
            tampilkanErrorKamera(fallbackError);
        }
        tampilkanToast(t('cameraSwitchError'), 2600);
    } finally {
        kameraSwitchInProgress = false;
    }
});

function kunciTrackerWajah(face, index = 0) {
    const id = Number(face?.id);
    if (Number.isFinite(id)) return `id:${id}`;
    const box = Array.isArray(face?.box) ? face.box : [0, 0, 0, 0];
    const x = Math.round((Number(box[0]) || 0) / 32);
    const y = Math.round((Number(box[1]) || 0) / 32);
    return `box:${x}:${y}:${index}`;
}

function resetTrackerLiveness() {
    trackerLiveness.clear();
}

function gesturBlinkUntukWajah(result, face, faceIndex) {
    const nama = [];

    // Human 3.3.6 mengekspos hasil gesture sebagai object/record pada
    // human.result.gesture, walau beberapa build/integrasi dapat memberi array.
    const sumberGesture = result?.gesture;
    const daftar = Array.isArray(sumberGesture)
        ? sumberGesture
        : (sumberGesture && typeof sumberGesture === 'object' ? Object.values(sumberGesture) : []);

    for (const item of daftar) {
        const target = Number(item?.face);
        if (Number.isFinite(target) && target !== faceIndex) continue;
        const value = String(typeof item === 'string'
            ? item
            : (item?.gesture || item?.name || item?.label || '')).trim().toLowerCase();
        if (value) nama.push(value);
    }

    const faceGesture = Array.isArray(face?.gesture)
        ? face.gesture
        : (face?.gesture && typeof face.gesture === 'object' ? Object.values(face.gesture) : []);
    const faceGestures = Array.isArray(face?.gestures)
        ? face.gestures
        : (face?.gestures && typeof face.gestures === 'object' ? Object.values(face.gestures) : []);

    for (const item of [...faceGesture, ...faceGestures]) {
        const value = String(typeof item === 'string'
            ? item
            : (item?.gesture || item?.name || item?.label || '')).trim().toLowerCase();
        if (value) nama.push(value);
    }

    return nama.some(value =>
        /(^|\s)blink (left|right) eye($|\s)/.test(value)
        || /\bblink\b|eye.?blink|kedip/.test(value)
    );
}

function gambarOverlayLivenessMasal(faces, states) {
    const canvas = document.getElementById('aiCanvas');
    if (!canvas || !video?.videoWidth || !video?.videoHeight) return;
    sinkronkanCanvasAIPadaResize();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
    const width = video.videoWidth;
    const height = video.videoHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const mirror = wadah?.classList.contains('kamera-cermin');
    ctx.font = 'bold 13px sans-serif';
    ctx.textBaseline = 'bottom';

    (Array.isArray(faces) ? faces.slice(0, AI_MULTI_FACE_MAX) : []).forEach((face, index) => {
        const [x0, y, w, h] = clampFaceBoxToVideo(face?.box, width, height);
        const x = mirror ? clampNumber(width - (x0 + w), 0, width) : x0;
        const state = states.get(kunciTrackerWajah(face, index));
        const fase = Number(state?.fase || 0);
        let label = 'Hadap lurus ke kamera';
        let stroke = '#ef4444';
        if (state?.sudahLolos) {
            label = 'Lulus • memeriksa nama...';
            stroke = '#22c55e';
        } else if (fase === 1) {
            label = 'Kedipkan mata untuk verifikasi liveness';
            stroke = '#facc15';
        }
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);
        const textWidth = ctx.measureText(label).width;
        const labelY = Math.max(20, y - 6);
        ctx.fillStyle = 'rgba(0,0,0,.78)';
        ctx.fillRect(x, Math.max(0, labelY - 20), textWidth + 12, 20);
        ctx.fillStyle = stroke;
        ctx.fillText(label, x + 6, labelY - 3);
    });
}

async function deteksiFrameUntukAbsensi() {
    let sampledFrameCount = 0;
    let lastFaces = [];
    let engineLivenessFrames = 0;
    let maxEngineLivenessScore = null;
    let blinkDetectedCount = 0;
    let movementPassedCount = 0;

    const sumberDeteksi = video;
    if (!sumberDeteksi) {
        return { faces: [], livenessPassed: false, movementPassed: false, blinkDetected: false, gesturePassed: false, stableHadirIds: [] };
    }

    resetTrackerLiveness();
    statusLiveness = 0;
    setStatusAI(
        konfigurasi?.bahasa === 'en' ? 'Up to 8 faces can be verified at once.' : 'Maksimal 8 wajah dapat diverifikasi sekaligus.',
        '#2563eb', false
    );

    for (let sample = 0; sample < AI_LIVENESS_SAMPLE_COUNT; sample++) {
        if (sample > 0) await new Promise(resolve => setTimeout(resolve, AI_LIVENESS_SAMPLE_INTERVAL_MS));

        const brightness = cekKecerahanFrameVideo(true);
        if (brightness.lowLight) {
            return { faces: lastFaces, livenessPassed: false, movementPassed: false, blinkDetected: false, gesturePassed: false, stableHadirIds: [], brightnessWarning: true, brightnessAverage: brightness.average };
        }

        const hasil = await deteksiHumanDariFrameKecil({
            face: {
                ...(AI_LIVENESS_CONFIG.face || {}),
                detector: { ...(AI_LIVENESS_CONFIG.face?.detector || {}), maxDetected: AI_MULTI_FACE_MAX },
                description: { enabled: false }
            },
            gesture: { enabled: true }
        }, { waitForExisting: true, profile: 'liveness' });
        sampledFrameCount++;
        const facesFrame = Array.isArray(hasil?.face) ? hasil.face.slice(0, AI_MULTI_FACE_MAX) : [];
        lastFaces = facesFrame;

        const activeKeys = new Set();
        facesFrame.forEach((face, index) => {
            const key = kunciTrackerWajah(face, index);
            activeKeys.add(key);
            if (!trackerLiveness.has(key)) {
                trackerLiveness.set(key, {
                    fase: 0,
                    sudahLolos: false,
                    lurusBerurutan: 0,
                    baselineYaw: null,
                    baselinePitch: null,
                    qualifiedFrames: 0,
                    engineFrames: 0,
                    engineGoodFrames: 0,
                    blinkDetected: false,
                    blinkStartAt: 0,
                    movementPassed: false,
                    lastSeen: performance.now()
                });
            }
            trackerLiveness.get(key).lastSeen = performance.now();
        });
        for (const [key, state] of trackerLiveness) {
            if (!activeKeys.has(key) && performance.now() - state.lastSeen > 700) trackerLiveness.delete(key);
        }

        let adaYangLolos = false;
        facesFrame.forEach((face, index) => {
            const key = kunciTrackerWajah(face, index);
            const state = trackerLiveness.get(key);
            if (!state || state.sudahLolos) return;
            if (!verifikasiLiveness(face)) {
                state.lurusBerurutan = 0;
                return;
            }

            state.qualifiedFrames++;
            const engineScore = skorLivenessEngine(face);
            if (Number.isFinite(engineScore)) {
                state.engineFrames++;
                maxEngineLivenessScore = maxEngineLivenessScore === null ? engineScore : Math.max(maxEngineLivenessScore, engineScore);
                if (engineScore >= AI_LIVENESS_ENGINE_MIN) {
                    state.engineGoodFrames++;
                    engineLivenessFrames++;
                }
            }

            const nowLiveness = performance.now();
            const blinkAktif = gesturBlinkUntukWajah(hasil, face, index);
            if (blinkAktif) {
                if (!state.blinkStartAt) {
                    state.blinkStartAt = nowLiveness;
                } else if (nowLiveness - state.blinkStartAt > AI_LIVENESS_BLINK_MAX_MS) {
                    state.blinkStartAt = nowLiveness;
                }
            } else if (state.blinkStartAt) {
                const durasiBlink = nowLiveness - state.blinkStartAt;
                state.blinkStartAt = 0;
                if (durasiBlink >= AI_LIVENESS_BLINK_MIN_MS && durasiBlink <= AI_LIVENESS_BLINK_MAX_MS) {
                    state.blinkDetected = true;
                }
            }

            const yaw = Number(face?.rotation?.angle?.yaw);
            const pitch = Number(face?.rotation?.angle?.pitch);
            const lurus = wajahLurusUntukLiveness(face);

            if (state.fase === 0) {
                state.lurusBerurutan = lurus ? state.lurusBerurutan + 1 : 0;
                if (state.lurusBerurutan >= AI_LIVENESS_STABLE_STRAIGHT_FRAMES) {
                    state.fase = 1;
                    state.baselineYaw = Number.isFinite(yaw) ? yaw : 0;
                    state.baselinePitch = Number.isFinite(pitch) ? pitch : 0;
                    state.blinkDetected = false;
                    state.blinkStartAt = 0;
                }
                return;
            }

            if (state.fase === 1) {
                if (wajahMiringEkstremUntukLiveness(face)) {
                    state.fase = 0;
                    state.lurusBerurutan = 0;
                    state.baselineYaw = null;
                    state.baselinePitch = null;
                    return;
                }

                // Challenge liveness sekarang mensyaratkan dua sinyal berbeda:
                // 1) engine anti-spoof/liveness mencapai ambang pada beberapa frame,
                // 2) blink nyata terdeteksi dalam rentang durasi yang valid.
                // Gerakan kepala tetap dicatat sebagai sinyal tambahan, tetapi
                // TIDAK cukup untuk meloloskan sesi sendirian. Senyum/emotion juga
                // sengaja tidak dipakai sebagai liveness karena foto 2D dapat
                // menampilkan ekspresi statis yang sama.
                const engineLulus = state.engineGoodFrames >= AI_LIVENESS_ENGINE_REQUIRED_FRAMES;
                if (state.blinkDetected && engineLulus) {
                    state.sudahLolos = true;
                    state.fase = 2;
                    blinkDetectedCount++;
                    adaYangLolos = true;
                    return;
                }

                const movedYaw = Number.isFinite(yaw) && Number.isFinite(state.baselineYaw) && Math.abs(yaw - state.baselineYaw) >= AI_LIVENESS_MOVEMENT_DELTA_DEG;
                const movedPitch = Number.isFinite(pitch) && Number.isFinite(state.baselinePitch) && Math.abs(pitch - state.baselinePitch) >= AI_LIVENESS_MOVEMENT_DELTA_DEG;
                if (movedYaw || movedPitch) state.movementPassed = true;
            }
        });

        const facesLolos = Array.from(trackerLiveness.values()).filter(state => state.sudahLolos).length;
        statusLiveness = facesLolos ? 2 : (trackerLiveness.size ? 1 : 0);
        gambarOverlayLivenessMasal(facesFrame, trackerLiveness);

        const waiting = Array.from(trackerLiveness.values()).filter(state => !state.sudahLolos).length;
        if (facesFrame.length === 0) {
            setStatusAI(konfigurasi?.bahasa === 'en' ? 'Position faces inside the camera frame.' : 'Posisikan wajah di dalam bingkai kamera.', '#2563eb', false);
        } else if (waiting > 0) {
            setStatusAI(konfigurasi?.bahasa === 'en' ? `${facesFrame.length} face(s) detected • follow the instruction above each face.` : `${facesFrame.length} wajah terdeteksi • ikuti instruksi di atas setiap wajah.`, '#2563eb', false);
        } else if (adaYangLolos || facesLolos) {
            setStatusAI(konfigurasi?.bahasa === 'en' ? `${facesLolos} face(s) passed liveness. Verifying…` : `${facesLolos} wajah lolos liveness. Memverifikasi…`, '#16a34a', true);
        }

        if (trackerLiveness.size && Array.from(trackerLiveness.values()).every(state => state.sudahLolos)) break;
    }

    const passedStates = Array.from(trackerLiveness.entries()).filter(([, state]) =>
        state.sudahLolos && state.qualifiedFrames >= AI_TEMPORAL_REQUIRED_FRAMES
    );
    const livenessPassed = passedStates.length > 0;
    const gesturePassed = passedStates.some(([, state]) => state.blinkDetected);
    const movementPassed = passedStates.some(([, state]) => state.movementPassed);
    const blinkDetected = passedStates.some(([, state]) => state.blinkDetected);

    if (!livenessPassed) {
        statusLiveness = 0;
        setStatusAI(
            konfigurasi?.bahasa === 'en' ? 'Liveness not completed. Follow the instruction above each face.' : 'Liveness belum selesai. Ikuti instruksi di atas setiap wajah.',
            '#d97706', false
        );
        return {
            faces: lastFaces, livenessPassed: false, movementPassed, blinkDetected, gesturePassed,
            livenessQualifiedFrames: 0, engineLivenessFrames, stableHadirIds: [], temporalRequiredFrames: AI_TEMPORAL_REQUIRED_FRAMES,
            temporalObserved: { sampledFrames: sampledFrameCount, trackedFaces: trackerLiveness.size }, livenessState: statusLiveness
        };
    }

    statusLiveness = 2;
    setStatusAI(
        konfigurasi?.bahasa === 'en' ? `Liveness passed for ${passedStates.length} face(s). Verifying names…` : `Liveness berhasil untuk ${passedStates.length} wajah. Memverifikasi nama…`,
        '#16a34a', true
    );

    const hasilIdentitas = await deteksiHumanDariFrameKecil({
        face: {
            ...(AI_LIVENESS_CONFIG.face || {}),
            detector: { ...(AI_LIVENESS_CONFIG.face?.detector || {}), maxDetected: AI_MULTI_FACE_MAX },
            description: { enabled: true, minConfidence: 0.20 }
        },
        gesture: { enabled: false }
    }, { waitForExisting: true, profile: 'identity' });
    const facesDenganEmbedding = Array.isArray(hasilIdentitas?.face) ? hasilIdentitas.face.slice(0, AI_MULTI_FACE_MAX).filter(face => face?.embedding?.length) : [];
    const passedKeys = new Set(passedStates.map(([key]) => key));
    const stableHadirIds = [];

    for (let index = 0; index < facesDenganEmbedding.length; index++) {
        const face = facesDenganEmbedding[index];
        const key = kunciTrackerWajah(face, index);
        if (!passedKeys.has(key)) continue;
        if (!verifikasiLiveness(face) || !wajahLayakUntukMatching(face)) continue;

        const match = cariKecocokan(face.embedding);
        if (!match || match.similarity < AI_MATCH_THRESHOLD) continue;
        const siswaTerjadwal = siswaReguHariIni.find(s => s.id === match.id);
        if (siswaTerjadwal) stableHadirIds.push(siswaTerjadwal.id);
    }

    statusLiveness = 3;
    return {
        faces: facesDenganEmbedding.length ? facesDenganEmbedding : lastFaces,
        livenessPassed: true, movementPassed, blinkDetected, gesturePassed,
        livenessQualifiedFrames: passedStates.reduce((sum, [, state]) => sum + state.qualifiedFrames, 0),
        engineLivenessFrames, stableHadirIds: Array.from(new Set(stableHadirIds)),
        temporalRequiredFrames: AI_TEMPORAL_REQUIRED_FRAMES,
        temporalObserved: { sampledFrames: sampledFrameCount, trackedFaces: trackerLiveness.size, passedFaces: passedStates.length },
        livenessState: statusLiveness, maxEngineLivenessScore
    };
}

function mulaiFlashLayar() {
    if (flashLayarSedangAktif) return false;
    flashLayarSedangAktif = true;
    document.body.classList.add('flash-layar-aktif');
    return true;
}

function matikanFlashLayar() {
    document.body.classList.remove('flash-layar-aktif');
    flashLayarSedangAktif = false;
}

async function lakukanFlashLayarSebelumCapture() {
    mulaiFlashLayar();

    // Tahan layar putih maksimal 500 ms. Frame kamera diambil
    // SAAT layar masih putih, bukan setelah efek dimatikan.
    await new Promise(resolve => setTimeout(resolve, 500));
}

function hentikanTimerThermalKamera() {
    if (kameraThermalTimer) {
        clearTimeout(kameraThermalTimer);
        kameraThermalTimer = null;
    }
}

function mulaiTimerThermalKamera() {
    hentikanTimerThermalKamera();
    kameraThermalStopShown = false;

    kameraThermalTimer = window.setTimeout(() => {
        kameraThermalTimer = null;

        const halKamera = document.getElementById('hal-1');
        const kameraAktif = !halKamera?.classList.contains('sembunyi') && Boolean(video?.srcObject);
        if (!kameraAktif || sudahAbsen || absensiSedangDiproses) return;

        kameraThermalStopShown = true;
        tampilkanToast(
            'Sesi kamera dihentikan setelah 60 detik untuk membantu mencegah perangkat terlalu panas. Buka kamera kembali untuk melanjutkan.',
            5200
        );
        hentikanKamera();
    }, KAMERA_THERMAL_TIMEOUT_MS);
}

async function stabilkanAutofokusKamera() {
    if (autofocusSettleInProgress) return autofocusSettleInProgress;

    autofocusSettleInProgress = (async () => {
        try {
            const track = videoTrack;
            const capabilities = track?.getCapabilities?.();
            const focusModes = Array.isArray(capabilities?.focusMode) ? capabilities.focusMode : [];

            if (track?.applyConstraints && focusModes.includes('continuous')) {
                try {
                    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
                } catch (error) {
                    console.warn('Gagal mengaktifkan continuous autofocus sebelum capture:', error);
                }
            }

            // Beri waktu beberapa frame agar lensa autofocus menstabilkan gambar.
            if (typeof video.requestVideoFrameCallback === 'function') {
                await new Promise(resolve => {
                    let count = 0;
                    const next = () => {
                        count += 1;
                        if (count >= 3) resolve();
                        else video.requestVideoFrameCallback(next);
                    };
                    video.requestVideoFrameCallback(next);
                    window.setTimeout(resolve, AUTOFOCUS_SETTLE_MS);
                });
            } else {
                await new Promise(resolve => setTimeout(resolve, AUTOFOCUS_SETTLE_MS));
            }
        } finally {
            autofocusSettleInProgress = null;
        }
    })();

    return autofocusSettleInProgress;
}

/* =====================================================
   JEPRET / ABSENSI
===================================================== */

btnJepret?.addEventListener(
    'click',
    async () => {
        // iOS/Safari: lakukan pemanggilan SpeechSynthesis secara sinkron
        // pada gesture pengguna sebelum await apa pun agar audio berikutnya
        // tidak dianggap autoplay.
        try {
            if ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
                window.speechSynthesis.cancel();
                const unlock = new SpeechSynthesisUtterance(' ');
                unlock.volume = 0;
                unlock.rate = 10;
                window.speechSynthesis.speak(unlock);
            }
        } catch (_) {}

        if (!siswaReguHariIni.length) {
            alert(t('noDutyMembers'));
            return;
        }

        if (!modelAiSiap || !faceDatabase.length) {
            alert(
                t('aiNotReady')
            );
            return;
        }

        if (aiBusy || absensiSedangDiproses) return;

        absensiSedangDiproses = true;
        aiBusy = true;
        btnJepret.disabled = true;
        btnJepret.innerHTML = '⏳';
        garisScan.classList.add('aktif');

        bunyikanSuaraJepret();

        // Beri waktu kamera menstabilkan frame sebelum analisis.
        await new Promise(resolve => setTimeout(resolve, 900));

        try {
            // Flash layar untuk kondisi sangat gelap (terutama subuh).
            // Layar tetap putih saat frame benar-benar diambil.
            await lakukanFlashLayarSebelumCapture();

            // Stabilkan autofocus sebentar agar descriptor dan bukti foto tidak diambil
            // tepat saat lensa masih berpindah titik fokus.
            await stabilkanAutofokusKamera();

            // Foto bukti diambil dari frame kamera yang sama untuk laporan guru.
            fotoAbsensiTerakhir = await ambilFrameKameraBlob();
        } catch (error) {
            console.error('Gagal mengambil foto bukti absensi:', error);
            aiBusy = false;
            absensiSedangDiproses = false;
            garisScan.classList.remove('aktif');
            btnJepret.innerHTML = IKON_KAMERA;
            btnJepret.disabled = false;
            const detail = error?.name === 'CanvasBlockedError' || error?.name === 'VirtualCameraError'
                ? (error?.message || t('cameraPrivacyError'))
                : t('proofCreateError');
            alert(detail);
            return;
        } finally {
            matikanFlashLayar();
        }

        let hadirIds = [];
        let jumlahWajah = 0;
        let wajahTerlaluJauh = 0;
        let deteksiGagal = false;
        let livenessPassed = false;
        let movementPassed = false;
        let blinkPassed = false;

        try {
            tampilkanToast('Tatap lurus ke kamera. Setelah status berubah, kedipkan mata secara alami atau gerakkan kepala sedikit.', 3200);
            const hasilDeteksi = await jalankanAsyncAman('Deteksi frame absensi', () => deteksiFrameUntukAbsensi(), null);
            if (!hasilDeteksi) throw new Error('Deteksi wajah tidak dapat diselesaikan.');
            const faces = hasilDeteksi.faces || [];
            livenessPassed = hasilDeteksi.livenessPassed;
            movementPassed = hasilDeteksi.movementPassed;
            blinkPassed = hasilDeteksi.blinkDetected;
            const gesturePassed = hasilDeteksi.gesturePassed !== false;

            if (!livenessPassed || !gesturePassed) {
                throw new Error('Verifikasi liveness gagal. Tatap lurus ke kamera, lalu kedipkan mata secara alami atau gerakkan kepala sedikit.');
            }

            jumlahWajah = faces.length;

            // Gunakan hanya identitas yang stabil pada >= 3 dari 5 frame.
            hadirIds = Array.from(new Set(hasilDeteksi.stableHadirIds || []));

            for (const wajah of faces) {
                const ukuranWajah = periksaUkuranWajah(wajah);
                if (!ukuranWajah.layak) wajahTerlaluJauh++;
                if (wajahMengalamiBacklight(wajah)) peringatkanBacklightSekali();
            }


        } catch (error) {
            deteksiGagal = true;
            console.error(
                'Deteksi absensi Human gagal:',
                error
            );

            alert(
                replaceTemplate(t('analysisError'), {
                    message: error?.message || (konfigurasi?.bahasa === 'en'
                        ? 'Make sure the camera is on and the face is clearly visible, then try again.'
                        : 'Pastikan kamera aktif dan wajah terlihat jelas, lalu coba lagi.')
                })
            );
        } finally {
            garisScan.classList.remove('aktif');
        }

        if (deteksiGagal) {
            fotoAbsensiTerakhir = null;
            garisScan.classList.remove('aktif');

            // Jangan meninggalkan tombol aktif saat stream sudah dihentikan.
            // Hidupkan kembali kamera agar pengguna dapat langsung mencoba ulang
            // tanpa reload halaman.
            hentikanKamera();
            try {
                await mulaiKamera();
            } catch (restartError) {
                console.warn('Kamera gagal dimulai ulang setelah deteksi gagal:', restartError);
                tampilkanErrorKamera(restartError);
            }

            btnJepret.innerHTML = IKON_KAMERA;
            btnJepret.disabled = !modelAiSiap || !faceDatabase.length || !video.srcObject;
            aiBusy = false;
            absensiSedangDiproses = false;
            return;
        }

        // Analisis selesai. Kamera live tidak lagi dibutuhkan sampai proses
        // berikutnya, jadi hentikan stream untuk mencegah kamera/baterai
        // tetap aktif di background.
        hentikanKamera();

        const hadir =
            siswaReguHariIni.filter(
                siswa => hadirIds.includes(siswa.id)
            );

        const tidakHadir =
            siswaReguHariIni.filter(
                siswa => !hadirIds.includes(siswa.id)
            );

        document.getElementById(
            'teksHadir'
        ).dataset.dynamic = 'true';
        document.getElementById(
            'teksHadir'
        ).innerText =
            t('resultPresent') +
            (
                hadir.length
                    ? hadir.map(s => s.name).join(', ')
                    : t('noFaceRecognized')
            );

        document.getElementById(
            'teksAbsen'
        ).dataset.dynamic = 'true';
        document.getElementById(
            'teksAbsen'
        ).innerText =
            t('resultAbsent') +
            (
                tidakHadir.length
                    ? tidakHadir.map(s => s.name).join(', ')
                    : t('allPresent')
            );

        // Tambahan informasi bila kamera tidak melihat wajah sama sekali.
        if (jumlahWajah === 0) {
            document.getElementById(
                'teksHadir'
            ).innerText =
                t('resultPresent') + t('noFaceRecognized');
        } else if (wajahTerlaluJauh > 0 && hadir.length === 0) {
            document.getElementById(
                'teksHadir'
            ).innerText =
                t('resultPresent') + t('faceTooFar');
        } else if (jumlahWajah > 0 && hadir.length === 0) {
            tampilkanToast(
                'Wajah terdeteksi, tetapi identitas belum stabil selama 3 frame. Tahan HP lebih stabil dan pastikan wajah mendapat cahaya yang cukup.',
                4200
            );
        }

        // Suara hanya diputar setelah tombol jepret ditekan, bukan saat preview.
        if ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
            try {
                window.speechSynthesis.cancel();
                const namaHadir = hadir.map(s => s.name).join(', ');
                const teksSuara = hadir.length
                    ? replaceTemplate(t('ttsDuty'), { names: namaHadir })
                    : t('ttsNoFace');
                const ucapan = new SpeechSynthesisUtterance(teksSuara);
                ucapan.lang = konfigurasi?.bahasa === 'en' ? 'en-US' : 'id-ID';
                ucapan.rate = 0.9;
                ucapan.pitch = 1;
                window.speechSynthesis.speak(ucapan);
            } catch (error) {
                console.warn('Text-to-speech tidak tersedia:', error);
            }
        }

        const waktuAbsensi = dapatkanWaktuAplikasi();
        const tanggalAbsensi = tanggalISOBaru(new Date(waktuAbsensi));
        const idLaporanBaru = buatIdLaporanUnik(waktuAbsensi);

        hasilAbsensiTerakhir = {
            id: idLaporanBaru.id,
            tanggal: tanggalAbsensi,
            waktu: waktuAbsensi,
            hari: namaHari[new Date(waktuAbsensi).getDay()],
            kelas: konfigurasi?.kelas || '',
            jurusan: konfigurasi?.jurusan || '',
            ruangan: konfigurasi?.ruangan || '',
            siswaTerjadwal: siswaReguHariIni.map(s => ({ id: s.id, name: s.name })),
            hadir: hadir.map(s => ({ id: s.id, name: s.name })),
            tidakHadir: tidakHadir.map(s => ({ id: s.id, name: s.name })),
            jumlahWajahTerdeteksi: jumlahWajah,
            livenessTerverifikasi: Boolean(livenessPassed && (movementPassed || blinkPassed)),
            photoId: idLaporanBaru.photoId,
            penyimpanan: 'IndexedDB-lokal',
            dibuatSaatOffline: navigator.onLine === false
        };

        document.getElementById(
            'popup'
        ).classList.add('muncul');

        document.getElementById(
            'overlay'
        ).classList.add('muncul');

        aiBusy = false;
        absensiSedangDiproses = false;
        btnJepret.innerHTML = IKON_KAMERA;
        btnJepret.disabled = false;
    }
);

let manualOverrideAuthorized = false;

function bukaModalKoreksiManual() {
    if (!hasilAbsensiTerakhir) return;
    const modal=document.getElementById('manualOverrideModal');
    const list=document.getElementById('manualOverrideList');
    if(!modal||!list)return;
    list.innerHTML='';
    const hadirIds=new Set((hasilAbsensiTerakhir.hadir||[]).map(s=>s.id));
    for(const siswa of siswaReguHariIni){
        const label=document.createElement('label');
        label.className='manual-override-row';
        const input=document.createElement('input');
        input.type='checkbox'; input.value=siswa.id; input.checked=hadirIds.has(siswa.id);
        const span=document.createElement('span'); span.textContent=siswa.name;
        label.append(input,span); list.appendChild(label);
    }
    modal.classList.add('muncul'); modal.setAttribute('aria-hidden','false');
}
function tutupModalKoreksiManual(){
    const modal=document.getElementById('manualOverrideModal');
    modal?.classList.remove('muncul'); modal?.setAttribute('aria-hidden','true');
    manualOverrideAuthorized=false;
    const pinInput=document.getElementById('manualOverridePin');
    if(pinInput) pinInput.value='';
}
function otorisasiKoreksiManual(){
    if (!hasilAbsensiTerakhir) return;
    bukaModalKoreksiManual();
}
async function terapkanKoreksiManual(){
    if(!hasilAbsensiTerakhir)return;

    const pinInput=document.getElementById('manualOverridePin');
    const pin=String(pinInput?.value||'').trim();
    if(!/^\d{4,8}$/.test(pin)){
        alert(t('pinInvalid'));
        pinInput?.focus();
        return;
    }
    if(!konfigurasi?.guruPinHash||!konfigurasi?.guruPinSalt){
        alert(konfigurasi?.bahasa === 'en' ? 'Set a Teacher Room PIN first.' : 'Buat PIN Ruang Guru terlebih dahulu.');
        return;
    }

    muatStatusKunciPinGuru();
    const sekarang=Date.now();
    if(sekarang<guruPinTerkunciSampai){
        alert(`Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((guruPinTerkunciSampai-sekarang)/1000)} detik.`);
        return;
    }

    const hash=await hashPinGuru(pin,konfigurasi.guruPinSalt);
    if(hash!==konfigurasi.guruPinHash){
        guruPinGagal++;
        if(guruPinGagal>=5){
            guruPinTerkunciSampai=Date.now()+30000;
            guruPinGagal=0;
            alert('Terlalu banyak percobaan. Coba lagi dalam 30 detik.');
        }else{
            alert(`${t('pinWrong')}${5-guruPinGagal}.`);
        }
        if(pinInput) pinInput.value='';
        pinInput?.focus();
        return;
    }

    // Reset kegagalan jika PIN benar
    guruPinGagal=0;
    guruPinTerkunciSampai=0;
    simpanStatusKunciPinGuru();

    manualOverrideAuthorized=true;
    const checked=new Set(Array.from(document.querySelectorAll('#manualOverrideList input[type="checkbox"]:checked')).map(i=>i.value));
    const hadir=siswaReguHariIni.filter(s=>checked.has(s.id));
    const tidakHadir=siswaReguHariIni.filter(s=>!checked.has(s.id));
    hasilAbsensiTerakhir.hadir=hadir.map(s=>({id:s.id,name:s.name}));
    hasilAbsensiTerakhir.tidakHadir=tidakHadir.map(s=>({id:s.id,name:s.name}));
    hasilAbsensiTerakhir.manualOverride=true;
    hasilAbsensiTerakhir.manualOverrideAt=Date.now();
    const elTeksHadir = document.getElementById('teksHadir');
    const elTeksAbsen = document.getElementById('teksAbsen');
    if (elTeksHadir) elTeksHadir.innerText=t('resultPresent')+(hadir.length?hadir.map(s=>s.name).join(', '):t('noFaceRecognized'));
    if (elTeksAbsen) elTeksAbsen.innerText=t('resultAbsent')+(tidakHadir.length?tidakHadir.map(s=>s.name).join(', '):t('allPresent'));
    tutupModalKoreksiManual(); tampilkanToast('Koreksi kehadiran manual diterapkan.');
}
document.getElementById('btnKoreksiManual')?.addEventListener('click',otorisasiKoreksiManual);
document.getElementById('btnBatalManualOverride')?.addEventListener('click',tutupModalKoreksiManual);
document.getElementById('btnSimpanManualOverride')?.addEventListener('click',terapkanKoreksiManual);


/* =====================================================
   OFFLINE OUTBOX / SINKRONISASI ABSENSI
===================================================== */

async function apiKirimAbsensi(laporan, fotoBlob) {
    const base = getBackendApiBaseUrl();
    if (!base) return { configured: false, synced: false };
    if (!(fotoBlob instanceof Blob) || !fotoBlob.size) {
        throw new Error('Foto bukti absensi tidak tersedia untuk sinkronisasi.');
    }

    const form = new FormData();
    form.append('id', String(laporan.id));
    form.append('tanggal', String(laporan.tanggal || ''));
    form.append('waktu', String(laporan.waktu || laporan.createdAt || Date.now()));
    form.append('kelas', String(konfigurasi?.kelas || laporan.kelas || ''));
    form.append('jurusan', String(konfigurasi?.jurusan || laporan.jurusan || ''));
    form.append('ruangan', String(konfigurasi?.ruangan || laporan.ruangan || ''));
    form.append('hadir', JSON.stringify(Array.isArray(laporan.hadir) ? laporan.hadir : []));
    form.append('tidakHadir', JSON.stringify(Array.isArray(laporan.tidakHadir) ? laporan.tidakHadir : []));
    form.append('jumlahWajah', String(Number(laporan.jumlahWajah || 0)));
    form.append('manualOverride', laporan.manualOverride ? '1' : '0');
    form.append('report', JSON.stringify(laporan));
    form.append('photo', fotoBlob, `${laporan.id}.${fotoBlob.type === 'image/webp' ? 'webp' : 'jpg'}`);

    // Backend yang dikonfigurasi perlu menyediakan POST /attendance.
    // Server harus memakai id sebagai idempotency key agar retry aman.
    const response = await fetchDenganTimeout(`${base}/attendance`, {
        method: 'POST',
        body: form,
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { configured: true, synced: true };
}

async function simpanAntreanAbsensiOffline(laporan, fotoBlob, lastError = '') {
    const id = String(laporan?.id || '');
    if (!id || !(fotoBlob instanceof Blob) || !fotoBlob.size) {
        throw new Error('Payload antrean absensi tidak lengkap.');
    }

    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        let selesai = false;
        const finish = (error = null) => {
            if (selesai) return;
            selesai = true;
            try { db.close(); } catch (_) {}
            if (error) reject(error); else resolve();
        };

        try {
            const tx = db.transaction(ATTENDANCE_OUTBOX_STORE, 'readwrite');
            tx.objectStore(ATTENDANCE_OUTBOX_STORE).put({
                id,
                laporan: JSON.parse(JSON.stringify(laporan)),
                fotoBlob,
                createdAt: Date.now(),
                attempts: 0,
                lastError: String(lastError || '')
            });
            tx.oncomplete = () => finish();
            tx.onerror = () => finish(tx.error || new Error('Gagal menyimpan antrean absensi offline.'));
            tx.onabort = () => finish(tx.error || new Error('Penyimpanan antrean absensi dibatalkan.'));
        } catch (error) {
            finish(error);
        }
    });
}

async function ambilAntreanAbsensiOffline() {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        let selesai = false;
        const finish = (value, error = null) => {
            if (selesai) return;
            selesai = true;
            try { db.close(); } catch (_) {}
            if (error) reject(error); else resolve(value);
        };
        try {
            const tx = db.transaction(ATTENDANCE_OUTBOX_STORE, 'readonly');
            const req = tx.objectStore(ATTENDANCE_OUTBOX_STORE).getAll();
            req.onsuccess = () => finish(Array.isArray(req.result) ? req.result : []);
            req.onerror = () => finish([], req.error || new Error('Gagal membaca antrean absensi.'));
            tx.onabort = () => finish([], tx.error || new Error('Pembacaan antrean absensi dibatalkan.'));
            tx.onerror = () => finish([], tx.error || new Error('Gagal membaca antrean absensi.'));
        } catch (error) {
            finish([], error);
        }
    });
}

async function hapusAntreanAbsensiOffline(id) {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(ATTENDANCE_OUTBOX_STORE, 'readwrite');
            tx.objectStore(ATTENDANCE_OUTBOX_STORE).delete(String(id));
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { const e = tx.error || new Error('Gagal menghapus antrean absensi.'); db.close(); reject(e); };
            tx.onabort = () => { const e = tx.error || new Error('Penghapusan antrean absensi dibatalkan.'); db.close(); reject(e); };
        } catch (error) {
            db.close();
            reject(error);
        }
    });
}

async function tandaiPercobaanAntreanAbsensi(item, error) {
    if (!item?.id) return;
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(ATTENDANCE_OUTBOX_STORE, 'readwrite');
            const store = tx.objectStore(ATTENDANCE_OUTBOX_STORE);
            store.put({
                ...item,
                attempts: Math.min(999, Number(item.attempts || 0) + 1),
                lastError: String(error?.message || error || '').slice(0, 500),
                updatedAt: Date.now()
            });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { const e = tx.error || new Error('Gagal memperbarui antrean absensi.'); db.close(); reject(e); };
            tx.onabort = () => { const e = tx.error || new Error('Pembaruan antrean absensi dibatalkan.'); db.close(); reject(e); };
        } catch (error) {
            db.close();
            reject(error);
        }
    });
}

let sinkronAbsensiSedangBerjalan = false;
async function sinkronkanAntreanAbsensi() {
    if (sinkronAbsensiSedangBerjalan || navigator.onLine === false) return { synced: 0, remaining: 0 };
    if (!getBackendApiBaseUrl()) return { synced: 0, remaining: 0 };

    sinkronAbsensiSedangBerjalan = true;
    let synced = 0;
    try {
        const antrean = (await ambilAntreanAbsensiOffline())
            .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
            .slice(0, 20);

        for (const item of antrean) {
            try {
                await apiKirimAbsensi(item.laporan, item.fotoBlob);
                await hapusAntreanAbsensiOffline(item.id);
                synced++;
            } catch (error) {
                console.warn('Antrean absensi belum tersinkron:', item.id, error);
                await tandaiPercobaanAntreanAbsensi(item, error).catch(() => {});
                // Jangan membanjiri server ketika jaringan masih bermasalah.
                break;
            }
        }

        if (synced > 0) {
            tampilkanToast(replaceTemplate(t('attendanceSyncSuccess'), { count: synced }), 3200);
        }
        const sisa = await ambilAntreanAbsensiOffline();
        return { synced, remaining: sisa.length };
    } catch (error) {
        console.warn('Sinkronisasi antrean absensi gagal:', error);
        return { synced, remaining: -1 };
    } finally {
        sinkronAbsensiSedangBerjalan = false;
    }
}


/* =====================================================
   SIMPAN ABSEN
===================================================== */
// Absensi saat ini disimpan secara lokal di IndexedDB, jadi tidak ada
// request HTTP per frame yang perlu di-throttle. Idempotency guard tetap
// dipasang pada batas penyimpanan untuk mencegah reportId tersimpan ganda.

document.getElementById(
    'btnSimpan'
).addEventListener(
    'click',
    async () => {

        const tombolSimpan = document.getElementById('btnSimpan');

        if (!hasilAbsensiTerakhir) {
            alert(t('photoSaveDataError'));
            return;
        }

        if (tombolSimpan.disabled) return;

        tombolSimpan.disabled = true;
        tombolSimpan.textContent = t('savingReport');

        try {
            const offlineSaatSimpan = navigator.onLine === false;
            await simpanLaporanAbsensi(hasilAbsensiTerakhir, fotoAbsensiTerakhir);

            let sinkronTertunda = false;
            const backendConfigured = Boolean(getBackendApiBaseUrl());
            if (backendConfigured) {
                if (offlineSaatSimpan) {
                    await simpanAntreanAbsensiOffline(hasilAbsensiTerakhir, fotoAbsensiTerakhir, 'offline saat menyimpan');
                    sinkronTertunda = true;
                } else {
                    try {
                        await apiKirimAbsensi(hasilAbsensiTerakhir, fotoAbsensiTerakhir);
                    } catch (syncError) {
                        await simpanAntreanAbsensiOffline(hasilAbsensiTerakhir, fotoAbsensiTerakhir, syncError?.message || syncError);
                        sinkronTertunda = true;
                        console.warn('Pengiriman server gagal; absensi masuk antrean offline:', syncError);
                    }
                }
            }

            if (sinkronTertunda) {
                tampilkanToast(
                    backendConfigured
                        ? t('attendanceQueuedForSync')
                        : t('offlineAttendanceSaved'),
                    4600
                );
            } else if (offlineSaatSimpan) {
                tampilkanToast(t('offlineAttendanceSaved'), 4200);
            }

            sudahAbsen = true;
            hentikanKamera();

            document.getElementById('popup')?.classList.remove('muncul');
            document.getElementById('overlay')?.classList.remove('muncul');

            setTimeout(() => {
                document.getElementById('hal-1')?.classList.add('sembunyi');
                document.getElementById('hal-3')?.classList.remove('sembunyi');
            }, 300);

        } catch (error) {
            console.error('Gagal menyimpan laporan absensi:', error);
            alert(
                replaceTemplate(t('reportSaveFailDetail'), {
                    message: error?.message || (konfigurasi?.bahasa === 'en'
                        ? 'Check browser storage and try again.'
                        : 'Periksa penyimpanan browser lalu coba lagi.')
                })
            );
        } finally {
            tombolSimpan.disabled = false;
            tombolSimpan.textContent = t('resultSave');
        }
    }
);



/* =====================================================
   KELUAR
===================================================== */

document.getElementById(
    'btnKeluar'
).addEventListener(
    'click',
    () => {

        window.close();


        setTimeout(
            () => {

                window.location.href =
                    'about:blank';

            },
            100
        );

    }
);


/* =====================================================
   RESET SEMUA DATA
===================================================== */

async function resetSemuaData() {

    const yakin =
        confirm(
            t('resetWarningTitle') + '\n\n' +
            t('resetWarningBody') + '\n\n' +
            t('resetContinue')
        );


    if (!yakin) return;


    const yakin2 =
        confirm(
            t('resetFacesBody') + '\n\n' +
            t('resetConfirm')
        );


    if (!yakin2) return;


    try {
        localStorage.removeItem(STORAGE_KEY);

        /* Saran dan metadata foto bukti juga ikut dihapus saat
           pengguna memilih 'Hapus Semua Data'. */
        localStorage.removeItem(SARAN_KEY);
    } catch (error) {
        console.warn('LocalStorage tidak dapat dibersihkan saat reset:', error);
    }

    await kosongkanDatabase();

    hasilAbsensiTerakhir = null;
    fotoAbsensiTerakhir = null;


    konfigurasi =
        null;

    semuaSiswa =
        [];


    alert(t('resetSuccess'));


    location.reload();

}


/* =====================================================
   KOTAK SARAN
   (disimpan 100% di localStorage perangkat ini saja —
   tidak ada permintaan internet sama sekali di sini,
   supaya tidak menambah boros data. koneksi internet
   di app ini hanya dipakai untuk memuat model AI foto.)
===================================================== */

const SARAN_KEY =
    'absensi_piket_saran_v2';



const DAFTAR_KATA_KASAR = [

    'anjing', 'anjg', 'anjrit', 'ajg',
    'bangsat', 'bgst', 'bajingan',
    'babi', 'kontol', 'kntl',
    'memek', 'ngentot', 'ngentod', 'pepek',
    'jancok', 'jancuk', 'asu',
    'tolol', 'goblok', 'goblog', 'idiot',
    'bego', 'tai', 'tahi',
    'sialan', 'brengsek', 'keparat',
    'kampret', 'sundal', 'pelacur', 'lonte',
    'fuck', 'shit', 'bitch', 'asshole',
    'bastard', 'dick', 'pussy'

];


let tabSaranAktif =
    'guru';

let halamanAsalSaran =
    'hal-1';


function bersihkanTeksUntukCek(teks) {

    return (teks || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/(.)\1{2,}/g, '$1$1');

}


function mengandungKataKasar(teks) {

    const bersih =
        bersihkanTeksUntukCek(teks);

    return DAFTAR_KATA_KASAR.some(
        kata => bersih.includes(kata)
    );

}


function ambilSemuaSaran() {

    try {

        let raw =
            localStorage.getItem(SARAN_KEY);

        /* Migrasi saran lama agar penambahan foto tidak menghilangkan
           saran yang sudah tersimpan sebelum pembaruan ini. */
        if (!raw) {
            const lama =
                localStorage.getItem('absensi_piket_saran_v1');
            if (lama) {
                setLocalStorageSafe(SARAN_KEY, lama, {
                    preserveKeys: [STORAGE_KEY, GURU_PIN_LOCK_KEY, GURU_PIN_FAIL_KEY]
                });
                raw = lama;
            }
        }

        const data =
            JSON.parse(raw || 'null');

        if (
            data &&
            Array.isArray(data.guru) &&
            Array.isArray(data.murid)
        ) {

            return data;

        }

    } catch (error) {}

    return {
        guru: [],
        murid: []
    };

}


function simpanSemuaSaran(data) {
    try {
        if (!setLocalStorageSafe(SARAN_KEY, JSON.stringify(data), {
            preserveKeys: [STORAGE_KEY, GURU_PIN_LOCK_KEY, GURU_PIN_FAIL_KEY]
        })) {
            const error = new Error('Penyimpanan saran lokal penuh.');
            error.name = 'StorageQuotaError';
            throw error;
        }
        return true;
    } catch (error) {
        console.error('Gagal menyimpan saran ke localStorage:', error);
        throw error;
    }
}


async function simpanFotoSaranDB(id, blob) {

    const db =
        await bukaDatabase();

    return new Promise(
        (resolve, reject) => {

            let selesai = false;

            const selesaiDengan =
                (error = null) => {
                    if (selesai) return;
                    selesai = true;

                    try {
                        db.close();
                    } catch (_) {}

                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };

            try {
                const tx =
                    db.transaction(
                        SARAN_PHOTO_STORE,
                        'readwrite'
                    );

                tx.objectStore(
                    SARAN_PHOTO_STORE
                ).put({
                    id: id,
                    blob: blob
                });

                tx.oncomplete =
                    () => selesaiDengan();

                tx.onerror =
                    () => selesaiDengan(
                        tx.error || new Error('Gagal menyimpan foto bukti.')
                    );

                tx.onabort =
                    () => selesaiDengan(
                        tx.error || new Error('Penyimpanan foto dibatalkan.')
                    );
            } catch (error) {
                selesaiDengan(error);
            }

        }
    );

}


async function ambilFotoSaranDB(id) {

    if (!id) return null;

    const db =
        await bukaDatabase();

    return new Promise(
        (resolve, reject) => {

            let selesai = false;

            const selesaiDengan =
                (nilai, error = null) => {
                    if (selesai) return;
                    selesai = true;

                    try {
                        db.close();
                    } catch (_) {}

                    if (error) {
                        reject(error);
                    } else {
                        resolve(nilai);
                    }
                };

            try {
                const tx =
                    db.transaction(
                        SARAN_PHOTO_STORE,
                        'readonly'
                    );

                const request =
                    tx.objectStore(
                        SARAN_PHOTO_STORE
                    ).get(id);

                request.onsuccess =
                    () => selesaiDengan(
                        request.result
                            ? request.result.blob
                            : null
                    );

                request.onerror =
                    () => selesaiDengan(
                        null,
                        request.error || new Error('Gagal membaca foto bukti.')
                    );

                tx.onerror =
                    () => selesaiDengan(
                        null,
                        tx.error || new Error('Gagal membaca database foto.')
                    );

                tx.onabort =
                    () => selesaiDengan(
                        null,
                        tx.error || new Error('Pembacaan foto dibatalkan.')
                    );
            } catch (error) {
                selesaiDengan(null, error);
            }

        }
    );

}


async function hapusFotoSaranDB(id) {

    if (!id) return;

    const db =
        await bukaDatabase();

    return new Promise(
        (resolve, reject) => {

            let selesai = false;

            const selesaiDengan =
                (error = null) => {
                    if (selesai) return;
                    selesai = true;

                    try {
                        db.close();
                    } catch (_) {}

                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };

            try {
                const tx =
                    db.transaction(
                        SARAN_PHOTO_STORE,
                        'readwrite'
                    );

                tx.objectStore(
                    SARAN_PHOTO_STORE
                ).delete(id);

                tx.oncomplete =
                    () => selesaiDengan();

                tx.onerror =
                    () => selesaiDengan(
                        tx.error || new Error('Gagal menghapus foto bukti.')
                    );

                tx.onabort =
                    () => selesaiDengan(
                        tx.error || new Error('Penghapusan foto dibatalkan.')
                    );
            } catch (error) {
                selesaiDengan(error);
            }

        }
    );

}

function kompresFotoSaran(file) {

    return new Promise(
        (resolve, reject) => {

            if (!file || !file.type.startsWith('image/')) {
                reject(new Error(t('fileMustBeImage')));
                return;
            }

            const reader =
                new FileReader();

            reader.onerror =
                () => reject(new Error(konfigurasi?.bahasa === 'en' ? 'The photo could not be read.' : 'Foto gagal dibaca.'));

            reader.onload =
                event => {

                    const img =
                        new Image();

                    img.onload =
                        () => {

                            const batas = 1280;
                            const skala =
                                Math.min(
                                    1,
                                    batas / Math.max(img.width, img.height)
                                );

                            const width =
                                Math.max(1, Math.round(img.width * skala));

                            const height =
                                Math.max(1, Math.round(img.height * skala));

                            const canvas =
                                document.createElement('canvas');

                            canvas.width = width;
                            canvas.height = height;

                            const ctx =
                                canvas.getContext('2d', { alpha: false });

                            if (!ctx) {
                                reject(new Error(konfigurasi?.bahasa === 'en' ? 'This browser does not support photo processing.' : 'Browser tidak mendukung pemrosesan foto.'));
                                return;
                            }

                            ctx.fillStyle = '#ffffff';
                            ctx.fillRect(0, 0, width, height);
                            ctx.drawImage(img, 0, 0, width, height);

                            const selesai = (blob, fallbackJpeg = false) => {
                                if (!blob) {
                                    reject(new Error(konfigurasi?.bahasa === 'en' ? 'The photo could not be compressed.' : 'Foto gagal dikompres.'));
                                    return;
                                }
                                resolve(blob);
                            };

                            try {
                                canvas.toBlob(
                                    blob => {
                                        if (blob && blob.type === 'image/webp') {
                                            selesai(blob);
                                        } else {
                                            canvas.toBlob(
                                                jpeg => selesai(jpeg, true),
                                                'image/jpeg',
                                                0.68
                                            );
                                        }
                                    },
                                    'image/webp',
                                    0.55
                                );
                            } catch (error) {
                                console.warn('WebP saran tidak tersedia, memakai JPEG:', error);
                                canvas.toBlob(
                                    jpeg => selesai(jpeg, true),
                                    'image/jpeg',
                                    0.68
                                );
                            }

                        };

                    img.onerror =
                        () => reject(new Error(konfigurasi?.bahasa === 'en' ? 'This photo format cannot be processed.' : 'Format foto tidak dapat diproses.'));

                    img.src = event.target.result;

                };

            reader.readAsDataURL(file);

        }
    );

}


function resetInputFotoSaran(peran) {
    const input = document.getElementById(peran === 'guru' ? 'fotoSaranGuru' : 'fotoSaranMurid');
    const preview = document.getElementById(peran === 'guru' ? 'previewFotoSaranGuru' : 'previewFotoSaranMurid');
    if (input) input.value = '';
    if (preview) {
        preview.querySelectorAll('[data-object-url]').forEach(el => {
            const url = el.getAttribute('data-object-url');
            if (url) {
                try { URL.revokeObjectURL(url); } catch (_) {}
                activeObjectURLs.delete(url);
            }
        });
        preview.innerHTML = '';
        preview.style.display = 'none';
    }
}


function tampilkanPreviewFotoSaran(peran, blob) {
    const preview = document.getElementById(peran === 'guru' ? 'previewFotoSaranGuru' : 'previewFotoSaranMurid');
    if (!preview) return;

    // Hapus preview lama tanpa mengosongkan file input; kirimSaran() masih
    // membutuhkan file input untuk memastikan lampiran tetap tersedia.
    preview.querySelectorAll('[data-object-url]').forEach(el => {
        const oldUrl = el.getAttribute('data-object-url');
        if (oldUrl) {
            try { URL.revokeObjectURL(oldUrl); } catch (_) {}
            activeObjectURLs.delete(oldUrl);
        }
    });
    preview.innerHTML = '';

    const img = document.createElement('img');
    const url = URL.createObjectURL(blob);
    activeObjectURLs.add(url);
    img.src = url;
    img.alt = t('photoPreviewAlt');
    img.setAttribute('data-object-url', url);
    img.onload = () => {
        // Setelah gambar selesai dimuat, browser tidak lagi membutuhkan
        // object URL untuk decoding gambar. Lepaskan URL agar memori tidak
        // menumpuk, tetapi jangan hapus elemen preview-nya.
        try { URL.revokeObjectURL(url); } catch (_) {}
        activeObjectURLs.delete(url);
        img.removeAttribute('data-object-url');
    };
    img.onerror = () => {
        try { URL.revokeObjectURL(url); } catch (_) {}
        activeObjectURLs.delete(url);
    };

    const hapus = document.createElement('button');
    hapus.type = 'button';
    hapus.className = 'btn-hapus-foto-saran';
    hapus.textContent = t('removeProofPhoto');
    hapus.onclick = () => resetInputFotoSaran(peran);

    preview.append(img, hapus);
    preview.style.display = 'block';
}


function pasangEventFotoSaran(peran) {

    const input =
        document.getElementById(
            peran === 'guru'
                ? 'fotoSaranGuru'
                : 'fotoSaranMurid'
        );

    if (!input) return;

    input.addEventListener(
        'change',
        async () => {

            const file =
                input.files && input.files[0];

            if (!file) {
                resetInputFotoSaran(peran);
                return;
            }

            if (!file.type.startsWith('image/')) {
                alert(t('fileMustBeImage'));
                resetInputFotoSaran(peran);
                return;
            }

            if (file.size > 15 * 1024 * 1024) {
                alert(t('sizeTooLarge'));
                resetInputFotoSaran(peran);
                return;
            }

            try {
                const blob =
                    await kompresFotoSaran(file);

                tampilkanPreviewFotoSaran(
                    peran,
                    blob
                );

            } catch (error) {
                console.error(
                    'Foto saran:',
                    error
                );
                alert(
                    konfigurasi?.bahasa === 'en' ? 'The proof photo could not be processed. Pick another photo.' : 'Foto bukti tidak dapat diproses. Silakan pilih foto lain.'
                );
                resetInputFotoSaran(peran);
            }

        }
    );

}


function pindahTabSaran(tab) {

    tabSaranAktif = tab;

    document.querySelectorAll(
        '.tab-btn'
    ).forEach(
        btn => {
            btn.classList.toggle(
                'aktif',
                btn.dataset.tab === tab
            );
        }
    );

    document.getElementById(
        'formSaranGuru'
    ).classList.toggle(
        'tab-hilang',
        tab !== 'guru'
    );

    document.getElementById(
        'formSaranMurid'
    ).classList.toggle(
        'tab-hilang',
        tab !== 'murid'
    );

}


async function renderSaran(peran) {

    const container =
        document.getElementById(
            peran === 'guru'
                ? 'daftarSaranGuru'
                : 'daftarSaranMurid'
        );

    if (!container) return;

    let daftar = [];
    try {
        const remote = await apiAmbilSaran(peran);
        if (Array.isArray(remote)) {
            daftar = remote;
        } else {
            const semuaSaranLokal = ambilSemuaSaran();
            daftar = semuaSaranLokal[peran] || [];
        }
    } catch (error) {
        console.warn('Backend saran tidak tersedia, memakai data lokal:', error);
        updateBackendStatusText();
        const semuaSaranLokal = ambilSemuaSaran();
        daftar = semuaSaranLokal[peran] || [];
    }

    container.innerHTML = '';

    if (daftar.length === 0) {
        buatPesanKosong(container, 'saran-kosong', t('emptySuggestions'));
        return;
    }

    daftar.forEach(
        item => {

            const div =
                document.createElement('div');

            div.className =
                'saran-item';

            const nama =
                document.createElement('div');

            nama.className =
                'saran-nama';

            nama.innerText =
                item.nama || (peran === 'guru' ? t('roleTeacher') : t('roleStudent'));

            const waktu =
                document.createElement('div');

            waktu.className =
                'saran-waktu';

            waktu.innerText =
                new Date(item.waktu).toLocaleString(konfigurasi?.bahasa === 'en' ? 'en-US' : 'id-ID');

            const teks =
                document.createElement('div');

            teks.className =
                'saran-teks';

            teks.innerText =
                item.teks || '';

            div.appendChild(nama);
            div.appendChild(waktu);
            div.appendChild(teks);

            if (item.photoId || item.photoUrl) {

                const foto = document.createElement('img');
                foto.className = 'saran-bukti-foto';
                foto.alt = t('proofPhoto');
                foto.loading = 'lazy';

                if (item.photoUrl) {
                    foto.src = item.photoUrl;
                } else {
                    ambilFotoSaranDB(item.photoId)
                        .then(blob => {
                            if (!blob) return;
                            const url = URL.createObjectURL(blob);
                            foto.src = url;
                            const cleanup = () => {
                                try { URL.revokeObjectURL(url); } catch (_) {}
                            };
                            foto.addEventListener('load', cleanup, { once: true });
                            foto.addEventListener('error', cleanup, { once: true });
                        })
                        .catch(error => {
                            console.warn('Foto bukti tidak dapat dimuat:', error);
                        });
                }

                foto.title = t('proofPhoto');
                div.appendChild(foto);

                const keterangan = document.createElement('div');
                keterangan.className = 'saran-foto-keterangan';
                keterangan.textContent = t('proofAttached');
                div.appendChild(keterangan);
            }

            container.appendChild(div);

        }
    );

}


async function renderSemuaSaran() {

    await Promise.all([
        renderSaran('guru'),
        renderSaran('murid')
    ]);

}


async function kirimSaran(peran) {

    const namaInput =
        document.getElementById(
            peran === 'guru'
                ? 'namaSaranGuru'
                : 'namaSaranMurid'
        );

    const teksInput =
        document.getElementById(
            peran === 'guru'
                ? 'teksSaranGuru'
                : 'teksSaranMurid'
        );

    const fotoInput =
        document.getElementById(
            peran === 'guru'
                ? 'fotoSaranGuru'
                : 'fotoSaranMurid'
        );

    const nama =
        namaInput.value.trim();

    const teks =
        teksInput.value.trim();

    if (!teks) {
        alert(t('suggestionEmptyError'));
        return;
    }

    if (
        mengandungKataKasar(teks) ||
        mengandungKataKasar(nama)
    ) {
        alert(t('suggestionInappropriate'));
        return;
    }

    let fotoBlob = null;

    if (
        fotoInput &&
        fotoInput.files &&
        fotoInput.files[0]
    ) {
        try {
            fotoBlob =
                await kompresFotoSaran(
                    fotoInput.files[0]
                );
        } catch (error) {
            console.error(
                'Gagal memproses foto saran:',
                error
            );
            alert(t('suggestionPhotoProcessError'));
            return;
        }
    }

    const item = {
        id: buatId(),
        nama:
            nama ||
            (peran === 'guru' ? 'Guru' : 'Siswa'),
        teks: teks,
        waktu: Date.now(),
        peran,
        tersinkronServer: false
    };

    try {
        const hasilServer = await apiKirimSaran(item, fotoBlob, peran);
        item.tersinkronServer = Boolean(hasilServer?.synced);
    } catch (error) {
        console.warn('Saran belum tersinkron ke backend:', error);
        updateBackendStatusText();
    }

    const semuaSaran = ambilSemuaSaran();

    if (fotoBlob) {
        item.photoId =
            'saranfoto_' +
            item.id;

        try {
            await simpanFotoSaranDB(
                item.photoId,
                fotoBlob
            );
        } catch (error) {
            console.error(
                'Gagal menyimpan foto bukti:',
                error
            );
            alert(t('suggestionPhotoSaveError'));
            return;
        }
    }

    semuaSaran[peran].unshift(item);

    try {
        simpanSemuaSaran(semuaSaran);
    } catch (error) {
        if (item.photoId) {
            await hapusFotoSaranDB(item.photoId).catch(() => {});
        }
        console.error(
            'Gagal menyimpan data saran:',
            error
        );
        alert(t('suggestionSaveError'));
        return;
    }

    namaInput.value = '';
    teksInput.value = '';
    resetInputFotoSaran(peran);

    await renderSaran(peran);

    alert(
        fotoBlob ? t('suggestionThanksWithPhoto') : t('suggestionThanks')
    );

}


pasangEventFotoSaran('guru');
pasangEventFotoSaran('murid');


function bukaKotakSaran(asal) {

    halamanAsalSaran =
        asal || 'hal-1';


    if (
        halamanAsalSaran === 'hal-1'
    ) {

        hentikanKamera();

    }


    document.getElementById(
        halamanAsalSaran
    ).classList.add(
        'sembunyi'
    );


    document.getElementById(
        'halSaran'
    ).classList.remove(
        'sembunyi'
    );


    pindahTabSaran('guru');

    renderSemuaSaran();

}


function tutupKotakSaran() {
    // Bersihkan teks, file input, preview, dan ObjectURL agar draft lama
    // tidak ikut terlihat oleh pengguna berikutnya pada perangkat yang sama.
    document.querySelectorAll('#halSaran input[type="text"], #halSaran textarea').forEach(input => {
        input.value = '';
    });
    document.querySelectorAll('#halSaran input[type="file"]').forEach(input => {
        input.value = '';
    });
    document.querySelectorAll('#halSaran .saran-preview-foto').forEach(preview => {
        preview.querySelectorAll('[data-object-url]').forEach(el => {
            const url = el.getAttribute('data-object-url');
            if (url) {
                try { URL.revokeObjectURL(url); } catch (_) {}
                activeObjectURLs.delete(url);
            }
        });
        preview.innerHTML = '';
        preview.style.display = 'none';
    });

    document.getElementById('halSaran')?.classList.add('sembunyi');
    document.getElementById(halamanAsalSaran)?.classList.remove('sembunyi');

    if (halamanAsalSaran === 'hal-1') {
        mulaiKamera().catch(error => {
            console.error('Gagal menyalakan kamera setelah menutup Kotak Saran:', error);
            tampilkanErrorKamera(error);
        });
    }
}


/* =====================================================
   CEGAH KELUAR
   (Catatan: browser tidak mengizinkan website benar-benar
   mengunci pengguna di dalam tab/app — ini hanya
   menampilkan dialog konfirmasi bawaan browser sebelum
   halaman ditutup/direfresh, selama absen belum selesai.)
===================================================== */

window.addEventListener(
    'beforeunload',
    event => {

        const halKameraAktif = !document.getElementById('hal-1')?.classList.contains('sembunyi');

        // Hentikan kamera secepat mungkin sebelum dokumen ditutup/reload.
        if (halKameraAktif && video?.srcObject) {
            hentikanKamera();
        }

        if (!sudahAbsen && halKameraAktif) {
            event.preventDefault();
            event.returnValue =
                'Absen piket belum selesai. Yakin ingin keluar?';
        }
    }
);

// pagehide mencakup navigasi/back-forward cache di sejumlah browser mobile.
// Ini menjadi lapisan cleanup tambahan selain visibilitychange/beforeunload.
window.addEventListener('pagehide', () => {
    if (video?.srcObject) hentikanKamera();
    else void lepaskanWakeLock();
    bersihkanGuruBlobUrls?.();
});


/* =====================================================
   KEYBOARD UX MODAL
   Tombol Escape menutup modal yang sedang terbuka agar navigasi
   keyboard di PC/laptop tetap cepat dan intuitif.
===================================================== */

document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;

    document.querySelectorAll('.modal.muncul').forEach(modal => {
        modal.classList.remove('muncul');
        modal.setAttribute('aria-hidden', 'true');
    });

    // Beberapa overlay khusus bukan memakai class .modal. Tutup juga
    // overlay foto guru dan dialog error kamera jika sedang terbuka.
    const guruFotoModal = document.getElementById('guruFotoModal');
    const guruFotoOverlay = document.getElementById('guruFotoOverlay');
    if (guruFotoModal?.classList.contains('muncul') || guruFotoOverlay?.classList.contains('muncul')) {
        tutupFotoGuru();
    }

    if (modalErrorKamera?.classList.contains('muncul')) {
        modalErrorKamera.classList.remove('muncul');
    }
});

window.addEventListener('beforeunload', () => {
    try { bersihkanSemuaObjectURLs(); } catch (_) {}
}, { passive: true });

let cameraViewportSyncTimer = null;
let cameraViewportSyncRaf = null;
function jadwalkanSinkronisasiViewportKamera() {
    if (cameraViewportSyncTimer) window.clearTimeout(cameraViewportSyncTimer);
    cameraViewportSyncTimer = window.setTimeout(() => {
        cameraViewportSyncTimer = null;
        if (cameraViewportSyncRaf) cancelAnimationFrame(cameraViewportSyncRaf);
        cameraViewportSyncRaf = requestAnimationFrame(() => {
            cameraViewportSyncRaf = null;
            adaptCameraSize();
            sinkronkanCanvasAIPadaResize();
        });
    }, 250);
}

function saatResizeKameraViewport() {
    jadwalkanSinkronisasiViewportKamera();
}

function saatOrientasiKameraBerubah() {
    jadwalkanSinkronisasiViewportKamera();
}

window.addEventListener('resize', saatResizeKameraViewport, { passive: true });
window.addEventListener('orientationchange', saatOrientasiKameraBerubah, { passive: true });

/* =====================================================
   DETEKSI PINDAH TAB / APLIKASI LAIN
   (Saat siswa membuka app lain sebelum absen selesai:
   kamera dihentikan otomatis demi privasi & baterai,
   lalu saat kembali, kamera dinyalakan ulang dan siswa
   diingatkan untuk melanjutkan. Ini hanya pengingat,
   bukan penguncian — browser memang sengaja tidak
   mengizinkan website memblokir pengguna berpindah app.)
===================================================== */

document.addEventListener(
    'visibilitychange',
    () => {

        const halKameraElemen =
            document.getElementById('hal-1');

        const halKameraAktif =
            halKameraElemen &&
            !halKameraElemen.classList.contains('sembunyi');


        if (document.hidden) {

            if (
                !sudahAbsen &&
                halKameraAktif &&
                video &&
                video.srcObject
            ) {

                hentikanKamera();

                kameraDijedaKarenaPindah =
                    true;

            }

        } else {

            if (!kameraDijedaKarenaPindah && !sudahAbsen && halKameraAktif && video?.srcObject) {
                void jagaLayarTetapMenyala();
            }

            if (
                kameraDijedaKarenaPindah &&
                !sudahAbsen &&
                halKameraAktif
            ) {

                kameraDijedaKarenaPindah =
                    false;

                if (!kameraDiizinkanHariIni()) return;

                mulaiKamera().catch(
                    error => {

                        console.error(
                            'Gagal menyalakan ulang kamera:',
                            error
                        );
                        tampilkanErrorKamera(error);

                    }
                );

                alert(t('resumeAttendance'));

            }

        }

    }
);


/* =====================================================
   CEGAH SELEKSI TEKS & MENU KLIK-KANAN
   (lapisan cadangan selain CSS di atas, untuk browser/
   WebView yang kurang patuh terhadap user-select. Kolom
   input/textarea tetap dikecualikan.)
===================================================== */

function elemenBolehDitandai(target) {

    if (!target) return false;

    const tag =
        target.tagName;

    return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        target.isContentEditable
    );

}


document.addEventListener(
    'selectstart',
    event => {

        if (
            !elemenBolehDitandai(
                event.target
            )
        ) {

            event.preventDefault();

        }

    }
);


document.addEventListener(
    'contextmenu',
    event => {

        if (
            !elemenBolehDitandai(
                event.target
            )
        ) {

            event.preventDefault();

        }

    }
);


/* =====================================================
   LAPORAN ABSENSI / RUANG GURU
===================================================== */

function tanggalISOBaru(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function tanggalDariISO(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

function awalMingguSenin(date = new Date(), offsetMinggu = 0) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const hari = d.getDay();
    const jarakKeSenin = hari === 0 ? 6 : hari - 1;
    d.setDate(d.getDate() - jarakKeSenin + offsetMinggu * 7);
    return d;
}

function formatTanggalGuru(iso) {
    return tanggalDariISO(iso).toLocaleDateString(konfigurasi?.bahasa === 'en' ? 'en-US' : 'id-ID', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

function formatWaktuGuru(timestamp) {
    return new Date(timestamp).toLocaleTimeString(konfigurasi?.bahasa === 'en' ? 'en-US' : 'id-ID', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

async function simpanFotoAbsensiDB(id, blob) {
    if (!blob) throw new Error('Foto bukti absensi kosong.');
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction('attendancePhotos', 'readwrite');
            tx.objectStore('attendancePhotos').put({ id, blob, updatedAt: Date.now() });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { const e = tx.error || new Error('Gagal menyimpan foto laporan.'); db.close(); reject(e); };
            tx.onabort = () => { const e = tx.error || new Error('Penyimpanan foto laporan dibatalkan.'); db.close(); reject(e); };
        } catch (e) {
            db.close();
            reject(e);
        }
    });
}

async function ambilFotoAbsensiDB(id) {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction('attendancePhotos', 'readonly');
            const req = tx.objectStore('attendancePhotos').get(id);
            req.onsuccess = () => resolve(req.result?.blob || null);
            req.onerror = () => reject(req.error || new Error('Gagal membaca foto laporan.'));
            tx.oncomplete = () => db.close();
            tx.onerror = () => db.close();
            tx.onabort = () => { db.close(); reject(tx.error || new Error('Pembacaan foto laporan dibatalkan.')); };
        } catch (e) {
            db.close();
            reject(e);
        }
    });
}

async function simpanLaporanAbsensi(laporan, fotoBlob) {
    if (!laporan?.tanggal) throw new Error('Tanggal laporan tidak valid.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(laporan.tanggal)) throw new Error('Format tanggal laporan tidak valid.');
    if (!laporanIdValid(laporan)) throw new Error('ID laporan tidak valid.');
    if (!fotoBlob || !(fotoBlob instanceof Blob) || !fotoBlob.size) throw new Error('Foto bukti absensi belum tersedia.');

    const reportId = String(laporan.id);
    if (laporanSedangDisimpan.has(reportId)) {
        const error = new Error('Laporan absensi ini sedang atau sudah diproses.');
        error.name = 'DuplicateAttendanceSaveError';
        throw error;
    }
    laporanSedangDisimpan.add(reportId);

    let db;
    try {
        db = await bukaDatabase();
    } catch (error) {
        laporanSedangDisimpan.delete(reportId);
        throw error;
    }

    let simpanBerhasil = false;
    return new Promise((resolve, reject) => {
        let selesai = false;
        const selesaiDengan = error => {
            if (selesai) return;
            selesai = true;
            db.close();
            if (error) {
                if (!simpanBerhasil) laporanSedangDisimpan.delete(reportId);
                reject(error);
            } else {
                simpanBerhasil = true;
                resolve();
            }
        };

        try {
            const tx = db.transaction(['attendanceRecords', 'attendancePhotos'], 'readwrite');
            tx.objectStore('attendancePhotos').put({
                id: laporan.photoId,
                blob: fotoBlob,
                updatedAt: Date.now()
            });
            tx.objectStore('attendanceRecords').put({
                ...laporan,
                id: laporan.id,
                photoId: laporan.photoId
            });
            tx.oncomplete = () => selesaiDengan();
            tx.onerror = () => selesaiDengan(tx.error || new Error('Gagal menyimpan laporan absensi.'));
            tx.onabort = () => selesaiDengan(tx.error || new Error('Penyimpanan laporan absensi dibatalkan.'));
        } catch (error) {
            if (!simpanBerhasil) laporanSedangDisimpan.delete(reportId);
            const quotaError = error?.name === 'QuotaExceededError'
                || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
                || /quota|storage|disk space/i.test(String(error?.message || ''));
            if (quotaError) {
                selesaiDengan(Object.assign(
                    new Error(konfigurasi?.bahasa === 'en'
                        ? 'Local storage is full. Older attendance reports should be cleared before saving a new photo.'
                        : 'Penyimpanan lokal HP penuh. Hapus laporan absensi lama sebelum menyimpan foto baru.'),
                    { name: 'StorageQuotaError', cause: error }
                ));
            } else {
                selesaiDengan(error);
            }
        }
    });
}

async function ambilSemuaLaporanAbsensi() {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction('attendanceRecords', 'readonly');
            const req = tx.objectStore('attendanceRecords').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error('Gagal membaca laporan absensi.'));
            tx.oncomplete = () => db.close();
            tx.onerror = () => db.close();
            tx.onabort = () => { db.close(); reject(tx.error || new Error('Pembacaan laporan dibatalkan.')); };
        } catch (e) {
            db.close();
            reject(e);
        }
    });
}

async function hapusLaporanAbsensiDB(id) {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(['attendanceRecords', 'attendancePhotos'], 'readwrite');
            tx.objectStore('attendanceRecords').delete(id);
            tx.objectStore('attendancePhotos').delete(`foto_absensi_${id.replace('absensi_', '')}`);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { const e = tx.error || new Error('Gagal menghapus laporan.'); db.close(); reject(e); };
            tx.onabort = () => { const e = tx.error || new Error('Penghapusan laporan dibatalkan.'); db.close(); reject(e); };
        } catch (e) {
            db.close();
            reject(e);
        }
    });
}

async function ambilFrameKameraBlob() {
    if (!video || !video.videoWidth || !video.videoHeight) {
        throw new Error('Frame kamera belum siap.');
    }

    /*
     * Gunakan ukuran INTRINSIK video, bukan clientWidth/clientHeight.
     * Ini mencegah foto menjadi gepeng/melar dan menjaga rasio asli
     * frame kamera. Preview yang dicerminkan hanya mengubah CSS;
     * drawImage() di sini tetap mengambil orientasi frame asli.
     */
    const maxSide = 1280;
    const scale = Math.min(
        1,
        maxSide / Math.max(video.videoWidth, video.videoHeight)
    );

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
        throw new Error('Canvas kamera tidak tersedia.');
    }

    // Snapshot bersih: ambil langsung dari <video>, bukan canvas overlay AI.
    ctx.drawImage(
        video,
        0,
        0,
        canvas.width,
        canvas.height
    );

    // Burn-in timestamp ke foto bukti. Ini hanya lapisan audit tambahan;
    // bukan pengganti validasi server atau anti-spoofing penuh.
    const waktuBukti = new Date(dapatkanWaktuAplikasi());
    const labelWaktu = waktuBukti.toLocaleString(
        konfigurasi?.bahasa === 'en' ? 'en-US' : 'id-ID',
        {
            dateStyle: 'medium',
            timeStyle: 'medium'
        }
    );
    const paddingWatermark = Math.max(10, Math.round(canvas.width * 0.012));
    const ukuranFont = Math.max(14, Math.round(canvas.width * 0.018));
    ctx.save();
    ctx.font = `600 ${ukuranFont}px sans-serif`;
    ctx.textBaseline = 'bottom';
    const teksWatermark = `ABSENSI • ${labelWaktu}`;
    const lebarTeks = ctx.measureText(teksWatermark).width;
    const tinggiTeks = ukuranFont + paddingWatermark * 1.4;
    const xWatermark = Math.max(0, canvas.width - lebarTeks - paddingWatermark * 2);
    const yWatermark = canvas.height;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    ctx.fillRect(
        xWatermark,
        Math.max(0, yWatermark - tinggiTeks),
        lebarTeks + paddingWatermark * 2,
        tinggiTeks
    );
    ctx.fillStyle = '#fff';
    ctx.fillText(teksWatermark, xWatermark + paddingWatermark, yWatermark - paddingWatermark * 0.55);
    ctx.restore();

    await validasiCanvasHasil(canvas);

    /*
     * Foto bukti disimpan sebagai Blob terkompresi, bukan Base64/PNG.
     * WebP dicoba terlebih dahulu karena umumnya jauh lebih hemat kuota.
     * Jika browser tidak mendukung WebP, otomatis turun ke JPEG.
     */
    const kualitasWebP = [0.62, 0.55, 0.48, 0.42];
    const kualitasJpeg = [0.68, 0.60, 0.52, 0.45];
    const batasBytes = 400 * 1024;

    const buatBlob = (format, quality) => new Promise((resolve, reject) => {
        canvas.toBlob(
            hasil => hasil
                ? resolve(hasil)
                : reject(new Error(`Browser gagal membuat foto ${format.toUpperCase()}.`)),
            format,
            quality
        );
    });

    for (const quality of kualitasWebP) {
        try {
            const blob = await buatBlob('image/webp', quality);
            if (blob && blob.type === 'image/webp') {
                if (blob.size <= batasBytes || quality === kualitasWebP[kualitasWebP.length - 1]) {
                    return blob;
                }
            }
        } catch (error) {
            console.warn('WebP tidak tersedia, memakai JPEG fallback:', error);
            break;
        }
    }

    for (const quality of kualitasJpeg) {
        const blob = await buatBlob('image/jpeg', quality);
        if (blob.size <= batasBytes || quality === kualitasJpeg[kualitasJpeg.length - 1]) {
            return blob;
        }
    }

    throw new Error('Foto terlalu besar dan tidak dapat dikompresi.');
}

let guruMingguOffset = 0;
let guruBlobUrls = [];
let guruAsalHalaman = 'hal-1';

function bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function buatSaltPin() {
    const bytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) {
        window.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytesToHex(bytes);
}

async function hashPinGuru(pin, salt) {
    const input = `AbsensiPiketGuru|${salt}|${pin}`;
    if (window.crypto?.subtle && window.TextEncoder) {
        const data = new TextEncoder().encode(input);
        const digest = await window.crypto.subtle.digest('SHA-256', data);
        return bytesToHex(new Uint8Array(digest));
    }

    // Fallback hanya untuk browser lama. Tetap tidak menyimpan PIN mentah.
    let h1 = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h1 ^= input.charCodeAt(i);
        h1 = Math.imul(h1, 0x01000193);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0');
}

function bukaModalPinGuru(asal = 'hal-1') {
    guruPinAsalHalaman = asal || 'hal-1';
    guruPinGagal = 0;
    guruPinError.textContent = '';

    const sudahAdaPin = Boolean(konfigurasi?.guruPinHash && konfigurasi?.guruPinSalt);
    guruPinMode = sudahAdaPin ? 'verify' : 'setup';

    guruPinExistingFields.classList.toggle('sembunyi', !sudahAdaPin);
    guruPinSetupFields.classList.toggle('sembunyi', sudahAdaPin);
    guruPinTitle.textContent = sudahAdaPin ? t('pinLockedTitle') : t('pinSetupTitle');
    guruPinDescription.textContent = sudahAdaPin
        ? t('pinDescription')
        : t('pinSetupDescription');
    guruPinSubmit.textContent = sudahAdaPin ? t('pinOpen') : t('pinSaveOpen');

    guruPinInput.value = '';
    guruPinNewInput.value = '';
    guruPinNewConfirm.value = '';
    guruPinModal.classList.add('muncul');
    guruPinModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => (sudahAdaPin ? guruPinInput : guruPinNewInput).focus(), 80);
}

function tutupModalPinGuru() {
    guruPinModal.classList.remove('muncul');
    guruPinModal.setAttribute('aria-hidden', 'true');
    guruPinError.textContent = '';
}

async function prosesPinGuru() {
    muatStatusKunciPinGuru();
    const sekarang = Date.now();
    if (sekarang < guruPinTerkunciSampai) {
        const sisa = Math.ceil((guruPinTerkunciSampai - sekarang) / 1000);
        guruPinError.textContent = replaceTemplate(t('pinLockedDetail'), { seconds: sisa });
        return;
    }

    guruPinSubmit.disabled = true;
    guruPinError.textContent = '';

    try {
        if (guruPinMode === 'setup') {
            const pin = String(guruPinNewInput.value || '').trim();
            const konfirmasi = String(guruPinNewConfirm.value || '').trim();
            if (!/^\d{4,8}$/.test(pin)) {
                guruPinError.textContent = t('pinInvalid');
                guruPinNewInput.focus();
                return;
            }
            if (pin !== konfirmasi) {
                guruPinError.textContent = t('pinMismatch');
                guruPinNewConfirm.focus();
                return;
            }

            const salt = buatSaltPin();
            const hash = await hashPinGuru(pin, salt);
            konfigurasi = { ...konfigurasi, guruPinHash: hash, guruPinSalt: salt };
            await simpanKonfigurasiDB(konfigurasi);
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(konfigurasi)); } catch (_) {}
            guruPinGagal = 0;
            guruPinTerkunciSampai = 0;
            simpanStatusKunciPinGuru();
            tutupModalPinGuru();
            await masukRuangGuruSetelahPin();
            return;
        }

        const pin = String(guruPinInput.value || '').trim();
        if (!/^\d{4,8}$/.test(pin)) {
            guruPinError.textContent = t('pinInvalid');
            guruPinInput.focus();
            return;
        }

        const hash = await hashPinGuru(pin, konfigurasi.guruPinSalt);
        if (hash !== konfigurasi.guruPinHash) {
            guruPinGagal++;
            const batasGagal = 5;
            const sisa = Math.max(0, batasGagal - guruPinGagal);
            guruPinError.textContent = sisa
                ? `${t('pinWrong')}${sisa}.`
                : `${t('pinLocked')}30${t('pinLockedSuffix')}`;
            guruPinInput.value = '';
            if (guruPinGagal >= batasGagal) {
                guruPinTerkunciSampai = Date.now() + 30000;
                guruPinGagal = 0;
            }
            simpanStatusKunciPinGuru();
            guruPinInput.focus();
            return;
        }

        guruPinGagal = 0;
        guruPinTerkunciSampai = 0;
        simpanStatusKunciPinGuru();
        tutupModalPinGuru();
        await masukRuangGuruSetelahPin();
    } catch (error) {
        console.error('PIN Ruang Guru:', error);
        guruPinError.textContent = t('pinProcessError');
    } finally {
        guruPinSubmit.disabled = false;
    }
}

async function masukRuangGuruSetelahPin() {
    guruAsalHalaman = guruPinAsalHalaman || 'hal-1';
    if (guruAsalHalaman === 'hal-1') hentikanKamera();
    const asalEl = document.getElementById(guruAsalHalaman);
    if (asalEl) asalEl.classList.add('sembunyi');
    document.getElementById('halGuru')?.classList.remove('sembunyi');
    guruMingguOffset = 0;
    try {
        await renderRuangGuru();
    } catch (error) {
        console.error('Gagal memuat Ruang Guru:', error);
        const elGuruLaporan = document.getElementById('guruLaporan');
        if (elGuruLaporan) elGuruLaporan.innerHTML = `<div class="guru-foto-empty">${escapeHtmlGuru(t('reportPhotoUnreadable'))}</div>`;
    }
}

function bersihkanGuruBlobUrls() {
    guruBlobUrls.forEach(url => URL.revokeObjectURL(url));
    guruBlobUrls = [];
}

function bukaRuangGuru(asal = 'hal-1') {
    bukaModalPinGuru(asal);
}

function tutupRuangGuru() {
    bersihkanGuruBlobUrls();
    document.getElementById('halGuru')?.classList.add('sembunyi');
    document.getElementById(guruAsalHalaman)?.classList.remove('sembunyi');

    if (guruAsalHalaman === 'hal-1' && !sudahAbsen && namaReguPiket.length) {
        mulaiKamera().catch(error => tampilkanErrorKamera(error));
    }
}

function setNotifikasiGuru(teks, mode = '') {
    const el = document.getElementById('guruNotifikasi');
    if (!el) return;
    el.className = `guru-notifikasi ${mode}`.trim();
    el.textContent = teks;
}

function escapeHtmlGuru(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'
    }[char]));
}


function csvEscape(value) {
    let text = String(value ?? '');
    // Cegah formula injection saat file dibuka di Excel/Sheets.
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
}

async function eksporLaporanCSV() {
    try {
        if (typeof window.__lazyLoadJSZip === 'function' && !window.JSZip) {
            await window.__lazyLoadJSZip();
        }
        const JSZip = await tungguLibraryGlobal('JSZip', 10000);
        if (!JSZip) throw new Error('JSZip belum berhasil dimuat. Periksa koneksi internet, lalu coba lagi.');

        const semuaLaporan = await ambilSemuaLaporanAbsensi();
        const laporanValid = semuaLaporan
            .filter(laporanIdValid)
            .sort((a, b) => {
                const ta = timestampLaporan(a);
                const tb = timestampLaporan(b);
                return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
            });

        if (!laporanValid.length) {
            alert(t('exportEmpty'));
            return;
        }

        const fotoItems = [];
        for (const lap of laporanValid) {
            if (!lap.photoId) continue;
            try {
                const blob = await ambilFotoAbsensiDB(lap.photoId);
                if (blob instanceof Blob && blob.size) {
                    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
                    const safeKey = String(lap.id).replace(/[^a-zA-Z0-9_-]/g, '_');
                    fotoItems.push({ lap, blob, filename: `${safeKey}.${ext}` });
                }
            } catch (error) {
                console.warn('Foto bukti gagal dibaca saat ekspor:', lap.photoId, error);
            }
        }

        const fotoById = new Map(fotoItems.map(item => [item.lap.id, item]));
        const header = ['Tanggal','Hari','Kelas','Ruangan','Waktu Absen','ID Sesi','Piket (Hadir)','Tidak Piket','Foto Bukti'];

        const rows = laporanValid.map(lap => {
            const hadir = lap.hadir?.length ? lap.hadir.map(s => s.name).join('; ') : '-';
            const tidakHadir = lap.tidakHadir?.length ? lap.tidakHadir.map(s => s.name).join('; ') : '-';
            const hari = konfigurasi?.bahasa === 'en'
                ? ({Senin:'Monday',Selasa:'Tuesday',Rabu:'Wednesday',Kamis:'Thursday',Jumat:'Friday',Sabtu:'Saturday',Minggu:'Sunday'}[lap.hari] || lap.hari)
                : lap.hari;
            const foto = fotoById.get(lap.id);
            return [
                lap.tanggal,
                hari,
                `${lap.kelas || ''} ${lap.jurusan || ''}`.trim(),
                lap.ruangan || '',
                formatWaktuGuru(lap.waktu),
                lap.id,
                hadir,
                tidakHadir,
                foto ? `foto-bukti/${foto.filename}` : ''
            ].map(csvEscape).join(',');
        });

        const csvContent = '\uFEFF' + [header.map(csvEscape).join(','), ...rows].join('\r\n') + '\r\n';
        const zip = new JSZip();
        zip.file('Laporan_Absensi.csv', csvContent);
        zip.file('README.txt', [
            'Backup Laporan Absensi Piket',
            '',
            'Setiap sesi absensi memiliki ID unik agar beberapa sesi dalam tanggal yang sama tidak saling menimpa.',
            'Folder foto-bukti berisi foto bukti yang tersedia di perangkat saat ekspor.'
        ].join('\r\n'));

        const folderFoto = zip.folder('foto-bukti');
        for (const foto of fotoItems) folderFoto.file(foto.filename, foto.blob);

        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url = URL.createObjectURL(zipBlob);
        try {
            const link = document.createElement('a');
            link.href = url;
            const kelas = String(konfigurasi?.kelas || 'Kelas').replace(/[\\/:*?"<>|]/g, '_');
            const jurusan = String(konfigurasi?.jurusan || 'Laporan').replace(/[\\/:*?"<>|]/g, '_');
            link.download = `Laporan_Piket_${kelas}_${jurusan}.zip`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
        } finally {
            URL.revokeObjectURL(url);
        }
        tampilkanToast(t('exportSuccess'));
    } catch (error) {
        console.error('Gagal ekspor laporan ZIP:', error);
        alert(replaceTemplate(t('exportError'), { message: error?.message || t('openDbError') }));
    }
}

async function hapusSemuaRiwayatAbsensiDB() {
    const db = await bukaDatabase();
    return new Promise((resolve, reject) => {
        let selesai = false;
        const finish = (fn, value) => {
            if (selesai) return;
            selesai = true;
            fn(value);
        };

        try {
            const tx = db.transaction(['attendanceRecords', 'attendancePhotos'], 'readwrite');
            tx.objectStore('attendanceRecords').clear();
            tx.objectStore('attendancePhotos').clear();
            tx.oncomplete = () => {
                db.close();
                finish(resolve);
            };
            tx.onerror = () => {
                const error = tx.error || new Error('Gagal membersihkan riwayat absensi.');
                db.close();
                finish(reject, error);
            };
            tx.onabort = () => {
                const error = tx.error || new Error('Penghapusan riwayat absensi dibatalkan.');
                db.close();
                finish(reject, error);
            };
        } catch (error) {
            db.close();
            finish(reject, error);
        }
    });
}

async function renderRuangGuru() {
    bersihkanGuruBlobUrls();

    const info = document.getElementById('guruInfoKelas');
    if (info) {
        info.textContent = konfigurasi
            ? `${t('classRoomInfo')} ${konfigurasi.kelas} ${konfigurasi.jurusan} • ${t('roomInfo')} ${konfigurasi.ruangan}`
            : t('notConfigured');
    }

    const start = awalMingguSenin(new Date(), guruMingguOffset);
    const dates = Array.from({length: 7}, (_, i) => {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dayKeys = ['dayMon','dayTue','dayWed','dayThu','dayFri','daySat','daySun'];
        return { iso: tanggalISOBaru(d), nama: t(dayKeys[i]) };
    });
    const end = dates[6].iso;

    const elGuruRentangMinggu = document.getElementById('guruRentangMinggu');
    if (elGuruRentangMinggu) elGuruRentangMinggu.textContent = `${formatTanggalGuru(dates[0].iso)} — ${formatTanggalGuru(end)}`;
    const elGuruStatusMinggu = document.getElementById('guruStatusMinggu');
    if (elGuruStatusMinggu) {
        elGuruStatusMinggu.textContent = guruMingguOffset === 0 ? t('reportWeekCurrent') : (guruMingguOffset < 0 ? t('reportWeekPrevious') : t('reportWeekNext'));
        elGuruStatusMinggu.setAttribute('aria-label', t('reportWeekDays'));
    }

    const semuaLaporan = await ambilSemuaLaporanAbsensi();
    const laporanValid = semuaLaporan
        .filter(laporanIdValid)
        .sort((a,b) => (timestampLaporan(b) || 0) - (timestampLaporan(a) || 0));

    const laporanPerTanggal = new Map();
    for (const laporan of laporanValid) {
        if (!laporanPerTanggal.has(laporan.tanggal)) laporanPerTanggal.set(laporan.tanggal, []);
        laporanPerTanggal.get(laporan.tanggal).push(laporan);
    }

    setNotifikasiGuru(guruMingguOffset === 0 ? t('reportGrowing') : t('reportArchive'), '');

    const container = document.getElementById('guruLaporan');
    if (!container) return;
    container.innerHTML = '';

    for (const day of dates) {
        const laporanHari = laporanPerTanggal.get(day.iso) || [];

        if (!laporanHari.length) {
            const card = document.createElement('div');
            card.className = 'guru-hari-card';
            card.innerHTML = `
                <div class="guru-hari-header">
                    <div><h3>${escapeHtmlGuru(day.nama)}</h3><small>${escapeHtmlGuru(formatTanggalGuru(day.iso))}</small></div>
                    <span class="guru-status belum">${escapeHtmlGuru(t('reportNotSaved'))}</span>
                </div>
                <div class="guru-foto-empty">${escapeHtmlGuru(t('reportNoData'))}</div>`;
            container.appendChild(card);
            continue;
        }

        for (const laporan of laporanHari) {
            const card = document.createElement('div');
            card.className = 'guru-hari-card';
            const hadirText = laporan.hadir?.length ? laporan.hadir.map(s => s.name).join(', ') : t('reportNoRecognized');
            const tidakText = laporan.tidakHadir?.length ? laporan.tidakHadir.map(s => s.name).join(', ') : t('reportAllPresent');
            const labelSesi = konfigurasi?.bahasa === 'en' ? `Session ${laporan.id.replace(/^absensi_/, '')}` : `Sesi ${laporan.id.replace(/^absensi_/, '')}`;

            card.innerHTML = `
                <div class="guru-hari-header">
                    <div><h3>${escapeHtmlGuru(day.nama)}</h3><small>${escapeHtmlGuru(formatTanggalGuru(day.iso))} • ${escapeHtmlGuru(formatWaktuGuru(laporan.waktu))}</small></div>
                    <span class="guru-status">${escapeHtmlGuru(t('reportSaved'))}</span>
                </div>
                <div class="guru-detail"><b>${escapeHtmlGuru(labelSesi)}</b></div>
                <div class="guru-detail"><b>${escapeHtmlGuru(t('reportOnDuty'))}</b> ${escapeHtmlGuru(hadirText)}</div>
                <div class="guru-detail"><b>${escapeHtmlGuru(t('reportNotOnDuty'))}</b> ${escapeHtmlGuru(tidakText)}</div>
                <div class="guru-detail"><b>${escapeHtmlGuru(t('reportFaces'))}</b> ${Number(laporan.jumlahWajahTerdeteksi || 0)}</div>
                <div class="guru-detail"><b>${escapeHtmlGuru(t('reportSchedule'))}</b> ${escapeHtmlGuru((laporan.siswaTerjadwal || []).map(s => s.name).join(', ') || '-')}</div>
                <div class="guru-foto-empty" data-photo-holder>${escapeHtmlGuru(t('reportLoadingPhoto'))}</div>`;

            container.appendChild(card);
            const holder = card.querySelector('[data-photo-holder]');
            try {
                const blob = await ambilFotoAbsensiDB(laporan.photoId);
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    guruBlobUrls.push(url);
                    const img = document.createElement('img');
                    img.className = 'guru-foto-thumb';
                    img.src = url;
                    img.alt = `Foto bukti ${day.nama}`;
                    img.addEventListener('click', () => bukaFotoGuru(url, `${day.nama} • ${formatTanggalGuru(day.iso)} • ${formatWaktuGuru(laporan.waktu)}`));
                    holder?.replaceWith(img);
                } else if (holder) {
                    holder.textContent = t('reportPhotoMissing');
                }
            } catch (error) {
                console.warn('Gagal memuat foto laporan:', error);
                if (holder) holder.textContent = t('reportPhotoUnreadable');
            }
        }
    }
}

function bukaFotoGuru(url, caption) {
    const modal = document.getElementById('guruFotoModal');
    const overlay = document.getElementById('guruFotoOverlay');
    const preview = document.getElementById('guruFotoPreview');
    const captionEl = document.getElementById('guruFotoCaption');
    if (preview) preview.src = url;
    if (captionEl) captionEl.textContent = caption;
    modal?.classList.add('muncul');
    overlay?.classList.add('muncul');
}

function tutupFotoGuru() {
    document.getElementById('guruFotoModal')?.classList.remove('muncul');
    document.getElementById('guruFotoOverlay')?.classList.remove('muncul');
}

document.getElementById('guruFotoClose')?.addEventListener('click', tutupFotoGuru);
async function resetPinGuruLokal() {
    const yakin = confirm(
        'Reset PIN Guru tanpa menghapus data siswa, foto wajah, jadwal, dan riwayat absensi?\n\n' +
        'Catatan: pada aplikasi yang sepenuhnya lokal, reset ini bukan mekanisme keamanan server. Gunakan hanya pada perangkat yang dikuasai guru.'
    );
    if (!yakin) return;

    try {
        konfigurasi = {
            ...konfigurasi,
            guruPinHash: '',
            guruPinSalt: ''
        };
        await simpanKonfigurasiDB(konfigurasi);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(konfigurasi)); } catch (_) {}
        guruPinGagal = 0;
        guruPinTerkunciSampai = 0;
        simpanStatusKunciPinGuru();
        tampilkanToast('PIN Guru telah direset. Data siswa dan riwayat tetap tersimpan.');
        tutupModalPinGuru();
        bukaModalPinGuru(guruPinAsalHalaman || 'hal-1');
    } catch (error) {
        console.error('Reset PIN gagal:', error);
        alert('Reset PIN gagal: ' + (error?.message || 'kesalahan tidak diketahui.'));
    }
}

document.getElementById('guruPinReset')?.addEventListener('click', resetPinGuruLokal);

guruPinCancel?.addEventListener('click', tutupModalPinGuru);
guruPinSubmit?.addEventListener('click', () => { processPinGuruSafe(); });
guruPinModal?.addEventListener('click', event => {
    if (event.target === guruPinModal) tutupModalPinGuru();
});
[guruPinInput, guruPinNewInput, guruPinNewConfirm].forEach(input => {
    input?.addEventListener('keydown', event => {
        if (event.key === 'Enter') processPinGuruSafe();
        if (event.key === 'Escape') tutupModalPinGuru();
    });
    input?.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 8);
    });
});

let pinProsesSedangBerjalan = false;
async function processPinGuruSafe() {
    if (pinProsesSedangBerjalan) return;
    pinProsesSedangBerjalan = true;
    try { await prosesPinGuru(); } finally { pinProsesSedangBerjalan = false; }
}

document.getElementById('guruFotoOverlay')?.addEventListener('click', tutupFotoGuru);
document.getElementById('guruPrevWeek')?.addEventListener('click', () => {
    guruMingguOffset--;
    renderRuangGuru().catch(console.error);
});
document.getElementById('guruNextWeek')?.addEventListener('click', () => {
    guruMingguOffset++;
    renderRuangGuru().catch(console.error);
});
document.getElementById('guruRefresh')?.addEventListener('click', () => {
    renderRuangGuru().catch(console.error);
});

document.getElementById('guruExportCSV')?.addEventListener('click', () => {
    eksporLaporanCSV();
});

document.getElementById('guruHapusRiwayat')?.addEventListener('click', async () => {
    const semuaLaporan = await ambilSemuaLaporanAbsensi().catch(() => []);
    if (!semuaLaporan.length) {
        alert(t('clearHistoryEmpty'));
        return;
    }

    if (!confirm(t('clearHistoryConfirm'))) return;

    const tombol = document.getElementById('guruHapusRiwayat');
    if (tombol) tombol.disabled = true;

    try {
        await hapusSemuaRiwayatAbsensiDB();
        await renderRuangGuru();
        tampilkanToast(t('clearHistorySuccess'));
    } catch (error) {
        console.error('Gagal membersihkan riwayat absensi:', error);
        alert(replaceTemplate(t('clearHistoryError'), { message: error?.message || t('openDbError') }));
    } finally {
        if (tombol) tombol.disabled = false;
    }
});
<!-- AKHIR SCRIPT 2: CORE + DATABASE + KAMERA + AI -->

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

/* =====================================================
   PREFERENSI EVENT
===================================================== */
document.getElementById('pilihBahasa')?.addEventListener('change', async event => {
    const bahasa = event.target.value === 'en' ? 'en' : 'id';
    if (!konfigurasi) konfigurasi = {};
    konfigurasi.bahasa = bahasa;
    terapkanBahasa(bahasa);
    try {
        await simpanKonfigurasiDB(konfigurasi);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(konfigurasi));
        } catch (storageError) {
            console.warn('Mirror localStorage tidak dapat diperbarui:', storageError);
        }
    } catch (error) {
        console.error('Gagal menyimpan bahasa:', error);
        alert(t('languageSaveError'));
    }
});

document.getElementById('pilihRasioKamera')?.addEventListener('change', async event => {
    const rasio = event.target.value === '9:16' ? '9:16' : '16:9';
    if (!konfigurasi) konfigurasi = {};
    konfigurasi.rasioKamera = rasio;
    terapkanRasioKamera(rasio);

    try {
        await simpanKonfigurasiDB(konfigurasi);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(konfigurasi));
        } catch (storageError) {
            console.warn('Mirror localStorage tidak dapat diperbarui:', storageError);
        }
    } catch (error) {
        console.error('Gagal menyimpan rasio kamera:', error);
        alert(t('ratioSaveError'));
        return;
    }

    tampilkanToast(
        konfigurasi?.bahasa === 'en'
            ? `Camera set to ${rasio}.`
            : `Rasio kamera diubah ke ${rasio}.`
    );

    /* Jika kamera sedang aktif, mulai ulang agar constraint perangkat ikut berubah. */
    const halKamera = document.getElementById('hal-1');
    if (kameraDiizinkanHariIni() && halKamera && !halKamera.classList.contains('sembunyi') && video.srcObject) {
        try {
            await mulaiKamera();
        } catch (error) {
            console.error('Gagal menerapkan rasio kamera:', error);
            tampilkanErrorKamera(error);
        }
    }
});

/* =====================================================
   START
===================================================== */

let bootstrapAplikasiSedangBerjalan = false;
let bootstrapAplikasiSelesai = false;

async function bootstrapAplikasi() {
    if (bootstrapAplikasiSedangBerjalan || bootstrapAplikasiSelesai) return;
    bootstrapAplikasiSedangBerjalan = true;

    try {
        const sudahAda = await loadConfig();

        // Maintenance storage dilakukan setelah konfigurasi siap agar
        // status UI dan sinkronisasi backend menggunakan konfigurasi terbaru.
        jalankanStartupAman('maintenance storage', () => pastikanPenyimpananPermanen());
        jalankanStartupAman('prune riwayat', () => autoPruneRiwayatAbsensi(30));
        jalankanStartupAman('sinkronisasi saran', () => sinkronisasiSaranTertunda());

        if (sudahAda) {
            await jalankanAsyncAman('menampilkan kamera', () => tampilkanKamera(), null);
        } else {
            const halSetup = document.getElementById('halSetup');
            halSetup?.classList.remove('sembunyi');
        }

        bootstrapAplikasiSelesai = true;
    } catch (error) {
        console.error('Bootstrap aplikasi gagal:', error);
        const halSetup = document.getElementById('halSetup');
        halSetup?.classList.remove('sembunyi');
        try {
            alert(t('openDbError'));
        } catch (_) {
            alert('Gagal memuat konfigurasi aplikasi.');
        }
    } finally {
        bootstrapAplikasiSedangBerjalan = false;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapAplikasi, { once: true });
} else {
    bootstrapAplikasi().catch(error => console.error('Bootstrap aplikasi gagal:', error));
}


function deteksiInAppBrowser() {
    const ua = navigator.userAgent || '';
    return /FBAN|FBAV|Instagram|Line\/|; wv\)|WhatsApp|TikTok|Twitter|Snapchat/i.test(ua);
}

function tampilkanPeringatanInAppBrowser() {
    if (!deteksiInAppBrowser()) return;
    const modal = document.getElementById('inAppBrowserWarning');
    if (!modal) return;

    try {
        if (sessionStorage.getItem('inappBrowserWarningShown') === '1') return;
        sessionStorage.setItem('inappBrowserWarningShown', '1');
    } catch (error) {
        console.warn('Session storage in-app browser tidak tersedia:', error);
    }

    modal.hidden = false;

    document.getElementById('btnTutupInAppWarning')?.addEventListener('click', () => {
        modal.hidden = true;
    }, { once: true });

    document.getElementById('btnBukaBrowser')?.addEventListener('click', async () => {
        const url = location.href;
        try {
            await navigator.clipboard?.writeText(url);
        } catch (_) {}
        window.open(url, '_blank', 'noopener,noreferrer');
        modal.hidden = true;
    }, { once: true });
}

function dapatkanWaktuAplikasi() {
    if (Number.isFinite(waktuServerOffsetMs)) {
        return Date.now() + waktuServerOffsetMs;
    }
    return Date.now();
}

/*
 * Ambil timestamp dari server yang menyajikan halaman bila tersedia.
 * Ini bukan pengganti backend absensi: server aplikasi/Apps Script tetap
 * harus menjadi sumber timestamp final ketika laporan dikirim ke server.
 */
async function sinkronkanWaktuServer() {
    if (!navigator.onLine || !/^https?:$/.test(location.protocol)) return null;
    try {
        const response = await fetch(location.href, {
            method: 'HEAD',
            cache: 'no-store',
            credentials: 'same-origin'
        });
        const headerDate = response.headers.get('Date');
        if (!headerDate) return null;
        const serverMs = Date.parse(headerDate);
        if (!Number.isFinite(serverMs)) return null;
        waktuServerOffsetMs = serverMs - Date.now();
        waktuServerTerakhir = Date.now();
        return serverMs;
    } catch (error) {
        console.warn('Sinkronisasi waktu server tidak tersedia:', error);
        return null;
    }
}

function deteksiDalamIframe() {
    try {
        return window.top !== window.self;
    } catch (_) {
        return true;
    }
}

function tampilkanPeringatanIframe() {
    if (!deteksiDalamIframe()) return;

    const modal = document.getElementById('iframePermissionModal');
    if (!modal) return;

    try {
        if (sessionStorage.getItem('iframePermissionWarningShown') === '1') return;
        sessionStorage.setItem('iframePermissionWarningShown', '1');
    } catch (_) {}

    const title = document.getElementById('iframePermissionTitle');
    const text = document.getElementById('iframePermissionText');
    const snippet = document.getElementById('iframeAllowSnippet');

    if (title) title.textContent = t('cameraIframeTitle');
    if (text) text.textContent = t('cameraIframeText');
    if (snippet) {
        snippet.textContent = `<iframe src="${location.href}" allow="camera; autoplay; fullscreen"></iframe>`;
    }

    modal.hidden = false;

    document.getElementById('btnTutupIframeWarning')?.addEventListener('click', () => {
        modal.hidden = true;
    }, { once: true });

    document.getElementById('btnBukaIframePenuh')?.addEventListener('click', () => {
        try {
            window.open(location.href, '_blank', 'noopener,noreferrer');
        } catch (_) {}
        modal.hidden = true;
    }, { once: true });
}

function pasangPembaruanPWA(registration) {
    if (!registration) return;

    const modal = document.getElementById('appUpdateModal');
    const title = document.getElementById('appUpdateTitle');
    const text = document.getElementById('appUpdateText');
    const btnLater = document.getElementById('btnNantiUpdate');
    const btnUpdate = document.getElementById('btnPerbaruiUpdate');

    if (title) title.textContent = t('cameraUpdateTitle');
    if (text) text.textContent = t('cameraUpdateText');
    if (btnLater) btnLater.textContent = t('cameraUpdateLater');
    if (btnUpdate) btnUpdate.textContent = t('cameraUpdateNow');

    let sedangMemuatUlang = false;

    const tampilkan = () => {
        if (!modal) return;
        modal.hidden = false;
    };

    if (registration.waiting) tampilkan();

    registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;

        worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                tampilkan();
            }
        });
    });

    btnLater?.addEventListener('click', () => {
        if (modal) modal.hidden = true;
    });

    btnUpdate?.addEventListener('click', () => {
        const waiting = registration.waiting;
        if (!waiting) {
            registration.update().catch(() => {});
            return;
        }

        btnUpdate.disabled = true;
        waiting.postMessage({ type: 'SKIP_WAITING' });
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sedangMemuatUlang) return;
        sedangMemuatUlang = true;
        location.reload();
    });
}

/* =====================================================
   OFFLINE AI MODEL STATUS
===================================================== */
async function cekAsetModelLokal() {
    try {
        const response = await fetch(`${AI_MODEL_PATH_LOCAL}faceres.json`, { cache: 'no-store' });
        if (!response.ok) {
            console.warn('Aset model lokal belum tersedia. AI akan menggunakan CDN saat online.');
            return false;
        }
        return true;
    } catch (_) {
        return false;
    }
}
cekAsetModelLokal().catch(() => {});

/*
 * Pemeriksaan integritas fungsi inti.
 * Tidak memblokir aplikasi; hanya mencatat fungsi yang benar-benar hilang.
 */
(() => {
    const fungsiInti = [
        'bukaDatabase',
        'simpanSiswaDB',
        'ambilSemuaSiswaDB',
        'muatModelAI',
        'mulaiAI',
        'mulaiKamera',
        'prosesFotoWajah',
        'resetSemuaData',
        'bukaRuangGuru',
        'renderRuangGuru',
        'kirimSaran',
        'simpanAntreanAbsensiOffline',
        'sinkronkanAntreanAbsensi',
        'apiKirimAbsensi'
    ];

    const hilang = fungsiInti.filter(nama => typeof window[nama] !== 'function');
    if (hilang.length) {
        console.error('Fungsi inti aplikasi tidak tersedia:', hilang);
    } else {
        console.info('Integritas fungsi inti Absensi Piket: OK');
    }
})();



/* =====================================================
   STARTUP INTEGRITY GUARD
   Pastikan titik-titik kritis tersedia sebelum interaksi pengguna.
===================================================== */
(() => {
    const wajib = {
        video,
        wadah,
        btnJepret,
        muatModelAI,
        deteksiWajahLoop,
        mulaiPreviewAI,
        ambilFrameKameraBlob,
        bersihkanObjectURLs
    };
    const hilang = Object.entries(wajib)
        .filter(([, value]) => !value)
        .map(([nama]) => nama);
    if (hilang.length) {
        console.error('Integritas startup aplikasi bermasalah:', hilang);
    }
})();

/* =====================================================
   STARTUP SAFE BOOTSTRAP
   Operasi startup non-kritis dibungkus agar satu kegagalan tidak
   menghentikan bagian lain dari aplikasi.
===================================================== */
function jalankanStartupAman(nama, aksi) {
    try {
        const hasil = aksi();
        if (hasil && typeof hasil.catch === 'function') {
            hasil.catch(error => {
                console.warn(`Startup ${nama} gagal:`, error);
            });
        }
        return hasil;
    } catch (error) {
        console.warn(`Startup ${nama} gagal:`, error);
        return null;
    }
}

// Jaring pengaman umum untuk operasi yang boleh gagal tanpa mematikan alur utama.
function jalankanAman(nama, aksi, fallback = null) {
    try {
        const hasil = aksi();
        if (hasil && typeof hasil.catch === 'function') {
            return hasil.catch(error => {
                console.error(`${nama} gagal:`, error);
                return fallback;
            });
        }
        return hasil;
    } catch (error) {
        console.error(`${nama} gagal:`, error);
        return fallback;
    }
}

async function jalankanAsyncAman(nama, aksi, fallback = null) {
    try {
        return await aksi();
    } catch (error) {
        console.error(`${nama} gagal:`, error);
        return fallback;
    }
}

/* =====================================================
   PWA / OFFLINE CACHE
===================================================== */
try { tampilkanPeringatanInAppBrowser(); } catch (error) { console.warn('Deteksi in-app browser gagal:', error); }
try { tampilkanPeringatanIframe(); } catch (error) { console.warn('Deteksi iframe gagal:', error); }
try { tampilkanStatusKoneksi(); } catch (error) { console.warn('Status koneksi gagal dipasang:', error); }
jalankanStartupAman('deteksi mode privasi', () => deteksiModePrivasi());
jalankanStartupAman('sinkronisasi waktu server', () => sinkronkanWaktuServer());
jalankanStartupAman('sinkronisasi antrean absensi', () => sinkronkanAntreanAbsensi());
jalankanStartupAman('sinkronisasi saran tertunda', () => sinkronisasiSaranTertunda());

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
            .then(registration => {
                pasangPembaruanPWA(registration);
                registration.update().catch(() => {});
            })
            .catch(error => {
                console.warn('Service Worker tidak dapat didaftarkan:', error);
                if (modePrivasiTerindikasi) {
                    tampilkanToast(t('cameraPrivateMode'), 4200);
                }
            });
    }, { once: true });
}

/* =====================================================
   EVENT BINDINGS — CONTROLS PRINCIPAIS
   Semua botões declarados no HTML devem ter seu handler ligado
   explicitamente. O uso de ?. torna o bloco seguro caso uma tela
   opcional seja removida em uma futura versão.
===================================================== */
const bindClick = (id, handler) => {
    const element = document.getElementById(id);
    if (!element || typeof handler !== 'function') return false;
    element.addEventListener('click', handler);
    return true;
};

bindClick('btnTambahSiswa', () => {
    void tambahSiswaBaru();
});
bindClick('btnTambahSiswaMassal', tambahSiswaMassal);
bindClick('btnBatalSiswaMassal', tutupModalSiswaMassal);
bindClick('btnProsesSiswaMassal', () => {
    void prosesSiswaMassal();
});

bindClick('btnSimpanPengaturan', () => {
    void simpanSemuaPengaturan();
});
bindClick('btnHapusSemuaData', () => {
    void resetSemuaData();
});

bindClick('btnRuangGuruSetup', () => {
    bukaRuangGuru('halSetup');
});
bindClick('btnRuangGuruKamera', () => {
    bukaRuangGuru('hal-1');
});
bindClick('btnTutupRuangGuru', tutupRuangGuru);

bindClick('btnKotakSaranSetup', () => {
    bukaKotakSaran('halSetup');
});
bindClick('btnKotakSaranKamera', () => {
    bukaKotakSaran('hal-1');
});
bindClick('btnTutupKotakSaran', tutupKotakSaran);
bindClick('btnTabSaranGuru', () => {
    pindahTabSaran('guru');
});
bindClick('btnTabSaranMurid', () => {
    pindahTabSaran('murid');
});
bindClick('btnKirimSaranGuru', () => {
    void kirimSaran('guru');
});
bindClick('btnKirimSaranMurid', () => {
    void kirimSaran('murid');
});

bindClick('btnBatalModalFoto', tutupModalFoto);
bindClick('btnProsesFotoWajah', () => {
    void prosesFotoWajah();
});

// Tombol ⚙️ pada halaman kamera memang memiliki fungsi yang sudah
// tersedia: kembali ke halaman pengaturan tanpa membuat fungsi baru.
bindClick('btnPengaturanKamera', bukaPengaturan);

// AKHIR SCRIPT 3: PREFERENSI EVENT + STARTUP + PWA
window.addEventListener('pagehide', () => {
    hentikanLoopDeteksi();
    hentikanKamera(true);
    if (kameraViewportSyncTimer) {
        clearTimeout(kameraViewportSyncTimer);
        kameraViewportSyncTimer = null;
    }
    if (cameraViewportSyncRaf) {
        cancelAnimationFrame(cameraViewportSyncRaf);
        cameraViewportSyncRaf = null;
    }
    bersihkanSemuaObjectURLs();
    hentikanPantauanMemoriAI();
    try { audioContextJepret?.close?.(); } catch (_) {}
    audioContextJepret = null;
});
