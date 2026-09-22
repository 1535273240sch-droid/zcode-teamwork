// Teamwork - batch scheduler.
//
// Turns a milestone list into execution batches: which milestones can run at the
// same time, which must wait, and how many Workers the campaign will need.
//
// Why this is code and not a sentence in a prompt: the two failure modes it
// prevents are both invisible to a model reading its own plan.
//
//   1. Two milestones that name the same file cannot be "parallel". The plan can
//      say they are, and the ownership hooks will then deny one of the Workers at
//      run time - after the tokens are already spent. Checking disjointness here
//      is cheap and catches it before dispatch.
//   2. A batch that exceeds the spawn budget does not fail loudly; it thins out
//      somewhere in the middle of a long run, and the campaign loses a milestone
//      without ever saying so.
//
// ASCII only: protocol artifact.

export const DEFAULT_SPAWN_BUDGET = 16;

/**
 * The dispatch ceiling in force for a campaign.
 *
 * One implementation, used by the engine and mirrored by the spawn-budget hook.
 * They previously disagreed: the hook read `spawnBudget` from campaign.json, while
 * the engine used its constructor default, so `/teamwork-status` and `succession`
 * reported 16 for a campaign whose ceiling was 6 - and the hook enforced 6. Every
 * number a human reads was therefore wrong in the permissive direction, which is the
 * worst way for a cost ceiling to be wrong.
 *
 * Returns undefined when the ceiling is explicitly disabled (`0` or `null`), matching
 * the hook's contract.
 */
export function resolveSpawnBudget(campaign) {
	const raw = campaign?.spawnBudget;
	if (raw === 0 || raw === null) return undefined; // explicitly disabled
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_SPAWN_BUDGET;
	return Math.floor(value);
}

/**
 * Normalise a file path for overlap comparison. Deliberately textual: these paths
 * are plan data, not resolved filesystem entries, and resolve() on a path that
 * does not exist yet would produce a key that does not match the hook's key.
 */
function key(file) {
	return String(file).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** Which milestones name at least one common file. */
export function fileConflicts(milestones) {
	const owners = new Map();
	const conflicts = [];
	for (const milestone of milestones) {
		for (const file of milestone.files ?? []) {
			const norm = key(file);
			const holder = owners.get(norm);
			if (holder && holder !== milestone.id) {
				conflicts.push({file, milestones: [holder, milestone.id]});
			} else {
				owners.set(norm, milestone.id);
			}
		}
	}
	return conflicts;
}

/**
 * Group milestones into batches by dependency depth.
 *
 * Batches are computed from `blocked_by` only, then narrowed: a milestone that
 * shares a file with another in the same batch is pushed to the next batch, because
 * a batch is a claim that its members can run at the same time.
 */
export function schedule(milestones, options = {}) {
	const budget = Number.isFinite(options.budget) ? options.budget : DEFAULT_SPAWN_BUDGET;
	const byId = new Map(milestones.map((m) => [m.id, m]));

	if (byId.size !== milestones.length) {
		return {ok: false, error: 'duplicate milestone id'};
	}
	for (const milestone of milestones) {
		for (const dep of milestone.blocked_by ?? []) {
			if (!byId.has(dep)) {
				return {ok: false, error: `milestone "${milestone.id}" is blocked_by unknown milestone "${dep}"`};
			}
		}
	}

	// Dependency depth. A cycle means the plan cannot be executed as written, and
	// running it would deadlock the campaign, so it is reported rather than guessed at.
	const depth = new Map();
	function depthOf(id, seen) {
		if (depth.has(id)) return depth.get(id);
		if (seen.has(id)) return -1; // cycle
		seen.add(id);
		const deps = byId.get(id)?.blocked_by ?? [];
		let max = 0;
		for (const dep of deps) {
			const d = depthOf(dep, seen);
			if (d < 0) return -1;
			if (d + 1 > max) max = d + 1;
		}
		seen.delete(id);
		depth.set(id, max);
		return max;
	}
	for (const milestone of milestones) {
		if (depthOf(milestone.id, new Set()) < 0) {
			return {ok: false, error: `dependency cycle involving milestone "${milestone.id}"`};
		}
	}

	const byDepth = new Map();
	for (const milestone of milestones) {
		const d = depth.get(milestone.id);
		if (!byDepth.has(d)) byDepth.set(d, []);
		byDepth.get(d).push(milestone);
	}

	// Within a depth, split any set that shares a file, and keep dependent splits
	// in later batches.
	const batches = [];
	for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
		let pending = byDepth.get(d).filter((m) => m.status !== 'done');
		while (pending.length > 0) {
			const batch = [];
			const claimed = new Set();
			const deferred = [];
			for (const milestone of pending) {
				const files = (milestone.files ?? []).map(key);
				if (files.some((f) => claimed.has(f))) {
					deferred.push(milestone);
					continue;
				}
				for (const f of files) claimed.add(f);
				batch.push(milestone);
			}
			if (batch.length === 0) break; // defensive: no progress possible
			batches.push({
				index: batches.length,
				milestones: batch.map((m) => m.id),
				files: [...claimed],
				parallel: batch.length > 1,
			});
			pending = deferred;
		}
	}

	const remaining = milestones.filter((m) => m.status !== 'done');
	const conflicts = fileConflicts(milestones);
	const exceeded = remaining.length > budget;

	return {
		ok: true,
		batches,
		worker_dispatches: remaining.length,
		budget,
		budget_exceeded: exceeded,
		file_conflicts: conflicts,
		warnings: [
			...(exceeded
				? [
						`Plan needs ${remaining.length} Worker dispatches but the campaign budget is ${budget}. ` +
							'Either widen the file scopes so milestones merge, or raise the budget deliberately - ' +
							'a campaign that quietly runs out of dispatches loses milestones without reporting it.',
					]
				: []),
			...(conflicts.length > 0
				? [
						`Milestones share files: ${conflicts
							.map((c) => `${c.file} (${c.milestones.join(', ')})`)
							.join('; ')}. They can never run at the same time; the ownership hooks would deny one of them.`,
					]
				: []),
		],
	};
}
