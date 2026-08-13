# codex-explore Skill 完整评审报告

## 结论

- **Skill：** `codex-explore`
- **模式：** `full`
- **方向：** `at-risk`
- **复杂度：** `proportionate`
- **可缩减程度：** `minor`
- **发布结论：** `pass-after-fixes`
- **加权总分：** 86.9 / 100
- **原始质量带：** `strong`
- **有效质量带：** `strong`
- **覆盖率：** 100%
- **置信度：** `high`，指数 0.93
- **一句话结论：** Skill 的范围、架构、等待和证据流程主体可靠，但显式模型字段不可用时没有稳定失败关闭；该问题在 3/3 次真实运行中复现，是发布前必须修复的 P1。

本报告评审当前提交 `fc84b762789d62439342b9e5aaf45bd3cc68c427`。生产源 digest 为 `sha256:de199f4c220b903451fb40518fa4b3f307fa5c4a7194da7e181031de066d9f93`，评测记录显示 `inScopeDirty=false`。评审和 eval 制品保存在 `.tmp/agent-workflows/`。本次没有发布报告，也没有修改插件生产源。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 把大型、边界不明或陌生材料中的事实搜索与核验移出父会话，减少上下文污染，同时把判断和写操作保留在父代理。 | known |
| 已观察失败 | `hidden_explicit_field` 在 schema 不公开 `model` 时仍启动 custom role；部分 review、缺陷和实现请求误加载 Skill；liveness 缺少叶子 tool trace。 | known |
| 成功标准 | Gate 只允许可独立的广泛事实探索；role 与显式 override 符合当前 schema；父代理不重复活跃范围；只整合终态、可核验证据。 | known |
| 目标环境或客户端 | Codex CLI 0.147.0，支持 `spawn_agent.agent_type`、四个 explore role、响应式 wait；兼容 v1/v2 context 字段。 | known |
| 范围外事项 | 最终缺陷判定、质量评价、严重性、建议、实现、发布和其它写操作。 | known |
| 相邻 Skill | `codex-subagent-guide` 管理已授权且没有专用 owner 的通用委派；它不应接管 explore 的专用流程。 | known |
| 发布要求 | manifest 声明四个 materialization profile、trigger validation/sanity、model-selection 和 workflow 为 release-required。用户请求完整评审，不要求正式发布。 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | `pnpm build`、plugin validator、plugin tests、materialization | 包结构、frontmatter、模板和制品有效。 |
| critical-artifacts | pass | P0 | — | `SKILL.md`、`openai.yaml`、README、4 roles、renderer、eval manifest | 核心引用均存在且可用。 |
| goal-alignment | pass | P0 | — | `SKILL.md:11-25,49-67` | 事实探索与判断、写操作保持分离。 |
| capability-validity | pass | P0 | — | 当前 schema、4 role materialization、workflow trace | 核心流程不依赖缺失能力。 |
| safety-permissions | pass | P0 | — | `SKILL.md:24-25,51-55` | 权限继承、行为只读和外部查询脱敏均明确。 |
| architecture-ownership | pass | P1 | — | schema/runtime owner 审计 | 动态字段和状态由工具提供，Skill 不缓存 runtime 状态。 |
| release-evidence | fail | P1 | F-EXP-001 | `model-selection-project-default.json#hidden_explicit_field` | 3/3 次重复违反显式 override 的失败关闭合同。 |

## 优点

