// navigator.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// This file solves one specific problem in the pipeline: after Selenium has
// loaded a business's homepage, the actual contact form is very often NOT on
// that page — it usually lives on a separate "/contact" (or similarly named)
// page reachable via a nav link. `findContactPage()` is the "get from
// wherever we landed to a page that actually has a usable contact form"
// step. It is called immediately after the initial `driver.get(url)` in
// main.js, before `form_finder.js` ever tries to locate the `<form>` element
// itself.
//
// ── How it works (high level) ───────────────────────────────────────────────
// `findContactPage(driver)` tries several strategies in order, stopping as
// soon as one succeeds, and returns `true`/`false` depending on whether it
// believes the driver is now sitting on a genuine contact page:
//   1. URL check — if the current URL already contains an obvious contact
//      keyword (e.g. "/contact", "/enquiry"), assume we're already there.
//   2. In-page form check — inject JS (`HAS_CONTACT_FORM_JS`) that inspects
//      every `<form>` on the current page (plus a formless fallback) to see
//      if something that looks like a real contact form (has an email field
//      and/or textarea, isn't a login/search form, has enough visible
//      fields) already exists on the homepage. Many small business sites put
//      the contact form directly on the homepage, so this avoids an
//      unnecessary navigation.
//   3. Link scanning — inject JS (`SCAN_LINKS_JS`) that scores every `<a>`
//      link on the page by how "contact-like" its visible text and href are
//      (using whitelists of strong contact phrases/keywords and blacklists
//      of unrelated pages like "about"/"careers"/"shop"), then visits the
//      top-scoring candidates in order, re-checking with the same "has a
//      contact form" JS after each navigation, and backing out again if a
//      candidate turns out to be a dead end.
//   4. Common-path fallback — if link scanning found nothing, brute-force a
//      short list of conventional contact/appointment URL paths (e.g.
//      `/contact-us`, `/get-in-touch`, `/request-appointment`) directly
//      against the site's origin.
//   5. Give up gracefully — if nothing above worked, navigate back to the
//      original page and return `false`; the caller (`form_finder.js` via
//      main.js) will still attempt to find a form on whatever page we ended
//      up on, since some sites have non-standard layouts this function can't
//      detect.
//
// Exported function: `findContactPage(driver)`.
//
// ── Dependencies / usage ────────────────────────────────────────────────────
// - Takes only a Selenium `driver` (built by `driver_setup.js`'s
//   `makeDriver()`) as input — no other project modules are required here;
//   all page inspection is done via inline JS strings executed in-browser
//   with `driver.executeScript`.
// - Called from `main.js` right after a page loads (`const onContact =
//   await findContactPage(driver);`), before `form_finder.js`'s
//   `findContactForm()` looks for the actual `<form>` element to fill.
'use strict';

// URL substrings that, if present in the current page's URL, are treated as
// strong evidence we're already on a contact-style page (used both to short-
// circuit at the very start and to confirm success after navigating).
const CONTACT_URL_WORDS = ['contact','get-in-touch','inquiry','enquiry','feedback','reach-us'];

// Link text phrases considered strong signals that a link points to a
// contact page. Includes a few non-English variants (Spanish/Portuguese)
// since the scraped businesses are worldwide.
const STRONG_TEXT = [
  'contact us','contact','get in touch','reach us','get in contact',
  'contact form','reach out','write to us','feedback','send us a message',
  'contacto','contáctanos','contactanos','contato','enquire','inquire',
];
// href substrings that add extra confidence when combined with (or even
// without) matching link text.
const HREF_KEYWORDS  = ['contact','inquiry','enquiry','feedback','reach-us','get-in-touch'];
// Link text starting with these phrases is excluded outright — these are
// common nav items that are never contact pages, so we don't waste
// navigations chasing them even if they happen to also match a keyword.
const BLACKLIST_TEXT = ['about','about us','home','services','portfolio','blog','news',
  'gallery','team','careers','jobs','faq','privacy','terms','sitemap','login',
  'register','shop','store','products','pricing','testimonials','reviews'];
// Same idea but matched against the href path instead of the visible text.
const BLACKLIST_HREF = ['about','javascript','mailto','tel','login','register',
  'shop','cart','checkout','blog','news','gallery','portfolio','careers','jobs'];

