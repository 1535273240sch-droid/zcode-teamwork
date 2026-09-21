// Teamwork - shared hook internals.
//
// Both PreToolUse hooks - ownership-lock.mjs (matcher Write|Edit) and
// bash-guard.mjs (matcher Bash) - must agree on the same mutex, the same lease
// store, and the same path normalisation. If they diverged, the two halves of the
// exclusive-ownership invariant would stop seeing each other's claims and the hole
// they exist to close would reopen. So the logic lives here, once.
//
// ASCII only: this file is a protocol artifact and crosses an encoding boundary.

import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	renameSync,
	rmSync,
	readdirSync,
	statSync,
	realpathSync,
	appendFileSync,
} from 'node:fs';
import {join, dirname, resolve, basename, sep} from 'node:path';
import {createHash} from 'node:crypto';

export const STATE_DIR = '.teamwork';
export const CAMPAIGN_REL = join(STATE_DIR, 'campaign.json');
export const APPROVAL_REL = join(STATE_DIR, 'approval.json');
export const LOCK_REL = join(STATE_DIR, 'ownership.json');
export const PLAN_REL = join(STATE_DIR, 'plan.json');
export const EVENTS_NAME = 'events.jsonl';
export const MUTEX_NAME = '.lock';
export const VERIFICATIONS_DIR = 'verifications';
export const FINAL_AUDIT_NAME = 'final-audit.md';
export const EVIDENCE_DIR = 'evidence';

export const DEFAULT_LEASE_MINUTES = 10;
export const MIN_LEASE_MINUTES = 1;
export const MAX_LEASE_MINUTES = 10080; // 7 days; a typo like 100000 must not deadlock a campaign
const MUTEX_RETRIES = 50;
const MUTEX_WAIT_MS = 20;
const MUTEX_STALE_MS = 10_000;
const TMP_STALE_MS = 60_000;

// Keys that would reach Object.prototype if assigned onto a normal object.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function statePaths(cwd) {
	const stateDir = join(cwd, STATE_DIR);
	return {
		stateDir,
		campaign: join(cwd, CAMPAIGN_REL),
		approval: join(cwd, APPROVAL_REL),
		lock: join(cwd, LOCK_REL),
		plan: join(cwd, PLAN_REL),
		events: join(stateDir, EVENTS_NAME),
		mutex: join(stateDir, MUTEX_NAME),
		evidenceDir: join(stateDir, EVIDENCE_DIR),
	};
}

export function isProtectedPath(filePath, cwd) {
	const norm = lockKey(filePath, cwd);
	const approvalTarget = lockKey(join(cwd, APPROVAL_REL), cwd);
	if (norm === approvalTarget) return true;
	const evidenceBase = lockKey(join(cwd, STATE_DIR, EVIDENCE_DIR), cwd);
	const evidencePrefix = evidenceBase.endsWith(sep) ? evidenceBase : evidenceBase + sep;
	if (norm === evidenceBase || norm.startsWith(evidencePrefix)) return true;
	return false;
}

export function isVerificationArtifact(filePath, cwd) {
	const norm = lockKey(filePath, cwd);
	const finalAuditTarget = lockKey(join(cwd, STATE_DIR, FINAL_AUDIT_NAME), cwd);
	if (norm === finalAuditTarget) return true;
	const verificationsBase = lockKey(join(cwd, STATE_DIR, VERIFICATIONS_DIR), cwd);
	const verificationsPrefix = verificationsBase.endsWith(sep) ? verificationsBase : verificationsBase + sep;
	if (norm === verificationsBase || norm.startsWith(verificationsPrefix)) return true;
	return false;
}

export function emit(obj) {
	process.stdout.write(JSON.stringify(obj));
	process.exit(0);
}

export function deny(reason) {
	emit({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason,
		},
	});
}

export function allowWithContext(text) {
	emit({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'allow',
			additionalContext: text,
		},
	});
}

export async function readStdin() {
	let raw = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) raw += chunk;
	return raw;
}

