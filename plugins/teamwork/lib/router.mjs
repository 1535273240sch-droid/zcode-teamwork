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
		title: 'SWE Light (单文件极速快修路径)',
		summary: '零冗余开销。单实现者配合审校者对决，反拆分铁律。',
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
		title: 'General (通用大型软件工程路径)',
		summary: '标准仓库级工程重构，配备里程碑 DAG 拓扑、独立测试编写与审计复测。',
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
		title: 'Document Review (文档与规范锦标赛评审路径)',
		summary: '针对论文、RFC、白皮书与技术规范，采用递归自聚合 (RSA) 树分段评审。',
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
		title: 'Math & Proof (数学推导与形式化证明路径)',
		summary: 'Colosseum 多阶段流水线，针对数理逻辑与定理推导进行严苛无死角查漏。',
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
		title: 'Adversarial Quant (量化金融与极限红队对抗路径)',
		summary: '顶级严格防御。覆盖量化回测、交易 Alpha、安全漏洞挖掘与混沌模糊测试。',
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
		title: 'L1 极速双人组 (Worker + Critic)',
		summary: '零冗余流程。专为单文件 Bugfix、轻量组件开发设计。',
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
		title: 'L2 标准战术组 (Orchestrator + Worker + Auditor + Critic)',
		summary: '结构化里程碑、独立真机复测与排他文件所有权保障。',
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
		title: 'L3 重装对抗组 (11 角色全武装)',
		summary: '全量最高防御。量化对冲、定理推导、红队模糊测试、核心协议升级。',
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
			reasons: ['检测到论文、RFC、白皮书或技术规范评审任务', '自动路由至基于递归自聚合 (RSA) 锦标赛树的文档审查流水线'],
			config: PATH_CONFIGS[PATHS.DOCUMENT_REVIEW],
		};
	}

	// 2. Math proof triggers
	if (/(theorem|lemma|formal proof|derivation|colosseum|mathematical logic)/.test(text)) {
		return {
			path: PATHS.MATH_PROOF,
			confidence: 0.95,
			reasons: ['检测到数学推导、引理定理证明或形式化逻辑推演任务', '自动路由至 Colosseum 多阶段严格证明验证流水线'],
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
				fileCount >= 8 ? `触碰文件过多 (${fileCount} 个文件 >= 8)` : '检测到高危量化金融、交易算法、安全漏洞挖掘或红队对抗关键词',
				'激活全部 11 角色重装对抗群组，引入混沌模糊测试与经验证伪',
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
				fileCount <= 2 ? `影响范围极窄 (${fileCount || 1} 个文件)` : '低爆炸半径 Bugfix / 轻量微调任务',
				'路由至 SWE Light 极速通道：反拆分铁律，单一实现者配合审校者快速对决闭环，节省 80%+ Token',
			],
			config: PATH_CONFIGS[PATHS.SWE_LIGHT],
		};
	}

	// 5. Default General SWE path
	return {
		path: PATHS.GENERAL,
		confidence: 0.8,
		reasons: [
			`跨代码库多个模块改动 (${fileCount || '多'} 个文件)`,
			'路由至通用大型软件工程通道：里程碑 DAG 结构化拆解，配备独立测试编写者与真机复测审计员',
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
