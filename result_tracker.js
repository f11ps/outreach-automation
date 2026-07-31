// result_tracker.js
//
// ════════════════════════════════════════════════════════════════════════════
// PURPOSE IN THE PIPELINE
// ------------------------------------------------------------------------------
// This module is the persistence layer for the contact-form-filling run
// (main.js). While submitter.js decides whether an individual form submission
// worked, result_tracker.js is responsible for:
//   - Writing each processed URL's outcome as a row in the results CSV
//     (form_results/contact_results.csv, path from config.js CSV_PATH),
//   - Mirroring that same row to a live Google Sheet via a POST to a deployed
//     Google Apps Script "Web App" endpoint (code.gs), so results can be
//     watched in real time without opening the CSV,
//   - Saving/loading a simple "progress" checkpoint (the index of the next
//     URL to process) so that if the tool is stopped and restarted, it can
//     resume instead of starting over (see README "Resume Support"),
//   - Loading already-existing results back into memory on startup (so
//     main.js knows what's already been done),
//   - Taking debug screenshots when something goes wrong (e.g. no form found,
//     no confirmation detected), saved under OUTPUT_DIR,
//   - A small DOM helper to strip cookie-consent / accessibility overlay
//     widgets out of the way before interacting with a page.
//
// HOW IT WORKS (HIGH LEVEL) / EXPORTED FUNCTIONS
// ------------------------------------------------------------------------------
//   takeDebugScreenshot(driver, prefix)
//     Fire-and-forget: asks Selenium for a base64 screenshot of the current
//     page and writes it to `${OUTPUT_DIR}/${prefix}_<unixTimestamp>.png`.
//     Returns the intended file path immediately (does not await the actual
//     write), so callers get a path string back even though the file may
//     still be being written asynchronously.
//
//   saveResults(results)
//     Appends only the LAST element of the `results` array as one new CSV row
//     (not a full rewrite — main.js is expected to call this once per
//     processed URL with the results array so far, so re-appending the whole
//     history each time would be wasteful and would duplicate rows). Creates
//     the CSV with a header row first if it doesn't exist yet. Also forwards
//     the same row to Google Sheets via sendToSheets().
//
//   saveProgress(idx) / loadProgress()
//     Persist/read a single integer (the index of the next URL to process)
//     to/from PROGRESS_FILE (form_results/progress.txt). This is the resume
//     checkpoint referenced in the README.
//
//   loadExistingResults()
//     Parses the existing CSV (if any) back into an array of row objects
//     keyed by CSV_FIELDS, so main.js can rebuild its `results` array in
//     memory when resuming a run.
//
//   clearProgress()
//     Deletes PROGRESS_FILE — called once a run completes fully, so the next
//     run starts fresh from index 0 rather than "resuming" past the end.
//
//   removeOverlays(driver)
//     Best-effort removal of cookie-consent banners / accessibility widgets
//     (Cybot Cookiebot dialog, generic ".cookie" classes, "Accept" buttons,
//     etc.) that could otherwise intercept clicks meant for the actual
//     contact form.
//
//   sendToSheets(record)
//     POSTs a single row to the Google Apps Script Web App URL (SHEETS_URL)
//     as JSON `{ type: 'cf', rows: [row] }`. Errors are swallowed (network
//     issues shouldn't crash the scraping run) — this is a "best-effort live
//     mirror", the CSV file remains the source of truth.
//
// DEPENDENCIES / USAGE
// ------------------------------------------------------------------------------
// - Depends on Node's built-in `fs` and `path` modules, plus config.js for
//   CSV_FIELDS (column list/order), CSV_PATH, PROGRESS_FILE, and OUTPUT_DIR.
// - Depends on the global `fetch` (Node 18+ has this built in) to talk to the
//   Google Sheets Apps Script endpoint described in the README ("Google
//   Sheets live updates" section — code.gs must be deployed as a Web App and
//   its URL either hardcoded here or provided via the GOOGLE_SHEETS_URL env
//   var).
// - Used by main.js, which calls saveResults()/saveProgress() after each URL,
//   loadProgress()/loadExistingResults() at startup to support resuming, and
//   clearProgress() once the whole URL list has been processed. main.js also
//   calls takeDebugScreenshot() when a form/confirmation can't be found, to
//   help diagnose failures later.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');
const { CSV_FIELDS, CSV_PATH, PROGRESS_FILE, OUTPUT_DIR } = require('./config');

// URL of the deployed Google Apps Script Web App (code.gs) that receives live
// row updates and writes them into the "CFResults" sheet. Can be overridden
// via the GOOGLE_SHEETS_URL env var without touching code; falls back to the
// hardcoded default deployment URL.
const SHEETS_URL = process.env.GOOGLE_SHEETS_URL || 'https://script.google.com/macros/s/AKfycbxrirb17CXY4T1s_uvK-m9p29S-PrfIs8L4CZPCfVXCg8NwMZz0XMVs9scuKJiNhBFX/exec';

// Best-effort push of one result row to the live Google Sheet. Builds the row
// in the same column order as CSV_FIELDS (so the sheet and CSV stay aligned),
// then fires a POST and silently swallows any failure (offline, endpoint
// down, etc.) — this must never be allowed to block or crash the main run.
function sendToSheets(record) {
  if (!SHEETS_URL) return;
  const row = CSV_FIELDS.map(f => record[f] || '');
  fetch(SHEETS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'cf', rows: [row] })
  }).catch(() => {});
}

