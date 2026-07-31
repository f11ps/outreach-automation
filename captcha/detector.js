// captcha/detector.js
//
// ── Purpose in the pipeline ─────────────────────────────────────────────────
// This file is the "eyes" of the CAPTCHA subsystem. It does NOT solve any
// CAPTCHA — it only looks at the current page (and, when given one, a
// narrower `formContext` element such as an iframe body) and answers two
// questions:
//
//   1. detectCaptchaState(driver, formContext) — "Is a CAPTCHA/challenge
//      present right now, and if so, what kind (roughly)?" Returns
//      { present: boolean, reason: string }. The `reason` string is a loose,
//      human-readable label (e.g. 'reCAPTCHA v2', 'hCaptcha iframe',
//      'Turnstile widget', 'Image CAPTCHA', 'Cloudflare interstitial') that
//      `captcha/handler.js` later pattern-matches (via .includes()) to decide
//      which solver module to invoke. It is deliberately checked in a
//      specific priority order: reCAPTCHA → hCaptcha → Cloudflare/Turnstile →
//      Cloudflare challenge URL/interstitial text → CF7/math CAPTCHA →
//      generic image CAPTCHA.
//
//   2. captchaSolved(driver) — "Has the CAPTCHA that was previously detected
//      now been solved?" Used for polling loops (e.g. manual-solve wait in
//      handler.js, and the Turnstile auto-clear loop in turnstile.js).
//
// ── How it works ─────────────────────────────────────────────────────────
// Detection is done purely through DOM/selector inspection via Selenium
// (`By.css`) and small `driver.executeScript` snippets run in-page, no
// network calls or ML involved here. Most checks look for:
//   - Known iframe `src` substrings (e.g. `recaptcha`, `hcaptcha`,
//     `turnstile`, `challenges.cloudflare.com`) combined with visibility
//     checks (`isDisplayed()` / bounding-rect size) so hidden/zero-size
//     iframes (common for "invisible" widgets that aren't actually shown)
//     don't cause false positives.
//   - Known CSS classes/ids for widgets (`.g-recaptcha`, `.h-captcha`,
//     `.cf-turnstile`, `#challenge-form`, etc).
//   - Page text/title heuristics for Cloudflare's interstitial "checking
//     your browser" / "just a moment" pages, which don't use a widget at all.
//   - Contact Form 7 "quiz" (math) fields and generic math-question labels
//     scanned across all visible text inputs.
//   - Generic "captcha-looking" `<img>` + `<input>` pairs for classic
//     image/OCR CAPTCHAs.
//
// ── Dependencies ────────────────────────────────────────────────────────
// - Depends only on `selenium-webdriver` (for `By` locators).
// - Consumed by: `captcha/handler.js` (decides which solver to call based on
//   `reason`, and polls `captchaSolved` while waiting for a manual solve),
//   and `captcha/turnstile.js` (`waitForTurnstileAutoClear` re-checks
//   `detectCaptchaState` in a loop until the Turnstile challenge disappears).
'use strict';

const { By } = require('selenium-webdriver');

// ── selPresent ──────────────────────────────────────────────────────────────
// Small helper: "does selector `selector` match anything inside `ctx`?"
// `ctx` can be the driver itself (whole page) or a narrower search root
// (e.g. a specific form's containing element) — this lets detection be
// scoped to just the relevant form when a `formContext` is supplied.
// If `visible` is true, at least one matched element must also be
// currently displayed (guards against CAPTCHA markup that exists in the
// DOM but is hidden/inactive).
async function selPresent(ctx, selector, visible = false) {
  try {
    const els = await ctx.findElements(By.css(selector));
    if (!els.length) return false;
    if (!visible) return true;
    for (const e of els) { if (await e.isDisplayed()) return true; }
    return false;
  } catch (_) { return false; }
}

