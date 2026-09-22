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
		phase: 'executing',
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

reset({over: {approved: false, phase: 'executing'}});
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

// A record now has to cite evidence that the runtime captured, so the helper
// creates that evidence file too. A record without a citation is blocked, which is
// the point of the check - see the evidence section below for tests of that.
function verifyRecord(id, body, options = {}) {
	mkdirSync(join(STATE, 'verifications'), {recursive: true});
	mkdirSync(join(STATE, 'evidence'), {recursive: true});
	const stem = options.evidenceName ?? `${id}-run`;
	writeFileSync(join(STATE, 'evidence', `${stem}.log`), options.evidenceBody ?? `captured output for ${id}\n${'x'.repeat(600)}\n`);
	const body2 = body.includes('evidence:') ? body : `${body}evidence: .teamwork/evidence/${stem}.log\n`;
	writeFileSync(join(STATE, 'verifications', `${id}.md`), body2);
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
	check('gate: names the offending milestone', String(out.reason ?? '').includes('m1'), out.reason);
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
mkdirSync(join(STATE, 'evidence'), {recursive: true});
	writeFileSync(join(STATE, 'evidence', 'm1-run.log'), `captured output\n${'x'.repeat(600)}\n`);
	// The filename shape is what is under test; the evidence requirement applies to
	// every record regardless of what it is called.
	writeFileSync(join(STATE, 'verifications', 'milestone-m1-verification.md'), 'm1\nVerdict: SOUND\nevidence: .teamwork/evidence/m1-run.log\n');
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: accepts the usual record filename shapes', r.stdout === '{}', r.stdout.slice(0, 200));
}

// A campaign that declares itself complete owes a final audit.
reset();
plan([{id: 'm1', status: 'done'}]);
verifyRecord('m1', 'm1\nVerdict: SOUND\n');
// The completion flag lives in campaign.json, which is the authoritative state file.
writeFileSync(CAMPAIGN, JSON.stringify({...campaign(), status: 'complete', milestones: [{id: 'm1', status: 'done'}]}));
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

// A UTF-8 BOM on the state file must not disarm the gate.
//
// JSON.parse rejects a leading BOM, and every reader treats a parse failure as "no
// campaign", so a BOM turned all seven hooks into silent no-ops - enforcement off,
// nothing reported. The state file is user-editable by design and the obvious Windows
// editors (PowerShell 5.1 `Set-Content -Encoding UTF8`, Notepad's "UTF-8 with BOM")
// add one, so this is a realistic edit, not a synthetic one. Regression: the gate
// must behave identically with and without the BOM.
{
	reset();
	plan([{id: 'm1', status: 'done'}]);
	const clean = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: blocks a claimed-done milestone with no evidence', /"decision":"block"/.test(clean.stdout), clean.stdout.slice(0, 160));

	// Rewrite the same campaign with a BOM prepended, byte for byte otherwise.
	const withBom = Buffer.concat([
		Buffer.from([0xef, 0xbb, 0xbf]),
		Buffer.from(readFileSync(CAMPAIGN, 'utf8'), 'utf8'),
	]);
	writeFileSync(CAMPAIGN, withBom);
	const bommed = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: a BOM on campaign.json does not disarm it', bommed.stdout === clean.stdout, bommed.stdout.slice(0, 200));

	// The ownership hook reads the same file through the same helper, so it must survive
	// the BOM too. It stays silent for a first claim, so the evidence is the lease it
	// writes, not its stdout.
	rmSync(LEASE, {force: true});
	const lock = run('ownership-lock.mjs', payload());
	check('gate: a BOM does not make the ownership lock inert', lock.code === 0 && existsSync(LEASE), `code=${lock.code} lease=${existsSync(LEASE)}`);
}

// ---------------------------------------------------------------------------

