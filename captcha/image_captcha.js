// ════════════════════════════════════════════════════════════════════════════
// captcha/image_captcha.js — Image-OCR & math CAPTCHA solver
//
// PURPOSE / ROLE IN THE PIPELINE:
//   Handles the two simplest classes of CAPTCHA that show up on contact
//   forms: (1) classic distorted-text image CAPTCHAs ("type the letters you
//   see") and (2) plain-text math CAPTCHAs ("What is 2 + 3?", including
//   Contact Form 7's built-in "Quiz" field). This module never talks to
//   reCAPTCHA/hCaptcha — captcha/handler.js decides which solver module to
//   call based on what it detects on the page.
//
// HOW IT WORKS (high level):
//   Exported `solveImageCaptcha(driver)`:
//     1. First tries `solveMathCaptcha(driver)` — math CAPTCHAs are cheap
//        and deterministic to solve, so they're attempted before OCR:
//          a. Special-case Contact Form 7's "Quiz" field: read the question
//             text directly from the DOM label, or if not rendered yet,
//             fetch it from the CF7 REST API and regex it out of the form
//             HTML.
//          b. Generic case: scan all visible text/number inputs for ones
//             whose label/placeholder/parent text/name/id looks like a math
//             question (regex for "digit operator digit" or word operators
//             like "plus"/"minus").
//          c. Either way, the found question string is parsed & evaluated
//             by `solveMathExpr()` (word-number and word-operator
//             replacement, then a regex to pull out `a OP b`), and the
//             result is typed into the input via `typeAnswer()`.
//     2. If no math CAPTCHA was found/solved, falls back to image OCR (up
//        to 3 attempts, reloading the CAPTCHA image between attempts):
//          a. `findCaptcha(driver)` — locates a CAPTCHA `<img>` and its
//             paired answer `<input>` using a big list of CSS selector
//             heuristics plus size/keyword filtering (to avoid matching
//             logos/icons).
//          b. `fetchAndPreprocess(driver, imgSrc)` — inside the browser,
//             draws the CAPTCHA image onto an off-screen `<canvas>` 3x
//             upscaled, in 4 different CSS-filter variants (high-contrast
//             grayscale, inverted, extreme contrast, and the raw image),
//             and returns each as a base64 PNG. Uses `fetch(..., {
//             credentials: 'include' })` so session-cookie-gated CAPTCHA
//             images still load.
//          c. `ocrVariants(buffers)` — runs each of those 4 image variants
//             through Tesseract.js (`getWorker()`, loaded once) using 4
//             different page-segmentation modes (PSM 6/7/8/13), collecting
//             every OCR guess, then "votes": the guess that appears most
//             often across all variant×PSM combinations wins, ties broken
//             by OCR confidence score.
//          d. If Tesseract.js's result is empty/too short, falls back to
//             `ocrWithPython()`, which shells out to a Python one-liner
//             using `pytesseract` (PIL preprocessing + multiple threshold/
//             invert/PSM combinations, same voting idea via `Counter`).
//          e. If the canvas-based fetch fails entirely (e.g. CORS/tainted
//             canvas), falls back to taking a plain screenshot-style canvas
//             draw of just the `<img>` element and OCRing that single image.
//          f. Whichever text comes out gets typed into the answer input via
//             `typeAnswer()`, and the function returns success/failure.
//
// DEPENDENCIES / USED BY:
//   - `tesseract.js` (npm package) — in-process JS OCR engine, lazily
//     `require()`'d inside `getWorker()` so the (fairly heavy) worker is
//     only spun up when actually needed.
//   - `child_process.execFileSync` — synchronously shells out to a Python
//     interpreter (`process.env.PYTHON` or a hard-coded venv path) running
//     an inline `-c` script that uses PIL + pytesseract, as a secondary OCR
//     engine when Tesseract.js is uncertain. This Python fallback is
//     self-contained (no persistent process, no shared file with
//     hcaptcha.js/recaptcha.js's Python solvers).
//   - `selenium-webdriver` (By, driver.executeScript/executeAsyncScript) —
//     used throughout to find elements, manipulate the DOM, draw to
//     `<canvas>`, and fetch images from inside the browser's own context
//     (so cookies/session state apply).
//   - Exported `solveImageCaptcha` (main entry), plus `solveMathCaptcha` and
//     `solveMathExpr` (also exported, presumably reusable/testable
//     independently) are called by captcha/handler.js.
// ════════════════════════════════════════════════════════════════════════════

