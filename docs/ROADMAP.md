# Teamwork for ZCode — 公开技术路线图 (Roadmap)

本文档持续记录 Teamwork 框架已交付的核心能力、已知局限及面向未来版本的演进规划。

---

## 1. 当前版本 (v0.3.0) 已交付能力

- **T1: 统一 CLI 骨架 (`teamwork.mjs`)**：统一多智能体协作运维命令。
- **T2: 工具产生证据与哈希链**：`run`、`verify`、`final-audit`，消除 Agent 打字式伪造。
- **T3: 用户触发批准关卡**：`UserPromptSubmit` 钩子拦截 `/teamwork-approve`，绑定 `charterHash` 防篡改。
- **T4: 弱归属降级与确定性审计**：无法区分 Worker 时自动降级为串行（`mode.json`），`audit-ownership` 提供 Git 级越权检查（R1-R3）。
- **T5: 唯一完成判定 Gate**：`teamwork.mjs gate` 汇聚 G1-G12 规则，提供确定性退出码。
- **T6: 全流程协同集成**：`session-context.mjs` 自动注入 CLI 路径、降级状态与知识库，所有提示词彻底剔除手写验证文件指令。
- **T7: 进度心跳与交接**：`progress beat`、`progress set`（起止快照）、卡死告警与 `handoff.md`。
- **T8: 归档移出工作目录**：归档迁往 `~/.teamwork-archive/`，`benchmark` 模式下拦截读归档命令。
- **T9: 跨轮知识积累**：`knowledge add` 维护陷阱库与失败路径，会话启动自动注入。
- **T10: 风险自适应验证**：`plan.json` 支持 `risk` 级别，Gate G10 校验最低验证角色组合。
- **T11: 深度路径安全防护**：防御路径穿越（`..`）、符号链接逃逸（symlink escape）、Windows 8.3 短路径及受保护路径变体。
- **T12: 种子缺陷评测夹具**：`tests/evals/` 包含 leak、premise、diverge 三类预置缺陷及自动化运行器。

---

## 2. 当前平台已知局限与应对策略

| 局限项 | 根因 | 当前应对策略 | 未来演进方向 |
|---|---|---|---|
| **单会话内 Worker 身份无法细分** | ZCode PreToolUse 钩子未注入独立的子 agent ID | 自动降级为串行（`mode.json.max_parallel: 1`）并结合 `audit-ownership` 事后审计 | 推动平台在 PreToolUse 中开放 `agent_id` / `subagent_name` 字段 |
| **模型分层缺乏全局开关** | 平台未提供插件级动态模型路由配置 | 在各角色的 `agents/*.md` 中手动指定 `model` | 等待平台支持多模型策略注入 |
| **文件系统防作弊的天然局限** | 同一本地进程或权限下文件可被原生脚本篡改 | 哈希链校验 + Git 差异对比 + 确定性审计，防偷懒式伪造 | 引入只读挂载与隔离沙箱 |

---

## 3. 未来规划 (v0.4.0+)

1. **容器与沙箱隔离支持**：将 Worker 执行环境与 Verifier 执行环境容器化隔离，从操作系统层面杜绝互相读取未授权文件。
2. **多模型矩阵评测自动化**：在 `tests/evals/` 中增加真实 API 调用的多模型对比基准。
3. **交互式 Web 控制面板**：在 ZCode 客户端内呈现实时的多 Agent 协作拓扑、文件租约看板与证据哈希树。
