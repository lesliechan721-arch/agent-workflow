# Skill 格式与常用调用字段

创建、修改或检查 Skill 的目录、frontmatter 或调用字段时读取。

## 标准结构

一个 Skill 目录至少包含 `SKILL.md`，文件由 YAML frontmatter 与 Markdown 正文组成。

```markdown
---
name: status-summary
description: Summarize status notes supplied by the user, retaining errors and unknowns.
---

Read the supplied note. Report its stated status, explicit errors and unknown facts.
Request the note when it is missing.
```

`name` 与目录名一致。`scripts/` 放可执行工具，`references/` 放条件读取的资料，`assets/` 放模板或数据；仅在任务需要时添加。

## 标准字段

| 字段 | 要求与用途 |
| --- | --- |
| `name` | 必填字符串，1–64 字符；小写字母、数字和连字符，不能以连字符开头或结尾，不能有连续连字符；与目录同名。跨客户端创作优先使用 ASCII 小写名称。 |
| `description` | 必填非空字符串，最多 1024 字符；说明做什么和何时使用。 |
| `license` | 可选字符串，许可证名称或随包许可文件的引用。 |
| `compatibility` | 可选字符串，提供时为 1–500 字符；只写实际环境要求。 |
| `metadata` | 可选的字符串键到字符串值映射；版本等数值也写为字符串。 |
| `allowed-tools` | 可选、实验性字段；标准写法为空格分隔的工具字符串，具体支持由客户端决定。 |

优先用这些字段表达已有含义，不用扩展字段重复 `description` 或另造兼容性键。可选项有用途才填写。正文保留每次都需要的方法和完成条件；分支细节通过明确指针读取。

## 资源引用

供 Agent 执行的文件引用应优先使用代码格式路径，相对于 Skill 根目录（`SKILL.md` 所在目录）；支持文档沿用同一基准。保留读取条件、用途和必要章节；`#...` 只定位章节，不属于文件名。

面向人的文档与导航可使用 Markdown 链接，遵循标准 Markdown 相对链接语义。

## 常用调用控制

两平台默认都支持模型选择和用户显式调用。需要改变此行为时使用下表；标准格式本身没有等价调用开关。

| 目标 | 字段与位置 | 结果 |
| --- | --- | --- |
| Codex 只保留显式调用 | `agents/openai.yaml` 中 `policy.allow_implicit_invocation: false` | 关闭隐式调用，保留 `$skill-name`；该字段默认 `true`。 |
| Claude Code 只由用户启动 | frontmatter 中 `disable-model-invocation: true` | 关闭模型自行启动；该字段默认 `false`。 |
| Claude Code 只由模型使用 | frontmatter 中 `user-invocable: false` | 关闭用户菜单和直接 `/skill-name` 入口，保留模型调用；该字段默认 `true`。 |

Claude Code 的两个字段控制不同入口。修改时保持另一个开关及无关正文；只保留模型调用时，不同时设 `disable-model-invocation: true`。

`agents/openai.yaml` 可省略。仅有 `interface` 而没有 `policy` 也有效；常用界面字段是字符串 `display_name`、`short_description`、`default_prompt`。界面短说明不替代用于任务匹配的标准 `description`。Claude Code 的 `argument-hint` 是可选参数提示字符串。

模型选择、子代理执行、hooks、动态内容、工具依赖和其它扩展，仅在当前任务需要时查对应官方文档。字段可解析不等于实际调用已验证；扩展可被一个客户端识别，也不表示能用于所有标准包上传渠道。

## 官方依据

- [Agent Skills 格式规范](https://agentskills.io/specification)：标准字段、资源与渐进披露。
- [Codex Skill 文档](https://developers.openai.com/codex/skills/)：调用策略及 `agents/openai.yaml`。
- [Claude Code Skill 文档](https://code.claude.com/docs/en/skills)：调用控制、参数和其它扩展。
