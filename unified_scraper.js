// ════════════════════════════════════════════════════════════════════════════
// unified_scraper.js — Google Maps business scraper (data-collection stage)
//
// PURPOSE / ROLE IN THE PIPELINE:
//   This is the first stage of the pipeline (see README.md). It drives a
//   headless Chrome instance (via Puppeteer) to search Google Maps for
//   "digital marketing agencies" style businesses across a large list of
//   cities/keywords (config.json), opens each business's Maps listing and
//   website, extracts contact-relevant data (name, address, phone, website,
//   contact-form URL, emails + Facebook + LinkedIn found on the site), and
//   persists it so that later stages can pick it up: fill.js / main.js
//   (contact-form filling) and l1.py (LinkedIn company-page enrichment, via
//   l1.txt).
//
// HOW IT WORKS (high level):
//   1. loadConfig()   — reads config.json (areas/cities + keywords). If a
//      WORKER_ID env var is set (used when running several scraper
//      instances in parallel via run1.js..run7.js), the city list is split
//      into 7 equal chunks and this process only works on its slice — this
//      is the "worker-parallelism" partitioning.
//   2. loadProgress() — reads this worker's progress JSON file (resume
//      support: which "city+keyword" searches are already completed and
//      which overall search index to resume from) plus a *shared*
//      processed_maps_urls.txt file (and, as a fallback, the existing CSV)
//      to build an in-memory de-dupe set of Google Maps listing URLs that
//      any worker has already scraped — this is how duplicate businesses
//      are avoided across parallel workers.
//   3. scrapeUnified() — the main loop: for every {city, keyword} pair not
//      yet marked completed, it:
//        a. Opens Google Maps, types "<keyword> <city>" into the search box.
//        b. Repeatedly scrolls the results panel (several scroll strategies
//           combined) until no new listings appear for a few attempts in a
//           row, or a max scroll-attempt cap is hit — this is how it forces
//           Google Maps' virtualized/infinite-scroll result list to fully
//           load ("pagination" on Maps is scroll-driven, not page-numbered).
//        c. Parses each `div[role="article"]` listing card out of the DOM
//           for name/rating/reviews/address/phone/website/Maps URL.
//        d. For each listing, navigates directly to its Maps URL to pull
//           more complete detail-panel data (address/phone/website), skips
//           it if another worker already claimed that Maps URL
//           (isAlreadyProcessed), otherwise immediately claims it
//           (markAsProcessed) before doing further work — this "claim
//           early" ordering is what keeps parallel workers from racing on
//           the same business.
//        e. If the business has a usable website, visits it
//           (scrapeWebsiteDetails) to find a contact page and, from the same
//           page loads, scrape emails (mailto: links, Cloudflare
//           email-obfuscation decoding, plain-text regex, raw HTML regex)
//           plus any Facebook/LinkedIn page linked from the site
//           (extractSocialLinks — validated/normalized, junk links like
//           share/login/feed URLs rejected).
//        f. Appends one row to digital_marketing_data.csv and POSTs the same
//           row to a Google Sheets Apps Script Web App URL for a live view;
//           any LinkedIn *company* URL found also gets appended to l1.txt
//           (appendToL1Txt) for l1.py to scrape separately.
//        g. Saves progress to disk after every business (fine-grained
//           resume) and after every completed search (coarse-grained
//           resume).
//   4. runWithRestart() — top-level supervisor: if scrapeUnified() throws
//      (e.g. browser crash, unexpected page state), it waits 5 minutes and
//      restarts the whole scrape loop, which will pick up again from saved
//      progress instead of starting over.
//
// DEPENDENCIES / USED BY:
//   - Reads: config.json (cities + keywords), unified_progress.json /
//     unified_progress_<WORKER_ID>.json (own resume state),
//     processed_maps_urls.txt (shared de-dupe set written by all workers),
//     digital_marketing_data.csv (used as a fallback source of already-seen
//     Maps URLs on startup), l1.txt (appended to, not read — see l1.py).
//   - Writes: digital_marketing_data.csv (scraped rows, now including
//     Facebook/LinkedIn columns), the progress JSON file above,
//     processed_maps_urls.txt (appends newly claimed URLs), l1.txt (appends
//     newly found LinkedIn company URLs), and pushes each row to the Google
//     Sheets Web App at GOOGLE_SHEETS_URL (backed by code.gs) for a live
//     "MapData" sheet view.
//   - Launched by run.js (single worker) or run1.js..run7.js (parallel
//     workers, each setting a different WORKER_ID env var).
//   - Downstream: fill.js / main.js read digital_marketing_data.csv (via
//     retry_urls.txt) to actually fill contact forms on the websites this
//     scraper discovered; l1.py reads l1.txt to enrich each LinkedIn company
//     page found.
//   - autopush.js (running in the background, spawned by run.js) watches
//     this script's output files and auto-commits/pushes them to GitHub.
// ════════════════════════════════════════════════════════════════════════════

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Google Apps Script Web App endpoint (deployed from code.gs) that appends
// each scraped row to a live Google Sheet ("MapData" tab) in real time.
const GOOGLE_SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwz28DvEzyPhZh9XsxhGMO1A5YpbFneKeeDmNduW2cp1GVnZuRzZw_xRYOj7TVZ9ZKf/exec';
const CONFIG_FILE = 'config.json';

