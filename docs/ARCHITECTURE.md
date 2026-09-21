# Teamwork for ZCode — 系统架构与底层机制 (v0.3.0)

本文档面向深入了解 Teamwork 运行机制、安全模型与防作弊体系的开发者。

---

## 1. 核心架构设计

Teamwork 在 ZCode 的扁平化子代理（Subagent）环境与扩展机制之上，构建了一套多智能体协同运行系统。整体架构由以下关键层次组成：

```
+-----------------------------------------------------------------------+
|                            User & Goal Mode                           |
|      (/teamwork -> /teamwork-approve -> /teamwork-status -> gate)      |
+-----------------------------------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------+
|                           Role Protocol (8 Agents)                    |
|   Sentinel -> Orchestrator -> Explorer / Worker -> Verifiers -> S-Aud |
+-----------------------------------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------+
|                    Teamwork CLI Tooling (teamwork.mjs)                |
|    run (hash chain) | verify | final-audit | audit-ownership | gate   |
+-----------------------------------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------+
|                       ZCode Hook Security Layer                       |
|   SessionStart  | UserPromptSubmit | PreToolUse (Write|Edit) | Bash   |
+-----------------------------------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------+
|                         State & Filesystem (.teamwork/)               |
|  campaign.json | approval.json | plan.json | ownership.json | evidence|
+-----------------------------------------------------------------------+
```

---

## 2. 状态生命周期与武器化条件 (Arming Invariants)

在 Teamwork 中，写锁与安全守卫不会对普通非 campaign 项目生效。
为防止 agent 自己批准自己或在访谈期间误触发，系统设置了严格的武器化条件 `isArmed(projectDir)`：

1. `.teamwork/campaign.json` 存在；
2. `campaign.approved === true`；
3. `campaign.phase === "execution"`；
4. `.teamwork/approval.json` 存在且格式合法；
5. `approval.charter_sha256 === charterHash(campaign)`。

### 宪章哈希计算与失效防护
宪章哈希对以下核心字段进行键排序（key-sorted deep canonical JSON）后计算 SHA-256：
- `objective`, `integrity_mode`, `pattern`, `working_directory`, `requirements`, `out_of_scope`, `verification_method`, `acceptance_criteria`, `ownership_lease_minutes`.

一旦人类批准后有人（或 agent）改动了上述任何核心字段，`isArmed` 立即失效，钩子自动转为 inert（空转），并在 `.teamwork/events.jsonl` 中记录且仅记录一次 `approval_invalidated` 事件。后续所有修改必须通过再次核准才能武装。

---

## 3. 文件独占锁协议 (Exclusive File Ownership)

### 3.1 跨平台目录互斥锁 (Directory Mutex)
- 锁路径：`.teamwork/.lock/`
- 原子性保证：基于 `fs.mkdirSync()` 在所有操作系统（POSIX 与 Windows）上的原子原语。
- 防死锁 (Stale Lock Stealing)：若持锁进程崩溃，超过 10 秒（`MUTEX_STALE_MS`）的锁将被下一个进程强制回收。

### 3.2 租约模型 (Lease Store)
- 租约记录于 `.teamwork/ownership.json`。
- 租约有时限（`ownership_lease_minutes`，默认 10 分钟，限制在 1~10080 分钟）。超时的租约自动被 prune 清理，防止崩溃的 Worker 永久锁死文件。

### 3.3 路径规范化 (lockKey)
- 跨平台大小写不敏感：在 Windows 和 macOS 上强制小写化。
- Unicode 规范化：macOS 文件系统默认使用 NFD，统一转换为 NFC。
- 符号链接解析：通过 `realpathBestEffort` 解析真实路径，彻底阻断利用符号链接绕过目录范围（symlink escape）的企图。

---

## 4. 工具产生证据与 SHA-256 哈希链

Teamwork 彻底废除了"由 Agent 口头贴输出"作为验证证据的做法，转为由命令执行工具强制落盘。

### 4.1 `teamwork.mjs run -- <command>`
- 执行命令并保留原始退出码。
- 捕获 stdout/stderr 前尾 32KB（避免上下文爆炸）。
- 生成全局递增防碰撞的证据 ID：`ev-<UTC时间戳>-<6位随机hex>`。
- 记录 git HEAD 与 dirty 状态。

### 4.2 哈希链存储 (`.teamwork/evidence/<UTC日期>.jsonl`)
每条证据日志包含前一条的哈希 `prev_hash`，并计算当前行哈希：
`hash = sha256(prev_hash + canonicalJson(entry_without_hash))`
- 第 1 条记录的 `prev_hash` 为全零串（64 个 0）。
- 日志目录下的所有日期文件按文件名和行顺序构成一条全局单向哈希链。
- 任意篡改、删除或插入单行，`verifyEvidenceChain` 校验将立即失败。

---

## 5. 确定性完成判定 (Gate Invariants G1-G12)

运行 `teamwork.mjs gate [--json]` 会对整个工作区状态进行 12 项确定性检查：

- **G1**: 宪章存在、已批准且哈希一致；
- **G2**: 计划存在、Sentinel 为 CLEARED，所有里程碑均为 done；
- **G3**: 每个里程碑包含其 `verified_by` 规定的每个角色的验证记录；
- **G4**: 验证记录结构合法，结论在角色允许的通过集（`SOUND`, `SURVIVED`, `REPRODUCED`）内；
- **G5**: 验证引用的证据 ID 在 `.teamwork/evidence/**` 中存在，且哈希链完整有效；
- **G6**: 证据时间戳不早于对应里程碑修改文件的最后修改时间（mtime 不陈旧）；
- **G7**: 验证角色必须独立于实现者；
- **G8**: `final-audit.md` 存在、结论为 `ACHIEVED`，且包含有效证据；
- **G9**: 运行所有权审计 `ownership-audit.json`，结果必须为 `PASS`；
- **G10**: 若里程碑定义了 `risk` 字段，验证角色集合必须满足最低风险层级；
- **G11**: `progress.json` 中无心跳超时卡死的里程碑；
- **G12**: 事件日志一致性检查。

---

## 6. 诚实可信边界说明

> **安全边界声明**：
> 在同一文件系统内，具有代码编辑权限的本地 Agent 在理论上可以通过任意原生脚本篡改磁盘上的任何文件。
> Teamwork 的机制设计目标是：**消除偷懒式、顺手式、无意识的伪造与幻觉，将原本靠约定的软规范提升为高阻力的机械化卡口**。它不是用来抵御拥有 root 权限的主动对抗性恶意攻击者，而是确保合规流程可自愈、可追溯、可审计。
