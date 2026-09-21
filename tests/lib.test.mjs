// Tests for the Teamwork planning libraries: decompose.mjs, scheduler.mjs, and
// the plan-cli.mjs that exposes them.
//
// These are pure functions over plan data, so unlike the hook tests there is no
// subprocess involved - except for the CLI, which is exercised end to end because
// its argument handling and exit codes are part of its contract.
//
//   node tests/lib.test.mjs
//
// ASCII only: protocol artifact.

import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync, rmSync, mkdtempSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

import {decompose, surveyWorkspace} from '../plugins/teamwork/lib/decompose.mjs';
import {schedule, fileConflicts, DEFAULT_SPAWN_BUDGET} from '../plugins/teamwork/lib/scheduler.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'plugins', 'teamwork', 'lib', 'plan-cli.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'teamwork-lib-'));

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
	}
}

function runCli(args, cwd = WORK) {
	const r = spawnSync(process.execPath, [CLI, ...args], {cwd, encoding: 'utf8'});
	return {stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), code: r.status};
}

// ---------------------------------------------------------------------------
// decompose.mjs

console.log('\ndecompose.mjs - milestone drafting');

{
	const r = decompose('Refactor the auth module to use the new session store', {cwd: WORK});
	const ids = r.milestones.map((m) => m.id);
	check('decompose: a refactor objective drafts a survey first', ids[0] === 'survey', ids.join(','));
	check('decompose: refactor also drafts an implementation milestone', ids.includes('implementation'), ids.join(','));
	check('decompose: every milestone names an owner', r.milestones.every((m) => typeof m.owner_role === 'string'));
	check(
		'decompose: every milestone names a different verifier than its owner',
		r.milestones.every((m) => m.verified_by !== m.owner_role),
	);
	check('decompose: milestones chain their dependencies', r.milestones[1].blocked_by.includes('survey'));
	check('decompose: returns a note telling the orchestrator to correct the draft', typeof r.note === 'string');
}

{
	const r = decompose('Add a test for the date parser', {cwd: WORK});
	const ids = r.milestones.map((m) => m.id);
	check('decompose: a test objective drafts a tests milestone', ids.includes('tests'), ids.join(','));
	check('decompose: a test objective does not invent a survey', !ids.includes('survey'), ids.join(','));
}

{
	const r = decompose('Make the thing better', {cwd: WORK});
	const ids = r.milestones.map((m) => m.id);
	check('decompose: an unmatched objective still drafts implementation', ids.includes('implementation'), ids.join(','));
}

{
	const r = decompose('Tidy up the loader', {cwd: WORK, mode: 'strict'});
	check('decompose: strict mode adds a survey even when unasked', r.milestones[0].id === 'survey', r.milestones.map((m) => m.id).join(','));
}

{
	const r = decompose('Add tests for the parser', {cwd: WORK, integrityMode: 'benchmark'});
	const tests = r.milestones.find((m) => m.id === 'tests');
	check('decompose: benchmark mode constrains self-authored fixtures', /real inputs/.test(tests.acceptance), tests.acceptance);
}

{
	// A survey must be able to name the files it is meant to count.
	mkdirSync(join(WORK, 'src', 'inner'), {recursive: true});
	writeFileSync(join(WORK, 'src', 'a.ts'), 'x');
	writeFileSync(join(WORK, 'src', 'inner', 'b.ts'), 'x');
	mkdirSync(join(WORK, '.hidden-dir'), {recursive: true});
	writeFileSync(join(WORK, '.hidden-dir', 'secret.ts'), 'x');
	const files = surveyWorkspace(WORK);
	check('survey: finds nested files', files.some((f) => f.includes('b.ts')), files.join(','));
	check('survey: skips dot directories', !files.some((f) => f.includes('secret.ts')), files.join(','));
}

// ---------------------------------------------------------------------------
// scheduler.mjs

console.log('\nscheduler.mjs - batching');

{
	const milestones = [
		{id: 'a', status: 'pending', blocked_by: [], files: ['src/a.ts']},
		{id: 'b', status: 'pending', blocked_by: [], files: ['src/b.ts']},
		{id: 'c', status: 'pending', blocked_by: ['a'], files: ['src/c.ts']},
	];
	const r = schedule(milestones);
	check('schedule: independent milestones share the first batch', r.batches[0].milestones.includes('a') && r.batches[0].milestones.includes('b'), JSON.stringify(r.batches[0]));
	check('schedule: a dependent milestone lands in a later batch', r.batches[1].milestones.includes('c'), JSON.stringify(r.batches));
	check('schedule: marks a multi-milestone batch parallel', r.batches[0].parallel === true);
	check('schedule: counts the dispatches it needs', r.worker_dispatches === 3, String(r.worker_dispatches));
}

{
	// The central claim: two milestones naming the same file are not parallel.
	const milestones = [
		{id: 'a', status: 'pending', blocked_by: [], files: ['src/shared.ts']},
		{id: 'b', status: 'pending', blocked_by: [], files: ['src/shared.ts']},
	];
	const r = schedule(milestones);
	check('schedule: splits milestones that share a file', r.batches.length === 2, JSON.stringify(r.batches.map((b) => b.milestones)));
	check('schedule: reports the shared file', r.file_conflicts.length === 1, JSON.stringify(r.file_conflicts));
	check('schedule: warns that shared files cannot run together', r.warnings.some((w) => /share files/.test(w)), JSON.stringify(r.warnings));
}

