// Teamwork - shared blackboard architecture.
//
// Aligned with Google Antigravity Blackboard Architecture:
// In multi-agent pipelines, agents submit result summaries to an authoritative
// central blackboard (.teamwork/blackboard.json).
//
// Workers only POST updates/diffs; the dedicated blackboard updater atomically
// serializes and merges them, eliminating concurrent state write races.
//
// ASCII only: protocol artifact.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {statePaths, acquireMutex, releaseMutex, writeAtomic, readStore} from '../hooks/_lib.mjs';

export const BLACKBOARD_FILE = 'blackboard.json';

/**
 * Resolve the blackboard file path.
 */
export function blackboardPath(stateDir = '.teamwork') {
	return join(stateDir, BLACKBOARD_FILE);
}

/**
 * Read the current blackboard state.
 */
export function readBlackboard(stateDir = '.teamwork') {
	const path = blackboardPath(stateDir);
	if (!existsSync(path)) {
		return {
			version: 1,
			entries: {},
			log: [],
			updatedAt: null,
		};
	}
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return {
			version: 1,
			entries: {},
			log: [],
			updatedAt: null,
			corrupt: true,
		};
	}
}

/**
 * Post an atomic key-value update to the central blackboard.
 */
export function postUpdate(stateDir = '.teamwork', update = {}, options = {}) {
	const {author = 'worker', milestone = null, category = 'general'} = options;
	const paths = {mutex: join(stateDir, '.lock')};
	const targetPath = blackboardPath(stateDir);

	let lockAcquired = false;
	try {
		lockAcquired = acquireMutex(paths);
		if (!lockAcquired) {
			return {ok: false, reason: 'could not acquire blackboard mutex lock'};
		}

		const current = readBlackboard(stateDir);
		const entries = {...(current.entries ?? {})};
		const log = Array.isArray(current.log) ? [...current.log] : [];

		const keysUpdated = [];
		for (const [key, val] of Object.entries(update)) {
			entries[key] = {
				value: val,
				author,
				milestone,
				category,
				updatedAt: new Date().toISOString(),
			};
			keysUpdated.push(key);
		}

		log.push({
			author,
			milestone,
			category,
			keys: keysUpdated,
			at: new Date().toISOString(),
		});

		// Keep recent 100 log entries
		const trimmedLog = log.slice(-100);

		const next = {
			version: 1,
			entries,
			log: trimmedLog,
			updatedAt: new Date().toISOString(),
		};

		writeAtomic(targetPath, JSON.stringify(next, null, 2));
		return {ok: true, updatedKeys: keysUpdated, blackboard: next};
	} finally {
		if (lockAcquired) releaseMutex(paths);
	}
}

/**
 * Query entries from blackboard by category or prefix.
 */
export function queryBlackboard(stateDir = '.teamwork', filter = {}) {
	const bb = readBlackboard(stateDir);
	const results = {};
	const category = filter.category;
	const prefix = filter.prefix;

	for (const [key, item] of Object.entries(bb.entries ?? {})) {
		if (category && item.category !== category) continue;
		if (prefix && !key.startsWith(prefix)) continue;
		results[key] = item.value;
	}

	return {ok: true, results, count: Object.keys(results).length};
}

// ---------------------------------------------------------------------------
// Pitfall registry
//
// A tournament spends real work on candidates that do not survive. This file is what
// makes that spend recoverable: each falsified candidate is written down with the
// reason it failed and, crucially, with the parts that were worth keeping.
//
// The highlights field is not decoration. A registry that recorded only failure
// reasons would make the synthesis a fresh start, and the tournament's whole
// justification is buying back the cost of the attempts that lost. Writing down only
// why a route died throws away the reason it was worth trying.

export const PITFALL_REGISTRY_FILE = 'pitfall-registry.json';

export function pitfallRegistryPath(stateDir = '.teamwork') {
	return join(stateDir, PITFALL_REGISTRY_FILE);
}

/** The registry, or an empty one. A corrupt file reads as empty and says so. */
export function readPitfallRegistry(stateDir = '.teamwork') {
	const empty = {version: 1, pitfalls: [], updatedAt: null};
	const path = pitfallRegistryPath(stateDir);
	if (!existsSync(path)) return empty;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pitfalls)) {
			return {...empty, corrupt: true};
		}
		return parsed;
	} catch {
		return {...empty, corrupt: true};
	}
}

/**
 * Record one candidate's outcome.
 *
 * Keyed by round and candidate, so re-recording the same candidate replaces its entry
 * rather than appending a second verdict. A candidate is falsified once; two entries
 * for one attempt would make the synthesis read the same failure twice and describe it
 * as corroboration.
 */
