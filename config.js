// ════════════════════════════════════════════════════════════════════════════
// config.js — Central configuration & contact-identity rotator
//
// PURPOSE / ROLE IN THE PIPELINE:
//   This is the single source of truth for:
//     1. The pool of "sender" identities (name/email) that get rotated into
//        contact forms — using several different names/emails spreads out
//        the outreach and avoids every single form submission looking
//        identical.
//     2. The full message payload (name, phone, company, sales pitch text,
//        etc.) that gets typed into each contact form.
//     3. File-path / tuning constants used by the rest of the pipeline
//        (where to read URLs from, where to write results, timeouts,
//        captcha retry limits, and the list of CSV column names used when
//        logging results).
//
// HOW IT WORKS (high level):
//   - `_CONTACTS` is a hard-coded array of {first_name, last_name, email}.
//   - `getNextContact()` picks the next contact round-robin (using a module
//     -level counter `_contactIndex`), and builds a full "contact" object
//     (name, phone, company, pitch message with the sender's name
//     interpolated at the bottom, etc.). Every call advances the rotation,
//     so each processed URL in main.js gets a different identity.
//   - A single default `contact` is computed once at module load (for any
//     code that wants a static contact instead of the rotating one), and
//     then the rotation index is reset back to 0 so the *real* loop in
//     main.js still starts from contact #0.
//   - The rest of the file just defines plain constants (paths, timeouts,
//     retry counts, CSV column list) and exports everything via
//     `module.exports`.
//
// DEPENDENCIES / USED BY:
//   - No dependencies of its own (pure constants/data module).
//   - Imported by main.js (getNextContact, URL_FILE, OUTPUT_DIR, CSV_FIELDS,
//     CAPTCHA_WAIT_TIMEOUT, MAX_CAPTCHA_RETRIES, CSV_PATH), and indirectly
//     by other pipeline modules (result_tracker.js, driver_setup.js,
//     captcha/handler.js, etc.) that need these same constants.
// ════════════════════════════════════════════════════════════════════════════

// config.js
'use strict';

// ── Rotating contact identities ───────────────────────────────────────────────
// Pool of sender identities. main.js calls getNextContact() once per URL so
// consecutive form submissions don't all come from the exact same name/email —
// several look-alike addresses under a couple of domains are used here.
const _CONTACTS = [
  { first_name: 'Farhan', last_name: 'Ansari',  email: 'farhan.ansari@perceptionsystem.in' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'rafiq@perceptionsystem.net' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'raf@perceptionsystem.net' },
  { first_name: 'Ubbad',  last_name: 'Mansuri', email: 'ubbad@f3clicks.in' },
  { first_name: 'Ubbad',  last_name: 'Mansuri', email: 'ubbad@f3clicks.net' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'rafiq@perceptionsystem.in' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'raf@perceptionsystem.in' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'rafiq@perceptionsystem.co.in' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'raf@perceptionsystem.co.in' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'raf@perceptionsystem.us' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'rafiq@perceptionsystem.us' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'rafiq@perceptionoutreach.com' },
  { first_name: 'Rafiq',  last_name: 'Ansari',  email: 'raf@perceptionoutreach.com' },
];

// Module-level counter that tracks which _CONTACTS entry to hand out next.
let _contactIndex = 0;

// Returns the next contact in round-robin order, fully expanded into the
// shape that fields.js / submitter.js expect (name pieces, phone, company,
// website, subject line, and a full outreach message with the sender's name
// stitched into the signature).
function getNextContact() {
  const base = _CONTACTS[_contactIndex % _CONTACTS.length];
  _contactIndex++;
  const full = `${base.first_name} ${base.last_name}`;
  return {
    first_name:         base.first_name,
    last_name:          base.last_name,
    full_name:          full,
    job_title:          'Business Development',
    email:              base.email,
    phone:              '+91 9913298992',
    phone_country_code: '+91',
    phone_local:        '9913298992',
    company:            'Perception System',
    website:            'https://www.perceptionsystem.com/',
    subject:            'White-Label Dev & AI Services for Your Agency Clients',
    budget:             'Flexible',
    address:            'Ahmedabad, Gujarat, India',
    message: `Hi Team,

I came across your agency and love the work you're doing for your clients!

I'm reaching out from Perception System — a technology partner trusted by agencies like yours to deliver white-label services that you can resell under your own brand:

• White-Label Web & Mobile App Development (CRM, ERP, SaaS, custom builds)
• AI-powered automation & chatbot solutions for your clients
• White-Label SEO, SMM & Pay-after-results Digital Marketing
• Dedicated dev teams you can plug into your existing projects

We work quietly in the background — your clients never know we exist. You get the credit, we do the heavy lifting.

Trusted by agencies serving Dubai Govt., Stanford University & 500+ global clients.

Would love to explore how we can help you scale without hiring overhead.

Warm regards,
${full}
Business Development | Perception System
https://www.perceptionsystem.com/`,
  };
}

// Default contact for backward compat.
// Some code may just want `contact` (a static object) rather than calling
// getNextContact() itself. Computing it here consumes one "slot" of the
// rotation, so immediately reset the index back to 0 afterwards — otherwise
// the real per-URL loop in main.js would skip contact #0 and start at #1.
const contact = getNextContact();
_contactIndex = 0; // reset so main loop starts from index 0

// ── File paths & tuning constants ─────────────────────────────────────────────
const URL_FILE            = 'retry_urls.txt';           // input: list of URLs to process (one per line)
const OUTPUT_DIR          = 'form_results';              // where results/logs/progress get written
const CSV_PATH            = `${OUTPUT_DIR}/contact_results.csv`; // final results CSV
const PROGRESS_FILE       = `${OUTPUT_DIR}/progress.txt`;        // tracks last processed index for resume support
const PAGE_LOAD_TIMEOUT   = 20000;   // ms — how long a page is allowed to take to load before being treated as "slow"
const CAPTCHA_WAIT_TIMEOUT= 20000;   // ms — how long to wait for a captcha to be solved
const CAPTCHA_POLICY      = 'auto';  // captcha handling mode (auto-solve vs manual, etc.)
const TWOCAPTCHA_API_KEY  = process.env.TWOCAPTCHA_API_KEY || null; // optional 3rd-party captcha-solving service key
const CAPSOLVER_API_KEY   = process.env.CAPSOLVER_API_KEY  || null; // optional 3rd-party captcha-solving service key
const MAX_CAPTCHA_RETRIES = 1;       // how many times main.js will retry a URL (fresh browser) if captcha solving fails

// Column order used when writing the results CSV (result_tracker.js) — keeping
// this centralized ensures every row has the same shape/order.
const CSV_FIELDS = [
  'url','status','details','load_status','load_time_s',
  'contact_page_status','form_status','fields_filled',
  'filled_fields','failed_fields',
  'validation_status','captcha_status','submit_status','success_status',
];

module.exports = {
  contact, getNextContact, URL_FILE, OUTPUT_DIR, CSV_PATH, PROGRESS_FILE,
  PAGE_LOAD_TIMEOUT, CAPTCHA_WAIT_TIMEOUT, CAPTCHA_POLICY,
  TWOCAPTCHA_API_KEY, CAPSOLVER_API_KEY, MAX_CAPTCHA_RETRIES, CSV_FIELDS,
};
