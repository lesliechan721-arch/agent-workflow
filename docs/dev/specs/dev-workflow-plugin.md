# 开发工作流插件 Spec

> 状态：关键产品决策已确认，基线评估已按 2026-04-30 当前仓库能力更新，可进入执行计划。
> 已确认：插件名 `dev-workflow`；首版只使用 source skills 作为入口；文档按单 workflow 目录归档；默认手动触发；首版声明并行实现所需子代理。

## 背景

需要设计一套开发需求文档管理系统，通过 agent-workflows 插件的 skill 组合完成从需求探索到实现、审查、修复和历史追踪的完整开发流程。用户明确要求：

- 需求 spec：探索技术方案，确定需求边界。
- 执行计划：基于需求 spec 设计执行计划。
- 计划拆分：把计划拆成分阶段 TODO，并明确阶段依赖关系。
- 计划实现：按阶段实现需求，可设计子代理并行策略。
- review：需求、计划和实现都支持 review，并输出 review 报告。
- review 修复：基于 review 报告修复，并记录修复与报告历史。
- 需要状态管理和历史文档管理。
- 工作通过插件 skill 实现，并设计合适的子代理。
- 设计可参考 `obra/superpowers`，但不能照搬。
- 有产品决策或疑问时，需要先向用户确认。

本文档记录已确认的首版设计。执行计划阶段再细化具体文件内容、agent prompt、模板和测试。

## 调研结论

### 当前 agent-workflows 插件能力边界

本轮基线以当前仓库的 source manifest、作者文档和构建代码为准。插件 source manifest 目前接受这些顶层字段：`name`、`version`、`description`、`skills`、`slashCommands`、`skillTriggers`、`mcpServers`、`apps`、`marketplace`、`interface`、`extensions`、`buildConfig`、`scripts`、`config`。未知字段仍会被 source manifest 校验拒绝，因此首版不能直接在 manifest 里新增 `state`、`documents`、`workflows` 这类产品字段。

可直接使用的能力：

- `skills`：最适合作为工作流入口。一个插件可以包含多个 skill，每个 skill 有自己的 `SKILL.md` 和 Codex `agents/openai.yaml`。
- `skillTriggers`：只表示安装时是否允许用户覆盖触发策略，不定义 skill 默认触发方式。默认触发仍由 `SKILL.md` 和 `agents/openai.yaml` 决定。
- `slashCommands`：已有跨平台公共入口。Claude 生成原生 slash command，Codex 生成 manual-only skill；命令名不能和 source skill 同名。用户已确认首版不额外加入这层入口。
- `extensions.agents`：可声明静态子 agent 角色。构建时 Claude 生成 agent Markdown，Codex 生成 role TOML。它能提供专门角色，但不会自动编排任务。
- `extensions.instructions`：可向项目注入规则。适合轻量提醒，不适合强行接管所有开发请求。
- `extensions.hooks` / `extensions.nativeHooks`：可在平台事件上执行命令，但当前更适合低级生命周期事件，不适合承载需求文档状态机。
- `mcpServers`：可以接入一个本地或远程 MCP 服务，提供更强的状态查询、索引和文档校验工具。
- `apps`：Codex connector 绑定能力，不适合作为本需求的核心。
- `buildConfig.templates`：可按 Claude/Codex 渲染 skill 和 reference 文档。
- `scripts` / `config`：已有 AW 自管插件配置、安装/升级/卸载 lifecycle、Node build 和插件脚本测试能力。它们适合插件级配置和安装期行为，不适合直接承载每个开发 workflow 的业务状态。
- Codex project scope 已支持 repo-managed artifacts 和 tracking；skills、MCP、instructions、permissions、hooks、agents 等项目侧产物可以由 AW 追踪安装和卸载。

当前仍不具备或不适合作为首版核心前提的能力：

