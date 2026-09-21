// Teamwork - deterministic ownership audit.
// ASCII only: this file is a protocol artifact.

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname, sep} from 'node:path';
import {findTeamworkDir, getGitInfo, runGit} from './utils.mjs';
import {writeAtomic, lockKey, statePaths} from '../../hooks/_lib.mjs';

function isSharedFile(file, sharedFiles, cwd) {
  const fKey = lockKey(file, cwd);
  for (const s of sharedFiles) {
    if (s.endsWith('/') || s.endsWith('\\')) {
      const normDir = lockKey(s, cwd);
      const prefix = normDir.endsWith(sep) ? normDir : normDir + sep;
      if (fKey === normDir || fKey.startsWith(prefix)) return true;
    } else {
      if (fKey === lockKey(s, cwd)) return true;
    }
  }
  return false;
}

function findMilestonesForFile(file, milestones, ownership, cwd) {
  const fKey = lockKey(file, cwd);
  const matched = [];
  for (const m of milestones) {
    const files = Array.isArray(m.files) ? m.files : [];
    if (files.some((mf) => lockKey(mf, cwd) === fKey)) {
      matched.push(m);
    }
  }
  for (const [ownFile, mId] of Object.entries(ownership)) {
    if (lockKey(ownFile, cwd) === fKey) {
      if (!matched.some((m) => m.id === mId)) {
        const found = milestones.find((m) => m.id === mId);
        if (found) matched.push(found);
        else matched.push({id: mId, status: 'unknown'});
      }
    }
  }
  return matched;
}

export function auditOwnershipCommand(args) {
  const teamworkDir = findTeamworkDir(process.cwd());
  const projectDir = dirname(teamworkDir);
  const paths = statePaths(projectDir);

  const git = getGitInfo(projectDir);
  if (!git.isGit) {
    const audit = {
      result: 'SKIPPED_NO_GIT',
      checked_at: new Date().toISOString(),
      base_sha: null,
      violations: [],
    };
    writeAtomic(paths.ownershipAudit, JSON.stringify(audit, null, 2) + '\n');
    console.log('OWNERSHIP AUDIT: SKIPPED_NO_GIT (not a git repository)');
    process.exit(0);
  }

  let baseSha = null;
  if (existsSync(paths.approval)) {
    try {
      const approval = JSON.parse(readFileSync(paths.approval, 'utf8'));
      if (typeof approval.base_sha === 'string' && approval.base_sha.length > 0) {
        baseSha = approval.base_sha;
      }
    } catch {}
  }

  // Collect modified and untracked files
  const changedFilesSet = new Set();

  if (baseSha) {
    const diffRes = runGit(['diff', '--name-only', baseSha], projectDir);
    if (diffRes.ok && diffRes.stdout) {
      for (const line of diffRes.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) changedFilesSet.add(trimmed);
      }
    }
  } else {
    // If no base_sha recorded, compare against HEAD
    const diffRes = runGit(['diff', '--name-only', 'HEAD'], projectDir);
    if (diffRes.ok && diffRes.stdout) {
      for (const line of diffRes.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) changedFilesSet.add(trimmed);
      }
    }
  }

  const untrackedRes = runGit(['ls-files', '-o', '--exclude-standard'], projectDir);
  if (untrackedRes.ok && untrackedRes.stdout) {
    for (const line of untrackedRes.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) changedFilesSet.add(trimmed);
    }
  }

  // Filter out .teamwork/**
  const changedFiles = [];
  for (const f of changedFilesSet) {
    const norm = f.replace(/\\/g, '/');
    if (norm === '.teamwork' || norm.startsWith('.teamwork/')) continue;
    changedFiles.push(f);
  }

  let plan = {milestones: [], ownership: {}, shared_files: []};
  if (existsSync(paths.plan)) {
    try {
      plan = JSON.parse(readFileSync(paths.plan, 'utf8'));
    } catch (err) {
      console.error('Error: failed to parse plan.json: ' + err.message);
      process.exit(1);
    }
  }

  const sharedFiles = Array.isArray(plan.shared_files) ? plan.shared_files : [];
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  const ownership = plan.ownership && typeof plan.ownership === 'object' ? plan.ownership : {};

  const violations = [];

  // R1 and R2 checks
  for (const file of changedFiles) {
    if (isSharedFile(file, sharedFiles, projectDir)) {
      continue;
    }
    const matched = findMilestonesForFile(file, milestones, ownership, projectDir);
    if (matched.length === 0) {
      violations.push({
        file,
        rule: 'R1',
        detail: `File ${file} does not belong to any milestone and is not in shared_files`,
      });
    } else {
      for (const m of matched) {
        if (m.status === 'pending') {
          violations.push({
            file,
            rule: 'R2',
            detail: `File ${file} belongs to pending milestone ${m.id}`,
          });
        }
      }
    }
  }

  // R3 check: only enabled when mode.json.max_parallel === 1
  let isSerial = false;
  if (existsSync(paths.mode)) {
    try {
      const modeData = JSON.parse(readFileSync(paths.mode, 'utf8'));
      if (modeData.max_parallel === 1) {
        isSerial = true;
      }
    } catch {}
  }

  const progressPath = join(teamworkDir, 'progress.json');
  if (isSerial && existsSync(progressPath)) {
    try {
      const prog = JSON.parse(readFileSync(progressPath, 'utf8'));
      const progMilestones = prog.milestones || {};
      for (const [mId, mData] of Object.entries(progMilestones)) {
        const startFiles = mData.start_snapshot?.files || {};
        const endFiles = mData.end_snapshot?.files || {};

        const mObj = milestones.find((m) => m.id === mId);
        const mFiles = mObj && Array.isArray(mObj.files) ? mObj.files : [];

        for (const [f, endHash] of Object.entries(endFiles)) {
          const startHash = startFiles[f];
          if (startHash !== endHash) {
            // File changed during milestone mId
            if (isSharedFile(f, sharedFiles, projectDir)) continue;
            const belongs = mFiles.some(
              (mf) => lockKey(mf, projectDir) === lockKey(f, projectDir)
            );
            if (!belongs) {
              violations.push({
                file: f,
                rule: 'R3',
                detail: `File ${f} was modified during milestone ${mId} but is not in ${mId}.files`,
              });
            }
          }
        }
      }
    } catch {}
  }

  const result = violations.length === 0 ? 'PASS' : 'FAIL';
  const auditReport = {
    result,
    checked_at: new Date().toISOString(),
    base_sha: baseSha,
    violations,
  };

  writeAtomic(paths.ownershipAudit, JSON.stringify(auditReport, null, 2) + '\n');

  if (result === 'PASS') {
    console.log('OWNERSHIP AUDIT: PASS');
    process.exit(0);
  } else {
    console.error(`OWNERSHIP AUDIT: FAIL (${violations.length} violations)`);
    for (const v of violations) {
      console.error(`  - [${v.rule}] ${v.file}: ${v.detail}`);
    }
    process.exit(1);
  }
}