export function recordPitfall(stateDir = '.teamwork', entry = {}) {
	const round = Number.isFinite(Number(entry.round)) ? Math.floor(Number(entry.round)) : 1;
	const candidate = String(entry.candidate ?? '').trim();
	if (candidate.length === 0) return {ok: false, reason: 'a pitfall needs the candidate it came from'};
	if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
		return {ok: false, reason: 'a pitfall needs the reason the candidate failed'};
	}

	const paths = {mutex: join(stateDir, '.lock')};
	const targetPath = pitfallRegistryPath(stateDir);
	let lockAcquired = false;
	try {
		lockAcquired = acquireMutex(paths);
		if (!lockAcquired) return {ok: false, reason: 'could not acquire pitfall registry mutex lock'};

		const current = readPitfallRegistry(stateDir);
		const pitfalls = Array.isArray(current.pitfalls) ? [...current.pitfalls] : [];
		const id = `${round}:${candidate}`;
		const record = {
			id,
			round,
			candidate,
			workstream: entry.workstream ?? null,
			verdict: entry.verdict ?? 'FALSIFIED',
			reason: entry.reason.trim(),
			highlights: (Array.isArray(entry.highlights) ? entry.highlights : [])
				.map((h) => String(h).trim())
				.filter((h) => h.length > 0),
			falsifiedBy: entry.falsifiedBy ?? 'empirical-challenger',
			evidence: entry.evidence ?? null,
			at: new Date().toISOString(),
		};

		const index = pitfalls.findIndex((p) => p && p.id === id);
		if (index === -1) pitfalls.push(record);
		else pitfalls[index] = record;

		const next = {version: 1, pitfalls, updatedAt: new Date().toISOString()};
		writeAtomic(targetPath, JSON.stringify(next, null, 2));
		return {ok: true, pitfall: record, replaced: index !== -1, registry: next};
	} finally {
		if (lockAcquired) releaseMutex(paths);
	}
}

/** Pitfalls, optionally narrowed to one round. */
export function pitfallsFor(stateDir = '.teamwork', filter = {}) {
	const all = readPitfallRegistry(stateDir).pitfalls;
	const round = Number.isFinite(Number(filter.round)) ? Math.floor(Number(filter.round)) : undefined;
	const list = round === undefined ? all : all.filter((p) => p && p.round === round);
	return {ok: true, pitfalls: list, count: list.length};
}

/**
 * The brief the Orchestrator reads before synthesising.
 *
 * It hands over what the synthesis needs and nothing else: which candidates fell and
 * why, the highlights worth carrying forward, and which declared candidates are still
 * standing. Survivors are listed separately because the job is to choose among them
 * and then borrow from the dead, not to average everything together.
 */
export function synthesisBrief(stateDir = '.teamwork', options = {}) {
	const round = Number.isFinite(Number(options.round)) ? Math.floor(Number(options.round)) : 1;
	const {pitfalls} = pitfallsFor(stateDir, {round});
	const declared = (Array.isArray(options.candidates) ? options.candidates : []).map((c) => String(c));
	const falsified = new Set(pitfalls.map((p) => p.candidate));
	const survivors = declared.filter((name) => !falsified.has(name));

	const lines = [
		`Tournament round ${round}: synthesis brief`,
		'',
		`Candidates declared: ${declared.length > 0 ? declared.join(', ') : '(none recorded)'}`,
		`Falsified: ${falsified.size > 0 ? [...falsified].join(', ') : '(none)'}`,
		`Survived: ${survivors.length > 0 ? survivors.join(', ') : '(none identified yet)'}`,
		'',
		'Start from a survivor, choosing the one that survived the strongest attempt to break it.',
		'Take the highlights below where they do not contradict that route, and say explicitly what you dropped.',
		'Do not average the candidates together: a design assembled from incompatible survivors fails differently from each.',
		'',
	];

	for (const pitfall of pitfalls) {
		lines.push(`## ${pitfall.candidate} - ${pitfall.verdict}`);
		lines.push(`Failed because: ${pitfall.reason}`);
		if (pitfall.highlights.length > 0) {
			lines.push('Worth keeping:');
			for (const highlight of pitfall.highlights) lines.push(`  - ${highlight}`);
		} else {
			lines.push('Worth keeping: (none recorded - treat this attempt as a dead end)');
		}
		lines.push('');
	}

	return {ok: true, round, falsified: pitfalls.length, survivors, brief: lines.join('\n')};
}
