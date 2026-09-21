// Teamwork - file ownership registry.
//
// One file, one owner, for the life of a campaign.
//
// Two agents editing one file is not a merge conflict that resolves; it is a lost
// update. Whichever write lands second silently discards the first, and nothing in
// either agent's context shows the loss. Ownership is therefore exclusive and
// decided up front, before any Worker starts, because the cost of noticing a
// collision at dispatch time is one scheduling decision and the cost of noticing
// it after two Workers have run is the work of one of them.
//
// Leases are time-bounded so a Worker that dies does not hold a file forever. The
// lease is a liveness mechanism, not a security one: an expired lease can be
// reclaimed, and reclaiming it is a deliberate act rather than an automatic one.
//
// ASCII only: protocol artifact.

export const DEFAULT_LEASE_MINUTES = 10;
export const MIN_LEASE_MINUTES = 1;
// A week. A typo like 100000 must not lock a campaign out of its own files.
export const MAX_LEASE_MINUTES = 10080;

/** Normalise a path so two spellings of one file compare equal. */
export function normalizePath(file) {
	return String(file ?? '')
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/{2,}/g, '/')
		.toLowerCase();
}

function clampLease(minutes) {
	const value = Number(minutes);
	if (!Number.isFinite(value)) return DEFAULT_LEASE_MINUTES;
	return Math.min(MAX_LEASE_MINUTES, Math.max(MIN_LEASE_MINUTES, Math.floor(value)));
}

/**
 * Build an ownership entry.
 *
 * `expiresAt` is absolute rather than a duration, so an entry means the same thing
 * regardless of when it is read.
 */
export function createEntry(input) {
	const file = normalizePath(input?.file);
	if (file.length === 0) throw new Error('createEntry: file is required');
	const milestone = String(input?.milestone ?? '');
	if (milestone.length === 0) throw new Error('createEntry: milestone is required');
	const leaseMinutes = clampLease(input?.leaseMinutes ?? DEFAULT_LEASE_MINUTES);
	return {
		file,
		display: String(input?.file ?? file),
		milestone,
		role: String(input?.role ?? 'worker'),
		leaseMinutes,
		expiresAt: new Date(Date.now() + leaseMinutes * 60_000).toISOString(),
	};
}

/**
 * Record an assignment without taking a lease.
 *
 * This is what a plan produces: "this file belongs to this milestone", decided
 * before anyone starts. An assignment has no expiry because it is not a liveness
 * claim - it is released explicitly, or replaced when the campaign is re-planned.
 * Conflating the two would mean a plan written on Monday appears to have expired
 * by Monday afternoon, and the first Worker to run would be told its own file had
 * lapsed.
 */
export function declare(input) {
	const file = normalizePath(input?.file);
	if (file.length === 0) throw new Error('declare: file is required');
	const milestone = String(input?.milestone ?? '');
	if (milestone.length === 0) throw new Error('declare: milestone is required');
	return {
		file,
		display: String(input?.file ?? file),
		milestone,
		role: String(input?.role ?? 'worker'),
		declared: true,
	};
}

/** Claim a file for a milestone. Returns {ok:false, holder} when someone else holds it. */
export function claim(ownership, input, now = Date.now()) {
	const file = normalizePath(input?.file);
	const milestone = String(input?.milestone ?? '');
	if (file.length === 0) return {ok: false, reason: 'file is required'};
	if (milestone.length === 0) return {ok: false, reason: 'milestone is required'};

	const existing = ownership.find((entry) => entry.file === file);
	if (existing) {
		if (existing.milestone === milestone) {
			// A declared assignment already covers this holder; hand it back rather than
			// stacking a second lease on the same file.
			return {ok: true, entry: existing, reused: true};
		}
		if (!isExpired(existing, now)) {
			return {
				ok: false,
				reason: `"${existing.display ?? file}" is owned by milestone "${existing.milestone}" as role "${existing.role}"`,
				holder: existing,
			};
		}
		// An expired lease is reclaimable, but only by taking it explicitly.
		return {ok: true, entry: createEntry(input), replaced: existing};
	}
	return {ok: true, entry: createEntry(input)};
}

export function isExpired(entry, now = Date.now()) {
	// A declared assignment is not a lease: it holds until released or re-planned.
	if (entry?.declared === true) return false;
	if (typeof entry?.expiresAt !== 'string') return true;
	const at = Date.parse(entry.expiresAt);
	if (!Number.isFinite(at)) return true;
	return at <= now;
}

/**
 * Extend an entry's lease. Only the holder may renew, so two Workers cannot keep
 * refreshing each other's claims.
 */
export function renew(entry, milestone, minutes, now = Date.now()) {
	if (entry === null || typeof entry !== 'object') return {ok: false, reason: 'no entry'};
	if (entry.milestone !== milestone) {
		return {ok: false, reason: `"${entry.display ?? entry.file}" is held by "${entry.milestone}", not "${milestone}"`};
	}
	const leaseMinutes = clampLease(minutes ?? entry.leaseMinutes);
	return {
		ok: true,
		entry: {...entry, leaseMinutes, expiresAt: new Date(now + leaseMinutes * 60_000).toISOString()},
	};
}

/** Release a file. Only the holder may release it. */
export function release(ownership, file, milestone) {
	const key = normalizePath(file);
	const entry = ownership.find((e) => e.file === key);
	if (!entry) return {ok: false, reason: `"${file}" is not held by anyone`};
	if (entry.milestone !== milestone) {
		return {ok: false, reason: `"${file}" is held by "${entry.milestone}", not "${milestone}"`};
	}
	return {ok: true, ownership: ownership.filter((e) => e.file !== key)};
}

/**
 * Who may write this file.
 *
 * Returns `allowed` and, when it is not, the holder, so a caller can produce a
 * message naming the actual owner rather than a generic refusal. A refusal that
 * does not say who holds the file leaves the reader with nothing to do next.
 */
export function checkWrite(ownership, file, milestone, now = Date.now()) {
	const key = normalizePath(file);
	const entry = ownership.find((e) => e.file === key);
	if (!entry) return {allowed: true, unclaimed: true};
	if (entry.milestone === milestone) return {allowed: true, entry};
	if (isExpired(entry, now)) {
		return {allowed: false, expired: true, holder: entry, reason: `"${file}" was held by "${entry.milestone}" but the lease expired`};
	}
	return {allowed: false, holder: entry, reason: `"${file}" belongs to milestone "${entry.milestone}"`};
}

/** Files claimed by a milestone, for scheduling and for reports. */
export function filesOf(ownership, milestone) {
	return ownership.filter((e) => e.milestone === milestone).map((e) => e.file);
}

/**
 * Detect conflicts in a proposed ownership set.
 *
 * Called before a plan is accepted, so a collision is a scheduling problem rather
 * than a runtime refusal with two Workers already dispatched.
 */
export function findCollisions(proposed) {
	const byFile = new Map();
	const collisions = [];
	for (const entry of proposed) {
		const key = normalizePath(entry?.file);
		if (key.length === 0) continue;
		const owner = String(entry?.milestone ?? '');
		const existing = byFile.get(key);
		if (existing && existing !== owner) {
			collisions.push({file: key, milestones: [existing, owner]});
			continue;
		}
		byFile.set(key, owner);
	}
	return collisions;
}

/** Expired entries, reported so a stalled campaign is visible rather than silent. */
export function expiredEntries(ownership, now = Date.now()) {
	return ownership.filter((entry) => isExpired(entry, now));
}
