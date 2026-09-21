// Tests for the isolation and pattern layer.
//
// Patterns decide what a campaign's gate demands; isolation decides where a
// Worker may write. Both are load-bearing: a pattern with no gate produces
// unverified output, and isolation that silently degrades puts two Workers in one
// directory. The tests below check the boundaries, not the happy path.
//
//   node tests/patterns.test.mjs

import {mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readdirSync} from 'node:fs';
import {join, dirname, resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync, execFileSync} from 'node:child_process';

import {
	PATTERN_IDS,
	PATTERN_ROLES,
	PATTERNS,
	validatePattern,
	loadPattern,
	getPattern,
	listPatterns,
	suggestPattern,
	checkPlanAgainstPattern,
	describePattern,
} from '../plugins/teamwork/lib/patterns.mjs';

import {
	ISOLATION_MODES,
	chooseMode,
	isGitRepo,
	supportsWorktree,
	branchNameFor,
	isolationPaths,
	createIsolation,
	removeIsolation,
	describeIsolation,
	permissionsFor,
	checkRoleWrite,
	verifierPermissions,
	absoluteStateDir,
} from '../plugins/teamwork/lib/isolation.mjs';

import {
	renderBriefing,
	shouldPrepareSuccession,
	SUCCESSION_BUDGET_FRACTION,
} from '../plugins/teamwork/lib/handoff.mjs';

import {createCampaign, createMilestone, addMilestone, setPhase} from '../plugins/teamwork/lib/state.mjs';
import {TeamworkEngine} from '../plugins/teamwork/lib/engine.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'plugins', 'teamwork', 'lib', 'teamwork-cli.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'teamwork-patterns-'));

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

function runCli(args, cwd) {
	const r = spawnSync(process.execPath, [CLI, ...args], {cwd, encoding: 'utf8'});
	return {stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), code: r.status};
}

function readdirSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// patterns.mjs

console.log('\npatterns.mjs - execution shapes');

{
	check('patterns: six are defined', PATTERN_IDS.length === 6, PATTERN_IDS.join(','));
	check('patterns: ids match the catalogue', Object.keys(PATTERNS).length === 6, String(Object.keys(PATTERNS).length));
	for (const id of PATTERN_IDS) {
		const problems = validatePattern(PATTERNS[id]);
		check(`patterns: "${id}" validates`, problems.length === 0, problems.join('; '));
	}
}

{
	// The property every pattern must have: a gate that is not the implementer.
	for (const id of PATTERN_IDS) {
		const pattern = PATTERNS[id];
		check(`patterns: "${id}" excludes the worker from its gate`, !pattern.gate.roles.includes('worker'), pattern.gate.roles.join(','));
		check(`patterns: "${id}" demands two independent voices`, pattern.gate.minIndependent >= 2, String(pattern.gate.minIndependent));
		check(`patterns: "${id}" names known roles`, pattern.roles.every((r) => PATTERN_ROLES.includes(r)), pattern.roles.join(','));
	}
}

{
	// A pattern whose gate could pass on one voice is a pattern with no verification.
	const broken = {...PATTERNS['research'], gate: {roles: ['critic'], minIndependent: 1}};
	check('patterns: a one-voice gate is rejected', validatePattern(broken).some((p) => /fewer than two/.test(p)), validatePattern(broken).join('; '));
}

{
	const selfVerifying = {...PATTERNS['research'], gate: {roles: ['worker', 'critic'], minIndependent: 2}};
	check('patterns: a gate containing the worker is rejected', validatePattern(selfVerifying).some((p) => /worker/.test(p)), validatePattern(selfVerifying).join('; '));
}

{
	const unknownRole = {...PATTERNS['research'], roles: ['orchestrator', 'wizard']};
	check('patterns: an unknown role is rejected', validatePattern(unknownRole).some((p) => /unknown role/.test(p)), validatePattern(unknownRole).join('; '));
	check('patterns: an empty role list is rejected', validatePattern({...PATTERNS['research'], roles: []}).some((p) => /roles is empty/.test(p)));
	check('patterns: a non-object is rejected', validatePattern(null).length > 0);
}

{
	check('patterns: loadPattern returns the pattern', loadPattern('math-proof').ok === true);
	const missing = loadPattern('nope');
	check('patterns: an unknown id is refused', missing.ok === false);
	check('patterns: the refusal lists what is available', Array.isArray(missing.available) && missing.available.length === 6, JSON.stringify(missing.available));
	check('patterns: getPattern returns a copy of the definition', getPattern('research')?.id === 'research');
	check('patterns: getPattern returns undefined for an unknown id', getPattern('nope') === undefined);
}

