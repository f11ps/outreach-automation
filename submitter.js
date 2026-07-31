// ════════════════════════════════════════════════════════════════════════════
// submitter.js
//
// PURPOSE IN THE PIPELINE
// ------------------------------------------------------------------------------
// This is the LAST step of the "fill one contact form" flow (see main.js). Once
// navigator.js has found the contact page, form_finder.js has located the
// <form>, and fields.js has filled in name/email/message/etc., this module is
// responsible for two things:
//
//   1. submitForm(driver, form, record)
//      Actually triggers the submission — i.e. finds and clicks the real
//      "Send"/"Submit" button (or falls back to other tricks if no button can
//      be found/clicked). Returns a tuple [submitted, lastError] where
//      `submitted` is a boolean and `lastError` is a short string (or null).
//      It also writes a human-readable status message into `record.submit_status`
//      so it ends up in the CSV / Google Sheet row for this URL (see
//      result_tracker.js / config.js CSV_FIELDS).
//
//   2. detectSuccess(driver)
//      After a submit attempt, call this to figure out whether the form
//      submission actually succeeded (thank-you page, redirect, confirmation
//      message, etc.). Returns a boolean.
//
// HOW IT WORKS (HIGH LEVEL)
// ------------------------------------------------------------------------------
// submitForm():
//   - Runs a scoring algorithm INSIDE the browser (via driver.executeScript)
//     that inspects every plausible clickable element on the page (buttons,
//     input[type=submit], input[type=button], input[type=image], role=button
//     links) and assigns each one a numeric score based on: its type attribute,
//     whether its text/name/id/class matches known "submit-like" words
//     (SIGNALS) or known "not a submit button" words (REJECTS), whether it's
//     inside the target <form>, and whether it's currently visible.
//   - Sorts candidates by score (highest = most likely the real submit button)
//     and tries clicking them one by one using a "human-like" click sequence
//     (scroll into view → try a native Selenium .click() → fall back to
//     dispatching synthetic mouse events) until one click succeeds.
//   - If no button click works, it falls through a chain of fallbacks:
//       Fallback A: dispatch a native 'submit' Event on the <form> element,
//                   then call form.submit() if the event wasn't prevented.
//       Fallback B: scan the whole document for forms that look "more filled
//                   in" (have an email field or >=2 filled inputs) and call
//                   .submit() directly on the best one.
//       Fallback C: focus the last filled visible text input and simulate
//                   pressing Enter (many forms submit on Enter).
//   - If literally nothing works, returns [false, 'No submit button'].
//
// detectSuccess():
//   - Records the URL before we started, then polls the page every 500ms for
//     up to ~10 seconds (20 iterations), checking three kinds of evidence,
//     from strongest to weakest:
//       1. URL changed at all after submission (treated as success — most
//          contact forms redirect to a thank-you/confirmation page on submit).
//       2. A known "strong" success selector (SUCCESS_SELS — plugin-specific
//          classes like WPCF7's `.wpcf7-mail-sent-ok`, Gravity Forms'
//          `#gform_confirmation_message`, generic `[class*="thank-you"]`,
//          etc.) is present, visible, and has non-trivial text.
//       3. The page body text contains one of the SUCCESS_TEXTS phrases
//          (multi-language "thank you" / "message sent" / "gracias" / etc.).
//       4. A "weak" selector (WEAK_SELS — generic things like `[class*=
//          "success"]`, `#message`) is present AND its own text also matches
//          one of SUCCESS_TEXTS (weak selectors alone are too generic to
//          trust, so they require the text check as corroboration).
//   - Returns true as soon as any check passes, or false if none pass within
//     the polling window.
//
// DEPENDENCIES / USAGE
// ------------------------------------------------------------------------------
// - Depends only on the Selenium `driver` object passed in (no other local
//   modules are required here — all DOM inspection happens via
//   driver.executeScript, i.e. code that runs inside the target page).
// - Used by main.js, which does roughly:
//       const [submitted, lastError] = await submitForm(driver, form, record);
//       ...
//       if (await detectSuccess(driver)) { record.success_status = 'Success'; }
//   `record` is the same per-URL result object that result_tracker.js later
//   writes to form_results/contact_results.csv and pushes to Google Sheets.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── All possible submit button signals ───────────────────────────────────────
// Words/phrases that, when found in a button's visible text (or its name/id/
// class/value/aria-label as a fallback), suggest "this is the button that
// submits the form". Includes common English phrasing, a handful of other
// languages, and generic wizard-style words like 'next'/'continue' for
// multi-step forms.
const SIGNALS = [
  // English
  'send','submit','send message','send inquiry','send enquiry','send request',
  'contact us','get in touch','request','enquire','inquire','get quote',
  'book now','book appointment','schedule','apply','apply now',
  'talk to us','reach out','yes send','send it','go','confirm','ok','done',
  'get started','let\'s talk','lets talk','drop us a line','write to us',
  'request appointment','request consultation','request info','request callback',
  'send form','submit form','submit request','submit inquiry',
  // Spanish/French/German/Italian
  'enviar','envoyer','senden','invia','verzenden','soumettre','absenden',
  // Generic
  'next','continue','proceed',
];

