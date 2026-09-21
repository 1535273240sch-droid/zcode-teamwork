// Teamwork - execution patterns.
//
// A pattern is a named shape for a campaign: which roles exist, in what order work
// flows, what each gate demands, and which transitions are legal. The engine
// executes whatever pattern it is given; the pattern decides what "done" means for
// this kind of work.
//
// Why this is data rather than prose: the alternative is a different prompt for
// each kind of task, and prompts drift. A pattern is validated on load, so a
// campaign cannot start in a shape that has no gate - which is exactly the failure
// that produces confident, unverified output.
//
// Six patterns are defined, matching the reference implementation's set. They
// differ in what a milestone must produce, not in how many agents run:
//
//   distributed-coding   many independent files, parallel Workers
//   iterative-coding     one artifact refined until it passes
//   document-review      a document assessed against criteria
//   math-proof           a claim and its proof, checked for gaps
//   self-verification    work whose correctness is internal to itself
//   research             an open question answered with sources
//
// ASCII only: protocol artifact.

import {normalizePath} from './ownership.mjs';

/** Every role a pattern may name. Matches the agents shipped with the plugin. */
export const PATTERN_ROLES = [
	'sentinel',
	'orchestrator',
	'explorer',
	'worker',
	'critic',
	'challenger',
	'auditor',
	'success-auditor',
];

export const PATTERN_IDS = [
	'distributed-coding',
	'iterative-coding',
	'document-review',
	'math-proof',
	'self-verification',
	'research',
];

// Shared gate vocabulary. A gate names the roles that must report before a
// milestone passes and how many independent voices that means.
const GATE_INDEPENDENT = ['critic', 'auditor'];
const GATE_ADVERSARIAL = ['critic', 'challenger', 'auditor'];

export const PATTERNS = {
	'distributed-coding': {
		id: 'distributed-coding',
		title: 'Distributed coding',
		summary: 'Many files change independently; Workers run in parallel under exclusive file ownership.',
		whenToUse: 'The objective touches many files that do not depend on one another, and the work can be split without a shared interface changing midway.',
		roles: ['sentinel', 'orchestrator', 'explorer', 'worker', 'critic', 'challenger', 'auditor', 'success-auditor'],
		flow: ['sentinel', 'orchestrator', 'explorer', 'worker', 'critic', 'challenger', 'auditor', 'success-auditor'],
		milestoneDeliverable: 'code change',
		gate: {roles: GATE_ADVERSARIAL, minIndependent: 2},
		// The property that makes parallelism safe here, stated where a gate can read it.
		requiresDisjointFiles: true,
		requiresIndependentVerification: true,
	},

	'iterative-coding': {
		id: 'iterative-coding',
		title: 'Iterative coding',
		summary: 'One artifact refined until it passes; each round is verified before the next begins.',
		whenToUse: 'A single component has to satisfy a test, benchmark or spec that can be run repeatedly.',
		roles: ['orchestrator', 'worker', 'critic', 'auditor', 'success-auditor'],
		flow: ['orchestrator', 'worker', 'critic', 'auditor', 'success-auditor'],
		milestoneDeliverable: 'a revision that passes the stated check',
		gate: {roles: GATE_INDEPENDENT, minIndependent: 2},
		requiresDisjointFiles: false,
		requiresIndependentVerification: true,
		iteration: {maxRounds: 8, mustImprove: true},
	},

	'document-review': {
		id: 'document-review',
		title: 'Document review',
		summary: 'A document is assessed against explicit criteria by readers who did not write it.',
		whenToUse: 'The deliverable is written material and the question is whether it meets stated criteria, not whether it is pleasant to read.',
		roles: ['orchestrator', 'explorer', 'worker', 'critic', 'challenger', 'auditor'],
		flow: ['orchestrator', 'explorer', 'worker', 'critic', 'challenger', 'auditor'],
		milestoneDeliverable: 'document section meeting the stated criteria',
		gate: {roles: ['critic', 'challenger'], minIndependent: 2},
		requiresDisjointFiles: true,
		requiresIndependentVerification: true,
		criteriaRequired: true,
	},

	'math-proof': {
		id: 'math-proof',
		title: 'Math proof',
		summary: 'A claim and its proof, checked for gaps rather than for plausibility.',
		whenToUse: 'The deliverable is a derivation where one unproven step invalidates the whole, and where a wrong result would be acted on.',
		roles: ['orchestrator', 'worker', 'challenger', 'auditor', 'success-auditor'],
		flow: ['orchestrator', 'worker', 'challenger', 'auditor', 'success-auditor'],
		milestoneDeliverable: 'a stated claim with a proof',
		gate: {roles: ['challenger', 'auditor'], minIndependent: 2},
		requiresDisjointFiles: false,
		requiresIndependentVerification: true,
		// A proof is not improved by a second attempt at the same step; the gap has to
		// be named. FALSIFIED is therefore the expected first verdict far more often.
		forbidsSelfAuthoredFixtures: true,
	},

	'self-verification': {
		id: 'self-verification',
		title: 'Self-verification',
		summary: 'Work whose correctness is internal, verified by re-deriving the result by a different route.',
		whenToUse: 'A change to a tool or process that is only observable through the result it produces, and where a second independent derivation is possible.',
		roles: ['orchestrator', 'worker', 'challenger', 'auditor'],
		flow: ['orchestrator', 'worker', 'challenger', 'auditor'],
		milestoneDeliverable: 'a result and an independent derivation of it',
		gate: {roles: ['challenger', 'auditor'], minIndependent: 2},
		requiresDisjointFiles: false,
		requiresIndependentVerification: true,
		// The implementer may not supply the second derivation: two routes to a result
		// are only independent if different agents walked them.
		forbidsImplementerDerivation: true,
	},

	research: {
		id: 'research',
		title: 'Research',
		summary: 'An open question answered with sources, where every claim is checked against one.',
		whenToUse: 'The objective is to find out rather than to build, and the output will inform a decision.',
		roles: ['orchestrator', 'explorer', 'worker', 'critic', 'challenger', 'auditor'],
		flow: ['orchestrator', 'explorer', 'worker', 'critic', 'challenger', 'auditor'],
		milestoneDeliverable: 'an answer with the sources it rests on',
		gate: {roles: ['critic', 'challenger'], minIndependent: 2},
		requiresDisjointFiles: false,
		requiresIndependentVerification: true,
		requiresSources: true,
	},
};