{
	const listed = listPatterns();
	check('patterns: listPatterns returns all six', listed.length === 6, String(listed.length));
	check('patterns: each entry explains when to use it', listed.every((p) => typeof p.whenToUse === 'string' && p.whenToUse.length > 20));
}

{
	// The suggestion is a hint, so only the obvious cases are asserted.
	check('patterns: a proof objective suggests math-proof', suggestPattern('prove that the retry loop terminates') === 'math-proof', suggestPattern('prove that the retry loop terminates'));
	check('patterns: a research objective suggests research', suggestPattern('research which parser library is fastest') === 'research', suggestPattern('research which parser library is fastest'));
	check('patterns: a docs objective suggests document-review', suggestPattern('update the README and the migration guide') === 'document-review', suggestPattern('update the README and the migration guide'));
	check('patterns: a wide refactor suggests distributed-coding', suggestPattern('refactor the loader across every call site') === 'distributed-coding', suggestPattern('refactor the loader across every call site'));
	check('patterns: an empty objective still returns something', PATTERN_IDS.includes(suggestPattern('')), suggestPattern(''));
}

{
	// The check that keeps a plan from failing at a gate after the work is done.
	const pattern = PATTERNS['distributed-coding'];
	const good = [
		{id: 'a', owner_role: 'worker', verified_by: 'critic', files: ['x.ts'], blocked_by: []},
		{id: 'b', owner_role: 'worker', verified_by: 'critic', files: ['y.ts'], blocked_by: []},
	];
	check('patterns: a sound plan passes its pattern check', checkPlanAgainstPattern(pattern, good).ok === true, JSON.stringify(checkPlanAgainstPattern(pattern, good)));

	const shared = [
		{id: 'a', owner_role: 'worker', verified_by: 'critic', files: ['x.ts'], blocked_by: []},
		{id: 'b', owner_role: 'worker', verified_by: 'critic', files: ['./X.TS'], blocked_by: []},
	];
	const sharedCheck = checkPlanAgainstPattern(pattern, shared);
	check('patterns: a shared file fails the pattern check', sharedCheck.ok === false, JSON.stringify(sharedCheck));
	check('patterns: the shared file is named', sharedCheck.problems.some((p) => /claimed by both/.test(p)), sharedCheck.problems.join('; '));
}

{
	const pattern = PATTERNS['distributed-coding'];
	const selfVerify = [{id: 'a', owner_role: 'critic', verified_by: 'critic', files: ['x.ts']}];
	check('patterns: self-verification is caught', checkPlanAgainstPattern(pattern, selfVerify).problems.some((p) => /verify its own work/.test(p)));

	const noVerifier = [{id: 'a', owner_role: 'worker', files: ['x.ts']}];
	check('patterns: a missing verifier is caught', checkPlanAgainstPattern(pattern, noVerifier).problems.some((p) => /no verifier/.test(p)));
}

{
	// Parallelism is a claim about files. A plan that claims it while declaring no
	// files cannot be checked, so it is refused rather than assumed safe.
	const pattern = PATTERNS['distributed-coding'];
	const vague = [
		{id: 'a', owner_role: 'worker', verified_by: 'critic', files: [], blocked_by: []},
		{id: 'b', owner_role: 'worker', verified_by: 'critic', files: [], blocked_by: []},
	];
	check('patterns: parallel work with no files declared is refused', checkPlanAgainstPattern(pattern, vague).problems.some((p) => /declares no files/.test(p)), checkPlanAgainstPattern(pattern, vague).problems.join('; '));

	// A chain is not parallel, so the same vagueness is fine.
	const chain = [
		{id: 'a', owner_role: 'worker', verified_by: 'critic', files: [], blocked_by: []},
		{id: 'b', owner_role: 'worker', verified_by: 'critic', files: [], blocked_by: ['a']},
	];
	check('patterns: a serial chain may omit files', checkPlanAgainstPattern(pattern, chain).ok === true, JSON.stringify(checkPlanAgainstPattern(pattern, chain)));
}

