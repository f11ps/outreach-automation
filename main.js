// ════════════════════════════════════════════════════════════════════════════
// main.js — Core contact-form-filling engine (the heart of the pipeline)
//
// PURPOSE / ROLE IN THE PIPELINE:
//   This is the module that actually does the work described in the README:
//   for every URL in retry_urls.txt (config.URL_FILE), it opens the site in
//   a real Chrome browser (via Selenium/driver_setup.js), finds the contact
//   page, finds the contact form on that page, fills it in with a rotating
//   sender identity (config.js), solves any CAPTCHA it encounters
//   (captcha/handler.js), submits the form, verifies success, and logs a
//   result row to CSV (result_tracker.js). It runs forever, re-reading the
//   URL file on every loop iteration so it can pick up URLs that fill.js /
//   the scraper appends while it's running.
//
// HOW IT WORKS (high level):
//   1. Load the URL list from disk; bail out if the file is missing.
//   2. Resume support: read the last saved progress index (result_tracker.js)
//      so a restart doesn't reprocess URLs that were already handled.
//   3. Helper functions:
//        - waitReady(driver)   → polls document.readyState until 'complete'
//                                  (or times out), so we don't start
//                                  interacting with a half-rendered page.
//        - clearOverlays(driver) → hides cookie/GDPR/consent/popup modals
//                                  that would otherwise block clicks.
//        - processUrl(driver, url, record, contact) → the per-URL pipeline:
//              load page → wait for JS render → find contact page →
//              find contact form → scroll it into view → fill fields →
//              retry filling if critical fields (name/email) are missing →
//              check consent checkboxes → solve any pre-submit CAPTCHA →
//              submit → solve any post-submit CAPTCHA (and resubmit if one
//              appeared) → detect success/partial/failure and record it.
//   4. The main IIFE at the bottom runs an infinite loop over URL indices:
//        - re-reads the URL file every iteration (so newly appended URLs
//          are picked up without restarting the process)
//        - if there's nothing new yet, prints a "." and waits 5s
//        - otherwise spins up a fresh browser (makeDriver), rotates to the
//          next sender identity (getNextContact), and calls processUrl
//        - wraps processUrl in try/catch to classify errors (network error
//          vs timeout vs unexpected exception) without crashing the loop
//        - retries a URL with a brand-new browser instance if CAPTCHA
//          solving failed, up to MAX_CAPTCHA_RETRIES times
//        - appends the result row, persists it to CSV, and saves the resume
//          checkpoint after each URL is fully processed (success or not)
//
// DEPENDENCIES / USED BY:
//   - Depends on: config.js (constants + contact rotation), driver_setup.js
//     (Selenium browser factory), navigator.js (findContactPage),
//     form_finder.js (findContactForm), fields.js (fillAllFields,
//     checkCheckboxes), captcha/handler.js (handleCaptcha), submitter.js
//     (submitForm, detectSuccess), form_types.js (removeBlockers, imported
//     but not directly called in this file), result_tracker.js
//     (screenshots, CSV/progress persistence).
//   - Used by: fill.js, which spawns `node main.js` as a child process
//     whenever there are pending URLs to fill, and by run.js indirectly
//     through the same watch loop.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');

const { getNextContact, URL_FILE, OUTPUT_DIR, CSV_FIELDS,
        CAPTCHA_WAIT_TIMEOUT, MAX_CAPTCHA_RETRIES }  = require('./config');
const { makeDriver }                                  = require('./driver_setup');
const { findContactPage }                             = require('./navigator');
const { findContactForm }                             = require('./form_finder');
const { fillAllFields, checkCheckboxes }              = require('./fields');
const { handleCaptcha }                               = require('./captcha/handler');
const { submitForm, detectSuccess }                   = require('./submitter');
const { removeBlockers }                              = require('./form_types');
const { takeDebugScreenshot, saveResults, saveProgress,
        loadProgress, loadExistingResults, clearProgress } = require('./result_tracker');

// Small utility helpers used throughout: sleep() for pacing/anti-bot delays,
// rand() to produce a randomized delay window so timing doesn't look
// robotic/scripted to the target site.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => Math.random() * (b - a) + a;

