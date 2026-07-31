// captcha/handler.js
//
// ── Purpose in the pipeline ─────────────────────────────────────────────────
// This is the central "traffic controller" for CAPTCHA handling. It exposes
// a single function, `handleCaptcha(driver, record, stage, formContext,
// timeout)`, which `main.js` calls at two points while filling a contact
// form:
//   - pre-submit  — right before the form is submitted, to clear any
//     CAPTCHA blocking submission (e.g. a Turnstile widget embedded in the
//     form).
//   - post-submit — right after clicking submit, to clear any CAPTCHA that
//     appears as a secondary challenge (common with Cloudflare's bot
//     protection, which may only trigger after the POST request fires).
// `handleCaptcha` doesn't know how to solve any CAPTCHA itself — it asks
// `detector.js` what's on the page, then dispatches to the right specialist
// solver module and interprets/normalizes the result into one of three
// outcomes the caller (main.js) understands: 'clear', 'blocked', or 'retry'.
//
// ── How it works (decision tree) ────────────────────────────────────────
//   1. Ask `detectCaptchaState` (detector.js) whether a CAPTCHA is present
//      and what its rough `reason` label is (e.g. 'reCAPTCHA v2',
//      'hCaptcha iframe', 'Turnstile widget', 'Image CAPTCHA', ...).
//      If nothing is detected → return 'clear' immediately.
//   2. Image/math CAPTCHAs (`reason` contains "image") are always attempted
//      via OCR (`solveImageCaptcha`), *regardless* of CAPTCHA_POLICY,
//      because they're cheap/fast to try and there's no "manual wait"
//      fallback that makes sense for them (nobody's watching the headless
//      browser). Success → 'clear'; failure → 'blocked'.
//   3. If CAPTCHA_POLICY === 'block' (see config.js), any other detected
//      CAPTCHA immediately marks the record as CaptchaBlocked and returns
//      'blocked' — no solving is attempted at all.
//   4. If CAPTCHA_POLICY === 'auto', the `reason` string is pattern-matched
//      (via simple substring checks) to classify the CAPTCHA family and
//      route to the matching specialist:
//        - Cloudflare/Turnstile ('turnstile'/'cloudflare'/'cf ' in reason)
//          → first check if a token is already present (widget solved
//          itself silently), else call `waitForTurnstileAutoClear`
//          (turnstile.js) which clicks the checkbox if any and polls for
//          the challenge to disappear on its own (Turnstile is frequently
//          a low-friction "invisible" or single-click widget that clears
//          without real challenge-solving logic).
//        - hCaptcha ('hcaptcha'/'h-captcha' in reason) → `solveHcaptcha`
//          (hcaptcha.js, CNN-based tile solver).
//        - reCAPTCHA ('recaptcha' in reason) → `solveRecaptchaAudio`
//          (recaptcha.js, audio-challenge + Whisper transcription). If it
//          fails, treated as "likely rate-limited" and the whole record is
//          marked 'Skipped' + 'blocked' (rather than retried), since
//          retrying immediately against a rate limit rarely helps.
//        - Anything else → falls through to `solveImageCaptcha` as a last
//          resort attempt.
//      If none of the auto-solve branches succeed, it falls through to
//      step 5 (manual wait) rather than giving up outright.
//   5. Manual wait — poll `captchaSolved` (detector.js) every 2s up to
//      `timeout` ms (defaults to CAPTCHA_WAIT_TIMEOUT from config.js). This
//      exists for CAPTCHA_POLICY modes other than 'auto'/'block' (e.g. a
//      'manual' policy where a human is expected to solve it in a visible
//      browser window) and as the final fallback after failed auto-solve
//      attempts. Times out → 'retry' (caller will likely re-attempt with a
//      fresh browser/session).
//
// Every branch also writes progress/status info onto `record`
// (record.status, record.details, record.captcha_status) so the outcome is
// visible in the CSV/Sheet results written by result_tracker.js.
//
// ── Dependencies ────────────────────────────────────────────────────────
// - `./detector` — detects CAPTCHA presence/type and whether it's solved.
// - `./recaptcha` — `solveRecaptchaAudio`, audio-challenge solver for
//   reCAPTCHA v2 (spawns a Whisper transcription server).
// - `./turnstile` — `waitForTurnstileAutoClear`, clicks + polls Cloudflare
//   Turnstile widgets until they self-clear.
// - `./image_captcha` — `solveImageCaptcha`, OCR/math solver for generic
//   image and math CAPTCHAs (also handles CF7 quiz fields internally).
// - `./hcaptcha` — `solveHcaptcha`, CNN tile-matching solver for hCaptcha.
// - `../config` — `CAPTCHA_POLICY` ('auto' | 'block' | anything else →
//   falls through to manual wait) and `CAPTCHA_WAIT_TIMEOUT` (default
//   manual-wait timeout in ms).
// - Called by: `main.js`, once pre-submit and once post-submit, passing the
//   Selenium `driver`, the per-URL result `record`, the `stage` string, the
//   current `form` element as `formContext`, and `CAPTCHA_WAIT_TIMEOUT`.
'use strict';

