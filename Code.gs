/**
 * ระบบบันทึกเวลาทำงานด้วยการสแกนใบหน้า — Apps Script backend
 *
 * Deploy as Web App: Execute as "Me", Access "Anyone".
 * ไฟล์นี้เป็นเพียงสำเนาอ้างอิง — โค้ดที่ทำงานจริงต้องวางไว้ในตัวแก้ไข Apps Script
 * (Extensions > Apps Script) ของ Google Sheet ที่เก็บข้อมูล แล้ว Deploy > New deployment
 *
 * ครั้งแรกให้รันฟังก์ชัน setupSheets() จากตัวแก้ไขหนึ่งครั้ง เพื่อสร้างแท็บทั้งหมดพร้อมหัวคอลัมน์
 */

var SHEETS = {
  EMPLOYEES: 'Employees',
  FACE_DATA: 'FaceData',
  ATTENDANCE: 'Attendance',
  SCAN_LOGS: 'ScanLogs',
  SETTINGS: 'Settings'
};

// หัวคอลัมน์ของแต่ละแท็บ — ใช้ตอน setupSheets() เท่านั้น
// การอ่าน/เขียนจริงอิง "ชื่อหัวคอลัมน์" ในชีต ผู้ใช้จึงสลับลำดับคอลัมน์ได้อย่างอิสระ
var SHEET_HEADERS = {
  Employees: ['EmployeeID', 'FullName', 'Department', 'Position', 'Status', 'PhotoURL'],
  FaceData: ['FaceID', 'EmployeeID', 'Descriptor', 'SampleCount', 'EnrolledAt', 'EnrolledBy'],
  Attendance: ['Date', 'EmployeeID', 'FullName', 'Department', 'TimeIn', 'TimeOut', 'LateMinutes', 'WorkHours', 'Status', 'PhotoInURL', 'PhotoOutURL', 'Note'],
  ScanLogs: ['LogID', 'Timestamp', 'EmployeeID', 'FullName', 'Type', 'Distance', 'Result', 'PhotoURL', 'Device'],
  Settings: ['Key', 'Value']
};

// ค่าตั้งต้น — แท็บ Settings เขียนทับได้ทีละค่า (แถวไหนไม่มีก็ใช้ค่านี้)
var DEFAULT_SETTINGS = {
  WorkStartTime: '08:00',        // เวลาเข้างานมาตรฐาน ใช้คำนวณ "สาย"
  WorkEndTime: '17:00',          // เวลาเลิกงาน (ใช้แสดงผลเท่านั้น)
  LateGraceMinutes: '10',        // ผ่อนผันกี่นาทีก่อนเริ่มนับว่าสาย
  BreakMinutes: '60',            // เวลาพักที่หักออกจากชั่วโมงทำงาน
  MatchThreshold: '0.45',        // ระยะใบหน้าที่ยอมรับ (ยิ่งน้อยยิ่งเข้ม)
  MatchMargin: '0.05',           // อันดับ 1 ต้องดีกว่าอันดับ 2 อย่างน้อยเท่านี้
  MinScanIntervalMinutes: '5',   // สแกนซ้ำภายในกี่นาทีถือว่าซ้ำ ไม่บันทึก
  DriveFolderId: '',             // โฟลเดอร์ Drive สำหรับเก็บรูป (ว่าง = ไม่เก็บรูป)
  PhotoSharing: 'anyone'         // 'anyone' = แชร์ลิงก์เพื่อให้รูปแสดงบนหน้าเว็บ, 'private' = ไม่แชร์
};

// Shared secret — ต้องตรงกับ API_TOKEN ใน app.js ('' = ปิดการตรวจสอบ)
var API_TOKEN = '';

// ---------- Routing ----------

