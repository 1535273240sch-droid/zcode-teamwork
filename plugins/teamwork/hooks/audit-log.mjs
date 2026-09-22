#!/usr/bin/env node
// Teamwork - tool audit trail.
//
// PostToolUse hook, matcher `*`. Records every tool call the campaign actually
// made, with the file it touched, so the campaign's history is on disk instead of
// only in a conversation that may be compacted away.
//
// This is the evidence layer the rest of the plugin reads from:
//   - commands/teamwork-status.md reports the recent tail of it
//   - hooks/progress-watch.mjs measures staleness from its timestamps
//   - the spawn budget counts dispatches from it
//   - hooks/verification-gate.mjs cross-checks it to tell captured evidence from
//     evidence the model wrote itself
//
// What it deliberately does NOT do:
//   - It never blocks. A PostToolUse hook runs after the fact; the call already
//     happened, so denying would only confuse the model.
//   - It is not a security boundary. A determined process can write files without
//     any tool. It is a record, and records are what let a human audit later.
//
// On capturing output. This hook records a fingerprint rather than a transcript:
// the command, its exit status, the byte count, a hash, and a short tail. The full
// output is not stored, because outputs are large and routinely contain secrets -
// a code review reads .env files - and an evidence store that leaks credentials
// would be a worse problem than the one it solves.
//
// What that buys and what it costs, stated plainly because the difference matters
// when reading a verification record:
//
//   CATCHES  a record claiming a result for a command that never ran. There is no
//            fingerprint, so the claim has nothing behind it.
//   MISSES   a command that ran honestly but whose output the record then
//            misrepresents. The fingerprint proves execution, not fidelity.
//
// That is the honest limit of this approach. Closing the second gap needs the full
// output, which means deciding how to handle secrets first.
//
// ASCII only: this file is a protocol artifact and crosses an encoding boundary.

import {readStdin, statePaths, loadCampaign, appendEvent, existsSync as exists, resolveProjectDir, consumeReservation} from './_lib.mjs';
import {captureEvidence} from '../lib/evidence.mjs';

// Tools whose target file is worth naming in the trail. Everything else is
// recorded by name alone.
const FILE_TOOLS = new Set(['Write', 'Edit', 'Read', 'MultiEdit', 'NotebookEdit']);

// Keep the preview short enough that a long command cannot bloat the log line.
const MAX_PREVIEW = 160;

function emit(obj) {
	process.stdout.write(JSON.stringify(obj));
	process.exit(0);
}

function pick(source, camel, snake) {
	return source?.[camel] ?? source?.[snake];
}

function preview(value) {
	if (typeof value !== 'string') return undefined;
	const single = value.replace(/\s+/g, ' ').trim();
	if (single.length === 0) return undefined;
	return single.length > MAX_PREVIEW ? `${single.slice(0, MAX_PREVIEW)}...` : single;
}

/**
 * Pull a readable string out of whatever shape the tool response arrived in.
 *
 * The harness has changed this shape before, so the extractor is defensive: it
 * accepts a string, or an object with any of the usual content fields, and gives
 * up quietly rather than throwing.
 */
function responseText(response) {
	if (response === null || response === undefined) return '';
	if (typeof response === 'string') return response;
	if (typeof response !== 'object') return String(response);
	const candidate =
		response.output ??
		response.stdout ??
		response.content ??
		response.text ??
		response.result ??
		response.message;
	if (typeof candidate === 'string') return candidate;
	if (Array.isArray(candidate)) {
		return candidate
			.map((part) => (typeof part === 'string' ? part : (part?.text ?? part?.content ?? '')))
			.join('\n');
	}
	return '';
}

function exitCodeOf(response) {
	if (response === null || typeof response !== 'object') return undefined;
	const raw = response.exitCode ?? response.exit_code ?? response.code;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

const raw = await readStdin();

let input;
try {
	input = JSON.parse(raw);
} catch {
	emit({}); // malformed payload: never interfere
}

const cwd = resolveProjectDir(input);
const paths = statePaths(cwd);

// Outside a campaign every project would accumulate a trail nobody reads, and
// this hook is only useful as part of the campaign record.
if (!exists(paths.campaign)) emit({});

const campaign = loadCampaign(paths.campaign);
if (!campaign) emit({});

const toolName = pick(input, 'toolName', 'tool_name') || 'unknown';
const toolInput = pick(input, 'toolInput', 'tool_input') ?? {};
const toolResponse = pick(input, 'toolResponse', 'tool_response');
const toolUseId = pick(input, 'toolUseId', 'tool_use_id');
const at = Date.now();

const entry = {event: 'tool', tool: toolName};

if (FILE_TOOLS.has(toolName)) {
	const target =
		toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? toolInput.notebook_path;
	if (typeof target === 'string' && target.length > 0) entry.file = target;
}

if (toolName === 'Bash') {
	const command = preview(toolInput.command);
	if (command) entry.command = command;
}

// Dispatch is the expensive operation, so it is recorded explicitly rather than
// inferred from the tool list later.
// `Agent` is the real name; `Task` is the documented alias. Missing this meant no
// dispatch was ever recorded, so the spawn budget counted zero for every campaign.
if (toolName === 'Task' || toolName === 'Agent') {
	entry.event = 'dispatch';
	// The budget reserved this slot at PreToolUse, before the trail entry could
	// exist. Consuming it here keeps the two counts describing the same dispatch:
	// leaving both would make the budget stricter than configured by one per call.
	consumeReservation(paths);
	const agent = toolInput.subagent_type ?? toolInput.subagentType ?? toolInput.agent;
	if (typeof agent === 'string' && agent.length > 0) entry.agent = agent;
	const description = preview(toolInput.description);
	if (description) entry.task = description;
}

if (toolName === 'TaskStop' || toolName === 'AgentStop') {
	entry.event = 'dispatch-stop';
}

// A failed call is the most interesting thing in the trail, so it is marked
// rather than left to be inferred from an absent success field.
const failedFlag = pick(input, 'toolResponseIsError', 'tool_response_is_error');
let failed = failedFlag === true;
if (toolResponse && typeof toolResponse === 'object' && toolResponse.is_error === true) failed = true;
// On a real machine PostToolUseFailure never fires: a failed tool comes through
// PostToolUse with status "failed". That is the only place a failure is observable.
if (toolResponse && typeof toolResponse === 'object' && toolResponse.status === 'failed') failed = true;
if (failed) entry.failed = true;

// Capture a fingerprint for calls whose result is worth citing later. Deliberately
// limited to commands and dispatch: a Read of a config file produces nothing a
// verification record should cite, and capturing every call would fill evidence/
// with noise that makes the real entries harder to find.
const CAPTURE_TOOLS = new Set(['Bash', 'Task', 'Agent']);
if (CAPTURE_TOOLS.has(toolName) && campaign.evidenceCapture !== false) {
	const captured = captureEvidence(paths.stateDir, {
		at,
		tool: toolName,
		toolUseId,
		command: entry.command,
		file: entry.file,
		output: responseText(toolResponse),
		exitCode: exitCodeOf(toolResponse),
		failed,
	});
	if (captured) entry.evidence = captured;
}

appendEvent(paths, entry);

emit({});