/** Validate a pattern. Returns the problems, empty when usable. */
export function validatePattern(pattern) {
	const problems = [];
	if (pattern === null || typeof pattern !== 'object') return ['pattern is not an object'];
	if (typeof pattern.id !== 'string' || pattern.id.length === 0) problems.push('id is missing');
	if (!Array.isArray(pattern.roles) || pattern.roles.length === 0) problems.push('roles is empty');
	else {
		for (const role of pattern.roles) {
			if (!PATTERN_ROLES.includes(role)) problems.push(`unknown role "${role}"`);
		}
	}
	if (!Array.isArray(pattern.flow) || pattern.flow.length === 0) problems.push('flow is empty');
	if (!pattern.gate || !Array.isArray(pattern.gate.roles) || pattern.gate.roles.length === 0) {
		problems.push('gate has no roles');
	}
	// A pattern whose gate asks for one voice is a pattern with no verification, and
	// the whole point of a pattern is to state what verification looks like.
	if (pattern.gate && Number(pattern.gate.minIndependent) < 2) {
		problems.push('gate requires fewer than two independent voices');
	}
	// The implementer must not be its own verifier.
	if (Array.isArray(pattern.gate?.roles) && pattern.gate.roles.includes('worker')) {
		problems.push('gate includes worker, which implements the milestone');
	}
	return problems;
}

export function getPattern(id) {
	const pattern = PATTERNS[id];
	if (!pattern) return undefined;
	return pattern;
}

/** Load a pattern by id, reporting problems instead of returning something unusable. */
export function loadPattern(id) {
	const pattern = getPattern(id);
	if (!pattern) return {ok: false, reason: `unknown pattern "${id}"`, available: PATTERN_IDS};
	const problems = validatePattern(pattern);
	if (problems.length > 0) return {ok: false, reason: `pattern "${id}" is not usable: ${problems.join('; ')}`};
	return {ok: true, pattern};
}

/** All patterns, for a chooser to present. */
export function listPatterns() {
	return PATTERN_IDS.map((id) => {
		const {id: _id, title, summary, whenToUse} = PATTERNS[id];
		return {id, title, summary, whenToUse};
	});
}