// Block the main thread. Node permits Atomics.wait outside workers, and the hook
// protocol is synchronous by design, so there is no async alternative here.
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sha1(value) {
	return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

// Resolve symlinks in the part of the path that exists, and keep the rest verbatim.
//
// realpathSync alone throws for a file that has not been created yet, and falling
// back to the unresolved path is not good enough. On macOS /var is a symlink to
// /private/var, so the working directory resolves to /private/var/... while a
// not-yet-existing file inside it stays /var/..., and the two then never compare as
// nested. That silently turned the Bash guard off on macOS - every candidate target
// was judged to be outside the campaign - and only CI caught it.
function realpathBestEffort(abs) {
	let current = abs;
	const tail = [];
	for (;;) {
		try {
			const real = realpathSync(current);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return abs; // reached the filesystem root
			tail.push(basename(current));
			current = parent;
		}
	}
}

// Normalise to a stable comparison key.
//
// Windows and macOS (APFS/HFS+) are case-insensitive by default, so /src/Core.ts
// and /src/core.ts are the same file and must not produce two different keys.
// macOS also stores filenames in NFD, so text is normalised to NFC.
export function lockKey(filePath, cwd) {
	const normalised = realpathBestEffort(resolve(cwd, filePath)).normalize('NFC');
	const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
	return caseInsensitive ? normalised.toLowerCase() : normalised;
}

// True when `target` resolves to the working directory itself or to something
// inside it. Paths outside the campaign are not the campaign's business.
export function isInsideDirectory(target, cwd) {
	const abs = lockKey(target, cwd);
	const base = lockKey('.', cwd);
	const root = base.endsWith(sep) ? base : base + sep;
	return abs === base || abs.startsWith(root);
}

// Best-effort owner identity, strongest signal first. `source` is recorded so the
// campaign can tell whether attribution is real or degraded.
export function resolveOwner(input) {
	if (process.env.TEAMWORK_OWNER_TOKEN) {
		return {owner: process.env.TEAMWORK_OWNER_TOKEN, source: 'token'};
	}
	for (const field of ['agent_id', 'agentId', 'agent_type', 'agentType']) {
		if (input[field]) return {owner: `agent:${input[field]}`, source: 'agent'};
	}
	// A subagent's transcript is usually its own file, so hashing it distinguishes
	// concurrent Workers better than the shared session id does.
	if (input.transcript_path) return {owner: `tx:${sha1(String(input.transcript_path))}`, source: 'transcript'};
	return {owner: `session:${input.session_id ?? 'unknown'}`, source: 'session'};
}

export function extractFilePath(input) {
	const t = input.tool_input ?? {};
	for (const field of ['file_path', 'filePath', 'absolute_path', 'path']) {
		if (typeof t[field] === 'string' && t[field].length > 0) return t[field];
	}
	return undefined;
}

export function loadCampaign(campaignPath) {
	try {
		const parsed = JSON.parse(readFileSync(campaignPath, 'utf8'));
		return parsed && typeof parsed === 'object' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

// The ownership hooks only arm once the human has approved the charter and
// execution has actually begun. During the scoping interview the charter exists but
// is not approved, and the lock must stay inert.
export function isCampaignActive(campaign) {
	return campaign?.approved === true && campaign?.phase === 'execution';
}

export function writeAtomic(file, data) {
	mkdirSync(dirname(file), {recursive: true});
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, data, 'utf8');
	renameSync(tmp, file);
}

// A crash between writeFileSync and renameSync leaves an orphan .tmp behind.
// Sweep them inside the critical section so they cannot accumulate forever.
export function pruneStaleTmp(dir) {
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.tmp')) continue;
			const full = join(dir, name);
			try {
				if (Date.now() - statSync(full).mtimeMs > TMP_STALE_MS) rmSync(full, {force: true});
			} catch {
				// already gone
			}
		}
	} catch {
		// state dir unreadable: nothing to sweep
	}
}

// Prototype-pollution-resistant store: a null-prototype object plus an explicit
// reject list, so a crafted key in ownership.json cannot reach Object.prototype.
export function readStore(path) {
	const store = Object.create(null);
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		if (!parsed || typeof parsed !== 'object') return store;
		for (const [key, lease] of Object.entries(parsed)) {
			if (DANGEROUS_KEYS.has(key)) continue;
			store[key] = lease;
		}
	} catch {
		// Missing or malformed store: start empty rather than blocking work.
	}
	return store;
}

export function appendEvent(paths, event) {
	try {
		appendFileSync(paths.events, `${JSON.stringify({t: Date.now(), ...event})}\n`);
	} catch {
		// diagnostics must never block a tool call
	}
}

// The critical section. mkdir() is atomic on every platform; a stale lock
// directory (holder died mid-section) is stolen after MUTEX_STALE_MS so a crash
// cannot deadlock the campaign.
export function acquireMutex(paths) {
	try {
		mkdirSync(paths.stateDir, {recursive: true});
	} catch {
		// handled by the mkdir below
	}
	for (let i = 0; i < MUTEX_RETRIES; i++) {
		try {
			mkdirSync(paths.mutex);
			return true;
		} catch {
			try {
				if (Date.now() - statSync(paths.mutex).mtimeMs > MUTEX_STALE_MS) {
					rmSync(paths.mutex, {recursive: true, force: true});
					continue;
				}
			} catch {
				// The lock vanished between mkdir and stat: retry immediately.
			}
			sleepSync(MUTEX_WAIT_MS);
		}
	}
	return false;
}

export function releaseMutex(paths) {
	try {
		rmSync(paths.mutex, {recursive: true, force: true});
	} catch {
		// Nothing useful to do; the stale-steal path covers a failure here.
	}
}

export function readLeaseMinutes(campaign) {
	const value = Number(campaign?.ownership_lease_minutes);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_LEASE_MINUTES;
	return Math.min(Math.max(value, MIN_LEASE_MINUTES), MAX_LEASE_MINUTES);
}

// Drop expired and malformed leases so an abandoned Worker cannot deadlock the
// campaign. Returns the paths whose leases were removed.
export function pruneExpired(store, leaseMs, now) {
	const removed = [];
	for (const [path, lease] of Object.entries(store)) {
		const fresh = lease && typeof lease.updatedAt === 'number' && now - lease.updatedAt <= leaseMs;
		if (!fresh) {
			delete store[path];
			removed.push(path);
		}
	}
	return removed;
}

export {existsSync};
