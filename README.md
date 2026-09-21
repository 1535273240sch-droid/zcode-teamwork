# Teamwork for ZCode

> 给 ZCode 的多智能体协作框架：**先访谈把目标定死，再派一支八个角色的队伍，做与验强制分离。**

> ### ⚠️ 首次使用请先读 [测试指南](docs/测试指南.md)
> **本项目代码从未在真实 ZCode 里加载过。** 742 个测试全绿，但验证的是代码内部的假设，不是平台的实际行为。
> 装上后最关键的一步是**批准钩子信任**（ZCode 有信任闸门，未批准前钩子不执行，装了会跟没装一样）。

---

> ### ⚠️ 先说清楚：这东西**非常耗 token**
> 成本通常是单 agent 的 **1~2 个数量级**。它是**用钱换确定性**，不是"更快地写代码"。
> 小改动、加注释、一次性问答——**直接用普通方式做，派团队成本是它的百倍，收益为零。**
> 用它之前先定预算；**目标写具体、验收标准写到能验**，是最有效的省钱手段。

---

## 解决什么问题

```
agent 说"做完了" → 你问"验证了吗" → "验证了" → 你一跑 → 挂了
```

**根因不是模型不诚实，是结构问题**：让写代码的 agent 检查自己的代码，等于同一份判断重复两遍，会用同一套错误假设看第二遍。

Teamwork 强制把「做」和「验」分开：

> 🔒 **一个里程碑，在没有参与实现它的 agent 验证之前，不算完成。**

而且这条规矩**有落盘证据**：验证结论写入 `.teamwork/verifications/<里程碑>.md`，终审写入 `.teamwork/final-audit.md`，`/goal` 目标文本直接点名这两个文件。"验没验"不再是一句承诺。

## 八个角色（职责刻意不重叠）

| 角色 | 职责 |
| --- | --- |
| 🧭 **Orchestrator** | 拆里程碑、出依赖图、分配文件所有权 |
| 🧗 **Explorer** | 探索调研 |
| 🔧 **Worker** | 干活实现 |
| 🛡️ **Sentinel** | 开工前审宪章，返回 `CLEARED` / `BLOCKED` |
| 🔍 **Critic** | 批判挑刺 |
| 🎯 **Challenger** | 挑战质疑 |
| ✅ **Auditor** | 审计留痕 |
| 🏆 **Success-Auditor** | 对着最初的宪章做终审，防指标漂移 |

## 机制

**编排**

- **五种编排形态**：串行 / 并行 / 流水线 / 轮换 / 混合
- **三种完整性模式**：快速 / 标准 / 严格（默认 `development`）
- **拆解器** `lib/decompose.mjs`：目标 → 里程碑草稿（含验收标准、依赖链）。**是脚手架不是神谕**，Orchestrator 必须修正它。
- **调度器** `lib/scheduler.mjs`：依赖分批 + **共享文件检测** + 派发预算核算。两个里程碑点了同一个文件就不可能"并行"——这点在派发前查出来，比等 Worker 撞车便宜得多。
- **计划 CLI** `lib/plan-cli.mjs`：`draft` / `schedule` / `status` 三个视图，支持 `--json`。

**编排引擎**（`lib/` —— 可被调用的代码，不只是提示词）

| 模块 | 职责 |
| --- | --- |
| `engine.mjs` | 控制面：initProject / approve / createPlan / schedule / claim / verify / final / handoff / status |
| `state.mjs` | 版本化类型状态机，原子写，损坏文件返回 null 而非崩溃 |
| `ownership.mjs` | 文件独占：声明式归属 + 可续租租约，`expired` 与 `held` 分开报告 |
| `verification.mjs` | 按**影响面**决定验证人数；判定裁决（一票否决，自审不算） |
| `journal.mjs` | 追加式日志，撕裂行跳过，可折叠出摘要 |
| `handoff.mjs` | 停滞检测 + 会话交接 + **继任简报**（预算将尽时写给下一个会话） |
| `isolation.mjs` | 工作区隔离三层（worktree / 独立目录 / 共享）+ **按角色限制写权限** |
| `patterns.mjs` | 6 条执行路径（分布式编码 / 迭代编码 / 文档审阅 / 数学证明 / 自验证 / 研究）+ 计划合规校验 |
| `decompose.mjs` / `scheduler.mjs` | 目标→草稿；依赖分批 + 冲突检测 |
| `teamwork-cli.mjs` | 全部动词的命令行入口，`--json` 输出，拒绝时非零退出 |

