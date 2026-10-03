#!/usr/bin/env node
// Teamwork - 哨兵主动看门狗运行器。
//
// 实时巡检战役健康状态、发现死锁隐患、发出停滞提醒，并自动自愈过期文件租约与悬挂的孤立子代理预留。
//
// 使用方式：
//   node scripts/watchdog.mjs            # 运行单次健康巡检与死锁自愈
//   node scripts/watchdog.mjs --daemon   # 启动常驻后台轮询看门狗循环 (每 60 秒轮询)

import {inspectHealth, healHealth} from '../plugins/teamwork/lib/watchdog.mjs';

const args = process.argv.slice(2);
const isDaemon = args.includes('--daemon');
const intervalMs = 60_000;

const STATUS_ZH = {
	healthy: '健康',
	deadlocked: '死锁',
	nudge: '停滞告警',
	warning: '异常预警',
	inactive: '未激活',
	idle: '空闲',
};

function runOnce() {
	const health = inspectHealth({cwd: process.cwd()});
	const timeStr = new Date().toLocaleTimeString();

	if (!health.ok) {
		console.log(`[${timeStr}] 哨兵看门狗: ${health.reason}`);
		return;
	}

	const statusText = STATUS_ZH[health.status] ?? health.status.toUpperCase();
	console.log(`[${timeStr}] 战役状态: [${statusText}] | 静默时长: ${health.quietMinutes ?? 0} 分钟 | 开放里程碑: ${health.openMilestones?.length ?? 0}`);

	if (health.signals?.length > 0) {
		for (const s of health.signals) {
			console.log(`  ! [${s.severity.toUpperCase()}] ${s.detail}`);
		}
	}

	if (health.status === 'deadlocked' || health.expiredLeases?.length > 0 || health.abandonedReservations?.length > 0) {
		const healResult = healHealth({cwd: process.cwd()});
		if (healResult.healed) {
			console.log(`  -> 自动自愈成功: 释放 ${healResult.prunedLeases?.length ?? 0} 个过期文件租约, 清理 ${healResult.prunedReservations?.length ?? 0} 个孤立预留令牌。`);
		}
	}
}

console.log('🌌 === Teamwork 哨兵主动看门狗 (存活巡检与死锁自愈内核) ===');

if (!isDaemon) {
	runOnce();
} else {
	console.log(`正在以后台守护进程模式运行 (每 ${intervalMs / 1000} 秒巡检一次)... 按 Ctrl+C 可停止。`);
	runOnce();
	setInterval(runOnce, intervalMs);
}
