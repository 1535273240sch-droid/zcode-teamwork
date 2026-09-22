// Teamwork - evidence and deliverables.
//
// Two failures motivated this file, and they are the same failure seen twice.
//
// 1. Two workers produced 2.4 MB of findings for a code review. A third claimed
//    success and wrote 802 bytes: a heading and nothing else. The gate passed it,
//    because the gate read the record and the record said the right words.
//
// 2. A worker wrote a fabricated `npm test` transcript into its verification
//    record, numbers and all. The gate passed it, for the same reason.
//
// In both cases the gate checked what the record *said* rather than what was *on
// disk*. A record is the worker's own account of its work, and an account can be
// wrong, incomplete, or invented. This module is about checking the artefacts
// instead: did the file get written, is it a real file or a stub, and did the
// evidence come from a command that actually ran or from the model's own pen.
//
// What this can and cannot do, stated plainly up front:
//
//   CAN   detect a missing deliverable, an empty one, and one that is a header
//         with no body
//   CAN   detect evidence that was written by the model rather than captured from
//         a tool call, by cross-checking the audit trail
//   CANNOT prove the content of a deliverable is correct or useful
//   CANNOT verify the substance of a claim - only that it was produced by
//         something other than the claimant
//
// The last two are the important limits. This raises the floor; it does not
// establish truth.
//
// ASCII only: protocol artifact.

import {existsSync, readFileSync, statSync, mkdirSync, appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

/** Deliverable files live here unless a milestone says otherwise. */
export const DELIVERABLES_DIR = 'deliverables';

/** Evidence captured from tool calls lives here. */
export const EVIDENCE_DIR = 'evidence';

/**
 * Smallest file we will accept as a real deliverable.
 *
 * Chosen from measured data rather than taste: the six failures in the code-review
 * incident produced stubs of 802, 1008 and 1839 bytes, while the two survivors
 * produced 23,818 and 35,390. Anything under this is a heading or two.
 */
export const MIN_DELIVERABLE_BYTES = 2048;

/**
 * Markers that mean a file is a placeholder rather than a deliverable.
 *
 * Word-boundary matched on the uppercased text so that prose *about* placeholders
 * does not trip the check - a report saying "the FINDINGS-PLACEHOLDER marker was
 * left in" is describing a defect, not being one.
 */
export const PLACEHOLDER_MARKERS = [
	'FINDINGS-PLACEHOLDER',
	'PLACEHOLDER',
	'TODO:',
	'TBD',
	'FIXME:',
	'<FILL',
	'LOREM IPSUM',
];

/**
 * Inspect one candidate deliverable.
 *
 * Returns a verdict and the reasons, never a bare boolean: a caller needs to tell
 * "missing" from "empty" from "stub" to say anything useful to the worker.
 */
export function inspectDeliverable(path, options = {}) {
	const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : MIN_DELIVERABLE_BYTES;
	const reasons = [];

	if (!existsSync(path)) {
		return {ok: false, kind: 'missing', bytes: 0, reasons: ['file does not exist']};
	}

	let stats;
	try {
		stats = statSync(path);
	} catch (error) {
		return {ok: false, kind: 'unreadable', bytes: 0, reasons: [error.message]};
	}
	if (stats.isDirectory()) {
		return {ok: false, kind: 'not-a-file', bytes: 0, reasons: ['path is a directory, not a file']};
	}

	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		return {ok: false, kind: 'unreadable', bytes: stats.size, reasons: [error.message]};
	}

	const body = stripHeadings(text);
	const trimmedBody = body.trim();

	if (stats.size === 0) {
		return {ok: false, kind: 'empty', bytes: 0, reasons: ['file is empty']};
	}

	if (stats.size < minBytes) {
		reasons.push(`${stats.size} bytes, below the ${minBytes}-byte floor`);
	}

	if (trimmedBody.length === 0) {
		reasons.push('file contains only headings, with no body content');
	}

	const upper = text.toUpperCase();
	const found = PLACEHOLDER_MARKERS.filter((marker) => upper.includes(marker));
	if (found.length > 0) {
		reasons.push(`placeholder text left in: ${found.join(', ')}`);
	}

	if (reasons.length > 0) {
		return {ok: false, kind: 'stub', bytes: stats.size, reasons};
	}
	return {ok: true, kind: 'content', bytes: stats.size, reasons: []};
}

/**
 * Remove markdown headings and horizontal rules, leaving the body.
 *
 * A file that is only headings is a template someone abandoned. Stripping them
 * lets the length check ask about substance rather than structure, so a document
 * that is 90% headings is not mistaken for a document with content.
 */
