// script.js (FINAL - Mengimplementasikan 3 Grafik Real-time - Bug Fix)

// Import fungsi dari firebase.js (termasuk query dan limitToLast yang sudah diekspor)
import { 
    db, 
    ref, 
    onValue, 
    set, 
    push, 
    query, 
    limitToLast 
} from './firebase.js'; 

// =========================
// Konstanta & Global Chart
// =========================
const MONITORING_PATH = 'monitoring';
const LOW_PPM = 750;    // Pompa ON jika ppm < 750
const HIGH_PPM = 1150;  // Pompa OFF jika ppm > 1150
const PUMP_PATH = 'actuators/pump';

const $ = (id) => document.getElementById(id);
const toISO = () => new Date().toISOString();

// Variabel untuk objek grafik dan data historis terbatas
let suhuChart, phChart, tdsChart;
const MAX_DATA_POINTS = 20; // Jumlah maksimum titik data di grafik
const chartData = {
    labels: [],
    suhu: [],
    ph: [],
    tds: []
};
let lastAutoDecision = null; // Untuk mencegah looping AUTO ON/OFF

// =========================
// Fungsi Log Event
// =========================
function logEvent(message, extra = {}) {
    try {
        const logsRef = ref(db, 'logs');
        push(logsRef, { message, ...extra, timestamp: toISO() });
        const logBox = $('log-entries');
        if (logBox) {
            const row = document.createElement('div');
            row.className = 'log-entry';
            row.innerHTML = `
                <span>${message}</span>
                <span class="timestamp">${new Date().toLocaleString()}</span>
            `;
            logBox.prepend(row); // Tambahkan log terbaru di atas
        }
    } catch (e) {
        console.error('Log error:', e);
    }
}