console.log('\naudit-log.mjs - tool trail');
// The trail is what the budget and the progress watch both read, so a silently
// empty log would disable two other mechanisms without failing anything.
function trail() {
	if (!existsSync(EVENTS)) return [];
	return readFileSync(EVENTS, 'utf8')
		.split('\n')
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

reset();
{
	run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {file_path: 'src/core.ts'}});
	const entries = trail();
	check('audit: records a tool call', entries.length === 1, JSON.stringify(entries));
	check('audit: names the tool', entries[0]?.tool === 'Write', JSON.stringify(entries[0]));
	check('audit: records the target file', entries[0]?.file === 'src/core.ts', JSON.stringify(entries[0]));
}

reset();
{
	run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: 'npm test'}});
	const e = trail()[0];
	check('audit: records a shell command', e?.command === 'npm test', JSON.stringify(e));
	check('audit: does not invent a file for a shell command', e?.file === undefined, JSON.stringify(e));
}

reset();
{
	run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse', tool_name: 'Task', tool_input: {subagent_type: 'worker', description: 'port the loader'}});
	const e = trail()[0];
	check('audit: marks a dispatch distinctly', e?.event === 'dispatch', JSON.stringify(e));
	check('audit: records the dispatched role', e?.agent === 'worker', JSON.stringify(e));
}

reset();
{
	const long = 'x'.repeat(400);
	run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: long}});
	const e = trail()[0];
	check('audit: truncates a long command', typeof e?.command === 'string' && e.command.length < 200, String(e?.command?.length));
}

{
	// Outside a campaign there is nothing to audit against, and every unrelated
	// project would otherwise accumulate a trail.
	reset({withCampaign: false});
	const r = run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse'});
	check('audit: inert without a campaign', r.stdout === '{}' && !existsSync(EVENTS), r.stdout);
}

{
	reset();
	const r = run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse'});
	check('audit: never blocks a completed call', parse(r.stdout)?.decision === undefined, r.stdout);
}

// ---------------------------------------------------------------------------

console.log('\nspawn-budget.mjs - dispatch ceiling');
// A campaign that has lost its way keeps dispatching; the ceiling is the one
// number that makes the cost visible to something other than the invoice.

function dispatchEntries(n) {
	mkdirSync(STATE, {recursive: true});
	const lines = [];
	for (let i = 0; i < n; i++) lines.push(JSON.stringify({event: 'dispatch', tool: 'Task', agent: 'worker'}));
	writeFileSync(EVENTS, lines.join('\n') + '\n');
}

function taskPayload(over = {}) {
	return payload({hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {subagent_type: 'worker', description: 'x'}, ...over});
}

{
	reset({over: {spawnBudget: 3}});
	{
		const r = run('spawn-budget.mjs', taskPayload());
		check('budget: allows a dispatch well inside the ceiling', parse(r.stdout)?.hookSpecificOutput?.permissionDecision !== 'deny', r.stdout);
	}
}

{
	reset({over: {spawnBudget: 3}});
	dispatchEntries(3);
	const r = run('spawn-budget.mjs', taskPayload());
	const out = parse(r.stdout) ?? {};
	check('budget: denies at the ceiling', out.hookSpecificOutput?.permissionDecision === 'deny', r.stdout.slice(0, 240));
	check('budget: explains how to raise it', /spawnBudget/.test(String(out.hookSpecificOutput?.permissionDecisionReason)), out.hookSpecificOutput?.permissionDecisionReason);
}

{
	reset({over: {spawnBudget: 4}});
	dispatchEntries(3); // one left, so the next is the last
	const r = run('spawn-budget.mjs', taskPayload());
	const out = parse(r.stdout) ?? {};
	check('budget: warns as the ceiling approaches', /dispatch 4 of 4/.test(String(out.hookSpecificOutput?.additionalContext)), r.stdout.slice(0, 240));
}

{
	reset({over: {spawnBudget: 0}});
	dispatchEntries(50);
	const r = run('spawn-budget.mjs', taskPayload());
	check('budget: 0 disables the ceiling entirely', r.stdout === '{}', r.stdout);
}

