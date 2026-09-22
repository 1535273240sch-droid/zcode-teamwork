// Tests for the evidence and deliverable checks.
//
// Both cases here are drawn from real incidents rather than invented:
//
//   - six review workers reported success and wrote heading-only stubs of 802,
//     1008 and 1839 bytes; the gate passed every one because it read the record and
//     the record said the right words
//   - one worker wrote a fabricated `npm test` transcript into its record, and the
//     gate accepted it for the same reason
//
// The tests are written against those shapes, because a check that only passes its
// own fixtures has proved nothing about the failure it exists to catch.
//
//   node tests/evidence.test.mjs

import {mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

import {
	inspectDeliverable,
	stripHeadings,
	checkDeliverables,
	evidenceName,
	evidencePath,
	captureEvidence,
	modelAuthoredEvidence,
	evidenceRefs,
	checkEvidence,
	describeDeliverableRules,
	MIN_DELIVERABLE_BYTES,
	EVIDENCE_DIR,
} from '../plugins/teamwork/lib/evidence.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO, 'plugins', 'teamwork', 'hooks', 'verification-gate.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'teamwork-evidence-'));

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

function write(path, content) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content);
}

// ---------------------------------------------------------------------------
// deliverable inspection

console.log('\nevidence.mjs - deliverable inspection');

{
	const dir = freshDir('del-missing');
	const result = inspectDeliverable(join(dir, 'nope.md'));
	check('deliverable: a missing file is reported as missing', result.kind === 'missing', result.kind);
	check('deliverable: a missing file is not ok', result.ok === false);
}

{
	// The real incident numbers: 802, 1008 and 1839 bytes, all heading-only.
	const dir = freshDir('del-stub');
	const stub = join(dir, 'findings-server.md');
	write(stub, '# findings: server\n\n## scope\n\n## method\n\n## results\n\n## conclusion\n');
	const result = inspectDeliverable(stub);
	check('deliverable: a heading-only stub is rejected', result.ok === false, JSON.stringify(result));
	check('deliverable: the stub is named as a stub', result.kind === 'stub', result.kind);
	check('deliverable: the size floor is cited', result.reasons.some((r) => /below the/.test(r)), JSON.stringify(result.reasons));
	check('deliverable: the absence of body text is cited', result.reasons.some((r) => /only headings/.test(r)), JSON.stringify(result.reasons));
}

{
	const dir = freshDir('del-placeholder');
	const file = join(dir, 'findings-infra.md');
	// The exact marker left behind in the incident.
	write(file, `# infra findings\n\n${'real analysis line\n'.repeat(200)}\nFINDINGS-PLACEHOLDER\n`);
	const result = inspectDeliverable(file);
	check('deliverable: a placeholder marker is rejected', result.ok === false, JSON.stringify(result));
	check('deliverable: the marker is named', result.reasons.some((r) => /FINDINGS-PLACEHOLDER/.test(r)), JSON.stringify(result.reasons));
}

{
	const dir = freshDir('del-real');
	const file = join(dir, 'findings-musetalk.md');
	// The survivor's shape: 23,818 bytes of actual prose.
	write(file, `# musetalk findings\n\n${'A finding with detail and a file reference.\n'.repeat(600)}\nVerdict: SOUND\n`);
	const result = inspectDeliverable(file);
	check('deliverable: a real report passes', result.ok === true, JSON.stringify(result));
	check('deliverable: the real report is classed as content', result.kind === 'content', result.kind);
	check('deliverable: the byte count is reported', result.bytes > 20000, String(result.bytes));
}

{
	const dir = freshDir('del-empty');
	const file = join(dir, 'empty.md');
	write(file, '');
	check('deliverable: an empty file is rejected', inspectDeliverable(file).kind === 'empty');
}

{
	// Prose *about* a placeholder marker is not a placeholder. A report describing
	// the defect must not be read as committing it.
	const dir = freshDir('del-mentions');
	const file = join(dir, 'report-about-defects.md');
	write(file, `# report\n\n${'Detailed analysis of the failure mode and its cause.\n'.repeat(200)}\nThe FINDINGS-PLACEHOLDER marker was found in a sibling file.\n`);
	const result = inspectDeliverable(file);
	check('deliverable: mentioning a marker is still a rejection', result.ok === false, 'markers are matched literally');
}

{
	const dir = freshDir('del-dir');
	mkdirSync(join(dir, 'a-directory'));
	check('deliverable: a directory is not a file', inspectDeliverable(join(dir, 'a-directory')).kind === 'not-a-file');
}

