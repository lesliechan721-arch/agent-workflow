---
name: create-aw-plugin
description: 仅当用户明确要求在 `agent-workflows` 仓库创建或维护 `plugins/<name>/` 插件时使用；用于设计插件能力、向现有插件新增静态 Skill、管理插件版本、运行作者校验并修复 bundle 问题。不用于安装或使用插件、仓库外的通用 Skill 编写，或单纯解释 CLI。
compatibility: Requires the agent-workflows repository, Node.js 20+, and installed workspace dependencies.
---

# Create AW Plugin

在当前仓库创建或维护 agent-workflows 插件。插件默认同时支持 Codex 和 Claude Code，也可以通过 `marketplace.policy.products` 收窄到单个平台。

这里描述的是源码层公共 contract，不是 Claude Code / Codex 原生插件 schema 的全集。作者只维护 `plugins/<name>/` 下的源码真值；runtime bundle、catalog manifest、本地 runtime view 和平台 manifest 由 CLI / 发布流程生成。

本 Skill 负责创建和修复；独立只读评分、证据复核与发布门禁由 repo-local `skill-review` 负责，后者也能评审标准静态 Skill，避免作者工作流同时充当自己的 reviewer。

## 阅读路由

先确认任务属于哪一类，只读取本次需要的 reference。所有插件都必须有 `.agents-plugin/plugin.json`。

| 任务 | 必读 | 条件性补充 |
|------|------|------------|
| 新建或重写 skill | `references/skill-design.md`、`references/skills-and-triggers.md`、`references/plugin-manifest-spec.md` 的基础字段与平台原生调用元数据 | skill 内含脚本时读 `references/skill-scripts.md`；完成前读 `references/skill-evaluation.md` |
| 设计或调整 Skill 原生调用元数据 | `references/skills-and-triggers.md`、`references/skill-frontmatter-capabilities.generated.md` | 改 description 时读 `references/skill-design.md` 和 `references/skill-evaluation.md` |
| Extensions | `references/extensions-spec.md`、manifest 对应章节 | — |
| MCP / Apps | `references/mcp-and-apps.md`、manifest 对应章节 | — |
| 公共 slashCommands | `references/slash-commands.md` | 复杂工作流仍放 skill，并读 skill 设计文档 |
| AW Config / Lifecycle / 插件根脚本 | `references/aw-scripts-config-lifecycle.md` | 需要 manifest 字段时读对应章节 |
| Dynamic Artifacts | `references/plugin-manifest-spec.md` 的 `artifacts.targets`、`references/aw-scripts-config-lifecycle.md` 的 renderer | 静态 / 动态边界见 `references/extensions-spec.md` |
| Claude 专属能力 | `references/claude-only-capabilities.md` | 使用 buildConfig 时读 `references/build-config-spec.md` |
| 综合能力或产物预览 | `references/comprehensive-example.md` | 再按实际能力打开上面的单项 reference |
| 插件版本递增或门禁 | `references/plugin-manifest-spec.md` 的 version / compatibility block | production bundle 边界见 `references/skill-evaluation.md` |

不要为了“混合型插件”一次加载全部文档；按 manifest 中实际声明的能力逐项读取。

## 创建与维护工作流

1. **确认目标和边界**
   - 新建插件：确认插件名、用户目标、支持平台、允许修改文件和最小能力组合
   - 维护插件：先读现有 `.agents-plugin/plugin.json`、相关源码、原生调用元数据与测试，不重新脚手架
   - 完成条件：已列出允许修改文件、目标平台、现有或目标调用策略、声明能力和验证入口；关键项未知时不编辑
2. **选择能力**
   - 创建或重大重写 Skill 时先写 candidate brief：真实任务与证据、without-skill baseline、可观察成功指标、预期增量和相邻方案
   - 可调用、多步骤、需要模型判断的工作流 → skill
   - 常驻规则、权限、hooks、agents → extensions
   - 显式快捷入口 → 公共 `slashCommands`
   - 配置驱动的 Codex 产物 → dynamic artifact
   - 明确 Skill invocation：`model`、`manual` 或 `claude-model-only`
   - 完成条件：能力选择已与任务范围对齐；涉及创建或重大重写 Skill 时，baseline gap、invocation、Skill-specific description、信息层级和 eval strategy 均已确定，且不能证明 Skill 增量时使用更简单能力或不创建
3. **创建骨架**
   - 新插件可运行 `scripts/init_plugin.mjs`
   - 向现有插件新增一个静态 Skill 时运行 `scripts/add_skill.mjs`；不要用它修改其它能力
   - MCP、Apps、config、lifecycle、slashCommands、extensions 和 dynamic artifacts 直接按对应 reference 修改源码，不先转换成通用更新计划
   - 创建 Skill 时显式传 `--skill-invocation`；省略时采用 `model`
   - 只保留用户请求的能力，不预先生成 MCP、Apps、lifecycle 或 config
   - 完成条件：骨架的能力、调用元数据、独立 Skill description 和 eval starter 与上一步决定一致
