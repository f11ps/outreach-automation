// captcha/turnstile.js
//
// ── Purpose in the pipeline ─────────────────────────────────────────────────
// Handles Cloudflare Turnstile, Cloudflare's CAPTCHA replacement. Unlike
// reCAPTCHA or hCaptcha, Turnstile very often requires no real "puzzle
// solving" at all — in its common "managed"/"non-interactive" modes it just
// runs a background browser-fingerprint/JS challenge and clears itself
// within a few seconds, and even its "interactive" mode is usually just a
// single checkbox click (no image grid, no audio). Because of that, this
// module doesn't attempt to defeat any challenge logic — it only:
//   1. Optionally clicks the checkbox, if one is visibly rendered inside the
//      Turnstile iframe (some deployments show a clickable widget instead of
//      running fully invisibly).
//   2. Polls the page (via detector.js) waiting for the challenge to
//      disappear on its own, re-clicking periodically in case the first
//      click didn't register or the widget re-rendered.
// A third helper, `injectTurnstileToken`, exists to directly set a
// `cf-turnstile-response` token value if one is already available/obtained
// through some other means (not exercised by the current auto-clear flow,
// but exported for use elsewhere / future use).
//
// ── How it works ─────────────────────────────────────────────────────────
// - `tryClickTurnstileCheckbox`: finds visible iframes whose `src` contains
//   'turnstile' or 'challenges.cloudflare', switches into the first one
//   found, and tries a short list of selectors (checkbox input, elements
//   with "checkbox" in id/class, `<label>`, finally the whole `<body>`) to
//   find something clickable — Turnstile's internal markup isn't guaranteed
//   stable across versions, so this is a best-effort cascade rather than one
//   exact selector. Clicks via `executeScript` (`el.click()`) rather than a
//   native Selenium click, then always switches back to defaultContent().
// - `waitForTurnstileAutoClear`: the main exported entry point used by
//   `captcha/handler.js`. Clicks the checkbox once up front, then loops up
//   to `attempts` times (default 15, every `delay` ms = 3s → ~45s total),
//   re-running `detectCaptchaState` (detector.js) each iteration. As soon as
//   detector.js no longer reports a Cloudflare/Turnstile challenge present,
//   it's considered cleared. Every 5th iteration it retries the checkbox
//   click, in case the widget reset or a new challenge instance appeared.
// - `injectTurnstileToken`: directly writes a token string into any
//   `cf-turnstile-response` hidden input(s) on the page and fires a
//   `change` event so any listening form-validation JS picks it up.
//
// ── Dependencies ────────────────────────────────────────────────────────
// - `selenium-webdriver` (`By`) for locating iframes/elements.
// - `./detector` (`detectCaptchaState`) — required lazily inside
//   `waitForTurnstileAutoClear` (not at module top) to poll whether the
//   Cloudflare/Turnstile challenge is still present.
// - Used by: `captcha/handler.js`, which calls `waitForTurnstileAutoClear`
//   when `detector.js` reports a Cloudflare/Turnstile-flavored `reason`
//   (after first checking directly for an existing token itself).
'use strict';

const { By } = require('selenium-webdriver');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Switch back to the top-level document context, swallowing any error (e.g.
// if we're already there or the driver session is in an odd state).
async function sw(driver) {
  try { await driver.switchTo().defaultContent(); } catch (_) {}
}

// Directly sets a solved Turnstile token onto the page's hidden response
// field(s), bypassing the need to interact with the widget at all. Useful
// if a token was obtained out-of-band (e.g. from an external solving
// service) — not called elsewhere in this codebase currently, but exported
// for that purpose.
async function injectTurnstileToken(driver, token) {
  await driver.executeScript(`
    document.querySelectorAll('input[name="cf-turnstile-response"]').forEach(function(el) {
      el.value = arguments[0];
      el.dispatchEvent(new Event('change', {bubbles:true}));
    });
  `, token);
}

// Looks for a visible Turnstile/Cloudflare-challenge iframe and tries to
// click something inside it that resembles a checkbox. Tries several
// selector fallbacks in order of specificity (real checkbox input → id/class
// containing "checkbox" → label → finally just the iframe body, since some
// Turnstile layouts make the entire widget body clickable).
async function tryClickTurnstileCheckbox(driver) {
  try {
    await sw(driver);
    const iframes = await driver.findElements(By.css(
      "iframe[src*='turnstile'],iframe[src*='challenges.cloudflare']"));
    for (const iframe of iframes) {
      if (!(await iframe.isDisplayed())) continue;
      try {
        await driver.switchTo().frame(iframe);
        for (const sel of ["input[type='checkbox']","[id*='checkbox']","[class*='checkbox']","label","body"]) {
          const els = await driver.findElements(By.css(sel));
          if (els.length) {
            await driver.executeScript('arguments[0].click();', els[0]);
            console.log('      🖱️ Clicked Turnstile checkbox');
            await sw(driver);
            return true;
          }
        }
        await sw(driver);
      } catch (_) { await sw(driver); }
    }
  } catch (_) { await sw(driver); }
  return false;
}

// Main exported solver: click once, then poll up to `attempts` times
// (default 15 × 3000ms delay ≈ 45s) for the challenge to clear on its own,
// per detector.js's detectCaptchaState. Re-clicks the checkbox every 5th
// iteration as a safety net in case the widget re-rendered or the first
// click missed. `formContext` is passed straight through to
// detectCaptchaState so the check stays scoped to the relevant form/iframe.
async function waitForTurnstileAutoClear(driver, formContext, attempts = 15, delay = 3000) {
  const { detectCaptchaState } = require('./detector');
  await tryClickTurnstileCheckbox(driver);
  for (let i = 0; i < attempts; i++) {
    await sleep(delay);
    const state = await detectCaptchaState(driver, formContext);
    if (!state.present) { console.log('      ✅ Cloudflare Turnstile auto-cleared'); return true; }
    if (i > 0 && i % 5 === 0) await tryClickTurnstileCheckbox(driver);
  }
  return false;
}

module.exports = { injectTurnstileToken, tryClickTurnstileCheckbox, waitForTurnstileAutoClear };