{
	check('strip: headings are removed', stripHeadings('# a\n## b\ntext\n').trim() === 'text');
	check('strip: horizontal rules are removed', stripHeadings('---\ntext\n').trim() === 'text');
	check('strip: a file of only headings yields nothing', stripHeadings('# a\n## b\n').trim() === '');
}

{
	const dir = freshDir('del-check');
	write(join(dir, 'good.md'), `# ok\n${'body line\n'.repeat(300)}`);
	const milestone = {id: 'm1', deliverables: ['good.md', 'missing.md']};
	const result = checkDeliverables(milestone, dir);
	check('deliverables: the check runs when deliverables are declared', result.checked === true);
	check('deliverables: the missing one fails', result.failures.some((f) => /missing.md/.test(f)), JSON.stringify(result.failures));
	check('deliverables: the good one does not fail', !result.failures.some((f) => /good.md/.test(f)), JSON.stringify(result.failures));
	check('deliverables: a milestone without deliverables is skipped', checkDeliverables({id: 'm2'}, dir).checked === false);
}

{
	check('deliverable: the rules can be described', /at least/.test(describeDeliverableRules()), describeDeliverableRules());
	check('deliverable: the floor is a real number', MIN_DELIVERABLE_BYTES > 0, String(MIN_DELIVERABLE_BYTES));
}

// ---------------------------------------------------------------------------
// evidence capture

console.log('\nevidence.mjs - evidence capture');

{
	const dir = freshDir('cap');
	const relative = captureEvidence(dir, {
		at: Date.now(),
		tool: 'Bash',
		toolUseId: 'abc-123',
		command: 'npm test',
		output: 'x'.repeat(5000),
		exitCode: 0,
		failed: false,
	});
	check('capture: returns a path to cite', typeof relative === 'string' && relative.endsWith('.log'), String(relative));
	const full = join(dir, relative);
	const text = readFileSync(full, 'utf8');
	check('capture: records the command', /npm test/.test(text), text.slice(0, 200));
	check('capture: records the exit code', /exit_code: 0/.test(text), text.slice(0, 300));
	check('capture: records the output size', /output_bytes: 5000/.test(text), text.slice(0, 300));
	check('capture: records a hash', /output_sha256: [0-9a-f]{64}/.test(text), text.slice(0, 400));
	// Deliberately not the full output: see the note at the top of audit-log.mjs.
	check('capture: does not store the full output', text.length < 2000, String(text.length));
}

{
	const dir = freshDir('cap-noid');
	const relative = captureEvidence(dir, {at: Date.now(), tool: 'Bash', output: 'x'.repeat(100), command: 'ls'});
	check('capture: works without a tool_use_id', typeof relative === 'string', String(relative));
	check('capture: the name is sanitised', !/[^A-Za-z0-9._/-]/.test(relative), relative);
}

{
	check('evidence: name is derived from the id', evidenceName('abc/def:ghi') === 'abc-def-ghi.log', evidenceName('abc/def:ghi'));
	check('evidence: a missing id still yields a name', evidenceName(undefined).endsWith('.log'), evidenceName(undefined));
	check('evidence: the path is under the state dir', evidencePath('/s', 'a.log') === join('/s', EVIDENCE_DIR, 'a.log'), evidencePath('/s', 'a.log'));
}

// ---------------------------------------------------------------------------
// forgery detection

console.log('\nevidence.mjs - detecting evidence the model wrote');

{
	// The incident shape: the trail shows a Write call creating a file inside
	// evidence/. That file is the claimant's own work.
	const events = [
		{event: 'tool', tool: 'Bash', command: 'npm test'},
		{event: 'tool', tool: 'Write', file: '.teamwork/evidence/tests-run.log'},
	];
	const forged = modelAuthoredEvidence(events);
	check('forgery: a Write into evidence/ is detected', forged.size === 1, JSON.stringify([...forged]));
}

{
	const events = [
		{event: 'tool', tool: 'Bash', command: 'npm test'},
		{event: 'tool', tool: 'Write', file: 'tests/journal-boundary.test.mjs'},
	];
	check('forgery: a Write elsewhere is not flagged', modelAuthoredEvidence(events).size === 0, JSON.stringify([...modelAuthoredEvidence(events)]));
}

{
	check('forgery: an empty trail yields nothing', modelAuthoredEvidence([]).size === 0);
	check('forgery: a malformed event does not throw', modelAuthoredEvidence([null, {}, {file: 5}]).size === 0);
}

