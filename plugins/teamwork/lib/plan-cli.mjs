#!/usr/bin/env node
// Teamwork - plan tooling CLI.
//
// The scripted half of the /teamwork-plan command. Reads the campaign state and
// prints one of three views:
//
//   draft      decompose the objective into a first-draft milestone list
//   schedule   batches, worker count, and the two failure modes the scheduler
//              exists to catch (shared files, budget overrun)
//   status     milestones, verification coverage, recent audit trail
//
// Why a CLI and not just prose instructions: the numbers here (how many dispatches
// a plan needs, whether two milestones collide on a file) are exactly the ones a
// model gets wrong when it reasons about its own plan in a conversation. Printing
// them from the same code that the hooks use keeps the plan and the enforcement
// telling the same story.
//
// Usage, from the workspace root:
//   node <plugin>/lib/plan-cli.mjs draft     [--objective "..."] [--cwd .] [--json]
//   node <plugin>/lib/plan-cli.mjs schedule  [--cwd .] [--budget 16] [--json]
//   node <plugin>/lib/plan-cli.mjs status    [--cwd .] [--json]
//
// ASCII only: protocol artifact.

import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {decompose} from './decompose.mjs';
import {schedule, DEFAULT_SPAWN_BUDGET} from './scheduler.mjs';

