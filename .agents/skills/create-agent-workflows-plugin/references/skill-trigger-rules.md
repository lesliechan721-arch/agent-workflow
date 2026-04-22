# Skill 自动 / 手动触发规则

## 先看结论

Codex 和 Claude Code 的触发开关不是一套语义：

- Codex 真正控制“自动触发”的字段是 `agents/openai.yaml` 里的 `policy.allow_implicit_invocation`。
- Claude Code 不读取 `agents/openai.yaml`。它看的是 `SKILL.md` frontmatter 里的 `user-invocable` 和 `disable-model-invocation`。
- `user-invocable`、`disable-model-invocation` 对 Codex 没有已确认的运行时效果。
- `allow_implicit_invocation` 对 Claude Code 没有已确认的运行时效果。

## Codex 规则

Codex 只从 `SKILL.md` frontmatter 读取这些触发相关信息：

- `name`
- `description`
- `metadata.short-description`

Codex 会从 `agents/openai.yaml` 读取：

- `policy.allow_implicit_invocation`
- `interface.*`
- `dependencies.*`

Codex 没有解析 `user-invocable` 或 `disable-model-invocation` 的代码路径；不要指望这两个字段改变 Codex 行为。

### Codex 的自动触发

- `policy.allow_implicit_invocation: true` 或省略不写：
  这个 skill 会进入线程启动时的 Skills 列表，也会进入脚本目录 / `SKILL.md` 文档路径的隐式识别索引。
- `policy.allow_implicit_invocation: false`：
  这个 skill 不会被默认注入模型上下文，也不会参与 Codex 的命令级隐式识别。

这里的“命令级隐式识别”指 Codex 在执行命令时，如果命令是在运行 skill 自带脚本，或直接读取该 skill 的 `SKILL.md`，会把它记为一次隐式 skill 调用。

### Codex 的手动 / 显式触发

- 即使 `allow_implicit_invocation: false`，skill 仍然可以被显式调用。
- Codex 的显式触发入口是：
  - 用户消息里的 `$skill-name`
  - 结构化 skill mention
- 这条路径按“已加载 skill + 未被禁用”处理，不看 `allow_implicit_invocation`。

所以在 Codex 里：

- `allow_implicit_invocation: false` 不等于“禁用 skill”
- 它只等于“关闭自动注入和隐式识别，保留显式调用”

### Codex 的描述字段为什么重要

Codex 在线程启动时只把 `name + description + file path` 放进 Skills 指令区。模型是否会主动选中某个 skill，首先靠这段描述。

因此要让 Codex 更容易自动触发：

- `description` 里要明确写“做什么”和“什么时候用”
- 直接写用户意图词，比如“当用户要求提交当前改动、生成或执行 git commit 时”

如果描述太泛，Codex 即使能看到 skill，也不容易选中。

## Claude Code 规则

Claude Code 的 plugin skill 和普通 skill，触发语义一致。

### Claude Code 的用户手动触发

- `user-invocable: true` 或省略不写：
  用户可以直接输入 `/skill-name`。
- `user-invocable: false`：
  用户不能直接输入 `/skill-name`，Claude 会把它当成隐藏 skill。

### Claude Code 的模型自动调用

- `disable-model-invocation: false` 或省略不写：
  Claude 可以通过 `SkillTool` 调用这个 skill。
- `disable-model-invocation: true`：
  Claude 不能通过 `SkillTool` 调这个 skill，但用户仍然可以手动 `/skill-name`，前提是 `user-invocable` 不是 `false`。

所以在 Claude Code 里：

- `user-invocable` 控制“用户能不能手动调”
- `disable-model-invocation` 控制“模型能不能自动调”

这两个开关是正交的，不要混成一个。

### Claude Code 不看什么

Claude Code 不读取 `agents/openai.yaml` 或 `policy.allow_implicit_invocation`。不要指望只改这两个配置就改变 Claude Code 的 skill 触发方式。

## 常用配置配方

### 1. 双端都保守，优先手动 / 显式触发

适合 `commit`、`deploy`、`release` 这类有副作用的流程。

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

效果：

- Codex：不会自动注入，但用户或上层流程可以显式提 `$your-skill`
- Claude Code：用户可 `/your-skill`，模型不能自动调

这也是当前仓库脚手架默认给 Codex 生成 `allow_implicit_invocation: false` 的原因：先走保守基线，再按需求打开自动触发。

### 2. 希望 Codex 也能自动发现并主动使用

适合低风险、辅助型、说明型 skill。

`SKILL.md`：

- `description` 写清楚“什么时候用”
- `disable-model-invocation` 保持缺省或显式写 `false`

`agents/openai.yaml`：

```yaml
policy:
  allow_implicit_invocation: true
```

也可以省略 `policy.allow_implicit_invocation`，Codex 默认同样按允许处理；但在这个仓库里，显式写出来更不容易让后续维护者误判。

### 3. Claude Code 里只允许模型调，不给用户手动入口

`SKILL.md`：

```yaml
---
name: your-skill
description: 在特定场景下由 Claude 自动调用。
user-invocable: false
---
```

如果还要允许模型自动调用，就不要加 `disable-model-invocation: true`。

注意：

- 这是 Claude Code 专属语义
- Codex 没有与之等价的“隐藏手动入口”开关

### 4. 想做“Codex 手动可用，但 Claude 隐藏”

可以这样配：

- `agents/openai.yaml`: `allow_implicit_invocation: false`
- `SKILL.md`: `user-invocable: false`

效果：

- Codex：仍可被显式 `$skill-name` 调起
- Claude Code：用户不能 `/skill-name`

但这不是完全对称的“只给模型用”配置，因为 Codex 没有对应的用户入口隐藏字段。

## 约束和提醒

- 不要把 Claude 的 `/skill` 当成双端公共协议。共享入口应该是“skill 本身”，不是 Claude slash command 语法。
- 不要把 `allow_implicit_invocation: false` 理解成“Codex 禁用 skill”；它只是关闭自动触发。
- 不要把 `disable-model-invocation: true` 理解成“Claude 不可手动调用”；它只阻止模型自动调。
- 如果要让 Codex 自动发现 skill，最先检查 `description` 是否写成了“做什么 + 什么时候用”，其次再看 `allow_implicit_invocation`。