function doGet(e) {
  try {
    var action = e.parameter.action;
    checkToken_(e.parameter.token);

    if (action === 'bootstrap') {
      // รวม 3 คำขอที่หน้าเว็บต้องใช้ตอนเปิดไว้ในรอบเดียว — Apps Script ตอบช้า การยิงทีละอันทำให้หน้าสแกนพร้อมช้ามาก
      return jsonResponse_({ ok: true, data: {
        settings: getSettings_(),
        employees: listEmployees_(),
        faces: listFaces_()
      } });
    }
    if (action === 'listEmployees') {
      return jsonResponse_({ ok: true, data: listEmployees_() });
    }
    if (action === 'listFaces') {
      return jsonResponse_({ ok: true, data: listFaces_() });
    }
    if (action === 'listAttendance') {
      return jsonResponse_({ ok: true, data: listAttendance_(e.parameter.from, e.parameter.to) });
    }
    if (action === 'listScanLogs') {
      return jsonResponse_({ ok: true, data: listScanLogs_(e.parameter.limit) });
    }
    if (action === 'getSettings') {
      return jsonResponse_({ ok: true, data: getSettings_() });
    }
    return errorResponse_('Unknown action: ' + action);
  } catch (err) {
    return errorResponse_(err.message);
  }
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    checkToken_(payload.token);

    switch (payload.type) {
      case 'recordScan':
        return jsonResponse_({ ok: true, data: recordScan_(payload.scan) });
      case 'enrollFace':
        return jsonResponse_({ ok: true, data: enrollFaces_(payload.employeeId, payload.descriptors, payload.enrolledBy) });
      case 'deleteFaces':
        return jsonResponse_({ ok: true, data: deleteFaces_(payload.employeeId) });
      case 'addEmployee':
        return jsonResponse_({ ok: true, data: addEmployee_(payload.employee) });
      case 'updateEmployee':
        return jsonResponse_({ ok: true, data: updateEmployee_(payload.employee) });
      case 'updateAttendance':
        return jsonResponse_({ ok: true, data: updateAttendance_(payload.attendance) });
      case 'deleteAttendance':
        deleteAttendance_(payload.date, payload.employeeId);
        return jsonResponse_({ ok: true, data: { Date: payload.date, EmployeeID: payload.employeeId } });
      case 'saveSettings':
        return jsonResponse_({ ok: true, data: saveSettings_(payload.settings) });
      default:
        return errorResponse_('Unknown type: ' + payload.type);
    }
  } catch (err) {
    return errorResponse_(err.message);
  }
}

// ---------- Employees ----------

function listEmployees_() {
  return sheetToObjects_(getSheet_(SHEETS.EMPLOYEES));
}

function addEmployee_(employee) {
  var sheet = getSheet_(SHEETS.EMPLOYEES);
  if (!employee.EmployeeID) employee.EmployeeID = Utilities.getUuid().slice(0, 8).toUpperCase();
  if (findRowById_(sheet, 'EmployeeID', employee.EmployeeID) !== -1) {
    throw new Error('รหัสพนักงานซ้ำ: ' + employee.EmployeeID);
  }
  if (!employee.Status) employee.Status = 'ทำงาน';
  objectToRow_(sheet, employee);
  return employee;
}

function updateEmployee_(employee) {
  var sheet = getSheet_(SHEETS.EMPLOYEES);
  var rowIndex = findRowById_(sheet, 'EmployeeID', employee.EmployeeID);
  if (rowIndex === -1) throw new Error('ไม่พบพนักงาน: ' + employee.EmployeeID);
  objectToRow_(sheet, employee, rowIndex);
  return employee;
}

// ---------- FaceData ----------

function listFaces_() {
  return sheetToObjects_(getSheet_(SHEETS.FACE_DATA));
}

/**
 * บันทึกใบหน้าที่ลงทะเบียน — หนึ่งพนักงานมีได้หลายแถว (หลายมุมหน้า/หลายรอบ)
 * ตอนจับคู่ ฝั่งหน้าเว็บจะใช้ระยะที่น้อยที่สุดในบรรดาแถวของคนนั้น
 *
 * รับ descriptor มาทีเดียวทั้งชุดแล้วลบของเดิมทิ้งในคำขอเดียวกัน เพราะแต่ละคำขอไปยัง Apps Script
 * ใช้เวลาราวหนึ่งวินาที การยิงทีละแถวทำให้ผู้ใช้ต้องรอนานโดยไม่จำเป็น
 * และถ้าคำขอกลางทางล้ม จะเหลือใบหน้าปนกันระหว่างของเก่ากับของใหม่
 */