4. **实现源码**
   - Skills → 编写 `SKILL.md`；面向 Codex 时同时提供 `agents/openai.yaml`
   - Extensions → 写入 manifest 的 `extensions`
   - MCP / Apps → 创建 `.mcp.json` / `.app.json`
   - Public slashCommands → 创建 `slash-commands/*.md`
   - AW Config / Lifecycle → 声明 `config` 和插件根 `scripts`
   - Dynamic Artifacts → 静态声明 target，renderer 只输出 `ArtifactPlan`
   - 完成条件：每个声明能力都有对应源码文件、字段和直接测试；没有修改生成目录或加入未请求能力
5. **管理插件版本**
   - `add_skill.mjs` 默认创建 minor release intent，不直接修改 plugin version
   - 其它 production bundle 变化使用 `scripts/add_plugin_change.mjs` 声明 major、minor 或 patch
   - 开发和 CI 反复修改时保留源码 manifest 中最近稳定版本；不要把 SemVer 当作编辑计数器
   - Skill `evals/**`、插件 `reports/**` 和 test-only 文件不进入 production bundle；Skill README 和 runtime 文件进入 production bundle
   - 完成条件：production bundle 有变化时存在对应 release intent；只有作者期材料变化时不创建 intent
6. **构建**
   - 运行 `pnpm build` 生成本地 staging/runtime bundle
   - 完成条件：命令 exit 0，目标 staging/runtime artifact 存在，且生成物只由构建产生
7. **验证并修复**
   - 运行 `scripts/validate_plugin.mjs`
   - validator 对仓库内插件默认用 `HEAD` 运行 author 门禁；CI 或分支对比用 `--version-base <git-ref>`
   - 需要检查全部变更插件时运行 `pnpm plugin:version:check -- --base <git-ref>`
   - 校验失败时按错误修复并重跑，直到通过
   - 默认 Claude profile 是 AW 最低支持版本 2.1.88；`current` profile 只用于核对当前字段，不改变 AW 的最低版本兼容门
   - 完成条件：默认 profile 通过；额外 profile 的结果与用途已区分为通过、诊断或未运行
8. **测试**
   - 插件根 Node 脚本运行 `pnpm plugin:test <plugin>`
   - 改到 manifest、bundle 或安装逻辑时运行相关 `pnpm test:*`
   - 每个 Skill 的作者期用例放在自身源码根 `evals/`，按 `references/skill-evaluation.md` 声明 owner、participants 和 profiles
   - `evals/README.md` 只记录该 owner 特有的 corpus、suite、命令、runner 限制和历史结果；不要复制全仓权限、隔离、进程、批次、发布或平台证据规则
   - 先运行 `pnpm plugin:eval <plugin> --skill <skill> --batch-name materialization --materialize-only` 验证 Codex 最终制品；真实模型 eval 只在本地显式运行
   - 完成条件：每个修改面有直接确定性测试；重大 Skill 修改有 with-skill/baseline behavior 和适用 trigger evidence；失败已修复并重跑
9. **交付**
   - full/release 评审消费完整 eval 后默认执行 `review:publish`；full 只生成正式报告，release 再把报告登记到 Skill README
   - 已发布的 full/release 报告可用 `review:release` 以后登记；插件 Skill README 变化必须由现有或新增 release intent 覆盖
   - 报告修改的源码文件、运行的验证、未验证项和仍需用户决定的风险
   - 完成条件：明确区分完整通过、轻量预检、模型证据和未运行项

## 脚手架

```bash
node .agents/skills/create-aw-plugin/scripts/init_plugin.mjs <plugin-name> \
  --description "插件描述" \
  --display-name "Display Name" \
  --short-description "简短 UI 描述" \
  [--skill-name <name>] \
  --skill-description "skill 的用户目标和使用时机" \
  [--skill-short-description "skill 的简短 UI 摘要"] \
  [--skill-invocation model|manual|claude-model-only] \
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

运行 `node .agents/skills/create-aw-plugin/scripts/init_plugin.mjs --help` 查看完整参数。

- 默认创建带 skill 的最小插件，调用策略为 `model`：Claude 允许模型发现，Codex 写入 `allow_implicit_invocation: true`
- `--skill-invocation manual` 同步生成 Claude manual-only 和 Codex implicit false；`claude-model-only` 隐藏 Claude 用户入口，但 Codex 没有完全等价能力，仍允许模型与显式调用
- 创建初始 Skill 时 `--skill-description` 必填，不能回退到插件 description
- `--skill-short-description` 只控制初始 Skill 的 UI metadata，必须为 25–64 字符；省略时只回退到 `--skill-description`
- 初始 Skill 同时生成 `evals/manifest.json`、trigger train/validation/sanity starter 和一个可写 behavior starter；发布前必须换成真实任务与断言
- `--no-skills` 创建不含 skill 的插件
- `--with-mcp` / `--with-apps` 只在确实需要时使用
- `--with-config-api` / `--with-lifecycle` 添加插件根脚本和 Node 测试样板
- `--min-version` 写入插件 `compatibility.aw.minVersion`
- `--catalog-min-version` 提供目标 catalog 的作者校验上下文
- 脚手架不改 `plugins/marketplace-source.json`，也不生成平台 manifest

向现有插件新增一个静态 Skill：

```bash
node .agents/skills/create-aw-plugin/scripts/add_skill.mjs <plugin-name> \
  --skill-name <name> \
  --skill-description "Skill 的用户目标和使用时机" \
  [--skill-short-description "25–64 字符 UI 摘要"] \
  [--skill-invocation model|manual|claude-model-only] \
  [--bump major|minor|patch] \
  [--repo-root .]
