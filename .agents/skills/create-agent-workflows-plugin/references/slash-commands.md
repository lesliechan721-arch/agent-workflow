# 公共 Slash Commands

公共 `slashCommands` 是源码层唯一的手动命令作者入口。插件作者维护一份 `slash-commands/*.md` 源文件；构建时只为插件支持的平台生成产物：支持 Claude 时得到原生 `/command`，支持 Codex 时得到 manual-only generated skill。

## 目录结构

```text
plugins/<name>/
└── slash-commands/
    ├── review.md
    ├── deploy.md
    └── assets/
        └── review-16.svg
```

命令文件是 Markdown 格式，文件名即命令名。命令名必须使用小写短横线格式，最长 64 字符。首版不支持子目录命名空间；`assets/` 是唯一允许的子目录，里面的 Markdown 不生成命令。

## manifest 声明

```json
{
  "slashCommands": "./slash-commands"
}
```

`slashCommands` 只能写单个 `./` 开头的目录路径。插件目录里出现 `slash-commands/` 时必须声明该字段。

## 命令文件格式

```markdown
---
description: 执行代码审查
claude:
  allowed-tools:
    - Bash
    - Read
    - Write
  model: inherit
  argument-hint: "[file-path]"
codex:
  description: 在 Codex 中手动执行代码审查工作流。
  interface:
    display_name: "Review Command"
    short_description: "显式启动代码审查、证据核验、风险分级与可执行报告生成工作流"
    icon_small: ./assets/review-16.svg
    icon_large: ./assets/review-64.svg
    brand_color: "#2563EB"
    default_prompt: "使用 $review 审查当前改动。"
---

对 $ARGUMENTS 指定的文件执行代码审查。

1. 读取目标文件
2. 分析代码质量
3. 输出审查报告
```

## Frontmatter 字段

顶层只允许 `description`、`claude`、`codex`。

| 字段 | 类型 | 说明 |
|------|------|------|
| 顶层 `description` | string | 必填。公共描述，Claude/Codex 默认共用 |
| `claude.description` | string | Claude 命令描述覆盖 |
| `claude.allowed-tools` | `string` \| `string[]` | 命令执行期间允许使用的工具 |
| `claude.model` | string | 指定模型（`inherit` 继承当前模型） |
| `claude.argument-hint` | string | 参数提示（如 `[file]`、`[branch]`） |
| `claude.shell` | string | shell 插值使用的解释器（默认 `bash`，可选 `powershell`） |
| `codex.description` | string | Codex generated skill 的描述覆盖 |
| `codex.interface.display_name` | string | Codex generated skill 展示名 |
| `codex.interface.short_description` | string | Codex generated skill 简短描述 |
| `codex.interface.icon_small` / `icon_large` | string | 只能写 `./assets/...`，源文件位于 `slash-commands/assets/` |
| `codex.interface.brand_color` | string | `#RRGGBB` |
| `codex.interface.default_prompt` | string | Codex skill 默认起手句；必须包含 `$command-name` |

Claude-only 字段不能放在顶层。Codex block 只允许 `description` 和 `interface`；`codex.policy` 不可配置，因为 generated skill 固定 manual-only。

复杂、可复用的流程仍应放在源码 `skills/` 中。公共 `slashCommands` 更适合做显式快捷入口，例如 `/review` 只启动 `review-workflow`，而不是把完整审查规则复制到命令正文里。

## 平台生成行为

构建后：

- 支持 Claude 的插件得到 generated `claude/commands/<name>.md`，用户通过 `/command-name` 触发。
- 支持 Codex 的插件得到 generated `codex/skills/<name>/SKILL.md`、`agents/openai.yaml` 和被引用的 `assets/`。
- 原始 `slash-commands/` 源目录不作为 runtime 目录发布。

Claude generated command 会固定写入 `disable-model-invocation: true`。Codex generated skill 会固定写入 `policy.allow_implicit_invocation: false`，因此只能由用户显式 `$command-name` 或结构化 skill mention 调用。`default_prompt` 只用于 UI/客户端的推荐起手话，不会替代 generated `SKILL.md` 正文。Codex project scope 安装这些命令时，会把 generated skill 复制到当前仓库 `.agents/skills/<name>`，并在 install record / project artifact shared identity 中以 `kind: "skill"` + `artifactKey: "<name>"` 记录最小 artifact identity。

## 动态参数与 Claude-only 语法

Claude 侧支持这些 slash command 参数：

- `$ARGUMENTS`：用户在命令名后输入的全部参数
- `$1`、`$2`、`$3`：按空格分割的第 1、2、3 个参数

命令文件正文还可以在 Claude 渲染结果中使用命令结果填充语法（`` !`command` `` 和 `` ```! ``），完整规则见 `references/claude-only-capabilities.md` § 命令结果填充。

这些动态参数和命令结果填充只允许出现在 Claude 渲染结果中。Codex 渲染结果不能残留 `$ARGUMENTS`、`$1`、`` !`command` `` 或 ```! 这类 Claude-only 语法；这项 forbidden syntax 校验只在插件支持 Codex、需要生成 Codex skill 时执行。Claude-only 插件不会因为正文中保留 Claude 参数或命令结果填充而失败。需要平台差异时，用 `buildConfig.templates` 包住 Claude-only 段落。

## 模板渲染

`slash-commands/*.md` 支持 `buildConfig.templates`。构建时会先按目标支持平台渲染模板，再解析该平台需要的 frontmatter 和正文；不支持的平台不会生成产物，也不会执行该平台专属校验。

```json
{
  "buildConfig": {
    "templates": {
      "include": ["slash-commands/*.md"],
      "vars": {
        "supportsCommands": {
          "claude": true,
          "codex": false
        }
      }
    }
  }
}
```

常见写法：

```markdown
{{#if supportsCommands}}
如果用户传入 $ARGUMENTS，只审查指定路径。
{{/if}}
{{#unless supportsCommands}}
先询问用户审查范围，再继续。
{{/unless}}
```

## 图标资源

Codex 图标资源只能来自 `slash-commands/assets/`，并写成 `./assets/...`。不要使用绝对路径、`../`、反斜杠、其它目录或不存在的文件。build 只复制被 command frontmatter 引用的资源到对应 generated skill 的 `assets/`。
