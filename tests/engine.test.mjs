// Tests for the Teamwork engine layer: state, ownership, verification, journal,
// handoff, and the engine that composes them.
//
// These are the modules that make decisions, so the tests are written against
// behaviour a campaign depends on rather than against coverage. Where a rule is
// load-bearing - a self-review does not count, one file has one owner - there is a
// test that would fail if the rule were quietly relaxed.
//
//   node tests/engine.test.mjs

import {mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

import {
	STATE_VERSION,
	createCampaign,
	createMilestone,
	createWorkstream,
	validateCampaign,
	loadCampaign,
	saveCampaign,
	updateCampaign,
	setPhase,
	setMilestoneStatus,
	addMilestone,
	recordGate,
	openMilestones,
	isCampaignActive,
	isCampaignComplete,
	resolveStateDir,
	stateFilePaths,
} from '../plugins/teamwork/lib/state.mjs';

import {
	normalizePath,
	createEntry,
	declare,
	claim,
	isExpired,
	renew,
	release,
	checkWrite,
	filesOf,
	findCollisions,
	expiredEntries,
	MIN_LEASE_MINUTES,
	MAX_LEASE_MINUTES,
} from '../plugins/teamwork/lib/ownership.mjs';

import {
	VERIFIER_ROLES,
	PASSING_VERDICTS,
	decideVerifiers,
	scopedPrompts,
	judgeGate,
	inspectRecord,
	createRepairWorkstream,
} from '../plugins/teamwork/lib/verification.mjs';

import {
	EVENT_KINDS,
	createEvent,
	appendEvent,
	readEvents,
	eventsOfKind,
	lastEventAt,
	summarize,
} from '../plugins/teamwork/lib/journal.mjs';

import {assessStaleness, buildHandoff, renderHandoff, STALE_MINUTES} from '../plugins/teamwork/lib/handoff.mjs';

import {TeamworkEngine} from '../plugins/teamwork/lib/engine.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'plugins', 'teamwork', 'lib', 'teamwork-cli.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'teamwork-engine-'));

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

// ---------------------------------------------------------------------------
// state.mjs

console.log('\nstate.mjs - campaign state');

{
	const state = createCampaign({objective: 'port the loader'});
	check('state: createCampaign starts in scoping', state.phase === 'scoping', state.phase);
	check('state: createCampaign is not approved', state.approved === false);
	check('state: createCampaign carries a version', state.version === STATE_VERSION, String(state.version));
	check('state: createCampaign defaults integrity to development', state.integrityMode === 'development');
	check('state: a fresh campaign validates', validateCampaign(state).length === 0, validateCampaign(state).join('; '));
}

{
	let threw = false;
	try {
		createCampaign({});
	} catch {
		threw = true;
	}
	check('state: an objective is required', threw);
}

{
	// An unknown integrity mode must not silently become a magic string.
	const state = createCampaign({objective: 'x', integrityMode: 'nonsense'});
	check('state: an unknown integrity mode falls back', state.integrityMode === 'development', state.integrityMode);
}

{
	const state = createCampaign({objective: 'x'});
	const problems = validateCampaign({...state, phase: 'made-up'});
	check('state: an unknown phase is reported', problems.some((p) => /phase/.test(p)), problems.join('; '));
}

{
	const state = createCampaign({objective: 'x'});
	const a = addMilestone(state, createMilestone({id: 'm1'}));
	const duplicated = {...a, milestones: [...a.milestones, a.milestones[0]]};
	check('state: a duplicate milestone id is reported', validateCampaign(duplicated).some((p) => /duplicate/.test(p)));
}

{
	let threw = false;
	try {
		addMilestone(createCampaign({objective: 'x'}), createMilestone({id: 'm1'}));
		addMilestone({...createCampaign({objective: 'x'}), milestones: [createMilestone({id: 'm1'})]}, createMilestone({id: 'm1'}));
	} catch {
		threw = true;
	}
	check('state: addMilestone refuses a duplicate id', threw);
}

{
	// A newer state file must be refused rather than partially understood.
	const future = {...createCampaign({objective: 'x'}), version: STATE_VERSION + 1};
	const problems = validateCampaign(future);
	check('state: a newer state version is refused', problems.some((p) => /newer/.test(p)), problems.join('; '));
}

{
	const dir = freshDir('state-write');
	const path = join(dir, 'campaign.json');
	const state = createCampaign({objective: 'x'});
	saveCampaign(state, path);
	check('state: saveCampaign creates the file', existsSync(path));
	const loaded = loadCampaign(path);
	check('state: a saved campaign round-trips', loaded?.objective === 'x', loaded?.objective);
	check('state: saveCampaign stamps updatedAt', typeof loaded.updatedAt === 'string');
}

{
	// A corrupt file must return null, never throw: every caller is a live hook.
	const dir = freshDir('state-corrupt');
	const path = join(dir, 'campaign.json');
	writeFileSync(path, '{ not json');
	check('state: loadCampaign returns null on bad JSON', loadCampaign(path) === null);
	writeFileSync(path, JSON.stringify({version: 1, objective: 'x', phase: 'nope', milestones: []}));
	check('state: loadCampaign returns null on invalid structure', loadCampaign(path) === null);
	check('state: loadCampaign can be asked to tolerate problems', loadCampaign(path, {tolerant: true}) !== null);
}

{
	// A hook that is killed mid-write must not leave a state file that parses but lies.
	const dir = freshDir('state-atomic');
	const path = join(dir, 'campaign.json');
	saveCampaign(createCampaign({objective: 'first'}), path);
	const stray = readFileSync(path, 'utf8');
	check('state: no temp files are left behind', !readdirSafe(dir).some((f) => f.includes('.tmp')), readdirSafe(dir).join(','));
	check('state: the written file is complete JSON', JSON.parse(stray).objective === 'first');
}

