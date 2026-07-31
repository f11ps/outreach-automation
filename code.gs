// ════════════════════════════════════════════════════════════════════════════
// code.gs — Google Apps Script Web App: live data sink for the pipeline.
//
// PURPOSE / ROLE IN THE PIPELINE:
//   This script is NOT run as part of the Node.js/Python pipeline directly
//   — per the README, a user pastes this into a Google Sheet's
//   Extensions -> Apps Script editor and deploys it as a Web App (Anyone
//   can access). Once deployed, its Web App URL is pasted into
//   unified_scraper.js and result_tracker.js, which then POST JSON batches
//   of rows to it in real time. It acts purely as a thin HTTP-to-Spreadsheet
//   bridge: receive rows, append them to the right sheet/tab, add a
//   timestamp if missing, and (for contact-form results) color the row by
//   status — turning the raw pipeline output into a live-updating,
//   human-browsable Google Sheet without either Node script needing direct
//   Sheets API credentials.
//
// HOW IT WORKS (high level):
//   - Two logical "tables" live in the same spreadsheet as two tabs:
//       MapData   — Google Maps scraped business rows (from
//                   unified_scraper.js), 15 columns per MAP_HEADERS.
//       CFResults — contact-form fill-attempt results (from
//                   result_tracker.js), 15 columns per CF_HEADERS.
//   - `getOrCreateSheet(name, headers)` lazily creates a tab with a styled
//     bold blue header row (and freezes it) the first time data for that
//     tab arrives, otherwise reuses the existing tab.
//   - `doPost(e)` is the Apps Script entry point Google automatically
//     invokes for every HTTP POST to the deployed Web App URL. It parses
//     the JSON body, looks at a `type` field ('map' or 'cf', defaulting to
//     'map' if absent) to decide which handler processes the request, and
//     always returns a JSON response via `respond()`.
//   - `handleMapData(body)` appends `body.rows` (array of row-arrays) to
//     the MapData sheet, filling in column index 14 (the Timestamp column,
//     0-indexed) with the current time if the caller didn't supply one.
//   - `handleCFData(body)` does the same for the CFResults sheet, but also
//     colors each newly-inserted row's background based on its Status
//     column (index 1): green for "success", yellow for "skipped", and a
//     peachy/red tone for anything else (failed/partial/etc).
//   - `doGet()` is the entry point for plain HTTP GET requests to the same
//     Web App URL — it returns a small JSON summary (row counts for both
//     sheets, plus a success/failed/skipped breakdown for CFResults) that
//     can be used as a lightweight status/health check endpoint, e.g. to
//     glance at overall progress without opening the spreadsheet.
//   - `respond(obj)` is a shared helper that serializes any object to JSON
//     and sets the Apps Script ContentService MIME type to `application/json`
//     for both doGet and doPost responses.
//
// ENDPOINTS EXPOSED (once deployed as a Web App):
//   POST <web-app-url>   body: {"type":"map","rows":[[...],...]}   -> appends to MapData
//   POST <web-app-url>   body: {"type":"cf", "rows":[[...],...]}   -> appends to CFResults, colored by status
//   GET  <web-app-url>                                              -> JSON stats summary of both sheets
//
// HOW / BY WHAT IT'S INVOKED:
//   - It is deployed inside Google's infrastructure (Apps Script bound to
//     a specific Google Sheet), not run locally — there's no local
//     "server process" for this file the way there is for the Python
//     scripts in this repo.
//   - unified_scraper.js POSTs scraped Google Maps rows here with
//     `type: 'map'` as it scrapes each business.
//   - result_tracker.js POSTs contact-form fill outcomes here with
//     `type: 'cf'` as each URL finishes processing.
//   - Both callers need the deployed Web App URL hardcoded/configured on
//     their side (README: "Copy the Web App URL into unified_scraper.js
//     and result_tracker.js").
//
// SETUP / DEPENDENCY NOTES:
//   - No external dependencies — runs entirely on Google's Apps Script
//     runtime using only built-in `SpreadsheetApp` and `ContentService`
//     services.
//   - Must be deployed as a Web App (Deploy > New deployment > Web app)
//     with access set to "Anyone" (or "Anyone with the link") so the
//     unauthenticated POST/GET requests from unified_scraper.js and
//     result_tracker.js succeed; otherwise Google will reject the calls
//     with a login/permission page instead of running doPost/doGet.
//   - The row *order* sent by the Node side must match MAP_HEADERS /
//     CF_HEADERS column order exactly, since rows are inserted positionally
//     (there's no field-name-based mapping) and column index 14 is
//     specifically read/written as the Timestamp column by both handlers.
// ════════════════════════════════════════════════════════════════════════════

// Google Apps Script
// Sheet 1: "MapData"     — Google Maps scraped business data
// Sheet 2: "CFResults"   — Contact form fill results

const MAP_SHEET = 'MapData';
const CF_SHEET  = 'CFResults';

// Column headers for the MapData tab — order must match the row arrays
// unified_scraper.js sends in its POST body.
const MAP_HEADERS = [
  'Index','Area','Keyword','Name','Rating','Reviews',
  'Address','Phone','Maps Website','Actual Website',
  'Contact Form URL','Maps URL','All Emails','Email Count','Timestamp'
];

