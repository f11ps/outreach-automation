# Outreach Automation Pipeline

Node.js + Python automation that scrapes businesses from Google Maps across a configurable list of cities/keywords (`config.json`), finds each business's emails/Facebook/LinkedIn, enriches every LinkedIn company page it finds with "About" section data, and automatically fills + submits each business's website contact form (hCaptcha, reCAPTCHA, Cloudflare Turnstile, and Math/CF7-quiz CAPTCHAs all solved automatically). Everything is also pushed live to a shared Google Sheet.

---

## Pipeline Overview

```
unified_scraper.js  (Google Maps scrape: areas/keywords from config.json)
        │
        ├──► digital_marketing_data.csv   (local, resume/dedup source)
        ├──► MapData sheet                 (via code.gs) — includes All Emails,
        │                                   Facebook, LinkedIn columns, found
        │                                   inline while visiting each website
        └──► l1.txt                        (every LinkedIn *company* URL found)
                        │
                        ▼
                l1.py  (LinkedIn "About" section scrape, polls l1.txt forever)
                        │
                        ├──► linkedin_companies.csv
                        └──► LinkedInData sheet (via code.gs)

        fill.js  (watches digital_marketing_data.csv for new Contact-Form/Website URLs)
                        │
                        ▼
                  retry_urls.txt ──► main.js  (fills + submits contact forms)
                                        │
                                        ├──► form_results/contact_results.csv
                                        └──► CFResults sheet (via result_tracker.js)
```

`run.js` starts `unified_scraper.js` (single worker) + kicks off `autopush.js` in the background. `run1.js`..`run7.js` do the same but each pins `unified_scraper.js` to a different `WORKER_ID` (1-7), letting the `config.json` city list be split 7 ways and scraped in parallel — run several of them at once (separate terminals/tmux panes) instead of `run.js` to go faster. `fill.js` is the separate outer loop that watches the scraped CSV and auto-spawns `main.js` whenever there's a contact form to fill. `l1.py` runs independently (its own terminal) and just polls `l1.txt` forever.

---

## Quick Start

```bash
npm install
pip install -r requirements.txt --break-system-packages
```

Scraper (single worker) + autopush:
```bash
node run.js
```

Or several parallel scraper workers (faster, needs more terminals):
```bash
node run1.js   # ... through run7.js, one per terminal
```

Contact-form filler (watches the scraped CSV, auto-runs main.js):
```bash
node fill.js
```

LinkedIn company-page enrichment (separate terminal, runs continuously):
```bash
python3 l1.py
```

Or run any stage standalone:
```bash
node unified_scraper.js   # Google Maps scrape only
node main.js               # contact form filler only (needs retry_urls.txt)
```

`GOOGLE_SHEETS_URL` env var overrides the default deployed webapp URL for any of the above (`unified_scraper.js`, `result_tracker.js`, `l1.py` all default to the same deployment).

---

## File Structure

