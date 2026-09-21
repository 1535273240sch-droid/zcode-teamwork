#!/usr/bin/env node
// Teamwork CLI - unified entrypoint for evidence, verification, and gate checks.
// ASCII only: this file is a protocol artifact.

import {basename} from 'node:path';

function printUsage() {
  process.stderr.write(
    'Usage: teamwork.mjs <subcommand> [options]\\n\\n' +
      'Subcommands:\\n' +
      '  run [--label <text>] -- <command...>: Execute command and record evidence\\n' +
      '  verify --milestone <id> --role <role> --verdict <verdict> --evidence <ids> [--body <text> | --body-file <path>]\\n' +
      '  final-audit --verdict <verdict> --evidence <ids> [--body <text> | --body-file <path>]\\n' +
      '  approve [--check | --manual-fallback]\\n' +
      '  audit-ownership\\n' +
      '  gate [--json]\\n' +
      '  progress <beat|set> ...\\n' +
      '  knowledge <add|list> ...\\n'
  );
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  printUsage();
}

const subcommand = args[0];
const subArgs = args.slice(1);

switch (subcommand) {
  case 'run': {
    const {runCommand} = await import('./lib/run.mjs');
    await runCommand(subArgs);
    break;
  }
  case 'verify': {
    const {verifyCommand} = await import('./lib/verify.mjs');
    await verifyCommand(subArgs);
    break;
  }
  case 'final-audit': {
    const {finalAuditCommand} = await import('./lib/verify.mjs');
    await finalAuditCommand(subArgs);
    break;
  }
  case 'approve': {
    const {approveCommand} = await import('./lib/approve.mjs');
    await approveCommand(subArgs);
    break;
  }
  case 'audit-ownership': {
    const {auditOwnershipCommand} = await import('./lib/audit-ownership.mjs');
    await auditOwnershipCommand(subArgs);
    break;
  }
  case 'gate': {
    const {gateCommand} = await import('./lib/gate.mjs');
    await gateCommand(subArgs);
    break;
  }
  case 'progress': {
    const {progressCommand} = await import('./lib/progress.mjs');
    await progressCommand(subArgs);
    break;
  }
  case 'knowledge': {
    const {knowledgeCommand} = await import('./lib/knowledge.mjs');
    await knowledgeCommand(subArgs);
    break;
  }
  case '-h':
  case '--help':
  case 'help': {
    printUsage();
    break;
  }
  default: {
    process.stderr.write(`Unknown subcommand: ${subcommand}\\n`);
    printUsage();
    break;
  }
}
