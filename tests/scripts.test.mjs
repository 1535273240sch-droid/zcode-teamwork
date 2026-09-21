// Tests for teamwork CLI skeleton and core library functions.
// ASCII only.

import {execFileSync, spawnSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {charterHash, canonicalJson, sortKeysDeep} from '../plugins/teamwork/scripts/lib/utils.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'plugins', 'teamwork', 'scripts', 'teamwork.mjs');

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

console.log('=== teamwork.mjs CLI skeleton ===');

// 1. No arguments prints usage and exits 2
const noArgs = spawnSync(process.execPath, [CLI], {encoding: 'utf8'});
check('no args exits with code 2', noArgs.status === 2, `exit code: ${noArgs.status}`);
check('no args prints usage to stderr', noArgs.stderr.includes('Usage: teamwork.mjs'), noArgs.stderr);

// 2. Unknown subcommand exits with code 2
const unknownSub = spawnSync(process.execPath, [CLI, 'unknown-xyz'], {encoding: 'utf8'});
check('unknown subcommand exits with code 2', unknownSub.status === 2, `exit code: ${unknownSub.status}`);
check('unknown subcommand reports error', unknownSub.stderr.includes('Unknown subcommand'), unknownSub.stderr);

console.log('\\n=== charterHash and canonicalJson ===');

const charter1 = {
  objective: 'Build something solid',
  integrity_mode: 'development',
  pattern: 'iterative-coding',
  working_directory: 'C:/test',
  requirements: ['fast', 'clean'],
  out_of_scope: ['ui'],
  verification_method: 'npm test',
  acceptance_criteria: ['tests pass'],
  ownership_lease_minutes: 10,
  approved: false, // Should NOT be in charterHash
  phase: 'scoping', // Should NOT be in charterHash
};

// Reorder fields
const charter2 = {
  ownership_lease_minutes: 10,
  acceptance_criteria: ['tests pass'],
  verification_method: 'npm test',
  out_of_scope: ['ui'],
  requirements: ['fast', 'clean'],
  working_directory: 'C:/test',
  pattern: 'iterative-coding',
  integrity_mode: 'development',
  objective: 'Build something solid',
  approved: true, // changed approved
  phase: 'execution', // changed phase
};

const hash1 = charterHash(charter1);
const hash2 = charterHash(charter2);

check('charterHash is insensitive to field order and ignores approved/phase', hash1 === hash2, `${hash1} vs ${hash2}`);

const charterModified = {
  ...charter1,
  objective: 'Build something different',
};
const hashModified = charterHash(charterModified);
check('charterHash is sensitive to field values', hash1 !== hashModified, `${hash1} vs ${hashModified}`);

console.log(`\\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