{
	const dir = freshDir('state-invalid-write');
	const path = join(dir, 'campaign.json');
	let threw = false;
	try {
		saveCampaign({version: 1, objective: 'x', phase: 'nope', milestones: []}, path);
	} catch {
		threw = true;
	}
	check('state: saveCampaign refuses to persist invalid state', threw);
}

{
	const dir = freshDir('state-unknown-fields');
	const path = join(dir, 'campaign.json');
	const state = createCampaign({objective: 'x'});
	saveCampaign({...state, experimentalField: {keep: true}}, path);
	const loaded = loadCampaign(path);
	check('state: unknown fields survive a round trip', loaded?.experimentalField?.keep === true, JSON.stringify(loaded?.experimentalField));
}

{
	const dir = freshDir('state-phase');
	const path = join(dir, 'campaign.json');
	let state = createCampaign({objective: 'x'});
	state = addMilestone(state, createMilestone({id: 'm1'}));
	saveCampaign(state, path);

	let threw = false;
	try {
		saveCampaign(setPhase(loadCampaign(path), 'executing'), path);
	} catch {
		threw = true;
	}
	check('state: an unapproved campaign cannot jump to executing', threw);

	// Approval is the one decision the two-phase flow exists to protect: spending
	// must not be reachable while the charter is still unread.
	let verifiedThrew = false;
	try {
		setPhase(loadCampaign(path), 'verifying');
	} catch {
		verifiedThrew = true;
	}
	check('state: an unapproved campaign cannot jump to verifying', verifiedThrew);

	let completeThrew = false;
	try {
		setPhase(loadCampaign(path), 'complete');
	} catch {
		completeThrew = true;
	}
	check('state: an unapproved campaign cannot claim completion', completeThrew);

	let abortOk = true;
	try {
		setPhase(loadCampaign(path), 'aborted');
	} catch {
		abortOk = false;
	}
	check('state: an unapproved campaign can still be aborted', abortOk);
}

{
	const dir = freshDir('state-backwards');
	const path = join(dir, 'campaign.json');
	let state = addMilestone(createCampaign({objective: 'x'}), createMilestone({id: 'm1'}));
	state = setPhase(setPhase(state, 'charter'), 'approved');
	saveCampaign(state, path);
	let threw = false;
	try {
		setPhase(loadCampaign(path), 'scoping');
	} catch {
		threw = true;
	}
	check('state: a campaign cannot move backwards', threw);
}

{
	// Aborting is reachable from anywhere and is terminal.
	const state = setPhase(createCampaign({objective: 'x'}), 'aborted');
	check('state: abort is allowed from scoping', state.phase === 'aborted');
	check('state: an aborted campaign is not active', isCampaignActive(state) === false);
}

{
	const dir = freshDir('state-gate');
	const path = join(dir, 'campaign.json');
	let state = addMilestone(createCampaign({objective: 'x'}), createMilestone({id: 'm1'}));
	state = recordGate(state, {milestone: 'm1', result: 'passed'});
	check('state: a passed gate marks the milestone verified', state.milestones[0].verified === true);
	check('state: a passed gate moves the milestone to passed', state.milestones[0].status === 'passed', state.milestones[0].status);

	const failed = recordGate(state, {milestone: 'm1', result: 'failed'});
	check('state: a failed gate leaves the milestone unverified', failed.milestones[0].verified === false);
}

{
	const dir = freshDir('state-complete');
	let state = addMilestone(createCampaign({objective: 'x'}), createMilestone({id: 'm1'}));
	check('state: a campaign with an open milestone is not complete', isCampaignComplete(state) === false);
	state = recordGate(state, {milestone: 'm1', result: 'passed'});
	// Completion is reachable only through approval: a campaign that skips it would
	// report success without anyone having agreed to the work.
	state = setPhase(setPhase(state, 'charter'), 'approved');
	state = setPhase(state, 'complete');
	check('state: a complete campaign with every milestone verified is complete', isCampaignComplete(state) === true);
}

{
	check('state: resolveStateDir defaults to .teamwork', resolveStateDir('/tmp', undefined) === join('/tmp', '.teamwork'));
	check('state: resolveStateDir honours a relative override', resolveStateDir('/tmp', 'custom') === join('/tmp', 'custom'));
	check('state: resolveStateDir honours an absolute override', resolveStateDir('/tmp', '/abs/dir') === '/abs/dir');
	const paths = stateFilePaths('/tmp/.teamwork');
	check('state: stateFilePaths names the journal', paths.journal.endsWith('journal.jsonl'), paths.journal);
}

// ---------------------------------------------------------------------------
// ownership.mjs

console.log('\nownership.mjs - one file, one owner');

{
	check('ownership: normalises backslashes', normalizePath('src\\a.ts') === 'src/a.ts', normalizePath('src\\a.ts'));
	check('ownership: normalises ./ prefix', normalizePath('./src/a.ts') === 'src/a.ts');
	check('ownership: normalises case', normalizePath('SRC/A.TS') === 'src/a.ts');
	check('ownership: collapses repeated separators', normalizePath('src//a.ts') === 'src/a.ts');
}

{
	const entry = createEntry({file: 'src/a.ts', milestone: 'm1'});
	check('ownership: an entry records the file', entry.file === 'src/a.ts');
	check('ownership: an entry carries an absolute expiry', typeof entry.expiresAt === 'string');
	check('ownership: a fresh entry is not expired', isExpired(entry) === false);
}

{
	check('ownership: an entry without expiry is expired', isExpired({file: 'x'}) === true);
	check('ownership: a malformed expiry counts as expired', isExpired({file: 'x', expiresAt: 'never'}) === true);
	check('ownership: a past expiry is expired', isExpired({file: 'x', expiresAt: new Date(Date.now() - 1000).toISOString()}) === true);
}

