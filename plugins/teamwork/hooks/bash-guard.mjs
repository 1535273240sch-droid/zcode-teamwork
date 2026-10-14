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

import {join} from 'node:path';
import {readStdin, deny, allowWithContext, statePaths, loadCampaign, isCampaignActive, isInsideDirectory, lockKey, resolveOwner, readStore, appendEvent, acquireMutex, releaseMutex, writeAtomic, pruneStaleTmp, pruneExpired, readLeaseMinutes, existsSync, resolveProjectDir} from './_lib.mjs';
import {readBoundaries, WORKTREES_DIR} from '../lib/isolation.mjs';

// One path argument: either a quoted run, which may contain spaces, or a bare token.
//
// The quoted form is not a nicety. A workspace whose path contains a space - e.g.
// "E:\New folder (7)" - is quoted precisely because of that space, and a pattern that
// stops at whitespace reads the target as `"E:\New`. The ownership table then records a
// key that names no file, and a write to a real file is either mis-attributed or, worse,
// read as relative and waved through a boundary check.
const TARGET = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;&|<>()]+)`;

// Patterns whose target file we can name with reasonable confidence. `group` is which
// capture holds the target, since mv/cp name a source before it.
const TARGET_PATTERNS = [
	{kind: 'redirect', group: 1, re: new RegExp(String.raw`(?:^|[\s;&|(])(?:\d?|&)>>?\s*(?![&=])\s*${TARGET}`, 'g')},
	{kind: 'tee', group: 1, re: new RegExp(String.raw`(?:^|[\s;&|(])tee\s+(?:-\S+\s+)*${TARGET}`, 'g')},
	{kind: 'dd', group: 1, re: new RegExp(String.raw`(?:^|[\s;&|(])dd\b[^\n;&|]*?\bof=${TARGET}`, 'g')},
	{kind: 'truncate', group: 1, re: new RegExp(String.raw`(?:^|[\s;&|(])truncate\s+(?:-\S+\s+)*${TARGET}`, 'g')},
	{kind: 'remove', group: 1, re: new RegExp(String.raw`(?:^|[\s;&|(])rm\s+(?:-\S+\s+)*${TARGET}`, 'g')},
	{kind: 'move', group: 2, re: new RegExp(String.raw`(?:^|[\s;&|(])(?:mv|cp|install)\s+(?:-\S+\s+)*${TARGET}\s+${TARGET}`, 'g')},
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

// Commands that embed a program which can write any file it likes. The shell patterns
// above cannot see the target of these, and that is exactly the hole they leave: a
// `node -e "fs.writeFileSync('src/other.ts', ...)"` writes straight past the ownership
// table and past every entry in TARGET_PATTERNS.
const PROGRAMMATIC_WRITE_PATTERNS = [
	/\bnode\b[^\n;&|]*(?:-e|--eval)\b/,
	/\bpython[0-9.]*\s+(?:-c|-)\b/,
	/\bdeno\s+eval\b/,
	/\bbun\s+(?:-e|--eval)\b/,
	/\bruby\s+-e\b/,
	/\bphp\s+-r\b/,
];

// The write APIs whose presence makes one of those commands an actual write rather than
// a mere evaluation. Narrowing the denial this way is deliberate: it is the difference
// between refusing `node -e "fs.rmSync(x)"` and refusing `node -e "console.log(y)"`, and
// only one of those is a boundary violation.
const WRITE_API_RE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdirSync|rmdirSync|rmSync|unlinkSync|renameSync|copyFileSync|truncateSync|chmodSync|openSync|fs\.(?:write|rm|unlink|rename|mkdir|copyFile|truncate)|shutil\.|os\.(?:remove|rename|mkdir|rmdir)|open\s*\([^)]*['"][wa])/;

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
	// Expansion characters whose meaning does not depend on position: a glob, a
	// variable or a command substitution expands wherever it appears.
	if (/[*?$`{}\[\]]/.test(t)) return undefined;
	// `~` is position-sensitive. It is only special as the first character of a word, so
	// a `~` in the middle is a literal path character - as in the Windows short name
	// C:\Users\RUNNER~1\..., which is how CI checkouts and many user profiles are
	// reached. Rejecting it anywhere discarded the target outright and so silently
	// disarmed every path check on such a workspace, which is the failure this module
	// exists to prevent.
	if (t.startsWith('~')) return undefined; // home expansion
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
	for (const {kind, re, group = 1} of TARGET_PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(command)) !== null) {
			const raw = m[group];
			if (!raw) continue;
			const target = normaliseTarget(raw);
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
const programmatic = PROGRAMMATIC_WRITE_PATTERNS.some((re) => re.test(command)) && WRITE_API_RE.test(command);

if (candidates.length === 0 && !opaque && !programmatic) process.exit(0); // not a file-writing command

const leaseMs = readLeaseMinutes(campaign) * 60_000;
const {owner, source: ownerSource} = resolveOwner(input);

// Execution boundaries.
//
// A Worker that was given a worktree is expected to work in it. The ownership table
// cannot express that: it compares file paths, so a Worker editing the shared checkout
// is claiming files it is entitled to claim, in the wrong place. What the engine
// recorded while preparing the isolation is the only place that fact exists, and this
// is where it is read.
//
// Inert unless a boundary was explicitly recorded for this owner. A campaign that never
// asked for isolation keeps exactly the behaviour it had before boundaries existed.
const boundary = readBoundaries(paths.stateDir)[owner];
const confined = boundary?.mode === 'worktree' && typeof boundary.worktreePath === 'string';
const worktreesRoot = join(paths.stateDir, WORKTREES_DIR);

// Coordination state (campaign.json, ownership.json, the event trail) is not another
// Worker's code, and the hooks and CLI write it from the shared checkout by design, so
// it is exempt. The worktrees tree is not exempt: it holds other Workstreams' checkouts,
// and writing into a sibling's worktree is the same violation as writing into the main one.
function isCoordinationState(target) {
	if (!insideCwd(target, paths.stateDir)) return false;
	return !insideCwd(target, worktreesRoot);
}

function escapesBoundary(target) {
	if (!insideCwd(target, cwd)) return false;
	// Resolving the target against the worktree is what makes this safe for relative
	// paths: a relative target resolves inside the worktree when read from there, so it
	// is never treated as an escape. Only a target that lands in the shared checkout no
	// matter which base it is read from - an absolute path, in practice - is one.
	if (insideCwd(target, boundary.worktreePath)) return false;
	return !isCoordinationState(target);
}

// A refusal, not a warning. The target is known and it is outside the checkout this
// Worker was given, so there is nothing to weigh: the change belongs somewhere else, and
// allowing it would edit code that no verification of this Workstream covers.
function denyBoundary(escaped) {
	for (const {target} of escaped) {
		appendEvent(paths, {event: 'denied', file: target, owner, source: ownerSource, via: 'boundary', worktree: boundary.worktreePath});
	}
	const list = escaped.map(({target}) => target).join(', ');
	return {
		action: 'deny',
		reason:
			`Teamwork boundary violation: this command writes outside the checkout assigned to this Worker. ` +
			`Out-of-boundary target(s): ${list}. Assigned worktree: ${boundary.worktreePath}. ` +
			`A Worker given a worktree works in that worktree. Writing to the shared checkout, or into another ` +
			`Worker's worktree, edits code this Workstream does not own and that its verification does not cover. ` +
			`Run the command with its working directory inside the assigned worktree, or report to the orchestrator ` +
			`if the change genuinely cannot be made there.`,
	};
}

// A program's write targets cannot be read out of the command line, so they cannot be
// checked against the boundary. For a Worker that was given its own checkout the remedy
// costs nothing - run the same command from inside it - so an unverifiable write is
// refused rather than waved through.
function denyProgrammatic() {
	appendEvent(paths, {event: 'denied', file: '(program)', owner, source: ownerSource, via: 'boundary-programmatic'});
	return {
		action: 'deny',
		reason:
			`Teamwork boundary violation: this command runs a program that can write files (node -e, python -c and ` +
			`similar), so its targets cannot be checked against the assigned worktree (${boundary.worktreePath}). ` +
			`Run the same command with its working directory inside the assigned worktree, or use the Edit/Write ` +
			`tools so that ownership and the boundary both apply.`,
	};
}

function evaluate() {
	if (confined) {
		const escaped = candidates.filter(({target}) => escapesBoundary(target));
		if (escaped.length > 0) return denyBoundary(escaped);
		if (programmatic) return denyProgrammatic();
	}

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
