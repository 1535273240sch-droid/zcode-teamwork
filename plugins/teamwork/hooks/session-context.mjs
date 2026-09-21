#!/usr/bin/env node
// Teamwork - inject the active campaign charter at session start.
//
// SessionStart hook, matcher `*`. On ANY session source (startup, clear, compact,
// resume, or anything the runtime adds later) the model sees the objective, the
// integrity mode, the plan, and the role protocol before its first turn, so a
// resumed or newly opened session continues the campaign instead of drifting.
//
// The matcher is deliberately source-agnostic rather than an enumerated list: a
// resumed session is the longest-running and most drift-prone case there is, and an
// enumerated list silently stops covering sources the runtime adds later.
//
// No-op when there is no active campaign.
//
// ASCII only: this file is a protocol artifact and crosses an encoding boundary.

import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
	readStdin,
	statePaths,
	loadCampaign,
	VERIFICATIONS_DIR,
	FINAL_AUDIT_NAME,
} from './_lib.mjs';

function emit(obj) {
	process.stdout.write(JSON.stringify(obj));
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

function verificationFiles(stateDir) {
	const dir = join(stateDir, VERIFICATIONS_DIR);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir).filter((name) => name.endsWith('.md'));
	} catch {
		return [];
	}
}

const raw = await readStdin();

let input;
try {
	input = JSON.parse(raw);
} catch {
	process.exit(0);
}

const cwd = input.cwd || process.cwd();
const paths = statePaths(cwd);

if (!existsSync(paths.campaign)) process.exit(0);

const campaign = loadCampaign(paths.campaign);
if (!campaign) process.exit(0);

const lines = [];

lines.push('A Teamwork campaign is active in this workspace.');

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(pluginRoot, 'scripts', 'teamwork.mjs');
lines.push(`TEAMWORK_CLI: node ${cliPath}`);
lines.push('');

if (campaign.objective) lines.push(`Objective: ${campaign.objective}`);
if (campaign.integrity_mode) lines.push(`Integrity mode: ${campaign.integrity_mode}`);
if (campaign.pattern) lines.push(`Pattern: ${campaign.pattern}`);
if (campaign.working_directory) lines.push(`Working directory: ${campaign.working_directory}`);
if (campaign.phase) lines.push(`Phase: ${campaign.phase}`);
if (campaign.approved !== true) {
	lines.push('Approval: NOT APPROVED. The ownership hooks are inert. Do not dispatch Workers yet.');
}

if (existsSync(paths.mode)) {
	try {
		const mode = readJson(paths.mode);
		if (mode?.max_parallel === 1) {
			lines.push('');
			lines.push('Campaign degraded to serial: \u672c campaign \u5df2\u964d\u7ea7\u4e3a\u4e32\u884c\uff0c\u540c\u4e00\u65f6\u523b\u53ea\u6d3e\u4e00\u4e2a Worker\u3002');
		}
	} catch {}
}

const progressPath = join(paths.stateDir, 'progress.json');
if (existsSync(progressPath)) {
	try {
		const prog = readJson(progressPath);
		const stallMinutes = Number(campaign?.stall_minutes) || 30;
		const stallMs = Math.max(5, Math.min(1440, stallMinutes)) * 60 * 1000;
		const now = Date.now();
		for (const [mId, mData] of Object.entries(prog.milestones || {})) {
			if (mData.status === 'in-progress' && mData.last_heartbeat) {
				const hb = new Date(mData.last_heartbeat).getTime();
				if (now - hb > stallMs) {
					lines.push('');
					lines.push(`Stall alert: \u91cc\u7a0b\u7891 ${mId} \u7591\u4f3c\u5361\u6b7b\uff0c\u5efa\u8bae\u91cd\u6d3e\u3002`);
				}
			}
		}
	} catch {}
}

const handoffPath = join(paths.stateDir, 'handoff.md');
if (existsSync(handoffPath)) {
	try {
		const handoffText = readFileSync(handoffPath, 'utf8').trim();
		if (handoffText.length > 0) {
			lines.push('');
			lines.push('Milestone handoff context (.teamwork/handoff.md):');
			lines.push(handoffText);
		}
	} catch {}
}

