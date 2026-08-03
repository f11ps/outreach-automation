'use strict';

// ── blank_email_retry.js ────────────────────────────────────────────────────
// • Pulls rows from the MapData sheet where "All Emails", "Facebook", or
//   "LinkedIn" is blank (via code.gs → action=getBlankEmailRows)
// • Re-visits each row's website: retries email scraping + looks for a
//   Facebook page and a LinkedIn page — same extraction policy as
//   unified_scraper.js (mailto: trusted regardless of domain, free-mail
//   providers like Gmail accepted, domcontentloaded page loads so a chat
//   widget/analytics beacon can't hang the page load), applied here as a
//   standalone resumable retry pass over rows that already went through
//   unified_scraper.js once (e.g. because the browser that scraped them was
//   still running old code, or the site was down/slow that first time).
// • Writes results back into the SAME sheet row (action=updateMapContact) —
//   emails → "All Emails", Facebook → "Facebook" column, LinkedIn → "LinkedIn"
//   column (kept separate, never mixed together)
// • Never blanks out a Facebook/LinkedIn/email value a previous run already
//   found, even if this run doesn't find it again
// • Resumable: progress saved after every row → Ctrl+C safe, rerun continues
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_URL ||
  'https://script.google.com/macros/s/AKfycbwz28DvEzyPhZh9XsxhGMO1A5YpbFneKeeDmNduW2cp1GVnZuRzZw_xRYOj7TVZ9ZKf/exec';
const PROGRESS_FILE = path.join(__dirname, 'blank_email_progress.json');
const NAV_TIMEOUT = 15000;
const BROWSER_RESTART_EVERY = 40; // rows

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a) + a);

