# `create-agent-workflows-plugin` Skill Delta Review

> 审查模式：`delta`，并重新核对 release gates
> 审查协议：repo-local `skill-review` v3
> 核验时间：2026-08-12 01:20 +08:00
> 上一版基线：2026-08-12 修改前工作树快照；上一份 release review 日期为 2026-08-09

## Executive verdict

- **Skill：** `create-agent-workflows-plugin`
- **Mode：** `delta`
- **Direction：** `aligned`
- **Release：** `pass-after-fixes`
- **Weighted score：** **80.2 / 100**（strong）
- **Coverage：** **100%**
- **Confidence：** **high，0.91**
- **P0 findings：** 0
- **P1 findings：** 0
- **Failing gate：** `release-evidence`（P1）

**一句结论：** 上轮 finding 和本轮独立上下文复核发现的实现根因均已按正确 owner 修复；当前没有未关闭的 P0/P1 实现 finding。唯一发布阻断是 release-required trigger/behavior suite 尚未实际运行，因此没有结果 bundle、trace 和 baseline delta。

## Review contract

| Item | Source-derived statement | Status |
| --- | --- | --- |
| Target problem | 在 `agent-workflows` 仓库创建或维护 `plugins/<name>/`，并正确处理双平台 Skill、manifest、动态内容和作者验证。 | known |
| Observed failures | 旧版把脚手架固定为 manual-only；字段 registry 漏字段、类型和值语义有漂移；release behavior suite 只读；隔离 subject 缺 validator 依赖；`.git` 变更可逃逸 diff。 | known，均已复现并修复 |
| Success criteria | 默认脚手架生成自动触发 Skill，参数可选择调用策略；字段按目标 profile 正确分类；隔离行为 eval 能运行 validator 并机械阻断控制目录变更；确定性测试通过。 | known |
| Intended environment/client | 当前 monorepo、Node.js 20+、Codex 与 Claude Code；AW 最低 Claude Code 版本为 2.1.88。 | known |
| Out of scope | 安装或使用插件、仓库外通用 Skill、手改生成目录/runtime cache、在本轮自动运行付费或有凭据的真实模型 eval。 | known |
| Adjacent skills | repo-local `skill-review` 做独立只读审查；普通静态 Skill 创建不属于本 Skill。 | known |
| Release requirement | trigger 和 behavior suite 均 `requiredForRelease: true`；完整发布证据必须有实际结果、baseline、trace 和完整性状态。 | known |

## Release gates

| Gate | Status | Severity | Evidence | Reason |
| --- | --- | --- | --- | --- |
| package-validity | pass | P0 | inspector、build、smoke build | 根包、frontmatter、目录和构建产物有效。 |
| critical-artifacts | pass | P0 | 37 文件枚举；三个脚本语法与帮助；reference 生成检查 | 主流程所需资源存在且可执行。 |
| goal-alignment | pass | P0 | 脚手架集成测试、Skill 路由与边界 | 默认 `model` 和显式 invocation 参数符合用户决定。 |
| capability-validity | pass | P0 | unit/integration/build/smoke | 核心流程使用当前仓库已实现的能力。 |
| safety-permissions | pass | P0 | workspace-write contract 与 app-server tests | 写入只发生在隔离副本；网络关闭；越界 diff、根 `.git` 变更和 artifact 失败会阻断。 |
| architecture-ownership | pass | P1 | registry、生成 reference、source/bundle validators | 易变字段、profile 值和大小写语义不再由 prose 和多个 allowlist 分别维护。 |
| release-evidence | **fail** | **P1** | manifest 与 cases 已通过静态合同；无模型结果目录 | suite 已可执行，但未提供实际 trigger rate、behavior trace、baseline delta 或完整 release bundle。 |

## Dimension scorecard

