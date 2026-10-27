let students = {};

const REKAP_EFFECTS_STORAGE_KEY = "sisensi_rekap_effects_enabled";
let rekapEffectsEnabled = true;
let previousRekapSnapshot = new Map();

// Helper tunggal penanganan API call dari Vercel ke Google Apps Script (GAS)
async function runGasApi(action, payload = {}) {
  try {
    const response = await fetch(GAS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...payload })
    });
    return await response.json();
  } catch (err) {
    console.error(`Error calling action ${action}:`, err);
    throw err;
  }
}

function loadRekapEffectsPreference() {
  try {
    const saved = localStorage.getItem(REKAP_EFFECTS_STORAGE_KEY);
    rekapEffectsEnabled = saved === null ? true : saved === "true";
  } catch (e) {
    rekapEffectsEnabled = true;
  }
  applyRekapEffectsPreference();
}

function applyRekapEffectsPreference() {
  document.body.classList.toggle("effects-enabled", rekapEffectsEnabled);
  document.body.classList.toggle("effects-disabled", !rekapEffectsEnabled);
  const button = document.getElementById("effectsToggleBtn");
  if (!button) return;
  button.textContent = "🌟";
  button.setAttribute("aria-label", rekapEffectsEnabled ? "Animasi aktif" : "Animasi nonaktif");
  button.classList.toggle("effects-on", rekapEffectsEnabled);
  button.classList.toggle("effects-off", !rekapEffectsEnabled);
  button.setAttribute("aria-pressed", String(rekapEffectsEnabled));
  button.title = rekapEffectsEnabled
    ? "Animasi presensi aktif"
    : "Animasi presensi nonaktif";
}

function toggleRekapEffects() {
  rekapEffectsEnabled = !rekapEffectsEnabled;
  try {
    localStorage.setItem(REKAP_EFFECTS_STORAGE_KEY, String(rekapEffectsEnabled));
  } catch (e) {}
  applyRekapEffectsPreference();
  if (!rekapEffectsEnabled) captureRekapSnapshot();

  if (rekapEffectsEnabled) {
    showToast("Efek animasi presensi aktif!", "success");
  } else {
    showToast("Efek animasi presensi nonaktif.", "info");
  }
}

function captureRekapSnapshot() {
  const container = document.getElementById("kelasListContainer");
  const snapshot = new Map();
  if (!container) return snapshot;

  container.querySelectorAll(".tingkat-column").forEach(column => {
    const level = (column.querySelector(".tingkat-column-title")?.textContent || "")
      .replace(/^Rekap Kelas\s+/i, "").trim().toUpperCase();
    const cards = Array.from(column.querySelectorAll(".kelas-item-compact[data-kelas-id]"));
    cards.forEach((card, rankIndex) => {
      const id = card.dataset.kelasId;
      if (!id) return;
      snapshot.set(id, {
        top: card.getBoundingClientRect().top,
        left: card.getBoundingClientRect().left,
        hadir: Number(card.dataset.hadir || 0),
        level,
        rankIndex
      });
    });
  });
  return snapshot;
}

function animateRekapChanges(previousSnapshot) {
  const container = document.getElementById("kelasListContainer");
  if (!container) return;
  const currentSnapshot = new Map();

  container.querySelectorAll(".tingkat-column").forEach(column => {
    const level = (column.querySelector(".tingkat-column-title")?.textContent || "")
      .replace(/^Rekap Kelas\s+/i, "").trim().toUpperCase();
    const cards = Array.from(column.querySelectorAll(".kelas-item-compact[data-kelas-id]"));

    cards.forEach((card, rankIndex) => {
      const id = card.dataset.kelasId;
      if (!id) return;
      const old = previousSnapshot && previousSnapshot.get(id);
      const rect = card.getBoundingClientRect();
      const current = {
        top: rect.top,
        left: rect.left,
        hadir: Number(card.dataset.hadir || 0),
        level,
        rankIndex
      };
      currentSnapshot.set(id, current);

      if (!rekapEffectsEnabled || !old) return;

      const dx = old.left - rect.left;
      const dy = old.top - rect.top;
      const sameLevel = old.level === current.level;
      const rankChanged = sameLevel && old.rankIndex !== current.rankIndex;

      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        card.style.transition = "none";
        card.style.transform = `translate(${dx}px, ${dy}px)`;
        card.getBoundingClientRect();
        requestAnimationFrame(() => {
          if (!rekapEffectsEnabled || !card.isConnected) return;
          card.style.transition = "transform 380ms cubic-bezier(0.2, 0.75, 0.25, 1), background 300ms ease, border-color 300ms ease, box-shadow 300ms ease";
          card.style.transform = "translate(0, 0)";
          window.setTimeout(() => {
            if (card.isConnected) {
              card.style.removeProperty("transform");
              card.style.removeProperty("transition");
            }
          }, 420);
        });
      }

      if (rankChanged) {
        const rankClass = current.rankIndex < old.rankIndex ? "is-moving-up" : "is-moving-down";
        card.classList.remove("is-moving-up", "is-moving-down");
        void card.offsetWidth;
        card.classList.add(rankClass);
        window.setTimeout(() => {
          if (card.isConnected) card.classList.remove("is-moving-up", "is-moving-down");
        }, 650);
      }

      if (current.hadir > old.hadir) {
        card.classList.remove("attendance-pulse");
        void card.offsetWidth;
        card.classList.add("attendance-pulse");
        card.addEventListener("animationend", () => card.classList.remove("attendance-pulse"), { once: true });
      }
    });
  });
  previousRekapSnapshot = currentSnapshot;
}

let progress = 0;
let clearTimer;
let syncTimer = null;

let totalHadir = 0;
let totalPulang = 0;
let sudahHadirHariIni = new Set();
let sudahPulangHariIni = new Set();
let isSyncing = false;
let offlineScansCache = [];

function updateOfflineScansCache() {
  try {
    offlineScansCache = JSON.parse(localStorage.getItem("offline_scans") || "[]");
  } catch (e) {
    offlineScansCache = [];
  }
}
updateOfflineScansCache();

let activeConfig = {
  isKhusus: false,
  default: {
    jamMasuk: "06:45",
    batasTerlambat: 30,
    batasSangatTerlambat: 60,
    batasSangatTerlambatSekali: 90,
    jamPulang: "11:00"
  },
  byLevel: {},
  allowedLevels: ["X", "XI", "XII"]
};

let countsJurusan = {
  AKUNTANSI: 0, DKV: 0, FARMASI: 0, KULINER: 0,
  RPL: 0, TKR: 0, TKJ: 0, TPM: 0, TSM: 0
};

let totalSiswaPerJurusan = {
  AKUNTANSI: 0, DKV: 0, FARMASI: 0, KULINER: 0,
  RPL: 0, TKR: 0, TKJ: 0, TPM: 0, TSM: 0
};

const input = document.getElementById("nis");
const LOGO_SEKOLAH = "assets/logo_medcom.png";

function updateProgress(val) {
  document.getElementById("bar").style.width = val + "%";
  document.getElementById("progressText").innerText = val + "%";
}

function loadStudents() {
  const fakeProgress = setInterval(() => {
    if (progress < 90) {
      progress += 5;
      updateProgress(progress);
    }
  }, 100);

  runGasApi("getScannerDashboardData")
    .then(data => {
      clearInterval(fakeProgress);

      if (!data || data.success === false) {
        console.error("Gagal memuat data siswa:", data);
        showCustomAlert("⚠️", (data && data.message) || "Server gagal memuat data siswa.");
        return;
      }

      students = data.students || {};

      if (data.configHariIni) {
        activeConfig = data.configHariIni;
        window.scannerDefaultConfig = JSON.parse(JSON.stringify(data.configHariIni));
      }

      loadLocalOverrideJam();

      totalHadir = Number(data.totalHadirAwal || 0);
      const totalHadirEl = document.getElementById("totalHadirText");
      if (totalHadirEl) totalHadirEl.innerText = totalHadir;

      if (Array.isArray(data.listHadirAwal)) {
        sudahHadirHariIni = new Set(data.listHadirAwal.map(item => typeof item === "object" ? String(item.nis) : String(item)));
        window.serverEarlyBirds = data.listHadirAwal;
      } else {
        sudahHadirHariIni = new Set();
        window.serverEarlyBirds = [];
      }

      totalPulang = Number(data.totalPulangAwal || 0);
      const totalPulangEl = document.getElementById("totalPulangText");
      if (totalPulangEl) totalPulangEl.innerText = totalPulang;

      if (Array.isArray(data.listPulangAwal)) {
        sudahPulangHariIni = new Set(data.listPulangAwal.map(item => typeof item === "object" ? String(item.nis) : String(item)));
      } else {
        sudahPulangHariIni = new Set();
      }

      if (data.totalSiswaPerJurusan) totalSiswaPerJurusan = data.totalSiswaPerJurusan;

      if (data.perJurusanAwal) {
        Object.keys(countsJurusan).forEach(key => { countsJurusan[key] = Number(data.perJurusanAwal[key]) || 0; });
        renderJurusanUI();
      }

      if (typeof renderHallOfFameUI === "function") renderHallOfFameUI();
      updateActiveLevelsBadge();

      progress = 100;
      updateProgress(100);

      setTimeout(() => {
        Object.keys(students).forEach(nis => {
          if (students[nis].photo) {
            const imgCache = new Image();
            imgCache.src = students[nis].photo;
            if (imgCache.decode) imgCache.decode().catch(() => {});
          }
        });
      }, 500);

      setTimeout(() => {
        const loader = document.getElementById("loader");
        const scanArea = document.getElementById("scanArea");
        if (loader) loader.style.display = "none";
        if (scanArea) scanArea.style.display = "grid";
        if (input) input.focus();
        updateOfflineBadge();
        setTimeout(autoSyncIfOnline, 2000);
      }, 300);

      // RINCIAN LOG BREAKDOWN REGULER VS TEMPORER
      const totalSemua = Object.keys(students).length;
      let countTemporer = 0;

      Object.values(students).forEach(s => {
        if (s.jamMasukKhusus || s.jamPulangKhusus) {
          countTemporer++;
        }
      });

      const countReguler = totalSemua - countTemporer;

      console.log(
        `✅ Data siswa berhasil dimuat: Total ${totalSemua} siswa ` +
        `(${countReguler} Reguler, ${countTemporer} Temporer/Jadwal Khusus)`
      );
    })
    .catch(error => {
      clearInterval(fakeProgress);
      console.error("❌ Error loadStudents:", error);
      const loader = document.getElementById("loader");
      if (loader) loader.style.display = "none";
      showCustomAlert("❌", "Gagal mengambil data siswa dari server. Periksa koneksi dan fungsi backend.");
    });
}

