// Teamwork - the orchestration engine.
//
// This is the piece the plugin was missing: a place where the campaign's rules are
// expressed as code that can be called, rather than as prose that has to be
// remembered.
//
// What "engine" means here, precisely. This module does NOT drive the session and
// does not decide when to dispatch. It cannot: on this platform only the model can
// start a Subagent, and a process hook cannot hold a timer. So the engine is a
// service the orchestrating agent calls - plan this, schedule that, judge these
// verdicts, hand off here - and every rule it enforces is enforced at the moment it
// is asked, not continuously.
//
// That distinction matters for reading the rest of this file: when a function here
// refuses something, the refusal is real and the caller cannot proceed; but nothing
// here will notice a violation on its own. The hooks are what notice. The engine
// decides, the hooks observe.
//
// State access goes through state.mjs; this module never writes files directly.
//
// ASCII only: protocol artifact.

import {
	STATE_VERSION,
	createCampaign,
	createMilestone,
	createWorkstream,
	loadCampaign,
	saveCampaign,
	setPhase,
	setMilestoneStatus,
	addMilestone as addMilestoneToState,
	recordGate,
	openMilestones,
	isCampaignActive,
	isCampaignComplete,
	findMilestone,
	resolveStateDir,
	stateFilePaths,
} from './state.mjs';

import {decompose} from './decompose.mjs';
import {schedule, DEFAULT_SPAWN_BUDGET} from './scheduler.mjs';
import {decideVerifiers, scopedPrompts, judgeGate, createRepairWorkstream} from './verification.mjs';
import {claim, release, checkWrite, findCollisions, expiredEntries} from './ownership.mjs';
import {createEvent, appendEvent, summarize} from './journal.mjs';
import {assessFromPaths, buildHandoff, renderHandoff} from './handoff.mjs';

/**
 * A campaign's control surface.
 *
 * Constructed with a working directory; every method reads and writes through the
 * state files, so two engine instances pointed at one campaign see the same
 * campaign - which is the point, because the hooks construct their own.
 */
export class TeamworkEngine {
	constructor(options = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.stateDir = resolveStateDir(this.cwd, options.stateDir);
		this.paths = stateFilePaths(this.stateDir);
		this.budget = Number.isFinite(options.budget) ? options.budget : DEFAULT_SPAWN_BUDGET;
	}

	// -- state access ------------------------------------------------------

	load() {
		return loadCampaign(this.paths.state, {tolerant: true});
	}

	save(state) {
		return saveCampaign(state, this.paths.state);
	}

	/** Record a journal entry alongside a state change. Failures are not fatal. */
	log(kind, payload) {
		appendEvent(this.paths.journal, createEvent(kind, payload));
	}

	// -- lifecycle ---------------------------------------------------------

	/**
	 * Begin a campaign in the scoping phase.
	 *
	 * Refuses when any campaign state already exists. A campaign in scoping looks
	 * inert - nothing has been approved, no Worker has run - but it holds the scoping
	 * interview, which is the most expensive part of the process to redo. Overwriting
	 * it silently would discard that work as a side effect of running one command, so
	 * starting over is opt-in via `force`.
	 */
	initProject(input) {
		const existing = this.load();
		if (existing && input?.force !== true) {
			const running = isCampaignActive(existing);
			return {
				ok: false,
				reason: running
					? `a campaign is already active (phase "${existing.phase}", objective: ${existing.objective})`
					: `campaign state already exists (phase "${existing.phase}", objective: ${existing.objective}); ` +
						'pass force to replace it deliberately',
				existing: {phase: existing.phase, objective: existing.objective},
			};
		}
		const state = createCampaign({...input, cwd: this.cwd});
		state.metadata.stateDir = input?.stateDir ?? '.teamwork';
		const saved = this.save(state);
		this.log('campaign-created', {objective: saved.objective, mode: saved.mode, replaced: existing !== null});
		return {ok: true, state: saved};
	}

	/** Mark the charter approved and move into execution. Requires at least one milestone. */
	approve() {
		let state = this.load();
		if (!state) return {ok: false, reason: 'no campaign to approve'};
		if (state.milestones.length === 0) {
			return {ok: false, reason: 'a campaign with no milestones has nothing to approve'};
		}
		state = setPhase(state, state.phase === 'scoping' ? 'charter' : state.phase);
		state = setPhase(state, 'approved');
		const saved = this.save(state);
		this.log('charter-approved', {milestones: saved.milestones.length});
		return {ok: true, state: saved};
	}

	/** Move to a later phase. Rejects moves that go backwards. */
	advance(phase) {
		const state = this.load();
		if (!state) return {ok: false, reason: 'no campaign'};
		try {
			const saved = this.save(setPhase(state, phase));
			this.log('phase-changed', {phase});
			return {ok: true, state: saved};
		} catch (error) {
			return {ok: false, reason: error.message};
		}
	}

