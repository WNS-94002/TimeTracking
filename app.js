/* ===== ตั้งค่าการเชื่อมต่อ ===== */

// URL ของ Apps Script Web App ที่ deploy แล้ว (ลงท้ายด้วย /exec)
const API_URL = 'https://script.google.com/macros/s/AKfycbz-DL_1tsIxaVud0UnZa9WUiuMDoPe203n8YGrcOV7T3kTxW0mbJRCD0q39O0IESlGdVA/exec';

// ต้องตรงกับ API_TOKEN ใน Code.gs ('' = ปิดการตรวจสอบ)
const API_TOKEN = '';

// ชื่อเครื่องที่ใช้สแกน — บันทึกลงคอลัมน์ Device ใน ScanLogs เพื่อให้รู้ว่ารายการมาจากจุดไหน
const DEVICE_NAME = 'จุดสแกนหลัก';

/* ===== สถานะรวมของหน้าเว็บ ===== */

const state = {
  view: 'scan',
  params: {},
  loaded: false,
  settings: {},
  employees: [],
  faces: [],
  faceIndex: [],
  scanMode: 'AUTO',       // AUTO | IN | OUT
  scanning: false,        // กล้องเปิดอยู่หรือไม่ — เริ่มเป็น false เสมอ ต้องกดปุ่มก่อน
  today: [],              // แถว Attendance ของวันนี้ (ใช้ทั้งหน้าสแกนและภาพรวม)
  attendance: [],         // ผลการค้นหาในหน้าประวัติ
  attendanceFilter: {},
  enroll: { employeeId: '', samples: [], cameraOn: false }
};

const PAGE_TITLES = {
  scan: 'สแกนเข้า-ออกงาน',
  dashboard: 'ภาพรวมวันนี้',
  attendance: 'ประวัติเวลาทำงาน',
  enroll: 'ลงทะเบียนใบหน้า',
  employees: 'พนักงาน',
  employeeForm: 'เพิ่ม/แก้ไขพนักงาน',
  settings: 'ตั้งค่า'
};

/* ===== API helpers =====
   apiPost ตั้งใจไม่ใส่ header Content-Type — Apps Script ตั้ง CORS header บน preflight ไม่ได้
   คำขอจึงต้องคงสภาพเป็น "simple request" ฝั่ง doPost อ่านด้วย JSON.parse(e.postData.contents) อยู่แล้ว
   อย่าเติม Content-Type: application/json เข้าไป มิฉะนั้น POST จะพังทั้งหมด */

async function apiGet(action, params) {
  requireApiUrl();
  const url = new URL(API_URL);
  url.searchParams.set('action', action);
  if (API_TOKEN) url.searchParams.set('token', API_TOKEN);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'Request failed');
  return body.data;
}

async function apiPost(payload) {
  requireApiUrl();
  const res = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ ...payload, token: API_TOKEN })
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'Request failed');
  return body.data;
}

function requireApiUrl() {
  if (!API_URL) throw new Error('ยังไม่ได้ตั้งค่า API_URL ใน app.js — ดูขั้นตอนใน README.md');
}

function showError(message) {
  const banner = document.getElementById('errorBanner');
  banner.textContent = message;
  banner.hidden = false;
  clearTimeout(showError._t);
  showError._t = setTimeout(() => { banner.hidden = true; }, 6000);
}

/* ===== ตัวช่วยทั่วไป ===== */

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthStartKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** ลิงก์ Drive ที่เก็บในชีตเป็นแบบเปิดดูในเว็บ — แปลงเป็น URL รูปย่อเพื่อเอามาแสดงใน <img> */
function driveThumb(url, size = 120) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? `https://drive.google.com/thumbnail?id=${m[0]}&sz=w${size}` : '';
}

function employeeById(id) {
  return state.employees.find((e) => String(e.EmployeeID) === String(id)) || null;
}

function isActive(employee) {
  const status = String(employee.Status || '').trim();
  return status === '' || status === 'ทำงาน' || status.toLowerCase() === 'active';
}

function activeEmployees() {
  return state.employees.filter(isActive);
}

