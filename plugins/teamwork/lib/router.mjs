// Teamwork - specialized routing & tiered agile architecture.
//
// Aligned 100% with Google Antigravity Task Routing:
//   1. swe-light: Single-file / self-contained modification. Iron rule: does NOT decompose.
//   2. general: Repo-scale software engineering, multi-module DAG milestones.
//   3. document-review: Papers, RFCs, specs review via recursive tournament aggregation (RSA).
//   4. math-proof: Theorem derivation, formalized proof via Colosseum stage pipeline.
//   5. adversarial-quant: Financial alpha, security vulnerability, red-team fuzzing with empirical challenger.
//
// Backward-compatible with L1/L2/L3 tiers.
//
// ASCII only: protocol artifact.

export const TIERS = {
	L1_AGILE: 'agile',
	L2_STANDARD: 'standard',
	L3_ADVERSARIAL: 'adversarial',
};

export const PATHS = {
	SWE_LIGHT: 'swe-light',
	GENERAL: 'general',
	DOCUMENT_REVIEW: 'document-review',
	MATH_PROOF: 'math-proof',
	ADVERSARIAL_QUANT: 'adversarial-quant',
};

export const PATH_CONFIGS = {
	[PATHS.SWE_LIGHT]: {
		path: PATHS.SWE_LIGHT,
		title: 'SWE Light (Single-file fast turnaround)',
		summary: 'Zero decomposition. Single implementer with reviewer loop.',
		activeRoles: ['worker', 'critic'],
		skipSentinel: true,
		skipOrchestrator: true,
		canDecompose: false,
		defaultPattern: 'iterative-coding',
		defaultSpawnBudget: 4,
		maxParallel: 1,
		minDeliverableBytes: 64,
		requireEvidence: true,
	},
	[PATHS.GENERAL]: {
		path: PATHS.GENERAL,
		title: 'General SWE Orchestration',
		summary: 'Standard repository-scale engineering with milestone DAG & independent audit.',
		activeRoles: ['orchestrator', 'worker', 'critic', 'test-writer', 'auditor', 'success-auditor'],
		skipSentinel: true,
		skipOrchestrator: false,
		canDecompose: true,
		defaultPattern: 'distributed-coding',
		defaultSpawnBudget: 16,
		maxParallel: 2,
		minDeliverableBytes: 256,
		requireEvidence: true,
	},
	[PATHS.DOCUMENT_REVIEW]: {
		path: PATHS.DOCUMENT_REVIEW,
		title: 'Document Review (RSA Tournament Tree)',
		summary: 'Recursive self-aggregation review over papers, RFCs, and markdown specifications.',
		activeRoles: ['orchestrator', 'spec-miner', 'critic', 'challenger', 'auditor'],
		skipSentinel: true,
		skipOrchestrator: false,
		canDecompose: true,
		defaultPattern: 'document-review',
		defaultSpawnBudget: 12,
		maxParallel: 4,
		minDeliverableBytes: 2048,
		requireEvidence: true,
	},
	[PATHS.MATH_PROOF]: {
		path: PATHS.MATH_PROOF,
		title: 'Math & Formal Proof Pipeline',
		summary: 'Colosseum multistage verification for theorems and deductive logic.',
		activeRoles: ['sentinel', 'orchestrator', 'worker', 'challenger', 'auditor', 'success-auditor'],
		skipSentinel: false,
		skipOrchestrator: false,
		canDecompose: true,
		defaultPattern: 'math-proof',
		defaultSpawnBudget: 24,
		maxParallel: 2,
		minDeliverableBytes: 512,
		requireEvidence: true,
	},
	[PATHS.ADVERSARIAL_QUANT]: {
		path: PATHS.ADVERSARIAL_QUANT,
		title: 'Full Adversarial & Quant Red-Team',
		summary: 'Maximum rigor. Quantitative backtests, security vulnerabilities, empirical fuzzing.',
		activeRoles: [
			'sentinel',
			'orchestrator',
			'spec-miner',
			'explorer',
			'worker',
			'test-writer',
			'critic',
			'challenger',
			'empirical-challenger',
			'auditor',
			'success-auditor',
		],
		skipSentinel: false,
		skipOrchestrator: false,
		canDecompose: true,
		defaultPattern: 'distributed-coding',
		defaultSpawnBudget: 32,
		maxParallel: 4,
		minDeliverableBytes: 1024,
		requireEvidence: true,
	},
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
		title: 'L3 Full Adversarial (11 Roles)',
		summary: 'Maximum defense. Quantitative models, math proofs, empirical fuzzing, high-risk migrations.',
		activeRoles: [
			'sentinel',
			'orchestrator',
			'spec-miner',
			'explorer',
			'worker',
			'test-writer',
			'critic',
			'challenger',
			'empirical-challenger',
			'auditor',
			'success-auditor',
		],
		skipSentinel: false,
		skipOrchestrator: false,
		defaultPattern: 'distributed-coding',
		defaultSpawnBudget: 32,
		maxParallel: 4,
		minDeliverableBytes: 1024,
		requireEvidence: true,
	},
};

