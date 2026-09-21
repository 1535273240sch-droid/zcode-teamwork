# Teamwork for ZCode

> 模型的「我做完了」不算证据。这个插件把验证变成物理约束。

> ### ✅ 已在真机验证（ZCode 3.14.1 / Windows 10）
> 核心机制确认有效：状态文件声称完成、但没有验证记录时，**Stop 钩子会拦住本轮收尾**，
> 门禁文本在模型上下文中累积注入，**模型被拉回来继续工作**。
> 期间发现 **9 个缺陷**（808 个单元测试一个都没抓到），全部修复并复验。
>
> 首次使用必读 [测试指南](docs/测试指南.md)。装上后最关键的一步是**批准钩子信任**
> —— ZCode 有信任闸门，未批准前钩子不执行，装了会跟没装一样。

---

## 它凭什么算约束，而不是提醒

**钩子不是提示词。**

提示词是劝告，模型可以合理化绕过。钩子是进程级的拒绝——**代码不允许，就没法继续**。

| 情况 | 结果 |
| --- | --- |
| 状态说某里程碑完成了，磁盘上没有验证记录 | **本轮收尾被拦住** |
| 派发次数超过预算 | **调用被拒** |
| 写了不属于自己的文件 | **调用被拒** |

这不是「提醒得更严」，是性质不同。

---

## 为什么值得信这一句

大多数同类项目都在宣称能做到上面这些。

**区别在于：我们验证过它是否真的在运行。**

这个插件在 **808 个单元测试全绿**的时候，在真机上**完全哑火**——一行强制都没生效。

原因全是**静默失败**，不报错、不提示：

| # | 缺陷 | 后果 |
| --- | --- | --- |
| 1 | 钩子等 `'execution'`，引擎写 `'approved'` | **所有钩子全失效** |
| 2 | `Stop` 用了 `stopReason`（只供显示） | **门禁完全哑火** |
| 3 | 钩子读 `plan.json`，引擎写 `campaign.json` | 门禁静默放行 |
| 4 | 真机工具名是 `Agent`，代码写的是 `Task` | **派发预算完全不跑** |
| 5 | 并发派发时序竞态（57ms 窗口） | 一批可突破预算 |
| 6 | 批准后重新规划绕过审批 | 批准形同虚设 |
| 7 | 测试与 CI：三个套件从未在 CI 跑过 + Windows 路径断言 | 「全绿」是假象 |
| 8 | `PostToolUseFailure` 从不触发 | 失败不可见 |
| 9 | `cwd` 读法不一致、无环境变量兜底 | 可能全部失效 |

**9 个，全部由真机验证发现，全部已修复并复验。**

这才是这个项目真正的产出。不是「我们做了个编排框架」，是**「我们知道这类框架会在哪里悄悄死掉」**。

---

## 已验证 vs 未验证

**真机验证过：**

- ✅ `Stop` 门禁拦住收尾 → 门禁文本累积注入 → **模型被拉回继续工作 11+ 步**
- ✅ 派发预算拦住并发调用（同回合两个 `Agent` 相隔 71ms，第二个被拒）
- ✅ 文件独占拒绝越界写入，文件确实没被创建
- ✅ 审计留痕落盘，含失败标记
- ✅ 上下文注入送达模型

**还没做：跑一轮完整真实任务。** 上面全是定向机制测试，不是让 8 个角色真干一个活。

**这条我没法替你验证——需要一次真跑。** 首次任务见 [docs/首个任务.md](docs/首个任务.md)。

---

## 什么时候用

**三个问题都是「是」才用：**

1. **做错了要我付出实际代价吗？**（返工、事故、被人追问）
2. **「做完了」能用一个命令或一份证据证明吗？**
3. **值得花比平常多 10~100 倍的 token 吗？**

**适合**：修 bug 并证明修好 · 重构/迁移（改几百处调用点）· 给老代码补测试 ·
上线前审计 · 写规格书 · 验证结论对不对

**别用**：问个问题查个资料 · 改一行代码 · 探索「这东西能干嘛」 ·
时间紧错了也无所谓 · 需求还在变

---

> ### ⚠️ 这东西**非常耗 token**
> 成本通常是单 agent 的 **1~2 个数量级**。它是**用钱换确定性**，不是「更快地写代码」。
> 小改动、加注释、一次性问答——**直接用普通方式做，派团队成本是它的百倍，收益为零。**
> 用它之前先定预算；**目标写具体、验收标准写到能验**，是最有效的省钱手段。

---

## 已知限制（平台给的，不是偷懒）

