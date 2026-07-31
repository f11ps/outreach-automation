// ════════════════════════════════════════════════════════════════════════════
// captcha/hcaptcha.js — hCaptcha solver
//
// PURPOSE / ROLE IN THE PIPELINE:
//   This module is the hCaptcha handler used by captcha/handler.js when it
//   detects an hCaptcha widget on a contact-form page. Its job is to make
//   the widget's hidden `h-captcha-response` field contain a valid token so
//   the surrounding form can be submitted successfully.
//
// HOW IT WORKS (high level):
//   The file actually contains the remnants of TWO different solving
//   strategies, but only ONE of them is wired up to the exported function:
//
//   1. "CNN tile-clicking" strategy (DEFINED BUT NOT CALLED — dead code):
//        A large set of helpers (findAnchorIframe, clickCheckbox,
//        findChallengeIframe, getTaskLabel, getTileImages, getTileElements,
//        clickTile, clickVerify, waitForChallenge, isChallengeRefreshed,
//        isHcaptchaSolved, cnnClassify) implement a classic "click the
//        checkbox inside Selenium, read the image grid, classify each tile
//        with a Python CNN (hcaptcha_cnn_solver.py), click the matching
//        tiles, click Verify, repeat" flow. This is the flow described by
//        the file's original top-of-file summary comment below, and it is
//        fully implemented — but `solveHcaptcha()` (the only exported
//        function) never calls any of these helpers. They are left in the
//        file, unused, likely superseded by strategy 2.
//
//   2. "SeleniumBase CDP" strategy (ACTUALLY USED):
//        `solveHcaptcha(driver)` — the exported entry point — does NOT
//        drive the hCaptcha widget itself. Instead it:
//          a. Reads the current page URL from the (Selenium) `driver`.
//          b. Spawns/reuses a persistent Python child process running
//             hcaptcha_sb_solver.py (via getSbProc/sbSolve), which opens
//             its OWN separate browser instance using the `seleniumbase`
//             library's CDP mode (Chrome DevTools Protocol clicks, which
//             have `isTrusted = true` and are much harder for hCaptcha's
//             bot-detection to distinguish from a real user).
//          c. Sends the page URL to that Python process over stdin and
//             waits (up to 120s) for it to write a solved response token
//             back on stdout.
//          d. Injects that token string into the ORIGINAL page's
//             `h-captcha-response` textarea/input (the one Selenium/driver
//             is actually looking at) via `executeScript`, dispatching
//             `input`/`change` events so the site's own JS notices the
//             value changed.
//        In other words: the actual solving/clicking happens in a
//        headless-ish side browser driven entirely by Python; this file's
//        job on the Node side is just to hand off the URL and splice the
//        resulting token back into the page the Node/Selenium `driver` is
//        controlling.
//
// DEPENDENCIES / USED BY:
//   - Depends on `selenium-webdriver` (By) for locating iframes/elements
//     when the (unused) CNN strategy helpers run — and used directly by
//     `solveHcaptcha()` only for `driver.getCurrentUrl()` / `executeScript()`.
//   - Spawns TWO separate persistent Python child processes via
//     `child_process.spawn`, communicating over stdin/stdout as
//     line-delimited JSON / plain text:
//       • hcaptcha_cnn_solver.py — CNN tile classifier (spawned lazily by
//         `getPyProc()`/`cnnClassify()`, but those are unused by the
//         active code path — effectively dormant unless some other part
//         of the codebase starts calling `cnnClassify`).
//       • hcaptcha_sb_solver.py — SeleniumBase CDP solver (spawned by
//         `getSbProc()`/`sbSolve()`), the one actually driving
//         `solveHcaptcha()`. Protocol: write a URL + newline to stdin,
//         read one line of output (the token, or empty string on failure)
//         from stdout.
//   - Both Python processes are launched with the `python3` interpreter
//     found at `process.env.PYTHON || '/usr/bin/python3'`.
//   - Exported `solveHcaptcha` is called by captcha/handler.js (the
//     dispatcher that decides which captcha solver module to invoke for
//     a given page).
// ════════════════════════════════════════════════════════════════════════════

