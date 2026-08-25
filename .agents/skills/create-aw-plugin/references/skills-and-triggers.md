# Skills 能力与原生调用配置

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
    └── evals/                   # 可选：作者期 eval 定义和 fixture
```

一个插件可以包含多个 skill 子目录，每个子目录名即 skill 标识（小写短横线格式）。

作者期触发/行为用例放在 owner Skill 的 `evals/`，由 `evals/manifest.json` 声明 owner Skill、participant Skills 和安装 profiles。完整工作批次位于项目 `.tmp/agent-workflows/evals/`；正式报告位于插件根 `reports/<skill>/<batch-id>/`。这些作者材料不会进入 runtime bundle 或 runtime digest。完整规则见 `references/skill-evaluation.md`。

## SKILL.md profile

AW 使用版本化 registry 区分 portable、最低宿主和当前宿主能力。机器真值位于 `packages/cli/src/utils/skill-frontmatter-capabilities.json`；作者 validator、CLI bundle validator、`references/skill-frontmatter-capabilities.md` 和表驱动测试共同消费它。本文只保留选择原则，不复制易变字段全集。

| Profile | 入口 | 结果用途 |
| --- | --- | --- |
| `portable-agent-skills` | `--strict-agent-skills` | 只检查 Agent Skills portable core |
| `claude-2.1.88` | 默认 AW source 校验 | 保证 AW 最低 Claude Code 版本 |
| `claude-current` | `--claude-skill-profile current` | 核对当前官方字段；不改变发布最低版本 |

诊断区分 `unknown-field`、`known-field-not-supported-by-target-version`、`known-field-requires-related-field`、`known-field-invalid-type-value` 和 `portable-profile-platform-extension`。例如 `when_to_use` 已在 Claude Code 2.1.88 源码中验证，不再误报为 unknown；`background` 当前文档要求 Claude Code 2.1.218，因此默认最低版本 profile 会给版本诊断，而不是把它称为拼写错误。

完整选择原则见 `references/skill-design.md`。当前字段重新核对 Agent Skills、Claude Code 和 Codex 官方文档；不要从本文的示例推断字段全集。

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

上游 Codex runtime 允许没有 `agents/openai.yaml` 也加载 `SKILL.md`，但 AW 作者合同要求用 `policy.allow_implicit_invocation` 明确声明调用行为。只要插件没有通过 `marketplace.policy.products` 明确排除 Codex，就把 skill 视为面向 Codex：必须提供 `agents/openai.yaml`，并显式写出 `policy.allow_implicit_invocation`。Claude-only skill 可以省略此文件，但需要在 manifest 的 `products` 中清楚收窄平台；build 会裁掉 Codex platform manifest/runtime，安装和显式升级也会按这个字段拦截不匹配的平台。

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

脚手架参数映射：

| `--skill-invocation` | Claude | Codex |
| --- | --- | --- |
| `model`（默认） | 允许模型发现，保留用户入口 | `allow_implicit_invocation: true` |
| `manual` | `user-invocable: true`、`disable-model-invocation: true` | `allow_implicit_invocation: false` |
| `claude-model-only` | `user-invocable: false`，不禁用模型 | 无隐藏用户入口的等价字段；保持 implicit true |

脚手架默认只适合可自动发现的初始工作流。任务有副作用或强授权边界时，作者必须显式传 `manual`。

### 触发开关对照

| 平台 | 自动触发控制 | 手动触发控制 | 配置位置 |
|------|-------------|-------------|----------|
| Codex | `allow_implicit_invocation` | 始终可 `$skill-name` | `agents/openai.yaml` |
| Claude Code | `disable-model-invocation` | `user-invocable` | `SKILL.md` frontmatter |

### 配方 1：保守手动触发

适合 `deploy`、`release` 等有副作用的流程。

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

## 原生元数据是唯一真值

Skill 的调用行为是 Skill 设计的一部分。作者直接在平台原生文件中声明行为，AW 不提供配置项来改写这些字段：

- Codex：`agents/openai.yaml` 中的 `policy.allow_implicit_invocation`
- Claude Code：`SKILL.md` frontmatter 中的 `disable-model-invocation` 与 `user-invocable`

安装、升级、重装和 lifecycle active replay 都保留最终 Skill 树中的原生元数据。静态 Skill 从平台 bundle 原样复制；动态 `codex.skill` 或 `claude.skill` 必须在最终树中提供合法元数据。AW 只校验并分发，不根据用户配置修改调用方式。

显式调用不受影响。Codex 可继续使用 `$skill-name`；Claude 是否显示用户入口由 `user-invocable` 决定。要改变调用行为，插件作者必须修改 Skill 源码或 renderer 输出，并按正常插件版本流程发布。

`marketplace.policy.products` 也会影响 bundle 裁剪：Claude-only 插件只生成 Claude skill 产物，不生成 Codex bundle，也不要求 `agents/openai.yaml`；Codex-only 插件只生成 Codex skill 产物，不生成 Claude platform manifest/runtime。省略或空 `products` 时按双平台 skill 处理。

---

## 调试检查点

- 自动触发不符合预期 → 先检查 `SKILL.md` 的 `description` 是否足够具体，再看 `allow_implicit_invocation`。不要靠 `default_prompt` 修正自动触发边界。
- 有副作用的流程 → 默认关掉 Codex 隐式调用和 Claude 模型调用。
- 不要把 Claude slash command 当作双端公共协议；手动触发命令请用公共 `slashCommands`，Codex 侧会生成 `allow_implicit_invocation: false` 的入口 Skill。
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

向现有插件新增一个静态 Skill 时，可以运行：

```bash
aw plugin add-skill <plugin-name> \
  --skill-name <skill-name> \
  --skill-description "用户目标与发现边界" \
  --skill-invocation model|manual|claude-model-only \
  [--workspace-root <workspace-root>]
```

该命令只处理确定性的静态 Skill 骨架、平台调用元数据、Codex eval starter 和 manifest `skills` 能力字段；稳定 plugin version 保持不变。日常开发不直接提高 manifest version；release train 开始时统一设置目标。命令不修改插件 README，也不新增 dynamic artifact、slash command 或其它能力。支持 Codex 的插件生成 `agents/openai.yaml` 与 v2 eval starter；Claude-only 插件只生成 Claude 可用源码，不生成无法运行的 Codex eval profile。
