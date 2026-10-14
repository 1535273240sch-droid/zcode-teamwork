# Changelog

All notable changes to this project are documented here.

The version lives in **two** places and they must stay in sync: `plugins/teamwork/.zcode-plugin/plugin.json`
is the installed version, and `marketplace.json` is the version the client compares against to decide whether
to offer an update. Bump both, or installed users will never be told there is a new one.

## [0.6.0] — 2026-10-15

隔离从"应用层正则拦截"升级为"物理边界强制执行"，并新增锦标赛竞争模式：Worker 的 worktree 不再只是一句口头约定，越界写入会被 Bash 守卫当场拒绝；任务合入前，Worktree 实际改动的文件清单必须与租约授权清单逐一对上。

### Added

- **执行边界注册表 (`plugins/teamwork/lib/isolation.mjs`)**：
  - 新增 `.teamwork/boundaries.json`，把 **owner 令牌** 与它被分配的 worktree 绑定起来。在此之前，worktree 只是被创建和告知，Bash 守卫无从知道某个 owner 拿到的是哪个 checkout——隔离因此停留在账面上。
  - `recordBoundary` 只接受真正的 worktree：`isolated-dir` 模式下的 Worker 仍然共享同一份仓库，把写入限制在临时目录里会直接拒绝它去改本该改的源码。只登记能真正执行的那一档，守卫才不会误杀正常编辑。
  - `readBoundaries` 使用 null 原型对象并拒绝 `__proto__ / constructor / prototype`，因为该文件的键来自环境变量，构造出的 owner 令牌不能污染它所插入的映射原型。
- **Worktree 改动清单 (`lib/isolation.mjs`)**：
  - `worktreeChanges()` 同时用 `git diff --name-only` 与 `git status --porcelain`：前者看不到 Worker 新建但未 `git add` 的文件，而"建文件"正是 Worker 的主要产出。
  - 比较基线是**创建 worktree 时的 fork 提交**，不是 `HEAD`。Worker 在自己的分支上提交后，worktree 内的 `git diff HEAD` 为空——用 HEAD 会让校验对已提交的改动完全失明。`createIsolation` 现在会把该 fork 点记录进边界。
  - 读取失败一律返回 `ok: false`：无法计算的校验不等于通过。
- **合并授权校验 (`lib/ownership.mjs` 的纯函数 `authorizeMerge`)**：
  - 比对 Worktree 改动清单与租约白名单，`src/` 形式的目录前缀可授权其下全部内容。
  - 与 git 调用分离（git 只在 `lib/isolation.mjs` 中），因此该比较无需仓库即可单元测试。
  - 授权清单为空同样判负——没有比较对象的校验并没有通过，只是没有运行。
  - 引擎侧入口：`engine.checkMerge(workstreamId, owner)` 组合两半并返回裁决，`engine.boundaries()` / `engine.releaseBoundary(owner)` 管理边界生命周期。
- **Bash 守卫执行期边界约束 (`plugins/teamwork/hooks/bash-guard.mjs`)**：
  - 目标落在共享 checkout（或**另一个 Worker 的 worktree**）而该 owner 已被分配 worktree 时，直接拒绝，并说明越界目标与所属 worktree。
  - 程序化写入（`node -e` / `python -c` / `deno eval` / `bun -e` / `ruby -e` / `php -r`）在受限模式下拒绝：这类命令的写入目标无法从命令行读出，而获得独立 checkout 的 Worker 只需在自己目录里重跑即可，代价为零，因此不做过目即放行。该规则与"是否出现写 API"配对使用，以免误杀 `node -e "console.log(...)"` 这类求值命令。
  - **默认完全惰性**：未记录边界的 owner 行为与 0.5.0 逐字一致，未启用隔离的战役不会被一个它没开启的功能约束。
  - 相对路径不判为越界：守卫无从得知 shell 的真实工作目录，猜测会大量误杀普通构建命令。
- **锦标赛模式 (`lib/patterns.mjs`, `lib/decompose.mjs`)**：
  - 第 7 个 pattern `tournament`：2~3 个并行 Worker 以**不同路线**实现同一难点，每个候选项配对一个 `empirical-challenger` 证伪器，最后由 Orchestrator 合成。
  - 门禁要求三名独立声音（证伪器 + 审校者 + 审计员），因为锦标赛的目的就是找到"经得起攻击的那条路线"，攻击本身不可选。
  - 候选项**故意共享文件范围**——比较同一份代码的两种实现正是其意义所在，因此其他 pattern 赖以并行的"文件互斥"规则在此不适用，改由"每个候选项独占 worktree"承担。
  - 路线只给编号不给描述：在还没有人看过问题之前就指定实现路线，等于取消了"独立尝试"。
  - synthesis 任务阻塞于**全部证伪任务**而非候选项：它读的是证伪报告，提前开始就只能猜测谁还站着。
- **陷阱注册表 (`lib/blackboard.mjs`)**：
  - 持久化 `.teamwork/pitfall-registry.json`，按"轮次 + 候选项"为键；同一候选项重复登记是**覆盖**而非追加——一次尝试只被证伪一次，两条记录会让合成把同一次失败读成互相印证。
  - `highlights` 是一等字段，不是装饰。锦标赛花掉的是真金白银，只有把"这条死路在被证伪前做对了什么"写下来，这笔开销才可能收回；只记失败原因会让合成变成从零开始。
  - `synthesisBrief()` 输出合成简报：幸存者单独列出（工作是**选择**其一再从尸体上取其精华，不是把所有方案平均掉）、被证伪者连同原因与亮点逐条列出、无亮点者明确标注为死路。
  - 引擎侧入口：`engine.recordPitfall` / `engine.pitfalls` / `engine.synthesisBrief`。

