# Teamwork 基准评测模式与防作弊机制 (Benchmark Mode)

Teamwork 支持三种完整性模式（`development`、`demo`、`benchmark`），在开工前由访谈确定并写入 `.teamwork/campaign.json` 的 `integrity_mode` 字段。

---

## 1. 三种模式定义

| 模式 | 适用场景 | 规则约束 | Gate (G9) 判定 |
|---|---|---|---|
| `development` | 快速原型、日常迭代 | 允许临时妥协，但必须记录；支持 manual_fallback 批准 | 非 Git 目录放行并输出 WARNING |
| `demo` | 展示可复现成果 | 必须能由外部从干净状态完全复现；必须有自动化证据 | 必须基于真实 Git 仓库 |
| `benchmark` | 算法测评、论文实验、基准对比 | **最严防作弊级别**；严格禁止参考历史，标准库优先 | 非 Git 仓库一律判 FAIL |

---

## 2. Benchmark 模式的核心硬性规则

在 `integrity_mode: "benchmark"` 下，系统实施以下防御：

1. **只准使用语言标准库**：
   不得引入测试生成辅助库、Mock 框架或为了通过测试特制的第三方工具。
2. **禁止逆向硬编码期望值**：
   严禁根据实际运行产物直接反填期望值；严禁撰写只断言"当前输出是什么"的无牙测试。
3. **隔离历史归档（防跨任务作弊）**：
   - 团队历史上曾出现 Agent 引用遗留在工作区内的历史会话或历史归档从而导致基准跑分虚假提升的问题。
   - 在 `benchmark` 模式下，`bash-guard.mjs` 对任何尝试通过命令行读取历史归档路径（`~/.teamwork-archive` 或 `.teamwork/history`）的工具（如 `cat`、`grep`、`rg`、`type`、`python` 等）直接执行 **DENY** 拦截。
   - `session-context.mjs` 永不向新会话注入归档内容。
   - `auditor` 的审计清单中强制检查"是否存在参考历史 campaign 偷跑数据"。
4. **所有权确定性审计 (G9)**：
   必须基于真实 Git 提交历史运行 `teamwork.mjs audit-ownership`。如果工作区不在 Git 控制之下，Gate 判定直接挂掉（FAIL）。