| Dimension | Weight | Score | Weighted | Confidence | Summary |
| --- | ---: | ---: | ---: | --- | --- |
| Specification & package integrity | 7 | 4.5 | 6.3 | high | 包、脚本、eval 与构建合同有效；未运行上游 `skills-ref`。 |
| Problem grounding & value | 8 | 4.0 | 6.4 | medium | 已增加 candidate/baseline gate；其自身模型 baseline 尚无结果。 |
| Invocation, triggering & pointers | 12 | 3.0 | 7.2 | medium | invocation 和 corpus 已修复；没有真实 trigger rate，按证据上限计分。 |
| Scope, boundaries & composition | 8 | 4.5 | 7.2 | high | plugin、Skill、UI summary 和 reviewer 边界清楚。 |
| Program, completion bounds & calibration | 12 | 4.5 | 10.8 | high | 主流程与生成模板均有局部完成条件。 |
| Information hierarchy & disclosure | 12 | 4.5 | 10.8 | high | branch route 保持简洁；字段表改为条件式生成 reference。 |
| Architecture ownership | 10 | 4.5 | 9.0 | high | schema、runner、作者和 reviewer owner 正确。 |
| Scripts & deterministic automation | 8 | 4.5 | 7.2 | high | 三个脚本均通过语法、帮助、样例或直接测试。 |
| Resource reachability & co-location | 5 | 4.5 | 4.5 | high | 核心资源可达；inspector 剩余项为示例/任务产物误报。 |
| Evals & evidence-driven iteration | 10 | 2.0 | 4.0 | medium | 可执行合同已完成，但没有实际模型 evidence。 |
| Reliability, safety & compatibility | 4 | 4.0 | 3.2 | high | profile、版本和诊断已表驱动验证；未做真实宿主 run。 |
| Pruning, source of truth & change discipline | 4 | 4.5 | 3.6 | high | 删除重复索引；字段事实集中；主文件净增仅 2 行。 |
| **Total** | **100** |  | **80.2** | **0.91 / high** | **pass-after-fixes** |

## Strengths

1. **用户决定已成为确定性合同。** `init_plugin.mjs` 默认生成 model-invoked Skill；`--skill-invocation model|manual|claude-model-only` 同步生成 Claude 和 Codex 元数据。
2. **字段事实已有单一 owner。** `skill-frontmatter-capabilities.json` 由作者 validator、CLI bundle validator、生成 reference 和表驱动测试共同消费；它覆盖 `version`、current free-form `metadata`、profile-specific boolean token 和值大小写语义。
3. **诊断不再混淆不同错误。** unknown、目标版本不支持、关联字段缺失、类型/值错误和 portable extension 使用不同 code。
4. **行为 suite 现在能测试真实作者工作。** 三个 case 分别创建自动触发插件、创建 manual 副作用插件和给已有 Skill 增加脚本。
5. **写入 eval 有机械安全边界。** runner 检查目录、文件、symlink、根 `.git` 控制目录、允许路径、文本、JSON 子集和 digest，并保留 current/baseline evidence。隔离 subject 显式带入 validator 所需的 YAML 包和 registry。
6. **P2 修复没有让主 Skill 明显沉积。** 底部重复 reference index 被删除；`SKILL.md` 相对基线只增加 2 行和约 390 tokens。

## Required findings

独立上下文 reviewer 在实现过程中发现并关闭四组 P1：根 `.git` 未进入 workspace snapshot；隔离 behavior subject 缺少 YAML/registry；frontmatter registry 缺 `version`，且 boolean、current metadata 和大小写语义不完整；JSON import attributes 与声明的 Node `>=20` 范围不兼容。registry loader 已改为 `createRequire`，同时由 type-only JSON import 保证 tsc 复制 runtime JSON。定向回归均已通过。当前没有未关闭的 P0/P1 实现 finding。`release-evidence` gate 仍失败，因为缺少真实模型运行结果；这不是新的包结构缺陷。

## Non-blocking findings

