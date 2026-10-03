#!/usr/bin/env node
// Teamwork - active watchdog runner.
//
// Checks campaign health, detects deadlocks, issues nudges, and auto-heals expired
// leases and abandoned worker reservations.
//
// Usage:
//   node scripts/watchdog.mjs            # Run one-off health check and auto-heal
//   node scripts/watchdog.mjs --daemon   # Run continuous background watchdog loop (every 60s)
//
// ASCII only: protocol artifact.

import {inspectHealth, healHealth} from '../plugins/teamwork/lib/watchdog.mjs';

const args = process.argv.slice(2);
const isDaemon = args.includes('--daemon');
const intervalMs = 60_000;

function runOnce() {
	const health = inspectHealth({cwd: process.cwd()});
	const timeStr = new Date().toLocaleTimeString();

	if (!health.ok) {
		console.log(`[${timeStr}] Watchdog: ${health.reason}`);
		return;
	}

	console.log(`[${timeStr}] Campaign Status: [${health.status.toUpperCase()}] | Quiet: ${health.quietMinutes ?? 0}m | Open: ${health.openMilestones?.length ?? 0}`);

	if (health.signals?.length > 0) {
		for (const s of health.signals) {
			console.log(`  ! [${s.severity.toUpperCase()}] ${s.detail}`);
		}
	}

	if (health.status === 'deadlocked' || health.expiredLeases?.length > 0 || health.abandonedReservations?.length > 0) {
		const healResult = healHealth({cwd: process.cwd()});
		if (healResult.healed) {
			console.log(`  -> Auto-healed: pruned ${healResult.prunedLeases?.length ?? 0} lease(s), ${healResult.prunedReservations?.length ?? 0} reservation(s).`);
		}
	}
}

console.log('=== Teamwork Active Watchdog (Sentinel Liveness & Deadlock Guard) ===');

if (!isDaemon) {
	runOnce();
} else {
	console.log(`Running in daemon mode (polling every ${intervalMs / 1000}s)... Press Ctrl+C to stop.`);
	runOnce();
	setInterval(runOnce, intervalMs);
}