- Gate 同时要求范围价值、可自包含的事实问题，以及与最终判断和写操作分离。该结构直接支持父子边界。
- `quick`、`standard`、`deep` 和 `custom` 的意图不同。9/10 个 model-selection case 通过，包括显式双字段、单字段、隐藏 preset 字段和非法显式值。
- workflow 的 3/3 个 case 通过。结果覆盖 spawn 参数、干净上下文、父范围隔离、终态和证据整合。
- liveness 的 9 次运行都完成长等待流程。每次至少出现一次 timeout 后继续等待，并最终到达终态；没有短轮询、状态探测或工作区写入。
- project/user 与 default/nondefault 的 materialization 均通过，生成的 skill、roles 和 config digest 可复核。
- renderer 集中处理 role key、模型默认值和等待时间。父 Skill 不重复 role 的叶子证据格式。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-EXP-001 | P1 | observed, normative | instruction_design | `SKILL.md:33-45`；`model-selection-project-default.json#hidden_explicit_field` | 用户显式指定 `model`，但当前 schema 隐藏该字段。 | 3/3 次都调用 `spawn_agent`；参数有 custom `agent_type` 和 clean context，但没有 `model`。期望 spawn 0，实际每次为 1。 | 显式双字段、model-only、reasoning-only、隐藏 preset 和非法值 case 都通过；问题只在隐藏显式字段 branch。 | Skill | 在 role 选择和 spawn 前先收集全部用户显式 override。任一字段不在 schema 时立即停止，不调用 spawn。 | 原 case 重跑 3 次，并增加隐藏 `reasoning_effort` holdout；两者均须 0 spawn，并指出不可满足字段。 |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-EXP-002 | P2 | observed | triggering | `SKILL.md:3`；trigger reports | validation 的 PR 缺陷 case 2/3 次误加载；train 的两个 review case 各 3/3 次误加载，实现 case 2/3 次误加载。所有误加载均未 spawn。 | description 先排除以 review、缺陷判断、建议或实现为交付目标的请求；正向条件只保留“交付目标本身是广泛事实搜索”或“请求明确分离事实子任务”。 |
| F-EXP-003 | P2 | observed, structural | evals | `eval-harness.mjs:350-370`；`run-liveness-evals.mjs:282-286` | 9/9 次 liveness 只因 `verifier_invoked_by_leaf` 失败；`leaf_tool_calls` 始终为空。 | 按 runtime child id 保存和关联叶子 rollout/tool event。在直接证据可用前，不用父临时 CODEX_HOME 的文件归属推断叶子调用。 |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-EXP-001 | problem_value | 没有 no-skill 或 minimal-skill 基线，无法量化上下文、时间和质量净收益。 | 在相同任务上比较 no-skill、minimal-skill 和当前 Skill 的质量、token、时间和方差。 |
| U-EXP-002 | minimum_control | 最大 4 个 agent 和每个子任务最多恢复一次没有隔离消融。 | 分别放宽两个限制，比较重复工作、成功率和成本。 |
| U-EXP-003 | evals | 叶子代理是否实际调用 verifier 无法由已保存的原始 trace 确认。 | 保存并关联子代理 rollout，直接读取叶子 tool call。 |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | build、validator、tests、4+1 profiles | — | — | 包和材料完整。 |
| 问题基础与实际价值 | 8 | 4.0 | medium | Gate 目标；workflow 3/3 | — | U-EXP-001 | 价值清楚，缺基线。 |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | high | validation 7/8；sanity 10/10；train 10/13 | F-EXP-002 | — | 有局部误加载。 |
| 范围、边界与组合性 | 8 | 5.0 | high | `SKILL.md:15-25,47-55`；workflow | — | — | 父子边界清楚。 |
| 程序与完成边界 | 10 | 3.5 | high | model-selection 9/10 | F-EXP-001 | — | 显式字段失败关闭不可靠。 |
| 最小充分控制与模型自由度 | 14 | 4.0 | medium | 最小控制审计 | — | U-EXP-002 | 主体适当，两个上限缺消融。 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | 信息层级图；schema/runtime 查询 | — | — | 稳定策略和环境事实分离。 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | owner 审计；runtime trace | — | — | owner 正确。 |
| 脚本与确定性自动化 | 7 | 5.0 | high | renderer、9 files/18 tests | — | — | 确定性逻辑已脚本化。 |
| 评测、验证与证据驱动迭代 | 9 | 3.5 | high | 135 次模型运行；liveness raw trace | F-EXP-003 | U-EXP-003 | 覆盖广，但叶子证据采集有缺口。 |
| 可靠性、安全与兼容性 | 4 | 5.0 | high | profiles、v1/v2、权限和 lifecycle | — | — | 兼容和安全边界充分。 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 67 行源 Skill；集中 renderer；版本门禁 | — | — | 无明显沉积。 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `SKILL.md` frontmatter description | 大型、边界不明、陌生材料的事实搜索和核验 | 正向 broad-search；负向 review/write/known-source | 部分 | 否 | 否 | validation 7/8、sanity 10/10、train 10/13 | 重写顺序，先排除以判断或写作为交付目标的请求。 |
| `agents/openai.yaml:4` | 用户显式调用 `$codex-explore` | 显式调用 | 是 | 否 | 否 | 显式 workflow 和 model-selection 均可加载 | 保持。 |
| `SKILL.md:4` compatibility | 当前 schema 和四个 role | Gate 通过后的能力确认 | 是 | 否 | 否 | 四种 release profile 和 short-wait profile materialization 通过 | 保持为兼容 pointer，不复制 schema。 |

