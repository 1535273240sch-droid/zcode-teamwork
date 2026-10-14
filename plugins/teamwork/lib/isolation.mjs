// Teamwork - worker isolation.
//
// Gives each workstream a place to write that nobody else is using, so parallel
// Workers cannot collide even if the ownership table is wrong.
//
// Ownership and isolation answer different questions and both are needed:
//   - ownership says two milestones must not touch one file
//   - isolation says two Workstreams must not share a directory at all
// Ownership is a rule that holds when everyone cooperates and the table is
// correct. Isolation holds regardless: a Worker writing to its own checkout cannot
// clobber another's even if the bookkeeping is stale.
//
// Three tiers, preferred in this order:
//   1. worktree        - a real git worktree on its own branch. Full isolation; the
//                        Worker's commits are separate and reviewable.
//   2. isolated-dir    - a private directory under the state dir. No git required.
//                        Files are separate but the repository history is shared.
//   3. shared-workspace - no separation at all. Only safe because ownership still
//                        applies; chosen explicitly, never by accident.
//
// Deliberately stricter than the reference implementation it is modelled on, which
// builds shell commands by string interpolation ("git worktree add -b " + name).
// Every git call here goes through execFileSync with an argument vector, so a
// branch name or path containing shell metacharacters cannot become a command.
//
// ASCII only: protocol artifact.

import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

export const ISOLATION_MODES = ['auto', 'worktree', 'isolated-dir', 'shared-workspace'];

export const WORKTREES_DIR = 'worktrees';

/** Run a git command. Returns {ok, stdout} - never throws. */
function git(args, cwd) {
	try {
		const stdout = execFileSync('git', args, {
			cwd,
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8',
			timeout: 30_000,
		});
		return {ok: true, stdout: stdout.trim()};
	} catch {
		return {ok: false, stdout: ''};
	}
}

/** Whether the working directory is inside a git repository. */
export function isGitRepo(cwd) {
	return git(['rev-parse', '--git-dir'], cwd).ok;
}

/**
 * Whether git worktrees are usable here.
 *
 * A repository with no commits cannot produce a worktree, which is common for a
 * freshly initialised project; the check therefore asks for HEAD rather than just
 * for a repository.
 */
export function supportsWorktree(cwd) {
	if (!isGitRepo(cwd)) return false;
	if (!git(['rev-parse', '--verify', 'HEAD'], cwd).ok) return false;
	return git(['worktree', 'list'], cwd).ok;
}

/**
 * Branch name for a workstream.
 *
 * Sanitised because it becomes part of a ref: a workstream id containing a space,
 * a colon or a leading dash would produce a branch git refuses, and the failure
 * would surface as a mysterious fallback rather than as a bad name.
 */
export function branchNameFor(workstreamId, now = Date.now()) {
	const safe = String(workstreamId)
		.replace(/[^A-Za-z0-9._/-]+/g, '-')
		.replace(/^[-./]+/, '')
		.replace(/\/{2,}/g, '/');
	const stem = safe.length > 0 ? safe : 'workstream';
	return `teamwork/${stem}-${now}`;
}

/** Paths used by one workstream's isolation, whether or not they exist. */
export function isolationPaths(stateDir, workstreamId) {
	const base = join(stateDir, WORKTREES_DIR, String(workstreamId));
	return {
		base,
		scratch: join(base, 'scratch'),
		logs: join(base, 'logs'),
		worktree: join(stateDir, WORKTREES_DIR, `${workstreamId}-wt`),
	};
}

/**
 * Choose an isolation mode without creating anything.
 *
 * Separated from creation so a plan can report what it will cost - a worktree
 * needs a branch and a checkout, an isolated dir needs a directory - before any of
 * it happens.
 */
export function chooseMode(requested, cwd) {
	const mode = ISOLATION_MODES.includes(requested) ? requested : 'auto';
	if (mode !== 'auto') return mode;
	if (supportsWorktree(cwd)) return 'worktree';
	return 'isolated-dir';
}

/**
 * Create isolation for a workstream.
 *
 * Falls back rather than failing: a Worker that cannot get a worktree is still
 * better off with a private directory than with no run at all. The returned `mode`
 * says which tier was actually achieved, and `fallbackFrom` records what was asked
 * for when they differ - a silent downgrade would leave a reader believing in
 * isolation that is not there.
 */
