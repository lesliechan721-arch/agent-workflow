# Skill 格式与常用调用字段

创建、修改或检查 Skill 的目录、frontmatter 或调用字段时读取。

## 标准结构

一个 Skill 目录至少包含 `SKILL.md`（YAML frontmatter + Markdown 正文）：

```markdown
---
name: status-summary
description: Summarize status notes supplied by the user, retaining errors and unknowns.
---

Read the supplied note. Report its stated status, explicit errors and unknown facts.
Request the note when it is missing.
```

`name` 与目录名一致。`scripts/` 放可执行工具，`references/` 放条件资料，`assets/` 放模板或静态数据；仅在确有用途时添加。`SKILL.md` 正文建议控制在 **500 行 / 约 5000 tokens 内**（作为防膨胀警戒线而非硬指标，超出时优先检查应条件披露的分支参考或大段示例）。

## 标准字段

| 字段 | 要求与用途 |
| --- | --- |
| `name` | 必填字符串，1–64 字符；小写字母、数字和连字符，不能以连字符开头或结尾，不能有连续连字符；与目录同名。跨客户端优先 ASCII 小写。 |
| `description` | 必填非空字符串，最多 1024 字符；写清做什么、何时触发及高价值边界。 |
| `license` | 可选字符串，许可证名称或随包许可文件引用。 |
| `compatibility` | 可选字符串，1–500 字符；只写真实环境依赖。 |
| `metadata` | 可选的字符串键到字符串值映射；版本等数值也写为字符串。 |
| `allowed-tools` | 可选实验字段；标准写法为空格分隔的工具字符串（如 `Bash(git:*) Bash(jq:*) Read`），支持程度取决于客户端。 |

优先使用标准字段，不用自定义扩展重复 `description`。

## 资源引用

- 供 Agent 执行读取的包内文件引用，使用代码格式路径，**相对于 Skill 根目录**（`SKILL.md` 所在目录）；支持文档沿用同一基准。`#...` 仅用于定位章节，不属于文件名。
- 包内文件引用尽量保持从 `SKILL.md` 出发**一层深度（1-hop）**，避免多层嵌套参考链导致漏读。
- 面向人的导航可使用标准 Markdown 相对链接。

## 常用调用控制

两平台默认均支持模型选择和用户显式调用。需改变时按下表配置（修改一个开关时保留另一个开关及无关正文）：

| 目标 | 字段与位置 | 效果 |
| --- | --- | --- |
| Codex 仅显式调用 | `agents/openai.yaml` 中 `policy.allow_implicit_invocation: false` | 关闭隐式调用，保留 `$skill-name`（默认 `true`） |
| Claude Code 仅用户启动 | frontmatter 中 `disable-model-invocation: true` | 关闭模型自行启动（默认 `false`） |
| Claude Code 仅模型使用 | frontmatter 中 `user-invocable: false` | 隐藏用户菜单与 `/skill-name`，保留模型调用（默认 `true`）；不要同时设 `disable-model-invocation: true` |

`agents/openai.yaml` 可省略；仅有 `interface`（`display_name`、`short_description`、`default_prompt`）而无 `policy` 也有效。界面短说明不替代 `description`。Claude Code 的 `argument-hint` 为可选参数提示字符串。

其他平台扩展（模型选择、hooks、子代理执行等）仅在需要时查阅对应官方文档。字段可解析不代表客户端行为已实测。

## 官方依据

- [Agent Skills 格式规范](https://agentskills.io/specification)
- [Codex Skill 文档](https://developers.openai.com/codex/skills/)
- [Claude Code Skill 文档](https://code.claude.com/docs/en/skills)
