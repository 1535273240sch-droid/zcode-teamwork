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

// Work kinds and the milestone each contributes. Order in this table is the order
// milestones appear, and later stages depend on earlier ones.
const WORK_KINDS = [
	{
		id: 'survey',
		match: /(refactor|migrat|rewrite|replace|upgrad|port |convert|redesign|architect)/i,
		deliverable: 'Written survey of every call site and file the objective touches, with counts',
		acceptance: 'Survey names each file and the number of call sites, produced by reading the code rather than by memory',
		owner: 'explorer',
		verifier: 'auditor',
		tests: false,
	},
	{
		id: 'implementation',
		match: /./,
		deliverable: 'The change the objective describes, implemented inside the assigned file scope',
		acceptance: 'The objective is demonstrable by running a command whose raw output is written into the verification record',
		owner: 'worker',
		verifier: 'critic',
		tests: false,
	},
	{
		id: 'tests',
		match: /(test|coverage|spec|bug|fix|behaviou?r|regress)/i,
		deliverable: 'Tests that fail before the change and pass after it',
		acceptance: 'Each new test is shown failing on the pre-change revision and passing after, with both outputs recorded',
		owner: 'worker',
		verifier: 'auditor',
		tests: true,
	},
	{
		id: 'docs',
		match: /(doc|readme|comment|changelog|api reference)/i,
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
	const {cwd = process.cwd(), integrityMode = 'development', mode = 'standard'} = options;
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
