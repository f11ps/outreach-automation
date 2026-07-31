// ════════════════════════════════════════════════════════════════════════════
// form_types.js
//
// PURPOSE / ROLE IN THE PIPELINE
//   Where form_finder.js answers "where is the form element on this page?",
//   this file answers "what *kind* of form is it, and does it need any
//   special handling before we can fill/submit it?" Different form
//   technologies (WordPress plugins, third-party embeds, SPA-rendered forms,
//   multi-step wizards) load differently and need different waiting/prep
//   strategies before fields.js can reliably fill them and submitter.js can
//   submit them.
//
//   In the current main.js pipeline this file is used narrowly — only
//   `removeBlockers()` is imported and called directly (to clear cookie/
//   popup overlays before scoring/filling a form). The rest of this module
//   (detectFormType, waitForHubspot, findTypeformIframe/findJotformIframe,
//   isMultiStep/clickNextStep, findFormAllTypes, etc.) forms a more complete
//   "detect + prep" toolkit that is exported for use by other call sites /
//   future wiring, even where main.js doesn't currently invoke every one of
//   them directly.
//
// HOW IT WORKS (high level)
//   - detectFormType(driver): inspects the page's HTML/URL for known
//     signatures (e.g. "wpcf7" → Contact Form 7, "hsforms"/"hubspot" →
//     HubSpot, "typeform" → Typeform iframe, etc.) and returns a short type
//     string ('cf7', 'wpforms', 'gravity', 'ninja', 'formidable',
//     'elementor', 'hubspot', 'typeform', 'jotform', 'formstack', 'cognito',
//     'pardot', 'multistep', 'formless', 'standard', or 'unknown').
//   - waitForForm(driver, timeout): polls until at least one <form> or a
//     couple of obviously-form-like inputs exist in the DOM — used to give
//     slow/late-rendering pages a chance to finish before giving up.
//   - waitForHubspot(driver, timeout): HubSpot embeds load their form via an
//     async JS SDK, so this polls specifically for HubSpot's known form
//     markup/class names to appear.
//   - findTypeformIframe / findJotformIframe: these two form builders are
//     always iframe-embedded, so these just locate the iframe element itself
//     (by src pattern) so the caller can switch WebDriver context into it.
//   - isMultiStep / clickNextStep: multi-step "wizard" forms show one step
//     at a time; isMultiStep() detects step/wizard/page markup, and
//     clickNextStep() finds and clicks a "Next/Continue/Proceed" button to
//     advance to the next step.
//   - scrollAndReveal(driver): scrolls the page to trigger lazy-loading of
//     forms that only mount once scrolled into view.
//   - removeBlockers(driver): hides cookie/consent/popup/modal overlays that
//     would otherwise sit on top of the form and interfere with visibility
//     checks, clicks, or screenshots. (This is the function main.js actually
//     imports and calls.)
//   - findFormAllTypes(driver): a convenience orchestrator that clears
//     blockers, detects the form type, and — depending on the type — waits
//     for HubSpot to finish loading, switches into a Typeform/JotForm
//     iframe, or scrolls to reveal a lazily-rendered form. Returns
//     `{ type, form, inIframe }` (note: `form` is always `null` here since
//     this file only classifies/prepares — actually locating the <form>
//     WebElement is form_finder.js's job).
//
// DEPENDENCIES / USED BY
//   - Depends on: selenium-webdriver (`By`) for locating iframe elements,
//     and driver.executeScript() for in-page DOM inspection.
//   - Used by: main.js imports and calls `removeBlockers()` directly before
//     handing off to form_finder.js's findContactForm(). The overlay-hiding
//     logic here is functionally very similar to form_finder.js's own
//     clearOverlays() (slightly larger selector list, covering modal/overlay
//     classes too) — both exist to solve the same "banner sitting on top of
//     the form" problem from two different modules.
//   - Conceptually paired with form_finder.js: form_finder.js locates *which*
//     DOM element is the form; this file classifies *what kind* of form it
//     is and preps the page for it. The `type` string this file produces is
//     intended to inform how fields.js fills fields and how submitter.js
//     submits (e.g. HubSpot/Typeform/JotForm forms behave differently than a
//     plain native <form>).
// ════════════════════════════════════════════════════════════════════════════

