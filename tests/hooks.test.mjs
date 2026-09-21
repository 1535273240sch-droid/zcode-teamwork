// Hook behaviour tests for the Teamwork ZCode plugin.
//
// Spawns the real hook scripts as child processes and feeds them the JSON payloads
// ZCode documents on stdin, then asserts on the stdout protocol and the on-disk
// state. Nothing here is a stub: if a hook stops honouring the protocol, these fail.
//
//   node tests/hooks.test.mjs

import {spawnSync, spawn} from 'node:child_process';
import {mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync, symlinkSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

import {lockKey, extractFilePath, readLeaseMinutes, isInsideDirectory} from '../plugins/teamwork/hooks/_lib.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = join(REPO, 'plugins', 'teamwork', 'hooks');
const WORK = mkdtempSync(join(tmpdir(), 'teamwork-hooks-'));
const STATE = join(WORK, '.teamwork');
const CAMPAIGN = join(STATE, 'campaign.json');
const LEASE = join(STATE, 'ownership.json');
const EVENTS = join(STATE, 'events.jsonl');
const PLAN = join(STATE, 'plan.json');

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

function run(script, payload) {
	const result = spawnSync(process.execPath, [join(HOOKS, script)], {
		input: JSON.stringify(payload),
		encoding: 'utf8',
	});
	return {stdout: (result.stdout || '').trim(), stderr: result.stderr || '', code: result.status};
}

// Spawn a hook process and leave it blocked reading stdin, so it can be released
// together with its siblings.
function spawnBlocked(script) {
	const child = spawn(process.execPath, [join(HOOKS, script)], {stdio: ['pipe', 'pipe', 'pipe']});
	let out = '';
	child.stdout.on('data', (chunk) => (out += chunk));
	return {
		child,
		ready: new Promise((res) => (child.pid ? res() : child.on('spawn', res))),
		closed: new Promise((res) => child.on('close', (code) => res({stdout: out.trim(), code}))),
	};
}

// Release N hook processes in a single synchronous tick. Process startup jitter
// alone does NOT expose the TOCTOU race - this test passed with the mutex removed
// until the barrier was added - so the barrier is what gives it teeth.
async function claimBarrier(script, payloads) {
	const procs = payloads.map(() => spawnBlocked(script));
	await Promise.all(procs.map((p) => p.ready));
	payloads.forEach((p, i) => procs[i].child.stdin.end(JSON.stringify(p)));
	return Promise.all(procs.map((p) => p.closed));
}

function parse(out) {
	try {
		return JSON.parse(out);
	} catch {
		return undefined;
	}
}

function payload(over = {}) {
	return {
		session_id: 'session-1',
		transcript_path: 'C:/tmp/transcript-a.jsonl',
		cwd: WORK,
		permission_mode: 'default',
		hook_event_name: 'PreToolUse',
		tool_name: 'Write',
		tool_input: {file_path: 'src/core.ts', content: 'x'},
		tool_use_id: 'tool-1',
		...over,
	};
}

function bashPayload(command, over = {}) {
	return payload({tool_name: 'Bash', tool_input: {command}, ...over});
}

function campaign(over = {}) {
	return {
		objective: 'Reduce p95 latency below 200ms on the replay dataset',
		integrity_mode: 'benchmark',
		pattern: 'self-verification',
		working_directory: WORK,
		acceptance_criteria: ['p95 < 200ms measured by bench.mjs on a cold cache'],
		ownership_lease_minutes: 10,
		approved: true,
		phase: 'execution',
		...over,
	};
}

function reset({withCampaign = true, over = {}} = {}) {
	rmSync(STATE, {recursive: true, force: true});
	if (withCampaign) {
		mkdirSync(STATE, {recursive: true});
		writeFileSync(CAMPAIGN, JSON.stringify(campaign(over)));
	}
}

function readLease() {
	return JSON.parse(readFileSync(LEASE, 'utf8'));
}

// ---------------------------------------------------------------------------

console.log('\nownership-lock.mjs - activation gate');

// Without a campaign the hook must be a complete no-op, or it would police
// every ordinary edit in every project the plugin is installed in.
reset({withCampaign: false});
{
	const r = run('ownership-lock.mjs', payload());
	check('no campaign: exits 0', r.code === 0, `code=${r.code}`);
	check('no campaign: no output (no-op)', r.stdout === '', r.stdout.slice(0, 120));
	check('no campaign: writes no lease file', !existsSync(LEASE));
}

// The charter exists during the scoping interview, before the human approves it.
// Arming the lock there is a semantic error, so both fields must be checked.
reset({over: {approved: false, phase: 'scoping'}});
{
	const r = run('ownership-lock.mjs', payload());
	check('not approved: exits 0', r.code === 0, `code=${r.code}`);
	check('not approved: no output (no-op)', r.stdout === '', r.stdout.slice(0, 160));
	check('not approved: writes no lease file', !existsSync(LEASE));
}

reset({over: {approved: false, phase: 'execution'}});
{
	const r = run('ownership-lock.mjs', payload());
	check('approved=false, phase=execution: still inert', r.stdout === '', r.stdout.slice(0, 160));
}

reset({over: {approved: true, phase: 'scoping'}});
{
	const r = run('ownership-lock.mjs', payload());
	check('approved=true, phase=scoping: still inert', r.stdout === '', r.stdout.slice(0, 160));
}

// ---------------------------------------------------------------------------

console.log('\nownership-lock.mjs - claims and conflicts');

reset();
{
	const r = run('ownership-lock.mjs', payload());
	check('first claim: exits 0', r.code === 0, `code=${r.code}`);
	const out = parse(r.stdout);
	check(
		'first claim: allowed (no deny)',
		r.stdout === '' || out?.hookSpecificOutput?.permissionDecision !== 'deny',
		r.stdout.slice(0, 160),
	);
	const lease = readLease();
	const key = Object.keys(lease)[0] ?? '';
	check('first claim: lease written for the file', key.endsWith('core.ts'), key);
	check('first claim: owner recorded', String(lease[key]?.owner).startsWith('tx:'), JSON.stringify(lease[key]));
	check(
		'first claim: owner source recorded',
		lease[key]?.ownerSource === 'transcript',
		JSON.stringify(lease[key]),
	);
}

// A second, different owner on the same file must be denied.
{
	const r = run('ownership-lock.mjs', payload({transcript_path: 'C:/tmp/transcript-b.jsonl', tool_use_id: 'tool-2'}));
	const out = parse(r.stdout);
	check('conflict: exits 0', r.code === 0, `code=${r.code}`);
	check(
		'conflict: permissionDecision is deny',
		out?.hookSpecificOutput?.permissionDecision === 'deny',
		r.stdout.slice(0, 200),
	);
	check(
		'conflict: reason names the file and the holder',
		typeof out?.hookSpecificOutput?.permissionDecisionReason === 'string' &&
			out.hookSpecificOutput.permissionDecisionReason.includes('core.ts') &&
			out.hookSpecificOutput.permissionDecisionReason.includes('tx:'),
		out?.hookSpecificOutput?.permissionDecisionReason?.slice(0, 160),
	);
	check('conflict: hookEventName correct', out?.hookSpecificOutput?.hookEventName === 'PreToolUse');
}

// The same owner re-writing its own file is normal and must not be blocked.
{
	const r = run('ownership-lock.mjs', payload({tool_use_id: 'tool-3'}));
	check('re-claim by same owner: exits 0', r.code === 0, `code=${r.code}`);
	const out = parse(r.stdout);
	check('re-claim by same owner: not denied', out?.hookSpecificOutput?.permissionDecision !== 'deny', r.stdout);
}

// A different owner on a different file is a parallel Worker: unaffected.
{
	const r = run(
		'ownership-lock.mjs',
		payload({
			transcript_path: 'C:/tmp/transcript-b.jsonl',
			tool_input: {file_path: 'src/other.ts', content: 'y'},
		}),
	);
	const out = parse(r.stdout);
	check('different file: not denied', out?.hookSpecificOutput?.permissionDecision !== 'deny', r.stdout.slice(0, 160));
	check('different file: both leases present', Object.keys(readLease()).length === 2, JSON.stringify(Object.keys(readLease())));
}

// An abandoned Worker must not deadlock the campaign: the lease expires.
{
	const lease = readLease();
	for (const k of Object.keys(lease)) lease[k].updatedAt = Date.now() - 11 * 60 * 1000;
	writeFileSync(LEASE, JSON.stringify(lease));
	const r = run('ownership-lock.mjs', payload({transcript_path: 'C:/tmp/transcript-c.jsonl', tool_use_id: 'tool-4'}));
	const out = parse(r.stdout);
	check('expired lease: reclaim allowed', out?.hookSpecificOutput?.permissionDecision !== 'deny', r.stdout.slice(0, 200));
	check('expired lease: single fresh lease remains', Object.keys(readLease()).length === 1, JSON.stringify(readLease()));
}

// ---------------------------------------------------------------------------

console.log('\nownership-lock.mjs - lease length edges');

reset({over: {ownership_lease_minutes: 0}});
{
	run('ownership-lock.mjs', payload());
	const lease = readLease();
	const key = Object.keys(lease)[0] ?? '';
	check('lease minutes 0 falls back to the default (10)', key.length > 0, JSON.stringify(lease));
	// Default is 10 minutes: a claim 5 minutes old must still be held.
	const fresh = readLease();
	fresh[key].updatedAt = Date.now() - 5 * 60 * 1000;
	writeFileSync(LEASE, JSON.stringify(fresh));
	const r = run('ownership-lock.mjs', payload({transcript_path: 'C:/tmp/other.jsonl'}));
	check(
		'lease minutes 0 -> 10 min: 5-minute-old claim still conflicts',
		parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
		r.stdout.slice(0, 160),
	);
}

// A nonsense lease must never be shorter than a minute, or every parallel Worker
// would steal every other Worker's files.
check('lease minutes "abc" -> default 10', readLeaseMinutes({ownership_lease_minutes: 'abc'}) === 10);
check('lease minutes -5 -> default 10', readLeaseMinutes({ownership_lease_minutes: -5}) === 10);
check('lease minutes null -> default 10', readLeaseMinutes({}) === 10);
check('lease minutes "15" -> 15', readLeaseMinutes({ownership_lease_minutes: '15'}) === 15);
check('lease minutes 0.5 -> clamped to 1', readLeaseMinutes({ownership_lease_minutes: 0.5}) === 1);
check('lease minutes 100000 -> clamped to 10080', readLeaseMinutes({ownership_lease_minutes: 100000}) === 10080);

// ---------------------------------------------------------------------------

console.log('\nownership-lock.mjs - concurrency (regression for the TOCTOU race)');

// The read-decide-write of the lease store used to be unprotected: N processes
// claiming N different files would each read the old store and write it back, and
// every claim but the last would vanish. The invariant held in every single-file
// test and failed exactly when parallel Workers needed it. Measured before the fix:
// 3 of 5 rounds lost leases (worst round kept 9 of 12).
{
	const N = 12;
	const ROUNDS = 3;
	let worst = N;
	let allExited = true;

	for (let round = 0; round < ROUNDS; round++) {
		reset();
		const payloads = Array.from({length: N}, (_, i) =>
			payload({
				transcript_path: `C:/tmp/worker-${round}-${i}.jsonl`,
				tool_input: {file_path: `src/file-${round}-${i}.ts`, content: 'x'},
			}),
		);
		const results = await claimBarrier('ownership-lock.mjs', payloads);
		if (!results.every((r) => r.code === 0)) allExited = false;
		worst = Math.min(worst, Object.keys(readLease()).length);
	}

	check(`concurrent claims: all ${N} processes exit 0`, allExited);
	check(
		`concurrent claims: all ${N} leases survive in every one of ${ROUNDS} rounds`,
		worst === N,
		`worst round kept ${worst} of ${N}`,
	);
	check('concurrent claims: no mutex left behind', !existsSync(join(STATE, '.lock')));
}

// Concurrent claims on the SAME file must produce exactly one winner.
{
	const N = 8;
	reset();
	const results = await claimBarrier(
		'ownership-lock.mjs',
		Array.from({length: N}, (_, i) => payload({transcript_path: `C:/tmp/racer-${i}.jsonl`, tool_input: {file_path: 'src/hot.ts', content: 'x'}})),
	);
	const denied = results.filter((r) => parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny').length;
	check('same-file race: exactly one lease exists', Object.keys(readLease()).length === 1, JSON.stringify(Object.keys(readLease())));
	check('same-file race: every other claim was denied', denied === N - 1, `denied=${denied} of ${N}`);
}

// A held mutex must make a second process stand down rather than corrupt the store.
{
	reset();
	mkdirSync(join(STATE, '.lock'), {recursive: true});
	const r = run('ownership-lock.mjs', payload());
	check('mutex held: hook stands down instead of writing', r.code === 0 && !existsSync(LEASE), `code=${r.code}`);
	rmSync(join(STATE, '.lock'), {recursive: true, force: true});
}

// A mutex left behind by a killed process must be stolen, not deadlock the campaign.
{
	reset();
	mkdirSync(join(STATE, '.lock'), {recursive: true});
	const {utimesSync} = await import('node:fs');
	const old = new Date(Date.now() - 60 * 1000);
	utimesSync(join(STATE, '.lock'), old, old);
	const r = run('ownership-lock.mjs', payload());
	check('stale mutex: stolen and the claim proceeds', r.code === 0 && existsSync(LEASE), `code=${r.code}`);
	check('stale mutex: released afterwards', !existsSync(join(STATE, '.lock')));
}

// ---------------------------------------------------------------------------

console.log('\nownership-lock.mjs - robustness');

// Bookkeeping must never be the reason a tool call fails.
{
	const result = spawnSync(process.execPath, [join(HOOKS, 'ownership-lock.mjs')], {
		input: 'not json at all',
		encoding: 'utf8',
	});
	check('malformed stdin: exits 0 and stays silent', result.status === 0 && (result.stdout || '').trim() === '');
}

reset();
{
	// A crafted key must not reach Object.prototype.
	writeFileSync(LEASE, JSON.stringify({__proto__: {polluted: true}, 'src/evil.ts': {owner: 'tx:x', updatedAt: Date.now()}}));
	run('ownership-lock.mjs', payload());
	check('prototype pollution: Object.prototype untouched', {}.polluted === undefined);
	const lease = readLease();
	check('prototype pollution: __proto__ key dropped', !Object.keys(lease).includes('__proto__'), Object.keys(lease).join(','));
	check('prototype pollution: legitimate lease kept', Object.keys(lease).includes('src/evil.ts'));
}

reset();
{
	// A stale .tmp left by a crashed writer must be swept, not accumulated.
	const stale = join(STATE, 'ownership.json.999.tmp');
	writeFileSync(stale, 'garbage');
	const {utimesSync} = await import('node:fs');
	const old = new Date(Date.now() - 5 * 60 * 1000);
	utimesSync(stale, old, old);
	run('ownership-lock.mjs', payload());
	check('stale .tmp: swept on the next run', !existsSync(stale));
}

reset();
{
	run('ownership-lock.mjs', payload());
	run('ownership-lock.mjs', payload({transcript_path: 'C:/tmp/transcript-b.jsonl'}));
	const lines = readFileSync(EVENTS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	check('events.jsonl: claim recorded', lines.some((e) => e.event === 'claimed' && e.file === 'src/core.ts'));
	check('events.jsonl: denial recorded', lines.some((e) => e.event === 'denied' && e.holder?.startsWith('tx:')));
}

// ---------------------------------------------------------------------------

console.log('\nownership-lock.mjs - path normalisation');

{
	reset();
	run('ownership-lock.mjs', payload({tool_input: {file_path: 'src/core.ts'}}));
	// On Windows/macOS the same file spelled differently must be the same key.
	const r = run('ownership-lock.mjs', payload({transcript_path: 'C:/tmp/transcript-b.jsonl', tool_input: {file_path: 'src/CORE.TS'}}));
	const denied = parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny';
	const expected = process.platform === 'win32' || process.platform === 'darwin';
	check(
		`case variant of the same path: ${expected ? 'conflicts' : 'does not conflict'} on ${process.platform}`,
		denied === expected,
		r.stdout.slice(0, 160),
	);
}

// The darwin branch cannot be exercised by running on darwin here, so the platform
// is stubbed. macOS is case-insensitive by default and would otherwise let a Worker
// bypass the lock by changing a letter's case.
{
	const original = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', {value: 'darwin', configurable: true});
	try {
		const a = lockKey('src/Core.ts', WORK);
		const b = lockKey('src/core.ts', WORK);
		check('darwin: case-insensitive paths collapse to one key', a === b, `${a} vs ${b}`);
		const nfd = lockKey('src/cafe\u0301.ts', WORK);
		const nfc = lockKey('src/caf\u00e9.ts', WORK);
		check('darwin: NFD and NFC filenames collapse to one key', nfd === nfc, `${nfd} vs ${nfc}`);
	} finally {
		if (original) Object.defineProperty(process, 'platform', original);
	}
}

// A path reached through a symlinked directory must produce the same key as the
// direct path, and a file that does not exist yet inside a symlinked directory must
// still count as inside it.
//
// This is the macOS /var -> /private/var case, and it silently disabled the Bash
// guard there: the working directory resolved to /private/var/... while a target
// file that had not been created yet stayed /var/..., so nothing ever compared as
// nested. Caught by CI on macos-latest, not locally.
{
	mkdirSync(join(WORK, 'real-dir'), {recursive: true});
	let linked = false;
	try {
		symlinkSync(join(WORK, 'real-dir'), join(WORK, 'link-dir'), process.platform === 'win32' ? 'junction' : 'dir');
		linked = true;
	} catch {
		linked = false;
	}
	if (linked) {
		const direct = lockKey('real-dir/new-file.ts', WORK);
		const viaLink = lockKey('link-dir/new-file.ts', WORK);
		check('symlinked directory: same key as the direct path', direct === viaLink, `${direct} vs ${viaLink}`);
		check(
			'symlinked directory: a not-yet-existing file inside it counts as inside the working directory',
			isInsideDirectory('link-dir/new-file.ts', WORK),
		);
		check('directory boundary: a sibling directory is outside', !isInsideDirectory(join(WORK, '..', 'elsewhere.ts'), WORK));
		check('directory boundary: the working directory itself is inside', isInsideDirectory('.', WORK));
	} else {
		console.log('  SKIP  symlinked directory checks (this platform would not create a symlink)');
	}
}

check('extractFilePath: file_path', extractFilePath({tool_input: {file_path: 'a.ts'}}) === 'a.ts');check('extractFilePath: filePath', extractFilePath({tool_input: {filePath: 'b.ts'}}) === 'b.ts');
check('extractFilePath: absolute_path', extractFilePath({tool_input: {absolute_path: 'c.ts'}}) === 'c.ts');
check('extractFilePath: path', extractFilePath({tool_input: {path: 'd.ts'}}) === 'd.ts');
check('extractFilePath: empty string is not a path', extractFilePath({tool_input: {file_path: ''}}) === undefined);
check('extractFilePath: non-string is not a path', extractFilePath({tool_input: {file_path: 42}}) === undefined);
check('extractFilePath: missing tool_input', extractFilePath({}) === undefined);

// ---------------------------------------------------------------------------

console.log('\nbash-guard.mjs');

reset({withCampaign: false});
{
	const r = run('bash-guard.mjs', bashPayload('echo hi > src/a.ts'));
	check('no campaign: no-op', r.code === 0 && r.stdout === '', r.stdout.slice(0, 120));
}

reset();
{
	const r = run('bash-guard.mjs', bashPayload('npm test'));
	check('non-writing command: silent', r.stdout === '', r.stdout.slice(0, 160));
}

reset();
{
	const r = run('bash-guard.mjs', bashPayload('git status && ls -la'));
	check('read-only command: silent', r.stdout === '', r.stdout.slice(0, 160));
}

reset();
{
	const r = run('bash-guard.mjs', bashPayload('echo noise > /dev/null'));
	check('redirect outside the working directory: silent', r.stdout === '', r.stdout.slice(0, 200));
}

// A Bash write to a file another Worker holds is the hole this hook exists to close.
{
	reset();
	run('ownership-lock.mjs', payload({tool_input: {file_path: 'src/owned.ts'}}));
	const r = run('bash-guard.mjs', bashPayload('echo x > src/owned.ts', {transcript_path: 'C:/tmp/transcript-b.jsonl'}));
	const out = parse(r.stdout);
	check(
		'redirect into another Worker file: denied',
		out?.hookSpecificOutput?.permissionDecision === 'deny',
		r.stdout.slice(0, 220),
	);
	check(
		'redirect denial names the file and the holder',
		String(out?.hookSpecificOutput?.permissionDecisionReason).includes('src/owned.ts') &&
			String(out?.hookSpecificOutput?.permissionDecisionReason).includes('tx:'),
		out?.hookSpecificOutput?.permissionDecisionReason?.slice(0, 200),
	);
}

{
	// sed -i into a file another Worker holds.
	reset();
	run('ownership-lock.mjs', payload({tool_input: {file_path: 'src/owned.ts'}}));
	const r = run('bash-guard.mjs', bashPayload("sed -i 's/a/b/' src/owned.ts", {transcript_path: 'C:/tmp/transcript-b.jsonl'}));
	check(
		'sed -i into another Worker file: denied',
		parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
		r.stdout.slice(0, 220),
	);
}

{
	// tee into a file another Worker holds.
	reset();
	run('ownership-lock.mjs', payload({tool_input: {file_path: 'src/owned.ts'}}));
	const r = run('bash-guard.mjs', bashPayload('echo x | tee -a src/owned.ts', {transcript_path: 'C:/tmp/transcript-b.jsonl'}));
	check(
		'tee into another Worker file: denied',
		parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
		r.stdout.slice(0, 220),
	);
}

{
	// An unattributable in-place edit is warned about, never blocked: a false denial
	// on an ordinary build command would be worse than a missed warning.
	reset();
	const r = run('bash-guard.mjs', bashPayload("sed -i 's/a/b/' src/whatever.ts"));
	const out = parse(r.stdout);
	check('unattributable sed -i: allowed with a warning', out?.hookSpecificOutput?.permissionDecision !== 'deny', r.stdout.slice(0, 160));
	check(
		'unattributable sed -i: warning explains ownership is unenforced',
		String(out?.hookSpecificOutput?.additionalContext).includes('NOT enforced'),
		out?.hookSpecificOutput?.additionalContext?.slice(0, 160),
	);
}

{
	// A fresh Bash write claims ownership so a later Edit by another Worker is caught.
	reset();
	const r = run('bash-guard.mjs', bashPayload('echo x > src/fresh.ts'));
	check('fresh Bash write: allowed', parse(r.stdout)?.hookSpecificOutput?.permissionDecision !== 'deny', r.stdout.slice(0, 160));
	const lease = readLease();
	const key = Object.keys(lease).find((k) => k.endsWith('fresh.ts'));
	check('fresh Bash write: lease claimed', Boolean(key), JSON.stringify(Object.keys(lease)));
	check('fresh Bash write: claim tagged as coming from bash', String(lease[key]?.ownerSource) === 'transcript', JSON.stringify(lease[key]));

	const r2 = run('ownership-lock.mjs', payload({transcript_path: 'C:/tmp/transcript-b.jsonl', tool_input: {file_path: 'src/fresh.ts'}}));
	check(
		'Edit after a Bash write by another owner: denied',
		parse(r2.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
		r2.stdout.slice(0, 200),
	);
}

// Bookkeeping must never be the reason a tool call fails.
{
	const result = spawnSync(process.execPath, [join(HOOKS, 'bash-guard.mjs')], {
		input: 'not json at all',
		encoding: 'utf8',
	});
	check('malformed stdin: exits 0 and stays silent', result.status === 0 && (result.stdout || '').trim() === '');
}

reset();
{
	const r = run('bash-guard.mjs', bashPayload(undefined));
	check('missing command: silent', r.code === 0 && r.stdout === '', r.stdout.slice(0, 120));
}

// ---------------------------------------------------------------------------

console.log('\nsession-context.mjs');

reset({withCampaign: false});
{
	const r = run('session-context.mjs', {...payload(), hook_event_name: 'SessionStart'});
	check('no campaign: silent', r.code === 0 && r.stdout === '', r.stdout.slice(0, 120));
}

reset();
{
	const r = run('session-context.mjs', {...payload(), hook_event_name: 'SessionStart', source: 'startup'});
	const out = parse(r.stdout);
	const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
	check('campaign: exits 0', r.code === 0, `code=${r.code}`);
	check('campaign: hookEventName is SessionStart', out?.hookSpecificOutput?.hookEventName === 'SessionStart');
	check('campaign: objective injected', ctx.includes('p95 latency'), ctx.slice(0, 120));
	check('campaign: integrity mode injected', ctx.includes('benchmark'));
	check('campaign: acceptance criteria injected', ctx.includes('cold cache'));
	check('campaign: benchmark warning injected', ctx.includes('standard library only'));
	check('campaign: role protocol injected', ctx.includes('Success Auditor'));
	check('campaign: verification artifact requirement injected', ctx.includes('final-audit.md'), ctx.slice(0, 200));
	check('campaign: plan absence reported', ctx.includes('plan.json does not exist yet'), ctx.slice(0, 200));
}

// The plan must survive a session restart: that is the whole point of writing it.
reset();
{
	mkdirSync(join(STATE, 'verifications'), {recursive: true});
	writeFileSync(join(STATE, 'verifications', 'm1.md'), 'SOUND');
	writeFileSync(join(STATE, 'final-audit.md'), 'ACHIEVED');
	writeFileSync(
		PLAN,
		JSON.stringify({
			sentinel: 'CLEARED',
			milestones: [
				{id: 'm1', deliverable: 'extract the parser', status: 'done', files: ['src/a.ts'], verified_by: 'critic', verified: true},
				{id: 'm2', deliverable: 'rewrite the caller', status: 'pending', files: ['src/b.ts'], blocked_by: ['m1'], verified_by: 'auditor'},
			],
			ownership: {'src/a.ts': 'm1', 'src/b.ts': 'm2'},
		}),
	);
	const r = run('session-context.mjs', {...payload(), hook_event_name: 'SessionStart', source: 'resume'});
	const ctx = parse(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
	check('plan: injected on a resumed session', ctx.includes('plan.json'), ctx.slice(0, 160));
	check('plan: milestone list injected', ctx.includes('extract the parser') && ctx.includes('rewrite the caller'));
	check('plan: milestone status injected', ctx.includes('[done]') && ctx.includes('[pending]'));
	check('plan: ownership table injected', ctx.includes('src/a.ts -> m1'), ctx.slice(0, 400));
	check('plan: remaining count injected', ctx.includes('Remaining milestones: 1 of 2'), ctx.slice(0, 400));
	check('plan: sentinel verdict injected', ctx.includes('CLEARED'));
	check('verifications: records on disk reported', ctx.includes('m1.md'), ctx.slice(0, 300));
	check('verifications: final audit reported', ctx.includes('Final audit on disk'), ctx.slice(0, 300));
}

// An unapproved campaign must say so, so a fresh session does not start executing.
reset({over: {approved: false, phase: 'scoping'}});
{
	const r = run('session-context.mjs', {...payload(), hook_event_name: 'SessionStart', source: 'startup'});
	const ctx = parse(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
	check('unapproved: explicitly reported', ctx.includes('NOT APPROVED'), ctx.slice(0, 200));
}

// ---------------------------------------------------------------------------

console.log('\nverification-gate.mjs - Stop gate');
// The gate fires only when the state file claims completed work with no evidence.
// A campaign that never blocks is worse than useless: it trains the model to ignore
// the Stop hook entirely.
function plan(milestones, over = {}) {
	writeFileSync(PLAN, JSON.stringify({milestones, ...over}));
}

function verifyRecord(id, body) {
	mkdirSync(join(STATE, 'verifications'), {recursive: true});
	writeFileSync(join(STATE, 'verifications', `${id}.md`), body);
}

// Stopping is free when nothing is claimed done.
reset();
plan([{id: 'm1', status: 'in_progress'}]);
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: silent with no completed milestone', r.stdout === '{}', r.stdout.slice(0, 200));
}

// The core rule: a milestone marked done with no record is a contradiction.
reset();
plan([{id: 'm1', status: 'done'}]);
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	const out = parse(r.stdout) ?? {};
	check('gate: blocks a done milestone with no record', out.decision === 'block', r.stdout.slice(0, 240));
	check('gate: names the offending milestone', String(out.stopReason ?? '').includes('m1'), out.stopReason);
}

// A record that exists but never names the milestone cannot be used as evidence.
reset();
plan([{id: 'm1', status: 'done'}]);
verifyRecord('m1', 'Verdict: SOUND\n');
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	const out = parse(r.stdout) ?? {};
	check('gate: blocks a record that never names the milestone', out.decision === 'block', r.stdout.slice(0, 240));
}

// A record that names the milestone but carries no verdict is not a verification.
reset();
plan([{id: 'm1', status: 'done'}]);
verifyRecord('m1', 'm1 was looked at, seems fine\n');
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	const out = parse(r.stdout) ?? {};
	check('gate: blocks a record with no verdict token', out.decision === 'block', r.stdout.slice(0, 240));
}

// A real record clears the gate.
reset();
plan([{id: 'm1', status: 'done'}]);
verifyRecord('m1', 'Milestone m1\nVerifier: Auditor\nVerdict: REPRODUCED\n');
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: clears once the record is complete', r.stdout === '{}', r.stdout.slice(0, 200));
}

// verified: true is the other way the state file claims completion.
reset();
plan([{id: 'm1', status: 'pending', verified: true}]);
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	const out = parse(r.stdout) ?? {};
	check('gate: verified flag also counts as claimed done', out.decision === 'block', r.stdout.slice(0, 240));
}