// =========================
// Inisialisasi Grafik (Chart.js)
// =========================
function initCharts() {
    // ---- Grafik Suhu ----
    const ctxSuhu = document.getElementById('suhuChart');
    if (ctxSuhu) {
        suhuChart = new Chart(ctxSuhu, {
            type: 'line',
            data: {
                labels: chartData.labels,
                datasets: [{
                    label: 'Suhu (°C)',
                    data: chartData.suhu,
                    borderColor: 'rgb(255, 99, 132)',
                    backgroundColor: 'rgba(255, 99, 132, 0.2)',
                    tension: 0.2,
                    pointRadius: 3
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: false } } }
        });
    }

    // ---- Grafik pH ----
    const ctxPh = document.getElementById('phChart');
    if (ctxPh) {
        phChart = new Chart(ctxPh, {
            type: 'line',
            data: {
                labels: chartData.labels,
                datasets: [{
                    label: 'pH Air',
                    data: chartData.ph,
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    tension: 0.2,
                    pointRadius: 3
                }]
            },
            // Batasan skala pH (standar 0-14, di sini dibatasi untuk visualisasi hidroponik)
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 14 } } } 
        });
    }

    // ---- Grafik TDS ----
    const ctxTds = document.getElementById('tdsChart');
    if (ctxTds) {
        tdsChart = new Chart(ctxTds, {
            type: 'line',
            data: {
                labels: chartData.labels,
                datasets: [{
                    label: 'Kadar Nutrisi (PPM)',
                    data: chartData.tds,
                    borderColor: 'rgb(54, 162, 235)',
                    backgroundColor: 'rgba(54, 162, 235, 0.2)',
                    tension: 0.2,
                    pointRadius: 3
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
        });
    }
    console.log("✅ Grafik diinisialisasi.");
}


// =========================
// Render UI Sensor & Update Grafik
// =========================
function renderSensors(latest) {
    if (!latest) return;
    
    // Konversi nilai (menggunakan parseFloat untuk menangani string seperti "28.50")
    const suhuValue = parseFloat(latest.suhu);
    const phValue = parseFloat(latest.phAir);
    const tdsValue = Math.round(Number(latest.kadarNutrisi) || 0);

    // Update nilai UI
    if ($('suhu')) $('suhu').textContent = suhuValue.toFixed(1);
    if ($('ph-air')) $('ph-air').textContent = phValue.toFixed(1);
    if ($('tds')) $('tds').textContent = tdsValue;

    // Update Status Sistem
    const status = String(latest.statusSistem || 'normal').toLowerCase(); 
    const statusText = status.charAt(0).toUpperCase() + status.slice(1);
    
    const statusEls = [$('status-suhu'), $('status-ph'), $('status-tds')];
    statusEls.forEach((el) => {
        if (!el) return;
        el.className = `status ${status}`;
        el.textContent = statusText;
    });

    // LOGIKA UPDATE GRAFIK
    if (suhuChart && phChart && tdsChart) {
        // Ambil label waktu singkat
        let timeLabel = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        // Tambahkan data baru
        chartData.labels.push(timeLabel);
        chartData.suhu.push(suhuValue);
        chartData.ph.push(phValue);
        chartData.tds.push(tdsValue);
        
        // Batasi jumlah titik data (geser data lama keluar)
        if (chartData.labels.length > MAX_DATA_POINTS) {
            chartData.labels.shift();
            chartData.suhu.shift();
            chartData.ph.shift();
            chartData.tds.shift();
        }
        
        // Perbarui semua grafik (gunakan 'none' untuk update yang cepat tanpa animasi)
        suhuChart.update('none'); 
        phChart.update('none'); 
        tdsChart.update('none'); 
    }

    // Update Timestamp Koneksi
    const connEl = $('conn');
    if (connEl) {
        let ts = latest.timestamp;
        if (typeof ts === 'number' && ts > 1000000000000) { 
            ts = new Date(ts).toLocaleString();
        }
        connEl.textContent = `Terhubung | Update Terakhir: ${ts}`;
    }

    console.log(`✅ Data terbaru dimuat: ${latest.timestamp}`);
}


// =========================
// Kontrol Pompa Otomatis
// =========================
async function writePumpState(on, mode = 'AUTO', note = '') {
    try {
        await set(ref(db, PUMP_PATH), { on: !!on, mode, updatedAt: toISO(), ...(note ? { note } : {}) });
    } catch (e) { console.error('Gagal set status pompa:', e); }
}

function autoControlPump(ppm) {
    if (ppm == null || isNaN(ppm)) return;

    if (ppm < LOW_PPM && lastAutoDecision !== 'ON') {
        lastAutoDecision = 'ON';
        writePumpState(true, 'AUTO', `AUTO: ppm ${ppm} < ${LOW_PPM}`);
        logEvent(`Pompa ON (AUTO). ppm=${ppm} < ${LOW_PPM}`, { ppm, rule: 'LOW' });
    } else if (ppm > HIGH_PPM && lastAutoDecision !== 'OFF') {
        lastAutoDecision = 'OFF';
        writePumpState(false, 'AUTO', `AUTO: ppm ${ppm} > ${HIGH_PPM}`);
        logEvent(`Pompa OFF (AUTO). ppm=${ppm} > ${HIGH_PPM}`, { ppm, rule: 'HIGH' });
    }
}


// =========================
// Listener: Data Monitoring (Stabil dengan Query)
// =========================
const monitoringRef = ref(db, MONITORING_PATH);
const latestDataQuery = query(monitoringRef, limitToLast(1)); 
const initialChartQuery = query(monitoringRef, limitToLast(MAX_DATA_POINTS));


// --- Listener untuk DATA DASHBOARD REAL-TIME ---
onValue(latestDataQuery, (snapshot) => {
    const val = snapshot.val();
    if (!val) { console.warn("⚠️ Node 'monitoring' kosong."); return; }
    
    const entries = Object.values(val); 
    if (entries.length === 0) return;

    const latest = entries[0]; 
    
    renderSensors(latest); // Memperbarui kartu sensor
    
    const ppm = Math.round(Number(latest.kadarNutrisi) || 0);
    autoControlPump(ppm);
}, (error) => {
    console.error("❌ Listener data monitoring gagal:", error.message);
    if ($('conn')) $('conn').textContent = 'Koneksi Terputus';
});


// --- Listener KHUSUS UNTUK INISIALISASI GRAFIK (DISEMPURNAKAN) ---
// Menggunakan { onlyOnce: true } untuk memastikan ini hanya berjalan sekali
onValue(initialChartQuery, (snapshot) => {
    // BUG FIX: Menghapus baris snapshot.ref.off yang menyebabkan error pada SDK v9+
    // HAPUS BARIS INI: snapshot.ref.off('value', this); 

    const val = snapshot.val();
    if (!val) return;

    // Bersihkan data chart sebelum diisi
    chartData.labels = [];
    chartData.suhu = [];
    chartData.ph = [];
    chartData.tds = [];

    // Iterasi melalui data historis (maks 20)
    Object.values(val).forEach(entry => {
        // Asumsi entry.timestamp adalah UNIX epoch (milliseconds)
        let timeLabel = new Date(entry.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        chartData.labels.push(timeLabel);
        chartData.suhu.push(parseFloat(entry.suhu));
        chartData.ph.push(parseFloat(entry.phAir));
        chartData.tds.push(Math.round(Number(entry.kadarNutrisi) || 0));
    });

    // Setelah data terisi, inisialisasi dan gambar grafik
    if (typeof initCharts === 'function') {
        initCharts();
        console.log(`✅ Grafik dimuat dengan ${chartData.labels.length} poin data historis.`);
    }

}, { onlyOnce: true });


// =========================
// Listener: Status Pompa → UI
// =========================
onValue(ref(db, PUMP_PATH), (snapshot) => {
    const data = snapshot.val() || { on: false, mode: 'AUTO' };
    const isOn = !!data.on;

    if ($('status-pompa')) $('status-pompa').textContent = isOn ? 'Menyala' : 'Mati';

    const btnPompa = $('btn-pompa');
    if (btnPompa) {
        btnPompa.textContent = `Pompa Air: ${isOn ? 'ON' : 'OFF'}`;
        btnPompa.classList.toggle('active', isOn);
    }
});


// =========================
// Kontrol Manual & Ekspor
// =========================
document.addEventListener('DOMContentLoaded', () => {
    const btnPompa = $('btn-pompa');
    const btnDownload = $('btn-download');

    // INISIALISASI GRAFIK TIDAK DIPANGGIL DI SINI. 
    // Dipanggil di dalam listener initialChartQuery.

    // Toggle pompa MANUAL
    if (btnPompa) {
        btnPompa.addEventListener('click', async () => {
            // Ambil status pompa saat ini (hanya sekali)
            const snap = await new Promise((res) => onValue(ref(db, PUMP_PATH), (s) => res(s), { onlyOnce: true }));
            const curr = (snap.val() && !!snap.val().on) || false;
            const next = !curr;
            await writePumpState(next, 'MANUAL', `MANUAL toggle → ${next ? 'ON' : 'OFF'}`);
            logEvent(`Pompa ${next ? 'ON' : 'OFF'} (MANUAL)`);
        });
    }

    // Download CSV data monitoring
    if (btnDownload) {
        btnDownload.addEventListener('click', () => exportMonitoringCSV());
    }
});

// =========================
// Ekspor CSV Data Historis (DISEMPURNAKAN DENGAN PEMISAH TITIK KOMA)
// =========================
function exportMonitoringCSV() {
    const DELIMITER = ';'; // <-- Ganti pemisah koma (,) menjadi titik koma (;)

    onValue(ref(db, MONITORING_PATH), (snapshot) => {
        const val = snapshot.val();
        if (!val) {
            alert('Tidak ada data untuk diunduh.');
            return;
        }
        const rows = Object.values(val);
        
        // Header CSV
        const header = ['timestamp_readable', 'timestamp_raw', 'suhu', 'phAir', 'kadarNutrisi', 'statusSistem'];
        
        const csv = [
            header.join(DELIMITER), // Gunakan DELIMITER baru
            ...rows.map((r) =>
                [
                    // 1. TIMESTAMP YANG BISA DIBACA MANUSIA
                    new Date(Number(r.timestamp) || 0).toLocaleString('id-ID'),
                    
                    // 2. TIMESTAMP MENTAH (RAW)
                    r.timestamp || '',
                    
                    // 3. SUHU: Pastikan pemisah desimalnya kembali titik (.) karena pemisah kolomnya adalah titik koma (;)
                    Number(r.suhu ?? '').toString().replace(',', '.'), 
                    
                    // 4. PH: Pastikan pemisah desimalnya kembali titik (.)
                    Number(r.phAir ?? '').toString().replace(',', '.'),
                    
                    // 5. TDS/Kadar Nutrisi
                    Number(r.kadarNutrisi ?? ''),
                    
                    // 6. Status Sistem
                    r.statusSistem || '',
                ].join(DELIMITER) // Gunakan DELIMITER baru untuk memisahkan kolom
            ),
        ].join('\n');

        // Membuat file CSV dan memicu download
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `monitoring_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }, { onlyOnce: true });
}