// form_types.js
// Handles ALL contact form types found on the web:
//
// TYPE 1: Native HTML <form> — standard, WordPress, custom
// TYPE 2: WordPress plugins — WPForms, CF7, Gravity Forms, Ninja Forms, Formidable
// TYPE 3: Third-party embeds — HubSpot, Typeform, JotForm, Cognito, Formstack
// TYPE 4: SPA/React/Vue/Angular — no <form> tag, inputs outside form
// TYPE 5: Multi-step forms — wizard style, next/prev buttons
// TYPE 6: Iframe-embedded forms — form inside iframe
// TYPE 7: Shadow DOM forms — web components
// TYPE 8: Elementor/Divi/Beaver Builder page builder forms

'use strict';

const { By } = require('selenium-webdriver');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Detect form type from page ────────────────────────────────────────────────
// Runs a single in-page script that checks the (lowercased) page HTML for
// known plugin/library signatures, in priority order: WordPress plugins
// first, then third-party embeds, then structural heuristics (multi-step
// markup, formless SPA inputs, plain <form> presence). Returns a short type
// string, or 'unknown' if nothing matched (or the script itself failed).
async function detectFormType(driver) {
  try {
    return await driver.executeScript(`
      var html = document.documentElement.innerHTML.toLowerCase();
      var url  = window.location.href.toLowerCase();

      // WordPress plugins
      if (html.indexOf('wpcf7') !== -1 || html.indexOf('contact-form-7') !== -1)
        return 'cf7';
      if (html.indexOf('wpforms') !== -1 || html.indexOf('wpforms-form') !== -1)
        return 'wpforms';
      if (html.indexOf('gform_wrapper') !== -1 || html.indexOf('gravityforms') !== -1)
        return 'gravity';
      if (html.indexOf('nf-form') !== -1 || html.indexOf('ninja-forms') !== -1)
        return 'ninja';
      if (html.indexOf('frm_form') !== -1 || html.indexOf('formidable') !== -1)
        return 'formidable';
      if (html.indexOf('elementor-form') !== -1)
        return 'elementor';

      // Third-party embeds
      if (html.indexOf('hsforms') !== -1 || html.indexOf('hubspot') !== -1 ||
          html.indexOf('hs-form') !== -1)
        return 'hubspot';
      if (html.indexOf('typeform') !== -1)
        return 'typeform';
      if (html.indexOf('jotform') !== -1)
        return 'jotform';
      if (html.indexOf('formstack') !== -1)
        return 'formstack';
      if (html.indexOf('cognito') !== -1 && html.indexOf('form') !== -1)
        return 'cognito';
      if (html.indexOf('pardot') !== -1)
        return 'pardot';

      // Multi-step: look for step/page/wizard markers inside any <form>
      var forms = document.querySelectorAll('form');
      for (var i=0; i<forms.length; i++) {
        var f = forms[i];
        if (f.querySelector('[data-step],[data-page],[class*="step"],[class*="wizard"],[class*="multi"]'))
          return 'multistep';
      }

      // SPA/Formless: 2+ visible, non-hidden inputs that live outside any
      // <form> element strongly suggests a framework-rendered contact
      // section without a real <form> wrapper.
      var inputs = document.querySelectorAll('input:not([type=hidden]),textarea');
      var outsideForm = Array.from(inputs).filter(function(el){
        return el.offsetParent !== null && !el.closest('form');
      });
      if (outsideForm.length >= 2) return 'formless';

      // Standard HTML form
      if (document.querySelector('form')) return 'standard';

      return 'unknown';
    `);
  } catch (_) { return 'unknown'; }
}

