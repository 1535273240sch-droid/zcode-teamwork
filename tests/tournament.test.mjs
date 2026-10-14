// Tests for the tournament pattern and the pitfall registry.
//
// A tournament spends real work on attempts that lose. Two things have to hold for that
// to be a trade rather than a waste: the candidates must actually be able to race in
// separate checkouts, and what the losing attempts got right must be written down
// before the synthesis reads it. The tests below are about those two properties.
//
//   node tests/tournament.test.mjs

import {mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

import {
	PATTERN_IDS,
	PATTERNS,
	validatePattern,
	loadPattern,
	listPatterns,
	suggestPattern,
	checkPlanAgainstPattern,
	describePattern,
} from '../plugins/teamwork/lib/patterns.mjs';

import {decompose, decomposeTournament} from '../plugins/teamwork/lib/decompose.mjs';

import {
	readPitfallRegistry,
	recordPitfall,
	pitfallsFor,
	pitfallRegistryPath,
	synthesisBrief,
} from '../plugins/teamwork/lib/blackboard.mjs';

import {TeamworkEngine} from '../plugins/teamwork/lib/engine.mjs';

const WORK = mkdtempSync(join(tmpdir(), 'teamwork-tournament-'));

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

// ---------------------------------------------------------------------------
console.log('\npattern');

check('pattern: tournament is registered', PATTERN_IDS.includes('tournament') && loadPattern('tournament').ok);
check('pattern: the set is seven', PATTERN_IDS.length === 7, PATTERN_IDS.join(','));
check('pattern: the entry validates', validatePattern(PATTERNS.tournament).length === 0, validatePattern(PATTERNS.tournament).join('; '));

check(
	'pattern: one candidate is refused, since a field of one has nothing to beat',
	validatePattern({...PATTERNS.tournament, tournament: {candidates: 1, falsifiersPerCandidate: 1}}).some((p) => /two candidates/.test(p)),
);
check(
	'pattern: a candidate with no falsifier is refused',
	validatePattern({...PATTERNS.tournament, tournament: {candidates: 3, falsifiersPerCandidate: 0}}).some((p) => /falsifier/.test(p)),
);
check(
	'pattern: the implementer still cannot be the gate',
	validatePattern({...PATTERNS.tournament, gate: {roles: ['worker', 'critic'], minIndependent: 2}}).some((p) => /includes worker/.test(p)),
);
check('pattern: the set is listable', listPatterns().length === 7 && listPatterns().some((p) => p.id === 'tournament'));
check('pattern: every entry explains when to use it', listPatterns().every((p) => typeof p.whenToUse === 'string' && p.whenToUse.length > 20));

{
	const text = describePattern('tournament');
	check('pattern: the description names the shape', text.includes('Tournament: 3 candidates'), text.slice(0, 80));
	check('pattern: the description states the isolation requirement', /own worktree/.test(text), text.slice(0, 200));
}
check('pattern: objective text can point at it', suggestPattern('pick among several competing designs') === 'tournament');
check('pattern: the older hints still win where they are more specific', suggestPattern('prove the invariant') === 'math-proof');

// ---------------------------------------------------------------------------
console.log('\nplan checking');

const candidate = (id, over = {}) => ({
	id,
	kind: 'candidate',
	candidate: Number(id.split('-')[1]),
	files: ['src/a.ts'],
	isolation: 'worktree',
	blocked_by: [],
	verified_by: 'empirical-challenger',
	...over,
});

check('plan: two isolated candidates satisfy the pattern', checkPlanAgainstPattern(PATTERNS.tournament, [candidate('candidate-1'), candidate('candidate-2')]).ok);
check(
	'plan: candidates sharing a file is not itself a fault, because isolation is what makes overlap safe',
	checkPlanAgainstPattern(PATTERNS.tournament, [candidate('candidate-1'), candidate('candidate-2')]).ok,
);
check(
	'plan: a candidate without a worktree is refused',
	checkPlanAgainstPattern(PATTERNS.tournament, [candidate('candidate-1'), candidate('candidate-2', {isolation: undefined})]).problems.some((p) => /no worktree isolation/.test(p)),
);
check(
	'plan: a blocked candidate is refused, since it cannot race',
	checkPlanAgainstPattern(PATTERNS.tournament, [candidate('candidate-1'), candidate('candidate-2', {blocked_by: ['candidate-1']})]).problems.some((p) => /cannot race/.test(p)),
);
check(
	'plan: a single candidate is refused',
	checkPlanAgainstPattern(PATTERNS.tournament, [candidate('candidate-1')]).problems.some((p) => /two candidate milestones/.test(p)),
);
check(
	'plan: a falsification milestone is not treated as an entrant, though it also carries a candidate number',
	checkPlanAgainstPattern(PATTERNS.tournament, [
		candidate('candidate-1'),
		candidate('candidate-2'),
		{id: 'falsify-1', kind: 'falsification', candidate: 1, files: [], blocked_by: ['candidate-1'], verified_by: 'critic'},
	]).ok,
);
check(
	'plan: the disjoint-file rule still applies to the patterns that rely on it',
	checkPlanAgainstPattern(PATTERNS['distributed-coding'], [
		{id: 'a', files: ['src/x.ts'], verified_by: 'critic', blocked_by: []},
		{id: 'b', files: ['src/x.ts'], verified_by: 'critic', blocked_by: []},
	]).problems.some((p) => /claimed by both/.test(p)),
);

// ---------------------------------------------------------------------------
console.log('\ndecomposition');

{
	const draft = decompose('build the fastest parser', {pattern: 'tournament', candidates: 3, falsifiersPerCandidate: 2, cwd: WORK});
	check(
		'decompose: the shape is candidates, their falsifiers, then one synthesis',
		draft.milestones.map((m) => m.id).join(',') ===
			'candidate-1,falsify-1-1,falsify-1-2,candidate-2,falsify-2-1,falsify-2-2,candidate-3,falsify-3-1,falsify-3-2,synthesis',
		draft.milestones.map((m) => m.id).join(','),
	);
	check('decompose: the round is described', draft.tournament?.candidates === 3 && draft.tournament?.falsifiersPerCandidate === 2);

	const candidates = draft.milestones.filter((m) => m.kind === 'candidate');
	check('decompose: candidates are isolated, unblocked and verified by someone else', candidates.every((m) => m.isolation === 'worktree' && m.blocked_by.length === 0 && m.verified_by === 'empirical-challenger'));
	check('decompose: candidates share one scope, which is what needs isolating', candidates[0].files.join(',') === candidates[1].files.join(','));
	check(
		'decompose: each candidate has an unblocked falsifier of its own',
		draft.milestones.filter((m) => m.kind === 'falsification').every((m) => m.blocked_by.length === 1 && m.files.length === 0),
	);
	const synthesis = draft.milestones.find((m) => m.id === 'synthesis');
	check(
		'decompose: synthesis waits for every falsification, not for the candidates',
		synthesis.blocked_by.join(',') === 'falsify-1-1,falsify-1-2,falsify-2-1,falsify-2-2,falsify-3-1,falsify-3-2',
		synthesis.blocked_by.join(','),
	);
	check('decompose: synthesis asks for the highlights, not just the failures', /pitfall-registry/.test(synthesis.acceptance));
	check('decompose: the draft satisfies its own pattern', checkPlanAgainstPattern(PATTERNS.tournament, draft.milestones).ok, checkPlanAgainstPattern(PATTERNS.tournament, draft.milestones).problems.join('; '));
}

check(
	'decompose: benchmark mode asks for real breaking inputs',
	/real data/.test(decompose('x', {pattern: 'tournament', candidates: 2, integrityMode: 'benchmark', cwd: WORK}).milestones.find((m) => m.kind === 'falsification').acceptance),
);
check(
	'decompose: a request for fewer than two candidates is still a field of two',
	decomposeTournament('x', {cwd: WORK, candidates: 1}).milestones.filter((m) => m.kind === 'candidate').length === 2,
);
check(
	'decompose: the linear draft is unchanged when no pattern is named',
	(() => {
		const linear = decompose('refactor auth across all files', {cwd: WORK});
		return linear.tournament === undefined && linear.milestones[0].id === 'survey';
	})(),
);

// ---------------------------------------------------------------------------
console.log('\npitfall registry');

{
	const stateDir = freshDir('registry');
	check('pitfall: absent reads as an empty registry', readPitfallRegistry(stateDir).pitfalls.length === 0);
	check('pitfall: a candidate is required', recordPitfall(stateDir, {reason: 'x'}).ok === false);
	check('pitfall: a reason is required', recordPitfall(stateDir, {candidate: 'c1'}).ok === false);
	check('pitfall: a blank reason is not a reason', recordPitfall(stateDir, {candidate: 'c1', reason: '   '}).ok === false);

	const written = recordPitfall(stateDir, {
		round: 1,
		candidate: 'candidate-1',
		reason: 'the streaming parser deadlocks on nested input',
		highlights: ['the token buffer is reusable', 'zero-copy slicing worked'],
	});
	check('pitfall: it is written', written.ok === true && written.replaced === false);
	check('pitfall: it is on disk', readFileSync(pitfallRegistryPath(stateDir), 'utf8').includes('token buffer'));

	const read = pitfallsFor(stateDir, {round: 1});
	check('pitfall: it reads back with its verdict', read.count === 1 && read.pitfalls[0].verdict === 'FALSIFIED');
	check('pitfall: the highlights survive', read.pitfalls[0].highlights.join(',') === 'the token buffer is reusable,zero-copy slicing worked');

	check('pitfall: re-recording one candidate replaces rather than appends', recordPitfall(stateDir, {round: 1, candidate: 'candidate-1', reason: 'revised'}).replaced === true);
	check('pitfall: so the count does not double', pitfallsFor(stateDir, {round: 1}).count === 1);
	check('pitfall: the latest reason wins', pitfallsFor(stateDir, {round: 1}).pitfalls[0].reason === 'revised');

	recordPitfall(stateDir, {round: 2, candidate: 'candidate-2', reason: 'second round'});
	check('pitfall: rounds are separable', pitfallsFor(stateDir, {round: 1}).count === 1 && pitfallsFor(stateDir, {round: 2}).count === 1);
	check('pitfall: the whole registry spans rounds', pitfallsFor(stateDir).count === 2);

	{
		const brief = synthesisBrief(stateDir, {round: 1, candidates: ['candidate-1', 'candidate-2', 'candidate-3']});
		check('brief: survivors are the candidates not falsified in this round', brief.survivors.join(',') === 'candidate-2,candidate-3', brief.survivors.join(','));
		check('brief: the falsified count is reported', brief.falsified === 1);
		check('brief: it names the candidate and its verdict', /candidate-1 - FALSIFIED/.test(brief.brief));
		check('brief: it carries the reason', /revised/.test(brief.brief));
		check('brief: it tells the reader where to start', /Start from a survivor/.test(brief.brief));
	}

	check(
		'brief: a falsification with nothing salvageable says so rather than inventing a highlight',
		(() => {
			recordPitfall(stateDir, {round: 3, candidate: 'candidate-9', reason: 'wrong approach entirely'});
			return /dead end/.test(synthesisBrief(stateDir, {round: 3}).brief);
		})(),
	);

	check(
		'pitfall: a corrupt registry reads as empty and admits it',
		(() => {
			writeFileSync(pitfallRegistryPath(stateDir), '{not json');
			const registry = readPitfallRegistry(stateDir);
			return registry.pitfalls.length === 0 && registry.corrupt === true;
		})(),
	);
}

// ---------------------------------------------------------------------------
console.log('\nengine');

{
	const cwd = freshDir('engine');
	const engine = new TeamworkEngine({cwd});
	const created = engine.initProject({objective: 'choose the best parser design among several competing approaches', pattern: 'tournament'});
	check('engine: a tournament campaign can be created', created.ok === true, created.reason);
	check('engine: the objective selected the tournament', created.state?.pattern === 'tournament', String(created.state?.pattern));

	const draft = engine.decompose({});
	check('engine: decomposition follows the pattern', draft.tournament?.candidates === 3, JSON.stringify(draft.tournament));

	const plan = engine.createPlan(draft.milestones);
	check('engine: the overlapping plan is accepted because every claimant is isolated', plan.ok === true, plan.reason);

	const stripped = engine.createPlan(draft.milestones.map(({isolation, ...rest}) => rest));
	check('engine: the same plan without isolation is refused', stripped.ok === false, JSON.stringify(stripped.reason));
	check('engine: the refusal names the remedy', /worktree/.test(String(stripped.reason)), String(stripped.reason));

	const overlapping = engine.createPlan([
		{id: 'a', files: ['src/x.ts'], verified_by: 'critic', blocked_by: []},
		{id: 'b', files: ['src/x.ts'], verified_by: 'critic', blocked_by: []},
	]);
	check('engine: overlap without isolation is still refused for any plan', overlapping.ok === false);

	check('engine: a pitfall can be recorded through the engine', engine.recordPitfall({round: 1, candidate: 'candidate-1', reason: 'blew the stack', highlights: ['the iterative core is sound']}).ok === true);
	check('engine: it is queryable', engine.pitfalls({round: 1}).count === 1);
	check('engine: the brief is available', engine.synthesisBrief({round: 1, candidates: ['candidate-1', 'candidate-2']}).survivors.join(',') === 'candidate-2');
}

// ---------------------------------------------------------------------------

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
