// Teamwork - tiered agile routing.
//
// Solves the "token explosion & bureaucratic paralysis" problem.
// Instead of forcing every 3-line bugfix through an 8-role, 5-phase ordeal,
// the router classifies the task into three concrete tiers:
//
//   L1: AGILE (Duo)        - Worker + Critic. Rapid turnaround, low token cost.
//   L2: STANDARD (Squad)   - Orchestrator + Worker + Auditor + Critic.
//   L3: ADVERSARIAL (Team) - Full 8-role adversarial rigor with Sentinel & Challenger.
//
// ASCII only: protocol artifact.

export const TIERS = {
	L1_AGILE: 'agile',
	L2_STANDARD: 'standard',
	L3_ADVERSARIAL: 'adversarial',
};

export const TIER_CONFIGS = {
	[TIERS.L1_AGILE]: {
		tier: TIERS.L1_AGILE,
		title: 'L1 Agile Duo (Worker + Critic)',
		summary: 'Zero ceremony. For single-file fixes, small features, and fast iterations.',
		activeRoles: ['worker', 'critic'],
		skipSentinel: true,
		skipOrchestrator: true,
		defaultPattern: 'iterative-coding',
		defaultSpawnBudget: 4,
		maxParallel: 1,
		minDeliverableBytes: 64,
		requireEvidence: true,
	},
	[TIERS.L2_STANDARD]: {
		tier: TIERS.L2_STANDARD,
		title: 'L2 Standard Squad (Orchestrator + Worker + Auditor + Critic)',
		summary: 'Structured milestones, independent reproduction, and disjoint file handling.',
		activeRoles: ['orchestrator', 'worker', 'critic', 'auditor', 'success-auditor'],
		skipSentinel: true,
		skipOrchestrator: false,
		defaultPattern: 'distributed-coding',
		defaultSpawnBudget: 12,
		maxParallel: 2,
		minDeliverableBytes: 256,
		requireEvidence: true,
	},
	[TIERS.L3_ADVERSARIAL]: {
		tier: TIERS.L3_ADVERSARIAL,
		title: 'L3 Full Adversarial (8 Roles)',
		summary: 'Maximum defense. Quantitative models, math proofs, high-risk migrations.',
		activeRoles: [
			'sentinel',
			'orchestrator',
			'explorer',
			'worker',
			'critic',
			'challenger',
			'auditor',
			'success-auditor',
		],
		skipSentinel: false,
		skipOrchestrator: false,
		defaultPattern: 'distributed-coding',
		defaultSpawnBudget: 24,
		maxParallel: 4,
		minDeliverableBytes: 1024,
		requireEvidence: true,
	},
};

/**
 * Recommend an operational tier based on task characteristics.
 */
export function recommendTier(input = {}) {
	const text = String(input.objective ?? input.task ?? '').toLowerCase();
	const files = Array.isArray(input.affectedFiles) ? input.affectedFiles : [];
	const fileCount = files.length;

	// High risk triggers -> L3
	const highRiskKeywords = [
		'backtest',
		'alpha',
		'trading',
		'financial',
		'security',
		'vulnerability',
		'consensus',
		'proof',
		'mathematical',
		'migration',
		'database schema',
		'adversarial',
		'red-team',
	];

	if (highRiskKeywords.some((k) => text.includes(k)) || fileCount >= 8) {
		return {
			tier: TIERS.L3_ADVERSARIAL,
			confidence: 0.9,
			reasons: [
				fileCount >= 8 ? `${fileCount} files affected (>= 8)` : 'High-risk or zero-tolerance domain keywords detected',
				'Requires Sentinel pre-flight and Challenger adversarial falsification',
			],
			config: TIER_CONFIGS[TIERS.L3_ADVERSARIAL],
		};
	}

	// Single file or quick fixes -> L1
	const lowRiskKeywords = ['fix', 'typo', 'small', 'unit test', 'tweak', 'quick', 'add test', 'lint'];
	if ((fileCount <= 2 && lowRiskKeywords.some((k) => text.includes(k))) || fileCount === 1) {
		return {
			tier: TIERS.L1_AGILE,
			confidence: 0.85,
			reasons: [
				fileCount <= 2 ? `Narrow scope (${fileCount || 1} file(s))` : 'Low blast radius bugfix/tweak',
				'Bypasses Sentinel and scoping interview to save 80%+ tokens',
			],
			config: TIER_CONFIGS[TIERS.L1_AGILE],
		};
	}

	// Default middle ground -> L2
	return {
		tier: TIERS.L2_STANDARD,
		confidence: 0.8,
		reasons: [
			`${fileCount || 'Multiple'} files touched across repository`,
			'Needs formal milestone dependency decomposition and independent auditor reproduction',
		],
		config: TIER_CONFIGS[TIERS.L2_STANDARD],
	};
}