{
	// A declared assignment is a plan statement, not a liveness claim, and must not
	// look expired the moment it is written.
	const declared = declare({file: 'src/a.ts', milestone: 'm1'});
	check('ownership: a declared assignment never expires', isExpired(declared) === false);
	check('ownership: a declared assignment is marked', declared.declared === true);
}

{
	const lease = createEntry({file: 'a.ts', milestone: 'm1', leaseMinutes: 999999});
	check('ownership: an absurd lease is clamped', lease.leaseMinutes === MAX_LEASE_MINUTES, String(lease.leaseMinutes));
	const tiny = createEntry({file: 'a.ts', milestone: 'm1', leaseMinutes: 0});
	check('ownership: a zero lease is clamped up', tiny.leaseMinutes === MIN_LEASE_MINUTES, String(tiny.leaseMinutes));
	const bogus = createEntry({file: 'a.ts', milestone: 'm1', leaseMinutes: 'soon'});
	check('ownership: a nonsense lease falls back to the default', Number.isFinite(bogus.leaseMinutes), String(bogus.leaseMinutes));
}

{
	const first = claim([], {file: 'src/a.ts', milestone: 'm1'});
	check('ownership: an unclaimed file can be claimed', first.ok === true);
	check('ownership: claiming returns the entry', first.entry.milestone === 'm1');

	const second = claim([first.entry], {file: 'src/a.ts', milestone: 'm2'});
	check('ownership: a held file cannot be claimed by another milestone', second.ok === false, JSON.stringify(second));
	check('ownership: the refusal names the holder', second.holder?.milestone === 'm1');

	const again = claim([first.entry], {file: 'src/a.ts', milestone: 'm1'});
	check('ownership: the holder can re-claim its own file', again.ok === true && again.reused === true);
}

{
	// Two spellings of one path must not both be claimable.
	const first = claim([], {file: 'src/a.ts', milestone: 'm1'});
	const second = claim([first.entry], {file: './SRC\\A.TS', milestone: 'm2'});
	check('ownership: path spelling cannot defeat a claim', second.ok === false, JSON.stringify(second));
}

{
	// An expired lease is reclaimable, but only by taking it explicitly.
	const stale = {file: 'src/a.ts', display: 'src/a.ts', milestone: 'm1', role: 'worker', expiresAt: new Date(Date.now() - 60000).toISOString()};
	const taken = claim([stale], {file: 'src/a.ts', milestone: 'm2'});
	check('ownership: an expired lease can be reclaimed', taken.ok === true);
	check('ownership: reclaiming reports what it replaced', taken.replaced?.milestone === 'm1');
}

{
	const entry = createEntry({file: 'a.ts', milestone: 'm1', leaseMinutes: 5});
	const renewed = renew(entry, 'm1', 30);
	check('ownership: the holder can renew', renewed.ok === true);
	check('ownership: renewing extends the expiry', Date.parse(renewed.entry.expiresAt) > Date.parse(entry.expiresAt));
	const denied = renew(entry, 'm2', 30);
	check('ownership: a non-holder cannot renew', denied.ok === false, JSON.stringify(denied));
}

{
	const entry = declare({file: 'a.ts', milestone: 'm1'});
	const gone = release([entry], 'a.ts', 'm1');
	check('ownership: the holder can release', gone.ok === true && gone.ownership.length === 0);
	const wrong = release([entry], 'a.ts', 'm2');
	check('ownership: a non-holder cannot release', wrong.ok === false, JSON.stringify(wrong));
	check('ownership: releasing an unheld file is reported', release([], 'a.ts', 'm1').ok === false);
}

{
	const ownership = [declare({file: 'src/a.ts', milestone: 'm1'})];
	check('ownership: the owner may write', checkWrite(ownership, 'src/a.ts', 'm1').allowed === true);
	check('ownership: another milestone may not write', checkWrite(ownership, 'src/a.ts', 'm2').allowed === false);
	check('ownership: an unclaimed file is writable', checkWrite(ownership, 'src/b.ts', 'm2').unclaimed === true);
	const denial = checkWrite(ownership, 'src/a.ts', 'm2');
	check('ownership: the denial names the owner', denial.reason.includes('m1'), denial.reason);
}

{
	// An expired lease must not block a milestone forever, but the refusal must say
	// the lease lapsed so the reader knows it is reclaimable.
	const stale = {file: 'src/a.ts', display: 'src/a.ts', milestone: 'm1', role: 'worker', expiresAt: new Date(Date.now() - 60000).toISOString()};
	const result = checkWrite([stale], 'src/a.ts', 'm2');
	check('ownership: an expired lease is written as lapsed', result.expired === true, JSON.stringify(result));
}

{
	const ownership = [declare({file: 'src/a.ts', milestone: 'm1'}), declare({file: 'src/b.ts', milestone: 'm1'})];
	check('ownership: filesOf lists a milestone files', filesOf(ownership, 'm1').length === 2, filesOf(ownership, 'm1').join(','));
}

{
	// Collisions must be found before dispatch, not when a Worker is refused.
	const collisions = findCollisions([
		{file: 'src/a.ts', milestone: 'm1'},
		{file: './SRC/A.TS', milestone: 'm2'},
	]);
	check('ownership: findCollisions spots a shared file', collisions.length === 1, JSON.stringify(collisions));
	check('ownership: findCollisions names both milestones', collisions[0]?.milestones.length === 2);
	check('ownership: no collision when each file has one owner', findCollisions([
		{file: 'a.ts', milestone: 'm1'},
		{file: 'b.ts', milestone: 'm2'},
	]).length === 0);
}

{
	const stale = {file: 'a.ts', milestone: 'm1', expiresAt: new Date(Date.now() - 60000).toISOString()};
	const live = declare({file: 'b.ts', milestone: 'm1'});
	check('ownership: expiredEntries reports only lapsed leases', expiredEntries([stale, live]).length === 1);
}

