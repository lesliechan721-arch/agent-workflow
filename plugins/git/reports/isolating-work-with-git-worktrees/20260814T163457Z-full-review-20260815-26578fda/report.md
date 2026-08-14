# `isolating-work-with-git-worktrees` 评审

## 结论

- **设计结论：** needs-fixes
- **发布就绪度：** blocked
- **复杂度：** proportionate
- **证据：** coverage `100%`；confidence `high`

**判断：**

Skill 的包结构、范围、Git 职责边界和最小控制总体正确。完整 Codex release 批次已完成，但 required behavior 在“默认根未忽略”分支中有 2/3 次绕过明确决策点，并创建了未授权的临时 worktree 与分支。因此，当前版本不能发布。现有证据要求先修正这一个完成边界，不支持扩写整个流程。

**下一步：**

执行 `A-01`。

## 必须处理

### `F-001` 未忽略默认根时仍创建 worktree — P1

**为什么重要：**

当项目没有路径约定且 `.worktrees/` 未忽略时，Agent 应先停止并取得明确路径决定。两个 current 重复运行改在 `$TMPDIR` 创建 `hotfix-blocked` worktree 和分支。这会绕过核心副作用授权边界。

**证据：**

- `plugins/git/skills/isolating-work-with-git-worktrees/SKILL.md:8`
- `behavior-project-default-stop_when_default_root_not_ignored.json` 的 current runs 2–3
- Appendix D 的 `F-001` admission record

**建议：**

把该条件写成独立 stop boundary：在取得用户或项目路径决定前，不得运行 `git worktree add`，也不得创建分支。明确环境提供的 containment 目录不等于路径授权。

**完成标准：**

同一高代价 case 的扩样运行全部保持零 worktree、零分支副作用；已忽略默认根的 minimal pair 仍全部通过；完整 required release suite 通过。

## 高价值改进

1. **`F-002` 稳定复用与例行管理路由边界：** 复用已有隔离的两个 release case 只加载 3/6；例行删除 case 误加载 2/3。先裁决简单复用是否必须加载，再修改 description 或 oracle。
2. **`F-003` 证明净增量价值：** behavior current 为 11/15，without-owner baseline 为 10/15；双方都完整通过 3/5 case，current final-turn tokens 高 42.0%。增加 observed/regression 场景，或比较 minimal Skill。
3. **`F-004` 稳定基线检查的工作区边界：** `report_dirty_baseline` 仅 1/3 current 完整通过。固定 setup 和 test 的执行工作目录，并继续检查 primary snapshot。

## 已经可靠的部分

- Source inspector 没有发现包错误或断裂引用；project 和 user materialization 都通过。
- 核心新建隔离正例全部 3/3 加载；当前 checkout、只读、commit 和 merge 相邻边界大部分精确路由。
- 默认路径正例、复用现有隔离和完整 clone 三个 behavior case 均 current 3/3 通过；所有 behavior current run 都避免 stash、reset 和 force。

## 决策关键的证据缺口

| ID | 缺少的证据 | 当前影响 | 获得方式 |
| --- | --- | --- | --- |
| `U-001` | release-counted case 没有 observed production provenance | 实际失败频率和损失未知；降低 problem-value 置信度 | 关联一个脱敏真实请求、事故、人工纠正或 trace |
| `U-002` | 没有 minimal-skill 或规则块 ablation | 无法逐项证明所有 mandatory block 的边际必要性 | 在固定 corpus 上做 paired ablation，并比较安全、路由、质量和成本 |

## 发布限制

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| `release-evidence` | fail | required behavior suite 存在已接纳 P1；正式报告可以发布，但 Skill release 被阻断 | `A-01` |

安全执行结果：`inspect_skill_target` 通过静态包检查；3 份 manifest case 文档全部通过 `validate_eval_cases.mjs --strict`；author-side eval entry 的 `--help` 退出码为 0；完整 `plugin:eval` 批次 `complete=true`、`mechanicalPassed=false`。