## 最小有效控制审计

### 最小行为合同

1. 只委派可与判断和写操作分离的大范围或边界不明事实探索。
2. 最终判断、严重性、建议和写操作留在父代理；叶子代理保持行为只读。
3. 启动前确认所选 role 和每个显式 override 都由当前 schema 支持；否则不启动。
4. 显式 model 或 reasoning effort 只使用 custom；其它情况选择 quick、standard 或 deep，且不传模型字段。
5. 默认使用一个干净上下文代理，并提供自包含的范围、来源、问题和证据要求。
6. 继承现有权限边界；公开搜索前最小化并脱敏输入。
7. 通过 runtime 等待；timeout 不等于失败；不得重复接管仍活跃的委派范围。
8. 只整合已终态且来源可核验的证据；仅在安全时清理代理。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 5：Gate、schema/role、spawn、wait、validate/integrate | medium；顺序错误会越界或丢失 override。 |
| Hard gates | 4 类：范围价值、自包含事实任务、无判断/写操作、能力与权限可确认 | high；适合保持为不变量。 |
| Fixed intermediate artifacts | 0 | low；没有为模型生成额外文档。 |
| Prohibitions | 约 12 类，集中在 role、权限、隐私、活跃范围、轮询、恢复和清理 | medium；大部分直接防止可观察故障。 |
| Conditional branches | 5 类：role、自定义字段、fanout、恢复/回退、cleanup | medium。 |
| Fixed output fields | 父代理无固定 schema；叶子 role 固定 Status/Findings/Gaps | low；叶子格式由 role 管理。 |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| Gate 三项条件 | 阻止把判断或小范围读取委派出去 | 目标边界和 trigger eval | invariant | 否 | keep-invariant | 高；会改变 Skill 目标。 |
| schema 与 role 存在检查 | 防止调用不存在能力 | 当前工具事实 | invariant | 否 | keep-invariant | 高；会产生非法调用。 |
| 显式 override 失败关闭 | 保留用户明确选择 | 规范和 observed failure | invariant | 否 | keep-invariant | 高；F-EXP-001 已复现。 |
| quick/standard/deep 映射 | 提供默认质量/成本档 | model-selection 结果 | default | 部分 | keep-default | 中；完全删除会增加选择方差。 |
| 干净上下文与自包含 message | 限制上下文泄露和隐式依赖 | workflow trace | default | 部分 | keep-default | 中。 |
| 默认一个 agent | 限制重复调查 | 成本和组合性 | default | 是 | keep-default | 低到中。 |
| 最多四个 agent | 限制 fanout | 仅静态理由 | invariant | 未知 | needs-ablation | 未验证；可能过严或必要。 |
| 权限继承和外部脱敏 | 防止错误安全声明和数据泄露 | 安全边界 | invariant | 否 | keep-invariant | 高。 |
| 终态、活跃范围和不重复接管 | 防止并发竞争 | liveness/workflow trace | invariant | 否 | keep-invariant | 高。 |
| 至少十分钟首次等待和禁止探测 | 防止短轮询和假失败 | liveness trace | default + prohibition | 部分 | keep-default | 中；当前 trace 支持该默认。 |
| 每个子任务最多恢复一次 | 限制恢复循环 | 静态成本约束 | invariant | 未知 | needs-ablation | 未验证。 |
| 最小补读、有限 fallback 和安全 cleanup | 控制父代理接管和资源生命周期 | scope/lifecycle | default | 部分 | keep-default | 中。 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| Gate 与停止条件 | in-file-step | 所有隐式调用 | `SKILL.md:13-27` | 是 | frontmatter description | keep-invariant | 保持。 |
| role 与 override 规则 | in-file-step | Gate 通过 | `SKILL.md:29-47` | 是 | 当前 spawn schema | keep-invariant/default | 修复显式字段 preflight。 |
| 权限、隐私和活跃范围不变量 | in-file-reference | spawn、公开搜索、并发 | `SKILL.md:49-55` | 条件需要 | 父 permission profile、任务来源 | keep-invariant | 保持。 |
| 等待、恢复、整合和 cleanup | in-file-reference | spawn 成功后 | `SKILL.md:57-67` | 条件需要 | runtime status/tool schema | keep-default/invariant | 保持；两个上限待消融。 |
| 字段、role 和状态 | environment-lookup | spawn/wait | 当前 tool schema、materialized roles、runtime | 否 | Codex tools | keep-invariant | 不缓存到 Skill。 |
| 叶子证据格式和行为只读约束 | environment-lookup | 选定 explore role | materialized role，由 `render-artifacts.mjs` 生成 | 父代理不需要 | role artifact | keep-invariant | 保持在 role，不复制到父 Skill。 |