/** พนักงานคนนี้ลงทะเบียนใบหน้าไว้กี่แบบ */
function faceCountOf(employeeId) {
  return state.faces.filter((f) => String(f.EmployeeID) === String(employeeId)).length;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/* ===== การนำทาง ===== */

function setView(view, params) {
  stopScanLoop();          // ออกจากหน้าที่ใช้กล้องเมื่อไร ต้องปิดกล้องทันที ไฟกล้องจะได้ไม่ค้าง
  FaceEngine.stopCamera();
  state.enroll.cameraOn = false;
  state.view = view;
  state.params = params || {};
  render();
}

function render() {
  const app = document.getElementById('app');
  document.getElementById('pageTitle').textContent = PAGE_TITLES[state.view] || '';

  document.querySelectorAll('#mainTabs .nav-item').forEach((btn) => {
    const view = btn.dataset.view;
    const active = view === state.view || (view === 'employees' && state.view === 'employeeForm');
    btn.classList.toggle('active', active);
  });
  document.getElementById('sidebar').classList.remove('open');

  if (!state.loaded) {
    app.innerHTML = '<p class="loading">กำลังโหลดข้อมูล...</p>';
    return;
  }

  switch (state.view) {
    case 'scan': renderScan(app); break;
    case 'dashboard': renderDashboard(app); break;
    case 'attendance': renderAttendance(app); break;
    case 'enroll': renderEnroll(app); break;
    case 'employees': renderEmployees(app); break;
    case 'employeeForm': renderEmployeeForm(app); break;
    case 'settings': renderSettings(app); break;
    default: app.innerHTML = '<p class="empty">ไม่พบหน้าที่ต้องการ</p>';
  }
}

/* ===== หน้าสแกน ===== */

// โทเคนกันลูปเก่าทำงานค้างหลังเปลี่ยนหน้า — ทุกครั้งที่เริ่มลูปใหม่จะเพิ่มค่านี้
let scanToken = 0;
let scanBusy = false;

function stopScanLoop() {
  scanToken++;
  scanBusy = false;
  state.scanning = false;
}

function renderScan(app) {
  app.innerHTML = `
    <div class="scan-layout">
      <div>
        <div class="video-frame mirrored" id="scanFrame">
          <video id="scanVideo" playsinline muted></video>
          <canvas class="overlay" id="scanOverlay"></canvas>
          <div class="cam-placeholder" id="camPlaceholder">
            <svg viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7z" stroke-linecap="round" stroke-linejoin="round"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
            <span id="camMessage">กดปุ่ม "เริ่มสแกน" เพื่อเปิดกล้อง</span>
          </div>
        </div>
        <div class="scan-controls">
          <button class="btn" id="btnScanToggle">เริ่มสแกน</button>
          <p class="scan-hint" id="scanHint">กล้องจะเปิดก็ต่อเมื่อกดปุ่มนี้เท่านั้น</p>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-header">
            <h3 style="margin:0;font-size:1rem;">โหมดบันทึก</h3>
            <div class="mode-switch" id="modeSwitch">
              <button data-mode="AUTO" class="${state.scanMode === 'AUTO' ? 'active' : ''}">อัตโนมัติ</button>
              <button data-mode="IN" class="${state.scanMode === 'IN' ? 'active' : ''}">เข้างาน</button>
              <button data-mode="OUT" class="${state.scanMode === 'OUT' ? 'active' : ''}">ออกงาน</button>
            </div>
          </div>
          <div id="resultCard" class="result-card">
            <div class="result-meta">รอสแกนใบหน้า</div>
          </div>
        </div>

        <div class="card">
          <div class="section-head">
            <h3>บันทึกวันนี้</h3>
            <span class="section-sub" id="todayCount"></span>
          </div>
          <div class="scan-feed" id="scanFeed"></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('modeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.scanMode = btn.dataset.mode;
    document.querySelectorAll('#modeSwitch button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === state.scanMode);
    });
  });

  document.getElementById('btnScanToggle').addEventListener('click', () => {
    if (state.scanning) stopScan();
    else startScan();
  });

  renderScanFeed();
}

/** ปิดกล้องและหยุดลูป แล้วคืนหน้าจอกลับสู่สถานะรอกดเริ่ม */
function stopScan() {
  stopScanLoop();
  FaceEngine.stopCamera();

  const video = document.getElementById('scanVideo');
  // ต้องล้าง srcObject ด้วย ไม่งั้นภาพเฟรมสุดท้ายจะค้างอยู่บนจอ ดูเหมือนกล้องยังทำงาน
  if (video) video.srcObject = null;

  FaceEngine.clearBox(document.getElementById('scanOverlay'));
  const placeholder = document.getElementById('camPlaceholder');
  if (placeholder) placeholder.hidden = false;
  setScanMessage('กดปุ่ม "เริ่มสแกน" เพื่อเปิดกล้อง');
  setScanButton('เริ่มสแกน', false);
  setScanHint('กล้องจะเปิดก็ต่อเมื่อกดปุ่มนี้เท่านั้น');
  showResult(null);
}

function setScanButton(label, running, disabled) {
  const btn = document.getElementById('btnScanToggle');
  if (!btn) return;
  btn.textContent = label;
  btn.disabled = !!disabled;
  btn.classList.toggle('danger', !!running);
}

function setScanMessage(text) {
  const el = document.getElementById('camMessage');
  if (el) el.textContent = text;
}

function setScanHint(text) {
  const el = document.getElementById('scanHint');
  if (el) el.textContent = text;
}

function renderScanFeed() {
  const feed = document.getElementById('scanFeed');
  const countEl = document.getElementById('todayCount');
  if (!feed) return;

  const rows = [...state.today].sort((a, b) => String(b.TimeIn || '').localeCompare(String(a.TimeIn || '')));
  if (countEl) countEl.textContent = `${rows.length} คน`;

  if (!rows.length) {
    feed.innerHTML = '<p class="empty">ยังไม่มีการบันทึกของวันนี้</p>';
    return;
  }

  feed.innerHTML = rows.map((r) => {
    const thumb = driveThumb(r.PhotoOutURL || r.PhotoInURL, 80);
    const out = r.TimeOut ? ` · ออก ${escapeHtml(r.TimeOut)}` : '';
    const late = num(r.LateMinutes, 0) > 0
      ? `<span class="pill pill-warn">สาย ${r.LateMinutes} น.</span>`
      : '<span class="pill pill-good">ตรงเวลา</span>';
    return `
      <div class="scan-feed-item">
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<img alt="">'}
        <div class="who">
          <strong>${escapeHtml(r.FullName)}</strong>
          <span>เข้า ${escapeHtml(r.TimeIn || '-')}${out}</span>
        </div>
        ${late}
      </div>`;
  }).join('');
}

async function startScan() {
  const video = document.getElementById('scanVideo');
  const overlay = document.getElementById('scanOverlay');
  const placeholder = document.getElementById('camPlaceholder');

  setScanButton('กำลังเปิดกล้อง...', false, true);

  try {
    if (!FaceEngine.isReady()) {
      setScanMessage('กำลังโหลดโมเดลใบหน้า...');
      await FaceEngine.loadModels();
    }
    setScanMessage('กำลังเปิดกล้อง...');
    await FaceEngine.startCamera(video);
  } catch (err) {
    showError(err.message);
    setScanMessage(err.message);
    setScanButton('ลองอีกครั้ง', false);
    return;
  }

  // ผู้ใช้อาจเปลี่ยนหน้าระหว่างรอกล้อง — ต้องปิดกล้องที่เพิ่งเปิดทิ้ง ไม่งั้นไฟกล้องค้าง
  if (state.view !== 'scan') { FaceEngine.stopCamera(); return; }

  placeholder.hidden = true;
  state.scanning = true;
  setScanButton('หยุดสแกน', true);
  setScanHint(state.faceIndex.length
    ? 'หันหน้าเข้ากล้องให้อยู่ในกรอบ ระบบจะบันทึกให้อัตโนมัติ'
    : 'ยังไม่มีใบหน้าที่ลงทะเบียนไว้ — ไปที่เมนู "ลงทะเบียนใบหน้า" ก่อน');

  scanToken++;
  const myToken = scanToken;
  const stabilizer = FaceEngine.createStabilizer(3);
  const threshold = num(state.settings.MatchThreshold, 0.45);
  const margin = num(state.settings.MatchMargin, 0.05);

  // เดินลูปด้วย setTimeout ~3 ครั้ง/วินาที — เร็วพอสำหรับคนเดินมายืนหน้ากล้อง และไม่กินซีพียูจนภาพกระตุก
  const tick = async () => {
    if (myToken !== scanToken) return;
    if (!scanBusy) {
      try {
        const detection = await FaceEngine.detect(video);
        if (myToken !== scanToken) return;

        if (!detection) {
          FaceEngine.clearBox(overlay);
          stabilizer.reset();
        } else {
          const result = FaceEngine.match(detection.descriptor, state.faceIndex, threshold, margin);
          FaceEngine.drawBox(overlay, video, detection, result.employeeId ? '#16a34a' : '#d97706');
          if (!result.employeeId) {
            stabilizer.reset();
            setScanHint(matchFailMessage(result));
          } else {
            setScanHint(`กำลังยืนยัน... (${stabilizer.progress + 1}/${stabilizer.required})`);
            if (stabilizer.push(result.employeeId)) {
              scanBusy = true;
              stabilizer.reset();
              await submitScan(result.employeeId, result.distance, video, overlay, myToken);
            }
          }
        }
      } catch (err) {
        showError(err.message);
      }
    }
    setTimeout(tick, 300);
  };
  tick();
}

function matchFailMessage(result) {
  if (result.reason === 'no-index') return 'ยังไม่มีใบหน้าที่ลงทะเบียนไว้';
  if (result.reason === 'ambiguous') return 'ใบหน้าใกล้เคียงกันหลายคน — ขยับเข้าใกล้กล้องอีกนิด';
  return 'ไม่พบข้อมูลใบหน้าของคนนี้';
}

async function submitScan(employeeId, distance, video, overlay, myToken) {
  const photo = FaceEngine.snapshot(video);
  const employee = employeeById(employeeId);
  showResult({ pending: true, employee });

  try {
    const data = await apiPost({
      type: 'recordScan',
      scan: {
        EmployeeID: employeeId,
        Type: state.scanMode,
        Distance: distance,
        PhotoBase64: photo,
        Device: DEVICE_NAME
      }
    });
    if (!data.duplicate) upsertToday(data.attendance);
    showResult({ ...data, photo });
    renderScanFeed();
  } catch (err) {
    showError(err.message);
    showResult({ error: err.message, employee });
  }

  // หน่วงไว้ให้คนอ่านผลทัน แล้วค่อยรับคนถัดไป
  setTimeout(() => {
    if (myToken !== scanToken) return;
    scanBusy = false;
    FaceEngine.clearBox(overlay);
    setScanHint('หันหน้าเข้ากล้องให้อยู่ในกรอบ ระบบจะบันทึกให้อัตโนมัติ');
    showResult(null);
  }, 4000);
}

function upsertToday(row) {
  if (!row) return;
  const i = state.today.findIndex((r) => String(r.EmployeeID) === String(row.EmployeeID));
  if (i === -1) state.today.push(row);
  else state.today[i] = row;
}

function showResult(result) {
  const card = document.getElementById('resultCard');
  if (!card) return;

  if (!result) {
    card.className = 'result-card';
    card.innerHTML = '<div class="result-meta">รอสแกนใบหน้า</div>';
    return;
  }

  const name = result.employee ? result.employee.FullName : '';
  const dept = result.employee ? (result.employee.Department || '') : '';

  if (result.pending) {
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-name">${escapeHtml(name)}</div>
      <div class="result-meta">กำลังบันทึก...</div>`;
    return;
  }

  if (result.error) {
    card.className = 'result-card is-bad';
    card.innerHTML = `
      <div class="result-name">${escapeHtml(name)}</div>
      <div class="result-meta">บันทึกไม่สำเร็จ</div>
      <div class="result-meta">${escapeHtml(result.error)}</div>`;
    return;
  }

  if (result.duplicate) {
    card.className = 'result-card is-bad';
    card.innerHTML = `
      ${result.photo ? `<img class="result-shot" src="${result.photo}" alt="">` : ''}
      <div class="result-name">${escapeHtml(name)}</div>
      <div class="result-meta">${escapeHtml(result.message)}</div>`;
    return;
  }

  const isIn = result.type === 'IN';
  const att = result.attendance || {};
  const late = num(att.LateMinutes, 0);

  card.className = `result-card ${isIn ? 'is-in' : 'is-out'}`;
  card.innerHTML = `
    ${result.photo ? `<img class="result-shot" src="${result.photo}" alt="">` : ''}
    <div class="result-name">${escapeHtml(name)}</div>
    <div class="result-meta">${escapeHtml(dept)}</div>
    <div class="result-time">${escapeHtml(result.time)}</div>
    <div>
      <span class="pill ${isIn ? 'pill-good' : 'pill-info'}">${isIn ? 'บันทึกเวลาเข้างาน' : 'บันทึกเวลาออกงาน'}</span>
      ${isIn && late > 0 ? `<span class="pill pill-warn">สาย ${late} นาที</span>` : ''}
      ${!isIn && att.WorkHours !== '' && att.WorkHours !== undefined ? `<span class="pill pill-neutral">ทำงาน ${att.WorkHours} ชม.</span>` : ''}
    </div>`;
}

