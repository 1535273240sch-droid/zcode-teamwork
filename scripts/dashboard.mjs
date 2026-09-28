#!/usr/bin/env node
// Teamwork - One-off Visual Dashboard CLI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const libPath = path.join(REPO_ROOT, 'plugins', 'teamwork', 'lib');
const { TeamworkEngine } = await import(`file://${path.join(libPath, 'engine.mjs').split(path.sep).join('/')}`);
const { renderDashboard } = await import(`file://${path.join(libPath, 'dashboard.mjs').split(path.sep).join('/')}`);

let cwd = process.argv[2] || process.cwd();
const defaultWs = path.join(process.env.USERPROFILE || process.env.HOME || '', '.zcode', 'workspace', 'default');
if (!fs.existsSync(path.join(cwd, '.teamwork')) && fs.existsSync(path.join(defaultWs, '.teamwork'))) {
  cwd = defaultWs;
}

const engine = new TeamworkEngine({ cwd });
const campaign = engine.load();
const status = engine.status();
const rendered = renderDashboard(campaign, { dispatchesCount: status?.dispatches ?? 0 });

console.log(rendered);
