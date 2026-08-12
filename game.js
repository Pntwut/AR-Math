// game.js
// -----------------------------------------------------------------------
// ลอจิกเกม: โจทย์คูณ, คะแนน, เวลา, การสร้างลูกโป่ง และระบบเลือกคำตอบ
// ด้วยการ "ชี้นิ้วค้างไว้ 3 วินาที" (dwell select) โดยใช้ตำแหน่งมือจาก
// hand-tracking.js ถ้าต้องการปรับเวลาค้าง/ความยาก ให้แก้ค่าคงที่ด้านล่าง
// -----------------------------------------------------------------------

import { HandTracker } from "./hand-tracking.js";

(function () {
  "use strict";

  // ---------- CONFIG ----------
  const DEFAULT_ROUND_SECONDS = 45;
  const OPTIONS_COUNT = 4;
  const DWELL_MS = 3000; // เวลาที่ต้องชี้ค้างไว้เพื่อยืนยันคำตอบ
  const WRONG_LOCKOUT_MS = 700; // กันไม่ให้ตอบผิดซ้ำทันทีขณะยังชี้ค้างอยู่จุดเดิม
  const BUBBLE_COLORS = ["#ff4d7e", "#7b5cff", "#38e8b0", "#ff8b3d", "#3ba7ff", "#ffc93c"];

  // ---------- STATE ----------
  let selectedTables = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  let roundSeconds = DEFAULT_ROUND_SECONDS;
  let score = 0;
  let timeLeft = roundSeconds;
  let timerHandle = null;
  let currentAnswer = null;
  let roundActive = false;
  let stream = null;
  let currentFacing = "user"; // "user" = กล้องหน้า, "environment" = กล้องหลัง

  let handTrackingReady = false;
  let pointerMode = "hand"; // "hand" = ใช้ dwell select, "tap" = fallback แตะหน้าจอ
  let hoverTarget = null;
  let hoverStart = 0;
  let selectionLocked = false;

  const tracker = new HandTracker(document.getElementById("camFeed"));

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const startScreen = $("startScreen");
  const endScreen = $("endScreen");
  const hud = $("hud");
  const questionBar = $("questionBar");
  const bubbleLayer = $("bubbleLayer");
  const scoreVal = $("scoreVal");
  const timeVal = $("timeVal");
  const timerPill = $("timerPill");
  const camFeed = $("camFeed");
  const camError = $("camError");
  const handCursor = $("handCursor");
  const handStatus = $("handStatus");
  const startBtn = $("startBtn");
  const roundSecondsInput = $("roundSeconds");

  // ---------- BUILD TABLE PICKER ----------
  const tablePicker = $("tablePicker");
  for (let n = 2; n <= 12; n++) {
    const chip = document.createElement("div");
    chip.className = "table-chip" + (selectedTables.has(n) ? " active" : "");
    chip.textContent = "แม่ " + n;
    chip.dataset.n = n;
    chip.addEventListener("click", () => {
      const num = Number(chip.dataset.n);
      if (selectedTables.has(num)) {
        selectedTables.delete(num);
        chip.classList.remove("active");
      } else {
        selectedTables.add(num);
        chip.classList.add("active");
      }
    });
    tablePicker.appendChild(chip);
  }
  $("selectAll").addEventListener("click", () => {
    selectedTables = new Set(Array.from({ length: 11 }, (_, i) => i + 2));
    [...tablePicker.children].forEach((c) => c.classList.add("active"));
  });
  $("selectNone").addEventListener("click", () => {
    selectedTables.clear();
    [...tablePicker.children].forEach((c) => c.classList.remove("active"));
  });

  // ---------- HAND TRACKER INIT (โหลดล่วงหน้าตั้งแต่หน้าแรก) ----------
  setHandStatus("loading", "กำลังเตรียมระบบตรวจจับมือ...");
  tracker
    .init()
    .then(() => {
      handTrackingReady = true;
      pointerMode = "hand";
      setHandStatus("ready", "พร้อมใช้งานระบบชี้มือแล้ว ✋");
    })
    .catch((e) => {
      console.error("Hand tracking init failed:", e);
      handTrackingReady = false;
      pointerMode = "tap";
      setHandStatus("error", "โหลดระบบชี้มือไม่สำเร็จ ใช้โหมดแตะหน้าจอแทน");
    });

  function setHandStatus(state, text) {
    handStatus.className = "hand-status " + state;
    handStatus.querySelector(".label").textContent = text;
  }

  // ---------- CAMERA ----------
  async function startCamera() {
    try {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: currentFacing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      camFeed.srcObject = stream;
      const mirrored = currentFacing === "user";
      camFeed.style.transform = mirrored ? "scaleX(-1)" : "none";
      tracker.setMirrored(mirrored);
      updateCamToggleLabels();
      return true;
    } catch (e) {
      camError.classList.remove("hidden");
      camError.innerHTML =
        "เปิดกล้องไม่ได้ 😢<br><br>" +
        "กรุณาอนุญาตการใช้กล้องในเบราว์เซอร์ และตรวจสอบว่าเปิดหน้านี้ผ่าน https (เช่น GitHub Pages)<br>" +
        "<br><small>" + (e && e.message ? e.message : "") + "</small>";
      return false;
    }
  }

  function updateCamToggleLabels() {
    const nextLabel = currentFacing === "user" ? "🔄 สลับเป็นกล้องหลัง" : "🔄 สลับเป็นกล้องหน้า";
    $("cameraToggleStart").textContent = nextLabel;
    $("cameraToggleHud").textContent = currentFacing === "user" ? "🔄 กล้องหน้า" : "🔄 กล้องหลัง";
  }

  async function toggleCamera() {
    currentFacing = currentFacing === "user" ? "environment" : "user";
    if (!stream) {
      updateCamToggleLabels();
      return;
    }
    await startCamera();
  }

  $("cameraToggleStart").addEventListener("click", toggleCamera);
  $("cameraToggleHud").addEventListener("click", toggleCamera);

  // ---------- FULLSCREEN ----------
  const fullscreenSupported = !!(
    document.documentElement.requestFullscreen ||
    document.documentElement.webkitRequestFullscreen ||
    document.documentElement.msRequestFullscreen
  );

  function isFullscreen() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement
    );
  }

  async function toggleFullscreen() {
    if (!fullscreenSupported) {
      showFullscreenNote(
        "เบราว์เซอร์นี้ไม่รองรับโหมดเต็มหน้าจอ (ข้อจำกัดของ iOS ที่อนุญาตเฉพาะ Safari) " +
          "แนะนำให้เปิดหน้านี้ด้วย Safari แล้วกดปุ่มแชร์ → \"เพิ่มลงหน้าจอโฮม\" จะได้เต็มจอแบบไม่มีแถบเบราว์เซอร์เลยครับ"
      );
      return;
    }
    const el = document.documentElement;
    try {
      if (!isFullscreen()) {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
        else if (el.msRequestFullscreen) await el.msRequestFullscreen();
      } else {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
        else if (document.msExitFullscreen) await document.msExitFullscreen();
      }
    } catch (e) {
      console.warn("Fullscreen ล้มเหลว:", e);
      showFullscreenNote("เปิดเต็มหน้าจอไม่สำเร็จ ลองเปิดด้วย Safari แทนครับ");
    }
  }

  function showFullscreenNote(text) {
    const note = $("fullscreenNote");
    note.textContent = text;
    note.classList.remove("hidden");
  }

  function updateFullscreenLabels() {
    if (!fullscreenSupported) {
      $("fullscreenBtn").textContent = "⛶ เต็มหน้าจอ (เบราว์เซอร์นี้ไม่รองรับ)";
      return;
    }
    const label = isFullscreen() ? "⛶ ออกจากเต็มหน้าจอ" : "⛶ เต็มหน้าจอ";
    $("fullscreenBtn").textContent = label;
  }
  updateFullscreenLabels();

  $("fullscreenBtn").addEventListener("click", async () => {
    await toggleFullscreen();
    updateFullscreenLabels();
  });
  $("fullscreenBtnHud").addEventListener("click", toggleFullscreen);

  ["fullscreenchange", "webkitfullscreenchange", "msfullscreenchange"].forEach((evt) => {
    document.addEventListener(evt, updateFullscreenLabels);
  });

  // ---------- GAME FLOW ----------
  startBtn.addEventListener("click", async () => {
    if (selectedTables.size === 0) {
      selectedTables.add(2);
      selectedTables.add(5);
      tablePicker.children[0].classList.add("active");
      tablePicker.children[3].classList.add("active");
    }
    const ok = await startCamera();
    if (!ok) return;
    startScreen.classList.add("hidden");
    hud.classList.remove("hidden");
    questionBar.classList.remove("hidden");
    $("cameraToggleHud").classList.remove("hidden");
    $("fullscreenBtnHud").classList.remove("hidden");

    if (pointerMode === "hand") {
      tracker.start(onHandUpdate);
    }
    beginRound();
  });

  $("playAgainBtn").addEventListener("click", () => {
    endScreen.classList.add("hidden");
    hud.classList.remove("hidden");
    questionBar.classList.remove("hidden");
    $("cameraToggleHud").classList.remove("hidden");
    $("fullscreenBtnHud").classList.remove("hidden");
    if (pointerMode === "hand") {
      tracker.start(onHandUpdate);
    }
    beginRound();
  });

  $("homeBtnHud").addEventListener("click", goHome);
  $("homeBtnEnd").addEventListener("click", goHome);

  function goHome() {
    roundActive = false;
    clearInterval(timerHandle);
    tracker.stop();
    handCursor.style.display = "none";
    clearHover();
    bubbleLayer.innerHTML = "";

    hud.classList.add("hidden");
    questionBar.classList.add("hidden");
    $("cameraToggleHud").classList.add("hidden");
    $("fullscreenBtnHud").classList.add("hidden");
    endScreen.classList.add("hidden");

    startScreen.classList.remove("hidden");
  }

  function beginRound() {
    roundSeconds = readRoundSeconds();
    score = 0;
    timeLeft = roundSeconds;
    scoreVal.textContent = score;
    timeVal.textContent = timeLeft;
    timerPill.classList.remove("low");
    roundActive = true;
    nextQuestion();
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      timeLeft--;
      timeVal.textContent = timeLeft;
      if (timeLeft <= 10) timerPill.classList.add("low");
      if (timeLeft <= 0) {
        endRound();
      }
    }, 1000);
  }

  function readRoundSeconds() {
    let v = parseInt(roundSecondsInput.value, 10);
    if (isNaN(v)) v = DEFAULT_ROUND_SECONDS;
    v = Math.max(10, Math.min(300, v)); // กันตั้งค่าเพี้ยน: อย่างน้อย 10 วิ ไม่เกิน 300 วิ
    roundSecondsInput.value = v;
    return v;
  }

  function endRound() {
    roundActive = false;
    clearInterval(timerHandle);
    tracker.stop();
    handCursor.style.display = "none";
    clearHover();
    bubbleLayer.innerHTML = "";
    hud.classList.add("hidden");
    questionBar.classList.add("hidden");
    $("cameraToggleHud").classList.add("hidden");
    $("fullscreenBtnHud").classList.add("hidden");
    $("endScore").textContent = score;
    $("endMsg").textContent = pickEndMessage(score);
    endScreen.classList.remove("hidden");
  }

  function pickEndMessage(s) {
    if (s >= 20) return "สุดยอดนักล่าแม่สูตร! 🏆";
    if (s >= 12) return "เก่งมาก! เกือบมือโปรแล้ว 🎉";
    if (s >= 6) return "ทำได้ดี ลองอีกครั้งให้เร็วขึ้น 💪";
    return "ไม่เป็นไร ลองใหม่อีกครั้งนะ 🙂";
  }

  // ---------- QUESTION LOGIC ----------
  function nextQuestion() {
    clearHover();
    bubbleLayer.innerHTML = "";
    const tables = Array.from(selectedTables);
    const a = tables[Math.floor(Math.random() * tables.length)];
    const b = Math.floor(Math.random() * 11) + 2; // 2..12
    const answer = a * b;
    currentAnswer = answer;
    questionBar.textContent = a + " × " + b + " = ?";

    const options = new Set([answer]);
    while (options.size < OPTIONS_COUNT) {
      const delta = Math.floor(Math.random() * 10) - 5;
      let wrong = answer + (delta === 0 ? 3 : delta) * (Math.random() < 0.5 ? 1 : 2);
      wrong = Math.max(1, Math.round(wrong));
      if (wrong !== answer) options.add(wrong);
    }
    const opts = shuffle(Array.from(options));
    spawnBubbles(opts);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function spawnBubbles(values) {
    const w = window.innerWidth,
      h = window.innerHeight;
    const zoneTop = h * 0.32,
      zoneBottom = h * 0.82;
    const cols = values.length;
    const colWidth = w / cols;

    values.forEach((val, i) => {
      const el = document.createElement("div");
      el.className = "bubble";
      el.dataset.val = val;
      el.textContent = val;

      const progress = document.createElement("div");
      progress.className = "bubble-progress";
      el.appendChild(progress);

      const color = BUBBLE_COLORS[Math.floor(Math.random() * BUBBLE_COLORS.length)];
      el.style.background = `radial-gradient(circle at 35% 30%, ${lighten(color)}, ${color})`;
      const x = colWidth * i + colWidth * 0.2 + Math.random() * colWidth * 0.2;
      const y = zoneTop + Math.random() * (zoneBottom - zoneTop);
      el.style.left = Math.max(8, Math.min(w - 150, x)) + "px";
      el.style.top = y + "px";
      el.style.animationDelay = Math.random() * 1.2 + "s";

      // แตะหน้าจอได้เสมอ ไว้เป็นทางเลือกสำรอง เผื่อชี้มือค้างไม่สะดวก
      el.addEventListener("pointerdown", () => {
        selectAnswer(el, val, true);
      });

      bubbleLayer.appendChild(el);
    });
  }

  function lighten(hex) {
    const c = hex.replace("#", "");
    const r = Math.min(255, parseInt(c.substr(0, 2), 16) + 60);
    const g = Math.min(255, parseInt(c.substr(2, 2), 16) + 60);
    const b = Math.min(255, parseInt(c.substr(4, 2), 16) + 60);
    return `rgb(${r},${g},${b})`;
  }

  // ---------- HAND DWELL SELECTION ----------
  function onHandUpdate(point) {
    if (point) {
      handCursor.style.display = "block";
      handCursor.style.left = point.x + "px";
      handCursor.style.top = point.y + "px";
    } else {
      handCursor.style.display = "none";
    }

    if (!roundActive || selectionLocked) {
      clearHover();
      return;
    }
    if (!point) {
      clearHover();
      return;
    }

    const target = findBubbleAtPoint(point);

    if (target !== hoverTarget) {
      if (hoverTarget) setProgress(hoverTarget, 0);
      hoverTarget = target;
      hoverStart = performance.now();
    }

    if (target) {
      const elapsed = performance.now() - hoverStart;
      const pct = Math.min(1, elapsed / DWELL_MS);
      setProgress(target, pct);
      if (pct >= 1) {
        const val = Number(target.dataset.val);
        selectAnswer(target, val, false);
      }
    }
  }

  function findBubbleAtPoint(point) {
    const bubbles = [...bubbleLayer.querySelectorAll(".bubble")];
    for (const b of bubbles) {
      const rect = b.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const r = rect.width / 2;
      const dx = point.x - cx;
      const dy = point.y - cy;
      if (dx * dx + dy * dy <= r * r) return b;
    }
    return null;
  }

  function clearHover() {
    if (hoverTarget) setProgress(hoverTarget, 0);
    hoverTarget = null;
  }

  function setProgress(el, pct) {
    el.style.setProperty("--deg", pct * 360 + "deg");
  }

  // ---------- ANSWER HANDLING (ใช้ร่วมกันทั้ง hand-dwell และ tap) ----------
  function selectAnswer(el, val, fromTap) {
    if (!roundActive) return;
    if (selectionLocked) return;

    if (val === currentAnswer) {
      selectionLocked = true;
      clearHover();
      el.classList.add("pop");
      burstConfetti(el);
      score++;
      scoreVal.textContent = score;
      setTimeout(() => {
        selectionLocked = false;
        nextQuestion();
      }, 260);
    } else {
      el.classList.add("shake");
      setTimeout(() => el.classList.remove("shake"), 350);
      if (!fromTap) {
        // กันชี้ค้างจุดผิดซ้ำทันที ต้องขยับมือออกแล้วค่อยชี้ใหม่
        selectionLocked = true;
        clearHover();
        setTimeout(() => {
          selectionLocked = false;
        }, WRONG_LOCKOUT_MS);
      }
    }
  }

  function burstConfetti(el) {
    const rect = el.getBoundingClientRect();
    for (let i = 0; i < 14; i++) {
      const p = document.createElement("div");
      p.className = "confetti";
      p.style.background = BUBBLE_COLORS[Math.floor(Math.random() * BUBBLE_COLORS.length)];
      p.style.left = rect.left + rect.width / 2 + (Math.random() * 60 - 30) + "px";
      p.style.top = rect.top + rect.height / 2 + "px";
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      bubbleLayer.appendChild(p);
      setTimeout(() => p.remove(), 950);
    }
  }
})();