/* ===== หน้าภาพรวมวันนี้ ===== */

const ICONS = {
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4 12 14.01l-3-3"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>',
  absent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>'
};

function statCard(accent, icon, label, value, unit, sub) {
  return `
    <div class="stat-card accent-${accent}">
      <div class="stat-icon">${icon}</div>
      <div class="stat-body">
        <div class="stat-label">${escapeHtml(label)}</div>
        <div class="stat-value">${escapeHtml(value)}<span class="stat-unit">${escapeHtml(unit || '')}</span></div>
        ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}
      </div>
    </div>`;
}

function renderDashboard(app) {
  const total = activeEmployees().length;
  const arrived = state.today.filter((r) => r.TimeIn).length;
  const late = state.today.filter((r) => num(r.LateMinutes, 0) > 0).length;
  const left = state.today.filter((r) => r.TimeOut).length;
  const absent = Math.max(0, total - arrived);
  const enrolled = activeEmployees().filter((e) => faceCountOf(e.EmployeeID) > 0).length;

  const rows = [...state.today].sort((a, b) => String(a.TimeIn || '').localeCompare(String(b.TimeIn || '')));

  app.innerHTML = `
    <div class="stat-grid">
      ${statCard('success', ICONS.check, 'มาแล้ววันนี้', arrived, `/ ${total} คน`)}
      ${statCard('warn', ICONS.clock, 'มาสาย', late, 'คน', `เกิน ${escapeHtml(state.settings.WorkStartTime)} + ผ่อนผัน ${escapeHtml(state.settings.LateGraceMinutes)} นาที`)}
      ${statCard('info', ICONS.out, 'ออกงานแล้ว', left, 'คน')}
      ${statCard('danger', ICONS.absent, 'ยังไม่มา', absent, 'คน')}
      ${statCard('primary', ICONS.people, 'ลงทะเบียนใบหน้าแล้ว', enrolled, `/ ${total} คน`)}
    </div>

    <div class="card">
      <div class="section-head">
        <h3>รายการวันนี้ (${escapeHtml(todayKey())})</h3>
        <span class="section-sub">เรียงตามเวลาเข้างาน</span>
      </div>
      ${rows.length ? `
      <div class="table-wrap">
        <table class="table-nowrap">
          <thead><tr><th>รูป</th><th>ชื่อ</th><th>แผนก</th><th>เข้างาน</th><th>ออกงาน</th><th>สาย</th><th>ชั่วโมง</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${photoCell(r.PhotoInURL)}</td>
                <td>${escapeHtml(r.FullName)}</td>
                <td class="muted">${escapeHtml(r.Department || '-')}</td>
                <td>${escapeHtml(r.TimeIn || '-')}</td>
                <td>${escapeHtml(r.TimeOut || '-')}</td>
                <td>${lateCell(r.LateMinutes)}</td>
                <td>${escapeHtml(r.WorkHours === '' || r.WorkHours === undefined ? '-' : r.WorkHours)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<p class="empty">ยังไม่มีใครสแกนเข้างานวันนี้</p>'}
    </div>

    ${absent > 0 ? `
    <div class="card">
      <div class="section-head"><h3>ยังไม่มาวันนี้</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>รหัส</th><th>ชื่อ</th><th>แผนก</th></tr></thead>
          <tbody>
            ${activeEmployees()
              .filter((e) => !state.today.some((r) => String(r.EmployeeID) === String(e.EmployeeID) && r.TimeIn))
              .map((e) => `<tr><td class="muted">${escapeHtml(e.EmployeeID)}</td><td>${escapeHtml(e.FullName)}</td><td class="muted">${escapeHtml(e.Department || '-')}</td></tr>`)
              .join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `;
}

function photoCell(url) {
  const thumb = driveThumb(url, 80);
  if (!thumb) return '<span class="muted">-</span>';
  return `<a class="thumb-link" href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${thumb}" alt="" loading="lazy"></a>`;
}

function lateCell(minutes) {
  const m = num(minutes, 0);
  if (!minutes && minutes !== 0) return '<span class="muted">-</span>';
  return m > 0 ? `<span class="pill pill-warn">${m} น.</span>` : '<span class="pill pill-good">ตรงเวลา</span>';
}

/* ===== หน้าประวัติเวลาทำงาน ===== */

function renderAttendance(app) {
  const f = state.attendanceFilter;
  const departments = [...new Set(state.employees.map((e) => e.Department).filter(Boolean))];

  const rows = state.attendance.filter((r) => {
    if (f.department && r.Department !== f.department) return false;
    if (f.status === 'late' && !(num(r.LateMinutes, 0) > 0)) return false;
    if (f.status === 'open' && r.TimeOut) return false;
    return true;
  });

  app.innerHTML = `
    <div class="card">
      <div class="filters">
        <div class="form-field">
          <label for="fFrom">ตั้งแต่วันที่</label>
          <input type="date" id="fFrom" value="${escapeHtml(f.from)}">
        </div>
        <div class="form-field">
          <label for="fTo">ถึงวันที่</label>
          <input type="date" id="fTo" value="${escapeHtml(f.to)}">
        </div>
        <div class="form-field">
          <label for="fDept">แผนก</label>
          <select id="fDept">
            <option value="">ทุกแผนก</option>
            ${departments.map((d) => `<option value="${escapeHtml(d)}" ${f.department === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label for="fStatus">สถานะ</label>
          <select id="fStatus">
            <option value="">ทั้งหมด</option>
            <option value="late" ${f.status === 'late' ? 'selected' : ''}>เฉพาะที่มาสาย</option>
            <option value="open" ${f.status === 'open' ? 'selected' : ''}>ยังไม่ออกงาน</option>
          </select>
        </div>
        <button class="btn" id="btnSearch">ค้นหา</button>
        <button class="btn secondary" id="btnExport">ส่งออก CSV</button>
      </div>

      <div class="section-head">
        <h3>ผลการค้นหา</h3>
        <span class="section-sub">${rows.length} รายการ · รวมชั่วโมงทำงาน ${rows.reduce((s, r) => s + num(r.WorkHours, 0), 0).toFixed(2)} ชม.</span>
      </div>

      ${rows.length ? `
      <div class="table-wrap">
        <table class="table-nowrap">
          <thead><tr><th>วันที่</th><th>ชื่อ</th><th>แผนก</th><th>เข้างาน</th><th>ออกงาน</th><th>สาย</th><th>ชั่วโมง</th><th>รูป</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${escapeHtml(r.Date)}</td>
                <td>${escapeHtml(r.FullName)}</td>
                <td class="muted">${escapeHtml(r.Department || '-')}</td>
                <td>${escapeHtml(r.TimeIn || '-')}</td>
                <td>${escapeHtml(r.TimeOut || '-')}</td>
                <td>${lateCell(r.LateMinutes)}</td>
                <td>${escapeHtml(r.WorkHours === '' || r.WorkHours === undefined ? '-' : r.WorkHours)}</td>
                <td>${photoCell(r.PhotoInURL)}</td>
                <td><button class="link-btn" data-edit="${escapeHtml(r.Date)}|${escapeHtml(r.EmployeeID)}">แก้เวลา</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<p class="empty">ไม่พบรายการในช่วงที่เลือก</p>'}
    </div>
  `;

  document.getElementById('btnSearch').addEventListener('click', () => {
    state.attendanceFilter = {
      from: document.getElementById('fFrom').value,
      to: document.getElementById('fTo').value,
      department: document.getElementById('fDept').value,
      status: document.getElementById('fStatus').value
    };
    loadAttendance();
  });

  document.getElementById('btnExport').addEventListener('click', () => exportCsv(rows));

  app.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [date, employeeId] = btn.dataset.edit.split('|');
      editAttendance(date, employeeId);
    });
  });
}

