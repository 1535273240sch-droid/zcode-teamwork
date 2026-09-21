// Teamwork - session handoff and staleness takeover.
//
// A long campaign outlives the session that started it. The session gets compacted,
// the user closes the laptop, the model's context is rebuilt - and the campaign is
// still supposed to be running. This module is what carries it across that gap.
//
// The honest limitation, stated once and not buried: a process hook cannot hold a
// timer. This plugin has no resident process, so there is NO dead-man switch that
// fires after N minutes of silence. What exists instead is a check that runs at the
// next opportunity the user gives it - on session start, on a user prompt - and
// decides then whether the campaign looks stalled. That is strictly weaker than a
// timer: it cannot interrupt, and it cannot act while nobody is looking.
//
// What it can do, and what makes it worth having:
//   - detect that a milestone's lease expired while its Worker was silent
//   - name the specific milestone that stopped moving, not just "something stalled"
//   - hand the work to a fresh session with enough context to continue
//   - refuse to hand off a campaign that is already complete
//
// ASCII only: protocol artifact.

import {existsSync} from 'node:fs';

import {isExpired} from './ownership.mjs';
import {openMilestones, isCampaignActive} from './state.mjs';
import {lastEventAt} from './journal.mjs';

// Silence that means something. Generous on purpose: a Worker running a test suite
// or a long build is quiet for minutes and is not stalled, and a watchdog that
// fires during normal work is a watchdog nobody keeps.
export const STALE_MINUTES = 30;

// A lease is expected to be renewed while work continues, so an expired lease is a
// sharper signal than silence alone. It is still only a signal: renewing is manual.
export const EXPIRED_LEASE_GRACE_MINUTES = 5;

/**
 * Assess whether a campaign looks stalled.
 *
 * Reads three signals and reports all of them rather than collapsing them into a
 * verdict, because they fail differently and a reader needs to tell them apart:
 *   - journal silence: nothing has happened for a while
 *   - expired leases: something claimed files and stopped renewing
 *   - missing trail: the hooks may not be trusted at all
 */
export function assessStaleness(input) {
	const now = Number.isFinite(input?.now) ? input.now : Date.now();
	const staleMinutes = Number.isFinite(input?.staleMinutes) ? input.staleMinutes : STALE_MINUTES;
	const state = input?.state;
	const signals = [];

	if (!isCampaignActive(state)) {
		return {stalled: false, signals: [], reason: 'campaign is not active'};
	}

	const open = openMilestones(state);
	if (open.length === 0) {
		return {stalled: false, signals: [], reason: 'no open milestones'};
	}

	// 1) Journal silence.
	let quietMinutes = null;
	if (input?.lastEventAt === null) {
		signals.push({
			kind: 'no-trail',
			detail:
				'No journal entries exist while the campaign is approved and milestones are open. Either no Worker has ' +
				'started, or the plugin hooks are not trusted in this workspace (ZCode gates workspace hooks behind a ' +
				'trust prompt). Until that is resolved nothing is being enforced.',
		});
	} else if (Number.isFinite(input?.lastEventAt)) {
		quietMinutes = Math.round((now - input.lastEventAt) / 60_000);
		if (quietMinutes >= staleMinutes) {
			signals.push({
				kind: 'silent',
				detail:
					`No journal activity for ${quietMinutes} minutes while ${open.length} milestone(s) remain open ` +
					`(${open.map((m) => m.id).join(', ')}). A long build or test run also looks like this, so confirm ` +
					'nothing is running before treating it as stalled.',
				minutes: quietMinutes,
			});
		}
	}

	// 2) Expired leases on open milestones.
	const ownership = Array.isArray(state?.ownership) ? state.ownership : [];
	const openIds = new Set(open.map((m) => m.id));
	const expired = ownership.filter(
		(entry) => openIds.has(entry.milestone) && isExpired(entry, now - EXPIRED_LEASE_GRACE_MINUTES * 60_000),
	);
	if (expired.length > 0) {
		signals.push({
			kind: 'expired-leases',
			detail:
				`${expired.length} file lease(s) expired while their milestones are still open: ` +
				`${expired.map((e) => `${e.display ?? e.file} (${e.milestone})`).join(', ')}. ` +
				'An expired lease can be reclaimed by another milestone, which is how two Workers end up on one file.',
			files: expired.map((e) => e.file),
		});
	}

	return {
		stalled: signals.length > 0,
		signals,
		open: open.map((m) => m.id),
		quietMinutes,
	};
}

