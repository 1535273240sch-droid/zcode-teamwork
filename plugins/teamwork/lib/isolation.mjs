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

import {existsSync, mkdirSync, rmSync} from 'node:fs';
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
		return {
			ok: true,
			mode: 'worktree',
			branch,
			worktreePath: paths.worktree,
			scratchDir: scratch,
			// Removing a worktree discards uncommitted work in it. That is the point of
			// a scratch checkout, but it is not something to do automatically, so cleanup
			// is offered and never invoked by this module.
			cleanup: {command: 'git', args: ['worktree', 'remove', paths.worktree, '--force'], cwd},
		};
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