/**
 * Recommend an Antigravity specialized path.
 */
export function recommendPath(input = {}) {
	const text = String(input.objective ?? input.task ?? '').toLowerCase();
	const files = Array.isArray(input.affectedFiles) ? input.affectedFiles : [];
	const fileCount = files.length;

	// 1. Document review triggers
	if (/(paper|rfc|specification|manuscript|arxiv|review doc|document review|whitepaper)/.test(text)) {
		return {
			path: PATHS.DOCUMENT_REVIEW,
			confidence: 0.95,
			reasons: ['Document or specification review requested', 'Routes to RSA recursive tournament review path'],
			config: PATH_CONFIGS[PATHS.DOCUMENT_REVIEW],
		};
	}

	// 2. Math proof triggers
	if (/(theorem|lemma|formal proof|derivation|colosseum|mathematical logic)/.test(text)) {
		return {
			path: PATHS.MATH_PROOF,
			confidence: 0.95,
			reasons: ['Mathematical proof or theorem derivation requested', 'Routes to Colosseum multistage verification'],
			config: PATH_CONFIGS[PATHS.MATH_PROOF],
		};
	}

	// 3. Adversarial / Quant triggers
	const quantAdversarialKeywords = [
		'backtest',
		'alpha',
		'trading',
		'financial',
		'security',
		'vulnerability',
		'exploit',
		'fuzz',
		'fuzzing',
		'consensus',
		'adversarial',
		'red-team',
	];
	if (quantAdversarialKeywords.some((k) => text.includes(k)) || fileCount >= 8) {
		return {
			path: PATHS.ADVERSARIAL_QUANT,
			confidence: 0.9,
			reasons: [
				fileCount >= 8 ? `${fileCount} files touched (>= 8)` : 'High-risk quantitative or security domain keywords detected',
				'Routes to Full Adversarial group with empirical challenger and red-team fuzzing',
			],
			config: PATH_CONFIGS[PATHS.ADVERSARIAL_QUANT],
		};
	}

	// 4. SWE light triggers (single file or quick fix)
	const lowRiskKeywords = ['fix', 'typo', 'small', 'unit test', 'tweak', 'quick', 'add test', 'lint', 'cheap'];
	if ((fileCount <= 2 && lowRiskKeywords.some((k) => text.includes(k))) || fileCount === 1) {
		return {
			path: PATHS.SWE_LIGHT,
			confidence: 0.85,
			reasons: [
				fileCount <= 2 ? `Narrow blast radius (${fileCount || 1} file(s))` : 'Low blast radius bugfix/tweak',
				'Routes to SWE Light: skips decomposition, direct implementer-reviewer loop to conserve tokens',
			],
			config: PATH_CONFIGS[PATHS.SWE_LIGHT],
		};
	}

	// 5. Default General SWE path
	return {
		path: PATHS.GENERAL,
		confidence: 0.8,
		reasons: [
			`${fileCount || 'Multiple'} files across repository`,
			'Routes to General SWE: structured milestones with test-writer and independent auditor verification',
		],
		config: PATH_CONFIGS[PATHS.GENERAL],
	};
}

/**
 * Recommend an operational tier based on task characteristics (backward compatible).
 */
export function recommendTier(input = {}) {
	const pathRec = recommendPath(input);

	if (pathRec.path === PATHS.SWE_LIGHT) {
		return {
			tier: TIERS.L1_AGILE,
			confidence: pathRec.confidence,
			reasons: pathRec.reasons,
			config: TIER_CONFIGS[TIERS.L1_AGILE],
		};
	}

	if (pathRec.path === PATHS.ADVERSARIAL_QUANT || pathRec.path === PATHS.MATH_PROOF) {
		return {
			tier: TIERS.L3_ADVERSARIAL,
			confidence: pathRec.confidence,
			reasons: pathRec.reasons,
			config: TIER_CONFIGS[TIERS.L3_ADVERSARIAL],
		};
	}

	return {
		tier: TIERS.L2_STANDARD,
		confidence: pathRec.confidence,
		reasons: pathRec.reasons,
		config: TIER_CONFIGS[TIERS.L2_STANDARD],
	};
}
