// ════════════════════════════════════════════════════════════════════════════
// fields.js — Field detection & filling engine
// ════════════════════════════════════════════════════════════════════════════
//
// PURPOSE / ROLE IN THE PIPELINE
// -------------------------------------------------------------------------
// This is step 4 of the per-URL pipeline driven by main.js:
//   1. navigator.js   — finds the contact page on the site
//   2. form_finder.js — finds the <form> element on that page
//   3. form_types.js  — (optionally) identifies the form platform (CF7, WPForms...)
//   4. fields.js (THIS FILE) — scans every input/textarea/select inside the
//      form, figures out what each one *means* (email? phone? message? ...),
//      and fills it with the right value from the `contact` object.
//   5. submitter.js   — clicks submit and checks for success.
//
// It exports two real functions used by main.js:
//   - fillAllFields(driver, form, contact, usedFields, filled, failed)
//       Scans the given `form` element, matches each visible field to a
//       "logical field name" (e.g. 'email', 'phone', 'first_name', 'message'),
//       and fills it via Selenium's executeScript. Mutates `usedFields`
//       (Set of logical names already used, to avoid double-filling),
//       `filled` (array of logical names successfully filled) and `failed`
//       (array of logical names never found in the form).
//   - checkCheckboxes(driver, form)
//       Ticks every visible, unchecked checkbox in the form (used for
//       "I agree to terms" / consent checkboxes so the submit isn't blocked).
//
// A handful of other exports (fillDropdownFields, fillNameFields,
// fillEmailField, fillPhoneFields, fillCompanyFields, fillMessageFields) are
// kept as no-op stubs purely so older code that imports them doesn't crash —
// all of that logic now lives inside fillAllFields.
//
// HOW FIELD MATCHING WORKS (high level)
// -------------------------------------------------------------------------
// For every input/textarea/select found inside the form, the code builds a
// single lowercase "context string" (`ctx`) by concatenating everything that
// might hint at the field's purpose: its <label>, its `name`/`id`
// attributes, its `placeholder`, `autocomplete`, and various `data-*`
// attributes. That context string is then run through `matchField()`, a
// large if/else chain of regexes and substring checks (ordered from most
// specific/unambiguous to most generic) that returns a "logical field key"
// such as 'email', 'phone', 'first_name', 'company', 'message', etc. If
// nothing matches, the field is logged to form_results/unknown_fields.log so
// unrecognized patterns can be reviewed later and used to extend the
// matching rules.
//
// Special cases handled along the way:
//   - Honeypot fields (hidden via CSS/zero-size/tabindex -1) and CAPTCHA
//     fields (matched via CAPTCHA_PATTERNS) are detected and skipped so they
//     are never filled.
//   - <select> dropdowns are handled separately from text inputs: instead of
//     typing a value, the code picks the "best" <option> for known dropdown
//     purposes (country/phone code -> India, service type -> digital
//     marketing, budget -> flexible, etc.).
//   - Phone number formatting is handled by getPhoneValue(), which inspects
//     the input's mask/pattern/maxlength attributes plus its context string
//     to decide whether to fill a local 10-digit number, a number with
//     country code, or a masked/split format.
//   - `usedFields` (a Set passed in by the caller) prevents the same logical
//     field from being filled twice if a form happens to have two inputs
//     that both look like, say, "email" (this also lets main.js call
//     fillAllFields a second time as a retry pass without re-filling
//     everything).
//   - Values are set via SET_VALUE_JS, a small injected script that uses the
//     native property setter (so React/Vue/Angular-controlled inputs pick up
//     the change) and fires input/change/blur/keyup events afterward.
//
// DEPENDENCIES / USED BY
// -------------------------------------------------------------------------
//   - Requires only Node's built-in `fs` and `path` modules (to append to
//     form_results/unknown_fields.log).
//   - Consumed by main.js, which calls fillAllFields() and checkCheckboxes()
//     with a Selenium `driver`, the previously-found `form` WebElement, and
//     a `contact` object (first_name/last_name/full_name/email/phone/
//     phone_local/company/website/job_title/subject/budget/address/message)
//     built from config.js.
//   - Writes to form_results/unknown_fields.log (read/used for future
//     improvement of the matching rules, not consumed programmatically here).
// ════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const UNKNOWN_LOG = path.join(__dirname, 'form_results', 'unknown_fields.log');

// Append a line describing a field we couldn't classify, so unmatched
// real-world label/name/placeholder combinations can be reviewed later and
// turned into new rules in FIELD_DEFS / matchField().
function logUnknown(url, label, name, id, placeholder, type) {
  const line = `${new Date().toISOString()} | ${url} | label="${label}" name="${name}" id="${id}" ph="${placeholder}" type=${type}\n`;
  try { fs.appendFileSync(UNKNOWN_LOG, line); } catch(_) {}
}