{
	check('patterns: an empty plan is refused', checkPlanAgainstPattern(PATTERNS['research'], []).ok === false);
	const docPattern = PATTERNS['document-review'];
	const noCriteria = [{id: 'a', owner_role: 'worker', verified_by: 'critic', files: []}];
	check('patterns: document-review requires acceptance criteria', checkPlanAgainstPattern(docPattern, noCriteria).problems.some((p) => /acceptance criteria/.test(p)), checkPlanAgainstPattern(docPattern, noCriteria).problems.join('; '));
}

{
	const text = describePattern('math-proof');
	check('patterns: describePattern names the pattern', text.includes('Math proof'), text.slice(0, 60));
	check('patterns: describePattern states the gate', /at least 2 independent/.test(text), text);
	check('patterns: describePattern states the constraint', /Fixtures may not be authored/.test(text), text);
	check('patterns: describePattern handles an unknown id', /Unknown pattern/.test(describePattern('nope')));
}

// ---------------------------------------------------------------------------
// isolation.mjs

console.log('\nisolation.mjs - worker isolation');

{
	check('isolation: four modes are defined', ISOLATION_MODES.length === 4, ISOLATION_MODES.join(','));
	check('isolation: an unknown mode falls back to auto', chooseMode('nonsense', WORK) === chooseMode('auto', WORK), chooseMode('nonsense', WORK));
	// The temp dir is not a git repository, so the choice must be the directory tier.
	check('isolation: a non-git directory cannot use worktrees', supportsWorktree(WORK) === false);
	check('isolation: the chosen mode is the directory tier', chooseMode('auto', WORK) === 'isolated-dir', chooseMode('auto', WORK));
}

{
	check('isolation: a bare temp dir is not a repo', isGitRepo(WORK) === false);

	// Build the case rather than pointing at the clone. The previous version asserted
	// on REPO, which is the checkout and therefore has commits - so it tested nothing
	// and failed on any machine where the clone was complete.
	const bare = freshDir('iso-nocommit');
	let gitAvailable = true;
	try {
		execFileSync('git', ['init'], {cwd: bare, stdio: 'ignore'});
	} catch {
		gitAvailable = false;
	}

	if (gitAvailable) {
		check('isolation: a freshly initialised repo is a repo', isGitRepo(bare) === true, bare);
		check(
			'isolation: a repository without commits cannot make a worktree',
			supportsWorktree(bare) === false,
			`supportsWorktree(${bare}) returned true, but a repo with no HEAD has nothing to branch from`,
		);

		// Build the positive case too, rather than pointing at the checkout: the
		// workspace may have been extracted from an archive and hold no .git at all,
		// which would make this assertion environment-dependent rather than a test of
		// the behaviour.
		const withCommit = freshDir('iso-withcommit');
		let committed = false;
		try {
			execFileSync('git', ['init'], {cwd: withCommit, stdio: 'ignore'});
			writeFileSync(join(withCommit, 'a.txt'), 'x\n');
			execFileSync('git', ['add', '.'], {cwd: withCommit, stdio: 'ignore'});
			execFileSync(
				'git',
				[
					'-c',
					'user.email=test@example.invalid',
					'-c',
					'user.name=test',
					'commit',
					'-m',
					'first',
				],
				{cwd: withCommit, stdio: 'ignore'},
			);
			committed = true;
		} catch {
			committed = false;
		}

		if (committed) {
			check('isolation: a repository with a commit can make a worktree', supportsWorktree(withCommit) === true, `supportsWorktree(${withCommit})`);
		} else {
			check('isolation: SKIPPED, could not create a commit in this environment', false, 'git commit failed');
		}
	} else {
		// Visible skip rather than a silent pass: this branch means the environment
		// lacks git, not that the behaviour was verified.
		check('isolation: SKIPPED, git is unavailable in this environment', false, 'git not found on PATH');
	}
}

{
	// A workstream id becomes part of a git ref, so it has to survive sanitising.
	const branch = branchNameFor('worker a/b:c', 1000);
	check('isolation: the branch name is prefixed', branch.startsWith('teamwork/'), branch);
	check('isolation: the branch name carries the id', branch.includes('worker'), branch);
	check('isolation: the branch name carries the timestamp', branch.endsWith('-1000'), branch);
	check('isolation: spaces and colons are removed', !/[ :]/.test(branch), branch);
	check('isolation: a leading dash is removed', !branchNameFor('-x', 1).includes('teamwork/-'), branchNameFor('-x', 1));
	check('isolation: an empty id still yields a name', branchNameFor('', 1).startsWith('teamwork/workstream-'), branchNameFor('', 1));
	check('isolation: repeated separators are collapsed', !branchNameFor('a//b', 1).includes('//'), branchNameFor('a//b', 1));
}

