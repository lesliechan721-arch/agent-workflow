# Skill 触发配置配方

这份文档只讨论 `plugins/<name>/skills/**` 下的 skill 触发配置。两个平台的触发开关完全独立，互不读取。

## Codex 触发字段

配置位置：`agents/openai.yaml` 的 `policy.allow_implicit_invocation`。

- `true` 或省略：允许自动注入和隐式识别，适合低风险辅助流程。
- `false`：关闭自动注入和隐式识别，但仍可通过 `$skill-name` 或结构化 mention 显式触发。

`description` 要写清楚"做什么"和"什么时候用"，这影响 Codex 的 skill 发现和匹配质量。

## Claude Code 触发字段

配置位置：`SKILL.md` frontmatter，两个字段彼此独立。

| 字段 | 默认值 | 效果 |
|------|--------|------|
| `user-invocable: true` 或省略 | true | 用户可手动调用 |
| `user-invocable: false` | — | 隐藏用户手动入口 |
| `disable-model-invocation: false` 或省略 | false | 模型可自动调用 |
| `disable-model-invocation: true` | — | 模型不能自动调用，但用户仍可手动调用 |

`allow_implicit_invocation` 不影响 Claude Code；`user-invocable` / `disable-model-invocation` 不影响 Codex。

---

## 配方 1：保守手动触发

适合 `commit`、`deploy`、`release` 等有副作用的流程。

`SKILL.md`：

```yaml
---
name: your-skill
description: 当用户明确要求执行某个流程时，完成该流程。
user-invocable: true
disable-model-invocation: true
---
```

`agents/openai.yaml`：

```yaml
policy:
  allow_implicit_invocation: false
```

## 配方 2：允许 Codex 自动发现

适合低风险、辅助型、说明型 skill。

`SKILL.md`：

```yaml
---
name: your-skill
description: 当用户需要某类低风险辅助工作时，执行对应工作流。
---
```

`agents/openai.yaml`：

```yaml
policy:
  allow_implicit_invocation: true
```

## 配方 3：Claude 隐藏用户入口

适合只希望 Claude Code 模型在特定场景下调用的 skill。

`SKILL.md`：

```yaml
---
name: your-skill
description: 在特定场景下由模型调用。
user-invocable: false
---
```

Codex 没有完全等价的"隐藏手动入口"字段；即使 `allow_implicit_invocation: false`，显式 `$skill-name` 仍可触发。

---

## 调试检查点

- 自动触发不符合预期 → 先检查 `description` 是否具体，再看 `allow_implicit_invocation`。
- 有副作用的流程 → 默认关掉 Codex 隐式调用。
- 不要把 Claude slash command 当作双端公共协议。
- `disable-model-invocation: true` 不等于 Claude 不能手动调用（用户仍可调用）。
