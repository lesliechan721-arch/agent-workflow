# codex-subagent-guide Skill 完整评审报告

## 结论

- **Skill：** `codex-subagent-guide`
- **模式：** `full`
- **方向：** `aligned`
- **复杂度：** `proportionate`
- **可缩减程度：** `minor`
- **发布结论：** `pass-after-fixes`
- **加权总分：** 92.1 / 100
- **原始质量带：** `excellent`
- **有效质量带：** `excellent`
- **覆盖率：** 100%
- **置信度：** `high`，指数 0.92
- **一句话结论：** Skill 本身短、边界清楚、架构正确；但当前 eval harness 把同插件的 8 个 role 错判为异常，导致 routing 和 lifecycle 两个发布必需 suite 在模型运行前中止。该 eval 结构问题是发布证据 P1。

本报告评审当前提交 `fc84b762789d62439342b9e5aaf45bd3cc68c427`。生产源 digest 为 `sha256:de199f4c220b903451fb40518fa4b3f307fa5c4a7194da7e181031de066d9f93`，评测记录显示 `inScopeDirty=false`。评审和 eval 制品保存在 `.tmp/agent-workflows/`。本次没有发布报告，也没有修改插件生产源。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 当委派已获授权且没有专用工作流 owner 时，为通用子代理选择 role、显式参数、context、等待和 cleanup 行为。 | known |
| 已观察失败 | 当前 routing 和 lifecycle 因 harness 要求 role 总数正好为 4 而中止；安装和无授权研究请求误加载；existing-agent fixture 会等待不存在的 actor。 | known |
| 成功标准 | 不授予委派权限；尊重专用 owner；只使用当前 schema；按最终交付物选择 role；默认 clean context；只接受 runtime 终态；安全 cleanup。 | known |
| 目标环境或客户端 | Codex CLI 0.147.0，支持 `spawn_agent.agent_type`、四个 guide role 和 agent lifecycle 工具。 | known |
| 范围外事项 | 判断是否应授权委派、专用 Skill 已管理的委派、只讨论多 Agent 的建议、插件安装和配置说明。 | known |
| 相邻 Skill | `codex-explore` 是专用的大范围只读事实探索 owner；适用时应由它完整管理生命周期。 | known |
| 发布要求 | manifest 声明四个 materialization profile、trigger validation/sanity、routing 和 lifecycle 为 release-required。用户请求完整评审，不要求正式发布。 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | `pnpm build`、plugin validator、plugin tests、materialization | 包结构和生成制品有效。 |
| critical-artifacts | pass | P0 | — | Skill、pointer、4 guide roles、renderer、eval manifest | 核心材料存在。 |
| goal-alignment | pass | P0 | — | `SKILL.md:3,11-31` | Skill 只管理已授权通用委派，不授予权限。 |
| capability-validity | pass | P0 | — | 当前 schema 和 materialized artifacts | 所需能力存在；8 role 是合并插件的预期结构。 |
| safety-permissions | pass | P0 | — | authorization、exact context、agent-only monitoring、safe cleanup | 未发现静默越权或不受控副作用。 |
| architecture-ownership | pass | P1 | — | owner 与 state 审计 | 动态 schema 和终态由工具提供。 |
| release-evidence | fail | P1 | F-GUIDE-001 | 当前 full batch 的 routing/lifecycle diagnostics | 两个 release-required 行为 suite 都没有当前合并制品的模型结果。 |

## 优点