// ---------------------------------------------------------------------------
// verification.mjs

console.log('\nverification.mjs - gates and sizing');

{
	check('verify: a self-review is not a verification role use', !VERIFIER_ROLES.includes('worker'));
	check('verify: FALSIFIED does not pass', !PASSING_VERDICTS.includes('FALSIFIED'));
	check('verify: BLOCKED does not pass', !PASSING_VERDICTS.includes('BLOCKED'));
}

{
	const small = decideVerifiers({affectedFiles: ['a.ts'], integrityMode: 'development', mode: 'standard'});
	check('verify: a one-file change gets one reviewer', small.reviewers === 1, JSON.stringify(small));
	check('verify: a one-file change needs no challenger', small.challengers === 0, JSON.stringify(small));
	check('verify: sizing explains itself', small.reasons.length > 0, JSON.stringify(small.reasons));

	const wide = decideVerifiers({affectedFiles: Array.from({length: 15}, (_, i) => `${i}.ts`), integrityMode: 'development', mode: 'standard'});
	check('verify: a wide change gets more reviewers', wide.reviewers > small.reviewers, JSON.stringify(wide));
	check('verify: a wide change gets a challenger', wide.challengers >= 1, JSON.stringify(wide));
	check('verify: sizing scales with blast radius, not line count', wide.total > small.total);
}

{
	const bench = decideVerifiers({affectedFiles: ['a.ts'], integrityMode: 'benchmark', mode: 'standard'});
	const dev = decideVerifiers({affectedFiles: ['a.ts'], integrityMode: 'development', mode: 'standard'});
	check('verify: benchmark mode raises scrutiny', bench.total > dev.total, JSON.stringify({bench, dev}));
}

{
	const strict = decideVerifiers({affectedFiles: ['a.ts'], integrityMode: 'development', mode: 'strict'});
	const quick = decideVerifiers({affectedFiles: ['a.ts'], integrityMode: 'development', mode: 'quick'});
	check('verify: strict mode raises scrutiny', strict.total > quick.total, JSON.stringify({strict, quick}));
	check('verify: quick mode drops the auditor', quick.auditor === 0, JSON.stringify(quick));
	check('verify: quick mode still requires one voice', quick.reviewers >= 1);
}

{
	const milestone = {id: 'm1', deliverable: 'port it', acceptance: 'runs', files: ['src/a.ts']};
	const sizing = decideVerifiers({affectedFiles: ['src/a.ts'], mode: 'standard'});
	const prompts = scopedPrompts(milestone, sizing);
	check('verify: prompts are produced per role', prompts.length === sizing.total, `${prompts.length} vs ${sizing.total}`);
	check('verify: prompts carry the acceptance line', prompts[0].includes('runs'), prompts[0].slice(0, 80));
	check('verify: prompts name the files', prompts[0].includes('src/a.ts'), prompts[0].slice(0, 120));

	// A challenger prompt only exists when the sizing asks for one, and the sizing
	// only asks for one on a change wide enough to deserve an adversarial read.
	const wideSizing = decideVerifiers({affectedFiles: Array.from({length: 10}, (_, i) => `${i}.ts`), mode: 'standard'});
	const widePrompts = scopedPrompts({...milestone, files: ['a.ts', 'b.ts']}, wideSizing);
	check('verify: a challenger is told to falsify', widePrompts.some((p) => /falsify/i.test(p)), JSON.stringify(wideSizing));
	check('verify: an auditor is asked to check the evidence', widePrompts.some((p) => /auditor/i.test(p) && /raw rather than summarised/i.test(p)), widePrompts.join('|').slice(0, 200));
}

{
	// The core rule: one objection is enough. Verification is not a vote.
	const agreed = judgeGate([{role: 'critic', verdict: 'SOUND'}, {role: 'auditor', verdict: 'REPRODUCED'}]);
	check('verify: unanimous agreement passes', agreed.result === 'passed', JSON.stringify(agreed));

	const objected = judgeGate([
		{role: 'critic', verdict: 'SOUND'},
		{role: 'challenger', verdict: 'FALSIFIED', reason: 'the retry path is not covered'},
	]);
	check('verify: one objection fails the gate', objected.result === 'failed', JSON.stringify(objected));
	check('verify: the objection is carried into the findings', objected.findings.some((f) => /retry path/.test(f)), JSON.stringify(objected.findings));
}

{
	check('verify: an empty gate cannot pass', judgeGate([]).result === 'failed');
	check('verify: an empty gate says why', /nothing to judge/.test(judgeGate([]).findings[0]), judgeGate([]).findings[0]);
}

{
	const selfReview = judgeGate([{role: 'critic', verdict: 'SOUND', selfReview: true}]);
	check('verify: a self-review fails the gate', selfReview.result === 'failed', JSON.stringify(selfReview));
	check('verify: a self-review is named as such', selfReview.findings.some((f) => /self-review/.test(f)), JSON.stringify(selfReview.findings));
}

{
	// Several verdicts from one role is one opinion repeated, not agreement.
	const oneRole = judgeGate([{role: 'critic', verdict: 'SOUND'}, {role: 'critic', verdict: 'SOUND'}]);
	check('verify: repeats from one role still count as one voice', oneRole.verifiers.length === 1, JSON.stringify(oneRole.verifiers));
}

{
	const unknownRole = judgeGate([{role: 'worker', verdict: 'SOUND'}]);
	check('verify: a non-verification role is refused', unknownRole.result === 'failed', JSON.stringify(unknownRole));
	check('verify: the refusal explains why', unknownRole.findings.some((f) => /not a verification role/.test(f)), JSON.stringify(unknownRole.findings));

	const badVerdict = judgeGate([{role: 'critic', verdict: 'looks fine'}]);
	check('verify: an unrecognised verdict is refused', badVerdict.result === 'failed', JSON.stringify(badVerdict));
}

