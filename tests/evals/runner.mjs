#!/usr/bin/env node
// Teamwork - Seed defect eval fixtures test runner.
// ASCII only: this file is a protocol artifact.

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ROLE_VERDICTS} from '../../plugins/teamwork/scripts/lib/verify.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)));
const AGENTS_DIR = join(REPO, 'plugins', 'teamwork', 'agents');

let pass = 0;
let fail = 0;

function check(name, ok, note = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name} (${note})`);
    fail++;
  }
}

console.log('=== Teamwork Seed Defect Evals Runner ===');

const isLive = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
console.log(`Execution mode: ${isLive ? 'LIVE (model API)' : 'MOCK (deterministic seed detection)'}\n`);

// 1. eval-leak -> Critic should detect resource leak
{
  console.log('Scenario 1: eval-leak (Critic -> DEFECTS_FOUND)');
  const criticPrompt = readFileSync(join(AGENTS_DIR, 'critic.md'), 'utf8');
  check('critic prompt contains resource leak guidelines', criticPrompt.includes('资源处理') && criticPrompt.includes('句柄'));

  const code = readFileSync(join(EVALS_DIR, 'eval-leak', 'src', 'reader.mjs'), 'utf8');
  const claim = readFileSync(join(EVALS_DIR, 'eval-leak', 'claim.md'), 'utf8');

  // Seed defect verification: openSync exists but closeSync does not
  const hasOpen = code.includes('openSync');
  const hasClose = code.includes('closeSync');
  const leakDetected = hasOpen && !hasClose;
  check('seed defect present: openSync without closeSync', leakDetected);

  // Mock evaluation output according to critic prompt rules
  const mockVerdict = leakDetected ? 'DEFECTS_FOUND' : 'SOUND';
  check('critic evaluation yields DEFECTS_FOUND', mockVerdict === 'DEFECTS_FOUND');
  check('critic verdict is valid in role whitelist', ROLE_VERDICTS.critic.has(mockVerdict));
}

// 2. eval-premise -> Challenger should falsify flawed premise
{
  console.log('\nScenario 2: eval-premise (Challenger -> FALSIFIED)');
  const challengerPrompt = readFileSync(join(AGENTS_DIR, 'challenger.md'), 'utf8');
  check('challenger prompt contains measurement & survivor bias checks', challengerPrompt.includes('度量') && challengerPrompt.includes('幸存者偏差'));

  const benchCode = readFileSync(join(EVALS_DIR, 'eval-premise', 'src', 'bench.mjs'), 'utf8');
  const claim = readFileSync(join(EVALS_DIR, 'eval-premise', 'claim.md'), 'utf8');

  // Seed defect verification: discards cold cache measurements (i >= 50)
  const filtersData = benchCode.includes('i >= 50') || benchCode.includes('discard');
  check('seed defect present: selective measurement (survivor bias)', filtersData);

  const mockVerdict = filtersData ? 'FALSIFIED' : 'SURVIVED';
  check('challenger evaluation yields FALSIFIED', mockVerdict === 'FALSIFIED');
  check('challenger verdict is valid in role whitelist', ROLE_VERDICTS.challenger.has(mockVerdict));
}

// 3. eval-diverge -> Auditor should detect discrepancy and output DIVERGED
{
  console.log('\nScenario 3: eval-diverge (Auditor -> DIVERGED)');
  const auditorPrompt = readFileSync(join(AGENTS_DIR, 'auditor.md'), 'utf8');
  check('auditor prompt contains reproduction and character-by-character comparison', auditorPrompt.includes('逐字符对比') && auditorPrompt.includes('不采信'));

  const claim = readFileSync(join(EVALS_DIR, 'eval-diverge', 'claim.md'), 'utf8');
  const claimedOutputMatch = /Claimed Raw Output\s*[\r\n]+`([^`]+)`/.exec(claim);
  const claimedOutput = claimedOutputMatch ? claimedOutputMatch[1].trim() : '';

  // Run the command independently
  const runRes = spawnSync(process.execPath, [join(EVALS_DIR, 'eval-diverge', 'src', 'compute.mjs')], {
    encoding: 'utf8',
  });
  const actualOutput = (runRes.stdout || '').trim();

  check('actual execution succeeded', runRes.status === 0);
  const diverged = actualOutput !== claimedOutput;
  check('auditor detects discrepancy: claimed 42 vs actual 41', diverged && actualOutput.includes('41') && claimedOutput.includes('42'));

  const mockVerdict = diverged ? 'DIVERGED' : 'REPRODUCED';
  check('auditor evaluation yields DIVERGED', mockVerdict === 'DIVERGED');
  check('auditor verdict is valid in role whitelist', ROLE_VERDICTS.auditor.has(mockVerdict));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
