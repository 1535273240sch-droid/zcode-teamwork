#!/usr/bin/env node
// Teamwork - Live Terminal Watcher (OLED Pure Black Mission Control).
//
// Refreshes every 2 seconds to provide live visual tracking of:
// - Milestones & Deliverables
// - Dispatches & Parallel Concurrency
// - File Ownership Locks
// - Subagent Heartbeats & Event Ledger

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Import dashboard renderer & engine
const libPath = path.join(REPO_ROOT, 'plugins', 'teamwork', 'lib');
const { TeamworkEngine } = await import(`file://${path.join(libPath, 'engine.mjs').split(path.sep).join('/')}`);
const { renderDashboard } = await import(`file://${path.join(libPath, 'dashboard.mjs').split(path.sep).join('/')}`);

// Working directory can be specified or default to active workspace
let cwd = process.argv[2] || process.cwd();
// If running from repo root, check default active workspace
const defaultWs = path.join(process.env.USERPROFILE || process.env.HOME || '', '.zcode', 'workspace', 'default');
if (!fs.existsSync(path.join(cwd, '.teamwork')) && fs.existsSync(path.join(defaultWs, '.teamwork'))) {
  cwd = defaultWs;
}

console.log(`Starting Teamwork Mission Control on ${cwd}...`);

function tick() {
  try {
    const engine = new TeamworkEngine({ cwd });
    const campaign = engine.load();
    const status = engine.status();
    const now = new Date().toLocaleTimeString();

    // ANSI escape codes for pure dark OLED styling
    const clearScreen = '\x1b[2J\x1b[3J\x1b[H';
    const bold = '\x1b[1m';
    const dim = '\x1b[2m';
    const green = '\x1b[32m';
    const cyan = '\x1b[36m';
    const reset = '\x1b[0m';
    const yellow = '\x1b[33m';

    const rendered = renderDashboard(campaign, { dispatchesCount: status?.dispatches ?? 0 });

    process.stdout.write(clearScreen);
    console.log(`${bold}${green}======================================================================${reset}`);
    console.log(`${bold}${green}   🌌 TEAMWORK MISSION CONTROL — LIVE BLACK MONITOR [${now}]${reset}`);
    console.log(`${dim}   Workspace: ${cwd}${reset}`);
    console.log(`${bold}${green}======================================================================${reset}\n`);

    console.log(rendered);

    // Read active file locks if any
    const ownershipPath = path.join(cwd, '.teamwork', 'ownership.json');
    if (fs.existsSync(ownershipPath)) {
      try {
        const locks = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
        const activeLocks = Object.entries(locks);
        if (activeLocks.length > 0) {
          console.log(`\n${bold}${yellow}🔒 Active File Exclusive Locks (${activeLocks.length}):${reset}`);
          for (const [file, info] of activeLocks) {
            console.log(`   - ${cyan}${file}${reset} -> held by [${info.owner || 'worker'}] (${info.expires_at || 'active'})`);
          }
        }
      } catch {}
    }

    console.log(`\n${dim}Press Ctrl+C to exit monitor. Auto-refreshing every 2s ...${reset}`);
  } catch (err) {
    console.error(`Error in monitor tick:`, err.message);
  }
}

// Initial tick and interval
tick();
setInterval(tick, 2000);
