# Teamwork for ZCode (v0.4.0)

> **100% 对齐 Google Antigravity 多智能体协同编排引擎**  
> 模型的「我做完了」从来不算证据。Teamwork 将工程验证、角色协作与交付质量转化为 OS 进程级物理硬约束。

[![Version](https://img.shields.io/badge/version-0.4.0-brightgreen.svg)](package.json)
[![Antigravity Alignment](https://img.shields.io/badge/Google%20Antigravity-100%25%20Aligned-00F5A0.svg)](#)
[![Tests](https://img.shields.io/badge/tests-932%20passed-success.svg)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-blue.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-purple.svg)](LICENSE)

---

## 🌟 为什么需要 Teamwork？

在复杂软件开发任务中，单智能体往往面临上下文膨胀、幻觉蔓延、假装完成、自圆其说等固有瓶颈：

- **口头宣布完成**：模型在对话中言之凿凿「已修复并通过全部测试」，但实际上根本没有运行测试或提交代码。
- **作弊与桩文件**：模型可能为了通过简单校验而生成空占位函数、伪造测试日志，甚至伪造虚假可执行命令。
- **越界破坏与上下文踩踏**：多步执行过程中，未加保护的核心模块或外部配置文件被意料之外地修改。

**Teamwork 彻底终结了这些问题。**  
它不是一段祈求模型遵守纪律的“提示词”（Prompt），而是基于 **ZCode 钩子机制与 OS 子进程物理约束** 构建的编排内核——**只要物理世界中没有生成真正的验证凭证，模型哪怕说得天花乱坠，收尾操作也必将被进程级拦截拉回**。

---

## 🚀 v0.4.0 核心演进与架构对齐

在最新 **v0.4.0** 中，Teamwork 实现了与 **Google Antigravity 智能体协同编排规范** 的 100% 完整对齐：

```
                              ┌──────────────────────────┐
                              │     User Requirement     │
                              └─────────────┬────────────┘
                                            │
                                  [ Tiered Router ]
                                            │
                 ┌──────────────────────────┼──────────────────────────┐
                 ▼                          ▼                          ▼
          ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
          │   Tier 1     │          │   Tier 2     │          │   Tier 3     │
          │  Agile Duo   │          │Standard Squad│          │Adversarial L3│
          └──────┬───────┘          └──────┬───────┘          └──────┬───────┘
                 │                         │                         │
            Worker+Critic           Lead+Worker+Critic        Lead+Worker+Critic
                 │                         │                  +Architect (Red)
                 └─────────────────────────┼─────────────────────────┘
                                           │
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │          Physical Evidence Engine            │
                    │   • Real-Command Re-verification (Anti-Fake) │
                    │   • Adaptive Payload Sizing (Min 64 Bytes)   │
                    │   • Dynamic 'latest' Evidence Resolution     │
                    │   • Exclusive File Locking Protection        │
                    └──────────────────────┬───────────────────────┘
                                           │
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │      Liquid Glass Real-time Dashboard        │
                    │      Mermaid DAG + Budget & Token Ledger     │
                    └──────────────────────────────────────────────┘
```

### 1. 三级自适应敏捷路由 (Tiered Agile Router)
告别一刀切的重型团队架构，根据任务复杂度和文件规模自动分流：
- **L1 极速双人组 (Agile Duo: Worker + Critic)**：  
  专为中小重构、单文件 Bug 修复、轻量脚本编写设计。跳过冗长规划阶段，直出代码并即刻交由审计员严格复验，0 沟通损耗。
- **L2 标准战术组 (Standard Squad: Lead + Worker + Critic)**：  
  经典 Antigravity 三角色对齐架构。Team Lead 负责战术拆解与里程碑立项，Worker 专注核心实现，Critic 负责回归测试与交付裁决。
- **L3 重装对抗组 (Full Adversarial: Lead + Worker + Critic + Architect)**：  
  应对高危模块改造与全系统架构攻坚。引入红队对抗思维，Critic 针对边缘边界进行破坏性测试，Architect 对全局依赖与安全性最终签字。

### 2. 真机命令二次复测与反作弊引擎 (Anti-Fake Evidence)
- **真子进程重执行**：针对模型伪造虚假测试脚本或虚假 `git` 日志，Critic 引擎具备真机二次调用 (`reverifyCommand`) 能力，由系统真实拉起 OS 进程验证退出码。
- **自适应代码门限 (`MIN_CODE_DELIVERABLE_BYTES = 64`)**：杜绝盲目的 2KB 死板下限限制，精准放行短小精悍的修复，同时强力拦截无实际逻辑的空桩文件。
- **动态证据链 (`evidence: latest`)**：智能体在声明交付时支持关联动态生成的最新日志证据，彻底解决硬编码文件哈希在跨步重试中失效的顽疾。

### 3. OLED 纯黑与微透物理毛玻璃大盘 (Liquid Glass Dashboard)
- 遵循顶级金融与量化级工业设计规范，提供 OLED 纯黑背景 (`#000000`) 与半透明微折射毛玻璃视觉享受。
- 自动提取状态并实时编译为 **Mermaid 状态机与依赖 DAG**，进度、心跳、文件独占所有权、派发预算一目了然。

---

## 🛠️ 命令体系与使用指引

在 ZCode 中，Teamwork 已原生注册为斜杠指令，直接键入即可开始高效协作：

### 1. 发起协同研发：`/teamwork`
```bash
# 智能自适应模式（自动研判任务复杂度）
/teamwork "重构认证模块并增加双因素鉴权，确保单元测试覆盖率达95%"

# 强制指定敏捷级别 (L1 敏捷双人 / L2 标准战术 / L3 重装对抗)
/teamwork --tier 1 "修复 lib/parser.mjs 第 45 行空指针异常"
/teamwork --tier 3 "升级核心存储引擎并引入跨集群容灾同步"
```

### 2. 洞察实时战况：`/teamwork-status`
无论任务正在推进还是等待审核，随时输入：
```bash
/teamwork-status
```
控制台与会话区将瞬时渲染出当前团队的：
- **任务拓扑与依赖泳道图 (Mermaid DAG)**
- **智能体实时心跳与在席状态**
- **文件独占写锁分布图**
- **证据审计流水与验证摘要**

### 3. 安全交付封板：`/teamwork-end`
```bash
/teamwork-end
```
触发底层物理收尾门禁。若存在未验证里程碑、非法文件修改或残留悬挂任务，系统将拒绝关闭并向主控回传拦截证据，直至所有约束被物理清偿。

---

## 🛡️ 智能体角色与物理硬约束矩阵

| 角色 | 核心职责 | 约束边界与安全防线 |
| :--- | :--- | :--- |
| **Team Lead (主控)** | 任务拆分、拓扑排期、全局资源把控 | 严格受派发预算上限（Dispatch Budget）约束，杜绝死循环派发 |
| **Worker (工程)** | 生产代码编写、接口实现、单元测试开发 | 遵循文件独占写锁机制，禁止写入未经授权的非分配模块 |
| **Critic (审计)** | 独立执行测试、证据采样、物理真伪裁决 | 必须在真实系统执行指令并产出带哈希的不可伪造证据文件 |
| **Architect (架构)** | 顶层契约维护、架构反退化、安全合规签字 | 仅在 L3 模式中激活，对系统契约性破坏具备一票否决权 |

### 七大守护进程拦截机制

1. **PreToolUse 拦截**：派发次数超标即刻挂起；并发 Worker 超限即刻拦截；跨区写文件直接在 OS 层拒绝。
2. **PostToolUse 审计**：每一次工具执行的入参与出参均实时计入不可篡改的 `.zcode/teamwork/audit/` 物理审计日志。
3. **Stop 强门禁拉回**：只要 `campaign.json` 标记完成但磁盘上缺乏对应的验证记录，收尾调用立刻抛出硬性错误，逼迫模型回归修复。

---

## 📊 架构验证与测试表现

本项目经过严格的工程化建设，具备完备的测试用例体系：

```powershell
# 运行全量 932 个自动化测试用例
npm test
```

```text
✔ tests/router.test.mjs           (Tiered Agile Routing & Strategy)
✔ tests/evidence.test.mjs         (Physical Execution & Anti-Cheating Engine)
✔ tests/dashboard.test.mjs        (Liquid Glass UI & Mermaid DAG Generator)
✔ tests/invariants.test.mjs       (PreToolUse/Stop Hook Enforcement)
✔ tests/concurrency.test.mjs      (Lock contention & Race-condition Hardening)
✔ tests/enhancements.test.mjs     (v0.4.0 Google Antigravity Alignment Suite)

Total Tests: 932 passed, 0 failed, 100% compliance
```

---

## 📦 环境要求与本地安装

### 环境准备
- **Node.js**：`>= 18.0.0`（请确保 `node` 已添加到系统的环境变量 `PATH` 中）。
- **ZCode**：支持 ZCode CLI / Desktop 任意主流版本。

### 一键部署
插件已预置在 ZCode 官方缓存与扩展空间，克隆或下载后运行：
```powershell
# 安装依赖
npm install

# 本地联调或查看 CLI 大盘
node bin/teamwork.mjs dashboard
```

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 发布。欢迎社区极客、量化团队与全自主智能体研究者共同探索多智能体协同工程的物理前沿！
