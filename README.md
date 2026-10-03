# Teamwork for ZCode (v0.5.0)

> **100% 完整对齐 Google Antigravity 多智能体协同编排引擎**  
> 模型的「我做完了」从来不算证据。Teamwork 将工程验证、角色协作、死锁自愈与交付质量转化为 OS 进程级物理硬约束。

[![Version](https://img.shields.io/badge/version-0.5.0-brightgreen.svg)](package.json)
[![Antigravity Alignment](https://img.shields.io/badge/Google%20Antigravity-100%25%20Aligned-00F5A0.svg)](#)
[![Tests](https://img.shields.io/badge/tests-969%2B%20passed-success.svg)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-blue.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-purple.svg)](LICENSE)

---

## 🌟 为什么需要 Teamwork？

在长程与复杂软件工程任务中，传统多智能体框架往往面临上下文膨胀、幻觉蔓延、假装完成、自圆其说等固有瓶颈：

- **口头宣布完成**：模型在对话中言之凿凿「已修复并通过全部测试」，但实际上根本没有运行测试或提交代码。
- **作弊与假桩文件**：模型可能为了通过简单校验而生成空占位函数、编造终端输出日志，甚至伪造虚假可执行命令（如实测记录中现场编译伪造的 `git.exe` 假桩）。
- **越界破坏与并发踩踏**：多个 Worker 并行修改相同文件导致代码覆盖、Git 冲突与逻辑损坏（TOCTOU 竞态）。
- **失联 Worker 静默假成功**：上游网络中断或超时切断导致子代理挂死，系统却误以为全盘通过。

**Teamwork 彻底终结了这些问题。**  
它不是一段祈求模型自觉遵守纪律的软性提示词（Prompt），而是基于 **ZCode 钩子机制与 OS 子进程物理硬约束** 构建的分布式协同内核——**只要物理世界中没有生成真正的验证凭证与实机物证，模型哪怕说得天花乱坠，收尾操作也必将被进程级拦截拉回**。

---

## 🚀 v0.5.0 核心演进：全面对齐 Google Antigravity

在 **v0.5.0** 中，Teamwork 实现了与 **Google Antigravity Teamwork 内置架构** 的全维度深度对齐：

```
                    ┌──────────────────────────────┐
                    │       User Interaction       │
                    └──────────────┬───────────────┘
                                   │ /teamwork
                                   ▼
                    ┌──────────────────────────────┐
                    │       PROJECT SENTINEL       │
                    │  • ORIGINAL_REQUEST.md (🔒)   │
                    │  • Active Watchdog Daemon    │
                    │  • Deadlock Auto-Healing     │
                    └──────────────┬───────────────┘
                                   │ Specialized Routing
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│    SWE Light     │      │     General      │      │ Document Review  │
│ (Anti-decompose) │      │   Orchestrator   │      │  (RSA Tree DAG)  │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         │ Single Line             │ Stage DAG / Blackboard  │ Tournament Tree
         ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Worker ── Critic │      │ Worker / Test-W  │      │ Segment Analysts │
│                  │      │ Spec-M / Chall   │      │ Synthesizer      │
└──────────────────┘      └────────┬─────────┘      └──────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │    Physical Evidence & Gate  │
                    │  • File Ownership Lock       │
                    │  • reverifyCommand (Sandbox) │
                    │  • Self-Succession (_gen<N>) │
                    │  • Victory Auditor Gate      │
                    └──────────────────────────────┘
```

### 1. 主动存活检测与死锁自愈看门狗 (Sentinel Watchdog & Auto-Healing)
对齐 Antigravity Sentinel 监控守护体系：
- **存活心跳与停滞研判**：主动巡检 `events.jsonl` mtime、开放里程碑持续时间；超过阈值生成阶梯式 Nudge 告警。
- **死锁自动修复 (Auto-Heal)**：自动检测并释放过期的文件租约（Lease Pruning），回收超时遗留的子代理预留令牌（Abandoned Reservations），化解 Worker 异常退出引发的系统锁死。
- **常驻后台模式**：支持一键运行 `npm run watchdog` 或 `--daemon` 守护模式。

### 2. 自我继承协议与永久退役铁律 (Self-Succession Protocol)
对齐 Antigravity 长程会话交接标准：
- **永久退役铁律 (Permanently Retired)**：一旦主控由于预算上限或上下文过载执行交接，上一代实例立即标记永久报废，严禁复用，从物理上杜绝历史上下文累积污染与幻觉漂移。
- **无缝换代接力**：自动生成不可变的归档数据 `.teamwork/handoffs/gen-<N>.json` 与供后继者阅读的 `BRIEFING.md`，平滑激活 `_gen<N+1>` 代代理。

### 3. 五大 Antigravity 专业化路由路径 (Specialized Routing Paths)
- **SWE Light (`swe-light`)**：单文件/自包含快速修复。遵循**反拆分铁律（Does NOT decompose）**，单一实现者配合审校者对决，节省 80%+ Token。
- **General (`general`)**：常规大型软件工程与跨模块重构，里程碑拓扑拆解，配备独立测试编写者。
- **Document Review (`document-review`)**：论文、RFC 与规范文档评审，基于递归自聚合（RSA）锦标赛树进行并行分段审校。
- **Math & Proof (`math-proof`)**：数学定理推导与形式化证明，Colosseum 多阶段流水线严格查验逻辑漏洞。
- **Adversarial Quant (`adversarial-quant`)**：量化模型、金融 Alpha 挖掘、红队安全、共识算法等极端高敏场景，激活全部 11 角色武装。

### 4. 专职黑板架构 (Shared Blackboard Architecture)
- 中心黑板 `.teamwork/blackboard.json` 串行汇总各特工的公共输出与接口契约。
- 提供原子提交（`postUpdate`）、审计留痕与分类检索（`queryBlackboard`），彻底解决多智能体并发写状态冲突。

### 5. 意图绝对权威记录 (`ORIGINAL_REQUEST.md`)
- 在项目根目录以 **Append-Only（只增不减）** 形式记录用户原始需求与时间戳。
- 作为整个系统不受上下文截断、崩溃和代理换代影响的**终极真理源（Ground Truth）**，终审裁决必须对照此文件做实质复核。

---

## 🛡️ 11 大特种智能体角色与权限矩阵

Teamwork 彻底摒弃“单一全能 Agent 自己审自己”的模式，采用严格的角色权限隔离矩阵：

| 角色 | 权限与工具矩阵 | 核心职责与设计原则 |
| :--- | :--- | :--- |
| **Sentinel (哨兵)** | Read, Grep, Glob, TodoWrite | 战役起点关卡，审查宪章完整性与完整性模式，监控存活心跳，严禁写业务代码 |
| **Orchestrator (编排)** | Read, Grep, Glob, TodoWrite | 战役依赖拆解与文件排他所有权划分；**硬约束：NEVER write code** |
| **Explorer (探索)** | Read, Grep, Glob, WebFetch, WebSearch | 只读调研代码库、定位接口与绘制调用拓扑，严禁 Edit/Write/Bash |
| **Worker (工人)** | Read, Grep, Glob, Edit, Write, Bash, TodoWrite | **唯一生产代码编写者**，严格限制在分配的文件租约范围内 |
| **Test Writer (测试编写)** | Read, Grep, Glob, Edit, Write, Bash, TodoWrite | **独立编写全面测试用例**（仅限测试目录），严禁修改业务生产代码，杜绝自我迎合 |
| **Spec Miner (规范挖掘)** | Read, Grep, Glob, WebFetch, WebSearch, TodoWrite | 只读从规范、文档、RFC、头文件、Proto 中提取权威接口与断言契约 |
| **Critic (缺陷审查)** | Read, Grep, Glob, Bash *(禁写)* | 攻击**实现细节**：边界未处理、空指针、内存泄漏、契约破坏 |
| **Challenger (红队证伪)** | Read, Grep, Glob, Bash, WebFetch, WebSearch *(禁写)* | 攻击**方案前提**：未来函数、过拟合、弱基准套利、虚假因果链 |
| **Empirical Challenger (混沌红队)** | Read, Grep, Glob, Bash, Edit, Write *(仅限fuzz目录)* | 构造模糊测试（Fuzzing）、反例生成器与极限破坏测试，用客观事实攻击 Worker 代码 |
| **Auditor (独立复现)** | Read, Grep, Glob, Bash *(禁写)* | 从全新干净状态真实复跑命令与物证，绝不信任 Worker 的汇报文本 |
| **Success Auditor (收官终审)** | Read, Grep, Glob, Bash *(禁写)* | **全战役收官终审强制门禁**，对照 `ORIGINAL_REQUEST.md` 进行零信任三阶段复测 |

---

## 🛠️ 命令体系与使用指引

在 ZCode / CatPaw 中，Teamwork 已原生注册为斜杠指令，直接键入即可开始高效协作：

### 1. 发起协同研发：`/teamwork`
```bash
# 智能自适应模式（自动研判任务复杂度并匹配 5 大专业化路由）
/teamwork "重构认证模块并增加双因素鉴权，确保单元测试覆盖率达95%"

# 强制指定敏捷级别或任务路径
/teamwork --tier 1 "修复 lib/parser.mjs 第 45 行空指针异常"
/teamwork --tier 3 "升级核心量化交易撮合引擎并引入模糊反例测试"
```

### 2. 洞察实时战况：`/teamwork-status`
```bash
/teamwork-status
```
终端与看板瞬时渲染出：
- **任务拓扑与依赖泳道图 (Mermaid DAG)**
- **智能体实时心跳与在席状态**
- **文件独占写锁分布图**
- **证据审计流水与验证摘要**

### 3. 实时看门狗与终端大盘：
```bash
# 单次运行健康巡检与死锁自愈
npm run watchdog

# 启动 OLED 纯黑实时监控大盘 (2s 动态刷新)
npm run watch
```

### 4. 安全交付封板：`/teamwork-end`
```bash
/teamwork-end
```
触发底层物理收尾门禁。若存在未验证里程碑、非法文件修改或残留悬挂任务，系统将拒绝关闭并向主控回传拦截证据，直至所有约束被物理清偿。

---

## 📊 架构验证与测试表现

本项目采用 **零第三方依赖（Zero External Dependencies）** 架构，完全基于 Node.js 原生标准库实现，测试集覆盖并发竞态、边界恢复、Frontmatter 契约、防作弊验证与看门狗自愈：

```bash
# 运行全量自动化测试套件
npm test
```

```
======================================================================
  PASS  frontmatter.test.mjs        (267 tests)
  PASS  hooks.test.mjs              (86 tests)
  PASS  lib.test.mjs                (112 tests)
  PASS  engine.test.mjs             (167 tests)
  PASS  patterns.test.mjs           (145 tests)
  PASS  evidence.test.mjs           (60 tests)
  PASS  concurrency.test.mjs        (39 tests)
  PASS  enhancements.test.mjs       (9 tests)
  PASS  antigravity-alignment.test  (37 tests)
  PASS  journal-boundary.test.mjs   (47 tests)
----------------------------------------------------------------------
  TOTAL: 969+ passed, 0 failed (100% Green)
======================================================================
```

---

## 📄 开源许可

本项目基于 [MIT](LICENSE) 许可证开源。
