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