- frontmatter 同时要求“委派已授权”和“没有专用 Skill owner”。它还明确说明本 Skill 不授予权限。
- materialized Skill 约 42 行、约 380 tokens。核心程序只有 spawn 参数、context、等待和 cleanup 三段。
- role 分类按最终交付物，而不是按是否只读。该设计避免把复杂只读任务错误降到 simple。
- context 规则优先 clean context，并要求 message 自包含。最近 N 轮无法精确表达时失败关闭，不用全历史近似。
- wait 只在父代理需要结果时调用。timeout 不是失败，终态以 runtime 结果为准，监控只使用 agent 工具。
- trigger release validation 7/7、sanity 6/6。专用 workflow owner 的 6 次相关运行均没有加载本 Skill，也没有 spawn。
- 四种 default/nondefault、project/user materialization 均通过。当前制品正确包含 4 个 explore role 和 4 个 guide role。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-GUIDE-001 | P1 | observed, structural | evals | `eval-harness.mjs:75-80`；当前 batch `raw/evaluation.json` | 对当前合并插件运行 routing 或 lifecycle。 | `readMaterializedRoles` 读取全部 `.codex/agents/*.toml`，数量不是 4 就 throw；当前预期为 8。routing 没有报告，lifecycle cases=0，两者均显示 `got 8`。 | build、validator、9 个测试文件/18 个测试和 materialization 均通过，说明 8 roles 是正确制品。历史正式批次在插件合并前生成，不能关闭当前回归。 | Eval | 只筛选并验证四个 guide role key 或文件，每个正好一次；忽略 explore roles。 | 在当前合并插件上完整重跑 routing/lifecycle；增加缺少一个 guide role 和重复一个 guide role 的负向 fixture。 |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-GUIDE-002 | P2 | observed | triggering | `SKILL.md:3`；train report | `installation_near_miss` 和 `research_without_authority` 都在 3/3 次加载 Skill，但 0 spawn。 | description 先写“已授权且当前请求要求实际执行委派”，并明确排除安装、配置和没有委派授权的研究。 |
| F-GUIDE-003 | P2 | observed, structural | evals | train/composition fixtures and reports | `manage_existing_agent` 的 3 次运行和两个专用 owner case 各一次运行因不存在的命名 agent 超时。 | 提供 runtime 可见的 existing-agent fixture/tool shim；或在 load/spawn 观察已完成时结束 trigger case。 |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-GUIDE-001 | minimum_control | 首次等待至少十分钟的精确默认值及例外没有当前版本的隔离消融。 | 比较更短、十分钟和更长窗口的假失败、轮询次数、完成时间和中断响应。 |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | build、validator、tests、4 profiles | — | — | 包和材料完整。 |
| 问题基础与实际价值 | 8 | 5.0 | high | 目标合同、当前 trigger、历史行为反证 | — | — | 解决明确且重复的问题。 |
| 调用策略、触发条件与 Context Pointer | 10 | 4.0 | high | validation 7/7；sanity 6/6；train 9/12 | F-GUIDE-002 | — | 主边界稳定，有局部误加载。 |
| 范围、边界与组合性 | 8 | 5.0 | high | authorization/owner gate；composition no-load | — | — | 专用 owner 优先。 |
| 程序与完成边界 | 10 | 5.0 | medium | 静态完成边界；历史行为报告 | — | — | 程序清楚，当前行为 suite 未执行。 |
| 最小充分控制与模型自由度 | 14 | 4.5 | medium | 最小控制审计；短 materialized Skill | — | U-GUIDE-001 | 控制紧凑，精确等待值缺消融。 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | schema/runtime 环境查询 | — | — | 不缓存动态事实。 |
| 职责归属与自然语言状态机风险 | 10 | 5.0 | high | owner 审计；agent-only monitoring | — | — | owner 正确。 |
| 脚本与确定性自动化 | 7 | 5.0 | high | renderer、9 files/18 tests | — | — | 确定性生成完整。 |
| 评测、验证与证据驱动迭代 | 9 | 2.5 | high | 87 次 trigger 模型运行；routing/lifecycle preflight failure | F-GUIDE-001, F-GUIDE-003 | — | 当前 release 行为证据不完整。 |
| 可靠性、安全与兼容性 | 4 | 5.0 | medium | 8 role materialization、schema 和安全静态审计 | — | — | 兼容声明成立，当前行为置信度受 eval 阻断影响。 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | 31 行模板、集中 renderer、版本门禁 | — | — | 无明显沉积。 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `SKILL.md` frontmatter description | 已授权、无专用 owner、要实际执行的通用委派 | 正向 authorization；负向 discussion/no owner | 大部分 | 否 | 否 | validation 7/7、sanity 6/6、train 9/12 | 把“实际执行”提前；增加 install/config/no-authority 排除。 |
| `agents/openai.yaml:4` | 显式 `$codex-subagent-guide` | 用户明确调用 | 是 | 否 | 否 | explicit trigger case 通过 | 保持。 |
| `SKILL.md:4` compatibility | 当前 schema 和四个 bundled guide roles | spawn/wait/cleanup | 是 | 否 | 否 | 四种 materialization profile 通过 | 明确“four guide roles”可减少与插件总 role 数混淆；不复制 role 文件。 |

## 最小有效控制审计

### 最小行为合同