```

- 命令只新增一个静态 Skill，并在同一次写入中更新 manifest 能力和创建 release intent；冲突时不留下部分文件
- 双平台或 Codex 插件生成 `agents/openai.yaml` 和 eval starter；Claude-only 插件不生成不可运行的 Codex v2 eval
- 命令不修改插件根 README；完成 Skill 内容后按现有 README 结构人工补充条目
- dynamic Skill、slash command 或现有目录使用相同名称时直接失败

其它 production 变化创建 release intent：

```bash
node .agents/skills/create-aw-plugin/scripts/add_plugin_change.mjs <plugin-name> \
  --bump major|minor|patch --summary "变更摘要"
```

稳定发布时统一应用 intent：

```bash
node .agents/skills/create-aw-plugin/scripts/apply_plugin_releases.mjs --all
pnpm build
pnpm plugin:version:check:release -- --base <git-ref>
```

`bump_plugin_version.mjs` 只保留为显式的单插件版本维护工具，不用于普通开发循环：

```bash
node .agents/skills/create-aw-plugin/scripts/bump_plugin_version.mjs <plugin-name> \
  (--bump major|minor|patch | --version <semver>)
```

## 跨能力 Gotchas

- `.agents-plugin/plugin.json` 是唯一手动维护的 manifest；不要手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- 插件名、skill 名使用小写短横线格式，并与目录名一致。
- `version` 和 `compatibility.aw.minVersion` 使用严格 SemVer。CLI version、catalog version 和 plugin version 是三套身份。
- production bundle 因插件源码变化而改变时必须创建 release intent；author 门禁检查 intent，release 门禁才要求版本已提高。`check_plugin_versions.mjs` 不负责推断 CLI bundler 自身变化造成的产物变化。
- build metadata 不提高 SemVer precedence，不能作为插件升级版本。
- 普通构建的 development receipt 不可发布；beta version 只在临时 staging 中生成，stable 发布才更新源码 manifest。
- Catalog 分为 `@lesliechan721/aw-plugins-manifest` sidecar 包和 `@lesliechan721/aw-plugins` full catalog 包；sidecar 的发布账本保证 `plugin@version` 跨 beta/latest 不可变。插件作者只维护源码，不手改包内产物。
- 不在插件 manifest 声明最低 Codex / Claude Code 版本；AW CLI 内置门槛当前为 Codex `>= 0.145.0`、Claude Code `>= 2.1.88`。
- `marketplace.policy.products` 同时约束 build 裁剪、平台 marketplace、安装/升级门禁和 `pnpm plugin:test` 平台选择。
- `skills`、`mcpServers`、`apps`、`slashCommands` 使用单个 `./` 相对路径，且路径必须存在。
- 面向 Codex 的静态 skill 必须带 `agents/openai.yaml`，并显式声明 `policy.allow_implicit_invocation`。
- Skill 的调用方式是 Skill 设计的一部分。Codex 使用 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`；Claude 使用 `SKILL.md` frontmatter 的 `disable-model-invocation` 与 `user-invocable`。AW 原样保留这些字段。
- Agent Skills portable core 与 Claude/Codex 扩展要明确区分。字段、类型、目标 profile 和版本证据的单一事实源是 `packages/cli/src/utils/skill-frontmatter-capabilities.json`；`scripts/generate_skill_frontmatter_reference.mjs` 把作者字段表生成到 `references/skill-frontmatter-capabilities.generated.md`，不要手改生成表。
- 默认 validator 按 AW 最低 Claude 2.1.88 profile 校验；`--claude-skill-profile current` 可核对当前官方字段，但不能让高版本字段兼容最低宿主。`--strict-agent-skills` 只接受 portable core。
- 插件 manifest 不支持 `dependencies`；插件必须独立声明和生成自己的运行时能力。
- lifecycle 和 renderer 要可重试、幂等；renderer V2 只返回 plan，不直接写 Codex/Claude Skill runtime 或 config。所有静态和动态 Skill 源码根都固定为 `skills/<skill>`；声明 source 时，target `sourceDirs` 必须包含该规范根，overlay 不能进入名为 `evals` 或 `reports` 的目录。动态 UTF-8 覆盖用 `content.files`，最终 Skill 保留非空 `README.md`。
- Skill 根 `evals/**` 和插件根 `reports/**` 是作者期材料，不进入 production runtime bundle 或 runtime digest；动态 Skill 的行为评测必须消费 materialized 最终制品。Skill README 属于发布内容，不在构建时剥离。
- 插件和每个 Skill 都必须有非空 README。插件 README 只介绍插件目标、Skill 和使用边界；Skill README 约定记录最近已 release 的正式报告摘要、仓库相对路径和被评估 Git commit。full 报告只进入正式 reports 目录，不自动改变 README。
- 每次 `plugin:eval` 只选择一个 owner Skill，但 suite 可以用 `skills[]` 和 repo-local `profiles[].plugins[]` 评估跨 Skill、跨插件组合；这不形成 production dependency。
- 完整 eval 批次固定在项目 `.tmp/agent-workflows/evals/`，包含 run、target、raw、scorecard 和自动汇总。`review:publish` 后，插件正式报告写到 `plugins/<plugin>/reports/<skill>/<batch-id>/`，静态 Skill 写到 `.agents/reports/<skill>/<batch-id>/`；正式目录只含 `report.md` 和 `summary.json`。
- 每次 eval 必须用 `--batch-name` 新建批次，或用已有输出的 `--batch-id` 追加同一临时批次。`review:publish` 不修改 full 报告对应的 README；release 模式或后续 `review:release` 才登记 README。该登记会改变插件 production source，必须在批次封存后执行并由 release intent 覆盖。
- 真实模型 eval 默认要求 Full Access 以管理后代进程；`--allow-unmanaged-processes` 只在用户明确确认无法保证后代清理的风险后使用。
- `plugin:test` 只验证确定性脚本；`plugin:eval` 只提供 Codex 模型证据，真实模型只运行 project profile，user profile 只做确定性 materialization。
- Codex project 插件必须有 repo-managed surface；含 Apps 或纯 native-only 的插件不能 project 安装。
- `plugins/marketplace-source.json`、`packages/cli/plugins-dist/`、`~/.aw/` 和平台 manifest 都不是单插件作者手改入口。

