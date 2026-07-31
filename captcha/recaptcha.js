// ════════════════════════════════════════════════════════════════════════════
// captcha/recaptcha.js — reCAPTCHA v2 solver (audio challenge + Whisper AI)
//
// PURPOSE / ROLE IN THE PIPELINE:
//   Solves Google reCAPTCHA v2 ("I'm not a robot" checkbox + challenge)
//   widgets encountered while filling contact forms. Rather than attempting
//   the (much harder to automate) image-tile challenge, it always steers
//   the widget toward the AUDIO challenge, downloads the spoken audio,
//   transcribes it locally using OpenAI's Whisper model (via a small
//   persistent Python server), and types the transcribed words back into
//   reCAPTCHA's answer box.
//
// HOW IT WORKS (high level) — exported `solveRecaptchaAudio(driver)`:
//     1. Switch to the top-level document, then locate and switch into the
//        reCAPTCHA "anchor" iframe (the small iframe containing just the
//        checkbox), polling for up to 8s since it can load late on pages
//        where the captcha only appears after a first form-submit attempt.
//     2. Click the checkbox. If that alone marks the captcha as solved
//        (`isSolved()` — checks the hidden `g-recaptcha-response` textarea
//        or the checkbox's `aria-checked` state), return success
//        immediately (this happens when Google's risk analysis trusts the
//        browser/session enough not to show a challenge at all).
//     3. Otherwise, find the "bframe" iframe (the actual challenge UI) and
//        check whether Google served an IMAGE challenge or an AUDIO
//        challenge. If it's an image challenge, click reCAPTCHA's own
//        "switch to audio" button (`clickAudioButton()`) — this file never
//        tries to solve the image grid itself. If it's already an audio
//        challenge, just click the audio button to start it.
//     4. Enter a retry loop (up to 3 attempts). On each attempt:
//          a. `getAudioUrl()` — poll the DOM for the `<audio>`/download-link
//             element's URL (up to 10s).
//          b. `fetchAudio()` — fetch the mp3 bytes from inside the page's
//             own JS context (`credentials:'include'`, so any
//             session/anti-bot cookies apply), base64-encode them, and
//             ship the base64 string back to Node via `executeAsyncScript`.
//          c. Write those bytes to a temp `audio.mp3` file on disk.
//          d. `transcribe(mp3Path)` — hand the file path to a persistent
//             Whisper Python server process (spawned/reused via
//             `getWhisper()`, communicating over stdin/stdout: one file
//             path in, one line of transcribed text out) and await the
//             text result (up to 60s).
//          e. Type the transcribed text into reCAPTCHA's audio-response
//             input character-by-character, dispatching realistic
//             keydown/keypress/input/keyup events with small random delays
//             (to look like real human typing rather than a bulk paste).
//          f. Click the Verify button, then check `isSolved()`. If not
//             solved and an error message is shown, or if the answer was
//             simply wrong, click reCAPTCHA's own reload/refresh button and
//             try again (new audio clip) up to the attempt limit.
//     5. Clean up the temp directory holding the mp3, and switch back to
//        the top-level document before returning true/false.
//
//   Throughout, `isRateLimited()` checks the challenge iframe's visible text
//   for phrases like "try again later" / "unusual activity" — if Google has
//   throttled/blocked the session, the function bails out early instead of
//   burning retry attempts it cannot win.
//
// DEPENDENCIES / USED BY:
//   - `selenium-webdriver` (By) — drives the browser: switching iframes,
//     finding/clicking elements, executing in-page JS.
//   - Spawns and talks to `whisper_server.py` (in the project root, one
//     level up from captcha/) as a PERSISTENT child process via
//     `child_process.spawn`, using `process.env.PYTHON ||
//     '/usr/bin/python3'` as the interpreter. Protocol over stdio:
//       • Node writes the audio file path + newline to the Python
//         process's stdin.
//       • Python (running Whisper) transcribes the file and writes the
//         resulting text + newline to stdout.
//       • Python writes status/log lines to stderr; this file watches for
//         a line containing "model loaded" to know when Whisper is ready
//         to accept requests (`_ready` flag).
//     The Whisper process is started eagerly ~200ms after this module
//     loads (see the `setTimeout(() => getWhisper(), 200)` call near the
//     top) so the (slow) model-loading time overlaps with the rest of the
//     form-filling pipeline's startup instead of blocking the first
//     captcha solve.
//   - Exported `solveRecaptchaAudio` is called by captcha/handler.js (the
//     dispatcher that decides which captcha solver module to invoke for a
//     given page based on what type of captcha it detects).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { By } = require('selenium-webdriver');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawn } = require('child_process');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.random() * (b - a) + a; }