// ── Set value — works with React, Vue, Angular, plain HTML ────────────────────
// Injected into the page via driver.executeScript(SET_VALUE_JS, el, val).
// Plain `el.value = val` does not work reliably on framework-controlled
// inputs (React etc. intercept the native setter to keep internal state in
// sync), so this grabs the *native* property setter off the prototype
// (HTMLInputElement/HTMLTextAreaElement/HTMLSelectElement) and calls it
// directly, bypassing any framework-level override. It then dispatches the
// standard input/change/blur/keyup events so any listeners (validation,
// React's onChange, etc.) still fire as if a real user typed the value.
const SET_VALUE_JS = `
(function(el, val) {
  el.scrollIntoView({block:'nearest'});
  el.focus();
  var tag   = el.tagName;
  var proto = tag==='TEXTAREA' ? window.HTMLTextAreaElement.prototype
            : tag==='SELECT'   ? window.HTMLSelectElement.prototype
            : window.HTMLInputElement.prototype;
  var setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, val);
  else el.value = val;
  ['input','change','blur','keyup'].forEach(function(t){
    el.dispatchEvent(new Event(t, {bubbles:true, cancelable:true}));
  });
})(arguments[0], arguments[1]);
`;

// ── Captcha inputs — never fill ───────────────────────────────────────────────
// Any field whose context string (label/name/id/placeholder) contains one of
// these substrings is treated as a CAPTCHA/anti-spam field and is skipped
// entirely (never filled, never counted as "unknown") — filling it with
// contact data would just fail the human check and break form submission.
const CAPTCHA_PATTERNS = [
  'captcha','securimage','verify_code','verification_code','security_code',
  'antispam','anti_spam','bot_check','human_check','spam_check',
  'enter the code','enter code','type the code','type code','math',
  'enter the correct','correct answer','spam protection','anti spam',
  'what is','calculate','solve this',
  'wpcf7-quiz','quiz-',
];

// ── Field definitions — order matters (most specific first) ───────────────────
// Each entry: [fieldKey, [...keywords]]
// This table is the *fallback* keyword scan used at the bottom of
// matchField() when none of the earlier, more careful regex checks match.
// It's also reused at the end of fillAllFields() to compute which logical
// fields were never found in the form (the `failed` list), by iterating all
// keys here and checking whether they ended up in `usedFields`.
const FIELD_DEFS = [
  ['first_name', [
    'first name','firstname','first-name','fname','given name','given-name',
    'forename','your first name','first_name','prénom','nombre',
  ]],
  ['last_name', [
    'last name','lastname','last-name','lname','surname','family name',
    'family-name','your last name','last_name','nom','apellido',
  ]],
  ['full_name', [
    'full name','fullname','full-name','your name','your full name',
    'contact name','contactname','name *','your name *','full_name',
    'complete name','legal name',
  ]],
  ['email', [
    'email','e-mail','email address','e-mail address','your email',
    'work email','business email','company email','email *','correo',
    'emailaddress','email_address','mail address','your e-mail',
    'email id','e mail','courriel',
  ]],
  ['phone', [
    'phone','phone number','phone no','phone_number','phonenumber',
    'mobile','mobile number','mobile no','cell','cell phone','cellphone',
    'telephone','tel','contact number','contact no','whatsapp',
    'mob','ph','ph no','phno','your number','your phone','contact_no',
    'phone *','mobile *','téléphone','telefono',
  ]],
  ['company', [
    'company','company name','companyname','company_name',
    'organization','organisation','business','business name',
    'firm','agency','agency name','brand','brand name',
    'practice','clinic','hospital','school','institute','employer',
    'your company','your organization','entreprise','empresa',
  ]],
  ['website', [
    'website','web site','website url','your website','company website',
    'url','site','homepage','web address','webaddress','site url',
    'your url','your site','web','site web',
  ]],
  ['job_title', [
    'job title','jobtitle','job_title','job role','position','role',
    'designation','occupation','title','your title','your role',
    'specialty','speciality','profession','your position','job function',
    'what do you do','your job','work title',
  ]],
  ['subject', [
    'subject','subject line','email subject','message subject',
    'topic','regarding','re:','inquiry subject','enquiry subject',
    'purpose','reason','service','interested in','interest',
    'how can we help','how can i help you','what can we help',
    'type of inquiry','type of enquiry','inquiry type','service type',
    'project type','what are you looking for','nature of inquiry',
    'i am interested in','looking for','need help with',
    'what brings you here','department',
  ]],
  ['message', [
    'message','your message','write your message','enter message',
    'comment','comments','description','project description',
    'details','project details','tell us','tell us more',
    'notes','additional','additional info','additional information',
    'body','content','requirements','project requirements',
    'inquiry','enquiry','concern','request','info','information',
    'question','questions','write to us','brief','project brief',
    'about your project','about project','your inquiry','your enquiry',
    'leave a message','send a message','write us','drop us',
    'anything else','other information','more details',
  ]],
  ['budget', [
    'budget','project budget','your budget','estimated budget',
    'price range','investment','spend','how much','approximate budget',
    'budget range','monthly budget','annual budget',
  ]],
  ['address', [
    'address','street address','your address','mailing address',
    'city','state','country','zip','postal','postal code',
    'region','province','location','street','town',
  ]],
];

