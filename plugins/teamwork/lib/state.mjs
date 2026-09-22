// Teamwork - campaign state.
//
// The single source of truth for a campaign: which milestones exist, who owns
// which file, what the verification gates decided, and whether the campaign is
// still allowed to spend.
//
// The previous version of this plugin kept campaign state in ad-hoc JSON that
// every hook interpreted for itself. That worked while the only reader was a
// prompt, and stops working the moment code makes decisions from it: two callers
// disagree about what "done" means and neither is wrong, because nothing defined
// it. So the state here is typed, versioned, validated on read, and written
// atomically.
//
// Design rules:
//   - Every write goes through saveState. There is no partial-write path, because
//     a hook that dies mid-write must not leave a state file that parses but lies.
//   - loadState never throws on bad input. A corrupt file returns null and the
//     caller decides; crashing a hook would take the user's session with it.
//   - unknown fields survive a round trip. A newer version of the plugin writing
//     a field this version does not know about must not have it deleted by an
//     older hook that happens to run afterwards.
//
// ASCII only: protocol artifact.

import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync} from 'node:fs';
import {join, dirname} from 'node:path';

import {declare} from './ownership.mjs';

export const STATE_VERSION = 1;

// A UTF-8 byte-order mark makes JSON.parse throw, and every reader here treats that
// throw as "no campaign" - so a BOM silently disarms enforcement rather than raising
// anything. The state file is user-editable by design, and on Windows the obvious
// editors add a BOM by default (PowerShell 5.1 `Set-Content -Encoding UTF8`, Notepad's
// "UTF-8 with BOM"). Strip it before parsing so such an edit cannot turn the gate off
// invisibly. Kept local to this module so lib/ stays independent of hooks/.
export function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export const CAMPAIGN_PHASES = ['scoping', 'charter', 'approved', 'executing', 'verifying', 'complete', 'aborted'];

export const MILESTONE_STATUSES = ['pending', 'in_progress', 'verification', 'passed', 'failed'];

export const WORKSTREAM_STATUSES = ['pending', 'active', 'completed', 'failed'];

export const INTEGRITY_MODES = ['development', 'demo', 'benchmark'];

export const EXECUTION_PATHS = [
	'distributed-coding',
	'iterative-coding',
	'document-review',
	'math-proof',
	'self-verification',
];

/** Teamwork writes its bookkeeping here unless the campaign says otherwise. */
export const DEFAULT_STATE_DIR = '.teamwork';

export function resolveStateDir(cwd, configured) {
	if (typeof configured === 'string' && configured.length > 0) {
		return configured.startsWith('/') ? configured : join(cwd, configured);
	}
	return join(cwd, DEFAULT_STATE_DIR);
}

export function stateFilePaths(stateDir) {
	return {
		stateDir,
		state: join(stateDir, 'campaign.json'),
		plan: join(stateDir, 'plan.json'),
		events: join(stateDir, 'events.jsonl'),
		verifications: join(stateDir, 'verifications'),
		finalAudit: join(stateDir, 'final-audit.md'),
		journal: join(stateDir, 'journal.jsonl'),
		lock: join(stateDir, '.lock'),
	};
}

// ---------------------------------------------------------------------------
// Construction

/**
 * Build a campaign in its scoping phase.
 *
 * `objective` is required: a campaign without a stated objective cannot be
 * verified against anything, and every downstream gate would be judging nothing.
 */
export function createCampaign(input) {
	const now = new Date().toISOString();
	const objective = typeof input?.objective === 'string' ? input.objective.trim() : '';
	if (objective.length === 0) {
		throw new Error('createCampaign: objective is required');
	}

	const integrityMode = INTEGRITY_MODES.includes(input?.integrityMode) ? input.integrityMode : 'development';
	const executionPath = EXECUTION_PATHS.includes(input?.executionPath) ? input.executionPath : 'distributed-coding';
	const mode = ['quick', 'standard', 'strict'].includes(input?.mode) ? input.mode : 'standard';

	return {
		version: STATE_VERSION,
		objective,
		mode,
		integrityMode,
		executionPath,
		pattern: typeof input?.pattern === 'string' && input.pattern.length > 0 ? input.pattern : 'distributed-coding',
		phase: 'scoping',
		approved: false,
		createdAt: now,
		updatedAt: now,
		milestones: [],
		workstreams: [],
		ownership: [],
		gates: [],
		metadata: {
			cwd: typeof input?.cwd === 'string' ? input.cwd : process.cwd(),
			stateDir: DEFAULT_STATE_DIR,
		},
	};
}

/** A milestone before it has an identity. */
export function createMilestone(input) {
	const id = typeof input?.id === 'string' ? input.id.trim() : '';
	if (id.length === 0) throw new Error('createMilestone: id is required');
	const status = MILESTONE_STATUSES.includes(input?.status) ? input.status : 'pending';
	return {
		id,
		deliverable: typeof input?.deliverable === 'string' ? input.deliverable : '',
		status,
		owner_role: typeof input?.owner_role === 'string' ? input.owner_role : 'worker',
		verified_by: typeof input?.verified_by === 'string' ? input.verified_by : 'critic',
		acceptance: typeof input?.acceptance === 'string' ? input.acceptance : '',
		files: Array.isArray(input?.files) ? [...input.files] : [],
		blocked_by: Array.isArray(input?.blocked_by) ? [...input.blocked_by] : [],
		verified: false,
		evidence: [],
	};
}