// Check if current page already has a usable contact form (with message/textarea)
//
// Injected into the page via driver.executeScript(). Logic:
//  - Loop over every <form>, skip password forms (login) and search forms
//    (has "search" in id/class/markup but no email field — heuristic to
//    avoid mistaking a site-search box for a contact form).
//  - A form counts as a real contact form if it has a textarea OR an email
//    field, AND has at least 2 visible (non-hidden, rendered) input/textarea
//    /select fields — this filters out things like a bare "subscribe with
//    just an email" newsletter box.
//  - If no <form> qualifies, fall back to a "formless" check: some modern
//    sites build contact UI without a <form> tag (JS-driven submission) — if
//    there's at least one visible email input and one visible textarea
//    anywhere on the page, treat that as a contact form too.
const HAS_CONTACT_FORM_JS = `
(function() {
  var forms = Array.from(document.querySelectorAll('form') || []);
  for (var i = 0; i < forms.length; i++) {
    var f = forms[i];
    var hasTextarea = !!f.querySelector('textarea');
    var hasEmail    = !!f.querySelector(
      'input[type=email],[name*=email i],[id*=email i],[placeholder*=email i]');
    var visible = Array.from(f.querySelectorAll('input,textarea,select'))
      .filter(function(e){ return e.offsetParent !== null && e.type !== 'hidden'; }).length;
    var snippet = (f.id+' '+f.className+' '+(f.innerHTML||'').substring(0,1000)).toLowerCase();
    var isPw = !!f.querySelector('input[type=password]');
    var isSearch = snippet.indexOf('search') !== -1 && !hasEmail;
    if (isPw || isSearch) continue;
    if ((hasTextarea || hasEmail) && visible >= 2) return true;
  }
  // Formless inputs with email + textarea
  var emails = Array.from(document.querySelectorAll(
    'input[type=email],[name*=email i],[placeholder*=email i]'
  )).filter(function(e){ return e.offsetParent !== null; });
  var tas = Array.from(document.querySelectorAll('textarea'))
    .filter(function(e){ return e.offsetParent !== null; });
  return emails.length > 0 && tas.length > 0;
})();
`;