// ── Whisper persistent server ─────────────────────────────────────────────────
// Module-level singleton child process running whisper_server.py. Kept
// alive across multiple solve calls so the (slow) Whisper model only needs
// to load once per run of the Node process, not once per CAPTCHA.
let _proc = null, _ready = false;

// Lazily spawn (or return the existing) persistent Whisper server process.
function getWhisper() {
  if (_proc && !_proc.killed) return _proc;
  const py  = process.env.PYTHON || '/usr/bin/python3';
  const scr = path.join(__dirname, '..', 'whisper_server.py');
  console.log('      🔄 Starting Whisper...');
  _proc  = spawn(py, [scr], { stdio: ['pipe','pipe','pipe'] });
  _ready = false;
  // stderr carries log/status lines; watch for the "model loaded" marker to
  // know Whisper has finished initializing and can accept transcribe requests.
  _proc.stderr.on('data', d => {
    const m = d.toString().trim();
    if (m.includes('model loaded')) _ready = true;
    console.log(`      [whisper] ${m}`);
  });
  _proc.on('exit', () => { _proc = null; _ready = false; });
  return _proc;
}

// Send an audio file path to the Whisper server and wait for the
// transcribed text (one line on stdout). Protocol: write `<path>\n` to
// stdin, read back `<text>\n` from stdout.
async function transcribe(audioPath) {
  const size = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
  // Guard against sending a near-empty/corrupt audio file to Whisper — very
  // small files are almost certainly a failed download, not real audio.
  if (size < 500) { console.log('      ⚠️ Audio too small'); return ''; }
  console.log(`      🔍 Transcribing ${size} bytes...`);
  return new Promise(resolve => {
    try {
      const proc = getWhisper();
      // Wait for the model to finish loading (polls _ready every 300ms,
      // gives up after 90s) before writing to stdin — writing too early
      // would just sit in the pipe buffer until the model is ready anyway,
      // but this keeps the logic explicit and bounded.
      const wait = cb => {
        if (_ready) return cb();
        let w = 0;
        const iv = setInterval(() => { w += 300; if (_ready || w > 90000) { clearInterval(iv); cb(); } }, 300);
      };
      wait(() => {
        let buf = '';
        const onData = d => {
          buf += d.toString();
          if (buf.includes('\n')) {
            proc.stdout.off('data', onData);
            const t = buf.split('\n')[0].trim();
            console.log(`      🗣️  Whisper: "${t}"`);
            resolve(t);
          }
        };
        proc.stdout.on('data', onData);
        proc.stdin.write(audioPath + '\n');
        // Hard timeout so a stuck/unresponsive Whisper process can't hang
        // the whole captcha-solve attempt forever.
        setTimeout(() => { proc.stdout.off('data', onData); console.log('      ⚠️ Whisper timeout'); resolve(''); }, 60000);
      });
    } catch (e) { console.log(`      ⚠️ ${e.message}`); resolve(''); }
  });
}

// Kick off the Whisper server shortly after module load (not synchronously
// at require-time) so its slow model-loading happens in the background
// while the rest of the pipeline starts up, rather than blocking it.
setTimeout(() => { try { getWhisper(); } catch (_) {} }, 200);

