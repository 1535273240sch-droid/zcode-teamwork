// Teamwork - verification gates.
//
// Decides how much verification a milestone owes, and judges the verdicts that
// come back.
//
// The rule this file exists to enforce: the agent that implemented a milestone
// cannot be the agent that verifies it. That is not a stylistic preference. A
// verifier holding the implementer's assumptions re-derives the same conclusion
// and reports success, and the failure that follows is indistinguishable from
// success until a user hits it. So the sizing here counts *independent* voices
// only, and a self-review counts as zero.
//
// Sizing is by blast radius, not by milestone size. A one-line change to a shared
// parser touches more than a hundred-line change to a leaf file, and the failure
// it can cause is correspondingly larger.
//
// ASCII only: protocol artifact.

import {INTEGRITY_MODES} from './state.mjs';

/** Roles that may render a verdict. Anything else is not a verifier. */
export const VERIFIER_ROLES = ['critic', 'challenger', 'auditor', 'success-auditor', 'sentinel'];

/** Verdict tokens a record may carry. Kept in sync with the execute skill. */
export const VERDICTS = [
	'SOUND',
	'REPRODUCED',
	'SURVIVED',
	'FALSIFIED',
	'UNFALSIFIABLE',
	'DIVERGED',
	'CLEARED',
	'BLOCKED',
];

/** Verdicts that allow a milestone to pass. FALSIFIED and BLOCKED do not. */
export const PASSING_VERDICTS = ['SOUND', 'REPRODUCED', 'SURVIVED', 'CLEARED'];

// File counts at which a milestone earns additional scrutiny. The thresholds are
// deliberately coarse: a finer gradation would imply a precision this heuristic
// does not have.
const REVIEWER_THRESHOLDS = [
	{files: 12, reviewers: 3},
	{files: 5, reviewers: 2},
];

const CHALLENGER_THRESHOLDS = [
	{files: 8, challengers: 2},
	{files: 3, challengers: 1},
];

/**
 * How many independent verifiers a milestone needs.
 *
 * Returns the counts and the reasons for them, so a human reading a gate record
 * can see why this milestone got the scrutiny it did rather than assuming the
 * number was arbitrary.
 */
export function decideVerifiers(input) {
	const affectedFiles = Array.isArray(input?.affectedFiles) ? input.affectedFiles : [];
	const integrityMode = INTEGRITY_MODES.includes(input?.integrityMode) ? input.integrityMode : 'development';
	const milestoneMode = ['quick', 'standard', 'strict'].includes(input?.mode) ? input.mode : 'standard';
	const count = affectedFiles.length;
	const reasons = [];

	let reviewers;
	const reviewerTier = REVIEWER_THRESHOLDS.find((t) => count >= t.files);
	if (reviewerTier) {
		reviewers = reviewerTier.reviewers;
		reasons.push(`${count} files affected (>= ${reviewerTier.files})`);
	} else {
		reviewers = 1;
		reasons.push(count === 0 ? 'no files declared; assuming a narrow change' : `${count} files affected`);
	}

	let challengers;
	const challengerTier = CHALLENGER_THRESHOLDS.find((t) => count >= t.files);
	if (challengerTier) {
		challengers = challengerTier.challengers;
		reasons.push(`${count} files affected (>= ${challengerTier.files}) warrants an adversarial read`);
	} else {
		challengers = 0;
	}

	let auditor = 1;

	// Benchmark mode exists for numbers other people will act on, where a wrong
	// result is expensive to discover late.
	if (integrityMode === 'benchmark') {
		reviewers += 1;
		challengers = Math.max(challengers, 1);
		auditor = 1;
		reasons.push('benchmark mode: an extra independent read and a minimum of one challenger');
	}

	if (milestoneMode === 'strict') {
		reviewers += 1;
		challengers = Math.max(challengers, 1);
		reasons.push('strict mode: maximum scrutiny');
	}

	if (milestoneMode === 'quick') {
		reviewers = Math.max(1, reviewers - 1);
		challengers = Math.max(0, challengers - 1);
		auditor = 0;
		reasons.push('quick mode: reduced scrutiny, no auditor');
	}

	return {reviewers, challengers, auditor, total: reviewers + challengers + auditor, reasons};
}

/**
 * Build the review requests a gate should issue.
 *
 * Prompts are scoped to the milestone and the files, so a verifier is not asked to
 * re-read a whole repository and then opine broadly. A verifier told to "review
 * the change" produces generic commentary; one told which files changed and what
 * the acceptance line was produces something a gate can act on.
 */