// captcha/hcaptcha.js
// hCaptcha solver — Node.js side.
// Spawns hcaptcha_solver.py (CNN) as a persistent child process,
// then drives the hCaptcha widget via Selenium:
//   1. Detect & click the hCaptcha checkbox
//   2. Wait for image challenge to appear
//   3. Read task label + fetch all tile images
//   4. Send to Python CNN → get matching tile indices
//   5. Click matching tiles → click Verify
//   6. Repeat for new challenges (up to MAX_ROUNDS)
'use strict';

const { By }    = require('selenium-webdriver');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

// ── Python CNN process (singleton) ───────────────────────────────────────────
// NOTE: This whole section (getPyProc/waitPyReady/cnnClassify) implements the
// "send tile images to a Python CNN classifier" strategy. It is fully wired
// up and functional, but as of this version of the file it is never called
// by solveHcaptcha() below — see the file-level banner comment for details.
let _pyProc   = null;
let _pyReady  = false;
let _pendingResolvers = [];   // queue of {resolve, reject, timer} — one entry
                               // per in-flight classify() request, matched to
                               // the Python process's stdout lines in FIFO order

const PYTHON     = process.env.PYTHON || '/usr/bin/python3';
const SOLVER_PY  = path.join(__dirname, '..', 'hcaptcha_cnn_solver.py');
const MAX_ROUNDS = 12;  // max challenge rounds (includes reloads for unsolvable types)

// Lazily spawn (or return the existing) persistent Python CNN solver process.
// Only one instance is kept alive at a time (singleton pattern via module-level
// _pyProc) so the (relatively expensive) model load only happens once.
function getPyProc() {
  if (_pyProc && !_pyProc.killed) return _pyProc;

  console.log('      🔄 Starting hCaptcha CNN solver...');
  _pyProc  = spawn(PYTHON, [SOLVER_PY], { stdio: ['pipe', 'pipe', 'pipe'] });
  _pyReady = false;

  let _lineBuf = '';

  // stdout protocol: line-delimited JSON, one line per classify() response.
  // Because stdout can deliver partial lines across multiple 'data' events,
  // we buffer into _lineBuf and only process fully-terminated lines.
  _pyProc.stdout.on('data', chunk => {
    _lineBuf += chunk.toString();
    const lines = _lineBuf.split('\n');
    _lineBuf = lines.pop();                 // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Responses are matched to requests strictly in the order they were
      // sent (FIFO queue), since the Python side processes one at a time.
      const resolver = _pendingResolvers.shift();
      if (resolver) {
        clearTimeout(resolver.timer);
        try {
          resolver.resolve(JSON.parse(trimmed));
        } catch (e) {
          resolver.reject(new Error(`Bad JSON: ${trimmed.slice(0, 80)}`));
        }
      }
    }
  });

  // stderr is used for status/log messages from the Python process, not data.
  // We watch for a "ready" marker to know when the model has finished loading.
  _pyProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg.includes('solver ready') || msg.includes('Prototypes ready')) {
      _pyReady = true;
    }
    // Only print important lines to avoid noise
    if (msg.includes('✅') || msg.includes('❌') || msg.includes('🎯') ||
        msg.includes('Selected') || msg.includes('error')) {
      console.log(`      [hcaptcha-cnn] ${msg}`);
    }
  });

  // If the Python process dies, reset state and fail any in-flight requests
  // so callers don't hang forever waiting on a resolver that will never fire.
  _pyProc.on('exit', () => {
    _pyProc  = null;
    _pyReady = false;
    // Reject all pending
    for (const r of _pendingResolvers) {
      clearTimeout(r.timer);
      r.reject(new Error('CNN process exited'));
    }
    _pendingResolvers = [];
  });

  return _pyProc;
}

// Poll _pyReady (set by the stderr listener above) until the CNN model has
// finished loading, or give up after `timeoutMs`.
async function waitPyReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (_pyReady) return true;
    await sleep(300);
  }
  return false;
}

// Ask the Python CNN process to classify which tile(s) match `taskLabel`.
// `imagesOrUrls` can be an array of image URLs (preferred — Python fetches
// them directly) or an object shaped like { data: [...] } as a fallback.
async function cnnClassify(taskLabel, imagesOrUrls) {
  const proc = getPyProc();
  await waitPyReady();

  return new Promise((resolve, reject) => {
    // Guard against a hung/unresponsive Python process — if no response line
    // arrives within 60s, remove this request from the queue and reject.
    const timer = setTimeout(() => {
      const idx = _pendingResolvers.findIndex(r => r.resolve === resolve);
      if (idx !== -1) _pendingResolvers.splice(idx, 1);
      reject(new Error('CNN classify timeout'));
    }, 60000);

    _pendingResolvers.push({ resolve, reject, timer });

    // Send URLs if available (Python fetches directly), else base64
    const payload = Array.isArray(imagesOrUrls)
      ? JSON.stringify({ task: taskLabel, images: imagesOrUrls }) + '\n'
      : JSON.stringify({ task: taskLabel, urls: imagesOrUrls.data }) + '\n';
    proc.stdin.write(payload);
  });
}

