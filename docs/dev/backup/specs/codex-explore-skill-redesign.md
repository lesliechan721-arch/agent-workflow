# Codex Explore Skill 重设计需求 Spec

日期：2026-05-08

P11 发布门禁结论（2026-05-09）：仓库内 `codex.skill` 基础设施和 `codex-explore` 新入口已完成，`$codex-explore` 以通用只读探索 workflow 发布。它可以把代码库、文档、网络资料、长日志、PR / issue 和用户材料作为 prompt 来源；具体能访问哪些来源取决于当前会话工具、权限、联网策略、用户提供的上下文和上层安全要求。

源码依据：`codex-rs/core/src/agent/role.rs:368-377` 把内置 `explorer` 描述为 `specific codebase questions` / `well-scoped questions on the codebase`，`codex-rs/core/src/agent/builtins/explorer.toml` 为空，没有额外声明模型、工具或外部来源扩展合同；同时 `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs:83-104` 会在克隆父 turn 配置后叠加 role，`codex-rs/core/src/tools/handlers/multi_agents_common.rs:225-236` 会把父 turn 的模型、工具、developer instructions、sandbox/permission 等有效配置传给子代理。因此这里的通用能力来自 `spawn_agent` 继承当前会话可用能力和 `$codex-explore` prompt 约束，不来自内置 `explorer` role 自带不受限制的外部来源合同。

## 背景

当前 `codex-explore` 同时提供两条入口：默认轻量 `developer_instructions` 和显式 `$codex-explore` skill。轻量入口会把一段提示词写入 Codex 全局上下文，指导主 agent 在合适场景使用内置 `explorer` role；显式 skill 则使用专用 `codex-explorer` role。

实际使用后发现，轻量入口的价值很有限。它不能突破 Codex runtime 对 `spawn_agent` 的全局授权规则；如果写得保守，就只是在用户已经明确要求并行或子代理时提醒一次，价值接近 skill，却一直占上下文。如果写得激进，又容易和 `spawn_agent` 工具说明冲突。专用 `codex-explorer` role 也带来了额外的 role 注册、冲突检测、tracking、status 和迁移成本，但它做的事情可以由 Codex 内置 `explorer` role 承担。

本轮把 `codex-explore` 从“代码库探索”扩展为“通用只读探索”。P11 复核后确认，内置 `explorer` role 文案偏代码库问题，但子代理通过 `spawn_agent` 继承当前会话工具、权限和资料上下文；因此发布态 skill 文案和触发描述应覆盖网络搜索、外部官方文档检索、长日志排查、多源事实核对和用户提供数据摘要等只读探索场景，同时写清访问限制。

同时，当前 `plugins/codex-explore/scripts/render-artifacts.mjs` 里的 `trimBlock()` 只做 `trimEnd()`，没有 dedent。用缩进模板字符串生成 Markdown/TOML 内容时，输出正文会保留多余前导空格，部分内容在 Markdown 语义上接近代码块。这个质量问题需要在本次重设计里一起修复，避免未来受管提示词或受管 skill 内容继续带着错误缩进。

## 当前基线事实

- `codex-explore` 是 Codex-only 插件，源码在 `plugins/codex-explore/`。
- 当前 manifest 声明了 `scripts.artifacts.render`，并通过动态 artifact 生成 `lightweight-instruction` 和 `codex-explorer-role`。
- 当前 `SKILL.md` 说明 `$codex-explore` 会使用 `agent_type = "codex-explorer"`，也就是依赖专用 role。
- Codex 已有内置 `explorer` role；选择 `agent_type = "explorer"` 时，可以在 `spawn_agent` 调用参数里传入 `model` 和 `reasoning_effort`。
- `wait_agent` 只等待子代理结束，不会关闭子代理；一次性探索 agent 用完后仍需要 `close_agent`。
- 当前插件配置包含 `enableLightweightInstruction`、`explorerModel` 和 `modelReasoningEffort`。重设计后仍需要保留 `explorerModel` 和 `modelReasoningEffort`，但不再需要 `enableLightweightInstruction`。
- Codex skill 的触发策略由 `skills/<skill>/agents/openai.yaml` 的 `policy.allow_implicit_invocation` 决定；`skillTriggers.<skill>.allowInstallOverride` 只表示安装时是否允许用户用 `--skill-trigger manual|auto|default` 覆盖。
- AW CLI 底座已经有 AW-owned 清理、historical tracking 回推、ownership-aware instruction / role 删除，以及 Codex project scope 升级时按 tracking 和新产物做 stale prune 的通用链路。本设计应复用这些 contract，不应让 `codex-explore` 在 renderer 或 lifecycle 里直接手改 `.codex`、`.agents/skills`、role 文件或 Codex config。
- 现有动态 artifact target contract 还只支持 `codex.developerInstructionsBlock` 和 `codex.agentRole`，`codex.skill` 尚未进入 `ArtifactTarget`、manifest schema、artifact plan validation、install record / diagnostic cache 和作者工具文档。
- 现有升级 stale prune 的触发点只覆盖 `Codex + project scope + upgrade`。`codex.skill` 新基线落地后，后续插件升级如果移除、改名或替换 dynamic skill artifact，也需要 user scope 具备同等级 stale prune 和 rollback 保护。

## 已确认决策