// ── Wait for dynamic form to appear ──────────────────────────────────────────
// Polls (every 400ms, up to `timeout`ms) until either a <form> exists or
// there are at least 2 plausible contact-style inputs on the page. Used to
// give slow/late-rendering (JS-heavy) pages a chance to finish before the
// caller gives up on finding a form.
async function waitForForm(driver, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const found = await driver.executeScript(`
        var forms = document.querySelectorAll('form');
        var inputs = document.querySelectorAll('input[type=email],input[type=text],textarea');
        return forms.length > 0 || inputs.length >= 2;
      `);
      if (found) return true;
    } catch (_) {}
    await sleep(400);
  }
  return false;
}

// ── Handle HubSpot forms (loaded via JS SDK) ──────────────────────────────────
// HubSpot embeds render asynchronously via their own JS SDK (the initial
// page HTML may only contain a placeholder div), so this polls specifically
// for HubSpot's known form class names / an input inside them, rather than
// relying on the generic waitForForm() above.
async function waitForHubspot(driver, timeout = 8000) {
  console.log('      🔄 Waiting for HubSpot form to load...');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const ready = await driver.executeScript(`
        return !!document.querySelector('.hs-form,form.hs-form,[class*="hs-form"] input');
      `);
      if (ready) { console.log('      ✅ HubSpot form loaded'); return true; }
    } catch (_) {}
    await sleep(500);
  }
  return false;
}

// ── Handle Typeform (iframe-based) ────────────────────────────────────────────
// Typeform forms are always embedded via an <iframe src="...typeform...">;
// this just locates that iframe element so the caller can switch into it.
async function findTypeformIframe(driver) {
  try {
    const iframes = await driver.findElements(By.css('iframe[src*="typeform"]'));
    if (iframes.length) {
      console.log('      📋 Typeform iframe detected');
      return iframes[0];
    }
  } catch (_) {}
  return null;
}

// ── Handle JotForm (iframe-based) ─────────────────────────────────────────────
// Same idea as findTypeformIframe(), but for JotForm's iframe embeds.
async function findJotformIframe(driver) {
  try {
    const iframes = await driver.findElements(By.css('iframe[src*="jotform"]'));
    if (iframes.length) {
      console.log('      📋 JotForm iframe detected');
      return iframes[0];
    }
  } catch (_) {}
  return null;
}

// ── Handle multi-step forms ───────────────────────────────────────────────────
// Checks whether the given form element contains step/page/wizard markers,
// or more than one "page"/"slide"-classed child — both are typical of
// wizard-style forms that reveal one step at a time.
async function isMultiStep(form, driver) {
  try {
    return await driver.executeScript(`
      var f = arguments[0];
      return !!(f.querySelector('[data-step],[data-page],[class*="step"],[class*="wizard"]') ||
                f.querySelectorAll('[class*="page"],[class*="slide"]').length > 1);
    `, form);
  } catch (_) { return false; }
}

// Finds a visible button/input/role=button whose text/value/aria-label looks
// like a "go to next step" control (Next/Continue/Proceed/Forward) and
// clicks it. Used to advance multi-step forms one step at a time.
async function clickNextStep(driver) {
  try {
    const clicked = await driver.executeScript(`
      var btns = Array.from(document.querySelectorAll('button,input[type=button],[role=button]'));
      var next = btns.find(function(b){
        var t = (b.innerText||b.value||b.getAttribute('aria-label')||'').toLowerCase();
        return t.indexOf('next') !== -1 || t.indexOf('continue') !== -1 ||
               t.indexOf('proceed') !== -1 || t.indexOf('forward') !== -1;
      });
      if (next && next.offsetParent !== null) { next.click(); return true; }
      return false;
    `);
    if (clicked) {
      console.log('      ➡️ Clicked Next step');
      await sleep(1000);
      return true;
    }
  } catch (_) {}
  return false;
}

