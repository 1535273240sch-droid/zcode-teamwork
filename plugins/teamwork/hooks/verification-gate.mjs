// Verification gate: a milestone that the campaign state calls done, but which has
// no verification record on disk, is not done. This hook turns that rule from a
// written promise into an enforced one.
//
// Wire it to the Stop event. When the model tries to end a turn while the campaign
// state claims completed work that carries no evidence, the gate blocks the stop and
// hands back the exact list of gaps. Clearing them is the model's job, not ours.
//
// Deliberately narrow. The gate fires only on a contradiction between what the state
// file claims and what exists on disk:
//   1. a milestone is marked done / verified, but no verification record exists
//   2. a verification record exists but carries no recognisable verdict
//   3. the campaign is marked complete but the final audit is missing
// It never blocks work in progress, and it never judges code quality itself.
//
// Off switches, in order of precedence:
//   - env TEAMWORK_VERIFY_GATE=off
//   - campaign.json: "verificationGate": false
//   - input.stopHookActive === true (this hook already fired this turn; blocking
//     again would trap the model in a loop)
//
// ASCII only: the hook payload crosses an encoding boundary into ZCode's runtime.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {emit, readStdin, statePaths, loadCampaign, loadMilestones, isCampaignActive, VERIFICATIONS_DIR, FINAL_AUDIT_NAME, resolveProjectDir} from './_lib.mjs';

// Verdict words the roster is allowed to end a record with. Kept in sync with the
// verdict table in skills/teamwork-execute/SKILL.md.
const VERDICT_TOKENS = [
	'SOUND',
	'REPRODUCED',
	'SURVIVED',
	'FALSIFIED',
	'UNFALSIFIABLE',
	'DIVERGED',
	'CLEARED',
	'BLOCKED',
];

const MAX_REPORTED = 8;

function milestoneId(milestone) {
	const raw = milestone?.id ?? milestone?.milestone ?? milestone?.name;
	return typeof raw === 'string' ? raw.trim() : '';
}

// A milestone counts as claimed-done when the state file says so. Work still in
// progress is none of the gate's business.
function isClaimedDone(milestone) {
	if (milestone?.verified === true) return true;
	const status = typeof milestone?.status === 'string' ? milestone.status.toLowerCase() : '';
	return status === 'done' || status === 'verified';
}

// Records are authored by the verifier, so tolerate the usual filename shapes
// (<id>.md, <id>-verification.md, milestone-<id>.md) instead of demanding one.
function findVerificationRecord(dir, id) {
	if (!existsSync(dir)) return undefined;
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return undefined;
	}
	const wanted = id.toLowerCase();
	const candidates = entries
		.filter((name) => name.toLowerCase().endsWith('.md'))
		.map((name) => join(dir, name))
		.filter((path) => {
			const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
			return base.includes(wanted);
		});
	return candidates[0];
}

function verdictsIn(text) {
	const upper = text.toUpperCase();
	return VERDICT_TOKENS.filter((token) => upper.includes(token));
}

const raw = await readStdin();
let input = {};
try {
	input = JSON.parse(raw) || {};
} catch {
	emit({});
}

// ZCode's internal contract names these in camelCase, while the process-hook payload
// follows the Claude-Code spelling. Accept both, or the gate silently reads undefined
// and never fires.
function pick(source, camel, snake) {
	return source?.[camel] ?? source?.[snake];
}

// Second pass of this hook in the same turn: stay out of the way, or a model that
// cannot satisfy the gate would spin forever.
if (pick(input, 'stopHookActive', 'stop_hook_active') === true) emit({});

if (process.env.TEAMWORK_VERIFY_GATE === 'off') emit({});

const cwd = resolveProjectDir(input);
const paths = statePaths(cwd);

const campaign = loadCampaign(paths.campaign);

// Nothing to enforce outside an approved, running campaign. During the scoping
// interview the charter exists but is not approved yet.
if (!isCampaignActive(campaign)) emit({});
if (campaign.verificationGate === false) emit({});

// Milestones come from campaign.json when it has them (which is what the engine
// writes), falling back to plan.json for campaigns created by an older version.
// Reading plan.json alone meant a CLI-created campaign had no plan file, so this
// gate saw zero milestones and exited cleanly - inert on the documented path.
const {milestones, source} = loadMilestones(cwd);
if (source === null) emit({});

const gaps = [];

for (const milestone of milestones) {
	const id = milestoneId(milestone);
	if (id.length === 0) continue;
	if (!isClaimedDone(milestone)) continue;

	const record = findVerificationRecord(join(paths.stateDir, VERIFICATIONS_DIR), id);
	if (!record) {
		gaps.push(`"${id}" is marked done but has no ${VERIFICATIONS_DIR}/ record`);
		continue;
	}

	let text;
	try {
		text = readFileSync(record, 'utf8');
	} catch {
		gaps.push(`"${id}" verification record could not be read`);
		continue;
	}

	if (!text.includes(id)) {
		gaps.push(`"${id}" verification record never names the milestone`);
		continue;
	}

	if (verdictsIn(text).length === 0) {
		gaps.push(`"${id}" verification record carries no verdict`);
	}
}

const campaignStatus = String(campaign?.status ?? '').toLowerCase();
if (campaignStatus === 'complete' || campaignStatus === 'done') {
	if (!existsSync(join(paths.stateDir, FINAL_AUDIT_NAME))) {
		gaps.push(`campaign is marked ${campaignStatus} but ${FINAL_AUDIT_NAME} is missing`);
	}
}

if (gaps.length === 0) emit({});

// Report the first few gaps in full and summarise the rest, so a long campaign does
// not bury the actionable items under its own backlog.
const shown = gaps.slice(0, MAX_REPORTED);
const hidden = gaps.length - shown.length;
const listed = shown.map((gap) => `- ${gap}`).join('\n');
const overflow = hidden > 0 ? `\n- ...and ${hidden} more` : '';

// The field is `reason`, not `stopReason`.
//
// ZCode parses both, but only `reason` and `systemMessage` are pushed into
// additionalContexts, and the continuation check is:
//
//   shouldContinueAfterStopHooks = stopShouldContinue === true
//                               && additionalContexts.length > 0
//                               && attempts < 3
//
// `stopReason` is display-only, so a gate that returns only that field sets
// blockRequested, gets a stopReason recorded, and then the turn ends normally.
// The block is silently a no-op - which is exactly the failure this gate exists to
// prevent, one level up. Verified against a real ZCode build: with `stopReason` the
// turn completed once; with `reason` the same turn was pulled back four times.
emit({
	decision: 'block',
	reason:
		'Teamwork verification gate: the campaign state claims completed work with no evidence on disk.\n' +
		`${listed}${overflow}\n` +
		'Either write the verification record (.teamwork/verifications/<milestone>.md naming the milestone, ' +
		'the verifying role, the exact command, the raw output, and the verdict), or correct the milestone status. ' +
		'A milestone the implementer verified alone does not count.',
});