- 去掉默认轻量 `developer_instructions` 入口，不再向 Codex 顶层上下文注入探索提示词。
- 去掉专用 `codex-explorer` role，不再安装 `[agents.codex-explorer]` 注册项或 role layer 文件。
- `$codex-explore` 成为唯一产品入口。skill 被触发后，主 agent 直接使用 Codex 内置 `explorer` role。
- 本设计把内置 `explorer` 作为通用只读探索执行者。通用能力由 `spawn_agent` 继承当前会话工具、权限和资料上下文，并由 `$codex-explore` prompt 明确资料来源、只读边界和输出要求；不能把它描述成内置 `explorer` role 自带不受限制的网络/文档访问能力。
- `explorerModel` 和 `modelReasoningEffort` 继续保留，并进入 `$codex-explore` skill 的运行时提示词，作为 `spawn_agent(agent_type="explorer", model=..., reasoning_effort=...)` 的默认参数。
- `enableLightweightInstruction` 从新 schema 中移除。本轮按开发阶段约束处理，不承诺旧版 `codex-explore` 已安装配置的残留兼容，也不为旧 key 补专项回归；如果未来要支持真实旧安装，需要单独设计配置迁移或忽略合同。
- 默认触发策略改为自动，源码 `agents/openai.yaml` 默认 `policy.allow_implicit_invocation = true`。manifest 继续允许用户显式 `--skill-trigger manual|auto|default` 覆盖；当用户选择 manual 时，config refresh 不能把它重置回源码默认 auto。skill 的描述要足够明确，能匹配“代码库探索、跨模块分析、review 前调查、实现前摸清结构、网络/文档搜索、多源资料总结、长日志或大段上下文归纳”等场景，同时避免过度泛化到无需子代理的小任务。
- 保留 renderer 体系，但调整职责：不再渲染轻量 instruction 或专用 role；只通过受管 skill 产物声明 `$codex-explore` 的期望运行时内容。新 `codex.skill` 基线建立后的升级清理由 AW CLI 底座根据 tracking、artifact identity 和 ownership 统一完成，不能放进插件自己的 renderer 或 lifecycle 脚本。
- renderer 的 block trimming 必须修复为真正 dedent，不能再把 JS 模板缩进泄漏到生成内容里。
- `codex.skill` 采用“静态模板真值”模型：源码 `skills/codex-explore/` 和 runtime bundle `codex/skills/codex-explore/` 是 renderer、skill trigger 解析、authoring 校验和 smoke 测试的模板来源；安装后的运行时 skill 目录则由 `codex.skill` renderer 输出、当前配置和当前 `skillTriggerPreference` 共同决定。静态模板不能再作为同名 skill 的独立运行时写入来源。
- V1 继续覆盖 user scope 和 project scope。实现不能把 user scope 暂时降级为静态 skill 或只写 AW 源目录；user scope 必须满足“安装后 Codex runtime 可见，配置变更后 runtime 内容刷新”的验收条件。
- 本轮不承担旧基线已安装 `codex-explore` 自动迁到新 `codex.skill` 基线的兼容迁移。旧 static skill tracking、旧 `lightweight-instruction`、旧 `codex-explorer-role` 到新 dynamic skill identity 的一次性迁移如果将来要支持，需要单独设计迁移合同；这不影响新基线下后续插件升级的 stale prune / cleanup 合同。

## 实现前置条件

- 通用只读探索依赖两层 contract：内置 `explorer` role 承接只读探索子任务，`spawn_agent` runtime 让子代理继承当前会话可用工具、权限和资料上下文。实现开始前必须确认主 agent 可以把代码库、文档、网页、日志和用户材料等来源写进 explorer prompt，并在 prompt 中约束只读边界。
- 公开文案必须说明能力边界：`$codex-explore` 可以调度通用只读探索，但能否访问具体来源取决于当前会话工具、联网策略、权限、用户提供材料和上层安全要求；不能访问来源时要说明限制，不能凭记忆补事实。

## 实施里程碑

为避免把 CLI 底座改造、skill 行为和发布口径混在一起验收，本需求按两个里程碑推进：

1. 里程碑一：完成仓库内可独立落地的基础设施改造。范围包括新增 `codex.skill` target、协调静态 skill materialization、补齐 project / user scope 的 apply、refresh、status、repair、diagnose、uninstall 和新基线后续 upgrade stale prune 闭环，停止生成旧版轻量 instruction 与专用 role，修复 renderer dedent，并同步测试、作者工具和打包验证。
2. 里程碑二：完成 `$codex-explore` 通用只读探索的发布口径、skill 文案、触发描述和回归测试；文案必须覆盖代码库、文档、网络、日志和用户材料，同时保留当前会话工具/权限边界。

## 目标

1. 删除 `codex-explore` 的轻量 instruction 产品入口。
2. 删除 `codex-explore` 的专用 agent role 产品入口。
3. 保留并强化 `$codex-explore` skill，让它成为通用只读探索入口，并直接调 Codex 内置 `explorer` role。
4. 继续支持配置 `explorerModel` 和 `modelReasoningEffort`，配置变更后无需用户手动同步，已安装 skill 内容应自动刷新。
5. 确保新 `codex.skill` 基线建立后，后续插件升级移除、改名或替换 dynamic skill artifact 时，AW-owned stale dynamic skill 会被清理，非 AW-owned 同名 skill 不会被误删。
6. 修复 renderer 生成内容的缩进质量问题，并用测试锁住。
7. 同步更新插件作者工具、公开文档和 smoke 测试，避免继续把 `codex-explore` 当成动态 instruction + dynamic role 示例。