- 没有插件级持久状态数据库。
- 没有内置 workflow 状态机、阶段事务和文档迁移引擎。
- AW config 是插件配置，不是 per-workflow 实例状态；不适合存放 spec、plan、review 历史。
- lifecycle 脚本只覆盖安装、升级、卸载，不适合在用户每次推进需求时自动改写 workflow 文档。
- 公共 `slashCommands` 适合手动命令入口，但首版已确认只用 source skills，避免和同名 skills 形成重复入口或 Codex generated skill 冲突。
- 没有自动“启动后强制加载整套方法论”的公共能力。
- 没有内置文档索引、锁、事务或并发写保护。

因此首版状态管理仍应设计成“仓库内受约束的 Markdown 文档 + JSON 状态索引”，由 skill 按规则读写。MCP、lifecycle 或 config helper 可以作为后续增强，而不是首版前提。

### 从 superpowers 借鉴的点

`superpowers` 的核心价值不是某个单独工具，而是一组严格串联的 agentic development skill：

- 先做 brainstorming/spec，明确边界后再进入计划。
- spec 和 plan 都要落成文档。
- implementation plan 要足够具体，可以交给低上下文执行者完成。
- 子代理实现后要有 review gate，先查是否符合 spec，再查代码质量。
- review 修复要先验证反馈是否成立，不能盲目照单全收。

本插件可以借鉴这些方法论，但需要适配 AW 的双平台 source contract：

- 文档目录统一放在 `docs/dev/workflows/<workflow-id>/`，而不是 `docs/superpowers/*`。
- 不依赖 Claude-only command、command output fill 或公共 `slashCommands` 作为核心入口。
- 不要求自动触发所有开发请求，避免插件过度侵入用户现有流程。
- 子 agent 作为可调用角色和并行执行策略。是否并行由依赖图、写入范围和用户确认共同决定。

参考来源：

- `https://github.com/obra/superpowers`
- `https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md`
- `https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md`
- `https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md`
- `https://github.com/obra/superpowers/blob/main/skills/requesting-code-review/SKILL.md`
- `https://github.com/obra/superpowers/blob/main/skills/receiving-code-review/SKILL.md`

## 设计目标

首版插件应该做到：

- 用一组明确的 skill 覆盖需求、计划、拆分、实现、review、修复和状态查询。
- 每个 workflow 有稳定 ID、当前状态、文档索引、历史记录和 review/repair 关联关系。
- spec、plan、todo、review、repair 都是可审查、可版本化的 Markdown 文档。
- 一个 workflow 的所有文档都归档在同一个目录内，便于迁移、压缩上下文和追踪历史。
- JSON 状态文件只做索引和状态机，不承载长正文。
- 每个阶段都有进入条件和退出条件，避免绕过用户确认直接实现。
- review 报告可以指向 spec、plan、todo 或实现 diff，并能被修复流程消费。
- 修复流程保留历史，不覆盖旧 review，不让 issue 失去来源。
- 子代理策略可被计划实现 skill 使用，但执行前要明确依赖、写入范围和是否可并行。

## 非目标

首版不做这些事：

- 不新增 CLI 命令或修改 `aw` runtime。
- 不引入插件级数据库。
- 不强制所有开发请求都自动进入该工作流。
- 首版不提供公共 `slashCommands` 别名；后续如需要，可新增不与 source skill 冲突的 `wf-*` 命令入口。
- 不把 AW config 当作 workflow 状态存储。
- 不用 lifecycle 脚本初始化、迁移或自动改写 workflow 文档。
- 不用 hook 自动改写文档状态，避免隐式副作用。
- 不实现跨 agent 文件锁。并行写入只能通过计划拆分和 disjoint write set 约束降低风险。
- 不自动提交 git commit，除非用户明确要求或后续单独设计。

## 推荐插件形态

首版插件名确定为 `dev-workflow`。入口只使用 source skills，不额外添加公共 `slashCommands`。