export function createIsolation(options) {
	const {stateDir, workstreamId, cwd = process.cwd(), mode: requested = 'auto', now = Date.now()} = options;
	if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
		return {ok: false, reason: 'workstreamId is required'};
	}

	const paths = isolationPaths(stateDir, workstreamId);
	const wanted = chooseMode(requested, cwd);

	if (wanted === 'worktree') {
		const branch = branchNameFor(workstreamId, now);
		// The commit this worktree forks from. Recorded because the merge check must
		// diff against it rather than against the worktree's own HEAD: once a Worker
		// commits on its branch, `git diff HEAD` inside the worktree is empty, and a
		// check built on that would report a clean merge for work it never examined.
		const fork = git(['rev-parse', 'HEAD'], cwd);
		if (!existsSync(paths.worktree)) {
			const added = git(['worktree', 'add', '-b', branch, paths.worktree, 'HEAD'], cwd);
			if (!added.ok) {
				// Record why, then continue to the next tier rather than giving up.
				return createIsolatedDir(paths, workstreamId, {
					wanted: 'worktree',
					reason: 'git worktree add failed (no commits, detached HEAD, or a path already in use)',
				});
			}
		}
		const scratch = join(paths.worktree, '.teamwork-scratch');
		try {
			mkdirSync(scratch, {recursive: true});
		} catch {
			return createIsolatedDir(paths, workstreamId, {wanted: 'worktree', reason: 'worktree scratch was not writable'});
		}
		const result = {
			ok: true,
			mode: 'worktree',
			branch,
			base: fork.ok ? fork.stdout : 'HEAD',
			worktreePath: paths.worktree,
			scratchDir: scratch,
			// Removing a worktree discards uncommitted work in it. That is the point of
			// a scratch checkout, but it is not something to do automatically, so cleanup
			// is offered and never invoked by this module.
			cleanup: {command: 'git', args: ['worktree', 'remove', paths.worktree, '--force'], cwd},
		};
		// A worktree nobody records is isolation the guard cannot see: the Bash hook
		// resolves writes against an owner token, and this is the only place the token
		// and the checkout are tied together. Absent an owner, nothing is recorded and
		// the hook stays exactly as inert as it was before boundaries existed.
		if (typeof options.owner === 'string' && options.owner.length > 0) {
			const recorded = recordBoundary(stateDir, {...result, owner: options.owner, workstreamId});
			if (recorded.ok) result.boundary = recorded.boundary;
		}
		return result;
	}

	if (wanted === 'shared-workspace') {
		return {
			ok: true,
			mode: 'shared-workspace',
			scratchDir: null,
			warning:
				'No isolation. Workers share one working tree, so the ownership table is the only thing keeping them ' +
				'apart. Only choose this when the milestones genuinely touch disjoint files.',
			cleanup: null,
		};
	}

	const fallback = requested === 'auto' && !supportsWorktree(cwd)
		? {wanted: 'auto', reason: 'git worktrees are unavailable here'}
		: undefined;
	return createIsolatedDir(paths, workstreamId, fallback);
}

function createIsolatedDir(paths, workstreamId, fallback) {
	try {
		mkdirSync(paths.scratch, {recursive: true});
		mkdirSync(paths.logs, {recursive: true});
	} catch (error) {
		return {ok: false, reason: `could not create an isolated directory: ${error.message}`};
	}
	const result = {
		ok: true,
		mode: 'isolated-dir',
		scratchDir: paths.scratch,
		logsDir: paths.logs,
		// The directory is kept after the run: it is the audit trail of what the
		// Workstream produced, and deleting it would destroy evidence a verification
		// gate may still need.
		cleanup: null,
	};
	if (fallback) {
		result.fallbackFrom = fallback.wanted;
		result.fallbackReason = fallback.reason;
	}
	return result;
}

/** Remove a worktree created for a workstream. Separate, because it is destructive. */
export function removeIsolation(stateDir, workstreamId, cwd = process.cwd()) {
	const paths = isolationPaths(stateDir, workstreamId);
	if (!existsSync(paths.worktree)) return {ok: true, removed: false, reason: 'nothing to remove'};
	const result = git(['worktree', 'remove', paths.worktree, '--force'], cwd);
	if (!result.ok) return {ok: false, reason: 'git worktree remove failed'};
	return {ok: true, removed: true};
}

