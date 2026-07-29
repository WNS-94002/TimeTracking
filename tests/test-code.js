// ทดสอบตรรกะคำนวณเวลาใน Code.gs โดยจำลอง global ของ Apps Script เท่าที่ตรรกะนี้ใช้
const fs = require('fs');
const path = require('path');

const p2 = (n) => String(n).padStart(2, '0');
global.Session = { getScriptTimeZone: () => 'Asia/Bangkok' };
global.Utilities = {
  // จำลองเฉพาะรูปแบบที่โค้ดใช้จริง โดยตีความว่า timezone ของสคริปต์ = เวลาท้องถิ่นของเครื่องทดสอบ
  formatDate(d, tz, fmt) {
    const map = {
      'yyyy-MM-dd': `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
      'HH:mm': `${p2(d.getHours())}:${p2(d.getMinutes())}`,
      'HHmmss': `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`,
      'yyyy-MM-dd HH:mm:ss': `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    };
    if (!(fmt in map)) throw new Error('รูปแบบที่ยังไม่ได้จำลอง: ' + fmt);
    return map[fmt];
  },
  getUuid: () => 'test-uuid-0000'
};
global.SpreadsheetApp = { getActiveSpreadsheet: () => { throw new Error('ไม่ควรถูกเรียกในการทดสอบนี้'); } };
global.DriveApp = {};
global.LockService = {};
global.ContentService = {};
global.console = console;

const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
eval(src);

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
const at = (h, m) => new Date(2026, 6, 28, h, m, 0);
const SETTINGS = { WorkStartTime: '08:00', LateGraceMinutes: '10', BreakMinutes: '60' };

console.log('hhmmToMinutes_ / minutesOfDay_');
check('08:00 = 480 นาที', hhmmToMinutes_('08:00') === 480);
check('รับ 8:05 ที่ไม่เติมศูนย์', hhmmToMinutes_('8:05') === 485);
check('ตัดช่องว่างหัวท้าย', hhmmToMinutes_(' 09:30 ') === 570);
check('ค่าที่อ่านไม่ออกคืน 0', hhmmToMinutes_('ไม่ใช่เวลา') === 0);
check('minutesOfDay_ อ่านจาก Date', minutesOfDay_(at(8, 5)) === 485);

console.log('dateKey_');
check('แปลง Date เป็น yyyy-MM-dd', dateKey_(at(8, 0)) === '2026-07-28');
check('ข้อความอยู่แล้วก็คงเดิม', dateKey_('2026-07-28') === '2026-07-28');
check('ตัดส่วนเวลาออกจาก ISO', dateKey_('2026-07-28T03:00:00.000Z') === '2026-07-28');
check('ค่าว่างคืนข้อความว่าง', dateKey_('') === '' && dateKey_(null) === '');

console.log('minutesBetween_');
check('08:00 ถึง 17:00 = 540 นาที', minutesBetween_(at(8, 0), at(17, 0)) === 540);

console.log('parseTimeOnDate_ (แก้เวลาด้วยมือ)');
const parsed = parseTimeOnDate_('2026-07-28', '09:15');
check('ประกอบวันที่+เวลาได้ถูก', parsed.getFullYear() === 2026 && parsed.getMonth() === 6 && parsed.getDate() === 28 && parsed.getHours() === 9 && parsed.getMinutes() === 15);
let threw = false;
try { parseTimeOnDate_('2026-07-28', 'เก้าโมง'); } catch (e) { threw = true; }
check('รูปแบบเวลาผิดต้องโยน error', threw);

console.log('applyAttendanceComputedFields_ — การนับสาย');
let r = applyAttendanceComputedFields_({ TimeIn: at(8, 0), TimeOut: '' }, SETTINGS);
check('มาตรงเวลาพอดี = ไม่สาย', r.LateMinutes === 0 && r.Status.indexOf('ปกติ') === 0);
r = applyAttendanceComputedFields_({ TimeIn: at(8, 10), TimeOut: '' }, SETTINGS);
check('มาถึงพอดีขอบผ่อนผัน = ไม่สาย', r.LateMinutes === 0);
r = applyAttendanceComputedFields_({ TimeIn: at(8, 11), TimeOut: '' }, SETTINGS);
check('เกินผ่อนผัน 1 นาที = สาย 1 นาที', r.LateMinutes === 1 && r.Status.indexOf('สาย') === 0);
r = applyAttendanceComputedFields_({ TimeIn: at(9, 30), TimeOut: '' }, SETTINGS);
check('มา 09:30 = สาย 80 นาที', r.LateMinutes === 80);
r = applyAttendanceComputedFields_({ TimeIn: at(7, 30), TimeOut: '' }, SETTINGS);
check('มาก่อนเวลา = ไม่ติดลบ', r.LateMinutes === 0);

console.log('applyAttendanceComputedFields_ — ชั่วโมงทำงาน');
r = applyAttendanceComputedFields_({ TimeIn: at(8, 0), TimeOut: at(17, 0) }, SETTINGS);
check('08:00-17:00 หักพัก 1 ชม. = 8 ชม.', r.WorkHours === 8);
r = applyAttendanceComputedFields_({ TimeIn: at(8, 0), TimeOut: at(12, 30) }, SETTINGS);
check('08:00-12:30 หักพัก = 3.5 ชม.', r.WorkHours === 3.5);
r = applyAttendanceComputedFields_({ TimeIn: at(8, 0), TimeOut: at(8, 20) }, SETTINGS);
check('ทำงานสั้นกว่าเวลาพัก ไม่ติดลบ', r.WorkHours === 0);
r = applyAttendanceComputedFields_({ TimeIn: at(8, 0), TimeOut: '' }, SETTINGS);
check('ยังไม่ออกงาน = ชั่วโมงว่าง + สถานะบอกว่ายังไม่ออก', r.WorkHours === '' && r.Status.indexOf('ยังไม่ออกงาน') !== -1);
r = applyAttendanceComputedFields_({ TimeIn: '', TimeOut: '' }, SETTINGS);
check('ยังไม่มีเวลาเข้า = ว่างทั้งหมด', r.LateMinutes === '' && r.WorkHours === '' && r.Status === '');

