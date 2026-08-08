---
name: create-agent-workflows-plugin
description: 仅当用户明确要求在 `agent-workflows` 仓库创建或维护 `plugins/<name>/` 插件时使用；用于设计插件内 Agent Skill、编写或调整 manifest 与平台能力、运行作者校验并修复 bundle 问题。不用于安装或使用插件、仓库外的通用 Skill 编写，或单纯解释 CLI。
compatibility: Requires the agent-workflows repository, Node.js 20+, and installed workspace dependencies.
---

# Create Agent Workflows Plugin

在当前仓库创建或维护 agent-workflows 插件。插件默认同时支持 Codex 和 Claude Code，也可以通过 `marketplace.policy.products` 收窄到单个平台。

这里描述的是源码层公共 contract，不是 Claude Code / Codex 原生插件 schema 的全集。作者只维护 `plugins/<name>/` 下的源码真值；runtime bundle、catalog manifest、本地 runtime view 和平台 manifest 由 CLI / 发布流程生成。

本 Skill 负责创建和修复；独立只读评分、证据复核与发布门禁由 repo-local `skill-review` 负责，后者也能评审标准静态 Skill，避免作者工作流同时充当自己的 reviewer。

## 阅读路由

先确认任务属于哪一类，只读取本次需要的 reference。所有插件都必须有 `.agents-plugin/plugin.json`。

| 任务 | 必读 | 条件性补充 |
|------|------|------------|
| 新建或重写 skill | `references/skill-design.md`、`references/skills-and-triggers.md`、`references/plugin-manifest-spec.md` 的基础字段与平台原生调用元数据 | skill 内含脚本时读 `references/skill-scripts.md`；完成前读 `references/skill-evaluation.md` |
| 设计或调整 Skill 原生调用元数据 | `references/skills-and-triggers.md` | 改 description 时读 `references/skill-design.md` 和 `references/skill-evaluation.md` |
| Extensions | `references/extensions-spec.md`、manifest 对应章节 | — |
| MCP / Apps | `references/mcp-and-apps.md`、manifest 对应章节 | — |
| 公共 slashCommands | `references/slash-commands.md` | 复杂工作流仍放 skill，并读 skill 设计文档 |
| AW Config / Lifecycle / 插件根脚本 | `references/aw-scripts-config-lifecycle.md` | 需要 manifest 字段时读对应章节 |
| Dynamic Artifacts | `references/plugin-manifest-spec.md` 的 `artifacts.targets`、`references/aw-scripts-config-lifecycle.md` 的 renderer | 静态 / 动态边界见 `references/extensions-spec.md` |
| Claude 专属能力 | `references/claude-only-capabilities.md` | 使用 buildConfig 时读 `references/build-config-spec.md` |
| 综合能力或产物预览 | `references/comprehensive-example.md` | 再按实际能力打开上面的单项 reference |

不要为了“混合型插件”一次加载全部文档；按 manifest 中实际声明的能力逐项读取。

## 创建与维护工作流

1. **确认目标和边界**
   - 新建插件：确认插件名、用户目标、支持平台和最小能力组合
   - 维护插件：先读现有 `.agents-plugin/plugin.json`、相关源码与测试，不重新脚手架
2. **选择能力**
   - 可调用、多步骤、需要模型判断的工作流 → skill
   - 常驻规则、权限、hooks、agents → extensions
   - 显式快捷入口 → 公共 `slashCommands`
   - 配置驱动的 Codex 产物 → dynamic artifact
3. **创建骨架**
   - 新插件可运行 `scripts/init_plugin.mjs`
   - 只保留用户请求的能力，不预先生成 MCP、Apps、lifecycle 或 config
4. **实现源码**
   - Skills → 编写 `SKILL.md`；面向 Codex 时同时提供 `agents/openai.yaml`
   - Extensions → 写入 manifest 的 `extensions`
   - MCP / Apps → 创建 `.mcp.json` / `.app.json`
   - Public slashCommands → 创建 `slash-commands/*.md`
   - AW Config / Lifecycle → 声明 `config` 和插件根 `scripts`
   - Dynamic Artifacts → 静态声明 target，renderer 只输出 `ArtifactPlan`
