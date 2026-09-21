#!/usr/bin/env node
// Teamwork - progress watch.
//
// UserPromptSubmit hook, matcher `*`. Reports how stale the campaign has become,
// measured against the audit trail rather than against anyone's memory.
//
// This exists because a long campaign has no natural moment at which someone asks
// "are we still moving?". The turn boundaries that would normally prompt that
// question are exactly the ones the model fills with its own plan. So the check
// runs on the human's turn instead, where it is cheap, and it reports facts the
// model cannot easily reconstruct: how long since the last recorded tool call, how
// many milestones are still open, and whether verification records exist at all.
//
// Honest limit: a process hook cannot run a timer. There is no dead-man switch
// here that fires after N minutes of silence - that needs a resident runtime, which
// this plugin does not have. What it can do is notice staleness at the next
// opportunity the user gives it, and say so before more tokens are spent. That is
// strictly weaker than a timer, and it is the strongest thing available here.
//
// Opt-out:
//   - env TEAMWORK_PROGRESS_WATCH=off
//   - campaign.json: "progressWatch": false
//
// ASCII only: protocol artifact.

import {readFileSync, existsSync, statSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import {readStdin, statePaths, loadCampaign, isCampaignActive, VERIFICATIONS_DIR, resolveProjectDir} from './_lib.mjs';

// Silence that is worth mentioning. Deliberately generous: a Worker running a long
// build or a full test suite is not stalled, and crying wolf on every quiet minute
// would train the reader to ignore this.
const STALE_MINUTES = 30;

function emit(obj) {
	process.stdout.write(JSON.stringify(obj));
	process.exit(0);
}

function pick(source, camel, snake) {
	return source?.[camel] ?? source?.[snake];
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

const raw = await readStdin();

let input;
try {
	input = JSON.parse(raw);
} catch {
	emit({}); // malformed payload: never interfere with the prompt
}

if (process.env.TEAMWORK_PROGRESS_WATCH === 'off') emit({});

const cwd = resolveProjectDir(input);
const paths = statePaths(cwd);

if (!existsSync(paths.campaign)) emit({});

const campaign = loadCampaign(paths.campaign);
if (!isCampaignActive(campaign)) emit({});
if (campaign.progressWatch === false) emit({});

const plan = readJson(paths.plan);
if (!plan) emit({});

const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
const open = milestones.filter((m) => m.status !== 'done' && m.verified !== true);
if (open.length === 0) emit({});

const notes = [];

// Staleness is measured from the trail's mtime. Reading the whole log to find the
// last timestamp would grow without bound; the file mtime carries the same signal
// for a fraction of the cost, and the trail is appended on every tool call.
if (existsSync(paths.events)) {
	let staleMinutes;
	try {
		staleMinutes = Math.round((Date.now() - statSync(paths.events).mtimeMs) / 60_000);
	} catch {
		staleMinutes = undefined;
	}
	if (typeof staleMinutes === 'number' && staleMinutes >= STALE_MINUTES) {
		notes.push(
			`Teamwork: no recorded tool activity for ${staleMinutes} minutes while ${open.length} milestone(s) remain ` +
				`open (${open.map((m) => m.id ?? '?').join(', ')}). A long build or test run also looks like this, so ` +
				'check the actual state before assuming the campaign stalled - but if nothing is running, the run has ' +
				'stopped moving, and the next step is to say so rather than to keep planning.',
		);
	}
} else {
	// No trail at all, while execution is approved and milestones are open, is itself
	// the signal: either no Worker has started, or the hooks are not trusted yet.
	notes.push(
		'Teamwork: the campaign is approved and milestones are open, but no hook events have been recorded. ' +
			'Either no Worker has started yet, or the plugin hooks are not trusted in this workspace ' +
			'(ZCode gates workspace hooks behind a trust prompt). Nothing is being policed until that is resolved.',
	);
}

// Report verification coverage alongside progress, because a campaign can look busy
// and still be producing work nothing has checked.
const verificationsDir = join(paths.stateDir, VERIFICATIONS_DIR);
let records = [];
if (existsSync(verificationsDir)) {
	try {
		records = readdirSync(verificationsDir).filter((name) => name.endsWith('.md'));
	} catch {
		records = [];
	}
}
if (milestones.length > 0 && records.length === 0) {
	notes.push(
		`Teamwork: none of the ${milestones.length} milestone(s) has a verification record yet. ` +
			'The verification gate blocks the end of the turn until each completed milestone has one, ' +
			'so writing them as work finishes is cheaper than writing them all at the end.',
	);
}

if (notes.length === 0) emit({});

emit({
	hookSpecificOutput: {
		hookEventName: 'UserPromptSubmit',
		additionalContext: notes.join('\n\n'),
	},
});