/**
 * What a verifier may do.
 *
 * A verifier inspects; it does not edit. That is a property of the role rather than
 * of the tool, so it is stated here where the gate can read it, instead of being
 * left to a prompt to enforce.
 */
export function verifierPermissions() {
	return {
		name: 'verifier',
		mayEdit: false,
		mayRunCommands: true,
		note: 'Verifiers run commands and read code. An edit during verification would make the evidence describe a revision that no longer exists.',
	};
}

/** What each role may touch. Returns undefined for a role with no restriction. */
export function permissionsFor(role) {
	switch (String(role)) {
		case 'explorer':
			return {mayEdit: false, mayRunCommands: false, note: 'Explorers read and report. Nothing they produce is a deliverable.'};
		case 'sentinel':
			return {mayEdit: false, mayRunCommands: true, note: 'The Sentinel reviews the charter and returns a verdict; it does not change the work.'};
		case 'critic':
		case 'challenger':
		case 'auditor':
		case 'success-auditor':
			return verifierPermissions();
		case 'orchestrator':
			return {mayEdit: false, mayRunCommands: true, note: 'The Orchestrator plans and dispatches. Editing would make it a Worker as well, and then nothing verifies its work.'};
		case 'worker':
			return {mayEdit: true, mayRunCommands: true};
		default:
			return undefined;
	}
}

/**
 * Whether a role may write in this workspace.
 *
 * Returns the reason so a refusal can explain which the role is and why the write
 * is not its job, rather than reporting a bare denial.
 */
export function checkRoleWrite(role, isolation) {
	const permissions = permissionsFor(role);
	if (!permissions) return {allowed: true};
	if (permissions.mayEdit) return {allowed: true};
	return {
		allowed: false,
		reason: `role "${role}" does not edit: ${permissions.note}`,
		role,
		isolationMode: isolation?.mode,
	};
}

/** A short report of what isolation is in effect, for status output. */
export function describeIsolation(isolation) {
	if (!isolation?.ok) return `no isolation: ${isolation?.reason ?? 'unknown'}`;
	if (isolation.mode === 'worktree') {
		return `worktree at ${isolation.worktreePath} on branch ${isolation.branch}`;
	}
	if (isolation.mode === 'isolated-dir') {
		const suffix = isolation.fallbackFrom ? ` (fell back from ${isolation.fallbackFrom}: ${isolation.fallbackReason})` : '';
		return `isolated directory at ${isolation.scratchDir}${suffix}`;
	}
	return 'shared workspace (no isolation)';
}

/** Absolute path helper used by callers that pass a relative state dir. */
export function absoluteStateDir(stateDir, cwd = process.cwd()) {
	return stateDir.startsWith('/') ? stateDir : resolve(cwd, stateDir);
}

// ---------------------------------------------------------------------------
// Execution boundaries
//
// A worktree is only isolation if the Worker actually stays in it. Creating one and
// telling the agent about it is not enforcement: the Bash guard sees every shell
// write but has no way to know which checkout a given owner was given. This registry
// is that missing link - the engine records it while preparing isolation, and the
// guard reads it to decide whether a write target lies inside its owner's checkout.
//
// Absence is meaningful and must stay cheap. With no entry for an owner, every check
// built on this is inert and the hooks behave exactly as they did before the registry
// existed. A campaign that never asks for isolation must not be policed by a feature
// it did not enable.

export const BOUNDARIES_NAME = 'boundaries.json';

export function boundariesPath(stateDir) {
	return join(stateDir, BOUNDARIES_NAME);
}

// Keys that would reach Object.prototype if assigned onto a normal object. The file
// is keyed by an owner token that originates in the environment, so a crafted token
// must not be able to pollute the prototype of the map it is inserted into.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Every recorded boundary, keyed by owner. Empty when none was ever recorded. */
export function readBoundaries(stateDir) {
	const store = Object.create(null);
	try {
		const parsed = JSON.parse(readFileSync(boundariesPath(stateDir), 'utf8'));
		if (!parsed || typeof parsed !== 'object') return store;
		for (const [owner, entry] of Object.entries(parsed)) {
			if (DANGEROUS_KEYS.has(owner)) continue;
			if (!entry || typeof entry !== 'object') continue;
			store[owner] = entry;
		}
	} catch {
		// Missing or malformed: no boundary is in force. Failing open is the right
		// direction, because the guard then falls back to the ownership table - the
		// invariant that does hold when there is no isolation to enforce.
	}
	return store;
}