// ── Filters ────────────────────────────────────────────────────────────────
const SKIP_DOMAINS = [
  'calendly.com', 'hubspot.com', 'wa.me', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'google.com', 'apple.com',
  'maps.google.com', 'goo.gl', 'bit.ly', 'forms.gle', 'yelp.com', 'clutch.co',
];
// Without a same-domain safety net (mailto: is trusted from any domain, see
// extractMailtoEmails below — it still runs every mailto: address through
// isValidEmail), obvious junk/placeholder addresses need their own filter.
const SKIP_EMAIL_PATTERNS = [
  'sentry', 'wixpress', 'example.com', 'domain.com', 'noreply', 'no-reply',
  'test@', 'user@', 'email@', 'name@', 'info@example', 'your@', 'yourname',
  'youremail', 'sample', 'placeholder', '@2x', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  'schema.org', 'w3.org', 'wordpress', 'jquery', 'bootstrap', 'acme.com',
  'company.com', 'mail@mail', 'admin@admin', 'webmaster@', 'postmaster@',
  'sentry.io', 'godaddy.com',
];
// Small/local businesses very commonly publish only a free-mail address —
// unlike an enterprise, that's not a red flag here, so these are accepted
// (not rejected) once matched via the loose text-scan tiers below.
const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'live.com', 'aol.com', 'rediffmail.com', 'protonmail.com', 'msn.com',
];
// Link text/href keywords — this is what actually makes contact-page
// discovery name-agnostic: a link labelled "Get in Touch" or "Customer Care"
// gets found by its visible text even if the URL slug is nothing like
// "contact". The path list below is only a secondary guess for when a site
// has no such link at all (e.g. contact info only lives in the footer) —
// worth the extra page-visit cost here since this script only handles the
// residual hard cases, not every business unified_scraper.js finds.
const CONTACT_KEYWORDS = [
  'contact', 'about', 'reach', 'touch', 'connect', 'email', 'enquir',
  'inquir', 'support', 'help', 'talk', 'hire', 'quote', 'consult', 'meet',
  'branch', 'location', 'office', 'write to us', 'feedback',
  'customer service', 'customer care', 'get in touch', 'say hello',
];
const COMMON_CONTACT_PATHS = [
  '/contact', '/contact-us', '/contactus', '/contact_us', '/contact.html',
  '/about', '/about-us', '/aboutus', '/about.html',
  '/get-in-touch', '/getintouch',
  '/reach-us', '/reach-out', '/reachus',
  '/support', '/help', '/help-center', '/helpcenter',
  '/customer-service', '/customer-care',
  '/connect', '/connect-with-us', '/say-hello',
  '/enquiry', '/enquire', '/enquiries', '/inquiry', '/inquire', '/inquiries',
  '/talk-to-us', '/lets-talk', '/write-to-us', '/feedback',
];
const BLOCK_PHRASES = [
  'sucuri website firewall', 'access denied', 'cloudflare', 'just a moment',
  'checking your browser', 'forbidden', 'ddos protection', 'enable javascript',
  'please enable cookies', 'error 403', '403 forbidden', 'error 503',
  'attention required',
];

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const STRICT_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SOCIAL_URL_RE = /https?:\/\/[^\s'"<>]+(?:facebook|linkedin)\.com\/[^\s'"<>]+/gi;

// ── Email helpers ─────────────────────────────────────────────────────────
function isValidEmail(email) {
  email = (email || '').toLowerCase().trim();
  if (email.length > 100 || email.length < 6) return false;
  if (!STRICT_EMAIL_RE.test(email)) return false;
  return !SKIP_EMAIL_PATTERNS.some(p => email.includes(p));
}

function decodeCloudflareEmail(encoded) {
  try {
    const r = parseInt(encoded.substr(0, 2), 16);
    let email = '';
    for (let n = 2; n < encoded.length; n += 2) {
      email += String.fromCharCode(parseInt(encoded.substr(n, 2), 16) ^ r);
    }
    return email;
  } catch (_) {
    return '';
  }
}

function normalizeDomain(host) {
  host = (host || '').toLowerCase().trim();
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const secondLast = parts[parts.length - 2];
  if (['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(secondLast) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

// Accepted for the loose (non-mailto) tiers if it matches the site's own
// domain, OR it's on a well-known free-mail provider — anything else off-
// domain is rejected here (no structured/brand-relation signal to trust it).
function isAcceptableLooseEmail(email, siteDomain) {
  const domain = normalizeDomain((email.split('@')[1] || ''));
  if (!domain) return false;
  if (domain === normalizeDomain(siteDomain)) return true;
  return FREE_EMAIL_DOMAINS.includes(domain);
}

function filterEmailsLoose(emails, website) {
  if (!website || !emails.length) return [];
  let host;
  try { host = new URL(website).hostname; } catch (_) { return []; }
  const siteDomain = normalizeDomain(host);
  if (!siteDomain) return [];
  const matched = emails.filter(e => isValidEmail(e) && isAcceptableLooseEmail(e, siteDomain));
  return dedupeEmails(matched);
}

// Case/whitespace-insensitive de-dupe, applied at every point a final email
// list is assembled — same address should never appear twice in a cell.
function dedupeEmails(emails) {
  return [...new Set((emails || []).map(e => e.trim().toLowerCase()).filter(Boolean))].sort();
}

// Tier 0 — mailto: links, anywhere on the page. A business that wires up a
// clickable mailto link is explicitly publishing that address as *the* way
// to reach them, so this is trusted regardless of domain (unlike the loose
// tiers below) — with its own junk-pattern filter since there's no
// same-domain safety net for this tier.
function extractMailtoEmails(pageData) {
  const emails = new Set();
  (pageData.mailtoHrefs || []).forEach(href => {
    if (!/^mailto:/i.test(href)) return;
    href.slice(7).split('?')[0].split(';').forEach(e => {
      e = e.trim().toLowerCase();
      if (isValidEmail(e)) emails.add(e);
    });
  });
  return [...emails];
}

// Tier 1 — structured, deliberate publication mechanisms: data-*
// attributes, Cloudflare-obfuscated emails, and JSON-LD structured data.
// Domain-restricted (site's own domain or a free-mail provider) below.
function extractStructuredEmails(pageData) {
  const emails = new Set();

  (pageData.dataAttrEmails || []).forEach(v => {
    const e = (v || '').trim().toLowerCase();
    if (isValidEmail(e)) emails.add(e);
  });

  (pageData.cfEmails || []).forEach(enc => {
    const decoded = decodeCloudflareEmail(enc);
    if (decoded && isValidEmail(decoded)) emails.add(decoded.toLowerCase());
  });

  (pageData.jsonLd || []).forEach(raw => {
    try {
      const scan = obj => {
        if (typeof obj === 'string') collectEmailsFromText(obj, emails);
        else if (Array.isArray(obj)) obj.forEach(scan);
        else if (obj && typeof obj === 'object') Object.values(obj).forEach(scan);
      };
      scan(JSON.parse(raw));
    } catch (_) { /* not valid JSON, skip */ }
  });

  return [...emails];
}

function collectEmailsFromText(str, into) {
  const matches = (str || '').match(EMAIL_REGEX) || [];
  matches.forEach(e => { if (isValidEmail(e)) into.add(e.toLowerCase()); });
}

// Tier 2 — loose text scan across header/footer/contact sections, full body
// text and raw HTML, plus "name [at] domain [dot] tld" de-obfuscation. Wide
// net, lowest confidence — only ever trusted when domain-restricted (see
// filterEmailsLoose / scrapeContactInfo).
function extractTextScanEmails(pageData) {
  const emails = new Set();

  collectEmailsFromText(pageData.sectionText, emails);
  collectEmailsFromText(pageData.bodyText, emails);
  collectEmailsFromText(pageData.html, emails);

  const obfRe = /([A-Za-z0-9._%+-]+)\s*[[(]?\s*at\s*[\])]?\s*([A-Za-z0-9.-]+)\s*[[(]?\s*dot\s*[\])]?\s*([A-Za-z]{2,})/gi;
  let m;
  while ((m = obfRe.exec(pageData.bodyText || '')) !== null) {
    const e = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase();
    if (isValidEmail(e)) emails.add(e);
  }

  return [...emails];
}

// ── Social link helpers (identical policy to unified_scraper.js) ──────────
function cleanSocialUrl(raw) {
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    try { u = new URL('https://' + String(raw).replace(/^\/+/, '')); }
    catch (_) { return ''; }
  }

  let host = (u.hostname || '').toLowerCase();
  const pathname = decodeURIComponent(u.pathname || '').replace(/\/+$/, '');

  if (host.includes('facebook.com') && (pathname === '/l.php' || pathname === '/flx/warn')) {
    const target = u.searchParams.get('u');
    if (target) return cleanSocialUrl(target);
  }
  if (host.includes('linkedin.com') && pathname.startsWith('/redir/redirect')) {
    const target = u.searchParams.get('url');
    if (target) return cleanSocialUrl(target);
  }

  if (host.startsWith('m.')) host = host.slice(2);
  if (host.startsWith('www.')) host = host.slice(4);
  if (host.endsWith('.linkedin.com')) host = 'linkedin.com';
  if (host.endsWith('.facebook.com')) host = 'facebook.com';
  if (host === 'fb.com') host = 'facebook.com';

  let finalPath = pathname;
  if (host === 'linkedin.com') {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length > 2) finalPath = '/' + segments.slice(0, 2).join('/');
  }

  const finalHost = host === 'linkedin.com' ? 'www.linkedin.com' : host;

  return `https://${finalHost}${finalPath}`;
}

function isValidSocialUrl(rawUrl, network) {
  const clean = cleanSocialUrl(rawUrl);
  if (!clean) return false;
  let u;
  try { u = new URL(clean); } catch (_) { return false; }
  const host = u.hostname.toLowerCase();
  const p = u.pathname.toLowerCase().replace(/^\/+|\/+$/g, '');

  if (network === 'facebook') {
    if (!['facebook.com', 'fb.com'].includes(host)) return false;
    const blocked = ['share', 'sharer', 'plugins', 'dialog', 'login', 'privacy', 'tr', 'events', 'policy', 'help', 'ads'];
    return Boolean(p) && !blocked.some(b => p.startsWith(b));
  }
  if (network === 'linkedin') {
    if (host !== 'www.linkedin.com') return false;
    const allowed = ['company/', 'school/', 'showcase/', 'in/'];
    const blocked = ['feed/', 'learning/', 'pulse/', 'posts/', 'sharearticle', 'sharing/'];
    return allowed.some(a => p.startsWith(a)) && !blocked.some(b => p.startsWith(b));
  }
  return false;
}

function extractSocialLinks(pageData) {
  const links = { facebook: new Set(), linkedin: new Set() };

  (pageData.anchors || []).forEach(href => {
    ['facebook', 'linkedin'].forEach(net => {
      if (isValidSocialUrl(href, net)) links[net].add(cleanSocialUrl(href));
    });
  });

  // Catch social URLs embedded in inline scripts/JSON, not just <a> tags
  const raw = (pageData.html || '').match(SOCIAL_URL_RE) || [];
  raw.forEach(href => {
    ['facebook', 'linkedin'].forEach(net => {
      if (isValidSocialUrl(href, net)) links[net].add(cleanSocialUrl(href));
    });
  });

  return { facebook: [...links.facebook].sort(), linkedin: [...links.linkedin].sort() };
}

// ── Blocked-page detection ───────────────────────────────────────────────
function isBlocked(pageData) {
  if (!pageData || !pageData.html) return true;
  const combined = (pageData.html.slice(0, 3000) + ' ' + (pageData.title || '')).toLowerCase();
  return BLOCK_PHRASES.some(p => combined.includes(p));
}

// ── URL helpers ───────────────────────────────────────────────────────────
function isUsableUrl(u) {
  if (!u) return false;
  const trimmed = String(u).trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  let host;
  try { host = new URL(trimmed).hostname.toLowerCase(); } catch (_) { return false; }
  if (!host) return false;
  return !SKIP_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}

function uniqUsableUrls(list) {
  const seen = new Set();
  const out = [];
  (list || []).forEach(raw => {
    if (!isUsableUrl(raw)) return;
    const u = String(raw).trim();
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  });
  return out;
}

function splitExisting(value) {
  return (value || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

function getContactUrls(pageData, baseUrl) {
  let baseHost;
  try { baseHost = new URL(baseUrl).hostname; } catch (_) { return []; }

  const seen = new Set([baseUrl]);
  const urls = [];

  (pageData.contactAnchors || []).forEach(href => {
    try {
      const u = new URL(href);
      if (u.hostname === baseHost && !seen.has(href) && !/\.(pdf|jpg|jpeg|png)$/i.test(u.pathname)) {
        seen.add(href);
        urls.push(href);
      }
    } catch (_) { /* ignore malformed href */ }
  });

  COMMON_CONTACT_PATHS.forEach(p => {
    try {
      const full = new URL(p, baseUrl).href;
      if (!seen.has(full)) { seen.add(full); urls.push(full); }
    } catch (_) { /* ignore */ }
  });

  return urls.slice(0, 10);
}

// ── Puppeteer page helpers ───────────────────────────────────────────────
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );
  await page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
  return page;
}

async function extractPageData(page) {
  return page.evaluate((keywords) => {
    const mailtoHrefs = Array.from(document.querySelectorAll('a[href^="mailto:" i]'))
      .map(a => a.getAttribute('href') || '');

    const dataAttrEmails = [];
    ['data-email', 'data-mail', 'data-contact', 'data-address'].forEach(attr => {
      document.querySelectorAll(`[${attr}]`).forEach(el => dataAttrEmails.push(el.getAttribute(attr) || ''));
    });

    const cfEmails = Array.from(document.querySelectorAll('[data-cfemail]'))
      .map(el => el.getAttribute('data-cfemail') || '');

    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(el => el.textContent || '');

    const sectionSelectors = [
      'header', 'footer', 'nav', '.header', '.footer', '.navbar', '.nav',
      '#header', '#footer', '#nav', '.top-bar', '.site-header', '.site-footer',
      '.contact-info', '.contact-details', '.contact-section',
      '[class*="contact"]', '[id*="contact"]', '[class*="email"]', '[id*="email"]',
    ];
    let sectionText = '';
    sectionSelectors.forEach(sel => {
      try { document.querySelectorAll(sel).forEach(el => { sectionText += ' ' + (el.innerText || ''); }); }
      catch (_) { /* invalid selector on this page, ignore */ }
    });

    const anchors = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);

    // Name-agnostic contact-page discovery: match on visible link TEXT (and
    // href) against the keyword list, so a link labelled "Get in Touch" or
    // "Branches" is found regardless of what its URL slug looks like.
    const contactAnchors = Array.from(document.querySelectorAll('a[href]'))
      .filter(a => {
        const t = (a.textContent || '').toLowerCase();
        const h = (a.getAttribute('href') || '').toLowerCase();
        return keywords.some(k => t.includes(k) || h.includes(k));
      })
      .map(a => a.href);

    return {
      title: document.title || '',
      bodyText: document.body ? (document.body.innerText || '') : '',
      html: document.documentElement ? document.documentElement.outerHTML : '',
      mailtoHrefs, dataAttrEmails, cfEmails, jsonLd, sectionText, anchors, contactAnchors,
    };
  }, CONTACT_KEYWORDS);
}

async function loadPage(page, url) {
  try {
    // domcontentloaded, not networkidle2 — a chat widget/analytics beacon
    // can keep a real site's network "busy" indefinitely, which would hang
    // this until timeout on plenty of real small-business sites otherwise.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await sleep(1000);
    try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)); } catch (_) {}
    await sleep(400);
    const pageData = await extractPageData(page);
    if (isBlocked(pageData)) return null;
    return pageData;
  } catch (_) {
    // Navigation timed out or errored — grab whatever DOM is there and use
    // it if it looks like real content rather than a blank/error page
    try {
      const pageData = await extractPageData(page);
      if (pageData && (pageData.bodyText || '').length > 100 && !isBlocked(pageData)) return pageData;
    } catch (_) { /* frame gone, nothing to salvage */ }
    return null;
  }
}

