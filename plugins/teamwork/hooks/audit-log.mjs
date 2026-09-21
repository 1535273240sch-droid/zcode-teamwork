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
//
// What it deliberately does NOT do:
//   - It never blocks. A PostToolUse hook runs after the fact; the call already
//     happened, so denying would only confuse the model.
//   - It never stores tool output. Outputs are large and often contain secrets or
//     proprietary code; the audit trail records shape and target, not payload.
//   - It is not a security boundary. A determined process can write files without
//     any tool. It is a record, and records are what let a human audit later.
//
// ASCII only: this file is a protocol artifact and crosses an encoding boundary.

import {readStdin, statePaths, loadCampaign, appendEvent, existsSync, resolveProjectDir} from './_lib.mjs';

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
if (!existsSync(paths.campaign)) emit({});

const campaign = loadCampaign(paths.campaign);
if (!campaign) emit({});

const toolName = pick(input, 'toolName', 'tool_name') || 'unknown';
const toolInput = pick(input, 'toolInput', 'tool_input') ?? {};
const toolResponse = pick(input, 'toolResponse', 'tool_response');

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
const failed = pick(input, 'toolResponseIsError', 'tool_response_is_error');
if (failed === true) entry.failed = true;
if (toolResponse && typeof toolResponse === 'object' && toolResponse.is_error === true) entry.failed = true;
// On a real machine PostToolUseFailure never fires: a failed tool comes through
// PostToolUse with status "failed". That is the only place a failure is observable.
if (toolResponse && typeof toolResponse === 'object' && toolResponse.status === 'failed') entry.failed = true;

appendEvent(paths, entry);

emit({});