// ── isRecaptchaV2Visible ──────────────────────────────────────────────────
// reCAPTCHA v2 gets its own dedicated, more careful check (rather than a
// simple selector list) because it has multiple visual states that all need
// to be recognized as "present":
//   1. The challenge popup ("bframe") is open — grid of images to solve.
//   2. A challenge iframe is showing (alternate detection via title attr).
//   3. Only the checkbox ("anchor" iframe) is showing and it is NOT yet
//      checked — have to switch INTO that iframe to inspect the checkbox
//      state, then switch back out.
//   4. A `.g-recaptcha` placeholder widget is on the page with a real
//      rendered size (filters out zero-size/invisible instances).
// Size checks (rect.width/height) are used throughout to reject invisible
// or not-yet-rendered widgets, which would otherwise cause the detector to
// think a CAPTCHA is present when it isn't actually shown to a user.
async function isRecaptchaV2Visible(driver) {
  try {
    // Check if bframe (challenge popup) is present — means reCAPTCHA is active
    const bframes = await driver.findElements(By.css("iframe[src*='recaptcha'][src*='bframe']"));
    for (const f of bframes) {
      if (await f.isDisplayed()) return true;
    }
    // Check challenge iframes
    const challenges = await driver.findElements(By.css("iframe[title*='recaptcha challenge']"));
    for (const f of challenges) {
      if (await f.isDisplayed()) return true;
    }
    // Check anchor iframe (unchecked checkbox)
    const frames = await driver.findElements(By.css("iframe[src*='recaptcha'][src*='anchor']"));
    for (const iframe of frames) {
      if (!(await iframe.isDisplayed())) continue;
      const rect = await iframe.getRect();
      if (rect.width < 60 || rect.height < 30) continue;
      try {
        // Must switch context into the iframe to read the checkbox DOM,
        // then always switch back to defaultContent before continuing.
        await driver.switchTo().frame(iframe);
        const unchecked = await driver.findElements(By.css('#recaptcha-anchor,.recaptcha-checkbox-border'));
        await driver.switchTo().defaultContent();
        if (unchecked.length) return true;
      } catch (_) { try { await driver.switchTo().defaultContent(); } catch (_2) {} }
    }
    const widgets = await driver.findElements(By.css('.g-recaptcha'));
    for (const w of widgets) {
      if (!(await w.isDisplayed())) continue;
      const rect = await w.getRect();
      if (rect.width > 60 && rect.height > 30) return true;
    }
  } catch (_) { try { await driver.switchTo().defaultContent(); } catch (_2) {} }
  return false;
}