/** A unit of work assigned to one role inside one milestone. */
export function createWorkstream(input) {
	const id = typeof input?.id === 'string' ? input.id.trim() : '';
	if (id.length === 0) throw new Error('createWorkstream: id is required');
	const status = WORKSTREAM_STATUSES.includes(input?.status) ? input.status : 'pending';
	return {
		id,
		milestone: typeof input?.milestone === 'string' ? input.milestone : '',
		role: typeof input?.role === 'string' ? input.role : 'worker',
		status,
		files: Array.isArray(input?.files) ? [...input.files] : [],
	};
}

// ---------------------------------------------------------------------------
// Reading

/**
 * Validate a parsed state object.
 *
 * Returns a list of problems, empty when the state is usable. Structural only:
 * whether a milestone is *true* is not something this layer can know.
 */
export function validateCampaign(state) {
	const problems = [];
	if (state === null || typeof state !== 'object' || Array.isArray(state)) {
		return ['state is not an object'];
	}
	if (typeof state.version !== 'number') problems.push('version is missing');
	else if (state.version > STATE_VERSION) {
		problems.push(`state version ${state.version} is newer than this plugin understands (${STATE_VERSION})`);
	}
	if (typeof state.objective !== 'string' || state.objective.length === 0) problems.push('objective is missing');
	if (!CAMPAIGN_PHASES.includes(state.phase)) problems.push(`phase "${state.phase}" is not recognised`);

	if (!Array.isArray(state.milestones)) problems.push('milestones is not an array');
	else {
		const seen = new Set();
		for (const milestone of state.milestones) {
			if (typeof milestone?.id !== 'string' || milestone.id.length === 0) {
				problems.push('a milestone has no id');
				continue;
			}
			if (seen.has(milestone.id)) problems.push(`duplicate milestone id "${milestone.id}"`);
			seen.add(milestone.id);
			if (!MILESTONE_STATUSES.includes(milestone.status)) {
				problems.push(`milestone "${milestone.id}" has status "${milestone.status}"`);
			}
		}
	}

	if (state.workstreams !== undefined && !Array.isArray(state.workstreams)) problems.push('workstreams is not an array');
	if (state.ownership !== undefined && !Array.isArray(state.ownership)) problems.push('ownership is not an array');
	return problems;
}

/**
 * Read campaign state. Returns null when the file is absent, unparseable, or
 * structurally broken - never throws, because every caller is a hook running
 * inside a live session.
 *
 * Problems are attached as a non-enumerable `_problems` so a caller that wants to
 * report them can, without them leaking into a round trip through JSON.
 */
export function loadCampaign(path, options = {}) {
	if (!existsSync(path)) return null;
	let parsed;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, 'utf8')));
	} catch {
		return null;
	}
	const problems = validateCampaign(parsed);
	if (problems.length > 0 && options.tolerant !== true) return null;
	Object.defineProperty(parsed, '_problems', {value: problems, enumerable: false});
	return parsed;
}

// ---------------------------------------------------------------------------
// Writing

/**
 * Write campaign state atomically.
 *
 * Writes to a sibling temp file and renames over the target: rename is atomic on
 * every platform this runs on, so a reader sees either the old file or the new
 * one and never a half-written one. A hook that is killed mid-write leaves the
 * previous state intact, which is the correct outcome - the campaign resumes from
 * the last thing that actually happened.
 */
export function saveCampaign(state, path) {
	if (state === null || typeof state !== 'object') throw new Error('saveCampaign: state is required');
	const dir = dirname(path);
	mkdirSync(dir, {recursive: true});

	const problems = validateCampaign(state);
	if (problems.length > 0) {
		throw new Error(`saveCampaign: refusing to write invalid state: ${problems.join('; ')}`);
	}

	const next = {...state, updatedAt: new Date().toISOString()};
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(next, null, 2));
		renameSync(temp, path);
	} catch (error) {
		// Leaving a temp file behind would accumulate; removing it must not mask the
		// original failure.
		try {
			if (existsSync(temp)) unlinkSync(temp);
		} catch {
			// ignore
		}
		throw error;
	}
	return next;
}

/** Apply a pure change to campaign state and persist it. */
export function updateCampaign(path, mutator) {
	const current = loadCampaign(path, {tolerant: true});
	if (current === null) throw new Error('updateCampaign: no valid state to update');
	const next = mutator(current);
	return saveCampaign(next, path);
}

// ---------------------------------------------------------------------------
// Transitions

