# Skills 能力与触发配置

Skills 是插件向用户或模型暴露的可调用工作流。每个 skill 是一组 Markdown 指令 + 平台元数据，由 CLI 按插件最终支持平台分发到对应目录。

本文负责 AW/平台 metadata 和触发合同。决定 skill 职责、编写 description、组织正文与资源时先读 `references/skill-design.md`；skill 内脚本和行为评估分别见 `references/skill-scripts.md`、`references/skill-evaluation.md`。

## Skill 目录结构

```text
plugins/<name>/skills/
└── <skill-name>/
    ├── SKILL.md                 # 必需：skill 定义（frontmatter + 正文）
    ├── agents/
    │   └── openai.yaml          # 面向 Codex 时必需：Codex 平台元数据
    ├── references/              # 可选：按需加载的参考文档
    │   └── *.md
    ├── scripts/                 # 可选：由 agent 执行的辅助脚本
    │   └── *.js | *.sh
    ├── assets/                  # 可选：模板、图片和静态数据
    └── evals/                   # 可选：作者期触发/输出质量用例
        └── evals.json
```

一个插件可以包含多个 skill 子目录，每个子目录名即 skill 标识（小写短横线格式）。

## SKILL.md profile

AW 区分两层 frontmatter：

- **Agent Skills portable core**：`name`、`description`，以及可选的 `license`、`compatibility`、`metadata`、字符串形式 `allowed-tools`
- **AW 平台扩展**：Claude 的 `user-invocable`、`disable-model-invocation`、`shell` 和数组形式 `allowed-tools`；Codex 的 `agents/openai.yaml`

完整约束和选择原则见 `references/skill-design.md`。默认 `validate_plugin.js` 接受 portable core 加目标平台的已知扩展；`--strict-agent-skills` 只接受 portable core。未知字段和旧式 `when_to_use` 会失败。

双平台、可严格移植的基础 frontmatter：

```yaml
---
name: repo-check
description: 当用户要求检查仓库状态或执行仓库诊断时，执行完整的仓库健康检查工作流。
compatibility: Requires git
metadata:
  short-description: 仓库状态诊断
---
```

SKILL.md 和 `references/` 下的 Markdown 文件均支持模板渲染（`{{var}}`、`{{#if}}`、`{{#unless}}`），可按平台生成不同内容。需在 `buildConfig.templates` 中配置 include glob 和变量，详见 `references/build-config-spec.md`。

### 命令结果填充（Claude Code 专属）

SKILL.md 正文和 `references/` 下的 Markdown 文件支持 `` !`command` `` 行内语法和 `` ```! `` 代码块语法，在加载时执行 shell 命令并将输出内联到 prompt。**此能力为 Claude Code 专属，Codex 不支持。**

使用此功能时需在 frontmatter 中声明 `allowed-tools` 和（可选的）`shell` 字段。字符串形式 `allowed-tools` 属于 portable core；数组形式和 `shell` 属于 Claude 扩展。完整语法规范、支持范围和配置见 `references/claude-only-capabilities.md` § 命令结果填充。

## agents/openai.yaml 规范

`SKILL.md` 是真正会注入模型上下文的 skill 指令体；`agents/openai.yaml` 是 Codex 读取的产品元数据，主要服务 UI、客户端、工具依赖和触发策略。不要把详细工作流或触发规则正文塞进 `default_prompt`。

上游 Codex runtime 允许没有 `agents/openai.yaml` 也加载 `SKILL.md`，但 AW 需要用 `policy.allow_implicit_invocation` 管理安装时触发偏好。只要插件没有通过 `marketplace.policy.products` 明确排除 Codex，就把 skill 视为面向 Codex：必须提供 `agents/openai.yaml`，并显式写出 `policy.allow_implicit_invocation`。Claude-only skill 可以省略此文件，但需要在 manifest 的 `products` 中清楚收窄平台；build 会裁掉 Codex platform manifest/runtime，安装和显式升级也会按这个字段拦截不匹配的平台。

### 完整字段

```yaml
interface:
  display_name: "Repo Check"              # UI 显示名称
  short_description: "检查仓库状态、变更风险与测试结果并生成可执行的简明报告" # 25-64 字符
  icon_small: "./assets/icon-small.png"    # 可选：小图标路径
  icon_large: "./assets/icon-large.svg"    # 可选：大图标路径
  brand_color: "#3B82F6"                   # 可选：品牌主色
  default_prompt: "使用 $repo-check 检查仓库状态。"

dependencies:                              # 可选：工具依赖
  tools:
    - type: "mcp"
      value: "tool-name"
      description: "Tool description"
      transport: "streamable_http"         # streamable_http | stdio
      url: "https://..."                   # streamable_http 用
      command: "tool-server"               # stdio 用