5. **构建**
   - 运行 `pnpm build` 生成本地 staging/runtime bundle
6. **验证并修复**
   - 运行 `scripts/validate_plugin.mjs`
   - 校验失败时按错误修复并重跑，直到通过
7. **测试**
   - 插件根 Node 脚本运行 `pnpm plugin:test <plugin>`
   - 改到 manifest、bundle 或安装逻辑时运行相关 `pnpm test:*`
   - Skill 的作者期用例统一放在插件根 `evals/`，按 `references/skill-evaluation.md` 声明 `evals/manifest.json`
   - 先运行 `pnpm plugin:eval <plugin> --materialize-only` 验证 Codex 最终制品；真实模型 eval 只在本地显式运行
8. **交付**
   - 报告修改的源码文件、运行的验证、未验证项和仍需用户决定的风险

## 脚手架

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.mjs <plugin-name> \
  --description "插件描述" \
  --display-name "Display Name" \
  --short-description "简短 UI 描述" \
  [--skill-name <name>] \
  [--skill-description "skill 的用户目标和使用时机"] \
  [--skill-short-description "skill 的简短 UI 摘要"] \
  [--no-skills] \
  [--with-mcp] \
  [--with-apps] \
  [--with-config-api] \
  [--with-lifecycle] \
  [--version 0.1.0] \
  [--min-version 0.0.0] \
  [--catalog-min-version 0.0.0] \
  [--repo-root .]
```

运行 `node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.mjs --help` 查看完整参数。

- 默认创建带 skill 的最小插件，并在平台文件中生成明确的原生调用元数据
- `--skill-short-description` 只控制初始 skill 的 UI metadata，必须为 25–64 字符；省略时兼容回退到 `--skill-description`，再回退到插件 UI 摘要，回退值也必须满足同一长度约束
- `--no-skills` 创建不含 skill 的插件
- `--with-mcp` / `--with-apps` 只在确实需要时使用
- `--with-config-api` / `--with-lifecycle` 添加插件根脚本和 Node 测试样板
- `--min-version` 写入插件 `compatibility.aw.minVersion`
- `--catalog-min-version` 提供目标 catalog 的作者校验上下文
- 脚手架不改 `plugins/marketplace-source.json`，也不生成平台 manifest

## 跨能力 Gotchas

- `.agents-plugin/plugin.json` 是唯一手动维护的 manifest；不要手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- 插件名、skill 名使用小写短横线格式，并与目录名一致。
- `version` 和 `compatibility.aw.minVersion` 使用严格 SemVer。CLI version、catalog version 和 plugin version 是三套身份。
- Catalog 分为 `@yiliang/aw-plugins-manifest` sidecar 包和 `@yiliang/aw-plugins` full catalog 包；插件作者只维护源码，不手改包内产物。
- 不在插件 manifest 声明最低 Codex / Claude Code 版本；AW CLI 内置门槛当前为 Codex `>= 0.145.0`、Claude Code `>= 2.1.88`。
- `marketplace.policy.products` 同时约束 build 裁剪、平台 marketplace、安装/升级门禁和 `pnpm plugin:test` 平台选择。
- `skills`、`mcpServers`、`apps`、`slashCommands` 使用单个 `./` 相对路径，且路径必须存在。
- 面向 Codex 的静态 skill 必须带 `agents/openai.yaml`，并显式声明 `policy.allow_implicit_invocation`。
- Skill 的调用方式是 Skill 设计的一部分。Codex 使用 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`；Claude 使用 `SKILL.md` frontmatter 的 `disable-model-invocation` 与 `user-invocable`。AW 原样保留这些字段。
- Agent Skills portable core 与 Claude/Codex 扩展要明确区分；默认 AW validator 接受目标平台的已知扩展，`--strict-agent-skills` 只接受 portable core。
- `dependencies.plugins` 只指向当前 catalog 内插件；版本门槛使用 `minVersion`，不写 range 或外部来源。
- lifecycle 和 renderer 要可重试、幂等；renderer V2 只返回 plan，不直接写 Codex/Claude Skill runtime、config、install record 或 diagnostic cache。完整静态 Skill 树用 target `sourceDirs`，动态 UTF-8 覆盖用 `content.files`。
- 插件根 `evals/**` 是作者期材料，不放进 Skill 子树，也不进入 production runtime bundle；动态 Skill 的行为评测必须消费 materialized 最终制品。
- `plugin:test` 只验证确定性脚本；`plugin:eval` v1 只提供 Codex 模型证据，真实模型只运行 project profile，user profile 只做确定性 materialization。
- Codex project 插件必须有 repo-managed surface；含 Apps 或纯 native-only 的插件不能 project 安装。
- `plugins/marketplace-source.json`、`packages/cli/plugins-dist/`、`~/.aw/` 和平台 manifest 都不是单插件作者手改入口。