window.onload = loadStudents;

function extractTingkatFromKelas(kelasStr) {
  if (!kelasStr) return "";
  const k = String(kelasStr).toUpperCase().trim();
  if (k.includes("XII") || k.includes(" 12") || k.includes("-12") || k.startsWith("XII") || k.startsWith("12")) return "XII";
  if (k.includes("XI") || k.includes(" 11") || k.includes("-11") || k.startsWith("XI") || k.startsWith("11")) return "XI";
  if (k.includes("X") || k.includes(" 10") || k.includes("-10") || k.startsWith("X") || k.startsWith("10")) return "X";
  return "";
}

/* ==========================================================================
   SINGLE-FUNCTION INPUT PROTECTION SYSTEM
   ========================================================================== */
window.scannerProtectionConfig = window.scannerProtectionConfig || {
  manualInput: true,
  autoDelete: true,
  paste: true,
  dragDrop: true,
  clipboardShortcut: true
};

(function initInputProtectionSystem() {
  if (!input) return;

  const MAX_KEY_GAP_MS = 120;
  const IDLE_CLEAR_MS = 1000;
  let lastKeyAt = 0;
  let idleClearTimer = null;

  function clearIdleTimer() {
    if (idleClearTimer !== null) {
      clearTimeout(idleClearTimer);
      idleClearTimer = null;
    }
  }

  function resetInput() {
    clearIdleTimer();
    input.value = "";
    lastKeyAt = 0;
  }

  function inputProtection(e, eventType) {
    const cfg = window.scannerProtectionConfig || {};

    switch (eventType) {
      case "paste":
        if (cfg.paste) {
          e.preventDefault();
          resetInput();
        }
        break;

      case "drop":
        if (cfg.dragDrop) {
          e.preventDefault();
          resetInput();
        }
        break;

      case "contextmenu":
        if (cfg.paste || cfg.clipboardShortcut) {
          e.preventDefault();
        }
        break;

      case "keydown": {
        const key = String(e.key || "").toLowerCase();
        const isPaste = cfg.paste && ((e.ctrlKey || e.metaKey) && key === "v" || (e.shiftKey && key === "insert"));
        const isCopyCut = cfg.clipboardShortcut && (e.ctrlKey || e.metaKey) && (key === "c" || key === "x");

        if (isPaste || isCopyCut) {
          e.preventDefault();
          e.stopPropagation();
          resetInput();
          return;
        }

        const isCharKey = e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (!isCharKey && e.key !== "Enter") return;

        const now = performance.now();
        const gap = lastKeyAt ? now - lastKeyAt : 0;

        if (cfg.manualInput && input.value.length > 0 && lastKeyAt && gap > MAX_KEY_GAP_MS) {
          resetInput();
          if (e.key === "Enter") e.preventDefault();
          return;
        }

        if (e.key === "Enter") {
          clearIdleTimer();
          lastKeyAt = 0;
          return;
        }

        lastKeyAt = now;
        break;
      }

      case "input":
        if ((e.inputType === "insertFromPaste" && cfg.paste) || 
            (e.inputType === "insertFromDrop" && cfg.dragDrop)) {
          resetInput();
          return;
        }

        clearIdleTimer();
        if (input.value && cfg.autoDelete) {
          idleClearTimer = setTimeout(() => {
            if (input.value.trim()) resetInput();
          }, IDLE_CLEAR_MS);
        }
        break;
    }
  }

  ["paste", "drop", "contextmenu", "input"].forEach(evt => {
    input.addEventListener(evt, (e) => inputProtection(e, evt));
  });

  input.addEventListener("keydown", (e) => inputProtection(e, "keydown"), true);
})();

input.addEventListener("keydown", function(e) {
  if (e.key === "Enter") {
    e.preventDefault(); 
    if (isSyncing) return;

    const nis = input.value.trim();
    if (!nis) return;

    if (!students || !students[nis]) {
      console.warn(`⚠️ QR/NIS [${nis}] tidak ditemukan!`);
      showError("QR tidak valid atau siswa tidak aktif");
      input.value = "";
      return;
    }

    try {
      const rawStudentData = students[nis] || {};
      const name = rawStudentData.name || "Siswa";
      const kelas = rawStudentData.class || rawStudentData.kelas || "";
      const photo = rawStudentData.photo || ""; 
      
      let tingkat = rawStudentData.tingkat || extractTingkatFromKelas(kelas);

      const now = new Date();
      const time = now.toTimeString().split(' ')[0]; 
      
      // PERBAIKAN DI BARIS INI: Kirim rawStudentData sebagai argumen ke-3
      const statusInfo = calculateScanStatus(now, tingkat, rawStudentData);

      showSuccess(nis, name, kelas, tingkat, time, photo, statusInfo);
      input.value = "";

      const scanTimestamp = now.toISOString();
      const statusScan = statusInfo.isPulang ? "PULANG" : "MASUK";
      const statusPresensi = statusInfo.code;

      saveOfflineScan(
        nis,
        scanTimestamp,
        statusScan,
        statusPresensi
      );

      triggerBackgroundSync();

    } catch (err) {
      console.error("❌ [CRITICAL SCAN ERROR]", err);
      showError("Terjadi kesalahan sistem JS: " + (err.message || err));
      input.value = "";
    }
  }
});

function calculateScanStatus(nowDate, tingkatSiswa, rawStudentObj) {
  const jam = String(nowDate.getHours()).padStart(2, '0');
  const menit = String(nowDate.getMinutes()).padStart(2, '0');
  const timeStr = `${jam}:${menit}`;

  let levelKey = String(tingkatSiswa || "").toUpperCase().trim();
  if (levelKey === "10" || levelKey === "1") levelKey = "X";
  else if (levelKey === "11" || levelKey === "2") levelKey = "XI";
  else if (levelKey === "12" || levelKey === "3") levelKey = "XII";

  if (!["X", "XI", "XII"].includes(levelKey)) {
    levelKey = extractTingkatFromKelas(tingkatSiswa);
  }

  let jMasuk = "06:45";
  let jPulang = "11:00";

  // PRIORITAS 1: Pakai Jam Khusus Personal jika ada (dari Master Temporer)
  if (rawStudentObj && rawStudentObj.jamMasukKhusus && rawStudentObj.jamPulangKhusus) {
    jMasuk = rawStudentObj.jamMasukKhusus;
    jPulang = rawStudentObj.jamPulangKhusus;
  } 
  // PRIORITAS 2: Pakai Config Jam Harian / Per Tingkat
  else if (activeConfig) {
    if (activeConfig.default) {
      jMasuk = activeConfig.default.jamMasuk || jMasuk;
      jPulang = activeConfig.default.jamPulang || jPulang;
    }
    if (activeConfig.byLevel && activeConfig.byLevel[levelKey]) {
      jMasuk = activeConfig.byLevel[levelKey].jamMasuk || jMasuk;
      jPulang = activeConfig.byLevel[levelKey].jamPulang || jPulang;
    }
  }

  if (jMasuk.length > 5) jMasuk = jMasuk.substring(0, 5);
  if (jPulang.length > 5) jPulang = jPulang.substring(0, 5);

  if (timeStr >= jPulang) {
    return { code: "VALID_PULANG", label: "👋 Hati-Hati di Jalan", color: "#2563eb", isPulang: true };
  }

  if (timeStr <= jMasuk) {
    return { code: "TEPAT_WAKTU", label: "✅ Tepat Waktu", color: "#16a34a", isPulang: false };
  }

  const [hM, mM] = jMasuk.split(":").map(Number);
  const [hS, mS] = timeStr.split(":").map(Number);
  const diffMinutes = (hS * 60 + mS) - (hM * 60 + mM);

  const bTerlambat = (activeConfig.default && activeConfig.default.batasTerlambat) || 30;
  const bSangatTerlambat = (activeConfig.default && activeConfig.default.batasSangatTerlambat) || 60;

  if (diffMinutes <= bTerlambat) {
    return { code: "TERLAMBAT", label: "⚠️ Terlambat", color: "#ca8a04", isPulang: false };
  } else if (diffMinutes <= bSangatTerlambat) {
    return { code: "SANGAT_TERLAMBAT", label: "⚠️ Sangat Terlambat", color: "#ea580c", isPulang: false };
  } else {
    return { code: "SANGAT_TERLAMBAT_SEKALI", label: "🚨 Sangat Terlambat Sekali", color: "#dc2626", isPulang: false };
  }
}

function createInitialAvatarDataUrl(name) {
  const canvas = document.createElement("canvas");
  canvas.width = 300;
  canvas.height = 400;
  const ctx = canvas.getContext("2d");

  // Background Gradient
  const gradient = ctx.createLinearGradient(0, 0, 300, 400);
  gradient.addColorStop(0, "#1e3a8a"); // Navy
  gradient.addColorStop(1, "#2563eb"); // Blue
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 300, 400);

  // Text Inisial (Huruf Pertama Nama)
  const initial = name ? name.trim().charAt(0).toUpperCase() : "?";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 130px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initial, 150, 200);

  return canvas.toDataURL("image/png");
}

function showSuccess(nis, name, kelas, tingkat, time, photo, statusInfo) {
  const isPulang = statusInfo.isPulang;

  let urutanScan = 1;
  if (isPulang) {
    if (!sudahPulangHariIni.has(nis)) {
      sudahPulangHariIni.add(nis);
      totalPulang += 1;
      const totalPulangEl = document.getElementById("totalPulangText");
      if (totalPulangEl) totalPulangEl.innerText = totalPulang;
    }
    urutanScan = totalPulang;
  } else {
    if (!sudahHadirHariIni.has(nis)) {
      sudahHadirHariIni.add(nis);
      totalHadir += 1;
      document.getElementById("totalHadirText").innerText = totalHadir;
      updateJurusanCount(kelas, tingkat);
    }
    urutanScan = totalHadir;
  }

  const idleBox = document.getElementById("idleBox");
  const scanBox = document.getElementById("scanResultBox");
  const photoImg = document.getElementById("scanPhotoImg");
  const badgeEl = document.getElementById("scanBadge");
  const statusAlertEl = document.getElementById("scanStatusAlert");
  const nameEl = document.getElementById("scanStudentName");
  const classEl = document.getElementById("scanStudentClass");
  const timeEl = document.getElementById("scanTimeDigital");

  // LOGIKA AVATAR INISIAL FALLBACK
  const initialAvatar = createInitialAvatarDataUrl(name);
  photoImg.onerror = function() { this.src = initialAvatar; };
  photoImg.src = photo && photo.trim() !== "" ? photo : initialAvatar;

  const badgeLabel = isPulang ? `📤 PRESENSI PULANG • KE-${urutanScan}` : `📥 PRESENSI MASUK • KE-${urutanScan}`;
  const badgeClass = isPulang ? "badge-pulang" : "badge-masuk";

  badgeEl.className = `scan-badge-top ${badgeClass}`;
  badgeEl.innerText = badgeLabel;

  statusAlertEl.style.color = statusInfo.color;
  statusAlertEl.innerText = statusInfo.label;

  nameEl.innerText = name.toUpperCase();
  
  // PENYESUAIAN MODULAR TEKS KELAS/ROMBEL:
  const isCustomRombel = kelas.includes("-") || /sesi|lab|ruang/i.test(kelas);
  classEl.innerText = isCustomRombel ? kelas : formatNamaKelas(kelas, tingkat);

  timeEl.style.color = statusInfo.color;
  timeEl.innerText = `${time} WIB`;

  idleBox.style.display = "none";
  scanBox.style.display = "flex";

  flashSuccess();

  setTimeout(() => {
    if (typeof renderHallOfFameUI === "function") renderHallOfFameUI();
    if (typeof renderJurusanUI === "function") renderJurusanUI();
  }, 50);

  clearResultLater();
}

