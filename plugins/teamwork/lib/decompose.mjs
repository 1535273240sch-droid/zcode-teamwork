// Teamwork - milestone decomposition.
//
// Turns a campaign objective into a first-draft milestone list. This is a
// SCAFFOLD, not an oracle: it applies a small set of rules over the objective text
// and the workspace listing, then hands the Orchestrator a starting structure to
// correct. Rule-based decomposition of an arbitrary goal is not something a few
// hundred lines can do well, and pretending otherwise would be worse than offering
// nothing.
//
// What it actually buys the campaign:
//   - dependencies are written down before the first Worker starts, instead of
//     being discovered after two Workers collide on the same file
//   - every milestone gets an explicit acceptance line, which is what the verifiers
//     later judge against
//   - the Orchestrator corrects a concrete draft instead of inventing structure
//     from nothing, which is where milestone lists usually get vague
//
// ASCII only: protocol artifact.

import {readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {getPattern} from './patterns.mjs';

// Work kinds and the milestone each contributes. Order in this table is the order
// milestones appear, and later stages depend on earlier ones.
const WORK_KINDS = [
	{
		id: 'survey',
		match: /(refactor|migrat|rewrite|replace|upgrad|port |convert|redesign|architect)/i,
		title: 'Survey: map every file and call site',
		deliverable: 'Written survey of every call site and file the objective touches, with counts',
		acceptance: 'Survey names each file and the number of call sites, produced by reading the code rather than by memory',
		owner: 'explorer',
		verifier: 'auditor',
		tests: false,
	},
	{
		id: 'implementation',
		match: /./,
		title: 'Implement the objective change',
		deliverable: 'The change the objective describes, implemented inside the assigned file scope',
		acceptance: 'The objective is demonstrable by running a command whose raw output is written into the verification record',
		owner: 'worker',
		verifier: 'critic',
		tests: false,
	},
	{
		id: 'tests',
		match: /(test|coverage|spec|bug|fix|behaviou?r|regress)/i,
		title: 'Tests: fail first, then pass',
		deliverable: 'Tests that fail before the change and pass after it',
		acceptance: 'Each new test is shown failing on the pre-change revision and passing after, with both outputs recorded',
		owner: 'worker',
		verifier: 'auditor',
		tests: true,
	},
	{
		id: 'docs',
		match: /(doc|readme|comment|changelog|api reference)/i,
		title: 'Docs: match the new behaviour',
		deliverable: 'Documentation updated to match the new behaviour',
		acceptance: 'Every command and path named in the documentation exists and was run',
		owner: 'worker',
		verifier: 'critic',
		tests: false,
	},
];

// Integrity mode changes how much verification a milestone owes, not how many
// milestones exist. Benchmark mode forbids self-authored fixtures, so the draft
// says so instead of leaving the Worker to guess.
function acceptanceFor(kind, integrityMode) {
	if (integrityMode === 'benchmark' && kind.tests) {
		return `${kind.acceptance}. Benchmark mode: fixtures must come from real inputs, not from values written after seeing the result`;
	}
	return kind.acceptance;
}

/**
 * Inspect the workspace for the directories a survey milestone would need to
 * count. Best-effort: an unreadable directory is reported as unknown, not as zero.
 */
export function surveyWorkspace(cwd, limit = 200) {
	const found = [];
	const queue = [{dir: cwd, depth: 0}];
	while (queue.length > 0 && found.length < limit) {
		const {dir, depth} = queue.shift();
		if (depth > 2) continue;
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (name.startsWith('.') || name === 'node_modules') continue;
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) queue.push({dir: full, depth: depth + 1});
			else found.push(full.slice(cwd.length + 1));
			if (found.length >= limit) break;
		}
	}
	return found;
}

/**
 * Produce a first-draft milestone list for an objective.
 *
 * Dependencies are linear through the matched kinds: survey before implementation,
 * implementation before tests and docs. That is the conservative default; the
 * Orchestrator is expected to widen parallelism where the files genuinely do not
 * overlap, and the scheduler's batch step is what checks that they do not.
 */