// Maps a field's context string (`ctx`, already lowercased — see fillAllFields)
// plus its tag/type to a logical field key like 'email' or 'first_name'.
// The checks are deliberately ordered from most reliable/unambiguous to most
// generic, because several keywords overlap (e.g. "company email" contains
// both "company" and "email" — email must be checked first so it isn't
// mis-classified as a company field). Returns null if nothing matches.
function matchField(ctx, tag, type) {
  // Structural/type-based shortcuts — the HTML itself tells us the purpose,
  // no need to inspect label text at all.
  if (tag === 'textarea') return 'message';
  if (type === 'email')   return 'email';
  if (type === 'tel')     return 'phone';
  if (type === 'url')     return 'website';
  if (type === 'number') {
    // A bare <input type="number"> is ambiguous (could be phone, quantity,
    // budget...) — only claim it as phone if the context clearly says so.
    if (ctx.match(/phone|mobile|cell|tel|mob/)) return 'phone';
    return null;
  }

  // Email — before company ('company email' → email)
  if (ctx.match(/\bemail\b/) || ctx.includes('e-mail') || ctx.includes('e mail') ||
      ctx.includes('courriel') || ctx.includes('correo')) return 'email';

  // Company — before name ('company name' → company)
  if (ctx.match(/\bcompany\b/) || ctx.match(/\borganiz/) ||
      ctx.match(/\bbusiness\b/) || ctx.match(/\bfirm\b/) ||
      ctx.match(/\bagency\b/)   || ctx.match(/\bemployer\b/) ||
      ctx.match(/\binstitut/)   || ctx.includes('brand name') ||
      ctx.includes('empresa')   || ctx.includes('entreprise')) return 'company';

  // Phone
  if (ctx.match(/\bphone\b/)    || ctx.match(/\bmobile\b/) ||
      ctx.match(/\btel\b/)      || ctx.match(/\bcell\b/) ||
      ctx.match(/\bwhatsapp\b/) || ctx.match(/\bmob\b/) ||
      ctx.includes('contact number') || ctx.includes('phone no') ||
      ctx.includes('mobile no') || ctx.includes('ph no') ||
      ctx.includes('telephone') || ctx.includes('téléphone') ||
      ctx.includes('telefono')  || ctx.includes('phonenumber')) return 'phone';

  // First name — 'First' alone OR 'first name'
  if (ctx.match(/\bfirst\b/)    || ctx.includes('fname') ||
      ctx.includes('firstname') || ctx.includes('first_name') ||
      ctx.includes('given name')|| ctx.includes('forename') ||
      ctx.includes('given-name')|| ctx.includes('prénom') ||
      ctx.includes('nombre'))     return 'first_name';

  // Last name — 'Last' alone OR 'last name'
  if (ctx.match(/\blast\b/)     || ctx.includes('lname') ||
      ctx.includes('lastname')  || ctx.includes('last_name') ||
      ctx.includes('surname')   || ctx.includes('family name') ||
      ctx.includes('family-name')|| ctx.includes('apellido')) return 'last_name';

  // Full name
  if (ctx.includes('full name') || ctx.includes('fullname') ||
      ctx.includes('your name') || ctx.includes('contact name') ||
      ctx.includes('complete name') || ctx.includes('legal name') ||
      ctx.match(/^name[\s\*]*$/) || ctx.match(/\bname\s*\*?\s*$/)) return 'full_name';
  // Generic 'name' — not company/brand/domain
  // Catches a bare "Name" label that isn't already covered above, while
  // explicitly excluding lookalikes such as "Company Name", "Brand Name",
  // "File Name", "Username", "Product Name" etc. which are NOT a person's name.
  if (ctx.match(/\bname\b/) &&
      !ctx.match(/company|brand|agency|business|domain|file|user|login|product|page/)) return 'full_name';

  // Website
  if (ctx.match(/\bwebsite\b/) || ctx.match(/\burl\b/) ||
      ctx.includes('web address') || ctx.includes('homepage') ||
      ctx.includes('site web')   || ctx.includes('your site')) return 'website';

  // Job title
  // "position"/"role" are ambiguous with job-application forms ("apply",
  // "hiring", "open" positions) — excluded so we don't misfill those.
  if (ctx.includes('job title') || ctx.includes('jobtitle') ||
      ctx.match(/\bdesignation\b/) || ctx.match(/\boccupation\b/) ||
      ctx.includes('your role')   || ctx.includes('your position') ||
      ctx.includes('work title')  || ctx.includes('job function') ||
      (ctx.match(/\bposition\b/) && !ctx.match(/apply|hiring|open/)) ||
      (ctx.match(/\brole\b/)     && !ctx.match(/apply|hiring/))) return 'job_title';

  // Subject / inquiry type
  if (ctx.match(/\bsubject\b/)  || ctx.match(/\btopic\b/) ||
      ctx.match(/\bregarding\b/)|| ctx.includes('interested in') ||
      ctx.includes('service type') || ctx.includes('inquiry type') ||
      ctx.includes('enquiry type') || ctx.includes('type of inquiry') ||
      ctx.includes('type of enquiry') || ctx.includes('nature of') ||
      ctx.includes('how can we help') || ctx.includes('what can we') ||
      ctx.includes('looking for') || ctx.includes('need help with') ||
      ctx.includes('i am interested') || ctx.includes('department') ||
      ctx.includes('what brings you')) return 'subject';

  // Budget
  if (ctx.match(/\bbudget\b/)   || ctx.includes('price range') ||
      ctx.match(/\binvestment\b/) || ctx.includes('how much') ||
      ctx.includes('monthly budget') || ctx.includes('annual budget')) return 'budget';

  // Address
  if (ctx.match(/\baddress\b/)  || ctx.match(/\bcity\b/) ||
      ctx.match(/\bstate\b/)    || ctx.match(/\bzip\b/) ||
      ctx.match(/\bpostal\b/)   || ctx.match(/\bprovince\b/) ||
      ctx.match(/\bregion\b/)   || ctx.match(/\btown\b/)) return 'address';

  // Message — broad, last resort
  // Deliberately checked last (before the keyword-scan fallback) because
  // words like "info"/"request"/"details" are common enough to swallow
  // fields that should have matched something more specific above.
  if (ctx.match(/\bmessage\b/)      || ctx.match(/\bcomment\b/) ||
      ctx.match(/\bdescription\b/)  || ctx.match(/\bdetails\b/) ||
      ctx.match(/\bnotes\b/)        || ctx.match(/\brequirements\b/) ||
      ctx.match(/\binquiry\b/)      || ctx.match(/\benquiry\b/) ||
      ctx.match(/\bconcern\b/)      || ctx.match(/\brequest\b/) ||
      ctx.includes('tell us')       || ctx.includes('write to') ||
      ctx.includes('about your project') || ctx.includes('project brief') ||
      ctx.includes('anything else') || ctx.includes('more details') ||
      ctx.includes('leave a message') || ctx.includes('drop us')) return 'message';

  // Keyword scan fallback — last resort using the flat keyword lists in
  // FIELD_DEFS (in declaration order) for anything the regex checks above
  // didn't catch (e.g. localized/less common phrasing).
  for (const [fieldKey, keywords] of FIELD_DEFS) {
    if (keywords.some(k => ctx.includes(k))) return fieldKey;
  }

  return null;
}
// ── Phone value formatter ─────────────────────────────────────────────────────
// Decides which phone representation to type into a matched phone field,
// based on the input's inputmask/pattern/maxlength attributes and its
// context string. `contact.phone_local` is the bare national number (e.g.
// 10 digits, no country code) and `contact.phone` is the full international
// form (e.g. with +91). Falls back to the local number when no stronger
// signal is found.
function getPhoneValue(contact, ctx, mask, pattern, maxlength) {
  mask      = (mask      || '').toLowerCase();
  pattern   = (pattern   || '').toLowerCase();
  maxlength = parseInt(maxlength) || 0;

  // Masked input formats — e.g. inputmask templates like "(999) 999-9999"
  // or "999-999-9999" tell us exactly how the digits should be grouped.
  if (mask.includes('(999)') || mask.includes('(000)'))
    return contact.phone_local.slice(0,5) + ' ' + contact.phone_local.slice(5);
  if (mask.includes('999-999') || mask.includes('000-000'))
    return contact.phone_local.slice(0,5) + '-' + contact.phone_local.slice(5);

  // maxlength hints — infer whether the field expects a bare local number,
  // or one with a country code prefix (91 = India dial code), based on how
  // many characters it will accept.
  if (maxlength === 10) return contact.phone_local;
  if (maxlength === 12) return '+91' + contact.phone_local;
  if (maxlength === 13) return '+91 ' + contact.phone_local;
  if (maxlength > 0 && maxlength < 10) return contact.phone_local.slice(0, maxlength);

  // Pattern hints — an HTML `pattern` attribute requiring exactly 10 or 12
  // digits tells us which format will pass validation.
  if (pattern.includes('\\d{10}')) return contact.phone_local;
  if (pattern.includes('\\d{12}')) return '91' + contact.phone_local;

  // Context hints — if the label/placeholder explicitly asks for a country
  // code or international format, use the full international number.
  if (ctx.includes('with country') || ctx.includes('country code') ||
      ctx.includes('+91') || ctx.includes('international')) return contact.phone;

  return contact.phone_local;
}