// ---------------------------------------------------------------------------
// evidence references and judgement

console.log('\nevidence.mjs - judging the citations');

{
	const refs = evidenceRefs('Verdict: SOUND\nevidence: .teamwork/evidence/m1-run.log\n');
	check('refs: a citation is found', refs.length === 1, JSON.stringify(refs));
	check('refs: the path is preserved', refs[0].includes('m1-run.log'), refs[0]);
}

{
	check('refs: a bare filename is accepted', evidenceRefs('evidence: run.log').length === 1, JSON.stringify(evidenceRefs('evidence: run.log')));
	check('refs: backticks are tolerated', evidenceRefs('evidence: `run.log`')[0] === 'run.log', JSON.stringify(evidenceRefs('evidence: `run.log`')));
	check('refs: several citations are collected', evidenceRefs('evidence: a.log\nevidence: b.log').length === 2);
	check('refs: no citation yields nothing', evidenceRefs('Verdict: SOUND').length === 0);
}

{
	const dir = freshDir('judge-none');
	const result = checkEvidence('verifications/m1.md', 'Verdict: SOUND', {stateDir: join(dir, '.teamwork'), events: []});
	check('judge: a record with no citation is rejected', result.failures.length === 1, JSON.stringify(result.failures));
	check('judge: the rejection says what to add', /evidence:/.test(result.failures[0]), result.failures[0]);
}

{
	const dir = freshDir('judge-missing');
	const result = checkEvidence('verifications/m1.md', 'evidence: .teamwork/evidence/gone.log', {stateDir: join(dir, '.teamwork'), events: []});
	check('judge: a citation to a nonexistent file is rejected', result.failures.some((f) => /no such file/.test(f)), JSON.stringify(result.failures));
}

{
	const dir = freshDir('judge-empty');
	const stateDir = join(dir, '.teamwork');
	write(join(stateDir, EVIDENCE_DIR, 'empty.log'), '');
	const result = checkEvidence('verifications/m1.md', 'evidence: .teamwork/evidence/empty.log', {stateDir, events: []});
	// Assert on the reason, not just on the word appearing somewhere in the message:
	// the filename itself contains "empty", so a loose match passes even when the
	// real failure is that the file could not be found.
	check('judge: a citation to an empty file is rejected', result.failures.some((f) => /the file is empty/.test(f)), JSON.stringify(result.failures));
}

{
	const dir = freshDir('judge-forged');
	const stateDir = join(dir, '.teamwork');
	write(join(stateDir, EVIDENCE_DIR, 'tests-run.log'), 'Tests: 132 passed, 73 failed\n'.repeat(20));
	// The trail shows the model wrote this file itself, which is exactly the forgery
	// from the incident: a fabricated transcript presented as captured output.
	const events = [{event: 'tool', tool: 'Write', file: '.teamwork/evidence/tests-run.log'}];
	const result = checkEvidence('verifications/tests.md', 'Verdict: REPRODUCED\nevidence: .teamwork/evidence/tests-run.log', {
		stateDir,
		events,
	});
	check('judge: model-authored evidence is rejected', result.failures.some((f) => /written by a tool call/.test(f)), JSON.stringify(result.failures));
	check('judge: the rejection explains the rule', result.failures.some((f) => /not by the claimant/.test(f)), JSON.stringify(result.failures));
}

{
	const dir = freshDir('judge-good');
	const stateDir = join(dir, '.teamwork');
	write(join(stateDir, EVIDENCE_DIR, 'm1-run.log'), 'captured by audit-log\nreal output\n');
	// The trail shows no Write into evidence/, so the file was captured.
	const events = [{event: 'tool', tool: 'Bash', command: 'npm test'}];
	const result = checkEvidence('verifications/m1.md', 'Milestone m1\nVerdict: SOUND\nevidence: .teamwork/evidence/m1-run.log', {
		stateDir,
		events,
	});
	check('judge: captured evidence passes', result.failures.length === 0, JSON.stringify(result.failures));
	check('judge: the check reports it ran', result.checked === true);
}

{
	const dir = freshDir('judge-optout');
	const result = checkEvidence('verifications/m1.md', 'Verdict: SOUND', {stateDir: join(dir, '.teamwork'), events: [], requireEvidence: false});
	check('judge: the requirement can be turned off', result.failures.length === 0, JSON.stringify(result.failures));
}