policy:
  allow_implicit_invocation: false         # 是否允许自动注入
  products: ["codex", "CHATGPT"]          # 可选：Codex-only 的 per-skill 产品限制
```

### interface 块

- `display_name`：建议直接写人类可读的 Title Case 名称，如 `Repo Check`。Codex 只清洗单行并校验非空且 ≤ 64 字符，不会把 `repo-check` 自动转换成 `Repo Check`
- `short_description`：必须为 25-64 字符，便于 UI 快速扫读；这是 AW 作者 profile 采用的上游 OpenAI metadata 约束
- `default_prompt`：用户/UI 调起 skill 时使用的一句默认起手话，不是模型指令正文。写短句，必须显式包含 `$skill-name`，例如 `使用 $repo-check 检查仓库状态。`；Codex loader 实际校验为非空且 ≤ 1024 字符
- `brand_color`：可选；填写时必须是 `#RRGGBB`
- `icon_small` / `icon_large`：可选；填写时必须是相对路径，且位于当前 skill 的 `assets/` 目录下，例如 `./assets/icon-small.png`。不要使用绝对路径、`..` 或 `assets/` 之外的目录

### dependencies.tools[] 块

- `type` / `value`：必填，声明工具依赖的类型和标识；缺失或空值会被 Codex loader 丢弃
- `description`：可选，说明工具用途
- `transport`：可选，当前 Codex 支持 `streamable_http` 和 `stdio`
- `url`：`streamable_http` 场景下的远端服务地址
- `command`：`stdio` 场景下启动本地 MCP server 的命令

### policy 块

- `policy` block 必须存在，且必须显式声明 `allow_implicit_invocation`；作者工具不会接受缺失字段并套用隐式默认值。
- `allow_implicit_invocation: true`：允许 Codex 自动注入和隐式识别。具体什么时候该用这个 skill，仍要写在 `SKILL.md` 的 `description` 和正文里
- `allow_implicit_invocation: false`：关闭自动注入，但仍可通过 `$skill-name` 显式触发
- `products`：可选的 Codex-only per-skill override。一般不需要写；只有同一插件里的不同 skill 需要限制到不同 Codex 产品时才使用。当前 Codex runtime 支持 `codex` / `chatgpt` / `atlas` 及对应全大写别名

---

## 双平台触发配置

两个平台的触发开关完全独立，互不读取。

### 触发开关对照

| 平台 | 自动触发控制 | 手动触发控制 | 配置位置 |
|------|-------------|-------------|----------|
| Codex | `allow_implicit_invocation` | 始终可 `$skill-name` | `agents/openai.yaml` |
| Claude Code | `disable-model-invocation` | `user-invocable` | `SKILL.md` frontmatter |

### 配方 1：保守手动触发

适合 `deploy`、`release` 等有副作用的流程。`git-commit` 按插件约定保留自动触发，不属于这一配方。

```yaml
# SKILL.md
---
name: your-skill
description: 当用户明确要求执行某个流程时，完成该流程。
user-invocable: true
disable-model-invocation: true
---
```

```yaml
# agents/openai.yaml
policy:
  allow_implicit_invocation: false
```

### 配方 2：允许自动发现

适合低风险、辅助型、说明型 skill。

```yaml
# SKILL.md（使用默认值，可省略触发字段）
---
name: your-skill
description: 当用户需要某类低风险辅助工作时，执行对应工作流。
---
```

允许自动发现时，直接在 `description` 写清技能用途、触发条件、常见用户说法和必要反例。`description` 是两个平台共享的发现信息，避免再维护平台专属的重复触发文案。

```yaml
# agents/openai.yaml
policy:
  allow_implicit_invocation: true
```

### 配方 3：Claude 隐藏用户入口

适合只希望 Claude Code 模型在特定场景下调用的 skill。

```yaml
# SKILL.md
---
name: your-skill
description: 在特定场景下由模型调用。
user-invocable: false
---
```

Codex 没有完全等价的"隐藏手动入口"字段；即使 `allow_implicit_invocation: false`，显式 `$skill-name` 仍可触发。

---

## AW 内建触发配置

平台原生文件提供 runtime 表达，AW 的长期真值来自 manifest 默认策略和内建配置。安装、升级和重装不再接收触发策略参数；用户通过 `aw config` 或主控制台配置页调整触发策略：

```bash
aw config set <plugin> aw.skillTriggers.<skill>.trigger manual
aw config set <plugin> aw.skillTriggers.<skill>.trigger auto
aw config unset <plugin> aw.skillTriggers.<skill>.trigger
```

触发值映射：

| 值 | Codex | Claude Code |
|------|-------|-------------|
| `manual` | `allow_implicit_invocation: false` | `disable-model-invocation: true`，并保留 `user-invocable: true` |
| `auto` | `allow_implicit_invocation: true` | `disable-model-invocation: false`，`user-invocable` 继承默认文件 |

