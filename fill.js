// ════════════════════════════════════════════════════════════════════════════
// fill.js — Entry point / watcher that feeds URLs into main.js and keeps it running
//
// PURPOSE / ROLE IN THE PIPELINE:
//   This is the "outer loop" the README tells you to run with `node fill.js`.
//   It does NOT do any browser automation itself — instead it:
//     1. Watches digital_marketing_data.csv (produced by the Google Maps
//        scraper, unified_scraper.js) for new business website/contact-form
//        URLs that haven't been queued or already filled yet.
//     2. Appends any newly discovered URLs to retry_urls.txt (the file
//        main.js reads from).
//     3. Spawns `node main.js` as a child process whenever there's queued
//        work pending, and waits for it to exit before allowing another
//        spawn (main.js itself loops forever over retry_urls.txt until it
//        runs out of URLs, then idles — so in practice this spawns main.js
//        once and lets it run continuously, re-spawning only if it ever
//        exits with pending work still queued).
//     4. Also starts autopush.js in the background, which auto-commits/
//        pushes changes (e.g. results CSV) to git periodically.
//
// HOW IT WORKS (high level):
//   - On startup: spawn autopush.js (detached, unref'd — fire and forget),
//     ensure the form_results/ output directory exists, ensure
//     retry_urls.txt exists, then run tick() once immediately.
//   - tick() is then re-run every CHECK_INTERVAL (30s) via setInterval:
//       a. getNewUrls() re-parses digital_marketing_data.csv, picks the best
//          available URL column per row (contact form URL > actual website >
//          maps website, in that priority), and filters out anything that's
//          already been filled (per form_results/contact_results.csv) or
//          already queued (per retry_urls.txt), plus anything that isn't a
//          real http(s) URL or is a Google Maps link.
//       b. Any genuinely new URLs get appended to retry_urls.txt.
//       c. If there's any URL in retry_urls.txt that isn't yet in the
//          filled-results CSV, runFiller() spawns `node main.js` (unless
//          it's already running), which will pick up and process it.
//   - parseLine()/getFilledUrls() are small local CSV helpers (hand-rolled,
//     not using a CSV library) that handle quoted fields with embedded
//     commas.
//
// DEPENDENCIES / USED BY:
//   - Spawns/depends on: autopush.js (background git auto-push) and
//     main.js (the actual form-filling engine covered above).
//   - Reads: digital_marketing_data.csv (written by unified_scraper.js) and
//     form_results/contact_results.csv (written by result_tracker.js, via
//     main.js) to know what's already done.
//   - Writes: retry_urls.txt (consumed by main.js), form_results/ directory.
//   - This is the file a user runs directly (`node fill.js`) per the README.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Start autopush in background
// detached + unref so this child process survives independently and doesn't
// keep the Node event loop alive on its own — fill.js's own logic (the
// setInterval below) is what keeps the process running.
const autopush = spawn('node', ['autopush.js'], { cwd: __dirname, stdio: 'ignore', detached: true });
autopush.unref();
console.log('🔄 Autopush started\n');

const CSV_PATH  = path.join(__dirname, 'digital_marketing_data.csv'); // scraper output — source of candidate URLs
const URLS_FILE = path.join(__dirname, 'retry_urls.txt');             // queue file main.js consumes
const CHECK_INTERVAL = 30000; // check every 30 seconds

fs.mkdirSync(path.join(__dirname, 'form_results'), { recursive: true });

// Minimal hand-rolled CSV line parser (handles quoted fields containing
// commas). Not a full CSV/RFC4180 implementation, but sufficient for the
// simple export format this pipeline produces.
function parseLine(line) {
  const fields = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  fields.push(cur.trim());
  return fields.map(f => f.replace(/^"|"$/g, '').trim());
}