```text
plugins/dev-workflow/
├── .agents-plugin/plugin.json
└── skills/
    ├── workflow-spec/
    │   ├── SKILL.md
    │   ├── agents/openai.yaml
    │   └── references/
    │       ├── spec-template.md
    │       └── spec-review-rubric.md
    ├── workflow-plan/
    │   ├── SKILL.md
    │   ├── agents/openai.yaml
    │   └── references/
    │       └── plan-template.md
    ├── workflow-split/
    │   ├── SKILL.md
    │   ├── agents/openai.yaml
    │   └── references/
    │       └── todo-template.md
    ├── workflow-implement/
    │   ├── SKILL.md
    │   ├── agents/openai.yaml
    │   └── references/
    │       ├── execution-strategy.md
    │       └── subagent-prompts.md
    ├── workflow-review/
    │   ├── SKILL.md
    │   ├── agents/openai.yaml
    │   └── references/
    │       ├── spec-review.md
    │       ├── plan-review.md
    │       └── implementation-review.md
    ├── workflow-repair/
    │   ├── SKILL.md
    │   ├── agents/openai.yaml
    │   └── references/
    │       └── repair-template.md
    └── workflow-status/
        ├── SKILL.md
        ├── agents/openai.yaml
        └── references/
            └── state-schema.md
```

第七个 `workflow-status` 作为首版能力保留。它不在用户原始功能列表中，但对“状态管理、历史文档管理”很有帮助：用户可以让 agent 汇总当前 workflow、缺失文档、阻塞项、最近 review 和 repair 历史。

## 推荐 skill 分工

### `workflow-spec`

用途：从模糊需求开始，探索技术方案、约束、风险和边界，并生成 spec 文档。

输入：

- 用户的功能想法。
- 当前代码库结构、已有文档、相关实现。
- 用户对范围、验收标准、时间成本的偏好。

输出：

- `docs/dev/workflows/<workflow-id>/spec.md`
- `docs/dev/workflows/<workflow-id>/state.json`
- `docs/dev/workflows/<workflow-id>/history.md`

行为约束：

- 先探索代码库和已有文档，再提问题。
- 遇到关键产品决策时，不擅自选择，只给建议和选项。
- spec 未得到用户批准前，不进入计划和实现。
- spec 文档里要明确“已确认”和“待确认”，避免假装所有问题都已解决。

### `workflow-plan`

用途：基于已确认 spec 写执行计划。

输入：

- 已批准的 spec。
- 代码库结构和测试基线。

输出：

- `docs/dev/workflows/<workflow-id>/plan.md`
- 更新 `state.json` 的 `plan` 引用和状态。

计划要求：

- 列出会创建、修改和测试的文件。
- 明确每个实现块的目标、依赖、风险和验证方式。
- 不能用 “TODO / TBD / 后续补充 / 类似上一步” 作为实现占位。
- 计划中应标记哪些任务可以并行，哪些必须串行。

### `workflow-split`

用途：把计划拆成阶段 TODO，明确阶段依赖关系和验收门禁。

输出：

- `docs/dev/workflows/<workflow-id>/todo.md`
- 更新 `state.json` 的 `todo`、`phases`、`dependencies`。

阶段要求：

- 每个阶段都有目标、输入、输出、依赖、测试和完成标准。
- 每个阶段只能依赖明确的前置阶段。
- 并行阶段必须声明 disjoint write set。
- 不允许把“全量实现”作为单一阶段。

### `workflow-implement`

用途：按 TODO 分阶段实现需求。

输入：

- 已批准的 spec。
- 已审查或用户确认的 plan。
- 已拆分的 TODO。
- 当前 `state.json`。

执行模式：

- 默认手动触发，不自动接管普通开发请求。
- 首版必须定义并行实现所需子代理，尤其是 `workflow-phase-implementer`。
- 当多个阶段没有依赖且写入范围不重叠时，`workflow-implement` 应提出或执行已获确认的并行子代理方案。
- 是否并行、每个子代理负责的阶段、写入范围、依赖和验证命令，都必须在执行前明确。

每个阶段结束后：