{
	// The default applies when the campaign says nothing, so a campaign that never
	// considered cost is still bounded.
	reset();
	dispatchEntries(16);
	const r = run('spawn-budget.mjs', taskPayload());
	check('budget: the default ceiling applies when unset', parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny', r.stdout.slice(0, 200));
}

{
	reset({over: {spawnBudget: 2}});
	dispatchEntries(5);
	const r = run('spawn-budget.mjs', payload({hook_event_name: 'PreToolUse', tool_name: 'Write'}));
	check('budget: only governs Task, not every tool', parse(r.stdout)?.hookSpecificOutput?.permissionDecision !== 'deny', r.stdout);
}

{
	reset({withCampaign: false, over: {}});
	dispatchEntries(100);
	const r = run('spawn-budget.mjs', taskPayload());
	check('budget: inert without a campaign', r.stdout === '{}', r.stdout);
}

{
	// A torn tail line is a normal consequence of an interrupted run and must not be
	// counted as a dispatch.
	reset({over: {spawnBudget: 1}});
	mkdirSync(STATE, {recursive: true});
	writeFileSync(EVENTS, JSON.stringify({event: 'dispatch'}) + '\n{"event":"disp');
	const r = run('spawn-budget.mjs', taskPayload());
	check('budget: ignores a torn log line', parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny', r.stdout.slice(0, 200));
}

// ---------------------------------------------------------------------------

console.log('\nprogress-watch.mjs - staleness report');
// The strongest available substitute for a dead-man timer on a platform where a
// hook is a one-shot process. It reports at the user's turn, not on a clock.

function contextOf(out) {
	return parse(out)?.hookSpecificOutput?.additionalContext ?? '';
}

{
	reset();
	writeFileSync(PLAN, JSON.stringify({milestones: [{id: 'm1', status: 'pending'}]}));
	const r = run('progress-watch.mjs', {...payload(), hook_event_name: 'UserPromptSubmit'});
	check('watch: reports when no trail exists at all', /no hook events have been recorded/.test(contextOf(r.stdout)), r.stdout.slice(0, 300));
	check('watch: mentions the trust prompt as a possible cause', /trust/.test(contextOf(r.stdout)), contextOf(r.stdout));
}

{
	reset();
	writeFileSync(PLAN, JSON.stringify({milestones: [{id: 'm1', status: 'done'}]}));
	const r = run('progress-watch.mjs', {...payload(), hook_event_name: 'UserPromptSubmit'});
	check('watch: silent when no milestone is open', r.stdout === '{}', r.stdout.slice(0, 200));
}

{
	reset();
	writeFileSync(PLAN, JSON.stringify({milestones: [{id: 'm1', status: 'pending'}]}));
	mkdirSync(STATE, {recursive: true});
	writeFileSync(EVENTS, JSON.stringify({event: 'tool', tool: 'Write'}) + '\n');
	const r = run('progress-watch.mjs', {...payload(), hook_event_name: 'UserPromptSubmit'});
	const ctx = contextOf(r.stdout);
	check('watch: flags the missing verification records', /has a verification record yet/.test(ctx), ctx.slice(0, 300));
	check('watch: does not cry wolf about freshness on a fresh trail', !/minutes while/.test(ctx), ctx.slice(0, 300));
}

{
	reset();
	writeFileSync(PLAN, JSON.stringify({milestones: [{id: 'm1', status: 'pending'}]}));
	mkdirSync(join(STATE, 'verifications'), {recursive: true});
	writeFileSync(join(STATE, 'verifications', 'm1.md'), 'm1\nVerdict: SOUND\n');
	// A trail must exist too, or the "no hook events" note fires legitimately and
	// the assertion would be about the wrong signal.
	writeFileSync(EVENTS, JSON.stringify({event: 'tool', tool: 'Write'}) + '\n');
	const r = run('progress-watch.mjs', {...payload(), hook_event_name: 'UserPromptSubmit'});
	check('watch: silent once a verification record exists', r.stdout === '{}', r.stdout.slice(0, 200));
}

{
	reset({over: {progressWatch: false}});
	writeFileSync(PLAN, JSON.stringify({milestones: [{id: 'm1', status: 'pending'}]}));
	const r = run('progress-watch.mjs', {...payload(), hook_event_name: 'UserPromptSubmit'});
	check('watch: honoured when the campaign turns it off', r.stdout === '{}', r.stdout.slice(0, 200));
}

{
	reset();
	const r = run('progress-watch.mjs', {...payload(), hook_event_name: 'UserPromptSubmit'});
	check('watch: tolerant of a missing plan', r.stdout === '{}', r.stdout.slice(0, 200));
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

console.log('\nverification-gate.mjs - the block channel');
// ZCode parses `decision:"block"` on Stop, but the continuation check requires a
// non-empty additionalContexts, and only `reason` and `systemMessage` are pushed
// into it. `stopReason` is display-only. A gate returning only stopReason sets
// blockRequested, records a reason, and then the turn ends normally - the block is
// a silent no-op. Verified against a real build: with stopReason the turn completed
// once; with reason the same turn was pulled back four times.

reset();
plan([{id: 'm1', status: 'done'}]);
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	const out = parse(r.stdout) ?? {};
	check('gate: uses the reason field, not stopReason', typeof out.reason === 'string' && out.reason.length > 0, JSON.stringify(Object.keys(out)));
	check('gate: does not rely on the display-only stopReason', out.stopReason === undefined, JSON.stringify(out).slice(0, 160));
}

// ---------------------------------------------------------------------------

console.log('\nmilestone source - campaign.json is authoritative');
// The engine writes milestones into campaign.json. Three hooks read plan.json
// alone, so a campaign created through the CLI had no plan file, every hook found
// nothing, and the gate was inert on the documented path.

reset();
writeFileSync(CAMPAIGN, JSON.stringify({...campaign(), milestones: [{id: 'm1', status: 'done'}]}));
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	const out = parse(r.stdout) ?? {};
	check('gate: reads milestones from campaign.json', out.decision === 'block', r.stdout.slice(0, 200));
}

reset();
writeFileSync(PLAN, JSON.stringify({milestones: [{id: 'm1', status: 'done'}]}));
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	const out = parse(r.stdout) ?? {};
	check('gate: still honours a legacy plan.json', out.decision === 'block', r.stdout.slice(0, 200));
}

