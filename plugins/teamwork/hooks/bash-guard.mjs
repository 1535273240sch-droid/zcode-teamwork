#!/usr/bin/env node
// Teamwork - Bash write guard.
//
// PreToolUse hook on Bash. Closes the other half of the exclusive-ownership
// invariant: ownership-lock.mjs only sees Write|Edit, so `echo x > file`,
// `sed -i`, `tee`, `dd of=`, `rm`, `mv` and `cp` would otherwise write straight
// past the ownership table without the lock ever noticing.
//
// Honest scope of what this can do:
//   - Shell is not parsed here, it is pattern-matched. Extraction is best-effort
//     and deliberately conservative: when a write pattern is recognised but no
//     target can be attributed, the command is ALLOWED with a warning rather than
//     blocked. A false denial on an ordinary build command would be worse than a
//     missed warning, because it would train Workers to fight the hook.
//   - Only targets that resolve inside the session working directory are policed.
//     Anything outside it (/dev/null, /tmp logs, sibling projects) is not part of
//     the campaign and is ignored entirely.
//   - Like ownership-lock.mjs it is a NO-OP unless an approved campaign is in its
//     execution phase.
//
// ASCII only: this file is a protocol artifact and crosses an encoding boundary.

import {readStdin, deny, allowWithContext, statePaths, loadCampaign, isCampaignActive, isInsideDirectory, lockKey, resolveOwner, readStore, appendEvent, acquireMutex, releaseMutex, writeAtomic, pruneStaleTmp, pruneExpired, readLeaseMinutes, existsSync, resolveProjectDir} from './_lib.mjs';

