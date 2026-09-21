#!/usr/bin/env node
// Teamwork - exclusive file ownership lease.
//
// PreToolUse hook on Write|Edit. Enforces the campaign invariant that no two
// Workers hold the same file at the same time ("exclusive file ownership").
//
// Design notes:
//   - It is a NO-OP unless an APPROVED campaign is in its execution phase at
//     <cwd>/.teamwork/campaign.json. Without that gate the hook would police every
//     ordinary edit in every project - and it would arm itself during the scoping
//     interview, before the human has approved anything.
//   - It is a LEASE, not a hard lock: a claim expires after leaseMinutes of
//     inactivity, so a crashed or abandoned Worker cannot deadlock the campaign.
//   - The read-decide-write of the lease store runs inside a mutex built on
//     mkdir(), which is atomic on every platform. Without it two concurrent
//     claims can both read the old store and write back, and the later write
//     silently erases the earlier claim - exactly when parallel Workers need the
//     lock most.
//   - Owner identity is best-effort. See resolveOwner() in _lib.mjs. ZCode
//     documents no per-subagent identifier in the PreToolUse payload, so when no
//     distinguishing signal is present every Worker in a session resolves to the
//     same owner and the conflict check below cannot fire. The hook detects that
//     state and says so out loud rather than pretending to protect. Set
//     TEAMWORK_OWNER_TOKEN on the ZCode process environment (one Worker per
//     process) for exact attribution.
//
// bash-guard.mjs closes the other half of this invariant: a write issued through
// Bash never reaches this hook, so it is policed separately against the same store.
//
// ASCII only: this file is a protocol artifact and crosses an encoding boundary.

import {
	readStdin,
	deny,
	allowWithContext,
	statePaths,
	loadCampaign,
	isCampaignActive,
	extractFilePath,
	lockKey,
	resolveOwner,
	readStore,
	appendEvent,
	acquireMutex,
	releaseMutex,
	writeAtomic,
	pruneStaleTmp,
	pruneExpired,
	readLeaseMinutes,
	isProtectedPath,
	isVerificationArtifact,
	existsSync,
} from './_lib.mjs';

const raw = await readStdin();

let input;
try {
	input = JSON.parse(raw);
} catch {
	process.exit(0); // malformed payload: never block a tool call over it
}

const cwd = input.cwd || process.cwd();
const paths = statePaths(cwd);

if (!existsSync(paths.campaign)) process.exit(0);

const campaign = loadCampaign(paths.campaign);
if (!isCampaignActive(campaign)) process.exit(0);

const filePath = extractFilePath(input);
if (!filePath) process.exit(0); // nothing to own

if (isProtectedPath(filePath, cwd)) {
	deny(
		`Protected path: direct write or edit to ${filePath} is denied. ` +
			`Evidence logs (.teamwork/evidence/**) and approval records (.teamwork/approval.json) ` +
			`must only be written by the teamwork CLI.`,
	);
}

const callerType = input.agent_type || input.agentType;
if (isVerificationArtifact(filePath, cwd)) {
	if (callerType && ['worker', 'orchestrator', 'explorer'].includes(callerType.toLowerCase())) {
		deny(
			`Role violation: ${callerType} is not permitted to write verification records or final audits (${filePath}). ` +
				`Only independent verifiers (critic, challenger, auditor, success-auditor) may write them via teamwork CLI.`,
		);
	}
}

const leaseMs = readLeaseMinutes(campaign) * 60_000;
const {owner, source: ownerSource} = resolveOwner(input);
const key = lockKey(filePath, cwd);

// The critical section returns an outcome; it must not emit directly, because
// process.exit() skips the finally block that releases the mutex.
function evaluate() {
	pruneStaleTmp(paths.stateDir);

	const store = readStore(paths.lock);
	const now = Date.now();

	for (const expired of pruneExpired(store, leaseMs, now)) {
		appendEvent(paths, {event: 'expired', file: expired});
	}

	const held = store[key];

	if (held && held.owner !== owner) {
		appendEvent(paths, {event: 'denied', file: filePath, owner, source: ownerSource, holder: held.owner});
		return {
			action: 'deny',
			reason:
				`File ownership conflict: ${filePath} is currently held by ${held.owner} ` +
				`(claimed ${Math.round((now - held.updatedAt) / 1000)}s ago, lease ${leaseMs / 60000} min). ` +
				`Teamwork allows only one Worker per file at a time. ` +
				`Pick a different file from your assigned scope, or report the conflict back to the orchestrator ` +
				`if your milestone cannot proceed without this one. ` +
				`If you believe the holder is gone, wait for the lease to expire rather than retrying in a loop.`,
		};
	}

	const reclaimed = !held;
	store[key] = {owner, ownerSource, updatedAt: now};

	try {
		writeAtomic(paths.lock, JSON.stringify(store, null, 2));
	} catch {
		// Lock bookkeeping must never block real work.
		return {action: 'silent'};
	}

		if (reclaimed) appendEvent(paths, {event: 'claimed', file: filePath, owner, source: ownerSource});

		if (isVerificationArtifact(filePath, cwd) && !callerType) {
			appendEvent(paths, {event: 'unverified_writer', file: filePath, owner, source: ownerSource});
		}

	const active = Object.keys(store).length;
	const notes = [];

	if (reclaimed && active > 1) {
		notes.push(`Teamwork: claimed exclusive ownership of ${filePath}. ${active} files are now held across the campaign.`);
	}

	// Fail-open detection. With no distinguishing signal, every Worker in this
	// session resolves to the same owner and the check above can never fire. Say so
	// rather than letting the campaign believe it is protected.
	if (reclaimed && ownerSource === 'session' && campaign.pattern === 'distributed-coding') {
		notes.push(
			'Teamwork WARNING: ownership attribution is unavailable in this session. ' +
				'No per-subagent identifier reached the hook, so every Worker resolves to the same owner and ' +
				'conflicting writes to one file CANNOT be detected. The exclusive-ownership invariant is not in force. ' +
				'To restore it, run one Worker per ZCode process and set TEAMWORK_OWNER_TOKEN in that process environment, ' +
				'or assign each Worker a disjoint file scope you can check by hand.',
		);
	}

	if (notes.length === 0) return {action: 'silent'};
	return {action: 'context', text: notes.join(' ')};
}

let outcome = {action: 'silent'};
if (!acquireMutex(paths)) process.exit(0); // never block a tool call over bookkeeping
try {
	outcome = evaluate();
} catch {
	outcome = {action: 'silent'};
} finally {
	releaseMutex(paths);
}

if (outcome.action === 'deny') deny(outcome.reason);
if (outcome.action === 'context') allowWithContext(outcome.text);

process.exit(0);