1. 只在委派已被授权且没有专用 workflow owner 时调用。
2. 只使用当前 schema 公开的字段和 role；显式 custom 字段必须完整保留，否则失败关闭。
3. 按最终交付物选择一个 preset；只读不自动等于 simple。
4. 默认使用干净上下文和自包含 message；只有必要且 schema 可精确表达时才继承。
5. 只在后续工作需要结果时等待；使用响应式长窗口，timeout 不等于失败。
6. 只有 runtime 明确报告终态时才视为完成。
7. 只用 agent 工具监控；保留结果且目标和后代不再需要时才 cleanup。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 4：authorization/owner、role/schema/spawn、context、wait/cleanup | medium。 |
| Hard gates | 3 类：已有授权、无专用 owner、schema 可精确表达 | high；适合保持为不变量。 |
| Fixed intermediate artifacts | 0 | low。 |
| Prohibitions | 约 8 类，集中在降级、近似 context、假终态、非 agent 监控和过早 cleanup | medium。 |
| Conditional branches | 4 类：preset/custom、inheritance、wait、cleanup | medium。 |
| Fixed output fields | 无固定 final schema；spawn message 有 7 类语义字段 | low。 |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 已授权 Gate | 防止 Skill 自行授予委派权限 | 项目授权边界 | invariant | 否 | keep-invariant | 高；删除会越权。 |
| 专用 owner 优先 | 防止两个 Skill 同时管理生命周期 | composition 证据 | invariant | 否 | keep-invariant | 高；会重复管理。 |
| 当前 schema 为准 | 防止调用隐藏或不存在字段 | client 合同 | invariant | 否 | keep-invariant | 高。 |
| 四个 preset 分类 | 降低 role 选择方差 | 任务交付物差异 | default | 部分 | keep-default | 中。 |
| 显式 custom 字段完整保留 | 保持用户选择 | 用户意图 | invariant | 否 | keep-invariant | 高。 |
| clean context + 自包含 message | 减少隐式依赖和泄露 | context 边界 | default | 部分 | keep-default | 中。 |
| 继承只在必要且可精确表达时使用 | 防止全历史近似最近 N 轮 | schema 限制 | invariant | 否 | keep-invariant | 高。 |
| 首次至少十分钟 | 减少短轮询和假失败 | lifecycle 目标 | default | 未知 | needs-ablation | 未验证精确数值。 |
| timeout 非失败、只认 runtime 终态 | 防止提前完成 | runtime 事实 | invariant | 否 | keep-invariant | 高。 |
| 只用 agent 工具监控 | 防止 shell/file/Git 旁路状态机 | architecture | invariant | 否 | keep-invariant | 高。 |
| 保存结果且无必要后代后 cleanup | 防止结果或后代丢失 | lifecycle | invariant | 否 | keep-invariant | 高。 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| authorization 和专用 owner Gate | in-file-step | 所有调用 | frontmatter description | 是 | 用户、AGENTS.md、专用 Skill | keep-invariant | 加强触发顺序，不扩展正文。 |
| preset/custom 与 role 表 | in-file-step | spawn | materialized `Spawn 参数` | 是 | renderer 注入四个 guide role | keep-default/invariant | 保持。 |
| context 选择 | in-file-step | spawn | `SKILL.md:17-23` | 是 | 当前 schema | keep-default/invariant | 保持。 |
| wait 与 cleanup | in-file-reference | 父代理依赖结果时 | `SKILL.md:25-31` | 条件需要 | runtime agent 状态 | keep-default/invariant | 等待数值待消融。 |
| 字段、合法值和 role 是否存在 | environment-lookup | spawn | 当前 tool schema、materialized roles | 否 | Codex tools/artifacts | keep-invariant | 不缓存。 |
| 终态、timeout 和后代关系 | environment-lookup | wait/cleanup | runtime | 否 | agent tools | keep-invariant | 不用 shell/file 模拟。 |

eval fixture、case 和报告不进入 runtime Skill 包，也不在触发后加载。

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| authorization/owner Gate | 已授权，且没有专用 workflow owner | 是 | 是 | 是 | 是 | 高 | 保持。 |
| role 与字段 | preset 按最终交付物；custom 字段完整可用 | 是 | 是 | 是 | 是 | 中 | 当前 routing 修复后重新验证。 |
| context | 默认 clean；继承有必要且可精确表达 | 是 | 是 | 是 | 是 | 中 | 保持。 |
| wait | 父代理需要结果；runtime 未终态则继续保持未完成 | 是 | 是 | 是 | 是 | 高 | 保持。 |
| cleanup | 结果已保存，目标和后代都不再需要 | 是 | 是 | 是 | 是 | 高 | 保持。 |

## 架构与职责归属

- **Skill 负责的策略：** authorization 前置条件、专用 owner 优先、role/default 选择、context 默认、等待和 cleanup 原则。
- **Schema 或客户端负责的事实：** `agent_type`、model、reasoning、fork 和 wait 字段及合法值。
- **Runtime 负责的状态：** agent 是否存在、活跃或终态，timeout、通知、后代关系和 cleanup 能力。
- **脚本候选：** role 表、模型默认值和等待配置已经由 renderer 生成；不需要增加 runtime 脚本。
- **仅属于 role 的约束：** 子代理只执行委派任务，并按任务 message 返回结果。
- **仅属于 eval 或 issue 的问题：** 合并插件中的 role 过滤、existing-agent fixture 和 trigger observer 超时。
- **自然语言状态机风险：** `low`。Skill 明确依赖 runtime 终态，不维护本地状态表。

## 脚本与资源