{
	// Expected values are built with the same path module the implementation uses.
	// Hardcoding '/state/...' asserts a POSIX layout, which passes on Linux and
	// macOS and fails on Windows, where join() correctly produces backslashes.
	const paths = isolationPaths('/state', 'ws1');
	check('isolation: paths are nested under the state dir', paths.base === join('/state', 'worktrees', 'ws1'), paths.base);
	check('isolation: the scratch directory is inside the base', paths.scratch === join('/state', 'worktrees', 'ws1', 'scratch'), paths.scratch);
	check('isolation: the worktree has its own suffix', paths.worktree === join('/state', 'worktrees', 'ws1-wt'), paths.worktree);
}

{
	const dir = freshDir('iso-create');
	const result = createIsolation({stateDir: join(dir, '.teamwork'), workstreamId: 'ws1', cwd: dir});
	check('isolation: creation succeeds', result.ok === true, JSON.stringify(result));
	check('isolation: a non-git workspace falls back to a directory', result.mode === 'isolated-dir', result.mode);
	check('isolation: the fallback is explained', result.fallbackReason !== undefined, JSON.stringify(result));
	check('isolation: the scratch directory exists', existsSync(result.scratchDir), result.scratchDir);
	check('isolation: a log directory is created too', existsSync(result.logsDir), result.logsDir);
	// The directory is evidence a gate may still need, so it is not auto-removed.
	check('isolation: nothing is cleaned up automatically', result.cleanup === null, JSON.stringify(result.cleanup));
}

{
	const dir = freshDir('iso-shared');
	const result = createIsolation({stateDir: join(dir, '.teamwork'), workstreamId: 'ws1', cwd: dir, mode: 'shared-workspace'});
	check('isolation: shared workspace is available on request', result.mode === 'shared-workspace', result.mode);
	check('isolation: shared workspace warns', /No isolation/.test(result.warning ?? ''), result.warning);
	check('isolation: shared workspace has no scratch dir', result.scratchDir === null, String(result.scratchDir));
}

{
	const dir = freshDir('iso-missing-id');
	const result = createIsolation({stateDir: join(dir, '.teamwork'), workstreamId: '', cwd: dir});
	check('isolation: a missing workstream id is refused', result.ok === false, JSON.stringify(result));
}

{
	const dir = freshDir('iso-idempotent');
	const stateDir = join(dir, '.teamwork');
	const first = createIsolation({stateDir, workstreamId: 'ws1', cwd: dir});
	const second = createIsolation({stateDir, workstreamId: 'ws1', cwd: dir});
	check('isolation: creating twice is safe', second.ok === true && second.scratchDir === first.scratchDir, `${first.scratchDir} vs ${second.scratchDir}`);
}

{
	const dir = freshDir('iso-remove');
	const stateDir = join(dir, '.teamwork');
	createIsolation({stateDir, workstreamId: 'ws1', cwd: dir});
	const removed = removeIsolation(stateDir, 'ws1', dir);
	check('isolation: removing absent isolation is a no-op', removed.ok === true && removed.removed === false, JSON.stringify(removed));
}

{
	const text = describeIsolation({ok: true, mode: 'isolated-dir', scratchDir: '/x/scratch'});
	check('isolation: describeIsolation names the directory', text.includes('/x/scratch'), text);
	const fallen = describeIsolation({ok: true, mode: 'isolated-dir', scratchDir: '/x', fallbackFrom: 'worktree', fallbackReason: 'no commits'});
	check('isolation: a downgrade is disclosed', /fell back from worktree/.test(fallen), fallen);
	check('isolation: shared workspace is described plainly', /shared workspace/.test(describeIsolation({ok: true, mode: 'shared-workspace'})), describeIsolation({ok: true, mode: 'shared-workspace'}));
	check('isolation: a failure is described', describeIsolation({ok: false, reason: 'nope'}).includes('nope'));
}

