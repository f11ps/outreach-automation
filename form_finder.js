// ════════════════════════════════════════════════════════════════════════════
// form_finder.js
//
// PURPOSE / ROLE IN THE PIPELINE
//   Given a Selenium `driver` that already has a business's website (or its
//   contact page, per navigator.js) loaded, this file's job is to locate the
//   actual <form> DOM element (or form-like region) that should be filled in.
//   It is the "where is the form?" step, called from main.js right after
//   findContactPage() (navigator.js) has navigated to a likely contact page:
//
//       const form = await findContactForm(driver);
//
//   Once a form (or form-like container) is returned, downstream code
//   (fields.js, submitter.js, captcha/handler.js) fills the fields, solves
//   any CAPTCHA, and submits it.
//
// HOW IT WORKS (high level)
//   findContactForm(driver) is the single exported entry point. It runs up
//   to 3 "passes" over the page (to allow for JS-rendered content that
//   appears late), and on each pass tries, in order:
//
//     1. Native <form> elements on the main page — every <form> is scored
//        via a heuristic (has email field? textarea? submit button? is it a
//        login/search form? does the HTML mention a known form-plugin
//        signature like wpcf7/hubspot/gravityform? etc.) and the
//        highest-scoring valid candidate is returned.
//     2. <form> elements inside <iframe>s — some sites embed their contact
//        form (HubSpot, JotForm, etc.) in an iframe. Known non-form iframes
//        (ads, analytics, recaptcha, social widgets, maps) are skipped by
//        src pattern to avoid wasting time switching into them. The same
//        scoring heuristic is reapplied inside each candidate iframe.
//     3. "Formless" contact sections — modern SPA sites (React/Vue/Angular)
//        often lay out contact inputs without wrapping them in a <form> tag
//        at all. This strategy looks for a cluster of visible inputs that
//        share a common DOM ancestor and looks like a contact block (has an
//        email input and/or a textarea), returning that ancestor element
//        instead of a real <form>.
//
//   If nothing is found on a pass, the code waits a bit (to let
//   client-side JS finish rendering) and nudges the page via a scroll
//   (which often triggers lazy-loaded/lazy-mounted forms), then retries.
//   After 3 passes with nothing found, it gives up and returns null.
//
//   clearOverlays(driver) is a small helper run once at the very start to
//   hide cookie/GDPR/popup banners that might otherwise sit on top of the
//   form and interfere with visibility checks or later clicks.
//
// DEPENDENCIES / USED BY
//   - Depends on: selenium-webdriver (`By`) for locating elements, and runs
//     browser-side JS via driver.executeScript() for DOM inspection/scoring
//     (this is done in-page for performance — one round trip instead of many
//     WebDriver calls per candidate element).
//   - Used by: main.js, which calls findContactForm() after navigator.js's
//     findContactPage() has landed on what looks like the contact page.
//   - Conceptually related to form_types.js: form_types.js's removeBlockers()
//     performs a very similar overlay-clearing job to this file's
//     clearOverlays(), and form_types.js's detectFormType()/findFormAllTypes()
//     classify *what kind* of form was found (CF7, WPForms, HubSpot, etc.),
//     which affects how fields.js/submitter.js later interact with it. This
//     file focuses purely on *locating* the form element, not classifying it.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { By } = require('selenium-webdriver');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Iframe `src` substrings that indicate the iframe is NOT a contact form
// (ads, trackers, social embeds, maps, captcha widgets) — skipped outright
// so we don't waste time switching into them and scanning their contents.
const SKIP_IFRAME_SRC = [
  'google-analytics','googletagmanager','facebook.com/plugins',
  'twitter.com/widgets','youtube.com','maps.google','recaptcha',
  'captcha','doubleclick','ads.',
];

// Hides fixed/absolute-positioned cookie/consent/popup banners that could
// visually cover the form or block interactions later on. Best-effort only —
// failures are swallowed since this is a non-critical convenience step.
async function clearOverlays(driver) {
  try {
    await driver.executeScript(`
      ['[class*="cookie"]','[class*="gdpr"]','[class*="consent"]','[class*="popup"]',
       '[id*="cookie"]','[id*="popup"]','#CybotCookiebotDialog','#onetrust-banner-sdk',
       '.cc-window','.pum-overlay'].forEach(function(s){
        document.querySelectorAll(s).forEach(function(el){
          var st=window.getComputedStyle(el);
          if(st.position==='fixed'||st.position==='absolute') el.style.display='none';
        });
      });
      document.body.style.overflow='auto';
    `);
  } catch (_) {}
}