## 非目标

- 不改变 Codex 上游 `spawn_agent` 工具的全局授权规则。
- 不让 `$codex-explore` 或默认自动触发策略成为通用 `spawn_agent` 授权绕过机制。
- 不再维护 `enableLightweightInstruction`，也不为旧 config store 中可能残留的该 key 补兼容迁移或专项测试。
- 不引入代码索引服务、MCP server、hook 或 permission mode。
- 不让 explorer 修改代码或执行任何有副作用的外部动作；`codex-explore` 仍定位为只读探索和汇总。
- 不把 `codex-explore` 做成网络、文档、搜索引擎或代码索引的替代品；它只是调度和约束探索 workflow，具体检索仍要遵守当前会话可用工具、联网策略、官方文档优先级和上层安全要求。
- 不创建自定义 explorer role，也不覆盖 Codex 内置 `explorer` role。
- 不做旧基线到新 `codex.skill` 基线的一次性兼容迁移；也就是不要求本轮自动把旧 static skill tracking、旧 `lightweight-instruction`、旧 `codex-explorer-role` 升格或清理为新 dynamic skill identity。

## 插件形态

重设计后的源码结构建议为：

```text
plugins/codex-explore/
├── .agents-plugin/plugin.json
├── scripts/render-artifacts.mjs
├── scripts/render-artifacts.test.mjs
└── skills/codex-explore/
    ├── SKILL.md
    └── agents/openai.yaml
```

需要移除：

- `plugins/codex-explore/instructions/lightweight.md`
- `plugins/codex-explore/roles/codex-explorer.md`
- runtime bundle 中的 `codex/instructions/**`
- runtime bundle 中的 `codex/roles/**`

manifest 保留：

- `marketplace.policy.products = ["CODEX"]`
- `skills = "./skills"`，但它只声明动态 skill 的源码模板和 trigger policy 来源，不再表示同名 skill 要走静态 materialization 写入运行时目录。
- `skillTriggers.codex-explore.allowInstallOverride = true`
- `config.schema.explorerModel`
- `config.schema.modelReasoningEffort`
- `scripts.artifacts.render`

manifest 新增或调整：

- `artifacts.targets[].id = "codex-explore-skill"`
- `artifacts.targets[].target = "codex.skill"` 或实现阶段确定的等价受管 skill target
- `artifacts.targets[].skillKey = "codex-explore"` 或实现阶段确定的等价静态 skill identity 字段
- `artifacts.targets[].projectManagedKind = "skill"`
- `artifacts.targets[].refreshKeys = ["explorerModel", "modelReasoningEffort"]`

manifest 移除：

- `config.schema.enableLightweightInstruction`
- `artifacts.targets[].id = "lightweight-instruction"`
- `artifacts.targets[].id = "codex-explorer-role"`
- `codex.agentRole` 相关 `roleKey = "codex-explorer"`

## Dynamic Skill Artifact

因为 `explorerModel` 和 `modelReasoningEffort` 仍需要进入 Codex skill 运行时文件，静态 `SKILL.md` 不能独立满足需求。本需求要求新增或复用一个受管 Codex skill artifact 目标，用 renderer 生成 `$codex-explore` 的实际运行时内容。

### 真值模型

本设计选择保留静态 `skills/` 作为模板真值，而不是把所有 skill 元数据都迁入 renderer plan。`codex.skill` 表达的是“用这个模板和当前配置生成运行时 skill，并由 AW 受管写入”，不是第二套同名 skill 真值。

| 维度 | 约定 |
| --- | --- |
| Source template | `plugins/codex-explore/skills/codex-explore/`，build 后对应 `codex/skills/codex-explore/`。它提供 frontmatter、`agents/openai.yaml` schema、默认 trigger policy、authoring 校验和 smoke 测试样本。 |
| Render input | renderer 读取模板、当前 config、scope、event 和历史 tracking，只能输出 manifest 已声明的 `skillKey = "codex-explore"`。 |
| Runtime target | project scope 写 `.agents/skills/codex-explore`；user scope 写 Codex native / AW runtime 实际读取的受管 skill 位置。两者都必须由 `codex.skill` apply 路径写入。 |
| Trigger patch | renderer 输出落盘前或落盘阶段必须应用当前 `skillTriggerPreference`，`manual` / `auto` / `default` 语义与静态 skill 完全一致。 |
| Status expected content | `renderer 输出 + 当前 render config + 当前 skillTriggerPreference patch`。不能再把 embedded pristine skill 原文当作动态 skill 的期望运行时内容。 |
| Repair source | repair 必须重新渲染并重新应用 trigger patch，再按 dynamic artifact ownership 写回；不能从 bundle 直接复制同名静态 skill 覆盖运行时目录。 |
| Rollback / prune owner | 以 `id + target + skillKey + artifactKey` 记录 artifact identity，并结合 install record / project artifact identity / managed marker 判断归属。不能对同名 skill 做 path-only 删除或 path-only 覆盖。 |

