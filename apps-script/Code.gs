// ============================================================
// BROKEN ENGLISH STUDIO — Google Sheets Sync Script
// ============================================================
const SPREADSHEET_ID = '1XGrgURRj9a2ZhBT0nOH7cA8bZKrSA0_Wx8EIoyS2TQo';

const CHUNK_SESSION_PREFIX = 'upload_session_';
const FOLDER_BATCH_PREFIX = 'folder_batch_';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    let result = { success: false };

    if (action === 'syncTasks') {
      syncTasks(data.rows);
      result = { success: true };
    } else if (action === 'syncAttendance') {
      syncAttendance(data.rows);
      result = { success: true };
    } else if (action === 'syncLog') {
      appendLog(data.date, data.time, data.text);
      result = { success: true };
    } else if (action === 'syncAllLogs') {
      syncAllLogs(data.rows);
      result = { success: true };
    } else if (action === 'syncMonthlyReport') {
      syncMonthlyReport(data);
      result = { success: true };
    } else if (action === 'startUpload') {
      result = handleStartUpload(data);
    } else if (action === 'uploadChunk') {
      result = handleUploadChunk(data);
    } else if (action === 'completeUpload') {
      result = handleCompleteUpload(data);
    } else if (action === 'finalizeFolder') {
      result = handleFinalizeFolder(data);
    } else if (action === 'zipFiles') {
      result = handleZipFiles(data);
    } else if (action === 'listFolder') {
      result = handleListFolder(data);
    } else if (action === 'uploadFolder') {
      result = handleFolderUpload(data);
    } else {
      result = handleFileUpload(data);
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── Helper: get or create a sheet tab ───────────────────────
function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

// ── TASKS SHEET ─────────────────────────────────────────────
function syncTasks(rows) {
  const sheet = getOrCreateSheet('Tasks');

  const headers = [
    'Task ID', 'Topic', 'Type', 'Assigned To', 'Employee Email',
    'Description', 'Assigned Date', 'Deadline', 'Status',
    'Explanation / Notes', 'Asset Link', 'Reference File', 'Last Updated'
  ];

  sheet.clearContents();

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground('#1a1a2e');
  headerRange.setFontColor('#FD6D05');
  headerRange.setFontWeight('bold');
  headerRange.setFontSize(10);

  if (!rows || rows.length === 0) return;

  const now = new Date().toLocaleString();
  const data = rows.map(r => [
    r.id, r.topic, r.type, r.assignedTo, r.employeeEmail,
    r.description, r.assignedDate, r.deadline, r.status,
    r.explanation, r.assetLink, r.referenceFile, now
  ]);

  sheet.getRange(2, 1, data.length, headers.length).setValues(data);

  rows.forEach((r, i) => {
    const cell = sheet.getRange(i + 2, 9);
    const colors = {
      'Completed':       { bg: '#052e16', fg: '#4ade80' },
      'In Progress':     { bg: '#172554', fg: '#60a5fa' },
      'Pending':         { bg: '#422006', fg: '#fbbf24' },
      'Rework Required': { bg: '#431407', fg: '#fb923c' },
      'Rejected':        { bg: '#450a0a', fg: '#f87171' },
    };
    const c = colors[r.status] || { bg: '#1e1e2e', fg: '#9ca3af' };
    cell.setBackground(c.bg).setFontColor(c.fg).setFontWeight('bold');
  });

  sheet.autoResizeColumns(1, headers.length);
}

// ── ATTENDANCE SHEET ─────────────────────────────────────────
function syncAttendance(rows) {
  const sheet = getOrCreateSheet('Attendance');

  const headers = [
    'Record ID', 'Employee Name', 'Employee Email',
    'Date', 'Clock In', 'Clock Out', 'Hours Worked', 'Last Updated'
  ];

  sheet.clearContents();

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground('#1a1a2e');
  headerRange.setFontColor('#FD6D05');
  headerRange.setFontWeight('bold');
  headerRange.setFontSize(10);

  if (!rows || rows.length === 0) return;

  const now = new Date().toLocaleString();
  const data = rows.map(r => [
    r.id, r.employeeName, r.employeeEmail,
    r.date, r.clockIn, r.clockOut || 'Still clocked in',
    r.hoursWorked || 0, now
  ]);

  sheet.getRange(2, 1, data.length, headers.length).setValues(data);

  rows.forEach((r, i) => {
    if (!r.clockOut) {
      sheet.getRange(i + 2, 6).setBackground('#422006').setFontColor('#fb923c').setFontWeight('bold');
    }
  });

  sheet.autoResizeColumns(1, headers.length);
}

// ── ACTIVITY LOG SHEET ───────────────────────────────────────
function appendLog(date, time, text) {
  const sheet = getOrCreateSheet('Activity Logs');

  if (sheet.getLastRow() === 0) {
    const headerRange = sheet.getRange(1, 1, 1, 3);
    headerRange.setValues([['Date', 'Time', 'Event']]);
    headerRange.setBackground('#1a1a2e');
    headerRange.setFontColor('#FD6D05');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  sheet.insertRowAfter(1);
  const row = sheet.getRange(2, 1, 1, 3);
  row.setValues([[date, time, text]]);
  row.setFontColor('#d1d5db');

  const maxRows = 500;
  const totalRows = sheet.getLastRow();
  if (totalRows > maxRows + 1) {
    sheet.deleteRows(maxRows + 2, totalRows - maxRows - 1);
  }

  sheet.autoResizeColumns(1, 3);
}

function syncAllLogs(rows) {
  const sheet = getOrCreateSheet('Activity Logs');
  sheet.clearContents();

  const headers = ['Date', 'Time', 'Event'];
  const headerRange = sheet.getRange(1, 1, 1, 3);
  headerRange.setValues([headers]);
  headerRange.setBackground('#1a1a2e');
  headerRange.setFontColor('#FD6D05');
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (!rows || rows.length === 0) return;

  const data = rows.map(r => [r.date || '', r.time || '', r.text || '']);
  sheet.getRange(2, 1, data.length, 3).setValues(data);
  sheet.getRange(2, 1, data.length, 3).setFontColor('#d1d5db');
  sheet.autoResizeColumns(1, 3);
}

// ── MONTHLY REPORT SHEET ─────────────────────────────────────
function syncMonthlyReport(data) {
  const sheet = getOrCreateSheet('Monthly Report');
  sheet.clearContents();

  const orange = '#FD6D05';
  const darkBg = '#1a1a2e';
  const midBg  = '#0f1121';

  sheet.getRange(1, 1).setValue('📊 Broken English Studio — Monthly Report');
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold').setFontColor(orange);
  sheet.getRange(2, 1).setValue(`${data.month} ${data.year}`);
  sheet.getRange(2, 1).setFontSize(11).setFontColor('#9ca3af');
  sheet.getRange(3, 1).setValue(`Generated: ${new Date().toLocaleString()}`);
  sheet.getRange(3, 1).setFontSize(9).setFontColor('#6b7280');

  const kpiHeaders = ['Metric', 'Value'];
  const kpiData = [
    ['Total Tasks Assigned',           data.total],
    ['Tasks Completed',                data.completed],
    ['Rework Flagged',                 data.reworks],
    ['Rejected',                       data.rejected],
    ['Completion Rate',                data.rate + '%'],
    ['Total Hours Worked (Attendance)',data.totalHours + ' hrs'],
    ['Unique Employees (Attendance)',  data.uniqueEmployees],
  ];

  sheet.getRange(5, 1, 1, 2).setValues([kpiHeaders])
    .setBackground(darkBg).setFontColor(orange).setFontWeight('bold');
  sheet.getRange(6, 1, kpiData.length, 2).setValues(kpiData);
  sheet.getRange(6, 1, kpiData.length, 1).setFontColor('#9ca3af');
  sheet.getRange(6, 2, kpiData.length, 1).setFontColor('#ffffff').setFontWeight('bold');

  const rateVal = parseInt(data.rate);
  const rateColor = rateVal >= 80 ? '#4ade80' : rateVal >= 50 ? '#fbbf24' : '#f87171';
  sheet.getRange(10, 2).setFontColor(rateColor).setFontSize(12);

  const creatorStartRow = 6 + kpiData.length + 2;
  sheet.getRange(creatorStartRow - 1, 1).setValue('👥 Creator Performance')
    .setFontWeight('bold').setFontColor(orange).setFontSize(11);

  const creatorHeaders = ['Creator', 'Assigned', 'Completed', 'Reworks', 'Rejected', 'Completion Rate'];
  sheet.getRange(creatorStartRow, 1, 1, creatorHeaders.length)
    .setValues([creatorHeaders])
    .setBackground(darkBg).setFontColor(orange).setFontWeight('bold');

  if (data.creatorBreakdown && data.creatorBreakdown.length > 0) {
    const creatorData = data.creatorBreakdown.map(c => [
      c.name, c.assigned, c.completed, c.reworks, c.rejected, c.rate + '%'
    ]);
    sheet.getRange(creatorStartRow + 1, 1, creatorData.length, creatorHeaders.length)
      .setValues(creatorData).setFontColor('#d1d5db');

    data.creatorBreakdown.forEach((c, i) => {
      const color = c.rate >= 80 ? '#4ade80' : c.rate >= 50 ? '#fbbf24' : '#f87171';
      sheet.getRange(creatorStartRow + 1 + i, 6).setFontColor(color).setFontWeight('bold');
    });
  }

  const taskStartRow = creatorStartRow + (data.creatorBreakdown ? data.creatorBreakdown.length : 0) + 3;
  sheet.getRange(taskStartRow - 1, 1).setValue('📋 Task List This Month')
    .setFontWeight('bold').setFontColor(orange).setFontSize(11);

  const taskHeaders = [
    'Campaign Topic', 'Category', 'Assigned Creator', 'Description Info',
    'Assigned Date', 'Target Date', 'Status', 'Explanation / Notes', 'Delivery Output'
  ];
  sheet.getRange(taskStartRow, 1, 1, taskHeaders.length)
    .setValues([taskHeaders])
    .setBackground(darkBg).setFontColor(orange).setFontWeight('bold');

  if (data.taskRows && data.taskRows.length > 0) {
    const taskData = data.taskRows.map(t => [
      t.topic, t.type, t.assignedTo, t.description,
      t.assignedDate, t.deadline, t.status,
      t.explanation !== 'None' ? t.explanation : '',
      t.assetLink || ''
    ]);
    sheet.getRange(taskStartRow + 1, 1, taskData.length, taskHeaders.length)
      .setValues(taskData).setFontColor('#d1d5db');

    const statusColors = {
      'Completed':       { bg: '#052e16', fg: '#4ade80' },
      'In Progress':     { bg: '#172554', fg: '#60a5fa' },
      'Pending':         { bg: '#422006', fg: '#fbbf24' },
      'Rework Required': { bg: '#431407', fg: '#fb923c' },
      'Rejected':        { bg: '#450a0a', fg: '#f87171' },
    };
    data.taskRows.forEach((t, i) => {
      const c = statusColors[t.status] || { bg: midBg, fg: '#9ca3af' };
      sheet.getRange(taskStartRow + 1 + i, 7)
        .setBackground(c.bg).setFontColor(c.fg).setFontWeight('bold');
    });
  }

  sheet.autoResizeColumns(1, 9);
  sheet.setFrozenRows(1);
}

// ── FILE UPLOAD HANDLER (legacy, small files only) ──────────
function handleFileUpload(data) {
  try {
    if (!data.base64 || !data.fileName) {
      return { success: false, error: 'Missing file data' };
    }

    const folderName = 'BE Studio Uploads';
    let folder;
    const folders = DriveApp.getFoldersByName(folderName);
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder(folderName);
    }

    const blob = Utilities.newBlob(
      Utilities.base64Decode(data.base64),
      data.mimeType || 'application/octet-stream',
      data.fileName
    );
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return { success: true, fileUrl: file.getUrl() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── MULTI-FILE FOLDER UPLOAD (legacy, small files only) ─────
function handleFolderUpload(data) {
  try {
    if (!data.files || data.files.length === 0) {
      return { success: false, error: 'No files provided' };
    }

    const parentName = 'BE Studio Uploads';
    let parent;
    const parents = DriveApp.getFoldersByName(parentName);
    if (parents.hasNext()) {
      parent = parents.next();
    } else {
      parent = DriveApp.createFolder(parentName);
    }

    const safeName = (data.folderName || 'Delivery').replace(/[\\/:*?"<>|]/g, '-');
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm');
    const taskFolder = parent.createFolder(`${safeName} (${stamp})`);

    data.files.forEach(f => {
      if (f.base64 && f.fileName) {
        const blob = Utilities.newBlob(
          Utilities.base64Decode(f.base64),
          f.mimeType || 'application/octet-stream',
          f.fileName
        );
        taskFolder.createFile(blob);
      }
    });

    taskFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return {
      success: true,
      folderUrl: taskFolder.getUrl(),
      folderName: data.folderName || 'Delivery',
      fileCount: data.files.length
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// CHUNKED RESUMABLE UPLOAD
// ============================================================
// Two ways a file reaches Drive through the same Drive resumable session:
//  • DIRECT (data.direct === true, sent by the Media Suite page): the session URL is returned
//    to the browser, which PUTs the raw file straight to Drive — no base64, no hop through
//    this script, true byte-by-byte progress, resume after a dropped connection. When Drive
//    has the whole file the browser calls 'completeUpload' so this script can share it.
//  • VIA SCRIPT (fallback, unchanged): the browser sends base64 chunks to 'uploadChunk' and
//    this script forwards them to the same session.
// The session is stored either way, so the page can always fall back to chunks.
function getUploadsParentFolder_() {
  const parentName = 'BE Studio Uploads';
  const parents = DriveApp.getFoldersByName(parentName);
  if (parents.hasNext()) return parents.next();
  return DriveApp.createFolder(parentName);
}

function handleStartUpload(data) {
  try {
    let parentFolderId;
    const props = PropertiesService.getScriptProperties();

    if (data.folderBatchId) {
      const cachedRaw = props.getProperty(FOLDER_BATCH_PREFIX + data.folderBatchId);
      let cachedFolderId = null;
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (Date.now() - cached.createdAt < SESSION_TTL_MS) cachedFolderId = cached.folderId;
      }
      if (!cachedFolderId) {
        const parent = getUploadsParentFolder_();
        const safeName = (data.folderName || 'Delivery').replace(/[\\/:*?"<>|]/g, '-');
        const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm');
        const subFolder = parent.createFolder(`${safeName} (${stamp})`);
        cachedFolderId = subFolder.getId();
        props.setProperty(FOLDER_BATCH_PREFIX + data.folderBatchId, JSON.stringify({ folderId: cachedFolderId, createdAt: Date.now() }));
      }
      parentFolderId = cachedFolderId;
    } else {
      parentFolderId = getUploadsParentFolder_().getId();
    }

    const mimeType = data.mimeType || 'application/octet-stream';
    const metadata = { name: data.fileName, parents: [parentFolderId] };
    const initHeaders = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
    if (data.direct) {
      // Needed for the browser to upload straight to this session: declare the file up
      // front and name the page's origin so Drive accepts its cross-origin requests.
      initHeaders['X-Upload-Content-Type'] = mimeType;
      if (data.fileSize) initHeaders['X-Upload-Content-Length'] = String(data.fileSize);
      if (data.origin) initHeaders['Origin'] = data.origin;
    }
    const initResp = UrlFetchApp.fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
      {
        method: 'post',
        contentType: 'application/json; charset=UTF-8',
        headers: initHeaders,
        payload: JSON.stringify(metadata),
        muteHttpExceptions: true
      }
    );

    if (initResp.getResponseCode() >= 300) {
      return { success: false, error: 'Failed to start Drive session: ' + initResp.getContentText() };
    }

    const headers = initResp.getAllHeaders();
    const sessionUri = headers['Location'] || headers['location'] ||
      Object.keys(headers).reduce((found, k) => found || (k.toLowerCase() === 'location' ? headers[k] : null), null);
    if (!sessionUri) {
      return { success: false, error: 'Drive did not return a resumable session URL. Response headers: ' + JSON.stringify(headers) };
    }

    const uploadId = Utilities.getUuid();
    props.setProperty(CHUNK_SESSION_PREFIX + uploadId, JSON.stringify({
      sessionUri: sessionUri,
      mimeType: mimeType,
      fileSize: data.fileSize,
      fileName: data.fileName,
      createdAt: Date.now()
    }));

    const result = { success: true, uploadId: uploadId };
    if (data.direct) result.sessionUrl = sessionUri;
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleUploadChunk(data) {
  try {
    const props = PropertiesService.getScriptProperties();
    const key = CHUNK_SESSION_PREFIX + data.uploadId;
    const sessionRaw = props.getProperty(key);
    if (!sessionRaw) {
      return { success: false, error: 'Upload session expired or not found. Please retry the upload.' };
    }

    const session = JSON.parse(sessionRaw);
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      props.deleteProperty(key);
      return { success: false, error: 'Upload session expired (older than 6 hours). Please retry the upload.' };
    }

    const bytes = Utilities.base64Decode(data.chunkBase64);
    const blob = Utilities.newBlob(bytes, session.mimeType);

    const resp = UrlFetchApp.fetch(session.sessionUri, {
      method: 'put',
      contentType: session.mimeType,
      headers: {
        'Content-Range': 'bytes ' + data.start + '-' + data.end + '/' + data.total
      },
      payload: blob.getBytes(),
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();

    if (data.isLast) {
      if (code === 200 || code === 201) {
        const fileData = JSON.parse(resp.getContentText());
        const file = DriveApp.getFileById(fileData.id);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        props.deleteProperty(key);
        return { success: true, done: true, fileUrl: file.getUrl(), fileName: session.fileName };
      }
      return { success: false, error: 'Final chunk failed (' + code + '): ' + resp.getContentText() };
    }

    if (code === 308 || code === 200 || code === 201) {
      return { success: true, done: false };
    }
    return { success: false, error: 'Chunk upload failed (' + code + '): ' + resp.getContentText() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// DIRECT uploads: the browser finished sending the file straight to Drive. Share it and
// return its link — same result shape as the last 'uploadChunk' of the chunked path.
function handleCompleteUpload(data) {
  try {
    if (!data.fileId) return { success: false, error: 'Drive did not return the uploaded file id.' };
    const props = PropertiesService.getScriptProperties();
    const key = CHUNK_SESSION_PREFIX + data.uploadId;
    const sessionRaw = props.getProperty(key);
    const session = sessionRaw ? JSON.parse(sessionRaw) : null;
    const file = DriveApp.getFileById(data.fileId);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    if (sessionRaw) props.deleteProperty(key);
    return { success: true, done: true, fileUrl: file.getUrl(), fileName: (session && session.fileName) || file.getName() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleFinalizeFolder(data) {
  try {
    const props = PropertiesService.getScriptProperties();
    const key = FOLDER_BATCH_PREFIX + data.folderBatchId;
    const raw = props.getProperty(key);
    if (!raw) return { success: false, error: 'Folder batch session not found.' };
    const { folderId } = JSON.parse(raw);
    const folder = DriveApp.getFolderById(folderId);
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    props.deleteProperty(key);
    return { success: true, folderUrl: folder.getUrl() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleZipFiles(data) {
  try {
    const fileIds = data.fileIds || [];
    if (!fileIds.length) return { success: false, error: 'No fileIds provided.' };

    const blobs = [];
    for (let i = 0; i < fileIds.length; i++) {
      const file = DriveApp.getFileById(fileIds[i]);
      blobs.push(file.getBlob());
    }

    const zipName = (data.zipName || 'files') + '.zip';
    const zipBlob = Utilities.zip(blobs, zipName);
    const zipBase64 = Utilities.base64Encode(zipBlob.getBytes());

    return { success: true, zipBase64: zipBase64, zipName: zipName };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── LIST FOLDER FILES (for per-file Work Approval review) ────
// data: { folderId }
function handleListFolder(data) {
  try {
    if (!data.folderId) return { success: false, error: 'No folderId provided.' };
    const folder = DriveApp.getFolderById(data.folderId);
    const it = folder.getFiles();
    const files = [];
    while (it.hasNext()) {
      const f = it.next();
      files.push({
        id: f.getId(),
        name: f.getName(),
        mimeType: f.getMimeType(),
        url: 'https://drive.google.com/file/d/' + f.getId() + '/view',
        size: f.getSize()
      });
    }
    return { success: true, files: files };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── TEMP TEST — run manually to check folder access ─────────
function testFolder() {
  var f = DriveApp.getFolderById('1lWElQNmgeoPkWOuQ8PMZ4F6J7_QIV6_O');
  var it = f.getFiles(), n = 0;
  while (it.hasNext()) { it.next(); n++; }
  Logger.log('OK, files: ' + n);
}
