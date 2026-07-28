// ทดสอบตรรกะล้วน ๆ ใน face.js (ไม่แตะกล้อง/โมเดล)
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'face.js'), 'utf8');
const FaceEngine = eval(src + '; FaceEngine');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const D = FaceEngine.DESCRIPTOR_LENGTH;
function vec(fill) { const a = new Float32Array(D); a.fill(fill); return a; }
function vecOffset(base, delta, n) { const a = vec(base); for (let i = 0; i < n; i++) a[i] += delta; return a; }

console.log('descriptor round-trip');
const v = vec(0.123456);
const round = FaceEngine.parseDescriptor(FaceEngine.serializeDescriptor(v));
check('parse(serialize(x)) มีความยาว 128', round && round.length === D);
check('ค่าคงเดิมหลังแปลงไปกลับ', Math.abs(round[0] - 0.123456) < 1e-6);
check('ปฏิเสธข้อความที่มีจำนวนค่าไม่ครบ', FaceEngine.parseDescriptor('1,2,3') === null);
check('ปฏิเสธข้อความว่าง', FaceEngine.parseDescriptor('') === null);
check('ปฏิเสธค่าที่ไม่ใช่ตัวเลข', FaceEngine.parseDescriptor(Array(D).fill('x').join(',')) === null);

console.log('averageDescriptors');
const avg = FaceEngine.averageDescriptors([vec(0), vec(1), vec(2)]);
check('เฉลี่ย 0,1,2 ได้ 1', Math.abs(avg[0] - 1) < 1e-6);
check('รายการว่างคืน null', FaceEngine.averageDescriptors([]) === null);

console.log('distance');
check('ระยะกับตัวเองเป็น 0', FaceEngine.distance(vec(0.5), vec(0.5)) === 0);
check('ระยะเป็นบวกเมื่อต่างกัน', FaceEngine.distance(vec(0), vec(1)) > 0);

console.log('buildIndex');
const rows = [
  { EmployeeID: 'A1', Descriptor: FaceEngine.serializeDescriptor(vec(0)) },
  { EmployeeID: 'A1', Descriptor: FaceEngine.serializeDescriptor(vecOffset(0, 0.9, 3)) },
  { EmployeeID: 'B2', Descriptor: FaceEngine.serializeDescriptor(vecOffset(0, 3, 40)) },
  { EmployeeID: 'C3', Descriptor: 'พัง' },                                   // descriptor เสีย
  { EmployeeID: '', Descriptor: FaceEngine.serializeDescriptor(vec(0)) },     // ไม่มีรหัส
  { EmployeeID: 'Z9', Descriptor: FaceEngine.serializeDescriptor(vec(0)) }    // ลาออกแล้ว
];
const index = FaceEngine.buildIndex(rows, new Set(['A1', 'B2', 'C3']));
check('ข้ามแถวที่ descriptor เสีย/ไม่มีรหัส/ไม่อยู่ในรายชื่อ', index.length === 3);
check('ไม่มีพนักงานที่ลาออกอยู่ในดัชนี', !index.some((e) => e.employeeId === 'Z9'));
check('ไม่ส่ง activeIds = เอาทุกแถวที่ใช้ได้', FaceEngine.buildIndex(rows, null).length === 4);

console.log('match');
const near = vecOffset(0, 0.02, 1);                 // ใกล้ A1 มาก
const far = vecOffset(0, 5, 100);                   // ไกลจากทุกคน
const okMatch = FaceEngine.match(near, index, 0.45, 0.05);
check('จับคู่ได้ถูกคน', okMatch.employeeId === 'A1' && okMatch.reason === 'ok');
check('คืนระยะที่วัดได้', okMatch.distance > 0 && okMatch.distance < 0.45);

const tooFar = FaceEngine.match(far, index, 0.45, 0.05);
check('ไกลเกิน threshold แล้วไม่จับคู่', tooFar.employeeId === null && tooFar.reason === 'too-far');

// สองคนที่อยู่ห่างเท่า ๆ กัน -> ต้องตัดสินว่า ambiguous ไม่ใช่เดาเอา
const twin = FaceEngine.buildIndex([
  { EmployeeID: 'X', Descriptor: FaceEngine.serializeDescriptor(vecOffset(0, 0.1, 1)) },
  { EmployeeID: 'Y', Descriptor: FaceEngine.serializeDescriptor(vecOffset(0, 0.101, 1)) }
], null);
const amb = FaceEngine.match(vec(0), twin, 0.45, 0.05);
check('สองคนสูสีกันถือว่าตัดสินไม่ได้', amb.employeeId === null && amb.reason === 'ambiguous');
check('ถ้าลด margin เป็น 0 จะยอมตัดสิน', FaceEngine.match(vec(0), twin, 0.45, 0).employeeId === 'X');

check('ดัชนีว่างคืน no-index', FaceEngine.match(vec(0), [], 0.45, 0.05).reason === 'no-index');
check('ไม่มี descriptor คืน no-index', FaceEngine.match(null, index, 0.45, 0.05).reason === 'no-index');

// หลายมุมหน้าของคนเดียวกัน: ต้องใช้ระยะที่ดีที่สุด ไม่ใช่แถวแรกที่เจอ
const multi = FaceEngine.buildIndex([
  { EmployeeID: 'M', Descriptor: FaceEngine.serializeDescriptor(vecOffset(0, 4, 60)) },  // มุมที่ไกล
  { EmployeeID: 'M', Descriptor: FaceEngine.serializeDescriptor(vecOffset(0, 0.01, 1)) } // มุมที่ตรง
], null);
check('ใช้ระยะที่ใกล้ที่สุดในบรรดาแถวของคนเดียวกัน', FaceEngine.match(vec(0), multi, 0.45, 0.05).employeeId === 'M');

console.log('createStabilizer');
const s = FaceEngine.createStabilizer(3);
check('เจอ 1 ครั้งยังไม่ยืนยัน', s.push('A') === false);
check('เจอ 2 ครั้งยังไม่ยืนยัน', s.push('A') === false);
check('เจอครบ 3 ครั้งจึงยืนยัน', s.push('A') === true);
check('ยืนยันแล้วครั้งถัดไปไม่ยิงซ้ำ', s.push('A') === false);
s.reset();
check('สลับคนแล้วเริ่มนับใหม่', s.push('A') === false && s.push('B') === false && s.push('B') === false && s.push('B') === true);
s.reset();
check('ไม่เจอหน้าแล้วรีเซ็ตการนับ', s.push('A') === false && s.push(null) === false && s.push('A') === false && s.push('A') === false);

console.log(`\n${pass} ผ่าน / ${fail} ไม่ผ่าน`);
process.exit(fail ? 1 : 0);