字段全集、scope、状态投影、receipt 和分发细节留在对应 reference 与公开文档，不复制进主指令。

## 验证入口

```bash
node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/<name>
node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs \
  plugins/<name> --strict-agent-skills
node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs \
  plugins/<name> --claude-skill-profile current
node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs \
  plugins/<name> --version-base <git-ref>
node .agents/skills/create-aw-plugin/scripts/check_plugin_versions.mjs \
  --all --base <git-ref>
node .agents/skills/create-aw-plugin/scripts/generate_skill_frontmatter_reference.mjs \
  --check
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform codex --scope project
pnpm plugin:test <dual-platform-plugin> --platform both --scope project
pnpm plugin:eval <plugin> --skill <skill> --batch-name materialization --materialize-only
pnpm plugin:eval <plugin> --skill <skill> --batch-name trigger-validation --suite trigger --split validation --runs 1
```

`validate_plugin.mjs` 默认校验 AW source profile，并对仓库内正式插件使用 `HEAD` 做版本检查；`--strict-agent-skills` 用于仓库内检查是否只使用 Agent Skills portable core，但不是上游 `skills-ref` 的替代品。`--json` 提供机器可解析结果。CLI 未构建、Git 不可用或 `packages/cli/dist` 的 manifest contract 已过期时，单插件 validator 警告并只做可用的轻量预检；独立全仓版本门禁在这些条件下失败。

## 完成条件

- 只修改用户请求所需的插件源码和直接关联测试/文档
- 没有手改生成目录、runtime cache 或 marketplace 产物
- `validate_plugin.mjs` 通过，相关确定性测试通过
- 新建或重大修改的 Skill 有 candidate/value evidence、明确 invocation、局部完成标准和验证循环；支持 Codex 时有自身 `evals/manifest.json` 和真实小型用例，Claude-only 时明确记录当前只完成确定性验证
- Codex/Claude 动态 Skill 的 project/user final artifacts 已 materialize，并保留作者声明的原生调用元数据；真实模型未运行时明确列为未验证
- 最终回复列出改动、验证结果和未完成项
- 插件和 Skill README 已补齐；有 release 登记的 Skill README 指向对应正式报告，只有 full 报告时不要求更新；插件 README 不包含 Skill 验证报告