当前没有需要继续修改源码的 P2 finding。动态 non-default artifact case 可作为后续覆盖扩展，但不是本轮最小发布用例集的必要条件。

## Invocation and Pointer Audit

| Pointer | Target material | Trigger branches | Intent front-loaded? | Duplicate synonym branch? | Repeats body identity? | Eval evidence | Recommendation |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| Root description | 整个作者 Skill | 在本仓库创建/维护 `plugins/<name>`；排除安装、使用、仓库外 Skill 和 CLI 解释 | yes | no | low | corpus present，results absent | 保留。 |
| 新建/重写 Skill | design、trigger、manifest、script/eval 条件分支 | 新建或重大重写 | yes | no | no | writable create cases present | 保留。 |
| 原生调用 metadata | trigger principles + generated capability table | invocation、description、profile 或字段变更 | yes | no | no | schema tests present | 保留生成表；不要恢复 prose 全集。 |
| Manifest/extension/config/dynamic routes | 单项 reference | manifest 实际声明对应能力 | yes | no | no | deterministic tests | 保持按能力披露。 |
| 综合示例 | hidden code-review example | 需要完整产物预览 | yes | no | no | example validator pass | 保持条件式。 |
| Eval completion pointer | skill-evaluation | 新建/重大修改和交付前 | yes | no | no | validate-only pass | 实际模型运行后再关闭 release gate。 |

## Information Hierarchy Map

| Content | Type | Applicable branch | Current location | Needed every run? | Reaching pointer / environment source | Completion boundary | Recommendation |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 目标、源码真值、角色边界 | in-file-reference | all | `SKILL.md:9-13` | yes | Skill 激活 | 只修改授权源码 | 保留。 |
| 八步作者流程 | in-file-step | all | `SKILL.md:33-73` | yes | 直接加载 | 每步局部 criterion | 保留。 |
| Candidate/value、invocation、hierarchy | disclosed-reference | 新建/重写 Skill | `references/skill-design.md` | no | 新建/重写 route | 设计输入均确定 | 保留。 |
| 当前宿主字段与版本 | environment-lookup | frontmatter/profile | registry + generated reference | no | metadata route | 目标 profile 可解释全部字段 | 当前 owner 正确。 |
| Eval 方法与写入合同 | disclosed-reference | eval/完成前 | `references/skill-evaluation.md` | no | completion pointer | required suite 完整 | 等待运行 evidence。 |
| scaffold/validator/reference generation | environment-lookup | 创建、校验、schema 更新 | `scripts/*.mjs` | no | workflow 与 validation commands | exit 0 / `--check` pass | 当前 owner 正确。 |
| 综合示例 | disclosed-reference | 多能力预览 | hidden code-review example | no | explicit example route | 仅用于比对 | 保留隐藏父目录。 |

## Completion Boundary Audit

| Step or rule set | Current criterion | Clear? | Checkable? | Demand sufficient? | Exhaustive? | Premature-completion risk | Recommendation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1. 目标与边界 | 文件、平台、invocation、能力、验证入口已知 | yes | yes | high | yes | low | 保留。 |
| 2. 选择能力 | 范围对齐；Skill 分支还要求 baseline、description、hierarchy、eval | yes | mostly | high | yes | low | 模型结果用于校准，不再加 prose。 |
| 3. 创建骨架 | 元数据、description、eval starter 与决定一致 | yes | yes | high | yes | low | 保留。 |
| 4. 实现源码 | 每项能力有源码、字段和直接测试 | yes | yes | high | mostly | low | 保留。 |
| 5. 构建 | exit 0、artifact 存在、无手改生成物 | yes | yes | high | yes | low | 保留。 |
| 6. 验证并修复 | minimum/current/portable 结果分开 | yes | yes | high | yes | low | 保留。 |
| 7. 测试 | change-to-test、baseline behavior、trigger evidence | yes | yes | high | yes | medium | 未运行模型时必须标 unknown。 |
| 8. 交付 | 区分通过、轻量、模型 evidence 和未运行 | yes | yes | high | yes | low | 保留。 |
| 生成的 Skill 模板 | 每个关键步骤有 completion TODO | yes | yes | medium | mostly | medium | 由作者替换 TODO；validator 会阻断遗留 TODO。 |

