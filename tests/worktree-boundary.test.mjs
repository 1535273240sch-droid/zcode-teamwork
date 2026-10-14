// Tests for execution boundaries: the registry that binds an owner to a worktree, the
// merge-time comparison against the ownership table, and the Bash guard that refuses a
// write outside the assigned checkout.
//
// Giving a Worker its own worktree is bookkeeping. Only staying inside it is isolation,
// and the difference is invisible until two Workers collide - so the tests below are
// written against the refusals, not the happy path.
//
//   node tests/worktree-boundary.test.mjs

import {mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync, execFileSync} from 'node:child_process';

import {
	createIsolation,
	worktreeChanges,
	readBoundaries,
	recordBoundary,
	clearBoundary,
	boundaryFor,
	BOUNDARIES_NAME,
} from '../plugins/teamwork/lib/isolation.mjs';

import {authorizeMerge, normalizePath} from '../plugins/teamwork/lib/ownership.mjs';
import {lockKey} from '../plugins/teamwork/hooks/_lib.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = join(REPO, 'plugins', 'teamwork', 'hooks');
const WORK = mkdtempSync(join(tmpdir(), 'teamwork-boundary-'));

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${detail}` : ''}`);
	}
}

function freshDir(name) {
	const dir = join(WORK, name);
	rmSync(dir, {recursive: true, force: true});
	mkdirSync(dir, {recursive: true});
	return dir;
}