// ── Helpers ───────────────────────────────────────────────────────────────────
// Always reset to the top-level document. reCAPTCHA lives in nested
// iframes (anchor + bframe), so callers must switch back out before the
// next unrelated lookup, or subsequent selector queries would run against
// the wrong frame.
async function sw(driver) { try { await driver.switchTo().defaultContent(); } catch (_) {} }

// Checks whether the captcha is already solved: either the hidden
// `g-recaptcha-response` textarea has a non-empty token, or the checkbox
// inside the anchor iframe shows the "checked" state.
async function isSolved(driver) {
  try {
    await sw(driver);
    for (const t of await driver.findElements(By.css("textarea[name='g-recaptcha-response']")))
      if ((await t.getAttribute('value') || '').trim()) return true;
    for (const f of await driver.findElements(By.css("iframe[src*='recaptcha'][src*='anchor']"))) {
      // Skip near-zero-width anchor iframes — some pages keep a hidden/
      // collapsed duplicate anchor iframe in the DOM that isn't the real
      // visible widget.
      if ((await f.getRect()).width < 60) continue;
      try {
        await driver.switchTo().frame(f);
        const c = await driver.findElements(By.css(".recaptcha-checkbox-checked,[aria-checked='true']"));
        await sw(driver);
        if (c.length) return true;
      } catch (_) { await sw(driver); }
    }
  } catch (_) { await sw(driver); }
  return false;
}

// Scans the challenge frame's visible body text for phrases Google shows
// when it has rate-limited / blocked the current session from solving more
// challenges — used to bail out early instead of wasting retry attempts.
async function isRateLimited(driver) {
  try {
    const b = await driver.executeScript("return document.body ? document.body.innerText.toLowerCase() : '';") || '';
    return ['try again later','too many requests','unusual activity','automated queries',
            'cannot process your request','protect our users'].some(p => b.includes(p));
  } catch (_) { return false; }
}

// Clicks an element via synthetic mouse events with a small random offset
// from center and a short randomized pause afterward, to look closer to a
// real human click than an instantaneous exact-center click. Falls back to
// a plain `.click()` via executeScript if the synthetic-event approach fails.
async function clickEl(driver, el) {
  try {
    await driver.executeScript(function(el) {
      el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect();
      var x = r.left + r.width/2 + (Math.random()*6-3);
      var y = r.top  + r.height/2 + (Math.random()*6-3);
      ['mouseover','mousedown','mouseup','click'].forEach(function(t) {
        el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, clientX:x, clientY:y }));
      });
    }, el);
    await sleep(rand(200, 400));
    return true;
  } catch (_) {
    try { await driver.executeScript('arguments[0].click();', el); return true; } catch (_2) { return false; }
  }
}

// Clicks reCAPTCHA's own reload/refresh button (fetches a new challenge —
// new audio clip / new image grid) between failed attempts.
async function reload(driver) {
  try {
    const rb = await driver.findElement(By.css('#recaptcha-reload-button,[id*="reload"],.rc-button-reload'));
    await driver.executeScript('arguments[0].click();', rb);
    await sleep(2000);
    return true;
  } catch (_) { return false; }
}

// Polls (up to 10s) for the audio challenge's downloadable/source URL,
// trying several selectors since reCAPTCHA has used different DOM
// structures for the audio element/link across versions.
async function getAudioUrl(driver) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      const url = await driver.executeScript(function() {
        var sels = ['#audio-source','a.rc-audiochallenge-tdownload-link','[id*="audio-source"]','audio[src]','audio source[src]'];
        for (var i=0; i<sels.length; i++) {
          var el = document.querySelector(sels[i]);
          if (el) { var s = el.src||el.href||el.getAttribute('src')||el.getAttribute('href')||''; if (s && s.startsWith('http')) return s; }
        }
        return null;
      });
      if (url) return url;
    } catch (_) {}
    await sleep(400);
  }
  return null;
}