/**
 * Build the payload for continuing a campaign in a fresh session.
 *
 * Contains what a new session cannot reconstruct from its own context: where the
 * state lives, what is still open, which leases are live, and what the last gate
 * decided. Deliberately not a summary of the conversation - that is exactly the
 * part a fresh session has lost, and inventing it would be the failure mode this
 * module exists to prevent.
 */
export function buildHandoff(state, options = {}) {
	if (state === null || typeof state !== 'object') {
		return {ok: false, reason: 'no campaign state to hand off'};
	}
	if (state.phase === 'complete') {
		return {ok: false, reason: 'campaign is already complete; nothing to hand off'};
	}
	if (state.phase === 'aborted') {
		return {ok: false, reason: 'campaign was aborted'};
	}

	const open = openMilestones(state);
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const ownership = Array.isArray(state.ownership) ? state.ownership : [];
	const live = ownership.filter((entry) => !isExpired(entry, now));

	const lastGate = (state.gates ?? [])[state.gates?.length - 1] ?? null;

	return {
		ok: true,
		reason: options.reason ?? 'session handoff',
		at: new Date(now).toISOString(),
		objective: state.objective,
		phase: state.phase,
		mode: state.mode,
		integrityMode: state.integrityMode,
		executionPath: state.executionPath,
		openMilestones: open.map((m) => ({
			id: m.id,
			deliverable: m.deliverable,
			status: m.status,
			owner_role: m.owner_role,
			verified_by: m.verified_by,
			acceptance: m.acceptance,
			files: m.files ?? [],
		})),
		liveLeases: live.map((entry) => ({file: entry.file, milestone: entry.milestone, expiresAt: entry.expiresAt})),
		lastGate: lastGate ? {milestone: lastGate.milestone, result: lastGate.result} : null,
		instruction:
			'Resume this campaign from the state above. Do not re-scope it and do not re-plan it: the milestones and ' +
			'their ownership are already decided. Pick up the first open milestone, keep each file to its owner, and ' +
			'write the verification record before marking anything done.',
	};
}

/** Render a handoff for a human or a model to read. */
export function renderHandoff(handoff) {
	if (!handoff?.ok) return `No handoff: ${handoff?.reason ?? 'unknown reason'}`;
	const lines = [
		`Campaign: ${handoff.objective}`,
		`Phase: ${handoff.phase}   Mode: ${handoff.mode}   Integrity: ${handoff.integrityMode}`,
		'',
		`Open milestones (${handoff.openMilestones.length}):`,
	];
	for (const m of handoff.openMilestones) {
		lines.push(`  [${m.id}] ${m.status} - ${m.deliverable}`);
		lines.push(`        owner: ${m.owner_role}   verifier: ${m.verified_by}`);
		if (m.files.length > 0) lines.push(`        files: ${m.files.join(', ')}`);
	}
	if (handoff.liveLeases.length > 0) {
		lines.push('', `Live leases (${handoff.liveLeases.length}):`);
		for (const lease of handoff.liveLeases) {
			lines.push(`  ${lease.file} -> ${lease.milestone} (until ${lease.expiresAt})`);
		}
	}
	if (handoff.lastGate) {
		lines.push('', `Last gate: ${handoff.lastGate.milestone} -> ${handoff.lastGate.result}`);
	}
	lines.push('', handoff.instruction);
	return lines.join('\n');
}

// A campaign that has used this fraction of its dispatch budget is about to run
// out. Writing the briefing now means the successor starts from a written record
// rather than from whatever survived in a context window.
export const SUCCESSION_BUDGET_FRACTION = 0.9;

/** Whether a campaign is close enough to its budget ceiling to warrant a dump. */
export function shouldPrepareSuccession(used, budget) {
	if (!Number.isFinite(used) || !Number.isFinite(budget) || budget <= 0) return false;
	return used >= budget * SUCCESSION_BUDGET_FRACTION;
}