// ── Selenium helpers ──────────────────────────────────────────────────────────
// Always switch back to the top-level document. hCaptcha lives inside nested
// iframes, so after finishing work inside a frame we must reset the
// driver's frame context before the next lookup, otherwise subsequent
// selector queries would run against the wrong (or a detached) document.
async function sw(driver) {
  try { await driver.switchTo().defaultContent(); } catch (_) {}
}

// Checks whether the hCaptcha response token is already populated — i.e.
// whether the captcha has already been solved (either by a previous call,
// or because the site considered the user already "trusted").
async function isHcaptchaSolved(driver) {
  try {
    await sw(driver);
    // Check response token
    const tokens = await driver.findElements(
      By.css("textarea[name='h-captcha-response'],input[name='h-captcha-response']"));
    for (const t of tokens) {
      const val = (await t.getAttribute('value') || '').trim();
      if (val && val.length > 10) return true;
    }
    // Also check via JS (some implementations hide the textarea)
    const jsCheck = await driver.executeScript(`
      var sels = [
        'textarea[name="h-captcha-response"]',
        'input[name="h-captcha-response"]',
        '[name="h-captcha-response"]',
      ];
      for (var i=0; i<sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el && (el.value||'').length > 10) return true;
      }
      return false;
    `).catch(() => false);
    if (jsCheck) return true;
  } catch (_) {}
  return false;
}

// Find the hCaptcha anchor iframe (checkbox)
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function findAnchorIframe(driver) {
  await sw(driver);

  // Scroll widget into view
  await driver.executeScript(`
    var el = document.querySelector('h-captcha,.h-captcha,[data-hcaptcha-widget-id]');
    if (el) el.scrollIntoView({block:'center'});
  `).catch(() => {});
  await sleep(1000);

  // Inject hCaptcha script if not loaded (web component / lazy sites)
  // — some sites define the <h-captcha> element but only load the hCaptcha
  // API script on user interaction; this forces it to load so the iframe
  // actually appears.
  await driver.executeScript(`
    (function(){
      if (document.querySelector('iframe[src*="hcaptcha"]')) return;
      var el = document.querySelector('h-captcha,.h-captcha,[data-hcaptcha-widget-id]');
      if (!el) return;
      var s = document.createElement('script');
      s.src = 'https://js.hcaptcha.com/1/api.js';
      s.async = true; s.defer = true;
      document.head.appendChild(s);
    })();
  `).catch(() => {});

  // Wait up to 12s for hCaptcha iframe to appear
  for (let i = 0; i < 24; i++) {
    try {
      // Try src*=hcaptcha (works after script injection)
      const frames = await driver.findElements(By.css('iframe[src*="hcaptcha"]'));
      for (const f of frames) {
        if (await f.isDisplayed()) return f;
      }
      // Also try original XPath
      const xframes = await driver.findElements(
        By.xpath("//iframe[contains(@src,'hcaptcha') and contains(@src,'checkbox')]"));
      for (const f of xframes) {
        if (await f.isDisplayed()) return f;
      }
    } catch (_) {}
    await sleep(500);
  }
  return null;
}

// Find the hCaptcha challenge iframe (image grid)
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function findChallengeIframe(driver) {
  await sw(driver);
  // Wait up to 8s for challenge iframe (has prompt-text inside)
  for (let i = 0; i < 16; i++) {
    try {
      const frames = await driver.findElements(By.css('iframe[src*="hcaptcha"]'));
      for (const f of frames) {
        if (!await f.isDisplayed()) continue;
        try {
          // Have to switch INTO each candidate frame to check for the
          // prompt-text element, since that's the only reliable way to
          // distinguish the challenge iframe from the checkbox iframe
          // (both match the same CSS selector from outside).
          await driver.switchTo().frame(f);
          const hasPrompt = await driver.executeScript(
            'return !!document.querySelector("h2.prompt-text,.prompt-text")');
          await sw(driver);
          if (hasPrompt) return f;
        } catch (_) { await sw(driver); }
      }
      // XPath fallback
      const xframes = await driver.findElements(
        By.xpath("//iframe[contains(@src,'hcaptcha') and contains(@src,'challenge')]"));
      for (const f of xframes) {
        if (await f.isDisplayed()) return f;
      }
    } catch (_) {}
    await sleep(500);
  }
  return null;
}