// ── Load URLs ─────────────────────────────────────────────────────────────────
// Fail fast if the input file doesn't exist — nothing to do without it.
if (!fs.existsSync(URL_FILE)) { console.log(`⚠️ ${URL_FILE} not found!`); process.exit(1); }
const urls = fs.readFileSync(URL_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
console.log(`🧩 Loaded ${urls.length} URLs`);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Resume support: if a previous run was interrupted, progress.txt records how
// far it got, so we don't reprocess/duplicate work.
const startIndex = loadProgress();
if (startIndex) console.log(`▶️  Resuming from URL #${startIndex + 1}`);
const results = [];

// ── Wait for page to be fully ready ──────────────────────────────────────────
// Polls document.readyState instead of relying purely on Selenium's own
// page-load wait, because many sites keep loading JS/XHR content well after
// the initial navigation event fires. Times out after `ms` so a page stuck
// mid-load doesn't hang the whole pipeline.
async function waitReady(driver, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await driver.executeScript('return document.readyState') === 'complete') break; }
    catch (_) {}
    await sleep(250);
  }
}

// ── Remove cookie/popup overlays ──────────────────────────────────────────────
// Cookie/consent/GDPR banners and modal popups commonly sit on top of the
// contact form and intercept clicks, so this injects a script that finds
// likely overlay elements (by class/id keyword match) and force-hides any
// that are fixed/absolute positioned. Wrapped in try/catch because
// executeScript can fail on some pages (e.g. strict CSP) and that's fine to
// ignore — it's a best-effort cleanup, not a required step.
async function clearOverlays(driver) {
  try {
    await driver.executeScript(`
      ['[class*="cookie"]','[class*="gdpr"]','[class*="consent"]','[class*="popup"]',
       '[class*="modal"][style*="display: block"]','[id*="cookie"]','[id*="popup"]',
       '#CybotCookiebotDialog','#onetrust-banner-sdk','.cc-window','.pum-overlay']
      .forEach(function(s){
        document.querySelectorAll(s).forEach(function(el){
          var st = window.getComputedStyle(el);
          if(st.position==='fixed'||st.position==='absolute') el.style.display='none';
        });
      });
      document.body.style.overflow='auto';
    `);
  } catch (_) {}
}