	cancel(reason) {
		const state = this.load();
		if (!state) return {ok: false, reason: 'no campaign'};
		const saved = this.save(setPhase(state, 'aborted'));
		this.log('cancel', {reason: reason ?? 'cancel requested'});
		return {ok: true, state: saved};
	}

	// -- planning ----------------------------------------------------------

	/**
	 * Draft a milestone list for the campaign objective.
	 *
	 * Returns a draft, not a decision. The caller is expected to correct it: the
	 * decomposition is rule-based and cannot read the code, so its value is that the
	 * correction starts from something concrete.
	 */
	decompose(input = {}) {
		const state = this.load();
		const objective = input.objective ?? state?.objective;
		if (typeof objective !== 'string' || objective.length === 0) {
			return {ok: false, reason: 'decompose needs an objective'};
		}
		const draft = decompose(objective, {
			cwd: this.cwd,
			mode: state?.mode ?? 'standard',
			integrityMode: state?.integrityMode ?? 'development',
		});
		return {ok: true, ...draft};
	}

	/**
	 * Accept a milestone list as the campaign plan.
	 *
	 * Validates before committing: dependencies must resolve, ids must be unique, no
	 * two milestones may claim one file. Each of those becomes a runtime refusal
	 * later if it is not caught here, and a runtime refusal mid-campaign costs the
	 * work already done.
	 */
	createPlan(milestones) {
		let state = this.load();
		if (!state) return {ok: false, reason: 'no campaign'};
		if (!Array.isArray(milestones) || milestones.length === 0) {
			return {ok: false, reason: 'createPlan needs at least one milestone'};
		}

		const ids = new Set();
		for (const raw of milestones) {
			const id = String(raw?.id ?? '');
			if (id.length === 0) return {ok: false, reason: 'a milestone has no id'};
			if (ids.has(id)) return {ok: false, reason: `duplicate milestone id "${id}"`};
			ids.add(id);
		}
		for (const raw of milestones) {
			for (const dep of raw?.blocked_by ?? []) {
				if (!ids.has(dep)) {
					return {ok: false, reason: `milestone "${raw.id}" is blocked_by unknown milestone "${dep}"`};
				}
			}
		}

		const proposed = milestones.flatMap((m) => (m.files ?? []).map((file) => ({file, milestone: m.id})));
		const fileCollisions = findCollisions(proposed);
		if (fileCollisions.length > 0) {
			return {
				ok: false,
				reason:
					'two milestones claim the same file, so they can never run at the same time: ' +
					fileCollisions.map((c) => `${c.file} (${c.milestones.join(', ')})`).join('; '),
				collisions: fileCollisions,
			};
		}

		// Rebuild from scratch so a re-plan does not inherit stale ownership.
		state = {...state, milestones: [], ownership: [], gates: [], workstreams: []};
		for (const raw of milestones) {
			state = addMilestoneToState(state, createMilestone(raw));
		}
		const saved = this.save(state);
		this.log('plan-created', {milestones: saved.milestones.length});
		return {ok: true, state: saved};
	}

	/** Batches, dispatch count, and the two failure modes the scheduler exists to catch. */
	getSchedule() {
		const state = this.load();
		if (!state) return {ok: false, reason: 'no campaign'};
		if (state.milestones.length === 0) return {ok: false, reason: 'no plan to schedule'};
		return schedule(state.milestones, {budget: this.budget});
	}

	/**
	 * Workstreams for one milestone, so ownership and execution agree on scope.
	 */
	getScheduleForMilestone(milestoneId) {
		const state = this.load();
		const milestone = findMilestone(state, milestoneId);
		if (!milestone) return {ok: false, reason: `no milestone "${milestoneId}"`};
		return {
			ok: true,
			milestone: milestone.id,
			files: milestone.files ?? [],
			owner_role: milestone.owner_role,
			verified_by: milestone.verified_by,
			acceptance: milestone.acceptance,
		};
	}

	// -- ownership ---------------------------------------------------------

	/** Claim a file for a milestone. Refuses when another milestone holds it. */
	claimFile(file, milestoneId, options = {}) {
		let state = this.load();
		if (!state) return {ok: false, reason: 'no campaign'};
		const result = claim(state.ownership, {
			file,
			milestone: milestoneId,
			role: options.role ?? 'worker',
			leaseMinutes: options.leaseMinutes,
		});
		if (!result.ok) return result;

		const ownership = result.replaced
			? state.ownership.filter((e) => e.file !== result.entry.file).concat(result.entry)
			: state.ownership.concat(result.entry);
		const saved = this.save({...state, ownership});
		this.log('ownership-claimed', {file: result.entry.file, milestone: milestoneId});
		return {ok: true, entry: result.entry, state: saved};
	}

	releaseFile(file, milestoneId) {
		const state = this.load();
		if (!state) return {ok: false, reason: 'no campaign'};
		const result = release(state.ownership, file, milestoneId);
		if (!result.ok) return result;
		const saved = this.save({...state, ownership: result.ownership});
		this.log('ownership-released', {file, milestone: milestoneId});
		return {ok: true, state: saved};
	}