## Architecture and ownership

- **Skill-owned policy：** 使用时机、源码真值、能力选择、invocation 原则、作者流程、完成边界和交付规则。
- **Schema/client-owned facts：** frontmatter 字段、类型、profile、版本、依赖和 accepted values，现由 versioned registry 持有。
- **Runtime-owned state：** 安装记录、native cache、materialized workspace、模型执行、credential capsule 和 eval evidence。
- **Script candidates：** scaffold、source validation、字段 reference generation、eval contract、workspace diff 和 artifact assertions；现已脚本化。
- **Role-only constraints：** 作者不自评分；reviewer 只读；真实模型运行需要显式入口。
- **Eval/issue-only concerns：** trigger rate、行为差异、token/time/variance、真实宿主差异。
- **Natural-language state-machine risk：** low。

## Scripts and resources

- **Scripts present or correctly omitted：** `init_plugin.mjs`、`validate_plugin.mjs`、`generate_skill_frontmatter_reference.mjs`。
- **Interface/dependency/safety quality：** 全部非交互并支持 `--help`；脚手架拒绝覆盖；validator 有 JSON 输出；生成器有 `--check`；workspace-write runner 关闭网络并检查越界改动。
- **Deterministic logic still repeated by the model：** 未发现字段全集或 eval diff 检查仍由模型手工维护。
- **References/assets reachability：** 核心 reference 从主文件直接到达；hidden example 通过综合示例 route 到达。
- **Duplication：** 旧字段表和底部重复 reference index 已移除。
- **Scattering / co-location：** registry 在 CLI schema owner；作者表在 Skill reference；验证算法位于 source/bundle runner。
- **Environment facts unnecessarily cached：** current profile 以 `verifiedOn` 标记；文档要求重新核对当前官方来源。
- **Stale or orphaned resources：** 未发现。inspector 报告的 missing 项是示例内部相对路径或 eval 预期创建文件，不转成 finding。

## Evals and evidence

- **Trigger eval and rates：** 26 条，13 positive / 13 negative；train 12、validation 8、sanity 6；自动触发语料不含 `$create-agent-workflows-plugin`。无运行结果，rates unknown。
- **Behavior/regression eval：** 3 个 `workspace-write` case，覆盖 model 创建、manual 创建、已有 Skill + script 修改；静态合同和隔离 subject 的 scaffold→validator 确定性 smoke 通过。无实际模型结果。
- **Runtime traces：** none supplied。
- **Baseline：** runner 已配置 `with_skill` / `without_skill`，但没有产出。
- **Ablation / no-op evidence：** none supplied。
- **Token/time/variance cost：** none supplied。
- **Evidence missing for release：** 完整 release 运行、trigger rates、behavior trace、workspace/artifact evidence、qualitative review、baseline delta 和 completeness 状态。

## Delta and sediment

- **Previous P0/P1 closure：** F-001 已关闭；F-002 的只读 suite/runner 根因已关闭，但实际 release evidence 尚未生成，因此 gate 仍失败。
- **Affected dimensions：** triggering、instruction_design、context_disclosure、architecture、scripts、evals、reliability、maintainability。
- **Direct regressions：** 未观察到；893 unit、107 integration、6 build smoke 和 1 plugin-script smoke 均通过。
- **SKILL.md / pointer / branch / resource delta：** 主文件 +2 行、约 +390 tokens；删除重复索引；新增一个生成字段表和对应生成器。包从 35 个文件增至 37 个文件。
- **Behavior metric delta：** unknown；没有新模型结果，不能声称行为率已改善。
- **Rules added and what they replaced：** local completion criteria 替代仅有全局 checklist；registry/generated table 替代 prose + allowlist；invocation mode 替代隐藏 manual 默认；writable case contract 替代只读行为说明。
- **Sediment candidates：** 未发现需要继续追加的规则；下一步应运行 evidence，不应再加 prose。
- **Net required change：** larger。增量主要位于 schema、eval runner 和测试 owner；主 Skill context 基本保持中性。