// Reads form_results/contact_results.csv and returns the set of URLs that
// already have a result recorded (success, failed, partial, etc.) — used to
// avoid re-queuing/re-processing URLs that have already been attempted.
function getFilledUrls() {
  const csv = path.join(__dirname, 'form_results', 'contact_results.csv');
  if (!fs.existsSync(csv)) return new Set();
  const filled = new Set();
  fs.readFileSync(csv, 'utf8').split('\n').filter(Boolean).slice(1).forEach(line => {
    const url = line.split(',')[0].replace(/^"|"$/g, '').trim();
    if (url) filled.add(url);
  });
  return filled;
}

// Scans the scraper's CSV output for URLs that haven't been queued or
// processed yet.
function getNewUrls() {
  if (!fs.existsSync(CSV_PATH)) return [];

  const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n').filter(Boolean);
  if (lines.length < 2) return []; // need at least a header + one data row

  // Locate the relevant columns by header keyword rather than fixed index,
  // since the scraper's CSV column order/naming could shift.
  const headers = parseLine(lines[0]).map(h => h.toLowerCase());
  const cfIdx = headers.findIndex(h => h.includes('contact form'));
  const awIdx = headers.findIndex(h => h.includes('actual website'));
  const mwIdx = headers.findIndex(h => h.includes('maps website'));

  const filled = getFilledUrls();
  const queued = new Set(
    fs.existsSync(URLS_FILE)
      ? fs.readFileSync(URLS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
      : []
  );
  // Union of already-filled and already-queued URLs — anything in `seen`
  // should not be added to the queue again.
  const seen = new Set([...filled, ...queued]);

  const newUrls = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    // Prefer the dedicated "contact form" URL if the scraper found one,
    // otherwise fall back to the business's actual website, otherwise the
    // raw Google Maps-listed website field.
    const url  = (cfIdx >= 0 && cols[cfIdx]) ? cols[cfIdx]
               : (awIdx >= 0 && cols[awIdx]) ? cols[awIdx]
               : (mwIdx >= 0 && cols[mwIdx]) ? cols[mwIdx]
               : '';
    // Only accept real http(s) URLs, skip raw Google Maps links (those
    // aren't a business's own website / contact form), and skip dupes.
    if (url && /^https?:\/\//i.test(url) && !url.includes('google.com/maps') && !seen.has(url)) {
      seen.add(url);
      newUrls.push(url);
    }
  }
  return newUrls;
}

// Guard flag so tick() never spawns a second concurrent main.js while one
// is already running.
let fillerRunning = false;

function runFiller() {
  if (fillerRunning) return;
  fillerRunning = true;
  console.log('\n🚀 Starting Contact Form Filler...\n');
  // stdio: 'inherit' so main.js's console output streams directly to this
  // process's terminal — useful since main.js normally runs indefinitely.
  const child = spawn('node', ['main.js'], { cwd: __dirname, stdio: 'inherit' });
  child.on('exit', () => {
    fillerRunning = false;
    console.log('\n⏳ Filler done — watching for new URLs...');
  });
}

// The periodic watcher step: pull in any new URLs from the scraper's CSV,
// append them to the queue file, and (re)start the filler if there's work
// to do.
function tick() {
  const newUrls = getNewUrls();
  if (newUrls.length) {
    fs.appendFileSync(URLS_FILE, newUrls.join('\n') + '\n', 'utf8');
    console.log(`\n➕ ${newUrls.length} new URLs added to queue`);
  }
  // Start filler if there are pending URLs (new or existing)
  const pending = fs.existsSync(URLS_FILE)
    ? fs.readFileSync(URLS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    : [];
  const filled = getFilledUrls();
  const hasPending = pending.some(u => !filled.has(u));
  if (hasPending) {
    runFiller();
  } else {
    process.stdout.write('.'); // heartbeat so it's visible the watcher is alive while idle
  }
}

// Initial run
console.log('👀 Watching for URLs... (Ctrl+C to stop)\n');
if (!fs.existsSync(URLS_FILE)) fs.writeFileSync(URLS_FILE, '', 'utf8');
tick();
setInterval(tick, CHECK_INTERVAL);