字段全集、scope、状态投影、receipt 和分发细节留在对应 reference 与公开文档，不复制进主指令。

## 验证入口

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.mjs plugins/<name>
node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.mjs \
  plugins/<name> --strict-agent-skills
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform codex --scope project
pnpm plugin:test <dual-platform-plugin> --platform both --scope project
pnpm plugin:eval <plugin> --materialize-only --output-dir /tmp/aw-eval
pnpm plugin:eval <plugin> --suite trigger --split validation --runs 1 --output-dir /tmp/aw-eval
```

`validate_plugin.mjs` 默认校验 AW source profile；`--strict-agent-skills` 用于仓库内检查是否只使用 Agent Skills portable core，但不是上游 `skills-ref` 的替代品。`--json` 提供机器可解析结果。CLI 未构建时 validator 只做轻量预检；完整 contract 仍需先运行 `pnpm build`。

## 完成条件

- 只修改用户请求所需的插件源码和直接关联测试/文档
- 没有手改生成目录、runtime cache 或 marketplace 产物
- `validate_plugin.mjs` 通过，相关确定性测试通过
- 新建或重大修改的 Skill 有明确完成标准、验证循环、插件根 eval manifest 和小型用例
- Codex/Claude 动态 Skill 的 project/user final artifacts 已 materialize，并保留作者声明的原生调用元数据；真实模型未运行时明确列为未验证
- 最终回复列出改动、验证结果和未完成项

## 参考文档索引

| 文档 | 何时读取 |
|------|----------|
| `references/skill-design.md` | 创建/重写 skill，定义职责、description、正文和资源布局 |
| `references/skill-scripts.md` | skill 内需要可执行脚本 |
| `references/skill-evaluation.md` | 优化触发或验证模型输出质量 |
| `references/skills-and-triggers.md` | 平台 metadata、原生调用开关和显式调用规则 |
| `references/plugin-manifest-spec.md` | 查询 plugin.json 字段、分发和 manifest 示例 |
| `references/extensions-spec.md` | instructions / permissions / hooks / agents |
| `references/build-config-spec.md` | templates / fileRules / manifestOverrides |
| `references/mcp-and-apps.md` | `.mcp.json` / `.app.json` |
| `references/slash-commands.md` | 公共 slashCommands 源码与平台产物 |
| `references/aw-scripts-config-lifecycle.md` | 插件根 config、helper、lifecycle、renderer 和脚本测试 |
| `references/claude-only-capabilities.md` | Claude 命令结果填充、output styles、LSP、userConfig、channels |
| `references/comprehensive-example.md` | 完整 `code-review` 示例和构建产物预览 |

`references/.examples/code-review/` 是可直接读取的完整示例插件。隐藏父目录用于避免 Codex 把示例中的 `SKILL.md` 当作当前仓库的真实 skill。
