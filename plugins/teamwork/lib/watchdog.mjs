// Teamwork - active watchdog and deadlock auto-healing.
//
// Aligned with Google Antigravity Sentinel Monitoring Crons:
//   - Progress Cron: tracks open milestones, active leases, and recent file touches
//   - Liveness Cron: detects stagnation via events.jsonl mtime and reservation TTL,
//     issues progressive nudges, and automatically heals deadlocked reservations and expired leases.
//
// ASCII only: protocol artifact.

import {existsSync, statSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import {
	statePaths,
	loadCampaign,
	isCampaignActive,
	loadMilestones,
	VERIFICATIONS_DIR,
	readStore,
	writeAtomic,
	acquireMutex,
	releaseMutex,
	pruneExpired,
	readLeaseMinutes,
	DEFAULT_LEASE_MINUTES,
	RESERVATION_TTL_MS,
} from '../hooks/_lib.mjs';

import {isExpired} from './ownership.mjs';

export const NUDGE_MINUTES_DEFAULT = 15;
export const DEADLOCK_MINUTES_DEFAULT = 30;

/**
 * Inspect health and liveness of a running campaign.
 */
export function inspectHealth(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const paths = options.stateDir ? {
		stateDir: options.stateDir,
		campaign: join(options.stateDir, 'campaign.json'),
		lock: join(options.stateDir, 'ownership.json'),
		plan: join(options.stateDir, 'plan.json'),
		events: join(options.stateDir, 'events.jsonl'),
		mutex: join(options.stateDir, '.lock'),
	} : statePaths(cwd);
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const nudgeMinutes = Number.isFinite(options.nudgeMinutes) ? options.nudgeMinutes : NUDGE_MINUTES_DEFAULT;
	const deadlockMinutes = Number.isFinite(options.deadlockMinutes) ? options.deadlockMinutes : DEADLOCK_MINUTES_DEFAULT;

	if (!existsSync(paths.campaign)) {
		return {ok: false, reason: 'no campaign found', healthy: true, status: 'idle'};
	}

	let campaign;
	try {
		campaign = JSON.parse(readFileSync(paths.campaign, 'utf8'));
	} catch (e) {
		return {ok: false, reason: `failed to parse campaign: ${e.message}`, healthy: false, status: 'corrupt'};
	}

	if (!isCampaignActive(campaign)) {
		return {ok: true, healthy: true, status: 'inactive', phase: campaign.phase, signals: []};
	}

	const signals = [];
	const {milestones} = loadMilestones(options.stateDir ?? cwd);
	const open = (milestones ?? []).filter((m) => m.status !== 'done' && m.verified !== true);

	// 1. Check last activity from events.jsonl
	let quietMinutes = 0;
	if (existsSync(paths.events)) {
		try {
			const mtime = statSync(paths.events).mtimeMs;
			quietMinutes = Math.max(0, Math.round((now - mtime) / 60_000));
		} catch {
			quietMinutes = 0;
		}
	} else {
		signals.push({
			kind: 'no-events-trail',
			severity: 'warning',
			detail: 'Campaign active but events.jsonl not found; hooks might not be armed.',
		});
	}

	if (quietMinutes >= deadlockMinutes && open.length > 0) {
		signals.push({
			kind: 'deadlock',
			severity: 'critical',
			minutes: quietMinutes,
			detail: `No event activity recorded for ${quietMinutes}m while ${open.length} milestone(s) open.`,
		});
	} else if (quietMinutes >= nudgeMinutes && open.length > 0) {
		signals.push({
			kind: 'stalled',
			severity: 'nudge',
			minutes: quietMinutes,
			detail: `Quiet for ${quietMinutes}m with ${open.length} milestone(s) open. Worker may be blocked.`,
		});
	}

	// 2. Check expired file leases
	const expiredLeases = [];
	if (existsSync(paths.lock)) {
		try {
			const store = JSON.parse(readFileSync(paths.lock, 'utf8'));
			for (const [key, entry] of Object.entries(store)) {
				if (entry && entry.expiresAt) {
					const exp = new Date(entry.expiresAt).getTime();
					if (Number.isFinite(exp) && exp < now) {
						expiredLeases.push({key, file: entry.file, milestone: entry.milestone, expiredForMinutes: Math.round((now - exp) / 60_000)});
					}
				}
			}
		} catch {
			// ignore lock read errors
		}
	}
	if (expiredLeases.length > 0) {
		signals.push({
			kind: 'expired-leases',
			severity: 'warning',
			detail: `${expiredLeases.length} lease(s) expired while campaign active.`,
			items: expiredLeases,
		});
	}

	// 3. Check abandoned reservations
	const abandonedReservations = [];
	const reservationsPath = join(paths.stateDir, 'spawn-reservations.json');
	if (existsSync(reservationsPath)) {
		try {
			const res = JSON.parse(readFileSync(reservationsPath, 'utf8'));
			for (const [id, item] of Object.entries(res)) {
				if (item && item.at) {
					const ageMs = now - item.at;
					if (ageMs > RESERVATION_TTL_MS) {
						abandonedReservations.push({id, agent: item.agent, ageMinutes: Math.round(ageMs / 60_000)});
					}
				}
			}
		} catch {
			// ignore reservations parse errors
		}
	}
	if (abandonedReservations.length > 0) {
		signals.push({
			kind: 'abandoned-reservations',
			severity: 'warning',
			detail: `${abandonedReservations.length} reservation(s) held past TTL.`,
			items: abandonedReservations,
		});
	}

	let status = 'healthy';
	if (signals.some((s) => s.severity === 'critical')) {
		status = 'deadlocked';
	} else if (signals.some((s) => s.severity === 'nudge')) {
		status = 'nudge';
	} else if (signals.length > 0) {
		status = 'warning';
	}

	return {
		ok: true,
		healthy: status === 'healthy',
		status,
		quietMinutes,
		openMilestones: open.map((m) => m.id),
		signals,
		expiredLeases,
		abandonedReservations,
		at: new Date(now).toISOString(),
	};
}

/**
 * Automatically heal deadlock conditions by pruning expired leases and abandoned reservations.
 */
export function healHealth(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const paths = options.stateDir ? {
		stateDir: options.stateDir,
		campaign: join(options.stateDir, 'campaign.json'),
		lock: join(options.stateDir, 'ownership.json'),
		plan: join(options.stateDir, 'plan.json'),
		events: join(options.stateDir, 'events.jsonl'),
		mutex: join(options.stateDir, '.lock'),
	} : statePaths(cwd);
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const results = {prunedLeases: [], prunedReservations: [], healed: false};

	if (!existsSync(paths.campaign)) {
		return {ok: false, reason: 'no campaign', ...results};
	}

	// 1. Auto-heal expired leases in ownership.json
	if (existsSync(paths.lock)) {
		let lockAcquired = false;
		try {
			lockAcquired = acquireMutex(paths);
			if (lockAcquired) {
				const store = readStore(paths.lock);
				const campaign = loadCampaign(paths.campaign);
				const leaseMin = readLeaseMinutes(campaign);
				const pruned = pruneExpired(store, leaseMin * 60_000, now);
				if (pruned.length > 0) {
					writeAtomic(paths.lock, JSON.stringify(store, null, 2));
					results.prunedLeases = pruned;
					results.healed = true;
				}
			}
		} finally {
			if (lockAcquired) releaseMutex(paths);
		}
	}

	// 2. Auto-heal abandoned reservations in spawn-reservations.json
	const reservationsPath = join(paths.stateDir, 'spawn-reservations.json');
	if (existsSync(reservationsPath)) {
		let lockAcquired = false;
		try {
			lockAcquired = acquireMutex(paths);
			if (lockAcquired) {
				const res = readStore(reservationsPath);
				const removed = [];
				for (const [id, item] of Object.entries(res)) {
					if (item && item.at && (now - item.at > RESERVATION_TTL_MS)) {
						delete res[id];
						removed.push(id);
					}
				}
				if (removed.length > 0) {
					writeAtomic(reservationsPath, JSON.stringify(res, null, 2));
					results.prunedReservations = removed;
					results.healed = true;
				}
			}
		} finally {
			if (lockAcquired) releaseMutex(paths);
		}
	}

	return {ok: true, ...results, at: new Date(now).toISOString()};
}