- 更新 TODO checkbox 和 `state.json`。
- 运行阶段验证命令。
- 生成阶段实现摘要。
- 进入 `workflow-review` 做实现 review，除非用户明确跳过。

### `workflow-review`

用途：审查 spec、plan、todo 或实现。

输出：

- `docs/dev/workflows/<workflow-id>/reviews/<review-id>.md`
- 更新 `state.json` 的 `reviews`。

review 类型：

- `spec`：检查范围、边界、术语、验收标准、未确认决策、风险。
- `plan`：检查任务是否覆盖 spec、依赖是否合理、测试是否充分、是否有占位。
- `todo`：检查阶段粒度、依赖关系、并行安全、阶段门禁。
- `implementation`：按代码 review 姿态检查 bug、回归、缺测试、需求不符和过度实现。
- `repair`：检查修复是否覆盖 review finding，是否引入新问题。

报告格式：

- Findings 优先，按严重程度排序。
- 每条 finding 有稳定 ID，例如 `SPEC-001`、`PLAN-002`、`IMPL-003`。
- 每条 finding 标记 `critical`、`important`、`minor`、`question`。
- 每条 finding 必须说明证据、影响和建议动作。
- 不把 summary 放在 findings 前面。

### `workflow-repair`

用途：基于 review 报告进行修复，并记录修复历史。

输入：

- review 报告。
- 当前 spec/plan/todo/implementation。
- 用户对 finding 的处理决定。

输出：

- `docs/dev/workflows/<workflow-id>/repairs/<repair-id>.md`
- 更新 `state.json` 的 `repairs` 和 review finding 状态。
- 必要时更新 spec、plan、todo 或代码。

修复原则：

- 先逐条确认 finding 是否成立，不能盲目修改。
- `critical` 和 `important` 默认需要修复或获得用户明确豁免。
- 修复如果改变需求边界，必须回到 `workflow-spec` 或 `workflow-plan` 更新文档。
- 修复完成后应重新 review 受影响对象，并把新 review 链接回 repair。

### `workflow-status`

用途：读取 workflow 文档和状态索引，向用户报告当前进展。

输出：

- 当前 workflow 状态。
- 已存在和缺失的文档。
- 阻塞的待确认问题。
- 未关闭 review findings。
- 最近 repair 和后续动作建议。

## 文档与状态管理

推荐使用 `<workflow-id> = YYYY-MM-DD-<slug>`，例如 `2026-04-29-dev-workflow-plugin`。

文档路径采用单 workflow 目录归档：

```text
docs/dev/workflows/<workflow-id>/
├── spec.md
├── plan.md
├── todo.md
├── state.json
├── history.md
├── reviews/
│   └── <review-id>.md
└── repairs/
    └── <repair-id>.md
```

这个方案放弃原先按文档类型分散到 `docs/dev/specs`、`docs/dev/plans`、`docs/dev/todos` 的拓扑。一个需求的 spec、plan、todo、review、repair、state 和 history 都在同一个目录下，方便整体查看、迁移和归档。

`state.json` 建议结构：

```json
{
  "version": 1,
  "workflowId": "2026-04-29-dev-workflow-plugin",
  "title": "开发工作流插件",
  "status": "spec_draft",
  "createdAt": "2026-04-29",
  "updatedAt": "2026-04-29",
  "documents": {
    "spec": "docs/dev/workflows/2026-04-29-dev-workflow-plugin/spec.md",
    "plan": null,
    "todo": null,
    "history": "docs/dev/workflows/2026-04-29-dev-workflow-plugin/history.md"
  },
  "decisions": [
    {
      "id": "D-001",
      "status": "accepted",
      "decision": "插件名使用 dev-workflow。"
    }
  ],
  "phases": [],
  "reviews": [],
  "repairs": [],
  "history": [
    {
      "at": "2026-04-29",
      "actor": "agent",
      "event": "created_spec_draft",
      "document": "docs/dev/workflows/2026-04-29-dev-workflow-plugin/spec.md"
    }
  ]
}
```

状态枚举建议：

