// ════════════════════════════════════════════════════════════════════════════
// run1.js — Parallel scraper worker #1
//
// PURPOSE / ROLE IN THE PIPELINE:
//   One of seven near-identical launcher scripts (run1.js .. run7.js) that
//   let the Google Maps scraper (unified_scraper.js) be run as several
//   parallel worker processes instead of a single sequential run (which is
//   what plain run.js does). Running multiple workers in parallel — each in
//   its own terminal/process — speeds up scraping across the large
//   cities x keywords search space defined in config.json.
//
//   This file is IDENTICAL in logic to run2.js..run7.js — the only
//   difference across all seven files is the numeric WORKER_ID passed to
//   unified_scraper.js (and the corresponding "Starting Worker N..."
//   console message). unified_scraper.js reads process.env.WORKER_ID to
//   decide which slice/shard of the work (e.g. which cities or keywords) it
//   is responsible for, so each worker covers a different portion of the
//   overall scrape and they don't duplicate effort.
//
//   Unlike run.js, this file does NOT also spawn autopush.js — that's only
//   started once, by run.js (or by fill.js), not by every parallel worker.
//
// HOW IT WORKS:
//   Spawns `node unified_scraper.js` as a child process with
//   WORKER_ID='1' injected into its environment, streams its output to this
//   terminal (stdio: 'inherit'), and exits with the same code the child
//   process exits with.
//
// DEPENDENCIES / USED BY:
//   - Spawns: unified_scraper.js (with WORKER_ID=1).
//   - Run directly by the user, typically one of several run1.js..run7.js
//     invocations started in parallel (e.g. separate terminals/tmux panes)
//     to scrape faster.
// ════════════════════════════════════════════════════════════════════════════

'use strict';
const { spawn } = require('child_process');
console.log('🗺️  Starting Worker 1...\n');
// WORKER_ID=1 tells unified_scraper.js which shard of cities/keywords this
// particular worker instance should handle.
const child = spawn('node', ['unified_scraper.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, WORKER_ID: '1' }
});
child.on('exit', code => process.exit(code || 0));