eval fixture、case 和报告不进入 runtime Skill 包，也不在触发后加载。

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Gate | 三项范围条件全部满足，且无停止条件 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| schema/override preflight | role 存在；显式字段可完整表达 | 是 | 是 | 否 | 否 | 高 | 使“检查全部显式字段”成为 spawn 前的单一 fail-fast 条件。 |
| spawn | role、clean context 和自包含 message 正确 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| wait 与活跃范围 | runtime 明确终态前视为活跃；timeout 后按需继续等待 | 是 | 是 | 是 | 是 | 高 | 保持。 |
| 证据接受 | 回答问题、claim 绑定来源，并区分 direct/inference/conflict/gaps | 是 | 是 | 是 | 是 | 中 | 保持。 |
| cleanup | 结果已保留，目标和必要后代均不再需要 | 是 | 是 | 是 | 是 | 中 | 保持。 |

## 架构与职责归属

- **Skill 负责的策略：** Gate、父子任务边界、role 默认选择、显式 override 保留、clean context、等待和整合原则。
- **Schema 或客户端负责的事实：** 可用字段、合法值、role key、context 参数名和 wait 上下限。
- **Runtime 负责的状态：** agent 活跃/终态、timeout、通知、后代关系和停止结果。
- **脚本候选：** role/config 渲染和 eval 解析已经由脚本承担；不需要新增 runtime 脚本。
- **仅属于 role 的约束：** 叶子行为只读、来源定位、Status/Findings/Gaps 输出。
- **仅属于 eval 或 issue 的问题：** 叶子 rollout 采集和 verifier 断言。
- **自然语言状态机风险：** `medium`。流程含并发与终态，但 Skill 依赖 runtime 状态，不自行模拟状态。

## 脚本与资源

- **已有脚本或正确省略：** `scripts/render-artifacts.mjs` 生成两个 Skill 的 role 和等待配置；各 eval runner 运行 trigger、model、workflow 和 liveness。
- **接口、依赖和安全质量：** build、plugin validator、9 个测试文件和 18 个测试通过；materialized digest 匹配。
- **模型仍在重复的确定性逻辑：** 父代理仍需读当前 schema 并选择 branch，这是 runtime 决策，不适合静态脚本替代。
- **Reference 和 asset 可达性：** Skill 没有 runtime reference/asset 依赖；README 和 eval 文档均可达。
- **重复：** 父 Skill 不重复叶子 role 的完整证据格式。
- **Scattering 与 co-location：** 稳定策略在 Skill；role 生成和配置在一个 renderer；eval fixture 与对应 Skill 同目录。
- **不必要缓存的环境事实：** 未发现。
- **过期或孤立资源：** 未发现。静态 state-machine 提示属于 heuristic，不构成 finding。