// ── detectCaptchaState ──────────────────────────────────────────────────────
// The main entry point. Runs a priority-ordered chain of checks and returns
// as soon as the first one matches. Order matters: reCAPTCHA and hCaptcha
// are checked before generic Cloudflare/Turnstile checks and before the
// broad "any math/image looking field" checks, so more specific/confident
// signals win over generic ones.
async function detectCaptchaState(driver, formContext) {
  const ctx = formContext || driver;

  // 1. reCAPTCHA v2 (checkbox or image challenge) — most specific check.
  if (await isRecaptchaV2Visible(driver)) return { present: true, reason: 'reCAPTCHA v2' };

  // 2. hCaptcha — iframe / widget / hidden response field with no value yet.
  const hcaptchaChecks = [
    ['hCaptcha iframe',   "iframe[title*='hCaptcha']",             true],
    ['hCaptcha iframe',   "iframe[src*='hcaptcha']",               true],
    ['hCaptcha widget',   '.h-captcha',                            true],
    ['hCaptcha response', "textarea[name='h-captcha-response']",   false],
  ];
  for (const [reason, sel, vis] of hcaptchaChecks) {
    if (await selPresent(ctx, sel, vis)) {
      // Special case: the hidden response textarea can match even after the
      // CAPTCHA has already been solved (it just holds the token). If it
      // already has a non-empty value, treat it as solved and stop checking
      // hCaptcha (break out of this loop and fall through to later checks
      // rather than reporting "present").
      try {
        const resp = await ctx.findElements(By.css("textarea[name='h-captcha-response']"));
        if (resp.length && (await resp[0].getAttribute('value') || '').trim()) break;
      } catch (_) {}
      return { present: true, reason };
    }
  }

  // 3. Cloudflare Turnstile / generic Cloudflare challenge widgets.
  const cfChecks = [
    ['Turnstile widget',           '.cf-turnstile',                              true],
    ['Turnstile iframe',           "iframe[src*='turnstile']",                   true],
    ['Cloudflare iframe',          "iframe[src*='challenges.cloudflare.com']",   true],
    ['CF challenge form',          '#challenge-form',                            false],
    ['CF challenge stage',         '#challenge-stage',                           false],
    ['CF challenge running',       '#challenge-running',                         false],
    ['CF widget id',               '[id*="cf-chl-widget"]',                      true],
    ['CF widget class',            '[class*="cf-chl"]',                          true],
  ];
  for (const [reason, sel, vis] of cfChecks) {
    if (await selPresent(ctx, sel, vis)) return { present: true, reason };
  }

  // 4. Cloudflare's URL-based challenge (redirect to a challenge-platform
  //    path) — no widget markup needed, just inspect the current URL.
  try {
    const url = (await driver.getCurrentUrl() || '').toLowerCase();
    if (['/cdn-cgi/challenge-platform/','/cdn-cgi/l/chk_jschl'].some(m => url.includes(m)))
      return { present: true, reason: 'Cloudflare challenge URL' };
  } catch (_) {}

  // 5. Cloudflare's text-only interstitial ("Just a moment...", "Checking
  //    your browser...") — detected by matching known phrases in the page
  //    body/title, then cross-checked against the word "cloudflare"
  //    appearing somewhere (body/title/full HTML) to reduce false positives
  //    from unrelated pages that happen to contain one of the phrases.
  //    Also checks for generic "prove you're human" wording used by other
  //    anti-bot challenge pages that aren't Cloudflare-branded.
  try {
    const body  = (await driver.executeScript("return document.body ? document.body.innerText.toLowerCase() : '';") || '');
    const title = (await driver.getTitle() || '').toLowerCase();
    const cfPhrases = ['just a moment','checking your browser before accessing',
      'attention required','please enable cookies','verify you are human',
      'security check to access','checking if the site connection is secure'];
    if (cfPhrases.some(p => body.includes(p) || title.includes(p))) {
      const html = (await driver.getPageSource() || '').toLowerCase();
      if (['cloudflare'].some(w => body.includes(w) || title.includes(w) || html.includes(w)))
        return { present: true, reason: 'Cloudflare interstitial' };
    }
    if (["i am human","i'm human","not a robot","robot check"].some(p => body.includes(p)))
      return { present: true, reason: 'Captcha challenge text' };
  } catch (_) {}

  // 6. Contact Form 7 "Quiz" field — a text math question rendered as a
  //    plain <label> next to a `wpcf7-quiz` input. Reported with the same
  //    'Image CAPTCHA' reason as generic math/OCR CAPTCHAs so handler.js
  //    routes it to solveImageCaptcha (which internally also has CF7-quiz
  //    specific handling — see image_captcha.js's solveMathCaptcha).
  try {
    const cf7quiz = await driver.executeScript(function() {
      var inp = document.querySelector('input.wpcf7-quiz,[name*="quiz-"]');
      if (!inp || inp.offsetParent === null) return null;
      var lbl = inp.closest('label');
      var question = lbl ? lbl.innerText.trim() : '';
      if (!question) {
        var qlbl = document.querySelector('.wpcf7-quiz-label');
        question = qlbl ? qlbl.innerText.trim() : '';
      }
      return { question: question, hasInput: true };
    });
    if (cf7quiz && cf7quiz.hasInput) return { present: true, reason: 'Image CAPTCHA' };
  } catch (_) {}

  // 7. Generic math CAPTCHA — scans every visible plain text/number input on
  //    the page, resolves each one's associated label text (via <label
  //    for>, aria-label, previous sibling, or parent text), and looks for
  //    either an actual arithmetic expression (e.g. "3 + 4") or spelled-out
  //    math/anti-spam wording ("what is", "solve", "anti-spam" etc.), or
  //    CAPTCHA-ish name/id attributes. Also reported as 'Image CAPTCHA' so
  //    it's routed to the same math/OCR solver path.
  try {
    const mathFound = await driver.executeScript(function() {
      function getLabel(el) {
        if (el.id) { var l=document.querySelector('label[for="'+el.id+'"]'); if(l) return l.innerText; }
        var a=el.getAttribute('aria-label'); if(a) return a;
        var prev=el.previousElementSibling; if(prev&&prev.innerText) return prev.innerText;
        var par=el.parentElement; if(par&&par.innerText) return par.innerText;
        return el.placeholder||'';
      }
      var inputs = Array.from(document.querySelectorAll('input[type=text],input[type=number],input:not([type])'));
      for (var i=0; i<inputs.length; i++) {
        var el=inputs[i];
        if (el.offsetParent===null) continue;
        var q=getLabel(el).toLowerCase();
        var name=(el.name||'').toLowerCase();
        var id=(el.id||'').toLowerCase();
        // Check label for math question
        if (/\d+\s*[+\-*\/x×÷]\s*\d+/.test(q) ||
            /(plus|minus|times|divided|multiplied|add|subtract)/.test(q) ||
            /what is|calculate|solve|correct answer|enter.*answer|spam.*protect|anti.?spam/.test(q) ||
            /captcha|verify|human|robot|math|spam|answer/.test(name+' '+id)) {
          return true;
        }
      }
      return false;
    });
    if (mathFound) return { present: true, reason: 'Image CAPTCHA' };
  } catch (_) {}

  // 8. Generic image CAPTCHA — needs BOTH a plausible captcha <img> (by
  //    src/id/class keyword match, excluding obvious non-captcha images like
  //    logos/icons/avatars, and within a sane pixel-size range) AND a
  //    plausible captcha <input> nearby (by name/id keyword match) to be
  //    reported, reducing false positives from pages that just happen to
  //    have an image or an input with "verify" in its name but not both.
  try {
    const found = await driver.executeScript(`
      var IMG_SELS = ['img[src*="captcha" i]','img[id*="captcha" i]','img[class*="captcha" i]',
                      'img[src*="securimage" i]','img[src*="verify" i]','img[src*="security" i]'];
      var INP_SELS = ['input[name*="captcha" i]','input[id*="captcha" i]',
                      'input[name*="securimage" i]','input[name*="security_code" i]',
                      'input[name*="verify" i]'];
      function isCaptchaImg(el) {
        var combined = (el.src||'')+' '+(el.alt||'')+' '+(el.className||'')+' '+(el.id||'');
        combined = combined.toLowerCase();
        if (!['captcha','securimage','verify','security_code'].some(function(s){ return combined.indexOf(s)!==-1; })) return false;
        if (['logo','icon','banner','avatar','social'].some(function(r){ return combined.indexOf(r)!==-1; })) return false;
        var w=el.offsetWidth,h=el.offsetHeight;
        return w>=30 && h>=15 && h<=150 && w<=600;
      }
      var hasImg = IMG_SELS.some(function(s){
        return Array.from(document.querySelectorAll(s)).some(function(e){ return e.offsetParent!==null && isCaptchaImg(e); });
      });
      var hasInp = INP_SELS.some(function(s){
        return Array.from(document.querySelectorAll(s)).some(function(e){ return e.offsetParent!==null; });
      });
      return hasImg && hasInp;
    `);
    if (found) return { present: true, reason: 'Image CAPTCHA' };
  } catch (_) {}

  // Nothing matched — page is (as far as we can tell) CAPTCHA-free.
  return { present: false, reason: '' };
}