// Scans every <a href> on the page and scores it as a candidate "contact
// page" link, so we can visit the most promising ones first instead of
// clicking every link on the page.
//
// Scoring (higher = more likely to be a contact link):
//  - Exact text match against a strong contact phrase: +20
//  - Partial text match (phrase appears anywhere in the link text): +8
//  - href contains a contact-related keyword: +5
// Links are skipped entirely (score irrelevant) if they're empty/placeholder
// (#, javascript:, mailto:, tel:) or match the text/href blacklists. Results
// are deduped by href, sorted by score descending, and only the top 5 are
// returned to bound how much navigation we do per page.
//
// Takes its keyword/blacklist arrays as arguments (arguments[0..3]) rather
// than hardcoding them in the injected string, so the same JS blob can be
// reused with the module-level constants defined above.
const SCAN_LINKS_JS = `
(function(strongKws, hrefKws, blackText, blackHref) {
  var scored = []; var seen = new Set();
  document.querySelectorAll('a[href]').forEach(function(a) {
    var href  = (a.getAttribute('href') || '').trim();
    var text  = (a.innerText || a.textContent || '').trim().toLowerCase().replace(/\\s+/g,' ');
    var hrefL = href.toLowerCase();
    if (!href || href === '#' || href.startsWith('javascript:')
        || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (blackText.some(function(b){ return text === b || text.startsWith(b+' '); })) return;
    if (blackHref.some(function(b){ return hrefL.indexOf('/'+b) !== -1; })) return;
    var score = 0;
    strongKws.forEach(function(k) {
      if (text === k) score += 20;
      else if (text.indexOf(k) !== -1) score += 8;
    });
    if (hrefKws.some(function(k){ return hrefL.indexOf(k) !== -1; })) score += 5;
    if (score > 0 && !seen.has(href)) {
      seen.add(href);
      scored.push({ href: href, label: text || href, score: score });
    }
  });
  scored.sort(function(a,b){ return b.score - a.score; });
  return scored.slice(0, 5).map(function(s){ return [s.href, s.label, s.score]; });
})(arguments[0], arguments[1], arguments[2], arguments[3]);
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Polls document.readyState until it reports 'complete' or the timeout
// elapses. Used after every navigation in this file because Selenium's own
// `driver.get()` can return before client-side JS (which many contact forms
// and nav menus depend on) has finished rendering.
async function waitForPageReady(driver, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const state = await driver.executeScript('return document.readyState');
      if (state === 'complete') return;
    } catch (_) {}
    await sleep(200);
  }
}

// Quick string check: does this URL look like a contact page based on
// known keyword substrings?
function isContactUrl(url) {
  return CONTACT_URL_WORDS.some(w => url.toLowerCase().includes(w));
}

// Main entry point: attempts to get the driver onto a page that has a real
// contact form, trying progressively more aggressive strategies. Returns
// `true` if it believes it succeeded, `false` if it gave up (the caller will
// still try to find a form on whatever page is currently loaded).
async function findContactPage(driver) {
  console.log('   🔎 Looking for contact page...');
  const baseUrl = await driver.getCurrentUrl();

  // 1. Already on contact URL?
  if (isContactUrl(baseUrl)) {
    console.log('      ✅ Already on contact page (URL match)');
    return true;
  }

  // 2. Current page already has a contact form with message field? Use it directly
  // (cheapest possible success case — no extra navigation needed at all)
  try {
    const hasForm = await driver.executeScript(HAS_CONTACT_FORM_JS);
    if (hasForm) {
      console.log('      ✅ Contact form found on current page');
      return true;
    }
  } catch (_) {}

  // 3. Look for contact page link
  // Ask the page for its best-guess contact links (scored/sorted, top 5).
  let candidates = [];
  try {
    candidates = await driver.executeScript(
      SCAN_LINKS_JS, STRONG_TEXT, HREF_KEYWORDS, BLACKLIST_TEXT, BLACKLIST_HREF
    ) || [];
  } catch (_) {}

  if (candidates.length) {
    console.log(`      🔗 Candidates: ${candidates.map(c => `"${c[1]}"(${c[2]})`).join(', ')}`);
  }

  // Visit each candidate link in score order until one actually leads to a
  // page with a contact form (or a contact-looking URL).
  for (const [href, label, score] of candidates) {
    try {
      // Resolve relative hrefs (e.g. "/contact") into an absolute URL using
      // the current page's origin, since executeScript only gives us the
      // raw attribute value, not the browser-resolved absolute URL.
      let absUrl = href;
      if (!href.startsWith('http')) {
        const u = new URL(baseUrl);
        absUrl = `${u.protocol}//${u.host}${href.startsWith('/') ? href : '/' + href}`;
      }
      // Skip if this "candidate" actually resolves back to the exact same
      // page we're already on (same host + pathname) — no point reloading it.
      const u1 = new URL(absUrl), u2 = new URL(baseUrl);
      if (u1.pathname === u2.pathname && u1.host === u2.host) continue;
      // Double-check against the href blacklist on the resolved absolute
      // URL too, in case relative resolution changed how it reads.
      if (BLACKLIST_HREF.some(b => absUrl.toLowerCase().includes('/' + b))) continue;

      await driver.get(absUrl);
      await waitForPageReady(driver, 6000);
      await sleep(1500); // extra settle time for client-rendered content/menus
      const destUrl = await driver.getCurrentUrl();

      // Verify destination has a contact form with message field
      const destHasForm = await driver.executeScript(HAS_CONTACT_FORM_JS).catch(() => false);
      if (isContactUrl(destUrl) || destHasForm) {
        console.log(`      ✅ Navigated to: "${label}" (score=${score})`);
        return true;
      }

      // Candidate turned out to be a dead end (e.g. redirected elsewhere or
      // no real form) — go back and try the next-best candidate.
      console.log(`      ⚠️ "${label}" has no contact form — going back`);
      await driver.navigate().back();
      await waitForPageReady(driver, 4000);
    } catch (_) {}
  }

  // Fallback: try common contact URL paths directly
  // No link on the page pointed to a contact page (e.g. contact info is only
  // in a footer image, or nav is JS-driven in a way we couldn't scan) — so
  // brute-force a handful of conventional paths against the site's origin.
  // Includes appointment-booking paths since these often serve the same
  // "get in touch with us" purpose for service businesses (e.g. clinics).
  try {
    const base = new URL(baseUrl);
    const commonPaths = ['/contact','/contact-us','/contact_us','/get-in-touch',
      '/appointment','/appointments','/new-patient','/new-patients','/request-appointment'];
    for (const p of commonPaths) {
      try {
        const tryUrl = `${base.protocol}//${base.host}${p}`;
        await driver.get(tryUrl);
        await waitForPageReady(driver, 5000);
        await sleep(1000);
        const destUrl = await driver.getCurrentUrl();
        const destPath = new URL(destUrl).pathname;
        // If the guessed path doesn't exist, many sites redirect to "/" (home)
        // or silently rewrite back to the original path — both mean "not a
        // real page", so skip without checking for a form.
        if (destPath === '/' || destPath === base.pathname) continue;
        const destHasForm = await driver.executeScript(HAS_CONTACT_FORM_JS).catch(() => false);
        if (isContactUrl(destUrl) || destHasForm) {
          console.log(`      ✅ Found via common path: ${p}`);
          return true;
        }
      } catch (_) {}
    }
    // None of the guessed paths worked — restore the original page so the
    // caller (form_finder.js) at least has the homepage to search, rather
    // than leaving the driver stranded on the last failed guess.
    await driver.get(baseUrl).catch(() => {});
    await waitForPageReady(driver, 4000);
  } catch (_) {}

  console.log('      ℹ️ No contact page found, using current page');
  return false;
}

module.exports = { findContactPage };