```
outreach-automation/
├── unified_scraper.js         # Google Maps scraper (areas/keywords from config.json);
│                               # also finds emails/Facebook/LinkedIn per business and
│                               # feeds l1.txt with LinkedIn company URLs
├── config.json                 # unified_scraper.js's areas + keywords — ships with a
│                               # general-purpose default list, edit freely (see loadConfig()
│                               # in unified_scraper.js for the { areas, keywords } shape)
├── l1.py                       # LinkedIn company "About" page scraper (resumable,
│                               # polls l1.txt forever, pushes to LinkedInData sheet)
├── l1.txt                      # LinkedIn company URLs to scrape (auto-fed by
│                               # unified_scraper.js's appendToL1Txt)
│
├── main.js                     # Contact-form filler main loop
├── fill.js                     # Watches digital_marketing_data.csv, queues URLs,
│                               # auto-runs main.js
├── run.js                      # Starts unified_scraper.js (single worker) + autopush.js
├── run1.js .. run7.js          # Same as run.js but each sets WORKER_ID=1..7 so
│                               # unified_scraper.js can be run as parallel workers
├── config.js                   # Contact identities, outreach message, paths, CAPTCHA settings
├── navigator.js                # Contact page finder
├── form_finder.js              # Form detection engine
├── form_types.js               # Multi-step form / blocker handling
├── fields.js                   # Field filling logic
├── submitter.js                # Form submit + success detect
├── driver_setup.js             # Chrome/Selenium setup
├── result_tracker.js           # CSV + Google Sheets logging (CFResults)
├── autopush.js                 # Auto git commit+push loop (see Housekeeping — no
│                               # secret-scanning of its own, relies on .gitignore)
├── code.gs                     # Google Apps Script — all 3 sheet tabs
│
├── whisper_server.py           # Whisper audio transcription server (reCAPTCHA audio)
├── hcaptcha_sb_solver.py       # SeleniumBase hCaptcha solver ⭐
├── hcaptcha_cnn_solver.py      # CNN image classifier (hCaptcha fallback, currently unused
│                               # — see note in that file)
│
├── captcha/
│   ├── handler.js              # CAPTCHA orchestrator
│   ├── detector.js             # CAPTCHA type detector
│   ├── hcaptcha.js             # hCaptcha Node.js wrapper ⭐
│   ├── recaptcha.js            # reCAPTCHA v2 audio solver
│   ├── image_captcha.js        # Image OCR + Math/CF7-quiz solver
│   └── turnstile.js            # Cloudflare Turnstile handler
│
├── digital_marketing_data.csv  # unified_scraper.js output (mirrors MapData sheet)
├── linkedin_companies.csv      # l1.py output (mirrors LinkedInData sheet)
├── retry_urls.txt              # queue main.js reads from
├── processed_maps_urls.txt     # shared cross-worker de-dupe ledger of Maps URLs
├── *_progress.json / .txt      # resume-point files, one per script (see below)
└── cookies.json                # (gitignored) LinkedIn session cookies — optional, see
                                 # LinkedIn section below for why l1.py works without it
```

### Progress / resume files

| File | Used by | Format |
|---|---|---|
| `unified_progress.json` / `unified_progress_<WORKER_ID>.json` | `unified_scraper.js` | search index + processed Maps URLs |
| `processed_maps_urls.txt` | `unified_scraper.js` (all workers, shared) | one Maps URL per line, cross-worker de-dupe |
| `form_results/progress.txt` | `main.js` | last processed index into `retry_urls.txt` |

`l1.py` doesn't use a separate progress file — it resumes by reading which LinkedIn URLs are already in `linkedin_companies.csv`.

All are safe to delete individually to force a full re-run of that one script; nothing else depends on them.

---

## Emails / Facebook / LinkedIn

`unified_scraper.js` finds all three during the same website visit, in `scrapeWebsiteDetails()` — no separate retry pass needed:

- **Emails**: mailto: links, Cloudflare email-obfuscation decoding, plain visible text, and raw HTML — all filtered to match the site's own domain.
- **Facebook / LinkedIn**: every `<a href>` on the page (plus a raw-HTML regex fallback for links embedded in scripts/JSON) is checked by `extractSocialLinks()` / `isValidSocialUrl()` / `cleanSocialUrl()`, which reject share/sharer/login/feed-style junk links, keep only real company/profile pages, unwrap Facebook's `/l.php` and LinkedIn's `/redir/redirect` tracking wrappers, and normalize a LinkedIn URL like `/company/xyz/posts` down to the bare `/company/xyz/` canonical page.

Both the homepage and every discovered contact-page visit contribute to the final result — a business that only lists its Facebook page on `/about` rather than the homepage still gets caught. Results land in the `Facebook` / `LinkedIn` columns of `digital_marketing_data.csv` and the `MapData` sheet, right after `Email Count`.

Every LinkedIn **company** URL found (personal `/in/` profiles are skipped) is also appended to `l1.txt` (deduped) via `appendToL1Txt()`, feeding the LinkedIn enrichment stage below.

---

## LinkedIn Enrichment — `l1.py`

Standalone, resumable LinkedIn company-page scraper that runs independently of `unified_scraper.js`, in its own terminal.