// ── Get label from DOM element ────────────────────────────────────────────────
// NOTE: this string is currently unused as a standalone executeScript call
// (fillAllFields inlines its own copy of getLabel() inside the big
// executeScript below so it can run together with the rest of the DOM scan
// in one round-trip). It's kept here — same fallback chain, same order — as
// a documented/reusable reference version.
// The strategy tries, in order of reliability, every common way a form
// field's purpose is conveyed to a human user or a screen reader:
//   1. <label for="id">            — the standard, most reliable association
//   2. aria-label                  — explicit accessibility label
//   3. aria-labelledby             — label built from other element(s) by id
//   4. a <label> wrapping the input (implicit label association)
//   5. the text of the immediately preceding sibling element
//   6. a label found in the immediate/grandparent container (custom widgets
//      that don't use <label> at all — divs/spans with placeholder text)
//   7. a <fieldset><legend> ancestor (for grouped/radio-style fields)
//   8. data-label / data-placeholder / data-name / data-field attributes
//      (frameworks / custom form builders that store metadata this way)
//   9. last resort: whatever attributes the input itself carries
//      (placeholder, name, id)
const GET_LABEL_FN = `
function getLabel(el) {
  // 1. label[for=id]
  if (el.id) {
    var l = document.querySelector('label[for="'+el.id+'"]');
    if (l) return l.innerText.trim();
  }
  // 2. aria-label
  var aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  // 3. aria-labelledby
  var lby = el.getAttribute('aria-labelledby');
  if (lby) {
    var parts = lby.split(/\\s+/).map(function(id){
      var lb = document.getElementById(id);
      return lb ? lb.innerText.trim() : '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  // 4. wrapping label
  var wrap = el.closest('label');
  if (wrap) return wrap.innerText.replace(el.value||'','').trim();
  // 5. previous sibling text/label
  var prev = el.previousElementSibling;
  if (prev && !['INPUT','SELECT','TEXTAREA','BUTTON'].includes(prev.tagName) && prev.innerText)
    return prev.innerText.trim();
  // 6. parent div/span text nodes
  var par = el.parentElement;
  if (par && par.tagName !== 'FORM') {
    var txt = Array.from(par.childNodes)
      .filter(function(n){ return n.nodeType===3; })
      .map(function(n){ return n.textContent.trim(); })
      .filter(Boolean).join(' ');
    if (txt) return txt;
    // check grandparent for label
    var gpar = par.parentElement;
    if (gpar && gpar.tagName !== 'FORM') {
      var glbl = gpar.querySelector('label,span,p,div');
      if (glbl && glbl !== par && glbl.innerText) return glbl.innerText.trim();
    }
  }
  // 7. fieldset legend
  var fs = el.closest('fieldset');
  if (fs) { var lg = fs.querySelector('legend'); if (lg) return lg.innerText.trim(); }
  // 8. data attributes
  var dl = el.getAttribute('data-label') || el.getAttribute('data-placeholder') ||
           el.getAttribute('data-name')  || el.getAttribute('data-field');
  if (dl) return dl.trim();
  // 9. placeholder / name / id (last resort)
  return el.placeholder || el.name || el.id || '';
}
`;