async function loadAttendance() {
  const app = document.getElementById('app');
  app.innerHTML = '<p class="loading">กำลังค้นหา...</p>';
  try {
    const f = state.attendanceFilter;
    state.attendance = await apiGet('listAttendance', { from: f.from, to: f.to });
  } catch (err) {
    showError(err.message);
    state.attendance = [];
  }
  render();
}

async function editAttendance(date, employeeId) {
  const row = state.attendance.find((r) => r.Date === date && String(r.EmployeeID) === String(employeeId));
  if (!row) return;

  const timeIn = prompt(`เวลาเข้างานของ ${row.FullName} (${date})\nรูปแบบ HH:mm — เว้นว่างเพื่อลบ`, row.TimeIn || '');
  if (timeIn === null) return;
  const timeOut = prompt(`เวลาออกงานของ ${row.FullName} (${date})\nรูปแบบ HH:mm — เว้นว่างเพื่อลบ`, row.TimeOut || '');
  if (timeOut === null) return;

  try {
    const updated = await apiPost({
      type: 'updateAttendance',
      attendance: { Date: date, EmployeeID: employeeId, TimeIn: timeIn.trim(), TimeOut: timeOut.trim(), Note: row.Note || '' }
    });
    const i = state.attendance.findIndex((r) => r.Date === date && String(r.EmployeeID) === String(employeeId));
    if (i !== -1) state.attendance[i] = updated;
    if (date === todayKey()) upsertToday(updated);
    render();
  } catch (err) {
    showError(err.message);
  }
}

