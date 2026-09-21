// Teamwork - verification and final-audit recording.
// ASCII only: this file is a protocol artifact.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from 'node:fs';
import {join, resolve} from 'node:path';
import {findTeamworkDir} from './utils.mjs';
import {findEvidenceById} from './evidence.mjs';

export const ALLOWED_ROLES = new Set([
  'critic',
  'challenger',
  'auditor',
  'success-auditor',
]);

export const ROLE_VERDICTS = {
  critic: new Set(['SOUND', 'DEFECTS_FOUND']),
  challenger: new Set(['SURVIVED', 'FALSIFIED', 'UNFALSIFIABLE']),
  auditor: new Set(['REPRODUCED', 'DIVERGED', 'BLOCKED']),
  'success-auditor': new Set(['ACHIEVED', 'PARTIALLY ACHIEVED', 'NOT ACHIEVED']),
};

export const PASSING_VERDICTS = new Set([
  'SOUND',
  'SURVIVED',
  'REPRODUCED',
  'ACHIEVED',
]);

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

function resolveBody(opts) {
  if (opts['body-file']) {
    try {
      return readFileSync(resolve(opts['body-file']), 'utf8');
    } catch (err) {
      process.stderr.write(`Error reading body file: ${err.message}\n`);
      process.exit(2);
    }
  }
  if (typeof opts.body === 'string') {
    return opts.body;
  }
  return '';
}

export async function verifyCommand(args) {
  const opts = parseOptions(args);
  const milestone = opts.milestone;
  const role = opts.role;
  const verdict = opts.verdict;
  const evidenceStr = opts.evidence;

  if (!milestone || !role || !verdict) {
    process.stderr.write(
      'Usage: teamwork.mjs verify --milestone <id> --role <role> --verdict <verdict> --evidence <id,id,...> [--body <text> | --body-file <path>]\n'
    );
    process.exit(2);
  }

  if (!ALLOWED_ROLES.has(role)) {
    process.stderr.write(
      `Rule violation: role "${role}" is not in the verifier whitelist: ${[...ALLOWED_ROLES].join(', ')}\n`
    );
    process.exit(1);
  }

  const allowedVerdicts = ROLE_VERDICTS[role];
  if (!allowedVerdicts.has(verdict)) {
    process.stderr.write(
      `Rule violation: verdict "${verdict}" is not valid for role "${role}". Allowed: ${[...allowedVerdicts].join(', ')}\n`
    );
    process.exit(1);
  }

  const evidenceIds = evidenceStr
    ? evidenceStr.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const body = resolveBody(opts);

  if (evidenceIds.length === 0) {
    if (verdict !== 'BLOCKED' && verdict !== 'UNFALSIFIABLE') {
      process.stderr.write(
        `Rule violation: at least 1 evidence ID is required for verdict "${verdict}".\n`
      );
      process.exit(1);
    }
    if (!body || body.trim().length === 0) {
      process.stderr.write(
        `Rule violation: body explaining the reason is required when no evidence is attached for "${verdict}".\n`
      );
      process.exit(1);
    }
  }

  const stateDir = findTeamworkDir(process.cwd());
  const evidenceDir = join(stateDir, 'evidence');

  for (const evId of evidenceIds) {
    const entry = findEvidenceById(evidenceDir, evId);
    if (!entry) {
      process.stderr.write(
        `Rule violation: evidence ID "${evId}" not found in evidence logs (.teamwork/evidence/**).\n`
      );
      process.exit(1);
    }
  }

  const verificationsDir = join(stateDir, 'verifications');
  const supersededDir = join(verificationsDir, 'superseded');
  mkdirSync(verificationsDir, {recursive: true});

  const fileName = `${milestone}--${role}.md`;
  const targetPath = join(verificationsDir, fileName);

  if (existsSync(targetPath)) {
    mkdirSync(supersededDir, {recursive: true});
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${milestone}--${role}--${ts}.md`;
    renameSync(targetPath, join(supersededDir, backupName));
  }

  const recordedAt = new Date().toISOString();
  const frontmatter = [
    '---',
    `milestone: ${milestone}`,
    `role: ${role}`,
    `verdict: ${verdict}`,
    `evidence: [${evidenceIds.join(', ')}]`,
    `recorded_at: ${recordedAt}`,
    '---',
    '',
    body,
  ].join('\n');

  writeFileSync(targetPath, frontmatter, 'utf8');
  process.stdout.write(`Verification recorded at: .teamwork/verifications/${fileName}\n`);
  process.exit(0);
}

export async function finalAuditCommand(args) {
  const opts = parseOptions(args);
  const role = 'success-auditor';
  const verdict = opts.verdict;
  const evidenceStr = opts.evidence;

  if (!verdict) {
    process.stderr.write(
      'Usage: teamwork.mjs final-audit --verdict <ACHIEVED|PARTIALLY ACHIEVED|NOT ACHIEVED> --evidence <ids> [--body <text> | --body-file <path>]\n'
    );
    process.exit(2);
  }

  const allowedVerdicts = ROLE_VERDICTS[role];
  if (!allowedVerdicts.has(verdict)) {
    process.stderr.write(
      `Rule violation: verdict "${verdict}" is not valid for final audit. Allowed: ${[...allowedVerdicts].join(', ')}\n`
    );
    process.exit(1);
  }

  const evidenceIds = evidenceStr
    ? evidenceStr.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const body = resolveBody(opts);

  if (evidenceIds.length === 0) {
    process.stderr.write(
      'Rule violation: at least 1 evidence ID is required for final audit.\n'
    );
    process.exit(1);
  }

  const stateDir = findTeamworkDir(process.cwd());
  const evidenceDir = join(stateDir, 'evidence');

  for (const evId of evidenceIds) {
    const entry = findEvidenceById(evidenceDir, evId);
    if (!entry) {
      process.stderr.write(
        `Rule violation: evidence ID "${evId}" not found in evidence logs (.teamwork/evidence/**).\n`
      );
      process.exit(1);
    }
  }

  const targetPath = join(stateDir, 'final-audit.md');
  const recordedAt = new Date().toISOString();
  const frontmatter = [
    '---',
    `role: ${role}`,
    `verdict: ${verdict}`,
    `evidence: [${evidenceIds.join(', ')}]`,
    `recorded_at: ${recordedAt}`,
    '---',
    '',
    body,
  ].join('\n');

  writeFileSync(targetPath, frontmatter, 'utf8');
  process.stdout.write('Final audit recorded at: .teamwork/final-audit.md\n');
  process.exit(0);
}