/** Move through the campaign lifecycle. Returns the new state; throws on an illegal move. */
export function setPhase(state, phase) {
	if (!CAMPAIGN_PHASES.includes(phase)) throw new Error(`setPhase: unknown phase "${phase}"`);
	const order = ['scoping', 'charter', 'approved', 'executing', 'verifying', 'complete'];
	const from = order.indexOf(state.phase);
	const to = order.indexOf(phase);
	// Aborted is reachable from anywhere and terminal; the linear phases only move
	// forward, so a hook running late cannot rewind a campaign that already finished.
	if (phase !== 'aborted' && from >= 0 && to >= 0 && to < from) {
		throw new Error(`setPhase: cannot move from "${state.phase}" back to "${phase}"`);
	}
	// Approval is the gate on spending. Without it, a campaign can reach execution
	// while the human has never seen the charter, which is the one decision the whole
	// two-phase flow exists to protect.
	const spendPhases = ['executing', 'verifying', 'complete'];
	if (spendPhases.includes(phase) && state.approved !== true && phase !== 'approved') {
		throw new Error(`setPhase: cannot move to "${phase}" before the charter is approved`);
	}
	return {...state, phase, approved: phase === 'approved' || state.approved};
}

export function setMilestoneStatus(state, id, status) {
	if (!MILESTONE_STATUSES.includes(status)) throw new Error(`setMilestoneStatus: unknown status "${status}"`);
	const milestones = state.milestones.map((m) => (m.id === id ? {...m, status} : m));
	if (!milestones.some((m) => m.id === id)) throw new Error(`setMilestoneStatus: no milestone "${id}"`);
	return {...state, milestones};
}

export function setWorkstreamStatus(state, id, status) {
	if (!WORKSTREAM_STATUSES.includes(status)) throw new Error(`setWorkstreamStatus: unknown status "${status}"`);
	if (!state.workstreams.some((w) => w.id === id)) throw new Error(`setWorkstreamStatus: no workstream "${id}"`);
	return {...state, workstreams: state.workstreams.map((w) => (w.id === id ? {...w, status} : w))};
}

export function addMilestone(state, milestone) {
	if (state.milestones.some((m) => m.id === milestone.id)) {
		throw new Error(`addMilestone: duplicate id "${milestone.id}"`);
	}
	const files = milestone.files ?? [];
	for (const file of files) {
		const holder = state.ownership.find((entry) => entry.file === file);
		if (holder && holder.milestone !== milestone.id) {
			throw new Error(
				`addMilestone: "${file}" is already owned by milestone "${holder.milestone}"; ` +
					'a file has exactly one owner for the life of the campaign',
			);
		}
	}
	const ownership = [
		...state.ownership,
		...files.map((file) => declare({file, milestone: milestone.id, role: milestone.owner_role ?? 'worker'})),
	];
	return {...state, milestones: [...state.milestones, milestone], ownership};
}

/**
 * Record a verification gate outcome.
 *
 * Only `passed` marks a milestone verified. A gate that returned `failed` leaves
 * the milestone unverified on purpose: the next step is a repair workstream, not a
 * promotion.
 */
export function recordGate(state, gate) {
	const gates = [...(state.gates ?? []), gate];
	const milestones = state.milestones.map((m) =>
		m.id === gate.milestone
			? {...m, verified: gate.result === 'passed', status: gate.result === 'passed' ? 'passed' : m.status}
			: m,
	);
	return {...state, gates, milestones};
}

// ---------------------------------------------------------------------------
// Interpretation

export function findMilestone(state, id) {
	return state?.milestones?.find((m) => m.id === id);
}

/** Open = not yet verified. Work in progress is open; so is work that failed. */
export function openMilestones(state) {
	return (state?.milestones ?? []).filter((m) => m.verified !== true);
}

export function isCampaignActive(state) {
	if (state === null || typeof state !== 'object') return false;
	if (state.phase === 'aborted') return false;
	if (state.approved !== true) return false;
	return ['approved', 'executing', 'verifying'].includes(state.phase);
}

/** A campaign is finished when it is complete and every milestone is verified. */
export function isCampaignComplete(state) {
	return state?.phase === 'complete' && openMilestones(state).length === 0;
}

/**
 * Count dispatch events the hook actually recorded in the event trail.
 *
 * Dispatches are recorded by audit-log.mjs on PostToolUse, so this trail - not the
 * engine's own journal - is the authority on how many Subagents were really started.
 * The engine previously read the count from its journal, which no hook ever writes
 * dispatch entries to, so `status` and `succession` reported "Dispatches: 0" for a
 * campaign that had already dispatched. A cost counter that reads zero while spending
 * is the failure mode the budget exists to prevent, so the two must share one source.
 */
export function countDispatches(eventsPath) {
	if (!existsSync(eventsPath)) return 0;
	let text;
	try {
		text = readFileSync(eventsPath, 'utf8');
	} catch {
		return 0;
	}
	let count = 0;
	for (const line of stripBom(text).split('\n')) {
		if (line.length === 0) continue;
		// Substring test first: this runs on the critical path of every dispatch.
		if (!line.includes('"dispatch"')) continue;
		try {
			if (JSON.parse(line)?.event === 'dispatch') count++;
		} catch {
			// a torn line at the tail of the log is not a dispatch
		}
	}
	return count;
}
