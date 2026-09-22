// Boundary tests for plugins/teamwork/lib/journal.mjs
//
// Covers all 12 edge cases and boundary branches identified in .teamwork/survey.md:
//   1. createEvent: default argument payload = {}
//   2. appendEvent: catch exception returning false
//   3. readEvents: readFileSync exception caught returning []
//   4. readEvents: options.limit non-positive fallback returning all events
//   5. lastEventAt: Number.isFinite(at) ? at : null false branch (unparseable timestamp)
//   6. lastEventAt: last?.at ?? '' fallback to empty string (missing at)
//   7. lastEventAt: Number.isFinite(at) ? at : null true branch (valid timestamp)
//   8. summarize: existing kind counter accumulation
//   9. summarize: empty log first and last falling back to null
//  10. summarize: gates mapping branch
//  11. summarize: agents filtering non-string properties
//  12. summarize: agents deduplication with Set
//
// ASCII only: protocol artifact.

import {mkdirSync, writeFileSync, rmSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

import {
	createEvent,
	appendEvent,
	readEvents,
	lastEventAt,
	summarize,
} from '../plugins/teamwork/lib/journal.mjs';

const WORK = mkdtempSync(join(tmpdir(), 'teamwork-journal-boundary-'));

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${detail}` : ''}`);
	}
}

function freshDir(name) {
	const dir = join(WORK, name);
	rmSync(dir, {recursive: true, force: true});
	mkdirSync(dir, {recursive: true});
	return dir;
}

console.log('\njournal.mjs - boundary tests');

// 1. createEvent: default argument payload = {} (line 44)
{
	const event = createEvent('note');
	check(
		'boundary 1: createEvent uses empty object default when payload is omitted',
		event.kind === 'note' && typeof event.at === 'string' && Object.keys(event).length === 2,
		JSON.stringify(event),
	);
}

// 2. appendEvent: catch exception returning false (lines 55-57)
{
	const dir = freshDir('append-dir');
	const result = appendEvent(dir, createEvent('note'));
	check(
		'boundary 2: appendEvent catches IO error and returns false when target is a directory',
		result === false,
		String(result),
	);
}

// 3. readEvents: readFileSync exception caught returning [] (lines 71-73)
{
	const dir = freshDir('read-dir');
	const events = readEvents(dir);
	check(
		'boundary 3: readEvents catches read error and returns empty array when path is a directory',
		Array.isArray(events) && events.length === 0,
		JSON.stringify(events),
	);
}

// 4. readEvents: options.limit non-positive or invalid fallback returning all events (lines 84-86)
{
	const dir = freshDir('read-limit');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, createEvent('note', {n: 1}));
	appendEvent(path, createEvent('note', {n: 2}));
	const zero = readEvents(path, {limit: 0});
	const negative = readEvents(path, {limit: -1});
	const nan = readEvents(path, {limit: 'invalid'});
	check(
		'boundary 4: readEvents returns all events when limit is non-positive or NaN',
		zero.length === 2 && negative.length === 2 && nan.length === 2,
		`zero=${zero.length}, negative=${negative.length}, nan=${nan.length}`,
	);
}

// 5. lastEventAt: Number.isFinite(at) ? at : null false branch (line 103)
{
	const dir = freshDir('last-invalid-date');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, {kind: 'note', at: 'invalid-date-string'});
	const result = lastEventAt(path);
	check(
		'boundary 5: lastEventAt returns null when timestamp cannot be parsed into a finite number',
		result === null,
		String(result),
	);
}

// 6. lastEventAt: last?.at ?? '' fallback to empty string (line 102)
{
	const dir = freshDir('last-missing-at');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, {kind: 'note'});
	const result = lastEventAt(path);
	check(
		'boundary 6: lastEventAt falls back to empty string and returns null when at is missing',
		result === null,
		String(result),
	);
}

// 7. lastEventAt: Number.isFinite(at) ? at : null true branch (line 103)
{
	const dir = freshDir('last-valid-date');
	const path = join(dir, 'journal.jsonl');
	const before = Date.now();
	appendEvent(path, createEvent('note', {text: 'valid'}));
	const result = lastEventAt(path);
	check(
		'boundary 7: lastEventAt returns numeric timestamp when last event has a valid ISO date',
		typeof result === 'number' && Number.isFinite(result) && result >= before,
		String(result),
	);
}

// 8. summarize: existing kind counter accumulation (line 117)
{
	const dir = freshDir('summary-kind-count');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, createEvent('note', {text: 'first'}));
	appendEvent(path, createEvent('note', {text: 'second'}));
	const summary = summarize(path);
	check(
		'boundary 8: summarize increments existing kind count when kind repeats',
		summary.byKind.note === 2,
		JSON.stringify(summary.byKind),
	);
}

// 9. summarize: empty log first and last falling back to null (lines 124-125)
{
	const dir = freshDir('summary-empty');
	const path = join(dir, 'empty.jsonl');
	const summary = summarize(path);
	check(
		'boundary 9: summarize sets first and last to null when journal is empty',
		summary.total === 0 && summary.first === null && summary.last === null,
		`total=${summary.total}, first=${summary.first}, last=${summary.last}`,
	);
}

// 10. summarize: gates mapping branch (lines 120, 128)
{
	const dir = freshDir('summary-gates');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, createEvent('gate-recorded', {milestone: 'm1', result: 'passed', extra: 'drop-me'}));
	const summary = summarize(path);
	check(
		'boundary 10: summarize maps gate-recorded events to milestone and result objects',
		Array.isArray(summary.gates) &&
			summary.gates.length === 1 &&
			summary.gates[0].milestone === 'm1' &&
			summary.gates[0].result === 'passed' &&
			summary.gates[0].extra === undefined,
		JSON.stringify(summary.gates),
	);
}

// 11. summarize: agents filtering non-string properties (line 127)
{
	const dir = freshDir('summary-non-string-agents');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, createEvent('dispatch', {}));
	appendEvent(path, createEvent('dispatch', {agent: null}));
	appendEvent(path, createEvent('dispatch', {agent: 123}));
	appendEvent(path, createEvent('dispatch', {agent: 'worker'}));
	const summary = summarize(path);
	check(
		'boundary 11: summarize filters out non-string agents from dispatch events',
		summary.agents.length === 1 && summary.agents[0] === 'worker',
		JSON.stringify(summary.agents),
	);
}

// 12. summarize: agents deduplication with Set (line 127)
{
	const dir = freshDir('summary-dedup-agents');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, createEvent('dispatch', {agent: 'worker'}));
	appendEvent(path, createEvent('dispatch', {agent: 'worker'}));
	const summary = summarize(path);
	check(
		'boundary 12: summarize deduplicates repeated agent names',
		summary.agents.length === 1 && summary.agents[0] === 'worker',
		JSON.stringify(summary.agents),
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
