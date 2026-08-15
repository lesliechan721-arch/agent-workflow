---
name: create-aw-plugin
description: 仅当用户明确要求在 `agent-workflows` 仓库创建或维护 `plugins/<name>/` 插件时使用；用于设计插件能力、向现有插件新增静态 Skill、管理插件版本、运行作者校验并修复 bundle 问题。不用于安装或使用插件、仓库外的通用 Skill 编写，或单纯解释 CLI。
compatibility: Requires the agent-workflows repository, Node.js 22+, and installed workspace dependencies.
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
   - 新插件保留脚手架写入的初始 version（默认 `0.1.0`），首版不创建 release intent
   - 向已有插件新增 Skill 时，`add_skill.mjs` 默认创建 minor release intent，不直接修改 plugin version
   - 已有插件的其它 production bundle 变化使用 `scripts/add_plugin_change.mjs` 声明 major、minor 或 patch
   - 开发和 CI 反复修改时保留源码 manifest 中最近稳定版本；不要把 SemVer 当作编辑计数器
   - Skill 根的直接子目录 `evals/**`、`reports/**`、插件根 `reports/**` 和 test-only 文件不进入 production bundle；更深层的同名目录、Skill README 和其它 runtime 文件进入 production bundle
   - 完成条件：新插件保持初始 version 且没有 intent；已有插件的 production bundle 有变化时存在对应 intent；只有作者期材料变化时不创建 intent
6. **按变更面构建**
   - 新建插件，或 manifest、README、Skill、runtime 脚本、bundle / 安装合同等 production bundle 输入变化时，运行 `pnpm build` 生成本地 staging/runtime bundle
   - 只有上述顶层作者目录或 test-only 材料变化时默认跳过 build；用户或隔离环境明确限制 build 时也不强行运行，并把对应 production artifact 列为未验证
   - 完成条件：需要 build 时命令 exit 0，目标 staging/runtime artifact 存在且只由构建产生；跳过时原因能追溯到 author-only 变更或明确限制
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
   - 确定性测试必须执行真实 helper、lifecycle、renderer、validator 或 bundle 路径，并断言可观察行为、失败边界或结构化公开合同；不得读取源码、脚本、配置或文档后用 prose 正则、固定文本、固定版本或实现细节冒充行为验证
   - Skill 和 prompt 的确定性测试只保留结构、模板、平台元数据、关键禁止项和最小安全不变量；模型需要理解、判断、路由或完成任务的语义合同使用 eval
   - 每个 Skill 的作者期用例放在自身源码根 `evals/`，按 `references/skill-evaluation.md` 声明 owner、participants 和 profiles
   - `evals/README.md` 只记录 owner 特有信息；完整权限、隔离、进程、批次和发布合同留在 `references/skill-evaluation.md`
   - 新增或修改 case 后运行 `validate_eval_cases.mjs`；当前修改或发布使用的文档增加 `--strict`
   - Eval 失败先检查 oracle、fixture、grader、runtime 和运行方差；只有通过 Case Admission 且归因为 `skill-defect` 的失败可以驱动 Skill 修改
   - Eval-driven 修改后重跑原 case、同族变体、minimal pair、相反标签 near-miss、固定 validation/sanity 和关键 regression
   - 先 materialize 最终制品；真实模型 eval 只在本地显式运行，并严格遵守 `references/skill-evaluation.md` 的权限、进程和等待合同
   - 完成条件：每个修改面有直接确定性测试；重大 Skill 修改有 with-skill/baseline behavior、适用 trigger evidence、有效 oracle 和 eval-change-safety 回归；失败已归因、修复并重跑
9. **交付**
   - 报告修改的源码文件、运行的验证、未验证项和仍需用户决定的风险
   - 正式报告发布和 Skill README 登记必须分别获得用户明确授权；命令、封存和 release intent 合同见 `references/skill-evaluation.md`
   - 完成条件：明确区分完整通过、轻量预检、模型证据和未运行项

## 脚手架