// ── Scan form fields ──────────────────────────────────────────────────────────
// Main entry point (also called a second time by main.js as a retry pass
// after scrolling, reusing the same `usedFields` set so already-filled
// fields are not re-filled).
async function fillAllFields(driver, form, contact, usedFields, filled, failed) {
  let pairs;
  try {
    // Everything below runs *inside the browser* via executeScript — it
    // collects one plain-object "descriptor" per visible fillable field
    // (inputs excluding hidden/submit/button/image/reset/file, plus
    // textareas and selects) so all the DOM inspection happens in a single
    // round trip instead of one executeScript call per field.
    pairs = await driver.executeScript(function(form, captchaPatterns) {
      // inline getLabel
      // Same fallback chain as GET_LABEL_FN above (duplicated here because
      // executeScript callbacks can't reference outer closures/strings —
      // everything the callback needs must be defined inside it or passed
      // in as an argument).
      function getLabel(el) {
        if (el.id) { var l=document.querySelector('label[for="'+el.id+'"]'); if(l) return l.innerText.trim(); }
        // Also check by aria-labelledby id
        var lblId = el.getAttribute('aria-labelledby') || (el.id ? el.id+'_label' : '');
        if (lblId) { var ll=document.getElementById(lblId); if(ll) return ll.innerText.trim(); }
        var aria=el.getAttribute('aria-label'); if(aria) return aria.trim();
        var lby=el.getAttribute('aria-labelledby');
        if(lby){ var parts=lby.split(/\s+/).map(function(id){ var lb=document.getElementById(id); return lb?lb.innerText.trim():''; }).filter(Boolean); if(parts.length) return parts.join(' '); }
        var wrap=el.closest('label'); if(wrap) return wrap.innerText.replace(el.value||'','').trim();
        var prev=el.previousElementSibling;
        if(prev&&!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(prev.tagName)&&prev.innerText) return prev.innerText.trim();
        var par=el.parentElement;
        if(par&&par.tagName!=='FORM'){
          var txt=Array.from(par.childNodes).filter(function(n){return n.nodeType===3;}).map(function(n){return n.textContent.trim();}).filter(Boolean).join(' ');
          if(txt) return txt;
          var gpar=par.parentElement;
          if(gpar&&gpar.tagName!=='FORM'){var glbl=gpar.querySelector('label,span,p');if(glbl&&glbl!==par&&glbl.innerText)return glbl.innerText.trim();}
        }
        var fs=el.closest('fieldset'); if(fs){var lg=fs.querySelector('legend');if(lg)return lg.innerText.trim();}
        var dl=el.getAttribute('data-label')||el.getAttribute('data-placeholder')||el.getAttribute('data-name')||el.getAttribute('data-field');
        if(dl) return dl.trim();
        return el.placeholder||el.name||el.id||'';
      }
      // Collect candidate fields: any visible input (except hidden/submit/
      // button/image/reset/file types, which are never user-fillable text
      // fields) plus textareas and selects. The offsetParent!==null check
      // filters out display:none elements, but some form builders keep
      // legitimately-used fields inside wrapper elements with special
      // "hidden_container"/"frm_hidden" classes (e.g. conditional fields
      // that get revealed by JS) — those are allowed through too.
      var inputs=Array.from(form.querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=file]),textarea,select'
      )).filter(function(el){return el.offsetParent!==null || el.closest('[class*=hidden_container]') || el.closest('[class*=frm_hidden]');});
      return inputs.map(function(el){
        var label=getLabel(el);
        // Build the combined lowercase "context string" used by matchField()
        // — every attribute that might hint at the field's purpose.
        var ctx=(label+' '+el.name+' '+el.id+' '+(el.placeholder||'')+' '+
                 (el.getAttribute('autocomplete')||'')+' '+(el.getAttribute('data-label')||'')+' '+
                 (el.getAttribute('data-name')||'')+' '+(el.getAttribute('data-field')||'')).toLowerCase();
        var tag=el.tagName.toLowerCase();
        var type=(el.type||'text').toLowerCase();
        var style=window.getComputedStyle(el);
        // Honeypot detection: bots-only fields that legitimate users never
        // see (display:none / visibility:hidden / opacity:0 / negative
        // tabindex / zero size). Filling these would flag the submission as
        // spam, so they must be identified and skipped.
        var isHoneypot=style.display==='none'||style.visibility==='hidden'||
                       style.opacity==='0'||el.tabIndex===-1||
                       (el.offsetWidth===0&&el.offsetHeight===0);
        var isCaptcha=captchaPatterns.some(function(p){return ctx.indexOf(p)!==-1;});
        // For <select> elements, also capture their options (value + visible
        // text) up front so the dropdown-choosing logic later doesn't need
        // another round trip into the page.
        var opts=tag==='select'?Array.from(el.options).map(function(o){return{value:o.value,text:o.text.trim().toLowerCase()};}):[];
        return{
          el:el,ctx:ctx,label:label,tag:tag,type:type,
          name:el.name||'',id:el.id||'',placeholder:el.placeholder||'',
          isHoneypot:isHoneypot,isCaptcha:isCaptcha,isSelect:tag==='select',options:opts,
          mask:el.getAttribute('data-inputmask')||el.getAttribute('data-mask')||el.getAttribute('data-inputmask-mask')||'',
          pattern:el.getAttribute('pattern')||'',
          maxlength:el.getAttribute('maxlength')||''
        };
      });
    }, form, CAPTCHA_PATTERNS);
  } catch (_) { return; }
  if (!pairs || !pairs.length) return;

  // Print scan table — purely diagnostic console output showing every field
  // found in the form, what it would be classified as, and why (honeypot /
  // captcha / select / matched key / no match) to make debugging a new site
  // straightforward.
  console.log('      ┌──────────────────────┬──────────────────┬────────┬──────────────────');
  console.log('      │ Label                │ name/id          │ type   │ → fill');
  console.log('      ├──────────────────────┼──────────────────┼────────┼──────────────────');
  for (const f of pairs) {
    const lbl = (f.label||'').slice(0,20).padEnd(20);
    const nid = (f.name||f.id||'').slice(0,16).padEnd(16);
    const typ = (f.isSelect?'select':f.type).slice(0,6).padEnd(6);
    let fill  = '✗ no match';
    if (f.isHoneypot)    fill = '⚠ honeypot';
    else if (f.isCaptcha) fill = '⚠ captcha';
    else if (f.isSelect)  fill = 'select';
    else { const ft = matchField(f.ctx, f.tag, f.type); if (ft) fill = `→ [${ft}]`; }
    console.log(`      │ ${lbl} │ ${nid} │ ${typ} │ ${fill}`);
  }
  console.log('      └──────────────────────┴──────────────────┴────────┴──────────────────');

  for (const f of pairs) {
    if (!f.el || f.isHoneypot || f.isCaptcha) continue;
    // Checkboxes/radios are not filled here — checkboxes (consent/terms)
    // are handled separately by checkCheckboxes(); radios are left alone
    // entirely (no generic rule for choosing among arbitrary radio groups).
    if (f.type === 'checkbox' || f.type === 'radio') continue;

    // ── Selects ──────────────────────────────────────────────────────────────
    // Dropdowns can't be "typed into" — instead we pick the most sensible
    // existing <option> based on the dropdown's label/purpose.
    if (f.isSelect) {
      const label = (f.label || f.name || f.id || '').toLowerCase();
      const opts  = f.options;

      // Filter out placeholder/instructional options ("-- Select --",
      // "Choose one", "N/A", etc.) so they're never accidentally "chosen" —
      // we only want to pick from options that represent a real value.
      const real = opts.filter(o => {
        if (!o.value || o.value === '') return false;
        const t = o.text.trim().toLowerCase();
        const placeholders = ['--','---','select','please select','choose','pick','none',
          'please choose','select one','select an option','- select -','--- select ---',
          'select a','choose a','choose an','n/a','other'];
        return !placeholders.some(p => t === p || t.startsWith(p+' ') || t.startsWith(p+'-'));
      });
      // If every option looked like a placeholder (unlikely), fall back to
      // any option that at least has a non-empty value.
      const pool = real.length ? real : opts.filter(o => o.value && o.value !== '');
      if (!pool.length) continue;

      let chosen = null;

      // Phone/dial code → India +91
      // If the label suggests a country-code/dial dropdown, or an option
      // literally contains "+91"/"india", prefer that option (the contact
      // details used by this tool are India-based).
      if (/phone|mobile|country.?code|dial|calling|flag/.test(label) ||
          pool.some(o => o.text.includes('+91') || o.text.includes('india'))) {
        chosen = pool.find(o =>
          o.text.includes('+91') || o.text.includes('india') ||
          o.value === '+91' || o.value === '91' || o.value.toLowerCase() === 'in');
      }

      // Country → India
      if (!chosen && /country|nation|location/.test(label)) {
        chosen = pool.find(o =>
          o.text.includes('india') || o.value.toLowerCase() === 'in' ||
          o.value === '91' || o.value.toLowerCase() === 'india');
      }

      // Service/inquiry type → digital marketing related
      // For "what service are you interested in" style dropdowns, prefer an
      // option relevant to digital marketing (this tool's outreach niche),
      // then fall back to any generic "general inquiry"/"other" option, and
      // finally to simply the first real option if nothing matches at all.
      if (!chosen && /service|interest|topic|subject|inquiry|enquiry|type|reason|department|help|looking/.test(label)) {
        const PREFER = [
          'digital marketing','seo','social media','marketing','advertising',
          'ppc','content marketing','branding','web design','web development',
          'general inquiry','general enquiry','general information','general',
          'other','inquiry','enquiry','information','question','contact us',
        ];
        chosen = pool.find(o => PREFER.some(p => o.text === p || o.text.includes(p)));
        // fallback: first real option
        if (!chosen) chosen = pool[0];
      }

      // Budget → flexible/custom
      // Prefer a vague/negotiable budget option rather than committing to a
      // specific price bracket.
      if (!chosen && /budget|price|cost|investment/.test(label)) {
        chosen = pool.find(o =>
          o.text.includes('flexible') || o.text.includes('custom') ||
          o.text.includes('discuss') || o.text.includes('other'));
      }

      // Final fallback for any other kind of dropdown: just pick the first
      // real (non-placeholder) option so the field isn't left blank.
      if (!chosen) chosen = pool[0];

      try {
        await driver.executeScript(
          'arguments[0].value=arguments[1]; arguments[0].dispatchEvent(new Event("change",{bubbles:true}));',
          f.el, chosen.value);
        console.log(`      ✓ Select [${f.label||f.name}] → '${chosen.text}'`);
        filled.push(`select:${f.label||f.name||'select'}`);
      } catch (_) {}
      continue;
    }

    // ── Text inputs ───────────────────────────────────────────────────────────
    const fieldKey = matchField(f.ctx, f.tag, f.type);
    if (!fieldKey) {
      // Couldn't classify this field at all — log it for later analysis
      // (form_results/unknown_fields.log) instead of silently ignoring it.
      try {
        const url = await driver.getCurrentUrl().catch(() => '');
        logUnknown(url, f.label, f.name, f.id, f.placeholder, f.type);
      } catch(_) {}
      continue;
    }
    // Avoid double-filling: if this logical field (e.g. 'email') was already
    // filled earlier in this same scan (or in a previous fillAllFields call
    // sharing the same `usedFields` Set, e.g. the retry pass in main.js),
    // skip it even though this particular DOM element matched again.
    if (usedFields.has(fieldKey)) continue;

    // Map each logical field key to the actual value to type, pulled from
    // the `contact` config object. Phone gets special formatting via
    // getPhoneValue() since the right string depends on the target input's
    // mask/pattern/maxlength.
    const values = {
      first_name: contact.first_name,
      last_name:  contact.last_name,
      full_name:  contact.full_name,
      email:      contact.email,
      phone:      getPhoneValue(contact, f.ctx, f.mask, f.pattern, f.maxlength),
      company:    contact.company,
      website:    contact.website,
      job_title:  contact.job_title,
      subject:    contact.subject,
      budget:     contact.budget,
      address:    contact.address,
      message:    contact.message,
    };
    const value = values[fieldKey];
    if (!value) continue;

    try {
      await driver.executeScript(SET_VALUE_JS, f.el, value);
      const short = value.slice(0,40) + (value.length>40?'...':'');
      console.log(`      ✓ [${f.label||f.name||f.id}] → [${fieldKey}] "${short}"`);
      filled.push(fieldKey);
      usedFields.add(fieldKey);
      // Small randomized delay between fields to look more human-like and
      // give any field-level JS (validation, masking) time to react.
      await sleep(Math.floor(Math.random() * 300 + 150));
    } catch (_) {}
  }

  // Track failed fields — any logical field key from FIELD_DEFS that never
  // got filled (not present in `usedFields`) and isn't already recorded is
  // added to `failed`, so main.js can report which expected fields were
  // missing from this particular form.
  for (const [key] of FIELD_DEFS) {
    if (!usedFields.has(key) && !failed.includes(key)) failed.push(key);
  }
}