export function stripHeadings(text) {
	return String(text)
		.split('\n')
		.filter((line) => {
			const t = line.trim();
			if (t.length === 0) return false;
			if (t.startsWith('#')) return false;
			if (/^[-=*_]{3,}$/.test(t)) return false;
			return true;
		})
		.join('\n');
}

/**
 * Check a milestone's declared deliverables.
 *
 * A milestone with no `deliverables` is not checked here - many milestones produce
 * a code change rather than a file, and inventing a file requirement for them
 * would make the gate noise. Opting in is the milestone author's call.
 */
export function checkDeliverables(milestone, cwd, options = {}) {
	const declared = Array.isArray(milestone?.deliverables) ? milestone.deliverables : [];
	if (declared.length === 0) return {checked: false, failures: [], results: []};

	const failures = [];
	const results = [];
	for (const relative of declared) {
		if (typeof relative !== 'string' || relative.length === 0) continue;
		const full = relative.startsWith('/') ? relative : join(cwd, relative);
		const result = inspectDeliverable(full, options);
		results.push({path: relative, ...result});
		if (!result.ok) {
			failures.push(
				`"${milestone.id}" deliverable ${relative} is ${result.kind}: ${result.reasons.join('; ')}`,
			);
		}
	}
	return {checked: true, failures, results};
}

// ---------------------------------------------------------------------------
// Evidence capture
//
// The point of this section is the asymmetry: the model writes the record, but the
// hook writes the evidence. A record can therefore claim anything, and the evidence
// it cites was produced by the runtime and cannot be edited into existence.
//
// The remaining hole was the model simply writing the evidence file itself. That is
// closed by cross-checking the audit trail: a file under evidence/ that the trail
// shows a Write call creating is model-authored, and is rejected. The trail is
// already written by audit-log on every tool call, so the check costs nothing.

/** Shape of an evidence filename. One per captured tool call. */
export function evidenceName(toolUseId, at = Date.now()) {
	const safe = String(toolUseId ?? '')
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.slice(0, 80);
	const stem = safe.length > 0 ? safe : `call-${at}`;
	return `${stem}.log`;
}

/** Path for a captured piece of evidence. */
export function evidencePath(stateDir, name) {
	return join(stateDir, EVIDENCE_DIR, name);
}

/**
 * Bytes of output tail kept in a fingerprint. Small on purpose: enough to
 * recognise what ran, not enough to carry a credential file.
 */
export const TAIL_BYTES = Number.isFinite(Number(process.env.TEAMWORK_EVIDENCE_TAIL))
	? Math.max(0, Number(process.env.TEAMWORK_EVIDENCE_TAIL))
	: 400;

/**
 * Capture a tool call's execution as evidence.
 *
 * The file is written here, by the hook, and never by the model. That asymmetry is
 * the whole mechanism: a verification record can claim anything, but the evidence it
 * cites was produced by the runtime. A file under evidence/ that the audit trail
 * shows a Write call creating is rejected for exactly this reason.
 *
 * What is stored is a fingerprint - command, exit status, byte count, hash, and a
 * short tail - not the full output. Outputs are large and routinely contain secrets
 * (a code review reads .env files), and an evidence store that leaks credentials
 * would be a worse problem than the one it solves.
 *
 * The consequence, stated because it matters when reading a record: this proves a
 * command ran and what it produced in volume, but not that the record quotes it
 * faithfully. Closing that gap needs the full output, which needs a secrets policy
 * first.
 *
 * Single implementation. An earlier version of this plugin had one copy here and
 * another inline in audit-log.mjs with different behaviour - which is the same
 * shape of defect as the plan.json/campaign.json disagreement that took a real
 * machine to find. There is one copy now, and audit-log imports it.
 *
 * Returns the relative path to cite, or null when there is nothing to capture.
 */