// Column headers for the CFResults tab — order must match the row arrays
// result_tracker.js sends in its POST body.
const CF_HEADERS = [
  'URL','Status','Details','Load Status','Load Time(s)',
  'Contact Page','Form Status','Fields Filled',
  'Filled Fields','Failed Fields',
  'Validation','Captcha','Submit','Success','Timestamp'
];

// ── Sheet setup ───────────────────────────────────────────────────────────────
// Returns the existing sheet/tab by name, or creates it (with a styled,
// frozen header row) the first time it's needed. Called lazily from both
// data handlers rather than at script load time, since Apps Script has no
// persistent "startup" — every request re-runs the whole script top-level
// (constants only) before invoking doGet/doPost.
function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#4a86e8')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ── POST handler ──────────────────────────────────────────────────────────────
// Apps Script's special reserved function name — automatically invoked by
// Google's infrastructure whenever an HTTP POST hits the deployed Web App
// URL. `e.postData.contents` is the raw request body string.
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents)
      return respond({ success: false, error: 'NO_DATA' });

    const body = JSON.parse(e.postData.contents);
    const type = body.type || 'map';

    // Route to the map-data handler or contact-form-results handler based
    // on the caller-supplied `type` field; anything else is rejected.
    if (type === 'map') return handleMapData(body);
    if (type === 'cf')  return handleCFData(body);
    return respond({ success: false, error: 'UNKNOWN_TYPE' });

  } catch (err) {
    return respond({ success: false, error: err.message });
  }
}

// ── Map data handler ──────────────────────────────────────────────────────────
// Appends Google Maps scrape rows (from unified_scraper.js) to the MapData
// tab, batch-inserting all rows from a single request in one setValues call.
function handleMapData(body) {
  if (!body.rows || !Array.isArray(body.rows))
    return respond({ success: false, error: 'INVALID_ROWS' });

  const sheet = getOrCreateSheet(MAP_SHEET, MAP_HEADERS);
  const rows  = body.rows.map(r => {
    const row = [...r];
    // Column 14 (0-indexed) is Timestamp — fill it in server-side if the
    // caller didn't already provide one.
    if (!row[14]) row[14] = new Date().toISOString();
    return row;
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, MAP_HEADERS.length)
       .setValues(rows);

  return respond({ success: true, inserted: rows.length, sheet: MAP_SHEET });
}

// ── CF results handler ────────────────────────────────────────────────────────
// Appends contact-form fill results (from result_tracker.js) to the
// CFResults tab, then color-codes each inserted row by its Status column
// so success/failure/skipped rows are visually distinguishable at a glance
// when browsing the sheet.
function handleCFData(body) {
  if (!body.rows || !Array.isArray(body.rows))
    return respond({ success: false, error: 'INVALID_ROWS' });

  const sheet = getOrCreateSheet(CF_SHEET, CF_HEADERS);
  const rows  = body.rows.map(r => {
    const row = [...r];
    // Column 14 (0-indexed) is Timestamp — fill it in server-side if the
    // caller didn't already provide one.
    if (!row[14]) row[14] = new Date().toISOString();
    // Color row by status
    return row;
  });

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, CF_HEADERS.length).setValues(rows);

  // Color by status
  // Column 1 (0-indexed) is Status. Green = success, yellow = skipped,
  // peach/red = anything else (failed, partial, error, etc).
  rows.forEach((row, i) => {
    const status = (row[1] || '').toLowerCase();
    const color  = status === 'success' ? '#d9ead3'
                 : status === 'skipped' ? '#fff2cc'
                 : '#fce5cd';
    sheet.getRange(startRow + i, 1, 1, CF_HEADERS.length).setBackground(color);
  });

  return respond({ success: true, inserted: rows.length, sheet: CF_SHEET });
}

// ── GET handler (stats) ───────────────────────────────────────────────────────
// Apps Script's reserved function name for HTTP GET requests to the
// deployed Web App URL. Provides a lightweight JSON "dashboard" of both
// sheets' row counts and a success/failed/skipped breakdown for
// CFResults, without needing to open the spreadsheet UI.
function doGet() {
  try {
    const ss      = SpreadsheetApp.getActive();
    const mapSh   = ss.getSheetByName(MAP_SHEET);
    const cfSh    = ss.getSheetByName(CF_SHEET);
    // Subtract 1 to exclude the header row from the count (never negative).
    const mapRows = mapSh ? Math.max(0, mapSh.getLastRow() - 1) : 0;
    const cfRows  = cfSh  ? Math.max(0, cfSh.getLastRow()  - 1) : 0;

    let success = 0, failed = 0, skipped = 0;
    if (cfSh && cfRows > 0) {
      // Read just the Status column (column 2, 1-indexed) for every data
      // row and tally outcomes.
      const data = cfSh.getRange(2, 2, cfRows, 1).getValues();
      data.forEach(([s]) => {
        const st = (s || '').toLowerCase();
        if (st === 'success') success++;
        else if (st === 'skipped') skipped++;
        else failed++;
      });
    }

    return respond({
      status: 'OK',
      mapData:    { total: mapRows },
      cfResults:  { total: cfRows, success, failed, skipped },
      timestamp:  new Date().toISOString()
    });
  } catch (err) {
    return respond({ status: 'ERROR', error: err.message });
  }
}

// Shared response helper — serializes any object as a JSON HTTP response,
// used by both doGet and doPost (and their handler functions) as the
// single point where the ContentService output is constructed.
function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