function enrollFaces_(employeeId, descriptors, enrolledBy) {
  if (!employeeId) throw new Error('ต้องระบุรหัสพนักงาน');
  if (!descriptors || !descriptors.length) throw new Error('ไม่มีข้อมูลใบหน้าที่จะบันทึก');

  descriptors.forEach(function (d) {
    if (String(d || '').split(',').length !== 128) {
      throw new Error('ข้อมูลใบหน้าไม่ถูกต้อง (ต้องมี 128 ค่า)');
    }
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // ลบของเดิมก่อนเสมอ มิฉะนั้นใบหน้าที่ลงทะเบียนตอนลุคเก่าจะยังถูกนำมาเทียบอยู่
    deleteFaces_(employeeId);

    var sheet = getSheet_(SHEETS.FACE_DATA);
    var now = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
    var rows = descriptors.map(function (descriptor) {
      return {
        FaceID: Utilities.getUuid().slice(0, 8),
        EmployeeID: employeeId,
        Descriptor: String(descriptor),
        SampleCount: descriptors.length,
        EnrolledAt: now,
        EnrolledBy: enrolledBy || ''
      };
    });
    rows.forEach(function (row) { objectToRow_(sheet, row); });
    return { EmployeeID: employeeId, saved: rows.length };
  } finally {
    lock.releaseLock();
  }
}

/** ลบใบหน้าที่ลงทะเบียนไว้ทั้งหมดของพนักงานคนหนึ่ง (ใช้ตอนลงทะเบียนใหม่) */
function deleteFaces_(employeeId) {
  var sheet = getSheet_(SHEETS.FACE_DATA);
  var headers = getHeaders_(sheet);
  var col = headers.indexOf('EmployeeID');
  if (col === -1) throw new Error('ไม่พบคอลัมน์ EmployeeID ในแท็บ FaceData');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { deleted: 0 };
  var ids = sheet.getRange(2, col + 1, lastRow - 1, 1).getValues();
  var deleted = 0;
  // ลบจากล่างขึ้นบน มิฉะนั้นเลขแถวจะเลื่อนระหว่างลบ
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === String(employeeId)) {
      sheet.deleteRow(i + 2);
      deleted++;
    }
  }
  return { deleted: deleted };
}

// ---------- Attendance ----------

/**
 * อ่านแถว Attendance แล้วแปลงเป็นรูปแบบที่หน้าเว็บใช้ได้ทันที (Date = yyyy-MM-dd, เวลา = HH:mm)
 *
 * ต้องกรองและแปลงจาก "ค่าดิบ" ของเซลล์ ไม่ใช่จากผลของ sheetToObjects_ เพราะ Sheets เก็บช่องวันที่/เวลา
 * เป็นชนิดวันที่-เวลา พอแปลงเป็น ISO แล้วมันเป็นเวลา UTC — การตัด 10 ตัวแรกจะได้วันที่ของโซน UTC
 * ทำให้รายการที่สแกนช่วงเช้ามืด (00:00-07:00 ตามเวลาไทย) ถูกนับเป็นของเมื่อวานและหายไปจากหน้า "วันนี้"
 */
function listAttendance_(from, to) {
  var sheet = getSheet_(SHEETS.ATTENDANCE);
  var headers = getHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [];
  values.forEach(function (rowValues) {
    var row = {};
    headers.forEach(function (header, i) { row[header] = rowValues[i]; });
    var key = dateKey_(row.Date);
    if (from && key < from) return;
    if (to && key > to) return;
    out.push(formatRow_(row));
  });
  return out;
}