- Polls `l1.txt` (one URL per line) every 5 minutes for new work — since `unified_scraper.js` keeps appending to it while it runs, `l1.py` just needs to be started once and left running
- Plain `requests` + BeautifulSoup — **no cookies needed**, and in practice cookies make results *worse*: an authenticated (especially Sales Navigator) session gets served a JS-rendered SPA shell with no parseable About-section markup, while a logged-out request gets LinkedIn's SEO-friendly server-rendered page, which is what this script actually parses
- Extracts: Overview, Website, Phone, Industry, Company Size, Headquarters, Type, Founded, Specialties, Locations, Company Name, Headline, top-card sublines
- Resume: skips any URL already present in `linkedin_companies.csv`
- Pushes each successfully-scraped row straight to the **LinkedInData** sheet tab (in addition to the local CSV) — no separate sync step needed

```bash
python3 l1.py
```

⚠️ LinkedIn's bot-detection is **inconsistent, not a hard block** — the same URL can return real data, a 429, or an HTTP-200 CAPTCHA/"checking your browser" page depending on very recent request volume from this IP. There's no reliable way to force it open — just leave `l1.py` running; each poll cycle picks up whatever it can.

---

## `code.gs`

Google Apps Script — 3 sheets managed:
- `MapData` — scraper data (Maps scrape + All Emails/Email Count/Facebook/LinkedIn/Timestamp, 17 columns)
- `CFResults` — main.js contact-form results, colored by status
- `LinkedInData` — l1.py results (one row per URL, posted individually rather than batched)

**POST** (`type` field selects handler): `map`, `cf`, `linkedin`

**GET** (no `action` param): JSON stats summary — row counts for all three sheets, plus a success/failed/skipped breakdown for CFResults.

### Google Sheets Setup