// ── Worker-parallelism setup ──────────────────────────────────────────────
// When this script is launched by run1.js..run7.js, each process sets its
// own WORKER_ID (e.g. "1".."7") in the environment. That both (a) gives
// each worker a private progress file so they don't clobber each other's
// resume state, and (b) is used below in loadConfig() to hand each worker a
// distinct slice of the city list.
const WORKER_ID = process.env.WORKER_ID || '';
const PROGRESS_FILE = WORKER_ID ? `unified_progress_${WORKER_ID}.json` : 'unified_progress.json';
const CSV_FILE = 'digital_marketing_data.csv';
// Shared across ALL workers (not suffixed by WORKER_ID) — this is the
// cross-worker de-dupe ledger of Google Maps listing URLs already scraped,
// so worker 1 and worker 3 don't both scrape the same business if their
// city slices happen to overlap in results.
const SHARED_URLS_FILE = 'processed_maps_urls.txt';

let config = {};
let progress = { completed: [], currentIndex: 0 };
let processedUrlsCache = new Set(); // in-memory for fast lookup

// Google search result links are often wrapped in a "/url?q=...&sa=..."
// redirect wrapper with HTML-entity-encoded ampersands/quotes. This unwraps
// that redirect back to the real destination URL.
function cleanGoogleUrl(url) {
    if (!url) return '';
    url = url.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    if (url.includes('google.com/url')) {
        try {
            const params = new URLSearchParams(url.split('?')[1]);
            return params.get('q') || params.get('url') || url;
        } catch (_) { return url; }
    }
    return url;
}

function normalizeMapUrl(url) {
    if (!url) return '';
    // Keep only the path part before query params for comparison
    return url.split('?')[0].trim();
}

// Duplicate-avoidance check: has ANY worker already scraped this exact Maps
// listing (compared with query-string-stripped URLs)?
function isAlreadyProcessed(mapsUrl) {
    if (!mapsUrl) return false;
    return processedUrlsCache.has(normalizeMapUrl(mapsUrl));
}

// Claims a Maps URL as "being processed" — adds it to the in-memory set AND
// appends it to the shared file on disk immediately, so other worker
// processes (which poll/re-read this file on their own startup, and could
// also be running concurrently) see it as taken as soon as possible. This
// is called BEFORE the expensive website-scraping work for a listing so two
// workers racing on the same business converge on only one of them doing
// the work.
function markAsProcessed(mapsUrl) {
    if (!mapsUrl) return;
    const url = normalizeMapUrl(mapsUrl);
    if (processedUrlsCache.has(url)) return;
    processedUrlsCache.add(url);
    fs.appendFileSync(SHARED_URLS_FILE, url + '\n');
}

// Loads config.json (cities + keywords). If running as a parallel worker,
// slices the city list into 7 equal-ish chunks (ceil-divided) and keeps
// only this worker's chunk based on WORKER_ID (expected to be "1".."7").
function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        // If WORKER_ID set, slice cities into 7 equal parts and pick this worker's chunk
        if (WORKER_ID) {
            const id = parseInt(WORKER_ID, 10); // 1-7
            const total = raw.areas.length;
            const chunkSize = Math.ceil(total / 7);
            const start = (id - 1) * chunkSize;
            const end = Math.min(start + chunkSize, total);
            config = { ...raw, areas: raw.areas.slice(start, end) };
            console.log(`👷 Worker ${WORKER_ID}: cities ${start + 1}–${end} (${config.areas.length} cities)`);
        } else {
            config = raw;
        }
        console.log(`📋 Loaded ${config.areas.length} cities and ${config.keywords.length} keywords`);
    } catch (error) {
        console.error('❌ Error loading config:', error.message);
        process.exit(1);
    }
}

// Restores resume state from disk on startup:
//   - This worker's own progress file (which {city,keyword} searches are
//     already completed, and the last search index reached).
//   - The shared processed_maps_urls.txt ledger (cross-worker de-dupe set).
//   - As a fallback/backfill for URLs scraped before processed_maps_urls.txt
//     existed, also scans the existing CSV's "Maps URL" column and adds
//     those into the same in-memory de-dupe set.
function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
            console.log(`📊 Resuming from search ${progress.currentIndex + 1}`);
        }

        // Load from processed_maps_urls.txt
        if (fs.existsSync(SHARED_URLS_FILE)) {
            fs.readFileSync(SHARED_URLS_FILE, 'utf8').split('\n').filter(Boolean)
                .forEach(u => processedUrlsCache.add(normalizeMapUrl(u)));
        }

        // Also load Maps URLs from CSV (covers old data before processed_maps_urls.txt existed)
        if (fs.existsSync(CSV_FILE)) {
            const lines = fs.readFileSync(CSV_FILE, 'utf8').split('\n').filter(Boolean);
            if (lines.length > 1) {
                const headers = lines[0].split(',');
                const mapsUrlIdx = headers.findIndex(h => h.toLowerCase().includes('maps url'));
                if (mapsUrlIdx >= 0) {
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        const url = (cols[mapsUrlIdx] || '').replace(/^"|"$/g, '').trim();
                        if (url && url.startsWith('http')) processedUrlsCache.add(normalizeMapUrl(url));
                    }
                }
            }
        }

        console.log(`🔄 Total processed URLs loaded: ${processedUrlsCache.size}`);
    } catch (error) {
        console.log('Starting fresh scraping');
    }
}

