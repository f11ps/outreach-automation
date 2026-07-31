#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// autopush.js — Filesystem watcher that auto-commits & auto-pushes to GitHub
//
// PURPOSE / ROLE IN THE PIPELINE:
//   A standalone utility (not part of the scraping/form-filling logic
//   itself) that keeps a GitHub remote in sync with this project's working
//   directory while the scraper (unified_scraper.js) and/or form filler
//   (main.js) are running. It's spawned in the background by run.js so that
//   as digital_marketing_data.csv, unified_progress*.json,
//   processed_maps_urls.txt, form_results/*, etc. get updated over a long
//   unattended run, those changes are periodically committed and pushed
//   automatically — giving an off-machine backup / live view of progress
//   without any manual `git add/commit/push`.
//
// HOW IT WORKS (high level):
//   - watch(dir) recursively walks the project directory tree (skipping
//     anything in IGNORE, e.g. .git/, node_modules/, form_results/) and
//     attaches an fs.watch() listener to every individual file, plus one on
//     each directory itself (to catch newly created files/subfolders that
//     didn't exist when watch() first ran).
//   - Every filesystem change event (any file write/rename under a watched
//     path) resets a single shared debounce timer (clearTimeout + a fresh
//     setTimeout). This means push() only actually runs once activity has
//     been quiet for DEBOUNCE_MS (3s) — coalescing bursts of rapid writes
//     (e.g. the scraper appending to the CSV + progress file + shared URL
//     ledger back-to-back) into a single commit instead of one per file
//     write.
//   - push() is the actual "decide what/when to commit" logic: it first
//     runs `git status --porcelain` and bails out immediately if there's
//     nothing to commit (so it never creates empty commits), otherwise it
//     stages everything (`git add -A`), commits with an auto-generated
//     ISO-timestamp message, and pushes to `origin main`. Any error (e.g.
//     push rejected, network issue, nothing to commit race) is caught and
//     logged rather than crashing the watcher.
//
// DEPENDENCIES / USED BY:
//   - No dependencies on other project modules — it only shells out to `git`
//     (via child_process.execSync) and watches the filesystem.
//   - Spawned as a background process by run.js when the scraper starts.
//   - Effectively "watches" everything unified_scraper.js, main.js,
//     result_tracker.js etc. write to (digital_marketing_data.csv,
//     unified_progress*.json, processed_maps_urls.txt,
//     form_results/contact_results.csv, etc.) except the excluded paths
//     below, and pushes them to the project's `origin` GitHub remote on
//     branch `main`.
//   - SAFETY NOTE: this script has no secret-scanning of its own — it
//     blindly `git add -A`s everything not in IGNORE and pushes it. Any
//     credentials/API keys that end up in a non-ignored file (e.g. checked
//     into config.js, or a stray .env not covered by .gitignore) would be
//     committed and pushed automatically. The only guards against that are
//     the project's own .gitignore and the small IGNORE set below (which is
//     about noisy/irrelevant paths, not secrets).
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIR = __dirname;
const DEBOUNCE_MS = 3000;

// Paths (by basename, not full path) that are never watched and never
// included by the recursive walk in watch(). Note IGNORE checks are
// basename-only, so a nested directory would need the same name to also be
// skipped — this is a lightweight filter, not a full .gitignore parser.
const IGNORE = new Set([
  '.git', 'node_modules', 'form_results', '.wdm',
  'autopush.js', 'package-lock.json',
]);

let timer = null;

// Commits and pushes whatever has changed, but only if there IS something
// to commit (checked via `git status --porcelain`, which is empty when the
// working tree is clean) — this prevents autopush from creating a stream of
// empty "auto: <timestamp>" commits when it fires on its own past writes or
// on no-op events.
function push() {
  try {
    const status = execSync('git status --porcelain', { cwd: DIR }).toString().trim();
    if (!status) return;
    console.log(`[autopush] Changes detected:\n${status}`);
    execSync('git add -A', { cwd: DIR });
    execSync(`git commit -m "auto: ${new Date().toISOString()}"`, { cwd: DIR });
    execSync('git push origin main', { cwd: DIR });
    console.log('[autopush] ✅ Pushed to GitHub');
  } catch (e) {
    // Covers: nothing staged (race with the status check above), commit
    // hook failures, push rejections (e.g. remote has diverged), network
    // errors, etc. Logged but not fatal — the watcher keeps running and
    // will simply try again on the next detected change.
    console.error('[autopush] ❌', e.message.split('\n')[0]);
  }
}

// Recursively attaches fs.watch() listeners across the whole project tree
// (skipping IGNORE entries) so that any file write anywhere triggers the
// debounced push() below.
function watch(dir) {
  fs.readdirSync(dir).forEach(name => {
    if (IGNORE.has(name)) return;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        // Recurse into subdirectories so nested files (e.g. captcha/*.js)
        // are watched individually too.
        watch(full);
      } else {
        // Per-file watcher: any change event on this specific file
        // (re)starts the shared debounce timer.
        fs.watch(full, () => {
          clearTimeout(timer);
          timer = setTimeout(push, DEBOUNCE_MS);
        });
      }
    } catch (_) {}
  });

  // Watch dir itself for new files
  // A directory-level watcher is also needed because fs.watch() on a file
  // only fires for changes to files that existed (and were individually
  // watched) at the time watch() ran — a brand-new file created later in
  // this directory wouldn't otherwise be noticed. This catches that case
  // too (though the new file itself still isn't watched individually until
  // the process restarts / watch() re-runs on it).
  fs.watch(dir, (event, filename) => {
    if (!filename || IGNORE.has(filename.split(path.sep)[0])) return;
    clearTimeout(timer);
    timer = setTimeout(push, DEBOUNCE_MS);
  });
}

console.log('[autopush] 👀 Watching for changes...');
watch(DIR);
