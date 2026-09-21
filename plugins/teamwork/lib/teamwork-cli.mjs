#!/usr/bin/env node
// Teamwork - the CLI.
//
// The engine's verbs, exposed to a shell. This is how an orchestrating agent calls
// the engine: on this platform a plugin's libraries are reached through commands,
// not through in-process imports, so a library without a CLI is a library nothing
// can use.
//
// Every command prints human-readable output by default and JSON with --json, and
// exits non-zero when it refuses. Exit codes are part of the contract: an agent
// checking `$?` must be able to tell "refused because of a rule" from "succeeded".
//
//   init       --objective "..." [--mode quick|standard|strict] [--integrity ...]
//   approve
//   advance    --phase executing|verifying|complete
//   cancel     [--reason "..."]
//   decompose  [--objective "..."]
//   plan       --milestones <file.json>
//   schedule
//   claim      --file <path> --milestone <id> [--lease <minutes>]
//   release    --file <path> --milestone <id>
//   can-write  --file <path> --milestone <id>
//   check      --milestone <id> [--affected <n>]
//   verify     --milestone <id> --verdicts <file.json>
//   final      --verdicts <file.json>
//   status
//   stale
//   handoff
//
// ASCII only: protocol artifact.

import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';

import {TeamworkEngine} from './engine.mjs';
import {renderHandoff} from './handoff.mjs';

function out(text) {
	process.stdout.write(`${text}\n`);
}

function fail(message, code = 1) {
	process.stderr.write(`teamwork: ${message}\n`);
	process.exit(code);
}

function parseArgs(argv) {
	const args = {cwd: process.cwd(), json: false};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === '--json') args.json = true;
		else if (token.startsWith('--')) {
			const key = token.slice(2);
			const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
			args[key] = value;
		} else fail(`unexpected argument "${token}"`);
	}
	return args;
}

function readJsonArg(path, what) {
	if (typeof path !== 'string') fail(`${what} needs a path (--${what} <file.json>)`);
	const full = resolve(path);
	if (!existsSync(full)) fail(`${what} file not found: ${full}`);
	try {
		return JSON.parse(readFileSync(full, 'utf8'));
	} catch (error) {
		fail(`${what} file is not valid JSON: ${error.message}`);
	}
}

function emit(result, args, render) {
	if (args.json) {
		// _problems is non-enumerable on state, so JSON.stringify will not carry it.
		out(JSON.stringify(result, null, 2));
	} else {
		render(result);
	}
	process.exit(result?.ok === false ? 1 : 0);
}

const [, , command, ...rest] = process.argv;
if (command === undefined) fail('no command given; run with --help for the list');
const args = parseArgs(rest);
const engine = new TeamworkEngine({cwd: args.cwd, stateDir: args['state-dir']});