manifest 中的每个显式受管 skill 都必须声明默认策略和是否允许动态变更：

```json
{
  "skills": "./skills",
  "skillTriggers": {
    "your-skill": {
      "defaultTrigger": "manual",
      "allowDynamicTrigger": true
    }
  }
}
```

`defaultTrigger` 只允许 `manual` 或 `auto`。未写入内建配置时，effective 值等于 `defaultTrigger`；清空字段或 reset 配置层后也回到该默认值。`allowDynamicTrigger: true` 表示用户可以修改 `aw.skillTriggers.<skill>.trigger`；`allowDynamicTrigger: false` 表示字段固定只读，历史 `$aw.skillTriggers` 覆盖值会作为 ignored 旧配置展示，不参与 runtime、status 或 drift 判断。新 manifest 中只允许 `defaultTrigger` 和 `allowDynamicTrigger`，不能再写旧的安装期覆盖字段。

静态 `skills/<skill>` 子目录和动态 `artifacts.targets[].target = "codex.skill"` 声明的 `skillKey` 都必须有对应 `skillTriggers.<skill>` entry。公共 `slashCommands` 在 Codex 侧生成的 manual-only skill 不要求作者手写 entry；AW 会注入 `defaultTrigger: "manual"`、`allowDynamicTrigger: false` 的 fixed built-in 字段。

本地 `~/.aw` 是共享 marketplace。Codex user scope 和 Claude native runtime 中，同一个用户、同名插件、同一平台只能有一份当前生效的 runtime skill 触发策略；AW 用 shared runtime owner 记录当前 owner 身份和完整性证据。owner 文件不保存 SkillTrigger 真值；`aw init` replay、marketplace refresh、卸载后 rematerialize 和重新应用配置都从 owner location 的 current effective built-in config 重新计算。owner 冲突只作为 blocker、diagnostic 或状态详情，解决方式是卸载、cleanup 或调整 owner 对应的有效安装后重试原写命令。Codex project scope 不改共享 runtime，只改当前仓库 `.agents/skills/<skill>/agents/openai.yaml`，也不参与 `aw init` replay 或 local marketplace rebuild replay。

`marketplace.policy.products` 也会影响 bundle 裁剪：Claude-only 插件只生成 Claude skill 产物，不生成 Codex bundle，也不要求 `agents/openai.yaml`；Codex-only 插件只生成 Codex skill 产物，不生成 Claude platform manifest/runtime。省略或空 `products` 时才按双平台 skill 处理。

### 公开配置投影

`aw config list/get --json` 顶层使用 `configSchemaVersion: 2`，AW 注入的触发字段会出现在 `fields` 中：

- `key` 是逻辑 key：`aw.skillTriggers.<skill>.trigger`
- `kind: "builtIn"`，`reserved: true`
- 可动态修改的字段返回当前 `effectiveValue`、`sourceLayer` 和 `valueState`
- fixed 字段返回 `valueState: "fixed"`，历史覆盖返回 `valueState: "ignored"` 和 `ignoredReason: "fixedSkillTrigger"`
- 插件退场或 skill key 删除后的旧值返回 `valueState: "orphaned"`，只允许清理，不能继续写入

`aw config set/unset/reset --json` 顶层使用 `receiptSchemaVersion: 2`，并通过 `affectedFields` 回显本次触碰的 built-in 字段。project scope 下，SkillTrigger effective 值只由默认值和 project shared 配置决定；project local 中误写的旧 `$aw.skillTriggers` 只能作为 invalid 存量值展示，不能改变 repo-visible runtime。

---

## 调试检查点

- 自动触发不符合预期 → 先检查 `SKILL.md` 的 `description` 是否足够具体，再看 `allow_implicit_invocation`。不要靠 `default_prompt` 修正自动触发边界。
- 有副作用的流程 → 默认关掉 Codex 隐式调用和 Claude 模型调用；`git-commit` 按插件约定保留自动触发。
- 不要把 Claude slash command 当作双端公共协议；手动触发命令请用公共 `slashCommands`，Codex 侧会生成 fixed/manual-only skill。
- `disable-model-invocation: true` 不等于 Claude 不能手动调用（用户仍可调用）。

## 多 Skill 插件

一个插件可以包含多个 skill：

```text
plugins/<name>/skills/
├── check/
│   ├── SKILL.md
│   └── agents/openai.yaml
├── fix/
│   ├── SKILL.md
│   └── agents/openai.yaml
└── report/
    ├── SKILL.md
    └── agents/openai.yaml
```

每个 skill 子目录完全独立，各自有独立的触发策略和工作流。manifest 的 `skills` 字段指向父目录（`"./skills"`），CLI 会自动发现所有子目录。