因此，任何声明了 `codex.skill` 的 `skillKey` 都要从现有静态 skill materialization 的直接写入集合中排除，或把现有 skill trigger materialization 改造成 `codex.skill` apply 路径内部的一步。安装阶段不能先用静态管线写 `.agents/skills/codex-explore`，再让 dynamic artifact 写同一路径；status、repair、upgrade stale prune 也不能再把静态 bundle skill 当成该 runtime 目录的 pristine truth。

建议 target 名称为 `codex.skill`，字段名可以在实现时微调，但必须表达下面这些语义：

- artifact 身份稳定，例如 `id = "codex-explore-skill"`。
- manifest 必须静态声明 skill identity，例如 `skillKey = "codex-explore"`；renderer plan 里的 `skillKey` 必须完全匹配，不能通过 renderer 任意声明 skill 名或落盘路径。
- target 管理一个 Codex skill 目录，至少包含 `SKILL.md` 和 `agents/openai.yaml`。
- project scope 下 `projectManagedKind` 映射为 `skill`。
- `refreshKeys` 包含 `explorerModel` 和 `modelReasoningEffort`。
- renderer 只能返回当前 manifest 声明过的 skill artifact，不能任意声明落盘路径。
- AW 负责写盘、rollback、install record、status、uninstall 和 config-triggered refresh。
- renderer 不能直接改 `.agents/skills/**`、`~/.aw` runtime bundle 或 Codex config。
- skill trigger 覆盖仍由现有 skill trigger 机制处理。config refresh 重写 skill 文件时，必须保留当前 install record 中的 `skillTriggerPreference`，不能把用户显式设置的 `manual` 或 `auto` 重置成源码默认。
- user scope 和 project scope 都应走同一个动态 artifact contract。project scope 写 repo-visible `.agents/skills/<skillKey>`；user scope 写 Codex native / AW runtime 使用的受管 skill 位置，并继续纳入原有 native install、rollback 和 materialization 流程。

需要补齐的 AW CLI 底座能力：

- 类型与 schema：扩展 `ArtifactTarget`、`DynamicArtifactKind`、`ArtifactPlanArtifact`、manifest normalizer、artifact plan validator、generated artifact schema、install-state schema 和 diagnostic cache，使其识别 `codex.skill`。
- 动态 skill 写入：新增 `codex.skill` 的 apply 路径，按 `skillKey` 写入完整 skill 目录，生成带 `kind = "skill"`、`artifactKey = skillKey`、`id`、`target`、`state`、`refreshKeys`、`configDigest`、`contentDigest` 的 tracking / install record artifact。
- 静态 materialization 协调：安装、升级、repair 和 refresh 计算 skill 写入集合时，必须识别 manifest 中的 dynamic skill `skillKey`。这些 key 不能再由静态 `materializeSkillTriggerPreference()` 独立写入同一路径；如果复用该函数，只能把它作为 dynamic skill staging 内容的 trigger patch 步骤。
- 安全校验：安装前复用现有 repo artifact / native runtime 冲突检查，拒绝覆盖同名但无 AW ownership 证明的 skill；stale 或 orphan 只在 tracking、project artifact identity 或其它可信证据能证明归属时处理。
- user scope 可见性：动态 skill 渲染结果必须进入 Codex native install 实际读取的 skill 树。安装和升级时，顺序必须是：校验 shared runtime owner 和冲突证据，捕获 rollback baseline，渲染 dynamic skill 到 staging，应用当前 `skillTriggerPreference`，提交 AW-managed runtime skill，再执行 Codex native install 或刷新 native materialized cache。不能先执行 native install，再把 dynamic skill 只写到 AW 源目录或 tracking。
- refresh：`aw config set/unset/reset` 和“重新应用配置”必须把 `codex.skill` 当作动态 artifact 刷新，触发条件仍来自 `refreshKeys`，失败时写入 dynamic diagnostic cache，成功后更新 install record 和 project artifact identity。
- user scope refresh：配置触发刷新时必须重新渲染 user runtime skill、保留当前 trigger preference、更新 Codex native/runtime 可见内容，并在失败时回滚本次写入或留下可诊断的 refresh failure。refresh 不应重放 lifecycle，也不应重新创建已移除的旧 instruction / role。
- skill trigger：动态 skill 内容落盘后仍要应用当前 `skillTriggerPreference`。`manual` / `auto` / `default` 的覆盖语义必须和静态 skill 一致，config refresh 不得重置用户安装时的选择。
- status / diagnose / repair / uninstall：把 `codex.skill` 纳入 managed artifact、repo-managed project item、drift、recent refresh failed、missing、uninstall 和 repair 报告；新基线下的 historical tracking、stale dynamic skill 和当前 skill target 要能被稳定解释。若遇到旧基线 instruction / role tracking，应按本轮非目标边界给出明确诊断，而不是隐式迁移。drift 和 repair 的 expected tree 必须来自“renderer 输出 + 当前 render config + 当前 `skillTriggerPreference` patch”，不能沿用 embedded pristine skill 比较链。

### User Scope 时序

V1 不把 user scope 延后，也不把 user scope 降级为静态 skill。user scope 的动态 skill 要按下面的顺序闭环：