新插件使用 `scripts/init_plugin.mjs`；向已有插件新增静态 Skill 使用 `scripts/add_skill.mjs`；其它 production 变化使用 `scripts/add_plugin_change.mjs` 创建 release intent。先运行对应脚本的 `--help`，只传本次任务需要的能力和显式 `--skill-invocation`。

稳定版本应用、单插件显式 bump 和版本门禁的命令只在版本分支使用，见 `references/plugin-manifest-spec.md` 的 version / compatibility block。

## 跨能力 Gotchas

这里只保留所有作者分支都需要的源码与安全不变量。版本/catalog、dynamic artifact、eval/review 和 platform scope 的细节按上面的阅读路由进入对应 reference。

- `.agents-plugin/plugin.json` 是唯一手动维护的 manifest；不要手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- 插件名、skill 名使用小写短横线格式，并与目录名一致。
- 新插件保留初始 version，首版不创建 release intent；已有插件的 production bundle 因源码变化而改变时必须创建 intent，author 门禁检查 intent，release 门禁才要求版本已提高。
- `skills`、`mcpServers`、`apps`、`slashCommands` 使用单个 `./` 相对路径，且路径必须存在。
- 面向 Codex 的静态 skill 必须带 `agents/openai.yaml`，并显式声明 `policy.allow_implicit_invocation`。
- Skill 的调用方式是 Skill 设计的一部分。Codex 使用 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`；Claude 使用 `SKILL.md` frontmatter 的 `disable-model-invocation` 与 `user-invocable`。AW 原样保留这些字段。
- 插件 manifest 不支持 `dependencies`；插件必须独立声明和生成自己的运行时能力。
- `plugins/marketplace-source.json`、`packages/cli/plugins-dist/`、`~/.aw/` 和平台 manifest 都不是单插件作者手改入口。

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
node .agents/skills/skill-review/scripts/validate_eval_cases.mjs \
  plugins/<plugin>/skills/<skill>/evals/trigger-cases.json --format json
node .agents/skills/skill-review/scripts/validate_eval_cases.mjs \
  plugins/<plugin>/skills/<skill>/evals/evals.json --format json
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform codex --scope project
pnpm plugin:test <dual-platform-plugin> --platform both --scope project
pnpm plugin:eval <plugin> --skill <skill> --batch-name materialization --materialize-only
pnpm plugin:eval <plugin> --skill <skill> --batch-name trigger-validation --suite trigger --split validation --runs 3
```

带 `--suite` / `--split` 的命令只完成所选 target，batch 仍为 `incomplete`；正式发布评估使用 `references/skill-evaluation.md` 中不带过滤参数的入口。

`validate_plugin.mjs` 默认校验 AW source profile，并对仓库内正式插件使用 `HEAD` 做版本检查；`--strict-agent-skills` 用于仓库内检查是否只使用 Agent Skills portable core，但不是上游 `skills-ref` 的替代品。`--json` 提供机器可解析结果。CLI 未构建、Git 不可用或 `packages/cli/dist` 的 manifest contract 已过期时，单插件 validator 警告并只做可用的轻量预检；独立全仓版本门禁在这些条件下失败。

## 完成条件

- 只修改用户请求所需的插件源码和直接关联测试/文档
- 没有手改生成目录、runtime cache 或 marketplace 产物
- `validate_plugin.mjs` 通过，相关确定性测试通过
- 新建或重大修改的 Skill 有 candidate/value evidence、明确 invocation、局部完成标准和验证循环；支持 Codex 时有自身 `evals/manifest.json`、错误代价 policy 和通过 Case Admission 的真实小型用例，Claude-only 时明确记录当前只完成确定性验证
- Eval-driven 修改只来自已归因为 `skill-defect` 的有效 case，并已通过同族、minimal pair、相反标签和固定回归集检查
- Codex/Claude 动态 Skill 的 project/user final artifacts 已 materialize，并保留作者声明的原生调用元数据；真实模型未运行时明确列为未验证
- 最终回复列出改动、验证结果和未完成项
- 插件和 Skill README 已补齐；有 release 登记的 Skill README 指向对应正式报告，只有 full 报告时不要求更新；插件 README 不包含 Skill 验证报告