{
	const nameless = judgeGate([{verdict: 'SOUND'}]);
	check('verify: a verdict without a role is refused', nameless.result === 'failed', JSON.stringify(nameless));
}

{
	const good = inspectRecord('Milestone m1\nVerifier: Auditor\nCommand: npm test\nOutput: 95 passed\nVerdict: REPRODUCED', 'm1');
	check('verify: a complete record passes inspection', good.length === 0, good.join('; '));
	check('verify: an empty record is refused', inspectRecord('', 'm1').length > 0);
	check('verify: a record that never names the milestone is refused', inspectRecord('Verifier: critic\nVerdict: SOUND', 'm1').some((p) => /names milestone/.test(p)));
	check('verify: a record with no verdict is refused', inspectRecord('m1\nVerifier: critic', 'm1').some((p) => /verdict/.test(p)));
	check('verify: a record with no verifier is refused', inspectRecord('m1\nVerdict: SOUND', 'm1').some((p) => /verifying role/.test(p)));
	check('verify: a record with no evidence is refused', inspectRecord('m1\nVerifier: critic\nVerdict: SOUND', 'm1').some((p) => /command/.test(p)));
}

{
	const repair = createRepairWorkstream({id: 'm1', owner_role: 'worker', files: ['src/a.ts']}, ['broken'], 2);
	check('verify: a repair workstream carries the findings', repair.findings.length === 1, JSON.stringify(repair));
	check('verify: a repair workstream targets the milestone', repair.milestone === 'm1');
	check('verify: repair workstreams are numbered', repair.id === 'repair-m1-2', repair.id);
	check('verify: a repair keeps the file scope', repair.files[0] === 'src/a.ts');
}

// ---------------------------------------------------------------------------
// journal.mjs

console.log('\njournal.mjs - append-only trail');

{
	const dir = freshDir('journal');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, createEvent('campaign-created', {objective: 'x'}));
	appendEvent(path, createEvent('dispatch', {agent: 'worker'}));
	check('journal: entries are appended', readEvents(path).length === 2, String(readEvents(path).length));
	check('journal: entries carry a timestamp', typeof readEvents(path)[0].at === 'string');
	check('journal: entries are filterable by kind', eventsOfKind(path, 'dispatch').length === 1);

	const summary = summarize(path);
	check('journal: summarize counts by kind', summary.byKind.dispatch === 1, JSON.stringify(summary.byKind));
	check('journal: summarize lists dispatch agents', summary.agents.includes('worker'), JSON.stringify(summary.agents));
	check('journal: summarize reports the last event', typeof summary.last === 'string');
}

{
	// A torn tail line is the normal consequence of a kill and must be skipped.
	const dir = freshDir('journal-torn');
	const path = join(dir, 'journal.jsonl');
	appendEvent(path, createEvent('note', {text: 'first'}));
	writeFileSync(path, readFileSync(path, 'utf8') + '{"kind":"note","at":');
	const events = readEvents(path);
	check('journal: a torn tail line is skipped', events.length === 1, String(events.length));
	check('journal: the intact entries survive', events[0].text === 'first');
}

{
	const dir = freshDir('journal-missing');
	check('journal: a missing journal reads as empty', readEvents(join(dir, 'nope.jsonl')).length === 0);
	check('journal: lastEventAt is null when empty', lastEventAt(join(dir, 'nope.jsonl')) === null);
}

{
	let threw = false;
	try {
		createEvent('made-up-kind');
	} catch {
		threw = true;
	}
	check('journal: an unknown event kind is refused', threw);
	check('journal: the known kinds include dispatch', EVENT_KINDS.includes('dispatch'));
}

{
	const dir = freshDir('journal-limit');
	const path = join(dir, 'journal.jsonl');
	for (let i = 0; i < 10; i++) appendEvent(path, createEvent('note', {n: i}));
	check('journal: a limit takes the tail', readEvents(path, {limit: 3}).length === 3);
	check('journal: the tail is the most recent', readEvents(path, {limit: 1})[0].n === 9, String(readEvents(path, {limit: 1})[0].n));
}

// ---------------------------------------------------------------------------
// handoff.mjs

console.log('\nhandoff.mjs - staleness and continuity');

function activeState(over = {}) {
	let state = createCampaign({objective: 'x'});
	state = addMilestone(state, {...createMilestone({id: 'm1', files: ['src/a.ts'], verified_by: 'critic'}), verified: false});
	state = setPhase(setPhase(state, 'charter'), 'approved');
	return {...state, ...over};
}

{
	const quiet = assessStaleness({state: activeState(), lastEventAt: Date.now(), now: Date.now()});
	check('handoff: a fresh campaign is not stalled', quiet.stalled === false, JSON.stringify(quiet));
}

{
	const stale = assessStaleness({
		state: activeState(),
		lastEventAt: Date.now() - (STALE_MINUTES + 5) * 60000,
		now: Date.now(),
	});
	check('handoff: silence past the threshold is stalled', stale.stalled === true, JSON.stringify(stale));
	check('handoff: the silence signal carries the minutes', stale.signals.some((s) => s.kind === 'silent' && s.minutes > 0), JSON.stringify(stale.signals));
	check('handoff: the silence signal names the open milestone', stale.signals[0].detail.includes('m1'), stale.signals[0].detail);
}

{
	// Silence alone is weak evidence: a long build looks identical. The message must
	// say so, or the reader learns to ignore it.
	const stale = assessStaleness({state: activeState(), lastEventAt: Date.now() - 60 * 60000, now: Date.now()});
	check('handoff: the silence signal admits a build looks the same', /build or test run/.test(stale.signals[0].detail), stale.signals[0].detail);
}