// ── Process one URL ───────────────────────────────────────────────────────────
// The full per-URL pipeline. Mutates `record` (the CSV row being built) in
// place as it progresses through each stage, so partial progress is still
// captured even if a later stage fails/throws.
async function processUrl(driver, url, record, contact) {
  // Load page
  const t0 = Date.now();
  await driver.get(url);
  const loadTime = (Date.now() - t0) / 1000;
  record.load_status = 'Loaded';
  record.load_time_s = loadTime.toFixed(1);

  // Sites that take too long to load are treated as skipped rather than
  // burning time waiting on them — 20s is considered abnormally slow.
  if (loadTime > 20) {
    record.status = 'Skipped'; record.details = `Slow: ${loadTime.toFixed(1)}s`;
    record.load_status = 'Slow'; return;
  }

  // Wait for JS render
  await waitReady(driver, 8000);
  await sleep(rand(2000, 3500)); // extra randomized settle time for late-rendering widgets (forms, chat bots, etc.)
  await clearOverlays(driver);

  // Step 1: Find contact page
  // navigator.js will try to navigate from the current page to whatever it
  // thinks is the contact page (nav links, common paths, sitemap, etc.).
  const onContact = await findContactPage(driver);
  record.contact_page_status = onContact ? 'Opened' : 'Not found';
  await clearOverlays(driver); // navigating may have triggered a new cookie banner

  // Step 2: Find form
  const form = await findContactForm(driver);
  if (!form) {
    record.details = 'No contact form detected';
    record.form_status = 'Not found';
    console.log('   ❌ No contact form found');
    return;
  }
  record.form_status = 'Found';

  // Step 3: Scroll form into view
  // Some sites only fully render/activate form widgets (e.g. lazy-loaded
  // fields, JS-bound validators) once they're scrolled into the viewport.
  try { await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', form); }
  catch (_) {}
  await sleep(rand(1200, 2000));

  // Step 4: Fill all fields
  console.log('   📝 Filling form fields...');
  const usedFields = new Set(); // tracks which form elements have already been claimed, to avoid double-filling
  const filled = [], failed = [];
  await fillAllFields(driver, form, contact, usedFields, filled, failed);

  // Retry if critical fields missing
  // If neither a name field nor the email field got filled, the first pass
  // may have missed fields that were below the fold / not yet visible.
  // Scroll further down and try again once before giving up on those fields.
  if (!['full_name','first_name','email'].some(f => filled.includes(f))) {
    console.log('   🔄 Critical fields missing — retrying after scroll...');
    try { await driver.executeScript('window.scrollTo(0, document.body.scrollHeight * 0.4);'); }
    catch (_) {}
    await sleep(rand(800, 1500));
    const rf = [], rfa = [];
    await fillAllFields(driver, form, contact, usedFields, rf, rfa);
    if (rf.length) { filled.push(...rf); console.log(`   ✅ Retry: ${rf.join(', ')}`); }
  }

  console.log(`   ✅ Filled ${filled.length}: [${filled.join(', ')}]`);
  if (failed.length) console.log(`   ℹ️  Not found: [${failed.join(', ')}]`);

  record.fields_filled = String(filled.length);
  record.filled_fields = filled.join(',');
  record.failed_fields = failed.join(',');

  // If nothing at all got filled, there's no point continuing to
  // checkboxes/captcha/submit — record the failure and stop here.
  if (!filled.length) {
    record.details = 'No form fields detected'; return;
  }

  // Step 5: Check checkboxes (terms/consent)
  // Many forms require a "I agree to terms" / consent checkbox to be ticked
  // before submission will succeed.
  await checkCheckboxes(driver, form);
  await sleep(rand(1500, 2500));

  // Step 6: Handle CAPTCHA
  // Attempt to solve any CAPTCHA present before submitting. If the captcha
  // handler reports the page is 'blocked' or wants a 'retry' (e.g. it
  // couldn't be solved), bail out of this attempt early — the outer loop in
  // the IIFE below decides whether to retry with a fresh browser.
  const captchaResult = await handleCaptcha(driver, record, 'pre-submit', form, CAPTCHA_WAIT_TIMEOUT);
  if (captchaResult === 'blocked' || captchaResult === 'retry') return;
  if (!record.captcha_status) record.captcha_status = 'Not present';

  // Step 7: Submit
  await sleep(rand(1000, 2000));
  const [submitted, lastError] = await submitForm(driver, form, record);

  // Wait for page to respond after submit (thank you, redirect, etc.)
  await sleep(rand(2000, 3000));

  // Step 8: Handle post-submit CAPTCHA (some sites show captcha after submit)
  // Some forms only reveal a CAPTCHA challenge *after* the first submit
  // attempt. If one appeared and got solved, the original submission likely
  // didn't go through, so resubmit now that the CAPTCHA is cleared.
  const postCaptcha = await handleCaptcha(driver, record, 'post-submit', form, CAPTCHA_WAIT_TIMEOUT);
  if (postCaptcha === 'clear' && record.captcha_status && record.captcha_status.includes('post-submit')) {
    // Captcha was present and solved — submit again
    console.log('   🔄 Post-submit captcha solved — resubmitting...');
    await sleep(rand(1000, 2000));
    await submitForm(driver, form, record);
    await sleep(rand(2000, 3000));
  }

  await sleep(rand(1000, 2000));

  // Determine final outcome. There are two branches depending on whether
  // submitForm() thinks it actually clicked/triggered a submit:
  //   - if submitted: check for a success signal (thank-you page/redirect).
  //     Mark 'Success' only if both email and name were filled (otherwise
  //     the lead data would be incomplete even though the form "worked"),
  //     else 'Partial'.
  //   - if not submitted: still check for a success signal in case the site
  //     submitted via some mechanism we didn't detect (e.g. Enter key
  //     triggered submission); otherwise record the submit failure reason.
  if (submitted) {
    console.log('   • Checking submission result...');
    if (await detectSuccess(driver)) {
      const emailFilled = filled.includes('email');
      const nameFilled  = filled.includes('full_name') || filled.includes('first_name');
      const isComplete  = emailFilled && nameFilled;
      record.status  = isComplete ? 'Success' : 'Partial';
      record.details = isComplete
        ? 'Verified thank-you / redirect'
        : `Submitted but missing: ${!emailFilled?'email ':''} ${!nameFilled?'name':''}`.trim();
      record.success_status = 'Success detected';
      console.log(isComplete ? '   ✅ Form submitted successfully!' : `   ⚠️ Partial: ${record.details}`);
    } else {
      record.details = 'Submitted but no confirmation detected';
      record.success_status = 'No confirmation';
      takeDebugScreenshot(driver, 'no_confirm'); // capture the page for manual debugging of why no confirmation showed
    }
  } else {
    if (await detectSuccess(driver)) {
      record.status = 'Success';
      record.details = 'Success detected (submit not tracked)';
      record.success_status = 'Success detected';
    } else {
      record.details = `Submit failed: ${lastError || 'No button found'}`;
      record.success_status = 'No success detected';
      takeDebugScreenshot(driver, 'no_submit'); // capture the page for manual debugging of why submit failed
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
// Runs forever. This is what lets fill.js/main.js act as a "watcher" process:
// as long as it's running, any URL appended to retry_urls.txt will
// eventually get picked up without needing to restart the process.
(async () => {
  let idx = startIndex;

  while (true) {
    // Reload URLs from file on every iteration to pick up newly added URLs
    const allUrls = fs.existsSync(URL_FILE)
      ? fs.readFileSync(URL_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
      : [];

    if (idx >= allUrls.length) {
      // No more URLs — wait for new ones
      process.stdout.write('.');
      await sleep(5000);
      continue;
    }

    const url = allUrls[idx];
    console.log(`\n🟢 [${idx+1}/${allUrls.length}] ${url}`);

    // Attempt loop: normally runs once, but if CAPTCHA solving fails it will
    // retry the same URL (with a brand-new browser instance and a freshly
    // rotated contact identity) up to MAX_CAPTCHA_RETRIES extra times.
    for (let attempt = 1; attempt <= MAX_CAPTCHA_RETRIES + 1; attempt++) {
      // Build a blank CSV record for this attempt, pre-populated with all
      // expected columns (from config.CSV_FIELDS) so saveResults() always
      // writes a consistent row shape.
      const record = Object.fromEntries(CSV_FIELDS.map(f => [f, '']));
      record.url    = url;
      record.status = 'Failed';

      const contact = getNextContact();
      console.log(`   👤 ${contact.full_name} <${contact.email}>`);

      // Fresh Chrome instance per attempt — avoids carrying over cookies/
      // state/detection flags from a previous failed attempt.
      const driver = await makeDriver();

      try {
        await processUrl(driver, url, record, contact);
      } catch (e) {
        // Classify the failure so the CSV/log is useful for later triage:
        // network-level errors and page-load timeouts are expected/common
        // and get a lighter-weight "Skipped" status, while anything else is
        // an unexpected error worth a debug screenshot.
        const msg = e.message || '';
        const isNetwork = ['ERR_NAME_NOT_RESOLVED','ERR_CONNECTION_REFUSED',
          'ERR_CONNECTION_TIMED_OUT','ERR_INTERNET_DISCONNECTED',
          'ERR_ADDRESS_UNREACHABLE','net::ERR_'].some(x => msg.includes(x));
        const isTimeout = msg.includes('timeout') || msg.toLowerCase().includes('page load');

        if (isNetwork) {
          console.log(`   ⏭️ Network error — skipping`);
          record.status = 'Skipped'; record.details = msg.slice(0, 150);
          record.load_status = 'NetworkError';
        } else if (isTimeout) {
          console.log('   ⏭️ Page load timeout');
          record.status = 'Skipped'; record.details = 'Page load timeout';
          record.load_status = 'Timeout';
          try { await driver.executeScript('window.stop();'); } catch (_) {} // stop any in-flight navigation before quitting the driver
        } else {
          console.log(`   ❌ ${e.constructor.name}: ${msg.slice(0, 150)}`);
          record.details = `${e.constructor.name}: ${msg.slice(0, 150)}`;
          takeDebugScreenshot(driver, 'error');
        }
      } finally {
        // Always tear down the browser, even on success, to avoid leaking
        // Chrome processes across thousands of URLs.
        try { await driver.quit(); } catch (_) {}
      }

      // CAPTCHA retry with fresh Chrome
      // If the captcha_status field indicates the captcha wasn't solved (or
      // explicitly asked for a retry), and we haven't exhausted our retry
      // budget, loop back to the top of the attempt loop with a brand-new
      // browser/session rather than accepting the failure immediately.
      const captchaFailed = (record.captcha_status || '').includes('Not solved') ||
                            (record.captcha_status || '').toLowerCase().includes('retry');
      if (captchaFailed && attempt <= MAX_CAPTCHA_RETRIES) {
        console.log(`   🔄 CAPTCHA retry ${attempt}/${MAX_CAPTCHA_RETRIES}...`);
        await sleep(rand(2000, 3500));
        continue;
      }

      // Final outcome for this URL (whether success, partial, or exhausted
      // retries) — persist immediately so progress isn't lost if the process
      // is killed before finishing the whole URL list.
      results.push(record);
      saveResults(results);
      saveProgress(idx + 1);
      await sleep(rand(3000, 6000)); // pace requests between different target sites
      break;
    }

    idx++;
  }

  // Unreachable in practice (the while(true) loop never breaks), but kept as
  // a defensive final flush/cleanup in case the loop is ever changed to exit.
  saveResults(results);
  clearProgress();
  console.log(`\n🏁 Done! → ${require('./config').CSV_PATH}`);
})();