// Patterns whose target file we can name with reasonable confidence.
const TARGET_PATTERNS = [
	{kind: 'redirect', re: /(?:^|[\s;&|(])(?:\d?|&)>>?\s*(?![&=])\s*([^\s;&|<>()]+)/g},
	{kind: 'tee', re: /(?:^|[\s;&|(])tee\s+(?:-\S+\s+)*([^\s;&|<>()]+)/g},
	{kind: 'dd', re: /(?:^|[\s;&|(])dd\b[^\n;&|]*?\bof=([^\s;&|<>()]+)/g},
	{kind: 'truncate', re: /(?:^|[\s;&|(])truncate\s+(?:-\S+\s+)*([^\s;&|<>()]+)/g},
	{kind: 'remove', re: /(?:^|[\s;&|(])rm\s+(?:-\S+\s+)*([^\s;&|<>()]+)/g},
	{kind: 'move', re: /(?:^|[\s;&|(])(?:mv|cp|install)\s+(?:-\S+\s+)*\S+\s+([^\s;&|<>()]+)/g},
];

// Commands that modify files in place but whose target cannot be extracted
// reliably. These are allowed with a warning: ownership is unverifiable, not
// violated.
const OPAQUE_PATTERNS = [
	/\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\b)/,
	/\bperl\s+-[a-zA-Z]*i\b/,
	/\bgit\s+apply\b/,
	/\bgit\s+restore\b/,
	/\bgit\s+checkout\b/,
	/\bpatch\b/,
	/\bshred\b/,
];

function stripQuotes(token) {
	const t = token.trim();
	if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1);
	return t;
}

// A target we cannot attribute to one path is not a target. Globs, command
// substitutions and variables all expand at run time, so they are reported as
// opaque instead of guessed at.
function normaliseTarget(token) {
	const t = stripQuotes(token);
	if (!t) return undefined;
	if (t === '-') return undefined;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return undefined; // URL
	if (/[*?$`{}\[\]~]/.test(t)) return undefined; // expansion
	return t;
}

function sedTargets(command) {
	const out = [];
	const re = /(?:^|[\s;&|(])sed\s+([^\n;&|]*)/g;
	let m;
	while ((m = re.exec(command)) !== null) {
		const args = m[1];
		if (!/(?:^|\s)-[a-zA-Z]*i[a-zA-Z]*(?:\s|$)/.test(args)) continue;
		const tokens = args.split(/\s+/).filter((tok) => tok && !tok.startsWith('-'));
		if (tokens.length > 0) out.push(tokens[tokens.length - 1]);
	}
	return out;
}

function extractTargets(command) {
	const found = [];
	for (const {kind, re} of TARGET_PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(command)) !== null) {
			if (!m[1]) continue;
			const target = normaliseTarget(m[1]);
			if (target) found.push({target, kind});
		}
	}
	for (const target of sedTargets(command)) {
		const normalised = normaliseTarget(target);
		if (normalised) found.push({target: normalised, kind: 'sed'});
	}
	// De-duplicate while keeping the first kind that named the path.
	const seen = new Set();
	return found.filter(({target}) => {
		if (seen.has(target)) return false;
		seen.add(target);
		return true;
	});
}

// Only paths inside the session working directory belong to the campaign.
const insideCwd = isInsideDirectory;

const raw = await readStdin();

let input;
try {
	input = JSON.parse(raw);
} catch {
	process.exit(0); // malformed payload: never block a tool call over it
}

const cwd = resolveProjectDir(input);
const paths = statePaths(cwd);

if (!existsSync(paths.campaign)) process.exit(0);

const campaign = loadCampaign(paths.campaign);
if (!isCampaignActive(campaign)) process.exit(0);

const command = input?.tool_input?.command;
if (typeof command !== 'string' || command.length === 0) process.exit(0);

const candidates = extractTargets(command).filter(({target}) => insideCwd(target, cwd));
const opaque = OPAQUE_PATTERNS.some((re) => re.test(command));

if (candidates.length === 0 && !opaque) process.exit(0); // not a file-writing command

const leaseMs = readLeaseMinutes(campaign) * 60_000;
const {owner, source: ownerSource} = resolveOwner(input);

function evaluate() {
	pruneStaleTmp(paths.stateDir);

	const store = readStore(paths.lock);
	const now = Date.now();

	for (const expired of pruneExpired(store, leaseMs, now)) {
		appendEvent(paths, {event: 'expired', file: expired});
	}

	const conflicts = [];
	const claims = [];

	for (const {target, kind} of candidates) {
		const key = lockKey(target, cwd);
		const held = store[key];
		if (held && held.owner !== owner) {
			conflicts.push({target, held, kind});
			continue;
		}
		claims.push({target, key, kind, reclaimed: !held});
	}

	if (conflicts.length > 0) {
		for (const {target, held} of conflicts) {
			appendEvent(paths, {event: 'denied', file: target, owner, source: ownerSource, holder: held.owner, via: 'bash'});
		}
		const detail = conflicts
			.map(({target, held}) => `${target} (held by ${held.owner}, claimed ${Math.round((now - held.updatedAt) / 1000)}s ago)`)
			.join('; ');
		return {
			action: 'deny',
			reason:
				`File ownership conflict via Bash: ${detail}. ` +
				`Teamwork allows only one Worker per file at a time, and this applies to writes made through the shell too. ` +
				`Use the Edit/Write tools for source changes so ownership is tracked, and pick a different file ` +
				`from your assigned scope, or report the conflict back to the orchestrator if your milestone ` +
				`cannot proceed without this one.`,
		};
	}

	const notes = [];

	if (claims.length > 0) {
		for (const {target, key, kind, reclaimed} of claims) {
			store[key] = {owner, ownerSource, updatedAt: now};
			if (reclaimed) appendEvent(paths, {event: 'claimed', file: target, owner, source: ownerSource, via: `bash:${kind}`});
		}
		try {
			writeAtomic(paths.lock, JSON.stringify(store, null, 2));
		} catch {
			return {action: 'silent'};
		}
		notes.push(
			`Teamwork: this Bash command writes ${claims.length} file(s) inside the campaign scope ` +
				`(${claims.map(({target}) => target).join(', ')}); ownership was claimed for them. ` +
				`Prefer the Edit/Write tools for source changes - the ownership table is exact for those and ` +
				`pattern-matched for shell writes.`,
		);
	}

	if (opaque) {
		notes.push(
			'Teamwork WARNING: this command modifies files in place (sed -i / patch / git apply and similar) ' +
				'and the ownership hook cannot tell which files it will touch. Exclusive ownership is NOT enforced ' +
				'for this call. Use the Edit/Write tools instead, or confirm by hand that no other Worker owns these files.',
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