{
	// An expired lease is sharper than silence, and must be reported separately.
	const state = activeState({ownership: [{file: 'src/a.ts', milestone: 'm1', expiresAt: new Date(Date.now() - 600000).toISOString()}]});
	const result = assessStaleness({state, lastEventAt: Date.now(), now: Date.now()});
	check('handoff: an expired lease is its own signal', result.signals.some((s) => s.kind === 'expired-leases'), JSON.stringify(result.signals));
}

{
	// Declared ownership is not a lease and must not read as stalled.
	const state = activeState({ownership: [declare({file: 'src/a.ts', milestone: 'm1'})]});
	const result = assessStaleness({state, lastEventAt: Date.now(), now: Date.now()});
	check('handoff: a declared assignment does not look stalled', !result.signals.some((s) => s.kind === 'expired-leases'), JSON.stringify(result.signals));
}

{
	// No trail at all most likely means the hooks are untrusted, and that must be
	// reported as a possibility rather than assumed to be a stall.
	const result = assessStaleness({state: activeState(), lastEventAt: null, now: Date.now()});
	check('handoff: a missing trail is reported', result.signals.some((s) => s.kind === 'no-trail'), JSON.stringify(result.signals));
	check('handoff: the missing-trail note raises the trust prompt', /trust/.test(result.signals[0].detail), result.signals[0].detail);
}

{
	check('handoff: an inactive campaign is not stalled', assessStaleness({state: createCampaign({objective: 'x'})}).stalled === false);
	const done = activeState({milestones: [{id: 'm1', status: 'passed', verified: true}]});
	check('handoff: a campaign with no open milestones is not stalled', assessStaleness({state: done, lastEventAt: Date.now()}).stalled === false);
}

{
	const handoff = buildHandoff(activeState());
	check('handoff: a handoff lists the open milestones', handoff.openMilestones.length === 1, JSON.stringify(handoff.openMilestones));
	check('handoff: a handoff carries the objective', handoff.objective === 'x');
	check('handoff: a handoff instructs the reader not to re-plan', /Do not re-scope/.test(handoff.instruction), handoff.instruction);
	check('handoff: a handoff omits a summary of the conversation', handoff.transcript === undefined && handoff.messages === undefined);
}

{
	check('handoff: a complete campaign has nothing to hand off', buildHandoff(activeState({phase: 'complete'})).ok === false);
	check('handoff: an aborted campaign is not handed off', buildHandoff(activeState({phase: 'aborted'})).ok === false);
	check('handoff: a missing state is refused', buildHandoff(null).ok === false);
}

{
	const live = declare({file: 'src/a.ts', milestone: 'm1'});
	const handoff = buildHandoff(activeState({ownership: [live]}));
	check('handoff: a handoff lists live leases', handoff.liveLeases.length === 1, JSON.stringify(handoff.liveLeases));
	const lapsed = {file: 'src/b.ts', milestone: 'm1', expiresAt: new Date(Date.now() - 60000).toISOString()};
	check('handoff: a handoff omits lapsed leases', buildHandoff(activeState({ownership: [lapsed]})).liveLeases.length === 0);
}

{
	const text = renderHandoff(buildHandoff(activeState()));
	check('handoff: the rendering names the campaign', text.includes('Campaign: x'), text.slice(0, 120));
	check('handoff: the rendering lists the open milestone', text.includes('m1'), text.slice(0, 200));
	check('handoff: a failed handoff renders its reason', /No handoff/.test(renderHandoff({ok: false, reason: 'nope'})), renderHandoff({ok: false, reason: 'nope'}));
}

// ---------------------------------------------------------------------------
// engine.mjs

console.log('\nengine.mjs - the control surface');

function engineIn(name) {
	return new TeamworkEngine({cwd: freshDir(name)});
}

{
	const engine = engineIn('engine-init');
	const created = engine.initProject({objective: 'port the loader'});
	check('engine: initProject creates a campaign', created.ok === true, JSON.stringify(created).slice(0, 200));
	check('engine: initProject writes state to disk', existsSync(engine.paths.state));
	check('engine: initProject writes a journal entry', readEvents(engine.paths.journal).length === 1);

	// Any existing state must be replaced deliberately, not as a side effect: a
	// campaign in scoping holds the interview, which is the expensive part.
	const again = engine.initProject({objective: 'something else'});
	check('engine: initProject refuses to clobber existing state', again.ok === false, JSON.stringify(again).slice(0, 200));
	check('engine: the refusal says how to proceed', /force/.test(again.reason), again.reason);
	check('engine: the refusal reports what is there', again.existing?.objective === 'port the loader', JSON.stringify(again.existing));

	const forced = engine.initProject({objective: 'something else', force: true});
	check('engine: initProject replaces state when forced', forced.ok === true && engine.load().objective === 'something else', JSON.stringify(forced).slice(0, 200));
}

{
	const engine = engineIn('engine-approve');
	engine.initProject({objective: 'x'});
	check('engine: approve refuses a campaign with no milestones', engine.approve().ok === false);
	engine.createPlan([{id: 'm1', files: [], verified_by: 'critic'}]);
	check('engine: approve accepts a campaign with milestones', engine.approve().ok === true);
	check('engine: approve marks the campaign approved', engine.load().approved === true);
}