{
	// Role permissions are what stop a verifier from editing the thing it is judging.
	const worker = permissionsFor('worker');
	check('isolation: a worker may edit', worker.mayEdit === true);

	for (const role of ['critic', 'challenger', 'auditor', 'success-auditor']) {
		const permissions = permissionsFor(role);
		check(`isolation: "${role}" may not edit`, permissions.mayEdit === false, JSON.stringify(permissions));
		check(`isolation: "${role}" may run commands to check the work`, permissions.mayRunCommands === true);
	}

	check('isolation: the orchestrator may not edit', permissionsFor('orchestrator').mayEdit === false);
	check('isolation: the explorer may not edit', permissionsFor('explorer').mayEdit === false);
	check('isolation: the sentinel may not edit', permissionsFor('sentinel').mayEdit === false);
}

{
	const denied = checkRoleWrite('critic', {mode: 'worktree'});
	check('isolation: a verifier write is refused', denied.allowed === false, JSON.stringify(denied));
	check('isolation: the refusal explains the role', /does not edit/.test(denied.reason), denied.reason);
	check('isolation: the refusal names the role', denied.role === 'critic', denied.role);

	check('isolation: a worker write is allowed', checkRoleWrite('worker').allowed === true);
	check('isolation: an unknown role is unrestricted', checkRoleWrite('mystery').allowed === true);
	check('isolation: the verifier note explains why', /evidence describe a revision/.test(verifierPermissions().note), verifierPermissions().note);
}

{
	check('isolation: an absolute state dir is passed through', absoluteStateDir('/abs', '/cwd') === '/abs');
	// resolve() is what the implementation calls, so the expectation is built the same
	// way; a literal '/cwd/rel' would only hold on POSIX.
	check('isolation: a relative state dir is resolved', absoluteStateDir('rel', '/cwd') === resolve('/cwd', 'rel'), absoluteStateDir('rel', '/cwd'));
	check('isolation: the resolved result is absolute', isAbsolute(absoluteStateDir('rel', WORK)), absoluteStateDir('rel', WORK));
}

// ---------------------------------------------------------------------------
// briefing and succession

console.log('\nbriefing - what a successor reads');

{
	check('briefing: the succession threshold is a fraction below one', SUCCESSION_BUDGET_FRACTION > 0 && SUCCESSION_BUDGET_FRACTION < 1, String(SUCCESSION_BUDGET_FRACTION));
	check('briefing: a campaign well under budget needs no briefing', shouldPrepareSuccession(3, 16) === false);
	check('briefing: a campaign near its ceiling does', shouldPrepareSuccession(15, 16) === true);
	check('briefing: exactly at the ceiling does', shouldPrepareSuccession(16, 16) === true);
	check('briefing: a nonsense budget is ignored', shouldPrepareSuccession(5, 0) === false);
	check('briefing: missing numbers are ignored', shouldPrepareSuccession(undefined, undefined) === false);
}

function progressingState() {
	let state = createCampaign({objective: 'port the loader', pattern: 'distributed-coding'});
	state = addMilestone(state, createMilestone({id: 'm1', deliverable: 'port it', acceptance: 'runs', files: ['src/a.ts'], verified_by: 'critic'}));
	state = setPhase(setPhase(state, 'charter'), 'approved');
	return state;
}

{
	const text = renderBriefing({
		state: progressingState(),
		journal: {total: 12, dispatches: 15, agents: ['worker', 'critic']},
		reason: 'spawn budget nearly exhausted',
		used: 15,
		budget: 16,
		stateDir: '.teamwork',
	});
	check('briefing: states the reason', text.includes('spawn budget nearly exhausted'), text.slice(0, 200));
	check('briefing: says where the state lives', text.includes('campaign.json') && text.includes('journal.jsonl'), text.slice(0, 400));
	check('briefing: carries the objective', text.includes('port the loader'));
	check('briefing: lists the open milestone', text.includes('m1'), text.slice(0, 600));
	check('briefing: carries the acceptance line', text.includes('runs'), text.slice(0, 600));
	check('briefing: carries the owner and verifier', text.includes('critic'), text.slice(0, 600));
	check('briefing: reports the dispatch count', text.includes('15 of 16'), text.slice(0, 500));
	check('briefing: forbids re-scoping', /Do not re-scope/.test(text), text);
	check('briefing: forbids re-planning', /Do not re-plan/.test(text), text);
	check('briefing: states the first action', /First action/.test(text), text);
}