1. 安装 / 升级：读取当前配置和 install record，确认 shared runtime owner 允许当前插件改写本地 runtime，检查同名非 AW-owned skill 冲突，并捕获本地 runtime、Codex native materialized cache 和相关 tracking 的 rollback baseline。
2. 渲染与触发策略：renderer 根据静态模板和当前配置生成 skill staging tree，然后应用当前 `skillTriggerPreference`。如果用户安装时选了 `manual`，staging 中的 `agents/openai.yaml` 必须关闭自动触发；如果选了 `auto` 或 `default`，则按对应语义保持自动触发。
3. 提交 runtime：把 staging tree 作为 AW-managed runtime skill 提交到 Codex user runtime 实际读取的位置，并写入带 `id`、`target`、`skillKey`、`artifactKey`、`contentDigest` 和 `configDigest` 的 tracking / install record。
4. Native 可见性：提交 runtime 后执行 Codex native install，或刷新 native materialized cache，确保新会话能读到刚渲染的 skill 内容。不能出现 native install 已完成、dynamic skill 还停留在 AW 源目录或 staging 的状态。
5. 配置刷新：`aw config set/unset/reset` 命中 `refreshKeys` 时，只重跑 dynamic skill renderer 和 trigger patch，再更新 user runtime 与 native materialized cache；不重放 lifecycle，不恢复旧 instruction / role，不重置用户选择过的 trigger preference。
6. 失败处理：任何一步失败都必须回滚本次写入，或写入可被 `status` / `diagnose` 解释的 refresh failure。不能留下 Codex native cache、AW runtime 和 install record 三者互相不一致的成功状态。

