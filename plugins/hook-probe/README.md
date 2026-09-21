# hook-probe

> **开发者工具**，不是功能插件。只在排查 hook 行为时安装，日常用 Teamwork 不需要它。

## 它做什么

把 ZCode 递给第三方插件的**每一个 hook 事件**原样记下来，同时提供几个模式去实测「返回值到底生不生效」。

## 用法

1. 安装本插件（marketplace 里选 `hook-probe`）
2. **开一个新会话**（hook 配置是会话启动时快照的）
3. 随便做点操作：改一个文件、跑一条命令、让模型回答一句话
4. 读取日志：

```bash
cat .zcode-probe/events.jsonl      # 所有事件
cat .zcode-probe/first-seen.json   # 首个事件 + 字段清单
```

## 模式（可选）

写 `.zcode-probe/mode.json` 切换，例如：

```json
{ "mode": "block" }
```

| 模式 | 作用 | 验证什么 |
| --- | --- | --- |
| `observe`（默认） | 只记录，返回空 | 哪些事件真的会送到第三方插件 |
| `block` | `Stop` 时回 `{decision:"block"}` | **第三方能否否决本轮收尾** |
| `deny` | `PreToolUse` 时回 `permissionDecision:"deny"` | 拒绝通道是否生效 |
| `rewrite` | `PreToolUse` 回 `updatedInput`（带 `_probe_rewritten` 标记） | 入参改写是否生效 |
| `context` | `SessionStart`/`UserPromptSubmit` 注入 `additionalContext` | 上下文注入是否送达模型 |

> 改模式后需要**新开会话**（或至少下一个事件）才生效。

## 要回答的问题

- [ ] 7 个事件是否全部送达第三方插件？（还是仅内建插件可用）
- [ ] `Stop` + `decision:"block"` 能否拦住收尾？
- [ ] `PreToolUse` + `permissionDecision` 能否拒绝？
- [ ] `updatedInput` 对哪些工具有效？
- [ ] `additionalContext` 是否真的进了模型上下文？

## 安全

- 全部只读 + 追加写 `.zcode-probe/`，**不修改任何业务代码**
- 任何异常都被吞掉，**绝不影响它正在观察的会话**
- 排查完请卸载，避免日志膨胀

## 许可

MIT
