// Teamwork - evidence log and hash chain implementation.
// ASCII only: this file is a protocol artifact.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {canonicalJson, sha256Hex, findTeamworkDir} from './utils.mjs';
import {acquireMutex, releaseMutex, statePaths} from '../../hooks/_lib.mjs';

export const ZERO_HASH = '0'.repeat(64);
const TAIL_MAX_BYTES = 32768; // 32KB

export function generateEvidenceId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  const rand = randomBytes(2).toString('hex');
  return `ev-${y}${m}${d}T${hh}${mm}${ss}Z-${rand}`;
}

export function getEvidenceFiles(evidenceDir) {
  if (!existsSync(evidenceDir)) return [];
  try {
    return readdirSync(evidenceDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }
}

export function getLastEvidenceHash(evidenceDir) {
  const files = getEvidenceFiles(evidenceDir);
  if (files.length === 0) return ZERO_HASH;

  for (let i = files.length - 1; i >= 0; i--) {
    const filePath = join(evidenceDir, files[i]);
    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        const parsed = JSON.parse(lastLine);
        if (parsed && typeof parsed.hash === 'string') {
          return parsed.hash;
        }
      }
    } catch {
      // Continue searching backwards
    }
  }
  return ZERO_HASH;
}

export function appendEvidenceLog(cwd, recordData) {
  const stateDir = findTeamworkDir(cwd);
  const evidenceDir = join(stateDir, 'evidence');
  mkdirSync(evidenceDir, {recursive: true});

  const paths = statePaths(cwd);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const dateFile = `${y}-${m}-${d}.jsonl`;
  const filePath = join(evidenceDir, dateFile);

  const locked = acquireMutex(paths);
  try {
    const prevHash = getLastEvidenceHash(evidenceDir);
    const entryWithoutHash = {
      ...recordData,
      prev_hash: prevHash,
    };
    delete entryWithoutHash.hash;

    const hash = sha256Hex(prevHash + canonicalJson(entryWithoutHash));
    const finalEntry = {
      ...entryWithoutHash,
      hash,
    };

    appendFileSync(filePath, JSON.stringify(finalEntry) + '\n', 'utf8');
    return finalEntry;
  } finally {
    if (locked) {
      releaseMutex(paths);
    }
  }
}

export function verifyEvidenceChain(evidenceDir) {
  const files = getEvidenceFiles(evidenceDir);
  if (files.length === 0) {
    return {valid: true, total: 0, errors: []};
  }

  let expectedPrevHash = ZERO_HASH;
  let total = 0;
  const errors = [];

  for (const file of files) {
    const fullPath = join(evidenceDir, file);
    let content = '';
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch (err) {
      errors.push({file, error: `Unreadable file: ${err.message}`});
      continue;
    }

    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    for (let idx = 0; idx < lines.length; idx++) {
      total++;
      const lineStr = lines[idx];
      let entry;
      try {
        entry = JSON.parse(lineStr);
      } catch (err) {
        errors.push({file, line: idx + 1, error: `Malformed JSON: ${err.message}`});
        continue;
      }

      if (!entry || typeof entry !== 'object') {
        errors.push({file, line: idx + 1, error: 'Not a JSON object'});
        continue;
      }

      if (entry.prev_hash !== expectedPrevHash) {
        errors.push({
          file,
          line: idx + 1,
          id: entry.id,
          error: `Broken chain: expected prev_hash ${expectedPrevHash}, got ${entry.prev_hash}`,
        });
      }

      const recordedHash = entry.hash;
      const copy = {...entry};
      delete copy.hash;
      const computedHash = sha256Hex(entry.prev_hash + canonicalJson(copy));
      if (recordedHash !== computedHash) {
        errors.push({
          file,
          line: idx + 1,
          id: entry.id,
          error: `Tampered record: computed hash ${computedHash}, got ${recordedHash}`,
        });
      }

      expectedPrevHash = recordedHash;
    }
  }

  return {valid: errors.length === 0, total, errors};
}

export function findEvidenceById(evidenceDir, id) {
  const files = getEvidenceFiles(evidenceDir);
  for (const file of files) {
    const fullPath = join(evidenceDir, file);
    try {
      const content = readFileSync(fullPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        if (!line.includes(id)) continue;
        const entry = JSON.parse(line);
        if (entry.id === id) {
          return entry;
        }
      }
    } catch {
      // Continue
    }
  }
  return null;
}
