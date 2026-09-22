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
import {checkDeliverables, checkEvidence, MIN_DELIVERABLE_BYTES} from '../lib/evidence.mjs';
import {pendingDispatches} from '../lib/scheduler.mjs';

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

// Drop `evidence:` citations, leaving the prose. Used by the naming check so a
// milestone id inside a path cannot stand in for naming the milestone.
function bodyWithoutCitations(text) {
	return String(text)
		.split('\n')
		.filter((line) => !/^\s*evidence\s*:/i.test(line))
		.join('\n');
}

function verdictsIn(text) {
	const upper = text.toUpperCase();
	return VERDICT_TOKENS.filter((token) => upper.includes(token));
}

// Read the audit trail. The trail is written by audit-log on every tool call, so it
// is the one record the model does not produce. Used to tell captured evidence from
// evidence the model wrote itself.
//
// A torn tail line is expected after a kill and is skipped rather than failing the
// read: the gate's job is to judge the campaign, not to be defeated by a partial
// final write.
function loadEvents(path) {
	if (!existsSync(path)) return [];
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return [];
	}
	const events = [];
	for (const line of text.split('\n')) {
		if (line.length === 0) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// torn tail line
		}
	}
	return events;
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

const gaps = [];

// The audit trail, read once. It is the only record in the campaign that the model
// does not author, which is what makes it useful for telling captured evidence from
// evidence the model wrote itself.
const events = loadEvents(paths.events);

// Dispatches that started and never reported back.
//
// Checked before the milestone source, and deliberately so. The incident this comes
// from had no milestone list at all: eight workers were dispatched into a campaign
// whose milestones were still empty, six were cut mid-flight at 20:19:47, and the
// gate exited early on `source === null` without looking at anything - which is why
// every surface reported success.
//
// A reservation is taken when a dispatch is admitted and consumed when audit-log
// records its result, so an unconsumed reservation means a worker began and nothing
// came back. That is the only trace a worker killed mid-run leaves.
//
// The limit, stated because it matters when acting on this: a reservation is also
// unconsumed while its worker is legitimately still running. At turn end nothing
// should still be running, which is where this is checked - so it distinguishes
// "started and silent" from "started and finished", not from "started and working".
if (campaign.requireDispatchesSettled !== false) {
	let reservations = {};
	try {
		reservations = JSON.parse(readFileSync(join(paths.stateDir, 'spawn-reservations.json'), 'utf8'));
	} catch {
		// absent or unreadable means none, which is the normal case
	}
	const pending = pendingDispatches(reservations);
	if (pending.length > 0) {
		const listed = pending
			.slice(0, MAX_REPORTED)
			.map((p) => `- a dispatch${p.agent ? ` for "${p.agent}"` : ''} started ${p.minutes ?? '?'} minutes ago and never reported a result`)
			.join('\n');
		gaps.push(
			`${pending.length} dispatch(es) started and never reported back:\n${listed}\n` +
				'A worker cut off mid-run leaves no result and no error, so nothing else in this report would have ' +
				'shown it. Confirm the work was done, or dispatch it again - either way, do not close the turn as if ' +
				'it had succeeded.',
		);
	}
}

// Milestones come from campaign.json when it has them (which is what the engine
// writes), falling back to plan.json for campaigns created by an older version.
// Reading plan.json alone meant a CLI-created campaign had no plan file, so this
// gate saw zero milestones and exited cleanly - inert on the documented path.
const {milestones, source} = loadMilestones(cwd);
if (source === null) {
	// No milestones to judge - but a zone of silent dispatches is still a finding.
	if (gaps.length === 0) emit({});
	else {
		emit({
			decision: 'block',
			reason: `Teamwork verification gate:\n${gaps.map((g) => `- ${g}`).join('\n')}`,
		});
	}
}

for (const milestone of milestones) {
	const id = milestoneId(milestone);
	if (id.length === 0) continue;
	if (!isClaimedDone(milestone)) continue;

	// Deliverables first, because a missing or stubbed output is the more serious
	// finding and should not be buried under record-format complaints.
	//
	// This is the check that the code-review incident needed. Six workers reported
	// success and wrote heading-only stubs of 802, 1008 and 1839 bytes; the gate
	// passed every one, because it read the record and the record said the right
	// words. A deliverable is a file on disk and can be measured.
	const deliverableCheck = checkDeliverables(milestone, cwd, {minBytes: MIN_DELIVERABLE_BYTES});
	for (const failure of deliverableCheck.failures) gaps.push(failure);

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

	// Check the body, with evidence citations removed first.
	//
	// A cite names a file, and a filename often carries the milestone id - so testing
	// the whole record lets `evidence: .teamwork/evidence/m1-run.log` satisfy a
	// requirement that the record actually name m1. A record that only mentions its
	// milestone inside a path has not been written about at all.
	if (!bodyWithoutCitations(text).includes(id)) {
		gaps.push(`"${id}" verification record never names the milestone`);
		continue;
	}

	if (verdictsIn(text).length === 0) {
		gaps.push(`"${id}" verification record carries no verdict`);
	}

	// The record cites evidence; the evidence must exist, be non-empty, and have
	// been captured by the hook rather than written by the claimant. The last point
	// is the one that matters: a worker that can write its own evidence can claim
	// any result it likes, which is exactly what happened in the code-review
	// incident where the record carried a fabricated test transcript.
	const evidenceCheck = checkEvidence(join(VERIFICATIONS_DIR, `${id}.md`), text, {
		stateDir: paths.stateDir,
		events,
		requireEvidence: campaign.requireEvidence !== false,
	});
	for (const failure of evidenceCheck.failures) gaps.push(failure);
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
		'Either close the gaps above, or correct the milestone status. ' +
		'A verification record needs the milestone name, the verifying role, a recognisable verdict, and a line ' +
		'"evidence: .teamwork/evidence/<name>.log" citing output the runtime captured - evidence written by the ' +
		'worker is not evidence. A declared deliverable must be a real file: present, past the size floor, with ' +
		'body text and no placeholders. A milestone the implementer verified alone does not count.',
});