## 评测与证据

### 执行环境

- **Batch：** `.tmp/agent-workflows/evals/plugin/codex-enhance/codex-explore/20260812T175539Z-full-review-20260813-1ac5bf66`
- **模型：** `gpt-5.6-luna`
- **Codex：** `codex-cli 0.147.0`
- **Provider：** `openai-oauth`
- **进程管理：** managed；可检查后代并保证 cleanup。
- **materialization：** project-default、user-default、project-nondefault、user-nondefault 全部通过；project-short-wait 也通过。
- **release target：** 8/8 已覆盖，无 missing target；release outcome 为 `failed`。

### 完整运行矩阵

| Suite | Split/profile | Cases × runs | 模型运行数 | 结果 | 解释 |
| --- | --- | ---: | ---: | --- | --- |
| trigger | validation / project-default | 8 × 3 | 24 | 7/8 case 通过 | `pr_defect_validation` 误加载 2/3。 |
| trigger | sanity / project-default | 10 × 3 | 30 | 10/10 通过 | 正负向 sanity 稳定。 |
| trigger | train / project-default | 13 × 3 | 39 | 10/13 通过 | 两个 review 和一个 implementation case 误加载。 |
| model-selection | project-default | 10 × 3 | 30 | 9/10 通过 | `hidden_explicit_field` 0/3。 |
| workflow | project-default | 3 × 1 | 3 | 3/3 通过 | end-to-end spawn、等待、证据和隔离通过。 |
| liveness | project-short-wait | 3 × 3 | 9 | 0/3 case 机械通过 | 9 次都只缺叶子 verifier tool trace；其它 lifecycle 断言通过。 |
| **合计** | — | — | **135** | — | 完整执行 release suites、train 和非 release liveness。 |

- **Trigger eval 与触发率：** release validation 87.5%，sanity 100%，train 76.9%。失败属于 false load，不是越权 spawn。
- **Behavior 或 regression eval：** model-selection 90%；workflow 100%。唯一行为 P1 是显式字段隐藏时仍 spawn。
- **Runtime trace：** liveness 9/9 次有至少一次 timeout、至少两次 wait、最终终态、无 probe、无父范围写入。叶子 verifier raw tool trace 缺失。
- **基线：** none。历史版本不作为当前分数基线。
- **Ablation 或 no-op 证据：** 无正式 ablation；trigger 负向 case 提供局部 no-op 证据。
- **Token、时间和方差成本：** 未形成统一基线。liveness 三组 median 约为 208 s、153 s 和 182 s。
- **发布仍缺少的证据：** 修复后 `hidden_explicit_field` 和新增 hidden-reasoning holdout；可靠的叶子 tool trace；可选 fanout/recovery ablation。

## 最小改进路线

### 现在——发布阻断

1. 在 spawn 前实施单一显式 override preflight。任一用户显式字段不在 schema 时，直接失败关闭。
2. 重跑 model-selection 3 次，并增加隐藏 `reasoning_effort` holdout。两类都必须 0 spawn。

### 下一步——高价值质量改进

1. 收紧 frontmatter description，减少 review、缺陷和实现请求的 false load。
2. 修复 liveness 的叶子 rollout/tool 证据采集，再重跑 3 × 3 liveness。

### 以后——启发式、评测或产品/runtime 工作

1. 增加 no-skill/minimal-skill 基线。
2. 对最大 fanout 和一次恢复上限做独立 ablation。

## 停止决定

现在应停止评审。当前材料已经提供完整静态检查、135 次真实模型运行、runtime trace、全部 12 个维度和最小控制审计。继续阅读相同材料不会改变结论。下一轮必须先出现新的 observed 证据：F-EXP-001 的修复后 model-selection 结果，或 F-EXP-003 的真实叶子 tool trace。
