// ════════════════════════════════════════════════════════════════════════════
// run3.js — Parallel scraper worker #3
//
// See run1.js for the full explanation — this file is functionally
// identical to run1.js/run2.js/run4.js../run7.js. The only difference
// between all seven run*.js files is the WORKER_ID value passed to
// unified_scraper.js (here: '3') and the matching "Starting Worker N..."
// log message. unified_scraper.js uses WORKER_ID to determine which shard
// of the cities/keywords search space this process instance should cover,
// allowing several of these scripts to run in parallel (in separate
// terminals) without duplicating scraping work. This script does not spawn
// autopush.js — that's only done once by run.js/fill.js.
// ════════════════════════════════════════════════════════════════════════════

'use strict';
const { spawn } = require('child_process');
console.log('🗺️  Starting Worker 3...\n');
// WORKER_ID=3 tells unified_scraper.js which shard of cities/keywords this
// particular worker instance should handle.
const child = spawn('node', ['unified_scraper.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, WORKER_ID: '3' }
});
child.on('exit', code => process.exit(code || 0));
