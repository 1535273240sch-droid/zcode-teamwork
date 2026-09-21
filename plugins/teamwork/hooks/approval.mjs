#!/usr/bin/env node
// Teamwork - approve campaign charter via UserPromptSubmit.
//
// ASCII only: this file is a protocol artifact and crosses an encoding boundary.

import {
	readStdin,
	statePaths,
	loadCampaign,
	writeAtomic,
	appendEvent,
	charterHash,
	existsSync,
} from './_lib.mjs';
import {spawnSync} from 'node:child_process';

const raw = await readStdin();

let input;
try {
	input = JSON.parse(raw);
} catch {
	process.exit(0); // fail-open
}

if (!input || typeof input !== 'object') process.exit(0);

const prompt =
	typeof input.prompt === 'string'
		? input.prompt
		: typeof input.text === 'string'
			? input.text
			: typeof input.user_prompt === 'string'
				? input.user_prompt
				: typeof input.message === 'string'
					? input.message
					: '';

const isCommand = /^\s*\/teamwork-approve(\s|$)/i.test(prompt);
const hasSentinel = prompt.includes('[[TEAMWORK-APPROVE-v1]]');

if (!isCommand && !hasSentinel) {
	process.exit(0);
}

const cwd = input.cwd || process.cwd();
const paths = statePaths(cwd);

if (!existsSync(paths.campaign)) {
	process.exit(0);
}

const campaign = loadCampaign(paths.campaign);
if (!campaign) process.exit(0);

if (campaign.phase !== 'scoping' && campaign.phase !== 'execution') {
	process.exit(0);
}

function getGitHead(dir) {
	try {
		const res = spawnSync('git', ['rev-parse', 'HEAD'], {
			cwd: dir,
			encoding: 'utf8',
			timeout: 3000,
		});
		if (res.status === 0 && res.stdout) {
			const trimmed = res.stdout.trim();
			if (trimmed.length > 0) return trimmed;
		}
	} catch {
		// git not installed or not in PATH
	}
	return null;
}

try {
	const hash = charterHash(campaign);
	const baseSha = getGitHead(cwd);
	const now = new Date().toISOString();

	const approval = {
		charter_sha256: hash,
		approved_at: now,
		base_sha: baseSha,
		source: 'user_prompt_hook',
	};

	writeAtomic(paths.approval, JSON.stringify(approval, null, 2) + '\n');

	campaign.approved = true;
	campaign.phase = 'execution';
	writeAtomic(paths.campaign, JSON.stringify(campaign, null, 2) + '\n');

	appendEvent(paths, {
		event: 'approved',
		charter_sha256: hash,
		source: 'user_prompt_hook',
		base_sha: baseSha,
	});
} catch {
	// fail-open
}

process.exit(0);