function clearResultLater() {
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    const idleBox = document.getElementById("idleBox");
    const scanBox = document.getElementById("scanResultBox");

    if (idleBox && scanBox) {
      scanBox.style.display = "none";
      idleBox.style.display = "flex";
    }
  }, 4000); 
}

function saveOfflineScan(nis, timeISO, statusScan, statusPresensi) {
  try {
    offlineScansCache.push({
      nis: nis,
      timestamp: timeISO,
      statusScan: statusScan,
      statusPresensi: statusPresensi,
      sent: false
    });

    localStorage.setItem(
      "offline_scans",
      JSON.stringify(offlineScansCache)
    );

    updateOfflineBadge();
  } catch (e) {
    console.error("⚠️ LocalStorage Penuh/Error:", e);
    offlineScansCache = offlineScansCache.filter(
      item => item.sent === false
    );

    try {
      localStorage.setItem(
        "offline_scans",
        JSON.stringify(offlineScansCache)
      );
    } catch (err) {}
  }
}

function markScanAsSentInLocalStorage(nis, timestamp) {
  offlineScansCache = offlineScansCache.map(item => {
    if (item.nis === nis && item.timestamp === timestamp) { item.sent = true; }
    return item;
  });
  localStorage.setItem("offline_scans", JSON.stringify(offlineScansCache));
  updateOfflineBadge();
}

function downloadLocalStorageBackup() {
  if (!offlineScansCache || offlineScansCache.length === 0) {
    showToast("Tidak ada data antrean offline saat ini!", "warning");
    return;
  }

  let csvContent = "data:text/csv;charset=utf-8,NIS,Nama,Kelas,Tingkat,Tanggal,Jam,Status_Scan,Status_Kirim\n";

  offlineScansCache.forEach(item => {
    const stringNis = String(item.nis || "").trim();
    const student = (typeof students !== "undefined" && students) ? students[stringNis] : {};
    
    const nama = student.name || "Siswa";
    const kelas = student.class || student.kelas || "";
    const tingkat = student.tingkat || extractTingkatFromKelas(kelas);

    const scanDate = item.timestamp ? new Date(item.timestamp) : new Date();
    const tanggalStr = getLocalDateString(scanDate);
    const jamStr = `${String(scanDate.getHours()).padStart(2, "0")}:${String(scanDate.getMinutes()).padStart(2, "0")}:${String(scanDate.getSeconds()).padStart(2, "0")}`;

    const statusKirim = item.sent ? "TERKIRIM" : "PENDING";

    const row = [
      `"${stringNis}"`,
      `"${nama}"`,
      `"${kelas}"`,
      `"${tingkat}"`,
      `"${tanggalStr}"`,
      `"${jamStr}"`,
      `"${item.statusScan || 'MASUK'}"`,
      `"${statusKirim}"`
    ].join(",");

    csvContent += row + "\n";
  });

  const encodedUri = encodeURI(csvContent);
  const downloadAnchor = document.createElement('a');
  const todayStr = getLocalDateString();
  downloadAnchor.setAttribute("href", encodedUri);
  downloadAnchor.setAttribute("download", `pool_raw_backup_${todayStr}.csv`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  document.body.removeChild(downloadAnchor);
  
  showToast("File backup pool_raw BERHASIL diunduh!", "success");
}

function updateOfflineBadge() {
  let pendingItems = offlineScansCache.filter(item => item.sent === false);

  const statusBar = document.getElementById("statusBar");
  const statusText = document.getElementById("statusText");

  if (!statusBar || !statusText) return;

  if (pendingItems.length > 0) {
    statusText.innerHTML = `🟠 Syncing (${pendingItems.length})`;
    statusBar.className = "sync-btn-active";
  } else {
    statusBar.className = "";
    if (navigator.onLine) {
      statusText.innerHTML = "🟢 Online";
      statusText.className = "online";
    } else {
      statusText.innerHTML = "🔴 Offline";
      statusText.className = "offline";
    }
  }
}

function handleSyncButtonClick() {
  if (!navigator.onLine) {
    showToast("Koneksi Terputus! Periksa jaringan internet kamu.", "error");
    return;
  }

  let pendingItems = offlineScansCache.filter(item => item.sent === false);

  if (pendingItems.length === 0) {
    showToast("Semua data presensi sudah tersinkronisasi!", "info");
    return;
  }

  syncOfflineData();
}

function autoSyncIfOnline() {
  if (offlineScansCache.length > 0 && navigator.onLine && !isSyncing) {
    syncOfflineData();
  }
}

let isBackgroundSyncing = false;

function triggerBackgroundSync() {
  syncOfflineData(); 
}

function syncOfflineData() {
  if (isBackgroundSyncing || !navigator.onLine) return;

  updateOfflineScansCache();

  const pendingItems = offlineScansCache.filter(item => item.sent === false);

  if (pendingItems.length === 0) {
    updateOfflineBadge();
    return;
  }

  isBackgroundSyncing = true;
  const currentItem = pendingItems[0];

  const payload = {
    id_siswa: String(currentItem.nis || "").trim(),
    timeISO: currentItem.timestamp,
    status_scan: String(currentItem.statusScan || "").toUpperCase(),
    status_presensi: String(currentItem.statusPresensi || "").toUpperCase()
  };

  runGasApi("scannerRecordScan", { payload })
    .then(res => {
      isBackgroundSyncing = false;

      if (res && res.success) {
        markScanAsSentInLocalStorage(currentItem.nis, currentItem.timestamp);
        updateOfflineScansCache();
        updateOfflineBadge();
        setTimeout(syncOfflineData, 100);
        return;
      }

      console.error("Scan gagal diproses:", res);

      if (res && ["INVALID_PAYLOAD", "EMPTY_ID", "INVALID_STATUS_SCAN", "STUDENT_NOT_FOUND", "INVALID_TIMESTAMP"].includes(res.reason)) {
        showToast("Scan ditolak server. Periksa ID dan status scan.", "error");
        return;
      }

      setTimeout(syncOfflineData, 5000);
    })
    .catch(err => {
      isBackgroundSyncing = false;
      console.error("Gagal mengirim antrean scan:", err);
      setTimeout(syncOfflineData, 5000);
    });
}

function showSettingsLoading(text) {
  const modalBox = document.querySelector("#settingsModal .settings-modal-box");
  const overlay = document.querySelector("#settingsModal .settings-loading-overlay");
  const textEl = document.querySelector("#settingsModal .settings-loading-text");
  
  if (textEl && text) textEl.textContent = text;
  if (modalBox) modalBox.classList.add("is-loading-state");
  if (overlay) overlay.classList.add("active");
}

function hideSettingsLoading(restorePrevious) {
  const modalBox = document.querySelector("#settingsModal .settings-modal-box");
  const overlay = document.querySelector("#settingsModal .settings-loading-overlay");
  
  if (overlay) overlay.classList.remove("active");
  if (modalBox) modalBox.classList.remove("is-loading-state");
}

function setModalMode(mode) {
  const modal = document.getElementById("settingsModal");
  if (!modal) return;
  modal.classList.toggle("pin-mode", mode === "pin");
  modal.classList.toggle("settings-mode", mode === "settings");
}

function openSettingsModal() {
  hideSettingsLoading(true);
  renderConfigJamToggle();
  window.settingsAccessRole = "";
  window.settingsAdminToken = "";
  applySettingsRoleAccess("petugas");
  setModalMode("pin");
  document.getElementById("pinStep").style.display = "block";
  document.getElementById("formStep").style.display = "none";
  document.getElementById("pinInput").value = "";
  document.getElementById("settingsModal").classList.add("active");
  setTimeout(() => { document.getElementById("pinInput").focus(); }, 200);
}

function closeSettingsModal() {
  hideSettingsLoading(true);
  document.getElementById("settingsModal").classList.remove("active");
  
  // Refresh indikator sesuai config yang benar-benar tersimpan
  updateConfigIndicators();
  
  setTimeout(() => { input.focus(); }, 200);
}

function verifyPin() {
  const pin = document.getElementById("pinInput").value.trim();
  if (!pin) { showToast("Masukkan PIN petugas terlebih dahulu.", "warning"); return; }

  showSettingsLoading("Memverifikasi PIN...");

  runGasApi("scannerVerifySettingsPin", { pin })
    .then(result => {
      if (!result || !result.success) {
        hideSettingsLoading(true);
        showToast((result && result.message) || "PIN petugas salah. Akses ditolak.", "error");
        document.getElementById("pinInput").select();
        return;
      }
      
      window.settingsAccessRole = result.role || "petugas";
      window.settingsAdminToken = result.token || "";
      applySettingsRoleAccess(window.settingsAccessRole);

      const jamMG = (activeConfig.default && activeConfig.default.jamMasuk) || activeConfig.jamMasuk || "06:45";
      const jamPG = (activeConfig.default && activeConfig.default.jamPulang) || activeConfig.jamPulang || "11:00";

      document.getElementById("cfgJamMasukGlobal").value = jamMG;
      document.getElementById("cfgTerlambatGlobal").value = (activeConfig.default && activeConfig.default.batasTerlambat) || activeConfig.batasTerlambat || 30;
      document.getElementById("cfgSangatTerlambatGlobal").value = (activeConfig.default && activeConfig.default.batasSangatTerlambat) || activeConfig.batasSangatTerlambat || 60;
      document.getElementById("cfgSangatTerlambatSekaliGlobal").value = (activeConfig.default && activeConfig.default.batasSangatTerlambatSekali) || activeConfig.batasSangatTerlambatSekali || 90;
      document.getElementById("cfgJamPulangGlobal").value = jamPG;

      const byLevel = activeConfig.byLevel || {};
      document.getElementById("cfgJamMasukX").value = (byLevel["X"] && byLevel["X"].jamMasuk) ? byLevel["X"].jamMasuk : "";
      document.getElementById("cfgJamPulangX").value = (byLevel["X"] && byLevel["X"].jamPulang) ? byLevel["X"].jamPulang : "";
      document.getElementById("cfgJamMasukXI").value = (byLevel["XI"] && byLevel["XI"].jamMasuk) ? byLevel["XI"].jamMasuk : "";
      document.getElementById("cfgJamPulangXI").value = (byLevel["XI"] && byLevel["XI"].jamPulang) ? byLevel["XI"].jamPulang : "";
      document.getElementById("cfgJamMasukXII").value = (byLevel["XII"] && byLevel["XII"].jamMasuk) ? byLevel["XII"].jamMasuk : "";
      document.getElementById("cfgJamPulangXII").value = (byLevel["XII"] && byLevel["XII"].jamPulang) ? byLevel["XII"].jamPulang : "";

      switchTab('configJam');
      switchTimeTab('global');

      loadProtectionSettings(function() {
        hideSettingsLoading(false);
        setModalMode("settings");
        
        document.getElementById("pinStep").style.display = "none";
        document.getElementById("formStep").style.display = "flex";

        renderConfigJamToggle();
      });
    })
    .catch(err => {
      hideSettingsLoading(true);
      showToast("Verifikasi PIN gagal. Periksa koneksi backend.", "error");
      console.error(err);
    });
}

function applySettingsRoleAccess(role) {
  const protectionTab = document.getElementById("tabBtn-proteksi");
  const isSuperAdmin = role === "superadmin";

  if (protectionTab) {
    protectionTab.style.display = isSuperAdmin ? "" : "none";
  }

  const isProtectiveDisabled = !isSuperAdmin;
  document.querySelectorAll("#tabContent-proteksi input, #tabContent-proteksi button").forEach(el => {
    el.disabled = isProtectiveDisabled;
    if (el.classList.contains("protection-check-row")) {
      el.classList.toggle("is-disabled", isProtectiveDisabled);
    }
  });

  if (!isSuperAdmin && document.getElementById("tabContent-proteksi")?.style.display !== "none") {
    switchTab("configJam");
  }
}

function requestSuperAdminAccess(callback) {
  const pin = prompt("Masukkan PIN Super Admin untuk membuka Config Proteksi:");
  if (!pin) return;

  runGasApi("scannerVerifySuperAdminPin", { pin })
    .then(result => {
      if (!result || !result.success || result.role !== "superadmin") {
        showToast("PIN Super Admin salah. Akses ditolak.", "error");
        return;
      }
      window.settingsAccessRole = "superadmin";
      window.settingsAdminToken = result.token || "";
      applySettingsRoleAccess("superadmin");
      if (typeof callback === "function") callback();
    })
    .catch(err => {
      showToast("Verifikasi Super Admin gagal.", "error");
      console.error(err);
    });
}

function loadProtectionSettings(onComplete) {
  showSettingsLoading("Memuat konfigurasi...");

  runGasApi("scannerGetProtectionSettings")
    .then(result => {
      // Prioritas 1: Server GAS | Prioritas 2: LocalStorage | Prioritas 3: Default ON (semua true)
      let serverConfig = (result && result.success && result.config) ? result.config : null;

      if (!serverConfig || Object.keys(serverConfig).length === 0) {
        try {
          serverConfig = JSON.parse(localStorage.getItem("scanner_protection_config") || "null");
        } catch (e) {}
      }

      // Pastikan jika data belum pernah disimpan, SEMUA item bernilai true (ON) secara default
      const finalConfig = {
        manualInput: serverConfig && serverConfig.manualInput !== undefined ? !!serverConfig.manualInput : true,
        autoDelete: serverConfig && serverConfig.autoDelete !== undefined ? !!serverConfig.autoDelete : true,
        paste: serverConfig && serverConfig.paste !== undefined ? !!serverConfig.paste : true,
        dragDrop: serverConfig && serverConfig.dragDrop !== undefined ? !!serverConfig.dragDrop : true,
        clipboardShortcut: serverConfig && serverConfig.clipboardShortcut !== undefined ? !!serverConfig.clipboardShortcut : true
      };

      // 1. ISIKAN STATUS CHECKBOX KE HTML
      const ids = {
        manualInput: "cfgProtectManualInput",
        autoDelete: "cfgProtectAutoDelete",
        paste: "cfgProtectPaste",
        dragDrop: "cfgProtectDragDrop",
        clipboardShortcut: "cfgProtectClipboardShortcut"
      };

      Object.keys(ids).forEach(function(key) {
        const el = document.getElementById(ids[key]);
        if (el) el.checked = finalConfig[key] === true;
      });

      // 2. SIMPAN & WAPPERKAN KE GLOBAL STATE SCANNER
      applyScannerProtectionSettings(finalConfig);
      localStorage.setItem("scanner_protection_config", JSON.stringify(finalConfig));

      // 3. PAKSA UI SWITCH (OFF/ON) MENYESUAIKAN STATUS CHECKBOX SECARA LANGSUNG
      updateProtectionStatusUI();

      if (typeof onComplete === "function") {
        onComplete();
      } else {
        hideSettingsLoading(true);
      }
    })
    .catch(err => { 
      hideSettingsLoading(true); 
      console.error("Gagal memuat konfigurasi proteksi", err);

      // Fallback jika koneksi RTO: Paksa Centang Berdasarkan Cache Lokal / Default ON
      const cached = JSON.parse(localStorage.getItem("scanner_protection_config") || "{}");
      const fallbackConfig = {
        manualInput: cached.manualInput !== undefined ? !!cached.manualInput : true,
        autoDelete: cached.autoDelete !== undefined ? !!cached.autoDelete : true,
        paste: cached.paste !== undefined ? !!cached.paste : true,
        dragDrop: cached.dragDrop !== undefined ? !!cached.dragDrop : true,
        clipboardShortcut: cached.clipboardShortcut !== undefined ? !!cached.clipboardShortcut : true
      };

      ["cfgProtectManualInput", "cfgProtectAutoDelete", "cfgProtectPaste", "cfgProtectDragDrop", "cfgProtectClipboardShortcut"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = true;
      });

      applyScannerProtectionSettings(fallbackConfig);
      updateProtectionStatusUI();

      if (typeof onComplete === "function") onComplete();
    });
}