// Words/phrases that disqualify an element outright — e.g. accessibility
// toolbar buttons, cart/checkout buttons, login/register links, etc. that
// happen to be nearby but are NOT the contact-form submit button.
const REJECTS = [
  'cancel','reset','clear','back','previous','close','login','sign in',
  'register','search','filter','checkout','pay','download','upload',
  'edit','delete','remove','share','print','add to cart','open toolbar',
  'increase text','decrease text','grayscale','contrast','readable font',
  'links underline','negative contrast','light background','high contrast',
  'reset settings','accessibility',
];

// ── Score a button element ────────────────────────────────────────────────────
// Standalone (Node-side) copy of the scoring logic — NOTE: this exact function
// is duplicated inline inside the driver.executeScript() call below because
// code passed to executeScript must be fully self-contained (it runs inside
// the browser's JS context, which cannot reference outer Node closures other
// than the serializable arguments passed in). This top-level copy isn't
// actually invoked from Node; it exists as a readable reference/duplicate of
// what runs in-browser.
function scoreButton(el, form, signals, rejects) {
  var r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return -1; // invisible/zero-size elements can't be clicked
  if (el.disabled) return -1;

  var type  = (el.type  || '').toLowerCase();
  var name  = (el.name  || '').toLowerCase();
  var id    = (el.id    || '').toLowerCase();
  var cls   = (el.className || '').toLowerCase();
  var val   = (el.value || '').toLowerCase();
  var aria  = (el.getAttribute('aria-label') || '').toLowerCase();
  var title = (el.title || '').toLowerCase();
  var text  = (el.innerText || el.textContent || '').trim().toLowerCase();
  if (!text) text = val || aria || title; // for <input> buttons, visible text often lives in `value`
  var combo = text + ' ' + name + ' ' + id + ' ' + cls + ' ' + val + ' ' + aria;

  // Hard reject — if any reject word appears anywhere in the combined text/
  // attributes, this element is disqualified regardless of other signals.
  if (rejects.some(function(r) { return combo.indexOf(r) !== -1; })) return -1;

  var score = 0;

  // Type signals — native submit inputs/buttons are the strongest hint
  if (type === 'submit') score += 40;
  if (type === 'image')  score += 15;  // image submit buttons

  // Text match — exact match to a known signal phrase scores higher than a
  // substring match (avoids over-rewarding buttons whose text merely contains
  // a signal word as part of something else)
  if (signals.some(function(s) { return text === s; }))              score += 30;
  else if (signals.some(function(s) { return text.indexOf(s) !== -1; })) score += 20;

  // Name/id/class hints — even without matching visible text, common
  // developer-chosen identifiers (id="submit-btn" etc.) are a useful signal
  if (['submit','send','contact','request','enquir','inquir','book','apply','go']
      .some(function(h) {
        return name.indexOf(h)!==-1 || id.indexOf(h)!==-1 || cls.indexOf(h)!==-1;
      })) score += 15;

  // Inside the form = strong signal (the button we actually want is almost
  // always a descendant of the <form> element we filled in)
  if (el.closest && el.closest('form') === form) score += 25;

  // Visible in viewport — prefer buttons that are actually on-screen right now
  if (r.top >= 0 && r.top < window.innerHeight) score += 5;

  // Has text (not empty button) — icon-only buttons are less certain matches
  if (text.length > 0) score += 5;

  return score;
}