switch (command) {
	case 'init':
		emit(
			engine.initProject({
				objective: args.objective,
				mode: args.mode,
				integrityMode: args.integrity,
				executionPath: args.path,
				force: args.force === true,
			}),
			args,
			(r) =>
				r.ok
					? out(`Campaign created.\n  objective: ${r.state.objective}\n  phase: ${r.state.phase}\n  mode: ${r.state.mode}`)
					: out(`Refused: ${r.reason}`),
		);
		break;

	case 'approve':
		emit(engine.approve(), args, (r) =>
			r.ok ? out(`Approved. ${r.state.milestones.length} milestone(s) will run.`) : out(`Refused: ${r.reason}`),
		);
		break;

	case 'advance':
		if (typeof args.phase !== 'string') fail('advance needs --phase');
		emit(engine.advance(args.phase), args, (r) => (r.ok ? out(`Phase: ${r.state.phase}`) : out(`Refused: ${r.reason}`)));
		break;

	case 'cancel':
		emit(engine.cancel(args.reason), args, (r) => (r.ok ? out('Campaign aborted.') : out(`Refused: ${r.reason}`)));
		break;

	case 'decompose': {
		const result = engine.decompose({objective: args.objective});
		emit(result, args, (r) => {
			if (!r.ok) return out(`Refused: ${r.reason}`);
			out(`Draft (${r.milestones.length} milestones, ${r.workspace_file_count} files seen):`);
			for (const m of r.milestones) {
				out(`  [${m.id}] ${m.deliverable}`);
				out(`        owner ${m.owner_role}, verified by ${m.verified_by}`);
				if (m.blocked_by.length > 0) out(`        blocked by ${m.blocked_by.join(', ')}`);
			}
			out('');
			out(r.note);
		});
		break;
	}

	case 'plan': {
		const milestones = readJsonArg(args.milestones, 'milestones');
		if (!Array.isArray(milestones)) fail('milestones file must contain a JSON array');
		emit(engine.createPlan(milestones), args, (r) =>
			r.ok ? out(`Plan accepted: ${r.state.milestones.length} milestone(s), ownership recorded.`) : out(`Refused: ${r.reason}`),
		);
		break;
	}

	case 'schedule': {
		const result = engine.getSchedule();
		emit(result, args, (r) => {
			if (!r.ok) return out(`Refused: ${r.error ?? r.reason}`);
			out(`Batches: ${r.batches.length}`);
			for (const batch of r.batches) {
				out(`  batch ${batch.index}: ${batch.milestones.join(', ')}${batch.parallel ? '  (parallel)' : ''}`);
				if (batch.files.length > 0) out(`        ${batch.files.join(', ')}`);
			}
			out(`Worker dispatches needed: ${r.worker_dispatches} of ${r.budget}`);
			for (const warning of r.warnings) out(`\nWARNING ${warning}`);
		});
		break;
	}

	case 'claim':
		emit(
			engine.claimFile(args.file, args.milestone, {role: args.role, leaseMinutes: args.lease ? Number(args.lease) : undefined}),
			args,
			(r) => (r.ok ? out(`Claimed ${r.entry.file} for ${r.entry.milestone} until ${r.entry.expiresAt}`) : out(`Refused: ${r.reason}`)),
		);
		break;

	case 'release':
		emit(engine.releaseFile(args.file, args.milestone), args, (r) => (r.ok ? out(`Released ${args.file}`) : out(`Refused: ${r.reason}`)));
		break;

	case 'can-write': {
		const result = engine.canWrite(args.file, args.milestone);
		emit({ok: result.allowed, ...result}, args, (r) =>
			r.allowed ? out(`Allowed${r.unclaimed ? ' (unclaimed)' : ''}`) : out(`Denied: ${r.reason}`),
		);
		break;
	}

	case 'check': {
		const result = engine.planVerification(args.milestone, {affectedFiles: args.affected ? Number(args.affected) : undefined});
		emit(result, args, (r) => {
			if (!r.ok) return out(`Refused: ${r.reason}`);
			out(`Verification sizing: ${r.sizing.reviewers} reviewer(s), ${r.sizing.challengers} challenger(s), ${r.sizing.auditor} auditor`);
			for (const reason of r.sizing.reasons) out(`  - ${reason}`);
			out('');
			r.prompts.forEach((p, i) => out(`--- prompt ${i + 1} ---\n${p}\n`));
		});
		break;
	}

	case 'verify': {
		const verdicts = readJsonArg(args.verdicts, 'verdicts');
		if (!Array.isArray(verdicts)) fail('verdicts file must contain a JSON array');
		emit(engine.verifyMilestone(args.milestone, verdicts), args, (r) => {
			if (!r.ok) return out(`Refused: ${r.reason}`);
			out(`Gate: ${r.gate.result} - ${r.gate.reason}`);
			for (const finding of r.gate.findings) out(`  ! ${finding}`);
			if (r.repair) out(`\nRepair workstream created: ${r.repair.id}`);
		});
		break;
	}

	case 'final': {
		const verdicts = readJsonArg(args.verdicts, 'verdicts');
		emit(engine.finalVerification(verdicts), args, (r) => (r.ok ? out('Final audit passed; campaign complete.') : out(`Refused: ${r.reason ?? (r.findings ?? []).join('; ')}`)));
		break;
	}

	case 'status': {
		const result = engine.status();
		emit(result, args, (r) => {
			if (!r.ok) return out(`No campaign: ${r.reason}`);
			out(`Objective: ${r.objective}`);
			out(`Phase: ${r.phase}   Mode: ${r.mode}   Integrity: ${r.integrityMode}   State v${r.version}`);
			out('');
			out(`Milestones (${r.milestones.length}, ${r.open.length} open):`);
			for (const m of r.milestones) {
				out(`  [${m.verified ? 'x' : ' '}] ${m.id}  ${m.status}${m.files.length > 0 ? `  (${m.files.join(', ')})` : ''}`);
			}
			if (r.ownership.length > 0) {
				out('');
				out(`Ownership (${r.ownership.length}):`);
				for (const entry of r.ownership) out(`  ${entry.file} -> ${entry.milestone}`);
			}
			if (r.gates.length > 0) {
				out('');
				out('Gates:');
				for (const gate of r.gates) out(`  ${gate.milestone}: ${gate.result}`);
			}
			out('');
			out(`Journal: ${r.journal.total} entries, last ${r.journal.last ?? '(none)'}`);
			out(`Dispatches: ${r.journal.dispatches}${r.journal.agents.length > 0 ? ` (${r.journal.agents.join(', ')})` : ''}`);
			if (r.complete) out('Campaign is complete and fully verified.');
		});
		break;
	}

	case 'stale': {
		const result = engine.staleness();
		emit({ok: true, ...result}, args, (r) => {
			if (!r.stalled) return out(`Not stalled${r.reason ? ` (${r.reason})` : ''}.`);
			out('Signals:');
			for (const signal of r.signals) out(`  [${signal.kind}] ${signal.detail}`);
		});
		break;
	}

	case 'handoff': {
		const result = engine.handoff(args.reason);
		emit(result, args, (r) => out(r.ok ? renderHandoff(r) : `Refused: ${r.reason}`));
		break;
	}

	default:
		fail(`unknown command "${command}"`);
}