/** แก้ไขเวลาด้วยมือจากหน้าเว็บ — คำนวณสาย/ชั่วโมงใหม่ให้ตรงกับเวลาที่แก้ */
function updateAttendance_(attendance) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet_(SHEETS.ATTENDANCE);
    var dateKey = dateKey_(attendance.Date);
    var rowIndex = findAttendanceRow_(sheet, dateKey, attendance.EmployeeID);
    if (rowIndex === -1) throw new Error('ไม่พบรายการของวันที่ ' + dateKey);

    var row = rowObject_(sheet, rowIndex);
    row.TimeIn = attendance.TimeIn ? parseTimeOnDate_(dateKey, attendance.TimeIn) : '';
    row.TimeOut = attendance.TimeOut ? parseTimeOnDate_(dateKey, attendance.TimeOut) : '';
    row.Note = attendance.Note || '';
    applyAttendanceComputedFields_(row, getSettings_());
    objectToRow_(sheet, row, rowIndex);
    return formatRow_(row);
  } finally {
    lock.releaseLock();
  }
}

function deleteAttendance_(date, employeeId) {
  var sheet = getSheet_(SHEETS.ATTENDANCE);
  var rowIndex = findAttendanceRow_(sheet, dateKey_(date), employeeId);
  if (rowIndex === -1) throw new Error('ไม่พบรายการที่ต้องการลบ');
  sheet.deleteRow(rowIndex);
}

/**
 * หัวใจของระบบ — รับผลการสแกนหนึ่งครั้งแล้ว upsert แถวของ (วันที่ + พนักงาน)
 *
 * scan = { EmployeeID, Type: 'AUTO'|'IN'|'OUT', Timestamp (ISO), Distance, PhotoBase64, Device }
 *
 * ใช้ LockService ครอบทั้งหมด เพราะเครื่องสแกนอาจยิงคำขอซ้อนกันได้ในไม่กี่วินาที
 * ถ้าไม่ล็อก สองคำขอจะอ่านแถวเดิมพร้อมกันแล้วเขียนทับกันเอง
 */
function recordScan_(scan) {
  if (!scan || !scan.EmployeeID) throw new Error('ต้องระบุรหัสพนักงาน');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var settings = getSettings_();
    var sheet = getSheet_(SHEETS.ATTENDANCE);

    // เวลาอ้างอิงจากเซิร์ฟเวอร์เสมอ ไม่เชื่อนาฬิกาของเครื่องสแกน (แท็บเล็ตอาจตั้งเวลาผิด)
    var now = new Date();
    var dateKey = Utilities.formatDate(now, tz_(), 'yyyy-MM-dd');

    var employee = findEmployee_(scan.EmployeeID);
    if (!employee) throw new Error('ไม่พบพนักงาน: ' + scan.EmployeeID);

    var rowIndex = findAttendanceRow_(sheet, dateKey, scan.EmployeeID);
    var row = rowIndex === -1 ? newAttendanceRow_(dateKey, employee) : rowObject_(sheet, rowIndex);

    var timeIn = asDate_(row.TimeIn);
    var timeOut = asDate_(row.TimeOut);
    var minInterval = num_(settings.MinScanIntervalMinutes, 5);
    var type = scan.Type || 'AUTO';

    // AUTO: ยังไม่มีเวลาเข้า = เข้างาน, มีแล้ว = ออกงาน
    // แต่ถ้าเพิ่งเข้างานไปหยก ๆ ต้องนับเป็นการสแกนซ้ำ ไม่ใช่รีบตีความว่าออกงาน
    if (type === 'AUTO') {
      if (!timeIn) {
        type = 'IN';
      } else if (minutesBetween_(timeIn, now) < minInterval) {
        return duplicateResult_(scan, employee, 'IN', row, 'บันทึกเวลาเข้างานไปแล้ว');
      } else {
        type = 'OUT';
      }
    }

    if (type === 'IN' && timeIn) {
      if (minutesBetween_(timeIn, now) < minInterval) {
        return duplicateResult_(scan, employee, 'IN', row, 'บันทึกเวลาเข้างานไปแล้ว');
      }
      // เก็บเวลาเข้างานครั้งแรกไว้เสมอ — เวลามาถึงจริงคือครั้งแรก ไม่ใช่ครั้งที่สแกนซ้ำ
      return duplicateResult_(scan, employee, 'IN', row, 'มีเวลาเข้างานของวันนี้แล้ว');
    }
    if (type === 'OUT' && timeOut && minutesBetween_(timeOut, now) < minInterval) {
      return duplicateResult_(scan, employee, 'OUT', row, 'บันทึกเวลาออกงานไปแล้ว');
    }
    if (type === 'OUT' && !timeIn) {
      throw new Error('ยังไม่มีเวลาเข้างานของวันนี้ — สแกนเข้างานก่อน');
    }

    var photoUrl = savePhoto_(scan.PhotoBase64, dateKey, scan.EmployeeID, type, settings);

    if (type === 'IN') {
      row.TimeIn = now;
      if (photoUrl) row.PhotoInURL = photoUrl;
    } else {
      row.TimeOut = now;
      if (photoUrl) row.PhotoOutURL = photoUrl;
    }
    applyAttendanceComputedFields_(row, settings);

    if (rowIndex === -1) {
      objectToRow_(sheet, row);
    } else {
      objectToRow_(sheet, row, rowIndex);
    }

    logScan_(scan, employee, type, 'บันทึกแล้ว', photoUrl, now);

    return {
      duplicate: false,
      type: type,
      employee: employee,
      attendance: formatRow_(row),
      time: Utilities.formatDate(now, tz_(), 'HH:mm')
    };
  } finally {
    lock.releaseLock();
  }
}