// Returns scored form data — elements returned separately via findElements
async function findContactForm(driver) {
  console.log('   🔍 Searching for contact form...');
  await clearOverlays(driver);

  // Up to 3 passes: some sites render their contact form asynchronously
  // (React hydration, lazy widgets, etc.), so later passes wait longer and
  // nudge the page with a scroll before re-scanning.
  for (let pass = 1; pass <= 3; pass++) {
    if (pass > 1) {
      console.log(`      ⏳ Pass ${pass}/3 — waiting for JS render...`);
      await sleep(pass * 1200);
      try {
        // Scrolling down then back up often triggers IntersectionObserver-
        // based lazy loading / lazy mounting of embedded forms.
        await driver.executeScript('window.scrollTo(0, document.body.scrollHeight*0.3)');
        await sleep(400);
        await driver.executeScript('window.scrollTo(0,0)');
      } catch (_) {}
    }

    // Get forms + scores — inline JS (not template string) to avoid escaping issues
    let formData = [];
    let allForms = [];
    try {
      // First grab the <form> WebElements via the normal WebDriver API so we
      // have real element handles to return later (executeScript results
      // can't hand back live DOM elements the same way).
      allForms = await driver.findElements(By.tagName('form'));
      if (allForms.length > 0) {
        // Then, in a single executeScript call, compute a heuristic "is this
        // the contact form?" score for every <form> on the page. Doing the
        // scoring in-page (rather than one WebDriver round-trip per form)
        // keeps this fast even on pages with many forms.
        formData = await driver.executeScript(function() {
          // Known contact-form plugin/library signatures searched for in
          // each form's outerHTML — presence strongly suggests a real
          // contact form rather than e.g. a newsletter signup or search box.
          var PLUGINS = ['wpcf7','wpforms','gform','gravityform','ninja-form','formidable',
                         'elementor-form','hs-form','hubspot','contact-form','cf7'];
          var url = window.location.href.toLowerCase();
          // Bonus signal: if we're already on a URL that looks like a
          // contact/inquiry page, forms found here are more likely correct.
          var onContact = ['contact','inquiry','enquiry','feedback','reach','touch']
            .some(function(w){ return url.indexOf(w) !== -1; });
          return Array.from(document.querySelectorAll('form') || []).map(function(f, i) {
            var inputs = Array.from(f.querySelectorAll('input,textarea,select'));
            // "Visible" excludes hidden/submit/button/image inputs — we only
            // care about fields a real user would actually fill in.
            var visible = inputs.filter(function(e) {
              return e.offsetParent !== null && e.type !== 'hidden' &&
                     e.type !== 'submit' && e.type !== 'button' && e.type !== 'image';
            });
            var html = (f.outerHTML || '').toLowerCase().substring(0, 5000);
            var hasEmail    = !!f.querySelector('input[type=email],[name*=email i],[id*=email i],[placeholder*=email i]');
            var hasTextarea = !!f.querySelector('textarea');
            var hasSubmit   = !!f.querySelector('button[type=submit],input[type=submit],button:not([type])');
            var hasPassword = !!f.querySelector('input[type=password]');
            var isSearch    = (f.id||'').toLowerCase().indexOf('search') !== -1 ||
                              (f.className||'').toLowerCase().indexOf('search') !== -1;
            var isPlugin    = PLUGINS.some(function(p){ return html.indexOf(p) !== -1; });
            // Weighted scoring: positive signals for things a contact form
            // has (email field, message box, submit button, several visible
            // fields, known plugin, contact-page URL); strong negative
            // penalties for things that indicate it's actually a login form
            // (password field) or a search box, which should never be
            // mistaken for the contact form.
            var score = 0;
            if (hasEmail)    score += 30;
            if (hasTextarea) score += 25;
            if (hasSubmit)   score += 15;
            if (visible.length >= 3) score += 10;
            else if (visible.length >= 2) score += 5;
            if (isPlugin)    score += 20;
            if (onContact)   score += 15;
            if (hasPassword) score -= 50;
            if (isSearch)    score -= 40;
            if (visible.length <= 1 && !hasEmail && !hasTextarea) score -= 20;
            return { idx: i, score: score, visible: visible.length,
                     hasEmail: hasEmail, hasTextarea: hasTextarea,
                     hasSubmit: hasSubmit, hasPassword: hasPassword, isSearch: isSearch };
          });
        }) || [];
      }
    } catch (_) {}

    if (formData.length > 0 && allForms.length > 0) {
      // Sort by score
      formData.sort((a, b) => b.score - a.score);

      console.log(`      Found ${allForms.length} form(s):`);
      formData.forEach(f => {
        console.log(`        Form ${f.idx+1}: score=${f.score} email=${f.hasEmail} textarea=${f.hasTextarea} visible=${f.visible} pw=${f.hasPassword}`);
      });

      // Pick best valid form: walk candidates highest-score-first, skip
      // anything that's clearly a login (password) or search form, and
      // accept the first one that has a real signal of being a contact form
      // (email field, message box, or at least 2 visible fields).
      for (const f of formData) {
        if (f.hasPassword || f.isSearch) continue;
        if (f.hasEmail || f.hasTextarea || f.visible >= 2) {
          const form = allForms[f.idx];
          if (form) {
            console.log(`      ✅ Selected form ${f.idx+1} (score=${f.score})`);
            return form;
          }
        }
      }
    }

    // Check iframes — the contact form may live inside an embedded iframe
    // (common with HubSpot/JotForm/third-party form builders) rather than
    // directly in the page DOM.
    try {
      const iframes = await driver.findElements(By.tagName('iframe'));
      for (const iframe of iframes) {
        const src = (await iframe.getAttribute('src').catch(() => '') || '').toLowerCase();
        // Skip iframes we already know aren't contact forms (ads, trackers,
        // social widgets, maps, captcha) to save time.
        if (SKIP_IFRAME_SRC.some(s => src.includes(s))) continue;
        if (!(await iframe.isDisplayed().catch(() => false))) continue;
        try {
          // Selenium requires switching context into the iframe before its
          // internal DOM can be queried/scored.
          await driver.switchTo().frame(iframe);
          const iData = await driver.executeScript(function() {
            // Same scoring heuristic as the main-page pass above, applied to
            // forms found inside this iframe's document (slightly smaller
            // HTML snippet size and fewer negative-signal checks, but same
            // idea).
            var PLUGINS = ['wpcf7','wpforms','gform','gravityform','ninja-form','formidable','elementor-form','hs-form','hubspot','contact-form','cf7'];
            return Array.from(document.querySelectorAll('form')||[]).map(function(f,i){
              var inputs = Array.from(f.querySelectorAll('input,textarea,select'));
              var visible = inputs.filter(function(e){ return e.offsetParent!==null&&e.type!=='hidden'&&e.type!=='submit'&&e.type!=='button'; });
              var html = (f.outerHTML||'').toLowerCase().substring(0,3000);
              var hasEmail = !!f.querySelector('input[type=email],[name*=email i]');
              var hasTextarea = !!f.querySelector('textarea');
              var hasPassword = !!f.querySelector('input[type=password]');
              var isPlugin = PLUGINS.some(function(p){ return html.indexOf(p)!==-1; });
              var score = (hasEmail?30:0)+(hasTextarea?25:0)+(visible.length>=2?10:0)+(isPlugin?20:0)-(hasPassword?50:0);
              return {idx:i,score:score,visible:visible.length,hasEmail:hasEmail,hasTextarea:hasTextarea,hasPassword:hasPassword};
            });
          }).catch(() => []) || [];
          // Re-fetch the actual <form> WebElements (now that we're inside
          // the iframe's frame context) so indices line up with iData.
          const iForms = await driver.findElements(By.tagName('form')).catch(() => []);
          if (iData.length && iForms.length) {
            iData.sort((a, b) => b.score - a.score);
            for (const f of iData) {
              // Note: f.isSearch is never set by the iframe scoring script
              // above (unlike the main-page version), so this check is
              // effectively always false here — kept for parity/safety.
              if (f.hasPassword || f.isSearch) continue;
              if (f.hasEmail || f.hasTextarea || f.visible >= 2) {
                const form = iForms[f.idx];
                if (form) {
                  console.log(`      ✅ Found form in iframe (score=${f.score})`);
                  // NOTE: driver stays switched into this iframe's context —
                  // the caller will interact with the returned element while
                  // still inside the frame, which is required for it to work.
                  return form;
                }
              }
            }
          }
          // No usable form in this iframe — switch back to the top-level
          // document before checking the next iframe.
          await driver.switchTo().defaultContent();
        } catch (_) {
          await driver.switchTo().defaultContent().catch(() => {});
        }
      }
    } catch (_) {}

    // Formless (React/Vue/Angular) — some SPA-built contact sections have no
    // wrapping <form> element at all; inputs sit directly in a <div>. This
    // pass looks for a cluster of visible, "real" inputs (excluding hidden/
    // submit/button/checkbox/radio/file/password) that live outside any
    // <form>, and confirms it looks like a contact section by requiring an
    // email-like field or a textarea among them.
    try {
      const formless = await driver.executeScript(`
        var inputs = Array.from(document.querySelectorAll(
          'input:not([type=hidden]):not([type=submit]):not([type=button])' +
          ':not([type=checkbox]):not([type=radio]):not([type=file]):not([type=password]),textarea'
        )).filter(function(el){ return el.offsetParent!==null && !el.closest('form'); });
        if (inputs.length < 2) return null;
        var hasEmail = inputs.some(function(el){
          return el.type==='email'||
                 (el.name+' '+el.id+' '+(el.placeholder||'')).toLowerCase().indexOf('email')!==-1;
        });
        var hasMsg = inputs.some(function(el){ return el.tagName.toLowerCase()==='textarea'; });
        if (!hasEmail && !hasMsg) return null;
        // Walk up each input's ancestor chain and find the nearest common
        // ancestor shared by all of them — this is treated as the
        // "container" for the formless contact section, so later code can
        // scope field-filling/submit-button lookups to just that subtree
        // instead of the whole page.
        function anc(el){var a=[];while(el){a.push(el);el=el.parentElement;}return a;}
        var sets=inputs.map(anc);
        var common=sets[0].find(function(a){return sets.every(function(s){return s.indexOf(a)!==-1;});});
        return common||document.body;
      `);
      if (formless) {
        console.log('      ✅ Found formless contact section');
        return formless;
      }
    } catch (_) {}
  }

  console.log('      ❌ No contact form found');
  return null;
}

module.exports = { findContactForm };