// Downloads the audio file's raw bytes from INSIDE the page's own JS
// context (so any session cookies / anti-bot headers apply exactly as they
// would for a real user's browser), converts the ArrayBuffer to a binary
// string then base64-encodes it with `btoa`, and returns that base64
// string back to Node (WebDriver script results must be JSON-serializable,
// hence the base64 round-trip rather than returning raw bytes).
async function fetchAudio(driver, url) {
  try {
    return await driver.executeAsyncScript(function() {
      var url = arguments[0], done = arguments[arguments.length-1];
      fetch(url, { credentials: 'include' })
        .then(function(r) { return r.arrayBuffer(); })
        .then(function(buf) {
          var b = new Uint8Array(buf), s = '';
          for (var i=0; i<b.byteLength; i++) s += String.fromCharCode(b[i]);
          done(btoa(s));
        })
        .catch(function() { done(null); });
    }, url);
  } catch (_) { return null; }
}

// ── Click audio button (works from image challenge too) ───────────────────────
// This same button both (a) switches an in-progress IMAGE challenge over to
// the audio challenge, and (b) starts playback/reveals the download link
// when already on the audio challenge — reCAPTCHA reuses the same button
// for both purposes depending on current state, so one function covers
// both call sites in solveRecaptchaAudio() below.
async function clickAudioButton(driver) {
  // Try all known selectors
  for (const sel of [
    '#recaptcha-audio-button', 'button.rc-button-audio',
    '[id*="audio-button"]', 'button[aria-labelledby*="audio"]',
    'button[title*="audio" i]',
  ]) {
    try {
      const btn = await driver.findElement(By.css(sel));
      if (await btn.isDisplayed()) {
        await clickEl(driver, btn);
        console.log('      🔊 Clicked audio button');
        return true;
      }
    } catch (_) {}
  }
  // Fallback: any button with 'audio' in attributes
  for (const btn of await driver.findElements(By.tagName('button'))) {
    try {
      const attrs = [
        await btn.getAttribute('id') || '',
        await btn.getAttribute('class') || '',
        await btn.getAttribute('title') || '',
        await btn.getAttribute('aria-label') || '',
      ].join(' ').toLowerCase();
      if (attrs.includes('audio') && await btn.isDisplayed()) {
        await clickEl(driver, btn);
        console.log('      🔊 Clicked audio button (fallback)');
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ── Main solver ───────────────────────────────────────────────────────────────
// Entry point exported to captcha/handler.js. See the file-level banner
// comment at the top for the full step-by-step description of the flow
// implemented below (checkbox → detect challenge type → force audio →
// download/transcribe/type/verify loop, up to 3 attempts).
async function solveRecaptchaAudio(driver) {
  try {
    await sw(driver);

    // 1. Find anchor iframe — wait up to 8s for it to appear (post-submit captcha loads late)
    let anchor = null;
    const anchorDeadline = Date.now() + 8000;
    while (Date.now() < anchorDeadline && !anchor) {
      for (const f of await driver.findElements(By.css("iframe[src*='recaptcha'][src*='anchor']"))) {
        try { if (await f.isDisplayed() && (await f.getRect()).width >= 60) { anchor = f; break; } } catch(_) {}
      }
      if (!anchor) {
        // Looser fallback selector in case the anchor iframe's src doesn't
        // literally contain "anchor" on some reCAPTCHA deployments.
        for (const f of await driver.findElements(By.css("iframe[src*='recaptcha']"))) {
          try { if (await f.isDisplayed()) { anchor = f; break; } } catch(_) {}
        }
      }
      if (!anchor) await sleep(500);
    }
    if (!anchor) { console.log('      ⚠️ No reCAPTCHA anchor iframe'); return false; }

    // 2. Click checkbox
    try {
      await driver.switchTo().frame(anchor);
      const cb = await driver.findElement(By.css('#recaptcha-anchor,.recaptcha-checkbox-border,.recaptcha-checkbox'));
      await clickEl(driver, cb);
      console.log('      ✓ Clicked checkbox');
    } catch (e) {
      console.log(`      ⚠️ Checkbox failed: ${(e.message||'').slice(0,60)}`);
      await sw(driver); return false;
    }
    await sw(driver);
    await sleep(rand(1500, 2500));

    // 3. Already solved?
    // (Google's risk analysis sometimes trusts the session enough that
    // clicking the checkbox alone passes, with no challenge shown at all.)
    if (await isSolved(driver)) { console.log('      ✅ Solved at checkbox!'); return true; }

    // 4. Find bframe
    let bframe = null;
    for (const f of await driver.findElements(By.css("iframe[src*='recaptcha'][src*='bframe']"))) { bframe = f; break; }
    if (!bframe) {
      for (const f of await driver.findElements(By.css("iframe[title*='recaptcha challenge'],iframe[title*='challenge']"))) { bframe = f; break; }
    }
    // No challenge iframe appeared at all — treat as solved (checkbox-only pass).
    if (!bframe) { console.log('      ✅ Solved (no challenge)'); return true; }

    await driver.switchTo().frame(bframe);
    await sleep(1200);

    if (await isRateLimited(driver)) { console.log('      ⚠️ Rate-limited'); await sw(driver); return false; }

    // 5. Check challenge type — image or audio
    const isImage = await driver.executeScript(function() {
      return !!document.querySelector('.rc-imageselect-tile,.rc-imageselect-table,[class*="imageselect"]');
    }).catch(() => false);

    if (isImage) {
      // Image challenge — click audio button to SWITCH to audio challenge
      // (this file deliberately never attempts to solve the image grid —
      // audio + Whisper is the only strategy implemented here)
      console.log('      🖼️ Image challenge — switching to audio...');
      const switched = await clickAudioButton(driver);
      if (!switched) {
        console.log('      ⚠️ Cannot switch to audio');
        await sw(driver); return false;
      }
      await sleep(2000);
      // Check if switched successfully
      const stillImage = await driver.executeScript(function() {
        return !!document.querySelector('.rc-imageselect-tile,.rc-imageselect-table');
      }).catch(() => true);
      if (stillImage) {
        console.log('      ⚠️ Still on image challenge');
        await sw(driver); return false;
      }
      console.log('      ✅ Switched to audio challenge');
    } else {
      // Already audio — click audio button
      const clicked = await clickAudioButton(driver);
      if (!clicked) {
        console.log('      ⚠️ Audio button not found');
        await sw(driver); return false;
      }
      await sleep(1800);
      if (await isRateLimited(driver)) { console.log('      ⚠️ Rate-limited'); await sw(driver); return false; }
    }

    // 6. Download → Whisper → type → verify (3 attempts)
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'rc_'));
    const mp3Path = path.join(tmpDir, 'audio.mp3');

    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`      📥 Attempt ${attempt}/3...`);

        const audioUrl = await getAudioUrl(driver);
        if (!audioUrl) {
          console.log(`      ⚠️ No audio URL (${attempt}/3)`);
          if (attempt < 3 && await reload(driver)) { await sleep(800); continue; }
          await sw(driver); return false;
        }
        console.log(`      🎵 ${audioUrl.slice(0,70)}...`);

        const b64 = await fetchAudio(driver, audioUrl);
        if (!b64) {
          console.log(`      ⚠️ Fetch failed (${attempt}/3)`);
          if (attempt < 3 && await reload(driver)) { await sleep(800); continue; }
          await sw(driver); return false;
        }

        const buf = Buffer.from(b64, 'base64');
        fs.writeFileSync(mp3Path, buf);
        console.log(`      📥 ${buf.length} bytes`);

        // Whisper transcription runs OUTSIDE any iframe context (it's just
        // a Node/child-process call), so switch back to the top-level
        // document first, then re-enter bframe afterward to continue
        // interacting with the challenge UI (typing/clicking Verify).
        await sw(driver);
        const text = await transcribe(mp3Path);
        await driver.switchTo().frame(bframe);

        if (!text) {
          console.log(`      ⚠️ Empty transcription (${attempt}/3)`);
          if (attempt < 3 && await reload(driver)) { await sleep(800); continue; }
          await sw(driver); return false;
        }

        // Type answer char-by-char
        // (Dispatches a full keydown/keypress/input/keyup sequence per
        // character with a randomized inter-key delay, rather than setting
        // `.value` directly, so the interaction looks like real typing to
        // any JS listeners / bot-detection heuristics on the page.)
        try {
          const ans = await driver.findElement(By.css(
            '#audio-response,.rc-audiochallenge-response-field input,input[id*="audio-response"]'));
          await driver.executeScript('arguments[0].value=""; arguments[0].focus();', ans);
          for (const ch of text) {
            await driver.executeScript(function(el, ch) {
              el.value += ch;
              el.dispatchEvent(new KeyboardEvent('keydown',  { key:ch, bubbles:true }));
              el.dispatchEvent(new KeyboardEvent('keypress', { key:ch, bubbles:true }));
              el.dispatchEvent(new InputEvent('input',       { bubbles:true }));
              el.dispatchEvent(new KeyboardEvent('keyup',    { key:ch, bubbles:true }));
            }, ans, ch);
            await sleep(rand(40, 110));
          }
          console.log(`      ✏️  Typed: "${text}"`);
          await sleep(rand(300, 500));
        } catch (e) {
          console.log(`      ⚠️ Answer input: ${(e.message||'').slice(0,60)}`);
          await sw(driver); return false;
        }

        // Click verify
        try {
          const verify = await driver.findElement(By.css(
            '#recaptcha-verify-button,button.rc-audiochallenge-verify-button,[id*="verify-button"]'));
          await clickEl(driver, verify);
          console.log(`      ✅ Submitted: "${text}"`);
        } catch (e) {
          console.log(`      ⚠️ Verify: ${(e.message||'').slice(0,60)}`);
          await sw(driver); return false;
        }

        await sleep(2000);
        await sw(driver);
        if (await isSolved(driver)) { console.log('      ✅ reCAPTCHA solved!'); return true; }

        // Not solved yet — check whether reCAPTCHA flagged the answer as
        // wrong (visible error message) vs. just needing more time
        // (delayed token issuance), and decide whether to retry.
        try {
          await driver.switchTo().frame(bframe);
          if (await isRateLimited(driver)) { console.log('      ⚠️ Rate limited'); await sw(driver); return false; }
          const errs = await driver.findElements(By.css('.rc-audiochallenge-error-message,[id*="audio-error"]'));
          let hasErr = false;
          for (const e of errs) { if (await e.isDisplayed() && (await e.getText()).trim()) { hasErr = true; break; } }
          await sw(driver);
          if (hasErr) {
            console.log(`      ⚠️ Wrong answer (${attempt}/3)`);
            if (attempt < 3) { await driver.switchTo().frame(bframe); await reload(driver); await sleep(800); continue; }
            return false;
          }
          // No error shown — give it a brief moment in case the token is
          // issued slightly after the checkmark/response would normally appear.
          await sleep(800);
          if (await isSolved(driver)) { console.log('      ✅ Solved (delayed)!'); return true; }
          await driver.switchTo().frame(bframe);
        } catch (_) { await sw(driver); }

        if (attempt < 3) {
          try { await driver.switchTo().frame(bframe); await reload(driver); await sleep(800); }
          catch (_) { await sw(driver); }
        }
      }
    } finally {
      // Always remove the temp directory holding the downloaded mp3(s),
      // even if a solve attempt threw or returned early.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    await sw(driver); return false;

  } catch (e) {
    console.log(`      ⚠️ reCAPTCHA error: ${(e.message||'').slice(0,150)}`);
    await sw(driver); return false;
  }
}

// Kill the Whisper child process when this Node process exits, so it
// doesn't linger as an orphaned process after the pipeline stops.
process.on('exit', () => { if (_proc) try { _proc.kill(); } catch (_) {} });

module.exports = { solveRecaptchaAudio };