/** สแกนซ้ำ: บันทึกไว้ใน ScanLogs เพื่อการตรวจสอบ แต่ไม่แตะแถว Attendance */
function duplicateResult_(scan, employee, type, row, message) {
  var now = new Date();
  logScan_(scan, employee, type, 'ซ้ำ: ' + message, '', now);
  return {
    duplicate: true,
    message: message,
    type: type,
    employee: employee,
    attendance: formatRow_(row),
    time: Utilities.formatDate(now, tz_(), 'HH:mm')
  };
}

function newAttendanceRow_(dateKey, employee) {
  return {
    Date: dateKey,
    EmployeeID: employee.EmployeeID,
    FullName: employee.FullName,
    Department: employee.Department || '',
    TimeIn: '',
    TimeOut: '',
    LateMinutes: '',
    WorkHours: '',
    Status: '',
    PhotoInURL: '',
    PhotoOutURL: '',
    Note: ''
  };
}

/** คำนวณ สาย / ชั่วโมงทำงาน / สถานะ จาก TimeIn+TimeOut ที่อยู่ในแถว */
function applyAttendanceComputedFields_(row, settings) {
  var timeIn = asDate_(row.TimeIn);
  var timeOut = asDate_(row.TimeOut);

  if (timeIn) {
    var limit = hhmmToMinutes_(settings.WorkStartTime) + num_(settings.LateGraceMinutes, 0);
    var late = minutesOfDay_(timeIn) - limit;
    row.LateMinutes = late > 0 ? late : 0;
    row.Status = late > 0 ? 'สาย' : 'ปกติ';
  } else {
    row.LateMinutes = '';
    row.Status = '';
  }

  if (timeIn && timeOut) {
    var hours = minutesBetween_(timeIn, timeOut) / 60 - num_(settings.BreakMinutes, 0) / 60;
    row.WorkHours = Math.round(Math.max(0, hours) * 100) / 100;
  } else {
    row.WorkHours = '';
    if (timeIn) row.Status = row.Status + ' · ยังไม่ออกงาน';
  }
  return row;
}

function findAttendanceRow_(sheet, dateKey, employeeId) {
  var headers = getHeaders_(sheet);
  var dateCol = headers.indexOf('Date');
  var idCol = headers.indexOf('EmployeeID');
  if (dateCol === -1 || idCol === -1) throw new Error('แท็บ Attendance ต้องมีคอลัมน์ Date และ EmployeeID');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (var i = 0; i < values.length; i++) {
    if (dateKey_(values[i][dateCol]) === dateKey && String(values[i][idCol]) === String(employeeId)) {
      return i + 2; // +2: แถวหัวตาราง + ดัชนีเริ่มที่ 1
    }
  }
  return -1;
}

function findEmployee_(employeeId) {
  var employees = listEmployees_();
  for (var i = 0; i < employees.length; i++) {
    if (String(employees[i].EmployeeID) === String(employeeId)) return employees[i];
  }
  return null;
}

// ---------- ScanLogs ----------

