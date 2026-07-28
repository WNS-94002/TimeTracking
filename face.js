/**
 * face.js — ห่อการทำงานของ face-api ไว้ทั้งหมด (โหลดโมเดล, กล้อง, ถอดลักษณะใบหน้า, จับคู่)
 *
 * แยกจาก app.js เพราะเป็นคนละเรื่องกัน: ไฟล์นี้ไม่รู้จัก Google Sheet และไม่แตะ DOM ของหน้าเว็บ
 * นอกจาก <video>/<canvas> ที่ส่งเข้ามา
 *
 * ศัพท์ที่ใช้: "descriptor" คือเวกเตอร์ 128 ค่าที่แทนใบหน้าหนึ่งใบ — เทียบสองใบหน้าด้วย
 * ระยะแบบยุคลิดระหว่าง descriptor ยิ่งน้อยยิ่งเหมือน
 */

const FaceEngine = (() => {
  const MODEL_URL = 'models';
  const DESCRIPTOR_LENGTH = 128;

  // ขนาดอินพุตของ tinyFaceDetector — 320 เร็วพอสำหรับหน้าเดียวระยะใกล้แบบเครื่องสแกน
  const detectorOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

  let modelsReady = false;
  let loadingPromise = null;
  let stream = null;

  // ===== โมเดล =====

  function isReady() {
    return modelsReady;
  }

  /** โหลดโมเดลจากโฟลเดอร์ models/ (เรียกซ้ำได้ — ครั้งถัดไปคืน Promise เดิม) */
  function loadModels() {
    if (modelsReady) return Promise.resolve();
    if (loadingPromise) return loadingPromise;

    if (typeof faceapi === 'undefined') {
      return Promise.reject(new Error('โหลดไลบรารี face-api ไม่สำเร็จ — ตรวจการเชื่อมต่ออินเทอร์เน็ต'));
    }

    loadingPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]).then(() => {
      modelsReady = true;
    }).catch((err) => {
      loadingPromise = null; // ให้ลองใหม่ได้ถ้าเน็ตหลุดตอนโหลด
      throw new Error('โหลดโมเดลใบหน้าไม่สำเร็จ: ' + err.message);
    });

    return loadingPromise;
  }

  // ===== กล้อง =====

  /**
   * เปิดกล้องแล้วผูกกับ <video> ที่ส่งเข้ามา
   * ต้องเรียกจากหน้าที่เปิดผ่าน https:// หรือ http://localhost เท่านั้น — เปิดไฟล์ตรง ๆ กล้องจะไม่ทำงาน
   */
  async function startCamera(videoEl) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('เบราว์เซอร์นี้ใช้กล้องไม่ได้ หรือหน้าเว็บไม่ได้เปิดผ่าน https/localhost');
    }
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (err) {
      throw new Error(cameraErrorMessage(err));
    }
    videoEl.srcObject = stream;
    await videoEl.play();
    // รอจนรู้ขนาดภาพจริง มิฉะนั้น canvas ที่วาดทับจะขนาดเป็น 0
    if (!videoEl.videoWidth) {
      await new Promise((resolve) => videoEl.addEventListener('loadeddata', resolve, { once: true }));
    }
    return stream;
  }

  function stopCamera() {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function cameraErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'ไม่ได้รับอนุญาตให้ใช้กล้อง — กดอนุญาตที่แถบที่อยู่ของเบราว์เซอร์แล้วลองใหม่';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'ไม่พบกล้องบนเครื่องนี้';
    }
    if (name === 'NotReadableError') {
      return 'กล้องถูกโปรแกรมอื่นใช้งานอยู่ — ปิดโปรแกรมนั้นแล้วลองใหม่';
    }
    return 'เปิดกล้องไม่สำเร็จ: ' + (err && err.message ? err.message : err);
  }

  // ===== ตรวจจับใบหน้า =====

  /** ตรวจจับใบหน้าเด่นที่สุดหนึ่งใบ คืน null ถ้าไม่เจอ */
  async function detect(videoEl) {
    if (!modelsReady || !videoEl || !videoEl.videoWidth) return null;
    return faceapi
      .detectSingleFace(videoEl, detectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();
  }

  /** วาดกรอบรอบใบหน้าลงบน canvas ที่ซ้อนทับวิดีโอ (สีบอกสถานะ: เขียว=รู้จัก, ส้ม=ยังไม่รู้จัก) */
  function drawBox(canvasEl, videoEl, detection, color) {
    if (!canvasEl || !videoEl) return;
    if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
    }
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!detection) return;

    const { x, y, width, height } = detection.detection.box;
    ctx.strokeStyle = color || '#4f46e5';
    ctx.lineWidth = Math.max(2, canvasEl.width / 200);
    ctx.lineJoin = 'round';
    ctx.strokeRect(x, y, width, height);
  }

  function clearBox(canvasEl) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  }

  /** ถ่ายภาพนิ่งจากวิดีโอเป็น JPEG ย่อขนาด — ใช้เป็นหลักฐานแนบไปกับการบันทึกเวลา */
  function snapshot(videoEl, maxWidth = 480, quality = 0.72) {
    if (!videoEl || !videoEl.videoWidth) return '';
    const scale = Math.min(1, maxWidth / videoEl.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(videoEl.videoWidth * scale);
    canvas.height = Math.round(videoEl.videoHeight * scale);
    canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }

  // ===== descriptor: แปลงไป-กลับกับข้อความที่เก็บในชีต =====

  function serializeDescriptor(descriptor) {
    return Array.from(descriptor).map((v) => v.toFixed(6)).join(',');
  }

  function parseDescriptor(text) {
    const parts = String(text || '').split(',');
    if (parts.length !== DESCRIPTOR_LENGTH) return null;
    const arr = new Float32Array(DESCRIPTOR_LENGTH);
    for (let i = 0; i < DESCRIPTOR_LENGTH; i++) {
      const n = Number(parts[i]);
      if (Number.isNaN(n)) return null;
      arr[i] = n;
    }
    return arr;
  }

  /** เฉลี่ย descriptor หลายมุมหน้าให้เหลือตัวแทนหนึ่งอัน — ทนต่อการเอียงหน้า/แสงมากกว่าใช้ภาพเดียว */
  function averageDescriptors(descriptors) {
    if (!descriptors.length) return null;
    const out = new Float32Array(DESCRIPTOR_LENGTH);
    descriptors.forEach((d) => {
      for (let i = 0; i < DESCRIPTOR_LENGTH; i++) out[i] += d[i];
    });
    for (let i = 0; i < DESCRIPTOR_LENGTH; i++) out[i] /= descriptors.length;
    return out;
  }

  function distance(a, b) {
    let sum = 0;
    for (let i = 0; i < DESCRIPTOR_LENGTH; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  // ===== จับคู่ =====

  /**
   * เตรียมชุดใบหน้าที่ลงทะเบียนไว้ให้พร้อมเทียบ
   * แถวจากแท็บ FaceData: { EmployeeID, Descriptor }  — หนึ่งคนมีได้หลายแถว
   * ข้ามแถวที่ descriptor เสียหรือของพนักงานที่ไม่อยู่ใน activeIds (เช่น ลาออกแล้ว)
   */
  function buildIndex(faceRows, activeIds) {
    const index = [];
    (faceRows || []).forEach((row) => {
      const id = row.EmployeeID;
      if (!id) return;
      if (activeIds && !activeIds.has(String(id))) return;
      const descriptor = parseDescriptor(row.Descriptor);
      if (!descriptor) return;
      index.push({ employeeId: String(id), descriptor });
    });
    return index;
  }

  /**
   * หาว่า descriptor ที่เพิ่งสแกนตรงกับพนักงานคนไหน
   *
   * ผ่านก็ต่อเมื่อครบสองเงื่อนไข:
   *   1. ระยะที่ใกล้ที่สุด < threshold
   *   2. ห่างจากคนอันดับสองอย่างน้อย margin
   * เงื่อนไขที่สองคือตัวกันสับสนระหว่างคนหน้าคล้ายกัน — ถ้าสองคนใกล้เคียงกันมาก
   * ให้ถือว่าตัดสินไม่ได้ ดีกว่าเดาแล้วบันทึกเวลาให้ผิดคน
   */
  function match(descriptor, index, threshold, margin) {
    if (!descriptor || !index.length) return { employeeId: null, distance: null, reason: 'no-index' };

    // ใช้ระยะที่ดีที่สุดของแต่ละคน (คนหนึ่งลงทะเบียนไว้ได้หลายมุมหน้า)
    const best = new Map();
    index.forEach((entry) => {
      const d = distance(descriptor, entry.descriptor);
      const current = best.get(entry.employeeId);
      if (current === undefined || d < current) best.set(entry.employeeId, d);
    });

    const ranked = Array.from(best.entries())
      .map(([employeeId, d]) => ({ employeeId, distance: d }))
      .sort((a, b) => a.distance - b.distance);

    const top = ranked[0];
    if (top.distance >= threshold) {
      return { employeeId: null, distance: top.distance, reason: 'too-far' };
    }
    if (ranked.length > 1 && ranked[1].distance - top.distance < margin) {
      return { employeeId: null, distance: top.distance, reason: 'ambiguous' };
    }
    return { employeeId: top.employeeId, distance: top.distance, reason: 'ok' };
  }

  /**
   * ตัวยืนยันความต่อเนื่อง — ต้องเจอคนเดิมติดกันครบจำนวนเฟรมที่กำหนดก่อนจึงจะถือว่าใช่
   * กันกรณีจับผิดชั่ววูบตอนคนเดินผ่านหน้ากล้อง
   */
  function createStabilizer(requiredHits = 3) {
    let lastId = null;
    let hits = 0;
    return {
      /** คืน true ครั้งเดียวเมื่อยืนยันครบ */
      push(employeeId) {
        if (!employeeId) { lastId = null; hits = 0; return false; }
        if (employeeId === lastId) hits++;
        else { lastId = employeeId; hits = 1; }
        return hits === requiredHits;
      },
      reset() { lastId = null; hits = 0; },
      get progress() { return hits; },
      get required() { return requiredHits; }
    };
  }

  return {
    DESCRIPTOR_LENGTH,
    isReady,
    loadModels,
    startCamera,
    stopCamera,
    detect,
    drawBox,
    clearBox,
    snapshot,
    serializeDescriptor,
    parseDescriptor,
    averageDescriptors,
    distance,
    buildIndex,
    match,
    createStabilizer
  };
})();
