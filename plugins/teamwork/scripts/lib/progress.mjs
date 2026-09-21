// Teamwork - progress heartbeat and status snapshot management.
// ASCII only: this file is a protocol artifact.

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {findTeamworkDir, runGit, sha256Hex} from './utils.mjs';
import {writeAtomic, statePaths} from '../../hooks/_lib.mjs';

function parseOptions(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        opts[key] = args[i + 1];
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

function takeSnapshot(projectDir, paths) {
  let baseSha = null;
  if (existsSync(paths.approval)) {
    try {
      const approval = JSON.parse(readFileSync(paths.approval, 'utf8'));
      if (approval.base_sha) baseSha = approval.base_sha;
    } catch {}
  }

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

  const files = {};
  for (const f of changedFilesSet) {
    const norm = f.replace(/\\/g, '/');
    if (norm === '.teamwork' || norm.startsWith('.teamwork/')) continue;
    try {
      const full = join(projectDir, f);
      if (existsSync(full)) {
        const content = readFileSync(full);
        files[f] = sha256Hex(content);
      }
    } catch {}
  }

  return {
    ts: new Date().toISOString(),
    files,
  };
}

export function progressCommand(args) {
  if (args.length === 0) {
    console.error('Usage: teamwork.mjs progress <beat|set> ...');
    process.exit(2);
  }

  const action = args[0];
  const rest = args.slice(1);
  const opts = parseOptions(rest);

  const teamworkDir = findTeamworkDir(process.cwd());
  const projectDir = dirname(teamworkDir);
  const paths = statePaths(projectDir);
  const progressPath = join(teamworkDir, 'progress.json');

  let progress = {milestones: {}};
  if (existsSync(progressPath)) {
    try {
      progress = JSON.parse(readFileSync(progressPath, 'utf8'));
      if (!progress.milestones) progress.milestones = {};
    } catch {}
  }

  if (action === 'beat') {
    const milestone = opts.milestone;
    if (!milestone) {
      console.error('Usage: teamwork.mjs progress beat --milestone <id> [--note "<text>"]');
      process.exit(2);
    }

    if (!progress.milestones[milestone]) {
      progress.milestones[milestone] = {status: 'in-progress'};
    }

    const now = new Date().toISOString();
    progress.milestones[milestone].last_heartbeat = now;
    if (opts.note) {
      progress.milestones[milestone].note = String(opts.note);
    }

    writeAtomic(progressPath, JSON.stringify(progress, null, 2) + '\n');
    console.log(`HEARTBEAT: milestone=${milestone} at=${now}`);
    process.exit(0);
  } else if (action === 'set') {
    const milestone = opts.milestone;
    const status = opts.status;
    if (!milestone || !['pending', 'in-progress', 'done'].includes(status)) {
      console.error('Usage: teamwork.mjs progress set --milestone <id> --status <pending|in-progress|done>');
      process.exit(2);
    }

    if (!progress.milestones[milestone]) {
      progress.milestones[milestone] = {};
    }

    progress.milestones[milestone].status = status;
    const now = new Date().toISOString();
    progress.milestones[milestone].last_heartbeat = now;

    if (status === 'in-progress') {
      progress.milestones[milestone].start_snapshot = takeSnapshot(projectDir, paths);
    } else if (status === 'done') {
      progress.milestones[milestone].end_snapshot = takeSnapshot(projectDir, paths);
    }

    writeAtomic(progressPath, JSON.stringify(progress, null, 2) + '\n');
    console.log(`STATUS: milestone=${milestone} status=${status}`);
    process.exit(0);
  } else {
    console.error(`Unknown progress action: ${action}`);
    process.exit(2);
  }
}