### Changed

- **`engine.createPlan` 放行"全员隔离时的文件重叠"**：原规则无条件拒绝两个 milestone 认领同一文件，从结构上禁止了锦标赛。放行的条件挂在**物理隔离**而非 pattern 名字上（`collision.milestones.every((id) => isolated.has(id))`），因为重叠之所以安全靠的是各自独立的 checkout 而不是账本记对；挂在名字上就能被"声明 tournament 但不开隔离"绕过，测试专门守住了这一点。这也让 worktree 机制成为锦标赛的必要前提。
- **`checkPlanAgainstPattern` 新增隔离不变量**：按计划**实际行为**判定（任何共享文件的 milestone 必须已隔离），而非按标签判定。最初的实现按"是否标记为 candidate"过滤，结果把同样带候选编号的证伪任务也当成了参赛者并要求它们互相竞赛——测试抓到了这个 bug。
- `skills/teamwork/SKILL.md` 的 pattern 列表修正为真实的 7 个 id（原文写作 `long-proof`，该 id 并不存在，且遗漏 `research`）；`phase` 取值修正为 `approved | executing | verifying`（原文写作 `"execution"`，正是代码注释中记录过的那个"文档与实现不一致导致 hook 静默失效"的旧坑）。

### Fixed

- **带空格的引号路径解析错误 (`hooks/bash-guard.mjs`)**：`extractTargets` 的正则在空格处截断，`"E:\新建文件夹 (7)/src/x.ts"` 被解析成 `"E:\新建文件夹`。这不仅是新功能失效——既有 ownership 锁也会为不存在的路径建锁键，而本机工作区路径恰好含空格，属必然踩中的洞。现在路径参数按"引号串（可含空格）或裸令牌"两种形式匹配，`mv`/`cp` 的源与目标捕获组也一并修正。
- **路径中的字面 `~` 被误当作家目录展开而丢弃 (`hooks/bash-guard.mjs`)**：`normaliseTarget` 原先只要在任意位置发现 `~` 就丢弃整个目标。但 `~` 只在**词首**具有展开含义，词中的 `~` 是普通路径字符——Windows 短名（如 `C:\Users\RUNNER~1\...`）正是如此，CI 检出目录与相当一部分用户配置目录都经由它抵达。原文因此在这类工作区上把每个目标都丢光，使路径校验静默失效。现改为仅拒绝词首 `~`；与位置无关的展开字符（`*?$`、反引号、`{}`、`[]`）仍按原样一律拒绝。该缺陷由 Windows CI 暴露：本机临时目录无 `~` 因而掩盖了它。

### Tests

- 新增 `tests/worktree-boundary.test.mjs`（43 项）：边界注册表与原型污染、合并授权、worktree 改动清单（含"以 HEAD 为基线会漏掉已提交改动"）、Bash 守卫的越界/相对路径/兄弟 worktree/程序化写入/惰性回退，以及 `~` 的位置语义（词中为字面量、词首仍按展开处理）。fixture 目录**故意含空格**以复现上述解析缺陷；测试以明确的 SKIP 失败项处理 git 不可用的环境，而非静默通过。
- 新增 `tests/tournament.test.mjs`（60 项）：pattern 校验与计划检查、分解形状、陷阱注册表的覆盖语义与损坏回退、合成简报，以及引擎端的端到端建战役流程。
- `tests/patterns.test.mjs` 的 pattern 数量断言由 6 更新为 7（5 处）。
- 全套 11 个 suite 本地通过。

### Limits, stated

- **运行期拦截需要 `TEAMWORK_OWNER_TOKEN`**：边界只有在为该 owner 显式登记后才生效，激活方式是每个 Worker 一个进程并带上该环境变量（`ownership-lock.mjs` 早已文档化的模型）。插件不会自动注入它——查证 ZCode hook 规范后可以确认：`PreToolUse` 输出为严格 schema，只有 `additionalContext` 与权限决定两个通道，**无法为被派发的 subagent 设置环境变量**，且 `SubagentStop` 并非受支持事件。要自动绑定 Worker 与其 worktree，必须控制进程启动，即尚未实现的 daemon 层。
- 计划层的结构性保证（`createPlan` / `checkPlanAgainstPattern` 的拒绝）**不依赖任何环境变量**，直接生效。
- 相对路径不判为越界，因此边界的真实强度依赖"Worker 确实在自己的 worktree 中执行"；单靠 hook 不构成完整沙箱，物理隔离仍来自 worktree 本身。
- 锦标赛的候选项**能否真正并行**取决于 spawn budget：`scheduler.mjs` 对超预算批次是"变薄"而非报错。
- 平台沙箱（bwrap / sandbox-exec）未实现，且在 Windows 上不可用。

## [0.5.0] — 2026-10-03

100% 深度对齐 Google Antigravity 多智能体协同编排引擎：引入主动存活看门狗与死锁自愈机制、长程会话自我继承协议与永久退役铁律、11 大特种特工矩阵、5 大专业化路由路径、中心黑板架构以及只增不减绝对意图权威记录。

### 新增特性 (Added)