建议 artifact plan 形态：

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "codex-explore-skill",
      "kind": "codexSkill",
      "platform": "codex",
      "target": "codex.skill",
      "state": "present",
      "skillKey": "codex-explore",
      "refreshKeys": ["explorerModel", "modelReasoningEffort"],
      "content": {
        "skillFile": "... rendered SKILL.md ...",
        "openaiYaml": "... rendered agents/openai.yaml ..."
      }
    }
  ]
}
```

## Skill 行为

`$codex-explore` 被触发后，主 agent 应把它视为用户选择了一个通用只读探索 workflow。除非任务明显很小，或当前全局规则不允许启动子代理，主 agent 应优先考虑启动内置 `explorer` 来读取材料、搜索证据、核对假设并归纳结论。

适用范围包括但不限于：

- 代码库探索：跨模块结构、既有模式、影响面、review 前调查、实现前摸清边界。
- 文档探索：项目文档、架构说明、测试说明、迁移记录、官方技术文档和版本差异记录。
- 网络资料探索：公开网页、官方文档、时间敏感资料和多源事实核对。
- 大上下文探索：测试输出、长日志片段、PR diff、issue 记录、需求文档、会议记录或用户提供的数据集合。
- 多源证据核对：需要把代码、文档、网页、错误信息、日志和用户材料放在一起比对的任务。

`explorer` 子代理继承当前会话可用的工具、权限和资料上下文。涉及网络、官方文档、时间敏感事实或用户材料时，prompt 必须写清资料来源和访问边界；不能访问来源时要说明限制，不能凭记忆补事实。

不适合委派的情况包括：单个事实查询、已知文件内的小搜索、2 到 3 个文件内能快速完成的定位、主 agent 下一步立刻依赖的阻塞决策、实现/修改/格式化/提交任务，以及任何需要授权、登录、购买、发布、发送消息或写入外部系统的动作。

默认调用参数来自插件配置：

```ts
spawn_agent({
  agent_type: "explorer",
  model: "<explorerModel>",
  reasoning_effort: "<modelReasoningEffort>",
  message: "..."
})
```

skill 内容要求：

- 不再提 `codex-explorer`。
- 明确使用内置 `explorer`。
- 用触发条件和适用范围表达通用只读探索定位，避免在正文里反复解释产品定位。
- 明确探索是只读任务，不允许创建、编辑、移动、删除、格式化或回退文件，不允许安装依赖、请求提权、登录账号、购买、发布、发送消息或调用有副作用的外部接口。
- 明确网页、外部官方文档、时间敏感事实和用户材料只能在当前会话工具、权限、联网策略和上层安全要求允许时使用；不能访问来源时要说明限制，不能凭记忆补事实。
- 默认启动 1 个 explorer；只有多个探索问题互不重叠、彼此能独立完成且确实值得拆分时，才启动 2 到 3 个；极少数复杂场景最多 4 个。
- 每个 explorer prompt 必须包含范围、资料来源、具体问题、探索深度、只读边界和期望输出。
- 探索深度只使用 `quick`、`medium`、`very thorough`。
- explorer 运行时，主 agent 不要重复调查同一个问题；如果有不依赖 explorer 结果的其它工作，可以先处理，否则直接等待结果。
- 已经启动 explorer 后，主 agent 必须等待并读取结果；`wait_agent` 的等待时间要结合任务规模、资料量和探索深度设置，避免过短 timeout 导致频繁轮询空转；不能因为暂时没返回就关闭 explorer 并自己重复完成同一个问题。
- 整合结果时只保留关键结论、证据路径、必要行号和不确定点。
- 整合后立即 `close_agent`。
- 如果配置的 `explorerModel` 不可用，主 agent 要说明当前配置不可用，再按用户最新指示处理；不要静默换模型。

`agents/openai.yaml` 要求：

- `interface.short_description` 要比当前描述更直接，说明这是代码库、文档、网络和大上下文的只读探索与多源证据总结能力。
- `interface.default_prompt` 要明确使用 `$codex-explore` 做通用只读探索，并允许代码库、文档、网络资料和用户提供的数据作为来源。
- 源码默认 `policy.allow_implicit_invocation = true`。
- 安装时用户选择 `--skill-trigger manual` 后，生成的 runtime `openai.yaml` 应关闭自动触发，且 config refresh 不得覆盖这个选择；用户选择 `auto` 或 `default` 时，应保持自动触发。

触发策略真值表：

| 安装偏好 | runtime `policy.allow_implicit_invocation` | 说明 |
| --- | --- | --- |
| `default` | `true` | 使用源码 `agents/openai.yaml` 默认值。本设计的源码默认就是自动触发。 |
| `auto` | `true` | 显式覆盖为自动触发；config refresh 必须保留这个覆盖。 |
| `manual` | `false` | 显式覆盖为手动触发；config refresh 必须保留这个覆盖，不能恢复源码默认值。 |

## Skill 提示词草案

实现时生成的 `SKILL.md` 应接近下面这版。允许为了 frontmatter schema、缩进或配置插值做小幅调整，但不能删掉通用只读范围、当前会话工具/权限边界、只读边界、并发限制、等待与关闭要求。

````markdown
---
name: codex-explore
description: 通用只读探索 workflow：当任务需要跨代码库、文档、网页、日志或用户材料做证据搜索、假设核对和多源总结时触发；小范围定位和单个事实查询不要触发。
user-invocable: true
metadata:
  short-description: 通用只读探索 workflow
---

# Codex Explore

只有任务需要读取大量材料、跨来源搜索、核对假设或压缩总结时，才按这里的流程委派 Codex 内置 `explorer`。这个 workflow 覆盖代码库、文档、网络、长日志和用户提供的材料；资料来源可以是项目文档、官方技术文档、公开网页、测试输出、PR diff、issue、需求材料、会议记录，或用户提供的数据和文本集合。

## 何时使用

先判断是否真的需要 explorer。单个事实查询、已知文件内的小搜索，或 2 到 3 个文件内能快速完成的定位，优先由主 agent 自己完成。

适合委派的情况包括：问题边界不清、涉及多个模块或多个来源、需要比较既有实现或外部资料、需要独立核对假设、需要总结大量上下文，或探索工作可以和主 agent 当前必须亲自处理的任务清楚分离。

不要把实现、修改、格式化、提交、需要授权的动作，或主 agent 下一步必须立即依赖的阻塞决策交给 explorer。

## 委派前判断

先快速拆分任务，区分主 agent 现在必须亲自处理的工作，以及可以独立交给 explorer 的探索工作。只把具体、边界清楚、可以独立产出结论的只读探索交给 explorer。

如果任务涉及网络、文档或时间敏感事实，必须遵守当前会话工具可用性、联网要求、官方文档优先和上层安全策略。`explorer` 子代理继承当前会话可用的工具和权限；不能访问来源时要在结果里说明限制，不能凭记忆补事实。

## 委派规则

主 agent 使用 `spawn_agent`，并把 `agent_type` 设为 `"explorer"`。默认参数来自插件配置：

```ts
spawn_agent({
  agent_type: "explorer",
  model: "<explorerModel>",
  reasoning_effort: "<modelReasoningEffort>",
  message: "..."
})
```

如果用户显式指定其它模型，或 Codex runtime 报告 `<explorerModel>` 不可用，先向用户说明当前 workflow 默认模型不可用或已被用户指令覆盖，再按用户最新指示处理。不要静默换模型。

除非用户另有要求，默认启动 1 个 explorer。只有多个探索问题互不重叠、彼此能独立完成且确实值得拆分时，才启动 2 到 3 个；极少数复杂场景最多 4 个。

每个 explorer 的 prompt 必须包含：

- 范围：限定目录、文件、模块、网页、文档集、日志片段、数据范围或行为边界。
- 资料来源：说明应该看代码库、用户提供内容、官方文档、公开网页、命令输出，还是这些来源的组合。
- 具体问题：说明要回答什么，不要只写“看看这个模块”或“查一下资料”。
- 探索深度：只能使用 `quick`、`medium`、`very thorough`。
- 输出格式：要求返回关键结论、证据路径、必要行号、不确定点，以及建议主 agent 下一步查看的内容。
- 只读要求：明确不得创建、编辑、移动、删除、格式化或回退文件，不得安装依赖，不得请求提权，不得登录账号、购买、发布、发送消息，或调用任何有副作用的外部接口。

## 等待与整合

explorer 运行时，主 agent 不要重复调查同一个问题。如果有不依赖 explorer 结果的其它工作，可以先处理；如果没有，就直接等待结果。已经启动 explorer 后，必须等待它进入最终状态并读取结果；不要因为等待一段时间没有返回，就关闭 explorer 并自己重复完成同一个探索问题。

调用 `wait_agent` 前，先按任务规模、资料量、探索深度和 explorer 数量评估合理 timeout。避免设置过短 timeout 反复轮询；`quick` 可以短等，`medium` 和 `very thorough` 应给更长等待窗口，通常按分钟级等待更合适。

整合结果时，只保留关键结论、证据路径、必要行号和不确定点。必要时补读少量材料验证，不要把完整子代理回复倾倒给用户。

读取并整合结果后，立即用 `close_agent` 关闭本 workflow 启动的 explorer。`wait_agent` 只代表等待结果，不等于关闭 agent。
````

`agents/openai.yaml` 源码默认内容建议为：

```yaml
interface:
  display_name: "Codex Explore"
  short_description: "代码库、文档、网络和大上下文的只读探索与多源证据总结"
  default_prompt: "使用 $codex-explore 对这个问题做只读探索，搜索并总结相关代码、文档、网络资料或用户提供的数据。"