## Minimal improvement roadmap

### Now — release blockers

1. 在外层沙箱允许的普通 Terminal 运行完整 static Skill release eval，不使用 suite/case/runs 过滤。
2. 对 `needs_review` 行为结果完成 trace/diff 定性复核，并保存完整结果 bundle。
3. 只有 trigger、behavior、baseline 和 completeness 均通过后，才能把 `release-evidence` 改为 pass。

### Next — high-value quality improvements

1. 若动态 artifact 作者行为是下一版重点，再增加 default/non-default、project/user materialization case；不要在没有真实失败时扩大 suite。

### Later — heuristic, eval or product/runtime work

1. 在真实 Claude Code 与 Codex 宿主上抽样验证 invocation 和 current-only 字段。
2. 宿主字段变化时更新 registry、重生成 reference，并运行 field/profile 表驱动测试。

## Unknowns

1. 真实 trigger 命中率与误触发率。
2. 三个 behavior case 的 current/baseline 差异、trace、token、时间和方差。
3. 真实 Claude Code/Codex host behavior。
4. 上游 `skills-ref validate` 结果。
5. `disallowed-tools` 的精确 introduced version；当前官方文档确认支持，但未给最低版本。

## Validation record

| Check | Result | Notes |
| --- | --- | --- |
| `inspect_skill_target.mjs ... --previous ... --format json` | pass | 37 files；low state-machine risk；信息级 reference 误报已复核。 |
| 三个作者脚本 `node --check` / `--help` | pass | 非交互入口可用。 |
| capability reference `--check` | pass | 生成表与 registry 完全一致。 |
| example `code-review` author validator | pass | built CLI full contract 可用。 |
| static eval `--validate-only` | pass | trigger + behavior；central contract true。 |
| 独立上下文实现复核 | pass | 找到的 `.git`、隔离依赖、registry 和 Node 20 语法兼容 P1 均已修复；最终确认无 P0/P1 实现或 Git 提交阻塞。 |
| isolated subject scaffold→validator smoke | pass | 不使用 `NODE_PATH`；subject 自带 YAML 依赖和 registry。 |
| `pnpm build` | pass | registry 已进入 `dist`。 |
| dist registry loader | pass | 使用 `createRequire`；无 import attributes/assertions；同目录 JSON 存在且可加载。 |
| `pnpm test:unit` | pass | 68 files，893 tests。 |
| `pnpm test:integration` | pass | 9 files，107 tests。 |
| `pnpm test:smoke:build` | pass | 6 tests；仅有既存 sourcemap warning。 |
| `pnpm test:smoke:plugin-scripts` | pass | 1 test；仅有既存 sourcemap warning。 |
| scorecard validator | pass | 80.2；coverage 100%；confidence 0.91；无 diagnostics。 |
| real model eval | not run | 按授权边界保留为 release blocker。 |

## Current sources checked

- [Agent Skills specification](https://agentskills.io/specification)
- [Claude Code Skills and frontmatter](https://code.claude.com/docs/en/skills)
- [Codex Skills](https://developers.openai.com/codex/build-skills)
- 本地 Claude Code 2.1.88 source snapshot：`src/utils/frontmatterParser.ts`、`src/skills/loadSkillsDir.ts`、`src/utils/effort.ts`

## Stop decision

本轮应停止修改。上轮静态和结构根因已经关闭，确定性测试没有直接回归。继续增加规则不会提高 release confidence。下一轮只应在完整真实模型 eval bundle、实际宿主失败或新的官方字段变化出现后开始。
