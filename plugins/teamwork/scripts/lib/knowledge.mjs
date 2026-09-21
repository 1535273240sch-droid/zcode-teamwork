// Teamwork - cross-round knowledge base management.
// ASCII only: this file is a protocol artifact.

import {readFileSync, appendFileSync, mkdirSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {findTeamworkDir} from './utils.mjs';

const TYPE_FILES = {
  pitfall: 'pitfalls.md',
  failed: 'failed-approaches.md',
  proved: 'proved.md',
};

const ANSWER_PATTERNS = [
  /expected\s*(?:value|output|result|is|:|=|==)/i,
  /answer\s*(?:is|:|=|==)/i,
  /\b(?:\u671f\u671b\u503c|\u7b54\u6848|\u6807\u51c6\u7b54\u6848)\b/i,
];

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

export function knowledgeCommand(args) {
  if (args.length === 0) {
    console.error('Usage: teamwork.mjs knowledge <add|list> ...');
    process.exit(2);
  }

  const action = args[0];
  const rest = args.slice(1);
  const opts = parseOptions(rest);

  const teamworkDir = findTeamworkDir(process.cwd());
  const knowledgeDir = join(teamworkDir, 'knowledge');
  mkdirSync(knowledgeDir, {recursive: true});

  if (action === 'add') {
    const type = opts.type;
    const text = opts.text;

    if (!type || !TYPE_FILES[type] || !text) {
      console.error('Usage: teamwork.mjs knowledge add --type <pitfall|failed|proved> --text "<text>"');
      process.exit(2);
    }

    if (type === 'pitfall') {
      for (const pattern of ANSWER_PATTERNS) {
        if (pattern.test(text)) {
          console.warn(
            'Teamwork WARNING: pitfall text appears to contain an expected value or answer. ' +
              'Pitfalls should describe classes of failures rather than specific solutions.'
          );
          break;
        }
      }
    }

    const targetFile = join(knowledgeDir, TYPE_FILES[type]);
    const ts = new Date().toISOString();
    const entry = `## [${ts}]\n${text.trim()}\n\n`;

    appendFileSync(targetFile, entry, 'utf8');
    console.log(`KNOWLEDGE ADDED: type=${type} file=${TYPE_FILES[type]}`);
    process.exit(0);
  } else if (action === 'list') {
    const type = opts.type;
    const filesToRead = type && TYPE_FILES[type] ? [TYPE_FILES[type]] : Object.values(TYPE_FILES);

    for (const f of filesToRead) {
      const p = join(knowledgeDir, f);
      if (existsSync(p)) {
        console.log(`=== ${f} ===\n`);
        console.log(readFileSync(p, 'utf8'));
      }
    }
    process.exit(0);
  } else {
    console.error(`Unknown knowledge action: ${action}`);
    process.exit(2);
  }
}