// Alternative record filenames the roster actually writes.
reset();
plan([{id: 'm1', status: 'done'}]);
mkdirSync(join(STATE, 'verifications'), {recursive: true});
writeFileSync(join(STATE, 'verifications', 'milestone-m1-verification.md'), 'm1\nVerdict: SOUND\n');
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: accepts the usual record filename shapes', r.stdout === '{}', r.stdout.slice(0, 200));
}

// A campaign that declares itself complete owes a final audit.
reset();
plan([{id: 'm1', status: 'done'}], {status: 'complete'});
verifyRecord('m1', 'm1\nVerdict: SOUND\n');
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	const out = parse(r.stdout) ?? {};
	check('gate: blocks a complete campaign missing its final audit', out.decision === 'block', r.stdout.slice(0, 240));
	writeFileSync(join(STATE, 'final-audit.md'), '# final audit\n');
	const r2 = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: clears once the final audit exists', r2.stdout === '{}', r2.stdout.slice(0, 200));
}

// Second pass in the same turn must not block, or the model can never finish.
reset();
plan([{id: 'm1', status: 'done'}]);
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop', stop_hook_active: true});
	check('gate: stands down on the second pass', r.stdout === '{}', r.stdout.slice(0, 200));
}

// An unapproved campaign is still scoping; the gate has no business there.
reset({over: {approved: false, phase: 'scoping'}});
plan([{id: 'm1', status: 'done'}]);
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: inert outside an approved campaign', r.stdout === '{}', r.stdout.slice(0, 200));
}

// Explicit opt-out for teams that do not want a hard gate.
reset({over: {verificationGate: false}});
plan([{id: 'm1', status: 'done'}]);
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: honoured when campaign turns it off', r.stdout === '{}', r.stdout.slice(0, 200));
}

// With no plan on disk there is nothing to check, and blocking would be a false positive.
reset();
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: tolerant of a missing plan', r.stdout === '{}', r.stdout.slice(0, 200));
}

// ---------------------------------------------------------------------------

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
