// hand-tracking.js
// -----------------------------------------------------------------------
// จัดการเรื่องการตรวจจับตำแหน่งนิ้วชี้ (index fingertip) ด้วย MediaPipe
// Hand Landmarker แล้วแปลงตำแหน่งเป็นพิกัดหน้าจอ (CSS pixel) ให้ game.js
// เอาไปใช้ต่อ ถ้าจะปรับความไว/โมเดล ให้แก้ที่ไฟล์นี้ไฟล์เดียว
// -----------------------------------------------------------------------

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const VISION_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const VISION_BUNDLE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// จุดบนมือที่ใช้เป็น "ตัวชี้" (index fingertip ตามมาตรฐาน MediaPipe = จุดที่ 8)
const POINTER_LANDMARK_INDEX = 8;

export class HandTracker {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this.landmarker = null;
    this.running = false;
    this.onResult = null; // callback({x,y} หรือ null)
    this.mirrored = true; // ต้องตรงกับ CSS transform ของ #camFeed
    this._loop = this._loop.bind(this);
  }

  /** โหลดโมเดล (ใช้เวลาสักครู่ตอนเปิดครั้งแรก ต้องมีอินเทอร์เน็ต) */
  async init() {
    const { HandLandmarker, FilesetResolver } = await import(VISION_BUNDLE_URL);
    const vision = await FilesetResolver.forVisionTasks(VISION_WASM_URL);
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
  }

  /** เรียกทุกครั้งที่สลับกล้องหน้า/หลัง เพื่อให้พิกัดกลับด้านถูกต้อง */
  setMirrored(isMirrored) {
    this.mirrored = isMirrored;
  }

  /** เริ่มลูปตรวจจับ ต่อเนื่องด้วย requestAnimationFrame */
  start(onResult) {
    this.onResult = onResult;
    this.running = true;
    requestAnimationFrame(this._loop);
  }

  stop() {
    this.running = false;
  }

  _loop() {
    if (!this.running) return;

    if (this.landmarker && this.videoEl.readyState >= 2) {
      const nowMs = performance.now();
      let result = null;
      try {
        result = this.landmarker.detectForVideo(this.videoEl, nowMs);
      } catch (e) {
        // เฟรมบางเฟรมอาจ error ได้ตอนกล้องกำลังสลับ ข้ามไปเฟรมถัดไป
      }
      if (result && result.landmarks && result.landmarks.length > 0) {
        const tip = result.landmarks[0][POINTER_LANDMARK_INDEX];
        const point = this._toScreenPoint(tip);
        if (this.onResult) this.onResult(point);
      } else {
        if (this.onResult) this.onResult(null);
      }
    }

    requestAnimationFrame(this._loop);
  }

  /**
   * แปลงพิกัด normalized (0..1 บนภาพกล้องดิบ) เป็นพิกัด CSS pixel
   * บนหน้าจอจริง โดยคำนวณตาม object-fit:cover ของ <video>
   */
  _toScreenPoint(lm) {
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) return null;

    const rect = this.videoEl.getBoundingClientRect();
    const videoAspect = vw / vh;
    const dispAspect = rect.width / rect.height;

    let scale, offsetX = 0, offsetY = 0, scaledW, scaledH;
    if (videoAspect > dispAspect) {
      // ภาพกล้องกว้างกว่าจอ -> โดนตัดซ้าย/ขวา
      scale = rect.height / vh;
      scaledW = vw * scale;
      scaledH = rect.height;
      offsetX = (scaledW - rect.width) / 2;
    } else {
      // ภาพกล้องสูงกว่าจอ -> โดนตัดบน/ล่าง
      scale = rect.width / vw;
      scaledW = rect.width;
      scaledH = vh * scale;
      offsetY = (scaledH - rect.height) / 2;
    }

    let nx = lm.x; // 0 = ซ้ายของภาพดิบ, 1 = ขวาของภาพดิบ
    if (this.mirrored) nx = 1 - nx;

    const xInScaled = nx * scaledW - offsetX;
    const yInScaled = lm.y * scaledH - offsetY;

    return {
      x: rect.left + xInScaled,
      y: rect.top + yInScaled,
    };
  }
}