function readRecentKnowledge(filePath, maxBytes = 2048) {
	if (!existsSync(filePath)) return '';
	try {
		const raw = readFileSync(filePath, 'utf8');
		const parts = raw
			.split(/(?=^## \[)/m)
			.map((s) => s.trim())
			.filter(Boolean);
		parts.reverse();
		let accumulated = '';
		for (const part of parts) {
			if (Buffer.byteLength(accumulated + part + '\n\n', 'utf8') > maxBytes) {
				break;
			}
			accumulated += part + '\n\n';
		}
		return accumulated.trim();
	} catch {
		return '';
	}
}

const pitfalls = readRecentKnowledge(join(paths.stateDir, 'knowledge', 'pitfalls.md'), 2048);
const failed = readRecentKnowledge(join(paths.stateDir, 'knowledge', 'failed-approaches.md'), 2048);

if (pitfalls.length > 0 || failed.length > 0) {
	lines.push('');
	lines.push('Knowledge base (recent entries from previous rounds, newest first):');
	if (pitfalls.length > 0) {
		lines.push('### Pitfalls to avoid:');
		lines.push(pitfalls);
	}
	if (failed.length > 0) {
		lines.push('### Failed approaches:');
		lines.push(failed);
	}
}

if (Array.isArray(campaign.acceptance_criteria) && campaign.acceptance_criteria.length > 0) {
	lines.push('');
	lines.push('Acceptance criteria (judged against real evidence, not summaries):');
	for (const criterion of campaign.acceptance_criteria) lines.push(`- ${criterion}`);
}

if (Array.isArray(campaign.out_of_scope) && campaign.out_of_scope.length > 0) {
	lines.push('');
	lines.push('Explicitly out of scope:');
	for (const item of campaign.out_of_scope) lines.push(`- ${item}`);
}

// Verification artifacts are the file-backed evidence that the role protocol was
// actually executed. Goal Mode only accepts file and command evidence, so these
// files are what turn "the team verified it" from a claim into a check.
lines.push('');
lines.push('Verification artifacts - required before the campaign may be called complete:');
lines.push(`- .teamwork/${VERIFICATIONS_DIR}/<milestone>.md, one per milestone, written by a verifier that did not implement it.`);
lines.push(`- .teamwork/${FINAL_AUDIT_NAME}, written by the Success Auditor, concluding ACHIEVED.`);
lines.push('A milestone with no verification file counts as unverified, no matter how green its tests are.');

const present = verificationFiles(paths.stateDir);
lines.push(
	present.length > 0
		? `Verification records on disk: ${present.join(', ')}.`
		: 'No verification records exist yet.',
);
lines.push(existsSync(join(paths.stateDir, FINAL_AUDIT_NAME)) ? `Final audit on disk: .teamwork/${FINAL_AUDIT_NAME}.` : 'No final audit on disk yet.');

// The plan is the part of the orchestration that used to live only in the
// conversation and therefore vanished whenever the session did.
lines.push('');
const plan = existsSync(paths.plan) ? readJson(paths.plan) : undefined;
if (!plan) {
	lines.push(
		'Plan: .teamwork/plan.json does not exist yet. If the Sentinel has already cleared the charter, ' +
			'the Orchestrator must run and write it before any Worker is dispatched - the ownership table is ' +
			'the only thing that keeps parallel Workers off each other, and it does not survive in conversation.',
	);
} else {
	lines.push('Plan (from .teamwork/plan.json - this is the authority, not your memory of it):');
	if (plan.sentinel) lines.push(`- Sentinel verdict: ${plan.sentinel}`);
	const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
	if (milestones.length > 0) {
		lines.push('- Milestones:');
		for (const m of milestones) {
			const parts = [`${m.id ?? '?'} [${m.status ?? 'unknown'}] ${m.deliverable ?? ''}`.trim()];
			if (Array.isArray(m.files) && m.files.length > 0) parts.push(`files: ${m.files.join(', ')}`);
			if (m.blocked_by) {
				const blocked = Array.isArray(m.blocked_by) ? m.blocked_by.join(', ') : String(m.blocked_by);
				if (blocked) parts.push(`blocked by: ${blocked}`);
			}
			if (m.verified_by) parts.push(`verified by: ${m.verified_by}`);
			if (m.verified === true) parts.push('VERIFIED');
			lines.push(`  - ${parts.join(' | ')}`);
		}
	}
	const ownership = plan.ownership && typeof plan.ownership === 'object' ? Object.entries(plan.ownership) : [];
	if (ownership.length > 0) {
		lines.push('- File ownership table (one Worker per file):');
		for (const [file, milestone] of ownership) lines.push(`  - ${file} -> ${milestone}`);
	}
	const pending = milestones.filter((m) => m.status !== 'done');
	lines.push(`- Remaining milestones: ${pending.length} of ${milestones.length}.`);
}

if (campaign.integrity_mode === 'benchmark') {
	lines.push('');
	lines.push(
		'Benchmark integrity mode is in force: language standard library only, no generated fixtures, ' +
			'no expected values written after seeing the result, no test that merely asserts current behaviour.',
	);
}

lines.push('');
lines.push('Role protocol:');
lines.push('- Explorer gathers evidence read-only. Worker implements one milestone inside an assigned file scope.');
lines.push(
	'- No two Workers hold the same file at once. A write to a file held by another Worker is blocked ' +
		'by the ownership hooks - for the Edit and Write tools, and for file writes issued through Bash. ' +
		'Choose a different file or report the conflict.',
);
lines.push('- Critic hunts defects in the implementation. Challenger attacks the premise. Auditor reproduces evidence.');
lines.push('- Success Auditor judges the finished campaign against the charter, not against the milestone list.');
lines.push('- A milestone is not complete until an agent that did not implement it has verified it.');

emit({
	hookSpecificOutput: {
		hookEventName: 'SessionStart',
		additionalContext: lines.join('\n'),
	},
});

process.exit(0);
