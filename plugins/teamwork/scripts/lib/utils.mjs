// Teamwork - common CLI utilities and canonical operations.
// ASCII only: this file is a protocol artifact.

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export {
  CHARTER_HASH_FIELDS,
  sortKeysDeep,
  canonicalJson,
  sha256Hex,
  charterHash,
} from '../../hooks/_lib.mjs';

export function findTeamworkDir(startDir = process.cwd()) {
  if (process.env.TEAMWORK_DIR) {
    const custom = resolve(process.env.TEAMWORK_DIR);
    if (existsSync(join(custom, 'campaign.json'))) {
      return custom;
    }
    if (existsSync(join(custom, '.teamwork', 'campaign.json'))) {
      return join(custom, '.teamwork');
    }
    return custom;
  }

  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, '.teamwork');
    if (existsSync(join(candidate, 'campaign.json'))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return join(resolve(startDir), '.teamwork');
}

export function runGit(args, cwd = process.cwd()) {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.error) {
      return {ok: false, stdout: '', stderr: String(res.error.message), code: res.status ?? 1};
    }
    return {
      ok: res.status === 0,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      code: res.status ?? 0,
    };
  } catch (err) {
    return {ok: false, stdout: '', stderr: String(err), code: 1};
  }
}

export function getGitInfo(cwd = process.cwd()) {
  const headRes = runGit(['rev-parse', 'HEAD'], cwd);
  const head = headRes.ok ? headRes.stdout.trim() : null;
  const statusRes = runGit(['status', '--porcelain'], cwd);
  const dirty = statusRes.ok ? statusRes.stdout.trim().length > 0 : false;
  return {head, dirty, hasGit: headRes.ok};
}