{
	const engine = engineIn('engine-plan');
	engine.initProject({objective: 'x'});
	const bad = engine.createPlan([{id: 'm1', files: [], verified_by: 'critic'}, {id: 'm1', files: [], verified_by: 'critic'}]);
	check('engine: createPlan refuses duplicate ids', bad.ok === false, JSON.stringify(bad).slice(0, 160));

	const missing = engine.createPlan([{id: 'm1', files: [], blocked_by: ['nope']}]);
	check('engine: createPlan refuses an unknown dependency', missing.ok === false, JSON.stringify(missing).slice(0, 160));

	const clash = engine.createPlan([
		{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'},
		{id: 'm2', files: ['./SRC/A.TS']},
	]);
	check('engine: createPlan refuses two owners for one file', clash.ok === false, JSON.stringify(clash).slice(0, 200));
	check('engine: the collision is reported in the refusal', clash.collisions?.length === 1);

	check('engine: createPlan refuses an empty list', engine.createPlan([]).ok === false);
}

{
	const engine = engineIn('engine-plan-ok');
	engine.initProject({objective: 'x'});
	const ok = engine.createPlan([
		{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'},
		{id: 'm2', files: ['src/b.ts'], blocked_by: ['m1'], verified_by: 'critic'},
	]);
	check('engine: a valid plan is accepted', ok.ok === true, JSON.stringify(ok).slice(0, 160));
	check('engine: a plan records ownership', engine.load().ownership.length === 2, String(engine.load().ownership.length));

	const replan = engine.createPlan([{id: 'm3', files: ['src/c.ts'], verified_by: 'critic'}]);
	check('engine: re-planning replaces the old plan', replan.ok === true && engine.load().milestones.length === 1, String(engine.load().milestones.length));
	check('engine: re-planning does not keep stale ownership', engine.load().ownership.length === 1, String(engine.load().ownership.length));
}

{
	const engine = engineIn('engine-claim');
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'}, {id: 'm2', files: [], verified_by: 'critic'}]);

	const denied = engine.claimFile('src/a.ts', 'm2');
	check('engine: claiming another milestone file is refused', denied.ok === false, JSON.stringify(denied).slice(0, 160));

	check('engine: the owner may write', engine.canWrite('src/a.ts', 'm1').allowed === true);
	check('engine: another milestone may not write', engine.canWrite('src/a.ts', 'm2').allowed === false);

	const claimed = engine.claimFile('src/b.ts', 'm2', {leaseMinutes: 5});
	check('engine: an unclaimed file can be claimed', claimed.ok === true, JSON.stringify(claimed).slice(0, 160));
	check('engine: claiming logs to the journal', eventsOfKind(engine.paths.journal, 'ownership-claimed').length === 1);

	const released = engine.releaseFile('src/b.ts', 'm2');
	check('engine: a lease can be released', released.ok === true);
	check('engine: releasing logs to the journal', eventsOfKind(engine.paths.journal, 'ownership-released').length === 1);
}

{
	const engine = engineIn('engine-schedule');
	engine.initProject({objective: 'x'});
	engine.createPlan([
		{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'},
		{id: 'm2', files: ['src/b.ts'], verified_by: 'critic'},
		{id: 'm3', files: ['src/c.ts'], blocked_by: ['m1'], verified_by: 'critic'},
	]);
	const schedule = engine.getSchedule();
	check('engine: independent milestones share a batch', schedule.batches[0].milestones.length === 2, JSON.stringify(schedule.batches[0]));
	check('engine: a dependent milestone waits', schedule.batches[1].milestones.includes('m3'), JSON.stringify(schedule.batches));
	check('engine: the dispatch count is reported', schedule.worker_dispatches === 3, String(schedule.worker_dispatches));
	check('engine: the budget is reported', schedule.budget === 16, String(schedule.budget));
}

{
	const engine = engineIn('engine-verify');
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'}]);

	const sizing = engine.planVerification('m1');
	check('engine: verification sizing is produced', sizing.ok === true, JSON.stringify(sizing).slice(0, 160));
	check('engine: verification prompts are produced', sizing.prompts.length > 0);

	const passed = engine.verifyMilestone('m1', [{role: 'critic', verdict: 'SOUND'}]);
	check('engine: a unanimous gate passes', passed.gate.result === 'passed', JSON.stringify(passed.gate));
	check('engine: a passed gate creates no repair', passed.repair === null);
	check('engine: a passed gate marks the milestone verified', engine.load().milestones[0].verified === true);
}

{
	const engine = engineIn('engine-repair');
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'}]);

	const failed = engine.verifyMilestone('m1', [{role: 'challenger', verdict: 'FALSIFIED', reason: 'retry path uncovered'}]);
	check('engine: an objection fails the gate', failed.gate.result === 'failed', JSON.stringify(failed.gate));
	check('engine: a failed gate creates a repair workstream', failed.repair !== null, JSON.stringify(failed.repair));
	check('engine: the repair carries the findings', failed.repair.findings.some((f) => /retry path/.test(f)), JSON.stringify(failed.repair.findings));
	check('engine: the failed milestone stays unverified', engine.load().milestones[0].verified === false);
	check('engine: the workstream is persisted', engine.load().workstreams.length === 1, String(engine.load().workstreams.length));
}

{
	const engine = engineIn('engine-final');
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'}]);
	// Completion requires approval, so the campaign has to go through it even when the
	// test is only interested in the final gate.
	engine.approve();
	check('engine: final refuses while milestones are open', engine.finalVerification([{role: 'success-auditor', verdict: 'SOUND'}]).ok === false);
	engine.verifyMilestone('m1', [{role: 'critic', verdict: 'SOUND'}]);
	const done = engine.finalVerification([{role: 'success-auditor', verdict: 'SOUND'}]);
	check('engine: final passes once everything is verified', done.ok === true, JSON.stringify(done).slice(0, 200));
	check('engine: final moves the campaign to complete', engine.load().phase === 'complete', engine.load().phase);
}

{
	const engine = engineIn('engine-status');
	engine.initProject({objective: 'port it'});
	engine.createPlan([{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'}]);
	const status = engine.status();
	check('engine: status reports the objective', status.objective === 'port it');
	check('engine: status reports the milestone', status.milestones.length === 1, JSON.stringify(status.milestones));
	check('engine: status counts the open milestones', status.open.length === 1, JSON.stringify(status.open));
	check('engine: status includes the journal summary', status.journal.total >= 2, String(status.journal.total));
	check('engine: status reports ownership', status.ownership.length === 1, String(status.ownership.length));
}

{
	const engine = engineIn('engine-cancel');
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', files: [], verified_by: 'critic'}]);
	engine.approve();
	const cancelled = engine.cancel('user stopped');
	check('engine: a campaign can be cancelled', cancelled.ok === true);
	check('engine: a cancelled campaign is not active', cancelled.state.phase === 'aborted');
	check('engine: cancelling logs a reason', eventsOfKind(engine.paths.journal, 'cancel')[0]?.reason === 'user stopped');
}

{
	const engine = engineIn('engine-handoff');
	check('engine: handoff on a missing campaign is refused', engine.handoff().ok === false);
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'}]);
	engine.approve();
	const handoff = engine.handoff('session ended');
	check('engine: handoff carries the open milestones', handoff.openMilestones.length === 1, JSON.stringify(handoff.openMilestones));
	check('engine: handoff is logged', eventsOfKind(engine.paths.journal, 'handoff').length === 1);
}

{
	const engine = engineIn('engine-stale');
	engine.initProject({objective: 'x'});
	engine.createPlan([{id: 'm1', files: [], verified_by: 'critic'}]);
	engine.approve();
	const staleness = engine.staleness();
	check('engine: staleness is assessable', typeof staleness.stalled === 'boolean', JSON.stringify(staleness));
}

{
	// A second engine pointed at the same directory must see the same campaign: the
	// hooks construct their own instances.
	const engine = engineIn('engine-shared');
	engine.initProject({objective: 'shared'});
	const other = new TeamworkEngine({cwd: engine.cwd});
	check('engine: two engines share one campaign', other.load()?.objective === 'shared', other.load()?.objective);
}

// ---------------------------------------------------------------------------
// teamwork-cli.mjs

console.log('\nteamwork-cli.mjs - the command surface');

{
	const dir = freshDir('cli');
	check('cli: no command fails loudly', runCli([], dir).code === 1);
	check('cli: an unknown command fails loudly', runCli(['nonsense'], dir).code === 1);
	check('cli: an unknown flag fails loudly', runCli(['status', '--bogus'], dir).code === 1);

	const init = runCli(['init', '--objective', 'port it'], dir);
	check('cli: init succeeds', init.code === 0, init.stderr);
	check('cli: init prints the objective', init.stdout.includes('port it'), init.stdout);

	check('cli: init without an objective fails', runCli(['init'], dir).code !== 0);
}

{
	const dir = freshDir('cli-flow');
	writeFileSync(join(dir, 'm.json'), JSON.stringify([{id: 'm1', files: ['src/a.ts'], verified_by: 'critic'}, {id: 'm2', files: ['src/b.ts'], verified_by: 'critic'}]));

	runCli(['init', '--objective', 'x'], dir);
	const plan = runCli(['plan', '--milestones', 'm.json'], dir);
	check('cli: plan succeeds', plan.code === 0, plan.stderr);
	check('cli: approve succeeds after planning', runCli(['approve'], dir).code === 0);
	check('cli: schedule succeeds', runCli(['schedule'], dir).code === 0);
	check('cli: status succeeds', runCli(['status'], dir).code === 0);
	check('cli: stale succeeds', runCli(['stale'], dir).code === 0);
	check('cli: claim succeeds', runCli(['claim', '--file', 'src/a.ts', '--milestone', 'm1'], dir).code === 0);
	check('cli: can-write allows the owner', runCli(['can-write', '--file', 'src/a.ts', '--milestone', 'm1'], dir).code === 0);
	check('cli: can-write denies another milestone', runCli(['can-write', '--file', 'src/a.ts', '--milestone', 'm2'], dir).code === 1);
	check('cli: check prints sizing', runCli(['check', '--milestone', 'm1'], dir).stdout.includes('reviewer'), runCli(['check', '--milestone', 'm1'], dir).stdout);

	writeFileSync(join(dir, 'v.json'), JSON.stringify([{role: 'critic', verdict: 'SOUND'}]));
	check('cli: verify succeeds', runCli(['verify', '--milestone', 'm1', '--verdicts', 'v.json'], dir).code === 0);
	check('cli: verify rejects a missing file', runCli(['verify', '--milestone', 'm1', '--verdicts', 'nope.json'], dir).code === 1);

	writeFileSync(join(dir, 'bad.json'), '{ not json');
	check('cli: malformed JSON fails loudly', runCli(['verify', '--milestone', 'm1', '--verdicts', 'bad.json'], dir).code === 1);
}

{
	const dir = freshDir('cli-json');
	runCli(['init', '--objective', 'x'], dir);
	const status = runCli(['status', '--json'], dir);
	let parsed = null;
	try {
		parsed = JSON.parse(status.stdout);
	} catch {
		parsed = null;
	}
	check('cli: --json emits parseable output', parsed !== null, status.stdout.slice(0, 200));
	check('cli: --json carries the objective', parsed?.objective === 'x', JSON.stringify(parsed).slice(0, 160));

	const handoff = runCli(['handoff', '--json'], dir);
	check('cli: handoff --json emits parseable output', (() => {
		try {
			JSON.parse(handoff.stdout);
			return true;
		} catch {
			return false;
		}
	})(), handoff.stdout.slice(0, 200));
}

{
	// A refusal must be visible to a shell, not just to a human reading it.
	const dir = freshDir('cli-exit');
	runCli(['init', '--objective', 'x'], dir);
	check('cli: a refusal exits non-zero', runCli(['final', '--verdicts', 'x.json'], dir).code === 1);
	check('cli: no campaign exits non-zero for status', runCli(['status'], freshDir('cli-none')).code === 1);
}

{
	const dir = freshDir('cli-state-dir');
	runCli(['init', '--objective', 'x', '--state-dir', 'custom-state'], dir);
	check('cli: --state-dir is honoured', existsSync(join(dir, 'custom-state', 'campaign.json')), readdirSafe(join(dir)).join(','));
}

// ---------------------------------------------------------------------------

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

function readdirSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