policy:
  allow_implicit_invocation: true
```

## Renderer 质量修复

`render-artifacts.mjs` 必须修复 `trimBlock()`：

- 对模板字符串先去掉首尾空白，再按非空行计算公共缩进并 dedent。
- 空行保留为空行，不参与公共缩进计算。
- 不应删除用户有意写入的相对缩进，例如列表下的代码块或嵌套列表。
- 所有由 renderer 生成的 Markdown/TOML 正文都必须经过同一套规范化逻辑。
- 单元测试要覆盖多行中文、Markdown 列表、嵌套缩进和空行。
- 回归断言：生成的 `SKILL.md` 正文不能因为 JS 模板缩进而出现整段 4 空格前缀。

## 升级与清理

升级与清理必须由 AW CLI 底座完成。`codex-explore` renderer 只描述当前版本期望存在的 `codex.skill` artifact；新 `codex.skill` 基线建立后的旧 dynamic skill 是否该删、如何回滚、如何避免误删，都由底座根据 tracking、当前 manifest、renderer plan 和 ownership evidence 决定。

本轮不要求把旧基线已安装的 `codex-explore` 自动迁到新 `codex.skill` 基线。也就是说，不要求自动把旧 static skill tracking、旧 `lightweight-instruction`、旧 `[agents.codex-explorer]` 注册项或旧 role 文件升格/清理为新 dynamic skill identity。若后续要支持这条真实旧安装迁移路径，需要单独设计迁移合同，并在“原地升格旧 artifact identity”和“同路径同 `artifactKey` preserve”这类策略之间做明确选择。

新 `codex.skill` 基线下，后续插件升级必须清理旧受管 dynamic skill 产物：

- 当前版本不再声明某个 AW-owned `codex.skill` artifact 时，upgrade stale prune 删除对应 runtime skill、tracking / project identity 和 diagnostic cache。
- 当前版本用新的 `id + target + artifactKey` 替换旧 dynamic skill artifact 时，旧 artifact 只能在 ownership 可信时删除，不能 path-only 删除。
- 同名非 AW-owned skill 必须保留，并给出可诊断信息。
- 如果已打开的 Codex 会话仍带有旧上下文，文档和 receipt 可以提示用户开启新会话；本轮不尝试修改当前会话上下文。

需要补齐的 AW CLI 底座能力：

- stale prune 不能只覆盖 `Codex + project scope + upgrade`。`Codex + user scope + upgrade` 也要按新基线 tracking 和新产物集合计算 stale dynamic skill artifacts，并复用 ownership-aware 删除逻辑。
- user scope stale prune 需要有和 project scope 同等级的回滚保护。只要升级过程中会改写用户级 Codex config、受管 skill 目录或 native materialized cache，就必须先捕获 rollback baseline；中断或失败时恢复到升级前状态。
- stale prune 只能删除 AW-owned dynamic skill artifact。遇到同名 skill 但 tracking / managed marker / project identity 不能证明归属时，必须拒绝或保留，并给出可诊断信息。
- `diffGeneratedArtifacts(previousTrackedArtifacts, desiredTrackedArtifacts)` 这类身份比较要支持动态 skill artifact，skill 类 artifact 必须带 `artifactKey`，不能退化成 path-only 删除。
- `cleanup`、`repair`、`uninstall` 和 `status/diagnose` 对 historical tracking 的解释要兼容“当前 dynamic skill 已被后续 manifest 移除、替换或残留”的状态，不把同名 skill 修回或清回静态 materialization。

配置 schema 清理：

- 新 schema 只保留 `explorerModel` 和 `modelReasoningEffort`。
- `aw config list/get` 只展示新 schema 下的 `explorerModel` 和 `modelReasoningEffort`。
- 本轮不处理旧 config store 中残留的 `enableLightweightInstruction`。当前处于开发阶段，按不存在旧版 `codex-explore` 已安装配置处理；如果未来需要兼容真实旧安装，需要另开迁移设计，并补对应回归。

## 文档与作者工具

本需求会改变插件能力示例和动态 artifact 形态，因此需要同步检查并更新：

- `docs/plugin-authoring.md`
- `docs/plugin-installation.md`
- `docs/architecture.md`
- `docs/coding-conventions.md`
- `.agents/skills/create-agent-workflows-plugin/`
- 相关 authoring references 和 example fixtures

如果新增 `codex.skill` 这类动态 target，作者工具必须补充 manifest 校验、示例和测试，避免插件作者继续把配置驱动 skill 写成 lifecycle 直接改文件。

## 测试要求

插件级测试：

- renderer 使用默认配置时生成 `codex-explore-skill` artifact。
- renderer 使用自定义 `explorerModel` 和 `modelReasoningEffort` 时，生成的 `SKILL.md` 包含对应 spawn 参数。
- renderer 不再生成 `lightweight-instruction`。
- renderer 不再生成 `codex-explorer-role`。
- renderer 输出内容没有模板缩进泄漏。
- `SKILL.md` 不包含 `codex-explorer`。
- `SKILL.md` 通过触发条件和资料来源覆盖通用只读探索范围，并明确当前会话工具、权限、联网策略和用户材料边界。
- `SKILL.md` 覆盖代码库、文档、网络、长日志、PR diff、issue 记录和用户材料等资料来源，并写清无法访问来源时必须说明限制、不能凭记忆补事实。
- `openai.yaml` 默认 `allow_implicit_invocation: true`。
- `openai.yaml` 的 `short_description` 和 `default_prompt` 应定位为代码库、文档、网络和大上下文的只读探索与多源证据总结。
- manifest 仍允许 `skillTriggers.codex-explore.allowInstallOverride = true`。

CLI 单元和集成测试：

- manifest 和 artifact plan validator 接受声明过的 `codex.skill`，并拒绝未声明 target、未声明 `skillKey`、`skillKey` 不匹配或试图携带任意落盘路径的 renderer 输出。
- 声明为 `codex.skill` 的 `skillKey` 不会再被静态 skill materialization 独立写入同一路径；安装结果只记录一个带 `id`、`target = "codex.skill"` 和 `artifactKey = "codex-explore"` 的受管 skill artifact。
- Codex project scope 安装后只产生 skill artifact，不改 `.codex/config.toml` 的 `developer_instructions`，不写 `[agents.codex-explorer]`。
- Codex user scope 安装后 native/runtime skill 可用，且 skill 内容带有当前配置值。
- Codex user scope 安装顺序覆盖回归：dynamic skill 渲染和 trigger patch 先进入 AW-managed runtime，再执行 native install 或 native cache refresh；不能出现 native install 读到旧静态 skill 的状态。
- 默认安装后的 runtime `openai.yaml` 允许自动触发；使用 `--skill-trigger manual` 安装时，runtime `openai.yaml` 关闭自动触发。
- `aw config set codex-explore explorerModel ...` 后，已安装 skill 自动刷新，Codex user scope 的 runtime 也能读到新内容，旧 instruction/role 不会重新出现。
- config refresh 保留用户安装时选择的 `--skill-trigger auto|manual|default`。
- status、repair 和 `diagnose --deep` 对动态 skill 的 drift 判断使用 renderer 输出、当前配置和当前 trigger patch 计算 expected tree；修改 `explorerModel` 后不能继续拿 embedded pristine skill 做比较，也不能把 repair 回写成静态模板内容。
- 新 `codex.skill` 基线安装后，升级到“移除或替换 dynamic skill artifact”的新 manifest 时，project scope 和 user scope 的 AW-owned 旧 dynamic skill 都被清理。
- 遇到同名用户自定义 skill 时，清理逻辑不会误删非 AW-owned 文件。
- 升级清理由底座 stale prune 完成，`codex-explore` 的 renderer / lifecycle 不执行任何直接文件清理脚本。

Smoke / pack 测试：

- runtime bundle 包含 `codex/skills/codex-explore/SKILL.md` 和 `agents/openai.yaml`。
- runtime bundle 不包含 `codex/instructions/lightweight.md`。
- runtime bundle 不包含 `codex/roles/codex-explorer.md`。
- marketplace / platform manifest 不再把 `codex-explore` 报告为 instruction + agent 插件。
- tarball 内容验证同步更新。

## 验收标准

- 新会话里安装 `codex-explore` 不再自动注入轻量探索 instruction。
- `$codex-explore` skill 发布态定位为通用只读探索，覆盖代码库、文档、网络资料、测试输出、长日志、PR diff、issue 记录、用户材料和多源证据核对等场景。
- `$codex-explore` 默认允许自动触发，但触发后仍要先判断任务规模和委派价值，不应为小搜索或单个事实查询启动 explorer。
- `$codex-explore` skill 使用内置 `explorer`，并按配置传入 `model` 和 `reasoning_effort`；具体可访问来源受当前会话工具、权限、联网策略和用户提供材料限制。
- `codex.skill` 的运行时内容来自静态模板、当前配置和当前 trigger preference 的动态渲染结果；同名静态 skill 不会再通过独立 materialization 写入同一路径。
- `codex-explorer` 专用 role 不再出现在新安装的 Codex config 或 role 文件中。
- 新 `codex.skill` 基线下，后续插件升级能按 ownership 清理 AW-owned stale dynamic skill，且不会误删非 AW-owned 同名 skill。
- 修改 `explorerModel` 或 `modelReasoningEffort` 后，project scope 和 user scope 的已安装 skill 内容都会自动刷新，Codex native/runtime 读取到新内容。
- status、repair 和 diagnose 对动态 skill 的 drift 判断与修复使用渲染后的 expected tree，不会把动态 skill 误修回 embedded pristine 模板。
- renderer 生成内容没有多余模板缩进。
- 文档、作者工具、测试和打包产物都不再把旧的轻量 instruction + 专用 role 设计当成当前推荐形态。