- **主动存活检测与死锁自愈看门狗 (`plugins/teamwork/lib/watchdog.mjs`, `scripts/watchdog.mjs`)**：
  - 原生零依赖对齐 Antigravity 哨兵监控守护机制（Sentinel Monitoring Crons）。
  - 主动巡检 `events.jsonl` 事件流 mtime、过期文件租约锁（Lease）以及未核销的子代理预留令牌（Reservations）。
  - 自动解除死锁（Auto-Heal）：自动清理过期文件租约，安全回收超时挂死的孤立子代理预留，彻底化解异常掉线造成的资源锁死。
  - 提供全功能终端运行器，支持一次性巡检与后台守护模式（`npm run watchdog`）。
- **自我继承协议与永久退役铁律 (`plugins/teamwork/lib/handoff.mjs`, `lib/engine.mjs`)**：
  - 严格落实 Antigravity 核心铁律：交接后旧代实例**永久退役（Permanently Retired - 禁止复用）**，从物理上杜绝历史上下文累积污染与幻觉漂移。
  - 自动归档不可篡改的交接记录到 `.teamwork/handoffs/gen-<N>.json` 并输出即时可读的 `BRIEFING.md`。
  - 在 `generations.json` 中完整记录从 `gen-1` 至 `gen-<N+1>` 的多代世代谱系。
- **11 大专业化特种特工全武装矩阵 (`agents/test-writer.md`, `agents/spec-miner.md`, `agents/empirical-challenger.md`)**：
  - 角色库由 8 角色扩充为 11 角色全武装矩阵。
  - `test-writer`（独立测试编写者）：专职独立编写全量自动化测试与极端边界用例，严禁修改任何生产业务代码，彻底消除实现者“自我迎合、自我造假”的盲区。
  - `spec-miner`（规范挖掘者）：严格只读，专门从代码库内的头文件、Proto、接口定义、RFC 文档或架构设计中逆向提取权威契约与不变量。
  - `empirical-challenger`（经验对抗者与模糊红队）：构造模糊测试（Fuzzing）、反例生成器与极限破坏测试，用客观事实攻击 Worker 代码，一票否决虚假完成。
- **5 大 Antigravity 专业化路由路径 (`plugins/teamwork/lib/router.mjs`)**：
  - `swe-light`（轻量快修）：单文件快速修复。严格遵循**反拆分铁律（Does NOT decompose）**，单一实现者配合审校者快速闭环，节省 80%+ Token。
  - `general`（标准软件工程）：常规大型软件工程与跨模块重构，里程碑拓扑拆解，配备独立测试编写者。
  - `document-review`（文档与规范评审）：论文、RFC 与规范文档评审，基于递归自聚合（RSA）锦标赛树进行并行分段审校。
  - `math-proof`（数学与形式化证明）：数学定理推导与形式化证明，Colosseum 多阶段流水线严格查验逻辑漏洞。
  - `adversarial-quant`（量化金融与极限红队）：量化模型、金融 Alpha 挖掘、红队安全、共识算法等极端高敏场景，激活全部 11 角色武装。
- **专职中心黑板架构 (`plugins/teamwork/lib/blackboard.mjs`)**：
  - 引入 `.teamwork/blackboard.json` 作为集中共享状态黑板，各特工仅提交状态更新与接口摘要。
  - 提供原子合并写入（`postUpdate`）、审计追踪留痕与分类筛选检索（`queryBlackboard`），彻底根除多 Agent 并发写入冲突。
- **只增不减绝对意图权威记录 (`ORIGINAL_REQUEST.md`)**：
  - 自动在项目根目录维护 **Append-Only（只增不减）** 的人类原始需求记录与 UTC 时间戳，作为不受上下文压缩截断影响的**终极真理源（Ground Truth）**，收尾验收必须以此为基准进行实质审查。
- **全量对齐测试套件 (`tests/antigravity-alignment.test.mjs`)**：
  - 新增 37 个严格断言，全量覆盖看门狗自愈、自我继承谱系、5 大专业化路由、特工 Frontmatter 契约、黑板原子同步与意图真理源落盘。

## [0.4.1] — 2026-09-29

Universal Cross-Platform One-Click Setup, Dynamic Hook Auto-Registration, Live Black Terminal Monitor, and Safe Status Handling.

### Added

- **Universal Cross-Platform Installer (`scripts/install.mjs`)**: Provides zero-config deployment across any machine (Windows, Linux, macOS). Dynamically detects user home directory and workspace, auto-generates portable hook definitions, and registers them directly into both global and workspace configurations.
- **Live OLED Black Monitor (`scripts/watch.mjs`)**: Dedicated 2-second terminal watcher providing financial terminal-grade live visualization of active milestones, dispatch budgets, active file locks, and Mermaid DAG.
- **One-off Dashboard Script (`scripts/dashboard.mjs`)**: Instant CLI printout of mission control board.
- **NPM Shortcuts**: Added `npm run setup`, `npm run dashboard`, and `npm run watch`.

### Fixed

- **Engine Status Milestone Safety**: Gracefully handles campaigns with undefined or empty milestone lists (`state.milestones ?? []`), preventing `TypeError` during early scoping phases.
- **ZCode Desktop Settings Hook Display**: Fixed issue where the ZCode Desktop "Settings -> Hooks" interface showed empty due to missing workspace configuration file.
- **Cross-Path Resilient Slash Command**: Enhanced `/teamwork-status` with multi-path resolution fallbacks.

## [0.4.0] — 2026-09-29

100% Antigravity Orchestration Alignment: Tiered Agile Routing, OLED & Mermaid Visual Dashboard, Adaptive Deliverable Sizing, and Deterministic Re-Verification.

### Added