{
	// The one thing a briefing must not do is invent a conversation summary: a
	// successor cannot check it, so it would be trusted without evidence.
	const text = renderBriefing({state: progressingState(), reason: 'test'});
	check('briefing: does not summarise the conversation', !/the user asked/i.test(text) && !/earlier you said/i.test(text), text.slice(0, 300));
	check('briefing: says the campaign is ready when nothing is open', (() => {
		let state = createCampaign({objective: 'x'});
		state = setPhase(setPhase(state, 'charter'), 'approved');
		state = {...state, milestones: [{id: 'm1', status: 'passed', verified: true, deliverable: 'd', acceptance: 'a', owner_role: 'worker', verified_by: 'critic', files: []}]};
		return /ready for final verification/.test(renderBriefing({state, reason: 'r'}));
	})());
	check('briefing: tolerates a missing state', typeof renderBriefing({reason: 'r'}) === 'string');
}

// ---------------------------------------------------------------------------
// engine integration

console.log('\nengine - patterns, isolation, briefing');

{
	const dir = freshDir('eng-pattern');
	const engine = new TeamworkEngine({cwd: dir});
	check('engine: patterns are listable', engine.listPatterns().patterns.length === 6);
	check('engine: a pattern can be suggested', engine.suggestPattern('prove the loop terminates').pattern === 'math-proof');
	check('engine: an empty objective cannot be suggested', engine.suggestPattern('').ok === false);

	engine.initProject({objective: 'prove the loop terminates'});
	check('engine: a campaign stores its pattern', engine.load().pattern === 'distributed-coding', engine.load().pattern);

	const set = engine.setPattern('math-proof');
	check('engine: the pattern can be changed before approval', set.ok === true, JSON.stringify(set).slice(0, 160));
	check('engine: the change is persisted', engine.load().pattern === 'math-proof', engine.load().pattern);
	check('engine: the description is returned', /Math proof/.test(set.description), set.description.slice(0, 60));
	check('engine: an unknown pattern is refused', engine.setPattern('nope').ok === false);
}

{
	// A plan is checked against its pattern, so a plan that could never pass its own
	// gate is refused before any work starts.
	const dir = freshDir('eng-pattern-plan');
	const engine = new TeamworkEngine({cwd: dir});
	engine.initProject({objective: 'x'});
	engine.setPattern('distributed-coding');

	const noVerifier = engine.createPlan([{id: 'm1', owner_role: 'worker', files: ['a.ts']}]);
	check('engine: a plan with no verifier is refused', noVerifier.ok === false, JSON.stringify(noVerifier).slice(0, 200));
	check('engine: the refusal names the pattern', /pattern/.test(noVerifier.reason), noVerifier.reason);

	const shared = engine.createPlan([
		{id: 'm1', owner_role: 'worker', verified_by: 'critic', files: ['a.ts']},
		{id: 'm2', owner_role: 'worker', verified_by: 'critic', files: ['./A.TS']},
	]);
	check('engine: a plan with a shared file is refused', shared.ok === false, JSON.stringify(shared).slice(0, 200));

	const sound = engine.createPlan([
		{id: 'm1', owner_role: 'worker', verified_by: 'critic', files: ['a.ts']},
		{id: 'm2', owner_role: 'worker', verified_by: 'critic', files: ['b.ts']},
	]);
	check('engine: a sound plan is accepted', sound.ok === true, JSON.stringify(sound).slice(0, 200));
}

{
	const dir = freshDir('eng-pattern-locked');
	const engine = new TeamworkEngine({cwd: dir});
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', owner_role: 'worker', verified_by: 'critic', files: ['a.ts']}]);
	engine.approve();
	// After approval the milestones were shaped for the old pattern; changing it now
	// would leave gates demanding roles the plan never accounted for.
	const locked = engine.setPattern('math-proof');
	check('engine: the pattern is locked after approval', locked.ok === false, JSON.stringify(locked).slice(0, 200));
	check('engine: the refusal explains why', /already approved/.test(locked.reason), locked.reason);
}

{
	const dir = freshDir('eng-pattern-init');
	const engine = new TeamworkEngine({cwd: dir});
	check('engine: an unknown pattern is refused at init', engine.initProject({objective: 'x', pattern: 'nope'}).ok === false);
	const ok = engine.initProject({objective: 'x', pattern: 'research', force: true});
	check('engine: a known pattern is accepted at init', ok.ok === true && engine.load().pattern === 'research', JSON.stringify(ok).slice(0, 160));
}