reset();
{
	const r = run('verification-gate.mjs', {...payload(), hook_event_name: 'Stop'});
	check('gate: silent when neither file lists milestones', r.stdout === '{}', r.stdout.slice(0, 200));
}

{
	// Ownership recorded by the engine lives in campaign.json; the session context
	// must render it from there, not only from a legacy plan.json.
	reset();
	writeFileSync(
		CAMPAIGN,
		JSON.stringify({...campaign(), milestones: [{id: 'm1', status: 'done', deliverable: 'port it'}], ownership: [{file: 'src/a.ts', milestone: 'm1'}]}),
	);
	const r = run('session-context.mjs', {...payload(), hook_event_name: 'SessionStart', source: 'startup'});
	const ctx = parse(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
	check('plan: ownership table read from campaign.json', ctx.includes('src/a.ts -> m1'), ctx.slice(0, 400));
}

{
	// The real tool name is Agent. A hook that only knows Task never runs, so the
	// budget is enforced on neither name.
	reset({over: {spawnBudget: 1}});
	mkdirSync(STATE, {recursive: true});
	writeFileSync(EVENTS, JSON.stringify({event: 'dispatch', tool: 'Agent', agent: 'worker'}) + '\n');
	const r = run('spawn-budget.mjs', payload({hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {subagent_type: 'general-purpose'}}));
	const out = parse(r.stdout) ?? {};
	check('budget: denies a dispatch made through Agent', out.hookSpecificOutput?.permissionDecision === 'deny', r.stdout.slice(0, 200));
}

{
	reset();
	run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {subagent_type: 'general-purpose', description: 'port it'}});
	const entries = existsSync(EVENTS) ? readFileSync(EVENTS, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
	check('audit: records an Agent call as a dispatch', entries[0]?.event === 'dispatch', JSON.stringify(entries[0]));
	check('audit: records the agent type', entries[0]?.agent === 'general-purpose', JSON.stringify(entries[0]));
}

