/**
 * DIRECT-TO-DRIVE UPLOADS for Media Suite deliveries (add to the existing web-app script).
 *
 * Why: today every video byte goes browser -> Apps Script (as base64, +33% size) -> Drive,
 * one 16MB chunk per request. The browser also cannot see bytes leave while a request to the
 * script is in flight, so progress can only move chunk-by-chunk.
 *
 * With this addition the script only OPENS a Drive resumable-upload session and hands its
 * URL to the browser. The browser then sends the raw file straight to Drive in 32MB pieces:
 *   - no base64, no proxy hop  -> uses the full upload bandwidth
 *   - true byte-by-byte progress (1%, 2%, 3%, ...)
 *   - resumes from the byte Drive confirmed after a dropped connection
 * The client (index.html) switches to it automatically when startUpload returns `sessionUrl`
 * and silently falls back to the current path if the direct PUT is blocked.
 *
 * INSTALL (script.google.com -> the project behind GOOGLE_SCRIPT_URL):
 * 1. Paste the two functions below into the project.
 * 2. In doPost's action switch:
 *      case 'startUpload':
 *        if (data.direct) { const r = startDirectUpload_(data); if (r) return json_(r); }
 *        ... existing startUpload code (unchanged fallback) ...
 *      case 'completeUpload':
 *        return json_(completeDirectUpload_(data));
 *    (json_ = however the script already returns ContentService JSON.)
 * 3. Replace `resolveUploadFolder_(data)` with the script's existing helper that picks the
 *    delivery folder / the folderBatchId batch folder, so finalizeFolder keeps working.
 * 4. Deploy -> Manage deployments -> edit the existing deployment -> New version
 *    (keeps the same /exec URL).
 */

function startDirectUpload_(data) {
  var folder = resolveUploadFolder_(data);            // <- existing folder/batch helper
  var meta = { name: data.fileName, mimeType: data.mimeType || 'application/octet-stream', parents: [folder.getId()] };
  var res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify(meta),
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': meta.mimeType,
        'X-Upload-Content-Length': String(data.fileSize),
        // Lets Drive answer the browser's cross-origin PUTs to this session.
        Origin: data.origin
      },
      muteHttpExceptions: true
    }
  );
  if (res.getResponseCode() !== 200) return null;     // null -> caller falls back to the proxy path
  var headers = res.getAllHeaders();
  var sessionUrl = headers['Location'] || headers['location'];
  if (!sessionUrl) return null;
  return { success: true, uploadId: Utilities.getUuid(), sessionUrl: sessionUrl };
}

// Called by the browser after Drive returns the finished file's id.
function completeDirectUpload_(data) {
  if (!data.fileId) return { success: false, error: 'Missing fileId' };
  var file = DriveApp.getFileById(data.fileId);
  // Match the sharing the existing uploads use (anyone with the link can view).
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { success: true, fileUrl: file.getUrl(), fileName: file.getName() };
}