/**
 * Suggest a pattern from the objective text.
 *
 * A hint, not a decision: it matches a few words and will be wrong on an objective
 * that is phrased unusually. It exists so the interview starts from a proposal the
 * human can reject, rather than from an open question they have to answer cold.
 */
export function suggestPattern(objective) {
	const text = String(objective ?? '').toLowerCase();
	if (/(prove|theorem|lemma|derivation|proof|invariant)/.test(text)) return 'math-proof';
	if (/(research|investigate|find out|survey|compare|which library|what is the best)/.test(text)) return 'research';
	if (/(readme|document|documentation|guide|specification|rfc|write up)/.test(text)) return 'document-review';
	if (/(benchmark|optimis|optimiz|performance|tune|speed up)/.test(text)) return 'iterative-coding';
	if (/(one component|single class|single function|rewrite the .* function|get .* passing)/.test(text)) return 'iterative-coding';
	if (/(refactor|migrat|rename|port|replace|across|every file|all call sites)/.test(text)) return 'distributed-coding';
	return 'distributed-coding';
}

/**
 * Whether a set of milestones is legal under a pattern.
 *
 * The checks that matter are the ones a pattern is chosen for: parallel milestones
 * need disjoint files, and every milestone needs a verifier that is not its own
 * implementer. A plan that violates these would run and then fail at a gate, after
 * the money was spent.
 */
export function checkPlanAgainstPattern(pattern, milestones) {
	const problems = [];
	const list = Array.isArray(milestones) ? milestones : [];

	if (list.length === 0) problems.push('the plan has no milestones');

	for (const milestone of list) {
		if (milestone?.owner_role && milestone?.verified_by && milestone.owner_role === milestone.verified_by) {
			problems.push(`milestone "${milestone.id}" would verify its own work`);
		}
		if (pattern.requiresIndependentVerification && !milestone?.verified_by) {
			problems.push(`milestone "${milestone.id}" has no verifier`);
		}
		if (pattern.criteriaRequired && !milestone?.acceptance) {
			problems.push(`milestone "${milestone.id}" has no acceptance criteria, which this pattern requires`);
		}
	}

	if (pattern.requiresDisjointFiles) {
		const owners = new Map();
		for (const milestone of list) {
			for (const file of milestone?.files ?? []) {
				const key = normalizePath(file);
				const holder = owners.get(key);
				if (holder && holder !== milestone.id) {
					problems.push(`"${file}" is claimed by both "${holder}" and "${milestone.id}"`);
				} else {
					owners.set(key, milestone.id);
				}
			}
		}
	}

	// Parallelism is only claimed when two milestones can start together; a plan
	// where every milestone depends on the last is a chain and needs no file
	// separation.
	const parallel = list.filter((m) => (m?.blocked_by ?? []).length === 0).length > 1;
	if (pattern.requiresDisjointFiles && parallel && list.every((m) => (m?.files ?? []).length === 0)) {
		problems.push(
			'the plan claims parallelism but declares no files, so ownership cannot be checked. ' +
				'Declare the files each milestone will touch.',
		);
	}

	return {ok: problems.length === 0, problems};
}

/** A pattern rendered for a human deciding whether it fits. */
export function describePattern(id) {
	const pattern = getPattern(id);
	if (!pattern) return `Unknown pattern "${id}".`;
	const lines = [
		`${pattern.title} (${pattern.id})`,
		pattern.summary,
		'',
		`Use when: ${pattern.whenToUse}`,
		`Flow: ${pattern.flow.join(' -> ')}`,
		`Gate: ${pattern.gate.roles.join(', ')} (at least ${pattern.gate.minIndependent} independent)`,
	];
	if (pattern.iteration) lines.push(`Iteration: up to ${pattern.iteration.maxRounds} rounds, each must improve on the last`);
	if (pattern.requiresDisjointFiles) lines.push('Requires disjoint files across parallel milestones');
	if (pattern.requiresSources) lines.push('Every claim must cite a source');
	if (pattern.forbidsSelfAuthoredFixtures) lines.push('Fixtures may not be authored by the implementer');
	if (pattern.forbidsImplementerDerivation) lines.push('The second derivation may not come from the implementer');
	return lines.join('\n');
}