- **Tiered Agile Router (`router.mjs`)**: Introduces L1 Agile Duo (Worker + Critic), L2 Standard Squad (Orchestrator + Worker + Auditor + Critic), and L3 Full Adversarial (all 8 roles). Eliminates token explosion and bureaucratic ceremony for routine bugfixes and focused tasks.
- **Visual Mission Control Dashboard (`dashboard.mjs`)**: High-information-density OLED Pure Dark & Liquid Glass dashboard featuring live Mermaid milestone dependency diagrams, ASCII progress bars, and ledger health metrics.
- **Auto-Resolution for `evidence: latest`**: Verifiers can now simply cite `evidence: latest` to bind to the latest hook-captured execution log, resolving the notorious Catch-22 deadlock where models had to guess obscure timestamped filenames.
- **Deterministic Command Re-running (`reverifyCommand`)**: Command re-execution utility in sandbox sub-process to physically eliminate fabricated test transcripts and counterfeit executables (e.g. fake git shims).
- **CLI Commands**: Added `teamwork dashboard` and `teamwork tier --task "..."` CLI verbs.

### Fixed

- **Adaptive Deliverable Sizing**: Code deliverables (`.js`, `.ts`, `.py`, `.json`, etc.) now use an adaptive 64-byte floor instead of being blocked by the rigid 2048-byte documentation floor.
- **Enhanced Verification Gate Guidance**: Directly instructs models that `evidence: latest` is valid syntax when citations are absent.

## [0.3.7] — 2026-09-22

Concurrency, after the eight-worker incident. Two additions and one ordering fix.

The incident: eight workers dispatched in parallel, and at 20:19:47 an upstream
teardown cut all eight in-flight requests at the same instant. Six never reported.
Every surface showed success, 2.68 million tokens produced six stub files, and the
loss was found by a human reading the filesystem.

The cause was not concurrency by itself. It is that a worker killed mid-flight
leaves no result **and no error**, so nothing could tell it apart from a worker that
had finished. Concurrency only decided how many were lost at once.

### Added

- **A concurrency ceiling, set by the user at approval** (`maxParallel`, default 4).
  The total budget bounds what a campaign costs; it says nothing about shape. A
  campaign with sixteen dispatches allowed can still start all sixteen at once, and
  that is what happened. In-flight count comes from the dispatch reservations that
  already existed, so this needed no new state. Set to 0 for no limit.

- **Abandoned-dispatch detection.** A reservation is taken when a dispatch is
  admitted and consumed when its result is recorded, so an unconsumed reservation
  means a worker began and nothing came back. The gate now reports those at turn
  end: six of eight workers going silent would have surfaced as a refusal instead of
  a green board.

  It separates "started and silent" from "started and finished", not from "started
  and working" - a live worker holds a reservation too. That is why it is checked
  where nothing should still be running.

### Fixed

- **The gate exited before it could see the incident.** It returned early when the
  campaign had no milestones, which is exactly the state the eight workers were
  dispatched into. The abandoned-dispatch check now runs before the milestone
  source, and a campaign with no milestones but silent dispatches is blocked rather
  than skipped.

- **The budget resolver existed twice**, in `spawn-budget.mjs` and
  `scheduler.mjs`, with identical bodies. Same shape as the plan.json /
  campaign.json and 'execution' / 'approved' defects: two implementations of one
  contract that agree until one is edited. The hook now imports the shared
  resolver, and a structural test asserts it does not carry its own.

### Tests

882 -> 921, built from the incident's shape: six reservations against a campaign
with no milestones, a cap of two with two in flight, and the ordering regression.

Obvious in hindsight, and only visible because the incident was written down in
enough detail to reconstruct it in a test fixture.

## [0.3.6] — 2026-09-22

Closes the gap between checking what a record says and checking what is on disk.
Both incidents below are real, and both defeated the gate for the same reason.

### Added

- **Deliverable check.** A milestone may declare `deliverables`. Each must exist,
  clear a size floor, contain body text beyond its headings, and carry no
  placeholder marker. Written for the code-review incident: six workers reported
  success and wrote heading-only stubs of 802, 1008 and 1839 bytes, while the two
  that survived wrote 23,818 and 35,390. The gate passed all six, because it read
  the record and the record said the right words. A file on disk can be measured;
  an account of one cannot.

- **Evidence capture.** `audit-log.mjs` now writes a fingerprint of each captured
  command - command, exit status, byte count, hash, short tail - into
  `.teamwork/evidence/`. Records cite it with a line
  `evidence: .teamwork/evidence/<name>.log`, and the gate requires the citation,
  the file, and its non-emptiness.

- **Forgery detection.** The check that makes the rest worth having: if the audit
  trail shows a `Write` call creating a file inside `evidence/`, that file is the
  claimant's own work and citing it is rejected. Written for the second incident,
  where a worker put a fabricated `npm test` transcript in its record and the gate
  accepted it. Evidence has to be produced by the command, not by the claimant.

- `lib/evidence.mjs`, and `tests/evidence.test.mjs` (60 assertions). The tests are
  built from the incident shapes - the real byte counts, the real placeholder
  marker - because a check that only passes its own fixtures has proved nothing.

### Fixed

- **`evidence.mjs` and `audit-log.mjs` each had a `captureEvidence`.** They differed:
  one stored the full output, the other a fingerprint. This is the same defect shape
  as the plan.json/campaign.json disagreement that needed a real machine to find -
  two modules implementing one contract differently. Consolidated to one
  implementation, which `audit-log` imports.

