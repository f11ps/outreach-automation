// driver_setup.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// This file is the "browser factory" for the whole automation pipeline. Its job
// is to build a Selenium `WebDriver` instance that drives a real Chrome browser
// in a way that (a) reliably finds a compatible Chrome binary + matching
// ChromeDriver on the host machine, and (b) is configured to look as little
// like an automated bot as possible (disabled automation flags, spoofed
// `navigator.webdriver`, optional hCaptcha-solving extension, optional proxy
// rotation). Every other module in the pipeline (form finder, field filler,
// captcha handler, submitter, etc.) receives this `driver` object and drives
// the already-open browser through it — this file never navigates to a
// business's website itself, it only creates/tears down the browser session.
//
// ── How it works (high level) ───────────────────────────────────────────────
// 1. `findBrowserBinary()` scans a list of common install paths to locate a
//    real Chrome/Chromium executable (handles snap-installed Chrome symlinks).
// 2. `findChromedriverBinary()` figures out the browser's major version and
//    tries to find a ChromeDriver binary whose major version matches it —
//    first via an env var override, then via the cache directory that
//    `webdriver-manager` (wdm) downloads into, then via a `.driver-cache`
//    folder maintained by a Python-side helper. If nothing matches, it lets
//    Selenium Manager / the system driver take over.
// 3. `makeDriver()` ties it all together: picks binary + driver, builds a
//    fresh temporary Chrome user-data-dir (so every run starts with a clean
//    profile/cookie jar), sets a grab-bag of Chrome flags for stability and
//    anti-detection, optionally wires in an HTTP proxy for IP rotation and the
//    "hektCaptcha" browser extension for automatic hCaptcha solving, then
//    builds the Selenium `Builder` and does a small CDP (Chrome DevTools
//    Protocol) trick to hide the fact that the page is being automated.
// 4. `isDriverAlive()` / `restartDriver()` are used by the caller to detect a
//    crashed/hung Chrome session and transparently replace it with a new one
//    mid-run, so a single bad page doesn't kill the whole batch job.
//
// Exported functions: `makeDriver`, `isDriverAlive`, `restartDriver`.
//
// ── Dependencies / usage ────────────────────────────────────────────────────
// - Depends on `./config` for `PAGE_LOAD_TIMEOUT`, and optionally on
//   `./ip_rotator` (lazily required only when `USE_PROXY=1`) for proxy
//   rotation, and on a `hcaptcha_models/ext` folder next to this file for the
//   auto-hCaptcha-solving Chrome extension.
// - Used by `main.js`, which calls `makeDriver()` once per URL-processing
//   session (and again via `restartDriver()` if Chrome dies mid-run) before
//   handing the resulting `driver` off to `navigator.js` (`findContactPage`),
//   `form_finder.js`, `fields.js`, `captcha/handler.js` and `submitter.js`.
'use strict';

const { Builder }  = require('selenium-webdriver');
const chrome       = require('selenium-webdriver/chrome');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execFileSync } = require('child_process');
const { PAGE_LOAD_TIMEOUT } = require('./config');

// USE_PROXY toggles whether outbound traffic is routed through a rotating
// proxy pool (useful to avoid IP-based rate limiting/blocking across many
// business websites). The rotator module is optional, so it's required
// lazily below and swallowed if missing rather than crashing at load time.
const USE_PROXY = process.env.USE_PROXY === '1';
let _rotator = null;
function getRotator() {
  if (!_rotator) {
    try { _rotator = require('./ip_rotator').rotator; } catch(_) {}
  }
  return _rotator;
}

// Common install locations for Chrome/Chromium across typical Linux setups
// (apt package, snap package via /opt/google, chromium fallback). We probe
// these instead of relying on PATH because headless/server environments
// often don't have `google-chrome` on PATH even when it's installed.
const CHROME_CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/opt/google/chrome/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

// Directory where `webdriver-manager` (wdm) caches downloaded ChromeDriver
// binaries, keyed by driver version.
const WDM_BASE = path.join(os.homedir(), '.wdm', 'drivers', 'chromedriver', 'linux64');

// Tracks the current temp Chrome profile dir so it can be cleaned up when a
// new one is created (e.g. on driver restart).
let _profileDir = null;