- `idea`
- `spec_draft`
- `spec_review`
- `spec_approved`
- `plan_draft`
- `plan_review`
- `plan_approved`
- `todo_ready`
- `implementing`
- `implementation_review`
- `repairing`
- `done`
- `archived`

状态转移原则：

- `spec_draft` 到 `spec_approved` 必须有用户确认。
- `plan_draft` 到 `plan_approved` 必须有用户确认或 review 通过。
- `todo_ready` 之后才能进入实现。
- `implementation_review` 有未关闭 `critical` finding 时不能进入 `done`。
- `repairing` 如果改变需求边界，必须回退到 spec 或 plan 阶段。

## 子代理设计

首版需要在 `extensions.agents` 中声明这些静态角色。实际调用时机由 skill 根据用户确认、阶段依赖和平台能力决定；其中 `workflow-phase-implementer` 是并行实现的核心角色，可以按阶段多次派发，但每次都必须有互不重叠的写入范围。

### `workflow-requirements-researcher`

职责：

- 读取代码库、文档和相关实现。
- 总结现有能力、约束、风险和可复用模块。
- 不写文件。

适用阶段：`workflow-spec` 前期探索。

### `workflow-spec-reviewer`

职责：

- 审查 spec 是否边界清楚、验收标准明确、风险充分、待确认项没有被伪装成结论。
- 不修改 spec，只输出 findings。

适用阶段：spec 自审或正式 review。

### `workflow-plan-reviewer`

职责：

- 检查 plan 是否覆盖 spec。
- 检查任务顺序、依赖、测试策略和实现粒度。
- 找出占位和不可执行步骤。

适用阶段：计划 review。

### `workflow-dependency-planner`

职责：

- 从 plan 中抽取阶段和依赖图。
- 判断哪些阶段可并行，哪些阶段有共享写入风险。
- 输出推荐的串行/并行执行批次，标明每个批次的前置条件。

适用阶段：`workflow-split`。

### `workflow-phase-implementer`

职责：

- 在明确阶段范围内实现任务。
- 只写入被分配的文件。
- 知道自己不是代码库里唯一的执行者，不回退其他代理或用户的改动。
- 发现相邻阶段已改变公共接口时，先适配现有改动；如果会破坏阶段边界，停止并报告。
- 运行指定验证。
- 返回状态、变更摘要、测试结果和疑问。

适用阶段：`workflow-implement`。并行使用前必须确认阶段无共享写入范围；每个子代理的 prompt 需要写清楚阶段 ID、写入文件集合、禁止触碰范围和验证命令。

### `workflow-implementation-reviewer`

职责：

- 先检查实现是否满足 spec/plan/todo。
- 再检查代码质量、测试、回归风险和过度实现。
- 输出 findings，不直接修复。

适用阶段：实现 review。

### `workflow-repair-verifier`

职责：

- 检查 repair 是否覆盖对应 review finding。
- 检查 repair 是否修改了不该修改的范围。
- 判断是否需要追加 review。

适用阶段：`workflow-repair`。

## 插件 manifest 草案

插件名和入口形态已确认。下面展示 source manifest 的首版方向；`extensions.agents[].prompt` 的完整正文在执行计划阶段补齐。