| 限制 | 原因 |
| --- | --- |
| **并发写相邻文件时独占不可靠** | 子代理载荷里没有 per-subagent 标识（无 `agent_id`、无 `agent_type`），同会话多个 Worker 会解析成**同一个 owner**。独占**不是弱化，是不存在**。要并发就**串行派 Worker** |
| **没有 dead-man 计时器** | 进程钩子握不住时钟，停滞只能在用户回合报告 |
| **7 个官方事件真机可达 6 个** | `PostToolUseFailure` 不可达，失败走 `PostToolUse` + `tool_response.status` |
| **`Stop` 只在完整 turn 收口时触发** | 多轮工具交互（如访谈流）中途不会触发 |
| **引擎不驱动会话** | 只有模型能开子代理，规则在**被调用时**强制，不是持续监控 |

---

## 解决什么问题

```
agent 说"做完了" → 你问"验证了吗" → "验证了" → 你一跑 → 挂了
```

**根因不是模型不诚实，是结构问题**：让写代码的 agent 检查自己的代码，等于同一份判断重复两遍，会用同一套错误假设看第二遍。

Teamwork 强制把「做」和「验」分开：

> 🔒 **一个里程碑，在没有参与实现它的 agent 验证之前，不算完成。**

而且这条规矩**有落盘证据**：验证结论写入 `.teamwork/verifications/<里程碑>.md`，终审写入 `.teamwork/final-audit.md`。"验没验"不再是一句承诺。

## 八个角色（职责刻意不重叠）

| 角色 | 职责 |
| --- | --- |
| 🧭 **Orchestrator** | 拆里程碑、出依赖图、分配文件所有权 |
| 🧗 **Explorer** | 探索调研 |
| 🔧 **Worker** | 干活实现 |
| 🛡️ **Sentinel** | 开工前审宪章，返回 `CLEARED` / `BLOCKED` |
| 🔍 **Critic** | 批判挑刺 |
| 🎯 **Challenger** | 挑战质疑，专门找漏洞 |
| ✅ **Auditor** | 审计留痕，查证据真伪 |
| 🏆 **Success-Auditor** | 对着最初的宪章做终审，防指标漂移 |

## 机制

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
node $CLI decompose && node $CLI plan --milestones m.json
node $CLI approve                      # 批准（此时才允许执行）
node $CLI schedule
node $CLI isolation --prepare ws1      # 为工作流建立隔离
node $CLI can-write --file src/a.ts --milestone m1
node $CLI verify --milestone m1 --verdicts v.json
node $CLI status
node $CLI stale
node $CLI succession                   # 预算将尽时是否该写简报
node $CLI handoff
```

> **引擎不驱动会话。** 它是一组被调用的服务：平台决定了只有模型能开子代理，进程钩子也握不住计时器。所以规则在**被调用时**强制，而不是持续监控——**引擎做判断，钩子做监视**。

**强制**（全部由钩子代码执行，不靠自觉）

| 钩子 | 事件 | 作用 |
| --- | --- | --- |
| `ownership-lock` | PreToolUse | 文件独占，编辑工具越界即拒 ⚠️ 见已知限制 |
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

---

## 安装

在 ZCode 里打开任意项目 → **Settings → Plugins → Create → Add marketplace**，填：

```
1535273240sch-droid/zcode-teamwork
```

在 **Personal** 分区找到 `teamwork` → **Install** → 打开开关。

> 也可以填本地克隆路径（本地目录不需要联网）。

> ⚠️ **装完必须开新会话。** ZCode 的钩子配置是会话启动时快照的，当前会话不会热加载。

> 🔐 **首次需确认信任钩子。** ZCode 对工作区钩子有信任闸门（`workspace_hooks_pending_trust`），
> 未批准前钩子不执行。若发现装了却「没反应」，去钩子信任提示里批准一次即可。
> 这是平台安全机制，不是插件故障。

---

## 使用流程

```bash
/teamwork 把 utils 里的日期解析函数补一组边界测试
```

1. **访谈** — 交互式问答分几批问清：目标 / 约束 / 独立验证方式 / 验收标准 / 工作目录
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
  lib/                     # 编排引擎（10 个模块：控制面 / 状态机 / 归属 / 验证 / 日志 / 交接 / 隔离 / 路径 / 拆解 / 调度 / CLI）
  skills/                  # 访谈与执行协议
plugins/hook-probe/        # 开发者工具：记录所有钩子事件（排查用，日常不必装）
tests/                     # 808 项：结构校验 + 钩子行为 + 计划库 + 引擎 + 路径与隔离
docs/机制说明.md            # 深入机制
docs/测试指南.md            # 真机验证实测结论（含 4 轮验证记录）
docs/首个任务.md            # 第一次使用的安全任务
docs/执行书.md              # 交给 AI 的验证指令
```

## 开发与测试

```bash
npm test    # 结构校验 + 钩子行为 + 计划库 + 引擎 + 路径
```

## 许可

见 [LICENSE](LICENSE)。
