// Teamwork - execute command and capture evidence.
// ASCII only: this file is a protocol artifact.

import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {generateEvidenceId, appendEvidenceLog} from './evidence.mjs';
import {getGitInfo, sha256Hex} from './utils.mjs';

const TAIL_LIMIT = 32768; // 32KB

export async function runCommand(args) {
  let label = undefined;
  let cmdArgs = [];

  const doubleDashIdx = args.indexOf('--');
  if (doubleDashIdx === -1) {
    process.stderr.write('Usage: teamwork.mjs run [--label <text>] -- <command...>\n');
    process.exit(2);
  }

  const preArgs = args.slice(0, doubleDashIdx);
  cmdArgs = args.slice(doubleDashIdx + 1);

  for (let i = 0; i < preArgs.length; i++) {
    if (preArgs[i] === '--label' && i + 1 < preArgs.length) {
      label = preArgs[i + 1];
      i++;
    }
  }

  if (cmdArgs.length === 0) {
    process.stderr.write('Error: No command specified after --\n');
    process.exit(2);
  }

  function formatToken(tok) {
    if (tok.includes(' ') && !tok.startsWith('"') && !tok.startsWith("'")) {
      return `"${tok.replace(/"/g, '\\"')}"`;
    }
    return tok;
  }

  const cwd = resolve(process.cwd());
  const cmdString = cmdArgs.map(formatToken).join(' ');
  const gitInfo = getGitInfo(cwd);

  const startTime = new Date();
  const res = spawnSync(cmdString, {
    cwd,
    shell: true,
    encoding: 'buffer',
    windowsHide: true,
  });

  const stdoutRaw = res.stdout ? res.stdout.toString('utf8') : '';
  const stderrRaw = res.stderr ? res.stderr.toString('utf8') : '';
  const exitCode = res.status !== null ? res.status : 1;

  let truncated = false;
  let stdoutTail = stdoutRaw;
  let stderrTail = stderrRaw;

  if (Buffer.byteLength(stdoutRaw, 'utf8') > TAIL_LIMIT) {
    truncated = true;
    const buf = Buffer.from(stdoutRaw, 'utf8');
    stdoutTail = buf.subarray(buf.length - TAIL_LIMIT).toString('utf8');
  }

  if (Buffer.byteLength(stderrRaw, 'utf8') > TAIL_LIMIT) {
    truncated = true;
    const buf = Buffer.from(stderrRaw, 'utf8');
    stderrTail = buf.subarray(buf.length - TAIL_LIMIT).toString('utf8');
  }

  const record = {
    id: generateEvidenceId(startTime),
    ts: startTime.toISOString(),
    cwd,
    cmd: cmdString,
    exit_code: exitCode,
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    stdout_sha256: sha256Hex(stdoutRaw),
    stderr_sha256: sha256Hex(stderrRaw),
    truncated,
    git_head: gitInfo.head,
    git_dirty: gitInfo.dirty,
  };
  if (label) {
    record.label = label;
  }

  appendEvidenceLog(cwd, record);

  if (stdoutRaw.length > 0) {
    process.stdout.write(stdoutRaw);
    if (!stdoutRaw.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
  if (stderrRaw.length > 0) {
    process.stderr.write(stderrRaw);
    if (!stderrRaw.endsWith('\n')) {
      process.stderr.write('\n');
    }
  }

  process.stdout.write(`EVIDENCE-ID: ${record.id}\n`);
  process.exit(exitCode);
}