// Click checkbox in anchor iframe
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function clickCheckbox(driver) {
  const anchor = await findAnchorIframe(driver);
  if (!anchor) { console.log('      ⚠️ hCaptcha checkbox iframe not found'); return false; }
  try {
    await driver.switchTo().frame(anchor);
    await sleep(500);

    // Get body element position for CDP click
    const rect = await driver.executeScript(`
      var el = document.querySelector('#anchor,#checkbox,[role="checkbox"]') || document.body;
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, found: el.id || el.tagName };
    `);

    // Use CDP Input.dispatchMouseEvent — sets isTrusted=true, bypasses bot detection
    // (a synthetic MouseEvent via dispatchEvent() has isTrusted=false, which
    // bot-detection scripts can check for, so CDP's real input simulation is
    // preferred whenever the driver supports it).
    try {
      const conn = await driver.createCDPConnection('page');
      const x = rect.x + (Math.random() * 4 - 2);
      const y = rect.y + (Math.random() * 4 - 2);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseMoved',   x, y, button: 'none' });
      await sleep(80);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(80);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseReleased',x, y, button: 'left', clickCount: 1 });
      console.log(`      🖱️ CDP click on hCaptcha checkbox (${rect.found})`);
    } catch (_) {
      // Fallback: regular JS click
      await driver.executeScript(`
        var el = document.querySelector('#anchor,#checkbox,[role="checkbox"]') || document.body;
        el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, isTrusted:true}));
      `);
      console.log('      🖱️ JS click on hCaptcha checkbox (fallback)');
    }

    await sw(driver);
    return true;
  } catch (e) {
    console.log(`      ⚠️ Checkbox click failed: ${(e.message || '').slice(0, 60)}`);
    await sw(driver);
    return false;
  }
}

// Read task label from challenge iframe
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function getTaskLabel(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    // Exact selector from hcaptcha-solver: h2.prompt-text > span
    const label = await driver.executeScript(`
      var span = document.querySelector('h2.prompt-text span');
      if (span) return span.innerText.trim().toLowerCase();
      var h2 = document.querySelector('h2.prompt-text');
      if (h2) return h2.innerText.trim().toLowerCase();
      return null;
    `);
    await sw(driver);
    // Strip the boilerplate instruction phrasing ("Please click on/each/all")
    // to leave just the target label (e.g. "buses"), which is what gets
    // passed to cnnClassify() as the classification target.
    return (label || '').replace(/please click (on |each |all )?/i, '').trim();
  } catch (_) {
    await sw(driver);
    return '';
  }
}

// Fetch all tile images as base64 from challenge iframe
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function getTileImages(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    // Extract image URLs from background-image style
    const result = await driver.executeScript(`
      // Find ALL elements with hcaptcha image URLs in style
      var allEls = Array.from(document.querySelectorAll('[style]'));
      var imgEls = allEls.filter(function(e){
        var s = e.getAttribute('style') || '';
        return s.includes('hcaptcha.com') || s.includes('imgs') && s.includes('url(');
      });

      if (imgEls.length >= 3) {
        var urls = imgEls.map(function(e){
          var s = e.getAttribute('style') || '';
          var m = s.match(/url\(["']?(https?:\/\/[^"')\s]+)["']?\)/);
          return m ? m[1] : null;
        }).filter(Boolean);
        if (urls.length >= 3) return { type: 'urls', data: urls };
      }

      // img src fallback
      var imgs = Array.from(document.querySelectorAll('img')).filter(function(i){
        return i.offsetWidth >= 30 && i.src && i.src.startsWith('http');
      });
      if (imgs.length >= 3) return { type: 'urls', data: imgs.map(function(i){ return i.src; }) };
      return { type: 'none', data: [] };
    `);
    await sw(driver);
    return result || { type: 'none', data: [] };
  } catch (_) {
    await sw(driver);
    return { type: 'none', data: [] };
  }
}