// Ticks every visible, currently-unchecked checkbox inside the form — used
// for "I agree to the terms" / consent checkboxes that often block
// submission if left unchecked. There's no attempt to distinguish which
// checkbox means what; any visible unchecked checkbox in the form is
// assumed safe to check.
async function checkCheckboxes(driver, form) {
  let n = 0;
  try {
    n = await driver.executeScript(`
      var n=0;
      Array.from(arguments[0].querySelectorAll("input[type='checkbox']")).forEach(function(cb){
        if(cb.offsetParent!==null && !cb.checked){ cb.click(); n++; }
      });
      return n;
    `, form);
  } catch (_) {}
  if (n) console.log(`      ✓ Checked ${n} checkboxes`);
}

// Stubs for API compat
// These functions used to contain separate per-field-type filling logic;
// that logic has since been consolidated into fillAllFields() above. They
// are kept as no-op async functions purely so any old code still importing
// them (e.g. older versions of main.js) doesn't throw at require()/call
// time.
async function fillDropdownFields(){}
async function fillNameFields(){}
async function fillEmailField(){}
async function fillPhoneFields(){}
async function fillCompanyFields(){}
async function fillMessageFields(){}

module.exports = {
  fillAllFields, checkCheckboxes,
  fillDropdownFields, fillNameFields, fillEmailField,
  fillPhoneFields, fillCompanyFields, fillMessageFields,
};