// captcha/image_captcha.js
// Image CAPTCHA solver:
//   1. Find captcha image + answer input (NOT a form field)
//   2. Fetch image via JS canvas (credentials included)
//   3. Preprocess: multiple variants (contrast, invert, denoise)
//   4. OCR each variant with Tesseract.js (multiple PSM modes)
//   5. Vote on best result → type into input
'use strict';

const { By }           = require('selenium-webdriver');
const fs               = require('fs');
const path             = require('path');
const os               = require('os');
const { execFileSync } = require('child_process');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Tesseract.js worker (loaded once) ─────────────────────────────────────────
// Module-level singleton — creating a Tesseract worker (loads WASM + language
// data) is expensive, so we do it once and reuse it across every CAPTCHA
// this process solves. `logger: () => {}` silences Tesseract's built-in
// per-recognition progress logging.
let _worker = null;
async function getWorker() {
  if (_worker) return _worker;
  const { createWorker } = require('tesseract.js');
  console.log('      🔄 Loading Tesseract.js...');
  _worker = await createWorker('eng', 1, { logger: () => {} });
  return _worker;
}

// ── Image CAPTCHA selectors ───────────────────────────────────────────────────
// Broad, keyword-based CSS attribute selectors (case-insensitive via the `i`
// flag) covering common CAPTCHA image/script naming conventions across many
// CAPTCHA libraries/plugins (securimage, generic "verify"/"code"/"chk", etc.)
const IMG_SELS = [
  "img[src*='captcha' i]",    "img[id*='captcha' i]",
  "img[class*='captcha' i]",  "img[alt*='captcha' i]",
  "img[src*='securimage' i]", "img[src*='verify' i]",
  "img[src*='security' i]",   "img[src*='code' i]",
  "img[src*='chk' i]",        "img[src*='random' i]",
  "img[src*='image.php' i]",  "img[src*='captcha.php' i]",
  "img[src*='num' i]",        "img[src*='check' i]",
];
const INP_SELS = [
  "input[name*='captcha' i]",       "input[id*='captcha' i]",
  "input[placeholder*='captcha' i]","input[name*='securimage' i]",
  "input[name*='security_code' i]", "input[id*='security_code' i]",
  "input[name*='verify' i]",        "input[id*='verify' i]",
  "input[name*='code' i]",          "input[placeholder*='code' i]",
  "input[placeholder*='enter' i]",  "input[placeholder*='type' i]",
];