```bash
CLI=plugins/teamwork/lib/teamwork-cli.mjs

node $CLI init --objective "..." [--force] [--pattern <id>]
node $CLI patterns                    # 列出 6 条执行路径
node $CLI pattern --suggest "..."      # 按目标推荐一条
node $CLI pattern --set <id>           # 在审批前切换
node $CLI decompose && node $CLI plan --milestones m.json
node $CLI approve
node $CLI schedule
node $CLI isolation --prepare ws1      # 为工作流建立隔离
node $CLI can-write --file src/a.ts --milestone m1
node $CLI verify --milestone m1 --verdicts v.json
node $CLI status
node $CLI stale
node $CLI succession                   # 预算将尽时是否该写简报
node $CLI briefing
node $CLI handoff
```

> **引擎不驱动会话。** 它是一组被调用的服务：平台决定了只有模型能开子代理，进程钩子也握不住计时器。所以规则在**被调用时**强制，而不是持续监控——**引擎做判断，钩子做监视**。

**强制**（全部由钩子代码执行，不靠自觉）

| 钩子 | 事件 | 作用 |
| --- | --- | --- |
| `ownership-lock` | PreToolUse | 文件独占，编辑工具越界即拒 |
| `bash-guard` | PreToolUse | shell 写入同样受独占约束 |
| `spawn-budget` | PreToolUse | **派发预算硬上限**（默认 16），到顶即拒 |
| `verification-gate` | **Stop** | 声称完成但无验证记录 → **拦住收尾** |
| `audit-log` | PostToolUse | 自动留痕到 `events.jsonl`，含文件/命令/派发 |
| `progress-watch` | UserPromptSubmit | 停滞检测 + 验证覆盖度提示 |
| `session-context` | SessionStart | 注入宪章与状态 |

**关掉某个机制**

| 机制 | 关闭方式 |
| --- | --- |
| 验证门禁 | `TEAMWORK_VERIFY_GATE=off` 或 `campaign.json: {"verificationGate": false}` |
| 派发预算 | `TEAMWORK_SPAWN_BUDGET=off` 或 `campaign.json: {"spawnBudget": 0}` |
| 进度看护 | `TEAMWORK_PROGRESS_WATCH=off` 或 `campaign.json: {"progressWatch": false}` |

> **诚实的边界**：钩子是一次性进程，**没有常驻计时器**。所以没有"静默 600 秒自动接管"这种 dead-man 开关——`progress-watch` 只能在下一个用户回合报告停滞。这比计时器弱，但是当前平台上能做到的最强形态。

---

## 环境要求

- **ZCode**（Z.ai）桌面版，需打开一个 workspace 才能管理插件
- **Node.js ≥ 18**（`node` 须在 PATH 上）
- 仅用 Node 内置模块，**无需 `npm install`**

## 安装

在 ZCode 里打开任意项目 → **Settings → Plugins → Create → Add marketplace**，填：

```
1535273240sch-droid/zcode-teamwork
```

在 **Personal** 分区找到 `teamwork` → **Install** → 打开开关。

> 也可以填本地克隆路径（本地目录不需要联网）。

> ⚠️ **装完必须开新会话。** ZCode 的钩子配置是会话启动时快照的，当前会话不会热加载。

> 🔐 **首次需确认信任钩子。** ZCode 对工作区钩子有信任闸门，插件钩子未获批前不执行。若发现装了却"没反应"，去钩子信任提示里批准一次即可。这是平台安全机制，不是插件故障。

## 使用流程

```bash
/teamwork 把 utils 里的日期解析函数补一组边界测试
```

1. **访谈** — 交互式问答分五批问清：目标 / 约束 / 独立验证方式 / 验收标准 / 工作目录
2. **关掉「提问自动继续」** — 设置 → 常规 → 提问自动继续（否则倒计时会自动放行批准关卡）
3. **批准** — 它推荐模式、写宪章到 `.teamwork/campaign.json`，然后**停下来等你批准**
4. **执行** — Sentinel 审宪章 → Orchestrator 出计划 → 设 `/goal` → Worker 开工
5. **终审** — Success-Auditor 对照最初宪章，写 `.teamwork/final-audit.md`

> 运行期间可用 `/teamwork-status` 查看进度、`/teamwork-end` 收尾。

---

## 仓库结构

```
plugins/teamwork/          # 插件本体
  agents/                  # 8 个角色定义
  commands/                # /teamwork、/teamwork-status、/teamwork-end
  hooks/                   # 7 个钩子（独占锁 / shell 守卫 / 上下文 / 门禁 / 留痕 / 预算 / 看护）
  lib/                     # 编排引擎（9 个模块：控制面 / 状态机 / 归属 / 验证 / 日志 / 交接 / 拆解 / 调度 / CLI）
  skills/                  # 访谈与执行协议
plugins/hook-probe/        # 开发者工具：记录所有钩子事件（排查用，日常不必装）
tests/                     # 578 项：结构校验 + 钩子行为 + 计划库 + 引擎与 CLI
docs/机制说明.md            # 深入机制（含旧版迁移）
```

## 开发与测试

```bash
npm test    # 结构校验 160 项 + 钩子行为 91 项
```

## 许可

见 [LICENSE](LICENSE)。