// Persists this worker's resume state (completed searches + current index)
// to its own progress file. Called frequently (after every business and
// after every completed search) so a crash loses at most a few seconds of
// work.
function saveProgress() {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// Creates the output CSV with a header row if it doesn't exist yet. Safe to
// call every run — workers append to the same shared CSV over time.
function initCSV() {
    if (!fs.existsSync(CSV_FILE)) {
        const headers = 'Index,Area,Keyword,Name,Rating,Reviews,Address,Phone,Maps Website,Actual Website,Contact Form URL,Maps URL,All Emails,Email Count,Facebook,LinkedIn,Timestamp\n';
        fs.writeFileSync(CSV_FILE, headers);
        console.log('📄 CSV file created');
    }
}

// ── Social link helpers (Facebook/LinkedIn) ───────────────────────────────────
// Catches social URLs embedded in inline scripts/JSON, not just <a> tags.
const SOCIAL_URL_RE = /https?:\/\/[^\s'"<>]+(?:facebook|linkedin)\.com\/[^\s'"<>]+/gi;

// Normalizes a raw Facebook/LinkedIn URL: unwraps Facebook's /l.php and
// LinkedIn's /redir/redirect tracking-link wrappers, strips m./www. prefixes,
// and truncates a LinkedIn URL like /company/xyz/posts down to the bare
// /company/xyz canonical page.
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

    // LinkedIn's canonical form is www.linkedin.com — keep it explicit rather
    // than relying on the bare domain to redirect there itself.
    const finalHost = host === 'linkedin.com' ? 'www.linkedin.com' : host;

    return `https://${finalHost}${finalPath}`;
}

// Rejects share/login/plugin/feed-style junk links so only real company or
// profile pages count as a match.
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

// anchors: array of <a href> URLs from the page. html: raw page HTML (also
// regex-scanned, since some sites only embed social links inside inline
// scripts/JSON rather than real <a> tags).
function extractSocialLinks(anchors, html) {
    const links = { facebook: new Set(), linkedin: new Set() };

    (anchors || []).forEach(href => {
        ['facebook', 'linkedin'].forEach(net => {
            if (isValidSocialUrl(href, net)) links[net].add(cleanSocialUrl(href));
        });
    });

    const raw = (html || '').match(SOCIAL_URL_RE) || [];
    raw.forEach(href => {
        ['facebook', 'linkedin'].forEach(net => {
            if (isValidSocialUrl(href, net)) links[net].add(cleanSocialUrl(href));
        });
    });

    return { facebook: [...links.facebook].sort(), linkedin: [...links.linkedin].sort() };
}

// ── l1.txt feed (for l1.py) ────────────────────────────────────────────────
// Every LinkedIn *company* URL this script finds also gets appended to
// l1.txt (one per line, deduped) so l1.py can scrape its About section
// directly — personal /in/ profile links are skipped since l1.py's
// About-section extraction only targets company pages.
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

// Visits a business's actual website (not the Maps listing) to find a
// contact page and scrape emails from it, plus any Facebook/LinkedIn page
// linked from the site. Returns
// { emails, actualWebsite, contactFormUrl, facebook, linkedin }.
async function scrapeWebsiteDetails(page, website) {
    try {
        // Skip known ad-network / third-party directory / social-media
        // domains that sometimes leak through as a business's "website" —
        // scraping them would be pointless or waste time.
        const badPatterns = [
            'google.com/aclk','googleadservices.com','appdevelopmentcompanies.co',
            'clutch.co','yelp.com','facebook.com','linkedin.com'
        ];
        if (badPatterns.some(p => website.includes(p))) {
            console.log(`⏭️ Skipping ad/irrelevant site: ${website}`);
            return { emails: [], actualWebsite: '', contactFormUrl: '', facebook: [], linkedin: [] };
        }

        console.log(`🌐 Visiting: ${website}`);
        // Ensure request interception (potentially left on elsewhere) is
        // disabled and no stray 'request' listeners remain, so this
        // navigation isn't blocked/altered by leftover handlers.
        await page.setRequestInterception(false);
        page.removeAllListeners('request');
        await page.goto(website, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));

        // Prefer the canonical/og:url meta tag over page.url() when present,
        // since it more reliably reflects the "real" homepage URL after any
        // client-side redirects/rewrites.
        let actualWebsite = page.url();
        try {
            const base = await page.evaluate(() => {
                return document.querySelector('link[rel="canonical"]')?.href ||
                       document.querySelector('meta[property="og:url"]')?.content || '';
            });
            if (base && base.startsWith('http')) actualWebsite = base;
        } catch (_) {}

        // Step 1: Find contact page link from homepage.
        // Scans every same-domain <a href> on the homepage and keeps ones
        // whose URL path or link text contains any contact-ish keyword —
        // not just "contact" (with separators stripped so "Contact-Us" /
        // "contact_us" / "Contact Us" all match). This is what actually
        // catches a link labelled/hrefed "Get in Touch" (e.g.
        // /get-in-touch/) that has no literal "contact" substring at all.
        const contactLinks = await page.evaluate((keywords) => {
            const base = window.location.origin;
            const seen = new Set();
            const links = [];
            for (const a of document.querySelectorAll('a[href]')) {
                const raw = a.getAttribute('href') || '';
                let href = raw.startsWith('http') ? raw : (raw.startsWith('/') ? base + raw : '');
                if (!href) continue;
                try { if (new URL(href).hostname !== new URL(base).hostname) continue; } catch(_) { continue; }
                const path = new URL(href).pathname.toLowerCase().replace(/[-_\/]/g, '');
                const text = (a.textContent || '').trim().toLowerCase().replace(/[-_\s]/g, '');
                if (keywords.some(k => path.includes(k) || text.includes(k))) {
                    if (!seen.has(href)) { seen.add(href); links.push(href); }
                }
            }
            return links.slice(0, 3);
        }, CONTACT_KEYWORDS);
        const contactPageUrl = contactLinks[0] || '';

        // Step 2: Extract emails from a page, using several complementary
        // techniques so that whichever method the site uses to publish its
        // email address gets caught:
        //   1. mailto: links (the most reliable signal).
        //   2. Cloudflare's "email protection" obfuscation — emails are
        //      hex-XOR-encoded in a data-cfemail attribute; this decodes
        //      them the same way Cloudflare's own JS would.
        //   3. Plain visible text on the page (innerText) matched via regex.
        //   4. Raw HTML source matched via regex — catches emails embedded
        //      in inline scripts / JSON data blobs that aren't in the
        //      rendered text or DOM attributes.
        // In every case the match is filtered to end with "@<domain>" so
        // unrelated emails picked up from ads/widgets/third-party embeds on
        // the page are excluded. Also returns every <a href> plus the raw
        // HTML on the page, so the caller can pull Facebook/LinkedIn links
        // out of the same page load instead of paying for a second evaluate.
        const extractPageData = async (domain) => {
            return page.evaluate((domain) => {
                const emails = new Set();
                const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

                // 1. mailto: links
                document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
                    const email = a.getAttribute('href').replace('mailto:', '').split('?')[0].trim().toLowerCase();
                    if (email.includes('@' + domain)) emails.add(email);
                });

                // 2. Cloudflare email protection
                document.querySelectorAll('[data-cfemail]').forEach(el => {
                    try {
                        const enc = el.getAttribute('data-cfemail');
                        const r = parseInt(enc.substr(0, 2), 16);
                        let email = '';
                        for (let i = 2; i < enc.length; i += 2)
                            email += String.fromCharCode(parseInt(enc.substr(i, 2), 16) ^ r);
                        if (email.includes('@' + domain)) emails.add(email.toLowerCase());
                    } catch(_) {}
                });

                // 3. Plain text in body
                (document.body.innerText.match(emailRegex) || []).forEach(e => {
                    if (e.toLowerCase().includes('@' + domain)) emails.add(e.toLowerCase());
                });

                // 4. Raw HTML — catches JS-rendered, JSON bootstrap, encoded emails
                const html = document.documentElement.innerHTML;
                (html.match(emailRegex) || []).forEach(e => {
                    if (e.toLowerCase().includes('@' + domain)) emails.add(e.toLowerCase());
                });

                // 5. Every anchor href — Facebook/LinkedIn links get filtered
                // and normalized on the Node side (extractSocialLinks).
                const anchors = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);

                return { emails: [...emails], anchors, html };
            }, domain);
        };

        const siteDomain = new URL(page.url()).hostname.replace('www.', '');

        // Step 3: Check homepage first
        let homepageData = await extractPageData(siteDomain);
        let emails = homepageData.emails;
        console.log(`📧 Homepage mailto: ${emails.length}`);

        const social = { facebook: new Set(), linkedin: new Set() };
        const ingestSocial = (anchors, html) => {
            const found = extractSocialLinks(anchors, html);
            found.facebook.forEach(u => social.facebook.add(u));
            found.linkedin.forEach(u => social.linkedin.add(u));
        };
        ingestSocial(homepageData.anchors, homepageData.html);

        // Step 4: Visit all discovered contact-ish pages (up to 3, from Step
        // 1) and extract emails + social links from each too, since many
        // sites only list an email/Facebook/LinkedIn link on their dedicated
        // /contact or /about page rather than the homepage.
        let contactFormUrl = contactPageUrl;
        for (const link of contactLinks) {
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 10000 });
                await new Promise(r => setTimeout(r, 1500));
                const linkData = await extractPageData(siteDomain);
                console.log(`📧 ${link} → ${linkData.emails.length} emails`);
                linkData.emails.forEach(e => emails.push(e));
                ingestSocial(linkData.anchors, linkData.html);
            } catch (_) {}
        }

        if (social.facebook.size) console.log(`📘 Facebook: ${[...social.facebook].join('; ')}`);
        if (social.linkedin.size) console.log(`💼 LinkedIn: ${[...social.linkedin].join('; ')}`);

        return {
            emails: [...new Set(emails)],
            actualWebsite,
            contactFormUrl: contactFormUrl || '',
            facebook: [...social.facebook].sort(),
            linkedin: [...social.linkedin].sort()
        };
    } catch (error) {
        console.log(`❌ Error scraping ${website}: ${error.message}`);
        return { emails: [], actualWebsite: '', contactFormUrl: '', facebook: [], linkedin: [] };
    }
}