// ── Find captcha image + input in ONE JS call ─────────────────────────────────
// Runs entirely inside the browser via executeScript for speed (one round
// trip instead of many WebDriver calls). Applies extra filtering beyond the
// raw selector match: rejects images whose combined src/alt/class/id
// mentions common non-CAPTCHA image types (logos, social icons, etc.), and
// enforces a plausible CAPTCHA image size range (small, wide-ish, short).
async function findCaptcha(driver) {
  return await driver.executeScript(`
    var IMG_SELS = arguments[0], INP_SELS = arguments[1];

    function isCaptchaImg(el) {
      var src = (el.getAttribute('src')||'').toLowerCase();
      var alt = (el.getAttribute('alt')||'').toLowerCase();
      var cls = (el.className||'').toLowerCase();
      var eid = (el.id||'').toLowerCase();
      var combined = src+' '+alt+' '+cls+' '+eid;
      // Must have captcha signal
      if (!['captcha','securimage','verify','security_code','chk','random','num']
          .some(function(s){ return combined.indexOf(s) !== -1; })) return false;
      // Reject non-captcha images
      if (['logo','icon','banner','avatar','social','facebook','twitter',
           'instagram','arrow','menu','star','badge']
          .some(function(r){ return combined.indexOf(r) !== -1; })) return false;
      // Size check: captcha images are small
      var w = el.offsetWidth || el.naturalWidth;
      var h = el.offsetHeight || el.naturalHeight;
      if (w < 20 || h < 10 || h > 200 || w > 700) return false;
      return true;
    }

    var imgEl = null, inpEl = null;

    for (var i = 0; i < IMG_SELS.length && !imgEl; i++) {
      var els = document.querySelectorAll(IMG_SELS[i]);
      for (var j = 0; j < els.length; j++) {
        if (els[j].offsetParent !== null && isCaptchaImg(els[j])) {
          imgEl = els[j]; break;
        }
      }
    }
    for (var k = 0; k < INP_SELS.length && !inpEl; k++) {
      var inps = document.querySelectorAll(INP_SELS[k]);
      for (var l = 0; l < inps.length; l++) {
        if (inps[l].offsetParent !== null) { inpEl = inps[l]; break; }
      }
    }

    if (!imgEl || !inpEl) return null;
    return {
      img: imgEl, inp: inpEl,
      src: imgEl.src || imgEl.getAttribute('src') || '',
      w: imgEl.offsetWidth, h: imgEl.offsetHeight
    };
  `, IMG_SELS, INP_SELS).catch(() => null);
}

// ── Fetch + preprocess image via canvas (multiple variants) ───────────────────
// Runs inside the browser (executeAsyncScript, since it needs to wait on
// async image loading/fetch before calling back `done`). Draws the CAPTCHA
// image onto a canvas at 3x its natural size (upscaling generally improves
// OCR accuracy on small/noisy CAPTCHA text), applying a different CSS
// `filter` per variant to give the OCR engine several different chances at
// reading the distorted text. Returns an array of base64-encoded PNG strings
// (data URL payload only, the `data:image/png;base64,` prefix stripped).
async function fetchAndPreprocess(driver, imgSrc) {
  // Returns array of base64 PNG strings (different preprocessing variants)
  return await driver.executeAsyncScript(`
    var src  = arguments[0];
    var done = arguments[arguments.length - 1];

    function processImage(imgEl) {
      var W = (imgEl.naturalWidth  || imgEl.width  || 200) * 3;
      var H = (imgEl.naturalHeight || imgEl.height || 60)  * 3;
      var variants = [];

      function makeVariant(filter) {
        var c = document.createElement('canvas');
        c.width = W; c.height = H;
        var ctx = c.getContext('2d');
        ctx.filter = filter;
        ctx.drawImage(imgEl, 0, 0, W, H);
        return c.toDataURL('image/png').split(',')[1];
      }

      // Variant 1: high contrast grayscale (best for most captchas)
      variants.push(makeVariant('contrast(300%) brightness(120%) grayscale(100%)'));
      // Variant 2: inverted (dark background captchas)
      variants.push(makeVariant('contrast(300%) invert(100%) grayscale(100%)'));
      // Variant 3: extreme contrast
      variants.push(makeVariant('contrast(500%) grayscale(100%)'));
      // Variant 4: original scaled up
      variants.push(makeVariant('none'));

      done(variants);
    }

    // If data URI, use directly
    if (src.startsWith('data:')) {
      var img = new Image();
      img.onload = function() { processImage(img); };
      img.src = src;
      return;
    }

    // Fetch with credentials
    // (credentials:'include' so session-cookie-protected CAPTCHA endpoints —
    // where the image is tied to a server-side session — still return the
    // right image bytes instead of a 403/blank image.)
    fetch(src, { credentials: 'include' })
      .then(function(r) { return r.blob(); })
      .then(function(blob) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function() {
          URL.revokeObjectURL(url);
          processImage(img);
        };
        img.onerror = function() { done(null); };
        img.src = url;
      })
      .catch(function() { done(null); });
  `, imgSrc).catch(() => null);
}