function fail(message) {
	process.stderr.write(`teamwork: ${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const args = {cwd: process.cwd(), json: false, budget: undefined, objective: undefined};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === '--json') args.json = true;
		else if (token === '--cwd') args.cwd = argv[++i];
		else if (token === '--objective') args.objective = argv[++i];
		else if (token === '--budget') args.budget = Number(argv[++i]);
		else if (token.startsWith('--')) fail(`unknown flag ${token}`);
	}
	return args;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

function stateOf(cwd) {
	return {
		campaign: join(cwd, '.teamwork', 'campaign.json'),
		plan: join(cwd, '.teamwork', 'plan.json'),
		events: join(cwd, '.teamwork', 'events.jsonl'),
		verifications: join(cwd, '.teamwork', 'verifications'),
		finalAudit: join(cwd, '.teamwork', 'final-audit.md'),
	};
}

function loadMilestones(paths, explicitObjective) {
	const plan = readJson(paths.plan);
	if (plan && Array.isArray(plan.milestones) && plan.milestones.length > 0) return plan.milestones;

	const campaign = readJson(paths.campaign);
	const objective = explicitObjective ?? campaign?.objective;
	if (typeof objective !== 'string' || objective.length === 0) {
		fail('no .teamwork/plan.json and no objective to decompose (pass --objective, or write campaign.json)');
	}
	return undefined; // caller decomposes
}

function tailEvents(eventsPath, limit) {
	if (!existsSync(eventsPath)) return [];
	let lines;
	try {
		lines = readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.length > 0);
	} catch {
		return [];
	}
	const tail = lines.slice(-limit);
	const out = [];
	for (const line of tail) {
		try {
			out.push(JSON.parse(line));
		} catch {
			// torn tail line: skip
		}
	}
	return out;
}

function verificationFiles(dir) {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir).filter((n) => n.endsWith('.md'));
	} catch {
		return [];
	}
}

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);
const paths = stateOf(args.cwd);

if (command === 'draft') {
	const campaign = readJson(paths.campaign);
	const objective = args.objective ?? campaign?.objective;
	if (typeof objective !== 'string' || objective.length === 0) {
		fail('draft needs an objective: pass --objective "..." or write .teamwork/campaign.json');
	}
	const result = decompose(objective, {
		cwd: args.cwd,
		mode: campaign?.mode ?? 'standard',
		integrityMode: campaign?.integrityMode ?? 'development',
	});
	if (args.json) {
		process.stdout.write(JSON.stringify(result, null, 2));
		process.exit(0);
	}
	process.stdout.write(`Draft milestone list for: ${objective}\n`);
	process.stdout.write(`Workspace files considered: ${result.workspace_file_count}\n\n`);
	for (const m of result.milestones) {
		process.stdout.write(`  [${m.id}] ${m.deliverable}\n`);
		process.stdout.write(`      owner: ${m.owner_role}   verified by: ${m.verified_by}\n`);
		process.stdout.write(`      acceptance: ${m.acceptance}\n`);
		if (m.blocked_by.length > 0) process.stdout.write(`      blocked by: ${m.blocked_by.join(', ')}\n`);
		process.stdout.write('\n');
	}
	process.stdout.write(`${result.note}\n`);
	process.exit(0);
}

if (command === 'schedule') {
	const milestones = loadMilestones(paths, args.objective);
	if (!milestones) fail('schedule needs .teamwork/plan.json (run the draft step and write it first)');

	const budget = Number.isFinite(args.budget) ? args.budget : DEFAULT_SPAWN_BUDGET;
	const result = schedule(milestones, {budget});

	if (args.json) {
		process.stdout.write(JSON.stringify(result, null, 2));
		process.exit(result.ok ? 0 : 1);
	}

	if (!result.ok) {
		process.stdout.write(`Plan cannot be scheduled: ${result.error}\n`);
		process.exit(1);
	}

	process.stdout.write(`Batches: ${result.batches.length}\n`);
	for (const batch of result.batches) {
		process.stdout.write(
			`  batch ${batch.index}: ${batch.milestones.join(', ')}${batch.parallel ? '  (parallel)' : ''}\n`,
		);
		if (batch.files.length > 0) process.stdout.write(`      files: ${batch.files.join(', ')}\n`);
	}
	process.stdout.write(`\nWorker dispatches needed: ${result.worker_dispatches} of ${result.budget}\n`);
	for (const warning of result.warnings) process.stdout.write(`\nWARNING ${warning}\n`);
	process.exit(0);
}

if (command === 'status') {
	const plan = readJson(paths.plan);
	const campaign = readJson(paths.campaign);
	const milestones = Array.isArray(plan?.milestones) ? plan.milestones : [];
	const records = verificationFiles(paths.verifications);
	const events = tailEvents(paths.events, 20);

	if (args.json) {
		process.stdout.write(
			JSON.stringify(
				{
					milestones,
					verification_records: records,
					final_audit: existsSync(paths.finalAudit),
					recent_events: events,
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	process.stdout.write(`Campaign: ${campaign?.objective ?? '(no campaign.json)'}\n`);
	process.stdout.write(`Phase: ${campaign?.phase ?? '?'}   Mode: ${campaign?.mode ?? '?'}\n\n`);

	if (milestones.length === 0) {
		process.stdout.write('No milestones on disk yet.\n');
	} else {
		process.stdout.write('Milestones:\n');
		for (const m of milestones) {
			const done = m.status === 'done' || m.verified === true;
			const mark = done ? 'x' : ' ';
			const id = m.id ?? '?';
			const named = records.some((r) => r.toLowerCase().includes(String(id).toLowerCase()));
			const evidence = named ? 'verified' : 'NO RECORD';
			process.stdout.write(`  [${mark}] ${id}  ${m.status ?? ''}  ${done ? evidence : ''}\n`);
			if (typeof m.deliverable === 'string') process.stdout.write(`        ${m.deliverable}\n`);
		}
	}

	process.stdout.write(`\nVerification records: ${records.length}\n`);
	if (records.length > 0) process.stdout.write(`  ${records.join(', ')}\n`);
	process.stdout.write(`Final audit: ${existsSync(paths.finalAudit) ? 'present' : 'missing'}\n`);

	if (existsSync(paths.events)) {
		let age = '?';
		try {
			age = `${Math.round((Date.now() - statSync(paths.events).mtimeMs) / 60_000)} min ago`;
		} catch {
			// leave unknown
		}
		process.stdout.write(`\nLast recorded tool activity: ${age}\n`);
		process.stdout.write(`Recent trail (${events.length} entries):\n`);
		for (const e of events) {
			const bits = [e.event ?? '?', e.tool ?? '', e.file ?? '', e.agent ?? '', e.command ?? ''];
			process.stdout.write(`  ${bits.filter((b) => b.length > 0).join('  ')}\n`);
		}
	} else {
		process.stdout.write('\nNo audit trail yet. Either nothing has run, or the hooks are not trusted.\n');
	}
	process.exit(0);
}

fail(`unknown command "${command ?? ''}" (expected draft, schedule, or status)`);