## 质量概览

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | adequate | 主边界明确；required trigger 精确路由为 39/45 |
| 指令、控制与架构 | weak | 控制规模适当，但一个核心 stop boundary 重复失败 |
| 资源、脚本与披露 | strong | runtime 无多余资源；eval entry 接口安全 |
| Eval 与发布证据 | adequate | case 结构和 baseline 完整；required suite 完成但未通过 |

## 行动路线

### 现在

1. **`A-01`：** 修正并验证未忽略默认根的 stop boundary；关闭 `F-001` 和 `release-evidence`。

### 下一步

1. **`A-02`：** 裁决复用 branch 的触发价值，稳定 reuse/admin 路由，并补充净增量价值证据；处理 `F-002`、`F-003`、`F-004`。

### 暂不处理

1. **`A-03`：** 在没有 observed failure 或 ablation 前，不增加更多 Git 边界规则；保留 `U-001`、`U-002`。

## 停止与重新打开条件

**现在停止，因为：**

评审合同、P1 根因、最小动作和关闭证据已经清楚。继续扩写 Skill 或 eval 不会关闭当前门禁。

**仅在出现以下情况时重新打开：**

- `F-001` 修订版和完整 release rerun；
- 新的 observed failure；
- 新的 normative requirement；
- 固定 eval 集出现稳定回归。

---

# `isolating-work-with-git-worktrees` 评审技术附录

## Appendix A — 评审范围与合同

| 项目 | 从材料提取的结论 | 状态 | Evidence |
| --- | --- | --- | --- |
| 目标问题 | 为独立任务提供 linked-worktree 隔离，并保护当前 checkout 的无关状态 | known | `SKILL.md:3,6-12` |
| 已观察失败 | unignored-root case 2/3 current 创建未授权临时 worktree/branch；baseline-check case 1/3 current 全通过 | known | batch raw behavior reports |
| 成功标准 | 复用合适隔离；安全创建；验证起点；任务保持隔离；不破坏当前状态 | known | `SKILL.md:6-12`、behavior oracle |
| 目标环境或客户端 | AW plugin `git`；Codex project runtime；Codex user 只做 materialization | known | `evals/manifest.json`、EvaluationBundle subjects |
| 范围外事项 | 同一 checkout 的同一任务、纯只读、例行 worktree 管理、完整仓库隔离 | known | `SKILL.md:3` |
| 相邻 Skill | `reconciling-git-merges`、`git-commit` | known | manifest `skills[]`、trigger exact-route oracle |
| 发布要求 | 完整 release eval 和 `review:publish` 已授权；README 登记未授权 | known | 用户授权与本评审任务 |

### 当前官方来源核验

2026-08-15 重新打开并核对：

