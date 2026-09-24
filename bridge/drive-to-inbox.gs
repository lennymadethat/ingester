/**
 * Google Drive → Ingester bridge (Google Apps Script). Optional.
 *
 * Drop ANY file into one Drive folder from any device; this script runs on
 * Google's servers every five minutes, POSTs each new file to the Ingester's
 * /upload route, and moves the original into a `_sent` subfolder so it is
 * never sent twice. Files over MAX_MB are parked in `_too-big`.
 *
 * Install: script.google.com → new project → paste this file → fill CONFIG →
 * run installTrigger() once (authorise Drive + external requests when asked).
 */

const CONFIG = {
  INGESTER_URL: 'https://ingester.YOUR_SUBDOMAIN.workers.dev',
  INGESTER_TOKEN: 'PASTE_INGESTER_TOKEN',       // the same value as `wrangler secret put INGESTER_TOKEN`
  UPLOADS_FOLDER_ID: 'PASTE_DRIVE_FOLDER_ID',   // the folder you drop files into
  SENT_SUBFOLDER: '_sent',
  TOOBIG_SUBFOLDER: '_too-big',
  MAX_MB: 40,                                   // Apps Script cannot POST > 50 MB
  MAX_PER_RUN: 12,                              // small batch, never near the 6-minute wall
};

function bridgeOnce() {
  const folder = DriveApp.getFolderById(CONFIG.UPLOADS_FOLDER_ID);
  const sent = getOrCreateSub_(folder, CONFIG.SENT_SUBFOLDER);
  const tooBig = getOrCreateSub_(folder, CONFIG.TOOBIG_SUBFOLDER);
  const files = folder.getFiles();
  let n = 0, ok = 0;
  while (files.hasNext() && n < CONFIG.MAX_PER_RUN) {
    const file = files.next();
    n++;
    if (file.getSize() > CONFIG.MAX_MB * 1024 * 1024) {
      file.moveTo(tooBig);
      Logger.log('parked (too big): ' + file.getName());
      continue;
    }
    try {
      const blob = file.getBlob();
      const url = CONFIG.INGESTER_URL + '/upload?name=' + encodeURIComponent(file.getName());
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: blob.getContentType() || 'application/octet-stream',
        payload: blob.getBytes(),
        headers: { 'x-ingester-token': CONFIG.INGESTER_TOKEN },
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() === 200) { file.moveTo(sent); ok++; }
      else Logger.log('upload failed ' + file.getName() + ': ' + res.getResponseCode() + ' ' + res.getContentText());
    } catch (e) {
      Logger.log('error on ' + file.getName() + ': ' + e);
    }
  }
  Logger.log('bridge: sent ' + ok + '/' + n + ' file(s)');
  return ok;
}

function getOrCreateSub_(folder, name) {
  const it = folder.getFoldersByName(name);
  return it.hasNext() ? it.next() : folder.createFolder(name);
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'bridgeOnce') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('bridgeOnce').timeBased().everyMinutes(5).create();
  Logger.log('trigger installed: bridgeOnce runs every 5 minutes.');
}