```json
{
  "name": "dev-workflow",
  "version": "0.1.0",
  "description": "面向需求、计划、阶段实现、review 和修复历史的开发工作流插件。",
  "skills": "./skills",
  "skillTriggers": {
    "workflow-spec": { "allowInstallOverride": true },
    "workflow-plan": { "allowInstallOverride": true },
    "workflow-split": { "allowInstallOverride": true },
    "workflow-implement": { "allowInstallOverride": true },
    "workflow-review": { "allowInstallOverride": true },
    "workflow-repair": { "allowInstallOverride": true },
    "workflow-status": { "allowInstallOverride": true }
  },
  "marketplace": {
    "category": "workflow",
    "tags": ["development", "spec", "plan", "review"],
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "NONE"
    }
  },
  "interface": {
    "displayName": "Development Workflow",
    "shortDescription": "需求、计划、实现、review 和修复历史管理",
    "capabilities": ["Skills"]
  },
  "extensions": {
    "agents": [
      {
        "name": "workflow-requirements-researcher",
        "description": "读取代码库和文档，整理需求探索阶段需要的现状、约束和风险。",
        "prompt": "完整 prompt 在执行计划中补齐。"
      },
      {
        "name": "workflow-spec-reviewer",
        "description": "审查 spec 是否边界清楚、验收标准明确且待确认项没有被伪装成结论。",
        "prompt": "完整 prompt 在执行计划中补齐。"
      },
      {
        "name": "workflow-plan-reviewer",
        "description": "审查计划是否覆盖 spec，任务顺序、依赖、测试策略和实现粒度是否可执行。",
        "prompt": "完整 prompt 在执行计划中补齐。"
      },
      {
        "name": "workflow-dependency-planner",
        "description": "从 plan 中抽取阶段和依赖图，判断可并行批次和共享写入风险。",
        "prompt": "完整 prompt 在执行计划中补齐。"
      },
      {
        "name": "workflow-phase-implementer",
        "description": "在明确阶段、依赖和写入范围内实现任务，可被多次派发用于并行实现。",
        "prompt": "完整 prompt 在执行计划中补齐。"
      },
      {
        "name": "workflow-implementation-reviewer",
        "description": "审查实现是否满足 spec、plan 和 todo，并检查代码质量、测试和回归风险。",
        "prompt": "完整 prompt 在执行计划中补齐。"
      },
      {
        "name": "workflow-repair-verifier",
        "description": "验证 repair 是否覆盖对应 review finding，并判断是否需要追加 review。",
        "prompt": "完整 prompt 在执行计划中补齐。"
      }
    ]
  }
}
```

默认触发策略：

- 所有 source skills 首版默认手动触发。
- `agents/openai.yaml` 使用 `policy.allow_implicit_invocation: false`。
- `SKILL.md` 使用 `user-invocable: true` 和 `disable-model-invocation: true`。
- manifest 中保留 `skillTriggers.allowInstallOverride: true`，让用户可以在安装时显式覆盖触发策略。

这个策略把源码默认值固定为手动，避免 spec、plan、repair 这类会写文档或代码的流程在用户没有明确要求时自动介入。即使用户安装时覆盖为自动触发，具体实现、修复和并行子代理派发仍必须遵守 workflow 文档里的确认门禁。

## Review 与 Repair 历史模型

review 报告建议包含：

```markdown
# <workflow-id> <target> Review

审查对象：<path 或 diff range>
审查时间：YYYY-MM-DD
审查类型：spec | plan | todo | implementation | repair

## Findings

### IMPL-001: <标题>

严重程度：critical | important | minor | question
状态：open
证据：<文件、行号、文档段落或命令输出>
影响：<为什么需要处理>
建议：<建议动作>

## Open Questions

## Summary
```

repair 报告建议包含：

```markdown
# <workflow-id> Repair <repair-id>

来源 review：docs/dev/workflows/<workflow-id>/reviews/<review-id>.md
修复时间：YYYY-MM-DD

## 处理结论

| Finding | 决策 | 说明 |
| --- | --- | --- |
| IMPL-001 | fixed | <说明> |
| PLAN-002 | deferred | <用户确认的原因> |

## 修复范围

## 验证结果

## 后续 review
```

`state.json` 中的 review/repair 索引只记录最小状态：

```json
{
  "reviews": [
    {
      "id": "2026-04-29-implementation-review-01",
      "type": "implementation",
      "path": "docs/dev/workflows/2026-04-29-dev-workflow-plugin/reviews/2026-04-29-implementation-review-01.md",
      "status": "open",
      "openFindings": ["IMPL-001"]
    }
  ],
  "repairs": [
    {
      "id": "2026-04-29-repair-01",
      "sourceReview": "2026-04-29-implementation-review-01",
      "path": "docs/dev/workflows/2026-04-29-dev-workflow-plugin/repairs/2026-04-29-repair-01.md",
      "status": "verified"
    }
  ]
}
```