function listScanLogs_(limit) {
  var rows = sheetToObjects_(getSheet_(SHEETS.SCAN_LOGS));
  var n = num_(limit, 50);
  return rows.slice(Math.max(0, rows.length - n)).reverse().map(function (r) {
    // Timestamp เขียนลงไปเป็นข้อความ แต่ Sheets มักแปลงเป็นชนิดวันที่-เวลาเอง แล้วอ่านกลับมาเป็น ISO แบบ UTC
    r.Timestamp = formatTimestamp_(r.Timestamp);
    return r;
  });
}

/** แปลงค่าเวลาที่อ่านจากชีตให้เป็น 'yyyy-MM-dd HH:mm:ss' ตามเขตเวลาของสคริปต์ */
function formatTimestamp_(value) {
  var d = asDate_(value);
  return d ? Utilities.formatDate(d, tz_(), 'yyyy-MM-dd HH:mm:ss') : value;
}

function logScan_(scan, employee, type, result, photoUrl, when) {
  objectToRow_(getSheet_(SHEETS.SCAN_LOGS), {
    LogID: Utilities.getUuid().slice(0, 8),
    Timestamp: Utilities.formatDate(when, tz_(), 'yyyy-MM-dd HH:mm:ss'),
    EmployeeID: employee ? employee.EmployeeID : '',
    FullName: employee ? employee.FullName : '',
    Type: type,
    Distance: scan.Distance === undefined || scan.Distance === null ? '' : Math.round(Number(scan.Distance) * 1000) / 1000,
    Result: result,
    PhotoURL: photoUrl || '',
    Device: scan.Device || ''
  });
}

// ---------- รูปถ่ายใน Google Drive ----------

/**
 * เก็บภาพนิ่งตอนสแกนลงโฟลเดอร์ Drive แล้วคืน URL
 * ถ้าไม่ได้ตั้ง DriveFolderId ไว้ จะข้ามไปเงียบ ๆ — ระบบยังบันทึกเวลาได้ตามปกติ
 */
function savePhoto_(base64, dateKey, employeeId, type, settings) {
  var folderId = settings.DriveFolderId;
  if (!folderId || !base64) return '';
  try {
    var data = String(base64).replace(/^data:image\/\w+;base64,/, '');
    var name = dateKey + '_' + employeeId + '_' + type + '_' + Utilities.formatDate(new Date(), tz_(), 'HHmmss') + '.jpg';
    var blob = Utilities.newBlob(Utilities.base64Decode(data), 'image/jpeg', name);
    var file = DriveApp.getFolderById(folderId).createFile(blob);
    if (settings.PhotoSharing !== 'private') {
      // ต้องแชร์แบบ "ใครมีลิงก์ก็ดูได้" รูปจึงจะแสดงบนหน้าเว็บที่เปิดโดยไม่ล็อกอิน
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
    return file.getUrl();
  } catch (err) {
    // รูปเป็นแค่หลักฐานประกอบ — ถ้าเก็บไม่ได้ก็ยังต้องบันทึกเวลาทำงานให้สำเร็จ
    console.error('savePhoto_ failed: ' + err.message);
    return '';
  }
}

// ---------- Settings ----------

// ค่าที่ต้องอยู่ในรูปแบบ HH:mm เป๊ะ ๆ เพราะฝั่งหน้าเว็บใช้ <input type="time"> ซึ่งไม่รับ "8:00"
var TIME_SETTING_KEYS = ['WorkStartTime', 'WorkEndTime'];

/**
 * บังคับค่าเวลาให้เป็น HH:mm
 *
 * ช่องอย่าง "08:00" มักถูก Sheets ตีความเป็นชนิดเวลาโดยอัตโนมัติ และถ้ามีการเปลี่ยนรูปแบบเซลล์
 * เป็นข้อความภายหลัง ค่าจะกลายเป็น "8:00" ที่ตัดศูนย์นำหน้าออก — คำนวณยังถูก แต่ <input type="time">
 * จะมองว่าเป็นค่าไม่ถูกต้องแล้วแสดงช่องว่าง ผู้ใช้ที่กดบันทึกทับจึงลบเวลาเข้างานทิ้งโดยไม่รู้ตัว
 */
function normalizeTimeSetting_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, tz_(), 'HH:mm');
  var m = String(value).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(value).trim();
  var h = Number(m[1]);
  return (h < 10 ? '0' + h : String(h)) + ':' + m[2];
}