// ── captchaSolved ────────────────────────────────────────────────────────
// Used to poll whether a previously-detected CAPTCHA has since been solved
// (either automatically or by a human, depending on CAPTCHA_POLICY in
// handler.js). Two independent signals are checked:
//   1. reCAPTCHA's checkbox specifically — switch into the anchor iframe and
//      look for the "checked" class/aria-checked attribute.
//   2. Any of the standard hidden response fields (reCAPTCHA, hCaptcha,
//      Turnstile) having a non-empty token value — this covers cases where
//      the widget solved itself without a visible checkbox state change
//      (e.g. invisible/managed challenges).
async function captchaSolved(driver) {
  try {
    await driver.switchTo().defaultContent();
    const frames = await driver.findElements(By.css("iframe[src*='recaptcha'][src*='anchor']"));
    for (const iframe of frames) {
      if ((await iframe.getRect()).width < 60) continue;
      try {
        await driver.switchTo().frame(iframe);
        const checked = await driver.findElements(By.css(".recaptcha-checkbox-checked,[aria-checked='true']"));
        await driver.switchTo().defaultContent();
        if (checked.length) return true;
      } catch (_) { try { await driver.switchTo().defaultContent(); } catch (_2) {} }
    }
  } catch (_) { try { await driver.switchTo().defaultContent(); } catch (_2) {} }
  try {
    const tokens = await driver.findElements(By.css(
      "textarea[name='g-recaptcha-response'],textarea[name='h-captcha-response'],input[name='cf-turnstile-response']"));
    for (const t of tokens) {
      if ((await t.getAttribute('value') || '').trim()) return true;
    }
  } catch (_) {}
  return false;
}

module.exports = { detectCaptchaState, captchaSolved, isRecaptchaV2Visible };
