// Tests for the concurrency cap and the abandoned-dispatch check.
//
// Both come from one incident: eight workers dispatched in parallel, an upstream
// teardown at 20:19:47 cut all eight in-flight requests at the same instant, six
// never reported, and every surface showed success. 2.68 million tokens produced
// six stub files.
//
// The gap that incident exposed is not "too much concurrency" on its own. It is
// that a worker cut mid-flight leaves no result AND no error, so nothing in the
// system can tell it apart from a worker that finished. The cap limits how much is
// lost at once; the abandoned-dispatch check is what notices the loss at all.
//
//   node tests/concurrency.test.mjs

import {mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

import {
	resolveMaxParallel,
	admittedAtConcurrency,
	pendingDispatches,
	DEFAULT_MAX_PARALLEL,
} from '../plugins/teamwork/lib/scheduler.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO, 'plugins', 'teamwork', 'hooks', 'verification-gate.mjs');
const BUDGET = join(REPO, 'plugins', 'teamwork', 'hooks', 'spawn-budget.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'teamwork-concurrency-'));

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

function campaign(dir, extra = {}) {
	const state = join(dir, '.teamwork');
	mkdirSync(state, {recursive: true});
	writeFileSync(
		join(state, 'campaign.json'),
		JSON.stringify({objective: 'x', phase: 'executing', approved: true, milestones: [], ...extra}),
	);
	return state;
}

function runHook(hook, payload, cwd) {
	const r = spawnSync(process.execPath, [hook], {
		input: JSON.stringify({...payload, cwd, hook_event_name: payload.hook_event_name ?? 'PreToolUse'}),
		encoding: 'utf8',
	});
	return (r.stdout || '').trim();
}

// ---------------------------------------------------------------------------
// the cap

console.log('\nscheduler.mjs - the concurrency cap');

{
	check('cap: a default exists', DEFAULT_MAX_PARALLEL > 0, String(DEFAULT_MAX_PARALLEL));
	// Modest on purpose: raising it finishes faster and loses more at once.
	check('cap: the default is conservative', DEFAULT_MAX_PARALLEL <= 8, String(DEFAULT_MAX_PARALLEL));
}

{
	check('cap: falls back to the default when unset', resolveMaxParallel({}) === DEFAULT_MAX_PARALLEL, String(resolveMaxParallel({})));
	check('cap: honours an explicit value', resolveMaxParallel({maxParallel: 2}) === 2, String(resolveMaxParallel({maxParallel: 2})));
	check('cap: 0 means unlimited', resolveMaxParallel({maxParallel: 0}) === undefined, String(resolveMaxParallel({maxParallel: 0})));
	check('cap: null means unlimited', resolveMaxParallel({maxParallel: null}) === undefined, String(resolveMaxParallel({maxParallel: null})));
	check('cap: nonsense falls back to the default', resolveMaxParallel({maxParallel: 'soon'}) === DEFAULT_MAX_PARALLEL, String(resolveMaxParallel({maxParallel: 'soon'})));
	check('cap: a negative value falls back', resolveMaxParallel({maxParallel: -3}) === DEFAULT_MAX_PARALLEL, String(resolveMaxParallel({maxParallel: -3})));
	// A cap of zero would deadlock every campaign, so the floor is one.
	check('cap: a fractional value is floored to at least one', resolveMaxParallel({maxParallel: 0.4}) === 1, String(resolveMaxParallel({maxParallel: 0.4})));
}

{
	check('cap: admits below the limit', admittedAtConcurrency(2, 4).admitted === true);
	check('cap: refuses at the limit', admittedAtConcurrency(4, 4).admitted === false, JSON.stringify(admittedAtConcurrency(4, 4)));
	check('cap: refuses above the limit', admittedAtConcurrency(9, 4).admitted === false);
	check('cap: unlimited always admits', admittedAtConcurrency(99, undefined).admitted === true);
	const refusal = admittedAtConcurrency(4, 4);
	check('cap: the refusal counts what is running', /4 of 4/.test(refusal.reason), refusal.reason);
	// The reason has to explain why the trade exists, or a reader will just raise it.
	check('cap: the refusal explains the incident', /cut connection takes everything in flight/.test(refusal.reason), refusal.reason);
	check('cap: the refusal says how to change it', /maxParallel/.test(refusal.reason), refusal.reason);
}

{
	// The incident shape: eight dispatched, six never came back.
	const reservations = {};
	for (let i = 0; i < 6; i++) reservations[`r${i}`] = {at: Date.now() - 60_000, agent: 'general-purpose'};
	const pending = pendingDispatches(reservations);
	check('pending: six abandoned dispatches are found', pending.length === 6, String(pending.length));
	check('pending: each carries how long it has been silent', pending[0].minutes >= 1, String(pending[0].minutes));
	check('pending: the agent is carried through', pending[0].agent === 'general-purpose', JSON.stringify(pending[0]));
}

{
	check('pending: no reservations means nothing pending', pendingDispatches({}).length === 0);
	check('pending: an array is accepted', pendingDispatches([{at: Date.now()}]).length === 1);
	check('pending: garbage does not throw', pendingDispatches([null, 5, {}]).length === 1, JSON.stringify(pendingDispatches([null, 5, {}])));
	check('pending: a missing timestamp yields no minutes', pendingDispatches([{id: 'x'}])[0].minutes === undefined);
}

// ---------------------------------------------------------------------------
// the gate blocks on abandoned dispatches

console.log('\nverification-gate.mjs - abandoned dispatches');

{
	// The exact incident: work was produced, records look fine, but six workers went
	// silent. Without this check the turn closes green.
	const dir = freshDir('gate-abandoned');
	const state = campaign(dir, {milestones: []});
	const reservations = {};
	for (let i = 0; i < 6; i++) {
		reservations[`r${i}`] = {at: Date.now() - 300_000, tool: 'Agent', agent: 'general-purpose'};
	}
	writeFileSync(join(state, 'spawn-reservations.json'), JSON.stringify(reservations));
	const out = runHook(GATE, {hook_event_name: 'Stop', stopHookActive: false}, dir);
	const parsed = JSON.parse(out);
	check('gate: abandoned dispatches block completion', parsed.decision === 'block', out.slice(0, 300));
	check('gate: the count is reported', /6 dispatch/.test(parsed.reason), parsed.reason.slice(0, 300));
	check('gate: it says the loss would otherwise be invisible', /nothing else in this report would have/.test(parsed.reason), parsed.reason.slice(0, 600));
}

{
	// Two reservations, one consumed: the survivor's work is fine and the one that
	// vanished is still caught.
	const dir = freshDir('gate-one-abandoned');
	const state = campaign(dir, {milestones: []});
	writeFileSync(join(state, 'spawn-reservations.json'), JSON.stringify({r1: {at: Date.now() - 120_000, agent: 'worker'}}));
	const out = runHook(GATE, {hook_event_name: 'Stop', stopHookActive: false}, dir);
	const parsed = JSON.parse(out);
	check('gate: one abandoned dispatch is still caught', parsed.decision === 'block', out.slice(0, 200));
	check('gate: the agent is named', /worker/.test(parsed.reason), parsed.reason.slice(0, 300));
}

{
	// All settled: no reservations left, so nothing to report.
	const dir = freshDir('gate-settled');
	const state = campaign(dir, {milestones: []});
	writeFileSync(join(state, 'spawn-reservations.json'), JSON.stringify({}));
	const out = runHook(GATE, {hook_event_name: 'Stop', stopHookActive: false}, dir);
	check('gate: settled dispatches do not block', out === '{}', out.slice(0, 200));
}

{
	const dir = freshDir('gate-nofile');
	campaign(dir, {milestones: []});
	const out = runHook(GATE, {hook_event_name: 'Stop', stopHookActive: false}, dir);
	check('gate: a missing reservation file is not an error', out === '{}', out.slice(0, 200));
}

{
	const dir = freshDir('gate-optout');
	const state = campaign(dir, {milestones: [], requireDispatchesSettled: false});
	writeFileSync(join(state, 'spawn-reservations.json'), JSON.stringify({r1: {at: Date.now() - 600_000}}));
	const out = runHook(GATE, {hook_event_name: 'Stop', stopHookActive: false}, dir);
	check('gate: the check can be turned off', out === '{}', out.slice(0, 200));
}

// ---------------------------------------------------------------------------
// the hook enforces the cap

console.log('\nspawn-budget.mjs - the cap in the hook');

function agentCall(cwd) {
	return {hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {subagent_type: 'general-purpose'}};
}

{
	const dir = freshDir('hook-cap');
	campaign(dir, {spawnBudget: 16, maxParallel: 2});
	// Two reservations already in flight, as if two workers were dispatched in this
	// same batch and had not yet reported.
	writeFileSync(
		join(dir, '.teamwork', 'spawn-reservations.json'),
		JSON.stringify({a: {at: Date.now(), agent: 'worker'}, b: {at: Date.now(), agent: 'worker'}}),
	);
	const out = runHook(BUDGET, agentCall(dir), dir);
	const parsed = JSON.parse(out);
	check('hook: the third dispatch at a cap of two is denied', parsed.hookSpecificOutput?.permissionDecision === 'deny', out.slice(0, 300));
	check('hook: the refusal cites the concurrency cap', /concurrent dispatch slots/.test(parsed.hookSpecificOutput?.permissionDecisionReason ?? ''), out.slice(0, 400));
}

{
	const dir = freshDir('hook-cap-ok');
	campaign(dir, {spawnBudget: 16, maxParallel: 4});
	const out = runHook(BUDGET, agentCall(dir), dir);
	const parsed = JSON.parse(out);
	check('hook: the first dispatch at a cap of four is admitted', parsed.hookSpecificOutput?.permissionDecision !== 'deny', out.slice(0, 300));
}

{
	// A campaign that wants no cap is not second-guessed.
	const dir = freshDir('hook-cap-off');
	campaign(dir, {spawnBudget: 16, maxParallel: 0});
	writeFileSync(
		join(dir, '.teamwork', 'spawn-reservations.json'),
		JSON.stringify(Object.fromEntries(Array.from({length: 12}, (_, i) => [`r${i}`, {at: Date.now()}]))),
	);
	const out = runHook(BUDGET, agentCall(dir), dir);
	check('hook: an unlimited campaign admits past the default', JSON.parse(out).hookSpecificOutput?.permissionDecision !== 'deny', out.slice(0, 300));
}

{
	// The cap must not interfere with the sum: with room to run, the budget still ends
	// the campaign on schedule.
	const dir = freshDir('hook-both');
	campaign(dir, {spawnBudget: 1, maxParallel: 8});
	writeFileSync(join(dir, '.teamwork', 'events.jsonl'), JSON.stringify({event: 'dispatch', tool: 'Agent'}) + '\n');
	const out = runHook(BUDGET, agentCall(dir), dir);
	check('hook: the sum budget still applies under a loose cap', JSON.parse(out).hookSpecificOutput?.permissionDecision === 'deny', out.slice(0, 200));
}

{
	// The campaign file is what makes the two numbers configurable, so the hook must
	// reach the charter rather than a compiled-in constant.
	const dir = freshDir('hook-charter');
	const state = campaign(dir, {spawnBudget: 16, maxParallel: 1});
	const onDisk = JSON.parse(readFileSync(join(state, 'campaign.json'), 'utf8'));
	check('charter: maxParallel is a campaign field', onDisk.maxParallel === 1, JSON.stringify(onDisk.maxParallel));
	const out = runHook(BUDGET, agentCall(dir), dir);
	check('charter: the hook honours it', JSON.parse(out).hookSpecificOutput?.permissionDecision !== 'deny', out.slice(0, 200));
	writeFileSync(join(state, 'spawn-reservations.json'), JSON.stringify({a: {at: Date.now()}}));
	const out2 = runHook(BUDGET, agentCall(dir), dir);
	check('charter: a cap of one admits one and refuses the next', JSON.parse(out2).hookSpecificOutput?.permissionDecision === 'deny', out2.slice(0, 300));
}

// ---------------------------------------------------------------------------

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
