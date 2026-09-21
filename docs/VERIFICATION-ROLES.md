# Teamwork 验证角色与协议规范 (v0.3.0)

Teamwork 的核心理念是：**做和验强制分离**。
让编写代码的 Worker 验证自己的代码，等于同一套（可能是错误的）假设验证第二遍。

---

## 1. 八大专职角色总览

| 角色 | 核心任务 | 是否可写代码 | 核心工具 | 适用阶段 |
|---|---|---|---|---|
| **Sentinel** | 战役起点关卡。审核宪章完备性，强制执行完整性模式 | 否 (只读) | Read, Grep, Glob | Phase 1 之后，开工前 |
| **Orchestrator** | 计划拆解。里程碑依赖图、风险评级、文件独占分配 | 否 | Read, Grep, Glob, TodoWrite | Sentinel CLEARED 之后 |
| **Explorer** | 代码库调研。绘制调用链、定位文件、收集证据 | 否 (只读) | Read, Grep, Glob, Web | 任意需要只读证据阶段 |
| **Worker** | 实现具体里程碑。在独占文件范围内编码和测试 | **是** | Read, Grep, Glob, Edit, Write, Bash | Phase 2 实现阶段 |
| **Critic** | 代码实现审查。攻击实现代码，寻找边界条件与缺陷 | 否 (只读) | Read, Grep, Glob, Bash | Worker 报告后 |
| **Challenger** | 论断证伪。攻击基准前提、度量口径、假设偏差 | 否 (只读) | Read, Grep, Glob, Bash, Web | 方案与量化论断阶段 |
| **Auditor** | 独立复现。从干净状态独立重跑证明命令，核验真实性 | 否 (只读) | Read, Grep, Glob, Bash | 里程碑验收阶段 |
| **Success Auditor** | 战役终审。对照宪章终审，防目标漂移与指标套利 | 否 (只读) | Read, Grep, Glob, Bash | 全部里程碑完成之后 |

---

## 2. 四大验证角色的职责与分工

普通子 agent 模式常被称为"自我验证"，实质是无意义的同语反复。Teamwork 将验证拆为四个完全不同方向的问题：

### 1. Critic (实现代码错了吗？)
- 攻击对象：**实现代码**。
- 重点检查：边界输入、空值、超大输入、错误捕获是否静默吞掉异常、文件句柄与资源泄漏、契约变更。
- 输出要求：结论只能是 `SOUND` 或 `DEFECTS_FOUND`。
- 记录命令：`teamwork.mjs verify --milestone <id> --role critic --verdict <verdict> --evidence <ids>`

### 2. Challenger (前提成立吗？)
- 攻击对象：**度量前提与因果假设**。
- 重点检查：量化的指标是否代表真实现象、测试数据是否存在幸存者偏差、基准测试是否挑了最容易通过的场景、参数是否事后调优。
- 输出要求：结论只能是 `SURVIVED`, `FALSIFIED` 或 `UNFALSIFIABLE`。
- 记录命令：`teamwork.mjs verify --milestone <id> --role challenger --verdict <verdict> --evidence <ids>`

### 3. Auditor (证据是真的吗？)
- 攻击对象：**声称的测试与命令输出**。
- 重点检查：**不采信 Worker 粘贴的输出**，在全新干净环境独立重跑命令；逐字符比对实际输出与声称输出；验证测试是否"有牙"（反向改动代码测试是否会挂）。
- 输出要求：结论只能是 `REPRODUCED`, `DIVERGED` 或 `BLOCKED`。
- 记录命令：`teamwork.mjs verify --milestone <id> --role auditor --verdict <verdict> --evidence <ids>`

### 4. Success Auditor (当初要的东西做到了吗？)
- 攻击对象：**战役终审结果**。
- 重点检查：对照最初的宪章（而不是里程碑清单）逐条审核；抓出"指标漂移"（用可测的指标替代了真实目标）；查出悄悄缩水的范围。
- 输出要求：结论只能是 `ACHIEVED`, `PARTIALLY ACHIEVED` 或 `NOT ACHIEVED`。
- 记录命令：`teamwork.mjs final-audit --verdict <verdict> --evidence <ids>`

---

## 3. 风险自适应验证组合规则 (T10)

在 `.teamwork/plan.json` 中，每个里程碑可配置 `risk` 级别：

- `low`（低风险）：至少需要 `critic` 验证；
- `medium`（中风险）：至少需要 `critic` + `auditor` 验证；
- `high`（高风险）：至少需要 `critic` + `auditor` + `challenger` 联合验证。

当 `risk` 存在时，`teamwork.mjs gate` 会在 G10 规则中强制校验验证者是否覆盖最低角色组合。

---

## 4. 模型分层建议与当前局限

在实际工程中，建议按角色进行模型分层：
- **执行角色**（Worker、Explorer）：可采用快速高效的模型（如 Gemini 2.0 Flash / GPT-4o-mini）；
- **质检与决策角色**（Sentinel、Critic、Challenger、Auditor、Success Auditor）：建议采用高推理能力模型（如 Gemini 2.0 Pro / Claude 3.5 Sonnet / o1 / o3-mini）。

> **平台局限说明**：
> 目前 ZCode 平台尚未提供插件维度的全局多模型映射接口。如果需要模型分层，用户需在 `plugins/teamwork/agents/<role>.md` 的 frontmatter 中手动配置 `model: "..."`，或由主会话 Agent 动态指定。