- [Agent Skills specification](https://agentskills.io/specification)
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
- [Using scripts in skills](https://agentskills.io/skill-creation/using-scripts)
- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)

## Appendix B — 完整发布门禁

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | source inspector；project/user materialization | frontmatter、name、metadata、最终制品有效 |
| critical-artifacts | pass | P0 | — | manifest；3 个 strict validator 结果 | required case、entry 和 fixture 均存在 |
| goal-alignment | pass | P0 | — | `SKILL.md`、oracle | 目标与授权一致 |
| capability-validity | pass | P0 | — | Git/runtime trace、materialization | 不依赖不存在能力 |
| safety-permissions | pass | P0 | — | 全部 behavior trace | 没有 P0 凭据、containment 或破坏性命令问题；P1 由 release-evidence 承担 |
| architecture-ownership | pass | P1 | — | architecture audit | Git/runtime 管真实状态；自然语言状态机风险低 |
| release-evidence | fail | P1 | `F-001` | required batch complete；stop case 1/3 | 重复绕过路径决策门禁 |
| eval-validity | pass | P1 | — | strict case validation、oracle audit、failure triage | 关键 case 可用于裁决，未发现已知错误 oracle |
| eval-change-safety | not_applicable | P1 | — | 没有生产修改 | 本轮不执行 eval-driven change |

## Appendix C — Full Scorecard

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | — | — | source 与 final artifact 有效 |
| 问题基础与实际价值 | 8 | 4 | medium | — | `U-001` | 问题具体；缺 observed provenance |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | high | `F-002` | — | 主边界可靠；reuse/admin 不稳定 |
| 范围、边界与组合性 | 8 | 5 | high | — | — | coherent，near-miss 清楚 |
| 程序与完成边界 | 10 | 3 | high | `F-001` | — | 一个核心 stop boundary 重复失败 |
| 最小充分控制与模型自由度 | 14 | 4 | medium | — | `U-002` | proportionate；缺 ablation |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | — | — | runtime 内容紧凑 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | — | — | owner 正确，风险 low |
| 脚本与确定性自动化 | 7 | 5 | high | — | — | runtime script 正确省略；eval entry 安全 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3.5 | high | `F-003` | — | 完整可诊断；净增量弱 |
| 可靠性、安全与兼容性 | 4 | 3.5 | high | `F-004` | — | baseline-check 路径有方差 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | — | — | 简洁，无事实缓存 sediment |

- **加权总分：** 84.7
- **原始质量带：** strong
- **有效质量带：** strong
- **复杂度上限原因：** 无；`proportionate` 不应用质量上限
- **Validator 决策：** design `needs-fixes`；release readiness `blocked`；coverage `100%`；confidence index `0.93`

## Appendix D — Finding Admission Records

### `F-001`

- **Location：** `SKILL.md:8`；behavior `stop_when_default_root_not_ignored` current runs 2–3
- **Exact claim：** 默认根未忽略且没有路径约定时，2/3 current 在 `$TMPDIR` 创建 linked worktree 和 `hotfix-blocked` 分支，没有先取得明确路径决定。
- **Affected scenario：** 无平台隔离、无项目路径约定、`.worktrees/` 未忽略，但任务要求独立 checkout。
- **Material impact：** 创建目录和 Git ref，绕过用户必须决定的路径副作用边界。
- **Direct evidence：** `SKILL.md:8`；case prompt；两个 `git worktree add` trace；机械 `does_not_create_*` 失败。
- **Counterevidence：** current run 1 正确停止；primary checkout 均保持不变；没有 stash/reset/force；所有路径仍在 eval root；containment suffix 明确说 TMPDIR 不是项目路径约定。
- **Owner：** Skill
- **Minimal action：** 把 unignored-root 分支形成独立 stop boundary；明确 containment 不是路径授权。
- **Validation：** 扩样同 case 零副作用；ignored-root minimal pair 通过；完整 required suite 通过。

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| Case 前提为无路径约定和未忽略默认根 | release fixture | `evals/evals.json`；`run-worktree-evals.mjs:281-283` | supported |
| Skill 要求先报告并取得明确处理方式 | target rule | `SKILL.md:8` | supported |
| 两次 current 创建 branch 与 linked worktree | runtime trace / Git state | behavior report runs 2–3 | supported |
| 相同失败在样本内重复 | release repetition | 2/3 current | supported |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| execution-path | required behavior → stop case → current → manual creation | manifest requiredForRelease；batch complete | supported |

## Appendix E — 适用专项审计

### Invocation / Context Pointer Audit

| Pointer | 目标材料 | 触发 branch | 意图前置 | 重复 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | linked-worktree 隔离流程 | 新独立任务、并行分支、复用隔离；排除同一任务、只读、管理、full clone | 是 | 否 | 否 | recall 87.5%；specificity 90.5% | 处理 `F-002`，不要盲目堆关键词 |

### Minimum Effective Control Audit

#### 最小行为合同

1. 只为需要独立 checkout 的任务激活；同一任务、只读、例行管理和仓库级隔离走其它路径。
2. 先确认现有平台隔离是否满足 branch、base 和隔离级别；满足则复用。
3. 手动创建前确定 base、branch 和项目路径约定；无约定默认 `.worktrees/<task>`；默认根未忽略时停止并取得决定。
4. 不 stash、reset、discard、force 或修改当前无关状态；隔离失败不得静默回退。
5. 开始任务前在隔离 workspace 验证 path、base、branch、initial state，并在那里运行必要 setup/baseline。
6. 任务修改保持在该 workspace；报告 path/branch；只按平台或明确用户要求安全清理。

#### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 4 | 与脆弱 Git 流程匹配 |
| Hard gates | 2 | unignored-root gate 重复失败；no-silent-fallback 未失败 |
| Fixed intermediate artifacts | 0 | low |
| Prohibitions | 约 9 个行为标记 | 多为 destructive-state invariants |
| Conditional branches | 3 | existing isolation、manual fallback、cleanup |
| Fixed output fields | 0 | low |

#### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| worktree / clone 隔离边界 | 避免把 linked worktree 当完整仓库隔离 | Git 领域事实；clone case 3/3 | invariant | 否 | keep-invariant | shared refs/object 操作污染主仓库 |
| 复用现有隔离 | 避免嵌套或重复 worktree | scope 与行为 oracle | 部分 | keep-default | 重复 workspace 和生命周期混乱 |
| 路径约定、ignore、stop | 控制目录和 ref 副作用 | P1 observed failure | 否 | keep-invariant | 创建未授权目录或 ref |
| 禁止 stash/reset/discard/force | 保护无关用户状态 | irreversible risk；trace checks | 否 | keep-invariant | 丢失或隐藏无关工作 |
| 可信起点和 baseline | 正确归因 pre-existing failure | baseline oracle | 部分 | keep-default | 错误归因或在错误 base 工作 |
| 交付和 cleanup 边界 | 保持任务与生命周期隔离 | destructive cleanup risk | 部分 | keep-default | 早删 workspace 或 branch |
| 逐块必要性 | 判断哪些规则可删 | 无 minimal-skill ablation | 未知 | needs-ablation | 可能增加 context 而无增益 |

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 触发与 near-miss | in-file-reference | 激活前 | description | 是 | user intent | keep-invariant | 保留 |
| 隔离级别选择 | in-file-step | 所有激活 | step 1 | 是 | Git/platform state | keep-invariant | 保留 |
| path/ignore/base/branch | in-file-step | manual creation | step 2 | 否 | project convention、Git | keep-invariant | 保留并修 stop boundary |
| initial state/baseline | in-file-step | 创建或复用后 | step 3 | 是 | Git、test command | keep-default | 明确 command context |
| task containment/report | in-file-step | execution/delivery | step 4 | 是 | active workspace | keep-invariant | 保留 |
| lifecycle cleanup | in-file-reference | user asks cleanup | step 4 | 否 | platform/Git | keep-default | 保留短规则 |
| eval corpus 与 scripts | environment-lookup | author/release only | `evals/` | 否 | manifest | 不进入 runtime control | 保持 author-only |

### Completion Boundary Audit

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 隔离级别确认 | 可证明共享或独立 refs/object store | 是 | 是 | 是 | 是 | 低 | 保留 |
| 未忽略默认根 | 报告并取得明确处理方式 | 文本清楚 | 是 | 是 | 是 | 高；2/3 绕过 | 形成独立 stop boundary |
| 可信起点 | path/base/branch/status 均确认 | 是 | 是 | 是 | 是 | 中；1/3 test context 错误 | 固定工作目录后继续 |
| 任务隔离 | 修改只在目标 workspace | 是 | 是 | 是 | 是 | 中 | 保留 |
| cleanup | 用户要求且无未保存工作 | 是 | 是 | 是 | 是 | 低 | 保留 |

### Architecture and Ownership

- **Skill 负责的策略：** 使用时机、隔离级别、路径默认、授权与 destructive-operation 不变量。
- **Schema 或客户端负责的事实：** 工具参数、权限、platform isolation 能力。
- **Runtime 负责的状态：** active workspace、process containment、Git command completion 和 lifecycle。
- **脚本候选：** runtime 无必要脚本；author eval script 负责 fixture、snapshot 和机械 assertion。
- **仅属于 role 的约束：** 不适用；没有 role。
- **仅属于 eval 或 issue 的问题：** 低概率组合、trigger variance、ablation 和成本比较。
- **自然语言状态机风险：** low

### Scripts and Resources

- **已有脚本或正确省略：** runtime script 正确省略；`evals/run-worktree-evals.mjs` 和 `trigger-fixture.mjs` 仅服务 author eval。
- **接口、依赖和安全质量：** 完整读取 imports、参数、help 和 main；`--help` 退出 0；临时目录和 materialized participants 有 containment；每轮 finally 清理。
- **模型仍在重复的确定性逻辑：** Git 状态、snapshot 和 assertion 已由 harness 机械处理；runtime 任务本身无需新脚本。
- **Reference 和 asset 可达性：** runtime 没有 reference/asset；manifest 一层到达全部 executable case、entry 和 fixture。
- **重复、scattering 与 co-location：** Skill 规则均在 12 行正文；eval oracle 与 fixture 各有清楚 owner。
- **不必要缓存的环境事实：** 无；Git 和 platform state 运行时读取。
- **过期或孤立资源：** `trigger-diagnostic-cases.json` 由非 required suite 引用，作为 diagnostic，不是孤立 release evidence。

## Eval Case Audit

### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | trigger `recall-first`；behavior `critical` | 两个 case 文档的 top-level `policy` |
| False-negative cost | trigger high；behavior high | 漏隔离可能污染当前工作 |
| False-positive cost | trigger medium；behavior high | 误加载主要是 context/tool cost；错误创建或阻止隔离有高成本 |
| Policy rationale | 核心隔离 recall 优先；behavior 高风险不允许平均抵消 | `trigger-cases.json`、`evals.json` |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | pass | 3 个文档 strict valid；case/oracle 人工审计 | 层级、前提、rule refs、observable assertions、variance 清楚 |
| release-evidence | fail | batch complete；required behavior failed | `F-001` 已通过 P1 admission |
| eval-change-safety | not_applicable | 无生产修改 | 本轮只评审和发布报告 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Manifest executable cases | 35（28 trigger + 2 diagnostic + 5 behavior） |
| Release-run cases | 20（15 trigger + 5 behavior） |
| Release scenario families | trigger 7；behavior 4 |
| Decision boundaries / minimal pairs | 11 个 release boundary case 有 minimal counterexample |
| Representative cases | 9 |
| Regression cases | 0 |
| Boundary cases | 11 |
| Challenge cases | 0 |
| Diagnostic-only cases | 2，未进入 release run |
| Stale / ambiguous cases | 0 已确认；reuse loading 价值待产品裁决 |

### Case Admission 结果

| Case 组 | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| 8 个 release owner-positive trigger | routing | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| 7 个 release negative/adjacent trigger | routing | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| manual creation positive | outcome | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| stop/reuse/baseline boundaries | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| repository isolation boundary | outcome | boundary | derived | high | 是 | 是 | 是 | release-counted |
| repository-isolation trigger pair | routing | diagnostic | boundary | medium | 是 | 是 | 是 | diagnostic-only |

### Trigger 或其它二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Positive recall | 87.5%（21/24） | 无；纯 trigger 不要求 without-owner | 3 个 miss 均在 reuse branch |
| False-negative rate | 12.5% | — | `source_10` 2 次；sanity reuse 1 次 |
| Negative specificity | 90.5%（19/21） | — | 2 个 false load 都在 routine deletion |
| False-positive rate | 9.5% | — | final outcome 安全，但增加 context/tool cost |
| Exact participant route | 86.7%（39/45） | — | 另有 merge case 1 次 companion multiple load |
| Mixed / uncertain cases | reuse 3/6；routine deletion 2/3 false load | — | 需要 fixed rerun 或裁决，不直接扩写 |

Trigger 成本与方差：validation 18 runs，平均 25.0 s、41,183 tokens，范围 15.5–39.5 s、21,077–73,148 tokens；sanity 27 runs，平均 34.1 s、55,528 tokens，范围 12.6–71.1 s、21,075–115,604 tokens。45 个 run 都无 execution error，fixture 均 unchanged。

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| manual worktree / ignored default path | 3/3 | 3/3 | 0 | 133,212 vs 101,823 mean tokens | current 120,786–143,167 | high |
| unignored default root stop | 1/3 | 0/3 | +1 run | 86,335 vs 51,428 | mixed；2/3 same failure | high |
| reuse platform isolation | 3/3 | 3/3 | 0 | 66,950 vs 45,787 | low current variance | high |
| repository-level full clone | 3/3 | 3/3 | 0 | 59,619 vs 50,913 | moderate | high |
| pre-existing baseline failure | 1/3 | 1/3 | 0 | 96,142 vs 61,422 | mixed failure modes | high |

合计：current 11/15，baseline 10/15；双方完整通过 3/5 case。final-turn tokens 为 current 1,326,772、baseline 934,120，current 高 42.0%。Command report 不保存每个 variant 的 `duration_ms`，因此行为时间 delta 不作精确声明。

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| `source_10` + sanity reuse load | insufficient-runs | mixed 3/6 | Skill / Eval 待裁决 | 固定扩样并裁决 branch value | 未加载时 outcome 仍正确复用 |
| `source_20` routine deletion false load | skill-defect | 2/3 | Skill description | 修正 near-miss 后 rerun | description 明确排除例行管理 |
| sanity merge multiple load | model-variance | 1/3 | companion `git-commit` | 不改本 Skill；交给相邻 owner | owner worktree Skill 始终未加载，正确 merge Skill 已加载 |
| stop when root unignored | skill-defect | 2/3 | Skill | `F-001`，先修 completion boundary | 直接绕过明确 stop gate |
| baseline failure worktree | insufficient-runs | 2/3 不同 failure | Skill | `F-004`，固定 cwd/path 后扩样 | 一个 primary snapshot 变化；一个 wrong path |

### Eval-driven 修改决策

- **修改内容：** 无；本轮只评审。
- **受影响场景族：** manual_worktree_creation、baseline_failure_attribution、reuse/platform routing、administration boundary。
- **为什么是 Skill defect：** 只有 `F-001` 具备重复、直接、可达且高影响证据；其余按 P2 或 insufficient-runs 处理。
- **原始失败证据：** batch raw reports 与 Git-state assertions。
- **Minimal pair / 相反标签风险：** ignored-root positive、routine list/delete negative、same-checkout negative、full-clone boundary。
- **Validation、sanity 和 regression 重跑：** 未执行，因为没有生产修改。
- **Quality delta：** 当前无修订版 delta。
- **Context / branch / maintenance delta：** 当前无变更。
- **决策：** reject；先完成 `A-01`，再运行完整 regression。

### Eval 维度

- **分数：** 3.5
- **置信度：** high
- **适用评分上限：** 有实际运行、baseline、trace、重复和 failure triage；但 required suite failed，净增量弱，不能到 4–5。
- **摘要：** suite 是可靠诊断工具，但当前不支持发布通过。

### 停止决定

停止继续修改 eval 或扩写 Skill。本批次已足够确定 `F-001`；其它 mixed result 保持 P2 或 insufficient-runs。下一步只做最小修订和完整 rerun。