function getSettings_() {
  var settings = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { settings[k] = DEFAULT_SETTINGS[k]; });
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 2) return settings;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  values.forEach(function (r) {
    var key = String(r[0]).trim();
    if (!key) return;
    settings[key] = r[1] instanceof Date
      ? Utilities.formatDate(r[1], tz_(), 'HH:mm')
      : String(r[1]).trim();
  });
  // ทำให้เป็นรูปแบบมาตรฐานตอนอ่าน ไม่ใช่แค่ตอนเขียน — ชีตที่สร้างไว้ก่อนหน้านี้จะได้ใช้ได้ด้วย
  TIME_SETTING_KEYS.forEach(function (k) {
    if (settings[k]) settings[k] = normalizeTimeSetting_(settings[k]);
  });
  return settings;
}

function saveSettings_(settings) {
  var sheet = getSheet_(SHEETS.SETTINGS);
  var lastRow = sheet.getLastRow();
  var existing = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 1).getValues();

  Object.keys(settings).forEach(function (key) {
    var value = String(settings[key]);
    if (TIME_SETTING_KEYS.indexOf(key) !== -1) value = normalizeTimeSetting_(value);

    var rowIndex = -1;
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i][0]).trim() === key) { rowIndex = i + 2; break; }
    }

    if (rowIndex === -1) {
      // ต้องตั้งรูปแบบเซลล์เป็นข้อความ "ก่อน" เขียนค่าเสมอ — ถ้า appendRow ไปก่อน Sheets จะแปลง
      // "08:00" เป็นชนิดเวลาไปแล้ว การมาตั้งรูปแบบทีหลังจะได้ข้อความ "8:00" ที่หายศูนย์นำหน้า
      rowIndex = lastRow < 2 ? 2 : sheet.getLastRow() + 1;
      sheet.getRange(rowIndex, 1, 1, 2).setNumberFormat('@').setValues([[key, value]]);
      existing.push([key]);
      lastRow = rowIndex;
    } else {
      sheet.getRange(rowIndex, 2).setNumberFormat('@').setValue(value);
    }
  });
  return getSettings_();
}

// ---------- ติดตั้งครั้งแรก ----------

/** รันครั้งเดียวจากตัวแก้ไข Apps Script — สร้างแท็บที่ยังไม่มี พร้อมหัวคอลัมน์และค่าตั้งต้น */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      var headers = SHEET_HEADERS[name];
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });

  // คอลัมน์เวลาเก็บเป็นชนิดวันที่-เวลา แต่ให้แสดงเฉพาะ ชม:นาที เพื่อให้คนอ่านง่าย
  var att = ss.getSheetByName(SHEETS.ATTENDANCE);
  var attHeaders = getHeaders_(att);
  ['TimeIn', 'TimeOut'].forEach(function (col) {
    var i = attHeaders.indexOf(col);
    if (i !== -1) att.getRange(2, i + 1, att.getMaxRows() - 1, 1).setNumberFormat('HH:mm');
  });
  ['Date'].forEach(function (col) {
    var i = attHeaders.indexOf(col);
    if (i !== -1) att.getRange(2, i + 1, att.getMaxRows() - 1, 1).setNumberFormat('@');
  });

  // Descriptor เป็นข้อความยาว 128 ค่า — บังคับเป็นข้อความ กัน Sheets ตีความเป็นตัวเลข
  var face = ss.getSheetByName(SHEETS.FACE_DATA);
  var faceHeaders = getHeaders_(face);
  var di = faceHeaders.indexOf('Descriptor');
  if (di !== -1) face.getRange(2, di + 1, face.getMaxRows() - 1, 1).setNumberFormat('@');

  var settingsSheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (settingsSheet.getLastRow() < 2) {
    saveSettings_(DEFAULT_SETTINGS);
  }
  return 'พร้อมใช้งาน — เหลือขั้นตอน Deploy > New deployment';
}