## 关键已确认决策

### D-001：插件名

结论：`dev-workflow`

理由：短、清楚，和功能范围匹配。

### D-002：是否加入 `workflow-status`

结论：加入。

理由：状态管理和历史管理如果没有独立入口，用户需要记住每个文档路径，体验会差。

### D-003：文档拓扑

结论：采用单 workflow 目录归档。

所有文档放在 `docs/dev/workflows/<workflow-id>/` 下，包括 `spec.md`、`plan.md`、`todo.md`、`state.json`、`history.md`、`reviews/` 和 `repairs/`。

### D-004：默认触发策略

结论：所有 source skills 默认手动触发。

理由：这些 skill 会写文档、推进计划和修改代码，默认自动触发容易打断用户已有工作流。

实现细化：`SKILL.md` 使用 `disable-model-invocation: true`，`agents/openai.yaml` 使用 `allow_implicit_invocation: false`。manifest 可保留 `skillTriggers.allowInstallOverride: true`，但即使用户安装时覆盖为 auto，写代码、修复和并行派发仍需要明确门禁。

### D-005：默认实现模式

结论：默认手动推进，但首版必须定义并行实现所需子代理。

实现细化：`workflow-dependency-planner` 负责识别可并行批次，`workflow-phase-implementer` 作为可多次派发的实现角色。并行前必须明确每个阶段的依赖、写入范围、禁止触碰范围和验证命令。

理由：并行实现需要 disjoint write set、依赖图和冲突处理。把子代理定义放进首版，可以让计划阶段直接生成可执行的并行策略。

### D-006：首版是否引入 MCP

结论：首版不引入 MCP，只用 skill 管理文档和状态文件。后续如果需要文档索引、状态校验或流程查询工具，再设计 MCP。

理由：当前需求可以用 Markdown/JSON 文档完成；MCP 会增加测试、安装和跨平台调试成本。

### D-007：是否允许自动修改旧 review 状态

结论：repair skill 可以更新 `state.json` 中的 finding 状态，但不改写旧 review 报告正文。旧 review 保持不可变，repair 报告记录处理结果。

理由：保留审查历史，避免追踪困难。

### D-008：首版是否加入公共 `slashCommands`

结论：首版不加入公共 `slashCommands`。

理由：source skills 已能覆盖双平台手动入口；公共 `slashCommands` 在 Codex 侧会生成 manual-only skill，命令名不能和 source skill 同名。首版先避免重复入口，后续如果确实需要命令式入口，可新增 `wf-spec`、`wf-plan` 这类不冲突的 alias。

## 验收标准

首版插件设计通过后，后续实现应满足：

- 能安装为双平台 AW 插件。
- 每个 skill 都有 `SKILL.md` 和 Codex `agents/openai.yaml`。
- 默认不会隐式触发会写文件或代码的流程。
- 能从一个需求想法生成 spec 草案，并记录 workflow state。
- 能从已批准 spec 生成 plan。
- 能从 plan 生成阶段 TODO 和依赖关系。
- 能按 TODO 推进实现，并在状态文件中记录阶段进度。
- 能对 spec、plan、todo、implementation 输出 review 报告。
- 能基于 review 报告生成 repair 记录，并更新 finding 状态索引。
- 能通过 status skill 汇总当前 workflow 状态、缺失文档和未关闭 findings。
- review 和 repair 历史不被覆盖。
- 并行子代理策略必须先标明依赖和写入范围，获得用户确认后再执行。

## 下一步

进入执行计划设计，计划中需要细化：

- 插件 source 目录结构。
- 每个 skill 的 frontmatter、默认触发策略和正文指令。
- `extensions.agents` 的完整 prompt。
- reference 模板文档。
- 作者工具校验项。
- build 和测试命令。