function saveProtectionSettings() {
  if (window.settingsAccessRole !== "superadmin") {
    showToast("Hanya Super Admin yang dapat menyimpan proteksi.", "warning");
    return false;
  }
  
  const config = {
    manualInput: !!document.getElementById("cfgProtectManualInput")?.checked,
    autoDelete: !!document.getElementById("cfgProtectAutoDelete")?.checked,
    paste: !!document.getElementById("cfgProtectPaste")?.checked,
    dragDrop: !!document.getElementById("cfgProtectDragDrop")?.checked,
    clipboardShortcut: !!document.getElementById("cfgProtectClipboardShortcut")?.checked
  };

  showSettingsLoading("Menyimpan konfigurasi proteksi...");

  runGasApi("scannerSaveProtectionSettings", { config, token: window.settingsAdminToken })
    .then(result => {
      hideSettingsLoading(true);
      if (!result || !result.success) { 
        showToast((result && result.message) || "Gagal menyimpan proteksi.", "error"); 
        return; 
      }

      // Update 1 Sumber Utama di Browser
      localStorage.setItem("scanner_protection_config", JSON.stringify(config));
      applyScannerProtectionSettings(config);
      updateProtectionStatusUI();
      
      closeSettingsModal();
      showToast("Konfigurasi proteksi berhasil disimpan.", "success");
    })
    .catch(err => { 
      hideSettingsLoading(true); 
      showToast("Gagal menyimpan konfigurasi proteksi.", "error"); 
      console.error(err); 
    });
  return true;
}

function applyScannerProtectionSettings(config) {
  window.scannerProtectionConfig = Object.assign({
    manualInput: true, autoDelete: true, paste: true, dragDrop: true, clipboardShortcut: true
  }, config || {});
  updateConfigIndicators();
}

function updateConfigIndicators() {
  const jamEl = document.getElementById("jamConfigIndicator");
  const protectEl = document.getElementById("protectionConfigIndicator");
  const today = getLocalDateString();
  let jamActive = false;
  
  try {
    const saved = JSON.parse(localStorage.getItem("jam_override_today") || "null");
    const manualActive = !!(saved && saved.date === today && saved.config && saved.enabled !== false);
    // Aktif jika ada simpanan manual ON atau activeConfig dari backend bernilai isKhusus
    jamActive = manualActive || !!(activeConfig && activeConfig.isKhusus);
  } catch (_) {
    jamActive = !!(activeConfig && activeConfig.isKhusus);
  }

  if (jamEl) {
    jamEl.classList.toggle("is-active", jamActive);
    jamEl.title = jamActive ? "Config Jam aktif untuk hari ini" : "Config Jam tidak aktif";
    jamEl.setAttribute("aria-label", jamEl.title);
  }

  const cfg = window.scannerProtectionConfig || {};
  const protectActive = Object.keys(cfg).some(k => cfg[k] === true);
  if (protectEl) {
    protectEl.classList.toggle("is-active", protectActive);
    protectEl.title = protectActive ? "Config Proteksi aktif" : "Config Proteksi tidak aktif";
    protectEl.setAttribute("aria-label", protectEl.title);
  }
}

function switchTab(tab) {
  if (tab === 'proteksi' && window.settingsAccessRole !== 'superadmin') {
    requestSuperAdminAccess(function() { switchTab('proteksi'); });
    return;
  }
  const tabs = ['configJam', 'proteksi', 'export'];

  tabs.forEach(function (name) {
    const content = document.getElementById('tabContent-' + name);
    const button = document.getElementById('tabBtn-' + name);
    if (content) content.style.display = name === tab ? 'block' : 'none';
    if (button) button.classList.toggle('active', name === tab);
  });
}

function switchTimeTab(tab) {
  const tabs = ['global', 'X', 'XI', 'XII'];

  tabs.forEach(function (name) {
    const content = document.getElementById('timeTabContent-' + name);
    const button = document.getElementById('timeTabBtn-' + name);
    if (content) content.style.display = name === tab ? 'block' : 'none';
    if (button) button.classList.toggle('active', name === tab);
  });
}

