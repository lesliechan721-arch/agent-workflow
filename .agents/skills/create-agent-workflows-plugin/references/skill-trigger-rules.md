# Skill 触发规则

这份说明只讨论 `plugins/<name>/skills/**` 下的 skill 触发规则。运行时 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` 仍由 build 产物生成，不是作者要手动维护的文件。

## 核心结论

Codex 和 Claude Code 的触发开关不是同一套规则：

- Codex 自动触发：`agents/openai.yaml` 的 `policy.allow_implicit_invocation`
- Codex 显式触发：用户写 `$skill-name` 或上层流程传入结构化 skill mention
- Claude Code 用户手动调用：`SKILL.md` frontmatter 的 `user-invocable`
- Claude Code 模型自动调用：`SKILL.md` frontmatter 的 `disable-model-invocation`

不要指望某个平台会读取另一个平台的触发字段。`allow_implicit_invocation` 不影响 Claude Code；`user-invocable` 和 `disable-model-invocation` 不影响 Codex。

## Codex

Codex 选择 skill 时，最先看到的是 skill 的 `name`、`description` 和路径。`description` 要写清楚“做什么”和“什么时候用”，例如“当用户要求提交当前改动、生成或执行 git commit 时”。

`agents/openai.yaml` 里的策略：

```yaml
policy:
  allow_implicit_invocation: false
```

- `true` 或省略：允许自动注入和隐式识别，适合低风险辅助流程。
- `false`：关闭自动注入和隐式识别，但仍可显式调用；适合提交、发布、部署等有副作用的流程。

`allow_implicit_invocation: false` 不是禁用 skill，只是要求用户或上层流程显式触发。

## Claude Code

`SKILL.md` frontmatter 里的两个字段彼此独立：

```yaml
---
name: your-skill
description: 当用户明确要求执行某个流程时，完成该流程。
user-invocable: true
disable-model-invocation: true
---
```

- `user-invocable: true` 或省略：用户可以手动调用。
- `user-invocable: false`：隐藏用户手动入口。
- `disable-model-invocation: false` 或省略：模型可以自动调用。
- `disable-model-invocation: true`：模型不能自动调用，但用户仍可手动调用，前提是 `user-invocable` 不是 `false`。

## 常用配方

### 保守手动触发

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

### 允许 Codex 自动发现

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

### Claude 隐藏用户入口

适合只希望 Claude Code 模型在特定场景下调用的 skill。

`SKILL.md`：

```yaml
---
name: your-skill
description: 在特定场景下由模型调用。
user-invocable: false
---
```

Codex 没有完全等价的“隐藏手动入口”字段；即使写了 `allow_implicit_invocation: false`，显式 `$skill-name` 仍可触发。

## 检查点

- 自动触发不符合预期时，先看 `description` 是否具体，再看 `allow_implicit_invocation`。
- 有副作用的流程默认关掉 Codex 隐式调用。
- 不要把 Claude slash command 当作双端公共协议。
- 不要把 `disable-model-invocation: true` 理解成 Claude 不能手动调用。
