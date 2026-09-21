// hook-probe: records every hook event this plugin receives and exercises the
// return-value channels, so we can verify empirically what ZCode honours for a
// third-party plugin.
//
// Usage: install the plugin, start a NEW session, then read .zcode-probe/events.jsonl.
// Behaviour is controlled by .zcode-probe/mode.json (optional). Modes:
//   observe   (default) write the event to the log, return nothing
//   block     reply {decision:"block"} on Stop, to test whether a plugin can veto
//             the end of a turn
//   deny      deny the next Write/Edit via permissionDecision, to test PreToolUse
//   rewrite   append a marker via updatedInput on Write/Edit, to test input rewrite
//   context   inject additionalContext, to test whether it reaches the model
//
// ASCII only: the hook payload crosses an encoding boundary into ZCode.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROBE_DIR = '.zcode-probe';
const EVENTS_FILE = 'events.jsonl';
const MODE_FILE = 'mode.json';

function readStdin() {
	let raw = '';
	process.stdin.setEncoding('utf8');
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve(raw);
		};
		process.stdin.on('data', (chunk) => {
			raw += chunk;
		});
		process.stdin.on('end', finish);
		// The runtime may keep the pipe open; never hang the agent waiting for it.
		setTimeout(finish, 1500);
	});
}

function emit(obj) {
	process.stdout.write(JSON.stringify(obj));
	process.exit(0);
}

function resolveProbeDir(input) {
	const cwd = input?.cwd || process.cwd();
	return join(cwd, PROBE_DIR);
}

function readMode(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, MODE_FILE), 'utf8'));
		return typeof parsed?.mode === 'string' ? parsed.mode : 'observe';
	} catch {
		return 'observe';
	}
}

function record(dir, entry) {
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, EVENTS_FILE), JSON.stringify(entry) + '\n');
	} catch {
		// A probe must never break the session it is observing.
	}
}

const raw = await readStdin();
let input = null;
try {
	input = JSON.parse(raw);
} catch {
	input = { _parse_error: true, _raw: raw.slice(0, 2000) };
}

const dir = resolveProbeDir(input);
const mode = readMode(dir);
const event = input?.hookEventName ?? 'unknown';

record(dir, {
	at: new Date().toISOString(),
	event,
	mode,
	input,
});

// File probe results in machine-readable form for the Windows/macOS/Linux matrix.
if (!existsSync(join(dir, 'first-seen.json'))) {
	try {
		writeFileSync(
			join(dir, 'first-seen.json'),
			JSON.stringify({ at: new Date().toISOString(), event, keys: Object.keys(input ?? {}).sort() }, null, 2)
		);
	} catch {
		// ignore
	}
}

switch (mode) {
	case 'block':
		if (event === 'Stop') {
			// `reason`, not `stopReason`: ZCode only pushes reason/systemMessage into
			// additionalContexts, and the continuation check requires a non-empty
			// additionalContexts. With stopReason the block is recorded but the turn
			// still ends - a false negative for anyone testing this channel.
			emit({
				decision: 'block',
				reason: 'hook-probe: verifying that a plugin can veto Stop',
			});
		}
		emit({});
		break;

	case 'deny':
		if (event === 'PreToolUse') {
			emit({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
					permissionDecisionReason: 'hook-probe: deny channel test',
				},
			});
		}
		emit({});
		break;

	case 'rewrite':
		if (event === 'PreToolUse') {
			const next = { ...(input.toolInput ?? {}), _probe_rewritten: true };
			emit({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'allow',
					updatedInput: next,
				},
			});
		}
		emit({});
		break;

	case 'context':
		if (event === 'SessionStart' || event === 'UserPromptSubmit') {
			emit({
				hookSpecificOutput: {
					hookEventName: event,
					additionalContext: 'hook-probe: additionalContext channel test',
				},
			});
		}
		emit({});
		break;

	default:
		emit({});
		break;
}