function getTodayJamOverride() {
  try {
    const saved = JSON.parse(localStorage.getItem("jam_override_today") || "null");
    return saved && saved.date === getLocalDateString() && saved.config ? saved : null;
  } catch (_) { return null; }
}

function isConfigJamEnabledToday() {
  const saved = getTodayJamOverride();
  if (saved && typeof saved.enabled === "boolean") {
    return saved.enabled;
  }
  // Jika belum ada tindakan manual, ikuti status isKhusus bawaan backend
  return !!(activeConfig && activeConfig.isKhusus);
}

function renderConfigJamToggle() {
  const btnOn = document.getElementById("configJamToggleOn");
  const btnOff = document.getElementById("configJamToggleOff");
  if (!btnOn || !btnOff) return;

  const isEnabled = isConfigJamEnabledToday();

  if (isEnabled) {
    btnOn.classList.add("is-selected");
    btnOff.classList.remove("is-selected");
  } else {
    btnOff.classList.add("is-selected");
    btnOn.classList.remove("is-selected");
  }
}

function setConfigJamActive(enabled) {
  const saved = getTodayJamOverride();
  const nextEnabled = (enabled === true);
  
  if (nextEnabled && (!saved || !saved.config)) {
    showToast("Ubah jam masuk/pulang lalu klik Simpan untuk mengaktifkan.", "info");
    renderConfigJamToggle();
    return;
  }

  if (saved) {
    saved.enabled = nextEnabled;
    localStorage.setItem("jam_override_today", JSON.stringify(saved));
  } else {
    localStorage.setItem("jam_override_today", JSON.stringify({
      date: getLocalDateString(),
      enabled: false,
      config: null
    }));
  }

  if (nextEnabled && saved && saved.config) {
    if (!window.scannerDefaultConfig) {
      window.scannerDefaultConfig = JSON.parse(JSON.stringify(activeConfig));
    }
    activeConfig = JSON.parse(JSON.stringify(saved.config));
  } else if (window.scannerDefaultConfig) {
    activeConfig = JSON.parse(JSON.stringify(window.scannerDefaultConfig));
  }

  renderConfigJamToggle();
  updateConfigIndicators();

  if (window.settingsAdminToken) {
    runGasApi("scannerSetJamOverrideStatus", { 
      enabled: nextEnabled, 
      dateKey: getLocalDateString(), 
      token: window.settingsAdminToken 
    }).catch(e => console.error("Status gagal disinkron", e));
  }

  if (typeof updateActiveLevelsBadge === "function") updateActiveLevelsBadge();
  if (typeof renderJurusanUI === "function") renderJurusanUI();

  showToast(nextEnabled 
    ? "Config Jam aktif untuk hari ini." 
    : "Config Jam nonaktif. Jadwal default digunakan.", "success");
}

function saveOverrideJam() {
  if (document.getElementById("tabContent-proteksi")?.style.display !== "none") {
    saveProtectionSettings();
    return;
  }
  const todayStr = getLocalDateString();
  
  const isOffSelected = document.getElementById("configJamToggleOff")?.classList.contains("is-selected");
  const isEnabled = !isOffSelected;

  const currentAllowed = (activeConfig && activeConfig.allowedLevels && activeConfig.allowedLevels.length > 0)
    ? activeConfig.allowedLevels 
    : ["X", "XI", "XII"];

  const newByLevel = {};

  const jmX = document.getElementById("cfgJamMasukX") ? document.getElementById("cfgJamMasukX").value : "";
  const jpX = document.getElementById("cfgJamPulangX") ? document.getElementById("cfgJamPulangX").value : "";
  if (jmX && jpX) newByLevel["X"] = { jamMasuk: jmX, jamPulang: jpX };

  const jmXI = document.getElementById("cfgJamMasukXI") ? document.getElementById("cfgJamMasukXI").value : "";
  const jpXI = document.getElementById("cfgJamPulangXI") ? document.getElementById("cfgJamPulangXI").value : "";
  if (jmXI && jpXI) newByLevel["XI"] = { jamMasuk: jmXI, jamPulang: jpXI };

  const jmXII = document.getElementById("cfgJamMasukXII") ? document.getElementById("cfgJamMasukXII").value : "";
  const jpXII = document.getElementById("cfgJamPulangXII") ? document.getElementById("cfgJamPulangXII").value : "";
  if (jmXII && jpXII) newByLevel["XII"] = { jamMasuk: jmXII, jamPulang: jpXII };

  const newConfig = {
    isKhusus: Object.keys(newByLevel).length > 0,
    default: {
      jamMasuk: (document.getElementById("cfgJamMasukGlobal") && document.getElementById("cfgJamMasukGlobal").value) || "06:45",
      batasTerlambat: Number(document.getElementById("cfgTerlambatGlobal") ? document.getElementById("cfgTerlambatGlobal").value : 30) || 30,
      batasSangatTerlambat: Number(document.getElementById("cfgSangatTerlambatGlobal") ? document.getElementById("cfgSangatTerlambatGlobal").value : 60) || 60,
      batasSangatTerlambatSekali: Number(document.getElementById("cfgSangatTerlambatSekaliGlobal") ? document.getElementById("cfgSangatTerlambatSekaliGlobal").value : 90) || 90,
      jamPulang: (document.getElementById("cfgJamPulangGlobal") && document.getElementById("cfgJamPulangGlobal").value) || "11:00"
    },
    byLevel: newByLevel,
    allowedLevels: currentAllowed
  };

  if (!window.scannerDefaultConfig) {
    window.scannerDefaultConfig = JSON.parse(JSON.stringify(activeConfig));
  }

  if (isEnabled) {
    activeConfig = JSON.parse(JSON.stringify(newConfig));
  } else if (window.scannerDefaultConfig) {
    activeConfig = JSON.parse(JSON.stringify(window.scannerDefaultConfig));
  }

  localStorage.setItem("jam_override_today", JSON.stringify({
    date: todayStr,
    enabled: isEnabled,
    config: newConfig
  }));

  renderConfigJamToggle();

  if (window.settingsAdminToken) {
    runGasApi("scannerSetJamOverrideStatus", { 
      enabled: isEnabled, 
      dateKey: todayStr, 
      token: window.settingsAdminToken 
    }).catch(e => console.error("Status Config Jam gagal disinkronkan ke server", e));
  }

  closeSettingsModal();
  if (typeof updateActiveLevelsBadge === "function") updateActiveLevelsBadge();
  if (typeof renderJurusanUI === "function") renderJurusanUI();
  updateConfigIndicators();

  showToast(isEnabled 
    ? "Pengaturan jam berhasil disimpan dan otomatis AKTIF hari ini." 
    : "Config Jam disimpan namun dalam kondisi NONAKTIF.", "success");
}

function loadLocalOverrideJam() {
  const saved = localStorage.getItem("jam_override_today");

  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      // Hanya timpa kalau user memproses toggle manual HARI INI via Modal Settings
      if (parsed.date === getLocalDateString() && parsed.enabled === true && parsed.config) {
        activeConfig = JSON.parse(JSON.stringify(parsed.config));
        renderConfigJamToggle();
        updateConfigIndicators();
        if (typeof updateActiveLevelsBadge === "function") updateActiveLevelsBadge();
        if (typeof renderJurusanUI === "function") renderJurusanUI();
        return;
      }
    } catch (e) {
      console.error("Gagal parse jam_override_today:", e);
    }
  }

  // Jika tidak ada override manual dari modal, gunakan config otomatis bawaan backend
  if (window.scannerDefaultConfig) {
    activeConfig = JSON.parse(JSON.stringify(window.scannerDefaultConfig));
  }
  updateConfigIndicators();
}

function isLevelAllowed(tingkatSiswa, kelasSiswa) {
  if (!activeConfig || !activeConfig.allowedLevels || activeConfig.allowedLevels.length === 0) {
    return true;
  }

  const allowed = activeConfig.allowedLevels.map(l => String(l).trim().toUpperCase());

  let t = String(tingkatSiswa || "").trim().toUpperCase();
  const k = String(kelasSiswa || "").trim().toUpperCase();

  if (!t || t === "UNDEFINED") {
    if (k.includes("XII") || k.startsWith("XII") || k.includes("12")) t = "XII";
    else if (k.includes("XI") || k.startsWith("XI") || k.includes("11")) t = "XI";
    else if (k.includes("X") || k.startsWith("X") || k.includes("10")) t = "X";
  }

  if (!t) return true;
  return allowed.includes(t);
}

function updateJurusanCount(kelasStr, tingkatStr) {
  if (!kelasStr || !isLevelAllowed(tingkatStr, kelasStr)) return;

  const targetKey = normalisasiJurusanFrontend(kelasStr);
  if (targetKey && countsJurusan.hasOwnProperty(targetKey)) {
    countsJurusan[targetKey] += 1;
  }
}