- **已有脚本或正确省略：** `scripts/render-artifacts.mjs` 生成四个 guide roles、spawn 参数表和等待默认值；routing/lifecycle/trigger runners 位于 Skill 的 eval 目录。
- **接口、依赖和安全质量：** build、plugin validator、9 个测试文件和 18 个测试通过；生成 digest 匹配。
- **模型仍在重复的确定性逻辑：** role 选择需要理解最终交付物，保留给模型；role 配置和字段渲染已脚本化。
- **Reference 和 asset 可达性：** 无 runtime reference/asset 依赖；README 和 eval 文档可达。
- **重复：** 源模板使用 placeholder，最终 Skill 只包含一份 role 表。
- **Scattering 与 co-location：** 稳定策略在 Skill；生成逻辑集中在 renderer；eval fixture 与 Skill 同目录。
- **不必要缓存的环境事实：** 未发现。
- **过期或孤立资源：** 历史正式报告仍可达，但 README 明确说明它在插件合并前生成；其 summary 的 `eval.releaseOutcome` 为 `incomplete`，不能替代当前证据。

## 评测与证据

### 执行环境

- **Batch：** `.tmp/agent-workflows/evals/plugin/codex-enhance/codex-subagent-guide/20260812T175548Z-full-review-20260813-6da3b9ab`
- **模型：** `gpt-5.6-luna`
- **Codex：** `codex-cli 0.147.0`
- **Provider：** `openai-oauth`
- **进程管理：** managed；可检查后代并保证 cleanup。
- **materialization：** project-default、user-default、project-nondefault、user-nondefault 全部通过。
- **release target：** 8/8 已覆盖，无 missing target；release outcome 为 `incomplete`。

### 完整运行矩阵

| Suite | Split/profile | Cases × runs | 模型运行数 | 结果 | 解释 |
| --- | --- | ---: | ---: | --- | --- |
| trigger | validation / project-default | 7 × 3 | 21 | 7/7 通过 | release validation 稳定。 |
| trigger | sanity / project-default | 6 × 3 | 18 | 6/6 通过 | strict negative sanity 稳定。 |
| routing | project-default | manifest 默认 3 runs | 0 | incomplete | workspace 创建前 `got 8`。 |
| lifecycle | project-default | 1 × 1 | 0 | incomplete，cases=0 | workspace 创建前 `got 8`。 |
| trigger | train / project-default | 12 × 3 | 36 | 9/12 case 通过，suite incomplete | 两个 false load；existing-agent case 3 次 timeout。 |
| trigger-composition | project-default | 4 × 3 | 12 | 2/4 case 通过，suite incomplete | 核心 no-load/no-spawn 成立，但两个 case 各有一次 actor timeout。 |
| **合计** | — | — | **87** | — | 全部真实模型调用都来自 trigger suites。 |

- **Trigger eval 与触发率：** release validation 和 sanity 均 100%；train 75%；composition 50%，但其两个失败是 incomplete actor fixture，核心专用-owner触发断言没有失败。
- **Behavior 或 regression eval：** 当前 routing 和 lifecycle 为 0 模型运行。不能把历史合并前证据当作当前 merged bundle 的正式通过结果。
- **Runtime trace：** trigger runs 保存了 Skill load、spawn 和 timeout trace。current routing/lifecycle 没有 runtime trace，因为 deterministic preflight 先失败。
- **基线：** previous version 仅作反证，不计为当前 release proof。
- **Ablation 或 no-op 证据：** 专用 owner 的 no-load/no-spawn 提供局部 no-op；没有等待窗口 ablation。
- **Token、时间和方差成本：** 未形成统一成本基线。5 个 actor fixture 运行达到 180 秒 timeout。
- **发布仍缺少的证据：** 修复 harness 后的完整 routing 和 lifecycle；可执行的 existing-agent fixture；可选等待窗口 ablation。

## 最小改进路线

### 现在——发布阻断

1. 让 `readMaterializedRoles` 只读取四个 guide role key，并验证每个正好一次。
2. 在当前 8-role merged bundle 上完整重跑 routing 和 lifecycle。两套 suite 必须 complete。

### 下一步——高价值质量改进

1. 收紧 frontmatter description，减少 install/config/no-authority false load。
2. 提供真实 existing-agent fixture 或确定性 tool shim，关闭 train/composition timeout。

### 以后——启发式、评测或产品/runtime 工作

1. 对首次等待窗口做 ablation。
2. 当 current merged-bundle evidence 完整后，再决定是否更新正式报告和 README 的最近验证信息。

## 停止决定

现在应停止评审。当前材料已经明确定位 release evidence 的唯一 P1 根因，并完成静态检查、87 次真实 trigger 运行、全部 12 个维度和最小控制审计。继续读取相同材料不会产生当前 merged bundle 的 routing/lifecycle 证据。下一轮必须先修复 role 过滤，并提供新的 complete behavior eval。