// Walk the candidate paths and return the first one that is an actual,
// executable file. Snap-installed Chrome exposes `google-chrome` as a
// symlink into a snap mount; `fs.realpathSync` resolves that so we get the
// true executable path (needed later for `execFileSync` version checks).
function findBrowserBinary() {
  for (const p of CHROME_CANDIDATES) {
    try {
      const real = fs.realpathSync(p);
      if (fs.existsSync(real) && fs.accessSync(real, fs.constants.X_OK) === undefined) return real;
    } catch (_) {
      // realpathSync/existsSync failed (e.g. broken symlink) — fall back to
      // checking the raw path itself before giving up on this candidate.
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (_2) { /* skip */ }
    }
  }
  return null;
}

// Pulls a major version number (e.g. "124") out of a raw version string like
// "Google Chrome 124.0.6367.91" or "ChromeDriver 124.0.6367.91 (...)".
function getMajorVersion(versionText) {
  const match = String(versionText || '').match(/\b(\d+)\.\d+\.\d+\.\d+\b/);
  return match ? match[1] : null;
}

// Runs `<binary> --version` and extracts Chrome's major version. Wrapped in
// try/catch because the binary may not support `--version` or may not exist.
function getBrowserMajor(binary) {
  if (!binary) return null;
  try {
    return getMajorVersion(execFileSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (_) {
    return null;
  }
}

// Same idea as getBrowserMajor but for a chromedriver binary.
function getDriverMajor(driverPath) {
  try {
    return getMajorVersion(execFileSync(driverPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (_) {
    return null;
  }
}

// ChromeDriver only works reliably with a Chrome build of the same major
// version, so before accepting a candidate driver we verify the versions
// line up. If we couldn't determine the browser's version at all, we assume
// compatibility rather than blocking startup entirely.
function isCompatibleDriver(driverPath, browserMajor) {
  if (!browserMajor) return true;
  const driverMajor = getDriverMajor(driverPath);
  return driverMajor === browserMajor;
}

// Locates a ChromeDriver binary compatible with the given browser binary,
// trying multiple sources in priority order:
//   1. CHROMEDRIVER_PATH env var override (if set and version-compatible)
//   2. webdriver-manager's cache (~/.wdm/...), newest version dirs first —
//      preferred over any snap-provided stub driver
//   3. A `.driver-cache` directory one level up from cwd, populated by a
//      Python-side companion tool
// If none of these produce a compatible driver, returns null so the caller
// falls back to Selenium Manager / whatever chromedriver is on PATH.
function findChromedriverBinary(browserBinary) {
  const browserMajor = getBrowserMajor(browserBinary);
  if (browserMajor) console.log(`   🧩 Chrome major version: ${browserMajor}`);

  if (process.env.CHROMEDRIVER_PATH) {
    const p = process.env.CHROMEDRIVER_PATH;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (isCompatibleDriver(p, browserMajor)) return p;
      console.log(`   ⚠️  Ignoring CHROMEDRIVER_PATH with incompatible version: ${p}`);
    } catch (_) {}
  }

  // Prefer wdm real binaries over snap stubs
  if (fs.existsSync(WDM_BASE)) {
    const versions = fs.readdirSync(WDM_BASE).sort().reverse();
    for (const ver of versions) {
      const p = path.join(WDM_BASE, ver, 'chromedriver-linux64', 'chromedriver');
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (isCompatibleDriver(p, browserMajor)) return p;
      } catch (_) {}
    }
  }

  // Fall back to .driver-cache (copied by Python side)
  const cached = path.join(process.cwd(), '..', '.driver-cache', 'chromedriver');
  try {
    fs.accessSync(cached, fs.constants.X_OK);
    if (isCompatibleDriver(cached, browserMajor)) return cached;
  } catch (_) {}

  if (browserMajor) {
    console.log(`   ⚠️  No cached ChromeDriver for Chrome ${browserMajor}; trying Selenium Manager/system driver`);
  }
  return null;
}

// Creates a brand-new, empty temp directory to use as Chrome's
// `--user-data-dir` for this session (guarantees no leftover cookies/local
// storage/cache bleed between runs or between different target websites).
// If a previous profile dir exists it is deleted first to avoid piling up
// temp folders across restarts.
function freshProfileDir() {
  if (_profileDir && fs.existsSync(_profileDir)) {
    try { fs.rmSync(_profileDir, { recursive: true, force: true }); } catch (_) {}
  }
  _profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome_js_profile_'));
  return _profileDir;
}

// Path to an unpacked Chrome extension ("hektCaptcha") that automatically
// attempts to solve hCaptcha challenges. Loaded as an unpacked extension via
// `--load-extension` if the folder is present; if it's missing, Chrome just
// starts without it (no hard dependency).
const HCAPTCHA_EXT = path.join(__dirname, 'hcaptcha_models', 'ext');

// Builds and returns a fully-configured, ready-to-use Selenium Chrome
// WebDriver. This is the main export of the file and the only thing most
// callers need.
async function makeDriver() {
  const binary     = findBrowserBinary();
  const driverPath = findChromedriverBinary(binary);
  const headless   = ['1','true','True'].includes(process.env.HEADLESS || '0');
  const profileDir = freshProfileDir();

  const opts = new chrome.Options();
  if (binary) {
    opts.setChromeBinaryPath(binary);
    console.log(`   🧩 Browser binary: ${binary}`);
  }
  opts.addArguments(
    '--disable-notifications',            // suppress native "allow notifications" popups that would block forms
    '--disable-blink-features=AutomationControlled', // hides the most common automation fingerprint flag
    '--no-sandbox',                       // required in many containerized/headless server environments
    '--disable-dev-shm-usage',            // avoids /dev/shm running out of space in Docker-like environments
    '--window-size=960,1080',
    '--window-position=0,0',
    `--user-data-dir=${profileDir}`,      // isolate this session's cookies/cache in a throwaway profile
  );

  // Load hektCaptcha extension for auto hCaptcha solving
  if (fs.existsSync(HCAPTCHA_EXT)) {
    opts.addArguments(`--load-extension=${HCAPTCHA_EXT}`);
    console.log('   🧩 hektCaptcha extension loaded');
  }

  if (headless) opts.addArguments('--headless=new', '--disable-gpu');

  // IP rotation — get proxy before building driver
  // (must happen before the driver is built since --proxy-server is a
  // launch-time Chrome flag, not something that can be changed afterward)
  if (USE_PROXY) {
    const rotator = getRotator();
    if (rotator) {
      const proxy = await rotator.nextProxy();
      if (proxy) {
        opts.addArguments(`--proxy-server=http://${proxy}`);
        opts.addArguments('--proxy-bypass-list=<-loopback>');
        console.log(`   🌐 Using proxy: ${proxy}`);
      } else {
        console.log('   🌐 No proxy available — using direct IP');
      }
    }
  }

  // Exclude automation switches to avoid detection
  // ("enable-automation" is what puts the "Chrome is being controlled by
  // automated test software" infobar; excluding it plus hiding the infobar
  // itself keeps the browser look closer to a normal user session)
  opts.excludeSwitches(['enable-automation']);
  opts.addArguments('--disable-infobars');

  // Use the version-matched ChromeDriver we found, if any; otherwise let
  // Selenium's default ServiceBuilder resolve one (Selenium Manager / PATH).
  const svc = driverPath
    ? new chrome.ServiceBuilder(driverPath)
    : new chrome.ServiceBuilder();

  console.log(`   🧩 ChromeDriver: ${driverPath || 'system'}`);

  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(opts)
    .setChromeService(svc)
    .build();

  // Cap how long a single page navigation is allowed to hang before
  // Selenium gives up — prevents one slow/broken site from stalling the
  // whole batch run indefinitely.
  await driver.manage().setTimeouts({ pageLoad: PAGE_LOAD_TIMEOUT });

  // Spoof navigator.webdriver via CDP
  // Even with the Blink automation flag disabled, some anti-bot scripts
  // check `navigator.webdriver` / plugin list / language list directly. This
  // injects a script that runs on every new document (i.e. every page load
  // and every iframe) to patch those properties before any page JS can read
  // them, and fakes a minimal `window.chrome` object that's normally only
  // present in non-automated Chrome. Best-effort: failures are ignored since
  // this is a "nice to have" anti-detection measure, not critical path.
  try {
    const connection = await driver.createCDPConnection('page');
    await connection.execute('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
        "Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});",
        "Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});",
        "window.chrome=window.chrome||{runtime:{}};",
      ].join('')
    });
  } catch (_) {}

  return driver;
}

// Cheap liveness check used by callers to decide whether the current driver
// session is still usable — `getTitle()` requires a working browser/session,
// so if it throws, the browser has likely crashed or the session was lost.
async function isDriverAlive(driver) {
  try { await driver.getTitle(); return true; } catch (_) { return false; }
}

// Kills the (possibly already-dead) driver and boots a fresh one, so a
// crashed Chrome process doesn't take down the whole batch job — the caller
// in main.js can just swap in the returned driver and keep going.
async function restartDriver(driver) {
  console.log('   🔄 Chrome restarting...');
  try { await driver.quit(); } catch (_) {}
  await sleep(2000);
  const d = await makeDriver();
  console.log('   ✅ Chrome restarted');
  return d;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { makeDriver, isDriverAlive, restartDriver };