export function captureEvidence(stateDir, input) {
	const name = evidenceName(input?.toolUseId, input?.at);
	const dir = join(stateDir, EVIDENCE_DIR);
	try {
		mkdirSync(dir, {recursive: true});
	} catch {
		return null;
	}

	const output = typeof input?.output === 'string' ? input.output : '';
	const hash = createHash('sha256').update(output).digest('hex');
	const tail = TAIL_BYTES > 0 ? output.slice(-TAIL_BYTES) : '';

	const lines = [
		'# captured tool output',
		`at: ${new Date(input?.at ?? Date.now()).toISOString()}`,
		`tool: ${input?.tool ?? 'unknown'}`,
		input?.command ? `command: ${input.command}` : null,
		input?.file ? `file: ${input.file}` : null,
		`output_bytes: ${output.length}`,
		`output_sha256: ${hash}`,
		input?.exitCode === undefined ? null : `exit_code: ${input.exitCode}`,
		`status: ${input?.failed ? 'failed' : 'ok'}`,
		'---',
	].filter((line) => line !== null);

	if (tail.length > 0) {
		lines.push('', `# last ${TAIL_BYTES} bytes of output`, tail);
	}

	try {
		appendFileSync(evidencePath(stateDir, name), `${lines.join('\n')}\n`);
	} catch {
		return null;
	}
	return `${EVIDENCE_DIR}/${name}`.replace(/\\/g, '/');
}

/**
 * Which evidence files the audit trail says the model wrote itself.
 *
 * The trail records every Write and Edit. If one of them names a file inside
 * evidence/, that file is the claimant's own work, and citing it is exactly the
 * forgery this check exists to catch.
 */
export function modelAuthoredEvidence(events) {
	const authored = new Set();
	for (const event of Array.isArray(events) ? events : []) {
		const target = typeof event?.file === 'string' ? event.file.replace(/\\/g, '/').toLowerCase() : '';
		if (target.length === 0) continue;
		if (!target.includes(`/${EVIDENCE_DIR}/`)) continue;
		if (event.tool !== 'Write' && event.tool !== 'Edit' && event.tool !== 'MultiEdit') continue;
		authored.add(target);
	}
	return authored;
}

/**
 * Find the evidence references a verification record makes.
 *
 * Accepted forms, deliberately forgiving about surrounding punctuation:
 *   evidence: .teamwork/evidence/abc.log
 *   evidence: evidence/abc.log
 *   evidence: abc.log
 */
export function evidenceRefs(text) {
	const out = new Set();
	const lines = String(text ?? '').split('\n');
	for (const line of lines) {
		const match = /^\s*evidence\s*:\s*(.+?)\s*$/i.exec(line);
		if (!match) continue;
		const value = match[1].replace(/[`'"]/g, '').trim();
		if (value.length === 0) continue;
		out.add(value);
	}
	return [...out];
}

/**
 * Judge the evidence a record cites.
 *
 * Returns failures rather than a verdict, so the gate can phrase each one as an
 * instruction the worker can act on. A record with no evidence reference at all is
 * its own failure: the whole point is that the claim is checkable.
 */
export function checkEvidence(recordPath, recordText, options) {
	const {stateDir, events = [], requireEvidence = true} = options ?? {};
	const failures = [];

	const refs = evidenceRefs(recordText);
	if (refs.length === 0) {
		if (requireEvidence) {
			failures.push(
				`${recordPath} cites no evidence. Add a line "evidence: .teamwork/evidence/<name>.log" pointing at ` +
					'the captured output of the command that produced this result.',
			);
		}
		return {checked: requireEvidence, refs: [], failures};
	}

	const forged = modelAuthoredEvidence(events);

	for (const ref of refs) {
		const bare = ref.replace(/\\/g, '/').toLowerCase();
		const name = bare.slice(bare.lastIndexOf('/') + 1);
		const full = bare.includes('/') ? join(stateDir, '..', ref) : evidencePath(stateDir, name);

		if (!existsSync(full)) {
			failures.push(`${recordPath} cites evidence "${ref}" but no such file exists`);
			continue;
		}

		let size = 0;
		try {
			size = statSync(full).size;
		} catch {
			size = 0;
		}
		if (size === 0) {
			failures.push(`${recordPath} cites evidence "${ref}" but the file is empty`);
			continue;
		}

		// The check that makes the rest worth having: evidence the model wrote is not
		// evidence. Match on the trailing name so an absolute path in the trail and a
		// relative path in the record still compare equal.
		for (const target of forged) {
			if (target.endsWith(name)) {
				failures.push(
					`${recordPath} cites evidence "${ref}", but the audit trail shows that file was written by a tool ` +
						'call rather than captured from one. Evidence has to be produced by the command, not by the ' +
						'claimant.',
				);
				break;
			}
		}
	}

	return {checked: true, refs, failures};
}

/** A short line describing what the deliverable check requires. */
export function describeDeliverableRules(options = {}) {
	const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : MIN_DELIVERABLE_BYTES;
	return (
		`A declared deliverable must exist, be at least ${minBytes} bytes, contain body text beyond its headings, ` +
		`and carry no placeholder markers (${PLACEHOLDER_MARKERS.join(', ')}).`
	);
}