{
	const dir = freshDir('eng-iso');
	const engine = new TeamworkEngine({cwd: dir});
	const plan = engine.isolationPlan('ws1');
	check('engine: isolation can be planned without creating', plan.ok === true, JSON.stringify(plan));
	const created = engine.prepareIsolation('ws1');
	check('engine: isolation can be created', created.ok === true, JSON.stringify(created).slice(0, 200));
	check('engine: the scratch directory exists', existsSync(created.scratchDir), String(created.scratchDir));
}

{
	const dir = freshDir('eng-role');
	const engine = new TeamworkEngine({cwd: dir});
	check('engine: a verifier may not write', engine.canRoleWrite('critic').allowed === false);
	check('engine: a worker may write', engine.canRoleWrite('worker').allowed === true);
}

{
	const dir = freshDir('eng-succession');
	const engine = new TeamworkEngine({cwd: dir, budget: 4});
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', owner_role: 'worker', verified_by: 'critic', files: ['a.ts']}]);
	engine.approve();

	const early = engine.successionCheck();
	check('engine: succession is not due at the start', early.shouldPrepare === false, JSON.stringify(early));

	// Four recorded dispatches against a budget of four puts the campaign at its
	// ceiling, which is where a briefing has to exist before the successor arrives.
	for (let i = 0; i < 4; i++) engine.log('dispatch', {agent: 'worker', task: `t${i}`});
	const due = engine.successionCheck();
	check('engine: succession is due at the ceiling', due.shouldPrepare === true, JSON.stringify(due));
	check('engine: the count is reported', due.used === 4 && due.budget === 4, JSON.stringify(due));

	const briefing = engine.briefing('ceiling reached');
	check('engine: a briefing is rendered', briefing.ok === true && /ceiling reached/.test(briefing.briefing), JSON.stringify(briefing).slice(0, 200));
	check('engine: the briefing lists the open milestone', /m1/.test(briefing.briefing), briefing.briefing.slice(0, 400));
}

// ---------------------------------------------------------------------------
// CLI surface for the new verbs

console.log('\nteamwork-cli - new verbs');

{
	const dir = freshDir('cli-pattern-verbs');
	runCli(['init', '--objective', 'prove it'], dir);

	const patterns = runCli(['patterns'], dir);
	check('cli: patterns lists the catalogue', patterns.code === 0 && patterns.stdout.includes('distributed-coding'), patterns.stdout.slice(0, 200));
	check('cli: patterns explains each one', /Use when:/.test(patterns.stdout), patterns.stdout.slice(0, 300));

	const suggest = runCli(['pattern', '--suggest', 'prove the loop terminates'], dir);
	check('cli: pattern --suggest works', suggest.code === 0 && suggest.stdout.includes('math-proof'), suggest.stdout.slice(0, 200));

	const show = runCli(['pattern'], dir);
	check('cli: pattern shows the current one', show.code === 0 && /Distributed coding/.test(show.stdout), show.stdout.slice(0, 200));

	const set = runCli(['pattern', '--set', 'research'], dir);
	check('cli: pattern --set works', set.code === 0 && /Research/.test(set.stdout), set.stdout.slice(0, 200));
	check('cli: an unknown pattern fails loudly', runCli(['pattern', '--set', 'nope'], dir).code === 1);
}

{
	const dir = freshDir('cli-iso-brief');
	runCli(['init', '--objective', 'x'], dir);

	const planned = runCli(['isolation'], dir);
	check('cli: isolation reports the tier', planned.code === 0 && planned.stdout.includes('isolated-dir'), planned.stdout);

	const prepared = runCli(['isolation', '--prepare', 'ws1'], dir);
	check('cli: isolation --prepare creates one', prepared.code === 0, prepared.stdout || prepared.stderr);

	const briefing = runCli(['briefing'], dir);
	check('cli: briefing renders', briefing.code === 0 && /Teamwork briefing/.test(briefing.stdout), briefing.stdout.slice(0, 200));

	const succession = runCli(['succession'], dir);
	check('cli: succession reports the count', succession.code === 0 && /Dispatches used/.test(succession.stdout), succession.stdout.slice(0, 200));
}

{
	const dir = freshDir('cli-pattern-json');
	runCli(['init', '--objective', 'x'], dir);
	const json = runCli(['patterns', '--json'], dir);
	let parsed = null;
	try {
		parsed = JSON.parse(json.stdout);
	} catch {
		parsed = null;
	}
	check('cli: patterns --json parses', parsed !== null && Array.isArray(parsed.patterns), json.stdout.slice(0, 200));
}

// ---------------------------------------------------------------------------

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