{
	// A failed tool arrives as PostToolUse with status "failed"; PostToolUseFailure
	// never fires. The trail must mark it, or failures are invisible.
	reset();
	run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: 'exit 3'}, tool_response: {status: 'failed', exitCode: 3}});
	const entries = readFileSync(EVENTS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	check('audit: marks a failure reported through status', entries[0]?.failed === true, JSON.stringify(entries[0]));
}

// ---------------------------------------------------------------------------

console.log('\nspawn-budget.mjs - concurrent dispatch in one batch');
// The budget counted dispatches from the trail, which audit-log writes on
// PostToolUse. A single turn can issue several Agent calls in one batch and their
// PreToolUse hooks fire milliseconds apart, all reading the same stale count, so a
// batch of N bypassed any budget. Measured on a real machine: two hooks 57ms apart
// both read zero, and the first trail write landed 1.8s later.
//
// These tests reproduce that shape: two PreToolUse calls with no PostToolUse
// between them. The second must see the first one's reservation.

function taskCall(name) {
	// A distinct tool_use_id per call, as the real payload carries.
	return payload({
		hook_event_name: 'PreToolUse',
		tool_name: name,
		tool_input: {subagent_type: 'general-purpose', description: 'parallel'},
	});
}

{
	reset({over: {spawnBudget: 1}});
	const first = run('spawn-budget.mjs', taskCall('Agent'));
	const second = run('spawn-budget.mjs', taskCall('Agent'));

	const firstOut = parse(first.stdout) ?? {};
	const secondOut = parse(second.stdout) ?? {};

	check(
		'budget: the first concurrent dispatch is allowed',
		firstOut.hookSpecificOutput?.permissionDecision !== 'deny',
		first.stdout.slice(0, 200),
	);
	check(
		'budget: the second concurrent dispatch is denied',
		secondOut.hookSpecificOutput?.permissionDecision === 'deny',
		`expected deny, got ${second.stdout.slice(0, 200)}`,
	);
}

{
	// Three calls, a budget of two: exactly two admitted. Without reservations all
	// three would pass, because none of their PostToolUse hooks had run yet.
	reset({over: {spawnBudget: 2}});
	const results = [run('spawn-budget.mjs', taskCall('Agent')), run('spawn-budget.mjs', taskCall('Agent')), run('spawn-budget.mjs', taskCall('Agent'))];
	const denied = results.filter((r) => parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny');
	check('budget: exactly budget-many concurrent calls are admitted', denied.length === 1, `${denied.length} denied of 3`);
}

{
	// Once the dispatch is recorded, the reservation is consumed rather than kept,
	// or the budget would be stricter than configured by one per call.
	reset({over: {spawnBudget: 2}});
	run('spawn-budget.mjs', taskCall('Agent'));                       // reserves 1
	run('audit-log.mjs', {...payload(), hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {subagent_type: 'general-purpose'}});  // commits + consumes
	const second = run('spawn-budget.mjs', taskCall('Agent'));        // should be allowed: 1 committed, 0 reserved
	check(
		'budget: a completed dispatch consumes its reservation',
		parse(second.stdout)?.hookSpecificOutput?.permissionDecision !== 'deny',
		second.stdout.slice(0, 200),
	);

	const third = run('spawn-budget.mjs', taskCall('Agent'));         // 1 committed + 1 reserved = 2
	check(
		'budget: the ceiling still applies after the reservation is consumed',
		parse(third.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
		third.stdout.slice(0, 200),
	);
}

{
	// The reservation file is state, not a leak: a fresh campaign starts at zero.
	reset({over: {spawnBudget: 1}});
	run('spawn-budget.mjs', taskCall('Agent'));
	const before = run('spawn-budget.mjs', taskCall('Agent'));
	check('budget: a second call in the same state is denied', parse(before.stdout)?.hookSpecificOutput?.permissionDecision === 'deny');
	reset({over: {spawnBudget: 1}});
	const after = run('spawn-budget.mjs', taskCall('Agent'));
	check(
		'budget: a reset campaign reserves afresh',
		parse(after.stdout)?.hookSpecificOutput?.permissionDecision !== 'deny',
		after.stdout.slice(0, 200),
	);
}

rmSync(WORK, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