// Get clickable tile elements (in same order as images)
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function getTileElements(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    // Exact selector from hcaptcha-solver: div.task-grid div.border-focus
    const els = await driver.executeScript(`
      var els = Array.from(document.querySelectorAll(
        'div.task-grid div.border-focus, .task-grid .border-focus'
      ));
      if (els.length >= 3) return els;
      // Fallback: task-grid image divs
      els = Array.from(document.querySelectorAll(
        'div.task-grid div.image, .task-grid .image'
      ));
      if (els.length >= 3) return els;
      // Last resort: visible imgs
      return Array.from(document.querySelectorAll('img')).filter(function(i){
        return i.offsetWidth >= 30 && i.offsetParent !== null;
      });
    `);
    await sw(driver);
    return els || [];
  } catch (_) {
    await sw(driver);
    return [];
  }
}

// Click a tile element with human-like mouse events
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function clickTile(driver, challengeFrame, tileEl) {
  try {
    await driver.switchTo().frame(challengeFrame);
    const rect = await driver.executeScript(`
      var el = arguments[0];
      el.scrollIntoView({block:'center'});
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    `, tileEl);

    // CDP click — isTrusted=true
    try {
      const conn = await driver.createCDPConnection('page');
      // Small random jitter around the tile's center so clicks don't land
      // on the exact same pixel every time (looks more human, and avoids
      // any pixel-perfect anti-bot heuristics).
      const x = rect.x + (Math.random() * 10 - 5);
      const y = rect.y + (Math.random() * 10 - 5);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y, button: 'none' });
      await sleep(60);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1 });
      await sleep(60);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } catch (_) {
      await driver.executeScript(`
        var el = arguments[0];
        ['mouseover','mousedown','mouseup','click'].forEach(function(t){
          el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:arguments[1],clientY:arguments[2]}));
        });
      `, tileEl, rect.x, rect.y);
    }
    await sw(driver);
    return true;
  } catch (_) {
    await sw(driver);
    return false;
  }
}

// Click the Verify button inside challenge iframe
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function clickVerify(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    // Exact selector from hcaptcha-solver: div.submit.button
    const clicked = await driver.executeScript(`
      var btn = document.querySelector('div.submit.button,.submit.button');
      if (btn && btn.offsetParent !== null) { btn.click(); return true; }
      var btns = Array.from(document.querySelectorAll('button'));
      for (var i=0; i<btns.length; i++) {
        var t = (btns[i].innerText||'').toLowerCase();
        if ((t.includes('verify')||t.includes('submit')) && btns[i].offsetParent !== null) {
          btns[i].click(); return true;
        }
      }
      return false;
    `);
    await sw(driver);
    if (clicked) console.log('      ✅ Clicked Verify');
    return clicked;
  } catch (_) {
    await sw(driver);
    return false;
  }
}
// Poll findChallengeIframe() until the challenge iframe shows up, or timeout.
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function waitForChallenge(driver, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await findChallengeIframe(driver);
    if (frame) return frame;
    await sleep(400);
  }
  return null;
}

// Check if challenge shows "new challenge" / refreshed
// (i.e. hCaptcha rejected the previous answer and served a new prompt with
// a different task label — used by the CNN strategy's round loop to detect
// when it needs to re-classify rather than assume solved.)
// (Part of the unused CNN tile-clicking strategy — see file banner.)
async function isChallengeRefreshed(driver, challengeFrame, prevLabel) {
  const newLabel = await getTaskLabel(driver, challengeFrame);
  return newLabel && newLabel !== prevLabel;
}

// ── Main hCaptcha solver ──────────────────────────────────────────────────────
// ── SeleniumBase solver process ───────────────────────────────────────────────
// This second persistent-process section is the one that actually backs
// solveHcaptcha() below. It spawns hcaptcha_sb_solver.py, which uses the
// `seleniumbase` Python package's CDP-mode browser to solve the hCaptcha
// challenge end-to-end in a completely separate browser instance, then
// returns just the resulting response token as a single line of text.
let _sbProc  = null;
let _sbReady = false;
let _sbQueue = [];

const SB_PY = require('path').join(__dirname, '..', 'hcaptcha_sb_solver.py');