// ---------- ตัวช่วยเรื่องวันที่/เวลา ----------

function tz_() {
  return Session.getScriptTimeZone();
}

/** แปลงค่าจากช่องวันที่ให้เป็น 'yyyy-MM-dd' ไม่ว่าชีตจะเก็บเป็นข้อความหรือเป็นชนิดวันที่ */
function dateKey_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, tz_(), 'yyyy-MM-dd');
  }
  return String(value).trim().slice(0, 10);
}

function asDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') return value;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** รวมวันที่ (yyyy-MM-dd) กับเวลา (HH:mm) ให้เป็น Date เดียว — ใช้ตอนแก้เวลาด้วยมือ */
function parseTimeOnDate_(dateKey, hhmm) {
  var t = String(hhmm).trim();
  if (Object.prototype.toString.call(hhmm) === '[object Date]') {
    t = Utilities.formatDate(hhmm, tz_(), 'HH:mm');
  }
  var m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) throw new Error('รูปแบบเวลาไม่ถูกต้อง: ' + hhmm);
  var parts = dateKey.split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(m[1]), Number(m[2]), 0);
}

function minutesOfDay_(date) {
  var hhmm = Utilities.formatDate(date, tz_(), 'HH:mm');
  return hhmmToMinutes_(hhmm);
}

function hhmmToMinutes_(hhmm) {
  var m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesBetween_(a, b) {
  return (b.getTime() - a.getTime()) / 60000;
}

function num_(value, fallback) {
  var n = Number(value);
  return isNaN(n) ? fallback : n;
}

// ---------- ตัวช่วยอ่าน/เขียนชีต (อิงชื่อหัวคอลัมน์ ไม่ใช่ตำแหน่งคอลัมน์) ----------

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('ไม่พบแท็บชื่อ: ' + name + ' (ลองรันฟังก์ชัน setupSheets ก่อน)');
  return sheet;
}

function getHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

function sheetToObjects_(sheet) {
  var headers = getHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row) {
    var obj = {};
    headers.forEach(function (header, i) {
      obj[header] = formatValue_(row[i]);
    });
    return obj;
  });
}

/** อ่านแถวเดียวแบบดิบ — ไม่แปลง Date เป็นข้อความ เพราะฝั่งคำนวณต้องใช้ Date จริง */
function rowObject_(sheet, rowIndex) {
  var headers = getHeaders_(sheet);
  var values = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var obj = {};
  headers.forEach(function (header, i) { obj[header] = values[i]; });
  return obj;
}

/** แปลงแถวดิบให้พร้อมส่งกลับเป็น JSON */
function formatRow_(row) {
  var out = {};
  Object.keys(row).forEach(function (k) { out[k] = formatValue_(row[k]); });
  if (row.TimeIn) out.TimeIn = Utilities.formatDate(asDate_(row.TimeIn), tz_(), 'HH:mm');
  if (row.TimeOut) out.TimeOut = Utilities.formatDate(asDate_(row.TimeOut), tz_(), 'HH:mm');
  out.Date = dateKey_(row.Date);
  return out;
}

function formatValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return value.toISOString();
  }
  return value;
}

function objectToRow_(sheet, obj, rowIndex) {
  var headers = getHeaders_(sheet);
  var row = headers.map(function (header) {
    return obj.hasOwnProperty(header) ? obj[header] : '';
  });
  if (rowIndex) {
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function findRowById_(sheet, idColumn, idValue) {
  var headers = getHeaders_(sheet);
  var idColIndex = headers.indexOf(idColumn);
  if (idColIndex === -1) throw new Error('ไม่พบคอลัมน์: ' + idColumn);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, idColIndex + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idValue)) return i + 2; // +2: แถวหัวตาราง + ดัชนีเริ่มที่ 1
  }
  return -1;
}

// ---------- Response / auth ----------

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(message) {
  return jsonResponse_({ ok: false, error: message });
}

function checkToken_(token) {
  if (API_TOKEN && token !== API_TOKEN) {
    throw new Error('Unauthorized: invalid token');
  }
}
