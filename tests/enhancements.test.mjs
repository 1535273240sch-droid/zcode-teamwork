// Tests for the new enhancements: router, dashboard, code deliverable adaptation, and evidence: latest
import {recommendTier, TIERS} from '../plugins/teamwork/lib/router.mjs';
import {renderDashboard} from '../plugins/teamwork/lib/dashboard.mjs';
import {inspectDeliverable, checkEvidence, captureEvidence} from '../plugins/teamwork/lib/evidence.mjs';
import {mkdirSync, writeFileSync, rmSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

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

console.log('\nenhancements.test.mjs - router & adaptive evidence');

// 1. Router test
{
	const l1 = recommendTier({task: 'fix small typo in parser', affectedFiles: ['src/parser.js']});
	check('router: small bugfix selects L1 Agile', l1.tier === TIERS.L1_AGILE, l1.tier);
	check('router: L1 skips Sentinel', l1.config.skipSentinel === true);

	const l3 = recommendTier({task: 'build quantitative backtest alpha model', affectedFiles: ['alpha.py']});
	check('router: high-risk quantitative task selects L3 Adversarial', l3.tier === TIERS.L3_ADVERSARIAL, l3.tier);

	const l2 = recommendTier({task: 'refactor user auth pipeline across 4 files', affectedFiles: ['a.js', 'b.js', 'c.js', 'd.js']});
	check('router: multi-file refactor selects L2 Standard', l2.tier === TIERS.L2_STANDARD, l2.tier);
}

// 2. Adaptive code deliverable size floor test
{
	const WORK = mkdtempSync(join(tmpdir(), 'teamwork-test-code-'));
	const smallCodeFile = join(WORK, 'fix.js');
	writeFileSync(smallCodeFile, 'export function add(a, b) {\n\treturn a + b;\n}\n'); // ~45 bytes
	const docFile = join(WORK, 'report.md');
	writeFileSync(docFile, '# Report\n\nSome heading\n'); // ~25 bytes

	const codeResult = inspectDeliverable(smallCodeFile, {minBytes: 20});
	check('deliverable: code file with valid body passes adaptive floor', codeResult.ok === true, JSON.stringify(codeResult));

	const docResult = inspectDeliverable(docFile);
	check('deliverable: tiny doc file is still rejected under 2048 floor', docResult.ok === false && docResult.kind === 'stub');

	rmSync(WORK, {recursive: true, force: true});
}

// 3. Evidence: latest auto-resolution
{
	const WORK = mkdtempSync(join(tmpdir(), 'teamwork-test-ev-'));
	const stateDir = join(WORK, '.teamwork');
	mkdirSync(join(stateDir, 'evidence'), {recursive: true});

	const evPath = captureEvidence(stateDir, {
		tool: 'Bash',
		command: 'npm test',
		output: 'All tests green',
		exitCode: 0,
		at: Date.now(),
	});

	const recText = 'Milestone m1\nVerifier: critic\nVerdict: SOUND\nevidence: latest\n';
	const result = checkEvidence(join(stateDir, 'verifications', 'm1.md'), recText, {stateDir, events: []});
	check('evidence: "evidence: latest" resolves the newly captured log automatically', result.checked === true && result.failures.length === 0, JSON.stringify(result.failures));

	rmSync(WORK, {recursive: true, force: true});
}

// 4. Dashboard rendering test
{
	const campaign = {
		objective: 'Refactor auth',
		phase: 'executing',
		pattern: 'distributed-coding',
		approved: true,
		milestones: [
			{id: 'm1', status: 'done', verified: true, owner: 'worker-1', deliverables: ['src/auth.js']},
			{id: 'm2', status: 'pending', blocked_by: ['m1'], owner: 'worker-2'},
		],
	};
	const output = renderDashboard(campaign, {dispatchesCount: 3});
	check('dashboard: produces visual dashboard with Mermaid', output.includes('graph LR') && output.includes('TEAMWORK MISSION CONTROL'));
	check('dashboard: includes progress bar and ledger', output.includes('50% (1/2 Milestones)') && output.includes('m1'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