// ── Human-like click: scroll → focus → mousedown → mouseup → click ───────────
// Tries to click `el` the way a real user would, to avoid triggering bot
// detection / JS handlers that only listen for genuine mouse events.
async function humanClick(driver, el) {
  await driver.executeScript(function(el) {
    // Scroll into view
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, el);
  await sleep(300); // let the smooth-scroll animation settle

  // Try Selenium click first (most natural — dispatches genuine OS-level
  // input events via the WebDriver protocol)
  try {
    await el.click();
    return true;
  } catch (_) {}

  // JS click with mouse events — used when Selenium's native click fails
  // (e.g. element intercepted by an overlay). Manually dispatches the full
  // sequence of mouse events a real click would generate.
  try {
    await driver.executeScript(function(el) {
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2;
      var y = r.top  + r.height / 2;
      ['mouseover','mouseenter','mousemove','mousedown','mouseup','click'].forEach(function(t) {
        el.dispatchEvent(new MouseEvent(t, {
          bubbles: true, cancelable: true,
          clientX: x, clientY: y,
          screenX: x + window.screenX, screenY: y + window.screenY,
        }));
      });
    }, el);
    return true;
  } catch (_) {}

  return false;
}

// ── Main submit function ──────────────────────────────────────────────────────
// Entry point called by main.js after the form has been filled in. Attempts,
// in order: (1) click the best-scored submit-like button, (2) dispatch a
// submit event / call form.submit(), (3) submit the "most filled" form on the
// page, (4) simulate pressing Enter in the last filled input. Returns
// [submitted: boolean, lastError: string|null] and annotates `record` with a
// human-readable submit_status string for the CSV/Sheets row.
async function submitForm(driver, form, record) {
  console.log('   🚀 Submitting form...');

  // Collect ALL candidate buttons from page using inline function.
  // Everything inside this driver.executeScript(...) call runs INSIDE the
  // browser page's own JS context (not in Node), so it must be fully
  // self-contained — it re-declares scoreButton() locally rather than
  // referencing the Node-level copy above, because closures over outer scope
  // aren't available in the browser sandbox that WebDriver ships the script to.
  let scored = [];
  try {
    scored = await driver.executeScript(function(form, signals, rejects) {
      function scoreButton(el, form, signals, rejects) {
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return -1;
        if (el.disabled) return -1;
        var type  = (el.type  || '').toLowerCase();
        var name  = (el.name  || '').toLowerCase();
        var id    = (el.id    || '').toLowerCase();
        var cls   = (el.className || '').toLowerCase();
        var val   = (el.value || '').toLowerCase();
        var aria  = (el.getAttribute('aria-label') || '').toLowerCase();
        var text  = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (!text) text = val || aria || (el.title||'').toLowerCase();
        var combo = text+' '+name+' '+id+' '+cls+' '+val+' '+aria;
        if (rejects.some(function(r){ return combo.indexOf(r)!==-1; })) return -1;
        var score = 0;
        if (type==='submit') score += 40;
        if (type==='image')  score += 15;
        if (signals.some(function(s){ return text===s; }))               score += 30;
        else if (signals.some(function(s){ return text.indexOf(s)!==-1; })) score += 20;
        if (['submit','send','contact','request','enquir','inquir','book','apply','go']
            .some(function(h){ return name.indexOf(h)!==-1||id.indexOf(h)!==-1||cls.indexOf(h)!==-1; })) score += 15;
        if (el.closest && el.closest('form')===form) score += 25;
        if (r.top>=0 && r.top<window.innerHeight) score += 5;
        if (text.length>0) score += 5;
        return score;
      }

      // `seen` dedupes elements that might get picked up by more than one of
      // the priority queries below (e.g. a button that's both inside the form
      // and matches the page-level submit selector).
      var seen = new Set(), cands = [];
      function add(el) {
        if (!seen.has(el) && el.offsetParent!==null) { seen.add(el); cands.push(el); }
      }

      // Priority 1: inside form — the most likely place for the real submit
      // control to live.
      Array.from(form.querySelectorAll(
        "button, input[type='submit'], input[type='button'], input[type='image'], a[role='button']"
      )).forEach(add);

      // Priority 2: parent container — some builders (e.g. page builders)
      // render the submit button as a sibling of the <form>, not a child.
      var p = form.parentElement;
      if (p) Array.from(p.querySelectorAll(
        "button, input[type='submit'], input[type='button']"
      )).forEach(add);

      // Priority 3: page-level (for forms where button is outside) — widen
      // the search to any submit-typed control anywhere on the page.
      Array.from(document.querySelectorAll(
        "button[type='submit'], input[type='submit']"
      )).forEach(add);

      // Priority 4: any visible button on page — last resort catch-all so we
      // always have *some* candidates to score, even on nonstandard markup.
      Array.from(document.querySelectorAll('button')).forEach(add);

      // Score every candidate and keep only the ones that could plausibly be
      // a submit control (score > 0), sorted best-first.
      var results = [];
      cands.forEach(function(el, i) {
        var s = scoreButton(el, form, signals, rejects);
        if (s > 0) results.push({ el: el, score: s,
          text: (el.innerText||el.value||el.getAttribute('aria-label')||'').trim().slice(0,40) });
      });
      results.sort(function(a,b){ return b.score-a.score; });
      return results;
    }, form, SIGNALS, REJECTS) || [];
  } catch (_) {}

  console.log(`      Found ${scored.length} submit candidates`);

  // Try clicking top candidates, best score first. Stop trying once scores
  // drop below 10 — anything that low is too weak a match to risk clicking
  // (could be an unrelated button on the page).
  for (const { el, score, text } of scored) {
    if (score < 10) break;
    console.log(`      Trying: '${text}' (score=${score})`);
    try {
      const clicked = await humanClick(driver, el);
      if (clicked) {
        await sleep(400); // give the page a moment to react (validation, AJAX, etc.)
        console.log(`      ✅ Clicked: '${text}' (score=${score})`);
        record.submit_status = `Clicked: '${text}' (score=${score})`;
        return [true, null];
      }
    } catch (_) {}
  }

  // Fallback A: dispatch submit event on form. If no click candidate worked,
  // try firing a native 'submit' Event directly — this triggers any JS
  // 'submit' listeners the site has wired up. If the event isn't
  // preventDefault()-ed (i.e. `ok` stays true), also call form.submit() to
  // force browser-native submission.
  try {
    const r = await driver.executeScript(function(form) {
      var evt = new Event('submit', { bubbles: true, cancelable: true });
      var ok = form.dispatchEvent(evt);
      if (ok) { try { form.submit(); return 'submit-event'; } catch(_) { return 'event-only'; } }
      return 'prevented';
    }, form);
    if (r !== 'prevented') {
      console.log(`      ✅ Submit event (${r})`);
      record.submit_status = `Submit event: ${r}`;
      return [true, null];
    }
  } catch (_) {}

  // Fallback B: form.submit() on best matching form. Sometimes the <form>
  // element passed in isn't actually the one that matters (e.g. form_finder
  // picked the wrong candidate), so re-scan the whole page for forms and pick
  // whichever one looks "most filled in" — has an email field, or at least 2
  // inputs carrying a value — and submit that one directly.
  try {
    const r = await driver.executeScript(function() {
      var forms = Array.from(document.querySelectorAll('form'));
      // Sort by number of filled inputs
      forms.sort(function(a,b){
        return b.querySelectorAll('input[value],textarea').length -
               a.querySelectorAll('input[value],textarea').length;
      });
      for (var i=0; i<forms.length; i++) {
        var f = forms[i];
        var inp = f.querySelectorAll('input,textarea,select');
        var hasEmail = Array.from(inp).some(function(e){
          return e.type==='email' || (e.name||'').toLowerCase().indexOf('email')!==-1;
        });
        if (hasEmail || inp.length >= 2) {
          try { f.submit(); return 'form['+i+']'; } catch(_) {}
        }
      }
      return null;
    });
    if (r) {
      console.log(`      ✅ form.submit() → ${r}`);
      record.submit_status = `form.submit(): ${r}`;
      return [true, null];
    }
  } catch (_) {}

  // Fallback C: Enter key on last filled input. Many forms submit when Enter
  // is pressed in a text field, so as an absolute last resort, focus the last
  // visible/enabled/filled text-like input and simulate an Enter keypress.
  try {
    const last = await driver.executeScript(function(form) {
      var inp = Array.from(form.querySelectorAll(
        "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='submit']):not([type='button'])"));
      var vis = inp.filter(function(e){ return e.offsetParent!==null && !e.disabled && e.value; });
      return vis.length ? vis[vis.length-1] : null;
    }, form);
    if (last) {
      await driver.executeScript(function(el) {
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',keyCode:13,bubbles:true,cancelable:true}));
        el.dispatchEvent(new KeyboardEvent('keyup',   {key:'Enter',keyCode:13,bubbles:true}));
      }, last);
      console.log('      ✅ Enter key on last input');
      record.submit_status = 'Enter key';
      return [true, null];
    }
  } catch (_) {}

  // Every strategy failed — nothing left to try.
  console.log('      ❌ No submit method worked');
  record.submit_status = 'No submit button found';
  return [false, 'No submit button'];
}

// ── Success detection ─────────────────────────────────────────────────────────
// Phrases (multi-language) that typically appear on a "thank you" / success
// confirmation after a contact form is submitted. Used both as a strong
// standalone signal (body text scan) and to corroborate WEAK_SELS matches.
const SUCCESS_TEXTS = [
  'thank you','thanks for','success','successfully submitted','form submitted',
  'message sent','message received','we will contact','we will get back',
  'we have received','received your','get back to you','be in touch',
  'confirmation','your submission','inquiry received','enquiry received',
  'request received','we received your',
  'gracias','enviado','obrigado','merci','danke',
];
// These are STRONG signals — any match = success
// CSS selectors specific to well-known contact-form plugins/frameworks
// (Contact Form 7, Elementor, Gravity Forms, WPForms, Ninja Forms, Formidable,
// generic Bootstrap alert-success, etc.). If any of these is visible with
// real text content, we consider the submission a confirmed success.
const SUCCESS_SELS = [
  '.wpcf7-mail-sent-ok',
  '.elementor-message-success',
  '.gform_confirmation_message',
  '.wpforms-confirmation',
  '.nf-response-msg',
  '.frm_message',
  '.alert-success',
  '.success-message',
  '.form-success',
  '.submission-success',
  '[class*="confirmation"]',
  '[class*="thank-you"]',
  '[class*="thankyou"]',
  '#gform_confirmation_message',
];
// Weak signals — only count if text also matches. These class/id patterns are
// too generic to trust on their own (e.g. `#message` could be the message
// textarea itself, `[class*="success"]` could be an unrelated UI element), so
// they're only treated as success evidence when their own text ALSO contains
// one of SUCCESS_TEXTS.
const WEAK_SELS = [
  '[class*="success"]',
  '[class*="thank"]',
  '[class*="confirm"]',
  '#result','#message','#response',
  '.wpcf7-response-output',
];

// Called after submitForm() to determine whether the submission actually
// went through. Polls the page for up to ~10 seconds because confirmation
// messages/redirects are often asynchronous (AJAX submit + fade-in message).
async function detectSuccess(driver) {
  const startUrl = await driver.getCurrentUrl().catch(() => '');

  const check = async () => {
    try {
      return await driver.executeScript(function(startUrl, texts, strongSels, weakSels) {
        var body = (document.body && document.body.innerText || '').toLowerCase();
        var url  = window.location.href;

        // URL changed to thank-you/success page. In practice, ANY navigation
        // away from the original page after a submit attempt is treated as
        // success (most sites only redirect on successful submission), with
        // an extra keyword check kept only for readability/potential future
        // tightening — note it currently `return true` unconditionally below.
        if (url !== startUrl) {
          var u = url.toLowerCase();
          if (["thank","success","confirm","sent","received","submitted"].some(function(w){ return u.indexOf(w)!==-1; }))
            return true;
          return true; // any redirect after submit = success
        }

        // Strong selectors — definitive success. Must be visible
        // (offsetParent !== null) and have more than 2 characters of text to
        // rule out empty/hidden placeholder elements matching the selector.
        for (var i=0; i<strongSels.length; i++) {
          try {
            var nodes = document.querySelectorAll(strongSels[i]);
            for (var j=0; j<nodes.length; j++) {
              if (nodes[j].offsetParent!==null && (nodes[j].innerText||'').trim().length > 2)
                return true;
            }
          } catch(_){}
        }

        // Body text — strong phrases only. Scans the entire visible page text
        // for any of the SUCCESS_TEXTS phrases.
        if (texts.some(function(t){ return body.indexOf(t)!==-1; })) return true;

        // Weak selectors — only if text also matches. Requires >5 chars of
        // text AND a SUCCESS_TEXTS match inside that specific element, since
        // the selectors themselves are too broad to trust alone.
        for (var k=0; k<weakSels.length; k++) {
          try {
            var wnodes = document.querySelectorAll(weakSels[k]);
            for (var l=0; l<wnodes.length; l++) {
              var n = wnodes[l];
              if (n.offsetParent!==null) {
                var t = (n.innerText||'').toLowerCase();
                if (t.length > 5 && texts.some(function(s){ return t.indexOf(s)!==-1; }))
                  return true;
              }
            }
          } catch(_){}
        }
        return false;
      }, startUrl, SUCCESS_TEXTS, SUCCESS_SELS, WEAK_SELS);
    } catch(_){ return false; }
  };

  // Poll up to 10s waiting for confirmation (20 iterations * 500ms).
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await check()) return true;
  }
  return false;
}


module.exports = { submitForm, detectSuccess };