function exportCsv(rows) {
  const headers = ['วันที่', 'รหัสพนักงาน', 'ชื่อ', 'แผนก', 'เข้างาน', 'ออกงาน', 'สาย(นาที)', 'ชั่วโมงทำงาน', 'สถานะ'];
  const lines = [headers.join(',')];
  rows.forEach((r) => {
    lines.push([r.Date, r.EmployeeID, r.FullName, r.Department, r.TimeIn, r.TimeOut, r.LateMinutes, r.WorkHours, r.Status]
      .map((v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`)
      .join(','));
  });
  // ﻿ (BOM) จำเป็นสำหรับ Excel บน Windows มิฉะนั้นภาษาไทยจะกลายเป็นอักขระเพี้ยน
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `เวลาทำงาน_${state.attendanceFilter.from}_ถึง_${state.attendanceFilter.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ===== หน้าลงทะเบียนใบหน้า ===== */

const ENROLL_SAMPLES = 3;
const SAMPLE_LABELS = ['หันตรง', 'หันซ้ายเล็กน้อย', 'หันขวาเล็กน้อย'];

function renderEnroll(app) {
  const employees = activeEmployees();

  app.innerHTML = `
    <div class="scan-layout">
      <div>
        <div class="video-frame mirrored">
          <video id="enrollVideo" playsinline muted></video>
          <div class="cam-placeholder" id="enrollPlaceholder">
            <svg viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7z" stroke-linecap="round" stroke-linejoin="round"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
            <span id="enrollCamMessage">กดปุ่ม "เปิดกล้อง" เพื่อเริ่มลงทะเบียน</span>
          </div>
        </div>
        <div class="scan-controls">
          <button class="btn" id="btnEnrollCamera">เปิดกล้อง</button>
          <p class="scan-hint" id="enrollHint">เลือกพนักงาน แล้วเก็บภาพ ${ENROLL_SAMPLES} มุม</p>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="section-head"><h3>ลงทะเบียนใบหน้า</h3></div>
          <div class="form-field">
            <label for="enrollEmployee">พนักงาน</label>
            <select id="enrollEmployee">
              <option value="">— เลือกพนักงาน —</option>
              ${employees.map((e) => `<option value="${escapeHtml(e.EmployeeID)}" ${state.enroll.employeeId === String(e.EmployeeID) ? 'selected' : ''}>${escapeHtml(e.FullName)} (${escapeHtml(e.EmployeeID)})${faceCountOf(e.EmployeeID) ? ' ✓' : ''}</option>`).join('')}
            </select>
            <span class="hint" id="enrollStatus"></span>
          </div>

          <div class="sample-strip" id="sampleStrip">
            ${Array.from({ length: ENROLL_SAMPLES }, (_, i) => `<div class="sample-slot" id="slot${i}">${SAMPLE_LABELS[i]}</div>`).join('')}
          </div>

          <div class="form-actions">
            <button class="btn" id="btnCapture">เก็บภาพ</button>
            <button class="btn secondary" id="btnResetSamples">เริ่มใหม่</button>
            <button class="btn" id="btnSaveFace" disabled>บันทึกใบหน้า</button>
          </div>
        </div>

        <div class="card">
          <div class="section-head">
            <h3>สถานะการลงทะเบียน</h3>
            <span class="section-sub">${employees.filter((e) => faceCountOf(e.EmployeeID)).length} / ${employees.length} คน</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>ชื่อ</th><th>แบบที่บันทึกไว้</th><th></th></tr></thead>
              <tbody>
                ${employees.map((e) => {
                  const n = faceCountOf(e.EmployeeID);
                  return `<tr>
                    <td>${escapeHtml(e.FullName)}</td>
                    <td>${n ? `<span class="pill pill-good">${n} แบบ</span>` : '<span class="pill pill-neutral">ยังไม่ลงทะเบียน</span>'}</td>
                    <td>${n ? `<button class="link-btn" data-clear="${escapeHtml(e.EmployeeID)}">ลบ</button>` : ''}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  const select = document.getElementById('enrollEmployee');
  select.addEventListener('change', () => {
    state.enroll.employeeId = select.value;
    state.enroll.samples = [];
    updateEnrollUi();
  });

  document.getElementById('btnCapture').addEventListener('click', captureSample);
  document.getElementById('btnResetSamples').addEventListener('click', () => {
    state.enroll.samples = [];
    updateEnrollUi();
  });
  document.getElementById('btnSaveFace').addEventListener('click', saveEnrollment);

  app.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', () => clearFaces(btn.dataset.clear));
  });

  document.getElementById('btnEnrollCamera').addEventListener('click', startEnrollCamera);

  updateEnrollUi();
}

async function startEnrollCamera() {
  const video = document.getElementById('enrollVideo');
  const placeholder = document.getElementById('enrollPlaceholder');
  const btn = document.getElementById('btnEnrollCamera');
  const message = document.getElementById('enrollCamMessage');

  btn.disabled = true;
  btn.textContent = 'กำลังเปิดกล้อง...';

  try {
    if (!FaceEngine.isReady()) {
      message.textContent = 'กำลังโหลดโมเดลใบหน้า...';
      await FaceEngine.loadModels();
    }
    await FaceEngine.startCamera(video);
    if (state.view !== 'enroll') { FaceEngine.stopCamera(); return; }
    placeholder.hidden = true;
    btn.hidden = true;
    state.enroll.cameraOn = true;
    updateEnrollUi();
  } catch (err) {
    showError(err.message);
    message.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'ลองอีกครั้ง';
  }
}

function updateEnrollUi() {
  const samples = state.enroll.samples;
  for (let i = 0; i < ENROLL_SAMPLES; i++) {
    const slot = document.getElementById(`slot${i}`);
    if (!slot) continue;
    if (samples[i]) {
      slot.classList.add('filled');
      slot.innerHTML = `<img src="${samples[i].photo}" alt="">`;
    } else {
      slot.classList.remove('filled');
      slot.textContent = SAMPLE_LABELS[i];
    }
  }
  const saveBtn = document.getElementById('btnSaveFace');
  if (saveBtn) saveBtn.disabled = !(state.enroll.employeeId && samples.length === ENROLL_SAMPLES);

  // กดเก็บภาพไม่ได้จนกว่ากล้องจะเปิด มิฉะนั้นจะได้แต่ข้อความ "ไม่พบใบหน้า" ที่ชี้สาเหตุผิด
  const captureBtn = document.getElementById('btnCapture');
  if (captureBtn) captureBtn.disabled = !state.enroll.cameraOn;

  const status = document.getElementById('enrollStatus');
  if (status) {
    const n = state.enroll.employeeId ? faceCountOf(state.enroll.employeeId) : 0;
    status.textContent = !state.enroll.employeeId
      ? 'เลือกพนักงานก่อนเก็บภาพ'
      : (n ? `คนนี้ลงทะเบียนไว้แล้ว ${n} แบบ — บันทึกใหม่จะแทนที่ของเดิมทั้งหมด` : 'ยังไม่เคยลงทะเบียน');
  }
}

async function captureSample() {
  if (!state.enroll.employeeId) { showError('เลือกพนักงานก่อน'); return; }
  if (state.enroll.samples.length >= ENROLL_SAMPLES) { showError('เก็บภาพครบแล้ว'); return; }

  const video = document.getElementById('enrollVideo');
  const hint = document.getElementById('enrollHint');
  hint.textContent = 'กำลังวิเคราะห์ใบหน้า...';

  try {
    const detection = await FaceEngine.detect(video);
    if (!detection) {
      hint.textContent = 'ไม่พบใบหน้าในภาพ — ขยับเข้าใกล้กล้องแล้วลองใหม่';
      return;
    }
    state.enroll.samples.push({ descriptor: detection.descriptor, photo: FaceEngine.snapshot(video, 200, 0.7) });
    hint.textContent = `เก็บแล้ว ${state.enroll.samples.length}/${ENROLL_SAMPLES} มุม`;
    updateEnrollUi();
  } catch (err) {
    showError(err.message);
  }
}

async function saveEnrollment() {
  const employeeId = state.enroll.employeeId;
  const samples = state.enroll.samples;
  if (!employeeId || samples.length !== ENROLL_SAMPLES) return;

  const btn = document.getElementById('btnSaveFace');
  btn.disabled = true;
  btn.textContent = 'กำลังบันทึก...';

  try {
    const averaged = FaceEngine.averageDescriptors(samples.map((s) => s.descriptor));
    // เก็บทั้งค่าเฉลี่ยและแต่ละมุม — ค่าเฉลี่ยทนแสง/มุมได้ดี ส่วนมุมเดี่ยวช่วยตอนคนหันหน้าสุดทาง
    // ฝั่ง Code.gs จะลบของเดิมให้เองในคำขอเดียวกัน
    await apiPost({
      type: 'enrollFace',
      employeeId,
      enrolledBy: DEVICE_NAME,
      descriptors: [averaged, ...samples.map((s) => s.descriptor)].map(FaceEngine.serializeDescriptor)
    });

    state.faces = await apiGet('listFaces');
    rebuildFaceIndex();
    state.enroll = { employeeId: '', samples: [] };
    render();
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = 'บันทึกใบหน้า';
  }
}

async function clearFaces(employeeId) {
  const employee = employeeById(employeeId);
  if (!confirm(`ลบใบหน้าที่ลงทะเบียนของ ${employee ? employee.FullName : employeeId} ?`)) return;
  try {
    await apiPost({ type: 'deleteFaces', employeeId });
    state.faces = await apiGet('listFaces');
    rebuildFaceIndex();
    render();
  } catch (err) {
    showError(err.message);
  }
}

/* ===== หน้าพนักงาน ===== */

function renderEmployees(app) {
  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="section-head" style="margin:0"><h3>รายชื่อพนักงาน</h3><span class="section-sub">${state.employees.length} คน</span></div>
        <button class="btn" id="btnAddEmployee">เพิ่มพนักงาน</button>
      </div>
      ${state.employees.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>รหัส</th><th>ชื่อ</th><th>แผนก</th><th>ตำแหน่ง</th><th>สถานะ</th><th>ใบหน้า</th><th></th></tr></thead>
          <tbody>
            ${state.employees.map((e) => `
              <tr>
                <td class="muted">${escapeHtml(e.EmployeeID)}</td>
                <td>${escapeHtml(e.FullName)}</td>
                <td class="muted">${escapeHtml(e.Department || '-')}</td>
                <td class="muted">${escapeHtml(e.Position || '-')}</td>
                <td>${isActive(e) ? '<span class="pill pill-good">ทำงาน</span>' : '<span class="pill pill-neutral">' + escapeHtml(e.Status) + '</span>'}</td>
                <td>${faceCountOf(e.EmployeeID) ? '<span class="pill pill-info">ลงทะเบียนแล้ว</span>' : '<span class="pill pill-neutral">ยังไม่มี</span>'}</td>
                <td><button class="link-btn" data-emp="${escapeHtml(e.EmployeeID)}">แก้ไข</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<p class="empty">ยังไม่มีพนักงาน — กด "เพิ่มพนักงาน" เพื่อเริ่ม</p>'}
    </div>
  `;

  document.getElementById('btnAddEmployee').addEventListener('click', () => setView('employeeForm', {}));
  app.querySelectorAll('[data-emp]').forEach((btn) => {
    btn.addEventListener('click', () => setView('employeeForm', { employeeId: btn.dataset.emp }));
  });
}

function renderEmployeeForm(app) {
  const editing = state.params.employeeId ? employeeById(state.params.employeeId) : null;
  const e = editing || { EmployeeID: '', FullName: '', Department: '', Position: '', Status: 'ทำงาน' };

  app.innerHTML = `
    <button class="back-link" id="btnBack">← กลับไปรายชื่อพนักงาน</button>
    <div class="card">
      <div class="section-head"><h3>${editing ? 'แก้ไขข้อมูลพนักงาน' : 'เพิ่มพนักงานใหม่'}</h3></div>
      <div class="form-grid">
        <div class="form-field">
          <label for="fId">รหัสพนักงาน</label>
          <input id="fId" value="${escapeHtml(e.EmployeeID)}" ${editing ? 'readonly' : ''} placeholder="เว้นว่างเพื่อให้ระบบสร้างให้">
        </div>
        <div class="form-field">
          <label for="fName">ชื่อ-นามสกุล *</label>
          <input id="fName" value="${escapeHtml(e.FullName)}">
        </div>
        <div class="form-field">
          <label for="fDeptInput">แผนก</label>
          <input id="fDeptInput" value="${escapeHtml(e.Department)}">
        </div>
        <div class="form-field">
          <label for="fPos">ตำแหน่ง</label>
          <input id="fPos" value="${escapeHtml(e.Position)}">
        </div>
        <div class="form-field">
          <label for="fStatusInput">สถานะ</label>
          <select id="fStatusInput">
            <option value="ทำงาน" ${isActive(e) ? 'selected' : ''}>ทำงาน</option>
            <option value="ลาออก" ${!isActive(e) ? 'selected' : ''}>ลาออก</option>
          </select>
          <span class="hint">คนที่ลาออกจะไม่ถูกนำมาเทียบใบหน้าตอนสแกน</span>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" id="btnSaveEmployee">บันทึก</button>
        <button class="btn secondary" id="btnCancel">ยกเลิก</button>
      </div>
    </div>
  `;

  document.getElementById('btnBack').addEventListener('click', () => setView('employees'));
  document.getElementById('btnCancel').addEventListener('click', () => setView('employees'));
  document.getElementById('btnSaveEmployee').addEventListener('click', async () => {
    const employee = {
      EmployeeID: document.getElementById('fId').value.trim(),
      FullName: document.getElementById('fName').value.trim(),
      Department: document.getElementById('fDeptInput').value.trim(),
      Position: document.getElementById('fPos').value.trim(),
      Status: document.getElementById('fStatusInput').value
    };
    if (!employee.FullName) { showError('กรอกชื่อ-นามสกุล'); return; }
    try {
      if (editing) {
        employee.PhotoURL = editing.PhotoURL || '';
        await apiPost({ type: 'updateEmployee', employee });
      } else {
        await apiPost({ type: 'addEmployee', employee });
      }
      state.employees = await apiGet('listEmployees');
      rebuildFaceIndex();
      setView('employees');
    } catch (err) {
      showError(err.message);
    }
  });
}

/* ===== หน้าตั้งค่า ===== */

const SETTING_FIELDS = [
  { key: 'WorkStartTime', label: 'เวลาเข้างานมาตรฐาน', type: 'time', required: true, hint: 'ใช้คำนวณว่ามาสายกี่นาที' },
  { key: 'WorkEndTime', label: 'เวลาเลิกงาน', type: 'time', required: true, hint: 'ใช้แสดงผลเท่านั้น' },
  { key: 'LateGraceMinutes', label: 'ผ่อนผัน (นาที)', type: 'number', required: true, hint: 'เข้างานช้าไม่เกินนี้ยังถือว่าตรงเวลา' },
  { key: 'BreakMinutes', label: 'เวลาพัก (นาที)', type: 'number', required: true, hint: 'หักออกจากชั่วโมงทำงาน' },
  { key: 'MinScanIntervalMinutes', label: 'กันสแกนซ้ำ (นาที)', type: 'number', required: true, hint: 'สแกนซ้ำภายในช่วงนี้จะไม่บันทึกใหม่' },
  { key: 'MatchThreshold', label: 'ความเข้มการจับคู่ใบหน้า', type: 'number', step: '0.01', required: true, hint: 'ยิ่งน้อยยิ่งเข้ม แนะนำ 0.40–0.50' },
  { key: 'MatchMargin', label: 'ระยะห่างจากอันดับสอง', type: 'number', step: '0.01', required: true, hint: 'กันสับสนระหว่างคนหน้าคล้ายกัน' },
  { key: 'DriveFolderId', label: 'รหัสโฟลเดอร์ Drive เก็บรูป', type: 'text', hint: 'เว้นว่าง = ไม่เก็บรูป' }
];

function renderSettings(app) {
  app.innerHTML = `
    <div class="card">
      <div class="section-head">
        <h3>ตั้งค่าระบบ</h3>
        <span class="section-sub">ค่าเหล่านี้เก็บอยู่ในแท็บ Settings ของ Google Sheet</span>
      </div>
      <div class="form-grid">
        ${SETTING_FIELDS.map((f) => `
          <div class="form-field">
            <label for="set_${f.key}">${escapeHtml(f.label)}</label>
            <input id="set_${f.key}" type="${f.type}" ${f.step ? `step="${f.step}"` : ''} value="${escapeHtml(state.settings[f.key] || '')}">
            <span class="hint">${escapeHtml(f.hint)}</span>
          </div>`).join('')}
      </div>
      <div class="form-actions">
        <button class="btn" id="btnSaveSettings">บันทึกการตั้งค่า</button>
        <button class="btn secondary" id="btnReload">โหลดข้อมูลใหม่</button>
      </div>
    </div>

    <div class="card">
      <div class="section-head"><h3>สถานะระบบ</h3></div>
      <div class="table-wrap">
        <table>
          <tbody>
            <tr><td>ที่อยู่ Apps Script</td><td class="muted">${API_URL ? escapeHtml(API_URL) : '<span class="pill pill-bad">ยังไม่ได้ตั้งค่า API_URL ใน app.js</span>'}</td></tr>
            <tr><td>โมเดลใบหน้า</td><td>${FaceEngine.isReady() ? '<span class="pill pill-good">พร้อมใช้งาน</span>' : '<span class="pill pill-warn">ยังไม่พร้อม</span>'}</td></tr>
            <tr><td>ใบหน้าที่ลงทะเบียน</td><td>${state.faceIndex.length} แบบ จาก ${new Set(state.faceIndex.map((f) => f.employeeId)).size} คน</td></tr>
            <tr><td>การเชื่อมต่อกล้อง</td><td>${window.isSecureContext ? '<span class="pill pill-good">ใช้ได้ (secure context)</span>' : '<span class="pill pill-bad">ใช้ไม่ได้ — ต้องเปิดผ่าน https หรือ localhost</span>'}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    const settings = {};
    SETTING_FIELDS.forEach((f) => { settings[f.key] = document.getElementById(`set_${f.key}`).value.trim(); });

    // เวลาเข้างานว่าง = ทุกคนถูกนับว่าสายทั้งวัน ต้องกันไว้ ไม่ใช่ปล่อยให้บันทึกแล้วค่อยไปงงทีหลัง
    const blank = SETTING_FIELDS.filter((f) => f.required && !settings[f.key]);
    if (blank.length) {
      showError('ต้องกรอก: ' + blank.map((f) => f.label).join(', '));
      return;
    }

    try {
      state.settings = await apiPost({ type: 'saveSettings', settings });
      render();
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById('btnReload').addEventListener('click', () => bootstrap());
}

/* ===== เริ่มต้นทำงาน ===== */

function rebuildFaceIndex() {
  const activeIds = new Set(activeEmployees().map((e) => String(e.EmployeeID)));
  state.faceIndex = FaceEngine.buildIndex(state.faces, activeIds);
}

function setModelStatus(cls, text) {
  const el = document.getElementById('modelStatus');
  el.className = `model-status ${cls}`;
  el.innerHTML = `<span class="dot"></span>${escapeHtml(text)}`;
}

async function bootstrap() {
  // ตั้งค่าช่วงวันที่เริ่มต้นก่อนเรียก API — ถ้าเรียกไม่สำเร็จ หน้าประวัติจะได้ยังมีค่าให้แสดง
  state.attendanceFilter = { from: monthStartKey(), to: todayKey(), department: '', status: '' };
  try {
    const data = await apiGet('bootstrap');
    state.settings = data.settings;
    state.employees = data.employees;
    state.faces = data.faces;
    rebuildFaceIndex();
    state.today = await apiGet('listAttendance', { from: todayKey(), to: todayKey() });
    state.loaded = true;
  } catch (err) {
    showError(err.message);
    // ยังให้ใช้หน้าเว็บต่อได้ เพื่อให้เห็นหน้าตั้งค่าและรู้ว่าพลาดตรงไหน
    state.loaded = true;
  }
  render();
}

function init() {
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.getElementById('mainTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    // ต้องผ่าน setView เสมอ แม้หน้านี้จะต้องโหลดข้อมูลต่อ — ไม่งั้นกล้องจากหน้าสแกนจะค้างเปิดอยู่
    setView(btn.dataset.view);
    if (btn.dataset.view === 'attendance') loadAttendance();
  });

  // โหลดโมเดลคู่ขนานไปกับข้อมูล — โมเดลก้อนใหญ่ (~6.7MB) ไม่ควรให้ไปขวางการแสดงผลหน้าแรก
  FaceEngine.loadModels()
    .then(() => setModelStatus('is-ready', 'โมเดลใบหน้าพร้อม'))
    .catch((err) => {
      setModelStatus('is-error', 'โมเดลใบหน้าใช้ไม่ได้');
      showError(err.message);
    });

  bootstrap();
}

document.addEventListener('DOMContentLoaded', init);