// ── Per-row scrape ────────────────────────────────────────────────────────
// Only chases whichever of email/Facebook/LinkedIn the row is actually
// missing — a row that already has an email but no LinkedIn shouldn't pay
// for the (expensive, up to 10 extra page loads) email contact-page crawl.
async function scrapeContactInfo(page, item) {
  const candidates = uniqUsableUrls([item.actualWebsite, item.mapsWebsite, item.contactFormUrl]);
  if (!candidates.length) return { blocked: false, unreachable: false, emails: [], facebook: [], linkedin: [] };

  const needEmail = !(item.emails || '').trim();
  const needFacebook = !(item.facebook || '').trim();
  const needLinkedin = !(item.linkedin || '').trim();

  // Two confidence tiers, gathered across every page visited for this row:
  //   0. mailto: links — anywhere on the site, any domain. Highest trust.
  //   1. loose        — structured (data-attr/Cloudflare/JSON-LD) or plain
  //                      text-scan, but the email's domain must be the
  //                      site's own domain OR a well-known free-mail
  //                      provider (Gmail etc — a legitimate sole contact
  //                      address for a small business, unlike an
  //                      enterprise). Any other off-domain address found
  //                      only via loose scanning is not trusted — no way to
  //                      tell it apart from an unrelated mention on the page.
  const mailtoEmails = new Set();
  const looseEmails = new Set();
  const facebook = new Set();
  const linkedin = new Set();
  let visitedAny = false;
  let lastGoodUrl = null;
  let lastGoodData = null;

  const hasStrongEmail = () => mailtoEmails.size > 0 || looseEmails.size > 0;
  const satisfied = () =>
    (!needEmail || hasStrongEmail()) &&
    (!needFacebook || facebook.size > 0) &&
    (!needLinkedin || linkedin.size > 0);

  const ingest = (data, baseUrl) => {
    if (needEmail) {
      extractMailtoEmails(data).forEach(e => mailtoEmails.add(e));
      const structured = extractStructuredEmails(data);
      const textScan = extractTextScanEmails(data);
      filterEmailsLoose([...structured, ...textScan], baseUrl).forEach(e => looseEmails.add(e));
    }
    if (needFacebook || needLinkedin) {
      const social = extractSocialLinks(data);
      if (needFacebook) social.facebook.forEach(s => facebook.add(s));
      if (needLinkedin) social.linkedin.forEach(s => linkedin.add(s));
    }
  };

  for (const url of candidates) {
    const data = await loadPage(page, url);
    if (!data) continue;
    visitedAny = true;
    lastGoodUrl = url;
    lastGoodData = data;

    ingest(data, url);
    if (satisfied()) break;
  }

  if (!visitedAny) return { blocked: false, unreachable: true, emails: [], facebook: [], linkedin: [] };

  if (!satisfied() && lastGoodUrl) {
    const contactUrls = getContactUrls(lastGoodData, lastGoodUrl);
    for (const curl of contactUrls) {
      if (curl === lastGoodUrl) continue;
      const cdata = await loadPage(page, curl);
      if (!cdata) continue;
      ingest(cdata, lastGoodUrl);
      if (satisfied()) break;
    }
  }

  const emails = mailtoEmails.size ? dedupeEmails([...mailtoEmails]) : dedupeEmails([...looseEmails]);

  return {
    blocked: false,
    unreachable: false,
    emails,
    facebook: dedupeSocial(facebook),
    linkedin: dedupeSocial(linkedin),
  };
}