function writeBoundaries(stateDir, store) {
	mkdirSync(stateDir, {recursive: true});
	const file = boundariesPath(stateDir);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
	// The rename is the commit point: a reader sees either the previous map or this
	// one, never a half-written file that parses as a boundary with no worktree in it.
	renameSync(tmp, file);
}

/**
 * Record where one owner is allowed to write.
 *
 * Only a real worktree produces a boundary. An isolated directory is not one: it has
 * an absolute scratch path, but a Worker there still shares the repository, so
 * confining writes to that path would deny it the source tree it was asked to change.
 * Recording only the tier that can actually be enforced is what keeps the guard from
 * refusing legitimate edits.
 */
export function recordBoundary(stateDir, input) {
	if (typeof input?.owner !== 'string' || input.owner.length === 0) {
		return {ok: false, reason: 'owner is required'};
	}
	if (input.mode !== 'worktree' || typeof input.worktreePath !== 'string' || input.worktreePath.length === 0) {
		return {ok: false, reason: 'only a worktree checkout has an enforceable boundary'};
	}
	const store = readBoundaries(stateDir);
	// Stored absolute: a boundary recorded relative to one process is not reproducible
	// in a hook that runs from a different working directory.
	store[input.owner] = {
		mode: 'worktree',
		worktreePath: resolve(input.worktreePath),
		scratchDir: typeof input.scratchDir === 'string' ? resolve(input.scratchDir) : null,
		workstreamId: input.workstreamId ?? null,
		branch: input.branch ?? null,
		base: input.base ?? 'HEAD',
		recordedAt: input.now ?? Date.now(),
	};
	try {
		writeBoundaries(stateDir, store);
	} catch (error) {
		return {ok: false, reason: `could not record the boundary: ${error.message}`};
	}
	return {ok: true, boundary: store[input.owner], path: boundariesPath(stateDir)};
}

/** Drop a boundary once the workstream has merged or been abandoned. */
export function clearBoundary(stateDir, owner) {
	const store = readBoundaries(stateDir);
	if (!(owner in store)) return {ok: true, removed: false};
	delete store[owner];
	try {
		writeBoundaries(stateDir, store);
	} catch (error) {
		return {ok: false, reason: `could not clear the boundary: ${error.message}`};
	}
	return {ok: true, removed: true};
}

/** The boundary in force for one owner, if any. */
export function boundaryFor(stateDir, owner) {
	return readBoundaries(stateDir)[owner];
}

/**
 * Files a worktree has changed, relative to the commit it forked from.
 *
 * Two commands, because one is not enough. `git diff --name-only` sees tracked
 * modifications and misses every file the Worker created but never added - and
 * creating files is most of what a Worker does, so a check built on the diff alone
 * would wave through exactly the case it exists to catch. Untracked paths are
 * therefore folded in from `git status --porcelain`.
 *
 * The base is the fork point rather than HEAD. In a worktree whose Worker has
 * committed, HEAD already contains the work, so diffing against it reports nothing.
 */
export function worktreeChanges(worktreePath, options = {}) {
	if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
		return {ok: false, reason: 'worktreePath is required'};
	}
	const base = typeof options.base === 'string' && options.base.length > 0 ? options.base : 'HEAD';
	const diff = git(['diff', '--name-only', base], worktreePath);
	// A diff that cannot be read has not passed. Reporting an empty change set here
	// would turn an unreadable worktree into an approved merge.
	if (!diff.ok) return {ok: false, reason: `could not read "git diff --name-only ${base}" in the worktree`};

	const changed = new Set(diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean));

	if (options.includeUntracked !== false) {
		const status = git(['status', '--porcelain', '--untracked-files=all'], worktreePath);
		if (!status.ok) return {ok: false, reason: 'could not read the worktree status'};
		for (const line of status.stdout.split('\n')) {
			// "XY path"; only untracked entries ("??") are added here, since tracked
			// changes already came from the diff above.
			if (!line.startsWith('??')) continue;
			const path = line.slice(3).trim();
			if (path.length > 0) changed.add(path);
		}
	}

	return {ok: true, base, changed: [...changed].sort()};
}
