// ════════════════════════════════════════════════════════════════════════════
// run.js — Entry point that starts the Google Maps scraper (single-worker)
//
// PURPOSE / ROLE IN THE PIPELINE:
//   This is the "Step 2" entry point from the README (`node run.js`): it
//   launches unified_scraper.js, which searches Google Maps across many
//   cities/keywords and writes discovered business data (name, address,
//   phone, website, contact form URL) to digital_marketing_data.csv. That
//   CSV is later consumed by fill.js/main.js to actually fill contact forms.
//   It also kicks off autopush.js in the background so scraped data /
//   results get periodically auto-committed and pushed to git.
//
// HOW IT WORKS (high level):
//   1. Spawn autopush.js as a detached background process (fire-and-forget).
//   2. Spawn unified_scraper.js as a foreground child process with
//      stdio: 'inherit' so its console output (progress, found businesses,
//      etc.) streams directly to this terminal.
//   3. When the scraper child process exits, this process exits with the
//      same exit code (propagating success/failure to the shell/caller).
//
//   Note: unlike run1.js..run7.js, this file does NOT set a WORKER_ID env
//   var, so unified_scraper.js runs in its default single-worker mode
//   (covering the full city/keyword list itself, rather than a shard of it).
//
// DEPENDENCIES / USED BY:
//   - Spawns: autopush.js, unified_scraper.js.
//   - Sibling files run1.js .. run7.js do the same thing but pass a
//     WORKER_ID env var so multiple scraper instances can run in parallel,
//     each covering a different shard/subset of the search space.
//   - This is a file the user runs directly per the README (`node run.js`).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { spawn } = require('child_process');

// Start autopush in background
// detached + unref: autopush.js runs independently of this process's
// lifecycle and won't keep Node alive on its own.
const autopush = spawn('node', ['autopush.js'], { cwd: __dirname, stdio: 'ignore', detached: true });
autopush.unref();
console.log('🔄 Autopush started\n');

// Start scraper
console.log('🗺️  Starting Google Maps Scraper...\n');
// stdio: 'inherit' streams the scraper's own console output straight to
// this process's terminal; propagate its exit code (or 0 if none) so shell
// scripts/CI can detect success/failure correctly.
const child = spawn('node', ['unified_scraper.js'], { cwd: __dirname, stdio: 'inherit' });
child.on('exit', code => process.exit(code || 0));