function dedupeSocial(set) {
  return [...new Set([...set].map(s => s.trim()))].sort();
}

// ── Web app (code.gs) helpers ────────────────────────────────────────────
async function fetchJson(url) {
  const res = await fetch(url);
  let data;
  try { data = await res.json(); }
  catch (_) {
    const text = await res.text().catch(() => '');
    throw new Error(`non-JSON response (status ${res.status}): ${text.slice(0, 300)}`);
  }
  return { res, data };
}

async function checkWebapp() {
  const { res, data } = await fetchJson(`${GOOGLE_SHEETS_URL}?action=health`);
  if (!res.ok || !data.success) {
    throw new Error(`Health check failed: status=${res.status}, response=${JSON.stringify(data)}`);
  }
  if (!data.facebookCol || !data.linkedinCol) {
    throw new Error(
      'Web app response is missing facebookCol/linkedinCol — the deployed Apps Script is out of date.\n' +
      '   → Paste the latest code.gs into script.google.com, Deploy → Manage deployments → New version, then rerun.'
    );
  }
  return data;
}

async function getBlankEmailRows() {
  const { data } = await fetchJson(`${GOOGLE_SHEETS_URL}?action=getBlankEmailRows`);
  if (!data.success) throw new Error(`getBlankEmailRows failed: ${JSON.stringify(data)}`);
  return data.rows || [];
}