// Lazily spawn (or return the existing) persistent SeleniumBase solver
// process — singleton, same pattern as getPyProc() above.
function getSbProc() {
  if (_sbProc && !_sbProc.killed) return _sbProc;
  console.log('      🔄 Starting SeleniumBase hCaptcha solver...');
  _sbProc  = require('child_process').spawn(PYTHON, [SB_PY], { stdio: ['pipe','pipe','pipe'] });
  _sbReady = false;
  let _buf = '';
  // Protocol: each line of stdout is one response (a token, or empty string).
  _sbProc.stdout.on('data', chunk => {
    _buf += chunk.toString();
    const lines = _buf.split("\n");
    _buf = lines.pop();
    for (const line of lines) {
      const r = _sbQueue.shift();
      if (r) { clearTimeout(r.timer); r.resolve(line.trim()); }
    }
  });
  _sbProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg.includes('ready')) _sbReady = true;
    if (msg.includes('✅') || msg.includes('❌') || msg.includes('⚠️'))
      console.log();
  });
  // On exit, resolve any still-pending requests with an empty string (rather
  // than rejecting) so callers treat it the same as "solve failed" without
  // needing a separate error-handling path.
  _sbProc.on('exit', () => {
    _sbProc = null; _sbReady = false;
    for (const r of _sbQueue) { clearTimeout(r.timer); r.resolve(''); }
    _sbQueue = [];
  });
  return _sbProc;
}

// Poll _sbReady until the SeleniumBase process signals it's ready, or give up.
async function waitSbReady(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (_sbReady) return true;
    await sleep(300);
  }
  return _sbReady;
}

// Send a page URL to the SeleniumBase Python process and wait for the
// resulting hCaptcha response token (or '' on failure/timeout after 120s —
// this can be slow since the Python side opens a real browser, solves an
// image challenge, and waits for hCaptcha's servers to issue a token).
async function sbSolve(url) {
  getSbProc();
  await waitSbReady();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const i = _sbQueue.findIndex(r => r.resolve === resolve);
      if (i !== -1) _sbQueue.splice(i, 1);
      resolve('');
    }, 120000);
    _sbQueue.push({ resolve, timer });
    _sbProc.stdin.write(url + '\n');
  });
}

// ── Main hCaptcha solver ───────────────────────────────────────────────────────
// This is the only exported function, and the actual entry point used by
// captcha/handler.js. See the file-level banner comment at the top for the
// full explanation of why this delegates to a separate Python/SeleniumBase
// process rather than driving the widget in-page.
async function solveHcaptcha(driver) {
  console.log('      🤖 Solving hCaptcha with SeleniumBase CDP...');

  // Get current URL to pass to SeleniumBase
  const url = await driver.getCurrentUrl().catch(() => '');
  if (!url) { console.log('      ⚠️ Could not get URL'); return false; }

  // SeleniumBase opens its own browser, solves hCaptcha, returns token
  const token = await sbSolve(url);

  if (!token || token.length < 10) {
    console.log('      ❌ SeleniumBase did not return token');
    return false;
  }

  console.log(`      ✅ Got token (len=${token.length}) — injecting into page...`);

  // Inject token into the page's hCaptcha response fields
  // (This is what actually lets the ORIGINAL page — the one `driver` is
  // controlling — think it solved the captcha itself: we write the token
  // value obtained from the side-channel Python solve directly into its
  // response field(s) and fire input/change events so any JS listeners
  // on the page pick up the change, e.g. to enable the submit button.)
  try {
    await driver.executeScript(`
      var token = arguments[0];
      var sels = ['textarea[name="h-captcha-response"]','input[name="h-captcha-response"]','[name="h-captcha-response"]'];
      sels.forEach(function(sel){
        document.querySelectorAll(sel).forEach(function(el){
          el.value = token;
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
        });
      });
    `, token);
    console.log('      ✅ Token injected into page');
    return true;
  } catch (e) {
    console.log('      ⚠️ Token injection error:', e.message.slice(0, 80));
    return false;
  }
}

// Cleanup on exit
// Only the CNN process (_pyProc) is explicitly killed here — note the
// SeleniumBase process (_sbProc) is not force-killed on exit in this file
// (it's a separate child process the OS will clean up when the parent
// Node process terminates and stdio pipes close).
process.on('exit', () => {
  if (_pyProc) try { _pyProc.kill(); } catch (_) {}
});

module.exports = { solveHcaptcha };
