// Tests for Google Antigravity Full Alignment:
// 1. Active Watchdog & Deadlock Auto-healing
// 2. Self-Succession Protocol (_gen<N+1>, retired iron rule)
// 3. 5 Antigravity Specialized Routing Paths
// 4. 11-Role System Frontmatter & Invariants
// 5. Shared Blackboard Architecture
// 6. ORIGINAL_REQUEST.md Ground Truth

import {mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

import {inspectHealth, healHealth} from '../plugins/teamwork/lib/watchdog.mjs';
import {executeSuccession, isGenerationRetired} from '../plugins/teamwork/lib/handoff.mjs';
import {recommendPath, PATHS} from '../plugins/teamwork/lib/router.mjs';
import {postUpdate, readBlackboard, queryBlackboard} from '../plugins/teamwork/lib/blackboard.mjs';
import {openEngine} from '../plugins/teamwork/lib/engine.mjs';
import {PATTERN_ROLES} from '../plugins/teamwork/lib/patterns.mjs';

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

console.log('\nantigravity-alignment.test.mjs - 100% Antigravity Alignment');

// 1. Active Watchdog & Deadlock Auto-healing
{
	const WORK = mkdtempSync(join(tmpdir(), 'teamwork-test-watchdog-'));
	const stateDir = join(WORK, '.teamwork');
	mkdirSync(stateDir, {recursive: true});

	const campaign = {
		version: 1,
		objective: 'Test Watchdog',
		phase: 'executing',
		approved: true,
		milestones: [{id: 'm1', status: 'pending'}],
		ownership: [],
	};
	writeFileSync(join(stateDir, 'campaign.json'), JSON.stringify(campaign, null, 2));

	// Write simulated expired lease in ownership.json
	const expiredLock = {
		'src/foo.js': {
			file: 'src/foo.js',
			milestone: 'm1',
			role: 'worker',
			leaseMinutes: 10,
			expiresAt: new Date(Date.now() - 3600_000).toISOString(),
		},
	};
	writeFileSync(join(stateDir, 'ownership.json'), JSON.stringify(expiredLock, null, 2));

	// Write simulated abandoned reservation
	const abandonedRes = {
		'abandoned-1': {
			at: Date.now() - 3600_000,
			agent: 'worker',
		},
	};
	writeFileSync(join(stateDir, 'spawn-reservations.json'), JSON.stringify(abandonedRes, null, 2));

	// Inspect health
	const health = inspectHealth({cwd: WORK, stateDir});
	check('watchdog: detects campaign signals', health.ok === true);
	check('watchdog: finds expired leases', health.expiredLeases.length === 1);
	check('watchdog: finds abandoned reservations', health.abandonedReservations.length === 1);

	// Heal health
	const healResult = healHealth({cwd: WORK, stateDir});
	check('watchdog: auto-heal succeeded', healResult.healed === true);
	check('watchdog: pruned expired lease', healResult.prunedLeases.includes('src/foo.js'));
	check('watchdog: pruned abandoned reservation', healResult.prunedReservations.includes('abandoned-1'));

	// Re-inspect after heal
	const postHealth = inspectHealth({cwd: WORK, stateDir});
	check('watchdog: healthy after heal', postHealth.expiredLeases.length === 0 && postHealth.abandonedReservations.length === 0);

	rmSync(WORK, {recursive: true, force: true});
}

// 2. Self-Succession Protocol & Retired Iron Rule
{
	const WORK = mkdtempSync(join(tmpdir(), 'teamwork-test-succession-'));
	const stateDir = join(WORK, '.teamwork');
	mkdirSync(stateDir, {recursive: true});

	const campaign = {
		version: 1,
		objective: 'Long Horizon Mission',
		phase: 'executing',
		approved: true,
		milestones: [{id: 'm1', deliverable: 'Core API', status: 'pending'}],
		ownership: [],
	};
	writeFileSync(join(stateDir, 'campaign.json'), JSON.stringify(campaign, null, 2));

	const succResult = executeSuccession({
		state: campaign,
		stateDir,
		generation: 1,
		reason: 'Context near compaction boundary',
	});

	check('succession: returns success', succResult.ok === true);
	check('succession: current generation is gen-1', succResult.currentGeneration === 'gen-1');
	check('succession: next generation is gen-2', succResult.nextGeneration === 'gen-2');
	check('succession: gen-1 is permanently retired', isGenerationRetired('gen-1', stateDir) === true);
	check('succession: gen-2 is not retired', isGenerationRetired('gen-2', stateDir) === false);
	check('succession: BRIEFING.md is created', existsSync(succResult.briefingPath));
	check('succession: archive JSON is created', existsSync(succResult.handoffPath));

	rmSync(WORK, {recursive: true, force: true});
}

// 3. 5 Antigravity Specialized Routing Paths
{
	const docRec = recommendPath({task: 'review whitepaper RFC manuscript for consensus', affectedFiles: ['rfc.md']});
	check('router: routes to document-review path', docRec.path === PATHS.DOCUMENT_REVIEW);

	const mathRec = recommendPath({task: 'formal proof of theorem 4.2 Colosseum pipeline', affectedFiles: ['proof.tex']});
	check('router: routes to math-proof path', mathRec.path === PATHS.MATH_PROOF);

	const quantRec = recommendPath({task: 'fuzzing exploit detection on trading arbitrage alpha', affectedFiles: ['quant.py']});
	check('router: routes to adversarial-quant path', quantRec.path === PATHS.ADVERSARIAL_QUANT);

	const sweLightRec = recommendPath({task: 'quick typo fix in readme', affectedFiles: ['README.md']});
	check('router: routes to swe-light path', sweLightRec.path === PATHS.SWE_LIGHT);
	check('router: swe-light does not decompose', sweLightRec.config.canDecompose === false);

	const generalRec = recommendPath({task: 'build user management service across 4 modules', affectedFiles: ['a.js', 'b.js', 'c.js', 'd.js']});
	check('router: routes to general path', generalRec.path === PATHS.GENERAL);
	check('router: general includes test-writer', generalRec.config.activeRoles.includes('test-writer'));
}

// 4. 11-Role System Frontmatter & Pattern Registry
{
	check('roles: test-writer in PATTERN_ROLES', PATTERN_ROLES.includes('test-writer'));
	check('roles: spec-miner in PATTERN_ROLES', PATTERN_ROLES.includes('spec-miner'));
	check('roles: empirical-challenger in PATTERN_ROLES', PATTERN_ROLES.includes('empirical-challenger'));
	check('roles: total 11 registered roles', PATTERN_ROLES.length === 11);

	// Check agent frontmatter files exist
	const agentDir = join(process.cwd(), 'plugins/teamwork/agents');
	check('agents: test-writer.md exists', existsSync(join(agentDir, 'test-writer.md')));
	check('agents: spec-miner.md exists', existsSync(join(agentDir, 'spec-miner.md')));
	check('agents: empirical-challenger.md exists', existsSync(join(agentDir, 'empirical-challenger.md')));
}

// 5. Shared Blackboard Architecture
{
	const WORK = mkdtempSync(join(tmpdir(), 'teamwork-test-blackboard-'));
	const stateDir = join(WORK, '.teamwork');
	mkdirSync(stateDir, {recursive: true});

	const post1 = postUpdate(stateDir, {apiEndpoint: 'https://api.internal/v1', port: 8080}, {author: 'worker-1', category: 'network'});
	check('blackboard: post atomic update', post1.ok === true && post1.updatedKeys.length === 2);

	const post2 = postUpdate(stateDir, {dbUri: 'postgres://localhost:5432/db'}, {author: 'worker-2', category: 'database'});
	check('blackboard: post second update', post2.ok === true);

	const bb = readBlackboard(stateDir);
	check('blackboard: reads all entries', Object.keys(bb.entries).length === 3);
	check('blackboard: preserves audit log', bb.log.length === 2);

	const netQuery = queryBlackboard(stateDir, {category: 'network'});
	check('blackboard: query by category', netQuery.count === 2 && netQuery.results.port === 8080);

	rmSync(WORK, {recursive: true, force: true});
}

// 6. ORIGINAL_REQUEST.md Ground Truth File
{
	const WORK = mkdtempSync(join(tmpdir(), 'teamwork-test-ground-truth-'));
	const engine = openEngine({cwd: WORK});

	const initRes = engine.initProject({
		objective: 'Build autonomous trading robot with zero slippage',
		mode: 'strict',
		pattern: 'distributed-coding',
	});

	check('engine: initProject succeeds', initRes.ok === true);

	const reqFile = join(WORK, 'ORIGINAL_REQUEST.md');
	check('engine: ORIGINAL_REQUEST.md created', existsSync(reqFile));

	const content = readFileSync(reqFile, 'utf8');
	check('engine: contains ground truth header', content.includes('# ORIGINAL_REQUEST (Ground Truth)'));
	check('engine: contains original objective', content.includes('Build autonomous trading robot with zero slippage'));

	rmSync(WORK, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
