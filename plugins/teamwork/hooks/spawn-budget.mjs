#!/usr/bin/env node
// Teamwork - spawn budget guard.
//
// PreToolUse hook on Task. Enforces the campaign's dispatch budget.
//
// Task is the only tool that starts a Subagent, and a Subagent is where nearly all
// of a campaign's cost lives. Without a ceiling, a campaign that has lost its way
// keeps dispatching - each new Worker looks locally justified, and nothing in the
// conversation ever adds up what the run has spent. The budget is the one number
// that makes that visible, and it has to be enforced by code, because the model
// doing the dispatching cannot see its own running total.
//
// Counted from .teamwork/events.jsonl, which audit-log.mjs writes for every
// completed Task call. The count therefore reflects dispatches that actually
// happened, not ones that were merely attempted.
//
// Honest limit: this counts what the hooks saw. 'TaskStop' is not a dispatch, and a
// dispatch whose PostToolUse never fired (an interrupted run) is not counted. The
// budget is a cost ceiling, not an audit of every token.
//
// Opt-out, in order of precedence:
//   - env TEAMWORK_SPAWN_BUDGET=off
//   - campaign.json: "spawnBudget": 0 or null
//   - campaign.json: "spawnBudget": <n> to set an explicit ceiling
// Default when unset: DEFAULT_SPAWN_BUDGET.
//
// ASCII only: protocol artifact.

import {readFileSync, existsSync} from 'node:fs';

import {readStdin, deny, allowWithContext, statePaths, loadCampaign, isCampaignActive, DEFAULT_SPAWN_BUDGET, resolveProjectDir} from './_lib.mjs';

// Warn once the run is close enough to the ceiling that the orchestrator should
// start planning its last milestones rather than discovering the wall.
const WARN_FRACTION = 0.75;

function emit(obj) {
	process.stdout.write(JSON.stringify(obj));
	process.exit(0);
}

function pick(source, camel, snake) {
	return source?.[camel] ?? source?.[snake];
}

function readBudget(campaign) {
	const raw = campaign?.spawnBudget;
	if (raw === 0 || raw === null) return undefined; // explicitly disabled
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_SPAWN_BUDGET;
	return Math.floor(value);
}

/** Count dispatch events already recorded in the trail. */
function countDispatches(eventsPath) {
	if (!existsSync(eventsPath)) return 0;
	let text;
	try {
		text = readFileSync(eventsPath, 'utf8');
	} catch {
		return 0;
	}
	let count = 0;
	for (const line of text.split('\n')) {
		if (line.length === 0) continue;
		// Substring test first: JSON.parse on every line of a long trail is wasteful
		// and this hook runs on the critical path of every dispatch.
		if (!line.includes('"dispatch"')) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.event === 'dispatch') count++;
		} catch {
			// a torn line at the tail of the log is not a dispatch
		}
	}
	return count;
}

const raw = await readStdin();

let input;
try {
	input = JSON.parse(raw);
} catch {
	emit({}); // malformed payload: never block a tool call over it
}

if (process.env.TEAMWORK_SPAWN_BUDGET === 'off') emit({});

// Only Task starts a Subagent. The hook is registered against a Task matcher, but
// a matcher is configuration and can be widened by mistake; enforcing the tool name
// here means a wider matcher costs nothing instead of blocking unrelated tools.
const toolName = pick(input, 'toolName', 'tool_name');
// The real tool name on ZCode 3.14+ is `Agent`; `Task` is its documented alias.
// The matcher is a case-sensitive regex and does NOT know about the alias, so this
// hook must accept both - otherwise it never runs on a real machine and the budget
// silently does nothing. Confirmed against a live install.
const DISPATCH_TOOLS = new Set(['Task', 'Agent']);
if (!DISPATCH_TOOLS.has(toolName)) emit({});

const cwd = resolveProjectDir(input);
const paths = statePaths(cwd);

if (!existsSync(paths.campaign)) emit({});

const campaign = loadCampaign(paths.campaign);
if (!isCampaignActive(campaign)) emit({});

const budget = readBudget(campaign);
if (budget === undefined) emit({});

const used = countDispatches(paths.events);

if (used >= budget) {
	deny(
		`Teamwork spawn budget exhausted: ${used} of ${budget} Worker dispatches have been used in this campaign. ` +
			'Do not dispatch another Subagent. Finish the current milestone with the team already assigned, ' +
			'or report to the human that the objective needs more dispatches than the budget allows - ' +
			'the budget is a deliberate ceiling, and raising it is their decision, not a workaround. ' +
			'To raise it, set "spawnBudget" in .teamwork/campaign.json.',
	);
}

if (used + 1 > budget * WARN_FRACTION) {
	allowWithContext(
		`Teamwork spawn budget: this is dispatch ${used + 1} of ${budget}. ` +
			`${budget - used - 1} left after it. Plan the remaining milestones against that number rather than ` +
			'finding out at the ceiling.',
	);
}

emit({});