// Identity is passed explicitly rather than assumed from a global config: CI machines
// have no user.email, and a commit that fails there would turn a behaviour test into an
// environment test.
function git(args, cwd) {
	return execFileSync(
		'git',
		['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args],
		{cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8'},
	).trim();
}

function gitAvailable() {
	try {
		return spawnSync('git', ['--version'], {encoding: 'utf8'}).status === 0;
	} catch {
		return false;
	}
}

function run(script, payload, env = {}) {
	const result = spawnSync(process.execPath, [join(HOOKS, script)], {
		input: JSON.stringify(payload),
		encoding: 'utf8',
		env: {...process.env, ...env},
	});
	return {stdout: (result.stdout || '').trim(), stderr: result.stderr || '', code: result.status};
}

// ---------------------------------------------------------------------------
console.log('\nboundary registry');

{
	const stateDir = freshDir('registry');
	check('registry: absent means no boundary', Object.keys(readBoundaries(stateDir)).length === 0);
	check(
		'registry: an entry with no owner is refused',
		recordBoundary(stateDir, {mode: 'worktree', worktreePath: '/tmp/wt'}).ok === false,
	);
	check(
		'registry: an isolated directory is not an enforceable boundary',
		recordBoundary(stateDir, {owner: 'o', mode: 'isolated-dir', worktreePath: '/tmp/dir'}).ok === false,
	);
	check(
		'registry: a worktree is recorded',
		recordBoundary(stateDir, {owner: 'owner-a', mode: 'worktree', worktreePath: '/tmp/wt', workstreamId: 'ws1', base: 'abc'}).ok === true,
	);
	check('registry: it reads back', boundaryFor(stateDir, 'owner-a')?.workstreamId === 'ws1', JSON.stringify(boundaryFor(stateDir, 'owner-a')));
	check('registry: the fork point is kept', boundaryFor(stateDir, 'owner-a')?.base === 'abc');
	check('registry: an unrecorded owner has none', boundaryFor(stateDir, 'nobody') === undefined);
	check('registry: it is written to disk', existsSync(join(stateDir, BOUNDARIES_NAME)));
	check('registry: clearing removes it', clearBoundary(stateDir, 'owner-a').removed === true && boundaryFor(stateDir, 'owner-a') === undefined);
	check('registry: clearing twice is not an error', clearBoundary(stateDir, 'owner-a').removed === false);

	// A crafted owner token must not reach Object.prototype through the map it keys.
	writeFileSync(
		join(stateDir, BOUNDARIES_NAME),
		'{"__proto__":{"mode":"worktree","worktreePath":"/tmp/evil"},"ok-a":{"mode":"worktree","worktreePath":"/tmp/x"}}',
	);
	const map = readBoundaries(stateDir);
	check('registry: a prototype key cannot pollute the map', Object.getPrototypeOf(map) === null && ({}).mode === undefined);
	check('registry: a well-formed sibling still loads', map['ok-a']?.worktreePath === '/tmp/x');
	check('registry: a malformed file reads as empty', (() => {
		writeFileSync(join(stateDir, BOUNDARIES_NAME), '{not json');
		return Object.keys(readBoundaries(stateDir)).length === 0;
	})());
}

// ---------------------------------------------------------------------------
console.log('\nmerge authorisation');

{
	const unauthorised = authorizeMerge({changed: ['src/a.ts', 'src/b.ts'], authorized: ['src/a.ts']});
	check('merge: an unauthorised file fails the check', unauthorised.ok === false && unauthorised.unauthorized.join(',') === 'src/b.ts');
	check('merge: the authorised file is still reported', unauthorised.authorized.join(',') === 'src/a.ts');
	check('merge: a directory prefix authorises its contents', authorizeMerge({changed: ['src/a.ts', 'src/deep/b.ts'], authorized: ['src/']}).ok === true);
	check('merge: an empty authorisation list is not a pass', authorizeMerge({changed: ['src/a.ts'], authorized: []}).ok === false);
	check('merge: no changes and no authorisation still fails', authorizeMerge({changed: [], authorized: []}).ok === false);
	check('merge: no changes with an authorisation list passes', authorizeMerge({changed: [], authorized: ['src/a.ts']}).ok === true);
	check('merge: path spelling does not decide authorisation', authorizeMerge({changed: ['./src\\A.TS'], authorized: ['src/a.ts']}).ok === true);
	check('merge: a prefix does not cover a sibling directory', authorizeMerge({changed: ['src-other/a.ts'], authorized: ['src/']}).ok === false);
}

// ---------------------------------------------------------------------------
if (!gitAvailable()) {
	// A visible skip, not a silent pass: this branch means the environment lacks git,
	// not that the behaviour was verified.
	check('worktree: SKIPPED, git is unavailable in this environment', false, 'git not found on PATH');
} else {
	// The fixture directory deliberately contains a space. A workspace path with a
	// space is the ordinary case on this host, and it is what exposed the extraction
	// bug the guard test below covers.
	const root = freshDir('repo with space');
	mkdirSync(join(root, 'src'), {recursive: true});
	writeFileSync(join(root, 'src', 'main.ts'), 'export const a = 1;\n');

	let ready = false;
	try {
		git(['init'], root);
		git(['add', '-A'], root);
		git(['commit', '-qm', 'init'], root);
		ready = true;
	} catch {
		ready = false;
	}

	if (!ready) {
		check('worktree: SKIPPED, could not create a commit in this environment', false, 'git commit failed');
	} else {
		const stateDir = join(root, '.teamwork');
		const iso = createIsolation({stateDir, workstreamId: 'ws1', cwd: root, owner: 'owner-a'});
		check('worktree: isolation is created', iso.ok === true && iso.mode === 'worktree', iso.mode);
		check('worktree: the fork point is recorded as the diff base', /^[0-9a-f]{7,40}$/.test(String(iso.base)), String(iso.base));
		check('worktree: naming an owner records a boundary', iso.boundary?.mode === 'worktree');
		check(
			'worktree: without an owner no boundary is recorded',
			createIsolation({stateDir, workstreamId: 'ws2', cwd: root}).boundary === undefined,
		);

		const wt = iso.worktreePath;
		writeFileSync(join(wt, 'src', 'main.ts'), 'export const a = 2;\n');
		check('changes: an uncommitted edit is visible', worktreeChanges(wt, {base: iso.base}).changed.join(',') === 'src/main.ts');
		writeFileSync(join(wt, 'src', 'new.ts'), 'export const b = 1;\n');
		check('changes: an untracked new file is visible', worktreeChanges(wt, {base: iso.base}).changed.includes('src/new.ts'));

		git(['add', '-A'], wt);
		git(['commit', '-qm', 'work'], wt);
		check('changes: committed work is still visible against the fork point', worktreeChanges(wt, {base: iso.base}).changed.length === 2);
		check(
			'changes: diffing against HEAD would have missed it, which is why base exists',
			worktreeChanges(wt, {base: 'HEAD'}).changed.length === 0,
		);
		check('changes: an unreadable worktree is not a pass', worktreeChanges(join(root, 'no-such-dir')).ok === false);

		// ---- the Bash guard against a live campaign
		writeFileSync(
			join(stateDir, 'campaign.json'),
			JSON.stringify({
				version: 2,
				approved: true,
				phase: 'executing',
				pattern: 'distributed-coding',
				milestones: [{id: 'm1', files: ['src/main.ts'], owner_role: 'worker'}],
				ownership: [{file: 'src/main.ts', milestone: 'm1', role: 'worker'}],
				workstreams: [{id: 'ws1', milestone: 'm1'}],
				gates: [],
			}),
		);

		const mainAbs = join(root, 'src', 'main.ts');
		const wtAbs = join(wt, 'src', 'main.ts');
		const lock = join(stateDir, 'ownership.json');
		const bashPayload = (command) => ({
			session_id: 'session-1',
			transcript_path: 'C:/tmp/transcript-boundary.jsonl',
			cwd: root,
			hook_event_name: 'PreToolUse',
			tool_name: 'Bash',
			tool_input: {command},
		});
		const CONFINED = {TEAMWORK_OWNER_TOKEN: 'owner-a'};
		const isDenied = (r) => r.stdout.includes('"permissionDecision":"deny"');
		const resetLock = () => rmSync(lock, {force: true});

		resetLock();
		let r = run('bash-guard.mjs', bashPayload(`echo x > "${mainAbs}"`), CONFINED);
		check('guard: a write into the shared checkout is denied', isDenied(r), r.stdout.slice(0, 200));
		check('guard: the refusal explains what it is', r.stdout.includes('boundary violation'), r.stdout.slice(0, 200));
		// Before the extractor was fixed this command was allowed: the target was read as
		// `".../repo` - truncated at the space - and a truncated path looks relative.
		check('guard: a quoted path containing a space is still attributed to the file', isDenied(r));

		resetLock();
		r = run('bash-guard.mjs', bashPayload(`echo x > "${wtAbs}"`), CONFINED);
		check('guard: a write inside the assigned worktree is allowed', !isDenied(r), r.stdout.slice(0, 200));

		resetLock();
		r = run('bash-guard.mjs', bashPayload('echo x > src/main.ts'), CONFINED);
		check('guard: a relative path is never treated as an escape', !isDenied(r), r.stdout.slice(0, 200));

		resetLock();
		r = run('bash-guard.mjs', bashPayload(`echo x > "${join(stateDir, 'worktrees', 'ws2-wt', 'src', 'main.ts')}"`), CONFINED);
		check('guard: writing into a sibling worktree is denied', isDenied(r), r.stdout.slice(0, 200));

		resetLock();
		r = run('bash-guard.mjs', bashPayload(`node -e "require('fs').writeFileSync('${mainAbs}','x')"`), CONFINED);
		check('guard: a programmatic write is refused while confined', isDenied(r), r.stdout.slice(0, 200));

		resetLock();
		r = run('bash-guard.mjs', bashPayload('node -e "console.log(1)"'), CONFINED);
		check('guard: a program that writes nothing is not refused', r.stdout === '', r.stdout.slice(0, 200));

		resetLock();
		r = run('bash-guard.mjs', bashPayload(`echo x > "${join(stateDir, 'notes.md')}"`), CONFINED);
		check('guard: campaign state stays writable for a confined owner', !isDenied(r), r.stdout.slice(0, 200));

		resetLock();
		r = run('bash-guard.mjs', bashPayload(`echo x > "${mainAbs}"`), {TEAMWORK_OWNER_TOKEN: ''});
		check('guard: with no boundary the guard behaves as it always did', r.stdout.includes('"permissionDecision":"allow"'), r.stdout.slice(0, 200));

		// `~` is only special as the first character of a word. A mid-path `~` is a literal
		// character - Windows short names are full of them, so a real workspace can sit
		// under one - and discarding such a target silently turned every check off there.
		// Both directions are asserted, because the fix must not start resolving `~/...`.
		const tildeDir = join(root, 'tilde~dir');
		mkdirSync(tildeDir, {recursive: true});
		resetLock();
		r = run('bash-guard.mjs', bashPayload(`echo x > "${join(tildeDir, 'x.ts')}"`), {TEAMWORK_OWNER_TOKEN: ''});
		check(
			'guard: a literal ~ inside a path is attributed rather than mistaken for home expansion',
			r.stdout.includes('"permissionDecision":"allow"'),
			r.stdout.slice(0, 200),
		);
		resetLock();
		r = run('bash-guard.mjs', bashPayload('echo x > ~/notes.ts'), {TEAMWORK_OWNER_TOKEN: ''});
		check('guard: a leading ~ is still treated as home expansion and left alone', r.stdout === '', r.stdout.slice(0, 200));

		// The ownership table is not replaced by the boundary: a file held by another
		// owner is still refused, even inside the assigned worktree.
		resetLock();
		writeFileSync(lock, JSON.stringify({[lockKey(wtAbs, root)]: {owner: 'tx:other', ownerSource: 'token', updatedAt: Date.now()}}));
		r = run('bash-guard.mjs', bashPayload(`echo x > "${wtAbs}"`), CONFINED);
		check('guard: the ownership table still reports a cross-owner conflict', isDenied(r), r.stdout.slice(0, 200));
	}
}

// ---------------------------------------------------------------------------

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