// Captures a screenshot of the current browser state for debugging failed
// runs (e.g. "no form found", "no confirmation detected" — see main.js call
// sites). Filename embeds a unix timestamp so repeated calls with the same
// prefix don't overwrite each other. Note: the screenshot capture/write is
// NOT awaited by the caller — this function returns the target path
// synchronously while the actual async screenshot + file write happens in
// the background (fire-and-forget), so it's possible (though unlikely in
// practice) for the process to exit before the file finishes writing.
function takeDebugScreenshot(driver, prefix) {
  try {
    const p = path.join(OUTPUT_DIR, `${prefix}_${Math.floor(Date.now()/1000)}.png`);
    driver.takeScreenshot().then(data => {
      fs.writeFileSync(p, data, 'base64');
      console.log(`   📸 Screenshot: ${p}`);
    }).catch(() => {});
    return p;
  } catch (_) { return ''; }
}

// Sanitizes and CSV-escapes a single field value before writing it to the
// results file: strips NUL bytes and other control characters (which can
// corrupt the CSV or cause issues in spreadsheet tools), then wraps the value
// in double quotes (escaping any internal quotes) if it contains a comma,
// quote, or newline — standard CSV quoting rules.
function _escapeCsv(val) {
  // Strip NUL bytes and non-printable chars, then CSV-escape
  const s = String(val == null ? '' : val)
    .replace(/\x00/g, '')          // remove NUL bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, ''); // remove other control chars
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Persists a result row to disk. Design note: `results` is the FULL array of
// results accumulated so far by main.js, but this function only writes the
// LAST entry — it's meant to be called once per newly-processed URL (i.e.
// after main.js pushes a new record onto `results`), so appending just that
// one new row is both correct and far cheaper than rewriting the whole file
// each time. The header row is written once, the first time the CSV file is
// created. After writing to disk, also mirrors the row to Google Sheets.
function saveResults(results) {
  // Append only the latest record instead of rewriting entire file
  if (!results.length) return;
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, CSV_FIELDS.join(',') + '\n', 'utf8');
  }
  const r = results[results.length - 1];
  const row = CSV_FIELDS.map(f => _escapeCsv(r[f] || '')).join(',');
  fs.appendFileSync(CSV_PATH, row + '\n', 'utf8');
  sendToSheets(r);
}

// Writes the "resume point" — the index (into the URL list) that should be
// processed next — to PROGRESS_FILE as a plain integer string.
function saveProgress(idx) {
  fs.writeFileSync(PROGRESS_FILE, String(idx), 'utf8');
}

// Reads back the resume point saved by saveProgress(). Validates the file
// contents are purely digits before trusting them; returns 0 (start from the
// beginning) if the file doesn't exist, is empty, or contains anything
// unexpected.
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const v = fs.readFileSync(PROGRESS_FILE, 'utf8').trim();
      if (/^\d+$/.test(v)) return parseInt(v, 10);
    }
  } catch (_) {}
  return 0;
}

// Re-hydrates the in-memory `results` array from an existing CSV file on
// disk, so a resumed run has access to everything already recorded (e.g. for
// display, or to avoid re-processing). Parses the header line to map column
// positions back to CSV_FIELDS names (defensive against column
// reordering/mismatch), defaulting any field not present in the header to ''.
// NOTE: uses a naive `line.split(',')` rather than a full CSV parser, so it
// does not correctly un-escape quoted fields that themselves contain commas
// — acceptable here since this is just for resume/inspection purposes, not
// the canonical write path.
function loadExistingResults() {
  const results = [];
  if (!fs.existsSync(CSV_PATH)) return results;
  try {
    const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n').filter(Boolean);
    if (lines.length < 2) return results; // header only / empty file
    const headers = lines[0].split(',');
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      const row  = Object.fromEntries(CSV_FIELDS.map(f => [f, '']));
      headers.forEach((h, idx) => { if (row.hasOwnProperty(h)) row[h] = vals[idx] || ''; });
      results.push(row);
    }
  } catch (_) {}
  return results;
}

// Deletes the progress checkpoint file. Called once a run has processed every
// URL in the list, so a subsequent run starts over from index 0 instead of
// treating the list as "already fully done".
function clearProgress() {
  try { if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE); } catch (_) {}
}

// Best-effort cleanup of common cookie-consent banners / accessibility
// widgets that can visually cover or intercept clicks on the actual contact
// form (e.g. a "Accept cookies" bar sitting on top of the submit button).
// Runs a small executeScript per selector, in the browser context, that
// simply removes any matching elements from the DOM. Each removal attempt is
// independent and failures are swallowed — this is a convenience pass, not a
// guaranteed one.
function removeOverlays(driver) {
  const sels = ['#CybotCookiebotDialog','.cookie','.cky-consent-bar',
    'div[class*="cookie"]',"button[aria-label*='Accept']"];
  for (const s of sels) {
    driver.executeScript(
      `document.querySelectorAll(arguments[0]).forEach(e => e.remove());`, s
    ).catch(() => {});
  }
}

module.exports = {
  takeDebugScreenshot, saveResults, saveProgress,
  loadProgress, loadExistingResults, clearProgress, removeOverlays, sendToSheets,
};