console.log('applyAttendanceComputedFields_ — รับค่าที่ชีตคืนมาเป็นข้อความ ISO ได้ด้วย');
r = applyAttendanceComputedFields_({ TimeIn: at(8, 30).toISOString(), TimeOut: at(17, 30).toISOString() }, SETTINGS);
check('อ่าน ISO string เป็นเวลาได้', r.LateMinutes === 20 && r.WorkHours === 8);

console.log('ตั้งค่าเวลาเข้างานอื่น');
r = applyAttendanceComputedFields_({ TimeIn: at(9, 5), TimeOut: '' }, { WorkStartTime: '09:00', LateGraceMinutes: '0', BreakMinutes: '0' });
check('เปลี่ยน WorkStartTime แล้วการนับสายเปลี่ยนตาม', r.LateMinutes === 5);
r = applyAttendanceComputedFields_({ TimeIn: at(9, 0), TimeOut: at(18, 0) }, { WorkStartTime: '09:00', LateGraceMinutes: '0', BreakMinutes: '0' });
check('ไม่หักเวลาพัก = 9 ชม. เต็ม', r.WorkHours === 9);

console.log('formatRow_ (สิ่งที่ส่งกลับให้หน้าเว็บ)');
// จำลองแถวที่ Sheets คืนมาเป็นชนิดวันที่-เวลา ซึ่งเป็นสิ่งที่เกิดขึ้นจริงในชีตที่ใช้งานอยู่
const rawRow = {
  Date: new Date(2026, 6, 29, 0, 0, 0),
  EmployeeID: 9402,
  FullName: 'วศิน สินธพ',
  TimeIn: new Date(2026, 6, 29, 0, 43, 9),
  TimeOut: new Date(2026, 6, 29, 8, 5, 0),
  LateMinutes: 0,
  WorkHours: 6.4
};
const shaped = formatRow_(rawRow);
check('Date เป็น yyyy-MM-dd ไม่ใช่ ISO', shaped.Date === '2026-07-29');
check('TimeIn เป็น HH:mm', shaped.TimeIn === '00:43');
check('TimeOut เป็น HH:mm', shaped.TimeOut === '08:05');
check('ค่าอื่นไม่ถูกแตะ', shaped.FullName === 'วศิน สินธพ' && shaped.WorkHours === 6.4 && shaped.EmployeeID === 9402);
const emptyShaped = formatRow_({ Date: new Date(2026, 6, 29), TimeIn: '', TimeOut: '' });
check('ช่องเวลาว่างยังว่างอยู่', emptyShaped.TimeIn === '' && emptyShaped.TimeOut === '');

// หัวใจของบั๊ก: เวลา 00:43 ไทย = 17:43Z ของ "วันก่อนหน้า" การตัด 10 ตัวแรกของ ISO จะได้วันที่ผิด
console.log('dateKey_ กับเวลาเช้ามืด (จุดที่เคยพลาด)');
const earlyMorning = new Date(2026, 6, 29, 0, 43, 0);
check('dateKey_ จากค่าดิบได้วันที่ตามเวลาท้องถิ่น', dateKey_(earlyMorning) === '2026-07-29');
check('ถ้าเผลอแปลงเป็น ISO ก่อนจะได้วันที่ผิด (ยืนยันว่าบั๊กมีจริง)',
  earlyMorning.toISOString().slice(0, 10) !== '2026-07-29' || earlyMorning.getTimezoneOffset() >= 0);

console.log('normalizeTimeSetting_ (ค่าเวลาในแท็บ Settings)');
check('เติมศูนย์นำหน้าให้ 8:00', normalizeTimeSetting_('8:00') === '08:00');
check('ค่าที่ถูกอยู่แล้วไม่เปลี่ยน', normalizeTimeSetting_('08:00') === '08:00');
check('เวลาบ่ายไม่ถูกแตะ', normalizeTimeSetting_('17:30') === '17:30');
check('รับค่าที่ Sheets คืนมาเป็นชนิด Date', normalizeTimeSetting_(at(8, 5)) === '08:05');
check('ตัดช่องว่างหัวท้าย', normalizeTimeSetting_(' 9:15 ') === '09:15');
check('ค่าที่ไม่ใช่เวลาส่งคืนตามเดิม', normalizeTimeSetting_('ไม่ใช่เวลา') === 'ไม่ใช่เวลา');
check('ค่าว่างยังเป็นค่าว่าง', normalizeTimeSetting_('') === '');
// ค่าที่ normalize แล้วต้องคำนวณได้เท่าเดิม — การแก้รูปแบบต้องไม่เปลี่ยนความหมาย
check('normalize แล้วนาทีเท่าเดิม', hhmmToMinutes_(normalizeTimeSetting_('8:00')) === hhmmToMinutes_('8:00'));

console.log('num_');
check('ค่าที่แปลงไม่ได้ใช้ค่าสำรอง', num_('abc', 5) === 5);
check('ข้อความตัวเลขแปลงได้', num_('0.45', 1) === 0.45);
check('ค่าว่างแปลงเป็น 0 ตามพฤติกรรม Number', num_('', 9) === 0);

console.log(`\n${pass} ผ่าน / ${fail} ไม่ผ่าน`);
process.exit(fail ? 1 : 0);