function renderJurusanUI() {
  const container = document.getElementById("kelasListContainer");
  if (!container) return;
  const previousSnapshot = captureRekapSnapshot();

  if (typeof students === "undefined" || Object.keys(students).length === 0) {
    container.innerHTML = `<div style="grid-column: span 3; text-align: center; color: #94a3b8; font-size: 14px; margin: auto;">Belum ada data siswa.</div>`;
    return;
  }

  const rekapMap = {};

  Object.keys(students).forEach(nis => {
    const s = students[nis];
    if (!s || !s.class) return;

    const namaKelas = String(s.class).trim();
    let tingkat = String(s.tingkat || "").trim().toUpperCase();

    const hasCustomSchedule = !!(s.jamMasukKhusus || s.jamPulangKhusus);
    if (!hasCustomSchedule && !isLevelAllowed(s.tingkat, s.class)) return;

    if (!tingkat || tingkat === "UNDEFINED") {
      if (namaKelas.includes("XII") || namaKelas.startsWith("XII")) tingkat = "XII";
      else if (namaKelas.includes("XI") || namaKelas.startsWith("XI")) tingkat = "XI";
      else if (namaKelas.includes("X") || namaKelas.startsWith("X")) tingkat = "X";
      else tingkat = "KHUSUS";
    }

    if (!rekapMap[namaKelas]) {
      rekapMap[namaKelas] = { total: 0, hadir: 0, tingkat: tingkat, lastScanTime: 0, isCustom: hasCustomSchedule };
    }

    rekapMap[namaKelas].total += 1;

    if (sudahHadirHariIni.has(String(nis))) {
      rekapMap[namaKelas].hadir += 1;
      
      let scanTimestamp = getStudentLastScanTimestamp(String(nis));
      
      if (scanTimestamp === 0 && window.serverEarlyBirds && Array.isArray(window.serverEarlyBirds)) {
        const serverMatch = window.serverEarlyBirds.find(item => String(item.nis || item) === String(nis));
        if (serverMatch && serverMatch.time) {
          const parts = serverMatch.time.split(":");
          const d = new Date();
          d.setHours(parseInt(parts[0]||0), parseInt(parts[1]||0), parseInt(parts[2]||0), 0);
          scanTimestamp = d.getTime();
        }
      }

      if (scanTimestamp > rekapMap[namaKelas].lastScanTime) {
        rekapMap[namaKelas].lastScanTime = scanTimestamp;
      }
    }
  });

  const groupedByTingkat = {};

  // KODE BARU (FIX NAMA KELAS HUMAN-READABLE):
Object.keys(rekapMap).forEach(kName => {
  const item = rekapMap[kName];
  if (item.hadir === 0) return;

  const percent = item.total > 0 ? (item.hadir / item.total) * 100 : 0;
  
  let groupKey = item.tingkat || "LAINNYA";
  
  // 1. CARI SAMPLE STUDENT UNTUK REKAP
  const sampleStudent = Object.values(students).find(s => s && String(s.class || "").trim() === kName);
  
  // 2. CONVERT ID KELAS JADI NAMA CANTIK (Contoh: "FAR-A26" -> "X FAR 1")
  let namaLabBersih = sampleStudent 
    ? formatNamaKelas(String(sampleStudent.class || "").trim(), item.tingkat) 
    : formatNamaKelas(kName, item.tingkat);

  // Deteksi nomor Sesi untuk auto-grouping khusus temporer/lab
  const matchSesi = kName.match(/sesi\s*(\d+|[a-z]+)/i);
  if (matchSesi) {
    const sesiNum = matchSesi[1];
    groupKey = `${item.tingkat} - Sesi ${sesiNum}`;
    
    // Bersihkan teks kelas/ruang jika ada kata Sesi/TKA
    namaLabBersih = kName
      .replace(/[-\s]*tka[-\s]*/i, " ")
      .replace(/[-\s]*sesi\s*(\d+|[a-z]+)/i, "")
      .trim();
  }

  if (!groupedByTingkat[groupKey]) {
    groupedByTingkat[groupKey] = [];
  }

  groupedByTingkat[groupKey].push({
    namaKelas: kName,
    namaKelasTampilan: namaLabBersih || kName,
    total: item.total,
    hadir: item.hadir,
    percent: percent,
    percentRounded: Math.round(percent),
    lastScanTime: item.lastScanTime,
    isCustom: item.isCustom || !["X", "XI", "XII"].includes(item.tingkat)
  });
});

  // SORTING URUTAN KEHADIRAN
  Object.keys(groupedByTingkat).forEach(tKat => {
    groupedByTingkat[tKat].sort((a, b) => {
      if (b.percentRounded !== a.percentRounded) return b.percentRounded - a.percentRounded;
      if (a.lastScanTime > 0 && b.lastScanTime > 0 && a.lastScanTime !== b.lastScanTime) return a.lastScanTime - b.lastScanTime;
      if (a.lastScanTime > 0 && b.lastScanTime === 0) return -1;
      if (b.lastScanTime > 0 && a.lastScanTime === 0) return 1;
      return a.namaKelas.localeCompare(b.namaKelas, "id", { numeric: true, sensitivity: "base" });
    });
  });

  let htmlContent = "";
  let hasData = false;

  const priorityOrder = ["X", "XI", "XII"];
  const dynamicKeys = Object.keys(groupedByTingkat).filter(k => !priorityOrder.includes(k));
  dynamicKeys.sort((a, b) => a.localeCompare(b, "id", { numeric: true }));

  const displayLevels = [...priorityOrder, ...dynamicKeys];

  displayLevels.forEach(tKat => {
    const listKelas = groupedByTingkat[tKat];
    if (!listKelas || listKelas.length === 0) return;

    if (priorityOrder.includes(tKat) && !isLevelAllowed(tKat, "")) return;

    hasData = true;

    const isReguler = priorityOrder.includes(tKat);
    const titleHeader = isReguler ? `Rekap Kelas ${tKat}` : `Rekap ${tKat}`;

    htmlContent += `
      <div class="tingkat-column">
        <div class="tingkat-column-title">${titleHeader}</div>
        <div class="kelas-list-stack">
    `;

    listKelas.forEach((k, index) => {
      let colorClass = "medium";
      if (k.percentRounded >= 85) colorClass = "high";
      else if (k.percentRounded < 50) colorClass = "low";

      // HANYA PASANG MEDALI UNTUK KELAS REGULER (X, XI, XII):
      let medalIcon = "";
      if (isReguler && k.percentRounded > 0) {
        if (index === 0) medalIcon = " 🥇";
        else if (index === 1) medalIcon = " 🥈";
        else if (index === 2) medalIcon = " 🥉";
      }

      const kelasId = k.namaKelas.replace(/\s+/g, "_");
      const namaTampilan = k.namaKelasTampilan || k.namaKelas;

      htmlContent += `
        <div
          class="kelas-item-compact"
          data-kelas-id="${kelasId}"
          data-hadir="${k.hadir}"
          title="${namaTampilan}: ${k.hadir} dari ${k.total} siswa hadir"
        >
          <div class="kelas-row-top">
            <span class="kelas-nama-bold">${namaTampilan}${medalIcon}</span>
            <div class="kelas-stats-text">
              <span>${k.hadir}/${k.total}</span>
              <span class="kelas-percent-clean text-${colorClass}">(${k.percentRounded}%)</span>
            </div>
          </div>
          <div class="mini-bar-bg">
            <div class="mini-bar-fill bar-${colorClass}" style="width:${k.percentRounded}%;"></div>
          </div>
        </div>
      `;
    });

    htmlContent += `
        </div>
      </div>
    `;
  });

  if (!hasData) {
    container.innerHTML = `
      <div id="emptyRekapState" class="empty-rekap-state">
        <img src="assets/top3kelas.png" alt="Ilustrasi rekap kehadiran kelas Top 3" class="empty-rekap-image" />
        <h3>Rekap Kehadiran Kelas</h3>
        <p>Belum ada presensi hari ini.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = htmlContent;
  applyRekapOverflowLayout(container);
  animateRekapChanges(previousSnapshot);
}

function applyRekapOverflowLayout(container = document.getElementById("kelasListContainer")) {
  if (!container) return;

  const oldGroups = Array.from(container.querySelectorAll(":scope > .rekap-column-group"));
  oldGroups.forEach(group => {
    while (group.firstElementChild) container.insertBefore(group.firstElementChild, group);
    group.remove();
  });

  const columns = Array.from(container.querySelectorAll(":scope > .tingkat-column"));
  container.classList.remove("rekap-levels-merged", "rekap-levels-1", "rekap-levels-2", "rekap-levels-3");
  columns.forEach(column => {
    const stack = column.querySelector(".kelas-list-stack");
    if (stack) stack.classList.remove("is-overflow-grid");
  });
  if (!columns.length) return;

  container.classList.add("rekap-levels-merged");

  requestAnimationFrame(() => {
    if (!container.isConnected || !columns.every(col => col.isConnected)) return;
    const containerHeight = container.clientHeight;
    if (!containerHeight) return;

    const cs = getComputedStyle(container);
    const verticalPadding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const gap = parseFloat(cs.rowGap || cs.gap) || 0;
    const usableHeight = Math.max(0, containerHeight - verticalPadding - 6);

    const getNaturalColumnHeight = column => {
      const title = column.querySelector(".tingkat-column-title");
      const stack = column.querySelector(".kelas-list-stack");
      if (!stack) return 0;
      const titleHeight = title ? title.getBoundingClientRect().height : 0;
      const titleMargin = title ? (parseFloat(getComputedStyle(title).marginBottom) || 0) : 0;
      const stackGap = parseFloat(getComputedStyle(stack).rowGap || getComputedStyle(stack).gap) || 0;
      const cardsHeight = Array.from(stack.children).reduce((sum, card) => {
        const style = getComputedStyle(card);
        return sum + card.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      }, 0);
      const columnGapLocal = parseFloat(getComputedStyle(column).rowGap || getComputedStyle(column).gap) || 0;
      return titleHeight + titleMargin + cardsHeight + Math.max(0, stack.children.length - 1) * stackGap + (stack.children.length ? columnGapLocal : 0);
    };

    const heights = columns.map(getNaturalColumnHeight);
    const mergedHeight = heights.reduce((a, b) => a + b, 0) + Math.max(0, columns.length - 1) * gap;

    if (mergedHeight <= usableHeight) return;

    const groups = [];
    let current = [];
    let currentHeight = 0;
    columns.forEach((column, index) => {
      const h = heights[index];
      const candidateHeight = current.length ? currentHeight + gap + h : h;
      if (current.length && candidateHeight > usableHeight) {
        groups.push(current);
        current = [column];
        currentHeight = h;
      } else {
        current.push(column);
        currentHeight = candidateHeight;
      }
    });
    if (current.length) groups.push(current);

    container.classList.remove("rekap-levels-merged");
    container.classList.add(`rekap-levels-${Math.max(1, Math.min(3, groups.length))}`);

    groups.forEach(groupColumns => {
      const wrapper = document.createElement("div");
      wrapper.className = "rekap-column-group";
      groupColumns[0].parentNode.insertBefore(wrapper, groupColumns[0]);
      groupColumns.forEach(column => wrapper.appendChild(column));
    });

    requestAnimationFrame(() => {
      if (!container.isConnected) return;
      columns.forEach((column, index) => {
        const stack = column.querySelector(".kelas-list-stack");
        if (!stack || stack.children.length <= 3) return;
        if (heights[index] > usableHeight + 2) stack.classList.add("is-overflow-grid");
      });
    });
  });
}

if (!window.__rekapOverflowObserver && typeof ResizeObserver !== "undefined") {
  const rekapContainer = document.getElementById("kelasListContainer");
  if (rekapContainer) {
    let rekapResizeQueued = false;
    window.__rekapOverflowObserver = new ResizeObserver(() => {
      if (rekapResizeQueued) return;
      rekapResizeQueued = true;
      requestAnimationFrame(() => {
        rekapResizeQueued = false;
        applyRekapOverflowLayout(rekapContainer);
      });
    });
    window.__rekapOverflowObserver.observe(rekapContainer);
  }
}
window.addEventListener("resize", () => applyRekapOverflowLayout());

function normalisasiJurusanFrontend(jurusanStr) {
  if (!jurusanStr) return "LAINNYA";
  const j = String(jurusanStr).toUpperCase();
  if (j.includes("AKN") || j.includes("AKL") || j.includes("AKUNTANSI")) return "AKUNTANSI";
  if (j.includes("DKV") || j.includes("DESAIN") || j.includes("VISUAL")) return "DKV";
  if (j.includes("FAR") || j.includes("FARMASI")) return "FARMASI";
  if (j.includes("KL") || j.includes("KLR") || j.includes("KUL") || j.includes("KULINER") || j.includes("TBG") || j.includes("BOG") || j.includes("BOGA")) return "KULINER";
  if (j.includes("RPL") || j.includes("REKAYASA")) return "RPL";
  if (j.includes("TKR") || j.includes("KENDARAAN") || j.includes("OTOMOTIF")) return "TKR";
  if (j.includes("TKJ") || j.includes("KOMPUTER") || j.includes("JARINGAN")) return "TKJ";
  if (j.includes("TPM") || j.includes("PEMESINAN") || j.includes("MESIN")) return "TPM";
  if (j.includes("TSM") || j.includes("TBSM") || j.includes("BSM") || j.includes("SEPEDA") || j.includes("MOTOR")) return "TSM";
  return "LAINNYA";
}

function getIndonesianDateString(dateObj = new Date()) {
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const bulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  return `${hari[dateObj.getDay()]}, ${dateObj.getDate()} ${bulan[dateObj.getMonth()]} ${dateObj.getFullYear()}`;
}

function updateActiveLevelsBadge() {
  const dateBadgeEl = document.getElementById("activeDateBadge");
  const levelsBadgeEl = document.getElementById("activeLevelsBadge");
  if (dateBadgeEl) dateBadgeEl.innerText = getIndonesianDateString();
  if (levelsBadgeEl) {
    const levels = activeConfig.allowedLevels || ["X", "XI"];
    levelsBadgeEl.innerText = levels.length === 0 ? "(Tidak Ada Tingkat Dipilih)" : `(Tingkat ${levels.join(", ")})`;
  }
}

function createErrorAvatarDataUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = 300;
  canvas.height = 400;
  const ctx = canvas.getContext("2d");

  // Background Gradient Merah Alert
  const gradient = ctx.createLinearGradient(0, 0, 300, 400);
  gradient.addColorStop(0, "#991b1b"); // Merah gelap
  gradient.addColorStop(1, "#dc2626"); // Merah terang
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 300, 400);

  // Teks Ikon Peringatan (⚠️ atau ❌)
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 110px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("⚠️", 150, 200);

  return canvas.toDataURL("image/png");
}

function showError(msg) {
  try {
    const idleBox = document.getElementById("idleBox");
    const scanBox = document.getElementById("scanResultBox");
    const statusAlertEl = document.getElementById("scanStatusAlert");
    const nameEl = document.getElementById("scanStudentName");
    const classEl = document.getElementById("scanStudentClass");
    const timeEl = document.getElementById("scanTimeDigital");
    const badgeEl = document.getElementById("scanBadge");
    const photoImg = document.getElementById("scanPhotoImg");

    if (idleBox && scanBox) {
      // GANTI LOGO SEKOLAH DENGAN AVATAR ERROR MERAH:
      if (photoImg) photoImg.src = createErrorAvatarDataUrl();

      if (badgeEl) {
        badgeEl.className = "scan-badge-top badge-pulang";
        badgeEl.innerText = "🚨 SCAN ERROR / REJECTED";
      }
      if (statusAlertEl) {
        statusAlertEl.style.color = "#dc2626";
        statusAlertEl.innerText = "PERINGATAN";
      }
      if (nameEl) nameEl.innerText = String(msg).toUpperCase();
      if (classEl) classEl.innerText = "Silakan Scan Ulang QR yang Valid";
      if (timeEl) {
        timeEl.style.color = "#dc2626";
        timeEl.innerText = `${new Date().toTimeString().split(' ')[0]} WIB`;
      }

      idleBox.style.display = "none";
      scanBox.style.display = "flex";
    }
  } catch (e) {
    console.error("Error showing error UI:", e);
  }

  flashError();
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => { clearResultLater(); }, 3500);
}

function flashSuccess() {
  document.body.classList.add("flash-success");
  setTimeout(() => { document.body.classList.remove("flash-success"); }, 600);
}

function flashError() {
  document.body.classList.add("flash-error");
  setTimeout(() => { document.body.classList.remove("flash-error"); }, 600);
}

setInterval(() => { 
  if (!isSyncing && document.activeElement !== input && !document.getElementById("settingsModal").classList.contains("active")) {
    input.focus(); 
  }
}, 1000);

function updateConnectionStatus() {
  updateOfflineBadge();
  autoSyncIfOnline();
}

window.addEventListener("load", updateConnectionStatus);
window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);

function updateClock() {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  const clockEl = document.getElementById("idleClockText");
  const dateEl = document.getElementById("idleDateText");

  if (clockEl) clockEl.innerText = `${timeStr} WIB`;
  if (dateEl) dateEl.innerText = getIndonesianDateString(now);

  if (now.getSeconds() === 0) loadLocalOverrideJam();
}

setInterval(updateClock, 1000);
updateClock();

/* ==========================================================
   GLOBAL TOAST SYSTEM
   ========================================================== */
let appToastTimer = null;

function showToast(message, type = "success", title = "") {
  let toast = document.getElementById("appToast");
  
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "appToast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.innerHTML = `
      <div class="toast-icon-bg" id="toastIcon">✓</div>
      <div class="toast-content">
        <div class="toast-title" id="toastTitle">Success</div>
        <div class="toast-message" id="toastMessage"></div>
      </div>
      <button class="toast-close-btn" onclick="hideToast()">✕</button>
    `;
    document.body.appendChild(toast);
  }

  const titleEl = document.getElementById("toastTitle");
  const msgEl = document.getElementById("toastMessage");
  const iconEl = document.getElementById("toastIcon");

  const presets = {
    success: { title: "Success", icon: "✓" },
    error: { title: "Error", icon: "✕" },
    info: { title: "Info", icon: "ℹ" },
    warning: { title: "Warning", icon: "!" }
  };

  const currentPreset = presets[type] || presets.success;

  if (titleEl) titleEl.textContent = title || currentPreset.title;
  if (msgEl) msgEl.textContent = message || "";
  if (iconEl) iconEl.textContent = currentPreset.icon;

  toast.dataset.type = type;
  toast.classList.add("is-visible");

  if (appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(hideToast, 3500);
}

function hideToast() {
  const toast = document.getElementById("appToast");
  if (toast) toast.classList.remove("is-visible");
}

function showToastJam(message, type) {
  showToast(message, type);
}

function showCustomAlert(icon, message) {
  document.getElementById("alertIcon").innerText = icon;
  document.getElementById("alertMessage").innerText = message;
  document.getElementById("customAlertModal").classList.add("active");
}

function closeCustomAlert() {
  document.getElementById("customAlertModal").classList.remove("active");
  setTimeout(() => { input.focus(); }, 200);
}

function getLocalDateString(dateObj = new Date()) {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getStudentLastScanTimestamp(nis) {
  try {
    let match = offlineScansCache.filter(item => String(item.nis) === String(nis));
    if (match.length > 0) {
      let lastItem = match[match.length - 1];
      return new Date(lastItem.timestamp).getTime() || 0;
    }
  } catch (e) {}
  return 0;
}

document.addEventListener("DOMContentLoaded", function() {
  loadRekapEffectsPreference();

  document.querySelectorAll("#tabContent-configJam input").forEach(inputEl => {
    inputEl.addEventListener("focus", () => {
      inputEl.dataset.initialValue = inputEl.value;
    });

    inputEl.addEventListener("change", () => {
      let isAnyValueChanged = false;

      document.querySelectorAll("#tabContent-configJam input").forEach(el => {
        if (el.dataset.initialValue !== undefined && el.value !== el.dataset.initialValue) {
          isAnyValueChanged = true;
        }
      });

      if (isAnyValueChanged) {
        const btnOn = document.getElementById("configJamToggleOn");
        const btnOff = document.getElementById("configJamToggleOff");
        if (btnOn && btnOff) {
          btnOn.classList.add("is-selected");
          btnOff.classList.remove("is-selected");
        }
      }
    });
  });
});

function formatSmartName(fullName, maxLen = 22) {
  if (!fullName) return "Siswa";
  const cleanName = fullName.trim();
  if (cleanName.length <= maxLen) return cleanName;
  const parts = cleanName.split(" ");
  if (parts.length > 2) {
    const firstTwo = parts.slice(0, parts.length - 1).join(" ");
    const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase() + ".";
    const result = `${firstTwo} ${lastInitial}`;
    if (result.length <= maxLen + 3) return result;
  }
  if (parts.length >= 2) return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`;
  return cleanName;
}

let hofCarouselTimer = null;
let hofCurrentTingkatIndex = 0;

function getStudentTingkat(studentObj, kelasStr) {
  if (studentObj && studentObj.tingkat) {
    const tingkat = String(studentObj.tingkat).trim().toUpperCase();
    if (["X", "XI", "XII"].includes(tingkat)) return tingkat;
  }
  const str = String(kelasStr || "").trim().toUpperCase();
  const match = str.match(/(?:^|\s)(XII|XI|X)(?=\s|-|$)/);
  if (match) return match[1];
  return "LAINNYA";
}

function renderHallOfFameUI() {
  const rank1Container = document.getElementById("hofRank1Container");
  const listContainer = document.getElementById("hofListContainer");
  const subLabelContainer = document.getElementById("hofSubLabelContainer");
  if (!listContainer) return;

  const hofCard = document.getElementById("hallOfFameCard");
  const showHofIdle = (message = "Top 10 Kehadiran Siswa hari ini.") => {
    if (hofCard) {
      hofCard.classList.add("hof-idle-mode");
      hofCard.classList.remove("hof-compact-mode");
    }
    if (rank1Container) rank1Container.innerHTML = "";
    if (subLabelContainer) subLabelContainer.innerHTML = "";
    listContainer.classList.remove("hof-fade-in");
    listContainer.innerHTML = `
      <div class="hof-idle-state">
        <img src="assets/top10kelas.png" alt="Ilustrasi podium Top 10 Hall of Fame" />
        <div class="hof-idle-copy">
          <strong>Hall of Fame</strong>
          <span>${message}</span>
        </div>
      </div>`;
  };

  if (typeof students === "undefined" || Object.keys(students).length === 0) {
    showHofIdle("Menunggu data siswa dimuat.");
    return;
  }

  try {
    const allEarlyBirds = [];
    const processedNis = new Set();

    function parseTimeToMs(timeStr) {
      if (!timeStr || timeStr === "--:--") return Infinity;
      const parts = timeStr.split(":").map(Number);
      return ((parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0)) * 1000;
    }

    if (window.serverEarlyBirds && Array.isArray(window.serverEarlyBirds)) {
      window.serverEarlyBirds.forEach(item => {
        const nisStr = typeof item === "object" ? String(item.nis || "") : String(item || "");
        if (!nisStr || processedNis.has(nisStr)) return;
        processedNis.add(nisStr);
        const student = students[nisStr];
        const timeDisplay = item && typeof item === "object" && item.time
          ? item.time.split(":").map((part, i) => String(part || "0").padStart(2, "0")).slice(0, 3).join(":")
          : "--:--:--";
        const kelasVal = (student && (student.kelas || student.class)) || (item && item.kelas) || "";
        allEarlyBirds.push({
          nis: nisStr,
          name: (student && student.name) || (item && item.name) || "Siswa",
          kelas: kelasVal,
          tingkat: getStudentTingkat(student, kelasVal),
          timeStr: timeDisplay,
          sortTime: parseTimeToMs(timeDisplay)
        });
      });
    }

    Object.keys(students).forEach(nis => {
      const stringNis = String(nis);
      if (!sudahHadirHariIni.has(stringNis) || processedNis.has(stringNis)) return;
      processedNis.add(stringNis);
      const student = students[stringNis];
      const scanTimestamp = getStudentLastScanTimestamp(stringNis);
      const scanDate = scanTimestamp > 0 ? new Date(scanTimestamp) : new Date();
      const timeVal = `${String(scanDate.getHours()).padStart(2, "0")}:${String(scanDate.getMinutes()).padStart(2, "0")}:${String(scanDate.getSeconds()).padStart(2, "0")}`;
      const kelasVal = student.class || student.kelas || "";
      allEarlyBirds.push({
        nis: stringNis, name: student.name || "Siswa", kelas: kelasVal,
        tingkat: getStudentTingkat(student, kelasVal), timeStr: timeVal,
        sortTime: scanDate.getTime()
      });
    });

    const globalFilter = typeof currentFilterTingkat !== "undefined" ? currentFilterTingkat : "ALL";
    const levelOrder = ["X", "XI", "XII", "LAINNYA"];
    const levelsWithScans = levelOrder.filter(level => allEarlyBirds.some(student => student.tingkat === level));
    let labelTingkatAktif = "";
    let activeList = [];

    if (globalFilter === "ALL" || globalFilter === "SEMUA") {
      if (!levelsWithScans.length) {
        showHofIdle();
        return;
      }
      hofCurrentTingkatIndex = hofCurrentTingkatIndex % levelsWithScans.length;
      labelTingkatAktif = levelsWithScans[hofCurrentTingkatIndex];
      activeList = allEarlyBirds.filter(student => student.tingkat === labelTingkatAktif);
    } else {
      labelTingkatAktif = String(globalFilter).toUpperCase().replace("KELAS", "").trim();
      activeList = allEarlyBirds.filter(student => student.tingkat === labelTingkatAktif);
      if (!activeList.length) {
        showHofIdle(`Belum ada siswa Kelas ${labelTingkatAktif} yang melakukan scan hari ini.`);
        return;
      }
    }

    if (hofCard) hofCard.classList.remove("hof-idle-mode");
    activeList.sort((a, b) => a.sortTime - b.sortTime);
    const now = new Date();
    const formattedDate = now.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (subLabelContainer) {
      subLabelContainer.innerHTML = `
        <span class="hof-label-bold-black">Top 10 Kelas ${labelTingkatAktif}</span>
        <span class="hof-label-gray-date">${formattedDate}</span>`;
    }

    const sortedTop10 = activeList.slice(0, 10);
    if (hofCard) hofCard.classList.toggle("hof-compact-mode", sortedTop10.length <= 5);
    if (!sortedTop10.length) {
      showHofIdle();
      return;
    }

    listContainer.classList.remove("hof-fade-in");
    void listContainer.offsetWidth;
    listContainer.classList.add("hof-fade-in");
    listContainer.innerHTML = sortedTop10.map((item, idx) => {
      const rankNum = idx + 1;
      const nameFormat = formatSmartName(item.name, 24);
      const kelasFormat = formatNamaKelas(item.kelas, item.tingkat);
      return `
        <div class="hof-item-clean" title="${item.name} (${kelasFormat}) - ${item.timeStr} WIB">
          <span class="hof-num">${rankNum}.</span>
          <span class="hof-name-bold">${nameFormat}</span>
          <span class="hof-class-tag">${kelasFormat}</span>
          <span class="hof-time-tag">${item.timeStr}</span>
        </div>`;
    }).join("");

    const maxNameChars = Math.max(1, ...sortedTop10.map(item => formatSmartName(item.name, 24).length));
    listContainer.style.setProperty("--hof-name-width", `min(${maxNameChars}ch, 45vw)`);
  } catch (e) {
    console.error("Gagal merender Hall of Fame:", e);
    showHofIdle("Klasemen belum dapat ditampilkan.");
  }
}

function startHofCarousel() {
  if (hofCarouselTimer) {
    clearInterval(hofCarouselTimer);
    hofCarouselTimer = null;
  }

  hofCarouselTimer = setInterval(() => {
    const globalFilter = typeof currentFilterTingkat !== "undefined" ? currentFilterTingkat : "ALL";
    
    if (globalFilter === "ALL" || globalFilter === "SEMUA") {
      const availableLevels = ["X", "XI", "XII", "LAINNYA"].filter(level =>
        Array.isArray(window.serverEarlyBirds) && window.serverEarlyBirds.some(item => {
          const nis = typeof item === "object" ? String(item.nis || "") : String(item || "");
          const student = (typeof students !== "undefined" && students) ? students[nis] : null;
          const kelas = (student && (student.class || student.kelas)) || (item && item.kelas) || "";
          return getStudentTingkat(student, kelas) === level;
        }) || (typeof students !== "undefined" && Object.keys(students).some(nis =>
          sudahHadirHariIni.has(String(nis)) && getStudentTingkat(students[nis], students[nis].class || students[nis].kelas || "") === level
        ))
      );
      if (availableLevels.length > 1) hofCurrentTingkatIndex = (hofCurrentTingkatIndex + 1) % availableLevels.length;
      renderHallOfFameUI();
    }
  }, 8000);
}

startHofCarousel();

function formatNamaKelas(idRombel, tingkat) {
  if (!idRombel || typeof idRombel !== "string") return "-";

  const parts = idRombel.trim().split("-");
  const jurusan = parts[0] || "";
  const subPart = parts[1] || "";
  const subKelas = subPart.replace(/[0-9]/g, "").trim();
  const tkt = String(tingkat || "").trim();

  if (jurusan && tkt && subKelas) {
    return `${jurusan.toUpperCase()} ${tkt.toUpperCase()}-${subKelas.toUpperCase()}`;
  }

  return idRombel;
}

function setAllProtections(enabled) {
  if (window.settingsAccessRole !== "superadmin") return;
  document.querySelectorAll('#tabContent-proteksi .protection-checkbox').forEach(function (checkbox) {
    checkbox.checked = enabled;
  });
  updateProtectionStatusUI();
}

function updateProtectionStatusUI() {
  const checkboxes = Array.from(document.querySelectorAll('#tabContent-proteksi .protection-checkbox'));
  const btnOn = document.getElementById("protectionToggleOn");
  const btnOff = document.getElementById("protectionToggleOff");

  if (checkboxes.length === 0) return;

  // Hitung berapa banyak checkbox yang dicentang
  const activeCount = checkboxes.filter(checkbox => checkbox.checked).length;
  const isAnyActive = activeCount > 0;

  if (btnOn && btnOff) {
    if (isAnyActive) {
      btnOn.classList.add("is-selected");
      btnOff.classList.remove("is-selected");
    } else {
      btnOff.classList.add("is-selected");
      btnOn.classList.remove("is-selected");
    }
  }
}

document.querySelectorAll('#tabContent-proteksi .protection-checkbox').forEach(function (checkbox) {
  checkbox.addEventListener('change', updateProtectionStatusUI);
});

updateProtectionStatusUI();

window.addEventListener("focus", updateConfigIndicators);
document.addEventListener("visibilitychange", function() {
  if (!document.hidden) updateConfigIndicators();
});
setInterval(updateConfigIndicators, 60000);

// SINKRONISASI 1 SUMBER UTAMA SAAT APLIKASI PERTAMA DI-LOAD
(function initGlobalProtectionState() {
  try {
    const cached = JSON.parse(localStorage.getItem("scanner_protection_config") || "null");
    if (cached) {
      applyScannerProtectionSettings(cached);
    } else {
      applyScannerProtectionSettings({
        manualInput: true, autoDelete: true, paste: true, dragDrop: true, clipboardShortcut: true
      });
    }
  } catch (_) { 
    updateConfigIndicators(); 
  }
})();

// Function ekstraksi warna dominan dari image logo/foto
function applyDominanGlow(imgElement) {
  if (!imgElement) return;

  const getDominantColor = (img) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = 50;
    canvas.height = 50;

    // Draw image ke canvas ukuran kecil
    ctx.drawImage(img, 0, 0, 50, 50);
    const data = ctx.getImageData(0, 0, 50, 50).data;

    let r = 0, g = 0, b = 0, count = 0;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      // Abaikan piksel transparan
      if (alpha > 128) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
    }

    if (count === 0) return "37, 99, 235"; // Fallback ke rgb default
    return `${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)}`;
  };

  const processImg = () => {
    try {
      const rgbStr = getDominantColor(imgElement);
      // Inject CSS Variable ke elemen logo
      imgElement.style.setProperty("--glow-rgb", rgbStr);
    } catch (e) {
      // Jika kena CORS, fallback ke warna tema aplikasi (#824653 -> RGB: 130, 70, 83)
      imgElement.style.setProperty("--glow-rgb", "130, 70, 83");
    }
  };

  if (imgElement.complete && imgElement.naturalWidth !== 0) {
    processImg();
  } else {
    imgElement.onload = processImg;
  }
}

// Inisialisasi saat aplikasi pertama dibuka
document.addEventListener("DOMContentLoaded", () => {
  const logoIdle = document.querySelector(".logo-idle-mode");
  if (logoIdle) applyDominanGlow(logoIdle);
});