async function updateMapContact(row, emails, facebook, linkedin) {
  const params = new URLSearchParams({
    action: 'updateMapContact',
    row: String(row),
    emails: emails.join('; '),
    facebook: facebook.join('; '),
    linkedin: linkedin.join('; '),
  });
  try {
    const { res, data } = await fetchJson(`${GOOGLE_SHEETS_URL}?${params.toString()}`);
    if (!res.ok || !data.success) {
      console.log(`  ⚠️ Update failed: status=${res.status}, response=${JSON.stringify(data)}`);
      return false;
    }
    const written = data.written || {};
    const expected = { emails: emails.join('; '), facebook: facebook.join('; '), linkedin: linkedin.join('; ') };
    for (const [k, v] of Object.entries(expected)) {
      if (v && written[k] !== v) {
        console.log(`  ⚠️ Mismatch for ${k}: sent=${JSON.stringify(v)}, sheet=${JSON.stringify(written[k])}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.log(`  ⚠️ Update failed: ${err.message}`);
    return false;
  }
}

// ── l1.txt feed (for l1.py) ──────────────────────────────────────────────
// Every LinkedIn *company* URL this script finds also gets appended to
// l1.txt (one per line, deduped) so l1.py can scrape it directly — personal
// /in/ profile links are filtered out since only company pages have
// About-section data.
const L1_TXT_FILE = path.join(__dirname, 'l1.txt');

function appendToL1Txt(urls) {
  const companyUrls = (urls || [])
    .map(u => cleanSocialUrl(u))
    .filter(u => u.toLowerCase().includes('linkedin.com/company/'));
  if (!companyUrls.length) return;

  let existing = new Set();
  try {
    if (fs.existsSync(L1_TXT_FILE)) {
      existing = new Set(fs.readFileSync(L1_TXT_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
    }
  } catch (_) { /* start fresh if unreadable */ }

  const fresh = companyUrls.filter(u => !existing.has(u));
  if (!fresh.length) return;

  fs.appendFileSync(L1_TXT_FILE, fresh.join('\n') + '\n', 'utf8');
}

// ── Progress (resume support) ────────────────────────────────────────────
function loadDoneRows() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      return new Set(data.doneRows || []);
    }
  } catch (_) { /* corrupt/missing progress file — start fresh */ }
  return new Set();
}

function saveDoneRows(doneRows) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ doneRows: [...doneRows] }, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Blank-email retry + Facebook/LinkedIn finder\n');

  const health = await checkWebapp();
  console.log(`✅ Web app OK (sheet: ${health.sheet})`);

  console.log('📥 Fetching blank rows...');
  const rows = await getBlankEmailRows();
  console.log(`📊 Blank rows in sheet: ${rows.length}`);

  const doneRows = loadDoneRows();
  const pending = rows.filter(r => !doneRows.has(r.row));
  console.log(`📊 Already processed: ${doneRows.size} | Pending: ${pending.length}\n`);

  if (!pending.length) {
    console.log('✅ Nothing to do.');
    return;
  }

  let browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-blink-features=AutomationControlled',
    ],
  });
  let page = await newPage(browser);
  let sinceRestart = 0;

  try {
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      console.log(`[${i + 1}/${pending.length}] Row ${item.row}: ${item.name || ''}`);

      if (sinceRestart >= BROWSER_RESTART_EVERY) {
        try { await browser.close(); } catch (_) {}
        browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });
        page = await newPage(browser);
        sinceRestart = 0;
        console.log('  🔄 Browser restarted');
      }

      let result;
      try {
        result = await scrapeContactInfo(page, item);
      } catch (err) {
        console.log(`  ❌ Error: ${err.message} — will retry next run`);
        try { await page.close(); } catch (_) {}
        try { page = await newPage(browser); } catch (_) {}
        sinceRestart++;
        await sleep(rand(1000, 2000));
        continue;
      }
      sinceRestart++;

      if (result.unreachable) {
        console.log('  ⛔ No candidate URL reachable — marking done');
        doneRows.add(item.row);
        saveDoneRows(doneRows);
        await sleep(rand(400, 900));
        continue;
      }

      // Merge with whatever the sheet already has, so a run that finds
      // nothing new never blanks out an email/Facebook/LinkedIn value found
      // earlier — important now that a row can already have an email but
      // still get re-visited just because Facebook/LinkedIn is blank.
      const finalEmails = result.emails.length ? result.emails : splitExisting(item.emails);
      const finalFacebook = result.facebook.length ? result.facebook : splitExisting(item.facebook);
      const finalLinkedin = (result.linkedin.length ? result.linkedin : splitExisting(item.linkedin))
        .map(u => cleanSocialUrl(u))
        .filter(Boolean);

      appendToL1Txt(finalLinkedin);

      if (finalEmails.length || finalFacebook.length || finalLinkedin.length) {
        console.log(`  ✓ emails=${JSON.stringify(finalEmails)} facebook=${JSON.stringify(finalFacebook)} linkedin=${JSON.stringify(finalLinkedin)}`);
        const ok = await updateMapContact(item.row, finalEmails, finalFacebook, finalLinkedin);
        if (ok) {
          console.log('  ↳ sheet updated');
          doneRows.add(item.row);
          saveDoneRows(doneRows);
        } else {
          console.log('  ↳ update failed, will retry next run');
        }
      } else {
        console.log('  ✗ nothing found');
        doneRows.add(item.row);
        saveDoneRows(doneRows);
      }

      await sleep(rand(500, 1200));
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  console.log('\n🏁 Done!');
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  scrapeContactInfo, extractMailtoEmails, extractStructuredEmails, extractTextScanEmails,
  extractSocialLinks, isValidEmail, isValidSocialUrl, isAcceptableLooseEmail,
  filterEmailsLoose, dedupeEmails,
};