// Fire-and-forget POST of a single scraped row to the Google Apps Script
// Web App (code.gs), which appends it to a live Google Sheet. Failures are
// swallowed (return false) — the CSV write is the durable source of truth,
// Sheets is just a convenience live-view.
async function sendToSheets(data) {
    try {
        const response = await fetch(GOOGLE_SHEETS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'map', rows: [data] })
        });
        if (response.ok) return true;
        return false;
    } catch (error) {
        return false;
    }
}

// Appends one row to the CSV. Fields are only quoted when they actually
// need it (contain a comma, newline, or quote), keeping the file readable
// while still being valid CSV.
function saveToCSV(data) {
    const csvRow = data.map(field => {
        const str = String(field ?? '');
        // Only wrap in quotes if field contains comma, newline, or double quote
        if (str.includes(',') || str.includes('\n') || str.includes('"')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }).join(',') + '\n';
    fs.appendFileSync(CSV_FILE, csvRow);
}

// ── Main scrape loop ────────────────────────────────────────────────────────
// Runs one full pass over every {city, keyword} combination not yet marked
// completed in this worker's progress file. See the file-level header
// comment above for the overall flow; details are commented inline below.
async function scrapeUnified() {
    console.log('🚀 Starting unified Google Maps scraper...');

    loadConfig();
    loadProgress();
    initCSV();

    // Build the full search matrix: every city × every keyword.
    const searches = [];
    config.areas.forEach(city => {
        config.keywords.forEach(keyword => {
            searches.push({ city, keyword });
        });
    });

    console.log(`📊 Total searches: ${searches.length}`);
    console.log(`📊 Remaining: ${searches.length - progress.currentIndex}`);

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    let totalCompanies = 0;
    let totalEmails = 0;
    let globalIndex = 1; // Global counter across all searches

    try {
        // Resume from progress.currentIndex rather than 0.
        for (let i = progress.currentIndex; i < searches.length; i++) {
            const { city, keyword } = searches[i];
            const searchKey = `${city}-${keyword}`;

            // Search-level resume guard: skip any {city,keyword} pair
            // already recorded as completed (covers cases where
            // currentIndex was saved mid-way but this specific key was
            // already finished).
            if (progress.completed.includes(searchKey)) {
                continue;
            }

            console.log(`\n🔍 [${i + 1}/${searches.length}] ${city} - ${keyword}`);

            try {
                // Go to Google Maps and perform search
                await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 1000));

                // Find and click search box
                const searchBox = await page.waitForSelector('input.UGojuc, input[name="q"], input[id="UGojuc"]', { timeout: 10000 });
                await searchBox.click();

                // Clear any existing text and type search query
                await searchBox.evaluate(el => el.value = '');
                const searchQuery = `${keyword} ${city}`;
                await searchBox.type(searchQuery, { delay: 100 });

                // Press Enter or click search button
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 3000));

                // Wait for results to load
                await page.waitForSelector('div[role="main"]', { timeout: 10000 });
                await new Promise(r => setTimeout(r, 1500));

                // ── Scroll to load all results ──────────────────────────────
                // Google Maps' results panel is a virtualized/infinite-scroll
                // list (no numbered pagination), so the only way to load the
                // full result set is to keep scrolling the panel until no new
                // listing cards (div[role="article"]) appear. The loop below
                // scrolls repeatedly, counting listing cards each time, and
                // stops once either a max scroll-attempt cap is reached
                // (maxScrolls) or the count has stayed unchanged for several
                // consecutive attempts in a row (maxNoChange) — i.e. Maps
                // isn't giving us anything new anymore.
                console.log('📜 Scrolling to load all results...');
                let previousCount = 0;
                let currentCount = 0;
                let scrollAttempts = 0;
                let noChangeCount = 0;
                const maxScrolls = 20;
                const maxNoChange = 4;

                // First, get initial count
                currentCount = await page.evaluate(() => {
                    return document.querySelectorAll('div[role="article"]').length;
                });
                console.log(`📊 Initial results: ${currentCount}`);

                do {
                    previousCount = currentCount;

                    // Try multiple scroll strategies — Google Maps' DOM/class
                    // names change over time and vary by A/B test, so several
                    // approaches are combined for resilience: scroll known
                    // result-container elements directly, scrollIntoView the
                    // last loaded card (triggers lazy-loading of more), and
                    // scroll the window itself as a fallback.
                    await page.evaluate(() => {
                        // Strategy 1: Scroll the main results container
                        const containers = [
                            document.querySelector('div[role="main"]'),
                            document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd'),
                            document.querySelector('[aria-label*="Results"]'),
                            document.querySelector('.e07Vkf.kA9KIf')
                        ];

                        containers.forEach(container => {
                            if (container) {
                                container.scrollTop = container.scrollHeight;
                            }
                        });

                        // Strategy 2: Scroll to the last visible result
                        const articles = document.querySelectorAll('div[role="article"]');
                        if (articles.length > 0) {
                            const lastArticle = articles[articles.length - 1];
                            lastArticle.scrollIntoView({ behavior: 'smooth', block: 'end' });
                        }

                        // Strategy 3: Page scroll as backup
                        window.scrollTo(0, document.body.scrollHeight);
                    });

                    // Wait for loading
                    await new Promise(r => setTimeout(r, 2500));

                    // Trigger more loading by pressing Page Down
                    await page.keyboard.press('PageDown');
                    await new Promise(r => setTimeout(r, 1000));

                    // Count current results
                    currentCount = await page.evaluate(() => {
                        return document.querySelectorAll('div[role="article"]').length;
                    });

                    console.log(`📊 Results: ${currentCount} (was ${previousCount})`);

                    if (currentCount === previousCount) {
                        noChangeCount++;
                        console.log(`⏳ No new results (${noChangeCount}/${maxNoChange})`);
                    } else {
                        noChangeCount = 0;
                        console.log(`✅ Found ${currentCount - previousCount} new results`);
                    }

                    scrollAttempts++;

                } while (scrollAttempts < maxScrolls && noChangeCount < maxNoChange);

                console.log(`✅ Scrolling complete. Final count: ${currentCount}`);
                await new Promise(r => setTimeout(r, 1000));

                // ── Parse listing cards out of the results panel ────────────
                // Runs entirely in-page (page.evaluate) for speed: each
                // div[role="article"] is one business card in the results
                // list. Several CSS class selectors are tried for each field
                // because Google Maps' generated class names aren't stable
                // API contracts — the code favors "does this look like an
                // address/phone/domain" pattern checks over trusting any
                // single selector.
                const companies = await page.evaluate(() => {
                    const results = [];

                    // Look for business listings with role="article"
                    const listings = document.querySelectorAll('div[role="article"]');

                    listings.forEach((listing, index) => {
                        try {
                            // Get business name from qBF1Pd class
                            const nameEl = listing.querySelector('.qBF1Pd.fontHeadlineSmall');

                            if (nameEl && nameEl.textContent && nameEl.textContent.trim()) {
                                const name = nameEl.textContent.trim();

                                // Skip first 2 results (usually ads/irrelevant)
                                if (index < 2) {
                                    return;
                                }

                                // Get rating from MW4etd class
                                const ratingEl = listing.querySelector('.MW4etd');
                                const rating = ratingEl?.textContent?.trim() || '';

                                // Get reviews from UY7F9 class
                                const reviewsEl = listing.querySelector('.UY7F9');
                                const reviews = reviewsEl?.textContent?.replace(/[()]/g, '').trim() || '';

                                // Get address from multiple possible selectors
                                let address = '';
                                const addressSelectors = [
                                    '.Io6YTe.fontBodyMedium.kR99db.fdkmkc',
                                    '.Io6YTe',
                                    '.W4Efsd'
                                ];

                                for (const selector of addressSelectors) {
                                    const addressEl = listing.querySelector(selector);
                                    if (addressEl && addressEl.textContent) {
                                        const text = addressEl.textContent.trim();
                                        // Check if it looks like an address
                                        if (text.match(/\d+.*(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Street|Avenue|Boulevard|Drive|Road)/i) ||
                                            text.includes(',') && text.length > 10) {
                                            address = text;
                                            break;
                                        }
                                    }
                                }

                                // Fallback: look in W4Efsd spans for address-like content
                                if (!address) {
                                    const addressSpans = listing.querySelectorAll('.W4Efsd span');
                                    addressSpans.forEach(span => {
                                        const text = span.textContent?.trim();
                                        if (text && !text.includes('·') && !text.includes('Closed') && !text.includes('Open') && !text.includes('+1')) {
                                            if (text.match(/\d+.*(?:St|Ave|Blvd|Dr|Rd|Way|Ln)/i)) {
                                                address = text;
                                            }
                                        }
                                    });
                                }

                                // Get phone from UsdlK class
                                const phoneEl = listing.querySelector('.UsdlK');
                                const phone = phoneEl?.textContent?.trim() || '';

                                // Get website from lcr4fd link with data-value="Website"
                                const websiteEl = listing.querySelector('a.lcr4fd[data-value="Website"]');
                                let website = '';
                                if (websiteEl && websiteEl.href) {
                                    website = websiteEl.href;
                                    // Decode HTML entities + clean Google redirect
                                    website = website.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
                                    if (website.includes('google.com/url')) {
                                        try {
                                            const params = new URLSearchParams(website.split('?')[1]);
                                            website = params.get('q') || params.get('url') || website;
                                        } catch (_) {}
                                    }
                                    const badPatterns = [
                                        'google.com/aclk','googleadservices.com','appdevelopmentcompanies.co',
                                        'clutch.co','yelp.com','facebook.com','linkedin.com','twitter.com','instagram.com'
                                    ];
                                    if (badPatterns.some(pattern => website.includes(pattern))) website = '';
                                }

                                // Get maps URL from hfpxzc link
                                const mapsEl = listing.querySelector('a.hfpxzc');
                                let mapsUrl = '';
                                if (mapsEl && mapsEl.href && mapsEl.href.includes('maps')) {
                                    mapsUrl = mapsEl.href;
                                }

                                results.push({
                                    name, rating, reviews, address, phone, website, mapsUrl
                                });
                            }
                        } catch (error) {
                            // Skip invalid listings
                        }
                    });

                    return results;
                });

                console.log(`📍 Found ${companies.length} companies`);

                // Debug: Show first company details
                if (companies.length > 0) {
                    console.log('🔍 Sample company:', {
                        name: companies[0].name,
                        website: companies[0].website,
                        mapsUrl: companies[0].mapsUrl
                    });
                }

                // ── Process each company by navigating directly to its Maps URL ──
                // The listing-card data scraped above is often incomplete
                // (address/phone/website truncated or missing), so each
                // business's own Maps detail page is visited to re-extract
                // more complete data from its side panel before moving on to
                // the website/email scrape.
                for (let j = 0; j < companies.length; j++) {
                    const company = companies[j];
                    let fullCompanyData = { ...company };

                    console.log(`📋 [${globalIndex}] Processing: ${company.name}`);

                    if (!company.mapsUrl) {
                        console.log(`⚠️ No Maps URL for: ${company.name}`);
                        globalIndex++;
                        continue;
                    }

                    try {
                        await page.goto(company.mapsUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
                        await new Promise(r => setTimeout(r, 2500));

                        const sidePanelLoaded = await page.evaluate(() => {
                            return document.querySelector('.Io6YTe.fontBodyMedium.kR99db.fdkmkc') !== null ||
                                   document.querySelector('[data-value="Address"]') !== null ||
                                   document.querySelector('.rogA2c') !== null;
                        });

                        if (!sidePanelLoaded) {
                            console.log(`⚠️ Side panel not loaded for ${company.name}, using basic data`);
                        } else {
                            // Extract detailed information from side panel
                            const detailedInfo = await page.evaluate(() => {
                                let address = '';
                                let phone = '';
                                let website = '';

                                // Multiple selectors for address in side panel
                                const addressSelectors = [
                                    '.Io6YTe.fontBodyMedium.kR99db.fdkmkc',
                                    '[data-item-id="address"] .Io6YTe',
                                    'button[data-item-id="address"] .Io6YTe',
                                    '.rogA2c .Io6YTe.fontBodyMedium.kR99db.fdkmkc'
                                ];

                                for (const selector of addressSelectors) {
                                    const el = document.querySelector(selector);
                                    if (el && el.textContent) {
                                        const text = el.textContent.trim();
                                        // Check if it looks like a full address
                                        if (text.length > 10 && (text.includes(',') || text.match(/\d+.*(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Street|Avenue|Boulevard|Drive|Road)/i))) {
                                            address = text;
                                            break;
                                        }
                                    }
                                }

                                // Phone selectors - look in all AeaXub divs
                                const phoneSelectors = [
                                    'button[data-item-id*="phone"] .Io6YTe',
                                    '.rogA2c .Io6YTe.fontBodyMedium.kR99db.fdkmkc',
                                    'div[role="img"][aria-label*="Phone"] + .rogA2c .Io6YTe',
                                    '.AeaXub .Io6YTe'
                                ];

                                // Check all AeaXub containers for phone
                                const aeaXubDivs = document.querySelectorAll('.AeaXub');
                                for (const div of aeaXubDivs) {
                                    const ioText = div.querySelector('.Io6YTe');
                                    if (ioText && ioText.textContent) {
                                        const text = ioText.textContent.trim();
                                        // Check if it looks like a phone number
                                        if (text.match(/^[\+\d][\d\s\-\(\)]{8,}$/)) {
                                            phone = text;
                                            break;
                                        }
                                    }
                                }

                                // Website selectors - look in all AeaXub divs
                                const aeaXubDivsForWebsite = document.querySelectorAll('.AeaXub');
                                for (const div of aeaXubDivsForWebsite) {
                                    const ioText = div.querySelector('.Io6YTe');
                                    if (ioText && ioText.textContent) {
                                        const text = ioText.textContent.trim();
                                        // Check if it looks like a website domain
                                        if (text.match(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/) &&
                                            !text.includes(' ') &&
                                            !text.match(/^[\+\d]/) &&
                                            !text.includes(',')) {
                                            website = 'https://' + text;
                                            break;
                                        }
                                    }
                                }

                                // Fallback: look for website in links
                                if (!website) {
                                    const websiteSelectors = [
                                        'a[data-value="Website"]',
                                        'a[data-item-id="authority"]',
                                        '.rogA2c a[href^="http"]'
                                    ];

                                    for (const selector of websiteSelectors) {
                                        const el = document.querySelector(selector);
                                        if (el && el.href && el.href.startsWith('http')) {
                                            website = el.href;
                                            break;
                                        }
                                    }
                                }

                                return { address, phone, website };
                            });

                            // Update company data with detailed info
                            if (detailedInfo.address) fullCompanyData.address = detailedInfo.address;
                            if (detailedInfo.phone) fullCompanyData.phone = detailedInfo.phone;
                            if (detailedInfo.website) fullCompanyData.website = cleanGoogleUrl(detailedInfo.website);

                            console.log(`✅ Updated: ${fullCompanyData.name} - ${fullCompanyData.address}`);
                        }

                    } catch (error) {
                        console.log(`❌ Error processing ${company.name}: ${error.message}`);
                    }

                    // ── Cross-worker de-dupe check + claim ──────────────────
                    // Skip if Maps URL already processed by any worker (real-time check)
                    if (isAlreadyProcessed(fullCompanyData.mapsUrl)) {
                        console.log(`⏭️ Skipping duplicate: ${fullCompanyData.name}`);
                        globalIndex++;
                        continue;
                    }
                    // Claim this URL immediately before processing
                    markAsProcessed(fullCompanyData.mapsUrl);

                    let emails = [];
                    let emailCount = 0;

                    if (fullCompanyData.website && fullCompanyData.website.startsWith('http') && fullCompanyData.website.length > 10) {
                        fullCompanyData.website = cleanGoogleUrl(fullCompanyData.website);
                        // Strip UTM/query params — use only origin+pathname for homepage
                        try {
                            const u = new URL(fullCompanyData.website);
                            fullCompanyData.website = u.origin;
                        } catch (_) {}
                        console.log(`🌐 Checking website details for: ${fullCompanyData.name}`);
                        const websiteDetails = await scrapeWebsiteDetails(page, fullCompanyData.website);

                        emails = websiteDetails.emails;
                        emailCount = emails.length;

                        if (emails.length > 0) {
                            console.log(`✅ Found ${emails.length} emails: ${emails.join('; ')}`);
                            totalEmails += emails.length;
                        }

                        appendToL1Txt(websiteDetails.linkedin);

                        // Row layout matches the CSV header defined in initCSV().
                        const unifiedData = [
                            globalIndex,
                            city,
                            keyword,
                            fullCompanyData.name,
                            fullCompanyData.rating,
                            fullCompanyData.reviews,
                            fullCompanyData.address,
                            fullCompanyData.phone,
                            fullCompanyData.website, // Maps website
                            websiteDetails.actualWebsite, // Actual website after redirects
                            websiteDetails.contactFormUrl, // Contact form URL
                            fullCompanyData.mapsUrl,
                            emails.join('; '),
                            emailCount,
                            (websiteDetails.facebook || []).join('; '),
                            (websiteDetails.linkedin || []).join('; '),
                            new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                        ];

                        saveToCSV(unifiedData);
                        await sendToSheets(unifiedData);
                    } else {
                        // No usable website — still record the business (with
                        // empty website/contact/email fields) so it's captured
                        // in the CSV and not re-scraped on a future run.
                        console.log(`⏭️ No valid website for: ${fullCompanyData.name}`);

                        const unifiedData = [
                            globalIndex,
                            city,
                            keyword,
                            fullCompanyData.name,
                            fullCompanyData.rating,
                            fullCompanyData.reviews,
                            fullCompanyData.address,
                            fullCompanyData.phone,
                            fullCompanyData.website,
                            '', // No actual website
                            '', // No contact form
                            fullCompanyData.mapsUrl,
                            '',
                            0,
                            '', // No Facebook
                            '', // No LinkedIn
                            new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                        ];

                        saveToCSV(unifiedData);
                        await sendToSheets(unifiedData);
                    }

                    // Fine-grained resume checkpoint: persist after every
                    // single business, not just after the whole search, so a
                    // crash mid-search only loses at most one business.
                    saveProgress();

                    globalIndex++; // Increment global counter
                    await new Promise(r => setTimeout(r, 500));
                }

                totalCompanies += companies.length;
                // Coarse-grained resume checkpoint: mark this {city,keyword}
                // search itself as fully completed and advance currentIndex,
                // so a restart skips straight past it via the `continue`
                // check near the top of the loop.
                progress.completed.push(searchKey);
                progress.currentIndex = i;
                saveProgress();

                console.log(`✅ Completed: ${companies.length} companies, ${totalEmails} total emails`);

            } catch (error) {
                console.log(`❌ Error in search: ${error.message}`);
            }

            await new Promise(r => setTimeout(r, 2000));
        }

    } finally {
        await browser.close();
        console.log(`\n🎉 Scraping completed!`);
        console.log(`📊 Total companies: ${totalCompanies}`);
        console.log(`📧 Total emails: ${totalEmails}`);
        console.log(`📄 Data saved to: ${CSV_FILE}`);
    }
}

// Top-level supervisor loop: keeps the scraper alive indefinitely. If
// scrapeUnified() throws for any reason (browser crash, network outage,
// unhandled page error), this catches it, waits 5 minutes, and restarts —
// relying on the progress files to resume near where it left off rather
// than reprocessing everything.
async function runWithRestart() {
    while (true) {
        try {
            await scrapeUnified();
            console.log('✅ Scraping completed successfully');
            break;
        } catch (error) {
            console.error('❌ Scraper error:', error.message);
            console.log('⏰ Waiting 5 minutes before restart...');
            await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
            console.log('🔄 Restarting scraper...');
        }
    }
}

// Only auto-run when executed directly (e.g. `node unified_scraper.js` or
// via run.js/run1.js.._run7.js), not when required as a module elsewhere.
if (require.main === module) {
    runWithRestart().catch(console.error);
}