const { detectCaptchaState, captchaSolved } = require('./detector');
const { solveRecaptchaAudio }               = require('./recaptcha');
const { waitForTurnstileAutoClear }         = require('./turnstile');
const { solveImageCaptcha }                 = require('./image_captcha');
const { solveHcaptcha }                     = require('./hcaptcha');
const { CAPTCHA_POLICY, CAPTCHA_WAIT_TIMEOUT } = require('../config');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// stage: 'pre-submit' | 'post-submit' (informational, used for logging and
// for the status strings written onto `record`).
// formContext: the Selenium element representing the contact form (or an
// iframe context), narrowing where detector.js looks for CAPTCHA markup.
async function handleCaptcha(driver, record, stage, formContext, timeout) {
  timeout = timeout || CAPTCHA_WAIT_TIMEOUT;
  const state = await detectCaptchaState(driver, formContext);
  if (!state.present) return 'clear';

  const reason = state.reason || 'CAPTCHA challenge';
  const isImageCaptcha = reason.toLowerCase().includes('image');

  // Image CAPTCHA (securimage, text-in-image) — always try OCR regardless of policy
  // (cheap, fast, and there's no sensible "manual wait" for a headless run).
  if (isImageCaptcha) {
    console.log(`   🖼️ Image CAPTCHA detected — trying OCR solver...`);
    if (await solveImageCaptcha(driver, formContext)) {
      record.captcha_status = `Auto-solved at ${stage}: ${reason}`;
      return 'clear';
    }
    console.log(`   ⚠️ Image OCR failed — skipping`);
    record.captcha_status = `Image OCR failed at ${stage}`;
    return 'blocked';
  }

  // 'block' policy: don't even attempt to solve — just report and bail out.
  if (CAPTCHA_POLICY === 'block') {
    console.log(`   🛑 CAPTCHA blocked at ${stage}: ${reason}`);
    record.status         = 'CaptchaBlocked';
    record.details        = `Blocked by ${reason} at ${stage}`;
    record.captcha_status = `Blocked at ${stage}: ${reason}`;
    return 'blocked';
  }

  // 'auto' policy: classify the reason string into a CAPTCHA family and
  // dispatch to the matching solver module.
  if (CAPTCHA_POLICY === 'auto') {
    console.log(`   🤖 Auto-solving CAPTCHA at ${stage}: ${reason}`);
    const isCF        = ['turnstile','cloudflare','cf '].some(w => reason.toLowerCase().includes(w));
    const isRecaptcha = reason.toLowerCase().includes('recaptcha');
    const isHcaptcha  = ['hcaptcha','h-captcha'].some(w => reason.toLowerCase().includes(w));

    if (isCF) {
      // First check if Turnstile is already solved (token present) — the
      // widget may complete its challenge silently in the background
      // (invisible/managed mode) without any visible interaction needed.
      const alreadySolved = await driver.executeScript(function() {
        var inp = document.querySelector('input[name="cf-turnstile-response"]');
        return inp && (inp.value || '').length > 10;
      }).catch(() => false);
      if (alreadySolved) {
        console.log('      ✅ Turnstile already solved (token present)');
        record.captcha_status = `Auto-cleared at ${stage}: ${reason}`;
        return 'clear';
      }
      // Otherwise click the checkbox (if visible) and poll until the
      // challenge disappears from the page — see turnstile.js for details.
      if (await waitForTurnstileAutoClear(driver, formContext)) {
        record.captcha_status = `Auto-cleared at ${stage}: ${reason}`;
        return 'clear';
      }
      // Turnstile challenges are often tied to a specific browser
      // fingerprint/session; if it won't clear, the recommended recovery is
      // a fresh browser session rather than continuing to retry in place.
      console.log(`   ⚠️ Turnstile not solved — retrying with fresh browser`);
      record.details        = `${reason} not solved at ${stage}`;
      record.captcha_status = `Not solved at ${stage}: ${reason}`;
      return 'retry';
    }

    if (isHcaptcha) {
      console.log(`   🤖 Solving hCaptcha with CNN at ${stage}...`);
      if (await solveHcaptcha(driver)) {
        record.captcha_status = `Auto-solved at ${stage}: ${reason}`;
        return 'clear';
      }
      console.log(`   ⚠️ hCaptcha not solved at ${stage} — retrying`);
      record.captcha_status = `Not solved at ${stage}: ${reason}`;
      record.details = `${reason} not solved at ${stage}`;
      return 'retry';
    }

    if (isRecaptcha) {
      if (await solveRecaptchaAudio(driver)) {
        record.captcha_status = `Auto-solved at ${stage}: ${reason}`;
        return 'clear';
      }
      // reCAPTCHA audio failures are usually due to Google rate-limiting the
      // audio challenge endpoint rather than a wrong transcription, so this
      // is treated as a terminal "Skipped" rather than something worth
      // retrying immediately.
      console.log(`   ⚠️ reCAPTCHA not solved at ${stage} (likely rate-limited), skipping`);
      record.status         = 'Skipped';
      record.details        = `${reason} rate-limited at ${stage}`;
      record.captcha_status = `Rate-limited at ${stage}: ${reason}`;
      return 'blocked';
    }

    // Image CAPTCHA — try for any non-CF/non-reCAPTCHA reason
    // (catch-all last resort for reasons that didn't match a known family,
    // e.g. generic "Captcha challenge text").
    console.log(`   🖼️ Trying image CAPTCHA solver...`);
    if (await solveImageCaptcha(driver, formContext)) {
      record.captcha_status = `Auto-solved at ${stage}: ${reason}`;
      return 'clear';
    }

    console.log(`   ⚠️ Auto-solve failed at ${stage}, falling back to manual wait`);
  }

  // Manual wait — final fallback (used when policy isn't 'auto'/'block', or
  // when 'auto' solving above failed but we still want to give it a chance
  // to clear on its own / be solved by a human watching a visible browser).
  // Polls captchaSolved() every 2s until `timeout` elapses.
  console.log(`   🔐 CAPTCHA at ${stage}: ${reason}. Waiting up to ${timeout/1000}s...`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await captchaSolved(driver)) {
      console.log('      ✅ CAPTCHA solved');
      record.captcha_status = `Solved manually at ${stage}: ${reason}`;
      return 'clear';
    }
    await sleep(2000);
  }

  console.log('   ⏭️ CAPTCHA not solved in time, skipping');
  record.details        = `${reason} not solved within ${timeout/1000}s at ${stage}`;
  record.captcha_status = `Not solved within ${timeout/1000}s at ${stage}: ${reason}`;
  return 'retry';
}

module.exports = { handleCaptcha };
