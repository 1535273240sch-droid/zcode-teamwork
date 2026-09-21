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
  getGitExecutable,
  runGit,
  getGitInfo,
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