export function scopedPrompts(milestone, sizing) {
	const files = (milestone?.files ?? []).join(', ') || '(no files declared)';
	const acceptance = milestone?.acceptance || '(no acceptance line recorded)';
	const deliverable = milestone?.deliverable || '(no deliverable recorded)';
	const base = [
		`Milestone: ${milestone?.id ?? '(unknown)'}`,
		`Deliverable: ${deliverable}`,
		`Acceptance: ${acceptance}`,
		`Files: ${files}`,
	].join('\n');

	const prompts = [];
	for (let i = 0; i < sizing.reviewers; i++) {
		prompts.push(`${base}\n\nAct as a reviewer. Judge the work against the acceptance line above. Attempt to reproduce the stated evidence yourself rather than trusting it.`);
	}
	for (let i = 0; i < sizing.challengers; i++) {
		prompts.push(`${base}\n\nAct as a challenger. Try to falsify the work. Look for the case the acceptance line does not cover, the input the implementation mishandles, and the claim that is true only under an assumption nobody wrote down.`);
	}
	for (let i = 0; i < sizing.auditor; i++) {
		prompts.push(`${base}\n\nAct as an auditor. Confirm the evidence is what it claims to be: the command was run, the output is raw rather than summarised, and the verdict follows from the output.`);
	}
	return prompts;
}

/**
 * Judge a set of verdicts for one milestone.
 *
 * Returns `passed` only when every independent voice agreed. A single FALSIFIED or
 * BLOCKED is enough to fail the gate: the point of an adversarial read is that it
 * takes one successful objection to invalidate a claim, not a majority.
 */
export function judgeGate(verdicts) {
	const list = Array.isArray(verdicts) ? verdicts : [];
	if (list.length === 0) {
		return {
			result: 'failed',
			reason: 'no verdicts were recorded',
			findings: ['A gate with no verifier output cannot pass; there is nothing to judge.'],
		};
	}

	const findings = [];
	const byRole = new Set();

	for (const entry of list) {
		const role = String(entry?.role ?? '').toLowerCase();
		const verdict = String(entry?.verdict ?? '').toUpperCase();

		if (role.length === 0) {
			findings.push('a verdict was submitted without naming the role that reached it');
			continue;
		}
		if (!VERIFIER_ROLES.includes(role)) {
			findings.push(`"${role}" is not a verification role and cannot render a verdict`);
			continue;
		}
		if (entry?.selfReview === true) {
			findings.push(`"${role}" reviewed work it implemented; a self-review is not verification`);
			continue;
		}
		if (!VERDICTS.includes(verdict)) {
			findings.push(`"${role}" returned "${entry?.verdict ?? ''}", which is not a recognised verdict`);
			continue;
		}
		byRole.add(role);
		if (!PASSING_VERDICTS.includes(verdict)) {
			findings.push(`${role} returned ${verdict}: ${entry?.reason ?? 'no reason recorded'}`);
		}
	}

	// One distinct verifier is the floor. Several verdicts from one role is one
	// opinion repeated, not agreement.
	if (byRole.size === 0) {
		return {result: 'failed', reason: 'no valid verdict from a verification role', findings};
	}

	if (findings.length > 0) {
		return {
			result: 'failed',
			reason: `${findings.length} objection(s) raised`,
			findings,
			verifiers: [...byRole],
		};
	}

	return {result: 'passed', reason: 'all independent verifiers agreed', findings: [], verifiers: [...byRole]};
}

/**
 * Check a written verification record for the properties the gate relies on.
 *
 * The gate reads records, so a record that never states a verdict or never names
 * its milestone is indistinguishable from a missing one. Reported separately from
 * judgeGate because the fix differs: one is "re-run the verification", the other
 * is "write down what happened".
 */
export function inspectRecord(text, milestoneId) {
	const problems = [];
	if (typeof text !== 'string' || text.length === 0) {
		return ['record is empty'];
	}
	if (!text.includes(milestoneId)) {
		problems.push(`record never names milestone "${milestoneId}"`);
	}
	const upper = text.toUpperCase();
	const found = VERDICTS.filter((v) => upper.includes(v));
	if (found.length === 0) {
		problems.push('record carries no recognised verdict');
	}
	if (!/verifier/i.test(text)) {
		problems.push('record does not name the verifying role');
	}
	if (!/(command|ran |executed|output)/i.test(text)) {
		problems.push('record does not show the command or its output');
	}
	return problems;
}

/** A repair workstream for a failed gate: the failure becomes the next task. */
export function createRepairWorkstream(milestone, findings, index = 1) {
	return {
		id: `repair-${milestone.id}-${index}`,
		milestone: milestone.id,
		role: milestone.owner_role ?? 'worker',
		status: 'pending',
		files: [...(milestone.files ?? [])],
		findings: [...findings],
	};
}