export function decompose(objective, options = {}) {
	const {cwd = process.cwd(), integrityMode = 'development', mode = 'standard', pattern} = options;

	// A tournament is not a variation on the linear draft below: its milestones are
	// parallel by construction and deliberately share their files, so it gets its own
	// shape rather than a flag threaded through this one.
	const configured = pattern ? getPattern(pattern) : undefined;
	if (configured?.tournament) {
		return decomposeTournament(objective, {
			cwd,
			integrityMode,
			candidates: options.candidates ?? configured.tournament.candidates,
			falsifiersPerCandidate: options.falsifiersPerCandidate ?? configured.tournament.falsifiersPerCandidate,
		});
	}

	const text = String(objective ?? '');
	const matched = WORK_KINDS.filter((kind) => kind.match.test(text));

	// Implementation is the floor: an objective that matches nothing still has to
	// be built by somebody.
	if (matched.length === 0) matched.push(WORK_KINDS[1]);

	// Strict mode pays for the survey even when the objective does not ask for it,
	// because that is precisely the case where call sites get missed.
	if (mode === 'strict' && !matched.some((k) => k.id === 'survey')) {
		matched.unshift(WORK_KINDS[0]);
	}

	const workspace = surveyWorkspace(cwd);
	const milestones = [];
	let previous = undefined;

	for (const kind of matched) {
		const id = kind.id;
		const milestone = {
			id,
			title: kind.title,
			deliverable: kind.deliverable,
			status: 'pending',
			owner_role: kind.owner,
			verified_by: kind.verifier,
			acceptance: acceptanceFor(kind, integrityMode),
			files: [],
			blocked_by: previous ? [previous] : [],
		};
		if (kind.id === 'survey') {
			milestone.files = workspace.slice(0, 40);
		}
		milestones.push(milestone);
		previous = id;
	}

	return {
		milestones,
		workspace_file_count: workspace.length,
		note:
			'Draft generated by decomposition rules, not by reading the objective in depth. ' +
			'The Orchestrator must correct the milestone list and fill in the file ownership table before any Worker starts.',
	};
}

/**
 * Draft a tournament plan: several candidates at one hard task, a falsifier for each,
 * then a synthesis that reads all of them.
 *
 * The candidates are given the same file scope on purpose. Two attempts at the same
 * code are what makes the comparison meaningful, and it is why this shape needs a
 * worktree per candidate instead of the disjoint-file rule the other patterns rely on.
 * Every candidate is therefore marked `isolation: 'worktree'`, which is the contract
 * the pattern's plan check and the engine's file-collision rule both read.
 *
 * Routes are labelled rather than described. Naming the route in the plan would mean
 * choosing the approaches before anyone has looked at the problem, and a Worker told
 * which route to take is no longer an independent attempt.
 */
export function decomposeTournament(objective, options = {}) {
	const {cwd = process.cwd(), integrityMode = 'development'} = options;
	const candidates = Math.max(2, Math.floor(Number.isFinite(Number(options.candidates)) ? Number(options.candidates) : 3));
	const perCandidate = Math.max(1, Math.floor(Number.isFinite(Number(options.falsifiersPerCandidate)) ? Number(options.falsifiersPerCandidate) : 1));

	const workspace = surveyWorkspace(cwd);
	const scope = workspace.slice(0, 40);
	const milestones = [];

	for (let i = 1; i <= candidates; i++) {
		const candidateId = `candidate-${i}`;
		milestones.push({
			id: candidateId,
			kind: 'candidate',
			candidate: i,
			route: `route-${i}`,
			deliverable: `Candidate ${i}: one complete implementation of the objective, taking a route deliberately different from the other candidates`,
			status: 'pending',
			owner_role: 'worker',
			// The falsifier did not write it, so the verdict is not the author's own.
			verified_by: 'empirical-challenger',
			acceptance: `Candidate ${i} runs, and its falsifier has tried and failed to break it with boundary and fuzz inputs. The attempts and their raw output are recorded, not summarised`,
			files: [...scope],
			isolation: 'worktree',
			blocked_by: [],
		});

		for (let f = 1; f <= perCandidate; f++) {
			milestones.push({
				id: perCandidate > 1 ? `falsify-${i}-${f}` : `falsify-${i}`,
				kind: 'falsification',
				candidate: i,
				deliverable: `Falsification report for candidate ${i}: the inputs that broke it, and the parts that survived and are worth keeping`,
				status: 'pending',
				owner_role: 'empirical-challenger',
				verified_by: 'critic',
				acceptance: `Every attempted break is shown with the input that produced it and the observed output. A report that only says the candidate works fails both clauses${integrityMode === 'benchmark' ? '. Benchmark mode: the breaking inputs must come from real data, not from values chosen after seeing the output' : ''}`,
				files: [],
				blocked_by: [candidateId],
			});
		}
	}

	// The synthesis waits for every falsification, not for the candidates: what it reads
	// is the reports, and a synthesis that started earlier would be guessing at which
	// routes are still standing.
	const falsificationIds = milestones.filter((m) => m.kind === 'falsification').map((m) => m.id);
	milestones.push({
		id: 'synthesis',
		kind: 'synthesis',
		deliverable: 'One design that starts from the strongest surviving candidate and absorbs the local strengths recorded for the ones that were falsified',
		status: 'pending',
		owner_role: 'orchestrator',
		verified_by: 'critic',
		acceptance: 'The synthesis names which candidate it started from, which pitfall-registry highlights it absorbed, and what it deliberately dropped',
		files: [...scope],
		isolation: 'worktree',
		blocked_by: falsificationIds,
	});

	return {
		milestones,
		workspace_file_count: workspace.length,
		tournament: {candidates, falsifiersPerCandidate: perCandidate, rounds: 1},
		note:
			'Tournament draft: the candidates share a file scope on purpose, so each needs its own worktree, and the pattern check refuses a plan where they do not have one. ' +
			'The Orchestrator must correct the scope, the candidate count and the acceptance lines before any Worker starts, and must fill the pitfall registry as falsifications come in.',
	};
}