{
	// Path spelling must not let a conflict slip through.
	const milestones = [
		{id: 'a', status: 'pending', blocked_by: [], files: ['src/x.ts']},
		{id: 'b', status: 'pending', blocked_by: [], files: ['./src/x.ts']},
		{id: 'c', status: 'pending', blocked_by: [], files: ['SRC\\X.TS']},
	];
	const conflicts = fileConflicts(milestones);
	check('schedule: normalises ./ and separators before comparing', conflicts.length === 2, JSON.stringify(conflicts));
}

{
	const milestones = [
		{id: 'a', status: 'pending', blocked_by: [], files: []},
		{id: 'b', status: 'pending', blocked_by: ['a'], files: []},
		{id: 'c', status: 'pending', blocked_by: ['b'], files: []},
	];
	const r = schedule(milestones, {budget: 2});
	check('schedule: flags a plan that exceeds the budget', r.budget_exceeded === true, JSON.stringify(r));
	check('schedule: warns about the overrun', r.warnings.some((w) => /budget/.test(w)), JSON.stringify(r.warnings));
	check('schedule: uses the default budget when none is passed', DEFAULT_SPAWN_BUDGET === 16, String(DEFAULT_SPAWN_BUDGET));
}

{
	// A cycle cannot be executed as written; reporting beats guessing.
	const milestones = [
		{id: 'a', status: 'pending', blocked_by: ['b'], files: []},
		{id: 'b', status: 'pending', blocked_by: ['a'], files: []},
	];
	const r = schedule(milestones);
	check('schedule: refuses a dependency cycle', r.ok === false && /cycle/.test(r.error), JSON.stringify(r));
}

{
	const milestones = [{id: 'a', status: 'pending', blocked_by: ['nope'], files: []}];
	const r = schedule(milestones);
	check('schedule: refuses an unknown dependency', r.ok === false && /unknown/.test(r.error), JSON.stringify(r));
}

{
	const milestones = [
		{id: 'a', status: 'done', verified: true, blocked_by: [], files: []},
		{id: 'b', status: 'pending', blocked_by: [], files: []},
	];
	const r = schedule(milestones);
	check('schedule: excludes finished milestones from batches', !r.batches.flatMap((b) => b.milestones).includes('a'), JSON.stringify(r.batches));
	check('schedule: excludes finished milestones from the dispatch count', r.worker_dispatches === 1, String(r.worker_dispatches));
}

{
	const milestones = [
		{id: 'dup', status: 'pending', blocked_by: [], files: []},
		{id: 'dup', status: 'pending', blocked_by: [], files: []},
	];
	const r = schedule(milestones);
	check('schedule: refuses duplicate milestone ids', r.ok === false, JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// plan-cli.mjs

console.log('\nplan-cli.mjs - command surface');

rmSync(join(WORK, '.teamwork'), {recursive: true, force: true});

{
	const r = runCli(['draft', '--objective', 'Migrate the config loader to JSON5']);
	check('cli: draft exits cleanly', r.code === 0, r.stderr);
	check('cli: draft prints the drafted milestones', /\[survey\]/.test(r.stdout), r.stdout.slice(0, 300));
}

{
	const r = runCli(['draft', '--json', '--objective', 'Add tests for the parser']);
	check('cli: draft --json emits parseable JSON', (() => {
		try {
			JSON.parse(r.stdout);
			return true;
		} catch {
			return false;
		}
	})(), r.stdout.slice(0, 200));
}

{
	const r = runCli(['draft']);
	check('cli: draft without an objective fails loudly', r.code === 1 && /objective/.test(r.stderr), r.stderr);
}

{
	mkdirSync(join(WORK, '.teamwork'), {recursive: true});
	writeFileSync(
		join(WORK, '.teamwork', 'plan.json'),
		JSON.stringify({
			milestones: [
				{id: 'a', status: 'pending', blocked_by: [], files: ['src/a.ts']},
				{id: 'b', status: 'pending', blocked_by: ['a'], files: ['src/b.ts']},
			],
		}),
	);
	const r = runCli(['schedule', '--budget', '4']);
	check('cli: schedule prints the batches', /batch 0/.test(r.stdout), r.stdout.slice(0, 300));
	check('cli: schedule prints the dispatch count', /Worker dispatches needed: 2/.test(r.stdout), r.stdout);
}

{
	const r = runCli(['schedule', '--json', '--budget', '1']);
	check('cli: schedule --json reports the overrun', (() => {
		try {
			return JSON.parse(r.stdout).budget_exceeded === true;
		} catch {
			return false;
		}
	})(), r.stdout.slice(0, 200));
}

{
	writeFileSync(join(WORK, '.teamwork', 'campaign.json'), JSON.stringify({objective: 'x', approved: true, phase: 'execution'}));
	const r = runCli(['status']);
	check('cli: status prints the milestone table', /Milestones/.test(r.stdout), r.stdout.slice(0, 300));
	check('cli: status reports missing verification records', /Verification records: 0/.test(r.stdout), r.stdout);
}

{
	const r = runCli(['status', '--json']);
	check('cli: status --json emits parseable JSON', (() => {
		try {
			JSON.parse(r.stdout);
			return true;
		} catch {
			return false;
		}
	})(), r.stdout.slice(0, 200));
}

{
	const r = runCli(['nonsense']);
	check('cli: an unknown command fails loudly', r.code === 1 && /unknown command/.test(r.stderr), r.stderr);
}

{
	const r = runCli(['draft', '--bogus']);
	check('cli: an unknown flag fails loudly', r.code === 1 && /unknown flag/.test(r.stderr), r.stderr);
}

// ---------------------------------------------------------------------------

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