	/** Whether a milestone may write a file right now. */
	canWrite(file, milestoneId) {
		const state = this.load();
		if (!state) return {allowed: false, reason: 'no campaign'};
		return checkWrite(state.ownership, file, milestoneId);
	}

	/** Leases that lapsed while their milestones are still open. */
	expiredLeases() {
		const state = this.load();
		if (!state) return [];
		return expiredEntries(state.ownership);
	}

	// -- verification ------------------------------------------------------

	/**
	 * Sizing and prompts for one milestone's verification.
	 *
	 * The counts come from blast radius, and the prompts are scoped to the milestone
	 * so a verifier is asked a question it can answer rather than asked to judge a
	 * change it has not been shown.
	 */
	planVerification(milestoneId, options = {}) {
		const state = this.load();
		const milestone = findMilestone(state, milestoneId);
		if (!milestone) return {ok: false, reason: `no milestone "${milestoneId}"`};
		const sizing = decideVerifiers({
			affectedFiles: options.affectedFiles ?? milestone.files ?? [],
			integrityMode: state.integrityMode,
			mode: state.mode,
		});
		return {ok: true, sizing, prompts: scopedPrompts(milestone, sizing)};
	}

	/**
	 * Judge verdicts and record the gate.
	 *
	 * A failed gate creates a repair workstream rather than leaving the milestone
	 * dangling: the failure becomes the next task, with the findings attached.
	 */
	verifyMilestone(milestoneId, verdicts, options = {}) {
		let state = this.load();
		const milestone = findMilestone(state, milestoneId);
		if (!milestone) return {ok: false, reason: `no milestone "${milestoneId}"`};

		const judgement = judgeGate(verdicts);
		const gate = {
			milestone: milestoneId,
			result: judgement.result,
			reason: judgement.reason,
			findings: judgement.findings,
			verifiers: judgement.verifiers ?? [],
			evidence: options.evidence ?? [],
			at: new Date().toISOString(),
		};

		state = recordGate(state, gate);

		let repair = null;
		if (judgement.result !== 'passed') {
			const existing = state.workstreams.filter((w) => w.milestone === milestoneId && w.id.startsWith('repair-')).length;
			repair = createRepairWorkstream(milestone, judgement.findings, existing + 1);
			state = {...state, workstreams: [...state.workstreams, createWorkstream(repair)]};
		}

		const saved = this.save(state);
		this.log('gate-recorded', {milestone: milestoneId, result: judgement.result});
		if (repair) this.log('repair-created', {milestone: milestoneId, findings: judgement.findings.length});
		return {ok: true, gate, repair, state: saved};
	}

	/** Final audit over every milestone. Refuses while any milestone is open. */
	finalVerification(verdicts) {
		let state = this.load();
		if (!state) return {ok: false, reason: 'no campaign'};
		const open = openMilestones(state);
		if (open.length > 0) {
			return {
				ok: false,
				reason: `${open.length} milestone(s) are still unverified (${open.map((m) => m.id).join(', ')})`,
			};
		}
		const judgement = judgeGate(verdicts);
		if (judgement.result !== 'passed') return {ok: false, ...judgement};
		state = setPhase(state, 'complete');
		const saved = this.save(state);
		this.log('gate-recorded', {milestone: '(final)', result: 'passed', verifiers: judgement.verifiers});
		return {ok: true, state: saved};
	}

	// -- continuity --------------------------------------------------------

	/** Whether the campaign looks stalled, and why. */
	staleness(options = {}) {
		const state = this.load();
		return assessFromPaths(this.paths, {state, now: options.now, staleMinutes: options.staleMinutes});
	}

	/** What a fresh session needs in order to continue this campaign. */
	handoff(reason) {
		const state = this.load();
		const built = buildHandoff(state, {reason});
		if (built.ok) this.log('handoff', {reason: built.reason, open: built.openMilestones.length});
		return built;
	}

	renderHandoff(reason) {
		return renderHandoff(this.handoff(reason));
	}

	// -- reporting ---------------------------------------------------------

	/** A single view of everything a reader needs, from one consistent read. */
	status() {
		const state = this.load();
		if (!state) return {ok: false, reason: 'no campaign'};
		const journal = summarize(this.paths.journal);
		const open = openMilestones(state);
		return {
			ok: true,
			objective: state.objective,
			phase: state.phase,
			mode: state.mode,
			integrityMode: state.integrityMode,
			version: state.version,
			milestones: state.milestones.map((m) => ({
				id: m.id,
				status: m.status,
				verified: m.verified === true,
				owner_role: m.owner_role,
				files: m.files ?? [],
			})),
			open: open.map((m) => m.id),
			workstreams: state.workstreams ?? [],
			ownership: state.ownership ?? [],
			gates: state.gates ?? [],
			journal,
			complete: isCampaignComplete(state),
		};
	}
}

/** Convenience constructor. */
export function openEngine(options) {
	return new TeamworkEngine(options);
}

export {STATE_VERSION, isCampaignActive, isCampaignComplete, openMilestones};