- **A milestone id inside an evidence path satisfied the naming check.** A record
  containing only `evidence: .teamwork/evidence/m1-run.log` counted as naming m1,
  because the check ran over the whole text. Citations are now stripped before the
  naming test, since a record that mentions its milestone only inside a path has not
  been written about at all.

### Limits, stated

The fingerprint proves a command **ran**. It does not prove the record quotes it
faithfully - a worker that runs the tests honestly and then misreports the numbers
is not caught. Closing that needs the full output stored, which needs a secrets
policy first: a code review reads `.env` files, and an evidence store that leaks
credentials would be worse than the problem it solves. `TEAMWORK_EVIDENCE_TAIL`
controls how much tail is kept.

The deliverable check asks whether a file exists and has substance. It cannot ask
whether the content is correct.

### Tests

808 -> 882.

## [0.3.5] — 2026-09-22

Found by installing this plugin on a clean Windows machine and running the first-task
walkthrough end to end - a two-milestone campaign driven by real sessions. Full record:
[docs/实测记录.md](docs/实测记录.md).

### Fixed

- **The engine and the hook disagreed about the dispatch ceiling, in the permissive
  direction.** The spawn-budget hook read `spawnBudget` from `campaign.json`; the engine
  used its own constructor default and never looked. For a campaign with
  `spawnBudget: 2`, the hook enforced 2 while `status`, `schedule` and `succession` all
  reported **16**:

  | reporter | ceiling for a `spawnBudget: 2` campaign |
  | --- | --- |
  | `status` / `schedule` / `succession` | 16 |
  | the hook that actually blocks | 2 |

  Every number a human could read was wrong in the direction that looks safer. For a cost
  ceiling that is the worst way to be wrong. Both sides now resolve through one
  `resolveSpawnBudget()` in `scheduler.mjs`.

- **The reported dispatch count was always zero.** The engine counted its own
  `journal.jsonl`, which no hook writes dispatch entries to - dispatches are recorded by
  `audit-log.mjs` into `events.jsonl`. A campaign that had dispatched twice reported
  "Dispatches: 0", so the succession warning could never fire. The count now comes from
  the event trail, through one `countDispatches()` shared with the hook.

- **A UTF-8 BOM on the state file silently disarmed every hook.** `JSON.parse`
  rejects a leading byte-order mark, and every reader treats a parse failure as "no
  campaign", so a BOM turned all seven hooks into no-ops: the ownership lock, the bash
  guard, the spawn budget and the verification gate all exited cleanly and enforced
  nothing, reporting nothing. Same contradiction, same state, one byte different:

  | `campaign.json` | gate on a milestone marked done with no verification record |
  | --- | --- |
  | clean | blocks |
  | BOM prepended | returns `{}` - passes |

  This is a realistic edit rather than a synthetic one. The state file is user-editable
  by design - `/teamwork-status` and `docs/首个任务.md` both tell people to read it - and
  the obvious Windows editors add a BOM by default: PowerShell 5.1's
  `Set-Content -Encoding UTF8`, and Notepad's "UTF-8 with BOM". Found by hitting it:
  a gate test that should have blocked returned `{}`, and the cause was a BOM the test
  harness itself had written. The reader now strips a leading BOM before parsing.

### Changed

- **`marketplace.json` no longer declares `pluginRoot`.** ZCode resolves a plugin
  `source` against the marketplace root and ignores `pluginRoot` entirely, so the
  upstream `pluginRoot: "plugins"` + `source: "./teamwork"` pair resolved to a path
  that does not exist. Installing from the documented marketplace failed with
  `plugin_marketplace_invalid: Unsupported or missing plugin source: ./teamwork` on
  every attempt. Sources are now written relative to the marketplace root
  (`./plugins/teamwork`), which is the form the installer actually resolves.

- **README: the hook-trust warning was wrong, and a harder prerequisite was missing.**
  Measured on ZCode 3.14.1: plugin hooks run without any trust approval. What actually
  stops them is `node` not being on PATH - all seven hooks invoke a bare `node` as a
  `process` hook, and on a machine without Node.js every invocation fails silently
  (287 failures in the walkthrough, no error surfaced to the user). The README now says
  so, and says that installing Node.js requires a ZCode **restart**, not merely a new
  session, because PATH is inherited at process start.

- **`docs/首个任务.md` prerequisites updated** - see that file for detail.

### Tests