// ── OCR with Tesseract.js — multiple PSM modes + voting ──────────────────────
// For each of the 4 preprocessed image variants, writes it to a temp PNG
// file (Tesseract.js's Node API works off files/buffers, not in-memory
// canvases) and runs OCR under 4 different "Page Segmentation Mode" (PSM)
// settings — different PSMs assume different text layouts (single line,
// single word, sparse text, raw line), and CAPTCHA text doesn't always fit
// the same assumption, so trying several increases the odds one reads it
// correctly. `tessedit_char_whitelist` restricts recognition to
// alphanumeric characters only (CAPTCHAs are almost never punctuation).
// Every (variant × PSM) result that survives basic sanity filtering
// (3–10 alphanumeric chars after stripping anything else) is collected,
// then majority-vote picks the most frequent answer string, with ties
// broken by whichever had the higher OCR confidence score.
async function ocrVariants(variantBuffers) {
  const worker = await getWorker();
  const allResults = [];

  for (const buf of variantBuffers) {
    const tmpFile = path.join(os.tmpdir(), `cap_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    try {
      fs.writeFileSync(tmpFile, buf);

      for (const psm of ['7', '8', '6', '13']) {
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: psm,
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
          });
          const { data: { text, confidence } } = await worker.recognize(tmpFile);
          // Strip anything that isn't a letter/digit — OCR often emits stray
          // punctuation/whitespace/newlines around the actual CAPTCHA text.
          const clean = text.replace(/[^A-Za-z0-9]/g, '').trim();
          if (clean && clean.length >= 3 && clean.length <= 10) {
            allResults.push({ text: clean, confidence: confidence || 0 });
          }
        } catch (_) {}
      }
    } finally {
      // Always clean up the temp file, even if OCR threw.
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }

  if (!allResults.length) return '';

  // Vote: pick most frequent, break ties by highest confidence
  const freq = {};
  const conf = {};
  for (const r of allResults) {
    freq[r.text] = (freq[r.text] || 0) + 1;
    conf[r.text] = Math.max(conf[r.text] || 0, r.confidence);
  }

  const best = Object.keys(freq).sort((a, b) => {
    if (freq[b] !== freq[a]) return freq[b] - freq[a];
    return conf[b] - conf[a];
  })[0];

  console.log(`      🔤 OCR result: "${best}" (${freq[best]}/${allResults.length} votes, conf=${conf[best].toFixed(0)})`);
  console.log(`      📊 All variants: ${[...new Set(allResults.map(r => r.text))].join(', ')}`);
  return best;
}

// ── Python fallback OCR (better for complex captchas) ────────────────────────
// Secondary OCR path used only when Tesseract.js's result is empty or
// suspiciously short. Builds an inline Python script (as a template string)
// that uses PIL for preprocessing (grayscale, 3x upscale, per-threshold
// binarization, optional inversion, sharpen filter) and pytesseract for
// recognition, trying several threshold/invert/PSM combinations and again
// voting via `collections.Counter` — mirroring the same "try many variants,
// pick the most common answer" strategy as ocrVariants() above, just with a
// different underlying OCR engine/preprocessing pipeline that sometimes
// succeeds where Tesseract.js fails. Runs synchronously via execFileSync
// with a 30s timeout so it can't hang the whole solve attempt.
function ocrWithPython(imagePath) {
  const PYTHON = process.env.PYTHON || '/home/ubuntu/Captch-Solver-Contact-Form/.venv/bin/python';
  const script = `
import sys, re
from PIL import Image, ImageFilter, ImageEnhance
import pytesseract

img = Image.open(sys.argv[1]).convert('L')
# Scale up 3x
w, h = img.size
img = img.resize((w*3, h*3), Image.LANCZOS)

results = []
for thresh in [100, 128, 150]:
    for invert in [False, True]:
        v = img.point(lambda p: 255 if p > thresh else 0)
        if invert: v = v.point(lambda p: 255 - p)
        v = v.filter(ImageFilter.SHARPEN)
        for psm in ['7','8','6']:
            t = pytesseract.image_to_string(v, config=f'--psm {psm} --oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')
            t = re.sub(r'[^A-Za-z0-9]', '', t).strip()
            if 3 <= len(t) <= 10: results.append(t)

if results:
    from collections import Counter
    print(Counter(results).most_common(1)[0][0])
else:
    print('')
`.trim();

  try {
    const result = execFileSync(PYTHON, ['-c', script, imagePath], {
      timeout: 30000, encoding: 'utf8',
    }).trim();
    if (result) console.log(`      🐍 Python OCR: "${result}"`);
    return result;
  } catch (_) { return ''; }
}

// ── Type answer into captcha input ────────────────────────────────────────────
// Uses the native HTMLInputElement `value` setter (via
// Object.getOwnPropertyDescriptor) rather than plain `el.value = ...`
// because many modern frontend frameworks (React, Vue, etc.) override/patch
// the `value` property or rely on native setter + dispatched events to
// detect changes — a plain assignment can silently fail to update the
// framework's internal state. Clears the field first, then sets the new
// value, firing input/change/blur events so any listeners (client-side
// validation, framework state) pick up the change.
async function typeAnswer(driver, inpEl, text) {
  await driver.executeScript(`
    var el = arguments[0], val = arguments[1];
    el.scrollIntoView({block:'center'});
    el.focus();
    // Clear existing value
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    if (setter && setter.set) setter.set.call(el, '');
    else el.value = '';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    // Set new value
    if (setter && setter.set) setter.set.call(el, val);
    else el.value = val;
    ['input','change','blur'].forEach(function(t){
      el.dispatchEvent(new Event(t, {bubbles:true}));
    });
  `, inpEl, text);
  console.log(`      ✅ Typed CAPTCHA answer: "${text}"`);
}

// ── Reload captcha image ──────────────────────────────────────────────────────
// Used between OCR retry attempts. First tries clicking an actual
// reload/refresh button/link if one exists on the page; if not, falls back
// to forcing a cache-busted reload by appending a `_t=<timestamp>` query
// param to the image's `src` (many CAPTCHA endpoints regenerate the image
// server-side on every fetch regardless of query string, so this alone is
// often enough to get a fresh challenge).
async function reloadCaptcha(driver) {
  try {
    const done = await driver.executeScript(`
      // Try reload button
      var sels = ['[id*="reload" i]','[class*="reload" i]','[id*="refresh" i]',
                  '[class*="refresh" i]','a[href*="captcha" i]','[onclick*="captcha" i]'];
      for (var i=0; i<sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el && el.offsetParent !== null) { el.click(); return 'clicked'; }
      }
      // Force reload by changing img src
      var imgs = document.querySelectorAll(
        'img[src*="captcha" i],img[src*="securimage" i],img[src*="verify" i]');
      if (imgs.length) {
        var src = imgs[0].getAttribute('src') || '';
        var sep = src.indexOf('?') !== -1 ? '&' : '?';
        imgs[0].src = src + sep + '_t=' + Date.now();
        return 'reloaded';
      }
      return null;
    `);
    if (done) { await sleep(1200); return true; }
  } catch (_) {}
  return false;
}

// ── Math CAPTCHA solver ──────────────────────────────────────────────────────
// Handles: "2 + 3 = ?", "What is 5 × 4?", "seven plus three", etc.
const MATH_INP_SELS = [
  "input[name*='captcha' i]","input[id*='captcha' i]",
  "input[name*='math' i]",   "input[id*='math' i]",
  "input[name*='calc' i]",   "input[id*='calc' i]",
  "input[name*='answer' i]", "input[id*='answer' i]",
  "input[name*='result' i]", "input[id*='result' i]",
  "input[name*='sum' i]",    "input[id*='sum' i]",
  "input[name*='spam' i]",   "input[id*='spam' i]",
  "input[name*='verify' i]", "input[id*='verify' i]",
  "input[name*='human' i]",  "input[id*='human' i]",
];

// Spelled-out numbers 0–20, used so math questions phrased in words
// ("seven plus three") can be normalized to digits before parsing.
const WORD_NUMS = {
  zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
  ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
  sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,
};

// Parses a free-text math question and returns the computed answer as a
// string, or null if no recognizable "a OP b" expression could be found.
// Steps: (1) lowercase, (2) replace spelled-out number words with digits,
// (3) replace spelled-out/unicode operators (plus/minus/times/÷ etc.) with
// their symbol, (4) regex out the first `<number> <op> <number>` pattern
// and evaluate it directly (no eval() — a manual switch on the operator).
function solveMathExpr(text) {
  let t = text.toLowerCase().trim();
  // Replace word numbers
  for (const [word, num] of Object.entries(WORD_NUMS)) {
    t = t.replace(new RegExp('\\b' + word + '\\b', 'g'), String(num));
  }
  // Replace word operators
  t = t.replace(/\bplus\b/g,'+').replace(/\bminus\b/g,'-')
       .replace(/\btimes\b|\bmultiplied by\b|\bx\b/g,'*')
       .replace(/\bdivided by\b/g,'/').replace(/[×]/g,'*').replace(/[÷]/g,'/');
  // Extract math expression
  const m = t.match(/(-?\d+)\s*([+\-*/])\s*(-?\d+)/);
  if (!m) return null;
  const a = parseInt(m[1]), op = m[2], b = parseInt(m[3]);
  if (isNaN(a) || isNaN(b)) return null;
  switch(op) {
    case '+': return String(a + b);
    case '-': return String(a - b);
    case '*': return String(a * b);
    // Division result is rounded since most math-CAPTCHA answers are
    // constructed to divide evenly, but rounding guards against float
    // artifacts (e.g. 9/3 !== exactly 3 in edge cases with parseInt/float math).
    case '/': return b !== 0 ? String(Math.round(a / b)) : null;
  }
  return null;
}

// Tries, in order: (1) Contact Form 7's built-in "Quiz" field (special-cased
// since its question text sometimes must be fetched from the CF7 REST API
// rather than read off the DOM), then (2) a generic DOM scan for any input
// whose label/parent text or name/id implies it's a math/human-check field.
async function solveMathCaptcha(driver) {
  // CF7 Quiz — fetch question via CF7 REST API
  try {
    const cf7 = await driver.executeAsyncScript(function() {
      var done = arguments[arguments.length - 1];
      // First check if label already has text
      var inputs = Array.from(document.querySelectorAll('input.wpcf7-quiz,[name*="quiz-"]'));
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp.offsetParent === null) continue;
        var lbl = inp.closest('label');
        var question = '';
        if (lbl) {
          var span = lbl.querySelector('.wpcf7-quiz-label');
          question = span ? span.innerText.trim() : lbl.innerText.trim();
        }
        if (question) { done({ inp: inp, question: question }); return; }
      }
      // Fetch via CF7 REST API
      // (Some CF7 quiz configs don't render the question text directly in
      // the label — in that case, hit CF7's own REST endpoint for the form
      // definition and regex the quiz question out of the raw form body.)
      var formEl = document.querySelector('.wpcf7');
      var formId = formEl ? (formEl.getAttribute('data-id') || '') : '';
      if (!formId) { done(null); return; }
      var root = (window.wpcf7 && window.wpcf7.api && window.wpcf7.api.root) || '/wp-json/';
      fetch(root + 'contact-form-7/v1/contact-forms/' + formId + '?context=edit', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var content = (data && data.properties && data.properties.form && data.properties.form.body) || '';
          var match = content.match(/quiz[^"]*"([^"]+)"/);
          var question = match ? match[1] : '';
          var inp2 = document.querySelector('input.wpcf7-quiz,[name*="quiz-"]');
          done(question && inp2 ? { inp: inp2, question: question } : null);
        })
        .catch(function() { done(null); });
    });
    if (cf7 && cf7.question) {
      console.log(`      🔢 CF7 Quiz: "${cf7.question.slice(0,60)}"`);
      const answer = solveMathExpr(cf7.question);
      if (answer !== null) {
        console.log(`      ✅ CF7 Quiz answer: ${answer}`);
        await typeAnswer(driver, cf7.inp, answer);
        return true;
      }
    }
  } catch (_) {}

  // Generic scan: run entirely in-page for speed. Tries three passes with
  // decreasing strictness so it can find math questions phrased in a
  // variety of ways without over-matching unrelated inputs:
  //   Pass 1: any visible text/number input whose DIRECT label (label[for],
  //           aria-label, placeholder, or immediate parent text — NOT a
  //           grandparent, to avoid accidentally grabbing text belonging to
  //           a sibling field) contains a math expression.
  //   Pass 2: inputs whose name/id looks like a captcha/math/human/spam
  //           field, where either the parent text or the name/id itself
  //           contains math.
  //   Pass 3: inputs whose label says something generic like "answer" or
  //           "verify" while the actual math expression lives in the
  //           parent's text (label and math live in different places).
  const found = await driver.executeScript(function() {
    function hasMath(text) {
      var t = (text||'').toLowerCase();
      return /\d+\s*[+\-*\/x×÷]\s*\d+/.test(t) ||
             /(plus|minus|times|divided|multiplied)/.test(t);
    }
    function getDirectLabel(el) {
      // Only check DIRECT label — not grandparent which may contain other fields
      if (el.id) { var l=document.querySelector('label[for="'+el.id+'"]'); if(l) return l.innerText.trim(); }
      var a=el.getAttribute('aria-label'); if(a) return a.trim();
      if (el.placeholder && hasMath(el.placeholder)) return el.placeholder;
      // Parent text only (not grandparent)
      var par=el.parentElement;
      if(par) return par.innerText.trim();
      return '';
    }
    var inputs = Array.from(document.querySelectorAll('input[type=text],input[type=number],input:not([type])'));
    for (var i=0; i<inputs.length; i++) {
      var el=inputs[i];
      if (el.offsetParent===null) continue;
      var directLabel = getDirectLabel(el);
      // Must have math in DIRECT label/parent only
      if (hasMath(directLabel)) {
        return { inp: el, question: directLabel };
      }
    }
    // Second pass: check by id/name (math-captcha, human, spam, answer)
    for (var m=0; m<inputs.length; m++) {
      var em=inputs[m];
      if (em.offsetParent===null) continue;
      var nm=(em.name||'').toLowerCase(), idm=(em.id||'').toLowerCase();
      if (/math|captcha|human|spam|answer|verify/.test(nm+' '+idm)) {
        var parText2 = em.parentElement ? em.parentElement.innerText.trim() : '';
        if (hasMath(parText2) || hasMath(nm+' '+idm)) {
          return { inp: em, question: parText2 || nm };
        }
      }
    }
    // Third pass: check label[for] text which may say "Enter the correct answer"
    // and parent has the actual math expression
    for (var j=0; j<inputs.length; j++) {
      var el2=inputs[j];
      if (el2.offsetParent===null) continue;
      var lbl = '';
      if (el2.id) { var l2=document.querySelector('label[for="'+el2.id+'"]'); if(l2) lbl=l2.innerText.trim(); }
      var par2 = el2.parentElement;
      var parText = par2 ? par2.innerText.trim() : '';
      // Label says "answer" AND parent has math
      if (/answer|correct|captcha|verify|human|spam/i.test(lbl) && hasMath(parText)) {
        return { inp: el2, question: parText };
      }
    }
    return null;
  }).catch(() => null);

  if (!found || !found.question) return false;

  const question = found.question.trim();
  console.log(`      🔢 Math: "${question.slice(0,60)}"`);

  const answer = solveMathExpr(question);
  if (answer === null) {
    console.log(`      ⚠️ Cannot parse: "${question.slice(0,60)}"`);
    return false;
  }

  console.log(`      ✅ Answer: ${answer}`);
  await typeAnswer(driver, found.inp, answer);
  return true;
}

// ── Main solver ───────────────────────────────────────────────────────────────
// Entry point exported to captcha/handler.js. Order of operations:
// math CAPTCHA first (fast, deterministic, no OCR needed), then image OCR
// as a fallback, with up to 3 retry rounds (reloading the CAPTCHA image
// between rounds) since OCR accuracy on distorted CAPTCHA text is
// inherently probabilistic.
async function solveImageCaptcha(driver) {
  // Try math CAPTCHA first (text-based question like "2 + 3 = ?")
  const mathSolved = await solveMathCaptcha(driver);
  if (mathSolved) return true;

  // Then try image OCR CAPTCHA
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      console.log(`      🔄 Image CAPTCHA retry ${attempt}/3...`);
      await reloadCaptcha(driver);
    }

    // Find captcha image + input
    const found = await findCaptcha(driver);
    if (!found) {
      if (attempt === 1) console.log('      ℹ️ No image CAPTCHA found');
      return false;
    }

    const { img: imgEl, inp: inpEl, src: imgSrc, w, h } = found;
    if (!imgSrc) { console.log('      ⚠️ Captcha image has no src'); return false; }

    console.log(`      🖼️ Image CAPTCHA: ${imgSrc.slice(0, 60)} (${w}×${h}px)`);

    // Fetch + preprocess (4 variants via canvas)
    const variants = await fetchAndPreprocess(driver, imgSrc);

    let text = '';

    if (variants && variants.length) {
      const buffers = variants.map(b64 => Buffer.from(b64, 'base64'));
      console.log(`      📡 Running OCR on ${buffers.length} image variants...`);
      text = await ocrVariants(buffers);

      // Python fallback if Tesseract.js fails or gives short result
      if (!text || text.length < 3) {
        console.log('      🐍 Tesseract.js uncertain — trying Python OCR...');
        const tmpFile = path.join(os.tmpdir(), `cap_py_${Date.now()}.png`);
        try {
          fs.writeFileSync(tmpFile, buffers[0]); // use high-contrast variant
          text = ocrWithPython(tmpFile);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
      }
    } else {
      // Canvas fetch failed — take screenshot directly
      // (Happens e.g. when the image is served cross-origin without CORS
      // headers, which "taints" the canvas and blocks toDataURL/fetch. As a
      // last resort, draw straight from the already-rendered <img> element
      // — this only works if the browser itself was able to display the
      // image, even though script-level pixel access was blocked for fetch.)
      console.log('      📸 Canvas fetch failed — using element screenshot...');
      try {
        const png = await driver.executeScript(`
          var img = arguments[0];
          var c = document.createElement('canvas');
          c.width  = (img.naturalWidth  || img.offsetWidth  || 150) * 3;
          c.height = (img.naturalHeight || img.offsetHeight || 50)  * 3;
          var ctx = c.getContext('2d');
          ctx.filter = 'contrast(300%) grayscale(100%)';
          ctx.drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL('image/png').split(',')[1];
        `, imgEl);
        if (png) {
          const buf = Buffer.from(png, 'base64');
          text = await ocrVariants([buf]);
        }
      } catch (_) {}
    }

    if (!text) {
      console.log(`      ⚠️ OCR empty (attempt ${attempt}/3)`);
      continue;
    }

    // Type answer
    try {
      await typeAnswer(driver, inpEl, text);
      return true;
    } catch (e) {
      console.log(`      ⚠️ Type failed: ${e.message?.slice(0, 80)}`);
      return false;
    }
  }

  console.log('      ⚠️ Image CAPTCHA failed after 3 attempts');
  return false;
}

// Terminate the Tesseract.js worker when the process exits, to free its
// WASM/worker resources cleanly rather than relying on the OS.
process.on('exit', () => {
  if (_worker) _worker.terminate().catch(() => {});
});

module.exports = { solveImageCaptcha, solveMathCaptcha, solveMathExpr };
