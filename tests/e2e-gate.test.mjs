// End-to-end gate tests covering G1 to G12 scenarios.
// ASCII only: this file is a protocol artifact.

import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, utimesSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {charterHash, runGit} from '../plugins/teamwork/scripts/lib/utils.mjs';

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

console.log('=== E2E Gate Tests (G1-G12) ===');

function setupTestRepo(integrityMode = 'development') {
  const dir = mkdtempSync(join(tmpdir(), 'teamwork-gate-e2e-'));
  const twDir = join(dir, '.teamwork');
  mkdirSync(twDir, {recursive: true});

  runGit(['init'], dir);
  runGit(['config', 'user.name', 'Teamwork Gate Test'], dir);
  runGit(['config', 'user.email', 'gate@teamwork.local'], dir);

  // Initial commit
  mkdirSync(join(dir, 'src'), {recursive: true});
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const v = 1;\n', 'utf8');
  runGit(['add', '.'], dir);
  runGit(['commit', '-m', 'initial commit'], dir);
  const baseSha = runGit(['rev-parse', 'HEAD'], dir).stdout.trim();

  const charter = {
    objective: 'Complete E2E gate successfully',
    integrity_mode: integrityMode,
    pattern: 'self-verification',
    working_directory: dir,
    requirements: ['r1'],
    out_of_scope: ['o1'],
    verification_method: 'automated test',
    acceptance_criteria: ['test passes'],
    ownership_lease_minutes: 10,
    approved: true,
    phase: 'execution',
  };
  writeFileSync(join(twDir, 'campaign.json'), JSON.stringify(charter, null, 2), 'utf8');

  const approval = {
    charter_sha256: charterHash(charter),
    approved_at: new Date().toISOString(),
    base_sha: baseSha,
    source: 'user_prompt_hook',
  };
  writeFileSync(join(twDir, 'approval.json'), JSON.stringify(approval, null, 2), 'utf8');

  const plan = {
    sentinel: 'CLEARED',
    milestones: [
      {
        id: 'm1',
        deliverable: 'implement feature',
        files: ['src/main.ts'],
        verified_by: ['critic'],
        status: 'done',
        verified: true,
      },
    ],
    ownership: {'src/main.ts': 'm1'},
    shared_files: [],
  };
  writeFileSync(join(twDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

  // Produce valid evidence using run command
  const run1 = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, '-e', 'console.log("PASS")'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const ev1Match = /EVIDENCE-ID:\s*(ev-[^\s]+)/.exec(run1.stdout);
  const ev1 = ev1Match ? ev1Match[1] : '';

  const run2 = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, '-e', 'console.log("AUDIT")'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const ev2Match = /EVIDENCE-ID:\s*(ev-[^\s]+)/.exec(run2.stdout);
  const ev2 = ev2Match ? ev2Match[1] : '';

  // Record verification for m1
  spawnSync(
    process.execPath,
    [CLI, 'verify', '--milestone', 'm1', '--role', 'critic', '--verdict', 'SOUND', '--evidence', ev1, '--body', 'Looks good'],
    {cwd: dir, encoding: 'utf8'}
  );

  // Record final audit
  spawnSync(
    process.execPath,
    [CLI, 'final-audit', '--verdict', 'ACHIEVED', '--evidence', ev2, '--body', 'Goal achieved'],
    {cwd: dir, encoding: 'utf8'}
  );

  // Run ownership audit
  spawnSync(process.execPath, [CLI, 'audit-ownership'], {cwd: dir, encoding: 'utf8'});

  return {dir, twDir, charter, approval, plan, ev1, ev2};
}

// 1. Scenario 1: Complete and valid -> PASS
{
  const {dir} = setupTestRepo();
  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 1: complete valid campaign -> PASS', res.status === 0 && res.stdout.includes('TEAMWORK-GATE: PASS'), res.stdout + res.stderr);
  rmSync(dir, {recursive: true, force: true});
}

// 2. Scenario 2: Verification record has no evidence ID -> FAIL (G4/G5)
{
  const {dir, twDir} = setupTestRepo();
  const vPath = join(twDir, 'verifications', 'm1--critic.md');
  const badContent = ['---', 'milestone: m1', 'role: critic', 'verdict: SOUND', 'evidence: []', '---', '', 'no evidence'].join('\n');
  writeFileSync(vPath, badContent, 'utf8');

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 2: verification without evidence ID -> FAIL', res.status === 1 && res.stdout.includes('TEAMWORK-GATE: FAIL'));
  rmSync(dir, {recursive: true, force: true});
}

// 3. Scenario 3: Evidence log tampered -> FAIL (G5)
{
  const {dir, twDir} = setupTestRepo();
  const evDir = join(twDir, 'evidence');
  // Tamper with evidence log
  const evFiles = readdirSync(evDir);
  const evFile = join(evDir, evFiles[0]);
  const content = readFileSync(evFile, 'utf8');
  writeFileSync(evFile, content.replace('AUDIT', 'TAMPERED'), 'utf8');

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 3: tampered evidence log -> FAIL', res.status === 1 && res.stdout.includes('G5'));
  rmSync(dir, {recursive: true, force: true});
}

// 4. Scenario 4: Evidence timestamp earlier than file mtime -> FAIL (G6)
{
  const {dir} = setupTestRepo();
  // Modify src/main.ts mtime to future
  const futureTime = new Date(Date.now() + 100000);
  utimesSync(join(dir, 'src', 'main.ts'), futureTime, futureTime);

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 4: evidence older than file mtime -> FAIL', res.status === 1 && res.stdout.includes('G6'), `status=${res.status}, out=${res.stdout}, err=${res.stderr}`);
  rmSync(dir, {recursive: true, force: true});
}

// 5. Scenario 5: Missing final-audit.md -> FAIL (G8)
{
  const {dir, twDir} = setupTestRepo();
  rmSync(join(twDir, 'final-audit.md'), {force: true});

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 5: missing final-audit.md -> FAIL', res.status === 1 && res.stdout.includes('G8'));
  rmSync(dir, {recursive: true, force: true});
}

// 6. Scenario 6: Unauthorized file change (ownership audit failure) -> FAIL (G9)
{
  const {dir, twDir} = setupTestRepo();
  writeFileSync(join(twDir, 'ownership-audit.json'), JSON.stringify({result: 'FAIL', violations: [{rule: 'R1'}]}), 'utf8');

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 6: ownership audit FAIL -> FAIL', res.status === 1 && res.stdout.includes('G9'));
  rmSync(dir, {recursive: true, force: true});
}

// 7. Scenario 7: Charter modified after approval -> FAIL (G1)
{
  const {dir, twDir, charter} = setupTestRepo();
  charter.objective = 'Objective changed after human approved';
  writeFileSync(join(twDir, 'campaign.json'), JSON.stringify(charter, null, 2), 'utf8');

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 7: charter altered after approval -> FAIL', res.status === 1 && res.stdout.includes('G1'));
  rmSync(dir, {recursive: true, force: true});
}

// 8. Scenario 8: Non-git directory
// development mode -> PASS + WARN
{
  const {dir, twDir} = setupTestRepo('development');
  // Write SKIPPED_NO_GIT into ownership-audit.json
  writeFileSync(join(twDir, 'ownership-audit.json'), JSON.stringify({result: 'SKIPPED_NO_GIT', violations: []}), 'utf8');

  const resDev = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 8a: non-git directory in development mode -> PASS with warning', resDev.status === 0 && resDev.stdout.includes('WARNINGS') && resDev.stdout.includes('TEAMWORK-GATE: PASS'));

  // benchmark mode -> FAIL
  const camp = JSON.parse(readFileSync(join(twDir, 'campaign.json'), 'utf8'));
  camp.integrity_mode = 'benchmark';
  writeFileSync(join(twDir, 'campaign.json'), JSON.stringify(camp, null, 2), 'utf8');
  const app = JSON.parse(readFileSync(join(twDir, 'approval.json'), 'utf8'));
  app.charter_sha256 = charterHash(camp);
  writeFileSync(join(twDir, 'approval.json'), JSON.stringify(app, null, 2), 'utf8');

  const resBench = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 8b: non-git directory in benchmark mode -> FAIL', resBench.status === 1 && resBench.stdout.includes('TEAMWORK-GATE: FAIL'));

  rmSync(dir, {recursive: true, force: true});
}

// 9. Scenario 9: Stalled milestone in progress.json -> FAIL (G11)
{
  const {dir, twDir} = setupTestRepo();
  const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // 40m ago, default threshold 30m
  writeFileSync(
    join(twDir, 'progress.json'),
    JSON.stringify({
      milestones: {
        m1: {
          status: 'in-progress',
          last_heartbeat: staleTime,
        },
      },
    }),
    'utf8'
  );

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 9: stalled milestone -> FAIL (G11)', res.status === 1 && res.stdout.includes('G11'));
  rmSync(dir, {recursive: true, force: true});
}

// 10. Scenario 10: risk: "medium" missing auditor -> FAIL (G10)
{
  const {dir, twDir, plan} = setupTestRepo();
  plan.milestones[0].risk = 'medium';
  // verified_by is only ['critic']
  writeFileSync(join(twDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 10: risk medium missing auditor -> FAIL (G10)', res.status === 1 && res.stdout.includes('G10'));
  rmSync(dir, {recursive: true, force: true});
}

// 11. Scenario 11: risk: "medium" with critic + auditor -> PASS
{
  const {dir, twDir, plan, ev1} = setupTestRepo();
  plan.milestones[0].risk = 'medium';
  plan.milestones[0].verified_by = ['critic', 'auditor'];
  writeFileSync(join(twDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

  // Also record auditor verification
  spawnSync(
    process.execPath,
    [CLI, 'verify', '--milestone', 'm1', '--role', 'auditor', '--verdict', 'REPRODUCED', '--evidence', ev1, '--body', 'reproduced cleanly'],
    {cwd: dir, encoding: 'utf8'}
  );

  const res = spawnSync(process.execPath, [CLI, 'gate'], {cwd: dir, encoding: 'utf8'});
  check('Scenario 11: risk medium with critic + auditor -> PASS', res.status === 0 && res.stdout.includes('TEAMWORK-GATE: PASS'));
  rmSync(dir, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