1. [script.google.com](https://script.google.com) → New Project
2. Paste in `code.gs`
3. Deploy → Web App → Anyone access
4. Copy the Web App URL → set it as the `GOOGLE_SHEETS_URL` env var, or hardcode it into `unified_scraper.js`, `result_tracker.js`, and `l1.py` (all three currently point at the same deployment)

Update karte waqt: **Deploy → Manage deployments → pencil icon → New version** use karo, "New deployment" nahi — isse URL same rehta hai aur teeno scripts mein baar-baar URL badalna nahi padta. (A "New deployment" instead mints a brand-new URL, which is why all three files needed a manual update the one time this project switched deployments.)

3 tabs automatically banenge: `MapData`, `CFResults`, `LinkedInData`.

---

## CAPTCHA System

### `captcha/detector.js`
The "eyes" of the CAPTCHA subsystem — doesn't solve anything, just looks at the page (or a narrower `formContext` iframe) and reports what's present: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, generic image CAPTCHA, or a Math/CF7 quiz. Checked in priority order so an ambiguous page resolves to the right solver.

### `captcha/handler.js`
The central "traffic controller" — `handleCaptcha(driver, record, stage, ...)` is called by `main.js` both pre-submit (clear anything blocking the form) and post-submit (clear a secondary challenge, common with Cloudflare bot protection that only triggers after the POST fires). Dispatches to the right solver module based on what `detector.js` reports:
```
Image/Math  → image_captcha.js
reCAPTCHA V3 → Skip (score-based, not solvable)
Cloudflare  → turnstile.js
reCAPTCHA v2 → recaptcha.js (Whisper audio)
hCaptcha    → hcaptcha.js (SeleniumBase CDP) ⭐
```

---

## hCaptcha Solver — Detailed Explanation ⭐

### Problem
hCaptcha normal Selenium clicks detect kar leta hai kyunki:
- JavaScript `dispatchEvent()` se click ka `isTrusted = false` hota hai
- hCaptcha `isTrusted` property check karta hai
- Bot detect hone par image challenge deta hai ya block karta hai

### Solution: CDP `Input.dispatchMouseEvent`

**Chrome DevTools Protocol (CDP)** browser engine level pe kaam karta hai — JavaScript DOM ke upar. CDP se bheja gaya mouse event `isTrusted = true` hota hai, exactly jaise real human click.

```
Normal JS click:    event.isTrusted = false  ❌ hCaptcha detects bot
CDP mouse event:    event.isTrusted = true   ✅ hCaptcha thinks human
```

### SeleniumBase Implementation

**`hcaptcha_sb_solver.py`** — this is the script that actually solves hCaptcha in the live pipeline today. It opens its own separate Chrome browser (via SeleniumBase's CDP-mode `sb_cdp.Chrome`), clicks the checkbox with a real CDP-dispatched mouse event, then polls the DOM until hCaptcha's own JS fills in a passed response token:

```python
sb = sb_cdp.Chrome(url, lang="en")  # Apna Chrome kholta hai
sb.gui_click_captcha()               # CDP click → isTrusted=true
token = sb.evaluate("[name='h-captcha-response']?.value")
```

`hcaptcha_cnn_solver.py` (MobileNetV3 tile classifier) is defined as a fallback path in `captcha/hcaptcha.js` but is currently unused — the live flow always goes through the SeleniumBase checkbox-click approach above rather than solving image tiles.

### Why Two Browsers?

- Selenium WebDriver ka Chrome `navigator.webdriver = true` hota hai
- SeleniumBase CDP mode mein yeh `undefined` hota hai
- hCaptcha `navigator.webdriver` check karta hai

**Main browser** (Selenium) → form fill karta hai
**SeleniumBase browser** → hCaptcha solve karta hai, token return karta hai
**Token inject** → main browser mein paste hota hai

### `captcha/hcaptcha.js`
Node.js wrapper — spawns the Python solver as a singleton process (started once, reused), sends it the URL via stdin, receives the token via stdout, and injects it into the main Selenium browser's `h-captcha-response` field.

---

## reCAPTCHA v2 Solver

**`captcha/recaptcha.js`** — always steers the widget toward the AUDIO challenge (much easier to automate than image tiles) rather than attempting the image grid:
1. Checkbox click (CDP)
2. Image challenge → audio button click
3. Audio file download
4. **`whisper_server.py`** → persistent Whisper (tiny model) server transcribes the MP3
5. Digit sequence extraction (word-numbers → digits, noise/repeat rejected)
6. Answer typed in, Verify clicked

---

## Math / CF7 Quiz Solver

**`captcha/image_captcha.js`** handles the two simplest CAPTCHA classes — classic distorted-text image CAPTCHAs and plain-text math/quiz CAPTCHAs (including Contact Form 7's built-in "Quiz" field):
- CF7 REST API se question fetch
- Math expressions solve: `2 + 3 = ?` → `5`
- Text answers: `"Spam Check Enter s3oc0mpany"` → `s3oc0mpany` (last word)
- Word numbers: `"seven plus three"` → `10`

---

## Output Files

```
form_results/
├── contact_results.csv      # main.js results
└── progress.txt             # main.js resume point
```

---

## Status Values

| Status | Meaning |
|--------|---------|
| `Success` | Form submitted, confirmation detected |
| `Partial` | Submitted but email/name missing |
| `Failed` | Form found but submit failed |
| `Skipped` | 404/403/timeout/reCAPTCHA V3 |

---

## Dependencies

```bash
npm install
pip install -r requirements.txt --break-system-packages
```

Chrome + a matching ChromeDriver are also required — `driver_setup.js` caches the driver under `~/.wdm/drivers/chromedriver/linux64/<version>/` (falling back to a `.driver-cache/` directory one level above this project, if present) and picks the highest version found there. If Chrome auto-updates past the cached driver version, download a matching one from [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) into that same path structure.

---

## Housekeeping

- `cookies.json` is gitignored (LinkedIn session cookies are real credentials — never commit them). `l1.py` works fine without it; see the LinkedIn Enrichment section above for why an authenticated session is actually *worse* for this scraping approach.
- `autopush.js` runs `git add -A` + commit + push on every detected change with **no secret-scanning of its own** — it relies entirely on `.gitignore` (and the small `IGNORE` set inside the script itself) to keep credentials/binaries/caches out of the repo. If you add any new file that holds a secret, make sure it's gitignored *before* running `run.js`/`run1.js` (which spawn `autopush.js` in the background).
- `config.json` (areas/keywords for `unified_scraper.js`) ships with a general-purpose default (mixed India/US/UK/Canada/Australia/UAE cities x common local-business keywords) — edit it directly to target different cities or business types; see `loadConfig()` in `unified_scraper.js` for the `{ areas: [...], keywords: [...] }` shape.
