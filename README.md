# Teamwork for ZCode

**给 ZCode 用的多智能体协作框架**——先访谈把目标定死，再派一支八个角色的队伍，用文件独占锁避免互相踩踏，用互相独立的验证角色逼出真话。

> ## 🔴 先说最重要的一件事：这东西**非常耗 token**
>
> Teamwork 的成本通常是单 agent 的**一到两个数量级**。它不是"更快地写代码"，它是**用钱换确定性**。
>
> **小项目不要用。** 单文件修复、小改动、加个注释、几分钟能做完的事、一次性问答——**直接用普通方式做。派团队的成本是它的一百倍，收益是零。**
>
> 参考量级：Google 那个 93 个 subagent「从零造操作系统」的演示，烧掉大约 **26 亿 token**（含缓存读取）。把它当上限的形状看，别当模板。
>
> 用它之前先定预算。**目标写具体、验收标准写到能验，是最有效的省钱手段**——它避免的是最贵的那种浪费：跑三小时才发现目标没定义。

---

## 目录

- [这个项目是做什么的](#这个项目是做什么的)
- [和普通子 agent 有什么区别](#和普通子-agent-有什么区别)
- [能帮你干什么](#能帮你干什么)
- [仓库结构](#仓库结构)
- [环境要求](#环境要求)
- [安装](#安装)
- [更新到新版本](#更新到新版本)
- [安装后验证](#安装后验证)
- [使用流程](#使用流程)
- [验证留痕](#验证留痕)
- [八个角色](#八个角色)
- [五种编排形态](#五种编排形态)
- [三种完整性模式](#三种完整性模式)
- [文件独占锁](#文件独占锁)
- [宪章字段说明](#宪章字段说明)
- [成本](#成本)
- [已知限制](#已知限制)
- [排错](#排错)
- [命名与版本](#命名与版本)
- [设计说明](#设计说明)
- [开发与测试](#开发与测试)
- [许可](#许可)

---

## 这个项目是做什么的

它是一个 **ZCode 插件**，通过 **marketplace** 分发。

一句话：**它把「派一个 agent 去干活」变成「建一支团队，并规定它怎么协作」。**

它给 ZCode 补上三样东西：

| 补什么 | 靠什么 |
|---|---|
| **开工前把目标定死** | Phase 1 访谈（`/teamwork` 命令 + skill），产出可审阅的宪章，**你批准了才动** |
| **角色分工 + 独立验证** | 8 个自定义 subagent，职责刻意不重叠，**做和验强制分离** |
| **并行时不互相踩踏** | 两个 `PreToolUse` 钩子实现的文件独占锁，编辑工具和 shell 写入都拦 |

它要解决的具体问题是这一种：

```
agent 说"做完了" → 你问"验证了吗" → "验证了" → 你实际一跑 → 挂了
```

**根因不是模型不诚实，是结构问题**：让写代码的那个 agent 去检查自己写的代码，等于同一份判断重复两遍。它会用同一套（可能是错误的）假设看第二遍，然后确认没问题。

Teamwork 的结构强制把"做"和"验"分开，规矩很硬：

> **一个里程碑，在没有参与实现它的 agent 验证之前，不算完成。**

而且从 0.2.0 起，这条规矩**有落盘证据**：验证角色必须把结论写进 `.teamwork/verifications/<里程碑>.md`，终审写进 `.teamwork/final-audit.md`，`/goal` 的目标文本直接点名这两个文件。于是"验没验"不再是一句承诺，而是运行时每轮都要查的东西。见[验证留痕](#验证留痕)。

验证循环本身**没有重写**——那是 ZCode 自带的 **Goal Mode** 干的活，比用 `Stop` 钩子硬凑要可靠。见[设计说明](#设计说明)。

---

## 和普通子 agent 有什么区别

ZCode 自带 `general-purpose` 和 `Explore` 两个子 agent，你也能自己建。**它们和 Teamwork 不是一个层面的东西。**

前者是「**派个人去干活**」；后者是「**建一个团队，并规定它怎么协作**」。

### 普通子 agent 的工作方式

主 agent 觉得需要，就派一个子 agent 去干一件事，拿回一个结果。沿路这些事没人管：

- 谁派活、派什么、派几个，是主 agent **临场决定**的，没有约束
- 子 agent 之间**互相不知道对方存在**
- 两个子 agent 可能**同时改同一个文件**，谁也不知道，直到合并时才炸
- 子 agent 说"做完了"，**没有人独立检查**
- 干到一半上下文丢了，重开一个就**忘了目标是什么**

Teamwork 把上面每一条都变成有结构的：

| | 普通子 agent | **Teamwork** |
|---|---|---|
| **开工前** | 直接开干 | **先访谈 → 写宪章 → 人批准了才动** |
| **分工** | 通用 agent 什么都干 | **8 个专职角色，职责刻意不重叠** |
| **验证** | 谁做的谁报结果 | **做和验强制分离**，且拆成四种不同问法 |
| **验证证据** | 报告里的一句话 | **落盘成文件，`/goal` 每轮检查它在不在** |
| **并行** | 可能撞同一个文件 | **文件独占锁，编辑工具与 shell 写入都拦** |
| **目标漂移** | 跑久了就忘了要干嘛 | **宪章 + 计划在每次会话启动时重新注入** |
| **收敛** | 你得一直打"继续" | Goal Mode **每轮自动验证、自动继续** |
| **什么时候算完** | agent 说"做完了" | **Success Auditor 对着宪章终审** |
| **成本** | 低 | **高一个到两个数量级** |

### 最关键的区别：四个验证角色是分开的

普通子 agent 是「一个 agent 干完，回报结果」——这叫**自我验证**，等于同一份判断的第二遍。

Teamwork 把"验"拆成**四个不同的问题**，交给**四个不同的角色**：

| 角色 | 问的问题 | 专门抓什么 |
|---|---|---|
| **Critic** | 这段代码**实现**错了吗？ | 边界输入、异常路径、资源泄漏、**静默返回一个看起来对的错答案** |
| **Challenger** | 这个**前提**成立吗？ | 度量的东西是不是那个东西、基线是不是挑软的打、参数是不是看了结果才定的 |
| **Auditor** | 这个**证据**是真的吗？ | 从干净状态自己重跑一遍；而且**这个检查在东西坏掉时会不会真的失败** |
| **Success Auditor** | 当初要的**东西**，真的做到了吗？ | 指标漂移——把可测的当成了目标，原目标悄悄溜走 |

**四个问题少一个都会漏。** Critic 通过不代表前提成立；前提成立不代表证据可复现；全都对，也不代表做的是当初要的那件事。

举个具体的：一个量化策略回测出高收益。

- Critic 会查代码有没有 bug
- **Challenger 会去查这收益是不是来自未来函数、是不是在测试集上调参、基线是不是挑了个弱的**
- Auditor 会自己重跑一遍，看数字对不对得上
- Success Auditor 会问：当初要的是一个能上实盘的策略，还是只是一个漂亮的回测数字？

**普通子 agent 只会给你最后那个数字。**

---

## 与 Google Antigravity `/teamwork-preview` 的异同对比

Teamwork for ZCode 深受 Google Antigravity `/teamwork-preview` 设计的启发，但在 ZCode 的平台能力和架构现实下进行了针对性的实现：

| 维度 | Google Antigravity `/teamwork-preview` | Teamwork for ZCode (v0.3.0) |
|---|---|---|
| **执行环境** | 原生多进程 / 容器隔离 | 单进程 / 扁平化 Subagent（跨平台目录互斥锁协调） |
| **文件独占** | 操作系统级只读/读写挂载 | `PreToolUse` (Write\|Edit + Bash) 钩子拦截租约冲突 |
| **证据产生** | 运行时强制捕获命令 stdout/stderr | `teamwork.mjs run -- <cmd>` 产生结构化日志与 SHA-256 哈希链 |
| **批准机制** | 平台原生 UI 批准关卡 | `UserPromptSubmit` 钩子拦截 `/teamwork-approve`，绑定 `charterHash` |
| **身份归属** | 原生注入 Subagent ID | 尝试提取多来源 ID；若不可辨别自动降级为串行（`mode.json`）并配合事后 Git 所有权审计（R1-R3） |
| **完成判定** | 内部 Goal Mode 综合判定 | `teamwork.mjs gate` 汇聚 12 项确定性检查（G1-G12）作为 Goal Mode 实据 |
| **模型分层** | 官方直接支持 Flash / Pro 混用 | 角色提示词建议分层；用户可在各角色 frontmatter 中自主配置 `model` |
| **历史隔离** | 每次沙箱完全重建 | 自动移出工作区至 `~/.teamwork-archive/`，`benchmark` 模式下防御读取历史 |

---

## 📚 深入架构与专题文档

为了保持主 README 简洁，详细规范与机制已拆分至 `docs/` 目录：

- 🛠️ [系统架构、锁协议与哈希链设计 (docs/ARCHITECTURE.md)](docs/ARCHITECTURE.md)
- 👥 [八大角色职责与验证协议 (docs/VERIFICATION-ROLES.md)](docs/VERIFICATION-ROLES.md)
- 🛡️ [基准评测模式与防作弊机制 (docs/BENCHMARK-MODE.md)](docs/BENCHMARK-MODE.md)
- 🗺️ [项目路线图与已知局限 (docs/ROADMAP.md)](docs/ROADMAP.md)

---

## 能帮你干什么

### ✅ 适合用

- **跨几十个文件的重构 / 迁移**——这是它的主场。Orchestrator 拆里程碑 + 分配文件所有权，Worker 并行开工不打架。
- **需要独立验证的结论**——量化策略、实验结果、研究结论。**Challenger 专门负责证伪**，这是它最值钱的地方。
- **反复失败的任务**——单个 agent 一遍遍自信地说"做完了"但实际没做完。**这是最典型的适用信号。**
- **长周期任务**——几小时到几天。Goal Mode 跨会话记住目标，计划落盘，你不用守着。
- **你没法亲自验证的东西**——你自己不熟悉细节，只能依赖它的报告。**这种情况必须有独立验证**，否则你就是在信一句没法核对的话。

### ❌ 不适合（请直接用普通方式做）

- **单文件修复、小改动、加个注释**——成本是它的一百倍，收益是零
- **一次性问答**——没有"完成"这个概念，团队无从下手
- **必须几分钟出结果的事**
- **成本需要可预测的任务**——Teamwork 的成本天然不可预测
- **你自己能一眼验证的事**——你亲自看一眼，比派八个 agent 便宜得多

一句话判断标准：

> **如果答错的代价，明显高于派团队的成本，才用它。**

---

## 仓库结构

```
.
├── marketplace.json              ← 市场清单（ZCode 从这里读）
├── package.json
├── CHANGELOG.md
├── LICENSE
├── README.md
├── .github/workflows/test.yml    ← CI：Node 18/20/22 × Linux/macOS/Windows
├── examples/                     ← 真实战役轨迹（见下方说明）
├── tests/                        ← 251 项自动化校验
│   ├── frontmatter.test.mjs      ← 160 项结构校验
│   └── hooks.test.mjs            ← 91 项行为校验
└── plugins/teamwork/             ← 插件本体
    ├── .zcode-plugin/plugin.json ← 插件清单
    ├── agents/                   ← 八个角色
    │   ├── sentinel.md
    │   ├── orchestrator.md
    │   ├── explorer.md
    │   ├── worker.md
    │   ├── critic.md
    │   ├── challenger.md
    │   ├── auditor.md
    │   └── success-auditor.md
    ├── hooks/
    │   ├── hooks.json            ← 钩子注册（自动发现，勿在清单重复声明）
    │   ├── _lib.mjs              ← 两个所有权钩子共用的锁/租约/路径逻辑
    │   ├── ownership-lock.mjs    ← 文件独占锁（Edit / Write）
    │   ├── bash-guard.mjs        ← shell 写入守卫（Bash）
    │   └── session-context.mjs   ← 会话启动时注入宪章与计划
    ├── skills/
    │   ├── teamwork/SKILL.md     ← Phase 1：Specify What, Not How
    │   └── teamwork-execute/SKILL.md ← Phase 2：调度循环与升级协议
    └── commands/
        ├── teamwork.md           ← /teamwork <目标>
        ├── teamwork-status.md    ← /teamwork-status
        └── teamwork-end.md       ← /teamwork-end
```

> `_lib.mjs` 不是可选的：`ownership-lock.mjs` 和 `bash-guard.mjs` **必须共用同一把互斥锁、同一份租约表、同一套路径规范化**。两边一旦分叉，它们合起来才堵上的那个洞就会重新打开。

---

## 环境要求

- **ZCode**（Z.ai）桌面版，需要一个已打开的 workspace 才能管理插件
- **Node.js ≥ 18**（钩子脚本用 node 跑；`node` 必须在 PATH 上）
- 仅用 Node 内置模块，**无需 `npm install`**

---

## 安装

### 方式一：GitHub marketplace（推荐）

在 ZCode 里**打开任意一个项目**（不开 workspace 的话，插件页会提示 `Open a workspace to manage plugins`），然后：

**Settings → Plugins → 右上角 Create → Add marketplace**，填：

```
1535273240sch-droid/teamwork-
```

在 **Personal** 分区里找到 `teamwork` → **Install** → 打开开关。

### 方式二：本地目录

**Settings → Plugins → Create → Add marketplace**，填本地路径（也可以直接把文件夹拖进去）：

```
<你克隆下来的路径>/teamwork-
```

> ⚠️ 注意目录名末尾**有一个连字符**（仓库就叫 `teamwork-`），写成本文的 `<路径>/zcode-teamwork` 是装不上的。见[命名与版本](#命名与版本)。

本地目录**不需要联网**。ZCode 那个公共插件目录才是从 GitHub 拉的，网络不通不影响你。

### ⚠️ 装完必须开新会话

**这是最容易踩的坑。** ZCode 的钩子配置是**会话启动时快照**的，当前开着的会话不会热加载。改配置、开关插件之后，都要**开新会话**才生效。

---

## 更新到新版本

> ### ⚠️ 先检查一件事：你装过 0.1.0 的「用户级散装」版本吗？
>
> 0.1.0 时代的文档教的是把角色/skill/命令/钩子**散装到 `~/.zcode/` 下**，并把钩子注册进 `~/.zcode/cli/config.json`。**那套东西如果还在，插件装了也不生效。**
>
> 因为 ZCode 的钩子执行顺序是 **user Hook → 已启用插件 Hook**：旧版那个**没有互斥锁、没有批准门**的 `ownership-lock.mjs` 会**先于**插件的新钩子运行，于是 0.2.0 修的并发竞态和批准门会**原样复现**，两套钩子还会共用同一份租约表互相打架。
>
> 自查：`~/.zcode/hooks/` 是否为空、`~/.zcode/agents/` 里是否还有那八个角色、`cli/config.json` 里搜不搜得到 `teamwork`。三项只要中一项，就先按 [docs/机制说明.md](docs/机制说明.md#️-从旧版用户级安装迁移过来必读) 的迁移步骤清理。
>
> 如果你从没装过 0.1.0，跳过这段。

装好之后想升级，**四步**，顺序不能乱：

**1. 先刷新市场源。**
点 **设置 → 插件**，搜索框上方那个**齿轮图标** → **市场源** 面板 → 找到这个市场 → **刷新该市场**。

> 这一步不能省。ZCode 检查更新用的是**本地缓存的市场清单**，不先刷新，它比对的还是旧版本号，会告诉你「已是最新」。

**2. 检查更新。**
同一页面点 **管理已安装**（或搜索框下方「已安装」图标带右侧的齿轮）→ 右上角 **检查更新**。有新版本的插件会带上标记。

**3. 更新 teamwork。**
点插件条目进详情页，底部有更新入口。

**4. 开新会话。**（和首次安装一样，不能省）
钩子配置是会话启动时快照的。0.2.0 改动了钩子注册（多了一个 `PreToolUse` / `Bash` 分组、`SessionStart` 的 matcher 换成了 `*`），**旧会话里这些改动一律不生效**——插件显示已更新，但锁还是旧行为。

### 为什么有时候不提示更新

版本号在**两个**地方，「最新版本」取自 `marketplace.json` 的 `version`，「已安装版本」取自插件自身的 `plugin.json`。**市场条目忘了升 `version`，代码更新了也不会提示。**

本仓库这两处由测试强制同步（`tests/frontmatter.test.mjs` 里有断言），所以正常不会踩到。如果你在改自己的插件，记住改版本要**改两处**。

### 更新后怎么确认生效

对着[安装后验证](#安装后验证)那三条重新核对一遍。0.3.0 之后应该是：

- 2 个 skills（`teamwork` + `teamwork-execute`）
- 4 个 commands（`/teamwork`、`/teamwork-approve`、`/teamwork-status`、`/teamwork-end`）
- **4 条 Hook**：`SessionStart`(`*`)、`UserPromptSubmit`(`.*`)、`PreToolUse`(`Write|Edit`)、`PreToolUse`(`Bash`)

**只要 `UserPromptSubmit` 或 `PreToolUse` 的 `Bash` 那条不在，就是没更新成功或者没开新会话。**

---

## 安装后验证

三个地方核对：

**1. Settings → Plugins → 点 teamwork**
应列出：8 个 agents、2 个 skills、4 个 commands、4 个 hook 脚本。

**2. Settings → Subagents**
应出现 **Plugin subagents** 分组，里面有 `sentinel` / `orchestrator` / `explorer` / `worker` / `critic` / `challenger` / `auditor` / `success-auditor`。

**3. Settings → Hooks**
应出现**四条只读**条目，来源都指向插件目录：

| 事件 | matcher | 作用 |
|---|---|---|
| `SessionStart` | `*` | 注入宪章、计划与跨轮知识 |
| `UserPromptSubmit` | `.*` | 用户批准关卡与宪章哈希绑定 |
| `PreToolUse` | `Write\|Edit` | 文件独占锁与保护路径防御 |
| `PreToolUse` | `Bash` | shell 写入守卫与基准归档隔离 |

四条都对了，就装好了。

---

## 使用流程

### 第 1 步：起一个 campaign

```
/teamwork 把 utils 里的日期解析函数补一组边界测试
```

### 第 2 步：回答访谈

它进入 **Phase 1（Specify What, Not How）**，**用交互式问答面板**（不是一坨纯文本问题）分五批问你：

| 议题 | 要问到什么程度 |
|---|---|
| **Scope & Objectives** | 达成什么**结果**，不是做什么**动作**。要可检查 |
| **Requirements** | 约束，以及**明确不做什么** |
| **Independent Verification** | 谁验、用什么命令、跟什么比 |
| **Acceptance Criteria** | 逐条可检查，每条绑一份证据 |
| **Project Working Directory** | 绝对路径 |

**这一步别糊弄。** 访谈问得越具体，后面烧的钱越少。特别是第 3 条——如果你答"跑一下测试"，等于没有验证标准，后面四个验证角色全部无从下手。

### ⚠️ 第 3 步之前：关掉「提问自动继续」

**这一条会直接吃掉你的批准关卡。**

ZCode 的问答面板默认带 **5 分钟倒计时**，到点没人回答，agent 会**按自己的判断挑一个方向继续推进**（历史记录里标为"未回答，已自动继续"）。而 Teamwork 的设计是「你批准之前绝不动工」——如果倒计时把批准问题自动放行了，这道关卡就形同虚设。

两个办法，任选其一：

- 到 **设置 → 常规 → 提问自动继续** 把它关掉（之后所有提问都会一直等你）
- 或者读到宪章时**把鼠标移到问答面板上**——任何动作都会让倒计时**永久停止**

（倒计时只作用于这类普通提问，**权限请求和计划审批本来就会一直等**，不受影响。）

### 第 4 步：它会推荐模式，然后等你批准

它会推荐一个 **integrity mode**（默认 `development`）和一个 **pattern**（五种编排形态之一），把宪章写到目标项目的 `.teamwork/campaign.json`，**然后停下来**。

**在你批准之前它不会派任何 agent，独占锁也还没武装**——钩子要求 `approved: true` 且 `phase: "execution"` 同时成立才生效。

### 第 5 步：批准之后

1. **Sentinel** 先审宪章，返回 `CLEARED` 或 `BLOCKED`
   - **BLOCKED 就是真卡住了**，它会列出缺什么。在起点被拦下来，比跑三小时才发现目标没定义便宜得多
2. **Orchestrator** 拆里程碑 + 出依赖图 + **分配文件所有权表**，并**写进 `.teamwork/plan.json`**
   - 这一步不是可选的。所有权表只活在对话里，会话一崩就没了——而这东西恰恰是并行 Worker 不打架的唯一依据
3. 它把目标设成 `/goal`，目标文本**点名验证文件**：
   ```
   /goal <objective> — 所有验收标准满足，
   且 .teamwork/verifications/ 下每个里程碑都有非实现者的验证记录，
   且 .teamwork/final-audit.md 的结论为 ACHIEVED
   ```
   之后 ZCode **每轮自动验证、自动继续**，你不用再打 "continue"。**没有终审文件，目标模式就不判定完成。**
4. Worker 开工；写文件撞车会被独占锁拦下

### 第 6 步：收尾

**Success Auditor** 对着**最初的宪章**（不是里程碑列表）做终审，写 `.teamwork/final-audit.md`，判断该做的到底做没做，专门防"指标漂移"。

### 运行期间的两个命令

| 命令 | 作用 |
|---|---|
| `/teamwork-status` | 只读报告：里程碑进度、当前租约、**验证缺口**、最近的冲突事件 |
| `/teamwork-end` | 归档到 `.teamwork/history/<时间戳>/` 并解除钩子（会先问你确认） |

### 顺手做一件事

在**跑 campaign 的那个项目**里，把 `.teamwork/` 加进 `.gitignore`：

```gitignore
.teamwork/
```

那是运行时状态，不该提交。（本仓库的 `.gitignore` 管不到你的目标项目。）

---

## 验证留痕

从 0.2.0 起，**"验过了"必须留下文件**：

| 文件 | 谁写 | 内容 |
|---|---|---|
| `.teamwork/verifications/<里程碑>.md` | **验证角色**（绝不可是实现它的 Worker） | 里程碑 id、验证角色、原样命令、原始输出、结论（`SOUND` / `FALSIFIED` / `SURVIVED` / `REPRODUCED` / `DIVERGED` / `BLOCKED`） |
| `.teamwork/final-audit.md` | Success Auditor | 对着宪章逐条判定，结论 `ACHIEVED` / `PARTIALLY ACHIEVED` / `NOT ACHIEVED` |

**一个里程碑没有验证文件，就算未验证**，测试再绿也一样。

### 为什么这件事值得单独说

因为**它把"靠自觉"焊成了"被检查"**。

Goal Mode 的每轮校验只认**文件型实据**——改动的文件、命令输出、测试结果。它看不见你有没有真的派过 Critic。所以这里没有发明任何新机制，只是**把框架已有的验证文化，接到了平台已有的硬校验上**：

- 角色履约 → 变成文件
- 文件 → 变成 `/goal` 的判定条件
- `/goal` → 由运行时每轮检查

代价要说清楚：**这样产物就依赖 ZCode 的 Goal Mode**，搬到别家会降级。这是当初明确选的取舍。

---

## 八个角色

| 角色 | 职责 | 工具权限 |
|---|---|---|
| **sentinel** | 起点关卡。审宪章，返回 CLEARED / BLOCKED。强制完整性模式 | 只读 |
| **orchestrator** | 拆里程碑、出依赖图、分配文件所有权，写 `plan.json`。**不写代码** | 只读 |
| **explorer** | 只读调研。报告必须带可独立核对的行号证据 | 只读 |
| **worker** | 在自己的文件范围内实现一个里程碑 | 读写 + 命令 |
| **critic** | 找**实现**的缺陷 | 只读 + 命令 |
| **challenger** | 攻击**前提** | 只读 + 命令 |
| **auditor** | 从干净状态**独立复现**证据 | 只读 + 命令 |
| **success-auditor** | 终审：宪章定义的"完成"真的达到了吗 | 只读 + 命令 |

四个验证角色的区别见[上文](#最关键的区别四个验证角色是分开的)——那是本项目的核心。

---

## 五种编排形态

`/teamwork` 会推荐一种，也可以自己指定。

| 形态 | 什么时候用 | 流水线 |
|---|---|---|
| **Iterative Coding** | 拆不开的活儿——一个算法、一个参数互相影响的模拟 | Implement → Critic → 打磨 → Auditor |
| **Distributed Coding** | 能干净拆成独立工作流的活儿 | Orchestrator → 并行 Worker → Critic → Auditor |
| **Long Proof** | 有死胡同的开放问题——猜想、策略搜索、新设计 | Explorer → Challenger（证伪）→ Worker → Auditor |
| **Self-Verification** | 每一步都要验、不能只在最后验的声明 | Worker → Auditor，逐里程碑循环 |
| **Document Review** | 分析一堆材料而不是代码 | Explorer → Critic → 综合 → Auditor |

**对拆解要诚实。** 如果各部分耦合得紧，选 Distributed Coding 买来的是冲突，不是速度。

**Distributed Coding 是唯一会并行跑 Worker 的形态**，也是唯一真正依赖"归属到具体 Worker"的形态。如果归属不可用，独占锁会在第一次认领时**明确告警**（见[文件独占锁](#文件独占锁)）。

---

## 三种完整性模式

在 Phase 1 选定，写进宪章，全程生效。

| 模式 | 含义 |
|---|---|
| **development** | 默认。快速迭代。允许走捷径，但必须记录 |
| **demo** | 别人必须能从干净状态独立复现，不用你帮忙 |
| **benchmark** | 最严。**只准用语言标准库**。不许生成 fixture，不许在看到结果之后才写期望值，不许写只断言当前行为的测试 |

选了 `benchmark`，Success Auditor 会专门去找指标造假——**一份诚实报告的"部分达成"，比一份造假的"完整达成"有价值得多。**

> **宪章是这两个值的唯一来源。** 插件设置页里**没有**对应开关，这是有意的：ZCode 只在 `.mcp.json` 里替换 `${user_config.*}`，钩子和 skill 都读不到插件配置。所以 `integrity_mode` 和 `ownership_lease_minutes` 在访谈里定，然后从宪章里读。早先版本在 `plugin.json` 里放过这两个配置项，那是**一个什么都不做的假开关**，0.2.0 已删除。

---

## 文件独占锁

它由**两个** `PreToolUse` 钩子合起来实现，共用同一份租约表和同一把互斥锁：

| 钩子 | matcher | 拦什么 |
|---|---|---|
| `ownership-lock.mjs` | `Write\|Edit` | 编辑工具写文件（**精确**：知道具体是哪个文件） |
| `bash-guard.mjs` | `Bash` | shell 写文件（**尽力**：模式匹配，见下方限制） |

当一个 Worker 要写**正被另一个 Worker 持有**的文件时，直接 deny。

这是 Teamwork 的核心不变量：**同一时刻，两个 Worker 绝不同时碰一个文件。**

### 为什么需要第二个钩子

`echo x > file`、`sed -i`、`tee`、`dd of=`、`git apply`、`patch` 这些**都不经过 `Write|Edit` 钩子**。只挂一个钩子的话，shell 写入会静默绕过所有权表——而那正是框架里最贵的失败模式。

所以：

- **能认出目标文件时**（`> file`、`tee file`、`sed -i ... file`、`rm`、`mv`、`cp` 的目标），照常查租约，冲突就 deny
- **认不出目标文件时**（`git apply`、`patch`、复杂管道），**放行但附带警告**，明确说明"这次调用的独占所有权没有被强制"
- **落在工作目录之外的路径**（`/dev/null`、`/tmp` 日志、隔壁项目）**完全不管**——它们不属于这个 campaign

**宁可漏报，不可误杀。** 一次误拦普通构建命令，会把 Worker 训练成跟钩子对抗，那比漏一条警告糟得多。

### 三个刻意的设计决定

**1. 它有开关，而且要两道。**
只在目标项目里存在 `.teamwork/campaign.json`，**且 `approved: true`、`phase: "execution"`** 时才生效。少一道，钩子就会去管你**每一个项目里的每一次普通编辑**——那是灾难；或者在访谈还没结束时就武装起来——那是语义错误。

想临时关掉？删掉 `campaign.json`，或者用 `/teamwork-end` 归档，就回到正常 ZCode。

**2. 它是租约，不是硬锁。**
认领超过 `ownership_lease_minutes`（默认 10 分钟）无活动就过期，可以被别的 Worker 回收。否则一个崩掉的 Worker 会把整个 campaign 永久死锁。

**3. 临界区有互斥。**
租约表的"读—判—写"三步曾经是**非原子**的：两个 Worker 同时认领不同文件时，都读到旧表、各自写回，后写者把先写者的认领覆盖掉——**先一个 Worker 的锁凭空消失**。而"并行 Worker"正是这个插件存在的理由。

现在临界区跑在 `mkdir` 做的互斥里（`mkdir` 在所有平台上都是原子的），拿不到锁就短暂自旋，超时就**直接放行**（记账永远不能阻塞工具调用）。持锁进程被杀掉也不会死锁——超过 10 秒的锁目录会被抢占。

修复前后的实测（12 个进程同时认领 12 个不同文件，跑 5 轮）：

| | 结果 |
|---|---|
| **无互斥（修复前）** | 5 轮里 4 轮丢锁，最差一轮 12 个只剩 **9** 个 |
| **有互斥（修复后）** | 5 轮全部 **12/12** |

### ⚠️ 两个你必须知道的限制

**限制一：shell 写入的覆盖是不完整的。**

`bash-guard.mjs` 不解析 shell，它做的是模式匹配。所以它**认不出**的情况包括：变量拼接的目标路径（`> $OUT/file`）、通配符（`> src/*.log`）、命令替换、`find -exec`、脚本内部的写入（`bash build.sh` 里干了什么它看不见）。这些一律走"放行 + 警告"。

**唯一可靠的做法**是让 Worker 用 `Edit` / `Write` 改源码——那条路径是精确的。这条规则已经写进 `worker.md` 的硬约束，以及 `critic.md` 的检查清单（Critic 会用 `git diff` 检查改动是不是都来自 `Edit`/`Write`）。

**限制二：持有者身份是尽力识别，而且可能完全失效。**

优先级如下：

```
$TEAMWORK_OWNER_TOKEN  →  agent_id / agent_type  →  transcript_path 哈希  →  session_id
```

**问题在于：ZCode 的钩子文档没有记载 `PreToolUse` 载荷里存在 per-subagent 标识符。** 如果确实没有，而 `transcript_path` 又是**整个会话共用**的，那么所有 Worker 会解析成**同一个 owner**，`held.owner !== owner` 永远为 false——**冲突检查完全失效，是零保护，不是"退化成先到先得"。**

**早先版本在这一点上说了不准确的话，已更正。** 现在钩子会**检测这个状态并明确告警**：当归属只能落到最弱的一档、且形态是 `distributed-coding` 时，第一次认领就会往上下文里写一条警告，直说"独占所有权未生效"。

要拿到精确归属，唯一可靠的路子是：

- **一个 Worker 一个 ZCode 进程**，在那个进程的环境里设 `TEAMWORK_OWNER_TOKEN`
  （注意：**不是**在派发时给子 agent 设环境变量——钩子是 ZCode 进程的子进程，继承的是 ZCode 的环境；子 agent 是进程内派发的，改不了它。这一点早先的文档写错过。）

否则就退而求其次：**手工保证每个 Worker 的文件范围互不重叠**，然后用 `/teamwork-status` 核对。

---

## 宪章字段说明

Phase 1 结束时会写到 `<目标项目>/.teamwork/campaign.json`：

```json
{
  "objective": "一句话，可检查",
  "integrity_mode": "development | demo | benchmark",
  "pattern": "iterative-coding | distributed-coding | long-proof | self-verification | document-review",
  "working_directory": "/绝对路径",
  "requirements": ["约束"],
  "out_of_scope": ["明确排除的"],
  "verification_method": "证明结果的命令或产物，以及由谁执行",
  "acceptance_criteria": ["逐条可独立检查"],
  "ownership_lease_minutes": 10,
  "approved": false,
  "phase": "scoping"
}
```

哪些字段真的被读：

| 字段 | 谁读 | 作用 |
|---|---|---|
| `approved` | 两个所有权钩子 | **必须为 `true`** 才武装，否则完全空转 |
| `phase` | 两个所有权钩子 | **必须为 `"execution"`** 才武装 |
| `ownership_lease_minutes` | 两个所有权钩子 | 认领过期时间（钳制在 1–10080 分钟） |
| `pattern` | `ownership-lock.mjs` | `distributed-coding` 会打开归属告警 |
| `integrity_mode` | `session-context.mjs` | 会话启动时注入模式约束 |
| `objective` / `acceptance_criteria` | `session-context.mjs` | 会话启动时注入宪章，防止跑偏 |
| `out_of_scope` | `session-context.mjs` | 会话启动时注入，防止范围悄悄长大 |

### `.teamwork/plan.json`

Orchestrator 产出，会话恢复时由 `session-context.mjs` 重新注入：

```json
{
  "sentinel": "CLEARED",
  "milestones": [
    {
      "id": "m1",
      "deliverable": "可检查的产物",
      "files": ["src/a.ts"],
      "blocked_by": [],
      "verified_by": "critic",
      "status": "pending | in-progress | done",
      "verified": false
    }
  ],
  "ownership": {"src/a.ts": "m1"}
}
```

### `.teamwork/events.jsonl`

钩子追加的运行时事件，排障时比翻 ZCode 日志直接：`claimed` / `denied` / `expired`。`/teamwork-status` 会读它。**`denied` 出现就说明两个 Worker 真的撞上了**，值得看一眼。

---

## 成本

**这东西又贵又慢，这是它的设计属性，不是缺陷。**

### 贵在哪

- 每个里程碑都要过验证角色，**验证本身的 token 消耗和实现是一个量级的**
- 八个角色各有独立上下文，**同一份代码被读很多遍**
- 长周期任务跨会话，每次重启都要重新注入宪章和上下文
- Goal Mode 每轮都做一次验证判定

### 量级参考

| 场景 | 量级 |
|---|---|
| Google 93 个 subagent「造操作系统」演示 | **约 26 亿 token**（含缓存读取） |
| 一个中等规模的重构 campaign | 视里程碑数量，通常是单 agent 的数倍到数十倍 |

### 怎么省

1. **目标写具体、验收标准写到能验**——这是最有效的省钱手段，它避免最贵的浪费：跑三小时才发现目标没定义
2. **开工前设预算**，用 Goal Mode 的用量上限
3. **别在小活儿上用**——这是最大的浪费来源
4. **选对 pattern**——耦合紧的活儿硬拆成并行，买来的是冲突和重做
5. **别让失败的里程碑空转**——升级协议写死在 `teamwork-execute` 里：重试一次 → 重新规划 → 暂停并交给人。**每个里程碑最多两轮返工**，到顶就停

### 一句话

> **如果答错的代价，明显高于派团队的成本，才用它。**

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **子 agent 不能再开子 agent** | ZCode 不把 Agent/Task 工具给 subagent。所以 Sentinel → Orchestrator → Workers 这棵树是**拍平**的：主 agent 当编排层，所有角色都是叶子。真嵌套得靠进程级（ZCode CLI `--print`） |
| **项目级钩子不执行** | `<workspace>/.zcode/config.json` 里的 hooks 被 ZCode 当前运行时**整体忽略**。这正是本项目必须以插件形式分发的原因 |
| **`model` / `thoughtLevel` 故意留空** | ZCode 的 `thoughtLevel` 必须和具体 `model` 一起写才生效，而且**对未知键静默忽略**——写错就是无声失效。所以默认继承会话模型。要钉模型：先去模型选择器确认合法 id，然后**两个键一起加** |
| **自定义 subagent 仍是 Beta** | `~/.zcode/agents/` 目前仅支持 user 级 |
| **所有权归属是尽力而为，可能完全失效** | 见[文件独占锁](#文件独占锁)。失效时钩子会**明确告警**，不会假装在保护 |
| **shell 写入的覆盖是模式匹配的** | 变量、通配符、脚本内部的写入拦不住。用 `Edit`/`Write` 改源码才是精确路径 |
| **没有 SessionEnd 事件** | ZCode 不提供，所以租约靠超时回收，不靠会话结束释放 |
| **`SessionStart` 的 source 枚举未公开** | 官方文档只列了 `startup` / `clear` / `compact` 为「常见值」，没有完整的 source 列表。所以 matcher 用的是 `*`（匹配全部），对任何 source 都生效，**不依赖枚举是否完整** |
| **没有 MultiEdit / NotebookEdit** | 已核对官方工具枚举（`Read`/`Grep`/`Glob`/`Bash`/`Edit`/`Write`/`WebFetch`/`WebSearch`/`TodoWrite`），不存在其他写入类工具。所以 `Write\|Edit` 的 matcher 是完备的 |
| **没有真实战役样例** | `examples/` 目前只有说明和骨架，**没有伪造的轨迹**。填它需要真跑一次战役，见下 |

### 关于 `examples/`

**这个仓库目前没有真实使用案例，这是可信度上最大的空洞。**

但**不能靠编造填**。放一份编出来的"战役轨迹"进 `examples/`，等于在一个专治"自信地报告没做到的事"的项目里，自己干那件事。

`examples/README.md` 里写了这个目录该放什么、格式是什么。要填它，就跑一次真实战役，把轨迹原样导出。

---

## 排错

**`/teamwork` 敲下去没反应**
→ 检查命令是否注册：Settings → Plugins → teamwork 详情里应有 commands。也可能是你在**旧会话**里敲的，**开个新会话**。

**Settings → Subagents 里看不到那 8 个角色**
→ 插件没启用，或者没开新会话。

**Settings → Hooks 里没有那三条**
→ 同上。另外确认 `node` 在 PATH 上：`node --version`。

**编辑文件没有被独占锁拦截**
→ 先确认目标项目里有 `.teamwork/campaign.json`，**且里面 `approved: true`、`phase: "execution"`**。缺任何一个，钩子完全空转——这是设计，不是 bug。

**钩子告警说"ownership attribution is unavailable"**
→ 这是**真话**，不是误报。见[文件独占锁](#文件独占锁)的"限制二"。要么改成进程级隔离 + `TEAMWORK_OWNER_TOKEN`，要么手工保证文件范围不重叠。

**Bash 写文件被拒绝了**
→ 说明你写的文件正被别的 Worker 持有。改用 `Edit`/`Write`，或者换文件，或者把冲突报给 orchestrator。**不要循环重试。**

**Bash 写文件放行了但带了警告**
→ 那个命令的目标文件认不出来（`git apply`、`patch`、复杂管道）。这次调用的独占所有权**没有被强制**。改成用 `Edit`/`Write` 就精确了。

**`/goal` 一直不判定完成**
→ 大概率是缺 `.teamwork/final-audit.md`，或者某个里程碑缺验证记录。跑 `/teamwork-status` 看**验证缺口**那一节，它会点名。

**钩子报错 / 不触发**
→ 看日志：`~/.zcode/cli/log/zcode-<日期>.jsonl`。钩子执行失败会记 `hook.run.failed`；项目级配置被忽略会记 `config_project_hooks_ignored`。

**改了插件后不生效**
→ 钩子配置是会话启动时快照的。**开新会话。** 从本地目录装的，还要在 Marketplace sources 面板里刷新该 marketplace。

**插件检查更新没提示**
→ 两个原因，按顺序查：
1. **本地市场清单是缓存的**，先去 **市场源** 面板点 **刷新该市场**，再检查更新。
2. 「最新版本」取自 `marketplace.json` 的 `version`，「已安装版本」取自 `plugin.json`。**两边必须同步升**，否则代码更新了也不会提示。测试里有这一条断言守着。

**想知道插件的结构对不对**
→ 跑 `npm test`（见下）。

---

## 命名与版本

这个仓库里四个名字**故意不完全一致**，值得说明白，免得你踩坑：

| 位置 | 名字 | 为什么 |
|---|---|---|
| GitHub 仓库 | `teamwork-` | 建仓库时定的，**末尾带连字符**。本地安装路径要用它 |
| marketplace 清单 | `teamwork-market` | 市场名，显示在 Plugins 页的 Personal 分组标题上 |
| package.json | `zcode-teamwork-market` | npm 包名，`private: true`，不发布 |
| 插件名 | `teamwork` | 用户实际安装、启用、在 `/teamwork` 里敲的那个 |

**唯一有实际影响的是仓库名末尾那个连字符**——本地安装路径写错就装不上，README 的[方式二](#方式二本地目录)已经按实际名字写。

### 版本号

版本号在**两个**地方，必须同步：

- `plugins/teamwork/.zcode-plugin/plugin.json` — 已安装版本
- `marketplace.json` — 客户端拿它跟已安装版本比，决定要不要提示更新

**漏改 `marketplace.json`，用户就永远收不到更新提示。** 测试里有断言守着这一条。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 设计说明

### 灵感来源与对照

本项目复刻的是 Google Antigravity 的 **Teamwork**（`/teamwork-preview`）的编排结构：两阶段流程（先访谈后执行）、八角色分工、文件独占所有权、三种完整性模式、五种编排形态。

**一个重要的对照：** Antigravity 至今被用户批评为**黑盒**（官方 issue #301：跑起来只提示"后台任务已启动"，看不到每个 agent 在干嘛）。而 **ZCode 的 Goal Mode 已经有按轮次分组的迭代清单面板了**——观测性这块不用自己造。

### 为什么验证循环交给 Goal Mode

Goal Mode 已经提供了：

- 每轮结束自动验证目标是否达成，未达成自动开下一轮
- **只认真实证据**（改动的文件、命令输出、测试结果），不认计划、清单、听起来很笃定的总结
- 目标状态下跨会话持久化
- 到达用量预算自动停
- 每轮迭代清单面板

自己用 `Stop` 钩子重写这套，上限是**连续 3 次**，而且丢掉面板。不划算。

**代价要说清楚**：这样产物就依赖 ZCode 的 Goal Mode，搬到别家会降级。这是当初明确选的取舍。

### 为什么配置和协议文件强制纯 ASCII

Markdown 里用破折号箭头没问题（模型按 UTF-8 读）。但 **JSON 配置和钩子 stdout 是协议路径**，跨编码边界进 ZCode 运行时。开发过程中实际踩到：一个 `—` 在 GBK 环境下会吃掉后续引号，**直接破坏 JSON**。所以这三类文件由测试强制纯 ASCII。

---

## 开发与测试

```bash
npm test                  # 全部
npm run test:frontmatter  # 只测结构
npm run test:hooks        # 只测钩子行为
```

**251 项校验**，分两组。CI 在 Node 18/20/22 × Linux/macOS/Windows 上跑。

### `tests/frontmatter.test.mjs` — 160 项结构校验

ZCode **会静默忽略无法识别的 frontmatter 键**，所以一个拼写错误不会报错，只会悄悄失效。这组测试断言：

- 每个角色的必填键齐全（`name` / `description`），且**描述带英文部分**（面向国际 marketplace）
- **没有未知键**
- **工具名全是 ZCode 的**（`Read` / `Edit`），不是别家的（`read_file` / `shell_command`）——后者会静默地什么都拿不到
- `thoughtLevel` 没有脱离 `model` 单独出现（那样会被静默忽略）
- 角色名不与 ZCode 内置的 `general-purpose` / `explore` 冲突
- 命令文件名符合 ZCode 的命令名规则（否则静默不注册）
- **`hooks.json` 里引用的每个脚本都真的存在**（否则运行期静默失败）
- `hooks.json` 的 `PreToolUse` **同时覆盖 `Write|Edit` 和 `Bash`**
- `hooks.json` 的 `SessionStart` matcher 是**与 source 无关**的（`*`）
- `plugin.json` **不含 `userConfig`**（ZCode 送不到钩子和 skill，只能是假开关）
- `plugin.json` / `marketplace.json` / `package.json` 的版本号**三处一致**，且 `CHANGELOG.md` 里有对应条目
- 清单里的 `source` 路径**真的存在**
- 配置与协议文件**纯 ASCII**（扫描整个 `hooks/` 目录，不只是固定清单）
- **frontmatter 解析器本身**也被断言（解析器错了，上面每一条都没意义）

### `tests/hooks.test.mjs` — 91 项行为校验

真起 node 子进程，喂符合 ZCode 文档契约的 JSON 到 stdin，断言 stdout 协议与磁盘上的状态：

- 无 campaign 时**完全空转**（不干扰日常使用）
- **`approved: false` 或 `phase != execution` 时仍然空转**（访谈期间不武装）
- 首次认领放行并落盘，且记录 owner 与来源
- **冲突时正确 deny，且错误信息点出文件和持有者**
- 同持有者重复写放行；不同文件互不影响（并行 Worker 不受干扰）
- **租约过期可回收**（崩掉的 Worker 不会死锁）
- **并发竞态回归**：12 个进程用**同步屏障**同时释放，3 轮全部 12/12
  （屏障是必须的：只靠进程启动抖动**复现不出**这个竞态，早先版本因此是个没牙的测试）
- 持有互斥锁时第二个进程**主动退让**而不是写坏表；**过期锁会被抢占**
- 租约时长的边界（0 / 负数 / 字符串 / 小数 / 超大值）
- **原型污染防御**、**残留 `.tmp` 清理**、**事件日志**
- **macOS 大小写不敏感与 NFD/NFC 归一**（通过桩掉 `process.platform` 在任意平台验证）
- **Bash 守卫**：非写入命令空转、工作目录外忽略、`>` / `sed -i` / `tee` 撞锁被拒、认不出目标的原地编辑**放行但警告**、shell 写入会认领所有权（后续别的 Worker 的 `Edit` 会被拦）
- **畸形 stdin 绝不阻塞工具调用**（记账永远不能成为工具调用失败的理由）

---

## 许可

MIT，见 [LICENSE](LICENSE)。