// ---------------------------------------------------------------------------
// the gate, end to end

console.log('\nverification-gate.mjs - wired to evidence');

function runGate(cwd) {
	const r = spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({hook_event_name: 'Stop', cwd, stopHookActive: false}),
		encoding: 'utf8',
	});
	return (r.stdout || '').trim();
}

function campaign(dir, extra = {}) {
	const state = join(dir, '.teamwork');
	mkdirSync(state, {recursive: true});
	writeFileSync(
		join(state, 'campaign.json'),
		JSON.stringify({objective: 'x', phase: 'executing', approved: true, milestones: [], ...extra}),
	);
}

{
	// The incident, reproduced: a milestone marked done whose deliverable is a stub,
	// with a record that reads perfectly. This must block.
	const dir = freshDir('gate-stub');
	campaign(dir, {milestones: [{id: 'm1', status: 'done', deliverables: ['findings-server.md']}]});
	write(join(dir, 'findings-server.md'), '# findings\n\n## scope\n\n## results\n');
	write(join(dir, '.teamwork', 'evidence', 'm1-run.log'), 'captured\n'.repeat(50));
	write(
		join(dir, '.teamwork', 'verifications', 'm1.md'),
		'Milestone m1\nVerifier: auditor\nVerdict: SOUND\nevidence: .teamwork/evidence/m1-run.log\n',
	);
	const out = runGate(dir);
	const parsed = JSON.parse(out);
	check('gate: a stubbed deliverable blocks completion', parsed.decision === 'block', out.slice(0, 300));
	check('gate: the stub is named in the reason', /deliverable/.test(parsed.reason), parsed.reason.slice(0, 400));
}

{
	// The forgery, reproduced: the trail shows the record's own evidence was written
	// by the model.
	const dir = freshDir('gate-forged');
	campaign(dir, {milestones: [{id: 'm1', status: 'done'}]});
	write(join(dir, '.teamwork', 'evidence', 'm1-run.log'), 'fabricated transcript\n'.repeat(50));
	write(
		join(dir, '.teamwork', 'verifications', 'm1.md'),
		'Milestone m1\nVerifier: critic\nVerdict: REPRODUCED\nevidence: .teamwork/evidence/m1-run.log\n',
	);
	writeFileSync(
		join(dir, '.teamwork', 'events.jsonl'),
		JSON.stringify({event: 'tool', tool: 'Write', file: '.teamwork/evidence/m1-run.log'}) + '\n',
	);
	const out = runGate(dir);
	const parsed = JSON.parse(out);
	check('gate: model-authored evidence blocks completion', parsed.decision === 'block', out.slice(0, 300));
	check('gate: the forgery is named', /written by a tool call/.test(parsed.reason), parsed.reason.slice(0, 500));
}

{
	// A record with a real deliverable and captured evidence passes.
	const dir = freshDir('gate-clean');
	campaign(dir, {milestones: [{id: 'm1', status: 'done', deliverables: ['findings-musetalk.md']}]});
	write(join(dir, 'findings-musetalk.md'), `# findings\n${'real analysis line\n'.repeat(300)}`);
	write(join(dir, '.teamwork', 'evidence', 'm1-run.log'), 'captured by audit-log\nreal output\n');
	write(
		join(dir, '.teamwork', 'verifications', 'm1.md'),
		'Milestone m1\nVerifier: auditor\nCommand: npm test\nVerdict: SOUND\nevidence: .teamwork/evidence/m1-run.log\n',
	);
	const out = runGate(dir);
	check('gate: a complete milestone passes', out === '{}', out.slice(0, 300));
}

{
	// A milestone id inside an evidence path must not satisfy the naming check.
	const dir = freshDir('gate-nameonly');
	campaign(dir, {milestones: [{id: 'm1', status: 'done'}]});
	write(join(dir, '.teamwork', 'evidence', 'm1-run.log'), 'captured\n'.repeat(50));
	write(
		join(dir, '.teamwork', 'verifications', 'm1.md'),
		'Verifier: critic\nVerdict: SOUND\nevidence: .teamwork/evidence/m1-run.log\n',
	);
	const out = runGate(dir);
	const parsed = JSON.parse(out);
	check('gate: a path does not count as naming the milestone', parsed.decision === 'block', out.slice(0, 300));
	check('gate: the naming gap is reported', /never names the milestone/.test(parsed.reason), parsed.reason.slice(0, 400));
}

// ---------------------------------------------------------------------------

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
