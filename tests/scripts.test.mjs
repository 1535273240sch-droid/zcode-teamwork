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

console.log('\n=== T2: teamwork.mjs run, verify, final-audit and hash chain ===');

import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {verifyEvidenceChain} from '../plugins/teamwork/scripts/lib/evidence.mjs';

const testDir = mkdtempSync(join(tmpdir(), 'teamwork-t2-test-'));
const teamworkDir = join(testDir, '.teamwork');
mkdirSync(teamworkDir, {recursive: true});
// write a dummy campaign
writeFileSync(
  join(teamworkDir, 'campaign.json'),
  JSON.stringify({
    objective: 'Test T2',
    approved: true,
    phase: 'execution',
  }),
  'utf8'
);

// 1. run command with exit code 3
const runFail = spawnSync(
  process.execPath,
  [CLI, 'run', '--', process.execPath, '-e', 'process.exit(3)'],
  {
    cwd: testDir,
    encoding: 'utf8',
  }
);
check('run executes command and preserves exit code 3', runFail.status === 3, `exit code: ${runFail.status}`);
const evMatch = /EVIDENCE-ID:\s*(ev-[^\s]+)/.exec(runFail.stdout);
check('run prints EVIDENCE-ID on stdout', Boolean(evMatch), runFail.stdout);
const evId1 = evMatch ? evMatch[1] : null;

// 2. run command with success
const runSuccess = spawnSync(
  process.execPath,
  [CLI, 'run', '--label', 'test-label', '--', process.execPath, '-e', 'console.log("hello world")'],
  {
    cwd: testDir,
    encoding: 'utf8',
  }
);
check('run success exits 0', runSuccess.status === 0, `exit code: ${runSuccess.status}`);
const evMatch2 = /EVIDENCE-ID:\s*(ev-[^\s]+)/.exec(runSuccess.stdout);
const evId2 = evMatch2 ? evMatch2[1] : null;
check('run prints second EVIDENCE-ID', Boolean(evId2), runSuccess.stdout);

// 3. check evidence directory and hash chain
const evidenceDir = join(teamworkDir, 'evidence');
const chainCheck1 = verifyEvidenceChain(evidenceDir);
check('evidence chain is valid after 2 runs', chainCheck1.valid && chainCheck1.total === 2, `errors: ${JSON.stringify(chainCheck1.errors)}`);

// 4. verify with non-existent evidence id fails and does not write file
const verifyBad = spawnSync(
  process.execPath,
  [CLI, 'verify', '--milestone', 'm1', '--role', 'critic', '--verdict', 'SOUND', '--evidence', 'ev-nonexistent'],
  {
    cwd: testDir,
    encoding: 'utf8',
  }
);
check('verify with non-existent evidence exits 1', verifyBad.status === 1, `status: ${verifyBad.status}`);
check('verify does not write file on error', !existsSync(join(teamworkDir, 'verifications', 'm1--critic.md')));

// 5. verify with valid evidence succeeds
const verifyGood = spawnSync(
  process.execPath,
  [CLI, 'verify', '--milestone', 'm1', '--role', 'critic', '--verdict', 'SOUND', '--evidence', evId2, '--body', 'All sound.'],
  {
    cwd: testDir,
    encoding: 'utf8',
  }
);
check('verify with valid evidence exits 0', verifyGood.status === 0, `status: ${verifyGood.status}, stderr: ${verifyGood.stderr}`);
const verifyFile = join(teamworkDir, 'verifications', 'm1--critic.md');
check('verification file was written', existsSync(verifyFile));

// 6. repeat verify moves old file to superseded
const verifyOverwrite = spawnSync(
  process.execPath,
  [CLI, 'verify', '--milestone', 'm1', '--role', 'critic', '--verdict', 'SOUND', '--evidence', evId2, '--body', 'All sound round 2.'],
  {
    cwd: testDir,
    encoding: 'utf8',
  }
);
check('second verify exits 0', verifyOverwrite.status === 0);
const supersededDir = join(teamworkDir, 'verifications', 'superseded');
const supersededFiles = existsSync(supersededDir) ? readdirSync(supersededDir) : [];
check('superseded file was preserved', supersededFiles.length >= 1, `count: ${supersededFiles.length}`);

// 7. final-audit with valid evidence
const finalAudit = spawnSync(
  process.execPath,
  [CLI, 'final-audit', '--verdict', 'ACHIEVED', '--evidence', evId2, '--body', 'Objective met.'],
  {
    cwd: testDir,
    encoding: 'utf8',
  }
);
check('final-audit exits 0', finalAudit.status === 0, `status: ${finalAudit.status}`);
check('final-audit.md was written', existsSync(join(teamworkDir, 'final-audit.md')));

// 8. tamper with evidence log and verify chain fails
const evFiles = readdirSync(evidenceDir).filter((f) => f.endsWith('.jsonl'));
const evFilePath = join(evidenceDir, evFiles[0]);
const evContent = readFileSync(evFilePath, 'utf8');
const lines = evContent.split('\n').filter(Boolean);
const parsed0 = JSON.parse(lines[0]);
parsed0.cmd = 'tampered command'; // modify command without updating hash
lines[0] = JSON.stringify(parsed0);
writeFileSync(evFilePath, lines.join('\n') + '\n', 'utf8');

const tamperedChain = verifyEvidenceChain(evidenceDir);
check('tampered evidence chain is detected as invalid', !tamperedChain.valid, `valid: ${tamperedChain.valid}`);

// 9. 12 concurrent run processes with mutex and barrier
import {spawn} from 'node:child_process';
const concurrentDir = mkdtempSync(join(tmpdir(), 'teamwork-concurrent-'));
const concurrentTeamwork = join(concurrentDir, '.teamwork');
mkdirSync(concurrentTeamwork, {recursive: true});
writeFileSync(
  join(concurrentTeamwork, 'campaign.json'),
  JSON.stringify({
    objective: 'Test Concurrency',
    approved: true,
    phase: 'execution',
  }),
  'utf8'
);

const barrier = join(concurrentDir, 'barrier.txt');
const workerScript = join(concurrentDir, 'worker.mjs');
writeFileSync(
  workerScript,
  `import {existsSync} from 'node:fs';
while (!existsSync(process.argv[2])) {}
console.log('worker ' + process.argv[3]);
`,
  'utf8'
);

const numWorkers = 12;
const promises = [];

for (let i = 0; i < numWorkers; i++) {
  promises.push(
    new Promise((resolveProc) => {
      const child = spawn(
        process.execPath,
        [CLI, 'run', '--', process.execPath, workerScript, barrier, String(i)],
        {
          cwd: concurrentDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('close', (code) => {
        resolveProc({code, out});
      });
    })
  );
}

// Give processes a small moment to initialize and wait at barrier
await new Promise((r) => setTimeout(r, 200));
writeFileSync(barrier, 'GO', 'utf8');

const results = await Promise.all(promises);
const allSucceeded = results.every((r) => r.code === 0);
check('all 12 concurrent runs exited 0', allSucceeded, `some non-zero exits`);

const concurrentChain = verifyEvidenceChain(join(concurrentTeamwork, 'evidence'));
check('concurrent evidence chain has 12 entries and is valid', concurrentChain.valid && concurrentChain.total === 12, `valid: ${concurrentChain.valid}, total: ${concurrentChain.total}, errors: ${JSON.stringify(concurrentChain.errors)}`);

// Clean up test directories
rmSync(testDir, {recursive: true, force: true});
rmSync(concurrentDir, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
