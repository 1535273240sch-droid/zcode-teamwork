// Teamwork - common CLI utilities and canonical operations.
// ASCII only: this file is a protocol artifact.

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const CHARTER_HASH_FIELDS = [
  'objective',
  'integrity_mode',
  'pattern',
  'working_directory',
  'requirements',
  'out_of_scope',
  'verification_method',
  'acceptance_criteria',
  'ownership_lease_minutes',
];

export function sortKeysDeep(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(sortKeysDeep);
  }
  const sorted = {};
  const keys = Object.keys(val).sort();
  for (const k of keys) {
    sorted[k] = sortKeysDeep(val[k]);
  }
  return sorted;
}

export function canonicalJson(val) {
  return JSON.stringify(sortKeysDeep(val));
}

export function sha256Hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function charterHash(charter) {
  if (!charter || typeof charter !== 'object') return '';
  const obj = {};
  for (const f of CHARTER_HASH_FIELDS) {
    if (f in charter) {
      obj[f] = charter[f];
    }
  }
  return sha256Hex(canonicalJson(obj));
}

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