/**
 * Render the briefing a successor session reads first.
 *
 * Deliberately contains only things a fresh session cannot recover: where the state
 * lives, what the pattern and integrity mode are, which milestones are open and who
 * owns them, what the last gate decided, and what the successor must not redo. It
 * does not summarise the conversation - that summary is the one artifact a successor
 * cannot check, so it is the one thing that must not be invented for it.
 */
export function renderBriefing(input) {
	const {state, journal, reason, used, budget, stateDir} = input ?? {};
	const lines = [
		'# Teamwork briefing',
		'',
		`Reason: ${reason ?? 'succession'}`,
		`At: ${new Date().toISOString()}`,
		'',
		'## Where things are',
		'',
		`- State directory: ${stateDir ?? '.teamwork'}`,
		'- Campaign state: campaign.json',
		'- Plan: plan.json',
		'- Journal: journal.jsonl',
		'- Verification records: verifications/',
		'- Final audit: final-audit.md',
		'',
	];
	if (state) {
		lines.push('## Campaign', '');
		lines.push(`- Objective: ${state.objective}`);
		lines.push(`- Phase: ${state.phase}`);
		lines.push(`- Mode: ${state.mode}   Integrity: ${state.integrityMode}`);
		if (state.pattern) lines.push(`- Pattern: ${state.pattern}`);
		if (Number.isFinite(used) && Number.isFinite(budget)) {
			lines.push(`- Dispatches used: ${used} of ${budget}`);
		}
		lines.push('');

		const open = openMilestones(state);
		lines.push(`## Open milestones (${open.length})`, '');
		if (open.length === 0) {
			lines.push('None. The campaign is ready for final verification.', '');
		} else {
			for (const m of open) {
				lines.push(`### ${m.id}`, '');
				lines.push(`- Status: ${m.status}`);
				lines.push(`- Deliverable: ${m.deliverable}`);
				lines.push(`- Acceptance: ${m.acceptance}`);
				lines.push(`- Owner: ${m.owner_role}   Verifier: ${m.verified_by}`);
				if ((m.files ?? []).length > 0) lines.push(`- Files: ${m.files.join(', ')}`);
				if ((m.blocked_by ?? []).length > 0) lines.push(`- Blocked by: ${m.blocked_by.join(', ')}`);
				lines.push('');
			}
		}

		const gates = state.gates ?? [];
		if (gates.length > 0) {
			lines.push('## Gates so far', '');
			for (const gate of gates) {
				lines.push(`- ${gate.milestone}: ${gate.result}${gate.reason ? ` (${gate.reason})` : ''}`);
			}
			lines.push('');
		}
	}
	if (journal) {
		lines.push('## Journal', '');
		lines.push(`- Entries: ${journal.total}`);
		lines.push(`- Dispatches: ${journal.dispatches}`);
		if (journal.agents?.length > 0) lines.push(`- Roles dispatched: ${journal.agents.join(', ')}`);
		lines.push('');
	}
	lines.push('## What the successor must not do', '');
	lines.push('');
	lines.push('- Do not re-scope the campaign. The objective and the plan are decided.');
	lines.push('- Do not re-plan the milestones. Ownership is fixed; a new owner means two agents on one file.');
	lines.push('- Do not mark anything done without a verification record naming it.');
	lines.push('');
	lines.push('## First action', '');
	lines.push('');
	lines.push('Read campaign.json and plan.json, then continue the first open milestone.');
	return lines.join('\n');
}

/**
 * Assemble the inputs assessStaleness needs from a state directory.
 *
 * Kept separate so the assessment itself stays a pure function and can be tested
 * without a filesystem.
 */
export function assessFromPaths(paths, options = {}) {
	const state = options.state ?? null;
	let last = null;
	if (existsSync(paths.journal)) last = lastEventAt(paths.journal);
	else if (existsSync(paths.events)) last = lastEventAt(paths.events);
	return assessStaleness({state, lastEventAt: last, now: options.now, staleMinutes: options.staleMinutes});
}