// ── Scroll form into view and trigger lazy load ───────────────────────────────
// Scrolls partway down the page and back to the top; many sites only mount
// (or animate in) their contact form once it's scrolled near the viewport,
// so this nudge helps trigger that before we try to detect/fill the form.
async function scrollAndReveal(driver) {
  try {
    await driver.executeScript(`
      // Scroll to middle of page to trigger lazy-loaded forms
      window.scrollTo(0, document.body.scrollHeight * 0.4);
    `);
    await sleep(800);
    await driver.executeScript(`window.scrollTo(0, 0);`);
    await sleep(300);
  } catch (_) {}
}

// ── Remove overlays/popups that block form ────────────────────────────────────
// Hides cookie/consent/popup/modal/overlay elements that are fixed or
// absolutely positioned (i.e. actually capable of visually covering the
// page/form), and restores body/html scrolling in case a modal had locked
// it. This is the function main.js calls directly, right before handing off
// to form_finder.js's findContactForm(). It targets a broader set of
// selectors (adds modal/overlay/lightbox classes) than form_finder.js's own
// clearOverlays(), which covers a similar but not identical case.
async function removeBlockers(driver) {
  try {
    await driver.executeScript(`
      // Remove cookie banners, popups, overlays
      var sels = [
        '[class*="cookie"]','[class*="gdpr"]','[class*="consent"]',
        '[class*="popup"]','[class*="modal"]','[class*="overlay"]',
        '[id*="cookie"]','[id*="popup"]','[id*="modal"]',
        '.pum-overlay','.mfp-overlay','.fancybox-overlay',
        '#CybotCookiebotDialog','#onetrust-banner-sdk',
        '.cc-window','.cookie-notice',
      ];
      sels.forEach(function(s){
        document.querySelectorAll(s).forEach(function(el){
          // Only remove if it's blocking (fixed/absolute positioned)
          var style = window.getComputedStyle(el);
          if (style.position === 'fixed' || style.position === 'absolute') {
            el.style.display = 'none';
          }
        });
      });
      // Restore body scroll
      document.body.style.overflow = 'auto';
      document.documentElement.style.overflow = 'auto';
    `);
  } catch (_) {}
}

// ── Find form considering all types ──────────────────────────────────────────
// Orchestrator that ties the helpers above together: clear blockers, detect
// the form type, then apply type-specific prep:
//   - hubspot: wait for the async HubSpot SDK to render the form.
//   - typeform / jotform: locate their iframe and switch WebDriver context
//     into it, returning early with `inIframe: true` so the caller knows
//     subsequent field lookups should happen inside that frame.
//   - unknown: scroll to trigger lazy loading, then wait for a form/inputs
//     to show up before giving up.
// Note this function does not itself return a concrete <form> WebElement —
// `form` is always null; locating the actual element is form_finder.js's
// responsibility. This function is about classification + page prep only.
async function findFormAllTypes(driver) {
  // Remove blockers first
  await removeBlockers(driver);

  const formType = await detectFormType(driver);
  console.log(`      📋 Form type detected: ${formType}`);

  // Handle special types
  switch (formType) {
    case 'hubspot':
      await waitForHubspot(driver);
      break;
    case 'typeform': {
      const iframe = await findTypeformIframe(driver);
      if (iframe) {
        try {
          await driver.switchTo().frame(iframe);
          console.log('      📋 Switched into Typeform iframe');
          return { type: 'typeform', form: null, inIframe: true };
        } catch (_) {}
      }
      break;
    }
    case 'jotform': {
      const iframe = await findJotformIframe(driver);
      if (iframe) {
        try {
          await driver.switchTo().frame(iframe);
          console.log('      📋 Switched into JotForm iframe');
          return { type: 'jotform', form: null, inIframe: true };
        } catch (_) {}
      }
      break;
    }
    case 'unknown':
      // Scroll to trigger lazy load
      await scrollAndReveal(driver);
      await waitForForm(driver, 4000);
      break;
  }

  return { type: formType, form: null, inIframe: false };
}

module.exports = {
  detectFormType,
  waitForForm,
  waitForHubspot,
  findTypeformIframe,
  findJotformIframe,
  isMultiStep,
  clickNextStep,
  scrollAndReveal,
  removeBlockers,
  findFormAllTypes,
};