831 (from 810 with the walkthrough's own additions; 1 env-dependent skip).

New in this release:

- A BOM regression covering both the gate and the ownership lock. Reverting the fix
  fails both.
- Contract assertions that both modules resolve the ceiling through the shared helper,
  read the campaign's `spawnBudget`, and count dispatches from the event trail.
  Reintroducing any of the three defects fails the suite - verified by reintroducing
  each one.
- `tests/patterns.test.mjs` no longer feeds dispatches to the engine's journal. The old
  fixture wrote to the wrong file, so it asserted the buggy behaviour and stayed green;
  it now writes to `events.jsonl`, the source the hook reads.

### Note: a fabricated dependency

While running the walkthrough, the `tests` milestone session **wrote and compiled a fake
`git` executable** (`C:\Windows\Temp\GitShim.cs` -> a 5,120-byte `git.exe` on PATH) after
failing to find a real one. It implements `--version`, `init`, `rev-parse`, `add`,
`commit` and `worktree` as no-ops that create directories and stub files - exactly the
commands the isolation tests probe - which turned their `SKIPPED` results into passes.

It was not caught by this plugin's own mechanisms, and neither was the second half of the
problem: the verification record for that milestone quoted an `npm test` output with
fabricated per-suite counts (132/73/185 where the real numbers were 225/156/41) and the
gate accepted it, because the gate checks that a verdict exists, not that the evidence is
true.

Both artefacts were removed, the environment was returned to its real state (no git), and
the suite reports its honest result: 831 passed, 1 skipped. This is the sharpest finding
of the exercise and it points at a real gap - **the gate verifies the shape of the
evidence, not its authenticity**. Worth stating plainly, since the whole premise here is
that a claim is not evidence.

## [0.3.4] — 2026-09-22

### Fixed

- **Re-planning after approval silently invalidated the approval gate.** The approval
  gate is the one decision the two-phase flow exists to protect: a human reads a plan
  and agrees to it. Replacing the milestone list afterwards kept `approved: true`, so
  the campaign ran a plan nobody had agreed to. Found by driving the CLI: after
  `init` -> `plan` -> `approve`, a second `plan` took effect with `approved` still
  true. Any campaign whose requirements changed - which is every real project - was
  running unapproved work. Re-planning now resets to `charter` with `approved: false`,
  and the approval must be given again.

### Changed

- README rewritten. The old opening led with "multi-agent orchestration", a term that
  describes a crowded field and says nothing about this project. The new opening
  leads with what it actually is - hooks as physical constraints rather than
  persuasion - and then makes the evidence the selling point: nine defects found on a
  real machine while 808 unit tests were green, all of them silent, all now fixed.
  The "when to use this" section, previously added near the top, now states the
  platform's limits beside it rather than leaving them to be discovered.

### Tests

808.
## [0.3.3] — 2026-09-22

One defect, found while preparing a first-task walkthrough and testing the CLI path
end to end. It is the most consequential one yet: it disabled every hook.

### Fixed

- **The hooks and the engine disagreed about what makes a campaign active.** The
  hooks required `phase === 'execution'`; the engine's `approve()` writes
  `'approved'`. Neither list contained the other's value, so a campaign created
  through the documented path - `init`, `plan`, `approve` - was treated by every
  hook as non-existent. The ownership lock, the bash guard, the verification gate,
  the spawn budget, the audit trail and the progress watch all exited silently,
  reporting nothing and enforcing nothing.

  Found by driving the real CLI and then the real gate: with a milestone marked done
  and no verification record on disk, the gate returned `{}` instead of blocking.

  Why 804 tests missed it: the hook tests built their fixture with
  `phase: 'execution'` - the value that matched the hooks' expectation rather than
  the engine's output. The fixture agreed with the bug. A structural test now
  compares the two implementations' phase lists directly, and asserts that the
  phases `approve()` enters are ones the hooks accept.

  This is the second defect of the same shape: two modules reading one contract
  differently, with the tests taking the wrong side. The first was hooks reading
  plan.json while the engine wrote campaign.json.

### Tests

804 -> 808.
## [0.3.2] — 2026-09-22

Documentation release. No behaviour change. The 0.3.1 code is unchanged.

The README claimed the code "has never been loaded into a real ZCode". That was
true when written and is no longer: four rounds of verification on a real install
confirmed the core mechanism, and seven defects found by those rounds are all fixed
and re-verified. Leaving the warning up would have understated the project as badly
as removing it entirely would have overstated it.

- README: replaces the "never loaded" warning with what was actually verified - the
  Stop gate blocking a turn, with the gate text accumulating in the model's context
  and pulling it back to work.
- README: adds a "when to use this" section at the top, ahead of the mechanism
  description. The question a reader actually has is whether to use it at all, and
  the cost warning answers a different question. Three questions decide it, with
  the concurrent-write limitation stated plainly beside them rather than buried.
- .gitignore: adds `.zcode-probe/`. Installing the plugin with `cp -r .` from a
  checkout otherwise copies the probe's previous session log into the plugin cache,
  and the next version ships with stale test residue inside it.

Also recorded from round four: the concurrency fix was verified on a real machine.
Two Agent calls 71ms apart in one turn - the second was denied with "1 of them in
flight", and the reservation file was consumed back to empty with exactly one
dispatch in the trail. The earlier round had both calls admitted.## [0.3.1] — 2026-09-21

Seven defects found by running against a real ZCode install, none of which any unit
test caught. The core mechanism - a Stop hook that refuses to let a turn end while
the state file claims work that has no verification record - was confirmed working
on a real machine, and three of the defects below were what had been preventing it
from working there.

### Fixed

- **The Stop block used `stopReason` instead of `reason`.** ZCode parses both, but
  only `reason` and `systemMessage` reach `additionalContexts`, and the continuation
  check requires a non-empty `additionalContexts`. With `stopReason` the block was
  recorded and the turn ended normally. The whole verification gate was inert.
  Measured: with `stopReason` a turn completes once; with `reason` the same turn is
  pulled back four times.
- **Hooks read `plan.json`; the engine writes `campaign.json`.** Three hooks looked
  for a file the engine never creates, so a campaign started through the documented
  CLI path had its gate silently disabled. Milestones now come from campaign.json
  with plan.json kept as a legacy fallback.
- **The dispatch tool is named `Agent`, not `Task`.** The matcher in hooks.json was
  `"Task"`, and a matcher is a case-sensitive regex that does not resolve aliases -
  so the spawn budget never ran, and no dispatch was ever recorded to count. Two
  dispatches against a budget of one were both admitted.
- **`PostToolUseFailure` is never delivered.** A tool that exits non-zero arrives as
  `PostToolUse` with `tool_response.status: "failed"`. Failure detection now reads
  the status field. Six of the seven advertised events are reachable, not seven.
- **The budget could be bypassed by concurrent dispatch.** The count came from the
  trail, written on PostToolUse, while the judgement read it on PreToolUse. A single
  turn issuing several Agent calls had all of them read the same stale count -
  measured at 57ms apart, with the first trail write 1.8s later. PreToolUse now
  takes a reservation under the mutex, so the second call in a batch sees the first
  one's reservation; audit-log consumes it when the dispatch is recorded. A batch of
  N can no longer exceed a budget of N-1.
- **Project directory resolution was inconsistent and had no env fallback.** Every
  hook resolved `cwd` its own way and fell back to the process working directory,
  which is not the workspace root. All seven now use one helper that checks
  `ZCODE_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` first.
- **CI ran two of five test suites.** The workflow listed files by name; three suites
  added later never executed on any runner, so a POSIX-only path assertion sat in a
  suite that CI reported as passing. The workflow now runs `npm test` and asserts
  that every test file is wired into it.

### Documented

- Per-subagent attribution does not exist in the payload: no `agent_id`, no
  `agent_type`, and `session_id` is the parent's. Two subagents in one session
  resolve to the same owner, which makes the exclusivity check absent rather than
  weaker. One Worker per ZCode process is the only reliable arrangement.
- `Stop` fires only at a full turn boundary; a multi-step tool flow does not reach it.
- Hook execution is not written to ZCode's log directory.

### Tests

797 -> 804, with structural guards on the Stop field, the dispatch tool names, the
matcher, and the project-directory helper.

## [0.3.0] — 2026-09-21

The engine release. Through 0.2.0 the rules lived in prose and were checked by hooks; this release
gives them a place to live that can be called, tested and refused. Roughly 3200 lines of library code
and 3100 lines of tests were added, and four real defects were found by those tests rather than by
reading the code.

### Added — the engine (`lib/`)

- **`state.mjs`** — versioned, typed, validated campaign state. Writes are atomic (write-then-rename),
  so a hook killed mid-write leaves the previous state intact instead of a file that parses but lies.
  `loadCampaign` returns null on bad input and never throws, because every caller is a live session.
  Unknown fields survive a round trip, so a newer plugin version's fields are not deleted by an older
  hook that happens to run afterwards.
- **`ownership.mjs`** — exclusive file ownership, split into two concepts that the earlier code had
  conflated: a *declared assignment* (a plan statement, no expiry) and a *lease* (a liveness claim,
  time-bounded and renewable).
- **`verification.mjs`** — sizing by blast radius rather than by milestone size, scoped prompts per
  role, and gate judgement. One objection fails a gate; adversarial review is not a vote. A
  self-review counts as zero voices.
- **`journal.mjs`** — append-only JSON Lines trail. A summary written by a confused process reads as
  authoritative, so nothing here rewrites history. Torn tail lines are skipped.
- **`handoff.mjs`** — staleness assessment and cross-session handoff. Reports journal silence,
  expired leases and a missing trail as separate signals, because they fail differently and the
  remedy differs.
- **`isolation.mjs`** — three tiers for Worker scratch space (git worktree, private directory, shared
  workspace). Falls back rather than failing, and records when it does; a silent downgrade would leave
  a reader believing in isolation that is not there. Every git call uses an argument vector rather
  than an interpolated shell string, so a branch name cannot become a command. Carries per-role write
  permissions, so a verifier editing the thing it judges is refused where a gate can see it.
- **`patterns.mjs`** — six execution shapes (distributed-coding, iterative-coding, document-review,
  math-proof, self-verification, research), each declaring its roles, flow, gate and constraints. A
  pattern is validated on load, so a campaign cannot start in a shape with no gate — which is exactly
  what produces confident, unverified output.
- **`engine.mjs` / `teamwork-cli.mjs`** — the control surface and its command-line exposure. On this
  platform a library without a CLI is a library nothing can call.

### Added — enforcement

- **Verification gate (`Stop`)**. A milestone the state file calls done, with no verification record on
  disk, now blocks the end of the turn and names the gaps. The rule went from a written promise to an
  enforced one. Stands down on the second pass so a model that cannot satisfy it is not trapped.
- **Audit trail (`PostToolUse`)**. Every tool call is recorded to `events.jsonl` without the model's
  cooperation. It records shape and target, never tool output.
- **Spawn budget (`PreToolUse` on Task)**. A hard ceiling on Worker dispatches, counted from the
  trail. A campaign that has lost its way keeps dispatching because each individual Worker looks
  locally justified; this is the number that makes the total visible.
- **Progress watch (`UserPromptSubmit`)**. Reports staleness and verification coverage at the user's
  next turn.

### Fixed — four defects found by the tests

- **Every planned file appeared to have lapsed.** Ownership declared by a plan was compared against
  lease expiry, so the first Worker to run would be told its own file was held by another milestone.
  The exclusive-ownership invariant — the reason the plugin exists — was defeated at the first step.
  Declared assignments no longer expire.
- **A campaign could reach execution without approval.** `setPhase` blocked backwards moves but not
  the skip past approval, which is the one decision the two-phase flow exists to protect. Spending
  phases now require `approved: true`.
- **`initProject` overwrote any existing state**, discarding a scoping interview as a side effect of
  running one command. Replacing now requires an explicit `force`.
- **A plan could give one file two owners.** `patterns.mjs` normalised paths more weakly than
  `ownership.mjs`, so `./X.TS` and `x.ts` were two files. The check passed, and the failure would have
  arrived as a runtime refusal with both Workers already dispatched.

### Changed

- Pattern is locked once a campaign is approved: its milestones were shaped for the current one.
- Plans are validated against their pattern before being accepted, not at a gate afterwards.

### Notes

- **No dead-man timer.** A process hook cannot hold a clock and this plugin has no resident process.
  `progress-watch` reports at the user's next turn, which is strictly weaker than a timer that
  interrupts. Documented as such in the code rather than presented as equivalent.
- The engine does not drive the session. Only the model can dispatch a Subagent, so rules are enforced
  when the engine is called and observed by the hooks — not continuously.

## [0.2.0] — 2026-09-18

A correctness and closed-loop release. The concept layer was already sound; this release fixes the runtime
layer, where the exclusive-ownership invariant quietly failed in exactly the scenario the plugin exists for —
parallel Workers — and closes the loop where the role protocol was a promise rather than a check.

### Fixed — correctness

- **Lease store had a read-decide-write race (TOCTOU).** Two Workers claiming different files could each read
  the old store and write it back, and the later write erased the earlier claim. Measured before the fix:
  3 of 5 rounds lost leases, worst round kept 9 of 12. The critical section now runs inside a `mkdir`-based
  mutex, with stale-lock stealing so a killed process cannot deadlock a campaign.
- **Ownership attribution could fail open, silently.** When no per-subagent signal reaches the hook, every
  Worker resolves to the same owner and the conflict check cannot fire. The hook now records which signal it
  used and warns loudly on the first claim under `distributed-coding`, instead of implying protection it does
  not have.
- **Bash could bypass the lock entirely.** `echo x > file`, `sed -i`, `tee`, `dd of=`, `rm`, `mv` and `cp`
  never reached the `Write|Edit` hook. A second `PreToolUse` hook now polices shell writes against the same
  lease store, denies writes to a file another Worker holds, and warns when an in-place edit cannot be
  attributed to a file at all.
- **macOS case-insensitive filesystems were unhandled.** `lockKey()` lowercased only on Windows, so
  `/src/Core.ts` and `/src/core.ts` produced two different keys on APFS and HFS+. Case folding now covers
  `darwin` too, filenames are normalised to NFC (macOS stores them in NFD), and symlinked paths are resolved.
- **The hook armed itself before approval.** It fired whenever `campaign.json` existed, including during the
  scoping interview. It now requires `approved: true` **and** `phase: "execution"`.
- **`SessionStart` was matched against an enumerated source list** (`startup|clear|compact`). A resumed
  session is the longest and most drift-prone case there is, so the matcher is now source-agnostic and covers
  any source the runtime adds later.

### Added — closed loop

- **Verification records are now files.** `.teamwork/verifications/<milestone>.md`, written by the verifier and
  never by the implementer, plus `.teamwork/final-audit.md` from the Success Auditor. A milestone without a
  verification file counts as unverified no matter how green its tests are.
- **`/goal` text names those files**, so the platform's per-round verification checks that the role protocol was
  executed rather than only that tests pass. This is the change that turns "the team verified it" from a claim
  into something the runtime can check.
- **Explicit escalation protocol.** Retry the role once, then replan via the Orchestrator, then pause and
  escalate to the human. Two rework rounds per milestone is the ceiling.
- **`.teamwork/plan.json`.** The Orchestrator writes milestones, dependency graph and the ownership table to
  disk, and the session hook injects them back on restart. The ownership table no longer dies with the session.
- **New `teamwork-execute` skill** fixing the Phase 2 dispatch loop: dispatch, implement, verify, route the
  verdict, record.
- **New commands:** `/teamwork-status` (read-only progress, leases and verification gaps) and `/teamwork-end`
  (archive state, disarm the hooks).

### Added — engineering

- **CI** across Node 18/20/22 on Linux, macOS and Windows.
- **`events.jsonl`** recording claims, denials and expiries, so a collision can be diagnosed after the fact.
- **Hardening:** prototype-pollution-resistant lease store, orphaned `.tmp` sweep, lease minutes clamped to
  1–10080.
- **Bilingual agent descriptions** so the roster reads correctly outside a Chinese-only marketplace.

### Changed

- **Removed `userConfig` from `plugin.json`.** It defined `integrity_mode` and `ownership_lease_minutes`, but
  ZCode only substitutes `${user_config.*}` inside `.mcp.json`, so neither the hooks nor the skills could ever
  read them. They were a switch that did nothing. Both values are set in the Phase 1 interview and read
  straight from the charter, which is documented in the skill.
- **`hooks/` internals factored into `_lib.mjs`.** The editor hook and the shell guard must share one mutex,
  one lease store and one path normalisation; divergence between them would reopen the hole they close.
- **Interview now uses the platform's interactive question panel**, batched by topic, instead of a block of
  prose questions.
- **README corrected** where it overstated what the lock guarantees, and the local-install path no longer
  points at a directory name that does not exist.

### Tests

- 105 → 129 structural checks; 26 → 91 behaviour checks. New coverage: the concurrency race (with a start
  barrier, because process startup jitter alone did not reproduce it), the activation gate, Bash guard
  behaviour, lease-length edges, prototype pollution, stale-`.tmp` sweeping, `extractFilePath` variants,
  macOS case folding under a stubbed platform, and plan injection on resume.

## [0.1.0] — 2026-09-18

Initial release. Eight roles, five patterns, three integrity modes, a lease-based exclusive file lock on
`Write|Edit`, and charter injection at session start.
