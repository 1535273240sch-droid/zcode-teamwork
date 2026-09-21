// Teamwork - append-only journal.
//
// Every campaign event lands here, in order, with a timestamp. The journal is what
// makes a campaign auditable after the fact and resumable during it.
//
// Why append-only rather than a mutable summary: a summary is written by whichever
// process happens to be running, and a summary written by a confused process is
// worse than none because it reads as authoritative. An append-only log cannot
// rewrite history - the worst a faulty writer can do is add a bad line, and the
// bad line is visibly attributable. Everything derived (current state, progress
// reports) is a fold over this log plus the state file.
//
// The log is JSON Lines so a torn final line - the normal consequence of a process
// being killed mid-write - is skipped by any reader rather than corrupting the
// preceding records.
//
// ASCII only: protocol artifact.

import {appendFileSync, readFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export const EVENT_KINDS = [
	'campaign-created',
	'charter-approved',
	'phase-changed',
	'plan-created',
	'milestone-added',
	'milestone-status',
	'workstream-status',
	'ownership-claimed',
	'ownership-released',
	'gate-recorded',
	'repair-created',
	'tool',
	'dispatch',
	'dispatch-stop',
	'handoff',
	'resume',
	'cancel',
	'note',
];

/** A single journal entry. `kind` is constrained so a reader can switch on it. */
export function createEvent(kind, payload = {}) {
	if (!EVENT_KINDS.includes(kind)) throw new Error(`createEvent: unknown kind "${kind}"`);
	return {at: new Date().toISOString(), kind, ...payload};
}

/** Append one event. Never throws: losing a log line must not kill a session. */
export function appendEvent(path, event) {
	try {
		mkdirSync(dirname(path), {recursive: true});
		appendFileSync(path, `${JSON.stringify(event)}\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the journal.
 *
 * `limit` takes the most recent N entries, which is what a status report wants -
 * the tail of a long campaign, not its opening.
 */
export function readEvents(path, options = {}) {
	if (!existsSync(path)) return [];
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return [];
	}
	const lines = text.split('\n');
	const events = [];
	for (const line of lines) {
		if (line.length === 0) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// A torn tail line is expected after a kill; skip it and carry on.
		}
	}
	const limit = Number(options.limit);
	if (Number.isFinite(limit) && limit > 0) return events.slice(-limit);
	return events;
}

/** Events of one kind, in order. */
export function eventsOfKind(path, kind) {
	return readEvents(path).filter((e) => e.kind === kind);
}

/**
 * Millisecond timestamp of the last event, or null when the journal is empty.
 * Used for staleness, where the question is "when did anything last happen".
 */
export function lastEventAt(path) {
	const events = readEvents(path);
	if (events.length === 0) return null;
	const last = events[events.length - 1];
	const at = Date.parse(last?.at ?? '');
	return Number.isFinite(at) ? at : null;
}

/**
 * Fold the journal into a per-milestone history.
 *
 * Reported alongside the state file so a reader can see the difference between
 * "the state says this passed" and "the journal shows it passing" - those disagree
 * exactly when something went wrong.
 */
export function summarize(path) {
	const events = readEvents(path);
	const byKind = new Map();
	for (const event of events) {
		byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
	}
	const dispatches = events.filter((e) => e.kind === 'dispatch');
	const gates = events.filter((e) => e.kind === 'gate-recorded');
	return {
		total: events.length,
		byKind: Object.fromEntries(byKind),
		first: events[0]?.at ?? null,
		last: events[events.length - 1]?.at ?? null,
		dispatches: dispatches.length,
		agents: [...new Set(dispatches.map((d) => d.agent).filter((a) => typeof a === 'string'))],
		gates: gates.map((g) => ({milestone: g.milestone, result: g.result})),
	};
}
